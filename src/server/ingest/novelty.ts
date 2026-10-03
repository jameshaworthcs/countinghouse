// Does an import add anything? A document the reader understood can hold nothing to record (a prize
// history), or only what is already recorded, or what another import waiting beside it has (the
// same balance on two tabs of one app). Such an import is "nothing new": said plainly on the review
// page, and dismissed in one action (docs/INGESTION.md, "Nothing new").

import { AGREEMENT_RECEIPT_DAYS } from '../../shared/agreements';
import { diffDays, formatDate, parseFlexibleDate } from '../../shared/dates';
import { formatMoney, parseAmount, toMinor } from '../../shared/money';
import type { Agreement, DraftFigure, DraftSection, Holding, ImportRecord } from '../../shared/schema';
import type { Store } from '../store';
import { addsAnything, detailToAdd, stillAdds, type DetailFields } from '../../shared/detail';
import { candidateOf, classifyDuplicates, type DedupResult } from './dedup';
import { sameHolding } from './match';
import { sameMoney, sameText } from './verify';
import { hmrcId, payslipId } from '../ids';
import { sameTerms, termsOfReading, type TermsContent } from '../../shared/terms';

export interface NothingNew {
  /** Why, in words, for the review page. */
  reason: string;
  /** Imports waiting beside it that already have what it shows. */
  coveredBy: { id: string; fileName: string }[];
}

/** The figures recorded with a balance (commitDraft writes them into one snapshot). */
const BALANCE_FIELDS = ['balance', 'availableBalance', 'contributions', 'gain', 'cash', 'bonusToDate', 'taxYearContributions', 'annualIncome'] as const;
type BalanceField = (typeof BALANCE_FIELDS)[number];

type Fact =
  // `adds`: what the row fills in on the payment it matches (shared/detail.ts).
  | { kind: 'row'; account: string; date: string; amount: number; description: string; adds?: DetailFields }
  | { kind: 'balance'; account: string; date: string; values: Partial<Record<BalanceField, number>> }
  // An account's terms on a day (its rates, limit and minimum payment): kept whether or not its balance is.
  | { kind: 'terms'; account: string; date: string; terms: TermsContent }
  | { kind: 'holding'; account: string; date: string; holding: Holding }
  | { kind: 'figure'; figure: DraftFigure }
  // An HMRC record is known by what it says (ids.ts, `hmrcId`).
  | { kind: 'hmrc'; id: string; what: string }
  // A payslip in full is known by what identifies it (ids.ts, `payslipId`).
  | { kind: 'payslip'; id: string }
  // A schedule, as the agreement it records: known by who, what and its payments.
  | { kind: 'agreement'; key: string; name: string };

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
    const dups: DedupResult[] = stored ? classifyDuplicates(s.transactions.map(candidateOf), store.transactions(stored)) : s.transactions.map(() => ({ status: 'new' as const }));
    // Every row the document offers counts, ticked or not, pending or not: leaving one out is a
    // choice to make on the review page, not a reason to call the document empty. A row already
    // recorded that fills in some of the record's details is something to record too.
    s.transactions.forEach((t, i) => {
      const dup = dups[i]!;
      const recorded = dup.status === 'duplicate' && dup.duplicateOf && !dup.sum ? store.transaction(dup.duplicateOf) : undefined;
      const found = recorded ? detailToAdd(t, recorded) : undefined;
      const adds = found && addsAnything(found) ? found.fields : undefined;
      out.push({ fact: { kind: 'row', account, date: t.date, amount: t.amount, description: t.description, ...(adds ? { adds } : {}) }, stored: dup.status === 'duplicate' && !adds });
    });
    if (s.recordBalance && s.balance !== undefined && s.balanceDate) {
      const values = Object.fromEntries(BALANCE_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) as Partial<Record<BalanceField, number>>;
      const date = s.balanceDate;
      const held = stored ? store.balances(stored).some((b) => b.date === date && !b.approximate && BALANCE_FIELDS.every((k) => values[k] === undefined || sameMoney(values[k], b[k]))) : false;
      out.push({ fact: { kind: 'balance', account, date, values }, stored: held });
    }
    const type = s.target.mode === 'new' ? s.target.account.type : ((stored ? store.account(stored)?.type : undefined) ?? s.detected.accountType ?? 'current');
    const terms = termsOfReading(s, type);
    const termsDate = s.balanceDate ?? s.periodEnd ?? draft.documentDate;
    if (terms && termsDate) {
      const held = stored ? store.terms(stored).some((t) => t.asOf === termsDate && sameTerms(t, terms)) : false;
      out.push({ fact: { kind: 'terms', account, date: termsDate, terms }, stored: held });
    }
    // A forecast with no balance is recorded as a figure on its account (ingest/commit.ts).
    if (s.annualIncome !== undefined && s.balanceDate && !(s.recordBalance && s.balance !== undefined)) {
      const figure: DraftFigure = { key: `${s.key}:forecast`, include: true, kind: 'pension_income_forecast', label: 'Forecast income per year', amount: s.annualIncome, currency: s.currency, periodEnd: s.balanceDate, payer: account };
      const held = stored ? store.figures.some((f) => f.kind === 'pension_income_forecast' && f.accountId === stored && f.date === s.balanceDate && sameMoney(f.amount, s.annualIncome)) : false;
      out.push({ fact: { kind: 'figure', figure }, stored: held });
    }
    if (s.recordHoldings && s.balanceDate) {
      const day = stored ? store.holdings(stored).filter((h) => h.date === s.balanceDate) : [];
      for (const h of s.holdings) out.push({ fact: { kind: 'holding', account, date: s.balanceDate, holding: h }, stored: day.some((snap) => snap.holdings.some((x) => holdingKnown(h, x))) });
    }
  }
  for (const f of draft.figures) if (f.include || f.duplicateOf) out.push({ fact: { kind: 'figure', figure: f }, stored: Boolean(f.duplicateOf) });
  for (const h of draft.hmrc ?? []) if (h.include || h.duplicateOf) out.push({ fact: { kind: 'hmrc', id: hmrcId(h.record), what: h.record.type }, stored: Boolean(h.duplicateOf) });
  for (const p of draft.payslips ?? []) if (p.include || p.duplicateOf) out.push({ fact: { kind: 'payslip', id: payslipId(p.record) }, stored: Boolean(p.duplicateOf) });
  // A schedule that adds nothing to the agreement recorded already (it is not ticked) is stored.
  for (const a of draft.agreements ?? []) out.push({ fact: { kind: 'agreement', key: agreementKey(a.record), name: a.record.name }, stored: !a.include });
  return out;
}

/** What makes two schedules one: the way round, the counterparty, and the payments with their statuses. */
function agreementKey(a: Pick<Agreement, 'direction' | 'counterparty' | 'payments'>): string {
  const payments = a.payments.map((p) => `${p.due}:${toMinor(p.amount)}:${p.status ?? ''}`).sort();
  return `${a.direction ?? 'out'}|${a.counterparty.toLowerCase()}|${payments.join(',')}`;
}

/** "14 September 2026", "14 Sep 2026", "14/09/2026" in a piece of text. */
const DAY_IN_TEXT = /\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/;
/** "£1,236.70" in a piece of text. */
const MONEY_IN_TEXT = /£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;

/**
 * Payments a reading mentions that are recorded already, by exact amount within 7 days, though it
 * gave them no place (an older reader had none for a schedule): from its printed values (a date in
 * the label or value, an amount in the value) and its remarks ("14 Sep 2026 £1,236.70 Paid").
 */
export function mentionedPayments(r: ImportRecord, store: Store): { date: string; amount: number; transactionId: string; accountId: string }[] {
  const raw = r.extraction.raw;
  if (!raw) return [];
  const pairs: { date: string; amount: number }[] = [];
  const add = (dateText: string | undefined, moneyText: string | undefined) => {
    const date = dateText ? parseFlexibleDate(dateText) : undefined;
    const amount = moneyText ? parseAmount(moneyText) : null;
    if (date && amount !== null && amount !== 0) pairs.push({ date, amount: Math.abs(amount) });
  };
  for (const p of raw.printed) add(DAY_IN_TEXT.exec(`${p.label} ${p.value}`)?.[1], MONEY_IN_TEXT.exec(p.value)?.[0]);
  for (const note of raw.notes) {
    for (const m of note.matchAll(new RegExp(`${DAY_IN_TEXT.source}[^£;]{0,12}${MONEY_IN_TEXT.source}`, 'g'))) add(m[1], `£${m[2]}`);
  }
  const out: { date: string; amount: number; transactionId: string; accountId: string }[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const t = store.transactions().find((x) => !seen.has(x.id) && toMinor(Math.abs(x.amount)) === toMinor(p.amount) && Math.abs(diffDays(x.date, p.date)) <= AGREEMENT_RECEIPT_DAYS);
    if (!t) continue;
    seen.add(t.id);
    out.push({ date: t.date, amount: t.amount, transactionId: t.id, accountId: t.accountId });
  }
  return out;
}

/**
 * Does `known` already have everything `fresh` says about the holding? A fund's own page adds units
 * and the amount invested to what an overview showed of it: that is new, even at the same value.
 */
function holdingKnown(fresh: Holding, known: Holding): boolean {
  if (!sameHolding(fresh, known)) return false;
  const money = (['value', 'price', 'costBasis', 'gain'] as const).every((k) => fresh[k] === undefined || sameMoney(fresh[k], known[k]));
  const units = fresh.units === undefined || (known.units !== undefined && Math.abs(fresh.units - known.units) < 0.0005);
  const ids = (['isin', 'sedol', 'ticker'] as const).every((k) => !fresh[k] || fresh[k].toUpperCase() === known[k]?.toUpperCase());
  return money && units && ids;
}

/** Everything `fresh` would fill in, `known` fills in too, with the same values. */
function addsNoMore(fresh: DetailFields | undefined, known: DetailFields | undefined): boolean {
  return !fresh || JSON.stringify(stillAdds(known ?? {}, fresh)) === JSON.stringify(fresh);
}

/** Does `k`, a fact another import will record, record `f` too? */
function covers(k: Fact, f: Fact): boolean {
  if (k.kind === 'row' && f.kind === 'row') return k.account === f.account && k.date === f.date && sameMoney(k.amount, f.amount) && sameText(k.description, f.description) && addsNoMore(f.adds, k.adds);
  if (k.kind === 'balance' && f.kind === 'balance') return k.account === f.account && k.date === f.date && BALANCE_FIELDS.every((x) => f.values[x] === undefined || sameMoney(f.values[x], k.values[x]));
  if (k.kind === 'holding' && f.kind === 'holding') return k.account === f.account && k.date === f.date && holdingKnown(f.holding, k.holding);
  if (k.kind === 'terms' && f.kind === 'terms') return k.account === f.account && k.date === f.date && sameTerms(k.terms, f.terms);
  if (k.kind === 'hmrc' && f.kind === 'hmrc') return k.id === f.id;
  if (k.kind === 'payslip' && f.kind === 'payslip') return k.id === f.id;
  if (k.kind === 'agreement' && f.kind === 'agreement') return k.key === f.key;
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
    if (kind === 'row') {
      const detail = list.some((f) => f.kind === 'row' && f.adds) && where !== 'stored' ? ', with the details it adds' : '';
      return `${list.length === 1 ? 'its transaction is' : `its ${plural(list.length, 'transaction')} are`} ${where === 'stored' ? 'already imported' : place}${detail}`;
    }
    if (kind === 'holding') return `${list.length === 1 ? 'its holding is' : `its ${plural(list.length, 'holding')} are`} ${place}`;
    if (kind === 'terms') return `${list.length === 1 ? 'its terms (rates and limit) are' : `its terms for ${plural(list.length, 'account')} are`} ${place}`;
    if (kind === 'hmrc') return `${list.length === 1 ? 'its HMRC record is' : `its ${plural(list.length, 'HMRC record')} are`} ${place}`;
    if (kind === 'payslip') return `${list.length === 1 ? 'the payslip is' : `its ${plural(list.length, 'payslip')} are`} ${place}`;
    if (kind === 'agreement') return `${list.length === 1 ? `its schedule (${(list[0] as Extract<Fact, { kind: 'agreement' }>).name}) is` : `its ${plural(list.length, 'schedule')} are`} ${place}`;
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
    // Taking away a copy recorded twice is something to do, even with nothing to add.
    if (doubtful || draft.sections.some((s) => s.extraCopies?.some((c) => c.remove))) {
      kept.push(...fresh.map((f) => ({ fact: f.fact, from: r })));
      continue;
    }
    if (!draft.sections.length && !draft.figures.length && !draft.hmrc?.length && !draft.payslips?.length && !draft.agreements?.length) {
      // Understood, and nothing to record: the reader says what it is. With no such words, it was
      // not understood, and stays a document to look at; so does one that mentions payments already
      // recorded, which its reading had no place for (read it again).
      if (draft.nothingToRecord && !mentionedPayments(r, store).length) out.set(r.id, { reason: draft.nothingToRecord, coveredBy: [] });
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
