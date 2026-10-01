// The categoriser over the store as it is: your rules, categories, accounts and institutions, your
// name, so money to or from you by name is seen as your own money moving, your payroll numbers at
// your jobs, so pay that carries one is seen as salary, and your agreements, so a payment one
// schedules takes its category.

import { CategoryIndex } from '../shared/categories';
import { Categoriser } from '../shared/categorise';
import type { Agreement } from '../shared/schema';
import type { Store } from './store';

/** `agreements`: in place of the store's, as when a proposal would add one. */
export function categoriserFor(store: Store, opts: { agreements?: readonly Agreement[] } = {}): Categoriser {
  return new Categoriser(store.rules, new CategoryIndex(store.categories), store.accounts, store.institutions, { ownerName: store.profile.name, payrollNumbers: store.employments.flatMap((e) => e.payrollNumbers), agreements: opts.agreements ?? store.agreements });
}
