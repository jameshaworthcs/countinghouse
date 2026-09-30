// Reading a stored document again (docs/INGESTION.md): comparing a new reading with what was
// recorded, and applying a difference as a correction or a new row. No test here reads anything:
// a real reading would spend the owner's Claude plan. All data here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import { sha256 } from '../src/server/fsutil';
import { documentId } from '../src/server/ids';
import { parseWithProfile, readCsvRows, suggestMapping } from '../src/server/ingest/csv';
import { compareRows } from '../src/server/ingest/reread';
import { ImportService } from '../src/server/ingest/service';
import { WorkArea } from '../src/server/ingest/workarea';
import { Store } from '../src/server/store';
import type { Reread } from '../src/shared/api';
import { ExtractionSchema, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const t = (id: string, date: string, amount: number, description: string, importId = 'imp_a'): Transaction => ({ id, accountId: 'current', date, amount, currency: 'GBP', description, source: { importId }, createdAt: stamp });

describe('comparing a new reading with what was recorded', () => {
  it('pairs rows: the same, read differently, read now only, recorded only', () => {
    const stored = [t('tx_1', '2026-09-01', -12.5, 'TESCO STORES'), t('tx_2', '2026-09-03', -72.5, 'SHELL GARAGE'), t('tx_3', '2026-09-05', -4, 'PRET A MANGER'), t('tx_4', '2026-09-09', -30, 'AMAZON'), t('tx_5', '2026-09-10', -9.99, 'NETFLIX', 'imp_b')];
    const read = [
      { date: '2026-09-01', amount: -12.5, description: 'TESCO STORES' },
      { date: '2026-09-03', amount: -12.5, description: 'SHELL GARAGE' },
      { date: '2026-09-06', amount: -4, description: 'PRET A MANGER' },
      { date: '2026-09-10', amount: -9.99, description: 'NETFLIX' },
      { date: '2026-09-11', amount: -20, description: 'BOOTS' },
    ];
    const rows = compareRows(read, stored, 'imp_a');
    expect(rows.map((r) => [r.kind, r.stored?.id ?? null, r.changes ?? null])).toEqual([
      ['same', 'tx_1', null],
      ['changed', 'tx_2', ['amount']],
      ['changed', 'tx_3', ['date']],
      ['missing', 'tx_4', null],
      // Recorded by another import: still the same row.
      ['same', 'tx_5', null],
      ['added', null, null],
    ]);
  });
});

describe('reading a stored document again', () => {
  let dir: string;
  let store: Store;
  let work: WorkArea;
  let svc: ImportService;
  const start = async () => {
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
  };
  /** A screenshot of three rows, committed into the current account. */
  const committed = async (): Promise<string> => {
    const bytes = Buffer.from('statement screenshot');
    const record: ImportRecord = {
      id: 'imp_20260920_120000_0001',
      status: 'review',
      createdAt: '2026-09-20T12:00:00+01:00',
      updatedAt: '2026-09-20T12:00:00+01:00',
      origin: 'upload',
      hintAccountId: 'current',
      document: { id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: 'IMG_0001.PNG', mediaType: 'image/png', size: bytes.length, capturedOn: '2026-09-20', capturedOnSource: 'exif' },
      extraction: { engine: 'claude-cli', engineVersion: 'extract-6', warnings: [], raw: ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ accountName: 'Current', transactions: [{ date: '2026-09-01', description: 'TESCO STORES', amount: -12.5 }, { date: '2026-09-03', description: 'SHELL GARAGE', amount: -72.5 }] }] }) },
    };
    await work.init();
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    await start();
    await svc.refreshDraft(record.id);
    await svc.commit(record.id);
    return record.id;
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-reread-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    work = new WorkArea(path.join(dir, 'work'));
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('only when turned on, and only for what Claude read', async () => {
    const id = await committed();
    await expect(svc.startReread(id)).rejects.toThrow('Reading stored documents again is off: turn it on in Settings → Import & extraction.');
    expect(svc.getReread(id)).toBeUndefined();
  });

  it('a difference is applied only when you choose: a correction that keeps what was recorded, or a new row', async () => {
    const id = await committed();
    const shell = store.transactions('current').find((x) => x.description === 'SHELL GARAGE')!;
    const reread: Reread = {
      importId: id,
      status: 'done',
      startedAt: '2026-09-29T10:00:00+01:00',
      finishedAt: '2026-09-29T10:01:00+01:00',
      engine: 'claude-cli',
      model: 'claude-sonnet-5-5',
      engineVersion: 'extract-9',
      previousVersion: 'extract-6',
      sections: [
        {
          accountId: 'current',
          accountName: 'Current',
          balance: null,
          rows: [
            { key: 'r1', kind: 'changed', stored: { id: shell.id, date: shell.date, amount: shell.amount, description: shell.description }, read: { date: '2026-09-03', amount: -12.5, description: 'SHELL GARAGE' }, changes: ['amount'] },
            { key: 'r2', kind: 'added', read: { date: '2026-09-05', amount: -4, description: 'PRET A MANGER' } },
          ],
        },
      ],
      notes: [],
    };
    await work.saveReread(reread);
    await start();
    const after = await svc.applyReread(id, 'r1');
    expect(after.sections[0]!.rows[0]!.applied).toBe(true);
    const fixed = store.transaction(shell.id)!;
    expect(fixed.amount).toBe(-12.5);
    expect(fixed.corrections).toEqual([expect.objectContaining({ field: 'amount', from: -72.5, to: -12.5, note: 'Read again with extract-9 (Sonnet)' })]);
    await svc.applyReread(id, 'r2');
    const added = store.transactions('current').find((x) => x.description === 'PRET A MANGER')!;
    expect(added).toMatchObject({ date: '2026-09-05', amount: -4, source: { importId: id }, notes: 'Read again with extract-9 (Sonnet)' });
    await expect(svc.applyReread(id, 'r2')).rejects.toThrow('Nothing to apply there.');
    // Forgotten, it is gone from the work area too.
    await svc.forgetReread(id);
    await start();
    expect(svc.getReread(id)).toBeUndefined();
  });

  it('a CSV is parsed again on this machine with the layout that fits it now, whatever the setting', async () => {
    const text = 'Date,Time,Transaction Type,Transaction Description,Amount,Currency,Balance\n12 August 2026,12:07,Transfer,To Revolving Line Account,-45.67,GBP,954.33\n3 September 2026,08:44,Payment,From A N OTHER - CHASE-TOPUP,500.00,GBP,"1,454.33"\n';
    const bytes = Buffer.from(text);
    // Committed with the type column taken for the description, as a guessed mapping once did.
    const { rows } = readCsvRows(text);
    const { type: _type, ...columns } = suggestMapping(rows)!.profile.columns;
    const guessed = { ...suggestMapping(rows)!.profile, columns: { ...columns, description: ['Transaction Type'] } };
    const record: ImportRecord = {
      id: 'imp_20260930_073000_00c5',
      status: 'review',
      createdAt: '2026-09-30T07:30:00+01:00',
      updatedAt: '2026-09-30T07:30:00+01:00',
      origin: 'upload',
      hintAccountId: 'current',
      document: { id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: 'Statement.csv', mediaType: 'text/csv', size: bytes.length },
      extraction: { engine: 'csv', engineVersion: 'csv-1', detail: 'auto-detected', warnings: [], raw: parseWithProfile(rows, { profile: guessed, headerIndex: 0, headerless: false }).extraction },
    };
    await work.init();
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    await start();
    await svc.refreshDraft(record.id);
    await svc.commit(record.id);
    // Since then the card payment was found recorded twice and this import's copy taken away.
    const copy = store.transactions('current').find((x) => x.description === 'Transfer')!;
    await store.deleteTransactions([copy.id], 'test: the copy taken away');
    await store.addTransactions([{ ...t('tx_00000000000000b1', '2026-08-12', -45.67, 'To Credit Card', 'imp_20260829_100000_0a01'), balanceAfter: 954.33 }], 'test: the statement’s row');

    const r = await svc.startReread(record.id);
    expect(r).toMatchObject({ status: 'done', engine: 'csv', layout: 'the Chase UK layout' });
    expect(r.sections[0]!.rows.map((x) => [x.kind, x.stored?.description, x.read?.description, x.changes ?? null])).toEqual([
      // The same balance after it: the statement's row, not a row to add again.
      ['same', 'To Credit Card', 'To Revolving Line Account', null],
      ['changed', 'Payment', 'From A N OTHER - CHASE-TOPUP', ['description']],
    ]);
    await svc.applyReread(record.id, r.sections[0]!.rows[1]!.key);
    const fixed = store.transactions('current').find((x) => x.description === 'From A N OTHER - CHASE-TOPUP')!;
    expect(fixed).toMatchObject({ amount: 500, type: 'Payment', corrections: [expect.objectContaining({ field: 'description', from: 'Payment', to: 'From A N OTHER - CHASE-TOPUP', note: 'Read again with the Chase UK layout' })] });
    expect(fixed.payee).not.toBe('Payment');
  });

  it('a reading the app stopped in the middle of says so after a restart', async () => {
    await work.init();
    await work.saveReread({ importId: 'imp_20260920_120000_0009', status: 'running', startedAt: stamp, sections: [], notes: [] });
    await start();
    expect(svc.getReread('imp_20260920_120000_0009')).toMatchObject({ status: 'failed', error: 'Stopped when the app restarted: read it again.' });
  });
});

