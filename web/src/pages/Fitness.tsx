import { useState } from 'react';
import { useGet } from '../lib/hooks';
import type { FitnessDay } from '../lib/api';
import { Card, Loading, ErrorNotice, Metric, StatTile } from '../components/common';
import { FitnessChart, FormChart } from '../charts/FitnessChart';
import { ZoneBars, PeriodBars } from '../charts/Bars';
import type { Zone } from '../charts/Bars';
import { Calendar } from '../charts/Calendar';
import type { CalendarDay } from '../charts/Calendar';
import { number, hours, signed, duration } from '../lib/format';

const RANGES = [
  { days: 42, label: '6 weeks' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 1825, label: 'All' },
];

export function Fitness() {
  const [range, setRange] = useState(180);
  const [totalsBy, setTotalsBy] = useState<'week' | 'month' | 'year'>('month');

  const fitness = useGet<{ days: FitnessDay[] }>(`/api/stats/fitness?days=${range}`, [range]);
  const zones = useGet<{ hr: Zone[] | null; power: any; pace: any; estimated: Record<string, string> }>(
    `/api/stats/zones?days=${Math.min(range, 365)}`, [range],
  );
  const totals = useGet<{ periods: any[] }>(`/api/stats/totals?by=${totalsBy}`, [totalsBy]);
  const calendar = useGet<{ days: CalendarDay[] }>(`/api/stats/calendar?days=${Math.min(range, 1095)}`, [range]);

  const days = fitness.data?.days ?? [];
  const latest = days[days.length - 1];

  // Peak fitness in the window is a genuinely motivating number, and it makes the
  // current value legible as "near your best" or "well below it".
  const peak = days.reduce<FitnessDay | null>(
    (best, d) => (d.ctl !== null && (!best || (best.ctl ?? 0) < d.ctl) ? d : best),
    null,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Fitness</h1>
          <p>Training load, form and how your body has responded</p>
        </div>
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.days} type="button" aria-pressed={range === r.days} onClick={() => setRange(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {fitness.error && <ErrorNotice error={fitness.error} onRetry={fitness.reload} />}

      {latest && (
        <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
          <StatTile
            label="Fitness" value={number(latest.ctl, 1)}
            note={peak && peak.ctl ? `Peak in range ${number(peak.ctl, 1)} (${peak.day})` : undefined}
            trend={days.map((d) => d.ctl)}
          />
          <StatTile label="Fatigue" value={number(latest.atl, 1)} trend={days.map((d) => d.atl)} />
          <StatTile
            label="Form" value={signed(latest.tsb, 1)}
            tone={(latest.tsb ?? 0) >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'}
            trend={days.map((d) => d.tsb)}
          />
          <StatTile
            label="Ramp rate" value={signed(latest.rampRate, 1)}
            note={
              (latest.rampRate ?? 0) > 7 ? 'Building fast — fatigue accumulates'
                : (latest.rampRate ?? 0) < -5 ? 'Detraining'
                : 'Sustainable'
            }
          />
        </div>
      )}

      <Card title="Training load" sub="Daily load, with fitness and fatigue over it" style={{ marginBottom: '1rem' }}>
        {fitness.loading ? <Loading /> : <FitnessChart days={days} height={300} />}
      </Card>

      <Card title="Form" sub="Above the line is fresh, below is carrying fatigue" style={{ marginBottom: '1rem' }}>
        {fitness.loading ? <Loading /> : <FormChart days={days} height={170} />}
      </Card>

      <div className="grid grid-2" style={{ marginBottom: '1rem' }}>
        <Card
          title="Time in heart-rate zones"
          sub={
            zones.data?.estimated?.lthr
              ? `Zones anchored on an estimated threshold HR — ${zones.data.estimated.lthr}`
              : 'Zones anchored on your threshold heart rate'
          }
        >
          {zones.loading ? <Loading /> : <ZoneBars zones={zones.data?.hr ?? []} />}
        </Card>

        <Card
          title="Volume"
          action={
            <div className="seg" role="group" aria-label="Group by">
              {(['week', 'month', 'year'] as const).map((by) => (
                <button key={by} type="button" aria-pressed={totalsBy === by} onClick={() => setTotalsBy(by)}>
                  {by[0].toUpperCase() + by.slice(1)}
                </button>
              ))}
            </div>
          }
        >
          {totals.loading ? <Loading /> : (
            <PeriodBars
              periods={(totals.data?.periods ?? []).slice(-24)}
              valueOf={(p) => (p.seconds || 0) / 3600}
              format={(v) => `${v.toFixed(0)}h`}
            />
          )}
        </Card>
      </div>

      <Card title="Consistency" sub="Every day in the range">
        {calendar.loading ? <Loading /> : <Calendar days={calendar.data?.days ?? []} />}
      </Card>

      {latest && (
        <Card title="Load balance" sub="Signals worth watching" style={{ marginTop: '1rem' }}>
          <div className="grid grid-3" style={{ gap: '1rem' }}>
            <Metric
              label="Monotony" value={number(latest.monotony, 2)}
              hint="Weekly mean load divided by its variation. Above 2 means every day looks the same, which carries more illness and injury risk than the same volume with hard and easy days."
            />
            <Metric label="Weekly hours" value={hours((latest.durationS || 0) * 7)} unit="h" />
            <Metric label="Sessions in last day" value={latest.activities} />
          </div>
          {(latest.monotony ?? 0) > 2 && (
            <div className="notice warn" style={{ marginTop: '0.875rem' }}>
              <span className="notice-icon" aria-hidden="true">!</span>
              <div>
                Your training monotony is {number(latest.monotony, 1)}. Every session is carrying
                similar load. Adding a genuinely easy day and a genuinely hard one lowers risk
                without changing your weekly total.
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

export { duration };
