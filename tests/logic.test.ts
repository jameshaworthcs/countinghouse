import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances } from '../src/server/analytics/allowances';
import { BalanceEngine } from '../src/server/analytics/balances';
import { cashflow } from '../src/server/analytics/cashflow';
import { detectRecurring } from '../src/server/analytics/recurring';
import { enrich } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { classifyDuplicates } from '../src/server/ingest/dedup';
import { matchAccount } from '../src/server/ingest/match';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { addDays } from '../src/shared/dates';
import { Categoriser } from '../src/shared/categorise';
import { cleanPayee, matchMerchant } from '../src/shared/merchants';
import type { Account, Rule, Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({
  id,
  name: id,
  type,
  currency: 'GBP',
  status: 'open',
  aliases: [],
  includeInNetWorth: true,
  createdAt: stamp,
  updatedAt: stamp,
  ...extra,
});
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: transactionId(accountId, date, amount, description, seq++),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  ...extra,
});

describe('merchants and categorisation', () => {
  it('recognises UK merchants, direction-aware', () => {
    expect(matchMerchant('CARD PAYMENT TO TESCO STORES 2231 ON 12/09', -12)).toMatchObject({ payee: 'Tesco', category: 'groceries' });
    expect(matchMerchant('TESCO PFS 1234', -40)).toMatchObject({ category: 'fuel' });
    expect(matchMerchant('HMRC SELF ASSESSMENT', -500)).toMatchObject({ category: 'tax' });
    expect(matchMerchant('HMRC', 120)).toMatchObject({ category: 'tax-refund' });
    expect(matchMerchant('UBER *EATS', -20)).toMatchObject({ category: 'takeaway' });
    expect(matchMerchant('UBER *TRIP', -9)).toMatchObject({ category: 'taxis' });
    expect(matchMerchant('BOOKING.COM HOTEL', -200)).toMatchObject({ category: 'accommodation' });
    expect(matchMerchant('CAFÉ DE FLORE', -10)).toBeUndefined();
    expect(matchMerchant('LEON SMITH', -10)?.category).toBe('eating-out'); // known limitation: first names collide
  });

  it('cleans payees', () => {
    expect(cleanPayee('CARD PAYMENT TO SQ *THE COFFEE ROOM ON 12/09 LONDON GB')).toBe('The Coffee Room');
    expect(cleanPayee('DIRECT DEBIT PAYMENT TO BRITISH GAS REF 1234567')).toBe('British Gas');
    expect(cleanPayee('TFL TRAVEL CH')).toBe('TFL Travel Ch');
    expect(cleanPayee('ACME LTD')).toBe('Acme Ltd');
  });

  it('applies precedence: rule > own transfer > wrapper flows > merchant > bank > ai', () => {
    const accounts = [
      acct('monzo', 'current', { institutionId: 'monzo' }),
      acct('vanguard-isa', 'stocks_isa', { institutionId: 'vanguard' }),
      acct('amex', 'credit_card', { institutionId: 'amex' }),
      acct('sipp', 'sipp', { institutionId: 'aj-bell' }),
    ];
    const rules: Rule[] = [
      {
        id: 'rule_a',
        enabled: true,
        priority: 10,
        match: { field: 'description', op: 'contains', value: 'tesco', caseSensitive: false },
        set: { category: 'home-garden', payee: 'Tesco (house)' },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];
    const c = new Categoriser(rules, new CategoryIndex(defaultCategories()), accounts, []);
    expect(c.categorise({ accountId: 'monzo', description: 'TESCO STORES', amount: -5 })).toMatchObject({ category: 'home-garden', categorisedBy: 'rule', ruleId: 'rule_a' });
    expect(c.categorise({ accountId: 'monzo', description: 'VANGUARD INVESTOR', amount: -500 })).toMatchObject({ category: 'investment-transfer', counterpartyAccountId: 'vanguard-isa' });
    expect(c.categorise({ accountId: 'monzo', description: 'AMERICAN EXPRESS', amount: -300 })).toMatchObject({ category: 'credit-card-payment', counterpartyAccountId: 'amex' });
    expect(c.categorise({ accountId: 'sipp', description: 'Tax relief received', amount: 200 })).toMatchObject({ category: 'tax-relief' });
    expect(c.categorise({ accountId: 'vanguard-isa', description: 'Vanguard LifeStrategy 80% purchase', amount: -500 })).toMatchObject({ category: 'trade' });
    expect(c.categorise({ accountId: 'monzo', description: 'ACME LTD SALARY', amount: 2000, payee: 'ACME LTD' })).toMatchObject({ category: 'salary', payee: 'ACME LTD' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, bankCategory: 'groceries' })).toMatchObject({ category: 'groceries', categorisedBy: 'bank' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, aiCategory: 'pets' })).toMatchObject({ category: 'pets', categorisedBy: 'ai' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, aiCategory: 'not-a-category' }).category).toBeUndefined();
  });
});

describe('duplicate detection', () => {
  const existing = [
    tx('a', '2026-09-01', -3, 'PRET A MANGER'),
    tx('a', '2026-09-01', -3, 'PRET A MANGER'),
    tx('a', '2026-09-02', -20, 'AMAZON MKTPLACE PMTS', { sourceId: 'X1' }),
    tx('a', '2026-09-05', -45.5, 'TESCO STORES 3297 LONDON'),
  ];

  it('matches exact rows as a multiset', () => {
    const res = classifyDuplicates(
      [
        { date: '2026-09-01', amount: -3, description: 'PRET A MANGER' },
        { date: '2026-09-01', amount: -3, description: 'PRET A MANGER' },
        { date: '2026-09-01', amount: -3, description: 'PRET A MANGER' },
      ],
      existing,
    );
    expect(res.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'new']);
  });

  it('uses bank ids and fuzzy matching', () => {
    const res = classifyDuplicates(
      [
        { date: '2026-09-03', amount: -20, description: 'Amazon', sourceId: 'X1' },
        { date: '2026-09-06', amount: -45.5, description: 'Tesco Stores' },
        { date: '2026-09-06', amount: -45.5, description: 'Sainsburys' },
      ],
      existing,
    );
    expect(res.map((r) => r.status)).toEqual(['duplicate', 'possible_duplicate', 'new']);
  });

  it('never merges rows with different bank ids', () => {
    const res = classifyDuplicates([{ date: '2026-09-02', amount: -20, description: 'AMAZON MKTPLACE PMTS', sourceId: 'X2' }], existing);
    expect(res[0]!.status).toBe('new');
  });
});

describe('account matching', () => {
  const accounts = [acct('monzo-current', 'current', { institutionId: 'monzo', last4: '1234' }), acct('vanguard-isa', 'stocks_isa', { institutionId: 'vanguard' })];
  it('matches on institution, type and last 4 digits', () => {
    expect(matchAccount({ institutionName: 'Monzo Bank', accountType: 'current', last4: '1234' }, accounts, []).accountId).toBe('monzo-current');
    expect(matchAccount({ institutionName: 'Vanguard', accountType: 'stocks_isa' }, accounts, []).accountId).toBe('vanguard-isa');
    expect(matchAccount({ institutionName: 'Monzo', accountType: 'current', last4: '9999' }, accounts, []).accountId).toBeUndefined();
    expect(matchAccount({}, accounts, [], 'vanguard-isa').accountId).toBe('vanguard-isa');
  });

  it('counts being your only account of a type as evidence, never as enough on its own', () => {
    const mine = [...accounts, acct('lisa', 'lisa', { institutionId: 'moneybox' }), acct('saver-a', 'savings', { last4: '7733' }), acct('saver-b', 'savings')];
    // An app screenshot that names no provider: the type and product name point at your only LISA.
    expect(matchAccount({ accountType: 'lisa', accountName: 'Lifetime ISA' }, [...mine.slice(0, 2), { ...mine[2]!, name: 'Moneybox Lifetime ISA' }], []).accountId).toBe('lisa');
    // The type alone is only a suggestion to confirm.
    const typeOnly = matchAccount({ accountType: 'lisa' }, mine, []);
    expect(typeOnly.score).toBeLessThan(50);
    // With two accounts of the type, no bonus; a different number rules an account out.
    expect(matchAccount({ accountType: 'savings', last4: '3310' }, mine, []).accountId).toBeUndefined();
  });

  it('a closed account still takes its old statements, but an open one wins a tie', () => {
    const closed = acct('old-lloyds', 'current', { institutionId: 'lloyds', last4: '2201', status: 'closed', closedOn: '2026-03-03' });
    const open = acct('lloyds', 'current', { institutionId: 'lloyds' });
    expect(matchAccount({ institutionName: 'Lloyds Bank', accountType: 'current', last4: '2201' }, [open, closed], []).accountId).toBe('old-lloyds');
    expect(matchAccount({ institutionName: 'Lloyds Bank', accountType: 'current' }, [open, { ...closed, last4: undefined }] as Account[], []).accountId).toBe('lloyds');
  });
});

describe('store, balances and analytics', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-test-'));
    store = await Store.open(dir);
    await store.setAccounts([acct('current', 'current', { institutionId: 'monzo' }), acct('isa', 'stocks_isa'), acct('savings', 'savings', { institutionId: 'marcus' })]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('rolls ledger balances forwards and backwards from anchors', async () => {
    await store.addTransactions(
      [
        tx('current', '2026-09-01', -10, 'A'),
        tx('current', '2026-09-02', -20, 'B', { balanceAfter: 970 }),
        tx('current', '2026-09-10', 500, 'C'),
      ],
      'test',
    );
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('current', '2026-08-31')).toBeNull();
    expect(engine.balanceOn('current', '2026-09-01')!.value).toBe(990);
    expect(engine.balanceOn('current', '2026-09-02')!.value).toBe(970);
    expect(engine.balanceOn('current', '2026-09-15')!.value).toBe(1470);
    expect(engine.gaps('current')).toEqual([]);
  });

  it('reports statement gaps between inconsistent anchors', async () => {
    await store.addTransactions([tx('current', '2026-09-01', -10, 'A', { balanceAfter: 90 }), tx('current', '2026-09-20', -10, 'B', { balanceAfter: 50 })], 'test');
    expect(new BalanceEngine(store).gaps('current')).toEqual([{ from: '2026-09-01', to: '2026-09-20', difference: -30 }]);
  });

  it('values market accounts from valuations plus contributions', async () => {
    await store.addBalances([{ id: 'bal_0000000000000001', accountId: 'isa', date: '2026-06-30', balance: 10_000, currency: 'GBP', kind: 'screenshot', source: {}, createdAt: stamp }], 'test');
    await store.addTransactions([tx('isa', '2026-07-15', 500, 'Contribution', { category: 'contribution' }), tx('isa', '2026-07-20', -4, 'Platform fee', { category: 'investment-fee' })], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('isa', '2026-07-01')!.value).toBe(10_000);
    expect(engine.balanceOn('isa', '2026-08-01')!.value).toBe(10_500);
  });

  it('an approximate figure stands in only for what is newer than the real data', async () => {
    const snap = (id: string, accountId: string, date: string, balance: number, extra: object = {}) => ({ id, accountId, date, balance, currency: 'GBP', kind: 'manual' as const, source: {}, createdAt: stamp, ...extra });
    // On its own: it is the value, marked estimated, and not counted as data.
    await store.addBalances([snap('bal_00000000000000f1', 'isa', '2026-09-29', 110_000, { approximate: true })], 'test');
    let engine = new BalanceEngine(store);
    expect(engine.balanceOn('isa', '2026-09-29')).toMatchObject({ value: 110_000, estimated: true });
    expect(engine.lastDataDate('isa')).toBeNull();
    // An older real valuation shapes history; the newer approximate figure is still today's value.
    await store.addBalances([snap('bal_00000000000000f2', 'isa', '2026-04-22', 104_200, { kind: 'statement' })], 'test');
    engine = new BalanceEngine(store);
    expect(engine.balanceOn('isa', '2026-05-01')).toMatchObject({ value: 104_200, estimated: false });
    expect(engine.balanceOn('isa', '2026-09-29')).toMatchObject({ value: 110_000, estimated: true });
    // A real valuation newer than it replaces it.
    await store.addBalances([snap('bal_00000000000000f3', 'isa', '2026-10-05', 111_050.4, { kind: 'screenshot' })], 'test');
    engine = new BalanceEngine(store);
    expect(engine.balanceOn('isa', '2026-09-29')).toMatchObject({ value: 104_200, estimated: false });
    // On a ledger account it never shows as an unexplained gap.
    await store.addTransactions([tx('current', '2026-09-10', -40, 'SHOP')], 'test');
    await store.addBalances([snap('bal_00000000000000f4', 'current', '2026-09-01', 1000, { kind: 'statement' }), snap('bal_00000000000000f5', 'current', '2026-09-29', 1500, { approximate: true })], 'test');
    engine = new BalanceEngine(store);
    expect(engine.gaps('current')).toEqual([]);
    expect(engine.balanceOn('current', '2026-09-29')).toMatchObject({ value: 1500, estimated: true });
  });

  it('keeps invalid lines verbatim and reloads external edits', async () => {
    const file = path.join(dir, 'transactions/current/2026.jsonl');
    await store.addTransactions([tx('current', '2026-09-01', -10, 'A')], 'test');
    await writeFile(file, `${await readFile(file, 'utf8')}{"id":"broken"}\n`);
    await store.load();
    expect(store.issues.some((i) => i.file.startsWith('transactions/current/2026.jsonl'))).toBe(true);
    await store.addTransactions([tx('current', '2026-09-02', -5, 'B')], 'test');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('{"id":"broken"}');
    expect(store.transactions('current')).toHaveLength(2);
  });

  it('computes cash flow excluding transfers, with refunds reducing spending', async () => {
    await store.setCategories(defaultCategories());
    await store.addTransactions(
      [
        tx('current', '2026-09-01', 2000, 'SALARY', { category: 'salary' }),
        tx('current', '2026-09-02', -100, 'TESCO', { category: 'groceries' }),
        tx('current', '2026-09-03', 20, 'TESCO REFUND', { category: 'refunds' }),
        tx('current', '2026-09-04', -500, 'TO SAVINGS', { category: 'savings-transfer' }),
      ],
      'test',
    );
    const cf = cashflow(store, '2026-09-01', '2026-09-30');
    expect(cf.totals).toMatchObject({ income: 2000, spending: 80, net: 1920 });
  });

  it('links transfers between own accounts on enrich', async () => {
    await store.setCategories(defaultCategories());
    await store.addTransactions([tx('current', '2026-09-05', -300, 'MARCUS SAVINGS'), tx('savings', '2026-09-06', 300, 'DEPOSIT FROM MONZO')], 'test');
    const res = await enrich(store);
    expect(res.transfersLinked).toBe(1);
    const [a] = store.transactions('current');
    const [b] = store.transactions('savings');
    expect(a!.transferGroup).toBe(b!.transferGroup);
    expect(a!.category).toBe('savings-transfer');
    expect(a!.counterpartyAccountId).toBe('savings');
  });

  it('detects monthly subscriptions and price rises', async () => {
    await store.setCategories(defaultCategories());
    const dates = ['2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'];
    await store.addTransactions(
      dates.map((d, i) => tx('current', d, i < 3 ? -10.99 : -12.99, 'NETFLIX.COM', { payee: 'Netflix', category: 'streaming' })),
      'test',
    );
    const [sub] = detectRecurring(store, '2026-09-20');
    expect(sub).toMatchObject({ payee: 'Netflix', cadence: 'monthly', typicalAmount: 12.99, active: true });
    expect(sub!.priceChange).toMatchObject({ from: 10.99, to: 12.99 });
  });

  it('follows a subscription moved to another account, and keeps concurrent ones apart', async () => {
    await store.setCategories(defaultCategories());
    await store.setAccounts([...store.accounts, acct('card', 'credit_card')]);
    // Spotify: two payments from the current account, then three from the card. Neither run alone
    // has the three payments a subscription needs.
    const spotify = [
      ['current', '2026-05-03'],
      ['current', '2026-06-03'],
      ['card', '2026-07-03'],
      ['card', '2026-08-03'],
      ['card', '2026-09-03'],
    ] as const;
    // A gym paid monthly from both accounts at once: two memberships, not one fortnightly payment.
    const gym = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].flatMap((d) => [
      tx('current', d, -30, 'PUREGYM', { payee: 'PureGym', category: 'fitness' }),
      tx('card', addDays(d, 14), -30, 'PUREGYM', { payee: 'PureGym', category: 'fitness' }),
    ]);
    await store.addTransactions([...spotify.map(([a, d]) => tx(a, d, -11.99, 'SPOTIFY', { payee: 'Spotify', category: 'streaming' })), ...gym], 'test');
    const found = detectRecurring(store, '2026-09-20');
    const music = found.filter((r) => r.payee === 'Spotify');
    expect(music).toHaveLength(1);
    expect(music[0]).toMatchObject({ cadence: 'monthly', count: 5, accountId: 'card', active: true });
    const gyms = found.filter((r) => r.payee === 'PureGym');
    expect(gyms.map((g) => [g.accountId, g.cadence]).sort()).toEqual([
      ['card', 'monthly'],
      ['current', 'monthly'],
    ]);
  });

  it('counts ISA subscriptions, provider figures and one-sided transfers', async () => {
    await store.setCategories(defaultCategories());
    await store.setAccounts([...store.accounts, acct('lisa', 'lisa'), acct('cash-isa', 'cash_isa')]);
    await store.addTransactions(
      [
        tx('isa', '2026-05-01', 5000, 'Subscription', { category: 'contribution' }),
        tx('isa', '2026-03-01', 9999, 'Previous tax year', { category: 'contribution' }),
        tx('current', '2026-06-01', -3000, 'TO CASH ISA', { category: 'savings-transfer', counterpartyAccountId: 'cash-isa' }),
      ],
      'test',
    );
    await store.addBalances([{ id: 'bal_0000000000000002', accountId: 'lisa', date: '2026-09-01', balance: 5000, currency: 'GBP', kind: 'screenshot', taxYearContributions: 2000, taxYear: '2026/27', source: {}, createdAt: stamp }], 'test');
    const a = allowances(store, '2026/27', '2026-09-29');
    expect(a.isa.used).toBe(10_000);
    expect(a.isa.remaining).toBe(10_000);
    expect(a.isa.cashUsed).toBe(3000);
    expect(a.lisa).toMatchObject({ contributed: 2000, remaining: 2000, bonusExpected: 500 });
  });
});
