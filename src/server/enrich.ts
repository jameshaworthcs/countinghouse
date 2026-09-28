// Re-derive enrichment (payee, category, transfer links) for stored transactions from their source
// fields. Your manual edits (categorisedBy = "user") are never touched. This is what lets new rules,
// better merchant lists or new categories apply to history without re-importing anything.

import { CategoryIndex } from '../shared/categories';
import { Categoriser, transferLegCategory } from '../shared/categorise';
import { diffDays } from '../shared/dates';
import { toMinor } from '../shared/money';
import type { Transaction } from '../shared/schema';
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
    if (res.payee !== t.payee) patch.payee = res.payee;
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
  const linked = new Set<string>();
  let transfersLinked = 0;
  for (const a of candidates) {
    if (linked.has(a.id) || a.amount >= 0) continue;
    const pool = byAmount.get(-toMinor(a.amount)) ?? [];
    let best: { t: Transaction; days: number } | undefined;
    for (const b of pool) {
      if (b.accountId === a.accountId || linked.has(b.id)) continue;
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
    for (const [t, acc, other] of [
      [a, accA, accB],
      [b, accB, accA],
    ] as const) {
      const patch = { ...(patches.get(t.id) ?? {}), transferGroup: group, counterpartyAccountId: other.id } as Partial<Transaction>;
      if (t.categorisedBy !== 'user') {
        patch.category = transferLegCategory(acc.type, other.type, t.amount);
        patch.categorisedBy = 'transfer';
      }
      patches.set(t.id, patch);
      linked.add(t.id);
    }
    transfersLinked++;
  }

  if (!opts.dryRun && patches.size) {
    await store.updateTransactions(
      [...patches.entries()].map(([id, patch]) => ({ id, patch })),
      `enrich: ${recategorised} recategorised, ${transfersLinked} transfers linked`,
    );
  }
  return { recategorised, transfersLinked };
}
