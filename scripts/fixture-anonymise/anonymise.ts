// Turn a document a real import failed on into a synthetic fixture: dates moved, amounts scaled,
// identifiers, emails and postcodes replaced, and names and places swapped for invented words. A
// regression test then needs none of the real rows (CONTRIBUTING.md, "Real imports, synthetic
// fixtures"). The CLI is scripts/fixture-anonymise.ts.

export interface AnonymiseOptions {
  seed: number;
  /** Days to move every date by: a whole number of weeks keeps each date's weekday. */
  shiftDays: number;
  /** One factor for every amount, so sums and running balances still agree (to a penny or two). */
  scale: number;
  /** Lower-case words kept as they are: the file's column headers, say. */
  keep?: ReadonlySet<string>;
  /** Lower-case words always replaced: the denylist's. */
  deny?: ReadonlySet<string>;
  /** Lower-case words that are generic or public (bank wording, chains, providers). */
  generic: ReadonlySet<string>;
  /** Common lower-case words (a dictionary): kept unless denied. */
  dictionary?: ReadonlySet<string>;
  /** Given names: replaced even when the dictionary has them ("Grace", "Mark"). */
  given?: ReadonlySet<string>;
}

export interface AnonymiseResult {
  text: string;
  counts: { dates: number; amounts: number; numbers: number; words: number; emails: number; postcodes: number };
}

/** mulberry32: a small seeded generator, so a seed gives the same fixture again. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
/** Words that are never anyone's: months, days and their short forms, currencies, time zones, countries. */
const ALWAYS_KEEP = new Set([
  ...MONTHS,
  ...MONTHS.map((m) => m.slice(0, 3)),
  'sept',
  ...DAYS,
  ...DAYS.map((d) => d.slice(0, 3)),
  ...'gbp eur usd gmt utc bst gbr usa fra deu irl esp ita nld bel prt che aut swe nor dnk pol can aus'.split(' '),
]);

const CONSONANTS = 'bcdfghjklmnprstvwz';
const VOWELS = 'aeiou';

/** An invented word about as long as `word`, the same one for the same word and seed. */
function pseudonym(word: string, seed: number): string {
  const rand = prng(hash(`${seed}:${word.toLowerCase()}`));
  const pick = (s: string) => s[Math.floor(rand() * s.length)]!;
  let out = '';
  for (let i = 0; i < Math.max(4, word.length); i++) out += i % 2 ? pick(VOWELS) : pick(CONSONANTS);
  if (word === word.toUpperCase()) return out.toUpperCase();
  if (word[0] === word[0]!.toUpperCase()) return out[0]!.toUpperCase() + out.slice(1);
  return out;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** A calendar date moved by `days` (UTC arithmetic on a date with no time zone). */
function shift(y: number, m: number, d: number, days: number): [number, number, number] | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return undefined;
  t.setUTCDate(t.getUTCDate() + days);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

const POSTCODE_EXAMPLES = ['M1 1AE', 'B33 8TH', 'W1A 0AX', 'CR2 6XH', 'DN55 1PT', 'EC1A 1BB'];

// One pass over the text. The order of the alternatives is the order of precedence.
const TOKEN = new RegExp(
  [
    /(?<markup><[^>\n]*>)/.source,
    /(?<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/.source,
    /(?<postcode>\b[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2}\b)/.source,
    /(?<iso>\b\d{4}-\d{2}-\d{2}\b)/.source,
    /(?<dmy>\b\d{1,2}(?<sep>[/.-])\d{1,2}\k<sep>(?:\d{4}|\d{2})\b)/.source,
    /(?<long>\b\d{1,2} +[A-Za-z]{3,9} +\d{4}\b)/.source,
    /(?<ofx>\b\d{8}(?:\d{6}(?:\.\d{3})?)?(?=[[<\s,"]|$))/.source,
    /(?<amount>(?<![\w.])-?[£$€]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\w]|\.\d))/.source,
    /(?<digits>\b\d{2}-\d{2}-\d{2}\b|(?<![\w.])\d{5,}(?![\w.]))/.source,
    /(?<word>[A-Za-z][A-Za-z']*)/.source,
  ].join('|'),
  'gm',
);

/** Anonymise a document's text. Everything that varies is decided by `opts`, so it can be repeated. */
export function anonymise(text: string, opts: AnonymiseOptions): AnonymiseResult {
  const counts = { dates: 0, amounts: 0, numbers: 0, words: 0, emails: 0, postcodes: 0 };
  const emails = new Map<string, string>();
  const postcodes = new Map<string, string>();
  const numbers = new Map<string, string>();
  const digitRand = prng(opts.seed ^ 0x5bd1e995);
  const randomDigits = (s: string) => s.replace(/\d/g, () => String(Math.floor(digitRand() * 10)));
  const replaceWord = (w: string) => {
    const lower = w.toLowerCase();
    if (w.length < 3 || ALWAYS_KEEP.has(lower) || opts.keep?.has(lower)) return w;
    if (!opts.deny?.has(lower)) {
      if (opts.generic.has(lower)) return w;
      if (opts.dictionary?.has(lower) && !opts.given?.has(lower)) return w;
    }
    counts.words++;
    return pseudonym(w, opts.seed);
  };

  const out = text.replace(TOKEN, (match: string, ...rest: unknown[]) => {
    const g = rest[rest.length - 1] as Record<string, string | undefined>;
    if (g.markup) return match;
    if (g.email) {
      counts.emails++;
      if (!emails.has(match.toLowerCase())) emails.set(match.toLowerCase(), `person${emails.size + 1}@example.com`);
      return emails.get(match.toLowerCase())!;
    }
    if (g.postcode) {
      counts.postcodes++;
      if (!postcodes.has(match)) postcodes.set(match, POSTCODE_EXAMPLES[postcodes.size % POSTCODE_EXAMPLES.length]!);
      return postcodes.get(match)!;
    }
    if (g.iso) {
      const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(match)!;
      const s = shift(+y!, +m!, +d!, opts.shiftDays);
      if (!s) return match;
      counts.dates++;
      return `${s[0]}-${pad(s[1])}-${pad(s[2])}`;
    }
    if (g.dmy) {
      const [, d, sep, m, y] = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(match)!;
      const year = y!.length === 2 ? 2000 + +y! : +y!;
      const s = shift(year, +m!, +d!, opts.shiftDays);
      // Not a date: a sort code (12-34-56), say, which is an identifier like any other.
      if (!s) {
        counts.numbers++;
        if (!numbers.has(match)) numbers.set(match, randomDigits(match));
        return numbers.get(match)!;
      }
      counts.dates++;
      const day = d!.length === 2 ? pad(s[2]) : String(s[2]);
      const month = m!.length === 2 ? pad(s[1]) : String(s[1]);
      return `${day}${sep}${month}${sep}${y!.length === 2 ? pad(s[0] % 100) : s[0]}`;
    }
    if (g.long) {
      const [, d, sp1, name, sp2, y] = /^(\d{1,2})( +)([A-Za-z]{3,9})( +)(\d{4})$/.exec(match)!;
      const mi = MONTHS.findIndex((mo) => mo === name!.toLowerCase() || mo.slice(0, 3) === name!.toLowerCase());
      const s = mi >= 0 ? shift(+y!, mi + 1, +d!, opts.shiftDays) : undefined;
      if (!s) return match.replace(/[A-Za-z]+/g, replaceWord);
      counts.dates++;
      const full = MONTHS[s[1] - 1]!;
      let mo = name!.length === 3 ? full.slice(0, 3) : full;
      mo = name === name!.toUpperCase() ? mo.toUpperCase() : name![0] === name![0]!.toUpperCase() ? mo[0]!.toUpperCase() + mo.slice(1) : mo;
      return `${d!.length === 2 ? pad(s[2]) : s[2]}${sp1}${mo}${sp2}${s[0]}`;
    }
    if (g.ofx) {
      const [, y, m, d, time] = /^(\d{4})(\d{2})(\d{2})(\d{6}(?:\.\d{3})?)?$/.exec(match)!;
      const s = shift(+y!, +m!, +d!, opts.shiftDays);
      if (!s) {
        counts.numbers++;
        return randomDigits(match);
      }
      counts.dates++;
      return `${s[0]}${pad(s[1])}${pad(s[2])}${time ?? ''}`;
    }
    if (g.amount) {
      const m = /^(-?)([£$€]?)([\d,]+)\.(\d{2})$/.exec(match)!;
      const pence = Number(m[3]!.replace(/,/g, '')) * 100 + Number(m[4]);
      const scaled = Math.round(pence * opts.scale);
      const pounds = Math.floor(scaled / 100);
      const whole = m[3]!.includes(',') ? pounds.toLocaleString('en-GB') : String(pounds);
      counts.amounts++;
      return `${m[1]}${m[2]}${whole}.${pad(scaled % 100)}`;
    }
    if (g.digits) {
      counts.numbers++;
      if (!numbers.has(match)) numbers.set(match, randomDigits(match));
      return numbers.get(match)!;
    }
    return replaceWord(match);
  });
  return { text: out, counts };
}

/** The lower-case words of a CSV-like file's first line: its column headers, which stay. */
export function headerWords(text: string): Set<string> {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return new Set([...first.matchAll(/[A-Za-z][A-Za-z']*/g)].map((m) => m[0].toLowerCase()));
}
