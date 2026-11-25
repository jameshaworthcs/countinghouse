// The Self Assessment liability (docs/FORMULAS.md §20; shared/taxcalc.ts), checked against results
// established independently of the code: HMRC's own worked examples (GOV.UK pages, helpsheets and
// manuals, with the figures they print), sixteen 2025/26 scenarios worked out by an independent model
// from HMRC's primary sources and its online calculation specification, and properties that must hold
// for any income. Every person and figure here is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeTax, taxForAllowanceSplit, type TaxCalcInput } from '../src/shared/taxcalc';
import { taxYear } from '../src/shared/uk';

const ty = taxYear(2025);
const tax = (input: Omit<TaxCalcInput, 'ty'>) => computeTax({ ty, ...input });

describe('HMRC’s worked examples, for 2025/26', () => {
  it('the starting rate for savings: £200 of interest on £16,000 of wages is not taxed (GOV.UK, “Tax on savings interest”)', () => {
    const r = tax({ nonSavings: { employment: 16000 }, savings: 200, dividends: 0 });
    expect(r.lines.find((l) => l.id === 'savings-starting')).toMatchObject({ amount: 200, tax: 0 });
    expect(r.incomeTaxDue).toBe(686);
  });

  it('the Personal Savings Allowance: £1,300 of interest for a basic rate taxpayer, £60 on the £300 over it', () => {
    const r = tax({ nonSavings: { employment: 30000 }, savings: 1300, dividends: 0 });
    expect(r.lines.filter((l) => l.id.startsWith('savings')).reduce((s, l) => s + (l.tax ?? 0), 0)).toBe(60);
  });

  it('dividends: £3,000 on £29,570 of wages, no tax on £500 and 8.75% on £2,500 (GOV.UK “Tax on dividends”, at 2025/26 rates)', () => {
    expect(tax({ nonSavings: { employment: 29570 }, savings: 0, dividends: 3000 }).incomeTaxDue).toBe(3618.75);
  });

  it('capital gains tax: 18% within the basic rate band, 24% above it (GOV.UK “Capital Gains Tax rates”)', () => {
    // Taxable income £20,000 is £32,570 of pay less the personal allowance.
    expect(tax({ nonSavings: { employment: 32570 }, savings: 0, dividends: 0, gains: { gains: 12600, losses: 0 } }).capitalGains?.tax).toBe(1728);
    expect(tax({ nonSavings: { employment: 32570 }, savings: 0, dividends: 0, gains: { gains: 52600, losses: 0 } }).capitalGains?.tax).toBe(10842);
  });

  it('losses brought forward only reduce gains to the annual exempt amount (CG21520)', () => {
    const r = tax({ nonSavings: { employment: 20000 }, savings: 0, dividends: 0, gains: { gains: 16300, losses: 3500, broughtForward: 10500 } }).capitalGains!;
    // 2025/26's £3,000 exempt amount: £12,800 net, £9,800 of the £10,500 used, nothing taxable.
    expect(r).toMatchObject({ net: 12800, broughtForwardUsed: 9800, taxable: 0, tax: 0 });
    // Gains under the exempt amount use no losses brought forward.
    expect(tax({ nonSavings: { employment: 20000 }, savings: 0, dividends: 0, gains: { gains: 2850, losses: 0, broughtForward: 5000 } }).capitalGains).toMatchObject({ broughtForwardUsed: 0, tax: 0 });
  });

  it('adjusted net income takes off pension contributions and Gift Aid grossed up (GOV.UK “Adjusted net income”: Clara)', () => {
    const r = tax({ nonSavings: { employment: 65000 }, savings: 5000, dividends: 0, bandExtension: { reliefAtSource: 4750, giftAid: 1250 }, childBenefit: 2000 });
    expect(r.adjustedNetIncome).toBe(64000);
    // 20% of the benefit: (£64,000 − £60,000) ÷ £200.
    expect(r.hicbc).toBe(400);
  });

  it('the High Income Child Benefit Charge rounds the benefit, the percentage and the charge down (PAYE14015, corrected: £532, not the £453 printed)', () => {
    expect(tax({ nonSavings: { employment: 68000 }, savings: 0, dividends: 0, childBenefit: 1331.2 }).hicbc).toBe(532);
    expect(tax({ nonSavings: { employment: 80000 }, savings: 0, dividends: 0, childBenefit: 2251.2 }).hicbc).toBe(2251);
    expect(tax({ nonSavings: { employment: 60199 }, savings: 0, dividends: 0, childBenefit: 2251.2 }).hicbc).toBe(0);
  });

  it('student loans through Self Assessment: Plan 1, £42,000 of pay and profits, 9% over £26,065, whole pounds down (GOV.UK, at the 2025/26 threshold)', () => {
    expect(tax({ nonSavings: { employment: 10000, selfEmployment: 32000 }, savings: 0, dividends: 0, studentLoan: { plans: ['plan1'], deductedByEmployers: 0 } }).studentLoan).toMatchObject({ due: 1434, payable: 1434 });
  });

  it('student loans: unearned income counts in full once over £2,000, and relief-at-source pension contributions come off', () => {
    const under = tax({ nonSavings: { employment: 30000 }, savings: 1999, dividends: 0, studentLoan: { plans: ['plan2'], deductedByEmployers: 0 } }).studentLoan!;
    const over = tax({ nonSavings: { employment: 30000 }, savings: 2001, dividends: 0, studentLoan: { plans: ['plan2'], deductedByEmployers: 0 } }).studentLoan!;
    expect(under).toMatchObject({ unearnedCounted: false, income: 30000, due: 137 });
    expect(over).toMatchObject({ unearnedCounted: true, income: 32001, due: 317 });
    expect(tax({ nonSavings: { employment: 30000 }, savings: 0, dividends: 0, bandExtension: { reliefAtSource: 1000 }, studentLoan: { plans: ['plan2'], deductedByEmployers: 0 } }).studentLoan!.income).toBe(29000);
  });

  it('no student loan repayment is due through the 2025/26 return for a Plan 5 loan', () => {
    expect(tax({ nonSavings: { employment: 40000 }, savings: 5000, dividends: 0, studentLoan: { plans: ['plan5'], deductedByEmployers: 0 } }).studentLoan).toMatchObject({ due: 0, payable: 0 });
  });

  it('Class 4 National Insurance: 6% between £12,570 and £50,270, 2% above (SA110 notes)', () => {
    expect(tax({ nonSavings: { employment: 0, selfEmployment: 30000 }, savings: 0, dividends: 0 }).class4).toBe(1045.8);
    expect(tax({ nonSavings: { employment: 0, selfEmployment: 60000 }, savings: 0, dividends: 0 }).class4).toBe(2456.6);
  });

  it('payments on account in a first year: a £3,000 bill means £4,500 due in January (GOV.UK “Payments on account”)', () => {
    // £3,000 left after tax at source, which is at least 20% of the year's.
    const r = tax({ nonSavings: { employment: 0, selfEmployment: 27570 }, savings: 0, dividends: 0, deducted: { other: 0 } });
    const left = r.incomeTaxDue + r.class4;
    expect(r.paymentsOnAccount.reason).toBe('due');
    expect(r.paymentsOnAccount.first + r.paymentsOnAccount.second).toBeCloseTo(left, 2);
    expect(r.dueJanuary).toBeCloseTo(left + r.paymentsOnAccount.first, 2);
  });
});

describe('the personal allowance goes where it saves most tax (ITA 2007 s.25(2))', () => {
  it('low pay, interest and dividends: setting it against the dividends lets the interest use the starting rate and the savings allowance', () => {
    expect(tax({ nonSavings: { employment: 5000 }, savings: 8000, dividends: 1000 }).incomeTaxDue).toBe(0);
    expect(tax({ nonSavings: { employment: 0 }, savings: 5000, dividends: 10000 }).incomeTaxDue).toBe(0);
    const r = tax({ nonSavings: { employment: 8000 }, savings: 6000, dividends: 12000 });
    expect(r.allowanceUsed).toEqual({ nonSavings: 8000, savings: 0, dividends: 4570 });
    expect(r.incomeTaxDue).toBe(606.37);
  });

  it('a higher rate taxpayer gains nothing from moving it (SAIM1110 at 2025/26 rates; each band’s tax to the penny, down)', () => {
    // £6,686 + £200 + £198.62 (£2,270 at 8.75%) + £752.62 (£2,230 at 33.75%).
    expect(tax({ nonSavings: { employment: 46000 }, savings: 1500, dividends: 5000 }).incomeTaxDue).toBe(7837.24);
  });
});

/**
 * Sixteen 2025/26 scenarios worked out by an independent model (GPT) from HMRC's primary sources,
 * including HMRC's online calculation specification: income in whole pounds as the return gives it
 * to the calculation, tax already taken off in pounds and pence.
 */
const ORACLE: { id: string; input: Omit<TaxCalcInput, 'ty'>; incomeTax: number; class4?: number; cgt?: number; studentLoan?: number; hicbc?: number; liability: number; balancing: number; dueJanuary: number; dueJuly: number }[] = [
  { id: 'S1 three jobs, interest, UK and US dividends with relief, small gains', input: { nonSavings: { employment: 15400 + 2610 + 1830 }, savings: 2130, dividends: 4815, foreignDividends: [{ label: 'USA', amount: 15, taxTaken: 2.34 }], gains: { gains: 300, losses: 140 }, deducted: { paye: 1012.4 } }, incomeTax: 2056.25, liability: 2056.25, balancing: 1043.85, dueJanuary: 1565.77, dueJuly: 521.93 },
  { id: 'S2 starting rate for savings', input: { nonSavings: { employment: 14000 }, savings: 4000, dividends: 0, deducted: { paye: 286 } }, incomeTax: 286, liability: 286, balancing: 0, dueJanuary: 0, dueJuly: 0 },
  { id: 'S3 dividends across the basic rate limit', input: { nonSavings: { employment: 45000 }, savings: 3000, dividends: 8000, deducted: { paye: 6486 } }, incomeTax: 9074.74, liability: 9074.74, balancing: 2588.74, dueJanuary: 3883.11, dueJuly: 1294.37 },
  { id: 'S4 personal allowance taper with pension and Gift Aid', input: { nonSavings: { employment: 110000 }, savings: 500, dividends: 2000, bandExtension: { reliefAtSource: 5000, giftAid: 1000 }, deducted: { paye: 33432 } }, incomeTax: 32038.25, liability: 32038.25, balancing: -1393.75, dueJanuary: 0, dueJuly: 0 },
  { id: 'S5 additional rate: no savings allowance, mostly taxed at source', input: { nonSavings: { employment: 160000 }, savings: 2000, dividends: 10000, deducted: { paye: 58703 } }, incomeTax: 62841.25, liability: 62841.25, balancing: 4138.25, dueJanuary: 4138.25, dueJuly: 0 },
  { id: 'S6 Child Benefit charge', input: { nonSavings: { employment: 66000 }, savings: 0, dividends: 0, bandExtension: { reliefAtSource: 2500 }, childBenefit: 2251.2, deducted: { paye: 13886 } }, incomeTax: 13332, hicbc: 382, liability: 13714, balancing: -172, dueJanuary: 0, dueJuly: 0 },
  { id: 'S7 Plan 2 loan with unearned income over £2,000', input: { nonSavings: { employment: 32000 }, savings: 1500, dividends: 1200, studentLoan: { plans: ['plan2'], deductedByEmployers: 318 }, deducted: { paye: 3886 } }, incomeTax: 4047.25, studentLoan: 242, liability: 4289.25, balancing: 403.25, dueJanuary: 403.25, dueJuly: 0 },
  { id: 'S8 self-employment beside a job', input: { nonSavings: { employment: 20000, selfEmployment: 18000 }, savings: 0, dividends: 0, deducted: { paye: 1486 } }, incomeTax: 5086, class4: 325.8, liability: 5411.8, balancing: 3925.8, dueJanuary: 5888.7, dueJuly: 1962.9 },
  { id: 'S9 gains over the band, losses brought forward', input: { nonSavings: { employment: 40000 }, savings: 0, dividends: 0, gains: { gains: 25000, losses: 2000, broughtForward: 1500 }, deducted: { paye: 5486 } }, incomeTax: 5486, cgt: 3823.8, liability: 9309.8, balancing: 3823.8, dueJanuary: 3823.8, dueJuly: 0 },
  { id: 'S10 Gift Aid widening the band for dividends', input: { nonSavings: { employment: 48000 }, savings: 0, dividends: 6000, bandExtension: { giftAid: 2500 }, deducted: { paye: 7086 } }, incomeTax: 7874.74, liability: 7874.74, balancing: 788.74, dueJanuary: 788.74, dueJuly: 0 },
  { id: 'S11 low pay, savings and dividends', input: { nonSavings: { employment: 8000 }, savings: 6000, dividends: 12000 }, incomeTax: 606.37, liability: 606.37, balancing: 606.37, dueJanuary: 606.37, dueJuly: 0 },
  { id: 'S12 car benefit less professional subscriptions', input: { nonSavings: { employment: 38000 + 4200 - 300 }, savings: 0, dividends: 0, deducted: { paye: 5486 } }, incomeTax: 5866, liability: 5866, balancing: 380, dueJanuary: 380, dueJuly: 0 },
  { id: 'S13 Marriage Allowance received', input: { nonSavings: { employment: 26000 }, savings: 1200, dividends: 0, marriageAllowance: 'received', deducted: { paye: 2686 } }, incomeTax: 2474, liability: 2474, balancing: -212, dueJanuary: 0, dueJuly: 0 },
  { id: 'S14 near the taper, with gains', input: { nonSavings: { employment: 99000 }, savings: 4000, dividends: 3000, gains: { gains: 9000, losses: 0 }, deducted: { paye: 29432 } }, incomeTax: 30475.75, cgt: 1440, liability: 31915.75, balancing: 2483.75, dueJanuary: 2483.75, dueJuly: 0 },
  { id: 'S15 a Scottish taxpayer', input: { scottish: true, nonSavings: { employment: 45000 }, savings: 3000, dividends: 8000, deducted: { paye: 6486 } }, incomeTax: 9502.54, liability: 9502.54, balancing: 3016.54, dueJanuary: 4524.81, dueJuly: 1508.27 },
  { id: 'S16 Plan 1, unearned income under £2,000', input: { nonSavings: { employment: 24000 }, savings: 1800, dividends: 0, studentLoan: { plans: ['plan1'], deductedByEmployers: 0 }, deducted: { paye: 2286 } }, incomeTax: 2446, liability: 2446, balancing: 160, dueJanuary: 160, dueJuly: 0 },
];

describe('sixteen 2025/26 scenarios worked out independently', () => {
  for (const s of ORACLE)
    it(s.id, () => {
      const r = tax(s.input);
      expect({ incomeTax: r.incomeTaxDue, class4: r.class4, cgt: r.capitalGains?.tax ?? 0, studentLoan: r.studentLoan?.payable ?? 0, hicbc: r.hicbc, liability: r.totalLiability, balancing: r.balancing, dueJanuary: Math.max(0, r.dueJanuary), dueJuly: r.dueJuly }).toEqual({
        incomeTax: s.incomeTax,
        class4: s.class4 ?? 0,
        cgt: s.cgt ?? 0,
        studentLoan: s.studentLoan ?? 0,
        hicbc: s.hicbc ?? 0,
        liability: s.liability,
        balancing: s.balancing,
        dueJanuary: s.dueJanuary,
        dueJuly: s.dueJuly,
      });
    });

  it('payments on account: the odd penny goes on the second (S1: £521.92 and £521.93)', () => {
    expect(tax(ORACLE[0]!.input).paymentsOnAccount).toMatchObject({ first: 521.92, second: 521.93, reason: 'due' });
  });
});

describe('paying through the tax code (HMRC’s payments on account stage, c13.5–c13.16)', () => {
  const base: Omit<TaxCalcInput, 'ty'> = { nonSavings: { employment: 45000 }, savings: 3000, dividends: 8000, deducted: { paye: 6486 } };
  it('a balance under £3,000 coded out leaves nothing to pay in January and no payments on account', () => {
    const r = tax({ ...base, codeOut: true });
    expect(r).toMatchObject({ codable: 2588.74, codedOut: 2588.74, dueJanuary: 0, dueJuly: 0 });
    expect(r.paymentsOnAccount.reason).toBe('coded-out');
  });
  it('a balance of £3,000 or more cannot be', () => {
    const r = tax({ ...base, dividends: 12000, codeOut: true });
    expect(r.codable).toBe(0);
    expect(r.paymentsOnAccount.reason).toBe('due');
  });
  it('a refund HMRC paid in the year adds to the balance, but not to the payments on account', () => {
    const plain = tax(base);
    const r = tax({ ...base, refundedInYear: 100 });
    expect(r.balancing).toBeCloseTo(plain.balancing + 100, 2);
    expect(r.paymentsOnAccount).toEqual(plain.paymentsOnAccount);
  });
  it('earlier years’ tax collected through the code is not this year’s tax taken off', () => {
    expect(tax({ ...base, earlierYearsInCode: 200 }).balancing).toBeCloseTo(tax(base).balancing + 200, 2);
    expect(tax({ ...base, thisYearInNextCode: 500 }).balancing).toBeCloseTo(tax(base).balancing - 500, 2);
  });
});

describe('properties of any year', () => {
  const pounds = (max: number) => fc.integer({ min: 0, max });
  const income = fc.record({ employment: pounds(250_000), savings: pounds(40_000), dividends: pounds(60_000), ras: pounds(20_000), gift: pounds(5_000) });
  const run = (i: { employment: number; savings: number; dividends: number; ras: number; gift: number }) => tax({ nonSavings: { employment: i.employment }, savings: i.savings, dividends: i.dividends, bandExtension: { reliefAtSource: i.ras, giftAid: i.gift } });

  it('the tax lines add up to the tax charged, and every amount is pounds and pence', () => {
    fc.assert(
      fc.property(income, (i) => {
        const r = run(i);
        const sum = r.lines.reduce((s, l) => s + Math.round((l.tax ?? 0) * 100), 0);
        expect(sum).toBe(Math.round(r.incomeTaxCharged * 100));
        for (const v of [r.incomeTaxCharged, r.totalLiability, r.balancing]) expect(Math.round(v * 100) / 100).toBe(v);
        // The slices taxed are exactly the taxable income.
        expect(r.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(Math.round(r.taxableIncome * 100));
      }),
      { numRuns: 300 },
    );
  });

  it('a pound more of any income never lowers the tax, and never raises it by more than the top rate with the taper', () => {
    fc.assert(
      fc.property(income, fc.constantFrom<'employment' | 'savings' | 'dividends'>('employment', 'savings', 'dividends'), (i, kind) => {
        const a = run(i).incomeTaxCharged;
        const b = run({ ...i, [kind]: i[kind] + 1 }).incomeTaxCharged;
        expect(b).toBeGreaterThanOrEqual(a);
        // The taper takes the allowance down in whole pounds, so a pound can bring in two more taxed,
        // and push as much savings or dividends up a band: never more than £1.50 (checked by brute force).
        expect(b - a).toBeLessThanOrEqual(1.5);
      }),
      { numRuns: 300 },
    );
  });

  it('the allowance set against each kind of income never exceeds it, and adds up to the allowance used', () => {
    fc.assert(
      fc.property(income, (i) => {
        const r = run(i);
        expect(r.allowanceUsed.nonSavings).toBeLessThanOrEqual(i.employment);
        expect(r.allowanceUsed.savings).toBeLessThanOrEqual(i.savings);
        expect(r.allowanceUsed.dividends).toBeLessThanOrEqual(i.dividends);
        expect(r.allowanceUsed.nonSavings + r.allowanceUsed.savings + r.allowanceUsed.dividends).toBe(Math.min(r.personalAllowance, i.employment + i.savings + i.dividends));
      }),
      { numRuns: 300 },
    );
  });

  it('no split of the allowance between pay, savings and dividends leaves less tax than the one chosen', () => {
    fc.assert(
      fc.property(fc.record({ employment: pounds(60_000), savings: pounds(20_000), dividends: pounds(30_000) }), fc.integer({ min: 0, max: 12_570 }), fc.integer({ min: 0, max: 12_570 }), (i, toNs, toSv) => {
        const input: TaxCalcInput = { ty, nonSavings: { employment: i.employment }, savings: i.savings, dividends: i.dividends };
        expect(computeTax(input).incomeTaxCharged).toBeLessThanOrEqual(taxForAllowanceSplit(input, toNs, toSv));
      }),
      { numRuns: 800 },
    );
  });

});

/**
 * Cases an independent review (GPT) worked out from HMRC's online calculation specification and
 * helpsheets, where an earlier version of the engine was wrong.
 */
describe('regressions from the independent review', () => {
  it('the allowance moves off pay when that keeps interest within the savings allowance in the higher band (ITA 2007 s.25(2); c5.52h)', () => {
    const r = tax({ nonSavings: { employment: 50070 }, savings: 700, dividends: 0, deducted: { paye: 7500 } });
    expect(r.incomeTaxCharged).toBe(7540);
    expect(r.balancing).toBe(40);
  });

  it('Foreign Tax Credit Relief source by source: US and Canadian dividends, £90 each taken off, credit £157.50, not £180 pooled (HS263)', () => {
    const r = tax({ nonSavings: { employment: 58000 }, savings: 1100, dividends: 1300, foreignDividends: [{ label: 'USA', amount: 600, taxTaken: 90 }, { label: 'CAN', amount: 600, taxTaken: 90 }], deducted: { paye: 10632 } });
    expect(r.incomeTaxCharged).toBe(11142);
    expect(r.reducers.find((x) => x.id === 'foreign-tax-credit')!.tax).toBe(-157.5);
    expect(r.balancing).toBe(352.5);
  });

  it('Foreign Tax Credit Relief counts the Child Benefit charge the dividend brings in (HS263 §6.2)', () => {
    const r = tax({ nonSavings: { employment: 59800 }, savings: 0, dividends: 600, foreignDividends: [{ label: 'USA', amount: 600, taxTaken: 90 }], childBenefit: 1500, deducted: { paye: 11352 } });
    expect(r.hicbc).toBe(30);
    expect(r.reducers.find((x) => x.id === 'foreign-tax-credit')!.tax).toBe(-63.75);
    expect(r.balancing).toBe(0);
  });

  it('Gift Aid your tax does not cover is charged: £800 given, £76 of tax, £124 more (ITA 2007 s.424)', () => {
    const r = tax({ nonSavings: { employment: 12950 }, savings: 200, dividends: 0, bandExtension: { giftAid: 1000 }, deducted: { paye: 76 } });
    expect(r.giftAidCharge).toBe(124);
    expect(r.balancing).toBe(124);
  });

  it('relief-at-source contributions widen the bands only up to the higher of £3,600 and relevant earnings (FA 2004 s.190)', () => {
    const r = tax({ nonSavings: { employment: 10000 }, savings: 0, dividends: 60000, bandExtension: { reliefAtSource: 20000 } });
    expect(r.bandExtension).toBe(10000);
    expect(r.reliefAtSourceOverCap).toBe(10000);
  });

  it('Marriage Allowance: a Scottish taxpayer paying the Scottish higher rate cannot receive it; interest within the savings allowance does not stop it', () => {
    expect(tax({ scottish: true, nonSavings: { employment: 46000 }, savings: 1450, dividends: 700, marriageAllowance: 'received', deducted: { paye: 7333.8 } })).toMatchObject({ marriageAllowanceRefused: true, balancing: 107.5 });
    expect(tax({ nonSavings: { employment: 50000 }, savings: 500, dividends: 0, marriageAllowance: 'received', deducted: { paye: 7486 } })).toMatchObject({ marriageAllowanceRefused: false, incomeTaxDue: 7234, balancing: -252 });
    // Transferring it while paying higher rate tax: the claim does not apply, and the full allowance stays.
    expect(tax({ nonSavings: { employment: 54000 }, savings: 0, dividends: 0, marriageAllowance: 'transferred' })).toMatchObject({ marriageAllowanceRefused: true, personalAllowance: 12570 });
  });

  it('SA110 box 9 takes no more than the PAYE; box 7 adds in full (c11.5–c11.8, c12.6); an in-year refund and payments on account made', () => {
    const r = tax({ nonSavings: { employment: 30000 }, savings: 0, dividends: 0, deducted: { paye: 90.25 }, outstandingDebtInCode: 40, earlierYearsInCode: 120, thisYearInNextCode: 50.5, refundedInYear: 125.75, paymentsOnAccountMade: 800 });
    expect(r.incomeTaxDue).toBe(3486);
    expect(r.paymentsOnAccount).toMatchObject({ first: 1752.62, second: 1752.63 });
    expect(r.balancing).toBe(2831);
    expect(r.dueJanuary).toBe(4583.62);
  });

  it('payments on account: under 20% of the year’s tax is compared exactly (c13.13)', () => {
    const r = tax({ nonSavings: { employment: 34067 }, savings: 0, dividends: 8507, deducted: { paye: 4000.01 } });
    expect(r.incomeTaxDue).toBe(5000.01);
    expect(r.paymentsOnAccount.reason).toBe('mostly-at-source');
    expect(r.dueJanuary).toBe(1000);
  });

  it('an overpaid balance is set against January’s payment on account (c13.17)', () => {
    const r = tax({ nonSavings: { employment: 50000 }, savings: 0, dividends: 0, deducted: { paye: 3000 }, paymentsOnAccountMade: 5000 });
    expect(r.balancing).toBe(-514);
    expect(r.paymentsOnAccount).toMatchObject({ first: 2243, second: 2243 });
    expect(r).toMatchObject({ dueJanuary: 1729, dueJuly: 2243 });
  });

  it('coding out what is left after payments on account made leaves the instalments due (c13.5–c13.16)', () => {
    const r = tax({ nonSavings: { employment: 50000 }, savings: 0, dividends: 0, deducted: { paye: 3000 }, paymentsOnAccountMade: 4000, codeOut: true });
    expect(r.codedOut).toBe(486);
    expect(r).toMatchObject({ dueJanuary: 2000, dueJuly: 2000 });
  });
});
