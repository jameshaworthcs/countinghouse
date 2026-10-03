// Linked and closed accounts (docs/FORMULAS.md §9): what carried over when one account took over from
// another under the same number, and closed accounts that still held money. Every figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDetailResponse, DataHealthResponse } from '../src/shared/api';
import type { Account, Transaction } from '../src/shared/schema';
import { BalanceEngine } from '../src/server/analytics/balances';
import { closedHolding, handoverOf } from '../src/server/analytics/handover';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { transactionId } from '../src/server/ids';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, balanceAfter?: number): Transaction => ({
  id: transactionId(accountId, date, amount, description, n++),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  source: {},
  createdAt: stamp,
});

let app: App;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-handover-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(dir, 'no-web');
  app = await createApp(config, { version: 'test', env: {}, inbox: false });
  // A fixed rate that matured into easy access on 13 Sep 2025, under one number.
  await app.ctx.store.setAccounts([
    acct('fixed', 'savings', { name: 'Example Fixed', status: 'closed', openedOn: '2023-09-14', closedOn: '2025-09-12' }),
    acct('easy', 'savings', { name: 'Example Easy Access', openedOn: '2025-09-13', continues: { accountId: 'fixed', from: '2025-09-13' } }),
  ]);
  // The easy access starts with the fixed rate's money, and that day's interest on top.
  await app.ctx.store.addTransactions([tx('fixed', '2023-09-14', 20000, 'Deposit', 20000), tx('easy', '2025-09-13', 1200, 'Interest Added', 22200)], 't');
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const req = (p: string) => app.app.request(`http://localhost${p}`, { headers: { host: 'localhost' } });

describe('what carried over between linked accounts', () => {
  it('the start of a day is its close less the rows that count on it', () => {
    const engine = new BalanceEngine(app.ctx.store);
    expect(engine.openingOn('easy', '2025-09-13')?.value).toBe(21000);
    expect(engine.openingOn('fixed', '2023-09-14')?.value).toBe(0);
  });

  it('is unexplained when a year’s interest is missing on the older side, and adds up once it is there', async () => {
    const { store } = app.ctx;
    const h = handoverOf(store, new BalanceEngine(store), store.account('easy')!)!;
    expect(h).toMatchObject({ from: '2025-09-13', closing: 20000, opening: 21000, difference: 1000, status: 'unexplained' });
    await store.addTransactions([tx('fixed', '2024-09-13', 1000, 'Interest Added', 21000)], 't');
    expect(handoverOf(store, new BalanceEngine(store), store.account('easy')!)).toMatchObject({ closing: 21000, opening: 21000, difference: 0, status: 'adds-up', estimated: false });
  });

  it('is not checked for valued accounts, or with no balance on a side', async () => {
    const { store } = app.ctx;
    await store.setAccounts([acct('old-isa', 'stocks_isa', { status: 'closed', closedOn: '2025-04-05' }), acct('new-isa', 'stocks_isa', { continues: { accountId: 'old-isa', from: '2025-04-06' } }), acct('blank', 'savings', { status: 'closed', closedOn: '2025-01-31' }), acct('next', 'savings', { continues: { accountId: 'blank', from: '2025-02-01' } })]);
    const engine = new BalanceEngine(store);
    expect(handoverOf(store, engine, store.account('new-isa')!)).toMatchObject({ status: 'unknown', closing: null, opening: null, valued: true });
    expect(handoverOf(store, engine, store.account('next')!)).toMatchObject({ status: 'unknown', closing: null, opening: null });
    expect(handoverOf(store, engine, store.account('next')!)).not.toHaveProperty('valued');
  });
});

describe('closed accounts that still held money', () => {
  it('are listed when nothing carries them on and the money did not leave', async () => {
    const { store } = app.ctx;
    // The fixed rate is carried on by the easy access: its money is accounted for there.
    expect(closedHolding(store, new BalanceEngine(store))).toEqual([]);
    await store.setAccounts([
      acct('gone', 'savings', { name: 'Old saver', status: 'closed', openedOn: '2024-01-01', closedOn: '2025-06-30' }),
      acct('emptied', 'savings', { status: 'closed', openedOn: '2024-01-01', closedOn: '2025-06-30' }),
      acct('card', 'credit_card', { status: 'closed', openedOn: '2024-01-01', closedOn: '2025-06-30' }),
    ]);
    await store.addTransactions([tx('gone', '2024-01-02', 500, 'Deposit', 500), tx('emptied', '2024-01-02', 500, 'Deposit', 500), tx('emptied', '2025-06-30', -500, 'Closing payment', 0), tx('card', '2025-05-01', -42, 'Shop', -42)], 't');
    expect(closedHolding(store, new BalanceEngine(store))).toEqual([
      { accountId: 'gone', name: 'Old saver', closedOn: '2025-06-30', balance: 500, estimated: false },
      { accountId: 'card', name: 'card', closedOn: '2025-06-30', balance: -42, estimated: false },
    ]);
  });
});

describe('where they are shown', () => {
  it('Data health lists each link with what carried over, and both account pages show it', async () => {
    const health = (await (await req('/api/data-health')).json()) as DataHealthResponse;
    expect(health.handovers).toEqual([expect.objectContaining({ older: { accountId: 'fixed', name: 'Example Fixed' }, newer: { accountId: 'easy', name: 'Example Easy Access' }, status: 'unexplained', difference: 1000 })]);
    expect(health.closedHolding).toEqual([]);
    const easy = (await (await req('/api/accounts/easy')).json()) as AccountDetailResponse;
    expect(easy.links?.carriesOnFrom).toMatchObject({ from: '2025-09-13', older: { accountId: 'fixed' } });
    expect(easy.links?.carriedOnAs).toBeUndefined();
    const fixed = (await (await req('/api/accounts/fixed')).json()) as AccountDetailResponse;
    expect(fixed.links?.carriedOnAs).toMatchObject({ newer: { accountId: 'easy' } });
  });
});
