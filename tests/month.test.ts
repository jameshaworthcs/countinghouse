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
import { buildMonthDigest, monthTransactionsFile } from '../src/server/agents/digest';
import { JobRunner } from '../src/server/agents/jobs';
import { JOB_DEFS, uncheckedFigures } from '../src/server/agents/kinds';
import { Analytics } from '../src/server/analytics';
import { flows } from '../src/server/analytics/cashflow';
import { loadConfig } from '../src/server/config';
import { balanceId, hmrcId, transactionId } from '../src/server/ids';
import { ProposalService } from '../src/server/proposals';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { toMinor } from '../src/shared/money';
import type { Account, Agreement, HmrcRecord, Insight, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, seq++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });
/** The month in review's prompt version now: a review by it stands. */
const REVIEW_VERSION = JOB_DEFS['monthly-review'].promptVersion;
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
  provenance: { setBy: 'agent', promptVersion: REVIEW_VERSION, jobId: 'job_a' },
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
    // Where it went, adding up: kept in the bank and the saver; what the loan lent and paid comes to nothing.
    expect(m.whereItWent.total).toBe(2156.99);
    expect(m.whereItWent.items.map((i) => [i.id, i.amount])).toEqual([['cash', 2156.99]]);
    expect(m.whereItWent.items[0]!.parts).toEqual([
      { id: 'bank', name: 'bank', amount: 1956.94 },
      { id: 'saver', name: 'saver', amount: 200.05 },
    ]);
    // By category: groceries against the months before, with each of the 12 months' amounts.
    const groceries = m.categories.top.find((c) => c.id === 'groceries')!;
    expect(groceries).toMatchObject({ amount: 155.5, count: 2, compared: { median: 155.5, months: 7 } });
    expect(groceries.history).toHaveLength(12);
    expect(groceries.history.at(-1)).toEqual({ month: '2026-08', amount: 155.5, complete: true });
    expect(groceries.history[0]).toMatchObject({ month: '2025-09', amount: 0, complete: false });
    // Its group nets off the £30 Alex paid back for dinner, filed under eating out.
    expect(m.categories.groups.find((g) => g.id === groceries.group!.id)!.amount).toBe(125.5);
  });

  it('where it went names money sent to accounts the app doesn’t know, paid onto cards and into an ISA, and always adds up', async () => {
    await months();
    await store.setAccounts([...store.accounts, acct('card', 'credit_card')]);
    await store.addTransactions(
      [
        tx('bank', '2026-08-27', -250, 'FASTER PAYMENT TO EXAMPLE BROKER', { category: 'investment-transfer', categorisedBy: 'user' }),
        tx('bank', '2026-08-28', -300, 'TO ISA', { category: 'investment-transfer', categorisedBy: 'transfer', transferGroup: 'tg_isa', counterpartyAccountId: 'isa' }),
        tx('isa', '2026-08-28', 300, 'SUBSCRIPTION', { category: 'contribution', categorisedBy: 'transfer', transferGroup: 'tg_isa', counterpartyAccountId: 'bank' }),
        tx('card', '2026-08-05', -80, 'EXAMPLE CAFE', { category: 'eating-out', categorisedBy: 'user' }),
        tx('bank', '2026-08-29', -100, 'CARD PAYMENT', { category: 'credit-card-payment', categorisedBy: 'transfer', transferGroup: 'tg_card', counterpartyAccountId: 'card' }),
        tx('card', '2026-08-29', 100, 'PAYMENT RECEIVED', { category: 'credit-card-payment', categorisedBy: 'transfer', transferGroup: 'tg_card', counterpartyAccountId: 'bank' }),
      ],
      't',
    );
    const w = new Analytics(store).month('2026-08').whereItWent;
    const item = (id: string) => w.items.find((i) => i.id === id);
    expect(item('unknown')).toMatchObject({ amount: 250, parts: [{ name: 'Example Broker', amount: 250, count: 1 }] });
    expect(item('invested')).toMatchObject({ amount: 300, parts: [{ id: 'isa', amount: 300 }] });
    expect(item('cards')!.amount).toBe(20);
    expect(item('unexplained')).toBeUndefined();
    expect(w.items.reduce((s, i) => s + toMinor(i.amount), 0)).toBe(toMinor(w.total));
  });

  it('counts cash paid in still to confirm, and what rests on a category the bank or the reader guessed', async () => {
    await months();
    await store.addTransactions(
      [
        tx('bank', '2026-08-23', 60, 'CASH PAID IN AT ATM EXAMPLETOWN'),
        tx('bank', '2026-08-24', -40, 'EXAMPLE STUDIO', { category: 'courses', categorisedBy: 'bank' }),
        tx('bank', '2026-08-25', 25, 'EXAMPLE PRIZE DRAW', { category: 'other-income', categorisedBy: 'ai' }),
      ],
      't',
    );
    const m = new Analytics(store).month('2026-08');
    // The reader's gift from someone is theirs to confirm, not a guess; the cash is uncategorised money in until you say.
    expect(m.quality).toMatchObject({
      peopleToConfirm: { count: 1, in: 50, out: 0 },
      cashToConfirm: { count: 1, amount: 60 },
      uncategorisedIn: 72.34,
      guessedSpending: 40,
      guessedSpendingShare: 0.01,
      guessedIn: 25,
      guessedInShare: 0.012,
    });
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
  const evidence = [{ type: 'computed', ids: null, id: null, metric: 'focus.spending.total', value: 1, label: null }];
  const out = (kinds: string[], extra: Record<string, unknown> = {}) => ({
    review: {
      title: 'July: the sofa, and groceries steady',
      keyPoints: [
        { text: 'A £400 sofa was the month’s one big payment.', evidence: [{ type: 'transactions', ids: ['tx_0000000000000000'], id: null, metric: null, value: null, label: 'not a real id' }, ...evidence] },
        { text: '  ', evidence: [] },
      ],
      sections: [
        { id: 'month', heading: 'The month', body: 'Pay of £2,000 came in.' },
        { id: 'now', heading: 'What to do now', body: 'Use your ISA allowance.' },
      ],
      caveats: ['Typical rests on six months.'],
      confidence: 'medium',
      evidence,
    },
    insights: kinds.map((kind) => ({ kind, pages: ['overview'], subject: { accountId: null, instrumentId: null, category: null, taxYear: null, month: null }, title: `A ${kind}`, body: 'Said.', confidence: 'medium', evidence, expiresInDays: 30 })),
    watch: ['Whether the sofa was the last big payment', ''],
    followUp: [{ watch: 'Whether groceries stay near £200', outcome: 'not-happened', note: 'They were £155.50.' }],
    proposals: [],
    ...extra,
  });
  const provenance = { setBy: 'agent' as const, model: 'test', promptVersion: REVIEW_VERSION, jobId: 'job_new' };
  const ctx = (params: Record<string, unknown>, proposals?: ProposalService) => ({ store, analytics: new Analytics(store), params, scratch: dir, ...(proposals ? { proposals } : {}) });

  it('keeps its title, key points, parts and new limits; written later, it is the month’s review alone, with nothing about now', async () => {
    await months();
    await JOB_DEFS['monthly-review'].apply(ctx({ month: '2026-07', catchUp: true }), out(['habit']), provenance, ['£999.99']);
    const written = store.insights.filter((i) => i.status === 'active');
    expect(written.map((i) => i.kind)).toEqual(['month-review']);
    expect(written[0]).toMatchObject({
      title: 'July: the sofa, and groceries steady',
      subject: { month: '2026-07' },
      keyPoints: [{ text: 'A £400 sofa was the month’s one big payment.', evidence: [{ type: 'computed', metric: 'focus.spending.total' }] }],
      sections: [{ id: 'month', heading: 'The month', body: 'Pay of £2,000 came in.' }],
      caveats: ['Typical rests on six months.'],
      watch: ['Whether the sofa was the last big payment'],
      followUp: [{ watch: 'Whether groceries stay near £200', outcome: 'not-happened', note: 'They were £155.50.' }],
      unchecked: ['£999.99'],
      period: { from: '2026-07-01', to: '2026-07-31' },
    });
    expect(written[0]!.body).toBe('The month\nPay of £2,000 came in.');
  });

  it('proposes the fixes it found, leaving out a change that does not fit the data', async () => {
    await months();
    const proposals = ProposalService.forWorkDir(store, path.join(dir, 'work'));
    await proposals.init();
    const rent = store.transactions('bank').find((t) => t.description === 'EXAMPLE LETTINGS RENT' && t.date === '2026-07-01')!;
    await JOB_DEFS['monthly-review'].apply(
      ctx({ month: '2026-07' }, proposals),
      out([], {
        proposals: [
          {
            title: 'Rent to Example Lettings',
            summary: 'The same £900 goes to Example Lettings on the 1st of every month, uncategorised.',
            changes: [
              { kind: 'set_category', why: 'Rent, on the 1st as every month.', transaction: rent.id, category: 'rent', note: null, rule: null },
              { kind: 'set_category', why: 'No such payment.', transaction: 'tx_ffffffffffffffff', category: 'rent', note: null, rule: null },
              { kind: 'add_rule', why: 'Every month the same payee.', transaction: null, category: 'rent', note: null, rule: { name: 'Example Lettings', field: 'description', op: 'contains', value: 'EXAMPLE LETTINGS', direction: 'out' } },
            ],
          },
        ],
      }),
      provenance,
    );
    const pending = proposals.list().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposal.changes.map((c) => c.kind)).toEqual(['set_category', 'add_rule']);
    const review = store.insights.find((i) => i.kind === 'month-review' && i.status === 'active')!;
    expect(review.proposals).toEqual([pending[0]!.proposal.id]);
  });

  it('a rerun replaces every note an earlier review of the month wrote, and nothing else', async () => {
    await months();
    const old = [
      insight({ subject: { month: '2026-08' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-3', jobId: 'job_old' } }),
      insight({ kind: 'habit', subject: { month: '2026-08', category: 'groceries' }, provenance: { setBy: 'agent', promptVersion: 'monthly-review-3', jobId: 'job_old' } }),
      insight({ subject: { month: '2026-07' }, provenance: { setBy: 'agent', promptVersion: REVIEW_VERSION, jobId: 'job_july' } }),
      insight({ kind: 'note', subject: { month: '2026-08' }, provenance: { setBy: 'owner' } }),
      insight({ kind: 'anomaly', subject: { month: '2026-08' }, provenance: { setBy: 'agent', promptVersion: 'insights-after-import-5', jobId: 'job_import' } }),
    ];
    await store.upsertRecords('insights', old, 'i');
    await JOB_DEFS['monthly-review'].apply(ctx({ month: '2026-08' }), out(['month-review']), provenance);
    const status = (id: string) => store.insights.find((i) => i.id === id)!.status;
    expect(old.map((i) => status(i.id))).toEqual(['superseded', 'superseded', 'active', 'active', 'active']);
    const fresh = store.insights.find((i) => i.provenance.jobId === 'job_new' && i.kind === 'month-review')!;
    expect(fresh.supersedes).toBe(old[0]!.id);
    // The latest month keeps its part about now; a second month-review among the other notes is not kept.
    expect(fresh.sections!.map((x) => x.id)).toEqual(['month', 'now']);
    expect(store.insights.filter((i) => i.provenance.jobId === 'job_new')).toHaveLength(1);
  });

  it('finds the figures it quotes that are not in the data, to the penny, or to the pound when written so', () => {
    const known = { exact: new Set([155_50, 2_000_00, 1_055_50]), pounds: new Set([156, 2000, 1056]) };
    expect(uncheckedFigures(['Groceries were £155.50, pay £2,000 and spending £1,056.', 'About £3,000 went to savings.', '−£155.50 back'], known)).toEqual([]);
    expect(uncheckedFigures(['Groceries were £155.51 and rent £900.', 'The ISA is worth £120k.'], known)).toEqual(['£155.51', '£900']);
  });
});

describe('the month in review’s digest, version 5', () => {
  it('has every earlier review in short, the year’s payees, trips, who each payment was with, and a file of payments to search up to the month’s end', async () => {
    await months();
    await store.addTransactions(
      [
        tx('bank', '2026-06-03', -120, 'EXAMPLE AIR', { category: 'holidays', categorisedBy: 'user' }),
        tx('bank', '2026-06-06', -45, 'EXAMPLE TAVERNA', { category: 'holidays', categorisedBy: 'user' }),
        tx('bank', '2026-07-20', -30, 'EXAMPLE MUSEUM', { category: 'holidays', categorisedBy: 'user' }),
      ],
      't',
    );
    await store.upsertRecords('insights', [insight({ subject: { month: '2026-05' }, title: 'May', caveats: ['Typical rests on four months.'], keyPoints: [{ text: 'Rent rose.' }] }), insight({ subject: { month: '2026-06' }, title: 'June' })], 'i');
    const a = new Analytics(store);
    const july = buildMonthDigest(store, a, { month: '2026-07', catchUp: true });
    expect(july.earlierReviews.map((r) => [r.month, r.title, r.keyPoints, r.caveats])).toEqual([
      ['2026-05', 'May', ['Rent rose.'], ['Typical rests on four months.']],
      ['2026-06', 'June', [], []],
    ]);
    expect(july.payeesYear[0]).toMatchObject({ payee: 'Example Lettings Rent', total: 6300, count: 7, months: 7, thisMonth: 900 });
    // The two June days are one trip; July's museum is another, small but on its own.
    expect(july.trips.map((t) => [t.from, t.to, t.spent])).toEqual([['2026-06-03', '2026-06-06', 165]]);
    expect(july.focus.transactions.moneyIn[0]).toHaveProperty('person');
    const file = monthTransactionsFile(store, a, '2026-07');
    expect(file).toContain('EXAMPLE MUSEUM');
    expect(file).not.toContain('2026-08-');
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
