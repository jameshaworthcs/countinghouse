// A pension provider's own exports (docs/INGESTION.md, "Pension and fund provider exports") and the
// money a payroll pays into a pension (FORMULAS.md §11, "Payroll pensions"): its trades with units and
// prices, its contributions summaries, its holdings priced on a day; payslip money counted once, in
// the payslip's tax year; a valuation that already holds a contribution; paid in from a provider's
// summary. All names and amounts are invented.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pensionTotals } from '../src/server/analytics/allowances';
import { BalanceEngine, insideValuations } from '../src/server/analytics/balances';
import { computeBaseline } from '../src/server/analytics/baseline';
import { Coverage } from '../src/server/analytics/coverage';
import { captureList } from '../src/server/analytics/capture';
import { paidIn } from '../src/server/analytics/investments';
import { payrollPensions } from '../src/server/analytics/payroll-pensions';
import { balanceId, figureId, payslipId, transactionId } from '../src/server/ids';
import { readCsvRows } from '../src/server/ingest/csv';
import { applyRecords } from '../src/server/records';
import { decodeText } from '../src/server/ingest/detect';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { parseHoldingsCsv } from '../src/server/ingest/holdings-csv';
import { parseContributionsCsv, parseFundTradesCsv } from '../src/server/ingest/pension-csv';
import { Store } from '../src/server/store';
import { AssumptionSet } from '../src/shared/assumptions';
import { endOfMonth } from '../src/shared/dates';
import { PayslipRecordSchema, type Account, type DocumentRef, type Figure, type PayslipRecord, type Transaction } from '../src/shared/schema';
import { taxYear } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
const rows = (name: string) => readCsvRows(decodeText(readFileSync(path.join(import.meta.dirname, 'fixtures', name)))).rows;
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id === 'workplace' ? 'Example Workplace Pension' : id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const doc = (fileName: string, lastModified?: string): DocumentRef => ({ id: 'doc_0000000000000001', sha256: '0'.repeat(64), fileName, mediaType: 'text/csv', size: 1, ...(lastModified ? { lastModified } : {}) });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

describe('reading a provider’s exports', () => {
  it('reads a fund trade history: what each row was, the units and their price, the totals as a check', () => {
    const ex = parseFundTradesCsv(rows('pension-trades.csv'), { asOf: '2026-03-20' })!;
    const [acc] = ex.accounts;
    // Oldest first; the switch's two legs on one day, the money out first.
    expect(acc!.transactions.map((t) => [t.date, t.amount, t.description, t.type, t.payee])).toEqual([
      ['2025-11-10', 300, 'Contribution · Example Lifestyle Fund', 'Contribution', 'Example Lifestyle Fund'],
      ['2025-12-12', 300, 'Contribution · Example Lifestyle Fund', 'Contribution', 'Example Lifestyle Fund'],
      ['2026-01-05', -612, 'Switch Out · Example Lifestyle Fund', 'Switch Out', 'Example Lifestyle Fund'],
      ['2026-01-05', 612, 'Switch In · Example Fixed Interest Fund', 'Switch In', 'Example Fixed Interest Fund'],
      ['2026-02-10', 300, 'Contribution · Example Fixed Interest Fund', 'Contribution', 'Example Fixed Interest Fund'],
      ['2026-03-10', 300, 'Contribution · Example Fixed Interest Fund', 'Contribution', 'Example Fixed Interest Fund'],
    ]);
    expect(acc!.transactions[2]!.attributes).toEqual({ units: -60, price: 10.2, fund: 'Example Lifestyle Fund' });
    // Its totals agree with its rows: the whole history, to the day it was downloaded.
    expect(acc).toMatchObject({ periodStart: '2025-11-10', periodEnd: '2026-03-20' });
    expect(ex.notes.join(' ')).toMatch(/totals agree with its rows \(100 units of Example Fixed Interest Fund; none of Example Lifestyle Fund\): it is the account’s whole history/);
  });

  it('says when its rows do not reach its totals, and then runs only to its last row', () => {
    const cut = rows('pension-trades.csv').filter((r) => r[0] !== '10/03/2026');
    const [acc] = parseFundTradesCsv(cut, { asOf: '2026-03-20' })!.accounts;
    expect(acc!.periodEnd).toBe('2026-02-10');
    expect(parseFundTradesCsv(cut, { asOf: '2026-03-20' })!.notes).toContain('Example Fixed Interest Fund: its rows add up to 76 units, but the file’s total is 100. Rows may be missing.');
  });

  it('leaves bank exports, holdings and summaries to their own readers', () => {
    expect(parseFundTradesCsv(rows('monzo.csv'))).toBeNull();
    expect(parseFundTradesCsv(rows('pension-holdings.csv'))).toBeNull();
    expect(parseContributionsCsv(rows('pension-trades.csv'), 'transaction-history.csv')).toBeNull();
    expect(parseHoldingsCsv(rows('pension-trades.csv'), 'transaction-history.csv')).toBeNull();
    expect(parseHoldingsCsv(rows('pension-contributions.csv'), 'contributions.csv')).toBeNull();
  });

  it('reads a contributions summary: since the start, or this tax year when its name says so', () => {
    const all = parseContributionsCsv(rows('pension-contributions.csv'), 'contributions.csv', { asOf: '2026-05-20' })!;
    expect(all.figures.map((f) => [f.kind, f.label, f.amount, f.taxYear, f.periodStart, f.periodEnd])).toEqual([
      ['pension_contribution_employee', 'You · Core · to date', 480, null, null, '2026-05-20'],
      ['pension_contribution_employer', 'Your Employer · Core · to date', 720, null, null, '2026-05-20'],
    ]);
    expect(all.notes).toContain('Paid in since the start, to 20 May 2026 (the day it was downloaded): you £480.00, your employer £720.00, £1,200.00 in all.');
    const year = parseContributionsCsv(rows('pension-contributions-tax-year-to-date.csv'), 'contributions-tax-year-to-date.csv', { asOf: '2026-05-20' })!;
    expect(year.figures.map((f) => [f.amount, f.taxYear, f.periodStart, f.periodEnd])).toEqual([
      [240, '2026/27', '2026-04-06', '2026-05-20'],
      [360, '2026/27', '2026-04-06', '2026-05-20'],
    ]);
  });

  it('dates holdings by the day they are priced, and keeps a "Unit Price"', () => {
    const [acc] = parseHoldingsCsv(rows('pension-holdings.csv'), 'currentInvestments.csv')!.accounts;
    expect(acc).toMatchObject({ balanceDate: '2026-03-20', closingBalance: 1300 });
    expect(acc!.holdings[0]).toMatchObject({ name: 'Example Fixed Interest Fund', units: 100, price: 13, value: 1300 });
  });
});

describe('drafts of a provider’s exports', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-pension-exports-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('workplace', 'workplace_pension'), acct('current', 'current')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('categorises its rows by their type first: a switch into a fixed interest fund is a trade, not interest', () => {
    const draft = buildDraft(parseFundTradesCsv(rows('pension-trades.csv'), { asOf: '2026-03-20' })!, { store, document: doc('transaction-history.csv'), hintAccountId: 'workplace', uploadedOn: '2026-03-20' });
    expect(draft.sections[0]!.transactions.map((t) => t.category)).toEqual(['contribution', 'contribution', 'trade', 'trade', 'contribution', 'contribution']);
    expect(draft.sections[0]).toMatchObject({ periodStart: '2025-11-10', periodEnd: '2026-03-20' });
    expect(draftIsClean(draft)).toEqual({ clean: true, reasons: [] });
  });

  it('puts a summary’s figures on the pension account it was uploaded to', () => {
    const ex = parseContributionsCsv(rows('pension-contributions-tax-year-to-date.csv'), 'contributions-tax-year-to-date.csv', { asOf: '2026-05-20' })!;
    expect(buildDraft(ex, { store, document: doc('c.csv'), hintAccountId: 'workplace', uploadedOn: '2026-05-20' }).figures.map((f) => f.accountId)).toEqual(['workplace', 'workplace']);
    // Uploaded to an account that is not a pension: no account.
    expect(buildDraft(ex, { store, document: doc('c.csv'), hintAccountId: 'current', uploadedOn: '2026-05-20' }).figures.map((f) => f.accountId)).toEqual([undefined, undefined]);
  });
});

describe('pension money from a payroll', () => {
  let dir: string;
  let store: Store;
  // Each month's payslip takes 120.00 for the pension and the employer adds 180.00; the scheme invests
  // the 300.00 a week or two after the pay date. March's money arrives in April.
  const slip = (payDate: string, ytdMonths: number): PayslipRecord => {
    const p = { employer: 'Larchwood Data Ltd', payDate, totals: {} };
    return PayslipRecordSchema.parse({
      ...p,
      id: payslipId(p),
      employmentId: 'larchwood',
      taxYear: taxYear(Number(payDate.slice(0, 4)) - (payDate.slice(5) < '04-06' ? 1 : 0)).label,
      deductions: [{ label: 'Pension Deduction', amount: 120 }],
      employerCosts: { pension: 180 },
      yearToDate: { pension: 120 * ytdMonths, pensionEmployer: 180 * ytdMonths },
      source: {},
      createdAt: stamp,
    });
  };
  const contribution = (date: string, amount = 300) => tx('workplace', date, amount, 'Contribution · Example Fixed Interest Fund', { category: 'contribution', type: 'Contribution' });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-payroll-pensions-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('workplace', 'workplace_pension'), acct('current', 'current')]);
    await store.setEmployments([{ id: 'larchwood', employer: 'Larchwood Data Ltd', aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    await store.upsertRecords('payslips', [slip('2026-02-27', 11), slip('2026-03-27', 12), slip('2026-04-28', 1), slip('2026-05-28', 2)], 'test: payslips');
    // A one-off payment of your own in June, from no payslip.
    await store.addTransactions([contribution('2026-03-12'), contribution('2026-04-09'), contribution('2026-05-12'), contribution('2026-06-10'), contribution('2026-06-20', 50)], 'test: rows');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the account a job pays into from its payslips’ money arriving there', () => {
    const p = payrollPensions(store);
    expect(p.accountOf.get('larchwood')).toBe('workplace');
    expect([...p.paired.values()].map((s) => s.payslip.payDate)).toEqual(['2026-02-27', '2026-03-27', '2026-04-28', '2026-05-28']);
  });

  it('counts it once, in the payslip’s tax year, split as the payslip splits it', () => {
    // 2026/27: April's and May's payslips (not March's money arriving on 9 April), and your own 50.
    expect(pensionTotals(store, taxYear(2026)).schemes).toMatchObject([{ accountId: 'workplace', personal: 29000, personalGross: 29000, employer: 36000, payslips: true }]);
    expect(pensionTotals(store, taxYear(2026)).lines.map((l) => l.label)).toEqual(['Example Workplace Pension: you 290.00, employer 360.00 (with its payslips)']);
    // 2025/26: February's and March's.
    expect(pensionTotals(store, taxYear(2025)).schemes).toMatchObject([{ accountId: 'workplace', personal: 24000, employer: 36000 }]);
  });

  it('takes a summary of the year so far as the account’s, and adds what came after it', async () => {
    // The provider's export, not a payslip.
    await store.saveImport(
      {
        id: 'imp_20260520_000000_cccc',
        status: 'committed',
        createdAt: stamp,
        updatedAt: stamp,
        origin: 'upload',
        document: { id: `doc_${'0'.repeat(15)}c`, sha256: '0'.repeat(64), fileName: 'contributions-tax-year-to-date.csv', mediaType: 'text/csv', size: 1 },
        extraction: { warnings: [] },
        draft: { documentType: 'csv_export', sections: [], figures: [], notes: [] },
        result: { accountIds: [], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 2 },
      },
      'test import',
    );
    const fig = (kind: Figure['kind'], amount: number): Figure => ({ id: figureId(kind, amount, '2026/27', '', kind, 'x'), kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2026-05-20', date: '2026-05-20', accountId: 'workplace', source: { importId: 'imp_20260520_000000_cccc' }, createdAt: stamp });
    await store.addFigures([fig('pension_contribution_employee', 120), fig('pension_contribution_employer', 180)], 'test: summary');
    expect(pensionTotals(store, taxYear(2026)).schemes).toMatchObject([{ accountId: 'workplace', source: 'figure', personal: 29000, employer: 36000 }]);
  });

  it('does not carry the money on in the projection once the job has ended', async () => {
    await store.addTransactions(
      ['2026-04', '2026-05', '2026-06'].flatMap((m) => [tx('current', `${m}-01`, -900, 'RENT'), tx('current', `${m}-25`, 2000, 'LARCHWOOD DATA LTD', { category: 'salary' })]),
      'test: bank',
    );
    for (const m of ['04', '05', '06'])
      await store.saveImport(
        {
          id: `imp_2026${m}01_000000_bbbb`,
          status: 'committed',
          createdAt: stamp,
          updatedAt: stamp,
          origin: 'upload',
          document: { id: `doc_${'0'.repeat(15)}b`, sha256: '0'.repeat(64), fileName: 's.pdf', mediaType: 'application/pdf', size: 1 },
          extraction: { warnings: [] },
          draft: { documentType: 'bank_statement', sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'current' }, currency: 'GBP', periodStart: `2026-${m}-01`, periodEnd: endOfMonth(`2026-${m}-01`), recordBalance: false, transactions: [], recordHoldings: false, holdings: [] }], figures: [], notes: [] },
          result: { accountIds: ['current'], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
        },
        'test import',
      );
    const wrapper = () => computeBaseline(store, new Coverage(store), '2026-04-01', '2026-06-30', new AssumptionSet([], '2026-07-01')).wrappers.find((w) => w.accountId === 'workplace')!;
    // Still in the job: the payroll's money goes on.
    expect(wrapper().external).toBeGreaterThan(300);
    await store.upsertEmployment({ ...store.employment('larchwood')!, endedOn: '2026-06-15' });
    // Left in June: only your own payment goes on.
    expect(wrapper().personal).toBe(0);
    expect(wrapper().notes).toContain('Not continued: the money from Larchwood Data Ltd’s payroll, which ended on 15 Jun 2026');
    expect(wrapper().external).toBeCloseTo(50 / 3, 2);
  });
});

describe('what a valuation already holds, and paid in', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-paid-in-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('workplace', 'workplace_pension')]);
    await store.addTransactions(['2025-11-10', '2025-12-12', '2026-01-12', '2026-02-10', '2026-03-10', '2026-04-08', '2026-05-12'].map((d) => tx('workplace', d, 300, 'Contribution', { category: 'contribution' })), 'test: rows');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('dates a contribution a statement already counts on the statement’s day', () => {
    const flows = [{ date: '2026-03-10', amount: 300 }, { date: '2026-04-08', amount: 300 }, { date: '2026-05-12', amount: 300 }];
    // The statement of 5 April says 600.00 went in: the money of 8 April is in it.
    expect(insideValuations(flows, [{ date: '2026-04-05', minor: 60000 }], new Set(['2026-04-05'])).map((f) => f.counted)).toEqual(['2026-03-10', '2026-04-05', '2026-05-12']);
    // A total no flows make up to the penny says nothing.
    expect(insideValuations(flows, [{ date: '2026-04-05', minor: 55000 }], new Set(['2026-04-05'])).map((f) => f.counted)).toEqual(['2026-03-10', '2026-04-08', '2026-05-12']);
  });

  it('a provider’s summary the rows add up to proves they go back to the start, and is what was paid in', async () => {
    const engine = () => new BalanceEngine(store);
    await store.addBalances([{ id: balanceId('workplace', '2026-04-05', 1900, 'statement'), accountId: 'workplace', date: '2026-04-05', balance: 1900, currency: 'GBP', kind: 'statement', contributions: 1800, source: {}, createdAt: stamp }], 'test: statement');
    // The statement alone: its own total, and nothing says the rows go back to the start.
    expect(engine().fromStart('workplace')).toBe(false);
    expect(paidIn(store, engine(), store.account('workplace')!)).toEqual({ amount: 1800, source: 'provider', asOf: '2026-04-05' });
    // The provider's summary to 20 May, which the rows add up to: they go back to the start.
    const fig = (kind: Figure['kind'], amount: number): Figure => ({ id: figureId(kind, amount, '2026-05-20', '', kind, 'y'), kind, label: kind, amount, currency: 'GBP', periodEnd: '2026-05-20', date: '2026-05-20', accountId: 'workplace', source: { importId: 'imp_20260520_000000_aaaa' }, createdAt: stamp });
    await store.addFigures([fig('pension_contribution_employee', 840), fig('pension_contribution_employer', 1260)], 'test: summary');
    expect(engine().fromStart('workplace')).toBe(true);
    expect(paidIn(store, engine(), store.account('workplace')!)).toEqual({ amount: 2100, source: 'provider', asOf: '2026-05-20' });
    // The money of 8 April is not added to the statement's value a second time.
    expect(engine().balanceOn('workplace', '2026-04-09')!.value).toBe(1900);
  });
});

describe('a summary of what was paid in since the start', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-paid-in-to-date-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('workplace', 'workplace_pension')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('is no tax year’s: it does not tick off an ask for the year it is dated in', async () => {
    await applyRecords(store, {
      provenance: { setBy: 'agent', model: 'claude-opus-5-5' },
      supersede: false,
      records: [{ type: 'capture', record: { id: 'pension', title: 'Pension', priority: 'normal', asks: [{ id: 'year', what: 'Contributions for 2026/27', check: { type: 'figures', kinds: ['pension_contribution_employee'], taxYear: '2026/27' } }] } }],
    });
    const ask = () => captureList(store, '2026-06-01').items[0]!.asks[0]!.state;
    const fig = (id: string, extra: Partial<Figure>): Figure => ({ id, kind: 'pension_contribution_employee', label: 'You', amount: 480, currency: 'GBP', periodEnd: '2026-05-20', date: '2026-05-20', accountId: 'workplace', source: {}, createdAt: stamp, ...extra });
    // Since the start, downloaded on 20 May 2026: not 2026/27's.
    await store.addFigures([fig('fig_0000000000000001', {})], 'test: to date');
    expect(ask()).toBe('todo');
    // The year so far is.
    await store.addFigures([fig('fig_0000000000000002', { amount: 240, taxYear: '2026/27', periodStart: '2026-04-06' })], 'test: this year');
    expect(ask()).toBe('done');
  });
});
