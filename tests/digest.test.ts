// The digest the analysis jobs read: what the owner's documents say beyond transactions and balances
// (pay, HMRC's records, terms, agreements, pension arrangements), and the records an insight may
// cite from it.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDigest, buildMonthDigest } from '../src/server/agents/digest';
import { JOB_DEFS, type JobContext } from '../src/server/agents/kinds';
import { Analytics } from '../src/server/analytics';
import { transactionId } from '../src/server/ids';
import { checkRecords } from '../src/server/records';
import { Store } from '../src/server/store';
import type { Account, Figure, HmrcRecord, PayslipRecord, Terms } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
const PAYROLL = '88001234';
const PAYE = '123/AB45678';

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-digest-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([acct('current', 'current'), acct('card', 'credit_card'), acct('sipp', 'sipp')]);
  await store.setEmployments([
    {
      id: 'acme',
      employer: 'Acme Widgets Ltd',
      aliases: [],
      payeReference: PAYE,
      payrollNumbers: [PAYROLL],
      startedOn: '2025-01-06',
      owed: [],
      pensionArrangements: [{ accountId: 'sipp', kind: 'monthly', amount: 150, from: '2026-05-01', source: {} }],
      createdBy: 'owner',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  const fig = (id: string, kind: Figure['kind'], amount: number): Figure => ({ id, kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', periodStart: '2026-08-01', periodEnd: '2026-08-31', date: '2026-08-28', payer: 'Acme Widgets Ltd', employmentId: 'acme', source: {}, createdAt: stamp });
  await store.addFigures([fig('fig_00000000000000c1', 'gross_pay', 2500), fig('fig_00000000000000c2', 'tax_deducted', 290), fig('fig_00000000000000c3', 'national_insurance', 120)], 'f');
  await store.addTransactions([{ id: transactionId('current', '2026-08-28', 2090, 'ACME WIDGETS SALARY', 0), accountId: 'current', date: '2026-08-28', amount: 2090, currency: 'GBP', description: 'ACME WIDGETS SALARY', category: 'salary', source: {} }], 't');
  const payslip: PayslipRecord = {
    id: 'pay_00000000000000c1',
    employer: 'Acme Widgets Ltd',
    otherNames: [],
    payeReference: PAYE,
    payrollNumber: PAYROLL,
    payDate: '2026-08-28',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    taxCode: '1257L',
    payments: [{ label: 'Salary', amount: 2500 }],
    deductions: [],
    totals: { payments: 2500, net: 2090 },
    employerCosts: {},
    yearToDate: {},
    employmentId: 'acme',
    taxYear: '2026/27',
    source: {},
    createdAt: stamp,
  };
  const hmrc: HmrcRecord[] = [
    { id: 'hmrc_00000000000000c1', type: 'tax-code', employer: 'ACME WIDGETS LTD', payeReference: PAYE, date: '2026-08-10', code: 'BR', cumulative: true, taxYear: '2026/27', employmentId: 'acme', source: {}, createdAt: stamp },
    { id: 'hmrc_00000000000000c2', type: 'ni-year', asOf: '2026-09-01', taxYear: '2022/23', status: 'not-full', contributions: [], voluntaryCost: 900, payBy: '2029-04-05', source: {}, createdAt: stamp },
  ];
  const terms: Terms = { id: 'trm_00000000000000c1', accountId: 'card', asOf: '2026-08-20', rates: [{ applies: 'purchases', rate: 0, until: '2027-03-31' }, { applies: 'purchases', rate: 24.9 }], limit: 4000, minimumPayment: 5, source: {}, createdAt: stamp };
  await store.upsertRecords('payslips', [payslip], 'p');
  await store.upsertRecords('hmrc', hmrc, 'h');
  await store.upsertRecords('terms', [terms], 'tr');
  await store.upsertAgreement({ id: 'flat-lease', name: 'Flat lease 2026/27', counterparty: 'Example Lettings', names: [], category: 'rent', from: '2026-07-01', until: '2027-06-30', payments: [{ due: '2026-08-01', amount: 950 }], details: [], source: {}, createdBy: 'owner', createdAt: stamp, updatedAt: stamp });
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('the digest', () => {
  it('carries pay, HMRC’s records, terms, agreements and pension arrangements', () => {
    const d = buildDigest(store, new Analytics(store), { month: '2026-08' });
    const job = d.pay.employers.find((e) => e.employmentId === 'acme')!;
    expect(job.months).toHaveLength(1);
    expect(job.months[0]).toMatchObject({ payDate: '2026-08-28', inFocus: true, gross: 2500, tax: 290, ni: 120 });
    expect(d.hmrc.taxCodes).toEqual([{ id: 'hmrc_00000000000000c1', employmentId: 'acme', employer: 'ACME WIDGETS LTD', date: '2026-08-10', code: 'BR', cumulative: true, taxYear: '2026/27' }]);
    expect(d.hmrc.niYears.notFull).toEqual([{ id: 'hmrc_00000000000000c2', taxYear: '2022/23', asOf: '2026-09-01', voluntaryCost: 900, payBy: '2029-04-05' }]);
    expect(d.terms).toEqual([expect.objectContaining({ accountId: 'card', limit: { asOf: '2026-08-20', value: 4000 }, minimumPayment: { asOf: '2026-08-20', amount: 5, due: null } })]);
    expect(d.terms[0]!.rates!.rates).toContainEqual({ applies: 'purchases', rate: 0, until: '2027-03-31' });
    expect(d.agreements).toEqual([expect.objectContaining({ id: 'flat-lease', payments: [expect.objectContaining({ due: '2026-08-01', amount: 950, status: 'unseen' })] })]);
    expect(d.pensionArrangements).toEqual([expect.objectContaining({ accountId: 'sipp', employmentId: 'acme', kind: 'monthly', amount: 150 })]);
    // Its first collection never came.
    expect(d.pensionArrangements[0]).toMatchObject({ firstCollectionSeen: false, lastCollected: null });
    expect(d.budgets).toBeNull();
    expect(d.goals).toBeNull();
  });

  it('a month looked back on knows only what its documents said by its end', async () => {
    await store.upsertRecords('hmrc', [{ id: 'hmrc_00000000000000c3', type: 'tax-code', employer: 'ACME WIDGETS LTD', payeReference: PAYE, date: '2026-09-15', code: 'K100', cumulative: true, taxYear: '2026/27', employmentId: 'acme', source: {}, createdAt: stamp }], 'h');
    const a = new Analytics(store);
    const july = buildMonthDigest(store, a, { month: '2026-07', catchUp: true });
    // August's payslip, the code issued in August, the NI record seen in September and the card's
    // August terms came after July.
    const job = july.pay.employers.find((e) => e.employmentId === 'acme')!;
    expect(job).toMatchObject({ months: [], taxCodesIssued: [], yearToDate: { gross: null, paidIn: 0 }, yearDocument: null });
    expect(july.hmrc.taxCodes).toEqual([]);
    expect(july.hmrc.niYears.notFull).toEqual([]);
    expect(july.terms).toEqual([]);
    // The lease's August rent was due within 60 days: known, not yet due.
    expect(july.agreements).toEqual([expect.objectContaining({ id: 'flat-lease', payments: [expect.objectContaining({ due: '2026-08-01', status: 'upcoming', paid: null })] })]);
    // August's review knows its own month's documents, and, apart, the code issued since.
    const august = buildMonthDigest(store, a, { month: '2026-08' });
    expect(august.hmrc.taxCodes.map((c) => c.code)).toEqual(['BR']);
    expect(august.asOfToday?.taxCodesSince.map((c) => c.code)).toEqual(['K100']);
    const paid = august.pay.employers.find((e) => e.employmentId === 'acme')!.months[0]!;
    expect(paid.payDate).toBe('2026-08-28');
    expect(paid.status).not.toBe('not paid by then');
  });

  it('leaves out identifiers the analysis does not need', () => {
    const text = JSON.stringify(buildDigest(store, new Analytics(store), { month: '2026-08' }));
    expect(text).not.toContain(PAYROLL);
    expect(text).not.toContain(PAYE);
  });
});

describe('what an insight may cite', () => {
  it('keeps a payslip, HMRC record, agreement, company or job that exists, and drops one that does not', async () => {
    const ctx: JobContext = { store, analytics: new Analytics(store), params: { month: '2026-08' }, scratch: dir };
    const cite = (type: string, id: string) => ({ type, ids: null, id, metric: null, value: null, label: null });
    const out = {
      insights: [
        {
          kind: 'month-review',
          pages: ['overview'],
          subject: { accountId: null, instrumentId: null, category: null, taxYear: null, month: '2026-08' },
          title: 'August',
          body: 'b',
          confidence: 'medium',
          evidence: [cite('payslip', 'pay_00000000000000c1'), cite('hmrc', 'hmrc_00000000000000c1'), cite('agreement', 'flat-lease'), cite('employment', 'acme'), cite('payslip', 'pay_ffffffffffffffff'), cite('company', 'nowhere-ltd')],
          expiresInDays: 30,
        },
      ],
      watch: [],
      followUp: [],
    };
    await JOB_DEFS['monthly-review'].apply(ctx, out, { setBy: 'agent', model: 'claude-test', promptVersion: 'test', jobId: 'job_test' });
    expect(store.insights[0]!.evidence).toEqual([
      { type: 'payslip', id: 'pay_00000000000000c1' },
      { type: 'hmrc', id: 'hmrc_00000000000000c1' },
      { type: 'agreement', id: 'flat-lease' },
      { type: 'employment', id: 'acme' },
    ]);
  });

  it('the validated write path refuses a citation of a record that does not exist', () => {
    const batch = {
      provenance: { setBy: 'agent' as const, model: 'claude-test', session: 'test' },
      supersede: false,
      records: [{ type: 'insight' as const, record: { kind: 'anomaly' as const, pages: ['tax' as const], subject: {}, title: 't', body: 'b', confidence: 'low' as const, evidence: [{ type: 'payslip' as const, id: 'pay_ffffffffffffffff' }], expiresOn: '2026-12-31' } }],
    };
    expect(checkRecords(store, batch as never).join('\n')).toMatch(/unknown payslip "pay_ffffffffffffffff"/);
  });
});
