// The optional Trading 212 live feed: its settings, its client, readings in the work area, linking,
// cadence and failures. Synthetic values only; no request leaves the test (a fake fetch answers).

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAudited } from '../src/server/audit';
import { createApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { inMarketHours, LiveFeedService, MIN_REFRESH_GAP_MS, WATCH_HOLD_MS } from '../src/server/feeds/service';
import { last4Of, t212ConfigFromEnv, toReading, Trading212Client, type T212Config } from '../src/server/feeds/trading212';
import { AccountSchema, type Account } from '../src/shared/schema';

const KEY = 'example-key-0001';
const SECRET = 'example-secret-0001';
const ACCOUNT_NUMBER = 98765432;

const SUMMARY = {
  id: ACCOUNT_NUMBER,
  currency: 'GBP',
  totalValue: 1234.567,
  cash: { availableToTrade: 12.345, inPies: 0, reservedForOrders: 1 },
  investments: { currentValue: 1222.2, totalCost: 1100, unrealizedProfitLoss: 122.2, realizedProfitLoss: 5.5 },
};
const POSITIONS = [
  { instrument: { ticker: 'EXMPa_EQ', isin: 'GB00EXAMPLE01', name: 'Example Global Fund', currency: 'GBX' }, quantity: 10.5, currentPrice: 9876.5, averagePricePaid: 9000, walletImpact: { currency: 'GBP', currentValue: 1037.03, totalCost: 945, unrealizedProfitLoss: 92.03, fxImpact: null } },
  { instrument: { ticker: 'EXUS_US_EQ', isin: 'US00EXAMPLE2', name: 'Example US Co', currency: 'USD' }, quantity: 2, currentPrice: 120.1, walletImpact: { currency: 'GBP', currentValue: 185.17, totalCost: 155, unrealizedProfitLoss: 30.17, fxImpact: -1.234 } },
];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake Trading 212: answers by path, and remembers every request. */
function fakeT212(answer: (path: string) => Response = (p) => (p.endsWith('/summary') ? json(SUMMARY) : json(POSITIONS))) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(answer(new URL(url).pathname));
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const CFG: T212Config = { apiKey: KEY, apiSecret: SECRET, environment: 'live', watchedSeconds: 15, backgroundMinutes: 15, quietMinutes: 180 };

const account = (a: Partial<Account> & { id: string }): Account => AccountSchema.parse({ name: a.id, type: 'gia', createdAt: '2027-01-01T00:00:00Z', updatedAt: '2027-01-01T00:00:00Z', ...a });

describe('Trading 212 settings', () => {
  it('is off unless both the key and the secret are set', () => {
    expect(t212ConfigFromEnv({})).toBeUndefined();
    expect(t212ConfigFromEnv({ FINANCE_T212_API_KEY: KEY })).toBeUndefined();
    expect(t212ConfigFromEnv({ FINANCE_T212_API_SECRET: SECRET })).toBeUndefined();
    expect(loadConfig({}).trading212).toBeUndefined();
  });

  it('defaults to the live service and its cadence, and keeps the intervals in bounds', () => {
    expect(t212ConfigFromEnv({ FINANCE_T212_API_KEY: KEY, FINANCE_T212_API_SECRET: SECRET })).toEqual(CFG);
    const cfg = t212ConfigFromEnv({ FINANCE_T212_API_KEY: KEY, FINANCE_T212_API_SECRET: SECRET, FINANCE_T212_ENV: 'demo', FINANCE_T212_WATCHED_SECONDS: '1', FINANCE_T212_BACKGROUND_MINUTES: '30', FINANCE_T212_ACCOUNT: 'example-invest' })!;
    expect(cfg.environment).toBe('demo');
    expect(cfg.watchedSeconds).toBe(5);
    expect(cfg.backgroundMinutes).toBe(30);
    expect(cfg.accountId).toBe('example-invest');
    expect(() => t212ConfigFromEnv({ FINANCE_T212_API_KEY: KEY, FINANCE_T212_API_SECRET: SECRET, FINANCE_T212_ENV: 'paper' })).toThrow(/live.*demo/);
    // Given as Trading 212's account number, only its last 4 digits are kept.
    const byNumber = t212ConfigFromEnv({ FINANCE_T212_API_KEY: KEY, FINANCE_T212_API_SECRET: SECRET, FINANCE_T212_ACCOUNT: String(ACCOUNT_NUMBER) })!;
    expect(byNumber.accountLast4).toBe('5432');
    expect(byNumber.accountId).toBeUndefined();
    expect(JSON.stringify(byNumber)).not.toContain(String(ACCOUNT_NUMBER));
  });
});

describe('Trading 212 client', () => {
  it('signs in with HTTP Basic (key as user, secret as password) on the chosen service', async () => {
    const t = fakeT212();
    const client = new Trading212Client({ ...CFG, environment: 'demo' }, { fetch: t.fetch });
    await client.summary();
    expect(t.calls[0]!.url).toBe('https://demo.trading212.com/api/v0/equity/account/summary');
    expect(t.calls[0]!.auth).toBe(`Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`);
  });

  it('asks a path no more often than its documented limit', async () => {
    let now = 1_000_000;
    const t = fakeT212();
    const client = new Trading212Client(CFG, { fetch: t.fetch, now: () => now });
    await client.summary();
    await expect(client.summary()).rejects.toMatchObject({ status: 429 });
    expect(t.calls).toHaveLength(1);
    now += 5_000;
    await client.summary();
    expect(t.calls).toHaveLength(2);
  });

  it('waits for a rate limit to reset, and says when a key is refused without repeating it', async () => {
    const now = 1_700_000_000_000;
    const reset = String(now / 1000 + 42);
    const limited = new Trading212Client(CFG, { fetch: fakeT212(() => json({}, 429, { 'x-ratelimit-reset': reset })).fetch, now: () => now });
    await expect(limited.positions()).rejects.toMatchObject({ status: 429, retryAt: (now / 1000 + 42) * 1000 });
    expect(limited.readyAt('/api/v0/equity/positions')).toBe((now / 1000 + 42) * 1000);

    const refused = new Trading212Client(CFG, { fetch: fakeT212(() => json({ code: 'AuthenticationFailed' }, 401)).fetch });
    const err = await refused.summary().catch((e: Error) => e);
    expect(err).toMatchObject({ status: 401, keyRefused: true });
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('refuses an answer that is not what the API documents', async () => {
    const client = new Trading212Client(CFG, { fetch: fakeT212(() => json({ items: [] })).fetch });
    await expect(client.positions()).rejects.toThrow(/list of positions/);
  });
});

describe('a reading', () => {
  it('keeps money to 2 dp, the last 4 digits of the account number only, and holdings largest first', () => {
    const r = toReading(SUMMARY, POSITIONS, '2027-03-02T10:15:00+00:00', 'example-invest');
    expect(r.totalValue).toBe(1234.57);
    expect(r.cash).toEqual({ free: 12.35, inPies: 0, reserved: 1 });
    expect(r.accountLast4).toBe('5432');
    expect(JSON.stringify(r)).not.toContain(String(ACCOUNT_NUMBER));
    expect(r.holdings.map((h) => h.ticker)).toEqual(['EXMPa_EQ', 'EXUS_US_EQ']);
    expect(r.holdings[0]).toEqual({ ticker: 'EXMPa_EQ', isin: 'GB00EXAMPLE01', name: 'Example Global Fund', priceCurrency: 'GBX', units: 10.5, price: 9876.5, value: 1037.03, cost: 945, gain: 92.03 });
    expect(r.holdings[1]!.fxImpact).toBe(-1.23);
    expect(last4Of(undefined)).toBeUndefined();
    expect(last4Of(7)).toBeUndefined();
  });
});

describe('market hours', () => {
  it('are weekdays 07:00–22:00 in London, through the clock changes', () => {
    expect(inMarketHours(new Date('2027-03-03T12:00:00Z'))).toBe(true); // Wednesday, GMT
    expect(inMarketHours(new Date('2027-03-06T12:00:00Z'))).toBe(false); // Saturday
    expect(inMarketHours(new Date('2027-03-03T06:30:00Z'))).toBe(false); // 06:30 GMT
    expect(inMarketHours(new Date('2027-07-07T06:30:00Z'))).toBe(true); // 07:30 BST
    expect(inMarketHours(new Date('2027-07-07T21:30:00Z'))).toBe(false); // 22:30 BST
  });
});

describe('the live feed', () => {
  let dir: string;
  let now: number;
  let accounts: Account[];
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-feed-'));
    now = Date.parse('2027-03-03T12:00:00Z');
    accounts = [account({ id: 'example-invest', institutionId: 'trading-212', last4: '5432' }), account({ id: 'example-isa', institutionId: 'trading-212', type: 'stocks_isa', last4: '1111' })];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = (t = fakeT212(), cfg: T212Config | null = CFG) => {
    const client = cfg ? new Trading212Client(cfg, { fetch: t.fetch, now: () => now }) : undefined;
    return new LiveFeedService(() => accounts, dir, cfg ?? undefined, { ...(client ? { client } : {}), now: () => now });
  };

  it('is off with no key: nothing is asked and the status says it is not set up', async () => {
    const t = fakeT212();
    const feed = service(t, null);
    await feed.init();
    feed.watch();
    await feed.refresh();
    expect(t.calls).toHaveLength(0);
    expect(feed.status()).toMatchObject({ configured: false, running: false, accountId: null });
  });

  it('appends each reading to the work area, linked to the account by its last 4 digits', async () => {
    const feed = service();
    const seen: unknown[] = [];
    feed.on('reading', (r) => seen.push(r));
    await feed.init();
    await feed.refresh();
    const files = await readdir(path.join(dir, 'feeds', 'trading-212'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^2027-03\.jsonl$/);
    const lines = (await readFile(path.join(dir, 'feeds', 'trading-212', files[0]!), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ feed: 'trading-212', accountId: 'example-invest', totalValue: 1234.57 });
    expect(seen).toHaveLength(1);
    const s = feed.status();
    expect(s).toMatchObject({ configured: true, environment: 'live', accountId: 'example-invest', accountName: 'example-invest', failures: 0 });
    expect(s.linkProblem).toBeUndefined();
    expect(feed.today().points).toEqual([{ at: s.latest!.at, totalValue: 1234.57 }]);
  });

  it('says why a reading is not linked, and FINANCE_T212_ACCOUNT names the account outright', async () => {
    accounts = [account({ id: 'example-invest', institutionId: 'trading-212', last4: '0000' })];
    const feed = service();
    await feed.refresh();
    expect(feed.status()).toMatchObject({ accountId: null });
    expect(feed.status().linkProblem).toMatch(/ends in 5432/);
    // Trading 212's account number in FINANCE_T212_ACCOUNT picks the account with its last 4 digits…
    accounts = [account({ id: 'example-invest', institutionId: 'trading-212', last4: '5432' })];
    const byNumber = service(fakeT212(), { ...CFG, accountLast4: '5432' });
    await byNumber.refresh();
    expect(byNumber.status()).toMatchObject({ accountId: 'example-invest' });
    // …and says so when the key reads another account.
    const other = service(fakeT212(), { ...CFG, accountLast4: '7777' });
    await other.refresh();
    expect(other.status()).toMatchObject({ accountId: null });
    expect(other.status().linkProblem).toMatch(/ending 5432.*ending 7777/);
    accounts = [account({ id: 'example-invest', institutionId: 'trading-212', last4: '0000' })];
    const named = service(fakeT212(), { ...CFG, accountId: 'example-invest' });
    await named.refresh();
    expect(named.status()).toMatchObject({ accountId: 'example-invest' });
    expect(named.status().linkProblem).toBeUndefined();
  });

  it('reads at once when the app is opened and the latest reading is stale, but not again within seconds', async () => {
    const t = fakeT212();
    const feed = service(t);
    await feed.init();
    feed.watch();
    await new Promise((r) => setImmediate(r));
    await feed.refresh(); // waits for the one under way, or is too soon
    expect(t.calls).toHaveLength(2); // summary + positions
    expect(feed.status().watched).toBe(true);
    now += 3_000;
    feed.watch();
    await feed.refresh();
    expect(t.calls).toHaveLength(2);
    now += MIN_REFRESH_GAP_MS + 3_000; // past the refresh gap and the summary's limit
    await feed.refresh();
    expect(t.calls).toHaveLength(4);
    now += WATCH_HOLD_MS;
    expect(feed.status().watched).toBe(false);
  });

  it('keeps the last error, backs off after failures, and does not count a rate limit as one', async () => {
    let answer: (p: string) => Response = () => json({}, 500);
    const t = fakeT212((p) => answer(p));
    const changes: boolean[] = [];
    const client = new Trading212Client(CFG, { fetch: t.fetch, now: () => now });
    const feed = new LiveFeedService(() => accounts, dir, CFG, { client, now: () => now, onStateChange: (c) => changes.push(c.ok) });
    await feed.refresh();
    expect(feed.status().failures).toBe(1);
    expect(feed.status().lastError).toMatch(/answered 500/);
    now += 60_000; // inside the back-off (at least 15 min in market hours)
    await feed.refresh();
    expect(t.calls).toHaveLength(1);
    now += 15 * 60_000;
    answer = (p) => (p.endsWith('/summary') ? json(SUMMARY) : json(POSITIONS));
    await feed.refresh();
    expect(feed.status()).toMatchObject({ failures: 0 });
    expect(feed.status().lastError).toBeUndefined();
    expect(changes).toEqual([false, true]);

    now += 60_000;
    answer = () => json({}, 429, { 'x-ratelimit-reset': String(Math.floor(now / 1000) + 30) });
    await feed.refresh();
    expect(feed.status().failures).toBe(0);
  });

  it('picks up the latest reading and today’s from the work area after a restart', async () => {
    const first = service();
    await first.refresh();
    const again = service(fakeT212());
    await again.init();
    expect(again.status().latest?.totalValue).toBe(1234.57);
    expect(again.today().points).toHaveLength(1);
    // A line cut short by a crash is skipped.
    const file = path.join(dir, 'feeds', 'trading-212', '2027-03.jsonl');
    await writeFile(file, `${await readFile(file, 'utf8')}{"feed":"trading-2`);
    const third = service(fakeT212());
    await third.init();
    expect(third.today().points).toHaveLength(1);
  });
});

describe('the feed through the API', () => {
  it('without a key: listed as not set up, its actions 404, and "the app is open" is never audited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-feed-api-'));
    try {
      await mkdir(path.join(dir, 'data'), { recursive: true });
      const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
      config.webDist = path.join(dir, 'no-web');
      const app = await createApp(config, { version: 'test', env: {}, inbox: false });
      try {
        const res = await app.app.request('/api/feeds', { headers: { host: '127.0.0.1' } });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ feeds: [{ id: 'trading-212', configured: false }] });
        const watch = await app.app.request('/api/feeds/trading-212/watch', { method: 'POST', headers: { host: '127.0.0.1', 'x-finance-csrf': '1' } });
        expect(watch.status).toBe(404);
        expect(isAudited('POST', '/api/feeds/trading-212/watch')).toBe(false);
        expect(isAudited('POST', '/api/feeds/trading-212/refresh')).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
