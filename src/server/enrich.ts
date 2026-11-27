// Re-derive enrichment (payee, category, transfer links) for stored transactions from their source
// fields. Your manual edits (categorisedBy = "user") are never touched. This is what lets new rules,
// better merchant lists or new categories apply to history without re-importing anything.

import { sideOf } from '../shared/accounts';
import { CategoryIndex } from '../shared/categories';
import { Categoriser, fallbackPayeeOf, isWrapperAccount, linkedPayee, payrollPattern, transferLegCategory, type CategoriseInput, type CategoriseResult } from '../shared/categorise';
import { diffDays, formatDate } from '../shared/dates';
import { cleanPayee } from '../shared/merchants';
import { formatMoney, toMinor } from '../shared/money';
import { tidyPlace } from '../shared/places';
import type { Account, Rule, Transaction } from '../shared/schema';
import { codingPlace } from '../shared/ledger';
import { autoLinkPatches, bookRulePatches, type LedgerSource } from './analytics/ledger';
import { categoriseInputOf, categoriserFor } from './categoriser';
import { nowISO } from './fsutil';
import { ruleId, transferGroupId } from './ids';
import { StoreError, type Store } from './store';

const TRANSFERISH = new Set(['transfers', 'transfer', 'credit-card-payment', 'savings-transfer', 'investment-transfer', 'contribution', 'withdrawal']);

/**
 * A payee that is the bank's wording rather than a name: the description itself, or one that keeps
 * its words for how the money moved ("…VIA FASTER PAYMENT TO…", "… Purchase | EUR 24.50 | FX rate").
 */
export function payeeLooksRaw(payee: string, description: string): boolean {
  if (payee.trim().toLowerCase() === description.trim().toLowerCase()) return true;
  return /\b(?:VIA FASTER PAYMENT|FASTER PAYMENTS? RECEIPT|REFERENCE|MANDATE|BANK GIRO CREDIT|DIRECT DEBIT|BILL PAYMENT|THIRD PARTY PAYMENT|CARD PAYMENT|REF)\b|\(VIA (?:APPLE|GOOGLE) PAY\)|\|\s*[A-Z]{3}\s+[\d.,]|FX RATE|&AMP;|\s(?:PURCHASE|REFUND)$|^(?:FROM|TO)\s|\d{5,}/i.test(payee);
}

/** Letters and digits only, lower case: for asking whether one text holds another. */
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The payee enrichment gives a row: the categoriser's, unless that is only a name cut from the
 * description and the row has a clean one from elsewhere already, as the reader gave it. A payee
 * cut from the description by an earlier version of the tidying is not from
 * elsewhere: its words are the description's. A payee you set is never changed.
 */
export function nextPayee(t: Transaction, input: CategoriseInput, res: CategoriseResult): string | undefined {
  if (t.payeeSetBy === 'user') return t.payee;
  const cut = cleanPayee(t.description);
  const weak = res.payee === (input.payee ?? input.aiPayee ?? cut) || res.payee === cut;
  const fromElsewhere = t.payee !== undefined && !letters(t.description).includes(letters(t.payee));
  if (weak && t.payee && fromElsewhere && !payeeLooksRaw(t.payee, t.description)) return t.payee;
  return res.payee;
}

export interface EnrichResult {
  recategorised: number;
  transfersLinked: number;
  /** Transfers whose payee named another account of yours than the one they are linked with: given that one's name. */
  accountPayees?: string[];
  /** With `detail`: each row it would change, and how. */
  changes?: EnrichChange[];
}

/** A row enrichment changes: its payee, its category and what gave it, or a transfer link. */
export interface EnrichChange {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  payee?: { from: string | null; to: string | null };
  category?: { from: string | null; to: string | null; by: Transaction['categorisedBy'] | null };
  linked?: boolean;
  /** A link across the line between your money and a company's, taken away. */
  unlinked?: boolean;
}

/**
 * Each transaction's tidy address (shared/places.ts), worked out again from its merchant fields,
 * which stay as the document gave them. Run when the app starts, so improved rules reach history
 * and transactions from before places existed get one. Returns how many changed.
 */
export async function refreshPlaces(store: Store): Promise<number> {
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  // A tidy address says nothing about whose money it is: every row, a company's too.
  for (const t of store.allTransactions()) {
    const place = tidyPlace(t.merchant);
    if (place !== t.place) updates.push({ id: t.id, patch: { place } });
  }
  if (updates.length) await store.updateTransactions(updates, `data: tidy merchant addresses (${updates.length} transaction${updates.length === 1 ? '' : 's'})`);
  return updates.length;
}

/**
 * Rows in investment and pension accounts that nothing categorised, which the app's built-in
 * wording now explains (a provider's words for a trade or a dividend): they get that category, and
 * the payee it gives unless you set one. Run when the app starts, so wording learnt later reaches
 * rows already committed. Nothing else is touched: a category set by anyone stays, and so does a
 * row you left uncategorised. Returns how many changed.
 */
export async function categoriseInvestmentRows(store: Store): Promise<number> {
  const wrappers = store.accounts.filter((a) => isWrapperAccount(a.type));
  if (!wrappers.length) return 0;
  const categoriser = categoriserFor(store);
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  for (const a of wrappers) {
    for (const t of store.transactions(a.id)) {
      if (t.category || t.categorisedBy || t.transferGroup) continue;
      const res = categoriser.categorise({ ...categoriseInputOf(t), aiCategory: undefined });
      if (!res.category || res.categorisedBy !== 'builtin') continue;
      const patch: Partial<Transaction> = { category: res.category, categorisedBy: 'builtin' };
      if (t.payeeSetBy !== 'user' && res.payee && res.payee !== t.payee) patch.payee = res.payee;
      updates.push({ id: t.id, patch });
    }
  }
  if (updates.length) await store.updateTransactions(updates, `data: categorise ${updates.length} investment-account row${updates.length === 1 ? '' : 's'} from their wording`);
  return updates.length;
}

/**
 * Rows linked as a transfer to a row, or set to go to an account, on the other side of the line
 * between your money and a company's (shared/accounts.ts, `sideOf`): such a link is not one. It can
 * be there from before an account was a company's, or a hand edit.
 */
export function crossingRows(store: Store): Set<string> {
  const side = (accountId: string) => sideOf(store.account(accountId));
  const groups = new Map<string, Transaction[]>();
  const all = store.allTransactions();
  for (const t of all) if (t.transferGroup) (groups.get(t.transferGroup) ?? groups.set(t.transferGroup, []).get(t.transferGroup)!).push(t);
  const out = new Set<string>();
  for (const t of all) {
    const mine = side(t.accountId);
    const other = t.counterpartyAccountId ? store.account(t.counterpartyAccountId) : undefined;
    if ((other && sideOf(other) !== mine) || (t.transferGroup && groups.get(t.transferGroup)!.some((x) => side(x.accountId) !== mine))) out.add(t.id);
  }
  return out;
}

/** A row as if its link across the line were never made: unlinked, and a transfer's category gone with it. */
function withoutLink(t: Transaction): Transaction {
  const { transferGroup: _g, counterpartyAccountId: _c, ...rest } = t;
  if (t.categorisedBy !== 'transfer') return rest;
  const { category: _cat, categorisedBy: _by, ...bare } = rest;
  return bare;
}

/** Each company that has accounts, with its accounts (an account naming a company not in your data is still not yours). */
function companySides(store: Store): Map<string, Account[]> {
  const out = new Map<string, Account[]>();
  for (const a of store.allAccounts) if (a.companyId) (out.get(a.companyId) ?? out.set(a.companyId, []).get(a.companyId)!).push(a);
  return out;
}

/**
 * Work every row you did not categorise out again, and link transfer pairs. `skip` names rows left as
 * they are this time: neither changed nor linked. `accountIds` and `rows` limit it to those accounts'
 * rows and those rows.
 *
 * Your rows and a company's are worked out apart and never linked to each other (docs/INGESTION.md,
 * "Company accounts"): your rows by your rules, categories and accounts, as they always were; a
 * company's rows get a payee and a tidy address but no category (they are coded in the company's own
 * books instead, by its book rules), except as the legs of a transfer between two of that company's
 * accounts. A link found across the line is taken away (`crossingRows`). Then each company's books are
 * worked out again: codings left where they do not apply go, book rules code what they match, and the
 * app's own links between a company's rows and your loans are found again.
 */
export async function enrich(store: Store, opts: { accountIds?: string[]; rows?: ReadonlySet<string>; dryRun?: boolean; detail?: boolean; skip?: ReadonlySet<string> } = {}): Promise<EnrichResult> {
  const scope = opts.accountIds ? new Set(opts.accountIds) : null;
  const skipped = (t: Transaction) => opts.skip?.has(t.id) ?? false;
  const inScope = (t: Transaction) => (!scope || scope.has(t.accountId)) && (!opts.rows || opts.rows.has(t.id));
  const patches = new Map<string, Partial<Transaction>>();
  let recategorised = 0;
  // Transfers given the name of the account they are linked with (`linkedPayee`).
  const accountPayees = new Set<string>();
  // Links across the line come off first; the rows are then worked out as rows that were never linked.
  const crossing = crossingRows(store);
  const seen = (raw: Transaction) => (crossing.has(raw.id) ? withoutLink(raw) : raw);
  const seed = (raw: Transaction): Partial<Transaction> => (crossing.has(raw.id) ? { transferGroup: undefined, counterpartyAccountId: undefined } : {});
  // The counts are of your rows: a company's rows are worked out too, but never counted as yours.
  let companyChanged = 0;
  const note = (raw: Transaction, patch: Partial<Transaction>, company = false) => {
    const all = { ...seed(raw), ...patch };
    if (!Object.keys(all).length) return;
    patches.set(raw.id, all);
    if (company) companyChanged++;
    else if ('category' in patch && patch.category !== raw.category) recategorised++;
  };

  // Your rows.
  const categoriser = categoriserFor(store);
  for (const raw of store.transactions()) {
    if (!inScope(raw) || skipped(raw)) continue;
    const t = seen(raw);
    // A linked transfer keeps its category and its link (yours or the link's): only a payee naming
    // another account of yours than the one it is linked with is put right.
    if (t.transferGroup && (t.categorisedBy === 'transfer' || t.categorisedBy === 'user')) {
      const other = t.counterpartyAccountId ? store.account(t.counterpartyAccountId) : undefined;
      const payee = other ? linkedPayee(t, other, store.accounts) : undefined;
      if (payee) {
        note(raw, { payee });
        accountPayees.add(t.id);
      }
      continue;
    }
    if (t.categorisedBy === 'user') {
      note(raw, {});
      continue;
    }
    const input = categoriseInputOf(t);
    const res = categoriser.categorise(input);
    const patch: Partial<Transaction> = {};
    const place = tidyPlace(t.merchant);
    if (place !== raw.place) patch.place = place;
    const payee = nextPayee(t, input, res);
    if (payee !== raw.payee) patch.payee = payee;
    if (res.category !== raw.category) patch.category = res.category;
    if (res.categorisedBy !== raw.categorisedBy) patch.categorisedBy = res.categorisedBy;
    if (res.ruleId !== raw.ruleId) patch.ruleId = res.ruleId;
    if (res.counterpartyAccountId && res.counterpartyAccountId !== raw.counterpartyAccountId) patch.counterpartyAccountId = res.counterpartyAccountId;
    if (res.tags?.length) {
      const tags = [...new Set([...(t.tags ?? []), ...res.tags])];
      if (tags.length !== (t.tags?.length ?? 0)) patch.tags = tags;
    }
    note(raw, patch);
  }

  // A company's rows: a payee and a tidy address, and no category of yours.
  const companies = companySides(store);
  for (const [companyId, accounts] of companies) {
    for (const raw of store.companyTransactions(companyId)) {
      if (!inScope(raw) || skipped(raw)) continue;
      const t = seen(raw);
      note(raw, companyRowPatch(raw, t, (id) => store.account(id), accounts), true);
    }
  }

  // Link transfer pairs: opposite amounts within 4 days in two accounts on one side (yours, or one
  // company's), where at least one side already looks like a transfer (or names the other account).
  const view = (raw: Transaction): Transaction => ({ ...seen(raw), ...(patches.get(raw.id) ?? {}) });
  let transfersLinked = 0;
  let companyLinked = 0;
  // Every row pairing touches, in scope or not (a partner leg in another account): its books are kept right too.
  const paired = new Set<string>();
  const sides: [Transaction[], ReturnType<typeof transferReader>, readonly Account[], boolean][] = [[store.transactions(), transferReader(store, categoriser), store.accounts, false]];
  for (const [companyId, accounts] of companies) sides.push([store.companyTransactions(companyId), companyTransferReader(store, accounts), accounts, true]);
  for (const [rows, reader, accounts, company] of sides) {
    const viewed = rows.map(view);
    // A row marked as money with a company of yours (shared/company.ts) is never a transfer between
    // your accounts: it is neither linked nor a partner for another row.
    // Nor is a company row linked to money with you, or one you coded in its books: you said what it is.
    const candidates = viewed.filter((t) => !t.transferGroup && !t.company && !t.companyLink?.rows.length && t.books?.setBy !== 'user' && !skipped(t) && inScope(t));
    const byAmount = new Map<number, Transaction[]>();
    for (const t of viewed) {
      if (t.transferGroup || t.company || t.companyLink?.rows.length || t.books?.setBy === 'user' || skipped(t)) continue;
      const k = toMinor(t.amount);
      (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(t);
    }
    const pairs = pairTransfers(store, candidates, byAmount, reader);
    for (const [t, other, acc] of pairs.legs) {
      const raw = store.transaction(t.id)!;
      const patch = { ...seed(raw), ...(patches.get(t.id) ?? {}), transferGroup: pairs.groupOf.get(t.id)!, counterpartyAccountId: other.id } as Partial<Transaction>;
      if (t.categorisedBy !== 'user' || company) {
        patch.category = transferLegCategory(acc.type, other.type, t.amount);
        patch.categorisedBy = 'transfer';
        if (company && raw.ruleId !== undefined) patch.ruleId = undefined;
      }
      const payee = linkedPayee(t, other, accounts);
      if (payee) {
        patch.payee = payee;
        if (!company) accountPayees.add(t.id);
      }
      // A leg of a transfer between the company's own accounts posts by itself: a rule's or a proposal's
      // coding goes (one you set keeps the row out of pairing, above).
      if (company && raw.books && raw.books.setBy !== 'user') patch.books = undefined;
      paired.add(t.id);
      patches.set(t.id, patch);
    }
    if (company) companyLinked += pairs.count;
    else transfersLinked += pairs.count;
  }

  // A company's books (docs/FORMULAS.md §22): with the rows as linked above, a coding or a link left where
  // it does not apply goes (a hand edit, a mark taken away, a row now a leg of a company transfer); then
  // each company's book rules code what they match (never a coding you or a proposal set); then the app's
  // own links between a company's rows and your loans are worked out again. Your rows' categories are
  // untouched by any of it.
  let booksChanged = 0;
  const stage = (id: string, p: Partial<Transaction>) => {
    const raw = store.transaction(id);
    if (!raw || (!inScope(raw) && !paired.has(id)) || skipped(raw)) return;
    patches.set(id, { ...seed(raw), ...(patches.get(id) ?? {}), ...p });
    booksChanged++;
  };
  const overlay: LedgerSource = {
    account: (id) => store.account(id),
    company: (id) => store.company(id),
    transaction: (id) => {
      const raw = store.transaction(id);
      return raw ? view(raw) : undefined;
    },
    transactions: (accountId) => store.transactions(accountId).map(view),
    companyAccounts: (id) => store.companyAccounts(id),
    companyTransactions: (id) => store.companyTransactions(id).map(view),
    companyJournals: (id) => store.companyJournals(id),
    bookRules: (id) => store.bookRules(id),
    balances: (id) => store.balances(id),
  };
  for (const raw of [...store.transactions(), ...[...companies.keys()].flatMap((id) => store.companyTransactions(id))]) {
    const t = view(raw);
    if (t.books && 'problem' in codingPlace(t, overlay)) stage(t.id, { books: undefined });
    if (t.companyLink && !store.account(t.accountId)?.companyId) stage(t.id, { companyLink: undefined });
  }
  // Only for a company whose books are kept here: without them its Books tab is not there to see them.
  for (const c of store.companies) {
    if (!c.books) continue;
    for (const { id, patch } of bookRulePatches(overlay, c.id)) stage(id, patch);
    if (companies.has(c.id)) for (const { id, patch } of autoLinkPatches(overlay, c.id)) stage(id, patch);
  }

  // What changes, against the rows as they are before anything is written.
  const changes: EnrichChange[] = [];
  if (opts.detail) {
    for (const [id, patch] of patches) {
      const t = store.transaction(id);
      if (!t) continue;
      const change: EnrichChange = { id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description };
      if ('payee' in patch && patch.payee !== t.payee) change.payee = { from: t.payee ?? null, to: patch.payee ?? null };
      if ('category' in patch && patch.category !== t.category) change.category = { from: t.category ?? null, to: patch.category ?? null, by: ('categorisedBy' in patch ? patch.categorisedBy : t.categorisedBy) ?? null };
      if (patch.transferGroup) change.linked = true;
      if ('transferGroup' in patch && !patch.transferGroup && t.transferGroup) change.unlinked = true;
      if (change.payee || change.category || change.linked || change.unlinked) changes.push(change);
    }
  }
  if (!opts.dryRun && patches.size) {
    await store.updateTransactions(
      [...patches.entries()].map(([id, patch]) => ({ id, patch })),
      `enrich: ${recategorised} recategorised, ${transfersLinked} transfers linked${companyChanged || companyLinked ? `; company rows: ${companyChanged} worked out, ${companyLinked} transfers linked` : ''}${booksChanged ? `; ${booksChanged} coded or linked in a company’s books` : ''}`,
    );
  }
  const named = accountPayees.size ? { accountPayees: [...accountPayees] } : {};
  if (!opts.detail) return { recategorised, transfersLinked, ...named };
  return { recategorised, transfersLinked, ...named, changes };
}

/**
 * What enrichment makes of a company's row (docs/INGESTION.md, "Company accounts"). `t` is the row as
 * seen (`raw` without a link across the line); the patch is against `raw`, as stored.
 * - A leg of a transfer between two of its company's accounts: the transfer category for its leg
 *   (`transferLegCategory`, by `transfer`), and the other account's name as its payee where the
 *   payee named a third account of the company.
 * - Any other row: its tidy address, the payee its source names (or one cut from its description),
 *   and no category at all. A category, rule or counterparty it carries is taken away, whoever set
 *   it: a category is one of yours, so on a company's row it is in the wrong place (from before its
 *   account was a company's, or set by hand). What it means to the company is its coding in the
 *   company's books (`books`), set apart from here.
 * A payee you set stays, and a mark of money with a company is taken away (it is for your own rows).
 */
export function companyRowPatch(raw: Transaction, t: Transaction, accountOf: (id: string) => Account | undefined, accounts: readonly Account[]): Partial<Transaction> {
  const patch: Partial<Transaction> = {};
  // A mark of money with a company is for your own rows (shared/company.ts): on a company's row, from
  // before its account was the company's or a hand edit, it is in the wrong place.
  if (raw.company !== undefined) patch.company = undefined;
  const place = tidyPlace(t.merchant);
  if (place !== raw.place) patch.place = place;
  const self = accountOf(t.accountId);
  const other = t.transferGroup && t.counterpartyAccountId ? accountOf(t.counterpartyAccountId) : undefined;
  if (t.transferGroup && self && other) {
    const category = transferLegCategory(self.type, other.type, t.amount);
    if (raw.category !== category) patch.category = category;
    if (raw.categorisedBy !== 'transfer') patch.categorisedBy = 'transfer';
    if (raw.ruleId !== undefined) patch.ruleId = undefined;
    const payee = linkedPayee(t, other, accounts);
    if (payee) patch.payee = payee;
    return patch;
  }
  const input = categoriseInputOf(t);
  const payee = nextPayee(t, input, { payee: fallbackPayeeOf(input) });
  if (payee !== raw.payee) patch.payee = payee;
  for (const k of ['category', 'categorisedBy', 'ruleId', 'counterpartyAccountId'] as const) if (raw[k] !== undefined) patch[k] = undefined;
  return patch;
}

/**
 * Take away the links across the line between your money and a company's, and work out again the
 * rows that change sides: an account given to a company (or back to you) and the rows linked to its
 * rows. With no account, only the rows linked across the line (start-up upkeep: a hand edit of
 * accounts.json). Nothing else is worked out again, so no other row changes unseen. Returns how many
 * rows changed.
 */
export async function separateSides(store: Store, accountId?: string): Promise<number> {
  const crossing = crossingRows(store);
  const rows = new Set([...crossing, ...(accountId ? store.transactions(accountId).map((t) => t.id) : [])]);
  if (!rows.size) return 0;
  const result = await enrich(store, { rows, detail: true });
  return result.changes?.length ?? 0;
}

/** Your choices on the preview of re-applying (docs/FORMULAS.md §10, "Re-applying categorisation"). */
export interface ReapplyChoices {
  /** Payments you gave a category: yours from now on, so nothing re-categorises them. */
  decided?: { id: string; category: string }[];
  /** Payments left as they are this time: neither changed nor linked, and offered again next time. */
  skip?: string[];
  /** Rules to make ("always"): a payee's payments, from now on, in the category you chose. */
  rules?: { match: Rule['match']; category: string; name?: string | undefined }[];
}

/**
 * Re-apply categorisation with your choices on its preview: your categories are written first, as
 * yours; then your new rules; then everything else is worked out again, as `enrich` does, but for the
 * payments you left as they are. Nothing is written when a choice is wrong.
 */
export async function reapply(store: Store, choices: ReapplyChoices = {}): Promise<EnrichResult & { decided: number; rules: number }> {
  const cats = new CategoryIndex(store.categories);
  const known = (id: string) => {
    if (!cats.get(id)) throw new StoreError(`Unknown category "${id}".`);
  };
  const decided = choices.decided ?? [];
  for (const d of decided) {
    known(d.category);
    const t = store.transaction(d.id);
    if (!t) throw new StoreError(`Unknown transaction ${d.id}`, 404);
    // Your categories are for your rows: a company's row takes none.
    if (store.account(t.accountId)?.companyId) throw new StoreError(`${formatMoney(t.amount)} on ${formatDate(t.date)} is on a company's own account: it takes no category of yours.`);
    if (t.transferGroup && cats.kindOf(d.category) !== 'transfer') {
      throw new StoreError(`${formatMoney(t.amount)} on ${formatDate(t.date)} is linked as a transfer between your accounts: unlink it on the Transactions page before putting it in ${cats.name(d.category)}.`);
    }
  }
  for (const id of choices.skip ?? []) if (!store.transaction(id)) throw new StoreError(`Unknown transaction ${id}`, 404);
  for (const r of choices.rules ?? []) known(r.category);

  if (decided.length) {
    await store.updateTransactions(
      decided.map((d) => ({ id: d.id, patch: { category: d.category, categorisedBy: 'user' as const, ruleId: undefined } })),
      `categorise: ${decided.length} decided while re-applying`,
    );
  }
  const stamp = nowISO();
  const rules: Rule[] = (choices.rules ?? []).map((r) => ({ id: ruleId(), name: r.name ?? `${r.match.value} → ${cats.name(r.category)}`, enabled: true, priority: 100, match: r.match, set: { category: r.category }, createdAt: stamp, updatedAt: stamp }));
  if (rules.length) await store.setRules([...store.rules, ...rules], `rule: add ${rules.map((r) => r.name).join('; ')}`);
  // Re-applying applies every rule, the new ones too.
  const result = await enrich(store, { skip: new Set(choices.skip ?? []) });
  return { ...result, decided: decided.length, rules: rules.length };
}

/**
 * A rule you just made, changed or deleted, applied to the rows it matches and to the rows it
 * categorised before, and to nothing else: each takes what the categoriser now says of it (rules
 * come first; a deleted or switched-off rule's rows go back to what the app makes of them).
 * Rows you categorised, and transfers linked between your accounts, stay as they are. Re-applying
 * everything is Settings → Rules → Preview re-applying to history, so a rule never brings in other changes
 * unseen. Returns how many rows changed category.
 */
export async function applyRule(store: Store, ruleId: string, opts: { label?: string } = {}): Promise<{ recategorised: number }> {
  const rule = store.rules.find((r) => r.id === ruleId);
  const categoriser = categoriserFor(store);
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  let recategorised = 0;
  for (const t of store.transactions()) {
    if (t.categorisedBy === 'user' || (t.transferGroup && t.categorisedBy === 'transfer')) continue;
    const input = categoriseInputOf(t);
    const payee = input.payee ?? input.aiPayee ?? cleanPayee(input.description);
    const texts = [input.description, ...(input.alsoSaid ?? [])];
    const matches = rule?.enabled === true && texts.some((description) => categoriser.matchRule(rule, { ...input, description }, payee));
    if (!matches && t.ruleId !== ruleId) continue;
    const res = categoriser.categorise(input);
    const patch: Partial<Transaction> = {};
    const next = nextPayee(t, input, res);
    if (next !== t.payee) patch.payee = next;
    if (res.category !== t.category) patch.category = res.category;
    if (res.categorisedBy !== t.categorisedBy) patch.categorisedBy = res.categorisedBy;
    if (res.ruleId !== t.ruleId) patch.ruleId = res.ruleId;
    if (res.counterpartyAccountId && res.counterpartyAccountId !== t.counterpartyAccountId) patch.counterpartyAccountId = res.counterpartyAccountId;
    if (res.tags?.length) {
      const tags = [...new Set([...(t.tags ?? []), ...res.tags])];
      if (tags.length !== (t.tags?.length ?? 0)) patch.tags = tags;
    }
    if (!Object.keys(patch).length) continue;
    updates.push({ id: t.id, patch });
    if ('category' in patch) recategorised++;
  }
  if (updates.length) await store.updateTransactions(updates, `rule: apply ${opts.label ?? rule?.name ?? rule?.match.value ?? ruleId} (${recategorised} recategorised)`);
  return { recategorised };
}

/**
 * Pay recorded before its job had your payroll number: money in with no category that carries one of
 * `numbers` is salary, as the categoriser now says of it (shared/categorise.ts, step 4c). Only gaps
 * are filled: a category you, a rule or a reader gave stays. Returns how many.
 */
export async function salaryByPayroll(store: Store, numbers: readonly string[], message: string): Promise<number> {
  const re = payrollPattern(numbers);
  if (!re) return 0;
  const wrapper = (id: string) => {
    const a = store.account(id);
    return a ? isWrapperAccount(a.type) : false;
  };
  const found = store.transactions().filter((t) => t.amount > 0 && !t.category && t.categorisedBy !== 'user' && !t.transferGroup && !wrapper(t.accountId) && re.test(t.description));
  if (found.length) await store.updateTransactions(found.map((t) => ({ id: t.id, patch: { category: 'salary', categorisedBy: 'builtin' } })), message);
  return found.length;
}

/** Source fields the categoriser reads: filling one in can change what a row is. */
const CATEGORISER_READS = ['type', 'counterpartyName', 'merchant', 'bankCategory', 'seenIn'] as const;

/**
 * A recorded row's payee, category and own-account link worked out again after another document
 * filled in some of its source fields (shared/detail.ts), as `enrich` would: only when a field
 * the categoriser reads was filled in (or `seenIn`, when the document called it something new),
 * and never on a row you categorised or one linked as a transfer. Returns the patch, empty when
 * nothing changes.
 */
export function rederive(categoriser: Categoriser, t: Transaction, filled: readonly string[]): Partial<Transaction> {
  if (!filled.some((f) => (CATEGORISER_READS as readonly string[]).includes(f))) return {};
  if (t.categorisedBy === 'user' || t.transferGroup) return {};
  const input = categoriseInputOf(t);
  const res = categoriser.categorise(input);
  const patch: Partial<Transaction> = {};
  const payee = nextPayee(t, input, res);
  if (payee && payee !== t.payee) patch.payee = payee;
  if (res.category !== t.category) patch.category = res.category;
  if (res.categorisedBy !== t.categorisedBy) patch.categorisedBy = res.categorisedBy;
  if (res.ruleId !== t.ruleId) patch.ruleId = res.ruleId;
  if (res.counterpartyAccountId !== t.counterpartyAccountId) patch.counterpartyAccountId = res.counterpartyAccountId;
  if (res.tags?.length) {
    const tags = [...new Set([...(t.tags ?? []), ...res.tags])];
    if (tags.length !== (t.tags?.length ?? 0)) patch.tags = tags;
  }
  return patch;
}

/**
 * How strongly two rows say they are the same money moving between your accounts, or null when one
 * of them says it went somewhere else (docs/INGESTION.md, "Transfers").
 * - A row that names the other row's account (by its number, an alias or its bank) counts 3.
 * - A row that pays you or comes from you by name counts 1; so does a transfer category, but one
 *   side's category alone is not enough: it says nothing about the other side ("Rainy day", a savings
 *   move, is not the payment to an exchange that another account made that day).
 * - A row that names only other accounts of yours, or was set to go to another (a rule's
 *   counterparty), rules the pair out: "AJ BELL" is not a payment to the Chase saver.
 * - So does a row you put in a category that isn't a transfer: you said where the money went (a
 *   gift you sent is not money moving between your accounts).
 * - So does a row the app knows by its own wording as someone else's money (a built-in category
 *   that isn't a transfer: a Premium Bonds prize, pay, a refund, a shop) when it says nothing of your
 *   accounts or you: the other row naming you cannot make a prize the money you moved.
 * With nothing for it, the pair is not linked.
 */
export type TransferSide = Pick<Transaction, 'id' | 'accountId' | 'date' | 'description' | 'type' | 'category' | 'categorisedBy' | 'counterpartyAccountId'>;

export function transferEvidence(a: TransferSide, b: TransferSide, named: (t: TransferSide) => string[], ownName: (t: TransferSide) => boolean): number | null {
  if ([a, b].some((t) => t.categorisedBy === 'user' && t.category && !TRANSFERISH.has(t.category))) return null;
  const namesA = named(a);
  const namesB = named(b);
  // Cash taken out may go into a cash account of yours, so a withdrawal is not ruled out here.
  const someoneElse = (t: TransferSide, names: string[]) => t.categorisedBy === 'builtin' && !!t.category && !TRANSFERISH.has(t.category) && t.category !== 'cash-withdrawal' && !names.length && !t.counterpartyAccountId && !ownName(t);
  if (someoneElse(a, namesA) || someoneElse(b, namesB)) return null;
  if ((namesA.length && !namesA.includes(b.accountId)) || (namesB.length && !namesB.includes(a.accountId))) return null;
  if ((a.counterpartyAccountId && a.counterpartyAccountId !== b.accountId) || (b.counterpartyAccountId && b.counterpartyAccountId !== a.accountId)) return null;
  let score = 0;
  if (namesA.includes(b.accountId) || a.counterpartyAccountId === b.accountId) score += 3;
  if (namesB.includes(a.accountId) || b.counterpartyAccountId === a.accountId) score += 3;
  if (ownName(a)) score += 1;
  if (ownName(b)) score += 1;
  const categories = [a, b].filter((t) => t.category && TRANSFERISH.has(t.category)).length;
  score += categories;
  if (score === 1 && categories === 1) return null;
  return score > 0 ? score : null;
}

/**
 * Pair transfers: money out of one of your accounts with the same amount into another, at most 4
 * days apart, where the rows say so (transferEvidence). The pairs with the most evidence are linked
 * first, then the closest together; a row is linked once.
 */
/**
 * What a transaction's description says about your accounts and you, for transferEvidence: the
 * accounts it names (worked out once per row), and whether it names you.
 */
export function transferReader(store: Store, categoriser = categoriserFor(store)) {
  const cache = new Map<string, string[]>();
  const named = (t: TransferSide) => {
    let ids = cache.get(t.id);
    if (!ids) {
      const type = store.account(t.accountId)?.type;
      // As when categorising: bank names say nothing inside an investment or pension account.
      const useInstitutions = !type || !isWrapperAccount(type) || type === 'cash_isa';
      // By the row's date: of two accounts under one number, the one open that day.
      ids = categoriser.ownAccountsMentioned(t.accountId, t.description, useInstitutions, t.type, t.date).map((x) => x.id);
      cache.set(t.id, ids);
    }
    return ids;
  };
  const ownName = (t: TransferSide) => categoriser.namesOwner(t.description);
  return { named, ownName };
}

/**
 * `transferReader` for one company's rows: the accounts its rows can name are that company's own
 * (their names, numbers and providers), and nothing names you: a company's money paid to you by name
 * is not money moving between its accounts.
 */
export function companyTransferReader(store: Store, accounts: readonly Account[]) {
  return transferReader(store, new Categoriser([], new CategoryIndex(store.categories), [...accounts], store.allInstitutions));
}

function pairTransfers(store: Store, candidates: Transaction[], byAmount: Map<number, Transaction[]>, reader: ReturnType<typeof transferReader>) {
  const { named, ownName } = reader;

  const outgoing = new Map<string, Transaction>();
  for (const t of candidates) if (t.amount < 0) outgoing.set(t.id, t);
  for (const t of candidates) if (t.amount > 0) for (const o of byAmount.get(-toMinor(t.amount)) ?? []) if (o.amount < 0 && !o.transferGroup) outgoing.set(o.id, o);
  const options: { a: Transaction; b: Transaction; score: number; days: number }[] = [];
  for (const a of outgoing.values()) {
    for (const b of byAmount.get(-toMinor(a.amount)) ?? []) {
      if (b.amount <= 0 || b.accountId === a.accountId || b.transferGroup) continue;
      const days = Math.abs(diffDays(a.date, b.date));
      if (days > 4) continue;
      const score = transferEvidence(a, b, named, ownName);
      if (score !== null) options.push({ a, b, score, days });
    }
  }
  options.sort((x, y) => y.score - x.score || x.days - y.days || x.a.date.localeCompare(y.a.date) || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));

  const linked = new Set<string>();
  const groupOf = new Map<string, string>();
  const legs: [Transaction, Account, Account][] = [];
  let count = 0;
  for (const { a, b } of options) {
    if (linked.has(a.id) || linked.has(b.id)) continue;
    const accA = store.account(a.accountId);
    const accB = store.account(b.accountId);
    // Never across the line between your money and a company's, nor between two companies.
    if (!accA || !accB || sideOf(accA) !== sideOf(accB)) continue;
    const group = transferGroupId(a.id, b.id);
    groupOf.set(a.id, group);
    groupOf.set(b.id, group);
    legs.push([a, accB, accA], [b, accA, accB]);
    linked.add(a.id);
    linked.add(b.id);
    count++;
  }
  return { legs, groupOf, count };
}

/**
 * Link the transfers a commit's new rows complete: the other leg may have been committed earlier,
 * from another account's statement. Only unlinked rows are touched, and a category you set stays.
 */
export async function linkTransfers(store: Store, ids: string[], message: string): Promise<number> {
  if (!ids.length) return 0;
  // Each side apart (yours, and each company's): a row is only ever linked to one on its own side.
  const sides = new Map<string, string[]>();
  for (const id of ids) {
    const t = store.transaction(id);
    if (!t) continue;
    const side = sideOf(store.account(t.accountId));
    (sides.get(side) ?? sides.set(side, []).get(side)!).push(id);
  }
  const updates: { id: string; patch: Partial<Transaction> }[] = [];
  let count = 0;
  for (const [side, wanted] of sides) {
    const want = new Set(wanted);
    const accounts = side ? store.companyAccounts(side) : store.accounts;
    // A row marked as money with a company of yours is never a transfer between your accounts.
    const all = (side ? store.companyTransactions(side) : store.transactions()).filter((t) => !t.transferGroup && !t.company && !t.companyLink?.rows.length && t.books?.setBy !== 'user');
    const byAmount = new Map<number, Transaction[]>();
    for (const t of all) (byAmount.get(toMinor(t.amount)) ?? byAmount.set(toMinor(t.amount), []).get(toMinor(t.amount))!).push(t);
    const pairs = pairTransfers(store, all.filter((t) => want.has(t.id)), byAmount, side ? companyTransferReader(store, accounts) : transferReader(store));
    count += pairs.count;
    for (const [t, other, acc] of pairs.legs) {
      const payee = linkedPayee(t, other, accounts);
      updates.push({
        id: t.id,
        patch: {
          transferGroup: pairs.groupOf.get(t.id)!,
          counterpartyAccountId: other.id,
          // A category you set stays on your rows; a company's row takes none of yours (companyRowPatch).
          ...(t.categorisedBy !== 'user' || side ? { category: transferLegCategory(acc.type, other.type, t.amount), categorisedBy: 'transfer' as const, ruleId: undefined } : {}),
          ...(payee ? { payee } : {}),
          // A company's transfer leg posts by itself: a rule's or a proposal's coding goes (yours keeps the row out, above).
          ...(side && t.books ? { books: undefined } : {}),
        },
      });
    }
  }
  if (!count) return 0;
  await store.updateTransactions(updates, message);
  return count;
}
