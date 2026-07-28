import { generate } from './ollama.js';
import { interpretForm } from '../metrics/fitness.js';
import { prettySport } from '../parsers/sports.js';

// The AI coach.
//
// Everything here works from compact numeric summaries, never raw streams: a small
// model has neither the context window nor the arithmetic to read 5000 samples, and
// would hallucinate confidently if asked to. Giving it pre-computed metrics and
// asking it to *interpret* them plays to what these models are good at.

const COACH_SYSTEM = `You are a concise, evidence-minded endurance coach reviewing an athlete's own data.

Rules:
- Be specific and quantitative. Cite the numbers you were given.
- Never invent data. If something is missing, say what would help and why.
- No medical claims or diagnoses.
- Prefer plain language over jargon. If you use a term like TSB, define it in a few words.
- Be direct. No preamble, no motivational filler, no emoji.`;

/**
 * Weekly review.
 * @param {object} context  from buildWeeklyContext()
 */
export async function weeklyReview(context) {
  const prompt = `Review this athlete's last 7 days of training and write a short summary.

## This week
${formatWeek(context.thisWeek)}

## Previous week (for comparison)
${formatWeek(context.lastWeek)}

## Current state
- Fitness (CTL, 42-day average load): ${fmt(context.fitness.ctl)}
- Fatigue (ATL, 7-day average load): ${fmt(context.fitness.atl)}
- Form (TSB = fitness − fatigue): ${fmt(context.fitness.tsb)} — ${context.fitness.formLabel}
- Ramp rate (fitness change over 7 days): ${fmt(context.fitness.rampRate)}
- Training monotony: ${fmt(context.fitness.monotony)} ${context.fitness.monotony > 2 ? '(high — little variation)' : ''}

## Sessions this week
${context.sessions.length ? context.sessions.join('\n') : 'No activities recorded.'}

Write:
1. **This week** — two or three sentences on what actually happened.
2. **What stands out** — one or two specific observations, with numbers.
3. **Next week** — one concrete suggestion that follows from the data above.

Keep the whole thing under 200 words. Use those three headings.`;

  const result = await generate(prompt, { system: COACH_SYSTEM, temperature: 0.4 });
  return result;
}

/** Insight for a single activity. */
export async function activityInsight(context) {
  const prompt = `Comment briefly on this single session.

${context.lines.join('\n')}

${context.comparison ? `## How it compares\n${context.comparison.join('\n')}\n` : ''}
In under 90 words: what kind of session was this in training terms, and one thing worth
noticing. Reference the numbers. No headings.`;

  return generate(prompt, { system: COACH_SYSTEM, temperature: 0.4, maxTokens: 1200 });
}

/**
 * Natural-language question answering, via generated SQL.
 *
 * The model never touches the database. It only proposes a SELECT, which is then
 * validated against a strict allowlist before execution — see `safeSql` below.
 * Results are handed back to the model for phrasing.
 */
export async function askQuestion(db, userId, question, { schema }) {
  const sqlPrompt = `Translate the question into a single SQLite SELECT statement.

${schema}

Rules:
- Exactly one SELECT statement. No semicolon. No CTE that writes. No PRAGMA, ATTACH, or any write.
- ALWAYS constrain to the current athlete with: user_id = ${Number(userId)}
- Times are epoch milliseconds (activities.start_time). Days are 'YYYY-MM-DD' text (daily.day).
- Distances are metres, durations are seconds, speeds are m/s.
- Limit results to 200 rows.
- Return ONLY the SQL, with no explanation or code fence.

Question: ${question}`;

  const sqlResult = await generate(sqlPrompt, {
    system: 'You write precise SQLite queries and output nothing but SQL.',
    temperature: 0.1,
    maxTokens: 1200,
  });

  const sql = cleanSql(sqlResult.text);
  const validation = safeSql(sql, userId);
  if (!validation.ok) {
    return { answer: null, error: `Could not build a safe query: ${validation.reason}`, sql };
  }

  let rows;
  try {
    rows = db.prepare(sql).all();
  } catch (err) {
    return { answer: null, error: `Query failed: ${err.message}`, sql };
  }

  const trimmed = rows.slice(0, 50);
  const answerResult = await generate(
    `Question: ${question}

Query results (JSON):
${JSON.stringify(trimmed, null, 1)}

Answer the question directly in one or two sentences using these results. Convert metres
to km and seconds to h/min where it reads better. If the results are empty, say so plainly.`,
    { system: COACH_SYSTEM, temperature: 0.2, maxTokens: 1200 },
  );

  return { answer: answerResult.text, sql, rowCount: rows.length, rows: trimmed };
}

function cleanSql(text) {
  return text
    .replace(/```(?:sql)?\s*([\s\S]*?)```/g, '$1')
    .replace(/^\s*sql\s*/i, '')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * Validate model-generated SQL before it goes anywhere near the database.
 *
 * Allowlist, not blocklist: a single SELECT, only known tables, no statement
 * separators, and it must scope to this user. Anything unexpected is refused rather
 * than sanitised — the cost of being wrong here is the model reading or destroying
 * data it was never meant to touch.
 */
const ALLOWED_TABLES = new Set([
  'activities', 'daily', 'best_efforts', 'laps', 'streams',
]);

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|grant|trigger)\b/i;

export function safeSql(sql, userId) {
  if (!sql) return { ok: false, reason: 'the model returned no SQL' };
  if (!/^select\b/i.test(sql.trim())) return { ok: false, reason: 'not a SELECT statement' };
  if (sql.includes(';')) return { ok: false, reason: 'contains multiple statements' };
  if (FORBIDDEN.test(sql)) return { ok: false, reason: 'contains a write or schema operation' };
  if (/\bsqlite_/i.test(sql)) return { ok: false, reason: 'references internal SQLite tables' };

  // Every table referenced must be one we allow.
  const referenced = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w]*)/gi)].map((m) => m[1].toLowerCase());
  if (!referenced.length) return { ok: false, reason: 'no table referenced' };
  for (const table of referenced) {
    if (!ALLOWED_TABLES.has(table)) return { ok: false, reason: `unknown table "${table}"` };
  }

  // Must be scoped to this athlete. On a single-user instance this is belt and
  // braces; on a shared one it is the thing preventing cross-account reads.
  if (!new RegExp(`user_id\\s*=\\s*${Number(userId)}\\b`).test(sql)) {
    return { ok: false, reason: 'query is not scoped to your user_id' };
  }

  return { ok: true };
}

/** Schema description handed to the model. Kept terse to save context. */
export const SCHEMA_DESCRIPTION = `Tables:
activities(id, user_id, name, sport, start_time INTEGER epoch-ms, elapsed_s, moving_s,
  distance_m, elev_gain_m, avg_hr, max_hr, avg_power, normalized_power, avg_cadence,
  avg_speed_ms, calories, load, load_method, intensity_factor, decoupling_pct,
  vo2max_estimate, trainer, commute, perceived_exertion, notes)
daily(user_id, day TEXT 'YYYY-MM-DD', load, duration_s, distance_m, elev_gain_m,
  activity_count, ctl, atl, tsb, monotony, ramp_rate, vo2max)
best_efforts(user_id, activity_id, sport, kind TEXT, bucket REAL, value REAL, start_time)
  -- kind 'peak_power'/'peak_hr': bucket = seconds, value = watts/bpm
  -- kind 'fastest_distance': bucket = metres, value = seconds taken
laps(activity_id, idx, distance_m, elapsed_s, avg_hr, avg_power)

Sport values include: run, trail_run, treadmill_run, ride, gravel_ride, mtb_ride,
virtual_ride, swim, walk, hike, row, strength, workout, other.`;

// ─── context builders ─────────────────────────────────────────────────────────

export function buildWeeklyContext(db, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const dayOffset = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  const week = (from, to) => db.prepare(`SELECT
      COUNT(*) AS sessions, SUM(load) AS load, SUM(moving_s) AS seconds,
      SUM(distance_m) AS distance, SUM(elev_gain_m) AS elevation
    FROM activities WHERE user_id = ? AND start_time >= ? AND start_time < ?`)
    .get(userId, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`));

  const thisWeek = week(dayOffset(7), dayOffset(-1));
  const lastWeek = week(dayOffset(14), dayOffset(7));

  const latest = db.prepare(
    'SELECT * FROM daily WHERE user_id = ? AND day <= ? ORDER BY day DESC LIMIT 1',
  ).get(userId, today) || {};

  const sessions = db.prepare(`SELECT name, sport, start_time, moving_s, distance_m,
      avg_hr, avg_power, load, load_method, intensity_factor
    FROM activities WHERE user_id = ? AND start_time >= ? ORDER BY start_time`)
    .all(userId, Date.now() - 7 * 86400000)
    .map((a) => `- ${new Date(a.start_time).toISOString().slice(0, 10)} ${prettySport(a.sport)}: `
      + [
        a.distance_m ? `${(a.distance_m / 1000).toFixed(1)} km` : null,
        a.moving_s ? formatDuration(a.moving_s) : null,
        a.avg_hr ? `${Math.round(a.avg_hr)} bpm avg` : null,
        a.avg_power ? `${Math.round(a.avg_power)} W avg` : null,
        a.load ? `load ${Math.round(a.load)}` : null,
      ].filter(Boolean).join(', '));

  return {
    thisWeek,
    lastWeek,
    fitness: {
      ctl: latest.ctl, atl: latest.atl, tsb: latest.tsb,
      rampRate: latest.ramp_rate, monotony: latest.monotony,
      formLabel: interpretForm(latest.tsb).label,
    },
    sessions,
  };
}

export function buildActivityContext(db, userId, activityRow) {
  const a = activityRow;
  const lines = [
    `## Session`,
    `- Type: ${prettySport(a.sport)}${a.trainer ? ' (indoor)' : ''}`,
    `- Date: ${new Date(a.start_time).toISOString().slice(0, 16).replace('T', ' ')}`,
    a.distance_m ? `- Distance: ${(a.distance_m / 1000).toFixed(2)} km` : null,
    a.moving_s ? `- Moving time: ${formatDuration(a.moving_s)}` : null,
    a.avg_speed_ms ? `- Average pace: ${paceLabel(a.avg_speed_ms)}` : null,
    a.elev_gain_m ? `- Elevation gain: ${Math.round(a.elev_gain_m)} m` : null,
    a.avg_hr ? `- Heart rate: ${Math.round(a.avg_hr)} avg, ${Math.round(a.max_hr || 0)} max` : null,
    a.avg_power ? `- Power: ${Math.round(a.avg_power)} W avg, ${Math.round(a.normalized_power || 0)} W normalized` : null,
    a.load ? `- Training load: ${Math.round(a.load)} (from ${a.load_method})` : null,
    a.intensity_factor ? `- Intensity factor: ${a.intensity_factor.toFixed(2)} (1.0 = threshold)` : null,
    a.decoupling_pct !== null && a.decoupling_pct !== undefined
      ? `- Aerobic decoupling: ${a.decoupling_pct.toFixed(1)}% (under 5% is good durability)` : null,
    a.perceived_exertion ? `- Reported effort: ${a.perceived_exertion}/10` : null,
  ].filter(Boolean);

  // Compare against the same sport over the previous 90 days.
  const peers = db.prepare(`SELECT AVG(distance_m) AS distance, AVG(moving_s) AS seconds,
      AVG(avg_hr) AS hr, AVG(load) AS load, COUNT(*) AS n
    FROM activities WHERE user_id = ? AND sport = ? AND id != ? AND start_time >= ?`)
    .get(userId, a.sport, a.id, a.start_time - 90 * 86400000);

  let comparison = null;
  if (peers?.n > 2) {
    comparison = [
      `- Your average ${prettySport(a.sport)} over the previous 90 days (${peers.n} sessions):`,
      peers.distance ? `  ${(peers.distance / 1000).toFixed(1)} km` : null,
      peers.seconds ? `  ${formatDuration(peers.seconds)}` : null,
      peers.hr ? `  ${Math.round(peers.hr)} bpm` : null,
      peers.load ? `  load ${Math.round(peers.load)}` : null,
    ].filter(Boolean);
  }

  return { lines, comparison };
}

// ── formatting ───────────────────────────────────────────────────────────────

function formatWeek(w) {
  if (!w || !w.sessions) return '- No activities.';
  return [
    `- Sessions: ${w.sessions}`,
    `- Total load: ${Math.round(w.load || 0)}`,
    `- Time: ${formatDuration(w.seconds || 0)}`,
    `- Distance: ${((w.distance || 0) / 1000).toFixed(1)} km`,
    `- Elevation: ${Math.round(w.elevation || 0)} m`,
  ].join('\n');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function paceLabel(speedMs) {
  if (!speedMs || speedMs <= 0) return '—';
  const secPerKm = 1000 / speedMs;
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}/km`;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'not available');
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
