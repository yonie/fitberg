// Every page, end to end.
//
// One seeded database, one real Fastify server, and one test per page asserting the
// requests that page actually makes come back with usable data. Not a snapshot of
// markup — the thing that breaks in practice is a route returning null, an empty list,
// or a field the page reads under a different name, and that is what this catches.
//
// Deliberately no browser: this has to run in `npm test` on a Pi. The rendering itself
// is checked by screenshotting the demo instance, which is a separate job.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitberg-pages-'));
process.env.DATA_DIR = DATA_DIR;
process.env.OLLAMA_ENABLED = '0';
process.env.FITBERG_OPEN_ACCESS = '1';
process.env.SESSION_SECRET = 'test-secret-not-used-anywhere-real';

const { makeFit } = await import('./fixtures.js');
const { loopRoute } = await import('./routes.js');
const { getDb } = await import('../server/db/index.js');
const { ingestBuffer } = await import('../server/ingest/index.js');
const { recomputeAll } = await import('../server/metrics/engine.js');
const { ensureDefaultUser } = await import('../server/lib/auth.js');
const { buildServer } = await import('../server/index.js');

const db = await getDb();
const USER = ensureDefaultUser(db);

// ─── a small but complete history ─────────────────────────────────────────────
//
// Enough shape for every page to have something to show: runs and rides so there are
// two sport families, power on the bike so the power curve exists, an indoor session
// with no GPS, and several weeks so the fitness curve has a slope.

const DAY = 86400000;
// Anchored to today, not to a fixed date: fatigue is a 7-day average and the fitness
// series covers a recent window, so a history from six months ago correctly produces
// zeroes and would make these assertions test nothing.
const TODAY = Math.floor(Date.now() / DAY) * DAY;
const START = TODAY - 18 * DAY + 7 * 3600000;

function session({ dayOffset, sport, minutes, speed, hrBase, power = null, indoor = false }) {
  const n = minutes * 60;
  const whenMs = START + dayOffset * DAY;

  if (indoor) {
    return makeFit(Array.from({ length: n }, (_, i) => ({
      t: i,
      timestamp: new Date(whenMs + i * 1000),
      lat: null, lng: null, alt: null,
      hr: Math.round(hrBase + 12 * Math.sin(i / 60)),
      cad: null, power: null, speed: 0, dist: 0, temp: 21,
    })), { sport, subSport: 'strengthTraining', deriveSummary: true });
  }

  const route = loopRoute({ n, speed, seed: dayOffset + 1, climbM: 70 });
  return makeFit(route.map((point, i) => ({
    t: i,
    timestamp: new Date(whenMs + i * 1000),
    lat: point.lat,
    lng: point.lng,
    alt: point.alt,
    hr: Math.round(hrBase + (i / n) * 8 + 5 * Math.sin(i / 100)),
    cad: 86,
    power,
    speed,
    dist: point.dist,
    temp: 15,
  })), { sport, deriveSummary: true });
}

const PLAN = [
  { dayOffset: 0, sport: 'running', minutes: 45, speed: 2.9, hrBase: 140 },
  { dayOffset: 2, sport: 'cycling', minutes: 80, speed: 7.5, hrBase: 132, power: 210 },
  { dayOffset: 4, sport: 'running', minutes: 30, speed: 3.4, hrBase: 165 },
  { dayOffset: 6, sport: 'running', minutes: 95, speed: 2.95, hrBase: 145 },
  { dayOffset: 8, sport: 'training', minutes: 40, speed: 0, hrBase: 115, indoor: true },
  { dayOffset: 10, sport: 'cycling', minutes: 150, speed: 7.2, hrBase: 128, power: 195 },
  { dayOffset: 13, sport: 'running', minutes: 50, speed: 3.0, hrBase: 142 },
  { dayOffset: 16, sport: 'cycling', minutes: 70, speed: 7.8, hrBase: 135, power: 225 },
];

for (const spec of PLAN) {
  await ingestBuffer(db, USER, session(spec), {
    filename: `plan-${spec.dayOffset}-${spec.sport}.fit`,
    recomputeMetrics: false,
  });
}
recomputeAll(db, USER);

const { app } = await buildServer();
await app.ready();

/** GET a route through the real server and assert it succeeded. */
async function get(url) {
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode} ${res.body.slice(0, 200)}`);
  return res.json();
}

// ─── the shell ────────────────────────────────────────────────────────────────

test('config: the shell gets what it needs to boot', async () => {
  const config = await get('/api/config');
  assert.ok(config.version, 'a version is reported');
  assert.equal(typeof config.openAccess, 'boolean');
  assert.ok(config.map?.terrainTileUrl, 'the flyover has a terrain source');
  assert.ok(config.ai, 'the AI panel has a status to read');
});

test('health: answers without a session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

test('Dashboard: totals, fitness and recent activities all populated', async () => {
  const dash = await get('/api/stats/dashboard');

  assert.equal(dash.totals.activities, PLAN.length);
  assert.ok(dash.totals.distanceM > 100000, `expected >100 km, got ${dash.totals.distanceM}`);
  assert.ok(dash.totals.seconds > 0, 'total moving time');

  // The headline numbers on the page.
  assert.ok(dash.fitness.ctl > 0, 'fitness has accumulated');
  assert.ok(dash.fitness.atl > 0, 'fatigue has accumulated');
  assert.equal(typeof dash.fitness.tsb, 'number');

  assert.ok(Array.isArray(dash.recent) && dash.recent.length > 0, 'the recent list is not empty');
  const [first] = dash.recent;
  // The fields the row renders. A missing avgSpeedMs is how the pace column broke before.
  for (const field of ['id', 'sport', 'startTime', 'distanceM', 'movingS', 'load']) {
    assert.ok(field in first, `recent activity is missing ${field}`);
  }
  // The rolling windows the tiles show.
  for (const window of ['last7', 'prev7', 'last30', 'last365']) {
    assert.ok(dash[window], `dashboard is missing ${window}`);
  }
  assert.ok(dash.profile, 'the inferred profile is included');
});

// ─── Activities ───────────────────────────────────────────────────────────────

test('Activities: the list pages, filters and sorts', async () => {
  const all = await get('/api/activities?limit=5');
  assert.equal(all.total, PLAN.length);
  assert.equal(all.activities.length, 5, 'the page size is honoured');

  const runs = await get('/api/activities?sport=run');
  assert.ok(runs.total > 0 && runs.total < PLAN.length, 'filtering narrows the list');
  assert.ok(runs.activities.every((a) => a.sport === 'run'));

  const sports = await get('/api/activities/sports');
  assert.ok(sports.sports.length >= 2, 'the sport filter has options');
  assert.ok(sports.sports.every((s) => s.label && s.count > 0));
});

// ─── Activity detail ──────────────────────────────────────────────────────────

test('Activity detail: summary, streams, laps and the original file', async () => {
  const { activities } = await get('/api/activities?sport=ride&limit=1');
  const id = activities[0].id;

  const detail = await get(`/api/activities/${id}`);
  assert.ok(detail.distanceM > 0);
  assert.ok(detail.avgHr > 0, 'heart rate came through');
  assert.ok(detail.avgPower > 0, 'power came through on the bike');
  assert.ok(Array.isArray(detail.laps));
  assert.ok(detail.streamChannels.length > 0, 'the charts have channels to draw');
  assert.ok(detail.original?.downloadUrl, 'the original file is downloadable');
  // The trim editor reads these.
  assert.ok('cropStartS' in detail && 'cropEndS' in detail);

  const streams = await get(`/api/activities/${id}/streams?resolution=500`);
  assert.ok(streams.n > 0);
  for (const channel of ['t', 'lat', 'lng', 'alt', 'hr', 'dist']) {
    assert.ok(Array.isArray(streams.channels[channel]), `stream ${channel} is missing`);
  }
  // The flyover needs coordinates it can actually draw.
  const finite = streams.channels.lat.filter(Number.isFinite);
  assert.ok(finite.length > 10, 'the route has usable coordinates');

  const original = await app.inject({ method: 'GET', url: `/api/activities/${id}/original` });
  assert.equal(original.statusCode, 200);
  assert.equal(original.rawPayload.subarray(8, 12).toString('latin1'), '.FIT');
});

// ─── Fitness ──────────────────────────────────────────────────────────────────

test('Fitness: the curve, the calendar and the totals', async () => {
  const fitness = await get('/api/stats/fitness');
  assert.ok(fitness.days.length > 10, 'the series spans the history');
  const withLoad = fitness.days.filter((d) => d.load > 0);
  assert.equal(withLoad.length, PLAN.length, 'every session shows up as a day with load');
  for (const field of ['day', 'load', 'ctl', 'atl', 'tsb']) {
    assert.ok(field in fitness.days[0], `the series is missing ${field}`);
  }
  // Fitness must actually rise over a training block, not sit flat.
  const first = fitness.days[0].ctl;
  const last = fitness.days[fitness.days.length - 1].ctl;
  assert.ok(last > first, `fitness should build: ${first} -> ${last}`);

  const calendar = await get('/api/stats/calendar');
  assert.ok(Array.isArray(calendar.days) && calendar.days.length > 0);

  const totals = await get('/api/stats/totals?by=week');
  assert.ok(totals.periods.length > 0, 'the period bars have data');
});

// ─── Records ──────────────────────────────────────────────────────────────────

test('Records: per-sport distances, the power curve and the zones', async () => {
  const records = await get('/api/stats/records');

  // Grouped by family, because a 5 km on a bike and on foot are different records.
  assert.ok(records.fastestByFamily.run?.length > 0, 'running has records');
  assert.ok(records.fastestByFamily.ride?.length > 0, 'cycling has records');

  // No marathon on a bike, and nothing under a kilometre.
  const rideBuckets = records.fastestByFamily.ride.map((e) => e.bucket);
  assert.ok(!rideBuckets.includes(42195), 'cycling must not have a marathon record');
  assert.ok(Math.min(...rideBuckets) >= 1000, 'cycling records start at 1 km');

  // Running keeps race distances.
  const runBuckets = records.fastestByFamily.run.map((e) => e.bucket);
  assert.ok(runBuckets.includes(1000) && runBuckets.includes(5000));

  // The filter is on by default and nothing survives it that could not have happened.
  for (const [family, efforts] of Object.entries(records.fastestByFamily)) {
    for (const effort of efforts) {
      const speed = effort.bucket / effort.value;
      assert.ok(speed < 30, `${family} ${effort.bucket}m at ${speed.toFixed(1)} m/s is impossible`);
    }
  }
  assert.equal(records.hidingImpossible, true);

  assert.ok(records.powerCurve.length > 2, 'the power curve has points');
  assert.ok(records.powerCurve.every((p) => p.bucket > 0 && p.value > 0));

  const zones = await get('/api/stats/zones');
  assert.ok(zones.hr?.length > 0 || zones.power?.length > 0, 'at least one set of zones');
});

test('Records: the impossible-times toggle changes the answer', async () => {
  const hidden = await get('/api/stats/records?sport=run');
  const shown = await get('/api/stats/records?sport=run&impossible=1');
  assert.equal(shown.hidingImpossible, false);
  // Nothing in this seeded history is impossible, so both agree — what is asserted is
  // that the flag reaches the query rather than being ignored.
  assert.ok(shown.fastestDistances.length >= hidden.fastestDistances.length);
});

test('Records: a race measured just short counts, unless strict', async () => {
  // Make one run read as a GPS-short 10 km: 9.95 km, well inside the 1% allowance.
  const run = db.prepare("SELECT id, distance_m, elapsed_s FROM activities WHERE sport = 'run' LIMIT 1").get();
  db.prepare('UPDATE activities SET distance_m = 9950, elapsed_s = 2700 WHERE id = ?').run(run.id);
  try {
    const lenient = await get('/api/stats/records?sport=run');
    const strict = await get('/api/stats/records?sport=run&strict=1');
    assert.equal(lenient.allowingShort, true);
    assert.equal(strict.allowingShort, false);

    const tenK = lenient.fastestDistances.find((e) => e.bucket === 10000);
    assert.equal(tenK?.activityId, run.id);
    assert.equal(tenK.value, 2700);
    assert.equal(tenK.measuredM, 9950);
    assert.ok(!strict.fastestDistances.some((e) => e.measuredM), 'strict counts measured distance only');
  } finally {
    db.prepare('UPDATE activities SET distance_m = ?, elapsed_s = ? WHERE id = ?')
      .run(run.distance_m, run.elapsed_s, run.id);
  }
});

// ─── Import ───────────────────────────────────────────────────────────────────

test('Import: the history of what came in', async () => {
  const imports = await get('/api/imports');
  assert.ok(Array.isArray(imports.imports));
});

// ─── Export ───────────────────────────────────────────────────────────────────

test('Export: the page preview, and a ZIP of FIT files and nothing else', async () => {
  const preview = await get('/api/export/preview');
  assert.equal(preview.activities, PLAN.length);
  assert.equal(preview.originalFiles, PLAN.length);
  assert.ok(preview.originalBytes > 0);

  const zip = await app.inject({ method: 'GET', url: '/api/export' });
  assert.equal(zip.statusCode, 200);
  assert.match(zip.headers['content-disposition'], /\.zip"?$/);

  // Every entry is a FIT file. The central directory lists names after each 0x02014b50
  // header; simply asserting no other extension appears is enough and needs no unzip.
  const body = zip.rawPayload.toString('latin1');
  assert.ok(body.includes('.fit'), 'the archive contains FIT files');
  for (const ext of ['.csv', '.json', '.txt', 'README']) {
    assert.ok(!body.includes(ext), `the archive must not contain ${ext}`);
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

test('Settings: what it reads, and nothing it cannot set', async () => {
  const profile = await get('/api/profile');
  // Inferred from the files, never asked for.
  assert.ok(profile.profile.maxHr > 0, 'max heart rate was worked out');
  assert.ok(profile.estimated.maxHr, 'and it says how');
  assert.equal(profile.profile.restingHr, null, 'resting heart rate is never invented');

  const ai = await get('/api/ai/settings');
  assert.ok(ai.url, 'the AI host is shown');
  assert.ok(ai.model, 'the AI model is shown');

  const system = await get('/api/system');
  assert.ok(system.node && system.driver);

  // Removed features must stay removed.
  for (const gone of ['/api/inbox', '/api/keys', '/api/connect', '/api/onboarding',
    '/api/stats/gear', '/api/ai/insights', '/api/profile/defaults']) {
    const res = await app.inject({ method: 'GET', url: gone });
    assert.equal(res.statusCode, 404, `${gone} should not exist`);
  }
});

// ─── Coach ────────────────────────────────────────────────────────────────────

test('Coach: degrades to a clear message when no AI host is configured', async () => {
  const status = await get('/api/ai/status');
  assert.equal(status.available, false);
  assert.ok(status.reason, 'and says why');

  // Asking anyway must be a clean refusal, not a crash.
  const asked = await app.inject({
    method: 'POST', url: '/api/ai/ask', payload: { question: 'How far did I run?' },
  });
  assert.equal(asked.statusCode, 503);
  assert.ok(asked.json().error);
});

test.after(async () => {
  await app.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
