// Agreements (agreements.json): what you agreed to pay and when, or are to be paid, checked against
// what was paid (FORMULAS.md §10, "Agreements").

import { agreementPattern, AGREEMENT_PAYMENT_DAYS, AGREEMENT_RECEIPT_DAYS, isScheduledPayment, namesCounterparty, paidExactly, scheduleFit } from '../../shared/agreements';
import type { Categoriser } from '../../shared/categorise';
import { categoriseInputOf } from '../categoriser';
import type { AgreementView } from '../../shared/api';
import { isWrapperAccount } from '../../shared/categorise';
import { addDays, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Agreement, Transaction } from '../../shared/schema';
import type { Store } from '../store';

/** What a row says about who was paid: its description, with the merchant or payer its source gives. */
export const paidToText = (t: Pick<Transaction, 'description' | 'merchant' | 'counterpartyName'>) => `${t.merchant?.name ?? t.counterpartyName ?? ''} ${t.description}`;

/**
 * The rows that may be an agreement's payments:
 * - money paid to you: money in to your everyday accounts other than the one that lends it;
 * - money a loan pays for you: money out of that loan's account;
 * - otherwise: money out of your everyday accounts (not an investment or pension) naming its counterparty.
 */
export function paymentsTo(store: Store, a: Agreement): Transaction[] {
  // Paid for you by someone else, outside your accounts: its document says how it went.
  if (a.paidBy && !a.accountId && a.direction !== 'in') return [];
  const pattern = agreementPattern(a);
  const wrapper = new Set(store.accounts.filter((x) => isWrapperAccount(x.type)).map((x) => x.id));
  const fits = (t: Transaction) =>
    a.direction === 'in'
      ? // Money in, not money moved between two everyday accounts of yours (the same sum sent on).
        t.amount > 0 && !wrapper.has(t.accountId) && t.accountId !== a.accountId && !(t.transferGroup && t.counterpartyAccountId !== a.accountId)
      : a.accountId
        ? t.amount < 0 && t.accountId === a.accountId
        : t.amount < 0 && !wrapper.has(t.accountId) && namesCounterparty(pattern, paidToText(t));
  return store
    .transactions()
    .filter(fits)
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
  const options: { ai: number; id: string; i: number; t: Transaction; exact: boolean; named: boolean; days: number; off: number }[] = [];
  agreements.forEach((a, ai) => {
    const pattern = agreementPattern(a);
    a.payments.forEach((p, i) => {
      for (const t of paid.get(a.id)!) {
        const fit = scheduleFit(a, p, t.date, Math.abs(t.amount));
        if (fit) options.push({ ai, id: a.id, i, t, exact: fit.off === 0, named: namesCounterparty(pattern, paidToText(t)), ...fit });
      }
    });
  });
  // Exactly what was due first, then one that names who it is with, then the fewest days apart.
  options.sort((x, y) => Number(y.exact) - Number(x.exact) || Number(y.named) - Number(x.named) || x.days - y.days || x.off - y.off || x.ai - y.ai || x.i - y.i || x.t.id.localeCompare(y.t.id));
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
  // A payment made to the penny (money paid to you, or by a loan for you) comes within days of its date.
  const window = paidExactly(a) ? AGREEMENT_RECEIPT_DAYS : AGREEMENT_PAYMENT_DAYS;
  const payments: AgreementView['payments'] = a.payments.map((p, i) => {
    const t = found.get(i);
    // None found: what its document said, when it said it was paid or cancelled; else by its date.
    const status: AgreementView['payments'][number]['status'] = t
      ? 'paid'
      : p.status === 'cancelled'
        ? 'cancelled'
        : p.status === 'paid'
          ? 'documented'
          : p.due > now
            ? 'upcoming'
            : addDays(p.due, window) >= now
              ? 'due'
              : 'unseen';
    const difference = t ? toMinor(Math.abs(t.amount)) - toMinor(p.amount) : 0;
    return { due: p.due, amount: p.amount, ...(p.label ? { label: p.label } : {}), status, ...(t ? { paid: { transactionId: t.id, accountId: t.accountId, date: t.date, amount: Math.abs(t.amount), ...(difference ? { difference: fromMinor(difference) } : {}) } } : {}) };
  });

  // Other payments to it in its category that no agreement pairs with: from when it was agreed (its
  // start, if that is not known) to 45 days after it ends, as a charge after a let comes. Not for
  // one known only by its exact amounts: any other money in is not its.
  const dues = a.payments.map((p) => p.due).sort();
  const start = [a.agreedOn ?? a.from, dues[0]!].sort()[0]!;
  const end = addDays([a.until ?? a.from, dues.at(-1)!].sort().at(-1)!, AGREEMENT_PAYMENT_DAYS);
  const others = paidExactly(a)
    ? []
    : paid
        .get(a.id)!
        .filter((t) => !used.has(t.id) && t.category === a.category && t.date >= start && t.date <= end)
        .map((t) => ({ transactionId: t.id, accountId: t.accountId, date: t.date, amount: -t.amount }));

  const total = [...payments.flatMap((p) => (p.paid ? [p.paid.amount] : [])), ...others.map((o) => o.amount)].reduce((x, n) => x + toMinor(n), 0);
  return { agreement: a, payments, others, paid: fromMinor(total) };
}

/**
 * The payments recorded already that an agreement schedules, each with the patch that files it now
 * the agreement is recorded (FORMULAS §10, "Filing"): as `categoriser` (one that knows the agreement)
 * files those to come, except one you, a rule of yours or a transfer link categorised. Money paid to
 * you through a loan names the loan as its other side.
 */
export function scheduledPatches(store: Store, agreement: Agreement, categoriser: Categoriser): { t: Transaction; patch: Partial<Transaction> }[] {
  const pattern = agreementPattern(agreement);
  const out: { t: Transaction; patch: Partial<Transaction> }[] = [];
  for (const t of store.transactions()) {
    if (t.transferGroup || t.categorisedBy === 'user' || t.categorisedBy === 'rule' || t.categorisedBy === 'transfer') continue;
    const account = store.account(t.accountId);
    if (!account || isWrapperAccount(account.type)) continue;
    if (!isScheduledPayment(agreement, pattern, { date: t.date, amount: t.amount, text: paidToText(t), accountId: t.accountId })) continue;
    const res = categoriser.categorise(categoriseInputOf(t));
    if (res.categorisedBy !== 'agreement' || res.category !== agreement.category) continue;
    if (t.category === agreement.category && t.categorisedBy === 'agreement' && (!res.counterpartyAccountId || res.counterpartyAccountId === t.counterpartyAccountId)) continue;
    out.push({
      t,
      patch: {
        category: agreement.category,
        categorisedBy: 'agreement',
        ruleId: undefined,
        ...(t.payeeSetBy !== 'user' && res.payee !== t.payee ? { payee: res.payee } : {}),
        ...(res.counterpartyAccountId ? { counterpartyAccountId: res.counterpartyAccountId } : {}),
      },
    });
  }
  return out;
}
