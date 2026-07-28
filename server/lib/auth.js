import crypto from 'node:crypto';
import { config } from './config.js';

// Authentication.
//
// Single-user by default, multi-user capable. Deliberately minimal: scrypt for
// passwords, opaque random session tokens in an httpOnly cookie, and separate
// API keys for machine access. No JWTs — a self-hosted app has a database right
// there, and revocation that actually works is worth more than statelessness.

const SESSION_COOKIE = 'fitberg_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 days
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// ─── passwords ────────────────────────────────────────────────────────────────

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  const derived = crypto.scryptSync(password, salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });

  // Constant-time compare so a wrong password cannot be found byte by byte.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ─── sessions ─────────────────────────────────────────────────────────────────

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function readSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ─── cookies ──────────────────────────────────────────────────────────────────

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { clear = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // Only mark Secure when we know we are actually on HTTPS, otherwise the cookie
  // is silently dropped for the many people running this on a plain LAN address.
  if (config.publicUrl.startsWith('https://')) attrs.push('Secure');
  return attrs.join('; ');
}

export { SESSION_COOKIE };

// ─── API keys ─────────────────────────────────────────────────────────────────

// ─── users ────────────────────────────────────────────────────────────────────

export function userCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function createUser(db, { email, password, displayName }) {
  const hash = password ? hashPassword(password) : null;
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, display_name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
  ).run(email.toLowerCase().trim(), hash, displayName || null, Date.now(), '{}');
  return result.lastInsertRowid;
}

export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
}

export function getUser(db, userId) {
  return db.prepare('SELECT id, email, display_name, created_at, settings_json FROM users WHERE id = ?')
    .get(userId);
}

/**
 * The single user of an open-access instance.
 * When FITBERG_OPEN_ACCESS=1 there is no login, so we need a user row to own the
 * data; this creates one on demand.
 */
export function ensureDefaultUser(db) {
  const existing = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (existing) return existing.id;
  return createUser(db, { email: 'local@fitberg', password: null, displayName: 'Me' });
}
