// Turn whatever an engine produced into a valid Extraction: round money to pence, repair dates,
// drop rows that cannot be salvaged (with a note), and fill defaults.

import { isISODate, parseFlexibleDate } from '../../shared/dates';
import { parseAmount, roundMoney } from '../../shared/money';
import { ExtractionSchema, type Extraction } from '../../shared/schema';
import { formatZodError } from '../store';

const MONEY_KEYS = new Set([
  'amount',
  'balanceAfter',
  'originalAmount',
  'fee',
  'value',
  'openingBalance',
  'closingBalance',
  'availableBalance',
  'creditLimit',
  'contributionsToDate',
  'gainLoss',
  'governmentBonusToDate',
  'taxYearContributions',
  'cashBalance',
  'annualIncome',
  'costBasis',
  'gain',
  'statedMoneyIn',
  'statedMoneyOut',
  // A timesheet's day or hourly rate.
  'rate',
]);
const DATE_KEYS = new Set(['date', 'transactionDate', 'periodStart', 'periodEnd', 'balanceDate', 'documentDate']);

function fixValue(key: string, v: unknown): unknown {
  if (MONEY_KEYS.has(key)) {
    if (typeof v === 'string') return parseAmount(v);
    if (typeof v === 'number') return Number.isFinite(v) ? roundMoney(v) : null;
    return v;
  }
  if (DATE_KEYS.has(key) && typeof v === 'string') {
    if (isISODate(v)) return v;
    return parseFlexibleDate(v) ?? null;
  }
  if ((key === 'currency' || key === 'originalCurrency') && typeof v === 'string') {
    const c = v.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : c === '£' ? 'GBP' : null;
  }
  if ((key === 'last4' || key === 'cardLast4' || key === 'accountLast4') && typeof v === 'string') {
    // The number's own last characters: "••••4471" is 4471, but an account number that ends in
    // letters ("QK7WM3P") has no last four digits, and its scattered digits must not stand in.
    const chars = v.replace(/[^0-9A-Za-z]/g, '');
    const tail = /(\d+)$/.exec(chars)?.[1] ?? '';
    return tail.length >= 2 ? tail.slice(-4) : null;
  }
  return v;
}

function walk(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(fixValue(k, v), k);
    return out;
  }
  return value;
}

export function normaliseExtraction(raw: unknown): { extraction: Extraction; warnings: string[] } {
  const warnings: string[] = [];
  const fixed = walk(raw) as Record<string, unknown>;
  // Drop transactions / holdings that lost a required value in repair.
  const accounts = Array.isArray(fixed.accounts) ? (fixed.accounts as Record<string, unknown>[]) : [];
  for (const [ai, acc] of accounts.entries()) {
    if (Array.isArray(acc.transactions)) {
      const before = acc.transactions.length;
      acc.transactions = (acc.transactions as Record<string, unknown>[]).filter(
        (t) => typeof t.date === 'string' && typeof t.amount === 'number' && typeof t.description === 'string',
      );
      const dropped = before - (acc.transactions as unknown[]).length;
      if (dropped) warnings.push(`Account ${ai + 1}: ${dropped} transaction row(s) had an unreadable date or amount and were dropped.`);
    }
    // Apps and many statements list newest first; store chronologically (stable within a day).
    const list = acc.transactions as { date: string }[] | undefined;
    if (Array.isArray(list) && list.length > 1 && list[0]!.date > list[list.length - 1]!.date) list.reverse();
    if (Array.isArray(acc.holdings)) {
      acc.holdings = (acc.holdings as Record<string, unknown>[]).filter((h) => typeof h.value === 'number' && typeof h.name === 'string');
    }
  }
  if (Array.isArray(fixed.figures)) {
    fixed.figures = (fixed.figures as Record<string, unknown>[]).filter((f) => typeof f.amount === 'number' && typeof f.kind === 'string');
  }
  const parsed = ExtractionSchema.safeParse(fixed);
  if (!parsed.success) throw new Error(`Extraction did not match the expected shape: ${formatZodError(parsed.error)}`);
  return { extraction: parsed.data, warnings };
}
