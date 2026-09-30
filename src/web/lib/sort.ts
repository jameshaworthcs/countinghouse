import { useState, type ReactNode } from 'react';
import { sortRows, type SortDir, type SortValue } from '../../shared/sort';

export interface SortColumn<T> {
  value: (row: T) => SortValue;
  /** Direction of the first click: text defaults to A→Z, numbers to largest first. */
  first?: SortDir;
}

/** What a `SortHeader` needs: the column's current direction (if sorted) and a click handler. */
export interface SortProps {
  dir: SortDir | undefined;
  onSort: () => void;
}

/**
 * Click-to-sort for a table. Each click on a column goes first direction → other direction →
 * the order the rows came in, so a table's own order (often by date) can always come back.
 */
export function useSort<T, K extends string>(rows: readonly T[], columns: Record<K, SortColumn<T>>, initial?: { key: K; dir: SortDir }) {
  const [state, setState] = useState<{ key: K; dir: SortDir } | null>(initial ?? null);
  // Tables are small, so sorting on every render is cheap and never goes stale.
  const col = state ? columns[state.key] : undefined;
  const sorted = state && col ? sortRows(rows, col.value, state.dir) : rows;
  const sortProps = (key: K): SortProps => ({
    dir: state?.key === key ? state.dir : undefined,
    onSort: () => setState((s) => nextSort(s, key, firstDir(rows, columns[key]))),
  });
  return { rows: sorted, sortProps };
}

/** `useSort` as a wrapper, for a table inside a page that returns early before it (hook order). */
export function Sorted<T, K extends string>({ rows, columns, initial, children }: { rows: readonly T[]; columns: Record<K, SortColumn<T>>; initial?: { key: K; dir: SortDir }; children: (s: { rows: readonly T[]; sortProps: (key: K) => SortProps }) => ReactNode }) {
  return children(useSort(rows, columns, initial));
}

function firstDir<T>(rows: readonly T[], col: SortColumn<T>): SortDir {
  if (col.first) return col.first;
  const sample = rows.map(col.value).find((v) => v !== null && v !== undefined && v !== '');
  return typeof sample === 'number' ? 'desc' : 'asc';
}

/** The next state after clicking `key`: first direction, then the other, then unsorted. */
export function nextSort<K extends string>(s: { key: K; dir: SortDir } | null, key: K, first: SortDir): { key: K; dir: SortDir } | null {
  if (s?.key !== key) return { key, dir: first };
  if (s.dir === first) return { key, dir: first === 'asc' ? 'desc' : 'asc' };
  return null;
}
