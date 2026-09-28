// Money handling.
//
// On disk and over the API, money is a JSON number in MAJOR units (pounds) with at most 2 decimal
// places, e.g. -4.5 or 1234.56. That keeps the data readable by people, jq, DuckDB and LLMs alike.
// All arithmetic in this codebase happens in integer MINOR units (pence) via these helpers, so sums
// are exact; values are converted back to major units only at the edges.
//
// Sign convention everywhere: from the owner's point of view. Positive increases net worth (money
// in, an asset balance); negative decreases it (money out, a debt such as a credit-card balance).

/** Convert major units (e.g. 12.34) to integer minor units (1234). */
export function toMinor(amount: number): number {
  // Scale then round; the tiny epsilon nudges values like 1.005 that are stored as 1.00499999.
  return Math.round(amount * 100 + (amount >= 0 ? 1e-7 : -1e-7));
}

/** Convert integer minor units back to major units. Always yields at most 2 decimal places. */
export function fromMinor(minor: number): number {
  const v = minor / 100;
  return Object.is(v, -0) ? 0 : v;
}

/** Round an arbitrary number to a valid money value (2 dp). */
export function roundMoney(amount: number): number {
  return fromMinor(toMinor(amount));
}

/** Exact sum of money values. */
export function sumMoney(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += toMinor(v);
  return fromMinor(total);
}

/** Add two money values exactly. */
export function addMoney(a: number, b: number): number {
  return fromMinor(toMinor(a) + toMinor(b));
}

/** Subtract b from a exactly. */
export function subMoney(a: number, b: number): number {
  return fromMinor(toMinor(a) - toMinor(b));
}

/**
 * True when `amount` is a finite number with no more than 2 decimal places: exactly the double
 * that a 2-dp decimal parses to (what fromMinor produces and JSON.parse reads). An absolute
 * tolerance would wrongly reject large amounts, where doubles are further apart than it.
 */
export function isMoney(amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  return Math.round(amount * 100) / 100 === amount;
}

const AMOUNT_NOISE = /[£$€¥\s\u00a0\u202f']|GBP|USD|EUR/gi;

/**
 * Parse an amount as it appears in bank exports and statements. Handles currency symbols and codes,
 * thousands separators, unicode minus, trailing minus, parentheses for negatives and CR/DR markers.
 * Returns null when the text is not a number. CR means credit (positive), DR debit (negative).
 */
export function parseAmount(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? roundMoney(input) : null;
  let s = input.trim();
  if (s === '' || s === '-' || s === '—') return null;
  let negative = false;
  // Unicode minus / dashes used as minus signs.
  s = s.replace(/[−‒–—]/g, '-');
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const crdr = /\s*(CR|DR|Cr|Dr|cr|dr)\.?$/.exec(s);
  if (crdr) {
    if (crdr[1]!.toUpperCase() === 'DR') negative = !negative;
    s = s.slice(0, crdr.index);
  }
  s = s.replace(AMOUNT_NOISE, '');
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  // Thousands separators: "1,234.56". A lone comma followed by exactly 2 digits and no dot is a
  // European decimal ("12,34"), which UK exports never use for GBP, but be defensive.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return roundMoney(negative ? -value : value);
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, opts: { compact?: boolean; decimals?: number; sign?: boolean }): Intl.NumberFormat {
  const key = `${currency}|${opts.compact ? 1 : 0}|${opts.decimals ?? 'a'}|${opts.sign ? 1 : 0}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      notation: opts.compact ? 'compact' : 'standard',
      minimumFractionDigits: opts.decimals ?? (opts.compact ? 0 : 2),
      maximumFractionDigits: opts.decimals ?? (opts.compact ? 1 : 2),
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    });
    formatters.set(key, f);
  }
  return f;
}

export interface FormatMoneyOptions {
  currency?: string;
  /** "£12.3K" style for tiles and axes. */
  compact?: boolean;
  /** Fixed number of decimals (default 2, or up to 1 when compact). */
  decimals?: number;
  /** Always show the sign, e.g. deltas: "+£12.00". */
  sign?: boolean;
}

export function formatMoney(amount: number, options: FormatMoneyOptions = {}): string {
  const currency = options.currency ?? 'GBP';
  try {
    return formatter(currency, options).format(amount);
  } catch {
    // Unknown currency code: fall back to a plain number with the code.
    return `${amount.toFixed(options.decimals ?? 2)} ${currency}`;
  }
}

/** Percentage helper: 0.1234 -> "12.3%". */
export function formatPercent(ratio: number, decimals = 1, sign = false): string {
  if (!Number.isFinite(ratio)) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(ratio);
}
