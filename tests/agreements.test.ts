// Agreements to pay (agreements.json; FORMULAS.md §10, "Agreements"): an accommodation offer's
// schedule, added by a proposal the owner applies, files its payments under its category as they
// come and checks each against what was paid. Every figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgreementView, ProposalView } from '../src/shared/api';
import { defaultCategories, CategoryIndex } from '../src/shared/categories';
import { Categoriser } from '../src/shared/categorise';
import type { Account, Agreement, ProposalInput, Rule, Transaction } from '../src/shared/schema';
import { agreementView } from '../src/server/analytics/agreements';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { enrich } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';
const DD = 'DIRECT DEBIT PAYMENT TO EXAMPLE UNIVERSITY REF 300000000/FEERES';

const offer = (): Omit<Agreement, 'createdBy' | 'createdAt' | 'updatedAt'> => ({
  id: 'example-hall-2025-26',
  name: 'Example Hall room, 2025/26',
  counterparty: 'Example University',
  names: ['EXAMPLE UNI'],
  category: 'rent',
  from: '2025-09-13',
  until: '2026-06-20',
  total: 6720,
  payments: [
    { due: '2025-10-31', amount: 2240, label: 'Instalment 1' },
    { due: '2026-01-31', amount: 2240, label: 'Instalment 2' },
    { due: '2026-04-30', amount: 2240, label: 'Instalment 3' },
  ],
  details: [
    { label: 'Bedroom type', value: 'Standard ensuite' },
    { label: 'Let length', value: '40 weeks' },
  ],
  agreedOn: '2025-08-01',
  source: {},
});

describe('the categoriser and an agreement', () => {
  const account: Account = { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  const agreement: Agreement = { ...offer(), createdBy: 'owner', createdAt: stamp, updatedAt: stamp };
  const c = new Categoriser([], new CategoryIndex(defaultCategories()), [account], [], { agreements: [agreement] });
  const at = (date: string, amount: number, description = DD) => c.categorise({ accountId: 'current', description, amount, date });

  it('files a payment it schedules under its category, by its name, near a due date, for about what was due', () => {
    expect(at('2025-11-03', -2240)).toMatchObject({ category: 'rent', categorisedBy: 'agreement', payee: 'Example University' });
    // Another name its payments carry, and £200 less than was due (within a tenth).
    expect(at('2026-01-30', -2040, 'CARD PAYMENT TO EXAMPLE UNI (ACCOM')).toMatchObject({ category: 'rent', categorisedBy: 'agreement' });
    // Not: printing, a payment far from any due date, money in, or a row with no date.
    expect(at('2026-01-18', -1, 'EXAMPLE UNIVERSITY PRINTING').categorisedBy).toBeUndefined();
    expect(at('2025-08-20', -2240).categorisedBy).toBeUndefined();
    expect(at('2025-11-03', 2240).categorisedBy).toBeUndefined();
    expect(c.categorise({ accountId: 'current', description: DD, amount: -2240 }).categorisedBy).toBeUndefined();
    // A name is a whole word: "EXAMPLE UNIVERSAL" is someone else.
    expect(at('2025-11-03', -2240, 'EXAMPLE UNIVERSAL LTD').categorisedBy).toBeUndefined();
    // Made before the offer was: not its payment, though within 45 days of a due date.
    const early = new Categoriser([], new CategoryIndex(defaultCategories()), [account], [], { agreements: [{ ...agreement, agreedOn: '2025-10-01' }] });
    expect(early.categorise({ accountId: 'current', description: DD, amount: -2240, date: '2025-09-20' }).categorisedBy).toBeUndefined();
    expect(early.categorise({ accountId: 'current', description: DD, amount: -2240, date: '2025-10-02' }).categorisedBy).toBe('agreement');
  });

  it('gives way to your rules', () => {
    const rule: Rule = { id: 'rule_1', name: 'University', enabled: true, priority: 1, match: { field: 'description', op: 'contains', value: 'EXAMPLE UNIVERSITY', caseSensitive: false }, set: { category: 'courses' }, createdAt: stamp, updatedAt: stamp };
    const withRule = new Categoriser([rule], new CategoryIndex(defaultCategories()), [account], [], { agreements: [agreement] });
    expect(withRule.categorise({ accountId: 'current', description: DD, amount: -2240, date: '2025-11-03' })).toMatchObject({ category: 'courses', categorisedBy: 'rule' });
  });
});

describe('an agreement to pay', () => {
  let app: App;
  let dir: string;
  let agent: string;
  const tx = (date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId('current', date, amount, description, 0), accountId: 'current', date, amount, currency: 'GBP', description, source: {}, ...extra });
  const rows = {
    first: tx('2025-11-03', -2240, DD, { category: 'courses', categorisedBy: 'builtin', payee: 'Education' }),
    second: tx('2026-01-30', -2040, 'CARD PAYMENT TO EXAMPLE UNI (ACCOM'),
    printing: tx('2026-01-18', -1, 'EXAMPLE UNIVERSITY PRINTING'),
    charge: tx('2026-07-01', -16, DD, { category: 'rent', categorisedBy: 'user' }),
    // Rent before the offer was made: not this agreement's.
    before: tx('2025-07-20', -500, DD, { category: 'rent', categorisedBy: 'user' }),
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-agreements-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.addTransactions(Object.values(rows), 'test: payments');
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const proposal = (agreement = offer()): ProposalInput => ({ title: 'Your Example Hall offer', summary: 'Its offer page.', provenance: { model: 'test-model' }, changes: [{ key: 'offer', kind: 'add_agreement', why: 'The offer page gives the let, its total and three instalments.', agreement }] });
  const post = (p: ProposalInput) => req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(p) });
  const send = async (p: ProposalInput) => ({ body: (await (await post(p)).json()) as ProposalView });
  /** Why a proposal that does not fit is turned away, change by change. */
  const problems = async (p: ProposalInput) => {
    const r = await post(p);
    expect(r.status).toBe(422);
    return ((await r.json()) as { problems: { key: string; problem: string }[] }).problems;
  };

  it('an agent proposes it; applied, its payments in your data take its category, and its card checks the schedule', async () => {
    const { body: view } = await send(proposal());
    expect(view).toMatchObject({ ready: 1, problems: 0 });
    // It says which rows it files, and what each is now: not the printing, nor the one you categorised.
    expect(view.changes[0]!.files!.map((f) => [f.date, f.amount, f.category ?? null])).toEqual([
      ['2025-11-03', -2240, 'courses'],
      ['2026-01-30', -2040, null],
    ]);
    expect((await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' })).status).toBe(200);
    const { store } = app.ctx;
    expect(store.agreement('example-hall-2025-26')).toMatchObject({ name: 'Example Hall room, 2025/26', createdBy: 'agent', details: [{ label: 'Bedroom type' }, { label: 'Let length' }] });
    expect(store.transaction(rows.first.id)).toMatchObject({ category: 'rent', categorisedBy: 'agreement', payee: 'Example University' });
    expect(store.transaction(rows.second.id)).toMatchObject({ category: 'rent', categorisedBy: 'agreement' });
    expect(store.transaction(rows.printing.id)!.category).toBeUndefined();
    expect(store.transaction(rows.charge.id)).toMatchObject({ category: 'rent', categorisedBy: 'user' });

    // Categorising again keeps them: the categoriser files them the same way.
    await enrich(store);
    expect(store.transaction(rows.first.id)).toMatchObject({ category: 'rent', categorisedBy: 'agreement' });

    // Its card: each instalment with the payment found for it (the second £200 less), then the
    // others in its category around it, and what you paid in all.
    const a = store.agreement('example-hall-2025-26')!;
    const v = agreementView(store, a, '2026-05-10');
    expect(v.payments.map((p) => [p.label, p.status, p.paid?.date ?? null, p.paid?.amount ?? null, p.paid?.difference ?? null])).toEqual([
      ['Instalment 1', 'paid', '2025-11-03', 2240, null],
      ['Instalment 2', 'paid', '2026-01-30', 2040, -200],
      ['Instalment 3', 'due', null, null, null],
    ]);
    expect(v.others).toEqual([{ transactionId: rows.charge.id, accountId: 'current', date: '2026-07-01', amount: 16 }]);
    expect(v.paid).toBe(4296);
    expect(agreementView(store, a, '2026-04-01').payments[2]!.status).toBe('upcoming');
    expect(agreementView(store, a, '2026-06-20').payments[2]!.status).toBe('unseen');
    const [listed] = (await (await req('/api/agreements')).json()) as AgreementView[];
    expect(listed!.agreement.id).toBe('example-hall-2025-26');

    // The same again is done already; another schedule under its id does not fit.
    expect(await problems(proposal())).toEqual([{ key: 'offer', problem: 'Your data already says this: leave the change out.' }]);
    expect((await problems(proposal({ ...offer(), payments: [{ due: '2025-10-31', amount: 6720 }] })))[0]!.problem).toMatch(/There is an agreement example-hall-2025-26 already/);
  });

  it('a tenancy and its renewal: each month’s rent is one agreement’s, not the other’s', async () => {
    const { store } = app.ctx;
    const year = (id: string, from: string, months: string[]): Agreement => ({ id, name: id, counterparty: 'Example Lettings Ltd', names: [], category: 'rent', from, payments: months.map((m) => ({ due: `${m}-01`, amount: 900 })), details: [], source: {}, createdBy: 'owner', createdAt: stamp, updatedAt: stamp });
    await store.setAgreements([year('first', '2026-01-01', ['2026-01', '2026-02', '2026-03']), year('renewal', '2026-04-01', ['2026-04', '2026-05', '2026-06'])]);
    await store.addTransactions(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m) => tx(`${m}-01`, -900, 'EXAMPLE LETTINGS LTD RENT', { category: 'rent', categorisedBy: 'agreement' })), 'test: rent');
    const first = agreementView(store, store.agreement('first')!, '2026-05-10');
    expect(first.payments.map((p) => p.paid?.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    // April's rent is within 45 days of the first's end, but the renewal's April pairs with it.
    expect(first.others).toEqual([]);
    const renewal = agreementView(store, store.agreement('renewal')!, '2026-05-10');
    expect(renewal.payments.map((p) => [p.status, p.paid?.date ?? null])).toEqual([
      ['paid', '2026-04-01'],
      ['paid', '2026-05-01'],
      ['upcoming', null],
    ]);
    // March's rent is the first's.
    expect(renewal.others).toEqual([]);
    // Without April's payment, the renewal's April is not paid with March's rent: that is the first's.
    await store.deleteTransactions([tx('2026-04-01', -900, 'EXAMPLE LETTINGS LTD RENT').id], 'test: no April');
    expect(agreementView(store, store.agreement('renewal')!, '2026-05-10').payments[0]).toMatchObject({ status: 'due' });
    expect(agreementView(store, store.agreement('first')!, '2026-05-10').payments.map((p) => p.paid?.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('takes a spending category, and one that ends after it starts', async () => {
    expect((await problems(proposal({ ...offer(), category: 'salary' })))[0]!.problem).toMatch(/is not a spending category/);
    expect((await problems(proposal({ ...offer(), until: '2025-01-01' })))[0]!.problem).toBe('It would end before it starts.');
  });

  it('you change it yourself; an agent cannot', async () => {
    const { body: view } = await send(proposal());
    await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    const put = (body: unknown, headers: Record<string, string> = CSRF) => req('/api/agreements/example-hall-2025-26', { method: 'PUT', headers, body: JSON.stringify(body) });
    expect((await put({ notes: 'Paid by Direct Debit' })).status).toBe(200);
    expect(app.ctx.store.agreement('example-hall-2025-26')).toMatchObject({ notes: 'Paid by Direct Debit' });
    expect((await put({ category: 'salary' })).status).toBe(400);
    expect((await put({ notes: 'x' }, { ...CSRF, authorization: agent })).status).toBe(403);
  });
});
