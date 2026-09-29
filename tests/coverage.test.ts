// Coverage, baselines from covered time, and the sparse-data fixes they enable.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeBaseline } from '../src/server/analytics/baseline';
import { BalanceEngine } from '../src/server/analytics/balances';
import { complement, Coverage, coveredDays, intersect, mergeIntervals } from '../src/server/analytics/coverage';
import { projections } from '../src/server/analytics/projections';
import { previousPeriod, spending } from '../src/server/analytics/spending';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { AssumptionSet } from '../src/shared/assumptions';
import { addDays, endOfMonth } from '../src/shared/dates';
import type { Account, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

describe('interval arithmetic', () => {
  it('merges touching and overlapping intervals', () => {
    expect(mergeIntervals([{ from: '2026-01-10', to: '2026-01-20' }, { from: '2026-01-01', to: '2026-01-09' }, { from: '2026-01-15', to: '2026-02-01' }, { from: '2026-03-01', to: '2026-03-02' }])).toEqual([
      { from: '2026-01-01', to: '2026-02-01' },
      { from: '2026-03-01', to: '2026-03-02' },
    ]);
  });
  it('counts, intersects and complements', () => {
    const a = [{ from: '2026-01-01', to: '2026-01-31' }];
    const b = [{ from: '2026-01-20', to: '2026-02-10' }];
    expect(coveredDays(a, '2026-01-15', '2026-02-15')).toBe(17);
    expect(intersect(a, b)).toEqual([{ from: '2026-01-20', to: '2026-01-31' }]);
    expect(complement(b, '2026-01-01', '2026-02-28')).toEqual([
      { from: '2026-01-01', to: '2026-01-19' },
      { from: '2026-02-11', to: '2026-02-28' },
    ]);
  });
});

describe('the period spending is compared with', () => {
  it('compares like for like, so monthly bills fall the same way in both', () => {
    // This month so far against the same days of last month.
    expect(previousPeriod('2026-09-01', '2026-09-03')).toEqual({ from: '2026-08-01', to: '2026-08-03' });
    // Whole months against whole months, whatever their lengths.
    expect(previousPeriod('2026-09-01', '2026-09-30')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(previousPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    // This month and the two before.
    expect(previousPeriod('2026-07-01', '2026-09-29')).toEqual({ from: '2026-04-01', to: '2026-06-29' });
    // Twelve months, and the tax year so far against the same dates a year earlier.
    expect(previousPeriod('2025-10-01', '2026-09-29')).toEqual({ from: '2024-10-01', to: '2025-09-29' });
    expect(previousPeriod('2026-04-06', '2026-09-29')).toEqual({ from: '2025-04-06', to: '2025-09-29' });
    // Any other range: the same number of days just before.
    expect(previousPeriod('2026-09-10', '2026-09-19')).toEqual({ from: '2026-08-31', to: '2026-09-09' });
  });
});

describe('coverage-aware baselines', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-coverage-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('current', 'current'), acct('card', 'credit_card')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  /** Months of salary 3000 and spending 2000 (1200 current + 800 card), on both accounts. */
  async function months(list: string[]) {
    const txs: Transaction[] = [];
    for (const m of list) {
      txs.push(tx('current', `${m}-01`, -1200, 'RENT'), tx('current', `${m}-25`, 3000, 'ACME LTD SALARY', { category: 'salary' }), tx('card', `${m}-10`, -800, 'TESCO STORES', { category: 'groceries' }));
      // Each account's statement covers the whole month.
    }
    await store.addTransactions(txs, 'test');
    for (const m of list) {
      for (const accountId of ['current', 'card']) {
        await store.saveImport(
          {
            id: `imp_${m.replace('-', '')}01_000000_${accountId === 'card' ? 'aaaa' : 'bbbb'}`,
            status: 'committed',
            createdAt: stamp,
            updatedAt: stamp,
            origin: 'upload',
            document: { id: `doc_${'0'.repeat(15)}${accountId === 'card' ? 'a' : 'b'}`, sha256: '0'.repeat(64), fileName: 's.pdf', mediaType: 'application/pdf', size: 1 },
            extraction: { warnings: [] },
            draft: { documentType: 'bank_statement', sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId }, currency: 'GBP', periodStart: `${m}-01`, periodEnd: endOfMonth(`${m}-01`), recordBalance: false, transactions: [], recordHoldings: false, holdings: [] }], figures: [], notes: [] },
            result: { accountIds: [accountId], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
          },
          'test import',
        );
      }
    }
  }

  it('averages over complete months, not the calendar (four months of data in a twelve-month window)', async () => {
    await months(['2026-05', '2026-06', '2026-07', '2026-08']);
    const cov = new Coverage(store);
    const b = computeBaseline(store, cov, '2025-09-01', '2026-08-31', new AssumptionSet([], '2026-09-28'));
    expect(b.available).toBe(true);
    expect(b.basis).toMatchObject({ kind: 'months', months: ['2026-05', '2026-06', '2026-07', '2026-08'] });
    expect(b.monthly).toEqual({ income: 3000, spending: 2000, net: 1000 });
    expect(b.confidence).toBe('high');
  });

  it('ignores days one account is missing, and says which account limits coverage', async () => {
    await months(['2026-07', '2026-08']);
    // A third account whose only statement covers the first half of August.
    await store.setAccounts([...store.accounts, acct('savings', 'savings')]);
    await store.addTransactions([tx('savings', '2026-08-15', 5, 'INTEREST', { category: 'interest', source: { importId: 'imp_20260816_000000_cccc' } })], 'test');
    await store.saveImport(
      {
        id: 'imp_20260816_000000_cccc',
        status: 'committed',
        createdAt: stamp,
        updatedAt: stamp,
        origin: 'upload',
        document: { id: `doc_${'0'.repeat(15)}c`, sha256: '0'.repeat(64), fileName: 's.pdf', mediaType: 'application/pdf', size: 1 },
        extraction: { warnings: [] },
        draft: { documentType: 'savings_statement', sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'savings' }, currency: 'GBP', periodStart: '2026-08-01', periodEnd: '2026-08-15', recordBalance: false, transactions: [], recordHoldings: false, holdings: [] }], figures: [], notes: [] },
        result: { accountIds: ['savings'], accountsCreated: [], transactionsAdded: 1, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
      },
      'test import',
    );
    const cov = new Coverage(store);
    const joint = cov.joint('2026-07-01', '2026-08-31');
    expect(joint.limiting[0]).toMatchObject({ accountId: 'savings' });
    // Before the savings account's first data it does not count; after, its gaps do.
    expect(joint.limiting[0]!.missingDays).toBe(16);
    expect(joint.completeMonths).toEqual(['2026-07']);
  });

  it('with less than a month of data, says so rather than guess', async () => {
    await store.addTransactions([tx('current', '2026-09-02', -50, 'LUNCH'), tx('current', '2026-09-20', -50, 'LUNCH'), tx('card', '2026-09-03', -100, 'SHOP'), tx('card', '2026-09-20', -40, 'SHOP')], 'test');
    const b = computeBaseline(store, new Coverage(store), '2026-09-01', '2026-09-30', new AssumptionSet([], '2026-09-28'));
    // 19 covered days (2–20 Sept; the card counts from its first data on the 3rd): too few for a
    // month's cycle of pay and bills.
    expect(b.available).toBe(false);
    expect(b.reason).toBe('Only 19 days in Sep 2026 have data for every account; at least 28 are needed');
  });

  it('with a month’s cycle but no complete month, uses covered days at low confidence', async () => {
    // 10 Sept to 12 Oct: 33 covered days, neither month 90% covered.
    await store.addTransactions([tx('current', '2026-09-10', -50, 'LUNCH'), tx('current', '2026-09-20', -50, 'LUNCH'), tx('current', '2026-10-12', -50, 'LUNCH'), tx('card', '2026-09-10', -100, 'SHOP'), tx('card', '2026-10-12', -40, 'SHOP')], 'test');
    const b = computeBaseline(store, new Coverage(store), '2026-09-01', '2026-10-31', new AssumptionSet([], '2026-10-28'));
    expect(b.available).toBe(true);
    expect(b.basis).toMatchObject({ kind: 'days', days: 33 });
    expect(b.confidence).toBe('low');
    expect(b.monthly.spending).toBeCloseTo((290 / 33) * (365.25 / 12), 1);
    expect(b.netSdBasis).toMatch(/fewer than 3 complete months/);
  });

  it('spending averages divide by covered days', async () => {
    await months(['2026-08']);
    const s = spending(store, '2026-06-01', '2026-08-31');
    expect(s.coverage.days).toBe(31);
    expect(s.dailyAverage).toBeCloseTo(2000 / 31, 1);
  });

  it('the breakdown adds up in both periods, including what was spent only before', async () => {
    await months(['2026-05', '2026-06', '2026-07', '2026-08']);
    await store.addTransactions([tx('card', '2026-06-12', -950, 'EASYJET', { category: 'flights' })], 'test');
    // June–August against March–May: the flight falls in the current period.
    const now = spending(store, '2026-06-01', '2026-08-31');
    expect(now.previousFrom).toBe('2026-03-01');
    expect(now.groups.reduce((sum, g) => sum + g.amount, 0)).toBeCloseTo(now.total, 2);
    // July–September against April–June: the flight is only in the previous period, at £0 now.
    const later = spending(store, '2026-07-01', '2026-09-30');
    expect(later.groups.reduce((sum, g) => sum + (g.previous ?? 0), 0)).toBeCloseTo(later.previousTotal, 2);
    const flights = later.categories.find((c) => c.id === 'flights');
    expect(flights).toMatchObject({ amount: 0, previous: 950, change: -1 });
  });

  it('projections use the covered months and carry a range', async () => {
    await months(['2026-06', '2026-07', '2026-08']);
    const p = projections(store, new BalanceEngine(store), { months: 24 });
    const year = p.scenarios.find((s) => s.id === 'year')!;
    expect(year.available).toBe(true);
    expect(year.monthly.income).toBe(3000);
    const pts = p.series.find((s) => s.id === 'year')!.points;
    expect(pts[pts.length - 1]!.band.p90).toBeGreaterThanOrEqual(pts[pts.length - 1]!.band.p10);
    expect(p.assumptions.map((a) => a.key)).toContain('inflation');
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
  });
});
