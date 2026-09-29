// Budgets: each monthly budget against the month's spending, whether it is over or on pace to go
// over, and a starting point for one from the months you have (docs/FORMULAS.md §15).

import type { BudgetLine, BudgetsResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, addMonths, endOfMonth, formatDate, monthKey, today, type ISODate } from '../../shared/dates';
import { fromMinor } from '../../shared/money';
import type { Budget } from '../../shared/schema';
import type { Store } from '../store';
import { flows, type FlowTx } from './cashflow';
import { Coverage } from './coverage';

/** Thresholds for a budget's status (docs/FORMULAS.md §15). Analysis settings, not assumptions. */
export const BUDGET_RULES = {
  /** "Nearly spent" from this share of the budget. */
  near: 0.9,
  /** A pace is judged only once this share of a usual month's spending would be done. */
  paceFrom: 0.25,
  /** "On pace to go over" when the month is heading for this much more than the budget. */
  paceMargin: 0.1,
  /** A usual pace needs this many past complete months with spending in the category. */
  paceMonths: 2,
  /** Past months looked at, for the usual pace and the suggestion. */
  history: 12,
  /** The suggestion is the median of up to this many recent complete months. */
  suggestMonths: 6,
} as const;

/** Round a suggestion up to a tidy amount: £5 steps under £100, £10 under £1,000, else £50. */
export function tidyUp(pounds: number): number {
  const step = pounds < 100 ? 5 : pounds < 1000 ? 10 : 50;
  return Math.ceil(pounds / step) * step;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Does this spending belong to the budget: all spending, a group's categories, or one category? */
export function inBudget(budget: Pick<Budget, 'category'>, f: FlowTx, cats: CategoryIndex): boolean {
  if (f.cls !== 'spending') return false;
  if (!budget.category) return true;
  if (!f.t.category) return false;
  if (f.t.category === budget.category) return true;
  const c = cats.get(budget.category);
  return Boolean(c && !c.parent && cats.groupOf(f.t.category)?.id === budget.category);
}

const dayOf = (d: ISODate) => Number(d.slice(8, 10));
const daysIn = (month: string) => dayOf(endOfMonth(`${month}-01`));

/**
 * The share of a month's spending in the budget usually done by day `day`, from past complete
 * months with some spending there; null with fewer than BUDGET_RULES.paceMonths of them.
 */
export function usualShare(byMonth: Map<string, { day: number; minor: number }[]>, months: string[], day: number): { share: number; months: number } | null {
  const shares: number[] = [];
  for (const m of months) {
    const rows = byMonth.get(m) ?? [];
    const total = rows.reduce((s, r) => s + r.minor, 0);
    if (total <= 0) continue;
    const by = Math.min(day, daysIn(m));
    const done = rows.filter((r) => r.day <= by).reduce((s, r) => s + r.minor, 0);
    shares.push(Math.min(Math.max(done / total, 0), 1));
  }
  if (shares.length < BUDGET_RULES.paceMonths) return null;
  return { share: shares.reduce((a, b) => a + b, 0) / shares.length, months: shares.length };
}

function budgetName(budget: Pick<Budget, 'category'>, cats: CategoryIndex): { name: string; scope: BudgetLine['scope'] } {
  if (!budget.category) return { name: 'All spending', scope: 'total' };
  const c = cats.get(budget.category);
  return { name: c?.name ?? budget.category, scope: c && !c.parent ? 'group' : 'category' };
}

export function budgets(store: Store, month: string = monthKey(today()), now: ISODate = today(), coverage: Coverage = new Coverage(store)): BudgetsResponse {
  const cats = new CategoryIndex(store.categories);
  const monthStart = `${month}-01`;
  const monthEnd = endOfMonth(monthStart);
  const complete = monthEnd < now;
  const end = complete ? monthEnd : now;
  const future = monthStart > now;

  // Data for every account, from the 1st: the month is known to this day.
  const joint = future ? null : coverage.joint(monthStart, end);
  const first = joint?.intervals[0];
  const dataTo = first && first.from === monthStart ? first.to : null;

  // Past complete months: the usual pace, and what a budget might be.
  const historyFrom = addMonths(monthStart, -BUDGET_RULES.history);
  const historyTo = addDays(monthStart, -1);
  const past = coverage.joint(historyFrom, historyTo).completeMonths;
  const pastFlows = flows(store, historyFrom, historyTo).filter((f) => f.cls === 'spending');
  const monthFlows = future ? [] : flows(store, monthStart, end).filter((f) => f.cls === 'spending');

  const lineFor = (b: Budget): BudgetLine => {
    const { name, scope } = budgetName(b, cats);
    const mine = monthFlows.filter((f) => inBudget(b, f, cats));
    const spentMinor = mine.reduce((s, f) => s + f.minor, 0);
    const toDataMinor = dataTo ? mine.filter((f) => f.t.date <= dataTo).reduce((s, f) => s + f.minor, 0) : 0;
    const budgetMinor = Math.round(b.monthly * 100);
    const byMonth = new Map<string, { day: number; minor: number }[]>();
    for (const f of pastFlows) {
      if (!inBudget(b, f, cats)) continue;
      const m = monthKey(f.t.date);
      (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push({ day: dayOf(f.t.date), minor: f.minor });
    }
    // How far through a usual month's spending the data reaches.
    let expected: number | null = null;
    let paceBasis: string | null = null;
    if (complete) {
      expected = 1;
    } else if (dataTo) {
      const usual = usualShare(byMonth, past, dayOf(dataTo));
      if (usual) {
        expected = usual.share;
        paceBasis = `usually ${Math.round(usual.share * 100)}% of a month’s spending here is done by the ${ordinal(dayOf(dataTo))} (${usual.months} past months)`;
      } else {
        expected = dayOf(dataTo) / daysIn(month);
        paceBasis = `${dayOf(dataTo)} of the month’s ${daysIn(month)} days`;
      }
    }
    const projectedMinor = !complete && expected !== null && expected >= BUDGET_RULES.paceFrom ? Math.round(toDataMinor / expected) : null;
    const status: BudgetLine['status'] =
      spentMinor > budgetMinor ? 'over' : projectedMinor !== null && projectedMinor > budgetMinor * (1 + BUDGET_RULES.paceMargin) ? 'pace' : spentMinor >= budgetMinor * BUDGET_RULES.near ? 'near' : 'ok';
    const recent = past.slice(-BUDGET_RULES.suggestMonths).map((m) => (byMonth.get(m) ?? []).reduce((s, r) => s + r.minor, 0));
    const typical = median(recent);
    return {
      ...(b.category ? { category: b.category } : {}),
      name,
      scope,
      monthly: b.monthly,
      spent: fromMinor(spentMinor),
      left: fromMinor(budgetMinor - spentMinor),
      share: budgetMinor ? spentMinor / budgetMinor : 0,
      expectedShare: expected,
      projected: projectedMinor === null ? null : fromMinor(projectedMinor),
      status,
      paceBasis,
      suggested: typical > 0 ? tidyUp(typical / 100) : null,
      ...(b.notes ? { notes: b.notes } : {}),
    };
  };

  const lines = store.budgets.map(lineFor).sort((a, b) => Number(a.scope !== 'total') - Number(b.scope !== 'total') || b.monthly - a.monthly);

  // Groups you spend in with no budget yet, with what a budget might be.
  const budgeted = new Set(store.budgets.map((b) => b.category ?? '*'));
  const suggestions: BudgetsResponse['suggestions'] = [];
  if (past.length) {
    const recent = past.slice(-BUDGET_RULES.suggestMonths);
    const candidates = [{ category: undefined as string | undefined }, ...cats.list.filter((c) => !c.parent && c.kind === 'expense' && !c.hidden).map((c) => ({ category: c.id }))];
    for (const cand of candidates) {
      if (budgeted.has(cand.category ?? '*')) continue;
      const perMonth = recent.map((m) => pastFlows.filter((f) => monthKey(f.t.date) === m && inBudget(cand, f, cats)).reduce((s, f) => s + f.minor, 0));
      const typical = median(perMonth);
      if (typical <= 0) continue;
      const { name, scope } = budgetName(cand, cats);
      suggestions.push({ ...(cand.category ? { category: cand.category } : {}), name, scope, suggested: tidyUp(typical / 100), typical: fromMinor(Math.round(typical)), months: recent.length });
    }
    suggestions.sort((a, b) => Number(a.scope !== 'total') - Number(b.scope !== 'total') || b.typical - a.typical);
  }

  const note = future
    ? 'This month has not started.'
    : complete
      ? dataTo === monthEnd
        ? null
        : dataTo
          ? `Only the days to ${formatDate(dataTo)} have data for every account: spending after that may be missing.`
          : 'No day of this month has data for every account: spending here may be incomplete.'
      : !dataTo
        ? 'No day this month has data for every account yet: import this month’s statements to see where you are.'
        : null;

  return { month, complete, dataTo, lines, suggestions: suggestions.slice(0, 10), pastMonths: past.length, note };
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Budgets over, or on pace to go over, this month: for the Overview's alerts. */
export function budgetAlerts(response: BudgetsResponse): BudgetLine[] {
  return response.lines.filter((l) => l.status === 'over' || l.status === 'pace');
}

