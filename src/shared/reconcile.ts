// Statement reconciliation: does opening balance + transactions = closing balance, and do running
// balances follow the amounts? Used on drafts (before commit) and in data-health checks.

import { fromMinor, toMinor } from './money';

export interface ReconcileInput {
  openingBalance?: number | undefined;
  closingBalance?: number | undefined;
  transactions: { amount: number; balanceAfter?: number | undefined; date: string }[];
}

export interface ReconcileResult {
  /** "ok" when the checks that could run all passed; "unknown" when no check could run. */
  status: 'ok' | 'mismatch' | 'unknown';
  /** opening + Σ amounts, when an opening balance is known. */
  expectedClosing?: number;
  difference?: number;
  /** Rows (by index) whose running balance disagrees with the previous row + amount. */
  runningBreaks: number[];
  checks: string[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const checks: string[] = [];
  const runningBreaks: number[] = [];
  let status: ReconcileResult['status'] = 'unknown';
  const result: ReconcileResult = { status, runningBreaks, checks };

  const sum = input.transactions.reduce((s, t) => s + toMinor(t.amount), 0);
  if (input.openingBalance !== undefined && input.closingBalance !== undefined && input.transactions.length > 0) {
    const expected = toMinor(input.openingBalance) + sum;
    result.expectedClosing = fromMinor(expected);
    result.difference = fromMinor(toMinor(input.closingBalance) - expected);
    if (expected === toMinor(input.closingBalance)) {
      checks.push('Opening balance plus transactions equals the closing balance.');
      status = 'ok';
    } else {
      checks.push(`Opening balance plus transactions is ${fromMinor(expected).toFixed(2)}, but the closing balance is ${input.closingBalance.toFixed(2)}.`);
      status = 'mismatch';
    }
  }

  let prev: { minor: number } | null = null;
  let checked = 0;
  input.transactions.forEach((t, i) => {
    if (t.balanceAfter === undefined) {
      prev = null;
      return;
    }
    const bal = toMinor(t.balanceAfter);
    if (prev) {
      checked++;
      if (prev.minor + toMinor(t.amount) !== bal) runningBreaks.push(i);
    }
    prev = { minor: bal };
  });
  if (checked > 0) {
    if (runningBreaks.length === 0) {
      checks.push(`Running balances agree on all ${checked + 1} rows.`);
      if (status === 'unknown') status = 'ok';
    } else {
      checks.push(`${runningBreaks.length} row(s) break the running balance (missing rows, wrong signs, or same-day ordering).`);
      status = 'mismatch';
    }
  }
  result.status = status;
  return result;
}
