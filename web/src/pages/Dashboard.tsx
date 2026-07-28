import { Link } from 'react-router-dom';
import { useGet } from '../lib/hooks';
import type { AppConfig, Dashboard as DashboardData, FitnessDay } from '../lib/api';
import { Card, StatTile, Loading, ErrorNotice, Empty, ActivityRow, Metric } from '../components/common';
import { FitnessChart, FormChart } from '../charts/FitnessChart';
import { Calendar } from '../charts/Calendar';
import type { CalendarDay } from '../charts/Calendar';
import { duration, hours, number, signed } from '../lib/format';

export function Dashboard({ config }: { config: AppConfig }) {
  const dash = useGet<DashboardData>('/api/stats/dashboard');
  const fitness = useGet<{ days: FitnessDay[] }>('/api/stats/fitness?days=120');
  const calendar = useGet<{ days: CalendarDay[] }>('/api/stats/calendar?days=273');

  if (dash.loading) return <Loading />;
  if (dash.error) return <ErrorNotice error={dash.error} onRetry={dash.reload} />;
  if (!dash.data) return null;

  const d = dash.data;

  if (d.totals.activities === 0) {
    return (
      <Empty title="No activities yet">
        Fitberg is running and ready. Bring your history over from Strava, your watch or
        anywhere else — it reads whatever you throw at it.
        <div style={{ marginTop: '1.25rem' }}>
          <Link className="btn btn-primary" to="/welcome">Start the setup guide</Link>
        </div>
      </Empty>
    );
  }

  const weekLoad = d.last7.load || 0;
  // Compare against the seven days before, not a monthly average — a recovery week
  // against a monthly mean reads as a catastrophe rather than as a plan.
  const prevWeekLoad = d.prev7?.load || 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            {number(d.totals.activities)} activities ·
            {' '}{number(d.totals.distanceM / 1000, 0)} km ·
            {' '}{hours(d.totals.seconds, 0)} hours ·
            {' '}{number(d.totals.elevationM, 0)} m climbed
          </p>
        </div>
      </div>

      {/* Fitness leads: it is the "where has my training left me" answer, and it
          needs nothing but the activity files. */}
      <Card title="Fitness &amp; form" sub="Where your training has left you" style={{ marginBottom: '1rem' }}>
        {d.fitness ? (
          <>
            <div className="grid grid-4" style={{ gap: '0.875rem', marginBottom: '1rem' }}>
              <Metric
                label="Fitness"
                value={number(d.fitness.ctl, 1)}
                hint="Chronic training load: a 42-day weighted average of your daily load."
              />
              <Metric
                label="Fatigue"
                value={number(d.fitness.atl, 1)}
                hint="Acute training load: a 7-day weighted average."
              />
              <Metric
                label="Form"
                value={signed(d.fitness.tsb, 1)}
                hint="Fitness minus fatigue. Positive means fresh."
              />
              {d.fitness.vo2max ? (
                <Metric label="VO₂max estimate" value={number(d.fitness.vo2max, 1)} unit="ml/kg/min" />
              ) : null}
            </div>

            <div className="notice" style={{
              borderColor: d.fitness.form.tone === 'warn' ? 'color-mix(in srgb, var(--critical) 45%, transparent)'
                : d.fitness.form.tone === 'caution' ? 'color-mix(in srgb, var(--warning) 45%, transparent)'
                : 'color-mix(in srgb, var(--good) 40%, transparent)',
            }}>
              <span className="notice-icon" aria-hidden="true">
                {d.fitness.form.tone === 'good' ? '✓' : d.fitness.form.tone === 'warn' ? '!' : 'i'}
              </span>
              <div>
                <strong>{d.fitness.form.label}.</strong>
                {d.fitness.form.note && ` ${d.fitness.form.note}.`}
                {d.fitness.rampRate !== null && Math.abs(d.fitness.rampRate) > 0.5 && (
                  <>
                    {' '}Fitness is {d.fitness.rampRate > 0 ? 'rising' : 'falling'} by{' '}
                    {Math.abs(d.fitness.rampRate).toFixed(1)} a week.
                    {d.fitness.rampRate > 7 && ' That is a fast build — watch for accumulating fatigue.'}
                    {d.fitness.rampRate < -5 && ' Sustained, that becomes detraining.'}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <p className="card-sub">Import some activities to see this.</p>
        )}
      </Card>

      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <StatTile
          label="This week"
          value={number(weekLoad, 0)}
          note={`${d.last7.activities} sessions · ${duration(d.last7.seconds)}`}
          delta={prevWeekLoad > 0
            ? { value: ((weekLoad - prevWeekLoad) / prevWeekLoad) * 100, suffix: '% vs last week' }
            : null}
        />
        <StatTile
          label="7-day distance"
          value={number((d.last7.distance || 0) / 1000, 1)}
          unit="km"
          note={`${number((d.last7.elevation || 0), 0)} m climbed`}
        />
        <StatTile
          label="30-day volume"
          value={hours(d.last30.seconds)}
          unit="h"
          note={`${d.last30.activities} sessions`}
        />
        <StatTile
          label="Last 12 months"
          value={number((d.last365.distance || 0) / 1000, 0)}
          unit="km"
          note={`${d.last365.activities} sessions · ${hours(d.last365.seconds, 0)} h`}
        />
      </div>

      <Card
        title="Training load"
        sub="Daily load with fitness and fatigue over it — all in the same units, on one axis"
        style={{ marginBottom: '1rem' }}
        action={<Link className="btn btn-sm" to="/fitness">Full history</Link>}
      >
        {fitness.loading ? <Loading /> : <FitnessChart days={fitness.data?.days ?? []} />}
      </Card>

      <Card title="Form" sub="Fitness minus fatigue. Above the line is fresh." style={{ marginBottom: '1rem' }}>
        {fitness.loading ? <Loading /> : <FormChart days={fitness.data?.days ?? []} />}
      </Card>

      <div className="grid grid-2">
        <Card title="Recent activities" action={<Link className="btn btn-sm" to="/activities">See all</Link>}>
          <div className="activity-list">
            {d.recent.map((activity) => <ActivityRow key={activity.id} activity={activity} />)}
          </div>
        </Card>

        <Card title="Consistency" sub="The last nine months">
          {calendar.loading ? <Loading /> : <Calendar days={calendar.data?.days ?? []} />}
        </Card>
      </div>

      {!config.ai.available && (
        <div className="notice" style={{ marginTop: '1rem' }}>
          <span className="notice-icon" aria-hidden="true">i</span>
          <div>
            <strong>The AI coach is not configured.</strong> Point <code>OLLAMA_URL</code> at an Ollama
            host and Fitberg will write a weekly training review, comment on individual sessions and
            answer questions about your data.
            {config.ai.reason && <> <span style={{ color: 'var(--text-3)' }}>({config.ai.reason})</span></>}
          </div>
        </div>
      )}
    </>
  );
}
