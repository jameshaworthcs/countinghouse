// Linking the two legs of a transfer while they wait for review (docs/INGESTION.md, "Linking
// transfers before commit").
//
// A row of a draft can be linked to a row of another import waiting for review (or of another
// account in the same one): a pending link, kept on both rows (`pendingLink`). When one of them is
// committed, the other's link becomes a link to the transaction it recorded (`transferMatch`), and
// when that one is committed too, the two are linked as a transfer, as any matched transfer is
// (./commit.ts). A row can also be linked to a recorded transaction directly, or unlinked from the
// one the draft found. The links are the server's: a draft saved from the review page keeps them as
// they are here (`keepLinks`), so linking from another import's page is never undone by it.

import type { DraftLinkView, LinkCandidate } from '../../shared/api';
import { transferLegCategory } from '../../shared/categorise';
import { diffDays } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { AccountType, Draft, DraftSection, DraftTransaction, ImportRecord } from '../../shared/schema';
import type { Store } from '../store';

/** How far apart in days the two legs of a transfer may be dated to be offered as a pair. */
export const LINK_WINDOW_DAYS = 14;
/** Candidates offered of each kind, the nearest in date first. */
const MAX_CANDIDATES = 12;

export interface RowRef {
  importId: string;
  key: string;
}

export interface FoundRow {
  section: DraftSection;
  row: DraftTransaction;
}

export function findRow(draft: Draft | undefined, key: string): FoundRow | undefined {
  for (const section of draft?.sections ?? []) {
    const row = section.transactions.find((t) => t.key === key);
    if (row) return { section, row };
  }
  return undefined;
}

export interface SectionAccount {
  /** Unknown until commit for an account the import creates. */
  id?: string;
  type: AccountType;
  name: string;
}

/** The account a section's rows go into, as far as it is known before commit. */
export function sectionAccount(store: Store, section: DraftSection): SectionAccount | undefined {
  const target = section.target;
  if (target.mode === 'existing') {
    const a = store.account(target.accountId);
    return a ? { id: a.id, type: a.type, name: a.name } : undefined;
  }
  if (target.mode === 'new') return { type: target.account.type, name: `${target.account.name} (new)` };
  return undefined;
}

/** Two accounts that are, or may be, the same: never the two legs of a transfer. */
export function sameAccount(a: SectionAccount, b: { id?: string | undefined }): boolean {
  return a.id !== undefined && a.id === b.id;
}

/** A row as one leg of a transfer with an account: its category (unless you chose one) and the other account. */
export function asTransferLeg(row: DraftTransaction, mine: SectionAccount, other: { id?: string | undefined; type: AccountType }): DraftTransaction {
  const out: DraftTransaction = { ...row };
  if (row.categorisedBy !== 'user') {
    out.category = transferLegCategory(mine.type, other.type, row.amount);
    out.categorisedBy = 'transfer';
    delete out.ruleId;
  }
  if (other.id) out.counterpartyAccountId = other.id;
  else delete out.counterpartyAccountId;
  return out;
}

/** `row` with no link of either kind, and your word that it has none. */
export function withoutLink(row: DraftTransaction): DraftTransaction {
  const { pendingLink: _p, transferMatch: _t, ...rest } = row;
  return { ...rest, transferMatchBy: 'user' };
}

/** `draft` with `row` (by key) replaced. */
export function replaceRow(draft: Draft, row: DraftTransaction): Draft {
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, transactions: s.transactions.map((t) => (t.key === row.key ? row : t)) })) };
}

function copyLinks(from: DraftTransaction, to: DraftTransaction): DraftTransaction {
  const { pendingLink: _p, transferMatch: _t, transferMatchBy: _b, ...rest } = to;
  return {
    ...rest,
    ...(from.pendingLink ? { pendingLink: from.pendingLink } : {}),
    ...(from.transferMatch ? { transferMatch: from.transferMatch } : {}),
    ...(from.transferMatchBy ? { transferMatchBy: from.transferMatchBy } : {}),
  };
}

/**
 * A draft sent by the review page (or a token), with each row's links as the server has them: they
 * change only by linking and unlinking, which can happen from the other import's page meanwhile.
 */
export function keepLinks(server: Draft | undefined, draft: Draft): Draft {
  if (!server) return draft;
  const rows = new Map(server.sections.flatMap((s) => s.transactions.map((t) => [t.key, t] as const)));
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, transactions: s.transactions.map((t) => (rows.has(t.key) ? copyLinks(rows.get(t.key)!, t) : t)) })) };
}

/**
 * A draft built again from its reading, keeping the links you made or took away (and the transfer
 * categories they set), for rows that are still the same payment.
 */
export function keepYourLinks(before: Draft | undefined, fresh: Draft): Draft {
  if (!before) return fresh;
  const yours = new Map(before.sections.flatMap((s) => s.transactions.filter((t) => t.pendingLink || t.transferMatchBy === 'user').map((t) => [t.key, t] as const)));
  if (!yours.size) return fresh;
  const chosen = new Set([...yours.values()].flatMap((t) => (t.transferMatch ? [t.transferMatch] : [])));
  return {
    ...fresh,
    sections: fresh.sections.map((s) => ({
      ...s,
      transactions: s.transactions.map((t) => {
        const was = yours.get(t.key);
        if (!was || toMinor(was.amount) !== toMinor(t.amount) || was.date !== t.date) {
          // Not a match of its own for a transaction you linked to another row.
          if (t.transferMatch && chosen.has(t.transferMatch)) {
            const { transferMatch: _t, ...rest } = t;
            return rest;
          }
          return t;
        }
        const out = copyLinks(was, t);
        if (was.categorisedBy === 'transfer') {
          if (was.category) out.category = was.category;
          out.categorisedBy = 'transfer';
          delete out.ruleId;
        }
        if (was.counterpartyAccountId) out.counterpartyAccountId = was.counterpartyAccountId;
        return out;
      }),
    })),
  };
}

const days = (a: string, b: string) => Math.abs(diffDays(a, b));

/**
 * What a row could be linked to: rows of imports waiting for review, other accounts' rows of this
 * one, and recorded transactions, each for the opposite amount in another account, within
 * `LINK_WINDOW_DAYS`, the nearest first. Rows already recorded (duplicates), rows linked elsewhere
 * and transactions already in a transfer are left out.
 */
export function linkCandidates(store: Store, pending: readonly ImportRecord[], self: ImportRecord, key: string): LinkCandidate[] {
  const found = findRow(self.draft, key);
  if (!found) return [];
  const mine = sectionAccount(store, found.section);
  if (!mine) return [];
  const want = -toMinor(found.row.amount);
  const near = (date: string, amount: number) => toMinor(amount) === want && days(date, found.row.date) <= LINK_WINDOW_DAYS;
  const rows: LinkCandidate[] = [];
  for (const r of pending) {
    if (r.status !== 'review' || !r.draft) continue;
    for (const section of r.draft.sections) {
      if (r.id === self.id && section.key === found.section.key) continue;
      const theirs = sectionAccount(store, section);
      if (!theirs || sameAccount(mine, theirs)) continue;
      for (const t of section.transactions) {
        if (t.status === 'duplicate' || !near(t.date, t.amount)) continue;
        if (t.pendingLink && !(t.pendingLink.importId === self.id && t.pendingLink.key === key)) continue;
        rows.push({ kind: 'pending', importId: r.id, key: t.key, fileName: r.document.fileName, accountName: theirs.name, date: t.date, amount: t.amount, description: t.payee ?? t.description, days: days(t.date, found.row.date), included: t.include });
      }
    }
  }
  const recorded: LinkCandidate[] = [];
  for (const t of store.transactions()) {
    if (t.transferGroup || !near(t.date, t.amount) || sameAccount(mine, { id: t.accountId }) || t.id === found.row.duplicateOf) continue;
    recorded.push({ kind: 'recorded', transactionId: t.id, accountName: store.account(t.accountId)?.name ?? t.accountId, date: t.date, amount: t.amount, description: t.payee ?? t.description, days: days(t.date, found.row.date) });
  }
  const byNearest = (a: LinkCandidate, b: LinkCandidate) => a.days - b.days || a.date.localeCompare(b.date);
  return [...rows.sort(byNearest).slice(0, MAX_CANDIDATES), ...recorded.sort(byNearest).slice(0, MAX_CANDIDATES)];
}

/** What each linked row of a draft is linked to, for the review page. */
export function linkViews(store: Store, pending: ReadonlyMap<string, ImportRecord>, record: ImportRecord): Record<string, DraftLinkView> {
  const out: Record<string, DraftLinkView> = {};
  for (const section of record.draft?.sections ?? []) {
    for (const t of section.transactions) {
      if (t.pendingLink) {
        const other = pending.get(t.pendingLink.importId);
        const found = other?.status === 'review' ? findRow(other.draft, t.pendingLink.key) : undefined;
        const account = found ? sectionAccount(store, found.section) : undefined;
        out[t.key] = found
          ? {
              kind: 'pending',
              by: 'user',
              importId: other!.id,
              key: found.row.key,
              fileName: other!.document.fileName,
              ...(account ? { accountName: account.name } : {}),
              date: found.row.date,
              amount: found.row.amount,
              description: found.row.payee ?? found.row.description,
              included: found.row.include,
            }
          : { kind: 'gone', by: 'user', importId: t.pendingLink.importId, key: t.pendingLink.key };
      } else if (t.transferMatch) {
        const tx = store.transaction(t.transferMatch);
        const by = t.transferMatchBy === 'user' ? 'user' : 'draft';
        out[t.key] = tx
          ? { kind: 'recorded', by, transactionId: tx.id, accountName: store.account(tx.accountId)?.name ?? tx.accountId, date: tx.date, amount: tx.amount, description: tx.payee ?? tx.description }
          : { kind: 'gone', by, transactionId: t.transferMatch };
      }
    }
  }
  return out;
}
