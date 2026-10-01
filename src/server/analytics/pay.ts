// Pay, month by month: each payslip's figures (gross, tax, NI, pension, student loan), what reached
// your bank, and pay seen in the bank with no payslip (docs/FORMULAS.md §17).

import type { EarnedPayroll, PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { addDays, diffDays, formatDate, formatMonth, maxDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Figure, Transaction } from '../../shared/schema';
import { taxYearOf, type TaxYear } from '../../shared/uk';
import { earnedPay } from './earned';
import type { Store } from '../store';
import { covers, type Coverage } from './coverage';
import { employerYears, isPayslipFigure, payerKey, type PayKind, type PaySource } from './sources';

export { isPayslipFigure, payerKey };

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

/** Who the bank says a payment is from, reduced for comparing. */
const paidBy = (t: Transaction) => payerKey(t.payee ?? t.counterpartyName ?? t.description);

const inYear = (d: string | undefined, ty: TaxYear) => Boolean(d && d >= ty.start && d <= ty.end);

/** One employer's payslip for one pay period, and the payment into the bank that paid it. */
export interface PayPeriod {
  key: string;
  payer: string;
  figures: Figure[];
  gross: number | null;
  tax: number | null;
  ni: number | null;
  pension: number | null;
  studentLoan: number | null;
  expectedNet: number | null;
  periodEnd: string | null;
  payDate: string | null;
  /** The days a payment is looked for in. */
  from: ISODate;
  to: ISODate;
  credit?: Transaction;
}

/** Nothing to pay into the bank: the deductions read are as much as the pay (a £0 payslip). */
const nothingDue = (p: PayPeriod) => p.expectedNet !== null && toMinor(p.expectedNet) <= 0;

/**
 * The year's payslips paired with the salary payments that paid them, and the salary payments no
 * payslip explains, each under the employer it came from when that is known (FORMULAS.md §17). The
 * Pay tab shows this; the tax band counts pay it puts under an employer as that employer's.
 */
export function pairPay(store: Store, ty: TaxYear): { periods: PayPeriod[]; others: { t: Transaction; employer: { key: string; payer: string } | null }[]; salary: Transaction[] } {
  const payslipFigures = store.figures.filter((f) => f.kind !== 'earned_pay' && isPayslipFigure(store, f) && (f.taxYear === ty.label || (!f.taxYear && inYear(f.periodEnd ?? f.date, ty))));
  // Pay received: salary credits in the year, plus the days either side of it for pay dates near its edges.
  const salary = store.transactions().filter((t) => t.category === 'salary' && t.amount > 0 && t.date >= addDays(ty.start, -PAY_MATCH_DAYS) && t.date <= addDays(ty.end, PAY_MATCH_DAYS));

  // Payslips: one pay period per employer and period.
  const byEmployer = new Map<string, { payer: string; periods: Map<string, Figure[]> }>();
  for (const f of payslipFigures) {
    const key = payerKey(f.payer);
    const e = byEmployer.get(key) ?? byEmployer.set(key, { payer: f.payer ?? '', periods: new Map() }).get(key)!;
    const period = `${f.periodStart ?? ''}|${f.periodEnd ?? f.date ?? ''}`;
    (e.periods.get(period) ?? e.periods.set(period, []).get(period)!).push(f);
  }
  const periods: PayPeriod[] = [];
  for (const [key, e] of byEmployer) {
    for (const [, figures] of [...e.periods.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const first = figures[0]!;
      const sum = (kind: Figure['kind']) => {
        const of = figures.filter((f) => f.kind === kind);
        return of.length ? fromMinor(of.reduce((s, f) => s + toMinor(f.amount), 0)) : null;
      };
      const gross = sum('gross_pay');
      const [tax = null, ni = null, pension = null, studentLoan = null] = DEDUCTIONS.map((k) => sum(k));
      const listed = [tax, ni, pension, studentLoan].reduce<number>((s, v) => s + toMinor(v ?? 0), 0);
      const periodEnd = first.periodEnd ?? first.date ?? null;
      const payDate = first.date ?? periodEnd;
      periods.push({
        key,
        payer: e.payer,
        figures,
        gross,
        tax,
        ni,
        pension,
        studentLoan,
        expectedNet: gross !== null ? fromMinor(toMinor(gross) - listed) : null,
        periodEnd,
        payDate,
        from: addDays(periodEnd ?? payDate!, -PAY_MATCH_DAYS),
        to: addDays(maxDate(payDate, periodEnd) ?? payDate!, PAY_MATCH_DAYS),
      });
    }
  }

  const used = new Set<string>();
  const pair = (p: PayPeriod, t: Transaction | undefined) => {
    if (!t) return;
    p.credit = t;
    used.add(t.id);
  };
  const open = (p: PayPeriod) => (t: Transaction) => !used.has(t.id) && t.date >= p.from && t.date <= p.to;
  // 1. A payment the employer's name is on, nearest the pay after the deductions read.
  for (const p of periods) {
    if (nothingDue(p)) continue;
    const net = toMinor(p.expectedNet ?? 0);
    pair(p, salary.filter((t) => open(p)(t) && fromEmployer(t, p.payer)).sort((a, b) => Math.abs(toMinor(a.amount) - net) - Math.abs(toMinor(b.amount) - net) || a.date.localeCompare(b.date))[0]);
  }
  // 2. A payment of exactly that pay, to the penny, whatever name the bank gives the employer.
  for (const p of periods) {
    if (p.credit || p.expectedNet === null || nothingDue(p)) continue;
    const day = p.payDate ?? p.periodEnd!;
    pair(p, salary.filter((t) => open(p)(t) && toMinor(t.amount) === toMinor(p.expectedNet!)).sort((a, b) => Math.abs(diffDays(a.date, day)) - Math.abs(diffDays(b.date, day)))[0]);
  }
  // 3. Pay no payslip explains: under the employer its text names, else the one the same payer
  //    paid (the nearest such payment), else under its own name.
  const payersOf = new Map<string, PayPeriod[]>();
  for (const p of periods) if (p.credit) (payersOf.get(paidBy(p.credit)) ?? payersOf.set(paidBy(p.credit), []).get(paidBy(p.credit))!).push(p);
  const others = salary
    .filter((t) => !used.has(t.id) && inYear(t.date, ty))
    .map((t) => {
      const by = periods.find((p) => p.payer && fromEmployer(t, p.payer)) ?? payersOf.get(paidBy(t))?.slice().sort((a, b) => Math.abs(diffDays(a.credit!.date, t.date)) - Math.abs(diffDays(b.credit!.date, t.date)))[0];
      return { t, employer: by ? { key: by.key, payer: by.payer } : null };
    });
  return { periods, others, salary };
}

/**
 * A document's figures for the year beside the payslips it covers (a P60, or a P45 or HMRC page to a
 * date): do they add up to it? Tax and NI settle it; pay can differ by the pension taken before tax.
 */
function documentNote(doc: { gross: number | null; tax: number | null; ni: number | null }, t: Pick<PayEmployer['totals'], 'gross' | 'tax' | 'ni' | 'pension'>): string {
  const close = (a: number, b: number) => Math.abs(toMinor(a) - toMinor(b)) < PAY_TOLERANCE_POUNDS * 100;
  if (doc.tax !== null && t.tax !== null) {
    const gap = fromMinor(toMinor(doc.tax) - toMinor(t.tax));
    if (close(doc.tax, t.tax) && (doc.ni === null || t.ni === null || close(doc.ni, t.ni))) {
      if (doc.gross === null || t.gross === null || close(doc.gross, t.gross)) return 'The payslips add up to it.';
      if (t.pension !== null && close(doc.gross, fromMinor(toMinor(t.gross) - toMinor(t.pension)))) return `The payslips add up to it. Its pay is theirs less the ${formatMoney(t.pension)} of pension taken before tax.`;
      const diff = fromMinor(toMinor(doc.gross) - toMinor(t.gross));
      return `The payslips’ tax and NI add up to it; its pay is ${formatMoney(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than their gross.`;
    }
    if (!close(doc.tax, t.tax)) return gap > 0 ? `The payslips’ tax comes to ${formatMoney(gap)} less than its tax: some payslips are missing.` : `The payslips’ tax comes to ${formatMoney(-gap)} more than its tax: check them.`;
    return 'The payslips’ NI does not add up to it: check them.';
  }
  if (doc.gross !== null && t.gross !== null && !close(doc.gross, t.gross)) return 'The payslips do not add up to it: some may be missing.';
  return 'The payslips add up to it.';
}

/** The document to set beside an employer's payslips: its year's figure, else the latest one to date. */
function employerDocument(store: Store, sources: Partial<Record<PayKind, PaySource[]>>) {
  const docs = (sources.gross_pay ?? sources.tax_deducted ?? []).filter((s) => s.kind !== 'payslips');
  const doc = docs.find((s) => s.final) ?? [...docs].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  if (!doc) return null;
  // The same document's other figures (its tax beside its pay).
  const fromDoc = (kind: PayKind) => (sources[kind] ?? []).find((s) => (doc.importId ? s.importId === doc.importId : s.kind === doc.kind))?.amount ?? null;
  const imported = doc.importId ? store.imports.find((i) => i.id === doc.importId) : undefined;
  return {
    title: imported?.documentType === 'p60' ? 'P60 for the year' : doc.kind === 'yours' ? 'Your figures for the year' : doc.final ? 'For the whole year' : `To ${formatDate(doc.asOf)}`,
    ...(imported ? { fileName: imported.fileName, importId: imported.id } : {}),
    final: doc.final,
    asOf: doc.asOf,
    gross: fromDoc('gross_pay'),
    tax: fromDoc('tax_deducted'),
    ni: fromDoc('national_insurance'),
  };
}

export function pay(store: Store, coverage: Coverage, taxYear?: string, now: ISODate = today(), earned: EarnedPayroll[] = earnedPay(store, now)): PayResponse {
  const ty = taxYear ? taxYearOf(`${taxYear.slice(0, 4)}-06-01`) : taxYearOf(now);
  const { periods, others, salary } = pairPay(store, ty);
  const years = employerYears(store, ty);

  const employers: PayEmployer[] = [];
  const employer = (key: string, payer: string) => employers.find((e) => e.key === key) ?? (employers.push({ key, payer, months: [], document: null, totals: { gross: null, tax: null, ni: null, pension: null, studentLoan: null, paidIn: 0 } }), employers[employers.length - 1]!);

  for (const p of periods) {
    const credit = p.credit;
    let status: PayMonth['status'];
    let note: string | undefined;
    if (nothingDue(p)) {
      status = 'nothing';
      note = `Nothing to pay into your bank: ${p.gross === 0 ? 'no pay this month' : 'the deductions are as much as the pay'}`;
    } else if (credit) {
      const diff = p.expectedNet !== null ? toMinor(credit.amount) - toMinor(p.expectedNet) : 0;
      status = p.expectedNet === null || Math.abs(diff) <= PAY_TOLERANCE_POUNDS * 100 ? 'paid' : 'differs';
      if (status === 'differs') note = `${formatMoney(Math.abs(fromMinor(diff)))} ${diff < 0 ? 'less' : 'more'} than the payslip’s pay after the deductions read from it: other deductions or adjustments on the payslip`;
    } else if (p.payDate && p.payDate > now) {
      status = 'due';
      note = `Due about ${p.payDate}`;
    } else {
      status = 'not-seen';
      // Is there bank data for those days at all? In the accounts this employer's pay goes into,
      // else any your salary goes into.
      const theirs = new Set([...periods.filter((q) => q.key === p.key && q.credit).map((q) => q.credit!.accountId), ...salary.filter((t) => fromEmployer(t, p.payer)).map((t) => t.accountId)]);
      const accounts = theirs.size ? theirs : new Set(salary.map((t) => t.accountId));
      const end = p.to > now ? now : p.to;
      const known = [...accounts].some((id) => {
        const c = coverage.byAccount.get(id);
        return c ? covers(c.intervals, p.from) && covers(c.intervals, end) : false;
      });
      note = known ? `No payment from ${p.payer || 'this employer'} is in your bank data between ${p.from} and ${end}` : `Your bank data does not cover ${p.from} to ${end} yet`;
    }
    employer(p.key, p.payer).months.push({
      periodStart: p.figures[0]!.periodStart ?? null,
      periodEnd: p.periodEnd,
      payDate: p.payDate,
      gross: p.gross,
      tax: p.tax,
      ni: p.ni,
      pension: p.pension,
      studentLoan: p.studentLoan,
      expectedNet: p.expectedNet,
      paidIn: credit ? { amount: credit.amount, date: credit.date, transactionId: credit.id, accountId: credit.accountId } : null,
      otherDeductions: credit && p.expectedNet !== null ? fromMinor(toMinor(p.expectedNet) - toMinor(credit.amount)) : null,
      status,
      ...(note ? { note } : {}),
      figureIds: p.figures.map((f) => f.id),
    });
  }

  // Pay into the bank with no payslip: under its employer when known, else the name it comes with.
  // A payment for timesheet work whose payslip is not imported yet goes under that payroll.
  const forWork = new Map(earned.flatMap((p) => p.expected.filter((e) => e.arrived).map((e) => [e.arrived!.transactionId, { p, e }] as const)));
  for (const { t, employer: known } of others) {
    const name = t.payee ?? t.counterpartyName ?? t.description;
    const work = forWork.get(t.id);
    const note = work ? `Pay for the work to ${work.e.periods.map((d) => formatMonth(d)).join(' and ')} on your timesheet, by the look of it: its payslip is not imported yet` : undefined;
    employer(work?.p.key ?? known?.key ?? payerKey(name), work?.p.payroll ?? known?.payer ?? name).months.push({ periodStart: null, periodEnd: null, payDate: t.date, gross: null, tax: null, ni: null, pension: null, studentLoan: null, expectedNet: null, paidIn: { amount: t.amount, date: t.date, transactionId: t.id, accountId: t.accountId }, otherDeductions: null, status: 'no-payslip', ...(note ? { note } : {}), figureIds: [] });
  }

  // Timesheet work: the periods of this tax year's work or payslips, and whatever is still owed.
  for (const p of earned) {
    const periods = p.periods.filter((x) => inYear(x.periodEnd, ty) || inYear(x.payslip?.payDate ?? x.payslip?.periodEnd ?? undefined, ty) || x.status !== 'paid');
    const expected = p.expected.filter((x) => (x.payDate ? inYear(x.payDate, ty) || x.status === 'late' : ty.label === taxYearOf(now).label));
    if (!periods.length && !expected.length) continue;
    employer(p.key, p.payroll).earned = { ...p, periods, expected };
  }

  for (const e of employers) {
    e.months.sort((a, b) => (a.payDate ?? a.periodEnd ?? '').localeCompare(b.payDate ?? b.periodEnd ?? ''));
    const total = (pick: (m: PayMonth) => number | null) => {
      const vals = e.months.map(pick).filter((v): v is number => v !== null);
      return vals.length ? fromMinor(vals.reduce((s, v) => s + toMinor(v), 0)) : null;
    };
    e.totals = { gross: total((m) => m.gross), tax: total((m) => m.tax), ni: total((m) => m.ni), pension: total((m) => m.pension), studentLoan: total((m) => m.studentLoan), paidIn: total((m) => m.paidIn?.amount ?? null) ?? 0 };
    // The document for the year beside the payslips: under any of the employer's names.
    const year = years.find((y) => y.names.some((n) => payerKey(n) === e.key)) ?? years.find((y) => payerKey(y.payer) === e.key);
    const doc = year ? employerDocument(store, year.sources) : null;
    if (doc) {
      // A document to a date is checked against the payslips paid by then (with the days a pay date can move).
      const upTo = doc.final ? null : addDays(doc.asOf, PAY_MATCH_DAYS);
      const months = upTo ? e.months.filter((m) => (m.payDate ?? m.periodEnd ?? '') <= upTo) : e.months;
      const sumOf = (pick: (m: PayMonth) => number | null) => {
        const vals = months.map(pick).filter((v): v is number => v !== null);
        return vals.length ? fromMinor(vals.reduce((s, v) => s + toMinor(v), 0)) : null;
      };
      const covered = { gross: sumOf((m) => m.gross), tax: sumOf((m) => m.tax), ni: sumOf((m) => m.ni), pension: sumOf((m) => m.pension) };
      e.document = { ...doc, note: documentNote(doc, covered) };
    }
  }
  employers.sort((a, b) => (b.totals.gross ?? b.totals.paidIn) - (a.totals.gross ?? a.totals.paidIn));

  const notes: string[] = [];
  if (earned.length) notes.push('Timesheet work is matched to the payslip whose gross is exactly a run of its unpaid months, oldest first. What is owed is expected with the next payslip after the usual delay; its tax and NI are estimates from the payroll’s last payslip and the UK rates.');
  if (!periods.length) notes.push('No payslips for this tax year: import them to see gross pay, tax and NI month by month. Pay into your bank is shown on its own.');
  notes.push('Pay is matched to a payment into your bank within 10 days of the pay date: from the same employer, or of exactly the pay after the deductions read. Deductions not read from a payslip (a cycle scheme, say) show as the difference.');
  return { taxYear: { label: ty.label, start: ty.start, end: ty.end }, employers, notes };
}
