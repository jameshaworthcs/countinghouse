// Jobs (employments.json) and HMRC's records (hmrc.jsonl): HMRC's gov.uk pages read on this machine,
// matched to jobs, and what the Pay tab makes of them. Every name, number and amount here is invented.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayResponse } from '../src/shared/api';
import { Coverage } from '../src/server/analytics/coverage';
import { owedPay, owedPayslips } from '../src/server/analytics/earned';
import { pay } from '../src/server/analytics/pay';
import { payByEmployer } from '../src/server/analytics/sources';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { matchEmployment } from '../src/server/employments';
import { figureId, hmrcId, transactionId } from '../src/server/ids';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';
import type { Account, ContextRecord, Employment, Figure, HmrcRecord, ImportRecord, Transaction } from '../src/shared/schema';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { Categoriser } from '../src/shared/categorise';
import { taxYear, taxYearOf } from '../src/shared/uk';
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
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures', 'govuk', name), 'utf8');
const stamp = '2026-01-01T00:00:00+00:00';
const CSRF = { 'x-finance-csrf': '1' };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('HMRC’s pages, uploaded', () => {
  let app: App;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-jobs-api-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    // Never Claude in a test: a page no local reader knows goes to offline OCR instead.
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
    return waitFor(async () => {
      const r = (await (await req(`/api/imports/${results[0]!.id}`)).json()) as ImportRecord;
      return r.status === 'review' || r.status === 'failed' ? r : undefined;
    });
  };

  withPdf('reads the page on this machine, sets up its job, and keeps each payment once', async () => {
    const page = (await fixture('taxable-income-employer.raw.txt')).split('\n');
    const rec = await upload('larchwood.pdf', page);
    expect(rec.extraction).toMatchObject({ engine: 'govuk', engineVersion: 'govuk-1' });
    expect(rec.draft!.jobs).toEqual([{ key: 'j0', employer: 'LARCHWOOD DATA LIMITED', target: { mode: 'new', employment: { id: 'larchwood-data', employer: 'LARCHWOOD DATA LIMITED' } } }]);
    expect(rec.draft!.hmrc!.map((h) => [h.record.type, h.include, h.jobKey])).toEqual([...Array.from({ length: 5 }, () => ['payment', true, 'j0']), ['employment', true, 'j0']]);
    expect((await req(`/api/imports/${rec.id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
    const { store } = app.ctx;
    expect(store.employments.map((e) => [e.id, e.employer, e.createdBy])).toEqual([['larchwood-data', 'LARCHWOOD DATA LIMITED', 'import']]);
    expect(store.hmrc).toHaveLength(6);
    expect(store.hmrc.every((r) => r.employmentId === 'larchwood-data' && r.source.importId === rec.id)).toBe(true);

    // A later printout, one more pay date on it: the five already stored are not stored again.
    const later = page.map((l) => l.replace('paid to 28 August 2026', 'paid to 28 September 2026').replace(/^Total .*/, '28 September 2026 0.00 0.00 0.00\nTotal 8,700.50 722.00 360.48')).join('\n').split('\n');
    const again = await upload('larchwood-sept.pdf', later);
    expect(again.draft!.jobs![0]).toMatchObject({ matchedBy: 'name', target: { mode: 'existing', employmentId: 'larchwood-data' } });
    expect(again.draft!.hmrc!.filter((h) => h.record.type === 'payment').map((h) => h.include)).toEqual([false, false, false, false, false, true]);

    // Pay already recorded, uncategorised, its bank reference carrying the payroll number (and rows
    // that are not pay, or were categorised already).
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const row = (date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId('current', date, amount, description, 0), accountId: 'current', date, amount, currency: 'GBP', description, source: {}, ...extra });
    const rows = [
      row('2026-05-28', 1800, 'BANK GIRO CREDIT REF PAYROLL CO, 0420 10203040 K'),
      row('2026-06-28', 1800, 'BANK GIRO CREDIT REF PAYROLL CO, 0420 10203040 K', { category: 'other-income', categorisedBy: 'user' }),
      row('2026-06-29', -50, 'PAYROLL CO 10203040 OVERPAYMENT'),
      row('2026-06-30', 20, 'REF 9910203040'),
    ];
    await store.addTransactions(rows, 'test: pay recorded');

    // The job's own page: the job learns its PAYE reference and your payroll number there.
    const details = (await fixture('employment-details.raw.txt')).replaceAll('OAKFIELD', 'LARCHWOOD DATA').replaceAll('ENGINEERING LIMITED', 'LIMITED').replace('Employment details for LARCHWOOD DATA\nLIMITED', 'Employment details for LARCHWOOD DATA LIMITED');
    const job = await upload('larchwood-details.pdf', details.split('\n'));
    expect(job.draft!.jobs![0]).toMatchObject({ payeReference: '123/AB45678', payrollNumber: '10203040', target: { mode: 'existing', employmentId: 'larchwood-data' } });
    expect((await req(`/api/imports/${job.id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
    expect(store.employment('larchwood-data')).toMatchObject({ payeReference: '123/AB45678', payrollNumbers: ['10203040'] });
    // The uncategorised pay with that number is salary now; your category, money out, and a longer
    // number that only contains it stay as they were.
    expect(rows.map((r) => [store.transactions().find((t) => t.id === r.id)!.category ?? null, store.transactions().find((t) => t.id === r.id)!.categorisedBy ?? null])).toEqual([
      ['salary', 'builtin'],
      ['other-income', 'user'],
      [null, null],
      [null, null],
    ]);
  });

  describe('documents about one new employer, waiting together', () => {
    const pages = async () => {
      const income = (await fixture('taxable-income-employer.raw.txt')).split('\n');
      const details = (await fixture('employment-details.raw.txt')).replaceAll('OAKFIELD', 'LARCHWOOD DATA').replaceAll('ENGINEERING LIMITED', 'LIMITED').replace('Employment details for LARCHWOOD DATA\nLIMITED', 'Employment details for LARCHWOOD DATA LIMITED');
      const a = await upload('larchwood.pdf', income);
      const b = await upload('larchwood-details.pdf', details.split('\n'));
      // Both were drafted before either was committed: each proposes the same new job.
      for (const r of [a, b]) expect(r.draft!.jobs![0]!.target).toMatchObject({ mode: 'new', employment: { id: 'larchwood-data' } });
      return { a, b };
    };
    const commit = async (id: string) => expect((await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);

    withPdf('the one still waiting is matched again to the job the first set up', async () => {
      const { a, b } = await pages();
      await commit(a.id);
      const again = (await (await req(`/api/imports/${b.id}`)).json()) as ImportRecord;
      expect(again.draft!.jobs![0]).toMatchObject({ matchedBy: 'name', target: { mode: 'existing', employmentId: 'larchwood-data' } });
      await commit(b.id);
      expect(app.ctx.store.employments.map((e) => [e.id, e.payeReference ?? null])).toEqual([['larchwood-data', '123/AB45678']]);
    });

    withPdf('one you saved changes to, so not drafted again, still joins that job when committed', async () => {
      const { a, b } = await pages();
      expect((await req(`/api/imports/${b.id}/draft`, { method: 'PUT', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify(b.draft) })).status).toBe(200);
      await commit(a.id);
      expect(((await (await req(`/api/imports/${b.id}`)).json()) as ImportRecord).draft!.jobs![0]!.target).toMatchObject({ mode: 'new' });
      await commit(b.id);
      expect(app.ctx.store.employments.map((e) => [e.id, e.payeReference ?? null, e.payrollNumbers])).toEqual([['larchwood-data', '123/AB45678', ['10203040']]]);
      expect(app.ctx.store.hmrc.every((r) => r.employmentId === 'larchwood-data')).toBe(true);
    });
  });

  withPdf('a job’s PAYE reference is what matches it, before any name', async () => {
    const { store } = app.ctx;
    await store.setEmployments([job('oakfield', 'Oakfield Group', { payeReference: '123/AB45678' }), job('oakfield-2', 'OAKFIELD ENGINEERING LIMITED')]);
    const rec = await upload('oakfield-details.pdf', (await fixture('employment-details.raw.txt')).split('\n'));
    expect(rec.draft!.jobs![0]).toMatchObject({ matchedBy: 'payeReference', target: { mode: 'existing', employmentId: 'oakfield' } });
  });

  withPdf('the owner says a payslip’s pay is owed, and takes it back', async () => {
    const { store } = app.ctx;
    await store.setEmployments([job('quillon', 'Quillon Systems Ltd')]);
    expect((await req('/api/employments/quillon/owed', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ periodEnd: '2026-08-31', note: 'they missed it' }) })).status).toBe(200);
    expect(store.employment('quillon')!.owed).toMatchObject([{ periodEnd: '2026-08-31', note: 'they missed it' }]);
    expect((await req('/api/employments/quillon/owed/2026-08-31', { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect(store.employment('quillon')!.owed).toEqual([]);
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const pay = { id: transactionId('current', '2026-07-28', 862.4, 'BANK GIRO CREDIT REF PAYROLL CO, 0420 88001234 K', 0), accountId: 'current', date: '2026-07-28', amount: 862.4, currency: 'GBP', description: 'BANK GIRO CREDIT REF PAYROLL CO, 0420 88001234 K', source: {} };
    await store.addTransactions([pay], 'test: pay recorded');
    const put = await req('/api/employments/quillon', { method: 'PUT', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ payeReference: '120 qs123', payLagMonths: 1, payrollNumbers: ['88001234'] }) });
    expect(put.status).toBe(200);
    expect(store.employment('quillon')).toMatchObject({ payeReference: '120/QS123', payLagMonths: 1, payrollNumbers: ['88001234'] });
    // The payroll number you gave the job makes the pay recorded with it salary.
    expect(store.transactions().find((t) => t.id === pay.id)).toMatchObject({ category: 'salary', categorisedBy: 'builtin' });
  });
});

const job = (id: string, employer: string, extra: Partial<Employment> = {}): Employment => ({ id, employer, aliases: [], payrollNumbers: [], owed: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });

describe('jobs, HMRC’s records and the Pay tab', () => {
  let dir: string;
  let store: Store;
  let n = 0;
  const current: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  const credit = (date: string, amount: number, description: string): Transaction => ({ id: transactionId('current', date, amount, description, n++), accountId: 'current', date, amount, currency: 'GBP', description, category: 'salary', source: {} });
  const payslip = (month: string, payDate: string, gross: number, tax: number): Figure[] =>
    (
      [
        ['gross_pay', gross],
        ['tax_deducted', tax],
        ['national_insurance', 0],
      ] as const
    ).map(([kind, amount]) => ({ id: figureId(kind, amount, month, 'Quillon', kind, String(n++)), kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: `${month}-${month.endsWith('-09') ? '30' : '31'}`, date: payDate, payer: 'QUILLON SYSTEMS LTD', employmentId: 'quillon', source: {}, createdAt: stamp }));
  const record = (r: Record<string, unknown>): HmrcRecord => ({ ...(r as unknown as HmrcRecord), id: hmrcId(r as { type: string }), employmentId: 'quillon', source: {}, createdAt: stamp });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-jobs-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([current]);
    await store.setEmployments([job('quillon', 'Quillon Systems Ltd', { aliases: ['QUILLON SYSTEMS LTD'], payrollNumbers: ['88001234'] })]);
    await store.addFigures([...payslip('2026-07', '2026-08-05', 862.4, 0), ...payslip('2026-08', '2026-09-05', 1062.5, 0), ...payslip('2026-09', '2026-10-05', 1062.5, 0)], 'test: payslips');
    // The July pay came early, August's never came, September's came early.
    await store.addTransactions([credit('2026-07-28', 862.4, 'FASTER PAYMENTS RECEIPT REF.Quillon July FROM QUILLON SYSTEMS LTD'), credit('2026-09-22', 1062.5, 'BANK GIRO CREDIT REF PAYROLL CO, 0420 88001234 K')], 'test: pay');
    await store.upsertRecords(
      'hmrc',
      [
        record({ type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-08-05', taxablePay: 862.4, tax: 0, ni: 0, taxYear: '2026/27' }),
        record({ type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-09-05', taxablePay: 1062.5, tax: 0, ni: 0, taxYear: '2026/27' }),
        record({ type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-10-05', taxablePay: 1062.5, tax: 0, ni: 0, taxYear: '2026/27' }),
        record({ type: 'tax-code', employer: 'QUILLON SYSTEMS LTD', date: '2026-07-30', code: '1100L', cumulative: false, taxYear: '2026/27' }),
        record({ type: 'tax-code', employer: 'QUILLON SYSTEMS LTD', date: '2026-09-30', code: '312T', cumulative: false, taxYear: '2026/27' }),
      ],
      'test: HMRC',
    );
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });
  const quillon = (p: PayResponse) => p.employers.find((e) => e.employmentId === 'quillon')!;

  it('sets HMRC’s record beside each month, and the tax HMRC’s code would take beside what was taken', () => {
    const e = quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01'));
    expect(e.codes).toEqual([
      { date: '2026-07-30', code: '1100L', cumulative: false },
      { date: '2026-09-30', code: '312T', cumulative: false },
    ]);
    expect(e.months.map((m) => [m.periodEnd, m.hmrc?.taxablePay ?? null, m.check?.tax ?? null])).toEqual([
      ['2026-07-31', 862.4, null],
      // On 1100L month 1 (issued 30 July), £1,062.50 pays £29.00 of tax; none was taken.
      ['2026-08-31', 1062.5, 29],
      // 312T was issued five days before the pay date: too late for that payroll, so 1100L still applies.
      ['2026-09-30', 1062.5, 29],
    ]);
    expect(e.months[1]!.check!.note).toBe('On HMRC’s code 1100L week 1/month 1 (issued 30 Jul 2026) this pay would have £29.00 of tax; £0.00 was taken');
    // The September pay came by the payroll number in the bank's reference, not the name.
    expect(e.months[2]).toMatchObject({ status: 'paid', paidIn: { amount: 1062.5, date: '2026-09-22' } });
  });

  it('pay you say is owed: shown as owed, beside the estate, and paired when it comes', async () => {
    let e = quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01'));
    expect(e.months[1]).toMatchObject({ status: 'not-seen' });
    await store.upsertEmployment({ ...store.employment('quillon')!, owed: [{ periodEnd: '2026-08-31', markedAt: stamp }] });
    e = quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01'));
    expect(e.months[1]).toMatchObject({ status: 'owed', note: 'Owed to you: you said it will be paid' });
    expect(owedPay([], owedPayslips(store, '2026-10-01'))).toMatchObject({ gross: 1062.5, net: 1062.5, next: null, items: [{ payroll: 'Quillon Systems Ltd', kind: 'payslip', periods: ['2026-08-31'] }] });
    // It arrives in October: the August payslip is paid, late.
    await store.addTransactions([credit('2026-10-20', 1062.5, 'FASTER PAYMENTS RECEIPT REF.Quillon August FROM QUILLON SYSTEMS LTD')], 'test: late pay');
    e = quillon(pay(store, new Coverage(store), '2026/27', '2026-10-21'));
    expect(e.months[1]).toMatchObject({ status: 'paid', paidIn: { date: '2026-10-20' }, note: 'Arrived late, on 20 Oct 2026: you had said it was owed' });
    expect(owedPay([], owedPayslips(store, '2026-10-21'))).toBeNull();
  });

  it('pay you told the app had not arrived is owed, by that record, while it is active', async () => {
    const told: ContextRecord = {
      id: 'ctx_00000000000000a1',
      kind: 'income',
      statement: 'Your August 2026 pay from Quillon (£1,062.50) had not arrived by 26 September 2026.',
      detail: { event: 'pay_not_received', amount: 1062.5, date: '2026-09-26', from: '2026-08-01', to: '2026-08-31', attributes: { employer: 'Quillon Systems Ltd' } },
      status: 'active',
      origin: { kind: 'document', document: 'email.pdf' },
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.upsertRecords('context', [told, { ...told, id: 'ctx_00000000000000a2', detail: { ...told.detail, attributes: { employer: 'Alder Ltd' } } }], 'test: context');
    expect(quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01')).months[1]).toMatchObject({ status: 'owed', owed: { contextId: told.id }, note: 'Owed to you: you told the app it had not arrived' });
    expect(owedPay([], owedPayslips(store, '2026-10-01'))).toMatchObject({ net: 1062.5, items: [{ kind: 'payslip', periods: ['2026-08-31'] }] });
    await store.upsertRecords('context', [{ ...told, status: 'retired' }], 'test: context retired');
    expect(quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01')).months[1]).toMatchObject({ status: 'not-seen' });
  });

  it('a pay date HMRC has with no pay and no tax is nothing to pay in, not a missing payslip', async () => {
    await store.upsertRecords('hmrc', [record({ type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-06-05', taxablePay: 0, tax: 0, ni: 0, taxYear: '2026/27' })], 'test: nil pay date');
    const e = quillon(pay(store, new Coverage(store), '2026/27', '2026-10-01'));
    expect(e.months[0]).toMatchObject({ periodEnd: null, payDate: '2026-06-05', status: 'nothing', note: 'Nothing paid: HMRC’s record of this pay date has no pay and no tax' });
  });

  describe('payslips paired with their pay', () => {
    // A payslip imported: its figures, from an import of a payslip (one that prints no period is
    // still a payslip by its document).
    const slip = async (figures: [Figure['kind'], number][], when: { date: string; periodStart?: string; periodEnd?: string }): Promise<Figure[]> => {
      const importId = `imp_20261001_000000_${(n++).toString(16).padStart(4, '0')}`;
      await store.saveImport(
        {
          id: importId,
          status: 'committed',
          createdAt: stamp,
          updatedAt: stamp,
          origin: 'upload',
          document: { id: `doc_${importId.slice(-4).padStart(16, '0')}`, sha256: '0'.repeat(64), fileName: 'payslip.pdf', mediaType: 'application/pdf', size: 1 },
          extraction: { warnings: [] },
          draft: { documentType: 'payslip', sections: [], figures: [], notes: [] },
          result: { accountIds: [], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: figures.length },
        },
        'test: payslip import',
      );
      return figures.map(([kind, amount]) => ({ id: figureId(kind, amount, when.periodEnd ?? when.date, 'Larch', kind, importId), kind, label: kind, amount, currency: 'GBP', taxYear: taxYearOf(when.date).label, ...when, payer: 'LARCH TIMBER LTD', employmentId: 'larch', source: { importId }, createdAt: stamp }));
    };
    const larch = () => pay(store, new Coverage(store), '2026/27', '2026-10-01').employers.find((e) => e.employmentId === 'larch')!;
    beforeEach(async () => {
      await store.setEmployments([...store.employments, job('larch', 'Larch Timber Ltd')]);
    });

    it('one that prints no period is looked for at the pay date HMRC was told', async () => {
      await store.addFigures(
        [
          ...(await slip([['gross_pay', 2000], ['tax_deducted', 200]], { date: '2026-06-30', periodStart: '2026-06-01', periodEnd: '2026-06-30' })),
          // The last, dated the day the job ended, prints no period; it repays tax.
          ...(await slip([['gross_pay', 300], ['tax_deducted', -150]], { date: '2026-07-03' })),
        ],
        'test: Larch payslips',
      );
      await store.addTransactions([credit('2026-06-26', 1800, 'LARCH TIMBER LTD SALARY'), credit('2026-07-24', 450, 'LARCH TIMBER LTD SALARY')], 'test: Larch pay');
      const theirs = (r: Record<string, unknown>) => ({ ...record(r), employmentId: 'larch' });
      await store.upsertRecords(
        'hmrc',
        [theirs({ type: 'payment', employer: 'LARCH TIMBER LTD', payDate: '2026-06-27', taxablePay: 2000, tax: 200, taxYear: '2026/27' }), theirs({ type: 'payment', employer: 'LARCH TIMBER LTD', payDate: '2026-07-27', taxablePay: 300, tax: -150, taxYear: '2026/27' })],
        'test: Larch HMRC',
      );
      // Without HMRC's pay date, the last payslip would be looked for around 3 July and take June's pay.
      expect(larch().months.map((m) => [m.periodEnd, m.payDate, m.status, m.paidIn?.date ?? null, m.hmrc?.payDate ?? null])).toEqual([
        ['2026-06-30', '2026-06-30', 'paid', '2026-06-26', '2026-06-27'],
        ['2026-07-03', '2026-07-27', 'paid', '2026-07-24', '2026-07-27'],
      ]);
    });

    it('pay brought forward before Christmas is found earlier in its pay period', async () => {
      await store.addFigures(
        [
          ...(await slip([['gross_pay', 2000], ['tax_deducted', 200]], { date: '2025-11-30', periodStart: '2025-11-01', periodEnd: '2025-11-30' })),
          ...(await slip([['gross_pay', 2000], ['tax_deducted', 200]], { date: '2025-12-31', periodStart: '2025-12-01', periodEnd: '2025-12-31' })),
        ],
        'test: Larch payslips',
      );
      // December's pay came on the 19th, twelve days before the period's end; November's on the 25th.
      await store.addTransactions([credit('2025-11-25', 1800, 'BANK GIRO CREDIT REF LARCH TIMBER LTD'), credit('2025-12-19', 1800, 'BANK GIRO CREDIT REF LARCH TIMBER LTD')], 'test: Larch pay');
      const e = pay(store, new Coverage(store), '2025/26', '2026-10-01').employers.find((x) => x.employmentId === 'larch')!;
      expect(e.months.map((m) => [m.periodEnd, m.status, m.paidIn?.date ?? null])).toEqual([
        ['2025-11-30', 'paid', '2025-11-25'],
        ['2025-12-31', 'paid', '2025-12-19'],
      ]);
    });

    it('no payslip takes another’s own payment', async () => {
      await store.addFigures([...(await slip([['gross_pay', 500]], { date: '2026-06-30', periodStart: '2026-06-01', periodEnd: '2026-06-30' })), ...(await slip([['gross_pay', 450]], { date: '2026-07-03' }))], 'test: Larch payslips');
      await store.addTransactions([credit('2026-07-02', 450, 'LARCH TIMBER LTD SALARY')], 'test: Larch pay');
      // The £450 is in June's days too, and the nearest to June's £500, but it is the last payslip's to the penny.
      expect(larch().months.map((m) => [m.periodEnd, m.status, m.paidIn?.amount ?? null])).toEqual([
        ['2026-06-30', 'not-seen', null],
        ['2026-07-03', 'paid', 450],
      ]);
    });
  });

  it('HMRC’s record of a job’s payments is a source of its own; a job that has ended makes it final', async () => {
    const [q] = payByEmployer(store, taxYear(2026));
    // The payslips (to 5 Oct) and HMRC's record (to 5 Oct) agree; on the same date the record counts.
    expect(q).toMatchObject({ employmentId: 'quillon', amount: 2987.4, final: false, source: { label: 'HMRC to 5 Oct 2026' } });
    await store.upsertRecords('hmrc', [record({ type: 'event', employer: 'QUILLON SYSTEMS LTD', date: '2026-10-01', event: 'ended', text: 'Employment ended at QUILLON SYSTEMS LTD' })], 'test: ended');
    expect(payByEmployer(store, taxYear(2026))[0]).toMatchObject({ final: true });
  });

  it('matches a document’s employer to a job by reference, payroll number, then a name only one job has', () => {
    const jobs = [job('a', 'Alder Ltd', { payeReference: '111/A1' }), job('b', 'Birch Ltd', { payrollNumbers: ['777001'] }), job('c', 'Cedar Ltd'), job('c2', 'Cedar Limited')];
    expect(matchEmployment(jobs, { employer: 'Someone Else', payeReference: '111 a1' })).toMatchObject({ employment: { id: 'a' }, by: 'payeReference' });
    expect(matchEmployment(jobs, { employer: 'Someone Else', payrollNumber: '777001' })).toMatchObject({ employment: { id: 'b' }, by: 'payrollNumber' });
    expect(matchEmployment(jobs, { employer: 'BIRCH LIMITED' })).toMatchObject({ employment: { id: 'b' }, by: 'name' });
    // Two jobs have the name: not enough to say which.
    expect(matchEmployment(jobs, { employer: 'CEDAR LTD' })).toBeUndefined();
  });
});

describe('pay that carries your payroll number', () => {
  it('is salary when money comes in with it; a name alone, money out or a longer number is not', () => {
    const current: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
    const c = new Categoriser([], new CategoryIndex(defaultCategories()), [current], [], { payrollNumbers: ['47120356', '5512'] });
    const of = (description: string, amount: number) => c.categorise({ accountId: 'current', description, amount });
    expect(of('BANK GIRO CREDIT REF FENNICK THERMAL, 0420 47120356 K', 1671.2)).toMatchObject({ category: 'salary', categorisedBy: 'builtin' });
    expect(of('BANK GIRO CREDIT REF FENNICK THERMAL, 0420 47120356 K', -10).category).not.toBe('salary');
    expect(of('REF 1471203560', 20).category).not.toBe('salary');
    // Too short to tell from chance.
    expect(of('FASTER PAYMENT 5512', 100).category).not.toBe('salary');
    expect(new Categoriser([], new CategoryIndex(defaultCategories()), [current], []).categorise({ accountId: 'current', description: 'BANK GIRO CREDIT REF FENNICK THERMAL, 0420 47120356 K', amount: 1671.2 }).category).not.toBe('salary');
  });
});

describe('format v5 migration', () => {
  withPdf('sets up jobs from the pay figures, and reads HMRC pages already imported again', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-v5-'));
    try {
      const data = path.join(dir, 'data');
      await mkdir(path.join(data, 'imports', '2026'), { recursive: true });
      await mkdir(path.join(data, 'documents', '2026', '09'), { recursive: true });
      await writeFile(path.join(data, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 4, baseCurrency: 'GBP', createdAt: stamp }));
      await writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'A N Other', employers: [{ name: 'Fernbrook Payroll Ltd', payLagMonths: 1 }] }));
      await writeFile(path.join(data, 'documents', '2026', '09', 'ni.pdf'), textPdf((await fixture('ni-record.raw.txt')).split('\n')));
      await writeFile(path.join(data, 'documents', '2026', '09', 'sp.pdf'), textPdf((await fixture('state-pension.raw.txt')).split('\n')));
      const imports = [
        { id: 'imp_20260930_120000_0a01', status: 'committed', committedAt: '2026-09-30T12:00:00+01:00', document: { id: 'doc_0000000000000a01', mediaType: 'application/pdf', path: 'documents/2026/09/ni.pdf' }, draft: { documentType: 'tax_document' } },
        { id: 'imp_20260930_120000_0a04', status: 'committed', committedAt: '2026-09-30T12:00:00+01:00', document: { id: 'doc_0000000000000a04', mediaType: 'application/pdf', path: 'documents/2026/09/sp.pdf' }, draft: { documentType: 'pension_statement' } },
        { id: 'imp_20260930_120000_0a02', status: 'committed', document: { id: 'doc_0000000000000a02', mediaType: 'application/pdf' }, draft: { documentType: 'p60' } },
        { id: 'imp_20260930_120000_0a03', status: 'committed', document: { id: 'doc_0000000000000a03', mediaType: 'application/pdf' }, draft: { documentType: 'payslip' } },
      ];
      for (const r of imports) {
        const full = { createdAt: stamp, updatedAt: stamp, ...r, draft: { sections: [], figures: [], notes: [], ...r.draft }, document: { sha256: r.document.id.slice(4).padEnd(64, '0'), fileName: `${r.id}.pdf`, size: 1, ...r.document } };
        await writeFile(path.join(data, 'imports', '2026', `${r.id}.json`), JSON.stringify(full));
      }
      const fig = (id: string, kind: string, amount: number, payer: string | undefined, importId: string, extra: Record<string, unknown> = {}) => ({ id, kind, label: kind, amount, currency: 'GBP', taxYear: '2025/26', ...(payer ? { payer } : {}), source: { importId }, createdAt: stamp, ...extra });
      const figures = [
        fig('fig_00000000000000a1', 'national_insurance', 1234.56, undefined, 'imp_20260930_120000_0a01'),
        fig('fig_00000000000000a2', 'gross_pay', 20000, 'Oakfield Engineering Ltd', 'imp_20260930_120000_0a02', { payerReference: '123 AB45678' }),
        fig('fig_00000000000000a3', 'gross_pay', 1500, 'OAKFIELD ENGINEERING LIMITED', 'imp_20260930_120000_0a03', { periodStart: '2026-03-01', periodEnd: '2026-03-31' }),
        fig('fig_00000000000000a4', 'pension_contribution_employee', 75, 'OAKFIELD ENGINEERING LIMITED', 'imp_20260930_120000_0a03', { periodStart: '2026-03-01', periodEnd: '2026-03-31' }),
        { id: 'fig_00000000000000a5', kind: 'earned_pay', label: 'July: Total Pay', amount: 900, currency: 'GBP', periodStart: '2026-07-01', periodEnd: '2026-07-31', payer: 'Larchwood Data Ltd', paidBy: 'Fernbrook Payroll Ltd', source: {}, createdAt: stamp },
        fig('fig_00000000000000a6', 'dividends_paid', 500, 'Brambleworth Ltd', 'imp_20260930_120000_0a02'),
        // The State Pension forecast's earlier reading: a figure on the State Pension account.
        { id: 'fig_00000000000000a7', kind: 'pension_income_forecast', label: 'Forecast', amount: 11500.5, currency: 'GBP', date: '2026-09-30', accountId: 'state', source: { importId: 'imp_20260930_120000_0a04' }, createdAt: stamp },
      ];
      await writeFile(path.join(data, 'figures.jsonl'), `${figures.map((f) => JSON.stringify(f)).join('\n')}\n`);
      expect(await runMigrations(data, () => undefined)).toMatchObject({ from: 4, to: 5 });

      const store = await Store.open(data);
      expect(store.issues.map((i) => `${i.file}: ${i.message}`)).toEqual([]);
      expect(store.employments.map((e) => [e.id, e.employer, e.payeReference ?? null, e.payLagMonths ?? null, e.createdBy])).toEqual([
        ['oakfield-engineering', 'Oakfield Engineering Ltd', '123/AB45678', null, 'migration'],
        ['fernbrook-payroll', 'Fernbrook Payroll Ltd', null, 1, 'migration'],
      ]);
      const byId = (id: string) => store.figures.find((f) => f.id === id);
      expect([byId('fig_00000000000000a2')?.employmentId, byId('fig_00000000000000a3')?.employmentId, byId('fig_00000000000000a4')?.employmentId, byId('fig_00000000000000a5')?.employmentId, byId('fig_00000000000000a6')?.employmentId]).toEqual(['oakfield-engineering', 'oakfield-engineering', 'oakfield-engineering', 'fernbrook-payroll', undefined]);
      // The National Insurance record, read again: its years are HMRC records, and the amount its old reading made a figure of is gone.
      expect(byId('fig_00000000000000a1')).toBeUndefined();
      expect(store.hmrc.filter((r) => r.type === 'ni-year').map((r) => r.taxYear)).toEqual(['2026/27', '2025/26', '2024/25', '2023/24']);
      // The forecast, read again, is HMRC's record on the account its figure was on; the figure is gone.
      expect(byId('fig_00000000000000a7')).toBeUndefined();
      expect(store.hmrc.filter((r) => r.type === 'state-pension-forecast')).toMatchObject([{ accountId: 'state', source: { importId: 'imp_20260930_120000_0a04' } }]);
      expect(store.profile).not.toHaveProperty('employers');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
