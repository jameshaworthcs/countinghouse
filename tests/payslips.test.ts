// Payslips in full (docs/INGESTION.md, "Payslips read on this machine"; FORMULAS.md §17, "Payslips in
// full"). Every fixture is invented; the NI numbers on them are HMRC's example prefix.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pensionTotals } from '../src/server/analytics/allowances';
import { Coverage } from '../src/server/analytics/coverage';
import { pay } from '../src/server/analytics/pay';
import { employerCostsOf, payslipGaps } from '../src/server/analytics/payslips';
import { payByEmployer } from '../src/server/analytics/sources';
import { selfAssessment } from '../src/server/analytics/selfassessment';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { payslipId, transactionId } from '../src/server/ids';
import { readSapPaystub, readUkPayslip, sapAmount } from '../src/server/ingest/payslips';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';
import type { TaxDocumentsResponse } from '../src/shared/api';
import { PayslipRecordSchema, type ImportRecord, type PayslipRecord } from '../src/shared/schema';
import { taxYear } from '../src/shared/uk';
import { textPdf } from './pdf';

const HAVE_PDFTOTEXT = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const withPdf = HAVE_PDFTOTEXT ? it : it.skip;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures', 'payslips', name), 'utf8');
const stamp = '2026-01-01T00:00:00+00:00';
const CSRF = { 'x-finance-csrf': '1' };
const NI = /[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]/;

describe('payslips read on this machine', () => {
  it('read an SAP paystub in full: every line, the totals, the codes and the year to date', async () => {
    const e = readSapPaystub(await fixture('sap-paystub.layout.txt'))!;
    expect(e).toMatchObject({ documentType: 'payslip', documentDate: '2025-10-31', confidence: 'high' });
    expect(e.payslips).toEqual([
      {
        employer: 'Quillon Systems Ltd',
        otherNames: ['Quillon Group Ltd'],
        payrollNumber: '88001234',
        payDate: '2025-10-31',
        periodStart: '2025-10-01',
        periodEnd: '2025-10-31',
        periodNumber: 7,
        frequency: 'monthly',
        taxCode: '1257L',
        niLetter: 'A',
        payMethod: 'BACS Trans',
        department: 'QS-ENG/DATA',
        payments: [
          { label: 'Monthly Salary', amount: -120 },
          { label: 'Monthly Salary', amount: 2500 },
          { label: 'Overtime', amount: 100, quantity: 4, rate: 25 },
        ],
        deductions: [
          { label: 'Tax paid', amount: 406.4 },
          { label: 'Employee NIC', amount: 118.32 },
          { label: 'Pension Deduction', amount: -10 },
          { label: 'Pension Deduction', amount: 125 },
          { label: 'Student Loan', amount: 45 },
        ],
        totals: { payments: 2480, deductions: 684.72, net: 1795.28 },
        employerCosts: {},
        yearToDate: { gross: 17360, taxable: 16520, tax: 2844.8, ni: 828.24, niEmployer: 1640.2, pension: 840, pensionEmployer: 1260 },
      },
    ]);
    // The period's figures, as a reader always gave them: lines of one kind add up.
    expect(e.figures.map((f) => [f.kind, f.amount, f.taxCode])).toEqual([
      ['gross_pay', 2480, '1257L'],
      ['tax_deducted', 406.4, null],
      ['national_insurance', 118.32, null],
      ['pension_contribution_employee', 115, null],
      ['student_loan_deducted', 45, null],
    ]);
    expect(JSON.stringify(e)).not.toMatch(NI);
    expect(JSON.stringify(e)).not.toMatch(/A N Other/);
  });

  it('read the classic UK payslip in full, keeping the NI letter and never the number', async () => {
    const e = readUkPayslip(await fixture('uk-payslip.raw.txt'))!;
    expect(e.payslips[0]).toEqual({
      employer: 'LARCHWOOD DATA LTD',
      otherNames: [],
      payDate: '2026-10-05',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      periodLabel: 'Sep-2026',
      frequency: 'monthly',
      taxCode: '1257L',
      cumulative: false,
      niLetter: 'A',
      payMethod: 'Bank Transfer',
      department: 'Analytics',
      payments: [{ label: 'Basic Pay', amount: 2150 }],
      deductions: [
        { label: 'Income Tax', amount: 213.4 },
        { label: 'National Insurance', amount: 85.28 },
        { label: 'Pension', amount: 50 },
        { label: 'Cycle Scheme', amount: 40 },
      ],
      totals: { payments: 2150, deductions: 388.68, taxable: 2100, nonTaxable: 0, net: 1761.32 },
      employerCosts: { ni: 200.1 },
      yearToDate: { gross: 6450, taxable: 6300, tax: 640.2, taxCredit: 0, ni: 255.84, niEmployer: 600.3, niablePay: 6450, ssp: 0, smp: 0, pension: 150, pensionEmployer: 90 },
    });
    expect(e.figures.map((f) => [f.kind, f.amount])).toEqual([
      ['gross_pay', 2150],
      ['tax_deducted', 213.4],
      ['national_insurance', 85.28],
      ['pension_contribution_employee', 50],
    ]);
    expect(e.figures[0]!.taxCode).toBe('1257L M1');
    expect(JSON.stringify(e)).not.toMatch(NI);
  });

  it('say when the lines do not add up to what the payslip prints', async () => {
    const e = readUkPayslip((await fixture('uk-payslip.raw.txt')).replace('Cycle Scheme 40.00', 'Cycle Scheme 4.00'))!;
    expect(e.confidence).toBe('medium');
    expect(e.notes.join(' ')).toMatch(/deduction lines read come to 352\.68, not the 388\.68 printed/);
  });

  it('read nothing that is not a payslip in a layout they know', () => {
    expect(readSapPaystub('Statement of account\nBalance 1.234,56')).toBeNull();
    expect(readUkPayslip('EMPLOYER\nSomeone\nDATE\n05-Oct-2026')).toBeNull();
    expect(sapAmount('1.234,56')).toBe(1234.56);
    expect(sapAmount('15,15-')).toBe(-15.15);
    expect(sapAmount('1,234.56')).toBeNull();
  });
});

const slip = (p: Partial<PayslipRecord> & { payDate: string }): PayslipRecord =>
  PayslipRecordSchema.parse({ employer: 'Larchwood Data Ltd', employmentId: 'larchwood', taxYear: '2026/27', payments: [], deductions: [], totals: {}, employerCosts: {}, yearToDate: {}, source: {}, createdAt: stamp, ...p, id: payslipId({ employer: 'Larchwood Data Ltd', totals: {}, ...p }) });

describe('the year to date on payslips', () => {
  it('shows pay on payslips not imported: before the first, or between two', () => {
    const list = [
      slip({ payDate: '2026-05-28', totals: { payments: 2000 }, yearToDate: { gross: 4000 } }),
      slip({ payDate: '2026-06-28', totals: { payments: 2000 }, yearToDate: { gross: 6000 } }),
      slip({ payDate: '2026-08-28', totals: { payments: 2100 }, yearToDate: { gross: 10100 } }),
    ];
    expect(payslipGaps(list).map((g) => [g.after?.payDate ?? null, g.before.payDate, g.amount])).toEqual([
      [null, '2026-05-28', 2000],
      ['2026-06-28', '2026-08-28', 2000],
    ]);
  });

  it('gives what the employer paid on top: printed, else the rise in the year to date', () => {
    const list = [
      slip({ payDate: '2026-04-28', totals: { payments: 2000 }, yearToDate: { gross: 2000, pensionEmployer: 100, niEmployer: 150 } }),
      slip({ payDate: '2026-05-28', totals: { payments: 2000 }, employerCosts: { ni: 151 }, yearToDate: { gross: 4000, pensionEmployer: 200, niEmployer: 301 } }),
      // A payslip is missing before this one: its rise is two months', so it says nothing of this one's.
      slip({ payDate: '2026-07-28', totals: { payments: 2000 }, yearToDate: { gross: 8000, pensionEmployer: 400 } }),
    ];
    expect([0, 1, 2].map((i) => employerCostsOf(list, i))).toEqual([{ ni: 150, pension: 100 }, { ni: 151, pension: 100 }, {}]);
  });
});

describe('payslips uploaded', () => {
  let app: App;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-payslips-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    // Never Claude in a test: a payslip no local reader knows goes to offline OCR instead.
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, extraction: { ...app.ctx.store.settings.extraction, engine: 'ocr' } });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const upload = async (name: string, lines: string[]) => {
    const form = new FormData();
    form.append('file', new Blob([textPdf(lines)]), name);
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    for (let i = 0; i < 200; i++) {
      const r = (await (await req(`/api/imports/${results[0]!.id}`)).json()) as ImportRecord;
      if (r.status === 'review' || r.status === 'failed') return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error('the upload was not read');
  };

  withPdf('are read on this machine and kept in full under their job; the net they print is the pay looked for', async () => {
    const lines = (await fixture('uk-payslip.raw.txt')).trim().split('\n');
    const rec = await upload('payslip-sep.pdf', lines);
    expect(rec.extraction).toMatchObject({ engine: 'payslip', engineVersion: 'payslip-1', detail: 'payslip, read on this machine' });
    expect(rec.draft!.payslips).toMatchObject([{ key: 's0', include: true, jobKey: 'j0' }]);
    expect(rec.draft!.jobs).toMatchObject([{ key: 'j0', target: { mode: 'new', employment: { id: 'larchwood-data' } } }]);
    expect((await req(`/api/imports/${rec.id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
    const { store } = app.ctx;
    expect(store.payslips).toMatchObject([{ employmentId: 'larchwood-data', taxYear: '2026/27', payDate: '2026-10-05', source: { importId: rec.id } }]);
    expect(JSON.stringify(store.payslips)).not.toMatch(NI);

    // The pay arrives: the payslip's own net (its cycle scheme taken too), not its pay less the
    // deductions that are tax figures.
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.addTransactions([{ id: transactionId('current', '2026-10-05', 1761.32, 'LARCHWOOD DATA LTD SALARY', 0), accountId: 'current', date: '2026-10-05', amount: 1761.32, currency: 'GBP', description: 'LARCHWOOD DATA LTD SALARY', category: 'salary', source: {} }], 'test: pay');
    const e = pay(store, new Coverage(store), '2026/27', '2026-10-06').employers.find((x) => x.employmentId === 'larchwood-data')!;
    expect(e.months[0]).toMatchObject({ status: 'paid', expectedNet: 1761.32, netPrinted: true, taxCode: '1257L M1', niLetter: 'A', employerCosts: { ni: 200.1 }, payslipId: store.payslips[0]!.id });
    // Its year to date has two months before it that no payslip imported shows.
    expect(e.gaps).toEqual([{ before: '2026-10-05', amount: 4300 }]);

    // The year so far is the payroll's own: taxable pay to date, not this payslip's gross alone.
    const [job] = payByEmployer(store, taxYear(2026));
    expect(job).toMatchObject({ employmentId: 'larchwood-data', amount: 6300, source: { label: 'year to date on the payslip of 5 Oct 2026' } });
    const sa = selfAssessment(store, '2026/27');
    expect(sa.sections[0]!.items.find((i) => i.id === 'pay')!.notes.join(' ')).toMatch(/pay £6,300\.00, from the year to date on the payslip of 5 Oct 2026: its P60 gives the year's figure/);
    // Pension so far, the employer's included, from the same column.
    expect(pensionTotals(store, taxYear(2026)).schemes).toMatchObject([{ label: 'LARCHWOOD DATA LTD (payslips)', personal: 15000, employer: 9000 }]);

    // Settings → Tax documents: the job's values with their sources, and its payslip kept in full.
    const docs = (await (await req('/api/tax-documents?taxYear=2026/27')).json()) as TaxDocumentsResponse;
    expect(docs.taxYear.label).toBe('2026/27');
    expect(docs.jobs).toMatchObject([
      {
        employmentId: 'larchwood-data',
        values: [
          { kind: 'gross_pay', label: 'Pay', chosen: { amount: 6300, label: 'year to date on the payslip of 5 Oct 2026', payslipId: store.payslips[0]!.id }, others: [{ kind: 'payslips', amount: 2150 }] },
          { kind: 'tax_deducted', chosen: { amount: 640.2 } },
          { kind: 'national_insurance', chosen: { amount: 255.84 } },
          { kind: 'pension_contribution_employee', label: 'Pension (you)', chosen: { amount: 150 }, others: [{ amount: 50 }] },
          { kind: 'pension_contribution_employer', label: 'Pension (employer)', chosen: { amount: 90 }, others: [] },
        ],
        payslips: [{ id: store.payslips[0]!.id, importId: rec.id, period: 'Sep 2026', gross: 2150, net: 1761.32, taxCode: '1257L M1' }],
        hmrcPayments: 0,
      },
    ]);
    expect(docs.other).toEqual([]);

    // The same payslip again adds nothing.
    const again = await upload('payslip-sep-copy.pdf', [...lines, '']);
    expect(again.draft!.payslips).toMatchObject([{ include: false, duplicateOf: store.payslips[0]!.id }]);
  });
});

describe('format v6 migration', () => {
  withPdf('reads stored payslips again in full, and puts right what their first reading got wrong', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-v6-'));
    try {
      const data = path.join(dir, 'data');
      await mkdir(path.join(data, 'imports', '2025'), { recursive: true });
      await mkdir(path.join(data, 'documents', '2025', '10'), { recursive: true });
      await writeFile(path.join(data, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 5, baseCurrency: 'GBP', createdAt: stamp }));
      await writeFile(path.join(data, 'employments.json'), JSON.stringify({ employments: [{ id: 'quillon', employer: 'Quillon Systems Ltd', aliases: [], payrollNumbers: ['88001234'], owed: [], createdBy: 'migration', createdAt: stamp, updatedAt: stamp }] }));
      await writeFile(path.join(data, 'documents', '2025', '10', 'paystub.pdf'), textPdf((await fixture('sap-paystub.layout.txt')).trim().split('\n')));
      const imp = 'imp_20251101_090000_0b01';
      await writeFile(
        path.join(data, 'imports', '2025', `${imp}.json`),
        JSON.stringify({ id: imp, status: 'committed', createdAt: stamp, updatedAt: stamp, committedAt: '2025-11-01T09:00:00+00:00', document: { id: 'doc_0000000000000b01', sha256: '0'.repeat(64), fileName: 'Paystub_202507.pdf', mediaType: 'application/pdf', size: 1, path: 'documents/2025/10/paystub.pdf' }, draft: { documentType: 'payslip', sections: [], figures: [], notes: [] } }),
      );
      const fig = (id: string, kind: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, kind, label: kind, amount, currency: 'GBP', taxYear: '2025/26', periodStart: '2025-10-01', periodEnd: '2025-10-31', date: '2025-10-31', payer: 'Quillon Systems Limited', employmentId: 'quillon', source: { importId: imp }, createdAt: stamp, ...extra });
      const figures = [
        fig('fig_00000000000000b1', 'gross_pay', 2480),
        fig('fig_00000000000000b2', 'tax_deducted', 406.4),
        // Misread: 118.23 for 118.32.
        fig('fig_00000000000000b3', 'national_insurance', 118.23),
        // One figure per pension line: they add up to it.
        fig('fig_00000000000000b4', 'pension_contribution_employee', 125),
        fig('fig_00000000000000b5', 'pension_contribution_employee', -10),
        // The student loan line was left out.
      ];
      await writeFile(path.join(data, 'figures.jsonl'), `${figures.map((f) => JSON.stringify(f)).join('\n')}\n`);
      expect(await runMigrations(data, () => undefined)).toMatchObject({ from: 5, to: 7 });

      const store = await Store.open(data);
      expect(store.issues).toEqual([]);
      expect(store.payslips).toMatchObject([{ employmentId: 'quillon', taxYear: '2025/26', payrollNumber: '88001234', totals: { net: 1795.28 }, source: { importId: imp, documentId: 'doc_0000000000000b01' } }]);
      const byId = (id: string) => store.figures.find((f) => f.id === id)!;
      expect(byId('fig_00000000000000b1')).toMatchObject({ amount: 2480, taxCode: '1257L' });
      expect(byId('fig_00000000000000b3')).toMatchObject({ amount: 118.32, notes: 'Read again on this machine (format v6): the first reading had 118.23.' });
      expect([byId('fig_00000000000000b4').amount, byId('fig_00000000000000b5').amount]).toEqual([125, -10]);
      expect(store.figures.filter((f) => f.kind === 'student_loan_deducted')).toMatchObject([{ amount: 45, payer: 'Quillon Systems Limited', employmentId: 'quillon', date: '2025-10-31' }]);
      store.stopWatching();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
