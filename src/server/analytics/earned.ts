// Pay earned on timesheets, followed to the payslip that paid it and the payment into the bank; what
// is still owed, when it should come, and what the payroll should take from it (docs/FORMULAS.md
// §17, "Earned pay"). Computed from figures and transactions; the estimates are labelled as such.

import type { EarnedPayroll, EarnedPeriod, ExpectedPay, OwedPay } from '../../shared/api';
import { addDays, addMonths, endOfMonth, formatMonth, makeDate, today, weekday, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import { employeeNi, parseTaxCode, payeTax, standardTaxCode, type TaxCode } from '../../shared/paye';
import type { DraftFigure, Figure, Transaction } from '../../shared/schema';
import { taxYear, taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import { fromJob, isPayslipFigure, pairPay, payerKey, type PayPeriod } from './pay';
import { namesOf } from '../employments';

/** A payslip's tax is reproduced by a basis when the estimate is within this of it. */
const BASIS_TOLERANCE_POUNDS = 1;

/** One period of one timesheet: its payer, role and dates. Two uploads of the timesheet share it. */
const slotKey = (f: Pick<Figure, 'payer' | 'work' | 'periodStart' | 'periodEnd'>) => `${payerKey(f.payer)}|${payerKey(f.work?.role)}|${f.periodStart ?? ''}|${f.periodEnd ?? ''}`;

/**
 * The earned pay that stands for each period, oldest first: a later upload of a timesheet replaces
 * an earlier one's figure for the same period (the later committed wins).
 */
export function effectiveEarned(figures: Figure[]): Figure[] {
  const by = new Map<string, Figure>();
  for (const f of figures) {
    if (f.kind !== 'earned_pay' || !f.periodEnd) continue;
    const k = slotKey(f);
    const o = by.get(k);
    if (!o || f.createdAt > o.createdAt || (f.createdAt === o.createdAt && f.id > o.id)) by.set(k, f);
  }
  return [...by.values()].sort((a, b) => a.periodEnd!.localeCompare(b.periodEnd!) || payerKey(a.payer).localeCompare(payerKey(b.payer)));
}

/** The stored figure a draft's earned pay replaces: the same period of the same timesheet, another amount. */
export function earnedReplaced(store: Store, f: Pick<DraftFigure, 'kind' | 'payer' | 'work' | 'periodStart' | 'periodEnd' | 'amount'>): Figure | undefined {
  if (f.kind !== 'earned_pay' || !f.periodEnd) return undefined;
  const standing = effectiveEarned(store.figures).find((x) => slotKey(x) === slotKey(f));
  return standing && toMinor(standing.amount) !== toMinor(f.amount) ? standing : undefined;
}

/** The payroll that pays an earned figure: the employer its payslips name. */
export const payrollOf = (f: Pick<Figure, 'paidBy' | 'payer'>) => f.paidBy ?? f.payer ?? '';

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** A payslip's own end: its period's end, else its pay date. */
const slipEnd = (p: PayPeriod) => p.periodEnd ?? p.payDate ?? '';

/**
 * Which payslip paid which periods: each payslip with pay pays the run of consecutive unpaid
 * periods, oldest first, ended by its own end, whose pay adds up to its gross to the penny. A £0
 * payslip pays nothing; a payslip no run adds up to is left unmatched.
 */
export function matchEarned(earned: Figure[], slips: PayPeriod[]): Map<PayPeriod, Figure[]> {
  const unpaid = [...earned].sort((a, b) => a.periodEnd!.localeCompare(b.periodEnd!));
  const out = new Map<PayPeriod, Figure[]>();
  for (const s of [...slips].sort((a, b) => slipEnd(a).localeCompare(slipEnd(b)))) {
    if (s.gross === null || toMinor(s.gross) <= 0) continue;
    const before = unpaid.filter((e) => e.periodEnd! <= slipEnd(s));
    const target = toMinor(s.gross);
    let run: Figure[] | undefined;
    for (let i = 0; i < before.length && !run; i++) {
      let sum = 0;
      for (let j = i; j < before.length; j++) {
        sum += toMinor(before[j]!.amount);
        if (sum === target) {
          run = before.slice(i, j + 1);
          break;
        }
        if (sum > target) break;
      }
    }
    if (!run) continue;
    out.set(s, run);
    for (const e of run) unpaid.splice(unpaid.indexOf(e), 1);
  }
  return out;
}

/** A pay day that falls at a weekend is paid on the Friday before. */
function workingDay(d: ISODate): ISODate {
  const w = weekday(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

/** The day `day` of a month (YYYY-MM), or its last day when the month is shorter. */
function dayOf(month: string, day: number): ISODate {
  const last = endOfMonth(`${month}-01`);
  return makeDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)), Math.min(day, Number(last.slice(8, 10)))) ?? last;
}

interface Basis {
  code: TaxCode;
  /** In words: "1257L M1, as your last payslip shows" or "1257L M1, which matches your last payslip’s tax". */
  label: string;
}

/** Pay and tax with this payroll earlier in the tax year of `payDate`. */
function yearToDate(slips: PayPeriod[], payDate: ISODate): { pay: number; tax: number } {
  const ty = taxYearOf(payDate);
  let pay = 0;
  let tax = 0;
  for (const s of slips) {
    const d = s.payDate ?? s.periodEnd;
    if (!d || d < ty.start || d >= payDate) continue;
    pay += toMinor(s.gross ?? 0);
    tax += toMinor(s.tax ?? 0);
  }
  return { pay: fromMinor(pay), tax: fromMinor(tax) };
}

/**
 * The tax basis the payroll uses: the code its last payslip prints, else the standard code, month 1
 * or cumulative, whichever gives that payslip's tax. Null when nothing reproduces it.
 */
export function taxBasis(slips: PayPeriod[]): Basis | null {
  const last = [...slips].filter((s) => s.gross !== null && toMinor(s.gross) > 0 && s.tax !== null).sort((a, b) => slipEnd(a).localeCompare(slipEnd(b))).at(-1);
  if (!last) return null;
  const printed = last.figures.map((f) => f.taxCode).find(Boolean);
  const code = printed ? parseTaxCode(printed) : null;
  if (code) return { code, label: `${code.code}, as your last payslip shows` };
  const payDate = last.payDate ?? last.periodEnd!;
  const ytd = yearToDate(slips, payDate);
  for (const cumulative of [false, true]) {
    const c = standardTaxCode(taxYearOf(payDate), cumulative);
    const tax = payeTax({ gross: last.gross!, payDate, code: c, previousPay: ytd.pay, previousTax: ytd.tax });
    if (tax !== null && Math.abs(toMinor(tax) - toMinor(last.tax!)) <= BASIS_TOLERANCE_POUNDS * 100) return { code: c, label: `${c.code}, which gives your last payslip’s tax` };
  }
  return null;
}

/** What the payroll should take from `gross` paid on `payDate`, by the basis its payslips show. */
export function estimateDeductions(slips: PayPeriod[], gross: number, payDate: ISODate, months: number[] = []): ExpectedPay['estimate'] & { apart: ExpectedPay['apart'] } {
  const notes: string[] = [];
  const ni = employeeNi(gross, payDate);
  if (ni === null) notes.push(`NI is not worked out for ${taxYearOf(payDate).label}.`);
  const basis = taxBasis(slips);
  const ytd = yearToDate(slips, payDate);
  const tax = basis ? payeTax({ gross, payDate, code: basis.code, previousPay: ytd.pay, previousTax: ytd.tax }) : null;
  if (!basis) notes.push('Tax is not estimated: no payslip from this payroll shows a tax code, or tax that a standard code gives.');
  else if (tax === null) notes.push('Tax is not estimated for a Scottish tax code.');
  const last = [...slips].filter((s) => s.gross !== null && toMinor(s.gross) > 0).sort((a, b) => slipEnd(a).localeCompare(slipEnd(b))).at(-1);
  let pension: number | null = null;
  if (last && last.pension !== null && toMinor(last.pension) > 0) {
    pension = fromMinor(Math.round((toMinor(gross) * toMinor(last.pension)) / toMinor(last.gross!)));
    notes.push(`Pension: the same share of pay as on the last payslip (${formatMoney(last.pension)} of ${formatMoney(last.gross!)}).`);
  }
  if (last && last.studentLoan !== null && toMinor(last.studentLoan) > 0) notes.push('A student loan deduction is likely, as on your last payslip; it is not estimated.');
  const net = tax !== null && ni !== null ? fromMinor(toMinor(gross) - toMinor(tax) - toMinor(ni) - toMinor(pension ?? 0)) : null;
  // Several months' pay at once, against each paid in a month of its own: NI is per pay period, and
  // a month-1 code taxes each month on its own.
  let apart: ExpectedPay['apart'] = null;
  if (months.length > 1) {
    const niApart = ni === null ? null : months.reduce((s, m) => s + toMinor(employeeNi(m, payDate) ?? 0), 0);
    const taxApart = tax === null || !basis ? null : basis.code.cumulative ? toMinor(tax) : months.reduce((s, m) => s + toMinor(payeTax({ gross: m, payDate, code: basis.code }) ?? 0), 0);
    apart = {
      ni: niApart === null ? null : fromMinor(niApart),
      tax: taxApart === null ? null : fromMinor(taxApart),
      extraNi: niApart === null || ni === null ? null : fromMinor(toMinor(ni) - niApart),
      extraTax: taxApart === null || tax === null ? null : fromMinor(toMinor(tax) - taxApart),
    };
  }
  return { tax, ni, pension, net, basis: basis?.label ?? null, notes, apart };
}

const periodName = (f: Pick<Figure, 'periodEnd'>) => f.periodEnd!.slice(0, 7);

/**
 * Every payroll that pays a timesheet: its periods, which payslip paid each, and what is still owed
 * and when it should come.
 */
export function earnedPay(store: Store, now: ISODate = today()): EarnedPayroll[] {
  const earned = effectiveEarned(store.figures);
  if (!earned.length) return [];
  // Payslips and the payments that paid them, every tax year from the first work to now.
  const slips: PayPeriod[] = [];
  const unexplained: Transaction[] = [];
  for (let y = taxYearOf(earned[0]!.periodEnd!).startYear; y <= taxYearOf(now).startYear; y++) {
    const { periods, others } = pairPay(store, taxYear(y));
    slips.push(...periods);
    unexplained.push(...others.map((o) => o.t));
  }
  const used = new Set<string>();
  const out: EarnedPayroll[] = [];
  // A payroll is the job its earned pay is under, else its reduced name (before jobs).
  const keyOf = (f: Figure) => f.employmentId ?? payerKey(payrollOf(f));
  const keys = [...new Set(earned.map(keyOf))];
  for (const key of keys) {
    const mine = earned.filter((f) => keyOf(f) === key);
    const job = store.employment(key);
    const who = job ? { names: namesOf(job), payrollNumbers: job.payrollNumbers } : { names: [payrollOf(mine[0]!)], payrollNumbers: [] };
    const ownSlips = slips.filter((s) => s.key === key);
    const payroll = ownSlips[0]?.payer || payrollOf(mine[0]!);
    const paid = matchEarned(mine, ownSlips);
    const paidBy = new Map<string, PayPeriod>();
    for (const [s, run] of paid) for (const f of run) paidBy.set(f.id, s);

    // How long after the work its pay comes: yours, else learned from the latest payslip that paid some.
    const yours = job?.payLagMonths ?? store.profile.employers?.find((e) => payerKey(e.name) === key)?.payLagMonths;
    const latestPaid = [...paid.entries()].sort(([a], [b]) => slipEnd(a).localeCompare(slipEnd(b))).at(-1);
    const learned = latestPaid ? monthsBetween(periodName(latestPaid[1].at(-1)!), slipEnd(latestPaid[0]).slice(0, 7)) : null;
    const lag = yours ?? learned;

    // The pay day: the day of the month this payroll's pay last reached the bank, else its payslip's date.
    const sorted = [...ownSlips].sort((a, b) => slipEnd(a).localeCompare(slipEnd(b)));
    const lastCredit = sorted.filter((s) => s.credit).at(-1)?.credit;
    const lastSlip = sorted.at(-1);
    const payDay = lastCredit ? Number(lastCredit.date.slice(8, 10)) : lastSlip?.payDate ? Number(lastSlip.payDate.slice(8, 10)) : 31;
    const nextSlipMonth = lastSlip ? addMonths(`${slipEnd(lastSlip).slice(0, 7)}-01`, 1).slice(0, 7) : null;
    // The names the bank gives this payroll's pay.
    const bankNames = new Set(sorted.filter((s) => s.credit).map((s) => payerKey(s.credit!.payee ?? s.credit!.counterpartyName ?? s.credit!.description)));

    const owed = mine.filter((f) => !paidBy.has(f.id));
    const groups = new Map<string, Figure[]>();
    for (const f of owed) {
      const due = lag === null ? '' : [addMonths(`${periodName(f)}-01`, lag).slice(0, 7), nextSlipMonth ?? ''].sort().at(-1)!;
      (groups.get(due) ?? groups.set(due, []).get(due)!).push(f);
    }
    const expected: ExpectedPay[] = [];
    for (const [month, run] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const gross = fromMinor(run.reduce((s, f) => s + toMinor(f.amount), 0));
      const payDate = month ? workingDay(dayOf(month, payDay)) : null;
      const latestWork = run.at(-1)!.periodEnd!;
      // Arrived before its payslip was imported: an unexplained payment from this payroll after the work.
      const arrived = unexplained
        .filter((t) => !used.has(t.id) && t.date > latestWork && (!payDate || t.date >= addDays(payDate, -15)) && (bankNames.has(payerKey(t.payee ?? t.counterpartyName ?? t.description)) || fromJob(t, who)))
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      if (arrived) used.add(arrived.id);
      const { apart, ...estimate } = estimateDeductions(ownSlips, gross, payDate ?? endOfMonth(now), run.map((f) => f.amount));
      expected.push({
        month: month || null,
        payDate,
        gross,
        periods: run.map((f) => f.periodEnd!),
        figureIds: run.map((f) => f.id),
        status: arrived ? 'arrived' : payDate && payDate < now ? 'late' : 'owed',
        ...(arrived ? { arrived: { amount: arrived.amount, date: arrived.date, transactionId: arrived.id, accountId: arrived.accountId } } : {}),
        estimate,
        apart,
      });
    }

    const periods: EarnedPeriod[] = mine.map((f) => {
      const s = paidBy.get(f.id);
      const group = expected.find((g) => g.figureIds.includes(f.id));
      // A £0 payslip that should have paid the work (the usual delay after it), but did not.
      const from = addMonths(`${periodName(f)}-01`, lag ?? 0).slice(0, 7);
      const skipped = !s ? sorted.filter((x) => x.gross !== null && toMinor(x.gross) === 0 && slipEnd(x) >= f.periodEnd! && slipEnd(x).slice(0, 7) >= from).map((x) => slipEnd(x).slice(0, 7)) : [];
      return {
        figureId: f.id,
        label: f.label,
        payer: f.payer ?? '',
        ...(f.work?.role ? { role: f.work.role } : {}),
        periodStart: f.periodStart ?? null,
        periodEnd: f.periodEnd!,
        amount: f.amount,
        ...(f.work?.daysWorked !== undefined ? { daysWorked: f.work.daysWorked } : {}),
        ...(f.work?.holidayDays !== undefined ? { holidayDays: f.work.holidayDays } : {}),
        ...(f.work?.hoursWorked !== undefined ? { hoursWorked: f.work.hoursWorked } : {}),
        ...(f.work?.rate !== undefined ? { rate: f.work.rate, ratePer: f.work.ratePer ?? 'day' } : {}),
        status: s ? 'paid' : group?.status ?? 'owed',
        ...(s ? { payslip: { periodEnd: s.periodEnd, payDate: s.payDate, gross: s.gross!, periods: paid.get(s)!.length, figureIds: s.figures.map((x) => x.id) } } : {}),
        ...(s?.credit ? { paidIn: { amount: s.credit.amount, date: s.credit.date, transactionId: s.credit.id, accountId: s.credit.accountId } } : {}),
        ...(group ? { expected: { month: group.month, payDate: group.payDate } } : {}),
        ...(skipped.length ? { note: `Not on the ${skipped.map((m) => formatMonth(m)).join(' or ')} payslip, which paid nothing` } : {}),
      };
    });
    out.push({
      key,
      ...(job ? { employmentId: job.id } : {}),
      payroll,
      timesheets: [...new Set(mine.map((f) => [f.payer, f.work?.role].filter(Boolean).join(', ')))],
      lag: { months: lag, source: yours !== undefined ? 'yours' : learned !== null ? 'learned' : null },
      periods,
      expected,
    });
  }
  return out;
}

/**
 * Pay owed and not yet in the bank, for the estate: shown beside it, never counted in it. Timesheet
 * work not yet paid (its tax and NI estimated), and payslips whose pay you said is owed to you (their
 * pay after deductions, as the payslip says).
 */
export function owedPay(payrolls: EarnedPayroll[], payslips: PayPeriod[] = []): OwedPay | null {
  const open: OwedPay['items'] = payrolls.flatMap((p) => p.expected.filter((e) => e.status !== 'arrived').map((e) => ({ payroll: p.payroll, gross: e.gross, net: e.estimate.net, payDate: e.payDate, periods: e.periods, status: e.status as 'owed' | 'late', kind: 'timesheet' as const })));
  for (const p of payslips) {
    if (!p.owed || p.credit || p.gross === null) continue;
    open.push({ payroll: p.payer, gross: p.gross, net: p.expectedNet, payDate: p.payDate, periods: p.periodEnd ? [p.periodEnd] : [], status: 'owed', kind: 'payslip' });
  }
  if (!open.length) return null;
  const gross = fromMinor(open.reduce((s, e) => s + toMinor(e.gross), 0));
  const nets = open.map((e) => e.net);
  // When the next should come: timesheet pay's expected pay date. A payslip's pay you said is owed
  // has no date to give: its own pay date has passed.
  const dates = open.flatMap((e) => (e.kind !== 'payslip' && e.payDate ? [e.payDate] : [])).sort();
  return {
    gross,
    net: nets.every((n): n is number => n !== null) ? fromMinor(nets.reduce((s, n) => s + toMinor(n), 0)) : null,
    next: dates[0] ?? null,
    late: open.some((e) => e.status === 'late'),
    items: open,
  };
}

/** Payslips whose pay you said is owed to you, in this tax year and the last, not yet arrived. */
export function owedPayslips(store: Store, now: ISODate = today()): PayPeriod[] {
  const ty = taxYearOf(now);
  return [taxYear(ty.startYear - 1), ty].flatMap((y) => pairPay(store, y).periods.filter((p) => p.owed && !p.credit));
}

/**
 * The payroll a timesheet's pay most likely comes through, for a draft: the one an earlier upload
 * of the same timesheet was linked to, else the one whose payslip paid exactly a run of its months.
 */
export function inferPayroll(store: Store, figures: Pick<DraftFigure, 'kind' | 'payer' | 'work' | 'periodEnd' | 'amount'>[]): Map<string, string> {
  const out = new Map<string, string>();
  const earned = figures.filter((f) => f.kind === 'earned_pay' && f.periodEnd);
  const stored = effectiveEarned(store.figures);
  for (const name of new Set(earned.map((f) => f.payer ?? ''))) {
    const role = payerKey(earned.find((f) => (f.payer ?? '') === name)?.work?.role);
    const before = stored.filter((x) => payerKey(x.payer) === payerKey(name) && x.paidBy && (!role || !x.work?.role || payerKey(x.work.role) === role)).at(-1);
    if (before?.paidBy) {
      out.set(name, before.paidBy);
      continue;
    }
    // A payslip whose gross is exactly a run of this timesheet's consecutive months, earlier uploads included.
    const months = [...stored.filter((x) => payerKey(x.payer) === payerKey(name)), ...earned.filter((f) => (f.payer ?? '') === name)]
      .map((f) => ({ end: f.periodEnd!, minor: toMinor(f.amount) }))
      .sort((a, b) => a.end.localeCompare(b.end))
      .filter((m, i, all) => i === 0 || m.end !== all[i - 1]!.end);
    const payers = new Set<string>();
    for (const g of store.figures.filter((x) => x.kind === 'gross_pay' && isPayslipFigure(store, x) && x.payer && toMinor(x.amount) > 0)) {
      const end = g.periodEnd ?? g.date ?? '';
      for (let i = 0; i < months.length; i++) {
        let sum = 0;
        for (let j = i; j < months.length && months[j]!.end <= end; j++) {
          sum += months[j]!.minor;
          if (sum === toMinor(g.amount)) payers.add(g.payer!);
          if (sum >= toMinor(g.amount)) break;
        }
      }
    }
    if (payers.size === 1) out.set(name, [...payers][0]!);
  }
  return out;
}
