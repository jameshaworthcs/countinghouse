// Property-based tests (fast-check) for money arithmetic, dates, reconciliation and the balance
// engine. Each property holds for every generated input; fast-check shrinks any failure to a
// minimal counterexample.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { addDays, addMonths, diffDays, fromUTC, isISODate, parseFlexibleDate } from '../src/shared/dates';
import { addMoney, apportion, formatMoney, fromMinor, isMoney, mulDivRound, parseAmount, roundMoney, roundToPounds, subMoney, sumMoney, toMinor } from '../src/shared/money';
import { reconcile } from '../src/shared/reconcile';
import type { Account, BalanceSnapshot, Transaction } from '../src/shared/schema';
import { taxYear, taxYearOf } from '../src/shared/uk';

const RUNS = { numRuns: 300 };
/** Money as integer pence within ±£100m, the realistic range for personal finance. */
const pence = fc.integer({ min: -10_000_000_000, max: 10_000_000_000 });
const money = pence.map((p) => fromMinor(p));
const isoDate = fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2060, 11, 31) }).map((t) => fromUTC(new Date(Math.floor(t / 86_400_000) * 86_400_000)));

describe('money', () => {
  it('pence round-trip exactly', () => {
    fc.assert(fc.property(pence, (p) => toMinor(fromMinor(p)) === p && isMoney(fromMinor(p))), RUNS);
  });

  it('sums are exact and order-independent', () => {
    fc.assert(
      fc.property(fc.array(pence, { maxLength: 60 }), (ps) => {
        const values = ps.map(fromMinor);
        const total = ps.reduce((a, b) => a + b, 0);
        return toMinor(sumMoney(values)) === total && toMinor(sumMoney([...values].reverse())) === total;
      }),
      RUNS,
    );
  });

  it('add and subtract are exact inverses, and commutative', () => {
    fc.assert(fc.property(money, money, (a, b) => addMoney(a, b) === addMoney(b, a) && subMoney(addMoney(a, b), b) === a), RUNS);
  });

  it('rounding always yields valid money within half a penny', () => {
    fc.assert(fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (x) => isMoney(roundMoney(x)) && Math.abs(roundMoney(x) - x) <= 0.005 + 1e-6), RUNS);
  });

  it('parses its own formatting back, and bank-style variants', () => {
    fc.assert(
      fc.property(money, (m) => {
        const formatted = formatMoney(m);
        const abs = Math.abs(m).toFixed(2);
        return (
          parseAmount(formatted) === m &&
          parseAmount(`(${abs})`) === -Math.abs(m) + 0 &&
          parseAmount(`${abs} DR`) === (m === 0 ? 0 : -Math.abs(m)) &&
          parseAmount(`${abs} CR`) === Math.abs(m) &&
          parseAmount(`${abs}-`) === (m === 0 ? 0 : -Math.abs(m))
        );
      }),
      RUNS,
    );
  });

  it('rounds a × b ÷ c half away from zero, as toMinor rounds', () => {
    expect([mulDivRound(5, 1, 2), mulDivRound(-5, 1, 2), mulDivRound(7, 1, 3), mulDivRound(-7, 1, 3), mulDivRound(5, -1, 2), mulDivRound(0, 3, 7)]).toEqual([3, -3, 2, -2, -3, 0]);
    // Beyond 2^53 in the product, exact all the same.
    expect(mulDivRound(9_000_000_000_000, 1_000, 3_000)).toBe(3_000_000_000_000);
    expect([roundToPounds(150), roundToPounds(149), roundToPounds(-150), roundToPounds(-149), roundToPounds(1_234_550)]).toEqual([2, 1, -2, -1, 12_346]);
    expect(() => mulDivRound(1, 1, 0)).toThrow(RangeError);
    fc.assert(
      fc.property(pence, fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (a, b, c) => {
        const r = mulDivRound(a, b, c);
        const exact = (a * b) / c;
        // Within half of one, and on an exact half, away from zero (the symmetry toMinor has).
        return Math.abs(r - exact) <= 0.5 + 1e-6 * Math.abs(exact) && mulDivRound(-a, b, c) === -r;
      }),
      RUNS,
    );
  });

  it('apportions pence by weights: the parts add up to the total, each within a penny of its share', () => {
    // 100p over three equal days: 33, 34, 33 (round(100/3)=33, round(200/3)=67, 100).
    expect(apportion(100, [1, 1, 1])).toEqual([33, 34, 33]);
    expect(apportion(-100, [1, 1, 1])).toEqual([-33, -34, -33]);
    expect(apportion(28_800, [123, 242])).toEqual([9_705, 19_095]);
    expect(apportion(1, [1, 1])).toEqual([1, 0]);
    expect(apportion(500, [0, 3, 0, 2])).toEqual([0, 300, 0, 200]);
    expect(() => apportion(100, [0, 0])).toThrow(RangeError);
    expect(() => apportion(1.5, [1])).toThrow(RangeError);
    fc.assert(
      fc.property(pence, fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 40 }), (total, ws) => {
        fc.pre(ws.some((w) => w > 0));
        const parts = apportion(total, ws);
        const whole = ws.reduce((s, w) => s + w, 0);
        return (
          parts.length === ws.length &&
          parts.reduce((s, p) => s + p, 0) === total &&
          parts.every((p, i) => Number.isInteger(p) && (ws[i] === 0 ? p === 0 : Math.abs(p - (total * ws[i]!) / whole) < 1 + 1e-6 * Math.abs(total))) &&
          // Signed like the total, and the same split of the negated total negated.
          parts.every((p) => p === 0 || Math.sign(p) === Math.sign(total)) &&
          apportion(-total, ws).every((p, i) => p === -parts[i]!)
        );
      }),
      RUNS,
    );
  });
});

describe('dates and tax years', () => {
  it('addDays and diffDays are inverse', () => {
    fc.assert(fc.property(isoDate, fc.integer({ min: -20_000, max: 20_000 }), (d, n) => diffDays(d, addDays(d, n)) === n && isISODate(addDays(d, n))), RUNS);
  });

  it('addMonths lands in the right month and never overflows it', () => {
    fc.assert(
      fc.property(isoDate, fc.integer({ min: -600, max: 600 }), (d, n) => {
        const r = addMonths(d, n);
        const months = (Number(r.slice(0, 4)) - Number(d.slice(0, 4))) * 12 + (Number(r.slice(5, 7)) - Number(d.slice(5, 7)));
        return isISODate(r) && months === n && Number(r.slice(8)) <= Number(d.slice(8));
      }),
      RUNS,
    );
  });

  it('every date falls in exactly one tax year, 6 April to 5 April', () => {
    fc.assert(
      fc.property(isoDate, (d) => {
        const ty = taxYearOf(d);
        return ty.start <= d && d <= ty.end && ty.start.endsWith('-04-06') && ty.end.endsWith('-04-05') && taxYear(ty.startYear).label === ty.label;
      }),
      RUNS,
    );
  });

  it('day-first parsing reads back what was written', () => {
    fc.assert(fc.property(isoDate, (d) => parseFlexibleDate(`${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`, 'DMY') === d && parseFlexibleDate(d) === d), RUNS);
  });
});

describe('reconciliation', () => {
  const rows = fc.array(pence.filter((p) => p !== 0).map(fromMinor), { minLength: 1, maxLength: 40 });

  it('a consistent statement reconciles, including running balances', () => {
    fc.assert(
      fc.property(money, rows, (opening, amounts) => {
        let bal = toMinor(opening);
        const txs = amounts.map((a, i) => {
          bal += toMinor(a);
          return { amount: a, balanceAfter: fromMinor(bal), date: addDays('2026-01-01', i) };
        });
        return reconcile({ openingBalance: opening, closingBalance: fromMinor(bal), transactions: txs }).status === 'ok';
      }),
      RUNS,
    );
  });

  it('any changed amount is caught', () => {
    fc.assert(
      fc.property(money, rows, fc.nat(), pence.filter((p) => p !== 0), (opening, amounts, pick, delta) => {
        const closing = fromMinor(toMinor(opening) + amounts.reduce((s, a) => s + toMinor(a), 0));
        const i = pick % amounts.length;
        const tampered = amounts.map((a, j) => ({ amount: j === i ? fromMinor(toMinor(a) + delta) : a, date: '2026-01-01' }));
        return reconcile({ openingBalance: opening, closingBalance: closing, transactions: tampered }).status === 'mismatch';
      }),
      RUNS,
    );
  });

  it('pending rows never count', () => {
    fc.assert(
      fc.property(money, rows, pence, (opening, amounts, pendingAmount) => {
        const closing = fromMinor(toMinor(opening) + amounts.reduce((s, a) => s + toMinor(a), 0));
        const txs = [...amounts.map((a) => ({ amount: a, date: '2026-01-01' })), { amount: fromMinor(pendingAmount), date: '2026-01-02', pending: true }];
        return reconcile({ openingBalance: opening, closingBalance: closing, transactions: txs }).status === 'ok';
      }),
      RUNS,
    );
  });
});

describe('balance engine (ledger accounts)', () => {
  const stamp = '2026-01-01T00:00:00+00:00';
  const account: Account = { id: 'acc', name: 'acc', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  const ledger = fc.record({
    opening: pence,
    days: fc.array(fc.record({ offset: fc.integer({ min: 0, max: 120 }), amount: pence.filter((p) => p !== 0) }), { minLength: 1, maxLength: 40 }),
    anchorEvery: fc.integer({ min: 5, max: 60 }),
  });

  it('balances follow the anchors and the transactions between them, with no gaps when consistent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-prop-'));
    try {
      await fc.assert(
        fc.asyncProperty(ledger, async ({ opening, days, anchorEvery }) => {
          const store = await Store.open(path.join(dir, `d${Math.random().toString(36).slice(2)}`));
          await store.setAccounts([account]);
          const sorted = [...days].sort((a, b) => a.offset - b.offset);
          const txs: Transaction[] = sorted.map((d, i) => ({ id: transactionId('acc', addDays('2026-01-01', d.offset), fromMinor(d.amount), 'X', i), accountId: 'acc', date: addDays('2026-01-01', d.offset), amount: fromMinor(d.amount), currency: 'GBP', description: 'X', source: {} }));
          await store.addTransactions(txs, 't');
          // Consistent statement balances every `anchorEvery` days: opening + everything so far.
          const snaps: BalanceSnapshot[] = [];
          for (let day = 0, k = 0; day <= 130; day += anchorEvery, k++) {
            const date = addDays('2026-01-01', day);
            const bal = opening + sorted.filter((d) => d.offset <= day).reduce((s, d) => s + d.amount, 0);
            snaps.push({ id: `bal_${k.toString(16).padStart(16, '0')}`, accountId: 'acc', date, balance: fromMinor(bal), currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp });
          }
          await store.addBalances(snaps, 's');
          const engine = new BalanceEngine(store);
          expect(engine.gaps('acc')).toEqual([]);
          for (let day = 0; day <= 130; day += 7) {
            const expected = opening + sorted.filter((d) => d.offset <= day).reduce((s, d) => s + d.amount, 0);
            expect(toMinor(engine.balanceOn('acc', addDays('2026-01-01', day))!.value)).toBe(expected);
          }
          store.stopWatching();
        }),
        { numRuns: 60 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a missing transaction between two statements is reported as a gap of exactly its amount', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-prop-'));
    try {
      await fc.assert(
        fc.asyncProperty(pence, fc.array(pence.filter((p) => p !== 0), { minLength: 2, maxLength: 20 }), fc.nat(), async (opening, amounts, pick) => {
          const store = await Store.open(path.join(dir, `d${Math.random().toString(36).slice(2)}`));
          await store.setAccounts([account]);
          const missing = pick % amounts.length;
          const txs: Transaction[] = amounts.flatMap((a, i) => (i === missing ? [] : [{ id: transactionId('acc', addDays('2026-01-02', i), fromMinor(a), 'X', i), accountId: 'acc', date: addDays('2026-01-02', i), amount: fromMinor(a), currency: 'GBP', description: 'X', source: {} }]));
          await store.addTransactions(txs, 't');
          const closing = opening + amounts.reduce((s, a) => s + a, 0);
          await store.addBalances(
            [
              { id: 'bal_0000000000000001', accountId: 'acc', date: '2026-01-01', balance: fromMinor(opening), currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp },
              { id: 'bal_0000000000000002', accountId: 'acc', date: addDays('2026-01-02', amounts.length), balance: fromMinor(closing), currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp },
            ],
            's',
          );
          const gaps = new BalanceEngine(store).gaps('acc');
          expect(gaps).toHaveLength(1);
          expect(toMinor(gaps[0]!.difference)).toBe(amounts[missing]);
          store.stopWatching();
        }),
        { numRuns: 60 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
