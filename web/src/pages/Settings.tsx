import type { AppConfig } from '../lib/api';
import { useGet } from '../lib/hooks';
import { useState } from 'react';
import { api } from '../lib/api';
import { Card, Loading, Metric } from '../components/common';
import { bytes } from '../lib/format';

export function Settings({ config, onSignOut }: { config: AppConfig; onSignOut: () => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>The few things worth changing</p>
        </div>
      </div>

      <AiCard />
      <SystemCard onSignOut={onSignOut} config={config} />
    </>
  );
}




/**
 * The AI host and model.
 *
 * A text field and a dropdown, because the alternative was telling a runner to edit
 * OLLAMA_MODEL in a file and restart a container. The dropdown lists what the host
 * actually has installed, so there is nothing to type and nothing to spell wrong.
 */
function AiCard() {
  const settings = useGet<{
    url: string; model: string; fromEnv: { ollamaUrl: boolean; ollamaModel: boolean };
  }>('/api/ai/settings');
  const status = useGet<{
    available: boolean; models: string[]; reason: string | null; hint?: string;
  }>('/api/ai/status');

  const [url, setUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (settings.loading) return <Card title="AI coach"><Loading /></Card>;
  if (!settings.data) return null;

  const currentUrl = url ?? settings.data.url;
  const currentModel = model ?? settings.data.model;
  const installed = status.data?.models ?? [];
  const dirty = currentUrl !== settings.data.url || currentModel !== settings.data.model;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.put<{ status: { available: boolean; reason: string | null } }>(
        '/api/ai/settings', { ollamaUrl: currentUrl, ollamaModel: currentModel },
      );
      setMessage(res.status.available ? 'Connected.' : (res.status.reason || 'Saved.'));
      settings.reload();
      status.reload();
      setUrl(null);
      setModel(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="AI coach"
      sub={status.data?.available ? 'Connected' : 'Not connected'}
      style={{ marginBottom: '1rem' }}
    >
      <div className="grid grid-2" style={{ gap: '0.75rem' }}>
        <label className="field">
          <span className="field-label">Where Ollama is running</span>
          <input
            type="text" value={currentUrl} spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.1.10:11434"
          />
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          {installed.length ? (
            <select value={currentModel} onChange={(e) => setModel(e.target.value)}>
              {!installed.includes(currentModel) && (
                <option value={currentModel}>{currentModel} (not installed)</option>
              )}
              {installed.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              type="text" value={currentModel} spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.2"
            />
          )}
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.875rem' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
          {busy ? <span className="spinner" /> : 'Save'}
        </button>
        {message && <span className="card-sub">{message}</span>}
        {!message && !status.data?.available && status.data?.reason && (
          <span className="card-sub">{status.data.reason}</span>
        )}
      </div>

      {!installed.length && status.data?.hint && (
        <p className="card-sub" style={{ marginTop: '0.75rem' }}>{status.data.hint}</p>
      )}
    </Card>
  );
}

// ─── system ───────────────────────────────────────────────────────────────────

function SystemCard({ config, onSignOut }: { config: AppConfig; onSignOut: () => void }) {
  const system = useGet<any>('/api/system');

  return (
    <Card title="System">
      {system.data && (
        <div className="grid grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
          <Metric label="Version" value={config.version} />
          <Metric label="Node" value={system.data.node} />
          <Metric label="Platform" value={system.data.platform} />
          <Metric label="Database" value={system.data.driver} />
          <Metric label="Database size" value={bytes(system.data.db.sizeBytes)} />
          <Metric label="Memory" value={`${system.data.memoryMb} MB`} />
        </div>
      )}

      <p className="card-sub">
        Data directory: <code>{system.data?.dataDir}</code>
        <br />
        Local AI: {config.ai.available ? `${config.ai.model} ✓` : (config.ai.reason || 'not configured')}
      </p>

      {!config.openAccess && (
        <button
          type="button" className="btn" style={{ marginTop: '0.875rem' }}
          onClick={async () => {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            onSignOut();
          }}
        >
          Sign out
        </button>
      )}
    </Card>
  );
}
