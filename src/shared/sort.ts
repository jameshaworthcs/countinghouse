// Column sorting, shared by the API (transactions) and the web tables.
//
// Numbers compare numerically; text compares the way people read it (case-insensitive, "2" before
// "10"). Blank values always sort last, whichever way the sort runs. Sorts are stable, so rows that
// compare equal keep the order they came in.

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });

function blank(v: SortValue): v is null | undefined | '' {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
}

/** Compare two values in the given direction; blanks go last either way. */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir = 'asc'): number {
  const ab = blank(a);
  const bb = blank(b);
  if (ab || bb) return ab === bb ? 0 : ab ? 1 : -1;
  const sign = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return sign * (a - b);
  return sign * collator.compare(String(a), String(b));
}

/** A sorted copy of `rows` by `key`. */
export function sortRows<T>(rows: readonly T[], key: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row) => ({ row, v: key(row) }))
    .sort((x, y) => compareValues(x.v, y.v, dir))
    .map((x) => x.row);
}

/** A formatted figure read back as a number, for tables that hold only text: "−£1,234", "12.5%", "£1.2k". */
export function parseFigure(text: string): number | null {
  const m = /^([+\-−–]?)\s*£?\s*([+\-−–]?)£?([\d,]*\.?\d+)\s*(k|m|bn)?\s*%?$/i.exec(text.trim());
  if (!m) return null;
  const scale = { k: 1e3, m: 1e6, bn: 1e9 }[(m[4] ?? '').toLowerCase()] ?? 1;
  const sign = /[-−–]/.test(`${m[1]}${m[2]}`) ? -1 : 1;
  return sign * Number(m[3]!.replace(/,/g, '')) * scale;
}

/** "amount_asc" → { key: 'amount', dir: 'asc' }; null for anything else. */
export function parseSortParam(s: string | null | undefined): { key: string; dir: SortDir } | null {
  const m = /^([a-z]+)_(asc|desc)$/.exec(s ?? '');
  return m ? { key: m[1]!, dir: m[2] as SortDir } : null;
}

export function formatSortParam(key: string, dir: SortDir): string {
  return `${key}_${dir}`;
}
