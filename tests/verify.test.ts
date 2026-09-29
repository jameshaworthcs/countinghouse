// Checking a reading: what the document's own arithmetic confirms, and how two readings are
// compared figure by figure (src/server/ingest/verify.ts).

import { describe, expect, it } from 'vitest';
import { assessReading, chooseReading, compareReadings, shortModel } from '../src/server/ingest/verify';
import { DraftSectionSchema, type Draft, type DraftSection, type DraftTransaction } from '../src/shared/schema';

let n = 0;
const row = (date: string, amount: number, description: string, extra: Partial<DraftTransaction> = {}): DraftTransaction => ({ key: `s0-t${n++}`, include: true, status: 'new', date, amount, description, ...extra });
const section = (extra: Partial<DraftSection>): DraftSection => DraftSectionSchema.parse({ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'acc' }, ...extra });
const draft = (sections: DraftSection[], extra: Partial<Draft> = {}): Draft => ({ documentType: 'bank_statement', sections, figures: [], notes: [], ...extra });
const ctx = { accountTypeOf: () => 'current' as const, latest: '2026-09-29', warnings: [] as string[] };

describe('what a reading’s own arithmetic confirms', () => {
  it('a statement whose balances reconcile needs no second reading', () => {
    const rows = [row('2026-09-02', -20, 'TESCO'), row('2026-09-03', 1000, 'SALARY')];
    const a = assessReading(draft([section({ openingBalance: 100, balance: 1080, transactions: rows })]), ctx);
    expect(a).toEqual({ problems: [], unconfirmed: [] });
  });

  it('a statement that does not reconcile has a problem', () => {
    const rows = [row('2026-09-02', -20, 'TESCO'), row('2026-09-03', 1000, 'SALARY')];
    const a = assessReading(draft([section({ openingBalance: 100, balance: 1090, transactions: rows })]), ctx);
    expect(a.problems).toEqual(['Account 1: balances don’t add up']);
  });

  it('a feed with no balances, a lone balance, contributions and tax figures are unconfirmed', () => {
    const feed = assessReading(draft([section({ transactions: [row('2026-09-02', -20, 'TESCO')] })]), ctx);
    expect(feed.unconfirmed).toEqual(['Account 1: no balances or totals to check the rows against']);
    const overview = assessReading(draft([section({ balance: 34003.51, contributions: 31100, taxYearContributions: 3600 })]), ctx);
    expect(overview.unconfirmed).toEqual(['Account 1: a balance with nothing to check it against', 'Account 1: contribution and allowance figures']);
    const p60 = assessReading(draft([], { figures: [{ key: 'f0', include: true, kind: 'gross_pay', label: 'Pay', amount: 69120, currency: 'GBP' }] }), ctx);
    expect(p60.unconfirmed).toEqual(['Tax figures']);
  });

  it('holdings are confirmed when they add up to the value, and a problem when they do not', () => {
    const holdings = [
      { name: 'Global All Cap', value: 24482.53, currency: 'GBP' },
      { name: 'LifeStrategy 80', value: 6800.7, currency: 'GBP' },
    ];
    expect(assessReading(draft([section({ balance: 31283.23, holdings })]), ctx)).toEqual({ problems: [], unconfirmed: [] });
    const off = assessReading(draft([section({ balance: 34003.51, holdings })]), ctx);
    expect(off.problems).toEqual(['Account 1: the holdings don’t add up to the value']);
  });

  it('warnings from reading and a low confidence are problems', () => {
    const a = assessReading(draft([section({ openingBalance: 0, balance: -20, transactions: [row('2026-09-02', -20, 'TESCO')] })], { confidence: 'low' }), { ...ctx, warnings: ['Account 1: 2 transaction row(s) had an unreadable date or amount and were dropped.'] });
    expect(a.problems).toHaveLength(2);
  });
});

describe('comparing two readings', () => {
  it('agrees when every figure matches, whatever the wording', () => {
    const a = draft([section({ balance: 90, transactions: [row('2026-09-01', -10, 'TESCO STORES 3297')] })]);
    const b = draft([section({ balance: 90, transactions: [row('2026-09-01', -10, 'Tesco Stores 3297 London')] })]);
    expect(compareReadings(a, b, { first: 'Sonnet', second: 'Opus' }).disagreements).toEqual([]);
  });

  it('names each figure that differs and marks the rows', () => {
    const b1 = row('2026-09-01', -12.5, 'SHELL');
    const b2 = row('2026-09-03', -4.1, 'PRET');
    const b3 = row('2026-09-04', -2.8, 'TFL');
    const a = draft([section({ balance: 100, transactions: [row('2026-09-01', -72.5, 'SHELL'), row('2026-09-02', -4.1, 'PRET')] })]);
    const b = draft([section({ balance: 101, transactions: [b1, b2, b3] })]);
    const c = compareReadings(a, b, { first: 'Sonnet', second: 'Opus' });
    expect(c.disagreements).toEqual([
      'Account 1, balance: Sonnet read £100.00, Opus £101.00',
      'Account 1, 2026-09-01 SHELL -£12.50: Sonnet read -£72.50',
      'Account 1, 2026-09-03 PRET -£4.10: Sonnet dated it 2026-09-02',
      'Account 1, 2026-09-04 TFL -£2.80: only Opus read this row',
    ]);
    expect(c.rowNotes.get(b1.key)).toBe('The two readings differed: Sonnet read the amount as -£72.50. Check it against the document.');
    expect(c.rowNotes.get(b2.key)).toMatch(/Sonnet read the date as 2026-09-02/);
    expect(c.rowNotes.get(b3.key)).toMatch(/only Opus read this row/);
  });

  it('compares holdings and tax figures too', () => {
    const a = draft([section({ balance: 100, holdings: [{ name: 'Fund A', isin: 'GB00B4PQW151', value: 60, currency: 'GBP' }] })], { figures: [{ key: 'f0', include: true, kind: 'tax_deducted', label: 'Tax', amount: 15137.6, currency: 'GBP', taxYear: '2025/26' }] });
    const b = draft([section({ balance: 100, holdings: [{ name: 'Fund A Acc', isin: 'GB00B4PQW151', value: 66, currency: 'GBP' }] })], { figures: [{ key: 'f0', include: true, kind: 'tax_deducted', label: 'Tax', amount: 15137.6, currency: 'GBP', taxYear: '2026/27' }] });
    expect(compareReadings(a, b, { first: 'Sonnet', second: 'Opus' }).disagreements).toEqual(['Account 1, holding Fund A Acc: Sonnet read £60.00, Opus £66.00', 'Tax: tax year 2025/26 in Sonnet, 2026/27 in Opus']);
  });

  it('keeps the stronger reading unless the arithmetic finds more wrong with it', () => {
    expect(chooseReading({ problems: [], unconfirmed: ['x'] }, { problems: [], unconfirmed: ['x'] })).toBe('second');
    expect(chooseReading({ problems: [], unconfirmed: [] }, { problems: ['balances don’t add up'], unconfirmed: [] })).toBe('first');
    expect(shortModel('claude-sonnet-5-5')).toBe('Sonnet');
    expect(shortModel('opus')).toBe('Opus');
  });
});
