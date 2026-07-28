import { useMemo, useState } from 'react';
import {
  linearScale, niceTicks, extent, linePath, areaPath, barPath, GridLines, YAxis, XAxisLabels,
  SeriesLabel, Legend, Tooltip, Crosshair, HoverDot, useTooltip, CHART_MARGIN,
} from './primitives';
import { useMeasure } from '../lib/hooks';
import { dayLabel } from '../lib/format';
import type { FitnessDay } from '../lib/api';

/**
 * The performance-management chart: daily training load as bars, with fitness
 * (42-day average) and fatigue (7-day average) as lines over the top.
 *
 * All three share one y-axis on purpose — they are all in the same load units, so
 * a second axis would be both unnecessary and misleading. Form is a separate chart
 * below because it is a *polarity* measure and wants diverging colour, not a third
 * line competing for the same space.
 */
export function FitnessChart({ days, height = 260 }: { days: FitnessDay[]; height?: number }) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const { tooltip, show, hide } = useTooltip();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = size.width || 720;
  const margin = CHART_MARGIN;
  const innerWidth = Math.max(10, width - margin.left - margin.right);
  const innerHeight = Math.max(10, height - margin.top - margin.bottom);

  const chart = useMemo(() => {
    if (!days.length) return null;

    const loadMax = Math.max(...days.map((d) => d.load || 0));
    const ctlMax = extent(days.map((d) => d.ctl))?.[1] ?? 0;
    const atlMax = extent(days.map((d) => d.atl))?.[1] ?? 0;
    const yMax = Math.max(loadMax, ctlMax, atlMax, 10) * 1.08;

    const x = linearScale([0, Math.max(1, days.length - 1)], [0, innerWidth]);
    const y = linearScale([0, yMax], [innerHeight, 0]);
    const barWidth = Math.max(1, Math.min(14, (innerWidth / days.length) - 2));

    return { x, y, barWidth, yTicks: niceTicks(0, yMax, 4) };
  }, [days, innerWidth, innerHeight]);

  if (!days.length) {
    return <p className="card-sub">No training data yet.</p>;
  }
  if (!chart) return null;

  const { x, y, barWidth, yTicks } = chart;
  const last = days[days.length - 1];

  // Roughly six date labels, whatever the range.
  const labelStep = Math.max(1, Math.floor(days.length / 6));
  const xLabels = days
    .map((d, i) => ({ i, d }))
    .filter(({ i }) => i % labelStep === 0)
    .map(({ i, d }) => ({ x: x(i), label: dayLabel(d.day) }));

  const hovered = hoverIndex === null ? null : days[hoverIndex];

  return (
    <div ref={ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        role="img"
        aria-label={`Training load, fitness and fatigue over the last ${days.length} days. Fitness is currently ${Math.round(last.ctl || 0)}, fatigue ${Math.round(last.atl || 0)}.`}
        onMouseLeave={() => { setHoverIndex(null); hide(); }}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridLines scale={y} ticks={yTicks} x0={0} x1={innerWidth} />
          <YAxis scale={y} ticks={yTicks} x={-8} />

          {/* Daily load: sequential, recessive — context for the lines. */}
          <g>
            {days.map((d, i) => {
              if (!d.load) return null;
              const barHeight = innerHeight - y(d.load);
              return (
                <path
                  key={d.day}
                  d={barPath(x(i) - barWidth / 2, y(d.load), barWidth, barHeight, 3)}
                  fill="var(--seq-200)"
                  opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.5}
                />
              );
            })}
          </g>

          {/* Fitness: filled to read as the accumulated base it represents. */}
          <path
            d={areaPath(days.map((d, i) => ({ x: x(i), y: d.ctl === null ? null : y(d.ctl) })), innerHeight)}
            fill="var(--series-1)"
            opacity={0.13}
          />
          <path
            d={linePath(days.map((d, i) => ({ x: x(i), y: d.ctl === null ? null : y(d.ctl) })))}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
          />

          {/* Fatigue */}
          <path
            d={linePath(days.map((d, i) => ({ x: x(i), y: d.atl === null ? null : y(d.atl) })))}
            fill="none"
            stroke="var(--series-2)"
            strokeWidth={2}
            strokeLinejoin="round"
          />

          <line className="axis-line" x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} />
          <XAxisLabels items={xLabels} y={innerHeight + 6} />

          {/* Direct labels: required relief for the sub-3:1 palette slots. */}
          {last.ctl !== null && (
            <SeriesLabel x={innerWidth + 6} y={y(last.ctl)} text={`${Math.round(last.ctl)}`} color="var(--series-1)" />
          )}
          {last.atl !== null && (
            <SeriesLabel x={innerWidth + 6} y={y(last.atl)} text={`${Math.round(last.atl)}`} color="var(--series-2)" />
          )}

          {hovered && hoverIndex !== null && (
            <>
              <Crosshair x={x(hoverIndex)} y0={0} y1={innerHeight} />
              {hovered.ctl !== null && <HoverDot x={x(hoverIndex)} y={y(hovered.ctl)} color="var(--series-1)" />}
              {hovered.atl !== null && <HoverDot x={x(hoverIndex)} y={y(hovered.atl)} color="var(--series-2)" />}
            </>
          )}

          {/* One transparent hit area, so the pointer never falls between marks. */}
          <rect
            x={0} y={0} width={innerWidth} height={innerHeight} fill="transparent"
            onMouseMove={(event) => {
              const bounds = (event.target as SVGRectElement).getBoundingClientRect();
              const index = Math.round(x.invert(event.clientX - bounds.left));
              const clamped = Math.max(0, Math.min(days.length - 1, index));
              setHoverIndex(clamped);
              const d = days[clamped];
              show(event, (
                <>
                  <div className="tooltip-title">{dayLabel(d.day)}</div>
                  <div className="tooltip-row"><span>Load</span><span>{Math.round(d.load)}</span></div>
                  <div className="tooltip-row"><span>Fitness</span><span>{d.ctl === null ? '—' : Math.round(d.ctl)}</span></div>
                  <div className="tooltip-row"><span>Fatigue</span><span>{d.atl === null ? '—' : Math.round(d.atl)}</span></div>
                  <div className="tooltip-row"><span>Form</span><span>{d.tsb === null ? '—' : Math.round(d.tsb)}</span></div>
                  {d.activities > 0 && (
                    <div className="tooltip-row"><span>Sessions</span><span>{d.activities}</span></div>
                  )}
                </>
              ));
            }}
          />
        </g>
      </svg>

      <Legend items={[
        { label: 'Fitness (42-day)', color: 'var(--series-1)' },
        { label: 'Fatigue (7-day)', color: 'var(--series-2)' },
        { label: 'Daily load', color: 'var(--seq-200)' },
      ]} />
      <Tooltip state={tooltip} />
    </div>
  );
}

/**
 * Form (training stress balance) as a diverging chart around zero.
 *
 * Form is polarity data — fresh above the line, fatigued below — so it gets the
 * diverging blue/red pair with a neutral zero baseline, rather than being a third
 * line on the chart above.
 */
export function FormChart({ days, height = 150 }: { days: FitnessDay[]; height?: number }) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const { tooltip, show, hide } = useTooltip();

  const width = size.width || 720;
  const margin = { ...CHART_MARGIN, top: 10, bottom: 22 };
  const innerWidth = Math.max(10, width - margin.left - margin.right);
  const innerHeight = Math.max(10, height - margin.top - margin.bottom);

  if (!days.length) return null;

  const span = extent(days.map((d) => d.tsb)) ?? [-10, 10];
  const bound = Math.max(Math.abs(span[0]), Math.abs(span[1]), 10);
  // Symmetric domain, so "10 above" and "10 below" are the same distance.
  const y = linearScale([-bound, bound], [innerHeight, 0]);
  const x = linearScale([0, Math.max(1, days.length - 1)], [0, innerWidth]);
  const zero = y(0);

  const labelStep = Math.max(1, Math.floor(days.length / 6));
  const xLabels = days
    .map((d, i) => ({ i, d }))
    .filter(({ i }) => i % labelStep === 0)
    .map(({ i, d }) => ({ x: x(i), label: dayLabel(d.day) }));

  const last = days[days.length - 1];

  return (
    <div ref={ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        role="img"
        aria-label={`Form over time. Currently ${Math.round(last.tsb || 0)}.`}
        onMouseLeave={hide}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridLines scale={y} ticks={niceTicks(-bound, bound, 3)} x0={0} x1={innerWidth} />
          <YAxis scale={y} ticks={niceTicks(-bound, bound, 3)} x={-8} />

          {/* Positive and negative filled separately so each keeps its own hue. */}
          <path
            d={areaPath(
              days.map((d, i) => ({ x: x(i), y: d.tsb === null ? null : y(Math.max(0, d.tsb)) })),
              zero,
            )}
            fill="var(--div-pos)"
            opacity={0.2}
          />
          <path
            d={areaPath(
              days.map((d, i) => ({ x: x(i), y: d.tsb === null ? null : y(Math.min(0, d.tsb)) })),
              zero,
            )}
            fill="var(--div-neg)"
            opacity={0.2}
          />
          <path
            d={linePath(days.map((d, i) => ({ x: x(i), y: d.tsb === null ? null : y(d.tsb) })))}
            fill="none"
            stroke={(last.tsb ?? 0) >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'}
            strokeWidth={2}
            strokeLinejoin="round"
          />

          {/* The neutral midpoint: the reference the whole chart is read against. */}
          <line x1={0} x2={innerWidth} y1={zero} y2={zero} stroke="var(--axis)" strokeWidth={1.5} />
          <XAxisLabels items={xLabels} y={innerHeight + 4} />

          {last.tsb !== null && (
            <SeriesLabel
              x={innerWidth + 6}
              y={y(last.tsb)}
              text={`${last.tsb > 0 ? '+' : ''}${Math.round(last.tsb)}`}
              color={last.tsb >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'}
            />
          )}

          <rect
            x={0} y={0} width={innerWidth} height={innerHeight} fill="transparent"
            onMouseMove={(event) => {
              const bounds = (event.target as SVGRectElement).getBoundingClientRect();
              const index = Math.max(0, Math.min(days.length - 1, Math.round(x.invert(event.clientX - bounds.left))));
              const d = days[index];
              show(event, (
                <>
                  <div className="tooltip-title">{dayLabel(d.day)}</div>
                  <div className="tooltip-row">
                    <span>Form</span>
                    <span>{d.tsb === null ? '—' : `${d.tsb > 0 ? '+' : ''}${Math.round(d.tsb)}`}</span>
                  </div>
                  <div className="tooltip-row">
                    <span>{(d.tsb ?? 0) >= 5 ? 'Fresh' : (d.tsb ?? 0) > -10 ? 'Neutral' : (d.tsb ?? 0) > -30 ? 'Building' : 'Overreaching'}</span>
                    <span />
                  </div>
                </>
              ));
            }}
          />
        </g>
      </svg>
      <Legend items={[
        { label: 'Fresh (positive form)', color: 'var(--div-pos)' },
        { label: 'Fatigued (negative form)', color: 'var(--div-neg)' },
      ]} />
      <Tooltip state={tooltip} />
    </div>
  );
}

/** A compact single-series trend for stat tiles. No axes, no legend, no tooltip. */
export function Sparkline({ values, width = 100, height = 28, color = 'var(--series-1)' }: {
  values: (number | null)[]; width?: number; height?: number; color?: string;
}) {
  const span = extent(values);
  if (!span) return null;

  const [min, max] = span[0] === span[1] ? [span[0] - 1, span[1] + 1] : span;
  const x = linearScale([0, Math.max(1, values.length - 1)], [1, width - 1]);
  const y = linearScale([min, max], [height - 2, 2]);
  const points = values.map((v, i) => ({ x: x(i), y: v === null ? null : y(v) }));

  return (
    <svg width={width} height={height} className="chart" aria-hidden="true" style={{ overflow: 'visible' }}>
      <path d={areaPath(points, height)} fill={color} opacity={0.14} />
      <path d={linePath(points)} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" />
    </svg>
  );
}
