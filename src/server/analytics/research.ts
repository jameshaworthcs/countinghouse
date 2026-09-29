// Lookups over the research store: the newest record of a kind for a subject, staleness, and
// matching holdings to instruments.

import { diffDays, today } from '../../shared/dates';
import { sameFundName } from '../../shared/funds';
import { normaliseDescription } from '../../shared/merchants';
import type { Holding, Instrument, Research, ResearchKind } from '../../shared/schema';
import type { Store } from '../store';

export type ResearchOf<K extends ResearchKind> = Extract<Research, { kind: K }>;

/** Newest research of `kind` about an instrument or institution (by asOf, then creation). */
export function latestResearch<K extends ResearchKind>(store: Store, kind: K, subject: { instrumentId?: string; institutionId?: string; assetClass?: string }): ResearchOf<K> | undefined {
  let best: ResearchOf<K> | undefined;
  for (const r of store.research) {
    if (r.kind !== kind) continue;
    if (subject.instrumentId && r.subject.instrumentId !== subject.instrumentId) continue;
    if (subject.institutionId && r.subject.institutionId !== subject.institutionId) continue;
    if (subject.assetClass && r.subject.assetClass !== subject.assetClass) continue;
    if (!best || r.asOf > best.asOf || (r.asOf === best.asOf && r.createdAt > best.createdAt)) best = r as ResearchOf<K>;
  }
  return best;
}

export function isStale(record: Pick<Research, 'asOf' | 'createdAt'>, staleAfterDays: number, on: string = today()): boolean {
  return diffDays(record.createdAt.slice(0, 10), on) > staleAfterDays;
}

const norm = (s: string) =>
  normaliseDescription(s)
    .replace(/\b(ACC|ACCUMULATION|INC|INCOME|CLASS|SHARES?|UNITS?|FUND|GBP|A|P|I|C|X)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** The instrument a holding refers to: by ISIN, then ticker, then name or alias. */
export function matchInstrument(holding: Pick<Holding, 'isin' | 'ticker' | 'name'>, instruments: Instrument[]): Instrument | undefined {
  if (holding.isin) {
    const hit = instruments.find((i) => i.isin === holding.isin?.toUpperCase());
    if (hit) return hit;
  }
  if (holding.ticker) {
    const t = holding.ticker.toUpperCase();
    const hit = instruments.find((i) => i.ticker?.toUpperCase() === t);
    if (hit) return hit;
  }
  const n = norm(holding.name);
  if (!n) return undefined;
  const exact = instruments.find((i) => norm(i.name) === n || i.aliases.some((a) => norm(a) === n));
  if (exact) return exact;
  // A name cut short on one statement and printed in full on another is one fund, when only one
  // instrument fits.
  const close = instruments.filter((i) => [i.name, ...i.aliases].some((a) => sameFundName(a, holding.name)));
  return close.length === 1 ? close[0] : undefined;
}
