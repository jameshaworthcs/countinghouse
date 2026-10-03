import { twMerge } from 'tailwind-merge';
import { formatDate, formatMonth, relativeDays, today } from '../../shared/dates';
import type { TaxBandEstimate } from '../../shared/api';
import type { Rule } from '../../shared/schema';
import { formatMoney, formatPercent } from '../../shared/money';

export { formatDate, formatMonth, formatMoney, formatPercent, relativeDays, today };

export const money = (v: number | null | undefined, opts: Parameters<typeof formatMoney>[1] = {}) => (v === null || v === undefined ? '—' : formatMoney(v, opts));

/** A rule's match in words: "the description holds “Tesco”, money out, £5 to £50". */
export function matchWords(m: Rule['match']): string {
  const field = m.field === 'payee' ? 'the payee' : 'the description';
  const how = { contains: 'holds', equals: 'is', startsWith: 'starts with', endsWith: 'ends with', regex: 'matches the pattern' }[m.op];
  const dir = m.direction === 'in' ? ', money in' : m.direction === 'out' ? ', money out' : '';
  const size =
    m.amountMin !== undefined && m.amountMax !== undefined
      ? `, ${money(m.amountMin, { decimals: m.amountMin % 1 ? 2 : 0 })} to ${money(m.amountMax, { decimals: m.amountMax % 1 ? 2 : 0 })}`
      : m.amountMin !== undefined
        ? `, ${money(m.amountMin, { decimals: m.amountMin % 1 ? 2 : 0 })} or more`
        : m.amountMax !== undefined
          ? `, up to ${money(m.amountMax, { decimals: m.amountMax % 1 ? 2 : 0 })}`
          : '';
  return `${field} ${how} “${m.value}”${dir}${size}`;
}

/** £12.3k style, for axes and tiles. */
export const compact = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatMoney(v, { compact: true }));

export const pct = (v: number | null | undefined, decimals = 1, sign = false) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : formatPercent(v, decimals, sign));

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : pluralWord}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return '—';
  return relativeDays(iso.slice(0, 10), today());
}

/** Join class names; later Tailwind utilities override earlier conflicting ones (h-8 beats h-9). */
export const cn = (...parts: (string | false | null | undefined)[]) => twMerge(parts.filter(Boolean).join(' '));

/** A computed tax band in words, with how sure it is. */
export function bandLabel(t: Pick<TaxBandEstimate, 'band' | 'basis'>): string {
  if (t.band === 'none') return t.basis === 'minimum' ? 'no income tax found yet' : t.basis === 'estimate' ? 'no income tax, estimated' : 'no income tax';
  const band = `${t.band} rate`;
  return t.basis === 'documents' ? band : t.basis === 'estimate' ? `${band}, estimated` : `at least ${band}`;
}
