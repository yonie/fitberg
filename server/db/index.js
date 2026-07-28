import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, driverName } from './driver.js';
import { config, ensureDirs } from '../lib/config.js';

let db = null;

/**
 * Open (creating if needed) the derived database and bring the schema up to date.
 * Safe to call repeatedly; returns the same handle.
 */
export async function getDb() {
  if (db) return db;
  ensureDirs();
  db = await openDatabase(config.dbPath);
  applySchema(db);
  return db;
}

export function applySchema(handle) {
  // Whether this database already existed decides what migrations mean, so it has to
  // be answered *before* the schema is applied.
  const isNew = !handle.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activities'",
  ).get();

  const schemaPath = path.join(import.meta.dirname, 'schema.sql');
  handle.exec(fs.readFileSync(schemaPath, 'utf8'));
  runMigrations(handle, { isNew });
}

// Additive migrations only.
//
// Because the originals store is the source of truth, we never need a
// destructive or data-transforming migration: to change how something is
// derived, add the column here and re-run `reindex`. That is the whole payoff of
// treating the database as a cache.
const MIGRATIONS = [
  // { id: 'YYYY-MM-DD-what', sql: 'ALTER TABLE ... ADD COLUMN ...' },
  {
    id: '2026-07-27-oauth-athlete',
    sql: 'ALTER TABLE oauth_tokens ADD COLUMN athlete TEXT',
  },
  {
    id: '2026-07-27-crop-start',
    sql: 'ALTER TABLE activities ADD COLUMN crop_start_s INTEGER',
  },
  {
    id: '2026-07-27-crop-end',
    sql: 'ALTER TABLE activities ADD COLUMN crop_end_s INTEGER',
  },
  {
    // The gear table went; the column referencing it has to go with it, or every
    // insert fails on a foreign key pointing at nothing.
    id: '2026-07-28-drop-gear',
    sql: 'ALTER TABLE activities DROP COLUMN gear_id',
  },
  {
    // Tables belonging to features that no longer exist. `CREATE TABLE IF NOT EXISTS`
    // only ever adds, so removing a table from schema.sql leaves it sitting in every
    // database that already had it — invisible, but still there.
    id: '2026-07-28-drop-removed-features',
    sql: `DROP TABLE IF EXISTS wellness;
          DROP TABLE IF EXISTS api_keys;
          DROP TABLE IF EXISTS oauth_tokens;
          DROP TABLE IF EXISTS connector_apps;
          DROP TABLE IF EXISTS gear;`,
  },
];

/**
 * Bring an older database up to the shape schema.sql describes.
 *
 * `schema.sql` is always current, so a database created from it is already at the
 * latest version — its migrations are recorded as done without being run. Running them
 * anyway would fail on the first `ADD COLUMN` for a column the schema just created,
 * which is exactly what a fresh install would hit.
 */
function runMigrations(handle, { isNew = false } = {}) {
  handle.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(handle.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
  const record = handle.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    if (!isNew) handle.exec(migration.sql);
    record.run(migration.id, Date.now());
  }
}

export async function describeDb() {
  const handle = await getDb();
  const count = (table) => handle.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  return {
    driver: await driverName(),
    path: config.dbPath,
    sizeBytes: fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0,
    counts: {
      users: count('users'),
      activities: count('activities'),
      originals: count('originals'),
      streams: count('streams'),
      bestEfforts: count('best_efforts'),
    },
  };
}

/**
 * Drop every derived table. Used by `reindex`, which then replays the originals
 * store. Deliberately does NOT touch users, activity_edits or the
 * originals ledger — those are either user-authored or the ledger itself.
 *
 * activity_edits in particular: it holds your crops, notes and RPE, which cannot be
 * re-derived from anything. Adding it to this list would make `reindex` destructive.
 */
export function truncateDerived(handle) {
  const tables = ['streams', 'laps', 'best_efforts', 'daily', 'activities', 'ai_insights'];
  handle.exec('PRAGMA foreign_keys = OFF');
  for (const table of tables) handle.exec(`DELETE FROM ${table}`);
  handle.exec('PRAGMA foreign_keys = ON');
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
