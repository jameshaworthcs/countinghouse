// Coverage: which days each account has transaction data for. Averages, rates and projections
// divide by covered time, never by calendar time, so one imported month is never mistaken for a
// quiet quarter. Formulas: docs/FORMULAS.md §3.
//
// Sources, for ledger accounts:
//   - each committed import covers its statement period for the account (periodStart–periodEnd),
//     or the span of the rows it contained; a statement that does not print its start, and opens
//     on the closing balance of the statement before it, runs on from that one (importIntervals);
//   - a transaction entered by hand covers its own day;
//   - accounts with transactions but no import records (the demo, early data) are covered from
//     their first to their last transaction.

import { balanceModeOf } from '../../shared/accounts';
import type { CoverageResponse } from '../../shared/api';
import { addDays, diffDays, eachMonth, endOfMonth, maxDate, minDate, startOfMonth, today, type ISODate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import type { Store } from '../store';

export interface Interval {
  from: ISODate;
  to: ISODate;
}

export interface AccountCoverage {
  accountId: string;
  intervals: Interval[];
  from: ISODate | null;
  to: ISODate | null;
  source: 'imports' | 'transactions' | 'none';
}

/** Sort and merge intervals that overlap or touch (a gap of 0 days). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.from <= i.to).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= addDays(last.to, 1)) {
      if (i.to > last.to) last.to = i.to;
    } else out.push({ ...i });
  }
  return out;
}

/**
 * Longest a statement that does not print its start can run on from the one before it: a monthly
 * cycle, with room for closing dates that drift. Two cycles apart, a statement is missing between.
 */
export const STATEMENT_CYCLE_DAYS = 40;

/**
 * The periods an account's committed imports cover. A statement that does not print its start
 * would begin at its first row, leaving the quiet days after the last statement uncovered. When it
 * opens on the closing balance of the statement just before it (the latest-ending one with a
 * closing balance), within one cycle, it runs from the day after that one's period: the two
 * balances chain, so nothing happened in between that neither shows. Formulas: docs/FORMULAS.md §3.
 */
export function importIntervals(store: Store, accountId: string): Interval[] {
  const sections = store.imports.flatMap((i) => i.sections.filter((s) => s.accountId === accountId));
  const closed = sections.filter((s) => s.closing !== undefined).sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return sections.map((s) => {
    if (s.fromStated || s.opening === undefined) return { from: s.from, to: s.to };
    const prev = closed.filter((p) => p.to < s.to).at(-1);
    if (!prev || toMinor(prev.closing!) !== toMinor(s.opening) || diffDays(prev.to, s.to) > STATEMENT_CYCLE_DAYS) return { from: s.from, to: s.to };
    return { from: minDate(s.from, addDays(prev.to, 1))!, to: s.to };
  });
}

export function covers(intervals: Interval[], date: ISODate): boolean {
  return intervals.some((i) => i.from <= date && date <= i.to);
}

/** Days in [from, to] covered by the (merged) intervals. */
export function coveredDays(intervals: Interval[], from: ISODate, to: ISODate): number {
  let days = 0;
  for (const i of intervals) {
    const a = maxDate(i.from, from)!;
    const b = minDate(i.to, to)!;
    if (a <= b) days += diffDays(a, b) + 1;
  }
  return days;
}

/** Intersection of two merged interval lists. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = maxDate(a[i]!.from, b[j]!.from)!;
    const to = minDate(a[i]!.to, b[j]!.to)!;
    if (from <= to) out.push({ from, to });
    if (a[i]!.to < b[j]!.to) i++;
    else j++;
  }
  return out;
}

/** [from, to] minus the intervals. */
export function complement(intervals: Interval[], from: ISODate, to: ISODate): Interval[] {
  const out: Interval[] = [];
  let cursor = from;
  for (const i of intervals) {
    if (i.to < cursor) continue;
    if (i.from > to) break;
    if (i.from > cursor) out.push({ from: cursor, to: minDate(addDays(i.from, -1), to)! });
    cursor = maxDate(cursor, addDays(i.to, 1))!;
    if (cursor > to) return out;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out;
}

export function isTransactionAccount(a: Account): boolean {
  return balanceModeOf(a) === 'ledger';
}

export function accountCoverage(store: Store, account: Account): AccountCoverage {
  const txs = store.transactions(account.id);
  const empty: AccountCoverage = { accountId: account.id, intervals: [], from: null, to: null, source: 'none' };
  if (!isTransactionAccount(account)) return empty;
  const fromImports = importIntervals(store, account.id);
  let intervals: Interval[];
  let source: AccountCoverage['source'];
  if (fromImports.length) {
    const manual = txs.filter((t) => !t.source.importId).map((t) => ({ from: t.date, to: t.date }));
    intervals = mergeIntervals([...fromImports, ...manual]);
    source = 'imports';
  } else if (txs.length) {
    intervals = [{ from: txs[0]!.date, to: txs[txs.length - 1]!.date }];
    source = 'transactions';
  } else return empty;
  return { accountId: account.id, intervals, from: intervals[0]!.from, to: intervals[intervals.length - 1]!.to, source };
}

export interface JointCoverage {
  from: ISODate;
  to: ISODate;
  /** Days in [from, to] on which every account open that day has data. */
  intervals: Interval[];
  days: number;
  totalDays: number;
  /** Accounts that leave days uncovered, with how many. */
  limiting: { accountId: string; name: string; missingDays: number }[];
  /** Calendar months fully in [from, to] with ≥ 90% of days jointly covered. */
  completeMonths: string[];
}

/**
 * Joint coverage of the transaction accounts in the estate. An account counts from the day it
 * opened (or its first data) until it closed; within that span a day without data for it is a gap.
 */
export class Coverage {
  readonly byAccount = new Map<string, AccountCoverage>();
  private readonly spans: { account: Account; from: ISODate; to: ISODate | null }[] = [];

  constructor(private readonly store: Store) {
    for (const a of store.accounts) {
      const c = accountCoverage(store, a);
      this.byAccount.set(a.id, c);
      if (!a.includeInNetWorth || c.source === 'none') continue;
      this.spans.push({ account: a, from: minDate(a.openedOn, c.from) ?? c.from!, to: a.closedOn ?? null });
    }
  }

  /** Accounts that should have data on `date`. */
  private accountsOn(date: ISODate) {
    return this.spans.filter((s) => s.from <= date && (s.to === null || date <= s.to));
  }

  joint(from: ISODate, to: ISODate): JointCoverage {
    const limiting = new Map<string, number>();
    const coveredDaysList: ISODate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const open = this.accountsOn(d);
      if (!open.length) continue;
      let all = true;
      for (const s of open) {
        if (!covers(this.byAccount.get(s.account.id)!.intervals, d)) {
          all = false;
          limiting.set(s.account.id, (limiting.get(s.account.id) ?? 0) + 1);
        }
      }
      if (all) coveredDaysList.push(d);
    }
    const intervals = mergeIntervals(coveredDaysList.map((d) => ({ from: d, to: d })));
    const completeMonths = eachMonth(from, to).filter((m) => {
      const mStart = `${m}-01`;
      const mEnd = endOfMonth(mStart);
      if (mStart < from || mEnd > to) return false;
      return coveredDays(intervals, mStart, mEnd) >= 0.9 * (diffDays(mStart, mEnd) + 1);
    });
    return {
      from,
      to,
      intervals,
      days: coveredDaysList.length,
      totalDays: diffDays(from, to) + 1,
      limiting: [...limiting.entries()]
        .map(([accountId, missingDays]) => ({ accountId, name: this.store.account(accountId)?.name ?? accountId, missingDays }))
        .sort((a, b) => b.missingDays - a.missingDays),
      completeMonths,
    };
  }

  /** Coverage per account and month over the last `months` months, for the data-health grid. */
  summary(months = 13, on: ISODate = today()): CoverageResponse {
    const from = startOfMonth(addDays(startOfMonth(on), -1 - 31 * (months - 2)));
    const monthKeys = eachMonth(from, on).slice(-months);
    const accounts = this.store.accounts
      .filter((a) => isTransactionAccount(a) && a.status === 'open' && a.includeInNetWorth)
      .map((a) => {
        const c = this.byAccount.get(a.id)!;
        return {
          accountId: a.id,
          name: a.name,
          source: c.source,
          from: c.from,
          to: c.to,
          months: monthKeys.map((m) => {
            const mStart = `${m}-01`;
            const mEnd = minDate(endOfMonth(mStart), on)!;
            const total = diffDays(mStart, mEnd) + 1;
            return { month: m, fraction: total > 0 ? coveredDays(c.intervals, mStart, mEnd) / total : 0 };
          }),
        };
      });
    const joint = this.joint(`${monthKeys[0]}-01`, on);
    return {
      months: monthKeys,
      accounts,
      completeMonths: joint.completeMonths,
      lastCompleteMonth: joint.completeMonths[joint.completeMonths.length - 1] ?? null,
      jointTo: joint.intervals[joint.intervals.length - 1]?.to ?? null,
    };
  }
}
