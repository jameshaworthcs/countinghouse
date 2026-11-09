// The live feed's readings as figures: the checks a reading passes, when one is recorded as a
// valuation (and its holdings), money paid in from the cash movements, and when a reading stands for
// an account's value today in the estate, the account and Investments (docs/FORMULAS.md §9, "Live
// readings"). Synthetic values only.

import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { CashMovementsBook, paidIn } from '../src/server/feeds/cash';
import { LIVE_FRESH_MS, liveOverride, type LiveOverride } from '../src/server/feeds/live';
import { checkReading, dueToRecord, lastRecorded, recordIfDue, toBalance, toHoldings } from '../src/server/feeds/record';
import { nowISO } from '../src/server/fsutil';
import { balanceId } from '../src/server/ids';
import { accountSummary, estateOn } from '../src/server/analytics/estate';
import { investments } from '../src/server/analytics/investments';
import { addDays } from '../src/shared/dates';
import type { FeedReading } from '../src/shared/feeds';
import { AccountSchema, type Account, type BalanceSnapshot, type Transaction } from '../src/shared/schema';

const T0 = '2027-03-03T12:00:00+00:00'; // a Wednesday, GMT

function reading(over: Partial<FeedReading> = {}): FeedReading {
  return {
    feed: 'trading-212',
    at: T0,
    accountId: 'example-invest',
    accountLast4: '5432',
    currency: 'GBP',
    totalValue: 1000,
    cash: { free: 10, inPies: 0, reserved: 0 },
    investments: { value: 990, cost: 900, unrealisedGain: 90, realisedGain: 0 },
    holdings: [{ ticker: 'EXMPa_EQ', isin: 'GB00EXAMPLE01', name: 'Example Global Fund', units: 10, price: 9900, priceCurrency: 'GBX', value: 990, cost: 900, gain: 90 }],
    contributions: 900,
    check: { ok: true },
    ...over,
  };
}

const at = (iso: string) => ({ at: iso });
const account = (a: Partial<Account> & { id: string }): Account => AccountSchema.parse({ name: a.id, type: 'gia', institutionId: 'trading-212', createdAt: '2027-01-01T00:00:00Z', updatedAt: '2027-01-01T00:00:00Z', ...a });

describe('checks on a reading', () => {
  it('passes the first, and an ordinary move', () => {
    expect(checkReading(reading(), undefined, undefined)).toEqual({ ok: true });
    expect(checkReading(reading({ totalValue: 1050 }), reading(), undefined)).toEqual({ ok: true });
  });

  it('holds back a value of nothing, and investments with no holdings', () => {
    expect(checkReading(reading({ totalValue: 0 }), reading(), undefined).ok).toBe(false);
    const empty = checkReading(reading({ holdings: [] }), reading(), undefined);
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/no holdings/);
  });

  it('holds back a jump that no money paid in explains, until the next reading agrees with it', () => {
    const jump = reading({ totalValue: 1500 });
    const held = checkReading(jump, reading(), undefined);
    expect(held.ok).toBe(false);
    expect(held.reason).toMatch(/50%/);
    // Money paid in between explains it.
    expect(checkReading(reading({ totalValue: 1500, contributions: 1400 }), reading(), undefined).ok).toBe(true);
    // The next reading saying the same confirms it; one back at the old level passes against the good one.
    expect(checkReading(reading({ totalValue: 1500 }), reading(), jump).ok).toBe(true);
    expect(checkReading(reading({ totalValue: 1050 }), reading(), jump).ok).toBe(true);
  });

  it('allows small accounts to move by up to £100', () => {
    const small = reading({ totalValue: 200, investments: { value: 190, cost: 180, unrealisedGain: 10, realisedGain: 0 } });
    expect(checkReading(reading({ totalValue: 290 }), small, undefined).ok).toBe(true);
  });
});

describe('when a reading is recorded', () => {
  const recorded = (r: FeedReading) => toBalance(r as FeedReading & { accountId: string });

  it('records the first of a day, unless nothing changed since the last', () => {
    expect(dueToRecord(reading(), undefined)).toEqual({ due: true, why: 'first of the day' });
    const friday = recorded(reading({ at: '2027-03-05T21:30:00+00:00' }));
    expect(dueToRecord(reading({ at: '2027-03-06T10:00:00+00:00' }), friday)).toMatchObject({ due: false, why: 'unchanged since the last recorded' });
    expect(dueToRecord(reading({ at: '2027-03-06T10:00:00+00:00', totalValue: 1050 }), friday).due).toBe(true);
  });

  it('then about hourly in market hours, and the close from 21:00 UK time', () => {
    const last = recorded(reading());
    expect(dueToRecord(reading({ ...at('2027-03-03T12:30:00+00:00'), totalValue: 1050 }), last)).toMatchObject({ due: false });
    expect(dueToRecord(reading({ ...at('2027-03-03T12:55:00+00:00'), totalValue: 1050 }), last)).toEqual({ due: true, why: 'hourly' });
    const evening = recorded(reading({ at: '2027-03-03T20:50:00+00:00' }));
    expect(dueToRecord(reading({ ...at('2027-03-03T21:05:00+00:00'), totalValue: 1050 }), evening)).toEqual({ due: true, why: 'the close' });
    const closed = recorded(reading({ at: '2027-03-03T21:05:00+00:00' }));
    expect(dueToRecord(reading({ ...at('2027-03-03T23:30:00+00:00'), totalValue: 1100 }), closed).due).toBe(false);
    // In British Summer Time the close is 21:00 BST (20:00 UTC).
    const summer = recorded(reading({ at: '2027-07-07T19:30:00+00:00' }));
    expect(dueToRecord(reading({ ...at('2027-07-07T20:05:00+00:00'), totalValue: 1050 }), summer)).toEqual({ due: true, why: 'the close' });
  });

  it('never records a reading held back, or one not linked to an account', () => {
    expect(dueToRecord(reading({ check: { ok: false, reason: 'x' } }), undefined).due).toBe(false);
    expect(dueToRecord(reading({ accountId: null }), undefined).due).toBe(false);
  });

  it('as a valuation with the moment it was read, and holdings with prices in pounds', () => {
    const b = recorded(reading());
    expect(b).toMatchObject({ kind: 'feed', dateSource: 'feed', date: '2027-03-03', at: T0, balance: 1000, cash: 10, contributions: 900, source: { feed: 'trading-212' } });
    expect(b.id).toBe(balanceId('example-invest', '2027-03-03', 1000, 'feed', T0));
    const h = toHoldings(reading({ holdings: [...reading().holdings, { ticker: 'EXUS_US_EQ', units: 2, price: 120.5, priceCurrency: 'USD', value: 180, cost: 150, gain: 30 }] }) as FeedReading & { accountId: string });
    expect(h.holdings[0]).toMatchObject({ name: 'Example Global Fund', units: 10, price: 99, value: 990, currency: 'GBP', costBasis: 900 });
    expect(h.holdings[1]!.price).toBeUndefined();
    expect(h).toMatchObject({ cash: 10, totalValue: 1000, source: { feed: 'trading-212' } });
  });
});

describe('recording into the data', () => {
  let dir: string;
  let app: App;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-feed-rec-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    await app.ctx.store.upsertAccount(account({ id: 'example-invest', last4: '5432' }));
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('writes the valuation and replaces the feed’s own holdings of the day, but never a document’s', async () => {
    const { store } = app.ctx;
    expect(await recordIfDue(store, reading())).toEqual({ recorded: true, why: 'first of the day' });
    expect(await recordIfDue(store, reading({ at: '2027-03-03T12:20:00+00:00', totalValue: 1050 }))).toMatchObject({ recorded: false });
    expect(await recordIfDue(store, reading({ at: '2027-03-03T13:00:00+00:00', totalValue: 1100 }))).toEqual({ recorded: true, why: 'hourly' });
    expect(store.balances('example-invest').map((b) => [b.kind, b.at, b.balance])).toEqual([
      ['feed', T0, 1000],
      ['feed', '2027-03-03T13:00:00+00:00', 1100],
    ]);
    expect(store.holdings('example-invest')).toHaveLength(1);
    expect(store.holdings('example-invest')[0]!.totalValue).toBe(1100);
    expect(lastRecorded(store.balances('example-invest'))?.balance).toBe(1100);
    // A document's snapshot of the next day stays the day's only one.
    await store.addHoldings([{ id: 'hld_00000000000000aa', accountId: 'example-invest', date: '2027-03-04', holdings: [{ name: 'Example Global Fund', value: 1000, currency: 'GBP' }], totalValue: 1000, source: { importId: 'imp_20270304_090000_abcd' }, createdAt: '2027-03-04T09:00:00+00:00' }], 'a document');
    await recordIfDue(store, reading({ at: '2027-03-04T10:00:00+00:00', totalValue: 1150 }));
    expect(store.holdings('example-invest').filter((h) => h.date === '2027-03-04').map((h) => h.source.importId)).toEqual(['imp_20270304_090000_abcd']);
    // The balance engine takes the latest of the day as its value.
    expect(app.ctx.analytics.engine.balanceOn('example-invest', '2027-03-03')?.value).toBe(1100);
  });
});

describe('money paid in, from the cash movements', () => {
  const CASH = [
    { type: 'DEPOSIT', amount: 1000, currency: 'GBP', reference: 'ref-0001', dateTime: '2027-01-05T10:00:00.000Z' },
    { type: 'DEPOSIT', amount: 100, currency: 'GBP', reference: 'ref-0002', dateTime: '2027-01-06T10:00:00.000Z' },
    { type: 'WITHDRAW', amount: -60.25, currency: 'GBP', reference: 'ref-0003', dateTime: '2027-02-01T10:00:00.000Z' },
    { type: 'INTEREST_ON_FREE_CASH', amount: 0.42, currency: 'GBP', reference: 'ref-0004', dateTime: '2027-02-02T10:00:00.000Z' },
    { type: 'FEE', amount: -1, currency: 'GBP', reference: 'ref-0006', dateTime: '2027-02-04T10:00:00.000Z' },
    { type: 'DEPOSIT', amount: 5, currency: 'EUR', reference: 'ref-0007', dateTime: '2027-02-05T10:00:00.000Z' },
  ];
  const row = (id: string, category: string): Transaction => ({ id: `tx_${id.replace(/\D/g, '').padStart(16, '0')}`, accountId: 'example-invest', date: '2027-01-06', amount: 100, currency: 'GBP', description: 'Deposit', raw: { ID: id }, category, source: {} });

  it('counts deposits, withdrawals and transfers in the account’s currency, less what your imports file as income', () => {
    expect(paidIn(CASH, 'GBP', [])).toBe(1039.75);
    expect(paidIn(CASH, 'GBP', [row('ref-0002', 'investment-income')])).toBe(939.75);
    expect(paidIn(CASH, 'GBP', [row('ref-0002', 'contribution'), row('ref-0003', 'withdrawal')])).toBe(1039.75);
  });

  it('reads the list in full once, then only what is new, at most hourly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-feed-cash-'));
    try {
      let now = Date.parse(T0);
      const pages = [CASH.slice(0, 3), CASH.slice(3)];
      const asked: (string | undefined)[] = [];
      const pager = {
        cashMovements: (next?: string) => {
          asked.push(next);
          const i = next ? Number(next.slice(-1)) : 0;
          return Promise.resolve({ items: pages[i]!, next: i + 1 < pages.length ? `/api/v0/equity/history/transactions?cursor=${i + 1}` : null });
        },
      };
      const book = new CashMovementsBook(dir, () => now);
      expect(book.contributions('GBP', [])).toBeUndefined();
      expect(book.due()).toBe(true);
      await book.refresh(pager, T0, () => Promise.resolve());
      expect(asked).toEqual([undefined, '/api/v0/equity/history/transactions?cursor=1']);
      expect(book.status).toMatchObject({ count: 6, complete: true });
      expect(book.contributions('GBP', [])).toBe(1039.75);
      now += 30 * 60_000;
      expect(book.due()).toBe(false);
      expect(book.due(true)).toBe(true);
      // A new deposit on the newest page: read, and the known page after it is not.
      pages[0] = [{ type: 'DEPOSIT', amount: 25, currency: 'GBP', reference: 'ref-0009', dateTime: '2027-03-03T09:00:00.000Z' }, ...pages[0]!];
      asked.length = 0;
      await book.refresh(pager, T0, () => Promise.resolve());
      expect(asked).toEqual([undefined]);
      expect(book.contributions('GBP', [])).toBe(1064.75);
      // Kept in the work area across a restart.
      const again = new CashMovementsBook(dir, () => now);
      await again.load();
      expect(again.contributions('GBP', [])).toBe(1064.75);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('when a live reading stands for today', () => {
  const now = new Date(T0);
  const gia = account({ id: 'example-invest' });
  const bal = (b: Partial<BalanceSnapshot>): BalanceSnapshot => ({ id: 'bal_0000000000000001', accountId: 'example-invest', date: '2027-03-02', balance: 900, currency: 'GBP', kind: 'statement', source: {}, createdAt: T0, ...b });

  it('is fresh, today’s, newer than the latest recorded, checked, and in pounds', () => {
    expect(liveOverride(reading(), gia, [bal({})], now)).toMatchObject({ accountId: 'example-invest', value: 1000, at: T0, contributions: 900 });
    expect(liveOverride(reading(), gia, [bal({})], new Date(Date.parse(T0) + LIVE_FRESH_MS + 1000))).toBeUndefined();
    expect(liveOverride(reading({ check: { ok: false, reason: 'x' } }), gia, [], now)).toBeUndefined();
    expect(liveOverride(reading(), { ...gia, currency: 'USD' }, [], now)).toBeUndefined();
    expect(liveOverride(reading({ currency: 'USD' }), gia, [], now)).toBeUndefined();
    expect(liveOverride(reading(), { ...gia, status: 'closed' }, [], now)).toBeUndefined();
    expect(liveOverride(reading({ accountId: 'example-other' }), gia, [], now)).toBeUndefined();
    // A reading from yesterday evening is not today's, however fresh.
    expect(liveOverride(reading({ at: '2027-03-02T23:50:00+00:00' }), gia, [], new Date('2027-03-03T00:10:00Z'))).toBeUndefined();
  });

  it('yields to a recorded balance of today that is later, or a close with no time', () => {
    expect(liveOverride(reading(), gia, [bal({ date: '2027-03-03', at: '2027-03-03T11:00:00+00:00' })], now)).toBeDefined();
    expect(liveOverride(reading(), gia, [bal({ date: '2027-03-03', at: '2027-03-03T12:00:00+00:00' })], now)).toBeDefined();
    expect(liveOverride(reading(), gia, [bal({ date: '2027-03-03', at: '2027-03-03T12:05:00+00:00' })], now)).toBeUndefined();
    expect(liveOverride(reading(), gia, [bal({ date: '2027-03-03' })], now)).toBeUndefined();
    // A rough figure you gave does not count as recorded data.
    expect(liveOverride(reading(), gia, [bal({ date: '2027-03-03', approximate: true })], now)).toBeDefined();
  });
});

describe('today’s figures with a live reading', () => {
  let dir: string;
  let app: App;
  const today = nowISO().slice(0, 10);
  const monthAgo = addDays(today, -30);
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-feed-live-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.upsertAccount(account({ id: 'example-invest', last4: '5432' }));
    await store.upsertAccount(account({ id: 'example-current', type: 'current', institutionId: 'example-bank' }));
    await store.addBalances(
      [
        { id: 'bal_00000000000000a1', accountId: 'example-invest', date: monthAgo, balance: 900, currency: 'GBP', kind: 'statement', contributions: 850, source: {}, createdAt: `${monthAgo}T00:00:00+00:00` },
        { id: 'bal_00000000000000a2', accountId: 'example-current', date: monthAgo, balance: 500, currency: 'GBP', kind: 'statement', source: {}, createdAt: `${monthAgo}T00:00:00+00:00` },
      ],
      'opening balances',
    );
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const live = (value: number, contributions?: number): LiveOverride => ({ accountId: 'example-invest', value, at: nowISO(), feed: 'Trading 212', ...(contributions !== undefined ? { contributions } : {}) });

  it('stand in the estate, the account, Investments and the Overview, and nowhere else', () => {
    const { store, analytics } = app.ctx;
    const engine = analytics.engine;
    expect(estateOn(store, engine, today).total).toBe(1400);
    expect(estateOn(store, engine, today, live(1250)).total).toBe(1750);
    const acc = accountSummary(store, engine, store.account('example-invest')!, today, live(1250));
    expect(acc).toMatchObject({ balance: 1250, balanceGBP: 1250, asOf: today, stale: false, live: { recorded: 900, recordedAsOf: monthAgo } });
    expect(acc.sparkline.at(-1)).toBe(1250);
    const inv = investments(store, engine, live(1250, 1000));
    const row = inv.accounts.find((a) => a.id === 'example-invest')!;
    expect(row).toMatchObject({ value: 1250, contributions: 1000, contributionsSource: 'provider', growth: 250, live: { feed: 'Trading 212' } });
    expect(inv.totals.value).toBe(1250);
    // Without contributions in the reading, paid in is the recorded one.
    expect(investments(store, engine, live(1250)).accounts.find((a) => a.id === 'example-invest')!.contributions).toBe(850);
    const summary = analytics.summary({}, live(1250));
    expect(summary.estate.value).toBe(1750);
    expect(summary.live).toHaveLength(1);
    expect(summary.live![0]).toMatchObject({ accountId: 'example-invest', name: 'example-invest', feed: 'Trading 212' });
    // Without one, the recorded figures, as agents and Ask see them.
    expect(analytics.summary({}).estate.value).toBe(1400);
    expect(analytics.summary({}).live).toBeUndefined();
    expect(analytics.investments().totals.value).toBe(900);
  });

  it('move the estate by exactly the difference from the recorded value', () => {
    const { store, analytics } = app.ctx;
    const engine = analytics.engine;
    const base = estateOn(store, engine, today);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (pence) => {
        const e = estateOn(store, engine, today, live(pence / 100));
        expect(Math.round(e.total * 100)).toBe(Math.round(base.total * 100) - 90_000 + pence);
        expect(Math.round(e.assets * 100)).toBe(Math.round(base.assets * 100) - 90_000 + pence);
      }),
    );
  });
});
