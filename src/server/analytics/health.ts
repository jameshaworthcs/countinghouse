// Data health: validation problems, statement gaps, uncategorised spending, accounts with no known
// balance, stale accounts and FSCS exposure.

import { balanceModeOf, staleAfterDays } from '../../shared/accounts';
import type { DataHealthResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, diffDays, today } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import { fscsDepositLimit } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { classifyFlow } from './cashflow';

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
    if (balanceModeOf(a) === 'ledger' && info && info.anchors === 0 && store.transactions(a.id).length > 0) noBalance.push({ accountId: a.id, name: a.name });
    const last = engine.lastDataDate(a.id);
    if (a.status === 'open' && last && diffDays(last, now) > staleAfterDays(a.type, store.settings.staleAfterDays)) stale.push({ accountId: a.id, name: a.name, days: diffDays(last, now) });
  }
  const since = addDays(now, -365);
  const uncategorised = store
    .transactions()
    .filter((t) => t.date >= since && !t.category && classifyFlow(t, cats, accounts.get(t.accountId)) !== 'excluded').length;
  return { issues: store.issues, gaps, uncategorised, noBalance, stale, fscs: fscsExposure(store, engine) };
}
