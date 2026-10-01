// An account's terms (terms.jsonl; FORMULAS.md §4, "Terms"): its rates, limit and a card's minimum
// payment as each document gives them, kept once, shown with how they changed and what ends soon,
// and the rate projections use. Every figure is invented.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProposalView } from '../src/shared/api';
import { ExtractionSchema, type Account, type ImportRecord, type Terms } from '../src/shared/schema';
import { accountParams, makeResolver } from '../src/server/analytics/params';
import { BalanceEngine } from '../src/server/analytics/balances';
import { termsAlerts, termsView } from '../src/server/analytics/terms';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { termsId } from '../src/server/ids';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { assessNovelty } from '../src/server/ingest/novelty';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const terms = (accountId: string, asOf: string, content: Partial<Terms>, importId = `imp_${asOf.replace(/-/g, '')}_090000_0001`): Terms => ({ id: termsId(accountId, asOf, { importId }), accountId, asOf, rates: [], source: { importId }, createdAt: stamp, ...content });

describe('format v7 migration', () => {
  it('moves the credit limit and rate each balance kept into terms, once a day', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-v7-'));
    try {
      const data = path.join(dir, 'data');
      await mkdir(path.join(data, 'balances'), { recursive: true });
      await writeFile(path.join(data, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 6, baseCurrency: 'GBP', createdAt: stamp }));
      await writeFile(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [acct('card', 'credit_card'), acct('saver', 'savings')] }));
      const bal = (id: string, accountId: string, date: string, extra: Record<string, unknown>, importId = `imp_${date.replace(/-/g, '')}_090000_0001`) => JSON.stringify({ id, accountId, date, balance: -100, currency: 'GBP', kind: 'statement', source: { importId, documentId: `doc_${id.slice(4)}` }, createdAt: stamp, ...extra });
      await writeFile(path.join(data, 'balances', 'card.jsonl'), [bal('bal_00000000000000a1', 'card', '2025-10-02', { creditLimit: 500, interestRate: 41.208 }), bal('bal_00000000000000a2', 'card', '2025-11-03', { creditLimit: 1600 }), bal('bal_00000000000000a3', 'card', '2025-12-03', {})].join('\n') + '\n');
      // A statement and a screenshot of one day with the same rate: one record. A rate that is no rate stays.
      await writeFile(path.join(data, 'balances', 'saver.jsonl'), [bal('bal_00000000000000b1', 'saver', '2026-03-31', { interestRate: 4.25 }), bal('bal_00000000000000b2', 'saver', '2026-03-31', { interestRate: 4.25, kind: 'screenshot' }, 'imp_20260331_100000_0002'), bal('bal_00000000000000b3', 'saver', '2026-04-30', { interestRate: 425 })].join('\n') + '\n');
      const logged: string[] = [];
      expect(await runMigrations(data, (m) => logged.push(m))).toMatchObject({ from: 6, to: 8 });
      const store = await Store.open(data);
      expect(store.issues).toEqual([]);
      expect(store.terms('card').map((t) => [t.asOf, t.limit ?? null, t.rates])).toEqual([
        ['2025-10-02', 500, [{ applies: 'purchases', rate: 41.208 }]],
        ['2025-11-03', 1600, []],
      ]);
      expect(store.terms('saver')).toMatchObject([{ asOf: '2026-03-31', rates: [{ applies: 'interest', rate: 4.25, basis: 'AER' }], source: { importId: 'imp_20260331_090000_0001' } }]);
      // The balances keep their money, not the terms.
      const card = (await readFile(path.join(data, 'balances', 'card.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(card.some((b) => 'creditLimit' in b || 'interestRate' in b)).toBe(false);
      expect((await readFile(path.join(data, 'balances', 'saver.jsonl'), 'utf8')).match(/interestRate/g)).toHaveLength(1);
      expect(logged.join('\n')).toMatch(/left on its balance: saver 2026-04-30/);
      store.stopWatching();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('terms from a statement', () => {
  let dir: string;
  let store: Store;
  let workFile: string;
  const record = (id: string, docId: string): ImportRecord => ({ id, status: 'review', createdAt: '2026-09-02T09:00:00+01:00', updatedAt: '2026-09-02T09:00:00+01:00', origin: 'upload', hintAccountId: 'card', document: { id: docId, sha256: 'ab'.repeat(32), fileName: 'statement.pdf', mediaType: 'application/pdf', size: 1 }, extraction: { warnings: [] } });
  // A card statement read in full: its limit, its rates (a promotional one with its end) and minimum payment.
  const reading = () =>
    ExtractionSchema.parse({
      documentType: 'credit_card_statement',
      documentDate: '2026-09-02',
      accounts: [
        {
          accountName: 'Card',
          accountType: 'credit_card',
          closingBalance: -87.4,
          balanceDate: '2026-09-01',
          creditLimit: 10000,
          terms: {
            rates: [
              { applies: 'purchases', rate: 0, basis: 'simple', until: '2027-03-31', balance: 87.4, label: 'Promotional purchases' },
              { applies: 'purchases', rate: 24.9, basis: 'simple', variable: true, label: 'Standard purchases' },
              { applies: 'cash', rate: 24.9, basis: 'simple', variable: true },
            ],
            minimumPayment: 5,
            paymentDue: '2026-09-27',
          },
          transactions: [],
        },
      ],
    });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-terms-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('card', 'credit_card')]);
    workFile = path.join(dir, 'statement.pdf');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('are kept as the account’s terms on its date, whether or not its balance is; the same again is nothing new', async () => {
    const first = record('imp_20260902_090000_0a01', 'doc_00000000000000a1');
    const draft = buildDraft(reading(), { store, document: first.document, hintAccountId: 'card', uploadedOn: '2026-09-02' });
    expect(draft.sections[0]).toMatchObject({ creditLimit: 10000, terms: { minimumPayment: 5, paymentDue: '2026-09-27' } });
    const done = await commitDraft(store, { record: first, draft: { ...draft, sections: [{ ...draft.sections[0]!, recordBalance: false }] }, workFile });
    expect(done.result).toMatchObject({ termsAdded: 1, balancesAdded: 0 });
    expect(store.terms('card')).toMatchObject([{ asOf: '2026-09-01', limit: 10000, minimumPayment: 5, paymentDue: '2026-09-27', source: { importId: first.id, documentId: 'doc_00000000000000a1' } }]);
    expect(store.terms('card')[0]!.rates).toHaveLength(3);

    // The same statement uploaded again: its terms are already here.
    const again = record('imp_20260902_100000_0a02', 'doc_00000000000000a1');
    const draft2 = buildDraft(reading(), { store, document: again.document, hintAccountId: 'card', uploadedOn: '2026-09-02' });
    const pending = { ...again, draft: { ...draft2, sections: [{ ...draft2.sections[0]!, recordBalance: false }] } } as ImportRecord;
    expect(assessNovelty([pending], store).get(again.id)?.reason).toMatch(/its terms \(rates and limit\) are already recorded/);
  });

  it('the reader’s rates are kept as printed, not as money, with their dates and amounts repaired', () => {
    const { extraction, warnings } = normaliseExtraction({
      documentType: 'credit_card_statement',
      accounts: [{ accountName: 'Card', transactions: [], terms: { rates: [{ applies: 'purchases', rate: 40.876, basis: 'simple', variable: null, until: null, balance: null, label: 'Standard purchases' }, { applies: 'purchases', rate: '0%', basis: null, variable: null, until: '31 Mar 2027', balance: '£2,716.30', label: 'Promotional purchases' }, { applies: 'purchases', rate: 2.104, per: 'month', basis: null, variable: null, until: null, balance: null, label: 'Purchases' }, { applies: 'nonsense', rate: 1, basis: null, variable: null, until: null, balance: null, label: null }], minimumPayment: '£72.00', paymentDue: '27/05/2026' } }],
    });
    expect(extraction.accounts[0]!.terms).toEqual({
      rates: [
        { applies: 'purchases', rate: 40.876, basis: 'simple', label: 'Standard purchases' },
        { applies: 'purchases', rate: 0, until: '2027-03-31', balance: 2716.3, label: 'Promotional purchases' },
        // A monthly rate stays a month's: it is not made into a year's.
        { applies: 'purchases', rate: 2.104, per: 'month', label: 'Purchases' },
      ],
      minimumPayment: 72,
      paymentDue: '2026-05-27',
    });
    expect(warnings.join(' ')).toMatch(/a rate it prints could not be kept \(4\)/);
  });
});

describe('an account’s terms over time', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-terms-view-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('card', 'credit_card'), acct('saver', 'savings'), acct('old-card', 'credit_card', { status: 'closed', closedOn: '2026-01-01' })]);
    await store.upsertRecords(
      'terms',
      [
        terms('card', '2025-10-02', { limit: 500, rates: [{ applies: 'purchases', rate: 41.208, basis: 'simple' }] }),
        terms('card', '2025-11-03', { limit: 1500, rates: [{ applies: 'purchases', rate: 41.208, basis: 'simple' }] }),
        terms('card', '2026-09-01', { limit: 2400, rates: [{ applies: 'purchases', rate: 34.94, basis: 'simple', variable: true }, { applies: 'purchases', rate: 0, until: '2026-10-20', balance: 241.85, label: 'Promotional purchases' }], minimumPayment: 5, paymentDue: '2026-09-27' }),
        terms('saver', '2026-09-30', { rates: [{ applies: 'interest', rate: 4.25, basis: 'AER', variable: true, until: '2026-10-01', label: 'Boosted rate' }] }),
        terms('old-card', '2025-12-01', { rates: [{ applies: 'purchases', rate: 0, until: '2026-10-15' }] }),
      ],
      'test: terms',
    );
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('shows the latest, how the limit and rates changed, and what ends within 60 days', () => {
    const v = termsView(store, 'card', '2026-10-01');
    expect(v).toMatchObject({ limit: { asOf: '2026-09-01', value: 2400 }, minimum: { amount: 5, due: '2026-09-27' }, rates: { asOf: '2026-09-01' } });
    expect(v.records).toBe(3);
    expect(v.changes.map((c) => [c.what, c.from ?? null, c.to])).toEqual([
      ['limit', null, 500],
      ['purchases', null, 41.208],
      ['limit', 500, 1500],
      ['limit', 1500, 2400],
      ['purchases', 41.208, 34.94],
    ]);
    expect(v.ending.map((e) => [e.rate.label, e.rate.until, e.days])).toEqual([['Promotional purchases', '2026-10-20', 19]]);
    // On the overview: open accounts only, and only what has not ended.
    expect(termsAlerts(store, '2026-10-01').map((a) => a.title)).toEqual(['card: Promotional purchases at 0% ends on 20 Oct 2026', 'saver: Boosted rate at 4.25% ends today']);
    expect(termsAlerts(store, '2026-10-02').map((a) => a.title)).toEqual(['card: Promotional purchases at 0% ends on 20 Oct 2026']);
  });

  it('a later document that gives only the limit does not hide the rates the one before gave', async () => {
    await store.upsertRecords('terms', [terms('card', '2026-09-30', { limit: 3000 }, 'imp_20260930_120000_0002')], 'test: a screenshot');
    const v = termsView(store, 'card', '2026-10-01');
    expect(v.limit).toMatchObject({ asOf: '2026-09-30', value: 3000 });
    expect(v.rates).toMatchObject({ asOf: '2026-09-01', rates: [{ rate: 34.94 }, { label: 'Promotional purchases' }] });
    expect(v.minimum).toMatchObject({ asOf: '2026-09-01' });
    expect(v.ending).toHaveLength(1);
  });

  it('projections take the rate a saver’s latest terms give, and not once it has ended', () => {
    const engine = new BalanceEngine(store);
    const saver = store.account('saver')!;
    expect(accountParams(store, engine, makeResolver(store, '2026-09-30'), saver, '2026-09-30').interest).toMatchObject({ source: 'statement', value: 0.0425, basis: 'Rate on your document of 30 Sep 2026, until 1 Oct 2026' });
    const after = accountParams(store, engine, makeResolver(store, '2026-10-02'), saver, '2026-10-02').interest!;
    expect(after.source).not.toBe('statement');
    expect(after.basis).toMatch(/your 4.25% ended on 1 Oct 2026/);
  });
});

describe('an agent sets an account’s terms from its document', () => {
  let app: App;
  let dir: string;
  let agent: string;
  const imp = 'imp_20260902_090000_0a01';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-set-terms-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.setAccounts([acct('card', 'credit_card')]);
    await store.saveImport({ id: imp, status: 'committed', createdAt: stamp, updatedAt: stamp, committedAt: stamp, origin: 'upload', document: { id: 'doc_00000000000000a1', sha256: 'ab'.repeat(32), fileName: 'Statement_Sep_2026.pdf', mediaType: 'application/pdf', size: 1 }, extraction: { warnings: [] } } as unknown as ImportRecord, 'test: import');
    // What the reading kept: the limit, and the purchase rate as its one rate.
    await store.upsertRecords('terms', [{ id: termsId('card', '2026-09-01', { importId: imp, documentId: 'doc_00000000000000a1' }), accountId: 'card', asOf: '2026-09-01', limit: 10000, rates: [{ applies: 'purchases', rate: 24.9 }], source: { importId: imp, documentId: 'doc_00000000000000a1' }, createdAt: stamp }], 'test: terms');
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
  const change = (extra: Record<string, unknown> = {}) => ({
    key: 'sep',
    kind: 'set_terms',
    why: 'The statement prints a 0% promotional purchase rate until 31 Mar 2027 on £87.40, and a standard rate of 24.90% variable.',
    account: 'card',
    asOf: '2026-09-01',
    importId: imp,
    terms: { limit: 10000, rates: [{ applies: 'purchases', rate: 0, until: '2027-03-31', balance: 87.4, label: 'Promotional purchases' }, { applies: 'purchases', rate: 24.9, basis: 'simple', variable: true, label: 'Standard purchases' }], minimumPayment: 5, paymentDue: '2026-09-27' },
    ...extra,
  });
  const post = (changes: unknown[]) => req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ title: 'Your card’s terms', summary: 'From its statements.', provenance: { model: 'test-model' }, changes }) });

  it('they replace what the reading kept for that day; the proposal shows what they replace', async () => {
    const res = await post([change()]);
    expect(res.status).toBe(201);
    const view = (await res.json()) as ProposalView;
    expect(view.changes[0]!.terms).toEqual({ fileName: 'Statement_Sep_2026.pdf', before: { rates: [{ applies: 'purchases', rate: 24.9 }], limit: 10000 } });
    expect((await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' })).status).toBe(200);
    const [t] = app.ctx.store.terms('card');
    expect(t).toMatchObject({ asOf: '2026-09-01', minimumPayment: 5, rates: [{ label: 'Promotional purchases', until: '2027-03-31' }, { label: 'Standard purchases' }] });
    expect(app.ctx.store.terms('card')).toHaveLength(1);
    // Again: done already. Not from a document of yours, nor in the future, nor with nothing in it.
    const problems = async (c: Record<string, unknown>) => ((await (await post([c])).json()) as { problems: { problem: string }[] }).problems[0]!.problem;
    expect(await problems(change())).toBe('Your data already says this: leave the change out.');
    expect(await problems(change({ importId: 'imp_20260101_090000_ffff' }))).toMatch(/is not one of your documents/);
    expect(await problems(change({ asOf: '2099-01-01' }))).toMatch(/is in the future/);
    expect(await problems(change({ terms: { rates: [] } }))).toBe('It gives no rate, limit or minimum payment.');
  });
});
