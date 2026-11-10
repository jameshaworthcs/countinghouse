// What a statement says beyond its rows (docs/INGESTION.md, docs/FORMULAS.md §3 and §13): an
// "opening" balance printed at the end of the first day, a period in which nothing moved, and a
// copy recorded twice a few days apart that a statement accounting for its whole period shows once.
// All data here is invented.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { Store } from '../src/server/store';
import { sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const tx = (id: string, accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: { importId: 'imp_20261001_120000_aaaa' },
  createdAt: stamp,
  ...extra,
});

let dir: string;
let store: Store;
let workFile: string;
const pdf = { id: 'doc_00000000000000ef', sha256: 'ef'.repeat(32), fileName: 'statement.pdf', mediaType: 'application/pdf', size: 1 };
const record = (id: string, hintAccountId: string, document = pdf): ImportRecord => ({
  id,
  status: 'review',
  createdAt: '2026-11-10T09:00:00+00:00',
  updatedAt: '2026-11-10T09:00:00+00:00',
  origin: 'upload',
  hintAccountId,
  document,
  extraction: { warnings: [] },
});
const draftOf = (raw: unknown, hintAccountId: string, document = pdf) => buildDraft(ExtractionSchema.parse(raw), { store, document, hintAccountId, uploadedOn: '2026-11-10' });
const reconcileOf = (d: ReturnType<typeof draftOf>, accountType: 'current' | 'credit_card' = 'current') => sectionChecks(d.sections[0]!, { accountType, latest: '2026-11-10' }).find((c) => c.id === 'reconcile');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-statement-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([
    { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp },
    { id: 'card', name: 'Card', type: 'credit_card', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp },
  ]);
  workFile = path.join(dir, 'statement.pdf');
  await writeFile(workFile, 'x');
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('an opening balance printed at the end of the first day', () => {
  const statement = (openingBalance: number, rows: { date: string; amount: number; balanceAfter: number | null }[], closingBalance: number) => ({
    documentType: 'bank_statement',
    accounts: [
      {
        accountName: 'Current',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        openingBalance,
        closingBalance,
        transactions: rows.map((r, i) => ({ ...r, description: `EXAMPLE PAYEE ${i}` })),
      },
    ],
  });

  it('opens on the balance before that day’s rows, and says so', () => {
    // "Balance on 01 October: £10.00", after a £2.50 payment that day; closes on £5.00.
    const d = draftOf(statement(10, [{ date: '2026-10-01', amount: -2.5, balanceAfter: 10 }, { date: '2026-10-09', amount: -5, balanceAfter: 5 }], 5), 'current');
    expect(d.sections[0]!.openingBalance).toBe(12.5);
    expect(reconcileOf(d)).toMatchObject({ status: 'ok' });
    expect(d.notes.some((n) => /end of 1 Oct 2026/.test(n))).toBe(true);
  });

  it('is left as printed when it adds up, or when no balance at the end of that day shows it', () => {
    // Adds up as printed.
    const fine = draftOf(statement(12.5, [{ date: '2026-10-01', amount: -2.5, balanceAfter: 10 }, { date: '2026-10-09', amount: -5, balanceAfter: 5 }], 5), 'current');
    expect(fine.sections[0]!.openingBalance).toBe(12.5);
    // Without a running balance, the first day's rows taken off would be a guess: still yours to check.
    const unsure = draftOf(statement(10, [{ date: '2026-10-01', amount: -2.5, balanceAfter: null }, { date: '2026-10-09', amount: -5, balanceAfter: null }], 5), 'current');
    expect(unsure.sections[0]!.openingBalance).toBe(10);
    expect(reconcileOf(unsure)).toMatchObject({ status: 'warn' });
    // Taking them off would not add up either.
    const wrong = draftOf(statement(10, [{ date: '2026-10-01', amount: -2.5, balanceAfter: 10 }, { date: '2026-10-09', amount: -5, balanceAfter: 5 }], 4), 'current');
    expect(wrong.sections[0]!.openingBalance).toBe(10);
  });
});

describe('a statement period in which nothing moved', () => {
  const empty = (extra: Record<string, unknown> = {}) => ({
    documentType: 'bank_statement',
    accounts: [{ accountName: 'Current', periodStart: '2026-11-01', periodEnd: '2026-11-10', statedMoneyIn: 0, statedMoneyOut: 0, transactions: [], ...extra }],
  });

  it('covers its days, records no balance, and is clean to commit', async () => {
    const d = draftOf(empty(), 'current');
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0]).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-10', recordBalance: false, transactions: [] });
    expect(d.sections[0]!.balance).toBeUndefined();
    expect(draftIsClean(d)).toEqual({ clean: true, reasons: [] });
    await commitDraft(store, { record: record('imp_20261110_090000_0e01', 'current'), draft: d, workFile });
    expect(store.imports.find((i) => i.id === 'imp_20261110_090000_0e01')!.sections).toEqual([{ accountId: 'current', from: '2026-11-01', to: '2026-11-10', fromStated: true }]);
    expect(store.balances('current')).toEqual([]);
  });

  it('is nothing to import without printed totals of nothing, or from a picture of a list', () => {
    expect(draftOf(empty({ statedMoneyIn: null, statedMoneyOut: null }), 'current').sections).toEqual([]);
    expect(draftOf(empty({ statedMoneyOut: 12 }), 'current').sections).toEqual([]);
    expect(draftOf(empty(), 'current', { ...pdf, fileName: 'IMG_0001.png', mediaType: 'image/png' }).sections).toEqual([]);
    expect(draftOf({ ...empty(), documentType: 'other' }, 'current').sections).toEqual([]);
  });
});

describe('a copy recorded a few days away, which a whole statement shows once', () => {
  const KEPT = 'tx_00000000000000b1';
  const COPY = 'tx_00000000000000b2';
  beforeEach(async () => {
    await store.addTransactions(
      [
        tx(KEPT, 'card', '2026-10-10', -6.35, 'EXAMPLE GROCER 0123', { source: { importId: 'imp_20261015_120000_0a01' } }),
        // The next screenshot dated it by the heading above it.
        tx(COPY, 'card', '2026-10-14', -6.35, 'EXAMPLE GROCER 0123', { source: { importId: 'imp_20261015_120000_0a02' } }),
      ],
      'test: one payment recorded twice, days apart',
    );
  });
  const statement = (stated: { statedMoneyIn: number | null; statedMoneyOut: number | null }) => ({
    documentType: 'credit_card_statement',
    accounts: [
      {
        accountName: 'Card',
        accountType: 'credit_card',
        periodStart: '2026-09-25',
        periodEnd: '2026-10-24',
        openingBalance: -100,
        closingBalance: -86.35,
        ...stated,
        transactions: [
          { date: '2026-10-10', amount: -6.35, description: 'EXAMPLE GROCER 0123 EXAMPLE TOWN GROCERS' },
          { date: '2026-10-12', amount: 100, description: 'PAYMENT RECEIVED - THANK YOU' },
          { date: '2026-10-20', amount: -80, description: 'EXAMPLE SHOP' },
        ],
      },
    ],
  });

  it('is taken away on commit, ticked by itself', async () => {
    const d = draftOf(statement({ statedMoneyIn: 100, statedMoneyOut: 86.35 }), 'card');
    expect(d.sections[0]!.transactions[0]).toMatchObject({ status: 'duplicate', duplicateOf: KEPT, include: false });
    expect(d.sections[0]!.extraCopies).toEqual([expect.objectContaining({ transactionId: COPY, keepId: KEPT, nearby: true, remove: true })]);
    expect(draftIsClean(d).clean).toBe(true);
    const done = await commitDraft(store, { record: record('imp_20261110_090000_0e02', 'card'), draft: d, workFile });
    expect(store.transaction(COPY)).toBeUndefined();
    expect(store.transaction(KEPT)).toBeDefined();
    expect(done.result?.transactionsRemoved).toEqual([expect.objectContaining({ id: COPY })]);
  });

  it('is not offered when the statement’s rows do not come to its totals', () => {
    expect(draftOf(statement({ statedMoneyIn: 100, statedMoneyOut: 90 }), 'card').sections[0]!.extraCopies ?? []).toEqual([]);
    expect(draftOf(statement({ statedMoneyIn: null, statedMoneyOut: null }), 'card').sections[0]!.extraCopies ?? []).toEqual([]);
  });
});
