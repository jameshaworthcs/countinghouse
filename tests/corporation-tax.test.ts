// A company's Corporation Tax computation from its books (docs/FORMULAS.md §22, "Corporation Tax";
// analytics/corporation-tax.ts, shared/corporation-tax.ts, shared/ct600.ts): the tax by financial year
// with marginal relief (HMRC's own worked examples), writing-down allowances at a hybrid rate, the
// accounts' profit shared out by days, adjustments, pre-trading expenditure and plant, capital
// allowances (the annual investment allowance, full expensing and its balancing charge, connected
// persons, small pools), losses and non-trading deficits carried forward, the CT600's boxes, readiness
// and the CSV. Pure functions over an in-memory source, and properties. Every name and figure is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CompanyCtResponse, CtComputationView } from '../src/shared/api';
import { BalanceEngine, type BalanceSource } from '../src/server/analytics/balances';
import { companyCorporationTax, ctComputationCsv } from '../src/server/analytics/corporation-tax';
import { companyLedger, type LedgerSource } from '../src/server/analytics/ledger';
import { transactionId } from '../src/server/ids';
import { daysInFinancialYear, fyParts, taxOnProfits, wdaRateHundredths, writingDown } from '../src/shared/corporation-tax';
import { CT600_BOXES, profitBoxes } from '../src/shared/ct600';
import { CT_DISCLAIMER } from '../src/shared/disclaimers';
import { assetTaxProblems, codingProblems } from '../src/shared/ledger';
import { booksProblems } from '../src/shared/company-books';
import { SettingsSchema, type Account, type BalanceSnapshot, type BooksCoding, type Company, type Journal, type Transaction } from '../src/shared/schema';
import { WDA_RATES } from '../src/shared/uk';

const stamp = '2024-01-01T00:00:00+00:00';
const CO = 'example-loom';
const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
type Books = NonNullable<Company['books']>;
/** Incorporated on 1 January 2024, its year to 31 December, trading from the start, not registered for VAT. */
const booksOf = (extra: Partial<Books> = {}): Books => ({ incorporatedOn: '2024-01-01', accountingReferenceDate: '12-31', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp, tradeStartedOn: '2024-01-01', withinChargeFrom: '2024-01-01', policies: [{ class: 'computer', months: 36 }], ...extra });
const companyOf = (books: Partial<Books> = {}): Company => ({ id: CO, name: 'Example Loom Ltd', number: '01234567', holdings: [], valuations: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp, books: booksOf(books) });
const coded = (ledger: string, extra: Partial<BooksCoding> = {}): BooksCoding => ({ ledger, setBy: 'user', ...extra });
const ACCOUNTS: Account[] = [acct('current', 'Everyday', 'current'), acct('loom-bank', 'Loom Account', 'current', { companyId: CO, includeInNetWorth: false })];
const bank = (date: string, amount: number, description: string, books?: BooksCoding) => tx('loom-bank', date, amount, description, books ? { books } : {});

function memory(rows: Transaction[], company: Company, journals: Journal[] = []): LedgerSource {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const companyOfAccount = (id: string) => ACCOUNTS.find((a) => a.id === id)?.companyId;
  return {
    balances: () => [],
    transactions: (accountId?: string) => (accountId ? sorted.filter((t) => t.accountId === accountId) : sorted.filter((t) => !companyOfAccount(t.accountId))),
    transaction: (id) => byId.get(id),
    account: (id) => ACCOUNTS.find((a) => a.id === id),
    company: (id) => (id === CO ? company : undefined),
    companyAccounts: (id) => ACCOUNTS.filter((a) => a.companyId === id),
    companyTransactions: (id) => sorted.filter((t) => companyOfAccount(t.accountId) === id),
    companyJournals: (id) => journals.filter((j) => j.companyId === id),
    bookRules: () => [],
  };
}

/** The company's balance engine, with a statement balance at each day given (the books' own balance then, opening balance included), so its accounts reconcile. */
function engineOf(src: LedgerSource, days: string[], opening = 0): BalanceEngine {
  const rows = src.companyTransactions(CO);
  const snaps: BalanceSnapshot[] = days.map((d, i) => ({ id: `bal_${i.toString(16).padStart(16, '0')}`, accountId: 'loom-bank', date: d, balance: Math.round((opening + rows.filter((t) => t.date <= d).reduce((x, t) => x + t.amount, 0)) * 100) / 100, currency: 'GBP', kind: 'statement', dateSource: 'document', source: {}, createdAt: stamp }));
  const source: BalanceSource = { accounts: src.companyAccounts(CO), settings: SettingsSchema.parse({}), transactions: (id?: string) => (id ? rows.filter((t) => t.accountId === id) : rows), balances: (id?: string) => snaps.filter((b) => !id || b.accountId === id) };
  return new BalanceEngine(source);
}

function ct(rows: Transaction[], books: Partial<Books>, opts: { today?: string; period?: string; journals?: Journal[]; statements?: string[]; opening?: number } = {}): CompanyCtResponse {
  const company = companyOf(books);
  const src = memory(rows, company, opts.journals);
  const today = opts.today ?? '2026-06-30';
  return companyCorporationTax({ src, company, engine: engineOf(src, opts.statements ?? ['2024-06-30', '2024-12-31', '2025-12-31', '2026-06-29'], opts.opening), today, period: opts.period })!;
}
const boxes = (v: CtComputationView) => Object.fromEntries(v.boxes.map((b) => [b.box, b.value]));
const kinds = (v: CtComputationView) => v.checks.map((c) => c.kind);

describe('the tax by financial year', () => {
  it('splits a period at 1 April by days', () => {
    expect(fyParts('2024-01-01', '2024-12-31')).toEqual([
      { fy: 2023, start: '2024-01-01', end: '2024-03-31', days: 91 },
      { fy: 2024, start: '2024-04-01', end: '2024-12-31', days: 275 },
    ]);
    expect(daysInFinancialYear(2023)).toBe(366);
    expect(daysInFinancialYear(2024)).toBe(365);
  });

  it('follows HMRC’s example of a period straddling 1 April 2023, where the limits change (CTM03955)', () => {
    // AP to 31 December 2023, profits £175,000, two associated companies: FY 2022 at 19% on 90/365, FY 2023
    // on 275/365 against limits of £50,000 and £250,000 × 275/366 ÷ 3, above the upper: the main rate.
    const t = taxOnProfits({ start: '2023-01-01', end: '2023-12-31', profit: 175_000, associated: 2, closeInvestmentHolding: false });
    expect(t.parts.map((p) => [p.fy, p.profit, p.rate, p.band, p.tax])).toEqual([
      [2022, 43_151, 19, 'single', 819_869],
      [2023, 131_849, 25, 'main', 3_296_225],
    ]);
    expect(t.parts[1]).toMatchObject({ lower: 1_252_277, upper: 6_261_384 });
    expect(t.parts.reduce((x, p) => x + p.net, 0)).toBe(4_116_094);
  });

  it('gives marginal relief on a short period, the limits reduced by its days (CTM03930, by days rather than months)', () => {
    // 1 January to 30 September 2024 (274 days), profits £55,000: U = 250,000 × 274/365 = £187,671.23;
    // relief 3/200 × (187,671.23 − 55,000) = £1,990.07; tax £13,750 − £1,990.07.
    const t = taxOnProfits({ start: '2024-01-01', end: '2024-09-30', profit: 55_000, associated: 0, closeInvestmentHolding: false });
    expect(t.parts.map((p) => p.band)).toEqual(['marginal', 'marginal']);
    expect(t.parts.reduce((x, p) => x + p.tax, 0)).toBe(1_375_000);
    expect(t.parts.reduce((x, p) => x + p.marginalRelief, 0)).toBe(199_007);
  });

  it('charges the small profits rate up to the lower limit and the main rate above the upper, a close investment-holding company the main rate', () => {
    const at = (profit: number, extra: Partial<Parameters<typeof taxOnProfits>[0]> = {}) => taxOnProfits({ start: '2024-04-01', end: '2025-03-31', profit, associated: 0, closeInvestmentHolding: false, ...extra }).parts;
    expect(at(50_000).map((p) => [p.band, p.net])).toEqual([['small', 950_000]]);
    expect(at(50_001).map((p) => p.band)).toEqual(['marginal']);
    expect(at(250_000).map((p) => [p.band, p.marginalRelief, p.net])).toEqual([['marginal', 0, 6_250_000]]);
    expect(at(250_001).map((p) => p.band)).toEqual(['main']);
    expect(at(10_000, { closeInvestmentHolding: true }).map((p) => [p.band, p.net])).toEqual([['main', 250_000]]);
    // One associated company halves the limits.
    expect(at(30_000, { associated: 1 }).map((p) => p.band)).toEqual(['marginal']);
    expect(at(25_000, { associated: 1 }).map((p) => p.band)).toEqual(['small']);
    // Before FY 2015: not covered.
    expect(taxOnProfits({ start: '2014-01-01', end: '2014-12-31', profit: 100, associated: 0, closeInvestmentHolding: false }).unsupported).toMatch(/FY 2015/);
  });

  it('as a property: tax rises with profits, between the small profits rate and the main rate, continuous at the limits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400_000 }), fc.integer({ min: 0, max: 3 }), (profit, associated) => {
        const tax = (p: number) => taxOnProfits({ start: '2024-04-01', end: '2025-03-31', profit: p, associated, closeInvestmentHolding: false }).parts.reduce((x, y) => x + y.net, 0);
        const t = tax(profit);
        expect(t).toBeGreaterThanOrEqual(profit * 19);
        expect(t).toBeLessThanOrEqual(profit * 25);
        expect(tax(profit + 1)).toBeGreaterThanOrEqual(t);
        // One more pound never costs more than the marginal rate (26.5%), plus a penny of rounding.
        expect(tax(profit + 1) - t).toBeLessThanOrEqual(2_651);
      }),
    );
  });
});

describe('writing-down allowances', () => {
  it('takes the hybrid rate over 1 April 2026 for the main pool, rounded up (FA 2026 s28), and over 1 April 2019 for the special rate pool (FA 2019 s31)', () => {
    // 182 days at 18% and 183 at 14%: 5,838 ÷ 365 = 15.9945…, rounded up to 16.00%.
    expect(wdaRateHundredths(WDA_RATES, 'main', '2025-10-01', '2026-09-30')).toBe(1_600);
    expect(wdaRateHundredths(WDA_RATES, 'main', '2026-04-01', '2027-03-31')).toBe(1_400);
    expect(wdaRateHundredths(WDA_RATES, 'main', '2025-04-01', '2026-03-31')).toBe(1_800);
    // 90 days at 8% and 275 at 6%: 2,370 ÷ 365 = 6.4931…, rounded up to 6.50%.
    expect(wdaRateHundredths(WDA_RATES, 'special', '2019-01-01', '2019-12-31')).toBe(650);
    expect(wdaRateHundredths(WDA_RATES, 'special', '2025-01-01', '2025-12-31')).toBe(600);
  });
  it('is the rate on the pool, reduced for a period shorter than a year', () => {
    expect(writingDown(1_000_000, 1_800, '2024-01-01', '2024-12-31')).toBe(180_000);
    expect(writingDown(1_000_000, 1_800, '2024-07-01', '2024-12-31')).toBe(90_740); // × 184/365
    expect(writingDown(0, 1_800, '2024-01-01', '2024-12-31')).toBe(0);
  });
});

describe('the profit boxes in whole pounds', () => {
  it('rounds each figure to the pound and adds the totals from the rounded boxes, never below nothing', () => {
    const p = profitBoxes({ turnover: 6_000_049, tradingProfit: 10_040, lossesAgainstTrading: 0, nonTradingProfits: 40, lossesAgainstTotal: 10_080, deficitsAgainstTotal: 0 });
    expect(p).toMatchObject({ b145: 60_000, b155: 100, b165: 100, b170: 0, b235: 100, b285: 100, b300: 0, b315: 0 });
    expect(profitBoxes({ turnover: null, tradingProfit: null, lossesAgainstTrading: 0, nonTradingProfits: 4_050, lossesAgainstTotal: 0, deficitsAgainstTotal: 0 })).toMatchObject({ b145: null, b155: null, b165: null, b170: 41, b315: 41 });
  });
});

/** A trading year: sales, software, entertaining, a laptop, interest; the year to 31 December 2024. */
const YEAR = [
  bank('2024-02-01', 10_000, 'SHARES PAID', coded('share-capital')),
  bank('2024-03-15', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
  bank('2024-09-15', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
  bank('2024-04-10', -2_000, 'EXAMPLE SOFTWARE LTD', coded('software-hosting')),
  bank('2024-05-20', -300, 'EXAMPLE RESTAURANT', coded('entertainment')),
  bank('2024-06-03', -1_500, 'EXAMPLE COMPUTERS LTD', coded('fixed-assets:computer:cost', { asset: { class: 'computer' } })),
  bank('2024-12-31', 120, 'INTEREST', coded('interest-receivable')),
];

describe('a trading year', () => {
  const r = ct(YEAR, { closeInvestmentHolding: false }, { period: '2024-12-31' });
  const v = r.computation!;

  it('starts from the accounts’ profit and adds back what is not deductible, takes interest out to non-trading profits', () => {
    // Depreciation: £1,500 over 36 months, June to December counted (7 months): £291.67.
    const byCode = Object.fromEntries(v.accounts.lines.map((l) => [l.ledger, [l.amount, l.basis]]));
    expect(byCode).toMatchObject({ turnover: [6_000_000, 'days'], 'software-hosting': [-200_000, 'days'], entertainment: [-30_000, 'days'], depreciation: [-29_167, 'days'], 'interest-receivable': [12_000, 'date'] });
    expect(v.accounts.profit).toBe(6_000_000 - 200_000 - 30_000 - 29_167 + 12_000);
    expect(v.adjustments.map((a) => [a.kind, a.ledger, a.amount])).toEqual([
      ['non-trading', 'interest-receivable', -12_000],
      ['disallowable', 'depreciation', 29_167],
      ['disallowable', 'entertainment', 30_000],
    ]);
    expect(v.beforeAllowances).toBe(5_800_000);
  });

  it('gives the laptop the annual investment allowance, and charges the profits with marginal relief', () => {
    expect(v.capitalAllowances.assets.map((a) => [a.treatment, a.qualifying, a.aia, a.toPool])).toEqual([['aia', 150_000, 150_000, 0]]);
    expect(v.capitalAllowances.net).toBe(150_000);
    expect(v.tradingResult).toBe(5_650_000);
    expect(v.nonTrading).toMatchObject({ credits: 12_000, net: 12_000 });
    expect(v.chargeable).toEqual({ exact: 5_662_000, whole: 56_620 });
    // 12 months (366 days), the limits whole: 25% of £56,620 = £14,155, less 3/200 × (£250,000 − £56,620) = £2,900.70.
    expect(v.tax).toMatchObject({ atRates: 1_415_500, marginalRelief: 290_070, chargeable: 1_125_430 });
    expect(v.tax.parts.map((p) => [p.fy, p.profit, p.marginalRelief])).toEqual([
      [2023, 14_078, 72_121],
      [2024, 42_542, 217_949],
    ]);
    expect(v.payable).toBe(1_125_430);
  });

  it('fills the CT600’s boxes, with labels from the form and working for each', () => {
    expect(boxes(v)).toMatchObject({ 1: 'Example Loom Ltd', 2: '01234567', 3: null, 4: 0, 30: '2024-01-01', 35: '2024-12-31', 145: 60_000, 155: 56_500, 165: 56_500, 170: 120, 235: 56_620, 295: 0, 300: 56_620, 315: 56_620, 326: null, 327: 0, 328: 0, 329: true, 330: 2023, 335: 14_078, 340: 25, 345: 351_950, 380: 2024, 385: 42_542, 390: 25, 395: 1_063_550, 430: 1_415_500, 435: 290_070, 440: 1_125_430, 475: 1_125_430, 480: null, 528: 1_125_430, 690: 1_500, 705: 1_500, 775: 1_500 });
    for (const b of v.boxes) {
      expect(b.working.length).toBeGreaterThan(3);
      expect(CT600_BOXES.find((d) => d.box === b.box)?.label).toBe(b.label);
    }
    expect(v.boxes.find((b) => b.box === '690')).toMatchObject({ column: 'Capital allowances', label: 'Annual investment allowance' });
  });

  it('is ready once its accounts are, and offers nothing to pay only when there is nothing', () => {
    expect(v.checks).toEqual([]);
    expect(v.ready).toBe(true);
    expect(r.periods.find((p) => p.end === '2024-12-31')).toMatchObject({ status: 'ready', payable: 1_125_430 });
    expect(v.period.offerNothingToPay).toBeUndefined();
    // Its accounts not reconciled to a statement: not ready.
    const unreconciled = ct(YEAR, { closeInvestmentHolding: false }, { period: '2024-12-31', statements: [] }).computation!;
    expect(kinds(unreconciled)).toContain('accounts-not-ready');
  });

  it('exports the boxes as CSV ending with the disclaimer', () => {
    const csv = ctComputationCsv(companyOf(), { form: r.form, disclaimer: r.disclaimer, computation: v }, (x) => (/[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x)));
    expect(csv).toContain('528,');
    expect(csv).toContain('11254.30');
    expect(csv.trim().split('\n').at(-1)).toBe(`"${CT_DISCLAIMER.replace(/"/g, '""')}"`);
    expect(r.disclaimer).toBe(CT_DISCLAIMER);
    expect(r.form.version).toMatch(/CT600 \(2026\) Version 3/);
  });
});

describe('before the trade starts', () => {
  // Within the charge from incorporation (its bank interest), trading from 1 July 2024: two CT periods in the year to 31 December.
  const rows = [
    bank('2024-01-05', 5_000, 'SHARES PAID', coded('share-capital')),
    bank('2024-01-10', -50, 'COMPANIES HOUSE', coded('formation-costs')),
    bank('2024-02-12', -1_200, 'EXAMPLE SOFTWARE LTD', coded('software-hosting')),
    bank('2024-03-01', -900, 'EXAMPLE COMPUTERS LTD', coded('fixed-assets:computer:cost', { asset: { class: 'computer' } })),
    bank('2024-05-31', 40, 'INTEREST', coded('interest-receivable')),
    bank('2024-08-20', 20_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
    bank('2024-09-02', -600, 'EXAMPLE SOFTWARE LTD', coded('software-hosting')),
    bank('2024-11-30', 60, 'INTEREST', coded('interest-receivable')),
  ];
  const books = { tradeStartedOn: '2024-07-01' };

  it('ends a CT period the day before the trade starts; nothing trades before it, interest is still taxed, and expenses wait', () => {
    const r = ct(rows, { ...books, closeInvestmentHolding: false }, { period: '2024-06-30' });
    const v = r.computation!;
    expect(r.periods.map((p) => [p.start, p.end, p.phase])).toEqual([
      ['2024-01-01', '2024-06-30', 'pre-trading'],
      ['2024-07-01', '2024-12-31', 'trading'],
      ['2025-01-01', '2025-12-31', 'trading'],
      ['2026-01-01', '2026-12-31', 'trading'],
    ]);
    expect(v.tradingResult).toBe(0);
    expect(v.beforeAllowances).toBe(0);
    expect(v.adjustments.map((a) => [a.kind, a.ledger, a.amount])).toEqual([
      ['non-trading', 'interest-receivable', -4_000],
      ['pre-trading', 'software-hosting', 120_000],
      ['disallowable', 'formation-costs', 5_000],
    ]);
    expect(v.preTrading).toMatchObject({ broughtForward: 0, added: 120_000, released: 0, carriedForward: 120_000 });
    // The laptop waits for the trade's first day (CAA 2001 s12).
    expect(v.capitalAllowances.deferred.map((a) => [a.acquired, a.incurred])).toEqual([['2024-03-01', '2024-07-01']]);
    expect(v.capitalAllowances.net).toBe(0);
    // Only the interest is taxed: £40 at 19%.
    expect(v.chargeable.whole).toBe(40);
    expect(v.payable).toBe(760);
    expect(boxes(v)).toMatchObject({ 145: null, 155: null, 165: null, 170: 40, 315: 40 });
    expect(v.notes.map((x) => x.text).join(' ')).toMatch(/s1218B.*CTM08070/);
  });

  it('asks whether a pre-trading company with profits is a close investment-holding company, and charges the main rate if it is', () => {
    const asked = ct(rows, books, { period: '2024-06-30' }).computation!;
    expect(kinds(asked)).toEqual(['close-investment-holding']);
    const cihc = ct(rows, { ...books, closeInvestmentHolding: true }, { period: '2024-06-30' }).computation!;
    expect(cihc.payable).toBe(1_000);
    expect(boxes(cihc)[4]).toBe(2);
  });

  it('releases pre-trading expenditure and the plant on the trade’s first day', () => {
    const v = ct(rows, { ...books, closeInvestmentHolding: false }, { period: '2024-12-31' }).computation!;
    expect(v.preTrading).toMatchObject({ broughtForward: 120_000, released: 120_000, carriedForward: 0 });
    expect(v.adjustments.find((a) => a.kind === 'pre-trading-released')?.amount).toBe(-120_000);
    // Depreciation (£900 over 36 months from March: 10 months, £250) is added back; the laptop takes the AIA from 1 July.
    expect(v.capitalAllowances.assets.map((a) => [a.incurred, a.aia])).toEqual([['2024-07-01', 90_000]]);
    expect(v.beforeAllowances).toBe(2_000_000 - 60_000 - 120_000);
    expect(v.tradingResult).toBe(2_000_000 - 60_000 - 120_000 - 90_000);
    expect(v.chargeable.whole).toBe(17_300 + 60);
    // A 184-day period in FY 2024: the lower limit £50,000 × 184/365 = £25,205.48, so 19%.
    expect(v.tax.parts.map((p) => [p.band, p.lower])).toEqual([['small', 2_520_548]]);
    expect(v.payable).toBe(17_360 * 19);
  });

  it('gives expenses incurred more than 7 years before the trade started nothing (CTA 2009 s61)', () => {
    const old = [bank('2024-02-12', -400, 'EXAMPLE SOFTWARE LTD', coded('software-hosting')), bank('2024-06-12', -100, 'EXAMPLE SOFTWARE LTD', coded('software-hosting')), bank('2032-03-01', 1_000, 'EXAMPLE CLIENT LTD', coded('turnover'))];
    const v = ct(old, { tradeStartedOn: '2031-04-01', closeInvestmentHolding: false }, { today: '2032-06-30', period: '2031-12-31', statements: ['2031-12-31'] }).computation!;
    expect(v.preTrading).toMatchObject({ released: 10_000, lapsed: 40_000 });
  });
});

describe('losses and deficits', () => {
  it('carries a trading loss forward and claims it against the next year’s total profits (CTA 2010 s45A)', () => {
    const rows = [
      bank('2024-02-01', 20_000, 'SHARES PAID', coded('share-capital')),
      bank('2024-06-01', 2_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2024-07-01', -5_000, 'EXAMPLE AGENCY', coded('advertising')),
      bank('2025-06-01', 10_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2025-12-31', 500, 'INTEREST', coded('interest-receivable')),
    ];
    const r = ct(rows, { closeInvestmentHolding: false });
    const y1 = companyCorporationTax({ src: memory(rows, companyOf({ closeInvestmentHolding: false })), company: companyOf({ closeInvestmentHolding: false }), engine: engineOf(memory(rows, companyOf()), ['2024-12-31', '2025-12-31']), today: '2026-06-30', period: '2024-12-31' })!.computation!;
    expect(y1.tradingResult).toBe(-300_000);
    expect(y1.losses.trading).toMatchObject({ arising: 300_000, carriedForward: 300_000 });
    expect(boxes(y1)).toMatchObject({ 155: 0, 780: 3_000, 315: 0 });
    expect(y1.notes.map((x) => x.text).join(' ')).toMatch(/s37/);
    const y2 = r.computation!.period.end === '2025-12-31' ? r.computation! : ct(rows, { closeInvestmentHolding: false }, { period: '2025-12-31' }).computation!;
    expect(y2.losses.trading).toMatchObject({ broughtForward: 300_000, usedAgainstTotal: 300_000, carriedForward: 0 });
    expect(boxes(y2)).toMatchObject({ 155: 10_000, 160: null, 170: 500, 235: 10_500, 285: 3_000, 295: 3_000, 315: 7_500 });
    expect(y2.notes.some((x) => /deductions allowance/.test(x.text))).toBe(true);
  });

  it('carries a non-trading deficit forward and sets it against later total profits (CTA 2009 s463G)', () => {
    const rows = [bank('2024-02-01', 20_000, 'LOAN IN', coded('creditors:other')), bank('2024-06-01', -800, 'INTEREST PAID', coded('interest-payable')), bank('2025-06-01', 5_000, 'EXAMPLE CLIENT LTD', coded('turnover'))];
    const books = { tradeStartedOn: '2025-01-01', closeInvestmentHolding: false };
    const y1 = ct(rows, books, { period: '2024-12-31' }).computation!;
    expect(y1.nonTrading).toMatchObject({ debits: 80_000, net: -80_000 });
    expect(boxes(y1)).toMatchObject({ 170: 0, 795: 800, 315: 0 });
    const y2 = ct(rows, books, { period: '2025-12-31' }).computation!;
    expect(y2.losses.nonTrading).toMatchObject({ broughtForward: 80_000, used: 80_000, carriedForward: 0 });
    expect(boxes(y2)).toMatchObject({ 155: 5_000, 263: 800, 315: 4_200 });
  });
});

describe('capital allowances', () => {
  it('gives full expensing when chosen, and brings its disposal value in as a balancing charge (CAA 2001 s45S, s59A)', () => {
    const rows = [
      bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2024-03-01', -4_000, 'EXAMPLE PRESS LTD', coded('fixed-assets:office:cost', { asset: { class: 'office', months: 60, allowance: 'first-year', disposedOn: '2025-06-30', proceeds: 1_500 } })),
      bank('2025-06-30', 1_500, 'EXAMPLE PRESS SOLD', coded('disposals')),
      bank('2025-07-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
    ];
    const y1 = ct(rows, { closeInvestmentHolding: false }, { period: '2024-12-31' }).computation!;
    expect(y1.capitalAllowances.assets.map((a) => [a.treatment, a.firstYear, a.aia, a.toPool])).toEqual([['full-expensing', 400_000, 0, 0]]);
    expect(boxes(y1)).toMatchObject({ 688: 4_000, 760: 4_000 });
    const y2 = ct(rows, { closeInvestmentHolding: false }, { period: '2025-12-31' }).computation!;
    expect(y2.capitalAllowances.disposals.map((d) => [d.treatment, d.disposalValue, d.balancingCharge, d.fromPool])).toEqual([['full-expensing', 150_000, 150_000, 0]]);
    expect(y2.capitalAllowances.net).toBe(-150_000);
    expect(boxes(y2)[689]).toBe(1_500);
    // The disposal's accounting loss is taken out: capital (the balancing charge instead).
    expect(y2.adjustments.find((a) => a.ledger === 'disposals')?.kind).toBe('capital');
  });

  it('gives special rate plant over the AIA the 50% allowance, half its disposal value a balancing charge (CAA 2001 s45S, s59B)', () => {
    const rows = [
      bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2024-03-01', -10_000, 'EXAMPLE HEATING LTD', coded('fixed-assets:office:cost', { asset: { class: 'office', months: 120, pool: 'special', disposedOn: '2025-06-30', proceeds: 2_000 } })),
      bank('2025-07-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
    ];
    // Only £4,000 of the allowance is this company's: the other £6,000 takes 50%, the rest to the special rate pool.
    const books = { closeInvestmentHolding: false, aiaAllocated: [{ periodEnd: '2024-12-31', amount: 4_000 }] };
    const y1 = ct(rows, books, { period: '2024-12-31' }).computation!;
    expect(y1.capitalAllowances.aiaLimit).toMatchObject({ period: 400_000, allocated: true, used: 400_000 });
    expect(y1.capitalAllowances.assets.map((a) => [a.treatment, a.aia, a.firstYear, a.toPool])).toEqual([['fya-50', 400_000, 300_000, 300_000]]);
    // The pool's £3,000 at 6%.
    expect(y1.capitalAllowances.pools.map((p) => [p.pool, p.rate, p.wda])).toEqual([['special', 6, 18_000]]);
    expect(boxes(y1)).toMatchObject({ 690: 4_000, 693: 3_000, 695: 4_180, 760: 10_000, 773: 10_000 });
    // Its disposal value £2,000: the relevant proportion is half of the £6,000 that took 50% over £10,000, so £600 is a balancing charge.
    const y2 = ct(rows, books, { period: '2025-12-31' }).computation!;
    expect(y2.capitalAllowances.disposals.map((d) => [d.treatment, d.balancingCharge, d.fromPool])).toEqual([['fya-50', 60_000, 140_000]]);
    expect(boxes(y2)[694]).toBe(600);
  });

  it('takes an AIA’d asset’s disposal value off the main pool, a balancing charge when it goes below nothing', () => {
    const rows = [
      bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2024-03-01', -2_000, 'EXAMPLE DESKS LTD', coded('fixed-assets:furniture:cost', { asset: { class: 'furniture', months: 60, disposedOn: '2025-03-31' } })),
      bank('2025-03-31', 600, 'DESKS SOLD', coded('disposals')),
    ];
    const y2 = ct(rows, { closeInvestmentHolding: false }, { period: '2025-12-31' }).computation!;
    // What it fetched is what was coded to disposals, as it alone left then.
    expect(y2.capitalAllowances.disposals.map((d) => [d.treatment, d.proceeds, d.fromPool])).toEqual([['pool', 60_000, 60_000]]);
    expect(y2.capitalAllowances.pools.map((p) => [p.pool, p.available, p.balancingCharge, p.wda])).toEqual([['main', -60_000, 60_000, 0]]);
    expect(boxes(y2)[710]).toBe(600);
  });

  it('gives plant from a connected person no AIA or first-year allowance, its cost capped at its market value (CAA 2001 ss217–218)', () => {
    const rows = [bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')), bank('2024-03-01', -3_000, 'J BLOGGS OLD PRINTER', coded('fixed-assets:office:cost', { asset: { class: 'office', months: 60, connected: true, marketValue: 2_000 } }))];
    const v = ct(rows, { closeInvestmentHolding: false }, { period: '2024-12-31' }).computation!;
    expect(v.capitalAllowances.assets.map((a) => [a.treatment, a.qualifying, a.aia, a.firstYear])).toEqual([['pool', 200_000, 0, 0]]);
    expect(v.capitalAllowances.pools.map((p) => [p.available, p.rate, p.wda, p.carriedForward])).toEqual([[200_000, 18, 36_000, 164_000]]);
    // Without a market value its cost is used, and the row asks for it.
    const unsure = ct([rows[0]!, bank('2024-03-01', -3_000, 'J BLOGGS OLD PRINTER', coded('fixed-assets:office:cost', { asset: { class: 'office', months: 60, connected: true } }))], { closeInvestmentHolding: false }, { period: '2024-12-31' }).computation!;
    expect(unsure.capitalAllowances.assets[0]!.notes.join(' ')).toMatch(/confirm its market value/);
  });

  it('writes a small pool off in full, and gives small equipment the AIA as plant (CTA 2009 s53)', () => {
    const rows = [bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')), bank('2024-03-01', -80, 'EXAMPLE CABLES', coded('small-equipment'))];
    const v = ct(rows, { closeInvestmentHolding: false, ledgerFrom: '2024-01-01', taxBroughtForward: { mainPool: 900 } }, { period: '2024-12-31' }).computation!;
    expect(v.adjustments.find((a) => a.ledger === 'small-equipment')).toMatchObject({ kind: 'capital', amount: 8_000 });
    expect(v.capitalAllowances.assets.map((a) => [a.smallEquipment, a.aia])).toEqual([[true, 8_000]]);
    expect(v.capitalAllowances.pools.map((p) => [p.broughtForward, p.smallPool, p.wda, p.carriedForward])).toEqual([[90_000, true, 90_000, 0]]);
  });

  it('asks what each asset fetched when two leave in one period with nothing said', () => {
    const rows = [
      bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')),
      bank('2024-03-01', -2_000, 'EXAMPLE DESK', coded('fixed-assets:furniture:cost', { asset: { class: 'furniture', months: 60, disposedOn: '2025-03-31' } })),
      bank('2024-03-02', -2_000, 'EXAMPLE CHAIR', coded('fixed-assets:furniture:cost', { asset: { class: 'furniture', months: 60, disposedOn: '2025-04-30' } })),
      bank('2025-04-30', 700, 'SOLD BOTH', coded('disposals')),
    ];
    expect(kinds(ct(rows, { closeInvestmentHolding: false }, { period: '2025-12-31' }).computation!)).toContain('disposal-proceeds');
  });

  it('refuses a car or an intangible asset as not supported, and asset fields for tax that do not fit', () => {
    const rows = [bank('2024-02-01', 30_000, 'EXAMPLE CLIENT LTD', coded('turnover')), bank('2024-03-01', -9_000, 'EXAMPLE CARS', coded('fixed-assets:motor:cost', { asset: { class: 'motor', months: 48 } }))];
    const v = ct(rows, { closeInvestmentHolding: false, policies: [{ class: 'motor', months: 48 }] }, { period: '2024-12-31' }).computation!;
    expect(v.checks.some((c) => c.kind === 'unsupported' && /a car/.test(c.what))).toBe(true);
    expect(assetTaxProblems({ class: 'office', marketValue: 10 })).toEqual([expect.stringMatching(/connected person/)]);
    expect(assetTaxProblems({ class: 'office', connected: true, allowance: 'aia' })).toEqual([expect.stringMatching(/s217/)]);
    expect(assetTaxProblems({ class: 'office', used: true, allowance: 'first-year' })).toEqual([expect.stringMatching(/unused/)]);
    expect(assetTaxProblems({ class: 'intangible', pool: 'special' })).toHaveLength(1);
    expect(assetTaxProblems({ class: 'office', proceeds: 5 })).toEqual([expect.stringMatching(/left the company/)]);
  });
});

describe('the settings for Corporation Tax', () => {
  it('refuses two figures for one period, and figures brought forward for books that start at the beginning', () => {
    const problems = booksProblems({ ...booksOf(), associatedCompanies: [{ periodEnd: '2024-12-31', count: 1 }, { periodEnd: '2024-12-31', count: 2 }], aiaAllocated: [{ periodEnd: '2024-12-31', amount: 1 }, { periodEnd: '2024-12-31', amount: 2 }], taxBroughtForward: { mainPool: 1 } });
    expect(problems).toEqual([expect.stringMatching(/associated companies .* given twice/), expect.stringMatching(/annual investment allowance allocated .* given twice/), expect.stringMatching(/start mid-life/)]);
    // A coding's asset fields for tax are checked with the rest of it.
    expect(codingProblems(-100, { ledger: 'fixed-assets:office:cost', asset: { class: 'office', connected: true, allowance: 'first-year' } }, 'company')).toEqual([expect.stringMatching(/s217/)]);
  });
});

describe('books taken over mid-life', () => {
  const opening: Journal = { id: 'jnl_00000000ab01', companyId: CO, date: '2025-09-30', memo: 'Opening balances', lines: [{ ledger: 'bank:loom-bank', amount: 10_000 }, { ledger: 'retained-earnings', amount: -10_000 }], opening: true, createdBy: 'owner', createdAt: stamp, updatedAt: stamp };
  const rows = [bank('2025-11-01', 40_000, 'EXAMPLE CLIENT LTD', coded('turnover')), bank('2026-04-01', -900, 'EXAMPLE SOFTWARE LTD', coded('software-hosting'))];
  const books = { incorporatedOn: '2023-01-10', accountingReferenceDate: '09-30', tradeStartedOn: '2023-01-10', withinChargeFrom: '2023-01-10', ledgerFrom: '2025-10-01', closeInvestmentHolding: false };
  const run = (extra: Partial<Books>) => ct(rows, { ...books, ...extra }, { today: '2026-11-27', period: '2026-09-30', journals: [opening], statements: ['2026-09-30'], opening: 10_000 });

  it('leaves the periods before the books out, and asks for the tax figures brought forward', () => {
    const r = run({});
    expect(r.periods.filter((p) => p.status === 'before-books').length).toBeGreaterThan(0);
    expect(kinds(r.computation!)).toEqual(['brought-forward']);
  });

  it('brings the pools and losses forward, writing the main pool down at the hybrid rate over 1 April 2026', () => {
    const v = run({ taxBroughtForward: { mainPool: 5_000, tradingLosses: 1_000 } }).computation!;
    expect(v.checks).toEqual([]);
    expect(v.capitalAllowances.pools.map((p) => [p.broughtForward, p.rate, p.wda])).toEqual([[500_000, 16, 80_000]]);
    expect(v.losses.trading).toMatchObject({ broughtForward: 100_000, usedAgainstTotal: 100_000 });
    expect(boxes(v)).toMatchObject({ 705: 800, 155: 40_000 - 900 - 800, 285: 1_000 });
  });
});

describe('the period’s state', () => {
  it('offers to record nothing to pay for an ended, ready period with no tax, and stops when a CT600 says so', () => {
    const rows = [bank('2024-02-01', 1_000, 'SHARES PAID', coded('share-capital')), bank('2024-06-01', -300, 'EXAMPLE SOFTWARE LTD', coded('software-hosting'))];
    const r = ct(rows, { closeInvestmentHolding: false }, { period: '2024-12-31' });
    expect(r.computation!.payable).toBe(0);
    expect(r.computation!.period.offerNothingToPay).toBe(true);
    const filed = ct(rows, { closeInvestmentHolding: false, filings: [{ id: 'fil_000000000001', kind: 'ct600', periodStart: '2024-01-01', periodEnd: '2024-12-31', filedOn: '2025-03-01', figures: { taxPayable: 0 }, addedBy: 'owner' }] }, { period: '2024-12-31' });
    expect(filed.computation!.period).toMatchObject({ status: 'filed' });
    expect(filed.computation!.period.offerNothingToPay).toBeUndefined();
  });

  it('marks a CT600 whose tax differs from the books, and a later period not ready while an earlier one is not', () => {
    const r = ct(YEAR, { closeInvestmentHolding: false, filings: [{ id: 'fil_000000000002', kind: 'ct600', periodStart: '2024-01-01', periodEnd: '2024-12-31', filedOn: '2025-03-01', figures: { taxPayable: 10_000 }, addedBy: 'owner' }] }, { period: '2024-12-31' });
    expect(r.periods[0]).toMatchObject({ differs: true, status: 'filed' });
    const unready = ct(YEAR, { closeInvestmentHolding: false }, { period: '2025-12-31', statements: ['2025-12-31'] }).computation!;
    expect(kinds(unready)).toContain('earlier-not-ready');
  });

  it('works on the earliest ended period with no CT600 next', () => {
    const r = ct(YEAR, { closeInvestmentHolding: false });
    expect(r.next).toBe('2024-12-31');
    expect(r.computation!.period.end).toBe('2024-12-31');
  });
});

describe('as properties over generated plant and sales', () => {
  it('never leaves a pool below nothing, and relieves no more than was spent and brought forward', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ month: fc.integer({ min: 1, max: 30 }), cost: fc.integer({ min: 50, max: 400_000 }), cls: fc.constantFrom('computer' as const, 'office' as const), choice: fc.constantFrom(undefined, 'aia' as const, 'first-year' as const, 'none' as const), connected: fc.boolean() }), { maxLength: 6 }), (items) => {
        const rows = [bank('2024-01-15', 2_000_000, 'EXAMPLE CLIENT LTD', coded('turnover')), ...items.map((it, i) => {
          const d = `${2024 + Math.floor((it.month - 1) / 12)}-${String(((it.month - 1) % 12) + 1).padStart(2, '0')}-1${i}`;
          return bank(d, -it.cost, `EXAMPLE KIT ${i}`, coded(`fixed-assets:${it.cls}:cost`, { asset: { class: it.cls, months: 36, ...(it.choice && !(it.connected && it.choice !== 'none') ? { allowance: it.choice } : {}), ...(it.connected ? { connected: true } : {}) } }));
        })];
        const company = companyOf({ closeInvestmentHolding: false });
        const src = memory(rows, company);
        const r = companyCorporationTax({ src, company, engine: engineOf(src, ['2024-12-31', '2025-12-31', '2026-06-29']), today: '2026-06-30' })!;
        const all = r.periods.map((p) => companyCorporationTax({ src, company, engine: engineOf(src, ['2024-12-31', '2025-12-31', '2026-06-29']), today: '2026-06-30', period: p.end })!.computation!);
        let relieved = 0;
        for (const v of all) {
          for (const p of v.capitalAllowances.pools) expect(p.carriedForward).toBeGreaterThanOrEqual(0);
          relieved += v.capitalAllowances.net;
        }
        const spent = companyLedger(src, CO).assets.reduce((x, a) => x + a.cost, 0);
        expect(relieved).toBeLessThanOrEqual(spent);
        const last = all.at(-1)!;
        expect(relieved + last.carriedForward.mainPool + last.carriedForward.specialPool).toBe(spent);
      }),
      { numRuns: 40 },
    );
  });
});
