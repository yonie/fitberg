import crypto from 'node:crypto';
import { config } from '../lib/config.js';

// OAuth 2.0 for COROS MCP, per the RFCs the server actually implements:
//  - RFC 8414 (authorization server metadata)
//  - RFC 9728 (protected resource metadata — this is what the 401 points at)
//  - RFC 7591 (dynamic client registration)
//  - RFC 7636 (PKCE, S256 — the only method COROS supports)
//  - RFC 8707 (resource parameter, so the token is bound to the MCP endpoint)
//
// Flow: metadata discovery → dynamic client registration → authorize (browser)
// → the code comes back on whichever redirect chooseRedirectUri picked → token
// exchange. Refresh tokens are stored; access tokens are 2 h and refreshed on
// demand.
//
// The device grant exists in metadata but returns an empty 401 for every client
// we tried (verified 2026-08-30), so it is not attempted.

const METADATA_TIMEOUT_MS = 15000;

export class CorosAuthError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'CorosAuthError';
    this.cause = cause;
  }
}

async function fetchJson(url, opts = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), ...opts });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok) {
    const detail = json?.error_description || json?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new CorosAuthError(`COROS ${new URL(url).pathname}: ${detail}`);
  }
  if (!json) throw new CorosAuthError(`COROS ${new URL(url).pathname}: not JSON`);
  return json;
}

/**
 * Discover the authorization server for an MCP endpoint.
 *
 * The MCP server 401s unauthenticated requests with a WWW-Authenticate header
 * pointing at its protected-resource metadata, which points at the AS. Both
 * documents are cached — they are stable — and the redirect target is followed
 * once so all later calls hit the regional server directly (mcp.coros.com is a
 * redirector; following it per request is needlessly slow).
 */
export async function discoverAuth({ mcpUrl, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = mcpUrl || config.coros.mcpUrl;

  // 1. Ask the MCP endpoint where its AS is. An unauthenticated POST returns
  //    401 + WWW-Authenticate with the resource metadata URL.
  const probe = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fitberg', version: '1.0.0' } },
    }),
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (probe.status !== 401) {
    // Already-authorised (should not happen) or a proxy in the way. Still try
    // the well-known paths derived from the endpoint origin.
    return discoverFromOrigin(new URL(endpoint).origin, { fetchImpl });
  }

  const challenge = probe.headers.get('www-authenticate') || '';
  const match = challenge.match(/resource_metadata="([^"]+)"/);
  const resourceUrl = match
    ? match[1]
    : `${new URL(endpoint).origin}/.well-known/oauth-protected-resource/mcp`;

  // 2. Protected-resource metadata names the authorization server.
  const resource = await fetchJson(resourceUrl, {}, fetchImpl);
  const issuers = resource.authorization_servers || [];
  const issuer = issuers[0];
  if (!issuer) throw new CorosAuthError('COROS did not name an authorization server');

  // 3. AS metadata gives us every endpoint and the supported scopes.
  const as = await fetchJson(
    issuer.replace(/\/$/, '') + '/.well-known/oauth-authorization-server',
    {}, fetchImpl,
  );

  return {
    issuer: as.issuer || issuer.replace(/\/$/, ''),
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    revocationEndpoint: as.revocation_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scopesSupported: as.scopes_supported || ['openid', 'mcp.tools', 'offline_access'],
    // The resource the token must be bound to (RFC 8707) — the MCP endpoint as
    // the server sees it, not the redirecting alias we dialled.
    resource: resource.resource || endpoint,
  };
}

/** Fallback discovery when the MCP endpoint did not answer 401 as expected. */
async function discoverFromOrigin(origin, { fetchImpl }) {
  const base = origin.replace(/\/$/, '');
  const resource = await fetchJson(`${base}/.well-known/oauth-protected-resource/mcp`, {}, fetchImpl);
  const issuer = (resource.authorization_servers || [])[0];
  if (!issuer) throw new CorosAuthError('COROS did not name an authorization server');
  const as = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, {}, fetchImpl);
  return {
    issuer: as.issuer || issuer.replace(/\/$/, ''),
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    revocationEndpoint: as.revocation_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scopesSupported: as.scopes_supported || ['openid', 'mcp.tools', 'offline_access'],
    resource: resource.resource || `${base}/mcp`,
  };
}

/**
 * The redirect URI to register and use.
 *
 * Three regimes:
 *
 *  - PUBLIC_URL is https (a reverse proxy in front): that is the redirect, and
 *    the browser lands straight back on Fitberg with nothing left to do.
 *  - PUBLIC_URL is loopback, so Fitberg is running on the browsing machine
 *    itself: the same, over http, which COROS accepts for loopback alone.
 *  - Anything else — a LAN address, or no PUBLIC_URL at all — has no redirect
 *    COROS will agree to, so we register COROS's own website instead. After
 *    approval the browser lands on their homepage with the code in the address
 *    bar, and the user pastes that address into the Import page, which finishes
 *    the exchange. Verified live: their registration endpoint takes any https
 *    URL and rejects every plain-http one that is not loopback.
 */
export function chooseRedirectUri(publicUrl, port) {
  if (publicUrl && publicUrl.startsWith('https://')) {
    return `${publicUrl.replace(/\/$/, '')}/api/integrations/coros/callback`;
  }
  if (publicUrl && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(publicUrl)) {
    return `${publicUrl.replace(/\/$/, '')}/api/integrations/coros/callback`;
  }
  // Their friendly homepage rather than an error page: no alarm, and the code
  // is right there in the address bar for the manual step the Import page walks
  // the user through.
  return 'https://www.coros.com/';
}

/**
 * Register an OAuth client for this Fitberg instance (RFC 7591). COROS's server
 * is an OpenID-style implementation that wants redirect_uris present even for
 * flows that never use them, and response_types non-empty.
 *
 * Returns { clientId, clientSecret? } — public client, secret not issued.
 */
export async function registerClient(auth, { redirectUri, clientName = 'Fitberg', fetchImpl = globalThis.fetch } = {}) {
  if (!auth.registrationEndpoint) throw new CorosAuthError('COROS has no registration endpoint');
  if (!redirectUri) throw new CorosAuthError('A redirect URI is required');

  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: auth.scopesSupported.join(' '),
  };

  const json = await fetchJson(auth.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, fetchImpl);

  if (!json.client_id) throw new CorosAuthError('COROS registration returned no client_id');
  return { clientId: json.client_id, clientSecret: json.client_secret || null };
}

/** PKCE pair. */
export function createPkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * The URL the user's browser is sent to. `state` is opaque to COROS and is
 * echoed back on the callback, where we match it to the pending flow.
 */
export function buildAuthorizeUrl(auth, { clientId, redirectUri, state, pkce, scopeOverride = null } = {}) {
  const url = new URL(auth.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopeOverride || auth.scopesSupported.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (auth.resource) url.searchParams.set('resource', auth.resource);
  return url.toString();
}

/**
 * Exchange the authorization code for tokens. This is the only call that needs
 * the verifier, and it is made exactly once per flow — COROS codes are
 * single-use.
 */
export async function exchangeCode(auth, { clientId, clientSecret, redirectUri, code, verifier, fetchImpl = globalThis.fetch }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  if (auth.resource) params.set('resource', auth.resource);

  const json = await fetchJson(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  }, fetchImpl);

  if (!json.access_token) throw new CorosAuthError('COROS returned no access token');
  return normaliseTokens(json);
}

/** Use the refresh token to get a fresh access token. */
export async function refreshTokens(auth, { clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  if (auth.resource) params.set('resource', auth.resource);

  const json = await fetchJson(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  }, fetchImpl);

  if (!json.access_token) throw new CorosAuthError('COROS returned no access token');
  return normaliseTokens(json);
}

/** Revoke the refresh token on disconnect, best-effort. */
export async function revokeToken(auth, { clientId, refreshToken, fetchImpl = globalThis.fetch }) {
  if (!auth.revocationEndpoint || !refreshToken) return;
  const params = new URLSearchParams({ token: refreshToken, client_id: clientId });
  try {
    await fetchImpl(auth.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch { /* best-effort by design */ }
}

/** Standardise a token response into what the database stores. */
export function normaliseTokens(json) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    // Refresh in advance of the expiry, so a sync never starts with a dead token.
    expiresAt: Date.now() + (json.expires_in ? Math.max(0, json.expires_in - 300) * 1000 : 3600 * 1000),
    scope: json.scope || null,
  };
}