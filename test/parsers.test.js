import test from 'node:test';
import assert from 'node:assert/strict';

import { syntheticRun, makeFit, BASE_TIME } from './fixtures.js';
import { parseFit } from '../server/parsers/fit.js';
import { normalizeSport } from '../server/parsers/sports.js';
import { encodeStream, decodeStream } from '../server/lib/codec.js';
import { haversine, encodePolyline, decodePolyline, elevationChange } from '../server/lib/geo.js';
import { sniff, KINDS } from '../server/ingest/sniff.js';

const samples = syntheticRun({ n: 600, speed: 3.0 });
const EXPECTED_DISTANCE = samples[samples.length - 1].dist; // 1797 m

// ─── FIT ──────────────────────────────────────────────────────────────────────

test('FIT: decodes a real encoded activity with full streams', () => {
  const { activities } = parseFit(makeFit(samples));
  assert.equal(activities.length, 1);
  const a = activities[0];

  assert.equal(a.sport, 'run');
  assert.equal(a.startTime, BASE_TIME);
  assert.equal(a.elapsedS, 599);
  assert.ok(Math.abs(a.distanceM - EXPECTED_DISTANCE) < 2, `distance ${a.distanceM}`);
  assert.equal(a.avgHr, 147);
  assert.equal(a.maxHr, 165);
  assert.equal(a.avgPower, 259);

  for (const ch of ['t', 'lat', 'lng', 'alt', 'hr', 'cad', 'power', 'dist']) {
    assert.ok(Array.isArray(a.streams[ch]), `missing stream ${ch}`);
    assert.equal(a.streams[ch].length, 600, `stream ${ch} length`);
  }

  // Semicircle -> degrees conversion must land back on the input coordinates.
  assert.ok(Math.abs(a.streams.lat[0] - samples[0].lat) < 1e-5, `lat ${a.streams.lat[0]}`);
  assert.ok(Math.abs(a.streams.lng[0] - samples[0].lng) < 1e-5, `lng ${a.streams.lng[0]}`);

  assert.ok(a.polyline && a.polyline.length > 10);
  assert.ok(a.laps.length >= 1);
});

test('FIT: derives UTC offset from the activity message local timestamp', () => {
  // This is the only way to know a 06:00 ride was a morning ride. Verified against
  // a real Wahoo ELEMNT file too, which reported +7200 for Amsterdam summer time.
  const { activities } = parseFit(makeFit(samples));
  assert.equal(activities[0].utcOffsetS, 3600);
});

test('FIT: computes normalized power and variability index', () => {
  const { activities } = parseFit(makeFit(samples));
  const a = activities[0];
  assert.ok(a.normalizedPower > 200 && a.normalizedPower < 320, `np ${a.normalizedPower}`);
  assert.ok(a.variabilityIndex >= 1 && a.variabilityIndex < 1.2, `vi ${a.variabilityIndex}`);
});

test('FIT: sub-sport promotes a run to trail/treadmill', () => {
  const trail = parseFit(makeFit(samples, { sport: 'running', subSport: 'trail' })).activities[0];
  assert.equal(trail.sport, 'trail_run');
  const tread = parseFit(makeFit(samples, { sport: 'running', subSport: 'treadmill' })).activities[0];
  assert.equal(tread.sport, 'treadmill_run');
});

test('FIT: a gym session recorded as sport=training becomes strength', () => {
  // Watches record strength work this way; without the sub-sport it collapses into
  // a meaningless generic "workout".
  const { activities } = parseFit(makeFit(samples, { sport: 'training', subSport: 'strengthTraining' }));
  assert.equal(activities[0].sport, 'strength');
});

test('FIT: a file with no session message still parses, and is not guessed at', () => {
  const { activities } = parseFit(makeFit(samples, { withSession: false }));
  const a = activities[0];
  assert.equal(a.startTime, BASE_TIME);
  assert.ok(a.distanceM > 1700, 'the records still give distance and time');
  // Deliberately NOT guessed from average speed. That used to file a downhill ski as a
  // run because it was fast, which quietly corrupted running records and pace stats.
  assert.equal(a.sport, 'other');
});

test('FIT: rejects non-FIT input', () => {
  assert.throws(() => parseFit(Buffer.from('this is not a fit file at all')), /not a FIT file|no records/i);
});

// ─── content sniffing ─────────────────────────────────────────────────────────

test('sniff: recognises FIT by its header, not its name', () => {
  const fit = makeFit(samples);
  assert.equal(sniff(fit, 'anything.txt').kind, KINDS.FIT);
  assert.equal(sniff(fit, 'no-extension').kind, KINDS.FIT);
});

test('sniff: recognises the containers FIT files arrive in', () => {
  assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'x.zip').kind, KINDS.ZIP);
  assert.equal(sniff(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0]), 'x.fit.gz').kind, KINDS.GZIP);
});

test('sniff: names activity recordings, ignores export scaffolding', () => {
  // Two different things. A GPX or TCX file *was* an activity, so its count is worth
  // reporting. A CSV index or a profile image never was, and itemising forty of them
  // buries the line that carries information.
  const gpx = sniff(Buffer.from('<?xml version="1.0"?><gpx><trk><trkpt lat="1" lon="2"/></trk></gpx>'), 'a.gpx');
  assert.equal(gpx.kind, KINDS.UNKNOWN);
  assert.equal(gpx.reason, 'GPX file');

  const tcx = sniff(Buffer.from('<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>'), 'a.tcx');
  assert.equal(tcx.reason, 'TCX file');

  // Scaffolding: null means "ignore without comment".
  assert.equal(sniff(Buffer.from('{"foo":1}'), 'a.json').reason, null);
  assert.equal(sniff(Buffer.from('a,b,c\n1,2,3'), 'a.csv').reason, null);
  // latin1, so the PNG magic is the real four bytes rather than their UTF-8 encoding.
  assert.equal(sniff(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), 'me.png').reason, null);
});

// ─── shared plumbing ──────────────────────────────────────────────────────────

test('sports: FIT sport and sub-sport enums map onto one vocabulary', () => {
  assert.equal(normalizeSport('running'), 'run');
  assert.equal(normalizeSport('cycling'), 'ride');
  assert.equal(normalizeSport('cycling', { subSport: 'gravel' }), 'gravel_ride');
  assert.equal(normalizeSport('cycling', { subSport: 'indoorCycling' }), 'virtual_ride');
  assert.equal(normalizeSport('running', { subSport: 'trail' }), 'trail_run');
  assert.equal(normalizeSport('training', { subSport: 'strengthTraining' }), 'strength');
  assert.equal(normalizeSport('swimming'), 'swim');
  assert.equal(normalizeSport('run', { trainer: true }), 'treadmill_run');
  assert.equal(normalizeSport('nonsense-sport'), 'other');
});

test('codec: integer channels round-trip nulls as NaN', () => {
  const enc = encodeStream('hr', [120, null, 155, undefined, 190]);
  const dec = decodeStream(enc);
  assert.equal(dec[0], 120);
  assert.ok(Number.isNaN(dec[1]));
  assert.equal(dec[2], 155);
  assert.ok(Number.isNaN(dec[3]));
  assert.equal(dec[4], 190);
});

test('codec: coordinates keep sub-metre precision', () => {
  const lat = 52.3702157;
  const dec = decodeStream(encodeStream('lat', [lat]));
  // f32 would lose ~1 m here, showing up as a visibly jittery track; f64 must not.
  assert.ok(Math.abs(dec[0] - lat) < 1e-9, `lost precision: ${dec[0]}`);
});

test('geo: haversine matches a known distance', () => {
  const d = haversine(52.0, 5.0, 53.0, 5.0);   // 1 degree of latitude ~111.2 km
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('geo: polyline round-trips within encoding precision', () => {
  const pts = [[52.3702, 4.8952], [52.3712, 4.8962], [52.3722, 4.8972]];
  const decoded = decodePolyline(encodePolyline(pts));
  assert.equal(decoded.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(decoded[i][0] - pts[i][0]) < 1e-5);
    assert.ok(Math.abs(decoded[i][1] - pts[i][1]) < 1e-5);
  }
});

test('geo: elevation threshold rejects sensor noise', () => {
  // Pure ±0.4 m jitter around 100 m must not accumulate any gain, or a flat ride
  // reports hundreds of metres of imaginary climbing.
  const noisy = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 ? 0.4 : -0.4));
  assert.equal(elevationChange(noisy).gain, 0);

  const climb = Array.from({ length: 51 }, (_, i) => 100 + i);
  assert.ok(Math.abs(elevationChange(climb).gain - 50) < 2);
});
