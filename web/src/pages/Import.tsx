import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Card, ErrorNotice, Loading } from '../components/common';
import { relativeTime, number } from '../lib/format';

// The import page.
//
// Connect a platform, press one button, get your history. COROS works over the
// official COROS MCP service — register once from this page (no config files, no
// restart), authorise over OAuth, then pull everything.
//
// Everything else (device over USB, watched folder, push API) is a file landing in the
// same pipeline, so it gets less space.

interface FileReport {
  filename: string;
  imported?: number;
  merged?: number;
  duplicates?: number;
  skipped?: number;
  failed?: number;
  error?: string;
  warnings?: string[];
  skipReasons?: Record<string, number>;
  log?: { file: string; status: string; reason: string }[];
}

export function Import() {
  const [reports, setReports] = useState<FileReport[]>([]);
  const history = useGet<{ imports: any[] }>('/api/imports');

  const resultRef = useRef<HTMLDivElement>(null);

  /** A drop-zone finished: show what happened, and make sure it is seen. */
  const afterImport = useCallback((files: FileReport[]) => {
    setReports(files);
    history.reload();
    // A 232-file import scrolls the summary off the bottom of a long page. Without
    // this the upload spinner just vanishes and nothing appears to have happened.
    requestAnimationFrame(() => {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A connector sync finished: refresh the lists, but leave any file report alone. */
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import</h1>
          <p>Drop FIT or TCX files in. Fitberg identifies them by reading them, not by their names.</p>
        </div>
      </div>

      <CorosCard onSyncDone={() => history.reload()} />

      <div ref={resultRef} />
      {reports.length > 0 && <ImportResult reports={reports} />}

      <ImportBox onFiles={afterImport} />

      {history.data && history.data.imports.length > 0 && (
        <Card title="Previous imports">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>File</th>
                  <th className="num">Imported</th><th className="num">Duplicate</th>
                  <th className="num">Failed</th>
                </tr>
              </thead>
              <tbody>
                {history.data.imports.map((imp) => (
                  <tr key={imp.id}>
                    <td className="card-sub">{relativeTime(imp.startedAt)}</td>
                    <td style={{ maxWidth: '20rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {imp.filename || '—'}
                    </td>
                    <td className="num">{imp.imported}</td>
                    <td className="num">{imp.duplicates}</td>
                    <td className="num">{imp.failed || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

// ─── the import box ──────────────────────────────────────────────────────────

/** Where a dump comes from, for people who have not requested one yet. */
const SOURCES = [
  {
    label: 'Strava',
    href: 'https://www.strava.com/athlete/download_my_account',
    how: 'Request your archive, wait for the email (a few hours), drop the ZIP in whole.',
  },
  {
    label: 'Garmin',
    href: 'https://www.garmin.com/account/datamanagement/exportdata/',
    how: 'Request an export, or just plug the watch in over USB and copy /GARMIN/ACTIVITY/.',
  },
  {
    label: 'Your device',
    href: null,
    how: 'Plug it in over USB and copy the files across. Nothing is lost this way, and '
      + 'there is no waiting.',
  },
];

// ─── COROS connector ──────────────────────────────────────────────────────────

interface CorosStatus {
  connected: boolean;
  accountName?: string | null;
  lastSyncAt?: number | null;
  lastSync?: {
    found?: number; downloaded?: number; imported?: number; merged?: number;
    duplicates?: number; failed?: number; quotaExhausted?: boolean; quotaUsed?: number;
    deferred?: number; alreadyHave?: number;
  } | null;
  autoSync?: boolean;
}

/**
 * The COROS card: connect once, then Sync now (or wait for the daily
 * background sync). The 50-FIT-a-day quota is COROS's, so backfilling a long
 * history takes a few days — the card says so rather than leaving the user to
 * wonder why it stopped at fifty.
 */
function CorosCard({ onSyncDone }: { onSyncDone: () => void }) {
  const status = useGet<CorosStatus>('/api/integrations/coros');
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [awaitingPaste, setAwaitingPaste] = useState(false);
  const [pasteDone, setPasteDone] = useState<string | null>(null);

  // The connect finishes in another tab; refresh this card when the user comes
  // back, rather than making them reload.
  useEffect(() => {
    const onFocus = () => { if (!status.data?.connected) status.reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.connected]);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    setPasteDone(null);
    try {
      const res = await api.post<{ url: string; manual: boolean }>('/api/integrations/coros/connect', {});
      // The OAuth flow happens in a separate tab. With an https PUBLIC_URL the
      // browser lands back on Fitberg by itself; otherwise COROS's own page
      // shows a code after login, which the user types into the field below.
      window.open(res.url, '_blank', 'noopener');
      setAwaitingPaste(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
    } finally {
      setBusy(null);
    }
  };

  const completePaste = async () => {
    setBusy('connect');
    setError(null);
    try {
      await api.post('/api/integrations/coros/complete', { code: pasted });
      setPasteDone('Connected.');
      setAwaitingPaste(false);
      setPasted('');
      status.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete');
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const res = await api.post<{ report: NonNullable<CorosStatus['lastSync']> }>(
        '/api/integrations/coros/sync', {},
      );
      status.reload();
      onSyncDone();
      if (res.report?.quotaExhausted) {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(null);
      status.reload();
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await api.post('/api/integrations/coros/disconnect', {});
      status.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  };

  const last = status.data?.lastSync;
  const sub = status.data?.connected
    ? (status.data.accountName ? `Connected — ${status.data.accountName}` : 'Connected')
    : 'Not connected';

  return (
    <Card
      title="COROS"
      sub={sub}
      style={{ marginBottom: '1rem' }}
    >
      {status.loading ? <Loading /> : status.data?.connected ? (
        <>
          {last && (
            <div className="card-sub" style={{ marginBottom: '0.75rem' }}>
              Last sync {status.data.lastSyncAt ? relativeTime(status.data.lastSyncAt) : '—'}:
              {' '}{last.imported ?? 0} new, {last.merged ?? 0} merged,
              {' '}{last.duplicates ?? 0} already present
              {last.alreadyHave ? ` · ${last.alreadyHave} already in your library` : ''}
              {last.quotaUsed ? ` · ${last.quotaUsed}/50 downloads today` : ''}
              {last.quotaExhausted
                ? ` · daily quota reached, ${last.deferred ?? 0} still to come tomorrow`
                : ''}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button" className="btn btn-primary"
              disabled={busy !== null} onClick={sync}
            >
              {busy === 'sync' ? <span className="spinner" /> : 'Sync now'}
            </button>
            <button
              type="button" className="btn"
              disabled={busy !== null} onClick={disconnect}
            >
              Disconnect
            </button>
          </div>

          <p className="card-sub" style={{ marginTop: '0.75rem' }}>
            Fitberg also syncs COROS automatically about once a day while it runs.
            COROS caps downloads at 50 activity files a day, so a first backfill
            of a long history takes a few days — it keeps going by itself.
            Every sync re-checks your whole COROS history, so nothing can be
            left behind and there is never anything to reset.
          </p>
        </>
      ) : (
        <>
          <p className="card-sub" style={{ margin: '0 0 0.75rem' }}>
            Connect your COROS account through COROS's official MCP service to pull
            new activities automatically — FIT files, straight from the source.
          </p>
          {awaitingPaste && (
            <div className="notice" style={{ marginBottom: '0.875rem' }}>
              <span className="notice-icon" aria-hidden="true">i</span>
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <span>
                  Almost there — two steps in the tab that just opened:
                </span>
                <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.25rem' }}>
                  <li>Log in to COROS and approve the connection.</li>
                  <li>You land back on COROS's website. <strong>Copy the web
                      address</strong> (Ctrl+L, then Ctrl+C) and paste it below.</li>
                </ol>
                <div style={{ display: 'flex', gap: '0.5rem', maxWidth: '34rem' }}>
                  <input
                    type="text" value={pasted} spellCheck={false}
                    placeholder="Paste the address you landed on"
                    onChange={(e) => setPasted(e.target.value)}
                    style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}
                  />
                  <button
                    type="button" className="btn btn-sm" disabled={!pasted || busy !== null}
                    onClick={completePaste}
                  >
                    Finish
                  </button>
                </div>
              </div>
            </div>
          )}
          <button
            type="button" className="btn btn-primary"
            disabled={busy !== null} onClick={connect}
          >
            {busy === 'connect' ? <span className="spinner" /> : 'Connect COROS'}
          </button>
          {pasteDone && <span className="card-sub" style={{ marginLeft: '0.75rem' }}>{pasteDone}</span>}
        </>
      )}
      {error && <div style={{ marginTop: '0.75rem' }}><ErrorNotice error={error} /></div>}
    </Card>
  );
}

/**
 * One box for everything.
 *
 * There is no reason to have a separate flow per platform: they all hand you an archive,
 * and files are identified by reading them rather than by their name or their folder. So
 * a whole export ZIP, a folder off a head unit and a single gzipped FIT file all go in
 * the same place, and anything already stored is recognised and skipped.
 */
function ImportBox({ onFiles }: { onFiles: (files: FileReport[]) => void }) {
  const [showSources, setShowSources] = useState(false);

  return (
    <Card
      title="Import"
      sub="Drop anything in — a whole export ZIP, a folder of files, or one file"
      style={{ marginBottom: '1rem' }}
      action={
        <button type="button" className="btn btn-sm" onClick={() => setShowSources(!showSources)}>
          {showSources ? 'Hide' : 'Where do I get one?'}
        </button>
      }
    >
      {showSources && (
        <ul style={{
          margin: '0 0 1rem', paddingLeft: '1.25rem', fontSize: '0.875rem',
          color: 'var(--text-2)', display: 'grid', gap: '0.5rem',
        }}>
          {SOURCES.map((source) => (
            <li key={source.label}>
              {source.href
                ? <a href={source.href} target="_blank" rel="noreferrer"><strong>{source.label}</strong> ↗</a>
                : <strong>{source.label}</strong>}
              {' — '}{source.how}
            </li>
          ))}
        </ul>
      )}

      <DropZone label="Drop your export ZIP, FIT or TCX files here" onImported={onFiles} big />

      <p className="card-sub" style={{ marginTop: '0.75rem' }}>
        Unzipping is not necessary, and neither is sorting anything first. Importing the same
        data twice is safe — Fitberg matches activities on what they physically are, so
        duplicates collapse into one.
      </p>
    </Card>
  );
}

// ─── shared upload widget ─────────────────────────────────────────────────────

function DropZone({ label = 'Drop FIT files here', onImported, big = false }: {
  label?: string; onImported: (files: FileReport[]) => void; big?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    setProgress(0);
    try {
      const result = await api.upload('/api/import', files, setProgress);
      onImported(result.files || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  return (
    <>
      <div
        className={`drop-zone${dragging ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) upload(files);
        }}
        style={{ padding: big ? '3rem 1.25rem' : '1.75rem 1.25rem' }}
      >
        {uploading ? (
          <>
            <h3>Uploading…</h3>
            <div style={{
              height: 8, borderRadius: 4, background: 'var(--surface-3)',
              overflow: 'hidden', maxWidth: '22rem', margin: '0 auto 0.5rem',
            }}>
              <div style={{
                width: `${Math.round(progress * 100)}%`, height: '100%',
                background: 'var(--series-1)', transition: 'width 0.2s',
              }} />
            </div>
            <p>
              {Math.round(progress * 100)}%
              {progress >= 1 && ' — uploaded, now reading. A large archive takes a few minutes.'}
            </p>
          </>
        ) : (
          <>
            <h3>{label}</h3>
            <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
              Choose files
            </button>
            <input
              ref={inputRef} type="file" multiple hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) upload(files);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      {error && <div style={{ marginTop: '0.75rem' }}><ErrorNotice error={error} /></div>}
    </>
  );
}

// ─── result ───────────────────────────────────────────────────────────────────

function ImportResult({ reports }: { reports: FileReport[] }) {
  const totals = reports.reduce((acc, r) => ({
    imported: acc.imported + (r.imported || 0),
    merged: acc.merged + (r.merged || 0),
    duplicates: acc.duplicates + (r.duplicates || 0),
    skipped: acc.skipped + (r.skipped || 0),
    failed: acc.failed + (r.failed || 0),
  }), { imported: 0, merged: 0, duplicates: 0, skipped: 0, failed: 0 });

  // Skips are grouped by reason server-side, so a 500-file archive reports
  // "88 × GPX file" rather than 88 identical lines.
  const skipReasons: Record<string, number> = {};
  for (const r of reports) {
    for (const [reason, count] of Object.entries(r.skipReasons || {})) {
      skipReasons[reason] = (skipReasons[reason] || 0) + count;
    }
  }

  return (
    <Card
      title="Import result"
      sub={`${totals.imported} new · ${totals.merged} merged · ${totals.duplicates} already present`}
      style={{ marginBottom: '1rem' }}
    >
      {totals.imported === 0 && totals.merged === 0 && totals.duplicates > 0 && (
        <div className="notice good" style={{ marginBottom: '0.875rem' }}>
          <span className="notice-icon" aria-hidden="true">✓</span>
          <div>
            Everything in this file was already in Fitberg, so nothing changed. Re-importing is
            always safe — activities are matched on when they happened and how far you went.
          </div>
        </div>
      )}

      {Object.keys(skipReasons).length > 0 && (
        <div className="notice" style={{ marginBottom: '0.875rem' }}>
          <span className="notice-icon" aria-hidden="true">i</span>
          <div>
            <strong>{number(totals.skipped)} file{totals.skipped === 1 ? '' : 's'} skipped.</strong>
            <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
              {Object.entries(skipReasons)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <li key={reason}>{number(count)} × {reason}</li>
                ))}
            </ul>
          </div>
        </div>
      )}

      {reports.map((report) => (
        <div key={report.filename} style={{ marginBottom: '0.75rem' }}>
          <h3 style={{ marginBottom: '0.25rem' }}>{report.filename}</h3>
          {report.error ? <ErrorNotice error={report.error} /> : (
            <div className="card-sub">
              {number(report.imported)} imported · {number(report.merged)} merged ·
              {' '}{number(report.duplicates)} duplicate · {number(report.skipped)} skipped
              {report.failed ? ` · ${report.failed} failed` : ''}
            </div>
          )}

          {report.warnings && report.warnings.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
              </summary>
              <ul style={{ fontSize: '0.8125rem', color: 'var(--text-2)', marginTop: '0.375rem' }}>
                {report.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}

          {report.log && report.log.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                Show every file
              </summary>
              <div className="table-wrap" style={{ marginTop: '0.5rem', maxHeight: '20rem', overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>File</th><th>Result</th><th>Detail</th></tr></thead>
                  <tbody>
                    {report.log.slice(0, 200).map((entry, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>{entry.file}</td>
                        <td><span className="badge">{entry.status}</span></td>
                        <td className="card-sub">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      ))}
    </Card>
  );
}
