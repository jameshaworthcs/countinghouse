// A document that shows a payment already recorded and knows more about it (docs/INGESTION.md,
// "Adding detail to a recorded payment"): what it fills in, what it never replaces, and how the
// import, the record and the nothing-new check see it. Also cash from a machine, which is never a
// transfer to the bank that runs it. All data here is invented.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoriserFor } from '../src/server/categoriser';
import { commitDraft } from '../src/server/ingest/commit';
import { classifyDuplicates } from '../src/server/ingest/dedup';
import { buildDraft } from '../src/server/ingest/draft';
import { assessNovelty } from '../src/server/ingest/novelty';
import { Store } from '../src/server/store';
import { detailToAdd, fieldsInWords, fillIn, stillAdds, type Shown } from '../src/shared/detail';
import { ExtractionSchema, type Account, type Draft, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const tx = (id: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id, accountId: 'current', date, amount, currency: 'GBP', description, source: { importId: 'imp_20260930_073000_0e01' }, createdAt: stamp, ...extra });
const shown = (date: string, amount: number, description: string, extra: Partial<Shown> = {}): Shown => ({ date, amount, description, ...extra });

// An export's rows: when each payment cleared, its type in one column, the running balance.
const cash = tx('tx_00000000000000c1', '2026-09-16', -34.48, 'Cash withdrawal, Example Bank, Faro', { time: '09:02', type: 'Cash withdrawal | EUR 40.00 | FX rate £1 = €1.1600', balanceAfter: 1344.90 });
const card = tx('tx_00000000000000c2', '2026-09-23', -87.64, 'To Revolving Line Account', { time: '14:07', type: 'Transfer', balanceAfter: 1257.26 });

describe('what a document adds to a recorded payment', () => {
  it('an app dating a payment earlier gives the day it was made, with that day’s time', () => {
    const found = detailToAdd(shown('2026-09-14', -34.48, 'Example Bank', { detail: { time: '21:15', type: 'Cash withdrawal' } }), cash);
    expect(found.fields).toEqual({ transactionDate: '2026-09-14', transactionTime: '21:15' });
    // Its shorter words are within the record's: nothing to point out.
    expect(found.differs).toEqual([]);
  });

  it('fills in what the record lacks, and points out, without changing, what it says differently', () => {
    const found = detailToAdd(shown('2026-09-23', -87.64, "Sam's Account to Credit card", { detail: { time: '14:07', type: 'Transfer', counterpartyName: 'Credit card' } }), card);
    expect(found.fields).toEqual({ counterpartyName: 'Credit card' });
    expect(found.differs).toEqual([{ field: 'description', recorded: 'To Revolving Line Account', here: "Sam's Account to Credit card" }]);
  });

  it('never replaces a value: another time, type or bank id is a difference', () => {
    const found = detailToAdd(shown('2026-09-23', -87.64, 'To Revolving Line Account', { detail: { time: '14:10', type: 'Card repayment', sourceId: 'ABC' } }), { ...card, sourceId: 'XYZ' });
    expect(found.fields).toEqual({});
    expect(found.differs.map((d) => d.field)).toEqual(['time', 'type', 'sourceId']);
  });

  it('a later date says nothing about when it was made; a balance only comes from the same day', () => {
    const plain = tx('tx_00000000000000c3', '2026-09-10', -20, 'CORNER SHOP');
    const later = detailToAdd(shown('2026-09-12', -20, 'CORNER SHOP', { balanceAfter: 480, detail: { time: '09:00' } }), plain);
    expect(later.fields).toEqual({});
    expect(later.differs).toEqual([{ field: 'date', recorded: '2026-09-10', here: '2026-09-12' }]);
    const sameDay = detailToAdd(shown('2026-09-10', -20, 'CORNER SHOP', { balanceAfter: 480, detail: { time: '09:00' } }), plain);
    expect(sameDay.fields).toEqual({ time: '09:00', balanceAfter: 480 });
    // A printed purchase date beside the posting date.
    expect(detailToAdd(shown('2026-09-10', -20, 'CORNER SHOP', { detail: { transactionDate: '2026-09-08' } }), plain).fields).toEqual({ transactionDate: '2026-09-08' });
  });

  it('adds nothing from a pending row, and a merchant field by field', () => {
    expect(detailToAdd(shown('2026-09-16', -34.48, 'Example Bank', { pending: true, detail: { time: '21:15' } }), cash).fields).toEqual({});
    const withMerchant = { ...card, merchant: { name: 'Example Café' } };
    const found = detailToAdd(shown('2026-09-23', -87.64, 'To Revolving Line Account', { detail: { merchant: { name: 'EXAMPLE CAFE', city: 'Leeds' } } }), withMerchant);
    expect(found.fields).toEqual({ merchant: { city: 'Leeds' } });
    expect(fillIn(withMerchant, found.fields).patch).toEqual({ merchant: { name: 'Example Café', city: 'Leeds' } });
  });

  it('fills in only what is still empty, a time only with its day, and only what you saw', () => {
    expect(fillIn({ ...cash, transactionDate: '2026-09-13' }, { transactionDate: '2026-09-14', transactionTime: '21:15' })).toEqual({ patch: {}, added: [] });
    expect(fillIn(cash, { transactionTime: '21:15', transactionDate: '2026-09-14' })).toEqual({ patch: { transactionDate: '2026-09-14', transactionTime: '21:15' }, added: ['transactionDate', 'transactionTime'] });
    expect(stillAdds({ counterpartyName: 'Credit card', time: '14:07' }, { counterpartyName: 'Credit card', reference: 'NEW' })).toEqual({ counterpartyName: 'Credit card' });
    expect(stillAdds({ merchant: { name: 'A', city: 'Leeds' } }, { merchant: { name: 'A', city: 'York' } })).toEqual({ merchant: { name: 'A' } });
    // A foreign amount is one value: half of one is nothing.
    expect(stillAdds({ original: { amount: -50, currency: 'EUR' } }, { original: { amount: -50, currency: 'USD' } })).toEqual({});
    expect(fieldsInWords(['transactionDate', 'transactionTime', 'counterpartyName'])).toBe('the day it was made and the other party');
  });
});

describe('the same date, amount and time', () => {
  it('is the same payment, by the record’s posting or by when it was made; never a midnight every row has', () => {
    const made = { ...cash, transactionDate: '2026-09-14', transactionTime: '21:15' };
    expect(classifyDuplicates([{ date: '2026-09-23', amount: -87.64, description: 'Something else', time: '14:07' }], [card])[0]).toEqual({ status: 'duplicate', duplicateOf: card.id, reason: 'Same date, amount and time' });
    expect(classifyDuplicates([{ date: '2026-09-14', amount: -34.48, description: 'Example Bank', time: '21:15' }], [made])[0]).toMatchObject({ status: 'duplicate', duplicateOf: cash.id });
    const midnight = { ...card, time: '00:00' };
    expect(classifyDuplicates([{ date: '2026-09-23', amount: -87.64, description: 'Something else', time: '00:00' }], [midnight])[0]!.status).not.toBe('duplicate');
    // Balances after them that differ: two payments, whatever the clock says.
    expect(classifyDuplicates([{ date: '2026-09-23', amount: -87.64, description: 'Something else', time: '14:07', balanceAfter: 5 }], [card])[0]!.status).toBe('new');
  });

  it('a few days from when it was made counts as near', () => {
    const made = { ...cash, date: '2026-09-24', transactionDate: '2026-09-14' };
    expect(classifyDuplicates([{ date: '2026-09-16', amount: -34.48, description: 'Example Bank' }], [made])[0]).toMatchObject({ status: 'possible_duplicate', duplicateOf: cash.id });
  });
});

describe('an import that knows more about recorded payments', () => {
  let dir: string;
  let store: Store;
  let workFile: string;
  const account = (id: string, extra: Partial<Account> = {}): Account => ({ id, name: id === 'current' ? 'Current' : 'Example Bank saver', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
  const record = (n: number): ImportRecord => ({
    id: `imp_20260930_200000_0d0${n}`,
    status: 'review',
    createdAt: '2026-09-30T20:00:00+01:00',
    updatedAt: '2026-09-30T20:00:00+01:00',
    origin: 'upload',
    hintAccountId: 'current',
    document: { id: `doc_00000000000000d${n}`, sha256: `d${n}`.repeat(32), fileName: `IMG_000${n}.png`, mediaType: 'image/png', size: 1 },
    extraction: { warnings: [] },
  });
  // The app's activity list: the cash by when it was taken out, the card payment by its own name.
  const screen = ExtractionSchema.parse({
    documentType: 'transactions_screenshot',
    accounts: [
      {
        accountName: 'Current',
        transactions: [
          { date: '2026-09-14', time: '21:15', description: 'Example Bank', amount: -34.48, type: 'Cash withdrawal' },
          { date: '2026-09-23', time: '14:07', description: "Sam's Account to Credit card", amount: -87.64, type: 'Transfer', counterpartyName: 'Credit card' },
        ],
      },
    ],
  });
  const draftOf = (extraction = screen, n = 1) => buildDraft(extraction, { store, document: record(n).document, hintAccountId: 'current', uploadedOn: '2026-09-30' });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-detail-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([account('current'), account('saver', { type: 'savings', aliases: ['Example Bank'] })]);
    await store.addTransactions([cash, { ...card, category: 'holidays', categorisedBy: 'user' }], 'test: an export');
    workFile = path.join(dir, 'IMG.png');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('offers what each row adds: ticked by itself when the match is certain, or close with nothing in conflict', () => {
    const [cashRow, cardRow] = draftOf().sections[0]!.transactions;
    // A possible duplicate on like words, adding only when the cash was taken out: ticked.
    expect(cashRow).toMatchObject({ status: 'possible_duplicate', duplicateOf: cash.id, include: false, adds: { include: true, fields: { transactionDate: '2026-09-14', transactionTime: '21:15' }, differs: [] } });
    // The same minute on the same day: certain.
    expect(cardRow).toMatchObject({ status: 'duplicate', duplicateOf: card.id, include: false, adds: { include: true, fields: { counterpartyName: 'Credit card' } } });
    expect(cardRow!.adds!.differs).toEqual([{ field: 'description', recorded: 'To Revolving Line Account', here: "Sam's Account to Credit card" }]);
    // Neither is a new payment: the saver's alias is in the cash row, but cash is cash.
    expect(cashRow!.category).toBe('cash-withdrawal');
  });

  it('fills them in on commit, with where they came from, and records nothing twice', async () => {
    const draft = draftOf();
    draft.sections[0]!.transactions[0]!.adds!.include = true;
    const done = await commitDraft(store, { record: record(1), draft, workFile });
    expect(store.transactions('current')).toHaveLength(2);
    const filled = store.transaction(cash.id)!;
    expect(filled).toMatchObject({ date: '2026-09-16', time: '09:02', transactionDate: '2026-09-14', transactionTime: '21:15', description: cash.description, type: cash.type });
    expect(filled.seenIn).toHaveLength(1);
    expect(filled.seenIn![0]).toMatchObject({ importId: record(1).id, documentId: record(1).document.id, row: 0, added: ['transactionDate', 'transactionTime'] });
    expect(filled.seenIn![0]!.said).toBeUndefined();
    const paid = store.transaction(card.id)!;
    expect(paid).toMatchObject({ counterpartyName: 'Credit card', description: 'To Revolving Line Account', category: 'holidays', categorisedBy: 'user' });
    expect(paid.seenIn![0]).toMatchObject({ added: ['counterpartyName'], said: { description: "Sam's Account to Credit card" } });
    expect(done.result).toMatchObject({
      transactionsAdded: 0,
      transactionsDetailed: [
        { id: cash.id, added: ['transactionDate', 'transactionTime'] },
        { id: card.id, added: ['counterpartyName'] },
      ],
    });
  });

  it('then the same screen again is nothing new: its rows match by when they were made, and add nothing', async () => {
    const draft = draftOf();
    draft.sections[0]!.transactions[0]!.adds!.include = true;
    await commitDraft(store, { record: record(1), draft, workFile });
    const again: ImportRecord = { ...record(2), draft: draftOf(screen, 2) };
    expect(again.draft!.sections[0]!.transactions.map((t) => [t.status, t.adds])).toEqual([
      ['duplicate', undefined],
      ['duplicate', undefined],
    ]);
    expect(assessNovelty([again], store).get(again.id)?.reason).toMatch(/already imported/);
  });

  it('is not nothing new while it has something to add, and one upload beside it adding the same covers it', () => {
    const first: ImportRecord = { ...record(1), draft: draftOf(screen, 1) };
    const second: ImportRecord = { ...record(2), createdAt: '2026-09-30T20:05:00+01:00', draft: draftOf(screen, 2) };
    const novelty = assessNovelty([first, second], store);
    expect(novelty.has(first.id)).toBe(false);
    expect(novelty.get(second.id)?.reason).toMatch(/also on IMG_0001\.png, with the details it adds/);
  });

  it('adds nothing when you tick the row in as its own payment, or leave it unticked', async () => {
    const unticked: Draft = draftOf(screen, 1);
    unticked.sections[0]!.transactions[1]!.adds!.include = false;
    await commitDraft(store, { record: record(1), draft: unticked, workFile });
    expect(store.transaction(card.id)!.seenIn).toBeUndefined();
    const own = draftOf(screen, 2);
    own.sections[0]!.transactions[1]!.include = true;
    await commitDraft(store, { record: record(2), draft: own, workFile });
    expect(store.transaction(card.id)!.counterpartyName).toBeUndefined();
    expect(store.transactions('current')).toHaveLength(3);
  });

  it('fills in only what is still empty at commit, and what a filled-in type says the row is', async () => {
    // Recorded before cash was known for cash: the bank's name alone made it a move to the saver.
    const old = tx('tx_00000000000000c4', '2026-09-15', -60, 'Example Bank', { payee: 'Example Bank saver', category: 'transfer', categorisedBy: 'transfer', counterpartyAccountId: 'saver' });
    await store.addTransactions([old], 'test: an old reading');
    const screenOfIt = ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ accountName: 'Current', transactions: [{ date: '2026-09-15', time: '08:05', description: 'Example Bank', amount: -60, type: 'Cash withdrawal' }] }] });
    const draft = draftOf(screenOfIt);
    const row = draft.sections[0]!.transactions[0]!;
    expect(row).toMatchObject({ status: 'duplicate', adds: { include: true, fields: { time: '08:05', type: 'Cash withdrawal' }, category: { from: 'transfer', to: 'cash-withdrawal' } } });
    // Another import got the time in first.
    await store.updateTransactions([{ id: old.id, patch: { time: '08:06' } }], 'test: another reading');
    await commitDraft(store, { record: record(1), draft, workFile });
    const after = store.transaction(old.id)!;
    expect(after).toMatchObject({ time: '08:06', type: 'Cash withdrawal', category: 'cash-withdrawal', categorisedBy: 'builtin' });
    expect(after.counterpartyAccountId).toBeUndefined();
    expect(after.seenIn![0]).toMatchObject({ added: ['type'], said: { time: '08:05' } });
  });
});

describe('cash from a machine', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-cash-'));
    store = await Store.open(path.join(dir, 'data'));
    const acct = (id: string, name: string, institutionId: string): Account => ({ id, name, type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, institutionId, createdAt: stamp, updatedAt: stamp });
    await store.setAccounts([acct('chase', 'Chase current', 'chase-uk'), acct('santander', 'Santander current', 'santander')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('is cash, not a transfer to your account at the bank that runs the machine', () => {
    const c = categoriserFor(store);
    expect(c.categorise({ accountId: 'chase', description: 'Cash withdrawal, Santander, Faro', amount: -34.48 })).toMatchObject({ category: 'cash-withdrawal', categorisedBy: 'builtin' });
    expect(c.categorise({ accountId: 'chase', description: 'Cash withdrawal, Santander, Faro', amount: -34.48 }).counterpartyAccountId).toBeUndefined();
    // Only the bank's type says it is cash.
    expect(c.categorise({ accountId: 'chase', description: 'Santander', amount: -34.48, type: 'Cash withdrawal' })).toMatchObject({ category: 'cash-withdrawal' });
    expect(c.ownAccountsMentioned('chase', 'Santander', true, 'Cash withdrawal')).toEqual([]);
    // Money sent to the account there is still a transfer.
    expect(c.categorise({ accountId: 'chase', description: 'Transfer to Santander', amount: -100 })).toMatchObject({ category: 'transfer', counterpartyAccountId: 'santander' });
  });
});
