// Goals: how far each has come from the accounts that fund it, and when it is reached if the
// recent pace carries on, with a range (docs/FORMULAS.md §16).

import type { GoalProgress, GoalsResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addMonths, diffDays, eachMonth, formatMonth, maxDate, minDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, toMinor } from '../../shared/money';
import type { Account, Goal } from '../../shared/schema';
import { ageOn, taxYearOf, taxYearParams } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { computeBaseline, DAYS_PER_MONTH, standardPeriods, type Baseline } from './baseline';
import { Coverage } from './coverage';
import { lognormalBand, medianGrowth, momentPath, muSdFromRange } from './model';
import { accountParams, makeResolver, type AccountParams } from './params';

export const GOAL_RULES = {
  /** How far ahead a goal is followed, in months. */
  horizonMonths: 480,
} as const;

/**
 * An account's money coming in each month at the recent pace. A wrapper's comes from the baseline
 * (contributions, employer money, relief, the LISA bonus). A cash account's is what moved in and out
 * of it, net: everything but its interest and prizes (income), which its rate stands for.
 */
export function monthlyInflow(store: Store, account: Account, b: Baseline): { monthly: number; basis: string } {
  const wrapper = b.wrappers.find((w) => w.accountId === account.id);
  if (wrapper) return { monthly: wrapper.personal + wrapper.external, basis: wrapper.notes.join('; ') || 'Payments in over the period' };
  if (!b.available) return { monthly: 0, basis: 'No recent period with data for every account' };
  const cats = new CategoryIndex(store.categories);
  const txs = store.transactions(account.id);
  const snaps = store.balances(account.id);
  const dataFrom = minDate(txs[0]?.date, snaps[0]?.date);
  const dataTo = maxDate(txs[txs.length - 1]?.date, snaps[snaps.length - 1]?.date);
  const from = maxDate(b.from, dataFrom) ?? b.from;
  const to = minDate(b.to, dataTo) ?? b.to;
  if (from > to) return { monthly: 0, basis: 'No data for it in the period' };
  const months = b.basis.kind === 'months' ? eachMonth(from, to).length : Math.max(diffDays(from, to) + 1, 1) / DAYS_PER_MONTH;
  let net = 0;
  for (const t of txs) if (t.date >= from && t.date <= to && cats.kindOf(t.category) !== 'income') net += toMinor(t.amount);
  return { monthly: Math.round(net / months) / 100, basis: `Money moved in and out of it, ${formatMonth(from)} – ${formatMonth(to)}, net of interest` };
}

/**
 * How much of a Lifetime ISA a goal can count. The 25% withdrawal charge applies unless the money
 * buys a first home (a home within the price cap, the LISA at least a year old) or you are 60.
 */
export function lisaShare(store: Store, goal: Goal, account: Account, on: ISODate): { share: number; note?: string } {
  if (account.type !== 'lisa') return { share: 1 };
  const ty = taxYearParams(taxYearOf(on));
  const penalised = 1 - ty.lisaWithdrawalCharge;
  const dob = store.profile.dateOfBirth;
  if (dob && ageOn(dob, on) >= 60) return { share: 1, note: 'Free to take out at 60 or over' };
  if (goal.kind !== 'home-deposit') return { share: penalised, note: `Counted at ${Math.round(penalised * 100)}%: taking it out for anything but a first home before 60 costs the ${Math.round(ty.lisaWithdrawalCharge * 100)}% charge` };
  if (goal.propertyPrice !== undefined && goal.propertyPrice > ty.lisaPropertyPriceCap) {
    return { share: penalised, note: `Counted at ${Math.round(penalised * 100)}%: a home over ${formatMoney(ty.lisaPropertyPriceCap, { decimals: 0 })} is not a qualifying purchase, so the charge applies` };
  }
  const first = minDate(account.openedOn, store.transactions(account.id)[0]?.date, store.balances(account.id)[0]?.date);
  const yearOld = first ? addMonths(first, 12) : null;
  if (yearOld && goal.targetDate && goal.targetDate < yearOld) return { share: penalised, note: `Counted at ${Math.round(penalised * 100)}%: it will not be a year old (from ${first}) by ${goal.targetDate}` };
  return { share: 1, note: goal.propertyPrice === undefined ? `Counted in full for a first home up to ${formatMoney(ty.lisaPropertyPriceCap, { decimals: 0 })}` : 'Counted in full: a first home within the price cap' };
}

interface Path {
  /** Expected value after each month (index 0 = today). */
  mean: number[];
  sd: number[];
}

/** One account's path: its own growth after charges, with its inflow added each month. */
export function accountPath(p: Pick<AccountParams, 'bucket' | 'value' | 'expectedReturn' | 'volatility' | 'fundFee' | 'platformFee' | 'interest'>, monthly: number, months: number): Path {
  const market = p.bucket === 'market' || p.bucket === 'pension';
  const mu = market ? p.expectedReturn.value : (p.interest?.value ?? 0);
  const sigma = market ? p.volatility.value : 0;
  const fee = market ? p.fundFee.value + p.platformFee.value : 0;
  const muSd = market ? muSdFromRange(p.expectedReturn.range) : 0;
  const { m1, m2 } = momentPath({ start: p.value, contributions: new Array<number>(months).fill(monthly), mu, sigma, fee, muSd });
  // With nothing uncertain the spread is nil (m2 − m1² would only be rounding).
  return { mean: m1, sd: sigma === 0 && muSd === 0 ? m1.map(() => 0) : m1.map((m, i) => Math.sqrt(Math.max(0, m2[i]! - m * m))) };
}

/** Median monthly growth of an account after charges: what a typical month compounds at. */
export function medianMonthly(p: Pick<AccountParams, 'bucket' | 'expectedReturn' | 'volatility' | 'fundFee' | 'platformFee' | 'interest'>): number {
  const market = p.bucket === 'market' || p.bucket === 'pension';
  const annual = market ? (1 + medianGrowth(p.expectedReturn.value, p.volatility.value)) * (1 - p.fundFee.value - p.platformFee.value) - 1 : (p.interest?.value ?? 0);
  return Math.pow(1 + annual, 1 / 12) - 1;
}

export function goalsProgress(store: Store, engine: BalanceEngine, now: ISODate = today(), coverage: Coverage = new Coverage(store)): GoalsResponse {
  const resolver = makeResolver(store, now);
  const [recent, year] = standardPeriods(now, coverage);
  let b = computeBaseline(store, coverage, recent!.from, recent!.to, resolver.set);
  let period = recent!;
  if (!b.available) {
    b = computeBaseline(store, coverage, year!.from, year!.to, resolver.set);
    period = year!;
  }
  const pace = b.available ? period.label.replace(/^If /, '').replace(/ continued$/, '') : null;

  const goals: GoalProgress[] = store.goals.map((goal) => {
    const kind = goal.kind ?? 'savings';
    const notes: string[] = [];
    const accounts = goal.accountIds.map((id) => store.account(id)).filter((a): a is Account => a !== undefined);
    if (accounts.length < goal.accountIds.length) notes.push('Some of its accounts no longer exist.');
    const parts = accounts.map((a) => {
      const params = accountParams(store, engine, resolver, a, now);
      const inflow = a.status === 'closed' ? { monthly: 0, basis: 'Closed' } : monthlyInflow(store, a, b);
      const lisa = lisaShare(store, goal, a, goal.targetDate ?? now);
      return { account: a, params, inflow, lisa };
    });

    // The target: an amount, or months of spending.
    let target: number | null = goal.targetAmount ?? null;
    let targetBasis = target !== null ? 'Your amount' : 'No amount set';
    if (kind === 'emergency-fund' && goal.months) {
      if (b.available && b.monthly.spending > 0) {
        target = Math.round(goal.months * b.monthly.spending);
        targetBasis = `${goal.months} month${goal.months === 1 ? '' : 's'} of spending at ${formatMoney(b.monthly.spending, { decimals: 0 })} a month (${pace})`;
      } else {
        target = goal.targetAmount ?? null;
        targetBasis = 'Your spending is not known yet: import a month of statements for every account';
      }
    }

    const current = Math.round(parts.reduce((s, p) => s + p.params.value * p.lisa.share, 0) * 100) / 100;
    const monthly = Math.round(parts.reduce((s, p) => s + p.inflow.monthly * p.lisa.share, 0) * 100) / 100;
    for (const p of parts) if (p.lisa.note) notes.push(`${p.account.name}: ${p.lisa.note}.`);

    // Follow it month by month: each account at its own growth and inflow, the spreads added
    // (as if the accounts moved together, which errs wide).
    const untilDate = goal.targetDate ? Math.max(eachMonth(now, goal.targetDate).length - 1, 0) : 0;
    const months = Math.min(GOAL_RULES.horizonMonths, Math.max(untilDate + 60, 120));
    const paths = parts.map((p) => ({ path: accountPath(p.params, p.inflow.monthly, months), share: p.lisa.share }));
    const at = (t: number) => {
      const mean = paths.reduce((s, x) => s + x.path.mean[t]! * x.share, 0);
      const sd = paths.reduce((s, x) => s + x.path.sd[t]! * x.share, 0);
      return lognormalBand(mean, sd * sd + mean * mean);
    };
    let reach: GoalProgress['reach'] = null;
    if (target !== null && parts.length && current < target) {
      const first = (key: 'p10' | 'p50' | 'p90') => {
        for (let t = 1; t <= months; t++) if (at(t)[key] >= target) return addMonths(now, t);
        return null;
      };
      reach = { early: first('p90'), median: first('p50'), late: first('p10') };
    }
    const atTarget = goal.targetDate && parts.length && untilDate <= months ? at(untilDate) : null;

    // What more a month would reach it by the date, at the median: the gap spread over the months,
    // each month's money growing at the accounts' blended median rate.
    let neededMonthly: number | null = null;
    if (target !== null && atTarget && untilDate > 0 && atTarget.p50 < target) {
      const weights = parts.map((p) => Math.max(p.params.value, 0) || Math.max(p.inflow.monthly, 0) || 1);
      const total = weights.reduce((s, w) => s + w, 0);
      const g = parts.reduce((s, p, i) => s + (weights[i]! / total) * medianMonthly(p.params), 0);
      let annuity = 0;
      for (let t = 0; t < untilDate; t++) annuity += Math.pow(1 + g, untilDate - t);
      neededMonthly = Math.ceil((target - atTarget.p50) / annuity);
    } else if (target !== null && atTarget) {
      neededMonthly = 0;
    }

    const status: GoalProgress['status'] =
      target === null || !parts.length ? 'unknown' : current >= target ? 'reached' : !goal.targetDate ? (reach?.median ? 'no-date' : 'unknown') : reach?.median && reach.median <= goal.targetDate ? 'on-track' : 'behind';
    if (!b.available) notes.push('The recent pace is not known yet: it takes a month of data for every account, so the projection has no money coming in.');

    return {
      id: goal.id,
      name: goal.name,
      kind,
      target,
      targetBasis,
      targetDate: goal.targetDate ?? null,
      current,
      share: target ? current / target : null,
      monthly,
      accounts: parts.map((p) => ({ accountId: p.account.id, name: p.account.name, value: p.params.value, counted: Math.round(p.params.value * p.lisa.share * 100) / 100, monthly: p.inflow.monthly, monthlyBasis: p.inflow.basis, ...(p.lisa.note ? { note: p.lisa.note } : {}) })),
      reach,
      atTargetDate: atTarget ? { p10: Math.round(atTarget.p10), p50: Math.round(atTarget.p50), p90: Math.round(atTarget.p90) } : null,
      neededMonthly,
      status,
      notes,
      ...(goal.notes ? { ownerNotes: goal.notes } : {}),
    };
  });

  return { goals, pace, notes: ['Amounts are in pounds of the day, not adjusted for inflation.'] };
}
