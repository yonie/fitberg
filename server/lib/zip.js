import { Readable } from 'node:stream';
import fs from 'node:fs';
import zlib from 'node:zlib';

// A streaming ZIP writer for the export endpoint.
//
// Fitberg's whole pitch is that your data is yours, which is worthless if you
// cannot get it out again. So export has to work for the real case: a decade of
// history, tens of thousands of files, several gigabytes — on a Raspberry Pi.
//
// That rules out building the archive in memory. This writes entries out
// incrementally and uses STORE (no compression), which additionally means:
//   * constant, tiny memory use regardless of archive size
//   * no CPU spent recompressing `.fit.gz` files that are already compressed
//   * a data descriptor after each entry, so sizes need not be known in advance

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DATA_DESC_SIG = 0x08074b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const ZIP64_THRESHOLD = 0xfffffffe;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

class Crc32 {
  #crc = -1;
  update(buf) {
    let crc = this.#crc;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    this.#crc = crc;
    return this;
  }
  get value() { return (this.#crc ^ -1) >>> 0; }
}

/**
 * Build a ZIP as an async byte stream.
 *
 * @param {AsyncIterable<{name:string, data?:Buffer|string, path?:string}>|Array} entries
 *        Each entry supplies either inline `data` or a `path` to stream from disk.
 * @returns {Readable}
 */
export function createZipStream(entries) {
  return Readable.from(generate(entries));
}

async function* generate(entries) {
  const central = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const localOffset = offset;

    // Bit 3 of the general-purpose flags says "sizes follow in a data descriptor",
    // which is what allows streaming an entry whose length we do not know yet.
    const flags = 0x0008;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(45, 4);            // version needed (4.5 for zip64)
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);             // method: store
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x2821, 12);       // mod date
    local.writeUInt32LE(0, 14);            // crc — in the descriptor
    local.writeUInt32LE(0, 18);            // compressed size — in the descriptor
    local.writeUInt32LE(0, 22);            // uncompressed size — in the descriptor
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    yield local;
    yield nameBuf;
    offset += local.length + nameBuf.length;

    const crc = new Crc32();
    let size = 0;

    if (entry.data !== undefined) {
      const buf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
      crc.update(buf);
      size = buf.length;
      yield buf;
    } else if (entry.path) {
      for await (const chunk of fs.createReadStream(entry.path)) {
        crc.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    }
    offset += size;

    // Data descriptor. Zip64 form (8-byte sizes) once anything exceeds 4 GB.
    const useZip64 = size > ZIP64_THRESHOLD || localOffset > ZIP64_THRESHOLD;
    const desc = Buffer.alloc(useZip64 ? 24 : 16);
    desc.writeUInt32LE(DATA_DESC_SIG, 0);
    desc.writeUInt32LE(crc.value, 4);
    if (useZip64) {
      desc.writeBigUInt64LE(BigInt(size), 8);
      desc.writeBigUInt64LE(BigInt(size), 16);
    } else {
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
    }
    yield desc;
    offset += desc.length;

    central.push({ nameBuf, crc: crc.value, size, localOffset, flags });
    count++;
  }

  // Central directory.
  const centralStart = offset;
  for (const e of central) {
    const needsZip64 = e.size > ZIP64_THRESHOLD || e.localOffset > ZIP64_THRESHOLD;
    const extra = needsZip64 ? Buffer.alloc(32) : Buffer.alloc(0);
    if (needsZip64) {
      extra.writeUInt16LE(0x0001, 0);            // zip64 extended information
      extra.writeUInt16LE(28, 2);
      extra.writeBigUInt64LE(BigInt(e.size), 4);
      extra.writeBigUInt64LE(BigInt(e.size), 12);
      extra.writeBigUInt64LE(BigInt(e.localOffset), 20);
      extra.writeUInt32LE(0, 28);
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(45, 6);
    cd.writeUInt16LE(e.flags, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(needsZip64 ? 0xffffffff : e.size, 20);
    cd.writeUInt32LE(needsZip64 ? 0xffffffff : e.size, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(needsZip64 ? 0xffffffff : e.localOffset, 42);

    yield cd;
    yield e.nameBuf;
    if (extra.length) yield extra;
    offset += cd.length + e.nameBuf.length + extra.length;
  }

  const centralSize = offset - centralStart;
  const needsZip64Eocd = count > 0xfffe || centralStart > ZIP64_THRESHOLD || centralSize > ZIP64_THRESHOLD;

  if (needsZip64Eocd) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    z64.writeBigUInt64LE(44n, 4);              // size of this record minus 12
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    z64.writeBigUInt64LE(BigInt(count), 24);
    z64.writeBigUInt64LE(BigInt(count), 32);
    z64.writeBigUInt64LE(BigInt(centralSize), 40);
    z64.writeBigUInt64LE(BigInt(centralStart), 48);
    yield z64;

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    yield locator;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Math.min(count, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(count, 0xffff), 10);
  eocd.writeUInt32LE(Math.min(centralSize, 0xffffffff), 12);
  eocd.writeUInt32LE(Math.min(centralStart, 0xffffffff), 16);
  eocd.writeUInt16LE(0, 20);
  yield eocd;
}

export const gzipSync = zlib.gzipSync;
