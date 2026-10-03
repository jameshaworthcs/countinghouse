// Documents whose facts had no home before (docs/INGESTION.md, "Schedules", "Nothing new", "Linked
// accounts"): a schedule of payments drafted as the agreement it is, and student finance's paid
// instalments as its student loan's movements; a reading that mentions payments already recorded is
// not "nothing new"; a filed document can be opened again; a statement that runs across the day one
// account carries on from another is split between them. Nothing here reads a document with
// Claude; every name and amount is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agreementsView } from '../src/server/analytics/agreements';
import { BalanceEngine } from '../src/server/analytics/balances';
import { flows } from '../src/server/analytics/cashflow';
import { loadConfig } from '../src/server/config';
import { sha256 } from '../src/server/fsutil';
import { documentId, transactionId } from '../src/server/ids';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { paymentLabel } from '../src/server/ingest/schedules';
import { ImportService } from '../src/server/ingest/service';
import { WorkArea } from '../src/server/ingest/workarea';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { ExtractionSchema, type Account, type ImportRecord, type Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, seq++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

/** A student finance payments page, as the reader that reads everything gives it. */
const studentFinancePage = {
  documentType: 'other',
  institutionName: 'Student Finance England',
  documentDate: '2026-10-03',
  accounts: [],
  schedules: [
    {
      provider: 'Student Finance England',
      name: 'Maintenance Loan 2026/27',
      direction: 'to-you',
      payments: [
        { date: '2026-09-14', amount: 1500, label: 'Instalment 1', status: 'paid' },
        { date: '2027-01-04', amount: 1500, label: 'Instalment 2', status: 'due' },
      ],
      details: [{ label: 'Course', value: 'Example Studies' }],
    },
    {
      provider: 'Student Finance England',
      name: 'Tuition Fee Loan 2026/27',
      direction: 'to-other',
      paidTo: 'University of Example',
      payments: [
        { date: '2026-09-25', amount: 2400, label: 'Term 1', status: 'paid' },
        { date: '2027-02-03', amount: 2400, label: 'Term 2', status: 'awaiting' },
      ],
      details: [],
    },
  ],
};

describe('schedules in a reading', () => {
  it('are kept with their payments, positive, their statuses, and details as text', () => {
    const { extraction } = normaliseExtraction({
      ...studentFinancePage,
      schedules: [
        {
          provider: 'Student Finance England',
          name: 'Maintenance Loan 2026/27',
          direction: 'to-you',
          paidTo: null,
          from: null,
          until: null,
          reference: null,
          total: '£3,000.00',
          payments: [
            { date: '14/09/2026', amount: -1500, label: null, status: 'paid' },
            { date: '2027-01-04', amount: '£1,500.00', label: 'Instalment 2', status: 'ready to be paid' },
          ],
          details: [{ label: 'Course year', value: '4' }, { label: 'Course', value: 'Example Studies' }],
        },
      ],
    });
    expect(extraction.schedules).toEqual([
      {
        provider: 'Student Finance England',
        name: 'Maintenance Loan 2026/27',
        direction: 'to-you',
        total: 3000,
        payments: [
          { date: '2026-09-14', amount: 1500, status: 'paid' },
          { date: '2027-01-04', amount: 1500, label: 'Instalment 2' },
        ],
        details: [{ label: 'Course year', value: '4' }, { label: 'Course', value: 'Example Studies' }],
      },
    ]);
  });
});

describe('what a reader gives that is not a schedule', () => {
  it('a total with no payment dates is a note, not a warning; a label that only restates the status is dropped', () => {
    const { extraction, warnings } = normaliseExtraction({ ...studentFinancePage, notes: [], schedules: [{ provider: 'Student Finance England', name: 'Maintenance Loan 2026/27', direction: 'to-you', total: 3000, payments: [], details: [] }] });
    expect(extraction.schedules).toEqual([]);
    expect(warnings).toEqual([]);
    expect(extraction.notes).toEqual(['Maintenance Loan 2026/27: £3,000.00 in all, with no payment dates, so not kept as a schedule.']);
    expect(paymentLabel("Paid - We've paid you")).toBeUndefined();
    expect(paymentLabel('Ready to be paid')).toBeUndefined();
    expect(paymentLabel('Instalment 2')).toBe('Instalment 2');
  });
});

describe('importing', () => {
  let dir: string;
  let store: Store;
  let work: WorkArea;
  let svc: ImportService;
  let n = 0;

  /** An import waiting for review, read as `raw`. */
  const pending = async (raw: unknown, extra: Partial<ImportRecord> = {}): Promise<string> => {
    const bytes = Buffer.from(`document ${++n}`);
    const id = `imp_20261003_120000_${n.toString(16).padStart(4, "0")}`;
    const record: ImportRecord = {
      id,
      status: 'review',
      createdAt: '2026-10-03T12:00:00+01:00',
      updatedAt: '2026-10-03T12:00:00+01:00',
      origin: 'upload',
      document: { id: documentId(sha256(bytes)), sha256: sha256(bytes), fileName: `document-${n}.pdf`, mediaType: 'application/pdf', size: bytes.length },
      extraction: { engine: 'claude-cli', engineVersion: 'extract-15', warnings: [], raw: ExtractionSchema.parse(raw) },
      ...extra,
    };
    await work.saveFile(record.document, bytes);
    await work.saveRecord(record);
    return id;
  };
  const start = async () => {
    svc = new ImportService(store, loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), work);
    await svc.init();
  };
  const draftOf = async (id: string) => (svc.getPending(id)?.draft ? svc.getPending(id)! : await svc.refreshDraft(id)).draft!;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-schedules-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setCategories(defaultCategories());
    work = new WorkArea(path.join(dir, 'work'));
    await work.init();
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  describe('a student finance payments page', () => {
    beforeEach(async () => {
      await store.setAccounts([acct('current', 'current'), acct('loan', 'student_loan', { institutionId: 'slc', includeInNetWorth: false })]);
      await store.addTransactions([tx('current', '2026-09-14', 1500, 'Bank Giro Credit')], 't');
      await store.addBalances([{ id: 'bal_00000000000000a1', accountId: 'loan', date: '2026-09-29', balance: -30000, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp }], 'b');
    });

    it('drafts each part as an agreement, and the paid instalments as the loan’s movements', async () => {
      const id = await pending(studentFinancePage);
      await start();
      const draft = await draftOf(id);
      const [maintenance, tuition] = draft.agreements!;
      expect(maintenance).toMatchObject({ include: true, target: { mode: 'new' }, record: { name: 'Maintenance Loan 2026/27', counterparty: 'Student Finance England', direction: 'in', category: 'transfer', accountId: 'loan', statusAsOf: '2026-10-03' } });
      // The bank credit that names nobody is its first instalment.
      expect(maintenance!.explains).toEqual([expect.objectContaining({ index: 0, accountId: 'current', date: '2026-09-14', amount: 1500 })]);
      expect(tuition).toMatchObject({ record: { counterparty: 'University of Example', paidBy: 'Student Finance England', accountId: 'loan', category: 'courses' } });
      expect(tuition!.record.direction).toBeUndefined();

      const loanRows = draft.sections.find((s) => s.target.mode === 'existing' && s.target.accountId === 'loan')!.transactions;
      expect(loanRows.map((t) => [t.date, t.amount, t.category, t.categorisedBy])).toEqual([
        ['2026-09-14', -1500, 'transfer', 'transfer'],
        ['2026-09-25', -2400, 'courses', 'agreement'],
      ]);
      expect(loanRows[0]!.transferMatch).toBe(store.transactions('current')[0]!.id);
      expect(loanRows[1]!.description).toBe('Tuition Fee Loan 2026/27 (Term 1): paid to University of Example');
      // Not nothing new, and held back once for a look at the new schedules.
      expect(svc.novelty().has(id)).toBe(false);
      expect(svc.readiness(svc.getPending(id)!).reasons).toContain('a new schedule to check');
    });

    it('on commit records the agreements, links the instalment as borrowing, and the fees count as spending', async () => {
      const id = await pending(studentFinancePage);
      await start();
      await draftOf(id);
      const done = await svc.commit(id);
      expect(done.result?.agreementsAdded).toBe(2);
      const credit = store.transactions('current')[0]!;
      expect(credit).toMatchObject({ category: 'transfer', counterpartyAccountId: 'loan' });
      expect(credit.transferGroup).toBeDefined();
      const views = agreementsView(store, '2026-10-03');
      const maintenance = views.find((v) => v.agreement.direction === 'in')!;
      expect(maintenance.payments.map((p) => p.status)).toEqual(['paid', 'upcoming']);
      const tuition = views.find((v) => v.agreement.paidBy)!;
      expect(tuition.payments.map((p) => p.status)).toEqual(['paid', 'upcoming']);
      // The fees paid for you are education spending; the instalment is not income.
      const counted = flows(store, '2026-09-01', '2026-09-30');
      expect(counted.map((f) => [f.cls, f.t.category, f.minor])).toEqual([['spending', 'courses', 240000]]);
      // A later instalment the bank shows before a newer page does is still borrowing.
      await store.addTransactions([tx('current', '2027-01-05', 1500, 'Bank Giro Credit')], 't2');
      const { categoriserFor, categoriseInputOf } = await import('../src/server/categoriser');
      const later = store.transactions('current').find((t) => t.date === '2027-01-05')!;
      expect(categoriserFor(store).categorise(categoriseInputOf(later))).toMatchObject({ category: 'transfer', categorisedBy: 'agreement', counterpartyAccountId: 'loan', payee: 'Student Finance England' });
    });

    it('a second document with the same schedule fills in what it adds, and nothing when it adds nothing', async () => {
      const first = await pending(studentFinancePage);
      await start();
      await draftOf(first);
      await svc.commit(first);
      const later = { ...studentFinancePage, documentDate: '2026-10-25', schedules: [{ ...studentFinancePage.schedules[1]!, payments: [{ date: '2026-09-25', amount: 2400, label: 'Term 1', status: 'paid' }, { date: '2027-02-03', amount: 2400, label: 'Term 2', status: 'due' }] }] };
      const same = await pending({ ...studentFinancePage, schedules: [studentFinancePage.schedules[0]] });
      const newer = await pending(later);
      await start();
      expect((await draftOf(same)).agreements![0]).toMatchObject({ include: false, target: { mode: 'existing' }, adds: { payments: 0, statuses: 0 } });
      expect(svc.novelty().get(same)?.reason).toMatch(/schedule \(Maintenance Loan 2026\/27\) is already recorded/);
      expect((await draftOf(newer)).agreements![0]).toMatchObject({ include: true, target: { mode: 'existing' }, adds: { payments: 0, statuses: 1 } });
    });

    it('two documents waiting with the same schedule record it once, whichever is committed first', async () => {
      const letter = await pending({ ...studentFinancePage, schedules: [{ ...studentFinancePage.schedules[1]!, payments: studentFinancePage.schedules[1]!.payments.map((p) => ({ ...p, status: 'scheduled' })) }] });
      const page = await pending(studentFinancePage);
      await start();
      await draftOf(letter);
      await draftOf(page);
      expect((await draftOf(letter)).agreements![0]!.target.mode).toBe('new');
      expect((await draftOf(page)).agreements![1]!.target.mode).toBe('new');
      await svc.commit(letter);
      await svc.commit(page);
      const tuition = store.agreements.filter((a) => a.paidBy);
      expect(tuition).toHaveLength(1);
      // The page is the later document: its statuses stand.
      expect(tuition[0]!.payments.map((p) => p.status)).toEqual(['paid', 'awaiting']);
    });

    it('the loan’s balance worked out from its movements away from a statement is an estimate', async () => {
      const id = await pending(studentFinancePage);
      await start();
      await draftOf(id);
      await svc.commit(id);
      const engine = new BalanceEngine(store);
      expect(engine.balanceOn('loan', '2026-09-29')).toMatchObject({ value: -30000, estimated: false });
      expect(engine.balanceOn('loan', '2026-09-22')).toMatchObject({ value: -27600, estimated: true });
    });
  });

  it('a reading with no place for payments it mentions, recorded already, is not "nothing new": read it again', async () => {
    await store.setAccounts([acct('current', 'current')]);
    await store.addTransactions([tx('current', '2026-09-14', 1500, 'Bank Giro Credit')], 't');
    const id = await pending({ documentType: 'other', accounts: [], notes: ['A payments page: instalments (14 Sep 2026 £1,500.00 Paid; 04 Jan 2027 £1,500.00 Due).'], nothingToRecord: 'A schedule of payments.' });
    await start();
    await draftOf(id);
    expect(svc.novelty().has(id)).toBe(false);
    expect(svc.readiness(svc.getPending(id)!).reasons).toEqual(expect.arrayContaining([expect.stringMatching(/mentions a payment already recorded .* read it again/)]));
  });

  it('a document filed as nothing new can be opened again, drafted as the app drafts it now', async () => {
    await store.setAccounts([acct('current', 'current')]);
    const id = await pending({ documentType: 'other', accounts: [], nothingToRecord: 'A help screen.' });
    await start();
    await draftOf(id);
    const filed = await svc.dismiss(id);
    expect(filed.result?.nothingNew).toBe('A help screen.');
    const again = await svc.reopen(id);
    expect(again).toMatchObject({ status: 'review', reopens: id });
    expect(again.id).not.toBe(id);
    expect(again.draft?.nothingToRecord).toBe('A help screen.');
    await expect(svc.reopen(again.id)).rejects.toThrow(/Only a document filed as adding nothing new/);
  });

  describe('linked accounts', () => {
    // A two-year fixed rate that matured into easy access under the same number.
    const statement = {
      documentType: 'savings_statement',
      institutionName: 'Example Savings Bank',
      accounts: [
        {
          institutionName: 'Example Savings Bank',
          accountName: 'Easy Access',
          accountType: 'savings',
          last4: '4321',
          periodStart: '2023-09-14',
          periodEnd: '2026-10-01',
          openingBalance: 0,
          closingBalance: 1.23,
          transactions: [
            { date: '2023-09-14', amount: 500, description: 'Faster Payment', balanceAfter: 500 },
            { date: '2023-09-14', amount: 18750.4, description: 'Faster Payment', balanceAfter: 19250.4 },
            { date: '2024-09-13', amount: 924.02, description: 'Interest Added', balanceAfter: 20174.42 },
            { date: '2025-09-13', amount: 968.37, description: 'Interest Added', balanceAfter: 21142.79 },
            { date: '2025-10-02', amount: -21141.56, description: 'To 00012345', balanceAfter: 1.23 },
          ],
        },
      ],
    };
    beforeEach(async () => {
      await store.upsertInstitution({ id: 'example-savings', name: 'Example Savings Bank', kind: 'bank' });
      await store.setAccounts([
        acct('fixed', 'savings', { name: 'Example 2 Year Fixed', institutionId: 'example-savings', last4: '4321', status: 'closed', openedOn: '2023-09-14', closedOn: '2025-09-12' }),
        acct('easy', 'savings', { name: 'Example Easy Access', institutionId: 'example-savings', last4: '4321', openedOn: '2025-09-13' }),
      ]);
      await store.addTransactions([tx('fixed', '2023-09-14', 500, 'Faster Payment'), tx('fixed', '2023-09-14', 18750.4, 'Faster Payment')], 't');
    });

    it('unlinked, the older account’s rows are left out as recorded under the same number, and rows before it opened are flagged', async () => {
      const id = await pending(statement);
      await start();
      const draft = await draftOf(id);
      expect(draft.sections).toHaveLength(1);
      const rows = draft.sections[0]!.transactions;
      expect(rows.slice(0, 2).map((t) => [t.status, t.include])).toEqual([
        ['possible_duplicate', false],
        ['possible_duplicate', false],
      ]);
      expect(draft.notes.join(' ')).toMatch(/recorded already on Example 2 Year Fixed, under the same account number/);
      expect(svc.readiness(svc.getPending(id)!).reasons).toContain('rows outside the account’s open dates');
    });

    it('linked, a statement that runs across the day is split between the two, with the balance carried over', async () => {
      const easy = store.account('easy')!;
      await store.upsertAccount({ ...easy, continues: { accountId: 'fixed', from: '2025-09-13' } });
      const id = await pending(statement);
      await start();
      const draft = await draftOf(id);
      const [older, newer] = draft.sections;
      expect(older).toMatchObject({ target: { mode: 'existing', accountId: 'fixed' }, balance: 20174.42, balanceDate: '2024-09-13' });
      expect(older!.transactions.map((t) => [t.date, t.status])).toEqual([
        ['2023-09-14', 'duplicate'],
        ['2023-09-14', 'duplicate'],
        ['2024-09-13', 'new'],
      ]);
      expect(newer).toMatchObject({ target: { mode: 'existing', accountId: 'easy' }, openingBalance: 20174.42, balance: 1.23 });
      expect(newer!.transactions.map((t) => t.date)).toEqual(['2025-09-13', '2025-10-02']);
      expect(draft.notes.join(' ')).toMatch(/Split at 13 Sep 2025, where Example Easy Access carries on from Example 2 Year Fixed/);
      expect(svc.readiness(svc.getPending(id)!).reasons).not.toContain('rows outside the account’s open dates');
    });

    it('a section moved to another account on the review page is checked again against it', async () => {
      const id = await pending(statement);
      await start();
      const section = (await draftOf(id)).sections[0]!;
      const moved = svc.redraftSection({ ...section, target: { mode: 'existing', accountId: 'fixed' } });
      expect(moved.transactions.slice(0, 2).map((t) => [t.status, t.include])).toEqual([
        ['duplicate', false],
        ['duplicate', false],
      ]);
      expect(moved.transactions[2]).toMatchObject({ status: 'new', include: true });
    });
  });
});
