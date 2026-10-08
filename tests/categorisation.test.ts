// Categorisation that gets more right by itself (docs/FORMULAS.md §10, "Payees" and "Pay by name";
// docs/DECISIONS.md 2026-10-03): payees from the ways banks word a payment, American Express's own
// categories, platform withdrawals, disputed charges, card repayments and refunds, cash paid in left
// for the owner to say, pay under the name the bank gives a job, what other documents said of a
// payment, and a preview of re-applying it all that matches what applying does. Every name and
// amount is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFlow } from '../src/server/analytics/cashflow';
import { paidAs } from '../src/server/analytics/pay';
import { payeeRuleMatch } from '../src/server/analytics/queue';
import { categoriseInputOf, categoriserFor, ruleCatches } from '../src/server/categoriser';
import { enrich, nextPayee, reapply } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories, mapBankCategory } from '../src/shared/categories';
import { Categoriser, purchaseKey } from '../src/shared/categorise';
import { cleanPayee, paymentParts } from '../src/shared/merchants';
import type { Account, Figure, Rule, Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const cats = new CategoryIndex(defaultCategories());
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, seq++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

describe('payees from the ways banks word a payment', () => {
  it('takes the other party out of the words around it, and keeps the reference', () => {
    expect(paymentParts('BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE Dinner , MANDATE NO 12')).toEqual({ name: 'SAM TAYLOR', reference: 'Dinner', via: 'transfer' });
    expect(paymentParts('STANDING ORDER VIA FASTER PAYMENT TO Alex Reed REFERENCE Rent-May')).toEqual({ name: 'Alex Reed', reference: 'Rent-May', via: 'transfer' });
    expect(paymentParts('Third party payment made via Faster Payment to EXAMPLE BANK Reference 4000123')).toEqual({ name: 'EXAMPLE BANK', reference: '4000123', via: 'transfer' });
    // The last FROM: a reference can hold one of its own.
    expect(paymentParts('FASTER PAYMENTS RECEIPT REF.FROM NAN FROM TAYLOR M')).toEqual({ name: 'TAYLOR M', reference: 'FROM NAN', via: 'transfer' });
    expect(paymentParts('FASTER PAYMENTS RECEIPT REF.Train&amp;Tickets FROM A REED')).toEqual({ name: 'A REED', reference: 'Train&Tickets', via: 'transfer' });
    expect(paymentParts('BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K')).toEqual({ name: 'ACME WIDGETS', reference: '0420 1234 K', via: 'giro' });
    expect(paymentParts('DIRECT DEBIT PAYMENT TO EXAMPLE GYM REF GYM123, MANDATE NO 0004')).toEqual({ name: 'EXAMPLE GYM', reference: 'GYM123', via: 'direct-debit' });
    expect(paymentParts('From Sam Taylor - SAVINGS')).toEqual({ name: 'Sam Taylor', reference: 'SAVINGS', via: 'transfer' });
    expect(paymentParts('Example Kitchen Purchase')).toEqual({ name: 'Example Kitchen', via: 'card' });
    // A bank credit that names nobody stays as it is.
    expect(paymentParts('BANK GIRO CREDIT')).toBeUndefined();
  });

  it('tidies what it takes out, and what other wordings leave', () => {
    expect(cleanPayee('BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE Dinner , MANDATE NO 12')).toBe('Sam Taylor');
    expect(cleanPayee('FASTER PAYMENTS RECEIPT REF.Xmas M&amp;D FROM TAYLOR R')).toBe('Taylor R');
    expect(cleanPayee('BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K')).toBe('Acme Widgets');
    expect(cleanPayee('DIRECT DEBIT PAYMENT TO EXAMPLE GYM REF GYM123, MANDATE NO 0004')).toBe('Example Gym');
    expect(cleanPayee('EXAMPLE CAFE 1234 (VIA APPLE PAY), ON 08-01-2024')).toBe('Example Cafe');
    // Chase: the purchase, with a foreign amount and its rate, is one payee whatever the rate.
    expect(cleanPayee('Example Hosting Purchase | EUR 24.50 | FX rate £1 = EUR 1.1440')).toBe('Example Hosting');
    expect(cleanPayee('Example Hosting Purchase | EUR 12.49 | FX rate £1 = EUR 1.1375')).toBe('Example Hosting');
    expect(cleanPayee('Example Kitchen Purchase')).toBe('Example Kitchen');
    // A brand whose name ends in a number keeps it.
    expect(cleanPayee('TRADING 212 UK LIM 12345678 CR')).toBe('Trading 212');
    expect(cleanPayee('BANK GIRO CREDIT')).toBe('Bank Giro Credit');
  });

  it('leaves out what a card added about the money: a rate paid abroad, the day it was made', () => {
    // Starling, paying in another currency.
    expect(cleanPayee('EXAMPLE TRANSIT PAYGO ($3.75, Rate: 1.2810)')).toBe('Example Transit Paygo');
    // A payment id before the name, and Santander's fee on a foreign payment.
    expect(cleanPayee('0a1b2c3d4e5f6071 - ExamplePay')).toBe('ExamplePay');
    expect(cleanPayee('CARD PAYMENT TO EXAMPLE CLOUD,1.80 USD, RATE 0.77/GBP ON 02-01-2024')).toBe('Example Cloud');
    expect(cleanPayee('Sam Taylor (Trip) (€11.64, Rate: 1.1695, Fee: £0.04)')).toBe('Sam Taylor (Trip)');
    // Capital One's day the payment was made.
    expect(cleanPayee('Www.examplevans.com London LND on 01 Sep')).toBe('Www.examplevans.com London LND');
  });
});

describe('American Express’s own categories', () => {
  it('maps "Group-Subgroup", and a subgroup it does not list takes its group’s', () => {
    expect(mapBankCategory('Entertainment-Restaurants')).toBe('eating-out');
    expect(mapBankCategory('General Purchases-Groceries')).toBe('groceries');
    expect(mapBankCategory('Communications-Mobile Telecommunication')).toBe('mobile');
    expect(mapBankCategory('Travel-Airline')).toBe('flights');
    expect(mapBankCategory('Travel-Space Flights')).toBe('travel');
    expect(mapBankCategory('Fees & Adjustments-Fees & Adjustments')).toBe('bank-fees');
    // An attraction's ticket (a cathedral, a museum) is an outing, not a hobby.
    expect(mapBankCategory('Entertainment-General Attractions')).toBe('events');
    // Other banks' words are read as before.
    expect(mapBankCategory('Transfers')).toBe('transfer');
    expect(mapBankCategory('eating_out')).toBe('eating-out');
  });

  it('categorises a row the merchant list does not know by Amex’s category', () => {
    const c = new Categoriser([], cats, [acct('amex', 'credit_card')], []);
    expect(c.categorise({ accountId: 'amex', description: 'EXAMPLE BISTRO LONDON', amount: -40, bankCategory: 'Entertainment-Restaurants' })).toMatchObject({ category: 'eating-out', categorisedBy: 'builtin' });
    expect(c.categorise({ accountId: 'amex', description: 'SOMEWHERE UNKNOWN', amount: -12, bankCategory: 'General Purchases-Clothing Stores' })).toMatchObject({ category: 'clothing', categorisedBy: 'bank' });
  });
});

describe('money that is neither spending nor income', () => {
  const c = new Categoriser([], cats, [acct('current', 'current'), acct('card', 'credit_card'), acct('isa', 'stocks_isa')], []);

  it('money in from an investment platform is a withdrawal, outside the platform’s own accounts', () => {
    expect(c.categorise({ accountId: 'current', description: 'TRADING 212 UK LIM 12345678 CR', amount: 500 })).toMatchObject({ category: 'investment-transfer', payee: 'Trading 212' });
    expect(c.categorise({ accountId: 'current', description: 'MOONPAY LONDON', amount: -100 }).category).toBe('investment-transfer');
    expect(c.categorise({ accountId: 'isa', description: 'TRADING 212 INTEREST', amount: 3 }).category).not.toBe('investment-transfer');
  });

  it('a disputed charge’s credit and the debit that takes it back come to nothing', () => {
    const credit = c.categorise({ accountId: 'card', description: 'CREDIT FOR DISPUTED CHARGE', amount: 150 });
    const debit = c.categorise({ accountId: 'card', description: 'DEBIT ADJUSTMENT', amount: -150 });
    expect([credit.category, debit.category]).toEqual(['refunds', 'refunds']);
    const card = acct('card', 'credit_card');
    const counted = [tx('card', '2026-06-12', 150, 'CREDIT FOR DISPUTED CHARGE', { category: credit.category }), tx('card', '2026-06-12', -150, 'DEBIT ADJUSTMENT', { category: debit.category })].map((t) => classifyFlow(t, cats, card));
    expect(counted).toEqual(['spending', 'spending']);
  });

  it('a credit card’s "Payment" is paying it off; the same word on a current account is not', () => {
    expect(c.categorise({ accountId: 'card', description: 'Payment', amount: 25 }).category).toBe('credit-card-payment');
    expect(c.categorise({ accountId: 'card', description: 'DIRECT DEBIT PAYMENT', amount: 25 }).category).toBe('credit-card-payment');
    expect(c.categorise({ accountId: 'current', description: 'PAYMENT', amount: 25 }).category).not.toBe('credit-card-payment');
  });

  it('cash and cheques paid in are yours to say: nothing on the list, from the bank or from the reader gives them a category', () => {
    const cases: [string, string | undefined][] = [
      ['POST OFFICE CASH DEPOSIT', undefined],
      ['CASH PAID IN AT ATM EXAMPLETOWN', undefined],
      ['COUNTER CREDIT 0412', undefined],
      ['EXAMPLE BANK', 'ATM'],
    ];
    for (const [description, type] of cases) expect(c.categorise({ accountId: 'current', description, amount: 80, ...(type ? { type } : {}) })).toEqual({ payee: 'Cash paid in' });
    expect(c.categorise({ accountId: 'current', description: 'POST OFFICE CASH DEPOSIT', amount: 80, bankCategory: 'Transfers', aiCategory: 'transfer' })).toEqual({ payee: 'Cash paid in' });
    // A cheque paid in is a cheque, wherever it was paid in.
    expect(c.categorise({ accountId: 'current', description: 'CHEQUE PAID IN AT EXAMPLETOWN', amount: 30 })).toEqual({ payee: 'Cheque paid in' });
    expect(c.categorise({ accountId: 'current', description: 'EXAMPLE BANK', amount: 30, type: 'CHQ' })).toEqual({ payee: 'Cheque paid in' });
    // A rule of yours still comes first.
    const rule = { id: 'rule_cash', enabled: true, priority: 100, match: { field: 'description' as const, op: 'contains' as const, value: 'CASH DEPOSIT', caseSensitive: false }, set: { category: 'gifts-received' }, createdAt: stamp, updatedAt: stamp };
    expect(new Categoriser([rule], cats, [acct('current', 'current')], []).categorise({ accountId: 'current', description: 'POST OFFICE CASH DEPOSIT', amount: 80 }).category).toBe('gifts-received');
    // Cash taken out is still a withdrawal, and cash paid onto a card is not cash paid in.
    expect(c.categorise({ accountId: 'current', description: 'CASH WITHDRAWAL LINK ATM', amount: -50 }).category).toBe('cash-withdrawal');
    expect(c.categorise({ accountId: 'card', description: 'POST OFFICE CASH DEPOSIT', amount: 80 }).payee).not.toBe('Cash paid in');
  });

  it('a rule matches a recorded payment as categorising it would, not by the payee shown', () => {
    const fare = tx('current', '2026-09-28', -2.8, 'TFL TRAVEL CH TFL.GOV.UK/CP', { payee: 'TfL' });
    const rule = (match: Rule['match']): Rule => ({ id: 'rule_t', enabled: true, priority: 100, match, set: {}, createdAt: stamp, updatedAt: stamp });
    expect(ruleCatches(rule({ field: 'payee', op: 'equals', value: cleanPayee(fare.description), caseSensitive: false }), fare)).toBe(true);
    expect(ruleCatches(rule({ field: 'payee', op: 'equals', value: 'TfL', caseSensitive: false }), fare)).toBe(false);
    // "Always" for a payee too short to look for in descriptions: the payee as the categoriser sees it.
    expect(payeeRuleMatch('TfL', [fare], 'out')).toEqual({ field: 'payee', op: 'equals', value: cleanPayee(fare.description), caseSensitive: false, direction: 'out' });
    expect(payeeRuleMatch('Tfl Travel', [fare], 'out')).toMatchObject({ field: 'description', op: 'contains', value: 'Tfl Travel' });
  });

  it('a payment its own document names no one for takes the name another document gave it', () => {
    // A statement's "Outgoing transaction"; the app called it after the café, through its card reader.
    expect(c.categorise({ accountId: 'card', description: 'Outgoing transaction', alsoSaid: ['Example Beach Cafe - Zettle / Paypal POS'], amount: -1.8 }).payee).toBe('Example Beach Cafe');
    // A brand the merchant list knows names it, and categorises it; a general word only categorises it.
    expect(c.categorise({ accountId: 'card', description: 'Outgoing transaction', alsoSaid: ['ALDI'], amount: -4.08 })).toMatchObject({ payee: 'Aldi', category: 'groceries' });
    expect(c.categorise({ accountId: 'card', description: 'Outgoing transaction', alsoSaid: ['Example Hill Pharmacy'], amount: -9.9 })).toMatchObject({ payee: 'Example Hill Pharmacy', category: 'pharmacy' });
    // A description that names someone keeps its own words.
    expect(c.categorise({ accountId: 'card', description: 'EXAMPLE DELI', alsoSaid: ['Example Deli Ltd'], amount: -4 }).payee).toBe('Example Deli');
    expect(cleanPayee('Example Ices - Zettle')).toBe('Example Ices');
    expect(cleanPayee('Example Pancakes V. - CCV Payments')).toBe('Example Pancakes V.');
  });

  it('a car park is parking, and keeps its own name', () => {
    expect(c.categorise({ accountId: 'card', description: 'Exampleton Car Park', amount: -2.4 })).toMatchObject({ category: 'parking', payee: 'Exampleton Car Park' });
  });

  it('a "BP" ending an HSBC row is its bill-payment code, not the fuel brand', () => {
    expect(c.categorise({ accountId: 'current', description: 'EXAMPLE LETTINGS 12 FLAT BP', amount: -900 }).category).not.toBe('fuel');
    expect(c.categorise({ accountId: 'current', description: 'EXAMPLE BNK VSA123456 123456******1234 BP', amount: -150 }).category).not.toBe('fuel');
    expect(c.categorise({ accountId: 'card', description: 'BP CONNECT EXAMPLETOWN', amount: -45 }).category).toBe('fuel');
    expect(c.categorise({ accountId: 'card', description: 'BP EXAMPLETOWN SERVICE STN', amount: -45 }).category).toBe('fuel');
  });

  it('a rule’s words match however the bank spaced them', () => {
    const rule = (value: string, op: Rule['match']['op'] = 'contains'): Rule => ({ id: 'rule_s', enabled: true, priority: 100, match: { field: 'description', op, value, caseSensitive: false }, set: { category: 'hair-beauty' }, createdAt: stamp, updatedAt: stamp });
    // One card pads its descriptions to fixed columns; another doesn't.
    const padded = tx('card', '2026-05-31', -29.2, 'EXAMPLE - BARBERS         YORK');
    const plain = tx('card', '2025-12-19', -25.2, 'Example - Barbers Purchase');
    expect(ruleCatches(rule('Example - Barbers York'), padded)).toBe(true);
    expect(ruleCatches(rule('Example - Barbers'), plain)).toBe(true);
    expect(ruleCatches(rule('example - barbers york', 'equals'), padded)).toBe(true);
    expect(ruleCatches(rule('Example - Barbers York'), plain)).toBe(false);
  });

  it('conversion fees, the Underground and a platform’s fee', () => {
    expect(c.categorise({ accountId: 'current', description: 'FOREIGN CURRENCY CONVERSION FEE', amount: -0.5 }).category).toBe('bank-fees');
    expect(c.categorise({ accountId: 'card', description: 'LUL TICKET MACHINE EXAMPLE', amount: -10 }).category).toBe('public-transport');
    expect(c.categorise({ accountId: 'current', description: 'DIRECT DEBIT PAYMENT TO INTERACTIVE INVEST REF A1234TDFEEO, MANDATE NO', amount: -14.99 }).category).toBe('investment-fee');
  });
});

describe('pay under the name the bank gives a job', () => {
  const employers = [{ payees: ['Acme Widgets'], least: 1500, most: 1700, first: '2026-04-30', last: '2026-08-29' }];
  const c = new Categoriser([], cats, [acct('current', 'current')], [], { employers });

  it('is salary when it is about that pay, while the job lasted', () => {
    expect(c.categorise({ accountId: 'current', description: 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 99 K', amount: 1600, date: '2025-11-28' })).toMatchObject({ category: 'salary', categorisedBy: 'builtin' });
  });

  it('is not when the amount is far from it, or long before the job’s pay began, or without the names', () => {
    expect(c.categorise({ accountId: 'current', description: 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 99 K', amount: 50, date: '2026-05-01' }).category).toBeUndefined();
    expect(c.categorise({ accountId: 'current', description: 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 99 K', amount: 1600, date: '2024-01-31' }).category).toBeUndefined();
    expect(new Categoriser([], cats, [acct('current', 'current')], []).categorise({ accountId: 'current', description: 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 99 K', amount: 1600, date: '2026-05-01' }).category).toBeUndefined();
  });
});

describe('a refund onto a card', () => {
  it('takes the category of what the card bought from the same payee in the 120 days before', () => {
    const bought = (accountId: string, key: string, date: string) => (accountId === 'card' && key === purchaseKey('EXAMPLE OUTFITTERS LONDON') && date <= '2026-03-01' ? 'clothing' : undefined);
    const c = new Categoriser([], cats, [acct('card', 'credit_card'), acct('current', 'current')], [], { cardPurchases: bought });
    expect(c.categorise({ accountId: 'card', description: 'EXAMPLE OUTFITTERS LONDON', amount: 40, date: '2026-02-20' })).toMatchObject({ category: 'clothing', categorisedBy: 'builtin' });
    expect(c.categorise({ accountId: 'current', description: 'EXAMPLE OUTFITTERS LONDON', amount: 40, date: '2026-02-20' }).category).toBeUndefined();
  });
});

describe('what other documents said of a payment', () => {
  it('a terse row is categorised by a statement’s fuller words for it', () => {
    const accounts = [acct('current', 'current'), acct('loan', 'student_loan', { aliases: ['SLC'] })];
    const c = new Categoriser([], cats, accounts, []);
    expect(c.categorise({ accountId: 'current', description: 'Bank Giro Credit', amount: 1000 }).category).toBeUndefined();
    expect(c.categorise({ accountId: 'current', description: 'Bank Giro Credit', amount: 1000, alsoSaid: ['BANK GIRO CREDIT REF SLC DISBURSEMENTS, 123'] })).toMatchObject({ category: 'transfer', counterpartyAccountId: 'loan' });
  });

  it('reads a recorded row’s other descriptions and reference, not the other party it names', () => {
    const t = tx('current', '2026-09-21', 1000, 'Bank Giro Credit', { reference: 'REF 9', counterpartyName: 'Example Payer', seenIn: [{ at: stamp, added: ['balanceAfter'], said: { description: 'BANK GIRO CREDIT REF SLC DISBURSEMENTS, 123' } }] });
    expect(categoriseInputOf(t).alsoSaid).toEqual(['BANK GIRO CREDIT REF SLC DISBURSEMENTS, 123', 'REF 9']);
  });
});

describe('re-applying keeps what the reader knew', () => {
  it('a general word in the merchant list does not overrule the reader’s category; a brand does', () => {
    const c = new Categoriser([], cats, [acct('current', 'current')], []);
    expect(c.categorise({ accountId: 'current', description: 'EXAMPLE DISTRICT COUNCIL', amount: -4, aiCategory: 'parking' })).toMatchObject({ category: 'parking', categorisedBy: 'ai' });
    expect(c.categorise({ accountId: 'current', description: 'TESCO STORES 123', amount: -4, aiCategory: 'home-garden' })).toMatchObject({ category: 'groceries', categorisedBy: 'builtin' });
  });

  it('keeps a clean payee from elsewhere, and replaces one cut from the description or left raw', () => {
    const c = new Categoriser([], cats, [acct('current', 'current')], []);
    const next = (t: Transaction) => nextPayee(t, categoriseInputOf(t), c.categorise(categoriseInputOf(t)));
    expect(next(tx('current', '2026-09-01', 2, 'Interest earned', { payee: 'Example Bank' }))).toBe('Example Bank');
    expect(next(tx('current', '2026-09-01', 500, 'TRADING 212 UK LIM 12345678 CR', { payee: 'Trading' }))).toBe('Trading 212');
    expect(next(tx('current', '2026-09-01', 1600, 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 99 K', { payee: 'Bank Giro Credit Ref Acme Widgets,' }))).toBe('Acme Widgets');
    expect(next(tx('current', '2026-09-01', -9, 'Example Kitchen Purchase', { payee: 'Example Kitchen Purchase' }))).toBe('Example Kitchen');
    expect(next(tx('current', '2026-09-01', -9, 'Example Kitchen Purchase', { payee: 'Mine', payeeSetBy: 'user' }))).toBe('Mine');
  });
});

describe('the store as it is', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-categorisation-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('current', 'current'), acct('card', 'credit_card')]);
    await store.setEmployments([
      { id: 'acme', employer: 'Acme Widgets Ltd', aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp },
      { id: 'mine', employer: 'Own Venture Ltd', aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp },
    ]);
    const fig = (id: string, employmentId: string, payer: string, kind: Figure['kind'], amount: number): Figure => ({ id, kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: '2026-08-01', periodEnd: '2026-08-31', date: '2026-08-28', payer, employmentId, source: {}, createdAt: stamp });
    await store.addFigures([fig('fig_00000000000000a1', 'acme', 'Acme Widgets Ltd', 'gross_pay', 2000), fig('fig_00000000000000a2', 'acme', 'Acme Widgets Ltd', 'tax_deducted', 200), fig('fig_00000000000000b1', 'mine', 'Own Venture Ltd', 'gross_pay', 1000)], 'f');
    await store.setCompanies([{ id: 'own-venture', name: 'Own Venture Ltd', holdings: [], valuations: [], employmentId: 'mine', createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    await store.addTransactions(
      [
        // Paired with August's payslip: it teaches the name the bank gives Acme's pay.
        tx('current', '2026-08-28', 1800, 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 5678 K', { category: 'salary', categorisedBy: 'user' }),
        // Before the payslips began: the same name, about the same pay.
        tx('current', '2026-03-27', 1750, 'BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K'),
        // Your own company's money: never salary by its name alone.
        tx('current', '2026-08-28', 1000, 'BANK GIRO CREDIT REF OWN VENTURE, 99', { category: 'salary', categorisedBy: 'user' }),
        tx('current', '2026-04-28', 1000, 'BANK GIRO CREDIT REF OWN VENTURE, 77'),
        // A card purchase, then its refund.
        tx('card', '2026-02-01', -60, 'EXAMPLE OUTFITTERS LONDON', { category: 'clothing', categorisedBy: 'user' }),
        tx('card', '2026-02-20', 60, 'EXAMPLE OUTFITTERS LONDON'),
      ],
      't',
    );
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('learns each job’s bank name from its paired pay, leaving out a company you hold shares in', () => {
    expect(paidAs(store)).toEqual([{ employmentId: 'acme', payees: ['Acme Widgets'], least: 1800, most: 1800, first: '2026-08-28', last: '2026-08-28' }]);
  });

  it('re-applying files the earlier pay and the refund, and the preview says exactly what applying does', async () => {
    const preview = await enrich(store, { dryRun: true, detail: true });
    const changed = new Map((preview.changes ?? []).filter((ch) => ch.category).map((ch) => [ch.id, ch.category!.to]));
    expect(store.transactions().filter((t) => t.categorisedBy !== 'user' && t.category).length).toBe(0);
    await enrich(store);
    for (const [id, to] of changed) expect(store.transaction(id)?.category ?? null).toBe(to);
    const byDescription = (d: string) => store.transactions().find((t) => t.description === d && t.categorisedBy !== 'user');
    expect(byDescription('BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K')?.category).toBe('salary');
    expect(byDescription('BANK GIRO CREDIT REF OWN VENTURE, 77')?.category).toBeUndefined();
    expect(byDescription('EXAMPLE OUTFITTERS LONDON')?.category).toBe('clothing');
    expect(categoriserFor(store)).toBeInstanceOf(Categoriser);
  });

  it('re-applies with your choices: your categories first and kept, one left as it is this time, and your rule', async () => {
    const id = (d: string) => store.transactions().find((t) => t.description === d && t.categorisedBy !== 'user')!.id;
    const pay = id('BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K');
    const refund = id('EXAMPLE OUTFITTERS LONDON');
    const venture = id('BANK GIRO CREDIT REF OWN VENTURE, 77');
    // Nothing is written when a choice is wrong.
    await expect(reapply(store, { decided: [{ id: pay, category: 'nonsense' }] })).rejects.toThrow(/Unknown category/);
    await expect(reapply(store, { skip: ['tx_0000000000000000'] })).rejects.toThrow(/Unknown transaction/);
    expect(store.transaction(pay)?.category).toBeUndefined();
    const r = await reapply(store, {
      decided: [{ id: pay, category: 'bonus' }],
      skip: [refund],
      rules: [{ match: { field: 'description', op: 'contains', value: 'OWN VENTURE', caseSensitive: false, direction: 'in' }, category: 'other-income' }],
    });
    expect(r).toMatchObject({ decided: 1, rules: 1 });
    expect(store.transaction(pay)).toMatchObject({ category: 'bonus', categorisedBy: 'user' });
    expect(store.transaction(refund)?.category).toBeUndefined();
    expect(store.transaction(venture)).toMatchObject({ category: 'other-income', categorisedBy: 'rule' });
    expect(store.rules.map((x) => x.name)).toEqual(['OWN VENTURE → Other income']);
    // Re-applying again keeps yours, and offers again what you left as it was.
    const again = await enrich(store, { dryRun: true, detail: true });
    expect((again.changes ?? []).filter((ch) => ch.category).map((ch) => ch.id)).toEqual([refund]);
    await enrich(store);
    expect(store.transaction(pay)).toMatchObject({ category: 'bonus', categorisedBy: 'user' });
    expect(store.transaction(refund)?.category).toBe('clothing');
  });
});
