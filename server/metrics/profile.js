// The athlete profile: the handful of physiological numbers that every training
// metric depends on.
//
// The hard product constraint is that someone arriving with a folder of FIT files
// knows *none* of these. So every field that can be is estimated from their own files,
// and the UI shows which numbers were measured versus inferred. Nothing silently
// refuses to compute because a field is blank.
//
// Weight is the exception: it cannot be derived from an activity file, so it is
// whatever you type in, or nothing.

export const DEFAULT_PROFILE = {
  sex: null,              // 'm' | 'f' | null
  birthYear: null,
  heightCm: null,
  weightKg: null,

  maxHr: null,
  restingHr: null,
  lthr: null,             // lactate threshold HR — the anchor for hrTSS
  ftp: null,              // functional threshold power, W
  thresholdPaceMs: null,  // threshold running speed, m/s
  units: 'metric',
};

export function readProfile(settingsJson) {
  let parsed = {};
  try { parsed = settingsJson ? JSON.parse(settingsJson) : {}; } catch { parsed = {}; }
  return { ...DEFAULT_PROFILE, ...(parsed.profile || {}) };
}

export function ageFrom(profile, atMs = Date.now()) {
  if (!profile.birthYear) return null;
  return new Date(atMs).getUTCFullYear() - profile.birthYear;
}

/**
 * Fill in whatever the athlete has not told us, from their own history.
 *
 * @param {object} profile      explicit, user-entered values (always win)
 * @param {object} observed     aggregates from the database
 * @returns {{profile:object, estimated:Record<string,string>}}
 *          `estimated` maps field -> human explanation of where it came from.
 */
export function resolveProfile(profile, observed = {}) {
  const out = { ...DEFAULT_PROFILE, ...profile };
  const estimated = {};

  const age = ageFrom(out);

  if (!out.maxHr) {
    if (observed.maxHrObserved > 120) {
      out.maxHr = observed.maxHrObserved;
      estimated.maxHr = `highest heart rate recorded across your activities (${Math.round(observed.maxHrObserved)} bpm)`;
    } else if (age) {
      // Tanaka et al. 2001: 208 − 0.7·age. Better validated across ages than the
      // familiar 220 − age, which systematically underestimates for older adults.
      out.maxHr = Math.round(208 - 0.7 * age);
      estimated.maxHr = `age-predicted (Tanaka: 208 − 0.7 × ${age})`;
    } else {
      out.maxHr = 190;
      estimated.maxHr = 'generic default — set your age or record a hard effort to improve this';
    }
  }

  // Resting heart rate is NOT invented. It is almost never in a FIT file and cannot be
  // recovered from an activity — the lowest sample in a ride is a coasting descent, not a
  // resting rate. A made-up 60 bpm silently changed every heart-rate load figure, so it
  // is left null and the load model works without it.

  if (!out.lthr) {
    if (observed.bestHr60min > 100) {
      // Best sustainable hour of heart rate is a good practical proxy for
      // threshold HR — it is roughly what a 1-hour time trial elicits.
      out.lthr = Math.round(observed.bestHr60min);
      estimated.lthr = 'your highest sustained 60-minute average heart rate';
    } else {
      out.lthr = Math.round(out.maxHr * 0.9);
      estimated.lthr = `90% of max heart rate (${out.maxHr} bpm)`;
    }
  }

  if (!out.ftp) {
    if (observed.bestPower20min > 50) {
      out.ftp = Math.round(observed.bestPower20min * 0.95);
      estimated.ftp = `95% of your best 20-minute power (${Math.round(observed.bestPower20min)} W)`;
    } else if (observed.bestPower60min > 50) {
      out.ftp = Math.round(observed.bestPower60min);
      estimated.ftp = 'your best 60-minute average power';
    }
    // Leaving ftp null is fine: load falls back to heart rate.
  }

  if (!out.thresholdPaceMs && observed.thresholdPaceMs > 0) {
    out.thresholdPaceMs = observed.thresholdPaceMs;
    estimated.thresholdPaceMs = 'derived from your best recent race-effort pace';
  }

  return { profile: out, estimated };
}

/**
 * Five-zone heart-rate model anchored on threshold HR rather than max HR.
 * Percent-of-max zones misplace the aerobic/threshold boundary for anyone whose
 * threshold is not exactly 90% of max, which is most people.
 */
export function hrZones(profile) {
  const { lthr, restingHr, maxHr } = profile;
  if (!lthr) return null;
  const bound = (frac) => Math.round(restingHr + (lthr - restingHr) * frac);
  return [
    { zone: 1, name: 'Recovery',   min: restingHr,   max: bound(0.81) },
    { zone: 2, name: 'Aerobic',    min: bound(0.81), max: bound(0.89) },
    { zone: 3, name: 'Tempo',      min: bound(0.89), max: bound(0.95) },
    { zone: 4, name: 'Threshold',  min: bound(0.95), max: bound(1.02) },
    { zone: 5, name: 'VO2max',     min: bound(1.02), max: maxHr },
  ];
}

/** Coggan's seven power zones as fractions of FTP. */
export function powerZones(profile) {
  const { ftp } = profile;
  if (!ftp) return null;
  const zones = [
    { zone: 1, name: 'Active recovery', lo: 0,    hi: 0.55 },
    { zone: 2, name: 'Endurance',       lo: 0.55, hi: 0.75 },
    { zone: 3, name: 'Tempo',           lo: 0.75, hi: 0.90 },
    { zone: 4, name: 'Threshold',       lo: 0.90, hi: 1.05 },
    { zone: 5, name: 'VO2max',          lo: 1.05, hi: 1.20 },
    { zone: 6, name: 'Anaerobic',       lo: 1.20, hi: 1.50 },
    { zone: 7, name: 'Neuromuscular',   lo: 1.50, hi: Infinity },
  ];
  return zones.map((z) => ({
    ...z,
    min: Math.round(ftp * z.lo),
    max: Number.isFinite(z.hi) ? Math.round(ftp * z.hi) : null,
  }));
}

/** Pace zones from threshold speed, expressed as speeds in m/s. */
export function paceZones(profile) {
  const thr = profile.thresholdPaceMs;
  if (!thr) return null;
  // Fractions of threshold *speed* (not pace), slowest first.
  const zones = [
    { zone: 1, name: 'Easy',      lo: 0.00, hi: 0.78 },
    { zone: 2, name: 'Steady',    lo: 0.78, hi: 0.87 },
    { zone: 3, name: 'Tempo',     lo: 0.87, hi: 0.95 },
    { zone: 4, name: 'Threshold', lo: 0.95, hi: 1.03 },
    { zone: 5, name: 'Interval',  lo: 1.03, hi: Infinity },
  ];
  return zones.map((z) => ({
    ...z,
    minSpeedMs: thr * z.lo,
    maxSpeedMs: Number.isFinite(z.hi) ? thr * z.hi : null,
  }));
}
