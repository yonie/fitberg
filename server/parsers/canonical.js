// The canonical activity shape every parser produces, plus the derivation pass
// that fills in whatever the source did not tell us.
//
// The guiding rule: trust the device's own summary when it exists (it knows about
// auto-pause, wheel circumference, pool length), and only compute a field from
// the raw streams when it is missing. That keeps a Wahoo ride's distance matching
// what the head unit displayed, rather than silently disagreeing by 1%.

import { haversine, encodePolyline, simplifyTrack, boundingBox, elevationChange } from '../lib/geo.js';
import { familyOf, isDistanceSport } from './sports.js';

export const STREAM_CHANNELS = ['t', 'lat', 'lng', 'alt', 'hr', 'cad', 'power', 'speed', 'dist', 'temp'];

/** An empty canonical activity. Parsers fill in what they know. */
export function newActivity(source) {
  return {
    source,
    sourceId: null,
    name: null,
    sport: 'other',
    subSport: null,

    startTime: null,        // epoch ms UTC
    utcOffsetS: 0,
    timezone: null,

    elapsedS: null,
    movingS: null,
    distanceM: null,
    elevGainM: null,
    elevLossM: null,
    elevMinM: null,
    elevMaxM: null,

    avgSpeedMs: null,
    maxSpeedMs: null,
    avgHr: null,
    maxHr: null,
    avgCadence: null,
    maxCadence: null,
    avgPower: null,
    maxPower: null,
    normalizedPower: null,
    workKj: null,
    calories: null,
    avgTempC: null,

    trainer: false,
    commute: false,
    manual: false,

    perceivedExertion: null,
    notes: null,

    streams: {},            // channel -> array of number|null
    laps: [],
    summary: null,          // the source's own payload, kept verbatim
  };
}

const MOVING_THRESHOLD_MS = {
  run: 0.5, walk: 0.3, ride: 1.0, swim: 0.15, row: 0.4, other: 0.3,
};

/**
 * Fill in derived fields. Idempotent and safe to run on partially-populated
 * activities — every assignment is guarded on the field being absent.
 */
export function finalizeActivity(act) {
  const s = act.streams || {};
  const n = streamLength(s);

  if (n > 0) {
    deriveTimeAndDistance(act, s, n);
    deriveElevation(act, s);
    deriveAggregates(act, s, n);
    derivePower(act, s, n);
    deriveTrack(act, s);
  }

  // Elapsed time of last resort: if all we have is a summary with a duration,
  // that is already set; otherwise fall back to the time stream span.
  if (!act.elapsedS && Array.isArray(s.t) && s.t.length > 1) {
    act.elapsedS = Math.round(lastFinite(s.t) - firstFinite(s.t));
  }
  if (!act.movingS) act.movingS = act.elapsedS;

  if (!act.avgSpeedMs && act.distanceM > 0 && act.movingS > 0) {
    act.avgSpeedMs = act.distanceM / act.movingS;
  }

  if (!act.workKj && act.avgPower && act.movingS) {
    act.workKj = (act.avgPower * act.movingS) / 1000;
  }

  act.dedupeKey = dedupeKey(act);
  return act;
}

function deriveTimeAndDistance(act, s, n) {
  // Prefer the device's cumulative distance stream; integrating GPS points
  // consistently over-reads because every sample's error adds to the total.
  if (!act.distanceM) {
    const deviceDist = Array.isArray(s.dist) ? lastFinite(s.dist) : null;
    if (Number.isFinite(deviceDist) && deviceDist > 0) {
      act.distanceM = deviceDist;
    } else if (Array.isArray(s.lat) && Array.isArray(s.lng)) {
      act.distanceM = integrateTrackDistance(s.lat, s.lng, n);
    }
  }

  // Build a cumulative distance stream if the source lacked one — the charts and
  // the fastest-split search both need distance-indexed data.
  if (!Array.isArray(s.dist) && Array.isArray(s.lat) && Array.isArray(s.lng)) {
    const dist = new Array(n).fill(null);
    let acc = 0;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const lat = s.lat[i];
      const lng = s.lng[i];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        if (prev) acc += haversine(prev[0], prev[1], lat, lng);
        prev = [lat, lng];
      }
      dist[i] = acc;
    }
    s.dist = dist;
  }

  // Speed: derive from distance/time when the device did not record it.
  if (!Array.isArray(s.speed) && Array.isArray(s.dist) && Array.isArray(s.t)) {
    const speed = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const dt = s.t[i] - s.t[i - 1];
      const dd = s.dist[i] - s.dist[i - 1];
      if (Number.isFinite(dt) && dt > 0 && Number.isFinite(dd) && dd >= 0) {
        speed[i] = dd / dt;
      }
    }
    if (n > 1) speed[0] = speed[1];
    s.speed = speed;
  }

  // Moving time: exclude samples below a per-sport speed floor, which is what
  // makes our average pace agree with the watch instead of being dragged down by
  // traffic lights and aid stations.
  if (!act.movingS && Array.isArray(s.speed) && Array.isArray(s.t)) {
    const floor = MOVING_THRESHOLD_MS[familyOf(act.sport)] ?? 0.3;
    let moving = 0;
    for (let i = 1; i < n; i++) {
      const dt = s.t[i] - s.t[i - 1];
      if (!Number.isFinite(dt) || dt <= 0 || dt > 60) continue; // >60s gap = paused
      const v = s.speed[i];
      if (Number.isFinite(v) && v >= floor) moving += dt;
    }
    if (moving > 0) act.movingS = Math.round(moving);
  }
}

function integrateTrackDistance(lat, lng, n) {
  let total = 0;
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(lat[i]) || !Number.isFinite(lng[i])) continue;
    if (prev) {
      const step = haversine(prev[0], prev[1], lat[i], lng[i]);
      // Reject teleports: a >200 m jump between consecutive samples is a GPS
      // glitch or a tunnel re-acquire, not real distance covered.
      if (step < 200) total += step;
    }
    prev = [lat[i], lng[i]];
  }
  return total;
}

function deriveElevation(act, s) {
  if (!Array.isArray(s.alt)) return;
  if (act.elevGainM !== null && act.elevGainM !== undefined) return;
  const { gain, loss, min, max } = elevationChange(s.alt);
  act.elevGainM = gain;
  act.elevLossM = loss;
  act.elevMinM = min;
  act.elevMaxM = max;
}

function deriveAggregates(act, s, n) {
  const pairs = [
    ['hr', 'avgHr', 'maxHr'],
    ['cad', 'avgCadence', 'maxCadence'],
    ['power', 'avgPower', 'maxPower'],
    ['speed', null, 'maxSpeedMs'],
    ['temp', 'avgTempC', null],
  ];

  for (const [channel, avgField, maxField] of pairs) {
    const arr = s[channel];
    if (!Array.isArray(arr)) continue;
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (!Number.isFinite(v)) continue;
      // Cadence and power legitimately read 0 while coasting; including those
      // zeros in the average is the convention for power but not for cadence.
      if (channel === 'cad' && v === 0) { if (v > max) max = v; continue; }
      sum += v; count++;
      if (v > max) max = v;
    }
    if (count > 0) {
      if (avgField && act[avgField] === null) act[avgField] = sum / count;
      if (maxField && act[maxField] === null && Number.isFinite(max)) act[maxField] = max;
    }
  }

  // Guard against a single GPS spike claiming a 40 m/s sprint.
  //
  // This used to compare against a per-sport "plausible" constant, which is a judgement
  // about how fast someone can go — the wrong kind of assumption to bake in, and wrong
  // for anyone faster than the number chosen. The physical distinction is duration, not
  // magnitude: a GPS spike is one or two samples wide, a real sprint lasts seconds. So
  // the reported maximum is the fastest speed *held for three seconds*, which needs no
  // opinion about the athlete and no per-sport table.
  if (Array.isArray(s.speed)) {
    const sustained = sustainedMax(s.speed, 3);
    if (sustained !== null) act.maxSpeedMs = sustained;
  }
}

/**
 * The highest value held for at least `window` consecutive samples.
 *
 * Streams are resampled to one sample per second before this runs, so the window is
 * seconds. Implemented as a rolling minimum over the window: a spike drags its own
 * window's minimum down and cannot win.
 */
function sustainedMax(values, window) {
  let best = null;
  for (let i = 0; i + window <= values.length; i++) {
    let low = Infinity;
    let complete = true;
    for (let k = i; k < i + window; k++) {
      const v = values[k];
      if (!Number.isFinite(v)) { complete = false; break; }
      if (v < low) low = v;
    }
    if (complete && (best === null || low > best)) best = low;
  }
  // A recording shorter than the window still deserves an answer.
  if (best === null) {
    const finite = values.filter((v) => Number.isFinite(v));
    return finite.length ? Math.max(...finite) : null;
  }
  return best;
}


function derivePower(act, s, n) {
  if (!Array.isArray(s.power) || act.normalizedPower !== null) return;

  // Normalized Power: 30-second rolling average, then the fourth root of the
  // mean of those averages raised to the fourth. The exponent is what makes
  // surging cost more than steady riding at the same average watts.
  const window = 30;
  const rolling = [];
  let sum = 0;
  let count = 0;
  const queue = [];

  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(s.power[i]) ? s.power[i] : 0;
    queue.push(v); sum += v; count++;
    if (queue.length > window) { sum -= queue.shift(); count--; }
    if (queue.length === window) rolling.push(sum / count);
  }
  if (rolling.length < window) return;

  let quartic = 0;
  for (const v of rolling) quartic += v ** 4;
  act.normalizedPower = (quartic / rolling.length) ** 0.25;

  if (act.avgPower > 0) act.variabilityIndex = act.normalizedPower / act.avgPower;
}

function deriveTrack(act, s) {
  if (!Array.isArray(s.lat) || !Array.isArray(s.lng)) return;

  const points = [];
  for (let i = 0; i < s.lat.length; i++) {
    if (Number.isFinite(s.lat[i]) && Number.isFinite(s.lng[i])) points.push([s.lat[i], s.lng[i]]);
  }
  if (!points.length) return;

  if (!act.polyline) act.polyline = encodePolyline(simplifyTrack(points, 900));
  if (act.startLat === undefined || act.startLat === null) {
    act.startLat = points[0][0];
    act.startLng = points[0][1];
  }
  if (!act.bbox) act.bbox = boundingBox(points);
}

/**
 * Cross-source dedupe key.
 *
 * The same ride imported from a Strava export, a Wahoo sync and a raw FIT file
 * must collapse to one activity. Source IDs cannot do that — they differ per
 * platform — so the key is physical: sport family, start time rounded to the
 * nearest 2 minutes, and distance rounded to 100 m. Start times drift by a few
 * seconds between platforms (upload timestamp vs first GPS fix), hence the
 * coarse bucket; distance disambiguates two sessions that began together.
 */
export function dedupeKey(act) {
  const family = familyOf(act.sport);
  const bucket = act.startTime ? Math.round(act.startTime / 120000) : 0;
  const dist = isDistanceSport(act.sport) && act.distanceM
    ? Math.round(act.distanceM / 100)
    : Math.round((act.elapsedS || 0) / 60);
  return `${family}:${bucket}:${dist}`;
}

/**
 * A start time rounded down to the previous 2-minute bucket, so an activity
 * whose timestamps differ by a second either side of a boundary still matches.
 * Callers check both this and the primary key.
 */
export function dedupeKeyNeighbours(act) {
  const family = familyOf(act.sport);
  const base = act.startTime ? Math.round(act.startTime / 120000) : 0;
  const dist = isDistanceSport(act.sport) && act.distanceM
    ? Math.round(act.distanceM / 100)
    : Math.round((act.elapsedS || 0) / 60);
  return [base - 1, base, base + 1].map((b) => `${family}:${b}:${dist}`);
}

// ── small helpers ────────────────────────────────────────────────────────────

export function streamLength(streams) {
  let n = 0;
  for (const key of STREAM_CHANNELS) {
    const arr = streams[key];
    if (Array.isArray(arr) && arr.length > n) n = arr.length;
  }
  return n;
}

function firstFinite(arr) {
  for (const v of arr) if (Number.isFinite(v)) return v;
  return NaN;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return NaN;
}

function percentile(arr, p) {
  const clean = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.min(clean.length - 1, Math.floor(clean.length * p))];
}

/** Pad/truncate every channel to the same length so blob indices always align. */
export function alignStreams(streams) {
  const n = streamLength(streams);
  for (const key of Object.keys(streams)) {
    const arr = streams[key];
    if (!Array.isArray(arr)) { delete streams[key]; continue; }
    if (arr.length < n) arr.push(...new Array(n - arr.length).fill(null));
    else if (arr.length > n) arr.length = n;
  }
  return n;
}
