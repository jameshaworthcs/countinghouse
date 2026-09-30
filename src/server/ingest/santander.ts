// Santander UK "Text" statement export:
//
//   From: 01/09/2026 to 30/09/2026
//   Account: XXXX XXXX XXXX 1234
//   Date: 01/09/2026
//   Description: CARD PAYMENT TO TESCO STORES 2231,12.34 GBP, RATE 1.00/GBP ON 30-08-2026
//   Amount: -12.34
//   Balance: 1234.56

import { formatDate, parseFlexibleDate } from '../../shared/dates';
import { parseAmount, roundMoney } from '../../shared/money';
import { ExtractionSchema, type ExtractedTransaction, type Extraction } from '../../shared/schema';

export const SANTANDER_ENGINE_VERSION = 'santander-txt-2';

/**
 * Santander's text export holds at most this many transactions. A full file of them stops at its
 * oldest row, however far back its header's "From" date is: the rest of the period is not in it.
 */
export const SANTANDER_MAX_ROWS = 600;

export function parseSantanderTxt(text: string): Extraction {
  const lines = text.replace(/\u00a0/g, ' ').split(/\r?\n/);
  const period = /From:\s*(\S+)\s+to\s+(\S+)/i.exec(text);
  const account = /Account:\s*([^\n]+)/i.exec(text);
  const records: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of lines) {
    const m = /^\s*(Date|Description|Amount|Balance)\s*:\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (key === 'date') {
      if (current) records.push(current);
      current = {};
    }
    if (current) current[key] = m[2]!.trim();
  }
  if (current) records.push(current);

  const notes: string[] = [];
  const txs: ExtractedTransaction[] = [];
  records.forEach((r, i) => {
    const date = parseFlexibleDate(r.date, 'DMY');
    const amount = parseAmount(r.amount?.replace(/GBP/i, ''));
    if (!date || amount === null) {
      notes.push(`Record ${i + 1}: unreadable date or amount; skipped`);
      return;
    }
    txs.push({
      date,
      description: r.description || '(no description)',
      amount,
      balanceAfter: parseAmount(r.balance?.replace(/GBP/i, '')),
      category: null,
      payee: null,
      pending: false,
      currency: 'GBP',
      originalAmount: null,
      originalCurrency: null,
      transactionDate: null,
      time: null,
      sourceId: null,
      type: null,
      reference: null,
      counterpartyName: null,
      merchantLocation: null,
      cardLast4: null,
      bankCategory: null,
      fee: null,
      exchangeRate: null,
      raw: Object.fromEntries(Object.entries(r).map(([k, v]) => [k[0]!.toUpperCase() + k.slice(1), v])),
      attributes: null,
      merchant: null,
      row: i,
      uncertain: null,
    });
  });
  // Santander lists newest first; store chronologically.
  if (txs.length > 1 && txs[0]!.date > txs[txs.length - 1]!.date) txs.reverse();
  const last = txs[txs.length - 1];
  const first = txs[0];
  // A full export covers from its oldest row, not from its header's date: saying otherwise would
  // count days it does not have as covered (docs/INGESTION.md, the formats table).
  const from = parseFlexibleDate(period?.[1], 'DMY');
  const cut = records.length >= SANTANDER_MAX_ROWS && first && from && first.date > from;
  if (cut) {
    notes.push(
      `Santander exports at most ${SANTANDER_MAX_ROWS} transactions, and this file has ${records.length}, so it starts on ${formatDate(first.date)}, not ${formatDate(from)} as its header says. Transactions between those dates are not in it: download that period separately.`,
    );
  }
  return ExtractionSchema.parse({
    documentType: 'bank_statement',
    institutionName: 'Santander UK',
    accounts: [
      {
        institutionName: 'Santander UK',
        accountType: 'current',
        last4: account?.[1]?.replace(/\D/g, '').slice(-4) || null,
        currency: 'GBP',
        periodStart: cut ? first.date : from,
        periodEnd: parseFlexibleDate(period?.[2], 'DMY'),
        openingBalance: first?.balanceAfter != null ? roundMoney(first.balanceAfter - first.amount) : null,
        closingBalance: last?.balanceAfter ?? null,
        balanceDate: last?.date ?? null,
        transactions: txs,
      },
    ],
    notes,
    confidence: 'high',
  });
}
