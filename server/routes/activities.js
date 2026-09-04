import { readStreams, readStreamRows } from '../db/repo.js';
import { decodeStream } from '../lib/codec.js';
import { getProfile, recomputeActivity, recomputeDaily } from '../metrics/engine.js';
import { saveEdit, applyCrop, readOriginalActivity } from '../db/edits.js';
import { prettySport, SPORTS } from '../parsers/sports.js';
import { readOriginal } from '../lib/blobstore.js';
import { shapeActivity, ACTIVITY_SELECT } from './shape.js';

export function registerActivityRoutes(app, { db }) {
  /** Paged, filterable activity list. */
  app.get('/api/activities', async (request) => {
    const q = request.query || {};
    const limit = clampInt(q.limit, 1, 200, 30);
    const offset = clampInt(q.offset, 0, 1e9, 0);

    const clauses = ['user_id = ?'];
    const params = [request.userId];

    if (q.sport) {
      const sports = String(q.sport).split(',').filter((s) => SPORTS.includes(s));
      if (sports.length) {
        clauses.push(`sport IN (${sports.map(() => '?').join(',')})`);
        params.push(...sports);
      }
    }
    if (q.from) { clauses.push('start_time >= ?'); params.push(Date.parse(`${q.from}T00:00:00Z`)); }
    if (q.to) { clauses.push('start_time <= ?'); params.push(Date.parse(`${q.to}T23:59:59Z`)); }
    if (q.search) {
      clauses.push('(name LIKE ? OR notes LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`);
    }
    if (q.hasGps === '1') clauses.push('polyline IS NOT NULL');

    const where = clauses.join(' AND ');
    const order = ({
      date: 'start_time', distance: 'distance_m', duration: 'moving_s', load: 'load',
    })[q.sort] || 'start_time';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM activities WHERE ${where}`).get(...params).c;
    const rows = db.prepare(
      `SELECT ${ACTIVITY_SELECT} FROM activities WHERE ${where}
       ORDER BY ${order} ${dir} NULLS LAST LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);

    return { total, limit, offset, activities: rows.map(shapeActivity) };
  });

  /** One activity, with laps and available stream channels. */
  app.get('/api/activities/:id', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });

    // A crop made before recording_elapsed_s existed left no record of how long the
    // recording was, which would strand the trim editor at its own cut. The original
    // file still knows, so work it out once and keep it.
    if (row.recording_elapsed_s == null && (row.crop_start_s != null || row.crop_end_s != null)) {
      const fresh = readOriginalActivity(db, row);
      const full = Number.isFinite(fresh?.elapsedS) ? Math.round(fresh.elapsedS) : null;
      if (full != null) {
        db.prepare('UPDATE activities SET recording_elapsed_s = ? WHERE id = ?').run(full, row.id);
        row.recording_elapsed_s = full;
      }
    }

    const laps = db.prepare('SELECT * FROM laps WHERE activity_id = ? ORDER BY idx').all(row.id);
    const channels = db.prepare('SELECT channel, n FROM streams WHERE activity_id = ?').all(row.id);
    const efforts = db.prepare(
      'SELECT kind, bucket, value FROM best_efforts WHERE activity_id = ? ORDER BY kind, bucket',
    ).all(row.id);

    const original = row.original_hash
      ? db.prepare('SELECT hash, rel_path, bytes, kind, original_name FROM originals WHERE hash = ?')
        .get(row.original_hash)
      : null;

    return {
      ...shapeActivity(row),
      subSport: row.sub_sport,
      elevLossM: row.elev_loss_m,
      elevMinM: row.elev_min_m,
      elevMaxM: row.elev_max_m,
      maxCadence: row.max_cadence,
      avgCadence: row.avg_cadence,
      maxPower: row.max_power,
      workKj: row.work_kj,
      avgTempC: row.avg_temp_c,
      decouplingPct: row.decoupling_pct,
      efficiencyFactor: row.efficiency_factor,
      variabilityIndex: row.variability_index,
      vo2maxEstimate: row.vo2max_estimate,
      aerobicPct: row.aerobic_pct,
      notes: row.notes,
      feeling: row.feeling,
      device: row.device,
      subSport: row.sub_sport,
      // The crop currently in force, so the editor opens where you left it.
      cropStartS: row.crop_start_s,
      cropEndS: row.crop_end_s,
      // How long the recording is with no crop applied — the range the trim editor is
      // allowed to span. elapsedS is the CROPPED length once a crop is in force, so
      // using that as the bound is what stopped you from ever undoing a trim by hand.
      recordingElapsedS: row.recording_elapsed_s ?? row.elapsed_s,
      bbox: row.bbox_json ? JSON.parse(row.bbox_json) : null,
      timezone: row.timezone,
      laps,
      streamChannels: channels,
      bestEfforts: efforts,
      // Provenance: which file this came from, so the user can always get it back.
      original: original ? {
        hash: original.hash,
        bytes: original.bytes,
        kind: original.kind,
        name: original.original_name,
        downloadUrl: `/api/activities/${row.id}/original`,
      } : null,
    };
  });

  /**
   * Stream data.
   *
   * Returns plain JSON arrays with `null` for gaps. Optional `resolution` decimates
   * the series server-side: a 6-hour ride is 21 600 samples per channel, which is
   * far more than a 900-pixel-wide chart can show, and sending it all just makes
   * the page slow.
   */
  app.get('/api/activities/:id/streams', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });

    const requested = request.query?.channels
      ? String(request.query.channels).split(',')
      : null;

    const decoded = {};
    let n = 0;

    // `full=1` asks for the whole recording rather than what is left after the crop.
    // The trim editor needs it: with only the cropped samples on the page there is
    // nothing to show for the part you are trying to put back, so the handles would
    // move over data that is not there.
    const wantsFull = request.query?.full === '1' || request.query?.full === 'true';
    const cropped = row.crop_start_s != null || row.crop_end_s != null;

    if (wantsFull && cropped) {
      const fresh = readOriginalActivity(db, row);
      if (!fresh) return reply.code(404).send({ error: 'The original file is unavailable' });
      for (const [channel, values] of Object.entries(fresh.streams || {})) {
        if (!Array.isArray(values)) continue;
        if (requested && !requested.includes(channel)) continue;
        // decimateAligned reads a gap as NaN, the way the stored streams encode one.
        decoded[channel] = Float64Array.from(values, (v) => (Number.isFinite(v) ? v : NaN));
        n = Math.max(n, decoded[channel].length);
      }
      if (!n) return { channels: {}, n: 0 };
    } else {
      const rows = readStreamRows(db, row.id)
        .filter((r) => !requested || requested.includes(r.channel));

      if (!rows.length) return { channels: {}, n: 0 };

      for (const streamRow of rows) {
        decoded[streamRow.channel] = decodeStream(streamRow);
        n = Math.max(n, decoded[streamRow.channel].length);
      }
    }

    const maxPoints = clampInt(request.query?.resolution, 100, 50000, 0);
    if (!maxPoints || n <= maxPoints) {
      const out = {};
      for (const [channel, values] of Object.entries(decoded)) {
        out[channel] = Array.from(values, (v) => (Number.isNaN(v) ? null : v));
      }
      return { n, resolution: null, channels: out };
    }

    const channels = decimateAligned(decoded, n, maxPoints);
    const outN = channels[Object.keys(channels)[0]]?.length ?? 0;
    return { n: outN, sourceN: n, resolution: maxPoints, channels };
  });

  /** The original file this activity was built from. */
  app.get('/api/activities/:id/original', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row?.original_hash) return reply.code(404).send({ error: 'No original file for this activity' });

    const original = db.prepare('SELECT * FROM originals WHERE hash = ?').get(row.original_hash);
    if (!original) return reply.code(404).send({ error: 'Original file is not in the store' });

    let buffer;
    try {
      buffer = readOriginal(original.rel_path);
    } catch (err) {
      return reply.code(500).send({ error: `Could not read the original file: ${err.message}` });
    }

    const name = original.original_name || `activity-${row.id}.${original.kind || 'bin'}`;
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
      .send(buffer);
  });

  /** Edit the athlete-authored fields. */
  app.patch('/api/activities/:id', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });

    const body = request.body || {};
    const sets = [];
    const values = [];

    const assign = (column, value) => { sets.push(`${column} = ?`); values.push(value); };

    if ('name' in body) assign('name', body.name || null);
    if ('notes' in body) assign('notes', body.notes || null);
    if ('sport' in body && SPORTS.includes(body.sport)) assign('sport', body.sport);
    const clamp = (value, lo, hi) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
    };
    const rpe = 'perceivedExertion' in body ? clamp(body.perceivedExertion, 1, 10) : undefined;
    const feeling = 'feeling' in body ? clamp(body.feeling, 1, 5) : undefined;
    if (rpe !== undefined) assign('perceived_exertion', rpe);
    if (feeling !== undefined) assign('feeling', feeling);
    if ('commute' in body) assign('commute', body.commute ? 1 : 0);
    if ('trainer' in body) assign('trainer', body.trainer ? 1 : 0);

    if (!sets.length) return reply.code(400).send({ error: 'Nothing to update' });

    sets.push('updated_at = ?'); values.push(Date.now());
    db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);

    // Mirror what you typed into activity_edits, which reindex does not delete. Writing
    // only to `activities` meant a rebuild from your files silently threw it away.
    const durable = {};
    if ('name' in body) durable.name = body.name || null;
    if ('notes' in body) durable.notes = body.notes || null;
    if (rpe !== undefined) durable.perceived_exertion = rpe;
    if (feeling !== undefined) durable.feeling = feeling;
    if (Object.keys(durable).length && row.dedupe_key) {
      saveEdit(db, request.userId, row.dedupe_key, durable);
    }

    // Sport and RPE both feed training load, so the derived numbers must follow.
    const affectsMetrics = 'sport' in body || 'perceivedExertion' in body || 'trainer' in body;
    if (affectsMetrics) {
      const { profile } = getProfile(db, request.userId);
      const updated = db.prepare('SELECT * FROM activities WHERE id = ?').get(row.id);
      recomputeActivity(db, request.userId, updated, profile);
      recomputeDaily(db, request.userId, { profile });
    }

    return { ok: true, recomputed: affectsMetrics };
  });

  /**
   * Crop an activity, without touching the file.
   *
   * `{ startS, endS }` in seconds from the start of the recording; either may be null.
   * The crop is stored separately from the derived data, so it survives a reindex, and
   * it is applied by re-deriving from the original — which is why every total and
   * average comes out honest rather than scaled.
   */
  app.put('/api/activities/:id/crop', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });
    if (!row.dedupe_key) return reply.code(400).send({ error: 'This activity cannot be cropped' });

    const body = request.body || {};
    const bound = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    const startS = bound(body.startS);
    const endS = bound(body.endS);

    if (startS !== null && endS !== null && endS <= startS) {
      return reply.code(400).send({ error: 'The end of the crop must come after the start' });
    }

    saveEdit(db, request.userId, row.dedupe_key, { crop_start_s: startS, crop_end_s: endS });

    // Re-derive from the original. Clearing the crop is the same operation with no
    // bounds, which restores the full recording.
    const applied = applyCrop(db, row, { crop_start_s: startS, crop_end_s: endS });
    if (!applied && (startS !== null || endS !== null)) {
      return reply.code(400).send({
        error: 'That crop would leave nothing, or the original file is unavailable',
      });
    }

    const { profile } = getProfile(db, request.userId);
    const updated = db.prepare('SELECT * FROM activities WHERE id = ?').get(row.id);
    recomputeActivity(db, request.userId, updated, profile);
    recomputeDaily(db, request.userId, { profile });

    return {
      ok: true,
      cropStartS: startS,
      cropEndS: endS,
      recordingElapsedS: updated.recording_elapsed_s ?? updated.elapsed_s,
      distanceM: updated.distance_m,
      elapsedS: updated.elapsed_s,
      movingS: updated.moving_s,
    };
  });

  /**
   * Delete an activity.
   *
   * Note that this removes the derived row, not the original file — the original
   * stays in the content-addressed store, so a reindex would bring the activity
   * back. That is deliberate: deletion here is "hide this from my history", and
   * genuinely destroying source data is a separate, explicit operation.
   */
  app.delete('/api/activities/:id', async (request, reply) => {
    const row = getOwned(db, request.userId, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });

    db.prepare('DELETE FROM activities WHERE id = ?').run(row.id);
    const { profile } = getProfile(db, request.userId);
    recomputeDaily(db, request.userId, { profile });

    return {
      ok: true,
      note: row.original_hash
        ? 'The activity was removed from your history. Its original file is still in the store, '
          + 'so a reindex would restore it. Use the originals settings page to erase it permanently.'
        : 'The activity was removed.',
    };
  });

  /** Distinct sports present, for filter menus. */
  app.get('/api/activities/sports', async (request) => {
    const rows = db.prepare(
      'SELECT sport, COUNT(*) AS count FROM activities WHERE user_id = ? GROUP BY sport ORDER BY count DESC',
    ).all(request.userId);
    return { sports: rows.map((r) => ({ sport: r.sport, label: prettySport(r.sport), count: r.count })) };
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getOwned(db, userId, id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return null;
  return db.prepare('SELECT * FROM activities WHERE id = ? AND user_id = ?').get(numeric, userId) ?? null;
}

/**
 * Decimate every channel together so the returned arrays stay index-aligned.
 *
 * All channels MUST come out the same length — the client indexes across them to
 * pair a heart rate with a map position, so decimating each one independently
 * would silently desynchronise the chart from the track.
 *
 * Each bucket emits exactly two points per channel:
 *   - value channels (hr, power, …) emit their min and max, because plain
 *     sampling erases spikes — a 1200 W sprint inside a 3-hour ride would just
 *     vanish from the chart
 *   - monotonic channels (t, dist) and coordinates emit the bucket's first and
 *     last sample, since min/max on latitude would zig-zag the drawn track
 */
function decimateAligned(decoded, n, maxPoints) {
  const MONOTONIC = new Set(['t', 'dist', 'lat', 'lng']);
  // Two output points per bucket, so aim for half as many buckets.
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const bucketSize = Math.ceil(n / buckets);

  const out = {};
  for (const channel of Object.keys(decoded)) out[channel] = [];

  for (let start = 0; start < n; start += bucketSize) {
    const end = Math.min(start + bucketSize, n);

    for (const [channel, values] of Object.entries(decoded)) {
      const target = out[channel];

      if (MONOTONIC.has(channel)) {
        target.push(firstFinite(values, start, end), lastFinite(values, start, end));
        continue;
      }

      let min = Infinity;
      let max = -Infinity;
      let any = false;
      for (let i = start; i < end; i++) {
        const v = values[i];
        if (Number.isNaN(v)) continue;
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!any) target.push(null, null);
      else target.push(min, max);
    }
  }

  return out;
}

function firstFinite(values, start, end) {
  for (let i = start; i < end; i++) if (!Number.isNaN(values[i])) return values[i];
  return null;
}

function lastFinite(values, start, end) {
  for (let i = end - 1; i >= start; i--) if (!Number.isNaN(values[i])) return values[i];
  return null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
