// A stored document read again, compared with what its import recorded (docs/INGESTION.md, "Reading
// a stored document again"). The comparison is all this does: each difference is applied only when
// you choose, as a recorded correction or a new row, and nothing is ever deleted. A CSV or
// spreadsheet is parsed again on this machine, with the layout that fits it now.

import type { RereadRow, RereadSection } from '../../shared/api';
import { diffDays } from '../../shared/dates';
import { descriptionKey } from '../../shared/merchants';
import { toMinor } from '../../shared/money';
import type { Draft, ImportRecord, Transaction } from '../../shared/schema';
import type { Store } from '../store';
import { similarity } from './dedup';

/** How far apart a row's two dates can be and still be the same row read differently. */
const DATE_SLACK_DAYS = 7;

/** A row as read now. `row` (its line in a CSV) and `balanceAfter` come from files parsed here. */
type ReadRow = { date: string; amount: number; description: string; row?: number | undefined; balanceAfter?: number | undefined; type?: string | undefined };

/**
 * Pair what was read now with what is stored, for one account:
 * 0. with `byRow` (a file parsed on this machine, whose rows keep their places): the row this import
 *    recorded from the same line, the same row whatever changed;
 * 1. the same row: same date, amount and description, or same date, amount and balance after it
 *    (recorded by this import or another);
 * 2. a row of this import read differently: same amount and description a few days apart (its
 *    date), same date and description (its amount), or same date and amount with a similar
 *    description;
 * 3. what is left: read now and not recorded (added), or recorded by this import and not read now
 *    (missing).
 */
export function compareRows(read: ReadRow[], stored: Transaction[], importId: string, opts: { byRow?: boolean } = {}): RereadRow[] {
  const out: RereadRow[] = [];
  const key = (r: ReadRow) => `${r.date}|${toMinor(r.amount)}|${descriptionKey(r.description)}`;
  const sameBalance = (t: Transaction, r: ReadRow) => t.date === r.date && toMinor(t.amount) === toMinor(r.amount) && t.balanceAfter !== undefined && r.balanceAfter !== undefined && toMinor(t.balanceAfter) === toMinor(r.balanceAfter);
  const left = new Set(stored.map((t) => t.id));
  const pending: { r: ReadRow; i: number }[] = [];
  const shown = (r: ReadRow) => ({ date: r.date, amount: r.amount, description: r.description, ...(r.type ? { type: r.type } : {}) });
  const settle = (t: Transaction, r: ReadRow, i: number) => {
    left.delete(t.id);
    const changes = (['date', 'amount', 'description'] as const).filter((f) => (f === 'amount' ? toMinor(t.amount) !== toMinor(r.amount) : t[f] !== r[f]));
    out.push({ key: `r${i}`, kind: changes.length ? 'changed' : 'same', stored: pick(t), read: shown(r), ...(changes.length ? { changes } : {}) });
  };
  const byRow = new Set<number>();
  if (opts.byRow) {
    read.forEach((r, i) => {
      const t = r.row !== undefined ? stored.find((x) => left.has(x.id) && x.source.importId === importId && x.source.row === r.row) : undefined;
      if (!t) return;
      byRow.add(i);
      settle(t, r, i);
    });
  }
  read.forEach((r, i) => {
    if (byRow.has(i)) return;
    const same = stored.find((t) => left.has(t.id) && (key(t) === key(r) || sameBalance(t, r)));
    if (same) {
      left.delete(same.id);
      out.push({ key: `r${i}`, kind: 'same', stored: pick(same), read: shown(r) });
    } else pending.push({ r, i });
  });
  const mine = () => stored.filter((t) => left.has(t.id) && t.source.importId === importId);
  for (const { r, i } of pending) {
    const dk = descriptionKey(r.description);
    const candidates = mine();
    const byDate = candidates.find((t) => toMinor(t.amount) === toMinor(r.amount) && descriptionKey(t.description) === dk && Math.abs(diffDays(t.date, r.date)) <= DATE_SLACK_DAYS);
    const byAmount = byDate ?? candidates.find((t) => t.date === r.date && descriptionKey(t.description) === dk);
    const byText = byAmount ?? candidates.find((t) => t.date === r.date && toMinor(t.amount) === toMinor(r.amount) && similarity(t.description, r.description) >= 0.4);
    if (byText) settle(byText, r, i);
    else out.push({ key: `r${i}`, kind: 'added', read: shown(r) });
  }
  for (const t of mine()) out.push({ key: `m-${t.id}`, kind: 'missing', stored: pick(t) });
  return out.sort((a, b) => (a.read?.date ?? a.stored!.date).localeCompare(b.read?.date ?? b.stored!.date));
}

const pick = (t: Transaction) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description });

/**
 * Compare a new reading's draft with what the import recorded, section by section: each section is
 * matched to the account the import put it in (else the draft's own match).
 */
export function compareReading(store: Store, record: ImportRecord, draft: Draft, opts: { byRow?: boolean } = {}): { sections: RereadSection[]; notes: string[] } {
  const notes: string[] = [];
  const committedTo = new Map((record.result?.sections ?? []).map((s) => [s.key, s.accountId]));
  const sections: RereadSection[] = [];
  const seen = new Set<string>();
  for (const s of draft.sections) {
    const accountId = committedTo.get(s.key) ?? (s.target.mode === 'existing' ? s.target.accountId : undefined) ?? (record.result?.accountIds.length === 1 ? record.result.accountIds[0] : undefined);
    if (!accountId || !store.account(accountId)) {
      notes.push(`A section read now (${s.detected.accountName ?? s.detected.institutionName ?? 'an account'}) matches none of the accounts this import went to.`);
      continue;
    }
    seen.add(accountId);
    const read = s.transactions.filter((t) => !t.pending).map((t) => ({ date: t.date, amount: t.amount, description: t.description, row: t.row, balanceAfter: t.balanceAfter, type: t.detail?.type }));
    const dates = read.map((r) => r.date).sort();
    const recorded = store.transactions(accountId).filter((t) => t.source.importId === record.id);
    const nearby = dates.length ? store.transactions(accountId).filter((t) => Math.abs(diffDays(t.date, dates[0]!)) <= DATE_SLACK_DAYS || Math.abs(diffDays(t.date, dates[dates.length - 1]!)) <= DATE_SLACK_DAYS || (t.date >= dates[0]! && t.date <= dates[dates.length - 1]!)) : [];
    const stored = [...new Map([...recorded, ...nearby].map((t) => [t.id, t])).values()];
    const rows = compareRows(read, stored, record.id, opts);
    const bal = store.balances(accountId).find((b) => b.source.importId === record.id);
    const readBal = s.balance !== undefined && s.recordBalance && s.balanceDate ? { date: s.balanceDate, balance: s.balance } : null;
    const balance = bal || readBal ? { stored: bal ? { id: bal.id, date: bal.date, balance: bal.balance } : null, read: readBal, changed: !bal || !readBal || bal.date !== readBal.date || toMinor(bal.balance) !== toMinor(readBal.balance) } : null;
    sections.push({ accountId, accountName: store.account(accountId)!.name, rows, balance });
  }
  for (const id of record.result?.accountIds ?? []) {
    if (seen.has(id)) continue;
    const recorded = store.transactions(id).filter((t) => t.source.importId === record.id);
    if (recorded.length) sections.push({ accountId: id, accountName: store.account(id)?.name ?? id, rows: recorded.map((t) => ({ key: `m-${t.id}`, kind: 'missing' as const, stored: pick(t) })), balance: null });
  }
  return { sections, notes };
}
