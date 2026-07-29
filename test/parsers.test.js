import test from 'node:test';
import assert from 'node:assert/strict';

import { syntheticRun, makeFit, makeTcx, BASE_TIME } from './fixtures.js';
import { parseFit } from '../server/parsers/fit.js';
import { parseTcx } from '../server/parsers/tcx.js';
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

test('FIT: cadence is stored in whatever unit the file already used', () => {
  // Deliberately no conversion. Real files here already report running cadence in steps
  // per minute, so doubling it produced 253 spm — which nobody runs at.
  const { activities } = parseFit(makeFit(samples, { sport: 'running' }));
  const a = activities[0];
  assert.equal(a.avgCadence, 84);
  assert.equal(a.streams.cad[0], samples[0].cad);
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

// ─── TCX ──────────────────────────────────────────────────────────────────────

test('TCX: decodes a hand-built activity with full streams', () => {
  const { activities } = parseTcx(makeTcx(samples));
  assert.equal(activities.length, 1);
  const a = activities[0];

  assert.equal(a.sport, 'run');
  assert.equal(a.startTime, BASE_TIME);
  assert.ok(Math.abs(a.distanceM - EXPECTED_DISTANCE) < 2, `distance ${a.distanceM}`);
  assert.ok(a.avgHr > 0 && a.avgHr < 200, `avgHr ${a.avgHr}`);
  assert.ok(a.avgPower > 200, `avgPower ${a.avgPower}`);
  assert.equal(a.laps.length, 1);

  for (const ch of ['t', 'lat', 'lng', 'alt', 'hr', 'cad', 'power', 'speed', 'dist']) {
    assert.ok(Array.isArray(a.streams[ch]), `missing stream ${ch}`);
    assert.equal(a.streams[ch].length, 600, `stream ${ch} length`);
  }
  assert.ok(Math.abs(a.streams.lat[0] - samples[0].lat) < 1e-5, `lat ${a.streams.lat[0]}`);
  assert.ok(a.polyline && a.polyline.length > 10);
});

test('TCX: a Sport attribute maps onto the shared sport vocabulary', () => {
  const { activities } = parseTcx(makeTcx(samples, { sport: 'Biking' }));
  assert.equal(activities[0].sport, 'ride');
});

test('TCX: reads Nike\'s nax:Tag extension — device, title, RPE, note, temperature', () => {
  const { activities } = parseTcx(makeTcx(samples, {
    nikeTags: {
      'com.nike.devicename': 'COROS PACE 3',
      'com.nike.name': 'Utreg Trail Run',
      rpe: '7',
      note: 'Adem niet helemaal onder controle',
      'com.nike.temperature': '18.5',
    },
  }));
  const a = activities[0];
  assert.equal(a.device, 'COROS PACE 3');
  assert.equal(a.name, 'Utreg Trail Run');
  assert.equal(a.perceivedExertion, 7);
  assert.match(a.notes, /Adem niet helemaal onder controle/);
  assert.ok(Math.abs(a.avgTempC - 18.5) < 1e-6, `avgTempC ${a.avgTempC}`);
});

test('TCX: a trail terrain tag promotes a run to a trail run', () => {
  const { activities } = parseTcx(makeTcx(samples, { nikeTags: { terrain: 'trail' } }));
  assert.equal(activities[0].sport, 'trail_run');
});

test('TCX: an indoors location tag marks the session as a trainer run', () => {
  const { activities } = parseTcx(makeTcx(samples, { nikeTags: { location: 'indoors' } }));
  const a = activities[0];
  assert.equal(a.trainer, true);
  assert.equal(a.sport, 'treadmill_run');
});

test('TCX: Sport="undefined" falls back to Nike\'s own ActivityType instead of "other"', () => {
  // A seventh of a real Nike export writes the literal string "undefined" as the Sport
  // attribute while naming the sport correctly in its own extension. Filed as "other" a
  // run counts toward no sport total and no personal record, so this is not cosmetic.
  const { activities } = parseTcx(makeTcx(samples, { sport: 'undefined', activityType: 'Running' }));
  assert.equal(activities[0].sport, 'run');
});

test('TCX: a guided NTC session is classified from its workout type, not its ActivityType', () => {
  // Nike labels guided yoga and strength classes `ActivityType=Running` too, so the
  // workout type has to win or every gym session in the export becomes a run.
  const { activities } = parseTcx(makeTcx(samples, {
    sport: 'undefined',
    activityType: 'Running',
    nikeTags: { 'com.nike.ntc.workout.type': 'yoga', 'com.nike.ntc.workout.name': 'Core Flow' },
  }));
  const a = activities[0];
  assert.equal(a.sport, 'yoga');
  assert.equal(a.name, 'Core Flow');
});

test('TCX: only the athlete\'s own note becomes notes, not the producer\'s boilerplate', () => {
  // Nike writes "Mean Pace: 5.68 MKM" as a lap note on every activity. Storing that in
  // `notes` restates a number already shown as the pace, and makes an activity you never
  // annotated look annotated.
  const withBoth = parseTcx(makeTcx(samples, {
    producerNote: 'Mean Pace: 5.688953927716134 MKM',
    nikeTags: { note: 'Legs felt good' },
  })).activities[0];
  assert.equal(withBoth.notes, 'Legs felt good');
  assert.equal(withBoth.summary.producerNote, 'Mean Pace: 5.688953927716134 MKM',
    'the producer note is still kept for provenance');

  const boilerplateOnly = parseTcx(makeTcx(samples, {
    producerNote: 'Mean Pace: 5.688953927716134 MKM',
  })).activities[0];
  assert.equal(boilerplateOnly.notes, null, 'an unannotated activity must stay unannotated');
});

test('TCX: an NTC workout with no GPS is classified from workout type, not left as other', () => {
  const noGps = syntheticRun({ n: 60, speed: 0 }).map((s) => ({ ...s, lat: NaN, lng: NaN, dist: NaN }));
  const { activities } = parseTcx(makeTcx(noGps, {
    sport: 'undefined',
    calories: 0,
    nikeTags: {
      'com.nike.ntc.workout.type': 'yoga',
      'com.nike.ntc.workout.name': 'Morning Flow',
      'com.nike.ntc.workout.estimatedcalories': '45',
    },
  }));
  const a = activities[0];
  assert.equal(a.sport, 'yoga');
  assert.equal(a.name, 'Morning Flow');
  assert.equal(a.calories, 45);
  assert.equal(a.trainer, true);
});

test('TCX: Nike-style per-point distance deltas are detected, not read as cumulative', () => {
  // Nike writes DistanceMeters as the gap since the previous point, against the schema.
  // Read as cumulative, a 1.8 km run would report about 3 m.
  const { activities } = parseTcx(makeTcx(samples, { distance: 'delta' }));
  const a = activities[0];
  assert.ok(Math.abs(a.distanceM - EXPECTED_DISTANCE) < 2, `distance ${a.distanceM}`);
  // The stream has to come out cumulative and monotonic whichever way the file wrote it,
  // because the fastest-split search walks it looking for a distance window.
  const dist = a.streams.dist.filter(Number.isFinite);
  assert.ok(dist.every((v, i) => i === 0 || v >= dist[i - 1]), 'distance stream must not decrease');
  assert.ok(Math.abs(dist[dist.length - 1] - EXPECTED_DISTANCE) < 5, `stream end ${dist[dist.length - 1]}`);
});

test('TCX: cumulative distance is still read as cumulative', () => {
  // The same numbers under the other convention must not be double-counted.
  const { activities } = parseTcx(makeTcx(samples, { distance: 'cumulative' }));
  assert.ok(Math.abs(activities[0].distanceM - EXPECTED_DISTANCE) < 2);
});

test('TCX: event-driven trackpoints are gridded into dense per-second streams', () => {
  // Nike emits a point per sensor reading, so position and heart rate never share one.
  // Left as-is, every channel would be ~75% null and the charts would read that as
  // missing data rather than as a differently-shaped recording.
  const { activities } = parseTcx(makeTcx(samples, { eventDriven: true, distance: 'delta' }));
  const a = activities[0];

  for (const ch of ['lat', 'lng', 'hr', 'cad', 'speed', 'dist']) {
    const present = a.streams[ch].filter(Number.isFinite).length;
    assert.ok(present > a.streams[ch].length * 0.9,
      `${ch} should be dense after gridding, got ${present}/${a.streams[ch].length}`);
  }
  // Gridding must not invent a longer or shorter activity than the file describes.
  assert.equal(a.streams.t.length, 600);
  assert.ok(Math.abs(a.distanceM - EXPECTED_DISTANCE) < 2, `distance ${a.distanceM}`);
  assert.ok(a.avgHr > 130 && a.avgHr < 170, `avgHr ${a.avgHr}`);
});

test('TCX: a summary-only recording with a single trackpoint still becomes an activity', () => {
  // A treadmill entry: Nike reports the whole distance on one point and nothing else.
  const one = [{ ...syntheticRun({ n: 1 })[0], lat: NaN, lng: NaN, alt: NaN, dist: 5000 }];
  const { activities } = parseTcx(makeTcx(one, { calories: 320 }));
  const a = activities[0];
  assert.equal(a.startTime, BASE_TIME);
  assert.equal(a.distanceM, 5000);
  assert.equal(a.calories, 320);
  assert.equal(a.trainer, true, 'no GPS means it was not outdoors');
});

test('TCX: an implausible distance in the source is imported as it stands', () => {
  // A real export contains single samples claiming 5 and 6 km — a manually entered
  // treadmill distance, or a forgotten recording. Nothing here second-guesses that: the
  // file says what it says, and trimming is the athlete's call, not the parser's.
  const lumpy = syntheticRun({ n: 60, speed: 3.0 }).map((s, i) => ({
    ...s, lat: NaN, lng: NaN, dist: i < 30 ? s.dist : s.dist + 6000,
  }));
  const { activities, warnings } = parseTcx(makeTcx(lumpy, { distance: 'delta' }));
  const a = activities[0];

  assert.ok(a.streams.dist, 'the distance series is kept as recorded');
  assert.ok(a.distanceM > 6000, `and so is the total: ${a.distanceM}`);
  assert.equal(warnings.length, 0, 'no warning, because nothing was changed');
});

test('TCX: trackpoints that all share one timestamp yield a summary, not a one-sample stream', () => {
  // Some exports stamp every point with the same instant. A single sample carrying the
  // whole distance claims it all happened at once.
  const frozen = syntheticRun({ n: 40 }).map((s) => ({ ...s, timestamp: new Date(BASE_TIME) }));
  const { activities, warnings } = parseTcx(makeTcx(frozen, { calories: 200 }));
  const a = activities[0];

  assert.deepEqual(Object.keys(a.streams), [], 'no streams rather than a misleading one');
  assert.equal(a.startTime, BASE_TIME);
  assert.equal(a.calories, 200);
  assert.ok(a.distanceM > 0, 'the summary survives');
  assert.match(warnings.join(' '), /share one timestamp/);
});

test('TCX: the lap duration is kept as moving time, not overwritten by the sample span', () => {
  const { activities } = parseTcx(makeTcx(samples));
  const a = activities[0];
  // 600 samples at 1 Hz spans 599 s, and the fixture's lap reports the same.
  assert.equal(a.movingS, 599);
  assert.ok(a.elapsedS >= a.movingS, 'elapsed can never be shorter than moving');
});

test('TCX: a file with no activities throws rather than returning nothing', () => {
  assert.throws(
    () => parseTcx(Buffer.from('<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>')),
    /no usable activity/i,
  );
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

test('sniff: recognises TCX by content, like FIT', () => {
  const tcx = sniff(makeTcx(samples), 'anything.txt');
  assert.equal(tcx.kind, KINDS.TCX);
  assert.equal(sniff(Buffer.from('<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>')).kind, KINDS.TCX);
});

test('sniff: names GPX as an activity recording it cannot store, ignores export scaffolding', () => {
  // A GPX file *was* an activity, so its count is worth reporting even though there is
  // no parser for it. A CSV index or a profile image never was, and itemising forty of
  // them buries the line that carries information.
  const gpx = sniff(Buffer.from('<?xml version="1.0"?><gpx><trk><trkpt lat="1" lon="2"/></trk></gpx>'), 'a.gpx');
  assert.equal(gpx.kind, KINDS.UNKNOWN);
  assert.equal(gpx.reason, 'GPX file');

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
