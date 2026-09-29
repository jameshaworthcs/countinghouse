// Duplicate detection for incoming transactions against what is already stored for the account.
//
//   1. Same bank transaction id (sourceId) → duplicate.
//   2. Same date, amount and simplified description → duplicate, as a multiset: two identical £3
//      coffees on one day stay two transactions if the new file also has two.
//   3. Same amount within ±3 days and similar description → possible duplicate, for you to decide
//      (typical when the same period arrives from two sources, e.g. a CSV and a screenshot).

import { diffDays } from '../../shared/dates';
import { descriptionKey } from '../../shared/merchants';
import { toMinor } from '../../shared/money';
import type { Draft, Transaction } from '../../shared/schema';

export interface DedupCandidate {
  date: string;
  amount: number;
  description: string;
  sourceId?: string | undefined;
}

export interface DedupResult {
  status: 'new' | 'duplicate' | 'possible_duplicate';
  duplicateOf?: string;
  reason?: string;
}

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

export function classifyDuplicates(incoming: DedupCandidate[], existing: Transaction[], fuzzyDays = 3): DedupResult[] {
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

  // 3. Fuzzy: same amount, nearby date, similar text.
  const byAmount = new Map<number, Transaction[]>();
  for (const t of existing) {
    if (used.has(t.id)) continue;
    const k = toMinor(t.amount);
    (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(t);
  }
  incoming.forEach((c, i) => {
    if (results[i]!.status !== 'new') return;
    let best: { t: Transaction; score: number } | null = null;
    for (const t of byAmount.get(toMinor(c.amount)) ?? []) {
      if (used.has(t.id) || conflictingIds(c, t)) continue;
      const days = Math.abs(diffDays(t.date, c.date));
      if (days > fuzzyDays) continue;
      const sim = similarity(t.description, c.description);
      if (sim < 0.4) continue;
      const score = sim - days * 0.05;
      if (!best || score > best.score) best = { t, score };
    }
    if (best) {
      used.add(best.t.id);
      results[i] = { status: 'possible_duplicate', duplicateOf: best.t.id, reason: 'Same amount, similar description, within a few days' };
    }
  });
  return results;
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
    const results = classifyDuplicates(
      rows.map((t) => ({ date: t.date, amount: t.amount, description: t.description, sourceId: t.detail?.sourceId })),
      stored(section.target.accountId).filter((t) => !claimed.has(t.id)),
    );
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
