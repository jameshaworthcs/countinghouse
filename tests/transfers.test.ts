// Transfers: what the descriptions say decides which rows are the same money (src/server/enrich.ts,
// src/shared/categorise.ts). The shapes are from real statements (a sort code and account number,
// a card number in a direct debit's reference, payments to your own name); every name and number
// here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoriserFor } from '../src/server/categoriser';
import { enrich, linkTransfers, reapply } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { buildDraft } from '../src/server/ingest/draft';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { Categoriser, longNumbers, ownNamePattern } from '../src/shared/categorise';
import { ExtractionSchema, type Account, type Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const accounts = [
  acct('bank', 'current', { institutionId: 'santander', last4: '4455' }),
  acct('saver', 'savings', { institutionId: 'chase', last4: '6612' }),
  acct('lisa', 'lisa', { institutionId: 'aj-bell' }),
  acct('easy', 'savings', { institutionId: 'aldermore', last4: '7788' }),
  acct('aqua', 'credit_card', { institutionId: 'aqua', last4: '3311' }),
  acct('tesco', 'credit_card', { institutionId: 'tesco-bank' }),
  acct('amex', 'credit_card', { institutionId: 'amex', last4: '5500' }),
  // A number like a year: a date in a description never names it.
  acct('odd', 'savings', { last4: '2025' }),
];

describe('reading a description for your own accounts', () => {
  const c = new Categoriser([], new CategoryIndex(defaultCategories()), accounts, [], { ownerName: 'Sam Robin Taylor' });
  const cat = (accountId: string, description: string, amount: number) => c.categorise({ accountId, description, amount });

  it('by the number another bank prints for it', () => {
    expect(cat('bank', 'DIRECT DEBIT PAYMENT TO AQUA CREDIT CARD REF 3900000012343311, MANDATE NO 0004', -42.1)).toMatchObject({ category: 'credit-card-payment', counterpartyAccountId: 'aqua', categorisedBy: 'transfer' });
    expect(cat('easy', 'To 12-34-56 00012344455', -1000)).toMatchObject({ category: 'transfer', counterpartyAccountId: 'bank' });
    // The number names one account, where the bank's name alone would not.
    expect(cat('bank', 'FASTER PAYMENTS RECEIPT REF.EAV1027788TAY FROM ALDERMORE BANK', 1000)).toMatchObject({ counterpartyAccountId: 'easy' });
    expect(cat('bank', 'CARD PAYMENT TO EXAMPLE SHOP,12.34 GBP, RATE 1.00/GBP ON 30-10-2025', -12.34).counterpartyAccountId).toBeUndefined();
    expect(longNumbers('To 12-34-56 00012344455 ON 14-03-2026')).toEqual(['00012344455']);
    expect(longNumbers('REF 4000 1234 5678 9010')).toEqual(['4000123456789010']);
  });

  it('by your name after “to” or “from”: your money moving, not spending or income', () => {
    for (const d of ['BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7', 'FASTER PAYMENTS RECEIPT REF.TOPUP FROM S Taylor', 'STANDING ORDER TO SAM ROBIN TAYLOR REFERENCE POT', 'TRANSFER FROM SR TAYLOR', 'Payment from TAYLOR S', 'From MR S. TAYLOR - SAVING', 'FASTER PAYMENTS RECEIPT REF.E FROM TAYLOR SR']) {
      expect(cat('bank', d, -100), d).toMatchObject({ category: 'transfer', categorisedBy: 'transfer' });
    }
    // Paying the card from yourself is a card payment.
    expect(cat('amex', 'PAYMENT FROM SAM TAYLOR', 100)).toMatchObject({ category: 'credit-card-payment' });
    // A payer naming you as the payee is not your own money.
    expect(cat('bank', 'BANK GIRO CREDIT REF ACME LTD 4242, SAM TAYLOR', 75).category).not.toBe('transfer');
    expect(cat('bank', 'TO SAMUEL TAYLORSON', -5).category).not.toBe('transfer');
    // Someone else's initials after your surname: family, not you.
    expect(cat('bank', 'FASTER PAYMENTS RECEIPT REF.xmas FROM TAYLOR MJ', 25).category).not.toBe('transfer');
    expect(ownNamePattern('Cher')).toBeNull();
    expect(new Categoriser([], new CategoryIndex(defaultCategories()), accounts, []).categorise({ accountId: 'bank', description: 'TO SAM TAYLOR', amount: -1 }).category).not.toBe('transfer');
  });
});

describe('linking transfers', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-transfers-'));
    store = await Store.open(dir);
    await store.setCategories(defaultCategories());
    await store.setAccounts(accounts);
    await store.setProfile({ ...store.profile, name: 'Sam Robin Taylor' });
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Rows as an import would add them: categorised, then linked to what was committed before. */
  const commit = async (rows: [string, string, number, string][]) => {
    const c = categoriserFor(store);
    const seen = new Map<string, number>();
    const txs = rows.map(([accountId, date, amount, description]): Transaction => {
      const key = `${accountId}|${date}|${amount}|${description}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const r = c.categorise({ accountId, description, amount });
      return {
        id: transactionId(accountId, date, amount, description, occurrence),
        accountId,
        date,
        amount,
        currency: 'GBP',
        description,
        source: {},
        createdAt: stamp,
        ...(r.category ? { category: r.category, categorisedBy: r.categorisedBy } : {}),
        ...(r.counterpartyAccountId ? { counterpartyAccountId: r.counterpartyAccountId } : {}),
      };
    });
    await store.addTransactions(txs, 'test');
    await linkTransfers(store, txs.map((t) => t.id), 'test');
    return txs.map((t) => t.id);
  };
  const partner = (id: string) => {
    const t = store.transaction(id)!;
    return t.transferGroup ? store.transactions().find((x) => x.transferGroup === t.transferGroup && x.id !== id) : undefined;
  };

  it('does not link on one side’s transfer category alone', async () => {
    // Money back from a savings pot, and the same £5 spent from the card that day.
    const [fromPot] = await commit([['bank', '2026-04-01', 5, 'FROM SAVINGS POT']]);
    expect(store.transaction(fromPot!)!.category).toBe('savings-transfer');
    const [spent] = await commit([['aqua', '2026-04-01', -5, 'EXAMPLE EXCHANGE LTD']]);
    expect(partner(fromPot!)).toBeUndefined();
    expect(partner(spent!)).toBeUndefined();
  });

  it('pairs a busy day’s moves by what each row says, whichever statement comes first', async () => {
    // The card payment to AJ Bell comes first: first come, it took the saver's £1,000 before.
    const [ajbell, saving1, saving2, fromEasy, big] = await commit([
      ['bank', '2026-03-03', -1000, 'AJ BELL (VIA APPLE PAY), ON 03-03-2026'],
      ['bank', '2026-03-03', -1000, 'BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7'],
      ['bank', '2026-03-03', -1000, 'BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7'],
      ['bank', '2026-03-02', 1000, 'FASTER PAYMENTS RECEIPT REF.EAV1027788TAY FROM ALDERMORE BANK'],
      ['bank', '2026-03-03', -12000, 'BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7'],
    ]);
    // The saver's statement: four deposits from you, dated the day before.
    const [in1, in2, inBig] = await commit([
      ['saver', '2026-03-02', 1000, 'From SAM TAYLOR - SAVING'],
      ['saver', '2026-03-02', 1000, 'From SAM TAYLOR - SAVING'],
      ['saver', '2026-03-02', 12000, 'From SAM TAYLOR - SAVING'],
    ]);
    // The easy-access account names the bank's account; the ISA took the card payment.
    const [toBank] = await commit([['easy', '2026-03-02', -1000, 'To 12-34-56 00012344455']]);
    const [lisaIn] = await commit([['lisa', '2026-03-03', 1000, 'Debit card payment']]);

    expect(new Set([partner(in1!)?.id, partner(in2!)?.id])).toEqual(new Set([saving1, saving2]));
    expect(partner(inBig!)?.id).toBe(big);
    expect(partner(toBank!)?.id).toBe(fromEasy);
    expect(partner(lisaIn!)?.id).toBe(ajbell);
    expect(store.transaction(ajbell!)).toMatchObject({ category: 'investment-transfer', counterpartyAccountId: 'lisa' });
  });

  it('a new statement’s draft picks the other leg already stored by what it says', async () => {
    const [saving, ajbell] = await commit([
      ['bank', '2026-03-03', -1000, 'BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7'],
      ['bank', '2026-03-03', -1000, 'AJ BELL (VIA APPLE PAY), ON 03-03-2026'],
    ]);
    const extraction = ExtractionSchema.parse({ documentType: 'investment_statement', accounts: [{ accountType: 'lisa', transactions: [{ date: '2026-03-03', description: 'Debit card payment', amount: 1000 }] }] });
    const document = { id: 'doc_0000000000000001', sha256: '0'.repeat(64), fileName: 'lisa.pdf', mediaType: 'application/pdf', size: 1 };
    const draft = buildDraft(extraction, { store, document, hintAccountId: 'lisa', uploadedOn: '2026-09-30' });
    expect(draft.sections[0]!.transactions[0]!.transferMatch).toBe(ajbell);
    expect(store.transaction(saving!)!.transferGroup).toBeUndefined();
  });

  it('never links a payment you put in a category that is not a transfer', async () => {
    // £100 from your own name into the saver, which you said was a gift; then £100 out of the bank
    // naming the saver by its number: no transfer.
    const [gift] = await commit([['saver', '2026-05-02', 100, 'FROM S R TAYLOR']]);
    await store.updateTransactions([{ id: gift!, patch: { category: 'gifts-received', categorisedBy: 'user' } }], 'mine');
    const [out] = await commit([['bank', '2026-05-01', -100, 'To 09-01-28 00012346612']]);
    expect(partner(out!)).toBeUndefined();
    expect(store.transaction(gift!)).toMatchObject({ category: 'gifts-received', categorisedBy: 'user' });
    // One you put in a transfer category still links.
    const [moved] = await commit([['saver', '2026-06-02', 250, 'FROM S R TAYLOR']]);
    await store.updateTransactions([{ id: moved!, patch: { category: 'savings-transfer', categorisedBy: 'user' } }], 'mine');
    const [out2] = await commit([['bank', '2026-06-01', -250, 'To 09-01-28 00012346612']]);
    expect(partner(out2!)?.id).toBe(moved);
  });

  it('never links money the app knows as someone else’s: a prize is not the money you moved', async () => {
    // £100 out of the bank to your own name, and a £100 Premium Bonds prize reinvested the next day.
    await store.setAccounts([...accounts, acct('bonds', 'premium_bonds', { institutionId: 'ns-and-i' })]);
    const [out] = await commit([['bank', '2026-04-01', -100, 'Third party payment made via Faster Payment to Sam Taylor']]);
    expect(store.transaction(out!)!.category).toBe('transfer');
    const [prize] = await commit([['bonds', '2026-04-02', 100, 'Auto prize reinvestment']]);
    expect(store.transaction(prize!)).toMatchObject({ category: 'other-income', categorisedBy: 'builtin' });
    expect(partner(prize!)).toBeUndefined();
    // Nor does a re-run link them; a deposit, which names no one either, still pairs with it.
    await enrich(store);
    expect(partner(prize!)).toBeUndefined();
    const [deposit] = await commit([['bonds', '2026-04-03', 100, 'Faster Payment deposit']]);
    expect(partner(deposit!)?.id).toBe(out);
  });

  it('never links a row that names another of your accounts', async () => {
    // A direct debit to the Tesco Bank card, and a £5 refund on the Amex card two days before.
    const [refund] = await commit([['amex', '2026-02-08', 7.5, 'DELIVEROO']]);
    const [dd] = await commit([['bank', '2026-02-10', -7.5, 'DIRECT DEBIT PAYMENT TO TESCO BANK REF 4000999988887777, MANDATE NO 0002']]);
    expect(store.transaction(dd!)).toMatchObject({ category: 'credit-card-payment', counterpartyAccountId: 'tesco' });
    expect(store.transaction(dd!)!.transferGroup).toBeUndefined();
    expect(store.transaction(refund!)!.transferGroup).toBeUndefined();
  });
});

describe('two of your accounts under one number', () => {
  // A fixed rate that matured into easy access at the same bank, under the same number.
  const linked = [
    acct('bank', 'current', { name: 'Bank current account', institutionId: 'santander', last4: '4455' }),
    acct('fixed', 'savings', { name: 'Example 2 Year Fixed', institutionId: 'aldermore', last4: '7788', status: 'closed', openedOn: '2023-09-14', closedOn: '2025-09-12' }),
    acct('easy', 'savings', { name: 'Example Easy Access', institutionId: 'aldermore', last4: '7788', openedOn: '2025-09-13', continues: { accountId: 'fixed', from: '2025-09-13' } }),
  ];
  const c = new Categoriser([], new CategoryIndex(defaultCategories()), linked, []);
  const cat = (description: string, amount: number, date?: string) => c.categorise({ accountId: 'bank', description, amount, ...(date ? { date } : {}) });

  it('a row naming the number is the one open on its day', () => {
    expect(cat('BILL PAYMENT VIA FASTER PAYMENT TO ALDERMORE BANK REFERENCE 1027788', -500, '2023-09-14')).toMatchObject({ counterpartyAccountId: 'fixed', payee: 'Example 2 Year Fixed' });
    expect(cat('FASTER PAYMENTS RECEIPT REF.EAV1027788TAY FROM ALDERMORE BANK', 1000, '2025-10-02')).toMatchObject({ counterpartyAccountId: 'easy', payee: 'Example Easy Access' });
    // Days after the fixed rate closed: the easy access, open that day.
    expect(cat('FASTER PAYMENTS RECEIPT REF.EAV1027788TAY FROM ALDERMORE BANK', 1000, '2025-09-16')).toMatchObject({ counterpartyAccountId: 'easy' });
  });

  it('a row naming only the bank can be either while both were open, and never a long-closed one', () => {
    // The bank's name alone says neither which product nor even another account: it may be a reference.
    expect(c.ownAccountsMentioned('bank', 'BILL PAYMENT VIA FASTER PAYMENT TO ALDERMORE BANK', true, undefined, '2023-09-14').map((a) => a.id)).toEqual(['fixed', 'easy']);
    expect(cat('BILL PAYMENT VIA FASTER PAYMENT TO ALDERMORE BANK', -500, '2023-09-14')).not.toHaveProperty('counterpartyAccountId');
    // Long after it closed, a closed account is never named; with no date to go by, it is left out.
    expect(c.ownAccountsMentioned('bank', 'TO ALDERMORE BANK', true, undefined, '2026-03-01').map((a) => a.id)).toEqual(['easy']);
    expect(c.ownAccountsMentioned('bank', 'TO ALDERMORE BANK').map((a) => a.id)).toEqual(['easy']);
  });

  describe('a linked transfer’s payee', () => {
    let dir: string;
    let store: Store;
    const out = { id: transactionId('bank', '2023-09-14', -500, 'TO ALDERMORE', 0), accountId: 'bank', date: '2023-09-14', amount: -500, currency: 'GBP', description: 'TO ALDERMORE', source: {}, createdAt: stamp };
    const into = { id: transactionId('fixed', '2023-09-14', 500, 'Faster Payment', 0), accountId: 'fixed', date: '2023-09-14', amount: 500, currency: 'GBP', description: 'Faster Payment', source: {}, createdAt: stamp };
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'finance-linked-payee-'));
      store = await Store.open(dir);
      await store.setCategories(defaultCategories());
      await store.setAccounts(linked);
    });
    afterEach(async () => {
      store.stopWatching();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    it('takes the name of the account it is linked with, when it named another of yours', async () => {
      const group = 'tg_00000000000000a1';
      // Read when the easy access was the only account of that bank's the app knew.
      await store.addTransactions(
        [
          { ...out, payee: 'Example Easy Access', category: 'savings-transfer', categorisedBy: 'transfer', transferGroup: group, counterpartyAccountId: 'fixed' },
          { ...into, payee: 'Faster Payment', category: 'transfer', categorisedBy: 'transfer', transferGroup: group, counterpartyAccountId: 'bank' },
        ],
        't',
      );
      const preview = await enrich(store, { dryRun: true, detail: true });
      expect(preview.accountPayees).toEqual([out.id]);
      expect(preview.changes).toEqual([expect.objectContaining({ id: out.id, payee: { from: 'Example Easy Access', to: 'Example 2 Year Fixed' } })]);
      // Left as it is this time, it stays; applied, it takes the name.
      await reapply(store, { skip: [out.id] });
      expect(store.transaction(out.id)!.payee).toBe('Example Easy Access');
      await reapply(store);
      expect(store.transaction(out.id)).toMatchObject({ payee: 'Example 2 Year Fixed', category: 'savings-transfer', transferGroup: group });
      // A payee you set is yours.
      await store.updateTransactions([{ id: out.id, patch: { payee: 'Example Easy Access', payeeSetBy: 'user' } }], 't');
      expect((await enrich(store, { dryRun: true, detail: true })).accountPayees).toBeUndefined();
    });

    it('is put right when the two are linked', async () => {
      await store.addTransactions([{ ...out, payee: 'Example Easy Access', category: 'savings-transfer', categorisedBy: 'transfer' }, { ...into, category: 'transfer', categorisedBy: 'transfer' }], 't');
      expect(await linkTransfers(store, [out.id, into.id], 't')).toBe(1);
      expect(store.transaction(out.id)).toMatchObject({ payee: 'Example 2 Year Fixed', counterpartyAccountId: 'fixed' });
    });
  });
});
