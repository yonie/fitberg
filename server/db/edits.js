import { readFileSync } from 'node:fs';
import { writeStreams, writeLaps } from './repo.js';
import { absPathFor } from '../lib/blobstore.js';
import { parseFit } from '../parsers/fit.js';
import { parseTcx } from '../parsers/tcx.js';
import { sniff, KINDS } from '../ingest/sniff.js';
import { finalizeActivity, streamLength } from '../parsers/canonical.js';

// User edits: the things you typed, and the crop you set.
//
// Everything else in the database is derived from your files and can be thrown away and
// rebuilt. These cannot — nobody can re-derive the note you wrote or the fact that the
// last twenty minutes of a run were you driving home. So they live in their own table,
// outside the derived set, keyed by the activity's physical dedupe key rather than its
// id: ids are reassigned on every reindex, the dedupe key is a property of the ride.
//
// The crop is applied by re-deriving the activity from its original file with the
// samples outside the window dropped. The file is never modified, so a crop is always
// reversible and can be changed as often as you like.

const FIELDS = ['crop_start_s', 'crop_end_s', 'name', 'notes', 'perceived_exertion', 'feeling'];

export function getEdit(db, userId, dedupeKey) {
  return db.prepare('SELECT * FROM activity_edits WHERE user_id = ? AND dedupe_key = ?')
    .get(userId, dedupeKey) ?? null;
}

/**
 * Record an edit. Only the keys present in `patch` are touched, so setting a crop does
 * not wipe a note.
 */
export function saveEdit(db, userId, dedupeKey, patch) {
  const existing = getEdit(db, userId, dedupeKey) || {};
  const next = {};
  for (const field of FIELDS) {
    next[field] = Object.prototype.hasOwnProperty.call(patch, field)
      ? patch[field]
      : (existing[field] ?? null);
  }

  db.prepare(`INSERT INTO activity_edits
      (user_id, dedupe_key, crop_start_s, crop_end_s, name, notes, perceived_exertion,
       feeling, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
      crop_start_s = excluded.crop_start_s,
      crop_end_s = excluded.crop_end_s,
      name = excluded.name,
      notes = excluded.notes,
      perceived_exertion = excluded.perceived_exertion,
      feeling = excluded.feeling,
      updated_at = excluded.updated_at`).run(
    userId, dedupeKey,
    next.crop_start_s, next.crop_end_s, next.name, next.notes,
    next.perceived_exertion, next.feeling, Date.now(),
  );

  // An edit that says nothing is not worth keeping.
  if (FIELDS.every((f) => next[f] === null || next[f] === undefined)) {
    db.prepare('DELETE FROM activity_edits WHERE user_id = ? AND dedupe_key = ?')
      .run(userId, dedupeKey);
  }

  return next;
}

/**
 * Re-apply every stored edit onto the current activities.
 *
 * Called after an import and after a reindex. Without this, rebuilding the database
 * from your files would silently drop your notes and un-crop your activities.
 *
 * @returns {{applied: number, cropped: number, missing: number}}
 */
export function applyEdits(db, userId) {
  const edits = db.prepare('SELECT * FROM activity_edits WHERE user_id = ?').all(userId);
  const result = { applied: 0, cropped: 0, missing: 0 };

  for (const edit of edits) {
    const activity = db.prepare(
      'SELECT * FROM activities WHERE user_id = ? AND dedupe_key = ?',
    ).get(userId, edit.dedupe_key);

    if (!activity) {
      // The file this edit belongs to is not imported right now. The edit stays put:
      // re-import the file and the crop and notes come back with it.
      result.missing++;
      continue;
    }

    const sets = [];
    const values = [];
    for (const column of ['name', 'notes', 'perceived_exertion', 'feeling']) {
      if (edit[column] !== null && edit[column] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(edit[column]);
      }
    }
    if (sets.length) {
      db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`).run(...values, activity.id);
    }

    if (edit.crop_start_s != null || edit.crop_end_s != null) {
      if (applyCrop(db, activity, edit)) result.cropped++;
    }

    result.applied++;
  }

  return result;
}

/**
 * Apply a crop to one activity, in place.
 *
 * Works by re-deriving from the original file rather than by editing the stored
 * summary: the samples outside the window are dropped and every total and average is
 * recomputed from what is left. That is the only way to get an honest result — you
 * cannot subtract a drive home from an average heart rate.
 *
 * @returns {boolean} whether anything changed
 */
export function applyCrop(db, activity, edit) {
  if (!activity.original_hash) return false;

  const original = db.prepare('SELECT rel_path FROM originals WHERE hash = ?')
    .get(activity.original_hash);
  if (!original) return false;

  let fresh;
  try {
    const buffer = readFileSync(absPathFor(original.rel_path));
    // Re-parse with whatever reads this file, sniffed from the bytes for the same reason
    // ingest does it that way. Assuming FIT here made every TCX-backed activity — a Nike
    // Run Club export, say — refuse to crop: the parser threw, and the throw looked from
    // the outside exactly like a crop that would leave nothing.
    const parsed = parserFor(buffer)(buffer, { source: activity.source || 'file' });
    // A multisport file holds several activities; match on start time rather than
    // assuming the first one.
    fresh = parsed.activities.find((a) => Math.abs(a.startTime - activity.start_time) < 120000)
      ?? parsed.activities[0];
  } catch {
    return false;
  }
  if (!fresh) return false;

  // Clearing a crop must restore exactly what the device reported, so the full-recording
  // case re-derives nothing: it writes the freshly parsed activity back as-is. Running it
  // through cropActivity would recompute the totals from samples and land a few metres
  // and a second off the original — correct-ish, but not the same number the user saw
  // before they ever touched it.
  const restoring = edit.crop_start_s == null && edit.crop_end_s == null;
  const cropped = restoring
    ? fresh
    : cropActivity(fresh, edit.crop_start_s, edit.crop_end_s);
  if (!cropped) return false;

  db.prepare(`UPDATE activities SET
      elapsed_s = ?, moving_s = ?, distance_m = ?,
      elev_gain_m = ?, elev_loss_m = ?,
      avg_hr = ?, max_hr = ?, avg_power = ?, max_power = ?, normalized_power = ?,
      avg_cadence = ?, avg_speed_ms = ?, max_speed_ms = ?,
      calories = ?, work_kj = ?, polyline = ?,
      crop_start_s = ?, crop_end_s = ?, updated_at = ?
    WHERE id = ?`).run(
    cropped.elapsedS ?? null, cropped.movingS ?? null, cropped.distanceM ?? null,
    cropped.elevGainM ?? null, cropped.elevLossM ?? null,
    // Heart rate, power and cadence are whole numbers as devices report them; a
    // re-derived mean would otherwise show as 143.22077200777562.
    round(cropped.avgHr), round(cropped.maxHr),
    round(cropped.avgPower), round(cropped.maxPower), round(cropped.normalizedPower),
    round(cropped.avgCadence), cropped.avgSpeedMs ?? null, cropped.maxSpeedMs ?? null,
    // Calories scale with the fraction of the activity kept; there is no better
    // estimate available once samples are gone.
    cropped.calories ?? null, cropped.workKj ?? null, cropped.polyline ?? null,
    edit.crop_start_s ?? null, edit.crop_end_s ?? null, Date.now(),
    activity.id,
  );

  writeStreams(db, activity.id, cropped.streams);
  writeLaps(db, activity.id, cropped.laps);
  return true;
}

/**
 * Drop the samples outside [startS, endS] and recompute every derived figure.
 *
 * The summary that came from the device describes the whole recording, so it is cleared
 * before re-deriving — otherwise a cropped ride would keep the original distance.
 */
export function cropActivity(act, startS, endS) {
  const streams = act.streams || {};
  const t = streams.t;
  if (!Array.isArray(t) || !t.length) return null;

  const from = Number.isFinite(startS) ? startS : -Infinity;
  const to = Number.isFinite(endS) ? endS : Infinity;

  const keep = [];
  for (let i = 0; i < t.length; i++) {
    const time = t[i];
    if (Number.isFinite(time) && time >= from && time <= to) keep.push(i);
  }
  // A crop that would leave nothing is a mistake, not an instruction.
  if (keep.length < 2) return null;

  const next = { ...act, streams: {} };
  for (const [channel, values] of Object.entries(streams)) {
    if (!Array.isArray(values)) continue;
    next.streams[channel] = keep.map((i) => values[i]);
  }

  // Re-base time and cumulative distance so the activity starts at zero again.
  const baseTime = next.streams.t[0];
  next.streams.t = next.streams.t.map((v) => (Number.isFinite(v) ? v - baseTime : v));
  if (Array.isArray(next.streams.dist)) {
    const baseDist = firstFinite(next.streams.dist) ?? 0;
    next.streams.dist = next.streams.dist.map((v) => (Number.isFinite(v) ? v - baseDist : v));
  }

  // The start moves forward by however much was trimmed off the front.
  next.startTime = act.startTime + baseTime * 1000;

  // Laps that fall outside the window go; the rest are re-based.
  next.laps = (act.laps || [])
    .filter((lap) => {
      const lapStartS = (lap.startTime - act.startTime) / 1000;
      return lapStartS >= from - 1 && lapStartS <= to + 1;
    })
    .map((lap, index) => ({ ...lap, idx: index }));

  // Clear the device's own summary so finalizeActivity recomputes from the samples
  // that are left rather than reporting the whole ride's totals.
  for (const field of [
    'elapsedS', 'movingS', 'distanceM', 'elevGainM', 'elevLossM',
    'avgHr', 'maxHr', 'avgPower', 'maxPower', 'normalizedPower',
    'avgCadence', 'maxCadence', 'avgSpeedMs', 'maxSpeedMs', 'workKj', 'polyline',
  ]) {
    next[field] = null;
  }

  // Calories are not recoverable from samples, so they are pro-rated by kept time.
  if (Number.isFinite(act.calories) && Number.isFinite(act.elapsedS) && act.elapsedS > 0) {
    const keptS = next.streams.t[next.streams.t.length - 1] - next.streams.t[0];
    next.calories = Math.round(act.calories * Math.min(1, keptS / act.elapsedS));
  }

  // Device-reported training load described the whole recording, so it no longer
  // applies; the load engine will recompute from the cropped data.
  next.deviceTss = null;

  finalizeActivity(next);
  if (streamLength(next.streams) < 2) return null;
  return next;
}

/**
 * The parser that reads this original, chosen by content.
 *
 * Originals are stored decompressed and one activity file per blob, so only the two
 * leaf formats can turn up here — a ZIP or a gzip member was unwrapped at import.
 */
function parserFor(buffer) {
  const { kind } = sniff(buffer.subarray(0, 4096));
  if (kind === KINDS.TCX) return parseTcx;
  return parseFit;
}

const firstFinite = (list) => list.find((v) => Number.isFinite(v));
const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
