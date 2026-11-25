// A Self Assessment liability, computed (docs/FORMULAS.md §20): income tax by band and by kind of
// income, the High Income Child Benefit Charge, Class 4 National Insurance, capital gains tax and
// student loan repayments, less the tax already taken off, and the payments on account that follow.
//
// Pure and deterministic: every amount is worked in integer pence (money.ts) and every step is kept as
// a line, so a figure on the page can be traced from the boxes through the sum. The rates and limits
// are the year's (uk.ts), never constants here. It follows HMRC's online calculation specification
// for the year ("Calculate Tax and NIC", docs/UK_RULES.md): each band's tax to the penny, rounded
// down; the HICBC and student loan to whole pounds, rounded down. The amounts it is given are the
// return's, already rounded as that specification rounds each group of boxes (taxreturn.ts).

import { fromMinor, toMinor } from './money';
import { codingOutLimit, paymentsOnAccountAtSourceShare, paymentsOnAccountThreshold, reliefAtSourceMinimum, taxYearParams, type TaxYear } from './uk';

export type StudentLoanPlan = 'plan1' | 'plan2' | 'plan4' | 'plan5' | 'postgraduate';

/** One source of foreign dividends: its gross amount and the foreign tax that may be credited (at most the treaty rate). */
export interface ForeignSource {
  label: string;
  amount: number;
  taxTaken: number;
}

export interface TaxCalcInput {
  ty: TaxYear;
  /** A Scottish taxpayer: non-savings income at Scottish rates (savings and dividends at UK rates). */
  scottish?: boolean;
  /** Non-savings income, each net of its own deductions: pay with benefits less allowable expenses, taxable profits, pensions, other. */
  nonSavings: { employment: number; selfEmployment?: number; property?: number; pensions?: number; other?: number };
  /** Savings income, gross: untaxed UK and foreign interest, and taxed interest grossed up. */
  savings: number;
  /** Dividends, gross: UK, other and foreign. */
  dividends: number;
  /** Foreign dividends within `dividends` on which Foreign Tax Credit Relief is claimed, source by source. */
  foreignDividends?: ForeignSource[];
  /** Reliefs that extend the basic and higher rate bands and reduce adjusted net income, gross. */
  bandExtension?: { reliefAtSource?: number; giftAid?: number };
  /**
   * Relevant UK earnings, which cap relief-at-source contributions at the higher of £3,600 and them
   * (FA 2004 s.190; HMRC's c4.58). Unset: pay and profits.
   */
  relevantEarnings?: number;
  /** Marriage Allowance: received from a spouse (a tax reducer), or transferred to one (a lower allowance). */
  marriageAllowance?: 'received' | 'transferred';
  /** Child Benefit received in the year, by you or a partner whose income is lower (the HICBC). */
  childBenefit?: number;
  /** Capital gains: the year's gains and losses on disposals, and losses brought forward. */
  gains?: { gains: number; losses: number; broughtForward?: number };
  /**
   * Student loan plans repayment had begun on before the year ended, and what employers took off.
   * `earned`, `unearned` and `deductions` give the loan's own income base (HMRC's stage 27) when the
   * return knows it; otherwise it is worked out from the income here.
   */
  studentLoan?: { plans: StudentLoanPlan[]; deductedByEmployers: number; postgraduateDeductedByEmployers?: number; earned?: number; unearned?: number; deductions?: number };
  /** Tax already taken off: PAYE, tax on taxed interest, and any other tax deducted. */
  deducted?: { paye?: number; taxedInterest?: number; other?: number };
  /** SA110 box 7: underpaid tax for earlier years this year's tax code collected (in `deducted.paye`): added to the tax due. */
  earlierYearsInCode?: number;
  /** SA110 box 9: an outstanding debt this year's tax code collected: that much of the PAYE is not this year's tax. */
  outstandingDebtInCode?: number;
  /** SA110 box 8: this year's underpaid tax HMRC is already collecting through next year's tax code. */
  thisYearInNextCode?: number;
  /** Payments on account already made for this year. */
  paymentsOnAccountMade?: number;
  /** Tax HMRC already refunded for the year, in the year (SA100 TR 6 box 1): it is added back. */
  refundedInYear?: number;
  /** Have a balance under the limit collected through next year's tax code (only when eligible). */
  codeOut?: boolean;
}

/** One step of the working: an amount of income at a rate, or a total. */
export interface CalcLine {
  id: string;
  label: string;
  /** The income (or gain) the line taxes, in pounds. */
  amount: number;
  rate?: number;
  /** The tax on it, in pounds. */
  tax?: number;
}

export interface TaxCalcResult {
  totalIncome: number;
  adjustedNetIncome: number;
  personalAllowance: number;
  /** The year's personal allowance before any taper or transfer. */
  personalAllowanceStandard: number;
  /** The personal allowance set against each kind of income. */
  allowanceUsed: { nonSavings: number; savings: number; dividends: number };
  taxableIncome: number;
  /** The basic and higher rate limits after the band extension (UK bands). */
  basicRateLimit: number;
  higherRateLimit: number;
  bandExtension: number;
  /** Relief-at-source contributions over the earnings cap, which do not widen the bands. */
  reliefAtSourceOverCap: number;
  personalSavingsAllowance: number;
  /** Income tax by band and kind, in the order HMRC charges it. */
  lines: CalcLine[];
  incomeTaxCharged: number;
  /** Tax reducers: Marriage Allowance received, Foreign Tax Credit Relief. */
  reducers: CalcLine[];
  /** Income tax after reducers, with any charge for Gift Aid the tax does not cover. */
  incomeTaxDue: number;
  /** Gift Aid's basic rate tax not covered by your income tax and capital gains tax (ITA 2007 s.424). */
  giftAidCharge: number;
  /** A Marriage Allowance claim that does not apply: income above the basic rate limit (or the Scottish intermediate rate). */
  marriageAllowanceRefused: boolean;
  hicbc: number;
  class4: number;
  class4Lines: CalcLine[];
  /** `modelled` false: a year whose rates changed part-way (2024/25), whose tax is not worked out here. */
  capitalGains: { modelled: boolean; net: number; broughtForwardUsed: number; annualExemptAmount: number; taxable: number; lines: CalcLine[]; tax: number } | null;
  studentLoan: { income: number; unearnedCounted: boolean; due: number; deducted: number; payable: number; lines: CalcLine[] } | null;
  /** Income tax, the HICBC, Class 4, capital gains tax and student loan: the year's whole liability. */
  totalLiability: number;
  /** Tax already taken off at source this year: PAYE less any outstanding debt it collected, taxed interest, other. */
  deductedAtSource: number;
  /** SA110 box 7, added to what is due. */
  earlierYearsInCode: number;
  /** What is left for the year once tax taken off, next year's code and payments on account made are counted (negative: overpaid). */
  balancing: number;
  /** A positive balance under the coding-out limit, which next year's tax code could collect. */
  codable: number;
  /** What the result assumes is collected through next year's code (`codeOut`). */
  codedOut: number;
  /** Payments on account for the next year: the January and July instalments, and why. */
  paymentsOnAccount: { first: number; second: number; relevantAmount: number; reason: 'due' | 'under-threshold' | 'mostly-at-source' | 'coded-out' };
  /**
   * Due on 31 January after the year: the balance not coded out plus the first payment on account
   * (HMRC's c13.17: an overpaid balance is set against the instalment; negative, a credit). And 31 July.
   */
  dueJanuary: number;
  dueJuly: number;
}

const minor = toMinor;
const major = fromMinor;
const clamp0 = (n: number) => Math.max(0, n);
/** Tax at a rate on pence, rounded down to the penny. */
const at = (pence: number, rate: number) => Math.floor(pence * rate + 1e-6);

interface Band {
  name: string;
  rate: number;
  /** Upper limit in taxable-income pence (Infinity for the last). */
  upTo: number;
}

/** A run of income through bands from a starting position: the slices it falls into. */
function slice(start: number, amount: number, bands: Band[]): { band: Band; amount: number }[] {
  const out: { band: Band; amount: number }[] = [];
  let pos = start;
  let left = amount;
  for (const b of bands) {
    if (left <= 0) break;
    if (pos < b.upTo) {
      const take = Math.min(left, b.upTo - pos);
      if (take > 0) {
        out.push({ band: b, amount: take });
        pos += take;
        left -= take;
      }
    }
  }
  return out;
}

interface IncomeTaxParts {
  lines: CalcLine[];
  tax: number;
  /**
   * Some income is taxed above the basic rate (a Scottish taxpayer's pay above the intermediate
   * rate), or dividends within the allowance sit above the basic rate limit: no Marriage Allowance
   * then (HMRC's c4.75–c4.76c). Interest within the savings allowance does not count.
   */
  aboveBasic: boolean;
}

const HIGH_BANDS = new Set(['higher', 'additional', 'advanced', 'top']);

/** Income tax on taxable non-savings, savings and dividend income (pence), the PA already set against them. */
function incomeTaxOn(ty: TaxYear, scottish: boolean, ns: number, sv: number, dv: number, extension: number, psaPence: number): IncomeTaxParts {
  const p = taxYearParams(ty);
  const basic = minor(p.basicRateLimit) + extension;
  const higher = minor(p.additionalRateThreshold) + extension;
  const uk = (rates: { basic: number; higher: number; additional: number }): Band[] => [
    { name: 'basic', rate: rates.basic, upTo: basic },
    { name: 'higher', rate: rates.higher, upTo: higher },
    { name: 'additional', rate: rates.additional, upTo: Infinity },
  ];
  const lines: CalcLine[] = [];
  let tax = 0;
  let aboveBasic = false;
  const push = (id: string, label: string, amount: number, rate: number, band?: string) => {
    const t = at(amount, rate);
    tax += t;
    if (band && rate > 0 && HIGH_BANDS.has(band)) aboveBasic = true;
    lines.push({ id, label, amount: major(amount), rate, tax: major(t) });
  };

  // Non-savings: Scottish bands for a Scottish taxpayer (the starter band fixed, the rest moved up by
  // the extension), else UK.
  const nsBands: Band[] = scottish && p.scottishBands ? p.scottishBands.map((b, i) => ({ name: b.name, rate: b.rate, upTo: b.upTo === null ? Infinity : minor(b.upTo) + (i === 0 ? 0 : extension) })) : uk(p.incomeTaxRates);
  for (const s of slice(0, ns, nsBands)) push(`non-savings-${s.band.name}`, `Pay, pensions and profits at the ${scottish && p.scottishBands ? 'Scottish ' : ''}${s.band.name} rate`, s.amount, s.band.rate, s.band.name);

  // Savings and dividends sit above non-savings income in the UK bands.
  let pos = ns;
  const startingBand = clamp0(minor(p.startingRateForSavings) - ns);
  const starting = Math.min(sv, startingBand);
  if (starting > 0) push('savings-starting', 'Interest at the starting rate for savings', starting, 0);
  pos += starting;
  const psaUsed = Math.min(sv - starting, psaPence);
  if (psaUsed > 0) push('savings-allowance', 'Interest within the Personal Savings Allowance', psaUsed, 0);
  pos += psaUsed;
  const svRest = sv - starting - psaUsed;
  for (const s of slice(pos, svRest, uk(p.savingsTaxRates))) push(`savings-${s.band.name}`, `Interest at the ${s.band.name} rate`, s.amount, s.band.rate, s.band.name);
  pos += svRest;

  const allowance = Math.min(dv, minor(p.dividendAllowance));
  if (allowance > 0) push('dividends-allowance', 'Dividends within the dividend allowance', allowance, 0);
  if (allowance > 0 && pos + allowance > basic) aboveBasic = true;
  pos += allowance;
  for (const s of slice(pos, dv - allowance, uk(p.dividendTaxRates))) push(`dividends-${s.band.name}`, `Dividends at the dividend ${s.band.name === 'basic' ? 'ordinary' : s.band.name === 'higher' ? 'upper' : 'additional'} rate`, s.amount, s.band.rate, s.band.name);
  return { lines, tax, aboveBasic };
}

/**
 * The Personal Savings Allowance: £1,000 when taxable income stays within the basic rate limit, £500
 * when it goes over it, nil over the higher rate limit (UK limits after the band extension, for
 * Scottish taxpayers too: HMRC's calculation, c4.77–c4.79).
 */
function psaFor(ty: TaxYear, taxable: number, extension: number): number {
  const p = taxYearParams(ty);
  const basic = minor(p.basicRateLimit) + extension;
  const higher = minor(p.additionalRateThreshold) + extension;
  return minor(p.personalSavingsAllowance[taxable > higher ? 'additional' : taxable > basic ? 'higher' : 'basic']);
}

interface Allocated {
  parts: IncomeTaxParts;
  paNs: number;
  paSv: number;
  paDv: number;
}

/**
 * Income tax with the personal allowance set where it leaves the least tax (ITA 2007 s.25(2)): every
 * split between non-savings income, savings and dividends that uses all of it, tried at the points
 * where a rate changes (tax is linear between them).
 */
function allocate(ty: TaxYear, scottish: boolean, ns: number, sv: number, dv: number, pa: number, extension: number, psa: number): Allocated {
  const p = taxYearParams(ty);
  const used = Math.min(pa, ns + sv + dv);
  const basic = minor(p.basicRateLimit) + extension;
  const higher = minor(p.additionalRateThreshold) + extension;
  const srb = minor(p.startingRateForSavings);
  const da = minor(p.dividendAllowance);
  const nsMax = Math.min(used, ns);
  const nsMin = clamp0(used - sv - dv);
  const nsPoints = new Set<number>([nsMax, nsMin]);
  const limits = [0, srb, basic, higher, basic - psa, basic - sv, basic - sv - da, ...(scottish && p.scottishBands ? p.scottishBands.flatMap((b, i) => (b.upTo === null ? [] : [minor(b.upTo) + (i === 0 ? 0 : extension)])) : [])];
  for (const k of limits) {
    const a = ns - k;
    if (a > nsMin && a < nsMax) nsPoints.add(a);
  }
  let best: Allocated | null = null;
  for (const paNs of nsPoints) {
    const rest = used - paNs;
    const nsTaxable = ns - paNs;
    const lo = clamp0(rest - dv);
    const hi = Math.min(rest, sv);
    const svPoints = new Set<number>([lo, hi]);
    const startingBand = clamp0(srb - nsTaxable);
    for (const k of [startingBand, startingBand + psa, basic - nsTaxable, higher - nsTaxable]) {
      const x = sv - k;
      if (x > lo && x < hi) svPoints.add(x);
    }
    for (const x of [rest - dv, rest - (dv - da), rest - (dv - (basic - nsTaxable - sv))]) if (x > lo && x < hi) svPoints.add(x);
    for (const paSv of svPoints) {
      const paDv = rest - paSv;
      const parts = incomeTaxOn(ty, scottish, nsTaxable, sv - paSv, dv - paDv, extension, psa);
      if (!best || parts.tax < best.parts.tax || (parts.tax === best.parts.tax && paNs > best.paNs)) best = { parts, paNs, paSv, paDv };
    }
  }
  return best!;
}

interface Core {
  total: number;
  ani: number;
  pa: number;
  extension: number;
  rasOverCap: number;
  taxable: number;
  psa: number;
  alloc: Allocated;
  maRefused: boolean;
  /** Income tax charged, less the Marriage Allowance reducer. */
  afterMa: number;
  maLine: CalcLine | null;
  hicbc: number;
}

/** Income tax charged, the Marriage Allowance and the HICBC, for an input: what Foreign Tax Credit Relief compares. */
function core(input: TaxCalcInput): Core {
  const p = taxYearParams(input.ty);
  const scottish = Boolean(input.scottish && p.scottishBands);
  const n = input.nonSavings;
  const ns = clamp0(minor(n.employment) + minor(n.selfEmployment ?? 0) + minor(n.property ?? 0) + minor(n.pensions ?? 0) + minor(n.other ?? 0));
  const sv = clamp0(minor(input.savings));
  const dv = clamp0(minor(input.dividends));
  const total = ns + sv + dv;
  // Relief-at-source contributions count up to the higher of £3,600 and relevant UK earnings.
  const ras = clamp0(minor(input.bandExtension?.reliefAtSource ?? 0));
  const earnings = input.relevantEarnings !== undefined ? clamp0(minor(input.relevantEarnings)) : clamp0(minor(n.employment) + minor(n.selfEmployment ?? 0));
  const rasCounted = Math.min(ras, Math.max(minor(reliefAtSourceMinimum), earnings));
  const extension = rasCounted + clamp0(minor(input.bandExtension?.giftAid ?? 0));
  const ani = clamp0(total - extension);
  const over = clamp0(ani - minor(p.personalAllowanceTaperThreshold));
  const fullPa = clamp0(minor(p.personalAllowance) - Math.floor(over / 200) * 100);
  const run = (pa: number) => {
    const taxable = clamp0(total - pa);
    const psa = psaFor(input.ty, taxable, extension);
    return { pa, taxable, psa, alloc: allocate(input.ty, scottish, ns, sv, dv, pa, extension, psa) };
  };
  let r = run(input.marriageAllowance === 'transferred' ? clamp0(fullPa - minor(p.marriageAllowance)) : fullPa);
  let maRefused = false;
  // Transferring it: only while you would pay no tax above the basic rate after it (c4.76c).
  if (input.marriageAllowance === 'transferred' && r.alloc.parts.aboveBasic) {
    maRefused = true;
    r = run(fullPa);
  }
  let afterMa = r.alloc.parts.tax;
  let maLine: CalcLine | null = null;
  if (input.marriageAllowance === 'received') {
    if (r.alloc.parts.aboveBasic) maRefused = true;
    else {
      const reducer = Math.min(afterMa, at(minor(p.marriageAllowance), p.incomeTaxRates.basic));
      if (reducer > 0) maLine = { id: 'marriage-allowance', label: 'Marriage Allowance received', amount: p.marriageAllowance, rate: p.incomeTaxRates.basic, tax: -major(reducer) };
      afterMa -= reducer;
    }
  }
  // High Income Child Benefit Charge (HMRC's c28.9–c28.14): whole percentage points of the excess
  // (one per £200), times 1% of the benefit in whole pounds (to the penny, down), at most the benefit,
  // whole pounds down.
  let hicbc = 0;
  const cbPounds = Math.floor(clamp0(input.childBenefit ?? 0) + 1e-9);
  if (cbPounds > 0 && ani > minor(p.hicbc.threshold)) {
    const points = Math.floor(((ani - minor(p.hicbc.threshold)) / 100) * (100 / (p.hicbc.fullAt - p.hicbc.threshold)) + 1e-9);
    hicbc = Math.floor(Math.min(cbPounds * 100, points * cbPounds) / 100) * 100;
  }
  return { total, ani, pa: r.pa, extension, rasOverCap: ras - rasCounted, taxable: r.taxable, psa: r.psa, alloc: r.alloc, maRefused, afterMa, maLine, hicbc };
}

/**
 * Foreign Tax Credit Relief, source by source (HS263): each source's credit is the lower of its
 * foreign tax and the UK tax on it, taking it off the top of the income still counted (income tax
 * after reducers, with the HICBC). The order that gives the most relief is used.
 */
function foreignCredit(input: TaxCalcInput, sources: ForeignSource[], base: Core): number {
  const valid = sources.filter((s) => s.amount > 0 && s.taxTaken > 0);
  if (!valid.length) return 0;
  const ukTax = (c: Core) => c.afterMa + c.hicbc;
  const withOut = (left: ForeignSource[]) => {
    const removed = sources.filter((s) => !left.includes(s)).reduce((a, s) => a + minor(s.amount), 0);
    return core({ ...input, dividends: major(clamp0(minor(input.dividends) - removed)), foreignDividends: undefined });
  };
  const orders: ForeignSource[][] = [];
  const permute = (list: ForeignSource[], acc: ForeignSource[] = []) => {
    if (!list.length) orders.push(acc);
    else list.forEach((s, i) => permute([...list.slice(0, i), ...list.slice(i + 1)], [...acc, s]));
  };
  if (valid.length <= 4) permute(valid);
  else {
    const rate = (s: ForeignSource) => s.taxTaken / s.amount;
    orders.push([...valid].sort((a, b) => rate(b) - rate(a)), [...valid].sort((a, b) => rate(a) - rate(b)), valid);
  }
  let best = 0;
  for (const order of orders) {
    let left = [...sources];
    let current = ukTax(base);
    let total = 0;
    for (const s of order) {
      left = left.filter((x) => x !== s);
      const without = ukTax(withOut(left));
      total += Math.min(minor(s.taxTaken), clamp0(current - without));
      current = without;
    }
    best = Math.max(best, total);
  }
  return best;
}

export function computeTax(input: TaxCalcInput): TaxCalcResult {
  const { ty } = input;
  const p = taxYearParams(ty);
  const c = core(input);
  const charged = c.alloc.parts.tax;

  // Reducers: Marriage Allowance received, then Foreign Tax Credit Relief (never below nil).
  const reducers: CalcLine[] = c.maLine ? [c.maLine] : [];
  let due = c.afterMa;
  const fd = input.foreignDividends ?? [];
  if (fd.length) {
    const relief = Math.min(foreignCredit(input, fd, c), due);
    if (relief > 0) reducers.push({ id: 'foreign-tax-credit', label: 'Foreign Tax Credit Relief on foreign dividends', amount: major(fd.reduce((a, s) => a + minor(s.amount), 0)), tax: -major(relief) });
    due -= relief;
  }

  // Class 4 National Insurance on profits.
  const n = input.nonSavings;
  const class4Lines: CalcLine[] = [];
  let class4 = 0;
  const profit = clamp0(minor(n.selfEmployment ?? 0));
  if (profit > 0 && p.class4) {
    const lpl = minor(p.class4.lowerProfitsLimit);
    const upl = minor(p.class4.upperProfitsLimit);
    for (const [id, label, amount, rate] of [
      ['class4-main', 'Class 4 NI on profits between the lower and upper profits limits', clamp0(Math.min(profit, upl) - lpl), p.class4.mainRate],
      ['class4-upper', 'Class 4 NI on profits over the upper profits limit', clamp0(profit - upl), p.class4.upperRate],
    ] as const) {
      if (amount <= 0) continue;
      const t = at(amount, rate);
      class4 += t;
      class4Lines.push({ id, label, amount: major(amount), rate, tax: major(t) });
    }
  }

  // Capital gains tax: the year's losses first, then the annual exempt amount, then losses brought
  // forward (only down to the exempt amount); 18% within the basic rate band income leaves, 24% above.
  let capitalGains: TaxCalcResult['capitalGains'] = null;
  if (input.gains) {
    const g = input.gains;
    const net = clamp0(minor(g.gains) - minor(g.losses));
    const aea = minor(p.cgtAnnualExemptAmount);
    const bfUsed = Math.min(clamp0(minor(g.broughtForward ?? 0)), clamp0(net - aea));
    const taxableGains = clamp0(net - bfUsed - aea);
    const lower = Math.min(taxableGains, clamp0(minor(p.basicRateLimit) + c.extension - c.taxable));
    const rates = p.cgtRates ?? { lower: 0, higher: 0 };
    const lines: CalcLine[] = [];
    let tax = 0;
    for (const [id, label, amount, rate] of [
      ['cgt-lower', 'Gains within the basic rate band', lower, rates.lower],
      ['cgt-higher', 'Gains above the basic rate band', taxableGains - lower, rates.higher],
    ] as const) {
      if (amount <= 0) continue;
      const t = at(amount, rate);
      tax += t;
      lines.push({ id, label, amount: major(amount), rate, tax: major(t) });
    }
    capitalGains = { modelled: p.cgtRates !== null, net: major(net), broughtForwardUsed: major(bfUsed), annualExemptAmount: p.cgtAnnualExemptAmount, taxable: major(taxableGains), lines, tax: major(tax) };
  }

  // Gift Aid: the basic rate tax treated as taken off the gifts must be covered by your income tax and
  // capital gains tax; any shortfall is charged (ITA 2007 s.424; HMRC's c9.33–c9.39).
  const giftAidTax = at(clamp0(minor(input.bandExtension?.giftAid ?? 0)), p.incomeTaxRates.basic);
  const giftAidCharge = clamp0(giftAidTax - due - minor(capitalGains?.tax ?? 0));
  if (giftAidCharge > 0) reducers.push({ id: 'gift-aid-charge', label: 'Gift Aid tax your income tax does not cover', amount: major(clamp0(minor(input.bandExtension?.giftAid ?? 0))), rate: p.incomeTaxRates.basic, tax: major(giftAidCharge) });
  due += giftAidCharge;

  // Student loan: 9% of the loan's income over the lowest threshold of the plans held (6% over its own
  // for a Postgraduate Loan), whole pounds rounded down; unearned income counts in full once over the
  // limit; less pension contributions that get relief on the return (HMRC's stage 27).
  let studentLoan: TaxCalcResult['studentLoan'] = null;
  const sl = input.studentLoan;
  if (sl && sl.plans.length && p.studentLoan) {
    const t = p.studentLoan;
    const earned = sl.earned !== undefined ? clamp0(minor(sl.earned)) : clamp0(minor(n.employment) + minor(n.selfEmployment ?? 0) + minor(n.pensions ?? 0));
    const unearned = sl.unearned !== undefined ? clamp0(minor(sl.unearned)) : clamp0(c.total - earned);
    const counted = unearned > minor(t.unearnedIncomeLimit);
    const deductions = sl.deductions !== undefined ? clamp0(minor(sl.deductions)) : Math.ceil(clamp0(minor(input.bandExtension?.reliefAtSource ?? 0)) / 100) * 100;
    const income = clamp0(earned + (counted ? unearned : 0) - deductions);
    const lines: CalcLine[] = [];
    const undergrad: { plan: StudentLoanPlan; threshold: number }[] = [];
    for (const plan of sl.plans) {
      if (plan === 'postgraduate') continue;
      const threshold = plan === 'plan5' ? t.plan5 : t[plan];
      if (threshold !== null) undergrad.push({ plan, threshold });
    }
    let ugDue = 0;
    let pgDue = 0;
    if (undergrad.length) {
      const low = undergrad.reduce((a, b) => (b.threshold < a.threshold ? b : a));
      const over = clamp0(income - minor(low.threshold));
      ugDue = Math.floor(at(over, t.rate) / 100) * 100;
      lines.push({ id: `student-loan-${low.plan}`, label: `Student loan (${planLabel(low.plan)}): ${t.rate * 100}% of income over £${low.threshold.toLocaleString('en-GB')}`, amount: major(over), rate: t.rate, tax: major(ugDue) });
    }
    if (sl.plans.includes('postgraduate')) {
      const over = clamp0(income - minor(t.postgraduate));
      pgDue = Math.floor(at(over, t.postgraduateRate) / 100) * 100;
      lines.push({ id: 'student-loan-postgraduate', label: `Postgraduate Loan: ${t.postgraduateRate * 100}% of income over £${t.postgraduate.toLocaleString('en-GB')}`, amount: major(over), rate: t.postgraduateRate, tax: major(pgDue) });
    }
    // What employers took off, whole pounds up (c27.43), set against each loan's own due.
    const up = (v: number | undefined) => Math.ceil(clamp0(minor(v ?? 0)) / 100) * 100;
    const payable = clamp0(ugDue - up(sl.deductedByEmployers)) + clamp0(pgDue - up(sl.postgraduateDeductedByEmployers));
    studentLoan = { income: major(income), unearnedCounted: counted, due: major(ugDue + pgDue), deducted: major(up(sl.deductedByEmployers) + up(sl.postgraduateDeductedByEmployers)), payable: major(payable), lines };
  }

  const total4 = due + c.hicbc + class4;
  const liability = total4 + minor(capitalGains?.tax ?? 0) + minor(studentLoan?.payable ?? 0);
  const d = input.deducted ?? {};
  // PAYE that went on an outstanding debt is not this year's tax (c11.5–c11.8); earlier years' tax
  // the code collected is added to what is due (c12.6), so it nets off the PAYE that collected it.
  const paye = minor(d.paye ?? 0);
  const debt = Math.min(clamp0(paye), clamp0(minor(input.outstandingDebtInCode ?? 0)));
  const atSource = paye - debt + minor(d.taxedInterest ?? 0) + minor(d.other ?? 0);
  const earlier = clamp0(minor(input.earlierYearsInCode ?? 0));
  const nextCode = clamp0(minor(input.thisYearInNextCode ?? 0));
  const poaMade = clamp0(minor(input.paymentsOnAccountMade ?? 0));
  const refunded = clamp0(minor(input.refundedInYear ?? 0));
  // The year's balance (c12.21 less c13.3): the liability and earlier years' tax, less tax taken off
  // and next year's code, plus tax HMRC refunded in the year, less payments on account made.
  const balancing = liability + earlier - atSource - nextCode + refunded - poaMade;

  // Paying through next year's tax code (c13.5–c13.8): the whole balance, when over nil and under the limit.
  const codable = balancing > 0 && balancing < minor(codingOutLimit) ? balancing : 0;
  const codedOut = input.codeOut ? codable : 0;

  // Payments on account (c13.11–c13.16): half each of the income tax and Class 4 left after tax taken
  // off, next year's code and any balance coded out, unless that is under £1,000 or under 20% of the
  // year's income tax and Class 4 (compared exactly). The odd penny goes on the second.
  const relevant = total4 + earlier - atSource - nextCode - codedOut;
  const reason: TaxCalcResult['paymentsOnAccount']['reason'] = relevant < minor(paymentsOnAccountThreshold) ? (codedOut > 0 ? 'coded-out' : 'under-threshold') : relevant * Math.round(1 / (1 - paymentsOnAccountAtSourceShare)) < total4 ? 'mostly-at-source' : 'due';
  const first = reason === 'due' ? Math.floor(relevant / 2) : 0;
  const second = reason === 'due' ? relevant - first : 0;

  return {
    totalIncome: major(c.total),
    adjustedNetIncome: major(c.ani),
    personalAllowance: major(c.pa),
    personalAllowanceStandard: p.personalAllowance,
    allowanceUsed: { nonSavings: major(c.alloc.paNs), savings: major(c.alloc.paSv), dividends: major(c.alloc.paDv) },
    taxableIncome: major(c.taxable),
    basicRateLimit: major(minor(p.basicRateLimit) + c.extension),
    higherRateLimit: major(minor(p.additionalRateThreshold) + c.extension),
    bandExtension: major(c.extension),
    reliefAtSourceOverCap: major(c.rasOverCap),
    personalSavingsAllowance: major(c.psa),
    lines: c.alloc.parts.lines,
    incomeTaxCharged: major(charged),
    reducers,
    incomeTaxDue: major(due),
    giftAidCharge: major(giftAidCharge),
    marriageAllowanceRefused: c.maRefused,
    hicbc: major(c.hicbc),
    class4: major(class4),
    class4Lines,
    capitalGains,
    studentLoan,
    totalLiability: major(liability),
    deductedAtSource: major(atSource),
    earlierYearsInCode: major(earlier),
    balancing: major(balancing),
    codable: major(codable),
    codedOut: major(codedOut),
    paymentsOnAccount: { first: major(first), second: major(second), relevantAmount: major(clamp0(relevant)), reason },
    dueJanuary: major(balancing - codedOut + first),
    dueJuly: major(second),
  };
}

/**
 * The income tax charged for a given split of the personal allowance (all of it used): `toNonSavings`
 * against non-savings income, `toSavings` against savings, the rest against dividends. For checking
 * that `computeTax` picks the split that leaves the least tax (ITA 2007 s.25(2)).
 */
export function taxForAllowanceSplit(input: TaxCalcInput, toNonSavings: number, toSavings: number): number {
  const p = taxYearParams(input.ty);
  const scottish = Boolean(input.scottish && p.scottishBands);
  const n = input.nonSavings;
  const ns = clamp0(minor(n.employment) + minor(n.selfEmployment ?? 0) + minor(n.property ?? 0) + minor(n.pensions ?? 0) + minor(n.other ?? 0));
  const sv = clamp0(minor(input.savings));
  const dv = clamp0(minor(input.dividends));
  const extension = clamp0(minor(input.bandExtension?.reliefAtSource ?? 0)) + clamp0(minor(input.bandExtension?.giftAid ?? 0));
  const ani = clamp0(ns + sv + dv - extension);
  const pa = Math.min(ns + sv + dv, clamp0(minor(p.personalAllowance) - Math.floor(clamp0(ani - minor(p.personalAllowanceTaperThreshold)) / 200) * 100));
  const aNs = Math.max(clamp0(pa - sv - dv), Math.min(clamp0(minor(toNonSavings)), pa, ns));
  const rest = pa - aNs;
  const aSv = Math.max(clamp0(rest - dv), Math.min(clamp0(minor(toSavings)), rest, sv));
  const psa = psaFor(input.ty, clamp0(ns + sv + dv - pa), extension);
  return major(incomeTaxOn(input.ty, scottish, ns - aNs, sv - aSv, dv - (rest - aSv), extension, psa).tax);
}


export function planLabel(plan: StudentLoanPlan): string {
  return plan === 'postgraduate' ? 'Postgraduate Loan' : `Plan ${plan.slice(4)}`;
}
