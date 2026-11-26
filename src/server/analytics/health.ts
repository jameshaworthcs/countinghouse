// Data health: validation problems, statement gaps, uncategorised spending, accounts with no known
// balance, stale accounts and FSCS exposure.

import { balanceModeOf, staleAfterDays } from '../../shared/accounts';
import type { DataHealthResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, diffDays, today } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import { fscsDepositLimit } from '../../shared/uk';
import type { Store } from '../store';
import { lastUpdated, type BalanceEngine } from './balances';
import { companyMarkProblem, markCounts } from '../../shared/company';
import { classifyFlow } from './cashflow';
import { directorLoanMovements, directorLoanWarnings, loanDays, owedLots, owedMostInTaxYear } from './director-loan';

const DEPOSIT_TYPES = new Set(['current', 'savings', 'cash_isa']);

/** Share of the FSCS limit at which a banking licence's total is flagged as close to it. */
export const FSCS_WARN_SHARE = 0.8;

export function fscsExposure(store: Store, engine: BalanceEngine): DataHealthResponse['fscs'] {
  const now = today();
  const limit = fscsDepositLimit(now);
  const groups = new Map<string, { total: number; institutions: Set<string> }>();
  for (const a of store.accounts) {
    if (a.status !== 'open' || !DEPOSIT_TYPES.has(a.type) || !a.institutionId || a.institutionId === 'ns-and-i') continue;
    const inst = store.institution(a.institutionId);
    const group = inst?.fscsGroup ?? a.institutionId;
    const bal = engine.balanceOn(a.id, now)?.gbp;
    if (!bal || bal <= 0) continue;
    const g = groups.get(group) ?? { total: 0, institutions: new Set<string>() };
    g.total += toMinor(bal);
    g.institutions.add(inst?.name ?? a.institutionId);
    groups.set(group, g);
  }
  return [...groups.entries()]
    .map(([group, g]) => ({ group, institutions: [...g.institutions], total: fromMinor(g.total), limit, over: fromMinor(g.total) > limit, near: fromMinor(g.total) >= limit * FSCS_WARN_SHARE }))
    .sort((a, b) => b.total - a.total);
}

export function dataHealth(store: Store, engine: BalanceEngine): DataHealthResponse {
  const now = today();
  const cats = new CategoryIndex(store.categories);
  const accounts = new Map(store.accounts.map((a) => [a.id, a]));
  const gaps: DataHealthResponse['gaps'] = [];
  const noBalance: DataHealthResponse['noBalance'] = [];
  const stale: DataHealthResponse['stale'] = [];
  for (const a of store.accounts) {
    for (const g of engine.gaps(a.id)) gaps.push({ accountId: a.id, name: a.name, ...g });
    const info = engine.info(a.id);
    // Rows and no balance to anchor them (a director's loan's rows are its movements: info, not the store).
    if (balanceModeOf(a) === 'ledger' && info && info.anchors === 0 && info.lastTransaction !== null) noBalance.push({ accountId: a.id, name: a.name });
    const last = lastUpdated(store, engine, a.id);
    if (a.status === 'open' && last && diffDays(last, now) > staleAfterDays(a.type, store.settings.staleAfterDays)) stale.push({ accountId: a.id, name: a.name, days: diffDays(last, now) });
  }
  const since = addDays(now, -365);
  const uncategorised = store
    .transactions()
    .filter((t) => t.date >= since && !t.category && classifyFlow(t, cats, accounts.get(t.accountId), store) !== 'excluded').length;
  const directorLoans = directorLoanChecks(store, engine, now);
  const marks = marksThatDoNotCount(store);
  return { issues: store.issues, gaps, uncategorised, noBalance, stale, fscs: fscsExposure(store, engine), ...(directorLoans.length ? { directorLoans } : {}), ...(marks.length ? { marksThatDoNotCount: marks } : {}) };
}

/**
 * Payments whose mark of money with a company no longer fits (a hand edit, a company taken away): the
 * mark counts for nothing (`markCounts`), so each is an ordinary row of yours until you change it.
 */
export function marksThatDoNotCount(store: Store): NonNullable<DataHealthResponse['marksThatDoNotCount']> {
  const out: NonNullable<DataHealthResponse['marksThatDoNotCount']> = [];
  for (const t of store.transactions()) {
    if (!t.company || markCounts(t, store)) continue;
    const account = store.account(t.accountId);
    const problem = companyMarkProblem(t, t.company, { account, company: store.company(t.company.id), companyName: (id) => store.company(id)?.name }) ?? '';
    out.push({ transactionId: t.id, accountId: t.accountId, name: account?.name ?? t.accountId, date: t.date, amount: t.amount, description: t.description, problem });
  }
  return out;
}

/** Each director's loan a company names whose warnings say something today (director-loan.ts). */
export function directorLoanChecks(store: Store, engine: BalanceEngine, on: string): NonNullable<DataHealthResponse['directorLoans']> {
  const out: NonNullable<DataHealthResponse['directorLoans']> = [];
  for (const c of store.companies) {
    const a = c.directorLoanAccountId ? store.accounts.find((x) => x.id === c.directorLoanAccountId) : undefined;
    if (!a || a.status !== 'open') continue;
    const balance = engine.balanceOn(a.id, on)?.value ?? null;
    const lots = balance !== null && balance < 0 ? owedLots(engine, a.id, loanDays(store, a.id, directorLoanMovements(store, c.id)), on) : [];
    const warnings = directorLoanWarnings(c.name, balance, owedMostInTaxYear(engine, a.id, on), on, lots);
    if (warnings.length) out.push({ accountId: a.id, name: a.name, companyName: c.name, balance, warnings });
  }
  return out;
}
