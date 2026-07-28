import { useState } from 'react';
import { api } from '../lib/api';

/**
 * First-run setup and sign-in.
 *
 * In register mode this is the very first screen anyone sees, so it says what
 * Fitberg is for rather than just asking for credentials.
 */
export function Login({ mode, onDone }: { mode: 'login' | 'register'; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') {
        await api.post('/api/auth/register', { email, password, displayName });
      } else {
        await api.post('/api/auth/login', { email, password });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1.5rem' }}>
      <div style={{ width: '100%', maxWidth: '25rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l7 9H5z" fill="var(--series-1)" />
            <path d="M5 11h14l3 5H2z" fill="var(--series-1)" opacity="0.55" />
            <path d="M2 16h20l-2 6H4z" fill="var(--series-1)" opacity="0.3" />
          </svg>
          <h1 style={{ marginTop: '0.75rem' }}>
            {mode === 'register' ? 'Set up Fitberg' : 'Welcome back'}
          </h1>
          <p style={{ color: 'var(--text-2)', margin: '0.5rem 0 0', fontSize: '0.9375rem' }}>
            {mode === 'register'
              ? 'Your fitness data, in your own cloud, forever. Create the account that will own it.'
              : 'Sign in to your Fitberg.'}
          </p>
        </div>

        <form onSubmit={submit} className="card" style={{ display: 'grid', gap: '0.875rem' }}>
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">Your name <span className="hint">(optional)</span></label>
              <input
                id="name" value={displayName} autoComplete="name"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email" type="email" value={email} required autoComplete="username"
              onChange={(e) => setEmail(e.target.value)}
            />
            {mode === 'register' && (
              <span className="hint">
                Used only to sign in. Nothing is ever sent anywhere — this stays on your server.
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password" type="password" value={password} required
              minLength={mode === 'register' ? 8 : undefined}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'register' && <span className="hint">At least 8 characters.</span>}
          </div>

          {error && (
            <div className="notice bad">
              <span className="notice-icon" aria-hidden="true">!</span>
              <div>{error}</div>
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={busy}
            style={{ justifyContent: 'center', padding: '0.5625rem' }}>
            {busy ? <span className="spinner" /> : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {mode === 'register' && (
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', textAlign: 'center', marginTop: '1rem' }}>
            Running on a trusted network and want no login at all?
            Set <code>FITBERG_OPEN_ACCESS=1</code> in your .env.
          </p>
        )}
      </div>
    </div>
  );
}
