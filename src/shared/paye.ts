// What an employer's payroll takes from one month's pay: PAYE income tax from a tax code, and
// employee Class 1 National Insurance (docs/FORMULAS.md §17, "Expected pay"). Estimates of pay not
// yet paid; a payslip's own figures always stand. Rates and thresholds come from uk.ts.
//
// Monthly pay only. England, Wales and Northern Ireland income tax rates (a Welsh "C" code uses the
// same rates); Scottish codes are recognised but not worked out.

import type { ISODate } from './dates';
import { fromMinor, toMinor } from './money';
import { taxYearOf, taxYearParams, type TaxYear } from './uk';

export interface TaxCode {
  /** As written, tidied: "1257L M1". */
  code: string;
  /**
   * allowance: a personal allowance of `number` × 10 + 9 a year (L, M, N, T codes, and 0T);
   * k: that much added to pay instead; br, d0, d1: all pay at the basic, higher or additional rate;
   * nt: no tax.
   */
  kind: 'allowance' | 'k' | 'br' | 'd0' | 'd1' | 'nt';
  number: number;
  /** False for an emergency, "week 1/month 1" code (M1, W1, X): each month on its own. */
  cumulative: boolean;
  region: 'ruk' | 'wales' | 'scotland';
}

/** Read a PAYE tax code: "1257L", "1257L M1", "K475", "BR", "S1257L", "C1257L X". Null when it is not one. */
export function parseTaxCode(input: string): TaxCode | null {
  let s = input.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let cumulative = true;
  const nonCumulative = /\s*(?:W1|M1|X|W1\/M1)$/.exec(s);
  if (nonCumulative) {
    cumulative = false;
    s = s.slice(0, nonCumulative.index).trim();
  }
  s = s.replace(/\s+/g, '');
  let region: TaxCode['region'] = 'ruk';
  if (/^[SC](?=\d|K|BR|D\d|NT|0T)/.test(s)) {
    region = s[0] === 'S' ? 'scotland' : 'wales';
    s = s.slice(1);
  }
  const code = input.toUpperCase().replace(/\s+/g, '').replace(/(W1|M1|X)$/, ' $1');
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,5})[LMNT]$/.exec(s))) return { code, kind: 'allowance', number: Number(m[1]), cumulative, region };
  if (s === '0T') return { code, kind: 'allowance', number: 0, cumulative, region };
  if ((m = /^K(\d{1,5})$/.exec(s))) return { code, kind: 'k', number: Number(m[1]), cumulative, region };
  if (s === 'BR') return { code, kind: 'br', number: 0, cumulative, region };
  if (s === 'D0') return { code, kind: 'd0', number: 0, cumulative, region };
  if (s === 'D1') return { code, kind: 'd1', number: 0, cumulative, region };
  if (s === 'NT') return { code, kind: 'nt', number: 0, cumulative, region };
  return null;
}

/** The code anyone with the standard personal allowance has in a tax year: "1257L" for £12,570. */
export function standardTaxCode(ty: TaxYear, cumulative: boolean): TaxCode {
  const n = Math.floor(taxYearParams(ty).personalAllowance / 10);
  return { code: `${n}L${cumulative ? '' : ' M1'}`, kind: 'allowance', number: n, cumulative, region: 'ruk' };
}

/** The tax month a pay day falls in: month 1 runs 6 April to 5 May, month 12 to 5 April. */
export function taxMonth(date: ISODate): number {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return ((month - (day >= 6 ? 4 : 5) + 12) % 12) + 1;
}

/** A code's allowance (or, for K, the pay added) for `months` months, in pence: (n × 10 + 9) × months ÷ 12. */
function allowanceMinor(number: number, months: number): number {
  return Math.round(((number * 10 + 9) * 100 * months) / 12);
}

export interface PayeInput {
  /** This month's pay, before tax. */
  gross: number;
  payDate: ISODate;
  code: TaxCode;
  /** Cumulative codes: pay and tax with this employer earlier in the tax year. */
  previousPay?: number;
  previousTax?: number;
}

/**
 * PAYE income tax on one month's pay, in pounds (negative: a refund). Taxable pay is rounded down to
 * whole pounds; the bands are the year's, pro rata to the months counted (rounded up to whole
 * pounds). A K code's tax is capped at half the month's pay. Null for a Scottish code.
 */
export function payeTax(input: PayeInput): number | null {
  const { code } = input;
  if (code.region === 'scotland') return null;
  const ty = taxYearOf(input.payDate);
  const p = taxYearParams(ty);
  const months = code.cumulative ? taxMonth(input.payDate) : 1;
  const payMinor = toMinor(input.gross) + (code.cumulative ? toMinor(input.previousPay ?? 0) : 0);
  const paidMinor = code.cumulative ? toMinor(input.previousTax ?? 0) : 0;
  const rate = (r: number, poundsTaxable: number) => Math.round(poundsTaxable * 100 * r);
  let dueMinor: number;
  if (code.kind === 'nt') dueMinor = 0;
  else if (code.kind === 'br' || code.kind === 'd0' || code.kind === 'd1') {
    const r = code.kind === 'br' ? p.incomeTaxRates.basic : code.kind === 'd0' ? p.incomeTaxRates.higher : p.incomeTaxRates.additional;
    dueMinor = rate(r, Math.floor(Math.max(0, payMinor) / 100));
  } else {
    const adjust = allowanceMinor(code.number, months);
    const taxable = Math.max(0, Math.floor((code.kind === 'k' ? payMinor + adjust : payMinor - adjust) / 100));
    const basicTop = Math.ceil((p.basicRateLimit * months) / 12);
    const higherTop = Math.ceil(((p.additionalRateThreshold - p.personalAllowance) * months) / 12);
    dueMinor =
      rate(p.incomeTaxRates.basic, Math.min(taxable, basicTop)) +
      rate(p.incomeTaxRates.higher, Math.max(0, Math.min(taxable, higherTop) - basicTop)) +
      rate(p.incomeTaxRates.additional, Math.max(0, taxable - higherTop));
  }
  let thisMonth = dueMinor - paidMinor;
  if (code.kind === 'k') thisMonth = Math.min(thisMonth, Math.floor(toMinor(input.gross) / 2));
  return fromMinor(thisMonth);
}

/**
 * Employee Class 1 NI (category A) on one month's pay: the main rate between the monthly primary
 * threshold and upper earnings limit, the upper rate above it. NI is worked out pay period by pay
 * period, never over the year. Null for a tax year not modelled.
 */
export function employeeNi(gross: number, payDate: ISODate): number | null {
  const ni = taxYearParams(taxYearOf(payDate)).employeeNi;
  if (!ni) return null;
  const pay = toMinor(gross);
  const pt = ni.primaryThresholdMonthly * 100;
  const uel = ni.upperEarningsLimitMonthly * 100;
  const main = Math.max(0, Math.min(pay, uel) - pt) * ni.mainRate;
  const upper = Math.max(0, pay - uel) * ni.upperRate;
  // To the penny, a half penny down (HMRC's exact percentage method).
  const total = main + upper;
  const floor = Math.floor(total);
  return fromMinor(total - floor > 0.5 + 1e-9 ? floor + 1 : floor);
}
