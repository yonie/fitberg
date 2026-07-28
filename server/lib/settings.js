// Instance settings you can change in the app.
//
// Only things a person might reasonably want to change live here — right now that is
// which Ollama host and model the coach talks to. It was environment-variable-only,
// which meant editing a file and restarting a container to switch model. That is a fine
// ask for a sysadmin and an absurd one for someone who just wants their runs analysed.
//
// Environment variables still work and act as the default, so a deployment can bake
// values in; anything saved here takes precedence.

import { config } from './config.js';

const DEFAULTS = () => ({
  ollamaUrl: config.ollama.url,
  ollamaModel: config.ollama.model,
});

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const defaults = DEFAULTS();

  return {
    ollamaUrl: stored.ollamaUrl || defaults.ollamaUrl,
    ollamaModel: stored.ollamaModel || defaults.ollamaModel,
    // So the UI can say whether a value is yours or the deployment's.
    fromEnv: {
      ollamaUrl: !stored.ollamaUrl,
      ollamaModel: !stored.ollamaModel,
    },
  };
}

export function saveSettings(db, patch) {
  const write = db.prepare(`INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const clear = db.prepare('DELETE FROM app_settings WHERE key = ?');

  if ('ollamaUrl' in patch) {
    const url = String(patch.ollamaUrl ?? '').trim().replace(/\/$/, '');
    if (!url) clear.run('ollamaUrl');
    else {
      // Fail here rather than on every AI request with a fetch error.
      try { new URL(url); } catch { throw new Error('That does not look like a web address'); }
      write.run('ollamaUrl', url, Date.now());
    }
  }

  if ('ollamaModel' in patch) {
    const model = String(patch.ollamaModel ?? '').trim();
    if (!model) clear.run('ollamaModel');
    else write.run('ollamaModel', model, Date.now());
  }

  return getSettings(db);
}
