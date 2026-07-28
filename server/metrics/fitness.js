// Fitness, fatigue and form.
//
// ── Fitness / fatigue / form ──
// Banister's impulse–response model: every session leaves a slow-decaying
// positive "fitness" trace and a fast-decaying negative "fatigue" one. Both are
// exponentially weighted moving averages of daily training load, with 42-day and
// 7-day time constants respectively.
//
//   CTL_today = CTL_yesterday + (load_today − CTL_yesterday) × (1 − e^(−1/42))
//   ATL_today = ATL_yesterday + (load_today − ATL_yesterday) × (1 − e^(−1/7))
//   TSB       = CTL_yesterday − ATL_yesterday
//
// TSB deliberately uses *yesterday's* values: form is what you woke up with, and
// including today's session would mean a hard morning workout instantly reporting
// poor form, which is backwards.
//
// There is deliberately no readiness score here. A meaningful one needs sleep and
// heart-rate variability, which only come from health-tracker data that Fitberg does
// not collect. Fitness, fatigue and form need nothing but your activity files, and
// are honest about what they measure.

const CTL_DAYS = 42;
const ATL_DAYS = 7;
const CTL_ALPHA = 1 - Math.exp(-1 / CTL_DAYS);
const ATL_ALPHA = 1 - Math.exp(-1 / ATL_DAYS);

/**
 * Walk a contiguous day series and produce the fitness curves.
 *
 * @param {Array<{day:string, load:number}>} series  ascending, one entry per day,
 *        including zero-load rest days (gaps would make the decay wrong)
 * @param {{ctl?:number, atl?:number}} [seed]  carry-in state
 * @returns {Array<object>} same length as `series`, with ctl/atl/tsb/monotony/strain/rampRate
 */
export function computeFitnessSeries(series, seed = {}) {
  let ctl = seed.ctl ?? 0;
  let atl = seed.atl ?? 0;
  const out = [];

  for (let i = 0; i < series.length; i++) {
    const load = Number.isFinite(series[i].load) ? series[i].load : 0;

    // Form reflects the state you started the day in.
    const tsb = ctl - atl;

    ctl += (load - ctl) * CTL_ALPHA;
    atl += (load - atl) * ATL_ALPHA;

    // Foster monotony/strain: training that is relentlessly the same every day
    // carries more injury and illness risk than the same volume with variation.
    const window = [];
    for (let j = Math.max(0, i - 6); j <= i; j++) {
      window.push(Number.isFinite(series[j].load) ? series[j].load : 0);
    }
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const sd = Math.sqrt(variance);
    // With no variation at all monotony is undefined; report null rather than Infinity.
    const monotony = sd > 0.01 ? mean / sd : (mean > 0 ? null : 0);
    const strain = monotony === null ? null : window.reduce((a, b) => a + b, 0) * monotony;

    const rampRate = out.length >= 7 ? ctl - out[out.length - 7].ctl : null;

    out.push({
      day: series[i].day,
      load,
      ctl,
      atl,
      tsb,
      monotony,
      strain,
      rampRate,
    });
  }

  return out;
}

/** Plain-language reading of a form value. */
export function interpretForm(tsb) {
  if (tsb === null || tsb === undefined) return { label: 'Unknown', tone: 'neutral' };
  if (tsb > 25) return { label: 'Very fresh', tone: 'caution', note: 'Detraining risk if this persists' };
  if (tsb > 5) return { label: 'Fresh', tone: 'good', note: 'Race-ready' };
  if (tsb > -10) return { label: 'Neutral', tone: 'neutral', note: 'Maintaining' };
  if (tsb > -30) return { label: 'Building', tone: 'good', note: 'Productive training' };
  return { label: 'Overreaching', tone: 'warn', note: 'High fatigue — recovery needed soon' };
}

/** Inclusive list of YYYY-MM-DD strings, so the EWMA sees rest days explicitly. */
export function dayRange(fromDay, toDay) {
  const days = [];
  let t = new Date(`${fromDay}T00:00:00Z`).getTime();
  const end = new Date(`${toDay}T00:00:00Z`).getTime();
  while (t <= end) {
    days.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return days;
}

/** Local calendar day for an activity, honouring the recorded UTC offset. */
export function localDayOf(startTimeMs, utcOffsetS = 0) {
  return new Date(startTimeMs + (utcOffsetS || 0) * 1000).toISOString().slice(0, 10);
}
