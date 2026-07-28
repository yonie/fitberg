import { Decoder, Stream, Utils } from '@garmin/fitsdk';
import { newActivity, finalizeActivity, alignStreams } from './canonical.js';
import { normalizeSport } from './sports.js';
import { semicirclesToDegrees } from '../lib/geo.js';

// FIT is the richest of the interchange formats and the one that actually
// preserves what the device measured: per-second power, cadence, temperature,
// left/right balance, lap structure and the device's own computed summary.
// Strava's bulk export ships original FIT files, and Wahoo's API serves FIT, so
// this parser carries most of the migration weight.

/**
 * @param {Buffer} buf
 * @param {{source?:string, sourceId?:string|null}} [opts]
 * @returns {{activities:Array<object>, warnings:string[]}}
 */
export function parseFit(buf, opts = {}) {
  const warnings = [];
  const stream = Stream.fromBuffer(buf);
  const decoder = new Decoder(stream);

  if (!decoder.isFIT()) throw new Error('not a FIT file');
  if (!decoder.checkIntegrity()) {
    // Truncated FIT files are common — a watch that died mid-activity, or a
    // partial sync. The records before the corruption are still real data, so we
    // decode what we can rather than discarding the activity.
    warnings.push('FIT integrity check failed; decoding the readable prefix');
  }

  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    includeUnknownData: false,
    mergeHeartRates: true,
  });

  if (errors?.length) warnings.push(`${errors.length} FIT decode error(s); partial data kept`);

  const records = messages.recordMesgs || [];
  const sessions = messages.sessionMesgs || [];
  const laps = messages.lapMesgs || [];

  // FIT has no field for "what the athlete called this activity", and `workout.wktName`
  // is the closest the profile offers. Structured-workout files from watches populate
  // it ("Threshold 4x8min"), and it is where Fitberg writes titles when it builds a FIT
  // from an API that has them. Without reading it, a ride you named "Ventoux, finally"
  // would come back as "Morning Ride" after a reindex.
  const fitName = messages.workoutMesgs?.[0]?.wktName || null;

  if (!records.length && !sessions.length) throw new Error('FIT file contains no records or sessions');

  const utcOffsetS = deriveUtcOffset(messages);
  const deviceName = deriveDeviceName(messages);

  // A multisport FIT (triathlon) holds several sessions in one file. Emit one
  // activity per session so a swim does not get averaged into a bike leg.
  const activities = [];
  const sessionList = sessions.length ? sessions : [null];

  for (let si = 0; si < sessionList.length; si++) {
    const session = sessionList[si];
    const slice = session && sessions.length > 1
      ? recordsForSession(records, session)
      : records;
    // Only a single-session file can claim the file-level name; in a triathlon file it
    // would be wrong on two of the three legs.
    const name = sessionList.length === 1 ? fitName : null;

    // Skip transition legs that carry no samples of their own.
    if (!slice.length && sessions.length > 1) continue;

    const act = buildActivity({
      session,
      records: slice,
      laps: session && sessions.length > 1 ? lapsForSession(laps, session) : laps,
      utcOffsetS,
      deviceName,
      source: opts.source || 'file',
      sourceId: sessions.length > 1 && opts.sourceId ? `${opts.sourceId}#${si}` : opts.sourceId ?? null,
      name,
    });
    if (act) activities.push(act);
  }

  if (!activities.length) throw new Error('FIT file yielded no usable activity');
  return { activities, warnings };
}

function buildActivity({ session, records, laps, utcOffsetS, deviceName, source, sourceId, name }) {
  const act = newActivity(source);
  act.sourceId = sourceId;
  if (name) act.name = name;
  act.device = deviceName;
  act.utcOffsetS = utcOffsetS;

  // ── the device's own summary wins ──
  if (session) {
    act.sport = normalizeSport(session.sport, {
      subSport: session.subSport,
      trainer: isIndoorSubSport(session.subSport),
    });
    act.subSport = session.subSport ?? null;
    act.startTime = toMs(session.startTime);
    act.elapsedS = round(session.totalElapsedTime);
    act.movingS = round(session.totalTimerTime);
    act.distanceM = num(session.totalDistance);
    act.elevGainM = num(session.totalAscent);
    act.elevLossM = num(session.totalDescent);
    act.avgHr = num(session.avgHeartRate);
    act.maxHr = num(session.maxHeartRate);
    act.avgCadence = num(session.avgCadence);
    act.maxCadence = num(session.maxCadence);
    act.avgPower = num(session.avgPower);
    act.maxPower = num(session.maxPower);
    act.normalizedPower = num(session.normalizedPower);
    act.calories = num(session.totalCalories);
    act.avgSpeedMs = num(session.enhancedAvgSpeed ?? session.avgSpeed);
    act.maxSpeedMs = num(session.enhancedMaxSpeed ?? session.maxSpeed);
    act.avgTempC = num(session.avgTemperature);
    if (Number.isFinite(session.totalWork)) act.workKj = session.totalWork / 1000;

    // The device already computed TSS against the FTP configured on it. That is
    // more authoritative than anything we can recompute, so keep it.
    act.deviceTss = num(session.trainingStressScore);
    act.deviceIf = num(session.intensityFactor);
    act.thresholdPower = num(session.thresholdPower);
    act.summary = compactSummary(session);
  }

  // ── streams ──
  const streams = { t: [], lat: [], lng: [], alt: [], hr: [], cad: [], power: [], speed: [], dist: [], temp: [] };
  let t0 = act.startTime ?? (records.length ? toMs(records[0].timestamp) : null);
  if (t0 === null && records.length) t0 = toMs(records[0].timestamp);

  for (const r of records) {
    const ts = toMs(r.timestamp);
    if (ts === null) continue;
    if (t0 === null) t0 = ts;

    streams.t.push(Math.round((ts - t0) / 1000));
    streams.lat.push(semicirclesToDegrees(r.positionLat ?? null));
    streams.lng.push(semicirclesToDegrees(r.positionLong ?? null));
    streams.alt.push(pick(r.enhancedAltitude, r.altitude));
    streams.hr.push(pick(r.heartRate));
    // FIT splits running cadence into whole and fractional parts; recombining
    // them and doubling gives steps per minute, which is what runners expect.
    streams.cad.push(combineCadence(r));
    streams.power.push(pick(r.power));
    streams.speed.push(pick(r.enhancedSpeed, r.speed));
    streams.dist.push(pick(r.distance));
    streams.temp.push(pick(r.temperature));
  }

  if (act.startTime === null) act.startTime = t0;
  if (act.startTime === null) return null;

  for (const key of Object.keys(streams)) {
    if (!streams[key].some((v) => v !== null && Number.isFinite(v))) delete streams[key];
  }
  // `t` is always meaningful when we have any records at all.
  if (records.length) streams.t = streams.t.length ? streams.t : undefined;
  act.streams = streams;
  alignStreams(act.streams);

  act.laps = (laps || []).map((lap, idx) => ({
    idx,
    startTime: toMs(lap.startTime),
    elapsedS: round(lap.totalElapsedTime),
    movingS: round(lap.totalTimerTime),
    distanceM: num(lap.totalDistance),
    avgHr: num(lap.avgHeartRate),
    maxHr: num(lap.maxHeartRate),
    avgPower: num(lap.avgPower),
    avgSpeedMs: num(lap.enhancedAvgSpeed ?? lap.avgSpeed),
    avgCadence: num(lap.avgCadence),
    elevGainM: num(lap.totalAscent),
  }));

  // An unrecognised sport stays unrecognised. There used to be a guess here based on
  // average speed, which filed a downhill ski as a run because it was fast — and a run
  // it is not. Guessing corrupts pace records, load and the sport totals, and it is
  // unfixable by the athlete because nothing looks wrong. Better to say "other".
  // No GPS almost always means indoors — except swimming, where the watch
  // deliberately stops using GPS in a pool.
  act.trainer = isIndoorSubSport(act.subSport) || (!act.streams.lat && act.sport !== 'swim');

  return finalizeActivity(act);
}

/**
 * FIT timestamps are UTC. The `activity` message additionally carries a
 * localTimestamp for the same instant, and the difference is the recording
 * device's UTC offset — the only reliable way to know that a 06:00 run was a
 * morning run rather than an overnight one.
 */
function deriveUtcOffset(messages) {
  const activity = messages.activityMesgs?.[0];
  if (activity?.localTimestamp && activity?.timestamp) {
    // `timestamp` is a FIT dateTime, which the decoder converts to a Date, but
    // `localTimestamp` is a localDateTime and comes through as the raw FIT
    // integer. Normalise both before subtracting or the offset is nonsense.
    const local = fitTimeToMs(activity.localTimestamp);
    const utc = fitTimeToMs(activity.timestamp);
    if (local !== null && utc !== null) {
      // Round to the nearest quarter hour: real offsets are all multiples of 15
      // minutes, and this absorbs a second of clock skew between the two fields.
      return Math.round((local - utc) / 1000 / 900) * 900;
    }
  }
  return 0;
}

function deriveDeviceName(messages) {
  const fileId = messages.fileIdMesgs?.[0];
  if (!fileId) return null;
  const manufacturer = fileId.manufacturer ? String(fileId.manufacturer) : null;
  const product = fileId.garminProduct ?? fileId.product ?? null;
  const parts = [manufacturer, product !== null ? String(product) : null].filter(Boolean);
  return parts.length ? parts.join(' ').replace(/_/g, ' ') : null;
}

function recordsForSession(records, session) {
  const start = toMs(session.startTime);
  const end = start !== null && Number.isFinite(session.totalElapsedTime)
    ? start + session.totalElapsedTime * 1000
    : null;
  if (start === null || end === null) return records;
  return records.filter((r) => {
    const ts = toMs(r.timestamp);
    return ts !== null && ts >= start - 1000 && ts <= end + 1000;
  });
}

function lapsForSession(laps, session) {
  const start = toMs(session.startTime);
  const end = start !== null && Number.isFinite(session.totalElapsedTime)
    ? start + session.totalElapsedTime * 1000
    : null;
  if (start === null || end === null) return laps;
  return laps.filter((l) => {
    const ts = toMs(l.startTime);
    return ts !== null && ts >= start - 1000 && ts <= end + 1000;
  });
}

// FIT sub-sport values arrive from the SDK as camelCase strings ("indoorCycling"),
// not the snake_case spelling used in the FIT profile docs. Compare on a squashed
// lowercase form so both work.
const INDOOR_SUB_SPORTS = new Set([
  'treadmill', 'indoorcycling', 'indoorrunning', 'indoorrowing', 'indoorwalking',
  'virtualactivity', 'spin', 'stairclimbing', 'elliptical', 'lappool',
  'indoorhandcycling', 'indoorskiing', 'ergometer',
]);

function isIndoorSubSport(sub) {
  if (!sub) return false;
  return INDOOR_SUB_SPORTS.has(String(sub).toLowerCase().replace(/_/g, ''));
}

function combineCadence(r) {
  const base = r.cadence;
  if (!Number.isFinite(base)) return null;
  const fractional = Number.isFinite(r.fractionalCadence) ? r.fractionalCadence : 0;
  return base + fractional;
}


/** Keep the session message, minus the bulky//redundant bits, for provenance. */
function compactSummary(session) {
  const out = {};
  for (const [k, v] of Object.entries(session)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !(v instanceof Date)) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

const toMs = (d) => {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.getTime();
  if (typeof d === 'number') return d;
  const parsed = Date.parse(d);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Accept either representation of a FIT time field and return epoch ms.
 *
 * FIT counts seconds from 1989-12-31T00:00:00Z. The decoder converts fields
 * typed `dateTime` into Date objects but leaves `localDateTime` as that raw
 * integer, so a subtraction across the two needs this normalisation. Values
 * below the FIT epoch offset cannot be epoch milliseconds, which is the tell.
 */
const fitTimeToMs = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < Utils.FIT_EPOCH_MS ? v * 1000 + Utils.FIT_EPOCH_MS : v;
  }
  return toMs(v);
};
const num = (v) => (Number.isFinite(v) ? v : null);
const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const pick = (...vals) => {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return null;
};
