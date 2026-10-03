// UK tax-year rules and allowance tables.
//
// Every figure lives in a dated table so that a Budget change is a one-line edit here, not a hunt
// through the codebase. Sources and caveats: docs/UK_RULES.md. When adding a year, add a row to
// TAX_YEAR_PARAMS with only the fields that changed; later years inherit earlier values.

import { addMonths, addYears, makeDate, type ISODate } from './dates';

export interface TaxYear {
  /** "2026/27" */
  label: string;
  /** Calendar year the tax year starts in (2026 for 2026/27). */
  startYear: number;
  /** 6 April */
  start: ISODate;
  /** 5 April the following year */
  end: ISODate;
}

export function taxYear(startYear: number): TaxYear {
  return {
    label: `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`,
    startYear,
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
  };
}

export function taxYearOf(date: ISODate): TaxYear {
  const y = Number(date.slice(0, 4));
  return taxYear(date.slice(5) >= '04-06' ? y : y - 1);
}

/** Accepts "2026/27", "2026-27", "2026-2027" or "2026". */
export function parseTaxYear(label: string): TaxYear | null {
  const m = /^(\d{4})(?:[/-](\d{2}|\d{4}))?$/.exec(label.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2]) {
    const end = Number(m[2].length === 2 ? `${String(start + 1).slice(0, 2)}${m[2]}` : m[2]);
    if (end !== start + 1) return null;
  }
  return taxYear(start);
}

/** Tax years overlapping [from, to], oldest first. */
export function taxYearsBetween(from: ISODate, to: ISODate): TaxYear[] {
  const out: TaxYear[] = [];
  for (let y = taxYearOf(from).startYear; y <= taxYearOf(to).startYear; y++) out.push(taxYear(y));
  return out;
}

export type TaxBand = 'none' | 'basic' | 'higher' | 'additional';

export interface TaxYearParams {
  /** Overall ISA subscription limit across all ISAs (cash, stocks & shares, IF, LISA). */
  isaAllowance: number;
  /** Cash-ISA limit for savers under 65, or null when there is no separate cash limit. */
  cashIsaLimitUnder65: number | null;
  /** Lifetime ISA subscription limit (counts within the overall ISA allowance). */
  lisaAllowance: number;
  lisaBonusRate: number;
  lisaWithdrawalCharge: number;
  lisaPropertyPriceCap: number;
  juniorIsaAllowance: number;
  /** Pension annual allowance (before taper). */
  pensionAnnualAllowance: number;
  /** Taper applies when threshold income > this ... */
  pensionTaperThresholdIncome: number;
  /** ... and adjusted income > this. AA reduces £1 per £2 over, down to the minimum. */
  pensionTaperAdjustedIncome: number;
  pensionTaperMinimum: number;
  /** Money Purchase Annual Allowance once benefits have been flexibly accessed. */
  moneyPurchaseAnnualAllowance: number;
  /** Personal Savings Allowance by band (interest outside ISAs). */
  personalSavingsAllowance: Record<TaxBand, number>;
  startingRateForSavings: number;
  dividendAllowance: number;
  cgtAnnualExemptAmount: number;
  personalAllowance: number;
  /** Maximum tax-free cash across all pensions (Lump Sum Allowance, from 2024/25). */
  lumpSumAllowance: number | null;
  /** Income tax rates on savings income above allowances, by band. */
  savingsTaxRates: Record<Exclude<TaxBand, 'none'>, number>;
  dividendTaxRates: Record<Exclude<TaxBand, 'none'>, number>;
  /** Income tax (England, Wales, Northern Ireland): the basic-rate band above the personal allowance. */
  basicRateLimit: number;
  /** Taxable income above which the additional rate applies (gross income, as HMRC quotes it). */
  additionalRateThreshold: number;
  /** Income above which the personal allowance falls by £1 for every £2. */
  personalAllowanceTaperThreshold: number;
  incomeTaxRates: Record<Exclude<TaxBand, 'none'>, number>;
  /** Basic-rate relief added to relief-at-source pension contributions (net £80 → gross £100). */
  reliefAtSourceRate: number;
  /** Share of a pension that can usually be taken tax-free (up to the lump sum allowance). */
  pensionTaxFreeShare: number;
  /** Lump Sum and Death Benefit Allowance (from 2024/25). */
  lumpSumAndDeathBenefitAllowance: number | null;
  /** High Income Child Benefit Charge: starts above `threshold`, equals the benefit at `fullAt`. */
  hicbc: { threshold: number; fullAt: number };
  /** Trading and property allowances (0 before they existed). */
  tradingAllowance: number;
  propertyAllowance: number;
  /** Disposals must be reported when proceeds exceed this, even with no tax due (null: 4 × the exempt amount). */
  cgtReportingProceeds: number | null;
  /**
   * Dividends above this mean a Self Assessment return. Up to it, tax on dividends over the allowance
   * can be paid through your tax code instead (HMRC must hear of them by `untaxedIncomeNoticeBy`).
   */
  dividendsReturnThreshold: number;
  /** Full new State Pension, per week. */
  statePensionFullWeekly: number;
  /**
   * Employee (primary) Class 1 National Insurance, category A, on monthly pay: nothing up to the
   * primary threshold, `mainRate` up to the upper earnings limit, `upperRate` above. Null for years
   * not modelled (2022/23 and 2023/24 changed rates part-way through).
   */
  employeeNi: { primaryThresholdMonthly: number; upperEarningsLimitMonthly: number; mainRate: number; upperRate: number } | null;
}

type ParamsRow = { from: number } & Partial<TaxYearParams>;

/**
 * Rows apply from tax year `from` (start year) until superseded. Keep sorted by `from`. The table
 * starts at 2016/17 (the first year with the Personal Savings Allowance and dividend allowance);
 * earlier years reuse the 2016/17 row and are not modelled precisely.
 */
export const TAX_YEAR_PARAMS: ParamsRow[] = [
  {
    from: 2016,
    isaAllowance: 15_240,
    cashIsaLimitUnder65: null,
    lisaAllowance: 0,
    lisaBonusRate: 0.25,
    lisaWithdrawalCharge: 0.25,
    lisaPropertyPriceCap: 450_000,
    juniorIsaAllowance: 4_080,
    pensionAnnualAllowance: 40_000,
    pensionTaperThresholdIncome: 110_000,
    pensionTaperAdjustedIncome: 150_000,
    pensionTaperMinimum: 10_000,
    moneyPurchaseAnnualAllowance: 10_000,
    personalSavingsAllowance: { none: 1_000, basic: 1_000, higher: 500, additional: 0 },
    startingRateForSavings: 5_000,
    dividendAllowance: 5_000,
    cgtAnnualExemptAmount: 11_100,
    personalAllowance: 11_000,
    lumpSumAllowance: null,
    savingsTaxRates: { basic: 0.2, higher: 0.4, additional: 0.45 },
    dividendTaxRates: { basic: 0.075, higher: 0.325, additional: 0.381 },
    basicRateLimit: 32_000,
    additionalRateThreshold: 150_000,
    personalAllowanceTaperThreshold: 100_000,
    incomeTaxRates: { basic: 0.2, higher: 0.4, additional: 0.45 },
    reliefAtSourceRate: 0.2,
    pensionTaxFreeShare: 0.25,
    lumpSumAndDeathBenefitAllowance: null,
    hicbc: { threshold: 50_000, fullAt: 60_000 },
    tradingAllowance: 0,
    propertyAllowance: 0,
    cgtReportingProceeds: null,
    dividendsReturnThreshold: 10_000,
    statePensionFullWeekly: 155.65,
    employeeNi: null,
  },
  {
    from: 2017,
    isaAllowance: 20_000,
    lisaAllowance: 4_000,
    juniorIsaAllowance: 4_128,
    moneyPurchaseAnnualAllowance: 4_000,
    cgtAnnualExemptAmount: 11_300,
    personalAllowance: 11_500,
    basicRateLimit: 33_500,
    tradingAllowance: 1_000,
    propertyAllowance: 1_000,
    statePensionFullWeekly: 159.55,
  },
  { from: 2018, juniorIsaAllowance: 4_260, dividendAllowance: 2_000, cgtAnnualExemptAmount: 11_700, personalAllowance: 11_850, basicRateLimit: 34_500, statePensionFullWeekly: 164.35 },
  { from: 2019, juniorIsaAllowance: 4_368, cgtAnnualExemptAmount: 12_000, personalAllowance: 12_500, basicRateLimit: 37_500, statePensionFullWeekly: 168.6 },
  {
    from: 2020,
    juniorIsaAllowance: 9_000,
    pensionTaperThresholdIncome: 200_000,
    pensionTaperAdjustedIncome: 240_000,
    pensionTaperMinimum: 4_000,
    cgtAnnualExemptAmount: 12_300,
    statePensionFullWeekly: 175.2,
  },
  { from: 2021, personalAllowance: 12_570, basicRateLimit: 37_700, statePensionFullWeekly: 179.6 },
  { from: 2022, dividendTaxRates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 }, statePensionFullWeekly: 185.15 },
  {
    from: 2023,
    pensionAnnualAllowance: 60_000,
    pensionTaperAdjustedIncome: 260_000,
    pensionTaperMinimum: 10_000,
    moneyPurchaseAnnualAllowance: 10_000,
    dividendAllowance: 1_000,
    cgtAnnualExemptAmount: 6_000,
    additionalRateThreshold: 125_140,
    cgtReportingProceeds: 50_000,
    statePensionFullWeekly: 203.85,
  },
  {
    from: 2024,
    dividendAllowance: 500,
    cgtAnnualExemptAmount: 3_000,
    lumpSumAllowance: 268_275,
    lumpSumAndDeathBenefitAllowance: 1_073_100,
    hicbc: { threshold: 60_000, fullAt: 80_000 },
    statePensionFullWeekly: 221.2,
    // Employee NI 8% from 6 April 2024; thresholds frozen (gov.uk "Rates and thresholds for employers").
    employeeNi: { primaryThresholdMonthly: 1_048, upperEarningsLimitMonthly: 4_189, mainRate: 0.08, upperRate: 0.02 },
  },
  { from: 2025, statePensionFullWeekly: 230.25 },
  // Budget 2025: dividend ordinary and upper rates +2pp from April 2026 (additional unchanged).
  // State Pension up 4.8% with earnings (the triple lock).
  { from: 2026, dividendTaxRates: { basic: 0.1075, higher: 0.3575, additional: 0.3935 }, statePensionFullWeekly: 241.3 },
  // Autumn Budget 2025: cash-ISA limit £12,000 for under-65s from 6 April 2027 (overall stays
  // £20,000); savings income tax rates +2pp from April 2027.
  { from: 2027, cashIsaLimitUnder65: 12_000, savingsTaxRates: { basic: 0.22, higher: 0.42, additional: 0.47 } },
];

const paramsCache = new Map<number, TaxYearParams>();

export function taxYearParams(ty: TaxYear | number): TaxYearParams {
  const startYear = typeof ty === 'number' ? ty : ty.startYear;
  const cached = paramsCache.get(startYear);
  if (cached) return cached;
  const merged: Partial<TaxYearParams> = {};
  for (const row of TAX_YEAR_PARAMS) {
    // Years before the table starts reuse its first row.
    if (row.from > startYear && row !== TAX_YEAR_PARAMS[0]) break;
    const { from: _from, ...rest } = row;
    Object.assign(merged, rest);
  }
  const out = merged as TaxYearParams;
  paramsCache.set(startYear, out);
  return out;
}

/** Whole years of age on a date. */
export function ageOn(dateOfBirth: ISODate, date: ISODate): number {
  const by = Number(dateOfBirth.slice(0, 4));
  const y = Number(date.slice(0, 4));
  let age = y - by;
  if (date.slice(5) < dateOfBirth.slice(5)) age -= 1;
  return age;
}

/** The date someone reaches `years` of age (29 Feb birthdays roll to 28 Feb). */
export function birthdayAt(dateOfBirth: ISODate, years: number): ISODate {
  return addYears(dateOfBirth, years);
}

/**
 * Cash-ISA limit for a tax year. Under-65s are capped from 2027/28; the full allowance applies from
 * the start of the tax year in which you turn 65. Unknown DOB: assume the cap applies.
 */
export function cashIsaLimit(ty: TaxYear, dateOfBirth?: ISODate): number {
  const p = taxYearParams(ty);
  if (p.cashIsaLimitUnder65 === null) return p.isaAllowance;
  if (dateOfBirth && ageOn(dateOfBirth, ty.end) >= 65) return p.isaAllowance;
  return p.cashIsaLimitUnder65;
}

/**
 * Tapered pension annual allowance. Without income figures the standard allowance is returned.
 */
export function pensionAnnualAllowance(ty: TaxYear, income?: { threshold?: number; adjusted?: number }): number {
  const p = taxYearParams(ty);
  if (!income?.threshold || !income.adjusted) return p.pensionAnnualAllowance;
  if (income.threshold <= p.pensionTaperThresholdIncome || income.adjusted <= p.pensionTaperAdjustedIncome) {
    return p.pensionAnnualAllowance;
  }
  const reduction = Math.floor((income.adjusted - p.pensionTaperAdjustedIncome) / 2);
  return Math.max(p.pensionTaperMinimum, p.pensionAnnualAllowance - reduction);
}

export function personalSavingsAllowance(ty: TaxYear, band: TaxBand | undefined): number {
  return taxYearParams(ty).personalSavingsAllowance[band ?? 'basic'];
}

export interface BandIncome {
  /** Pay, pensions, self-employment profit and other income that is not savings or dividends. */
  nonSavings: number;
  /** Interest outside ISAs and pensions. */
  savings: number;
  /** Dividends outside ISAs and pensions. */
  dividends: number;
  /** Gross relief-at-source pension contributions plus gross Gift Aid: they widen the bands. */
  bandExtension: number;
}

export interface TaxBandResult {
  band: TaxBand;
  total: number;
  personalAllowance: number;
  taxable: number;
  /** Taxable income at which the higher and additional rates start, after any extension. */
  higherFrom: number;
  additionalFrom: number;
}

/**
 * The highest income tax band any of a year's income reaches (England, Wales and Northern Ireland
 * bands, which are also the bands savings and dividends use everywhere in the UK). The Personal
 * Savings Allowance is set by this band. Whole pounds; FORMULAS.md §11.
 */
export function taxBandFor(ty: TaxYear, income: BandIncome): TaxBandResult {
  const p = taxYearParams(ty);
  const total = Math.max(0, income.nonSavings) + Math.max(0, income.savings) + Math.max(0, income.dividends);
  const extension = Math.max(0, income.bandExtension);
  const adjustedNet = total - extension;
  const taper = Math.max(0, Math.floor((adjustedNet - p.personalAllowanceTaperThreshold) / 2));
  const personalAllowance = Math.max(0, p.personalAllowance - taper);
  const taxable = Math.max(0, total - personalAllowance);
  const higherFrom = p.basicRateLimit + extension;
  const additionalFrom = p.additionalRateThreshold + extension;
  const band: TaxBand = taxable <= 0 ? 'none' : taxable <= higherFrom ? 'basic' : taxable <= additionalFrom ? 'higher' : 'additional';
  return { band, total, personalAllowance, taxable, higherFrom, additionalFrom };
}

/** Normal minimum pension age on a date: 55, rising to 57 on 6 April 2028. */
export function normalMinimumPensionAge(onDate: ISODate): number {
  return onDate >= '2028-04-06' ? 57 : 55;
}

/**
 * Earliest date private pensions can normally be accessed. Anyone who reaches 55 before 6 April 2028
 * can access at 55; everyone else at 57. Protected pension ages are not modelled.
 */
export function pensionAccessDate(dateOfBirth: ISODate): ISODate {
  const at55 = birthdayAt(dateOfBirth, 55);
  return at55 < '2028-04-06' ? at55 : birthdayAt(dateOfBirth, 57);
}

/** LISA: can be opened aged 18-39; contributions (and bonus) stop at the 50th birthday. */
export function lisaRules(dateOfBirth: ISODate | undefined, onDate: ISODate) {
  if (!dateOfBirth) return { canOpen: null, canContribute: null, contributionsEnd: null, penaltyFreeFrom: null };
  const age = ageOn(dateOfBirth, onDate);
  return {
    canOpen: age >= 18 && age < 40,
    canContribute: age >= 18 && age < 50,
    contributionsEnd: birthdayAt(dateOfBirth, 50),
    penaltyFreeFrom: birthdayAt(dateOfBirth, 60),
  };
}

/**
 * Value you would receive from a LISA if you withdrew everything for a non-qualifying reason: the
 * 25% charge applies to the whole withdrawal, so you get 75% (losing the bonus and 6.25% of your own
 * money).
 */
export function lisaPenaltyAdjustedValue(value: number, ty: TaxYear): number {
  return Math.round(value * (1 - taxYearParams(ty).lisaWithdrawalCharge) * 100) / 100;
}

interface DatedLimit {
  from: ISODate;
  limit: number;
}

/** FSCS deposit protection per person, per banking licence. */
export const FSCS_DEPOSIT_LIMITS: DatedLimit[] = [
  { from: '2017-01-30', limit: 85_000 },
  { from: '2025-12-01', limit: 120_000 },
];

export function fscsDepositLimit(onDate: ISODate): number {
  let limit = 85_000;
  for (const row of FSCS_DEPOSIT_LIMITS) if (onDate >= row.from) limit = row.limit;
  return limit;
}

/** Days until the end of the tax year containing `date` (0 on 5 April). */
export function daysLeftInTaxYear(date: ISODate): number {
  const ty = taxYearOf(date);
  const end = makeDate(ty.startYear + 1, 4, 5)!;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}

/** Relief at source: a net personal contribution of £80 is grossed up to £100 by basic-rate relief. */
export function grossUpReliefAtSource(net: number, ty: TaxYear = taxYearOf(`${new Date().getFullYear()}-04-06`)): number {
  const rate = taxYearParams(ty).reliefAtSourceRate;
  return Math.round((net / (1 - rate)) * 100) / 100;
}

/**
 * State Pension age under current law (Pensions Acts 2007, 2011 and 2014; gov.uk "State Pension age
 * timetable"):
 *   - born 6 October 1954 – 5 April 1960: 66;
 *   - born 6 April 1960 – 5 March 1961: 66 plus 1–11 months (one more month per month of birth);
 *   - born 6 March 1961 – 5 April 1977: 67;
 *   - born 6 April 1977 – 5 April 1978: a fixed date between 6 May 2044 and 6 March 2046;
 *   - born on or after 6 April 1978: 68.
 * Earlier cohorts are not modelled (they have reached it). The 67→68 timetable is subject to
 * statutory reviews and may change.
 */
export function statePensionDate(dateOfBirth: ISODate): ISODate {
  if (dateOfBirth < '1954-10-06') return addYears(dateOfBirth, 65);
  if (dateOfBirth < '1960-04-06') return addYears(dateOfBirth, 66);
  if (dateOfBirth < '1961-03-06') {
    // 6 April 1960 – 5 May 1960 → 66 years 1 month; each later month of birth adds a month.
    const y = Number(dateOfBirth.slice(0, 4));
    const m = Number(dateOfBirth.slice(5, 7));
    const d = Number(dateOfBirth.slice(8, 10));
    const cohortStartMonth = d >= 6 ? m : m - 1; // the month in which the cohort's 6th falls
    const monthsSinceApril1960 = (y - 1960) * 12 + (cohortStartMonth - 4);
    return addMonths(addYears(dateOfBirth, 66), monthsSinceApril1960 + 1);
  }
  if (dateOfBirth < '1977-04-06') return addYears(dateOfBirth, 67);
  if (dateOfBirth < '1978-04-06') {
    // Cohorts of one month of birth (from the 6th) reach State Pension age on the 6th of every other
    // month from 6 May 2044 to 6 March 2046.
    const y = Number(dateOfBirth.slice(0, 4));
    const m = Number(dateOfBirth.slice(5, 7));
    const d = Number(dateOfBirth.slice(8, 10));
    const cohortStartMonth = d >= 6 ? m : m - 1;
    const index = (y - 1977) * 12 + (cohortStartMonth - 4); // 0 for 6 April – 5 May 1977
    return addMonths('2044-05-06', 2 * index);
  }
  return addYears(dateOfBirth, 68);
}

/** The full new State Pension a year, for a tax year (52 weeks). */
/**
 * The day by which HMRC must hear of income with tax to pay for `ty` (dividends over the allowance,
 * say) when it does not already know of it and you do not send a return: 5 October after the year
 * ends. It is also the last day to register for Self Assessment for that year.
 */
export function untaxedIncomeNoticeBy(ty: TaxYear): ISODate {
  return `${ty.startYear + 1}-10-05`;
}

/** One Self Assessment deadline for a tax year's return (docs/UK_RULES.md, "Self Assessment"). */
export interface SaDeadline {
  date: ISODate;
  kind: 'register' | 'paper' | 'online-through-code' | 'online' | 'pay' | 'second-payment-on-account';
  what: string;
}

/**
 * The deadlines for `ty`'s Self Assessment return, from GOV.UK's "Self Assessment tax returns:
 * deadlines": register by 5 October after the year ends; a paper return by 31 October; online by
 * 30 December to have a bill under `codingOutLimit` collected through your tax code; online, and
 * the tax paid (with any first payment on account for the next year), by 31 January; any second
 * payment on account by 31 July.
 */
export function saDeadlines(ty: TaxYear): SaDeadline[] {
  const y = ty.startYear;
  return [
    { date: untaxedIncomeNoticeBy(ty), kind: 'register', what: 'Tell HMRC you need to send a return, if you have not sent one before (or tell it of income it does not know about)' },
    { date: `${y + 1}-10-31`, kind: 'paper', what: 'A paper return must reach HMRC' },
    { date: `${y + 1}-12-30`, kind: 'online-through-code', what: `Send the return online by now to have a bill under £${codingOutLimit.toLocaleString('en-GB')} collected through your tax code, if you pay tax through PAYE` },
    { date: `${y + 2}-01-31`, kind: 'online', what: 'Send the return online' },
    { date: `${y + 2}-01-31`, kind: 'pay', what: 'Pay the tax you owe, and the first payment on account for the next year if you make them' },
    { date: `${y + 2}-07-31`, kind: 'second-payment-on-account', what: 'The second payment on account, if you make them' },
  ];
}

/** A Self Assessment bill under this can be collected through your tax code (GOV.UK, "Pay your Self Assessment tax bill: through your tax code"). */
export const codingOutLimit = 3000;

/**
 * The last day a return for `ty` can be corrected: 12 months after its 31 January online deadline
 * (GOV.UK, "Correct a Self Assessment tax return": 31 January 2027 for 2024/25).
 */
export function saCorrectBy(ty: TaxYear): ISODate {
  return `${ty.startYear + 3}-01-31`;
}

/**
 * The oldest tax year whose return can still be sent or corrected on `on` (`saCorrectBy`): its
 * figures, and the data they rest on, can still matter. 2024/25 on any day of October 2026.
 */
export function oldestOpenTaxYear(on: ISODate): TaxYear {
  let ty = taxYearOf(on);
  while (saCorrectBy(taxYear(ty.startYear - 1)) >= on) ty = taxYear(ty.startYear - 1);
  return ty;
}

export function statePensionFullYearly(ty: TaxYear): number {
  return Math.round(taxYearParams(ty).statePensionFullWeekly * 52 * 100) / 100;
}

/** Notable dated rule changes, surfaced as notes in the UI. */
export const RULE_NOTES: { from: ISODate; text: string }[] = [
  { from: '2025-12-01', text: 'FSCS deposit protection rose from £85,000 to £120,000 per person per banking licence.' },
  {
    from: '2027-04-06',
    text: 'Cash ISA subscriptions capped at £12,000 a year for under-65s (overall ISA allowance stays £20,000). Transfers from stocks & shares ISAs into cash ISAs are no longer allowed, and interest on cash held in stocks & shares ISAs is charged at 22%.',
  },
  { from: '2027-04-06', text: 'Tax on savings and property income rises by 2 percentage points (22%, 42%, 47%).' },
  { from: '2028-04-06', text: 'Normal minimum pension age rises from 55 to 57.' },
  {
    from: '2026-06-29',
    text: 'A First Time Buyer ISA is to be offered in place of the Lifetime ISA once available (no date yet; consultation closed 18 August 2026). Existing LISAs continue under the current rules indefinitely.',
  },
  { from: '2029-04-06', text: 'Salary-sacrificed pension contributions above £2,000 a year become subject to National Insurance.' },
];
