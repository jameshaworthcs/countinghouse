// The balance engine: what was each account worth on any given day?
//
// Ledger accounts (bank, savings, cards, loans, cash ISAs): known balances are anchors (statement
// or screenshot snapshots, and running balances printed next to transactions). Between anchors the
// balance moves exactly with transactions: balance(D) = anchor + Σ transactions in (anchor, D].
// A row printed on the statement after the close it is dated before counts from after that close
// (ledgerDates).
// Before the first anchor it is rolled back from the next one. With no anchors at all it is the
// running sum of transactions, flagged as estimated.
//
// Market accounts (investments, pensions, property): valuations are anchors, and money moving in or
// out from outside (contributions, withdrawals, bonus, relief) is added to them. Between two
// valuations the growth between them is shared out: as the holdings' published prices moved, when
// there are prices for enough of them (prices.ts), else evenly over the days; either way an
// estimate that meets both valuations exactly. After the last valuation only money moving counts.
// Before the first valuation, value is estimated: rolled back from it as the prices moved, or, with
// no prices, from contributions plus growth accrued linearly when the data goes back to the
// account's start, else rolled back by the money that arrived since.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { addDays, diffDays, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { BalanceBasis } from '../../shared/api';
import type { Account, BalanceEvidence, BalanceSnapshot, HoldingsSnapshot, Settings, Transaction } from '../../shared/schema';
import type { Store } from '../store';
import { covers, holdingsPath, indexNear, PriceBook, type HoldingsPath, type PriceIndex } from './prices';

/** What the engine reads: a store, or a store as a proposal would leave it; holdings and prices when it has them. */
export type BalanceSource = Pick<Store, 'accounts' | 'transactions' | 'balances' | 'settings'> & Partial<Pick<Store, 'holdings' | 'instruments' | 'research'>>;

interface Anchor {
  date: ISODate;
  minor: number;
  /**
   * Screenshot balances may be taken mid-day, so they are weaker evidence for gap checks. An
   * approximate figure you gave is weaker still: it only stands in for what is newer than your data.
   */
  source: 'snapshot' | 'running' | 'screenshot' | 'approximate';
  /** Wall-clock time (HH:MM:SS) on its day when it was seen; absent for a close or an untimed screenshot. */
  at?: string;
  /** Seen mid-day with rows of its day that may come after it: weak for gap checks. */
  midDay?: boolean;
}

/**
 * Which of two anchors of one day stands for it (docs/FORMULAS.md §9): the later, when both say when
 * (a close is the latest); otherwise, or at the same moment, the stronger (a statement's or your own
 * balance, then a screenshot's, then a running balance), the newer of equals.
 */
const STRENGTH: Record<Anchor['source'], number> = { approximate: 0, running: 1, screenshot: 2, snapshot: 3 };
const momentOf = (a: Anchor): string | undefined => a.at ?? (a.source === 'screenshot' ? undefined : '24:00:00');
function outranks(next: Anchor, current: Anchor): boolean {
  const [m, n] = [momentOf(next), momentOf(current)];
  if (m !== undefined && n !== undefined && m !== n) return m > n;
  return STRENGTH[next.source] >= STRENGTH[current.source];
}

/** A balance's time on its own day (HH:MM:SS), when it has one for that day. */
export function timeOnDay(b: { date: ISODate; at?: string | undefined }): string | undefined {
  return b.at && b.at.slice(0, 10) === b.date ? b.at.slice(11, 19) : undefined;
}

interface Series {
  dates: ISODate[];
  prefix: number[]; // prefix[i] = Σ minor of items 0..i
}

interface AccountData {
  account: Account;
  mode: 'ledger' | 'market';
  tx: Series;
  flows: Series;
  /** The money moving in or out from outside, one by one (market accounts). */
  flowList: { date: ISODate; minor: number }[];
  /** Every row, for the holdings path (market accounts). */
  rows: Transaction[];
  anchors: Anchor[];
  firstDate: ISODate | null;
  lastDate: ISODate | null;
  lastSnapshot: ISODate | null;
  lastTransaction: ISODate | null;
  fx: number | null;
  /** Market accounts: the external flows go back to the account's start (flowsFromStart). */
  fromStart: boolean;
}

/**
 * Whether a market account's external flows go back to its start, so that summed they are all it
 * was ever paid (docs/FORMULAS.md §12, "Paid in"): every real valuation before the first flow is
 * nothing, and there is one, or the first flow comes within 31 days of the account's opening.
 * Otherwise the data starts part-way through the account's life.
 */
export function flowsFromStart(account: Pick<Account, 'openedOn'>, valuations: { date: ISODate; balance: number }[], firstFlow: ISODate | null): boolean {
  if (firstFlow === null) return false;
  const before = valuations.filter((b) => b.date < firstFlow);
  return before.every((b) => Math.abs(b.balance) < 1) && (before.length > 0 || (account.openedOn !== undefined && diffDays(account.openedOn, firstFlow) <= 31));
}

export interface BalancePoint {
  /** Balance in the account's own currency. */
  value: number;
  /** Converted to GBP (null when no FX rate is configured). */
  gbp: number | null;
  estimated: boolean;
  /** The balance or valuation it is worked out from; none for a running sum of rows alone, or a closed account. */
  basis?: BalanceBasis;
}

const BASIS_KIND: Record<Anchor['source'], BalanceBasis['kind']> = { snapshot: 'balance', running: 'running', screenshot: 'screenshot', approximate: 'approximate' };
const basisOf = (a: Anchor, after = false): BalanceBasis => ({ date: a.date, kind: BASIS_KIND[a.source], ...(after ? { after: true as const } : {}) });

/** How far from a day a cash figure may be to give an investments-alone value its cash. */
const CASH_REFERENCE_DAYS = 31;

/**
 * For each valuation of a valued account that is its investments alone, the cash to add, in pence
 * (§9, "Investments alone"). One is: no cash on it, and its own import recorded a holdings
 * snapshot that day, with no cash either, whose holdings add up to it (within £1): a holdings page
 * whose total is the funds alone. Its cash is the nearest cash figure within 31 days (a balance's
 * `cash`, or a snapshot's), carried to that day by the account's rows between; with none, nothing.
 */
function investmentsOnlyCash(snaps: readonly BalanceSnapshot[], holdings: readonly HoldingsSnapshot[], txs: readonly Transaction[]): (s: BalanceSnapshot) => number {
  const refs = [...snaps.filter((b) => b.cash !== undefined).map((b) => ({ date: b.date, cash: b.cash! })), ...holdings.filter((h) => h.cash !== undefined).map((h) => ({ date: h.date, cash: h.cash! }))];
  const rows = buildSeries(txs);
  return (s) => {
    if (s.cash !== undefined || !s.source.importId) return 0;
    const own = holdings.find((h) => h.source.importId === s.source.importId && h.date === s.date && h.cash === undefined && h.holdings.length);
    if (!own || Math.abs(toMinor(own.holdings.reduce((sum, h) => sum + h.value, 0)) - toMinor(s.balance)) > 100) return 0;
    const ref = refs.filter((r) => Math.abs(diffDays(r.date, s.date)) <= CASH_REFERENCE_DAYS).sort((a, b) => Math.abs(diffDays(a.date, s.date)) - Math.abs(diffDays(b.date, s.date)) || a.date.localeCompare(b.date))[0];
    if (!ref) return 0;
    return toMinor(ref.cash) + sumTo(rows, s.date) - sumTo(rows, ref.date);
  };
}

/** Prices may end this many days before the valuation an estimate is worked towards. */
const PRICES_END_SLACK_DAYS = 7;

/** The steady daily rate, within ±2% a day, at which `miss` is nothing, by bisection; none when no rate there is. */
function solveRate(miss: (rate: number) => number): number | undefined {
  let [lo, hi] = [-0.02, 0.02];
  let [mLo, mHi] = [miss(lo), miss(hi)];
  if (Math.abs(mLo) < 0.5) return lo;
  if (Math.abs(mHi) < 0.5) return hi;
  if (Math.sign(mLo) === Math.sign(mHi)) return undefined;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const m = miss(mid);
    if (Math.abs(m) < 0.5) return mid;
    if (Math.sign(m) === Math.sign(mLo)) [lo, mLo] = [mid, m];
    else [hi, mHi] = [mid, m];
  }
  return (lo + hi) / 2;
}

/** Transactions by day, in date order. */
function daysOf<T extends { date: ISODate }>(txs: T[]): Map<ISODate, T[]> {
  const days = new Map<ISODate, T[]>();
  for (const t of txs) (days.get(t.date) ?? days.set(t.date, []).get(t.date)!).push(t);
  return days;
}

/**
 * A day's closing running balance, in minor units: where its printed balances end. Each row's
 * balance follows the row before it, so the close is the balance no other row of the day starts
 * from. That holds whatever order the rows are stored in, as when two statements that overlap by a
 * day each add some of its rows. When the chain does not show a single end, the day's last row with
 * a balance stands in, as before.
 */
export function dayClose(day: { amount: number; balanceAfter?: number | undefined }[]): number | undefined {
  const printed = day.filter((t): t is typeof t & { balanceAfter: number } => t.balanceAfter !== undefined);
  if (!printed.length) return undefined;
  const starts = new Set(printed.map((t) => toMinor(t.balanceAfter) - toMinor(t.amount)));
  const ends = [...new Set(printed.map((t) => toMinor(t.balanceAfter)).filter((b) => !starts.has(b)))];
  return ends.length === 1 ? ends[0] : toMinor(printed[printed.length - 1]!.balanceAfter);
}

function buildSeries(items: readonly { date: ISODate; amount: number }[]): Series {
  const dates: ISODate[] = [];
  const prefix: number[] = [];
  let acc = 0;
  for (const it of items) {
    acc += toMinor(it.amount);
    dates.push(it.date);
    prefix.push(acc);
  }
  return { dates, prefix };
}

/** Σ of items with date <= d. */
function sumTo(series: Series, d: ISODate): number {
  let lo = 0;
  let hi = series.dates.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid]! <= d) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx < 0 ? 0 : series.prefix[idx]!;
}

function lastAnchorOnOrBefore(anchors: Anchor[], d: ISODate): Anchor | undefined {
  let lo = 0;
  let hi = anchors.length - 1;
  let found: Anchor | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.date <= d) {
      found = anchors[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** A statement's, running or your own balance, as a day's close. */
const isStrong = (a: Anchor) => a.source !== 'screenshot' && a.source !== 'approximate' && !a.midDay;

function firstAnchorAfter(anchors: Anchor[], d: ISODate): Anchor | undefined {
  return anchors.find((a) => a.date > d);
}

/**
 * How far before a statement's close a payment printed on the next statement may be dated. Cards
 * print a payment made on (or just before) the closing day on the next statement when it posts
 * late; a document with rows older than this spans more than one statement period.
 */
export const LATE_POSTING_DAYS = 7;

/**
 * The day each transaction counts from in a ledger balance (docs/FORMULAS.md §9): its own date,
 * except that a row printed on one statement but dated on or before the previous statement's close
 * counts from the day after that close, since that closing balance did not include it. Rows with a
 * printed running balance keep their date: the balance pins them to it.
 */
export function ledgerDates<T extends { date: ISODate; balanceAfter?: number | undefined; source: { importId?: string | undefined } }>(
  txs: T[],
  snaps: { date: ISODate; kind: string; approximate?: boolean | undefined; source: { importId?: string | undefined } }[],
): (T & { countsFrom: ISODate })[] {
  const closes = new Map<string, ISODate>();
  for (const s of snaps) {
    const id = s.source.importId;
    if (s.kind !== 'statement' || s.approximate || !id) continue;
    const had = closes.get(id);
    if (!had || s.date > had) closes.set(id, s.date);
  }
  const sorted = [...new Set(closes.values())].sort();
  const previousClose = (close: ISODate) => sorted.filter((d) => d < close).at(-1);
  // A statement's rows count after the previous close only when every row dated on or before it is
  // within LATE_POSTING_DAYS of it: otherwise the document covers more than one period.
  const floor = new Map<string, ISODate>();
  for (const [id, close] of closes) {
    const prev = previousClose(close);
    if (!prev) continue;
    const early = txs.filter((t) => t.source.importId === id && t.balanceAfter === undefined && t.date <= prev);
    if (early.length && early.every((t) => diffDays(t.date, prev) <= LATE_POSTING_DAYS)) floor.set(id, addDays(prev, 1));
  }
  const out = txs.map((t) => {
    const from = t.source.importId && t.balanceAfter === undefined ? floor.get(t.source.importId) : undefined;
    return { ...t, countsFrom: from && t.date < from ? from : t.date };
  });
  return out.sort((a, b) => (a.countsFrom < b.countsFrom ? -1 : a.countsFrom > b.countsFrom ? 1 : 0));
}

export function fxRate(currency: string, settings: Settings): number | null {
  if (currency === 'GBP') return 1;
  return settings.fx[currency] ?? null;
}

/**
 * Newest date with any data for an account, for "last updated" and staleness: its balance data, or
 * HMRC's State Pension forecast on it, which is a yearly update with no balance (docs/FORMULAS.md §9).
 */
export function lastUpdated(store: Pick<Store, 'hmrc'>, engine: BalanceEngine, accountId: string): ISODate | null {
  let last = engine.lastDataDate(accountId);
  for (const r of store.hmrc) if (r.type === 'state-pension-forecast' && r.accountId === accountId && (!last || r.asOf > last)) last = r.asOf;
  return last;
}

export class BalanceEngine {
  private readonly data = new Map<string, AccountData>();
  private readonly usable = new Map<string, Anchor[]>();
  private readonly prices: PriceBook | undefined;
  private readonly indexes = new Map<string, PriceIndex | null>();
  private readonly paths = new Map<string, HoldingsPath | null>();

  constructor(private readonly store: BalanceSource) {
    this.prices = store.research && store.instruments && store.holdings ? new PriceBook(store.research) : undefined;
    for (const account of store.accounts) {
      const mode = balanceModeOf(account);
      const txs = store.transactions(account.id);
      const snaps = store.balances(account.id);
      const anchors = new Map<ISODate, Anchor>();
      if (mode === 'ledger') {
        // End-of-day running balances (docs/FORMULAS.md §9).
        for (const [date, day] of daysOf(txs)) {
          const close = dayClose(day);
          if (close !== undefined) anchors.set(date, { date, minor: close, source: 'running' });
        }
      }
      // An approximate figure you gave stands in only for what is newer than all of the account's
      // real data (docs/FORMULAS.md §9); it never counts as data for staleness or gap checks.
      const real = snaps.filter((s) => !s.approximate);
      const lastReal = [txs[txs.length - 1]?.date, real[real.length - 1]?.date].filter(Boolean).sort().reverse()[0];
      const placeholders = snaps.filter((s) => s.approximate && (!lastReal || s.date > lastReal));
      // A valued account's figure that is its investments alone (its document showed no cash) is
      // worth that plus the cash it held that day (docs/FORMULAS.md §9, "Investments alone").
      const plusCash = mode === 'market' ? investmentsOnlyCash(snaps, store.holdings?.(account.id) ?? [], txs) : () => 0;
      // One anchor a day: the later one, else the stronger (`outranks`). A screenshot may be taken
      // mid-day, and would hide what a statement's or your own balance says from the gap check; one
      // you typed yourself weighs as your own.
      for (const s of real) {
        const source = s.kind === 'screenshot' && s.enteredBy !== 'user' ? 'screenshot' : 'snapshot';
        const at = timeOnDay(s);
        const next: Anchor = { date: s.date, minor: toMinor(s.balance) + plusCash(s), source, ...(at ? { at } : {}) };
        const current = anchors.get(s.date);
        if (!current || outranks(next, current)) anchors.set(s.date, next);
      }
      // A balance seen mid-day is not its day's close: rows of that day not known to come before it
      // (no time, or a later one) may follow it, so it cannot show a gap.
      const byDay = daysOf(txs);
      for (const a of anchors.values()) {
        if (a.at && (byDay.get(a.date) ?? []).some((t) => !t.time || t.time.length < 5 || t.time.padEnd(8, ':00').slice(0, 8) > a.at!)) a.midDay = true;
      }
      for (const s of placeholders) if (!anchors.has(s.date)) anchors.set(s.date, { date: s.date, minor: toMinor(s.balance), source: 'approximate' });
      const sortedAnchors = [...anchors.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      const flows = txs.filter((t) => t.category && EXTERNAL_FLOW_CATEGORIES.has(t.category));
      const firstTx = txs[0]?.date ?? null;
      const lastTx = txs[txs.length - 1]?.date ?? null;
      const firstAnchor = sortedAnchors[0]?.date ?? null;
      const lastSnapshot = real.length ? real[real.length - 1]!.date : null;
      const firstFlow = flows[0]?.date ?? null;
      const candidatesFirst = mode === 'ledger' ? [firstTx, firstAnchor] : [firstAnchor, firstFlow];
      const firstDate = candidatesFirst.filter(Boolean).sort()[0] ?? null;
      const lastDate = [lastTx, lastSnapshot].filter(Boolean).sort().reverse()[0] ?? null;
      this.data.set(account.id, {
        account,
        mode,
        tx: buildSeries(mode === 'ledger' ? ledgerDates(txs, snaps).map((t) => ({ date: t.countsFrom, amount: t.amount })) : txs),
        flows: buildSeries(flows),
        flowList: flows.map((t) => ({ date: t.date, minor: toMinor(t.amount) })),
        rows: mode === 'market' ? txs : [],
        anchors: mode === 'market' ? sortedAnchors.filter((a) => a.source !== 'running') : sortedAnchors,
        firstDate,
        lastDate,
        lastSnapshot,
        lastTransaction: lastTx,
        fx: fxRate(account.currency, store.settings),
        fromStart: flowsFromStart(account, real, firstFlow),
      });
    }
  }

  has(accountId: string): boolean {
    return this.data.has(accountId);
  }

  /** Newest date with any data for the account. */
  lastDataDate(accountId: string): ISODate | null {
    return this.data.get(accountId)?.lastDate ?? null;
  }

  firstDataDate(accountId: string): ISODate | null {
    return this.data.get(accountId)?.firstDate ?? null;
  }

  info(accountId: string): { lastSnapshot: ISODate | null; lastTransaction: ISODate | null; anchors: number; mode: 'ledger' | 'market' } | null {
    const d = this.data.get(accountId);
    if (!d) return null;
    return { lastSnapshot: d.lastSnapshot, lastTransaction: d.lastTransaction, anchors: d.anchors.length, mode: d.mode };
  }

  balanceOn(accountId: string, date: ISODate): BalancePoint | null {
    const d = this.data.get(accountId);
    if (!d || !d.firstDate || date < d.firstDate) return null;
    const { account } = d;
    if (account.closedOn && date > account.closedOn) return { value: 0, gbp: 0, estimated: false };
    let minor: number;
    let estimated = false;
    let basis: BalanceBasis | undefined;
    if (d.mode === 'ledger') {
      // Interest its documents do not list (a student loan's) makes any day but a statement's own an estimate.
      const unrecorded = Boolean(ACCOUNT_TYPE_META[account.type].interestUnrecorded);
      const a1 = lastAnchorOnOrBefore(d.anchors, date);
      if (a1) {
        minor = a1.minor + (sumTo(d.tx, date) - sumTo(d.tx, a1.date));
        estimated = a1.source === 'approximate' || (unrecorded && a1.date !== date);
        basis = basisOf(a1);
      } else {
        const a2 = firstAnchorAfter(d.anchors, date);
        if (a2) {
          minor = a2.minor - (sumTo(d.tx, a2.date) - sumTo(d.tx, date));
          estimated = a2.source === 'approximate' || unrecorded;
          basis = basisOf(a2, true);
        } else {
          minor = sumTo(d.tx, date);
          estimated = true;
        }
      }
    } else {
      const a1 = lastAnchorOnOrBefore(d.anchors, date);
      const a2 = firstAnchorAfter(d.anchors, date);
      if (a1 && a2 && a1.date !== date && a2.source !== 'approximate') {
        // Between two valuations: as its holdings were worth at published prices, meeting both;
        // else the growth between them shared out, as the prices moved or by days.
        const path = this.pathFor(d, a1.date, a2.date);
        const index = path ? undefined : this.indexFor(d, a1.date, a2.date);
        if (path) {
          const [r1, r2] = [a1.minor - path.at(a1.date), a2.minor - path.at(a2.date)];
          minor = Math.round(path.at(date) + r1 + (r2 - r1) * (diffDays(a1.date, date) / Math.max(1, diffDays(a1.date, a2.date))));
        } else minor = this.valueBetween(d, a1, a2, date, index);
        estimated = true;
        basis = { ...basisOf(a1), to: a2.date, ...(path || index ? { prices: true as const } : {}) };
      } else if (a1) {
        minor = a1.minor + (sumTo(d.flows, date) - sumTo(d.flows, a1.date));
        estimated = a1.source === 'approximate';
        basis = basisOf(a1);
      } else {
        const contributed = sumTo(d.flows, date);
        estimated = true;
        if (a2) basis = basisOf(a2, true);
        const path = a2 ? this.pathFor(d, date, a2.date) : undefined;
        const index = a2 && !path ? this.indexFor(d, date, a2.date) : undefined;
        if (a2 && path) {
          // As its holdings were worth at published prices, less what they were short of the valuation.
          const rolled = Math.round(path.at(date) + a2.minor - path.at(a2.date));
          minor = ACCOUNT_TYPE_META[account.type].liability ? rolled : Math.max(0, rolled);
          basis = { ...basis!, prices: true };
        } else if (a2 && index) {
          // Rolled back from the first valuation as the prices moved, with the money that arrived since.
          const I = (t: ISODate) => index.at(t);
          const since = d.flowList.filter((f) => f.date > date && f.date <= a2.date).reduce((s, f) => s + f.minor * (I(a2.date) / I(f.date)), 0);
          const rolled = Math.round((a2.minor - since) * (I(date) / I(a2.date)));
          minor = ACCOUNT_TYPE_META[account.type].liability ? rolled : Math.max(0, rolled);
          basis = { ...basis!, prices: true };
        } else if (a2 && (diffDays(date, a2.date) <= 45 || !d.fromStart)) {
          // Close to the first valuation, or data that starts part-way through the account's life
          // (it was not empty when the first flow arrived): roll back by the money that arrived
          // since, as if nothing grew. An asset is never worth less than nothing.
          const rolled = a2.minor - (sumTo(d.flows, a2.date) - contributed);
          minor = ACCOUNT_TYPE_META[account.type].liability ? rolled : Math.max(0, rolled);
        } else if (a2 && d.flows.dates.length) {
          // The flows go back to the start: it grew from them to the first valuation.
          const firstFlow = d.flows.dates[0]!;
          const growthAtA2 = a2.minor - sumTo(d.flows, a2.date);
          const span = Math.max(1, diffDays(firstFlow, a2.date));
          const frac = Math.min(1, Math.max(0, diffDays(firstFlow, date) / span));
          minor = contributed + Math.round(growthAtA2 * frac);
        } else if (d.flows.dates.length) {
          minor = contributed;
        } else return null;
      }
    }
    const value = fromMinor(minor);
    return { value, gbp: d.fx === null ? null : fromMinor(Math.round(minor * d.fx)), estimated, ...(basis ? { basis } : {}) };
  }

  /**
   * A market account's holdings path for valuing days from `from` to `to` (prices.ts): from its
   * holdings snapshot nearest the later day that has one good for them all.
   */
  private pathFor(d: AccountData, from: ISODate, to: ISODate): HoldingsPath | undefined {
    if (!this.prices || !this.store.holdings || !this.store.instruments) return undefined;
    const snaps = [...this.store.holdings(d.account.id)].sort((a, b) => Math.abs(diffDays(a.date, to)) - Math.abs(diffDays(b.date, to)) || b.date.localeCompare(a.date));
    for (const snap of snaps) {
      let path = this.paths.get(snap.id);
      if (path === undefined) {
        // Its cash: as the snapshot gives it, else a balance of that day or the next.
        const cash = snap.cash ?? this.store.balances(d.account.id).find((b) => b.cash !== undefined && (b.date === snap.date || b.date === addDays(snap.date, 1)))?.cash;
        path = holdingsPath(snap, cash, d.rows, this.store.instruments, this.prices) ?? null;
        this.paths.set(snap.id, path);
      }
      if (path && path.from <= from && diffDays(path.to, to) <= PRICES_END_SLACK_DAYS) return path;
    }
    return undefined;
  }

  /**
   * A market account's price index for valuing days from `from` to `to`: weighted by its holdings
   * nearest the later day, when its prices cover them all (docs/FORMULAS.md §9, "Between valuations").
   */
  private indexFor(d: AccountData, from: ISODate, to: ISODate): PriceIndex | undefined {
    if (!this.prices || !this.store.holdings || !this.store.instruments) return undefined;
    const key = `${d.account.id}|${to}`;
    let index = this.indexes.get(key);
    if (index === undefined) {
      index = indexNear(this.store.holdings(d.account.id), to, this.store.instruments, this.prices) ?? null;
      this.indexes.set(key, index);
    }
    return index && covers(index, from, addDays(to, -PRICES_END_SLACK_DAYS)) ? index : undefined;
  }

  /**
   * A value between two valuations (§9, "Between valuations"): the first, and each sum moved in or
   * out since, grown as the index moved (by nothing with no index) and at one steady rate on top,
   * the rate that makes them come to the second valuation on its day. When no rate does (money taken
   * out that the valuations cannot follow), what is left unexplained there is shared out by days.
   */
  private valueBetween(d: AccountData, a1: Anchor, a2: Anchor, date: ISODate, index: PriceIndex | undefined): number {
    const I = (t: ISODate) => (index ? index.at(t) : 1);
    const flows = d.flowList.filter((f) => f.date > a1.date && f.date <= a2.date);
    const model = (t: ISODate, rate: number) => {
      const grown = (from: ISODate) => (I(t) / I(from)) * Math.exp(rate * diffDays(from, t));
      return a1.minor * grown(a1.date) + flows.filter((f) => f.date <= t).reduce((s, f) => s + f.minor * grown(f.date), 0);
    };
    const rate = solveRate((r) => model(a2.date, r) - a2.minor);
    if (rate !== undefined) return Math.round(model(date, rate));
    const rest = a2.minor - model(a2.date, 0);
    return Math.round(model(date, 0) + rest * (diffDays(a1.date, date) / Math.max(1, diffDays(a1.date, a2.date))));
  }

  /**
   * A ledger account's balance at the start of `day`: its close that day less the rows that count
   * on it (`ledgerDates`). Null for a valued account, or before its data.
   */
  openingOn(accountId: string, day: ISODate): BalancePoint | null {
    const d = this.data.get(accountId);
    if (!d || d.mode !== 'ledger') return null;
    const close = this.balanceOn(accountId, day);
    if (!close) return null;
    const minor = toMinor(close.value) - (sumTo(d.tx, day) - sumTo(d.tx, addDays(day, -1)));
    return { value: fromMinor(minor), gbp: d.fx === null ? null : fromMinor(Math.round(minor * d.fx)), estimated: close.estimated };
  }

  latest(accountId: string, on: ISODate = today()): (BalancePoint & { asOf: ISODate | null }) | null {
    const p = this.balanceOn(accountId, on);
    if (!p) return null;
    return { ...p, asOf: this.lastDataDate(accountId) };
  }

  /** Balances at each date (null where unknown). */
  series(accountId: string, dates: ISODate[]): (number | null)[] {
    return dates.map((d) => this.balanceOn(accountId, d)?.gbp ?? null);
  }

  /**
   * Gaps between consecutive anchors that transactions don't explain: usually a missing statement.
   * A screenshot or a balance seen mid-day takes part when it adds up exactly (`usableAnchors`).
   */
  gaps(accountId: string): { from: ISODate; to: ISODate; difference: number }[] {
    const usable = this.usableAnchors(accountId);
    const out: { from: ISODate; to: ISODate; difference: number }[] = [];
    for (let i = 1; i < usable.length; i++) {
      const gap = this.unexplained(accountId, usable[i - 1]!, usable[i]!);
      if (gap.difference) out.push(gap);
    }
    return out;
  }

  /**
   * What the balances say about the days from `from` to `to` (docs/FORMULAS.md §3, "Balance
   * evidence"): whether the balance before them, carried by the rows recorded, comes to each balance
   * after, through the first on or after `to` (or the last inside them). With nothing recorded
   * before them, an account that opened on a known day starts from the £0 it opened with.
   */
  evidence(accountId: string, from: ISODate, to: ISODate): BalanceEvidence {
    const d = this.data.get(accountId);
    if (!d || d.mode !== 'ledger') return { status: 'no-balance' };
    let list = this.usableAnchors(accountId);
    const opened = d.account.openedOn ? addDays(d.account.openedOn, -1) : undefined;
    const fromOpening = opened !== undefined && !(list[0] && list[0].date <= opened) && !(d.tx.dates[0] && d.tx.dates[0] <= opened);
    if (fromOpening) list = [{ date: opened, minor: 0, source: 'snapshot' }, ...list];
    const start = list.findLastIndex((a) => a.date < from);
    if (start < 0) return { status: 'no-balance' };
    const after = list.findIndex((a) => a.date >= to);
    const end = after >= 0 ? after : list.findLastIndex((a) => a.date >= from);
    const opening = fromOpening && start === 0 ? { fromOpening: true } : {};
    if (end < 0) return { status: 'no-balance', from: list[start]!.date, ...opening };
    let difference = 0;
    let unexplained = false;
    for (let i = start + 1; i <= end; i++) {
      const pair = this.unexplained(accountId, list[i - 1]!, list[i]!);
      difference += toMinor(pair.difference);
      if (pair.difference) unexplained = true;
    }
    return { status: unexplained ? 'unexplained' : 'adds-up', from: list[start]!.date, to: list[end]!.date, through: after >= 0 ? to : list[end]!.date, difference: fromMinor(difference), ...opening };
  }

  /**
   * The strong anchors either side of a day, for a row on it: the last before it and the first on
   * or after it (a row counts in its own day's close), with what the rows between leave unexplained.
   * Null without one on each side.
   */
  between(accountId: string, date: ISODate): { from: { date: ISODate; balance: number }; to: { date: ISODate; balance: number }; difference: number } | null {
    const strong = this.strongAnchors(accountId);
    const i = strong.findIndex((a) => a.date >= date);
    if (i < 1) return null;
    const [a, b] = [strong[i - 1]!, strong[i]!];
    return { from: { date: a.date, balance: fromMinor(a.minor) }, to: { date: b.date, balance: fromMinor(b.minor) }, difference: this.unexplained(accountId, a, b).difference };
  }

  /** Statement, running and your own balances: screenshots and balances seen mid-day may not be the day's close, approximate figures are rough. */
  private strongAnchors(accountId: string): Anchor[] {
    const d = this.data.get(accountId);
    if (!d || d.mode !== 'ledger' || d.tx.dates.length === 0) return [];
    return d.anchors.filter(isStrong);
  }

  /**
   * The strong anchors, with each screenshot or balance seen mid-day that adds up exactly with them
   * (docs/FORMULAS.md §9, "Gaps"): the anchor before it (or, before the first, the one after),
   * carried by the rows recorded, comes to it at its day's close, or at the close of the day before
   * when it was seen before that day's rows. One that does not is left out, as before: it may have
   * been seen before rows that were still to post.
   */
  private usableAnchors(accountId: string): Anchor[] {
    const cached = this.usable.get(accountId);
    if (cached) return cached;
    const d = this.data.get(accountId);
    const out: Anchor[] = [];
    if (d && d.mode === 'ledger' && d.tx.dates.length > 0) {
      const strong = d.anchors.filter(isStrong);
      // The balance at a day's close, carried from an anchor forwards or back by the rows between.
      const closeOf = (a: Anchor, day: ISODate) => a.minor + (sumTo(d.tx, day) - sumTo(d.tx, a.date));
      for (const a of d.anchors) {
        if (a.source === 'approximate') continue;
        if (isStrong(a)) {
          out.push(a);
          continue;
        }
        const ref = out.at(-1) ?? strong.find((s) => s.date > a.date);
        if (!ref) continue;
        const dayBefore = addDays(a.date, -1);
        if (closeOf(ref, a.date) === a.minor) out.push({ date: a.date, minor: a.minor, source: a.source });
        else if (closeOf(ref, dayBefore) === a.minor && out.at(-1)?.date !== dayBefore) out.push({ date: dayBefore, minor: a.minor, source: a.source });
      }
    }
    this.usable.set(accountId, out);
    return out;
  }

  private unexplained(accountId: string, a: Anchor, b: Anchor): { from: ISODate; to: ISODate; difference: number } {
    const d = this.data.get(accountId)!;
    const expected = a.minor + (sumTo(d.tx, b.date) - sumTo(d.tx, a.date));
    return { from: a.date, to: b.date, difference: fromMinor(b.minor - expected) };
  }
}
