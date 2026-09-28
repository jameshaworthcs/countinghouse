// QIF (Quicken Interchange Format). Dates are ambiguous (US vs UK order), so the whole file is
// inspected first and the order that makes every date valid wins, preferring UK day-first.

import { parseFlexibleDate, type DateOrder } from '../../shared/dates';
import { parseAmount } from '../../shared/money';
import { ExtractionSchema, type AccountType, type ExtractedTransaction, type Extraction } from '../../shared/schema';

export const QIF_ENGINE_VERSION = 'qif-1';

interface QifRecord {
  fields: Record<string, string>;
  index: number;
}

function normaliseQifDate(s: string): string {
  // Quicken writes 26/9'06 or 9/26'06 for years 2000+.
  return s.replace(/'\s*(\d{1,2})$/, (_m, y: string) => `/20${y.padStart(2, '0')}`).replace(/\s+/g, '');
}

function detectOrder(dates: string[]): { order: DateOrder; ambiguous: boolean } {
  let dmyOk = true;
  let mdyOk = true;
  for (const d of dates) {
    if (!parseFlexibleDate(d, 'DMY')) dmyOk = false;
    if (!parseFlexibleDate(d, 'MDY')) mdyOk = false;
  }
  if (dmyOk) return { order: 'DMY', ambiguous: mdyOk };
  if (mdyOk) return { order: 'MDY', ambiguous: false };
  return { order: 'auto', ambiguous: true };
}

export function parseQif(text: string): Extraction {
  const lines = text.split(/\r?\n/);
  let type = 'Bank';
  const records: QifRecord[] = [];
  let current: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('!')) {
      const m = /^!Type:(\S+)/i.exec(line);
      if (m) type = m[1]!;
      continue;
    }
    if (line.startsWith('^')) {
      if (Object.keys(current).length) records.push({ fields: current, index: records.length });
      current = {};
      continue;
    }
    const code = line[0]!;
    const value = line.slice(1).trim();
    const key = code in current ? `${code}${Object.keys(current).filter((k) => k.startsWith(code)).length + 1}` : code;
    current[key] = value;
  }
  if (Object.keys(current).length) records.push({ fields: current, index: records.length });

  const dates = records.map((r) => normaliseQifDate(r.fields.D ?? '')).filter(Boolean);
  const { order, ambiguous } = detectOrder(dates);
  const notes: string[] = [];
  if (ambiguous && order === 'DMY') notes.push('QIF dates were ambiguous; read as day/month/year (UK). Check a few dates in the review.');

  const txs: ExtractedTransaction[] = [];
  for (const r of records) {
    const date = parseFlexibleDate(normaliseQifDate(r.fields.D ?? ''), order);
    const amount = parseAmount(r.fields.T ?? r.fields.U);
    if (!date || amount === null) {
      notes.push(`Record ${r.index + 1}: no readable date or amount; skipped`);
      continue;
    }
    const payee = r.fields.P;
    const memo = r.fields.M;
    const description = payee && memo && !payee.toLowerCase().includes(memo.toLowerCase()) ? `${payee} · ${memo}` : (payee ?? memo ?? '(no description)');
    txs.push({
      date,
      description,
      amount,
      balanceAfter: null,
      category: null,
      payee: payee ?? null,
      pending: false,
      currency: 'GBP',
      originalAmount: null,
      originalCurrency: null,
      transactionDate: null,
      time: null,
      sourceId: null,
      type: null,
      reference: r.fields.N ?? null,
      counterpartyName: null,
      merchantLocation: null,
      cardLast4: null,
      bankCategory: r.fields.L ?? null,
      fee: null,
      exchangeRate: null,
      raw: r.fields,
      attributes: null,
      merchant: null,
      row: r.index,
    });
  }
  txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const accountType: AccountType = /ccard/i.test(type) ? 'credit_card' : /invst/i.test(type) ? 'gia' : 'current';
  if (/invst/i.test(type)) notes.push('Investment QIF files are imported as cash movements only.');
  return ExtractionSchema.parse({
    documentType: accountType === 'credit_card' ? 'credit_card_statement' : 'bank_statement',
    accounts: [
      {
        accountType,
        currency: 'GBP',
        periodStart: txs[0]?.date ?? null,
        periodEnd: txs[txs.length - 1]?.date ?? null,
        transactions: txs,
      },
    ],
    notes,
    confidence: ambiguous ? 'medium' : 'high',
  });
}
