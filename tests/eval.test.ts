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

  it('scores an understood document that adds nothing, and never a document that does', () => {
    const empty: Draft = { documentType: 'other', sections: [], figures: [], notes: [] };
    expect(scoreCase({ sections: [], nothingNew: true }, empty, { nothingNew: true }).score).toBe(1);
    expect(scoreCase({ sections: [], nothingNew: true }, empty, {}).fields.nothingNew).toEqual({ correct: 0, total: 1 });
    // Every case checks it: saying "nothing new" of a statement would hide it.
    const s = scoreCase({ sections: [{ account: 'acc', balance: 90 }] }, draft('acc', [], { balance: 90 }), { nothingNew: true });
    expect(s.fields.nothingNew).toEqual({ correct: 0, total: 1 });
  });

  it('costs a point for a holding a document does not show, and for a claim it does not make', () => {
    const bonds = draft('acc', [], { balance: 12350, holdings: [{ name: '117BQ206001 to 117BQ206050', value: 50, currency: 'GBP' }] });
    expect(scoreCase({ sections: [{ account: 'acc', balance: 12350, holdings: [] }] }, bonds).fields.noExtraHolding).toEqual({ correct: 0, total: 1 });
    const unsupported = /\bpaid (out )?(to|into)\b/i;
    const says = (notes: string[]) => scoreCase({ sections: [], unsupported }, { documentType: 'other', sections: [], figures: [], notes }).fields.noClaim;
    expect(says(['Prizes are paid out to another account, so they are not transactions.'])).toEqual({ correct: 0, total: 1 });
    // Saying the document does not say is not a claim.
    expect(says(['The screen does not say whether the prizes were paid into a bank account.', 'The list continues.'])).toEqual({ correct: 1, total: 1 });
  });

  it('scores an account’s terms when reading everything: its limit, each rate and when it ends, the minimum payment', () => {
    const expected = { sections: [{ account: 'acc', terms: { limit: 4500, minimumPayment: 25, paymentDue: '2026-09-29', rates: [{ applies: 'purchases' as const, rate: 24.9 }, { applies: 'balance-transfers' as const, rate: 0, until: '2027-03-15' }] } }] };
    const read = (rates: { applies: 'purchases' | 'balance-transfers' | 'cash'; rate: number; until?: string }[]) => draft('acc', [], { creditLimit: 4500, terms: { rates, minimumPayment: 25, paymentDue: '2026-09-29' } });
    const right = scoreCase(expected, read([{ applies: 'purchases', rate: 24.9 }, { applies: 'balance-transfers', rate: 0, until: '2027-03-15' }]), {}, { everything: true });
    expect([right.fields.termsLimit, right.fields.termsRate, right.fields.termsNoExtraRate, right.fields.termsMinimum]).toEqual([{ correct: 1, total: 1 }, { correct: 2, total: 2 }, { correct: 1, total: 1 }, { correct: 1, total: 1 }]);
    // The promotion's end missed, and a rate the document does not print.
    const wrong = scoreCase(expected, read([{ applies: 'purchases', rate: 24.9 }, { applies: 'balance-transfers', rate: 0 }, { applies: 'cash', rate: 27.9 }]), {}, { everything: true });
    expect([wrong.fields.termsRate, wrong.fields.termsNoExtraRate]).toEqual([{ correct: 1, total: 2 }, { correct: 0, total: 1 }]);
    // Not scored by the reader that does not read everything.
    expect(scoreCase(expected, read([])).fields.termsRate).toBeUndefined();
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
