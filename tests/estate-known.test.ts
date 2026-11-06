// When the estate is fully known (docs/FORMULAS.md §9, "Known on D" and "Incomplete stretches"): an
// account opened before its data starts leaves only the days from its opening out, never the
// history before it; confirming nothing is missing from its opening counts it from then.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine, confirmedThrough } from '../src/server/analytics/balances';
import { Coverage } from '../src/server/analytics/coverage';
import { estateKnownOn, estateOn, estateSeries, incompleteStretches } from '../src/server/analytics/estate';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, BalanceSnapshot, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: `Example ${id}`, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {} });
const bal = (accountId: string, date: string, balance: number): BalanceSnapshot => ({ id: `bal_${(n++ * 7919).toString(16).padStart(16, '0')}`, accountId, date, balance, currency: 'GBP', kind: 'screenshot', source: {}, createdAt: stamp });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-known-'));
  store = await Store.open(path.join(dir, 'data'));
  // A current account with a year of data, and a new investment account opened a day before its
  // first valuation (£0, no rows).
  await store.upsertAccount(acct('bank', 'current'));
  await store.upsertAccount(acct('new-gia', 'gia', { openedOn: '2026-11-05' }));
  await store.addTransactions([tx('bank', '2025-11-01', 1000, 'PAY'), tx('bank', '2026-06-01', -200, 'SHOP')], 'rows');
  await store.addBalances([bal('bank', '2026-11-06', 800), bal('new-gia', '2026-11-06', 0)], 'balances');
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('confirmedThrough', () => {
  it('needs the stretches to cover every day, together', () => {
    expect(confirmedThrough([{ from: '2026-01-01', to: '2026-01-10' }], '2026-01-01', '2026-01-10')).toBe(true);
    expect(confirmedThrough([{ from: '2026-01-06', to: '2026-01-10' }, { from: '2026-01-01', to: '2026-01-05' }], '2026-01-02', '2026-01-09')).toBe(true);
    expect(confirmedThrough([{ from: '2026-01-01', to: '2026-01-04' }, { from: '2026-01-06', to: '2026-01-10' }], '2026-01-01', '2026-01-10')).toBe(false);
    expect(confirmedThrough([{ from: '2026-01-02', to: '2026-01-10' }], '2026-01-01', '2026-01-10')).toBe(false);
    expect(confirmedThrough([], '2026-01-01', '2026-01-01')).toBe(false);
  });
});

describe('an account opened before its data starts', () => {
  it('leaves out only the days from its opening, not the history before', () => {
    const engine = new BalanceEngine(store);
    expect(estateKnownOn(store, engine, '2026-11-04')).toBe(true);
    expect(estateKnownOn(store, engine, '2026-11-05')).toBe(false);
    expect(estateKnownOn(store, engine, '2026-11-06')).toBe(true);
    expect(incompleteStretches(store, engine, '2025-11-01', '2026-11-06')).toEqual([{ from: '2026-11-05', to: '2026-11-05', accounts: [{ id: 'new-gia', name: 'Example new-gia' }] }]);
    const s = estateSeries(store, engine, '2026-11-01', '2026-11-06', 'wrapper');
    expect(s.incomplete).toEqual([{ from: '2026-11-05', to: '2026-11-05', accounts: [{ id: 'new-gia', name: 'Example new-gia' }] }]);
  });

  it('is listed in Data health from its opening to its first data', () => {
    const engine = new BalanceEngine(store);
    const gaps = new Coverage(store).gaps(engine, '2026-04-06', '2026-11-06').filter((g) => g.accountId === 'new-gia');
    expect(gaps).toEqual([expect.objectContaining({ from: '2026-11-05', to: '2026-11-05', beforeData: true, valuations: true })]);
  });

  it('counts from its opening once you confirm nothing is missing before its data', async () => {
    await store.setCoverageConfirmations([{ id: 'cov_000000000001', accountId: 'new-gia', from: '2026-11-05', to: '2026-11-05', confirmedAt: stamp }]);
    const engine = new BalanceEngine(store);
    expect(engine.firstDataDate('new-gia')).toBe('2026-11-05');
    expect(engine.balanceOn('new-gia', '2026-11-05')?.value).toBe(0);
    expect(engine.balanceOn('new-gia', '2026-11-04')).toBeNull();
    expect(estateKnownOn(store, engine, '2026-11-05')).toBe(true);
    expect(estateOn(store, engine, '2026-11-05').total).toBe(800);
    expect(incompleteStretches(store, engine, '2025-11-01', '2026-11-06')).toEqual([]);
    expect(new Coverage(store).gaps(engine, '2026-04-06', '2026-11-06').filter((g) => g.accountId === 'new-gia')).toEqual([]);
  });

  it('a confirmation short of its first data changes nothing', async () => {
    await store.upsertAccount({ ...store.account('new-gia')!, openedOn: '2026-11-01' });
    await store.setCoverageConfirmations([{ id: 'cov_000000000002', accountId: 'new-gia', from: '2026-11-01', to: '2026-11-04', confirmedAt: stamp }]);
    const engine = new BalanceEngine(store);
    expect(engine.firstDataDate('new-gia')).toBe('2026-11-06');
    expect(incompleteStretches(store, engine, '2026-10-01', '2026-11-06')).toEqual([{ from: '2026-11-01', to: '2026-11-05', accounts: [{ id: 'new-gia', name: 'Example new-gia' }] }]);
  });
});

describe('an account with no opening date', () => {
  it('leaves out everything before its data, and splits where the set of accounts changes', async () => {
    await store.upsertAccount(acct('old-isa', 'stocks_isa'));
    await store.addBalances([bal('old-isa', '2026-03-01', 5000)], 'isa');
    const engine = new BalanceEngine(store);
    expect(incompleteStretches(store, engine, '2025-11-01', '2026-11-06')).toEqual([
      { from: '2025-11-01', to: '2026-02-28', accounts: [{ id: 'old-isa', name: 'Example old-isa' }] },
      { from: '2026-11-05', to: '2026-11-05', accounts: [{ id: 'new-gia', name: 'Example new-gia' }] },
    ]);
  });
});
