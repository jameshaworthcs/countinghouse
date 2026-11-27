// What a company's books work out at each accounting period's end (docs/FORMULAS.md §22, "At a
// period's end"): a fixed asset's depreciation, straight line by whole months, and the parts of a cost
// or income that covers days in other periods. Pure: integer pence, ISO dates compared as strings and
// counted with shared/dates.ts, never Date maths on an ISO date.

import { diffDays, type ISODate } from './dates';
import { apportion, mulDivRound } from './money';

/** A day's month as a count of months (year × 12 + month − 1), from the string alone. */
const monthNumber = (d: ISODate): number => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Months counted from `from` to `to`, the month of each counted in full: 1 for two days of one month,
 * 2 from 31 January to 1 February, 0 when `to` is before `from`. A fixed asset's month of acquisition
 * counts in full, and so does the month a period ends in.
 */
export function monthsCounted(from: ISODate, to: ISODate): number {
  if (to < from) return 0;
  return monthNumber(to) - monthNumber(from) + 1;
}

/** How months are counted: a full month in the month an asset is bought and none in the month it leaves (`acquisition`), or a full month in both (`both`). */
export type MonthConvention = 'acquisition' | 'both';

/**
 * What depreciation needs of an asset (pence, positive): its cost; the day it counts from; its life in
 * months over time (`lives`: the first from `from`, each later one a change in estimate from its day;
 * `months` undefined: no life then, so nothing is written down); what it is expected to fetch at the
 * end (`residual`); credits that reduced its cost (`reductions`); the day it left; and how months count.
 */
export interface DepreciableAsset {
  cost: number;
  from: ISODate;
  lives: readonly { from: ISODate; months?: number | undefined }[];
  residual?: number | undefined;
  reductions?: readonly { date: ISODate; amount: number }[];
  disposedOn?: ISODate | undefined;
  convention?: MonthConvention | undefined;
}

/** An asset's cost on a day: its cost less the reductions dated by then. */
export function costOn(asset: Pick<DepreciableAsset, 'cost' | 'reductions'>, date: ISODate): number {
  return asset.cost - (asset.reductions ?? []).filter((r) => r.date <= date).reduce((s, r) => s + r.amount, 0);
}

/** Months counted to a day: from the month it counts from, to that day's month, or to the month it left (that month left out under the `acquisition` convention). */
export function monthsTo(asset: Pick<DepreciableAsset, 'from' | 'disposedOn' | 'convention'>, date: ISODate): number {
  const left = asset.disposedOn !== undefined && asset.disposedOn <= date;
  const until = left ? asset.disposedOn! : date;
  const m = monthsCounted(asset.from, until) - (left && (asset.convention ?? 'acquisition') === 'acquisition' ? 1 : 0);
  return Math.max(0, m);
}

/**
 * An asset's depreciation to a day (pence), straight line by whole months with cumulative rounding
 * (docs/FORMULAS.md §22, "Depreciation"). With no change, round((cost − residual) × m ÷ life), m the
 * months counted (`monthsTo`), at most its life. A change in estimate (a new life from a day, FRS 105
 * paras 12.18 and 8.12) or a reduction of its cost from a day starts a new stretch at the months before
 * that day's month, s: the net book value then less the residual, B, is spread over what is left of the
 * life, n = life − s, as D(s) + round(B × min(m − s, n) ÷ n); with nothing left of it (n ≤ 0), B is
 * written off in the month of the change. Never less than nothing to write down, never past it.
 */
export function depreciationTo(asset: DepreciableAsset, date: ISODate): number {
  const mEnd = monthsTo(asset, date);
  const residual = asset.residual ?? 0;
  const last = asset.disposedOn && asset.disposedOn < date ? asset.disposedOn : date;
  const events = [
    ...asset.lives.slice(1).map((l) => ({ date: l.from, months: l.months, life: true as const, amount: 0 })),
    ...(asset.reductions ?? []).map((r) => ({ date: r.date, months: undefined, life: false as const, amount: r.amount })),
  ]
    .filter((e) => e.date <= last)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let life = asset.lives[0]?.months;
  let cost = asset.cost;
  let s = 0;
  let base = 0;
  const remaining = () => Math.max(0, cost - residual - base);
  const value = (m: number): number => {
    if (!life || m <= s) return base;
    const n = life - s;
    if (n <= 0) return base + remaining();
    return base + mulDivRound(remaining(), Math.min(m - s, n), n);
  };
  for (const e of events) {
    const at = Math.min(Math.max(0, monthsCounted(asset.from, e.date) - 1), mEnd);
    base = value(at);
    s = at;
    if (e.life) life = e.months;
    else cost -= e.amount;
  }
  return value(mEnd);
}

/** A period: its first and last days. */
export interface Span {
  start: ISODate;
  end: ISODate;
}

/** Days of `a` and `b` in common, inclusive (0 when they do not meet). */
export function overlapDays(a: Span, b: Span): number {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return end < start ? 0 : diffDays(start, end) + 1;
}

/**
 * The parts of an amount (pence) that fall in each period, by the days it covers in each (`apportion`):
 * every day of `covers` counts, inclusive; days before `first` (the books' first day) count on it.
 * Periods follow on with no gaps and reach past the cover's last day; a period it does not cover has 0.
 */
export function coverParts(minor: number, covers: { from: ISODate; to: ISODate }, periods: readonly Span[], first: ISODate): number[] {
  const from = covers.from < first ? first : covers.from;
  const to = covers.to < first ? first : covers.to;
  const weights = periods.map((p) => overlapDays(p, { start: from, end: to }));
  return weights.some((w) => w > 0) ? apportion(minor, weights) : periods.map(() => 0);
}

/**
 * What to carry to the balance sheet at the end of period k for a posting of `minor` pence on day
 * `posted` whose parts by period are `parts` (pence, adding up to it): what the period should have
 * recognised by its end less what has been posted by then. Positive: more is due to profit and loss
 * than was posted (an accrual for a cost, a deferral of income); negative: more was posted than is due
 * yet (a prepayment, accrued income turned round). Every period's profit and loss then holds its part.
 */
export function carriedAt(k: number, parts: readonly number[], minor: number, posted: ISODate, periods: readonly Span[]): number {
  const due = parts.slice(0, k + 1).reduce((s, x) => s + x, 0);
  const postedBy = posted <= periods[k]!.end ? minor : 0;
  return due - postedBy;
}
