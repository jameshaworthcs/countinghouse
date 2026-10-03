// Linked accounts (`Account.continues`, a product change under one account number): the money the
// older account ended with should be what the newer one starts from. And a closed account that
// still held money, with no account carrying it on, lost it somewhere. Formulas: docs/FORMULAS.md
// §9, "Linked and closed accounts".

import { balanceModeOf } from '../../shared/accounts';
import type { ClosedHolding, Handover } from '../../shared/api';
import { addDays } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';

/**
 * What carried over when `newer` took over from the account it continues: the older account's
 * balance at the end of its last day (the day before `from`) against the newer one's at the start of
 * `from`. Null when `newer` continues no account in your data.
 */
export function handoverOf(store: Pick<Store, 'account'>, engine: BalanceEngine, newer: Account): Handover | null {
  const link = newer.continues;
  const older = link ? store.account(link.accountId) : undefined;
  if (!link || !older) return null;
  const base = { older: { accountId: older.id, name: older.name }, newer: { accountId: newer.id, name: newer.name }, from: link.from };
  // Valued accounts move with markets between valuations: what carried over cannot be checked.
  if (balanceModeOf(older) !== 'ledger' || balanceModeOf(newer) !== 'ledger') return { ...base, closing: null, opening: null, difference: null, status: 'unknown', estimated: false, valued: true };
  const closing = engine.balanceOn(older.id, addDays(link.from, -1));
  const opening = engine.openingOn(newer.id, link.from);
  const estimated = Boolean(closing?.estimated || opening?.estimated);
  if (!closing || !opening) return { ...base, closing: closing?.value ?? null, opening: opening?.value ?? null, difference: null, status: 'unknown', estimated };
  const difference = fromMinor(toMinor(opening.value) - toMinor(closing.value));
  return { ...base, closing: closing.value, opening: opening.value, difference, status: difference === 0 ? 'adds-up' : 'unexplained', estimated };
}

/** Every link between your accounts, with what carried over. */
export function handovers(store: Store, engine: BalanceEngine): Handover[] {
  return store.accounts.flatMap((a) => {
    const h = handoverOf(store, engine, a);
    return h ? [h] : [];
  });
}

/**
 * Closed ledger accounts that still held money, or owed it, at the end of their last day, with no
 * account carrying on from them: the balances show no money leaving, so it is missing from the
 * estate from the day after (a closing payment not recorded, or a closing date too early).
 */
export function closedHolding(store: Store, engine: BalanceEngine): ClosedHolding[] {
  return store.accounts.flatMap((a) => {
    if (a.status !== 'closed' || !a.closedOn || balanceModeOf(a) !== 'ledger') return [];
    if (store.accounts.some((n) => n.continues?.accountId === a.id)) return [];
    const b = engine.balanceOn(a.id, a.closedOn);
    if (!b || toMinor(b.value) === 0) return [];
    return [{ accountId: a.id, name: a.name, closedOn: a.closedOn, balance: b.value, estimated: b.estimated }];
  });
}
