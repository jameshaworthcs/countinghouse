// Splitting a payment across categories: the lines a receipt suggests (shared by the server and the
// review in the transaction drawer).

import { fromMinor, toMinor } from './money';
import type { Receipt, Transaction } from './schema';

/**
 * Split lines proposed from a receipt's reading: its lines added up by category (a line with none
 * goes to the transaction's own), and what the receipt does not account for (a tip, cashback) stays
 * with the transaction's category too, so the lines always add up to the payment.
 */
export function proposedSplit(t: Pick<Transaction, 'amount' | 'category'>, reading: NonNullable<Receipt['reading']>): { category: string; amount: number }[] {
  const own = t.category ?? (t.amount < 0 ? 'other-expense' : 'other-income');
  const byCategory = new Map<string, number>();
  for (const l of reading.lines) {
    const c = l.category ?? own;
    byCategory.set(c, (byCategory.get(c) ?? 0) + toMinor(l.amount));
  }
  const rest = toMinor(t.amount) - [...byCategory.values()].reduce((s, v) => s + v, 0);
  if (rest !== 0) byCategory.set(own, (byCategory.get(own) ?? 0) + rest);
  return [...byCategory.entries()].filter(([, v]) => v !== 0).map(([category, v]) => ({ category, amount: fromMinor(v) }));
}
