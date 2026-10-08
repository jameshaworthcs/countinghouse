// Pay month by month (docs/FORMULAS.md §17): payslips matched to what reached the bank. All data
// here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payByEmployer, unexplainedSalary } from '../src/server/analytics/allowances';
import { Coverage } from '../src/server/analytics/coverage';
import { fromEmployer, pay } from '../src/server/analytics/pay';
import { figureId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, Figure, Transaction } from '../src/shared/schema';
import { taxYearOf } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
let dir: string;
let store: Store;
let n = 0;
const credit = (date: string, amount: number, payee: string, description: string): Transaction => ({ id: transactionId('current', date, amount, description, n++), accountId: 'current', date, amount, currency: 'GBP', description, payee, category: 'salary', source: {} });
const payslip = (month: string, payDate: string, figures: Partial<Record<Figure['kind'], number>>, payer = 'Larchwood Data Ltd'): Figure[] =>
  Object.entries(figures).map(([kind, amount]) => ({ id: figureId(kind, amount, month, payer, kind, String(n++)), kind: kind as Figure['kind'], label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: `${month}-${month.endsWith('-02') ? '28' : month.endsWith('-09') || month.endsWith('-06') ? '30' : '31'}`, date: payDate, payer, source: {}, createdAt: stamp }));

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-pay-'));
  store = await Store.open(path.join(dir, 'data'));
  const current: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  await store.setAccounts([current]);
  await store.addTransactions(
    [
      credit('2026-06-25', 2000, 'Oakfield Engineering', 'BANK GIRO CREDIT REF OAKFIELD ENGINEERING'),
      credit('2026-07-28', 812.4, 'Larchwood Data', 'FASTER PAYMENTS RECEIPT REF.Larchwood July FROM LARCHWOOD DATA LTD'),
      credit('2026-06-28', 1600, 'Larchwood Data', 'FASTER PAYMENTS RECEIPT FROM LARCHWOOD DATA LTD'),
      { id: transactionId('current', '2026-09-20', -5, 'COFFEE', n++), accountId: 'current', date: '2026-09-20', amount: -5, currency: 'GBP', description: 'COFFEE', category: 'coffee', source: {} },
      { id: transactionId('current', '2026-06-01', -5, 'COFFEE', n++), accountId: 'current', date: '2026-06-01', amount: -5, currency: 'GBP', description: 'COFFEE', category: 'coffee', source: {} },
    ],
    'test: transactions',
  );
  await store.addFigures(
    [
      ...payslip('2026-06', '2026-06-28', { gross_pay: 2000, tax_deducted: 200, national_insurance: 100, pension_contribution_employee: 50 }),
      ...payslip('2026-07', '2026-08-05', { gross_pay: 812.4, tax_deducted: 0, national_insurance: 0 }),
      ...payslip('2026-08', '2026-09-05', { gross_pay: 1105.25, tax_deducted: 0, national_insurance: 0 }),
      ...payslip('2026-09', '2026-10-05', { gross_pay: 1105.25, tax_deducted: 0, national_insurance: 0 }),
    ],
    'test: payslips',
  );
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('pay month by month', () => {
  it('knows an employer’s payments by its name, however the bank writes it', () => {
    expect(fromEmployer({ description: 'FASTER PAYMENTS RECEIPT FROM LARCHWOOD DATA LTD', payee: undefined }, 'Larchwood Data Ltd')).toBe(true);
    expect(fromEmployer({ description: 'BANK GIRO CREDIT', payee: 'Larchwood Data' }, 'LARCHWOOD DATA LIMITED')).toBe(true);
    expect(fromEmployer({ description: 'BANK GIRO CREDIT REF OAKFIELD', payee: 'Oakfield' }, 'Larchwood Data Ltd')).toBe(false);
  });

  it('each payslip against what reached the bank: paid, differs, not seen, due', () => {
    const p = pay(store, new Coverage(store), '2026/27', '2026-09-29');
    const larch = p.employers.find((e) => e.payer === 'Larchwood Data Ltd')!;
    expect(larch.months.map((m) => [m.periodEnd, m.status, m.expectedNet, m.paidIn?.amount ?? null])).toEqual([
      ['2026-06-30', 'differs', 1650, 1600],
      ['2026-07-31', 'paid', 812.4, 812.4],
      ['2026-08-31', 'not-seen', 1105.25, null],
      ['2026-09-30', 'due', 1105.25, null],
    ]);
    // June: £1,650 after the deductions read from it, £1,600 arrived: £50 of others.
    expect(larch.months[0]).toMatchObject({ otherDeductions: 50, note: '£50.00 less than the payslip’s pay after the deductions read from it: other deductions or adjustments on the payslip' });
    expect(larch.months[2]!.note).toBe('No payment from Larchwood Data Ltd is in your bank data between 2026-08-21 and 2026-09-15');
    expect(larch.totals).toMatchObject({ gross: 5022.9, tax: 200, ni: 100, pension: 50, paidIn: 2412.4 });
  });

  it('pay with no payslip is shown under its employer', () => {
    const p = pay(store, new Coverage(store), '2026/27', '2026-09-29');
    const oak = p.employers.find((e) => e.payer === 'Oakfield Engineering')!;
    expect(oak.months.map((m) => [m.status, m.payDate, m.paidIn?.amount])).toEqual([['no-payslip', '2026-06-25', 2000]]);
  });
});

describe('an employer the bank calls something else', () => {
  // Quillon's payslips; Hartwell Group is how the bank shows its payroll. Pension is taken before tax.
  beforeEach(async () => {
    await store.addTransactions(
      [credit('2026-05-22', 1550, 'Hartwell Group', 'BANK GIRO CREDIT REF HARTWELL GROUP'), credit('2026-06-24', 1550, 'Hartwell Group', 'BANK GIRO CREDIT REF HARTWELL GROUP'), credit('2026-07-24', 402.17, 'Hartwell Group', 'BANK GIRO CREDIT REF HARTWELL GROUP')],
      'test: Hartwell pay',
    );
    await store.addFigures(
      [
        ...payslip('2026-05', '2026-05-31', { gross_pay: 2000, tax_deducted: 200, national_insurance: 100, pension_contribution_employee: 150 }, 'Quillon Systems Ltd'),
        ...payslip('2026-06', '2026-06-30', { gross_pay: 2000, tax_deducted: 200, national_insurance: 100, pension_contribution_employee: 150 }, 'Quillon Systems Ltd'),
        ...payslip('2026-09', '2026-09-30', { gross_pay: 0 }, 'Quillon Systems Ltd'),
      ],
      'test: Quillon payslips',
    );
  });
  const p60 = (kind: Figure['kind'], amount: number, n = ''): Figure => ({ id: figureId(kind, amount, '2026/27', 'Quillon Systems Limited', kind, `p60${n}`), kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: '2026-04-06', periodEnd: '2027-04-05', payer: 'Quillon Systems Limited', source: {}, createdAt: stamp });

  it('pays a payslip with a payment of exactly its pay, and keeps that payer’s other pay with the employer', () => {
    const q = pay(store, new Coverage(store), '2026/27', '2026-09-30').employers.find((e) => e.payer === 'Quillon Systems Ltd')!;
    expect(q.months.map((m) => [m.status, m.expectedNet, m.paidIn?.date ?? null])).toEqual([
      ['paid', 1550, '2026-05-22'],
      ['paid', 1550, '2026-06-24'],
      ['no-payslip', null, '2026-07-24'],
      ['nothing', 0, null],
    ]);
    expect(q.months[3]!.note).toBe('Nothing to pay into your bank: no pay this month');
    expect(pay(store, new Coverage(store), '2026/27', '2026-09-30').employers.some((e) => e.payer === 'Hartwell Group')).toBe(false);
  });

  it('the tax band counts that pay once: as the payslips, not again as salary received', () => {
    const ty = taxYearOf('2026-06-01');
    const unexplained = unexplainedSalary(store, ty, payByEmployer(store, ty)).map((t) => t.payee);
    expect(unexplained).toEqual(['Oakfield Engineering']);
  });

  it('a P60 is checked by its tax and NI; its pay is the payslips’ less pension taken before tax', async () => {
    await store.addFigures([p60('gross_pay', 3700), p60('tax_deducted', 400), p60('national_insurance', 200)], 'test: P60');
    const q = () => pay(store, new Coverage(store), '2026/27', '2026-09-30').employers.find((e) => e.payer === 'Quillon Systems Ltd')!;
    expect(q().document).toMatchObject({ title: 'Your figures for the year', final: true, gross: 3700, tax: 400, ni: 200, note: 'The payslips add up to it. Its pay is theirs less the £300.00 of pension taken before tax.' });
    await store.addFigures([p60('tax_deducted', 187.3, '-more')], 'test: more tax on the P60');
    expect(q().document!.note).toBe('The payslips’ tax comes to £187.30 less than its tax: some payslips are missing.');
  });
});
