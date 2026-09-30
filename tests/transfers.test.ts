// Transfers: what the descriptions say decides which rows are the same money (src/server/enrich.ts,
// src/shared/categorise.ts). The shapes are from real statements (a sort code and account number,
// a card number in a direct debit's reference, payments to your own name); every name and number
// here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoriserFor } from '../src/server/categoriser';
import { linkTransfers } from '../src/server/enrich';
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
    for (const d of ['BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE SAVING , MANDATE NO 7', 'FASTER PAYMENTS RECEIPT REF.TOPUP FROM S Taylor', 'STANDING ORDER TO SAM ROBIN TAYLOR REFERENCE POT', 'TRANSFER FROM SR TAYLOR', 'Payment from TAYLOR S', 'From MR S. TAYLOR - SAVING']) {
      expect(cat('bank', d, -100), d).toMatchObject({ category: 'transfer', categorisedBy: 'transfer' });
    }
    // Paying the card from yourself is a card payment.
    expect(cat('amex', 'PAYMENT FROM SAM TAYLOR', 100)).toMatchObject({ category: 'credit-card-payment' });
    // A payer naming you as the payee is not your own money.
    expect(cat('bank', 'BANK GIRO CREDIT REF ACME LTD 4242, SAM TAYLOR', 75).category).not.toBe('transfer');
    expect(cat('bank', 'TO SAMUEL TAYLORSON', -5).category).not.toBe('transfer');
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
    await rm(dir, { recursive: true, force: true });
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

  it('never links a row that names another of your accounts', async () => {
    // A direct debit to the Tesco Bank card, and a £5 refund on the Amex card two days before.
    const [refund] = await commit([['amex', '2026-02-08', 7.5, 'DELIVEROO']]);
    const [dd] = await commit([['bank', '2026-02-10', -7.5, 'DIRECT DEBIT PAYMENT TO TESCO BANK REF 4000999988887777, MANDATE NO 0002']]);
    expect(store.transaction(dd!)).toMatchObject({ category: 'credit-card-payment', counterpartyAccountId: 'tesco' });
    expect(store.transaction(dd!)!.transferGroup).toBeUndefined();
    expect(store.transaction(refund!)!.transferGroup).toBeUndefined();
  });
});
