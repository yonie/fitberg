// Shared setup for the COROS connector tests.
//
// Imported from coros.test.js inside its before() hook, after the fake COROS
// server's URL is known and written to COROS_MCP_URL — the config module reads
// that variable once at import time, so the import order is the whole point of
// this file existing.

const { getDb, truncateDerived } = await import('../server/db/index.js');
const { discoverAuth, registerClient, createPkce, buildAuthorizeUrl, exchangeCode, chooseRedirectUri } =
  await import('../server/integrations/coros-oauth.js');
const { syncCoros, CorosSyncError, needsReconnect } = await import('../server/integrations/coros-sync.js');
const { ingestBuffer } = await import('../server/ingest/index.js');

const db = await getDb();
const USER = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)')
  .run('coros-test@fitberg.local', Date.now()).lastInsertRowid;

export {
  db, USER, truncateDerived,
  discoverAuth, registerClient, createPkce, buildAuthorizeUrl, exchangeCode,
  chooseRedirectUri, syncCoros, CorosSyncError, needsReconnect, ingestBuffer,
};