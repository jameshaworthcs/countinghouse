// Checks shown while reviewing an import, before anything is saved: does what was read add up, and
// does it look like what such a document says? Pure, so the server's "ready to commit" follows the
// same rules as the review page (docs/FORMULAS.md §13).

import { formatDate } from './dates';
import { formatMoney, fromMinor, toMinor } from './money';
import { reconcile } from './reconcile';
import type { AccountType, DraftSection } from './schema';

export interface ReviewCheck {
  id: string;
  /** ok: passed. warn: look at it before committing. info: worth knowing. */
  status: 'ok' | 'warn' | 'info';
  title: string;
  detail?: string;
  /** Keys of the draft rows the check is about. */
  rows?: string[];
}

export interface CheckContext {
  /** The type of the account the rows go into, or were detected as. */
  accountType?: AccountType | undefined;
  /** The latest date a row can have: the day the document was uploaded. */
  latest: string;
  /** An export's period is its first and last rows, so checking rows against it proves nothing. */
  periodFromRows?: boolean;
}

/** Descriptions of a payment to a card, which is money in on the card's own statement. */
const PAYMENT_TO_CARD = /\b(payment received|thank you|direct debit (payment|received)|payment - thank|card payment received|dd payment)\b/i;

const rowsWord = (n: number) => (n === 1 ? '1 row' : `${n} rows`);

export function sectionChecks(section: DraftSection, ctx: CheckContext): ReviewCheck[] {
  const out: ReviewCheck[] = [];
  const rows = section.transactions;
  // Statements and exports total their settled rows; pending ones are shown separately.
  const settled = rows.filter((t) => !t.pending);

  // Opening balance + rows = closing balance, and running balances follow the amounts. On an
  // investment account's activity list they are the cash, so the closing cash is what they reach.
  const closing = section.cashLedger ? section.cash : section.balance;
  const r = reconcile({ openingBalance: section.openingBalance, closingBalance: closing, transactions: settled });
  if (section.cashLedger) {
    out.push({
      id: 'cash-ledger',
      status: 'info',
      title: 'The balances here are the account’s cash',
      detail: `On an investment account’s activity list the running balance is the uninvested cash${section.cash !== undefined ? ` (${formatMoney(section.cash)} at the end)` : ''}, not what the account is worth. The rows are recorded; the account’s value comes from a screen or statement that shows its total.`,
    });
  }
  if (r.status !== 'unknown') {
    out.push({
      id: 'reconcile',
      status: r.status === 'ok' ? 'ok' : 'warn',
      title: r.status === 'ok' ? (section.cashLedger ? 'The cash balances add up' : 'Balances add up') : section.cashLedger ? 'The cash balances don’t add up' : 'Balances don’t add up',
      detail: `${r.checks.join(' ')}${r.status === 'mismatch' ? ' Look for a missing row or a wrong sign against the original.' : ''}`,
      ...(r.runningBreaks.length ? { rows: r.runningBreaks.map((i) => settled[i]!.key) } : {}),
    });
  }

  // The totals printed on the statement ("money in", "money out").
  if (section.statedTotals && settled.length) {
    const inMinor = settled.reduce((s, t) => s + Math.max(0, toMinor(t.amount)), 0);
    const outMinor = settled.reduce((s, t) => s + Math.max(0, -toMinor(t.amount)), 0);
    const parts: { label: string; read: number; stated: number }[] = [];
    if (section.statedTotals.moneyIn !== undefined) parts.push({ label: 'Money in', read: inMinor, stated: toMinor(section.statedTotals.moneyIn) });
    if (section.statedTotals.moneyOut !== undefined) parts.push({ label: 'Money out', read: outMinor, stated: toMinor(Math.abs(section.statedTotals.moneyOut)) });
    const wrong = parts.filter((p) => p.read !== p.stated);
    if (parts.length) {
      out.push({
        id: 'totals',
        status: wrong.length ? 'warn' : 'ok',
        title: wrong.length ? 'The rows don’t match the statement’s totals' : 'The rows match the statement’s totals',
        detail: parts.map((p) => `${p.label}: ${formatMoney(fromMinor(p.read))} read${p.read === p.stated ? '' : `, ${formatMoney(fromMinor(p.stated))} on the statement`}.`).join(' '),
      });
    }
  }

  // Holdings, with any uninvested cash, add up to the value shown. Rounding in what is displayed
  // is allowed for: £1 or 0.1% of the value, whichever is more.
  if (section.holdings.length && section.balance !== undefined && section.holdings.every((h) => !h.currency || h.currency === section.currency)) {
    const held = section.holdings.reduce((s, h) => s + toMinor(h.value), 0) + toMinor(section.cash ?? 0);
    const value = toMinor(section.balance);
    const tolerance = Math.max(100, Math.round(Math.abs(value) * 0.001));
    out.push(
      Math.abs(value - held) <= tolerance
        ? { id: 'holdings', status: 'ok', title: 'The holdings add up to the value' }
        : held < value && section.holdingsPartial
          ? {
              id: 'holdings',
              status: 'info',
              title: 'Part of the holdings list',
              detail: `The holdings${section.cash !== undefined ? ' and cash' : ''} shown come to ${formatMoney(fromMinor(held))} of the ${formatMoney(section.balance)} value: the screen lists only some of them. They join the other holdings recorded for this account on the same day, so screenshots of the rest of the list complete it.`,
            }
          : {
              id: 'holdings',
              status: 'warn',
              title: 'The holdings don’t add up to the value',
              detail: `The holdings${section.cash !== undefined ? ' and cash' : ''} come to ${formatMoney(fromMinor(held))}; the value shown is ${formatMoney(section.balance)}. ${held > value ? 'That is more than the account is worth, so a value is probably misread.' : 'A holding may be missing or misread, or the screen may list only some of them.'}`,
            },
    );
  } else if (section.holdings.length && section.holdingsPartial) {
    out.push({
      id: 'holdings',
      status: 'info',
      title: section.holdings.length === 1 ? 'One holding, without the account’s total' : 'Holdings, without the account’s total',
      detail: 'This screen does not show what the whole account is worth. The holdings join the others recorded for this account on the same day; the value comes from a screen that shows the total.',
    });
  }

  // Rows dated outside the period the statement says it covers: usually a misread year.
  if (section.periodStart && section.periodEnd && rows.length && !ctx.periodFromRows) {
    const outside = rows.filter((t) => t.date < section.periodStart! || t.date > section.periodEnd!);
    out.push(
      outside.length
        ? { id: 'period', status: 'warn', title: `${rowsWord(outside.length)} dated outside the statement period`, detail: `The statement covers ${formatDate(section.periodStart)} to ${formatDate(section.periodEnd)}. Check the dates, especially the year.`, rows: outside.map((t) => t.key) }
        : { id: 'period', status: 'ok', title: 'Every row is within the statement period' },
    );
  }

  const future = rows.filter((t) => t.date > ctx.latest);
  if (future.length) {
    out.push({ id: 'future', status: 'warn', title: `${rowsWord(future.length)} dated after the upload day`, detail: 'A row cannot be later than the day the document was uploaded. Check the dates, especially the year.', rows: future.map((t) => t.key) });
  }

  // Credit cards: purchases are money out (negative), payments to the card money in.
  if (ctx.accountType === 'credit_card' && settled.length >= 3) {
    const positive = settled.filter((t) => t.amount > 0).length;
    const paymentsAsSpending = settled.filter((t) => t.amount < 0 && PAYMENT_TO_CARD.test(t.description));
    if (positive > settled.length - positive) {
      out.push({ id: 'card-signs', status: 'warn', title: 'Most rows are money in, which is unusual for a card', detail: 'On a credit card, purchases should be negative and payments to the card positive. The signs may be the wrong way round: check against the statement.' });
    } else if (paymentsAsSpending.length) {
      out.push({ id: 'card-signs', status: 'warn', title: `${rowsWord(paymentsAsSpending.length)} look like payments to the card but are money out`, detail: 'A payment to the card reduces what you owe, so it should be positive.', rows: paymentsAsSpending.map((t) => t.key) });
    } else {
      out.push({ id: 'card-signs', status: 'ok', title: 'Signs look right for a credit card' });
    }
  }

  // The same row twice: genuine (two identical coffees) or read twice where screenshots overlap.
  const seen = new Map<string, string[]>();
  for (const t of rows) {
    const k = `${t.date}|${toMinor(t.amount)}|${t.description.trim().toLowerCase()}`;
    (seen.get(k) ?? seen.set(k, []).get(k)!).push(t.key);
  }
  const repeated = [...seen.values()].filter((keys) => keys.length > 1).flat();
  if (repeated.length) {
    out.push({ id: 'repeated', status: 'info', title: `${rowsWord(repeated.length)} appear more than once`, detail: 'They may be genuine, or one row read twice where the parts of a long screenshot overlap. Check each against the original.', rows: repeated });
  }

  const unsure = rows.filter((t) => t.uncertain);
  if (unsure.length) {
    out.push({ id: 'uncertain', status: 'warn', title: `${rowsWord(unsure.length)} the reader was unsure of`, detail: unsure.map((t) => `${formatDate(t.date)} ${t.description}: ${t.uncertain}`).join('; '), rows: unsure.map((t) => t.key) });
  }

  const pending = rows.filter((t) => t.pending);
  if (pending.length) {
    out.push({ id: 'pending', status: 'info', title: `${rowsWord(pending.length)} still pending`, detail: 'Pending rows are left out unless you tick them: the settled row arrives with a later statement or export, sometimes with a different amount.', rows: pending.map((t) => t.key) });
  }
  return out;
}
