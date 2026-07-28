import { useState } from 'react';
import { useGet } from '../lib/hooks';
import type { Activity } from '../lib/api';
import { Card, Loading, ErrorNotice, Empty, ActivityRow } from '../components/common';
import { number } from '../lib/format';

const PAGE_SIZE = 30;

export function Activities() {
  const [sport, setSport] = useState<string>('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<'date' | 'distance' | 'duration' | 'load'>('date');
  const [page, setPage] = useState(0);

  // Debounce so typing does not fire a query per keystroke.
  const onSearchChange = (value: string) => {
    setSearch(value);
    window.clearTimeout((onSearchChange as any).timer);
    (onSearchChange as any).timer = window.setTimeout(() => {
      setDebouncedSearch(value);
      setPage(0);
    }, 300);
  };

  const sports = useGet<{ sports: { sport: string; label: string; count: number }[] }>(
    '/api/activities/sports',
  );

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    sort,
  });
  if (sport) query.set('sport', sport);
  if (debouncedSearch) query.set('search', debouncedSearch);

  const list = useGet<{ total: number; activities: Activity[] }>(
    `/api/activities?${query}`,
    [sport, debouncedSearch, sort, page],
  );

  const total = list.data?.total ?? 0;
  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activities</h1>
          <p>{number(total)} {total === 1 ? 'activity' : 'activities'}{sport ? ' in this sport' : ''}</p>
        </div>
      </div>

      <div className="controls">
        <input
          type="search"
          placeholder="Search names and notes…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{
            padding: '0.4375rem 0.625rem', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-strong)', background: 'var(--surface-1)', minWidth: '14rem',
          }}
        />

        <select
          value={sport}
          onChange={(e) => { setSport(e.target.value); setPage(0); }}
          style={{
            padding: '0.4375rem 0.5625rem', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-strong)', background: 'var(--surface-1)',
          }}
          aria-label="Filter by sport"
        >
          <option value="">All sports</option>
          {sports.data?.sports.map((s) => (
            <option key={s.sport} value={s.sport}>{s.label} ({s.count})</option>
          ))}
        </select>

        <div className="seg" role="group" aria-label="Sort by">
          {([['date', 'Date'], ['distance', 'Distance'], ['duration', 'Time'], ['load', 'Load']] as const).map(
            ([value, label]) => (
              <button
                key={value} type="button" aria-pressed={sort === value}
                onClick={() => { setSort(value); setPage(0); }}
              >
                {label}
              </button>
            ),
          )}
        </div>
      </div>

      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}

      {list.loading ? <Loading /> : total === 0 ? (
        <Empty title="Nothing matches">
          {debouncedSearch || sport
            ? 'Try clearing the filters.'
            : 'Import some activities to get started.'}
        </Empty>
      ) : (
        <Card>
          <div className="activity-list">
            {list.data?.activities.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </div>

          {pages > 1 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginTop: '1rem', gap: '0.75rem',
            }}>
              <button
                type="button" className="btn btn-sm" disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Newer
              </button>
              <span className="card-sub">Page {page + 1} of {pages}</span>
              <button
                type="button" className="btn btn-sm" disabled={page >= pages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Older →
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
