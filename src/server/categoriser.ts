// The categoriser over the store as it is: your rules, categories, accounts and institutions, your
// name, so money to or from you by name is seen as your own money moving, and your payroll numbers
// at your jobs, so pay that carries one is seen as salary.

import { CategoryIndex } from '../shared/categories';
import { Categoriser } from '../shared/categorise';
import type { Store } from './store';

export function categoriserFor(store: Store): Categoriser {
  return new Categoriser(store.rules, new CategoryIndex(store.categories), store.accounts, store.institutions, { ownerName: store.profile.name, payrollNumbers: store.employments.flatMap((e) => e.payrollNumbers) });
}
