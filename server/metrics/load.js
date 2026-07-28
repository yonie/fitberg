// Training load.
//
// Everything downstream — fitness, fatigue and form — is an exponential
// average of one number per activity. So this number has to be comparable across
// a power-meter ride, a heart-rate run and a pool swim with neither.
//
// The scale is TSS-like by construction: **one hour at threshold intensity = 100**,
// whichever signal we measured it with. That is what makes the four methods below
// interchangeable inside the same rolling average.
//
// Methods, in descending order of trustworthiness:
//   device → the head unit already computed TSS against its configured FTP
//   power  → normalized power against FTP
//   hr     → heart rate against threshold HR
//   pace   → grade-adjusted running pace against threshold pace
//   duration → last resort: duration scaled by RPE or a sport-typical intensity

import { familyOf } from '../parsers/sports.js';

/**
 * @param {object} act        canonical activity with streams
 * @param {object} profile    resolved athlete profile
 * @returns {{load:number, method:string, intensityFactor:number|null, detail:string}}
 */
export function computeLoad(act, profile) {
  const duration = act.movingS || act.elapsedS || 0;
  if (duration <= 0) return { load: 0, method: 'none', intensityFactor: null, detail: 'no duration' };

  // The device's own TSS is anchored on the FTP the athlete actually set on it.
  if (Number.isFinite(act.deviceTss) && act.deviceTss > 0) {
    return {
      load: act.deviceTss,
      method: 'device',
      intensityFactor: act.deviceIf ?? null,
      detail: 'training stress reported by the recording device',
    };
  }

  const power = fromPower(act, profile, duration);
  if (power) return power;

  const hr = fromHeartRate(act, profile);
  if (hr) return hr;

  const pace = fromPace(act, profile, duration);
  if (pace) return pace;

  return fromDuration(act, duration);
}

function fromPower(act, profile, duration) {
  const ftp = profile.ftp;
  const np = act.normalizedPower ?? act.avgPower;
  if (!ftp || !np || np <= 0) return null;

  const intensityFactor = np / ftp;
  // TSS = duration × IF² normalised so an hour at FTP scores 100.
  const load = (duration * intensityFactor * intensityFactor) / 3600 * 100;

  return {
    load,
    method: 'power',
    intensityFactor,
    detail: `normalized power ${Math.round(np)} W vs FTP ${Math.round(ftp)} W`,
  };
}

/**
 * Heart-rate load.
 *
 * Each sample's intensity is expressed as a fraction of the heart-rate reserve
 * *up to threshold*, then squared and integrated. Squaring matters: it makes
 * intensity cost disproportionately more than duration, matching how power-based
 * TSS behaves, so the two methods can share one rolling average.
 */
function fromHeartRate(act, profile) {
  const hrStream = act.streams?.hr;
  const { lthr, restingHr } = profile;
  if (!lthr) return null;

  // Two formulations, and which one is used depends on what is actually known.
  //
  // With a resting rate, intensity is measured against heart-rate reserve, which is the
  // better model. Without one it is measured against threshold alone — Coggan's hrTSS
  // does exactly this. What is NOT done is inventing a resting rate to make the first
  // formula available: that changes every load figure on a guess.
  const useReserve = Boolean(restingHr) && lthr > restingHr;
  const reserve = useReserve ? lthr - restingHr : lthr;
  const floor = useReserve ? restingHr : 0;

  // With a stream we can integrate properly.
  if (Array.isArray(hrStream) && hrStream.some((v) => Number.isFinite(v))) {
    const t = act.streams.t;
    let sum = 0;
    let counted = 0;

    for (let i = 0; i < hrStream.length; i++) {
      const hr = hrStream[i];
      if (!Number.isFinite(hr) || hr <= 0) continue;

      let dt = 1;
      if (Array.isArray(t) && i > 0 && Number.isFinite(t[i]) && Number.isFinite(t[i - 1])) {
        dt = t[i] - t[i - 1];
        // A large gap means the recording was paused, not that the athlete spent
        // 20 minutes at that heart rate.
        if (!Number.isFinite(dt) || dt <= 0 || dt > 30) dt = 1;
      }

      const ratio = Math.max(0, (hr - floor) / reserve);
      sum += ratio * ratio * dt;
      counted += dt;
    }

    if (counted > 60) {
      const load = (sum / 3600) * 100;
      return {
        load,
        method: 'hr',
        intensityFactor: Math.sqrt(sum / counted),
        detail: `heart rate integrated against threshold ${Math.round(lthr)} bpm`,
      };
    }
  }

  // Summary-only fallback: a file with a session summary but no samples.
  if (Number.isFinite(act.avgHr) && act.avgHr > 0) {
    const duration = act.movingS || act.elapsedS;
    const ratio = Math.max(0, (act.avgHr - floor) / reserve);
    const load = (duration * ratio * ratio) / 3600 * 100;
    return {
      load,
      method: 'hr',
      intensityFactor: ratio,
      detail: `average heart rate ${Math.round(act.avgHr)} bpm vs threshold ${Math.round(lthr)} bpm`,
    };
  }

  return null;
}

/**
 * Grade-adjusted running load.
 *
 * Raw pace punishes hill runs and flatters descents, so speed is converted to the
 * equivalent flat speed using Minetti's measured energy cost of graded running
 * before comparing against threshold pace.
 */
function fromPace(act, profile, duration) {
  if (familyOf(act.sport) !== 'run') return null;
  const thr = profile.thresholdPaceMs;
  if (!thr || thr <= 0) return null;

  const speed = act.streams?.speed;
  const alt = act.streams?.alt;
  const dist = act.streams?.dist;
  const t = act.streams?.t;

  let ngp = null;

  if (Array.isArray(speed) && speed.some((v) => Number.isFinite(v) && v > 0)) {
    // Grade-adjust each sample, smooth over 30 s, then normalise the same way
    // normalized power does, so surging on hills is not rewarded.
    const adjusted = new Array(speed.length).fill(NaN);
    for (let i = 0; i < speed.length; i++) {
      const v = speed[i];
      if (!Number.isFinite(v) || v <= 0) { adjusted[i] = 0; continue; }
      adjusted[i] = v * gradeAdjustFactor(gradeAt(alt, dist, t, i));
    }
    ngp = normalise(adjusted, 30);
  } else if (Number.isFinite(act.avgSpeedMs) && act.avgSpeedMs > 0) {
    ngp = act.avgSpeedMs;
  }

  if (!ngp || ngp <= 0) return null;

  const intensityFactor = ngp / thr;
  const load = (duration * intensityFactor * intensityFactor) / 3600 * 100;

  return {
    load,
    method: 'pace',
    intensityFactor,
    detail: `grade-adjusted pace ${paceLabel(ngp)} vs threshold ${paceLabel(thr)}`,
  };
}

/**
 * Minetti et al. (2002), the measured metabolic cost of running on a gradient,
 * in J/kg/m. Normalising by the level-ground cost gives the multiplier that turns
 * an uphill metre into its flat-ground equivalent.
 */
export function gradeAdjustFactor(grade) {
  if (!Number.isFinite(grade)) return 1;
  // Beyond ±45% people walk, and the polynomial stops behaving.
  const i = Math.max(-0.45, Math.min(0.45, grade));
  const cost = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  const level = 3.6;
  return Math.max(0.5, cost / level);
}

function gradeAt(alt, dist, t, i) {
  if (!Array.isArray(alt) || i < 1) return 0;
  // Look back ~10 samples: consecutive-sample grade is dominated by altimeter
  // noise and produces wild multipliers.
  const j = Math.max(0, i - 10);
  const dAlt = alt[i] - alt[j];
  let dDist = null;
  if (Array.isArray(dist) && Number.isFinite(dist[i]) && Number.isFinite(dist[j])) {
    dDist = dist[i] - dist[j];
  }
  if (!Number.isFinite(dAlt) || !Number.isFinite(dDist) || dDist < 1) return 0;
  return dAlt / dDist;
}

/** Rolling-average then quartic-mean normalisation, as used for normalized power. */
function normalise(values, window) {
  const rolling = [];
  let sum = 0;
  const queue = [];
  for (const raw of values) {
    const v = Number.isFinite(raw) ? raw : 0;
    queue.push(v); sum += v;
    if (queue.length > window) sum -= queue.shift();
    if (queue.length === window) rolling.push(sum / window);
  }
  if (!rolling.length) {
    const clean = values.filter((v) => Number.isFinite(v) && v > 0);
    return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
  }
  let quartic = 0;
  for (const v of rolling) quartic += v ** 4;
  return (quartic / rolling.length) ** 0.25;
}

/**
 * Load from duration — only when the athlete supplied an RPE.
 *
 * There used to be a table of "typical" intensity factors per sport here, so that an
 * activity with no power, no heart rate and no GPS still produced a number. That number
 * was invented, and it fed straight into fitness and form: an hour of anything scored
 * the same whether it was a walk to the shops or a hill session. Better to have no load
 * than a fabricated one. Set an RPE on the activity and it becomes computable.
 */
function fromDuration(act, duration) {
  if (!Number.isFinite(act.perceivedExertion) || act.perceivedExertion <= 0) {
    return {
      load: null,
      method: 'none',
      intensityFactor: null,
      detail: 'no power, heart rate or GPS in the file — set an RPE to give this a load',
    };
  }

  // RPE 10 ≈ threshold-and-above; map 1..10 onto 0.35..1.05.
  const intensityFactor = 0.35 + (Math.min(10, act.perceivedExertion) / 10) * 0.7;
  const load = (duration * intensityFactor * intensityFactor) / 3600 * 100;
  return {
    load,
    method: 'rpe',
    intensityFactor,
    detail: `from duration and your RPE of ${act.perceivedExertion}/10`,
  };
}

/**
 * Aerobic decoupling (Pw:Hr): how much the output-per-heartbeat drifts from the
 * first half of an activity to the second. Under ~5% indicates solid aerobic
 * durability at that intensity; a large positive number means you were fading.
 */
export function computeDecoupling(act) {
  const s = act.streams || {};
  const hr = s.hr;
  if (!Array.isArray(hr)) return null;
  const output = Array.isArray(s.power) ? s.power : s.speed;
  if (!Array.isArray(output)) return null;

  const n = Math.min(hr.length, output.length);
  if (n < 600) return null; // under 10 minutes the halves are too noisy to compare

  const half = Math.floor(n / 2);
  const ratio = (from, to) => {
    let sumOut = 0; let sumHr = 0; let count = 0;
    for (let i = from; i < to; i++) {
      const o = output[i]; const h = hr[i];
      if (!Number.isFinite(o) || !Number.isFinite(h) || h <= 0 || o <= 0) continue;
      sumOut += o; sumHr += h; count++;
    }
    if (count < 60) return null;
    return (sumOut / count) / (sumHr / count);
  };

  const first = ratio(0, half);
  const second = ratio(half, n);
  if (first === null || second === null || first === 0) return null;

  // Positive = efficiency dropped over the activity.
  return ((first - second) / first) * 100;
}

/** Efficiency factor: normalized output per heartbeat. Rises as fitness improves. */
export function computeEfficiencyFactor(act) {
  const output = act.normalizedPower ?? act.avgPower ?? act.avgSpeedMs;
  if (!Number.isFinite(output) || !Number.isFinite(act.avgHr) || act.avgHr <= 0) return null;
  return output / act.avgHr;
}

/** Share of moving time spent below threshold — the classic polarisation check. */
export function computeAerobicShare(act, profile) {
  const hr = act.streams?.hr;
  if (!Array.isArray(hr) || !profile.lthr) return null;
  let below = 0; let total = 0;
  for (const v of hr) {
    if (!Number.isFinite(v) || v <= 0) continue;
    total++;
    if (v < profile.lthr * 0.95) below++;
  }
  return total > 60 ? (below / total) * 100 : null;
}

const paceLabel = (speedMs) => {
  if (!speedMs || speedMs <= 0) return '—';
  const secPerKm = 1000 / speedMs;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
};
