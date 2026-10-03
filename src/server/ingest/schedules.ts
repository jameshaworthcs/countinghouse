// Schedules a document gives (extract-15, rule 24), drafted as the agreements they are: new ones, or
// what they add to one recorded already (new payments, their latest statuses). For UK student
// finance a schedule is also its student loan's own movements: each instalment it paid is money the
// loan lent you or paid for you (docs/INGESTION.md, "Schedules").

import { slugify } from '../../shared/accounts';
import { nameKey } from '../../shared/categorise';
import { maxDate, minDate, today, type ISODate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { AgreementSchema, type Account, type Agreement, type DraftAgreement, type ExtractedSchedule } from '../../shared/schema';
import { agreementView } from '../analytics/agreements';
import type { Store } from '../store';

/** Who runs UK student finance (Student Finance England, Wales and Northern Ireland, SAAS, the Student Loans Company). */
export const STUDENT_FINANCE = /\bSTUDENT\s+(?:FINANCE|LOANS?\s+COMPANY|AWARDS\s+AGENCY)\b|\bSLC\b|\bSAAS\b/i;

export const isStudentFinance = (s: Pick<ExtractedSchedule, 'provider'>) => STUDENT_FINANCE.test(s.provider);

/** An agreement as a document gives it, before it is recorded. */
export type ScheduleRecord = Omit<Agreement, 'createdBy' | 'createdAt' | 'updatedAt'>;

/**
 * The category a schedule's payments take, from what it is: student finance paid to you is
 * borrowing (a transfer from the loan); other money paid to you is other income; a payment made for
 * you to a university or college is its fees; rent, council tax, insurance and loans by their words.
 */
export function scheduleCategory(s: Pick<ExtractedSchedule, 'name' | 'provider' | 'paidTo' | 'direction'>): string {
  const text = `${s.name} ${s.provider} ${s.paidTo ?? ''}`;
  if (s.direction === 'to-you') return isStudentFinance(s) ? 'transfer' : 'other-income';
  if (/\bTUITION\b|\bCOURSE\b|\bFEES?\b/i.test(text) || (s.direction === 'to-other' && /\bUNIVERSITY\b|\bCOLLEGE\b/i.test(text))) return 'courses';
  if (/\bRENT\b|ACCOMMODATION|TENANCY|\bLET\b|\bROOM\b|\bHALLS?\b/i.test(text)) return 'rent';
  if (/COUNCIL TAX/i.test(text)) return 'council-tax';
  if (/INSURANCE/i.test(text)) return 'insurance';
  if (/\bLOAN\b|PAYMENT PLAN|CREDIT AGREEMENT|FINANCE AGREEMENT/i.test(text)) return 'loan-repayment';
  return 'other-expense';
}

/**
 * A payment's label, unless all it says is its status: a reader gives the status column's words as
 * the label when the schedule names its payments no other way ("Paid - We've paid you").
 */
export function paymentLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  return /^\s*\(?\s*(?:paid|due|ready to be paid|awaiting(?: confirmation)?|expected|scheduled|planned|cancelled)\b|we'?ve paid/i.test(label) ? undefined : label;
}

/** Your student loan: the one open, else the open one Student Finance runs. */
export function studentLoanAccount(store: Store): Account | undefined {
  const loans = store.accounts.filter((a) => a.type === 'student_loan' && a.status !== 'closed');
  return loans.length === 1 ? loans[0] : loans.find((a) => a.institutionId === 'slc');
}

/**
 * The agreement a schedule is. Student finance's lends or pays through your student loan
 * (`loanAccountId`); one paid to someone else for you is that someone's, paid by the provider.
 */
export function scheduleRecord(s: ExtractedSchedule, opts: { loanAccountId?: string | undefined; statusAsOf: ISODate }): ScheduleRecord {
  const dues = s.payments.map((p) => p.date).sort();
  const toOther = s.direction === 'to-other';
  const name = /\b\d{4}\b/.test(s.name) ? s.name : `${s.name} ${dues[0]!.slice(0, 4)}`;
  const until = s.until ?? dues.at(-1);
  const through = isStudentFinance(s) && s.direction !== 'from-you' ? opts.loanAccountId : undefined;
  return {
    id: slugify(name).slice(0, 60) || 'schedule',
    name: name.slice(0, 160),
    counterparty: (toOther ? (s.paidTo ?? s.provider) : s.provider).slice(0, 200),
    // The names student finance's payments carry in a bank's words ("BANK GIRO CREDIT REF SLC DISBURSEMENTS").
    names: isStudentFinance(s) && s.direction === 'to-you' ? ['SLC', 'Student Loans Company', 'Student Finance'] : [],
    category: scheduleCategory(s),
    ...(s.direction === 'to-you' ? { direction: 'in' as const } : {}),
    ...(through ? { accountId: through } : {}),
    ...(toOther ? { paidBy: s.provider.slice(0, 200) } : {}),
    from: s.from ?? dues[0]!,
    ...(until ? { until } : {}),
    ...(s.total !== undefined ? { total: s.total } : {}),
    payments: s.payments.map((p) => {
      const label = paymentLabel(p.label);
      return { due: p.date, amount: p.amount, ...(label ? { label } : {}), ...(p.status ? { status: p.status } : {}) };
    }),
    details: s.details,
    ...(s.reference ? { reference: s.reference } : {}),
    statusAsOf: opts.statusAsOf,
    source: {},
  };
}

const paymentKey = (p: { due: string; amount: number }) => `${p.due}|${toMinor(p.amount)}`;
const directionOf = (a: Pick<Agreement, 'direction'>) => a.direction ?? 'out';

/** The agreement recorded already that a schedule is: the same way round, with the same counterparty, and the same name or a payment in common. */
export function recordedAs(agreements: readonly Agreement[], rec: ScheduleRecord): Agreement | undefined {
  const keys = new Set(rec.payments.map(paymentKey));
  return agreements.find((a) => directionOf(a) === directionOf(rec) && nameKey(a.counterparty) === nameKey(rec.counterparty) && (nameKey(a.name) === nameKey(rec.name) || a.payments.some((p) => keys.has(paymentKey(p)))));
}

/**
 * A schedule laid over the agreement recorded already: payments it does not have are added, and a
 * payment's status is the one its latest document gives (by `statusAsOf`). Everything the record
 * has stays; what it lacks (a total, a reference, details) is filled in.
 */
export function mergeSchedule(base: Agreement, rec: ScheduleRecord): { merged: ScheduleRecord; adds: { payments: number; statuses: number } } {
  const newer = !base.statusAsOf || rec.statusAsOf === undefined || rec.statusAsOf >= base.statusAsOf;
  const payments = base.payments.map((p) => ({ ...p }));
  let added = 0;
  let statuses = 0;
  for (const p of rec.payments) {
    const there = payments.find((x) => paymentKey(x) === paymentKey(p));
    if (!there) {
      payments.push({ ...p });
      added++;
      continue;
    }
    if (p.status && p.status !== there.status && newer) {
      there.status = p.status;
      statuses++;
    }
    if (p.label && !there.label) there.label = p.label;
  }
  payments.sort((a, b) => a.due.localeCompare(b.due));
  const { createdBy: _c, createdAt: _a, updatedAt: _u, ...kept } = base;
  const statusAsOf = maxDate(base.statusAsOf, rec.statusAsOf);
  const until = maxDate(base.until, rec.until);
  const merged: ScheduleRecord = {
    ...kept,
    from: minDate(base.from, rec.from) ?? base.from,
    ...(until ? { until } : {}),
    payments,
    details: [...base.details, ...rec.details.filter((d) => !base.details.some((x) => x.label === d.label))].slice(0, 40),
    ...(base.total === undefined && rec.total !== undefined ? { total: rec.total } : {}),
    ...(!base.reference && rec.reference ? { reference: rec.reference } : {}),
    ...(!base.accountId && rec.accountId ? { accountId: rec.accountId } : {}),
    ...(!base.paidBy && rec.paidBy ? { paidBy: rec.paidBy } : {}),
    ...(statusAsOf ? { statusAsOf } : {}),
  };
  return { merged, adds: { payments: added, statuses } };
}

/** A schedule record as a whole agreement, to check against your payments before it is recorded. */
export const asAgreement = (rec: ScheduleRecord, stamp = `${today()}T00:00:00Z`): Agreement => AgreementSchema.parse({ ...rec, createdBy: 'owner', createdAt: stamp, updatedAt: stamp });

/**
 * A document's schedules as draft agreements: each one new, or filling in the one recorded already
 * (ticked only when it adds a payment or a newer status), with the recorded payments it explains.
 */
export function draftAgreements(store: Store, schedules: readonly ExtractedSchedule[], opts: { loanAccountId?: string | undefined; statusAsOf: ISODate; now?: ISODate }): DraftAgreement[] {
  const now = opts.now ?? today();
  const taken = new Set(store.agreements.map((a) => a.id));
  return schedules.map((s, i) => {
    const rec = scheduleRecord(s, opts);
    const existing = recordedAs(store.agreements, rec);
    let record: ScheduleRecord;
    let adds: DraftAgreement['adds'];
    if (existing) {
      const m = mergeSchedule(existing, rec);
      record = m.merged;
      adds = m.adds;
    } else {
      let id = rec.id;
      for (let n = 2; taken.has(id); n++) id = `${rec.id.slice(0, 56)}-${n}`;
      taken.add(id);
      record = { ...rec, id };
    }
    const view = agreementView(store, asAgreement(record), now);
    const explains = view.payments.flatMap((p, index) => (p.paid ? [{ index, transactionId: p.paid.transactionId, accountId: p.paid.accountId, date: p.paid.date, amount: p.paid.amount }] : []));
    return {
      key: `a${i}`,
      include: !existing || (adds !== undefined && adds.payments + adds.statuses > 0),
      target: existing ? { mode: 'existing' as const, agreementId: existing.id } : { mode: 'new' as const },
      record,
      ...(adds ? { adds } : {}),
      explains,
    };
  });
}
