// What an import covers, and which account it is, when the document prints neither (docs/INGESTION.md,
// "Which account" and "Coverage"; docs/FORMULAS.md §3): the range in an export's file name, how much
// of a screenshot's list is in view, rows and balances your accounts have recorded already, and
// days an import would cover that make it more than "nothing new". All data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountCoverage } from '../src/server/analytics/coverage';
import { transactionId } from '../src/server/ids';
import { buildDraft, coverageBeyondRows } from '../src/server/ingest/draft';
import { dateRangeFromFileName } from '../src/server/ingest/images';
import { assessNovelty } from '../src/server/ingest/novelty';
import { Store } from '../src/server/store';
import { sectionSpan } from '../src/shared/coverage';
import { ExtractionSchema, type Account, type DocumentRef, type Draft, type DraftSection, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, 'PAYMENT', n++), accountId, date, amount, currency: 'GBP', description: 'PAYMENT', source: {}, ...extra });
let docs = 0;
const doc = (extra: Partial<DocumentRef> = {}): DocumentRef => {
  const hex = (++docs).toString(16).padStart(16, '0');
  return { id: `doc_${hex}`, sha256: hex.repeat(4), fileName: 'IMG_0001.PNG', mediaType: 'image/png', size: 1, ...extra };
};
const row = (date: string, amount: number, balanceAfter: number | null = null) => ({ date, amount, description: 'Payment', balanceAfter });

describe('the range in an export’s file name', () => {
  it.each([
    ['Statement for 14 March 2026 to 13 May 2026.csv', { from: '2026-03-14', to: '2026-05-13' }],
    ['transactions_2026-04-01_to_2026-04-30.csv', { from: '2026-04-01', to: '2026-04-30' }],
    ['Example Bank 01-08-2025 - 31-08-2025.csv', { from: '2025-08-01', to: '2025-08-31' }],
    ['Statement 5 June 2025.csv', null],
    ['Statement for 30 April 2026 to 1 April 2026.csv', null],
    ['IMG_0001.PNG', null],
  ])('dateRangeFromFileName(%j)', (name, expected) => {
    expect(dateRangeFromFileName(name)).toEqual(expected);
  });
});

describe('what a document that prints no period covers beyond its rows', () => {
  const csv = { documentType: 'csv_export' as const };
  const rows = { transactions: [row('2026-03-20', -5), row('2026-04-28', 20)], periodStart: '2026-03-20', periodEnd: '2026-04-28' };
  const exported = (fileName: string, lastModified?: string) => doc({ fileName, mediaType: 'text/csv', ...(lastModified ? { lastModified } : {}) });

  it('an export covers the range its file name gives, to the day before it was made when it runs to that day', () => {
    const out = coverageBeyondRows(csv, rows, exported('Statement for 14 March 2026 to 13 May 2026.csv', '2026-05-13T12:00:00.000Z'), '2026-05-13');
    expect(out).toMatchObject({ coversFrom: '2026-03-14', coversTo: '2026-05-12' });
    expect(out.coversWhy).toMatch(/file name gives the range exported.*so it covers to 12 May 2026/);
    // A range that ended before it was made is taken whole.
    expect(coverageBeyondRows(csv, rows, exported('Statement for 14 March 2026 to 6 May 2026.csv', '2026-05-13T12:00:00.000Z'), '2026-05-13')).toMatchObject({ coversFrom: '2026-03-14', coversTo: '2026-05-06' });
    // With no file date, the upload day is when it was made.
    expect(coverageBeyondRows(csv, rows, exported('Statement for 14 March 2026 to 13 May 2026.csv'), '2026-05-13')).toMatchObject({ coversTo: '2026-05-12' });
  });

  it('proposes nothing when a row falls outside the range, or the name gives none', () => {
    expect(coverageBeyondRows(csv, rows, exported('Statement for 1 April 2026 to 13 May 2026.csv'), '2026-05-13')).toEqual({});
    expect(coverageBeyondRows(csv, rows, exported('export.csv'), '2026-05-13')).toEqual({});
  });

  it('never narrows what the rows cover, and says only what it widens', () => {
    // The range starts on the first row: only the end is widened.
    const end = coverageBeyondRows(csv, rows, exported('Statement for 20 March 2026 to 6 May 2026.csv'), '2026-05-13');
    expect(end.coversTo).toBe('2026-05-06');
    expect(Object.keys(end).sort()).toEqual(['coversTo', 'coversWhy']);
    // A last row on the day it was made: only the start is widened, and the reason does not say "to".
    const sameDay = { ...rows, transactions: [row('2026-03-20', -5), row('2026-05-13', 20)] };
    const start = coverageBeyondRows(csv, sameDay, exported('Statement for 14 March 2026 to 13 May 2026.csv'), '2026-05-13');
    expect(start).toMatchObject({ coversFrom: '2026-03-14' });
    expect(start.coversTo).toBeUndefined();
    expect(start.coversWhy).not.toMatch(/covers to/);
  });

  it('a statement that prints its period is left to it', () => {
    const statement = { transactions: rows.transactions, periodStart: '2026-03-01', periodEnd: '2026-04-30', listShows: null };
    expect(coverageBeyondRows({ documentType: 'bank_statement' }, statement, exported('Statement for 14 March 2026 to 13 May 2026.pdf'), '2026-05-13')).toEqual({});
  });

  const screen = { documentType: 'transactions_screenshot' as const };
  const taken = doc({ capturedOn: '2026-05-13', capturedOnSource: 'exif' });
  const list = (listShows: { newestEnd?: boolean | null; oldestEnd?: boolean | null; from?: string | null; to?: string | null }, dates = ['2026-05-01', '2026-05-09']) => ({
    transactions: dates.map((d) => row(d, -3)),
    periodStart: null,
    periodEnd: null,
    listShows: { newestEnd: null, oldestEnd: null, from: null, to: null, ...listShows },
  });

  it('a screenshot showing the newest end of its list covers to the day before it was taken', () => {
    const out = coverageBeyondRows(screen, list({ newestEnd: true }), taken, '2026-05-13');
    expect(out).toMatchObject({ coversTo: '2026-05-12' });
    expect(out.coversFrom).toBeUndefined();
    expect(out.coversWhy).toMatch(/newest end of its list/);
    // Taken by its file name too.
    expect(coverageBeyondRows(screen, list({ newestEnd: true }), doc({ capturedOn: '2026-05-13', capturedOnSource: 'filename' }), '2026-05-13')).toMatchObject({ coversTo: '2026-05-12' });
  });

  it('a month’s whole list covers the month, up to the day before it was taken', () => {
    expect(coverageBeyondRows(screen, list({ newestEnd: true, oldestEnd: true, from: '2026-05-01', to: '2026-05-31' }), taken, '2026-05-13')).toEqual({ coversTo: '2026-05-12', coversWhy: expect.stringMatching(/newest end/) as unknown });
    // An earlier first row's month is widened at the start too.
    const out = coverageBeyondRows(screen, list({ newestEnd: true, oldestEnd: true, from: '2026-05-01', to: '2026-05-31' }, ['2026-05-04', '2026-05-09']), taken, '2026-05-13');
    expect(out).toMatchObject({ coversFrom: '2026-05-01', coversTo: '2026-05-12' });
    expect(out.coversWhy).toMatch(/ends in view, so it covers from 1 May 2026/);
    // A past month's tab covers to that month's end.
    expect(coverageBeyondRows(screen, list({ newestEnd: true, oldestEnd: true, from: '2026-04-01', to: '2026-04-30' }, ['2026-04-06', '2026-04-22']), taken, '2026-05-13')).toMatchObject({ coversFrom: '2026-04-01', coversTo: '2026-04-30' });
  });

  it('proposes nothing when the list is cut off, it is not known when it was taken, a row is outside its period, or it prints a period', () => {
    expect(coverageBeyondRows(screen, list({ newestEnd: false, oldestEnd: false }), taken, '2026-05-13')).toEqual({});
    for (const source of ['upload', 'file-modified'] as const) expect(coverageBeyondRows(screen, list({ newestEnd: true }), doc({ capturedOn: '2026-05-13', capturedOnSource: source }), '2026-05-13')).toEqual({});
    expect(coverageBeyondRows(screen, list({ newestEnd: true, oldestEnd: true, from: '2026-05-05', to: '2026-05-31' }), taken, '2026-05-13')).toEqual({});
    expect(coverageBeyondRows(screen, list({}), taken, '2026-05-13')).toEqual({});
    expect(coverageBeyondRows(screen, { ...list({ newestEnd: true }), periodStart: '2026-05-01', periodEnd: '2026-05-10' }, taken, '2026-05-13')).toEqual({});
  });
});

describe('the days a section covers', () => {
  const section = (s: Partial<DraftSection>) => ({ transactions: [], ...s }) as Pick<DraftSection, 'periodStart' | 'periodEnd' | 'coversFrom' | 'coversTo' | 'transactions' | 'openingBalance' | 'balanceDate' | 'fromSchedule'>;
  const t = (date: string) => ({ key: date, include: true, status: 'new' as const, date, amount: -1, description: 'x' });

  it('an export’s first row is not a printed start; a range given for it is', () => {
    expect(sectionSpan(section({ periodStart: '2026-02-10', periodEnd: '2026-02-20', transactions: [t('2026-02-10'), t('2026-02-20')] }), 'csv_export')).toEqual({ from: '2026-02-10', to: '2026-02-20', fromStated: false });
    expect(sectionSpan(section({ periodStart: '2026-02-10', periodEnd: '2026-02-20', transactions: [t('2026-02-10')], coversFrom: '2026-02-01' }), 'csv_export')).toEqual({ from: '2026-02-01', to: '2026-02-20', fromStated: true });
    // A statement keeps its period with no rows only when the draft found it covers it (draft.ts).
    expect(sectionSpan(section({ periodStart: '2026-02-01', periodEnd: '2026-02-28' }), 'bank_statement')).toEqual({ from: '2026-02-01', to: '2026-02-28', fromStated: true });
    expect(sectionSpan(section({}), 'bank_statement')).toBeNull();
    expect(sectionSpan(section({ periodStart: '2026-02-01', periodEnd: '2026-02-28', transactions: [t('2026-02-10')] }), 'bank_statement')).toEqual({ from: '2026-02-01', to: '2026-02-28', fromStated: true });
    expect(sectionSpan(section({ transactions: [t('2026-02-10')], fromSchedule: true }), 'other')).toBeNull();
  });
});

describe('with a store', () => {
  let dir: string;
  let store: Store;
  let k = 0;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-import-coverage-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([
      acct('mz-current', 'current', { institutionId: 'monzo', last4: '1111' }),
      acct('mz-saver', 'savings', { institutionId: 'monzo', last4: '2222' }),
      acct('mz-card', 'credit_card', { institutionId: 'monzo' }),
    ]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const exportOf = (rows: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) =>
    ExtractionSchema.parse({ documentType: 'csv_export', institutionName: 'Monzo', accounts: [{ institutionName: 'Monzo', currency: 'GBP', periodStart: rows[0]!.date, periodEnd: rows.at(-1)!.date, closingBalance: rows.at(-1)!.balanceAfter, transactions: rows, ...extra }] });
  const csvDoc = () => doc({ fileName: 'export.csv', mediaType: 'text/csv' });

  /** A committed import of one section. */
  async function committed(accountId: string, section: Partial<DraftSection>, documentType: Draft['documentType'] = 'bank_statement') {
    const id = `imp_20260101_000000_${(k++).toString(16).padStart(4, '0')}`;
    const full = { key: 's0', detected: {}, target: { mode: 'existing' as const, accountId }, currency: 'GBP', recordBalance: false, transactions: [], recordHoldings: false, holdings: [], ...section };
    await store.saveImport(
      {
        id,
        status: 'committed',
        createdAt: stamp,
        updatedAt: stamp,
        origin: 'upload',
        document: doc({ mediaType: 'application/pdf' }),
        extraction: { warnings: [] },
        draft: { documentType, sections: [full], figures: [], notes: [] },
        result: { accountIds: [accountId], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
      },
      'test import',
    );
  }

  describe('an export that names no account is the account its rows are in', () => {
    it('rows recorded with the same balances after', async () => {
      await store.addTransactions([tx('mz-saver', '2026-04-01', 12.5, { balanceAfter: 1012.5 }), tx('mz-saver', '2026-04-20', -300, { balanceAfter: 712.5 })], 'test');
      const draft = buildDraft(exportOf([row('2026-04-01', 12.5, 1012.5), row('2026-04-20', -300, 712.5)]), { store, document: csvDoc(), uploadedOn: '2026-05-01' });
      expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'mz-saver' });
      expect(draft.sections[0]!.matchReason).toMatch(/its 2 rows recorded there, with the same balances/);
      expect(draft.sections[0]!.transactions.every((t) => t.status === 'duplicate')).toBe(true);
    });

    it('most of its rows on the same days for the same amounts, without balances', async () => {
      await store.addTransactions([tx('mz-current', '2026-04-02', -4.2), tx('mz-current', '2026-04-05', -18)], 'test');
      const draft = buildDraft(exportOf([row('2026-04-02', -4.2), row('2026-04-05', -18), row('2026-04-09', -7)]), { store, document: csvDoc(), uploadedOn: '2026-05-01' });
      expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'mz-current' });
    });

    it('one row without its balance is not enough, and a tie between accounts is no match', async () => {
      await store.addTransactions([tx('mz-current', '2026-04-02', -4.2)], 'test');
      expect(buildDraft(exportOf([row('2026-04-02', -4.2), row('2026-04-09', -7)]), { store, document: csvDoc(), uploadedOn: '2026-05-01' }).sections[0]!.target.mode).not.toBe('existing');
      await store.addTransactions([tx('mz-current', '2026-04-09', -7), tx('mz-card', '2026-04-02', -4.2), tx('mz-card', '2026-04-09', -7)], 'test');
      expect(buildDraft(exportOf([row('2026-04-02', -4.2), row('2026-04-09', -7)]), { store, document: csvDoc(), uploadedOn: '2026-05-01' }).sections[0]!.target.mode).not.toBe('existing');
    });

    it('opening on the balance an account had just before its first day', async () => {
      await store.addTransactions([tx('mz-saver', '2026-03-28', 50, { balanceAfter: 2468.13 })], 'test');
      const draft = buildDraft(exportOf([row('2026-04-03', -18, 2450.13), row('2026-04-09', 7, 2457.13)], { openingBalance: 2468.13 }), { store, document: csvDoc(), uploadedOn: '2026-05-01' });
      expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'mz-saver' });
      expect(draft.sections[0]!.matchReason).toMatch(/opens on that account's balance \(£2,468\.13 on 28 Mar 2026\)/);
    });

    it('a different number on the document still rules an account out, however much it has recorded', async () => {
      await store.addTransactions([tx('mz-saver', '2026-03-28', 50, { balanceAfter: 1000 }), tx('mz-saver', '2026-04-01', 12.5, { balanceAfter: 1012.5 }), tx('mz-saver', '2026-04-03', -2.5, { balanceAfter: 1010 })], 'test');
      const draft = buildDraft(exportOf([row('2026-04-01', 12.5, 1012.5), row('2026-04-03', -2.5, 1010)], { last4: '9999', accountType: 'savings', accountName: 'mz-saver', openingBalance: 1000 }), { store, document: csvDoc(), uploadedOn: '2026-05-01' });
      expect(draft.sections[0]!.target.mode).not.toBe('existing');
      expect(draft.sections[0]!.matchReason).not.toMatch(/recorded there/);
    });

    it('opens on any balance of the account’s latest day before it, whichever was kept first', async () => {
      await store.addTransactions([tx('mz-saver', '2026-03-28', 50, { balanceAfter: 2518.13 }), tx('mz-saver', '2026-03-28', -50, { balanceAfter: 2468.13 })], 'test');
      const draft = buildDraft(exportOf([row('2026-04-03', -18, 2450.13), row('2026-04-09', 7, 2457.13)], { openingBalance: 2468.13 }), { store, document: csvDoc(), uploadedOn: '2026-05-01' });
      expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'mz-saver' });
    });
  });

  it('an export whose period is its rows runs on from the statement before it when the balances chain', async () => {
    await committed('mz-current', { periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, balance: -50, transactions: [{ key: 't', include: true, status: 'new', date: '2026-01-10', amount: -50, description: 'x' }] });
    await committed('mz-current', { periodStart: '2026-02-10', periodEnd: '2026-02-20', openingBalance: -50, balance: -60, transactions: [{ key: 't', include: true, status: 'new', date: '2026-02-10', amount: -5, description: 'x' }, { key: 'u', include: true, status: 'new', date: '2026-02-20', amount: -5, description: 'x' }] }, 'csv_export');
    expect(accountCoverage(store, store.account('mz-current')!).intervals).toEqual([{ from: '2026-01-01', to: '2026-02-20' }]);
  });

  describe('days it would cover make an import more than "nothing new"', () => {
    const pending = (draft: Draft, id = 'imp_20260613_120000_aaaa'): ImportRecord => ({ id, status: 'review', createdAt: '2026-06-13T12:00:00+00:00', updatedAt: '2026-06-13T12:00:00+00:00', origin: 'upload', document: doc(), extraction: { warnings: [] }, draft });
    const imported = { source: { importId: 'imp_20260601_000000_cccc' } };

    it('a list of payments recorded already that covers days nothing else does', async () => {
      await store.addTransactions([tx('mz-saver', '2026-06-01', 3.21), tx('mz-saver', '2026-06-08', -60)], 'test');
      await committed('mz-saver', { periodStart: '2026-05-01', periodEnd: '2026-06-01', transactions: [{ key: 't', include: true, status: 'new', date: '2026-06-01', amount: 3.21, description: 'Interest' }] });
      const extraction = ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ institutionName: 'Monzo', last4: '2222', accountType: 'savings', transactions: [row('2026-06-01', 3.21), row('2026-06-08', -60)], listShows: { newestEnd: true, oldestEnd: true, from: '2026-06-01', to: '2026-06-30' } }] });
      const draft = buildDraft(extraction, { store, document: doc({ capturedOn: '2026-06-13', capturedOnSource: 'exif' }), uploadedOn: '2026-06-13' });
      expect(draft.sections[0]).toMatchObject({ target: { mode: 'existing', accountId: 'mz-saver' }, coversTo: '2026-06-12' });
      expect(assessNovelty([pending(draft)], store).has('imp_20260613_120000_aaaa')).toBe(false);
      // Once those days are covered, it is nothing new, and says so.
      await committed('mz-saver', { periodStart: '2026-06-02', periodEnd: '2026-06-12', transactions: [{ key: 't', include: true, status: 'new', date: '2026-06-08', amount: -60, description: 'x' }] });
      expect(assessNovelty([pending(draft)], store).get('imp_20260613_120000_aaaa')?.reason).toMatch(/already imported/);
    });

    it('of two waiting that cover the same days, the one with more is kept', async () => {
      // Recorded from an import that covered other days (a payment entered by hand covers its own day).
      await store.addTransactions([tx('mz-saver', '2026-06-08', -60, imported)], 'test');
      await committed('mz-saver', { periodStart: '2026-05-01', periodEnd: '2026-05-31', transactions: [{ key: 't', include: true, status: 'new', date: '2026-05-10', amount: -1, description: 'x' }] });
      const extraction = ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ institutionName: 'Monzo', last4: '2222', accountType: 'savings', transactions: [row('2026-06-08', -60)] }] });
      const draft = buildDraft(extraction, { store, document: doc({ capturedOn: '2026-06-13', capturedOnSource: 'exif' }), uploadedOn: '2026-06-13' });
      const a = pending(draft);
      const b = { ...pending(draft, 'imp_20260613_120001_bbbb'), createdAt: '2026-06-13T12:00:01+00:00' };
      const out = assessNovelty([a, b], store);
      expect(out.has(a.id)).toBe(false);
      expect(out.get(b.id)?.reason).toMatch(/the days it covers \(8 Jun 2026 to 8 Jun 2026\) are also on/);
    });

    it('counts the quiet days an export would run on over from the statement before it', async () => {
      await committed('mz-current', { periodStart: '2026-05-01', periodEnd: '2026-05-31', openingBalance: 0, balance: -50, transactions: [{ key: 't', include: true, status: 'new', date: '2026-05-10', amount: -50, description: 'x' }] });
      await store.addTransactions([tx('mz-current', '2026-06-10', -5, imported), tx('mz-current', '2026-06-20', -5, imported)], 'test');
      // Its rows are recorded, and their days covered by a confirmation: only 1–9 June are new.
      await store.addCoverageConfirmations([{ id: 'cov_0123456789ab', accountId: 'mz-current', from: '2026-06-10', to: '2026-06-20', confirmedAt: stamp }]);
      const extraction = exportOf([row('2026-06-10', -5), row('2026-06-20', -5)], { openingBalance: -50, last4: '1111' });
      const draft = buildDraft(extraction, { store, document: csvDoc(), uploadedOn: '2026-06-25' });
      expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'mz-current' });
      expect(assessNovelty([pending(draft)], store).has('imp_20260613_120000_aaaa')).toBe(false);
    });
  });
});
