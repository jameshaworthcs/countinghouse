// Duplicate detection for incoming transactions against what is already stored for the account.
//
//   1. Same bank transaction id (sourceId) → duplicate.
//   2. Same date, amount and simplified description → duplicate, as a multiset: two identical £3
//      coffees on one day stay two transactions if the new file also has two.
//   3. Same date, amount and balance after it (both known) → duplicate, as a multiset. The running
//      balance places a row in the account's history, whatever each source calls it: Chase's
//      statement says "To Credit Card" where its export says "To Revolving Line Account".
//   3b. Same date, amount and time to the minute (both known) → duplicate, as a multiset. The date
//      and time may be the record's own or the day it was made: an app lists a payment by when the
//      card was used, and a record filled in from it keeps that too (shared/detail.ts).
//   4. Same amount within ±3 days → possible duplicate, for you to decide (typical when the same
//      period arrives from two sources, e.g. a CSV and a screenshot), when the descriptions are
//      similar. Described differently, only from £20 (`DIFFERENT_WORDS_FROM`), and then on the same
//      day or for an amount with pence: sources date a payment differently (the day it was made,
//      the day it cleared) and describe it differently, but two £3.50 coffees at different cafés
//      are two coffees. Never when both show a balance after them and the balances differ.
//   5. From a document that is not a list of transactions (a letter, a confirmation), a row that
//      stored rows add up to (two or three, within ±3 days, the same way, from £100) → possible
//      duplicate: a deposit made in two payments, confirmed by letter as one.

import { diffDays } from '../../shared/dates';
import { descriptionKey } from '../../shared/merchants';
import { formatMoney, toMinor } from '../../shared/money';
import type { Draft, DraftTransaction, ExtraCopy, Transaction } from '../../shared/schema';

export interface DedupCandidate {
  date: string;
  amount: number;
  description: string;
  sourceId?: string | undefined;
  balanceAfter?: number | undefined;
  /** HH:MM[:SS], of `date`. */
  time?: string | undefined;
}

/** A draft row as dedup sees it: its bank id and time are in its detail. */
export const candidateOf = (t: Pick<DraftTransaction, 'date' | 'amount' | 'description' | 'balanceAfter' | 'detail'>): DedupCandidate => ({
  date: t.date,
  amount: t.amount,
  description: t.description,
  sourceId: t.detail?.sourceId,
  balanceAfter: t.balanceAfter,
  time: t.detail?.time,
});

/** Below this, the same amount described differently is taken as another payment (everyday prices repeat). */
export const DIFFERENT_WORDS_FROM = 20;

/** Below this, a row that stored rows add up to is taken as its own payment (small sums coincide). */
export const SUM_FROM = 100;

/** Two or three of `rows` whose amounts add up to `minor` exactly, if any do. */
function rowsAddingUpTo<T extends { amount: number }>(rows: T[], minor: number): T[] | undefined {
  const m = rows.map((r) => toMinor(r.amount));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (m[i]! + m[j]! === minor) return [rows[i]!, rows[j]!];
      for (let k = j + 1; k < rows.length; k++) if (m[i]! + m[j]! + m[k]! === minor) return [rows[i]!, rows[j]!, rows[k]!];
    }
  }
  return undefined;
}

/** Both show a balance after them, and the balances differ (either sign, as sources differ on a card's): two payments. */
const otherBalance = (a: { balanceAfter?: number | undefined }, b: { balanceAfter?: number | undefined }) =>
  a.balanceAfter !== undefined && b.balanceAfter !== undefined && Math.abs(toMinor(a.balanceAfter)) !== Math.abs(toMinor(b.balanceAfter));

export interface DedupResult {
  status: 'new' | 'duplicate' | 'possible_duplicate';
  duplicateOf?: string;
  reason?: string;
  /** Matched to several recorded rows adding up to it (step 5): `duplicateOf` is only the first. */
  sum?: true;
}

/** A time a row can be placed by: to the minute, and not a midnight an export puts on every row. */
const minuteOf = (time: string | undefined) => (time && time.slice(0, 5) !== '00:00' ? time.slice(0, 5) : undefined);

function tokens(s: string): Set<string> {
  return new Set(descriptionKey(s).split(' ').filter((t) => t.length >= 3));
}

export function similarity(a: string, b: string): number {
  const ka = descriptionKey(a);
  const kb = descriptionKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.includes(kb) || kb.includes(ka)) return 0.9;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return ka.slice(0, 6) === kb.slice(0, 6) ? 0.6 : 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/** `sums`: the document is not a list of transactions, so a row may restate several (step 5). */
export function classifyDuplicates(incoming: DedupCandidate[], existing: Transaction[], fuzzyDays = 3, opts: { sums?: boolean } = {}): DedupResult[] {
  const results: DedupResult[] = incoming.map(() => ({ status: 'new' }));
  const used = new Set<string>();
  const conflictingIds = (c: DedupCandidate, t: Transaction) => Boolean(c.sourceId && t.sourceId && c.sourceId !== t.sourceId);

  // 1. Bank transaction ids.
  const bySource = new Map<string, Transaction>();
  for (const t of existing) if (t.sourceId) bySource.set(t.sourceId, t);
  incoming.forEach((c, i) => {
    if (!c.sourceId) return;
    const t = bySource.get(c.sourceId);
    if (t && !used.has(t.id)) {
      used.add(t.id);
      results[i] = { status: 'duplicate', duplicateOf: t.id, reason: 'Same bank transaction id' };
    }
  });

  // 2. Exact date + amount + description, as a multiset.
  const key = (date: string, amount: number, desc: string) => `${date}|${toMinor(amount)}|${descriptionKey(desc)}`;
  const buckets = new Map<string, Transaction[]>();
  for (const t of existing) {
    if (used.has(t.id)) continue;
    const k = key(t.date, t.amount, t.description);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(t);
  }
  incoming.forEach((c, i) => {
    if (results[i]!.status !== 'new') return;
    const bucket = buckets.get(key(c.date, c.amount, c.description));
    const idx = bucket?.findIndex((t) => !used.has(t.id) && !conflictingIds(c, t)) ?? -1;
    if (bucket && idx >= 0) {
      const t = bucket.splice(idx, 1)[0]!;
      used.add(t.id);
      results[i] = { status: 'duplicate', duplicateOf: t.id, reason: 'Same date, amount and description' };
    }
  });

  // 3. Exact date + amount + balance after, as a multiset.
  incoming.forEach((c, i) => {
    if (results[i]!.status !== 'new' || c.balanceAfter === undefined) return;
    const t = existing.find((x) => !used.has(x.id) && !conflictingIds(c, x) && x.date === c.date && toMinor(x.amount) === toMinor(c.amount) && x.balanceAfter !== undefined && toMinor(x.balanceAfter) === toMinor(c.balanceAfter!));
    if (t) {
      used.add(t.id);
      results[i] = { status: 'duplicate', duplicateOf: t.id, reason: 'Same date, amount and balance after it' };
    }
  });

  // 3b. Exact date + amount + time, as a multiset: the record's posting, or when it was made.
  incoming.forEach((c, i) => {
    const minute = minuteOf(c.time);
    if (results[i]!.status !== 'new' || !minute) return;
    const at = (x: Transaction) => (x.date === c.date && minuteOf(x.time) === minute) || (x.transactionDate === c.date && minuteOf(x.transactionTime) === minute);
    const t = existing.find((x) => !used.has(x.id) && !conflictingIds(c, x) && !otherBalance(c, x) && toMinor(x.amount) === toMinor(c.amount) && at(x));
    if (t) {
      used.add(t.id);
      results[i] = { status: 'duplicate', duplicateOf: t.id, reason: 'Same date, amount and time' };
    }
  });

  // 4. Fuzzy: same amount, nearby date; similar text, the same day, or an amount with pence.
  const byAmount = new Map<number, Transaction[]>();
  for (const t of existing) {
    if (used.has(t.id)) continue;
    const k = toMinor(t.amount);
    (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(t);
  }
  incoming.forEach((c, i) => {
    if (results[i]!.status !== 'new') return;
    const pence = toMinor(c.amount) % 100 !== 0;
    const large = Math.abs(toMinor(c.amount)) >= DIFFERENT_WORDS_FROM * 100;
    let best: { t: Transaction; score: number; similar: boolean; days: number } | null = null;
    for (const t of byAmount.get(toMinor(c.amount)) ?? []) {
      if (used.has(t.id) || conflictingIds(c, t) || otherBalance(c, t)) continue;
      // From either of the record's days: when it cleared, or when it was made.
      const days = Math.min(Math.abs(diffDays(t.date, c.date)), t.transactionDate ? Math.abs(diffDays(t.transactionDate, c.date)) : Infinity);
      if (days > fuzzyDays) continue;
      const sim = similarity(t.description, c.description);
      const similar = sim >= 0.4;
      if (!similar && !(large && (days === 0 || pence))) continue;
      const score = sim - days * 0.05;
      if (!best || score > best.score) best = { t, score, similar, days };
    }
    if (best) {
      used.add(best.t.id);
      const reason = best.similar ? 'Same amount, similar description, within a few days' : `Same amount ${best.days === 0 ? 'on the same day' : 'within a few days'}, described differently`;
      results[i] = { status: 'possible_duplicate', duplicateOf: best.t.id, reason };
    }
  });

  // 5. A letter restating money recorded as several payments.
  if (opts.sums) {
    incoming.forEach((c, i) => {
      if (results[i]!.status !== 'new') return;
      const want = toMinor(c.amount);
      if (Math.abs(want) < SUM_FROM * 100) return;
      const near = existing.filter((t) => !used.has(t.id) && Math.sign(t.amount) === Math.sign(c.amount) && Math.abs(toMinor(t.amount)) < Math.abs(want) && Math.abs(diffDays(t.date, c.date)) <= fuzzyDays);
      const parts = rowsAddingUpTo(near, want);
      if (!parts) return;
      for (const t of parts) used.add(t.id);
      const money = (t: Transaction) => formatMoney(Math.abs(t.amount), { currency: t.currency });
      results[i] = { status: 'possible_duplicate', duplicateOf: parts[0]!.id, reason: `The same money as ${parts.length} payments recorded within a few days: ${parts.map(money).join(' + ')}`, sum: true };
    });
  }
  return results;
}

/**
 * Something of yours is on this transaction, or it is linked to another: a category, payee, note,
 * tag or split you set, a correction, a receipt, details another document filled in when you
 * committed it, a transfer link. Such a copy is never taken away.
 */
export function hasYourChanges(t: Transaction, withReceipts: Set<string>): boolean {
  return t.categorisedBy === 'user' || t.payeeSetBy === 'user' || Boolean(t.notes || t.tags?.length || t.splits?.length || t.corrections?.length || t.seenIn?.length || t.transferGroup) || withReceipts.has(t.id);
}

/**
 * Payments the account has recorded twice that this document shows once (docs/INGESTION.md,
 * "Recorded twice"). A recorded row the document matches has a second copy when another recorded row
 * has the same date and amount, nothing on the document matches it, another import recorded it (one
 * document listing both means two payments: a spend, its refund and the spend again), and either:
 * - both show the same balance after them: the same payment, for certain (ticked to be taken away);
 * - or the document shows that date and amount fewer times than they are recorded, and no balances
 *   say otherwise (for you to judge).
 * The copy offered is one with nothing of yours on it: the one the document did not match, unless
 * only the other is clean. When both have something of yours, nothing is offered.
 */
export function storedTwice(rows: Pick<DraftTransaction, 'date' | 'amount' | 'status' | 'duplicateOf'>[], stored: Transaction[], opts: { withReceipts?: Set<string>; fileOf?: (t: Transaction) => string | undefined } = {}): ExtraCopy[] {
  const withReceipts = opts.withReceipts ?? new Set<string>();
  const dayKey = (x: { date: string; amount: number }) => `${x.date}|${toMinor(x.amount)}`;
  const claimed = new Set(rows.flatMap((r) => (r.status !== 'new' && r.duplicateOf ? [r.duplicateOf] : [])));
  const shown = new Map<string, number>();
  for (const r of rows) shown.set(dayKey(r), (shown.get(dayKey(r)) ?? 0) + 1);
  const recorded = new Map<string, Transaction[]>();
  for (const t of stored) (recorded.get(dayKey(t)) ?? recorded.set(dayKey(t), []).get(dayKey(t))!).push(t);
  const byId = new Map(stored.map((t) => [t.id, t]));
  const offered = new Set<string>();
  const out: ExtraCopy[] = [];
  for (const id of claimed) {
    const matched = byId.get(id);
    if (!matched || offered.has(id)) continue;
    const k = dayKey(matched);
    const same = recorded.get(k) ?? [];
    for (const twin of same) {
      if (twin.id === matched.id || claimed.has(twin.id) || offered.has(twin.id)) continue;
      if (twin.source.importId && twin.source.importId === matched.source.importId) continue;
      const sameBalance = matched.balanceAfter !== undefined && twin.balanceAfter !== undefined && toMinor(matched.balanceAfter) === toMinor(twin.balanceAfter);
      const extra = same.length - out.filter((c) => dayKey(c) === k).length > (shown.get(k) ?? 0);
      if (!sameBalance && (!extra || otherBalance(matched, twin))) continue;
      const [gone, kept] = !hasYourChanges(twin, withReceipts) ? [twin, matched] : !hasYourChanges(matched, withReceipts) ? [matched, twin] : [undefined, undefined];
      if (!gone || !kept) continue;
      offered.add(gone.id);
      offered.add(kept.id);
      const fromFile = opts.fileOf?.(gone);
      out.push({ transactionId: gone.id, keepId: kept.id, accountId: gone.accountId, date: gone.date, amount: gone.amount, description: gone.description, ...(fromFile ? { fromFile } : {}), sameBalance, remove: sameBalance });
      break;
    }
  }
  return out;
}

/**
 * A draft's rows were checked against what was stored when it was made. Before it is committed
 * another import may have added some of them (screenshots of one list, scrolled, overlap by a row),
 * and a section given its account by hand was never checked against that account. So the rows it
 * would add are checked again at commit, against the stored rows the draft has not already matched:
 * - a row now stored exactly (the same bank id, or the same date, amount and description) is left
 *   out;
 * - a row that now looks like a stored one (same amount, similar description, a few days apart) is
 *   marked and left out, and the commit waits for you to check it.
 * Only rows that were new and included are looked at, so your own choices stand.
 */
export function recheckDraft(draft: Draft, stored: (accountId: string) => Transaction[]): { draft: Draft; alreadyStored: number; toCheck: string[] } {
  const next: Draft = structuredClone(draft);
  let alreadyStored = 0;
  const toCheck: string[] = [];
  for (const section of next.sections) {
    if (section.target.mode !== 'existing') continue;
    const claimed = new Set(section.transactions.flatMap((t) => (t.status !== 'new' && t.duplicateOf ? [t.duplicateOf] : [])));
    const rows = section.transactions.filter((t) => t.status === 'new' && t.include);
    if (!rows.length) continue;
    const results = classifyDuplicates(rows.map(candidateOf), stored(section.target.accountId).filter((t) => !claimed.has(t.id)));
    rows.forEach((t, i) => {
      const r = results[i]!;
      if (r.status === 'new') return;
      t.status = r.status;
      t.include = false;
      if (r.duplicateOf) t.duplicateOf = r.duplicateOf;
      if (r.status === 'duplicate') alreadyStored++;
      else toCheck.push(t.key);
    });
  }
  return { draft: next, alreadyStored, toCheck };
}
