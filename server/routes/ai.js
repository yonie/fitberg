import { getSettings, saveSettings } from '../lib/settings.js';
import { ollamaStatus, generate, invalidateModelCache } from '../ai/ollama.js';
import {
  weeklyReview, activityInsight, askQuestion, buildWeeklyContext, buildActivityContext,
  SCHEMA_DESCRIPTION,
} from '../ai/coach.js';

export function registerAiRoutes(app, { db }) {
  app.get('/api/ai/status', async () => ollamaStatus());

  /** The AI host and model, as set on the Settings page. */
  app.get('/api/ai/settings', async () => {
    const { ollamaUrl, ollamaModel, fromEnv } = getSettings(db);
    return { url: ollamaUrl, model: ollamaModel, fromEnv };
  });

  app.put('/api/ai/settings', async (request, reply) => {
    try {
      const saved = saveSettings(db, request.body || {});
      // The resolved-tag cache belongs to the old host.
      invalidateModelCache();
      return { ok: true, ...saved, status: await ollamaStatus() };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /**
   * Weekly coach review. Cached per ISO week, because generating one on a Pi with
   * a local model takes real time and the inputs only change once a day.
   */
  /**
   * The cached weekly review, if there is one.
   *
   * Separate from the POST because reading costs nothing and generating costs a minute
   * of a model's time. Without this, an already-written review sat in the database while
   * the page showed an empty state and a Generate button.
   */
  app.get('/api/ai/weekly', async (request) => {
    const weekKey = isoWeek(new Date());
    const cached = db.prepare(
      `SELECT content, model, created_at FROM ai_insights
       WHERE user_id = ? AND kind = 'weekly' AND ref = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(request.userId, weekKey);

    if (!cached) return { content: null, week: weekKey };
    return {
      content: cached.content,
      model: cached.model,
      createdAt: cached.created_at,
      cached: true,
      week: weekKey,
    };
  });

  app.post('/api/ai/weekly', async (request, reply) => {
    const status = await ollamaStatus();
    if (!status.available) return reply.code(503).send({ error: status.reason, hint: status.hint });

    const weekKey = isoWeek(new Date());
    const force = Boolean(request.body?.refresh);

    if (!force) {
      // Newest first: regenerating writes a new row, and without an order the read
      // kept serving the first review ever written for the week.
      const cached = db.prepare(
        `SELECT content, model, created_at FROM ai_insights
         WHERE user_id = ? AND kind = 'weekly' AND ref = ?
         ORDER BY created_at DESC LIMIT 1`,
      ).get(request.userId, weekKey);
      // Regenerate if it is more than a day old; new sessions have likely landed.
      if (cached && Date.now() - cached.created_at < 24 * 3600 * 1000) {
        return { content: cached.content, model: cached.model, cached: true, week: weekKey };
      }
    }

    const context = buildWeeklyContext(db, request.userId);
    if (!context.sessions.length && !context.fitness.ctl) {
      return reply.code(400).send({ error: 'Not enough training data yet for a review.' });
    }

    let result;
    try {
      result = await weeklyReview(context);
    } catch (err) {
      return reply.code(503).send({ error: `AI request failed: ${err.message}` });
    }

    db.prepare(
      `INSERT INTO ai_insights (user_id, kind, ref, content, model, created_at)
       VALUES (?, 'weekly', ?, ?, ?, ?)`,
    ).run(request.userId, weekKey, result.text, result.model, Date.now());

    // One review per week, not one per press: regenerating three times used to leave
    // three rows, and a reader with no ORDER BY would serve the oldest of them.
    db.prepare(
      `DELETE FROM ai_insights WHERE user_id = ? AND kind = 'weekly' AND ref = ?
         AND created_at < (SELECT MAX(created_at) FROM ai_insights
                           WHERE user_id = ? AND kind = 'weekly' AND ref = ?)`,
    ).run(request.userId, weekKey, request.userId, weekKey);

    return { content: result.text, model: result.model, cached: false, week: weekKey, durationMs: result.durationMs };
  });

  /** Insight for one activity. */
  app.post('/api/ai/activity/:id', async (request, reply) => {
    const status = await ollamaStatus();
    if (!status.available) return reply.code(503).send({ error: status.reason, hint: status.hint });

    const row = db.prepare('SELECT * FROM activities WHERE id = ? AND user_id = ?')
      .get(Number(request.params.id), request.userId);
    if (!row) return reply.code(404).send({ error: 'Activity not found' });

    const ref = String(row.id);
    if (!request.body?.refresh) {
      const cached = db.prepare(
        `SELECT content, model FROM ai_insights
         WHERE user_id = ? AND kind = 'activity' AND ref = ?
         ORDER BY created_at DESC LIMIT 1`,
      ).get(request.userId, ref);
      if (cached) return { content: cached.content, model: cached.model, cached: true };
    }

    const context = buildActivityContext(db, request.userId, row);
    let result;
    try {
      result = await activityInsight(context);
    } catch (err) {
      return reply.code(503).send({ error: `AI request failed: ${err.message}` });
    }

    db.prepare(
      `INSERT INTO ai_insights (user_id, kind, ref, content, model, created_at)
       VALUES (?, 'activity', ?, ?, ?, ?)`,
    ).run(request.userId, ref, result.text, result.model, Date.now());

    db.prepare(
      `DELETE FROM ai_insights WHERE user_id = ? AND kind = 'activity' AND ref = ?
         AND created_at < (SELECT MAX(created_at) FROM ai_insights
                           WHERE user_id = ? AND kind = 'activity' AND ref = ?)`,
    ).run(request.userId, ref, request.userId, ref);

    return { content: result.text, model: result.model, cached: false };
  });

  /**
   * Natural-language questions about your own data.
   *
   * The model writes a SELECT; it never executes anything itself. The generated SQL
   * is validated against an allowlist (single SELECT, known tables only, must be
   * scoped to this user_id) before it runs, and the SQL is returned to the caller so
   * the answer is auditable rather than magic.
   */
  app.post('/api/ai/ask', async (request, reply) => {
    const status = await ollamaStatus();
    if (!status.available) return reply.code(503).send({ error: status.reason, hint: status.hint });

    const question = String(request.body?.question || '').trim();
    if (question.length < 3) return reply.code(400).send({ error: 'Ask a question.' });
    if (question.length > 500) return reply.code(400).send({ error: 'That question is too long.' });

    try {
      const result = await askQuestion(db, request.userId, question, { schema: SCHEMA_DESCRIPTION });
      return result;
    } catch (err) {
      return reply.code(503).send({ error: `AI request failed: ${err.message}` });
    }
  });
}

/** ISO-8601 week key, e.g. 2026-W30. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday determines the ISO week-numbering year.
  const dayNumber = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
