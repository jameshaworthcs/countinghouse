// A month's figures (docs/FORMULAS.md §18): money in, borrowing, spending by kind, where the net went,
// the estate at both ends with what each value rests on, how well the month is categorised, and each
// line against the complete months before it. One function behind the API, the Overview's month card
// and the month in review's digest, so Claude reads exactly what you see.
//
// Everything is worked out from what is known of the month itself: regular payments as they stood at
// its end, agreement payments as paid by then. Nothing after the month counts but the agreements'
// payments due in the 60 days after it, which their documents gave.

import { ACCOUNT_TYPE_META, balanceModeOf, WRAPPER_GROUP_LABELS, WRAPPER_GROUPS, type WrapperGroup } from '../../shared/accounts';
import type { MonthAccountValue, MonthCompared, MonthLine, MonthPayment, MonthRegularChange, MonthSummary } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { isCashWithdrawal, nameKey } from '../../shared/categorise';
import { addDays, addMonths, diffDays, endOfMonth, eachMonth, type ISODate } from '../../shared/dates';
import { cleanPayee } from '../../shared/merchants';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Transaction } from '../../shared/schema';
import type { Store } from '../store';
import { agreementsView } from './agreements';
import type { BalanceEngine } from './balances';
import { flows, type FlowTx } from './cashflow';
import type { Coverage } from './coverage';
import { estateOn } from './estate';
import { personParties } from './queue';
import { detectRecurring } from './recurring';

/** The month's rules, named (docs/FORMULAS.md §18). */
export const MONTH_RULES = {
  /** A one-off is a single payment of at least this much… */
  oneOffMinimum: 250,
  /** …to a payee paid fewer times than this in the 365 days before it. */
  oneOffPriorPayments: 3,
  /** Months a month is compared with: the complete ones among these before it. */
  historyMonths: 12,
  /** A value at market resting on a valuation older than this at the month's end is not the month's. */
  valuationDays: 31,
  /** Agreement payments due this many days after the month are what's coming. */
  comingDays: 60,
  /** New payees and regular changes listed, the largest first. */
  listed: 10,
} as const;

const MONEY_IN_LINES = [
  ['pay', 'Pay'],
  ['other-income', 'Other income'],
  ['gifts', 'Gifts received'],
  ['uncategorised-in', 'Uncategorised money in'],
  ['borrowed', 'Borrowed'],
] as const;
const SPENDING_LINES = [
  ['scheduled', 'Scheduled'],
  ['regular', 'Regular'],
  ['one-offs', 'One-offs'],
  ['everyday', 'Everyday'],
  ['money-back', 'Refunds and money paid back'],
] as const;
type MoneyInLine = (typeof MONEY_IN_LINES)[number][0];
type SpendingLine = (typeof SPENDING_LINES)[number][0];

const PAY = new Set(['salary', 'bonus']);
/** Rows on a loan that cost you rather than lend you money. */
const LOAN_CHARGES = new Set(['interest-charges', 'bank-fees']);
/** Where money moved, as a sentence names it ("moved to savings £300, to the Lifetime ISA £333"). */
const MOVED_TO: Record<string, string> = { savings: 'savings', isa: 'ISAs', lisa: 'the Lifetime ISA', pensions: 'pensions', investments: 'investments', cards: 'credit cards', loans: 'loans', unknown: 'accounts the app doesn’t know' };

/** Where money moved to another account of yours lands, by that account's type (undefined: another current account). */
function movedGroup(a: Account | undefined): string | undefined {
  if (!a) return 'unknown';
  if (a.type === 'credit_card') return 'cards';
  const meta = ACCOUNT_TYPE_META[a.type];
  if (meta.liability) return 'loans';
  if (a.type === 'current') return undefined;
  if (a.type === 'savings' || a.type === 'premium_bonds') return 'savings';
  if (meta.group === 'isa' || meta.group === 'lisa' || meta.group === 'pensions' || meta.group === 'investments') return meta.group;
  return 'savings';
}

/** A month's line amounts, in pence, for comparing months. */
interface MonthLines {
  month: string;
  complete: boolean;
  moneyIn: Record<MoneyInLine, number>;
  income: number;
  spending: Record<SpendingLine, number>;
  spendingTotal: number;
  net: number;
}

/** What working out any month needs, built once. */
export class MonthContext {
  readonly cats: CategoryIndex;
  private readonly accounts: Map<string, Account>;
  private readonly loans: Set<string>;
  private readonly scheduled = new Set<string>();
  private readonly payeeDates = new Map<string, ISODate[]>();
  private readonly parties: ReturnType<typeof personParties>;
  private readonly linesCache = new Map<string, MonthLines>();

  constructor(
    readonly store: Store,
    readonly engine: BalanceEngine,
    readonly coverage: Coverage,
  ) {
    this.cats = new CategoryIndex(store.categories);
    this.accounts = new Map(store.accounts.map((a) => [a.id, a]));
    this.loans = new Set(store.accounts.filter((a) => ACCOUNT_TYPE_META[a.type].liability && a.type !== 'credit_card').map((a) => a.id));
    // Payments an agreement schedules: paired with one of its payments, or filed by it.
    for (const v of agreementsView(store)) for (const p of v.payments) if (p.paid) this.scheduled.add(p.paid.transactionId);
    for (const t of store.transactions()) {
      if (t.categorisedBy === 'agreement') this.scheduled.add(t.id);
      if (t.amount < 0 && !t.transferGroup) {
        const key = payeeKey(t);
        if (key) (this.payeeDates.get(key) ?? this.payeeDates.set(key, []).get(key)!).push(t.date);
      }
    }
    for (const list of this.payeeDates.values()) list.sort();
    this.parties = personParties(store);
  }

  /** Every account has data for the month (≥ 90% of its days, §3). */
  isComplete(month: string): boolean {
    const from = `${month}-01`;
    return this.coverage.joint(from, endOfMonth(from)).completeMonths.includes(month);
  }

  /** How many payments to a payee in the 365 days before a day. */
  private priorPayments(key: string, date: ISODate): number {
    const list = this.payeeDates.get(key);
    if (!list) return 0;
    const from = addDays(date, -365);
    let n = 0;
    for (const d of list) if (d >= from && d < date) n++;
    return n;
  }

  /** The bucket a spending payment goes in (§18). */
  private spendingLine(t: Transaction, regular: Set<string>): Exclude<SpendingLine, 'money-back'> {
    if (this.scheduled.has(t.id)) return 'scheduled';
    if (regular.has(t.id)) return 'regular';
    const key = payeeKey(t);
    if (-t.amount >= MONTH_RULES.oneOffMinimum && key && this.priorPayments(key, t.date) < MONTH_RULES.oneOffPriorPayments) return 'one-offs';
    return 'everyday';
  }

  private moneyInLine(f: FlowTx): Exclude<MoneyInLine, 'borrowed'> {
    const c = f.t.category;
    if (!c) return 'uncategorised-in';
    if (PAY.has(c)) return 'pay';
    if (c === 'gifts-received') return 'gifts';
    return 'other-income';
  }

  /**
   * What a loan lent you or paid for you in [from, to], cards excepted, each payment once: the rows on
   * a loan that took its balance further into debt (not its interest or fees), and money in from a
   * loan whose own row isn't recorded yet (no transfer link to one).
   */
  borrowedIn(from: ISODate, to: ISODate): Transaction[] {
    const out: Transaction[] = [];
    for (const t of this.store.transactions()) {
      if (t.date < from || t.date > to) continue;
      if (this.loans.has(t.accountId)) {
        if (t.amount < 0 && !LOAN_CHARGES.has(t.category ?? '')) out.push(t);
      } else if (t.amount > 0 && !t.transferGroup && t.counterpartyAccountId && this.loans.has(t.counterpartyAccountId)) out.push(t);
    }
    return out;
  }

  /** A month's lines in pence, with the regular payments as they stood at its end. */
  lines(month: string): MonthLines {
    const hit = this.linesCache.get(month);
    if (hit) return hit;
    const from = `${month}-01`;
    const to = endOfMonth(from);
    const regular = new Set(detectRecurring(this.store, to).flatMap((r) => r.transactionIds));
    const moneyIn = Object.fromEntries(MONEY_IN_LINES.map(([id]) => [id, 0])) as Record<MoneyInLine, number>;
    const spending = Object.fromEntries(SPENDING_LINES.map(([id]) => [id, 0])) as Record<SpendingLine, number>;
    for (const f of flows(this.store, from, to)) {
      if (f.cls === 'income') moneyIn[this.moneyInLine(f)] += f.minor;
      else if (f.minor < 0) spending['money-back'] += f.minor;
      else spending[this.spendingLine(f.t, regular)] += f.minor;
    }
    moneyIn.borrowed = this.borrowedIn(from, to).reduce((s, t) => s + Math.abs(toMinor(t.amount)), 0);
    const income = moneyIn.pay + moneyIn['other-income'] + moneyIn.gifts + moneyIn['uncategorised-in'];
    const spendingTotal = Object.values(spending).reduce((s, v) => s + v, 0);
    const out: MonthLines = { month, complete: this.isComplete(month), moneyIn, income, spending, spendingTotal, net: income - spendingTotal };
    this.linesCache.set(month, out);
    return out;
  }

  /** A month's figure against the complete months among the 12 before, and the same month a year before. */
  compared(month: string, pick: (l: MonthLines) => number): MonthCompared | undefined {
    const before = eachMonth(`${addMonths(`${month}-01`, -MONTH_RULES.historyMonths).slice(0, 7)}-01`, addDays(`${month}-01`, -1))
      .slice(-MONTH_RULES.historyMonths)
      .map((m) => this.lines(m))
      .filter((l) => l.complete);
    if (!before.length) return undefined;
    const values = before.map(pick).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
    const lastYear = before.find((l) => l.month === addMonths(`${month}-01`, -12).slice(0, 7));
    return { median: fromMinor(median), low: fromMinor(values[0]!), high: fromMinor(values[values.length - 1]!), months: values.length, ...(lastYear ? { lastYear: fromMinor(pick(lastYear)) } : {}) };
  }

  summary(month: string): MonthSummary {
    const { store, cats } = this;
    const from = `${month}-01`;
    const to = endOfMonth(from);
    const joint = this.coverage.joint(from, to);
    const lines = this.lines(month);
    const recurring = detectRecurring(store, to);
    const regular = new Set(recurring.flatMap((r) => r.transactionIds));
    const monthFlows = flows(store, from, to);

    // Money in and spending, line by line, by category group.
    const byLine = new Map<string, { minor: number; count: Set<string>; groups: Map<string, number> }>();
    const add = (line: string, f: FlowTx) => {
      const e = byLine.get(line) ?? byLine.set(line, { minor: 0, count: new Set(), groups: new Map() }).get(line)!;
      e.minor += f.minor;
      e.count.add(f.t.id);
      const group = f.t.category ? (cats.kindOf(f.t.category) === 'income' && f.cls === 'spending' ? f.t.category : (cats.groupOf(f.t.category)?.id ?? f.t.category)) : 'uncategorised';
      e.groups.set(group, (e.groups.get(group) ?? 0) + f.minor);
    };
    const scheduled: MonthPayment[] = [];
    const oneOffs: MonthPayment[] = [];
    for (const f of monthFlows) {
      if (f.cls === 'income') add(this.moneyInLine(f), f);
      else if (f.minor < 0) add('money-back', f);
      else {
        const line = this.spendingLine(f.t, regular);
        add(line, f);
        if (line === 'scheduled' && !scheduled.some((p) => p.id === f.t.id)) scheduled.push(payment(f.t));
        if (line === 'one-offs' && !oneOffs.some((p) => p.id === f.t.id)) oneOffs.push(payment(f.t));
      }
    }
    const borrowedRows = this.borrowedIn(from, to);
    const groupName = (id: string) => (id === 'uncategorised' ? 'Uncategorised' : cats.name(id));
    const line = (id: string, label: string, pick: (l: MonthLines) => number): MonthLine => {
      const e = byLine.get(id);
      const compared = this.compared(month, pick);
      return {
        id,
        label,
        amount: fromMinor(pick(lines)),
        count: id === 'borrowed' ? borrowedRows.length : (e?.count.size ?? 0),
        groups: e ? [...e.groups.entries()].map(([g, minor]) => ({ id: g, name: groupName(g), amount: fromMinor(minor) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)) : [],
        ...(compared ? { compared } : {}),
      };
    };
    const inLines = MONEY_IN_LINES.map(([id, label]) => line(id, label, (l) => l.moneyIn[id]));
    const spendLines = SPENDING_LINES.map(([id, label]) => line(id, label, (l) => l.spending[id]));

    // Where the net went: money moved between your current accounts and the others.
    const groupOfTransfer = new Map<string, Transaction[]>();
    for (const t of store.transactions()) if (t.transferGroup && t.date >= addDays(from, -7) && t.date <= addDays(to, 7)) (groupOfTransfer.get(t.transferGroup) ?? groupOfTransfer.set(t.transferGroup, []).get(t.transferGroup)!).push(t);
    const moved = new Map<string, number>();
    for (const t of store.transactions()) {
      const account = this.accounts.get(t.accountId);
      if (account?.type !== 'current' || t.date < from || t.date > to) continue;
      const kind = cats.kindOf(t.category);
      if (!t.transferGroup && kind !== 'transfer' && kind !== 'investment') continue;
      // A loan's money in is borrowing, not money moved.
      if (t.counterpartyAccountId && this.loans.has(t.counterpartyAccountId) && t.amount > 0) continue;
      const other = t.counterpartyAccountId ?? groupOfTransfer.get(t.transferGroup ?? '')?.find((x) => x.id !== t.id)?.accountId;
      const where = movedGroup(other ? this.accounts.get(other) : undefined);
      if (!where) continue;
      moved.set(where, (moved.get(where) ?? 0) - toMinor(t.amount));
    }

    // What you were worth at each end, and what each value rests on.
    const startDay = addDays(from, -1);
    const start = estateOn(store, this.engine, startDay);
    const end = estateOn(store, this.engine, to);
    const accounts: MonthAccountValue[] = store.accounts
      .filter((a) => a.includeInNetWorth && (!a.closedOn || a.closedOn >= startDay) && (!a.openedOn || a.openedOn <= to))
      .map((a) => {
        const s = this.engine.balanceOn(a.id, startDay);
        const e = this.engine.balanceOn(a.id, to);
        const meta = ACCOUNT_TYPE_META[a.type];
        const market = balanceModeOf(a) === 'market';
        const old = market && e?.basis && (e.basis.after || diffDays(e.basis.date, to) > MONTH_RULES.valuationDays);
        return {
          accountId: a.id,
          name: a.name,
          group: meta.group,
          start: s?.gbp ?? null,
          end: e?.gbp ?? null,
          ...(e?.basis ? { basis: e.basis } : {}),
          estimated: e?.estimated ?? false,
          ...(old ? { oldValuation: true } : {}),
        };
      })
      .filter((a) => a.start !== null || a.end !== null);

    // How well the month is categorised.
    const sumMinor = (list: FlowTx[]) => list.reduce((s, f) => s + f.minor, 0);
    const spendFlows = monthFlows.filter((f) => f.cls === 'spending');
    const inFlows = monthFlows.filter((f) => f.cls === 'income');
    const uncatSpend = sumMinor(spendFlows.filter((f) => !f.t.category));
    const uncatIn = sumMinor(inFlows.filter((f) => !f.t.category));
    const people = { count: 0, in: 0, out: 0 };
    for (const t of store.transactions()) {
      if (t.date < from || t.date > to || !this.parties.has(t.id)) continue;
      if (t.categorisedBy === 'user' || t.categorisedBy === 'rule' || t.categorisedBy === 'agreement') continue;
      people.count++;
      if (t.amount > 0) people.in += toMinor(t.amount);
      else people.out -= toMinor(t.amount);
    }

    // Payees new this month, and regular payments that started, stopped or changed price.
    const newPayees = new Map<string, { payee: string; minor: number; count: number }>();
    for (const f of spendFlows) {
      if (f.minor <= 0 || this.parties.has(f.t.id)) continue;
      const key = payeeKey(f.t);
      if (!key || this.priorPayments(key, from) > 0) continue;
      const e = newPayees.get(key) ?? newPayees.set(key, { payee: f.t.payee ?? cleanPayee(f.t.description), minor: 0, count: 0 }).get(key)!;
      e.minor += f.minor;
      e.count++;
    }
    const change = (r: (typeof recurring)[number], date: string, extra: Partial<MonthRegularChange> = {}): MonthRegularChange => ({ payee: r.payee, cadence: r.cadence, amount: r.typicalAmount, date, ...extra });
    const inMonth = (d: string | undefined) => d !== undefined && d >= from && d <= to;
    const started = recurring.filter((r) => inMonth(r.firstDate)).map((r) => change(r, r.firstDate));
    const stopped = recurring.filter((r) => !r.active && inMonth(r.nextDate)).map((r) => change(r, r.nextDate));
    const priceChanged = recurring.filter((r) => inMonth(r.priceChange?.date)).map((r) => change(r, r.priceChange!.date, { amount: r.priceChange!.to, from: r.priceChange!.from }));

    // What the agreements have due in the 60 days after the month.
    const until = addDays(to, MONTH_RULES.comingDays);
    const coming = agreementsView(store, to)
      .flatMap((v) =>
        v.payments
          .filter((p) => p.due > to && p.due <= until && p.status !== 'cancelled')
          .map((p) => ({ date: p.due, amount: p.amount, direction: v.agreement.direction === 'in' ? ('in' as const) : ('out' as const), agreementId: v.agreement.id, name: v.agreement.name, ...(p.label ? { label: p.label } : {}) })),
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    const spendingCompared = this.compared(month, (l) => l.spendingTotal);
    const netCompared = this.compared(month, (l) => l.net);
    const groups = WRAPPER_GROUPS.map((g: WrapperGroup) => ({ id: g, label: WRAPPER_GROUP_LABELS[g], start: start.wrapper.get(g) ?? 0, end: end.wrapper.get(g) ?? 0 })).filter((g) => g.start !== 0 || g.end !== 0);
    return {
      month,
      from,
      to,
      complete: lines.complete,
      limitedBy: joint.limiting,
      moneyIn: { income: fromMinor(lines.income), borrowed: fromMinor(lines.moneyIn.borrowed), total: fromMinor(lines.income + lines.moneyIn.borrowed), lines: inLines },
      borrowed: borrowedRows.map(payment).sort((a, b) => a.date.localeCompare(b.date)),
      spending: {
        total: fromMinor(lines.spendingTotal),
        lines: spendLines,
        scheduled: scheduled.sort((a, b) => a.date.localeCompare(b.date)),
        oneOffs: oneOffs.sort((a, b) => a.amount - b.amount),
        ...(spendingCompared ? { compared: spendingCompared } : {}),
      },
      net: { amount: fromMinor(lines.net), ...(netCompared ? { compared: netCompared } : {}) },
      moved: [...moved.entries()].filter(([, v]) => v !== 0).map(([id, minor]) => ({ id, label: MOVED_TO[id] ?? id, amount: fromMinor(minor) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      worth: { start: start.total, end: end.total, change: fromMinor(toMinor(end.total) - toMinor(start.total)), estimated: start.estimated || end.estimated, groups, accounts },
      quality: {
        uncategorisedSpending: fromMinor(uncatSpend),
        uncategorisedSpendingShare: lines.spendingTotal > 0 ? Math.round((uncatSpend / lines.spendingTotal) * 1000) / 1000 : null,
        uncategorisedIn: fromMinor(uncatIn),
        uncategorisedInShare: lines.income > 0 ? Math.round((uncatIn / lines.income) * 1000) / 1000 : null,
        peopleToConfirm: { count: people.count, in: fromMinor(people.in), out: fromMinor(people.out) },
      },
      payees: {
        new: [...newPayees.values()].sort((a, b) => b.minor - a.minor).slice(0, MONTH_RULES.listed).map((e) => ({ payee: e.payee, amount: fromMinor(e.minor), count: e.count })),
        started: started.slice(0, MONTH_RULES.listed),
        stopped: stopped.slice(0, MONTH_RULES.listed),
        priceChanged: priceChanged.slice(0, MONTH_RULES.listed),
      },
      coming,
    };
  }
}

/** Who a payment is to, reduced for comparing (cash from a machine is nobody's). */
function payeeKey(t: Transaction): string | undefined {
  if (t.category === 'cash-withdrawal' || isCashWithdrawal(t.description, t.type)) return undefined;
  const key = nameKey(t.payee ?? cleanPayee(t.description));
  return key.length >= 2 ? key : undefined;
}

function payment(t: Transaction): MonthPayment {
  return { id: t.id, date: t.date, accountId: t.accountId, payee: t.payee ?? cleanPayee(t.description), amount: t.amount, ...(t.category ? { category: t.category } : {}) };
}
