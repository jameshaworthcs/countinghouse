// Trading 212's public API (https://docs.trading212.com/api), read-only use: an Invest or Stocks ISA
// account's summary and its open positions. Optional: it runs only when the owner sets a key
// (FINANCE_T212_API_KEY and FINANCE_T212_API_SECRET in .env). The key and secret go to Trading 212
// as HTTP Basic auth and nowhere else; they are never logged, and nothing of the owner's is sent.
//
// Rate limits are per account, whichever key asks (summary 1 per 5s, positions 1 per 1s). Each
// response says how many are left and when they reset; a path is not asked again before then.

import { z } from 'zod';
import { roundMoney } from '../../shared/money';
import type { FeedHolding, FeedReading } from '../../shared/feeds';

export const T212_BASE_URLS = { live: 'https://live.trading212.com', demo: 'https://demo.trading212.com' } as const;
export type T212Environment = keyof typeof T212_BASE_URLS;

export interface T212Config {
  apiKey: string;
  apiSecret: string;
  environment: T212Environment;
  /** The app's account readings belong to (FINANCE_T212_ACCOUNT given as an account id). */
  accountId?: string;
  /**
   * FINANCE_T212_ACCOUNT given as Trading 212's account number instead: only its last 4 digits are
   * kept, and they pick the app's Trading 212 account with those digits.
   */
  accountLast4?: string;
  watchedSeconds: number;
  backgroundMinutes: number;
  quietMinutes: number;
}

/** The fewest seconds between two requests to each path, as the API documents them. */
const MIN_GAP_MS: Record<string, number> = {
  '/api/v0/equity/account/summary': 5_000,
  '/api/v0/equity/positions': 1_000,
};

const num = z.number().finite();

const SummarySchema = z.object({
  id: z.number().int().optional(),
  currency: z.string().min(3).max(3),
  totalValue: num,
  cash: z.object({ availableToTrade: num.default(0), inPies: num.default(0), reservedForOrders: num.default(0) }).default({ availableToTrade: 0, inPies: 0, reservedForOrders: 0 }),
  investments: z.object({ currentValue: num.default(0), totalCost: num.default(0), unrealizedProfitLoss: num.default(0), realizedProfitLoss: num.default(0) }).default({ currentValue: 0, totalCost: 0, unrealizedProfitLoss: 0, realizedProfitLoss: 0 }),
});

const PositionSchema = z.object({
  instrument: z.object({ ticker: z.string().min(1), isin: z.string().optional(), name: z.string().optional(), currency: z.string().optional() }),
  quantity: num,
  currentPrice: num,
  walletImpact: z.object({ currentValue: num, totalCost: num.default(0), unrealizedProfitLoss: num.default(0), fxImpact: num.nullable().optional() }),
});

export type T212Summary = z.infer<typeof SummarySchema>;
export type T212Position = z.infer<typeof PositionSchema>;

/** A request Trading 212 refused or could not answer, in words fit for Settings (never the key). */
export class T212Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** When asking again is allowed (ms since the epoch), when the API said. */
    readonly retryAt?: number,
  ) {
    super(message);
  }
  /** The key itself was refused: asking again soon will not help. */
  get keyRefused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface T212ClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class Trading212Client {
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** Per path: no request before this moment. */
  private readonly notBefore = new Map<string, number>();

  constructor(
    private readonly cfg: Pick<T212Config, 'apiKey' | 'apiSecret' | 'environment'>,
    opts: T212ClientOptions = {},
  ) {
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get baseUrl(): string {
    return T212_BASE_URLS[this.cfg.environment];
  }

  /** When a request to this path may next be made (ms since the epoch; 0 for now). */
  readyAt(path: string): number {
    return this.notBefore.get(path) ?? 0;
  }

  async summary(): Promise<T212Summary> {
    return SummarySchema.parse(await this.get('/api/v0/equity/account/summary'));
  }

  async positions(): Promise<T212Position[]> {
    const body = await this.get('/api/v0/equity/positions');
    if (!Array.isArray(body)) throw new T212Error('Trading 212 answered with something other than a list of positions.');
    return body.map((p) => PositionSchema.parse(p));
  }

  private async get(path: string): Promise<unknown> {
    const now = this.now();
    const ready = this.readyAt(path);
    if (ready > now) throw new T212Error(`Waiting for Trading 212's rate limit (${Math.ceil((ready - now) / 1000)}s).`, 429, ready);
    this.notBefore.set(path, now + (MIN_GAP_MS[path] ?? 1_000));
    const auth = Buffer.from(`${this.cfg.apiKey}:${this.cfg.apiSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const e = err as Error;
      throw new T212Error(e.name === 'TimeoutError' ? `Trading 212 did not answer within ${this.timeoutMs / 1000}s.` : `Could not reach Trading 212 (${e.message}).`);
    }
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    if (res.headers.has('x-ratelimit-remaining') && remaining <= 0 && reset > this.now()) this.notBefore.set(path, Math.max(this.readyAt(path), reset));
    if (res.status === 429) {
      const until = reset > this.now() ? reset : this.now() + 60_000;
      this.notBefore.set(path, Math.max(this.readyAt(path), until));
      throw new T212Error('Trading 212 says too many requests: waiting for its rate limit to reset.', 429, until);
    }
    if (res.status === 401) throw new T212Error('Trading 212 refused the API key: check FINANCE_T212_API_KEY and FINANCE_T212_API_SECRET, and that the key has not been revoked.', 401);
    if (res.status === 403) throw new T212Error('Trading 212 refused the request: give the key the “Account data” and “Portfolio” permissions, and check its IP restriction allows this server.', 403);
    if (!res.ok) throw new T212Error(`Trading 212 answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`, res.status);
    try {
      return await res.json();
    } catch {
      throw new T212Error('Trading 212 answered with something that is not JSON.', res.status);
    }
  }
}

/** The last 4 digits of the account number Trading 212 gives, the only part ever kept. */
export function last4Of(id: number | undefined): string | undefined {
  if (id === undefined) return undefined;
  const digits = String(Math.abs(Math.trunc(id)));
  return digits.length >= 2 ? digits.slice(-4) : undefined;
}

/** A summary and its positions as one reading. Money to 2 dp; prices and units as given. */
export function toReading(summary: T212Summary, positions: T212Position[], at: string, accountId: string | null): FeedReading {
  const last4 = last4Of(summary.id);
  const holdings: FeedHolding[] = positions
    .map((p) => {
      const h: FeedHolding = {
        ticker: p.instrument.ticker,
        units: p.quantity,
        price: p.currentPrice,
        value: roundMoney(p.walletImpact.currentValue),
        cost: roundMoney(p.walletImpact.totalCost),
        gain: roundMoney(p.walletImpact.unrealizedProfitLoss),
      };
      if (p.instrument.isin) h.isin = p.instrument.isin;
      if (p.instrument.name) h.name = p.instrument.name;
      if (p.instrument.currency) h.priceCurrency = p.instrument.currency;
      if (typeof p.walletImpact.fxImpact === 'number') h.fxImpact = roundMoney(p.walletImpact.fxImpact);
      return h;
    })
    .sort((a, b) => b.value - a.value || a.ticker.localeCompare(b.ticker));
  return {
    feed: 'trading-212',
    at,
    accountId,
    ...(last4 ? { accountLast4: last4 } : {}),
    currency: summary.currency,
    totalValue: roundMoney(summary.totalValue),
    cash: { free: roundMoney(summary.cash.availableToTrade), inPies: roundMoney(summary.cash.inPies), reserved: roundMoney(summary.cash.reservedForOrders) },
    investments: {
      value: roundMoney(summary.investments.currentValue),
      cost: roundMoney(summary.investments.totalCost),
      unrealisedGain: roundMoney(summary.investments.unrealizedProfitLoss),
      realisedGain: roundMoney(summary.investments.realizedProfitLoss),
    },
    holdings,
  };
}

const intOr = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * The feed's settings from the environment: none unless both the key and the secret are set (the
 * feed is optional). FINANCE_T212_ENV=demo uses the practice-money service, for trying it out.
 */
export function t212ConfigFromEnv(env: NodeJS.ProcessEnv): T212Config | undefined {
  const apiKey = env.FINANCE_T212_API_KEY?.trim();
  const apiSecret = env.FINANCE_T212_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return undefined;
  const environment = env.FINANCE_T212_ENV?.trim().toLowerCase();
  if (environment && environment !== 'live' && environment !== 'demo') throw new Error(`FINANCE_T212_ENV must be "live" or "demo", not "${environment}".`);
  const cfg: T212Config = {
    apiKey,
    apiSecret,
    environment: environment === 'demo' ? 'demo' : 'live',
    watchedSeconds: intOr(env.FINANCE_T212_WATCHED_SECONDS, 15, 5, 600),
    backgroundMinutes: intOr(env.FINANCE_T212_BACKGROUND_MINUTES, 15, 1, 24 * 60),
    quietMinutes: intOr(env.FINANCE_T212_QUIET_MINUTES, 180, 5, 24 * 60),
  };
  const account = env.FINANCE_T212_ACCOUNT?.trim();
  const digits = account?.replace(/[\s-]/g, '');
  if (digits && /^\d{4,}$/.test(digits)) cfg.accountLast4 = digits.slice(-4);
  else if (account) cfg.accountId = account;
  return cfg;
}
