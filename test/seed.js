#!/usr/bin/env node
// Seed a Fitberg instance with a realistic synthetic training history.
//
// Not test fixtures — this exists so you can see what the app looks like with real
// data in it before spending an afternoon exporting your own, and so the charts can
// be checked against a history whose shape is known in advance.
//
//   node test/seed.js [weeks]
//
// Generates a periodised block: three build weeks then a recovery week, with easy
// runs, interval sessions, long runs, rides and gym sessions.

import fs from 'node:fs';
import path from 'node:path';
import { makeFit } from './fixtures.js';
import { loopRoute, outAndBack } from './routes.js';

const WEEKS = Number(process.argv[2]) || 16;
const DATA_DIR = process.env.DATA_DIR || './data';

const { getDb } = await import('../server/db/index.js');
const { ingestBuffer } = await import('../server/ingest/index.js');
const { recomputeAll } = await import('../server/metrics/engine.js');
const { ensureDefaultUser } = await import('../server/lib/auth.js');

const db = await getDb();
const userId = ensureDefaultUser(db);

console.log(`Seeding ${WEEKS} weeks of synthetic history into ${path.resolve(DATA_DIR)}\n`);

// A deterministic pseudo-random generator, so a seeded database is reproducible
// and a chart that looked wrong can be looked at again.
let seed = 20260726;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const jitter = (spread) => (random() - 0.5) * 2 * spread;

const DAY_MS = 86400000;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const start = today.getTime() - WEEKS * 7 * DAY_MS;

/** A week's plan. Recovery every fourth week, which is what real training looks like. */
function planFor(weekIndex) {
  const isRecovery = weekIndex % 4 === 3;
  // Volume ramps ~8% per build week, then drops back on the recovery week.
  const block = Math.floor(weekIndex / 4);
  const base = 1 + block * 0.08;
  const scale = isRecovery ? base * 0.6 : base;

  // A week a real person might do: two quality sessions, a long one at the weekend, a
  // couple of easy ones, and something that is not running.
  return [
    { dow: 1, type: 'easy_run', scale },
    { dow: 2, type: isRecovery ? 'easy_run' : 'intervals', scale },
    { dow: 3, type: weekIndex % 2 ? 'ride' : 'swim', scale },
    { dow: 4, type: 'gym', scale },
    { dow: 5, type: isRecovery ? 'walk' : 'tempo_run', scale },
    { dow: 6, type: weekIndex % 3 === 2 ? 'long_ride' : 'long_run', scale },
    { dow: 0, type: isRecovery ? 'rest' : 'walk', scale },
  ];
}

const SESSIONS = {
  easy_run: (s) => ({ sport: 'running', minutes: 42 * s, speed: 2.85 + jitter(0.1), hrBase: 138, climbM: 40 }),
  tempo_run: (s) => ({ sport: 'running', minutes: 48 * s, speed: 3.5 + jitter(0.1), hrBase: 162, climbM: 35 }),
  intervals: (s) => ({ sport: 'running', minutes: 40 * s, speed: 3.35 + jitter(0.15), hrBase: 168, climbM: 20, surges: true }),
  long_run: (s) => ({ sport: 'running', minutes: 92 * s, speed: 2.95 + jitter(0.08), hrBase: 146, climbM: 90, shape: 'outAndBack' }),
  ride: (s) => ({ sport: 'cycling', minutes: 75 * s, speed: 7.6 + jitter(0.5), hrBase: 132, climbM: 220 }),
  long_ride: (s) => ({ sport: 'cycling', minutes: 165 * s, speed: 7.2 + jitter(0.4), hrBase: 128, climbM: 620, shape: 'outAndBack' }),
  swim: (s) => ({ sport: 'swimming', subSport: 'lapSwimming', minutes: 35 * s, speed: 0, hrBase: 130, indoor: true }),
  walk: (s) => ({ sport: 'walking', minutes: 55 * s, speed: 1.35 + jitter(0.1), hrBase: 96, climbM: 25 }),
  gym: (s) => ({ sport: 'training', subSport: 'strengthTraining', minutes: 45 * s, speed: 0, hrBase: 118, indoor: true }),
};

let created = 0;
const loadByDay = new Map();

for (let week = 0; week < WEEKS; week++) {
  for (const slot of planFor(week)) {
    if (slot.type === 'rest') continue;
    // Skip the odd session — nobody completes every planned week.
    if (random() < 0.08) continue;

    const spec = SESSIONS[slot.type](slot.scale);
    const dayOffset = week * 7 + slot.dow;
    const when = start + dayOffset * DAY_MS + (6 + Math.floor(random() * 4)) * 3600000;
    if (when > Date.now()) continue;

    const samples = buildSamples(spec, when);
    if (!samples.length) continue;

    const buffer = makeFit(samples, {
      sport: spec.sport,
      // FIT enum values are camelCase in the SDK's string form.
      subSport: spec.subSport || 'generic',
      // Each session gets its own averages, so the history looks like a real one
      // rather than 96 activities all reporting an identical heart rate.
      deriveSummary: true,
    });

    const report = await ingestBuffer(db, userId, buffer, {
      filename: `seed-${dayOffset}-${slot.type}.fit`,
      recomputeMetrics: false,
    });
    created += report.imported;

    const day = new Date(when).toISOString().slice(0, 10);
    loadByDay.set(day, (loadByDay.get(day) || 0) + spec.minutes * slot.scale);
  }

  process.stdout.write(`\r  week ${week + 1}/${WEEKS} — ${created} activities`);
}
process.stdout.write('\n');

/** Build 1 Hz samples for a session: a real route, real structure, plausible drift. */
function buildSamples(spec, whenMs) {
  const n = Math.max(60, Math.round(spec.minutes * 60));

  // Indoor work has heart rate and nothing else. A pool swim also has distance, which is
  // how the swim records get something to show.
  if (spec.indoor) {
    const poolSpeed = spec.sport === 'swimming' ? 0.95 : 0;
    return Array.from({ length: n }, (_, i) => ({
      t: i,
      timestamp: new Date(whenMs + i * 1000),
      lat: null,
      lng: null,
      alt: null,
      hr: Math.round(spec.hrBase + 18 * Math.sin(i / 90) + jitter(4)),
      cad: null,
      power: null,
      speed: poolSpeed,
      dist: poolSpeed * i,
      temp: 25,
    }));
  }

  // A speed profile, so pace varies within the session the way it really does: a slower
  // first few minutes, the session's own structure, and a fade or a push at the end.
  // Without this every split from 400 m to a half marathon comes out at an identical
  // pace and the records table is obviously synthetic.
  const speeds = [];
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    const warmUp = Math.min(1, 0.82 + phase * 6);          // easing into it
    const structure = spec.surges
      ? (Math.sin(i / 120) > 0.55 ? 1.24 : 0.88)           // intervals: hard, then float
      : 1 + 0.05 * Math.sin(i / 900);                      // steady, with gentle variation
    const finish = spec.shape === 'outAndBack' && phase > 0.85 ? 0.95 : 1;
    speeds.push(spec.speed * Math.min(warmUp, 1) * structure * finish);
  }

  const cumulative = [0];
  for (let i = 1; i < n; i++) cumulative.push(cumulative[i - 1] + speeds[i]);

  const seedForRoute = Math.floor(whenMs / 1000) & 0x7fffffff;
  const shape = spec.shape === 'outAndBack' ? outAndBack : loopRoute;
  const route = shape({
    n,
    speed: spec.speed,
    distances: cumulative,
    seed: seedForRoute,
    climbM: spec.climbM ?? 50,
    // Somewhere with hills, so the elevation profile and the 3D view have something to
    // show. Spread around a little so every route is not the same loop.
    startLat: 45.90 + jitter(0.05),
    startLng: 6.13 + jitter(0.07),
  });

  return route.map((point, i) => {
    const phase = i / n;
    // Intervals: five hard efforts with recoveries, which is what makes the power curve
    // and the fastest-splits table interesting rather than flat.
    const surge = spec.surges && Math.sin(i / 120) > 0.55 ? 1 : 0;
    const speed = speeds[i];
    const hr = spec.hrBase
      + phase * 9                    // cardiac drift at constant effort
      + surge * 16
      + 6 * Math.sin(i / 120)
      + jitter(3);

    return {
      t: i,
      timestamp: new Date(whenMs + i * 1000),
      lat: point.lat,
      lng: point.lng,
      alt: point.alt,
      hr: Math.round(hr),
      cad: spec.sport === 'cycling' ? Math.round(84 + surge * 8 + jitter(4)) : Math.round(84 + jitter(3)),
      power: spec.sport === 'cycling'
        ? Math.round((200 * spec.speed) / 7.6 + surge * 90 + 30 * Math.sin(i / 100) + jitter(12))
        : null,
      speed,
      dist: point.dist,
      temp: Math.round(14 + jitter(4)),
    };
  });
}


// Give the seeded athlete plausible thresholds so load uses power and pace rather
// than falling back to duration estimates.
const settings = { profile: { birthYear: 1988, sex: 'm', weightKg: 74, maxHr: 188, restingHr: 48, ftp: 245 } };
db.prepare('UPDATE users SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), userId);

console.log('\nComputing metrics…');
const result = recomputeAll(db, userId, {
  onProgress: (p) => process.stdout.write(`\r  ${p.phase}: ${p.done}/${p.total}`),
});
process.stdout.write('\r'.padEnd(50) + '\r');

const latest = db.prepare('SELECT * FROM daily WHERE user_id = ? ORDER BY day DESC LIMIT 1').get(userId);
const totals = db.prepare('SELECT COUNT(*) c, SUM(distance_m) d, SUM(moving_s) s FROM activities WHERE user_id = ?').get(userId);

console.log(`Done.

  activities   ${totals.c}
  distance     ${(totals.d / 1000).toFixed(0)} km
  time         ${(totals.s / 3600).toFixed(0)} h
  days         ${result.daily.days} (${result.daily.from} .. ${result.daily.to})

  fitness      ${latest?.ctl?.toFixed(1)}
  fatigue      ${latest?.atl?.toFixed(1)}
  form         ${latest?.tsb?.toFixed(1)}
  VO2max       ${latest?.vo2max?.toFixed(1) ?? '—'}
`);

if (!fs.existsSync(path.join(DATA_DIR, 'originals'))) {
  console.warn('Warning: no originals directory — something went wrong.');
}
