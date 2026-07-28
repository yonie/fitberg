import { Suspense, lazy } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useGet, useSession } from './lib/hooks';
import type { AppConfig } from './lib/api';
import { Loading } from './components/common';

import { Dashboard } from './pages/Dashboard';
import { Activities } from './pages/Activities';
import { Fitness } from './pages/Fitness';
import { Records } from './pages/Records';
import { Import } from './pages/Import';
import { Export } from './pages/Export';
import { Settings } from './pages/Settings';
import { Coach } from './pages/Coach';
import { Login } from './pages/Login';

// The activity detail page pulls in MapLibre, which is by far the largest
// dependency. Loading it on demand keeps the dashboard fast on a home server.
const ActivityDetail = lazy(() => import('./pages/ActivityDetail').then((m) => ({ default: m.ActivityDetail })));

export function App() {
  const session = useSession();
  const config = useGet<AppConfig>('/api/config');

  if (session.loading) {
    return <div style={{ padding: '3rem' }}><Loading label="Starting Fitberg" /></div>;
  }

  // Nobody has set this instance up yet.
  if (!session.initialised) {
    return <Login mode="register" onDone={session.refresh} />;
  }
  if (!session.userId) {
    return <Login mode="login" onDone={session.refresh} />;
  }
  if (!config.data) {
    return <div style={{ padding: '3rem' }}><Loading /></div>;
  }

  return <Shell config={config.data} onSignOut={session.refresh} />;
}

function Shell({ config, onSignOut }: { config: AppConfig; onSignOut: () => void }) {

  return (
    <div className="app">
      <Nav config={config} onSignOut={onSignOut} />
      <main className="main">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Dashboard config={config} />} />
            <Route path="/activities" element={<Activities />} />
            <Route path="/activities/:id" element={<ActivityDetail config={config} />} />
            <Route path="/fitness" element={<Fitness />} />
            <Route path="/records" element={<Records />} />
            <Route path="/coach" element={<Coach config={config} />} />
            <Route path="/import" element={<Import />} />
            <Route path="/export" element={<Export />} />
            <Route path="/settings" element={<Settings config={config} onSignOut={onSignOut} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}


function Nav({ config, onSignOut }: { config: AppConfig; onSignOut: () => void }) {

  return (
    <nav className="nav">
      <Link to="/" className="nav-brand">
        <Logo />
        Fitberg
      </Link>

      <NavLink to="/" end><Icon d="M3 12h4l3-8 4 16 3-8h4" /> Dashboard</NavLink>
      <NavLink to="/activities"><Icon d="M4 6h16M4 12h16M4 18h10" /> Activities</NavLink>
      <NavLink to="/fitness"><Icon d="M3 17l5-6 4 3 5-8 4 4" /> Fitness</NavLink>
      <NavLink to="/records"><Icon d="M8 21h8M12 17v4M6 4h12v5a6 6 0 0 1-12 0z" /> Records</NavLink>
      {config.ai.available && (
        <NavLink to="/coach"><Icon d="M12 3a7 7 0 0 1 7 7c0 3-2 4-2 6H7c0-2-2-3-2-6a7 7 0 0 1 7-7zM9 20h6" /> Coach</NavLink>
      )}
      <NavLink to="/import"><Icon d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /> Import</NavLink>
      <NavLink to="/export"><Icon d="M12 3v12m0-12l-4 4m4-4l4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /> Export</NavLink>
      <NavLink to="/settings"><Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z" /> Settings</NavLink>

      <div className="nav-spacer" />

      <div className="nav-foot">
        <div>Fitberg {config.version}</div>
        {!config.openAccess && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: '0.5rem', padding: '0.125rem 0.4375rem', fontSize: '0.75rem' }}
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
              onSignOut();
            }}
          >
            Sign out
          </button>
        )}
      </div>
    </nav>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      {/* An iceberg: most of your data sits below the surface, and it is yours. */}
      <path d="M12 2l7 9H5z" fill="var(--series-1)" />
      <path d="M5 11h14l3 5H2z" fill="var(--series-1)" opacity="0.55" />
      <path d="M2 16h20l-2 6H4z" fill="var(--series-1)" opacity="0.3" />
    </svg>
  );
}
