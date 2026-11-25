// A Lifetime ISA's bonus, matched to the payments it is for (docs/FORMULAS.md §11, "LISA bonus").
// Invented figures only.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances, lisaBonusByYear } from '../src/server/analytics/allowances';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { addDays } from '../src/shared/dates';
import type { Account, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: transactionId(accountId, date, amount, description, seq++),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  ...extra,
});
const paid = (date: string, amount: number) => tx('lisa', date, amount, 'Card payment', { category: 'contribution' });
const bonus = (date: string, amount: number) => tx('lisa', date, amount, 'Government bonus', { category: 'government-bonus' });

describe('LISA bonus', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-lisa-'));
    store = await Store.open(dir);
    await store.setCategories(defaultCategories());
    await store.setAccounts([acct('current', 'current'), acct('lisa', 'lisa')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('says what is still to come once the allowance is full and some bonus has arrived', async () => {
    await store.addTransactions([paid('2025-05-10', 1500), bonus('2025-06-20', 375), paid('2025-08-02', 1500), bonus('2025-09-15', 375), paid('2025-10-20', 1000)], 'test');
    const l = allowances(store, '2025/26', '2025-11-01').lisa!;
    expect(l).toMatchObject({ contributed: 4000, bonusEarned: 1000, bonusReceived: 750, bonusStillDue: 250 });
  });

  it('counts a bonus that arrives after 5 April for the year of its payment', async () => {
    await store.addTransactions([paid('2025-09-01', 3000), bonus('2025-10-05', 750), paid('2026-03-25', 1000), bonus('2026-04-22', 250), paid('2026-04-28', 200), bonus('2026-05-30', 50)], 'test');
    const before = allowances(store, '2025/26', '2026-06-01').lisa!;
    expect(before).toMatchObject({ contributed: 4000, bonusEarned: 1000, bonusReceived: 1000, bonusStillDue: 0 });
    expect(before.notes.some((n) => n.includes('after 5 April'))).toBe(true);
    const after = allowances(store, '2026/27', '2026-06-01').lisa!;
    expect(after).toMatchObject({ contributed: 200, bonusEarned: 50, bonusReceived: 50, bonusStillDue: 0 });
    expect(after.notes.some((n) => n.includes("is for 2025/26's payments"))).toBe(true);
    // The April bonus is listed under the year it is for.
    const ids = (ty: string) => allowances(store, ty, '2026-06-01').lisa!.lines.flatMap((l) => (l.label.endsWith('bonus received') ? (l.transactionIds ?? []) : []));
    const april = store.transactions('lisa').find((t) => t.date === '2026-04-22')!.id;
    expect(ids('2025/26')).toContain(april);
    expect(ids('2026/27')).not.toContain(april);
  });

  it('splits one bonus across payments, and earns nothing over the allowance', async () => {
    await store.addTransactions([paid('2025-06-01', 3000), paid('2025-06-03', 2000), bonus('2025-07-10', 1000)], 'test');
    const l = allowances(store, '2025/26', '2025-08-01').lisa!;
    expect(l).toMatchObject({ contributed: 5000, bonusEarned: 1000, bonusReceived: 1000, bonusStillDue: 0 });
  });

  it('counts a payment only the bank records', async () => {
    await store.addTransactions([tx('current', '2025-07-01', -1000, 'TO LIFETIME ISA', { category: 'investment-transfer', counterpartyAccountId: 'lisa' }), bonus('2025-08-20', 250)], 'test');
    const l = allowances(store, '2025/26', '2025-09-01').lisa!;
    expect(l).toMatchObject({ contributed: 1000, bonusEarned: 250, bonusReceived: 250, bonusStillDue: 0 });
  });

  it('counts a bonus no earlier payment earned as received in the year it is dated, without paying a later payment', async () => {
    await store.addTransactions([bonus('2025-05-15', 100), paid('2025-06-01', 400)], 'test');
    const l = allowances(store, '2025/26', '2025-07-01').lisa!;
    expect(l).toMatchObject({ contributed: 400, bonusEarned: 100, bonusReceived: 100, bonusStillDue: 100 });
  });

  it('uses the rate on a provider figure the rows do not add up to', async () => {
    await store.addTransactions([paid('2025-06-01', 500)], 'test');
    await store.addBalances([{ id: 'bal_0000000000000009', accountId: 'lisa', date: '2025-09-01', balance: 2500, currency: 'GBP', kind: 'screenshot', taxYearContributions: 2000, taxYear: '2025/26', source: {}, createdAt: stamp }], 'test');
    const l = allowances(store, '2025/26', '2025-09-30').lisa!;
    expect(l).toMatchObject({ contributed: 2000, bonusEarned: 500, bonusReceived: 0, bonusStillDue: 500 });
  });

  it('never loses or makes up bonus: each bonus is shared out in full, and a year gets at most what its payments earn unless nothing earlier did', async () => {
    const day = fc.integer({ min: 0, max: 900 }).map((n) => addDays('2024-04-06', n));
    const pence = (lo: number, hi: number) => fc.integer({ min: lo, max: hi }).map((n) => n / 100);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(day, pence(1, 300_000)), { maxLength: 12 }), fc.array(fc.tuple(day, pence(1, 100_000)), { maxLength: 12 }), async (pays, bonuses) => {
        const d = await mkdtemp(path.join(os.tmpdir(), 'finance-lisa-p-'));
        const s = await Store.open(d);
        try {
          await s.setAccounts([acct('lisa', 'lisa')]);
          await s.addTransactions([...pays.map(([dt, a]) => paid(dt, a)), ...bonuses.map(([dt, a]) => bonus(dt, a))], 'test');
          const years = lisaBonusByYear(s, s.account('lisa')!, '2026-11-01');
          const received = [...years.values()].reduce((sum, y) => sum + y.received, 0);
          const total = bonuses.reduce((sum, [, a]) => sum + Math.round(a * 100), 0);
          expect(received).toBe(total);
          for (const y of years.values()) {
            expect(y.bonuses.reduce((sum, b) => sum + b.minor, 0)).toBe(y.received);
            expect(y.owed).toBeGreaterThanOrEqual(0);
            expect(y.owed).toBeLessThanOrEqual(y.earned ?? Infinity);
          }
          // With every bonus after every payment, no year gets more than it earned unless bonus is left over.
          if (pays.length && bonuses.every(([b]) => pays.every(([p]) => p <= b))) {
            const earned = [...years.values()].reduce((sum, y) => sum + (y.earned ?? 0), 0);
            if (total <= earned) for (const y of years.values()) expect(y.received).toBeLessThanOrEqual(y.earned ?? 0);
          }
        } finally {
          s.stopWatching();
          await rm(d, { recursive: true, force: true, maxRetries: 5 });
        }
      }),
      { numRuns: 40 },
    );
  });
});
