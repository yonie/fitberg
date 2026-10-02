import { getProfile } from '../metrics/engine.js';
import { hrZones, powerZones, paceZones } from '../metrics/profile.js';
import { interpretForm, dayRange } from '../metrics/fitness.js';
import { readStreams } from '../db/repo.js';
import {
  PEAK_DURATIONS, splitDistancesFor, MAX_SPEED_MS, RACE_DISTANCES, RACE_SHORTFALL,
} from '../metrics/efforts.js';
import { familyOf } from '../parsers/sports.js';
import { shapeActivity, ACTIVITY_SELECT } from './shape.js';

export function registerStatsRoutes(app, { db }) {
  /** Everything the dashboard needs, in one request. */
  app.get('/api/stats/dashboard', async (request) => {
    const userId = request.userId;
    const { profile, estimated } = getProfile(db, userId);

    const latest = db.prepare(
      'SELECT * FROM daily WHERE user_id = ? ORDER BY day DESC LIMIT 1',
    ).get(userId);

    const today = new Date().toISOString().slice(0, 10);

    const totals = db.prepare(`SELECT COUNT(*) AS activities, SUM(distance_m) AS distance,
        SUM(moving_s) AS seconds, SUM(elev_gain_m) AS elevation, MIN(start_time) AS first,
        MAX(start_time) AS last
      FROM activities WHERE user_id = ?`).get(userId);

    const period = (days) => db.prepare(`SELECT COUNT(*) AS activities, SUM(distance_m) AS distance,
        SUM(moving_s) AS seconds, SUM(load) AS load, SUM(elev_gain_m) AS elevation
      FROM activities WHERE user_id = ? AND start_time >= ?`)
      .get(userId, Date.now() - days * 86400000);

    // The 7 days *before* the last 7, so the dashboard can show a real
    // week-over-week change rather than comparing against a monthly average.
    const window = (fromDays, toDays) => db.prepare(`SELECT COUNT(*) AS activities,
        SUM(distance_m) AS distance, SUM(moving_s) AS seconds, SUM(load) AS load,
        SUM(elev_gain_m) AS elevation
      FROM activities WHERE user_id = ? AND start_time >= ? AND start_time < ?`)
      .get(userId, Date.now() - fromDays * 86400000, Date.now() - toDays * 86400000);

    const recent = db.prepare(
      `SELECT ${ACTIVITY_SELECT} FROM activities WHERE user_id = ? ORDER BY start_time DESC LIMIT 8`,
    ).all(userId);

    return {
      profile,
      profileEstimated: estimated,
      fitness: latest ? {
        day: latest.day,
        ctl: latest.ctl,
        atl: latest.atl,
        tsb: latest.tsb,
        rampRate: latest.ramp_rate,
        monotony: latest.monotony,
        strain: latest.strain,
        vo2max: latest.vo2max,
        form: interpretForm(latest.tsb),
      } : null,
      totals: {
        activities: totals.activities || 0,
        distanceM: totals.distance || 0,
        seconds: totals.seconds || 0,
        elevationM: totals.elevation || 0,
        firstActivity: totals.first,
        lastActivity: totals.last,
      },
      last7: period(7),
      prev7: window(14, 7),
      last30: period(30),
      last365: period(365),
      recent: recent.map(shapeActivity),
    };
  });

  /** The fitness/fatigue/form curve. */
  app.get('/api/stats/fitness', async (request) => {
    const days = clampInt(request.query?.days, 7, 3650, 180);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const rows = db.prepare(
      `SELECT day, load, ctl, atl, tsb, ramp_rate, activity_count, duration_s,
         distance_m, monotony, vo2max
       FROM daily WHERE user_id = ? AND day >= ? ORDER BY day`,
    ).all(request.userId, from);

    return {
      from,
      days: rows.map((r) => ({
        day: r.day,
        load: r.load,
        ctl: r.ctl,
        atl: r.atl,
        tsb: r.tsb,
        rampRate: r.ramp_rate,
        activities: r.activity_count,
        durationS: r.duration_s,
        distanceM: r.distance_m,
        monotony: r.monotony,
        vo2max: r.vo2max,
      })),
    };
  });

  /** Training zones, and where the athlete's time actually goes. */
  app.get('/api/stats/zones', async (request) => {
    const { profile, estimated } = getProfile(db, request.userId);
    const days = clampInt(request.query?.days, 7, 3650, 90);
    const since = Date.now() - days * 86400000;

    const zones = hrZones(profile);
    const distribution = zones ? new Array(zones.length).fill(0) : null;

    if (zones) {
      // Time in zone needs the raw samples; there is no way to derive it from
      // an average. Bounded to keep this responsive on a Pi.
      const activities = db.prepare(
        `SELECT id FROM activities WHERE user_id = ? AND start_time >= ? AND avg_hr IS NOT NULL
         ORDER BY start_time DESC LIMIT 400`,
      ).all(request.userId, since);

      for (const { id } of activities) {
        const streams = readStreams(db, id, ['hr', 't']);
        const hr = streams.hr;
        if (!hr) continue;
        const t = streams.t;
        for (let i = 0; i < hr.length; i++) {
          const value = hr[i];
          if (!Number.isFinite(value) || value <= 0) continue;
          let dt = 1;
          if (t && i > 0 && Number.isFinite(t[i]) && Number.isFinite(t[i - 1])) {
            const delta = t[i] - t[i - 1];
            dt = delta > 0 && delta <= 30 ? delta : 1;
          }
          const index = zones.findIndex((z) => value >= z.min && value < z.max);
          distribution[index === -1 ? zones.length - 1 : index] += dt;
        }
      }
    }

    return {
      profile,
      estimated,
      hr: zones ? zones.map((z, i) => ({ ...z, seconds: Math.round(distribution[i]) })) : null,
      power: powerZones(profile),
      pace: paceZones(profile),
      windowDays: days,
    };
  });

  /**
   * Personal records: the power curve and fastest distances, plus which activity
   * each came from.
   */
  app.get('/api/stats/records', async (request) => {
    const sport = request.query?.sport || null;
    const family = sport ? familyOf(sport) : null;
    // On by default; `?impossible=1` shows the lot.
    const hideImpossible = request.query?.impossible !== '1';
    // Also on by default; `?strict=1` counts measured distance only.
    const allowShort = request.query?.strict !== '1';

    const sportClause = sport ? 'AND be.sport = ?' : '';
    const sportParams = sport ? [sport] : [];

    const best = (kind, buckets) => {
      const rows = db.prepare(
        `SELECT be.bucket, be.value, be.activity_id, be.start_time, a.name, a.sport
         FROM best_efforts be JOIN activities a ON a.id = be.activity_id
         WHERE be.user_id = ? AND be.kind = ? ${sportClause}
         ORDER BY be.bucket, ${kind === 'fastest_distance' ? 'be.value ASC' : 'be.value DESC'}`,
      ).all(request.userId, kind, ...sportParams);

      // First row per bucket is the record, given the ordering above.
      const seen = new Map();
      for (const row of rows) {
        if (!seen.has(row.bucket)) seen.set(row.bucket, row);
      }
      return buckets
        .filter((b) => seen.has(b))
        .map((b) => {
          const row = seen.get(b);
          return {
            bucket: b,
            value: row.value,
            activityId: row.activity_id,
            activityName: row.name,
            sport: row.sport,
            startTime: row.start_time,
          };
        });
    };

    /**
     * Fastest distances, grouped by sport family when unfiltered.
     *
     * A single global "best 5 km" is worse than useless in a mixed history: a bike
     * split beats every run, so the running records simply never appear. Grouping by
     * family means a runner who also rides still sees their actual running PRs.
     */
    const fastestByFamily = () => {
      const rows = db.prepare(
        `SELECT be.bucket, be.value, be.activity_id, be.start_time, be.sport, a.name
         FROM best_efforts be JOIN activities a ON a.id = be.activity_id
         WHERE be.user_id = ? AND be.kind = 'fastest_distance' ${sportClause}
         ORDER BY be.value ASC`,
      ).all(request.userId, ...sportParams);

      // A whole activity that measured just short of a race distance counts as that
      // race, at its elapsed time. Only short: one that measured long already holds
      // a real split over the distance.
      if (allowShort) {
        const activities = db.prepare(
          `SELECT id, name, sport, start_time, distance_m, elapsed_s FROM activities
           WHERE user_id = ? AND distance_m > 0 AND elapsed_s > 0 ${sport ? 'AND sport = ?' : ''}`,
        ).all(request.userId, ...sportParams);
        for (const a of activities) {
          for (const bucket of RACE_DISTANCES[familyOf(a.sport)] ?? []) {
            if (a.distance_m < bucket && a.distance_m >= bucket * (1 - RACE_SHORTFALL)) {
              rows.push({
                bucket, value: a.elapsed_s, activity_id: a.id, start_time: a.start_time,
                sport: a.sport, name: a.name, measured_m: a.distance_m,
              });
            }
          }
        }
        rows.sort((x, y) => x.value - y.value);
      }

      // Rows arrive fastest-first, so the first hit per (family, bucket) is the record —
      // but the filter has to be applied while choosing, not afterwards. Filtering the
      // chosen row would leave a distance empty whenever its fastest split is the bogus
      // one; skipping bogus rows during selection promotes the fastest real effort
      // instead.
      const byFamily = new Map();
      for (const row of rows) {
        const fam = familyOf(row.sport);
        if (hideImpossible) {
          const ceiling = MAX_SPEED_MS[fam];
          if (ceiling && row.bucket / row.value > ceiling) continue;
        }
        if (!byFamily.has(fam)) byFamily.set(fam, new Map());
        const buckets = byFamily.get(fam);
        if (!buckets.has(row.bucket)) {
          buckets.set(row.bucket, {
            bucket: row.bucket,
            value: row.value,
            activityId: row.activity_id,
            activityName: row.name,
            sport: row.sport,
            startTime: row.start_time,
            ...(row.measured_m ? { measuredM: row.measured_m } : {}),
          });
        }
      }

      const out = {};
      for (const [fam, buckets] of byFamily) {
        // Ordered by that family's own distance list, so a table reads shortest to
        // longest in the units the sport actually uses.
        const order = splitDistancesFor(fam) ?? [];
        out[fam] = order.filter((b) => buckets.has(b)).map((b) => buckets.get(b));
      }
      return out;
    };

    const grouped = fastestByFamily();
    // Flat list for a sport-filtered request, where there is only one family anyway.
    const flat = Object.values(grouped).flat().sort((a, b) => a.bucket - b.bucket);

    return {
      sport,
      family,
      hidingImpossible: hideImpossible,
      allowingShort: allowShort,
      powerCurve: best('peak_power', PEAK_DURATIONS),
      hrCurve: best('peak_hr', PEAK_DURATIONS),
      fastestDistances: flat,
      fastestByFamily: grouped,
    };
  });

  /** Calendar heat map: one cell per day. */
  app.get('/api/stats/calendar', async (request) => {
    const days = clampInt(request.query?.days, 30, 1100, 365);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);

    const rows = db.prepare(
      `SELECT day, load, duration_s, distance_m, activity_count
       FROM daily WHERE user_id = ? AND day >= ? ORDER BY day`,
    ).all(request.userId, from);

    const byDay = new Map(rows.map((r) => [r.day, r]));
    // Emit every calendar day, including empty ones, so the client does not have
    // to reconstruct the grid.
    return {
      from,
      to,
      days: dayRange(from, to).map((day) => {
        const row = byDay.get(day);
        return {
          day,
          load: row?.load ?? 0,
          durationS: row?.duration_s ?? 0,
          distanceM: row?.distance_m ?? 0,
          activities: row?.activity_count ?? 0,
        };
      }),
    };
  });

  /** Totals grouped by week, month or year, optionally per sport. */
  app.get('/api/stats/totals', async (request) => {
    const groupBy = ['week', 'month', 'year'].includes(request.query?.by) ? request.query.by : 'month';
    const bucket = { week: '%Y-W%W', month: '%Y-%m', year: '%Y' }[groupBy];

    const rows = db.prepare(
      `SELECT strftime('${bucket}', start_time / 1000, 'unixepoch') AS period,
              sport,
              COUNT(*) AS activities,
              SUM(distance_m) AS distance_m,
              SUM(moving_s) AS seconds,
              SUM(elev_gain_m) AS elevation_m,
              SUM(load) AS load
       FROM activities WHERE user_id = ?
       GROUP BY period, sport ORDER BY period`,
    ).all(request.userId);

    // Pivot into one entry per period with a per-sport breakdown.
    const periods = new Map();
    for (const row of rows) {
      let entry = periods.get(row.period);
      if (!entry) {
        entry = {
          period: row.period, activities: 0, distanceM: 0, seconds: 0, elevationM: 0, load: 0,
          bySport: {},
        };
        periods.set(row.period, entry);
      }
      entry.activities += row.activities;
      entry.distanceM += row.distance_m || 0;
      entry.seconds += row.seconds || 0;
      entry.elevationM += row.elevation_m || 0;
      entry.load += row.load || 0;
      entry.bySport[row.sport] = {
        activities: row.activities,
        distanceM: row.distance_m || 0,
        seconds: row.seconds || 0,
        load: row.load || 0,
      };
    }

    return { by: groupBy, periods: [...periods.values()] };
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
