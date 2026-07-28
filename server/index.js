import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';

import { config, ensureDirs } from './lib/config.js';
import { getDb, describeDb } from './db/index.js';
import {
  parseCookies, readSession, SESSION_COOKIE, userCount, ensureDefaultUser,
  pruneSessions,
} from './lib/auth.js';
import { driverName } from './db/driver.js';

import { registerAuthRoutes } from './routes/auth.js';
import { registerActivityRoutes } from './routes/activities.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerExportRoutes } from './routes/export.js';

import { ollamaStatus } from './ai/ollama.js';

// Endpoints reachable without a session. Everything else requires one.
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/config',
  '/api/auth/state',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/logout',
]);

// Endpoints authenticated by API key instead of a session, so machines can push
// activities without holding a browser cookie.

export async function buildServer() {
  ensureDirs();
  const db = await getDb();
  pruneSessions(db);

  // Open-access mode has no login, so a user row must exist to own the data.
  if (config.openAccess) ensureDefaultUser(db);

  const app = Fastify({
    // Plain JSON logging, deliberately with no pino-pretty transport: it would be
    // another dependency to install and it fails hard when absent.
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        // Some clients can only authenticate with a query parameter (see the
        // auth hook). Strip it before anything reaches the log, or every push
        // would write a working API key to disk.
        req(request) {
          return {
            method: request.method,
            url: redactSecrets(request.url),
            remoteAddress: request.socket?.remoteAddress,
          };
        },
      },
    },
    // Uploads are the point of this app; a Strava export can be several GB.
    bodyLimit: 512 * 1024 * 1024,
    trustProxy: true,
  }).withTypeProvider();

  await app.register(fastifyMultipart, {
    limits: {
      // A FIT file is a few MB; the ceiling is really for a whole Strava export ZIP.
      fileSize: 4 * 1024 * 1024 * 1024,
      files: 50,
    },
  });

  // Raw-body support for the push endpoint, so a watch can POST a FIT file with
  // no multipart wrapper.
  app.addContentTypeParser(
    ['application/octet-stream', 'application/vnd.ant.fit', 'application/gpx+xml', 'application/xml'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.decorateRequest('cookies', null);
  app.decorateRequest('userId', null);

  // ─── authentication ─────────────────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    request.cookies = parseCookies(request.headers.cookie);

    const url = request.url.split('?')[0];

    // Non-API requests are the web app's own assets and its client-side routes.
    if (!url.startsWith('/api/')) return;

    if (PUBLIC_PATHS.has(url)) return;

    if (config.openAccess) {
      request.userId = ensureDefaultUser(db);
      return;
    }

    const session = readSession(db, request.cookies[SESSION_COOKIE]);
    if (!session) {
      return reply.code(401).send({
        error: 'Not signed in',
        initialised: userCount(db) > 0,
      });
    }
    request.userId = session.user_id;
  });

  // ─── routes ─────────────────────────────────────────────────────────────────

  app.get('/api/health', async () => ({
    ok: true,
    version: readVersion(),
    uptimeS: Math.round(process.uptime()),
  }));

  /** Public client configuration: map tiles, feature availability. */
  app.get('/api/config', async () => {
    const ai = await ollamaStatus();
    return {
      version: readVersion(),
      map: {
        styleUrl: config.map.styleUrl || null,
        terrainTileUrl: config.map.terrainTileUrl,
        terrainEncoding: config.map.terrainEncoding,
        terrainMaxZoom: config.map.terrainMaxZoom,
      },
      ai: { available: ai.available, model: ai.model || null, reason: ai.reason || null },
      openAccess: config.openAccess,
      publicUrl: config.publicUrl,
    };
  });

  app.get('/api/system', async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: 'Not signed in' });
    return {
      db: await describeDb(),
      driver: await driverName(),
      node: process.versions.node,
      platform: `${process.platform}/${process.arch}`,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      dataDir: config.dataDir,
      ai: await ollamaStatus(),
    };
  });

  registerAuthRoutes(app, { db });
  registerProfileRoutes(app, { db });
  registerActivityRoutes(app, { db });
  registerStatsRoutes(app, { db });
  registerImportRoutes(app, { db });
  registerAiRoutes(app, { db });
  registerExportRoutes(app, { db });

  // ─── the web app ────────────────────────────────────────────────────────────

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: ['index.html'] });

    // SPA fallback: client-side routes must resolve to index.html, but a missing
    // API path should still 404 as an API error rather than serving HTML.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: `No such endpoint: ${request.url}` });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: `No such endpoint: ${request.url}` });
      }
      return reply.code(503).type('text/html').send(missingBuildPage());
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) app.log.error({ err: error, url: request.url }, 'request failed');
    else app.log.warn({ url: request.url, msg: error.message }, 'request rejected');

    reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : error.message,
      // Surface the detail in development; it is the difference between a useful
      // bug report and a shrug.
      detail: status >= 500 && process.env.NODE_ENV !== 'production' ? error.message : undefined,
    });
  });

  return { app, db };
}

async function main() {
  const { app, db } = await buildServer();

  const ownerId = config.openAccess ? ensureDefaultUser(db)
    : db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? null;

  await app.listen({ port: config.port, host: config.host });

  app.log.info(`Fitberg ${readVersion()} on ${config.publicUrl}`);
  app.log.info(`data:   ${config.dataDir}`);
  app.log.info(`db:     ${await driverName()}`);

  if (config.sessionSecretIsEphemeral && !config.openAccess) {
    app.log.warn('SESSION_SECRET is not set — sessions will not survive a restart. '
      + 'Generate one with: openssl rand -hex 32');
  }
  if (!fs.existsSync(config.webDist)) {
    app.log.warn(`web app not built (${config.webDist} missing) — run: npm run build`);
  }
  if (!ownerId) {
    app.log.info('No account yet. Open the URL above to set one up.');
  }

  const stoppers = [];

  const shutdown = async (signal) => {
    app.log.info(`${signal} received, shutting down`);
    for (const stop of stoppers) { try { stop(); } catch { /* ignore */ } }
    try { await app.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Remove credential-bearing query parameters from a URL before logging it. */
export function redactSecrets(url) {
  return String(url).replace(/([?&](?:key|api_key|token)=)[^&]*/gi, '$1REDACTED');
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.projectRoot, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function missingBuildPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fitberg — web app not built</title>
<style>
 :root{color-scheme:light}
 body{margin:0;min-height:100vh;display:grid;place-items:center;
  font:16px/1.6 system-ui,sans-serif;background:#f9f9f7;color:#0b0b0b}
 div{max-width:34rem;padding:2rem}
 code{background:#0000000f;padding:.15em .4em;border-radius:4px;font-size:.9em}
 h1{font-size:1.3rem;margin:0 0 1rem}
</style></head><body><div>
<h1>The API is running, but the web app has not been built</h1>
<p>Build the front end and reload:</p>
<p><code>npm --prefix web install &amp;&amp; npm --prefix web run build</code></p>
<p>Or run the Vite dev server on port 5173 with <code>npm run dev:web</code>,
which proxies API calls here automatically.</p>
</div></body></html>`;
}

// Only start listening when executed directly, so tests can import buildServer().
const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  main().catch((err) => {
    console.error('Fitberg failed to start:');
    console.error(err);
    process.exit(1);
  });
}
