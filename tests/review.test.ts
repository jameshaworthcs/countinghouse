// The checks shown while reviewing an import.

import { describe, expect, it } from 'vitest';
import { sectionChecks } from '../src/shared/review';
import { DraftSectionSchema, type DraftSection, type DraftTransaction } from '../src/shared/schema';

let n = 0;
const row = (date: string, amount: number, description: string, extra: Partial<DraftTransaction> = {}): DraftTransaction => ({ key: `r${n++}`, include: true, status: 'new', date, amount, description, ...extra });
const section = (transactions: DraftTransaction[], extra: Partial<DraftSection> = {}): DraftSection =>
  DraftSectionSchema.parse({ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'acc' }, transactions, ...extra });
const byId = (checks: ReturnType<typeof sectionChecks>, id: string) => checks.find((c) => c.id === id);
const ctx = { latest: '2026-09-29' };

describe('review checks', () => {
  it('reconciles opening + rows = closing, ignoring pending rows', () => {
    const rows = [row('2026-09-02', -20, 'TESCO'), row('2026-09-03', 1000, 'SALARY'), row('2026-09-04', -5, 'PRET', { pending: true, include: false })];
    expect(byId(sectionChecks(section(rows, { openingBalance: 100, balance: 1080 }), ctx), 'reconcile')).toMatchObject({ status: 'ok' });
    const bad = byId(sectionChecks(section(rows, { openingBalance: 100, balance: 1090 }), ctx), 'reconcile');
    expect(bad).toMatchObject({ status: 'warn', title: 'Balances don’t add up' });
  });

  it('points at the rows that break a running balance', () => {
    const rows = [row('2026-09-01', -10, 'A', { balanceAfter: 90 }), row('2026-09-02', -10, 'B', { balanceAfter: 80 }), row('2026-09-03', 10, 'C', { balanceAfter: 70 })];
    const c = byId(sectionChecks(section(rows), ctx), 'reconcile');
    expect(c).toMatchObject({ status: 'warn', rows: [rows[2]!.key] });
  });

  it('compares the rows with the totals printed on the statement', () => {
    const rows = [row('2026-09-02', -20.5, 'TESCO'), row('2026-09-03', 1000, 'SALARY'), row('2026-09-04', -4.5, 'PRET')];
    expect(byId(sectionChecks(section(rows, { statedTotals: { moneyIn: 1000, moneyOut: 25 } }), ctx), 'totals')).toMatchObject({ status: 'ok' });
    const c = byId(sectionChecks(section(rows, { statedTotals: { moneyIn: 1000, moneyOut: 35 } }), ctx), 'totals');
    expect(c).toMatchObject({ status: 'warn' });
    expect(c!.detail).toContain('Money out: £25.00 read, £35.00 on the statement');
  });

  it('flags rows outside the statement period and after the upload day', () => {
    const rows = [row('2025-09-15', -3, 'MISREAD YEAR'), row('2026-09-15', -3, 'OK'), row('2026-10-02', -3, 'FUTURE')];
    const checks = sectionChecks(section(rows, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }), ctx);
    expect(byId(checks, 'period')).toMatchObject({ status: 'warn', rows: [rows[0]!.key, rows[2]!.key] });
    expect(byId(checks, 'future')).toMatchObject({ status: 'warn', rows: [rows[2]!.key] });
    // An export's period is its own first and last rows: nothing to check.
    expect(byId(sectionChecks(section(rows.slice(1, 2), { periodStart: '2026-09-15', periodEnd: '2026-09-15' }), { ...ctx, periodFromRows: true }), 'period')).toBeUndefined();
  });

  it('checks card signs: purchases negative, payments to the card positive', () => {
    const purchases = [row('2026-09-01', -12, 'AMAZON'), row('2026-09-02', -30, 'TRAINLINE'), row('2026-09-03', -8, 'PRET')];
    expect(byId(sectionChecks(section([...purchases, row('2026-09-10', 250, 'PAYMENT RECEIVED - THANK YOU')]), { ...ctx, accountType: 'credit_card' }), 'card-signs')).toMatchObject({ status: 'ok' });
    // Every sign inverted, as a card statement printed without minus signs reads.
    const inverted = [...purchases.map((t) => ({ ...t, amount: -t.amount })), row('2026-09-10', -250, 'PAYMENT RECEIVED - THANK YOU')];
    expect(byId(sectionChecks(section(inverted), { ...ctx, accountType: 'credit_card' }), 'card-signs')).toMatchObject({ status: 'warn', title: 'Most rows are money in, which is unusual for a card' });
    // Only the payment wrong.
    const payment = row('2026-09-10', -250, 'DIRECT DEBIT PAYMENT');
    expect(byId(sectionChecks(section([...purchases, payment]), { ...ctx, accountType: 'credit_card' }), 'card-signs')).toMatchObject({ status: 'warn', rows: [payment.key] });
    // Not a card: no sign check.
    expect(byId(sectionChecks(section(inverted), { ...ctx, accountType: 'current' }), 'card-signs')).toBeUndefined();
    // Too few rows to count, but a payment to the card ("Payment", as a card's own export says) tells.
    const card = { ...ctx, accountType: 'credit_card' as const };
    const short = row('2026-09-29', -3.49, 'Payment');
    expect(byId(sectionChecks(section([row('2026-09-07', 3.49, 'SOFTWARE CO'), short]), card), 'card-signs')).toMatchObject({ status: 'warn', rows: [short.key] });
    expect(byId(sectionChecks(section([row('2026-09-07', -3.49, 'SOFTWARE CO'), row('2026-09-29', 3.49, 'Payment')]), card), 'card-signs')).toMatchObject({ status: 'ok' });
    expect(byId(sectionChecks(section(purchases.slice(0, 2)), card), 'card-signs')).toBeUndefined();
  });

  it('notes repeated rows, unsure rows and pending rows', () => {
    const a = row('2026-09-05', -3.2, 'COSTA');
    const b = row('2026-09-05', -3.2, 'Costa ');
    const unsure = row('2026-09-06', -45, 'SHELL', { uncertain: 'amount partly hidden' });
    const pending = row('2026-09-07', -9.99, 'NETFLIX', { pending: true, include: false });
    // Struck through on the screen: left out, and nothing to be unsure of.
    const cancelled = row('2026-09-08', -0.1, 'EXAMPLE BUSES', { uncertain: 'Marked Cancelled with the amount struck through', include: false });
    const checks = sectionChecks(section([a, b, unsure, pending, cancelled]), ctx);
    expect(byId(checks, 'repeated')).toMatchObject({ status: 'info', rows: [a.key, b.key] });
    expect(byId(checks, 'uncertain')).toMatchObject({ status: 'warn', rows: [unsure.key] });
    expect(byId(checks, 'pending')).toMatchObject({ status: 'info', rows: [pending.key] });
    expect(byId(checks, 'cancelled')).toMatchObject({ status: 'info', rows: [cancelled.key] });
  });

  it('has nothing to say about a clean export with no balances', () => {
    expect(sectionChecks(section([row('2026-09-01', -3, 'A'), row('2026-09-02', -4, 'B')]), ctx)).toEqual([]);
  });
});
