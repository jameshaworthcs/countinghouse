// Set aside, in words (docs/FORMULAS.md §21): the same on the page, on proposals and in the API.

import type { EarmarkEffect } from './schema';

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
