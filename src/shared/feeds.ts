// Live feeds: an optional connection to a provider's own API that reads an account's value and
// holdings far more often than statements do (docs/ARCHITECTURE.md, "Live feeds"). Trading 212 is
// the only one. Readings are kept in the work area, never in data/, so the app runs the same with
// no feed set up.

export const FEED_IDS = ['trading-212'] as const;
export type FeedId = (typeof FEED_IDS)[number];

/** One holding as a reading gives it. Money in the account's currency; `price` in the instrument's. */
export interface FeedHolding {
  ticker: string;
  isin?: string;
  name?: string;
  units: number;
  price: number;
  priceCurrency?: string;
  value: number;
  cost: number;
  gain: number;
  /** What currency moves added to or took from its value (account currency), when it is priced in another. */
  fxImpact?: number;
}

/** What the provider said the account held at one moment. */
export interface FeedReading {
  feed: FeedId;
  /** When it was read: ISO 8601 with offset. */
  at: string;
  /** The app's account it was linked to when read (null: not linked). */
  accountId: string | null;
  /** The last 4 digits of the provider's account number; never the whole number. */
  accountLast4?: string;
  currency: string;
  /** The account's whole value: investments and cash. */
  totalValue: number;
  cash: { free: number; inPies: number; reserved: number };
  investments: { value: number; cost: number; unrealisedGain: number; realisedGain: number };
  holdings: FeedHolding[];
  /**
   * Money paid in to date, net of withdrawals, from the provider's list of cash movements (its
   * deposits, withdrawals and transfers; a deposit your imports file as income, such as a
   * promotion, left out). Absent until that list has been read in full.
   */
  contributions?: number;
  /** The checks a reading passes before it counts (docs/FORMULAS.md §9, "Live readings"). */
  check?: { ok: boolean; reason?: string };
}

/** A feed's state, for Settings and the pages that show its latest reading (GET /api/feeds). */
export interface FeedStatus {
  id: FeedId;
  name: string;
  /** Its key is set (in .env). A feed is optional: unset, nothing about it runs. */
  configured: boolean;
  /** The provider's real-money service, or its practice-money one. */
  environment?: 'live' | 'demo';
  /** Taking readings by itself (a serving instance with the key set). */
  running: boolean;
  accountId: string | null;
  accountName?: string;
  /** Why readings are not linked to an account, when they are not. */
  linkProblem?: string;
  latest?: FeedReading;
  lastAttemptAt?: string;
  lastError?: string;
  /** Failures in a row. */
  failures: number;
  /** Someone has the app open: readings come every `watchedSeconds`. */
  watched: boolean;
  nextAt?: string;
  intervals: { watchedSeconds: number; backgroundMinutes: number; quietMinutes: number };
  /** The latest reading held back by the checks, and why. */
  heldBack?: { at: string; reason: string };
  /** The latest reading recorded as a valuation, and why it was due (when recorded since the app started). */
  lastRecorded?: { at: string; why?: string };
  /** Why the latest attempt to record a reading failed. */
  recordError?: string;
  /** The provider's cash movements as last read: how many, and when. */
  cashMovements?: { count: number; readAt: string; complete: boolean };
  /** Why the latest attempt to read the cash movements failed (the readings go on without it). */
  cashError?: string;
}

export interface FeedsResponse {
  feeds: FeedStatus[];
}

/** GET /api/feeds/:id/today: today's readings, oldest first (value and time only). */
export interface FeedTodayResponse {
  id: FeedId;
  date: string;
  points: { at: string; totalValue: number }[];
}
