// Proposed fixes (docs/AGENTS.md, "Proposing fixes"): changes an agent found reasons for in your
// data, each with its reason, waiting for you. Nothing changes until you apply one, and you can
// leave any of its changes out.
//
// - An agent proposes through POST /api/proposals with its token, or, running in the app, through
//   `ProposalService.create` from its job. Either way the proposal is checked the same way.
// - A proposal waits in the work area. One you apply or dismiss is kept in data/proposals, with the
//   rows and accounts it changed as they were before: the record of what changed, why and who said so.
// - It is checked against the data when it is made, whenever it is shown, and when you apply it: its
//   changes run in order on a copy, and each must still fit. A change your data already agrees with
//   is marked as already so, and applying skips it.
// - One your data comes to say all of (an import or an edit got there first) closes by itself as
//   already done (`superseded`), kept in data/proposals like the others. That is not a no: only a
//   dismissal stops the same changes being proposed again.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProposalBalance, ProposalChangeView, ProposalCheckResponse, ProposalDecision, ProposalListResponse, ProposalRow, ProposalRuleExample, ProposalSummary, ProposalView } from '../shared/api';
import { ACCOUNT_TYPE_META } from '../shared/accounts';
import { agreementPattern, isScheduledPayment } from '../shared/agreements';
import { CategoryIndex } from '../shared/categories';
import { Categoriser, isWrapperAccount, transferLegCategory } from '../shared/categorise';
import { addDays, diffDays, formatDate, today } from '../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../shared/money';
import { sameTerms, type TermsContent } from '../shared/terms';
import { AccountSchema, AgreementSchema, BalanceSnapshotSchema, CompanySchema, EmploymentSchema, ProposalSchema, TermsSchema, type Account, type Agreement, type BalanceSnapshot, type Category, type Company, type Terms, type Employment, type PensionArrangement, type Proposal, type ProposalInput, type ProposalStatus, type ProposedChange, type Provenance, type Rule, type Transaction } from '../shared/schema';
import { paidToText } from './analytics/agreements';
import { BalanceEngine, type BalanceSource } from './analytics/balances';
import { runAs } from './audit';
import { categoriseInputOf, categoriserFor, ruleCatches } from './categoriser';
import { nextPayee } from './enrich';
import { atomicWrite, Mutex, nowISO } from './fsutil';
import { balanceId, proposalId, termsId, transferGroupId } from './ids';
import { StoreError, type DecidedProposalSummary, type Store } from './store';

/** Days apart the two rows of a proposed transfer may be: a card payment can take a few days. */
const LINK_DAYS = 10;
/** Days apart a duplicate and the rows it repeats may be. */
const DUPLICATE_DAYS = 10;
/** Proposals waiting at once: an agent that keeps proposing is stopped here, not in your queue. */
const MAX_PENDING = 50;
/** Quiet after a change to the data before checking which proposals it finished. */
const SWEEP_AFTER_MS = 1000;

/** Changes that do not fit the data, each with its reason. */
export class ProposalProblems extends StoreError {
  constructor(
    message: string,
    readonly problems: { key: string; problem: string }[],
    status = 422,
  ) {
    super(message, status);
  }
}

interface ChangeResult {
  problem?: string;
  alreadySo?: true;
  /** A link's rows as it leaves them: their category, and the account each is a transfer with. */
  after?: Record<string, { category?: string; transferWith: string }>;
  /** A move inside an account: the balances either side of it, which add up without it. */
  between?: { from: { date: string; balance: number }; to: { date: string; balance: number } };
  /** A balance moved: why it is not the account's it is in, and the balances it adds up with where it goes. */
  moved?: { misfit: string; beside: { date: string; balance: number }[] };
  /** An agreement added: the payments in your data it files under its category, with the category each has now. */
  files?: { transactionId: string; accountId: string; date: string; amount: number; category?: string }[];
  /** Terms set: the document they are from, and the terms its reading kept, which they replace. */
  terms?: { fileName?: string; before?: TermsContent };
  /** A rule made: the payments it categorises now, the guesses in its category it settles, and how many of yours it matches but leaves. */
  rule?: { count: number; amount: number; examples: ProposalRuleExample[]; settles: number; yours: number };
  /** A category added or changed: its group after, and how it was. */
  category?: { group?: string; was?: { name: string; group?: string } };
}

interface Outcome {
  results: Map<string, ChangeResult>;
  /** Changes to rows that stay, by id ("undefined" clears a field). */
  patches: Map<string, Partial<Transaction>>;
  /** Rows to remove, as they are now. */
  removed: Map<string, Transaction>;
  /** Accounts as they will be. */
  accounts: Map<string, Account>;
  /** Every row and account the changes touch, as they are now. */
  touchedRows: Map<string, Transaction>;
  touchedAccounts: Map<string, Account>;
  /** Balances to move, by id: to which account, and from which (as the changes before it left it). */
  moves: Map<string, { balance: BalanceSnapshot; from: string; to: string }>;
  /** Companies to add, and the balances (their valuations) to record on their new accounts. */
  companies: Map<string, Company>;
  /** Jobs as they will be (a pension arrangement added). */
  jobs: Map<string, Employment>;
  balances: BalanceSnapshot[];
  /** Agreements to add. */
  agreements: Map<string, Agreement>;
  /** Terms records to write, by id; those to take away (a balance's moved with it), as they are now. */
  terms: Map<string, Terms>;
  termsRemoved: Map<string, Terms>;
  /** Rules to add, in order. */
  rules: Rule[];
  /** Your categories as they will be, when a change adds or changes one; those it changes, as they are now. */
  categories?: Category[];
  categoriesBefore: Map<string, Category>;
}

/** Rows a rule's change shows of those it would categorise. */
const RULE_EXAMPLES = 8;

/**
 * What settles a row's category: you, your rule, an agreement, a transfer link. A category one of these
 * gave is so; one the bank, the reader or the app's own patterns gave is a guess a proposal can confirm.
 */
const SETTLED_BY: ReadonlySet<NonNullable<Transaction['categorisedBy']>> = new Set(['user', 'rule', 'agreement', 'transfer']);

/** A proposed rule's id: the same each time the proposal is checked, shown and applied. */
const proposedRuleId = (proposalId: string, key: string) => `rule_${createHash('sha256').update(`${proposalId}:${key}`).digest('hex').slice(0, 14)}`;

/** Two rule matches that catch the same payments: the same words, the same way, with the same limits. */
function sameMatch(a: Rule['match'], b: Rule['match']): boolean {
  const norm = (m: Rule['match']) =>
    JSON.stringify([m.field, m.op, m.caseSensitive ? m.value.trim() : m.value.trim().toLowerCase(), m.caseSensitive, [...(m.accountIds ?? [])].sort(), m.amountMin ?? null, m.amountMax ?? null, m.direction ?? null]);
  return norm(a) === norm(b);
}

const money = (t: Pick<Transaction, 'amount' | 'currency'>) => formatMoney(t.amount, { currency: t.currency });
const brief = (t: Transaction, accountName: (id: string) => string) => `${money(t)} on ${formatDate(t.date)} in ${accountName(t.accountId)}`;

/**
 * The strong balances either side of an account's balance on a day (a statement's, a running
 * balance or your own), each with what the rows between leave unexplained, and that day's own.
 */
function besideDay(engine: BalanceEngine, accountId: string, date: string) {
  const [before, after] = [engine.between(accountId, date), engine.between(accountId, addDays(date, 1))];
  const on = before?.to.date === date ? before.to : after?.from.date === date ? after.from : undefined;
  const beside = [before?.to.date === date ? { ...before.from, difference: before.difference } : undefined, after?.from.date === date ? { ...after.to, difference: after.difference } : undefined].filter((b) => b !== undefined);
  return { on, beside };
}

/**
 * Run a proposal's changes in order on a copy of the data, leaving out `leaveOut`: what each would
 * do, and what applying them all would write.
 */
function simulate(store: Store, changes: ProposedChange[], leaveOut: ReadonlySet<string>, forProposal = 'proposal'): Outcome {
  // Your categories as the changes so far leave them: a category one adds can be used by the next.
  let catList: Category[] = store.categories;
  let cats = new CategoryIndex(catList);
  const receiptsOn = new Set(store.receipts.map((r) => r.transactionId));
  /** Something you set on the row (a transfer link is not: a proposal may undo one). */
  const yours = (t: Transaction) => t.categorisedBy === 'user' || t.payeeSetBy === 'user' || Boolean(t.notes || t.tags?.length || t.splits?.length || t.corrections?.length || t.seenIn?.length) || receiptsOn.has(t.id);
  const accountName = (id: string) => store.account(id)?.name ?? id;
  let categoriserMemo: Categoriser | undefined;
  const categoriser = () => (categoriserMemo ??= categoriserFor(store));
  const out: Outcome = { results: new Map(), patches: new Map(), removed: new Map(), accounts: new Map(), touchedRows: new Map(), touchedAccounts: new Map(), moves: new Map(), companies: new Map(), jobs: new Map(), balances: [], agreements: new Map(), terms: new Map(), termsRemoved: new Map(), rules: [], categoriesBefore: new Map() };
  /** Change a category, or add one (`was` undefined), in the list the next changes see. */
  const putCategory = (next: Category, was: Category | undefined) => {
    const original = was ? store.categories.find((x) => x.id === was.id) : undefined;
    if (original && !out.categoriesBefore.has(original.id)) out.categoriesBefore.set(original.id, original);
    catList = was ? catList.map((x) => (x.id === was.id ? next : x)) : [...catList, next];
    cats = new CategoryIndex(catList);
    out.categories = catList;
  };
  const balanceById = new Map(store.balances().map((b) => [b.id, b]));
  // Rows as the changes so far leave them (null: removed), and transfer pairs likewise.
  const rows = new Map<string, Transaction | null>();
  const groups = new Map<string, string[]>();
  for (const t of store.transactions()) if (t.transferGroup) (groups.get(t.transferGroup) ?? groups.set(t.transferGroup, []).get(t.transferGroup)!).push(t.id);
  const row = (id: string): Transaction | undefined => (rows.has(id) ? (rows.get(id) ?? undefined) : store.transaction(id));
  const account = (id: string): Account | undefined => out.accounts.get(id) ?? store.account(id);
  const patch = (t: Transaction, p: Partial<Transaction>) => {
    if (!out.touchedRows.has(t.id)) out.touchedRows.set(t.id, store.transaction(t.id)!);
    out.patches.set(t.id, { ...(out.patches.get(t.id) ?? {}), ...p });
    const next: Record<string, unknown> = { ...t, ...p };
    for (const [k, v] of Object.entries(p)) if (v === undefined) delete next[k];
    rows.set(t.id, next as Transaction);
  };
  const partnerOf = (t: Transaction) => (t.transferGroup ? (groups.get(t.transferGroup) ?? []).filter((id) => id !== t.id).map(row).find(Boolean) : undefined);
  /** A row is still linked: say with what, and which change here would undo it if it is left out. */
  const linkedNow = (t: Transaction) => {
    const p = partnerOf(t);
    const pair = groups.get(t.transferGroup!) ?? [t.id];
    const undo = changes.findIndex((x) => x.kind === 'unlink_transfer' && leaveOut.has(x.key) && pair.includes(x.transaction));
    const what = p ? `${brief(t, accountName)} is linked with ${brief(p, accountName)}` : `${brief(t, accountName)} is linked as a transfer`;
    return undo >= 0 ? `${what}: include change ${undo + 1}, which undoes that link.` : `${what}: undo that link first.`;
  };
  const gone = (id: string) => `Transaction ${id} is no longer in your data.`;
  /** What you added to a row beyond a category or payee, which taking it away would lose. */
  const keptByYou = (t: Transaction) => Boolean(t.notes || t.tags?.length || t.splits?.length || t.corrections?.length || t.seenIn?.length) || receiptsOn.has(t.id);
  const KEPT_BY_YOU = 'It has something of yours on it (a note, tag, split, correction, receipt or details you added from another document), so a proposal leaves it to you.';
  const remove = (t: Transaction) => {
    if (!out.touchedRows.has(t.id)) out.touchedRows.set(t.id, store.transaction(t.id)!);
    out.patches.delete(t.id);
    out.removed.set(t.id, store.transaction(t.id)!);
    rows.set(t.id, null);
  };

  const run = (c: ProposedChange): ChangeResult => {
    switch (c.kind) {
      case 'unlink_transfer': {
        const t = row(c.transaction);
        if (!t) return { problem: gone(c.transaction) };
        if (!t.transferGroup) return { alreadySo: true };
        for (const id of groups.get(t.transferGroup) ?? [t.id]) {
          const m = row(id);
          if (m) patch(m, { transferGroup: undefined, counterpartyAccountId: undefined });
        }
        groups.delete(t.transferGroup);
        return {};
      }
      case 'link_transfer': {
        const a = row(c.from);
        const b = row(c.to);
        if (!a || !b) return { problem: gone(!a ? c.from : c.to) };
        if (a.accountId === b.accountId) return { problem: `Both are in ${accountName(a.accountId)}: a transfer moves money between two of your accounts.` };
        if (a.amount >= 0) return { problem: `${brief(a, accountName)} is money in: a transfer is linked from the money out to the money in.` };
        if (b.amount <= 0) return { problem: `${brief(b, accountName)} is money out: a transfer is linked from the money out to the money in.` };
        if (toMinor(a.amount) !== -toMinor(b.amount) || a.currency !== b.currency) return { problem: `The amounts differ: ${money({ ...a, amount: -a.amount })} out, ${money(b)} in.` };
        const days = Math.abs(diffDays(a.date, b.date));
        if (days > LINK_DAYS) return { problem: `They are ${days} days apart; a transfer arrives within ${LINK_DAYS}.` };
        if (a.transferGroup && a.transferGroup === b.transferGroup) return { alreadySo: true };
        if (a.transferGroup) return { problem: linkedNow(a) };
        if (b.transferGroup) return { problem: linkedNow(b) };
        const accA = account(a.accountId);
        const accB = account(b.accountId);
        if (!accA || !accB) return { problem: `Account ${!accA ? a.accountId : b.accountId} is no longer in your data.` };
        const group = transferGroupId(a.id, b.id);
        const after: NonNullable<ChangeResult['after']> = {};
        for (const [t, self, other] of [[a, accA, accB], [b, accB, accA]] as const) {
          // A category you set stays (as when an import links a transfer).
          const category = t.categorisedBy === 'user' ? t.category : transferLegCategory(self.type, other.type, t.amount);
          patch(t, { transferGroup: group, counterpartyAccountId: other.id, ...(t.categorisedBy !== 'user' ? { category, categorisedBy: 'transfer' as const } : {}) });
          after[t.id] = { ...(category ? { category } : {}), transferWith: other.id };
        }
        groups.set(group, [a.id, b.id]);
        return { after };
      }
      case 'set_category': {
        const t = row(c.transaction);
        if (!t) return { problem: gone(c.transaction) };
        const cat = cats.get(c.category);
        if (!cat) return { problem: `There is no category "${c.category}".` };
        if (t.transferGroup && cat.kind !== 'transfer') return { problem: `${linkedNow(t)} While it is a transfer, it takes a transfer category, not ${cat.name}.` };
        // In that category already: so, unless only a guess put it there (the bank's category, the
        // reader's or the app's own patterns). Then applying confirms it: it becomes yours.
        if (t.category === c.category && (!t.categorisedBy || SETTLED_BY.has(t.categorisedBy))) return { alreadySo: true };
        // Yours wins: a category you set is not changed by a proposal.
        const was = store.transaction(t.id);
        if (was?.categorisedBy === 'user') return { problem: `You set its category yourself (${cats.name(was.category)}), so a proposal leaves it to you: change it on the Transactions page if you want to.` };
        // A row that stops being a transfer stops naming one of your accounts as the other side, and
        // a payee that was one of your accounts' names is worked out again from its words.
        const untransferred = cat.kind !== 'transfer' && !t.transferGroup;
        const namedYours = untransferred && t.payeeSetBy !== 'user' && store.accounts.some((a) => a.id !== t.accountId && a.name === t.payee);
        const payee = namedYours ? categoriser().categorise({ ...categoriseInputOf(t), aiCategory: undefined }).payee : undefined;
        patch(t, { category: c.category, categorisedBy: 'user', ...(untransferred && t.counterpartyAccountId ? { counterpartyAccountId: undefined } : {}), ...(payee && payee !== t.payee ? { payee } : {}) });
        return {};
      }
      case 'set_note': {
        const t = row(c.transaction);
        if (!t) return { problem: gone(c.transaction) };
        if ((t.notes ?? '').trim() === c.note.trim()) return { alreadySo: true };
        // Yours wins: a note on the row (typed, or from a proposal you applied) is not replaced.
        if (t.notes?.trim()) return { problem: `It has a note already (“${t.notes.trim().slice(0, 80)}${t.notes.trim().length > 80 ? '…' : ''}”), so a proposal leaves it to you: change it on the Transactions page if you want to.` };
        patch(t, { notes: c.note.trim() });
        return {};
      }
      case 'remove_duplicate': {
        const t = row(c.transaction);
        // Gone already: what it asks for is done.
        if (!t) return rows.get(c.transaction) === null ? { problem: 'Another change here removes it already.' } : { alreadySo: true };
        if (t.transferGroup) return { problem: linkedNow(t) };
        if (c.sameAs.includes(t.id)) return { problem: 'It cannot repeat itself.' };
        // A copy with something of yours on it (a category, note, split, receipt…) is never taken away.
        if (yours(store.transaction(t.id)!)) return { problem: 'It has something of yours on it (a category, payee, note, tag, split, correction, receipt or details you added from another document), so a proposal leaves it to you.' };
        let sum = 0;
        for (const id of c.sameAs) {
          const s = row(id);
          if (!s) return { problem: `A row it repeats: ${gone(id)}` };
          if (s.accountId !== t.accountId) return { problem: `${brief(s, accountName)} is in another account, so it cannot be the same money.` };
          const days = Math.abs(diffDays(s.date, t.date));
          if (days > DUPLICATE_DAYS) return { problem: `${brief(s, accountName)} is ${days} days from it; a repeat is within ${DUPLICATE_DAYS}.` };
          sum += toMinor(s.amount);
        }
        if (sum !== toMinor(t.amount)) return { problem: `The rows it repeats add up to ${money({ ...t, amount: fromMinor(sum) })}, not ${money(t)}.` };
        remove(t);
        return {};
      }
      case 'remove_wrong_sign': {
        const t = row(c.transaction);
        if (!t) return rows.get(c.transaction) === null ? { problem: 'Another change here removes it already.' } : { alreadySo: true };
        if (t.transferGroup) return { problem: linkedNow(t) };
        if (c.recordedAs.includes(t.id)) return { problem: 'It cannot record itself.' };
        if (!t.amount) return { problem: 'It is £0.00: there is no sign to be wrong.' };
        const doc = t.source.documentId ?? t.source.importId;
        if (!doc) return { problem: 'It was not read from a document, so it cannot have been misread.' };
        // A category or payee you gave the misread row goes with it: the rows recorded the right way
        // round keep theirs. What else you added (a note, a split, a receipt…) would be lost.
        if (keptByYou(store.transaction(t.id)!)) return { problem: KEPT_BY_YOU };
        let sum = 0;
        for (const id of c.recordedAs) {
          const s = row(id);
          if (!s) return { problem: `A row recording it: ${gone(id)}` };
          if (s.accountId !== t.accountId) return { problem: `${brief(s, accountName)} is in another account, so it cannot be the same money.` };
          if ((s.source.documentId ?? s.source.importId) === doc) return { problem: `${brief(s, accountName)} was read from the same document: another document must record it.` };
          const days = Math.abs(diffDays(s.date, t.date));
          if (days > DUPLICATE_DAYS) return { problem: `${brief(s, accountName)} is ${days} days from it; the same money is recorded within ${DUPLICATE_DAYS}.` };
          sum += toMinor(s.amount);
        }
        if (sum !== -toMinor(t.amount)) return { problem: `The rows recording it add up to ${money({ ...t, amount: fromMinor(sum) })}, not ${money({ ...t, amount: -t.amount })}.` };
        remove(t);
        return {};
      }
      case 'remove_internal_move': {
        const t = row(c.transaction);
        if (!t) return rows.get(c.transaction) === null ? { problem: 'Another change here removes it already.' } : { alreadySo: true };
        if (t.transferGroup) return { problem: linkedNow(t) };
        if (!t.source.documentId && !t.source.importId) return { problem: 'It was not read from a document: a row you typed in is yours to remove.' };
        // As with a misread row, a category or payee you gave it goes with it.
        if (keptByYou(store.transaction(t.id)!)) return { problem: KEPT_BY_YOU };
        remove(t);
        // Whether the balances either side add up without it is checked once every change has run.
        return {};
      }
      case 'set_account_dates': {
        const acc = account(c.account);
        if (!acc) return { problem: `Account ${c.account} is no longer in your data.` };
        if (c.openedOn === undefined && c.closedOn === undefined) return { problem: 'It sets neither date.' };
        const next: Record<string, unknown> = { ...acc };
        if (c.openedOn === null) delete next.openedOn;
        else if (c.openedOn !== undefined) next.openedOn = c.openedOn;
        if (c.closedOn === null) {
          delete next.closedOn;
          next.status = 'open';
        } else if (c.closedOn !== undefined) {
          next.closedOn = c.closedOn;
          next.status = 'closed';
        }
        const opened = next.openedOn as string | undefined;
        const closed = next.closedOn as string | undefined;
        if (opened && closed && closed < opened) return { problem: `It would close (${formatDate(closed)}) before it opened (${formatDate(opened)}).` };
        if (closed && closed > today()) return { problem: `${formatDate(closed)} is in the future.` };
        if (opened === acc.openedOn && closed === acc.closedOn && next.status === acc.status) return { alreadySo: true };
        if (!out.touchedAccounts.has(acc.id)) out.touchedAccounts.set(acc.id, store.account(acc.id)!);
        out.accounts.set(acc.id, AccountSchema.parse(next));
        return {};
      }
      case 'link_accounts': {
        const acc = account(c.account);
        const older = account(c.continues);
        if (!acc) return { problem: `Account ${c.account} is no longer in your data.` };
        if (!older) return { problem: `Account ${c.continues} is no longer in your data.` };
        if (acc.id === older.id) return { problem: 'An account cannot carry on from itself.' };
        if (older.continues?.accountId === acc.id) return { problem: `${older.name} already carries on from ${acc.name}.` };
        if (acc.openedOn && c.from < acc.openedOn) return { problem: `${acc.name} opened on ${formatDate(acc.openedOn)}, after ${formatDate(c.from)}.` };
        if (older.closedOn && older.closedOn >= c.from) return { problem: `${older.name} was still open on ${formatDate(c.from)} (it closed on ${formatDate(older.closedOn)}).` };
        if (acc.continues?.accountId === older.id && acc.continues.from === c.from) return { alreadySo: true };
        if (!out.touchedAccounts.has(acc.id)) out.touchedAccounts.set(acc.id, store.account(acc.id)!);
        out.accounts.set(acc.id, AccountSchema.parse({ ...acc, continues: { accountId: older.id, from: c.from } }));
        return {};
      }
      case 'move_balance': {
        const b = balanceById.get(c.balance);
        if (!b) return { problem: `Balance ${c.balance} is no longer in your data.` };
        const from = out.moves.get(b.id)?.to ?? b.accountId;
        if (from === c.to) return { alreadySo: true };
        const to = account(c.to);
        if (!to) return { problem: `Account ${c.to} is not in your data.` };
        if (b.currency !== to.currency) return { problem: `It is in ${b.currency}, and ${to.name} is in ${to.currency}.` };
        // Yours wins: a balance you gave or changed is not moved by a proposal.
        if (b.kind === 'manual' || b.enteredBy === 'user') return { problem: 'You gave this balance yourself, so a proposal leaves it to you.' };
        if (!b.source.importId && !b.source.documentId) return { problem: 'It was not read from a document, so it cannot have been read into the wrong account.' };
        if (to.openedOn && b.date < to.openedOn) return { problem: `${to.name} opened on ${formatDate(to.openedOn)}, after it (${formatDate(b.date)}).` };
        if (to.closedOn && b.date > to.closedOn) return { problem: `${to.name} closed on ${formatDate(to.closedOn)}, before it (${formatDate(b.date)}).` };
        out.moves.set(b.id, { balance: b, from, to: c.to });
        // The terms its reading gave go with it: they were read into the wrong account too.
        for (const t of store.terms(from)) {
          if (t.asOf !== b.date || !t.source.importId || t.source.importId !== b.source.importId) continue;
          out.termsRemoved.set(t.id, t);
          const moved = TermsSchema.parse({ ...t, accountId: c.to, id: termsId(c.to, t.asOf, t.source) });
          out.terms.set(moved.id, moved);
        }
        // Whether it is wrong where it is, and fits where it goes, is checked once every change has run.
        return {};
      }
      case 'add_pension_arrangement': {
        const job = out.jobs.get(c.employmentId) ?? store.employment(c.employmentId);
        if (!job) return { problem: `Job ${c.employmentId} is not in your data.` };
        const acc = account(c.arrangement.accountId);
        if (!acc) return { problem: `Account ${c.arrangement.accountId} is not in your data.` };
        if (!ACCOUNT_TYPE_META[acc.type].pension || acc.type === 'state_pension' || acc.type === 'db_pension') return { problem: `${acc.name} is not a pension you pay into.` };
        if (c.arrangement.from > today()) return { problem: `${formatDate(c.arrangement.from)} is in the future.` };
        if (c.arrangement.until && c.arrangement.until < c.arrangement.from) return { problem: 'It would end before it starts.' };
        // The same arrangement there already: done.
        const same = (a: PensionArrangement) => a.accountId === c.arrangement.accountId && a.kind === c.arrangement.kind && toMinor(a.amount) === toMinor(c.arrangement.amount) && a.from === c.arrangement.from;
        if (job.pensionArrangements.some(same)) return { alreadySo: true };
        out.jobs.set(job.id, EmploymentSchema.parse({ ...job, pensionArrangements: [...job.pensionArrangements, c.arrangement], updatedAt: nowISO() }));
        return {};
      }
      case 'add_agreement': {
        const a = c.agreement;
        const there = out.agreements.get(a.id) ?? store.agreement(a.id);
        // There already with this schedule: what it asks for is done.
        const schedule = (x: Pick<Agreement, 'payments'>) => JSON.stringify(x.payments.map((p) => [p.due, toMinor(p.amount)]).sort());
        if (there) return there.counterparty === a.counterparty && schedule(there) === schedule(a) ? { alreadySo: true } : { problem: `There is an agreement ${a.id} already: ${there.name}.` };
        const cat = cats.get(a.category);
        if (!cat) return { problem: `There is no category "${a.category}".` };
        if (a.direction === 'in' ? cat.kind !== 'transfer' && cat.kind !== 'income' : cat.kind !== 'expense') {
          return { problem: a.direction === 'in' ? `${cat.name} is neither a transfer nor an income category: money paid to you is one or the other.` : `${cat.name} is not a spending category: an agreement's payments are money you pay.` };
        }
        if (a.accountId && !account(a.accountId)) return { problem: `Account ${a.accountId} is not in your data.` };
        if (a.until && a.until < a.from) return { problem: 'It would end before it starts.' };
        const stamp = nowISO();
        const agreement = AgreementSchema.parse({ ...a, createdBy: 'agent', createdAt: stamp, updatedAt: stamp });
        // The payments already in your data it schedules are filed as the categoriser will file those
        // to come, with it after the agreements there already; except one you, a rule of yours or a
        // transfer link categorised.
        const pattern = agreementPattern(agreement);
        const withIt = categoriserFor(store, { agreements: [...store.agreements, ...out.agreements.values(), agreement] });
        const files: NonNullable<ChangeResult['files']> = [];
        for (const stored of store.transactions()) {
          const t = row(stored.id);
          if (!t || t.transferGroup || t.categorisedBy === 'user' || t.categorisedBy === 'rule' || t.categorisedBy === 'transfer') continue;
          const acc = account(t.accountId);
          if (!acc || isWrapperAccount(acc.type) || !isScheduledPayment(agreement, pattern, { date: t.date, amount: t.amount, text: paidToText(t), accountId: t.accountId })) continue;
          const res = withIt.categorise(categoriseInputOf(t));
          if (res.categorisedBy !== 'agreement' || res.category !== a.category) continue;
          if (t.category === a.category && t.categorisedBy === 'agreement') continue;
          files.push({ transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, ...(t.category ? { category: t.category } : {}) });
          patch(t, { category: a.category, categorisedBy: 'agreement', ruleId: undefined, ...(t.payeeSetBy !== 'user' && res.payee !== t.payee ? { payee: res.payee } : {}) });
        }
        out.agreements.set(a.id, agreement);
        return files.length ? { files } : {};
      }
      case 'set_terms': {
        const acc = account(c.account);
        if (!acc) return { problem: `Account ${c.account} is not in your data.` };
        const imp = store.imports.find((i) => i.id === c.importId);
        if (!imp) return { problem: `Import ${c.importId} is not one of your documents.` };
        if (c.asOf > today()) return { problem: `${formatDate(c.asOf)} is in the future.` };
        if (!c.terms.rates.length && c.terms.limit === undefined && c.terms.minimumPayment === undefined) return { problem: 'It gives no rate, limit or minimum payment.' };
        const source = { importId: imp.id, ...(imp.documentId ? { documentId: imp.documentId } : {}) };
        const id = termsId(acc.id, c.asOf, source);
        const was = out.terms.get(id) ?? store.terms(acc.id).find((t) => t.id === id);
        const fileName = imp.fileName;
        if (was && sameTerms(was, c.terms)) return { alreadySo: true };
        if (was && !out.terms.has(id)) out.termsRemoved.set(id, was);
        out.terms.set(id, TermsSchema.parse({ id, accountId: acc.id, asOf: c.asOf, ...c.terms, source, createdAt: was?.createdAt ?? nowISO() }));
        return { terms: { fileName, ...(was ? { before: { rates: was.rates, ...(was.limit !== undefined ? { limit: was.limit } : {}), ...(was.minimumPayment !== undefined ? { minimumPayment: was.minimumPayment } : {}), ...(was.paymentDue ? { paymentDue: was.paymentDue } : {}) } } : {}) } };
      }
      case 'add_company': {
        const there = out.companies.get(c.company.id) ?? store.company(c.company.id);
        // There already with this holding: what it asks for is done.
        const same = (x: Company) => x.holdings.length === c.company.holdings.length && c.company.holdings.every((h) => x.holdings.some((y) => y.shareClass === h.shareClass && y.shares === h.shares));
        if (there) return same(there) ? { alreadySo: true } : { problem: `${there.name} is in your data already, with another holding: change it on its account page.` };
        const byNumber = c.company.number ? store.companies.find((x) => x.number === c.company.number) : undefined;
        if (byNumber) return same(byNumber) ? { alreadySo: true } : { problem: `${byNumber.name} has that company number already.` };
        if (account(c.account.id)) return { problem: `There is an account ${c.account.id} already.` };
        if (c.company.employmentId && !store.employment(c.company.employmentId)) return { problem: `Job ${c.company.employmentId} is not in your data.` };
        if (!c.company.holdings.length) return { problem: 'It holds no shares.' };
        if (c.valuation.asOf > today()) return { problem: `${formatDate(c.valuation.asOf)} is in the future.` };
        const stamp = nowISO();
        const acc = AccountSchema.parse({ id: c.account.id, name: c.account.name, type: 'other_asset', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, notes: `Your shares in ${c.company.name}${c.company.number ? ` (company ${c.company.number})` : ''}.`, createdAt: stamp, updatedAt: stamp });
        out.accounts.set(acc.id, acc);
        // Its value on the day its balance sheet (or you) gives: a valuation of the account, its note
        // saying how it was worked out. Not a rough figure: it is dated, from a document.
        const balance = BalanceSnapshotSchema.parse({ id: balanceId(acc.id, c.valuation.asOf, c.valuation.value, 'manual'), accountId: acc.id, date: c.valuation.asOf, balance: c.valuation.value, currency: 'GBP', kind: 'manual', ...(c.valuation.note ? { note: c.valuation.note } : {}), source: c.valuation.source, createdAt: stamp });
        out.balances.push(balance);
        out.companies.set(c.company.id, CompanySchema.parse({ ...c.company, valuations: [{ ...c.valuation, balanceId: balance.id }], accountId: acc.id, createdBy: 'agent', createdAt: stamp, updatedAt: stamp }));
        return {};
      }
      case 'add_rule': {
        const cat = cats.get(c.rule.category);
        if (!cat) return { problem: `There is no category "${c.rule.category}".` };
        if (c.rule.match.op === 'regex') {
          try {
            new RegExp(c.rule.match.value);
          } catch {
            return { problem: `“${c.rule.match.value}” is not a pattern the app can read.` };
          }
        }
        // A rule of yours that catches the same payments: the same, or yours wins.
        const there = [...store.rules, ...out.rules].find((r) => r.enabled && sameMatch(r.match, c.rule.match));
        if (there) return there.set.category === c.rule.category ? { alreadySo: true } : { problem: `Your rule “${there.name ?? there.match.value}” catches the same payments and puts them in ${cats.name(there.set.category)}: change that rule in Settings → Rules instead.` };
        const stamp = nowISO();
        const rule: Rule = { id: proposedRuleId(forProposal, c.key), name: c.rule.name ?? `${c.rule.match.value} → ${cat.name}`, enabled: true, priority: 100, match: c.rule.match, set: { category: c.rule.category }, createdAt: stamp, updatedAt: stamp };
        out.rules.push(rule);
        // The payments it catches, categorised as the categoriser would with it (a rule of yours that
        // comes first still wins), as applying a rule does: yours and linked transfers are left.
        const withIt = categoriserFor(store, { rules: [...store.rules, ...out.rules], categories: catList });
        const alone = new Categoriser([rule], new CategoryIndex([]), [], []);
        const filled: Transaction[] = [];
        let settled = 0;
        let yoursLeft = 0;
        for (const now of store.transactions()) {
          const t = row(now.id);
          if (!t || !ruleCatches(rule, t, alone)) continue;
          if (t.categorisedBy === 'user') {
            if (t.category !== rule.set.category) yoursLeft++;
            continue;
          }
          if (t.transferGroup && t.categorisedBy === 'transfer') continue;
          const input = categoriseInputOf(t);
          const res = withIt.categorise(input);
          if (res.ruleId !== rule.id) continue;
          const p: Partial<Transaction> = {};
          const payee = nextPayee(t, input, res);
          if (payee !== t.payee) p.payee = payee;
          if (res.category !== t.category) p.category = res.category;
          if (res.categorisedBy !== t.categorisedBy) p.categorisedBy = res.categorisedBy;
          if (res.ruleId !== t.ruleId) p.ruleId = res.ruleId;
          if (!Object.keys(p).length) continue;
          patch(t, p);
          if ('category' in p) filled.push(t);
          else if ('categorisedBy' in p) settled++;
        }
        filled.sort((a, b) => b.date.localeCompare(a.date));
        const examples: ProposalRuleExample[] = filled.slice(0, RULE_EXAMPLES).map((t) => ({ id: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description, ...(t.category ? { category: t.category } : {}) }));
        return { rule: { count: filled.length, amount: fromMinor(filled.reduce((s, t) => s + toMinor(t.amount), 0)), examples, settles: settled, yours: yoursLeft } };
      }
      case 'add_category': {
        const there = cats.get(c.category.id);
        if (there) return there.name === c.category.name && there.parent === c.category.parent && there.kind === c.category.kind ? { alreadySo: true } : { problem: `There is a category “${there.name}” with the id ${there.id} already.` };
        const parent = c.category.parent ? cats.get(c.category.parent) : undefined;
        if (c.category.parent && !parent) return { problem: `There is no group "${c.category.parent}".` };
        if (parent?.parent) return { problem: `${parent.name} is a category in ${cats.name(parent.parent)}, not a group: a category goes in a group.` };
        if (parent && parent.kind !== c.category.kind) return { problem: `${parent.name} holds ${parent.kind} categories, not ${c.category.kind} ones.` };
        const sibling = catList.find((x) => x.parent === c.category.parent && x.name.trim().toLowerCase() === c.category.name.trim().toLowerCase());
        if (sibling) return { problem: `${parent ? `${parent.name} has` : 'There is a group called'} “${sibling.name}” already.` };
        putCategory({ id: c.category.id, name: c.category.name, kind: c.category.kind, ...(parent ? { parent: parent.id } : {}) }, undefined);
        return { category: parent ? { group: parent.name } : {} };
      }
      case 'change_category': {
        const was = cats.get(c.category);
        if (!was) return { problem: `There is no category "${c.category}".` };
        const name = c.name ?? was.name;
        const parentId = c.parent === undefined ? was.parent : (c.parent ?? undefined);
        const parent = parentId ? cats.get(parentId) : undefined;
        if (parentId && !parent) return { problem: `There is no group "${parentId}".` };
        if (parentId === was.id) return { problem: 'A category cannot go in itself.' };
        if (parent?.parent) return { problem: `${parent.name} is a category in ${cats.name(parent.parent)}, not a group: a category goes in a group.` };
        if (parent && parent.kind !== was.kind) return { problem: `${parent.name} holds ${parent.kind} categories, and ${was.name} is ${was.kind}.` };
        const children = catList.filter((x) => x.parent === was.id);
        if (parent && children.length) return { problem: `${was.name} is a group with ${children.length === 1 ? 'a category' : `${children.length} categories`} in it (${children.map((x) => x.name).join(', ')}): only a category goes in a group.` };
        if (name === was.name && parentId === was.parent) return { alreadySo: true };
        const sibling = catList.find((x) => x.id !== was.id && x.parent === parentId && x.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (sibling) return { problem: `${parent ? `${parent.name} has` : 'There is a group called'} “${sibling.name}” already.` };
        const next: Category = { ...was, name };
        if (parent) next.parent = parent.id;
        else delete next.parent;
        putCategory(next, was);
        return { category: { ...(parent ? { group: parent.name } : {}), was: { name: was.name, ...(was.parent ? { group: cats.name(was.parent) } : {}) } } };
      }
    }
  };

  for (const c of changes) if (!leaveOut.has(c.key)) out.results.set(c.key, run(c));

  // A move inside an account left the account's money where it was: without it (and whatever else
  // this proposal takes away), the statement or your own balances either side of it add up.
  const moves = changes.filter((c) => c.kind === 'remove_internal_move' && !leaveOut.has(c.key) && !out.results.get(c.key)?.problem && !out.results.get(c.key)?.alreadySo);
  if (moves.length) {
    const without: BalanceSource = {
      accounts: store.accounts,
      settings: store.settings,
      balances: (id) => store.balances(id),
      transactions: (id) => store.transactions(id).flatMap((t) => row(t.id) ?? []),
    };
    const engine = new BalanceEngine(without);
    for (const c of moves) {
      const t = out.removed.get((c as Extract<ProposedChange, { kind: 'remove_internal_move' }>).transaction)!;
      const b = engine.between(t.accountId, t.date);
      if (!b) out.results.set(c.key, { problem: `There is no statement or balance of yours on each side of ${formatDate(t.date)} in ${accountName(t.accountId)} to show its money did not move.` });
      else if (b.difference) out.results.set(c.key, { problem: `Without it, the balances either side still do not add up: ${formatMoney(b.from.balance)} on ${formatDate(b.from.date)} to ${formatMoney(b.to.balance)} on ${formatDate(b.to.date)} leaves ${formatMoney(b.difference)} unexplained.` });
      else out.results.set(c.key, { between: { from: b.from, to: b.to } });
    }
  }

  // A balance moved: with every change run, where it was it does not belong (the account was not
  // open that day, or its balances do not add up with it), and where it goes they do.
  const balanceMoves = changes.filter((c): c is Extract<ProposedChange, { kind: 'move_balance' }> => c.kind === 'move_balance' && !leaveOut.has(c.key) && !out.results.get(c.key)?.problem && !out.results.get(c.key)?.alreadySo);
  if (balanceMoves.length) {
    const accounts = store.accounts.map((a) => out.accounts.get(a.id) ?? a);
    /** The data as the changes leave it, with one balance kept where it was. */
    const engineWith = (keep?: string) => {
      const placed = (b: BalanceSnapshot) => (b.id === keep ? b.accountId : (out.moves.get(b.id)?.to ?? b.accountId));
      const all = store.balances();
      return new BalanceEngine({ accounts, settings: store.settings, balances: (id) => all.filter((b) => placed(b) === id), transactions: (id) => store.transactions(id).flatMap((t) => row(t.id) ?? []) });
    };
    const after = engineWith();
    const said = (b: { balance: number; date: string }) => `${formatMoney(b.balance)} on ${formatDate(b.date)}`;
    for (const c of balanceMoves) {
      const move = out.moves.get(c.balance);
      if (!move || move.to !== c.to) continue;
      const { balance: b, from: fromId } = move;
      const from = accounts.find((a) => a.id === fromId);
      const to = accounts.find((a) => a.id === c.to)!;
      const fromName = from?.name ?? fromId;
      let misfit: string | undefined;
      if (from?.openedOn && b.date < from.openedOn) misfit = `${fromName} opened on ${formatDate(from.openedOn)}, after it.`;
      else if (from?.closedOn && b.date > from.closedOn) misfit = `${fromName} closed on ${formatDate(from.closedOn)}, before it.`;
      else {
        const here = besideDay(engineWith(b.id), fromId, b.date);
        const off = here.beside.find((x) => x.difference);
        if (off) misfit = `In ${fromName} it does not add up with ${said(off)}: ${formatMoney(Math.abs(off.difference))} is unexplained.`;
      }
      if (!misfit) {
        out.results.set(c.key, { problem: `Nothing shows it is not ${fromName}’s: the account was open that day, and no balance of its says otherwise.` });
        continue;
      }
      const there = besideDay(after, c.to, b.date);
      if (there.on && toMinor(there.on.balance) !== toMinor(b.balance)) out.results.set(c.key, { problem: `${to.name}’s own data says ${said(there.on)}, not ${formatMoney(b.balance)}.` });
      else if (!there.beside.length) out.results.set(c.key, { problem: `${to.name} has no statement, running or own balance either side of ${formatDate(b.date)} to check it against.` });
      else {
        const off = there.beside.find((x) => x.difference);
        if (off) out.results.set(c.key, { problem: `In ${to.name} it does not add up with ${said(off)}: ${formatMoney(Math.abs(off.difference))} is unexplained.` });
        else out.results.set(c.key, { moved: { misfit, beside: there.beside.map(({ date, balance }) => ({ date, balance })) } });
      }
    }
  }
  return out;
}

/** Applying would leave the data as it is: every change is already so, or they undo each other. */
function changesNothing(store: Store, o: Outcome): boolean {
  if (o.removed.size || o.companies.size || o.balances.length || o.jobs.size || o.agreements.size || o.terms.size || o.termsRemoved.size || o.rules.length || o.categories) return false;
  if ([...o.moves.values()].some((m) => m.to !== m.balance.accountId)) return false;
  for (const [id, patch] of o.patches) {
    const t = store.transaction(id) as Record<string, unknown> | undefined;
    if (!t || Object.entries(patch).some(([k, v]) => t[k] !== v)) return false;
  }
  for (const [id, a] of o.accounts) {
    const was = store.account(id);
    if (!was || was.openedOn !== a.openedOn || was.closedOn !== a.closedOn || was.status !== a.status || JSON.stringify(was.continues ?? null) !== JSON.stringify(a.continues ?? null)) return false;
  }
  return true;
}

/** Nothing in it is left to do: it fits, and applying it would change nothing. */
const leavesNothing = (store: Store, p: Proposal, o = simulate(store, p.changes, new Set(), p.id)) => ![...o.results.values()].some((r) => r.problem) && changesNothing(store, o);

/** What each decided status means, when something asks to decide it again. */
const DECIDED: Record<Exclude<ProposalStatus, 'pending'>, string> = {
  applied: 'You applied this proposal already.',
  dismissed: 'You dismissed this proposal already.',
  superseded: 'This proposal closed already: your data came to say all of it.',
};

/** The transactions a change names. */
function namedRows(c: ProposedChange): string[] {
  switch (c.kind) {
    case 'unlink_transfer':
    case 'set_category':
    case 'set_note':
      return [c.transaction];
    case 'link_transfer':
      return [c.from, c.to];
    case 'remove_duplicate':
      return [c.transaction, ...c.sameAs];
    case 'remove_wrong_sign':
      return [c.transaction, ...c.recordedAs];
    case 'remove_internal_move':
      return [c.transaction];
    case 'set_account_dates':
    case 'link_accounts':
    case 'move_balance':
    case 'add_company':
    case 'add_pension_arrangement':
    case 'add_agreement':
    case 'set_terms':
    case 'add_rule':
    case 'add_category':
    case 'change_category':
      return [];
  }
}

/** What a change does, ignoring its key and reason: two proposals that do the same are the same. */
const signature = (changes: ProposedChange[]) => JSON.stringify(changes.map(({ key: _k, why: _w, ...rest }) => rest));

const newestFirst = (a: Proposal, b: Proposal) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

function summaryOf(p: DecidedProposalSummary): ProposalSummary {
  return { id: p.id, status: p.status, title: p.title, changes: p.changes, applied: p.applied, provenance: p.provenance, createdAt: p.createdAt, ...(p.decidedAt ? { decidedAt: p.decidedAt } : {}) };
}

export class ProposalService extends EventEmitter {
  private readonly pending = new Map<string, Proposal>();
  /** One decision at a time: yours, an agent's withdrawal, or closing what is already done. */
  private readonly lock = new Mutex();
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onDataChanged = () => {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => void runAs({ type: 'app', task: 'closing proposals already done' }, () => this.closeDone()).catch((err: Error) => console.warn(`[proposals] could not close the ones already done: ${err.message}`)), SWEEP_AFTER_MS);
  };

  constructor(
    private readonly store: Store,
    /** The work area's proposals directory: proposals waiting for you (never committed). */
    readonly dir: string,
    /** Commits the data's changes so far (the git committer's flush), so each decision is a commit of its own. */
    private readonly commit: () => Promise<void> = () => Promise.resolve(),
  ) {
    super();
  }

  static forWorkDir(store: Store, workDir: string, commit?: () => Promise<void>): ProposalService {
    return new ProposalService(store, path.join(workDir, 'proposals'), commit);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const f of (await readdir(this.dir)).filter((f) => f.endsWith('.json'))) {
      try {
        const p = ProposalSchema.parse(JSON.parse(await readFile(path.join(this.dir, f), 'utf8')));
        if (p.status === 'pending' && !this.store.proposals.some((d) => d.id === p.id)) this.pending.set(p.id, p);
      } catch (err) {
        console.warn(`[proposals] ignoring unreadable ${f}: ${(err as Error).message}`);
      }
    }
  }

  /** Proposals waiting for you. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** From now on, whenever the data changes (an import, an edit, a file changed outside), close what it finished. */
  watch(): void {
    this.store.on('change', this.onDataChanged);
    this.store.on('reload', this.onDataChanged);
  }

  stop(): void {
    this.store.off('change', this.onDataChanged);
    this.store.off('reload', this.onDataChanged);
    clearTimeout(this.sweepTimer);
  }

  /** Close every waiting proposal your data already says all of, as already done. */
  closeDone(): Promise<Proposal[]> {
    return this.lock.run(() => this.sweep());
  }

  list(): ProposalListResponse {
    return {
      pending: [...this.pending.values()].sort(newestFirst).map((p) => this.view(p)),
      decided: this.store.proposals.slice(0, 30).map(summaryOf),
    };
  }

  async get(id: string): Promise<ProposalView> {
    const p = this.pending.get(id) ?? (await this.store.readProposal(id));
    if (!p) throw new StoreError('No such proposal', 404);
    return this.view(p);
  }

  /**
   * Propose a fix. It must fit the data as it is: every change applies in order, and none is
   * something the data already says. `dryRun` checks and shows it without keeping it.
   */
  async create(input: ProposalInput, provenance: Provenance, opts: { dryRun?: boolean } = {}): Promise<ProposalView> {
    const keys = new Set<string>();
    const changes = input.changes.map((c, i) => {
      const key = c.key ?? `c${i + 1}`;
      if (keys.has(key)) throw new ProposalProblems('Each change needs its own key.', [{ key, problem: `The key "${key}" is used twice.` }], 400);
      keys.add(key);
      return { ...c, key };
    });
    const stamp = nowISO();
    const proposal = ProposalSchema.parse({ id: proposalId(), status: 'pending', title: input.title, summary: input.summary, changes, provenance, createdAt: stamp, updatedAt: stamp });
    const outcome = simulate(this.store, proposal.changes, new Set(), proposal.id);
    const problems = proposal.changes.flatMap((c) => {
      const r = outcome.results.get(c.key);
      return r?.problem ? [{ key: c.key, problem: r.problem }] : r?.alreadySo ? [{ key: c.key, problem: 'Your data already says this: leave the change out.' }] : [];
    });
    if (problems.length) throw new ProposalProblems(`${problems.length} of the ${proposal.changes.length} changes do not fit your data.`, problems);
    if (changesNothing(this.store, outcome)) throw new ProposalProblems('Applying it would leave your data as it is: its changes undo each other.', []);
    if (opts.dryRun) return this.view(proposal);

    const sig = signature(proposal.changes);
    const same = [...this.pending.values()].find((p) => signature(p.changes) === sig);
    if (same) throw new StoreError(`The same proposal is waiting already: ${same.id}.`, 409);
    for (const d of this.store.proposals.filter((d) => d.status === 'dismissed').slice(0, 100)) {
      const p = await this.store.readProposal(d.id);
      if (p && signature(p.changes) === sig) throw new StoreError(`The owner dismissed the same proposal on ${formatDate(p.decidedAt!.slice(0, 10))} (${p.id}${p.dismissedReason ? `: "${p.dismissedReason}"` : ''}).`, 409);
    }
    if (this.pending.size >= MAX_PENDING) throw new StoreError(`${MAX_PENDING} proposals are waiting for the owner already.`, 429);
    await this.save(proposal);
    return this.view(proposal);
  }

  /** An agent takes back a proposal the owner has not decided. */
  withdraw(id: string): Promise<void> {
    return this.lock.run(async () => {
      const p = this.pending.get(id);
      if (!p) {
        const decided = this.store.proposals.find((d) => d.id === id);
        throw new StoreError(decided ? (decided.status === 'superseded' ? DECIDED.superseded : 'The owner has decided that proposal already.') : 'No such proposal', decided ? 409 : 404);
      }
      await this.forget(id);
      this.emit('update', { ...p, status: 'dismissed' });
    });
  }

  /** What applying it would do with some changes left out. */
  check(id: string, leaveOut: string[]): ProposalCheckResponse {
    const p = this.requirePending(id);
    const outcome = simulate(this.store, p.changes, new Set(leaveOut), p.id);
    const changes = p.changes.filter((c) => !leaveOut.includes(c.key)).map((c) => ({ key: c.key, ...outcome.results.get(c.key) }));
    const problems = changes.filter((c) => c.problem).length;
    return { changes, ready: changes.filter((c) => !c.problem && !c.alreadySo).length, problems, ...(!problems && changesNothing(this.store, outcome) ? { alreadyDone: true as const } : {}) };
  }

  /**
   * Apply it, leaving out `leaveOut`. Every change applied must fit the data as it is now. One your
   * data already says all of closes as already done instead.
   */
  apply(id: string, leaveOut: string[] = []): Promise<ProposalDecision> {
    return this.lock.run(async () => {
      const p = this.requirePending(id);
      const skip = new Set(leaveOut.filter((key) => p.changes.some((c) => c.key === key)));
      const outcome = simulate(this.store, p.changes, skip, p.id);
      const problems = p.changes.flatMap((c) => {
        const problem = outcome.results.get(c.key)?.problem;
        return problem ? [{ key: c.key, problem }] : [];
      });
      if (problems.length) throw new ProposalProblems(`${problems.length === 1 ? 'A change no longer fits' : `${problems.length} changes no longer fit`} your data: leave ${problems.length === 1 ? 'it' : 'them'} out, or dismiss the proposal.`, problems, 409);
      if (changesNothing(this.store, outcome)) {
        if (skip.size === p.changes.length) throw new StoreError('Every change is left out: there is nothing to apply.', 409);
        if (skip.size) throw new StoreError('Nothing is left to apply: your data already says the changes you kept.', 409);
        // An import or an edit got there first while it waited.
        const done = await this.decide(p, { status: 'superseded' }, `proposal: ${p.title} (already done)`);
        await this.commit();
        return this.view(done);
      }
      const doing = p.changes.filter((c) => !skip.has(c.key) && !outcome.results.get(c.key)?.alreadySo);

      // One message for every write, so the data's history shows the proposal as one commit.
      const message = `proposal: ${p.title} (${doing.length} change${doing.length === 1 ? '' : 's'} applied)`;
      // Categories first, then rules: the rows after them use both.
      if (outcome.categories) await this.store.setCategories(outcome.categories, message);
      if (outcome.rules.length) await this.store.setRules([...this.store.rules, ...outcome.rules], message);
      if (outcome.patches.size) await this.store.updateTransactions([...outcome.patches].map(([tid, patch]) => ({ id: tid, patch })), message);
      if (outcome.removed.size) await this.store.deleteTransactions([...outcome.removed.keys()], message);
      for (const account of outcome.accounts.values()) await this.store.upsertAccount(account, message);
      for (const company of outcome.companies.values()) await this.store.upsertCompany(company, message);
      for (const job of outcome.jobs.values()) await this.store.upsertEmployment(job, message);
      for (const agreement of outcome.agreements.values()) await this.store.upsertAgreement(agreement, message);
      const termsGone = [...outcome.termsRemoved.keys()].filter((tid) => !outcome.terms.has(tid));
      if (termsGone.length) await this.store.removeRecords('terms', termsGone, message);
      if (outcome.terms.size) await this.store.upsertRecords('terms', [...outcome.terms.values()], message);
      if (outcome.balances.length) await this.store.addBalances(outcome.balances, message);
      if (outcome.moves.size) await this.store.moveBalances([...outcome.moves.values()].map((m) => ({ id: m.balance.id, accountId: m.to })), message);
      const balances = [...outcome.moves.values()].map((m) => m.balance);
      const termsBefore = [...outcome.termsRemoved.values()];
      const categoriesBefore = [...outcome.categoriesBefore.values()];
      const before = { transactions: [...outcome.touchedRows.values()], accounts: [...outcome.touchedAccounts.values()], ...(balances.length ? { balances } : {}), ...(termsBefore.length ? { terms: termsBefore } : {}), ...(categoriesBefore.length ? { categories: categoriesBefore } : {}) };
      const decided = await this.decide(p, { status: 'applied', applied: doing.map((c) => c.key), before }, message);
      await this.commit();
      // Another proposal it has left with nothing to do closes now, in a commit of its own.
      const alsoDone = await this.sweep();
      return { ...this.view(decided), ...(alsoDone.length ? { alsoDone: alsoDone.map(({ id: doneId, title }) => ({ id: doneId, title })) } : {}) };
    });
  }

  dismiss(id: string, reason?: string): Promise<ProposalDecision> {
    return this.lock.run(async () => {
      const p = this.requirePending(id);
      const decided = await this.decide(p, { status: 'dismissed', ...(reason?.trim() ? { dismissedReason: reason.trim().slice(0, 1000) } : {}) }, `proposal: ${p.title} (dismissed)`);
      await this.commit();
      return this.view(decided);
    });
  }

  /** Close one your data already says all of, as already done: nothing changes, and it is not a no. */
  close(id: string): Promise<ProposalDecision> {
    return this.lock.run(async () => {
      const p = this.requirePending(id);
      const outcome = simulate(this.store, p.changes, new Set(), p.id);
      if (!leavesNothing(this.store, p, outcome)) {
        const misfits = [...outcome.results.values()].filter((r) => r.problem).length;
        throw new StoreError(misfits ? `${misfits === 1 ? 'A change no longer fits' : `${misfits} changes no longer fit`} your data, so it is not done: dismiss it instead.` : 'Applying it would still change your data, so it is not done: apply it, or dismiss it.', 409);
      }
      const done = await this.decide(p, { status: 'superseded' }, `proposal: ${p.title} (already done)`);
      await this.commit();
      return this.view(done);
    });
  }

  /** The proposal with the rows and accounts it names, and what each change would do now. */
  view(p: Proposal): ProposalView {
    const { before, ...proposal } = p;
    const pending = p.status === 'pending';
    const outcome = pending ? simulate(this.store, p.changes, new Set(), p.id) : undefined;
    const changes: ProposalChangeView[] = p.changes.map((change) => ({ change, ...(outcome?.results.get(change.key) ?? {}) }));
    // A decided proposal shows its rows and accounts as they were before it: what it changed.
    const was = new Map((before?.transactions ?? []).map((t) => [t.id, t]));
    const wasAccount = new Map((before?.accounts ?? []).map((a) => [a.id, a]));
    const find = (id: string) => (pending ? undefined : was.get(id)) ?? this.store.transaction(id);
    const named = new Set(p.changes.flatMap(namedRows));
    // Each named row's transfer partner, as it was then (a decided proposal) or is now.
    const wanted = new Set([...named].map(find).flatMap((t) => (t?.transferGroup ? [t.transferGroup] : [])));
    const groups = new Map<string, Transaction[]>();
    if (wanted.size) {
      for (const t of [...(pending ? [] : was.values()), ...this.store.transactions()]) {
        if (!t.transferGroup || !wanted.has(t.transferGroup)) continue;
        const list = groups.get(t.transferGroup) ?? groups.set(t.transferGroup, []).get(t.transferGroup)!;
        if (!list.some((x) => x.id === t.id)) list.push(t);
      }
    }
    // The partners are shown in full too: an unlink is judged by both rows.
    const ids = new Set([...named, ...[...groups.values()].flat().map((t) => t.id)]);
    const partnerRow = new Map([...groups.values()].flatMap((list) => list.map((t) => [t.id, t] as const)));
    const importName = new Map(this.store.imports.map((i) => [i.id, i.fileName]));
    const rows: Record<string, ProposalRow> = {};
    const accountIds = new Set<string>();
    for (const id of ids) {
      const t = find(id) ?? partnerRow.get(id);
      if (!t) {
        rows[id] = { id, accountId: '', date: '', amount: 0, currency: 'GBP', description: '', missing: true };
        continue;
      }
      const partner = t.transferGroup ? (groups.get(t.transferGroup) ?? []).find((x) => x.id !== t.id) : undefined;
      accountIds.add(t.accountId);
      if (partner) accountIds.add(partner.accountId);
      rows[id] = {
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        ...(t.category ? { category: t.category } : {}),
        ...(t.categorisedBy ? { categorisedBy: t.categorisedBy } : {}),
        ...(t.transferGroup ? { transferGroup: t.transferGroup } : {}),
        ...(partner ? { partner: { id: partner.id, accountId: partner.accountId, date: partner.date, amount: partner.amount, description: partner.description } } : {}),
        ...(t.source?.importId ? { source: { importId: t.source.importId, ...(importName.has(t.source.importId) ? { fileName: importName.get(t.source.importId)! } : {}) } } : {}),
      };
    }
    for (const c of p.changes) {
      if (c.kind === 'set_account_dates' || c.kind === 'set_terms') accountIds.add(c.account);
      if (c.kind === 'link_accounts') accountIds.add(c.account).add(c.continues);
    }
    // A balance a change moves, as it is now (a decided proposal: as it was before it).
    const wasBalance = new Map((before?.balances ?? []).map((b) => [b.id, b]));
    const balances: Record<string, ProposalBalance> = {};
    for (const c of p.changes) {
      if (c.kind !== 'move_balance') continue;
      accountIds.add(c.to);
      const b = (pending ? undefined : wasBalance.get(c.balance)) ?? this.store.balances().find((x) => x.id === c.balance);
      if (!b) {
        balances[c.balance] = { id: c.balance, accountId: '', date: '', balance: 0, currency: 'GBP', kind: 'statement', missing: true };
        continue;
      }
      accountIds.add(b.accountId);
      balances[b.id] = {
        id: b.id,
        accountId: b.accountId,
        date: b.date,
        balance: b.balance,
        currency: b.currency,
        kind: b.kind,
        ...(() => {
          // The rate its reading gave, kept with the account's terms for that day.
          const rate = this.store.terms(b.accountId).find((t) => t.asOf === b.date && t.source.importId !== undefined && t.source.importId === b.source.importId)?.rates[0]?.rate;
          return rate !== undefined ? { interestRate: rate } : {};
        })(),
        ...(b.source.importId ? { source: { importId: b.source.importId, ...(importName.has(b.source.importId) ? { fileName: importName.get(b.source.importId)! } : {}) } } : {}),
      };
    }
    const accounts: ProposalView['accounts'] = {};
    for (const id of accountIds) {
      const a = (pending ? undefined : wasAccount.get(id)) ?? this.store.account(id);
      if (!a) continue;
      const inst = this.store.institution(a.institutionId);
      accounts[id] = { id: a.id, name: a.name, type: a.type, status: a.status, ...(a.openedOn ? { openedOn: a.openedOn } : {}), ...(a.closedOn ? { closedOn: a.closedOn } : {}), ...(inst ? { institutionName: inst.name } : {}) };
    }
    const ready = changes.filter((c) => !c.problem && !c.alreadySo).length;
    const done = outcome !== undefined && leavesNothing(this.store, p, outcome);
    return { proposal, changes, rows, balances, accounts, ready, problems: changes.filter((c) => c.problem).length, ...(done ? { alreadyDone: true as const } : {}) };
  }

  /** Close the waiting proposals your data already says all of. The caller holds the lock. */
  private async sweep(): Promise<Proposal[]> {
    const done = [...this.pending.values()].filter((p) => leavesNothing(this.store, p));
    if (!done.length) return [];
    // What got there first (an import, an edit) is committed first, under its own message.
    await this.commit();
    const closed: Proposal[] = [];
    for (const p of done) closed.push(await this.decide(p, { status: 'superseded' }, `proposal: ${p.title} (already done)`));
    await this.commit();
    return closed;
  }

  /** Keep it in the data as decided, and stop it waiting. */
  private async decide(p: Proposal, outcome: Pick<Proposal, 'status'> & Partial<Pick<Proposal, 'applied' | 'dismissedReason' | 'before'>>, message: string): Promise<Proposal> {
    const stamp = nowISO();
    const decided: Proposal = { ...p, ...outcome, updatedAt: stamp, decidedAt: stamp };
    await this.store.saveProposal(decided, message);
    await this.forget(p.id);
    this.emit('update', decided);
    return decided;
  }

  private requirePending(id: string): Proposal {
    const p = this.pending.get(id);
    if (p) return p;
    const decided = this.store.proposals.find((d) => d.id === id);
    throw new StoreError(decided && decided.status !== 'pending' ? DECIDED[decided.status] : 'No such proposal', decided ? 409 : 404);
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async save(p: Proposal): Promise<void> {
    await atomicWrite(this.file(p.id), JSON.stringify(p, null, 2), 0o600);
    this.pending.set(p.id, p);
    this.emit('update', p);
  }

  private async forget(id: string): Promise<void> {
    this.pending.delete(id);
    await rm(this.file(id), { force: true });
  }
}
