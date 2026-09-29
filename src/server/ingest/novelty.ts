// Does an import add anything? A document the reader understood can hold nothing to record (a prize
// history), or only what is already recorded, or what another import waiting beside it has (the
// same balance on two tabs of one app). Such an import is "nothing new": said plainly on the review
// page, and dismissed in one action (docs/INGESTION.md, "Nothing new").

import { formatDate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import type { DraftFigure, DraftSection, Holding, ImportRecord } from '../../shared/schema';
import type { Store } from '../store';
import { classifyDuplicates } from './dedup';
import { sameHolding } from './match';
import { sameMoney, sameText } from './verify';

export interface NothingNew {
  /** Why, in words, for the review page. */
  reason: string;
  /** Imports waiting beside it that already have what it shows. */
  coveredBy: { id: string; fileName: string }[];
}

/** The figures recorded with a balance (commitDraft writes them into one snapshot). */
const BALANCE_FIELDS = ['balance', 'availableBalance', 'creditLimit', 'contributions', 'gain', 'cash', 'bonusToDate', 'taxYearContributions', 'annualIncome', 'interestRate'] as const;
type BalanceField = (typeof BALANCE_FIELDS)[number];

type Fact =
  | { kind: 'row'; account: string; date: string; amount: number; description: string }
  | { kind: 'balance'; account: string; date: string; values: Partial<Record<BalanceField, number>> }
  | { kind: 'holding'; account: string; date: string; holding: Holding }
  | { kind: 'figure'; figure: DraftFigure };

/** A fact and where it already is: the stored data, or another import. */
interface Placed {
  fact: Fact;
  stored: boolean;
}

/** Where a section's records would go. A section left to choose can never be covered. */
function accountKey(record: ImportRecord, s: DraftSection): string {
  if (s.target.mode === 'existing') return s.target.accountId;
  if (s.target.mode === 'new') return `new:${s.target.account.id}`;
  return `unassigned:${record.id}:${s.key}`;
}

/** Everything an import would record if committed as it is, each marked if already stored. */
function factsOf(record: ImportRecord, store: Store): Placed[] {
  const draft = record.draft!;
  const out: Placed[] = [];
  for (const s of draft.sections) {
    const account = accountKey(record, s);
    const stored = s.target.mode === 'existing' ? s.target.accountId : undefined;
    // Rows: checked against what is stored now, which may be more than when the draft was built.
    const dups = stored ? classifyDuplicates(s.transactions, store.transactions(stored)) : s.transactions.map(() => ({ status: 'new' as const }));
    // Every row the document offers counts, ticked or not, pending or not: leaving one out is a
    // choice to make on the review page, not a reason to call the document empty.
    s.transactions.forEach((t, i) => out.push({ fact: { kind: 'row', account, date: t.date, amount: t.amount, description: t.description }, stored: dups[i]!.status === 'duplicate' }));
    if (s.recordBalance && s.balance !== undefined && s.balanceDate) {
      const values = Object.fromEntries(BALANCE_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) as Partial<Record<BalanceField, number>>;
      const date = s.balanceDate;
      const held = stored ? store.balances(stored).some((b) => b.date === date && !b.approximate && BALANCE_FIELDS.every((k) => values[k] === undefined || sameMoney(values[k], b[k]))) : false;
      out.push({ fact: { kind: 'balance', account, date, values }, stored: held });
    }
    if (s.recordHoldings && s.balanceDate) {
      const day = stored ? store.holdings(stored).filter((h) => h.date === s.balanceDate) : [];
      for (const h of s.holdings) out.push({ fact: { kind: 'holding', account, date: s.balanceDate, holding: h }, stored: day.some((snap) => snap.holdings.some((x) => sameHoldingFigures(h, x))) });
    }
  }
  for (const f of draft.figures) if (f.include || f.duplicateOf) out.push({ fact: { kind: 'figure', figure: f }, stored: Boolean(f.duplicateOf) });
  return out;
}

function sameHoldingFigures(a: Holding, b: Holding): boolean {
  return sameHolding(a, b) && sameMoney(a.value, b.value) && (a.units === undefined || b.units === undefined || Math.abs(a.units - b.units) < 0.0005);
}

/** Does `k`, a fact another import will record, record `f` too? */
function covers(k: Fact, f: Fact): boolean {
  if (k.kind === 'row' && f.kind === 'row') return k.account === f.account && k.date === f.date && sameMoney(k.amount, f.amount) && sameText(k.description, f.description);
  if (k.kind === 'balance' && f.kind === 'balance') return k.account === f.account && k.date === f.date && BALANCE_FIELDS.every((x) => f.values[x] === undefined || sameMoney(f.values[x], k.values[x]));
  if (k.kind === 'holding' && f.kind === 'holding') return k.account === f.account && k.date === f.date && sameHoldingFigures(f.holding, k.holding);
  if (k.kind === 'figure' && f.kind === 'figure') {
    const [a, b] = [k.figure, f.figure];
    return a.kind === b.kind && sameMoney(a.amount, b.amount) && (a.taxYear ?? '') === (b.taxYear ?? '') && (a.periodEnd ?? '') === (b.periodEnd ?? '') && (a.payer ?? '').toLowerCase() === (b.payer ?? '').toLowerCase();
  }
  return false;
}

/** Not to be called empty: the reading itself needs a look. */
function doubtful(r: ImportRecord): boolean {
  const v = r.extraction.verification;
  return r.draft?.confidence === 'low' || r.extraction.warnings.length > 0 || Boolean(v?.disagreements.length) || Boolean(v?.error) || r.extraction.engine === 'ocr';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "its balance (£1,250.00 on 29 Sep 2026) is also on IMG_0102.png, and its 5 transactions are already imported". */
function describe(facts: { fact: Fact; where: string }[]): string {
  const groups = new Map<string, Fact[]>();
  for (const { fact, where } of facts) {
    const key = `${fact.kind}|${where}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(fact);
  }
  const parts = [...groups.entries()].map(([key, list]) => {
    const [kind, where] = key.split('|') as [Fact['kind'], string];
    const place = where === 'stored' ? 'already recorded' : `also on ${where}`;
    if (kind === 'balance') {
      const b = list[0] as Extract<Fact, { kind: 'balance' }>;
      const value = b.values.balance !== undefined ? ` (${formatMoney(b.values.balance)} on ${formatDate(b.date)})` : '';
      return list.length === 1 ? `its balance${value} is ${place}` : `its ${list.length} balances are ${place}`;
    }
    if (kind === 'row') return `${list.length === 1 ? 'its transaction is' : `its ${plural(list.length, 'transaction')} are`} ${where === 'stored' ? 'already imported' : place}`;
    if (kind === 'holding') return `${list.length === 1 ? 'its holding is' : `its ${plural(list.length, 'holding')} are`} ${place}`;
    return `${list.length === 1 ? 'its tax figure is' : `its ${plural(list.length, 'tax figure')} are`} ${place}`;
  });
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return `Everything on it is already here: ${text}.`;
}

/**
 * Which imports waiting for review add nothing new. Richer imports are taken first, so of two that
 * show the same balance, the one with the rows is kept and the other is the one with nothing new;
 * of two identical ones, the earlier upload is kept.
 */
export function assessNovelty(pending: ImportRecord[], store: Store): Map<string, NothingNew> {
  const out = new Map<string, NothingNew>();
  const candidates = pending
    .filter((r) => r.status === 'review' && r.draft)
    .map((r) => ({ r, facts: factsOf(r, store), doubtful: doubtful(r) }))
    .sort(
      (a, b) =>
        Number(b.doubtful) - Number(a.doubtful) ||
        b.facts.filter((f) => !f.stored).length - a.facts.filter((f) => !f.stored).length ||
        a.r.createdAt.localeCompare(b.r.createdAt) ||
        (a.r.document.capturedAt ?? '').localeCompare(b.r.document.capturedAt ?? '') ||
        a.r.id.localeCompare(b.r.id),
    );
  // What the imports being kept will record, and which import each fact comes from.
  const kept: { fact: Fact; from: ImportRecord }[] = [];
  for (const { r, facts, doubtful } of candidates) {
    const draft = r.draft!;
    const fresh = facts.filter((f) => !f.stored);
    if (doubtful) {
      kept.push(...fresh.map((f) => ({ fact: f.fact, from: r })));
      continue;
    }
    if (!draft.sections.length && !draft.figures.length) {
      // Understood, and nothing to record: the reader says what it is. With no such words, it was
      // not understood, and stays a document to look at.
      if (draft.nothingToRecord) out.set(r.id, { reason: draft.nothingToRecord, coveredBy: [] });
      continue;
    }
    const used = new Set<number>();
    const placed: { fact: Fact; where: string }[] = [];
    const coveredBy = new Map<string, { id: string; fileName: string }>();
    let fresher = false;
    for (const f of facts) {
      if (f.stored) {
        placed.push({ fact: f.fact, where: 'stored' });
        continue;
      }
      const i = kept.findIndex((k, n) => !used.has(n) && covers(k.fact, f.fact));
      if (i < 0) {
        fresher = true;
        break;
      }
      used.add(i);
      const from = kept[i]!.from;
      coveredBy.set(from.id, { id: from.id, fileName: from.document.fileName });
      placed.push({ fact: f.fact, where: from.document.fileName });
    }
    if (fresher || !placed.length) {
      kept.push(...fresh.map((f) => ({ fact: f.fact, from: r })));
      continue;
    }
    out.set(r.id, { reason: describe(placed), coveredBy: [...coveredBy.values()] });
  }
  return out;
}
