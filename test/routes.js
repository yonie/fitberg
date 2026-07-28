// Plausible GPS routes for synthetic activities.
//
// The seed used to walk due north in a straight line — fine for asserting a distance,
// useless for anything you look at. The obvious replacement, integrating a randomly
// wandering heading, is worse than it sounds: over a three-hour ride the heading noise
// accumulates and the track comes out as a scribble of overlapping loops. Nobody's ride
// looks like that.
//
// So the shape is built directly instead. A closed loop is a circle deformed by a few
// low-frequency harmonics, then resampled at constant speed along its own arc length.
// That gives a smooth loop that leaves home and comes back, has long sweeping bends, and
// crosses itself rarely — which is what a local loop actually looks like.
//
// Deterministic: same seed, same route. A screenshot taken today can be taken again.

const EARTH_M_PER_DEG_LAT = 111320;

/** Small deterministic PRNG so a route is reproducible from its seed. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A closed loop of `n` one-second samples covering `n * speed` metres.
 *
 * @param {object} opts
 * @param {number} opts.n         samples (seconds)
 * @param {number} opts.speed     metres per second
 * @param {number} [opts.startLat]
 * @param {number} [opts.startLng]
 * @param {number} [opts.seed]
 * @param {number} [opts.climbM]  total ascent to distribute over the route
 */
export function loopRoute({
  n, speed, distances = null, startLat = 45.9, startLng = 6.13, seed = 1, climbM = 60,
}) {
  const random = rng(seed);
  const metresPerDegLng = EARTH_M_PER_DEG_LAT * Math.cos((startLat * Math.PI) / 180);

  // Either a constant speed, or a cumulative-distance series when the pace varies.
  // The variable case matters more than it sounds: with a constant speed every split
  // from 400 m to a half marathon comes out at exactly the same pace, and the records
  // table reads as obviously fake.
  const cumulativeWanted = distances ?? Array.from({ length: n }, (_, i) => i * speed);
  const targetLength = cumulativeWanted[cumulativeWanted.length - 1] || n * (speed || 1);

  // Three harmonics with small amplitudes: enough to stop it being a circle, not enough
  // to fold the curve back through itself. Amplitudes sum to well under 1 so the radius
  // never approaches zero.
  const harmonics = [2, 3, 5].map((k) => ({
    k,
    amp: 0.10 + random() * 0.14,
    phase: random() * 2 * Math.PI,
  }));
  const radiusAt = (theta) => 1 + harmonics
    .reduce((sum, h) => sum + h.amp * Math.sin(h.k * theta + h.phase), 0);

  // Walk the curve finely once to measure it, then scale so its length is the distance
  // the activity actually covered.
  const STEPS = 4000;
  const raw = [];
  let perimeter = 0;
  let prev = null;
  for (let i = 0; i <= STEPS; i++) {
    const theta = (i / STEPS) * 2 * Math.PI;
    const r = radiusAt(theta);
    const point = { x: r * Math.cos(theta), y: r * Math.sin(theta) };
    if (prev) perimeter += Math.hypot(point.x - prev.x, point.y - prev.y);
    raw.push(point);
    prev = point;
  }
  const scale = targetLength / perimeter;

  // Cumulative arc length in metres, so samples can be placed at equal spacing.
  const cumulative = [0];
  for (let i = 1; i < raw.length; i++) {
    cumulative.push(cumulative[i - 1]
      + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y) * scale);
  }

  const origin = raw[0];
  const out = [];
  let cursor = 0;

  for (let i = 0; i < n; i++) {
    const wanted = cumulativeWanted[i];
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < wanted) cursor++;

    // Linear interpolation between the two curve samples that straddle this distance.
    const span = cumulative[cursor + 1] - cumulative[cursor];
    const frac = span > 0 ? (wanted - cumulative[cursor]) / span : 0;
    const a = raw[cursor];
    const b = raw[cursor + 1];
    const x = (a.x + (b.x - a.x) * frac - origin.x) * scale;
    const y = (a.y + (b.y - a.y) * frac - origin.y) * scale;

    // Elevation: one long climb and descent with shorter rollers on top, so the profile
    // and the 3D view both have something to show.
    const phase = i / n;
    const alt = 420
      + (climbM / 2) * (1 - Math.cos(2 * Math.PI * phase))
      + (climbM / 8) * Math.sin(2 * Math.PI * phase * 6);

    out.push({
      lat: startLat + y / EARTH_M_PER_DEG_LAT,
      lng: startLng + x / metresPerDegLng,
      alt,
      dist: wanted,
    });
  }

  return out;
}

/**
 * An out-and-back, for long sessions where a loop would be implausibly large.
 * Turns around at halfway and retraces, which is what people actually do.
 */
export function outAndBack(opts) {
  const half = Math.max(2, Math.floor(opts.n / 2));
  // Half the samples cover half the distance, so the outbound leg is generated at the
  // full speed over half the time.
  const outbound = loopRoute({ ...opts, n: half });
  const total = outbound[outbound.length - 1].dist;

  const back = [];
  for (let i = outbound.length - 2; i >= 0; i--) {
    const point = outbound[i];
    back.push({
      lat: point.lat,
      lng: point.lng,
      alt: point.alt,
      dist: total + (total - point.dist),
    });
  }

  return [...outbound, ...back].slice(0, opts.n);
}
