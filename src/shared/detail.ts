// What a document knows about a payment already recorded that the record does not: the source fields
// it can fill in, and what it says differently (docs/INGESTION.md, "Adding detail to a recorded
// payment"). Pure, so the draft, the commit, the nothing-new check and the review page agree.
//
// A payment is recorded by its date, amount and description, and those never change. Any other
// source field the record lacks can be filled in from a document that shows the same payment:
// - the day it was made, when the document dates it earlier than the record (an app shows when the
//   card was used; the export, when it cleared), with that day's time;
// - its time, bank id, type, reference, other party, merchant, bank category, card, foreign amount,
//   rate and fee;
// - the balance after it, only when both date it the same day (a running balance is the ledger's).
// A field the record already has is never replaced. Where the document says something else, the
// difference is shown, and kept with the record of what the document added; nothing changes.

import { formatDate } from './dates';
import { formatMoney, toMinor } from './money';
import { DETAIL_FIELDS, type DetailField, type DraftTransaction, type SeenIn, type Transaction } from './schema';

export type DetailFields = NonNullable<DraftTransaction['adds']>['fields'];

export interface Difference {
  field: string;
  recorded: string | number;
  here: string | number;
}

export interface DetailAdded {
  fields: DetailFields;
  differs: Difference[];
}

/** What a document says about one payment: a draft row, or anything shaped like one. */
export type Shown = Pick<DraftTransaction, 'date' | 'amount' | 'description' | 'balanceAfter' | 'original' | 'pending' | 'detail'>;

/** The recorded payment, as far as filling it in goes. */
export type Recorded = Pick<Transaction, 'date' | 'description' | DetailField>;

/** Case, spacing and punctuation aside. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9£€$]+/g, ' ')
    .trim();

/**
 * Two wordings of one thing: the same once case and punctuation are set aside, or the document's
 * shorter than the record's and within it ("Cash withdrawal" in "Cash withdrawal | EUR 40.00").
 */
function sameWords(here: string, recorded: string): boolean {
  const [h, r] = [plain(here), plain(recorded)];
  return h === r || (h.length > 0 && ` ${r} `.includes(` ${h} `));
}

const sameTime = (a: string, b: string) => a.slice(0, 5) === b.slice(0, 5);
const sameMoney = (a: number, b: number) => toMinor(a) === toMinor(b);

const STRING_FIELDS = ['type', 'reference', 'counterpartyName', 'bankCategory'] as const;
const EXACT_FIELDS = ['sourceId', 'cardLast4'] as const;
const MERCHANT_FIELDS = ['name', 'category', 'mcc', 'address', 'city', 'postcode', 'country', 'website', 'online'] as const;

/**
 * What `shown`, a row of a document matched to `recorded`, adds to it, and where it differs.
 * Nothing from a pending row: it is shown before it settles, and may settle otherwise.
 */
export function detailToAdd(shown: Shown, recorded: Recorded): DetailAdded {
  const fields: DetailFields = {};
  const differs: Difference[] = [];
  if (shown.pending) return { fields, differs };
  const d = shown.detail ?? {};
  const set = fields as Record<string, unknown>;
  const fill = <K extends keyof DetailFields>(field: K, here: DetailFields[K] | undefined, have: DetailFields[K] | undefined, same: (a: NonNullable<DetailFields[K]>, b: NonNullable<DetailFields[K]>) => boolean) => {
    if (here === undefined || here === null || here === '') return;
    if (have === undefined) set[field] = here;
    else if (!same(here, have) && (typeof here === 'string' || typeof here === 'number') && (typeof have === 'string' || typeof have === 'number')) differs.push({ field, recorded: have, here });
  };

  // Dates. The record's `date` is when the payment was posted. A document dating it earlier is
  // dating it by when it was made; one printing a separate purchase date says so outright.
  const posted = shown.date === recorded.date;
  const printedMade = d.transactionDate && d.transactionDate !== shown.date ? d.transactionDate : undefined;
  const made = printedMade ?? (!posted && shown.date < recorded.date ? shown.date : undefined);
  if (!posted && shown.date !== made) differs.push({ field: 'date', recorded: recorded.date, here: shown.date });
  if (made && made < recorded.date) fill('transactionDate', made, recorded.transactionDate, (a, b) => a === b);
  else if (made && made > recorded.date) differs.push({ field: 'transactionDate', recorded: recorded.transactionDate ?? recorded.date, here: made });
  // A time is of the day the document gives with it.
  if (d.time) {
    if (posted) fill('time', d.time, recorded.time, sameTime);
    else if (shown.date === made && (fields.transactionDate ?? recorded.transactionDate) === made) fill('transactionTime', d.time, recorded.transactionTime, sameTime);
  }

  for (const f of STRING_FIELDS) fill(f, d[f], recorded[f], sameWords);
  for (const f of EXACT_FIELDS) fill(f, d[f], recorded[f], (a, b) => a === b);
  // A running balance places a payment in one day's ledger: only from a document that posts it the
  // same day. Cards' balances are signed either way by different sources.
  if (posted) fill('balanceAfter', shown.balanceAfter, recorded.balanceAfter, (a, b) => Math.abs(toMinor(a)) === Math.abs(toMinor(b)));
  if (shown.original) {
    if (!recorded.original) fields.original = shown.original;
    else if (shown.original.currency !== recorded.original.currency || !sameMoney(Math.abs(shown.original.amount), Math.abs(recorded.original.amount)))
      differs.push({ field: 'original', recorded: formatMoney(recorded.original.amount, { currency: recorded.original.currency }), here: formatMoney(shown.original.amount, { currency: shown.original.currency }) });
  }
  fill('exchangeRate', d.exchangeRate, recorded.exchangeRate, (a, b) => Math.abs(a - b) < 1e-6);
  fill('fee', d.fee, recorded.fee, sameMoney);

  // The merchant, field by field: an app's city beside an export's name.
  if (d.merchant) {
    const add: NonNullable<DetailFields['merchant']> = {};
    for (const k of MERCHANT_FIELDS) {
      const here = d.merchant[k];
      const have = recorded.merchant?.[k];
      if (here === undefined || here === '') continue;
      if (have === undefined) (add as Record<string, unknown>)[k] = here;
      else if (typeof here === 'string' && typeof have === 'string' && !sameWords(here, have)) differs.push({ field: `merchant.${k}`, recorded: have, here });
    }
    if (Object.keys(add).length) fields.merchant = add;
  }
  if (d.attributes) {
    const add = Object.fromEntries(Object.entries(d.attributes).filter(([k]) => recorded.attributes?.[k] === undefined));
    if (Object.keys(add).length) fields.attributes = add;
  }

  if (!sameWords(shown.description, recorded.description)) differs.push({ field: 'description', recorded: recorded.description, here: shown.description });
  return { fields, differs };
}

export const addsAnything = (a: { fields: DetailFields } | undefined): boolean => Boolean(a && Object.keys(a.fields).length);

/**
 * The patch that fills `fields` in on `recorded`, as it is now: only what is still empty (another
 * import may have filled some since), merchant and attributes key by key. A time goes in only with
 * the day it belongs to.
 */
export function fillIn(recorded: Recorded, fields: DetailFields): { patch: Partial<Transaction>; added: DetailField[] } {
  const patch: Partial<Transaction> = {};
  const added: DetailField[] = [];
  // The day before its time.
  const entries = (Object.entries(fields) as [DetailField, unknown][]).sort(([a], [b]) => DETAIL_FIELDS.indexOf(a) - DETAIL_FIELDS.indexOf(b));
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    if (k === 'merchant' || k === 'attributes') {
      const have = (recorded[k] ?? {}) as Record<string, unknown>;
      const fresh = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([key]) => have[key] === undefined));
      if (!Object.keys(fresh).length) continue;
      (patch as Record<string, unknown>)[k] = { ...have, ...fresh };
      added.push(k);
      continue;
    }
    if (recorded[k] !== undefined) continue;
    if (k === 'transactionTime' && fields.transactionDate !== undefined && (patch.transactionDate ?? recorded.transactionDate) !== fields.transactionDate) continue;
    (patch as Record<string, unknown>)[k] = v;
    added.push(k);
  }
  return { patch, added };
}

/**
 * What `now` would add that you saw on the review page (`seen`): the same fields with the same
 * values. A row edited since it was matched, or a record another import filled in meanwhile, adds
 * only what both still agree on.
 */
export function stillAdds(seen: DetailFields, now: DetailFields): DetailFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) {
    const was = (seen as Record<string, unknown>)[k];
    if (was === undefined) continue;
    // The merchant and other details key by key; a foreign amount is one value.
    if ((k === 'merchant' || k === 'attributes') && v !== null && typeof v === 'object') {
      const keep = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([key, x]) => JSON.stringify((was as Record<string, unknown>)[key]) === JSON.stringify(x)));
      if (Object.keys(keep).length) out[k] = keep;
    } else if (JSON.stringify(was) === JSON.stringify(v)) out[k] = v;
  }
  return out;
}

/** The provenance entry for what a document filled in, with what it said differently. */
export function seenInEntry(source: { importId?: string; documentId?: string; row?: number | undefined }, added: DetailField[], differs: Difference[], at: string): SeenIn {
  const said = Object.fromEntries(differs.map((x) => [x.field, x.here]));
  return {
    ...(source.importId ? { importId: source.importId } : {}),
    ...(source.documentId ? { documentId: source.documentId } : {}),
    ...(source.row !== undefined && source.row >= 0 ? { row: source.row } : {}),
    at,
    added,
    ...(Object.keys(said).length ? { said } : {}),
  };
}

// ─── Words, for the review page, the transaction and the import record ─────────────────────────

export const DETAIL_LABELS: Record<DetailField, string> = {
  transactionDate: 'Made on',
  transactionTime: 'Time made',
  time: 'Time',
  sourceId: 'Bank id',
  type: 'Type',
  reference: 'Reference',
  counterpartyName: 'Other party',
  merchant: 'Merchant',
  bankCategory: 'Bank’s category',
  cardLast4: 'Card',
  balanceAfter: 'Balance after',
  original: 'Foreign amount',
  exchangeRate: 'Exchange rate',
  fee: 'Fee',
  attributes: 'Other details',
};

const DIFFERENCE_LABELS: Record<string, string> = { description: 'Description', date: 'Date', ...DETAIL_LABELS };

/** One line per thing filled in: "Made on 14 Sep 2026 at 21:15", "Other party: Credit card". */
export function describeDetail(fields: DetailFields, currency = 'GBP'): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (fields.transactionDate) out.push({ label: DETAIL_LABELS.transactionDate, value: `${formatDate(fields.transactionDate)}${fields.transactionTime ? ` at ${fields.transactionTime.slice(0, 5)}` : ''}` });
  else if (fields.transactionTime) out.push({ label: DETAIL_LABELS.transactionTime, value: fields.transactionTime.slice(0, 5) });
  if (fields.time) out.push({ label: DETAIL_LABELS.time, value: fields.time.slice(0, 5) });
  for (const k of ['counterpartyName', 'type', 'reference', 'bankCategory', 'sourceId'] as const) if (fields[k]) out.push({ label: DETAIL_LABELS[k], value: fields[k] });
  if (fields.merchant) {
    const m = fields.merchant;
    const parts = [m.name, m.address, m.city, m.postcode, m.country, m.website, m.category, m.mcc ? `MCC ${m.mcc}` : undefined, m.online === true ? 'online' : m.online === false ? 'in person' : undefined].filter(Boolean);
    if (parts.length) out.push({ label: DETAIL_LABELS.merchant, value: parts.join(' · ') });
  }
  if (fields.cardLast4) out.push({ label: DETAIL_LABELS.cardLast4, value: `•••• ${fields.cardLast4}` });
  if (fields.original) out.push({ label: DETAIL_LABELS.original, value: formatMoney(Math.abs(fields.original.amount), { currency: fields.original.currency }) });
  if (fields.exchangeRate) out.push({ label: DETAIL_LABELS.exchangeRate, value: String(fields.exchangeRate) });
  if (fields.fee !== undefined) out.push({ label: DETAIL_LABELS.fee, value: formatMoney(fields.fee, { currency }) });
  if (fields.balanceAfter !== undefined) out.push({ label: DETAIL_LABELS.balanceAfter, value: formatMoney(fields.balanceAfter, { currency }) });
  if (fields.attributes) out.push({ label: DETAIL_LABELS.attributes, value: Object.entries(fields.attributes).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') });
  return out;
}

/** A difference in words: "Description: “To Revolving Line Account” recorded, “Sam's Account to Credit card” here". */
export function describeDifference(x: Difference): { label: string; recorded: string; here: string } {
  const show = (v: string | number) => (/date$/i.test(x.field) && typeof v === 'string' ? formatDate(v) : String(v));
  return { label: DIFFERENCE_LABELS[x.field] ?? (x.field.startsWith('merchant.') ? `Merchant ${x.field.slice(9)}` : x.field), recorded: show(x.recorded), here: show(x.here) };
}

/** "the day it was made and the other party": for an import's summary and commit message. */
export function fieldsInWords(added: DetailField[]): string {
  const words: Record<DetailField, string> = {
    transactionDate: 'the day it was made',
    transactionTime: 'the time it was made',
    time: 'the time',
    sourceId: 'the bank id',
    type: 'the type',
    reference: 'the reference',
    counterpartyName: 'the other party',
    merchant: 'the merchant',
    bankCategory: 'the bank’s category',
    cardLast4: 'the card',
    balanceAfter: 'the balance after it',
    original: 'the foreign amount',
    exchangeRate: 'the exchange rate',
    fee: 'the fee',
    attributes: 'other details',
  };
  // The day and its time read as one.
  const list = added.includes('transactionDate') ? added.filter((f) => f !== 'transactionTime') : added;
  const parts = [...new Set(list.map((f) => words[f]))];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}
