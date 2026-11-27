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

/** What depreciation needs of an asset: its cost (pence, positive), the day it counts from, its life in months, and the day it left. */
export interface DepreciableAsset {
  cost: number;
  from: ISODate;
  months?: number | undefined;
  disposedOn?: ISODate | undefined;
}

/**
 * An asset's depreciation to a day (pence), straight line by whole months with cumulative rounding:
 * round(cost × m ÷ life), m the months counted from the month it counts from to that day's month (to
 * the month it left, once it has), at most its life, so never more than its cost. No life: none.
 */
export function depreciationTo(asset: DepreciableAsset, date: ISODate): number {
  if (!asset.months || asset.cost <= 0) return 0;
  const until = asset.disposedOn && asset.disposedOn < date ? asset.disposedOn : date;
  const m = Math.min(monthsCounted(asset.from, until), asset.months);
  return m <= 0 ? 0 : mulDivRound(asset.cost, m, asset.months);
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
