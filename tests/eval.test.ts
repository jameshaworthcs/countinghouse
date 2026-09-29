// The extraction evaluation's scorer and its cases (eval/): the numbers it reports have to mean
// what they say.

import { describe, expect, it } from 'vitest';
import { buildCases } from '../eval/cases';
import { sameText, scoreCase } from '../eval/score';
import { DraftSectionSchema, type Draft, type DraftTransaction } from '../src/shared/schema';

let n = 0;
const row = (date: string, amount: number, description: string, extra: Partial<DraftTransaction> = {}): DraftTransaction => ({ key: `r${n++}`, include: true, status: 'new', date, amount, description, ...extra });
const draft = (accountId: string, transactions: DraftTransaction[], extra: object = {}): Draft => ({
  documentType: 'bank_statement',
  sections: [DraftSectionSchema.parse({ key: 's0', detected: {}, target: { mode: 'existing', accountId }, transactions, ...extra })],
  figures: [],
  notes: [],
});

describe('eval scorer', () => {
  it('matches descriptions as printed, allowing a code or place added', () => {
    expect(sameText('TESCO STORES 3297', 'VIS TESCO STORES 3297 LONDON')).toBe(true);
    expect(sameText('Café de Flore', 'CAFE DE FLORE')).toBe(true);
    expect(sameText('Card Payment to TESCO STORES 3297 On 12 Aug', 'Card Payment to TESCO STORES 3297 On 12 Aug')).toBe(true);
    expect(sameText('TESCO STORES 3297', 'SAINSBURYS S/MKT')).toBe(false);
  });

  it('scores a perfect extraction at 100%', () => {
    const expected = { sections: [{ account: 'acc', balance: 90, transactions: [{ date: '2026-09-01', amount: -10, description: 'TESCO', balanceAfter: 90 }] }] };
    const s = scoreCase(expected, draft('acc', [row('2026-09-01', -10, 'TESCO', { balanceAfter: 90 })], { balance: 90 }));
    expect(s.score).toBe(1);
    expect(s.rows).toEqual({ expected: 1, found: 1, extra: 0 });
  });

  it('counts a wrong sign, a wrong date, a missing row and an extra row as such', () => {
    const expected = {
      sections: [
        {
          account: 'acc',
          transactions: [
            { date: '2026-09-01', amount: -10, description: 'TESCO' },
            { date: '2026-09-02', amount: -4.5, description: 'PRET' },
            { date: '2026-09-03', amount: -20, description: 'SHELL' },
          ],
        },
      ],
    };
    const s = scoreCase(expected, draft('acc', [row('2026-09-01', 10, 'TESCO'), row('2026-09-04', -4.5, 'PRET'), row('2026-09-05', -1, 'EXTRA')]));
    expect(s.fields.sign).toEqual({ correct: 1, total: 2 });
    expect(s.fields.date).toEqual({ correct: 1, total: 2 });
    expect(s.fields.row).toEqual({ correct: 2, total: 3 });
    expect(s.fields.noExtra).toEqual({ correct: 2, total: 3 });
    expect(s.errors.some((e) => e.includes('SHELL') && e.includes('missing'))).toBe(true);
  });

  it('checks that rows imported before are recognised, and routes to the right account', () => {
    const expected = { sections: [{ account: 'acc', transactions: [{ date: '2026-09-01', amount: -10, description: 'TESCO', duplicate: true }] }] };
    expect(scoreCase(expected, draft('acc', [row('2026-09-01', -10, 'TESCO', { status: 'duplicate', include: false })])).score).toBe(1);
    const wrong = scoreCase(expected, draft('other', [row('2026-09-01', -10, 'TESCO')]));
    expect(wrong.fields.account).toEqual({ correct: 0, total: 1 });
    expect(wrong.fields.duplicate).toEqual({ correct: 0, total: 1 });
  });

  it('every case is well formed: unique ids, known accounts, balances that add up', () => {
    const cases = buildCases();
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(25);
    for (const c of cases) {
      expect(c.file.text ?? c.file.html).toBeTruthy();
      for (const s of c.expected.sections) {
        const txs = s.transactions ?? [];
        // Statements: opening + rows = closing, to the penny.
        if (s.openingBalance !== undefined && s.balance !== undefined && txs.length) {
          const settled = txs.filter((t) => !t.pending).reduce((sum, t) => sum + Math.round(t.amount * 100), Math.round(s.openingBalance * 100));
          expect(settled, c.id).toBe(Math.round(s.balance * 100));
        }
      }
    }
  });
});
