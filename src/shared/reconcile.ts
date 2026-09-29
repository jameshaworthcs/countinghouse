// Statement reconciliation: does opening balance + transactions = closing balance, and do running
// balances follow the amounts? Used on drafts (before commit) and in data-health checks. Pending
// rows are left out: statement and export balances are of settled transactions.

import { fromMinor, toMinor } from './money';

export interface ReconcileInput {
  openingBalance?: number | undefined;
  closingBalance?: number | undefined;
  transactions: { amount: number; balanceAfter?: number | undefined; date: string; pending?: boolean | undefined }[];
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
  input = { ...input, transactions: input.transactions.filter((t) => !t.pending) };
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

  // Statements list rows oldest first; apps usually newest first. Running balances are checked in
  // whichever order they fit, so a correct newest-first screen is not reported as broken.
  const walk = (order: number[]) => {
    const breaks: number[] = [];
    let prev: { minor: number } | null = null;
    let n = 0;
    for (const i of order) {
      const t = input.transactions[i]!;
      if (t.balanceAfter === undefined) {
        prev = null;
        continue;
      }
      const bal = toMinor(t.balanceAfter);
      if (prev) {
        n++;
        if (prev.minor + toMinor(t.amount) !== bal) breaks.push(i);
      }
      prev = { minor: bal };
    }
    return { breaks, n };
  };
  const forward = input.transactions.map((_, i) => i);
  const asPrinted = walk(forward);
  const reversed = asPrinted.breaks.length ? walk([...forward].reverse()) : asPrinted;
  const best = reversed.breaks.length < asPrinted.breaks.length ? reversed : asPrinted;
  const checked = best.n;
  runningBreaks.push(...best.breaks.sort((a, b) => a - b));
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
