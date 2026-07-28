import { prettySport } from '../parsers/sports.js';

// Shared response shaping.
//
// This lives in its own module because it was originally duplicated: the activity
// list and the dashboard each mapped rows to JSON separately, and the dashboard's
// copy quietly omitted `avg_speed_ms` and `utc_offset_s`. The result was that every
// activity on the dashboard rendered its pace as "—" and its time in UTC, while the
// same activity on the list page was fine. One shaper, one shape.

/**
 * A readable fallback title, in the style every platform uses ("Morning Ride").
 *
 * Device files carry no activity name — a Wahoo or Garmin FIT has nowhere to put
 * one — so an athlete importing straight from their head unit would otherwise see a
 * list of identical "Ride" entries. Names that *do* exist (from
 * typed in here) always win.
 *
 * Deliberately derived at read time rather than stored: writing it into `name`
 * would make the row look already-named, and the merge rule that fills a null name
 * from a later import would stop working — so a Strava export arriving afterwards
 * could no longer supply the title you actually wrote.
 */
export function autoName(sport, startTime, utcOffsetS = 0) {
  const local = new Date(startTime + (utcOffsetS || 0) * 1000);
  const hour = local.getUTCHours();
  const partOfDay = hour < 5 ? 'Night'
    : hour < 12 ? 'Morning'
    : hour < 17 ? 'Afternoon'
    : hour < 21 ? 'Evening'
    : 'Night';
  return `${partOfDay} ${prettySport(sport)}`;
}

/** Row from `activities` -> the JSON shape the web app's activity components expect. */
export function shapeActivity(row) {
  return {
    id: row.id,
    name: row.name,
    // What the UI should print. `name` stays null when nothing named it, so the
    // merge logic can still fill it from a later import.
    displayName: row.name || autoName(row.sport, row.start_time, row.utc_offset_s),
    sport: row.sport,
    sportLabel: prettySport(row.sport),
    startTime: row.start_time,
    utcOffsetS: row.utc_offset_s ?? 0,
    elapsedS: row.elapsed_s,
    movingS: row.moving_s,
    distanceM: row.distance_m,
    elevGainM: row.elev_gain_m,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    avgPower: row.avg_power,
    normalizedPower: row.normalized_power,
    avgSpeedMs: row.avg_speed_ms,
    calories: row.calories,
    load: row.load,
    loadMethod: row.load_method,
    intensityFactor: row.intensity_factor,
    trainer: !!row.trainer,
    commute: !!row.commute,
    manual: !!row.manual,
    polyline: row.polyline,
    startLat: row.start_lat,
    startLng: row.start_lng,
    source: row.source,
    perceivedExertion: row.perceived_exertion,
  };
}

/**
 * The columns `shapeActivity` reads. Any query feeding it must select these, or
 * fields silently come back null — which is exactly the bug this module exists to
 * prevent.
 */
export const ACTIVITY_SELECT = `id, name, sport, start_time, utc_offset_s, elapsed_s, moving_s,
  distance_m, elev_gain_m, avg_hr, max_hr, avg_power, normalized_power, avg_speed_ms,
  calories, load, load_method, intensity_factor, trainer, commute, manual, polyline,
  start_lat, start_lng, source, perceived_exertion`;
