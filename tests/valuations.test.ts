// A market account between its valuations (docs/FORMULAS.md §9, "Between valuations"): the growth
// between two valuations shared out at a steady rate on the money in it, shaped by the holdings'
// published prices when there are enough. All data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { holdingsPath, PriceBook, priceIndex } from '../src/server/analytics/prices';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Account, BalanceSnapshot, HoldingsSnapshot, Instrument, Research, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
let n = 0;
const tx = (accountId: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, 'Subscription', n++), accountId, date, amount, currency: 'GBP', description: 'Subscription', category: 'contribution', source: {}, ...extra });
const bal = (accountId: string, date: string, balance: number): BalanceSnapshot => ({ id: `bal_${(n++).toString(16).padStart(16, '0')}`, accountId, date, balance, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp });
const inst = (id: string, name: string): Instrument => ({ id, name, aliases: [], createdAt: stamp, updatedAt: stamp });
const prices = (instrumentId: string, points: [string, number][]): Research => ({
  id: `res_${(n++).toString(16).padStart(16, '0')}`,
  kind: 'instrument.prices',
  subject: { instrumentId },
  asOf: points[points.length - 1]![0],
  sources: [{ title: 'Example price history' }],
  confidence: 'high',
  data: { currency: 'GBP', points: points.map(([date, price]) => ({ date, price })) },
  provenance: { setBy: 'agent' },
  createdAt: stamp,
});
const holdings = (accountId: string, date: string, list: { name: string; value: number }[], cash = 0): HoldingsSnapshot => ({
  id: `hld_${(n++).toString(16).padStart(16, '0')}`,
  accountId,
  date,
  holdings: list.map((h) => ({ ...h, currency: 'GBP' })),
  cash,
  totalValue: list.reduce((s, h) => s + h.value, cash),
  source: {},
  createdAt: stamp,
});

describe('between two valuations', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-val-'));
    store = await Store.open(dir);
    await store.setAccounts([acct('isa', 'stocks_isa')]);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('with no prices, grows at one steady rate that meets both valuations, and money grows only once it is in', async () => {
    await store.addTransactions([tx('isa', '2025-07-01', 10_000)], 'test');
    await store.addBalances([bal('isa', '2025-01-01', 10_000), bal('isa', '2026-01-01', 22_000)], 'test');
    const engine = new BalanceEngine(store);
    const on = (d: string) => engine.balanceOn('isa', d)!;
    expect(on('2025-01-01')).toMatchObject({ value: 10_000, estimated: false });
    expect(on('2026-01-01')).toMatchObject({ value: 22_000, estimated: false });
    const mid = on('2025-06-30');
    expect(mid).toMatchObject({ estimated: true, basis: { date: '2025-01-01', kind: 'balance', to: '2026-01-01' } });
    expect(mid.basis!.prices).toBeUndefined();
    // £2,000 of growth over the year on £10,000, then £20,000: about a third of it by the money's mid-year.
    expect(mid.value).toBeGreaterThan(10_500);
    expect(mid.value).toBeLessThan(11_000);
    // The money paid in arrives whole, and the months rise steadily after it.
    expect(on('2025-07-01').value - mid.value).toBeGreaterThan(10_000);
    const ends = ['2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31'].map((d) => on(d).value);
    for (let i = 1; i < ends.length; i++) expect(ends[i]!).toBeGreaterThan(ends[i - 1]!);
  });

  it('follows its holdings’ prices, and still meets both valuations', async () => {
    await store.setInstruments([inst('world', 'Example World Index Fund')]);
    await store.addBalances([bal('isa', '2025-01-01', 10_000), bal('isa', '2025-12-31', 11_000)], 'test');
    await store.addHoldings([holdings('isa', '2025-12-31', [{ name: 'Example World Index Fund', value: 11_000 }])], 'test');
    await store.appendRecords('research', [prices('world', [['2025-01-01', 1], ['2025-06-30', 0.8], ['2025-12-31', 1.1]])], 'test');
    const engine = new BalanceEngine(store);
    const june = engine.balanceOn('isa', '2025-06-30')!;
    expect(june).toMatchObject({ estimated: true, basis: { to: '2025-12-31', prices: true } });
    // The market fell a fifth by June: so did the estimate, near enough.
    expect(june.value).toBeGreaterThan(7_800);
    expect(june.value).toBeLessThan(8_200);
    expect(engine.balanceOn('isa', '2025-12-31')!.value).toBe(11_000);
  });

  it('before its first valuation, is rolled back as the prices moved', async () => {
    await store.setInstruments([inst('world', 'Example World Index Fund')]);
    await store.addTransactions([tx('isa', '2025-03-01', 1_000)], 'test');
    await store.addBalances([bal('isa', '2025-06-01', 12_000)], 'test');
    await store.addHoldings([holdings('isa', '2025-06-01', [{ name: 'Example World Index Fund', value: 9_000 }], 3_000)], 'test');
    await store.appendRecords('research', [prices('world', [['2025-01-01', 1], ['2025-06-01', 1.2]])], 'test');
    const engine = new BalanceEngine(store);
    // Three quarters invested, in a fund a sixth lower then; the cash as it was.
    const april = engine.balanceOn('isa', '2025-04-30')!;
    expect(april).toMatchObject({ estimated: true, basis: { date: '2025-06-01', after: true, prices: true } });
    expect(april.value).toBeCloseTo(12_000 * (0.25 + 0.75 / 1.2), 0);
  });

  it('weights holdings by value, keeps cash as it is, and has no index when too little is priced', () => {
    const book = new PriceBook([prices('a', [['2025-01-01', 1], ['2025-02-01', 2]])]);
    const instruments = [inst('a', 'Alpha Growth'), inst('b', 'Beta Value')];
    const idx = priceIndex(holdings('isa', '2025-01-01', [{ name: 'Alpha Growth', value: 600 }, { name: 'Beta Value', value: 200 }], 200), instruments, book)!;
    expect(idx.at('2025-01-01')).toBeCloseTo(1);
    // A doubles; B, unpriced, moves with it; the cash stays.
    expect(idx.at('2025-02-01')).toBeCloseTo((200 + 1200 + 400) / 1000);
    expect(priceIndex(holdings('isa', '2025-01-01', [{ name: 'Alpha Growth', value: 100 }, { name: 'Beta Value', value: 900 }]), instruments, book)).toBeUndefined();
  });

  it('walks the units held from a snapshot through the trades, by name first and then by price', () => {
    const instruments = [inst('robots', 'Example Robotics ETF'), inst('spx', 'Example S&P 500 ETF')];
    const book = new PriceBook([prices('robots', [['2025-01-01', 10], ['2025-06-01', 12]]), prices('spx', [['2025-01-01', 10.2], ['2025-06-01', 11]])]);
    const rows = [
      { date: '2025-01-10', amount: 1_000, description: 'Subscription', category: 'contribution' },
      // Both trade near £10: the words tell them apart.
      { date: '2025-02-01', amount: -500, description: 'Purchase 50 Example Robotics ETF USD Acc', category: 'trade' },
      { date: '2025-03-01', amount: -510, description: 'Purchase 50 Example S&P 500 ETF', category: 'trade' },
    ];
    const snap = { date: '2025-06-01', holdings: [{ name: 'Example Robotics ETF', units: 50, value: 600, currency: 'GBP' }, { name: 'Example S&P 500 ETF', units: 50, value: 550, currency: 'GBP' }], cash: 0 };
    const path = holdingsPath(snap, -10, rows, instruments, book)!;
    expect(path.at('2025-06-01') / 100).toBeCloseTo(1_140);
    // In February, only the robots were bought: 50 at £10, and the cash for the rest.
    expect(path.at('2025-02-15') / 100).toBeCloseTo(50 * 10 + 500);
    // Before the money arrived there was nothing.
    expect(path.at('2025-01-05') / 100).toBeCloseTo(0);
    // A trade at a price no holding had is not one of these holdings: no path.
    expect(holdingsPath(snap, 0, [...rows, { date: '2025-04-01', amount: -100, description: 'Purchase 1 Something Else', category: 'trade' }], instruments, book)).toBeUndefined();
  });
});
