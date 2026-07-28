// Geo helpers: distance, encoded polylines, bounding boxes, grade smoothing.

const EARTH_R = 6371008.8; // metres, mean radius (WGS84)
const DEG = Math.PI / 180;

/** Great-circle distance in metres between two lat/lng pairs. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** FIT stores coordinates as semicircles: degrees = value * 180 / 2^31. */
export function semicirclesToDegrees(v) {
  if (v === null || v === undefined) return null;
  return (v * 180) / 2147483648;
}

/**
 * Google encoded polyline, precision 5 (~1.1 m). Used for list/overview maps;
 * the full-resolution track always comes from the lat/lng streams.
 */
export function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';

  for (const [lat, lng] of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeSigned(iLat - lastLat) + encodeSigned(iLng - lastLng);
    lastLat = iLat;
    lastLng = iLng;
  }
  return out;
}

function encodeSigned(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function decodePolyline(str) {
  const points = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    let shift = 0;
    let result = 0;
    let b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Reduce a track to at most `maxPoints` using Ramer–Douglas–Peucker, so the
 * overview polyline of a 30 000-point ultra stays a few KB without visibly
 * changing shape.
 */
export function simplifyTrack(points, maxPoints = 900) {
  const clean = points.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (clean.length <= maxPoints) return clean;

  // Binary-search a tolerance that lands near the target point count, rather
  // than guessing one that behaves differently for a 5k and an alpine tour.
  let lo = 1e-7;
  let hi = 0.01;
  let best = clean;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const simplified = rdp(clean, mid);
    if (simplified.length > maxPoints) {
      lo = mid;
    } else {
      best = simplified;
      hi = mid;
    }
    if (hi - lo < 1e-9) break;
  }
  return best;
}

function rdp(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function perpDistance(p, a, b) {
  const x = p[1]; const y = p[0];
  const x1 = a[1]; const y1 = a[0];
  const x2 = b[1]; const y2 = b[0];
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + tc * dx), y - (y1 + tc * dy));
}

export function boundingBox(points) {
  let minLat = Infinity; let minLng = Infinity;
  let maxLat = -Infinity; let maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, minLng, maxLat, maxLng };
}

/**
 * Cumulative elevation gain/loss with a threshold, because raw barometric and
 * especially GPS altitude noise otherwise inflates gain enormously — a flat
 * 10 km run can report 200 m of "climbing" from sample jitter alone.
 */
export function elevationChange(altitudes, { threshold = 1.5 } = {}) {
  let gain = 0;
  let loss = 0;
  let anchor = null;
  let min = Infinity;
  let max = -Infinity;

  for (const raw of altitudes) {
    if (!Number.isFinite(raw)) continue;
    if (raw < min) min = raw;
    if (raw > max) max = raw;
    if (anchor === null) { anchor = raw; continue; }
    const delta = raw - anchor;
    if (delta >= threshold) { gain += delta; anchor = raw; }
    else if (delta <= -threshold) { loss += -delta; anchor = raw; }
  }

  return {
    gain,
    loss,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  };
}
