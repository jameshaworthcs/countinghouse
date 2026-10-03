// The categoriser over the store as it is: your rules, categories, accounts and institutions, your
// name, so money to or from you by name is seen as your own money moving, your payroll numbers at
// your jobs, so pay that carries one is seen as salary, your agreements, so a payment one schedules
// takes its category, the names the bank gives your jobs' pay, so pay before your payslips start is
// salary, and what each card paid whom, so money back from the same payee is that purchase's refund.

import { CategoryIndex } from '../shared/categories';
import { CARD_REFUND_DAYS, Categoriser, purchaseKey, type CardPurchases, type CategoriseInput } from '../shared/categorise';
import { diffDays } from '../shared/dates';
import { cleanPayee } from '../shared/merchants';
import type { Agreement, Category, Rule, Transaction } from '../shared/schema';
import { paidAs } from './analytics/pay';
import type { Store } from './store';

/** `agreements`, `rules`, `categories`: in place of the store's, as when a proposal would add some. */
export function categoriserFor(store: Store, opts: { agreements?: readonly Agreement[]; rules?: readonly Rule[]; categories?: readonly Category[] } = {}): Categoriser {
  return new Categoriser([...(opts.rules ?? store.rules)], new CategoryIndex([...(opts.categories ?? store.categories)]), store.accounts, store.institutions, {
    ownerName: store.profile.name,
    payrollNumbers: store.employments.flatMap((e) => e.payrollNumbers),
    agreements: opts.agreements ?? store.agreements,
    employers: paidAs(store),
    cardPurchases: cardPurchases(store),
  });
}

/** Each card's purchases by payee (`purchaseKey`), newest first, with the category each has. */
function cardPurchases(store: Store): CardPurchases {
  const cards = new Set(store.accounts.filter((a) => a.type === 'credit_card').map((a) => a.id));
  const byPayee = new Map<string, { date: string; category: string | undefined }[]>();
  for (const t of store.transactions()) {
    if (!cards.has(t.accountId) || t.amount >= 0 || t.transferGroup) continue;
    const key = `${t.accountId}|${purchaseKey(t.description)}`;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push({ date: t.date, category: t.category });
  }
  for (const list of byPayee.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return (accountId, key, date) => {
    if (key.length < 3) return undefined;
    const hit = byPayee.get(`${accountId}|${key}`)?.find((p) => p.date <= date && diffDays(p.date, date) <= CARD_REFUND_DAYS);
    return hit ? (hit.category ?? 'refunds') : undefined;
  };
}

/**
 * What the categoriser is given for a recorded transaction: its source fields, and what other
 * documents that showed it said of it (their own description) with its reference. The other party
 * the source names is its payee already, and is not read as a description: "Interactive Investor"
 * named as the payee of a fee is not money moved to your account there.
 */
export function categoriseInputOf(t: Transaction): CategoriseInput {
  const alsoSaid = [...(t.seenIn ?? []).map((s) => s.said?.description), t.reference].filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && s !== t.description);
  return {
    accountId: t.accountId,
    description: t.description,
    amount: t.amount,
    date: t.date,
    type: t.type,
    bankCategory: t.bankCategory,
    aiCategory: t.categorisedBy === 'ai' ? t.category : undefined,
    payee: t.merchant?.name ?? t.counterpartyName,
    ...(alsoSaid.length ? { alsoSaid: [...new Set(alsoSaid)] } : {}),
  };
}

/**
 * Does a rule catch a recorded transaction, as categorising it would: its description or what other
 * documents said of it, and the payee the categoriser works out (the other party its source names,
 * else one cut from the description), not the payee shown.
 */
export function ruleCatches(rule: Rule, t: Transaction, categoriser: Categoriser = new Categoriser([rule], new CategoryIndex([]), [], [])): boolean {
  const input = categoriseInputOf(t);
  const payee = input.payee ?? cleanPayee(input.description);
  return [input.description, ...(input.alsoSaid ?? [])].some((description) => categoriser.matchRule(rule, { ...input, description }, payee));
}
