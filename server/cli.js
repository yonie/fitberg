#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './lib/config.js';
import { getDb, describeDb, closeDb } from './db/index.js';
import { driverName } from './db/driver.js';
import { reindex, rebuildLedger } from './ingest/reindex.js';
import { ingestPath } from './ingest/index.js';
import { verifyStore, storeStats } from './lib/blobstore.js';
import { recomputeAll, getProfile } from './metrics/engine.js';
import { userCount, createUser } from './lib/auth.js';

// Command-line tools. These exist because the operations that matter most for
// data safety — reindex, verify, import — should not require a working browser
// session or even a running server.

const COMMANDS = {
  status: cmdStatus,
  reindex: cmdReindex,
  verify: cmdVerify,
  import: cmdImport,
  recompute: cmdRecompute,
  'create-user': cmdCreateUser,
  'rebuild-ledger': cmdRebuildLedger,
  help: cmdHelp,
};

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    cmdHelp();
    process.exit(1);
  }
  try {
    await handler(args);
  } finally {
    closeDb();
  }
}

async function withUser(fn, args) {
  ensureDirs();
  const db = await getDb();
  const explicit = args.find((a) => a.startsWith('--user='));
  const userId = explicit
    ? Number(explicit.split('=')[1])
    : db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id;

  if (!userId) {
    console.error('No user exists yet. Create one with:\n  npm run fitberg -- create-user <email> [password]');
    process.exit(1);
  }
  return fn(db, userId);
}

// ─── commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  ensureDirs();
  const db = await getDb();
  const info = await describeDb();
  const store = storeStats();

  console.log('Fitberg status\n');
  console.log(`  data dir     ${config.dataDir}`);
  console.log(`  database     ${info.path} (${formatBytes(info.sizeBytes)}, ${await driverName()})`);
  console.log(`  originals    ${store.files} files, ${formatBytes(store.bytes)}  <- the authoritative copy`);
  console.log('');
  console.log(`  users        ${info.counts.users}`);
  console.log(`  activities   ${info.counts.activities}`);
  console.log(`  streams      ${info.counts.streams} channel blobs`);
  console.log(`  best efforts ${info.counts.bestEfforts}`);

  if (info.counts.users) {
    const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
    const range = db.prepare(
      'SELECT MIN(start_time) AS first, MAX(start_time) AS last FROM activities WHERE user_id = ?',
    ).get(userId);
    if (range.first) {
      console.log(`  date range   ${iso(range.first)} .. ${iso(range.last)}`);
    }
    const { profile, estimated } = getProfile(db, userId);
    console.log('');
    console.log('  profile');
    for (const key of ['maxHr', 'restingHr', 'lthr', 'ftp', 'weightKg', 'thresholdPaceMs']) {
      if (profile[key] === null || profile[key] === undefined) continue;
      const value = key === 'thresholdPaceMs' ? `${pace(profile[key])} /km` : profile[key];
      const note = estimated[key] ? `  (estimated: ${estimated[key]})` : '';
      console.log(`    ${key.padEnd(16)} ${String(value).padEnd(8)}${note}`);
    }

  }
}

async function cmdReindex(args) {
  return withUser(async (db, userId) => {
    console.log('Rebuilding the database from the originals store.');
    console.log('Your source files are not modified; only derived data is replaced.\n');

    const result = await reindex(db, userId, {
      verify: !args.includes('--no-verify'),
      onProgress: (p) => {
        if (p.phase === 'replay') process.stdout.write(`\r  replaying ${p.done}/${p.total} files`);
        else if (p.checked) process.stdout.write(`\r  verifying ${p.checked} files`);
      },
    });

    process.stdout.write('\r'.padEnd(60) + '\r');
    console.log(`  files replayed  ${result.files}`);
    console.log(`  activities      ${result.imported} rebuilt, ${result.merged} merged, ${result.duplicates} duplicate`);
    console.log(`  skipped         ${result.skipped}`);
    console.log(`  failed          ${result.failed}`);
    if (result.integrity) {
      console.log(`  integrity       ${result.integrity.ok}/${result.integrity.checked} files verified`);
      if (result.integrity.corrupt.length) {
        console.log(`  CORRUPT         ${result.integrity.corrupt.length} file(s) no longer match their hash:`);
        for (const c of result.integrity.corrupt.slice(0, 10)) console.log(`      ${c.relPath}`);
      }
    }
    console.log(`  took            ${(result.elapsedMs / 1000).toFixed(1)}s`);

    if (result.warnings?.length) {
      console.log('\n  warnings:');
      for (const w of result.warnings.slice(0, 10)) console.log(`    - ${w}`);
    }
  }, args);
}

async function cmdVerify() {
  ensureDirs();
  await getDb();
  console.log('Verifying that every original file still matches its content hash.\n');

  const result = verifyStore({
    onProgress: (r) => process.stdout.write(`\r  checked ${r.checked}`),
  });
  process.stdout.write('\r'.padEnd(40) + '\r');

  console.log(`  checked     ${result.checked}`);
  console.log(`  verified    ${result.ok}`);
  console.log(`  corrupt     ${result.corrupt.length}`);
  console.log(`  unreadable  ${result.unreadable.length}`);

  for (const c of result.corrupt.slice(0, 20)) {
    console.log(`    CORRUPT ${c.relPath}`);
  }
  for (const u of result.unreadable.slice(0, 20)) {
    console.log(`    UNREADABLE ${u.relPath}: ${u.error}`);
  }

  if (!result.corrupt.length && !result.unreadable.length) {
    console.log('\n  Your data is intact.');
  } else {
    console.log('\n  Some files are damaged. Restore them from a backup, then run reindex.');
    process.exitCode = 2;
  }
}

async function cmdImport(args) {
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) {
    console.error('Usage: npm run fitberg -- import <file-or-directory> [...]');
    process.exit(1);
  }

  return withUser(async (db, userId) => {
    for (const target of paths) {
      const absolute = path.resolve(target);
      if (!fs.existsSync(absolute)) { console.error(`  not found: ${target}`); continue; }

      const stat = fs.statSync(absolute);
      const files = stat.isDirectory()
        ? fs.readdirSync(absolute).map((f) => path.join(absolute, f)).filter((f) => fs.statSync(f).isFile())
        : [absolute];

      for (const file of files) {
        process.stdout.write(`  ${path.basename(file)} ... `);
        const report = await ingestPath(db, userId, file, { filename: path.basename(file) });
        console.log(`${report.imported} new, ${report.merged} merged, ${report.duplicates} dup, `
          + `${report.skipped} skipped, ${report.failed} failed`);

        for (const w of report.warnings.slice(0, 5)) console.log(`      warning: ${w}`);
        if (report.failed) {
          for (const entry of report.log.filter((l) => l.status === 'failed').slice(0, 5)) {
            console.log(`      failed: ${entry.file}: ${entry.reason}`);
          }
        }
      }
    }
  }, args);
}


async function cmdRecompute(args) {
  return withUser(async (db, userId) => {
    console.log('Recomputing all derived metrics.\n');
    const result = recomputeAll(db, userId, {
      onProgress: (p) => process.stdout.write(`\r  ${p.phase}: ${p.done}/${p.total}`),
    });
    process.stdout.write('\r'.padEnd(50) + '\r');
    console.log(`  activities   ${result.activities}`);
    console.log(`  days         ${result.daily.days} (${result.daily.from} .. ${result.daily.to})`);
    if (result.profileChanged) {
      console.log('  note         inferred thresholds changed, so load was recalculated twice');
    }
  }, args);
}

async function cmdCreateUser(args) {
  ensureDirs();
  const db = await getDb();
  const [email, password] = args.filter((a) => !a.startsWith('--'));

  if (!email) {
    console.error('Usage: npm run fitberg -- create-user <email> [password]');
    process.exit(1);
  }
  if (userCount(db) > 0 && !args.includes('--force')) {
    console.error('An account already exists. Pass --force to add another.');
    process.exit(1);
  }
  if (password && password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const id = createUser(db, { email, password: password || null, displayName: null });
  console.log(`Created user ${id} (${email}).`);
  if (!password) {
    console.log('No password set — only usable with FITBERG_OPEN_ACCESS=1.');
  }
}

async function cmdRebuildLedger() {
  ensureDirs();
  const db = await getDb();
  console.log('Rebuilding the originals ledger from the files on disk.\n');
  const result = rebuildLedger(db);
  console.log(`  indexed ${result.added} files`);
  console.log('  now run: npm run fitberg -- reindex');
}

function cmdHelp() {
  console.log(`Fitberg — your fitness data, in your own cloud, forever.

Usage: npm run fitberg -- <command> [options]

Data safety
  status              Show what is stored and how the metrics currently read
  verify              Check every original file against its content hash
  reindex             Rebuild the whole database from the originals store
                        (--no-verify to skip the integrity check first)
  rebuild-ledger      Re-index the originals directory after losing the database

Importing
  import <path...>    Import FIT files, a folder of them, or an export ZIP

Maintenance
  recompute           Recalculate load and fitness from stored activities
  create-user <email> [password]

Options
  --user=<id>         Act on a specific user on a multi-user instance

The originals store is the authoritative copy of your data; the database is a
cache that reindex can rebuild at any time. Back up ${config.dataDir} and you
have lost nothing.`);
}

// ── formatting ───────────────────────────────────────────────────────────────

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const pace = (speedMs) => {
  if (!speedMs) return '—';
  const s = 1000 / speedMs;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

main().catch((err) => {
  console.error(err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
