// Income a fund keeps (src/shared/review.ts, isReinvested): an accumulation distribution, or the
// equalisation on accumulation units, listed among an investment account's transactions. It buys
// more of the fund and never reaches the cash. All data here is invented.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { Store } from '../src/server/store';
import { isReinvested, sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type Account, type ImportRecord } from '../src/shared/schema';

describe('isReinvested', () => {
  it('knows an accumulation distribution and equalisation on accumulation units', () => {
    expect(isReinvested({ description: 'Example Global Index Fund Acc - Accumulation Distribution' })).toBe(true);
    expect(isReinvested({ description: 'Example Global Index Fund Acc', type: 'Equalisation Acc Units' })).toBe(true);
    expect(isReinvested({ description: 'Example Global Index Fund Acc', detail: { type: 'Accumulation Distribution' } })).toBe(true);
  });

  it('leaves income paid out as cash alone', () => {
    for (const description of ['Example Income Fund Inc - Distribution', 'Example Income Fund Inc - Equalisation', 'Gross interest to 30/09/26', 'Dividend EXAMPLE PLC', 'Purchase 10 Example Global Index Fund Acc']) {
      expect(isReinvested({ description })).toBe(false);
    }
  });
});

describe('a transactions screen listing reinvested income', () => {
  let dir: string;
  let store: Store;
  let workFile: string;
  const stamp = '2026-09-01T00:00:00+01:00';
  const lisa: Account = { id: 'lisa', name: 'Example LISA', type: 'lisa', institutionId: 'example-invest', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp };
  const record: ImportRecord = {
    id: 'imp_20261001_120000_0b01',
    status: 'review',
    createdAt: '2026-10-01T12:00:00+01:00',
    updatedAt: '2026-10-01T12:00:00+01:00',
    origin: 'upload',
    hintAccountId: 'lisa',
    document: { id: 'doc_00000000000000bc', sha256: 'bc'.repeat(32), fileName: 'IMG_0002.png', mediaType: 'image/png', size: 1 },
    extraction: { warnings: [] },
  };
  // Amounts shown without a sign, as the screen prints them; the reader says so.
  const screen = ExtractionSchema.parse({
    documentType: 'transactions_screenshot',
    accounts: [
      {
        accountName: 'Lifetime ISA',
        accountType: 'lisa',
        transactions: [
          { date: '2026-09-10', description: 'Example Tech Index Acc - Accumulation Distribution', type: 'Accumulation Distribution', amount: 8, uncertain: 'sign assumed positive; no sign shown' },
          { date: '2026-09-10', description: 'Example Tech Index Acc - Equalisation Acc Units', type: 'Equalisation Acc Units', amount: 2, uncertain: 'sign assumed positive; no sign shown' },
          { date: '2026-09-30', description: 'Gross interest to 30/09/26', amount: 1.5 },
        ],
      },
    ],
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-reinvested-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([lisa]);
    workFile = path.join(dir, 'IMG_0002.png');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('leaves them unticked, notes them, does not hold the import back over their signs, and records only the cash', async () => {
    const draft = buildDraft(screen, { store, document: record.document, hintAccountId: 'lisa', uploadedOn: '2026-10-01' });
    const section = draft.sections[0]!;
    expect(section.transactions.map((t) => [t.amount, t.include])).toEqual([
      [8, false],
      [2, false],
      [1.5, true],
    ]);
    const checks = sectionChecks(section, { latest: '2026-10-01', accountType: 'lisa' });
    expect(checks.find((c) => c.id === 'reinvested')).toMatchObject({ status: 'info', rows: [section.transactions[0]!.key, section.transactions[1]!.key] });
    expect(checks.find((c) => c.id === 'uncertain')).toBeUndefined();
    await commitDraft(store, { record, draft, workFile });
    expect(store.transactions('lisa').map((t) => t.amount)).toEqual([1.5]);
  });

  it('records one you tick, and asks about its sign again', async () => {
    const draft = buildDraft(screen, { store, document: record.document, hintAccountId: 'lisa', uploadedOn: '2026-10-01' });
    const section = draft.sections[0]!;
    section.transactions[0]!.include = true;
    expect(sectionChecks(section, { latest: '2026-10-01' }).find((c) => c.id === 'uncertain')).toMatchObject({ rows: [section.transactions[0]!.key] });
    await commitDraft(store, { record, draft, workFile });
    expect(store.transactions('lisa').map((t) => t.amount).sort()).toEqual([1.5, 8]);
  });
});
