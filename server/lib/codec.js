// Time-series storage codec.
//
// A 90-minute ride at 1 Hz is ~5400 samples across ~8 channels. As SQLite rows
// that is 43k rows for one activity; a few thousand activities becomes tens of
// millions of rows and every chart turns into a slow aggregate query. Instead we
// store each channel as one typed-array blob: a 5400-sample float32 channel is
// 21 KB, reads in a single row lookup, and hands straight to the client as bytes.
//
// Per-channel dtype is chosen to be the narrowest that holds the data losslessly
// enough for its purpose (see CHANNELS below).

/** @typedef {'f32'|'f64'|'i32'|'u16'|'u8'} DType */

const CTORS = {
  f32: Float32Array,
  f64: Float64Array,
  i32: Int32Array,
  u16: Uint16Array,
  u8: Uint8Array,
};

// Canonical channel set. `dtype` is what we persist; `nullValue` is the sentinel
// meaning "no reading here" for integer channels that cannot hold NaN.
export const CHANNELS = {
  t:     { dtype: 'i32', unit: 's since activity start', nullValue: -1 },
  // f64 for coordinates: f32 has ~7 significant digits, which is ~1 m of error
  // at these magnitudes — visible as a jittery track when zoomed in.
  lat:   { dtype: 'f64', unit: 'degrees' },
  lng:   { dtype: 'f64', unit: 'degrees' },
  alt:   { dtype: 'f32', unit: 'm' },
  hr:    { dtype: 'u8',  unit: 'bpm',  nullValue: 0 },
  cad:   { dtype: 'u16', unit: 'rpm or spm', nullValue: 65535 },
  power: { dtype: 'u16', unit: 'W',    nullValue: 65535 },
  speed: { dtype: 'f32', unit: 'm/s' },
  dist:  { dtype: 'f32', unit: 'm cumulative' },
  temp:  { dtype: 'f32', unit: 'C' },
  grade: { dtype: 'f32', unit: '%' },
};

export const CHANNEL_NAMES = Object.keys(CHANNELS);

/**
 * Encode a JS number array into a blob for the `streams` table.
 * `null`/`undefined`/`NaN` entries become the channel's null sentinel (integer
 * channels) or NaN (float channels).
 * @param {string} channel
 * @param {Array<number|null|undefined>} values
 */
export function encodeStream(channel, values) {
  const spec = CHANNELS[channel];
  if (!spec) throw new Error(`unknown stream channel: ${channel}`);
  const Ctor = CTORS[spec.dtype];
  const isFloat = spec.dtype === 'f32' || spec.dtype === 'f64';
  const arr = new Ctor(values.length);

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(v)) {
      arr[i] = isFloat ? NaN : spec.nullValue;
    } else {
      arr[i] = v;
    }
  }

  return {
    channel,
    n: values.length,
    dtype: spec.dtype,
    data: Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength),
  };
}

/**
 * Decode a `streams` row back to a Float64Array, with nulls as NaN so callers
 * have exactly one "missing" representation to reason about.
 * @param {{channel:string,n:number,dtype:DType,data:Uint8Array}} row
 * @returns {Float64Array}
 */
export function decodeStream(row) {
  const Ctor = CTORS[row.dtype];
  if (!Ctor) throw new Error(`unknown dtype: ${row.dtype}`);

  const bytes = toUint8(row.data);
  // A Buffer from SQLite is rarely aligned to the typed array's element size,
  // and TypedArray-on-ArrayBuffer requires alignment — so copy into a fresh one.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const typed = new Ctor(copy.buffer, 0, row.n);

  const out = new Float64Array(row.n);
  const spec = CHANNELS[row.channel];
  const nullValue = spec?.nullValue;

  for (let i = 0; i < row.n; i++) {
    const v = typed[i];
    out[i] = nullValue !== undefined && v === nullValue ? NaN : v;
  }
  return out;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;            // covers Buffer too
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength);
  throw new Error('stream blob is not a byte source');
}

/** True when a channel has at least one real reading — used to skip empty channels. */
export function hasSignal(values) {
  for (const v of values) {
    if (v !== null && v !== undefined && !Number.isNaN(v)) return true;
  }
  return false;
}
