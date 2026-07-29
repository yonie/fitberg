import fs from 'node:fs';
import path from 'node:path';

import { sniff, KINDS } from './sniff.js';
import { zipEntries, gunzip, readHead } from './archive.js';
import { putBuffer } from '../lib/blobstore.js';
import { parseFit } from '../parsers/fit.js';
import { parseTcx } from '../parsers/tcx.js';
import { finalizeActivity, streamLength } from '../parsers/canonical.js';
import {
  insertActivity, findDuplicate, mergeActivity, writeStreams, writeLaps,
} from '../db/repo.js';
import { recomputeAll } from '../metrics/engine.js';
import { applyEdits } from '../db/edits.js';

// The ingest pipeline.
//
// One entry point, two formats: FIT and TCX. Give it a single `.fit`, a `.fit.gz`, a
// `.tcx` (Nike Run Club and others export these), a whole unopened export ZIP, or a
// directory of files off a head unit — it recurses through containers, identifies
// files by content rather than name, stores every original byte-for-byte, and is
// idempotent. Importing the same data twice changes nothing.
//
// Anything that is neither is skipped with a reason saying what it actually was, so a
// skip is never a silent loss.

const MAX_LOG_ENTRIES = 400;

class ImportReport {
  constructor(source, filename) {
    this.source = source;
    this.filename = filename;
    this.found = 0;
    this.imported = 0;
    this.merged = 0;
    this.duplicates = 0;
    this.skipped = 0;
    // Archive members that were never activities in the first place.
    this.ignored = 0;
    this.failed = 0;
    this.activityIds = [];
    this.log = [];
    this.truncatedLog = 0;
    this.warnings = [];
    // Skips grouped by reason. A Strava export can hold hundreds of GPX files, and
    // "88 GPX files skipped" is useful where 88 identical log lines are not — the log
    // is capped, so without this the real total would be lost to truncation.
    this.skipReasons = {};
  }

  note(file, status, reason, extra = {}) {
    if (status === 'skipped' && reason) {
      this.skipReasons[reason] = (this.skipReasons[reason] || 0) + 1;
    }
    if (this.log.length < MAX_LOG_ENTRIES) this.log.push({ file, status, reason, ...extra });
    else this.truncatedLog++;
  }

  toJSON() {
    return {
      source: this.source,
      filename: this.filename,
      found: this.found,
      imported: this.imported,
      merged: this.merged,
      duplicates: this.duplicates,
      skipped: this.skipped,
      ignored: this.ignored,
      failed: this.failed,
      skipReasons: this.skipReasons,
      log: this.log,
      truncatedLog: this.truncatedLog,
      warnings: this.warnings.slice(0, 50),
    };
  }
}

/**
 * Ingest a file from disk — used by the inbox watcher and by uploads (which are
 * spooled to a temp file first, so a multi-gigabyte archive is read lazily rather
 * than buffered).
 */
export async function ingestPath(db, userId, absPath, opts = {}) {
  const filename = opts.filename || path.basename(absPath);
  const report = new ImportReport(opts.source || 'file', filename);

  const head = await readHead(absPath);
  const { kind, reason } = sniff(head, filename);

  try {
    if (kind === KINDS.ZIP) {
      await ingestZip(db, userId, absPath, report, opts);
    } else {
      const buffer = await fs.promises.readFile(absPath);
      await ingestBuffer(db, userId, buffer, { ...opts, filename, kind, kindReason: reason, report });
    }
  } catch (err) {
    report.failed++;
    report.note(filename, 'failed', err.message);
  }

  if (opts.recomputeMetrics !== false) finishImport(db, userId, report, opts);
  return report;
}

/** Ingest an in-memory buffer. Used for API pushes and archive members. */
export async function ingestBuffer(db, userId, buffer, opts = {}) {
  const report = opts.report || new ImportReport(opts.source || 'file', opts.filename || 'upload');
  const filename = opts.filename || 'upload';

  const detected = opts.kind || sniff(buffer.subarray(0, 4096), filename);
  const kind = typeof detected === 'string' ? detected : detected.kind;
  const reason = typeof detected === 'string' ? opts.kindReason : detected.reason;

  try {
    switch (kind) {
      case KINDS.GZIP: {
        // Strava ships `.fit.gz`; unwrap and re-sniff the payload.
        await ingestBuffer(db, userId, gunzip(buffer), {
          ...opts, filename: filename.replace(/\.gz$/i, ''), kind: undefined, report,
        });
        break;
      }
      case KINDS.FIT:
        await handleFit(db, userId, buffer, filename, report, opts);
        break;
      case KINDS.TCX:
        await handleTcx(db, userId, buffer, filename, report, opts);
        break;
      default:
        // A null reason means "export scaffolding, not an activity" — counted so the
        // numbers still add up, but not itemised.
        if (reason === null) { report.ignored++; break; }
        report.skipped++;
        report.note(filename, 'skipped', reason || 'not a FIT file');
    }
  } catch (err) {
    report.failed++;
    report.note(filename, 'failed', err.message);
  }

  if (!opts.report && opts.recomputeMetrics !== false) finishImport(db, userId, report, opts);
  return report;
}

/**
 * Walk a ZIP archive, importing every FIT file inside at any depth.
 * A Strava export is exactly this: `activities/*.fit.gz` plus a lot of things we
 * have no use for.
 */
async function ingestZip(db, userId, zipPath, report, opts) {
  for await (const entry of zipEntries(zipPath)) {
    try {
      if (entry.tooBigToBuffer) {
        report.skipped++;
        report.note(entry.name, 'skipped', `${formatBytes(entry.size)} — too large to be a FIT file`);
        continue;
      }
      const buffer = await entry.buffer();
      await ingestBuffer(db, userId, buffer, {
        ...opts, filename: entry.baseName, source: report.source, report,
      });
    } catch (err) {
      report.failed++;
      report.note(entry.name, 'failed', err.message);
    }
  }
}

/** Store the bytes, parse, persist. */
async function handleFit(db, userId, buffer, filename, report, opts) {
  const stored = putBuffer(buffer, { ext: '.fit' });
  recordOriginal(db, stored, 'fit', opts.source || report.source, filename);

  const { activities, warnings } = parseFit(buffer, { source: report.source });
  if (warnings?.length) report.warnings.push(...warnings.map((w) => `${filename}: ${w}`));

  for (const act of activities) {
    report.found++;
    act.originalHash = stored.hash;
    storeActivity(db, userId, act, report, { originalHash: stored.hash, filename });
  }
}

/** Store the bytes, parse, persist. Mirrors {@link handleFit}. */
async function handleTcx(db, userId, buffer, filename, report, opts) {
  const stored = putBuffer(buffer, { ext: '.tcx' });
  recordOriginal(db, stored, 'tcx', opts.source || report.source, filename);

  const { activities, warnings } = parseTcx(buffer, { source: report.source });
  if (warnings?.length) report.warnings.push(...warnings.map((w) => `${filename}: ${w}`));

  for (const act of activities) {
    report.found++;
    act.originalHash = stored.hash;
    storeActivity(db, userId, act, report, { originalHash: stored.hash, filename });
  }
}

/**
 * Persist one activity, deduplicating against what is already stored.
 *
 * Matching is physical — sport, start time to the nearest two minutes, distance to
 * the nearest 100 m — not by any platform's id. So the same ride arriving from a
 * Strava export and from the head unit collapses into one activity.
 */
function storeActivity(db, userId, act, report, { originalHash = null, filename = null } = {}) {
  if (!Number.isFinite(act.startTime)) {
    report.skipped++;
    report.note(filename || 'activity', 'skipped', 'no usable start time');
    return 'skipped';
  }

  if (originalHash) act.originalHash = originalHash;
  if (!act.dedupeKey) finalizeActivity(act);

  const newHasStreams = streamLength(act.streams || {}) > 0;
  const existing = findDuplicate(db, userId, act);

  if (existing) {
    const merged = mergeActivity(db, existing, act, { newHasStreams });
    if (merged.updated) {
      report.merged++;
      report.note(filename || 'activity', 'merged',
        merged.streamsReplaced
          ? 'matched an existing activity and added its detailed data'
          : `matched an existing activity and filled in ${merged.fields.length} field(s)`,
        { activityId: existing.id });
      report.activityIds.push(existing.id);
      return 'merged';
    }
    report.duplicates++;
    report.note(filename || 'activity', 'duplicate', 'already imported', { activityId: existing.id });
    return 'duplicate';
  }

  const id = insertActivity(db, userId, act);
  writeStreams(db, id, act.streams);
  writeLaps(db, id, act.laps);

  report.imported++;
  report.activityIds.push(id);
  report.note(filename || 'activity', 'imported',
    `${act.sport}${act.distanceM ? `, ${(act.distanceM / 1000).toFixed(2)} km` : ''}`,
    { activityId: id });
  return 'inserted';
}

function recordOriginal(db, stored, kind, source, originalName) {
  db.prepare(`INSERT INTO originals (hash, rel_path, bytes, kind, source, original_name, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (hash) DO NOTHING`).run(
    stored.hash, stored.relPath, stored.bytes, kind, source, originalName, Date.now(),
  );
}

/**
 * Recompute derived metrics after an import.
 *
 * Deliberately a full recompute rather than an incremental one: importing a
 * back-catalogue changes the athlete's whole history — inferred FTP and threshold
 * pace shift, which changes the load of every activity, which changes every day's
 * fitness curve. Incremental updates here would be subtly wrong forever.
 */
export function finishImport(db, userId, report, opts = {}) {
  if (!report.imported && !report.merged) return report;
  try {
    // Before the metrics, not after: a crop changes the activity's load, so applying it
    // afterwards would leave the fitness curve describing the uncropped ride.
    report.edits = applyEdits(db, userId);
    const result = recomputeAll(db, userId, { onProgress: opts.onProgress });
    report.metrics = {
      activities: result.activities,
      days: result.daily.days,
      profileChanged: result.profileChanged,
    };
  } catch (err) {
    report.warnings.push(`metrics recompute failed: ${err.message}`);
  }
  return report;
}

// ─── import bookkeeping ───────────────────────────────────────────────────────

export function beginImportRecord(db, userId, { source, filename, bytes }) {
  return db.prepare(`INSERT INTO imports
    (user_id, source, filename, bytes, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
    .run(userId, source || null, filename || null, bytes || null, Date.now()).lastInsertRowid;
}

export function finishImportRecord(db, importId, report, status = 'done') {
  db.prepare(`UPDATE imports SET status = ?, found = ?, imported = ?, duplicates = ?,
      failed = ?, log_json = ?, finished_at = ?
    WHERE id = ?`).run(
    status, report.found, report.imported + report.merged, report.duplicates,
    report.failed, JSON.stringify(report.toJSON()), Date.now(), importId,
  );
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export { ImportReport };
