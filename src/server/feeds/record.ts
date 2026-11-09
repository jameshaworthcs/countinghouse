// Readings of a live feed recorded as valuations (docs/FORMULAS.md §9, "Live readings"): about one
// an hour in market hours, plus the close, each with the moment it was read (`at`), and the day's
// holdings. They are written straight to data/ and committed without review: the owner's stated
// exception to "imports are drafts" (docs/DECISIONS.md, 2026-11-09), since they are the provider's
// own figures from its API, not a reading of a document. A reading that fails the checks is never
// recorded.

import { sumMoney, toMinor } from '../../shared/money';
import type { FeedReading } from '../../shared/feeds';
import type { BalanceSnapshot, Holding, HoldingsSnapshot } from '../../shared/schema';
import { balanceId, holdingsId } from '../ids';
import { inMarketHours, londonClock } from './clock';

/** The rules, named. */
export const RECORD_RULES = {
  /** A reading is recorded when the last recorded one is at least this old, in market hours. */
  hourlyMs: 55 * 60_000,
  /** From this hour (UK time, weekdays) the first reading is the day's close. */
  closeHour: 21,
  /** A reading moving more than this share of the value, beyond the money moved, is held back… */
  jumpShare: 0.1,
  /** …and more than this many pounds. */
  jumpPounds: 100,
  /** A held-back reading is confirmed by the next one within this share of it. */
  confirmShare: 0.01,
} as const;

/**
 * Whether a reading can be believed (FORMULAS.md §9, "Live readings"), against the last one that
 * could (`good`) and the last held back (`held`):
 *   - a value of nothing, when there was something;
 *   - investments with no holdings;
 *   - a move of more than 10% of the value (and £100), beyond the money paid in or out between —
 *     unless the reading held back before it said the same (within 1%): the move was real.
 */
export function checkReading(r: FeedReading, good: FeedReading | undefined, held: FeedReading | undefined): { ok: boolean; reason?: string } {
  if (r.totalValue <= 0 && (good?.totalValue ?? 0) > 0) return { ok: false, reason: 'Trading 212 gave a value of nothing' };
  if (r.investments.value > 1 && r.holdings.length === 0) return { ok: false, reason: 'Trading 212 gave investments but no holdings' };
  if (!good) return { ok: true };
  const paidBetween = r.contributions !== undefined && good.contributions !== undefined ? toMinor(r.contributions) - toMinor(good.contributions) : 0;
  const moved = toMinor(r.totalValue) - toMinor(good.totalValue) - paidBetween;
  const limit = Math.max(toMinor(RECORD_RULES.jumpPounds), Math.abs(toMinor(good.totalValue)) * RECORD_RULES.jumpShare);
  if (Math.abs(moved) <= limit) return { ok: true };
  if (held && Math.abs(toMinor(r.totalValue) - toMinor(held.totalValue)) <= Math.max(100, Math.abs(toMinor(held.totalValue)) * RECORD_RULES.confirmShare)) return { ok: true };
  const pct = good.totalValue ? Math.round((Math.abs(moved) / Math.abs(toMinor(good.totalValue))) * 100) : 100;
  return { ok: false, reason: `The value moved ${pct}% since the last reading with no money paid in or out to explain it` };
}

/** The account's latest recorded feed valuation. */
export function lastRecorded(balances: readonly BalanceSnapshot[]): BalanceSnapshot | undefined {
  return balances.filter((b) => b.kind === 'feed' && b.at).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!)).pop();
}

/**
 * Whether a reading that passed its checks is due to be recorded, and why (FORMULAS.md §9):
 *   - the first of its day, unless nothing changed since the last one recorded (a weekend);
 *   - the first from 21:00 UK time on a weekday: the close;
 *   - in market hours, when the last recorded is 55 minutes old or more.
 */
export function dueToRecord(r: FeedReading, last: BalanceSnapshot | undefined): { due: boolean; why: string } {
  if (!r.check?.ok || !r.accountId) return { due: false, why: 'not a reading that counts' };
  const date = r.at.slice(0, 10);
  const same = last !== undefined && toMinor(last.balance) === toMinor(r.totalValue) && (last.contributions ?? null) === (r.contributions ?? null);
  if (!last || last.date !== date) return same ? { due: false, why: 'unchanged since the last recorded' } : { due: true, why: 'first of the day' };
  if (same) return { due: false, why: 'unchanged since the last recorded' };
  const now = londonClock(r.at);
  if (now.weekday && now.hour >= RECORD_RULES.closeHour && londonClock(last.at!).hour < RECORD_RULES.closeHour) return { due: true, why: 'the close' };
  if (inMarketHours(new Date(r.at)) && Date.parse(r.at) - Date.parse(last.at!) >= RECORD_RULES.hourlyMs) return { due: true, why: 'hourly' };
  return { due: false, why: 'recorded within the hour' };
}

/** A reading as a valuation: the account's whole value at the moment it was read. */
export function toBalance(r: FeedReading & { accountId: string }): BalanceSnapshot {
  const date = r.at.slice(0, 10);
  const b: BalanceSnapshot = {
    id: balanceId(r.accountId, date, r.totalValue, 'feed', r.at),
    accountId: r.accountId,
    date,
    balance: r.totalValue,
    currency: r.currency,
    kind: 'feed',
    dateSource: 'feed',
    at: r.at,
    cash: sumMoney([r.cash.free, r.cash.inPies, r.cash.reserved]),
    source: { feed: r.feed },
    createdAt: r.at,
  };
  if (r.contributions !== undefined) b.contributions = r.contributions;
  return b;
}

/**
 * A reading's holdings as the day's snapshot. Prices are kept in the account's currency: a price in
 * pence (GBX) as pounds, one in another currency left out (its value is still the account's).
 */
export function toHoldings(r: FeedReading & { accountId: string }): HoldingsSnapshot {
  const date = r.at.slice(0, 10);
  const holdings: Holding[] = r.holdings.map((h) => {
    const out: Holding = { name: h.name ?? h.ticker, ticker: h.ticker, units: h.units, value: h.value, currency: r.currency, costBasis: h.cost, gain: h.gain };
    if (h.isin) out.isin = h.isin;
    if (h.priceCurrency === r.currency) out.price = h.price;
    else if (h.priceCurrency === 'GBX' && r.currency === 'GBP') out.price = h.price / 100;
    return out;
  });
  return {
    id: holdingsId(r.accountId, date, r.totalValue, r.at),
    accountId: r.accountId,
    date,
    holdings,
    cash: sumMoney([r.cash.free, r.cash.inPies, r.cash.reserved]),
    totalValue: r.totalValue,
    source: { feed: r.feed },
    createdAt: r.at,
  };
}

/** What recording needs from the store. */
export interface RecordingStore {
  balances(accountId: string): BalanceSnapshot[];
  holdings(accountId: string): HoldingsSnapshot[];
  addBalances(snaps: BalanceSnapshot[], message: string): Promise<number>;
  addHoldings(snaps: HoldingsSnapshot[], message: string, replaces?: string[]): Promise<number>;
}

/**
 * Record a reading when it is due: its valuation, and its holdings as the day's snapshot (replacing
 * the feed's earlier one that day; a day that has a document's snapshot keeps it, and gets none).
 */
export async function recordIfDue(store: RecordingStore, r: FeedReading): Promise<{ recorded: boolean; why: string }> {
  if (!r.accountId) return { recorded: false, why: 'not linked to an account' };
  const reading = r as FeedReading & { accountId: string };
  const decision = dueToRecord(reading, lastRecorded(store.balances(reading.accountId)));
  if (!decision.due) return { recorded: false, why: decision.why };
  const time = reading.at.slice(11, 16);
  await store.addBalances([toBalance(reading)], `Trading 212 feed: valuation at ${time} (${decision.why})`);
  const date = reading.at.slice(0, 10);
  const today = store.holdings(reading.accountId).filter((h) => h.date === date);
  if (today.every((h) => h.source.feed === reading.feed)) {
    await store.addHoldings([toHoldings(reading)], `Trading 212 feed: holdings at ${time}`, today.map((h) => h.id));
  }
  return { recorded: true, why: decision.why };
}
