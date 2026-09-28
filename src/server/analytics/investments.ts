// Investments, ISAs and pensions: value, contributions, growth, money-weighted return, holdings,
// LISA specifics and a simple retirement projection.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { InvestmentAccountSummary, InvestmentsResponse } from '../../shared/api';
import { EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { addMonths, diffDays, today } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import { ageOn, birthdayAt, lisaPenaltyAdjustedValue, pensionAccessDate, taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';

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
  if (a.type === 'property' || a.type === 'other_asset' || a.type === 'state_pension') return false;
  return balanceModeOf(a) === 'market' || Boolean(meta.isa) || Boolean(meta.pension);
}

export function investments(store: Store, engine: BalanceEngine): InvestmentsResponse {
  const now = today();
  const dob = store.profile.dateOfBirth;
  const r = store.profile.assumedRealReturn;
  const accounts: InvestmentAccountSummary[] = [];
  const allocation = new Map<string, number>();
  let totalValue = 0;
  let totalContrib = 0;
  let pensions = 0;
  let isas = 0;
  let pensionMonthly = 0;

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
    // LISA: providers usually report your contributions and the government bonus separately; the
    // bonus is not investment growth.
    const bonusSeparate = a.type === 'lisa' && contributionsSource === 'provider' && lastSnap?.bonusToDate !== undefined ? lastSnap.bonusToDate : 0;
    const invested = contributions !== null ? contributions + bonusSeparate : null;
    const growth = value !== null && invested !== null ? Math.round((value - invested) * 100) / 100 : null;
    // Money-weighted return over the period we have valuations for: start with the first recorded
    // value as if invested then, add later external flows, end with today's value.
    const firstSnap = snaps[0];
    const cashFlows = firstSnap
      ? [{ date: firstSnap.date, amount: -firstSnap.balance }, ...flowsTx.filter((t) => t.date > firstSnap.date).map((t) => ({ date: t.date, amount: -t.amount }))]
      : [];
    const irr = value !== null && firstSnap && firstSnap.balance > 0 ? xirr([...cashFlows, { date: now, amount: value }]) : null;

    let cumulative = 0;
    const flowIdx = [...flowsTx];
    const history = snaps.map((s) => {
      while (flowIdx.length && flowIdx[0]!.date <= s.date) cumulative += toMinor(flowIdx.shift()!.amount);
      return {
        date: s.date,
        value: s.balance,
        contributions: s.contributions ?? (flowsTx.length ? fromMinor(cumulative) : null),
      };
    });
    const holdingsList = store.holdings(a.id);
    const holdings = holdingsList[holdingsList.length - 1] ?? null;
    if (holdings) {
      for (const h of holdings.holdings) allocation.set(h.assetClass ?? 'unclassified', (allocation.get(h.assetClass ?? 'unclassified') ?? 0) + toMinor(h.value));
      if (holdings.cash) allocation.set('cash', (allocation.get('cash') ?? 0) + toMinor(holdings.cash));
    }

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
    };
    if (a.type === 'lisa') {
      const bonusTx = store.transactions(a.id).filter((t) => t.category === 'government-bonus');
      summary.lisa = {
        bonusToDate: lastSnap?.bonusToDate ?? (bonusTx.length ? fromMinor(bonusTx.reduce((s, t) => s + toMinor(t.amount), 0)) : null),
        penaltyAdjustedValue: value !== null ? lisaPenaltyAdjustedValue(value, taxYearOf(now)) : null,
        penaltyFreeFrom: dob ? birthdayAt(dob, 60) : null,
      };
    }
    if (meta.pension) {
      const lastYear = flowsTx.filter((t) => t.date > addMonths(now, -12) && t.amount > 0);
      const monthly = lastYear.reduce((s, t) => s + toMinor(t.amount), 0) / 12;
      pensionMonthly += monthly;
      let projected: number | null = null;
      if (dob && value !== null) {
        const years = Math.max(0, store.profile.retirementAge - ageOn(dob, now));
        const g = Math.pow(1 + r, years);
        const annual = (monthly * 12) / 100;
        projected = Math.round((value * g + (r ? (annual * (g - 1)) / r : annual * years)) * 100) / 100;
      }
      summary.pension = { accessDate: dob ? pensionAccessDate(dob) : null, projectedAtRetirement: projected };
    }
    accounts.push(summary);
    if (value !== null && a.includeInNetWorth) {
      totalValue += toMinor(value);
      if (meta.pension) pensions += toMinor(value);
      if (meta.isa) isas += toMinor(value);
    }
    if (contributions !== null && a.includeInNetWorth) totalContrib += toMinor(contributions);
  }

  const allocTotal = [...allocation.values()].reduce((s, v) => s + v, 0);
  const statePension = store.accounts
    .filter((a) => a.type === 'state_pension')
    .map((a) => store.balances(a.id).at(-1)?.annualIncome)
    .find((v) => v !== undefined);
  const notes: string[] = [];
  let projectedPot: number | null = null;
  let retirementDate: string | null = null;
  if (dob) {
    retirementDate = birthdayAt(dob, store.profile.retirementAge);
    const years = Math.max(0, store.profile.retirementAge - ageOn(dob, now));
    const g = Math.pow(1 + r, years);
    const annual = (pensionMonthly * 12) / 100;
    projectedPot = Math.round((fromMinor(pensions) * g + (r ? (annual * (g - 1)) / r : annual * years)) * 100) / 100;
    notes.push(`Assumes ${(r * 100).toFixed(1)}% a year above inflation and your last 12 months of contributions continuing, in today's money.`);
    notes.push('Income uses a 4% sustainable withdrawal rate; 25% of the pot can usually be taken tax-free (up to the £268,275 lump sum allowance).');
  } else {
    notes.push('Add your date of birth in Settings to see a retirement projection.');
  }
  return {
    totals: {
      value: fromMinor(totalValue),
      contributions: fromMinor(totalContrib),
      growth: fromMinor(totalValue - totalContrib),
      pensions: fromMinor(pensions),
      isas: fromMinor(isas),
    },
    accounts,
    allocation: [...allocation.entries()]
      .map(([assetClass, v]) => ({ assetClass, value: fromMinor(v), share: allocTotal ? v / allocTotal : 0 }))
      .sort((a, b) => b.value - a.value),
    retirement: {
      age: store.profile.retirementAge,
      date: retirementDate,
      potToday: fromMinor(pensions),
      monthlyContribution: fromMinor(Math.round(pensionMonthly)),
      projectedPot,
      projectedIncome: projectedPot !== null ? Math.round(projectedPot * 0.04) : null,
      statePension: statePension ?? null,
      assumedRealReturn: r,
      notes,
    },
  };
}
