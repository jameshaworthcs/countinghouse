// A tax year's return, box by box (docs/FORMULAS.md §20; analytics/taxreturn.ts): the records carried
// into the right boxes, your answers and figures over them, a gap kept apart from a nil, and the
// liability worked out from the boxes. Every person, company and figure here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taxReturn } from '../src/server/analytics/taxreturn';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { figureId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { requiredScope } from '../src/server/tokens';
import type { Account, Employment, Figure, ReturnEntry, Transaction } from '../src/shared/schema';
import { computeTax } from '../src/shared/taxcalc';
import { taxYear } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
const NOW = '2026-11-25';
const job = (id: string, employer: string, extra: Partial<Employment> = {}): Employment => ({ id, employer, aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
const account = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, openedOn: '2020-01-01', createdAt: stamp, updatedAt: stamp, ...extra });
const fig = (kind: Figure['kind'], amount: number, payer: string, extra: Partial<Figure> = {}): Figure => ({
  id: figureId(kind, amount, '2025/26', payer, kind, extra.employmentId ?? extra.accountId ?? ''),
  kind,
  label: kind,
  amount,
  currency: 'GBP',
  taxYear: '2025/26',
  payer,
  source: {},
  createdAt: stamp,
  ...extra,
});
const dividendTx = (i: number, date: string, amount: number, isin: string, whtUsd: number): Transaction => ({
  id: transactionId('gia', date, amount, `Dividend · Co${i}`, 0),
  accountId: 'gia',
  date,
  amount,
  currency: 'GBP',
  description: `Dividend (Dividend) · Example Co ${i}`,
  category: 'investment-income',
  categorisedBy: 'user',
  raw: { Action: 'Dividend (Dividend)', ISIN: isin, 'Withholding tax': String(whtUsd), 'Currency (Withholding tax)': 'USD', 'Exchange rate': '0.80', Total: String(amount) },
  source: {},
});

describe('a 2025/26 return from the records', () => {
  let dir: string;
  let store: Store;
  const set = async (entries: Record<string, ReturnEntry['value']>) => {
    const current = store.taxReturn('2025/26')?.entries ?? {};
    const next = { ...current, ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { value: v, updatedAt: stamp }])) };
    await store.setReturns([{ id: '2025-26', taxYear: '2025/26', entries: next, updatedAt: stamp }], 'test: return');
  };
  const view = () => taxReturn(store, '2025/26', undefined, NOW)!;
  const boxOf = (key: string) => view().pages.flatMap((p) => p.boxes).find((b) => b.key === key);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-return-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([account('saver', 'savings'), account('gia', 'gia', { openedOn: '2025-05-01' })]);
    await store.setEmployments([job('oak', 'Oak Fabrication Ltd', { payeReference: '111/AL123' }), job('maple', 'Maple Studio Ltd')]);
    await store.setCompanies([{ id: 'maple', name: 'Maple Studio Ltd', number: '12345678', holdings: [{ shareClass: 'Ordinary', shares: 60, totalShares: 100, source: {} }], valuations: [], employmentId: 'maple', createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    await store.addFigures(
      [
        // Oak: a P60 for the year. Maple: HMRC's figure for the finished year, no tax known.
        fig('gross_pay', 18400.4, 'Oak Fabrication Ltd', { employmentId: 'oak', label: 'P60', periodStart: '2025-04-06', periodEnd: '2026-04-05' }),
        fig('tax_deducted', 1050.6, 'Oak Fabrication Ltd', { employmentId: 'oak', label: 'P60', periodStart: '2025-04-06', periodEnd: '2026-04-05' }),
        fig('gross_pay', 12, 'Maple Studio Ltd', { employmentId: 'maple', label: 'Taxable income from employment', periodStart: '2025-04-06', periodEnd: '2026-04-05' }),
        // A dividend voucher from a company the owner holds shares in but does not direct.
        fig('dividends_paid', 3200, 'Birchwood Ltd', { periodEnd: '2025-10-01', date: '2025-10-01' }),
        // The savings account's interest statement for the year.
        fig('interest_paid', 1600.55, 'saver', { accountId: 'saver', periodStart: '2025-04-06', periodEnd: '2026-04-05' }),
        // The platform's statement: dividends before foreign tax, for its account.
        fig('dividends_paid', 16.55, 'Example Platform', { accountId: 'gia', periodStart: '2025-04-06', periodEnd: '2026-04-05' }),
      ],
      'test: figures',
    );
    // Its payments, each after the US tax taken off: $1.50 and $0.75 at 0.80, and one UK dividend.
    await store.addTransactions([dividendTx(1, '2025-07-01', 8.5, 'US0000000001', 1.5), dividendTx(2, '2025-10-01', 4.25, 'US0000000002', 0.75), dividendTx(3, '2025-12-01', 2, 'GB0000000003', 0)], 'test: dividends');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('carries each figure into its box: pay and tax by job, interest, UK dividends, and the platform’s foreign dividends by country', () => {
    const r = view();
    expect(r.forms).toMatchObject({ taxYear: '2025/26', own: true });
    expect(boxOf('SA102:job-oak:1')).toMatchObject({ state: 'records', entered: '18400.40', paper: '18400' });
    // Tax taken off is rounded up on paper; online it keeps its pence.
    expect(boxOf('SA102:job-oak:2')).toMatchObject({ entered: '1050.60', paper: '1051' });
    expect(boxOf('SA102:job-oak:4')).toMatchObject({ value: '111/AL123' });
    expect(boxOf('TR3:2')).toMatchObject({ value: 1600.55, state: 'records' });
    // The UK dividend voucher, and the platform's dividend on a GB ISIN.
    expect(boxOf('TR3:4')).toMatchObject({ value: 3202, state: 'records' });
    // US: $1.50 × 0.80 = £1.20 and $0.75 × 0.80 = £0.60 taken off; before it, £9.70 and £4.85.
    expect(boxOf('SA106:USA:B')).toMatchObject({ value: 14.55 });
    expect(boxOf('SA106:USA:C')).toMatchObject({ value: 1.8 });
    expect(boxOf('SA106:USA:E')).toMatchObject({ value: true, entered: 'X' });
    expect(boxOf('SA106:USA:F')).toMatchObject({ value: 14.55 });
    // Total dividends are over £500, so the foreign ones go on the Foreign page, which TR 2 asks for.
    expect(boxOf('TR2:Q5')).toMatchObject({ value: true, entered: 'Yes' });
    expect(boxOf('TR3:6')).toBeUndefined();
    // The figures agree with Tax → Allowances.
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('keeps a gap apart from a nil: tax for a job is missing until you say it was none', async () => {
    expect(boxOf('SA102:job-maple:2')).toMatchObject({ state: 'missing', value: null, entered: '' });
    expect(view().readiness.blockers.some((b) => b.key === 'SA102:job-maple:2' && b.kind === 'missing')).toBe(true);
    await set({ 'SA102:job-maple:2': null });
    expect(boxOf('SA102:job-maple:2')).toMatchObject({ state: 'nil', value: null, basis: 'None, as you confirmed' });
    expect(view().readiness.blockers.some((b) => b.key === 'SA102:job-maple:2')).toBe(false);
  });

  it('a director of a close company: the new 2025–26 boxes, from the company in the records', async () => {
    // Box 6 must be answered for every job.
    expect(boxOf('SA102:job-maple:6')).toMatchObject({ state: 'missing', always: true });
    await set({ 'SA102:job-maple:6': true, 'SA102:job-maple:7': true, 'SA102:job-oak:6': false });
    expect(boxOf('SA102:job-maple:6')).toMatchObject({ entered: 'Yes', state: 'yours' });
    expect(boxOf('SA102:job-oak:6')).toMatchObject({ entered: 'No' });
    expect(boxOf('SA102:job-oak:7')).toBeUndefined();
    expect(boxOf('SA102:job-maple:7.1')).toMatchObject({ value: 'Maple Studio Ltd', state: 'records' });
    expect(boxOf('SA102:job-maple:7.2')).toMatchObject({ value: '12345678' });
    // No dividends from it in the records: missing until you say none, then 0, which the form says to enter.
    expect(boxOf('SA102:job-maple:7.3')).toMatchObject({ state: 'missing' });
    await set({ 'SA102:job-maple:7.3': null });
    expect(boxOf('SA102:job-maple:7.3')).toMatchObject({ state: 'nil', entered: '0.00', paper: '0' });
    expect(boxOf('SA102:job-maple:7.4')).toMatchObject({ value: 60, entered: '60%' });
  });

  it('a close company’s dividends go in box 7.3 as well as TR 3 box 4', async () => {
    await store.addFigures([fig('dividends_paid', 900, 'Maple Studio Ltd', { periodEnd: '2026-03-01', date: '2026-03-01' })], 'test: maple dividend');
    await set({ 'SA102:job-maple:6': true, 'SA102:job-maple:7': true });
    expect(boxOf('SA102:job-maple:7.3')).toMatchObject({ value: 900 });
    expect(boxOf('TR3:4')).toMatchObject({ value: 4102 });
  });

  it('your figure replaces the records’ and says what they gave; the tax follows it', async () => {
    const before = view().calculation.incomeTaxCharged;
    await set({ 'TR3:2': 1700 });
    expect(boxOf('TR3:2')).toMatchObject({ state: 'yours', value: 1700, fromRecords: 1600.55 });
    expect(view().calculation.incomeTaxCharged).toBeCloseTo(before + 100 * 0.2, 2);
    // The check against Allowances now says they differ.
    expect(view().checks.find((c) => c.label.startsWith('Interest'))!.ok).toBe(false);
  });

  it('works out the tax from the boxes as entered: income down to whole pounds box by box, tax taken off in pence', async () => {
    await set({ 'SA102:job-maple:2': null });
    const c = view().calculation;
    const expected = computeTax({
      ty: taxYear(2025),
      nonSavings: { employment: 18400 + 12 },
      savings: 1600,
      dividends: 3202 + 14,
      foreignDividends: [{ label: 'USA', amount: 14.55, taxTaken: 1.8 }],
      bandExtension: { reliefAtSource: 0, giftAid: 0 },
      deducted: { paye: 1050.6, taxedInterest: 0 },
      codeOut: true,
    });
    expect(c.totalIncome).toBe(expected.totalIncome);
    expect(c.incomeTaxDue).toBe(expected.incomeTaxDue);
    expect(c.reducers.find((x) => x.id === 'foreign-tax-credit')!.tax).toBeLessThan(0);
    expect(c.balancing).toBe(expected.balancing);
  });

  it('questions decide which boxes apply, and a yes to something not prepared here keeps the return from being ready', async () => {
    expect(boxOf('TR4:5')).toBeUndefined();
    await set({ 'q:gift-aid': true });
    expect(boxOf('TR4:5')).toMatchObject({ state: 'missing' });
    await set({ 'TR4:5': 400 });
    // £400 given is £500 grossed up: the basic rate band widens by it.
    expect(view().calculation.basicRateLimit).toBe(37700 + 500);
    await set({ 'q:property': true });
    expect(view().readiness.blockers.find((b) => b.key === 'q:property')).toMatchObject({ kind: 'not-covered' });
  });

  it('a student loan whose repayments were not due puts nothing on the return', async () => {
    await store.setAccounts([...store.accounts, account('loan', 'student_loan', { includeInNetWorth: false })]);
    expect(view().questions.find((q) => q.key === 'q:student-loan')!.state).toBe('unanswered');
    await set({ 'q:student-loan': 'not-started' });
    expect(boxOf('TR5:SL1')).toMatchObject({ value: null, state: 'nil' });
    expect(view().calculation.studentLoan).toBeNull();
    await set({ 'q:student-loan': 'plan2' });
    expect(boxOf('TR5:SL1')).toMatchObject({ value: true, entered: 'X' });
    expect(view().calculation.studentLoan).not.toBeNull();
  });

  it('a refund from HMRC in the year is asked about, never assumed: one for an earlier year must not count', async () => {
    const before = view().calculation.balancing;
    await store.setAccounts([...store.accounts, account('bank', 'current')]);
    await store.addTransactions([{ id: transactionId('bank', '2025-06-20', 412.3, 'HMRC PAYE REFUND', 0), accountId: 'bank', date: '2025-06-20', amount: 412.3, currency: 'GBP', description: 'HMRC PAYE REFUND', category: 'tax-refund', source: {} }], 'test: refund');
    const q = view().questions.find((x) => x.key === 'q:refunded')!;
    expect(q.state).toBe('unanswered');
    expect(q.help).toMatch(/£412\.30 on 20 Jun 2025/);
    expect(view().calculation.balancing).toBe(before);
  });

  it('what is left to pay, with and without the tax code collecting it', async () => {
    await set({ 'SA102:job-maple:2': null });
    const o = view().owed;
    expect(o.balance).toBeGreaterThan(0);
    expect(o.withCoding).toMatchObject({ by: '2026-12-30', dueJanuary: 0, dueJuly: 0 });
    expect(o.withoutCoding.dueJanuary).toBeGreaterThanOrEqual(o.balance);
    // No return for 2024/25 in the records: no payments on account made for 2025/26.
    expect(o.paymentsOnAccountMade).toBe(0);
    // Saying no to coding out: TR 6 box 2 gets its X.
    await set({ 'TR6:2': true });
    expect(boxOf('TR6:2')).toMatchObject({ entered: 'X' });
    expect(view().calculation.codedOut).toBe(0);
  });

  it('never ready while a Yes has no figures, a job may be missing, or a required answer is set to none', async () => {
    await set({ 'q:pensions-benefits': true, 'q:all-jobs': false });
    const r = view();
    expect(r.readiness.blockers.find((b) => b.key === 'TR3:8')).toMatchObject({ kind: 'missing' });
    expect(r.readiness.blockers.find((b) => b.key === 'q:all-jobs')).toMatchObject({ kind: 'missing' });
    // A nil for the director question is no answer: it stays missing.
    await set({ 'SA102:job-oak:6': null, 'SA102:job-oak:1': null });
    expect(boxOf('SA102:job-oak:6')).toMatchObject({ state: 'missing', nilRefused: true });
    expect(boxOf('SA102:job-oak:1')).toMatchObject({ state: 'records', value: 18400.4 });
  });

  it('platform dividends that cannot all be matched to a country stay in box 4, said, never hidden', async () => {
    // A fourth payment: the payments no longer add up to the statement.
    await store.addTransactions([dividendTx(4, '2026-01-10', 3, 'US0000000004', 0)], 'test: another');
    expect(boxOf('TR3:4')).toMatchObject({ state: 'check', value: 3216.55 });
    expect(boxOf('TR3:4')!.check).toMatch(/not split by country/);
    expect(boxOf('SA106:USA:B')).toBeUndefined();
  });

  it('a year before the forms here has no return box by box; a year after them uses the latest forms, saying so', () => {
    expect(taxReturn(store, '2024/25', undefined, NOW)).toBeNull();
    const next = taxReturn(store, '2026/27', undefined, NOW)!;
    expect(next.forms).toMatchObject({ taxYear: '2025/26', own: false });
    expect(next.readiness.blockers.map((b) => b.key)).toEqual(expect.arrayContaining(['forms', 'year']));
  });
});

describe('setting a box or question', () => {
  let dir: string;
  let app: App;
  const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-return-api-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    await app.ctx.store.setEmployments([job('oak', 'Oak Fabrication Ltd')]);
    await app.ctx.store.addFigures([fig('gross_pay', 20000, 'Oak Fabrication Ltd', { employmentId: 'oak', label: 'P60', periodStart: '2025-04-06', periodEnd: '2026-04-05' })], 'test');
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const put = (body: unknown) => app.app.request('http://localhost/api/self-assessment/entry', { method: 'PUT', headers: { host: 'localhost', ...CSRF }, body: JSON.stringify(body) });

  it('takes a value of the box’s kind, a nil, or clears it; refuses anything else', async () => {
    expect((await put({ taxYear: '2025/26', key: 'SA102:job-oak:2', value: 2100.4, note: 'P60' })).status).toBe(200);
    expect(app.ctx.store.taxReturn('2025/26')!.entries['SA102:job-oak:2']).toMatchObject({ value: 2100.4, note: 'P60' });
    expect((await put({ taxYear: '2025/26', key: 'SA102:job-oak:2', value: null })).status).toBe(200);
    expect((await put({ taxYear: '2025/26', key: 'SA102:job-oak:2', clear: true })).status).toBe(200);
    expect(app.ctx.store.taxReturn('2025/26')!.entries['SA102:job-oak:2']).toBeUndefined();
    // Not a box on the return; a value of the wrong kind; more than 2 decimal places; a box that is worked out.
    expect((await put({ taxYear: '2025/26', key: 'TR9:1', value: 1 })).status).toBe(400);
    expect((await put({ taxYear: '2025/26', key: 'SA102:job-oak:6', value: 'maybe' })).status).toBe(400);
    expect((await put({ taxYear: '2025/26', key: 'SA102:job-oak:2', value: 1.234 })).status).toBe(400);
    expect((await put({ taxYear: '2025/26', key: 'TR2:Q1', value: false })).status).toBe(400);
    // A question takes yes or no, or one of its choices.
    expect((await put({ taxYear: '2025/26', key: 'q:property', value: false })).status).toBe(200);
    expect((await put({ taxYear: '2025/26', key: 'q:student-loan', value: 'plan9' })).status).toBe(400);
    expect((await put({ taxYear: '2025/26', key: 'q:student-loan', value: 'not-started' })).status).toBe(200);
  });

  it('is your session’s alone: no agent token may set one', () => {
    expect(requiredScope('PUT', '/api/self-assessment/entry')).toBeNull();
  });
});
