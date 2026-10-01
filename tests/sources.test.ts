// One source per employer and year, dividends and pensions counted once, forecasts kept, NI numbers
// kept out (docs/FORMULAS.md §11, §12, §14, §9). Every name, number and amount here is invented.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances } from '../src/server/analytics/allowances';
import { BalanceEngine } from '../src/server/analytics/balances';
import { investments } from '../src/server/analytics/investments';
import { selfAssessment } from '../src/server/analytics/selfassessment';
import { payByEmployer, payeReference } from '../src/server/analytics/sources';
import { hmrcId, transactionId } from '../src/server/ids';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';
import { isNiNumber, withoutNiNumbers } from '../src/shared/privacy';
import { ExtractionSchema, type Account, type ImportRecord, type Transaction } from '../src/shared/schema';
import { taxYear } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
let dir: string;
let store: Store;
let n = 0;

const account = (id: string, type: Account['type'], name = id, extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const credit = (accountId: string, date: string, amount: number, description: string, category?: string): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, ...(category ? { category, categorisedBy: 'user' as const } : {}), source: {} });

type FigureIn = { kind: string; label?: string; amount: number; taxYear?: string; periodStart?: string; periodEnd?: string; payer?: string; payerReference?: string };

/** Read, draft and commit one document the way an upload is: its type decides what its figures are. */
async function importDocument(documentType: string, figures: FigureIn[], extra: { accounts?: unknown[]; hintAccountId?: string; documentDate?: string } = {}) {
  const i = n++;
  const record: ImportRecord = {
    id: `imp_20261001_12${String(i).padStart(4, '0')}_${(0xa000 + i).toString(16)}`,
    status: 'review',
    createdAt: '2026-10-01T12:00:00+01:00',
    updatedAt: '2026-10-01T12:00:00+01:00',
    origin: 'upload',
    document: { id: `doc_${String(i).padStart(16, '0')}`, sha256: String(i).padStart(64, '0'), fileName: `${documentType}-${i}.pdf`, mediaType: 'application/pdf', size: 1 },
    extraction: { warnings: [] },
  };
  const reading = ExtractionSchema.parse({ documentType, accounts: extra.accounts ?? [], figures: figures.map((f) => ({ label: f.kind, currency: 'GBP', ...f })), ...(extra.documentDate ? { documentDate: extra.documentDate } : {}) });
  const draft = buildDraft(reading, { store, document: record.document, uploadedOn: '2026-10-01', ...(extra.hintAccountId ? { hintAccountId: extra.hintAccountId } : {}) });
  const workFile = path.join(dir, `${record.id}.pdf`);
  await writeFile(workFile, 'x');
  return commitDraft(store, { record: { ...record, extraction: { warnings: [], raw: reading } }, draft, workFile });
}

const payslip = (month: string, gross: number, tax: number, payer: string, extra: Partial<FigureIn>[] = []) => {
  const end = `${month}-${['02'].includes(month.slice(5)) ? '28' : ['04', '06', '09', '11'].includes(month.slice(5)) ? '30' : '31'}`;
  return importDocument('payslip', [
    { kind: 'gross_pay', amount: gross, taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: end, payer },
    { kind: 'tax_deducted', amount: tax, taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: end, payer },
    ...extra.map((x) => ({ amount: 0, kind: 'national_insurance', taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: end, payer, ...x })),
  ], { documentDate: end });
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-sources-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([account('current', 'current', 'Current account')]);
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('one source per employer and year', () => {
  it('counts one job once when its payslips, a P45 and an HMRC page all state it: the latest', async () => {
    for (const m of ['2026-04', '2026-05', '2026-06']) await payslip(m, 2000, 200, 'Quillon Systems Ltd');
    // The P45 (to the leaving day) and HMRC's page (to the last pay date) state the same taxable pay.
    await importDocument('tax_document', [
      { kind: 'gross_pay', label: 'Total pay to date', amount: 5700, taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2026-07-03', payer: 'QUILLON SYSTEMS LIMITED', payerReference: '123/QS4567' },
      { kind: 'tax_deducted', label: 'Total tax to date', amount: 600, taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2026-07-03', payer: 'QUILLON SYSTEMS LIMITED', payerReference: '123/QS4567' },
    ]);
    await importDocument('tax_document', [
      { kind: 'gross_pay', label: 'Taxable income', amount: 5700, taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2026-07-27', payer: 'Quillon Systems Ltd', payerReference: '123 QS4567' },
      { kind: 'tax_deducted', label: 'Income Tax paid', amount: 600, taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2026-07-27', payer: 'Quillon Systems Ltd', payerReference: '123 QS4567' },
    ]);
    const ty = taxYear(2026);
    const [job, ...others] = payByEmployer(store, ty);
    expect(others).toEqual([]);
    expect(job).toMatchObject({ amount: 5700, final: false, payeReference: '123/QS4567', source: { kind: 'to-date', label: 'to 27 Jul 2026', asOf: '2026-07-27' } });
    expect(job!.others.map((s) => [s.kind, s.amount, s.asOf])).toEqual(
      expect.arrayContaining([
        ['payslips', 6000, '2026-06-30'],
        ['to-date', 5700, '2026-07-03'],
      ]),
    );
    const sa = selfAssessment(store, '2026/27').sections[0]!.items;
    expect(sa.find((i) => i.id === 'pay')).toMatchObject({ amount: 5700, status: 'check' });
    expect(sa.find((i) => i.id === 'paye-tax')).toMatchObject({ amount: 600 });
  });

  it('a page to a date does not stop later payslips counting', async () => {
    await importDocument('tax_document', [{ kind: 'gross_pay', amount: 1200, taxYear: '2026/27', periodStart: '2026-08-27', periodEnd: '2026-08-27', payer: 'LARCHWOOD DATA LTD' }]);
    await payslip('2026-08', 1200, 20, 'Larchwood Data Ltd');
    await payslip('2026-09', 900, 0, 'Larchwood Data Ltd');
    const [job] = payByEmployer(store, taxYear(2026));
    expect(job).toMatchObject({ amount: 2100, source: { kind: 'payslips', asOf: '2026-09-30' } });
  });

  it('a P60 counts over another figure for the whole year, never beside it', async () => {
    const year = { taxYear: '2025/26', periodStart: '2025-04-06', periodEnd: '2026-04-05', payer: 'Oakfield Engineering Ltd' };
    await importDocument('p60', [
      { kind: 'gross_pay', amount: 16000, ...year },
      { kind: 'tax_deducted', amount: 900, ...year },
    ]);
    await importDocument('tax_document', [{ kind: 'gross_pay', amount: 16000, ...year, payer: 'OAKFIELD ENGINEERING LIMITED' }]);
    const [job, ...others] = payByEmployer(store, taxYear(2025));
    expect(others).toEqual([]);
    expect(job).toMatchObject({ amount: 16000, final: true, source: { label: 'P60' } });
    expect(allowances(store, '2025/26', '2026-10-01').taxBand).toMatchObject({ basis: 'documents' });
    expect(selfAssessment(store, '2025/26').sections[0]!.items.find((i) => i.id === 'pay')).toMatchObject({ amount: 16000, status: 'ready', basis: 'P60 figures' });
  });

  it('one employer under two names when they share a PAYE reference', async () => {
    const year = { taxYear: '2025/26', periodStart: '2025-04-06', periodEnd: '2026-04-05' };
    await importDocument('p60', [{ kind: 'gross_pay', amount: 8000, ...year, payer: 'Hartwell Group', payerReference: '456/HW12' }]);
    await importDocument('tax_document', [{ kind: 'gross_pay', amount: 8000, ...year, payer: 'Quillon Systems Ltd', payerReference: '456 hw12' }]);
    expect(payByEmployer(store, taxYear(2025)).map((e) => [e.payer, e.amount])).toEqual([['Hartwell Group', 8000]]);
    expect(payeReference('456 hw12')).toBe('456/HW12');
    expect(payeReference('01234567')).toBeUndefined();
  });

  it('Self Assessment names the jobs whose tax is not known', async () => {
    const year = { taxYear: '2025/26', periodStart: '2025-04-06', periodEnd: '2026-04-05' };
    await importDocument('p60', [
      { kind: 'gross_pay', amount: 9000, ...year, payer: 'Larchwood Data Ltd' },
      { kind: 'tax_deducted', amount: 400, ...year, payer: 'Larchwood Data Ltd' },
    ]);
    // HMRC's taxable-income page gives each job's pay for the year, not its tax.
    await importDocument('tax_document', [{ kind: 'gross_pay', amount: 2250, ...year, payer: 'OAKFIELD ENGINEERING LTD' }]);
    const items = selfAssessment(store, '2025/26').sections[0]!.items;
    expect(items.find((i) => i.id === 'pay')).toMatchObject({ amount: 11250, status: 'ready' });
    const tax = items.find((i) => i.id === 'paye-tax')!;
    expect(tax).toMatchObject({ amount: 400, status: 'check', basis: 'Some jobs only' });
    expect(tax.notes.join(' ')).toMatch(/not known for OAKFIELD ENGINEERING LTD/);
  });
});

describe('dividends counted once', () => {
  it('a voucher and the credit that paid it are one dividend; other credits and vouchers still count', async () => {
    await store.addTransactions(
      [
        credit('current', '2026-04-20', 5000, 'FASTER PAYMENTS RECEIPT REF.Dividend FROM BRAMBLEWORTH LTD', 'dividends'),
        credit('current', '2026-11-03', 750, 'FASTER PAYMENTS RECEIPT REF.Dividend FROM BRAMBLEWORTH LTD', 'dividends'),
      ],
      'test: dividends',
    );
    await importDocument('tax_document', [
      { kind: 'dividends_paid', label: 'Dividend:', amount: 5000, taxYear: '2026/27', periodStart: '2026-04-19', periodEnd: '2026-04-19', payer: 'Brambleworth Ltd' },
      { kind: 'dividends_paid', label: 'Dividend:', amount: 300, taxYear: '2026/27', periodStart: '2026-06-01', periodEnd: '2026-06-01', payer: 'Fernhill Holdings Ltd' },
    ]);
    const d = allowances(store, '2026/27', '2026-12-01').dividends;
    // £5,000 once (voucher + its credit), the £300 voucher with no credit, the £750 credit with no voucher.
    expect(d.amount).toBe(6050);
    expect(d.lines.map((l) => [l.label, l.amount, l.source])).toEqual([
      ['Brambleworth Ltd (voucher, paid into Current account on 20 Apr 2026)', 5000, 'figure'],
      ['Fernhill Holdings Ltd (voucher)', 300, 'figure'],
      ['Current account', 750, 'transactions'],
    ]);
    const hint = selfAssessment(store, '2026/27').mayNeedToFile.find((m) => m.reason === 'Dividends over the dividend allowance')!;
    expect(hint.detail).toMatch(/by 5 Oct 2027/);
  });
});

describe('pension contributions, scheme by scheme', () => {
  it('a statement and the payslips that paid it count once; another scheme adds to it', async () => {
    await store.setAccounts([account('current', 'current', 'Current account'), account('quillon-plan', 'workplace_pension', 'Quillon Money Purchase Plan'), account('sipp', 'sipp', 'SIPP', { pension: { method: 'relief_at_source' } })]);
    // Twelve payslips' pension deductions, £100 each, in 2025/26.
    for (let m = 0; m < 12; m++) {
      const month = `${m < 9 ? '2025' : '2026'}-${String(((m + 3) % 12) + 1).padStart(2, '0')}`;
      await importDocument('payslip', [{ kind: 'pension_contribution_employee', amount: 100, taxYear: '2025/26', periodStart: `${month}-01`, periodEnd: `${month}-28`, payer: 'Quillon Systems Ltd' }]);
    }
    // The scheme's statement for the year: the same £1,200, and the employer's £1,200.
    await importDocument(
      'pension_statement',
      [
        { kind: 'pension_contribution_employee', amount: 1200, taxYear: '2025/26', periodEnd: '2026-04-05', payer: 'Quillon UK' },
        { kind: 'pension_contribution_employer', amount: 1200, taxYear: '2025/26', periodEnd: '2026-04-05', payer: 'Quillon UK' },
      ],
      { accounts: [{ accountName: 'Quillon Money Purchase Plan', accountType: 'workplace_pension', closingBalance: 2500, balanceDate: '2026-04-05' }], hintAccountId: 'quillon-plan' },
    );
    await store.addTransactions([credit('sipp', '2025-06-01', 500, 'Employer Contribution', 'employer-contribution')], 'test: SIPP');
    const p = allowances(store, '2025/26', '2026-10-01').pension;
    expect(p).toMatchObject({ personalGross: 1200, employer: 1700, total: 2900 });
  });
});

describe('a pension forecast with no balance', () => {
  it('is kept as its income per year, and the retirement outlook uses it', async () => {
    await store.setProfile({ ...store.profile, dateOfBirth: '1990-03-01' });
    await store.setAccounts([account('current', 'current', 'Current account'), account('state', 'state_pension', 'State Pension', { includeInNetWorth: false })]);
    const rec = await importDocument('pension_statement', [], { accounts: [{ accountName: 'State Pension', accountType: 'state_pension', annualIncome: 11500.5, balanceDate: '2026-09-30' }], hintAccountId: 'state' });
    expect(rec.result?.figuresAdded).toBe(1);
    expect(store.figures.find((f) => f.kind === 'pension_income_forecast')).toMatchObject({ accountId: 'state', amount: 11500.5, date: '2026-09-30' });
    expect(investments(store, new BalanceEngine(store)).retirement.statePension).toMatchObject({ annual: 11500.5, source: 'forecast' });
  });

  it('HMRC’s forecast, when newer, takes over, from the State Pension age it gives', async () => {
    await store.setProfile({ ...store.profile, dateOfBirth: '1990-03-01' });
    await store.setAccounts([account('current', 'current', 'Current account'), account('state', 'state_pension', 'State Pension', { includeInNetWorth: false })]);
    await importDocument('pension_statement', [], { accounts: [{ accountName: 'State Pension', accountType: 'state_pension', annualIncome: 11500.5, balanceDate: '2026-09-30' }], hintAccountId: 'state' });
    const forecast = { type: 'state-pension-forecast' as const, asOf: '2026-10-01', weekly: 230.25, annual: 12006.75, payableFrom: '2058-03-01' };
    await store.upsertRecords('hmrc', [{ ...forecast, id: hmrcId(forecast), accountId: 'state', source: {}, createdAt: stamp }], 'test: HMRC forecast');
    expect(investments(store, new BalanceEngine(store)).retirement.statePension).toEqual({ annual: 12006.75, source: 'forecast', basis: 'HMRC’s forecast of 1 Oct 2026 (in today\'s money)', startsOn: '2058-03-01' });
  });
});

describe('National Insurance numbers', () => {
  it('are known in their usual forms, and nothing else is', () => {
    expect(isNiNumber('QQ123456C')).toBe(true);
    expect(isNiNumber('QQ 12 34 56 C')).toBe(true);
    expect(isNiNumber('123/AB456')).toBe(false);
    expect(isNiNumber('01234567')).toBe(false);
    expect(withoutNiNumbers('Reference: QQ 12 34 56 C, plan 262-737')).toBe('Reference: [NI number], plan 262-737');
    // Inside a longer bank reference it is a source fact, and left alone.
    expect(withoutNiNumbers('BANK GIRO CREDIT REF HMRC PAYE, TQQ12345607182928')).toBe('BANK GIRO CREDIT REF HMRC PAYE, TQQ12345607182928');
  });

  it('a reader’s "reference" that is one is left out of the figure', async () => {
    await importDocument('pension_statement', [{ kind: 'pension_contribution_employee', amount: 50, taxYear: '2025/26', periodEnd: '2026-04-05', payer: 'Quillon UK', payerReference: 'QQ123456C' }]);
    expect(store.figures[0]!.payerReference).toBeUndefined();
  });
});

describe('format v4 migration', () => {
  it('records a forecast an import dropped, and takes NI numbers out of figures and readings', async () => {
    const data = path.join(dir, 'v3');
    await mkdir(path.join(data, 'imports', '2026'), { recursive: true });
    await writeFile(path.join(data, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 3, baseCurrency: 'GBP', createdAt: stamp }));
    const imp = {
      id: 'imp_20260930_200516_0a01',
      status: 'committed',
      committedAt: '2026-09-30T20:06:26+01:00',
      document: { id: 'doc_0000000000000a01' },
      extraction: { raw: { figures: [{ kind: 'pension_contribution_employee', payerReference: 'QQ 12 34 56 C' }], notes: ['Reference: QQ123456C'] } },
      draft: { sections: [{ key: 's0', target: { mode: 'new' }, recordBalance: false, balanceDate: '2026-09-30', annualIncome: 11500.5, currency: 'GBP' }] },
      result: { sections: [{ key: 's0', accountId: 'state' }] },
    };
    await writeFile(path.join(data, 'imports', '2026', `${imp.id}.json`), `${JSON.stringify(imp, null, 2)}\n`);
    await writeFile(path.join(data, 'figures.jsonl'), `${JSON.stringify({ id: 'fig_00000000000000a1', kind: 'pension_contribution_employee', label: 'paid', amount: 50, currency: 'GBP', taxYear: '2025/26', payer: 'Quillon UK', payerReference: 'QQ123456C', source: {}, createdAt: stamp })}\n`);
    expect(await runMigrations(data, () => undefined)).toMatchObject({ from: 3, to: 6 });
    const figures = (await readFile(path.join(data, 'figures.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(figures[0]).not.toHaveProperty('payerReference');
    expect(figures[1]).toMatchObject({ kind: 'pension_income_forecast', accountId: 'state', amount: 11500.5, date: '2026-09-30', source: { importId: imp.id } });
    const after = await readFile(path.join(data, 'imports', '2026', `${imp.id}.json`), 'utf8');
    expect(after).not.toMatch(/QQ ?12 ?34 ?56 ?C/);
    expect(after).toMatch(/Reference: \[NI number\]/);
  });
});
