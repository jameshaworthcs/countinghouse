// Income and spending. Transfers between your own accounts and investment flows are excluded; a
// refund reduces spending rather than counting as income.

import { balanceModeOf } from '../../shared/accounts';
import type { CashflowMonth, CashflowResponse, CategoryAmount } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { eachMonth, endOfMonth, maxDate, minDate, monthKey } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Transaction } from '../../shared/schema';
import type { Store } from '../store';
import { Coverage } from './coverage';

export type FlowClass = 'income' | 'spending' | 'excluded';

export function classifyFlow(t: Transaction, cats: CategoryIndex, account: Account | undefined): FlowClass {
  if (!account || balanceModeOf(account) === 'market') return 'excluded';
  if (t.transferGroup) return 'excluded';
  const kind = cats.kindOf(t.category);
  if (kind === 'transfer' || kind === 'investment') return 'excluded';
  if (kind === 'income') return t.category === 'refunds' ? 'spending' : 'income';
  if (kind === 'expense') return 'spending';
  return t.amount > 0 ? 'income' : 'spending';
}

export interface FlowTx {
  t: Transaction;
  cls: 'income' | 'spending';
  /** Income: amount received. Spending: amount spent (refunds negative). In pence. */
  minor: number;
}

/**
 * The parts of a transaction for income and spending: its split lines when you split it (each with
 * its own category and amount), else the transaction itself. What the lines do not account for stays
 * in the transaction's own category. A transfer is never split.
 */
export function categoryLines(t: Transaction): Transaction[] {
  if (!t.splits?.length || t.transferGroup) return [t];
  const lines: Transaction[] = t.splits.map((s) => ({ ...t, amount: s.amount, category: s.category }));
  const rest = toMinor(t.amount) - t.splits.reduce((sum, s) => sum + toMinor(s.amount), 0);
  if (rest !== 0) lines.push({ ...t, amount: fromMinor(rest) });
  return lines;
}

export function flows(store: Store, from: string, to: string, accountIds?: Set<string>): FlowTx[] {
  const cats = new CategoryIndex(store.categories);
  const accounts = new Map(store.accounts.map((a) => [a.id, a]));
  const out: FlowTx[] = [];
  for (const whole of store.transactions()) {
    if (whole.date < from || whole.date > to) continue;
    if (accountIds && !accountIds.has(whole.accountId)) continue;
    for (const t of categoryLines(whole)) {
      const cls = classifyFlow(t, cats, accounts.get(t.accountId));
      if (cls === 'excluded') continue;
      const minor = cls === 'income' ? toMinor(t.amount) : -toMinor(t.amount);
      out.push({ t, cls, minor });
    }
  }
  return out;
}

export function categoryBreakdown(list: FlowTx[], cats: CategoryIndex, cls: 'income' | 'spending', previous?: FlowTx[]): { categories: CategoryAmount[]; groups: CategoryAmount[] } {
  const agg = (items: FlowTx[], keyOf: (f: FlowTx) => string) => {
    const m = new Map<string, { minor: number; count: number }>();
    for (const f of items) {
      if (f.cls !== cls) continue;
      const k = keyOf(f);
      const e = m.get(k) ?? { minor: 0, count: 0 };
      e.minor += f.minor;
      e.count++;
      m.set(k, e);
    }
    return m;
  };
  const leafKey = (f: FlowTx) => f.t.category ?? 'uncategorised';
  // Refunds count as negative spending; as a group they are "Refunds", not their "Income" parent.
  const groupKey = (f: FlowTx) => (!f.t.category ? 'uncategorised' : f.cls === 'spending' && cats.kindOf(f.t.category) === 'income' ? f.t.category : (cats.groupOf(f.t.category)?.id ?? f.t.category));
  const build = (m: Map<string, { minor: number; count: number }>, prev: Map<string, { minor: number; count: number }> | undefined, isGroup: boolean): CategoryAmount[] => {
    const total = [...m.values()].reduce((s, e) => s + e.minor, 0);
    return [...m.entries()]
      .map(([id, e]) => {
        const c = cats.get(id);
        const group = isGroup ? undefined : cats.groupOf(id);
        const p = prev?.get(id)?.minor;
        const out: CategoryAmount = {
          id,
          name: id === 'uncategorised' ? 'Uncategorised' : (c?.name ?? id),
          kind: c?.kind ?? (cls === 'income' ? 'income' : 'expense'),
          amount: fromMinor(e.minor),
          count: e.count,
          share: total ? e.minor / total : 0,
          ...(group && group.id !== id ? { groupId: group.id, groupName: group.name } : {}),
        };
        if (prev) {
          out.previous = fromMinor(p ?? 0);
          out.change = p ? (e.minor - p) / Math.abs(p) : null;
        }
        return out;
      })
      .concat(
        // What was spent before and not at all now. Refunds on their own (a negative amount) are
        // left out: they are not somewhere the money went.
        [...(prev ?? new Map<string, { minor: number; count: number }>())]
          .filter(([id, e]) => !m.has(id) && e.minor > 0)
          .map(([id, e]) => {
            const group = isGroup ? undefined : cats.groupOf(id);
            return {
              id,
              name: id === 'uncategorised' ? 'Uncategorised' : (cats.get(id)?.name ?? id),
              kind: cats.get(id)?.kind ?? (cls === 'income' ? 'income' : 'expense'),
              amount: 0,
              count: 0,
              share: 0,
              previous: fromMinor(e.minor),
              change: -1,
              ...(group && group.id !== id ? { groupId: group.id, groupName: group.name } : {}),
            };
          }),
      )
      .sort((a, b) => b.amount - a.amount || (b.previous ?? 0) - (a.previous ?? 0));
  };
  const prevLeaf = previous ? agg(previous, leafKey) : undefined;
  const prevGroup = previous ? agg(previous, groupKey) : undefined;
  return { categories: build(agg(list, leafKey), prevLeaf, false), groups: build(agg(list, groupKey), prevGroup, true) };
}

export function cashflow(store: Store, from: string, to: string, coverage: Coverage = new Coverage(store)): CashflowResponse {
  const cats = new CategoryIndex(store.categories);
  const list = flows(store, from, to);
  const byMonth = new Map<string, { income: number; spending: number }>();
  for (const m of eachMonth(from, to)) byMonth.set(m, { income: 0, spending: 0 });
  let income = 0;
  let spending = 0;
  for (const f of list) {
    const e = byMonth.get(monthKey(f.t.date))!;
    if (f.cls === 'income') {
      e.income += f.minor;
      income += f.minor;
    } else {
      e.spending += f.minor;
      spending += f.minor;
    }
  }
  const months: CashflowMonth[] = [...byMonth.entries()].map(([month, e]) => {
    const joint = coverage.joint(maxDate(`${month}-01`, from)!, minDate(endOfMonth(`${month}-01`), to)!);
    return {
      month,
      income: fromMinor(e.income),
      spending: fromMinor(e.spending),
      net: fromMinor(e.income - e.spending),
      savingsRate: e.income > 0 ? (e.income - e.spending) / e.income : null,
      covered: joint.totalDays ? joint.days / joint.totalDays : 0,
    };
  });
  const { categories, groups } = categoryBreakdown(list, cats, 'spending');
  return {
    from,
    to,
    months,
    totals: {
      income: fromMinor(income),
      spending: fromMinor(spending),
      net: fromMinor(income - spending),
      savingsRate: income > 0 ? (income - spending) / income : null,
    },
    categories,
    groups,
  };
}
