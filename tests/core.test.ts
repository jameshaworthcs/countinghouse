import { describe, expect, it } from 'vitest';
import { addMonths, diffDays, eachMonth, parseFlexibleDate, relativeDays } from '../src/shared/dates';
import { formatMoney, parseAmount, sumMoney, toMinor } from '../src/shared/money';
import { reconcile } from '../src/shared/reconcile';
import {
  ageOn,
  cashIsaLimit,
  fscsDepositLimit,
  lisaPenaltyAdjustedValue,
  parseTaxYear,
  pensionAccessDate,
  pensionAnnualAllowance,
  personalSavingsAllowance,
  taxBandFor,
  taxYear,
  taxYearOf,
  taxYearParams,
} from '../src/shared/uk';

describe('money', () => {
  it.each([
    ['£1,234.56', 1234.56],
    ['-12.34', -12.34],
    ['(12.34)', -12.34],
    ['12.34 CR', 12.34],
    ['12.34DR', -12.34],
    ['−5.00', -5],
    ['5.00-', -5],
    ['+£5', 5],
    ['GBP 5.10', 5.1],
    ['1 234.50', 1234.5],
    ['', null],
    ['abc', null],
    ['12,34', 12.34],
  ])('parseAmount(%j) = %j', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it('sums exactly in pence', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney(Array.from({ length: 1000 }, () => 0.01))).toBe(10);
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(-4.5)).toBe(-450);
  });

  it('formats GBP', () => {
    expect(formatMoney(1234.5)).toBe('£1,234.50');
    expect(formatMoney(-12)).toBe('-£12.00');
    expect(formatMoney(12500, { compact: true })).toBe('£12.5k');
    expect(formatMoney(5, { sign: true })).toBe('+£5.00');
  });
});

describe('dates', () => {
  it.each([
    ['03/04/2026', '2026-04-03'],
    ['3/4/26', '2026-04-03'],
    ['2026-09-26', '2026-09-26'],
    ['2026-09-26 14:30:00', '2026-09-26'],
    ['20260926120000[0:GMT]', '2026-09-26'],
    ['26 Sep 2026', '2026-09-26'],
    ['26-Sep-26', '2026-09-26'],
    ['Fri 26th September 2026', '2026-09-26'],
    ['Sep 26, 2026', '2026-09-26'],
    ['09/26/2026', '2026-09-26'],
    ['31/02/2026', null],
    ['nonsense', null],
  ])('parseFlexibleDate(%j) = %j (UK day-first)', (input, expected) => {
    expect(parseFlexibleDate(input)).toBe(expected);
  });

  it('respects explicit US order', () => {
    expect(parseFlexibleDate('03/04/2026', 'MDY')).toBe('2026-03-04');
  });

  it('fills a missing year when asked', () => {
    expect(parseFlexibleDate('26 Sep', 'DMY', { defaultYear: 2025 })).toBe('2025-09-26');
  });

  it('clamps month arithmetic', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(diffDays('2026-01-01', '2026-03-01')).toBe(59);
    expect(eachMonth('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(relativeDays('2026-09-01', '2026-09-28')).toBe('4 weeks ago');
  });
});

describe('UK rules', () => {
  it('splits tax years on 6 April', () => {
    expect(taxYearOf('2026-04-05').label).toBe('2025/26');
    expect(taxYearOf('2026-04-06').label).toBe('2026/27');
    expect(taxYear(2026)).toEqual({ label: '2026/27', startYear: 2026, start: '2026-04-06', end: '2027-04-05' });
    expect(parseTaxYear('2025-26')?.label).toBe('2025/26');
    expect(parseTaxYear('2025/27')).toBeNull();
  });

  it('knows the allowances', () => {
    expect(taxYearParams(2026).isaAllowance).toBe(20_000);
    expect(taxYearParams(2016).isaAllowance).toBe(15_240);
    expect(taxYearParams(2026).lisaAllowance).toBe(4_000);
    expect(taxYearParams(2022).pensionAnnualAllowance).toBe(40_000);
    expect(taxYearParams(2023).pensionAnnualAllowance).toBe(60_000);
    expect(taxYearParams(2026).dividendAllowance).toBe(500);
    expect(taxYearParams(2026).cgtAnnualExemptAmount).toBe(3_000);
    expect(taxYearParams(2026).dividendTaxRates.basic).toBe(0.1075);
    expect(taxYearParams(2027).savingsTaxRates.basic).toBe(0.22);
  });

  it('caps cash ISAs for under-65s from 2027/28', () => {
    expect(cashIsaLimit(taxYear(2026), '1990-01-01')).toBe(20_000);
    expect(cashIsaLimit(taxYear(2027), '1990-01-01')).toBe(12_000);
    expect(cashIsaLimit(taxYear(2027))).toBe(12_000);
    // Turns 65 during 2027/28 (on 1 Jan 2028): full allowance from the start of that tax year.
    expect(cashIsaLimit(taxYear(2027), '1963-01-01')).toBe(20_000);
  });

  it('tapers the pension annual allowance', () => {
    expect(pensionAnnualAllowance(taxYear(2026))).toBe(60_000);
    expect(pensionAnnualAllowance(taxYear(2026), { threshold: 250_000, adjusted: 300_000 })).toBe(40_000);
    expect(pensionAnnualAllowance(taxYear(2026), { threshold: 400_000, adjusted: 500_000 })).toBe(10_000);
    expect(pensionAnnualAllowance(taxYear(2026), { threshold: 150_000, adjusted: 300_000 })).toBe(60_000);
  });

  it('handles pension access age, PSA, FSCS and LISA penalty', () => {
    expect(pensionAccessDate('1970-06-01')).toBe('2025-06-01');
    expect(pensionAccessDate('1975-06-01')).toBe('2032-06-01');
    expect(personalSavingsAllowance(taxYear(2026), 'higher')).toBe(500);
    expect(personalSavingsAllowance(taxYear(2026), undefined)).toBe(1_000);
    expect(fscsDepositLimit('2025-11-30')).toBe(85_000);
    expect(fscsDepositLimit('2025-12-01')).toBe(120_000);
    expect(lisaPenaltyAdjustedValue(10_000, taxYear(2026))).toBe(7_500);
    expect(ageOn('1990-09-29', '2026-09-28')).toBe(35);
  });
});

describe('tax band', () => {
  const band = (nonSavings: number, savings = 0, dividends = 0, bandExtension = 0, year = 2026) => taxBandFor(taxYear(year), { nonSavings, savings, dividends, bandExtension });

  it('places income in the band its highest pound reaches', () => {
    expect(band(11_000).band).toBe('none');
    expect(band(30_000)).toMatchObject({ band: 'basic', personalAllowance: 12_570, taxable: 17_430, higherFrom: 37_700 });
    // Interest and dividends count: 45,000 + 6,000 is 38,430 taxable, over the 37,700 basic band.
    expect(band(45_000, 6_000).band).toBe('higher');
    expect(band(12_570, 0, 40_000).band).toBe('higher');
  });

  it('widens the bands by relief-at-source pension contributions and Gift Aid', () => {
    expect(band(45_000, 6_000, 0, 1_000)).toMatchObject({ band: 'basic', higherFrom: 38_700, additionalFrom: 126_140 });
  });

  it('tapers the personal allowance above £100,000 and uses each year’s thresholds', () => {
    expect(band(110_000)).toMatchObject({ band: 'higher', personalAllowance: 7_570, taxable: 102_430 });
    expect(band(130_000)).toMatchObject({ band: 'additional', personalAllowance: 0 });
    // Pension contributions lower adjusted net income, restoring allowance.
    expect(band(110_000, 0, 0, 10_000).personalAllowance).toBe(12_570);
    // Until 2022/23 the additional rate started at £150,000.
    expect(band(140_000, 0, 0, 0, 2022).band).toBe('higher');
  });
});

describe('reconcile', () => {
  it('checks opening + transactions = closing and running balances', () => {
    const ok = reconcile({
      openingBalance: 100,
      closingBalance: 70.5,
      transactions: [
        { date: '2026-09-01', amount: -20, balanceAfter: 80 },
        { date: '2026-09-02', amount: -9.5, balanceAfter: 70.5 },
      ],
    });
    expect(ok.status).toBe('ok');
    const bad = reconcile({ openingBalance: 100, closingBalance: 70, transactions: [{ date: '2026-09-01', amount: -20 }] });
    expect(bad.status).toBe('mismatch');
    expect(bad.difference).toBe(-10);
    expect(reconcile({ transactions: [{ date: '2026-09-01', amount: 1 }] }).status).toBe('unknown');
  });
});
