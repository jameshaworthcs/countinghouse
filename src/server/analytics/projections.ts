// Projections: where your estate value heads if a past period's income, spending and saving carried
// on, with each account growing at its own researched or assumed rate, net of its charges, and a
// range rather than a single line. The equations are in docs/FORMULAS.md §5; parameters and their
// sources come from params.ts, baselines from baseline.ts.

import { assumptionDef, type AssumptionSet } from '../../shared/assumptions';
import type { AccountParamsSummary, AssumptionInUse, ProjectionPoint, ProjectionResponse, ProjectionScenario } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addMonths, formatMonth, today, type ISODate } from '../../shared/dates';
import { birthdayAt } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { computeBaseline, DAYS_PER_MONTH, standardPeriods, type Baseline } from './baseline';
import { Coverage } from './coverage';
import { estateSeries, firstDataDate } from './estate';
import { simulate, medianGrowth, type SimAccount } from './model';
import { accountParams, makeResolver, poolStats, type AccountParams } from './params';

export interface ProjectionOptions {
  months?: number;
  /** e.g. -0.1 to model spending 10% less. */
  spendingAdjustment?: number;
  /** Optional custom baseline period. */
  pastFrom?: ISODate;
  pastTo?: ISODate;
  /** Today's money (default) or future pounds. */
  units?: 'real' | 'nominal';
}

/** The global assumptions a projection reads, with their sources. */
export function assumptionsInUse(set: AssumptionSet, keys: string[]): AssumptionInUse[] {
  return keys.map((key) => {
    const def = assumptionDef(key)!;
    const r = set.resolve(key);
    return {
      key,
      label: def.label,
      unit: def.unit,
      value: r.value,
      range: r.range,
      source: r.source,
      basis: r.source === 'fallback' ? `Fallback: ${r.note ?? ''}` : `${r.source === 'owner' ? 'Yours' : 'Agent'}: ${r.record?.source ?? ''}`,
      recordId: r.record?.id,
      asOf: r.record?.asOf,
      stale: r.stale,
    };
  });
}

export function summariseParams(p: AccountParams): AccountParamsSummary {
  const invest = p.bucket === 'market' || p.bucket === 'pension';
  const charges = invest ? p.value * (p.fundFee.value + p.platformFee.value) + p.platformFixed.value : undefined;
  return {
    id: p.accountId,
    name: p.name,
    type: p.type,
    bucket: p.bucket,
    value: p.value,
    holdingsKnown: p.holdingsKnown,
    holdingsAsOf: p.holdingsAsOf,
    holdings: p.holdings.map((h) => ({ name: h.name, instrumentId: h.instrumentId, value: h.value, exposureBasis: h.exposureBasis, expectedReturn: h.expectedReturn, volatility: h.volatility, fundFee: h.fundFee })),
    expectedReturn: p.expectedReturn,
    volatility: p.volatility,
    fundFee: p.fundFee,
    platformFee: p.platformFee,
    platformFixed: p.platformFixed,
    ...(p.interest ? { interest: p.interest } : {}),
    ...(p.growth ? { growth: p.growth } : {}),
    ...(invest ? { netGrowth: (1 + medianGrowth(p.expectedReturn.value, p.volatility.value)) * (1 - p.fundFee.value - p.platformFee.value) - 1, annualCharges: Math.round((charges ?? 0) * 100) / 100 } : {}),
  };
}

export function summariseBaseline(store: Store, b: Baseline): Omit<ProjectionScenario, 'id' | 'label'> {
  return {
    from: b.from,
    to: b.to,
    available: b.available,
    ...(b.reason ? { reason: b.reason } : {}),
    confidence: b.confidence,
    basis: b.basis,
    monthly: {
      ...b.monthly,
      investing: Math.round((b.wrappers.reduce((s, w) => s + w.personal, 0) + b.unassignedInvesting) * 100) / 100,
      external: Math.round(b.wrappers.reduce((s, w) => s + w.external, 0) * 100) / 100,
    },
    netSd: b.netSd,
    netSdBasis: b.netSdBasis,
    wrappers: b.wrappers.map((w) => ({ ...w, name: store.account(w.accountId)?.name ?? w.accountId })),
  };
}

const GLOBAL_KEYS = ['inflation', 'salary.growth', 'spending.growth', 'contribution.growth', 'correlation.assetClasses', 'cashflow.uncertainty'];

export function projections(store: Store, engine: BalanceEngine, opts: ProjectionOptions = {}): ProjectionResponse {
  const start = today();
  const months = Math.min(Math.max(opts.months ?? 60, 6), 480);
  const adj = opts.spendingAdjustment ?? 0;
  const units = opts.units ?? 'real';
  const resolver = makeResolver(store, start);
  const { set } = resolver;
  const coverage = new Coverage(store);
  const notes: string[] = [];

  const included = store.accounts.filter((a) => a.includeInNetWorth && a.status === 'open');
  const params = included.map((a) => accountParams(store, engine, resolver, a, start));
  const invest = params.filter((p) => p.bucket === 'market' || p.bucket === 'pension');
  const pool = poolStats(invest, resolver.rho);
  const sum = (bucket: AccountParams['bucket']) => params.filter((p) => p.bucket === bucket).reduce((s, p) => s + p.value, 0);
  const startPos = { cash: sum('cash'), market: sum('market'), pension: sum('pension'), property: sum('property'), debt: sum('debt') };

  const g = (key: string) => set.resolve(key).value;
  const inflation = g('inflation');
  const defs: { id: string; label: string; from: ISODate; to: ISODate }[] = standardPeriods(start, coverage);
  if (opts.pastFrom && opts.pastTo && opts.pastFrom < opts.pastTo) {
    defs.push({ id: 'past', label: `If ${formatMonth(opts.pastFrom)} to ${formatMonth(opts.pastTo)} repeated`, from: opts.pastFrom, to: opts.pastTo });
  }

  const scenarios: ProjectionScenario[] = [];
  const series: ProjectionResponse['series'] = [];
  const baselines = new Map<string, Baseline>();
  for (const def of defs) {
    const b = computeBaseline(store, coverage, def.from, def.to, set);
    baselines.set(def.id, b);
    scenarios.push({ id: def.id, label: def.label, ...summariseBaseline(store, b) });
    if (!b.available) continue;
    const flowsFor = new Map(b.wrappers.map((w) => [w.accountId, w]));
    const accounts: SimAccount[] = params
      .filter((p) => p.bucket !== 'income')
      .map((p) => ({
        id: p.accountId,
        bucket: p.bucket as SimAccount['bucket'],
        value: p.value,
        ...(p.bucket === 'market' || p.bucket === 'pension'
          ? { mu: p.expectedReturn.value, sigma: p.volatility.value, fee: p.fundFee.value + p.platformFee.value, fixedFee: p.platformFixed.value, contribution: flowsFor.get(p.accountId)?.personal ?? 0, external: flowsFor.get(p.accountId)?.external ?? 0 }
          : {}),
        ...(p.interest ? { interest: p.interest.value } : {}),
        ...(p.growth ? { growth: p.growth.value } : {}),
      }));
    const points = simulate({
      start,
      months,
      accounts,
      income: b.monthly.income,
      spending: b.monthly.spending * (1 + adj),
      unassignedInvesting: b.unassignedInvesting,
      netUncertainty: b.netSd,
      inflation,
      salaryGrowth: g('salary.growth'),
      spendingGrowth: g('spending.growth'),
      contributionGrowth: g('contribution.growth'),
      pool,
    });
    const step = months > 120 ? 3 : 1;
    const out: ProjectionPoint[] = points
      .filter((p) => p.month % step === 0 || p.month === months)
      .map((p) => {
        const k = units === 'real' ? 1 / p.deflator : 1;
        const r = (v: number) => Math.round(v * k);
        return { date: p.date, month: p.month, cash: r(p.cash), market: r(p.market), pension: r(p.pension), property: r(p.property), debt: r(p.debt), total: r(p.total), band: { p10: r(p.band.p10), p50: r(p.band.p50), p90: r(p.band.p90) } };
      });
    series.push({ id: def.id, label: def.label, points: out });
  }

  // History for context: the last 24 months (or since data starts).
  const first = firstDataDate(store, engine);
  const historyFrom = first && first > addMonths(start, -24) ? first : addMonths(start, -24);
  const hist = first ? estateSeries(store, engine, historyFrom, start, 'wrapper') : null;
  const history = hist ? hist.dates.map((d, i) => ({ date: d, value: hist.total[i]! })) : [];

  // Spending by group: annualised at the recent pace against the last 12 months, both from covered time.
  const cats = new CategoryIndex(store.categories);
  const recentB = baselines.get('recent')!;
  const yearB = baselines.get('year')!;
  const perYear = (b: Baseline) => {
    const m = new Map<string, number>();
    if (!b.available) return m;
    const monthsCovered = b.basis.kind === 'months' ? b.basis.months.length : b.basis.days / DAYS_PER_MONTH;
    for (const f of b.flows) {
      if (f.cls !== 'spending') continue;
      const gid = f.t.category ? (cats.groupOf(f.t.category)?.id ?? f.t.category) : 'uncategorised';
      m.set(gid, (m.get(gid) ?? 0) + f.minor / 100);
    }
    for (const [k, v] of m) m.set(k, Math.round((v / monthsCovered) * 12));
    return m;
  };
  const recentBy = perYear(recentB);
  const yearBy = perYear(yearB);
  const categories = [...new Set([...recentBy.keys(), ...yearBy.keys()])]
    .map((id) => ({ id, name: id === 'uncategorised' ? 'Uncategorised' : cats.name(id), recentAnnual: recentBy.get(id) ?? 0, lastYear: yearBy.get(id) ?? 0 }))
    .filter((c) => c.recentAnnual > 0 || c.lastYear > 0)
    .sort((a, b) => Math.max(b.recentAnnual, b.lastYear) - Math.max(a.recentAnnual, a.lastYear));

  const runwayBase = recentB.available ? recentB : yearB.available ? yearB : null;
  const runwayMonths = runwayBase && runwayBase.monthly.spending > 0 ? Math.round((startPos.cash / runwayBase.monthly.spending) * 10) / 10 : null;

  const dob = store.profile.dateOfBirth;
  const retirementDate = dob ? birthdayAt(dob, store.profile.retirementAge) : null;
  const retirement = retirementDate && retirementDate <= addMonths(start, months) ? { date: retirementDate, age: store.profile.retirementAge } : null;

  const fallbacks = [...invest.flatMap((p) => [p.expectedReturn, p.fundFee, p.platformFee]), ...params.flatMap((p) => (p.interest ? [p.interest] : []))].filter((s) => s.source === 'fallback').length;
  notes.push(units === 'real' ? `In today's money: future pounds are divided by ${(inflation * 100).toFixed(1)}% a year of inflation.` : 'In future pounds: not adjusted for inflation.');
  notes.push('Each account grows at its own expected return, at the median (what a typical path compounds at), after its fund and platform charges. Cash earns its interest rate.');
  notes.push('The shaded range covers 80% of outcomes (10th to 90th percentile): market swings, uncertainty in the expected returns themselves, and how well the months of data pin down your saving.');
  if (fallbacks) notes.push(`${fallbacks} value${fallbacks > 1 ? 's use' : ' uses'} a fallback rather than research or your own figure; see "What this assumes" below.`);
  notes.push('Property grows at its assumed rate; loans and mortgages are held flat (repayments stay in spending).');
  if (retirement) notes.push(`Your retirement (${retirement.date}) falls within this horizon; the scenarios assume today's pattern carries on regardless.`);
  if (adj) notes.push(`Spending adjusted by ${adj > 0 ? '+' : ''}${Math.round(adj * 100)}% in every scenario.`);
  if (!scenarios.some((s) => s.available)) notes.push('Import a month of statements for every account to unlock projections.');

  return {
    startDate: start,
    months,
    units,
    spendingAdjustment: adj,
    start: { ...startPos, total: startPos.cash + startPos.market + startPos.pension + startPos.property + startPos.debt },
    scenarios,
    history,
    series,
    assumptions: assumptionsInUse(set, GLOBAL_KEYS),
    accounts: params.filter((p) => p.bucket !== 'income').map(summariseParams),
    pool: { value: pool.value, mu: pool.mu, ...(pool.muRange ? { muRange: pool.muRange } : {}), sigma: pool.sigma, fee: pool.fee },
    categories: categories.slice(0, 16),
    runwayMonths,
    retirement,
    notes,
  };
}
