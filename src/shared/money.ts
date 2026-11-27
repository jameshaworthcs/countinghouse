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
 * round(a × b ÷ c) for integers, exactly (in BigInt, so no product loses precision), half away from
 * zero as `toMinor` rounds: 5 × 1 ÷ 2 is 3 and −5 × 1 ÷ 2 is −3. `c` must not be 0.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c) || c === 0) throw new RangeError(`mulDivRound takes safe integers and a divisor that is not 0 (${a}, ${b}, ${c})`);
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const negative = n < 0n !== d < 0n;
  const [an, ad] = [n < 0n ? -n : n, d < 0n ? -d : d];
  const q = an / ad;
  const r = an - q * ad;
  const rounded = 2n * r >= ad ? q + 1n : q;
  const out = Number(negative ? -rounded : rounded);
  return Object.is(out, -0) ? 0 : out;
}

/**
 * Integer pence split by weights, with cumulative rounding (docs/FORMULAS.md §22, "Apportioning"):
 * part i = round(total × W_i ÷ W) − round(total × W_{i−1} ÷ W), where W_i is the sum of the first i
 * weights and W of them all, rounded half away from zero (`mulDivRound`). The parts always add up to
 * the total exactly, a part with a weight of 0 is 0, and no part is more than a penny from its exact
 * share. Weights are non-negative integers (days, months), at least one of them more than 0.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new RangeError(`apportion splits integer pence (${total})`);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError('apportion takes weights that are non-negative integers');
  const whole = weights.reduce((s, w) => s + w, 0);
  if (whole <= 0 || !Number.isSafeInteger(whole)) throw new RangeError('apportion takes at least one weight more than 0');
  const out: number[] = [];
  let cumulative = 0;
  let before = 0;
  for (const w of weights) {
    cumulative += w;
    const upTo = mulDivRound(total, cumulative, whole);
    out.push(upTo - before);
    before = upTo;
  }
  return out;
}

/** Integer pence to the nearest whole pound, half away from zero (a filing's figures): 150 is 2, −250 is −3. */
export const roundToPounds = (minor: number): number => mulDivRound(minor, 1, 100);

/** Integer pence in whole pounds with the pence left out (towards nothing, never rounded up): 199 is 1, −199 is −1. A VAT return's boxes 6–9. */
export const poundsWithoutPence = (minor: number): number => Math.trunc(minor / 100) || 0;

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
