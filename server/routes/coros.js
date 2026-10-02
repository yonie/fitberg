import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import {
  discoverAuth, registerClient, buildAuthorizeUrl, exchangeCode,
  createPkce, revokeToken, chooseRedirectUri,
} from '../integrations/coros-oauth.js';
import { syncCoros, CorosSyncError, needsReconnect } from '../integrations/coros-sync.js';
import { createMcpClient } from '../integrations/mcp-client.js';

// COROS integration routes.
//
// The connect flow is OAuth 2.0 with dynamic client registration: Fitberg
// registers its own client with COROS at connect time, so there is no shared
// client_id baked into the source. The user's browser is sent to COROS's
// authorize page; the code comes back to our loopback callback.
//
// In-flight flows are held in memory (this module), keyed by state. A restart
// mid-flow loses the flow — the user clicks Connect again — which is fine for
// a once-ever operation.

/** Pending OAuth flows: state → { verifier, redirectUri, userId, clientId }. */
const pendingFlows = new Map();

export function registerCorosRoutes(app, { db }) {
  const redirectUri = chooseRedirectUri(config.publicUrl, config.port);

  /** Is anything connected, and how did the last sync go? */
  app.get('/api/integrations/coros', async (request) => {
    const account = getAccount(db, request.userId);
    if (!account) return { connected: false };

    return {
      connected: true,
      needsReconnect: needsReconnect(account),
      accountName: account.account_name,
      lastSyncAt: account.last_sync_at,
      lastSync: account.last_sync_status_json ? safeJson(account.last_sync_status_json) : null,
      autoSync: config.coros.autoSync,
    };
  });

  /** Start connecting: returns the URL to open in the browser. */
  app.post('/api/integrations/coros/connect', async (request, reply) => {
    const existing = getAccount(db, request.userId);
    if (existing?.refresh_token) {
      return reply.code(409).send({ error: 'COROS is already connected. Disconnect it first.' });
    }

    try {
      // 1. Find the authorization server from the MCP endpoint.
      const auth = await discoverAuth();

      // 2. Register a client for this instance (kept for reconnects/refreshes).
      const { clientId, clientSecret } = await registerClient(auth, {
        redirectUri, clientName: 'Fitberg',
      });

      // 3. Authorize URL with PKCE; state ties the callback to this flow.
      const state = crypto.randomBytes(16).toString('base64url');
      const pkce = createPkce();
      const url = buildAuthorizeUrl(auth, { clientId, redirectUri, state, pkce });

      // A second Connect replaces any abandoned flow for this user, so a
      // half-finished attempt never wedges the card.
      for (const [key, pending] of pendingFlows) {
        if (pending.userId === request.userId) pendingFlows.delete(key);
      }

      pendingFlows.set(state, {
        verifier: pkce.verifier,
        redirectUri,
        userId: request.userId,
        clientId,
        clientSecret,
        auth,
        createdAt: Date.now(),
      });

      // manual: the user finishes by pasting the address they landed on. Only
      // an https PUBLIC_URL (or a genuinely-local browser) gets a redirect that
      // comes back on its own.
      return { url, manual: !redirectUri.startsWith(`${config.publicUrl.replace(/\/$/, '')}/api/`) };
    } catch (err) {
      return reply.code(502).send({ error: `Could not reach COROS: ${err.message}` });
    }
  });

  /**
   * OAuth callback. COROS redirects here with ?code=...&state=...; we finish
   * the exchange and record the account. Rendered as HTML, because the user's
   * browser arrives here directly from COROS's page — this is not an API call
   * from our own front end.
   */
  app.get('/api/integrations/coros/callback', async (request, reply) => {
    const { code, state, error } = request.query;
    const closePage = (title, detail, ok) => reply.type('text/html').send(callbackPage(title, detail, ok));

    if (error) return closePage('COROS connection failed', error, false);

    const result = await completeFlow(db, String(code || ''), String(state || ''));
    if (result.ok) {
      return closePage('COROS connected',
        'You can close this tab and go back to Fitberg — the Import page now knows.', true);
    }
    return closePage(
      result.retry ? 'Finish connecting on the Import page' : 'COROS connection failed',
      result.error, !result.retry,
    );
  });

  /**
   * Finish a connect flow with a code the user typed (or a whole URL pasted —
   * both accepted). With the OOB redirect the user logs in on COROS's page,
   * which shows the authorization code; they copy it into the Import page. If
   * instead the browser was redirected somewhere with the code in the URL,
   * pasting that URL works identically. The code is single-use and bound to
   * the PKCE verifier of the one flow this user started, so completing it here
   * is the same security as a redirect-based finish.
   */
  app.post('/api/integrations/coros/complete', async (request, reply) => {
    const raw = String(request.body?.code || request.body?.url || '').trim();
    if (!raw) return reply.code(400).send({ error: 'Copy the address of the COROS page you landed on and paste it here.' });

    // A pasted URL carries the code (and maybe state) as query parameters.
    let code = raw;
    let state = String(request.body?.state || '');
    if (raw.includes('code=')) {
      const queryPart = raw.slice(raw.indexOf('?') + 1);
      const params = new URLSearchParams(queryPart);
      code = params.get('code') || code;
      state = state || params.get('state') || '';
    }

    // COROS sends a declined login back as ?error=... instead of a code. Say
    // so rather than reporting a confusing "no code" failure.
    if (raw.includes('error=')) {
      const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
      const why = params.get('error_description') || params.get('error') || 'COROS refused the connection';
      return reply.code(400).send({ error: `COROS declined: ${why}. Press Connect to try again.` });
    }

    const result = await completeFlow(db, code, state, request.userId);
    if (result.ok) return { ok: true };
    return reply.code(400).send({ error: result.error });
  });

  /**
   * Sync now. Every sync walks the whole history, so this is the same work the
   * background sync does — there is no other button, and nothing to reset.
   */
  app.post('/api/integrations/coros/sync', async (request, reply) => {
    const account = getAccount(db, request.userId);
    if (!account) return reply.code(404).send({ error: 'COROS is not connected' });

    try {
      const report = await syncCoros(db, request.userId, account);
      return { report };
    } catch (err) {
      const authExpired = err instanceof CorosSyncError && err.authExpired;
      return reply.code(authExpired ? 401 : 502).send({
        error: err.message,
        ...(authExpired ? { reconnect: true } : {}),
      });
    }
  });

  /** Disconnect: forget the tokens, and tell COROS to revoke them. */
  app.post('/api/integrations/coros/disconnect', async (request) => {
    const account = getAccount(db, request.userId);
    if (!account) return { ok: true };

    try {
      const auth = await discoverAuth();
      await revokeToken(auth, { clientId: account.client_id, refreshToken: account.refresh_token });
    } catch { /* best-effort */ }

    db.prepare('DELETE FROM integration_accounts WHERE id = ?').run(account.id);
    return { ok: true };
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Exchange a callback's code for tokens and record the account.
 *
 * The flow is found by state when we have one (redirect callback, pasted URL),
 * and otherwise by being the one in-flight flow for this user (typed code —
 * the OOB page shows the code, not the state). Multiple simultaneous flows per
 * user are not supported; a second Connect replaces the first's pending entry.
 */
async function completeFlow(db, code, state, userId = null) {
  let flow = null;
  if (state) {
    flow = pendingFlows.get(state);
    pendingFlows.delete(state);
  } else if (userId !== null) {
    for (const [key, pending] of pendingFlows) {
      if (pending.userId === userId) {
        flow = pending;
        pendingFlows.delete(key);
        break;
      }
    }
  }
  if (!flow) {
    return { ok: false, retry: true, error: 'This link is no longer valid — every approval code works once. Press Connect COROS and log in again.' };
  }
  if (!code) {
    return { ok: false, error: 'That address has no approval code in it yet. Log in and approve first — you will see the address change to one ending in ?code=…' };
  }

  try {
    const tokens = await exchangeCode(flow.auth, {
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: flow.redirectUri,
      code,
      verifier: flow.verifier,
    });

    // Who we just connected as, best-effort — it makes the UI say something
    // better than "account".
    let accountName = null;
    try {
      const mcp = createMcpClient(config.coros.mcpUrl, () => tokens.accessToken);
      await mcp.initialize();
      const info = await mcp.callTool('queryUserInfo', {});
      accountName = findName(info) || null;
    } catch { /* cosmetic only */ }

    upsertAccount(db, flow.userId, {
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      ...tokens,
      accountName,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getAccount(db, userId) {
  return db.prepare(
    "SELECT * FROM integration_accounts WHERE user_id = ? AND provider = 'coros'",
  ).get(userId);
}

function upsertAccount(db, userId, { clientId, clientSecret, accessToken, refreshToken, expiresAt, accountName }) {
  db.prepare(`INSERT INTO integration_accounts
      (user_id, provider, client_id, client_secret, access_token, refresh_token,
       token_expires_at, account_name, created_at, updated_at)
      VALUES (?, 'coros', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, provider) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at,
        account_name = excluded.account_name,
        updated_at = excluded.updated_at`)
    .run(userId, clientId, clientSecret, accessToken, refreshToken, expiresAt, accountName, Date.now(), Date.now());
}

/** Dig a display name out of a queryUserInfo response, whatever its shape. */
function findName(info) {
  const scan = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    for (const key of ['nickname', 'userName', 'username', 'name', 'email', 'account', 'displayName']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key];
    }
    for (const v of Object.values(obj)) {
      const found = scan(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const block of info?.content || []) {
    if (block.type === 'text' && block.text) {
      try { const found = scan(JSON.parse(block.text)); if (found) return found; } catch { /* not JSON */ }
    }
  }
  return scan(info?.structuredContent);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** A tiny standalone page for the OAuth callback — the user has no app open here. */
function callbackPage(title, detail, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 :root{color-scheme:light}
 body{margin:0;min-height:100vh;display:grid;place-items:center;
  font:16px/1.6 system-ui,sans-serif;background:#f9f9f7;color:#0b0b0b}
 div{max-width:34rem;padding:2rem;text-align:center}
 h1{font-size:1.3rem;margin:0 0 .5rem}
 p{color:#555;margin:0}
</style></head><body><div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}