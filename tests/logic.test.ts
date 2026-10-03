import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances } from '../src/server/analytics/allowances';
import { BalanceEngine } from '../src/server/analytics/balances';
import { cashflow } from '../src/server/analytics/cashflow';
import { detectRecurring } from '../src/server/analytics/recurring';
import { categoriseInvestmentRows, enrich } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { classifyDuplicates } from '../src/server/ingest/dedup';
import { matchAccount } from '../src/server/ingest/match';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { addDays } from '../src/shared/dates';
import { Categoriser } from '../src/shared/categorise';
import { cleanPayee, matchMerchant } from '../src/shared/merchants';
import type { Account, Figure, Rule, Transaction } from '../src/shared/schema';

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

  it('knows a brand however a card spaces it, and Kraken by its company', () => {
    expect(matchMerchant('SPORTSDIRECT 164 01234567890', -48.99)).toMatchObject({ category: 'clothing' });
    expect(matchMerchant('Lasiguanas York', -30.74)).toMatchObject({ category: 'eating-out' });
    expect(matchMerchant('FASTER PAYMENT TO PAYWARD SERVICES LTD', -100)).toMatchObject({ payee: 'Kraken', category: 'investment-transfer' });
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
    // Chase's words for paying its card: the statement and app, and the export.
    expect(c.categorise({ accountId: 'monzo', description: 'To Credit Card', amount: -112.5 }).category).toBe('credit-card-payment');
    expect(c.categorise({ accountId: 'monzo', description: "Sam's Account to Credit card", amount: -112.5 }).category).toBe('credit-card-payment');
    expect(c.categorise({ accountId: 'monzo', description: 'To Revolving Line Account', amount: -112.5 }).category).toBe('credit-card-payment');
    expect(c.categorise({ accountId: 'sipp', description: 'Tax relief received', amount: 200 })).toMatchObject({ category: 'tax-relief' });
    expect(c.categorise({ accountId: 'vanguard-isa', description: 'Vanguard LifeStrategy 80% purchase', amount: -500 })).toMatchObject({ category: 'trade' });
    expect(c.categorise({ accountId: 'monzo', description: 'ACME LTD SALARY', amount: 2000, payee: 'ACME LTD' })).toMatchObject({ category: 'salary', payee: 'ACME LTD' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, bankCategory: 'groceries' })).toMatchObject({ category: 'groceries', categorisedBy: 'bank' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, aiCategory: 'pets' })).toMatchObject({ category: 'pets', categorisedBy: 'ai' });
    expect(c.categorise({ accountId: 'monzo', description: 'MYSTERY', amount: -5, aiCategory: 'not-a-category' }).category).toBeUndefined();
  });

  it('reads interactive investor’s wording: a settlement date is a trade, "Div" a dividend, each named after the investment', () => {
    const c = new Categoriser([], new CategoryIndex(defaultCategories()), [acct('current', 'current'), acct('ii-isa', 'stocks_isa', { institutionId: 'interactive-investor' })], []);
    const isa = (description: string, amount: number, extra: { payee?: string } = {}) => c.categorise({ accountId: 'ii-isa', description, amount, ...extra });
    expect(isa('12 VANGUARD FTSE GLOB  Del   105.20 S Date 03/02/25', -1262.4)).toMatchObject({ category: 'trade', payee: 'VANGUARD FTSE GLOB', categorisedBy: 'builtin' });
    expect(isa('3.5 LIFESTRATEGY 60  Del   250.00 S Date 3/2/2025', -875)).toMatchObject({ category: 'trade', payee: 'LIFESTRATEGY 60' });
    // Selling an income fund is a trade, not investment income.
    expect(isa('40 ABC EQUITY INCOME  Rec   2.50 S Date 04/03/25', 100)).toMatchObject({ category: 'trade', payee: 'ABC EQUITY INCOME' });
    expect(isa('Div 250   VANGUARD FUNDS PLC   FTSE ALL WLD UCITS ETF', 45.5)).toMatchObject({ category: 'investment-income', payee: 'VANGUARD FUNDS PLC FTSE ALL WLD UCITS ETF' });
    expect(isa('Div 250   VANGUARD FUNDS PLC', 45.5, { payee: 'Vanguard' }).payee).toBe('Vanguard');
    // An employer's payments into a pension, regular ("(E)") or one-off: no tax relief follows them.
    const sipp = new Categoriser([], new CategoryIndex(defaultCategories()), [acct('ii-sipp', 'sipp', { institutionId: 'interactive-investor' })], []);
    expect(sipp.categorise({ accountId: 'ii-sipp', description: 'Reg Contribution (E)', amount: 250 }).category).toBe('employer-contribution');
    expect(sipp.categorise({ accountId: 'ii-sipp', description: 'Employer Bank Credit Contribution', amount: 1000 }).category).toBe('employer-contribution');
    expect(sipp.categorise({ accountId: 'ii-sipp', description: 'Reg Contribution', amount: 250 }).category).toBe('contribution');
    // The rest of ii's wording as before.
    expect(isa('GROSS INTEREST', 0.8)).toMatchObject({ category: 'investment-income', payee: 'Gross Interest' });
    expect(isa('Monthly Subscription', 500).category).toBe('contribution');
    expect(isa('DIVERSIFIED GROWTH FUND', 10).category).toBeUndefined();
    // Outside an investment account neither wording means anything.
    expect(c.categorise({ accountId: 'current', description: 'Div 250 VANGUARD FUNDS PLC', amount: 45.5 }).category).not.toBe('investment-income');
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

  it('a letter confirming a deposit made in two payments is the same money', () => {
    const saved = [tx('s', '2024-02-02', 400, 'Faster Payment Posted: 01/02/2024'), tx('s', '2024-02-02', 10100.5, 'Faster Payment'), tx('s', '2024-02-08', 250, 'Faster Payment')];
    const letter = [{ date: '2024-02-01', amount: 10500.5, description: 'Confirmation of deposit to your savings account' }];
    const [res] = classifyDuplicates(letter, saved, 3, { sums: true });
    expect(res).toMatchObject({ status: 'possible_duplicate', duplicateOf: saved[0]!.id, reason: 'The same money as 2 payments recorded within a few days: £400.00 + £10,100.50' });
    // A statement lists each payment, so its rows are never sums of others.
    expect(classifyDuplicates(letter, saved)[0]!.status).toBe('new');
    // Nor do rows a week away, or the other way, add up to it.
    expect(classifyDuplicates([{ date: '2024-02-12', amount: 10500.5, description: 'Deposit' }], saved, 3, { sums: true })[0]!.status).toBe('new');
    expect(classifyDuplicates([{ date: '2024-02-01', amount: -10500.5, description: 'Withdrawal' }], saved, 3, { sums: true })[0]!.status).toBe('new');
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

  it('another product at the same provider is not enough: a named product must share a word', () => {
    const bond = acct('bond', 'savings', { name: 'Fixed Rate Bond 2 Year', institutionId: 'lloyds' });
    const saver = acct('saver', 'savings', { name: 'Everyday Saver', institutionId: 'monzo' });
    const letter = { institutionName: 'Lloyds Bank', accountType: 'savings' as const, accountName: 'Easy Access Issue 7' };
    // Open, your only saver at the provider: still a suggestion to confirm, not a match.
    expect(matchAccount(letter, [bond], []).score).toBeLessThan(50);
    // Closed, it does not borrow "your only saver" from the open one.
    const closed = matchAccount(letter, [{ ...bond, status: 'closed', closedOn: '2026-02-28' }, saver], []);
    expect(closed.score).toBeLessThan(50);
    expect(closed.reason).not.toMatch(/your only/);
    // The bond's own letter still matches it.
    expect(matchAccount({ ...letter, accountName: '2 Year Fixed Rate Bond' }, [bond, saver], []).accountId).toBe('bond');
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

  it('keeps your balance over a screenshot of the same day, and says what is unexplained around a day', async () => {
    const bal = (id: string, date: string, balance: number, kind: 'statement' | 'manual' | 'screenshot') => ({ id, accountId: 'current', date, balance, currency: 'GBP', kind, source: {}, createdAt: stamp });
    await store.addTransactions([tx('current', '2026-09-03', 1, 'EXAMPLE PAYER'), tx('current', '2026-09-03', 1, 'Holiday'), tx('current', '2026-09-04', -3, 'EXAMPLE SHOP')], 'test');
    // Your £0 and then a screenshot's £0, both on 30 Sep: the screenshot does not hide yours.
    await store.addBalances([bal('bal_00000000000000b1', '2026-08-31', 2, 'statement'), bal('bal_00000000000000b2', '2026-09-30', 0, 'manual'), bal('bal_00000000000000b3', '2026-09-30', 0, 'screenshot')], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.gaps('current')).toEqual([{ from: '2026-08-31', to: '2026-09-30', difference: -1 }]);
    expect(engine.between('current', '2026-09-03')).toEqual({ from: { date: '2026-08-31', balance: 2 }, to: { date: '2026-09-30', balance: 0 }, difference: -1 });
    expect(engine.between('current', '2026-08-31')).toBeNull();
    expect(engine.between('current', '2026-10-01')).toBeNull();
  });

  it('closes a day where its printed balances end, whatever order two statements stored its rows in', async () => {
    // Two exports overlap on 30 Sep: the later one (stored first) has the day's last payment, the
    // earlier one its first. Stored order puts the first payment last: the day still closes at 495.
    await store.addTransactions([tx('current', '2026-09-29', -5, 'SHOP A', { balanceAfter: 500 })], 'test');
    await store.addTransactions([tx('current', '2026-09-30', -1.5, 'CAFE B', { balanceAfter: 495 }), tx('current', '2026-10-02', -2, 'SHOP C', { balanceAfter: 493 })], 'later export');
    await store.addTransactions([tx('current', '2026-09-30', -3.5, 'SHOP C', { balanceAfter: 496.5 })], 'earlier export');
    const engine = new BalanceEngine(store);
    expect(engine.gaps('current')).toEqual([]);
    expect(engine.balanceOn('current', '2026-09-30')!.value).toBe(495);
    // A real gap is still found.
    await store.addTransactions([tx('current', '2026-10-05', -1, 'SHOP A', { balanceAfter: 480 })], 'test');
    expect(new BalanceEngine(store).gaps('current')).toEqual([{ from: '2026-10-02', to: '2026-10-05', difference: -12 }]);
  });

  it('counts a payment printed on the next statement after the close it missed', async () => {
    await store.setAccounts([...store.accounts, acct('card', 'credit_card')]);
    const on = (importId: string) => ({ source: { importId } });
    const close = (id: string, importId: string, date: string, balance: number) => ({ id, accountId: 'card', date, balance, currency: 'GBP', kind: 'statement' as const, ...on(importId), createdAt: stamp });
    const [a, b, c] = ['imp_20260303_000000_aaaa', 'imp_20260403_000000_bbbb', 'imp_20260502_000000_cccc'];
    await store.addTransactions(
      [
        tx('card', '2026-02-10', -100, 'SHOP A', on(a)),
        // Made two days before A closed and on the day B closed, but printed on the next statement.
        tx('card', '2026-03-01', -5, 'CAFE B', on(b)),
        tx('card', '2026-03-20', 100, 'PAYMENT RECEIVED', on(b)),
        tx('card', '2026-04-03', -10, 'SHOP C', on(b)),
        tx('card', '2026-04-03', -6.41, 'CAFE D', on(c)),
        tx('card', '2026-04-20', -50, 'SHOP E', on(c)),
      ],
      'test',
    );
    await store.addBalances([close('bal_00000000000000a1', a, '2026-03-03', -100), close('bal_00000000000000a2', b, '2026-04-03', -15), close('bal_00000000000000a3', c, '2026-05-02', -71.41)], 'test');
    let engine = new BalanceEngine(store);
    expect(engine.gaps('card')).toEqual([]);
    // Each closing day's balance is the statement's.
    expect(engine.balanceOn('card', '2026-03-03')!.value).toBe(-100);
    expect(engine.balanceOn('card', '2026-04-03')!.value).toBe(-15);
    expect(engine.balanceOn('card', '2026-04-04')!.value).toBe(-21.41);

    // A document whose rows reach weeks before the previous close covers several periods: its rows
    // keep their dates, so what the statements do not explain still shows.
    const d = 'imp_20260630_000000_dddd';
    await store.addTransactions([tx('card', '2026-04-10', -20, 'SHOP F', on(d)), tx('card', '2026-06-15', -10, 'SHOP G', on(d))], 'test');
    await store.addBalances([close('bal_00000000000000a4', d, '2026-06-30', -81.41)], 'test');
    engine = new BalanceEngine(store);
    expect(engine.gaps('card')).toEqual([{ from: '2026-04-03', to: '2026-05-02', difference: 20 }]);
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

  it('works out the tax band from P60s, salary, net pay, interest and dividends', async () => {
    await store.setCategories(defaultCategories());
    const fig = (id: string, kind: Figure['kind'], amount: number, taxYear: string): Figure => ({ id: `fig_${id.padStart(16, '0')}`, kind, label: kind, amount, currency: 'GBP', taxYear, source: {}, createdAt: stamp });
    // Nothing known: only what is found counts, as a minimum.
    let a = allowances(store, '2026/27', '2026-09-29');
    expect(a.taxBand).toMatchObject({ band: 'none', basis: 'minimum' });
    expect(a.savings.allowance).toBe(1_000);
    // Net pay received is a floor.
    await store.addTransactions([tx('current', '2026-05-28', 2500, 'ACME PAYROLL', { category: 'salary' })], 'test');
    expect(allowances(store, '2026/27', '2026-09-29').taxBand).toMatchObject({ band: 'none', basis: 'minimum', total: 2500 });
    // Last year's P60 stands in for the year in progress…
    await store.addFigures([fig('1', 'gross_pay', 30_000, '2025/26')], 'test');
    a = allowances(store, '2026/27', '2026-09-29');
    expect(a.taxBand).toMatchObject({ band: 'basic', basis: 'estimate' });
    expect(allowances(store, '2025/26', '2026-09-29').taxBand).toMatchObject({ band: 'basic', basis: 'documents' });
    // …your salary in Settings is preferred over it…
    await store.setProfile({ ...store.profile, grossSalary: 52_000 });
    expect(allowances(store, '2026/27', '2026-09-29').taxBand).toMatchObject({ band: 'higher', basis: 'estimate' });
    // …a payslip's pay to date below it does not replace it…
    await store.addFigures([fig('4', 'gross_pay', 20_000, '2026/27')], 'test');
    expect(allowances(store, '2026/27', '2026-09-29').taxBand).toMatchObject({ band: 'higher', basis: 'estimate' });
    await store.setProfile({ ...store.profile, grossSalary: undefined });
    // …and this year's own P60 or payslip figures settle it, with interest and dividends on top.
    await store.addFigures([fig('2', 'gross_pay', 25_000, '2026/27'), fig('3', 'dividends_paid', 6_000, '2026/27')], 'test');
    a = allowances(store, '2026/27', '2026-09-29');
    expect(a.taxBand).toMatchObject({ band: 'higher', basis: 'documents', total: 51_000 });
    expect(a.savings).toMatchObject({ band: 'higher', bandBasis: 'documents', allowance: 500 });
    // A past year with no P60 and no pay found is not estimated from today's salary.
    expect(allowances(store, '2024/25', '2026-09-29').taxBand).toMatchObject({ band: 'none', basis: 'minimum' });
  });

  it('on start, gives investment rows nothing categorised the category their wording now has, and touches nothing else', async () => {
    await store.setCategories(defaultCategories());
    const rows = {
      trade: tx('isa', '2025-02-03', -1262.4, '12 VANGUARD FTSE GLOB  Del   105.20 S Date 03/02/25'),
      dividend: tx('isa', '2025-04-02', 45.5, 'Div 250   VANGUARD FUNDS PLC'),
      yourPayee: tx('isa', '2025-04-03', 30, 'Div 120   ACME FUND', { payee: 'Acme dividends', payeeSetBy: 'user' }),
      claudes: tx('isa', '2025-04-04', 12, 'Div 250   VANGUARD FUNDS PLC', { category: 'other-income', categorisedBy: 'ai' }),
      unexplained: tx('isa', '2025-05-01', -2, 'MYSTERY'),
      leftByYou: tx('isa', '2025-05-02', -3, '5 ABC FUND  Del  0.60 S Date 02/05/25', { categorisedBy: 'user' }),
      notInvestments: tx('current', '2025-05-03', -3, '5 ABC FUND  Del  0.60 S Date 02/05/25'),
    };
    await store.addTransactions(Object.values(rows), 'test');
    expect(await categoriseInvestmentRows(store)).toBe(3);
    const now = (k: keyof typeof rows) => {
      const t = store.transaction(rows[k].id)!;
      return [t.category, t.categorisedBy, t.payee];
    };
    expect(now('trade')).toEqual(['trade', 'builtin', 'VANGUARD FTSE GLOB']);
    expect(now('dividend')).toEqual(['investment-income', 'builtin', 'VANGUARD FUNDS PLC']);
    expect(now('yourPayee')).toEqual(['investment-income', 'builtin', 'Acme dividends']);
    expect(now('claudes')).toEqual(['other-income', 'ai', undefined]);
    for (const k of ['unexplained', 'leftByYou', 'notInvestments'] as const) expect(now(k)[0]).toBeUndefined();
    expect(await categoriseInvestmentRows(store)).toBe(0);
  });

  it('counts a general investment account’s dividends in any provider’s wording, and none from an ISA', async () => {
    await store.setCategories(defaultCategories());
    await store.setAccounts([...store.accounts, acct('gia', 'gia')]);
    await store.addTransactions(
      [
        tx('gia', '2026-07-02', 45.5, 'Div 250   VANGUARD FUNDS PLC   FTSE ALL WLD UCITS ETF', { category: 'investment-income' }),
        tx('gia', '2026-08-01', 12.25, 'DIVIDEND ACME PLC', { category: 'investment-income' }),
        tx('gia', '2026-08-25', 0.8, 'GROSS INTEREST', { category: 'investment-income' }),
        tx('isa', '2026-07-02', 30, 'Div 250   VANGUARD FUNDS PLC', { category: 'investment-income' }),
      ],
      'test',
    );
    expect(allowances(store, '2026/27', '2026-09-29').dividends.amount).toBe(57.75);
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
