import sax from 'sax';
import { newActivity, finalizeActivity, alignStreams } from './canonical.js';
import { normalizeSport } from './sports.js';

// TCX is the Garmin Training Center schema that Nike Run Club (among others) exports
// activities in. Structurally the base schema carries less than FIT — no power, no
// temperature, no running dynamics — but Nike puts most of what FIT would call the
// device's own session summary into its own `nax:` extension as flat Key/Value pairs
// rather than typed fields: device model, a user title, RPE, a free-text note, weather,
// indoor/outdoor, terrain. Reading those is what makes a Nike import as complete as a
// FIT one rather than a stripped-down copy of it.
//
// Two things about real-world TCX make this more than an XML-to-streams mapping, and
// both are handled below because getting either wrong corrupts the data silently:
//
//   1. Trackpoints are EVENT-DRIVEN, not sampled. Nike emits a trackpoint whenever any
//      sensor has news, carrying only that sensor's value — position and heart rate
//      almost never appear in the same one, and a quarter of them carry nothing but a
//      timestamp. Mapping trackpoint-index to stream-index would produce channels that
//      are ~90% null and interleaved, which every consumer downstream (the charts, the
//      canonical derivations, the mean-max curves) reads as missing data rather than as
//      a differently-shaped recording. So samples are placed on a one-per-second grid.
//
//   2. Trackpoint `DistanceMeters` is defined by the schema as cumulative from the start
//      of the activity, and Garmin writes it that way — but Nike writes the DELTA since
//      the previous point. Guessing wrong turns a 5 km run into either 8 m or a
//      meaningless sawtooth, so the reading is chosen by whichever one reproduces the
//      lap's own authoritative total.
//
// Namespace prefixes vary by producer (`<Speed>` under a locally-redeclared default
// namespace in one file, `<ns3:Speed>` in another), so tags are matched on local name —
// the same "identify by content, not by exact shape" approach `sniff.js` takes with
// whole files.

/** Hold a channel's last reading across a gap this long. Beyond it, a real pause. */
const MAX_FILL_S = 30;

/** Sanity cap on the resampled grid, matching `metrics/efforts.js`: 48 h. */
const MAX_GRID_S = 48 * 3600;

const STREAM_KEYS = ['lat', 'lng', 'alt', 'hr', 'cad', 'power', 'speed', 'dist'];

const localName = (name) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

const toNum = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const toMs = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * @param {Buffer} buf
 * @param {{source?:string, sourceId?:string|null}} [opts]
 * @returns {{activities:Array<object>, warnings:string[]}}
 */
export function parseTcx(buf, opts = {}) {
  const xml = buf.toString('utf8').replace(/^﻿/, '');
  const warnings = [];
  const rawActivities = [];

  const parser = sax.parser(true, { trim: false });
  const path = [];
  let text = '';

  let raw = null;    // the <Activity> being read
  let lap = null;    // the <Lap> being read
  let tp = null;     // the <Trackpoint> being read
  let pendingTagKey = null;

  parser.onerror = (err) => {
    warnings.push(`TCX parse error: ${err.message}`);
    parser.resume();
  };
  parser.ontext = (t) => { text += t; };
  parser.oncdata = (t) => { text += t; };

  parser.onopentag = (node) => {
    path.push(localName(node.name));
    text = '';
    const name = path[path.length - 1];

    if (name === 'Activity') {
      raw = {
        sportAttr: node.attributes.Sport || null,
        activityType: null, idText: null, tags: {}, laps: [],
      };
    } else if (name === 'Lap' && raw) {
      lap = {
        startTimeText: node.attributes.StartTime || null,
        elapsedS: null, distanceM: null, calories: null,
        avgHr: null, maxHr: null, cadence: null, maxSpeedMs: null, notes: null,
        trackpoints: [],
      };
    } else if (name === 'Trackpoint' && lap) {
      tp = { t: null, lat: null, lng: null, alt: null, dist: null, hr: null, cad: null, speed: null, power: null };
    }
  };

  parser.onclosetag = () => {
    const name = path[path.length - 1];
    const parent = path[path.length - 2];
    const value = text.trim();
    text = '';

    switch (name) {
      case 'Id':
        if (raw && parent === 'Activity' && raw.idText === null) raw.idText = value;
        break;
      case 'Time':
        if (tp) tp.t = toMs(value);
        break;
      case 'LatitudeDegrees':
        if (tp) tp.lat = toNum(value);
        break;
      case 'LongitudeDegrees':
        if (tp) tp.lng = toNum(value);
        break;
      case 'AltitudeMeters':
        if (tp) tp.alt = toNum(value);
        break;
      case 'DistanceMeters':
        if (tp) tp.dist = toNum(value);
        else if (lap && parent === 'Lap') lap.distanceM = toNum(value);
        break;
      case 'TotalTimeSeconds':
        if (lap && parent === 'Lap') lap.elapsedS = toNum(value);
        break;
      case 'MaximumSpeed':
        if (lap && parent === 'Lap') lap.maxSpeedMs = toNum(value);
        break;
      case 'Calories':
        if (lap && parent === 'Lap') lap.calories = toNum(value);
        break;
      case 'Notes':
        if (lap && parent === 'Lap') lap.notes = value;
        break;
      case 'Cadence':
        // Nike writes running cadence here in steps per minute, which is the unit the
        // rest of Fitberg stores, so it is taken as-is.
        if (tp) tp.cad = toNum(value);
        else if (lap && parent === 'Lap') lap.cadence = toNum(value);
        break;
      case 'Value':
        // One tag name, three meanings depending on where it sits: a per-sample heart
        // rate, a lap summary, or half of a Nike Key/Value pair. Dispatching on the
        // parent separates all three without a namespace-aware parser.
        if (pendingTagKey !== null) {
          if (raw) raw.tags[pendingTagKey] = value;
          pendingTagKey = null;
        } else if (parent === 'HeartRateBpm' && tp) {
          tp.hr = toNum(value);
        } else if (parent === 'AverageHeartRateBpm' && lap) {
          lap.avgHr = toNum(value);
        } else if (parent === 'MaximumHeartRateBpm' && lap) {
          lap.maxHr = toNum(value);
        }
        break;
      case 'Speed':
        if (tp) tp.speed = toNum(value);
        break;
      case 'Watts':
        if (tp) tp.power = toNum(value);
        break;
      case 'RunCadence':
        if (tp && tp.cad === null) tp.cad = toNum(value);
        break;
      case 'ActivityType':
        // Nike's own name for the sport, which is populated even in the files whose
        // standard `Sport` attribute is the string "undefined".
        if (raw && !tp) raw.activityType = value;
        break;
      case 'Key':
        if (parent === 'Tag') pendingTagKey = value;
        break;
      case 'Trackpoint':
        if (lap && tp) lap.trackpoints.push(tp);
        tp = null;
        break;
      case 'Lap':
        if (raw && lap) raw.laps.push(lap);
        lap = null;
        break;
      case 'Activity':
        if (raw) rawActivities.push(raw);
        raw = null;
        break;
      default:
        break;
    }

    path.pop();
  };

  parser.write(xml).close();

  const activities = rawActivities
    .map((a) => buildActivity(a, opts, warnings))
    .filter(Boolean);

  if (!activities.length) throw new Error('TCX file yielded no usable activity');
  return { activities, warnings };
}

function buildActivity(raw, opts, warnings) {
  const act = newActivity(opts.source || 'file');
  act.sourceId = raw.tags['com.nike.running.originalactivityid'] || opts.sourceId || null;

  // Absolute cumulative distance per trackpoint, whichever way the producer wrote it.
  const events = [];
  let lapBase = 0;
  for (const lp of raw.laps) {
    const mode = distanceMode(lp);
    let running = 0;
    for (const point of lp.trackpoints) {
      if (point.t === null) continue;
      let dist = null;
      if (Number.isFinite(point.dist)) {
        running = mode === 'delta' ? running + point.dist : point.dist;
        dist = lapBase + running;
      }
      events.push({ ...point, dist });
    }
    lapBase += Number.isFinite(lp.distanceM) ? lp.distanceM : running;
  }

  if (!events.length) return null;

  const startTime = toMs(raw.idText) ?? toMs(raw.laps[0]?.startTimeText) ?? events[0].t;
  if (startTime === null) return null;
  act.startTime = startTime;

  act.streams = gridStreams(events, warnings);

  const spanS = alignStreams(act.streams) - 1;
  const summaryS = raw.laps.reduce((sum, lp) => sum + (lp.elapsedS || 0), 0) || null;
  // The lap total is the producer's own duration and already excludes auto-paused time,
  // so it is the moving time. Elapsed can only be as long as the recording itself.
  if (summaryS) {
    act.movingS = round(summaryS);
    act.elapsedS = Math.max(round(summaryS), spanS > 0 ? spanS : 0);
  }

  act.laps = raw.laps.map((lp, idx) => ({
    idx,
    startTime: toMs(lp.startTimeText),
    elapsedS: round(lp.elapsedS),
    movingS: round(lp.elapsedS),
    distanceM: lp.distanceM,
    avgHr: lp.avgHr,
    maxHr: lp.maxHr,
    avgCadence: lp.cadence,
    avgSpeedMs: lp.elapsedS > 0 && Number.isFinite(lp.distanceM) ? lp.distanceM / lp.elapsedS : null,
  }));

  act.distanceM = raw.laps.reduce((sum, lp) => sum + (lp.distanceM || 0), 0) || null;
  act.calories = raw.laps.reduce((sum, lp) => sum + (lp.calories || 0), 0) || null;
  // Only useful when there is no speed stream to measure a sustained maximum from;
  // `finalizeActivity` overrides it when there is.
  act.maxSpeedMs = raw.laps.reduce((max, lp) => Math.max(max, lp.maxSpeedMs ?? 0), 0) || null;

  applyNikeTags(act, raw);

  return finalizeActivity(act);
}

/**
 * Is a lap's trackpoint `DistanceMeters` cumulative (per the schema, and what Garmin
 * writes) or a per-point delta (what Nike writes)?
 *
 * The lap's own `DistanceMeters` is authoritative, so the reading that reproduces it
 * wins. Without one, monotonicity decides: cumulative distance cannot decrease.
 */
function distanceMode(lp) {
  let sum = 0;
  let max = -Infinity;
  let monotonic = true;
  let prev = null;
  let seen = 0;

  for (const point of lp.trackpoints) {
    const v = point.dist;
    if (!Number.isFinite(v)) continue;
    seen++;
    sum += v;
    if (v > max) max = v;
    if (prev !== null && v < prev) monotonic = false;
    prev = v;
  }

  if (!seen) return 'cumulative';
  const total = lp.distanceM;
  if (Number.isFinite(total) && total > 0) {
    return Math.abs(sum - total) <= Math.abs(max - total) ? 'delta' : 'cumulative';
  }
  return monotonic ? 'cumulative' : 'delta';
}

/**
 * Place event-driven samples on a one-per-second grid, each channel carrying its most
 * recent reading.
 *
 * This is the same normalisation `metrics/efforts.js` applies before computing anything,
 * done here instead because for TCX it is a property of the source format rather than of
 * any one metric: without it every channel arrives riddled with holes that mean "this
 * sensor had nothing new to say", not "no data". Bounded fill keeps a genuine pause a
 * gap rather than inventing a held heart rate across it.
 */
function gridStreams(events, warnings) {
  const t0 = events[0].t;
  const tLast = events[events.length - 1].t;
  const span = Math.max(0, Math.round((tLast - t0) / 1000));

  // Some exports stamp every trackpoint with the same time, so a 44-minute session
  // arrives as one instant. There is no time series to recover there, and a one-sample
  // one would claim the whole distance happened at once — so the activity keeps its
  // summary and simply has no streams, which is what the file actually tells us.
  if (span === 0) {
    if (events.length > 1) {
      warnings.push(`${events.length} samples share one timestamp; kept as a summary only`);
    }
    return {};
  }

  if (span + 1 > MAX_GRID_S) {
    warnings.push(`recording spans ${Math.round(span / 3600)} h; sample times used as-is`);
    return rawStreams(events, t0);
  }

  const n = span + 1;
  const streams = { t: new Array(n) };
  for (let i = 0; i < n; i++) streams.t[i] = i;
  for (const key of STREAM_KEYS) streams[key] = new Array(n).fill(null);

  for (const event of events) {
    const sec = Math.round((event.t - t0) / 1000);
    if (sec < 0 || sec >= n) continue;
    for (const key of STREAM_KEYS) {
      const v = event[key];
      if (Number.isFinite(v)) streams[key][sec] = v;
    }
  }

  for (const key of STREAM_KEYS) {
    const arr = streams[key];
    let carry = null;
    let gap = 0;
    for (let i = 0; i < n; i++) {
      if (arr[i] !== null) { carry = arr[i]; gap = 0; continue; }
      if (carry !== null && gap < MAX_FILL_S) { arr[i] = carry; gap++; } else { gap++; }
    }
  }

  return dropEmpty(streams);
}

/** Fallback for a recording too long to grid: one stream sample per trackpoint. */
function rawStreams(events, t0) {
  const streams = { t: [] };
  for (const key of STREAM_KEYS) streams[key] = [];
  for (const event of events) {
    streams.t.push(Math.round((event.t - t0) / 1000));
    for (const key of STREAM_KEYS) streams[key].push(Number.isFinite(event[key]) ? event[key] : null);
  }
  return dropEmpty(streams);
}

function dropEmpty(streams) {
  for (const key of STREAM_KEYS) {
    if (!streams[key].some((v) => Number.isFinite(v))) delete streams[key];
  }
  return streams;
}

/**
 * Nike's extension carries real information the base TCX schema has no field for at
 * all: an actual device model, the title you gave the run, your RPE, your note, the
 * temperature, and indoor/terrain context. Guided Nike Training Club sessions (yoga,
 * strength) go further and arrive with the literal string `Sport="undefined"` — the
 * workout type and focus tags are the only thing that can classify those correctly
 * instead of every one of them collapsing into "other".
 */
function applyNikeTags(act, raw) {
  const { tags, laps, sportAttr, activityType } = raw;

  if (tags['com.nike.devicename']) act.device = tags['com.nike.devicename'];
  act.name = tags['com.nike.name'] || tags['com.nike.ntc.workout.name'] || null;

  const rpe = toNum(tags.rpe);
  if (rpe !== null) act.perceivedExertion = Math.round(rpe);

  const temp = toNum(tags['com.nike.temperature']);
  if (temp !== null) act.avgTempC = temp;

  if (!act.calories) {
    const estimated = toNum(tags['com.nike.ntc.workout.estimatedcalories']);
    if (estimated !== null) act.calories = estimated;
  }

  // Only what the athlete actually wrote. Nike also generates a per-lap note that
  // restates the average pace ("Mean Pace: 5.68 MKM") on every single activity, and
  // putting that in `notes` would fill a field meant for your own words with a number
  // already shown as the pace — and make an activity you never annotated look annotated.
  // It stays in the summary, where the rest of the producer's own metadata lives.
  act.notes = tags.note || null;

  const indoor = String(tags.location || tags['com.nike.ntc.location'] || '').toLowerCase() === 'indoors';
  const isNtc = Object.keys(tags).some((k) => k.startsWith('com.nike.ntc.'));
  const subSportHint = isNtc
    ? tags['com.nike.ntc.workout.type'] || tags['com.nike.ntc.workout.focus'] || null
    : tags.terrain || null;
  act.subSport = subSportHint;

  // The standard `Sport` attribute is the string "undefined" on a seventh of a real
  // Nike export — worse than absent, because it normalises to nothing and files a run
  // as "other", where it counts toward no sport total and no personal record. Nike's
  // own `ActivityType` is populated in exactly those files, so it is the fallback.
  //
  // Nike Training Club sessions come first regardless: a guided yoga class is labelled
  // `ActivityType=Running` too, and its workout type is the only honest signal.
  const declared = [sportAttr, activityType].find((v) => v && v !== 'undefined') || null;
  const rawSport = isNtc ? 'workout' : declared;
  act.sport = normalizeSport(rawSport, { subSport: subSportHint, trainer: indoor });
  act.trainer = indoor || (!act.streams.lat && act.sport !== 'swim');

  const producerNotes = laps.map((lp) => lp.notes).filter(Boolean).join(' / ');
  act.summary = { ...tags };
  if (producerNotes) act.summary.producerNote = producerNotes;
  if (!Object.keys(act.summary).length) act.summary = null;
}
