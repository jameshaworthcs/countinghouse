// Columns (grouped or diverging), horizontal bar lists, heatmap, sparkline, meter, allocation bar.

import { scaleBand, scaleLinear } from 'd3-scale';
import { line as d3line } from 'd3-shape';
import { TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn, compact, money, pct } from '../../lib/format';
import { ChartTooltip, SEQ, TooltipRow, useWidth } from './common';

// ─── Columns ─────────────────────────────────────────────────────────────────────────────────────

export interface ColumnSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

/** Path for a bar with 4px rounded data-end and a square baseline. */
function barPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, h, w / 2);
  if (h < 0.5) return '';
  if (up) {
    return `M${x},${y0} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + w - rr} Q${x + w},${y1} ${x + w},${y1 + rr} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - rr} Q${x},${y1} ${x + rr},${y1} H${x + w - rr} Q${x + w},${y1} ${x + w},${y1 - rr} V${y0} Z`;
}

export function ColumnChart({
  labels,
  series,
  mode = 'grouped',
  marker,
  height = 240,
  ariaLabel,
  format = (v) => money(v),
  onSelect,
}: {
  labels: string[];
  series: ColumnSeries[];
  /** grouped: side by side; diverging: first series up, second series down (shown as negative). */
  mode?: 'grouped' | 'diverging';
  /** A dot per column; null leaves the column without one. */
  marker?: { label: string; color: string; values: (number | null)[] };
  height?: number;
  ariaLabel: string;
  format?: (v: number) => string;
  onSelect?: (index: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 10, right: 8, bottom: 26, left: 58 };
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;
  if (innerW <= 0) return <div ref={ref} style={{ height }} />;

  const band = scaleBand<number>()
    .domain(labels.map((_, i) => i))
    .range([0, innerW])
    .paddingInner(0.3)
    .paddingOuter(0.15);
  let lo = 0;
  let hi = 0;
  labels.forEach((_, i) => {
    if (mode === 'diverging') {
      hi = Math.max(hi, series[0]?.values[i] ?? 0);
      lo = Math.min(lo, -(series[1]?.values[i] ?? 0));
    } else for (const s of series) {
      hi = Math.max(hi, s.values[i] ?? 0);
      lo = Math.min(lo, s.values[i] ?? 0);
    }
    if (marker) {
      hi = Math.max(hi, marker.values[i] ?? 0);
      lo = Math.min(lo, marker.values[i] ?? 0);
    }
  });
  if (hi === lo) hi = lo + 1;
  const y = scaleLinear().domain([lo, hi]).nice(5).range([innerH, 0]);
  const yTicks = y.ticks(5);
  const groupW = band.bandwidth();
  const n = mode === 'diverging' ? 1 : series.length;
  const gap = 2;
  const barW = Math.min(24, (groupW - gap * (n - 1)) / n);
  const totalW = barW * n + gap * (n - 1);
  const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 44))));

  return (
    <div ref={ref} className="relative select-none">
      <svg width={width} height={height} className="chart-svg block" role="img" aria-label={ariaLabel}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          {yTicks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={0} x2={innerW} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} shapeRendering="crispEdges" />
              <text x={-8} dy="0.32em" textAnchor="end" className="sensitive tabular">
                {compact(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const x0 = (band(i) ?? 0) + (groupW - totalW) / 2;
            const active = hover === i;
            return (
              <g key={i} opacity={hover === null || active ? 1 : 0.55}>
                {mode === 'diverging' ? (
                  <>
                    <path d={barPath(x0, barW, y(0), y(series[0]?.values[i] ?? 0))} fill={series[0]?.color} />
                    <path d={barPath(x0, barW, y(0), y(-(series[1]?.values[i] ?? 0)))} fill={series[1]?.color} />
                  </>
                ) : (
                  series.map((s, si) => <path key={s.id} d={barPath(x0 + si * (barW + gap), barW, y(0), y(s.values[i] ?? 0))} fill={s.color} />)
                )}
                {marker && marker.values[i] !== null && marker.values[i] !== undefined && <circle cx={x0 + totalW / 2} cy={y(marker.values[i])} r={4.5} fill={marker.color} stroke="var(--panel)" strokeWidth={2} />}
                {i % labelEvery === 0 && (
                  <text x={(band(i) ?? 0) + groupW / 2} y={innerH + 18} textAnchor="middle">
                    {l}
                  </text>
                )}
                <rect
                  x={band(i)}
                  y={0}
                  width={groupW}
                  height={innerH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onClick={onSelect ? () => onSelect(i) : undefined}
                  style={{ cursor: onSelect ? 'pointer' : undefined }}
                  tabIndex={0}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${l}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(', ')}`}
                />
              </g>
            );
          })}
        </g>
      </svg>
      {hover !== null && (
        <ChartTooltip x={margin.left + (band(hover) ?? 0) + groupW / 2} y={margin.top} width={width}>
          <div className="mb-1 font-medium text-ink">{labels[hover]}</div>
          {series.map((s) => (
            <TooltipRow key={s.id} color={s.color} kind="bar" label={s.label} value={format(s.values[hover] ?? 0)} />
          ))}
          {marker && marker.values[hover] !== null && marker.values[hover] !== undefined && <TooltipRow color={marker.color} kind="dot" label={marker.label} value={format(marker.values[hover])} />}
        </ChartTooltip>
      )}
    </div>
  );
}

// ─── Horizontal bar list ─────────────────────────────────────────────────────────────────────────

export interface BarRow {
  id: string;
  label: ReactNode;
  value: number;
  sub?: ReactNode;
  note?: ReactNode;
}

/** One series, one hue: nominal categories never get a value ramp. */
export function BarList({ rows, color = 'var(--s1)', format = (v: number) => money(v, { decimals: 0 }), onSelect, max }: { rows: BarRow[]; color?: string; format?: (v: number) => string; onSelect?: (id: string) => void; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" className={cn('group w-full text-left', onSelect ? 'cursor-pointer' : 'cursor-default')} onClick={onSelect ? () => onSelect(r.id) : undefined} disabled={!onSelect}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-ink group-hover:underline">{r.label}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                {r.note}
                <span className="sensitive tabular font-medium text-ink">{format(r.value)}</span>
              </span>
            </div>
            <div className="h-2 rounded-r bg-transparent">
              {r.value !== 0 && <div className="h-2 rounded-r-[4px]" style={{ width: `${Math.max(0.5, (Math.abs(r.value) / top) * 100)}%`, background: color }} />}
            </div>
            {r.sub && <div className="mt-0.5 text-[12px] text-ink-3">{r.sub}</div>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────────────────────────

export function Heatmap({ columns, rows, format = (v: number) => compact(v), onSelect }: { columns: string[]; rows: { id: string; name: string; values: number[] }[]; format?: (v: number) => string; onSelect?: (rowId: string, col: number) => void }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const step = (v: number) => (v <= 0 ? -1 : Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length)));
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full border-separate border-spacing-[2px] text-[11.5px]">
        <thead>
          <tr>
            <th className="sticky left-0 bg-panel" />
            {columns.map((c) => (
              <th key={c} className="px-1 pb-1 text-center font-normal whitespace-nowrap text-ink-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="sticky left-0 max-w-[150px] truncate bg-panel pr-2 text-left font-normal whitespace-nowrap text-ink-2">
                {r.name}
              </th>
              {r.values.map((v, i) => {
                const s = step(v);
                const dark = s >= 4;
                return (
                  <td
                    key={i}
                    title={`${r.name}, ${columns[i]}: ${money(v)}`}
                    onClick={onSelect ? () => onSelect(r.id, i) : undefined}
                    className={cn('sensitive tabular h-7 min-w-[52px] rounded-[3px] px-1 text-center', onSelect && v > 0 ? 'cursor-pointer hover:outline hover:outline-1 hover:outline-[var(--ink-3)]' : '')}
                    style={{ background: s < 0 ? 'var(--panel-2)' : SEQ[s], color: s < 0 ? 'var(--ink-3)' : dark ? 'white' : 'var(--ink)' }}
                  >
                    {v > 0 ? format(v) : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Sparkline ───────────────────────────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 96, height = 28, color = 'var(--deemph)', accent = 'var(--s1)' }: { values: (number | null)[]; width?: number; height?: number; color?: string; accent?: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden />;
  const ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const x = scaleLinear().domain([0, values.length - 1]).range([3, width - 5]);
  const y = scaleLinear()
    .domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi])
    .range([height - 4, 4]);
  const d = d3line<readonly [number, number]>()
    .x((p) => x(p[0]))
    .y((p) => y(p[1]))(pts);
  const last = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={d ?? undefined} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={2.75} fill={accent} stroke="var(--panel)" strokeWidth={1.5} />
    </svg>
  );
}

// ─── Meter ───────────────────────────────────────────────────────────────────────────────────────

/** A single ratio against a limit. The track is a lighter step of the same ramp. */
/** Use of an allowance. `atLeast`: the data does not cover the whole period, so `used` is a minimum. */
export function Meter({ used, limit, label, sub, overLabel = 'Over the limit', atLeast = false }: { used: number; limit: number; label: ReactNode; sub?: ReactNode; overLabel?: string; atLeast?: boolean }) {
  const ratio = limit > 0 ? used / limit : 0;
  const over = used > limit;
  const near = !over && ratio >= 0.9;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="text-[12.5px] text-ink-3">
          {atLeast && 'at least '}
          <span className="sensitive tabular font-semibold text-ink">{money(used, { decimals: 0 })}</span> of <span className="sensitive tabular">{money(limit, { decimals: 0 })}</span>
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--seq-1)' }} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={typeof label === 'string' ? label : undefined}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: over ? 'var(--bad)' : near ? 'var(--serious)' : 'var(--seq-5)' }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[12px] text-ink-3">
        <span>{sub}</span>
        {over ? (
          <span className="inline-flex items-center gap-1 font-medium text-bad-ink">
            <TriangleAlert className="size-3.5" /> {overLabel} by <span className="sensitive">{money(used - limit, { decimals: 0 })}</span>
          </span>
        ) : (
          <span>
            {atLeast && 'up to '}
            <span className="sensitive tabular">{money(Math.max(0, limit - used), { decimals: 0 })}</span> left{atLeast ? '' : ` · ${pct(ratio, 0)}`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A budget against the month's spending. The tick marks how much of a usual month's spending is
 * done by the day the data reaches; status colours only for status (over, on pace to go over, nearly
 * spent).
 */
export function BudgetMeter({ spent, budget, expected, status, label, sub }: { spent: number; budget: number; expected: number | null; status: 'over' | 'pace' | 'near' | 'ok'; label: ReactNode; sub?: ReactNode }) {
  const ratio = budget > 0 ? spent / budget : 0;
  const fill = status === 'over' ? 'var(--bad)' : status === 'pace' || status === 'near' ? 'var(--serious)' : 'var(--seq-5)';
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-medium text-ink">{label}</span>
        <span className="shrink-0 text-[12.5px] text-ink-3">
          <span className="sensitive tabular font-semibold text-ink">{money(spent, { decimals: 0 })}</span> of <span className="sensitive tabular">{money(budget, { decimals: 0 })}</span>
        </span>
      </div>
      <div className="relative h-2.5 rounded-full" style={{ background: 'var(--seq-1)' }} role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent} aria-label={typeof label === 'string' ? label : undefined}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: fill }} />
        {expected !== null && expected > 0 && expected < 1 && <div className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-ink-2" style={{ left: `calc(${expected * 100}% - 1px)` }} title="Usual by now" aria-hidden />}
      </div>
      {sub && <div className="mt-1 text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}

// ─── Part-to-whole bar ───────────────────────────────────────────────────────────────────────────

export function AllocationBar({ parts }: { parts: { id: string; label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.value / total, 0)}`).join(', ')}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div key={p.id} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${money(p.value)} (${pct(p.value / total)})`} />
          ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <li key={p.id} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-[3px]" style={{ background: p.color }} />
              {p.label} <span className="text-ink-3">{pct(p.value / total, 0)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
