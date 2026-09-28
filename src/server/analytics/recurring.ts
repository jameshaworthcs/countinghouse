// Regular payments and subscriptions, found from the rhythm of your spending: same payee, similar
// amount, steady interval.

import type { RecurringItem } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, diffDays, today } from '../../shared/dates';
import { cleanPayee } from '../../shared/merchants';
import { fromMinor } from '../../shared/money';
import type { Store } from '../store';
import { flows, type FlowTx } from './cashflow';

const CADENCES: { id: RecurringItem['cadence']; min: number; max: number; perMonth: number }[] = [
  { id: 'weekly', min: 5, max: 9, perMonth: 52 / 12 },
  { id: 'fortnightly', min: 12, max: 16, perMonth: 26 / 12 },
  { id: 'monthly', min: 26, max: 35, perMonth: 1 },
  { id: 'quarterly', min: 84, max: 100, perMonth: 1 / 3 },
  { id: 'annual', min: 350, max: 380, perMonth: 1 / 12 },
];

/** Named thresholds (docs/FORMULAS.md §10). */
export const RECURRING_RULES = {
  /** How far back payments are looked for. */
  lookbackDays: 730,
  /** Fewest payments on distinct days. */
  minPayments: 3,
  /** An interval counts as on time within ±max(minSlackDays, slack × median interval). */
  slack: 0.35,
  minSlackDays: 3,
  /** Share of intervals that must be on time. */
  minOnTime: 0.6,
  /** Amounts are steady when their median spread is at most this share of the median amount (or the last three are equal). */
  maxSpread: 0.25,
  /** A price change needs the first and last amounts this far apart, and the last three equal. */
  priceChange: 0.03,
  /** Still active if the last payment is no older than this many median intervals. */
  activeWithin: 1.6,
  /** Payments moved from one account to another (a new card) join up when the runs overlap by at most this many days. */
  handoverOverlapDays: 7,
} as const;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const byDate = (a: FlowTx, b: FlowTx) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : 0);

/**
 * Groups payments by payee and account. A payee paid from several accounts one after another (a
 * subscription moved to a new card) is one group; paid from several accounts at the same time, it
 * stays one group per account.
 */
function groupPayments(list: FlowTx[]): [string, FlowTx[]][] {
  const byPayee = new Map<string, Map<string, FlowTx[]>>();
  for (const f of list) {
    const payee = (f.t.payee ?? cleanPayee(f.t.description)).trim().toLowerCase();
    const accounts = byPayee.get(payee) ?? byPayee.set(payee, new Map()).get(payee)!;
    (accounts.get(f.t.accountId) ?? accounts.set(f.t.accountId, []).get(f.t.accountId)!).push(f);
  }
  const out: [string, FlowTx[]][] = [];
  for (const [payee, accounts] of byPayee) {
    const runs = [...accounts].map(([accountId, l]) => ({ accountId, list: l.sort(byDate) }));
    runs.sort((a, b) => byDate(a.list[0]!, b.list[0]!));
    const sequential = runs.every((r, i) => i === 0 || diffDays(r.list[0]!.t.date, runs[i - 1]!.list.at(-1)!.t.date) <= RECURRING_RULES.handoverOverlapDays);
    if (runs.length > 1 && sequential) out.push([`${runs.map((r) => r.accountId).join('+')}|${payee}`, runs.flatMap((r) => r.list)]);
    else for (const r of runs) out.push([`${r.accountId}|${payee}`, r.list]);
  }
  return out;
}

export function detectRecurring(store: Store, on: string = today()): RecurringItem[] {
  const R = RECURRING_RULES;
  const cats = new CategoryIndex(store.categories);
  const from = addDays(on, -R.lookbackDays);
  const payments = flows(store, from, on).filter((f) => f.cls === 'spending' && f.minor > 0 && f.t.category !== 'cash-withdrawal');
  const out: RecurringItem[] = [];
  for (const [key, list] of groupPayments(payments)) {
    if (list.length < R.minPayments) continue;
    list.sort(byDate);
    // Several payments on one day (e.g. split bills) count once for cadence purposes.
    const dates = [...new Set(list.map((f) => f.t.date))];
    if (dates.length < R.minPayments) continue;
    const intervals = dates.slice(1).map((d, i) => diffDays(dates[i]!, d));
    const m = median(intervals);
    const cadence = CADENCES.find((c) => m >= c.min && m <= c.max);
    if (!cadence) continue;
    const onTime = intervals.filter((iv) => Math.abs(iv - m) <= Math.max(R.minSlackDays, m * R.slack)).length / intervals.length;
    if (onTime < R.minOnTime) continue;
    const amounts = list.map((f) => f.minor);
    const recent = amounts.slice(-3);
    const typical = median(recent);
    const spread = median(amounts.map((a) => Math.abs(a - median(amounts)))) / Math.max(1, median(amounts));
    if (spread > R.maxSpread && new Set(recent).size > 1) continue;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const nextDate = addDays(last.t.date, Math.round(m));
    const active = diffDays(last.t.date, on) <= m * R.activeWithin;
    const firstAmount = amounts[0]!;
    const lastAmount = amounts[amounts.length - 1]!;
    let priceChange: RecurringItem['priceChange'];
    if (cadence.id !== 'weekly' && Math.abs(lastAmount - firstAmount) / Math.max(1, firstAmount) > R.priceChange && new Set(recent).size === 1) {
      const changedAt = [...list].reverse().find((f) => f.minor !== lastAmount);
      priceChange = { from: fromMinor(firstAmount), to: fromMinor(lastAmount), date: changedAt ? addDays(changedAt.t.date, 1) : last.t.date };
    }
    const payee = last.t.payee ?? cleanPayee(last.t.description);
    out.push({
      key,
      payee,
      categoryName: cats.name(last.t.category),
      cadence: cadence.id,
      typicalAmount: fromMinor(typical),
      monthlyCost: fromMinor(Math.round(typical * cadence.perMonth)),
      annualCost: fromMinor(Math.round(typical * cadence.perMonth * 12)),
      count: list.length,
      firstDate: first.t.date,
      lastDate: last.t.date,
      nextDate,
      active,
      accountId: last.t.accountId,
      transactionIds: list.map((f) => f.t.id),
      ...(last.t.category ? { category: last.t.category } : {}),
      ...(priceChange ? { priceChange } : {}),
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.monthlyCost - a.monthlyCost);
}
