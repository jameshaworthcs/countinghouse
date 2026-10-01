// Payslips in full (payslips.jsonl) in the calculations (FORMULAS.md §17, "Payslips in full"): the
// payslip a pay period's figures came from, the year to date it prints, and what that shows of
// payslips not imported.

import { fromMinor, toMinor } from '../../shared/money';
import type { Figure, PayslipRecord, PayslipYtdKey } from '../../shared/schema';
import type { TaxYear } from '../../shared/uk';
import type { Store } from '../store';

/**
 * The payslip record a pay period's figures came from: its import's, for that period; for figures
 * from no import, the job's payslip for the same period.
 */
export function payslipOf(store: Store, figures: Figure[]): PayslipRecord | undefined {
  const first = figures[0];
  if (!first) return undefined;
  const end = first.periodEnd ?? first.date;
  const importId = first.source.importId;
  if (!importId) return first.employmentId ? store.payslips.find((p) => !p.source.importId && p.employmentId === first.employmentId && (p.periodEnd ?? p.payDate) === end) : undefined;
  const of = store.payslips.filter((p) => p.source.importId === importId);
  if (of.length <= 1) return of[0];
  return of.find((p) => (p.periodEnd ?? p.payDate) === end);
}

/** A job's payslips in a tax year, oldest first. */
export function jobPayslips(store: Store, employmentId: string, ty: TaxYear): PayslipRecord[] {
  return store.payslips.filter((p) => p.employmentId === employmentId && p.taxYear === ty.label).sort((a, b) => a.payDate.localeCompare(b.payDate) || a.id.localeCompare(b.id));
}

/** Pay the year-to-date column shows that no imported payslip has: before the first, or between two. */
export interface PayslipGap {
  /** The payslip before the gap (none: the gap is before the first imported this year). */
  after?: PayslipRecord;
  /** The payslip whose year to date shows it. */
  before: PayslipRecord;
  /** The pay missing. */
  amount: number;
}

/**
 * A payroll's year to date of pay is the sum of its payslips this year. So the first payslip's,
 * less its own pay, is pay on payslips before it; and a rise between two that is more than the later
 * one's pay is pay on payslips between them. A fall (a new tax year, a refund) shows nothing.
 */
export function payslipGaps(list: PayslipRecord[]): PayslipGap[] {
  const gaps: PayslipGap[] = [];
  let previous: PayslipRecord | undefined;
  for (const p of list) {
    const ytd = p.yearToDate.gross;
    const pay = p.totals.payments;
    // The year to date before this payslip: none before the first; unknown when the one before does not print it.
    const before = previous ? previous.yearToDate.gross : 0;
    if (ytd !== undefined && pay !== undefined && before !== undefined) {
      const missing = toMinor(ytd) - toMinor(pay) - toMinor(before);
      if (missing > 0) gaps.push({ ...(previous ? { after: previous } : {}), before: p, amount: fromMinor(missing) });
    }
    previous = p;
  }
  return gaps;
}

/**
 * What the employer paid on top in a payslip's period: as printed, else from the year to date: the
 * whole of it on the year's first payslip (with no pay before it), else the rise from the payslip
 * before it, when nothing is missing between them.
 */
export function employerCostsOf(list: PayslipRecord[], i: number): { ni?: number; pension?: number } {
  const p = list[i]!;
  const gaps = payslipGaps(list.slice(0, i + 1));
  const whole = gaps.every((g) => g.before.id !== p.id);
  const previous = i > 0 ? list[i - 1] : undefined;
  const fromYtd = (key: PayslipYtdKey): number | undefined => {
    const now = p.yearToDate[key];
    if (now === undefined || !whole) return undefined;
    if (!previous) return now;
    const then = previous.yearToDate[key];
    return then === undefined ? undefined : fromMinor(toMinor(now) - toMinor(then));
  };
  const ni = p.employerCosts.ni ?? fromYtd('niEmployer');
  const pension = p.employerCosts.pension ?? fromYtd('pensionEmployer');
  return { ...(ni !== undefined ? { ni } : {}), ...(pension !== undefined ? { pension } : {}) };
}

/** The year-to-date key that states a figure kind for the year, as a P60 does (pay is taxable pay). */
export const YTD_OF: Partial<Record<Figure['kind'], PayslipYtdKey[]>> = {
  gross_pay: ['taxable', 'gross'],
  tax_deducted: ['tax'],
  national_insurance: ['ni'],
  student_loan_deducted: ['studentLoan'],
  pension_contribution_employee: ['pension'],
  pension_contribution_employer: ['pensionEmployer'],
};

/** A payslip's year to date of a figure kind, when it prints it. */
export function ytdOf(p: PayslipRecord, kind: Figure['kind']): number | undefined {
  for (const key of YTD_OF[kind] ?? []) if (p.yearToDate[key] !== undefined) return p.yearToDate[key];
  return undefined;
}

/**
 * A job's year so far of a figure kind by the payroll's own count: the year to date on its latest
 * payslip that prints it, plus that kind's figures from payslips paid after it that have no record
 * (a scan read by Claude). Undefined when no payslip prints it.
 */
export function yearSoFar(store: Store, employmentId: string, ty: TaxYear, kind: Figure['kind'], payslipFigures: Figure[]): { amount: number; asOf: string; payslip: PayslipRecord } | undefined {
  const latest = jobPayslips(store, employmentId, ty)
    .filter((p) => ytdOf(p, kind) !== undefined)
    .at(-1);
  if (!latest) return undefined;
  const later = payslipFigures.filter((f) => f.employmentId === employmentId && f.kind === kind && (f.date ?? f.periodEnd ?? '') > latest.payDate && !payslipOf(store, [f]));
  const amount = fromMinor(toMinor(ytdOf(latest, kind)!) + later.reduce((x, f) => x + toMinor(f.amount), 0));
  const asOf = [latest.payDate, ...later.map((f) => f.date ?? f.periodEnd ?? '')].sort().at(-1)!;
  return { amount, asOf, payslip: latest };
}
