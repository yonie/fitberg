// Sport normalisation.
//
// Every platform names things differently, and a hub whose "all my running" view
// misses Nike runs because they are typed `run` instead of `Run` is worthless.
// Everything funnels through here into one vocabulary.

export const SPORTS = [
  'run', 'trail_run', 'treadmill_run',
  'ride', 'gravel_ride', 'mtb_ride', 'virtual_ride', 'ebike_ride', 'handcycle',
  'swim', 'open_water_swim',
  'walk', 'hike', 'snowshoe',
  'row', 'kayak', 'paddle', 'surf', 'sail', 'windsurf', 'kitesurf',
  'strength', 'workout', 'hiit', 'yoga', 'pilates', 'crossfit',
  'elliptical', 'stair_stepper', 'indoor_cardio',
  'ski_alpine', 'ski_nordic', 'snowboard',
  'skate', 'inline_skate', 'skateboard',
  'climb', 'golf', 'tennis', 'racquet', 'football', 'wheelchair',
  'other',
];

// Which broad family a sport belongs to — drives which load model applies and
// which charts make sense.
export const FAMILY = {
  run: 'run', trail_run: 'run', treadmill_run: 'run',
  ride: 'ride', gravel_ride: 'ride', mtb_ride: 'ride', virtual_ride: 'ride',
  ebike_ride: 'ride', handcycle: 'ride',
  swim: 'swim', open_water_swim: 'swim',
  walk: 'walk', hike: 'walk', snowshoe: 'walk',
  row: 'row', kayak: 'row', paddle: 'row',
  strength: 'strength', workout: 'strength', hiit: 'strength',
  yoga: 'strength', pilates: 'strength', crossfit: 'strength',
};

export function familyOf(sport) {
  return FAMILY[sport] || 'other';
}

/** Sports whose pace/speed is meaningful to compare over ground distance. */
export function isDistanceSport(sport) {
  return ['run', 'ride', 'swim', 'walk', 'row'].includes(familyOf(sport));
}

const ALIASES = new Map(Object.entries({
  // ── Strava activity types ──
  run: 'run', trailrun: 'trail_run', virtualrun: 'treadmill_run',
  ride: 'ride', virtualride: 'virtual_ride', gravelride: 'gravel_ride',
  mountainbikeride: 'mtb_ride', ebikeride: 'ebike_ride', emountainbikeride: 'ebike_ride',
  velomobile: 'ride', handcycle: 'handcycle',
  swim: 'swim', walk: 'walk', hike: 'hike', snowshoe: 'snowshoe',
  weighttraining: 'strength', workout: 'workout', crossfit: 'crossfit',
  highintensityintervaltraining: 'hiit', yoga: 'yoga', pilates: 'pilates',
  elliptical: 'elliptical', stairstepper: 'stair_stepper',
  rowing: 'row', virtualrow: 'row', canoeing: 'kayak', kayaking: 'kayak',
  standuppaddling: 'paddle', surfing: 'surf', kitesurf: 'kitesurf',
  windsurf: 'windsurf', sail: 'sail',
  alpineski: 'ski_alpine', backcountryski: 'ski_nordic', nordicski: 'ski_nordic',
  rollerski: 'ski_nordic', snowboard: 'snowboard',
  iceskate: 'skate', inlineskate: 'inline_skate', skateboard: 'skateboard',
  rockclimbing: 'climb', golf: 'golf', tennis: 'tennis',
  badminton: 'racquet', pickleball: 'racquet', squash: 'racquet',
  tabletennis: 'racquet', racquetball: 'racquet',
  soccer: 'football', wheelchair: 'wheelchair',

  // ── FIT `sport` enum ──
  running: 'run', cycling: 'ride', swimming: 'swim', walking: 'walk',
  hiking: 'hike', rowing_: 'row', training: 'workout',
  fitness_equipment: 'indoor_cardio', generic: 'other',
  e_biking: 'ebike_ride', mountaineering: 'hike',
  cross_country_skiing: 'ski_nordic', alpine_skiing: 'ski_alpine',

  // ── FIT's own enum, as the Garmin SDK spells it ──
  //
  // The SDK emits camelCase ("alpineSkiing"), which squashes to "alpineskiing" — and
  // none of the aliases above matched that, so every ski, skate and paddle session fell
  // through to the guesser and came out as a run.
  running: 'run', cycling: 'ride', swimming: 'swim', walking: 'walk', hiking: 'hike',
  rowing: 'row', paddling: 'paddle', standuppaddleboarding: 'paddle', kayaking: 'kayak',
  rafting: 'paddle', surfing: 'surf', sailing: 'sail', windsurfing: 'windsurf',
  kitesurfing: 'kitesurf', wakeboarding: 'surf', waterskiing: 'surf',
  alpineskiing: 'ski_alpine', crosscountryskiing: 'ski_nordic', snowboarding: 'snowboard',
  snowshoeing: 'snowshoe', iceskating: 'skate', inlineskating: 'inline_skate',
  rockclimbing: 'climb', floorclimbing: 'climb', mountaineering: 'climb',
  fitnessequipment: 'indoor_cardio', training: 'workout', golf: 'golf', tennis: 'tennis',
  soccer: 'football', racket: 'racquet', boxing: 'workout', meditation: 'yoga',
  wheelchairpushwalk: 'wheelchair', wheelchairpushrun: 'wheelchair',
  ebiking: 'ebike_ride',
  // Deliberately mapped to 'other': these are not training, and inventing a category
  // for them would put them in totals they do not belong in.
  generic: 'other', transition: 'other', multisport: 'other', flying: 'other',
  motorcycling: 'other', boating: 'other', driving: 'other', hanggliding: 'other',
  horsebackriding: 'other', hunting: 'other', fishing: 'other', skydiving: 'other',
  snowmobiling: 'other', tactical: 'other', jumpmaster: 'other', diving: 'other',
  basketball: 'other', americanfootball: 'other', baseball: 'other',
  snowboarding: 'snowboard', snowshoeing: 'snowshoe',
  inline_skating: 'inline_skate', ice_skating: 'skate',
  rock_climbing: 'climb', paddling: 'paddle', stand_up_paddleboarding: 'paddle',
  kayaking_: 'kayak', surfing_: 'surf', sailing: 'sail',
  windsurfing: 'windsurf', kitesurfing: 'kitesurf',
  tennis_: 'tennis', golf_: 'golf', soccer_: 'football',
  american_football: 'football', wheelchair_run_pace: 'wheelchair',
  wheelchair_push_pace: 'wheelchair', transition: 'other',
  multisport: 'other', flexibility_training: 'yoga',
  strength_training: 'strength', cardio_training: 'indoor_cardio',
  hiit_: 'hiit', water_sports: 'other', floor_climbing: 'stair_stepper',

  // ── Nike Run Club ──
  jogging: 'run',

  // ── plain-language / GPX <type> values people actually write ──
  cycle: 'ride', bike: 'ride', biking: 'ride', mtb: 'mtb_ride',
  gravel: 'gravel_ride', road: 'ride', indoor: 'indoor_cardio',
  treadmill: 'treadmill_run', trail: 'trail_run',
  strength_: 'strength', gym: 'strength', weights: 'strength',
  openwaterswim: 'open_water_swim', open_water: 'open_water_swim',
  erg: 'row', indoorrowing: 'row',
}));

/**
 * @param {string|null|undefined} raw  Whatever the source called it.
 * @param {{subSport?:string|null, trainer?:boolean}} [hints]
 */
export function normalizeSport(raw, hints = {}) {
  const key = String(raw ?? '').toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z_0-9]/g, '');
  // Sources are inconsistent about word separators for the same activity:
  // Strava says "WeightTraining", other exports say "Weight Training", FIT says
  // "strength_training". Try the underscored and squashed spellings of each.
  const squashed = key.replace(/_/g, '');
  let sport = ALIASES.get(key)
    || ALIASES.get(squashed)
    || ALIASES.get(key.replace(/_$/, ''))
    || null;

  if (!sport && SPORTS.includes(key)) sport = key;

  // FIT sub-sport carries the interesting distinction: sport=running,
  // sub_sport=trail is a trail run; sub_sport=treadmill is not outdoors at all.
  const sub = String(hints.subSport ?? '').toLowerCase();
  if (sport === 'run' || key === 'running') {
    if (sub.includes('trail')) sport = 'trail_run';
    else if (sub.includes('treadmill') || sub.includes('indoor')) sport = 'treadmill_run';
  }
  if (sport === 'ride' || key === 'cycling') {
    if (sub.includes('mountain') || sub.includes('downhill') || sub.includes('enduro')) sport = 'mtb_ride';
    else if (sub.includes('gravel') || sub.includes('cyclocross')) sport = 'gravel_ride';
    else if (sub.includes('virtual') || sub.includes('indoor') || sub.includes('spin')) sport = 'virtual_ride';
    else if (sub.includes('e_bike') || sub.includes('ebike')) sport = 'ebike_ride';
  }
  if (sport === 'swim' && (sub.includes('open_water') || sub.includes('openwater'))) {
    sport = 'open_water_swim';
  }
  // A watch records a gym session as sport=training with the detail in sub-sport.
  // Without this, every strength workout collapses into a generic "workout".
  if (sport === 'workout' || sport === 'other' || sport === 'indoor_cardio') {
    const squashedSub = sub.replace(/_/g, '');
    if (squashedSub.includes('strength')) sport = 'strength';
    else if (squashedSub.includes('cardio')) sport = 'indoor_cardio';
    else if (squashedSub.includes('yoga') || squashedSub.includes('flexibility')) sport = 'yoga';
    else if (squashedSub.includes('pilates')) sport = 'pilates';
    else if (squashedSub.includes('hiit')) sport = 'hiit';
  }

  if (!sport) sport = 'other';

  // A "run" recorded on a trainer/treadmill should not pollute outdoor pace PRs.
  if (hints.trainer && sport === 'run') sport = 'treadmill_run';
  if (hints.trainer && sport === 'ride') sport = 'virtual_ride';

  return sport;
}

export function prettySport(sport) {
  return String(sport)
    .split('_')
    .map((w) => (w === 'mtb' || w === 'hiit' ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
