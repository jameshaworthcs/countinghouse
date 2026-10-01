// Agreements (agreements.json): what you agreed to pay and when, checked against what you paid
// (FORMULAS.md §10, "Agreements").

import { agreementPattern, AGREEMENT_PAYMENT_DAYS, namesCounterparty, scheduleFit } from '../../shared/agreements';
import type { AgreementView } from '../../shared/api';
import { isWrapperAccount } from '../../shared/categorise';
import { addDays, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Agreement, Transaction } from '../../shared/schema';
import type { Store } from '../store';

/** What a row says about who was paid: its description, with the merchant or payer its source gives. */
export const paidToText = (t: Pick<Transaction, 'description' | 'merchant' | 'counterpartyName'>) => `${t.merchant?.name ?? t.counterpartyName ?? ''} ${t.description}`;

/** Money out of your everyday accounts (not an investment or pension) naming the agreement's counterparty. */
export function paymentsTo(store: Store, a: Agreement): Transaction[] {
  const pattern = agreementPattern(a);
  const wrapper = new Set(store.accounts.filter((x) => isWrapperAccount(x.type)).map((x) => x.id));
  return store
    .transactions()
    .filter((t) => t.amount < 0 && !wrapper.has(t.accountId) && namesCounterparty(pattern, paidToText(t)))
    .sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
}

interface Pairing {
  /** Each agreement's payments to its counterparty. */
  paid: Map<string, Transaction[]>;
  /** By agreement, the payment each payment due (by its index) pairs with. */
  pairs: Map<string, Map<number, Transaction>>;
  /** Every payment paired, whichever agreement's. */
  used: Set<string>;
}

/**
 * Every agreement's payments due paired with payments at once, so two agreements never share one (a
 * tenancy and its renewal, the month's rent either side of the change): the pairs of exactly what
 * was due first, then the fewest days apart, then the nearest amount (within a tenth).
 */
function pairAll(store: Store, agreements: readonly Agreement[]): Pairing {
  const paid = new Map(agreements.map((a) => [a.id, paymentsTo(store, a)]));
  const options: { ai: number; id: string; i: number; t: Transaction; exact: boolean; days: number; off: number }[] = [];
  agreements.forEach((a, ai) => {
    a.payments.forEach((p, i) => {
      for (const t of paid.get(a.id)!) {
        const fit = scheduleFit(a, p, t.date, -t.amount);
        if (fit) options.push({ ai, id: a.id, i, t, exact: fit.off === 0, ...fit });
      }
    });
  });
  options.sort((x, y) => Number(y.exact) - Number(x.exact) || x.days - y.days || x.off - y.off || x.ai - y.ai || x.i - y.i || x.t.id.localeCompare(y.t.id));
  const pairs = new Map(agreements.map((a) => [a.id, new Map<number, Transaction>()]));
  const used = new Set<string>();
  for (const o of options) {
    const mine = pairs.get(o.id)!;
    if (mine.has(o.i) || used.has(o.t.id)) continue;
    mine.set(o.i, o.t);
    used.add(o.t.id);
  }
  return { paid, pairs, used };
}

export function agreementsView(store: Store, now: ISODate = today()): AgreementView[] {
  const pairing = pairAll(store, store.agreements);
  return store.agreements.map((a) => viewOf(a, pairing, now));
}

/** One agreement (as given, in place of the store's with its id), checked with all the others. */
export function agreementView(store: Store, a: Agreement, now: ISODate = today()): AgreementView {
  const list = store.agreements.some((x) => x.id === a.id) ? store.agreements.map((x) => (x.id === a.id ? a : x)) : [...store.agreements, a];
  return viewOf(a, pairAll(store, list), now);
}

function viewOf(a: Agreement, { paid, pairs, used }: Pairing, now: ISODate): AgreementView {
  const found = pairs.get(a.id)!;
  const payments: AgreementView['payments'] = a.payments.map((p, i) => {
    const t = found.get(i);
    const status = t ? 'paid' : p.due > now ? 'upcoming' : addDays(p.due, AGREEMENT_PAYMENT_DAYS) >= now ? 'due' : 'unseen';
    const difference = t ? toMinor(-t.amount) - toMinor(p.amount) : 0;
    return { due: p.due, amount: p.amount, ...(p.label ? { label: p.label } : {}), status, ...(t ? { paid: { transactionId: t.id, accountId: t.accountId, date: t.date, amount: -t.amount, ...(difference ? { difference: fromMinor(difference) } : {}) } } : {}) };
  });

  // Other payments to it in its category that no agreement pairs with: from when it was agreed (its
  // start, if that is not known) to 45 days after it ends, as a charge after a let comes.
  const dues = a.payments.map((p) => p.due).sort();
  const start = [a.agreedOn ?? a.from, dues[0]!].sort()[0]!;
  const end = addDays([a.until ?? a.from, dues.at(-1)!].sort().at(-1)!, AGREEMENT_PAYMENT_DAYS);
  const others = paid
    .get(a.id)!
    .filter((t) => !used.has(t.id) && t.category === a.category && t.date >= start && t.date <= end)
    .map((t) => ({ transactionId: t.id, accountId: t.accountId, date: t.date, amount: -t.amount }));

  const total = [...payments.flatMap((p) => (p.paid ? [p.paid.amount] : [])), ...others.map((o) => o.amount)].reduce((x, n) => x + toMinor(n), 0);
  return { agreement: a, payments, others, paid: fromMinor(total) };
}
