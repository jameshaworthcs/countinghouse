// Pay earned on timesheets (docs/FORMULAS.md §17, "Earned pay"): matched to the payslips that paid
// it, what is owed and when it should come, its estimated deductions, and that it is pending beside
// the estate, never income or part of it. All data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payByEmployer } from '../src/server/analytics/allowances';
import { Coverage } from '../src/server/analytics/coverage';
import { earnedPay, effectiveEarned, inferPayroll, owedPay } from '../src/server/analytics/earned';
import { pay } from '../src/server/analytics/pay';
import { figureId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, Figure, Transaction } from '../src/shared/schema';
import { taxYear } from '../src/shared/uk';

const stamp = '2026-08-01T00:00:00+00:00';
const PAYROLL = 'Fernbrook Payroll Ltd';
const SHEET = 'Kestrel Labs Ltd';
let dir: string;
let store: Store;
let n = 0;

const credit = (date: string, amount: number): Transaction => ({ id: transactionId('current', date, amount, 'BANK GIRO CREDIT REF FERNBROOK', n++), accountId: 'current', date, amount, currency: 'GBP', description: 'BANK GIRO CREDIT REF FERNBROOK', payee: 'Fernbrook', category: 'salary', source: {} });
const monthEnd = (m: string) => ({ '02': '28', '04': '30', '06': '30', '09': '30', '11': '30' })[m.slice(5)] ?? '31';
const payslip = (month: string, payDate: string, figures: Partial<Record<Figure['kind'], number>>, extra: Partial<Figure> = {}): Figure[] =>
  Object.entries(figures).map(([kind, amount]) => ({ id: figureId(kind, amount, month, PAYROLL, kind, String(n++)), kind: kind as Figure['kind'], label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: `${month}-01`, periodEnd: `${month}-${monthEnd(month)}`, date: payDate, payer: PAYROLL, source: {}, createdAt: stamp, ...extra }));
const earned = (month: string, amount: number, extra: Partial<Figure> = {}, createdAt = stamp): Figure => ({
  id: figureId('earned_pay', amount, `${month}-${monthEnd(month)}`, SHEET, `${month} total`, `${n++}`),
  kind: 'earned_pay',
  label: `${month}: Total Pay`,
  amount,
  currency: 'GBP',
  periodStart: `${month}-01`,
  periodEnd: `${month}-${monthEnd(month)}`,
  payer: SHEET,
  paidBy: PAYROLL,
  work: { role: 'Project 7', daysWorked: amount / 120, rate: 120, ratePer: 'day' },
  source: {},
  createdAt,
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-earned-'));
  store = await Store.open(path.join(dir, 'data'));
  const current: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  await store.setAccounts([current]);
  // June's work (£1,320) on the July payslip, in the bank on 24 July; July's timesheet went in late,
  // so the August payslip paid nothing. July (£640) and August (£1,480) are owed.
  await store.addTransactions([credit('2026-07-24', 1244.04)], 'test: pay');
  await store.addFigures(
    [
      ...payslip('2026-07', '2026-07-24', { gross_pay: 1320, tax_deducted: 54.2, national_insurance: 21.76 }),
      ...payslip('2026-08', '2026-08-25', { gross_pay: 0 }),
      earned('2026-06', 1320),
      earned('2026-07', 640),
      earned('2026-08', 1480),
    ],
    'test: figures',
  );
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('earned pay', () => {
  it('each month to the payslip whose gross it makes up, and what is owed, with when', () => {
    const [w] = earnedPay(store, '2026-09-10');
    expect(w).toMatchObject({ key: 'fernbrookpayroll', payroll: PAYROLL, timesheets: ['Kestrel Labs Ltd, Project 7'], lag: { months: 1, source: 'learned' } });
    expect(w!.periods.map((p) => [p.periodEnd, p.status, p.payslip?.periodEnd ?? null, p.paidIn?.amount ?? null])).toEqual([
      ['2026-06-30', 'paid', '2026-07-31', 1244.04],
      ['2026-07-31', 'owed', null, null],
      ['2026-08-31', 'owed', null, null],
    ]);
    expect(w!.periods[1]!.note).toBe('Not on the Aug 2026 payslip, which paid nothing');
    // Both owed months come with the September payslip, on the day of the month pay last arrived.
    expect(w!.expected).toHaveLength(1);
    expect(w!.expected[0]).toMatchObject({ month: '2026-09', payDate: '2026-09-24', gross: 2120, periods: ['2026-07-31', '2026-08-31'], status: 'owed' });
  });

  it('estimates the deductions on the basis the last payslip shows, and what paying two months at once adds', () => {
    const x = earnedPay(store, '2026-09-10')[0]!.expected[0]!;
    // The July payslip's £54.20 is 1257L on a month-1 basis (cumulative would have been nothing).
    expect(x.estimate).toMatchObject({ tax: 214.2, ni: 85.76, pension: null, net: 1820.04, basis: '1257L M1, which gives your last payslip’s tax' });
    expect(x.apart).toEqual({ tax: 86.2, ni: 34.56, extraTax: 128, extraNi: 51.2 });
  });

  it('a printed tax code wins over the one worked out', async () => {
    await store.addFigures(payslip('2026-05', '2026-05-22', { gross_pay: 500, tax_deducted: 100 }, { taxCode: 'BR' }), 'test: older');
    const slips = await store.addFigures(payslip('2026-09', '2026-09-24', { gross_pay: 300, tax_deducted: 60 }, { taxCode: 'BR' }), 'test: br');
    expect(slips).toBe(2);
    await store.addFigures([earned('2026-09', 900)], 'test: sept');
    const x = earnedPay(store, '2026-09-26')[0]!.expected.at(-1)!;
    expect(x.estimate.basis).toBe('BR, as your last payslip shows');
  });

  it('when the payslip comes, the run it adds up to is paid, and nothing is owed', async () => {
    await store.addFigures(payslip('2026-09', '2026-09-24', { gross_pay: 2120, tax_deducted: 214.2, national_insurance: 85.76 }), 'test: sept');
    await store.addTransactions([credit('2026-09-24', 1820.04)], 'test: pay');
    const [w] = earnedPay(store, '2026-09-30');
    expect(w!.periods.map((p) => [p.status, p.payslip?.periodEnd, p.payslip?.periods])).toEqual([
      ['paid', '2026-07-31', 1],
      ['paid', '2026-09-30', 2],
      ['paid', '2026-09-30', 2],
    ]);
    expect(w!.lag).toEqual({ months: 1, source: 'learned' });
    expect(w!.expected).toEqual([]);
    expect(owedPay([w!])).toBeNull();
  });

  it('pay that reaches the bank before its payslip is imported is no longer owed', async () => {
    await store.addTransactions([credit('2026-09-24', 1820.04)], 'test: pay');
    const [w] = earnedPay(store, '2026-09-30');
    expect(w!.expected[0]).toMatchObject({ status: 'arrived', arrived: { amount: 1820.04, date: '2026-09-24' } });
    expect(w!.periods.slice(1).map((p) => p.status)).toEqual(['arrived', 'arrived']);
    expect(owedPay([w!])).toBeNull();
    // The Pay tab lists the payment under the payroll, saying what it is for.
    const month = pay(store, new Coverage(store), '2026/27', '2026-09-30').employers.find((e) => e.key === 'fernbrookpayroll')!.months.find((m) => m.status === 'no-payslip')!;
    expect(month.note).toMatch(/Jul 2026 and Aug 2026 on your timesheet/);
  });

  it('owed past its pay day is late, and the estate shows it as pending', () => {
    const owed = owedPay(earnedPay(store, '2026-10-01'))!;
    expect(owed).toMatchObject({ gross: 2120, net: 1820.04, next: '2026-09-24', late: true });
    expect(owed.items).toEqual([{ payroll: PAYROLL, gross: 2120, net: 1820.04, payDate: '2026-09-24', periods: ['2026-07-31', '2026-08-31'], status: 'late', kind: 'timesheet' }]);
    expect(owedPay(earnedPay(store, '2026-09-10'))!.late).toBe(false);
  });

  it('how long after the work pay comes is yours to say', async () => {
    await store.setProfile({ ...store.profile, employers: [{ name: 'FERNBROOK PAYROLL LIMITED', payLagMonths: 2 }] });
    const [w] = earnedPay(store, '2026-09-10');
    expect(w!.lag).toEqual({ months: 2, source: 'yours' });
    // July's work with the next payslip (September); August's two months on (October).
    expect(w!.expected.map((x) => [x.month, x.gross])).toEqual([
      ['2026-09', 640],
      ['2026-10', 1480],
    ]);
  });

  it('a later upload of the timesheet replaces a period’s figure; an unmatched payslip pays nothing', async () => {
    await store.addFigures([earned('2026-08', 1560, {}, '2026-09-02T00:00:00+00:00')], 'test: corrected');
    expect(effectiveEarned(store.figures).map((f) => [f.periodEnd, f.amount])).toEqual([
      ['2026-06-30', 1320],
      ['2026-07-31', 640],
      ['2026-08-31', 1560],
    ]);
    // A payslip of £2,000 is no run of the owed months: they stay owed.
    await store.addFigures(payslip('2026-09', '2026-09-24', { gross_pay: 2000 }), 'test: odd');
    expect(earnedPay(store, '2026-09-25')[0]!.periods.filter((p) => p.status !== 'paid').map((p) => p.periodEnd)).toEqual(['2026-07-31', '2026-08-31']);
  });

  it('is never income: not pay for the tax year, and not an employer of its own on the Pay tab', () => {
    expect(payByEmployer(store, taxYear(2026)).map((e) => [e.payer, e.amount])).toEqual([[PAYROLL, 1320]]);
    const p = pay(store, new Coverage(store), '2026/27', '2026-09-10');
    expect(p.employers.map((e) => e.payer)).toEqual([PAYROLL]);
    expect(p.employers[0]!.earned!.periods).toHaveLength(3);
    expect(p.employers[0]!.totals.gross).toBe(1320);
  });

  it('a new timesheet is linked to the payroll an earlier upload was, else the one whose payslip it adds up to', async () => {
    const draft = [{ kind: 'earned_pay' as const, payer: SHEET, periodEnd: '2026-09-30', amount: 700, work: { role: 'Project 7' } }];
    expect(inferPayroll(store, draft).get(SHEET)).toBe(PAYROLL);
    // Without the earlier link: June's £1,320 is exactly the July payslip.
    const fresh = await Store.open(path.join(dir, 'fresh'));
    await fresh.addFigures([...payslip('2026-07', '2026-07-24', { gross_pay: 1320 })], 'test: slip');
    expect(inferPayroll(fresh, [{ kind: 'earned_pay', payer: SHEET, periodEnd: '2026-06-30', amount: 1320 }]).get(SHEET)).toBe(PAYROLL);
    expect(inferPayroll(fresh, [{ kind: 'earned_pay', payer: SHEET, periodEnd: '2026-06-30', amount: 1000 }]).has(SHEET)).toBe(false);
    fresh.stopWatching();
  });
});
