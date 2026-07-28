import fs from 'node:fs';
import { config } from '../lib/config.js';
import { truncateDerived } from '../db/index.js';
import { absPathFor, walkOriginals, hashBuffer, verifyStore } from '../lib/blobstore.js';
import { ingestBuffer, ImportReport, finishImport } from './index.js';
import { KINDS } from './sniff.js';

// Reindex: rebuild the entire database from the originals store.
//
// This is the promise the whole design rests on — the database is a cache, your
// files are the truth. It means:
//
//   * a schema change is just "add the column, reindex"
//   * a parser bug fix retroactively improves every activity you ever imported
//   * a corrupted or deleted database costs you nothing but CPU time
//
// It is destructive to derived data only: users, API keys, connector tokens and
// survive, because those were never derivable from a file.

/**
 * @param {object} db
 * @param {number} userId
 * @param {{onProgress?:(p:object)=>void, verify?:boolean}} [opts]
 */
export async function reindex(db, userId, opts = {}) {
  const started = Date.now();
  const report = new ImportReport('reindex', 'originals store');

  // Optionally confirm nothing has rotted before trusting it as the source of truth.
  let integrity = null;
  if (opts.verify) {
    integrity = verifyStore({ onProgress: opts.onProgress });
    if (integrity.corrupt.length) {
      report.warnings.push(
        `${integrity.corrupt.length} original file(s) no longer match their content hash — `
        + 'these are corrupted and were skipped',
      );
    }
  }
  const corrupt = new Set((integrity?.corrupt || []).map((c) => c.relPath));

  // The ledger tells us what each file is, so nothing needs re-sniffing. Fall back
  // to sniffing for any file present on disk but missing from the ledger.
  const ledger = new Map(
    db.prepare('SELECT hash, rel_path, kind, source, original_name FROM originals').all()
      .map((r) => [r.rel_path, r]),
  );

  const files = [];
  for (const file of walkOriginals()) {
    if (corrupt.has(file.relPath)) continue;
    files.push({ ...file, meta: ledger.get(file.relPath) || null });
  }

  truncateDerived(db);

  let done = 0;
  for (const file of files) {
    try {
      const buffer = await fs.promises.readFile(file.absPath);
      await ingestBuffer(db, userId, buffer, {
        filename: file.meta?.original_name || file.relPath,
        source: file.meta?.source || 'file',
        kind: file.meta?.kind && file.meta.kind !== 'unknown' ? mapLedgerKind(file.meta.kind) : undefined,
        report,
        recomputeMetrics: false,
      });
    } catch (err) {
      report.failed++;
      report.note(file.relPath, 'failed', err.message);
    }

    done++;
    if (opts.onProgress && done % 25 === 0) {
      opts.onProgress({ phase: 'replay', done, total: files.length });
    }
  }

  // One metrics pass at the end rather than per file.
  finishImport(db, userId, report, { onProgress: opts.onProgress });

  return {
    ...report.toJSON(),
    files: files.length,
    integrity,
    elapsedMs: Date.now() - started,
  };
}

/** The ledger stores a bare extension; map it to a sniff kind. */
function mapLedgerKind(kind) {
  return kind === 'fit' ? KINDS.FIT : kind;
}

/**
 * Rebuild the originals ledger by walking the store.
 * Only needed if the `originals` table is lost but the files survive — recovering
 * from a deleted database, for instance.
 */
export function rebuildLedger(db) {
  const insert = db.prepare(`INSERT INTO originals
      (hash, rel_path, bytes, kind, source, original_name, container, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (hash) DO NOTHING`);

  let added = 0;
  for (const file of walkOriginals()) {
    const hash = file.relPath.split(/[/\\]/).pop().split('.')[0];
    const ext = (file.relPath.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    insert.run(hash, file.relPath, file.bytes, ext || null, null, null, null, Date.now());
    added++;
  }
  return { added };
}
