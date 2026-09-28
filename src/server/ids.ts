// Identifier generation. Record ids are content hashes assigned once, when the record is created,
// so they are stable forever (editing a record never changes its id).

import { randomHex, shortHash } from './fsutil';

/**
 * Transactions from an import include the import id, so committing the same import twice (a retry
 * after a failure) produces the same ids and adds nothing twice. Hand-entered ones have no import.
 */
export function transactionId(accountId: string, date: string, amount: number, description: string, occurrence: number, importId?: string): string {
  return importId ? `tx_${shortHash('tx', accountId, date, amount.toFixed(2), description, occurrence, importId)}` : `tx_${shortHash('tx', accountId, date, amount.toFixed(2), description, occurrence)}`;
}

export function balanceId(accountId: string, date: string, balance: number, kind: string, salt = ''): string {
  return `bal_${shortHash('bal', accountId, date, balance.toFixed(2), kind, salt)}`;
}

export function holdingsId(accountId: string, date: string, totalValue: number, salt = ''): string {
  return `hld_${shortHash('hld', accountId, date, totalValue.toFixed(2), salt)}`;
}

export function figureId(kind: string, amount: number, period: string, payer: string, label: string, salt = ''): string {
  return `fig_${shortHash('fig', kind, amount.toFixed(2), period, payer, label, salt)}`;
}

export function documentId(sha256: string): string {
  return `doc_${sha256.slice(0, 16)}`;
}

export function importId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `imp_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${randomHex(2)}`;
}

export function ruleId(): string {
  return `rule_${Date.now().toString(36)}${randomHex(3)}`;
}

export function transferGroupId(a: string, b: string): string {
  return `tg_${shortHash('tg', ...[a, b].sort())}`;
}
