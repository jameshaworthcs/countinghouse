// Time series: stacked (diverging) areas and lines, with a crosshair that snaps to the nearest date
// and one tooltip listing every series. Keyboard: focus the chart and use ← →.

import { scaleLinear, scaleUtc } from 'd3-scale';
import { area as d3area, curveMonotoneX, line as d3line, stack as d3stack, stackOffsetDiverging } from 'd3-shape';
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatDate } from '../../../shared/dates';
import { compact, money } from '../../lib/format';
import { ChartTooltip, TooltipRow, useWidth } from './common';

export interface TimeSeries {
  id: string;
  label: string;
  color: string;
  values: (number | null)[];
  kind: 'area' | 'line';
  dashed?: boolean;
  stack?: boolean;
  markers?: boolean;
  /** Hide from tooltip/end labels (e.g. a helper band). */
  quiet?: boolean;
}

interface Props {
  dates: string[];
  series: TimeSeries[];
  height?: number;
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
  endLabels?: boolean;
  /** Index where projected values start; draws a "today" rule. */
  splitIndex?: number;
  ariaLabel: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toTime = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

function tickLabel(t: Date, spanDays: number): string {
  const m = t.getUTCMonth();
  const y = t.getUTCFullYear();
  if (spanDays <= 120) return `${t.getUTCDate()} ${MONTHS[m]}`;
  if (m === 0 || spanDays > 1400) return String(y);
  return spanDays > 540 ? `${MONTHS[m]} ${String(y).slice(2)}` : MONTHS[m]!;
}

export function TimeChart({ dates, series, height = 260, format = (v) => money(v), axisFormat = (v) => compact(v), endLabels = false, splitIndex, ariaLabel }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const times = useMemo(() => dates.map(toTime), [dates]);
  const labelSpace = endLabels ? 118 : 12;
  const margin = { top: 10, right: labelSpace, bottom: 26, left: 58 };
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;

  const model = useMemo(() => {
    if (!dates.length || innerW <= 0) return null;
    const stacked = series.filter((s) => s.kind === 'area' && s.stack);
    const rows = dates.map((_, i) => Object.fromEntries(stacked.map((s) => [s.id, s.values[i] ?? 0])) as Record<string, number>);
    const layers = stacked.length ? d3stack<Record<string, number>>().keys(stacked.map((s) => s.id)).offset(stackOffsetDiverging)(rows) : [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of layers) for (const [a, b] of l) {
      lo = Math.min(lo, a, b);
      hi = Math.max(hi, a, b);
    }
    for (const s of series) {
      if (s.kind === 'area' && s.stack) continue;
      for (const v of s.values) if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (series.some((s) => s.kind === 'area')) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (lo === hi) hi = lo + 1;
    const pad = (hi - lo) * 0.06;
    const y = scaleLinear()
      .domain([lo < 0 ? lo - pad : lo === 0 ? 0 : lo - pad, hi + pad])
      .nice(5)
      .range([innerH, 0]);
    const x = scaleUtc()
      .domain([new Date(times[0]!), new Date(times[times.length - 1]!)])
      .range([0, innerW]);
    const xi = (i: number) => x(new Date(times[i]!));
    return { layers, stacked, x, y, xi };
  }, [dates, series, innerW, innerH, times]);

  if (!model) return <div ref={wrapRef} style={{ height }} />;
  const { layers, stacked, x, y, xi } = model;
  const spanDays = (times[times.length - 1]! - times[0]!) / 86_400_000;
  const xTicks = x.ticks(Math.max(2, Math.floor(innerW / 90)));
  const yTicks = y.ticks(5);

  const areaGen = d3area<[number, number]>()
    .x((_, i) => xi(i))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
    .curve(curveMonotoneX);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = x.invert(px).getTime();
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i]! - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? dates.length) - 1));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(dates.length - 1, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  // End labels only when they don't collide (never nudged away from their lines).
  const ends = endLabels
    ? series
        .filter((s) => s.kind === 'line' && !s.quiet)
        .map((s) => {
          let idx = s.values.length - 1;
          while (idx >= 0 && s.values[idx] === null) idx--;
          return idx >= 0 ? { s, idx, v: s.values[idx]!, py: y(s.values[idx]!) } : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => a.py - b.py)
    : [];
  const endsOk = ends.every((e, i) => i === 0 || e.py - ends[i - 1]!.py >= 26);

  const hoverRows =
    hover === null
      ? []
      : series
          .filter((s) => !s.quiet && s.values[hover] !== null && s.values[hover] !== undefined)
          .map((s) => ({ s, v: s.values[hover]! }));

  return (
    <div ref={wrapRef} className="relative select-none">
      <svg
        width={width}
        height={height}
        className="chart-svg block overflow-visible focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          {yTicks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={0} x2={innerW} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={-8} dy="0.32em" textAnchor="end" className="sensitive tabular">
                {axisFormat(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.getTime()} x={x(t)} y={innerH + 18} textAnchor="middle" className="tabular">
              {tickLabel(t, spanDays)}
            </text>
          ))}
          {splitIndex !== undefined && splitIndex > 0 && splitIndex < dates.length && (
            <g transform={`translate(${xi(splitIndex)},0)`}>
              <line y1={0} y2={innerH} stroke="var(--axis)" strokeWidth={1} />
              <text x={4} y={10} style={{ fill: 'var(--ink-3)' }}>
                Today
              </text>
            </g>
          )}
          {layers.map((layer, li) => {
            const s = stacked[li]!;
            const d = areaGen(layer.map((p) => [p[0], p[1]] as [number, number]));
            const edge = d3line<[number, number]>()
              .x((_, i) => xi(i))
              .y((p) => y(p[1] >= 0 && p[0] >= 0 ? p[1] : p[0]))
              .curve(curveMonotoneX)(layer.map((p) => [p[0], p[1]] as [number, number]));
            return (
              <g key={s.id}>
                <path d={d ?? undefined} fill={s.color} fillOpacity={0.2} />
                <path d={edge ?? undefined} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              </g>
            );
          })}
          {series
            .filter((s) => !(s.kind === 'area' && s.stack))
            .map((s) => {
              const pts = s.values.map((v, i) => [i, v] as const);
              const lineD = d3line<readonly [number, number | null]>()
                .defined((p) => p[1] !== null)
                .x((p) => xi(p[0]))
                .y((p) => y(p[1]!))
                .curve(curveMonotoneX)(pts);
              const areaD =
                s.kind === 'area'
                  ? d3area<readonly [number, number | null]>()
                      .defined((p) => p[1] !== null)
                      .x((p) => xi(p[0]))
                      .y0(y(0))
                      .y1((p) => y(p[1]!))
                      .curve(curveMonotoneX)(pts)
                  : null;
              return (
                <g key={s.id}>
                  {areaD && <path d={areaD} fill={s.color} fillOpacity={0.1} />}
                  <path d={lineD ?? undefined} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '6 4' : undefined} />
                  {s.markers &&
                    pts.map(([i, v]) =>
                      v === null ? null : <circle key={i} cx={xi(i)} cy={y(v)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />,
                    )}
                </g>
              );
            })}
          {endsOk &&
            ends.map((e) => (
              <g key={e.s.id} transform={`translate(${xi(e.idx) + 8},${e.py})`}>
                <text dy="-0.2em" style={{ fill: 'var(--ink-2)', fontSize: 11.5 }}>
                  {e.s.label.length > 16 ? `${e.s.label.slice(0, 15)}…` : e.s.label}
                </text>
                <text dy="1.05em" className="sensitive tabular" style={{ fill: 'var(--ink)', fontWeight: 600, fontSize: 12 }}>
                  {compact(e.v)}
                </text>
              </g>
            ))}
          {hover !== null && (
            <g>
              <line x1={xi(hover)} x2={xi(hover)} y1={0} y2={innerH} stroke="var(--ink-3)" strokeWidth={1} />
              {series.map((s, si) => {
                let v: number | null = s.values[hover] ?? null;
                if (s.kind === 'area' && s.stack) {
                  const layer = layers[stacked.indexOf(s)];
                  const p = layer?.[hover];
                  if (!p || p[0] === p[1]) return null;
                  v = p[1] > 0 ? p[1] : p[0];
                }
                if (v === null) return null;
                return <circle key={si} cx={xi(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />;
              })}
            </g>
          )}
          <rect width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }} />
        </g>
      </svg>
      {hover !== null && hoverRows.length > 0 && (
        <ChartTooltip x={margin.left + xi(hover)} y={margin.top} width={width}>
          <div className="mb-1 font-medium text-ink">{formatDate(dates[hover]!)}</div>
          {hoverRows.map(({ s, v }) => (
            <TooltipRow key={s.id} color={s.color} kind={s.dashed ? 'dash' : 'line'} label={s.label} value={format(v)} />
          ))}
        </ChartTooltip>
      )}
    </div>
  );
}
