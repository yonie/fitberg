import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../lib/config.js';
import {
  ingestPath, ingestBuffer, beginImportRecord, finishImportRecord,
} from '../ingest/index.js';
import { storeStats } from '../lib/blobstore.js';

// Import routes: browser uploads, the machine-to-machine push endpoint, and the
// Uploads, spooled to a temp file so a multi-gigabyte archive is read lazily.

export function registerImportRoutes(app, { db }) {

  /** Import history. */
  app.get('/api/imports', async (request) => {
    const rows = db.prepare(
      'SELECT * FROM imports WHERE user_id = ? ORDER BY started_at DESC LIMIT 50',
    ).all(request.userId);

    return {
      imports: rows.map((r) => ({
        id: r.id,
        source: r.source,
        filename: r.filename,
        bytes: r.bytes,
        status: r.status,
        found: r.found,
        imported: r.imported,
        duplicates: r.duplicates,
        failed: r.failed,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
    };
  });

  app.get('/api/imports/:id', async (request, reply) => {
    const row = db.prepare('SELECT * FROM imports WHERE id = ? AND user_id = ?')
      .get(Number(request.params.id), request.userId);
    if (!row) return reply.code(404).send({ error: 'Import not found' });

    let log = null;
    try { log = row.log_json ? JSON.parse(row.log_json) : null; } catch { /* ignore */ }
    return { id: row.id, status: row.status, filename: row.filename, log };
  });

  /** Inbox status and an on-demand scan. */

}
