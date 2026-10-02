// COROS connector tests, against a fake COROS.
//
// The fake speaks the real protocol shapes: a Streamable HTTP MCP endpoint that
// 401s without a bearer token and serves JSON-RPC with one, an authorization
// server with metadata, dynamic client registration, PKCE code exchange and
// refresh, and a FIT download tool that returns content blocks. The exact JSON
// of records and files is varied across tests, because the one certainty about
// COROS's real payloads is that they will drift.
//
// No network: everything runs on localhost sockets against the same code paths
// production uses (discovery, registration, sync), with config pointed at the
// fake.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitberg-coros-'));
process.env.DATA_DIR = DATA_DIR;
process.env.OLLAMA_ENABLED = '0';

const { syntheticRun, makeFit, BASE_TIME } = await import('./fixtures.js');

// ─── the fake COROS ───────────────────────────────────────────────────────────

/**
 * A fake COROS stack: MCP endpoint + OAuth AS on one origin.
 *
 * @param {object} opts
 * @param {Array}  opts.activities  [{ id, startTime, fit }] served by querySportRecords
 * @param {number} [opts.tokenTtlS]  access-token lifetime; short to test refresh
 */
function fakeCoros({ activities = [], tokenTtlS = 3600 } = {}) {
  const state = {
    activities,
    registrations: new Map(),   // client_id -> { redirectUris }
    codes: new Map(),          // code -> { clientId }
    tokens: new Map(),         // access_token -> { clientId, scopes }
    refreshTokens: new Map(),  // refresh_token -> { clientId }
    fitDownloads: 0,
    listCalls: 0,
  };
  const server = http.createServer(handler);
  const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = () => `http://127.0.0.1:${server.address().port}`;

  function handler(req, res) {
    const url = new URL(req.url, base());
    const reply = (status, json, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };

    if (req.method === 'POST' && url.pathname === '/mcp') return mcpEndpoint(req, res);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return reply(200, {
        resource: `${base()}/mcp`,
        authorization_servers: [base()],
        scopes_supported: ['openid', 'mcp.tools', 'offline_access'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return reply(200, asMetadata());
    }
    if (req.method === 'POST' && url.pathname === '/connect/register') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const json = JSON.parse(body);
        const clientId = crypto.randomUUID();
        state.registrations.set(clientId, { redirectUris: json.redirect_uris || [] });
        reply(200, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const grant = params.get('grant_type');

        if (grant === 'authorization_code') {
          const code = params.get('code');
          const stored = state.codes.get(code);
          if (!stored) return reply(400, { error: 'invalid_grant' });
          state.codes.delete(code);
          const access = crypto.randomBytes(24).toString('base64url');
          const refresh = crypto.randomBytes(24).toString('base64url');
          state.tokens.set(access, { clientId: stored.clientId });
          state.refreshTokens.set(refresh, { clientId: stored.clientId });
          return reply(200, {
            access_token: access, refresh_token: refresh,
            token_type: 'Bearer', expires_in: tokenTtlS, scope: 'openid mcp.tools offline_access',
          });
        }

        if (grant === 'refresh_token') {
          const refresh = params.get('refresh_token');
          const stored = state.refreshTokens.get(refresh);
          if (!stored) return reply(400, { error: 'invalid_grant' });
          const access = crypto.randomBytes(24).toString('base64url');
          const newRefresh = crypto.randomBytes(24).toString('base64url');
          state.tokens.set(access, stored);
          state.refreshTokens.delete(refresh);
          state.refreshTokens.set(newRefresh, stored);
          return reply(200, {
            access_token: access, refresh_token: newRefresh,
            token_type: 'Bearer', expires_in: tokenTtlS,
          });
        }
        return reply(400, { error: 'unsupported_grant_type' });
      });
      return;
    }
    reply(404, { error: 'not found' });
  }

  function asMetadata() {
    return {
      issuer: base(),
      authorization_endpoint: `${base()}/oauth2/authorize`,
      token_endpoint: `${base()}/oauth2/token`,
      registration_endpoint: `${base()}/connect/register`,
      revocation_endpoint: `${base()}/oauth2/revoke`,
      scopes_supported: ['openid', 'mcp.tools', 'offline_access'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  /** The MCP endpoint itself: bearer-gated JSON-RPC. */
  function mcpEndpoint(req, res) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token || !state.tokens.has(token)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp`,
      });
      return res.end();
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };

      if (msg.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-coros', version: '1' } });
      }
      if (msg.method === 'tools/list') {
        return reply({ tools: [{ name: 'querySportRecords' }, { name: 'downloadActivityFitFiles' }] });
      }
      if (msg.method === 'tools/call') {
        if (msg.params.name === 'querySportRecords') {
          // The real tool filters by the date window, answers newest first, and
          // cuts the answer off at `limit` with no cursor for the remainder.
          // The fake does all three: one that returned everything regardless
          // would make a sync that steps over an activity indistinguishable
          // from one that fetched it.
          const args = msg.params.arguments || {};
          const dayMs = (yyyymmdd) => {
            const text = String(yyyymmdd);
            return Date.parse(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00Z`);
          };
          const from = args.startDate ? dayMs(args.startDate) : -Infinity;
          const to = args.endDate ? dayMs(args.endDate) + 86400000 : Infinity;
          state.listCalls++;
          const selected = state.activities
            .filter((a) => a.meta.startTime >= from && a.meta.startTime < to)
            .sort((x, y) => y.meta.startTime - x.meta.startTime)
            .slice(0, args.limit ?? 100);

          // The real tool answers in a human-readable listing, not JSON; the
          // fake emits the same shape, one record per activity in the window.
          const lines = selected.map((a, i) => [
            `${i + 1}. ${a.meta.sport || 'Outdoor Run'} — ${new Date(a.meta.startTime).toISOString().slice(0, 10)}`,
            '   Location: Fake',
            `   Time Window: startTimestamp=${Math.floor(a.meta.startTime / 1000)} | endTimestamp=${Math.floor(a.meta.startTime / 1000) + 1000}`,
            `   LabelId: ${a.meta.id} | SportType: ${a.meta.sportCode || 100}`,
          ].join('\n'));
          return reply({ content: [{ type: 'text', text: lines.join('\n\n') }] });
        }
        if (msg.params.name === 'downloadActivityFitFiles') {
          // The real tool takes labelId + sportType (required together).
          const { labelId, sportType } = msg.params.arguments;
          if (!labelId || !sportType) {
            return reply({ content: [{ type: 'text', text: 'labelId and sportType are required' }], isError: true });
          }
          const files = state.activities.filter((a) => a.meta.id === labelId);
          if (!files.length) {
            return reply({ content: [{ type: 'text', text: 'no such activity' }], isError: true });
          }
          // Manual entries and some third-party imports have no file behind
          // them; COROS answers the download call with an error, for ever.
          if (files.every((a) => a.meta.noFile)) {
            return reply({ content: [{ type: 'text', text: 'no FIT file for this activity' }], isError: true });
          }
          state.fitDownloads += files.length;
          // The resource-block shape with a base64 blob.
          return reply({
            content: files.map((a) => ({
              type: 'resource',
              resource: {
                uri: `coros://activity/${a.meta.id}/fit`,
                blob: a.fit.toString('base64'),
                mimeType: 'application/vnd.ant.fit',
              },
            })),
          });
        }
        return reply({ content: [{ type: 'text', text: 'unknown tool' }], isError: true });
      }
      reply({});
    });
  }

  return {
    state, listen, base, server,
    /** Mint an authorization code for a client, as the authorize page would. */
    issueCode(clientId) {
      const code = crypto.randomBytes(16).toString('base64url');
      state.codes.set(code, { clientId });
      return code;
    },
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

// One fake, one Fitberg data dir, shared across tests in sequence.
//
// Everything that needs the fake's URL — including the dynamic imports, because
// config.js reads COROS_MCP_URL once at import — is set up in before(). Under
// node:test's default process isolation, module evaluation and test execution
// can happen in different processes, so a socket bound at evaluation time is
// not guaranteed to be the one tests talk to.
const fake = fakeCoros();
let db, USER, syncCoros, CorosSyncError, needsReconnect, discoverAuth, registerClient, createPkce,
  buildAuthorizeUrl, exchangeCode, chooseRedirectUri, truncateDerived, ingestBuffer;

before(async () => {
  await fake.listen();
  process.env.COROS_MCP_URL = `${fake.base()}/mcp`;

  const modules = await import('./coros-setup.js');
  db = modules.db;
  USER = modules.USER;
  syncCoros = modules.syncCoros;
  CorosSyncError = modules.CorosSyncError;
  needsReconnect = modules.needsReconnect;
  discoverAuth = modules.discoverAuth;
  registerClient = modules.registerClient;
  createPkce = modules.createPkce;
  buildAuthorizeUrl = modules.buildAuthorizeUrl;
  exchangeCode = modules.exchangeCode;
  chooseRedirectUri = modules.chooseRedirectUri;
  truncateDerived = modules.truncateDerived;
  ingestBuffer = modules.ingestBuffer;
});

after(async () => {
  await new Promise((resolve) => fake.server.close(resolve));
});

function reset() {
  truncateDerived(db);
  db.prepare('DELETE FROM originals').run();
  db.prepare('DELETE FROM integration_accounts').run();
  const originals = path.join(DATA_DIR, 'originals');
  fs.rmSync(originals, { recursive: true, force: true });
  fs.mkdirSync(originals, { recursive: true });
  fake.state.fitDownloads = 0;
  fake.state.listCalls = 0;
}

/** Run a full connect flow against the fake, returning a connected account row. */
async function connectAccount(name = 'Test Runner') {
  const auth = await discoverAuth({ mcpUrl: `${fake.base()}/mcp` });
  const redirectUri = 'http://localhost:8710/api/integrations/coros/callback';
  const { clientId } = await registerClient(auth, { redirectUri, clientName: 'Fitberg' });

  const pkce = createPkce();
  const state = crypto.randomBytes(8).toString('hex');
  const url = buildAuthorizeUrl(auth, { clientId, redirectUri, state, pkce });
  assert.match(url, /code_challenge_method=S256/);
  assert.match(url, /resource=/);

  const code = fake.issueCode(clientId);
  const tokens = await exchangeCode(auth, {
    clientId, redirectUri, code, verifier: pkce.verifier,
  });
  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);

  db.prepare(`INSERT INTO integration_accounts
      (user_id, provider, client_id, access_token, refresh_token, token_expires_at, account_name, created_at, updated_at)
      VALUES (?, 'coros', ?, ?, ?, ?, ?, ?, ?)`)
    .run(USER, clientId, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, name, Date.now(), Date.now());

  return db.prepare('SELECT * FROM integration_accounts WHERE user_id = ? AND provider = ?')
    .get(USER, 'coros');
}

/** The connected account row for the test user. */
function corosAccount() {
  return db.prepare("SELECT * FROM integration_accounts WHERE user_id = ? AND provider = 'coros'")
    .get(USER);
}

test('coros: redirect URI choice — https when available, the COROS site otherwise', () => {
  // Loopback is the only plain-http redirect COROS accepts. Every other
  // deployment — a LAN address, no PUBLIC_URL at all — sends the browser to
  // COROS's own site, and the user pastes the address they land on back into
  // the Import page.
  assert.equal(
    chooseRedirectUri('https://fitberg.example.com', 8710),
    'https://fitberg.example.com/api/integrations/coros/callback',
  );
  assert.equal(
    chooseRedirectUri('http://localhost:8710', 8710),
    'http://localhost:8710/api/integrations/coros/callback',
  );
  assert.equal(
    chooseRedirectUri('http://192.168.1.129:8710', 8710),
    'https://www.coros.com/',
  );
  assert.equal(
    chooseRedirectUri(undefined, 9999),
    'https://www.coros.com/',
  );
});

test('coros: discovery and DCR against a fresh fake', async () => {
  const auth = await discoverAuth({ mcpUrl: `${fake.base()}/mcp` });
  assert.equal(auth.issuer, fake.base());
  assert.ok(auth.authorizationEndpoint.includes('/oauth2/authorize'));
  assert.deepEqual(auth.scopesSupported, ['openid', 'mcp.tools', 'offline_access']);

  const { clientId } = await registerClient(auth, {
    redirectUri: 'http://localhost:8710/api/integrations/coros/callback',
  });
  assert.ok(clientId);
  assert.ok(fake.state.registrations.has(clientId));
});

test('coros: sync imports new activities as FIT files', async () => {
  reset();
  const run1 = makeFit(syntheticRun({ n: 600, speed: 3.0, startMs: BASE_TIME }));
  const run2 = makeFit(syntheticRun({ n: 400, speed: 2.8, startMs: BASE_TIME + 86400000 }));
  fake.state.activities = [
    { meta: { id: '1001', startTime: BASE_TIME, distance: 1800, sport: 'running' }, fit: run1 },
    { meta: { id: '1002', startTime: BASE_TIME + 86400000, distance: 1120, sport: 'running' }, fit: run2 },
  ];

  const account = await connectAccount();
  const report = await syncCoros(db, USER, account);

  assert.equal(report.found, 2);
  assert.equal(report.downloaded, 2);
  assert.equal(report.imported, 2);
  assert.equal(fake.state.fitDownloads, 2);

  // source_id is stored for both, so the next sync does not re-list them
  const ids = db.prepare("SELECT source_id FROM activities WHERE user_id = ? AND source = 'coros' ORDER BY start_time")
    .all(USER).map((r) => r.source_id);
  assert.deepEqual(ids, ['1001', '1002']);
});

test('coros: a second sync is a no-op (ids remembered, dedupe as backstop)', async () => {
  const account = corosAccount();
  const report = await syncCoros(db, USER, account);

  // The whole history is listed again, every time; both ids are known, so
  // nothing is downloaded.
  assert.equal(report.found, 2);
  assert.equal(report.downloaded, 0);
  assert.equal(report.imported, 0);
  assert.equal(fake.state.fitDownloads, 2, 'no further downloads');
});

test('coros: new activity appears on a later sync, duplicates collapse', async () => {
  const run3 = makeFit(syntheticRun({ n: 300, speed: 3.2, startMs: BASE_TIME + 2 * 86400000 }));
  fake.state.activities.push({ meta: { id: '1003', startTime: BASE_TIME + 2 * 86400000, distance: 960, sport: 'running' }, fit: run3 });

  const report = await syncCoros(db, USER, corosAccount());

  // All three listed, one of them new.
  assert.equal(report.found, 3);
  assert.equal(report.downloaded, 1);
  assert.equal(report.imported, 1);
  assert.equal(fake.state.fitDownloads, 3);
});

test('coros: token refresh mid-life works and is persisted', async () => {
  reset();
  const run = makeFit(syntheticRun({ n: 200, speed: 3.0 }));
  fake.state.activities = [{ meta: { id: '2001', startTime: BASE_TIME }, fit: run }];

  // Connect with a short-lived token, then let it expire.
  const account = await connectAccount('Refresh Tester');
  // Force expiry.
  db.prepare('UPDATE integration_accounts SET token_expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, account.id);

  const report = await syncCoros(db, USER, corosAccount());
  assert.equal(report.imported, 1);
  // The stored token changed from the expired one.
  const updated = db.prepare('SELECT * FROM integration_accounts WHERE id = ?').get(account.id);
  assert.notEqual(updated.access_token, account.access_token);
  assert.ok(updated.token_expires_at > Date.now());
});

test('coros: a refresh token COROS rejects becomes a reconnect, not a retry loop', async () => {
  reset();
  const account = await connectAccount('Revoked Tester');
  db.prepare('UPDATE integration_accounts SET token_expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, account.id);
  // COROS forgets the refresh token (revoked, or expired on their side).
  fake.state.refreshTokens.clear();

  await assert.rejects(
    () => syncCoros(db, USER, corosAccount()),
    (err) => err instanceof CorosSyncError && err.authExpired,
  );
  const after = corosAccount();
  assert.equal(after.refresh_token, null);
  assert.equal(after.access_token, null);
  assert.equal(needsReconnect(after), true);
});

test('coros: quota stops a large backfill and it resumes next sync', async () => {
  reset();
  // 60 activities over two and a half days, but a quota of 50: the sync stops
  // at 50 and the other 10 have to survive until tomorrow.
  fake.state.activities = Array.from({ length: 60 }, (_, i) => ({
    meta: { id: `q${i}`, startTime: BASE_TIME + i * 3600000 },
    fit: makeFit(syntheticRun({ n: 60, speed: 3.0, startMs: BASE_TIME + i * 3600000 })),
  }));

  const account = await connectAccount('Quota Tester');
  const first = await syncCoros(db, USER, account);

  assert.equal(first.found, 60);
  assert.equal(first.downloaded, 50);
  assert.equal(first.quotaExhausted, true);
  assert.equal(first.deferred, 10, 'the ten it could not fetch are owed, not skipped');
  assert.equal(fake.state.fitDownloads, 50);

  const status = JSON.parse(corosAccount().last_sync_status_json);
  assert.equal(status.quotaUsed, 50);
  assert.equal(status.quotaDate, new Date().toISOString().slice(0, 10));

  // Tomorrow: the daily counter has rolled over. Nothing else changes — the
  // next sync lists the same history and simply sees what is still missing.
  const rolled = JSON.parse(corosAccount().last_sync_status_json);
  rolled.quotaDate = '2000-01-01';
  db.prepare('UPDATE integration_accounts SET last_sync_status_json = ? WHERE id = ?')
    .run(JSON.stringify(rolled), corosAccount().id);

  const second = await syncCoros(db, USER, corosAccount());
  assert.equal(second.downloaded, 10);
  assert.equal(second.deferred, 0);
  assert.equal(fake.state.fitDownloads, 60);

  const stored = db.prepare(
    "SELECT COUNT(*) AS c FROM activities WHERE user_id = ? AND source = 'coros'",
  ).get(USER).c;
  assert.equal(stored, 60, 'every activity arrives across the two syncs');
});

test('coros: the daily quota counter does not carry into the next day', async () => {
  reset();
  fake.state.activities = [
    { meta: { id: 'd1', startTime: BASE_TIME }, fit: makeFit(syntheticRun({ n: 80, speed: 3.0, startMs: BASE_TIME })) },
  ];
  const account = await connectAccount('Rollover Tester');
  await syncCoros(db, USER, account);

  // Yesterday ended on a full quota.
  const yesterday = JSON.parse(corosAccount().last_sync_status_json);
  yesterday.quotaDate = '2000-01-01';
  yesterday.quotaUsed = 50;
  db.prepare('UPDATE integration_accounts SET last_sync_status_json = ? WHERE id = ?')
    .run(JSON.stringify(yesterday), account.id);

  // Today's first sync finds nothing new. It must not stamp yesterday's count
  // onto today, or the rest of the day is spent believing the quota is gone.
  const quiet = await syncCoros(db, USER, corosAccount());
  assert.equal(quiet.downloaded, 0);
  const afterQuiet = JSON.parse(corosAccount().last_sync_status_json);
  assert.equal(afterQuiet.quotaDate, new Date().toISOString().slice(0, 10));
  assert.equal(afterQuiet.quotaUsed, 0, "yesterday's count does not become today's");

  // So a ride that lands later the same day still comes down.
  const fresh = Date.now() - 3600000;
  fake.state.activities.push({
    meta: { id: 'd2', startTime: fresh },
    fit: makeFit(syntheticRun({ n: 80, speed: 3.0, startMs: fresh })),
  });
  const later = await syncCoros(db, USER, corosAccount());
  assert.equal(later.downloaded, 1);
  assert.equal(later.quotaExhausted, false);
});

test('coros: a window holding more activities than one answer is split up', async () => {
  reset();
  // 120 activities over three days. One answer holds 100 and there is no
  // cursor for the rest, so the window itself has to be subdivided.
  fake.state.activities = Array.from({ length: 120 }, (_, i) => {
    const startMs = BASE_TIME + Math.floor(i / 40) * 86400000 + (i % 40) * 1800000;
    return {
      meta: { id: `p${i}`, startTime: startMs },
      fit: makeFit(syntheticRun({ n: 30, speed: 3.0, startMs })),
    };
  });

  const account = await connectAccount('Paging Tester');
  const report = await syncCoros(db, USER, account);

  assert.equal(report.found, 120, 'every activity is listed, not just the first 100');
  assert.equal(report.downloaded, 50, 'the daily quota still applies');
  assert.equal(report.deferred, 70, 'the rest are owed, and the mark stays behind them');
  assert.ok(fake.state.listCalls > 1, 'the full window was asked for in pieces');
});

test('coros: an activity COROS has no file for does not stall the sync', async () => {
  reset();
  const secondStart = BASE_TIME + 86400000;
  fake.state.activities = [
    {
      meta: { id: 'nf1', startTime: BASE_TIME, noFile: true },
      fit: makeFit(syntheticRun({ n: 40, speed: 3.0, startMs: BASE_TIME })),
    },
    {
      meta: { id: 'nf2', startTime: secondStart },
      fit: makeFit(syntheticRun({ n: 40, speed: 3.0, startMs: secondStart })),
    },
  ];

  const account = await connectAccount('No File Tester');
  const report = await syncCoros(db, USER, account);

  assert.equal(report.unavailable, 1);
  assert.equal(report.imported, 1);
  assert.equal(report.deferred, 0, 'a missing file is permanent, so nothing is owed');

  // A later sync asks again — free, and it would pick the file up if COROS
  // ever produced one — but it must not import anything twice.
  const again = await syncCoros(db, USER, corosAccount());
  assert.equal(again.unavailable, 1);
  assert.equal(again.imported, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM activities WHERE user_id = ? AND source = 'coros'").get(USER).c, 1,
  );
});

test('coros: a ride already in the library is skipped, not downloaded again', async () => {
  reset();
  const startMs = BASE_TIME + 5 * 86400000;
  // The same ride, already in Fitberg from a file import, and not byte-for-byte
  // what COROS would hand over — so content dedupe alone would not catch it and
  // the library would end up holding the ride twice.
  await ingestBuffer(db, USER, makeFit(syntheticRun({ n: 300, speed: 3.1, startMs })), {
    filename: 'from-a-file.fit', source: 'file',
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activities WHERE user_id = ?').get(USER).c, 1);

  fake.state.activities = [{
    meta: { id: 'dup1', startTime: startMs },
    fit: makeFit(syntheticRun({ n: 500, speed: 2.9, startMs })),
  }];

  const account = await connectAccount('Duplicate Tester');
  const report = await syncCoros(db, USER, account);

  assert.equal(report.alreadyHave, 1);
  assert.equal(report.downloaded, 0);
  assert.equal(fake.state.fitDownloads, 0, 'not even fetched');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM activities WHERE user_id = ?').get(USER).c, 1,
    'no second copy of a ride already held',
  );
});

test('coros: an activity that turns up late is fetched with nothing to press', async () => {
  reset();
  const older = BASE_TIME;
  const newer = BASE_TIME + 3 * 86400000;
  const build = (startMs) => makeFit(syntheticRun({ n: 200, speed: 3.0, startMs }));

  // The first sync only hears about the newer one.
  fake.state.activities = [{ meta: { id: 'late-b', startTime: newer }, fit: build(newer) }];
  const account = await connectAccount('Late Arrival Tester');
  await syncCoros(db, USER, account);
  assert.equal(fake.state.fitDownloads, 1);

  // Then an older one appears: a gap an earlier version left behind, an
  // activity restored on the watch, a ride uploaded days after the fact. It is
  // older than everything already fetched, which is exactly the case a
  // "carry on from where I stopped" sync can never see again.
  fake.state.activities.unshift({ meta: { id: 'late-a', startTime: older }, fit: build(older) });
  const second = await syncCoros(db, USER, corosAccount());

  assert.equal(second.found, 2, 'the whole history is listed, not just what is new');
  assert.equal(second.downloaded, 1, 'the older one is fetched, without anything being reset');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activities WHERE user_id = ?').get(USER).c, 2);
});

test('coros: an activity deleted in Fitberg is not fetched all over again', async () => {
  reset();
  const startMs = BASE_TIME + 8 * 86400000;
  fake.state.activities = [{
    meta: { id: 'del1', startTime: startMs },
    fit: makeFit(syntheticRun({ n: 200, speed: 3.0, startMs })),
  }];

  const account = await connectAccount('Deletion Tester');
  await syncCoros(db, USER, account);
  assert.equal(fake.state.fitDownloads, 1);

  // Deleting an activity in Fitberg means "hide this from my history"; the
  // original file stays in the store. Every sync lists the whole history, so
  // without a memory of the fetch this would come down again daily.
  db.prepare("DELETE FROM activities WHERE user_id = ? AND source = 'coros'").run(USER);

  const second = await syncCoros(db, USER, corosAccount());
  assert.equal(second.downloaded, 0, 'the deletion stands, and costs no quota');
  assert.equal(fake.state.fitDownloads, 1);
});

test('coros: wrong bearer is an auth error, not a crash', async () => {
  reset();
  db.prepare(`INSERT INTO integration_accounts
      (user_id, provider, client_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
      VALUES (?, 'coros', 'x', 'forged', NULL, ?, ?, ?)`)
    .run(USER, Date.now() + 3600000, Date.now(), Date.now());

  await assert.rejects(
    () => syncCoros(db, USER, corosAccount()),
    /Unauthorized|HTTP 401|initialize/,
  );
});

test('coros: SSE-framed responses are parsed like JSON ones', async () => {
  // Re-point the sync at an SSE-flavoured endpoint: same fake, one flag.
  // Covered by mcp-client parse; here we check the client side directly.
  const { createMcpClient } = await import('../server/integrations/mcp-client.js');

  const sseServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive\n\n');
    res.write('event: message\n');
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hello' }] } })}\n\n`);
    res.end();
  });
  await new Promise((r) => sseServer.listen(0, '127.0.0.1', r));
  try {
    const client = createMcpClient(`http://127.0.0.1:${sseServer.address().port}/mcp`, () => 'any-token');
    await client.initialize();
    const result = await client.callTool('anything', {});
    assert.equal(result.content[0].text, 'hello');
  } finally {
    sseServer.close();
    await new Promise((r) => sseServer.on('close', r));
  }
});

// (The fake server is closed by the test.after hook registered above.)