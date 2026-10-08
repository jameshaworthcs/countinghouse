// Behaviours fixed after reviewing the running app against demo data.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { estateOn } from '../src/server/analytics/estate';
import { investments, xirr } from '../src/server/analytics/investments';
import { hashPassword, verifyPassword } from '../src/server/auth';
import { GitCommitter } from '../src/server/git';
import { transactionId } from '../src/server/ids';
import { Store, type ChangeEvent } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { Categoriser } from '../src/shared/categorise';
import type { Account, BalanceSnapshot, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: transactionId(accountId, date, amount, description, n++),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  ...extra,
});
const bal = (accountId: string, date: string, balance: number, extra: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  id: `bal_${(n++).toString(16).padStart(16, '0')}`,
  accountId,
  date,
  balance,
  currency: 'GBP',
  kind: 'screenshot',
  source: {},
  createdAt: stamp,
  ...extra,
});

describe('estate value classification', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-reg-'));
    store = await Store.open(dir);
    await store.setAccounts([acct('current', 'current'), acct('card', 'credit_card')]);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('treats a card in credit as cash and an overdraft as a debt', async () => {
    await store.addBalances([bal('card', '2026-05-01', 25), bal('current', '2026-05-01', -300)], 'test');
    const e = estateOn(store, new BalanceEngine(store), '2026-05-02');
    expect(e.assets).toBe(25);
    expect(e.liabilities).toBe(-300);
    expect(e.wrapper.get('cash')).toBe(25);
    expect(e.wrapper.get('liabilities')).toBe(-300);
    expect(e.total).toBe(-275);
  });

  it('rolls a market account back from a nearby first valuation instead of starting from zero', async () => {
    await store.setAccounts([...store.accounts, acct('isa', 'stocks_isa')]);
    await store.addTransactions([tx('isa', '2026-03-28', 600, 'Regular contribution', { category: 'contribution' })], 'test');
    await store.addBalances([bal('isa', '2026-03-31', 19_000)], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('isa', '2026-03-28')!.value).toBe(19_000);
    expect(engine.balanceOn('isa', '2026-03-27')).toBeNull();
  });

  it('before its first valuation, an account whose data starts part-way through is rolled back, not grown from nothing', async () => {
    // Three payments in from October, then the first valuation in June: an export that starts with
    // money already in the account.
    const pays = (id: string) => ['2024-10-10', '2024-11-10', '2024-12-10'].map((d) => tx(id, d, 1_000, 'Monthly Subscription', { category: 'contribution' }));
    await store.setAccounts([...store.accounts, acct('late', 'stocks_isa'), { ...acct('opened', 'stocks_isa'), openedOn: '2024-10-01' }, acct('empty', 'stocks_isa')]);
    await store.addTransactions([...pays('late'), ...pays('opened'), ...pays('empty')], 'test');
    await store.addBalances([bal('late', '2025-06-01', 50_000), bal('opened', '2025-06-01', 50_000), bal('empty', '2025-06-01', 50_000), bal('empty', '2024-09-30', 0)], 'test');
    const engine = new BalanceEngine(store);
    // The valuation less what arrived since, as if nothing grew.
    expect(engine.balanceOn('late', '2024-10-10')).toEqual({ value: 48_000, gbp: 48_000, estimated: true, basis: { date: '2025-06-01', kind: 'screenshot', after: true } });
    expect(engine.balanceOn('late', '2025-01-31')!.value).toBe(50_000);
    expect(engine.balanceOn('late', '2024-10-09')).toBeNull();
    // The data goes back to the start, by the opening date or a nil valuation: it grew from what went in.
    for (const id of ['opened', 'empty']) {
      expect(engine.balanceOn(id, '2024-10-10')!.value).toBe(1_000);
      expect(engine.balanceOn(id, '2025-01-31')!.value).toBeLessThan(50_000);
    }
    expect(engine.balanceOn('opened', '2024-10-10')!.estimated).toBe(true);
  });

  it('never rolls an account back below nothing', async () => {
    await store.setAccounts([...store.accounts, acct('sipp', 'sipp')]);
    await store.addTransactions([tx('sipp', '2024-10-10', 100, 'Contribution', { category: 'contribution' }), tx('sipp', '2024-11-10', 5_000, 'Transfer in from another pension', { category: 'transfer' })], 'test');
    // The transfer lost a fifth before the first valuation.
    await store.addBalances([bal('sipp', '2025-06-01', 4_000)], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('sipp', '2024-10-10')!.value).toBe(0);
    expect(engine.balanceOn('sipp', '2024-11-10')!.value).toBe(4_000);
  });
});

describe('investment returns', () => {
  it('computes XIRR for a simple case', () => {
    const r = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 1100 },
    ]);
    expect(r).toBeCloseTo(0.1, 3);
  });

  it('includes money already invested before the first recorded contribution', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-reg-'));
    try {
      const store = await Store.open(dir);
      await store.setCategories(defaultCategories());
      await store.setAccounts([acct('isa', 'stocks_isa')]);
      await store.addBalances([bal('isa', '2025-09-30', 20_000, { contributions: 20_000 })], 'test');
      await store.addTransactions([tx('isa', '2026-03-31', 1_000, 'Contribution', { category: 'contribution' })], 'test');
      const today = new Date().toISOString().slice(0, 10);
      await store.addBalances([bal('isa', today, 22_000, { contributions: 21_000 })], 'test');
      const inv = investments(store, new BalanceEngine(store));
      const a = inv.accounts.find((x) => x.id === 'isa')!;
      expect(a.growth).toBe(1_000);
      expect(a.xirr).not.toBeNull();
      expect(a.xirr!).toBeLessThan(0.15);
      expect(a.xirr!).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('paid in and growth are only what is known', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-inv-'));
    store = await Store.open(dir);
    await store.setCategories(defaultCategories());
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('an account whose paid in is not known adds its value, not growth', async () => {
    await store.setAccounts([acct('isa', 'stocks_isa'), acct('lisa', 'lisa')]);
    await store.addBalances([bal('isa', '2026-09-29', 60_000, { kind: 'manual', approximate: true }), bal('lisa', '2026-06-30', 9_000, { contributions: 8_000 })], 'test');
    const inv = investments(store, new BalanceEngine(store));
    expect(inv.totals).toMatchObject({ value: 69_000, contributions: 8_000, growth: 1_000, growthPct: 0.125, paidInUnknown: 1 });
    expect(inv.accounts.find((a) => a.id === 'isa')).toMatchObject({ contributions: null, growth: null, estimated: true, xirr: null, history: [] });
  });

  it('contributions summed from transactions are paid in only when they go back to the start', async () => {
    await store.setAccounts([acct('late', 'stocks_isa'), { ...acct('opened', 'stocks_isa'), openedOn: '2026-01-05' }, acct('empty', 'stocks_isa')]);
    await store.addBalances([bal('late', '2025-10-31', 50_000), bal('empty', '2025-12-31', 0)], 'test');
    await store.addTransactions(
      ['late', 'opened', 'empty'].flatMap((id) => [tx(id, '2026-01-10', 500, 'Contribution', { category: 'contribution' }), tx(id, '2026-02-10', 500, 'Contribution', { category: 'contribution' })]),
      'test',
    );
    const inv = investments(store, new BalanceEngine(store));
    const paidIn = Object.fromEntries(inv.accounts.map((a) => [a.id, a.contributions]));
    // Years of an ISA before its first statement are not £1,000 paid in.
    expect(paidIn).toEqual({ late: null, opened: 1_000, empty: 1_000 });
  });

  it('a newer approximate figure neither hides the provider’s paid in nor sets the return', async () => {
    await store.setAccounts([acct('isa', 'stocks_isa')]);
    await store.addBalances([bal('isa', '2025-09-15', 80_000, { contributions: 75_000 }), bal('isa', '2026-09-15', 100_000, { contributions: 90_000 }), bal('isa', '2026-09-29', 110_000, { kind: 'manual', approximate: true })], 'test');
    const a = investments(store, new BalanceEngine(store)).accounts[0]!;
    expect(a).toMatchObject({ value: 110_000, estimated: true, contributions: 90_000, growth: 20_000 });
    // From the first valuation to the last real one: 80,000 to 100,000 in a year.
    expect(a.xirr!).toBeCloseTo(0.25, 2);
    expect(a.history.map((h) => h.value)).toEqual([80_000, 100_000]);
  });
});

describe('payees for generic merchant matches', () => {
  it('uses the cleaned description rather than a generic label', () => {
    const c = new Categoriser([], new CategoryIndex(defaultCategories()), [acct('current', 'current')], []);
    expect(c.categorise({ accountId: 'current', description: 'UNIQLO REGENT ST', amount: -40 })).toMatchObject({ category: 'clothing', payee: 'Uniqlo Regent St' });
    expect(c.categorise({ accountId: 'current', description: 'THE FALCON PUB', amount: -12 })).toMatchObject({ category: 'pubs-bars' });
    expect(c.categorise({ accountId: 'current', description: 'BARCLAYS BANK', amount: -12 }).category).not.toBe('pubs-bars');
  });
});

describe('password hashes', () => {
  it('round-trips and contains no shell or env-special characters', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('git auto-commit', () => {
  it('commits only the data directory, one commit per flush', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'finance-git-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      const store = await Store.open(path.join(repo, 'data'));
      const committer = await GitCommitter.create(path.join(repo, 'data'), () => true, 10);
      store.on('change', (e: ChangeEvent) => committer.queue(e));
      execFileSync('sh', ['-c', 'echo code > app.txt'], { cwd: repo });
      await committer.flush('data: initialise');
      await store.setAccounts([acct('current', 'current')], 'account: add current');
      await committer.flush();
      const log = git('log', '--format=%s');
      expect(log.trim().split('\n')).toEqual(['account: add current', 'data: initialise']);
      expect(git('status', '--porcelain')).toContain('?? app.txt');
      expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/accounts.json');
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
