import { useMemo, useState } from 'react';
import {
  linearScale, niceTicks, extent, linePath, areaPath, GridLines, YAxis,
  Tooltip, Crosshair, useTooltip,
} from './primitives';
import { useMeasure } from '../lib/hooks';
import { distance, duration, pace, number } from '../lib/format';

// Activity stream charts.
//
// Heart rate, power, elevation and pace have completely different units, so they
// are drawn as SMALL MULTIPLES sharing one x-axis — never as multiple series on a
// dual y-axis, which is the single most misleading thing a chart can do. Stacking
// them keeps every comparison honest while still letting you read a climb against
// the heart-rate response to it.
//
// A shared hover index links the panels, so one pointer position reads out every
// channel at once.

export interface StreamData {
  n: number;
  channels: Record<string, (number | null)[]>;
}

type Axis = 'time' | 'distance';

interface PanelSpec {
  key: string;
  label: string;
  unit: string;
  color: string;
  fill?: boolean;
  format: (v: number) => string;
  invert?: boolean;
}

const PANELS: PanelSpec[] = [
  {
    key: 'alt', label: 'Elevation', unit: 'm', color: 'var(--text-3)', fill: true,
    format: (v) => `${Math.round(v)} m`,
  },
  {
    key: 'hr', label: 'Heart rate', unit: 'bpm', color: 'var(--series-8)',
    format: (v) => `${Math.round(v)} bpm`,
  },
  {
    key: 'power', label: 'Power', unit: 'W', color: 'var(--series-4)',
    format: (v) => `${Math.round(v)} W`,
  },
  {
    key: 'speed', label: 'Pace', unit: '/km', color: 'var(--series-1)',
    // Pace is inverted: faster is a *lower* number, so the axis reads upside down
    // to keep "higher on the chart" meaning "going better".
    invert: true,
    format: (v) => `${pace(v)}/km`,
  },
  {
    key: 'cad', label: 'Cadence', unit: 'spm', color: 'var(--series-3)',
    format: (v) => `${Math.round(v)}`,
  },
];

export function StreamCharts({ streams, sport, onHoverIndex, followIndex }: {
  streams: StreamData;
  sport: string;
  onHoverIndex?: (index: number | null) => void;
  /**
   * Where the flyover currently is. Used when the pointer is not over the charts, so the
   * crosshair tracks the flight instead of sitting still while the map moves.
   */
  followIndex?: number | null;
}) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const { tooltip, show, hide } = useTooltip();
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  // The pointer wins while it is over the charts; otherwise the flyover drives.
  const hoverIndex = pointerIndex ?? followIndex ?? null;
  const [axis, setAxis] = useState<Axis>(streams.channels.dist ? 'distance' : 'time');

  const width = size.width || 720;
  const margin = { top: 10, right: 14, bottom: 4, left: 46 };
  const innerWidth = Math.max(10, width - margin.left - margin.right);

  const active = useMemo(
    () => PANELS.filter((p) => {
      const values = streams.channels[p.key];
      if (!values) return false;
      // A channel of all-nulls exists in some files; do not draw an empty panel.
      return values.some((v) => v !== null && Number.isFinite(v));
    }),
    [streams],
  );

  const xValues = useMemo(() => {
    const dist = streams.channels.dist;
    const time = streams.channels.t;
    if (axis === 'distance' && dist) return dist;
    return time ?? dist ?? null;
  }, [axis, streams]);

  // Where each sample sits on the x axis.
  //
  // A sample can be missing its x reading — a pause leaves a run of trackpoints with no
  // distance on them — and there is no honest position for one. This used to fall back to
  // the sample INDEX, which feeds an index into a scale whose domain is metres: a gap 1300
  // samples into a 730 m activity landed the point at nearly twice the plot width, and
  // `.chart` deliberately does not clip, so the line drew out across the page.
  //
  // Distance never goes backwards, so the last reading before a gap is where the athlete
  // still was. Carrying it forward is both true and, unlike an index, always in domain.
  const xAt = useMemo(() => {
    if (!xValues) return [];
    const out: number[] = new Array(xValues.length);
    let last = NaN;
    for (let i = 0; i < xValues.length; i++) {
      const v = xValues[i];
      if (v !== null && Number.isFinite(v)) last = v;
      out[i] = last;
    }
    // A gap at the very start has nothing behind it, so it borrows the first real reading.
    const first = out.find((v) => Number.isFinite(v)) ?? 0;
    for (let i = 0; i < out.length && !Number.isFinite(out[i]); i++) out[i] = first;
    return out;
  }, [xValues]);

  if (!active.length || !xValues) {
    return <p className="card-sub">This activity has no detailed sample data.</p>;
  }

  const xSpan = extent(xValues) ?? [0, 1];
  const x = linearScale([xSpan[0], xSpan[1]], [0, innerWidth]);

  const setHover = (index: number | null) => {
    setPointerIndex(index);
    onHoverIndex?.(index);
  };

  const xLabel = (value: number) =>
    axis === 'distance' ? distance(value) : duration(value, 'clock');

  return (
    <div ref={ref}>
      {streams.channels.dist && streams.channels.t && (
        <div className="controls" style={{ marginBottom: '0.5rem', justifyContent: 'flex-end' }}>
          <div className="seg" role="group" aria-label="X axis">
            <button type="button" aria-pressed={axis === 'distance'} onClick={() => setAxis('distance')}>
              Distance
            </button>
            <button type="button" aria-pressed={axis === 'time'} onClick={() => setAxis('time')}>
              Time
            </button>
          </div>
        </div>
      )}

      <div onMouseLeave={() => { setHover(null); hide(); }}>
        {active.map((panel, panelIndex) => {
          const values = streams.channels[panel.key];
          const span = extent(values);
          if (!span) return null;

          const isLast = panelIndex === active.length - 1;
          const panelHeight = panel.key === 'alt' ? 92 : 108;
          const innerHeight = panelHeight - margin.top - (isLast ? 22 : 8);

          // Pace: invert the range so faster (higher speed) sits higher.
          const yDomain: [number, number] = panel.invert
            ? [span[0] * 0.95, span[1] * 1.05]
            : [Math.max(0, span[0] - (span[1] - span[0]) * 0.1), span[1] + (span[1] - span[0]) * 0.1 || 1];
          const y = linearScale(yDomain, [innerHeight, 0]);
          const yTicks = niceTicks(yDomain[0], yDomain[1], 3);

          const points = values.map((v, i) => ({
            x: x(xAt[i]),
            y: v === null || !Number.isFinite(v) ? null : y(v),
          }));

          const hoverValue = hoverIndex === null ? null : values[hoverIndex];

          return (
            <div key={panel.key} style={{ position: 'relative' }}>
              <svg
                className="chart"
                viewBox={`0 0 ${width} ${panelHeight}`}
                style={{ height: panelHeight, display: 'block' }}
                role="img"
                aria-label={`${panel.label} over ${axis}`}
              >
                <g transform={`translate(${margin.left},${margin.top})`}>
                  <GridLines scale={y} ticks={yTicks} x0={0} x1={innerWidth} />
                  <YAxis
                    scale={y} ticks={yTicks} x={-8}
                    format={(v) => (panel.key === 'speed' ? pace(v) : String(Math.round(v)))}
                  />

                  {panel.fill && (
                    <path d={areaPath(points, innerHeight)} fill={panel.color} opacity={0.18} />
                  )}
                  <path
                    d={linePath(points)} fill="none" stroke={panel.color}
                    strokeWidth={panel.fill ? 1.5 : 2} strokeLinejoin="round"
                  />

                  {hoverIndex !== null && <Crosshair x={x(xAt[hoverIndex])} y0={0} y1={innerHeight} />}
                  {hoverIndex !== null && hoverValue !== null && Number.isFinite(hoverValue) && (
                    <circle
                      cx={x(xAt[hoverIndex])} cy={y(hoverValue as number)} r={4}
                      fill={panel.color} stroke="var(--surface-1)" strokeWidth={2}
                    />
                  )}

                  {/* Panel title inside the plot: no room for a separate header row. */}
                  <text x={2} y={-1} className="series-label" fill={panel.color}>
                    {panel.label}
                  </text>

                  {isLast && (
                    <>
                      <line className="axis-line" x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} />
                      {niceTicks(xSpan[0], xSpan[1], 6).map((t) => (
                        <text
                          key={t} className="tick" x={x(t)} y={innerHeight + 6} dy="0.71em"
                          textAnchor="middle"
                        >
                          {xLabel(t)}
                        </text>
                      ))}
                    </>
                  )}

                  <rect
                    x={0} y={0} width={innerWidth} height={innerHeight} fill="transparent"
                    onMouseMove={(event) => {
                      const bounds = (event.target as SVGRectElement).getBoundingClientRect();
                      const target = x.invert(event.clientX - bounds.left);
                      const index = nearestIndex(xAt, target);
                      setHover(index);
                      show(event, (
                        <>
                          <div className="tooltip-title">
                            {xLabel(xAt[index])}
                            {axis === 'distance' && streams.channels.t
                              ? ` · ${duration(streams.channels.t[index] ?? 0, 'clock')}`
                              : ''}
                          </div>
                          {active.map((p) => {
                            const v = streams.channels[p.key]?.[index];
                            if (v === null || v === undefined || !Number.isFinite(v)) return null;
                            return (
                              <div className="tooltip-row" key={p.key}>
                                <span>{p.label}</span>
                                <span>{p.format(v)}</span>
                              </div>
                            );
                          })}
                        </>
                      ));
                    }}
                  />
                </g>
              </svg>
            </div>
          );
        })}
      </div>

      {sport.includes('swim') && (
        <p className="card-sub" style={{ marginTop: '0.5rem' }}>Pace is per 100 m.</p>
      )}

      <Tooltip state={tooltip} />
    </div>
  );
}

/** Binary search for the sample nearest a value on a monotonic axis. */
function nearestIndex(values: (number | null)[], target: number): number {
  let lo = 0;
  let hi = values.length - 1;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const v = values[mid];
    if (v === null || !Number.isFinite(v)) { lo = mid; continue; }
    if (v < target) lo = mid; else hi = mid;
  }

  const loValue = values[lo] ?? 0;
  const hiValue = values[hi] ?? 0;
  return Math.abs(loValue - target) <= Math.abs(hiValue - target) ? lo : hi;
}

/** Lap table. Enough rows that a table beats a chart. */
export function LapsTable({ laps, sport }: { laps: any[]; sport: string }) {
  if (!laps?.length) return null;
  const showPower = laps.some((l) => l.avg_power);
  const isPaceSport = /run|walk|hike|swim/.test(sport);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Lap</th>
            <th className="num">Distance</th>
            <th className="num">Time</th>
            <th className="num">{isPaceSport ? 'Pace' : 'Speed'}</th>
            <th className="num">HR</th>
            {showPower && <th className="num">Power</th>}
            <th className="num">Climb</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => (
            <tr key={lap.idx}>
              <td>{lap.idx + 1}</td>
              <td className="num">{distance(lap.distance_m)}</td>
              <td className="num">{duration(lap.elapsed_s, 'clock')}</td>
              <td className="num">
                {isPaceSport
                  ? (lap.avg_speed_ms ? `${pace(lap.avg_speed_ms)}/km` : '—')
                  : (lap.avg_speed_ms ? `${(lap.avg_speed_ms * 3.6).toFixed(1)} km/h` : '—')}
              </td>
              <td className="num">{lap.avg_hr ? Math.round(lap.avg_hr) : '—'}</td>
              {showPower && <td className="num">{lap.avg_power ? Math.round(lap.avg_power) : '—'}</td>}
              <td className="num">{lap.elev_gain_m ? `${Math.round(lap.elev_gain_m)} m` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { number };
