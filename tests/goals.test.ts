// Goals (docs/FORMULAS.md §16): progress from the accounts that fund a goal, when it is reached at
// the recent pace, the monthly saving that would reach it by its date, and the LISA's rules. All
// data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { accountPath, goalsProgress, lisaShare } from '../src/server/analytics/goals';
import { balanceId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, Goal, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const goal = (g: Partial<Goal> & Pick<Goal, 'id'>): Goal => ({ name: g.id, accountIds: ['savings'], createdAt: stamp, updatedAt: stamp, ...g });
let n = 0;
const tx = (accountId: string, date: string, amount: number, category: string): Transaction => ({ id: transactionId(accountId, date, amount, category, n++), accountId, date, amount, currency: 'GBP', description: category, category, source: {} });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-goals-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([acct('current', 'current'), acct('savings', 'savings', { name: 'Easy saver', interestRate: 0 })]);
  // June to August: pay £3,000, spend £2,000, move £500 to savings each month.
  const rows: Transaction[] = [];
  for (const m of ['2026-06', '2026-07', '2026-08']) {
    rows.push(tx('current', `${m}-01`, 3000, 'salary'), tx('current', `${m}-10`, -2000, 'groceries'), tx('current', `${m}-15`, -500, 'savings-transfer'), tx('savings', `${m}-15`, 500, 'savings-transfer'));
  }
  rows.push(tx('current', '2026-08-31', -0.01, 'bank-fees'), tx('savings', '2026-06-01', 0.01, 'interest'), tx('savings', '2026-08-31', 0.01, 'interest'));
  await store.addTransactions(rows, 'test: transactions');
  await store.addBalances([{ id: balanceId('savings', '2026-08-31', 5000, 'manual', stamp), accountId: 'savings', date: '2026-08-31', balance: 5000, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp }], 'test: balance');
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

const progress = () => goalsProgress(store, new BalanceEngine(store), '2026-09-15');

describe('a goal’s path', () => {
  it('cash grows by its rate and what comes in, with no spread', () => {
    const p = accountPath({ bucket: 'cash', value: 1000, expectedReturn: { value: 0, source: 'fallback', basis: '' }, volatility: { value: 0, source: 'fallback', basis: '' }, fundFee: { value: 0, source: 'fallback', basis: '' }, platformFee: { value: 0, source: 'fallback', basis: '' }, interest: { value: 0.12, source: 'account', basis: '' } }, 100, 12);
    let v = 1000;
    for (let t = 0; t < 12; t++) v = (v + 100) * Math.pow(1.12, 1 / 12);
    expect(p.mean[12]).toBeCloseTo(v, 6);
    expect(p.sd.every((s) => s < 1e-6)).toBe(true);
  });
});

describe('progress and when it is reached', () => {
  it('an amount: today’s value, the recent pace, and the month it is reached', async () => {
    await store.setGoals([goal({ id: 'car', targetAmount: 7000, targetDate: '2027-06-01' })]);
    const [g] = progress().goals;
    expect(g).toMatchObject({ kind: 'savings', target: 7000, current: 5000, share: 5000 / 7000, monthly: 500, status: 'on-track', neededMonthly: 0 });
    // £2,000 to go at £500 a month, with no interest and no spread: four months.
    expect(g!.reach).toEqual({ early: '2027-01-15', median: '2027-01-15', late: '2027-01-15' });
    expect(g!.accounts[0]).toMatchObject({ accountId: 'savings', value: 5000, counted: 5000, monthly: 500 });
  });

  it('behind: what more a month would reach it by the date', async () => {
    await store.setGoals([goal({ id: 'deposit', targetAmount: 20000, targetDate: '2027-09-15' })]);
    const [g] = progress().goals;
    expect(g!.status).toBe('behind');
    // Twelve months of £500 reach £11,000: £9,000 short over 12 months with no growth is £750 more.
    expect(g!.atTargetDate?.p50).toBe(11000);
    expect(g!.neededMonthly).toBe(750);
  });

  it('an emergency fund is months of your spending', async () => {
    await store.setGoals([goal({ id: 'rainy-day', kind: 'emergency-fund', months: 3 })]);
    const [g] = progress().goals;
    expect(g).toMatchObject({ target: 6000, status: 'no-date' });
    expect(g!.targetBasis).toMatch(/^3 months of spending at £2,000 a month/);
  });

  it('reached, and a goal with nothing to measure says so', async () => {
    await store.setGoals([goal({ id: 'small', targetAmount: 4000 }), goal({ id: 'nothing', targetAmount: 100, accountIds: [] })]);
    const [small, nothing] = progress().goals;
    expect(small!.status).toBe('reached');
    expect(nothing!.status).toBe('unknown');
  });
});

describe('a Lifetime ISA in a goal', () => {
  beforeEach(async () => {
    await store.setAccounts([...store.accounts, acct('lisa', 'lisa', { openedOn: '2026-01-10' })]);
    await store.setProfile({ ...store.profile, dateOfBirth: '1994-05-14' });
  });
  const share = (g: Partial<Goal>) => lisaShare(store, goal({ id: 'g', accountIds: ['lisa'], ...g }), store.account('lisa')!, g.targetDate ?? '2026-09-15');

  it('counts in full for a first home within the cap once it is a year old', () => {
    expect(share({ kind: 'home-deposit', propertyPrice: 400_000, targetDate: '2028-06-01' }).share).toBe(1);
    expect(share({ kind: 'home-deposit', targetDate: '2028-06-01' }).share).toBe(1);
  });

  it('counts at 75% otherwise: another goal, a home over the cap, or too soon', () => {
    expect(share({ kind: 'savings' })).toMatchObject({ share: 0.75 });
    expect(share({ kind: 'emergency-fund' }).note).toMatch(/costs the 25% charge/);
    expect(share({ kind: 'home-deposit', propertyPrice: 500_000, targetDate: '2028-06-01' }).note).toMatch(/over £450,000 is not a qualifying purchase/);
    expect(share({ kind: 'home-deposit', targetDate: '2026-12-01' }).note).toMatch(/will not be a year old \(from 2026-01-10\) by 2026-12-01/);
  });

  it('is free at 60', async () => {
    await store.setProfile({ ...store.profile, dateOfBirth: '1960-01-01' });
    expect(share({ kind: 'savings' }).share).toBe(1);
  });
});
