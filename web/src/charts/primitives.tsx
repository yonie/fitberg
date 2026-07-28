import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Chart primitives.
//
// Hand-rolled SVG rather than a charting library: it keeps the bundle small (this
// runs off a Raspberry Pi), and it makes the mark specifications — 2px lines,
// 4px rounded bar ends, 2px gaps between fills, recessive grid — explicit rather
// than fought against.

export interface Scale {
  (value: number): number;
  invert(pixel: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  // A zero-width domain would divide by zero; centre the single value instead.
  const span = d1 - d0 || 1;

  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0 || 1)) * span;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

export function logScale(domain: [number, number], range: [number, number]): Scale {
  // Guard the domain away from zero: log(0) is -Infinity.
  const d0 = Math.max(domain[0], 1e-6);
  const d1 = Math.max(domain[1], d0 * 1.0001);
  const l0 = Math.log(d0);
  const l1 = Math.log(d1);
  const [r0, r1] = range;

  const scale = ((value: number) => {
    const clamped = Math.max(value, d0);
    return r0 + ((Math.log(clamped) - l0) / (l1 - l0)) * (r1 - r0);
  }) as Scale;
  scale.invert = (pixel: number) => Math.exp(l0 + ((pixel - r0) / (r1 - r0 || 1)) * (l1 - l0));
  scale.domain = [d0, d1];
  scale.range = range;
  return scale;
}

/**
 * Axis ticks at human-readable intervals (1, 2, 5, 10 …) rather than the raw
 * domain divided by n, which produces labels like 3.67.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude;

  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let t = start; t <= max + step * 0.001; t += step) {
    // Floating-point accumulation leaves values like 0.30000000000000004.
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

/** Extent of possibly-sparse data, ignoring nulls and NaN. */
export function extent(values: (number | null | undefined)[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? [min, max] : null;
}

/** Pad a domain so marks do not touch the frame, and include zero when sensible. */
export function padDomain(
  domain: [number, number],
  { includeZero = false, padFraction = 0.08 }: { includeZero?: boolean; padFraction?: number } = {},
): [number, number] {
  let [min, max] = domain;
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const span = max - min || Math.abs(max) || 1;
  return [min - span * padFraction, max + span * padFraction];
}

/**
 * Build an SVG path, breaking the line at gaps rather than interpolating across
 * them — a paused recording should show a break, not a straight line through
 * data that does not exist.
 */
export function linePath(
  points: { x: number; y: number | null }[],
): string {
  let path = '';
  let penDown = false;
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) { penDown = false; continue; }
    path += `${penDown ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    penDown = true;
  }
  return path;
}

export function areaPath(
  points: { x: number; y: number | null }[],
  baseline: number,
): string {
  // Emit one closed shape per contiguous run so gaps do not get filled.
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];

  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push({ x: p.x, y: p.y });
  }
  if (current.length) segments.push(current);

  return segments
    .filter((s) => s.length > 1)
    .map((s) => {
      const top = s.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      return `${top}L${s[s.length - 1].x.toFixed(1)},${baseline.toFixed(1)}L${s[0].x.toFixed(1)},${baseline.toFixed(1)}Z`;
    })
    .join('');
}

/**
 * A bar with only its data-end rounded (4px), anchored square to the baseline.
 * Rounding both ends detaches the bar from its axis and reads as a lozenge.
 */
export function barPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}L${x},${y + r}Q${x},${y} ${x + r},${y}`
    + `L${x + width - r},${y}Q${x + width},${y} ${x + width},${y + r}`
    + `L${x + width},${y + height}Z`;
}

/** Downward bar (for negative values), rounded at the bottom. */
export function barPathDown(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y}L${x},${y + height - r}Q${x},${y + height} ${x + r},${y + height}`
    + `L${x + width - r},${y + height}Q${x + width},${y + height} ${x + width},${y + height - r}`
    + `L${x + width},${y}Z`;
}

// ─── chrome components ────────────────────────────────────────────────────────

export function GridLines({ scale, ticks, x0, x1 }: {
  scale: Scale; ticks: number[]; x0: number; x1: number;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <line key={t} className="grid-line" x1={x0} x2={x1} y1={scale(t)} y2={scale(t)} />
      ))}
    </g>
  );
}

export function YAxis({ scale, ticks, x, format }: {
  scale: Scale; ticks: number[]; x: number; format?: (v: number) => string;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <text key={t} className="tick" x={x} y={scale(t)} dy="0.32em" textAnchor="end">
          {format ? format(t) : t}
        </text>
      ))}
    </g>
  );
}

export function XAxisLabels({ items, y }: { items: { x: number; label: string }[]; y: number }) {
  return (
    <g aria-hidden="true">
      {items.map((item, i) => (
        <text key={i} className="tick" x={item.x} y={y} dy="0.71em" textAnchor="middle">
          {item.label}
        </text>
      ))}
    </g>
  );
}

/**
 * A direct label sitting at a series' final point.
 *
 * These are not decoration: several palette slots fall below 3:1 contrast on the
 * light surface, and the validated palette's relief rule requires visible labels
 * so identity is never carried by colour alone.
 */
export function SeriesLabel({ x, y, text, color, anchor = 'start' }: {
  x: number; y: number; text: string; color: string; anchor?: 'start' | 'end';
}) {
  return (
    <text
      className="series-label"
      x={x}
      y={y}
      dy="0.32em"
      textAnchor={anchor}
      fill={color}
      // A ring of surface colour keeps the label legible where it crosses a mark.
      stroke="var(--surface-1)"
      strokeWidth={3}
      paintOrder="stroke"
    >
      {text}
    </text>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.label}>
          <span
            className="legend-swatch"
            style={{
              background: item.dashed
                ? `repeating-linear-gradient(90deg, ${item.color} 0 3px, transparent 3px 5px)`
                : item.color,
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ─── hover / tooltip ──────────────────────────────────────────────────────────

export interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
}

/**
 * Pointer tracking for charts.
 *
 * Interaction is on by default per the visualisation guidance: an SVG chart in a
 * browser is interactive, so line and area charts get a crosshair and tooltip and
 * bars get per-mark hover, without each chart having to wire it up.
 */
export function useTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const frame = useRef<number | null>(null);

  const show = useCallback((event: { clientX: number; clientY: number }, content: ReactNode) => {
    // Coalesce to one update per frame; mousemove fires far more often than that.
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const { clientX, clientY } = event;
    frame.current = requestAnimationFrame(() => {
      setTooltip({ x: clientX, y: clientY, content });
    });
  }, []);

  const hide = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    setTooltip(null);
  }, []);

  return { tooltip, show, hide };
}

export function Tooltip({ state }: { state: TooltipState | null }) {
  if (!state) return null;
  // Flip to the other side near the viewport edge so the tooltip stays on screen.
  const flipX = state.x > window.innerWidth - 220;
  const flipY = state.y > window.innerHeight - 140;
  return (
    <div
      className="tooltip"
      role="status"
      style={{
        left: flipX ? undefined : state.x + 14,
        right: flipX ? window.innerWidth - state.x + 14 : undefined,
        top: flipY ? undefined : state.y + 14,
        bottom: flipY ? window.innerHeight - state.y + 14 : undefined,
      }}
    >
      {state.content}
    </div>
  );
}

export function Crosshair({ x, y0, y1 }: { x: number; y0: number; y1: number }) {
  return <line x1={x} x2={x} y1={y0} y2={y1} stroke="var(--axis)" strokeWidth={1} strokeDasharray="3 3" />;
}

/** Marker on a hovered point. 8px minimum, with a surface ring for separation. */
export function HoverDot({ x, y, color }: { x: number; y: number; color: string }) {
  return <circle cx={x} cy={y} r={4.5} fill={color} stroke="var(--surface-1)" strokeWidth={2} />;
}

export const CHART_MARGIN = { top: 14, right: 56, bottom: 26, left: 44 };
