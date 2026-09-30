// A platform's holdings export (docs/INGESTION.md) gives no asset classes, no date and no cash. The
// model takes each fund's asset class from the latest statement that gave one, the export is dated
// by its file, and its funds become instruments whether or not agents are on. All data here is
// invented.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { accountParams, makeResolver } from '../src/server/analytics/params';
import { createApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { readCsvRows } from '../src/server/ingest/csv';
import { decodeText } from '../src/server/ingest/detect';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { parseHoldingsCsv } from '../src/server/ingest/holdings-csv';
import { recordInstrumentsFromHoldings } from '../src/server/instruments';
import { Store } from '../src/server/store';
import { ExtractionSchema, type Account, type DocumentRef, type Holding, type HoldingsSnapshot } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
let snaps = 0;
const snap = (accountId: string, date: string, holdings: Holding[]): HoldingsSnapshot => ({
  id: `hld_${(++snaps).toString(16).padStart(16, '0')}`,
  accountId,
  date,
  holdings,
  totalValue: holdings.reduce((s, h) => s + h.value, 0),
  source: {},
  createdAt: stamp,
});
const fund = (name: string, ids: Partial<Holding>, value = 1000): Holding => ({ name, units: 10, value, currency: 'GBP', ...ids });
const doc = (fileName: string, lastModified?: string, mediaType = 'text/csv'): DocumentRef => ({ id: 'doc_0000000000000001', sha256: '0'.repeat(64), fileName, mediaType, size: 1, ...(lastModified ? { lastModified } : {}) });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-holdings-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([acct('isa', 'stocks_isa'), acct('sipp', 'sipp')]);
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('an export with no asset classes', () => {
  it('takes each fund’s from the latest statement that gave one, in any account', async () => {
    await store.addHoldings(
      [
        snap('sipp', '2025-06-01', [fund('Example Income Fund £ Inc', { sedol: 'B0000C4', assetClass: 'bond' })]),
        snap('sipp', '2026-09-20', [fund('Example Gilt ETF', { ticker: 'XGLT', assetClass: 'bond' })]),
        snap('isa', '2026-09-29', [fund('Example Global Index Fund Acc', { sedol: 'B3X7QG6', assetClass: 'equity' }, 3000), fund('Example Income Fund £ Inc', { sedol: 'B0000C4', assetClass: 'mixed' })]),
        // The export: the same funds, one new, and no asset class on any of them.
        snap('isa', '2026-09-30', [
          fund('Example Global Index Fund Acc', { sedol: 'B3X7QG6' }, 3000),
          fund('Example Income Fund £ Inc', { sedol: 'B0000C4' }),
          fund('Example Gilt ETF GBP', { ticker: 'XGLT' }),
          fund('Example New Fund Acc', { sedol: 'B1111D5' }),
        ]),
      ],
      'h',
    );
    await store.addBalances([{ id: 'bal_0000000000000001', accountId: 'isa', date: '2026-09-30', balance: 6000, currency: 'GBP', kind: 'export', source: {}, createdAt: stamp }], 'b');
    const params = accountParams(store, new BalanceEngine(store), makeResolver(store, '2026-09-30'), store.account('isa')!, '2026-09-30');
    const by = new Map(params.holdings.map((h) => [h.name, h]));
    expect(by.get('Example Global Index Fund Acc')).toMatchObject({ exposure: { equity: 1 }, exposureSource: 'statement', exposureBasis: 'Asset class from the statement of 29 Sep 2026 (shares); the latest holdings give none' });
    // The latest statement to give one wins over an older one.
    expect(by.get('Example Income Fund £ Inc')).toMatchObject({ exposure: { mixed: 1 }, exposureSource: 'statement' });
    // Another account's statement, by ticker, under a name printed differently.
    expect(by.get('Example Gilt ETF GBP')).toMatchObject({ exposure: { bond: 1 }, exposureSource: 'statement' });
    expect(by.get('Example Gilt ETF GBP')!.exposureBasis).toContain('20 Sep 2026');
    // No statement ever gave one: still the labelled fallback.
    expect(by.get('Example New Fund Acc')).toMatchObject({ exposure: { mixed: 1 }, exposureSource: 'fallback' });
  });
});

describe('an export with no date in it', () => {
  const rows = () => readCsvRows(decodeText(readFileSync(path.join(import.meta.dirname, 'fixtures', 'ii-holdings.csv')))).rows;
  const draftFor = (fileName: string, lastModified?: string) => buildDraft(parseHoldingsCsv(rows(), fileName)!, { store, document: doc(fileName, lastModified), hintAccountId: 'isa', uploadedOn: '2026-09-30' });

  it('is dated by its file name, else the day the file was saved, and keeps the growth it prints', () => {
    expect(draftFor('ii-29-09-2026-ISA.csv', '2026-09-30T12:04:19.293Z').sections[0]).toMatchObject({ balanceDate: '2026-09-29', balanceDateSource: 'filename' });
    const saved = draftFor('f47ac10b-58cc-4372-a567-0e02b2c3d479.csv', '2026-09-30T12:04:19.293Z');
    expect(saved.sections[0]).toMatchObject({ balance: 8978.1, balanceDate: '2026-09-30', balanceDateSource: 'file-modified', gain: 1478.1 });
    expect(draftIsClean(saved).reasons).not.toContain('balance date unknown');
    // Saved after it was uploaded: a clock out of step, so the upload day, to check.
    expect(draftFor('export.csv', '2026-10-02T12:00:00Z').sections[0]).toMatchObject({ balanceDate: '2026-09-30', balanceDateSource: 'upload' });
  });

  it('never dates a statement by its file: one downloaded today can be last year’s', () => {
    const statement = ExtractionSchema.parse({ documentType: 'pension_statement', accounts: [{ accountType: 'sipp', closingBalance: 1000 }] });
    const draft = buildDraft(statement, { store, document: doc('statement.pdf', '2026-09-30T12:00:00Z', 'application/pdf'), hintAccountId: 'sipp', uploadedOn: '2026-09-30' });
    expect(draft.sections[0]).toMatchObject({ balanceDateSource: 'upload' });
  });
});

describe('funds become instruments with agents off', () => {
  it('as the app’s own record, not an agent’s, in the audit trail', async () => {
    await store.addHoldings([snap('isa', '2026-09-29', [fund('Example Global Index Fund Acc', { sedol: 'B3X7QG6' })])], 'h');
    const messages: string[] = [];
    store.on('change', (e: { message: string }) => messages.push(e.message));
    expect(await recordInstrumentsFromHoldings(store)).toBe(1);
    expect(messages).toEqual(['instruments: 1 by the app (holdings)']);
  });

  it('when the app starts, for funds already held', async () => {
    await store.setSettings({ ...store.settings, agents: { ...store.settings.agents, enabled: false } });
    await store.addHoldings([snap('isa', '2026-09-29', [fund('Example Global Index Fund Acc', { sedol: 'B3X7QG6' }), fund('Example World ETF', { ticker: 'XMPL' })])], 'h');
    store.stopWatching();
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_INBOX_DIR: path.join(dir, 'inbox'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    const app = await createApp(config, { version: 'test', env: {}, inbox: false });
    try {
      expect(app.ctx.store.instruments.map((i) => [i.name, i.sedol ?? i.ticker])).toEqual([
        ['Example Global Index Fund Acc', 'B3X7QG6'],
        ['Example World ETF', 'XMPL'],
      ]);
    } finally {
      await app.close();
    }
  });
});
