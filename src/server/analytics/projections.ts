// Projections: where your estate value goes if a chosen period's income and spending continued.
//
// Monthly simulation from today's balances:
//   liquid    += income − spending − money moved into investments/pensions
//   invested   = invested × (1 + r) + money moved in           (ISAs, LISA, GIA, crypto)
//   pensions   = pensions × (1 + r) + contributions             (incl. employer + relief)
//   property and other debts are held flat.
// r is the assumed real (after-inflation) return from your profile, so results are in today's money.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { ProjectionResponse, ProjectionScenario } from '../../shared/api';
import { CategoryIndex, EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { addMonths, eachMonth, endOfMonth, startOfMonth, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { flows } from './cashflow';
import { estateSeries, firstDataDate } from './estate';

export interface ProjectionOptions {
  months?: number;
  /** e.g. -0.1 to model spending 10% less. */
  spendingAdjustment?: number;
  /** Optional custom baseline period. */
  pastFrom?: ISODate;
  pastTo?: ISODate;
}

interface Baseline {
  income: number;
  spending: number;
  investing: number;
  pensionInflow: number;
  monthsWithData: number;
}

function baseline(store: Store, from: ISODate, to: ISODate): Baseline {
  const months = eachMonth(from, to).length;
  const list = flows(store, from, to);
  const income = list.filter((f) => f.cls === 'income').reduce((s, f) => s + f.minor, 0);
  const spending = list.filter((f) => f.cls === 'spending').reduce((s, f) => s + f.minor, 0);
  const monthsWithData = new Set(list.map((f) => f.t.date.slice(0, 7))).size;
  // Money leaving ledger accounts for investments/pensions.
  let investing = 0;
  let pensionInflow = 0;
  for (const t of store.transactions()) {
    if (t.date < from || t.date > to) continue;
    const account = store.account(t.accountId);
    if (!account) continue;
    const meta = ACCOUNT_TYPE_META[account.type];
    if (balanceModeOf(account) === 'ledger' && t.amount < 0 && t.category === 'investment-transfer') investing += -toMinor(t.amount);
    // Pension inflows that did not come from your own cash (employer, salary sacrifice, relief).
    if (meta.pension && t.amount > 0 && t.category && EXTERNAL_FLOW_CATEGORIES.has(t.category) && !t.transferGroup) pensionInflow += toMinor(t.amount);
  }
  const m = Math.max(1, months);
  return {
    income: Math.round(income / m),
    spending: Math.round(spending / m),
    investing: Math.round(investing / m),
    pensionInflow: Math.round(pensionInflow / m),
    monthsWithData,
  };
}

export function projections(store: Store, engine: BalanceEngine, opts: ProjectionOptions = {}): ProjectionResponse {
  const start = today();
  const months = Math.min(Math.max(opts.months ?? 60, 6), 480);
  const adj = opts.spendingAdjustment ?? 0;
  const r = store.profile.assumedRealReturn;
  const rm = Math.pow(1 + r, 1 / 12) - 1;
  const notes: string[] = [];

  // Current position, by bucket.
  let liquid = 0;
  let invested = 0;
  let pensions = 0;
  let property = 0;
  let debts = 0;
  for (const a of store.accounts.filter((x) => x.includeInNetWorth)) {
    const p = engine.balanceOn(a.id, start);
    if (!p || p.gbp === null) continue;
    const minor = toMinor(p.gbp);
    const meta = ACCOUNT_TYPE_META[a.type];
    if (meta.pension) pensions += minor;
    else if (a.type === 'property' || a.type === 'other_asset') property += minor;
    else if (meta.liability && a.type !== 'credit_card') debts += minor;
    else if (balanceModeOf(a) === 'market') invested += minor;
    else liquid += minor;
  }

  const lastFullMonthEnd = endOfMonth(addMonths(start, -1));
  const defs: { id: string; label: string; from: ISODate; to: ISODate }[] = [
    { id: 'recent', label: 'If the last 3 months continued', from: startOfMonth(addMonths(lastFullMonthEnd, -2)), to: lastFullMonthEnd },
    { id: 'year', label: 'If the last 12 months continued', from: startOfMonth(addMonths(lastFullMonthEnd, -11)), to: lastFullMonthEnd },
  ];
  if (opts.pastFrom && opts.pastTo && opts.pastFrom < opts.pastTo) {
    defs.push({ id: 'past', label: `If ${opts.pastFrom.slice(0, 7)} to ${opts.pastTo.slice(0, 7)} repeated`, from: opts.pastFrom, to: opts.pastTo });
  }

  const scenarios: ProjectionScenario[] = [];
  const series: ProjectionResponse['series'] = [];
  for (const def of defs) {
    const b = baseline(store, def.from, def.to);
    const needed = Math.min(eachMonth(def.from, def.to).length, 3);
    const available = b.monthsWithData >= needed && b.income + b.spending > 0;
    const spendingAdj = Math.round(b.spending * (1 + adj));
    const scenario: ProjectionScenario = {
      id: def.id,
      label: def.label,
      from: def.from,
      to: def.to,
      available,
      monthly: {
        income: fromMinor(b.income),
        spending: fromMinor(spendingAdj),
        net: fromMinor(b.income - spendingAdj),
        investing: fromMinor(b.investing),
        pensionInflow: fromMinor(b.pensionInflow),
      },
      ...(available ? {} : { reason: `Needs at least ${needed} months of transactions in ${def.from.slice(0, 7)} – ${def.to.slice(0, 7)}` }),
    };
    scenarios.push(scenario);
    if (!available) continue;
    let l = liquid;
    let inv = invested;
    let pen = pensions;
    const points: { date: string; value: number; liquid: number }[] = [{ date: start, value: fromMinor(l + inv + pen + property + debts), liquid: fromMinor(l) }];
    for (let i = 1; i <= months; i++) {
      l += b.income - spendingAdj - b.investing;
      inv = Math.round(inv * (1 + rm)) + b.investing;
      pen = Math.round(pen * (1 + rm)) + b.pensionInflow;
      if (i % (months > 120 ? 3 : 1) === 0 || i === months) {
        points.push({ date: endOfMonth(addMonths(start, i)), value: fromMinor(l + inv + pen + property + debts), liquid: fromMinor(l) });
      }
    }
    series.push({ id: def.id, label: def.label, points });
  }

  // History for context: last 24 months (or since data starts).
  const first = firstDataDate(store, engine);
  const historyFrom = first && first > addMonths(start, -24) ? first : addMonths(start, -24);
  const hist = first ? estateSeries(store, engine, historyFrom, start, 'wrapper') : null;
  const history = hist ? hist.dates.map((d, i) => ({ date: d, value: hist.total[i]! })) : [];

  // Categories: annualised spend at the recent pace vs the last 12 months.
  const cats = new CategoryIndex(store.categories);
  const recentFlows = flows(store, defs[0]!.from, defs[0]!.to).filter((f) => f.cls === 'spending');
  const yearFlows = flows(store, defs[1]!.from, defs[1]!.to).filter((f) => f.cls === 'spending');
  const sumBy = (list: typeof recentFlows) => {
    const m = new Map<string, number>();
    for (const f of list) {
      const g = f.t.category ? (cats.groupOf(f.t.category)?.id ?? f.t.category) : 'uncategorised';
      m.set(g, (m.get(g) ?? 0) + f.minor);
    }
    return m;
  };
  const recentBy = sumBy(recentFlows);
  const yearBy = sumBy(yearFlows);
  const ids = new Set([...recentBy.keys(), ...yearBy.keys()]);
  const categories = [...ids]
    .map((id) => ({
      id,
      name: id === 'uncategorised' ? 'Uncategorised' : cats.name(id),
      recentAnnual: fromMinor(Math.round(((recentBy.get(id) ?? 0) / 3) * 12)),
      lastYear: fromMinor(yearBy.get(id) ?? 0),
    }))
    .filter((c) => c.recentAnnual > 0 || c.lastYear > 0)
    .sort((a, b) => Math.max(b.recentAnnual, b.lastYear) - Math.max(a.recentAnnual, a.lastYear));

  const recent = scenarios.find((s) => s.id === 'recent');
  const monthlySpend = recent?.available ? toMinor(recent.monthly.spending) : 0;
  const runwayMonths = monthlySpend > 0 ? Math.round((liquid / monthlySpend) * 10) / 10 : null;

  notes.push(`Investments and pensions grow at ${(r * 100).toFixed(1)}% a year after inflation (change it in Settings → Profile). Cash does not grow.`);
  notes.push('Property and loans are held flat; credit-card balances are treated as cash that gets repaid.');
  if (adj) notes.push(`Spending adjusted by ${adj > 0 ? '+' : ''}${Math.round(adj * 100)}% in every scenario.`);
  if (!scenarios.some((s) => s.available)) notes.push('Import a few months of bank statements to unlock projections.');

  return {
    startDate: start,
    months,
    assumedRealReturn: r,
    spendingAdjustment: adj,
    start: {
      liquid: fromMinor(liquid),
      invested: fromMinor(invested),
      pensions: fromMinor(pensions),
      property: fromMinor(property),
      debts: fromMinor(debts),
      total: fromMinor(liquid + invested + pensions + property + debts),
    },
    scenarios,
    history,
    series,
    categories: categories.slice(0, 16),
    runwayMonths,
    notes,
  };
}

