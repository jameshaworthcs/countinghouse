// Re-derive enrichment (payee, category, transfer links) for stored transactions from their source
// fields. Your manual edits (categorisedBy = "user") are never touched. This is what lets new rules,
// better merchant lists or new categories apply to history without re-importing anything.

import { isWrapperAccount, payrollPattern, transferLegCategory, type Categoriser, type CategoriseInput, type CategoriseResult } from '../shared/categorise';
import { diffDays } from '../shared/dates';
import { cleanPayee } from '../shared/merchants';
import { toMinor } from '../shared/money';
import { tidyPlace } from '../shared/places';
import type { Account, Transaction } from '../shared/schema';
import { categoriseInputOf, categoriserFor } from './categoriser';
import { transferGroupId } from './ids';
import type { Store } from './store';

const TRANSFERISH = new Set(['transfer', 'credit-card-payment', 'savings-transfer', 'investment-transfer', 'contribution', 'withdrawal']);

/**
 * A payee that is the bank's wording rather than a name: the description itself, or one that keeps
 * its words for how the money moved ("…VIA FASTER PAYMENT TO…", "… Purchase | EUR 24.50 | FX rate").
 */
export function payeeLooksRaw(payee: string, description: string): boolean {
  if (payee.trim().toLowerCase() === description.trim().toLowerCase()) return true;
  return /\b(?:VIA FASTER PAYMENT|FASTER PAYMENTS? RECEIPT|REFERENCE|MANDATE|BANK GIRO CREDIT|DIRECT DEBIT|BILL PAYMENT|THIRD PARTY PAYMENT|CARD PAYMENT|REF)\b|\(VIA (?:APPLE|GOOGLE) PAY\)|\|\s*[A-Z]{3}\s+[\d.,]|FX RATE|&AMP;|\s(?:PURCHASE|REFUND)$|^(?:FROM|TO)\s|\d{5,}/i.test(payee);
}

/** Letters and digits only, lower case: for asking whether one text holds another. */
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The payee enrichment gives a row: the categoriser's, unless that is only a name cut from the
 * description and the row has a clean one from elsewhere already, as the reader gave it. A payee
 * cut from the description by an earlier version of the tidying is not from
 * elsewhere: its words are the description's. A payee you set is never changed.
 */
export function nextPayee(t: Transaction, input: CategoriseInput, res: CategoriseResult): string | undefined {
  if (t.payeeSetBy === 'user') return t.payee;
  const cut = cleanPayee(t.description);
  const weak = res.payee === (input.payee ?? input.aiPayee ?? cut) || res.payee === cut;
  const fromElsewhere = t.payee !== undefined && !letters(t.description).includes(letters(t.payee));
  if (weak && t.payee && fromElsewhere && !payeeLooksRaw(t.payee, t.description)) return t.payee;
  return res.payee;
}

export interface EnrichResult {
  recategorised: number;
  transfersLinked: number;
  /** With `detail`: each row it would change, and how. */
  changes?: EnrichChange[];
}

/** A row enrichment changes: its payee, its category and what gave it, or a transfer link. */
export interface EnrichChange {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  payee?: { from: string | null; to: string | null };
  category?: { from: string | null; to: string | null; by: Transaction['categorisedBy'] | null };
  linked?: boolean;
}

/**
 * Each transaction's tidy address (shared/places.ts), worked out again from its merchant fields,
 * which stay as the document gave them. Run when the app starts, so improved rules reach history
 * and transactions from before places existed get one. Returns how many changed.
 */
export async function refreshPlaces(store: Store): Promise<number> {
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  for (const t of store.transactions()) {
    const place = tidyPlace(t.merchant);
    if (place !== t.place) updates.push({ id: t.id, patch: { place } });
  }
  if (updates.length) await store.updateTransactions(updates, `data: tidy merchant addresses (${updates.length} transaction${updates.length === 1 ? '' : 's'})`);
  return updates.length;
}

/**
 * Rows in investment and pension accounts that nothing categorised, which the app's built-in
 * wording now explains (a provider's words for a trade or a dividend): they get that category, and
 * the payee it gives unless you set one. Run when the app starts, so wording learnt later reaches
 * rows already committed. Nothing else is touched: a category set by anyone stays, and so does a
 * row you left uncategorised. Returns how many changed.
 */
export async function categoriseInvestmentRows(store: Store): Promise<number> {
  const wrappers = store.accounts.filter((a) => isWrapperAccount(a.type));
  if (!wrappers.length) return 0;
  const categoriser = categoriserFor(store);
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  for (const a of wrappers) {
    for (const t of store.transactions(a.id)) {
      if (t.category || t.categorisedBy || t.transferGroup) continue;
      const res = categoriser.categorise({ ...categoriseInputOf(t), aiCategory: undefined });
      if (!res.category || res.categorisedBy !== 'builtin') continue;
      const patch: Partial<Transaction> = { category: res.category, categorisedBy: 'builtin' };
      if (t.payeeSetBy !== 'user' && res.payee && res.payee !== t.payee) patch.payee = res.payee;
      updates.push({ id: t.id, patch });
    }
  }
  if (updates.length) await store.updateTransactions(updates, `data: categorise ${updates.length} investment-account row${updates.length === 1 ? '' : 's'} from their wording`);
  return updates.length;
}

export async function enrich(store: Store, opts: { accountIds?: string[]; dryRun?: boolean; detail?: boolean } = {}): Promise<EnrichResult> {
  const categoriser = categoriserFor(store);
  const scope = opts.accountIds ? new Set(opts.accountIds) : null;
  const patches = new Map<string, Partial<Transaction>>();
  let recategorised = 0;

  for (const t of store.transactions()) {
    if (scope && !scope.has(t.accountId)) continue;
    if (t.categorisedBy === 'user' || (t.transferGroup && t.categorisedBy === 'transfer')) continue;
    const input = categoriseInputOf(t);
    const res = categoriser.categorise(input);
    const patch: Partial<Transaction> = {};
    const place = tidyPlace(t.merchant);
    if (place !== t.place) patch.place = place;
    const payee = nextPayee(t, input, res);
    if (payee !== t.payee) patch.payee = payee;
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
  if (!opts.detail) return { recategorised, transfersLinked };
  const changes: EnrichChange[] = [];
  for (const [id, patch] of patches) {
    const t = store.transaction(id);
    if (!t) continue;
    const change: EnrichChange = { id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description };
    if ('payee' in patch && patch.payee !== t.payee) change.payee = { from: t.payee ?? null, to: patch.payee ?? null };
    if ('category' in patch && patch.category !== t.category) change.category = { from: t.category ?? null, to: patch.category ?? null, by: ('categorisedBy' in patch ? patch.categorisedBy : t.categorisedBy) ?? null };
    if (patch.transferGroup) change.linked = true;
    if (change.payee || change.category || change.linked) changes.push(change);
  }
  return { recategorised, transfersLinked, changes };
}

/**
 * Pay recorded before its job had your payroll number: money in with no category that carries one of
 * `numbers` is salary, as the categoriser now says of it (shared/categorise.ts, step 4c). Only gaps
 * are filled: a category you, a rule or a reader gave stays. Returns how many.
 */
export async function salaryByPayroll(store: Store, numbers: readonly string[], message: string): Promise<number> {
  const re = payrollPattern(numbers);
  if (!re) return 0;
  const wrapper = (id: string) => {
    const a = store.account(id);
    return a ? isWrapperAccount(a.type) : false;
  };
  const found = store.transactions().filter((t) => t.amount > 0 && !t.category && t.categorisedBy !== 'user' && !t.transferGroup && !wrapper(t.accountId) && re.test(t.description));
  if (found.length) await store.updateTransactions(found.map((t) => ({ id: t.id, patch: { category: 'salary', categorisedBy: 'builtin' } })), message);
  return found.length;
}

/** Source fields the categoriser reads: filling one in can change what a row is. */
const CATEGORISER_READS = ['type', 'counterpartyName', 'merchant', 'bankCategory'] as const;

/**
 * A recorded row's payee, category and own-account link worked out again after another document
 * filled in some of its source fields (shared/detail.ts), as `enrich` would: only when a field
 * the categoriser reads was filled in, and never on a row you categorised or one linked as a
 * transfer. Returns the patch, empty when nothing changes.
 */
export function rederive(categoriser: Categoriser, t: Transaction, filled: readonly string[]): Partial<Transaction> {
  if (!filled.some((f) => (CATEGORISER_READS as readonly string[]).includes(f))) return {};
  if (t.categorisedBy === 'user' || t.transferGroup) return {};
  const input = categoriseInputOf(t);
  const res = categoriser.categorise(input);
  const patch: Partial<Transaction> = {};
  const payee = nextPayee(t, input, res);
  if (payee && payee !== t.payee) patch.payee = payee;
  if (res.category !== t.category) patch.category = res.category;
  if (res.categorisedBy !== t.categorisedBy) patch.categorisedBy = res.categorisedBy;
  if (res.ruleId !== t.ruleId) patch.ruleId = res.ruleId;
  if (res.counterpartyAccountId !== t.counterpartyAccountId) patch.counterpartyAccountId = res.counterpartyAccountId;
  if (res.tags?.length) {
    const tags = [...new Set([...(t.tags ?? []), ...res.tags])];
    if (tags.length !== (t.tags?.length ?? 0)) patch.tags = tags;
  }
  return patch;
}

/**
 * How strongly two rows say they are the same money moving between your accounts, or null when one
 * of them says it went somewhere else (docs/INGESTION.md, "Transfers").
 * - A row that names the other row's account (by its number, an alias or its bank) counts 3.
 * - A row that pays you or comes from you by name counts 1; so does a transfer category, but one
 *   side's category alone is not enough: it says nothing about the other side ("Rainy day", a savings
 *   move, is not the payment to an exchange that another account made that day).
 * - A row that names only other accounts of yours, or was set to go to another (a rule's
 *   counterparty), rules the pair out: "AJ BELL" is not a payment to the Chase saver.
 * With nothing for it, the pair is not linked.
 */
export type TransferSide = Pick<Transaction, 'id' | 'accountId' | 'description' | 'type' | 'category' | 'counterpartyAccountId'>;

export function transferEvidence(a: TransferSide, b: TransferSide, named: (t: TransferSide) => string[], ownName: (t: TransferSide) => boolean): number | null {
  const namesA = named(a);
  const namesB = named(b);
  if ((namesA.length && !namesA.includes(b.accountId)) || (namesB.length && !namesB.includes(a.accountId))) return null;
  if ((a.counterpartyAccountId && a.counterpartyAccountId !== b.accountId) || (b.counterpartyAccountId && b.counterpartyAccountId !== a.accountId)) return null;
  let score = 0;
  if (namesA.includes(b.accountId) || a.counterpartyAccountId === b.accountId) score += 3;
  if (namesB.includes(a.accountId) || b.counterpartyAccountId === a.accountId) score += 3;
  if (ownName(a)) score += 1;
  if (ownName(b)) score += 1;
  const categories = [a, b].filter((t) => t.category && TRANSFERISH.has(t.category)).length;
  score += categories;
  if (score === 1 && categories === 1) return null;
  return score > 0 ? score : null;
}

/**
 * Pair transfers: money out of one of your accounts with the same amount into another, at most 4
 * days apart, where the rows say so (transferEvidence). The pairs with the most evidence are linked
 * first, then the closest together; a row is linked once.
 */
/**
 * What a transaction's description says about your accounts and you, for transferEvidence: the
 * accounts it names (worked out once per row), and whether it names you.
 */
export function transferReader(store: Store, categoriser = categoriserFor(store)) {
  const cache = new Map<string, string[]>();
  const named = (t: TransferSide) => {
    let ids = cache.get(t.id);
    if (!ids) {
      const type = store.account(t.accountId)?.type;
      // As when categorising: bank names say nothing inside an investment or pension account.
      const useInstitutions = !type || !isWrapperAccount(type) || type === 'cash_isa';
      ids = categoriser.ownAccountsMentioned(t.accountId, t.description, useInstitutions, t.type).map((x) => x.id);
      cache.set(t.id, ids);
    }
    return ids;
  };
  const ownName = (t: TransferSide) => categoriser.namesOwner(t.description);
  return { named, ownName };
}

function pairTransfers(store: Store, candidates: Transaction[], byAmount: Map<number, Transaction[]>) {
  const { named, ownName } = transferReader(store);

  const outgoing = new Map<string, Transaction>();
  for (const t of candidates) if (t.amount < 0) outgoing.set(t.id, t);
  for (const t of candidates) if (t.amount > 0) for (const o of byAmount.get(-toMinor(t.amount)) ?? []) if (o.amount < 0 && !o.transferGroup) outgoing.set(o.id, o);
  const options: { a: Transaction; b: Transaction; score: number; days: number }[] = [];
  for (const a of outgoing.values()) {
    for (const b of byAmount.get(-toMinor(a.amount)) ?? []) {
      if (b.amount <= 0 || b.accountId === a.accountId || b.transferGroup) continue;
      const days = Math.abs(diffDays(a.date, b.date));
      if (days > 4) continue;
      const score = transferEvidence(a, b, named, ownName);
      if (score !== null) options.push({ a, b, score, days });
    }
  }
  options.sort((x, y) => y.score - x.score || x.days - y.days || x.a.date.localeCompare(y.a.date) || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));

  const linked = new Set<string>();
  const groupOf = new Map<string, string>();
  const legs: [Transaction, Account, Account][] = [];
  let count = 0;
  for (const { a, b } of options) {
    if (linked.has(a.id) || linked.has(b.id)) continue;
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
