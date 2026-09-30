// The balance engine: what was each account worth on any given day?
//
// Ledger accounts (bank, savings, cards, loans, cash ISAs): known balances are anchors (statement
// or screenshot snapshots, and running balances printed next to transactions). Between anchors the
// balance moves exactly with transactions: balance(D) = anchor + Σ transactions in (anchor, D].
// Before the first anchor it is rolled back from the next one. With no anchors at all it is the
// running sum of transactions, flagged as estimated.
//
// Market accounts (investments, pensions, property): valuations are anchors and only money moving
// in or out from outside (contributions, withdrawals, bonus, relief) is added between them. Before
// the first valuation, value is estimated: from contributions plus growth accrued linearly when the
// data goes back to the account's start, else rolled back by the money that arrived since.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { diffDays, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Settings } from '../../shared/schema';
import type { Store } from '../store';

interface Anchor {
  date: ISODate;
  minor: number;
  /**
   * Screenshot balances may be taken mid-day, so they are weaker evidence for gap checks. An
   * approximate figure you gave is weaker still: it only stands in for what is newer than your data.
   */
  source: 'snapshot' | 'running' | 'screenshot' | 'approximate';
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
}

function buildSeries(items: { date: ISODate; amount: number }[]): Series {
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

function firstAnchorAfter(anchors: Anchor[], d: ISODate): Anchor | undefined {
  return anchors.find((a) => a.date > d);
}

export function fxRate(currency: string, settings: Settings): number | null {
  if (currency === 'GBP') return 1;
  return settings.fx[currency] ?? null;
}

export class BalanceEngine {
  private readonly data = new Map<string, AccountData>();

  constructor(store: Store) {
    for (const account of store.accounts) {
      const mode = balanceModeOf(account);
      const txs = store.transactions(account.id);
      const snaps = store.balances(account.id);
      const anchors = new Map<ISODate, Anchor>();
      if (mode === 'ledger') {
        // End-of-day running balances: the last transaction of a day that carries a balance.
        for (let i = 0; i < txs.length; i++) {
          const t = txs[i]!;
          const next = txs[i + 1];
          if (t.balanceAfter !== undefined && (!next || next.date !== t.date)) {
            anchors.set(t.date, { date: t.date, minor: toMinor(t.balanceAfter), source: 'running' });
          }
        }
      }
      // An approximate figure you gave stands in only for what is newer than all of the account's
      // real data (docs/FORMULAS.md §9); it never counts as data for staleness or gap checks.
      const real = snaps.filter((s) => !s.approximate);
      const lastReal = [txs[txs.length - 1]?.date, real[real.length - 1]?.date].filter(Boolean).sort().reverse()[0];
      const placeholders = snaps.filter((s) => s.approximate && (!lastReal || s.date > lastReal));
      for (const s of real) anchors.set(s.date, { date: s.date, minor: toMinor(s.balance), source: s.kind === 'screenshot' ? 'screenshot' : 'snapshot' });
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
        tx: buildSeries(txs),
        flows: buildSeries(flows),
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
    if (d.mode === 'ledger') {
      const a1 = lastAnchorOnOrBefore(d.anchors, date);
      if (a1) {
        minor = a1.minor + (sumTo(d.tx, date) - sumTo(d.tx, a1.date));
        estimated = a1.source === 'approximate';
      } else {
        const a2 = firstAnchorAfter(d.anchors, date);
        if (a2) {
          minor = a2.minor - (sumTo(d.tx, a2.date) - sumTo(d.tx, date));
          estimated = a2.source === 'approximate';
        } else {
          minor = sumTo(d.tx, date);
          estimated = true;
        }
      }
    } else {
      const a1 = lastAnchorOnOrBefore(d.anchors, date);
      if (a1) {
        minor = a1.minor + (sumTo(d.flows, date) - sumTo(d.flows, a1.date));
        estimated = a1.source === 'approximate';
      } else {
        const contributed = sumTo(d.flows, date);
        const a2 = firstAnchorAfter(d.anchors, date);
        estimated = true;
        if (a2 && (diffDays(date, a2.date) <= 45 || !d.fromStart)) {
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
    return { value, gbp: d.fx === null ? null : fromMinor(Math.round(minor * d.fx)), estimated };
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
   */
  gaps(accountId: string): { from: ISODate; to: ISODate; difference: number }[] {
    const d = this.data.get(accountId);
    if (!d || d.mode !== 'ledger' || d.tx.dates.length === 0) return [];
    const out: { from: ISODate; to: ISODate; difference: number }[] = [];
    const strong = d.anchors.filter((a) => a.source !== 'screenshot' && a.source !== 'approximate');
    for (let i = 1; i < strong.length; i++) {
      const a = strong[i - 1]!;
      const b = strong[i]!;
      const expected = a.minor + (sumTo(d.tx, b.date) - sumTo(d.tx, a.date));
      if (expected !== b.minor) out.push({ from: a.date, to: b.date, difference: fromMinor(b.minor - expected) });
    }
    return out;
  }
}
