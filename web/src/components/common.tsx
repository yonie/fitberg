import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkline } from '../charts/FitnessChart';
import { RoutePreview } from './Flyover';
import {
  distance, duration, shortDateLabel, timeLabel, sportIcon, paceOrSpeed, number,
} from '../lib/format';
import type { Activity } from '../lib/api';

export function StatTile({ label, value, unit, note, delta, trend, tone }: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  delta?: { value: number; suffix?: string } | null;
  trend?: (number | null)[];
  tone?: string;
}) {
  return (
    <div className="card stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}{unit && <small>{unit}</small>}
      </span>
      {delta && (
        <span className={`delta ${delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : 'flat'}`}>
          {delta.value > 0 ? '↑' : delta.value < 0 ? '↓' : '→'}
          {Math.abs(delta.value).toFixed(Math.abs(delta.value) < 10 ? 1 : 0)}{delta.suffix}
        </span>
      )}
      {note && <span className="stat-note">{note}</span>}
      {trend && trend.length > 1 && <Sparkline values={trend} width={140} height={26} />}
    </div>
  );
}

export function Card({ title, sub, action, children, style }: {
  title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="card" style={style}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'center', padding: '2rem 0', color: 'var(--text-2)' }}>
      <span className="spinner" /> {label}…
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="notice bad">
      <span className="notice-icon" aria-hidden="true">!</span>
      <div style={{ flex: 1 }}>
        {error}
        {onRetry && (
          <div style={{ marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p style={{ maxWidth: '32rem', margin: '0 auto 1.25rem' }}>{children}</p>}
      {action}
    </div>
  );
}

/**
 * One row in an activity list, showing the route shape — which is how people
 * actually recognise a session.
 *
 * The stats are laid out with container queries rather than viewport media
 * queries, because this row appears both full-width on the activities page and in a
 * half-width dashboard card. Keying off the viewport gets the narrow case wrong in
 * exactly the place it matters.
 */
export function ActivityRow({ activity }: { activity: Activity }) {
  const speed = paceOrSpeed(activity.avgSpeedMs, activity.sport);
  const showSpeed = Boolean(activity.distanceM) && speed.value !== '—';

  return (
    <Link to={`/activities/${activity.id}`} className="activity-row">
      <span className="activity-icon" aria-hidden="true">{sportIcon(activity.sport)}</span>

      <div className="activity-main">
        <div className="activity-title">{activity.displayName || activity.sportLabel}</div>
        <div className="activity-when">
          {shortDateLabel(activity.startTime, activity.utcOffsetS)}
          {' · '}{timeLabel(activity.startTime, activity.utcOffsetS)}
          {activity.trainer && ' · indoor'}
          {activity.commute && ' · commute'}
        </div>
      </div>

      <div className="activity-stats">
        {activity.distanceM ? (
          <MiniStat label="Distance" value={distance(activity.distanceM)} />
        ) : null}
        <MiniStat label="Time" value={duration(activity.movingS ?? activity.elapsedS)} />
        {showSpeed && (
          <MiniStat label={speed.unit === '/km' ? 'Pace' : 'Speed'} value={speed.value} secondary />
        )}
        {activity.avgHr ? <MiniStat label="HR" value={Math.round(activity.avgHr)} secondary /> : null}
        {activity.load ? <MiniStat label="Load" value={Math.round(activity.load)} /> : null}
      </div>

      <span className="activity-route">
        <RoutePreview polyline={activity.polyline} width={84} height={38} />
      </span>
    </Link>
  );
}

/** `secondary` marks a stat that gets dropped first when the row is cramped. */
function MiniStat({ label, value, secondary }: { label: string; value: ReactNode; secondary?: boolean }) {
  return (
    <div className={`activity-stat${secondary ? ' is-secondary' : ''}`}>
      <div className="activity-stat-label">{label}</div>
      <div className="activity-stat-value">{value}</div>
    </div>
  );
}

/** A labelled value used across the detail pages. */
export function Metric({ label, value, unit, hint }: {
  label: string; value: ReactNode; unit?: string; hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: '1.125rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value}{unit && <small style={{ fontSize: '0.7em', fontWeight: 500, color: 'var(--text-2)', marginLeft: '0.15em' }}>{unit}</small>}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async (event) => {
        const button = event.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          const original = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = original; }, 1400);
        } catch {
          // Clipboard access needs a secure context; many self-hosters are on
          // plain http over a LAN, so say something useful instead of failing mutely.
          button.textContent = 'Select and copy manually';
        }
      }}
    >
      {label}
    </button>
  );
}

export { number };
