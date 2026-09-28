// The projection model: pure functions over plain numbers, no store access, so every result is
// reproducible and testable. Every equation is written down in docs/FORMULAS.md §5–§7.
//
// Money here is in pounds as floating point (projections are estimates, rounded for display); the
// money.ts integer-pence rule is for recorded amounts, which never pass through this module.

import { addMonths, endOfMonth, type ISODate } from '../../shared/dates';
import type { Range } from '../../shared/assumptions';

/** z-score of the 90th percentile of a standard normal. */
export const Z90 = 1.2815515655446004;

/**
 * Log-return parameters of a lognormal annual growth factor with arithmetic mean return μ and
 * standard deviation σ: s² = ln(1 + σ²/(1+μ)²), m = ln(1+μ) − s²/2.
 */
export function logParams(mu: number, sigma: number): { m: number; s2: number } {
  const s2 = Math.log(1 + (sigma * sigma) / ((1 + mu) * (1 + mu)));
  return { m: Math.log(1 + mu) - s2 / 2, s2 };
}

/** Median annual growth, e^m − 1: what a typical year compounds at (below the mean μ). */
export function medianGrowth(mu: number, sigma: number): number {
  return Math.exp(logParams(mu, sigma).m) - 1;
}

/** Monthly factor for an annual rate: (1+r)^(1/12). */
export const monthly = (annual: number) => Math.pow(1 + annual, 1 / 12);

export interface MomentInput {
  /** Value today. */
  start: number;
  /** Money added at the start of each month t = 0…T−1, before that month's growth. */
  contributions: number[];
  /** Annual arithmetic mean return (nominal, before charges). */
  mu: number;
  /** Annual volatility. */
  sigma: number;
  /** Annual charges as a share of value. */
  fee: number;
  /** Standard deviation of the estimate of μ itself (parameter uncertainty), 0 when certain. */
  muSd?: number;
}

/**
 * First and second moments of wealth after each month, exact for independent lognormal monthly
 * returns (FORMULAS.md §6):
 *   W₍ₜ₊₁₎ = (Wₜ + Cₜ)·G,  E[G] = a₁ = (1+μ)^(1/12)(1−f)^(1/12),  E[G²] = a₂ = a₁²·e^(s²/12)
 *   E[W₍ₜ₊₁₎] = (E[Wₜ] + Cₜ)·a₁
 *   E[W²₍ₜ₊₁₎] = (E[Wₜ²] + 2Cₜ·E[Wₜ] + Cₜ²)·a₂
 * Uncertainty in μ is integrated with 3-point Gauss–Hermite quadrature: μ ± √3·δ (weight 1/6
 * each) and μ (weight 2/3), mixing the moments.
 */
export function momentPath(input: MomentInput): { m1: number[]; m2: number[] } {
  const T = input.contributions.length;
  const sd = input.muSd ?? 0;
  const nodes = sd > 0 ? [-1, 0, 1].map((k) => ({ mu: input.mu + k * Math.sqrt(3) * sd, w: k === 0 ? 2 / 3 : 1 / 6 })) : [{ mu: input.mu, w: 1 }];
  const m1 = new Array<number>(T + 1).fill(0);
  const m2 = new Array<number>(T + 1).fill(0);
  for (const node of nodes) {
    const { s2 } = logParams(Math.max(node.mu, -0.99), input.sigma);
    const a1 = monthly(Math.max(node.mu, -0.99)) * monthly(-input.fee);
    const a2 = a1 * a1 * Math.exp(s2 / 12);
    let e1 = input.start;
    let e2 = input.start * input.start;
    m1[0]! += node.w * e1;
    m2[0]! += node.w * e2;
    for (let t = 0; t < T; t++) {
      const c = input.contributions[t]!;
      const next1 = (e1 + c) * a1;
      const next2 = (e2 + 2 * c * e1 + c * c) * a2;
      e1 = next1;
      e2 = next2;
      m1[t + 1]! += node.w * e1;
      m2[t + 1]! += node.w * e2;
    }
  }
  return { m1, m2 };
}

export interface Band {
  p10: number;
  p50: number;
  p90: number;
}

/**
 * Percentiles of a lognormal with the given first two moments (Fenton–Wilkinson):
 *   σ² = ln(E[W²]/E[W]²), median = E[W]/e^(σ²/2), pₖ = median·e^(zₖσ).
 * Non-positive means (possible after large withdrawals) fall back to a normal approximation.
 */
export function lognormalBand(m1: number, m2: number): Band {
  if (!(m1 > 0)) {
    const sd = Math.sqrt(Math.max(0, m2 - m1 * m1));
    return { p10: m1 - Z90 * sd, p50: m1, p90: m1 + Z90 * sd };
  }
  const s2 = Math.max(0, Math.log(Math.max(1, m2 / (m1 * m1))));
  const s = Math.sqrt(s2);
  const median = m1 / Math.exp(s2 / 2);
  return { p10: median * Math.exp(-Z90 * s), p50: median, p90: median * Math.exp(Z90 * s) };
}

/** δ, the standard deviation of μ's estimate, from its plausible 10th–90th percentile range. */
export function muSdFromRange(range: Range | undefined): number {
  return range ? Math.max(0, (range.high - range.low) / (2 * Z90)) : 0;
}

export interface SimAccount {
  id: string;
  bucket: 'cash' | 'market' | 'pension' | 'property' | 'debt';
  /** Value today, in pounds. */
  value: number;
  /** Market and pension accounts: annual mean return (nominal, before charges), volatility, charges. */
  mu?: number;
  sigma?: number;
  fee?: number;
  /** A flat yearly charge, in pounds. */
  fixedFee?: number;
  /** Cash accounts: annual interest (AER). */
  interest?: number;
  /** Property: annual growth. */
  growth?: number;
  /** Monthly contribution paid from your cash (today's money). */
  contribution?: number;
  /** Monthly money arriving from outside your cash: employer, tax relief, LISA bonus. */
  external?: number;
}

export interface SimInput {
  start: ISODate;
  months: number;
  accounts: SimAccount[];
  /** Monthly income and spending in today's money. */
  income: number;
  spending: number;
  /** Monthly investing not tied to a known account (joins the combined portfolio). */
  unassignedInvesting: number;
  /** Standard error of the monthly saving estimate, in pounds. */
  netUncertainty: number;
  inflation: number;
  salaryGrowth: number;
  spendingGrowth: number;
  contributionGrowth: number;
  /** The market and pension accounts as one portfolio, for the band. */
  pool: { mu: number; muRange?: Range | undefined; sigma: number; fee: number };
}

export interface SimPoint {
  date: ISODate;
  month: number;
  /** Future pounds. */
  cash: number;
  market: number;
  pension: number;
  property: number;
  debt: number;
  total: number;
  /** p10–p90 of the total, future pounds. */
  band: Band;
  /** Divide by this to express the point in today's money: (1+π)^(t/12). */
  deflator: number;
}

/**
 * Month-by-month projection (FORMULAS.md §5). Each account compounds at its own median growth net
 * of charges; cash earns its interest and takes income − spending − contributions; property
 * grows; debts stay flat. The band combines the portfolio's lognormal spread with the uncertainty
 * of the monthly saving estimate, which grows linearly with time.
 */
export function simulate(input: SimInput): SimPoint[] {
  const T = Math.max(0, Math.round(input.months));
  const g = (annual: number, t: number) => Math.pow(1 + annual, t / 12);
  const cashAccounts = input.accounts.filter((a) => a.bucket === 'cash');
  const positiveCash = cashAccounts.reduce((s, a) => s + Math.max(0, a.value), 0);
  // Cash earns the balance-weighted rate of the accounts holding it.
  const cashRate = positiveCash > 0 ? cashAccounts.reduce((s, a) => s + Math.max(0, a.value) * (a.interest ?? 0), 0) / positiveCash : 0;
  const invest = input.accounts.filter((a) => a.bucket === 'market' || a.bucket === 'pension');
  const state = new Map(invest.map((a) => [a.id, a.value]));
  let cash = cashAccounts.reduce((s, a) => s + a.value, 0);
  let unassigned = 0;
  let property = input.accounts.filter((a) => a.bucket === 'property').reduce((s, a) => s + a.value, 0);
  const propertyGrowth = (() => {
    const p = input.accounts.filter((a) => a.bucket === 'property');
    const v = p.reduce((s, a) => s + Math.max(0, a.value), 0);
    return v > 0 ? p.reduce((s, a) => s + Math.max(0, a.value) * (a.growth ?? 0), 0) / v : 0;
  })();
  const debt = input.accounts.filter((a) => a.bucket === 'debt').reduce((s, a) => s + a.value, 0);

  // The combined portfolio's contributions each month, for its moments.
  const poolContrib: number[] = [];
  const points: SimPoint[] = [];
  const sum = (bucket: 'market' | 'pension') => invest.filter((a) => a.bucket === bucket).reduce((s, a) => s + state.get(a.id)!, 0);
  const push = (t: number, band: Band) => {
    const market = sum('market') + unassigned;
    const pension = sum('pension');
    const total = cash + market + pension + property + debt;
    points.push({ date: t === 0 ? input.start : endOfMonth(addMonths(input.start, t)), month: t, cash, market, pension, property, debt, total, band, deflator: g(input.inflation, t) });
  };
  const poolStart = invest.reduce((s, a) => s + a.value, 0);
  push(0, { p10: poolStart + cash + property + debt, p50: poolStart + cash + property + debt, p90: poolStart + cash + property + debt });

  const growthOf = new Map(invest.map((a) => [a.id, monthly(medianGrowth(a.mu ?? 0, a.sigma ?? 0)) * monthly(-(a.fee ?? 0))]));
  const poolGrowth = monthly(medianGrowth(input.pool.mu, input.pool.sigma)) * monthly(-input.pool.fee);
  for (let t = 0; t < T; t++) {
    const inc = input.income * g(input.salaryGrowth, t);
    const spend = input.spending * g(input.spendingGrowth, t);
    const cg = g(input.contributionGrowth, t);
    let paid = 0;
    let into = 0;
    for (const a of invest) {
      const c = (a.contribution ?? 0) * cg;
      const e = (a.external ?? 0) * cg;
      paid += c;
      into += c + e - (a.fixedFee ?? 0) / 12;
      state.set(a.id, (state.get(a.id)! + c + e) * growthOf.get(a.id)! - (a.fixedFee ?? 0) / 12);
    }
    const u = input.unassignedInvesting * cg;
    paid += u;
    into += u;
    unassigned = (unassigned + u) * poolGrowth;
    poolContrib.push(into);
    cash = cash * (cash > 0 ? monthly(cashRate) : 1) + inc - spend - paid;
    property *= monthly(propertyGrowth);
    push(t + 1, { p10: 0, p50: 0, p90: 0 });
  }

  // Bands: the portfolio's spread around its median, combined root-sum-square with the saving
  // estimate's error (independent), and centred on the account-by-account median path.
  const { m1, m2 } = momentPath({ start: poolStart, contributions: poolContrib, mu: input.pool.mu, sigma: input.pool.sigma, fee: input.pool.fee, muSd: muSdFromRange(input.pool.muRange) });
  for (const p of points) {
    const pool = lognormalBand(m1[p.month]!, m2[p.month]!);
    const sdCash = input.netUncertainty * p.month;
    const down = Math.hypot(pool.p50 - pool.p10, Z90 * sdCash);
    const up = Math.hypot(pool.p90 - pool.p50, Z90 * sdCash);
    p.band = { p10: p.total - down, p50: p.total, p90: p.total + up };
  }
  return points;
}

export interface RetirementInput {
  /** Months until retirement. */
  months: number;
  /** Pension pots today. */
  start: number;
  /** Monthly contributions to pensions today (all sources), growing at `contributionGrowth`. */
  monthlyContribution: number;
  contributionGrowth: number;
  pool: { mu: number; muRange?: Range | undefined; sigma: number; fee: number };
  inflation: number;
  withdrawalRate: number;
}

export interface RetirementResult {
  /** Pension pots at retirement, in today's money. */
  pot: Band;
  /** Sustainable yearly income from them, in today's money: pot × withdrawal rate. */
  income: Band;
}

/** Pension pots at retirement and the income they sustain (FORMULAS.md §7). */
export function retirement(input: RetirementInput): RetirementResult {
  const T = Math.max(0, Math.round(input.months));
  const contributions = Array.from({ length: T }, (_, t) => input.monthlyContribution * Math.pow(1 + input.contributionGrowth, t / 12));
  const { m1, m2 } = momentPath({ start: input.start, contributions, mu: input.pool.mu, sigma: input.pool.sigma, fee: input.pool.fee, muSd: muSdFromRange(input.pool.muRange) });
  const deflator = Math.pow(1 + input.inflation, T / 12);
  const nominal = lognormalBand(m1[T]!, m2[T]!);
  const pot = { p10: nominal.p10 / deflator, p50: nominal.p50 / deflator, p90: nominal.p90 / deflator };
  return { pot, income: { p10: pot.p10 * input.withdrawalRate, p50: pot.p50 * input.withdrawalRate, p90: pot.p90 * input.withdrawalRate } };
}

/**
 * Charges in pounds over a horizon: the difference between growing with and without them
 * (FORMULAS.md §8). Uses the median growth path with the given contributions.
 */
export function feeDrag(input: { start: number; monthlyContribution: number; months: number; mu: number; sigma: number; fee: number; fixedFee: number }): { withFees: number; withoutFees: number; drag: number } {
  const gross = monthly(medianGrowth(input.mu, input.sigma));
  let withFees = input.start;
  let withoutFees = input.start;
  for (let t = 0; t < input.months; t++) {
    withFees = (withFees + input.monthlyContribution) * gross * monthly(-input.fee) - input.fixedFee / 12;
    withoutFees = (withoutFees + input.monthlyContribution) * gross;
  }
  return { withFees, withoutFees, drag: withoutFees - withFees };
}
