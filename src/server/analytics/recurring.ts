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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function detectRecurring(store: Store, on: string = today()): RecurringItem[] {
  const cats = new CategoryIndex(store.categories);
  const from = addDays(on, -730);
  const groups = new Map<string, FlowTx[]>();
  for (const f of flows(store, from, on)) {
    if (f.cls !== 'spending' || f.minor <= 0) continue;
    if (f.t.category === 'cash-withdrawal') continue;
    const payee = (f.t.payee ?? cleanPayee(f.t.description)).trim();
    const key = `${f.t.accountId}|${payee.toLowerCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  const out: RecurringItem[] = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    list.sort((a, b) => (a.t.date < b.t.date ? -1 : 1));
    // Several payments on one day (e.g. split bills) count once for cadence purposes.
    const dates = [...new Set(list.map((f) => f.t.date))];
    if (dates.length < 3) continue;
    const intervals = dates.slice(1).map((d, i) => diffDays(dates[i]!, d));
    const m = median(intervals);
    const cadence = CADENCES.find((c) => m >= c.min && m <= c.max);
    if (!cadence) continue;
    const regular = intervals.filter((iv) => Math.abs(iv - m) <= Math.max(3, m * 0.35)).length / intervals.length;
    if (regular < 0.6) continue;
    const amounts = list.map((f) => f.minor);
    const recent = amounts.slice(-3);
    const typical = median(recent);
    const spread = median(amounts.map((a) => Math.abs(a - median(amounts)))) / Math.max(1, median(amounts));
    if (spread > 0.25 && new Set(recent).size > 1) continue;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const nextDate = addDays(last.t.date, Math.round(m));
    const active = diffDays(last.t.date, on) <= m * 1.6;
    const firstAmount = amounts[0]!;
    const lastAmount = amounts[amounts.length - 1]!;
    let priceChange: RecurringItem['priceChange'];
    if (cadence.id !== 'weekly' && Math.abs(lastAmount - firstAmount) / Math.max(1, firstAmount) > 0.03 && new Set(recent).size === 1) {
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
