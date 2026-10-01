// What a payroll takes from a month's pay (src/shared/paye.ts; docs/FORMULAS.md §17, "Expected pay"):
// tax codes, PAYE on a month-1 or cumulative basis, and employee NI. All figures are invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { employeeNi, parseTaxCode, payeTax, standardTaxCode, taxMonth } from '../src/shared/paye';
import { taxYear } from '../src/shared/uk';

describe('tax codes', () => {
  it('reads the codes payslips print', () => {
    expect(parseTaxCode('1257L')).toMatchObject({ code: '1257L', kind: 'allowance', number: 1257, cumulative: true, region: 'ruk' });
    expect(parseTaxCode('1257L M1')).toMatchObject({ code: '1257L M1', kind: 'allowance', number: 1257, cumulative: false });
    expect(parseTaxCode('1257l w1')).toMatchObject({ code: '1257L W1', cumulative: false });
    expect(parseTaxCode('1257LX')).toMatchObject({ code: '1257L X', cumulative: false });
    expect(parseTaxCode('K475')).toMatchObject({ kind: 'k', number: 475 });
    expect(parseTaxCode('BR')).toMatchObject({ kind: 'br' });
    expect(parseTaxCode('D0')).toMatchObject({ kind: 'd0' });
    expect(parseTaxCode('0T M1')).toMatchObject({ kind: 'allowance', number: 0, cumulative: false });
    expect(parseTaxCode('NT')).toMatchObject({ kind: 'nt' });
    expect(parseTaxCode('S1257L')).toMatchObject({ region: 'scotland', number: 1257 });
    expect(parseTaxCode('C1257L')).toMatchObject({ region: 'wales', number: 1257 });
    expect(parseTaxCode('hello')).toBeNull();
    expect(parseTaxCode('')).toBeNull();
    expect(standardTaxCode(taxYear(2026), false).code).toBe('1257L M1');
  });

  it('counts tax months from 6 April', () => {
    expect(taxMonth('2026-04-06')).toBe(1);
    expect(taxMonth('2026-05-05')).toBe(1);
    expect(taxMonth('2026-05-06')).toBe(2);
    expect(taxMonth('2026-10-23')).toBe(7);
    expect(taxMonth('2027-01-05')).toBe(9);
    expect(taxMonth('2027-04-05')).toBe(12);
  });
});

describe('PAYE on a month’s pay', () => {
  const m1 = parseTaxCode('1257L M1')!;
  const cumulative = parseTaxCode('1257L')!;

  it('month 1: the month’s allowance off, taxable pay rounded down to the pound, 20% on it', () => {
    // £1,320 − £1,048.25 = £271.75 → £271 → £54.20.
    expect(payeTax({ gross: 1320, payDate: '2026-07-24', code: m1 })).toBe(54.2);
    expect(payeTax({ gross: 900, payDate: '2026-07-24', code: m1 })).toBe(0);
    // Into the higher rate: £3,142 at 20% then 40%.
    expect(payeTax({ gross: 5000, payDate: '2026-07-24', code: m1 })).toBe(Math.round((3142 * 0.2 + (5000 - 1048.25 - 3142 - 0.75) * 0.4) * 100) / 100);
  });

  it('cumulative: pay and allowance to date, less the tax already paid; a refund when it is less', () => {
    // Month 4 (24 July): allowance £4,193; £1,320 now and £2,000 before is under it, so the £150 paid comes back.
    expect(payeTax({ gross: 1320, payDate: '2026-07-24', code: cumulative, previousPay: 2000, previousTax: 150 })).toBe(-150);
    // Month 1 with nothing before: the same as month 1.
    expect(payeTax({ gross: 1320, payDate: '2026-04-24', code: cumulative })).toBe(54.2);
  });

  it('BR, D0, NT and a K code (never more than half the pay)', () => {
    expect(payeTax({ gross: 1000.6, payDate: '2026-07-24', code: parseTaxCode('BR')! })).toBe(200);
    expect(payeTax({ gross: 1000, payDate: '2026-07-24', code: parseTaxCode('D0')! })).toBe(400);
    expect(payeTax({ gross: 1000, payDate: '2026-07-24', code: parseTaxCode('NT')! })).toBe(0);
    // K475 adds £396.58 a month: £1,396 taxable → £279.20, under half of £1,000.
    expect(payeTax({ gross: 1000, payDate: '2026-07-24', code: parseTaxCode('K475 M1')! })).toBe(279.2);
    expect(payeTax({ gross: 100, payDate: '2026-07-24', code: parseTaxCode('K475 M1')! })).toBe(50);
  });

  it('a Scottish code is not worked out', () => {
    expect(payeTax({ gross: 2000, payDate: '2026-07-24', code: parseTaxCode('S1257L')! })).toBeNull();
  });

  it('month 1 tax never falls as pay rises, and is never more than 45% of it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: 50_000 }), (pence, extra) => {
        const a = payeTax({ gross: pence / 100, payDate: '2026-09-25', code: m1 })!;
        const b = payeTax({ gross: (pence + extra) / 100, payDate: '2026-09-25', code: m1 })!;
        return b >= a && a <= (pence / 100) * 0.45 + 0.01;
      }),
    );
  });
});

describe('employee NI', () => {
  it('8% between £1,048 and £4,189 a month, 2% above', () => {
    expect(employeeNi(1320, '2026-07-24')).toBe(21.76);
    expect(employeeNi(1000, '2026-07-24')).toBe(0);
    expect(employeeNi(5000, '2026-07-24')).toBe(267.5);
    // 2024/25 has the same rates; years before are not modelled.
    expect(employeeNi(1320, '2024-07-24')).toBe(21.76);
    expect(employeeNi(1320, '2023-07-24')).toBeNull();
  });

  it('paid in one month, two months’ pay costs more NI than in two', () => {
    const together = employeeNi(640 + 1480, '2026-09-25')!;
    const apart = employeeNi(640, '2026-09-25')! + employeeNi(1480, '2026-09-25')!;
    expect(together).toBe(85.76);
    expect(Math.round((together - apart) * 100) / 100).toBe(51.2);
  });
});
