// Income and spending. Transfers between your own accounts and investment flows are excluded; a
// refund reduces spending rather than counting as income.

import { balanceModeOf } from '../../shared/accounts';
import type { CashflowMonth, CashflowResponse, CategoryAmount } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { eachMonth, monthKey } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Transaction } from '../../shared/schema';
import type { Store } from '../store';

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

export function flows(store: Store, from: string, to: string, accountIds?: Set<string>): FlowTx[] {
  const cats = new CategoryIndex(store.categories);
  const accounts = new Map(store.accounts.map((a) => [a.id, a]));
  const out: FlowTx[] = [];
  for (const t of store.transactions()) {
    if (t.date < from || t.date > to) continue;
    if (accountIds && !accountIds.has(t.accountId)) continue;
    const cls = classifyFlow(t, cats, accounts.get(t.accountId));
    if (cls === 'excluded') continue;
    const minor = cls === 'income' ? toMinor(t.amount) : -toMinor(t.amount);
    out.push({ t, cls, minor });
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
  const groupKey = (f: FlowTx) => (f.t.category ? (cats.groupOf(f.t.category)?.id ?? f.t.category) : 'uncategorised');
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
      .sort((a, b) => b.amount - a.amount);
  };
  const prevLeaf = previous ? agg(previous, leafKey) : undefined;
  const prevGroup = previous ? agg(previous, groupKey) : undefined;
  return { categories: build(agg(list, leafKey), prevLeaf, false), groups: build(agg(list, groupKey), prevGroup, true) };
}

export function cashflow(store: Store, from: string, to: string): CashflowResponse {
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
  const months: CashflowMonth[] = [...byMonth.entries()].map(([month, e]) => ({
    month,
    income: fromMinor(e.income),
    spending: fromMinor(e.spending),
    net: fromMinor(e.income - e.spending),
    savingsRate: e.income > 0 ? (e.income - e.spending) / e.income : null,
  }));
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
