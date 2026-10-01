// Agreements (agreements.json): which of your payments one schedules. The categoriser files them under
// its category with this, and its card checks its schedule against them (FORMULAS.md §10, "Agreements").

import { diffDays } from './dates';
import { normaliseDescription } from './merchants';
import { toMinor } from './money';
import type { Agreement } from './schema';

/** Days either side of a payment's due date that it may be paid. */
export const AGREEMENT_PAYMENT_DAYS = 45;
/** How far a payment may differ from what is due, as a share of it, and still be that payment. */
export const AGREEMENT_PAYMENT_TOLERANCE = 0.1;

/** Its names as one pattern, each a whole word or words: the counterparty's, and the others its payments carry. */
export function agreementPattern(a: Pick<Agreement, 'counterparty' | 'names'>): RegExp {
  const names = [...new Set([a.counterparty, ...a.names].map(normaliseDescription).filter((n) => n.length >= 3))];
  const words = names.map((n) => n.split(' ').map(escapeRegex).join('\\s+'));
  return new RegExp(`(?:^|[^A-Z0-9])(?:${words.join('|')})(?:[^A-Z0-9]|$)`);
}

/** Does a row's text name the agreement's counterparty? `text`: its description, with the merchant or payer the source gives. */
export function namesCounterparty(pattern: RegExp, text: string): boolean {
  return pattern.test(normaliseDescription(text));
}

/**
 * How far a payment is from one the schedule says is due, or null when it cannot be that one: it is
 * too far from the due date or the amount, or it was made before the agreement was.
 */
export function scheduleFit(a: Pick<Agreement, 'agreedOn'>, due: Agreement['payments'][number], date: string, paid: number): { days: number; off: number } | null {
  if (a.agreedOn && date < a.agreedOn) return null;
  const days = Math.abs(diffDays(due.due, date));
  if (days > AGREEMENT_PAYMENT_DAYS) return null;
  const off = Math.abs(toMinor(paid) - toMinor(due.amount));
  if (off > toMinor(due.amount) * AGREEMENT_PAYMENT_TOLERANCE) return null;
  return { days, off };
}

/**
 * Is a row one of the agreement's scheduled payments: money out naming its counterparty, made once
 * it was agreed, within 45 days of a payment's due date, for that payment's amount or within a tenth
 * of it?
 */
export function isScheduledPayment(a: Agreement, pattern: RegExp, t: { date: string; amount: number; text: string }): boolean {
  if (t.amount >= 0 || !namesCounterparty(pattern, t.text)) return false;
  return a.payments.some((p) => scheduleFit(a, p, t.date, -t.amount) !== null);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
