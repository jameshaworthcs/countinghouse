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

/**
 * An HMRC record's id is what it says (its employer's name reduced, as names are compared), with no
 * import in it: the same payment or code read from two printouts of a page, or the same page twice,
 * is one record, stored once.
 */
export function hmrcId(record: { type: string; employer?: string | undefined }): string {
  const { employer, ...rest } = record;
  const who = (employer ?? '')
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|uk)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return `hmrc_${shortHash('hmrc', who, stableJson(rest))}`;
}

/**
 * A payslip's id is what identifies it, with no import in it: who paid it (your payroll number there,
 * else the employer's name reduced), its pay date and period, and its pay. The same payslip read
 * from two copies, or by two readers, is one record.
 */
export function payslipId(p: { employer: string; payrollNumber?: string | undefined; payDate: string; periodEnd?: string | undefined; periodLabel?: string | undefined; periodNumber?: number | undefined; totals: { payments?: number | undefined; net?: number | undefined } }): string {
  const who =
    p.payrollNumber ??
    p.employer
      .toLowerCase()
      .replace(/\b(ltd|limited|plc|llp|uk)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  const period = p.periodEnd ?? p.periodLabel ?? String(p.periodNumber ?? '');
  const pay = p.totals.net ?? p.totals.payments;
  return `pay_${shortHash('payslip', who, p.payDate, period, pay === undefined ? '' : pay.toFixed(2))}`;
}

/** JSON with keys in order, so equal records give equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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

export function proposalId(now: Date = new Date()): string {
  return importId(now).replace(/^imp_/, 'prop_');
}

export function ruleId(): string {
  return `rule_${Date.now().toString(36)}${randomHex(3)}`;
}

export function transferGroupId(a: string, b: string): string {
  return `tg_${shortHash('tg', ...[a, b].sort())}`;
}
