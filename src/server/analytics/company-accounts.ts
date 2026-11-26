// A company's own accounts (Account.companyId): its bank account, its card. The store keeps them out
// of everything personal (store.ts, "Scope"); this is where they are seen, each company on its own,
// with a balance engine of their own, for their account pages and their group on the Accounts page.
// Nothing here is added to any personal figure.

import type { AccountSummary, CompanyAccountsGroup } from '../../shared/api';
import { today, type ISODate } from '../../shared/dates';
import type { BalanceSnapshot, HoldingsSnapshot, Transaction } from '../../shared/schema';
import type { Store } from '../store';
import { BalanceEngine, type BalanceSource } from './balances';
import { accountSummary } from './estate';

const byDate = <T extends { date: string }>(list: T[]): T[] => [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/** The store as one company's accounts alone: what its balance engine reads. */
export function companySource(store: Store, companyId: string): BalanceSource {
  const accounts = store.companyAccounts(companyId);
  const ids = new Set(accounts.map((a) => a.id));
  return {
    accounts,
    settings: store.settings,
    transactions: (accountId?: string): Transaction[] => (accountId ? store.transactions(accountId) : store.companyTransactions(companyId)),
    balances: (accountId?: string): BalanceSnapshot[] => (accountId ? store.balances(accountId) : byDate(accounts.flatMap((a) => store.balances(a.id)))),
    holdings: (accountId?: string): HoldingsSnapshot[] => (accountId ? store.holdings(accountId) : byDate(accounts.flatMap((a) => store.holdings(a.id)))),
    instruments: store.instruments,
    research: store.research,
    figures: store.allFigures.filter((f) => f.accountId !== undefined && ids.has(f.accountId)),
    coverageConfirmations: store.allCoverageConfirmations.filter((c) => ids.has(c.accountId)),
  };
}

/** A balance engine over one company's accounts alone. */
export function companyEngine(store: Store, companyId: string): BalanceEngine {
  return new BalanceEngine(companySource(store, companyId));
}

/**
 * Each company's own accounts with their summaries, in the order of companies.json; accounts naming
 * a company not in your data come last, under that id (`known: false`).
 */
export function companyAccountGroups(store: Store, engineOf: (companyId: string) => BalanceEngine, on: ISODate = today()): CompanyAccountsGroup[] {
  const ids = [...new Set(store.allAccounts.flatMap((a) => (a.companyId ? [a.companyId] : [])))];
  const order = (id: string) => {
    const i = store.companies.findIndex((c) => c.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return ids
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((id) => {
      const company = store.company(id);
      const engine = engineOf(id);
      const accounts: AccountSummary[] = store.companyAccounts(id).map((a) => accountSummary(store, engine, a, on));
      return { company: { id, name: company?.name ?? id, known: Boolean(company) }, accounts };
    });
}
