// When a live reading stands for an account's value today (docs/FORMULAS.md §9, "Live readings").
// Pages that show today's figures (the Overview's estate value, the account's own page, the
// Accounts list, Investments) use it in place of the recorded value; past days, charts, agents
// and Ask keep the recorded values.

import type { FeedReading } from '../../shared/feeds';
import type { Account, BalanceSnapshot } from '../../shared/schema';
import { nowISO } from '../fsutil';

/** A reading older than this no longer stands for today's value. */
export const LIVE_FRESH_MS = 60 * 60_000;

/** Today's value of one account, from its live reading. */
export interface LiveOverride {
  accountId: string;
  /** In the account's currency (the reading's). */
  value: number;
  /** When it was read. */
  at: string;
  /** Paid in to date, net, as the provider's cash movements give it (when read). */
  contributions?: number;
  /** The feed's name, for the label. */
  feed: string;
}

/**
 * The live reading as today's value of its account, when it may stand for it:
 *   - it passed its checks and is linked to an open account in the same currency, GBP;
 *   - it was read today and within the hour;
 *   - it is newer than the account's latest recorded balance (a close recorded today, with no
 *     time, is the latest of its day and wins).
 */
export function liveOverride(reading: FeedReading | undefined, account: Account | undefined, balances: readonly BalanceSnapshot[], now: Date): LiveOverride | undefined {
  if (!reading || !account || !reading.check?.ok || reading.accountId !== account.id) return undefined;
  if (account.status !== 'open' || reading.currency !== account.currency || account.currency !== 'GBP') return undefined;
  const readAt = Date.parse(reading.at);
  if (!Number.isFinite(readAt) || now.getTime() - readAt > LIVE_FRESH_MS || readAt > now.getTime() + 60_000) return undefined;
  if (reading.at.slice(0, 10) !== nowISO(now).slice(0, 10)) return undefined;
  const today = reading.at.slice(0, 10);
  for (const b of balances) {
    if (b.approximate) continue;
    if (b.date > today) return undefined;
    if (b.date === today && (!b.at || Date.parse(b.at) > readAt)) return undefined;
  }
  return {
    accountId: account.id,
    value: reading.totalValue,
    at: reading.at,
    feed: 'Trading 212',
    ...(reading.contributions !== undefined ? { contributions: reading.contributions } : {}),
  };
}
