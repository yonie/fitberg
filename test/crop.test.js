// Cropping.
//
// A forgotten stop turns a 5 km run into a 25 km one with a 45 km/h top speed, and that
// pollutes every record. Cropping has to fix the numbers without touching the file, and
// it has to survive the database being thrown away and rebuilt from those files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitberg-crop-'));
process.env.DATA_DIR = DATA_DIR;
process.env.OLLAMA_ENABLED = '0';

const { syntheticRun, makeFit, makeTcx } = await import('./fixtures.js');
const { getDb } = await import('../server/db/index.js');
const { ingestBuffer } = await import('../server/ingest/index.js');

const db = await getDb();
const USER = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)')
  .run('crop@test', Date.now()).lastInsertRowid;

// ─── cropping ─────────────────────────────────────────────────────────────────

const { saveEdit, applyCrop, applyEdits, cropActivity } = await import('../server/db/edits.js');
const { reindex } = await import('../server/ingest/reindex.js');

test('crop: trimming the end shortens the activity and re-derives its totals', async () => {
  const startMs = Date.UTC(2025, 2, 3, 7, 0, 0);
  // 20 minutes at 3 m/s = 3600 m.
  const samples = syntheticRun({ n: 1200, startMs });
  const bytes = makeFit(samples, { sport: 'running', deriveSummary: true });

  const report = await ingestBuffer(db, USER, bytes, {
    filename: 'crop-me.fit', recomputeMetrics: false,
  });
  const [id] = report.activityIds;
  const before = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(before.distance_m > 3500, `expected ~3600 m, got ${before.distance_m}`);

  // Keep the first 10 minutes only — as if the rest were a drive home.
  saveEdit(db, USER, before.dedupe_key, { crop_start_s: 0, crop_end_s: 600 });
  assert.equal(applyCrop(db, before, { crop_start_s: 0, crop_end_s: 600 }), true);

  const after = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(Math.abs(after.distance_m - 1800) < 60, `expected ~1800 m, got ${after.distance_m}`);
  assert.ok(after.elapsed_s <= 601, `expected ~600 s, got ${after.elapsed_s}`);
  assert.equal(after.crop_end_s, 600);

  // The streams are trimmed too, not just the summary — otherwise the charts would
  // still show the drive home.
  const streams = db.prepare("SELECT n FROM streams WHERE activity_id = ? AND channel = 't'").get(id);
  assert.ok(streams.n <= 601, `stream still has ${streams.n} samples`);

  // Averages are re-derived rather than kept: a cropped run cannot keep the whole
  // recording's average heart rate.
  assert.notEqual(after.avg_hr, before.avg_hr);

  // And the file is untouched — that is the whole point of "non-destructive".
  const original = db.prepare('SELECT bytes FROM originals WHERE hash = ?').get(before.original_hash);
  assert.equal(original.bytes, bytes.length);
});

test('crop: survives a reindex, and so do notes', async () => {
  const startMs = Date.UTC(2025, 3, 9, 6, 0, 0);
  const samples = syntheticRun({ n: 1200, startMs });
  const bytes = makeFit(samples, { sport: 'running', deriveSummary: true });

  const report = await ingestBuffer(db, USER, bytes, {
    filename: 'crop-survives.fit', recomputeMetrics: false,
  });
  const [id] = report.activityIds;
  const row = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);

  saveEdit(db, USER, row.dedupe_key, {
    crop_start_s: 0, crop_end_s: 600, notes: 'stopped for coffee', perceived_exertion: 4,
  });
  applyEdits(db, USER);

  const cropped = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(Math.abs(cropped.distance_m - 1800) < 60);
  assert.equal(cropped.notes, 'stopped for coffee');

  // The database is a cache: throw it away and rebuild from the files.
  await reindex(db, USER);

  const rebuilt = db.prepare('SELECT * FROM activities WHERE dedupe_key = ?').get(row.dedupe_key);
  assert.ok(rebuilt, 'the activity came back');
  assert.ok(
    Math.abs(rebuilt.distance_m - 1800) < 60,
    `crop must survive reindex; distance came back as ${rebuilt.distance_m}`,
  );
  assert.equal(rebuilt.notes, 'stopped for coffee', 'notes must survive reindex');
  assert.equal(rebuilt.perceived_exertion, 4, 'RPE must survive reindex');
});

test('crop: a TCX-backed activity crops too, not just a FIT one', async () => {
  // Over half a Nike Run Club import is TCX, and re-deriving the crop reads the original
  // back off disk. Parsing that as FIT throws, which the caller could only report as
  // "that crop would leave nothing" — so trimming was refused for every one of them.
  const startMs = Date.UTC(2025, 5, 12, 18, 0, 0);
  const samples = syntheticRun({ n: 1200, startMs });
  const bytes = Buffer.from(makeTcx(samples, { sport: 'Running' }));

  const report = await ingestBuffer(db, USER, bytes, {
    filename: 'crop-me.tcx', recomputeMetrics: false,
  });
  const [id] = report.activityIds;
  const before = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(before.distance_m > 3500, `expected ~3600 m, got ${before.distance_m}`);
  assert.equal(
    db.prepare('SELECT kind FROM originals WHERE hash = ?').get(before.original_hash).kind,
    'tcx',
  );

  assert.equal(applyCrop(db, before, { crop_start_s: 0, crop_end_s: 600 }), true);

  const after = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(Math.abs(after.distance_m - 1800) < 60, `expected ~1800 m, got ${after.distance_m}`);
  assert.ok(after.elapsed_s <= 601, `expected ~600 s, got ${after.elapsed_s}`);
  assert.equal(after.crop_end_s, 600);

  // And it comes back off: clearing restores the whole recording.
  assert.equal(applyCrop(db, after, { crop_start_s: null, crop_end_s: null }), true);
  const restored = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  assert.ok(restored.distance_m > 3500, `expected ~3600 m back, got ${restored.distance_m}`);
});

test('crop: the whole recording\'s length survives the crop, so a trim can be widened', async () => {
  // A crop overwrites elapsed_s with the CROPPED length. The trim editor bounds its
  // handles by the recording length, so without a separate record of it the slider ends
  // at the cut: every trim could be tightened and none could ever be loosened.
  const startMs = Date.UTC(2025, 6, 2, 6, 30, 0);
  const samples = syntheticRun({ n: 1200, startMs });
  const bytes = makeFit(samples, { sport: 'running', deriveSummary: true });

  const report = await ingestBuffer(db, USER, bytes, {
    filename: 'crop-widen.fit', recomputeMetrics: false,
  });
  const [id] = report.activityIds;
  const read = () => db.prepare('SELECT * FROM activities WHERE id = ?').get(id);

  // Untouched, the two agree.
  const before = read();
  assert.equal(before.recording_elapsed_s, before.elapsed_s);

  // Trim to 10 minutes: elapsed follows the crop, the recording length does not.
  assert.equal(applyCrop(db, before, { crop_start_s: 0, crop_end_s: 600 }), true);
  const tight = read();
  assert.ok(tight.elapsed_s <= 601, `expected ~600 s, got ${tight.elapsed_s}`);
  assert.ok(
    tight.recording_elapsed_s >= 1100,
    `the recording is ~1199 s; got ${tight.recording_elapsed_s}`,
  );

  // Which is what lets the next crop reach past the previous one.
  assert.equal(applyCrop(db, tight, { crop_start_s: 0, crop_end_s: 900 }), true);
  const wider = read();
  assert.ok(wider.elapsed_s > tight.elapsed_s, 'the trim must be able to open back out');
  assert.ok(Math.abs(wider.distance_m - 2700) < 60, `expected ~2700 m, got ${wider.distance_m}`);
  assert.ok(wider.recording_elapsed_s >= 1100, 'and the recording length still stands');
});

test('crop: a window that would leave nothing is refused', () => {
  const samples = syntheticRun({ n: 600, startMs: Date.UTC(2025, 4, 1) });
  const act = { startTime: Date.UTC(2025, 4, 1), streams: {}, laps: [] };
  for (const key of ['t', 'lat', 'lng', 'hr', 'dist']) {
    act.streams[key] = samples.map((s) => (key === 't' ? s.t : s[key === 'dist' ? 'dist' : key]));
  }
  assert.equal(cropActivity(act, 500, 500.5), null);
  assert.equal(cropActivity(act, 5000, 6000), null);
});

