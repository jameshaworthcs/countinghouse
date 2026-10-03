// Coverage: which days each account has data for. Averages, rates and projections divide by
// covered time, never by calendar time, so one imported month is never mistaken for a quiet
// quarter; and a figure for a period (a tax year's interest) is known only when every day it needs
// is covered. Formulas: docs/FORMULAS.md §3.
//
// Sources, for every account (`coveredIntervals`):
//   - each committed import covers its statement period for the account (periodStart–periodEnd),
//     or the span of the rows it contained; a statement that does not print its start, and opens
//     on the closing balance of the statement before it, runs on from that one (importIntervals);
//   - a transaction entered by hand covers its own day;
//   - a stretch you confirmed nothing is missing from covers its days (coverage.json);
//   - accounts with transactions but no import records (the demo, early data) are covered from
//     their first to their last transaction.

import { balanceModeOf } from '../../shared/accounts';
import type { CoverageResponse } from '../../shared/api';
import { addDays, diffDays, eachMonth, endOfMonth, maxDate, minDate, startOfMonth, today, type ISODate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { Account, BalanceEvidence } from '../../shared/schema';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';

/**
 * How far into a period an account with no opening date may start having data and still count as
 * having opened then: statements and exports seldom begin on a period's first day. Starting later,
 * it may have been open before, so the period's days before its data are missing until you set its
 * opening date (docs/FORMULAS.md §3, "Missing days").
 */
export const COVERAGE_SLACK_DAYS = 45;

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

/**
 * The days an account's own records cover, whatever kind of account it is (docs/FORMULAS.md §3):
 * its imports' statement periods, the day of each row entered by hand, and the stretches you
 * confirmed nothing is missing from. An account with rows but no import records is covered from
 * its first row to its last.
 */
export function coveredIntervals(store: Store, account: Account): Interval[] {
  const txs = store.transactions(account.id);
  const confirmed = store.coverageConfirmations.filter((c) => c.accountId === account.id).map((c) => ({ from: c.from, to: c.to }));
  const fromImports = importIntervals(store, account.id);
  if (fromImports.length) {
    const manual = txs.filter((t) => !t.source.importId).map((t) => ({ from: t.date, to: t.date }));
    return mergeIntervals([...fromImports, ...manual, ...confirmed]);
  }
  if (txs.length) return mergeIntervals([{ from: txs[0]!.date, to: txs[txs.length - 1]!.date }, ...confirmed]);
  return mergeIntervals(confirmed);
}

/** A ledger account's coverage, for the coverage grid and the days every account covers (`Coverage`). */
export function accountCoverage(store: Store, account: Account): AccountCoverage {
  const empty: AccountCoverage = { accountId: account.id, intervals: [], from: null, to: null, source: 'none' };
  if (!isTransactionAccount(account)) return empty;
  const source: AccountCoverage['source'] = importIntervals(store, account.id).length ? 'imports' : store.transactions(account.id).length ? 'transactions' : 'none';
  if (source === 'none') return empty;
  const intervals = coveredIntervals(store, account);
  return { accountId: account.id, intervals, from: intervals[0]!.from, to: intervals[intervals.length - 1]!.to, source };
}

/** Days an account should have data for that its records do not cover (`missingDays`). */
export interface MissingStretch extends Interval {
  /** The account has no data at all: no rows, balances or statement periods. */
  noData: boolean;
  /**
   * It has no opening date and its data starts more than COVERAGE_SLACK_DAYS into the period, so it
   * may have been open before: this stretch runs from the period's start to its data. Setting its
   * opening date settles it.
   */
  openingUnknown: boolean;
}

/**
 * The days of [from, to] an account should have data for that its records do not cover
 * (docs/FORMULAS.md §3, "Missing days"): the one rule for whether a period's data is complete, used
 * by Data health, the Tax year page, Self Assessment and the capture list.
 *
 * It should have data from its opening date; without one, from its first covered day when that is
 * within COVERAGE_SLACK_DAYS of `from`, else from `from` (it may have been open before). It needs
 * none after it closed. `covered` defaults to its records (`coveredIntervals`).
 */
export function missingDays(store: Store, account: Account, from: ISODate, to: ISODate, covered: Interval[] = coveredIntervals(store, account)): MissingStretch[] {
  const first = covered[0]?.from;
  let start: ISODate;
  let unknownFrom: ISODate | undefined;
  if (account.openedOn) start = maxDate(from, account.openedOn)!;
  else if (first && diffDays(from, first) <= COVERAGE_SLACK_DAYS) start = maxDate(from, first)!;
  else {
    start = from;
    unknownFrom = from;
  }
  const end = minDate(to, account.closedOn)!;
  if (start > end) return [];
  const noData = !covered.length && !store.transactions(account.id).length && !store.balances(account.id).length;
  return complement(covered, start, end).map((g) => ({ ...g, noData, openingUnknown: g.from === unknownFrom }));
}

/** A stretch of days an account should have data for that nothing covers, with what its balances say. */
export interface CoverageGap {
  accountId: string;
  name: string;
  from: ISODate;
  to: ISODate;
  days: number;
  /** Rows recorded inside it (a document dated outside its period, or one you entered). */
  rows: number;
  evidence: BalanceEvidence;
  /** The account has no data at all. */
  noData?: boolean;
  /** It has no opening date and its data starts later: it may have opened then (`MissingStretch`). */
  openingUnknown?: boolean;
  /** A valued account (an ISA, a pension): its balances cannot show what was paid in or out. */
  valuations?: boolean;
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

  /**
   * Each stretch from `from` to `to` that an account should have data for and that nothing covers,
   * by the one rule (`missingDays`), with what its balances say (docs/FORMULAS.md §3). The accounts
   * are the transaction accounts in the estate, with data or an opening date, and `also`: accounts a
   * tax figure rests on (their interest, subscriptions or contributions), valued ones included.
   */
  gaps(engine: BalanceEngine, from: ISODate, to: ISODate = today(), also: readonly Account[] = []): CoverageGap[] {
    const out: CoverageGap[] = [];
    const listed = this.store.accounts.filter(
      (a) => also.some((x) => x.id === a.id) || (isTransactionAccount(a) && a.includeInNetWorth && (this.byAccount.get(a.id)!.source !== 'none' || a.openedOn !== undefined)),
    );
    for (const a of listed) {
      for (const g of missingDays(this.store, a, from, to)) {
        const rows = this.store.transactions(a.id).filter((t) => t.date >= g.from && t.date <= g.to).length;
        out.push({
          accountId: a.id,
          name: a.name,
          from: g.from,
          to: g.to,
          days: diffDays(g.from, g.to) + 1,
          rows,
          evidence: engine.evidence(a.id, g.from, g.to),
          ...(g.noData ? { noData: true } : {}),
          ...(g.openingUnknown ? { openingUnknown: true } : {}),
          ...(!isTransactionAccount(a) ? { valuations: true } : {}),
        });
      }
    }
    return out;
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
