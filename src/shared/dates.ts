// Calendar-date helpers. Dates are ISO "YYYY-MM-DD" strings everywhere: they sort lexically, diff
// cleanly in git and have no timezone. Arithmetic goes through UTC so DST never shifts a day.

export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function toUTC(date: ISODate): Date {
  const m = ISO_RE.exec(date);
  if (!m) throw new Error(`Invalid ISO date: ${date}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
}

export function fromUTC(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Build an ISO date from parts (month 1-12). Returns null when the date does not exist. */
export function makeDate(year: number, month: number, day: number): ISODate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return fromUTC(d);
}

/** Today's date in the machine's local timezone (the app runs on your computer, in the UK). */
export function today(now: Date = new Date()): ISODate {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Local calendar date of a timestamp. */
export function dateOf(timestamp: Date | number | string): ISODate {
  return today(new Date(timestamp));
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}

/** Add calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: ISODate, months: number): ISODate {
  const d = toUTC(date);
  const targetMonth = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUTC(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))));
}

export function addYears(date: ISODate, years: number): ISODate {
  return addMonths(date, years * 12);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

export function minDate(...dates: (ISODate | undefined | null)[]): ISODate | undefined {
  let out: ISODate | undefined;
  for (const d of dates) if (d && (!out || d < out)) out = d;
  return out;
}

export function maxDate(...dates: (ISODate | undefined | null)[]): ISODate | undefined {
  let out: ISODate | undefined;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
}

/** "2026-09" */
export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

export function startOfMonth(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: ISODate): ISODate {
  const d = toUTC(startOfMonth(date));
  return fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function startOfYear(date: ISODate): ISODate {
  return `${date.slice(0, 4)}-01-01`;
}

/** Every month key from the month of `from` to the month of `to`, inclusive. */
export function eachMonth(from: ISODate, to: ISODate): string[] {
  const out: string[] = [];
  let cur = startOfMonth(from);
  const end = startOfMonth(to);
  while (cur <= end) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

/** Every date from `from` to `to` inclusive, stepping `stepDays`. Always includes `to`. */
export function eachDay(from: ISODate, to: ISODate, stepDays = 1): ISODate[] {
  const out: ISODate[] = [];
  let cur = from;
  while (cur < to) {
    out.push(cur);
    cur = addDays(cur, stepDays);
  }
  out.push(to);
  return out;
}

/** Day of week, 0 = Sunday. */
export function weekday(date: ISODate): number {
  return toUTC(date).getUTCDay();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};

export type DateOrder = 'DMY' | 'MDY' | 'YMD' | 'auto';

function expandYear(y: number, pivotYear?: number): number {
  if (y >= 100) return y;
  // Two-digit years: pick the century that lands closest to the pivot (default: this year).
  const pivot = pivotYear ?? new Date().getFullYear();
  const century = Math.floor(pivot / 100) * 100;
  const candidates = [century - 100 + y, century + y, century + 100 + y];
  return candidates.reduce((best, c) => (Math.abs(c - pivot) < Math.abs(best - pivot) ? c : best));
}

/**
 * Parse the date formats UK banks and apps actually use. Day-first by default: "03/04/2026" is
 * 3 April, never 4 March, unless `order` says otherwise.
 *
 * Handles: 2026-09-26, 2026-09-26T14:30:00Z, 2026-09-26 14:30:00, 20260926 (OFX), 26/09/2026,
 * 26/09/26, 26-09-2026, 26.09.2026, 26 Sep 2026, 26-Sep-26, 26 September 2026, Sep 26, 2026,
 * "Fri 26 Sep 2026", "26th September 2026". Returns null if nothing sensible is found.
 */
export function parseFlexibleDate(
  input: string | null | undefined,
  order: DateOrder = 'auto',
  opts: { pivotYear?: number; defaultYear?: number } = {},
): ISODate | null {
  if (!input) return null;
  let s = input.trim().replace(/\u00a0/g, ' ');
  if (!s) return null;

  // ISO-ish: 2026-09-26, optionally with a time part.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return makeDate(+m[1]!, +m[2]!, +m[3]!);

  // Compact: 20260926 (OFX, optionally followed by time and timezone).
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6}(?:\.\d+)?(?:\[.*\])?)?$/.exec(s);
  if (m) return makeDate(+m[1]!, +m[2]!, +m[3]!);

  // Strip weekday names and ordinal suffixes: "Fri 26th Sep 2026" -> "26 Sep 2026".
  s = s
    .replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+/i, '')
    .replace(/(\d{1,2})(st|nd|rd|th)\b/i, '$1')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Numeric with separators: 26/09/2026, 26-09-26, 26.09.2026, 2026/09/26.
  m = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:\s.*)?$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const c = +m[3]!;
    if (m[1]!.length === 4) return makeDate(a, b, c); // Y/M/D
    const year = expandYear(c, opts.pivotYear);
    if (order === 'MDY') return makeDate(year, a, b);
    if (order === 'YMD') return makeDate(expandYear(a, opts.pivotYear), b, c);
    // DMY (UK). In auto mode, if the first number can't be a day-of-month-with-this-month
    // combination but the swap can, accept the swap (e.g. 09/26/2026 from a US-format export).
    const dmy = makeDate(year, b, a);
    if (dmy) return dmy;
    return order === 'auto' ? makeDate(year, a, b) : null;
  }

  // Textual month: "26 Sep 2026", "26-Sep-26", "26 September 2026", "26 Sep" (needs defaultYear).
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3,9})\.?(?:[\s/-](\d{2,4}))?(?:\s.*)?$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    const year = m[3] ? expandYear(+m[3], opts.pivotYear) : opts.defaultYear;
    if (month && year) return makeDate(year, month, +m[1]!);
    return null;
  }

  // "Sep 26 2026" / "September 26 2026"
  m = /^([A-Za-z]{3,9})\.?\s(\d{1,2})(?:\s(\d{2,4}))?(?:\s.*)?$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const year = m[3] ? expandYear(+m[3], opts.pivotYear) : opts.defaultYear;
    if (month && year) return makeDate(year, month, +m[2]!);
    return null;
  }

  // "Sep 2026" -> first of month is not a real date; refuse rather than guess.
  return null;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26 Sep 2026" */
export function formatDate(date: ISODate, opts: { year?: boolean } = {}): string {
  const m = ISO_RE.exec(date);
  if (!m) return date;
  const base = `${+m[3]!} ${SHORT_MONTHS[+m[2]! - 1]}`;
  return opts.year === false ? base : `${base} ${m[1]}`;
}

/** A stretch of days: "13 Sep 2025", "6 Apr – 31 Dec 2024", "6 Apr 2024 – 29 Jan 2025". */
export function formatSpan(from: ISODate, to: ISODate): string {
  if (from === to) return formatDate(from);
  return `${formatDate(from, { year: from.slice(0, 4) !== to.slice(0, 4) })} – ${formatDate(to)}`;
}

/** "Sep 2026" from "2026-09" or a full date. */
export function formatMonth(monthOrDate: string, opts: { short?: boolean } = {}): string {
  const y = monthOrDate.slice(0, 4);
  const mo = +monthOrDate.slice(5, 7);
  const name = SHORT_MONTHS[mo - 1] ?? '?';
  return opts.short ? `${name} ${y.slice(2)}` : `${name} ${y}`;
}

/** Human "3 days ago" / "in 2 months" relative to today. */
export function relativeDays(date: ISODate, from: ISODate = today()): string {
  const d = diffDays(date, from);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d === -1) return 'tomorrow';
  const abs = Math.abs(d);
  let text: string;
  if (abs < 14) text = `${abs} days`;
  else if (abs < 60) text = `${Math.round(abs / 7)} weeks`;
  else if (abs < 730) text = `${Math.round(abs / 30.44)} months`;
  else text = `${(abs / 365.25).toFixed(1).replace(/\.0$/, '')} years`;
  return d > 0 ? `${text} ago` : `in ${text}`;
}
