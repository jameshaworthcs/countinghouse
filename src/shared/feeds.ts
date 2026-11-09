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
