// One payment from several sources (docs/INGESTION.md, "Duplicates" and "Recorded twice"): a
// statement, an export and a screenshot each date and describe it their own way. All data here is
// invented.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDraft } from '../src/server/ingest/commit';
import { classifyDuplicates, storedTwice } from '../src/server/ingest/dedup';
import { buildDraft } from '../src/server/ingest/draft';
import { Store } from '../src/server/store';
import { ExtractionSchema, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const tx = (id: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id, accountId: 'current', date, amount, currency: 'GBP', description, source: { importId: 'imp_20260901_120000_aaaa' }, createdAt: stamp, ...extra });

describe('the same payment from another source', () => {
  const stored = [
    tx('tx_statement', '2026-08-12', -45.67, 'To Credit Card', { balanceAfter: 954.33 }),
    tx('tx_topup', '2026-09-03', 500, 'From A N OTHER - CHASE-TOPUP', { balanceAfter: 1454.33 }),
    tx('tx_cash', '2026-09-17', -34.48, 'Cash withdrawal, Bank, Faro', { balanceAfter: 1386.7 }),
    tx('tx_shop', '2026-09-20', -40, 'CORNER SHOP'),
    tx('tx_cafe', '2026-09-10', -3.5, 'COSTA COFFEE'),
  ];

  it('the same balance after it makes it the same payment, however it is described', () => {
    const [r] = classifyDuplicates([{ date: '2026-08-12', amount: -45.67, description: 'To Revolving Line Account', balanceAfter: 954.33 }], stored);
    expect(r).toEqual({ status: 'duplicate', duplicateOf: 'tx_statement', reason: 'Same date, amount and balance after it' });
    // Another balance after it: not that payment by this rule.
    expect(classifyDuplicates([{ date: '2026-08-12', amount: -45.67, description: 'To Revolving Line Account', balanceAfter: 900 }], stored)[0]!.status).not.toBe('duplicate');
  });

  it('described differently, from £20 it is yours to check on the same day, or a few days apart for an amount with pence', () => {
    const res = classifyDuplicates(
      [
        { date: '2026-09-15', amount: -34.48, description: 'ATM' },
        { date: '2026-09-20', amount: -40, description: 'Transfer' },
      ],
      stored,
    );
    expect(res).toEqual([
      { status: 'possible_duplicate', duplicateOf: 'tx_cash', reason: 'Same amount within a few days, described differently' },
      { status: 'possible_duplicate', duplicateOf: 'tx_shop', reason: 'Same amount on the same day, described differently' },
    ]);
    const alone = (c: Parameters<typeof classifyDuplicates>[0][number]) => classifyDuplicates([c], stored)[0]!.status;
    // Whole pounds on another day, described differently: a payment of its own.
    expect(alone({ date: '2026-09-22', amount: -40, description: 'NEWSAGENT' })).toBe('new');
    // An everyday price at another café, the next day or the same day: another coffee.
    expect(alone({ date: '2026-09-11', amount: -3.5, description: 'PRET A MANGER' })).toBe('new');
    expect(alone({ date: '2026-09-10', amount: -3.5, description: 'PRET A MANGER' })).toBe('new');
    // Both show a balance after them, and they differ: two payments.
    expect(alone({ date: '2026-09-15', amount: -34.48, description: 'ATM', balanceAfter: 1000 })).toBe('new');
  });

  it('a statement row that names no one is the same money as the payment the app names, however small', () => {
    // A card statement prints "Outgoing transaction" on the day the payment posted; the card's app
    // names the merchant, on the day it was made.
    const statement = [tx('tx_unnamed', '2026-07-29', -4.08, 'Outgoing transaction'), tx('tx_unnamed2', '2026-08-01', -6.3, 'Outgoing transaction')];
    const res = classifyDuplicates(
      [
        { date: '2026-07-28', amount: -4.08, description: 'EXAMPLE SUPERMARKET' },
        { date: '2026-07-31', amount: -6.3, description: 'EXAMPLE TRANSPORT' },
      ],
      statement,
    );
    expect(res.map((r) => [r.status, r.duplicateOf])).toEqual([
      ['possible_duplicate', 'tx_unnamed'],
      ['possible_duplicate', 'tx_unnamed2'],
    ]);
    expect(res[0]!.reason).toMatch(/names no one/);
    expect(res.every((r) => r.similar)).toBe(true);
    // Named both sides, small and unlike: still two payments.
    expect(classifyDuplicates([{ date: '2026-07-28', amount: -4.08, description: 'GREENGROCER' }], [tx('tx_cafe2', '2026-07-29', -4.08, 'CORNER CAFE')])[0]!.status).toBe('new');
  });
});

describe('recorded twice', () => {
  const pdf = tx('tx_pdf', '2026-08-12', -45.67, 'To Credit Card', { balanceAfter: 954.33, transferGroup: 'tg_0000000000000001', source: { importId: 'imp_20260829_100000_pdf1' } });
  const csv = tx('tx_csv', '2026-08-12', -45.67, 'Transfer', { balanceAfter: 954.33, source: { importId: 'imp_20260830_100000_csv1' } });
  const row = (duplicateOf: string, status: 'duplicate' | 'possible_duplicate' = 'possible_duplicate') => ({ date: '2026-08-12', amount: -45.67, status, duplicateOf });

  it('a document showing a payment once offers the copy with nothing of yours on it', () => {
    const fileOf = (t: Transaction) => (t.id === 'tx_csv' ? 'export.csv' : 'statement.pdf');
    expect(storedTwice([row('tx_pdf')], [pdf, csv], { fileOf })).toEqual([{ transactionId: 'tx_csv', keepId: 'tx_pdf', accountId: 'current', date: '2026-08-12', amount: -45.67, description: 'Transfer', fromFile: 'export.csv', sameBalance: true, remove: true }]);
    // Matched to the clean copy, the linked copy still stays.
    expect(storedTwice([row('tx_csv')], [pdf, csv])).toEqual([expect.objectContaining({ transactionId: 'tx_csv', keepId: 'tx_pdf' })]);
  });

  it('without the same balance it is for you to judge; nothing when the document shows it as often, or both copies are yours', () => {
    const a = tx('tx_a', '2026-09-01', -3.5, 'COFFEE');
    const b = tx('tx_b', '2026-09-01', -3.5, 'COFFEE HOUSE', { source: { importId: 'imp_20260902_120000_bbbb' } });
    expect(storedTwice([{ date: '2026-09-01', amount: -3.5, status: 'duplicate', duplicateOf: 'tx_a' }], [a, b])).toEqual([expect.objectContaining({ transactionId: 'tx_b', keepId: 'tx_a', accountId: 'current', sameBalance: false, remove: false })]);
    // One document listed both: two coffees, whatever this one shows.
    expect(storedTwice([{ date: '2026-09-01', amount: -3.5, status: 'duplicate', duplicateOf: 'tx_a' }], [a, { ...b, source: a.source }])).toEqual([]);
    // Balances after them that differ: two coffees.
    expect(storedTwice([{ date: '2026-09-01', amount: -3.5, status: 'duplicate', duplicateOf: 'tx_a' }], [{ ...a, balanceAfter: 96.5 }, { ...b, balanceAfter: 93 }])).toEqual([]);
    // Two coffees on the document, two recorded.
    expect(storedTwice([{ date: '2026-09-01', amount: -3.5, status: 'duplicate', duplicateOf: 'tx_a' }, { date: '2026-09-01', amount: -3.5, status: 'new' }], [a, b])).toEqual([]);
    // A category you chose on one, a note on the other.
    expect(storedTwice([{ date: '2026-09-01', amount: -3.5, status: 'duplicate', duplicateOf: 'tx_a' }], [{ ...a, category: 'coffee', categorisedBy: 'user' }, { ...b, notes: 'with Sam' }])).toEqual([]);
  });
});

describe('an import that corrects the record', () => {
  const PDF = 'tx_00000000000000a1';
  const CSV = 'tx_00000000000000a2';
  let dir: string;
  let store: Store;
  let workFile: string;
  const record: ImportRecord = {
    id: 'imp_20260930_073000_0b01',
    status: 'review',
    createdAt: '2026-09-30T07:30:00+01:00',
    updatedAt: '2026-09-30T07:30:00+01:00',
    origin: 'upload',
    hintAccountId: 'current',
    document: { id: 'doc_00000000000000cd', sha256: 'cd'.repeat(32), fileName: 'IMG_0001.png', mediaType: 'image/png', size: 1 },
    extraction: { warnings: [] },
  };
  const screen = ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ accountName: 'Current', transactions: [{ date: '2026-08-12', description: "Sam's Account to Credit card", amount: -45.67 }] }] });
  const draftNow = () => buildDraft(screen, { store, document: record.document, hintAccountId: 'current', uploadedOn: '2026-09-30' });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-dedup-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.addTransactions(
      [
        tx(PDF, '2026-08-12', -45.67, 'To Credit Card', { balanceAfter: 954.33, category: 'credit-card-payment', categorisedBy: 'transfer', source: { importId: 'imp_20260829_100000_0a01' } }),
        tx(CSV, '2026-08-12', -45.67, 'Transfer', { balanceAfter: 954.33, source: { importId: 'imp_20260830_100000_0c01' } }),
      ],
      'test: one payment recorded twice',
    );
    workFile = path.join(dir, 'IMG_0001.png');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the second copy away on commit, and says so on the import', async () => {
    const draft = draftNow();
    expect(draft.sections[0]!.transactions[0]).toMatchObject({ status: 'possible_duplicate', duplicateOf: PDF, include: false });
    expect(draft.sections[0]!.extraCopies).toEqual([expect.objectContaining({ transactionId: CSV, keepId: PDF, sameBalance: true, remove: true })]);
    const done = await commitDraft(store, { record, draft, workFile });
    expect(store.transactions('current').map((t) => t.id)).toEqual([PDF]);
    expect(done.result).toMatchObject({ transactionsAdded: 0, transactionsRemoved: [{ id: CSV, date: '2026-08-12', amount: -45.67, description: 'Transfer', importId: 'imp_20260830_100000_0c01' }] });
  });

  it('keeps it when it is unticked, when you have since changed it, or when you count the row as another payment', async () => {
    const unticked = draftNow();
    unticked.sections[0]!.extraCopies![0]!.remove = false;
    await commitDraft(store, { record, draft: unticked, workFile });
    expect(store.transactions('current')).toHaveLength(2);

    const counted = draftNow();
    counted.sections[0]!.transactions[0]!.include = true;
    await commitDraft(store, { record: { ...record, id: 'imp_20260930_073000_0b02' }, draft: counted, workFile });
    expect(store.transactions('current').filter((t) => t.date === '2026-08-12' && t.description !== "Sam's Account to Credit card")).toHaveLength(2);

    const draft = draftNow();
    await store.updateTransactions([{ id: CSV, patch: { notes: 'the card payment' } }], 'test: a note');
    await commitDraft(store, { record: { ...record, id: 'imp_20260930_073000_0b03' }, draft, workFile });
    expect(store.transaction(CSV)).toBeDefined();
  });

  it('a close match fills in what the record lacks by itself; one described differently waits for you', async () => {
    await store.addTransactions(
      [
        tx('tx_00000000000000a4', '2026-07-06', -9.5, 'EXAMPLE SPORT PURCHASE', { source: { importId: 'imp_20260829_100000_0a01' } }),
        tx('tx_00000000000000a5', '2026-07-27', 653.27, 'From A N Other Repayment', { source: { importId: 'imp_20260829_100000_0a01' } }),
      ],
      'test: two payments a statement recorded',
    );
    const app = ExtractionSchema.parse({
      documentType: 'transactions_screenshot',
      accounts: [
        {
          accountName: 'Current',
          transactions: [
            { date: '2026-07-03', description: 'EXAMPLE SPORT', amount: -9.5, time: '19:37', type: 'Purchase' },
            { date: '2026-07-27', description: "A N Other's Account to Credit card", amount: 653.27, time: '12:23' },
          ],
        },
      ],
    });
    const [sport, repay] = buildDraft(app, { store, document: record.document, hintAccountId: 'current', uploadedOn: '2026-09-30' }).sections[0]!.transactions;
    // Made on the 3rd, posted on the 6th: when it was made, ticked to fill in.
    expect(sport).toMatchObject({ status: 'possible_duplicate', duplicateOf: 'tx_00000000000000a4', include: false, adds: { include: true, fields: { transactionDate: '2026-07-03', transactionTime: '19:37' } } });
    // The same money, worded differently: yours to look at.
    expect(repay).toMatchObject({ status: 'possible_duplicate', duplicateOf: 'tx_00000000000000a5', adds: { include: false } });
  });

  it('a cancelled row is shown, not recorded; a row that names no one takes the app’s name, and its category', async () => {
    const UNNAMED = 'tx_00000000000000a3';
    await store.addTransactions([tx(UNNAMED, '2026-07-29', -4.08, 'Outgoing transaction', { source: { importId: 'imp_20260829_100000_0a01' } })], 'test: a payment a statement names no one for');
    const app = ExtractionSchema.parse({
      documentType: 'transactions_screenshot',
      accounts: [
        {
          accountName: 'Current',
          transactions: [
            { date: '2026-07-24', description: 'EXAMPLE BUSES', amount: -0.1, uncertain: 'Marked Cancelled with the amount struck through' },
            { date: '2026-07-28', description: 'ALDI', amount: -4.08, time: '11:55', type: 'Purchase' },
          ],
        },
      ],
    });
    const draft = buildDraft(app, { store, document: record.document, hintAccountId: 'current', uploadedOn: '2026-09-30' });
    const [gone, named] = draft.sections[0]!.transactions;
    expect(gone).toMatchObject({ status: 'new', include: false });
    expect(named).toMatchObject({ status: 'possible_duplicate', duplicateOf: UNNAMED, include: false, adds: { include: true, category: { to: 'groceries' } } });
    await commitDraft(store, { record: { ...record, id: 'imp_20260930_073000_0b05' }, draft, workFile });
    expect(store.transactions('current').filter((t) => t.date < '2026-08-01').map((t) => t.id)).toEqual([UNNAMED]);
    expect(store.transaction(UNNAMED)).toMatchObject({ description: 'Outgoing transaction', category: 'groceries', categorisedBy: 'builtin' });
    expect(store.transaction(UNNAMED)?.seenIn?.[0]?.said?.description).toBe('ALDI');
  });
});
