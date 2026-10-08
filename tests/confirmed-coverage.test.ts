// Coverage beyond documents: what the balances say about days no document covers, screenshots and
// mid-day balances that add up exactly, stretches you confirmed, and the range you gave an export
// (docs/FORMULAS.md §3 and §9).

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { BalanceEngine } from '../src/server/analytics/balances';
import { accountCoverage, Coverage } from '../src/server/analytics/coverage';
import { loadConfig } from '../src/server/config';
import { balanceId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { requiredScope } from '../src/server/tokens';
import type { CoverageGapView } from '../src/shared/api';
import { confirmableTo, settledStretches, settledThrough } from '../src/shared/coverage';
import type { Account, BalanceSnapshot, DraftSection, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, extra: Partial<Account> = {}): Account => ({ id, name: id, type: 'credit_card', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, 'SHOP', n++), accountId, date, amount, currency: 'GBP', description: 'SHOP', source: {}, ...extra });
const bal = (accountId: string, date: string, balance: number, kind: BalanceSnapshot['kind'] = 'statement', extra: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  id: balanceId(accountId, date, balance, kind, String(n++)),
  accountId,
  date,
  balance,
  currency: 'GBP',
  kind,
  source: {},
  createdAt: stamp,
  ...extra,
});

describe('coverage beyond documents', () => {
  let dir: string;
  let store: Store;
  let k = 0;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-confirmed-'));
    store = await Store.open(path.join(dir, 'data'));
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** A committed import of one section for `card`. */
  async function document(section: Partial<DraftSection>, documentType: 'credit_card_statement' | 'csv_export' = 'credit_card_statement') {
    const id = `imp_20260101_000000_${(k++).toString(16).padStart(4, '0')}`;
    const full = { key: 's0', detected: {}, target: { mode: 'existing' as const, accountId: 'card' }, currency: 'GBP', recordBalance: false, transactions: [], recordHoldings: false, holdings: [], ...section };
    await store.saveImport(
      {
        id,
        status: 'committed',
        createdAt: stamp,
        updatedAt: stamp,
        origin: 'upload',
        document: { id: `doc_${k.toString(16).padStart(16, '0')}`, sha256: '0'.repeat(64), fileName: 'f', mediaType: 'application/pdf', size: 1 },
        extraction: { warnings: [] },
        draft: { documentType, sections: [full], figures: [], notes: [] },
        result: { accountIds: ['card'], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
      },
      'test import',
    );
  }

  /** January and April statements, nothing for February and March. */
  async function quietCard(aprilOpening: number) {
    await store.setAccounts([acct('card', { openedOn: '2026-01-01' })]);
    await store.addTransactions([tx('card', '2026-01-10', -50), tx('card', '2026-04-12', -20)], 'test');
    await document({ periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, balance: -50 });
    await document({ periodStart: '2026-04-01', periodEnd: '2026-04-30', openingBalance: aprilOpening, balance: aprilOpening - 20 });
    await store.addBalances([bal('card', '2026-01-31', -50), bal('card', '2026-04-30', aprilOpening - 20)], 'test');
  }

  it('says whether the balances add up across the days no document covers', async () => {
    await quietCard(-50);
    const engine = new BalanceEngine(store);
    const gaps = new Coverage(store).gaps(engine, '2026-01-01', '2026-04-30');
    expect(gaps).toEqual([{ accountId: 'card', name: 'card', from: '2026-02-01', to: '2026-03-31', days: 59, rows: 0, evidence: { status: 'adds-up', from: '2026-01-31', to: '2026-04-30', through: '2026-03-31', difference: 0 } }]);
  });

  it('says what is unexplained when they do not', async () => {
    await quietCard(-80);
    const [gap] = new Coverage(store).gaps(new BalanceEngine(store), '2026-01-01', '2026-04-30');
    expect(gap!.evidence).toEqual({ status: 'unexplained', from: '2026-01-31', to: '2026-04-30', through: '2026-03-31', difference: -30 });
  });

  it('with nothing before a stretch, starts from the £0 the account opened with, and says so', async () => {
    await store.setAccounts([acct('card', { openedOn: '2026-01-01' })]);
    await store.addTransactions([tx('card', '2026-01-05', -10), tx('card', '2026-03-02', -5)], 'test');
    await store.addBalances([bal('card', '2026-03-31', -15)], 'test');
    expect(new BalanceEngine(store).evidence('card', '2026-01-01', '2026-02-28')).toEqual({ status: 'adds-up', from: '2025-12-31', to: '2026-03-31', through: '2026-02-28', difference: 0, fromOpening: true });
    // Without a known opening day there is nothing before it to go by.
    await store.setAccounts([acct('card')]);
    expect(new BalanceEngine(store).evidence('card', '2026-01-01', '2026-02-28')).toEqual({ status: 'no-balance' });
  });

  it('speaks only up to the last balance when the stretch runs past it', async () => {
    await store.setAccounts([acct('card')]);
    await store.addTransactions([tx('card', '2026-01-10', -50)], 'test');
    await store.addBalances([bal('card', '2026-01-31', -50), bal('card', '2026-03-15', -50, 'manual')], 'test');
    expect(new BalanceEngine(store).evidence('card', '2026-02-01', '2026-04-10')).toEqual({ status: 'adds-up', from: '2026-01-31', to: '2026-03-15', through: '2026-03-15', difference: 0 });
    expect(new BalanceEngine(store).evidence('card', '2026-03-20', '2026-04-10')).toEqual({ status: 'no-balance', from: '2026-03-15' });
  });

  it('counts a screenshot or a mid-day balance only when it adds up exactly', async () => {
    await store.setAccounts([acct('card')]);
    await store.addTransactions([tx('card', '2026-01-10', -50), tx('card', '2026-02-10', -30), tx('card', '2026-02-20', -5)], 'test');
    // Adds up at the close of its day: the gap check now runs to it.
    await store.addBalances([bal('card', '2026-01-31', -50), bal('card', '2026-02-20', -85, 'screenshot', { at: '2026-02-20T21:00:00+00:00' })], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.evidence('card', '2026-02-01', '2026-02-20')).toMatchObject({ status: 'adds-up', to: '2026-02-20' });
    expect(engine.gaps('card')).toEqual([]);
  });

  it('counts one seen before its day’s rows at the close of the day before', async () => {
    await store.setAccounts([acct('card')]);
    await store.addTransactions([tx('card', '2026-01-10', -50), tx('card', '2026-02-20', -5)], 'test');
    // −50 on the 20th, before the −5 posted: the close of the 19th.
    await store.addBalances([bal('card', '2026-01-31', -50), bal('card', '2026-02-20', -50, 'screenshot')], 'test');
    expect(new BalanceEngine(store).evidence('card', '2026-02-01', '2026-02-25')).toEqual({ status: 'adds-up', from: '2026-01-31', to: '2026-02-19', through: '2026-02-19', difference: 0 });
  });

  it('leaves out a screenshot that does not add up, as before', async () => {
    await store.setAccounts([acct('card')]);
    await store.addTransactions([tx('card', '2026-01-10', -50)], 'test');
    await store.addBalances([bal('card', '2026-01-31', -50), bal('card', '2026-02-20', -90, 'screenshot')], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.evidence('card', '2026-02-01', '2026-02-20')).toEqual({ status: 'no-balance', from: '2026-01-31' });
    expect(engine.gaps('card')).toEqual([]);
  });

  it('a stretch you confirmed counts as covered', async () => {
    await quietCard(-50);
    expect(accountCoverage(store, store.account('card')!).intervals).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-04-01', to: '2026-04-30' },
    ]);
    await store.setCoverageConfirmations([{ id: 'cov_0123456789ab', accountId: 'card', from: '2026-02-01', to: '2026-03-31', confirmedAt: stamp }]);
    expect(accountCoverage(store, store.account('card')!).intervals).toEqual([{ from: '2026-01-01', to: '2026-04-30' }]);
    const cov = new Coverage(store);
    expect(cov.gaps(new BalanceEngine(store), '2026-01-01', '2026-04-30')).toEqual([]);
    expect(cov.joint('2026-01-01', '2026-04-30').completeMonths).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('an export covers the range you gave it, not just its first row to its last', async () => {
    await store.setAccounts([acct('card')]);
    const rows = [
      { key: 't0', include: true, status: 'new' as const, date: '2026-01-07', amount: -5, description: 'SHOP' },
      { key: 't1', include: true, status: 'new' as const, date: '2026-01-29', amount: -5, description: 'SHOP' },
    ];
    // The CSV reader takes its period from its rows.
    await document({ periodStart: '2026-01-07', periodEnd: '2026-01-29', transactions: rows, coversFrom: '2026-01-01', coversTo: '2026-01-31' }, 'csv_export');
    expect(accountCoverage(store, store.account('card')!).intervals).toEqual([{ from: '2026-01-01', to: '2026-01-31' }]);
    // A range inside its rows never narrows it.
    await document({ periodStart: '2026-02-03', periodEnd: '2026-02-20', transactions: rows.map((r, i) => ({ ...r, date: i ? '2026-02-20' : '2026-02-03' })), coversFrom: '2026-02-10' }, 'csv_export');
    expect(accountCoverage(store, store.account('card')!).intervals).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-03', to: '2026-02-20' },
    ]);
  });
});

describe('what can be confirmed', () => {
  const gap = (from: string, to: string, evidence: CoverageGapView['evidence']): CoverageGapView => ({ accountId: 'card', name: 'card', from, to, days: 1, rows: 0, evidence });
  const addsUp = (through: string) => ({ status: 'adds-up' as const, from: '2026-01-31', to: through, through, difference: 0 });

  it('settles at the end of the month before last', () => {
    expect(settledThrough('2026-10-02')).toBe('2026-08-31');
    expect(settledThrough('2026-10-31')).toBe('2026-08-31');
    expect(settledThrough('2026-11-01')).toBe('2026-09-30');
    expect(settledThrough('2026-03-15')).toBe('2026-01-31');
    expect(settledThrough('2026-01-05')).toBe('2025-11-30');
  });

  it('confirms one stretch as far as its balances reach, never today, and never one that leaves something unexplained', () => {
    expect(confirmableTo(gap('2026-09-05', '2026-10-02', addsUp('2026-09-30')), '2026-10-02')).toBe('2026-09-30');
    expect(confirmableTo(gap('2026-09-05', '2026-10-02', { status: 'no-balance', from: '2026-09-04' }), '2026-10-02')).toBe('2026-10-01');
    expect(confirmableTo(gap('2026-10-02', '2026-10-02', { status: 'no-balance', from: '2026-10-01' }), '2026-10-02')).toBeNull();
    expect(confirmableTo(gap('2026-02-01', '2026-03-31', { status: 'unexplained', from: '2026-01-31', to: '2026-04-30', through: '2026-03-31', difference: -30 }), '2026-10-02')).toBeNull();
  });

  it('confirming all keeps to settled days: capped, or left for the monthly update', () => {
    const now = '2026-10-02';
    expect(
      settledStretches(
        [
          gap('2026-03-29', '2026-10-02', addsUp('2026-09-30')), // capped at 31 Aug
          gap('2026-09-29', '2026-10-02', addsUp('2026-09-30')), // all recent: left
          gap('2025-12-12', '2025-12-31', addsUp('2025-12-31')), // settled: whole
          gap('2026-06-03', '2026-07-01', { status: 'no-balance', from: '2026-06-02' }), // only one at a time
        ],
        now,
      ),
    ).toEqual([
      { accountId: 'card', from: '2026-03-29', to: '2026-08-31' },
      { accountId: 'card', from: '2025-12-12', to: '2025-12-31' },
    ]);
  });
});

describe('confirming coverage through the API', () => {
  let app: App;
  let dir: string;
  const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-confirmed-api-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });

  it('confirms, lists and withdraws a stretch; no token can', async () => {
    expect((await req('/api/accounts', { method: 'POST', headers: CSRF, body: JSON.stringify({ name: 'Card', type: 'credit_card' }) })).status).toBe(201);
    const post = (stretches: unknown) => req('/api/coverage/confirmations', { method: 'POST', headers: CSRF, body: JSON.stringify({ stretches }) });
    expect((await post([{ accountId: 'card', from: '2026-02-01', to: '2999-01-01' }])).status).toBe(400);
    expect((await post([{ accountId: 'nope', from: '2026-02-01', to: '2026-02-28' }])).status).toBe(404);
    const ok = await post([{ accountId: 'card', from: '2026-02-01', to: '2026-02-28' }]);
    expect(ok.status).toBe(200);
    const { added } = (await ok.json()) as { added: { id: string; evidence: { status: string } }[] };
    expect(added).toHaveLength(1);
    expect(added[0]!.evidence.status).toBe('no-balance');
    // The same stretch again adds nothing.
    expect(((await (await post([{ accountId: 'card', from: '2026-02-01', to: '2026-02-28' }])).json()) as { added: unknown[] }).added).toHaveLength(0);
    const health = (await (await req('/api/data-health')).json()) as { confirmations: { id: string; name: string }[] };
    expect(health.confirmations.map((c) => c.name)).toEqual(['Card']);
    expect((await req(`/api/coverage/confirmations/${added[0]!.id}`, { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect(((await (await req('/api/data-health')).json()) as { confirmations: unknown[] }).confirmations).toEqual([]);
    expect(requiredScope('POST', '/api/coverage/confirmations')).toBeNull();
    expect(requiredScope('DELETE', `/api/coverage/confirmations/${added[0]!.id}`)).toBeNull();
  });

  it('keeps the reason you give, trimmed, and none for a blank one', async () => {
    expect((await req('/api/accounts', { method: 'POST', headers: CSRF, body: JSON.stringify({ name: 'Old bank', type: 'current' }) })).status).toBe(201);
    const post = (stretches: unknown) => req('/api/coverage/confirmations', { method: 'POST', headers: CSRF, body: JSON.stringify({ stretches }) });
    const res = await post([
      { accountId: 'old-bank', from: '2025-04-06', to: '2025-07-31', note: '  No statements: next to no interest  ' },
      { accountId: 'old-bank', from: '2025-08-01', to: '2025-08-31', note: '   ' },
    ]);
    const { added } = (await res.json()) as { added: { note?: string }[] };
    expect(added.map((c) => c.note)).toEqual(['No statements: next to no interest', undefined]);
    const health = (await (await req('/api/data-health')).json()) as { confirmations: { from: string; note?: string }[] };
    expect(health.confirmations.find((c) => c.from === '2025-04-06')?.note).toBe('No statements: next to no interest');
  });
});
