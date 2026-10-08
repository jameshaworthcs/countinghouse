// Portfolio exports: a platform's list of holdings as CSV (interactive investor's "Export" on the
// portfolio page, and similar), one row per holding with quantity, price, value and cost. Not
// transactions, so the transaction profiles do not apply. Deterministic, read on this machine.

import { parseFlexibleDate, type ISODate } from '../../shared/dates';
import { parseAmount } from '../../shared/money';
import { ExtractionSchema, type AccountType, type Extraction } from '../../shared/schema';
import { normHeader } from './csv';

export const HOLDINGS_CSV_VERSION = 'holdings-csv-3';

const pick = (headers: string[], ...names: RegExp[]) => {
  for (const re of names) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/** A price as printed: "290.19p" is pence, "£7.1375" pounds; any precision. */
export function price(cell: string | undefined): number | null {
  if (!cell) return null;
  const s = cell.replace(/[£,\s]/g, '');
  const pence = /p$/i.test(s);
  const n = Number(s.replace(/p$/i, ''));
  if (!Number.isFinite(n)) return null;
  return pence ? Math.round(n * 10_000) / 1_000_000 : n;
}

/** SEDOL (7 characters, no vowels, check digit), ISIN, or else a ticker. */
function identifier(cell: string | undefined): { isin?: string; sedol?: string; ticker?: string } {
  const s = (cell ?? '').trim().toUpperCase();
  if (!s) return {};
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return { isin: s };
  if (/^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}\d$/.test(s) && /\d/.test(s.slice(0, 6))) return { sedol: s };
  return /^[A-Z0-9.]{1,12}$/.test(s) ? { ticker: s } : {};
}

/** The wrapper a file name suggests ("…-ISA.csv", "…SIPP…"). */
function typeFromName(fileName: string): AccountType | null {
  const n = fileName.toLowerCase();
  if (/\blisa\b|lifetime/.test(n)) return 'lisa';
  if (/sipp|pension/.test(n)) return 'sipp';
  if (/(^|[^a-z])isa([^a-z]|$)/.test(n)) return 'stocks_isa';
  if (/trading|\bgia\b|fund.?and.?share/.test(n)) return 'gia';
  return null;
}

/**
 * Parse a holdings export, or return null when the file is not one (it has dates, or lacks a name,
 * quantity or value column).
 */
export function parseHoldingsCsv(rows: string[][], fileName: string): Extraction | null {
  const headerIndex = rows.findIndex((r) => r.filter(Boolean).length >= 3);
  if (headerIndex < 0) return null;
  const headers = rows[headerIndex]!.map(normHeader);
  if (headers.some((h) => /^(date|trade date|settlement date|transaction date)$/.test(h))) return null;
  const col = {
    name: pick(headers, /^(name|investment|holding|security|stock|description|fund)( name)?$/),
    symbol: pick(headers, /^(symbol|ticker|epic|code|sedol|isin)$/),
    units: pick(headers, /^(qty|quantity|units|shares|holding)$/),
    price: pick(headers, /^(price|last price|current price|unit price)$/),
    // The day the prices are from, when the file prints one (a pension provider's "Price Date").
    priced: pick(headers, /^(price date|priced at|valuation date|value date|as at|as of)$/),
    value: pick(headers, /^market value £$/, /^(market value|value|value £|value \(£\)|current value)$/),
    cost: pick(headers, /^(book cost|cost|total cost|amount invested)$/),
    gain: pick(headers, /^(gain\/loss|gain \/ loss|profit\/loss|total gain\/loss|gain)$/),
  };
  if (col.name < 0 || col.units < 0 || col.value < 0) return null;

  const holdings: Extraction['accounts'][number]['holdings'] = [];
  let printedTotal: number | null = null;
  let printedGain: number | null = null;
  const notes: string[] = [];
  const pricedOn: ISODate[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const name = row[col.name]?.trim() ?? '';
    const value = parseAmount(row[col.value]);
    // The totals line: no holding name, a value, and the growth on all of them.
    if (!name || /^(total|totals|gbp)$/i.test(name)) {
      if (value !== null && row.some((c) => /^(gbp|total|totals)$/i.test(c.trim()))) {
        printedTotal = value;
        printedGain = col.gain >= 0 ? parseAmount(row[col.gain]) : null;
      }
      continue;
    }
    if (value === null) {
      notes.push(`"${name}" has no value and was left out.`);
      continue;
    }
    const day = col.priced >= 0 ? parseFlexibleDate(row[col.priced], 'DMY') : null;
    if (day) pricedOn.push(day);
    const units = Number((row[col.units] ?? '').replace(/,/g, ''));
    const cost = col.cost >= 0 ? parseAmount(row[col.cost]) : null;
    const gain = col.gain >= 0 ? parseAmount(row[col.gain]) : null;
    const id = identifier(col.symbol >= 0 ? row[col.symbol] : undefined);
    holdings.push({
      name,
      isin: id.isin ?? null,
      ticker: id.ticker ?? null,
      sedol: id.sedol ?? null,
      units: Number.isFinite(units) && units > 0 ? units : null,
      price: col.price >= 0 ? price(row[col.price]) : null,
      value,
      currency: 'GBP',
      assetClass: null,
      costBasis: cost,
      gain,
    });
  }
  if (!holdings.length) return null;
  const sum = Math.round(holdings.reduce((s, h) => s + h.value * 100, 0)) / 100;
  if (printedTotal !== null && Math.abs(printedTotal - sum) > 0.01) notes.push(`The file's own total (£${printedTotal.toFixed(2)}) differs from its rows (£${sum.toFixed(2)}).`);
  const gains = holdings.map((h) => h.gain).filter((g): g is number => g !== null);
  const gainSum = gains.length === holdings.length ? Math.round(gains.reduce((s, g) => s + g * 100, 0)) / 100 : null;
  if (printedGain !== null && gainSum !== null && Math.abs(printedGain - gainSum) > 0.01) notes.push(`The file's own total growth (£${printedGain.toFixed(2)}) differs from its rows (£${gainSum.toFixed(2)}).`);
  notes.push('A holdings export lists investments only: any uninvested cash is not in it, so the value recorded is what the investments are worth.');
  // interactive investor's export has its own set of columns.
  const ii = headers.includes('day gain/loss') && headers.includes('average price');
  // Priced on one day: the holdings' value is as at that day, whenever the file was saved.
  const valuedOn = pricedOn.length === holdings.length && new Set(pricedOn).size === 1 ? pricedOn[0]! : null;
  if (pricedOn.length && !valuedOn) notes.push(`Its funds are priced on different days (${[...new Set(pricedOn)].sort().join(', ')}), so it is dated by the file.`);
  return ExtractionSchema.parse({
    documentType: 'csv_export',
    institutionName: ii ? 'interactive investor' : null,
    accounts: [
      {
        institutionName: ii ? 'interactive investor' : null,
        accountType: typeFromName(fileName),
        currency: 'GBP',
        closingBalance: printedTotal ?? sum,
        balanceDate: valuedOn,
        gainLoss: printedGain,
        holdings,
      },
    ],
    notes,
    confidence: 'high',
  });
}
