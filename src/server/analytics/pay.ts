// Pay, month by month: each payslip's figures (gross, tax, NI, pension, student loan), what reached
// your bank, and pay seen in the bank with no payslip (docs/FORMULAS.md §17).

import type { EarnedPayroll, PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { addDays, diffDays, formatDate, formatMonth, maxDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Employment, Figure, HmrcRecord, PayslipRecord, Transaction } from '../../shared/schema';
import { employerCostsOf, jobPayslips, payslipGaps, payslipOf } from './payslips';
import { taxYearOf, type TaxYear } from '../../shared/uk';
import { earnedPay } from './earned';
import type { Store } from '../store';
import { covers, type Coverage } from './coverage';
import { employerYears, isPayslipFigure, jobEndedOn, payerKey, type PayKind, type PaySource } from './sources';
import { parseTaxCode, payeTax, taxMonth } from '../../shared/paye';
import { matchEmployment, namesOf } from '../employments';
import { payrollPattern } from '../../shared/categorise';

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

/**
 * Does a bank credit look like it came from this job: a word of one of its names in its text, or
 * your payroll number there (banks often show a payroll company's name, and two jobs paid through
 * one payroll differ only by the number in the reference).
 */
export function fromJob(t: Pick<Transaction, 'description' | 'payee' | 'counterpartyName'>, job: { names: string[]; payrollNumbers: string[] }): boolean {
  if (job.names.some((n) => fromEmployer(t, n))) return true;
  return payrollPattern(job.payrollNumbers)?.test(t.description) ?? false;
}

/** One employer's payslip for one pay period, and the payment into the bank that paid it. */
export interface PayPeriod {
  /** The job (its id), else the employer's reduced name. */
  key: string;
  payer: string;
  /** Every name the job comes under, and your payroll numbers there. */
  names: string[];
  payrollNumbers: string[];
  employmentId?: string;
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
  /** You said its pay is owed to you: on the Pay tab, or by telling the app it had not arrived (`contextId`). */
  owed?: { markedAt: string; note?: string; contextId?: string };
  /** HMRC's record of this payment, when its pay and tax are the payslip's to the penny. */
  hmrcId?: string;
  /** The payslip in full, when it was read in full; `expectedNet` is then the net pay it prints. */
  payslip?: PayslipRecord;
  netPrinted?: boolean;
}

/** HMRC's one record of a job's payment whose pay and tax are a payslip's, to the penny (its taxable pay is the gross, or the gross less pension taken before tax). */
function paymentOf(store: Store, employmentId: string, ty: TaxYear, gross: number | null, tax: number | null, pension: number | null): Extract<HmrcRecord, { type: 'payment' }> | undefined {
  if (gross === null || tax === null || !toMinor(gross)) return undefined;
  const taxable = [toMinor(gross), toMinor(gross) - toMinor(pension ?? 0)];
  const found = store.hmrc.filter((r): r is Extract<HmrcRecord, { type: 'payment' }> => r.type === 'payment' && r.employmentId === employmentId && r.taxYear === ty.label && toMinor(r.tax) === toMinor(tax) && taxable.includes(toMinor(r.taxablePay)));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Pay you said is owed for a job's period: marked on the Pay tab (the job's `owed`), else told to the
 * app (an active context record of pay not received that names the employer, the period ending in
 * its days).
 */
function owedFor(store: Store, job: Employment, periodEnd: string | null): PayPeriod['owed'] {
  if (!periodEnd) return undefined;
  const marked = job.owed.find((o) => o.periodEnd === periodEnd);
  if (marked) return { markedAt: marked.markedAt, ...(marked.note ? { note: marked.note } : {}) };
  const told = store.context.find((c) => {
    const d = c.detail;
    const employer = d.attributes?.employer;
    return c.status === 'active' && d.event === 'pay_not_received' && Boolean(d.to) && periodEnd >= (d.from ?? d.to!) && periodEnd <= d.to! && typeof employer === 'string' && Boolean(matchEmployment([job], { employer }));
  });
  return told ? { markedAt: told.createdAt, contextId: told.id } : undefined;
}

/** What a month shows of its payslip in full: its code and NI letter, the net it prints, and the employer's costs. */
function payslipDetail(store: Store, p: PayPeriod, ty: TaxYear): Pick<PayMonth, 'netPrinted' | 'payslipId' | 'taxCode' | 'niLetter' | 'employerCosts'> {
  const slip = p.payslip;
  const code = slip?.taxCode ? `${slip.taxCode}${slip.cumulative === false ? ' M1' : ''}` : p.figures.find((f) => f.taxCode)?.taxCode;
  const list = slip?.employmentId ? jobPayslips(store, slip.employmentId, ty) : [];
  const at = slip ? list.findIndex((x) => x.id === slip.id) : -1;
  const costs = at >= 0 ? employerCostsOf(list, at) : {};
  return {
    ...(p.netPrinted ? { netPrinted: true } : {}),
    ...(slip ? { payslipId: slip.id } : {}),
    ...(code ? { taxCode: code } : {}),
    ...(slip?.niLetter ? { niLetter: slip.niLetter } : {}),
    ...(Object.keys(costs).length ? { employerCosts: costs } : {}),
  };
}

/** Nothing to pay into the bank: the deductions read are as much as the pay (a £0 payslip). */
const nothingDue = (p: PayPeriod) => p.expectedNet !== null && toMinor(p.expectedNet) <= 0;

/**
 * The year's payslips paired with the salary payments that paid them, and the salary payments no
 * payslip explains, each under the job it came from when that is known (FORMULAS.md §17). The Pay
 * tab shows this; the tax band counts pay it puts under a job as that job's.
 */
export function pairPay(store: Store, ty: TaxYear): { periods: PayPeriod[]; others: { t: Transaction; employer: { key: string; payer: string } | null }[]; salary: Transaction[] } {
  const payslipFigures = store.figures.filter((f) => f.kind !== 'earned_pay' && isPayslipFigure(store, f) && (f.taxYear === ty.label || (!f.taxYear && inYear(f.periodEnd ?? f.date, ty))));
  // Pay received: salary credits in the year, plus the days either side of it for pay dates near its
  // edges, and later ones for pay that is owed.
  const salary = store.transactions().filter((t) => t.category === 'salary' && t.amount > 0 && t.date >= addDays(ty.start, -PAY_MATCH_DAYS));

  // Payslips: one pay period per job (else employer) and period.
  const byEmployer = new Map<string, { payer: string; names: string[]; payrollNumbers: string[]; employmentId?: string; periods: Map<string, Figure[]> }>();
  for (const f of payslipFigures) {
    const job = store.employment(f.employmentId);
    const key = job?.id ?? payerKey(f.payer);
    const e =
      byEmployer.get(key) ??
      byEmployer.set(key, { payer: job?.employer ?? f.payer ?? '', names: job ? namesOf(job) : f.payer ? [f.payer] : [], payrollNumbers: job?.payrollNumbers ?? [], ...(job ? { employmentId: job.id } : {}), periods: new Map() }).get(key)!;
    const period = `${f.periodStart ?? ''}|${f.periodEnd ?? f.date ?? ''}`;
    (e.periods.get(period) ?? e.periods.set(period, []).get(period)!).push(f);
  }
  const periods: PayPeriod[] = [];
  for (const [key, e] of byEmployer) {
    const job = store.employment(e.employmentId);
    // In date order (a payslip that prints no period goes by its date).
    const at = ([key, figures]: [string, Figure[]]) => `${figures[0]!.periodEnd ?? figures[0]!.date ?? ''}|${key}`;
    for (const [, figures] of [...e.periods.entries()].sort((a, b) => at(a).localeCompare(at(b)))) {
      const first = figures[0]!;
      const sum = (kind: Figure['kind']) => {
        const of = figures.filter((f) => f.kind === kind);
        return of.length ? fromMinor(of.reduce((s, f) => s + toMinor(f.amount), 0)) : null;
      };
      const gross = sum('gross_pay');
      const [tax = null, ni = null, pension = null, studentLoan = null] = DEDUCTIONS.map((k) => sum(k));
      const listed = [tax, ni, pension, studentLoan].reduce<number>((s, v) => s + toMinor(v ?? 0), 0);
      // HMRC's record of the payment. A payslip that prints no period (a final one, dated the day
      // you left) is looked for at the pay date HMRC was told.
      const record = job ? paymentOf(store, job.id, ty, gross, tax, pension) : undefined;
      const undated = !first.periodStart && !first.periodEnd && record ? record.payDate : undefined;
      const periodEnd = first.periodEnd ?? first.date ?? null;
      const payDate = undated ?? first.date ?? periodEnd;
      const owed = job ? owedFor(store, job, periodEnd) : undefined;
      // The payslip in full: the net pay it prints is what reaches the bank, whatever the lines read.
      const slip = payslipOf(store, figures);
      const printed = slip?.totals.net;
      periods.push({
        key,
        payer: e.payer,
        names: e.names,
        payrollNumbers: e.payrollNumbers,
        ...(e.employmentId ? { employmentId: e.employmentId } : {}),
        figures,
        gross,
        tax,
        ni,
        pension,
        studentLoan,
        expectedNet: printed ?? (gross !== null ? fromMinor(toMinor(gross) - listed) : null),
        ...(printed !== undefined ? { netPrinted: true } : {}),
        ...(slip ? { payslip: slip } : {}),
        periodEnd,
        payDate,
        from: addDays(undated ?? periodEnd ?? payDate!, -PAY_MATCH_DAYS),
        to: addDays(maxDate(payDate, periodEnd) ?? payDate!, PAY_MATCH_DAYS),
        ...(owed ? { owed } : {}),
        ...(record ? { hmrcId: record.id } : {}),
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
  // 1. A payment the job's name or payroll number is on: one of the pay after the deductions read
  //    (within £1) first, so no payslip takes another's own payment; then pay brought forward (before
  //    Christmas, say), exactly that pay to the penny, earlier in the pay period, the nearest the pay
  //    date; then the nearest to that pay.
  const near = (p: PayPeriod) => (t: Transaction) => Math.abs(toMinor(t.amount) - toMinor(p.expectedNet ?? 0)) <= PAY_TOLERANCE_POUNDS * 100;
  const fromTheJob = (exact: boolean) => {
    for (const p of periods) {
      if (p.credit || nothingDue(p)) continue;
      const net = toMinor(p.expectedNet ?? 0);
      pair(p, salary.filter((t) => open(p)(t) && fromJob(t, p) && (!exact || near(p)(t))).sort((a, b) => Math.abs(toMinor(a.amount) - net) - Math.abs(toMinor(b.amount) - net) || a.date.localeCompare(b.date))[0]);
    }
  };
  fromTheJob(true);
  for (const p of periods) {
    const start = p.figures[0]!.periodStart;
    if (p.credit || nothingDue(p) || p.expectedNet === null || !start) continue;
    const day = p.payDate ?? p.periodEnd!;
    pair(p, salary.filter((t) => !used.has(t.id) && t.date >= start && t.date < p.from && fromJob(t, p) && toMinor(t.amount) === toMinor(p.expectedNet!)).sort((a, b) => Math.abs(diffDays(a.date, day)) - Math.abs(diffDays(b.date, day)))[0]);
  }
  fromTheJob(false);
  // 2. A payment of exactly that pay, to the penny, whatever name the bank gives the employer.
  for (const p of periods) {
    if (p.credit || p.expectedNet === null || nothingDue(p)) continue;
    const day = p.payDate ?? p.periodEnd!;
    pair(p, salary.filter((t) => open(p)(t) && toMinor(t.amount) === toMinor(p.expectedNet!)).sort((a, b) => Math.abs(diffDays(a.date, day)) - Math.abs(diffDays(b.date, day)))[0]);
  }
  // 3. Pay you said is owed, arriving late: a payment from the job of exactly that pay after its
  //    window, the oldest owed first. A payment that names the period's month is taken first.
  for (const p of [...periods].filter((x) => x.owed && !x.credit && x.expectedNet !== null).sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? ''))) {
    const month = p.periodEnd ? formatMonth(p.periodEnd).split(' ')[0]!.toLowerCase() : '';
    const late = salary.filter((t) => !used.has(t.id) && t.date > p.to && fromJob(t, p) && toMinor(t.amount) === toMinor(p.expectedNet!));
    pair(p, late.sort((a, b) => Number(b.description.toLowerCase().includes(month)) - Number(a.description.toLowerCase().includes(month)) || a.date.localeCompare(b.date))[0]);
  }
  // 4. Pay no payslip explains: under the job its text names (or its payroll number), else the one
  //    the same payer paid (the nearest such payment), else under its own name.
  const payersOf = new Map<string, PayPeriod[]>();
  for (const p of periods) if (p.credit) (payersOf.get(paidBy(p.credit)) ?? payersOf.set(paidBy(p.credit), []).get(paidBy(p.credit))!).push(p);
  const jobs = store.employments.map((j) => ({ key: j.id, payer: j.employer, names: namesOf(j), payrollNumbers: j.payrollNumbers }));
  const others = salary
    .filter((t) => !used.has(t.id) && inYear(t.date, ty))
    .map((t) => {
      const by =
        periods.find((p) => p.payer && fromJob(t, p)) ??
        jobs.find((j) => fromJob(t, j)) ??
        payersOf.get(paidBy(t))?.slice().sort((a, b) => Math.abs(diffDays(a.credit!.date, t.date)) - Math.abs(diffDays(b.credit!.date, t.date)))[0];
      return { t, employer: by ? { key: by.key, payer: by.payer } : null };
    });
  return { periods, others, salary: salary.filter((t) => t.date <= addDays(ty.end, PAY_MATCH_DAYS)) };
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
  const docs = (sources.gross_pay ?? sources.tax_deducted ?? []).filter((s) => s.kind !== 'payslips' && !s.payslipId);
  const doc = docs.find((s) => s.final) ?? [...docs].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  if (!doc) return null;
  // The same source's other figures (its tax beside its pay): the same import, or HMRC's record.
  const same = (a: PaySource) => (a.importId || doc.importId ? a.importId === doc.importId : Boolean(a.records) === Boolean(doc.records) && a.kind === doc.kind);
  const fromDoc = (kind: PayKind) => (sources[kind] ?? []).find(same)?.amount ?? null;
  const imported = doc.importId ? store.imports.find((i) => i.id === doc.importId) : undefined;
  const title =
    imported?.documentType === 'p60'
      ? 'P60 for the year'
      : doc.kind === 'yours'
        ? 'Your figures for the year'
        : doc.records
          ? `HMRC’s record to ${formatDate(doc.asOf)}${doc.final ? ' (the job has ended)' : ''}`
          : doc.kind === 'year'
            ? 'For the whole year'
            : `To ${formatDate(doc.asOf)}${doc.final ? ' (the job has ended)' : ''}`;
  return {
    title,
    ...(imported ? { fileName: imported.fileName, importId: imported.id } : {}),
    final: doc.final,
    asOf: doc.asOf,
    gross: fromDoc('gross_pay'),
    tax: fromDoc('tax_deducted'),
    ni: fromDoc('national_insurance'),
  };
}

/**
 * Days before a pay date that HMRC must have issued a tax code for the payroll to have used it: an
 * employer operates a new code from the first pay day after it receives the notice, and a payroll is
 * run a while before the pay day (FORMULAS.md §17, "Tax on HMRC's code").
 */
export const CODE_NOTICE_DAYS = 14;

/** The tax code HMRC issued for a job that was in force for a pay date: the latest issued long enough before it. */
export function codeInForce(store: Store, employmentId: string, payDate: ISODate): Extract<HmrcRecord, { type: 'tax-code' }> | undefined {
  return store.hmrc
    .filter((r): r is Extract<HmrcRecord, { type: 'tax-code' }> => r.type === 'tax-code' && r.employmentId === employmentId && r.date <= addDays(payDate, -CODE_NOTICE_DAYS))
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
}

/** The day a job started: yours, else HMRC's (its employment page, or the account's "new employment"). */
export function jobStartedOn(store: Store, employmentId: string): string | undefined {
  const yours = store.employment(employmentId)?.startedOn;
  if (yours) return yours;
  return store.hmrc
    .flatMap((r) => (r.employmentId !== employmentId ? [] : r.type === 'employment' && r.startedOn ? [r.startedOn] : r.type === 'event' && r.event === 'started' ? [r.date] : []))
    .sort()
    .at(-1);
}

export function pay(store: Store, coverage: Coverage, taxYear?: string, now: ISODate = today(), earned: EarnedPayroll[] = earnedPay(store, now)): PayResponse {
  const ty = taxYear ? taxYearOf(`${taxYear.slice(0, 4)}-06-01`) : taxYearOf(now);
  const { periods, others, salary } = pairPay(store, ty);
  const years = employerYears(store, ty);

  const employers: PayEmployer[] = [];
  const employer = (key: string, payer: string) => {
    const found = employers.find((e) => e.key === key);
    if (found) return found;
    const job = store.employment(key);
    const e: PayEmployer = { key, payer: job?.employer ?? payer, months: [], document: null, totals: { gross: null, tax: null, ni: null, pension: null, studentLoan: null, paidIn: 0 } };
    if (job) {
      const started = jobStartedOn(store, job.id);
      const ended = jobEndedOn(store, job.id);
      // The codes in force during the year: those issued in it, and the last one issued before it.
      const codes = store.hmrc.filter((r): r is Extract<HmrcRecord, { type: 'tax-code' }> => r.type === 'tax-code' && r.employmentId === job.id).sort((a, b) => a.date.localeCompare(b.date));
      const before = codes.filter((c) => c.date < ty.start).at(-1);
      const during = codes.filter((c) => c.date >= ty.start && c.date <= ty.end);
      Object.assign(e, {
        employmentId: job.id,
        ...(job.payeReference ? { payeReference: job.payeReference } : {}),
        ...(job.payrollNumbers.length ? { payrollNumbers: job.payrollNumbers } : {}),
        ...(started ? { startedOn: started } : {}),
        ...(ended ? { endedOn: ended } : {}),
        codes: [...(before ? [before] : []), ...during].map((c) => ({ date: c.date, code: c.code, cumulative: c.cumulative })),
      });
    }
    employers.push(e);
    return e;
  };

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
      if (status === 'differs')
        note = p.netPrinted
          ? `${formatMoney(Math.abs(fromMinor(diff)))} ${diff < 0 ? 'less' : 'more'} than the net pay the payslip prints`
          : `${formatMoney(Math.abs(fromMinor(diff)))} ${diff < 0 ? 'less' : 'more'} than the payslip’s pay after the deductions read from it: other deductions or adjustments on the payslip`;
      else if (p.owed && credit.date > p.to) note = `Arrived late, on ${formatDate(credit.date)}: you had said it was owed`;
    } else if (p.owed) {
      status = 'owed';
      note = p.owed.contextId ? 'Owed to you: you told the app it had not arrived' : `Owed to you: you said it will be paid${p.owed.note ? ` (${p.owed.note})` : ''}`;
    } else if (p.payDate && p.payDate > now) {
      status = 'due';
      note = `Due about ${p.payDate}`;
    } else {
      status = 'not-seen';
      // Is there bank data for those days at all? In the accounts this job's pay goes into, else
      // any your salary goes into.
      const theirs = new Set([...periods.filter((q) => q.key === p.key && q.credit).map((q) => q.credit!.accountId), ...salary.filter((t) => fromJob(t, p)).map((t) => t.accountId)]);
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
      ...(p.owed ? { owed: p.owed } : {}),
      ...payslipDetail(store, p, ty),
    });
  }

  // Pay into the bank with no payslip: under its job when known, else the name it comes with.
  // A payment for timesheet work whose payslip is not imported yet goes under that payroll.
  const forWork = new Map(earned.flatMap((p) => p.expected.filter((e) => e.arrived).map((e) => [e.arrived!.transactionId, { p, e }] as const)));
  for (const { t, employer: known } of others) {
    const name = t.payee ?? t.counterpartyName ?? t.description;
    const work = forWork.get(t.id);
    const note = work ? `Pay for the work to ${work.e.periods.map((d) => formatMonth(d)).join(' and ')} on your timesheet, by the look of it: its payslip is not imported yet` : undefined;
    employer(work?.p.key ?? known?.key ?? payerKey(name), work?.p.payroll ?? known?.payer ?? name).months.push({ periodStart: null, periodEnd: null, payDate: t.date, gross: null, tax: null, ni: null, pension: null, studentLoan: null, expectedNet: null, paidIn: { amount: t.amount, date: t.date, transactionId: t.id, accountId: t.accountId }, otherDeductions: null, status: 'no-payslip', ...(note ? { note } : {}), figureIds: [] });
  }

  // HMRC's record of each payment, beside the payslip whose pay and tax it has, else the month of the
  // same tax month: what the employer reported. A payment no month has is a pay date with no payslip
  // imported.
  const byAmount = new Map(periods.flatMap((p) => (p.hmrcId ? [[p.hmrcId, p.figures[0]!.id] as const] : [])));
  const taken = new Set(byAmount.values());
  for (const r of store.hmrc) {
    if (r.type !== 'payment' || r.taxYear !== ty.label || !r.employmentId) continue;
    const e = employer(r.employmentId, r.employer ?? r.employmentId);
    const month = taxMonth(r.payDate);
    const at = (m: PayMonth) => m.payDate ?? m.periodEnd ?? m.paidIn?.date;
    const its = byAmount.get(r.id);
    const same = its
      ? e.months.find((m) => m.figureIds.includes(its))
      : e.months.filter((m) => !m.hmrc && !m.figureIds.some((id) => taken.has(id)) && at(m) && taxMonth(at(m)!) === month && inYear(at(m), ty)).sort((a, b) => Number(b.figureIds.length > 0) - Number(a.figureIds.length > 0))[0];
    const hmrc = { payDate: r.payDate, taxablePay: r.taxablePay, tax: r.tax, ni: r.ni ?? null, recordId: r.id };
    if (same) same.hmrc = hmrc;
    else
      e.months.push({
        periodStart: null,
        periodEnd: null,
        payDate: r.payDate,
        gross: null,
        tax: null,
        ni: null,
        pension: null,
        studentLoan: null,
        expectedNet: null,
        paidIn: null,
        otherDeductions: null,
        // A pay date with no pay or tax (an employer can report one) has nothing to pay in.
        ...(toMinor(r.taxablePay) === 0 && toMinor(r.tax) === 0
          ? { status: 'nothing' as const, note: 'Nothing paid: HMRC’s record of this pay date has no pay and no tax' }
          : { status: 'no-payslip' as const, note: `No payslip imported for this pay date: HMRC's record says ${formatMoney(r.taxablePay)} of taxable pay and ${formatMoney(r.tax)} of tax` }),
        figureIds: [],
        hmrc,
      });
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
    if (e.employmentId) {
      taxChecks(store, e, e.employmentId);
      // Pay the year to date shows on no imported payslip.
      const gaps = payslipGaps(jobPayslips(store, e.employmentId, ty));
      if (gaps.length) e.gaps = gaps.map((g) => ({ ...(g.after ? { after: g.after.payDate } : {}), before: g.before.payDate, amount: g.amount }));
    }
    // The document for the year beside the payslips: the job's, else under any of the employer's names.
    const year = years.find((y) => y.employmentId && y.employmentId === e.key) ?? years.find((y) => y.names.some((n) => payerKey(n) === e.key)) ?? years.find((y) => payerKey(y.payer) === e.key);
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
  notes.push('Pay is matched to a payment into your bank within 10 days of the pay date: from the same job (by name or payroll number), or of exactly the pay after the deductions read. Pay the job brought forward (before Christmas, say) is matched earlier in its pay period when it is exactly that pay. Net pay is what the payslip prints when it was read in full; otherwise it is the pay less the deductions read, and any not read (a cycle scheme, say) show as the difference.');
  if (employers.some((e) => e.months.some((m) => m.check))) notes.push(`The tax a pay date would have on HMRC’s code is worked out from the taxable pay HMRC’s record shows, on the code HMRC issued at least ${CODE_NOTICE_DAYS} days before it (a payroll cannot use a code it has not been sent).`);
  return { taxYear: { label: ty.label, start: ty.start, end: ty.end }, employers, notes };
}

/**
 * Tax on HMRC's code (FORMULAS.md §17): for each payment HMRC's record shows, the tax the code HMRC
 * issued for the job would take (cumulative codes counting the job's earlier pay and tax in the
 * year), set beside what was taken when they differ by more than £1.
 */
function taxChecks(store: Store, e: PayEmployer, employmentId: string): void {
  let previousPay = 0;
  let previousTax = 0;
  for (const m of [...e.months].filter((x) => x.hmrc).sort((a, b) => a.hmrc!.payDate.localeCompare(b.hmrc!.payDate))) {
    const h = m.hmrc!;
    const issued = codeInForce(store, employmentId, h.payDate);
    const code = issued ? parseTaxCode(`${issued.code}${issued.cumulative ? '' : ' M1'}`) : null;
    const tax = code ? payeTax({ gross: h.taxablePay, payDate: h.payDate, code, previousPay, previousTax }) : null;
    if (issued && tax !== null && Math.abs(toMinor(tax) - toMinor(h.tax)) > PAY_TOLERANCE_POUNDS * 100) {
      const printed = m.taxCode;
      m.check = {
        code: issued.code,
        cumulative: issued.cumulative,
        issuedOn: issued.date,
        tax,
        taken: h.tax,
        note: `On HMRC’s code ${issued.code}${issued.cumulative ? '' : ' week 1/month 1'} (issued ${formatDate(issued.date)}) this pay would have ${formatMoney(tax)} of tax; ${formatMoney(h.tax)} was taken${printed ? `, on the ${printed} its payslip shows` : ''}`,
      };
    }
    previousPay = fromMinor(toMinor(previousPay) + toMinor(h.taxablePay));
    previousTax = fromMinor(toMinor(previousTax) + toMinor(h.tax));
  }
}
