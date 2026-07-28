import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// Content-addressed store for original files.
//
// This is the part of Fitberg that actually matters. Every byte the user ever
// hands us is written here under sha256(content) and then treated as immutable.
// The SQLite database is a derived cache that `reindex` rebuilds from these
// files, which means a schema bug, a botched migration, or a deleted database
// can never cost the user their history.
//
// Layout: originals/<first2>/<next2>/<sha256><ext>
// Sharding two levels keeps any single directory to a manageable size — a decade
// of daily activities is ~4000 files, but people import 20-year archives.

export function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function relPathFor(hash, ext = '') {
  const safeExt = ext && /^\.[A-Za-z0-9._-]{1,20}$/.test(ext) ? ext.toLowerCase() : '';
  return path.join(hash.slice(0, 2), hash.slice(2, 4), hash + safeExt);
}

export function absPathFor(relPath) {
  return path.join(config.originalsDir, relPath);
}

/**
 * Store bytes if not already present. Idempotent: importing the same file twice
 * is a no-op that reports the existing entry.
 * @returns {{hash:string, relPath:string, bytes:number, existed:boolean}}
 */
export function putBuffer(buf, { ext = '' } = {}) {
  const hash = hashBuffer(buf);
  const relPath = relPathFor(hash, ext);
  const abs = absPathFor(relPath);

  if (fs.existsSync(abs)) {
    return { hash, relPath, bytes: buf.length, existed: true };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write to a temp name then rename, so a crash mid-write can never leave a
  // truncated file sitting at a hash that claims to be complete content.
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
  // Best-effort read-only: these files are never meant to change again.
  try { fs.chmodSync(abs, 0o444); } catch { /* non-fatal */ }

  return { hash, relPath, bytes: buf.length, existed: false };
}

export function readOriginal(relPath) {
  return fs.readFileSync(absPathFor(relPath));
}

/** Walk every stored original. Used by `reindex` to rebuild the database. */
export function* walkOriginals(dir = config.originalsDir, base = config.originalsDir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkOriginals(abs, base);
    } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
      yield { relPath: path.relative(base, abs), absPath: abs, bytes: fs.statSync(abs).size };
    }
  }
}

/**
 * Verify the store: every file's content must still hash to its own filename.
 * Surfaces bit-rot or a bad disk before the user finds out the hard way.
 */
export function verifyStore({ onProgress } = {}) {
  const result = { checked: 0, ok: 0, corrupt: [], unreadable: [] };
  for (const file of walkOriginals()) {
    result.checked++;
    const expected = path.basename(file.relPath).split('.')[0];
    try {
      const actual = hashBuffer(fs.readFileSync(file.absPath));
      if (actual === expected) result.ok++;
      else result.corrupt.push({ relPath: file.relPath, expected, actual });
    } catch (err) {
      result.unreadable.push({ relPath: file.relPath, error: err.message });
    }
    if (onProgress && result.checked % 200 === 0) onProgress(result);
  }
  return result;
}

export function storeStats() {
  let files = 0;
  let bytes = 0;
  for (const f of walkOriginals()) { files++; bytes += f.bytes; }
  return { files, bytes };
}
