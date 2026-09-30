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

import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProposalChangeView, ProposalCheckResponse, ProposalListResponse, ProposalRow, ProposalSummary, ProposalView } from '../shared/api';
import { CategoryIndex } from '../shared/categories';
import { transferLegCategory } from '../shared/categorise';
import { diffDays, formatDate, today } from '../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../shared/money';
import { AccountSchema, ProposalSchema, type Account, type Proposal, type ProposalInput, type ProposedChange, type Provenance, type Transaction } from '../shared/schema';
import { atomicWrite, nowISO } from './fsutil';
import { proposalId, transferGroupId } from './ids';
import { StoreError, type DecidedProposalSummary, type Store } from './store';

/** Days apart the two rows of a proposed transfer may be: a card payment can take a few days. */
const LINK_DAYS = 10;
/** Days apart a duplicate and the rows it repeats may be. */
const DUPLICATE_DAYS = 10;
/** Proposals waiting at once: an agent that keeps proposing is stopped here, not in your queue. */
const MAX_PENDING = 50;

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
}

const money = (t: Pick<Transaction, 'amount' | 'currency'>) => formatMoney(t.amount, { currency: t.currency });
const brief = (t: Transaction, accountName: (id: string) => string) => `${money(t)} on ${formatDate(t.date)} in ${accountName(t.accountId)}`;

/**
 * Run a proposal's changes in order on a copy of the data, leaving out `leaveOut`: what each would
 * do, and what applying them all would write.
 */
function simulate(store: Store, changes: ProposedChange[], leaveOut: ReadonlySet<string>): Outcome {
  const cats = new CategoryIndex(store.categories);
  const accountName = (id: string) => store.account(id)?.name ?? id;
  const out: Outcome = { results: new Map(), patches: new Map(), removed: new Map(), accounts: new Map(), touchedRows: new Map(), touchedAccounts: new Map() };
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
        if (t.category === c.category) return { alreadySo: true };
        patch(t, { category: c.category, categorisedBy: 'user' });
        return {};
      }
      case 'remove_duplicate': {
        const t = row(c.transaction);
        // Gone already: what it asks for is done.
        if (!t) return rows.get(c.transaction) === null ? { problem: 'Another change here removes it already.' } : { alreadySo: true };
        if (t.transferGroup) return { problem: linkedNow(t) };
        if (c.sameAs.includes(t.id)) return { problem: 'It cannot repeat itself.' };
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
        if (!out.touchedRows.has(t.id)) out.touchedRows.set(t.id, store.transaction(t.id)!);
        out.patches.delete(t.id);
        out.removed.set(t.id, store.transaction(t.id)!);
        rows.set(t.id, null);
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
    }
  };

  for (const c of changes) if (!leaveOut.has(c.key)) out.results.set(c.key, run(c));
  return out;
}

/** The transactions a change names. */
function namedRows(c: ProposedChange): string[] {
  switch (c.kind) {
    case 'unlink_transfer':
    case 'set_category':
      return [c.transaction];
    case 'link_transfer':
      return [c.from, c.to];
    case 'remove_duplicate':
      return [c.transaction, ...c.sameAs];
    case 'set_account_dates':
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

  constructor(
    private readonly store: Store,
    /** The work area's proposals directory: proposals waiting for you (never committed). */
    readonly dir: string,
  ) {
    super();
  }

  static forWorkDir(store: Store, workDir: string): ProposalService {
    return new ProposalService(store, path.join(workDir, 'proposals'));
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
    const outcome = simulate(this.store, proposal.changes, new Set());
    const problems = proposal.changes.flatMap((c) => {
      const r = outcome.results.get(c.key);
      return r?.problem ? [{ key: c.key, problem: r.problem }] : r?.alreadySo ? [{ key: c.key, problem: 'Your data already says this: leave the change out.' }] : [];
    });
    if (problems.length) throw new ProposalProblems(`${problems.length} of the ${proposal.changes.length} changes do not fit your data.`, problems);
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
  async withdraw(id: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p) throw new StoreError(this.store.proposals.some((d) => d.id === id) ? 'The owner has decided that proposal already.' : 'No such proposal', this.store.proposals.some((d) => d.id === id) ? 409 : 404);
    this.pending.delete(id);
    await rm(this.file(id), { force: true });
    this.emit('update', { ...p, status: 'dismissed' });
  }

  /** What applying it would do with some changes left out. */
  check(id: string, leaveOut: string[]): ProposalCheckResponse {
    const p = this.requirePending(id);
    const outcome = simulate(this.store, p.changes, new Set(leaveOut));
    const changes = p.changes.filter((c) => !leaveOut.includes(c.key)).map((c) => ({ key: c.key, ...outcome.results.get(c.key) }));
    return { changes, ready: changes.filter((c) => !c.problem && !c.alreadySo).length, problems: changes.filter((c) => c.problem).length };
  }

  /** Apply it, leaving out `leaveOut`. Every change applied must fit the data as it is now. */
  async apply(id: string, leaveOut: string[] = []): Promise<ProposalView> {
    const p = this.requirePending(id);
    const skip = new Set(leaveOut);
    const outcome = simulate(this.store, p.changes, skip);
    const problems = p.changes.flatMap((c) => {
      const problem = outcome.results.get(c.key)?.problem;
      return problem ? [{ key: c.key, problem }] : [];
    });
    if (problems.length) throw new ProposalProblems(`${problems.length === 1 ? 'A change no longer fits' : `${problems.length} changes no longer fit`} your data: leave ${problems.length === 1 ? 'it' : 'them'} out, or dismiss the proposal.`, problems, 409);
    const doing = p.changes.filter((c) => !skip.has(c.key) && !outcome.results.get(c.key)?.alreadySo);
    if (!doing.length) throw new StoreError('Nothing is left to apply: your data already says all of it. Dismiss the proposal instead.', 409);

    // One message for every write, so the data's history shows the proposal as one commit.
    const message = `proposal: ${p.title} (${doing.length} change${doing.length === 1 ? '' : 's'} applied)`;
    if (outcome.patches.size) await this.store.updateTransactions([...outcome.patches].map(([tid, patch]) => ({ id: tid, patch })), message);
    if (outcome.removed.size) await this.store.deleteTransactions([...outcome.removed.keys()], message);
    for (const account of outcome.accounts.values()) await this.store.upsertAccount(account, message);
    const stamp = nowISO();
    const decided: Proposal = {
      ...p,
      status: 'applied',
      updatedAt: stamp,
      decidedAt: stamp,
      applied: doing.map((c) => c.key),
      before: { transactions: [...outcome.touchedRows.values()], accounts: [...outcome.touchedAccounts.values()] },
    };
    await this.store.saveProposal(decided, message);
    await this.forget(p.id);
    this.emit('update', decided);
    return this.view(decided);
  }

  async dismiss(id: string, reason?: string): Promise<ProposalView> {
    const p = this.requirePending(id);
    const stamp = nowISO();
    const decided: Proposal = { ...p, status: 'dismissed', updatedAt: stamp, decidedAt: stamp, ...(reason?.trim() ? { dismissedReason: reason.trim().slice(0, 1000) } : {}) };
    await this.store.saveProposal(decided, `proposal: ${p.title} (dismissed)`);
    await this.forget(p.id);
    this.emit('update', decided);
    return this.view(decided);
  }

  /** The proposal with the rows and accounts it names, and what each change would do now. */
  view(p: Proposal): ProposalView {
    const { before, ...proposal } = p;
    const pending = p.status === 'pending';
    const outcome = pending ? simulate(this.store, p.changes, new Set()) : undefined;
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
    for (const c of p.changes) if (c.kind === 'set_account_dates') accountIds.add(c.account);
    const accounts: ProposalView['accounts'] = {};
    for (const id of accountIds) {
      const a = (pending ? undefined : wasAccount.get(id)) ?? this.store.account(id);
      if (!a) continue;
      const inst = this.store.institution(a.institutionId);
      accounts[id] = { id: a.id, name: a.name, type: a.type, status: a.status, ...(a.openedOn ? { openedOn: a.openedOn } : {}), ...(a.closedOn ? { closedOn: a.closedOn } : {}), ...(inst ? { institutionName: inst.name } : {}) };
    }
    const ready = changes.filter((c) => !c.problem && !c.alreadySo).length;
    return { proposal, changes, rows, accounts, ready, problems: changes.filter((c) => c.problem).length };
  }

  private requirePending(id: string): Proposal {
    const p = this.pending.get(id);
    if (p) return p;
    const decided = this.store.proposals.find((d) => d.id === id);
    throw new StoreError(decided ? `You ${decided.status} this proposal already.` : 'No such proposal', decided ? 409 : 404);
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
