// Activity persistence: insert, dedupe, merge, and stream blob read/write.

import { encodeStream, decodeStream, CHANNEL_NAMES, hasSignal } from '../lib/codec.js';
import { dedupeKey, dedupeKeyNeighbours, STREAM_CHANNELS } from '../parsers/canonical.js';

const ACTIVITY_COLUMNS = [
  'source', 'source_id', 'dedupe_key', 'name', 'sport', 'sub_sport', 'device',
  'start_time', 'utc_offset_s', 'timezone',
  'elapsed_s', 'moving_s', 'recording_elapsed_s',
  'distance_m', 'elev_gain_m', 'elev_loss_m', 'elev_min_m', 'elev_max_m',
  'avg_speed_ms', 'max_speed_ms', 'avg_hr', 'max_hr', 'avg_cadence', 'max_cadence',
  'avg_power', 'max_power', 'normalized_power', 'work_kj', 'calories', 'avg_temp_c',
  'trainer', 'commute', 'manual',
  'polyline', 'start_lat', 'start_lng', 'bbox_json',
  'load', 'load_method', 'intensity_factor', 'variability_index', 'decoupling_pct',
  'efficiency_factor', 'vo2max_estimate', 'aerobic_pct',
  'perceived_exertion', 'feeling', 'notes',
  'original_hash', 'summary_json',
];

/** Map a canonical activity object onto database column values. */
function toRow(act) {
  return {
    source: act.source || 'file',
    source_id: act.sourceId ?? null,
    dedupe_key: act.dedupeKey || dedupeKey(act),
    name: act.name ?? null,
    sport: act.sport || 'other',
    sub_sport: act.subSport ?? null,
    device: act.device ?? null,
    start_time: act.startTime,
    utc_offset_s: act.utcOffsetS || 0,
    timezone: act.timezone ?? null,
    elapsed_s: intOrNull(act.elapsedS),
    moving_s: intOrNull(act.movingS),
    // On import the activity is the whole recording, so the two agree; a crop later
    // shortens elapsed_s and leaves this one alone.
    recording_elapsed_s: intOrNull(act.recordingElapsedS ?? act.elapsedS),
    distance_m: numOrNull(act.distanceM),
    elev_gain_m: numOrNull(act.elevGainM),
    elev_loss_m: numOrNull(act.elevLossM),
    elev_min_m: numOrNull(act.elevMinM),
    elev_max_m: numOrNull(act.elevMaxM),
    avg_speed_ms: numOrNull(act.avgSpeedMs),
    max_speed_ms: numOrNull(act.maxSpeedMs),
    avg_hr: numOrNull(act.avgHr),
    max_hr: numOrNull(act.maxHr),
    avg_cadence: numOrNull(act.avgCadence),
    max_cadence: numOrNull(act.maxCadence),
    avg_power: numOrNull(act.avgPower),
    max_power: numOrNull(act.maxPower),
    normalized_power: numOrNull(act.normalizedPower),
    work_kj: numOrNull(act.workKj),
    calories: numOrNull(act.calories),
    avg_temp_c: numOrNull(act.avgTempC),
    trainer: act.trainer ? 1 : 0,
    commute: act.commute ? 1 : 0,
    manual: act.manual ? 1 : 0,
    polyline: act.polyline ?? null,
    start_lat: numOrNull(act.startLat),
    start_lng: numOrNull(act.startLng),
    bbox_json: act.bbox ? JSON.stringify(act.bbox) : null,
    load: numOrNull(act.load),
    load_method: act.loadMethod ?? null,
    intensity_factor: numOrNull(act.intensityFactor),
    variability_index: numOrNull(act.variabilityIndex),
    decoupling_pct: numOrNull(act.decouplingPct),
    efficiency_factor: numOrNull(act.efficiencyFactor),
    vo2max_estimate: numOrNull(act.vo2maxEstimate),
    aerobic_pct: numOrNull(act.aerobicPct),
    perceived_exertion: intOrNull(act.perceivedExertion),
    feeling: intOrNull(act.feeling),
    notes: act.notes ?? null,
    original_hash: act.originalHash ?? null,
    summary_json: act.summary ? JSON.stringify(act.summary) : null,
  };
}

export function insertActivity(db, userId, act) {
  const row = toRow(act);
  const now = Date.now();
  const cols = [...ACTIVITY_COLUMNS, 'user_id', 'created_at', 'updated_at'];
  const placeholders = cols.map(() => '?').join(', ');
  const values = [...ACTIVITY_COLUMNS.map((c) => row[c]), userId, now, now];

  const result = db.prepare(
    `INSERT INTO activities (${cols.join(', ')}) VALUES (${placeholders})`,
  ).run(...values);

  return result.lastInsertRowid;
}

/**
 * Find an existing activity that is physically the same session.
 *
 * Checks the neighbouring time buckets too, because platforms disagree about an
 * activity's start instant by a few seconds (upload time vs first GPS fix), and a
 * pair straddling a bucket boundary would otherwise import twice.
 */
export function findDuplicate(db, userId, act) {
  const keys = dedupeKeyNeighbours(act);
  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM activities WHERE user_id = ? AND dedupe_key IN (${placeholders})`,
  ).all(userId, ...keys);

  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];

  // Several candidates: take the one closest in start time.
  return rows.reduce((best, row) =>
    Math.abs(row.start_time - act.startTime) < Math.abs(best.start_time - act.startTime) ? row : best);
}

/**
 * Enrich an existing activity with a better version of the same session.
 *
 * This is what lets the same ride arrive from two places and end up as one record —
 * off the head unit and out of a Strava export, say. Rules:
 *
 *   - a record with sample streams beats one without, and its streams replace
 *   - a non-null field beats a null field
 *   - user-authored fields (notes, RPE) are never overwritten with null
 *   - `manual` clears as soon as any real recording arrives
 *
 * @returns {{updated:boolean, fields:string[], streamsReplaced:boolean}}
 */
export function mergeActivity(db, existing, act, { newHasStreams }) {
  const incoming = toRow(act);
  const existingHasStreams = db.prepare(
    'SELECT COUNT(*) AS c FROM streams WHERE activity_id = ?',
  ).get(existing.id).c > 0;

  const upgradeStreams = newHasStreams && !existingHasStreams;

  // Fields we will take from the incoming record when it has something to say.
  const mergeable = ACTIVITY_COLUMNS.filter((c) => ![
    'dedupe_key', 'source', 'source_id', 'original_hash',
    // Never clobber the athlete's own annotations.
    'notes', 'perceived_exertion', 'feeling',
  ].includes(c));

  const sets = [];
  const values = [];
  const changed = [];

  for (const col of mergeable) {
    const next = incoming[col];
    const prev = existing[col];
    if (next === null || next === undefined) continue;

    const isEmptyPrev = prev === null || prev === undefined || prev === '';
    // Booleans stored as 0 count as "set", so only fill genuinely absent values —
    // except when the incoming record has real streams, in which case its
    // measured summary is more trustworthy than a manual entry's guess.
    const shouldOverwrite = isEmptyPrev || (upgradeStreams && !['trainer', 'commute'].includes(col));

    if (shouldOverwrite && prev !== next) {
      sets.push(`${col} = ?`);
      values.push(next);
      changed.push(col);
    }
  }

  // A real recording means this is no longer a manual entry.
  if (newHasStreams && existing.manual) {
    sets.push('manual = 0');
    changed.push('manual');
  }

  // Keep the athlete's notes and add anything new rather than replacing.
  if (act.notes && !existing.notes) {
    sets.push('notes = ?'); values.push(act.notes); changed.push('notes');
  }
  if (Number.isFinite(act.perceivedExertion) && !existing.perceived_exertion) {
    sets.push('perceived_exertion = ?'); values.push(act.perceivedExertion); changed.push('perceived_exertion');
  }

  if (sets.length) {
    sets.push('updated_at = ?'); values.push(Date.now());
    db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`).run(...values, existing.id);
  }

  if (upgradeStreams) {
    writeStreams(db, existing.id, act.streams);
    writeLaps(db, existing.id, act.laps);
  }

  return { updated: sets.length > 0 || upgradeStreams, fields: changed, streamsReplaced: upgradeStreams };
}

export function writeStreams(db, activityId, streams) {
  if (!streams) return 0;
  db.prepare('DELETE FROM streams WHERE activity_id = ?').run(activityId);

  const stmt = db.prepare(
    'INSERT INTO streams (activity_id, channel, n, dtype, data) VALUES (?, ?, ?, ?, ?)',
  );

  let written = 0;
  for (const channel of CHANNEL_NAMES) {
    const values = streams[channel];
    if (!Array.isArray(values) || !values.length) continue;
    // `t` is monotonic indices and always "has signal"; other channels are only
    // worth a row if they contain at least one real reading.
    if (channel !== 't' && !hasSignal(values)) continue;
    const encoded = encodeStream(channel, values);
    stmt.run(activityId, encoded.channel, encoded.n, encoded.dtype, encoded.data);
    written++;
  }
  return written;
}

export function writeLaps(db, activityId, laps) {
  db.prepare('DELETE FROM laps WHERE activity_id = ?').run(activityId);
  if (!Array.isArray(laps) || !laps.length) return 0;

  const stmt = db.prepare(`INSERT INTO laps
    (activity_id, idx, start_time, elapsed_s, moving_s, distance_m, avg_hr, max_hr,
     avg_power, avg_speed_ms, avg_cadence, elev_gain_m)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let n = 0;
  for (const [i, lap] of laps.entries()) {
    stmt.run(
      activityId, lap.idx ?? i, intOrNull(lap.startTime), intOrNull(lap.elapsedS),
      intOrNull(lap.movingS), numOrNull(lap.distanceM), numOrNull(lap.avgHr), numOrNull(lap.maxHr),
      numOrNull(lap.avgPower), numOrNull(lap.avgSpeedMs), numOrNull(lap.avgCadence),
      numOrNull(lap.elevGainM),
    );
    n++;
  }
  return n;
}

/**
 * Read stream channels back as plain arrays (NaN for gaps), which is what the
 * metrics functions expect.
 * @returns {Record<string, number[]>}
 */
export function readStreams(db, activityId, channels = null) {
  const wanted = channels && channels.length
    ? channels
    : STREAM_CHANNELS;

  const placeholders = wanted.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT channel, n, dtype, data FROM streams WHERE activity_id = ? AND channel IN (${placeholders})`,
  ).all(activityId, ...wanted);

  const out = {};
  for (const row of rows) {
    out[row.channel] = Array.from(decodeStream(row));
  }
  return out;
}

/** Raw typed arrays, for endpoints that stream bytes straight to the client. */
export function readStreamRows(db, activityId) {
  return db.prepare(
    'SELECT channel, n, dtype, data FROM streams WHERE activity_id = ?',
  ).all(activityId);
}

export function replaceBestEfforts(db, userId, activityId, sport, startTime, efforts) {
  db.prepare('DELETE FROM best_efforts WHERE activity_id = ?').run(activityId);
  if (!efforts?.length) return 0;

  const stmt = db.prepare(`INSERT INTO best_efforts
    (user_id, activity_id, sport, kind, bucket, value, start_idx, start_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const e of efforts) {
    stmt.run(userId, activityId, sport, e.kind, e.bucket, e.value, e.startIdx ?? null, startTime);
  }
  return efforts.length;
}

const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const intOrNull = (v) => (Number.isFinite(v) ? Math.round(v) : null);
