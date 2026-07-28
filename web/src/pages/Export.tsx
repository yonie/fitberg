import { useGet } from '../lib/hooks';
import { Card } from '../components/common';
import { bytes, number } from '../lib/format';

// Export.
//
// One button, one thing in the ZIP: your FIT files. Everything else this app shows is
// derived from them and can be rebuilt, so there is nothing else to put in the archive
// and nothing to choose between — which is why this page has no options on it.

export function Export() {
  const preview = useGet<{
    activities: number; originalFiles: number; originalBytes: number;
  }>('/api/export/preview');

  const p = preview.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Export</h1>
          <p>Your FIT files, in one ZIP, whenever you want them.</p>
        </div>
      </div>

      <Card title="Download everything" style={{ marginBottom: '1rem' }}>
        <a className="btn btn-primary" href="/api/export" download>
          Download ZIP
        </a>

        {p && (
          <p style={{ fontSize: '0.9375rem', margin: '1rem 0 0' }}>
            {number(p.originalFiles)} FIT files, {bytes(p.originalBytes)}, covering{' '}
            {number(p.activities)} activities. Exactly the files you imported, unmodified,
            with duplicates already removed.
          </p>
        )}
      </Card>
    </>
  );
}
