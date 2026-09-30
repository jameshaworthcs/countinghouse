// Moves inside an account (src/shared/spaces.ts): between its main balance and a Space its
// statements count in the balance. An app screen lists them; statements do not. All data here is
// invented.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { Store } from '../src/server/store';
import { spaceMove } from '../src/shared/spaces';
import { ExtractionSchema, type Account, type ImportRecord } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const bank: Account = { id: 'bank', name: 'Bank', type: 'current', institutionId: 'starling', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };

describe('a move to or from a Space', () => {
  it('is typed so by the bank, or names one of the account’s Spaces with nothing saying otherwise', () => {
    expect(spaceMove(bank, { description: 'Holiday', type: 'Saving', counterpartyName: 'Holiday' })).toBe('Holiday');
    expect(spaceMove(bank, { description: 'Holiday', type: null })).toBeUndefined();
    const known = { ...bank, spaces: ['Holiday'] };
    expect(spaceMove(known, { description: 'HOLIDAY' })).toBe('Holiday');
    // A payment to someone of that name is money out.
    expect(spaceMove(known, { description: 'Holiday', type: 'Payments' })).toBeUndefined();
    // Another bank's "Saving" type says nothing without its Spaces named.
    expect(spaceMove({ ...bank, institutionId: 'monzo' }, { description: 'Holiday', type: 'Saving' })).toBeUndefined();
    expect(spaceMove(undefined, { description: 'Holiday', type: 'Saving' })).toBeUndefined();
  });
});

describe('an app screen listing Space moves', () => {
  let dir: string;
  let store: Store;
  let workFile: string;
  const record: ImportRecord = {
    id: 'imp_20260930_120000_0a01',
    status: 'review',
    createdAt: '2026-09-30T12:00:00+01:00',
    updatedAt: '2026-09-30T12:00:00+01:00',
    origin: 'upload',
    hintAccountId: 'bank',
    document: { id: 'doc_00000000000000ab', sha256: 'ab'.repeat(32), fileName: 'IMG_0001.png', mediaType: 'image/png', size: 1 },
    extraction: { warnings: [] },
  };
  // The top row is cut off above its type; the one below shows it.
  const screen = ExtractionSchema.parse({
    documentType: 'transactions_screenshot',
    accounts: [
      {
        accountName: 'Personal',
        transactions: [
          { date: '2026-09-03', description: 'Holiday', counterpartyName: 'Holiday', amount: 3 },
          { date: '2026-09-03', description: 'Example Payer', type: 'Income', amount: 4 },
          { date: '2026-08-14', description: 'Holiday', counterpartyName: 'Holiday', type: 'Saving', amount: -3 },
        ],
      },
    ],
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-spaces-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([bank]);
    workFile = path.join(dir, 'IMG_0001.png');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves them unticked, names the Space, and remembers it on commit', async () => {
    const draft = buildDraft(screen, { store, document: record.document, hintAccountId: 'bank', uploadedOn: '2026-09-30' });
    const rows = draft.sections[0]!.transactions;
    expect(rows.map((t) => [t.description, t.include, t.insideAccount ?? null])).toEqual([
      ['Holiday', false, 'Holiday'],
      ['Example Payer', true, null],
      ['Holiday', false, 'Holiday'],
    ]);
    expect(rows[0]!.transferMatch).toBeUndefined();
    await commitDraft(store, { record, draft, workFile });
    expect(store.transactions('bank').map((t) => t.description)).toEqual(['Example Payer']);
    expect(store.account('bank')!.spaces).toEqual(['Holiday']);
  });

  it('records one you tick all the same', async () => {
    const draft = buildDraft(screen, { store, document: record.document, hintAccountId: 'bank', uploadedOn: '2026-09-30' });
    draft.sections[0]!.transactions[0]!.include = true;
    await commitDraft(store, { record, draft, workFile });
    expect(store.transactions('bank').map((t) => t.description).sort()).toEqual(['Example Payer', 'Holiday']);
    // Recorded, it was not left out: only the one you left out is remembered as a Space.
    expect(store.account('bank')!.spaces).toEqual(['Holiday']);
  });
});
