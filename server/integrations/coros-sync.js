import { createMcpClient, McpError } from './mcp-client.js';
import {
  discoverAuth, refreshTokens, CorosAuthError,
} from './coros-oauth.js';
import { ingestBuffer, beginImportRecord, finishImportRecord } from '../ingest/index.js';
import { takeSourceName } from '../db/edits.js';
import { sniff, KINDS } from '../ingest/sniff.js';
import { config } from '../lib/config.js';

// The COROS sync service.
//
// What the user sees as "Sync now" is, in order:
//   1. Make sure the access token is fresh (refresh if needed).
//   2. `querySportRecords` back through the whole history, in slices.
//   3. Filter out activities we have already imported — by COROS's activity id
//      when we stored it, and by our physical dedupe as a safety net.
//   4. `downloadActivityFitFiles` for the survivors, minding the 50-file daily
//      quota, and feed the bytes into the normal ingest pipeline.
//
// Between 2 and 3, the names COROS gives activities are taken over: the listing
// is the only place COROS shows them, and it already arrived.
//
// Everything is defensive about shapes: this talks to a third-party server we do
// not control, and the one certainty about such servers is that they change.
// A field moved is a skipped file with a logged reason, never a crashed sync.

/** COROS caps FIT downloads at 50 files per account per calendar day. */
const DAILY_FIT_QUOTA = 50;
/** One MCP call must not hang a sync forever. */
const CALL_TIMEOUT_MS = 60000;
/** Records one `querySportRecords` answer holds. */
const LIST_LIMIT = 100;
/** How much history to ask for at a time, walking backwards from today. */
const HISTORY_SLICE_DAYS = 90;
/** Consecutive empty slices that mean we have reached the start of the history. */
const EMPTY_SLICES_TO_STOP = 3;
/** A hard stop, so a server answering nonsense cannot spin for ever. */
const MAX_HISTORY_SLICES = 60;
const DAY_MS = 24 * 3600 * 1000;

/** Whether the account has no usable login left and must go through Connect again. */
export function needsReconnect(account) {
  return !account.refresh_token && !(account.access_token && account.token_expires_at > Date.now());
}

export class CorosSyncError extends Error {
  constructor(message, { authExpired = false } = {}) {
    super(message);
    this.name = 'CorosSyncError';
    this.authExpired = authExpired;
  }
}

// ─── token management ─────────────────────────────────────────────────────────

/** A fetch with a timeout, so a wedged COROS cannot wedge a sync. */
function fetchWithTimeout(url, opts = {}) {
  return globalThis.fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS), ...opts });
}

/**
 * A valid access token for the account, refreshing if the stored one is stale.
 * Writes the new token back to the database — the row is the single source of
 * truth for token state.
 */
export async function ensureFreshToken(db, account, { fetchImpl = fetchWithTimeout } = {}) {
  if (account.access_token && account.token_expires_at > Date.now()) {
    return account.access_token;
  }
  if (!account.refresh_token) {
    throw new CorosSyncError('COROS login has expired — reconnect it', { authExpired: true });
  }

  const auth = await discoverAuth({ fetchImpl });
  let tokens;
  try {
    tokens = await refreshTokens(auth, {
      clientId: account.client_id,
      clientSecret: account.client_secret,
      refreshToken: account.refresh_token,
      fetchImpl,
    });
  } catch (err) {
    // invalid_grant: COROS no longer honours this refresh token (revoked,
    // expired, or the client was dropped). Retrying cannot fix that, so forget
    // the dead tokens — the account then reads as needing a reconnect, and
    // Connect is allowed again.
    if (err instanceof CorosAuthError && err.code === 'invalid_grant') {
      db.prepare(`UPDATE integration_accounts
          SET access_token = NULL, refresh_token = NULL, token_expires_at = NULL, updated_at = ?
          WHERE id = ?`).run(Date.now(), account.id);
      account.access_token = null;
      account.refresh_token = null;
      throw new CorosSyncError('COROS login has expired — reconnect it', { authExpired: true });
    }
    throw err;
  }

  db.prepare(`UPDATE integration_accounts
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ?
      WHERE id = ?`).run(
    tokens.accessToken, tokens.refreshToken, tokens.expiresAt, Date.now(), account.id,
  );

  return tokens.accessToken;
}

// ─── the sync ─────────────────────────────────────────────────────────────────

/**
 * Run one sync for a connected COROS account.
 *
 * @returns a report shaped like an import report, plus `quotaExhausted` when
 * the 50-file cap stopped us early (the next sync picks up where this left off).
 */
export async function syncCoros(db, userId, account, {
  fetchImpl = fetchWithTimeout,
  onProgress = null,
  force = false,
} = {}) {
  const startedAt = Date.now();
  const report = {
    provider: 'coros',
    accountId: account.id,
    startedAt,
    found: 0,          // activities COROS listed
    downloaded: 0,      // FIT files fetched
    imported: 0,        // new activities ingested
    merged: 0,
    duplicates: 0,
    failed: 0,
    alreadyHave: 0,     // already in the library, so never downloaded at all
    unavailable: 0,     // COROS has no file for these; nothing to retry
    deferred: 0,        // listed but not fetched yet — the next sync gets them
    namesUpdated: 0,    // activities renamed to what COROS calls them
    quotaExhausted: false,
    daysInspected: 0,
    log: [],
  };

  const note = (msg, extra = {}) => {
    report.log.push({ at: Date.now() - startedAt, msg, ...extra });
    if (report.log.length > 200) report.log.shift();
    onProgress?.({ msg, ...extra });
  };

  // ── 1. token ──
  const token = await ensureFreshToken(db, account, { fetchImpl });
  const mcp = createMcpClient(config.coros.mcpUrl, () => token, { fetchImpl });
  await mcp.initialize();

  // ── 2. list what COROS has ──
  //
  // All of it, every time. Listing costs nothing against the download quota —
  // a whole history is a handful of calls and a few seconds — so there is no
  // reason to remember where the last sync stopped. Nothing to fall behind,
  // nothing to reset, and an activity that shows up late (or was missed by an
  // older version, or removed by accident) is picked up by the next sync
  // without anyone having to know it happened.
  const activities = await listActivities(mcp, { note });
  report.found = activities.length;
  report.daysInspected = activities.length
    ? Math.ceil((Date.now() - activities[0].startTime) / DAY_MS)
    : 0;
  const maxStartSeen = activities.reduce((m, a) => Math.max(m, a.startTime), 0);

  // ── 2b. take over COROS's names ──
  //
  // For everything already in the library, before the filter below: a rename
  // in the COROS app changes nothing we would download, so a sync with nothing
  // new is exactly the one that has to carry it. Fresh activities get theirs
  // once they are imported.
  const renamed = takeCorosNames(db, userId, activities);
  if (renamed) {
    report.namesUpdated += renamed;
    note(`${renamed} name(s) updated from COROS`);
  }

  // ── 3. filter to what we do not have ──
  //
  // Two ways of already having something. COROS's own id, recorded when a sync
  // brought the activity in — and the start time, which catches the same ride
  // imported from a file before COROS was ever connected. The second check
  // matters more than it looks: our dedupe works on file content, so a ride
  // whose stored file differs by a byte from COROS's own copy would otherwise
  // land a second time, and a library built by hand would be downloaded all
  // over again at fifty files a day.
  const known = knownCorosIds(db, userId);
  const haveStart = knownStartSeconds(db, userId);
  const fresh = [];
  for (const act of activities) {
    if (act.id && known.has(act.id)) continue;
    if (haveStart.has(Math.floor(act.startTime / 1000))) { report.alreadyHave++; continue; }
    fresh.push(act);
  }
  if (report.alreadyHave) {
    note(`${report.alreadyHave} already in the library from an earlier import; not downloaded again`);
  }

  // Activities we listed but still owe the user. While this is non-empty the
  // high-water mark stays behind the oldest of them, so the next sync lists
  // them again rather than stepping over them for good.
  const deferred = [];

  if (!fresh.length) {
    note(`nothing new (${activities.length} listed, all known or already imported)`);
    return finishSync(db, account, report, { changed: false, maxStartSeen, deferred });
  }

  // ── 4. download and ingest, within quota ──
  let quotaUsed = quotaUsedToday(db, account);
  const importId = beginImportRecord(db, userId, {
    source: 'coros', filename: `COROS sync ${new Date().toISOString().slice(0, 10)}`, bytes: null,
  });

  try {
    for (let i = 0; i < fresh.length; i++) {
      const act = fresh[i];
      if (quotaUsed >= DAILY_FIT_QUOTA) {
        report.quotaExhausted = true;
        // Everything still in the list is owed, not skipped.
        deferred.push(...fresh.slice(i));
        note(`stopped at the daily limit of ${DAILY_FIT_QUOTA} FIT downloads; the rest will come tomorrow`);
        break;
      }

      let bytes = null;
      try {
        bytes = await downloadFit(mcp, act, { note });
      } catch (err) {
        // A transport-level failure is usually transient, so this one is owed.
        report.failed++;
        deferred.push(act);
        note(`download failed for ${describeActivity(act)}: ${err.message}`);
        continue;
      }
      // A clean "there is no file" is permanent — a retry gets the same answer,
      // so it must not hold the high-water mark back for ever.
      if (!bytes) { report.unavailable++; continue; }

      quotaUsed++;
      try {
        const ingest = await ingestBuffer(db, userId, bytes, {
          filename: `coros-${act.id}.fit`,
          source: 'coros',
        });
        report.downloaded++;
        report.imported += ingest.imported;
        report.merged += ingest.merged;
        report.duplicates += ingest.duplicates;
        report.failed += ingest.failed;

        const activityId = ingest.activityIds?.[ingest.activityIds.length - 1] || null;
        // Track the COROS id — this is what keeps future syncs from re-listing.
        if (act.id && activityId) {
          attachCorosId(db, userId, activityId, act.id);
        }
        note(`${describeActivity(act)}: ${summarise(ingest)}`, { activityId });
      } catch (err) {
        // The bytes arrived; our pipeline could not use them. Downloading them
        // again would spend quota on the same failure, so this one is not owed.
        report.failed++;
        note(`ingest failed for ${describeActivity(act)}: ${err.message}`);
      }
    }
  } finally {
    // The ones just imported had no row to name when the list came in.
    const named = takeCorosNames(db, userId, fresh);
    if (named) {
      report.namesUpdated += named;
      note(`${named} new activit${named === 1 ? 'y' : 'ies'} named from COROS`);
    }

    report.deferred = deferred.length;
    const summary = { ...report };
    delete summary.log;
    finishImportRecord(db, importId, {
      found: report.found,
      imported: report.imported,
      merged: report.merged,
      duplicates: report.duplicates,
      failed: report.failed,
      toJSON: () => ({ source: 'coros', provider: 'coros', ...summary, log: report.log.slice(-50) }),
    }, report.failed && !report.downloaded ? 'failed' : 'done');
  }

  return finishSync(db, account, report, {
    changed: report.imported + report.merged > 0, quotaUsed, maxStartSeen, deferred,
  });
}

function finishSync(db, account, report, { changed, quotaUsed = null, maxStartSeen = 0, deferred = [] }) {
  report.deferred = deferred.length;

  // The quota counter travels inside the status blob: it is per calendar day
  // (UTC), and written on every sync so an interrupted run still counts its
  // downloads. Yesterday's count must not carry into today, so it is inherited
  // only while the stored date is still the current one.
  const today = todayUtc();
  const previous = safeJson(account.last_sync_status_json);
  const carried = previous?.quotaDate === today ? previous.quotaUsed || 0 : 0;

  const status = {
    ...report,
    log: report.log.slice(-50),
    quotaDate: today,
    quotaUsed: quotaUsed ?? carried,
  };
  // last_synced_activity_ms is kept for the record — the newest activity this
  // account has ever shown us — but nothing reads it to decide what to fetch.
  // That is the point: there is no mark to get stuck behind.
  db.prepare(`UPDATE integration_accounts
      SET last_sync_at = ?, last_sync_status_json = ?,
          last_synced_activity_ms = MAX(COALESCE(last_synced_activity_ms, 0), ?), updated_at = ?
      WHERE id = ?`).run(
    Date.now(), JSON.stringify(status), maxStartSeen, Date.now(), account.id,
  );
  report.changed = changed;
  report.finishedAt = Date.now();
  return report;
}

/** The UTC calendar day, which is the day COROS's download quota resets on. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ─── COROS MCP tool wrappers ──────────────────────────────────────────────────

/**
 * Every activity COROS holds, walking backwards from today.
 *
 * `querySportRecords` answers one date window at a time and caps the answer at
 * `limit` with no cursor for the rest, so the window itself is the pagination:
 * the history is walked in slices, and any slice that comes back exactly full
 * might have been truncated, so it is halved and asked again, down to a single
 * day (the finest the date filter goes).
 *
 * The walk stops after a long enough silence — three empty slices, so most of a
 * year with nothing in it — which is the far end of the account's history.
 *
 * Results are keyed by id and sorted oldest-first, so a backfill that runs out
 * of quota gets through the oldest ones first and the newest arrive tomorrow.
 */
async function listActivities(mcp, { note } = {}) {
  const found = new Map();
  let emptyRun = 0;
  let day = dayNumber(Date.now());

  for (let slice = 0; slice < MAX_HISTORY_SLICES; slice++) {
    const toDay = day;
    const fromDay = toDay - HISTORY_SLICE_DAYS + 1;
    const count = await collectWindow(mcp, fromDay, toDay, found, { note });

    emptyRun = count ? 0 : emptyRun + 1;
    if (emptyRun >= EMPTY_SLICES_TO_STOP) break;
    day = fromDay - 1;
  }

  if (!found.size) note('COROS listed no activities at all');
  return [...found.values()].sort((a, b) => a.startTime - b.startTime);
}

/**
 * One window's records into `found`, subdividing when the answer comes back
 * full. Returns how many records the window held.
 */
async function collectWindow(mcp, fromDay, toDay, found, { note }) {
  const records = await queryWindow(mcp, dayStart(fromDay), dayStart(toDay));

  if (records.length >= LIST_LIMIT && toDay > fromDay) {
    // A full answer may have been cut off at the limit. Both halves are
    // strictly narrower, so this terminates at single days.
    const mid = fromDay + Math.floor((toDay - fromDay) / 2);
    return (await collectWindow(mcp, fromDay, mid, found, { note }))
      + (await collectWindow(mcp, mid + 1, toDay, found, { note }));
  }
  if (records.length >= LIST_LIMIT) {
    // One day with more activities than a single answer holds. Nothing left to
    // subdivide, so say so rather than silently dropping the remainder.
    note(`more than ${LIST_LIMIT} activities on ${toCorosDate(dayStart(fromDay))}; some may be missed`);
  }
  for (const record of records) found.set(record.id, record);
  return records.length;
}

/** UTC day number, and the millisecond that day starts on. */
function dayNumber(ms) { return Math.floor(ms / DAY_MS); }
function dayStart(day) { return day * DAY_MS; }

/**
 * One `querySportRecords` call over a date window.
 *
 * The tool's input schema was not documented offline; we send the filter names
 * the official README shows (date-based) and parse what comes back defensively.
 */
async function queryWindow(mcp, fromMs, toMs) {
  const since = toCorosDate(fromMs);
  const until = toCorosDate(toMs);

  // The real tool schema requires every parameter present (additionalProperties
  // shown in production) and dates as yyyyMMdd. sportTypeCodes 65535 = all.
  let response;
  try {
    response = await mcp.callTool('querySportRecords', {
      startDate: since,
      endDate: until,
      sportTypeCodes: [65535],
      minDistanceKm: null,
      maxDistanceKm: null,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      maxAveragePace: null,
      locationKeyword: null,
      limit: LIST_LIMIT,
    });
  } catch (err) {
    if (err instanceof McpError && err.httpStatus === 401) {
      throw new CorosSyncError('COROS login has expired — reconnect it', { authExpired: true });
    }
    throw new CorosSyncError(`could not list COROS activities: ${err.message}`);
  }

  if (response.isError) {
    throw new CorosSyncError(textOf(response) || 'querySportRecords returned an error');
  }

  // The tool answers in a fixed-width human-readable listing, not JSON — one
  // record like:
  //   1. Outdoor Run — 2026-08-29
  //      Location: Utrecht Run
  //      Time Window: startTimestamp=1788003762 | endTimestamp=1788005068
  //      LabelId: 479964017847205988 | SportType: 100
  // The LabelId is what the download tool wants, and startTimestamp (seconds)
  // tells us whether this record is newer than the last sync. "Location" is
  // misnamed: it is the activity's name — "<place> <sport>" by default, and
  // whatever the user typed once they rename it in the COROS app. Parsing text
  // from a vendor is fragile, so anything without a LabelId is skipped rather
  // than assumed complete.
  //
  // The payload sometimes arrives JSON-string-encoded (real quotes, literal
  // \n); unwrap that so the record parser sees normal newlines.
  let text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { text = JSON.parse(trimmed); } catch { /* already plain */ }
  }

  const foundRecords = [];
  for (const block of text.split(/\n(?=\d+\.\s)/)) {
    const labelMatch = block.match(/LabelId:\s*(\S+)/);
    const startMatch = block.match(/startTimestamp=(\d+)/);
    if (!labelMatch || !startMatch) continue;

    const start = Number(startMatch[1]) * 1000;
    // The download tool wants the sport code alongside the labelId.
    const sportMatch = block.match(/SportType:\s*(\d+)/);
    // No name line is no name, not a broken record.
    const nameMatch = block.match(/^[ \t]*Location:[ \t]*(.*?)[ \t]*$/m);
    foundRecords.push({
      id: labelMatch[1],
      sportCode: sportMatch ? Number(sportMatch[1]) : null,
      name: nameMatch?.[1] || null,
      startTime: start,
      raw: { label: block.trim() },
    });
  }

  return foundRecords;
}

/**
 * `downloadActivityFitFiles` for one activity. Returns FIT bytes, or null when
 * the server reported it has no file (manual activities etc).
 *
 * The tool takes labelId + sportType (required together), not a list of ids,
 * and returns at most `limit` files per call — one per call here.
 */
async function downloadFit(mcp, act, { note } = {}) {
  if (!act.sportCode) {
    note(`cannot download ${describeActivity(act)}: no sport type in the listing`);
    return null;
  }
  let response;
  try {
    response = await mcp.callTool('downloadActivityFitFiles', {
      labelId: act.id,
      sportType: act.sportCode,
      limit: 1,
    });
  } catch (err) {
    if (err instanceof McpError && err.httpStatus === 401) {
      throw new CorosSyncError('COROS login has expired — reconnect it', { authExpired: true });
    }
    throw err;
  }

  if (response.isError) {
    note(`COROS said no file for ${describeActivity(act)}: ${textOf(response)}`);
    return null;
  }

  return extractFitBytes(response);
}

/**
 * Pull binary FIT data out of whatever content shape the tool returned.
 *
 * MCP file content is a JSON block with a name and base64 data, or a text block
 * holding base64 with no wrapper, or (URL fallback) a link to fetch. We try
 * each, in order of how likely it is to be well-formed.
 */
function extractFitBytes(response) {
  for (const block of response.content || []) {
    // Resource-style block: { type: 'resource', resource: { blob: base64, mimeType } }
    if (block.type === 'resource' && block.resource?.blob) {
      const buf = Buffer.from(block.resource.blob, 'base64');
      if (looksLikeFit(buf)) return buf;
    }
    // Direct: { type: 'file', data: base64, ... } or { type: 'image', data: base64 }
    if ((block.type === 'file' || block.type === 'resource') && block.data) {
      const buf = Buffer.from(block.data, 'base64');
      if (looksLikeFit(buf)) return buf;
    }
    // Embedded resource wrapped in a contents array
    if (block.type === 'resource' && Array.isArray(block.resource?.contents)) {
      for (const c of block.resource.contents) {
        if (c.blob) {
          const buf = Buffer.from(c.blob, 'base64');
          if (looksLikeFit(buf)) return buf;
        }
        if (c.text && looksLikeFit(Buffer.from(c.text))) return Buffer.from(c.text, 'utf8');
      }
    }
    // Text block holding bare base64
    if (block.type === 'text' && block.text) {
      const stripped = block.text.replace(/\s+/g, '');
      if (stripped.length > 64 && /^[A-Za-z0-9+/=]+$/.test(stripped)) {
        const buf = Buffer.from(stripped, 'base64');
        if (looksLikeFit(buf)) return buf;
      }
    }
  }

  // Structured content sometimes carries the same data
  if (response.structuredContent) {
    const scan = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.data === 'string' && looksLikeFit(Buffer.from(obj.data, 'base64'))) {
        return Buffer.from(obj.data, 'base64');
      }
      if (typeof obj.blob === 'string' && looksLikeFit(Buffer.from(obj.blob, 'base64'))) {
        return Buffer.from(obj.blob, 'base64');
      }
      for (const v of Object.values(obj)) {
        const found = scan(v);
        if (found) return found;
      }
      return null;
    };
    const buf = scan(response.structuredContent);
    if (buf) return buf;
  }

  return null;
}

// The same content check the ingest pipeline uses, so a file is accepted here
// if and only if the pipeline would accept it: ".FIT" at offset 8.
function looksLikeFit(buf) {
  return Boolean(buf) && buf.length >= 12
    && sniff(buf.subarray(0, 4096)).kind === KINDS.FIT;
}

function textOf(response) {
  return (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .slice(0, 300) || null;
}

/** COROS date format: yyyyMMdd. */
function toCorosDate(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function describeActivity(act) {
  return `${act.id || 'unknown id'} (${new Date(act.startTime).toISOString().slice(0, 16)}Z)`;
}

function summarise(ingest) {
  const parts = [];
  if (ingest.imported) parts.push(`${ingest.imported} imported`);
  if (ingest.merged) parts.push(`${ingest.merged} merged`);
  if (ingest.duplicates) parts.push(`${ingest.duplicates} duplicate`);
  return parts.join(', ') || 'nothing new';
}

// ─── database helpers ──────────────────────────────────────────────────────────

/**
 * COROS activity ids we have already fetched.
 *
 * The activity row is the obvious place to look and the wrong one on its own:
 * deleting an activity in Fitberg drops that row while deliberately keeping the
 * original file, so a sync that consulted only activities would download the
 * deleted one again every single day. The originals store remembers the fetch
 * under the name the sync gave it, which makes a deletion stick and cost
 * nothing.
 */
function knownCorosIds(db, userId) {
  const ids = new Set();

  for (const row of db.prepare(
    "SELECT source_id FROM activities WHERE user_id = ? AND source = 'coros' AND source_id IS NOT NULL",
  ).all(userId)) {
    ids.add(row.source_id);
  }

  for (const row of db.prepare(
    "SELECT original_name FROM originals WHERE original_name LIKE 'coros-%.fit'",
  ).all()) {
    const match = /^coros-(.+)\.fit$/.exec(row.original_name || '');
    if (match) ids.add(match[1]);
  }

  return ids;
}

/**
 * Start times already in the library, to the second, whatever brought them in.
 *
 * COROS reports whole seconds and Fitberg stores milliseconds, so both are cut
 * to seconds before comparing. Checked against a real account: all 73 activities
 * COROS listed over 200 days matched a stored start time exactly, none of them
 * merely close, so this needs no fuzz around it.
 */
function knownStartSeconds(db, userId) {
  const rows = db.prepare('SELECT start_time FROM activities WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => Math.floor(Number(r.start_time) / 1000)));
}

/**
 * Apply the names COROS listed onto the activities they belong to, by the
 * rules in takeSourceName. Returns how many activities were renamed.
 *
 * An activity is found by its COROS id first — including the legs of a
 * multisport file, stored as `<id>#<n>` — and otherwise by start second, which
 * is how a ride imported before COROS was connected is recognised. Two
 * activities on the same second cannot be told apart, so neither is named.
 */
function takeCorosNames(db, userId, activities) {
  const named = activities.filter((a) => a.name);
  if (!named.length) return 0;

  const byId = new Map();
  const bySecond = new Map();
  for (const row of db.prepare(
    'SELECT id, name, dedupe_key, source, source_id, start_time FROM activities WHERE user_id = ?',
  ).all(userId)) {
    if (row.source === 'coros' && row.source_id) {
      const id = row.source_id.split('#')[0];
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
    const second = Math.floor(Number(row.start_time) / 1000);
    if (!bySecond.has(second)) bySecond.set(second, []);
    bySecond.get(second).push(row);
  }

  let renamed = 0;
  for (const act of named) {
    let rows = (act.id && byId.get(act.id)) || [];
    if (!rows.length) {
      const sameSecond = bySecond.get(Math.floor(act.startTime / 1000)) || [];
      if (sameSecond.length === 1) rows = sameSecond;
    }
    for (const row of rows) {
      if (takeSourceName(db, userId, row, 'coros', act.name)) renamed++;
    }
  }
  return renamed;
}

function attachCorosId(db, userId, activityId, corosId) {
  db.prepare('UPDATE activities SET source_id = ? WHERE id = ? AND user_id = ?')
    .run(corosId, activityId, userId);
}

/** How many FIT files this account has pulled down today (UTC), for the quota. */
function quotaUsedToday(db, account) {
  const status = account.last_sync_status_json ? safeJson(account.last_sync_status_json) : null;
  if (!status?.quotaDate || status.quotaDate !== todayUtc()) return 0;
  return status.quotaUsed || 0;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}