import yauzl from 'yauzl';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// Archive traversal.
//
// A Strava bulk export is routinely multi-gigabyte, so nothing here loads an archive
// into memory. yauzl reads entries lazily from the file on disk, and an entry is only
// buffered once we know it is small enough to be a FIT file.

// A FIT file is a few MB at most. Anything larger is not one, so it is never read.
const STREAM_THRESHOLD_BYTES = 32 * 1024 * 1024;

/**
 * Iterate the entries of a ZIP file on disk.
 *
 * Each yielded entry exposes `buffer()` and `stream()`; callers pick based on
 * `size` and what the parser can accept. Directory entries and the junk that
 * macOS and Windows sprinkle into archives are filtered out.
 *
 * @param {string} zipPath
 * @returns {AsyncGenerator<{name:string, baseName:string, size:number, buffer:()=>Promise<Buffer>, stream:()=>Promise<import('node:stream').Readable>}>}
 */
export async function* zipEntries(zipPath) {
  const zipfile = await openZip(zipPath);

  try {
    while (true) {
      const entry = await nextEntry(zipfile);
      if (!entry) break;

      const name = entry.fileName;
      if (name.endsWith('/')) continue;                       // directory
      if (shouldSkipEntry(name)) continue;

      yield {
        name,
        baseName: path.posix.basename(name),
        size: entry.uncompressedSize,
        tooBigToBuffer: entry.uncompressedSize > STREAM_THRESHOLD_BYTES,
        buffer: () => entryToBuffer(zipfile, entry),
        stream: () => entryToStream(zipfile, entry),
      };
    }
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    // `lazyEntries` is what keeps memory flat: entries are pulled one at a time.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) reject(new Error(`cannot open ZIP: ${err.message}`));
      else resolve(zipfile);
    });
  });
}

function nextEntry(zipfile) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      zipfile.removeListener('entry', onEntry);
      zipfile.removeListener('end', onEnd);
      zipfile.removeListener('error', onError);
    }
    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

function entryToStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(new Error(`cannot read ${entry.fileName}: ${err.message}`));
      else resolve(stream);
    });
  });
}

async function entryToBuffer(zipfile, entry) {
  const stream = await entryToStream(zipfile, entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Archive noise that is never activity data. Skipping these keeps import logs
 * readable instead of listing hundreds of "unrecognised file" entries.
 */
function shouldSkipEntry(name) {
  const base = path.posix.basename(name);
  if (base.startsWith('.')) return true;                // .DS_Store, ._resource forks
  if (name.startsWith('__MACOSX/')) return true;
  if (base === 'Thumbs.db' || base === 'desktop.ini') return true;
  // Media and documents that legitimately appear in exports but hold no data.
  return /\.(jpe?g|png|gif|heic|mp4|mov|pdf|html?|txt|md)$/i.test(base);
}

/** Decompress a gzip buffer, with a clear error rather than a raw zlib code. */
export function gunzip(buffer) {
  try {
    return zlib.gunzipSync(buffer);
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`);
  }
}

/** Read the first `bytes` of a file, for content sniffing. */
export async function readHead(filePath, bytes = 4096) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
