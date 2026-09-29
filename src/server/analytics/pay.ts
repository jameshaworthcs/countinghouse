// Pay, month by month: each payslip's figures (gross, tax, NI, pension, student loan), what reached
// your bank, and pay seen in the bank with no payslip (docs/FORMULAS.md §17).

import type { PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { addDays, maxDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Figure, Transaction } from '../../shared/schema';
import { taxYearOf, type TaxYear } from '../../shared/uk';
import type { Store } from '../store';
import { isPayslipFigure, payerKey } from './allowances';
import { covers, type Coverage } from './coverage';

/** How far either side of the pay date a payment into the bank is looked for, in days. */
export const PAY_MATCH_DAYS = 10;
/** A payment within this of the payslip's net is the net (pennies of rounding aside). */
export const PAY_TOLERANCE_POUNDS = 1;

const DEDUCTIONS = ['tax_deducted', 'national_insurance', 'pension_contribution_employee', 'student_loan_deducted'] as const;

/** Does a bank credit look like it came from this employer: a word of the name in its text? */
export function fromEmployer(t: Pick<Transaction, 'description' | 'payee' | 'counterpartyName'>, payer: string): boolean {
  const key = payerKey(payer);
  if (key.length < 4) return false;
  const text = payerKey(`${t.payee ?? ''} ${t.counterpartyName ?? ''} ${t.description}`);
  return text.includes(key.slice(0, Math.min(key.length, 10)));
}

const inYear = (d: string | undefined, ty: TaxYear) => Boolean(d && d >= ty.start && d <= ty.end);

export function pay(store: Store, coverage: Coverage, taxYear?: string, now: ISODate = today()): PayResponse {
  const ty = taxYear ? taxYearOf(`${taxYear.slice(0, 4)}-06-01`) : taxYearOf(now);
  const payslipFigures = store.figures.filter((f) => isPayslipFigure(store, f) && (f.taxYear === ty.label || (!f.taxYear && inYear(f.periodEnd ?? f.date, ty))));
  const p60Figures = store.figures.filter((f) => !isPayslipFigure(store, f) && f.taxYear === ty.label && (f.kind === 'gross_pay' || f.kind === 'tax_deducted'));
  // Pay received: salary credits in the year, plus the days either side of it for pay dates near its edges.
  const salary = store.transactions().filter((t) => t.category === 'salary' && t.amount > 0 && t.date >= addDays(ty.start, -PAY_MATCH_DAYS) && t.date <= addDays(ty.end, PAY_MATCH_DAYS));
  const used = new Set<string>();

  // Payslips: one pay period per employer and period.
  const byEmployer = new Map<string, { payer: string; periods: Map<string, Figure[]> }>();
  for (const f of payslipFigures) {
    const key = payerKey(f.payer);
    const e = byEmployer.get(key) ?? byEmployer.set(key, { payer: f.payer ?? '', periods: new Map() }).get(key)!;
    const period = `${f.periodStart ?? ''}|${f.periodEnd ?? f.date ?? ''}`;
    (e.periods.get(period) ?? e.periods.set(period, []).get(period)!).push(f);
  }

  const employers: PayEmployer[] = [];
  for (const [key, e] of byEmployer) {
    const months: PayMonth[] = [];
    const periods = [...e.periods.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, figures] of periods) {
      const first = figures[0]!;
      const sum = (kind: Figure['kind']) => {
        const of = figures.filter((f) => f.kind === kind);
        return of.length ? fromMinor(of.reduce((s, f) => s + toMinor(f.amount), 0)) : null;
      };
      const gross = sum('gross_pay');
      const [tax = null, ni = null, pension = null, studentLoan = null] = DEDUCTIONS.map((k) => sum(k));
      const listed = [tax, ni, pension, studentLoan].reduce<number>((s, v) => s + toMinor(v ?? 0), 0);
      const expectedNet = gross !== null ? fromMinor(toMinor(gross) - listed) : null;
      const periodEnd = first.periodEnd ?? first.date ?? null;
      const payDate = first.date ?? periodEnd;
      // The payment: from this employer, near the pay date or the period's end, nearest the net.
      const from = addDays(periodEnd ?? payDate!, -PAY_MATCH_DAYS);
      const to = addDays(maxDate(payDate, periodEnd) ?? payDate!, PAY_MATCH_DAYS);
      const candidates = salary.filter((t) => !used.has(t.id) && t.date >= from && t.date <= to && fromEmployer(t, e.payer));
      candidates.sort((a, b) => Math.abs(toMinor(a.amount) - toMinor(expectedNet ?? 0)) - Math.abs(toMinor(b.amount) - toMinor(expectedNet ?? 0)) || a.date.localeCompare(b.date));
      const credit = candidates[0];
      if (credit) used.add(credit.id);
      let status: PayMonth['status'];
      let note: string | undefined;
      if (credit) {
        const diff = expectedNet !== null ? toMinor(credit.amount) - toMinor(expectedNet) : 0;
        status = expectedNet === null || Math.abs(diff) <= PAY_TOLERANCE_POUNDS * 100 ? 'paid' : 'differs';
        if (status === 'differs') note = `${formatMoney(Math.abs(fromMinor(diff)))} ${diff < 0 ? 'less' : 'more'} than the payslip’s pay after the deductions read from it: other deductions or adjustments on the payslip`;
      } else if (payDate && payDate > now) {
        status = 'due';
        note = `Due about ${payDate}`;
      } else {
        status = 'not-seen';
        // Is there bank data for those days at all?
        const accounts = new Set(salary.filter((t) => fromEmployer(t, e.payer)).map((t) => t.accountId));
        const known = [...accounts].some((id) => {
          const c = coverage.byAccount.get(id);
          return c ? covers(c.intervals, from) && covers(c.intervals, to > now ? now : to) : false;
        });
        note = known ? `No payment from ${e.payer || 'this employer'} is in your bank data between ${from} and ${to > now ? now : to}` : `Your bank data does not cover ${from} to ${to > now ? now : to} yet`;
      }
      months.push({
        periodStart: first.periodStart ?? null,
        periodEnd,
        payDate,
        gross,
        tax,
        ni,
        pension,
        studentLoan,
        expectedNet,
        paidIn: credit ? { amount: credit.amount, date: credit.date, transactionId: credit.id, accountId: credit.accountId } : null,
        otherDeductions: credit && expectedNet !== null ? fromMinor(toMinor(expectedNet) - toMinor(credit.amount)) : null,
        status,
        ...(note ? { note } : {}),
        figureIds: figures.map((f) => f.id),
      });
    }
    employers.push({ key, payer: e.payer, months, p60: null, totals: { gross: null, tax: null, ni: null, pension: null, studentLoan: null, paidIn: 0 } });
  }

  // Pay into the bank with no payslip: grouped by the employer its text names (the cleaned payee).
  for (const t of salary) {
    if (used.has(t.id) || !inYear(t.date, ty)) continue;
    const name = t.payee ?? t.counterpartyName ?? t.description;
    const known = employers.find((e) => e.payer && fromEmployer(t, e.payer));
    const key = known?.key ?? payerKey(name);
    const e = known ?? employers.find((x) => x.key === key) ?? (employers.push({ key, payer: name, months: [], p60: null, totals: { gross: null, tax: null, ni: null, pension: null, studentLoan: null, paidIn: 0 } }), employers[employers.length - 1]!);
    e.months.push({ periodStart: null, periodEnd: null, payDate: t.date, gross: null, tax: null, ni: null, pension: null, studentLoan: null, expectedNet: null, paidIn: { amount: t.amount, date: t.date, transactionId: t.id, accountId: t.accountId }, otherDeductions: null, status: 'no-payslip', figureIds: [] });
  }

  for (const e of employers) {
    e.months.sort((a, b) => (a.payDate ?? a.periodEnd ?? '').localeCompare(b.payDate ?? b.periodEnd ?? ''));
    const total = (pick: (m: PayMonth) => number | null) => {
      const vals = e.months.map(pick).filter((v): v is number => v !== null);
      return vals.length ? fromMinor(vals.reduce((s, v) => s + toMinor(v), 0)) : null;
    };
    e.totals = { gross: total((m) => m.gross), tax: total((m) => m.tax), ni: total((m) => m.ni), pension: total((m) => m.pension), studentLoan: total((m) => m.studentLoan), paidIn: total((m) => m.paidIn?.amount ?? null) ?? 0 };
    const p60 = p60Figures.filter((f) => payerKey(f.payer) === e.key);
    const pick = (kind: Figure['kind']) => {
      const of = p60.filter((f) => f.kind === kind);
      return of.length ? fromMinor(of.reduce((s, f) => s + toMinor(f.amount), 0)) : null;
    };
    if (p60.length) e.p60 = { gross: pick('gross_pay'), tax: pick('tax_deducted') };
  }
  employers.sort((a, b) => (b.totals.gross ?? b.totals.paidIn) - (a.totals.gross ?? a.totals.paidIn));

  const notes: string[] = [];
  if (!payslipFigures.length) notes.push('No payslips for this tax year: import them to see gross pay, tax and NI month by month. Pay into your bank is shown on its own.');
  notes.push('Pay is matched to a payment into your bank from the same employer within 10 days of the pay date. Deductions not read from a payslip (a cycle scheme, say) show as the difference.');
  return { taxYear: { label: ty.label, start: ty.start, end: ty.end }, employers, notes };
}
