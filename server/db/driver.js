// SQLite driver adapter.
//
// Prefers Node's built-in `node:sqlite` (Node >= 22.5 with --experimental-sqlite,
// unflagged from 23.4/24). That means the production Docker image needs no C
// toolchain and no native module, which removes the single most common
// "it won't install on my Raspberry Pi" failure.
//
// Falls back to better-sqlite3 when the builtin is unavailable, so Fitberg still
// runs on Node 20 bare metal.
//
// Both are synchronous and API-compatible enough that the surface below is tiny.
// Normalised differences:
//   - blobs come back as Uint8Array from node:sqlite, Buffer from better-sqlite3
//   - node:sqlite rejects `undefined` as a bound parameter, better-sqlite3 too;
//     bind() coerces undefined -> null for both.

let impl = null;

async function loadImpl() {
  if (impl) return impl;

  try {
    const { DatabaseSync } = await import('node:sqlite');
    impl = {
      name: 'node:sqlite',
      open(path) {
        const db = new DatabaseSync(path);
        // node:sqlite returns bigint for INTEGER by default in some versions;
        // ask for numbers so downstream arithmetic behaves.
        if (typeof db.setReturnArrays === 'function') db.setReturnArrays(false);
        return wrapNodeSqlite(db);
      },
    };
    return impl;
  } catch {
    /* builtin not available — fall through */
  }

  // Fallback for Node < 22.5. Note that better-sqlite3's published linux-arm64
  // prebuild links against GLIBC 2.38, which is newer than Debian bookworm /
  // Raspberry Pi OS ships (2.36) — on those hosts this import or the subsequent
  // open will fail, and the fix is to run Node >= 24 (or Docker) so the builtin
  // above is used instead. That is why the error below names the real remedy.
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (err) {
    throw new Error(
      `No SQLite driver available. Node ${process.versions.node} lacks the built-in ` +
      `node:sqlite module, and the better-sqlite3 fallback failed to load ` +
      `(${err.message.split('\n')[0]}).\n` +
      `Fix: run Fitberg on Node >= 24, or use the Docker image which already does.`,
    );
  }

  impl = {
    name: 'better-sqlite3',
    open(path) {
      return wrapBetterSqlite(new Database(path));
    },
  };
  return impl;
}

function bind(params) {
  // Accept either (…args) or a single object of named params.
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array)) {
    const obj = {};
    for (const [k, v] of Object.entries(params[0])) obj[k] = v === undefined ? null : v;
    return [obj];
  }
  return params.map((v) => (v === undefined ? null : v));
}

function wrapNodeSqlite(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA synchronous = NORMAL');

  const cache = new Map();
  const prep = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      // Return plain numbers, not BigInt, for INTEGER columns.
      if (typeof stmt.setReadBigInts === 'function') stmt.setReadBigInts(false);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  return {
    driver: 'node:sqlite',
    raw: db,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      return {
        run: (...p) => {
          const r = prep(sql).run(...bind(p));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...p) => prep(sql).get(...bind(p)) ?? undefined,
        all: (...p) => prep(sql).all(...bind(p)),
        iterate: (...p) => prep(sql).iterate(...bind(p)),
      };
    },
    transaction(fn) {
      return (...args) => {
        db.exec('BEGIN');
        try {
          const out = fn(...args);
          db.exec('COMMIT');
          return out;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw err;
        }
      };
    },
    close: () => db.close(),
  };
}

function wrapBetterSqlite(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('synchronous = NORMAL');

  const cache = new Map();
  const prep = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
    return stmt;
  };

  return {
    driver: 'better-sqlite3',
    raw: db,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      return {
        run: (...p) => {
          const r = prep(sql).run(...bind(p));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...p) => prep(sql).get(...bind(p)),
        all: (...p) => prep(sql).all(...bind(p)),
        iterate: (...p) => prep(sql).iterate(...bind(p)),
      };
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

export async function openDatabase(path) {
  const chosen = await loadImpl();
  return chosen.open(path);
}

export async function driverName() {
  return (await loadImpl()).name;
}
