// End-to-end ingest tests.
//
// The important one is "reindex reproduces the database exactly": that is the claim
// the whole architecture rests on, and if it ever breaks, the promise that your files
// are safe becomes untrue.
//
// Uses only dynamic imports so DATA_DIR can be pointed at a scratch directory before
// server/lib/config.js is first evaluated and caches it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitberg-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.INBOX_POLL_SECONDS = '0';
process.env.OLLAMA_ENABLED = '0';

const { syntheticRun, makeFit, makeTcx, BASE_TIME } = await import('./fixtures.js');
const { makeZip, gzip } = await import('./zipwriter.js');

const { getDb, truncateDerived } = await import('../server/db/index.js');
const { ingestBuffer, ingestPath } = await import('../server/ingest/index.js');
const { reindex } = await import('../server/ingest/reindex.js');
const { recomputeAll } = await import('../server/metrics/engine.js');

const db = await getDb();
const USER = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)')
  .run('test@fitberg.local', Date.now()).lastInsertRowid;

const samples = syntheticRun({ n: 600, speed: 3.0 });

function reset() {
  truncateDerived(db);
  db.prepare('DELETE FROM originals').run();
  // The originals store must be cleared too, not just the ledger. `reindex` replays
  // whatever is on disk, so leftover files from an earlier test would be resurrected
  // into the next one's expectations.
  const originals = path.join(DATA_DIR, 'originals');
  fs.rmSync(originals, { recursive: true, force: true });
  fs.mkdirSync(originals, { recursive: true });
}

/** A ZIP shaped like a real Strava bulk export: gzipped FIT plus assorted noise. */
function stravaExportZip() {
  return makeZip([
    { name: 'activities/1111111111.fit.gz', data: gzip(makeFit(samples)) },
    // A different day, so the two are genuinely distinct sessions.
    { name: 'activities/2222222222.fit',
      data: makeFit(syntheticRun({ n: 300, speed: 2.6, startMs: BASE_TIME + 86400000 })) },
    // Things a real export contains that are not activities.
    { name: 'activities.csv', data: Buffer.from('a,b,c\n1,2,3\n') },
    { name: 'activities/3333333333.gpx', data: Buffer.from('<?xml version="1.0"?><gpx><trk/></gpx>') },
    // Scaffolding: never activities, so counted but not itemised.
    { name: 'profile.json', data: Buffer.from('{"username":"someone","weight":72}') },
    { name: 'followers.csv', data: Buffer.from('athlete\nsomeone-else\n') },
  ]);
}

test('ingest: a whole unopened Strava export ZIP', async () => {
  reset();
  const zipPath = path.join(DATA_DIR, 'strava_export.zip');
  fs.writeFileSync(zipPath, stravaExportZip());

  const report = await ingestPath(db, USER, zipPath, { filename: 'strava_export.zip' });

  // Both FIT files, whether gzipped or not.
  assert.equal(report.imported, 2, `imported ${report.imported}: ${JSON.stringify(report.log, null, 1)}`);
  assert.equal(report.failed, 0);

  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY start_time').all(USER);
  assert.equal(rows.length, 2);

  const streamCount = db.prepare('SELECT COUNT(*) c FROM streams WHERE activity_id = ?').get(rows[0].id).c;
  assert.ok(streamCount >= 6, `expected several stream channels, got ${streamCount}`);
});

/** A ZIP shaped like a real Nike export: a tcx/ folder of runs, plus the export PDF. */
function nikeExportZip() {
  const second = syntheticRun({ n: 300, speed: 2.6, startMs: BASE_TIME + 86400000 });
  return makeZip([
    { name: 'tcx/00024415-0e80-4e97-a08b-845e30c017dc.tcx',
      data: makeTcx(samples, { distance: 'delta', eventDriven: true,
        nikeTags: { 'com.nike.name': 'Utreg Trail Run', 'com.nike.devicename': 'COROS PACE 3', rpe: '7', terrain: 'trail' } }) },
    { name: 'tcx/0628d536-3efe-4a48-a8db-994e42796e59.tcx',
      data: makeTcx(second, { distance: 'delta', eventDriven: true }) },
    // Nike ships a PDF of the whole account alongside the activity files.
    { name: 'export.pdf', data: Buffer.from('%PDF-1.4 not really a pdf') },
  ]);
}

test('ingest: a whole unopened Nike export ZIP of TCX files', async () => {
  reset();
  const zipPath = path.join(DATA_DIR, 'nikeuserdata.zip');
  fs.writeFileSync(zipPath, nikeExportZip());

  const report = await ingestPath(db, USER, zipPath, { filename: 'nikeuserdata.zip' });

  assert.equal(report.imported, 2, `imported ${report.imported}: ${JSON.stringify(report.log, null, 1)}`);
  assert.equal(report.failed, 0);

  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY start_time').all(USER);
  assert.equal(rows.length, 2);

  // Nike's own extension is the only place a title, device or RPE exists in a TCX, so
  // an import that ignored it would produce activities named "Morning Run" with no
  // device and no RPE — strictly worse than the file it came from.
  assert.equal(rows[0].name, 'Utreg Trail Run');
  assert.equal(rows[0].device, 'COROS PACE 3');
  assert.equal(rows[0].perceived_exertion, 7);
  assert.equal(rows[0].sport, 'trail_run');

  const streamCount = db.prepare('SELECT COUNT(*) c FROM streams WHERE activity_id = ?').get(rows[0].id).c;
  assert.ok(streamCount >= 6, `expected several stream channels, got ${streamCount}`);
});

test('ingest: the same run from a FIT file and a Nike TCX stays one activity', async () => {
  reset();
  // The whole point of matching on what an activity physically is: a Nike export and
  // the watch's own FIT of the same session must not become two runs in the log.
  await ingestBuffer(db, USER, makeFit(samples), { filename: 'watch.fit', recomputeMetrics: false });
  await ingestBuffer(db, USER, makeTcx(samples, { distance: 'delta' }), {
    filename: 'nike.tcx', recomputeMetrics: false,
  });

  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ?').all(USER);
  assert.equal(rows.length, 1, 'one physical session must not become two activities');
});

test('ingest: a TCX is identified by content, not by its extension', async () => {
  reset();
  const report = await ingestBuffer(db, USER, makeTcx(samples), { filename: 'no-extension' });
  assert.equal(report.imported, 1, JSON.stringify(report.toJSON().log));
});

test('ingest: unimported activities are reported, scaffolding is not', async () => {
  reset();
  const zipPath = path.join(DATA_DIR, 'strava_export.zip');
  fs.writeFileSync(zipPath, stravaExportZip());

  const report = await ingestPath(db, USER, zipPath, { filename: 'strava_export.zip' });

  // A GPX was an activity that did not make it in, so its count is reported.
  const skips = report.log.filter((l) => l.status === 'skipped');
  assert.ok(skips.some((l) => /GPX/i.test(l.reason)), JSON.stringify(skips));
  assert.equal(report.skipReasons['GPX file'], 1);

  // Profile JSON and a followers list never were activities, so they are counted but
  // not itemised. Reporting them as "skipped" hides the number that matters.
  assert.ok(!skips.some((l) => /CSV|JSON/i.test(l.reason)), JSON.stringify(skips));
  assert.ok(report.ignored >= 2, `scaffolding is still counted (ignored=${report.ignored})`);
});

test('ingest: importing the same archive twice changes nothing', async () => {
  reset();
  const zipPath = path.join(DATA_DIR, 'strava_export.zip');
  fs.writeFileSync(zipPath, stravaExportZip());

  await ingestPath(db, USER, zipPath, { filename: 'strava_export.zip' });
  const firstCount = db.prepare('SELECT COUNT(*) c FROM activities WHERE user_id = ?').get(USER).c;

  const second = await ingestPath(db, USER, zipPath, { filename: 'strava_export.zip' });
  const secondCount = db.prepare('SELECT COUNT(*) c FROM activities WHERE user_id = ?').get(USER).c;

  assert.equal(secondCount, firstCount, 'a repeat import must not duplicate activities');
  assert.equal(second.imported, 0);
  assert.ok(second.duplicates >= 1, `expected duplicates, got ${JSON.stringify(second.toJSON().log)}`);
});

test('ingest: the same ride from two sources stays one activity', async () => {
  reset();
  // Once off the head unit, once out of a Strava export. Matching is physical —
  // sport, start time, distance — so where the file came from is irrelevant.
  await ingestBuffer(db, USER, makeFit(samples), { filename: 'watch.fit', recomputeMetrics: false });
  await ingestBuffer(db, USER, gzip(makeFit(samples)), { filename: '999.fit.gz', recomputeMetrics: false });

  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ?').all(USER);
  assert.equal(rows.length, 1, 'the same physical session must not become two activities');
});

test('ingest: a bare gzipped FIT file is unwrapped and imported', async () => {
  reset();
  const report = await ingestBuffer(db, USER, gzip(makeFit(samples)), { filename: '1111.fit.gz' });
  assert.equal(report.imported, 1, JSON.stringify(report.toJSON().log));
});

test('ingest: identifies files by content, not by extension', async () => {
  reset();
  // A FIT file misleadingly named .gpx must still be recognised as FIT.
  const report = await ingestBuffer(db, USER, makeFit(samples), { filename: 'definitely-a-track.gpx' });
  assert.equal(report.imported, 1);
  const row = db.prepare('SELECT avg_power FROM activities WHERE user_id = ?').get(USER);
  assert.ok(row.avg_power > 200, 'content sniffing should have chosen the FIT parser');
});

test('ingest: an unsupported file is skipped, not failed', async () => {
  reset();
  const report = await ingestBuffer(db, USER, Buffer.from('<?xml version="1.0"?><gpx><trk/></gpx>'), {
    filename: 'phone-run.gpx',
  });
  assert.equal(report.imported, 0);
  assert.equal(report.failed, 0, 'an unsupported format is not an error');
  assert.equal(report.skipped, 1);
  assert.match(report.log[0].reason, /GPX/);
});

// ─── metrics ──────────────────────────────────────────────────────────────────

test('metrics: load and the fitness curve are computed', async () => {
  reset();
  await ingestBuffer(db, USER, makeFit(samples), { filename: 'run.fit', recomputeMetrics: false });
  recomputeAll(db, USER);

  const act = db.prepare('SELECT * FROM activities WHERE user_id = ?').get(USER);
  assert.ok(act.load > 0, `load should be positive, got ${act.load}`);
  assert.ok(['power', 'hr', 'pace', 'duration', 'device'].includes(act.load_method));

  const daily = db.prepare('SELECT * FROM daily WHERE user_id = ? ORDER BY day').all(USER);
  assert.ok(daily.length > 0, 'daily rollup should exist');

  const withLoad = daily.find((d) => d.load > 0);
  assert.ok(withLoad, 'at least one day should carry load');
  assert.ok(withLoad.ctl > 0, 'fitness (CTL) should be positive');
  assert.ok(withLoad.atl > 0, 'fatigue (ATL) should be positive');
  assert.ok(Number.isFinite(withLoad.tsb), 'form (TSB) should be a number');
});

test('best efforts: the power curve and fastest splits are recorded', async () => {
  reset();
  await ingestBuffer(db, USER, makeFit(samples), { filename: 'run.fit' });

  const peaks = db.prepare(
    "SELECT bucket, value FROM best_efforts WHERE user_id = ? AND kind = 'peak_power' ORDER BY bucket",
  ).all(USER);
  assert.ok(peaks.length > 3, `expected a power curve, got ${peaks.length} points`);
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i].value <= peaks[i - 1].value + 1e-6,
      `power curve not monotonic at ${peaks[i].bucket}s`);
  }

  const splits = db.prepare(
    "SELECT bucket, value FROM best_efforts WHERE user_id = ? AND kind = 'fastest_distance' ORDER BY bucket",
  ).all(USER);
  const k1 = splits.find((s) => s.bucket === 1000);
  assert.ok(k1, 'a 1 km split should be found in a 1.8 km run');
  // 1000 m at 3.0 m/s is ~333 s.
  assert.ok(Math.abs(k1.value - 333) < 12, `1 km split was ${k1.value}s`);
});

// ─── the central guarantee ────────────────────────────────────────────────────

test('reindex: rebuilds the database from the FIT files alone', async () => {
  reset();
  const zipPath = path.join(DATA_DIR, 'strava_export.zip');
  fs.writeFileSync(zipPath, stravaExportZip());
  await ingestPath(db, USER, zipPath, { filename: 'strava_export.zip' });

  const before = snapshot(db, USER);
  assert.ok(before.activities.length >= 2);

  // Simulate total loss of the derived database.
  const result = await reindex(db, USER, { verify: true });
  assert.equal(result.failed, 0, `reindex failures: ${JSON.stringify(result.log, null, 1)}`);
  assert.equal(result.integrity.corrupt.length, 0, 'originals store should be intact');

  const after = snapshot(db, USER);

  assert.equal(after.activities.length, before.activities.length,
    'reindex must reproduce the same number of activities');

  for (let i = 0; i < before.activities.length; i++) {
    const a = before.activities[i];
    const b = after.activities[i];
    assert.equal(b.sport, a.sport, 'sport must survive a reindex');
    assert.equal(b.start_time, a.start_time, 'start time must survive a reindex');
    assert.equal(round(b.distance_m), round(a.distance_m), 'distance must survive a reindex');
    assert.equal(round(b.load), round(a.load), 'computed load must be reproducible');
    assert.equal(b.streamChannels, a.streamChannels, 'stream channels must be reproducible');
  }

  assert.equal(after.dailyCount, before.dailyCount, 'the daily rollup must be reproducible');
});

function snapshot(db, userId) {
  const activities = db.prepare(
    'SELECT * FROM activities WHERE user_id = ? ORDER BY start_time, distance_m',
  ).all(userId).map((a) => ({
    ...a,
    streamChannels: db.prepare('SELECT COUNT(*) c FROM streams WHERE activity_id = ?').get(a.id).c,
  }));

  return {
    activities,
    dailyCount: db.prepare('SELECT COUNT(*) c FROM daily WHERE user_id = ?').get(userId).c,
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

test.after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});
