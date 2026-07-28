// The metrics engine: turns stored activities into training metrics.
//
// Split into two phases because they have very different costs:
//
//   per-activity  — load, decoupling, best efforts. Runs once when an activity is
//                   imported, and again on reindex.
//   daily rollup  — fitness/fatigue/form. These are inherently
//                   sequential over the whole timeline (each day depends on the
//                   day before), so they are recomputed in one sweep rather than
//                   incrementally. A decade of data is ~4000 iterations of
//                   arithmetic: fast enough to just redo it.

import { readStreams, replaceBestEfforts } from '../db/repo.js';
import { readProfile, resolveProfile } from './profile.js';
import { computeLoad, computeDecoupling, computeEfficiencyFactor, computeAerobicShare } from './load.js';
import {
  computeBestEfforts, vdot, thresholdSpeedFromVdot, vo2maxFromFtp, vo2maxFromHeartRate,
} from './efforts.js';
import { computeFitnessSeries, dayRange, localDayOf } from './fitness.js';
import { familyOf } from '../parsers/sports.js';

/**
 * Aggregates over the athlete's own history, used to infer the profile fields
 * they have not filled in.
 */
export function observedAggregates(db, userId) {
  const hr = db.prepare(`SELECT MAX(max_hr) AS maxHr, MIN(NULLIF(avg_hr, 0)) AS minAvgHr
    FROM activities WHERE user_id = ? AND max_hr > 100`).get(userId) || {};

  const bestPower = (bucket) => db.prepare(`SELECT MAX(value) AS v FROM best_efforts
    WHERE user_id = ? AND kind = 'peak_power' AND bucket = ?`).get(userId, bucket)?.v ?? null;

  const bestHr = (bucket) => db.prepare(`SELECT MAX(value) AS v FROM best_efforts
    WHERE user_id = ? AND kind = 'peak_hr' AND bucket = ?`).get(userId, bucket)?.v ?? null;

  return {
    maxHrObserved: hr.maxHr ?? null,
    bestPower20min: bestPower(1200),
    bestPower60min: bestPower(3600),
    bestHr60min: bestHr(3600),
    thresholdPaceMs: estimateThresholdPace(db, userId),
  };
}

/**
 * Threshold running speed from the athlete's best recent efforts.
 * Takes the highest VDOT across the standard race distances in the last 90 days —
 * a good hard effort is a better fitness probe than any average.
 */
function estimateThresholdPace(db, userId) {
  const since = Date.now() - 90 * 86400000;
  const rows = db.prepare(`SELECT bucket, MIN(value) AS seconds FROM best_efforts
    WHERE user_id = ? AND kind = 'fastest_distance' AND start_time >= ?
      AND sport IN ('run','trail_run')
    GROUP BY bucket`).all(userId, since);

  let bestVdot = null;
  for (const row of rows) {
    // Below 1500 m the effort is too anaerobic for the VDOT model to hold.
    if (row.bucket < 1500) continue;
    const v = vdot(row.bucket, row.seconds);
    if (v !== null && (bestVdot === null || v > bestVdot)) bestVdot = v;
  }

  return bestVdot === null ? null : thresholdSpeedFromVdot(bestVdot);
}

/** Resolve the athlete profile, merging explicit settings with inferred values. */
export function getProfile(db, userId) {
  const user = db.prepare('SELECT settings_json FROM users WHERE id = ?').get(userId);
  const explicit = readProfile(user?.settings_json);
  const observed = observedAggregates(db, userId);
  return resolveProfile(explicit, observed);
}

/**
 * Recompute the derived metrics for one activity.
 * @param {object} db
 * @param {number} userId
 * @param {object} activityRow  row from `activities`
 * @param {object} profile      resolved profile
 * @param {{skipBestEfforts?:boolean}} [opts]
 */
export function recomputeActivity(db, userId, activityRow, profile, opts = {}) {
  const streams = readStreams(db, activityRow.id);

  // Rebuild the shape the metric functions expect from the stored row.
  const act = {
    sport: activityRow.sport,
    trainer: !!activityRow.trainer,
    movingS: activityRow.moving_s,
    elapsedS: activityRow.elapsed_s,
    distanceM: activityRow.distance_m,
    avgHr: activityRow.avg_hr,
    maxHr: activityRow.max_hr,
    avgPower: activityRow.avg_power,
    normalizedPower: activityRow.normalized_power,
    avgSpeedMs: activityRow.avg_speed_ms,
    perceivedExertion: activityRow.perceived_exertion,
    deviceTss: readSummaryNumber(activityRow.summary_json, 'trainingStressScore'),
    deviceIf: readSummaryNumber(activityRow.summary_json, 'intensityFactor'),
    streams,
  };

  const { load, method, intensityFactor } = computeLoad(act, profile);
  const decoupling = computeDecoupling(act);
  const efficiency = computeEfficiencyFactor(act);
  const aerobic = computeAerobicShare(act, profile);
  const vo2 = activityVo2max(act, activityRow, profile);

  db.prepare(`UPDATE activities SET
      load = ?, load_method = ?, intensity_factor = ?,
      decoupling_pct = ?, efficiency_factor = ?, aerobic_pct = ?, vo2max_estimate = ?,
      updated_at = ?
    WHERE id = ?`).run(
    round2(load), method, round3(intensityFactor),
    round2(decoupling), round4(efficiency), round1(aerobic), round1(vo2),
    Date.now(), activityRow.id,
  );

  if (!opts.skipBestEfforts) {
    // The sport matters: it decides which distances this activity keeps records over.
    const efforts = computeBestEfforts({
      streams, sport: activityRow.sport, trainer: !!activityRow.trainer,
    });
    replaceBestEfforts(db, userId, activityRow.id, activityRow.sport, activityRow.start_time, efforts);
  }

  return { load, method };
}

/** Per-activity VO2max estimate, using whichever signal that sport provides. */
function activityVo2max(act, row, profile) {
  const family = familyOf(row.sport);

  if (family === 'run' && !row.trainer && row.distance_m > 1500 && row.moving_s > 0) {
    // Only treat genuinely hard efforts as fitness probes: an easy long run
    // would otherwise drag the estimate down.
    const isHardEffort = profile.lthr && row.avg_hr && row.avg_hr > profile.lthr * 0.92;
    if (isHardEffort) {
      const v = vdot(row.distance_m, row.moving_s);
      if (v !== null) return v;
    }
  }

  if (family === 'ride' && profile.ftp && profile.weightKg) {
    return vo2maxFromFtp(profile.ftp, profile.weightKg);
  }

  return null;
}

/**
 * Rebuild the whole `daily` table of fitness curves.
 * @returns {{days:number, from:string|null, to:string|null}}
 */
export function recomputeDaily(db, userId, { profile } = {}) {
  const resolved = profile || getProfile(db, userId).profile;

  const activities = db.prepare(`SELECT id, start_time, utc_offset_s, load, moving_s, elapsed_s,
      distance_m, elev_gain_m
    FROM activities WHERE user_id = ? ORDER BY start_time`).all(userId);

  if (!activities.length) {
    db.prepare('DELETE FROM daily WHERE user_id = ?').run(userId);
    return { days: 0, from: null, to: null };
  }

  // Bucket activities into local calendar days.
  const buckets = new Map();
  for (const a of activities) {
    const day = localDayOf(a.start_time, a.utc_offset_s);
    let b = buckets.get(day);
    if (!b) { b = { load: 0, duration_s: 0, distance_m: 0, elev_gain_m: 0, count: 0 }; buckets.set(day, b); }
    b.load += Number.isFinite(a.load) ? a.load : 0;
    b.duration_s += a.moving_s || a.elapsed_s || 0;
    b.distance_m += a.distance_m || 0;
    b.elev_gain_m += a.elev_gain_m || 0;
    b.count += 1;
  }

  const firstDay = localDayOf(activities[0].start_time, activities[0].utc_offset_s);
  // Run the timeline through today so form keeps decaying during a layoff — an
  // athlete who stopped training three weeks ago should see that.
  const today = new Date().toISOString().slice(0, 10);
  const lastActivityDay = localDayOf(
    activities[activities.length - 1].start_time,
    activities[activities.length - 1].utc_offset_s,
  );
  const lastDay = today > lastActivityDay ? today : lastActivityDay;

  const days = dayRange(firstDay, lastDay);
  const series = days.map((day) => ({ day, load: buckets.get(day)?.load ?? 0 }));
  const fitness = computeFitnessSeries(series);

  const insert = db.prepare(`INSERT INTO daily
      (user_id, day, load, duration_s, distance_m, elev_gain_m, activity_count,
       ctl, atl, tsb, monotony, strain, ramp_rate, vo2max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET
      load = excluded.load, duration_s = excluded.duration_s, distance_m = excluded.distance_m,
      elev_gain_m = excluded.elev_gain_m, activity_count = excluded.activity_count,
      ctl = excluded.ctl, atl = excluded.atl, tsb = excluded.tsb,
      monotony = excluded.monotony, strain = excluded.strain, ramp_rate = excluded.ramp_rate,
      vo2max = excluded.vo2max`);

  const runAll = db.transaction(() => {
    db.prepare('DELETE FROM daily WHERE user_id = ?').run(userId);

    for (let i = 0; i < fitness.length; i++) {
      const f = fitness[i];
      const bucket = buckets.get(f.day);
      // Best VO2max we can estimate from the activity data itself.
      const vo2 = bestVo2ForDay(db, userId, f.day)
        ?? vo2maxFromHeartRate(resolved.maxHr, resolved.restingHr);

      insert.run(
        userId, f.day,
        round2(f.load), bucket?.duration_s ?? 0, round1(bucket?.distance_m ?? 0),
        round1(bucket?.elev_gain_m ?? 0), bucket?.count ?? 0,
        round2(f.ctl), round2(f.atl), round2(f.tsb),
        round2(f.monotony), round1(f.strain), round2(f.rampRate),
        round1(vo2),
      );
    }
  });
  runAll();

  return { days: fitness.length, from: firstDay, to: lastDay };
}

/** Best VO2max estimate from activities in the trailing six weeks. */
function bestVo2ForDay(db, userId, day) {
  const end = new Date(`${day}T23:59:59Z`).getTime();
  const start = end - 42 * 86400000;
  const row = db.prepare(`SELECT MAX(vo2max_estimate) AS v FROM activities
    WHERE user_id = ? AND start_time BETWEEN ? AND ? AND vo2max_estimate IS NOT NULL`)
    .get(userId, start, end);
  return row?.v ?? null;
}

/**
 * Full recompute: every activity, then the daily rollup.
 * Called after a bulk import and by `reindex`.
 */
export function recomputeAll(db, userId, { onProgress } = {}) {
  // Best efforts must exist before the profile can infer FTP or threshold pace
  // from them, and load depends on the profile — so this runs in two passes.
  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY start_time').all(userId);

  let pass1 = getProfile(db, userId).profile;
  let done = 0;
  for (const row of rows) {
    recomputeActivity(db, userId, row, pass1);
    if (onProgress && ++done % 100 === 0) onProgress({ phase: 'activities', done, total: rows.length });
  }

  // Now that best efforts exist, the inferred FTP/threshold pace may have
  // changed — redo load with the better profile.
  const pass2 = getProfile(db, userId).profile;
  const profileChanged = pass2.ftp !== pass1.ftp
    || pass2.thresholdPaceMs !== pass1.thresholdPaceMs
    || pass2.lthr !== pass1.lthr;

  if (profileChanged) {
    done = 0;
    for (const row of rows) {
      recomputeActivity(db, userId, row, pass2, { skipBestEfforts: true });
      if (onProgress && ++done % 100 === 0) onProgress({ phase: 'reload', done, total: rows.length });
    }
  }

  const daily = recomputeDaily(db, userId, { profile: pass2 });
  return { activities: rows.length, daily, profile: pass2, profileChanged };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readSummaryNumber(summaryJson, key) {
  if (!summaryJson) return null;
  try {
    const v = JSON.parse(summaryJson)[key];
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const round4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
