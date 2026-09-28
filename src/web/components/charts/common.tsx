// Shared chart pieces: sizing, the frame (title, legend, table view), tooltip.

import { Table2, ChartLine } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '../../lib/format';

/** Categorical slots, fixed order (never cycled). */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)'];

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'area' | 'line' | 'dash' | 'bar' | 'dot';
}

export function LegendKey({ color, kind = 'bar' }: { color: string; kind?: LegendItem['kind'] }) {
  if (kind === 'line' || kind === 'dash') {
    return (
      <svg width="16" height="8" aria-hidden className="shrink-0">
        <line x1="1" y1="4" x2="15" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={kind === 'dash' ? '4 3' : undefined} />
      </svg>
    );
  }
  if (kind === 'dot') return <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: color, opacity: kind === 'area' ? 0.85 : 1 }} aria-hidden />;
}

export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2', className)}>
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          <LegendKey color={i.color} kind={i.kind ?? 'bar'} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export interface TableView {
  columns: string[];
  rows: (string | number | null)[][];
  /** Column indexes that are numbers (right-aligned, tabular). */
  numeric?: number[];
}

/**
 * Every chart sits in a frame with its legend and a table-view twin (the accessible equivalent,
 * and the way to read exact values).
 */
export function ChartFrame({
  title,
  subtitle,
  legend,
  actions,
  table,
  children,
  className,
  loading,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  actions?: ReactNode;
  table?: TableView;
  children: ReactNode;
  className?: string;
  loading?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className={cn('print-plain m-0 min-w-0 rounded-xl border border-line bg-panel px-5 pt-4 pb-4 shadow-card', className)}>
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {title && <div className="text-[15px] font-semibold text-ink">{title}</div>}
          {subtitle && <div className="mt-0.5 text-[13px] text-ink-3">{subtitle}</div>}
        </div>
        <div className="no-print flex items-center gap-2">
          {actions}
          {table && (
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              className="inline-flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-panel-2 hover:text-ink"
              aria-label={asTable ? 'Show chart' : 'Show as table'}
              title={asTable ? 'Show chart' : 'Show as table'}
            >
              {asTable ? <ChartLine className="size-4" /> : <Table2 className="size-4" />}
            </button>
          )}
        </div>
      </figcaption>
      {legend && !asTable && <Legend items={legend} className="mb-3" />}
      <div className={cn('transition-opacity', loading ? 'opacity-50' : '')}>{asTable && table ? <DataTable table={table} /> : children}</div>
    </figure>
  );
}

export function DataTable({ table }: { table: TableView }) {
  const numeric = new Set(table.numeric ?? table.columns.map((_, i) => i).slice(1));
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {table.columns.map((c, i) => (
              <th key={c} className={cn('border-b border-line px-2 py-1.5 font-medium text-ink-3', numeric.has(i) ? 'text-right' : 'text-left')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((v, i) => (
                <td key={i} className={cn('border-b border-line px-2 py-1 text-ink', numeric.has(i) ? 'sensitive tabular text-right' : '')}>
                  {v ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Floating tooltip positioned inside a relative container; flips to stay on screen. */
export function ChartTooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [x, children]);
  const left = x + 14 + w > width ? Math.max(0, x - 14 - w) : x + 14;
  return (
    <div ref={ref} className="pointer-events-none absolute z-10 min-w-[150px] rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] shadow-lg" style={{ left, top: Math.max(0, y) }} role="presentation">
      {children}
    </div>
  );
}

export function TooltipRow({ color, kind = 'line', label, value }: { color?: string; kind?: LegendItem['kind']; label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="inline-flex items-center gap-1.5 text-ink-3">
        {color && <LegendKey color={color} kind={kind === 'area' || kind === 'bar' ? 'line' : kind} />}
        {label}
      </span>
      <span className="sensitive tabular font-semibold text-ink">{value}</span>
    </div>
  );
}

export function niceMax(v: number): number {
  if (v <= 0) return 0;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}
