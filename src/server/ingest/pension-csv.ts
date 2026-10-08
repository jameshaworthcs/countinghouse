// A pension or fund provider's own exports that are not a bank's list of payments: its history of
// fund trades (each with the units it bought or sold and their price), and its summary of what you and
// your employer have paid in. Deterministic, read on this machine (docs/INGESTION.md).

import { formatDate, parseFlexibleDate, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, parseAmount, toMinor } from '../../shared/money';
import { ExtractedTransactionSchema, ExtractionSchema, type Extraction, type ExtractedTransaction } from '../../shared/schema';
import { taxYearOf } from '../../shared/uk';
import { normHeader } from './csv';
import { price } from './holdings-csv';

export const PENSION_CSV_VERSION = 'pension-csv-1';

const pick = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h));

/** Units as printed ("-12.3450", "1,200.5"). */
function units(cell: string | undefined): number | null {
  const s = (cell ?? '').replace(/[,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Units to 4 decimal places, the most providers print, as a whole number to compare. */
const unitKey = (n: number) => Math.round(n * 10_000);

/**
 * A fund trade history: the trade date, its type (Contribution, Switch In, Sale…), the fund, the
 * value, and the units traded and their price, one row per trade, as a pension provider exports it.
 * A total line per fund (no date) gives the units held: when every fund's rows add up to it, the
 * file is the account's whole history, to the day it was downloaded (`asOf`). Returns null when the
 * file is not one.
 */
export function parseFundTradesCsv(rows: string[][], opts: { asOf?: ISODate | undefined } = {}): Extraction | null {
  const headerIndex = rows.findIndex((r) => r.filter(Boolean).length >= 4);
  if (headerIndex < 0) return null;
  const headers = rows[headerIndex]!.map(normHeader);
  const col = {
    date: pick(headers, /^(trade date|deal date|date)$/),
    type: pick(headers, /^(transaction type|trade type|type|activity)$/),
    fund: pick(headers, /^(fund name|fund|investment|investment name|security)$/),
    value: pick(headers, /^(value|amount|trade value|value £|amount £)$/),
    units: pick(headers, /^(traded units|units traded|units|quantity)$/),
    price: pick(headers, /^(trade price|deal price|unit price|price)$/),
  };
  if (Object.values(col).some((i) => i < 0)) return null;

  const notes: string[] = [];
  const txs: ExtractedTransaction[] = [];
  const held = new Map<string, number>();
  const totals = new Map<string, number>();
  rows.slice(headerIndex + 1).forEach((row, i) => {
    if (row.every((c) => !c)) return;
    const fund = row[col.fund]?.trim() ?? '';
    const type = row[col.type]?.trim() ?? '';
    const date = parseFlexibleDate(row[col.date], 'DMY');
    const traded = units(row[col.units]);
    if (!date) {
      // "Overall Total" lines: the units each fund holds now, a check on the rows.
      if (/total/i.test(type) && fund && traded !== null) totals.set(fund, (totals.get(fund) ?? 0) + unitKey(traded));
      else notes.push(`Row ${headerIndex + i + 2}: no date, left out.`);
      return;
    }
    const amount = parseAmount(row[col.value]);
    if (amount === null) {
      notes.push(`Row ${headerIndex + i + 2}: no value, left out.`);
      return;
    }
    if (traded !== null) held.set(fund, (held.get(fund) ?? 0) + unitKey(traded));
    const at = price(row[col.price]);
    const raw: Record<string, string> = {};
    rows[headerIndex]!.forEach((h, j) => {
      if (row[j]) raw[h] = row[j]!;
    });
    txs.push(
      ExtractedTransactionSchema.parse({
        date,
        // The type says what the money was ("Contribution", "Switch In"); the fund, what it bought.
        description: [type, fund].filter(Boolean).join(' · ') || '(no description)',
        amount,
        payee: fund || null,
        type: type || null,
        raw,
        attributes: { ...(traded !== null ? { units: traded } : {}), ...(at !== null ? { price: at } : {}), ...(fund ? { fund } : {}) },
        row: headerIndex + i + 1,
      }),
    );
  });
  if (!txs.length) return null;
  txs.sort((a, b) => a.date.localeCompare(b.date) || (b.row ?? 0) - (a.row ?? 0));

  // The total lines against the rows: each fund's units should be what its rows add up to.
  const funds = [...new Set([...held.keys(), ...totals.keys()])];
  const off = funds.filter((f) => totals.has(f) && (held.get(f) ?? 0) !== totals.get(f));
  const whole = totals.size > 0 && off.length === 0 && funds.every((f) => totals.has(f));
  const shown = (key: number) => (key / 10_000).toLocaleString('en-GB', { maximumFractionDigits: 4 });
  for (const f of off) notes.push(`${f}: its rows add up to ${shown(held.get(f) ?? 0)} units, but the file’s total is ${shown(totals.get(f)!)}. Rows may be missing.`);
  const first = txs[0]!.date;
  const last = txs[txs.length - 1]!.date;
  // The whole history: it runs to the day it was downloaded, not just to its last trade.
  const periodEnd = whole && opts.asOf && opts.asOf >= last ? opts.asOf : last;
  if (whole) {
    const now = funds.filter((f) => totals.get(f)! !== 0).map((f) => `${shown(totals.get(f)!)} units of ${f}`);
    notes.push(
      `The file’s totals agree with its rows (${now.length ? now.join(', ') : 'nothing held'}${funds.length > now.length ? `; none of ${funds.filter((f) => totals.get(f) === 0).join(', ')}` : ''}): it is the account’s whole history, from its first trade on ${formatDate(first)}${periodEnd !== last ? ` to ${formatDate(periodEnd)}, the day it was downloaded` : ''}.`,
    );
  }
  return ExtractionSchema.parse({
    documentType: 'csv_export',
    accounts: [{ currency: 'GBP', periodStart: first, periodEnd, transactions: txs, holdings: [] }],
    notes,
    confidence: 'high',
  });
}

/** Who a contributions summary's row is from. */
function contributor(cell: string): 'employee' | 'employer' | null {
  const s = cell.trim().toLowerCase();
  if (/employer|company|firm/.test(s)) return 'employer';
  if (/^(you|yourself|member|employee|me|personal)$/.test(s) || /\byou\b/.test(s)) return 'employee';
  return null;
}

/** A file name that says the totals are this tax year's ("contributions-tax-year-to-date.csv"). */
const TAX_YEAR_NAME = /tax.?year|year.?to.?date|\bytd\b|this.?year/i;

/**
 * A provider's summary of contributions: who paid (You, Your Employer), the kind (Core, AVC) and the
 * amount, with no dates. They are what was paid in up to the day it was downloaded (`asOf`): this tax
 * year's when its file name says so, else since the start. Returns null when the file is not one.
 */
export function parseContributionsCsv(rows: string[][], fileName: string, opts: { asOf?: ISODate | undefined } = {}): Extraction | null {
  const headerIndex = rows.findIndex((r) => r.filter(Boolean).length >= 2);
  if (headerIndex < 0) return null;
  const headers = rows[headerIndex]!.map(normHeader);
  if (headers.some((h) => /date/.test(h))) return null;
  const who = pick(headers, /^(contributor|contributed by|paid by|from)$/);
  const amountCol = pick(headers, /^(contribution amount|contributions?|amount|value|total)$/);
  const kindCol = pick(headers, /^(contribution type|type)$/);
  if (who < 0 || amountCol < 0) return null;

  const asOf = opts.asOf;
  const yearToDate = TAX_YEAR_NAME.test(fileName);
  const ty = asOf ? taxYearOf(asOf) : undefined;
  const notes: string[] = [];
  const figures: Extraction['figures'] = [];
  const sum = { employee: 0, employer: 0 };
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.every((c) => !c)) continue;
    const name = row[who]?.trim() ?? '';
    const amount = parseAmount(row[amountCol]);
    if (amount === null) continue;
    const side = contributor(name);
    if (!side) {
      notes.push(`"${name}" paid ${formatMoney(amount)}: not you or your employer, so it is left out.`);
      continue;
    }
    sum[side] += toMinor(amount);
    const kind = kindCol >= 0 ? row[kindCol]?.trim() : '';
    figures.push({
      kind: side === 'employee' ? 'pension_contribution_employee' : 'pension_contribution_employer',
      label: [name, kind, yearToDate ? 'this tax year' : 'to date'].filter(Boolean).join(' · '),
      amount,
      currency: 'GBP',
      // This tax year's: from 6 April to the day it was downloaded. Since the start: no start, no tax year.
      periodStart: yearToDate && ty ? ty.start : null,
      periodEnd: asOf ?? null,
      taxYear: yearToDate && ty ? ty.label : null,
      payer: null,
      payerReference: null,
      accountLast4: null,
      taxCode: null,
      work: null,
    });
  }
  if (!figures.length) return null;
  const total = fromMinor(sum.employee + sum.employer);
  const span = yearToDate ? (ty ? `during the ${ty.label} tax year` : 'during this tax year') : 'since the start';
  notes.push(
    `Paid in ${span}${asOf ? `, to ${formatDate(asOf)} (the day it was downloaded)` : ''}: you ${formatMoney(fromMinor(sum.employee))}, your employer ${formatMoney(fromMinor(sum.employer))}, ${formatMoney(total)} in all.`,
  );
  if (!asOf) notes.push('Nothing says when it was downloaded, so its figures have no date.');
  return ExtractionSchema.parse({
    documentType: 'csv_export',
    documentDate: asOf ?? null,
    accounts: [],
    figures,
    notes,
    confidence: 'high',
  });
}
