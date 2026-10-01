// The tax year in full (FORMULAS.md §11 and §7; docs/UK_RULES.md, "Self Assessment"): a Self
// Assessment employment page per job, the year's deadlines, HMRC's working out of the year with the
// payments that settled it, and the National Insurance record. Every figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { investments } from '../src/server/analytics/investments';
import { selfAssessment } from '../src/server/analytics/selfassessment';
import { figureId, hmrcId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import type { Employment, ExtractedHmrc, Figure, HmrcRecord } from '../src/shared/schema';
import { saDeadlines, taxYear } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';

describe('the Self Assessment deadlines', () => {
  it('are those of the year after the tax year, and the January and July after that', () => {
    expect(saDeadlines(taxYear(2025)).map((d) => [d.date, d.kind])).toEqual([
      ['2026-10-05', 'register'],
      ['2026-10-31', 'paper'],
      ['2026-12-30', 'online-through-code'],
      ['2027-01-31', 'online'],
      ['2027-01-31', 'pay'],
      ['2027-07-31', 'second-payment-on-account'],
    ]);
  });
});

describe('the tax year in full', () => {
  let dir: string;
  let store: Store;
  const job = (id: string, employer: string, extra: Partial<Employment> = {}): Employment => ({ id, employer, aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
  const record = (r: ExtractedHmrc, extra: Partial<HmrcRecord> = {}): HmrcRecord => ({ ...r, id: hmrcId(r), source: {}, createdAt: stamp, ...extra }) as HmrcRecord;
  const fig = (kind: Figure['kind'], amount: number, payer: string, employmentId: string, extra: Partial<Figure> = {}): Figure => ({ id: figureId(kind, amount, '2025/26', payer, kind, employmentId), kind, label: kind, amount, currency: 'GBP', taxYear: '2025/26', payer, employmentId, source: {}, createdAt: stamp, ...extra });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-taxyear-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setProfile({ ...store.profile, dateOfBirth: '2005-03-21' });
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.setEmployments([job('alder', 'Alder Ltd', { payeReference: '111/AL123' }), job('birch', 'Birch Ltd', { payeReference: '222/BI456', startedOn: '2025-09-01' })]);
    // Alder: a P60 for the whole year (your figures stand in for it). Birch: started in September, left in February.
    await store.addFigures([fig('gross_pay', 12000, 'Alder Ltd', 'alder'), fig('tax_deducted', 1200, 'Alder Ltd', 'alder'), fig('student_loan_deducted', 120, 'Alder Ltd', 'alder'), fig('gross_pay', 4000, 'Birch Ltd', 'birch'), fig('tax_deducted', 300, 'Birch Ltd', 'birch')], 'test: figures');
    await store.upsertRecords(
      'hmrc',
      [
        record({ type: 'event', employer: 'Birch Ltd', date: '2026-02-20', event: 'ended', text: 'Employment ended at Birch Ltd' }, { employmentId: 'birch' }),
        record({ type: 'settlement', taxYear: '2025/26', asOf: '2026-09-30', outcome: 'underpaid', amount: 76.2, calculatedOn: '2026-07-01', outstanding: 0, payments: [{ date: '2026-08-19', amount: 76.2, how: 'bank transfer' }] }),
        record({ type: 'ni-year', asOf: '2026-09-30', taxYear: '2025/26', status: 'full', contributions: [{ kind: 'Paid employment', amount: 715 }] }),
        record({ type: 'ni-year', asOf: '2026-09-30', taxYear: '2023/24', status: 'not-full', contributions: [], voluntaryCost: 612, payBy: '2030-04-05' }),
        record({ type: 'state-pension-forecast', asOf: '2026-09-30', weekly: 241.3, monthly: Math.round(((241.3 * 365.25) / 7 / 12) * 100) / 100, annual: Math.round(((241.3 * 365.25) / 7) * 100) / 100, payableFrom: '2073-03-21', recordTo: '2026-04-05', qualifyingYears: 3, yearsNeeded: 10, assumesYears: 32, maximum: true }),
      ],
      'test: HMRC',
    );
    await store.addTransactions([{ id: transactionId('current', '2026-08-20', -76.2, 'HMRC SELF ASSESSMENT', 0), accountId: 'current', date: '2026-08-20', amount: -76.2, currency: 'GBP', description: 'HMRC SELF ASSESSMENT', source: {} }], 'test: payment');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives an employment page per job, the deadlines, HMRC’s working out with its payment, and the year’s NI', () => {
    const sa = selfAssessment(store, '2025/26');
    expect(sa.employments.map((e) => [e.employer, e.payeReference, e.pay, e.tax, e.studentLoan, e.startedOn ?? null, e.endedOn ?? null, e.final])).toEqual([
      ['Alder Ltd', '111/AL123', 12000, 1200, 120, null, null, true],
      ['Birch Ltd', '222/BI456', 4000, 300, null, '2025-09-01', '2026-02-20', true],
    ]);
    expect(sa.deadlines).toHaveLength(6);
    expect(sa.settlement).toMatchObject({ outcome: 'underpaid', amount: 76.2, outstanding: 0, payments: [{ date: '2026-08-19', amount: 76.2, paidFrom: { date: '2026-08-20', amount: -76.2, accountId: 'current' } }] });
    expect(sa.ni).toMatchObject({ status: 'full' });
    expect(selfAssessment(store, '2023/24').ni).toMatchObject({ status: 'not-full', voluntaryCost: 612, payBy: '2030-04-05' });
  });

  it('shows the State Pension forecast in full and the NI record, newest year first', () => {
    const r = investments(store, new BalanceEngine(store)).retirement;
    expect(r.statePension).toMatchObject({ annual: Math.round(((241.3 * 365.25) / 7) * 100) / 100, source: 'forecast', startsOn: '2073-03-21', hmrc: { weekly: 241.3, qualifyingYears: 3, assumesYears: 32, yearsNeeded: 10, maximum: true } });
    expect(r.niRecord.map((y) => [y.taxYear, y.status, y.voluntaryCost ?? null])).toEqual([
      ['2025/26', 'full', null],
      ['2023/24', 'not-full', 612],
    ]);
  });
});
