import { getProfile } from '../metrics/engine.js';
import { getUser } from '../lib/auth.js';
import { config } from '../lib/config.js';

export function registerProfileRoutes(app, { db }) {
  /**
   * The athlete profile, inferred entirely from the imported files. `estimated`
   * explains where each number came from, so the UI can say how it was worked out
   * rather than presenting a guess as fact. Read-only: there is nothing to fill in.
   */
  app.get('/api/profile', async (request) => {
    const { profile, estimated } = getProfile(db, request.userId);
    const user = getUser(db, request.userId);
    const settings = readSettings(user);

    return {
      profile,
      estimated,
      explicit: settings.profile || {},
      preferences: settings.preferences || { units: 'metric' },
      user: { id: user.id, email: user.email, displayName: user.display_name },
    };
  });
}

// ── settings helpers ─────────────────────────────────────────────────────────

function readSettings(user) {
  try { return user?.settings_json ? JSON.parse(user.settings_json) : {}; } catch { return {}; }
}

function writeSettings(db, userId, settings) {
  db.prepare('UPDATE users SET settings_json = ? WHERE id = ?')
    .run(JSON.stringify(settings), userId);
}

/** Bring a stored onboarding blob up to the current shape without losing progress. */
function migrateOnboarding(stored) {
  const base = defaultOnboarding();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    version: ONBOARDING_VERSION,
    steps: { ...base.steps, ...(stored.steps || {}) },
    platforms: { ...base.platforms, ...(stored.platforms || {}) },
  };
}
