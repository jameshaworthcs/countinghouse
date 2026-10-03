// Money with people (docs/FORMULAS.md §10, "People", "Cash paid in" and "Guesses to check"): who a
// payment is with, the names one person's payments carry, what each payment, and each cash payment
// in, looks like it was and why, the To categorise page's queue with the app's guesses, and the
// decisions you make there. Nothing is categorised from a suggestion without you. Every name and
// amount is invented.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { classifyFlow } from '../src/server/analytics/cashflow';
import { categoriseQueue } from '../src/server/analytics/queue';
import { loadConfig } from '../src/server/config';
import { transactionId } from '../src/server/ids';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { cleanPayee } from '../src/shared/merchants';
import { giftOccasion, itemCategory, parsePersonName, PeopleIndex, referenceWords, shareOf, suggestFor, suggestForCash, tidyName, type PaidOut, type PersonParty } from '../src/shared/people';
import type { Account, Person, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, seq++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });
const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({ id, name, names: [], usually: {}, createdAt: stamp, updatedAt: stamp, ...extra });
const cats = new CategoryIndex(defaultCategories());
const known = (id: string) => Boolean(cats.get(id));
const kindOf = (id: string) => cats.kindOf(id);
const key = (name: string) => parsePersonName(name)?.key;

describe('a person’s name', () => {
  it('is known however the payment writes it: surname and first initial', () => {
    for (const n of ['S TAYLOR', 'Sam Taylor', 'TAYLOR S', 'Mr Sam Taylor', 'S J Taylor', 'Sam Jo Taylor']) expect(key(n), n).toBe('taylor|s');
    for (const n of ['P OKAFOR', 'Priya Okafor', 'OKAFOR P', 'OKAFOR PRIYA']) expect(key(n), n).toBe('okafor|p');
    expect(key('REED A J K')).toBe('reed|a');
    expect(parsePersonName('REED A J K')?.initials).toBe('ajk');
    expect(key('BLAKE JW')).toBe('blake|j');
    expect(key('Priya Ashworth-Lane')).toBe('ashworthlane|p');
    expect(key('ASHWORTH-LANE P')).toBe('ashworthlane|p');
  });

  it('takes a first name before a short surname, not for initials', () => {
    expect(key('SAM COX')).toBe('cox|s');
    expect(key('COX SJ')).toBe('cox|s');
  });

  it('two first names could be either way round: both are kept', () => {
    expect(parsePersonName('TAYLOR SAM')).toMatchObject({ key: 'sam|t', altKey: 'taylor|s' });
  });

  it('knows joint names, one surname shared or two whole names', () => {
    expect(key('BLAKE R&C')).toBe('blake|c&r');
    expect(key('R & C BLAKE')).toBe('blake|c&r');
    expect(key('Mr & Mrs Blake')).toBe('blake|&');
    // A surname that is a first name too.
    expect(key('TAYLOR R&J')).toBe('taylor|j&r');
    expect(key('John & Jane Taylor')).toBe('taylor|j&j');
    const two = parsePersonName('Sam Taylor & Alex Reed');
    expect(two).toMatchObject({ joint: true });
    expect(two?.members?.map((m) => m.key)).toEqual(['reed|a', 'taylor|s']);
  });

  it('is not a business, a product or one word', () => {
    for (const n of ['Example Widgets Ltd', 'Purple Lantern', 'Acme Pay', 'Moon Pay', 'Square Cash', 'Trading 212', 'Harbour Wines (Kim', 'Example Card', 'Aqua', 'Rewards', 'Chase Saver', 'HMRC Shipley', 'Smith & Sons', 'Marks & Spencer', 'M&S'])
      expect(parsePersonName(n), n).toBeUndefined();
  });

  it('printed in capitals, is shown as a name, its initials kept', () => {
    expect(tidyName('PRIYA SHAH')).toBe('Priya Shah');
    expect(tidyName('TAYLOR R&J')).toBe('Taylor R&J');
    expect(tidyName('FENWICK H C W')).toBe('Fenwick H C W');
    expect(tidyName("O'NEIL-WARD P")).toBe("O'Neil-Ward P");
    expect(tidyName('Priya Shah')).toBe('Priya Shah');
  });

  it('a title or a saved person says it is someone, whatever the name', () => {
    expect(key('MRS PATEL')).toBe('patel|');
    expect(parsePersonName('Zorvan Quill')).toBeUndefined();
    expect(parsePersonName('Zorvan Quill', true)?.key).toBe('quill|z');
    expect(key('Mr Zorvan Quill')).toBe('quill|z');
  });
});

describe('who a payment is with', () => {
  const index = new PeopleIndex({ ownerName: 'Jordan W Blake', ownNames: ['Robin Wood', 'Example Bank'], people: [person('zorvan', 'Zorvan Quill'), person('sam', 'Sam Taylor', { names: ['S TAYLOR'] })] });
  const party = (description: string, extra: Partial<Transaction> = {}) => index.party(tx('bank', '2026-05-01', 20, description, extra));

  it('is the other person of a payment between two people’s accounts, with its reference', () => {
    expect(party('FASTER PAYMENTS RECEIPT REF.xmas FROM ALEX REED')).toEqual({ name: 'ALEX REED', key: 'reed|a', reference: 'xmas' });
    expect(party('STANDING ORDER VIA FASTER PAYMENT TO Alex Reed REFERENCE Rent-May')).toMatchObject({ key: 'reed|a', reference: 'Rent-May' });
    expect(party('From Alex Reed - Train')).toMatchObject({ key: 'reed|a', reference: 'Train' });
  });

  it('is someone you saved, by any of their names or a variant only they have', () => {
    expect(party('FASTER PAYMENTS RECEIPT REF.thanks FROM ZORVAN QUILL')).toMatchObject({ personId: 'zorvan' });
    expect(party('FASTER PAYMENTS RECEIPT REF.lunch FROM TAYLOR S')).toMatchObject({ personId: 'sam', key: 'taylor|s' });
    // Either way round, when both words are first names.
    expect(party('FASTER PAYMENTS RECEIPT REF.lunch FROM TAYLOR SAM')).toMatchObject({ personId: 'sam' });
  });

  it('is never you, nor your accounts, nor a card payment, nor a transfer between your accounts', () => {
    expect(party('FASTER PAYMENTS RECEIPT REF.top up FROM BLAKE JW')).toBeUndefined();
    expect(party('FASTER PAYMENTS RECEIPT REF.top up FROM J BLAKE')).toBeUndefined();
    expect(party('From Alex Reed & Jordan Blake - bills')).toBeUndefined();
    expect(party('To Robin Wood - savings')).toBeUndefined();
    expect(party('EXAMPLE CAFE (VIA APPLE PAY), ON 08-01-2024')).toBeUndefined();
    expect(party('BANK GIRO CREDIT REF ALEX REED, 1234')).toBeUndefined();
    expect(party('FASTER PAYMENTS RECEIPT REF.xmas FROM ALEX REED', { transferGroup: 'tg_1' })).toBeUndefined();
    expect(party('FASTER PAYMENTS RECEIPT REF.xmas FROM ALEX REED', { counterpartyAccountId: 'savings' })).toBeUndefined();
  });

  it('reads the other party a source names on a transfer, not on a card payment', () => {
    expect(party('Alex Reed', { counterpartyName: 'Alex Reed', type: 'FASTER PAYMENT', reference: 'pizza' })).toMatchObject({ key: 'reed|a', reference: 'pizza' });
    expect(party('Alex Reed', { counterpartyName: 'Alex Reed', type: 'Card payment' })).toBeUndefined();
  });

  it('is found in what another document said of the payment', () => {
    expect(party('Bank Giro Credit', { seenIn: [{ importId: 'imp_20260101_000000_aaaa', at: stamp, added: [], said: { description: 'FASTER PAYMENTS RECEIPT REF.bday FROM ALEX REED' } }] })).toMatchObject({ key: 'reed|a', reference: 'bday' });
  });
});

describe('what a payment with a person looks like it was', () => {
  const party = (reference?: string, k = 'reed|a'): PersonParty => ({ name: 'ALEX REED', key: k, ...(reference ? { reference } : {}) });
  const suggest = (amount: number, reference?: string, extra: Partial<Parameters<typeof suggestFor>[2]> = {}, row: Partial<Transaction> = {}) =>
    suggestFor({ amount, date: '2026-06-01', ...row }, party(reference, (extra as { key?: string }).key), { known, kindOf, personName: 'Alex Reed', ...extra });

  it('splits run-together references into words', () => {
    expect(referenceWords('XmasGift2019')).toBe('xmas gift 2019');
    expect(referenceWords('3Bus faresMay23')).toBe('3 bus fares may 23');
    expect(referenceWords('Train&amp;Tickets')).toBe('train&tickets');
  });

  it('a gift when the reference says an occasion, pocket money, or love and kisses', () => {
    for (const r of ['XmasGift2019', 'POCKET MONEY', '2019 birthdaymoney', 'Exam success xx', 'CONGRATS 30', 'Love from us'])
      expect(suggest(50, r), r).toMatchObject({ treatment: 'gift', category: 'gifts-received', strong: true });
    // The occasion is the reason given, before the love.
    expect(suggest(50, 'Happy birthday xx')?.reason).toBe('the reference says “birthday”');
    expect(suggest(-15, 'HAPPY BIRTHDAY')).toMatchObject({ treatment: 'gift', category: 'gifts', strong: true });
  });

  it('who it is from is not a gift by itself: most family money is, not all', () => {
    expect(suggest(50, 'FROM NAN')).toBeUndefined();
    expect(suggest(50, 'FROM AUNTIE', { ownerSurname: 'reed' })).toMatchObject({ treatment: 'gift', strong: false });
    expect(suggest(50, 'FROM AUNTIE', { ownerSurname: 'reed' })?.reason).toMatch(/surname/);
  });

  it('paid back when the reference squares something up, in what was shared when it says', () => {
    expect(suggest(30, 'half the train')).toMatchObject({ treatment: 'repaid', category: 'trains', strong: true });
    expect(suggest(30, 'paying back dinner')).toMatchObject({ treatment: 'repaid', category: 'eating-out', strong: true });
    expect(suggest(30, 'owed')).toMatchObject({ treatment: 'repaid', category: 'repaid', strong: true });
    expect(suggest(30, 'half of mums present')).toMatchObject({ treatment: 'repaid', category: 'gifts', strong: true });
    expect(suggest(-27, 'REFUND')).toMatchObject({ treatment: 'shared', category: 'other-expense', strong: true });
  });

  it('what was shared alone only fills in the choice: "Train back" is a train, not a repayment', () => {
    expect(suggest(30, 'Train back')).toMatchObject({ treatment: 'repaid', category: 'trains', strong: false });
    expect(suggest(-12, 'TRAIN')).toMatchObject({ treatment: 'shared', category: 'trains', strong: false });
    expect(suggest(-12, 'Example Pizza Co')).toMatchObject({ treatment: 'shared', category: 'eating-out', strong: false });
  });

  it('a loan is yours to say', () => {
    expect(suggest(500, 'loan till payday')).toBeUndefined();
    expect(suggest(-500, 'lent for car', { ownerSurname: 'reed' })).toBeUndefined();
  });

  it('your own money when the reference says so, only filled in', () => {
    expect(suggest(-150, 'top up')).toMatchObject({ treatment: 'own', category: 'transfer', strong: false });
  });

  it('a share of a payment you made: half, a third, a quarter, or all of one not in round pounds', () => {
    const paid: PaidOut[] = [
      { id: 'a', date: '2026-05-27', amount: -236.5, payee: 'Example Air', category: 'flights' },
      { id: 'b', date: '2026-05-20', amount: -100.01, payee: 'Example Hall', category: 'events' },
      { id: 'c', date: '2026-05-10', amount: -64.65, payee: 'Example Bistro', category: 'eating-out' },
      { id: 'd', date: '2026-02-01', amount: -500, payee: 'Too Long Ago' },
    ];
    const half = suggest(118.25, undefined, { paid });
    expect(half).toMatchObject({ treatment: 'repaid', category: 'flights', strong: true });
    expect(half?.reason).toBe('half of £236.50 to Example Air on 27 May 2026');
    expect(shareOf(33.34, '2026-06-01', paid)).toMatchObject({ n: 3, payment: { id: 'b' } });
    expect(shareOf(33.33, '2026-06-01', paid)).toMatchObject({ n: 3, payment: { id: 'b' } });
    expect(suggest(64.65, undefined, { paid })).toMatchObject({ category: 'eating-out', strong: true });
    expect(suggest(64.65, undefined, { paid })?.reason).toMatch(/^all of £64\.65/);
    // Not a payment made after it, nor one 90 days or more before.
    expect(shareOf(250, '2026-06-01', paid)).toBeUndefined();
    expect(shareOf(118.25, '2026-05-26', paid)).toBeUndefined();
    // A round amount is a share only perhaps, and what the reference says was shared comes first;
    // money under £5 is nobody's share.
    expect(suggest(50, undefined, { paid: [{ id: 'e', date: '2026-05-30', amount: -100, payee: 'Example Venue', category: 'events' }] })).toMatchObject({ category: 'events', strong: false });
    expect(suggest(50, 'Train home', { paid: [{ id: 'e', date: '2026-05-30', amount: -100, payee: 'Example Shop', category: 'groceries' }] })).toMatchObject({ category: 'trains', strong: false });
    expect(shareOf(4, '2026-06-01', [{ id: 'f', date: '2026-05-30', amount: -8, payee: 'Example' }])).toBeUndefined();
  });

  it('what you said they usually are, and what you chose before, only fill in the choice', () => {
    const usual = suggest(40, 'Vienna', { person: person('alex', 'Alex Reed', { usually: { in: 'gift' } }) });
    expect(usual).toMatchObject({ treatment: 'gift', category: 'gifts-received', strong: false });
    expect(usual?.reason).toBe('you said money from Alex Reed is usually a gift');
    const history = new Map([
      ['gifts-received', 4],
      ['repaid', 1],
    ]);
    expect(suggest(40, undefined, { history })).toMatchObject({ treatment: 'gift', strong: false, reason: 'you chose this for 4 of 5 earlier payments from Alex Reed' });
    // Too few, or too mixed, to go on.
    expect(suggest(40, undefined, { history: new Map([['gifts-received', 2]]) })).toBeUndefined();
    expect(suggest(40, undefined, { history: new Map([['gifts-received', 3], ['repaid', 2]]) })).toBeUndefined();
  });

  it('the category it has from the reader is a suggestion like any other', () => {
    expect(suggest(40, undefined, {}, { category: 'gifts-received', categorisedBy: 'ai' })).toMatchObject({ treatment: 'gift', strong: false, reason: 'as the reader took it' });
  });

  it('finds what was shared from words, then from a brand the merchant list knows', () => {
    const expense = (id: string) => known(id) && kindOf(id) === 'expense';
    expect(itemCategory('Travelcard', expense)).toMatchObject({ category: 'public-transport' });
    expect(itemCategory('MOBILEPHONECONTRAC', expense)).toMatchObject({ category: 'mobile' });
    expect(itemCategory('Nandos', expense)).toMatchObject({ category: 'eating-out' });
    expect(itemCategory('Vienna', expense)).toBeUndefined();
  });
});

describe('what cash or a cheque paid in looks like it was', () => {
  const withdrawals = [
    { date: '2026-03-02', amount: -80 },
    { date: '2026-03-10', amount: -20 },
  ];
  const ctx = { known, kindOf, withdrawals };

  it('your own cash back when you took out exactly as much in the 30 days before, or as much in all', () => {
    expect(suggestForCash({ amount: 80, date: '2026-03-20' }, ctx)).toEqual({ treatment: 'own', category: 'cash-withdrawal', reason: 'you took out exactly £80.00 in cash on 2 Mar 2026', strong: false });
    expect(suggestForCash({ amount: 100, date: '2026-03-20' }, ctx)).toMatchObject({ treatment: 'own', reason: 'you took out £100.00 in cash in the 30 days before' });
    // Too long after, or more than you took out: often a gift, to check.
    expect(suggestForCash({ amount: 80, date: '2026-04-15' }, ctx)).toEqual({ treatment: 'gift', category: 'gifts-received', reason: 'cash paid in is often a gift, but check', strong: false });
    expect(suggestForCash({ amount: 150, date: '2026-03-20' }, ctx)?.treatment).toBe('gift');
    // A cheque is never cash you took out.
    expect(suggestForCash({ amount: 80, date: '2026-03-20', cheque: true }, ctx)).toEqual({ treatment: 'gift', category: 'gifts-received', reason: 'a cheque paid in is often a gift, but check', strong: false });
  });

  it('a gift from a week before Christmas Day or your birthday to a month after', () => {
    expect(giftOccasion('2026-01-08')).toBe('14 days after Christmas Day');
    expect(giftOccasion('2025-12-20')).toBe('5 days before Christmas Day');
    expect(giftOccasion('2026-12-25')).toBe('on Christmas Day');
    expect(giftOccasion('2026-02-10')).toBeUndefined();
    expect(giftOccasion('2026-05-15', '05-14')).toBe('1 day after your birthday');
    expect(giftOccasion('2026-05-15')).toBeUndefined();
    // Born on 29 February: the 28th in other years.
    expect(giftOccasion('2027-03-02', '02-29')).toBe('2 days after your birthday');
    expect(suggestForCash({ amount: 317, date: '2026-01-08' }, { known, kindOf, withdrawals: [] })).toEqual({ treatment: 'gift', category: 'gifts-received', reason: 'paid in 14 days after Christmas Day, when cash is often a gift', strong: false });
    // Cash you took out to the penny says more than the time of year.
    expect(suggestForCash({ amount: 80, date: '2025-12-30' }, { known, kindOf, withdrawals: [{ date: '2025-12-24', amount: -80 }] })?.treatment).toBe('own');
  });

  it('what you chose before for cash paid in, when most of it was one thing', () => {
    const history = new Map([
      ['cash-withdrawal', 3],
      ['gifts-received', 1],
    ]);
    expect(suggestForCash({ amount: 40, date: '2026-06-10' }, { known, kindOf, withdrawals: [], history })).toEqual({ treatment: 'own', category: 'cash-withdrawal', reason: 'you chose this for 3 of 4 earlier cash payments in', strong: false });
    // Not when it was mixed.
    history.set('gifts-received', 3);
    expect(suggestForCash({ amount: 40, date: '2026-06-10' }, { known, kindOf, withdrawals: [], history })?.reason).toBe('cash paid in is often a gift, but check');
  });
});

describe('the To categorise queue', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-people-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setCategories(defaultCategories());
    await store.setProfile({ ...store.profile, name: 'Jordan Blake' });
    await store.setAccounts([acct('bank', 'current'), acct('card', 'credit_card'), acct('isa', 'stocks_isa')]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('groups each person’s payments however they are written, with what each looks like', async () => {
    // The flights were paid on the card with no category yet: the reference says what was shared.
    await store.addTransactions(
      [
        tx('card', '2026-05-27', -236.5, 'EXAMPLE AIR'),
        tx('bank', '2026-06-01', 118.25, 'FASTER PAYMENTS RECEIPT REF.Flights FROM ALEX REED'),
        tx('bank', '2026-06-20', 25, 'FASTER PAYMENTS RECEIPT REF.xmas FROM A REED'),
        tx('bank', '2026-06-25', -12, 'BILL PAYMENT VIA FASTER PAYMENT TO REED ALEX REFERENCE TRAIN'),
        tx('bank', '2026-07-01', 30, 'FASTER PAYMENTS RECEIPT REF.Sorry FROM ALEX REED', { category: 'gifts-received', categorisedBy: 'user' }),
        tx('bank', '2026-07-02', 50, 'FASTER PAYMENTS RECEIPT REF.top up FROM JORDAN BLAKE'),
        tx('bank', '2026-07-03', 40, 'FASTER PAYMENTS RECEIPT REF.FROM NAN FROM BLAKE M'),
      ],
      't',
    );
    const q = categoriseQueue(store);
    expect(q.people.map((g) => [g.name, g.rows.length, g.decided, g.sharesYourSurname])).toEqual([
      ['Alex Reed', 3, 1, false],
      ['Blake M', 1, 0, true],
    ]);
    const alex = q.people[0]!;
    expect(alex.names).toEqual(['ALEX REED', 'A REED', 'REED ALEX']);
    expect(alex.in).toBe(173.25);
    expect(alex.out).toBe(-12);
    expect(alex.rows.map((r) => [r.date, r.suggestion?.category, r.suggestion?.strong])).toEqual([
      ['2026-06-25', 'trains', false],
      ['2026-06-20', 'gifts-received', true],
      ['2026-06-01', 'flights', true],
    ]);
    // Family money is suggested as a gift only with a "check".
    expect(q.people[1]!.rows[0]!.suggestion).toMatchObject({ treatment: 'gift', strong: false });
    // Nothing was categorised by any of it.
    expect(store.transactions().filter((t) => t.categorisedBy === 'user')).toHaveLength(1);
    // Only payments from a day on, when asked.
    expect(categoriseQueue(store, { from: '2026-06-21' }).people.map((g) => g.rows.length)).toEqual([1, 1]);
  });

  it('suggests a rule from your decisions, sized like them and not wider than they are', async () => {
    await store.addTransactions(
      [
        tx('bank', '2026-03-01', -950, 'THIRD PARTY PAYMENT MADE VIA FASTER PAYMENT TO EXAMPLE LETTINGS LTD REFERENCE FLAT2', { payee: 'Example Lettings Ltd', category: 'rent', categorisedBy: 'user' }),
        tx('bank', '2026-04-01', -950, 'THIRD PARTY PAYMENT MADE VIA FASTER PAYMENT TO EXAMPLE LETTINGS LTD REFERENCE FLAT2', { payee: 'Example Lettings Ltd', category: 'rent', categorisedBy: 'user' }),
        tx('bank', '2026-05-01', -975.5, 'THIRD PARTY PAYMENT MADE VIA FASTER PAYMENT TO EXAMPLE LETTINGS LTD REFERENCE FLAT2', { payee: 'Example Lettings Ltd' }),
        // A key cut, a tenth of the size: not rent.
        tx('bank', '2026-05-09', -12, 'THIRD PARTY PAYMENT MADE VIA FASTER PAYMENT TO EXAMPLE LETTINGS LTD REFERENCE KEY', { payee: 'Example Lettings Ltd' }),
        // Two you put elsewhere make the rule too wide.
        tx('bank', '2026-03-03', -4.5, 'EXAMPLE KIOSK', { payee: 'Example Kiosk', category: 'coffee', categorisedBy: 'user' }),
        tx('bank', '2026-03-04', -4.5, 'EXAMPLE KIOSK', { payee: 'Example Kiosk', category: 'coffee', categorisedBy: 'user' }),
        tx('bank', '2026-03-05', -9, 'EXAMPLE KIOSK NEWS', { payee: 'Example Kiosk News', category: 'news-magazines', categorisedBy: 'user' }),
        tx('bank', '2026-03-06', -4.5, 'EXAMPLE KIOSK', { payee: 'Example Kiosk' }),
      ],
      't',
    );
    const q = categoriseQueue(store);
    expect(q.rules).toHaveLength(2);
    const [rule, kiosk] = q.rules;
    expect(rule).toMatchObject({ payee: 'Example Lettings Ltd', category: 'rent', direction: 'out', from: { by: 'user', count: 2 }, fills: { count: 1, amount: -975.5 } });
    expect(rule!.match).toMatchObject({ field: 'description', op: 'contains', value: 'Example Lettings Ltd', amountMin: 475, amountMax: 1900 });
    // "Example Kiosk" in the description would catch the news stand too: the payee itself doesn't.
    expect(kiosk).toMatchObject({ payee: 'Example Kiosk', category: 'coffee', fills: { count: 1 } });
    expect(kiosk!.match).toMatchObject({ field: 'payee', op: 'equals', value: 'Example Kiosk' });
    // What's left: the key; not what a rule would fill.
    expect(q.payees.map((g) => [g.payee, g.count])).toEqual([['Example Lettings Ltd', 1]]);
  });

  it('suggests a rule from the reader’s categories when you made none, and none for a person', async () => {
    const reader = { categorisedBy: 'ai' as const, category: 'public-transport' };
    await store.addTransactions(
      [
        tx('bank', '2026-03-01', -2, 'EXAMPLE BUSES', reader),
        tx('bank', '2026-03-02', -2, 'EXAMPLE BUSES', reader),
        tx('bank', '2026-03-03', -2, 'EXAMPLE BUSES', reader),
        tx('bank', '2026-03-04', -2.2, 'EXAMPLE BUSES'),
        tx('bank', '2026-03-01', 20, 'FASTER PAYMENTS RECEIPT REF.bus FROM ALEX REED', { category: 'gifts-received', categorisedBy: 'user' }),
        tx('bank', '2026-03-02', 20, 'FASTER PAYMENTS RECEIPT REF.bus FROM ALEX REED', { category: 'gifts-received', categorisedBy: 'user' }),
        tx('bank', '2026-03-03', 20, 'FASTER PAYMENTS RECEIPT REF.bus FROM ALEX REED', { category: 'gifts-received', categorisedBy: 'user' }),
        tx('bank', '2026-03-04', 20, 'FASTER PAYMENTS RECEIPT REF.bus FROM ALEX REED'),
      ],
      't',
    );
    const q = categoriseQueue(store);
    expect(q.rules.map((r) => [r.payee, r.from.by, r.fills.count])).toEqual([['Example Buses', 'ai', 1]]);
    // The person's third payment is theirs to decide, with what you chose before.
    expect(q.people[0]!.rows[0]!.suggestion).toMatchObject({ category: 'gifts-received', strong: false });
  });

  it('lists cash and cheques paid in first, each to decide, and what the app guessed by payee and category', async () => {
    await store.setProfile({ ...store.profile, dateOfBirth: '1990-05-14' });
    const guess = { bankCategory: 'Business Services-Conferences & Training', category: 'courses', categorisedBy: 'bank' as const, payee: 'Example Platform' };
    await store.addTransactions(
      [
        tx('bank', '2026-03-02', -80, 'CASH WITHDRAWAL LINK ATM'),
        tx('bank', '2026-03-20', 80, 'POST OFFICE CASH DEPOSIT', { payee: 'Cash paid in' }),
        tx('bank', '2026-01-08', 317, 'CASH PAID IN AT ATM EXAMPLETOWN'),
        tx('bank', '2026-01-02', 30, 'CHEQUE PAID IN AT EXAMPLETOWN'),
        tx('bank', '2025-06-01', 50, 'CASH PAID IN AT ATM EXAMPLETOWN', { category: 'gifts-received', categorisedBy: 'user' }),
        // Cash paid onto a card is not cash paid in.
        tx('card', '2026-04-01', 60, 'POST OFFICE CASH DEPOSIT'),
        tx('card', '2026-02-14', -459.99, 'EXAMPLE PLATFORM LIMITED*J LONDON', guess),
        tx('card', '2026-02-14', -459.99, 'EXAMPLE PLATFORM LIMITED*J LONDON', guess),
        tx('bank', '2026-03-05', -3.2, 'THE COPPER KETTLE', { payee: 'The Copper Kettle', category: 'eating-out', categorisedBy: 'ai' }),
        // Not guesses: a name the app knows, and a person's payment (theirs to decide).
        tx('bank', '2026-03-06', -12, 'THE COPPER KETTLE', { payee: 'The Copper Kettle', category: 'eating-out', categorisedBy: 'builtin' }),
        tx('bank', '2026-03-07', 25, 'FASTER PAYMENTS RECEIPT REF.xmas FROM A REED', { category: 'gifts-received', categorisedBy: 'ai' }),
      ],
      't',
    );
    const q = categoriseQueue(store);
    const [cash, ...people] = q.people;
    expect(cash).toMatchObject({ key: 'cash', cash: true, name: 'Cash and cheques paid in', decided: 1, in: 477, out: 0 });
    expect(cash!.rows.map((r) => [r.date, r.cheque ?? false, r.suggestion?.treatment, r.suggestion?.reason])).toEqual([
      ['2026-03-20', false, 'own', 'you took out exactly £80.00 in cash on 2 Mar 2026'],
      ['2026-01-08', false, 'gift', 'paid in 14 days after Christmas Day, when cash is often a gift'],
      ['2026-01-02', true, 'gift', 'paid in 8 days after Christmas Day, when a cheque is often a gift'],
    ]);
    expect(people.map((g) => g.name)).toEqual(['A Reed']);
    expect(q.counts.people).toBe(4);
    const cashIds = new Set(cash!.rows.map((r) => r.id));
    expect(q.payees.flatMap((g) => g.ids).filter((id) => cashIds.has(id))).toEqual([]);
    expect(q.payees.map((g) => g.payee)).toContain(cleanPayee('POST OFFICE CASH DEPOSIT'));
    expect(q.guesses.map((g) => [g.payee, g.category, g.count, g.amount, g.by, g.bankSays])).toEqual([
      ['Example Platform', 'courses', 2, -919.98, { bank: 2, ai: 0 }, ['Business Services-Conferences & Training']],
      ['The Copper Kettle', 'eating-out', 1, -3.2, { bank: 0, ai: 1 }, []],
    ]);
    expect(q.guesses[0]!.match).toMatchObject({ field: 'description', op: 'contains', value: 'Example Platform', direction: 'out' });
    expect(q.counts.guesses).toBe(3);
    // Only payments from a day on, when asked.
    expect(categoriseQueue(store, { from: '2026-03-01' }).people[0]!.rows.map((r) => r.date)).toEqual(['2026-03-20']);
  });
});

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };

describe('deciding on the To categorise page', () => {
  let dir: string;
  let app: App;
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const post = (p: string, body: unknown, method = 'POST') => req(p, { method, headers: CSRF, body: JSON.stringify(body) });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-decide-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    await app.ctx.store.setAccounts([acct('bank', 'current')]);
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('confirms each payment as yours and saves who they are, adding the names their payments carry', async () => {
    const { store } = app.ctx;
    const a = tx('bank', '2026-06-20', 25, 'FASTER PAYMENTS RECEIPT REF.xmas FROM A REED');
    const b = tx('bank', '2026-06-21', 30, 'FASTER PAYMENTS RECEIPT REF.train FROM ALEX REED');
    await store.addTransactions([a, b], 't');
    const res = await post('/api/categorise/decisions', {
      decisions: [
        { id: a.id, category: 'gifts-received' },
        { id: b.id, category: 'trains' },
      ],
      person: { name: 'Alex Reed', names: ['A REED', 'ALEX REED'], relation: 'friend', usually: { in: 'repaid' } },
    });
    expect(res.status).toBe(200);
    expect(store.transaction(a.id)).toMatchObject({ category: 'gifts-received', categorisedBy: 'user' });
    expect(store.transaction(b.id)).toMatchObject({ category: 'trains', categorisedBy: 'user' });
    expect(store.people).toEqual([expect.objectContaining({ id: 'alex-reed', name: 'Alex Reed', names: ['A REED', 'ALEX REED'], relation: 'friend', usually: { in: 'repaid' } })]);
    // Saving them again adds names, and keeps what you said unless you change it.
    await post('/api/categorise/decisions', { decisions: [], person: { id: 'alex-reed', name: 'Alex Reed', names: ['REED A'] } });
    expect(store.people[0]).toMatchObject({ names: ['A REED', 'ALEX REED', 'REED A'], relation: 'friend', usually: { in: 'repaid' } });
    expect(JSON.parse(await readFile(path.join(dir, 'data', 'people.json'), 'utf8'))).toMatchObject({ people: [{ id: 'alex-reed' }] });
    // The queue has nothing left of theirs.
    const queue = (await (await req('/api/categorise/queue')).json()) as { people: unknown[] };
    expect(queue.people).toEqual([]);
    expect((await req('/api/people/alex-reed', { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect(store.people).toEqual([]);
    expect(store.transaction(a.id)).toMatchObject({ category: 'gifts-received', categorisedBy: 'user' });
  });

  it('cash paid in is decided as yours with no one to save, and a guess confirmed is yours too', async () => {
    const { store } = app.ctx;
    const cash = tx('bank', '2026-01-08', 317, 'CASH PAID IN AT ATM EXAMPLETOWN');
    const guess = tx('bank', '2026-03-05', -3.2, 'THE COPPER KETTLE', { payee: 'The Copper Kettle', category: 'eating-out', categorisedBy: 'ai' });
    await store.addTransactions([cash, guess], 't');
    const res = await post('/api/categorise/decisions', {
      decisions: [
        { id: cash.id, category: 'gifts-received' },
        { id: guess.id, category: 'eating-out' },
      ],
    });
    expect(res.status).toBe(200);
    expect(store.transaction(cash.id)).toMatchObject({ category: 'gifts-received', categorisedBy: 'user' });
    expect(store.transaction(guess.id)).toMatchObject({ category: 'eating-out', categorisedBy: 'user' });
    expect(store.people).toEqual([]);
    const queue = (await (await req('/api/categorise/queue')).json()) as { people: unknown[]; guesses: unknown[] };
    expect(queue).toMatchObject({ people: [], guesses: [] });
  });

  it('refuses a category that doesn’t exist, before changing anything', async () => {
    const a = tx('bank', '2026-06-20', 25, 'FASTER PAYMENTS RECEIPT REF.xmas FROM A REED');
    await app.ctx.store.addTransactions([a], 't');
    expect((await post('/api/categorise/decisions', { decisions: [{ id: a.id, category: 'nonsense' }], person: { name: 'Alex Reed' } })).status).toBe(400);
    expect(app.ctx.store.transaction(a.id)?.category).toBeUndefined();
    expect(app.ctx.store.people).toEqual([]);
  });

  it('a rule made there, or anywhere, applies to the payments it matches and nothing else', async () => {
    const { store } = app.ctx;
    const kiosk = tx('bank', '2026-06-01', -4.5, 'EXAMPLE KIOSK 1');
    const kiosk2 = tx('bank', '2026-06-02', -4.5, 'EXAMPLE KIOSK 2');
    // Something the app would categorise differently now, which only re-applying everything changes.
    const other = tx('bank', '2026-06-03', -9.99, 'NETFLIX.COM', { category: 'other-expense', categorisedBy: 'builtin' });
    await store.addTransactions([kiosk, kiosk2, other], 't');
    const res = await post('/api/categorise/decisions', { decisions: [{ id: kiosk.id, category: 'coffee' }], rule: { match: { field: 'description', op: 'contains', value: 'Example Kiosk', caseSensitive: false, direction: 'out' }, category: 'coffee' } });
    const body = (await res.json()) as { updated: number; rule: { id: string }; ruleApplied: { recategorised: number } };
    expect(body).toMatchObject({ updated: 1, ruleApplied: { recategorised: 1 } });
    expect(store.transaction(kiosk.id)).toMatchObject({ category: 'coffee', categorisedBy: 'user' });
    expect(store.transaction(kiosk2.id)).toMatchObject({ category: 'coffee', categorisedBy: 'rule', ruleId: body.rule.id });
    expect(store.transaction(other.id)).toMatchObject({ category: 'other-expense', categorisedBy: 'builtin' });
    // Changed to match nothing, the rule takes back what it gave.
    await post(`/api/rules/${body.rule.id}`, { match: { field: 'description', op: 'contains', value: 'nothing like it', caseSensitive: false }, apply: true }, 'PATCH');
    expect(store.transaction(kiosk2.id)?.categorisedBy).not.toBe('rule');
    expect(store.transaction(other.id)).toMatchObject({ category: 'other-expense', categorisedBy: 'builtin' });
  });
});

describe('format v9: money paid back counts against spending', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-migrate9-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('marks refunds and adds "Paid back to you" beside them, then counts both as less spending', async () => {
    const data = path.join(dir, 'data');
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 8, baseCurrency: 'GBP', createdAt: stamp }));
    const old = defaultCategories()
      .filter((c) => c.id !== 'repaid')
      .map(({ offsetsSpending: _o, ...c }) => c);
    await writeFile(path.join(data, 'categories.json'), JSON.stringify({ categories: old }));
    expect(await runMigrations(data, () => undefined)).toMatchObject({ from: 8, to: 9 });
    const store = await Store.open(data);
    expect(store.issues).toEqual([]);
    const ids = store.categories.map((c) => c.id);
    expect(ids.indexOf('repaid')).toBe(ids.indexOf('refunds') + 1);
    expect(store.categories.find((c) => c.id === 'repaid')).toMatchObject({ name: 'Paid back to you', parent: 'income', kind: 'income', system: true, offsetsSpending: true });
    expect(store.categories.find((c) => c.id === 'refunds')).toMatchObject({ offsetsSpending: true });
    expect(store.people).toEqual([]);
    expect(JSON.parse(await readFile(path.join(data, 'people.json'), 'utf8'))).toEqual({ $schema: '../schemas/people.schema.json', people: [] });
    const index = new CategoryIndex(store.categories);
    const bank = acct('bank', 'current');
    expect(classifyFlow(tx('bank', '2026-06-01', 30, 'x', { category: 'repaid' }), index, bank)).toBe('spending');
    expect(classifyFlow(tx('bank', '2026-06-01', 30, 'x', { category: 'trains' }), index, bank)).toBe('spending');
    expect(classifyFlow(tx('bank', '2026-06-01', 30, 'x', { category: 'gifts-received' }), index, bank)).toBe('income');
  });
});
