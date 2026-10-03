// The To categorise page (docs/FORMULAS.md §10, "People", "Cash and cheques paid in", "Rules from your
// decisions" and "Guesses to check"):
// - payments with people, and cash and cheques paid in, each yours to decide, with what it looks like
//   and why;
// - rules your decisions point to: a payee you put in one category at least twice one way (or the
//   reader did, three times, when you never did), that would categorise rows now;
// - what's left uncategorised, by payee and direction;
// - what the app categorised from a guess (the bank's category, the reader's suggestion), for you to
//   confirm or change.
// Accounts valued at market (investments, pensions) are left out: their rows are not spending or
// income (§14).

import { balanceModeOf } from '../../shared/accounts';
import type { CategoriseQueue, GuessGroup, PayeeGroup, PersonGroup, PersonRow, QueueExample, RuleSuggestion } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { CASH_PAID_IN, Categoriser, CHEQUE_PAID_IN, holdsPaidIn, isCashWithdrawal, isWrapperAccount, paidInKind, type CategoriseInput, type PaidIn } from '../../shared/categorise';
import { cleanPayee } from '../../shared/merchants';
import { fromMinor, toMinor } from '../../shared/money';
import { PeopleIndex, suggestFor, suggestForCash, tidyName, type CashOut, type PaidOut, type PersonHistory, type PersonParty } from '../../shared/people';
import type { Person, Rule, Transaction } from '../../shared/schema';
import { categoriseInputOf, ruleCatches } from '../categoriser';
import type { Store } from '../store';

/** Your decisions that make a rule: this many for a payee one way, all in one category. */
export const RULE_FROM_DECISIONS = 2;
/** Or the reader's, when you made none for that payee that way. */
export const RULE_FROM_READER = 3;

/** How a payment with a person, or cash or a cheque paid in, got its category, when that settles it: yours, your rule's, or an agreement's. */
export const DECIDED = new Set<Transaction['categorisedBy']>(['user', 'rule', 'agreement']);

/** Categories the app guessed: the bank's own, or the reader's suggestion. */
export const GUESSED = new Set<Transaction['categorisedBy']>(['bank', 'ai']);

/** Who your payments are with, when a person: from your name, your accounts and banks, and the people you saved. */
export function peopleIndexFor(store: Store): PeopleIndex {
  const ownNames = [...store.accounts.flatMap((a) => [a.name, ...a.aliases]), ...store.institutions.map((i) => i.name)];
  return new PeopleIndex({ ownerName: store.profile.name, ownNames, people: store.people });
}

/** Each payment with a person, by transaction id, over the accounts that hold your everyday money. */
export function personParties(store: Store, index: PeopleIndex = peopleIndexFor(store)): Map<string, PersonParty> {
  const skip = new Set(store.accounts.filter((a) => isWrapperAccount(a.type) || balanceModeOf(a) === 'market').map((a) => a.id));
  const out = new Map<string, PersonParty>();
  for (const t of store.transactions()) {
    if (skip.has(t.accountId)) continue;
    const party = index.party(t);
    if (party) out.set(t.id, party);
  }
  return out;
}

/**
 * Cash and cheques paid in to your current and savings accounts, by transaction id: by their words or
 * the bank's type, or the payee the categoriser gave them from another document's words.
 */
export function paidInto(store: Store): Map<string, PaidIn> {
  const holds = new Map(store.accounts.map((a) => [a.id, holdsPaidIn(a.type)]));
  const out = new Map<string, PaidIn>();
  for (const t of store.transactions()) {
    if (t.amount <= 0 || t.transferGroup || !(holds.get(t.accountId) ?? true)) continue;
    const kind = t.payee === CHEQUE_PAID_IN ? 'cheque' : t.payee === CASH_PAID_IN ? 'cash' : paidInKind(t.description, t.type);
    if (kind) out.set(t.id, kind);
  }
  return out;
}

/**
 * The rule "always" makes for a payee's payments one way: money that way whose description holds the
 * payee (one of 4 letters or more), else whose payee, as the categoriser sees it, is the payee's. The
 * first that catches every one of `rows`, or none.
 */
export function payeeRuleMatch(payee: string, rows: readonly Transaction[], direction?: 'in' | 'out'): Rule['match'] | undefined {
  const [first] = rows;
  if (!first) return undefined;
  const input = categoriseInputOf(first);
  const way = direction ? { direction } : {};
  const candidates: Rule['match'][] = [
    ...(payee.replace(/[^A-Za-z]/g, '').length >= 4 ? [{ field: 'description' as const, op: 'contains' as const, value: payee, caseSensitive: false, ...way }] : []),
    { field: 'payee', op: 'equals', value: input.payee ?? cleanPayee(input.description), caseSensitive: false, ...way },
  ];
  for (const match of candidates) {
    const rule: Rule = { id: 'rule_check', enabled: true, priority: 100, match, set: {}, createdAt: '', updatedAt: '' };
    const categoriser = new Categoriser([rule], new CategoryIndex([]), [], []);
    if (rows.every((t) => ruleCatches(rule, t, categoriser))) return match;
  }
  return undefined;
}

const example = (t: Transaction): QueueExample => ({ id: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description });
const sumOf = (list: readonly Transaction[]) => fromMinor(list.reduce((s, t) => s + toMinor(t.amount), 0));
const newestFirst = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
const directionOf = (t: Transaction): 'in' | 'out' => (t.amount >= 0 ? 'in' : 'out');

/** The name to show for someone: the fullest their payments carry, as written in mixed case when one is, else tidied. */
function displayName(names: Map<string, number>): string {
  const letters = (s: string) => s.replace(/[^A-Za-z]/g, '').length;
  return tidyName([...names.entries()].sort((a, b) => letters(b[0]) - letters(a[0]) || Number(/[a-z]/.test(b[0])) - Number(/[a-z]/.test(a[0])) || b[1] - a[1])[0]![0]);
}

export function categoriseQueue(store: Store, opts: { from?: string | undefined } = {}): CategoriseQueue {
  const cats = new CategoryIndex(store.categories);
  const known = (id: string) => Boolean(cats.get(id));
  const kindOf = (id: string) => cats.kindOf(id);
  const index = peopleIndexFor(store);
  const parties = personParties(store, index);
  const cash = paidInto(store);
  const market = new Set(store.accounts.filter((a) => balanceModeOf(a) === 'market').map((a) => a.id));
  const all = store.transactions().filter((t) => !market.has(t.accountId));
  const listed = (t: Transaction) => !opts.from || t.date >= opts.from;
  const peopleById = new Map(store.people.map((p) => [p.id, p]));

  // Payments you made, which money from someone may be their share of: spending, not cash.
  const paid: PaidOut[] = all
    .filter((t) => t.amount < 0 && !t.transferGroup && !parties.has(t.id) && t.category !== 'cash-withdrawal' && (!t.category || kindOf(t.category) === 'expense') && !isCashWithdrawal(t.description, t.type))
    .map((t) => ({ id: t.id, date: t.date, amount: t.amount, payee: t.payee ?? cleanPayee(t.description), category: t.category }));

  // ── People ──
  interface Acc {
    person?: Person;
    names: Map<string, number>;
    open: Transaction[];
    decided: number;
    history: { in: PersonHistory; out: PersonHistory };
    shown: Transaction[];
  }
  const groups = new Map<string, Acc>();
  for (const t of all) {
    const party = parties.get(t.id);
    if (!party || cash.has(t.id)) continue;
    const key = party.personId ?? party.key;
    const person = party.personId ? peopleById.get(party.personId) : undefined;
    const g = groups.get(key) ?? groups.set(key, { ...(person ? { person } : {}), names: new Map(), open: [], decided: 0, history: { in: new Map(), out: new Map() }, shown: [] }).get(key)!;
    g.names.set(party.name, (g.names.get(party.name) ?? 0) + 1);
    if (t.categorisedBy === 'user' && t.category && !t.splits) {
      const h = g.history[directionOf(t)];
      h.set(t.category, (h.get(t.category) ?? 0) + 1);
    }
    if (!listed(t)) continue;
    g.shown.push(t);
    if (DECIDED.has(t.categorisedBy)) g.decided++;
    else g.open.push(t);
  }
  const people: PersonGroup[] = [];
  for (const [key, g] of groups) {
    if (!g.open.length) continue;
    const name = g.person?.name ?? displayName(g.names);
    const rows: PersonRow[] = g.open.sort(newestFirst).map((t) => {
      const party = parties.get(t.id)!;
      const suggestion = suggestFor(t, party, { known, kindOf, person: g.person, personName: name, history: g.history[directionOf(t)], paid, ownerSurname: index.ownerSurname });
      return {
        ...example(t),
        ...(party.reference ? { reference: party.reference } : {}),
        ...(t.category ? { category: t.category } : {}),
        ...(t.categorisedBy ? { categorisedBy: t.categorisedBy } : {}),
        ...(suggestion ? { suggestion } : {}),
      };
    });
    people.push({
      key,
      ...(g.person ? { person: g.person } : {}),
      name,
      names: [...g.names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      sharesYourSurname: Boolean(index.ownerSurname) && rows.some((r) => parties.get(r.id)!.key.split('|')[0] === index.ownerSurname),
      rows,
      decided: g.decided,
      in: sumOf(g.shown.filter((t) => t.amount > 0)),
      out: sumOf(g.shown.filter((t) => t.amount < 0)),
    });
  }
  people.sort((a, b) => b.rows.length - a.rows.length || b.in - b.out - (a.in - a.out) || a.name.localeCompare(b.name));

  // ── Cash and cheques paid in ──
  const withdrawals: CashOut[] = all
    .filter((t) => t.amount < 0 && !t.transferGroup && (t.category === 'cash-withdrawal' || isCashWithdrawal(t.description, t.type)))
    .map((t) => ({ date: t.date, amount: t.amount }));
  const cashHistory: Record<PaidIn, PersonHistory> = { cash: new Map(), cheque: new Map() };
  const cashOpen: Transaction[] = [];
  const cashShown: Transaction[] = [];
  let cashDecided = 0;
  for (const t of all) {
    const kind = cash.get(t.id);
    if (!kind) continue;
    const h = cashHistory[kind];
    if (t.categorisedBy === 'user' && t.category && !t.splits) h.set(t.category, (h.get(t.category) ?? 0) + 1);
    if (!listed(t)) continue;
    cashShown.push(t);
    if (DECIDED.has(t.categorisedBy)) cashDecided++;
    else cashOpen.push(t);
  }
  if (cashOpen.length) {
    const birthday = store.profile.dateOfBirth?.slice(5);
    const kinds = new Set(cashOpen.map((t) => cash.get(t.id)!));
    people.unshift({
      key: 'cash',
      cash: true,
      name: kinds.size > 1 ? 'Cash and cheques paid in' : kinds.has('cheque') ? 'Cheques paid in' : CASH_PAID_IN,
      names: [],
      sharesYourSurname: false,
      rows: cashOpen.sort(newestFirst).map((t) => {
        const cheque = cash.get(t.id) === 'cheque';
        const suggestion = suggestForCash({ amount: t.amount, date: t.date, cheque }, { known, kindOf, withdrawals, birthday, history: cashHistory[cheque ? 'cheque' : 'cash'] });
        return {
          ...example(t),
          ...(cheque ? { cheque } : {}),
          ...(t.category ? { category: t.category } : {}),
          ...(t.categorisedBy ? { categorisedBy: t.categorisedBy } : {}),
          ...(suggestion ? { suggestion } : {}),
        };
      }),
      decided: cashDecided,
      in: sumOf(cashShown),
      out: 0,
    });
  }

  // ── Rules from your decisions ──
  const inputs = new Map<string, { input: CategoriseInput; texts: string[]; payee: string }>();
  const inputOf = (t: Transaction) => {
    let e = inputs.get(t.id);
    if (!e) {
      const input = categoriseInputOf(t);
      e = { input, texts: [input.description, ...(input.alsoSaid ?? [])], payee: input.payee ?? cleanPayee(input.description) };
      inputs.set(t.id, e);
    }
    return e;
  };
  const byPayee = new Map<string, { payee: string; direction: 'in' | 'out'; rows: Transaction[] }>();
  for (const t of all) {
    if (parties.has(t.id) || cash.has(t.id) || t.transferGroup) continue;
    const payee = (t.payee ?? cleanPayee(t.description)).trim();
    if (!payee) continue;
    const direction = directionOf(t);
    const k = `${payee.toLowerCase()}|${direction}`;
    (byPayee.get(k) ?? byPayee.set(k, { payee, direction, rows: [] }).get(k)!).rows.push(t);
  }
  const rules: RuleSuggestion[] = [];
  const spendingOrIncome = (id: string | undefined) => Boolean(id) && (kindOf(id!) === 'expense' || kindOf(id!) === 'income');
  const unanimous = (list: Transaction[]) => list.length > 0 && list.every((t) => t.category === list[0]!.category);
  for (const { payee, direction, rows } of byPayee.values()) {
    const mine = rows.filter((t) => t.categorisedBy === 'user' && t.category && !t.splits);
    const reader = rows.filter((t) => t.categorisedBy === 'ai' && t.category);
    let basis: Transaction[];
    let by: 'user' | 'ai';
    if (mine.length >= RULE_FROM_DECISIONS && unanimous(mine)) {
      basis = mine;
      by = 'user';
    } else if (!mine.length && reader.length >= RULE_FROM_READER && unanimous(reader)) {
      basis = reader;
      by = 'ai';
    } else continue;
    const category = basis[0]!.category!;
    if (!spendingOrIncome(category)) continue;
    // The description holds the payee (one of 4 letters or more: "BP" is inside too many words);
    // failing that, the payee as the categoriser sees it.
    const candidates: Rule['match'][] = [
      ...(payee.replace(/[^A-Za-z]/g, '').length >= 4 ? [{ field: 'description' as const, op: 'contains' as const, value: payee, caseSensitive: false, direction }] : []),
      { field: 'payee', op: 'equals', value: inputOf(basis[0]!).payee, caseSensitive: false, direction },
    ];
    const sizes = basis.map((t) => Math.abs(t.amount));
    const least = Math.min(...sizes);
    const most = Math.max(...sizes);
    for (const candidate of candidates) {
      const test = (match: Rule['match']) => {
        const rule: Rule = { id: 'rule_suggested', name: `${payee} → ${cats.name(category)}`, enabled: true, priority: 100, match, set: { category }, createdAt: '', updatedAt: '' };
        const categoriser = new Categoriser([rule], cats, [], []);
        return (t: Transaction) => {
          const e = inputOf(t);
          return e.texts.some((description) => categoriser.matchRule(rule, { ...e.input, description }, e.payee));
        };
      };
      let match = candidate;
      let hits = test(match);
      if (!basis.every(hits)) continue;
      const fillsOf = () => all.filter((t) => t.categorisedBy !== 'user' && !t.transferGroup && !parties.has(t.id) && !cash.has(t.id) && t.category !== category && hits(t)).sort(newestFirst);
      let fills = fillsOf();
      // Payments far from the sizes you decided (£1 of printing beside £2,000 of rent) are something
      // else: the rule keeps to sizes like yours.
      if (fills.some((t) => Math.abs(t.amount) < least / 4 || Math.abs(t.amount) > most * 4)) {
        match = { ...match, amountMin: Math.floor(least / 2), amountMax: Math.ceil(most * 2) };
        hits = test(match);
        fills = fillsOf();
      }
      // A rule that would also catch payments you put somewhere else is too wide.
      if (all.some((t) => t.categorisedBy === 'user' && t.category !== category && hits(t))) continue;
      if (fills.length) {
        rules.push({
          payee,
          category,
          direction,
          match,
          from: { by, count: basis.length },
          fills: { count: fills.length, amount: sumOf(fills), ids: fills.map((t) => t.id) },
          examples: fills.slice(0, 5).map(example),
        });
      }
      break;
    }
  }
  rules.sort((a, b) => Math.abs(b.fills.amount) - Math.abs(a.fills.amount) || a.payee.localeCompare(b.payee));
  // Two ways of naming one payee point to one rule: the first that fills each row.
  const claimed = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const ids = rules[i]!.fills.ids;
    if (ids.every((id) => claimed.has(id))) rules.splice(i--, 1);
    else for (const id of ids) claimed.add(id);
  }

  // ── What's left, by payee; and the app's guesses, by payee and category ──
  const inRules = new Set(rules.flatMap((r) => r.fills.ids));
  const left = new Map<string, { payee: string; direction: 'in' | 'out'; rows: Transaction[] }>();
  const guessed = new Map<string, { payee: string; direction: 'in' | 'out'; category: string; rows: Transaction[] }>();
  for (const t of all) {
    // A payment a suggested rule would fill waits there: your decisions say what it is.
    if (!listed(t) || t.transferGroup || parties.has(t.id) || cash.has(t.id) || inRules.has(t.id)) continue;
    const payee = (t.payee ?? cleanPayee(t.description)).trim() || t.description;
    const direction = directionOf(t);
    if (!t.category) {
      const k = `${payee.toLowerCase()}|${direction}`;
      (left.get(k) ?? left.set(k, { payee, direction, rows: [] }).get(k)!).rows.push(t);
    } else if (GUESSED.has(t.categorisedBy) && !t.splits) {
      const k = `${payee.toLowerCase()}|${direction}|${t.category}`;
      (guessed.get(k) ?? guessed.set(k, { payee, direction, category: t.category, rows: [] }).get(k)!).rows.push(t);
    }
  }
  const groupOf = (payee: string, direction: 'in' | 'out', rows: Transaction[]): PayeeGroup => {
    rows.sort(newestFirst);
    return {
      payee,
      direction,
      count: rows.length,
      amount: sumOf(rows),
      first: rows[rows.length - 1]!.date,
      last: rows[0]!.date,
      accountIds: [...new Set(rows.map((t) => t.accountId))],
      ids: rows.map((t) => t.id),
      examples: rows.slice(0, 5).map(example),
      match: payeeRuleMatch(payee, rows, direction) ?? { field: 'payee' as const, op: 'equals' as const, value: inputOf(rows[0]!).payee, caseSensitive: false, direction },
    };
  };
  const largest = (a: PayeeGroup, b: PayeeGroup) => Math.abs(b.amount) - Math.abs(a.amount) || a.payee.localeCompare(b.payee);
  const payees: PayeeGroup[] = [...left.values()].map(({ payee, direction, rows }) => groupOf(payee, direction, rows)).sort(largest);
  const guesses: GuessGroup[] = [...guessed.values()]
    .map(({ payee, direction, category, rows }) => ({
      ...groupOf(payee, direction, rows),
      category,
      by: { bank: rows.filter((t) => t.categorisedBy === 'bank').length, ai: rows.filter((t) => t.categorisedBy === 'ai').length },
      bankSays: [...new Set(rows.filter((t) => t.categorisedBy === 'bank' && t.bankCategory).map((t) => t.bankCategory!))].slice(0, 3),
    }))
    .sort(largest);

  return {
    ...(opts.from ? { from: opts.from } : {}),
    people,
    rules,
    payees,
    guesses,
    counts: { people: people.reduce((s, g) => s + g.rows.length, 0), rules: rules.length, payees: payees.reduce((s, g) => s + g.count, 0), guesses: guesses.reduce((s, g) => s + g.count, 0) },
  };
}
