// A company's books (companies.json, `books`): its periods and what it must file and pay by when,
// worked out from its dates and the UK rules (shared/uk.ts, "Companies"), and checked against what it
// has filed. Pure: no store, no clock (today is passed in). docs/FORMULAS.md §22, "Company books".
//
// Company deadlines are the company's, never yours: they are served from the company's own routes
// (routes/company-books.ts) and never join a personal figure or route (DECISIONS 2026-11-26).

import type { Alert } from './api';
import { addDays, diffDays, formatDate, formatSpan, type ISODate } from './dates';
import { DEADLINE_LEAD_DAYS, DEADLINE_WARN_DAYS } from './deadlines';
import { FIXED_ASSET_CLASS_META } from './ledger';
import { toMinor } from './money';
import type { Company, CompanyBooksSetup, CompanyFiling, CompanyFilingKind } from './schema';
import {
  ACCOUNTING_PERIOD_RULES,
  accountsFilingDeadline,
  confirmationStatementDue,
  ct600Due,
  CT_PERIOD_RULES,
  ctPaymentDue,
  defaultAccountingReferenceDate,
  firstAccountingPeriodEnd,
  lastDayOfMonths,
  longerThanMonths,
  monthsAfter,
  nextAccountingPeriodEnd,
  vatPeriodEnd,
  vatReturnDue,
  type VatStagger,
} from './uk';

/** A period worked out here, or one you (or HMRC's notice) set. */
export interface BooksPeriod {
  start: ISODate;
  end: ISODate;
  source: 'worked-out' | 'yours';
}

/** A Corporation Tax accounting period, with the period of account its last day falls in (FA 1998 Sch 18 para 14(2)). */
export interface CtPeriod extends BooksPeriod {
  periodOfAccount: { start: ISODate; end: ISODate };
}

/** A VAT period, by the stagger in force when it began, and the return filed for it. */
export interface VatPeriod {
  start: ISODate;
  end: ISODate;
  stagger: VatStagger;
  filing?: CompanyFiling;
}

export type DeadlineStatus = 'done' | 'upcoming' | 'due-soon' | 'overdue';

/** One thing a company must file or pay, by when, and whether a filing recorded here does it. */
export interface CompanyDeadline {
  /** `kind:period end`: one per kind and period (an unmatched filing's is `kind:period end:filing id`). */
  id: string;
  kind: CompanyFilingKind;
  period: { start?: ISODate; end: ISODate };
  due: ISODate;
  /** done: a filing recorded here does it; overdue: past its day; due-soon: within 60 days (`DEADLINE_LEAD_DAYS`); upcoming: later. */
  status: DeadlineStatus;
  /** Days from today to the due day (negative: since). */
  days: number;
  title: string;
  /** Who it goes to. */
  to: 'Companies House' | 'HMRC';
  /** The rule its day comes from, in short. */
  rule: string;
  filing?: CompanyFiling;
  /** Filed (or paid) after its due day. */
  filedLate?: boolean;
  /** A filing that matches no period worked out here: listed so nothing you recorded is hidden. */
  unmatched?: true;
  /** Corporation Tax done because there is nothing to pay: a £0 payment recorded, or its CT600 saying so. */
  nothingToPay?: true;
}

/** Periods are listed this far: up to the one containing the day given. A guard against a loop on a hand-edited record. */
const MAX_PERIODS = 600;

const byStart = <T extends { start: ISODate }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.start.localeCompare(b.start));

/**
 * Accounting reference periods (CA 2006 ss391–392) from incorporation up to the one containing `until`:
 * the first to the reference date (yours, or the default), then 12 months at a time; a period you set
 * (one shortened or extended) is used as it is, the one before it ending the day before it starts, and
 * the next ones following on from its end (its end is the new reference date).
 */
export function accountingPeriodsOf(books: Pick<CompanyBooksSetup, 'incorporatedOn' | 'accountingReferenceDate' | 'periods'>, until: ISODate): BooksPeriod[] {
  const yours = byStart(books.periods);
  const ard = books.accountingReferenceDate ?? defaultAccountingReferenceDate(books.incorporatedOn);
  const out: BooksPeriod[] = [];
  let cursor = books.incorporatedOn;
  let prevEnd: ISODate | undefined;
  while (cursor <= until && out.length < MAX_PERIODS) {
    const own = yours.find((p) => p.start <= cursor && p.end >= cursor);
    let end: ISODate;
    if (own) end = own.end;
    else {
      end = prevEnd ? nextAccountingPeriodEnd(prevEnd) : firstAccountingPeriodEnd(books.incorporatedOn, ard);
      const next = yours.find((p) => p.start > cursor);
      if (next && next.start <= end) end = addDays(next.start, -1);
    }
    out.push({ start: cursor, end, source: own ? 'yours' : 'worked-out' });
    prevEnd = end;
    cursor = addDays(end, 1);
  }
  return out;
}

/**
 * When the company came within the charge to Corporation Tax (CTA 2009 s9: carrying on business or a
 * source of income, such as interest; not only trade), as far as the books say: the day given; none
 * when it is dormant for Corporation Tax (null); from incorporation when not given, an assumption the
 * company's page labels (`withinChargeAssumed`).
 */
export function withinChargeFrom(books: Pick<CompanyBooksSetup, 'incorporatedOn' | 'withinChargeFrom'>): ISODate | undefined {
  return books.withinChargeFrom === null ? undefined : (books.withinChargeFrom ?? books.incorporatedOn);
}

/** Whether the day it came within the charge is the assumed one (incorporation), not one the books give. */
export function withinChargeAssumed(books: Pick<CompanyBooksSetup, 'withinChargeFrom'>): boolean {
  return books.withinChargeFrom === undefined;
}

/**
 * Corporation Tax accounting periods (CTA 2009 ss9–10) up to the one containing `until`: from the day
 * the company came within the charge (`withinChargeFrom`), each ending on the first of 12 months from
 * its beginning, the end of its period of account, and the day before it started to trade (s10(1)(d));
 * periods you set (HMRC's notice) are used as they are, the one before ending the day before. Dormant
 * for Corporation Tax (null): only the periods you set.
 */
export function ctPeriodsOf(books: Pick<CompanyBooksSetup, 'incorporatedOn' | 'accountingReferenceDate' | 'periods' | 'tradeStartedOn' | 'withinChargeFrom' | 'ctPeriods'>, until: ISODate): CtPeriod[] {
  const yours = byStart(books.ctPeriods);
  const start = withinChargeFrom(books);
  const trade = books.tradeStartedOn ?? undefined;
  const first = [start, yours[0]?.start].filter((d): d is ISODate => Boolean(d)).sort()[0];
  if (!first) return [];
  // Periods of account far enough on for the last CT period's own (one you set can end later).
  const lastYours = yours.at(-1)?.end;
  const poas = accountingPeriodsOf(books, lastYours && lastYours > until ? lastYours : until);
  const poaOf = (d: ISODate) => poas.find((p) => p.start <= d && p.end >= d);
  const out: CtPeriod[] = [];
  let cursor = first;
  while (cursor <= until && out.length < MAX_PERIODS) {
    const own = yours.find((p) => p.start <= cursor && p.end >= cursor);
    let end: ISODate;
    if (own) end = own.end;
    else {
      // Not within the charge here: on to the next period you set, or to the day it came within it.
      if (!start || cursor < start) {
        const next = [yours.find((p) => p.start > cursor)?.start, start && start > cursor ? start : undefined].filter((d): d is ISODate => Boolean(d)).sort()[0];
        if (!next) break;
        cursor = next;
        continue;
      }
      const poa = poaOf(cursor);
      if (!poa) break;
      end = lastDayOfMonths(cursor, CT_PERIOD_RULES.maxMonths);
      if (poa.end < end) end = poa.end;
      // Starting to trade ends a period (s10(1)(d)): the next begins on the day it started.
      if (trade && trade > cursor && trade <= end) end = addDays(trade, -1);
      const next = yours.find((p) => p.start > cursor);
      if (next && next.start <= end) end = addDays(next.start, -1);
    }
    const poa = poaOf(end);
    out.push({ start: cursor, end, source: own ? 'yours' : 'worked-out', periodOfAccount: poa ? { start: poa.start, end: poa.end } : { start: cursor, end } });
    cursor = addDays(end, 1);
  }
  return out;
}

/** The stagger in force on a day: the latest schedule entry from then or before (the first before any). */
function staggerOn(schedule: NonNullable<CompanyBooksSetup['vat']>['schedule'], d: ISODate): VatStagger {
  let s = schedule[0]!.stagger;
  for (const e of [...schedule].sort((a, b) => a.from.localeCompare(b.from))) if (e.from <= d) s = e.stagger;
  return s;
}

/**
 * VAT periods (VAT Regulations 1995 reg 25(1)) from registration up to the one containing `until` (or
 * the deregistration day): the first from the registration day to `firstPeriodEnd` or its stagger's
 * period end; then by the stagger in force, the annual year running 12 months from its schedule entry;
 * a schedule change starts a period on its day. A filed return's own period wins: one that starts on a
 * period's first day, or (with no start) ends within the period, sets where it ends.
 */
export function vatPeriodsOf(books: Pick<CompanyBooksSetup, 'vat'> & { filings?: readonly CompanyFiling[] }, until: ISODate): VatPeriod[] {
  const vat = books.vat;
  if (!vat?.schedule.length) return [];
  const schedule = [...vat.schedule].sort((a, b) => a.from.localeCompare(b.from));
  const filed = sortFilings((books.filings ?? []).filter((f) => f.kind === 'vat'));
  const used = new Set<string>();
  const last = vat.deregisteredOn && vat.deregisteredOn < until ? vat.deregisteredOn : until;
  const out: VatPeriod[] = [];
  let cursor = vat.registeredFrom;
  while (cursor <= last && out.length < MAX_PERIODS) {
    const stagger = staggerOn(schedule, cursor);
    let end: ISODate;
    if (cursor === vat.registeredFrom && vat.firstPeriodEnd && vat.firstPeriodEnd >= cursor) end = vat.firstPeriodEnd;
    else if (stagger === 'annual') {
      // 12-month years from the day annual accounting began.
      let yearStart = [...schedule].reverse().find((e) => e.from <= cursor)?.from ?? vat.registeredFrom;
      end = lastDayOfMonths(yearStart, 12);
      while (end < cursor) {
        yearStart = addDays(end, 1);
        end = lastDayOfMonths(yearStart, 12);
      }
    } else end = vatPeriodEnd(stagger, cursor);
    const change = schedule.find((e) => e.from > cursor);
    if (change && change.from <= end) end = addDays(change.from, -1);
    if (vat.deregisteredOn && vat.deregisteredOn < end) end = vat.deregisteredOn;
    const filing = filed.find((f) => !used.has(f.id) && (f.periodStart ? f.periodStart === cursor && f.periodEnd >= cursor : f.periodEnd >= cursor && f.periodEnd <= end));
    if (filing) {
      used.add(filing.id);
      end = filing.periodEnd;
    }
    out.push({ start: cursor, end, stagger, ...(filing ? { filing } : {}) });
    cursor = addDays(end, 1);
  }
  return out;
}

/** Filings in a fixed order (by period end, start, id): what matches does not depend on the order they were recorded in. */
function sortFilings<T extends CompanyFiling>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || (a.periodStart ?? '').localeCompare(b.periodStart ?? '') || a.id.localeCompare(b.id));
}

/** The first review period's end and the made-up dates after it (CA 2006 s853A(5)–(6)). */
function nextReviewEnd(start: ISODate): ISODate {
  return lastDayOfMonths(start, 12);
}

const KIND_ORDER: Record<CompanyFilingKind, number> = { accounts: 0, confirmation: 1, ct600: 2, 'ct-payment': 3, vat: 4 };

/** The status of a deadline on `today`. */
export function deadlineStatus(due: ISODate, today: ISODate, done: boolean): DeadlineStatus {
  if (done) return 'done';
  const days = diffDays(today, due);
  return days < 0 ? 'overdue' : days <= DEADLINE_LEAD_DAYS ? 'due-soon' : 'upcoming';
}

/**
 * Every deadline of a company you keep the books of, as on `today` (FORMULAS.md §22, "Deadlines"): its
 * accounts and confirmation statements at Companies House, and its CT600s, Corporation Tax and VAT
 * returns at HMRC, from incorporation (or registration) up to the periods containing today, and the
 * next confirmation statement. Each is done when a filing recorded here matches it (its kind and
 * period); filed after its day, it is marked late. A filing matching none is listed too. Those due
 * before `deadlinesFrom` and not done are left out. Sorted by due day.
 */
export function companyDeadlines(company: Pick<Company, 'books'>, today: ISODate): CompanyDeadline[] {
  const books = company.books;
  if (!books) return [];
  const filings = sortFilings(books.filings);
  const used = new Set<string>();
  const out: CompanyDeadline[] = [];
  const take = (kind: CompanyFilingKind, test: (f: CompanyFiling) => boolean) => {
    const f = filings.find((x) => x.kind === kind && !used.has(x.id) && test(x));
    if (f) used.add(f.id);
    return f;
  };
  const push = (d: Omit<CompanyDeadline, 'id' | 'status' | 'days' | 'filedLate'> & { id?: string }) => {
    const done = Boolean(d.filing);
    out.push({
      ...d,
      id: d.id ?? `${d.kind}:${d.period.end}`,
      status: deadlineStatus(d.due, today, done),
      days: diffDays(today, d.due),
      // Late only against a day worked out for it: an unmatched filing's day is a guess.
      ...(d.filing && !d.nothingToPay && !d.unmatched && d.filing.filedOn > d.due ? { filedLate: true } : {}),
    });
  };

  // Accounts, to Companies House (CA 2006 s442).
  const periods = accountingPeriodsOf(books, today);
  for (const p of periods) {
    const filing = take('accounts', (f) => f.periodEnd === p.end);
    const first = p.start === books.incorporatedOn && longerThanMonths(p.start, p.end, 12);
    push({ kind: 'accounts', period: { start: p.start, end: p.end }, due: accountsFilingDeadline(p, books.incorporatedOn), title: `Accounts to ${formatDate(p.end)}`, to: 'Companies House', rule: first ? 'CA 2006 s442(3)' : 'CA 2006 s442(2)(a)', ...(filing ? { filing } : {}) });
  }

  // Corporation Tax: its return and its payment, for each accounting period (FA 1998 Sch 18 para 14; TMA 1970 s59D).
  for (const ap of ctPeriodsOf(books, today)) {
    const span = formatSpan(ap.start, ap.end);
    const ct600 = take('ct600', (f) => f.periodEnd === ap.end);
    push({ kind: 'ct600', period: { start: ap.start, end: ap.end }, due: ct600Due(ap, ap.periodOfAccount), title: `Corporation Tax return (CT600) for ${span}`, to: 'HMRC', rule: 'FA 1998 Sch 18 para 14', ...(ct600 ? { filing: ct600 } : {}) });
    const paid = take('ct-payment', (f) => f.periodEnd === ap.end);
    // Nothing to pay: a payment of £0 you recorded, or its CT600 saying so. Never late.
    const zero = paid?.kind === 'ct-payment' && paid.figures?.amount === 0;
    const nothing = !paid && ct600?.kind === 'ct600' && ct600.figures?.taxPayable === 0 ? ct600 : undefined;
    push({ kind: 'ct-payment', period: { start: ap.start, end: ap.end }, due: ctPaymentDue(ap.end), title: `Corporation Tax for ${span}`, to: 'HMRC', rule: 'TMA 1970 s59D', ...(paid ? { filing: paid, ...(zero ? { nothingToPay: true as const } : {}) } : nothing ? { filing: nothing, nothingToPay: true as const } : {}) });
  }

  // VAT returns (VAT Regulations 1995 regs 25, 25A(20) and 50).
  for (const v of vatPeriodsOf({ vat: books.vat, filings }, today)) {
    if (v.filing) used.add(v.filing.id);
    push({ kind: 'vat', period: { start: v.start, end: v.end }, due: vatReturnDue(v, v.stagger), title: `VAT return for ${formatSpan(v.start, v.end)}`, to: 'HMRC', rule: v.stagger === 'annual' ? 'VAT Regulations 1995 reg 50(2)(b)' : 'VAT Regulations 1995 regs 25(1), 25A(20)', ...(v.filing ? { filing: v.filing } : {}) });
  }

  // Confirmation statements (CA 2006 s853A): review periods from incorporation, or from the next
  // made-up date Companies House shows; each statement made up within its review period does it, and an
  // earlier made-up date starts the next review period the day after.
  const confirmations = filings.filter((f) => f.kind === 'confirmation');
  let reviewStart = books.incorporatedOn;
  let reviewEnd = nextReviewEnd(books.incorporatedOn);
  const anchor = books.confirmationStatement?.nextMadeUpTo;
  if (anchor && anchor > books.incorporatedOn) {
    reviewEnd = anchor;
    const start = addDays(monthsAfter(anchor, -12), 1);
    reviewStart = start > books.incorporatedOn ? start : books.incorporatedOn;
    // Statements made up before the review period Companies House shows next are settled: each its own,
    // due 14 days after the review period it falls in, those counted back a year at a time from it.
    for (const f of confirmations) {
      if (f.periodEnd >= reviewStart) break;
      let end = monthsAfter(anchor, -12);
      for (let k = 2; monthsAfter(anchor, -12 * k) >= f.periodEnd && k < MAX_PERIODS; k++) end = monthsAfter(anchor, -12 * k);
      used.add(f.id);
      push({ kind: 'confirmation', period: { end: f.periodEnd }, due: confirmationStatementDue(end), title: `Confirmation statement made up to ${formatDate(f.periodEnd)}`, to: 'Companies House', rule: 'CA 2006 s853A(1)', filing: f });
    }
  }
  for (let i = 0; i < MAX_PERIODS; i++) {
    const filing = confirmations.find((f) => !used.has(f.id) && f.periodEnd >= reviewStart && f.periodEnd <= reviewEnd);
    if (filing) used.add(filing.id);
    const madeUpTo = filing?.periodEnd ?? reviewEnd;
    // Due 14 days after the review period ends (s853A(1)), even for one made up early.
    const due = confirmationStatementDue(reviewEnd);
    push({ kind: 'confirmation', period: { start: reviewStart, end: madeUpTo }, due, title: `Confirmation statement made up to ${formatDate(madeUpTo)}`, to: 'Companies House', rule: 'CA 2006 s853A(1)', ...(filing ? { filing } : {}) });
    if (!filing && due >= today) break;
    reviewStart = addDays(madeUpTo, 1);
    reviewEnd = nextReviewEnd(reviewStart);
  }

  // What was filed but matches nothing worked out here (a period set otherwise, a date mistyped).
  for (const f of filings) {
    if (used.has(f.id)) continue;
    const period = { ...(f.periodStart ? { start: f.periodStart } : {}), end: f.periodEnd };
    const due =
      f.kind === 'accounts'
        ? monthsAfter(f.periodEnd, 9)
        : f.kind === 'ct600'
          ? monthsAfter(f.periodEnd, 12)
          : f.kind === 'ct-payment'
            ? ctPaymentDue(f.periodEnd)
            : f.kind === 'vat'
              ? vatReturnDue({ start: f.periodStart ?? f.periodEnd, end: f.periodEnd }, books.vat ? staggerOn(books.vat.schedule, f.periodStart ?? f.periodEnd) : 'quarterly-1')
              : confirmationStatementDue(f.periodEnd);
    push({ id: `${f.kind}:${f.periodEnd}:${f.id}`, kind: f.kind, period, due, title: `${FILING_KIND_LABELS[f.kind]} for ${f.periodStart ? formatSpan(f.periodStart, f.periodEnd) : `the period to ${formatDate(f.periodEnd)}`}`, to: f.kind === 'accounts' || f.kind === 'confirmation' ? 'Companies House' : 'HMRC', rule: 'Matches no period worked out here: check its dates, and the periods in the settings', filing: f, unmatched: true });
  }

  const from = books.deadlinesFrom;
  return out.filter((d) => !from || d.status === 'done' || d.due >= from).sort((a, b) => a.due.localeCompare(b.due) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.period.end.localeCompare(b.period.end));
}

/** How often VAT returns are made, in words. */
export const VAT_STAGGER_LABELS: Record<VatStagger, string> = {
  monthly: 'Monthly',
  'quarterly-1': 'Quarterly, to March, June, September and December (stagger 1)',
  'quarterly-2': 'Quarterly, to April, July, October and January (stagger 2)',
  'quarterly-3': 'Quarterly, to May, August, November and February (stagger 3)',
  annual: 'Yearly (annual accounting)',
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** An accounting reference date in words: "31 March"; the last day of February says so. */
export function formatMonthDay(md: string): string {
  const [m, d] = md.split('-').map(Number) as [number, number];
  return m === 2 && d >= 28 ? 'the last day of February' : `${d} ${MONTH_NAMES[m - 1] ?? '?'}`;
}

/** What each kind of filing is called. */
export const FILING_KIND_LABELS: Record<CompanyFilingKind, string> = {
  accounts: 'Accounts',
  ct600: 'Corporation Tax return (CT600)',
  'ct-payment': 'Corporation Tax paid',
  vat: 'VAT return',
  confirmation: 'Confirmation statement',
};

/**
 * The Overview's alerts for a company's deadlines: those due within 60 days or overdue, each a warning
 * from 14 days before its day (the thresholds Self Assessment's alerts use: shared/deadlines.ts), named
 * with the company.
 */
export function companyDeadlineAlerts(company: Pick<Company, 'id' | 'name'>, deadlines: readonly CompanyDeadline[]): Alert[] {
  return deadlines
    .filter((d) => d.status === 'due-soon' || d.status === 'overdue')
    .map((d) => ({
      id: `company-${company.id}-${d.id}`,
      level: d.days <= DEADLINE_WARN_DAYS ? ('warning' as const) : ('info' as const),
      title: `${company.name}: ${d.title} ${d.status === 'overdue' ? `was due on ${formatDate(d.due)}` : `due by ${formatDate(d.due)}`}`,
      detail: `${d.to}, ${d.rule}. Check the date with ${d.to}; once it is done, record it on the company’s page.`,
      action: { label: company.name, href: `/company/${company.id}` },
    }));
}

/**
 * What is wrong with a company's books, in words (none: they fit). The store refuses a write that adds
 * or changes books with any, and the company's page lists those a hand edit left.
 */
export function booksProblems(books: CompanyBooksSetup & { filings?: readonly CompanyFiling[] }): string[] {
  const out: string[] = [];
  const inc = books.incorporatedOn;
  const day = (d: ISODate) => formatDate(d);
  const periodsProblems = (list: readonly { start: ISODate; end: ISODate }[], what: string, maxMonths: number, why: string) => {
    const sorted = byStart(list);
    sorted.forEach((p, i) => {
      if (p.end < p.start) out.push(`${what} ${day(p.start)} – ${day(p.end)} ends before it starts.`);
      else if (longerThanMonths(p.start, p.end, maxMonths)) out.push(`${what} ${day(p.start)} – ${day(p.end)} is longer than ${maxMonths} months (${why}).`);
      if (p.start < inc) out.push(`${what} ${day(p.start)} – ${day(p.end)} starts before the company was incorporated (${day(inc)}).`);
      const prev = sorted[i - 1];
      if (prev && p.start <= prev.end) out.push(`${what}s ${day(prev.start)} – ${day(prev.end)} and ${day(p.start)} – ${day(p.end)} overlap.`);
    });
  };
  periodsProblems(books.periods, 'The accounting period', ACCOUNTING_PERIOD_RULES.maxMonths, 'CA 2006 s392(5)');
  periodsProblems(books.ctPeriods, 'The Corporation Tax period', CT_PERIOD_RULES.maxMonths, 'CTA 2009 s10(1)(a)');
  if (books.ledgerFrom && books.ledgerFrom < inc) out.push(`Its books start on ${day(books.ledgerFrom)}, before it was incorporated (${day(inc)}).`);
  if (books.tradeStartedOn && books.tradeStartedOn < inc) out.push(`Trade started on ${day(books.tradeStartedOn)}, before the company was incorporated (${day(inc)}).`);
  if (books.withinChargeFrom && books.withinChargeFrom < inc) out.push(`It came within the charge to Corporation Tax on ${day(books.withinChargeFrom)}, before it was incorporated (${day(inc)}).`);
  if (books.tradeStartedOn && books.withinChargeFrom && books.tradeStartedOn < books.withinChargeFrom) out.push(`Trade started on ${day(books.tradeStartedOn)}, before it came within the charge to Corporation Tax (${day(books.withinChargeFrom)}): trading brings a company within the charge (CTA 2009 s9(2)).`);
  if (books.tradeStartedOn && books.withinChargeFrom === null) out.push('It trades, so it is not dormant for Corporation Tax: give the day it came within the charge (CTA 2009 s9).');
  const classes = (books.policies ?? []).map((p) => p.class);
  for (const c of new Set(classes.filter((c, i) => classes.indexOf(c) !== i))) out.push(`Two depreciation policies are for ${FIXED_ASSET_CLASS_META[c].name.toLowerCase()}: give one life per class.`);
  if (books.confirmationStatement && books.confirmationStatement.nextMadeUpTo <= inc) out.push(`The next confirmation statement's made-up date (${day(books.confirmationStatement.nextMadeUpTo)}) is not after incorporation.`);
  if (books.paye) {
    if (books.paye.from < inc) out.push(`The PAYE scheme starts on ${day(books.paye.from)}, before the company was incorporated.`);
    if (books.paye.closedOn && books.paye.closedOn < books.paye.from) out.push('The PAYE scheme closes before it starts.');
  }
  const vat = books.vat;
  if (vat) {
    if (vat.registeredFrom < inc) out.push(`VAT registration on ${day(vat.registeredFrom)} is before the company was incorporated.`);
    const froms = vat.schedule.map((e) => e.from);
    if (froms.some((f, i) => i > 0 && f <= froms[i - 1]!)) out.push('The VAT schedule’s changes must be in order of date, one a day.');
    if (froms[0]! > vat.registeredFrom) out.push('The first VAT schedule applies from registration (its date is on or before the registration date).');
    if (vat.firstPeriodEnd && vat.firstPeriodEnd < vat.registeredFrom) out.push('The first VAT period ends before registration.');
    if (vat.deregisteredOn && vat.deregisteredOn <= vat.registeredFrom) out.push('Deregistration is not after registration.');
    if (vat.deregisteredOn && froms.some((f) => f > vat.deregisteredOn!)) out.push('A VAT schedule change is after deregistration.');
  }
  const filings = books.filings ?? [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const f of filings) {
    const what = `The ${FILING_KIND_LABELS[f.kind].replace(/^./, (c) => c.toLowerCase())} for ${f.periodStart ? formatSpan(f.periodStart, f.periodEnd) : day(f.periodEnd)}`;
    if (ids.has(f.id)) out.push(`Two filings have the id ${f.id}.`);
    ids.add(f.id);
    const key = `${f.kind}|${f.periodEnd}`;
    if (keys.has(key)) out.push(`${what} is recorded twice.`);
    keys.add(key);
    if (f.periodStart && f.periodStart > f.periodEnd) out.push(`${what} ends before it starts.`);
    if (f.periodEnd < inc) out.push(`${what} ends before the company was incorporated.`);
    if (f.kind !== 'ct-payment' && f.filedOn < f.periodEnd) out.push(`${what} is filed (${day(f.filedOn)}) before its period ends.`);
    if (f.kind === 'vat' && f.figures) {
      const b = f.figures;
      if (toMinor(b.totalVatDue) !== toMinor(b.vatDueSales) + toMinor(b.vatDueAcquisitions)) out.push(`${what}: box 3 is not boxes 1 and 2 together.`);
      if (toMinor(b.netVatDue) !== Math.abs(toMinor(b.totalVatDue) - toMinor(b.vatReclaimedCurrPeriod))) out.push(`${what}: box 5 is not the difference of boxes 3 and 4.`);
    }
  }
  return out;
}

/**
 * The problems `after` has that `before` did not (`booksProblems`): what a write adds. A problem a hand
 * edit left is not the write's, so the app can fix one at a time.
 */
export function addedBooksProblems(before: (CompanyBooksSetup & { filings?: readonly CompanyFiling[] }) | undefined, after: CompanyBooksSetup & { filings?: readonly CompanyFiling[] }): string[] {
  const had = new Set(before ? booksProblems(before) : []);
  return booksProblems(after).filter((p) => !had.has(p));
}
