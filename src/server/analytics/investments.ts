// Investments, ISAs and pensions: value, contributions, growth, money-weighted return, holdings,
// charges and their drag, LISA specifics, and the retirement outlook with a range. Parameters come
// from params.ts; equations are in docs/FORMULAS.md §7–§9.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { InvestmentAccountSummary, InvestmentsResponse } from '../../shared/api';
import { EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { diffDays, formatDate, today } from '../../shared/dates';
import { fromMinor, roundMoney, subMoney, toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import { ageOn, birthdayAt, lisaPenaltyAdjustedValue, pensionAccessDate, statePensionDate, statePensionFullYearly, taxYearOf, taxYearParams } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { computeBaseline, standardPeriods } from './baseline';
import { Coverage } from './coverage';
import { feeDrag, retirement as retirementModel } from './model';
import { accountParams, makeResolver, poolStats } from './params';
import { assumptionsInUse, summariseParams } from './projections';

/** Money-weighted annual return. Flows: negative = money you put in, positive = value out. */
export function xirr(flows: { date: string; amount: number }[]): number | null {
  if (flows.length < 2) return null;
  const t0 = flows[0]!.date;
  const years = flows.map((f) => diffDays(t0, f.date) / 365.25);
  if (years[years.length - 1]! < 0.08) return null;
  const npv = (r: number) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, years[i]!), 0);
  const dnpv = (r: number) => flows.reduce((s, f, i) => s - (years[i]! * f.amount) / Math.pow(1 + r, years[i]! + 1), 0);
  let r = 0.05;
  for (let i = 0; i < 50; i++) {
    const v = npv(r);
    const d = dnpv(r);
    if (!Number.isFinite(v) || !Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.99) break;
    if (Math.abs(next - r) < 1e-7) return next;
    r = next;
  }
  // Bisection fallback.
  let lo = -0.99;
  let hi = 5;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function isInvestmentAccount(a: Account): boolean {
  const meta = ACCOUNT_TYPE_META[a.type];
  if (a.type === 'property' || a.type === 'other_asset' || a.type === 'state_pension' || a.type === 'db_pension' || a.type === 'cash_isa') return false;
  return balanceModeOf(a) === 'market' || Boolean(meta.isa) || Boolean(meta.pension);
}

export function investments(store: Store, engine: BalanceEngine): InvestmentsResponse {
  const now = today();
  const dob = store.profile.dateOfBirth;
  const resolver = makeResolver(store, now);
  const { set } = resolver;
  const coverage = new Coverage(store);
  const inflation = set.resolve('inflation').value;
  // Contributions going forward: the last 12 months where covered, else the last 3.
  const [recentPeriod, yearPeriod] = standardPeriods(now, coverage);
  const yearBaseline = computeBaseline(store, coverage, yearPeriod!.from, yearPeriod!.to, set);
  const baseline = yearBaseline.available ? yearBaseline : computeBaseline(store, coverage, recentPeriod!.from, recentPeriod!.to, set);
  const flowFor = new Map(baseline.wrappers.map((w) => [w.accountId, w]));
  const retirementDate = dob ? birthdayAt(dob, store.profile.retirementAge) : null;
  const horizonMonths = retirementDate && retirementDate > now ? Math.round(diffDays(now, retirementDate) / 30.4375) : 120;

  const accounts: InvestmentAccountSummary[] = [];
  const allocation = new Map<string, number>();
  let totalValue = 0;
  let totalContrib = 0;
  let pensions = 0;
  let isas = 0;
  let annualCharges = 0;
  const pensionParams = [];

  for (const a of store.accounts.filter((x) => x.status === 'open' && isInvestmentAccount(x))) {
    const meta = ACCOUNT_TYPE_META[a.type];
    const latest = engine.latest(a.id, now);
    const snaps = store.balances(a.id);
    const lastSnap = snaps[snaps.length - 1];
    const flowsTx = store.transactions(a.id).filter((t) => t.category && EXTERNAL_FLOW_CATEGORIES.has(t.category));
    let contributions: number | null = null;
    let contributionsSource: InvestmentAccountSummary['contributionsSource'] = null;
    if (lastSnap?.contributions !== undefined) {
      contributions = lastSnap.contributions;
      contributionsSource = 'provider';
    } else if (flowsTx.length) {
      contributions = fromMinor(flowsTx.reduce((s, t) => s + toMinor(t.amount), 0));
      contributionsSource = 'transactions';
    }
    const value = latest?.gbp ?? null;
    // LISA providers usually report your contributions and the government bonus separately; the
    // bonus is not investment growth.
    const bonusSeparate = a.type === 'lisa' && contributionsSource === 'provider' && lastSnap?.bonusToDate !== undefined ? lastSnap.bonusToDate : 0;
    const invested = contributions !== null ? roundMoney(contributions + bonusSeparate) : null;
    const growth = value !== null && invested !== null ? subMoney(value, invested) : null;
    // Money-weighted return over the period with valuations: the first recorded value as if
    // invested then, later external flows, and today's value.
    const firstSnap = snaps[0];
    const cashFlows = firstSnap ? [{ date: firstSnap.date, amount: -firstSnap.balance }, ...flowsTx.filter((t) => t.date > firstSnap.date).map((t) => ({ date: t.date, amount: -t.amount }))] : [];
    const irr = value !== null && firstSnap && firstSnap.balance > 0 ? xirr([...cashFlows, { date: now, amount: value }]) : null;

    let cumulative = 0;
    const flowIdx = [...flowsTx];
    const history = snaps.map((s) => {
      while (flowIdx.length && flowIdx[0]!.date <= s.date) cumulative += toMinor(flowIdx.shift()!.amount);
      return { date: s.date, value: s.balance, contributions: s.contributions ?? (flowsTx.length ? fromMinor(cumulative) : null) };
    });
    const holdingsList = store.holdings(a.id);
    const holdings = holdingsList[holdingsList.length - 1] ?? null;

    const params = accountParams(store, engine, resolver, a, now);
    // Accounts whose holdings are not known show as such, not as the "mixed" they are modelled as.
    if (params.value > 0 && a.includeInNetWorth) {
      if (!params.holdingsKnown) allocation.set('unknown', (allocation.get('unknown') ?? 0) + params.value);
      else for (const [cls, share] of Object.entries(params.exposure)) if (share > 0) allocation.set(cls, (allocation.get(cls) ?? 0) + share * params.value);
    }
    const flows = flowFor.get(a.id);
    const rate = params.fundFee.value + params.platformFee.value;
    const annual = roundMoney(params.value * rate + params.platformFixed.value);
    const drag = feeDrag({ start: params.value, monthlyContribution: (flows?.personal ?? 0) + (flows?.external ?? 0), months: horizonMonths, mu: params.expectedReturn.value, sigma: params.volatility.value, fee: rate, fixedFee: params.platformFixed.value });
    const deflator = Math.pow(1 + inflation, horizonMonths / 12);
    if (meta.pension) pensionParams.push(params);

    const summary: InvestmentAccountSummary = {
      id: a.id,
      name: a.name,
      type: a.type,
      typeLabel: meta.label,
      value,
      asOf: engine.lastDataDate(a.id),
      contributions,
      contributionsSource,
      growth,
      growthPct: growth !== null && invested ? growth / invested : null,
      xirr: irr,
      history,
      holdings,
      params: summariseParams(params),
      charges: { annual, drag: Math.round(drag.drag / deflator), horizonYears: Math.round((horizonMonths / 12) * 10) / 10, rate },
    };
    if (a.type === 'lisa') {
      const bonusTx = store.transactions(a.id).filter((t) => t.category === 'government-bonus');
      summary.lisa = {
        bonusToDate: lastSnap?.bonusToDate ?? (bonusTx.length ? fromMinor(bonusTx.reduce((s, t) => s + toMinor(t.amount), 0)) : null),
        penaltyAdjustedValue: value !== null ? lisaPenaltyAdjustedValue(value, taxYearOf(now)) : null,
        penaltyFreeFrom: dob ? birthdayAt(dob, 60) : null,
      };
    }
    if (meta.pension) summary.pension = { accessDate: dob ? pensionAccessDate(dob) : null };
    accounts.push(summary);
    if (value !== null && a.includeInNetWorth) {
      totalValue += toMinor(value);
      annualCharges += toMinor(annual);
      if (meta.pension) pensions += toMinor(value);
      if (meta.isa) isas += toMinor(value);
    }
    if (contributions !== null && a.includeInNetWorth) totalContrib += toMinor(contributions);
  }

  // Retirement outlook.
  const withdrawal = assumptionsInUse(set, ['withdrawal.rate'])[0]!;
  const pool = poolStats(pensionParams, resolver.rho);
  const monthlyPersonal = pensionParams.reduce((s, p) => s + (flowFor.get(p.accountId)?.personal ?? 0), 0);
  const monthlyExternal = pensionParams.reduce((s, p) => s + (flowFor.get(p.accountId)?.external ?? 0), 0);
  const notes: string[] = [];
  let pot = null;
  let income = null;
  if (dob && retirementDate) {
    const monthsToRetirement = Math.max(0, Math.round(diffDays(now, retirementDate) / 30.4375));
    const result = retirementModel({
      months: monthsToRetirement,
      start: fromMinor(pensions),
      monthlyContribution: monthlyPersonal + monthlyExternal,
      contributionGrowth: set.resolve('contribution.growth').value,
      pool,
      inflation,
      withdrawalRate: withdrawal.value,
    });
    pot = { p10: Math.round(result.pot.p10), p50: Math.round(result.pot.p50), p90: Math.round(result.pot.p90) };
    income = { p10: Math.round(result.income.p10), p50: Math.round(result.income.p50), p90: Math.round(result.income.p90) };
    notes.push(`Pension pots grow at their own expected returns after charges, with ${fmtPct(inflation)} inflation taken off to show today's money. The range is the 10th to 90th percentile.`);
    notes.push(
      baseline.available
        ? `Contributions carry on at ${Math.round(monthlyPersonal + monthlyExternal).toLocaleString('en-GB')} a month (from ${baseline.basis.kind === 'months' ? `${baseline.basis.months.length} complete month${baseline.basis.months.length > 1 ? 's' : ''}` : `${baseline.basis.days} days`} of data), rising with the contribution-growth assumption, until you retire.`
        : 'Contributions are not known yet (they need a month of data for every account), so the pots grow from today’s values with nothing more paid in: a floor, not a forecast.',
    );
    notes.push(`Income is the pots × a ${fmtPct(withdrawal.value)} sustainable withdrawal rate (${withdrawal.source === 'fallback' ? 'fallback' : withdrawal.source === 'owner' ? 'your figure' : 'researched'}), rising with inflation.`);
    if (ageOn(dob, now) >= store.profile.retirementAge) notes.push('You are at or past your retirement age in Settings; the figures are for today.');
  } else notes.push('Add your date of birth in Settings to see a retirement outlook.');

  // State Pension: your forecast if you recorded one, else the full new State Pension (fallback).
  const forecast = store.accounts
    .filter((a) => a.type === 'state_pension')
    .map((a) => store.balances(a.id).findLast((b) => b.annualIncome !== undefined))
    .find((b) => b !== undefined);
  const spDate = dob ? statePensionDate(dob) : null;
  const statePension = forecast
    ? { annual: forecast.annualIncome!, source: 'forecast' as const, basis: `Your forecast recorded on ${forecast.date} (in today's money)`, startsOn: spDate }
    : dob
      ? { annual: statePensionFullYearly(taxYearOf(now)), source: 'fallback' as const, basis: `Fallback: the full new State Pension for ${taxYearOf(now).label}. Your gov.uk forecast replaces it (it depends on your National Insurance record).`, startsOn: spDate }
      : null;
  if (statePension && retirementDate && spDate && spDate > retirementDate) {
    const gap = Math.round((diffDays(retirementDate, spDate) / 365.25) * 10) / 10;
    notes.push(`The State Pension starts on ${formatDate(spDate)}, ${gap} year${gap === 1 ? '' : 's'} after you plan to retire.`);
  }
  const dbIncome = store.accounts
    .filter((a) => a.type === 'db_pension' && a.status === 'open')
    .reduce((s, a) => s + (store.balances(a.id).findLast((b) => b.annualIncome !== undefined)?.annualIncome ?? 0), 0);
  const ty = taxYearParams(taxYearOf(now));

  const allocTotal = [...allocation.values()].reduce((s, v) => s + v, 0);
  return {
    totals: {
      value: fromMinor(totalValue),
      contributions: fromMinor(totalContrib),
      growth: fromMinor(totalValue - totalContrib),
      pensions: fromMinor(pensions),
      isas: fromMinor(isas),
      annualCharges: fromMinor(annualCharges),
    },
    accounts,
    allocation: [...allocation.entries()].map(([assetClass, v]) => ({ assetClass, value: Math.round(v * 100) / 100, share: allocTotal ? v / allocTotal : 0 })).sort((a, b) => b.value - a.value),
    retirement: {
      age: store.profile.retirementAge,
      date: retirementDate,
      potToday: fromMinor(pensions),
      monthlyPersonal: Math.round(monthlyPersonal * 100) / 100,
      monthlyExternal: Math.round(monthlyExternal * 100) / 100,
      contributionsKnown: baseline.available,
      pot,
      income,
      withdrawalRate: withdrawal,
      statePension,
      dbIncome,
      taxFreeCash: { share: ty.pensionTaxFreeShare, lumpSumAllowance: ty.lumpSumAllowance },
      pool: { mu: pool.mu, sigma: pool.sigma, fee: pool.fee },
      assumptions: assumptionsInUse(set, ['inflation', 'contribution.growth', 'withdrawal.rate']),
      notes,
    },
  };
}

function fmtPct(v: number): string {
  return `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
}
