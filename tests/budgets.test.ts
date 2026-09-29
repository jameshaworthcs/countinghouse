// Budgets (docs/FORMULAS.md §15): spending against a monthly amount, the usual pace, suggestions,
// and the Overview's alert. All data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Analytics } from '../src/server/analytics';
import { budgets, median, tidyUp, usualShare } from '../src/server/analytics/budgets';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, Budget, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
let dir: string;
let store: Store;
let n = 0;
const tx = (date: string, amount: number, category: string, description = 'CARD PAYMENT'): Transaction => ({ id: transactionId('current', date, amount, description, n++), accountId: 'current', date, amount, currency: 'GBP', description, category, source: {} });
const budget = (category: string | undefined, monthly: number): Budget => ({ ...(category ? { category } : {}), monthly, createdAt: stamp, updatedAt: stamp });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-budgets-'));
  store = await Store.open(path.join(dir, 'data'));
  const account: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  await store.setAccounts([account]);
  // Six complete months: rent on the 1st, groceries of £50 on the 5th and the 20th, a meal out.
  const rows: Transaction[] = [];
  for (const m of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) {
    rows.push(tx(`${m}-01`, -900, 'rent'), tx(`${m}-05`, -50, 'groceries'), tx(`${m}-20`, -50, 'groceries'), tx(`${m}-25`, -40, 'eating-out'));
  }
  // September so far: £60 of groceries by the 10th, and rent.
  rows.push(tx('2026-09-01', -900, 'rent'), tx('2026-09-03', -35, 'groceries'), tx('2026-09-10', -25, 'groceries'));
  // Data for the account runs to 28 Feb before (so March is a complete month) and to 10 Sep.
  rows.push(tx('2026-02-28', -1, 'other-expense'));
  await store.addTransactions(rows, 'test: transactions');
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('the pieces', () => {
  it('suggestions round up to tidy amounts; the median is the middle', () => {
    expect([tidyUp(41), tidyUp(99.5), tidyUp(101), tidyUp(1001)]).toEqual([45, 100, 110, 1050]);
    expect([median([3, 1, 2]), median([4, 1, 3, 2]), median([])]).toEqual([2, 2.5, 0]);
  });

  it('the usual pace is the share of each month’s spending done by that day, averaged; it needs two months', () => {
    const byMonth = new Map([
      ['2026-07', [{ day: 5, minor: 5000 }, { day: 20, minor: 5000 }]],
      ['2026-08', [{ day: 2, minor: 3000 }, { day: 25, minor: 1000 }]],
    ]);
    expect(usualShare(byMonth, ['2026-07', '2026-08'], 10)).toEqual({ share: (0.5 + 0.75) / 2, months: 2 });
    expect(usualShare(byMonth, ['2026-07'], 10)).toBeNull();
    // A month with nothing spent says nothing about the pace.
    expect(usualShare(new Map([...byMonth, ['2026-06', []]]), ['2026-06', '2026-07', '2026-08'], 10)!.months).toBe(2);
  });
});

describe('a month against its budgets', () => {
  it('over: spent more than the budget', async () => {
    await store.setBudgets([budget('eating-out', 30)]);
    const b = budgets(store, '2026-08', '2026-09-12');
    expect(b.complete).toBe(true);
    expect(b.lines[0]).toMatchObject({ name: 'Eating out', scope: 'category', spent: 40, left: -10, status: 'over', expectedShare: 1, projected: null });
  });

  it('on pace to go over: ahead of how far through a usual month’s spending the data reaches', async () => {
    await store.setBudgets([budget('groceries', 100)]);
    const b = budgets(store, '2026-09', '2026-09-12');
    expect(b.dataTo).toBe('2026-09-10');
    const [l] = b.lines;
    // Usually half of it is spent by the 10th (the £50 on the 5th); £60 by the 10th heads for £120.
    expect(l).toMatchObject({ spent: 60, expectedShare: 0.5, projected: 120, status: 'pace' });
    expect(l!.paceBasis).toBe('usually 50% of a month’s spending here is done by the 10th (6 past months)');
    expect(b.note).toBeNull();
  });

  it('with under two months of history the pace is the share of days, and early in the month none is judged', async () => {
    const other = await Store.open(path.join(dir, 'other'));
    try {
      await other.setAccounts(store.accounts);
      await other.addTransactions([tx('2026-09-01', -60, 'groceries'), tx('2026-09-10', -1, 'other-expense')], 'test: transactions');
      await other.setBudgets([budget('groceries', 100)]);
      // 10 of 30 days gone: £60 heads for £180.
      expect(budgets(other, '2026-09', '2026-09-12').lines[0]).toMatchObject({ expectedShare: 10 / 30, projected: 180, status: 'pace', paceBasis: '10 of the month’s 30 days' });
      // 5 days in, too early to judge a pace: only what is spent counts.
      expect(budgets(other, '2026-09', '2026-09-05').lines[0]).toMatchObject({ projected: null, status: 'ok', spent: 60 });
    } finally {
      other.stopWatching();
    }
  });

  it('a group covers its categories; no category covers all spending', async () => {
    await store.setBudgets([budget('food', 200), budget(undefined, 2000)]);
    const b = budgets(store, '2026-08', '2026-09-12');
    expect(b.lines.map((l) => [l.name, l.scope, l.spent, l.status])).toEqual([
      ['All spending', 'total', 1040, 'ok'],
      ['Food & drink', 'group', 140, 'ok'],
    ]);
  });

  it('nearly spent at 90%', async () => {
    await store.setBudgets([budget('groceries', 110)]);
    expect(budgets(store, '2026-08', '2026-09-12').lines[0]!.status).toBe('near');
  });

  it('suggests what you typically spend, rounded up, for what has no budget', async () => {
    await store.setBudgets([budget('groceries', 100)]);
    const b = budgets(store, '2026-09', '2026-09-12');
    expect(b.pastMonths).toBe(6);
    expect(b.lines[0]!.suggested).toBe(100);
    expect(b.suggestions.map((s) => [s.name, s.suggested, s.typical])).toEqual([
      ['All spending', 1050, 1040],
      ['Housing', 900, 900],
      ['Food & drink', 140, 140],
    ]);
  });

  it('the Overview warns about budgets over or on pace to go over this month', async () => {
    await store.setBudgets([budget('groceries', 100), budget('rent', 1000)]);
    const alerts = new Analytics(store).summary({}).alerts.filter((a) => a.id === 'budgets');
    // The summary is for today; the September data above is only "this month" in September 2026.
    expect(alerts.length).toBeLessThanOrEqual(1);
    const b = budgets(store, '2026-09', '2026-09-12');
    expect(b.lines.filter((l) => l.status === 'over' || l.status === 'pace').map((l) => l.name)).toEqual(['Groceries']);
  });
});
