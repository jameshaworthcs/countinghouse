// CSV engine: finds the header row, picks a profile (yours first, then built-in), and turns rows
// into an Extraction. Every source row is kept verbatim in `raw` so later features can re-derive
// anything from it without re-importing.

import Papa from 'papaparse';
import { parseFlexibleDate, type ISODate } from '../../shared/dates';
import { catalogInstitution } from '../../shared/institutions';
import { parseAmount, roundMoney } from '../../shared/money';
import { cardSigns } from '../../shared/review';
import type { AccountType, CsvProfile, ExtractedAccount, ExtractedTransaction, Extraction } from '../../shared/schema';
import { ExtractionSchema } from '../../shared/schema';
import { BUILTIN_CSV_PROFILES } from './csv-profiles';

export const CSV_ENGINE_VERSION = 'csv-1';

export function readCsvRows(text: string): { rows: string[][]; delimiter: string } {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF+/, ''), {
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', ';', '\t', '|'],
  });
  const rows = result.data.map((r) => r.map((c) => (c ?? '').replace(/\u00a0/g, ' ').trim()));
  return { rows, delimiter: result.meta.delimiter };
}

export function normHeader(h: string): string {
  return h
    .replace(/^\uFEFF+/, '')
    .replace(/^["']|["']$/g, '')
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface ProfileMatch {
  profile: CsvProfile;
  headerIndex: number;
  /** For header-less profiles the header is synthesised. */
  headerless: boolean;
}

/** Most specific profile whose header signature appears in the first rows. */
export function findProfile(rows: string[][], userProfiles: CsvProfile[] = []): ProfileMatch | null {
  const profiles = [...userProfiles, ...BUILTIN_CSV_PROFILES];
  let best: ProfileMatch | null = null;
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const cells = new Set(rows[i]!.map(normHeader));
    for (const profile of profiles) {
      if (profile.headerless) continue;
      if (!profile.headerSignature.every((h) => cells.has(normHeader(h)))) continue;
      const isUser = !profile.builtin;
      const better =
        !best ||
        (isUser && best.profile.builtin) ||
        (isUser === !best.profile.builtin && profile.headerSignature.length > best.profile.headerSignature.length);
      if (better) best = { profile, headerIndex: i, headerless: false };
    }
    if (best) return best;
  }
  // Header-less layouts: match on the shape of the first data row.
  const first = rows[0];
  if (first) {
    for (const profile of profiles) {
      if (!profile.headerless || first.length !== profile.headerless.length) continue;
      const cols = profile.headerless.map(normHeader);
      const d = cols.indexOf(normHeader(profile.columns.date));
      const a = profile.columns.amount ? cols.indexOf(normHeader(profile.columns.amount)) : -1;
      if (d >= 0 && parseFlexibleDate(first[d], profile.dateOrder) && (a < 0 || parseAmount(first[a]) !== null)) {
        return { profile, headerIndex: -1, headerless: true };
      }
    }
  }
  return null;
}

function last4Of(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function timeOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return undefined;
  return `${m[1]!.padStart(2, '0')}:${m[2]}${m[3] ? `:${m[3]}` : ''}`;
}

function joinDescription(values: (string | undefined)[]): string {
  const parts: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    const containedIdx = parts.findIndex((p) => p.toLowerCase().includes(lower));
    if (containedIdx >= 0) continue;
    const containsIdx = parts.findIndex((p) => lower.includes(p.toLowerCase()));
    if (containsIdx >= 0) parts[containsIdx] = t;
    else parts.push(t);
  }
  return parts.join(' · ');
}

/** Key/value lines above the header (Nationwide-style preambles). */
function readPreamble(rows: string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const cells = r.filter(Boolean);
    if (cells.length >= 2) out[normHeader(cells[0]!)] = cells[1]!;
  }
  return out;
}

export interface CsvParseResult {
  extraction: Extraction;
  rowCount: number;
  skipped: number;
}

export function parseWithProfile(rows: string[][], match: ProfileMatch): CsvParseResult {
  const { profile } = match;
  const header = match.headerless ? profile.headerless! : rows[match.headerIndex]!;
  const dataRows = match.headerless ? rows : rows.slice(match.headerIndex + 1);
  const preamble = match.headerless ? {} : readPreamble(rows.slice(0, match.headerIndex));
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const k = normHeader(h);
    if (!index.has(k)) index.set(k, i);
  });
  const col = (name: string | undefined, row: string[]): string | undefined => {
    if (!name) return undefined;
    const i = index.get(normHeader(name));
    return i === undefined ? undefined : row[i];
  };
  const warnings: string[] = [];
  let skipped = 0;

  type Row = { tx: ExtractedTransaction; group: string; groupValues: Record<string, string>; accountNumber?: string | undefined };
  const parsed: Row[] = [];
  // "Opening balance" / "balance brought forward" lines carry a balance, not a transaction.
  const balanceRows: { date: ISODate; balance: number; opening: boolean }[] = [];
  const BALANCE_ROW = /^(opening|closing|start|end(ing)?) ?balance$|balance (brought|carried) forward|^(b\/f|c\/f)$/i;
  const skipDescriptions = (profile.skipDescriptions ?? []).map((d) => d.toLowerCase());

  dataRows.forEach((row, i) => {
    if (row.every((c) => !c)) return;
    const lineNo = (match.headerless ? 0 : match.headerIndex + 1) + i;
    if (profile.filter) {
      const v = col(profile.filter.column, row) ?? '';
      if (!profile.filter.values.some((x) => x.toLowerCase() === v.toLowerCase())) {
        skipped++;
        return;
      }
    }
    const date = parseFlexibleDate(col(profile.columns.date, row), profile.dateOrder);
    if (!date) {
      skipped++;
      if (row.filter(Boolean).length > 1) warnings.push(`Row ${lineNo + 1}: no readable date ("${col(profile.columns.date, row) ?? ''}"), skipped`);
      return;
    }
    let amount: number | null = null;
    if (profile.columns.amount) {
      amount = parseAmount(col(profile.columns.amount, row));
      if (amount !== null && profile.amountSign === 'inverted') amount = -amount;
    } else {
      const debit = parseAmount(col(profile.columns.debit, row));
      const credit = parseAmount(col(profile.columns.credit, row));
      if (debit !== null || credit !== null) amount = roundMoney(Math.abs(credit ?? 0) - Math.abs(debit ?? 0));
    }
    if (amount === null) {
      skipped++;
      warnings.push(`Row ${lineNo + 1}: no readable amount, skipped`);
      return;
    }
    for (const [when, sign] of [[profile.negativeWhen, -1], [profile.positiveWhen, 1]] as const) {
      if (!when) continue;
      const v = (col(when.column, row) ?? '').toLowerCase();
      if (when.values.some((x) => v.startsWith(x.toLowerCase()))) amount = sign * Math.abs(amount);
    }
    let fee: number | null = null;
    const feeRaw = parseAmount(col(profile.columns.fee, row));
    if (feeRaw) {
      fee = -Math.abs(feeRaw);
      amount = roundMoney(amount + fee);
    }
    const descText = joinDescription(profile.columns.description.map((d) => col(d, row)));
    if (BALANCE_ROW.test(descText.trim()) && !amount) {
      const bal = parseAmount(col(profile.columns.balance, row));
      if (bal !== null) balanceRows.push({ date, balance: bal, opening: !/closing|end|carried|c\/f/i.test(descText) });
      skipped++;
      return;
    }
    if (skipDescriptions.some((d) => descText.toLowerCase().includes(d))) {
      skipped++;
      return;
    }
    const currency = (col(profile.columns.currency, row) || 'GBP').toUpperCase();
    const localCurrency = col(profile.columns.localCurrency, row)?.toUpperCase();
    const localAmount = parseAmount(col(profile.columns.localAmount, row));
    const raw: Record<string, string> = {};
    header.forEach((h, j) => {
      const v = row[j];
      if (v) raw[h] = v;
    });
    const merchant = {
      ...(col(profile.columns.payee, row) ? { name: col(profile.columns.payee, row)! } : {}),
      ...(col(profile.columns.merchantAddress, row) ? { address: col(profile.columns.merchantAddress, row)! } : {}),
      ...(col(profile.columns.merchantCity, row) ? { city: col(profile.columns.merchantCity, row)! } : {}),
      ...(col(profile.columns.merchantPostcode, row) ? { postcode: col(profile.columns.merchantPostcode, row)! } : {}),
      ...(col(profile.columns.merchantCountry, row) ? { country: col(profile.columns.merchantCountry, row)! } : {}),
    };
    const tx: ExtractedTransaction = {
      date,
      description: joinDescription(profile.columns.description.map((d) => col(d, row))) || col(profile.columns.payee, row) || '(no description)',
      amount,
      balanceAfter: parseAmount(col(profile.columns.balance, row)),
      category: null,
      payee: col(profile.columns.payee, row) || null,
      pending: false,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'GBP',
      originalAmount: localCurrency && localCurrency !== currency && localAmount !== null ? localAmount : null,
      originalCurrency: localCurrency && localCurrency !== currency && /^[A-Z]{3}$/.test(localCurrency) ? localCurrency : null,
      transactionDate: parseFlexibleDate(col(profile.columns.transactionDate, row), profile.dateOrder),
      time: timeOf(col(profile.columns.time, row)) ?? null,
      sourceId: col(profile.columns.id, row)?.replace(/^'+|'+$/g, '') || null,
      type: col(profile.columns.type, row) || null,
      reference: col(profile.columns.reference, row) || null,
      counterpartyName: col(profile.columns.counterparty, row) || null,
      merchantLocation: null,
      cardLast4: null,
      bankCategory: col(profile.columns.category, row) || null,
      fee,
      exchangeRate: null,
      raw,
      attributes: null,
      merchant: Object.keys(merchant).length ? merchant : null,
      row: lineNo,
      uncertain: null,
    };
    const groupValues: Record<string, string> = {};
    for (const c of profile.splitBy ?? []) groupValues[c] = col(c, row) ?? '';
    parsed.push({
      tx,
      group: Object.values(groupValues).join(' · '),
      groupValues,
      accountNumber: col(profile.columns.accountNumber, row),
    });
  });

  const groups = new Map<string, Row[]>();
  for (const r of parsed) (groups.get(r.group) ?? groups.set(r.group, []).get(r.group)!).push(r);

  const institutionName = profile.institutionId ? (catalogInstitution(profile.institutionId)?.name ?? profile.name) : null;
  const accounts: ExtractedAccount[] = [];
  for (const [group, list] of groups) {
    // Store chronologically: many banks export newest first.
    const firstDate = list[0]!.tx.date;
    const lastDate = list[list.length - 1]!.tx.date;
    const ordered = firstDate > lastDate ? [...list].reverse() : list;
    const txs = ordered.map((r) => r.tx);
    const withBalance = txs.filter((t) => t.balanceAfter !== null);
    const lastTx = txs[txs.length - 1];
    const firstTx = txs[0];
    let closingBalance: number | null = null;
    let openingBalance: number | null = null;
    let balanceDate: ISODate | null = null;
    if (withBalance.length && lastTx?.balanceAfter !== null && lastTx) {
      closingBalance = lastTx.balanceAfter;
      balanceDate = lastTx.date;
    }
    if (firstTx && firstTx.balanceAfter !== null) openingBalance = roundMoney(firstTx.balanceAfter - firstTx.amount);
    const openingRow = balanceRows.find((b) => b.opening);
    if (openingBalance === null && openingRow) openingBalance = openingRow.balance;
    const closingRow = [...balanceRows].reverse().find((b) => !b.opening);
    if (closingBalance === null && closingRow) {
      closingBalance = closingRow.balance;
      balanceDate = closingRow.date;
    }
    if (closingBalance === null && preamble['account balance']) {
      closingBalance = parseAmount(preamble['account balance']);
      balanceDate = lastDate > firstDate ? lastDate : firstDate;
    }
    const gv = list[0]!.groupValues;
    const currency = list[0]!.tx.currency ?? 'GBP';
    const accountNumber = list.find((r) => r.accountNumber)?.accountNumber ?? preamble['account number'] ?? preamble['account name'];
    const productName = gv.Product ?? gv.product;
    const isSavingsProduct = productName ? /saving|vault|pocket/i.test(productName) : false;
    accounts.push({
      institutionName,
      accountName: preamble['account name'] ?? (group ? `${profile.name} ${group}` : null),
      accountType: isSavingsProduct ? 'savings' : (profile.accountType ?? null),
      last4: last4Of(accountNumber) ?? null,
      currency,
      periodStart: txs.reduce<ISODate | null>((m, t) => (!m || t.date < m ? t.date : m), null),
      periodEnd: txs.reduce<ISODate | null>((m, t) => (!m || t.date > m ? t.date : m), null),
      openingBalance,
      closingBalance,
      balanceDate,
      availableBalance: parseAmount(preamble['available balance']),
      creditLimit: null,
      contributionsToDate: null,
      gainLoss: null,
      governmentBonusToDate: null,
      taxYearContributions: null,
      taxYearInterest: null,
      cashBalance: null,
      annualIncome: null,
      interestRate: null,
      statedMoneyIn: null,
      statedMoneyOut: null,
      runningBalanceOf: null,
      transactions: txs,
      holdings: [],
    });
  }

  if (skipped) warnings.push(`${skipped} row(s) were skipped (filtered or unreadable).`);
  const extraction = ExtractionSchema.parse({
    documentType: 'csv_export',
    institutionName,
    accounts,
    notes: warnings.slice(0, 50),
    confidence: 'high',
  });
  return { extraction, rowCount: parsed.length, skipped };
}

// ─── Unknown layouts: suggest a mapping ──────────────────────────────────────────────────────────

export interface MappingSuggestion {
  profile: CsvProfile;
  headerIndex: number;
  headers: string[];
  sample: string[][];
  confident: boolean;
}

const HINTS: Record<string, RegExp> = {
  date: /^(date|transaction date|posting date|posted|booking date|value date|txn date|completed date|date posted)$|date/,
  amount: /^(amount|value|amt|transaction amount|net amount|amount \(gbp\)|gbp)$|amount/,
  debit: /debit|paid out|money out|withdrawal|payments?\b|spent|out$/,
  credit: /credit|paid in|money in|deposit|receipts?|received|in$/,
  balance: /balance/,
  description: /description|details|narrative|memo|particulars|payee|merchant|name|transaction|reference|counter ?party/,
  currency: /^currency$|ccy/,
  category: /category/,
  time: /^time$/,
  type: /^type$|transaction type/,
};

/** Header words for the description, strongest first. */
const DESCRIPTION_HINTS = [/description|details|narrative|particulars|memo/, /payee|merchant|name|counter ?party/, /reference|transaction/];

/**
 * Columns for a layout no profile knows, worked out from its header and rows. `accountType` is the
 * account the file is going to, when known.
 */
export function suggestMapping(rows: string[][], opts: { accountType?: AccountType | undefined } = {}): MappingSuggestion | null {
  if (rows.length < 2) return null;
  // Header: the first row whose following row contains a date and which itself has no dates.
  let headerIndex = 0;
  for (let i = 0; i < Math.min(rows.length - 1, 30); i++) {
    const row = rows[i]!;
    const next = rows[i + 1]!;
    const hasDateBelow = next.some((c) => parseFlexibleDate(c));
    const isTexty = row.filter(Boolean).length >= 2 && !row.some((c) => parseFlexibleDate(c)) && row.filter((c) => parseAmount(c) !== null).length <= 1;
    if (hasDateBelow && isTexty) {
      headerIndex = i;
      break;
    }
  }
  const headers = rows[headerIndex]!;
  const data = rows.slice(headerIndex + 1).filter((r) => r.length >= 2);
  const sample = data.slice(0, 8);
  const n = Math.max(1, Math.min(data.length, 200));
  const stats = headers.map((h, i) => {
    let dates = 0;
    let amounts = 0;
    let textLen = 0;
    for (const r of data.slice(0, 200)) {
      const v = r[i] ?? '';
      if (parseFlexibleDate(v)) dates++;
      else if (parseAmount(v) !== null) amounts++;
      else textLen += v.length;
    }
    return { header: h, norm: normHeader(h), dateRatio: dates / n, amountRatio: amounts / n, avgText: textLen / n };
  });
  const pick = (hint: RegExp, pred: (s: (typeof stats)[number]) => boolean) => stats.find((s) => hint.test(s.norm) && pred(s));
  const date = pick(HINTS.date!, (s) => s.dateRatio > 0.7) ?? stats.find((s) => s.dateRatio > 0.9);
  const amount = pick(HINTS.amount!, (s) => s.amountRatio > 0.5 && !/balance/.test(s.norm));
  const debit = amount ? undefined : pick(HINTS.debit!, (s) => s.amountRatio > 0.05);
  const credit = amount ? undefined : pick(HINTS.credit!, (s) => s.amountRatio > 0.05 && s !== debit);
  const balance = pick(HINTS.balance!, (s) => s.amountRatio > 0.5);
  // The description: a column named for it first, then one naming the other party, then any other
  // text column the hints allow. A column that is the transaction's type ("Transaction Type": Transfer,
  // Payment…) is never it while another will do: Chase's export has both.
  const typeLike = (s: (typeof stats)[number]) => HINTS.type!.test(s.norm);
  const description =
    DESCRIPTION_HINTS.map((hint) => pick(hint, (s) => s.avgText > 3 && !typeLike(s))).find(Boolean) ??
    pick(HINTS.description!, (s) => s.avgText > 3) ??
    [...stats].sort((a, b) => b.avgText - a.avgText).find((s) => s.avgText > 3);
  const currency = pick(HINTS.currency!, () => true);
  const category = pick(HINTS.category!, () => true);
  const time = pick(HINTS.time!, () => true);
  const type = pick(HINTS.type!, (s) => s !== description);
  if (!date || !description) return null;
  const profile: CsvProfile = {
    id: 'custom',
    name: 'Custom mapping',
    headerSignature: headers.filter(Boolean).map(normHeader),
    dateOrder: 'auto',
    amountSign: 'normal',
    columns: {
      date: date.header,
      description: [description.header],
      ...(amount ? { amount: amount.header } : {}),
      ...(debit ? { debit: debit.header } : {}),
      ...(credit ? { credit: credit.header } : {}),
      ...(balance ? { balance: balance.header } : {}),
      ...(currency ? { currency: currency.header } : {}),
      ...(category ? { category: category.header } : {}),
      ...(time ? { time: time.header } : {}),
      ...(type ? { type: type.header } : {}),
    },
  };
  // A card's own export shows purchases as positive and payments to the card as negative. For a
  // file going to a credit card, one amount column is read that way round when its rows fail the
  // card-signs check as they stand and pass it flipped (docs/INGESTION.md).
  if (opts.accountType === 'credit_card' && amount && readsCardStyle(rows, headerIndex, profile)) profile.amountSign = 'inverted';
  const confident = Boolean(amount || (debit && credit)) && /date/.test(date.norm);
  return { profile, headerIndex, headers, sample, confident };
}

/**
 * A built-in layout that names no bank (Date / Description / Amount) says nothing about which way
 * round its signs are. For a file going to a credit card, it is read card style on the same rule as
 * columns worked out automatically. A bank's layout, or one you saved, is kept as it is.
 */
export function withCardSigns(rows: string[][], match: ProfileMatch, accountType: AccountType | undefined): ProfileMatch {
  const p = match.profile;
  if (accountType !== 'credit_card' || !p.builtin || p.institutionId || p.accountType || match.headerless || !p.columns.amount || p.amountSign !== 'normal') return match;
  return readsCardStyle(rows, match.headerIndex, p) ? { ...match, profile: { ...p, amountSign: 'inverted' } } : match;
}

function readsCardStyle(rows: string[][], headerIndex: number, profile: CsvProfile): boolean {
  const txs = parseWithProfile(rows, { profile, headerIndex, headerless: false }).extraction.accounts.flatMap((a) => a.transactions);
  const asRead = cardSigns(txs);
  return asRead !== null && asRead.verdict !== 'ok' && cardSigns(txs.map((t) => ({ ...t, amount: -t.amount })))?.verdict === 'ok';
}
