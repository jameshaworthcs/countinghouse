// The categoriser over the store as it is: your rules, categories, accounts and institutions, and
// your name, so money to or from you by name is seen as your own money moving.

import { CategoryIndex } from '../shared/categories';
import { Categoriser } from '../shared/categorise';
import type { Store } from './store';

export function categoriserFor(store: Store): Categoriser {
  return new Categoriser(store.rules, new CategoryIndex(store.categories), store.accounts, store.institutions, { ownerName: store.profile.name });
}
