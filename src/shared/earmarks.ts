// Set aside, in words (docs/FORMULAS.md §21): the same on the page, on proposals and in the API.

import type { EarmarkEffect, EarmarkPot } from './schema';

/** What each effect does, in plain words. */
export const EFFECT_WORDS: Record<EarmarkEffect, string> = {
  source: 'Adds to the pot',
  use: 'Paid from the pot',
  'from-pot': 'Borrowed from the pot',
  'to-pot': 'Put back into the pot',
  'topped-up': 'You topped up the pot',
  'own-back': 'Your own money back',
  own: 'Your own money',
};

/**
 * Every account money set aside names: its everyday and set-aside accounts, and the accounts and
 * counterparties its pots' rules name. One list, for the store's refusal of a company's account and
 * for a proposal's check of the same (so the two never disagree).
 */
export function earmarkAccountIds(e: { everyday: readonly string[]; setAside: readonly string[]; pots: readonly Pick<EarmarkPot, 'rules'>[] }): string[] {
  return [...e.everyday, ...e.setAside, ...e.pots.flatMap((p) => p.rules.flatMap((r) => [...(r.accountIds ?? []), ...(r.counterpartyAccountId ? [r.counterpartyAccountId] : [])]))];
}
