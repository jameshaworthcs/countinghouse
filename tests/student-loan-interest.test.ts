// A student loan's interest, which its documents give only as a total for the tax year so far
// (docs/FORMULAS.md §9, "Gaps"): what it grew by between two balances is interest, not a missing
// statement.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BalanceEngine } from '../src/server/analytics/balances';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { SYSTEM_PROMPT } from '../src/server/ingest/prompt';
import { runMigrations, statedTaxYearInterest } from '../src/server/migrations';
import { Store } from '../src/server/store';
import { ExtractionSchema, type Account, type BalanceSnapshot, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const acct = (id: string, type: Account['type']): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, last4: '4321', createdAt: stamp, updatedAt: stamp });
let n = 0;
const bal = (accountId: string, date: string, balance: number, extra: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  id: `bal_${String(++n).padStart(16, '0')}`,
  accountId,
  date,
  balance,
  currency: 'GBP',
  kind: 'statement',
  source: {},
  createdAt: stamp,
  ...extra,
});
// An instalment of the loan before the balances: the gap check needs an account with rows.
const instalment = (accountId: string): Transaction => ({ id: `tx_${String(++n).padStart(16, '0')}`, accountId, date: '2026-01-10', amount: -1000, currency: 'GBP', description: 'EXAMPLE LOAN INSTALMENT', source: {} });
const tyi = (taxYearInterest: number, taxYear = '2026/27') => ({ taxYearInterest, taxYear });

describe('the gap check on a student loan', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-loan-interest-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('loan', 'student_loan'), acct('saver', 'savings')]);
    await store.addTransactions([instalment('loan'), instalment('saver')], 'test');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const gaps = (id: string) => new BalanceEngine(store).gaps(id);

  it('counts what the tax year’s interest grew by between two balances', async () => {
    await store.addBalances([bal('loan', '2026-09-28', -20000, tyi(300)), bal('loan', '2026-10-03', -20087.65, tyi(387.65))], 'test');
    expect(gaps('loan')).toEqual([]);
  });

  it('still shows the gap when the balances do not give the interest', async () => {
    await store.addBalances([bal('loan', '2026-09-28', -20000), bal('loan', '2026-10-03', -20087.65)], 'test');
    expect(gaps('loan')).toEqual([{ from: '2026-09-28', to: '2026-10-03', difference: -87.65 }]);
  });

  it('shows what the stated interest leaves unexplained', async () => {
    await store.addBalances([bal('loan', '2026-09-28', -20000, tyi(300)), bal('loan', '2026-10-03', -20087.65, tyi(350))], 'test');
    expect(gaps('loan')).toEqual([{ from: '2026-09-28', to: '2026-10-03', difference: -37.65 }]);
  });

  it('counts all of a year’s interest when the earlier balance is before that year began', async () => {
    await store.addBalances([bal('loan', '2026-03-20', -19500, tyi(410, '2025/26')), bal('loan', '2026-05-02', -19560.4, tyi(60.4))], 'test');
    expect(gaps('loan')).toEqual([]);
  });

  it('counts nothing between totals of different years when the earlier is inside the later’s year', async () => {
    await store.addBalances([bal('loan', '2026-04-20', -19500, tyi(410, '2025/26')), bal('loan', '2026-05-02', -19560.4, tyi(60.4))], 'test');
    expect(gaps('loan')).toEqual([{ from: '2026-04-20', to: '2026-05-02', difference: -60.4 }]);
  });

  it('leaves an account whose interest is listed as movements alone', async () => {
    await store.addBalances([bal('saver', '2026-09-28', 1000, tyi(10)), bal('saver', '2026-10-03', 1012, tyi(22))], 'test');
    expect(gaps('saver')).toEqual([{ from: '2026-09-28', to: '2026-10-03', difference: 12 }]);
  });

  it('uses a screenshot that adds up once its interest is counted', async () => {
    await store.addBalances(
      [bal('loan', '2026-09-28', -20000, tyi(300)), bal('loan', '2026-10-03', -20087.65, { kind: 'screenshot', ...tyi(387.65) }), bal('loan', '2026-10-20', -20100, tyi(387.65))],
      'test',
    );
    expect(gaps('loan')).toEqual([{ from: '2026-10-03', to: '2026-10-20', difference: -12.35 }]);
  });
});

describe('reading a student loan’s interest for the tax year', () => {
  let dir: string;
  let store: Store;
  let workFile: string;
  const record: ImportRecord = {
    id: 'imp_20261003_120000_0d01',
    status: 'review',
    createdAt: stamp,
    updatedAt: stamp,
    origin: 'upload',
    document: { id: 'doc_00000000000000d1', sha256: 'd1'.repeat(32), fileName: 'loan.pdf', mediaType: 'application/pdf', size: 1 },
    extraction: { warnings: [] },
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-loan-commit-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([acct('loan', 'student_loan')]);
    workFile = path.join(dir, 'loan.pdf');
    await writeFile(workFile, 'x');
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('keeps it with the balance, for the tax year of the balance’s day', async () => {
    const reading = ExtractionSchema.parse({ documentType: 'other', accounts: [{ accountType: 'student_loan', last4: '4321', closingBalance: -20087.65, balanceDate: '2026-10-03', taxYearInterest: 387.65 }] });
    const draft = buildDraft(reading, { store, document: record.document, uploadedOn: '2026-10-03' });
    expect(draft.sections[0]).toMatchObject({ balance: -20087.65, taxYearInterest: 387.65 });
    await commitDraft(store, { record: { ...record, extraction: { warnings: [], raw: reading } }, draft, workFile });
    expect(store.balances('loan')[0]).toMatchObject({ balance: -20087.65, taxYearInterest: 387.65, taxYear: '2026/27' });
  });
});

describe('format v11 migration', () => {
  it('finds the total in a printed summary or a note, for the year of the balance only', () => {
    const printed = { printed: [{ section: '2026-27 summary', label: 'Interest added', value: '+£1,387.65' }] };
    expect(statedTaxYearInterest(printed, '2026/27')).toBe(1387.65);
    expect(statedTaxYearInterest(printed, '2025/26')).toBeNull();
    const note = { notes: ['The 2026-27 summary (since 6 April 2026) shows salary repayments £0.00 and interest added +£300.00.'] };
    expect(statedTaxYearInterest(note, '2026/27')).toBe(300);
    expect(statedTaxYearInterest({ notes: ['Interest added +£300.00.'] }, '2026/27')).toBeNull();
    expect(statedTaxYearInterest({ printed: [{ section: '2026-27 summary', label: 'Salary repayments', value: '£0.00' }] }, '2026/27')).toBeNull();
  });

  describe('on a data directory', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'finance-migrate11-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    it('backfills each student loan balance from the reading that recorded it', async () => {
      await mkdir(path.join(dir, 'balances'), { recursive: true });
      await mkdir(path.join(dir, 'imports', '2026'), { recursive: true });
      await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 10, baseCurrency: 'GBP', createdAt: stamp }));
      await writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [acct('loan', 'student_loan'), acct('saver', 'savings')] }));
      const imp = (id: string, accountId: string, balanceDate: string, raw: object) => ({
        id,
        status: 'committed',
        extraction: { raw },
        draft: { sections: [{ key: 's0', balanceDate }] },
        result: { sections: [{ key: 's0', accountId }] },
      });
      const imports: [string, string, string, object][] = [
        ['imp_20260928_120000_0e01', 'loan', '2026-09-28', { notes: ['The 2026-27 summary (since 6 April 2026) shows interest added +£300.00.'] }],
        ['imp_20261003_120000_0e02', 'loan', '2026-10-03', { printed: [{ section: '2026-27 summary', label: 'Interest added', value: '+£387.65' }] }],
        ['imp_20261003_120000_0e03', 'saver', '2026-10-03', { printed: [{ section: '2026-27 summary', label: 'Interest added', value: '+£12.00' }] }],
      ];
      for (const [id, accountId, date, raw] of imports) await writeFile(path.join(dir, 'imports', '2026', `${id}.json`), JSON.stringify(imp(id, accountId, date, raw)));
      const loan = [bal('loan', '2026-09-28', -20000, { source: { importId: imports[0]![0] } }), bal('loan', '2026-10-03', -20087.65, { source: { importId: imports[1]![0] } }), bal('loan', '2026-10-10', -20087.65, { kind: 'manual' })];
      await writeFile(path.join(dir, 'balances', 'loan.jsonl'), `${loan.map((l) => JSON.stringify(l)).join('\n')}\n`);
      await writeFile(path.join(dir, 'balances', 'saver.jsonl'), `${JSON.stringify(bal('saver', '2026-10-03', 1012, { source: { importId: imports[2]![0] } }))}\n`);

      expect(await runMigrations(dir, () => undefined)).toMatchObject({ from: 10, to: 11 });
      const read = async (f: string) =>
        (await readFile(path.join(dir, 'balances', f), 'utf8'))
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as BalanceSnapshot);
      expect((await read('loan.jsonl')).map((b) => [b.date, b.taxYearInterest ?? null, b.taxYear ?? null])).toEqual([
        ['2026-09-28', 300, '2026/27'],
        ['2026-10-03', 387.65, '2026/27'],
        ['2026-10-10', null, null],
      ]);
      expect((await read('saver.jsonl'))[0]!.taxYearInterest).toBeUndefined();
    });
  });
});

describe('the reader on a student loan’s page', () => {
  it('takes the tax year’s interest from its summary, never as a transaction', () => {
    expect(SYSTEM_PROMPT).toMatch(/summary of the tax year so far \("since 6 April"\) gives taxYearInterest/);
    expect(SYSTEM_PROMPT).toMatch(/totals for the year, never transactions/);
  });
});
