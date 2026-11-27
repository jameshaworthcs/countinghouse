// UK tax-year rules and allowance tables.
//
// Every figure lives in a dated table so that a Budget change is a one-line edit here, not a hunt
// through the codebase. Sources and caveats: docs/UK_RULES.md. When adding a year, add a row to
// TAX_YEAR_PARAMS with only the fields that changed; later years inherit earlier values.

import { addDays, addMonths, addYears, endOfMonth, makeDate, startOfMonth, weekday, type ISODate } from './dates';

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
  /**
   * Scottish income tax on non-savings income (pay, pensions, profits): each band's rate and the
   * taxable income (after the personal allowance) it runs to, the last open-ended. Null for years not
   * modelled. Savings and dividends use the UK bands everywhere.
   */
  scottishBands: { name: string; rate: number; upTo: number | null }[] | null;
  /** Marriage Allowance: the part of the personal allowance a spouse or civil partner can transfer. */
  marriageAllowance: number;
  /**
   * Income-contingent student loan repayments through Self Assessment: 9% (6% for a Postgraduate
   * Loan) of income over each plan's yearly threshold. Unearned income counts in full once it is over
   * `unearnedIncomeLimit`. Null for years not modelled.
   */
  studentLoan: { plan1: number; plan2: number; plan4: number; plan5: number | null; postgraduate: number; rate: number; postgraduateRate: number; unearnedIncomeLimit: number } | null;
  /** Class 4 National Insurance on self-employed profits (null: years not modelled). */
  class4: { lowerProfitsLimit: number; upperProfitsLimit: number; mainRate: number; upperRate: number } | null;
  /**
   * Capital gains tax on gains (other than residential property and carried interest) within the
   * basic rate band income leaves, and above it. Null for 2024/25, whose rates changed on 30 October
   * 2024 (disposals before it at 10% and 20%, after it at 18% and 24%): not worked out here.
   */
  cgtRates: { lower: number; higher: number } | null;
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
    scottishBands: null,
    marriageAllowance: 1_100,
    studentLoan: null,
    class4: null,
    cgtRates: { lower: 0.1, higher: 0.2 },
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
    marriageAllowance: 1_260,
    // Scottish rates 2024/25 (Scottish Government; gov.uk "Scottish Income Tax"): taxable income bands.
    scottishBands: [
      { name: 'starter', rate: 0.19, upTo: 2_306 },
      { name: 'basic', rate: 0.2, upTo: 13_991 },
      { name: 'intermediate', rate: 0.21, upTo: 31_092 },
      { name: 'higher', rate: 0.42, upTo: 62_430 },
      { name: 'advanced', rate: 0.45, upTo: 125_140 },
      { name: 'top', rate: 0.48, upTo: null },
    ],
    studentLoan: { plan1: 24_990, plan2: 27_295, plan4: 31_395, plan5: null, postgraduate: 21_000, rate: 0.09, postgraduateRate: 0.06, unearnedIncomeLimit: 2_000 },
    // Class 4 main rate 6% from 6 April 2024; Class 2 no longer compulsory.
    class4: { lowerProfitsLimit: 12_570, upperProfitsLimit: 50_270, mainRate: 0.06, upperRate: 0.02 },
    cgtRates: null,
  },
  {
    from: 2025,
    statePensionFullWeekly: 230.25,
    scottishBands: [
      { name: 'starter', rate: 0.19, upTo: 2_827 },
      { name: 'basic', rate: 0.2, upTo: 14_921 },
      { name: 'intermediate', rate: 0.21, upTo: 31_092 },
      { name: 'higher', rate: 0.42, upTo: 62_430 },
      { name: 'advanced', rate: 0.45, upTo: 125_140 },
      { name: 'top', rate: 0.48, upTo: null },
    ],
    // Plan 5 repayments can first be due from April 2026, so none through the 2025/26 return.
    studentLoan: { plan1: 26_065, plan2: 28_470, plan4: 32_745, plan5: null, postgraduate: 21_000, rate: 0.09, postgraduateRate: 0.06, unearnedIncomeLimit: 2_000 },
    // From 6 April 2025 the 18% and 24% rates apply to all gains (Autumn Budget 2024).
    cgtRates: { lower: 0.18, higher: 0.24 },
  },
  // Budget 2025: dividend ordinary and upper rates +2pp from April 2026 (additional unchanged).
  // State Pension up 4.8% with earnings (the triple lock).
  {
    from: 2026,
    dividendTaxRates: { basic: 0.1075, higher: 0.3575, additional: 0.3935 },
    statePensionFullWeekly: 241.3,
    // Student loan thresholds 2026/27 (GOV.UK, rates and thresholds for employers 2026 to 2027); Plan 5
    // repayments can be due from April 2026.
    studentLoan: { plan1: 26_900, plan2: 29_385, plan4: 33_795, plan5: 25_000, postgraduate: 21_000, rate: 0.09, postgraduateRate: 0.06, unearnedIncomeLimit: 2_000 },
  },
  // Savings income tax rates from 6 April 2027: Budget 2026 set 24%, 44%, 49% (Budget 2025 had set
  // 22%, 42%, 47%). Budget 2025's £12,000 under-65 cash-ISA limit from 2027/28 was dropped in
  // Budget 2026: the cash limit stays the full £20,000, so there is no separate cash cap.
  { from: 2027, savingsTaxRates: { basic: 0.24, higher: 0.44, additional: 0.49 } },
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
 * Cash-ISA limit for a tax year: the full allowance unless a year sets `cashIsaLimitUnder65` (none
 * does now; Budget 2025's 2027/28 cap was dropped). Where one is set, the full allowance applies from
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

/**
 * LISA withdrawal charge on a first home over the price cap, from the date it took effect (Budget
 * 2026: 20% from 29 October 2026). Before the first row, such a withdrawal paid the ordinary charge.
 */
export const LISA_OVER_CAP_CHARGES: { from: ISODate; rate: number }[] = [{ from: '2026-10-29', rate: 0.2 }];

/**
 * The charge on a LISA withdrawal on `onDate`: `overCap` for buying a first home above the price cap
 * (the account otherwise qualifying), else the ordinary unauthorised-withdrawal charge.
 */
export function lisaWithdrawalChargeOn(onDate: ISODate, overCap = false): number {
  let rate = taxYearParams(taxYearOf(onDate)).lisaWithdrawalCharge;
  if (overCap) for (const row of LISA_OVER_CAP_CHARGES) if (onDate >= row.from) rate = row.rate;
  return rate;
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

/** Payments on account are due only when the income tax and Class 4 left after tax taken off is at least this (TMA 1970 s.59A; HMRC's c13.11)… */
export const paymentsOnAccountThreshold = 1000;
/** …and tax taken off covers no more than this share of the year's (HMRC's c13.13: the rest at least 20%). */
export const paymentsOnAccountAtSourceShare = 0.8;
/** Relief-at-source pension contributions get relief up to the higher of this and relevant UK earnings (FA 2004 s.190). */
export const reliefAtSourceMinimum = 3600;

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
    from: '2026-10-28',
    text: 'A First Time Buyer ISA is to replace the Lifetime ISA for new savers from April 2029 (Budget 2026): a 25% bonus on the balance, up to £20,000, paid on withdrawal for a first home up to £450,000. Existing LISAs continue under the current rules.',
  },
  { from: '2026-10-29', text: 'The Lifetime ISA withdrawal charge on a first home over the £450,000 price cap falls from 25% to 20%. Other unauthorised withdrawals still pay 25%.' },
  { from: '2027-04-06', text: 'Tax on savings and property income rises by 4 percentage points (24%, 44%, 49%).' },
  { from: '2028-04-06', text: 'Normal minimum pension age rises from 55 to 57.' },
  { from: '2029-04-06', text: 'Salary-sacrificed pension contributions above £2,000 a year become subject to National Insurance.' },
];

// ─── Companies: a director's loan (docs/UK_RULES.md, "Companies") ───────────────────────────────

/**
 * Tax a close company owes on a loan to a participator (you, as its director and shareholder) that is
 * still outstanding after its accounting period (CTA 2010 s455). From 6 April 2016 the rate is the
 * dividend upper rate (ITA 2007 s8(2)) for the tax year the loan is made (Finance Act 2016 s50): read
 * from `TAX_YEAR_PARAMS` (`dividendTaxRates.higher`), so the two never disagree. Before then, a flat
 * rate: the rows here.
 */
export const S455_FLAT_RATES: { until: ISODate; rate: number }[] = [{ until: '2016-04-05', rate: 0.25 }];

/** The s455 rate on money lent to you on `loanDate`. */
export function s455Rate(loanDate: ISODate): number {
  const flat = S455_FLAT_RATES.find((r) => loanDate <= r.until);
  return flat ? flat.rate : taxYearParams(taxYearOf(loanDate)).dividendTaxRates.higher;
}

/**
 * The s455 rate by when the money was lent, from the first row up to `on`'s tax year: each rate with
 * the day it starts (the first, the flat rate, from no day in particular).
 */
export function s455RateHistory(on: ISODate): { from: ISODate; rate: number }[] {
  const out: { from: ISODate; rate: number }[] = [{ from: '1900-01-01', rate: S455_FLAT_RATES[0]!.rate }];
  for (let year = Number(S455_FLAT_RATES.at(-1)!.until.slice(0, 4)); year <= taxYearOf(on).startYear; year++) {
    const ty = taxYear(year);
    const rate = s455Rate(ty.start);
    if (rate !== out.at(-1)!.rate) out.push({ from: ty.start, rate });
  }
  return out;
}

/**
 * When s455 tax is due: the day after 9 months from the end of the accounting period the loan was made
 * in (CTA 2010 s455(3)). Repaid (or released) before then, no tax is due on what was repaid (s458).
 */
export const S455_DUE_MONTHS = 9;

/**
 * Repaying and borrowing again (CTA 2010 s464ZA from 30 October 2024, before then s464C): a repayment
 * of £5,000 or more followed within 30 days by new borrowing of £5,000 or more in a later accounting
 * period is matched to the new borrowing, not the old; so is one made while £15,000 or more is owed
 * with arrangements to borrow again.
 */
export const S455_REBORROWING = { days: 30, repaid: 5_000, owedWithArrangements: 15_000 } as const;

/**
 * A loan from your employer (your company, when you work for it) outstanding above this at any time
 * in a tax year is a taxable benefit at the official rate of interest (ITEPA 2003 s180), and the
 * employer owes Class 1A National Insurance on it. Each row from the tax year it starts: £5,000 to
 * 2013/14 (ITEPA 2003 s180 as enacted, from 2003/04, the first year of ITEPA), £10,000 from 2014/15
 * (Finance Act 2014 s22).
 */
export const BENEFICIAL_LOAN_THRESHOLDS: DatedLimit[] = [
  { from: '2003-04-06', limit: 5_000 },
  { from: '2014-04-06', limit: 10_000 },
];

/** The threshold for a tax year: the latest row starting by then (the first row before any). */
export function beneficialLoanThreshold(ty: TaxYear): number {
  let limit = BENEFICIAL_LOAN_THRESHOLDS[0]!.limit;
  for (const row of BENEFICIAL_LOAN_THRESHOLDS) if (ty.start >= row.from) limit = row.limit;
  return limit;
}

// ─── Companies: periods and deadlines (docs/UK_RULES.md, "Companies") ───────────────────────────
//
// What a private limited company must file and pay, and by when: its accounts and confirmation
// statement at Companies House, its Corporation Tax return and payment, and its VAT returns. Pure
// functions of dates; `shared/company-books.ts` puts them together for a company's own record. Months
// are calendar months, counted as the Acts count them (`monthsAfter`, `lastDayOfMonths`).

/** Whether a date is the last day of its month. */
export function isMonthEnd(date: ISODate): boolean {
  return addDays(date, 1).slice(8) === '01';
}

/**
 * The day `months` calendar months after `date`, as CA 2006 s443 counts a period "after" a date: the
 * corresponding day of the month `months` on (s443(2)); the last day of that month when `date` is the
 * last day of its month (s443(3)) or the corresponding day does not exist, such as the 30th of February
 * (s443(4)). A month's end running to a month's end is s443(3) for Companies House's periods, and
 * HMRC's practice for Corporation Tax (CTM01800: a period ending on 28 February in a leap year pays on
 * 29 November, on 28 February in any other year, the month's last day, on 1 December; CTM93040: a
 * return for a period to 28 February before a leap year is due on 29 February, one to 29 February on
 * 28 February).
 */
export function monthsAfter(date: ISODate, months: number): ISODate {
  return isMonthEnd(date) ? endOfMonth(addMonths(startOfMonth(date), months)) : addMonths(date, months);
}

/**
 * The last day of a period of `months` calendar months beginning with `start` (CA 2006 s853A(5)'s
 * review period of "12 months beginning with" incorporation; CTA 2009 s10(1)(a)'s "12 months from the
 * beginning" of an accounting period; FA 1998 Sch 18 para 14(1)(c)'s "30 months from the beginning"):
 * the day before the corresponding day `months` on, or the last day of that month when there is no
 * corresponding day (12 months beginning with 29 February 2024 end on 28 February 2025).
 */
export function lastDayOfMonths(start: ISODate, months: number): ISODate {
  const target = addMonths(startOfMonth(start), months);
  const day = Number(start.slice(8));
  if (day === 1) return addDays(target, -1);
  const lastDay = Number(endOfMonth(target).slice(8));
  return day > lastDay ? endOfMonth(target) : addDays(`${target.slice(0, 8)}${start.slice(8)}`, -1);
}

/**
 * The row of a dated table of rules in force on `date` (the latest row from then or before): a rule
 * that changes gets a new row, so the change is not applied to periods before it. A date before the
 * first row takes the first: earlier rules are not covered (docs/UK_RULES.md says which).
 */
export function ruleOn<T extends { from: ISODate }>(rows: readonly T[], date: ISODate): T {
  let row = rows[0]!;
  for (const r of rows) if (r.from <= date) row = r;
  return row;
}

/** An accounting reference date: a day of the year, "MM-DD" (CA 2006 s391). */
export type MonthDay = string;

/**
 * Whether an accounting reference date means the last day of its month. The last day of February is
 * written "02-28" or "02-29" and means the 29th in a leap year: the default reference date of a company
 * incorporated in February is "the last day of the month" (s391(4)).
 */
export function monthDayIsMonthEnd(md: MonthDay): boolean {
  const [m, d] = md.split('-').map(Number) as [number, number];
  return m === 2 ? d >= 28 : d === Number(endOfMonth(`2001-${md.slice(0, 2)}-01`).slice(8));
}

/** The accounting reference date in `year`. */
export function monthDayIn(md: MonthDay, year: number): ISODate {
  const first = `${String(year).padStart(4, '0')}-${md.slice(0, 2)}-01`;
  return monthDayIsMonthEnd(md) ? endOfMonth(first) : `${first.slice(0, 8)}${md.slice(3)}`;
}

/** The first `md` on or after `date`. */
export function nextMonthDay(md: MonthDay, date: ISODate): ISODate {
  const year = Number(date.slice(0, 4));
  const thisYear = monthDayIn(md, year);
  return thisYear >= date ? thisYear : monthDayIn(md, year + 1);
}

/**
 * Accounting reference periods (CA 2006 ss391–392). The default reference date is the last day of the
 * month in which the anniversary of incorporation falls (s391(4), for a company incorporated in Great
 * Britain from 1 April 1996, or after the Act's commencement). The first period begins on the day of
 * incorporation and is more than 6 months and not more than 18 months long, ending on the reference
 * date (s391(5)); each later one is 12 months (s391(6)). A notice under s392 shortens or extends one,
 * but never past 18 months (s392(5)); an extension is not allowed again within 5 years of an earlier
 * one (s392(3)), which the app does not check.
 */
export const ACCOUNTING_PERIOD_RULES = { firstMoreThanMonths: 6, maxMonths: 18 } as const;

/** A company's default accounting reference date (s391(4)). */
export function defaultAccountingReferenceDate(incorporatedOn: ISODate): MonthDay {
  const mm = incorporatedOn.slice(5, 7);
  return mm === '02' ? '02-28' : `${mm}-${endOfMonth(`2001-${mm}-01`).slice(8)}`;
}

/** Is a period longer than `months` months (it ends after the last day of `months` months beginning with its start)? */
export function longerThanMonths(start: ISODate, end: ISODate, months: number): boolean {
  return end > lastDayOfMonths(start, months);
}

/** The end of a company's first accounting reference period with reference date `ard`: its first occurrence making the period more than 6 months (s391(5)). */
export function firstAccountingPeriodEnd(incorporatedOn: ISODate, ard: MonthDay): ISODate {
  let end = nextMonthDay(ard, incorporatedOn);
  while (!longerThanMonths(incorporatedOn, end, ACCOUNTING_PERIOD_RULES.firstMoreThanMonths)) end = nextMonthDay(ard, addDays(end, 1));
  return end;
}

/**
 * The next 12-month accounting reference period's end after one ending `end` (s391(6)): the same day a
 * year on, the last day of the month when `end` is one (a period to 28 February 2027 is followed by one
 * to 29 February 2028).
 */
export function nextAccountingPeriodEnd(end: ISODate): ISODate {
  return monthsAfter(end, 12);
}

/**
 * Accounts of a private company are delivered to Companies House within 9 months after the end of the
 * accounting reference period (CA 2006 s442(2)(a)). A first period longer than 12 months has until the
 * later of 9 months from the first anniversary of incorporation and 3 months from the period's end
 * (s442(3)). A shortened period has until 3 months from the notice if that is later (s442(4)), and the
 * Secretary of State can extend the period (s442(5)): neither is worked out here. By the period's first
 * day: CA 2006 Part 15 came into force on 6 April 2008 (SI 2007/3495 art 3), for financial years
 * beginning on or after it; earlier ones (CA 1985) are not covered.
 */
export const ACCOUNTS_FILING_RULES: readonly { from: ISODate; privateMonths: number; firstLongMonthsFromAnniversary: number; firstLongMonthsFromEnd: number }[] = [
  { from: '2008-04-06', privateMonths: 9, firstLongMonthsFromAnniversary: 9, firstLongMonthsFromEnd: 3 },
];

/**
 * When a private company's accounts for `period` are due at Companies House: s442(2)(a), or s442(3) for
 * a first period longer than 12 months. The first anniversary of a 29 February incorporation is taken
 * as 28 February: the Act does not say, and this errs early (1 March would give a day later).
 */
export function accountsFilingDeadline(period: { start: ISODate; end: ISODate }, incorporatedOn: ISODate): ISODate {
  const r = ruleOn(ACCOUNTS_FILING_RULES, period.start);
  if (period.start === incorporatedOn && longerThanMonths(period.start, period.end, 12)) {
    const a = monthsAfter(addYears(incorporatedOn, 1), r.firstLongMonthsFromAnniversary);
    const b = monthsAfter(period.end, r.firstLongMonthsFromEnd);
    return a > b ? a : b;
  }
  return monthsAfter(period.end, r.privateMonths);
}

/**
 * A company's confirmation statement (CA 2006 s853A): each review period is 12 months, the first
 * beginning with the day of incorporation and each later one with the day after the last (s853A(5));
 * one made up to an earlier day starts the next review period the day after it (s853A(6)). It is
 * delivered within 14 days after the end of the review period (s853A(1)), made up to a day no later
 * than its last (s853A(4)): one made up early is still due 14 days after its review period's end. By
 * the review period's end: Part 24 as substituted by the Small Business, Enterprise and Employment Act
 * 2015 s92 is in force from 30 June 2016 (SI 2016/321); annual returns before it are not covered.
 */
export const CONFIRMATION_STATEMENT_RULES: readonly { from: ISODate; reviewMonths: number; days: number }[] = [{ from: '2016-06-30', reviewMonths: 12, days: 14 }];

/** When the confirmation statement for a review period ending `reviewEnd` is due (s853A(1)), whatever day it is made up to. */
export function confirmationStatementDue(reviewEnd: ISODate): ISODate {
  return addDays(reviewEnd, ruleOn(CONFIRMATION_STATEMENT_RULES, reviewEnd).days);
}

/**
 * Corporation Tax accounting periods (CTA 2009 ss9–10). One begins when the company comes within the
 * charge (s9(1)(a)): when it starts to carry on business (s9(2)) or has a source of income, such as
 * interest on its bank account; trading is not needed (GOV.UK, "Dormant for Corporation Tax": "Trading
 * includes … getting interest"). Again straight after one ends while it stays
 * within it (s9(1)(b)). One ends on the first of: 12 months from its beginning (s10(1)(a)); the
 * company's accounting date, or the end of a period it does not make up accounts for (s10(1)(b)–(c));
 * starting or ceasing to trade (s10(1)(d)); and the rest of s10(1), which the app does not know of
 * (residence, administration, ceasing to be within the charge).
 */
export const CT_PERIOD_RULES = { maxMonths: 12 } as const;

/**
 * Corporation Tax is due on the day after 9 months from the end of the accounting period (TMA 1970
 * s59D(1)), for a company that does not pay by instalments. Large companies pay by quarterly
 * instalments (s59E and the Corporation Tax (Instalment Payments) Regulations 1998), which the app does
 * not work out. By the period's end: Corporation Tax Self Assessment, for accounting periods ending on
 * or after 1 July 1999 (the day after 9 months is statutory from then; before, by concession: CTM92010).
 */
export const CT_PAYMENT_RULES: readonly { from: ISODate; months: number; days: number }[] = [{ from: '1999-07-01', months: 9, days: 1 }];

/** When Corporation Tax for an accounting period ending `end` is due, outside instalments (TMA 1970 s59D(1); HMRC's CTM01800). */
export function ctPaymentDue(end: ISODate): ISODate {
  const r = ruleOn(CT_PAYMENT_RULES, end);
  return addDays(monthsAfter(end, r.months), r.days);
}

/**
 * A company tax return (CT600) is due on the last day of the latest of (FA 1998 Sch 18 para 14(1)):
 * 12 months from the end of its accounting period; 12 months from the end of the period of account the
 * accounting period's last day falls in, if that is not longer than 18 months, or 30 months from its
 * beginning if it is; and 3 months from HMRC's notice to deliver it (para 14(1)(d)), which the app does
 * not know and does not work out. So both returns for a 15-month period of account are due 12 months
 * after it ends (HMRC's CTM93050, example 3). Months as `monthsAfter` counts them, a month's end to a
 * month's end, the 29 February rule included (CTM93040). By the accounting period's end: Schedule 18
 * applies to accounting periods ending on or after 1 July 1999 (Corporation Tax Self Assessment).
 */
export const CT_RETURN_RULES: readonly { from: ISODate; monthsFromEnd: number; longPeriodOfAccountMonths: number; longMonthsFromStart: number }[] = [{ from: '1999-07-01', monthsFromEnd: 12, longPeriodOfAccountMonths: 18, longMonthsFromStart: 30 }];

/** When the CT600 for accounting period `ap`, whose last day falls in period of account `poa`, is due (without the notice's 3 months). */
export function ct600Due(ap: { end: ISODate }, poa: { start: ISODate; end: ISODate }): ISODate {
  const r = ruleOn(CT_RETURN_RULES, ap.end);
  const own = monthsAfter(ap.end, r.monthsFromEnd);
  const ofAccount = longerThanMonths(poa.start, poa.end, r.longPeriodOfAccountMonths) ? lastDayOfMonths(poa.start, r.longMonthsFromStart) : monthsAfter(poa.end, r.monthsFromEnd);
  return own > ofAccount ? own : ofAccount;
}

/** How often a VAT-registered company makes returns, as HMRC set it: monthly, quarterly in one of three staggers, or yearly under annual accounting. */
export const VAT_STAGGERS = ['monthly', 'quarterly-1', 'quarterly-2', 'quarterly-3', 'annual'] as const;
export type VatStagger = (typeof VAT_STAGGERS)[number];

/**
 * The months HMRC's quarterly staggers end in (HMRC's DMBM530020, which calls monthly returns stagger 0): stagger 1 March, June, September and
 * December; stagger 2 April, July, October and January; stagger 3 May, August, November and February.
 * Returns are for quarters ending on the dates HMRC set (VAT Regulations 1995 reg 25(1)).
 */
export const VAT_QUARTER_END_MONTHS: Record<Exclude<VatStagger, 'monthly' | 'annual'>, readonly number[]> = {
  'quarterly-1': [3, 6, 9, 12],
  'quarterly-2': [1, 4, 7, 10],
  'quarterly-3': [2, 5, 8, 11],
};

/**
 * When VAT returns are due. A return is due "not later than the last day of the month next following
 * the end of the period" (VAT Regulations 1995 reg 25(1)), and HMRC allow 7 days more for one made
 * online and paid electronically (reg 25A(20), by direction: VAT Notice 700/12), whatever day of the
 * week that is: a period to 31 March by 7 May, and one to 10 February by 7 April (the last day of March,
 * and 7 days), not 17 March. Under annual accounting the return for the year is due by the last
 * working day of the second month after it (reg 50(2)(b)). For an annual accounting period shorter
 * than 4 months, GOV.UK's guidance ("VAT Annual Accounting Scheme: return and payment deadlines") gives
 * 1 month after it; that is guidance, not reg 50. The payment is due by the same day; annual
 * accounting's advance payments are not worked out. By the period's end: from 1 April 2019, when Making
 * Tax Digital for VAT began, every return is made online, so the 7 days are taken for every return; an
 * earlier period made on paper had none (not covered).
 */
export const VAT_RETURN_RULES: readonly { from: ISODate; electronicDays: number; annualMonths: number; annualShortMonths: number; annualShortUnderMonths: number }[] = [
  { from: '2019-04-01', electronicDays: 7, annualMonths: 2, annualShortMonths: 1, annualShortUnderMonths: 4 },
];

/**
 * VAT rates, by the day a supply is made (docs/UK_RULES.md, "VAT rates"): the standard rate (VATA 1994
 * s2(1), 20% from 4 January 2011 by Finance (No. 2) Act 2010 s3) and the reduced rate (s29A, 5%). The
 * temporary rates for hospitality and tourism (5% from 15 July 2020, 12.5% from 1 October 2021 to
 * 31 March 2022) were special rates for those supplies, not changes to these. Earlier rates are not
 * covered: a supply before the first row takes it.
 */
export const VAT_RATES: readonly { from: ISODate; standard: number; reduced: number }[] = [{ from: '2011-01-04', standard: 0.2, reduced: 0.05 }];

/** The VAT rate of a kind in force on a day (`VAT_RATES`). */
export function vatRateOn(date: ISODate, rate: 'standard' | 'reduced'): number {
  return ruleOn(VAT_RATES, date)[rate];
}

/** The last day of the VAT period in a stagger that contains `date` (monthly or quarterly). */
export function vatPeriodEnd(stagger: Exclude<VatStagger, 'annual'>, date: ISODate): ISODate {
  if (stagger === 'monthly') return endOfMonth(date);
  const months = VAT_QUARTER_END_MONTHS[stagger];
  let d = startOfMonth(date);
  while (!months.includes(Number(d.slice(5, 7)))) d = addMonths(d, 1);
  return endOfMonth(d);
}

/** When the VAT return for `period` is due, under `stagger` (`VAT_RETURN_RULES`). */
export function vatReturnDue(period: { start: ISODate; end: ISODate }, stagger: VatStagger): ISODate {
  const r = ruleOn(VAT_RETURN_RULES, period.end);
  // reg 25(1): the last day of the month after the one the period ends in, then the direction's days.
  if (stagger !== 'annual') return addDays(endOfMonth(addMonths(startOfMonth(period.end), 1)), r.electronicDays);
  // GOV.UK's guidance, not reg 50: a period shorter than 4 months (it ends before the last day of 4 months beginning with its start).
  if (period.end < lastDayOfMonths(period.start, r.annualShortUnderMonths)) return monthsAfter(period.end, r.annualShortMonths);
  return lastWorkingDayOfMonth(addMonths(startOfMonth(period.end), r.annualMonths));
}

/** Easter Sunday in a year (the anonymous Gregorian algorithm). */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Whether a day is a working day: not a Saturday or Sunday, and not one of England and Wales's bank
 * holidays that can fall on the last day of a month (Banking and Financial Dealings Act 1971 Sch 1, and
 * Good Friday): Good Friday, Easter Monday, and the last Mondays of May and August. Others never end a
 * month, which is all this is used for (`lastWorkingDayOfMonth`); a holiday moved by proclamation is
 * not known.
 */
export function isMonthEndWorkingDay(date: ISODate): boolean {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return false;
  const easter = easterSunday(Number(date.slice(0, 4)));
  if (date === addDays(easter, -2) || date === addDays(easter, 1)) return false;
  const mm = date.slice(5, 7);
  // The last Monday of May or August: a Monday within its month's last 7 days.
  if ((mm === '05' || mm === '08') && wd === 1 && addDays(date, 7).slice(5, 7) !== mm) return false;
  return true;
}

/** The last working day of the month `date` is in (`isMonthEndWorkingDay`). */
export function lastWorkingDayOfMonth(date: ISODate): ISODate {
  let d = endOfMonth(date);
  while (!isMonthEndWorkingDay(d)) d = addDays(d, -1);
  return d;
}

// ─── VAT returns from a company's books (docs/UK_RULES.md, "VAT returns") ──────────────────────────
//
// What the books' VAT return works with besides the periods and deadlines above: the threshold for
// correcting errors on a later return, HMRC's late submission penalty points, and the registration and
// deregistration thresholds. Each a dated row (`ruleOn`), looked up by the date that decides it.

/**
 * Correcting errors on earlier VAT returns (VAT Notice 700/45 sections 4.2–4.7). The net value of the
 * errors found on earlier returns (the VAT due to HMRC less that due to the company, across them) may be
 * corrected on the current return ("method 1", using its boxes 1 and 4: Notice 700/12 para 6.6) when it
 * is no more than £10,000, or no more than £50,000 and no more than 1% of the box 6 of the return for
 * the period the errors are found in. Above that, or for errors made deliberately, they are reported to
 * HMRC separately ("method 2"), which may be chosen for an error of any size. An error is corrected
 * within 4 years: from the end of the period it was made in for output tax under-declared and input tax
 * over-claimed, from the return's due date for input tax under-claimed (section 4.7; the limit does not
 * apply to deliberate errors). By the day the errors are found: these limits from 1 July 2008 (£2,000
 * before, not covered).
 */
export const VAT_ERROR_CORRECTION_RULES: readonly { from: ISODate; limit: number; upperLimit: number; box6Percent: number; years: number }[] = [{ from: '2008-07-01', limit: 10_000, upperLimit: 50_000, box6Percent: 1, years: 4 }];

/** How a net error (pence, either way) may be corrected, found on `day`, `box6` (whole pounds) being the box 6 of the return for that period. */
export function vatCorrectionMethod(netMinor: number, box6: number, day: ISODate): { method: 'next-return' | 'separately'; limit: 'basic' | 'box6' | 'over'; maxMinor: number } {
  const r = ruleOn(VAT_ERROR_CORRECTION_RULES, day);
  const net = Math.abs(netMinor);
  if (net <= r.limit * 100) return { method: 'next-return', limit: 'basic', maxMinor: r.limit * 100 };
  // 1% of box 6, in pence: box 6 is whole pounds, so 1% of it is box6 pence.
  const onePercent = Math.max(0, box6) * r.box6Percent;
  const upper = Math.min(r.upperLimit * 100, onePercent);
  if (net <= upper) return { method: 'next-return', limit: 'box6', maxMinor: upper };
  return { method: 'separately', limit: 'over', maxMinor: Math.max(r.limit * 100, upper) };
}

/**
 * The last day an error on a return may be corrected (Notice 700/45 section 4.7): 4 years from the end
 * of its period, or for input tax under-claimed from the return's due date. Not for deliberate errors.
 */
export function vatCorrectionDeadline(periodEnd: ISODate, due: ISODate, underClaimedInput: boolean): ISODate {
  const r = ruleOn(VAT_ERROR_CORRECTION_RULES, periodEnd);
  return addYears(underClaimedInput ? due : periodEnd, r.years);
}

/** How often returns are made, for penalty points: annual accounting, quarterly (any stagger) or monthly. */
export type VatFrequency = 'annual' | 'quarterly' | 'monthly';
export const vatFrequencyOf = (stagger: VatStagger): VatFrequency => (stagger === 'annual' ? 'annual' : stagger === 'monthly' ? 'monthly' : 'quarterly');

/**
 * Late submission penalties for VAT returns (Finance Act 2021 s116 and Sch 24; GOV.UK, "Penalty points
 * and penalties if you submit your VAT Return late" and "Remove penalty points you've received after
 * submitting your VAT Return late"), for VAT periods starting on or after 1 January 2023 (default
 * surcharge before, not covered): a point for each return submitted late, nil and repayment returns
 * included, but not the first return after registration, the final one after cancellation or a one-off
 * return. At the threshold for the frequency (annual 2, quarterly 4, monthly 5) a £200 penalty, and
 * another for each later late return while at it. Below it, a point expires on the last day of the month
 * 24 months after the month the return was due (25 when it was due on a month's last day); at it, the
 * points are reset to nothing only after a period of compliance (annual 24 months, quarterly 12, monthly
 * 6) with every return due in the 24 months before submitted. A change of frequency adjusts the points
 * (never below nothing). HMRC keep the official count: these are its rules, for information.
 */
export const VAT_PENALTY_RULES: readonly {
  from: ISODate;
  thresholds: Record<VatFrequency, number>;
  penalty: number;
  expiryMonths: number;
  complianceMonths: Record<VatFrequency, number>;
  outstandingMonths: number;
  frequencyChange: Record<VatFrequency, Record<VatFrequency, number>>;
}[] = [
  {
    from: '2023-01-01',
    thresholds: { annual: 2, quarterly: 4, monthly: 5 },
    penalty: 200,
    expiryMonths: 24,
    complianceMonths: { annual: 24, quarterly: 12, monthly: 6 },
    outstandingMonths: 24,
    frequencyChange: {
      annual: { annual: 0, quarterly: 2, monthly: 3 },
      quarterly: { annual: -2, quarterly: 0, monthly: 1 },
      monthly: { annual: -3, quarterly: -1, monthly: 0 },
    },
  },
];

/** The first day of VAT periods penalty points apply to: earlier periods are under the default surcharge. */
export const VAT_PENALTY_POINTS_FROM = VAT_PENALTY_RULES[0]!.from;

/**
 * When a penalty point for a return due on `due` expires, below the threshold: the last day of the month
 * 24 months after the month it was due, or 25 when it was due on a month's last day (GOV.UK, "Remove
 * penalty points…": the point counts from the month after the failure, the day after the deadline).
 */
export function vatPointExpiry(due: ISODate): ISODate {
  const r = ruleOn(VAT_PENALTY_RULES, due);
  return endOfMonth(addMonths(startOfMonth(due), r.expiryMonths + (isMonthEnd(due) ? 1 : 0)));
}

/**
 * The VAT registration and deregistration thresholds (VATA 1994 Sch 1 paras 1 and 4; VAT Notice 700/1
 * and its supplement's table of earlier limits): a business must register when its taxable turnover in
 * the last 12 months goes over the registration threshold (or is expected to in the next 30 days alone),
 * and may ask to cancel when it falls below the deregistration threshold. Taxable turnover is everything
 * sold that is not exempt or outside the scope, zero-rated sales included, with services received from
 * abroad under the reverse charge (Notice 700 para 5.4; Notice 741A para 5.7), and supplies of the
 * business's capital assets left out (Sch 1 para 1(7)). By the day the test is made.
 */
export const VAT_REGISTRATION_THRESHOLDS: readonly { from: ISODate; registration: number; deregistration: number }[] = [
  { from: '2010-04-01', registration: 70_000, deregistration: 68_000 },
  { from: '2011-04-01', registration: 73_000, deregistration: 71_000 },
  { from: '2012-04-01', registration: 77_000, deregistration: 75_000 },
  { from: '2013-04-01', registration: 79_000, deregistration: 77_000 },
  { from: '2014-04-01', registration: 81_000, deregistration: 79_000 },
  { from: '2015-04-01', registration: 82_000, deregistration: 80_000 },
  { from: '2016-04-01', registration: 83_000, deregistration: 81_000 },
  { from: '2017-04-01', registration: 85_000, deregistration: 83_000 },
  { from: '2024-04-01', registration: 90_000, deregistration: 88_000 },
];

/** The registration and deregistration thresholds in force on a day (`VAT_REGISTRATION_THRESHOLDS`). */
export function vatThresholdsOn(date: ISODate): { from: ISODate; registration: number; deregistration: number } {
  return ruleOn(VAT_REGISTRATION_THRESHOLDS, date);
}
