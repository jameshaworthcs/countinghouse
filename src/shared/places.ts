// A merchant's address, tidied into one line for reading: "1 EXAMPLE PLACE\nMARKET STREET",
// "LONDON", "EC1A1BB", "UNITED KINGDOM OF GB AND NI" becomes "1 Example Place, Market Street,
// London EC1A 1BB". Enrichment: the transaction's merchant fields stay exactly as the document gave
// them, and this is worked out from them again whenever the rules improve (docs/INGESTION.md).

import type { Transaction } from './schema';

/** The UK in the ways documents write it: left out, since nearly everything is here. */
const HOME = new Set(['united kingdom of gb and ni', 'united kingdom', 'great britain', 'gb', 'gbr', 'uk', 'england', 'scotland', 'wales', 'northern ireland']);

/** Words that start a line only when it carries on the one before ("2 MARKET" / "STREET"). */
const STREET_WORDS = new Set(['street', 'st', 'road', 'rd', 'lane', 'ln', 'avenue', 'ave', 'drive', 'dr', 'way', 'close', 'crescent', 'gardens', 'terrace', 'square', 'place', 'row', 'walk', 'court', 'park', 'hill', 'grove', 'mews', 'parade', 'yard', 'wharf', 'green']);

/** Joining words that stay lower case inside a name: "City of London", "Stratford-upon-Avon". */
const SMALL = new Set(['of', 'on', 'upon', 'the', 'and', 'in', 'by', 'at', 'de', 'la', 'le', 'du', 'des', 'del', 'en', 'sur']);

/** Kept as written: they are initials, not words. */
const UPPER = new Set(['po', 'uk', 'usa', 'us', 'bbc', 'nhs', 'ii', 'iii', 'iv']);

function titleWord(word: string, first: boolean): string {
  const lower = word.toLowerCase();
  if (!lower) return word;
  if (/^\d/.test(word)) {
    // 7TH → 7th; 20B, 1-2, 103-104 stay as they are.
    const ordinal = /^(\d+)(st|nd|rd|th)$/i.exec(word);
    return ordinal ? `${ordinal[1]}${ordinal[2]!.toLowerCase()}` : word.toUpperCase();
  }
  if (UPPER.has(lower)) return lower === 'po' ? 'PO' : word.toUpperCase();
  if (!first && SMALL.has(lower)) return lower;
  // Hyphens and apostrophes: each piece a word ("Stratford-upon-Avon"), a lone letter after an
  // apostrophe stays small ("St John's").
  return lower
    .split('-')
    .map((piece, i) => {
      if (i > 0 && SMALL.has(piece)) return piece;
      return piece.replace(/^([a-z])|'([a-z]{2,})/g, (m, a: string | undefined, b: string | undefined) => (a ? a.toUpperCase() : `'${b![0]!.toUpperCase()}${b!.slice(1)}`));
    })
    .join('-');
}

/** "ST MUNGO STREET" → "St Mungo Street". Already mixed-case text is left as it is. */
export function titleCase(text: string): string {
  if (/[a-z]/.test(text)) return text;
  const words = text.split(/\s+/).filter(Boolean);
  // A joining word keeps its capital at the start, and after a number: "9 The Example".
  return words.map((w, i) => titleWord(w, i === 0 || /^\d/.test(words[i - 1]!))).join(' ');
}

/** A full UK postcode gets its space ("EC1A1BB" → "EC1A 1BB"); anything else is only upper-cased. */
export function tidyPostcode(code: string): string {
  const c = code.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(c) ? `${c.slice(0, -3)} ${c.slice(-3)}` : code.trim().toUpperCase();
}

const clean = (s: string | undefined) => (s ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const isHome = (s: string) => HOME.has(s.toLowerCase().replace(/[.]/g, '').trim());

/** The address lines a document gave, put back together where it wrapped a line mid-name. */
function addressLines(address: string | undefined): string[] {
  const lines = (address ?? '')
    .split(/\n|\r|,/)
    .map(clean)
    .filter(Boolean)
    // A phone number or a long reference on a line of its own is not part of the address.
    .filter((l) => !/^[+\d][\d\s()-]{7,}$/.test(l) || /[a-z]/i.test(l));
  const out: string[] = [];
  for (const line of lines) {
    const firstWord = line.split(' ')[0]!.toLowerCase();
    const prev = out[out.length - 1];
    // "3" / "ST ANNE STREET": a house number on its own line goes with the street after it.
    if (prev !== undefined && /^\d+[a-z]?$/i.test(prev)) out[out.length - 1] = `${prev} ${line}`;
    // "2 MARKET" / "STREET": a street word starting a line finishes the one before.
    else if (prev !== undefined && STREET_WORDS.has(firstWord) && line.split(' ').length <= 2) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out;
}

/** One tidy line for a merchant's address, or undefined when it gives nothing but the UK. */
export function tidyPlace(merchant: Transaction['merchant']): string | undefined {
  if (!merchant) return undefined;
  const country = clean(merchant.country);
  const home = !country || isHome(country);
  // A town written "NEWBURY, ENGLAND" is the town; a town written "UK" is not a town.
  const town = clean(merchant.city)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !isHome(s))
    .join(', ');
  const postcode = clean(merchant.postcode);
  // A line that only repeats the town or the country (which follow) is left out.
  const lines = addressLines(merchant.address).filter((l) => !isHome(l) && l.toLowerCase() !== town.toLowerCase() && l.toLowerCase() !== country.toLowerCase());
  const parts = lines.map(titleCase);
  const townLine = [town ? titleCase(town) : '', postcode ? (home ? tidyPostcode(postcode) : postcode.toUpperCase()) : ''].filter(Boolean).join(' ');
  if (townLine) parts.push(townLine);
  if (!home) parts.push(country.length <= 3 ? country.toUpperCase() : titleCase(country));
  const place = parts.join(', ');
  return place || undefined;
}
