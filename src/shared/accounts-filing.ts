// Filing a micro-entity's accounts (docs/FORMULAS.md §22, "Filing the accounts"; docs/UK_RULES.md,
// "Filing the accounts"): the size tests and whether a company qualifies for a financial year, the
// advances to a director its loan shows, the statements the balance sheet carries, the rounding
// statement and the optional accounting policies. Pure functions over figures the books and you give;
// the sheet itself is assembled in analytics/accounts-filing.ts. Nothing here calls Companies House.

import { addDays, diffDays, type ISODate } from './dates';
import { FIXED_ASSET_CLASS_META, type AssetRegisterClass } from './ledger';
import { mulDivRound, toMinor } from './money';
import { lastDayOfMonths, type SizeLimits } from './uk';

/** Whether a period is a year: exactly 12 months, its last day the last of 12 months beginning with its first. */
export const isYear = (p: { start: ISODate; end: ISODate }): boolean => p.end === lastDayOfMonths(p.start, 12);

/**
 * The turnover limit for a financial year, in pence: the limit itself for a year, else proportionately
 * adjusted (CA 2006 s384A(5), s382(4)), by its days over the days of the 12 months beginning with its
 * first day (so a year of 366 days is a year, and 6 months of 181 days is 181 ÷ 365 of the limit).
 */
export function turnoverLimit(limit: number, p: { start: ISODate; end: ISODate }): number {
  if (isYear(p)) return toMinor(limit);
  const year = diffDays(p.start, lastDayOfMonths(p.start, 12)) + 1;
  return mulDivRound(toMinor(limit), diffDays(p.start, p.end) + 1, year);
}

/** One financial year's figures for a size test: turnover in pence, balance sheet total in whole pounds, the average number employed; each absent when not known. */
export interface YearFigures {
  start: ISODate;
  end: ISODate;
  turnover?: number | undefined;
  assets?: number | undefined;
  employees?: number | undefined;
}

/** One requirement of a size test: its figure (absent: not known), its limit, and whether it is within it. */
export interface SizeRequirement {
  value?: number;
  limit: number;
  within?: boolean;
}

/** A year's size test: each requirement, and whether it meets the qualifying conditions (two or more within; absent: not known). */
export interface SizeTest {
  start: ISODate;
  end: ISODate;
  turnover: SizeRequirement;
  assets: SizeRequirement;
  employees: SizeRequirement;
  meets?: boolean;
}

/**
 * Whether a year meets the qualifying conditions (s384A(4), s382(3)): it satisfies two or more of the
 * three requirements. Known when two are within or two are over, whatever the third.
 */
export function sizeTest(y: YearFigures, limits: SizeLimits): SizeTest {
  const req = (value: number | undefined, limit: number): SizeRequirement => ({ limit, ...(value === undefined ? {} : { value, within: value <= limit }) });
  const turnover = req(y.turnover, turnoverLimit(limits.turnover, y));
  const assets = req(y.assets, limits.balanceSheet);
  const employees = req(y.employees, limits.employees);
  const all = [turnover, assets, employees];
  const within = all.filter((r) => r.within === true).length;
  const over = all.filter((r) => r.within === false).length;
  return { start: y.start, end: y.end, turnover, assets, employees, ...(within >= 2 ? { meets: true } : over >= 2 ? { meets: false } : {}) };
}

/** How a year's qualification was decided. */
export type QualificationRule = 'first-year' | 'two-years' | 'one-year-only' | 'told' | 'unknown';

export interface Qualification {
  /** Whether it qualifies for the last year given; absent: it cannot be told. */
  qualifies?: boolean;
  rule: QualificationRule;
  /** Each year's size test, oldest first, the year decided last. */
  years: SizeTest[];
}

/**
 * Whether a company qualifies for the last of `years` (oldest first, consecutive financial years):
 * in its first financial year, when it meets the conditions in it (s384A(1), s382(1)); in a later one,
 * meeting or ceasing to meet them changes its qualification only when that happens in two consecutive
 * years (s384A(2)–(3), s382(1A)–(2)). So it qualifies as it meets them when this year and the last agree,
 * and as it qualified last year when they differ. `previousQualified` is what you say of the year before
 * the last one given, where the years given cannot settle it.
 */
export function qualification(years: readonly YearFigures[], limits: SizeLimits, opts: { firstYear: boolean; previousQualified?: boolean | undefined }): Qualification {
  const tests = years.map((y) => sizeTest(y, limits));
  const n = tests.length - 1;
  const memo = new Map<number, { q: boolean | undefined; rule: QualificationRule }>();
  const q = (k: number): { q: boolean | undefined; rule: QualificationRule } => {
    const seen = memo.get(k);
    if (seen) return seen;
    const m = tests[k]!.meets;
    let out: { q: boolean | undefined; rule: QualificationRule };
    if (k === 0 && opts.firstYear) out = { q: m, rule: m === undefined ? 'unknown' : 'first-year' };
    else if (m === undefined) out = { q: undefined, rule: 'unknown' };
    else {
      const prevM = k > 0 ? tests[k - 1]!.meets : undefined;
      if (prevM !== undefined && prevM === m) out = { q: m, rule: 'two-years' };
      else {
        const told = k === n && opts.previousQualified !== undefined;
        const prevQ = told ? opts.previousQualified : k > 0 ? q(k - 1).q : undefined;
        if (prevQ === undefined) out = { q: undefined, rule: 'unknown' };
        // Met (or not) this year alone: as it qualified the year before. With last year's test not
        // known, that holds only when this year agrees with how it qualified then.
        else if (prevM !== undefined || m === prevQ) out = { q: prevQ, rule: told ? 'told' : 'one-year-only' };
        else out = { q: undefined, rule: 'unknown' };
      }
    }
    memo.set(k, out);
    return out;
  };
  const last = n >= 0 ? q(n) : { q: undefined, rule: 'unknown' as const };
  return { ...(last.q === undefined ? {} : { qualifies: last.q }), rule: last.rule, years: tests };
}

// ─── A director's advances (CA 2006 s413) ─────────────────────────────────────────────────────────

/** A director's loan over a period, in pence, signed from the director's side: positive when the company owes the director. */
export interface LoanPath {
  opening: number;
  movements: readonly { date: ISODate; amount: number }[];
}

/** What a director's loan shows of advances to the director in a period (pence, each positive). */
export interface DirectorAdvances {
  /** Owed by the director at the start of the period. */
  opening: number;
  /** Owed by the director at its end. */
  closing: number;
  /** Advanced in the period: each day's increase in what the director owed. */
  advanced: number;
  /** Repaid in the period: each day's decrease in what the director owed (money paid back, or a dividend or pay credited to the loan). */
  repaid: number;
  /** The most the director owed on any day of the period. */
  maximum: number;
  /** Whether the director owed the company anything at any time in the period: an advance subsisting in it (s413(7)). */
  any: boolean;
  /** Whether the company owed the director anything at any time in it (money the director lent: never an advance to the director). */
  lentToCompany: boolean;
}

/**
 * The advances a director's loan shows in a period (s413(1)(a), (3), (7)): what the director owed the
 * company, day by day (the day's movements together), from the loan's balance at the start. Only what
 * the director owes is an advance: a credit balance (the company owing the director, money the director
 * lent it) is not, and a day that takes the loan from a credit into the director owing advances only
 * what the director then owes.
 */
export function directorAdvances(loan: LoanPath): DirectorAdvances {
  const byDay = new Map<ISODate, number>();
  for (const m of loan.movements) byDay.set(m.date, (byDay.get(m.date) ?? 0) + m.amount);
  let balance = loan.opening;
  const owed = (b: number) => Math.max(0, -b);
  const opening = owed(balance);
  let advanced = 0;
  let repaid = 0;
  let maximum = opening;
  let lentToCompany = balance > 0;
  for (const day of [...byDay.keys()].sort()) {
    const before = owed(balance);
    balance += byDay.get(day)!;
    const after = owed(balance);
    if (after > before) advanced += after - before;
    else repaid += before - after;
    maximum = Math.max(maximum, after);
    if (balance > 0) lentToCompany = true;
  }
  return { opening, closing: owed(balance), advanced, repaid, maximum, any: maximum > 0, lentToCompany };
}

// ─── The statements on the balance sheet ──────────────────────────────────────────────────────────

/** A statement the balance sheet carries, its words and where the law asks for it. */
export interface BalanceSheetStatement {
  key: 'audit-exemption' | 'members' | 'responsibilities' | 'micro-entity';
  text: string;
  source: string;
}

/**
 * The statements above the director's signature on a micro-entity's balance sheet, filed with audit
 * exemption: in Companies House's words ("Preparing and filing Companies House accounts", §§9.4 and
 * 11.1), "year" made "period" for a period other than a year. CA 2006 s475(2)–(4) (audit exemption, the
 * members not requiring an audit under s476, the directors' responsibilities; above the signature),
 * s414(3)(a) (prepared under the micro-entity provisions) and s444(5) (delivered under the small companies
 * regime). A micro-entity need not also say its profit and loss account is not delivered (s444(5C)).
 */
export function balanceSheetStatements(p: { start: ISODate; end: ISODate }): BalanceSheetStatement[] {
  const year = isYear(p) ? 'year' : 'period';
  const end = longDate(p.end);
  return [
    { key: 'audit-exemption', text: `For the ${year} ending ${end} the company was entitled to exemption from audit under section 477 of the Companies Act 2006 relating to small companies.`, source: 'CA 2006 ss475(2), 477' },
    { key: 'members', text: `The members have not required the company to obtain an audit of its accounts for the ${year} in question in accordance with section 476.`, source: 'CA 2006 s475(3)(a)' },
    { key: 'responsibilities', text: 'The directors acknowledge their responsibilities for complying with the requirements of the Act with respect to accounting records and the preparation of accounts.', source: 'CA 2006 s475(3)(b)' },
    { key: 'micro-entity', text: 'The accounts have been prepared in accordance with the micro-entity provisions and have been delivered in accordance with the provisions applicable to companies subject to the small companies regime.', source: 'CA 2006 ss414(3)(a), 444(5)' },
  ];
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A day as the accounts write it: 31 December 2025. */
export const longDate = (d: ISODate): string => `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** The rounding statement (FRS 105 para 3.13(d)): the accounts are in whole pounds. */
export const ROUNDING_STATEMENT = 'The figures in these accounts are rounded to the nearest pound.';

/** The line the director signs under (CA 2006 s414(1)–(2)): approved by the board, signed on its behalf. */
export function approvalLine(approvedOn: ISODate | undefined, approvedBy: string | undefined): string {
  return `Approved by the board of directors on ${approvedOn ? longDate(approvedOn) : '[date]'} and signed on its behalf by ${approvedBy ?? '[name]'}, Director.`;
}

// ─── The accounting policies (optional for a micro-entity) ────────────────────────────────────────

export interface PoliciesInput {
  /** Each class's life in months from the company's policies, in force at the period's end (and earlier lives changed in it). */
  lives: { class: AssetRegisterClass; months: number; from?: ISODate | undefined }[];
  /** Whether any asset on the register at the period's end has a life of its own. */
  ownLives: boolean;
  /** Whether any asset has a residual value. */
  residual: boolean;
  /** The month convention (`books.depreciationMonths`). */
  months: 'acquisition' | 'both';
  /** Whether it held fixed (tangible) assets, intangible assets, at any time in the period. */
  tangible: boolean;
  intangible: boolean;
  /** Whether it is registered for VAT in the period. */
  vat: boolean;
  /** Whether the period's accounts carry prepayments, accruals, deferred or accrued income. */
  accruals: boolean;
}

/**
 * Accounting policies in words, from the books: not required of a micro-entity (FRS 105 para 6.1 allows
 * more than it asks; Companies House's WebFiling help: not required for micro accounts), so offered to
 * add, never put in by themselves. More than the minimum is to be given with regard to FRS 102 Section 1A
 * (FRS 105 para 1.3).
 */
export function accountingPolicies(i: PoliciesInput): string[] {
  const out = [
    'Basis of preparation. These accounts have been prepared in accordance with FRS 105, The Financial Reporting Standard applicable to the Micro-entities Regime, and the micro-entity provisions of the Companies Act 2006, under the historical cost convention.',
    'Presentation. The accounts are presented in pounds sterling, rounded to the nearest pound.',
  ];
  if (i.vat) out.push('Turnover. Turnover is stated net of VAT.');
  if (i.accruals) out.push('Accruals. Income and expenditure are recognised on the accrual basis: costs paid in advance are carried as prepayments, costs incurred and not yet paid as accruals, and income received in advance as deferred income.');
  const convention = i.months === 'both' ? 'A full month is charged in the month an asset is acquired and in the month it is disposed of.' : 'A full month is charged in the month an asset is acquired, and none in the month it is disposed of.';
  const lives = (intangible: boolean) =>
    i.lives
      .filter((l) => (l.class === 'intangible') === intangible)
      .map((l) => `${FIXED_ASSET_CLASS_META[l.class].name.toLowerCase()} ${l.months} months${l.from ? ` (from ${longDate(l.from)})` : ''}`)
      .join('; ');
  const residual = i.residual ? ' less its residual value' : '';
  if (i.tangible) {
    const l = lives(false);
    out.push(`Tangible fixed assets. Tangible fixed assets are measured at cost less accumulated depreciation. Depreciation is charged on a straight-line basis over each asset's useful life${residual}${l ? `: ${l}` : ''}${i.ownLives ? (l ? ', or the life set for an asset of its own' : ', as set for each asset') : ''}. ${convention}`);
  }
  if (i.intangible) {
    const l = lives(true);
    out.push(`Intangible assets. Intangible assets acquired are measured at cost less accumulated amortisation, amortised on a straight-line basis over their useful lives${l ? `: ${l}` : ''}${i.ownLives ? (l ? ', or the life set for an asset of its own' : ', as set for each asset') : ''}. ${convention}`);
  }
  return out;
}

// ─── The average number of employees ──────────────────────────────────────────────────────────────

/**
 * The months of a financial year for the average number of employees (s411(3)–(4), s384A(7)): the first
 * begins on its first day, each the day after the last ends, the last cut at its end. 1 January to 31
 * December is 12; 2 May 2023 to 31 May 2024 is 13.
 */
export function monthsOfYear(p: { start: ISODate; end: ISODate }): { start: ISODate; end: ISODate }[] {
  const out: { start: ISODate; end: ISODate }[] = [];
  for (let k = 1, from = p.start; from <= p.end && k <= 240; k++) {
    const to = lastDayOfMonths(p.start, k);
    out.push({ start: from, end: to < p.end ? to : p.end });
    from = addDays(to, 1);
  }
  return out;
}
