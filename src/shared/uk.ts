// UK tax-year rules and allowance tables.
//
// Every figure lives in a dated table so that a Budget change is a one-line edit here, not a hunt
// through the codebase. Sources and caveats: docs/UK_RULES.md. When adding a year, add a row to
// TAX_YEAR_PARAMS with only the fields that changed; later years inherit earlier values.

import { addYears, makeDate, type ISODate } from './dates';

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
  },
  {
    from: 2017,
    isaAllowance: 20_000,
    lisaAllowance: 4_000,
    juniorIsaAllowance: 4_128,
    moneyPurchaseAnnualAllowance: 4_000,
    cgtAnnualExemptAmount: 11_300,
    personalAllowance: 11_500,
  },
  { from: 2018, juniorIsaAllowance: 4_260, dividendAllowance: 2_000, cgtAnnualExemptAmount: 11_700, personalAllowance: 11_850 },
  { from: 2019, juniorIsaAllowance: 4_368, cgtAnnualExemptAmount: 12_000, personalAllowance: 12_500 },
  {
    from: 2020,
    juniorIsaAllowance: 9_000,
    pensionTaperThresholdIncome: 200_000,
    pensionTaperAdjustedIncome: 240_000,
    pensionTaperMinimum: 4_000,
    cgtAnnualExemptAmount: 12_300,
  },
  { from: 2021, personalAllowance: 12_570 },
  { from: 2022, dividendTaxRates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 } },
  {
    from: 2023,
    pensionAnnualAllowance: 60_000,
    pensionTaperAdjustedIncome: 260_000,
    pensionTaperMinimum: 10_000,
    moneyPurchaseAnnualAllowance: 10_000,
    dividendAllowance: 1_000,
    cgtAnnualExemptAmount: 6_000,
  },
  { from: 2024, dividendAllowance: 500, cgtAnnualExemptAmount: 3_000, lumpSumAllowance: 268_275 },
  // Autumn Budget 2025: dividend rates +2pp from April 2026.
  { from: 2026, dividendTaxRates: { basic: 0.1075, higher: 0.3575, additional: 0.3935 } },
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
export function grossUpReliefAtSource(net: number): number {
  return Math.round((net / 0.8) * 100) / 100;
}

/** Notable dated rule changes, surfaced as notes in the UI. */
export const RULE_NOTES: { from: ISODate; text: string }[] = [
  { from: '2025-12-01', text: 'FSCS deposit protection rose from £85,000 to £120,000 per person per banking licence.' },
  {
    from: '2027-04-06',
    text: 'Cash ISA subscriptions capped at £12,000 a year for under-65s (overall ISA allowance stays £20,000). Transfers from stocks & shares ISAs into cash ISAs are no longer allowed, and interest on cash held in stocks & shares ISAs is charged at 22%.',
  },
  {
    from: '2028-04-06',
    text: 'Normal minimum pension age rises from 55 to 57. The Lifetime ISA is due to be replaced by a First-Time Buyer ISA for new savers (existing LISAs continue).',
  },
];
