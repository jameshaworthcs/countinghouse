// Set aside: how much of the money in your everyday accounts is set aside in pots, and how much is
// yours to spend (docs/FORMULAS.md §21). A pure sum over your payments: no model, no guessing beyond
// the plain defaults written down there. Nothing runs without earmarks.json.

import type { EarmarkAccount, EarmarkBy, EarmarkLine, EarmarkPotResult, EarmarkRow, EarmarksResponse, EarmarksResult, EarmarkToCheck } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { Categoriser } from '../../shared/categorise';
import { addDays, diffDays, today as todayOf, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import { EARMARK_EFFECTS, POT_EFFECTS, type EarmarkSetup, type Account, type Category, type EarmarkEffect, type EarmarkPot, type EarmarkRule, type Earmarks, type Rule, type Transaction } from '../../shared/schema';
import { ruleCatches } from '../categoriser';

export const EARMARK_RULES = {
  /** Two everyday accounts' rows of opposite amounts this many days apart can be one move between them. */
  pairDays: 5,
  /** The other side of a transfer to a set-aside account is looked for this many days either way. */
  otherSideDays: 5,
  /** An account whose latest data is older than this many days is marked stale. */
  staleDays: 14,
} as const;

/** What working out the pots needs: the data, read through plain functions so tests can build it. */
export interface EarmarksInput {
  setup: Earmarks;
  accounts: readonly Account[];
  categories: readonly Category[];
  /** Every transaction (the other sides of transfers are looked up among them). */
  transactions: readonly Transaction[];
  /** An account's balance at the close of a day, in pounds (null when unknown). */
  balanceOn: (accountId: string, date: ISODate) => number | null;
  lastDataOf: (accountId: string) => ISODate | null;
  firstDataOf: (accountId: string) => ISODate | null;
  today?: ISODate;
}

interface Part {
  effect: EarmarkEffect;
  /** Signed pence, like the payment. */
  pence: number;
}

interface Counted {
  t: Transaction;
  pot: string;
  parts: Part[];
  by: EarmarkBy;
  rule?: EarmarkRule;
  reason?: string;
}

const isIn = (t: Transaction) => t.amount > 0;
const signOf = (t: Transaction) => (t.amount < 0 ? -1 : 1);

/** The accounts on the other side of a transfer: its linked rows', else the account it names. */
function otherSides(t: Transaction, byGroup: ReadonlyMap<string, Transaction[]>): string[] {
  if (t.transferGroup) {
    const others = (byGroup.get(t.transferGroup) ?? []).filter((o) => o.id !== t.id && o.accountId !== t.accountId).map((o) => o.accountId);
    if (others.length) return [...new Set(others)];
  }
  return t.counterpartyAccountId ? [t.counterpartyAccountId] : [];
}

/** A rule as a categorising rule, so its words match exactly as rules do elsewhere (ruleCatches). */
function textRule(r: EarmarkRule, i: number): Rule | null {
  if (!r.text) return null;
  return {
    id: `rule_earmark${i}`,
    enabled: true,
    priority: 100,
    match: { field: r.text.field, op: r.text.op, value: r.text.value, caseSensitive: r.text.caseSensitive },
    set: {},
    createdAt: '2000-01-01T00:00:00Z',
    updatedAt: '2000-01-01T00:00:00Z',
  };
}

/** Does a pot's rule catch a payment? Every condition given must hold. */
function makeMatcher(pot: EarmarkPot, cats: CategoryIndex, otherSidesOf: (t: Transaction) => string[]): (r: EarmarkRule, t: Transaction) => boolean {
  const synth = new Map<string, Rule>();
  pot.rules.forEach((r, i) => {
    const rule = textRule(r, i);
    if (rule) synth.set(r.id, rule);
  });
  const categoriser = new Categoriser([...synth.values()], new CategoryIndex([]), [], []);
  return (r, t) => {
    if (r.direction === 'in' && t.amount <= 0) return false;
    if (r.direction === 'out' && t.amount >= 0) return false;
    const abs = Math.abs(t.amount);
    if (r.amountMin !== undefined && abs < r.amountMin) return false;
    if (r.amountMax !== undefined && abs > r.amountMax) return false;
    if (r.accountIds && !r.accountIds.includes(t.accountId)) return false;
    if (r.category && t.category !== r.category && cats.groupOf(t.category)?.id !== r.category) return false;
    if (r.counterpartyAccountId && !otherSidesOf(t).includes(r.counterpartyAccountId)) return false;
    const rule = synth.get(r.id);
    if (rule && !ruleCatches(rule, t, categoriser)) return false;
    return true;
  };
}

/** The part of a payment a rule counts, before any limit: all of it, a share, or up to an amount. */
function portionOf(r: EarmarkRule | undefined, t: Transaction): number {
  const abs = Math.abs(toMinor(t.amount));
  if (!r?.portion) return abs;
  if ('percent' in r.portion) return Math.round((abs * r.portion.percent) / 100);
  return Math.min(abs, toMinor(r.portion.upTo));
}


/**
 * Pair moves between two everyday accounts: linked rows, a row naming the other account, or (both
 * transfers) opposite amounts within a few days. Paired rows change nothing. A row naming another
 * everyday account whose data ends before it is money on its way.
 */
function pairEveryday(rows: readonly Transaction[], everyday: ReadonlySet<string>, cats: CategoryIndex, otherSidesOf: (t: Transaction) => string[], lastDataOf: (id: string) => ISODate | null) {
  const internal = new Set<string>();
  const onItsWay: { t: Transaction; other: string }[] = [];
  const isTransfer = (t: Transaction) => !t.category || cats.kindOf(t.category) === 'transfer';
  const loose: Transaction[] = [];
  for (const t of rows) {
    const others = otherSidesOf(t).filter((a) => everyday.has(a) && a !== t.accountId);
    if (!others.length) {
      loose.push(t);
      continue;
    }
    const linked = t.transferGroup && rows.some((o) => o.id !== t.id && o.transferGroup === t.transferGroup && everyday.has(o.accountId));
    if (linked) {
      internal.add(t.id);
      continue;
    }
    // Named but not linked: its other side may sit among the loose rows, or not have arrived yet.
    loose.push(t);
  }
  const byAmount = new Map<number, Transaction[]>();
  for (const t of loose) if (isTransfer(t)) (byAmount.get(toMinor(t.amount)) ?? byAmount.set(toMinor(t.amount), []).get(toMinor(t.amount))!).push(t);
  const sorted = [...loose].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const t of sorted) {
    if (internal.has(t.id) || !isTransfer(t)) continue;
    const candidates = (byAmount.get(-toMinor(t.amount)) ?? [])
      .filter((o) => !internal.has(o.id) && o.accountId !== t.accountId && Math.abs(diffDays(t.date, o.date)) <= EARMARK_RULES.pairDays)
      .sort((a, b) => Math.abs(diffDays(t.date, a.date)) - Math.abs(diffDays(t.date, b.date)) || a.id.localeCompare(b.id));
    const o = candidates[0];
    if (o) {
      internal.add(t.id);
      internal.add(o.id);
    }
  }
  for (const t of loose) {
    if (internal.has(t.id)) continue;
    const other = otherSidesOf(t).find((a) => everyday.has(a) && a !== t.accountId);
    if (!other) continue;
    const last = lastDataOf(other);
    if (last !== null && last < t.date) {
      onItsWay.push({ t, other });
      internal.add(t.id);
    }
  }
  return { internal, onItsWay };
}

/** Work out every pot (docs/FORMULAS.md §21). */
export function computeEarmarks(input: EarmarksInput): EarmarksResponse {
  const { setup } = input;
  const now = input.today ?? todayOf();
  const problems: string[] = [];
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  for (const id of [...setup.everyday, ...setup.setAside]) {
    const a = accountsById.get(id);
    if (!a) problems.push(`"${id}" is not one of your accounts.`);
    else if (a.currency !== 'GBP') problems.push(`${a.name} is in ${a.currency}: only accounts in pounds can be counted.`);
  }
  const everyday = new Set(setup.everyday);
  const setAsideIds = new Set(setup.setAside);
  const cats = new CategoryIndex([...input.categories]);

  // Each account to its own latest day.
  const accounts: EarmarkAccount[] = [];
  let everydayTotal = 0;
  let held = 0;
  for (const [role, ids] of [
    ['everyday', setup.everyday],
    ['set-aside', setup.setAside],
  ] as const) {
    for (const id of ids) {
      const a = accountsById.get(id);
      if (!a) continue;
      const asOf = input.lastDataOf(id);
      // A closed account holds nothing after it closed, and is never stale.
      const closed = a.closedOn !== undefined && a.closedOn <= now;
      const balance = asOf ? input.balanceOn(id, asOf) : closed ? 0 : null;
      if (role === 'everyday' && balance === null) problems.push(`There is no balance for ${a.name}: add a statement or a balance for it.`);
      accounts.push({ accountId: id, name: a.name, role, balance: balance ?? 0, asOf, stale: !closed && (asOf === null || diffDays(asOf, now) > EARMARK_RULES.staleDays) });
      if (role === 'everyday') everydayTotal += toMinor(balance ?? 0);
      else held += toMinor(balance ?? 0);
    }
  }
  if (problems.length) return { setup, result: null, problems };

  const byGroup = new Map<string, Transaction[]>();
  for (const t of input.transactions) if (t.transferGroup) (byGroup.get(t.transferGroup) ?? byGroup.set(t.transferGroup, []).get(t.transferGroup)!).push(t);
  const otherSidesOf = (t: Transaction) => otherSides(t, byGroup);
  const firstStart = setup.pots.reduce((m, p) => (p.start < m ? p.start : m), setup.pots[0]!.start);
  const rows = input.transactions.filter((t) => everyday.has(t.accountId) && t.date >= firstStart).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const { internal, onItsWay } = pairEveryday(rows, everyday, cats, otherSidesOf, input.lastDataOf);

  const toCheck: EarmarkToCheck[] = [];
  const counted: Counted[] = [];
  const claimed = new Set<string>();
  const txById = new Map(input.transactions.map((t) => [t.id, t]));

  // Decisions first: they win over everything.
  for (const [txId, d] of Object.entries(setup.decisions)) {
    const t = txById.get(txId);
    const pot = setup.pots.find((p) => p.id === d.pot);
    if (!t || !pot) {
      toCheck.push({ kind: 'stale-decision', pot: d.pot, date: d.seen.date, transactionIds: [txId], question: `Your decision of ${d.decidedAt.slice(0, 10)} is for a payment that is no longer recorded (${d.seen.date}, ${formatMoney(d.seen.amount)}). It isn't counted: remove it, or decide the payment that replaced it.`, amount: 0 });
      continue;
    }
    if (!everyday.has(t.accountId) || t.date < pot.start) {
      toCheck.push({ kind: 'stale-decision', pot: pot.id, date: t.date, transactionIds: [txId], question: `Your decision for this payment no longer counts: it isn't in an everyday account on or after ${pot.start}.`, amount: 0 });
      continue;
    }
    const abs = Math.abs(toMinor(t.amount));
    let left = abs;
    const parts: Part[] = [];
    for (const p of d.parts) {
      const pence = Math.min(left, toMinor(p.amount));
      left -= pence;
      if (pence > 0) parts.push({ effect: p.effect, pence: pence * signOf(t) });
    }
    if (left > 0) parts.push({ effect: 'own', pence: left * signOf(t) });
    const changed = d.seen.amount !== t.amount || d.seen.accountId !== t.accountId;
    const over = d.parts.reduce((s, p) => s + toMinor(p.amount), 0) > abs;
    if (changed || over) {
      toCheck.push({ kind: 'stale-decision', pot: pot.id, date: t.date, transactionIds: [txId], question: changed ? `The payment changed since you decided it (it was ${formatMoney(d.seen.amount)} in ${accountsById.get(d.seen.accountId)?.name ?? d.seen.accountId}). Check your decision still holds.` : 'Your decision adds up to more than the payment: only the payment is counted.', amount: fromMinor(Math.abs(parts.filter((p) => POT_EFFECTS.includes(p.effect)).reduce((s, p) => s + p.pence, 0))) });
    }
    counted.push({ t, pot: pot.id, parts, by: 'decision', reason: d.reason });
    claimed.add(txId);
  }

  const potResults: EarmarkPotResult[] = [];
  const nByDay = new Map<ISODate, number>();
  let totalN = 0;
  for (const pot of setup.pots) {
    const match = makeMatcher(pot, cats, otherSidesOf);
    const potRows = rows.filter((t) => t.date >= pot.start && !internal.has(t.id) && !claimed.has(t.id));
    const days = new Map<ISODate, Transaction[]>();
    for (const t of potRows) (days.get(t.date) ?? days.set(t.date, []).get(t.date)!).push(t);
    const decidedHere = counted.filter((c) => c.pot === pot.id && c.by === 'decision');
    const decidedByDay = new Map<ISODate, Counted[]>();
    for (const c of decidedHere) (decidedByDay.get(c.t.date) ?? decidedByDay.set(c.t.date, []).get(c.t.date)!).push(c);
    const allDays = [...new Set([...days.keys(), ...decidedByDay.keys()])].sort();

    const allowance = new Map<string, number>();
    const usedBy = new Map<string, number>();
    const potCounted: Counted[] = [...decidedHere];
    let n = toMinor(pot.opening);
    let provisional = 0;
    for (const day of allDays) {
      // A day in a fixed order, whatever order its rows were recorded in: money in first, then money
      // put back into the pot, then money paid from it (FORMULAS §21, "A day").
      let later = 0;
      const add = (p: Part) => {
        if (!POT_EFFECTS.includes(p.effect)) return;
        if (p.pence > 0 || p.effect === 'to-pot') n += p.pence;
        else later += p.pence;
      };
      for (const c of decidedByDay.get(day) ?? []) for (const p of c.parts) add(p);
      const dayRows = (days.get(day) ?? []).slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id.localeCompare(b.id));
      const capped: { t: Transaction; rule: EarmarkRule }[] = [];
      const defaultsOut: Transaction[] = [];
      for (const t of dayRows) {
        const rule = pot.rules.find((r) => match(r, t));
        if (rule) {
          if (rule.limitTo) {
            capped.push({ t, rule });
            continue;
          }
          const pence = portionOf(rule, t) * signOf(t);
          const parts: Part[] = [{ effect: rule.effect, pence }];
          const rest = toMinor(t.amount) - pence;
          if (rest !== 0) parts.push({ effect: 'own', pence: rest });
          potCounted.push({ t, pot: pot.id, parts, by: 'rule', rule });
          claimed.add(t.id);
          add({ effect: rule.effect, pence });
          if (rule.effect === 'source') for (const u of pot.rules) if (u.limitTo?.includes(rule.id)) allowance.set(u.id, Math.max(0, (allowance.get(u.id) ?? 0) + pence));
          continue;
        }
        const toSetAside = otherSidesOf(t).some((a) => setAsideIds.has(a));
        if (!toSetAside) continue;
        if (isIn(t)) {
          const pence = toMinor(t.amount);
          potCounted.push({ t, pot: pot.id, parts: [{ effect: 'from-pot', pence }], by: 'default' });
          claimed.add(t.id);
          n += pence;
        } else defaultsOut.push(t);
      }
      // Money sent to a set-aside account: put back what the pot held that day; more than that needs checking.
      if (defaultsOut.length) {
        const total = defaultsOut.reduce((s, t) => s - toMinor(t.amount), 0);
        const held = Math.max(0, n);
        if (total <= held || held === 0) {
          // All of it put back; or, with nothing in the pot to put back, all of it yours topping it up.
          const effect = held === 0 ? 'topped-up' : 'to-pot';
          for (const t of defaultsOut) {
            potCounted.push({ t, pot: pot.id, parts: [{ effect, pence: toMinor(t.amount) }], by: 'default' });
            claimed.add(t.id);
          }
          if (held > 0) n -= total;
        } else {
          let back = held;
          const suggestion: EarmarkToCheck['suggestion'] = [];
          for (const t of defaultsOut) {
            const abs = -toMinor(t.amount);
            const put = Math.min(abs, back);
            back -= put;
            const parts: Part[] = [];
            if (put > 0) parts.push({ effect: 'to-pot', pence: -put });
            if (abs - put > 0) parts.push({ effect: 'topped-up', pence: -(abs - put) });
            potCounted.push({ t, pot: pot.id, parts, by: 'suggested' });
            claimed.add(t.id);
            suggestion.push({ transactionId: t.id, parts: parts.map((p) => ({ effect: p.effect, amount: fromMinor(Math.abs(p.pence)) })) });
          }
          n -= held;
          provisional += total;
          toCheck.push({
            kind: 'more-than-held',
            pot: pot.id,
            date: day,
            transactionIds: defaultsOut.map((t) => t.id),
            question: `${formatMoney(fromMinor(total))} went to your set-aside accounts on this day, more than the ${formatMoney(fromMinor(held))} ${pot.name} held. Counted for now: ${formatMoney(fromMinor(held))} put back, and ${formatMoney(fromMinor(total - held))} you topping it up. Was any of it something else?`,
            suggestion,
            amount: fromMinor(total),
          });
        }
      }
      n += later;
      // Money paid from the pot only up to what its sources brought in: after the day's money in.
      for (const { t, rule } of capped) {
        const want = portionOf(rule, t);
        let pence: number;
        if (isIn(t)) {
          pence = Math.min(want, usedBy.get(rule.id) ?? 0);
          usedBy.set(rule.id, (usedBy.get(rule.id) ?? 0) - pence);
          allowance.set(rule.id, (allowance.get(rule.id) ?? 0) + pence);
        } else {
          pence = Math.min(want, allowance.get(rule.id) ?? 0);
          allowance.set(rule.id, (allowance.get(rule.id) ?? 0) - pence);
          usedBy.set(rule.id, (usedBy.get(rule.id) ?? 0) + pence);
          pence = -pence;
        }
        const parts: Part[] = pence !== 0 ? [{ effect: rule.effect, pence }] : [];
        const rest = toMinor(t.amount) - pence;
        if (rest !== 0) parts.push({ effect: 'own', pence: rest });
        potCounted.push({ t, pot: pot.id, parts, by: 'rule', rule });
        claimed.add(t.id);
        n += pence;
      }
    }

    // The other side of a transfer to a set-aside account should be there when its statements cover the day.
    for (const c of potCounted) {
      const t = c.t;
      if (t.transferGroup || !t.counterpartyAccountId || !setAsideIds.has(t.counterpartyAccountId)) continue;
      const first = input.firstDataOf(t.counterpartyAccountId);
      const last = input.lastDataOf(t.counterpartyAccountId);
      if (!first || !last || t.date < first || t.date > last) continue;
      const found = input.transactions.some((o) => o.accountId === t.counterpartyAccountId && toMinor(o.amount) === -toMinor(t.amount) && Math.abs(diffDays(o.date, t.date)) <= EARMARK_RULES.otherSideDays);
      if (!found) {
        toCheck.push({ kind: 'missing-other-side', pot: pot.id, date: t.date, transactionIds: [t.id], question: `The other side of this transfer isn't in ${accountsById.get(t.counterpartyAccountId)?.name ?? t.counterpartyAccountId}, though its statements cover the day. A missing statement, or not a transfer to it?`, amount: Math.abs(t.amount) });
      }
    }

    const lines: EarmarkLine[] = [];
    for (const effect of EARMARK_EFFECTS) {
      const entries: { c: Counted; pence: number }[] = [];
      for (const c of potCounted) for (const p of c.parts) if (p.effect === effect) entries.push({ c, pence: p.pence });
      if (!entries.length) continue;
      const inP = entries.filter((e) => e.pence > 0).reduce((s, e) => s + e.pence, 0);
      const outP = entries.filter((e) => e.pence < 0).reduce((s, e) => s - e.pence, 0);
      const rowsOut: EarmarkRow[] = entries
        .filter((e) => e.c.by !== 'default' || effect !== 'own')
        .sort((a, b) => a.c.t.date.localeCompare(b.c.t.date) || a.c.t.id.localeCompare(b.c.t.id))
        .map(({ c, pence }) => ({
          transactionId: c.t.id,
          date: c.t.date,
          accountId: c.t.accountId,
          description: c.t.description,
          amount: c.t.amount,
          counted: fromMinor(pence),
          by: c.by,
          ...(c.rule ? { ruleId: c.rule.id, ruleName: c.rule.name } : {}),
          ...(c.reason ? { reason: c.reason } : {}),
        }));
      lines.push({ effect, total: POT_EFFECTS.includes(effect) ? fromMinor(inP - outP) : 0, in: fromMinor(inP), out: fromMinor(outP), count: entries.length, rows: rowsOut });
    }
    totalN += n;
    potResults.push({
      id: pot.id,
      name: pot.name,
      ...(pot.purpose ? { purpose: pot.purpose } : {}),
      start: pot.start,
      opening: pot.opening,
      setAside: fromMinor(n),
      lines,
      provisional: fromMinor(provisional),
      checks: pot.checks,
    });
    // Each day's change in this pot, for the series.
    for (const c of potCounted) for (const p of c.parts) if (POT_EFFECTS.includes(p.effect)) nByDay.set(c.t.date, (nByDay.get(c.t.date) ?? 0) + p.pence);
  }

  const onItsWayTotal = onItsWay.reduce((s, w) => s - toMinor(w.t.amount), 0);
  const spendable = everydayTotal + onItsWayTotal - totalN;

  // The lowest point and a weekly series: spendable only moves on days with payments.
  const openingN = setup.pots.reduce((s, p) => s + toMinor(p.opening), 0);
  const totalOn = (d: ISODate) => {
    let sum = 0;
    for (const id of setup.everyday) {
      const last = input.lastDataOf(id);
      const first = input.firstDataOf(id);
      if (!last || !first || d < first) continue;
      sum += toMinor(input.balanceOn(id, d < last ? d : last) ?? 0);
    }
    return sum;
  };
  const changeDays = [...new Set([...rows.map((t) => t.date), ...nByDay.keys()])].sort();
  const lastDay = accounts.filter((a) => a.role === 'everyday').reduce<ISODate | null>((m, a) => (a.asOf && (!m || a.asOf > m) ? a.asOf : m), null);
  let lowest: EarmarksResult['lowest'] = null;
  const nTo = (() => {
    const sorted = [...nByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return (d: ISODate) => sorted.reduce((s, [day, v]) => (day <= d ? s + v : s), openingN);
  })();
  for (const d of changeDays) {
    if (lastDay && d > lastDay) break;
    const s = totalOn(d) - nTo(d);
    if (!lowest || s < toMinor(lowest.spendable)) lowest = { date: d, spendable: fromMinor(s) };
  }
  const series: EarmarksResult['series'] = [];
  if (lastDay) {
    for (let d = firstStart; d <= lastDay; d = addDays(d, 7)) {
      const total = totalOn(d);
      const n = nTo(d);
      series.push({ date: d, spendable: fromMinor(total - n), setAside: fromMinor(n), total: fromMinor(total) });
    }
  }
  const everydayDates = accounts.filter((a) => a.role === 'everyday' && a.asOf).map((a) => a.asOf!).sort();

  const result: EarmarksResult = {
    accounts,
    everydayTotal: fromMinor(everydayTotal),
    onItsWay: onItsWay.map((w) => ({ transactionId: w.t.id, date: w.t.date, accountId: w.t.accountId, otherAccountId: w.other, amount: -w.t.amount })),
    onItsWayTotal: fromMinor(onItsWayTotal),
    pots: potResults,
    spendable: fromMinor(spendable),
    heldInSetAside: fromMinor(held),
    oldest: everydayDates[0] ?? null,
    newest: everydayDates[everydayDates.length - 1] ?? null,
    toCheck: toCheck.sort((a, b) => a.date.localeCompare(b.date)),
    lowest,
    series,
    internal: { count: internal.size },
  };
  return { setup, result, problems: [] };
}


/**
 * Why a setup can't be used (null: it can): every account is yours and in pounds, every category and
 * account a rule names is there, its patterns work, and no pot starts in the future.
 */
export function setupProblem(setup: EarmarkSetup, accountOf: (id: string) => Account | undefined, hasCategory: (id: string) => boolean, on: ISODate = todayOf()): string | null {
  for (const id of [...setup.everyday, ...setup.setAside]) {
    const a = accountOf(id);
    if (!a) return `There is no account "${id}".`;
    if (a.currency !== 'GBP') return `${a.name} is in ${a.currency}: only accounts in pounds can be counted.`;
  }
  for (const pot of setup.pots) {
    if (pot.start > on) return `${pot.name} starts on ${pot.start}, in the future.`;
    for (const r of pot.rules) {
      if (r.category && !hasCategory(r.category)) return `Rule "${r.name}" names no category of yours ("${r.category}").`;
      if (r.counterpartyAccountId && !accountOf(r.counterpartyAccountId)) return `Rule "${r.name}" names no account of yours ("${r.counterpartyAccountId}").`;
      if (r.text?.op === 'regex') {
        try {
          new RegExp(r.text.value);
        } catch {
          return `Rule "${r.name}": "${r.text.value}" is not a pattern that works.`;
        }
      }
    }
  }
  return null;
}

/** A setup made the one in use: your decisions and checks stay, and a pot taken away takes its decisions with it. */
export function withSetup(current: Earmarks | null, setup: EarmarkSetup, updatedAt: string): Earmarks {
  const potIds = new Set(setup.pots.map((p) => p.id));
  return {
    everyday: setup.everyday,
    setAside: setup.setAside,
    pots: setup.pots.map((p) => ({ ...p, checks: current?.pots.find((x) => x.id === p.id)?.checks ?? [] })),
    decisions: Object.fromEntries(Object.entries(current?.decisions ?? {}).filter(([, d]) => potIds.has(d.pot))),
    updatedAt,
  };
}

/** Which effects a payment in or out can have in a pot. */
export const EFFECTS_IN: readonly EarmarkEffect[] = ['source', 'use', 'from-pot', 'own-back', 'own'];
export const EFFECTS_OUT: readonly EarmarkEffect[] = ['source', 'use', 'to-pot', 'topped-up', 'own'];

/**
 * Why a decision can't be made for a payment (null: it can): the pot is there, the payment is in an
 * everyday account from the pot's start, its parts suit its direction and add up to no more than it.
 */
export function decisionProblem(setup: Earmarks, potId: string, t: Transaction | undefined, parts: readonly { effect: EarmarkEffect; amount: number }[] | null): string | null {
  const pot = setup.pots.find((p) => p.id === potId);
  if (!pot) return `There is no pot "${potId}".`;
  if (!t) return 'That payment is no longer in your data.';
  if (!setup.everyday.includes(t.accountId)) return 'It is not in one of the everyday accounts.';
  if (t.date < pot.start) return `It is before ${pot.name} starts (${pot.start}).`;
  if (!parts) return null;
  const allowed = t.amount > 0 ? EFFECTS_IN : EFFECTS_OUT;
  const misfit = parts.find((p) => !allowed.includes(p.effect));
  if (misfit) return `It is money ${t.amount > 0 ? 'in' : 'out'}: it cannot be "${misfit.effect}".`;
  const total = parts.reduce((n, p) => n + toMinor(p.amount), 0);
  if (total > Math.abs(toMinor(t.amount))) return `The parts add up to ${formatMoney(fromMinor(total))}, more than the payment (${formatMoney(Math.abs(t.amount))}).`;
  return null;
}

/** Set aside's headline figures for a setup and the rows as they are (or as a change would leave them). */
export function earmarkFigures(
  store: Pick<import('../store').Store, 'accounts' | 'categories'>,
  setup: Earmarks | null | undefined,
  transactions: readonly Transaction[],
  engine: Pick<import('./balances').BalanceEngine, 'balanceOn' | 'lastDataDate' | 'firstDataDate'>,
): { setAside: number; spendable: number; toCheck: number } | null {
  if (!setup) return null;
  const r = computeEarmarks({
    setup,
    accounts: store.accounts,
    categories: store.categories,
    transactions,
    balanceOn: (id, d) => {
      const p = engine.balanceOn(id, d);
      return p ? (p.gbp ?? p.value) : null;
    },
    lastDataOf: (id) => engine.lastDataDate(id),
    firstDataOf: (id) => engine.firstDataDate(id),
  }).result;
  return r ? { setAside: fromMinor(r.pots.reduce((s, p) => s + toMinor(p.setAside), 0)), spendable: r.spendable, toCheck: r.toCheck.length } : null;
}

/** The pots worked out from the store: each account to its own latest day. */
export function earmarks(
  store: Pick<import('../store').Store, 'earmarks' | 'accounts' | 'categories' | 'transactions'>,
  engine: Pick<import('./balances').BalanceEngine, 'balanceOn' | 'lastDataDate' | 'firstDataDate'>,
  on: ISODate = todayOf(),
  /** A setup to work out instead of the one in use (a preview while editing it). */
  setup: Earmarks | null = store.earmarks,
): EarmarksResponse {
  if (!setup) return { setup: null, result: null, problems: [] };
  return computeEarmarks({
    setup,
    accounts: store.accounts,
    categories: store.categories,
    transactions: store.transactions(),
    balanceOn: (id, d) => {
      const p = engine.balanceOn(id, d);
      return p ? (p.gbp ?? p.value) : null;
    },
    lastDataOf: (id) => engine.lastDataDate(id),
    firstDataOf: (id) => engine.firstDataDate(id),
    today: on,
  });
}
