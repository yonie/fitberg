// Synthetic FIT fixtures.
//
// Generated with Garmin's own encoder rather than checked in as sample files, so the
// tests can assert on exact expected values — a known distance at a known pace with
// known heart rate. That makes a parser regression obvious instead of subtle.

import { Encoder, Profile, Utils } from '@garmin/fitsdk';

export const BASE_TIME = Date.UTC(2026, 2, 14, 8, 0, 0); // 2026-03-14T08:00:00Z

/**
 * A synthetic outdoor run: `n` samples at 1 Hz heading north from Amsterdam,
 * 3.0 m/s, HR ramping 130 -> 165, cadence ~168 spm, gentle 20 m climb.
 */
export function syntheticRun({
  n = 600, startLat = 52.3702, startLng = 4.8952, speed = 3.0, startMs = BASE_TIME,
} = {}) {
  const samples = [];
  const metresPerDegLat = 111320;
  for (let i = 0; i < n; i++) {
    samples.push({
      t: i,
      timestamp: new Date(startMs + i * 1000),
      lat: startLat + (i * speed) / metresPerDegLat,
      lng: startLng,
      alt: 5 + 20 * Math.sin((Math.PI * i) / n),
      hr: Math.round(130 + (35 * i) / n),
      cad: 84 + (i % 3),          // half-steps, as FIT stores for running
      // A base sawtooth plus a deliberate 60-second surge just after the start.
      // The surge matters for the best-effort tests: without a real hard effort
      // the power is perfectly periodic (period 40), and a mean-max window that
      // is an exact multiple of the period gets pinned to the series mean while a
      // non-multiple window can average slightly higher. That makes the power
      // curve non-monotonic in a way real power data never is.
      power: 240 + ((i * 7) % 40) + (i >= 5 && i < 65 ? 80 : 0),
      speed,
      dist: i * speed,
      temp: 12,
    });
  }
  return samples;
}

/**
 * Encode samples as a real FIT activity file (bytes), as a watch would.
 *
 * By default the session summary carries fixed values, so the parser tests can
 * assert on exact numbers. Pass `deriveSummary: true` to compute the summary from
 * the samples instead — which is what the seed script wants, since a whole
 * training history where every session reports an average of 147 bpm is useless
 * for looking at charts.
 */
export function makeFit(samples, {
  sport = 'running', subSport = 'generic', withSession = true, deriveSummary = false,
} = {}) {
  const encoder = new Encoder();
  const start = samples[0].timestamp;
  const end = samples[samples.length - 1].timestamp;
  const totalDistance = samples[samples.length - 1].dist;
  const elapsed = (end.getTime() - start.getTime()) / 1000;

  const mean = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => Number.isFinite(v) && v > 0);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const peak = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
    return values.length ? Math.max(...values) : null;
  };

  // Ascent from the samples, so a hilly route does not report the fixed 20 m below.
  const ascent = (() => {
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = (samples[i].alt ?? 0) - (samples[i - 1].alt ?? 0);
      if (d > 0) gain += d; else loss -= d;
    }
    return { gain: Math.round(gain), loss: Math.round(loss) };
  })();

  const summary = deriveSummary
    ? {
      avgHeartRate: Math.round(mean('hr') ?? 0) || null,
      maxHeartRate: Math.round(peak('hr') ?? 0) || null,
      avgCadence: Math.round(mean('cad') ?? 0) || null,
      maxCadence: Math.round(peak('cad') ?? 0) || null,
      avgPower: Math.round(mean('power') ?? 0) || null,
      maxPower: Math.round(peak('power') ?? 0) || null,
      avgSpeed: elapsed > 0 ? totalDistance / elapsed : null,
      maxSpeed: peak('speed'),
      totalCalories: Math.round((elapsed / 60) * 11),
    }
    : {
      avgHeartRate: 147, maxHeartRate: 165,
      avgCadence: 84, maxCadence: 86,
      avgPower: 259, maxPower: 279,
      avgSpeed: 3.0, maxSpeed: 3.2,
      totalCalories: 420,
    };

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'activity',
    // FIT enum values are camelCase in the SDK's string form.
    manufacturer: 'wahooFitness',
    product: 31,
    timeCreated: start,
    serialNumber: 987654321,
  });

  for (const s of samples) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: s.timestamp,
      // FIT stores coordinates as semicircles.
      positionLat: Math.round((s.lat * 2147483648) / 180),
      positionLong: Math.round((s.lng * 2147483648) / 180),
      altitude: s.alt,
      heartRate: s.hr,
      cadence: s.cad,
      power: s.power,
      speed: s.speed,
      distance: s.dist,
      temperature: s.temp,
    });
  }

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.LAP,
    timestamp: end,
    startTime: start,
    totalElapsedTime: elapsed,
    totalTimerTime: elapsed,
    totalDistance,
    avgHeartRate: summary.avgHeartRate,
    maxHeartRate: summary.maxHeartRate,
  });

  if (withSession) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.SESSION,
      timestamp: end,
      startTime: start,
      sport,
      subSport,
      totalElapsedTime: elapsed,
      totalTimerTime: elapsed,
      totalDistance,
      totalAscent: deriveSummary ? ascent.gain : 20,
      totalDescent: deriveSummary ? ascent.loss : 20,
      ...summary,
    });
  }

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.ACTIVITY,
    timestamp: end,
    // +1h local offset, so the parser should derive utcOffsetS === 3600.
    // `localTimestamp` is a FIT localDateTime, which the encoder wants as a raw
    // FIT timestamp rather than a Date.
    localTimestamp: Utils.convertDateToDateTime(new Date(end.getTime() + 3600 * 1000)),
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });

  return Buffer.from(encoder.close());
}
