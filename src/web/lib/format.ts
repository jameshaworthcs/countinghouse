import { twMerge } from 'tailwind-merge';
import { formatDate, formatMonth, relativeDays, today } from '../../shared/dates';
import { formatMoney, formatPercent } from '../../shared/money';

export { formatDate, formatMonth, formatMoney, formatPercent, relativeDays, today };

export const money = (v: number | null | undefined, opts: Parameters<typeof formatMoney>[1] = {}) => (v === null || v === undefined ? '—' : formatMoney(v, opts));

/** £12.3k style, for axes and tiles. */
export const compact = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatMoney(v, { compact: true }));

export const pct = (v: number | null | undefined, decimals = 1, sign = false) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : formatPercent(v, decimals, sign));

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : pluralWord}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return '—';
  return relativeDays(iso.slice(0, 10), today());
}

/** Join class names; later Tailwind utilities override earlier conflicting ones (h-8 beats h-9). */
export const cn = (...parts: (string | false | null | undefined)[]) => twMerge(parts.filter(Boolean).join(' '));
