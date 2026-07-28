import {createUser, findUserByEmail, verifyPassword, createSession, destroySession, sessionCookie, userCount, getUser, SESSION_COOKIE } from '../lib/auth.js';
import { config } from '../lib/config.js';

export function registerAuthRoutes(app, { db }) {
  /**
   * Whether this instance has been set up yet. The web app calls this first to
   * decide between a login form and the dashboard.
   */
  app.get('/api/auth/state', async () => ({
    initialised: userCount(db) > 0,
    openAccess: config.openAccess,
    // Warn rather than fail: sessions still work, they just do not survive restarts.
    ephemeralSessions: config.sessionSecretIsEphemeral,
  }));

  /** First-run account creation. Only allowed while no user exists. */
  app.post('/api/auth/register', async (request, reply) => {
    if (userCount(db) > 0) {
      return reply.code(409).send({ error: 'This instance already has an account. Sign in instead.' });
    }

    const { email, password, displayName } = request.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(String(email))) {
      return reply.code(400).send({ error: 'A valid email address is required' });
    }
    if (!password || String(password).length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }

    const userId = createUser(db, { email, password, displayName });
    const token = createSession(db, userId);
    reply.header('set-cookie', sessionCookie(token));
    return { id: userId, email: String(email).toLowerCase().trim(), displayName: displayName || null };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body || {};
    const user = findUserByEmail(db, email);

    // Identical response for unknown user and wrong password, so the endpoint
    // cannot be used to enumerate accounts.
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      return reply.code(401).send({ error: 'Incorrect email or password' });
    }

    const token = createSession(db, user.id);
    reply.header('set-cookie', sessionCookie(token));
    return { id: user.id, email: user.email, displayName: user.display_name };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(db, request.cookies?.[SESSION_COOKIE]);
    reply.header('set-cookie', sessionCookie('', { clear: true }));
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: 'Not signed in' });
    const user = getUser(db, request.userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
    };
  });
}
