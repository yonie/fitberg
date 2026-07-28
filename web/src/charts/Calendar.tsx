import { useMemo } from 'react';
import { Tooltip, useTooltip } from './primitives';
import { useMeasure } from '../lib/hooks';
import { duration, distance } from '../lib/format';

// Training calendar heat map.
//
// Magnitude on a grid, so this is sequential colour: one hue, more-is-darker. The
// lightest step is allowed to recede toward the surface because "no training" is a
// real and common value that should visually disappear.

const RAMP = [
  'var(--surface-2)',   // nothing
  'var(--seq-100)',
  'var(--seq-200)',
  'var(--seq-350)',
  'var(--seq-450)',
  'var(--seq-600)',
];

export interface CalendarDay {
  day: string;
  load: number;
  durationS: number;
  distanceM: number;
  activities: number;
}

export function Calendar({ days, metric = 'load' }: {
  days: CalendarDay[];
  metric?: 'load' | 'duration' | 'distance';
}) {
  const { tooltip, show, hide } = useTooltip();
  const [ref, size] = useMeasure<HTMLDivElement>();

  const { weeks, thresholds, monthLabels } = useMemo(() => {
    const valueOf = (d: CalendarDay) =>
      metric === 'load' ? d.load : metric === 'duration' ? d.durationS : d.distanceM;

    // Quantile breaks rather than equal intervals: one enormous week would
    // otherwise flatten every ordinary day into the palest step.
    const nonZero = days.map(valueOf).filter((v) => v > 0).sort((a, b) => a - b);
    const quantile = (q: number) => nonZero.length ? nonZero[Math.floor(q * (nonZero.length - 1))] : 0;
    const breaks = [quantile(0.2), quantile(0.45), quantile(0.7), quantile(0.9)];

    // Bucket into calendar weeks starting Monday, so columns are weeks.
    const columns: (CalendarDay | null)[][] = [];
    let current: (CalendarDay | null)[] = [];

    if (days.length) {
      const firstDow = (new Date(`${days[0].day}T12:00:00Z`).getUTCDay() + 6) % 7;
      for (let i = 0; i < firstDow; i++) current.push(null);
    }

    for (const day of days) {
      current.push(day);
      if (current.length === 7) { columns.push(current); current = []; }
    }
    if (current.length) {
      while (current.length < 7) current.push(null);
      columns.push(current);
    }

    // Month labels.
    //
    // Check every day in the column, not just the first one: a column whose first
    // day is the 29th of one month and whose later days start the next month must
    // still get the new month's label, otherwise whole months go unlabelled.
    const labels: { column: number; label: string }[] = [];
    let lastMonth = -1;
    columns.forEach((column, index) => {
      for (const day of column) {
        if (!day) continue;
        const date = new Date(`${day.day}T12:00:00Z`);
        const month = date.getUTCMonth();
        if (month !== lastMonth && date.getUTCDate() <= 7) {
          labels.push({
            column: index,
            label: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
          });
          lastMonth = month;
          break;
        }
      }
    });

    return { weeks: columns, thresholds: breaks, monthLabels: labels };
  }, [days, metric]);

  // Size the cells to the space available rather than using a fixed 12px, which
  // overflowed its card for any range longer than about six months and silently
  // clipped the most recent weeks — the ones you most want to see.
  const topPad = 16;
  const leftPad = 22;
  const available = (size.width || 620) - leftPad - 2;
  const perColumn = weeks.length ? available / weeks.length : 15;
  const cell = Math.max(5, Math.min(14, Math.floor(perColumn) - 3));
  const gap = cell >= 9 ? 3 : 2;
  const width = leftPad + weeks.length * (cell + gap);
  const height = topPad + 7 * (cell + gap);

  const valueOf = (d: CalendarDay) =>
    metric === 'load' ? d.load : metric === 'duration' ? d.durationS : d.distanceM;

  const colorFor = (d: CalendarDay | null) => {
    if (!d) return 'transparent';
    const v = valueOf(d);
    if (v <= 0) return RAMP[0];
    if (v <= thresholds[0]) return RAMP[1];
    if (v <= thresholds[1]) return RAMP[2];
    if (v <= thresholds[2]) return RAMP[3];
    if (v <= thresholds[3]) return RAMP[4];
    return RAMP[5];
  };

  const activeDays = days.filter((d) => d.activities > 0).length;

  return (
    <div ref={ref}>
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={width} height={height} className="chart"
          role="img"
          aria-label={`Training calendar: ${activeDays} active days out of ${days.length}.`}
          onMouseLeave={hide}
        >
          {monthLabels.map((m) => (
            <text
              key={`${m.column}-${m.label}`}
              className="tick"
              x={leftPad + m.column * (cell + gap)}
              y={9}
            >
              {m.label}
            </text>
          ))}

          {cell >= 8 && ['M', 'W', 'F'].map((label, i) => (
            <text key={label} className="tick" x={0} y={topPad + (i * 2) * (cell + gap) + cell - 1}>
              {label}
            </text>
          ))}

          {weeks.map((column, weekIndex) =>
            column.map((day, dayIndex) => {
              if (!day) return null;
              return (
                <rect
                  key={day.day}
                  x={leftPad + weekIndex * (cell + gap)}
                  y={topPad + dayIndex * (cell + gap)}
                  width={cell}
                  height={cell}
                  rx={cell >= 9 ? 2.5 : 1.5}
                  fill={colorFor(day)}
                  // A hairline keeps adjacent same-value cells from merging.
                  stroke="var(--surface-1)"
                  strokeWidth={0.5}
                  onMouseMove={(event) => show(event, (
                    <>
                      <div className="tooltip-title">
                        {new Date(`${day.day}T12:00:00Z`).toLocaleDateString(undefined, {
                          weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
                        })}
                      </div>
                      {day.activities > 0 ? (
                        <>
                          <div className="tooltip-row"><span>Sessions</span><span>{day.activities}</span></div>
                          <div className="tooltip-row"><span>Load</span><span>{Math.round(day.load)}</span></div>
                          <div className="tooltip-row"><span>Time</span><span>{duration(day.durationS)}</span></div>
                          {day.distanceM > 0 && (
                            <div className="tooltip-row"><span>Distance</span><span>{distance(day.distanceM)}</span></div>
                          )}
                        </>
                      ) : (
                        <div className="tooltip-row"><span>Rest day</span><span /></div>
                      )}
                    </>
                  ))}
                />
              );
            }),
          )}
        </svg>
      </div>

      <div className="legend" style={{ justifyContent: 'space-between' }}>
        <span>{activeDays} active days of {days.length}</span>
        <span className="legend-item">
          Less
          {RAMP.map((c) => (
            <span key={c} className="legend-swatch" style={{ background: c, width: 11, height: 11 }} />
          ))}
          More
        </span>
      </div>

      <Tooltip state={tooltip} />
    </div>
  );
}
