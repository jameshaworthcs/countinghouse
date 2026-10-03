// The one rule for whether a period's data is complete (docs/FORMULAS.md §3, "Missing days"): the
// Tax year page, Self Assessment, the capture list and Data health all use it.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances, missingNote, yearMissing } from '../src/server/analytics/allowances';
import { BalanceEngine } from '../src/server/analytics/balances';
import { captureList } from '../src/server/analytics/capture';
import { Coverage, coveredIntervals, missingDays } from '../src/server/analytics/coverage';
import { selfAssessment } from '../src/server/analytics/selfassessment';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { formatSpan } from '../src/shared/dates';
import type { Account, Transaction } from '../src/shared/schema';
import { oldestOpenTaxYear, saCorrectBy, taxYear } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

let dir: string;
let store: Store;
let k = 0;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-missing-'));
  store = await Store.open(path.join(dir, 'data'));
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

/** A committed statement for `accountId` covering [from, to], with the rows given recorded from it. */
async function statement(accountId: string, from: string, to: string, rows: Transaction[] = [], balance?: number) {
  const id = `imp_20260101_000000_${(k++).toString(16).padStart(4, '0')}`;
  if (rows.length) await store.addTransactions(rows.map((t) => ({ ...t, source: { importId: id } })), 'rows');
  await store.saveImport(
    {
      id,
      status: 'committed',
      createdAt: stamp,
      updatedAt: stamp,
      origin: 'upload',
      document: { id: `doc_${k.toString(16).padStart(16, '0')}`, sha256: '0'.repeat(64), fileName: 's.pdf', mediaType: 'application/pdf', size: 1 },
      extraction: { warnings: [] },
      draft: {
        documentType: 'bank_statement',
        sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId }, currency: 'GBP', periodStart: from, periodEnd: to, ...(balance !== undefined ? { balance, balanceDate: to } : {}), recordBalance: balance !== undefined, transactions: [], recordHoldings: false, holdings: [] }],
        figures: [],
        notes: [],
      },
      result: { accountIds: [accountId], accountsCreated: [], transactionsAdded: rows.length, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
    },
    'statement',
  );
  if (balance !== undefined) await store.addBalances([{ id: `bal_${(k * 7919).toString(16).padStart(16, '0')}`, accountId, date: to, balance, currency: 'GBP', kind: 'statement', source: { importId: id }, createdAt: stamp }], 'balance');
}

async function confirm(accountId: string, from: string, to: string) {
  await store.setCoverageConfirmations([...store.coverageConfirmations, { id: `cov_${(k++).toString(16).padStart(12, '0')}`, accountId, from, to, confirmedAt: stamp }], 'confirm');
}

describe('the oldest tax year still open', () => {
  it('is open until 12 months after its 31 January deadline', () => {
    expect(saCorrectBy(taxYear(2024))).toBe('2027-01-31');
    expect(oldestOpenTaxYear('2026-10-03').label).toBe('2024/25');
    expect(oldestOpenTaxYear('2027-01-31').label).toBe('2024/25');
    expect(oldestOpenTaxYear('2027-02-01').label).toBe('2025/26');
  });
});

describe('missing days', () => {
  it('names a stretch inside the period that no statement covers, and a confirmation covers it', async () => {
    await store.setAccounts([acct('current', 'current', { openedOn: '2020-01-01' })]);
    await statement('current', '2025-04-01', '2025-09-28');
    await statement('current', '2025-10-08', '2026-04-30');
    const account = store.account('current')!;
    expect(missingDays(store, account, '2025-04-06', '2026-04-05')).toEqual([{ from: '2025-09-29', to: '2025-10-07', noData: false, openingUnknown: false }]);
    await confirm('current', '2025-09-29', '2025-10-07');
    expect(coveredIntervals(store, account)).toEqual([{ from: '2025-04-01', to: '2026-04-30' }]);
    expect(missingDays(store, account, '2025-04-06', '2026-04-05')).toEqual([]);
  });

  it('counts an account with no opening date from its data when that starts soon after the period does', async () => {
    await store.setAccounts([acct('saver', 'savings'), acct('late', 'savings')]);
    await statement('saver', '2025-05-01', '2026-04-30');
    await statement('late', '2025-09-01', '2026-04-30');
    expect(missingDays(store, store.account('saver')!, '2025-04-06', '2026-04-05')).toEqual([]);
    // Five months in, it may have been open before: the days to its data are missing until its opening date is set.
    expect(missingDays(store, store.account('late')!, '2025-04-06', '2026-04-05')).toEqual([{ from: '2025-04-06', to: '2025-08-31', noData: false, openingUnknown: true }]);
    await store.upsertAccount({ ...store.account('late')!, openedOn: '2025-09-01' });
    expect(missingDays(store, store.account('late')!, '2025-04-06', '2026-04-05')).toEqual([]);
  });

  it('marks an account with no data at all, and needs nothing after an account closed', async () => {
    await store.setAccounts([acct('unused', 'current', { openedOn: '2025-07-09', status: 'closed', closedOn: '2026-03-03' })]);
    expect(missingDays(store, store.account('unused')!, '2025-04-06', '2026-04-05')).toEqual([{ from: '2025-07-09', to: '2026-03-03', noData: true, openingUnknown: false }]);
  });
});

describe('tax figures', () => {
  it('a savings account paying interest once a year is complete when its statements cover the year', async () => {
    // The Self Assessment page once judged by the first and last row: with one interest row a year,
    // the year after the last one looked uncovered although the statement runs through it.
    await store.setAccounts([acct('fixed', 'savings', { openedOn: '2023-09-14', status: 'closed', closedOn: '2025-09-12' })]);
    await statement('fixed', '2023-09-14', '2025-09-12', [tx('fixed', '2023-09-14', 20000, 'Deposit'), tx('fixed', '2024-09-13', 1200, 'Interest Added', { category: 'interest' })]);
    const a = allowances(store, '2024/25', '2026-10-03');
    expect(a.savings).toMatchObject({ interest: 1200, incomplete: null, missing: [] });
    const sa = selfAssessment(store, '2024/25');
    const item = sa.sections.find((s) => s.id === 'savings')!.items.find((i) => i.id === 'interest')!;
    expect(item.notes.join(' ')).not.toMatch(/may be missing/);
  });

  it('names each account’s missing days, says which add up, and stops once they are confirmed', async () => {
    await store.setAccounts([acct('current', 'current', { openedOn: '2020-01-01' }), acct('nodata', 'current', { openedOn: '2024-01-01', status: 'closed', closedOn: '2025-07-31' })]);
    await statement('current', '2025-04-01', '2025-09-28', [tx('current', '2025-06-01', 0.4, 'INTEREST', { category: 'interest' })], 100);
    await statement('current', '2025-10-01', '2026-04-30', [], 100);
    const a = allowances(store, '2025/26', '2026-10-03');
    expect(a.savings.missing).toEqual([
      { accountId: 'current', name: 'current', from: '2025-09-29', to: '2025-09-30', days: 2, evidence: 'adds-up' },
      { accountId: 'nodata', name: 'nodata', from: '2025-04-06', to: '2025-07-31', days: 117, noData: true, evidence: 'no-balance' },
    ]);
    expect(a.savings.incomplete).toBe(
      `Not counted yet: interest on days no document covers: current, ${formatSpan('2025-09-29', '2025-09-30')}; nodata (no data at all), ${formatSpan('2025-04-06', '2025-07-31')}. Import statements for those days; where the balances add up, confirm them in Settings → Data health.`,
    );
    await confirm('current', '2025-09-29', '2025-09-30');
    expect(allowances(store, '2025/26', '2026-10-03').savings.missing.map((m) => m.accountId)).toEqual(['nodata']);
  });

  it('a year still settling needs its days only to the end of the month before last', async () => {
    await store.setAccounts([acct('current', 'current', { openedOn: '2020-01-01' })]);
    await statement('current', '2026-04-01', '2026-08-31');
    expect(yearMissing(store, store.accounts, taxYear(2026), '2026-10-03')).toEqual([]);
    expect(yearMissing(store, store.accounts, taxYear(2026), '2026-11-01').map((m) => [m.from, m.to])).toEqual([['2026-09-01', '2026-09-30']]);
  });

  it('a sentence names a few stretches an account is missing and counts the rest', () => {
    const m = (from: string, to: string) => ({ accountId: 'a', name: 'Card', from, to, days: 1, evidence: 'no-balance' as const });
    expect(missingNote('interest', [m('2025-05-01', '2025-05-01'), m('2025-06-01', '2025-06-01'), m('2025-07-01', '2025-07-01'), m('2025-08-01', '2025-08-01'), m('2025-09-01', '2025-09-01')])).toBe(
      'Not counted yet: interest on days no document covers: Card, 1 May 2025, 1 Jun 2025, 1 Jul 2025 and 2 more stretches. Import statements for those days.',
    );
  });
});

describe('the capture list', () => {
  it('counts the days you confirmed, as the Tax year page and Data health do', async () => {
    await store.setAccounts([acct('current', 'current', { openedOn: '2020-01-01' })]);
    await statement('current', '2025-04-01', '2025-09-28');
    await statement('current', '2025-10-27', '2026-08-31');
    await store.setCapture([{ id: 'current', title: 'Current account', accountId: 'current', priority: 'normal', asks: [{ id: 'statements', what: 'Statements', check: { type: 'coverage', from: '2025-04-06' } }], provenance: { setBy: 'agent', model: 'test' }, createdAt: stamp, updatedAt: stamp }], 'capture');
    const ask = () => captureList(store, '2026-10-03').items[0]!.asks[0]!;
    expect(ask().state).toBe('partial');
    expect(ask().progress).toContain(`Missing ${formatSpan('2025-09-29', '2025-10-26')}`);
    await confirm('current', '2025-09-29', '2025-10-26');
    expect(ask()).toMatchObject({ state: 'done', progress: `Covered ${formatSpan('2025-04-06', '2026-08-31')}.` });
  });
});

describe('Data health', () => {
  it('lists the valued accounts a tax figure rests on, and accounts with no data, beside the ledgers', async () => {
    await store.setAccounts([
      acct('current', 'current', { openedOn: '2020-01-01' }),
      acct('lisa', 'lisa'),
      acct('nodata', 'current', { openedOn: '2025-07-09', status: 'closed', closedOn: '2026-03-03' }),
      acct('gia', 'gia'),
    ]);
    await statement('current', '2024-04-01', '2026-08-31');
    await statement('lisa', '2024-04-13', '2025-07-02');
    await statement('lisa', '2025-07-07', '2026-08-31');
    await statement('gia', '2025-01-01', '2026-08-31');
    const coverage = new Coverage(store);
    const gaps = coverage.gaps(new BalanceEngine(store), '2024-04-06', '2026-08-31', [store.account('lisa')!]);
    expect(gaps.map((g) => [g.accountId, g.from, g.to, Boolean(g.valuations), Boolean(g.noData)])).toEqual([
      ['lisa', '2025-07-03', '2025-07-06', true, false],
      ['nodata', '2025-07-09', '2026-03-03', false, true],
    ]);
  });
});
