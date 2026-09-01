import { config } from '../lib/config.js';
import { syncCoros } from './coros-sync.js';

// The background COROS sync.
//
// A simple interval, not a cron daemon: the server is a single long-running
// process, so "roughly daily" is a setInterval away. The interval is aligned
// lazily — every hour we check whether the last successful sync is older than a
// day — which self-heals across restarts, clock jumps, and a laptop that sleeps
// through its slot.
//
// Errors are swallowed into the account's status blob (syncCoros and the
// routes write it), so a dead token or a network outage never crashes the
// server or spams the log; the next user visit to the Import page shows the
// state and the reconnect button.

const CHECK_INTERVAL_MS = 60 * 60 * 1000;   // hourly check
const SYNC_EVERY_MS = 24 * 3600 * 1000;      // sync at most daily

export function startCorosScheduler(db, { log = console } = {}) {
  if (!config.coros.autoSync) return () => {};

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const accounts = db.prepare(
        "SELECT * FROM integration_accounts WHERE provider = 'coros'",
      ).all();

      for (const account of accounts) {
        const overdue = !account.last_sync_at || Date.now() - account.last_sync_at >= SYNC_EVERY_MS;
        if (!overdue) continue;

        // Per account, so one expired login does not hold up everyone else on
        // a shared instance. syncCoros already records the failure on the row.
        try {
          await syncCoros(db, account.user_id, account);
          log.info?.(`coros: synced account ${account.id}`);
        } catch (err) {
          log.warn?.(`coros: account ${account.id} did not sync: ${err.message}`);
        }
      }
    } catch (err) {
      // Sync failures are recorded per-account by syncCoros; anything here is
      // a surprise worth one log line and nothing more.
      log.warn?.(`coros: background sync failed: ${err.message}`);
    }
  }

  // First check shortly after boot, so a restart still syncs promptly.
  timer = setTimeout(function run() {
    tick().catch(() => {});
    timer = setTimeout(run, CHECK_INTERVAL_MS);
  }, 30 * 1000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}