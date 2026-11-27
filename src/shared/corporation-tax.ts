// The arithmetic of a company's Corporation Tax computation (docs/FORMULAS.md §22, "Corporation Tax"):
// a period's financial years, the tax on its profits with marginal relief, and the period's share of a
// year for allowances and limits. Pure: integer pence (or whole pounds where the CT600 takes them), ISO
// dates as strings counted with shared/dates.ts, the rules from the dated tables in shared/uk.ts.
//
// The assembly from a company's books (what is profit, what is capital, the pools and losses carried
// from one period to the next) is analytics/corporation-tax.ts.

import { addDays, diffDays, type ISODate } from './dates';
import { apportion, mulDivRound } from './money';
import { CT_RATES, ctRatesFor, financialYearOf, lastDayOfMonths } from './uk';

/** Days of a period, both ends counted. */
export const daysOf = (start: ISODate, end: ISODate): number => diffDays(start, end) + 1;

/** Whether a period is 12 months long (so a full year's allowances and limits): it ends on the last day of 12 months beginning with its start. */
export const isYear = (start: ISODate, end: ISODate): boolean => end === lastDayOfMonths(start, 12);

/**
 * A period's share of a year, as a fraction num ÷ den: 1 for 12 months; otherwise its days ÷ 365. The
 * limits and allowances given for a year are "proportionately" reduced for a shorter period (CAA 2001
 * s51A(6) for the annual investment allowance, s56(3) for writing-down allowances, s56A for small pools;
 * CTA 2010 s18D(4) for the small profits limits). The Acts do not say how; HMRC works it by days
 * (CTM03930: "strictly the calculation should be carried out by reference to the number of days in the
 * short AP"), and the app over 365.
 */
export function yearShare(start: ISODate, end: ISODate): { num: number; den: number } {
  return isYear(start, end) ? { num: 1, den: 1 } : { num: daysOf(start, end), den: 365 };
}

/** A part of a period in one financial year. */
export interface FyPart {
  fy: number;
  start: ISODate;
  end: ISODate;
  days: number;
}

/** A period split at each 1 April into its financial years (CTA 2010 s8(3): profits are apportioned between them). */
export function fyParts(start: ISODate, end: ISODate): FyPart[] {
  const out: FyPart[] = [];
  let cursor = start;
  while (cursor <= end) {
    const fy = financialYearOf(cursor);
    const fyEnd = `${fy + 1}-03-31`;
    const partEnd = fyEnd < end ? fyEnd : end;
    out.push({ fy, start: cursor, end: partEnd, days: daysOf(cursor, partEnd) });
    cursor = addDays(partEnd, 1);
  }
  return out;
}

/** One financial year's part of the tax (pence; the profit in whole pounds). */
export interface TaxPart extends FyPart {
  profit: number;
  rate: number;
  band: 'small' | 'marginal' | 'main' | 'single';
  lower?: number;
  upper?: number;
  tax: number;
  marginalRelief: number;
  net: number;
}

/** Days in a financial year (366 when it holds 29 February). */
export const daysInFinancialYear = (fy: number): number => daysOf(`${fy}-04-01`, `${fy + 1}-03-31`);

/**
 * The Corporation Tax on a period's taxable total profits (whole pounds), by financial year:
 *
 * - the profits are apportioned between the financial years by days (CTA 2009 s8(5); CTA 2010 s1172's
 *   time basis; `apportion`, so the parts are whole pounds adding up to the whole);
 * - a year with one rate charges it on its part;
 * - from FY 2023, the years whose limits are the same are taken together (HMRC's CTM03640: the period
 *   is split only where the limits differ). The lower and upper limits L are divided by one more than
 *   the number of associated companies (CTA 2010 s18D(3)) and reduced proportionately (s18D(4)): for
 *   the whole period, by its days ÷ 365 when it is shorter than 12 months (CTM03930: "strictly … by
 *   reference to the number of days"); for a part treated as a period of its own where the limits
 *   differ, by its days ÷ the days of its financial year (CTM03955). With augmented profits A taken as
 *   the profits N (no exempt distributions are tracked: s18L), N ≤ L pays the small profits rate (s18A);
 *   L < N ≤ U the main rate less marginal relief F × (U − N) (s18B, the fraction N ÷ A being 1), shared
 *   between the years by days; more, the main rate;
 * - a close investment-holding company pays the main rate on all its profits (s18A(1)(b), s18B(1)(b),
 *   s18N).
 *
 * Tax is pence: a whole-pound profit at a whole-number rate is exact; marginal relief is rounded to the
 * penny, half away from nothing. `unsupported` when a year is before the rates covered.
 */
export function taxOnProfits(input: { start: ISODate; end: ISODate; profit: number; associated: number; closeInvestmentHolding: boolean }): { parts: TaxPart[]; unsupported?: string } {
  const { start, end, profit, associated, closeInvestmentHolding } = input;
  const fys = fyParts(start, end);
  const shares = apportion(profit, fys.map((p) => p.days));
  const rates = fys.map((p) => ctRatesFor(p.fy));
  const missing = fys.find((_, i) => !rates[i]);
  if (missing) return { parts: [], unsupported: `the financial year ${missing.fy} is before the rates covered here (from FY ${CT_RATES[0]!.fy})` };
  const limitsKey = (i: number) => {
    const r = rates[i]!;
    return r.small === undefined ? `single:${i}` : `${r.lower}|${r.upper}|${r.fraction?.n}/${r.fraction?.d}`;
  };
  // Consecutive years with the same limits, together.
  const groups: number[][] = [];
  fys.forEach((_, i) => (groups.length && limitsKey(groups.at(-1)![0]!) === limitsKey(i) ? groups.at(-1)!.push(i) : groups.push([i])));
  const parts: TaxPart[] = [];
  for (const g of groups) {
    const r = rates[g[0]!]!;
    if (r.small === undefined || r.lower === undefined || r.upper === undefined || !r.fraction) {
      for (const i of g) parts.push({ ...fys[i]!, profit: shares[i]!, rate: r.main, band: 'single', tax: shares[i]! * r.main, marginalRelief: 0, net: shares[i]! * r.main });
      continue;
    }
    // The limits' share: num ÷ den of a year.
    const whole = g.length === fys.length;
    const { num, den } = whole ? yearShare(start, end) : { num: fys[g[0]!]!.days, den: daysInFinancialYear(fys[g[0]!]!.fy) };
    const mult = den * (1 + associated);
    const n = g.reduce((x, i) => x + shares[i]!, 0);
    const limits = { lower: mulDivRound(r.lower * 100, num, mult), upper: mulDivRound(r.upper * 100, num, mult) };
    // Compared exactly: N ≤ L × num ÷ mult is N × mult ≤ L × num.
    const band: TaxPart['band'] = closeInvestmentHolding ? 'main' : n * mult <= r.lower * num ? 'small' : n * mult <= r.upper * num ? 'marginal' : 'main';
    const rate = band === 'small' ? r.small : r.main;
    // F × (U − N) in pence: F.n × 100 × (upper × num − N × mult) ÷ (F.d × mult), shared between the years by days.
    const relief = band === 'marginal' ? mulDivRound(100 * (r.upper * num - n * mult), r.fraction.n, r.fraction.d * mult) : 0;
    const reliefs = apportion(relief, g.map((i) => fys[i]!.days));
    g.forEach((i, k) => {
      const tax = shares[i]! * rate;
      parts.push({ ...fys[i]!, profit: shares[i]!, rate, band, ...limits, tax, marginalRelief: reliefs[k]!, net: tax - reliefs[k]! });
    });
  }
  return { parts };
}

/**
 * A pool's writing-down allowance rate for a period, in hundredths of a percent: the rate in force on
 * its first day; for a period running over a change, the hybrid rate X = r₁ × BRD ÷ CP + r₂ × ARD ÷ CP
 * (BRD and ARD the days before and on or after the change, CP the period's days), rounded up to two
 * decimal places (FA 2019 s31(5)–(7) for the special rate, FA 2026 s28 for the main rate).
 */
export function wdaRateHundredths(rows: readonly { from: ISODate; main: number; special: number }[], pool: 'main' | 'special', start: ISODate, end: ISODate): number {
  const at = (d: ISODate) => rows.filter((r) => r.from <= d).at(-1) ?? rows[0]!;
  const r1 = at(start)[pool];
  const change = rows.find((r) => r.from > start && r.from <= end && r[pool] !== r1);
  if (!change) return r1 * 100;
  const cp = daysOf(start, end);
  const brd = diffDays(start, change.from);
  const ard = cp - brd;
  // Rounded up: the ceiling of 100 × (r₁ × BRD + r₂ × ARD) ÷ CP.
  const scaled = 100 * (r1 * brd + change[pool] * ard);
  return Math.floor(scaled / cp) + (scaled % cp ? 1 : 0);
}

/** A yearly amount (pence) for a period: in full for 12 months, else × days ÷ 365 (`yearShare`), rounded to the penny. */
export function forPeriod(yearlyMinor: number, start: ISODate, end: ISODate): number {
  const s = yearShare(start, end);
  return mulDivRound(yearlyMinor, s.num, s.den);
}

/**
 * A writing-down allowance (pence): the pool's balance × the yearly rate (hundredths of a percent) × the period's share
 * of a year (CAA 2001 s56(1), (3)), rounded to the penny.
 */
export function writingDown(available: number, rateHundredths: number, start: ISODate, end: ISODate): number {
  if (available <= 0) return 0;
  const s = yearShare(start, end);
  return mulDivRound(available, rateHundredths * s.num, 10_000 * s.den);
}
