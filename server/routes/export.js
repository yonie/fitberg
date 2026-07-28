import { createZipStream } from '../lib/zip.js';
import { absPathFor, storeStats } from '../lib/blobstore.js';

// Export.
//
// One button, one archive, one thing inside it: your FIT files. Nothing derived, no
// index, no metadata — everything else in this app can be rebuilt from these, so the
// files are the export. Deduplication happened on the way in, so what comes out has no
// duplicates in it.
//
// The archive streams, so exporting a decade of history works on a Raspberry Pi without
// buffering gigabytes in memory.

export function registerExportRoutes(app, { db }) {
  /** What an export would contain, so the UI can warn about size before starting. */
  app.get('/api/export/preview', async (request) => {
    const activities = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE user_id = ?')
      .get(request.userId).c;
    const originals = db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(bytes), 0) AS bytes FROM originals
       WHERE hash IN (SELECT original_hash FROM activities WHERE user_id = ? AND original_hash IS NOT NULL)`,
    ).get(request.userId);

    return {
      activities,
      originalFiles: originals.c,
      originalBytes: originals.bytes,
      store: storeStats(),
      contains: ['Every FIT file, exactly as you gave it to Fitberg'],
    };
  });

  /** Every FIT file, as a ZIP. Streamed as it is built. */
  app.get('/api/export', async (request, reply) => {
    const userId = request.userId;

    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="fitberg-export-${stamp}.zip"`)
      // Length is unknowable up front for a streamed archive.
      .header('cache-control', 'no-store');

    return reply.send(createZipStream(buildEntries(db, userId)));
  });

  // ─── integrity and rebuild ──────────────────────────────────────────────────

}

/** Lazily yield archive entries so nothing large is ever fully in memory. */
async function* buildEntries(db, userId) {
  // Named by the filename they arrived with rather than by their hash, because a folder
  // of sha256 names is not something anyone wants to look at. Collisions get a counter;
  // the store is keyed by content, so two files with the same name are different files.
  const originals = db.prepare(
    `SELECT DISTINCT o.hash, o.rel_path, o.original_name FROM originals o
     JOIN activities a ON a.original_hash = o.hash WHERE a.user_id = ?
     ORDER BY o.imported_at`,
  ).all(userId);

  const used = new Set();
  for (const original of originals) {
    const ext = original.rel_path.match(/\.[A-Za-z0-9.]+$/)?.[0] || '.fit';
    const base = (original.original_name || original.hash)
      .replace(/\.(fit|gz)$/gi, '')
      .replace(/[/\\]/g, '_') || original.hash;

    let name = `${base}${ext}`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++})${ext}`;
    used.add(name.toLowerCase());

    yield { name, path: absPathFor(original.rel_path) };
  }
}

const round = (v, digits = 2) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : '');
