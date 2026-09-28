// The projection model: moment recursion against a seeded Monte Carlo oracle, bands, fees,
// inflation, and the retirement outlook.

import { describe, expect, it } from 'vitest';
import { feeDrag, lognormalBand, logParams, medianGrowth, momentPath, monthly, muSdFromRange, retirement, simulate, Z90, type SimInput } from '../src/server/analytics/model';

/** mulberry32: small, seeded, deterministic. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Simulate W(t+1) = (W(t) + C(t)) · G with lognormal monthly G, optionally with an uncertain μ. */
function monteCarlo(start: number, contributions: number[], mu: number, sigma: number, fee: number, muSd: number, paths: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let p = 0; p < paths; p++) {
    const pathMu = mu + muSd * normal(r);
    const { m, s2 } = logParams(pathMu, sigma);
    let w = start;
    for (const c of contributions) w = (w + c) * Math.exp(m / 12 + Math.sqrt(s2 / 12) * normal(r)) * monthly(-fee);
    out.push(w);
  }
  return out.sort((a, b) => a - b);
}

describe('lognormal building blocks', () => {
  it('recovers the arithmetic mean and gives a lower median', () => {
    const { m, s2 } = logParams(0.065, 0.16);
    expect(Math.exp(m + s2 / 2) - 1).toBeCloseTo(0.065, 10);
    expect(medianGrowth(0.065, 0.16)).toBeLessThan(0.065);
    expect(medianGrowth(0.05, 0)).toBeCloseTo(0.05, 12);
  });

  it('fits a band that is ordered and collapses without variance', () => {
    const b = lognormalBand(100, 100 * 100 * 1.04);
    expect(b.p10).toBeLessThan(b.p50);
    expect(b.p50).toBeLessThan(b.p90);
    expect(b.p50).toBeLessThan(100);
    const flat = lognormalBand(100, 100 * 100);
    expect(flat.p10).toBeCloseTo(100, 8);
    expect(flat.p90).toBeCloseTo(100, 8);
  });

  it('reads a μ range as its 10th–90th percentile', () => {
    expect(muSdFromRange({ low: 0.03, high: 0.09 })).toBeCloseTo(0.03 / Z90, 10);
    expect(muSdFromRange(undefined)).toBe(0);
  });
});

describe('moment recursion', () => {
  it('matches Monte Carlo for a lump sum with regular contributions', () => {
    const contributions = Array.from({ length: 240 }, () => 500);
    const { m1, m2 } = momentPath({ start: 20_000, contributions, mu: 0.06, sigma: 0.15, fee: 0.004 });
    const sims = monteCarlo(20_000, contributions, 0.06, 0.15, 0.004, 0, 20_000, 7);
    const mean = sims.reduce((s, v) => s + v, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((s, v) => s + (v - mean) ** 2, 0) / sims.length);
    expect(m1[240]! / mean).toBeGreaterThan(0.985);
    expect(m1[240]! / mean).toBeLessThan(1.015);
    const modelSd = Math.sqrt(m2[240]! - m1[240]! ** 2);
    expect(modelSd / sd).toBeGreaterThan(0.95);
    expect(modelSd / sd).toBeLessThan(1.05);
    // The fitted percentiles land close to the simulated ones.
    const band = lognormalBand(m1[240]!, m2[240]!);
    const q = (p: number) => sims[Math.floor(p * sims.length)]!;
    expect(band.p50 / q(0.5)).toBeGreaterThan(0.97);
    expect(band.p50 / q(0.5)).toBeLessThan(1.03);
    expect(band.p10 / q(0.1)).toBeGreaterThan(0.94);
    expect(band.p90 / q(0.9)).toBeLessThan(1.06);
  });

  it('integrates uncertainty in the expected return, widening the spread', () => {
    const contributions = Array.from({ length: 360 }, () => 300);
    const certain = momentPath({ start: 10_000, contributions, mu: 0.055, sigma: 0.12, fee: 0 });
    const uncertain = momentPath({ start: 10_000, contributions, mu: 0.055, sigma: 0.12, fee: 0, muSd: 0.015 });
    const sims = monteCarlo(10_000, contributions, 0.055, 0.12, 0, 0.015, 20_000, 11);
    const mean = sims.reduce((s, v) => s + v, 0) / sims.length;
    expect(uncertain.m1[360]! / mean).toBeGreaterThan(0.97);
    expect(uncertain.m1[360]! / mean).toBeLessThan(1.03);
    const sdCertain = Math.sqrt(certain.m2[360]! - certain.m1[360]! ** 2);
    const sdUncertain = Math.sqrt(uncertain.m2[360]! - uncertain.m1[360]! ** 2);
    expect(sdUncertain).toBeGreaterThan(sdCertain * 1.2);
  });

  it('is exact with no volatility: plain compounding', () => {
    const { m1, m2 } = momentPath({ start: 1000, contributions: [100, 100, 100], mu: 0.12, sigma: 0, fee: 0 });
    const g = monthly(0.12);
    const expected = ((1000 + 100) * g + 100) * g * g + 100 * g;
    expect(m1[3]).toBeCloseTo(((((1000 + 100) * g + 100) * g + 100) * g), 8);
    expect(m2[3]).toBeCloseTo(m1[3]! ** 2, 4);
    expect(expected).toBeGreaterThan(0);
  });
});

const baseInput = (over: Partial<SimInput> = {}): SimInput => ({
  start: '2026-10-01',
  months: 120,
  accounts: [],
  income: 0,
  spending: 0,
  unassignedInvesting: 0,
  netUncertainty: 0,
  inflation: 0,
  salaryGrowth: 0,
  spendingGrowth: 0,
  contributionGrowth: 0,
  pool: { mu: 0, sigma: 0, fee: 0 },
  ...over,
});

describe('simulate', () => {
  it('holds still with no growth and no flows', () => {
    const pts = simulate(baseInput({ accounts: [{ id: 'c', bucket: 'cash', value: 1000 }, { id: 'd', bucket: 'debt', value: -300 }] }));
    expect(pts).toHaveLength(121);
    expect(pts[120]!.total).toBeCloseTo(700, 8);
    expect(pts[120]!.band.p10).toBeCloseTo(700, 8);
  });

  it('adds saving to cash and earns its interest', () => {
    const pts = simulate(baseInput({ months: 12, income: 3000, spending: 2000, accounts: [{ id: 'c', bucket: 'cash', value: 10_000, interest: 0.04 }] }));
    // 10,000 at 4% for a year plus 1,000 a month earning interest from when it arrives.
    expect(pts[12]!.cash).toBeGreaterThan(10_000 * 1.04 + 12_000);
    expect(pts[12]!.cash).toBeLessThan(10_000 * 1.04 + 12_000 * 1.03);
  });

  it('moves contributions from cash into the account and adds external money', () => {
    const pts = simulate(
      baseInput({
        months: 12,
        income: 1000,
        accounts: [
          { id: 'c', bucket: 'cash', value: 0 },
          { id: 'p', bucket: 'pension', value: 0, mu: 0, sigma: 0, fee: 0, contribution: 200, external: 50 },
        ],
      }),
    );
    expect(pts[12]!.cash).toBeCloseTo(12 * 800, 6);
    expect(pts[12]!.pension).toBeCloseTo(12 * 250, 6);
  });

  it('charges reduce growth; fixed fees come off each month', () => {
    const acc = (fee: number, fixedFee = 0) => simulate(baseInput({ accounts: [{ id: 'm', bucket: 'market', value: 100_000, mu: 0.06, sigma: 0.15, fee, fixedFee }], pool: { mu: 0.06, sigma: 0.15, fee } }))[120]!.market;
    expect(acc(0.01)).toBeLessThan(acc(0));
    expect(acc(0, 120)).toBeLessThan(acc(0));
    expect(acc(0) / 100_000).toBeCloseTo(Math.pow(1 + medianGrowth(0.06, 0.15), 10), 6);
  });

  it('bands are ordered and widen with time and with saving uncertainty', () => {
    const run = (netUncertainty: number) =>
      simulate(baseInput({ netUncertainty, accounts: [{ id: 'm', bucket: 'market', value: 50_000, mu: 0.06, sigma: 0.16, fee: 0.003 }], pool: { mu: 0.06, sigma: 0.16, fee: 0.003, muRange: { low: 0.035, high: 0.085 } } }));
    const pts = run(0);
    for (const p of pts) {
      expect(p.band.p10).toBeLessThanOrEqual(p.band.p50 + 1e-6);
      expect(p.band.p50).toBeLessThanOrEqual(p.band.p90 + 1e-6);
    }
    const width = (p: (typeof pts)[number]) => p.band.p90 - p.band.p10;
    expect(width(pts[120]!)).toBeGreaterThan(width(pts[60]!));
    expect(width(run(200)[120]!)).toBeGreaterThan(width(pts[120]!));
  });

  it('reports the inflation deflator for today’s money', () => {
    const pts = simulate(baseInput({ inflation: 0.02 }));
    expect(pts[120]!.deflator).toBeCloseTo(Math.pow(1.02, 10), 10);
  });
});

describe('retirement and charges', () => {
  it('income is the pot times the withdrawal rate, in today’s money', () => {
    const r = retirement({ months: 300, start: 50_000, monthlyContribution: 800, contributionGrowth: 0.02, pool: { mu: 0.06, sigma: 0.14, fee: 0.004 }, inflation: 0.02, withdrawalRate: 0.035 });
    expect(r.income.p50).toBeCloseTo(r.pot.p50 * 0.035, 6);
    expect(r.pot.p10).toBeLessThan(r.pot.p50);
    expect(r.pot.p50).toBeLessThan(r.pot.p90);
  });

  it('fee drag is positive and grows with the charge', () => {
    const a = feeDrag({ start: 50_000, monthlyContribution: 500, months: 240, mu: 0.06, sigma: 0.15, fee: 0.002, fixedFee: 0 });
    const b = feeDrag({ start: 50_000, monthlyContribution: 500, months: 240, mu: 0.06, sigma: 0.15, fee: 0.008, fixedFee: 0 });
    expect(a.drag).toBeGreaterThan(0);
    expect(b.drag).toBeGreaterThan(a.drag * 3);
  });
});
