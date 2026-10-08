// Pension money paid through payroll (docs/FORMULAS.md §11, "Payroll pensions"): what each payslip
// took for the pension and what the employer added on top, and the rows in a pension account that are
// that money arriving there. A row is a payslip's when it is your deduction and the employer's together,
// to the penny, arriving within two months of the pay date. The money then belongs to the payslip's
// tax year, split as the payslip splits it, whenever the provider invested it.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { addDays } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { Account, PayslipRecord, Transaction } from '../../shared/schema';
import { namesOf } from '../employments';
import type { Store } from '../store';
import { employerCostsOf } from './payslips';
import { payerKey } from './sources';

/** Days after a pay date within which its pension money arrives in the scheme. */
export const PAYROLL_ARRIVAL_DAYS = 62;
/** Days before a pay date a row may be dated: a scheme can date the money by the payroll's run. */
const EARLY_DAYS = 7;

const PENSION_LINE = /pension|superannuation|\bavc\b/i;
/** Rows that can be pension money arriving: contributions, the employer's, or not categorised yet. */
const ARRIVAL_CATEGORIES = new Set(['contribution', 'employer-contribution']);

/** One payslip's pension money, in pence. */
export interface PayslipPension {
  payslip: PayslipRecord;
  employmentId: string;
  employee: number;
  employer: number;
}

export interface PayrollPensions {
  /** Each payslip with pension money, oldest first. */
  slips: PayslipPension[];
  /** Rows in pension accounts that are a payslip's pension money arriving, by transaction id. */
  paired: Map<string, PayslipPension>;
  /** The pension account each job pays into, by job id. */
  accountOf: Map<string, string>;
}

/** Pension accounts money can be paid into (not a State Pension or a defined-benefit scheme). */
export const contributoryPension = (a: Account) => ACCOUNT_TYPE_META[a.type].pension && a.type !== 'state_pension' && a.type !== 'db_pension';

/** A job's payslips with pension money: the deduction lines it prints, and the employer's from its year to date. */
function slipsOf(store: Store, employmentId: string): PayslipPension[] {
  const all = store.payslips.filter((p) => p.employmentId === employmentId).sort((a, b) => a.payDate.localeCompare(b.payDate) || a.id.localeCompare(b.id));
  const out: PayslipPension[] = [];
  for (const year of new Set(all.map((p) => p.taxYear))) {
    const list = all.filter((p) => p.taxYear === year);
    list.forEach((p, i) => {
      const lines = p.deductions.filter((d) => PENSION_LINE.test(d.label));
      const previous = i > 0 ? list[i - 1]!.yearToDate.pension : 0;
      const employee = lines.length
        ? lines.reduce((s, d) => s + toMinor(d.amount), 0)
        : p.yearToDate.pension !== undefined && previous !== undefined
          ? toMinor(p.yearToDate.pension) - toMinor(previous)
          : 0;
      const employer = toMinor(employerCostsOf(list, i).pension ?? 0);
      if (employee > 0 || employer > 0) out.push({ payslip: p, employmentId, employee: Math.max(0, employee), employer: Math.max(0, employer) });
    });
  }
  return out;
}

/** Each payslip paired with the first unused row of its money in the window after its pay date. */
function pair(slips: PayslipPension[], rows: Transaction[], used: ReadonlyMap<string, unknown>): Map<string, PayslipPension> {
  const out = new Map<string, PayslipPension>();
  for (const s of slips) {
    const want = s.employee + s.employer;
    const from = addDays(s.payslip.payDate, -EARLY_DAYS);
    const to = addDays(s.payslip.payDate, PAYROLL_ARRIVAL_DAYS);
    const hit = rows.find((t) => !used.has(t.id) && !out.has(t.id) && t.date >= from && t.date <= to && toMinor(t.amount) === want);
    if (hit) out.set(hit.id, s);
  }
  return out;
}

/**
 * Which pension account each job pays into, and the rows there that are its payslips' money: the
 * account the job names (`pensionAccountId`), else the one that names the job (`pension.employer`),
 * else the one where its payslips' money arrives (two payslips paired, or its only one).
 */
export function payrollPensions(store: Store): PayrollPensions {
  const accounts = store.accounts.filter(contributoryPension);
  const rows = new Map(accounts.map((a) => [a.id, store.transactions(a.id).filter((t) => t.amount > 0 && !t.transferGroup && (!t.category || ARRIVAL_CATEGORIES.has(t.category)))]));
  const slips: PayslipPension[] = [];
  const paired = new Map<string, PayslipPension>();
  const accountOf = new Map<string, string>();
  for (const job of store.employments) {
    const own = slipsOf(store, job.id);
    if (!own.length) continue;
    slips.push(...own);
    const named = accounts.find((a) => a.id === job.pensionAccountId) ?? accounts.find((a) => a.pension?.employer && namesOf(job).some((n) => payerKey(n) === payerKey(a.pension!.employer)));
    const tries = (named ? [named] : accounts).map((a) => ({ a, hits: pair(own, rows.get(a.id) ?? [], paired) }));
    const best = tries.sort((x, y) => y.hits.size - x.hits.size)[0];
    if (!best) continue;
    if (!named && best.hits.size < Math.min(2, own.length)) continue;
    accountOf.set(job.id, best.a.id);
    for (const [id, s] of best.hits) paired.set(id, s);
  }
  return { slips, paired, accountOf };
}
