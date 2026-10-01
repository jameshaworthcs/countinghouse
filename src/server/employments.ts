// Jobs (employments.json): which job a document's pay figures and HMRC records are about, and what a
// job learns from them (docs/DATA_FORMAT.md, "employments.json"). A document names an employer as it
// pleases; a job is known by its PAYE reference first, then your payroll number there, then a name
// it has come under. Nothing here guesses beyond that: a name no job has is a new job, which you can
// change on the review page.

import { slugify } from '../shared/accounts';
import type { Employment, ExtractedHmrc, Figure, FigureKind } from '../shared/schema';
import { PAY_KINDS, payeReference, payerKey } from './analytics/sources';

/** Who a document says a job is with. */
export interface JobIdentity {
  employer: string;
  payeReference?: string | undefined;
  payrollNumber?: string | undefined;
}

/** Every name a job has come under. */
export const namesOf = (e: Pick<Employment, 'employer' | 'aliases'>) => [e.employer, ...e.aliases];

/** The job of yours a document's employer is, and what showed it. */
export function matchEmployment(employments: Employment[], who: JobIdentity): { employment: Employment; by: 'payeReference' | 'payrollNumber' | 'name' } | undefined {
  const ref = payeReference(who.payeReference);
  const key = payerKey(who.employer);
  const byName = (e: Employment) => Boolean(key) && namesOf(e).some((n) => payerKey(n) === key);
  if (ref) {
    const same = employments.filter((e) => e.payeReference === ref);
    // One reference can cover two jobs with one employer: the payroll number, else the name, tells them apart.
    const pick = same.find((e) => who.payrollNumber && e.payrollNumbers.includes(who.payrollNumber)) ?? same.find(byName) ?? (same.length === 1 ? same[0] : undefined);
    if (pick) return { employment: pick, by: 'payeReference' };
  }
  if (who.payrollNumber) {
    const pick = employments.find((e) => e.payrollNumbers.includes(who.payrollNumber!));
    if (pick) return { employment: pick, by: 'payrollNumber' };
  }
  const named = employments.filter(byName);
  // A name two jobs share (two spells with one employer) is not enough to say which.
  if (named.length === 1) return { employment: named[0]!, by: 'name' };
  return undefined;
}

/** What a job learns from a document that is about it: another name, its reference, a payroll number. */
export function learn(e: Employment, who: JobIdentity): Employment {
  const ref = payeReference(who.payeReference);
  const names = namesOf(e).map(payerKey);
  const aliases = who.employer && !names.includes(payerKey(who.employer)) ? [...e.aliases, who.employer] : e.aliases;
  const payrollNumbers = who.payrollNumber && !e.payrollNumbers.includes(who.payrollNumber) ? [...e.payrollNumbers, who.payrollNumber] : e.payrollNumbers;
  return { ...e, aliases, payrollNumbers, ...(ref && !e.payeReference ? { payeReference: ref } : {}) };
}

/** An id for a new job from its employer's name, not one taken already. */
export const newEmploymentId = (employer: string, taken: Iterable<string>) => slugify(employer.replace(/\b(ltd|limited|plc|llp)\b\.?/gi, ''), taken);

/**
 * Is a figure about a job? Pay, tax, NI and student loan with an employer named; a payslip's pension
 * deductions; earned pay, which is the payroll's that pays it. A pension statement's contributions
 * are its scheme's, and dividends and interest are no job's.
 */
export function jobOfFigure(f: Pick<Figure, 'kind' | 'payer' | 'payerReference' | 'paidBy'>, documentType: string | undefined): JobIdentity | null {
  const payslipPension = (f.kind === 'pension_contribution_employee' || f.kind === 'pension_contribution_employer') && documentType === 'payslip';
  if (f.kind === 'earned_pay') return f.paidBy || f.payer ? { employer: (f.paidBy ?? f.payer)! } : null;
  if (!(PAY_KINDS as readonly FigureKind[]).includes(f.kind) && !payslipPension) return null;
  if (!f.payer) return null;
  return { employer: f.payer, ...(f.payerReference ? { payeReference: f.payerReference } : {}) };
}

/** Is an HMRC record about a job? Its payments, details, codes, and the jobs it started or ended. */
export function jobOfHmrc(r: ExtractedHmrc): JobIdentity | null {
  switch (r.type) {
    case 'payment':
    case 'tax-code':
      return r.employer ? { employer: r.employer, payeReference: r.payeReference } : null;
    case 'employment':
      return r.employer ? { employer: r.employer, payeReference: r.payeReference, payrollNumber: r.payrollNumber } : null;
    case 'event':
      return (r.event === 'started' || r.event === 'ended') && r.employer ? { employer: r.employer } : null;
    default:
      return null;
  }
}
