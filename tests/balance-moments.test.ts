// When on its day a balance was seen, and figures you typed yourself (docs/FORMULAS.md §9).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { balanceByYou, balanceSeenAt, commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { runMigrations } from '../src/server/migrations';
import { Store } from '../src/server/store';
import { today } from '../src/shared/dates';
import { ExtractionSchema, type Account, type BalanceSnapshot, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const bank: Account = { id: 'bank', name: 'Bank', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, last4: '1234', createdAt: stamp, updatedAt: stamp };
let n = 0;
const bal = (date: string, balance: number, kind: BalanceSnapshot['kind'], extra: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  id: `bal_${String(++n).padStart(16, '0')}`,
  accountId: 'bank',
  date,
  balance,
  currency: 'GBP',
  kind,
  source: {},
  createdAt: stamp,
  ...extra,
});
const tx = (date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: `tx_${String(++n).padStart(16, '0')}`,
  accountId: 'bank',
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  ...extra,
});

describe('balances of one day', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-moments-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([bank]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('takes the later: your £1 at 18:26, a payment, then the £0 you typed from the confirmation at 22:59', async () => {
    await store.addTransactions([tx('2026-09-30', -1, 'EXAMPLE PAYEE TOPUP')], 'test');
    await store.addBalances(
      [
        bal('2026-04-14', 1, 'statement'),
        bal('2026-09-30', 1, 'manual', { at: '2026-09-30T18:26:19+01:00' }),
        bal('2026-09-30', 0, 'screenshot', { at: '2026-09-30T22:59:10+01:00', enteredBy: 'user' }),
      ],
      'test',
    );
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('bank', '2026-09-30')!.value).toBe(0);
    expect(engine.balanceOn('bank', '2026-10-01')!.value).toBe(0);
    // Seen mid-day, before a payment of the day that has no time: neither can show a gap.
    expect(engine.gaps('bank')).toEqual([]);
  });

  it('still keeps your balance over an untimed screenshot, and a close over a balance seen mid-day', async () => {
    await store.addBalances([bal('2026-09-10', 5, 'manual'), bal('2026-09-10', 9, 'screenshot'), bal('2026-09-20', 7, 'manual', { at: '2026-09-20T09:00:00+01:00' }), bal('2026-09-20', 6, 'statement')], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('bank', '2026-09-10')!.value).toBe(5);
    expect(engine.balanceOn('bank', '2026-09-20')!.value).toBe(6);
  });

  it('lets a later screenshot stand for the day over your earlier balance, but not for gap checks', async () => {
    await store.addBalances([bal('2026-09-01', 10, 'statement'), bal('2026-09-30', 10, 'manual', { at: '2026-09-30T09:00:00+01:00' }), bal('2026-09-30', 4, 'screenshot', { at: '2026-09-30T21:00:00+01:00' })], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('bank', '2026-09-30')!.value).toBe(4);
    expect(engine.gaps('bank')).toEqual([]);
  });

  it('weighs a figure you typed from a screenshot as your own: it outranks the screenshot and shows a gap', async () => {
    await store.addTransactions([tx('2026-09-15', -1, 'SHOP')], 'test');
    await store.addBalances([bal('2026-09-01', 10, 'statement'), bal('2026-09-30', 9, 'screenshot'), bal('2026-09-30', 8, 'screenshot', { enteredBy: 'user' })], 'test');
    const engine = new BalanceEngine(store);
    expect(engine.balanceOn('bank', '2026-09-30')!.value).toBe(8);
    expect(engine.gaps('bank')).toEqual([{ from: '2026-09-01', to: '2026-09-30', difference: -1 }]);
  });

  it('checks a balance seen mid-day when every row of its day came before it', async () => {
    await store.addTransactions([tx('2026-09-30', -1, 'CAFE', { time: '08:15' })], 'test');
    await store.addBalances([bal('2026-09-01', 10, 'statement'), bal('2026-09-30', 7, 'manual', { at: '2026-09-30T12:00:00+01:00' })], 'test');
    expect(new BalanceEngine(store).gaps('bank')).toEqual([{ from: '2026-09-01', to: '2026-09-30', difference: -2 }]);
    // A row of the day after it: the balance could be right before it, so no gap is claimed.
    await store.addTransactions([tx('2026-09-30', -2, 'SHOP', { time: '18:40' })], 'test');
    expect(new BalanceEngine(store).gaps('bank')).toEqual([]);
  });
});

describe('an imported balance you typed', () => {
  it('is one the draft did not propose; a draft from before compares with the reading, sign aside', () => {
    expect(balanceByYou({ key: 's0', balance: 0, readBalance: null }, undefined)).toBe(true);
    expect(balanceByYou({ key: 's0', balance: -50, readBalance: -50 }, undefined)).toBe(false);
    expect(balanceByYou({ key: 's0', balance: 50, readBalance: -50 }, undefined)).toBe(true);
    expect(balanceByYou({ key: 's0', balance: undefined, readBalance: null }, undefined)).toBe(false);
    const reading = ExtractionSchema.parse({ documentType: 'credit_card_statement', accounts: [{ closingBalance: 50 }] });
    expect(balanceByYou({ key: 's0', balance: -50 }, reading)).toBe(false);
    expect(balanceByYou({ key: 's0', balance: -40 }, reading)).toBe(true);
    expect(balanceByYou({ key: 's0', balance: -40 }, undefined)).toBe(false);
  });

  it('is seen when you typed it, on that day; a screenshot’s when it was taken; a statement’s at the close', () => {
    const now = '2026-09-30T22:59:10+01:00';
    const shot = '2026-09-30T22:44:18+01:00';
    expect(balanceSeenAt('2026-09-30', 'screenshot', true, shot, now)).toBe(now);
    expect(balanceSeenAt('2026-09-30', 'screenshot', false, shot, now)).toBe(shot);
    expect(balanceSeenAt('2026-09-29', 'screenshot', true, shot, now)).toBeUndefined();
    expect(balanceSeenAt('2026-09-30', 'statement', false, shot, now)).toBeUndefined();
  });

  describe('committed', () => {
    let dir: string;
    let store: Store;
    let workFile: string;
    const on = today();
    const capturedAt = `${on}T00:00:05+01:00`;
    const record: ImportRecord = {
      id: 'imp_20260930_224430_0b01',
      status: 'review',
      createdAt: stamp,
      updatedAt: stamp,
      origin: 'upload',
      document: { id: 'doc_00000000000000b1', sha256: 'b1'.repeat(32), fileName: 'IMG_0002.png', mediaType: 'image/png', size: 1, capturedOn: on, capturedOnSource: 'exif', capturedAt },
      extraction: { warnings: [] },
    };
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'finance-typed-'));
      store = await Store.open(path.join(dir, 'data'));
      await store.setAccounts([bank]);
      workFile = path.join(dir, 'IMG_0002.png');
      await writeFile(workFile, 'x');
    });
    afterEach(async () => {
      store.stopWatching();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    it('from a payment confirmation with no balance, is yours and as of when you committed it', async () => {
      const reading = ExtractionSchema.parse({ documentType: 'other', accounts: [{ last4: '1234', transactions: [{ date: on, description: 'EXAMPLE PAYEE TOPUP', amount: -1 }] }] });
      const draft = buildDraft(reading, { store, document: record.document, uploadedOn: on });
      expect(draft.sections[0]).toMatchObject({ readBalance: null, recordBalance: false });
      Object.assign(draft.sections[0]!, { balance: 0, recordBalance: true });
      await commitDraft(store, { record: { ...record, extraction: { warnings: [], raw: reading } }, draft, workFile });
      const [b] = store.balances('bank');
      expect(b).toMatchObject({ balance: 0, kind: 'screenshot', enteredBy: 'user' });
      expect(b!.at!.slice(0, 10)).toBe(on);
      expect(b!.at! >= capturedAt).toBe(true);
    });

    it('as read, is the screenshot’s, seen when it was taken', async () => {
      const reading = ExtractionSchema.parse({ documentType: 'account_overview_screenshot', accounts: [{ last4: '1234', closingBalance: 25 }] });
      const draft = buildDraft(reading, { store, document: record.document, uploadedOn: on });
      expect(draft.sections[0]!.readBalance).toBe(25);
      await commitDraft(store, { record: { ...record, extraction: { warnings: [], raw: reading } }, draft, workFile });
      const [b] = store.balances('bank');
      expect(b).toMatchObject({ balance: 25, at: capturedAt });
      expect(b).not.toHaveProperty('enteredBy');
    });
  });
});

describe('format v3 migration', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-migrate3-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('says when balances were seen and which imported figures you typed', async () => {
    await mkdir(path.join(dir, 'balances'), { recursive: true });
    await mkdir(path.join(dir, 'imports', '2026'), { recursive: true });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 2, baseCurrency: 'GBP', createdAt: stamp }));
    const typed = 'imp_20260930_224430_0c01';
    const read = 'imp_20260930_100000_0c02';
    const imp = (id: string, closingBalance: number | null, balance: number) => ({
      id,
      document: { capturedOn: '2026-09-30', capturedAt: '2026-09-30T22:44:18+01:00' },
      extraction: { raw: { accounts: [{ closingBalance }] } },
      draft: { sections: [{ key: 's0', recordBalance: true, balance, balanceDate: '2026-09-30' }] },
      result: { sections: [{ key: 's0', accountId: 'bank' }] },
    });
    await writeFile(path.join(dir, 'imports', '2026', `${typed}.json`), JSON.stringify(imp(typed, null, 0)));
    await writeFile(path.join(dir, 'imports', '2026', `${read}.json`), JSON.stringify(imp(read, 3, 3)));
    const lines = [
      bal('2026-04-14', 1, 'statement', { source: { importId: 'imp_20260930_182614_0c03' } }),
      bal('2026-09-30', 1, 'manual', { createdAt: '2026-09-30T18:26:19+01:00' }),
      bal('2026-08-01', 2, 'manual', { createdAt: '2026-09-30T18:27:00+01:00' }),
      bal('2026-09-30', 0, 'screenshot', { createdAt: '2026-09-30T22:59:10+01:00', source: { importId: typed } }),
      bal('2026-09-30', 3, 'screenshot', { createdAt: '2026-09-30T23:10:00+01:00', source: { importId: read } }),
    ];
    await writeFile(path.join(dir, 'balances', 'bank.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    expect(await runMigrations(dir, () => undefined)).toMatchObject({ from: 2, to: 11 });
    const out = (await readFile(path.join(dir, 'balances', 'bank.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as BalanceSnapshot);
    expect(out.map((b) => [b.balance, b.at ?? null, b.enteredBy ?? null])).toEqual([
      [1, null, null],
      [1, '2026-09-30T18:26:19+01:00', null],
      [2, null, null],
      [0, '2026-09-30T22:59:10+01:00', 'user'],
      [3, '2026-09-30T22:44:18+01:00', null],
    ]);
  });
});
