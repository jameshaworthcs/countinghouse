// A month in review (docs/FORMULAS.md §18, docs/AGENTS.md "monthly-review"): the month's figures by
// fixed rules, what each value at its end rests on, the digest Claude reads (written later for an
// earlier month, it knows nothing after it), a review's lines to watch, a rerun replacing its month's
// notes, and earlier months reviewed oldest first. No job here calls Claude; every name and amount is
// invented.

import fc from 'fast-check';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMonthDigest } from '../src/server/agents/digest';
import { JobRunner } from '../src/server/agents/jobs';
import { JOB_DEFS } from '../src/server/agents/kinds';
import { Analytics } from '../src/server/analytics';
import { flows } from '../src/server/analytics/cashflow';
import { loadConfig } from '../src/server/config';
import { balanceId, hmrcId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { toMinor } from '../src/shared/money';
import type { Account, Agreement, HmrcRecord, Insight, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, seq++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const lastDay = (m: string) => `${m}-${m === '2026-02' ? '28' : ['2026-04', '2026-06'].includes(m) ? '30' : '31'}`;
let n = 0;
const insight = (extra: Partial<Insight>): Insight => ({
  id: `inf_${(n++).toString(16).padStart(16, '0')}`,
  kind: 'month-review',
  pages: ['overview'],
  subject: {},
  title: 'A month',
  body: 'What happened.',
  evidence: [{ type: 'computed', metric: 'spending' }],
  confidence: 'medium',
  provenance: { setBy: 'agent', promptVersion: 'monthly-review-4', jobId: 'job_a' },
  status: 'active',
  createdAt: '2026-09-01T00:00:00+00:00',
  ...extra,
});

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-month-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setCategories(defaultCategories());
  await store.setProfile({ ...store.profile, name: 'Jordan Blake' });
  await store.setAccounts([acct('bank', 'current'), acct('saver', 'savings'), acct('isa', 'stocks_isa'), acct('slc', 'student_loan', { includeInNetWorth: false })]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Eight months of a current account and a saver: pay, rent, shopping, saving, and interest on each one's last day. */
async function months(): Promise<void> {
  const rows: Transaction[] = [];
  for (const m of MONTHS) {
    rows.push(
      tx('bank', `${m}-01`, -900, 'EXAMPLE LETTINGS RENT'),
      tx('bank', `${m}-10`, -120, 'EXAMPLE MART', { category: 'groceries', categorisedBy: 'builtin' }),
      tx('bank', `${m}-20`, -35.5, 'EXAMPLE MART', { category: 'groceries', categorisedBy: 'builtin' }),
      tx('bank', `${m}-25`, 2000, 'ACME LTD SALARY', { category: 'salary', categorisedBy: 'user' }),
      tx('bank', `${m}-26`, -200, 'TO SAVER', { category: 'savings-transfer', categorisedBy: 'transfer', transferGroup: `tg_${m}`, counterpartyAccountId: 'saver' }),
      tx('saver', `${m}-26`, 200, 'FROM BANK', { category: 'savings-transfer', categorisedBy: 'transfer', transferGroup: `tg_${m}`, counterpartyAccountId: 'bank' }),
      tx('bank', lastDay(m), 0.1, 'INTEREST', { category: 'interest', categorisedBy: 'builtin' }),
      tx('saver', lastDay(m), 0.05, 'INTEREST', { category: 'interest', categorisedBy: 'builtin' }),
    );
  }
  rows.push(
    // August: a one-off, money back, a gift not yet confirmed, tuition the loan paid, maintenance it lent.
    tx('bank', '2026-08-12', -400, 'EXAMPLE SOFA CO'),
    tx('bank', '2026-08-15', 20, 'EXAMPLE MART REFUND', { category: 'refunds', categorisedBy: 'builtin' }),
    tx('bank', '2026-08-16', 30, 'FASTER PAYMENTS RECEIPT REF.dinner FROM ALEX REED', { category: 'eating-out', categorisedBy: 'user' }),
    tx('bank', '2026-08-17', 50, 'FASTER PAYMENTS RECEIPT REF.bday FROM SAM TAYLOR', { category: 'gifts-received', categorisedBy: 'ai' }),
    tx('slc', '2026-08-20', -2400, 'PAID TO UNIVERSITY OF EXAMPLE', { category: 'courses', categorisedBy: 'agreement' }),
    tx('bank', '2026-08-21', 1500, 'BANK GIRO CREDIT', { category: 'transfer', categorisedBy: 'agreement', counterpartyAccountId: 'slc' }),
    tx('bank', '2026-08-22', 12.34, 'MYSTERY CREDIT'),
  );
  await store.addTransactions(rows, 't');
  // The ISA's only valuation is from before the year: its value at August's end is not August's.
  await store.addBalances([{ id: balanceId('isa', '2025-12-31', 10_000, 'statement'), accountId: 'isa', date: '2025-12-31', balance: 10_000, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp }], 'b');
  const maintenance: Agreement = {
    id: 'maintenance',
    name: 'Maintenance Loan 2026/27',
    counterparty: 'Student Finance England',
    names: [],
    category: 'transfer',
    direction: 'in',
    accountId: 'slc',
    from: '2026-08-21',
    payments: [
      { due: '2026-08-21', amount: 1500 },
      { due: '2026-10-15', amount: 1500 },
    ],
    details: [],
    source: {},
    createdBy: 'owner',
    createdAt: stamp,
    updatedAt: stamp,
  };
  await store.setAgreements([maintenance]);
}

describe('a month’s figures', () => {
  it('money in apart from borrowing, spending by kind, where the net went, and worth with what it rests on', async () => {
    await months();
    const a = new Analytics(store);
    const m = a.month('2026-08');
    expect(m.complete).toBe(true);
    const line = (list: { id: string; amount: number }[], id: string) => list.find((l) => l.id === id)!.amount;
    // Money in: pay, interest, the gift and the unknown credit; borrowing is apart.
    expect(line(m.moneyIn.lines, 'pay')).toBe(2000);
    expect(line(m.moneyIn.lines, 'other-income')).toBe(0.15);
    expect(line(m.moneyIn.lines, 'gifts')).toBe(50);
    expect(line(m.moneyIn.lines, 'uncategorised-in')).toBe(12.34);
    expect(m.moneyIn).toMatchObject({ income: 2062.49, borrowed: 3900, total: 5962.49 });
    expect(m.borrowed.map((b) => [b.date, b.amount])).toEqual([
      ['2026-08-20', -2400],
      ['2026-08-21', 1500],
    ]);
    // Spending: the tuition as scheduled, rent as regular, the sofa as a one-off, the rest everyday, and money back.
    expect(line(m.spending.lines, 'scheduled')).toBe(2400);
    expect(line(m.spending.lines, 'regular')).toBe(900);
    expect(line(m.spending.lines, 'one-offs')).toBe(400);
    expect(line(m.spending.lines, 'everyday')).toBe(155.5);
    expect(line(m.spending.lines, 'money-back')).toBe(-50);
    expect(m.spending.oneOffs.map((p) => p.payee)).toEqual(['Example Sofa Co']);
    // The lines add up to cash flow's spending and income, to the penny.
    const f = flows(store, '2026-08-01', '2026-08-31');
    expect(toMinor(m.spending.total)).toBe(f.filter((x) => x.cls === 'spending').reduce((s, x) => s + x.minor, 0));
    expect(toMinor(m.moneyIn.income)).toBe(f.filter((x) => x.cls === 'income').reduce((s, x) => s + x.minor, 0));
    expect(m.net.amount).toBe(-1743.01);
    // Against the seven complete months before.
    expect(m.moneyIn.lines.find((l) => l.id === 'pay')!.compared).toEqual({ median: 2000, low: 2000, high: 2000, months: 7 });
    expect(m.spending.compared).toMatchObject({ median: 1055.5, months: 7 });
    // Where the net went: to savings.
    expect(m.moved).toEqual([{ id: 'savings', label: 'savings', amount: 200 }]);
    // Worth: the ISA rests on December's valuation, so its (lack of) change is not August's.
    const isa = m.worth.accounts.find((x) => x.accountId === 'isa')!;
    expect(isa).toMatchObject({ end: 10_000, basis: { date: '2025-12-31', kind: 'balance' }, oldValuation: true });
    expect(m.worth.accounts.find((x) => x.accountId === 'bank')!.basis).toBeUndefined();
    // The gift from someone, read by the reader, is still yours to confirm.
    expect(m.quality.peopleToConfirm).toEqual({ count: 1, in: 50, out: 0 });
    expect(m.quality.uncategorisedIn).toBe(12.34);
    // What the agreement has due after the month.
    expect(m.coming).toEqual([{ date: '2026-10-15', amount: 1500, direction: 'in', agreementId: 'maintenance', name: 'Maintenance Loan 2026/27' }]);
    expect(m.payees.new.map((p) => p.payee)).toContain('Example Sofa Co');
  });

  it('compares with fewer than 12 months, and with none', async () => {
    await months();
    const a = new Analytics(store);
    expect(a.month('2026-01').moneyIn.lines.find((l) => l.id === 'pay')!.compared).toBeUndefined();
    expect(a.month('2026-03').spending.compared).toEqual({ median: 1055.5, low: 1055.5, high: 1055.5, months: 2 });
  });

  it('its lines always add up to cash flow’s spending and income', async () => {
    const categories = [undefined, 'groceries', 'eating-out', 'salary', 'interest', 'refunds', 'repaid', 'gifts-received', 'transfer', 'courses', 'cash-withdrawal'];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ day: fc.integer({ min: 1, max: 28 }), pence: fc.integer({ min: -90_000, max: 90_000 }).filter((p) => p !== 0), category: fc.constantFrom(...categories), payee: fc.constantFrom('A SHOP', 'B CAFE', 'C LETTINGS') }), { maxLength: 40 }), async (rows) => {
        const local = await Store.open(path.join(dir, `p${seq++}`));
        await local.setCategories(defaultCategories());
        await local.setAccounts([acct('bank', 'current')]);
        await local.addTransactions(
          rows.map((r) => tx('bank', `2026-05-${String(r.day).padStart(2, '0')}`, r.pence / 100, r.payee, r.category ? { category: r.category, categorisedBy: 'user' } : {})),
          't',
        );
        const m = new Analytics(local).month('2026-05');
        const f = flows(local, '2026-05-01', '2026-05-31');
        const spend = m.spending.lines.reduce((s, l) => s + toMinor(l.amount), 0);
        const income = m.moneyIn.lines.filter((l) => l.id !== 'borrowed').reduce((s, l) => s + toMinor(l.amount), 0);
        expect(spend).toBe(f.filter((x) => x.cls === 'spending').reduce((s, x) => s + x.minor, 0));
        expect(income).toBe(f.filter((x) => x.cls === 'income').reduce((s, x) => s + x.minor, 0));
        expect(toMinor(m.spending.total)).toBe(spend);
      }),
      { numRuns: 25 },
    );
  });
});

describe('the month in review’s digest', () => {
  it('written later for an earlier month: nothing from after it, and nothing of today', async () => {
    await months();
    const code = (date: string, c: string): HmrcRecord => {
      const record = { type: 'tax-code' as const, date, code: c, cumulative: true, taxYear: '2026/27' };
      return { ...record, id: hmrcId(record), source: {}, createdAt: stamp };
    };
    await store.upsertRecords('hmrc', [code('2026-06-10', '1257L'), code('2026-08-10', 'K100')], 'h');
    await store.upsertRecords('insights', [insight({ subject: { month: '2026-06' }, watch: ['Whether groceries stay near £200'] }), insight({ subject: { month: '2026-06' }, status: 'superseded', title: 'Old' })], 'i');
    const a = new Analytics(store);
    const july = buildMonthDigest(store, a, { month: '2026-07', catchUp: true });
    expect(july).toMatchObject({ month: '2026-07', asOf: '2026-07-31', mode: 'catch-up' });
    expect(july).not.toHaveProperty('asOfToday');
    expect(july).not.toHaveProperty('ownerContext');
    expect(july.history.map((h) => h.month)).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', ...MONTHS.slice(0, 7)]);
    expect(july.hmrc.taxCodes.map((c) => c.code)).toEqual(['1257L']);
    expect(july.previousReview).toMatchObject({ month: '2026-06', title: 'A month', watch: ['Whether groceries stay near £200'] });
    // The maintenance agreement's first payment was due within 60 days: known, but not paid by then.
    expect(july.agreements).toEqual([expect.objectContaining({ id: 'maintenance', direction: 'in', payments: [{ due: '2026-08-21', amount: 1500, label: null, status: 'upcoming', paid: null }] })]);
    expect(JSON.stringify(july)).not.toContain('2026-08-12');

    const august = buildMonthDigest(store, a, { month: '2026-08' });
    expect(august).toMatchObject({ mode: 'latest' });
    expect(august).toHaveProperty('asOfToday.estate');
    expect(august.hmrc.taxCodes.map((c) => c.code)).toEqual(['1257L', 'K100']);
    expect(august.focus.transactions.largestSpending[0]).toMatchObject({ description: 'PAID TO UNIVERSITY OF EXAMPLE' });
  });

  it('a payment made after the day it is seen from was not paid by then', async () => {
    await months();
    await store.setAgreements([
      { id: 'sofa', name: 'Sofa on finance', counterparty: 'Example Sofa Co', names: [], category: 'home-garden', from: '2026-07-01', agreedOn: '2026-07-01', payments: [{ due: '2026-07-31', amount: 400 }], details: [], source: {}, createdBy: 'owner', createdAt: stamp, updatedAt: stamp },
    ]);
    const a = new Analytics(store);
    const july = buildMonthDigest(store, a, { month: '2026-07', catchUp: true });
    expect(july.agreements[0]!.payments[0]).toMatchObject({ due: '2026-07-31', status: 'not paid by then', paid: null });
    const august = buildMonthDigest(store, a, { month: '2026-08' });
    expect(august.agreements[0]!.payments[0]).toMatchObject({ status: 'paid', paid: { date: '2026-08-12' } });
  });
});

describe('a month in review’s output', () => {
  const out = (kinds: string[], extra: Record<string, unknown> = {}) => ({
    insights: kinds.map((kind) => ({ kind, pages: ['overview'], subject: { accountId: null, instrumentId: null, category: null, taxYear: null, month: null }, title: `A ${kind}`, body: 'Said.', confidence: 'medium', evidence: [{ type: 'computed', ids: null, id: null, metric: 'spending', value: 1, label: null }], expiresInDays: 30 })),
    watch: ['Whether the sofa was the last big payment', ''],
    followUp: [{ watch: 'Whether groceries stay near £200', outcome: 'done', note: 'They were £155.50.' }],
    ...extra,
  });
  const provenance = { setBy: 'agent' as const, model: 'test', promptVersion: 'monthly-review-4', jobId: 'job_new' };
  const ctx = (params: Record<string, unknown>) => ({ store, analytics: new Analytics(store), params, scratch: dir });

  it('carries what to watch and how the last lines turned out; written later, it is the month’s review alone', async () => {
    await months();
    await JOB_DEFS['monthly-review'].apply(ctx({ month: '2026-07', catchUp: true }), out(['month-review', 'habit']), provenance);
    const written = store.insights.filter((i) => i.status === 'active');
    expect(written.map((i) => i.kind)).toEqual(['month-review']);
    expect(written[0]).toMatchObject({ subject: { month: '2026-07' }, watch: ['Whether the sofa was the last big payment'], followUp: [{ watch: 'Whether groceries stay near £200', outcome: 'done', note: 'They were £155.50.' }], period: { from: '2026-07-01', to: '2026-07-31' } });
  });

  it('a rerun replaces every note an earlier review of the month wrote, and nothing else', async () => {
    await months();
    const old = [
      insight({ subject: { month: '2026-08' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-3', jobId: 'job_old' } }),
      insight({ kind: 'habit', subject: { month: '2026-08', category: 'groceries' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-3', jobId: 'job_old' } }),
      insight({ subject: { month: '2026-07' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-4', jobId: 'job_july' } }),
      insight({ kind: 'note', subject: { month: '2026-08' }, provenance: { setBy: 'owner' } }),
      insight({ kind: 'anomaly', subject: { month: '2026-08' }, provenance: { setBy: 'agent', promptVersion: 'insights-after-import-5', jobId: 'job_import' } }),
    ];
    await store.upsertRecords('insights', old, 'i');
    await JOB_DEFS['monthly-review'].apply(ctx({ month: '2026-08' }), out(['month-review']), provenance);
    const status = (id: string) => store.insights.find((i) => i.id === id)!.status;
    expect(old.map((i) => status(i.id))).toEqual(['superseded', 'superseded', 'active', 'active', 'active']);
    const fresh = store.insights.find((i) => i.provenance.jobId === 'job_new')!;
    expect(fresh.supersedes).toBe(old[0]!.id);
  });
});

describe('earlier months, reviewed oldest first', () => {
  it('queues the complete months before the latest with no review, and runs them oldest first', async () => {
    await months();
    await store.upsertRecords('insights', [insight({ subject: { month: '2026-03' } }), insight({ subject: { month: '2026-04' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-3' } })], 'i');
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    const runner = new JobRunner(store, new Analytics(store), config, { autoRun: false, paused: true });
    await runner.init();
    try {
      // March has a review by this version; April's is by an older one. August is the latest.
      const months = runner.catchUpMonths('2026-09-15');
      expect(months).toEqual(MONTHS.slice(0, 7).filter((m) => m !== '2026-03'));
      for (const month of ['2026-07', '2026-05', '2026-06']) runner.enqueue({ kind: 'monthly-review', params: { month, catchUp: true }, trigger: 'owner' });
      runner.enqueue({ kind: 'interpret-note', params: { noteId: 'note_1' }, trigger: 'owner' });
      await new Promise((r) => setTimeout(r, 20));
      expect(runner.nextJob()?.params.month).toBe('2026-05');
    } finally {
      runner.stop();
    }
  });
});

describe('GET /api/month/:month', () => {
  it('is a month not after this one', async () => {
    const { createApp } = await import('../src/server/app');
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'app'), FINANCE_WORK_DIR: path.join(dir, 'work2'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
    config.webDist = path.join(dir, 'no-web');
    const app = await createApp(config, { version: 'test', env: {}, inbox: false });
    try {
      const get = (p: string) => app.app.request(`http://localhost${p}`, { headers: { host: 'localhost' } });
      expect((await get('/api/month/2026-13')).status).toBe(400);
      expect((await get('/api/month/2999-01')).status).toBe(400);
      const res = await get('/api/month/2026-01');
      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text())).toMatchObject({ month: '2026-01', spending: { total: 0 } });
      expect(await readFile(path.join(dir, 'app', 'people.json'), 'utf8')).toContain('people');
    } finally {
      await app.close();
    }
  });
});
