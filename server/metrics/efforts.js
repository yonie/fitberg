import { familyOf } from '../parsers/sports.js';

// Best efforts: the power curve, peak heart rates and fastest distances.
//
// These drive the "am I getting fitter?" view, and they are also how the app
// bootstraps an athlete's FTP, threshold HR and threshold pace when they arrive
// from a platform that never told them those numbers.

// Durations for mean-maximal power and heart rate, in seconds.
export const PEAK_DURATIONS = [1, 5, 10, 15, 20, 30, 60, 120, 300, 480, 600, 1200, 1800, 2700, 3600, 5400];

// Distances for the fastest-split search, per sport family, in metres.
//
// Per family because a "marathon PR" on a bike is meaningless and a 400 m PR on a bike
// is a track event nobody rides on the road. What people actually keep records over
// differs by sport: runners use race distances, cyclists use time-trial distances and
// centuries, swimmers use pool events, rowers use the 2 k and its multiples.
const SPLITS = {
  run: [400, 800, 1000, 1609.344, 3000, 5000, 10000, 15000, 21097.5, 42195],
  // 10/20/40 km are the classic TT distances; 100 km and 100 miles are the endurance
  // landmarks. Nothing below a kilometre: over shorter distances a cyclist's record is
  // a power number, and the power curve already covers that.
  ride: [1000, 5000, 10000, 20000, 40000, 50000, 100000, 160934.4, 200000],
  // Pool events, plus the open-water mile.
  swim: [50, 100, 200, 400, 800, 1000, 1500, 1609.344, 2000, 5000],
  // Walkers and hikers do measure the same landmarks, including a marathon on foot.
  walk: [1000, 1609.344, 5000, 10000, 21097.5, 42195],
  // The 2 k is rowing's benchmark; the rest are the standard indoor pieces.
  row: [500, 1000, 2000, 5000, 6000, 10000, 21097.5, 42195],
};

// The fastest a human plausibly covers ground in each sport, in m/s.
//
// Used when *reading* records, never when computing them: every split found is stored,
// and this only decides what gets shown. That way the filter is a switch the athlete
// controls rather than data quietly thrown away, and turning it off needs no recompute.
//
// The usual cause of an impossible split is a forgotten stop — the drive home lands in
// the file. Every value here is comfortably above the world record for the sport, so a
// real effort is never hidden.
export const MAX_SPEED_MS = {
  run: 8,      // 28.8 km/h; Bolt peaked near 12 but not over any of these distances
  ride: 25,    // 90 km/h, i.e. a fast descent
  swim: 2.2,   // the 50 m free record is about 2.1, and pool turns step the distance
  walk: 4.5,   // race-walking and downhill hiking
  row: 6.5,    // the 2 k record is about 5.7
};

/** Every distance any family records over — for validating a stored bucket. */
export const SPLIT_DISTANCES = [...new Set(Object.values(SPLITS).flat())].sort((a, b) => a - b);

/**
 * The distances this sport keeps records over, or null if it keeps none.
 *
 * Strength, yoga and ball sports return null: they cover no ground worth timing, and a
 * "fastest 5 km" on a yoga mat is noise in a records table.
 */
export function splitDistancesFor(sport) {
  return SPLITS[familyOf(sport)] ?? null;
}

/**
 * Reindex streams onto an exact one-sample-per-second timeline.
 *
 * Devices use "smart recording" with variable sample intervals, so a raw
 * 300-element window is not 300 seconds. Every calculation below assumes exact
 * seconds, so normalise once here rather than complicating each of them.
 *
 * @returns {{n:number, channels:Record<string,Float64Array>}|null}
 */
export function resampleToSeconds(streams) {
  const t = streams?.t;
  if (!Array.isArray(t) || t.length < 2) return null;

  let last = -Infinity;
  for (const v of t) if (Number.isFinite(v) && v > last) last = v;
  const n = Math.floor(last) + 1;
  if (!Number.isFinite(n) || n < 2 || n > 24 * 3600 * 2) return null; // sanity cap: 48 h

  const names = ['lat', 'lng', 'alt', 'hr', 'cad', 'power', 'speed', 'dist', 'temp'];
  const channels = {};
  for (const name of names) {
    if (Array.isArray(streams[name])) channels[name] = new Float64Array(n).fill(NaN);
  }

  // Place each sample at its second, then forward-fill the gaps so a 5-second
  // recording interval does not read as four seconds of missing data.
  for (let i = 0; i < t.length; i++) {
    const sec = Math.round(t[i]);
    if (!Number.isFinite(sec) || sec < 0 || sec >= n) continue;
    for (const name of Object.keys(channels)) {
      const v = streams[name][i];
      if (Number.isFinite(v)) channels[name][sec] = v;
    }
  }

  for (const name of Object.keys(channels)) {
    const arr = channels[name];
    let carry = NaN;
    let gap = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(arr[i])) { carry = arr[i]; gap = 0; continue; }
      // Only bridge short gaps. A five-minute hole is a paused recording, and
      // holding the last heart rate across it would invent training load.
      if (Number.isFinite(carry) && gap < 30) { arr[i] = carry; gap++; }
      else { gap++; }
    }
  }

  return { n, channels };
}

/**
 * Mean-maximal value for each duration: the highest average sustained over any
 * window of that length. Uses a prefix sum so the whole curve costs one pass per
 * duration rather than a nested scan.
 *
 * Gaps (NaN) are treated as zero for power — coasting is genuinely zero watts —
 * but a window is rejected if it is mostly missing data.
 */
export function meanMaxCurve(series, n, durations = PEAK_DURATIONS, { treatGapsAsZero = true } = {}) {
  if (!series || n < 1) return [];

  const prefix = new Float64Array(n + 1);
  const validPrefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = series[i];
    const ok = Number.isFinite(v);
    prefix[i + 1] = prefix[i] + (ok ? v : 0);
    validPrefix[i + 1] = validPrefix[i] + (ok ? 1 : 0);
  }

  const out = [];
  for (const d of durations) {
    const window = Math.round(d);
    if (window < 1 || window > n) continue;

    let best = -Infinity;
    let bestIdx = -1;
    for (let start = 0; start + window <= n; start++) {
      const end = start + window;
      const valid = validPrefix[end] - validPrefix[start];
      // Require most of the window to be real readings.
      if (valid < window * 0.5) continue;
      const sum = prefix[end] - prefix[start];
      const mean = treatGapsAsZero ? sum / window : sum / valid;
      if (mean > best) { best = mean; bestIdx = start; }
    }

    if (bestIdx >= 0 && Number.isFinite(best) && best > 0) {
      out.push({ bucket: d, value: best, startIdx: bestIdx });
    }
  }
  return out;
}

/**
 * Fastest time to cover each distance, via a two-pointer sweep over cumulative
 * distance. O(n) per distance rather than checking every pair of points.
 */
export function fastestSplits(distSeries, n, distances = SPLITS.run) {
  if (!distSeries || n < 2) return [];

  // Forward-fill and enforce monotonicity: a GPS glitch that momentarily reduces
  // cumulative distance would otherwise let the sweep report an impossible split.
  const dist = new Float64Array(n);
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const v = distSeries[i];
    if (Number.isFinite(v) && v >= carry) carry = v;
    dist[i] = carry;
  }

  const total = dist[n - 1];
  const out = [];

  for (const target of distances) {
    if (!(total >= target)) continue;

    let best = Infinity;
    let bestStart = -1;
    let start = 0;
    for (let end = 0; end < n; end++) {
      // Pull `start` forward as long as the window still covers the distance.
      while (start < end && dist[end] - dist[start + 1] >= target) start++;
      if (dist[end] - dist[start] >= target) {
        const elapsed = end - start;
        if (elapsed > 0 && elapsed < best) { best = elapsed; bestStart = start; }
      }
    }

    if (Number.isFinite(best) && bestStart >= 0) {
      out.push({ bucket: target, value: best, startIdx: bestStart });
    }
  }
  return out;
}

/**
 * Compute every best-effort record for one activity.
 * @returns {Array<{kind:string, bucket:number, value:number, startIdx:number}>}
 */
export function computeBestEfforts(act) {
  const resampled = resampleToSeconds(act.streams);
  if (!resampled) return [];
  const { n, channels } = resampled;

  const efforts = [];

  if (channels.power) {
    for (const e of meanMaxCurve(channels.power, n)) {
      efforts.push({ kind: 'peak_power', ...e });
    }
  }

  if (channels.hr) {
    // Heart rate has no meaningful zero, so gaps must not be averaged in as 0.
    for (const e of meanMaxCurve(channels.hr, n, PEAK_DURATIONS, { treatGapsAsZero: false })) {
      efforts.push({ kind: 'peak_hr', ...e });
    }
  }

  // Fastest splits only make sense where distance was actually travelled, and only
  // over the distances this sport is measured in.
  const distances = splitDistancesFor(act.sport);
  if (channels.dist && !act.trainer && distances) {
    for (const e of fastestSplits(channels.dist, n, distances)) {
      efforts.push({ kind: 'fastest_distance', ...e });
    }
  }

  return efforts;
}

// ─── VO2max / VDOT ────────────────────────────────────────────────────────────

/**
 * Daniels & Gilbert VDOT: a pseudo-VO2max that folds in running economy, derived
 * from a race-effort distance and time.
 *
 * VO2 required at velocity v (m/min):  −4.60 + 0.182258·v + 0.000104·v²
 * Fraction of VO2max sustainable for t minutes:
 *   0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t)
 *
 * @param {number} distanceM
 * @param {number} timeS
 * @returns {number|null}
 */
export function vdot(distanceM, timeS) {
  if (!(distanceM > 0) || !(timeS > 0)) return null;
  const minutes = timeS / 60;
  // Outside roughly 3–90 minutes the sustainable-fraction curve is extrapolating.
  if (minutes < 2 || minutes > 240) return null;

  const v = distanceM / minutes;
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  const pct = 0.8
    + 0.1894393 * Math.exp(-0.012778 * minutes)
    + 0.2989558 * Math.exp(-0.1932605 * minutes);

  if (!(pct > 0)) return null;
  const result = vo2 / pct;
  return result > 20 && result < 90 ? result : null;
}

/** Invert the VO2-at-velocity relation: what speed does a given VO2 demand? */
export function speedForVo2(vo2Target) {
  const a = 0.000104;
  const b = 0.182258;
  const c = -(4.60 + vo2Target);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const vMinute = (-b + Math.sqrt(disc)) / (2 * a); // m/min
  return vMinute > 0 ? vMinute / 60 : null;         // m/s
}

/**
 * Threshold running speed implied by a VDOT.
 * Daniels puts threshold ("T") effort at ~88% of VO2max — the intensity you could
 * hold for about an hour.
 */
export function thresholdSpeedFromVdot(vdotValue) {
  if (!(vdotValue > 0)) return null;
  return speedForVo2(vdotValue * 0.88);
}

/**
 * VO2max from a cycling FTP.
 * FTP sits near 75% of maximal aerobic power, and MAP maps to VO2max through the
 * ACSM cycling economy relation (~10.8 mL/kg/min per W/kg, plus resting cost).
 */
export function vo2maxFromFtp(ftpWatts, weightKg) {
  if (!(ftpWatts > 0) || !(weightKg > 0)) return null;
  const map = ftpWatts / 0.75;
  const vo2 = (10.8 * map) / weightKg + 7;
  return vo2 > 20 && vo2 < 95 ? vo2 : null;
}

/**
 * Uth–Sørensen–Overgaard–Pedersen estimate: VO2max ≈ 15.3 × HRmax/HRrest.
 * Crude, but it is the only option for an athlete with heart rate and nothing
 * else, and it tracks changes in resting HR sensibly.
 */
export function vo2maxFromHeartRate(maxHr, restingHr) {
  if (!(maxHr > 0) || !(restingHr > 0) || maxHr <= restingHr) return null;
  const vo2 = 15.3 * (maxHr / restingHr);
  return vo2 > 20 && vo2 < 95 ? vo2 : null;
}
