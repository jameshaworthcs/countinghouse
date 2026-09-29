// Regressions for the problems a review of the codebase found on 28 September 2026.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances } from '../src/server/analytics/allowances';
import { enrich } from '../src/server/enrich';
import { figureId, transactionId } from '../src/server/ids';
import { commitDraft } from '../src/server/ingest/commit';
import { buildDraft } from '../src/server/ingest/draft';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { parseOfx } from '../src/server/ingest/ofx';
import { Store } from '../src/server/store';
import { CategoryIndex, defaultCategories } from '../src/shared/categories';
import { Categoriser } from '../src/shared/categorise';
import { addDays, addYears, today } from '../src/shared/dates';
import { isMoney } from '../src/shared/money';
import { ExtractionSchema, type Account, type Figure, type ImportRecord, type Transaction } from '../src/shared/schema';
import { grossUpReliefAtSource, statePensionDate, statePensionFullYearly, taxYear, taxYearParams } from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, ...extra });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-fixes-'));
  store = await Store.open(path.join(dir, 'data'));
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('allowances', () => {
  it('a bank payment to a SIPP is not counted again when the SIPP statement has it', async () => {
    await store.setAccounts([acct('current', 'current'), acct('sipp', 'sipp', { pension: { method: 'relief_at_source' } })]);
    await store.addTransactions(
      [
        // Paid on 1 May, credited to the SIPP 8 days later: too far apart to be linked as one transfer.
        tx('current', '2026-05-01', -800, 'AJ BELL SIPP', { category: 'investment-transfer', counterpartyAccountId: 'sipp' }),
        tx('sipp', '2026-05-09', 800, 'Contribution', { category: 'contribution' }),
        tx('sipp', '2026-06-20', 200, 'Tax relief', { category: 'tax-relief' }),
      ],
      't',
    );
    const a = allowances(store, '2026/27', '2026-09-29');
    expect(a.pension.personal).toBe(800);
    expect(a.pension.personalGross).toBe(1000);
  });

  it('without the SIPP’s own statement the bank payment still counts', async () => {
    await store.setAccounts([acct('current', 'current'), acct('sipp', 'sipp')]);
    await store.addTransactions([tx('current', '2026-05-01', -800, 'AJ BELL SIPP', { category: 'investment-transfer', counterpartyAccountId: 'sipp' })], 't');
    const a = allowances(store, '2026/27', '2026-09-29');
    expect(a.pension.personal).toBe(800);
    expect(a.pension.personalGross).toBe(grossUpReliefAtSource(800, taxYear(2026)));
  });

  it('carry-forward is unknown, not £60,000, when a year’s contributions are not known', async () => {
    await store.setAccounts([acct('pension', 'workplace_pension', { openedOn: '2020-01-01' })]);
    await store.addTransactions([tx('pension', '2026-05-28', 500, 'Employer', { category: 'employer-contribution' })], 't');
    const cf = allowances(store, '2026/27', '2026-09-29').pension.carryForward;
    expect(cf).toHaveLength(3);
    for (const c of cf) expect(c.unused).toBeNull();
    expect(cf[0]!.basis).toMatch(/not fully known|No pension data/);
  });

  it('pension figures from documents: what you paid plus the relief shown is the gross', async () => {
    await store.setAccounts([acct('sipp', 'sipp')]);
    const fig = (kind: Figure['kind'], amount: number): Figure => ({ id: figureId(kind, amount, '2026/27', 'AJ Bell', kind), kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', payer: 'AJ Bell', source: {}, createdAt: stamp });
    await store.addFigures([fig('pension_contribution_employee', 4000), fig('pension_tax_relief', 1000), fig('pension_contribution_employer', 1500)], 'f');
    const p = allowances(store, '2026/27', '2026-09-29').pension;
    expect(p).toMatchObject({ personalGross: 5000, employer: 1500, total: 6500 });
  });

  it('says an allowance is a minimum when the data starts after the tax year began', async () => {
    await store.setAccounts([acct('isa', 'stocks_isa'), acct('lisa', 'lisa'), acct('new-isa', 'stocks_isa', { openedOn: '2026-09-01' })]);
    await store.addTransactions(
      [
        // Only September's statement: April to August are not in the data.
        tx('isa', '2026-09-01', 600, 'Subscription', { category: 'contribution' }),
        tx('isa', '2026-09-20', 5, 'Interest', { category: 'investment-income' }),
        // Opened in September: covered from its opening.
        tx('new-isa', '2026-09-02', 100, 'Subscription', { category: 'contribution' }),
      ],
      't',
    );
    // The LISA provider's "paid in this tax year" figure is complete by itself.
    await store.addBalances([{ id: 'bal_00000000000000aa', accountId: 'lisa', date: '2026-09-20', balance: 9000, currency: 'GBP', kind: 'screenshot', taxYearContributions: 2000, taxYear: '2026/27', source: {}, createdAt: stamp }], 't');
    const a = allowances(store, '2026/27', '2026-09-29');
    expect(a.isa.used).toBe(2700);
    expect(a.isa.incomplete).toMatch(/^Not counted yet: subscriptions before your data starts, for isa \(data from 1 Sep 2026\)/);
    expect(a.isa.incomplete).not.toContain('new-isa');
    expect(a.lisa!.incomplete).toBeNull();
  });

  it('a tax year covered from its start is complete', async () => {
    await store.setAccounts([acct('isa', 'stocks_isa')]);
    const months = ['2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'];
    await store.addTransactions(months.map((d) => tx('isa', d, 500, 'Subscription', { category: 'contribution' })), 't');
    const a = allowances(store, '2026/27', '2026-09-29');
    expect(a.isa).toMatchObject({ used: 3000, incomplete: null });
  });

  it('carry-forward is counted for a year the data covers from start to end', async () => {
    await store.setAccounts([acct('pension', 'workplace_pension')]);
    // Monthly contributions from Jan 2024 to Sep 2026: 2024/25 and 2025/26 are covered in full;
    // 2023/24 only from January, so it stays unknown.
    const months = Array.from({ length: 33 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-28`);
    await store.addTransactions(months.map((d) => tx('pension', d, 500, 'Employer', { category: 'employer-contribution' })), 't');
    const cf = allowances(store, '2026/27', '2026-09-29').pension.carryForward;
    expect(cf.map((c) => c.taxYear)).toEqual(['2023/24', '2024/25', '2025/26']);
    expect(cf[0]!.unused).toBeNull();
    expect(cf[1]!.unused).toBe(60_000 - 12 * 500);
    expect(cf[2]!.unused).toBe(60_000 - 12 * 500);
  });
});

describe('the Overview with a first snapshot', () => {
  it('does not show accounts arriving as growth, and asks only for what is missing', async () => {
    const { Analytics } = await import('../src/server/analytics');
    await store.setProfile({ ...store.profile, name: 'Sam', dateOfBirth: '2005-03-21' });
    await store.setAccounts([acct('card', 'credit_card'), acct('isa', 'stocks_isa')]);
    await store.addBalances(
      [
        { id: 'bal_00000000000000c1', accountId: 'card', date: '2026-06-30', balance: -1138, currency: 'GBP', kind: 'manual', source: {}, createdAt: stamp },
        { id: 'bal_00000000000000c2', accountId: 'isa', date: today(), balance: 110000, currency: 'GBP', kind: 'manual', approximate: true, source: {}, createdAt: stamp },
      ],
      't',
    );
    const s = new Analytics(store).summary({});
    expect(s.estate.value).toBe(108862);
    // Thirty days ago the ISA had no data: that is not £110,000 of growth.
    expect(s.deltas.map((d) => d.change)).toEqual([null, null, null]);
    // With no transactions, this month's spending is unknown, not £0.
    expect(s.monthToDate.spending).toBeNull();
    expect(s.alerts.find((a) => a.id === 'profile')).toMatchObject({ title: 'Add your tax band', detail: 'It drives your savings allowance and tax figures.' });
  });

  it('an account opened since, with data from its opening, does not hold the comparison back', async () => {
    const { Analytics } = await import('../src/server/analytics');
    const now = today();
    const opened = addDays(now, -10);
    await store.setAccounts([acct('current', 'current'), acct('saver', 'savings', { openedOn: opened })]);
    await store.addBalances(
      [
        { id: 'bal_00000000000000d1', accountId: 'current', date: addYears(now, -2), balance: 2000, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp },
        { id: 'bal_00000000000000d2', accountId: 'saver', date: opened, balance: 500, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp },
      ],
      't',
    );
    const s = new Analytics(store).summary({});
    // Thirty days ago the saver had not opened: it held nothing, so the £500 is a real change.
    expect(s.deltas.map((d) => d.change)).toEqual([500, 500, 500]);
    // Without an opening date, its first balance could be years of history: no comparison.
    await store.setAccounts([acct('current', 'current'), acct('saver', 'savings')]);
    expect(new Analytics(store).summary({}).deltas.map((d) => d.change)).toEqual([null, null, null]);
  });
});

describe('spending this month so far', () => {
  const now = '2026-09-29';
  const month = async (rows: Transaction[]) => {
    const { monthToDate } = await import('../src/server/analytics/spending');
    const { Coverage } = await import('../src/server/analytics/coverage');
    await store.setAccounts([acct('current', 'current')]);
    if (rows.length) await store.addTransactions(rows, 't');
    return monthToDate(store, new Coverage(store), now);
  };

  it('is unknown, not £0, before any day of the month has data', async () => {
    expect(await month([])).toEqual({ spending: null, change: null, note: 'no day this month has data for every account yet' });
  });

  it('compares like for like: the same days last month, where both months have data', async () => {
    const m = await month([
      tx('current', '2026-08-01', -30, 'TESCO'),
      tx('current', '2026-08-15', -20, 'PRET'),
      tx('current', '2026-08-31', -99, 'RENT'), // after 29 August: not one of the days compared
      tx('current', '2026-09-01', -80, 'TESCO'),
      tx('current', '2026-09-29', 1, 'INTEREST'),
    ]);
    expect(m).toEqual({ spending: 80, change: 30, note: null });
  });

  it('makes no comparison on a sliver of the month, or without last month’s data', async () => {
    const early = await month([tx('current', '2026-08-01', -30, 'TESCO'), tx('current', '2026-09-01', -80, 'TESCO'), tx('current', '2026-09-05', -5, 'PRET')]);
    expect(early).toEqual({ spending: 85, change: null, note: 'only 5 of 29 days so far have data for every account' });
  });

  it('says when last month has no data to compare with', async () => {
    const m = await month([tx('current', '2026-09-01', -80, 'TESCO'), tx('current', '2026-09-29', -5, 'PRET')]);
    expect(m).toEqual({ spending: 85, change: null, note: 'not enough data for 1 Aug – 29 Aug to compare' });
  });
});

describe('pending rows, payees and corrections', () => {
  it('pending rows are shown but not included by default', async () => {
    await store.setAccounts([acct('current', 'current', { last4: '1234' })]);
    const extraction = ExtractionSchema.parse({
      documentType: 'transactions_screenshot',
      accounts: [{ accountType: 'current', last4: '1234', transactions: [{ date: '2026-09-20', description: 'TESCO', amount: -12.5, pending: true }, { date: '2026-09-19', description: 'PRET', amount: -4.1 }] }],
    });
    const draft = buildDraft(extraction, { store, document: { id: 'doc_0000000000000001', sha256: '1'.repeat(64), fileName: 'x.png', mediaType: 'image/png', size: 1 }, uploadedOn: '2026-09-21' });
    const rows = draft.sections[0]!.transactions;
    expect(rows.find((r) => r.description === 'TESCO')).toMatchObject({ include: false, pending: true });
    expect(rows.find((r) => r.description === 'PRET')).toMatchObject({ include: true });
  });

  it('re-running enrichment keeps a payee you set', async () => {
    await store.setAccounts([acct('current', 'current')]);
    await store.setCategories(defaultCategories());
    const t = tx('current', '2026-09-01', -9.99, 'SQ *THE CORNER CAFE', { payee: 'Corner Cafe (Tom’s)', payeeSetBy: 'user' });
    await store.addTransactions([t], 't');
    await enrich(store);
    expect(store.transaction(t.id)!.payee).toBe('Corner Cafe (Tom’s)');
  });

  it('drafts: foreign amounts take the payment’s sign, unsure notes and printed totals carry through, empty accounts are left out', async () => {
    await store.setAccounts([acct('card', 'credit_card', { last4: '1005' })]);
    // As the model returns it: strings for money, a lower-case currency.
    const { extraction } = normaliseExtraction({
      documentType: 'credit_card_statement',
      accounts: [
        {
          accountType: 'credit_card',
          last4: '1005',
          statedMoneyIn: 612.4,
          statedMoneyOut: '£1,080.22',
          transactions: [
            { date: '2026-08-21', description: 'LE COMPTOIR PARIS', amount: -38.92, originalAmount: 45, originalCurrency: 'eur' },
            { date: '2026-08-22', description: 'SHELL', amount: -54.23, uncertain: 'amount partly cut off' },
          ],
        },
        // The account an interest certificate mentions: nothing to import.
        { accountType: 'savings', last4: '7733', accountName: 'Online Savings Account' },
      ],
    });
    const draft = buildDraft(extraction, { store, document: { id: 'doc_0000000000000002', sha256: '2'.repeat(64), fileName: 's.pdf', mediaType: 'application/pdf', size: 1 }, uploadedOn: '2026-09-21' });
    expect(draft.sections).toHaveLength(1);
    const [s] = draft.sections;
    expect(s!.statedTotals).toEqual({ moneyIn: 612.4, moneyOut: 1080.22 });
    expect(s!.transactions[0]!.original).toEqual({ amount: -45, currency: 'EUR' });
    expect(s!.transactions[1]!.uncertain).toBe('amount partly cut off');
  });

  it('the model’s money strings go through the bank-amount parser', () => {
    const { extraction } = normaliseExtraction({ documentType: 'bank_statement', accounts: [{ closingBalance: '(1,234.56)', transactions: [{ date: '2026-09-01', description: 'X', amount: '12.30 DR' }] }] });
    expect(extraction.accounts[0]!.closingBalance).toBe(-1234.56);
    expect(extraction.accounts[0]!.transactions[0]!.amount).toBe(-12.3);
  });

  it('isMoney accepts large amounts and rejects 3 decimal places', () => {
    expect(isMoney(156_810_164.61)).toBe(true);
    expect(isMoney(0.1 + 0.2)).toBe(false);
    expect(isMoney(12.345)).toBe(false);
  });
});

describe('committing an import twice adds nothing twice', () => {
  it('is idempotent on retry', async () => {
    await store.setAccounts([acct('current', 'current')]);
    const workFile = path.join(dir, 'upload.csv');
    await writeFile(workFile, 'x');
    const record: ImportRecord = {
      id: 'imp_20260928_120000_abcd',
      status: 'review',
      createdAt: stamp,
      updatedAt: stamp,
      origin: 'upload',
      document: { id: 'doc_00000000000000ab', sha256: 'ab'.repeat(32), fileName: 'upload.csv', mediaType: 'text/csv', size: 1 },
      extraction: { warnings: [] },
    };
    const draft = {
      documentType: 'csv_export' as const,
      sections: [
        {
          key: 's0',
          detected: {},
          target: { mode: 'existing' as const, accountId: 'current' },
          currency: 'GBP',
          recordBalance: true,
          balance: 100,
          balanceDate: '2026-09-02',
          transactions: [
            { key: 'a', include: true, status: 'new' as const, date: '2026-09-01', amount: -3, description: 'COFFEE' },
            { key: 'b', include: true, status: 'new' as const, date: '2026-09-01', amount: -3, description: 'COFFEE' },
          ],
          recordHoldings: false,
          holdings: [],
        },
      ],
      figures: [],
      notes: [],
    };
    const first = await commitDraft(store, { record, draft, workFile });
    expect(first.result!.transactionsAdded).toBe(2);
    const second = await commitDraft(store, { record, draft, workFile });
    expect(second.result!.transactionsAdded).toBe(0);
    expect(store.transactions('current')).toHaveLength(2);
    expect(store.balances('current')).toHaveLength(1);
  });

  it('an account set up without its number learns it from its first statement', async () => {
    await store.setAccounts([acct('card', 'credit_card'), acct('known', 'current', { last4: '1111' })]);
    const workFile = path.join(dir, 'statement.pdf');
    await writeFile(workFile, 'x');
    const record: ImportRecord = {
      id: 'imp_20260929_120000_abce',
      status: 'review',
      createdAt: stamp,
      updatedAt: stamp,
      origin: 'upload',
      document: { id: 'doc_00000000000000ac', sha256: 'ac'.repeat(32), fileName: 'statement.pdf', mediaType: 'application/pdf', size: 1 },
      extraction: { warnings: [] },
    };
    const section = (key: string, accountId: string, last4: string) => ({ key, detected: { last4 }, target: { mode: 'existing' as const, accountId }, currency: 'GBP', recordBalance: true, balance: -50, balanceDate: '2026-09-02', transactions: [], recordHoldings: false, holdings: [] });
    await commitDraft(store, { record, draft: { documentType: 'credit_card_statement', sections: [section('s0', 'card', '4821'), section('s1', 'known', '9999')], figures: [], notes: [] }, workFile });
    expect(store.account('card')!.last4).toBe('4821');
    // An account that has its number keeps it: you chose where the statement went.
    expect(store.account('known')!.last4).toBe('1111');
  });
});

describe('UK rules', () => {
  it('State Pension age follows the legislated timetable', () => {
    expect(statePensionDate('1958-03-01')).toBe('2024-03-01');
    expect(statePensionDate('1960-04-10')).toBe('2026-05-10');
    expect(statePensionDate('1960-05-05')).toBe('2026-06-05');
    expect(statePensionDate('1961-03-05')).toBe('2028-02-05');
    expect(statePensionDate('1961-03-06')).toBe('2028-03-06');
    expect(statePensionDate('1977-04-06')).toBe('2044-05-06');
    expect(statePensionDate('1978-02-10')).toBe('2046-01-06');
    expect(statePensionDate('1978-04-05')).toBe('2046-03-06');
    expect(statePensionDate('1990-07-15')).toBe('2058-07-15');
  });

  it('2026/27 figures checked against gov.uk', () => {
    const p = taxYearParams(taxYear(2026));
    expect(p.statePensionFullWeekly).toBe(241.3);
    expect(statePensionFullYearly(taxYear(2026))).toBe(12_547.6);
    expect(p.dividendTaxRates).toEqual({ basic: 0.1075, higher: 0.3575, additional: 0.3935 });
    expect(p.hicbc).toEqual({ threshold: 60_000, fullAt: 80_000 });
    expect(p.cgtReportingProceeds).toBe(50_000);
    expect(p.lumpSumAndDeathBenefitAllowance).toBe(1_073_100);
    expect(taxYearParams(taxYear(2027)).savingsTaxRates).toEqual({ basic: 0.22, higher: 0.42, additional: 0.47 });
    expect(taxYearParams(taxYear(2025)).statePensionFullWeekly).toBe(230.25);
    expect(grossUpReliefAtSource(80, taxYear(2026))).toBe(100);
  });
});

describe('ingestion details', () => {
  it('OFX foreign amounts, both directions', () => {
    const ofx = (agg: string, amount: string) =>
      `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>GBP<BANKACCTFROM><ACCTID>12345678</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901<TRNAMT>${amount}<FITID>1<NAME>CAFE PARIS${agg}</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const inForeign = parseOfx(ofx('<CURRENCY><CURRATE>0.85<CURSYM>EUR</CURRENCY>', '-100.00')).accounts[0]!.transactions[0]!;
    expect(inForeign).toMatchObject({ amount: -85, originalAmount: -100, originalCurrency: 'EUR', exchangeRate: 0.85 });
    const converted = parseOfx(ofx('<ORIGCURRENCY><CURRATE>0.85<CURSYM>EUR</ORIGCURRENCY>', '-85.00')).accounts[0]!.transactions[0]!;
    expect(converted).toMatchObject({ amount: -85, originalAmount: -100, originalCurrency: 'EUR' });
  });

  it('a card purchase mentioning "chip" is not a transfer to your Chip account', () => {
    const accounts = [acct('current', 'current'), acct('chip-savings', 'savings', { institutionId: 'chip' })];
    const c = new Categoriser([], new CategoryIndex(defaultCategories()), accounts, [{ id: 'chip', name: 'Chip', kind: 'investment_platform' }]);
    expect(c.categorise({ accountId: 'current', description: 'CHIP AND PIN FISH BAR', amount: -8.5 }).categorisedBy).not.toBe('transfer');
    expect(c.categorise({ accountId: 'current', description: 'TRANSFER TO CHIP SAVINGS', amount: -100 }).categorisedBy).toBe('transfer');
  });
});
