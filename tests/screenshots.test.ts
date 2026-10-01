// Screenshots from a phone (docs/INGESTION.md): when the balance on an app screen applies, how
// screenshots taken together share what they show, and documents that add nothing new. All data
// here is invented.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import { sha256 } from '../src/server/fsutil';
import { documentId } from '../src/server/ids';
import { buildDraft, draftIsClean, type BatchEvidence } from '../src/server/ingest/draft';
import { ImportService } from '../src/server/ingest/service';
import { WorkArea } from '../src/server/ingest/workarea';
import { captureDate } from '../src/server/ingest/images';
import { extractionJsonSchema, PROMPT_VERSION, SYSTEM_PROMPT } from '../src/server/ingest/prompt';
import { assessReading } from '../src/server/ingest/verify';
import { Store } from '../src/server/store';
import { sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type Account, type DocumentRef, type Extraction, type ImportRecord } from '../src/shared/schema';

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
  await store.setAccounts([acct('bonds', 'premium_bonds', { name: 'Premium Bonds', institutionId: 'ns-and-i' }), acct('current', 'current', { last4: '4821' })]);
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
    expect(PROMPT_VERSION).toBe('extract-11');
    expect(SYSTEM_PROMPT).not.toMatch(/paid to a bank account/i);
    expect(SYSTEM_PROMPT).toMatch(/never where money went/);
    expect(SYSTEM_PROMPT).toMatch(/Premium Bond numbers[^.]*are not holdings/);
  });

  it('reads a confirmation of one payment as that payment, and a scheduled one as nothing (extract-10)', () => {
    expect(SYSTEM_PROMPT).toMatch(/confirmation or receipt of one payment[^.]*is a movement: it gives that one payment as a transaction/);
    expect(SYSTEM_PROMPT).toMatch(/A payment set up for a later day is scheduled, not a movement/);
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

describe('screenshots taken together share the account', () => {
  const batch: BatchEvidence = { accountId: 'bonds', importId: 'imp_20260929_200900_4c3d', fileName: 'IMG_0102.PNG', minutes: -1 };
  const scrolled = (account: Record<string, unknown> = {}) => ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ transactions: reinvestments, ...account }] });
  const draw = (extraction: Extraction, extra: { batch?: BatchEvidence; hintAccountId?: string } = {}) => buildDraft(extraction, { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29', ...extra });

  it('a screen that names no account takes the one a screenshot beside it shows, and says why', () => {
    expect(draw(scrolled()).sections[0]!.target).toEqual({ mode: 'skip' });
    const draft = draw(scrolled(), { batch });
    expect(draft.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'bonds' });
    expect(draft.sections[0]!.matchReason).toMatch(/taken 1 minute before IMG_0102\.PNG, which shows Premium Bonds, on the same phone, and uploaded with it/);
    expect(draft.batchMatch).toEqual({ accountId: 'bonds', importId: batch.importId });
  });

  it('it fills a gap only: a screen that says what kind of account it is, but not which, is not a new account', () => {
    expect(draw(scrolled({ accountType: 'current' })).sections[0]!.target).toEqual({ mode: 'skip' });
    expect(draw(scrolled({ accountType: 'current' }), { batch: { ...batch, accountId: 'current' } }).sections[0]!.target).toEqual({ mode: 'existing', accountId: 'current' });
  });

  it('anything on the screen that says otherwise wins: number, kind, provider, currency, name', () => {
    for (const other of [{ last4: '4821' }, { accountType: 'current' }, { institutionName: 'Monzo' }, { currency: 'EUR' }, { accountName: 'Flex Instant Saver' }]) {
      const draft = draw(scrolled(other), { batch });
      expect(draft.sections[0]!.target, JSON.stringify(other)).not.toEqual({ mode: 'existing', accountId: 'bonds' });
      expect(draft.batchMatch).toBeUndefined();
    }
  });

  it('a confident match on the screen itself, or your choice, always wins', () => {
    expect(draw(scrolled({ last4: '4821', accountType: 'current' }), { batch }).sections[0]!.target).toEqual({ mode: 'existing', accountId: 'current' });
    expect(draw(scrolled(), { batch, hintAccountId: 'current' }).sections[0]!.target).toEqual({ mode: 'existing', accountId: 'current' });
  });

  it('a screen of several accounts is not a scrolled screen of one', () => {
    const home = ExtractionSchema.parse({ documentType: 'account_overview_screenshot', accounts: [{ closingBalance: 10 }, { closingBalance: 20 }] });
    expect(draw(home, { batch }).sections.every((s) => s.target.mode === 'skip')).toBe(true);
  });

  describe('which screenshots were taken together', () => {
    let svc: ImportService;
    let work: WorkArea;
    const make = async (id: string, opts: { at: string; created?: string; width?: number; extraction: Extraction; fileName?: string }): Promise<ImportRecord> => {
      const record: ImportRecord = {
        id,
        status: 'review',
        createdAt: opts.created ?? '2026-09-29T20:09:00+01:00',
        updatedAt: '2026-09-29T20:09:00+01:00',
        origin: 'upload',
        document: doc({ fileName: opts.fileName ?? `${id.slice(-4)}.PNG`, capturedOn: '2026-09-29', capturedOnSource: 'exif', capturedAt: opts.at, image: { width: opts.width ?? 1206, height: 2622 } }),
        extraction: { warnings: [], raw: opts.extraction },
      };
      await work.saveRecord(record);
      return record;
    };
    const named = (accountType: Account['type'], extra: Record<string, unknown> = {}) => ExtractionSchema.parse({ documentType: 'account_overview_screenshot', accounts: [{ accountName: accountType === 'premium_bonds' ? 'Premium Bonds' : 'Current account', accountType, closingBalance: 100, ...extra }] });
    const target = (id: string) => svc.getPending(id)!.draft!.sections[0]!.target;
    const start = async () => {
      svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
      await svc.init();
      for (const r of svc.listPending()) await svc.refreshDraft(r.id);
    };
    beforeEach(() => {
      work = new WorkArea(path.join(dir, 'work'));
    });

    it('taken a minute apart on one phone and uploaded together: the scrolled one follows', async () => {
      await make('imp_20260929_200900_aaaa', { at: '2026-09-29T20:07:40+01:00', extraction: scrolled() });
      await make('imp_20260929_200900_bbbb', { at: '2026-09-29T20:08:33+01:00', extraction: named('premium_bonds'), fileName: 'IMG_0102.PNG' });
      await start();
      expect(target('imp_20260929_200900_aaaa')).toEqual({ mode: 'existing', accountId: 'bonds' });
      expect(svc.getPending('imp_20260929_200900_aaaa')!.draft!.sections[0]!.matchReason).toMatch(/taken 1 minute before IMG_0102\.PNG/);
    });

    it('not when taken far apart, on another phone, or uploaded separately', async () => {
      await make('imp_20260929_200900_bbbb', { at: '2026-09-29T20:08:33+01:00', extraction: named('premium_bonds') });
      await make('imp_20260929_200900_c001', { at: '2026-09-29T19:40:00+01:00', extraction: scrolled() });
      await make('imp_20260929_200900_c002', { at: '2026-09-29T20:08:00+01:00', width: 1179, extraction: scrolled() });
      await make('imp_20260929_201500_c003', { at: '2026-09-29T20:08:00+01:00', created: '2026-09-29T20:15:00+01:00', extraction: scrolled() });
      await start();
      for (const id of ['imp_20260929_200900_c001', 'imp_20260929_200900_c002', 'imp_20260929_201500_c003']) expect(target(id), id).toEqual({ mode: 'skip' });
    });

    it('not between two accounts’ screens: the nearest before and after must agree', async () => {
      await make('imp_20260929_200900_bbbb', { at: '2026-09-29T20:05:00+01:00', extraction: named('premium_bonds') });
      await make('imp_20260929_200900_aaaa', { at: '2026-09-29T20:06:00+01:00', extraction: scrolled() });
      await make('imp_20260929_200900_dddd', { at: '2026-09-29T20:07:00+01:00', extraction: named('current', { last4: '4821' }) });
      await start();
      expect(target('imp_20260929_200900_aaaa')).toEqual({ mode: 'skip' });
    });

    it('never from a screenshot that took its own account from the batch', async () => {
      await make('imp_20260929_200900_bbbb', { at: '2026-09-29T20:00:00+01:00', extraction: named('premium_bonds') });
      await make('imp_20260929_200900_aaaa', { at: '2026-09-29T20:05:00+01:00', extraction: scrolled() });
      await make('imp_20260929_200900_eeee', { at: '2026-09-29T20:14:00+01:00', extraction: scrolled() });
      await start();
      expect(target('imp_20260929_200900_aaaa')).toEqual({ mode: 'existing', accountId: 'bonds' });
      // Fourteen minutes from the named screen: its only neighbour in reach is one that borrowed.
      expect(target('imp_20260929_200900_eeee')).toEqual({ mode: 'skip' });
    });

    it('dropping the screenshot it relied on sends it back to you; a draft you edited is left alone', async () => {
      await make('imp_20260929_200900_bbbb', { at: '2026-09-29T20:08:33+01:00', extraction: named('premium_bonds') });
      await make('imp_20260929_200900_aaaa', { at: '2026-09-29T20:07:40+01:00', extraction: scrolled() });
      await make('imp_20260929_200900_ffff', { at: '2026-09-29T20:07:50+01:00', extraction: scrolled() });
      await start();
      const edited = svc.getPending('imp_20260929_200900_ffff')!;
      await svc.updateDraft(edited.id, { ...edited.draft!, notes: [...edited.draft!.notes, 'checked'] });
      await svc.discard('imp_20260929_200900_bbbb');
      expect(target('imp_20260929_200900_aaaa')).toEqual({ mode: 'skip' });
      expect(target('imp_20260929_200900_ffff')).toEqual({ mode: 'existing', accountId: 'bonds' });
    });
  });
});

describe('a screen that says only what kind of account it is', () => {
  const scrolled = (account: Record<string, unknown> = {}) => ExtractionSchema.parse({ documentType: 'transactions_screenshot', accounts: [{ transactions: reinvestments, ...account }] });
  const draw = (extraction: Extraction) => buildDraft(extraction, { store, document: doc({ capturedOn: '2026-09-29', capturedOnSource: 'exif' }), uploadedOn: '2026-09-29' });

  it('Premium Bonds: a person holds only one, so the screen is yours', () => {
    const [s] = draw(scrolled({ accountType: 'premium_bonds' })).sections;
    expect(s!.target).toEqual({ mode: 'existing', accountId: 'bonds' });
    expect(s!.matchReason).toBe('Matched by type (Premium Bonds), your only Premium Bonds, a person holds only one');
    // The rows are then checked against the account's own: the prizes were recorded before.
    expect(s!.transactions.map((t) => t.category)).toEqual(['other-income', 'other-income', 'other-income']);
  });

  it('unless the screen says otherwise, or you hold two (a child’s, say)', async () => {
    await store.setAccounts([...store.accounts.map((a) => (a.id === 'bonds' ? { ...a, last4: '7302' } : a))]);
    expect(draw(scrolled({ accountType: 'premium_bonds', last4: '7730' })).sections[0]!.target.mode).toBe('new');
    await store.setAccounts([...store.accounts, acct('ada-bonds', 'premium_bonds', { name: 'Ada’s Premium Bonds', institutionId: 'ns-and-i' })]);
    const [s] = draw(scrolled({ accountType: 'premium_bonds' })).sections;
    expect(s!.target).toEqual({ mode: 'skip' });
    expect(s!.matchReason).toMatch(/only that it is Premium Bonds, and you have 2: choose it/);
    expect(s!.suggestedAccountId).toBeUndefined();
  });

  it('any other kind: one of yours, so it asks which and suggests your only one, never a new account', async () => {
    await store.setAccounts([...store.accounts, acct('lisa', 'lisa', { name: 'Lifetime ISA' })]);
    const [s] = draw(scrolled({ accountType: 'lisa' })).sections;
    expect(s!.target).toEqual({ mode: 'skip' });
    expect(s!.suggestedAccountId).toBe('lisa');
    expect(s!.matchReason).toBe('Nothing on this screen names the account, only that it is Lifetime ISA. It looks like your Lifetime ISA: choose it');
    expect(draftIsClean(draw(scrolled({ accountType: 'lisa' }))).reasons).toContain('an account to choose or a section left out');
  });

  it('a kind you have none of is a new account, with its only provider', async () => {
    await store.setAccounts(store.accounts.filter((a) => a.id !== 'bonds'));
    const [s] = draw(scrolled({ accountType: 'premium_bonds' })).sections;
    expect(s!.target).toMatchObject({ mode: 'new', account: { type: 'premium_bonds', institutionId: 'ns-and-i', name: 'NS&I Premium Bonds' } });
  });
});

describe('rows another import recorded meanwhile', () => {
  let svc: ImportService;
  let work: WorkArea;
  let seq = 0;
  const make = async (raw: Record<string, unknown>, at: string): Promise<string> => {
    const id = `imp_20260929_220730_${(++seq).toString(16).padStart(4, '0')}`;
    const bytes = Buffer.from(`screenshot ${id}`);
    const record: ImportRecord = {
      id,
      status: 'review',
      createdAt: '2026-09-29T22:07:30+01:00',
      updatedAt: '2026-09-29T22:07:30+01:00',
      origin: 'upload',
      document: doc({ id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: `IMG_05${90 + seq}.PNG`, capturedOn: '2026-09-29', capturedOnSource: 'exif', capturedAt: at, image: { width: 1206, height: 2622 } }),
      extraction: { warnings: [], raw: ExtractionSchema.parse(raw) },
    };
    await work.init();
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    return id;
  };
  const start = async () => {
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
    for (const r of svc.listPending()) await svc.refreshDraft(r.id);
  };
  const prize = (date: string, amount: number) => ({ date, description: 'Auto prize reinvestment', amount });
  const tab = (transactions: unknown[], extra: Record<string, unknown> = {}) => ({ documentType: 'transactions_screenshot', accounts: [{ accountType: 'premium_bonds', transactions, ...extra }] });
  const stored = () => store.transactions('bonds').map((t) => `${t.date} ${t.amount}`).sort();
  beforeEach(() => {
    work = new WorkArea(path.join(dir, 'work'));
  });

  it('two scrolled screens of one list share a row: it is recorded once, and the second says so', async () => {
    // The bottom row of the first is the first of three on 2 December on the second.
    const top = await make(tab([prize('2026-01-05', 100), prize('2025-12-02', 25)]), '2026-09-29T22:06:27+01:00');
    const next = await make(tab([prize('2025-12-02', 25), prize('2025-12-02', 25), prize('2025-12-02', 100), prize('2025-11-04', 50)]), '2026-09-29T22:06:32+01:00');
    await start();
    await svc.commit(top);
    const committed = await svc.commit(next);
    expect(stored()).toEqual(['2025-11-04 50', '2025-12-02 100', '2025-12-02 25', '2025-12-02 25', '2026-01-05 100']);
    expect(committed.result).toMatchObject({ transactionsAdded: 3, transactionsSkipped: 1 });
    expect(committed.draft!.notes.at(-1)).toMatch(/^1 row was already recorded when this was committed/);
  });

  it('a section you pointed at an account is checked against that account’s rows', async () => {
    await store.setAccounts([...store.accounts, acct('bonds-2', 'premium_bonds', { name: 'Other bonds' })]);
    const first = await make(tab([prize('2026-06-02', 25)], { accountName: 'Premium Bonds', last4: '7302' }), '2026-09-29T20:08:00+01:00');
    await store.setAccounts(store.accounts.map((a) => (a.id === 'bonds' ? { ...a, last4: '7302' } : a)));
    const later = await make(tab([prize('2026-06-02', 25), prize('2026-04-02', 100)]), '2026-09-29T22:06:27+01:00');
    await start();
    await svc.commit(first);
    const pending = svc.getPending(later)!;
    expect(pending.draft!.sections[0]!.target.mode).toBe('skip');
    const chosen = { ...pending.draft!, sections: pending.draft!.sections.map((s) => ({ ...s, target: { mode: 'existing' as const, accountId: 'bonds' } })) };
    await svc.commit(later, chosen);
    expect(stored()).toEqual(['2026-04-02 100', '2026-06-02 25']);
  });

  it('drafts waiting from before are drafted again when the app starts; ones you edited are not', async () => {
    const plain = await make(tab([prize('2025-08-04', 50)]), '2026-09-29T22:06:32+01:00');
    const edited = await make(tab([prize('2025-07-02', 25)]), '2026-09-29T22:06:36+01:00');
    for (const [id, draftEditedAt] of [[plain, undefined], [edited, '2026-09-29T22:10:00+01:00']] as const) {
      // As an older version drafted them: a new account for a Premium Bonds screen.
      const record = (await work.loadAll()).find((r) => r.id === id)!;
      await work.saveRecord({ ...record, draft: { documentType: 'transactions_screenshot', sections: [{ key: 's0', detected: { accountType: 'premium_bonds' }, target: { mode: 'new', account: { id: 'premium-bonds-2', name: 'Premium Bonds', type: 'premium_bonds', currency: 'GBP' } }, currency: 'GBP', recordBalance: false, recordHoldings: false, transactions: [], holdings: [] }], figures: [], notes: [] }, ...(draftEditedAt ? { draftEditedAt } : {}) });
    }
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
    expect(svc.getPending(plain)!.draft!.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'bonds' });
    expect(svc.getPending(edited)!.draft!.sections[0]!.target.mode).toBe('new');
    expect((await work.loadAll()).find((r) => r.id === plain)!.draft!.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'bonds' });
  });

  it('a letter about a new product waits for the account its statement creates, not the old product', async () => {
    // A two-year bond that matured into an easy-access account at the same bank, and another saver.
    await store.setAccounts([
      ...store.accounts,
      acct('fixed', 'savings', { name: 'Fixed Rate Bond 2 Year', institutionId: 'lloyds', status: 'closed', closedOn: '2026-02-28' }),
      acct('saver', 'savings', { name: 'Everyday Saver', institutionId: 'monzo' }),
    ]);
    const product = { institutionName: 'Lloyds Bank', accountName: 'Easy Access Issue 7', accountType: 'savings' };
    const statement = await make({ documentType: 'savings_statement', accounts: [{ ...product, transactions: [{ date: '2026-03-01', description: 'Interest Added', amount: 12.5, balanceAfter: 5012.5 }] }] }, '2026-09-29T08:00:00+01:00');
    const letter = await make({ documentType: 'other', accounts: [{ ...product, closingBalance: 5012.5, balanceDate: '2026-03-01', transactions: [] }] }, '2026-09-29T21:00:00+01:00');
    await start();
    // Same provider and kind, but another product: not the bond (closed, and not your only saver).
    expect(svc.getPending(letter)!.draft!.sections[0]!.target.mode).toBe('new');
    const created = (await svc.commit(statement)).result!.accountsCreated;
    expect(created).toHaveLength(1);
    expect(svc.getPending(letter)!.draft!.sections[0]!.target).toEqual({ mode: 'existing', accountId: created[0] });
    expect((await svc.commit(letter)).result!.accountsCreated).toEqual([]);
    expect(store.balances(created[0]).map((b) => b.balance)).toEqual([5012.5]);
    expect(store.balances('fixed')).toEqual([]);
  });

  it('a row that only looks like one recorded meanwhile waits for you, marked; then it commits', async () => {
    const a = await make(tab([prize('2026-06-02', 25)], { accountName: 'Premium Bonds' }), '2026-09-29T20:08:00+01:00');
    const b = await make(tab([{ date: '2026-06-03', description: 'Auto prize reinvestment June', amount: 25 }], { accountName: 'Premium Bonds' }), '2026-09-29T22:06:27+01:00');
    await start();
    await svc.commit(a);
    expect(svc.getPending(b)!.draft!.sections[0]!.transactions[0]!.status).toBe('new');
    expect((await svc.commitReady()).skipped).toEqual([{ id: b, reasons: ['possible duplicates to check'] }]);
    const marked = svc.getPending(b)!.draft!.sections[0]!.transactions[0]!;
    expect(marked).toMatchObject({ status: 'possible_duplicate', include: false });
    await expect(svc.commit(b)).resolves.toMatchObject({ status: 'committed', result: { transactionsAdded: 0 } });
    // Had you ticked it again, it would be yours to keep.
  });
});

describe('nothing new: understood, and adds nothing', () => {
  let svc: ImportService;
  let work: WorkArea;
  let seq = 0;
  const make = async (raw: Record<string, unknown>, opts: { at?: string; created?: string; verification?: ImportRecord['extraction']['verification'] } = {}): Promise<string> => {
    const id = `imp_20260929_200900_${(++seq).toString(16).padStart(4, '0')}`;
    const bytes = Buffer.from(`screenshot ${id}`);
    const record: ImportRecord = {
      id,
      status: 'review',
      createdAt: opts.created ?? `2026-09-29T20:09:0${seq % 10}+01:00`,
      updatedAt: '2026-09-29T20:09:00+01:00',
      origin: 'upload',
      document: doc({ id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: `IMG_05${80 + seq}.PNG`, capturedOn: '2026-09-29', capturedOnSource: 'exif', capturedAt: opts.at ?? '2026-09-29T20:08:00+01:00', image: { width: 1206, height: 2622 } }),
      extraction: { warnings: [], raw: ExtractionSchema.parse(raw), ...(opts.verification ? { verification: opts.verification } : {}) },
    };
    await work.init();
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    return id;
  };
  const start = async () => {
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
    for (const r of svc.listPending()) await svc.refreshDraft(r.id);
  };
  const tab = (extra: Record<string, unknown> = {}) => ({ documentType: 'transactions_screenshot', accounts: [{ accountName: 'Premium Bonds', accountType: 'premium_bonds', last4: '7302', closingBalance: 1250, transactions: reinvestments, ...extra }] });
  const bondRecord = (extra: Record<string, unknown> = {}) => ({ documentType: 'account_overview_screenshot', accounts: [{ accountName: 'Premium Bonds', accountType: 'premium_bonds', last4: '7302', closingBalance: 1250, ...extra }] });
  const prizeHistory = { documentType: 'other', accounts: [{ accountType: 'premium_bonds', last4: '7302' }], nothingToRecord: 'A prize history: prizes won, by bond number and month.' };
  beforeEach(async () => {
    work = new WorkArea(path.join(dir, 'work'));
    await store.setAccounts([acct('bonds', 'premium_bonds', { name: 'Premium Bonds', institutionId: 'ns-and-i' }), acct('current', 'current', { last4: '4821' })]);
  });

  it('a view with nothing to record says what it is, in the reader’s words, and is not ready to commit', async () => {
    const id = await make(prizeHistory);
    await start();
    const n = svc.novelty().get(id);
    expect(n).toEqual({ reason: 'A prize history: prizes won, by bond number and month.', coveredBy: [] });
    expect(svc.readiness(svc.getPending(id)!, n)).toEqual({ ready: false, reasons: ['nothing new'] });
  });

  it('a document the reader found nothing in and could not explain is not called empty', async () => {
    const id = await make({ documentType: 'other' });
    await start();
    expect(svc.novelty().has(id)).toBe(false);
  });

  it('not when the reading itself needs a look: readers that disagreed, warnings, low confidence', async () => {
    const disagreed = await make(prizeHistory, { verification: { method: 'second-reading', firstModel: 'sonnet', secondModel: 'opus', reasons: [], disagreements: ['Sonnet found 1 account(s), Opus 0'], kept: 'second' } });
    const unsure = await make({ ...prizeHistory, confidence: 'low' });
    await start();
    expect(svc.novelty().has(disagreed)).toBe(false);
    expect(svc.novelty().has(unsure)).toBe(false);
  });

  it('the same balance on two tabs: the screen with the rows is kept, the other has nothing new', async () => {
    const bonds = await make(bondRecord(), { at: '2026-09-29T20:08:44+01:00' });
    const rows = await make(tab(), { at: '2026-09-29T20:08:33+01:00' });
    await start();
    const novelty = svc.novelty();
    expect(novelty.has(rows)).toBe(false);
    const n = novelty.get(bonds)!;
    expect(n.coveredBy).toEqual([{ id: rows, fileName: svc.getPending(rows)!.document.fileName }]);
    expect(n.reason).toBe(`Everything on it is already here: its balance (£1,250.00 on 29 Sep 2026) is also on ${svc.getPending(rows)!.document.fileName}.`);
  });

  it('two copies of one screen: the earlier upload is kept', async () => {
    const first = await make(bondRecord(), { created: '2026-09-29T20:09:00+01:00' });
    const second = await make(bondRecord(), { created: '2026-09-29T20:09:05+01:00' });
    await start();
    expect([...svc.novelty().keys()]).toEqual([second]);
    expect(svc.novelty().get(second)!.coveredBy[0]!.id).toBe(first);
  });

  it('anything more is something new: another day, another figure, one more row', async () => {
    await make(tab(), { at: '2026-09-29T20:08:33+01:00' });
    const otherValue = await make(bondRecord({ closingBalance: 28550 }));
    const extraFigure = await make(bondRecord({ interestRate: 4.4 }));
    const moreRows = await make(tab({ transactions: [...reinvestments, { date: '2026-06-02', description: 'Auto prize reinvestment', amount: 25 }] }));
    await start();
    for (const id of [otherValue, extraFigure, moreRows]) expect(svc.novelty().has(id), id).toBe(false);
  });

  it('what is already stored counts, however it got there', async () => {
    await store.addBalances([{ id: 'bal_0000000000000001', accountId: 'bonds', date: '2026-09-29', balance: 1250, currency: 'GBP', kind: 'screenshot', source: {}, createdAt: stamp }], 'b');
    const id = await make(bondRecord());
    const approximate = await make(bondRecord({ closingBalance: 28000 }));
    await store.addBalances([{ id: 'bal_0000000000000002', accountId: 'bonds', date: '2026-09-29', balance: 28000, currency: 'GBP', kind: 'manual', approximate: true, source: {}, createdAt: stamp }], 'b');
    await start();
    expect(svc.novelty().get(id)!.reason).toBe('Everything on it is already here: its balance (£1,250.00 on 29 Sep 2026) is already recorded.');
    // A rough figure you gave is not a reading of the account.
    expect(svc.novelty().has(approximate)).toBe(false);
  });

  it('a fund’s own page adds its units and amount invested to the overview’s value: that is new', async () => {
    await store.setAccounts([...store.accounts, acct('lisa', 'lisa', { name: 'Lifetime ISA', institutionId: 'moneybox' })]);
    await store.addHoldings([{ id: 'hld_0000000000000001', accountId: 'lisa', date: '2026-09-29', holdings: [{ name: 'Fidelity Index World Fund P Acc', value: 5204.77, currency: 'GBP' }], totalValue: 9418.62, source: {}, createdAt: stamp }], 'h');
    const fund = { name: 'Fidelity Index World Fund P Acc', value: 5204.77 };
    const page = (h: Record<string, unknown>) => ({ documentType: 'holding_detail_screenshot', accounts: [{ holdings: [{ ...fund, ...h }] }] });
    const fuller = await make(page({ units: 1321.007, costBasis: 4300 }));
    const same = await make(page({}), { created: '2026-09-29T20:09:59+01:00' });
    await start();
    expect(svc.getPending(fuller)!.draft!.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'lisa' });
    expect(svc.novelty().has(fuller)).toBe(false);
    expect(svc.novelty().get(same)!.reason).toBe('Everything on it is already here: its holding is already recorded.');
  });

  it('a section waiting for you to choose its account is never nothing new', async () => {
    const id = await make({ documentType: 'transactions_screenshot', accounts: [{ transactions: reinvestments }] }, { at: '2026-09-29T19:00:00+01:00' });
    await start();
    expect(svc.getPending(id)!.draft!.sections[0]!.target).toEqual({ mode: 'skip' });
    expect(svc.novelty().has(id)).toBe(false);
  });

  it('dismissing files the document and records nothing else; it must still add nothing', async () => {
    const rows = await make(tab(), { at: '2026-09-29T20:08:33+01:00' });
    const bonds = await make(bondRecord(), { at: '2026-09-29T20:08:44+01:00' });
    const prizes = await make(prizeHistory);
    await start();
    await expect(svc.dismiss(rows)).rejects.toThrow(/something new/);
    const filed = await svc.dismiss(bonds);
    expect(filed.status).toBe('committed');
    expect(filed.result).toMatchObject({ transactionsAdded: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0, accountIds: ['bonds'] });
    expect(filed.result!.nothingNew).toMatch(/its balance/);
    expect(existsSync(path.join(dir, 'data', filed.document.path!))).toBe(true);
    expect(store.balances('bonds')).toEqual([]);
    // Not even the account's last digits: nothing was recorded from it.
    expect(store.account('bonds')!.last4).toBeUndefined();
    expect(svc.getPending(bonds)).toBeUndefined();
    // The same file again is recognised as already imported.
    expect((await svc.create({ fileName: 'again.png', bytes: Buffer.from(`screenshot ${bonds}`), origin: 'upload' })).duplicateOf?.id).toBe(bonds);
    expect(await svc.dismissNothingNew()).toEqual([prizes]);
    expect(svc.listPending().map((r) => r.id)).toEqual([rows]);
  });

  it('a new account a dismissed document would have made is not created', async () => {
    await make({ documentType: 'account_overview_screenshot', accounts: [{ institutionName: 'Chase', accountType: 'savings', last4: '3310', closingBalance: 5210.44 }] }, { created: '2026-09-29T20:09:00+01:00' });
    const copy = await make({ documentType: 'account_overview_screenshot', accounts: [{ institutionName: 'Chase', accountType: 'savings', last4: '3310', closingBalance: 5210.44 }] }, { created: '2026-09-29T20:09:05+01:00' });
    await start();
    expect(svc.getPending(copy)!.draft!.sections[0]!.target.mode).toBe('new');
    await svc.dismiss(copy);
    expect(store.accounts.map((a) => a.id)).toEqual(['bonds', 'current']);
  });
});
