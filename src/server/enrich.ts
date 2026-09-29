// Re-derive enrichment (payee, category, transfer links) for stored transactions from their source
// fields. Your manual edits (categorisedBy = "user") are never touched. This is what lets new rules,
// better merchant lists or new categories apply to history without re-importing anything.

import { CategoryIndex } from '../shared/categories';
import { Categoriser, transferLegCategory } from '../shared/categorise';
import { diffDays } from '../shared/dates';
import { toMinor } from '../shared/money';
import type { Account, Transaction } from '../shared/schema';
import { transferGroupId } from './ids';
import type { Store } from './store';

const TRANSFERISH = new Set(['transfer', 'credit-card-payment', 'savings-transfer', 'investment-transfer', 'contribution', 'withdrawal']);

export interface EnrichResult {
  recategorised: number;
  transfersLinked: number;
}

export async function enrich(store: Store, opts: { accountIds?: string[]; dryRun?: boolean } = {}): Promise<EnrichResult> {
  const categoriser = new Categoriser(store.rules, new CategoryIndex(store.categories), store.accounts, store.institutions);
  const scope = opts.accountIds ? new Set(opts.accountIds) : null;
  const patches = new Map<string, Partial<Transaction>>();
  let recategorised = 0;

  for (const t of store.transactions()) {
    if (scope && !scope.has(t.accountId)) continue;
    if (t.categorisedBy === 'user' || (t.transferGroup && t.categorisedBy === 'transfer')) continue;
    const res = categoriser.categorise({
      accountId: t.accountId,
      description: t.description,
      amount: t.amount,
      bankCategory: t.bankCategory,
      aiCategory: t.categorisedBy === 'ai' ? t.category : undefined,
      payee: t.merchant?.name ?? t.counterpartyName,
    });
    const patch: Partial<Transaction> = {};
    if (res.payee !== t.payee && t.payeeSetBy !== 'user') patch.payee = res.payee;
    if (res.category !== t.category) patch.category = res.category;
    if (res.categorisedBy !== t.categorisedBy) patch.categorisedBy = res.categorisedBy;
    if (res.ruleId !== t.ruleId) patch.ruleId = res.ruleId;
    if (res.counterpartyAccountId && res.counterpartyAccountId !== t.counterpartyAccountId) patch.counterpartyAccountId = res.counterpartyAccountId;
    if (res.tags?.length) {
      const tags = [...new Set([...(t.tags ?? []), ...res.tags])];
      if (tags.length !== (t.tags?.length ?? 0)) patch.tags = tags;
    }
    if (Object.keys(patch).length) {
      patches.set(t.id, patch);
      if ('category' in patch) recategorised++;
    }
  }

  // Link transfer pairs: opposite amounts within 4 days in two of your accounts, where at least one
  // side already looks like a transfer (or names the other account).
  const view = (t: Transaction): Transaction => ({ ...t, ...(patches.get(t.id) ?? {}) });
  const candidates = store
    .transactions()
    .map(view)
    .filter((t) => !t.transferGroup && (!scope || scope.has(t.accountId)));
  const byAmount = new Map<number, Transaction[]>();
  for (const t of store.transactions().map(view)) {
    if (t.transferGroup) continue;
    const k = toMinor(t.amount);
    (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(t);
  }
  const pairs = pairTransfers(store, candidates, byAmount);
  for (const [t, other, acc] of pairs.legs) {
    const patch = { ...(patches.get(t.id) ?? {}), transferGroup: pairs.groupOf.get(t.id)!, counterpartyAccountId: other.id } as Partial<Transaction>;
    if (t.categorisedBy !== 'user') {
      patch.category = transferLegCategory(acc.type, other.type, t.amount);
      patch.categorisedBy = 'transfer';
    }
    patches.set(t.id, patch);
  }
  const transfersLinked = pairs.count;

  if (!opts.dryRun && patches.size) {
    await store.updateTransactions(
      [...patches.entries()].map(([id, patch]) => ({ id, patch })),
      `enrich: ${recategorised} recategorised, ${transfersLinked} transfers linked`,
    );
  }
  return { recategorised, transfersLinked };
}

/**
 * Pair transfers: each money-out candidate with an opposite amount within 4 days in another of your
 * accounts, where at least one side already looks like a transfer (or names the other account).
 */
function pairTransfers(store: Store, candidates: Transaction[], byAmount: Map<number, Transaction[]>) {
  const linked = new Set<string>();
  const groupOf = new Map<string, string>();
  const legs: [Transaction, Account, Account][] = [];
  let count = 0;
  const outgoing = [...candidates.filter((t) => t.amount < 0), ...candidates.filter((t) => t.amount > 0).flatMap((t) => (byAmount.get(-toMinor(t.amount)) ?? []).filter((o) => o.amount < 0 && !o.transferGroup))];
  for (const a of outgoing) {
    if (linked.has(a.id)) continue;
    const pool = byAmount.get(-toMinor(a.amount)) ?? [];
    let best: { t: Transaction; days: number } | undefined;
    for (const b of pool) {
      if (b.accountId === a.accountId || linked.has(b.id) || b.transferGroup) continue;
      const days = Math.abs(diffDays(a.date, b.date));
      if (days > 4) continue;
      const hinted = (a.category && TRANSFERISH.has(a.category)) || (b.category && TRANSFERISH.has(b.category)) || a.counterpartyAccountId === b.accountId || b.counterpartyAccountId === a.accountId;
      if (!hinted) continue;
      if (!best || days < best.days) best = { t: b, days };
    }
    if (!best) continue;
    const b = best.t;
    const accA = store.account(a.accountId);
    const accB = store.account(b.accountId);
    if (!accA || !accB) continue;
    const group = transferGroupId(a.id, b.id);
    groupOf.set(a.id, group);
    groupOf.set(b.id, group);
    legs.push([a, accB, accA], [b, accA, accB]);
    linked.add(a.id);
    linked.add(b.id);
    count++;
  }
  return { legs, groupOf, count };
}

/**
 * Link the transfers a commit's new rows complete: the other leg may have been committed earlier,
 * from another account's statement. Only unlinked rows are touched, and a category you set stays.
 */
export async function linkTransfers(store: Store, ids: string[], message: string): Promise<number> {
  if (!ids.length) return 0;
  const want = new Set(ids);
  const all = store.transactions().filter((t) => !t.transferGroup);
  const byAmount = new Map<number, Transaction[]>();
  for (const t of all) (byAmount.get(toMinor(t.amount)) ?? byAmount.set(toMinor(t.amount), []).get(toMinor(t.amount))!).push(t);
  const pairs = pairTransfers(store, all.filter((t) => want.has(t.id)), byAmount);
  if (!pairs.count) return 0;
  await store.updateTransactions(
    pairs.legs.map(([t, other, acc]) => ({
      id: t.id,
      patch: {
        transferGroup: pairs.groupOf.get(t.id)!,
        counterpartyAccountId: other.id,
        ...(t.categorisedBy !== 'user' ? { category: transferLegCategory(acc.type, other.type, t.amount), categorisedBy: 'transfer' as const } : {}),
      },
    })),
    message,
  );
  return pairs.count;
}
