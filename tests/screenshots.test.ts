// Screenshots from a phone (docs/INGESTION.md): when the balance on an app screen applies, how
// screenshots taken together share what they show, and documents that add nothing new. All data
// here is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { captureDate } from '../src/server/ingest/images';
import { extractionJsonSchema, PROMPT_VERSION, SYSTEM_PROMPT } from '../src/server/ingest/prompt';
import { assessReading } from '../src/server/ingest/verify';
import { Store } from '../src/server/store';
import { sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type Account, type DocumentRef } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let docs = 0;
const doc = (extra: Partial<DocumentRef> = {}): DocumentRef => {
  const hex = (++docs).toString(16).padStart(16, '0');
  return { id: `doc_${hex}`, sha256: hex.repeat(4), fileName: 'IMG_0001.PNG', mediaType: 'image/png', size: 1, ...extra };
};
const reinvestments = [
  { date: '2026-07-02', description: 'Auto prize reinvestment', amount: 25 },
  { date: '2026-08-04', description: 'Auto prize reinvestment', amount: 100 },
  { date: '2026-09-02', description: 'Auto prize reinvestment', amount: 50 },
];

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-screens-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setAccounts([acct('bonds', 'premium_bonds', { institutionId: 'ns-and-i' }), acct('current', 'current', { last4: '4821' })]);
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

const bondsScreen = (extra: Record<string, unknown> = {}, documentType = 'transactions_screenshot') =>
  ExtractionSchema.parse({ documentType, accounts: [{ accountName: 'Premium Bonds', accountType: 'premium_bonds', closingBalance: 12350, transactions: reinvestments, ...extra }] });

describe('the balance on a screenshot is dated when it was taken', () => {
  it('an app screen’s headline balance is at its capture date, not at its latest row', () => {
    const draft = buildDraft(bondsScreen(), { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
    const [s] = draft.sections;
    expect(s).toMatchObject({ balance: 12350, balanceDate: '2026-09-29', balanceDateSource: 'exif' });
    expect(sectionChecks(s!, { accountType: 'premium_bonds', latest: '2026-09-29' }).find((c) => c.id === 'balance-date')).toBeUndefined();
  });

  it('takes the capture date from the file name or the file’s date as well', () => {
    for (const source of ['filename', 'file-modified'] as const) {
      const draft = buildDraft(bondsScreen(), { store, document: doc({ capturedOn: '2026-09-28', capturedOnSource: source }), uploadedOn: '2026-09-29' });
      expect(draft.sections[0]).toMatchObject({ balanceDate: '2026-09-28', balanceDateSource: source });
    }
  });

  it('a screen the reader could not classify is still a screen, when it is an image', () => {
    const draft = buildDraft(bondsScreen({}, 'other'), { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
    expect(draft.sections[0]!.balanceDate).toBe('2026-09-29');
  });

  it('a date printed beside the balance wins over the capture date', () => {
    const draft = buildDraft(bondsScreen({ balanceDate: '2026-09-27' }), { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
    expect(draft.sections[0]).toMatchObject({ balanceDate: '2026-09-27', balanceDateSource: 'document' });
  });

  it('a screen with its own period (an activity list) keeps the period’s end', () => {
    const draft = buildDraft(bondsScreen({ periodStart: '2026-07-01', periodEnd: '2026-09-28' }), { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
    expect(draft.sections[0]).toMatchObject({ balanceDate: '2026-09-28', balanceDateSource: 'document' });
  });

  it('a statement keeps its rules: its balance is after its latest row, even as a photo or screenshot', () => {
    const statement = ExtractionSchema.parse({ documentType: 'bank_statement', accounts: [{ accountType: 'current', last4: '4821', closingBalance: 910.5, transactions: [{ date: '2026-09-01', description: 'TESCO', amount: -12 }, { date: '2026-09-12', description: 'PRET', amount: -4 }] }] });
    for (const mediaType of ['application/pdf', 'image/png']) {
      const draft = buildDraft(statement, { store, document: doc({ mediaType, capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
      expect(draft.sections[0]).toMatchObject({ balanceDate: '2026-09-12', balanceDateSource: 'document' });
    }
  });

  it('a statement’s balance dated after its period is still moved to the period’s end', () => {
    const statement = ExtractionSchema.parse({ documentType: 'credit_card_statement', accounts: [{ accountType: 'current', last4: '4821', closingBalance: -50, balanceDate: '2026-09-03', periodStart: '2026-08-03', periodEnd: '2026-09-02', transactions: [{ date: '2026-08-20', description: 'SHELL', amount: -50 }] }] });
    const draft = buildDraft(statement, { store, document: doc({ mediaType: 'application/pdf' }), uploadedOn: '2026-09-29' });
    expect(draft.sections[0]!.balanceDate).toBe('2026-09-02');
  });

  it('with nothing saying when it was taken, the upload day stands in and the review asks', () => {
    const draft = buildDraft(bondsScreen(), { store, document: doc(), uploadedOn: '2026-09-29' });
    expect(draft.sections[0]).toMatchObject({ balanceDate: '2026-09-29', balanceDateSource: 'upload' });
    expect(draft.notes.join(' ')).toMatch(/on or after 2026-09-02/);
    expect(draftIsClean(draft).reasons).toContain('balance date unknown');
  });

  it('a settled row later than the capture date is marked, and the capture date kept', () => {
    const rows = [...reinvestments, { date: '2026-09-30', description: 'Auto prize reinvestment', amount: 25 }, { date: '2026-10-01', description: 'Standing order', amount: 100, pending: true }];
    const draft = buildDraft(bondsScreen({ transactions: rows }), { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-10-02' });
    const [s] = draft.sections;
    expect(s!.balanceDate).toBe('2026-09-29');
    expect(draft.notes.join(' ')).toMatch(/lists a row dated 2026-09-30/);
    const check = sectionChecks(s!, { accountType: 'premium_bonds', latest: '2026-10-02' }).find((c) => c.id === 'balance-date');
    // Only the settled row: a pending one may be dated ahead.
    expect(check).toMatchObject({ status: 'warn', rows: [s!.transactions[3]!.key] });
  });
});

describe('when a screenshot was taken', () => {
  const noMetadata = Buffer.from('not an image');

  it('reads the time from screenshot file names, as local time', async () => {
    const cases: [string, string][] = [
      ['Screenshot 2026-09-24 at 19.42.10.png', '2026-09-24T19:42:10'],
      ['Screenshot_20260924-194210.png', '2026-09-24T19:42:10'],
      ['Screenshot from 2026-09-24 19-42-10.png', '2026-09-24T19:42:10'],
    ];
    for (const [name, local] of cases) {
      const cap = await captureDate(noMetadata, name);
      expect(cap).toMatchObject({ date: '2026-09-24', source: 'filename' });
      expect(cap!.at!.slice(0, 19)).toBe(local);
      expect(cap!.at).toMatch(/[+-]\d{2}:\d{2}$/);
    }
  });

  it('gives no time when the name has none, or a time that is not local (a Pixel’s UTC stamp)', async () => {
    expect((await captureDate(noMetadata, 'IMG_20260924.png'))?.at).toBeUndefined();
    expect((await captureDate(noMetadata, 'PXL_20260924_184210123.jpg'))?.at).toBeUndefined();
    expect(await captureDate(noMetadata, 'IMG_0101.PNG')).toBeNull();
  });

  it('falls back to the file’s modified time, with its time', async () => {
    const cap = await captureDate(noMetadata, 'IMG_0101.PNG', '2026-09-29T19:07:21.000Z');
    expect(cap).toMatchObject({ date: '2026-09-29', source: 'file-modified' });
    expect(Date.parse(cap!.at!)).toBe(Date.parse('2026-09-29T19:07:21.000Z'));
  });
});

describe('the reader: views that are not the account’s movements', () => {
  it('no longer teaches that prizes go to another account, and says a list is not movements', () => {
    expect(PROMPT_VERSION).toBe('extract-9');
    expect(SYSTEM_PROMPT).not.toMatch(/paid to a bank account/i);
    expect(SYSTEM_PROMPT).toMatch(/never where money went/);
    expect(SYSTEM_PROMPT).toMatch(/Premium Bond numbers[^.]*are not holdings/);
  });

  it('asks what a document with nothing to record shows, as a required, nullable field', () => {
    const schema = extractionJsonSchema() as { required: string[]; properties: Record<string, { anyOf?: { type: string }[] }> };
    expect(schema.required).toContain('nothingToRecord');
    expect(schema.properties.nothingToRecord!.anyOf!.map((x) => x.type)).toEqual(['string', 'null']);
  });

  it('carries the reader’s words into the draft; readings from before extract-9 still parse', () => {
    const extraction = ExtractionSchema.parse({ documentType: 'other', accounts: [{ accountType: 'premium_bonds', last4: '3704' }], nothingToRecord: ' A prize history: prizes won, by bond number and month. ' });
    const draft = buildDraft(extraction, { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });
    expect(draft.sections).toEqual([]);
    expect(draft.nothingToRecord).toBe('A prize history: prizes won, by bond number and month.');
    expect(ExtractionSchema.parse({ documentType: 'other' }).nothingToRecord).toBeNull();
  });

  it('a reading that finds nothing to record is read again before it is believed', () => {
    const empty = buildDraft(ExtractionSchema.parse({ documentType: 'other', nothingToRecord: 'A settings screen.' }), { store, document: doc(), uploadedOn: '2026-09-29' });
    expect(assessReading(empty, { accountTypeOf: () => undefined, latest: '2026-09-29', warnings: [] }).unconfirmed).toContain('Nothing to record');
  });
});
