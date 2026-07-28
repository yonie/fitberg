// Formatting helpers. Every number the user sees passes through here, so units and
// rounding stay consistent across the app.

export function km(metres: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(metres as number)) return '—';
  return `${((metres as number) / 1000).toFixed(digits)}`;
}

export function distance(metres: number | null | undefined): string {
  if (!Number.isFinite(metres as number) || (metres as number) <= 0) return '—';
  const m = metres as number;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function duration(seconds: number | null | undefined, style: 'short' | 'clock' = 'short'): string {
  if (!Number.isFinite(seconds as number) || (seconds as number) < 0) return '—';
  const total = Math.round(seconds as number);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (style === 'clock') {
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Running pace, in minutes per kilometre. */
export function pace(speedMs: number | null | undefined): string {
  if (!Number.isFinite(speedMs as number) || (speedMs as number) <= 0) return '—';
  const secPerKm = 1000 / (speedMs as number);
  // Above ~40 min/km the value is noise from a stopped recording.
  if (secPerKm > 2400) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function speedKmh(speedMs: number | null | undefined): string {
  if (!Number.isFinite(speedMs as number) || (speedMs as number) <= 0) return '—';
  return ((speedMs as number) * 3.6).toFixed(1);
}

/** Pace for runs and walks, speed for everything else — what each sport reads in. */
export function paceOrSpeed(speedMs: number | null | undefined, sport: string): { value: string; unit: string } {
  const isPaceSport = /run|walk|hike|swim/.test(sport);
  if (isPaceSport) {
    return sport.includes('swim')
      ? { value: pace100m(speedMs), unit: '/100m' }
      : { value: pace(speedMs), unit: '/km' };
  }
  return { value: speedKmh(speedMs), unit: 'km/h' };
}

export function pace100m(speedMs: number | null | undefined): string {
  if (!Number.isFinite(speedMs as number) || (speedMs as number) <= 0) return '—';
  const sec = 100 / (speedMs as number);
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function number(value: number | null | undefined, digits = 0): string {
  if (!Number.isFinite(value as number)) return '—';
  return (value as number).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function bytes(n: number | null | undefined): string {
  if (!Number.isFinite(n as number)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n as number;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * Render an activity's timestamp in the timezone it was recorded in.
 * A 06:00 run in Amsterdam should read 06:00 to the athlete no matter where they
 * are looking at it from, so the stored UTC offset is applied rather than the
 * browser's own.
 */
export function localDateTime(startTime: number, utcOffsetS = 0): Date {
  return new Date(startTime + utcOffsetS * 1000);
}

export function dateLabel(startTime: number, utcOffsetS = 0): string {
  const d = localDateTime(startTime, utcOffsetS);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * A compact date for dense rows: "Sat 25 Jul", with the year only when it is not
 * the current one. The full label truncates in a list row, which loses the time
 * entirely — the least useful thing to drop.
 */
export function shortDateLabel(startTime: number, utcOffsetS = 0): string {
  const d = localDateTime(startTime, utcOffsetS);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

export function timeLabel(startTime: number, utcOffsetS = 0): string {
  const d = localDateTime(startTime, utcOffsetS);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export function relativeTime(ms: number | null | undefined): string {
  if (!Number.isFinite(ms as number)) return '—';
  const diff = Date.now() - (ms as number);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(months / 12)} years ago`;
}

export function hours(seconds: number | null | undefined, digits = 1): string {
  if (!Number.isFinite(seconds as number)) return '—';
  return ((seconds as number) / 3600).toFixed(digits);
}

export function signed(value: number | null | undefined, digits = 0): string {
  if (!Number.isFinite(value as number)) return '—';
  const v = value as number;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** Duration label for power-curve buckets: 5s, 1:00, 20:00, 1:00:00. */
export function effortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:00`;
}

/**
 * Distance label for a split bucket, in the terms that sport uses.
 *
 * "Marathon" belongs to running and walking. A cyclist covering 42.195 km has not run a
 * marathon, and 160.9 km is a century, not "1 mile × 100".
 */
export function splitLabel(metres: number, family?: string): string {
  const onFoot = family === 'run' || family === 'walk' || family === undefined;

  if (metres === 1609.344) return family === 'swim' ? '1 mile' : '1 mile';
  if (metres === 21097.5) return onFoot || family === 'row' ? 'Half marathon' : '21.1 km';
  if (metres === 42195) return onFoot || family === 'row' ? 'Marathon' : '42.2 km';
  if (metres === 160934.4) return '100 miles';

  if (metres < 1000) return `${metres} m`;
  const km = metres / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

export const SPORT_ICONS: Record<string, string> = {
  run: '🏃', trail_run: '⛰️', treadmill_run: '🏃',
  ride: '🚴', gravel_ride: '🚴', mtb_ride: '🚵', virtual_ride: '🚴', ebike_ride: '🚴',
  swim: '🏊', open_water_swim: '🏊',
  walk: '🚶', hike: '🥾', snowshoe: '🥾',
  row: '🚣', kayak: '🛶', paddle: '🛶', surf: '🏄',
  strength: '🏋️', workout: '💪', hiit: '💪', crossfit: '🏋️',
  yoga: '🧘', pilates: '🧘',
  elliptical: '🏃', stair_stepper: '🪜', indoor_cardio: '💪',
  ski_alpine: '⛷️', ski_nordic: '🎿', snowboard: '🏂',
  skate: '⛸️', inline_skate: '🛼', skateboard: '🛹',
  climb: '🧗', golf: '⛳', tennis: '🎾', racquet: '🏸', football: '⚽',
  other: '🏅',
};

export const sportIcon = (sport: string) => SPORT_ICONS[sport] || SPORT_ICONS.other;

