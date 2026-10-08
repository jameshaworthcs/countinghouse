// Linking the two legs of a transfer while both wait for review (src/server/ingest/links.ts): a
// pending link on both rows, which becomes a link to the recorded transaction when one is committed
// and a transfer when both are. Nothing here reads a document; all data is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import { sha256 } from '../src/server/fsutil';
import { documentId } from '../src/server/ids';
import { ImportService } from '../src/server/ingest/service';
import { WorkArea } from '../src/server/ingest/workarea';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { ExtractionSchema, type Account, type ImportRecord } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });

describe('linking transfers before commit', () => {
  let dir: string;
  let store: Store;
  let work: WorkArea;
  let svc: ImportService;
  let n = 0;

  /** An import waiting for review: a CSV-like reading of rows into one account (or several). */
  const pending = async (accounts: { hint: string; rows: [string, number, string][] }[]): Promise<string> => {
    const bytes = Buffer.from(`document ${++n}`);
    const id = `imp_20260920_120000_000${n}`;
    const record: ImportRecord = {
      id,
      status: 'review',
      createdAt: '2026-09-20T12:00:00+01:00',
      updatedAt: '2026-09-20T12:00:00+01:00',
      origin: 'upload',
      ...(accounts.length === 1 ? { hintAccountId: accounts[0]!.hint } : {}),
      document: { id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: `statement-${n}.pdf`, mediaType: 'application/pdf', size: bytes.length },
      extraction: {
        engine: 'claude-cli',
        engineVersion: 'extract-6',
        warnings: [],
        raw: ExtractionSchema.parse({ documentType: 'bank_statement', accounts: accounts.map((a) => ({ accountName: a.hint, transactions: a.rows.map(([date, amount, description]) => ({ date, amount, description })) })) }),
      },
    };
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    return id;
  };
  const start = async () => {
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
  };
  /** The first row of an import's section, by index. */
  const row = (id: string, section = 0, i = 0) => svc.getPending(id)!.draft!.sections[section]!.transactions[i]!;
  /** Choose each section's account, as on the review page. */
  const into = async (id: string, ...accountIds: string[]) => {
    const r = svc.getPending(id)!.draft ? svc.getPending(id)! : await svc.refreshDraft(id);
    await svc.updateDraft(id, { ...r.draft!, sections: r.draft!.sections.map((s, i) => ({ ...s, target: { mode: 'existing', accountId: accountIds[i]! } })) });
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-links-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setCategories(defaultCategories());
    await store.setAccounts([acct('current', 'current'), acct('saver', 'savings'), acct('card', 'credit_card')]);
    work = new WorkArea(path.join(dir, 'work'));
    await work.init();
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('links rows of two imports, and makes them a transfer once both are committed, in either order', async () => {
    // Descriptions that say nothing about each other: the draft would never pair them itself.
    const a = await pending([{ hint: 'current', rows: [['2026-09-01', -500, 'MISC DEBIT 0042']] }]);
    const b = await pending([{ hint: 'saver', rows: [['2026-09-03', 500, 'CREDIT 7781']] }]);
    await start();
    await into(a, 'current');
    await into(b, 'saver');
    expect(row(a).transferMatch).toBeUndefined();

    const offered = svc.linkCandidates({ importId: a, key: row(a).key });
    expect(offered).toEqual([expect.objectContaining({ kind: 'pending', importId: b, key: row(b).key, days: 2 })]);

    await svc.linkRow({ importId: a, key: row(a).key }, { importId: b, key: row(b).key });
    expect(row(a).pendingLink).toEqual({ importId: b, key: row(b).key });
    expect(row(b).pendingLink).toEqual({ importId: a, key: row(a).key });
    expect(row(a)).toMatchObject({ category: 'savings-transfer', categorisedBy: 'transfer', counterpartyAccountId: 'saver' });
    const view = svc.linkViews(svc.getPending(a)!)[row(a).key];
    expect(view).toMatchObject({ kind: 'pending', importId: b, amount: 500 });
    expect(view?.fileName).toBe(svc.getPending(b)!.document.fileName);

    // A draft saved from a page opened before the link keeps the link the server has.
    const stale = structuredClone(svc.getPending(b)!.draft!);
    delete stale.sections[0]!.transactions[0]!.pendingLink;
    await svc.updateDraft(b, stale);
    expect(row(b).pendingLink).toEqual({ importId: a, key: row(a).key });

    // The saver's statement first: its row is recorded, and the current account's row links to it.
    await svc.commit(b);
    const credit = store.transactions('saver')[0]!;
    expect(credit.transferGroup).toBeUndefined();
    expect(row(a).pendingLink).toBeUndefined();
    expect(row(a).transferMatch).toBe(credit.id);
    expect(svc.linkViews(svc.getPending(a)!)[row(a).key]).toMatchObject({ kind: 'recorded', by: 'user', transactionId: credit.id });

    await svc.commit(a);
    const debit = store.transactions('current')[0]!;
    const creditNow = store.transaction(credit.id)!;
    expect(debit.transferGroup).toBeDefined();
    expect(debit.transferGroup).toBe(creditNow.transferGroup);
    expect(debit.counterpartyAccountId).toBe('saver');
    expect(creditNow.counterpartyAccountId).toBe('current');
  });

  it('links two accounts’ rows of one document, linked when it is committed', async () => {
    const a = await pending([
      { hint: 'current', rows: [['2026-09-01', -120, 'PAYMENT 99812']] },
      { hint: 'card', rows: [['2026-09-02', 120, 'THANK YOU']] },
    ]);
    await start();
    await into(a, 'current', 'card');
    await svc.linkRow({ importId: a, key: row(a, 0).key }, { importId: a, key: row(a, 1).key });
    await svc.commit(a);
    const [paid] = store.transactions('current');
    const [received] = store.transactions('card');
    expect(paid!.transferGroup).toBeDefined();
    expect(paid!.transferGroup).toBe(received!.transferGroup);
    expect(paid!.category).toBe('credit-card-payment');
  });

  it('links a row to a recorded transaction, and unlinks it back to what the rules say', async () => {
    const a = await pending([{ hint: 'current', rows: [['2026-09-01', -75, 'MISC DEBIT 1']] }]);
    await start();
    await into(a, 'current');
    await store.addTransactions([{ id: 'tx_00000000000000aa', accountId: 'saver', date: '2026-09-02', amount: 75, currency: 'GBP', description: 'CREDIT', source: {}, createdAt: stamp }], 'test');
    const before = row(a).category;
    const offered = svc.linkCandidates({ importId: a, key: row(a).key });
    expect(offered).toEqual([expect.objectContaining({ kind: 'recorded', transactionId: 'tx_00000000000000aa' })]);

    await svc.linkRow({ importId: a, key: row(a).key }, { transactionId: 'tx_00000000000000aa' });
    expect(row(a)).toMatchObject({ transferMatch: 'tx_00000000000000aa', transferMatchBy: 'user', categorisedBy: 'transfer' });

    await svc.unlinkRow({ importId: a, key: row(a).key });
    expect(row(a).transferMatch).toBeUndefined();
    expect(row(a).transferMatchBy).toBe('user');
    expect(row(a).category).toBe(before);

    // Your "no link" survives drafting it again, which would otherwise look for one.
    await svc.refreshDraft(a);
    expect(row(a).transferMatchBy).toBe('user');
  });

  it('refuses what cannot be a transfer', async () => {
    const a = await pending([{ hint: 'current', rows: [['2026-09-01', -10, 'X'], ['2026-09-02', 10, 'Y']] }]);
    const b = await pending([{ hint: 'saver', rows: [['2026-09-01', 11, 'Z']] }]);
    await start();
    await into(a, 'current');
    await into(b, 'saver');
    await expect(svc.linkRow({ importId: a, key: row(a, 0, 0).key }, { importId: a, key: row(a, 0, 1).key })).rejects.toThrow(/same one/);
    await expect(svc.linkRow({ importId: a, key: row(a, 0, 0).key }, { importId: b, key: row(b).key })).rejects.toThrow(/same amount/);
  });

  it('takes a link away, with a note, when the other import is discarded', async () => {
    const a = await pending([{ hint: 'current', rows: [['2026-09-01', -500, 'MISC DEBIT 0042']] }]);
    const b = await pending([{ hint: 'saver', rows: [['2026-09-03', 500, 'CREDIT 7781']] }]);
    await start();
    await into(a, 'current');
    await into(b, 'saver');
    await svc.linkRow({ importId: a, key: row(a).key }, { importId: b, key: row(b).key });
    await svc.discard(b);
    expect(row(a).pendingLink).toBeUndefined();
    expect(svc.getPending(a)!.draft!.notes.at(-1)).toMatch(/statement-\d+\.pdf was discarded/);
  });
});
