// Set aside, in words (docs/FORMULAS.md §21).

import type { EarmarkEffect } from '../../shared/schema';

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

/** Why a payment counts as it does. */
export const BY_WORDS = { decision: 'your decision', rule: 'rule', default: 'transfer with a set-aside account', suggested: 'suggested: to check' } as const;
