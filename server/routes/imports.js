import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from '../lib/config.js';
import {
  ingestPath, beginImportRecord, finishImportRecord,
} from '../ingest/index.js';

// Import routes: browser uploads and import history.
//
// Uploads are spooled to a temp file rather than buffered in memory, so a
// multi-gigabyte export ZIP is read lazily by `ingestPath` the same way a CLI
// import of a file already on disk is.

export function registerImportRoutes(app, { db }) {

  /** Browser upload: one or more files (or archives), each its own import record. */
  app.post('/api/import', async (request, reply) => {
    const files = [];

    for await (const part of request.files()) {
      const filename = part.filename || 'upload';
      const tmpPath = path.join(config.tmpDir, `${crypto.randomUUID()}-${path.basename(filename)}`);

      let importId = null;
      try {
        await pipeline(part.file, fs.createWriteStream(tmpPath));
        importId = beginImportRecord(db, request.userId, {
          source: 'file', filename, bytes: fs.statSync(tmpPath).size,
        });

        const report = await ingestPath(db, request.userId, tmpPath, { filename, source: 'file' });
        finishImportRecord(db, importId, report, report.failed ? 'failed' : 'done');
        files.push({ filename, ...report.toJSON() });
      } catch (err) {
        if (importId !== null) {
          finishImportRecord(db, importId, {
            found: 0, imported: 0, merged: 0, duplicates: 0, failed: 1, toJSON: () => ({ error: err.message }),
          }, 'failed');
        }
        files.push({ filename, error: err.message });
      } finally {
        fs.rm(tmpPath, { force: true }, () => {});
      }
    }

    if (!files.length) return reply.code(400).send({ error: 'No files in upload' });
    return { files };
  });

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
