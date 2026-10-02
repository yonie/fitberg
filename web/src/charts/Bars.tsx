import {
  linearScale, logScale, niceTicks, extent, linePath, barPath, GridLines, YAxis,
  Tooltip, useTooltip, HoverDot,
} from './primitives';
import { useMeasure } from '../lib/hooks';
import { duration, effortDuration, splitLabel, number, shortDateLabel } from '../lib/format';

// Ordinal blue ramp for the five training zones.
//
// Zones are a discrete *ordered* scale, so this is the ordinal case: one hue,
// monotone lightness, and the lightest step still clears the surface (it starts at
// step 250 rather than 100 for exactly that reason).
const ZONE_RAMP = ['var(--seq-250)', 'var(--seq-350)', 'var(--seq-450)', 'var(--seq-550)', 'var(--seq-650)'];

export interface Zone {
  zone: number;
  name: string;
  min: number;
  max: number;
  seconds: number;
}

/**
 * Time in heart-rate zones, as a horizontal stacked bar plus a per-zone list.
 * Horizontal because the zone names are long, which is what the form guidance
 * recommends for many or long-named categories.
 */
export function ZoneBars({ zones }: { zones: Zone[] }) {
  const { tooltip, show, hide } = useTooltip();
  const total = zones.reduce((a, z) => a + z.seconds, 0);

  if (total <= 0) {
    return (
      <p className="card-sub">
        No heart-rate samples in this period, so there is no zone distribution to show.
      </p>
    );
  }

  return (
    <div>
      {/* Stacked overview. The 2px gaps between segments are the required spacer. */}
      <div
        style={{ display: 'flex', gap: 2, height: 16, marginBottom: '1rem' }}
        onMouseLeave={hide}
        role="img"
        aria-label={`Time in zones: ${zones.map((z) => `${z.name} ${Math.round((z.seconds / total) * 100)}%`).join(', ')}`}
      >
        {zones.map((z, i) => {
          const share = z.seconds / total;
          if (share <= 0) return null;
          return (
            <div
              key={z.zone}
              style={{
                flex: `${share} 1 0`, background: ZONE_RAMP[i] ?? ZONE_RAMP[ZONE_RAMP.length - 1],
                borderRadius: 3, minWidth: 2,
              }}
              onMouseMove={(event) => show(event, (
                <>
                  <div className="tooltip-title">Zone {z.zone} — {z.name}</div>
                  <div className="tooltip-row"><span>Time</span><span>{duration(z.seconds)}</span></div>
                  <div className="tooltip-row"><span>Share</span><span>{Math.round(share * 100)}%</span></div>
                  <div className="tooltip-row"><span>Range</span><span>{Math.round(z.min)}–{Math.round(z.max)} bpm</span></div>
                </>
              ))}
            />
          );
        })}
      </div>

      {/* The table view, which doubles as the direct-label relief. */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Zone</th>
              <th className="num">Range</th>
              <th className="num">Time</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z, i) => (
              <tr key={z.zone}>
                <td>
                  <span className="legend-item">
                    <span className="legend-swatch" style={{ background: ZONE_RAMP[i] }} />
                    Z{z.zone} {z.name}
                  </span>
                </td>
                <td className="num">{Math.round(z.min)}–{Math.round(z.max)}</td>
                <td className="num">{duration(z.seconds)}</td>
                <td className="num">{Math.round((z.seconds / total) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Tooltip state={tooltip} />
    </div>
  );
}

/**
 * Mean-maximal power (or heart rate) curve.
 *
 * Log x-axis because the durations span 1 second to 90 minutes; a linear axis
 * would compress everything under a minute into a few pixels, which is precisely
 * the region a sprinter cares about.
 */
export function EffortCurve({ points, unit, height = 220, color = 'var(--series-1)' }: {
  points: { bucket: number; value: number }[];
  unit: string;
  height?: number;
  color?: string;
}) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const { tooltip, show, hide } = useTooltip();

  const width = size.width || 640;
  const margin = { top: 12, right: 16, bottom: 30, left: 44 };
  const innerWidth = Math.max(10, width - margin.left - margin.right);
  const innerHeight = Math.max(10, height - margin.top - margin.bottom);

  if (points.length < 2) {
    return <p className="card-sub">Not enough data for a curve yet.</p>;
  }

  const sorted = [...points].sort((a, b) => a.bucket - b.bucket);
  const span = extent(sorted.map((p) => p.value))!;
  const x = logScale([sorted[0].bucket, sorted[sorted.length - 1].bucket], [0, innerWidth]);
  const y = linearScale([Math.max(0, span[0] * 0.9), span[1] * 1.05], [innerHeight, 0]);
  const yTicks = niceTicks(y.domain[0], y.domain[1], 4);

  // Label only the decade-ish durations, so ticks never collide.
  const xTickValues = [1, 5, 15, 60, 300, 1200, 3600].filter(
    (t) => t >= x.domain[0] && t <= x.domain[1],
  );

  return (
    <div ref={ref}>
      <svg
        className="chart" viewBox={`0 0 ${width} ${height}`} style={{ height }}
        role="img" aria-label={`Best effort curve in ${unit}`}
        onMouseLeave={hide}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridLines scale={y} ticks={yTicks} x0={0} x1={innerWidth} />
          <YAxis scale={y} ticks={yTicks} x={-8} />

          <path
            d={linePath(sorted.map((p) => ({ x: x(p.bucket), y: y(p.value) })))}
            fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round"
          />

          {/* Markers at 8px so each measured point is a real hit target. */}
          {sorted.map((p) => (
            <circle
              key={p.bucket}
              cx={x(p.bucket)} cy={y(p.value)} r={4}
              fill={color} stroke="var(--surface-1)" strokeWidth={2}
              onMouseMove={(event) => show(event, (
                <>
                  <div className="tooltip-title">{effortDuration(p.bucket)}</div>
                  <div className="tooltip-row">
                    <span>Best</span><span>{Math.round(p.value)} {unit}</span>
                  </div>
                </>
              ))}
            />
          ))}

          <line className="axis-line" x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} />
          {xTickValues.map((t) => (
            <text key={t} className="tick" x={x(t)} y={innerHeight + 8} dy="0.71em" textAnchor="middle">
              {effortDuration(t)}
            </text>
          ))}
        </g>
      </svg>
      <Tooltip state={tooltip} />
    </div>
  );
}

/**
 * Fastest times per distance.
 *
 * The sport column is not decoration. Without filtering, the fastest 5 km in a mixed
 * history is almost always on a bike, and rendering that as a running pace claims a
 * 2:04/km 5 k — so each row states which sport it came from, and speed is formatted
 * the way that sport is actually read: pace for running and walking, km/h for
 * cycling. Filter by sport for a comparable list.
 */
export function SplitsTable({ splits, family }: {
  splits: {
    bucket: number; value: number; activityId: number; activityName: string | null;
    startTime: number; sport?: string;
    /** Set when the whole activity measured just short of the distance and counts anyway. */
    measuredM?: number;
  }[];
  /** Sport family, so a distance is named the way that sport names it. */
  family?: string;
}) {
  if (!splits.length) return <p className="card-sub">No distance records yet.</p>;

  const sports = new Set(splits.map((s) => s.sport).filter(Boolean));
  const mixed = sports.size > 1;

  return (
    <>
      {mixed && (
        <div className="notice" style={{ marginBottom: '0.875rem' }}>
          <span className="notice-icon" aria-hidden="true">i</span>
          <div>
            These records span several sports, so they are not comparable with each other —
            a fast 5 km on a bike is not a fast 5 km on foot. Pick a sport above for a list
            that is.
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Distance</th>
              {mixed && <th>Sport</th>}
              <th className="num">Best time</th>
              <th className="num">Speed</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => {
              const speedMs = s.bucket / s.value;
              const asPace = /run|walk|hike|swim/.test(s.sport || 'run');
              const secPerKm = 1000 / speedMs;
              return (
                <tr key={`${s.bucket}-${s.sport ?? ''}`}>
                  <td>{splitLabel(s.bucket, family)}</td>
                  {mixed && (
                    <td>
                      <span className="badge">{prettySportLabel(s.sport)}</span>
                    </td>
                  )}
                  <td className="num">{duration(s.value, 'clock')}</td>
                  <td className="num">
                    {asPace
                      ? `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}/km`
                      : `${(speedMs * 3.6).toFixed(1)} km/h`}
                  </td>
                  <td>
                    <a href={`/activities/${s.activityId}`}>
                      {s.activityName || shortDateLabel(s.startTime)}
                    </a>
                    {(s.activityName || s.measuredM) && (
                      <span className="card-sub" style={{ display: 'block' }}>
                        {[
                          s.activityName && shortDateLabel(s.startTime),
                          s.measuredM && `measured ${(s.measuredM / 1000).toFixed(2)} km`,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const prettySportLabel = (sport?: string) =>
  String(sport || 'other').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Simple vertical bars for period totals. Sequential — magnitude, one hue. */
export function PeriodBars({ periods, valueOf, format, height = 200 }: {
  periods: { period: string; [key: string]: any }[];
  valueOf: (p: any) => number;
  format?: (v: number) => string;
  height?: number;
}) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const { tooltip, show, hide } = useTooltip();

  const width = size.width || 640;
  const margin = { top: 12, right: 12, bottom: 34, left: 48 };
  const innerWidth = Math.max(10, width - margin.left - margin.right);
  const innerHeight = Math.max(10, height - margin.top - margin.bottom);

  if (!periods.length) return <p className="card-sub">No data yet.</p>;

  const values = periods.map(valueOf);
  const yMax = Math.max(...values, 1) * 1.08;
  const y = linearScale([0, yMax], [innerHeight, 0]);
  const step = innerWidth / periods.length;
  // 2px of surface between adjacent bars, per the spacer rule.
  const barWidth = Math.max(2, Math.min(38, step - 2));
  const yTicks = niceTicks(0, yMax, 4);

  const labelStep = Math.max(1, Math.ceil(periods.length / 12));

  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} style={{ height }}
        role="img" aria-label="Totals per period" onMouseLeave={hide}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridLines scale={y} ticks={yTicks} x0={0} x1={innerWidth} />
          <YAxis scale={y} ticks={yTicks} x={-8} format={format ? (v) => format(v) : undefined} />

          {periods.map((p, i) => {
            const value = valueOf(p);
            const barHeight = innerHeight - y(value);
            return (
              <path
                key={p.period}
                d={barPath(i * step + (step - barWidth) / 2, y(value), barWidth, barHeight)}
                fill="var(--series-1)"
                onMouseMove={(event) => show(event, (
                  <>
                    <div className="tooltip-title">{p.period}</div>
                    <div className="tooltip-row">
                      <span>Value</span>
                      <span>{format ? format(value) : number(value)}</span>
                    </div>
                    {p.activities !== undefined && (
                      <div className="tooltip-row"><span>Sessions</span><span>{p.activities}</span></div>
                    )}
                  </>
                ))}
              />
            );
          })}

          <line className="axis-line" x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} />
          {periods.map((p, i) => (i % labelStep === 0 ? (
            <text
              key={p.period} className="tick"
              x={i * step + step / 2} y={innerHeight + 8} dy="0.71em"
              textAnchor="middle"
            >
              {periodLabel(p.period)}
            </text>
          ) : null))}
        </g>
      </svg>
      <Tooltip state={tooltip} />
    </div>
  );
}

/**
 * Turn a SQLite period key into something readable: "2026-03" -> "Mar",
 * "2026-W12" -> "W12", "2026" -> "2026". Bare month numbers are meaningless as
 * axis labels.
 */
function periodLabel(period: string): string {
  const week = /^(\d{4})-W(\d{1,2})$/.exec(period);
  if (week) return `W${Number(week[2])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const date = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));
    return date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
  }
  return period;
}

/** A single ratio against a target. Same-ramp track, per the meter guidance. */
export function Meter({ value, max, label, unit, color = 'var(--series-1)' }: {
  value: number; max: number; label: string; unit?: string; color?: string;
}) {
  const fraction = Math.max(0, Math.min(1, value / (max || 1)));
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="stat-label">{label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.875rem' }}>
          {number(value, 1)}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden', marginTop: '0.3125rem' }}>
        <div style={{ width: `${fraction * 100}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}

export function HoverPoint(props: { x: number; y: number; color: string }) {
  return <HoverDot {...props} />;
}
