// Filing a company's micro-entity accounts (docs/FORMULAS.md §22, "Filing the accounts"): the size
// tests and the two-year rule (CA 2006 ss382, 384A; SI 2024/1303), the advances a director's loan shows
// (s413), the statements on the balance sheet, the months of a year for the average number employed, the
// filing sheet from the books, and through the app: what the owner confirms, recording the accounts as
// filed (which locks the books) and the book value of the owner's shares. Every name and figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountingPolicies, balanceSheetStatements, directorAdvances, isYear, monthsOfYear, qualification, sizeTest, turnoverLimit, type YearFigures } from '../src/shared/accounts-filing';
import { booksProblems } from '../src/shared/company-books';
import type { CompanyBooksResponse, CompanyFilingResponse, CompanyView, ProposalView } from '../src/shared/api';
import { FILING_DISCLAIMER } from '../src/shared/disclaimers';
import { companySizeRulesFor } from '../src/shared/uk';
import { companyFiling } from '../src/server/analytics/accounts-filing';
import { BalanceEngine, type BalanceSource } from '../src/server/analytics/balances';
import type { LedgerSource } from '../src/server/analytics/ledger';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { balanceId, transactionId } from '../src/server/ids';
import { SettingsSchema, type Account, type BalanceSnapshot, type Company, type Journal, type Transaction } from '../src/shared/schema';

const stamp = '2024-01-01T00:00:00+00:00';
const PARTICULARS = { registeredIn: 'england-and-wales' as const, type: 'private-limited-by-shares' as const, notWoundUp: true as const };
const LIMITS = { turnover: 1_000_000, balanceSheet: 500_000, employees: 10 };

describe('the size of a company', () => {
  it('takes the limits by the first day of the financial year decided (SI 2024/1303 from 6 April 2025)', () => {
    expect(companySizeRulesFor('2025-04-05').micro).toEqual({ turnover: 632_000, balanceSheet: 316_000, employees: 10 });
    expect(companySizeRulesFor('2025-04-05').small).toEqual({ turnover: 10_200_000, balanceSheet: 5_100_000, employees: 50 });
    expect(companySizeRulesFor('2025-04-06').micro).toEqual({ turnover: 1_000_000, balanceSheet: 500_000, employees: 10 });
    expect(companySizeRulesFor('2025-04-06').small).toEqual({ turnover: 15_000_000, balanceSheet: 7_500_000, employees: 50 });
    expect(companySizeRulesFor('2016-01-01').covered).toBe(true);
    expect(companySizeRulesFor('2015-12-31').covered).toBe(false);
  });

  it('pro-rates the turnover limit for a period other than a year, by its days, and a year of 366 days is a year', () => {
    expect(isYear({ start: '2024-01-01', end: '2024-12-31' })).toBe(true);
    expect(turnoverLimit(1_000_000, { start: '2024-01-01', end: '2024-12-31' })).toBe(100_000_000);
    expect(turnoverLimit(1_000_000, { start: '2024-03-15', end: '2025-03-14' })).toBe(100_000_000);
    // 181 of 365 days: £495,890.41.
    expect(turnoverLimit(1_000_000, { start: '2025-01-01', end: '2025-06-30' })).toBe(49_589_041);
    // 13 months from 2 May 2023: 396 days over the 366 of the 12 months beginning then (29 February 2024 in them).
    expect(turnoverLimit(632_000, { start: '2023-05-02', end: '2024-05-31' })).toBe(Math.round((63_200_000 * 396) / 366));
  });

  it('counts a year of 52 or 53 weeks as a year (s390(3)): its turnover limit whole, its statements for the year', () => {
    expect(isYear({ start: '2025-01-01', end: '2025-12-30' })).toBe(true);
    expect(isYear({ start: '2025-01-01', end: '2026-01-06' })).toBe(true);
    expect(isYear({ start: '2025-01-01', end: '2025-12-29' })).toBe(false);
    expect(turnoverLimit(1_000_000, { start: '2025-01-01', end: '2025-12-30' })).toBe(100_000_000);
    expect(turnoverLimit(1_000_000, { start: '2025-01-01', end: '2026-01-06' })).toBe(100_000_000);
    expect(balanceSheetStatements({ start: '2025-01-01', end: '2025-12-30' })[0]!.text).toMatch(/^For the year ending 30 December 2025/);
  });

  it('meets the conditions with two or more requirements within the limits, and says when it cannot tell', () => {
    const y = (t?: number, a?: number, e?: number): YearFigures => ({ start: '2025-01-01', end: '2025-12-31', turnover: t, assets: a, employees: e });
    expect(sizeTest(y(1_200_000_00, 40_000, 2), LIMITS).meets).toBe(true);
    expect(sizeTest(y(1_200_000_00, 600_000, 2), LIMITS).meets).toBe(false);
    // Exactly the limit is within it ("not more than").
    expect(sizeTest(y(100_000_000, 500_000, 11), LIMITS).meets).toBe(true);
    expect(sizeTest(y(undefined, 40_000, 2), LIMITS).meets).toBe(true);
    expect(sizeTest(y(undefined, 600_000, 2), LIMITS).meets).toBeUndefined();
    expect(sizeTest(y(undefined, 600_000, 12), LIMITS).meets).toBe(false);
  });

  /** A year that meets the conditions or not, whichever is asked. */
  const year = (i: number, meets: boolean | undefined): YearFigures => ({ start: `${2016 + i}-01-01`, end: `${2016 + i}-12-31`, ...(meets === undefined ? {} : { turnover: meets ? 1_000 : 200_000_000, assets: meets ? 1_000 : 900_000, employees: 1 }) });

  it('decides the first year by itself, and a change only when it lasts two consecutive years (s384A(1)–(3))', () => {
    const q = (...m: boolean[]) => qualification(m.map((x, i) => year(i, x)), LIMITS, { firstYear: true });
    expect(q(true)).toMatchObject({ qualifies: true, rule: 'first-year' });
    expect(q(false)).toMatchObject({ qualifies: false, rule: 'first-year' });
    expect(q(true, true, false)).toMatchObject({ qualifies: true, rule: 'one-year-only' });
    expect(q(true, false, false)).toMatchObject({ qualifies: false, rule: 'two-years' });
    expect(q(false, true)).toMatchObject({ qualifies: false, rule: 'one-year-only' });
    expect(q(false, true, true)).toMatchObject({ qualifies: true, rule: 'two-years' });
    expect(q(true, false, true, false)).toMatchObject({ qualifies: true });
  });

  it('uses your answer for the year before only while the books cannot work it out, and stops asking once they can', () => {
    // The books know the year before qualified (its first year, within the limits): an answer saying it did not is not used.
    const known = qualification([year(0, true), year(1, false)], LIMITS, { firstYear: true, previousQualified: false });
    expect(known).toMatchObject({ qualifies: true, rule: 'one-year-only', askPrevious: false });
    // Not known: the answer settles it.
    expect(qualification([year(0, undefined), year(1, false)], LIMITS, { firstYear: false, previousQualified: false })).toMatchObject({ qualifies: false, rule: 'told', askPrevious: true });
    // Later the books learn the year before (its employees given, say): they decide, the answer stays unused.
    expect(qualification([year(0, true), year(1, true)], LIMITS, { firstYear: true, previousQualified: false })).toMatchObject({ qualifies: true, rule: 'two-years', askPrevious: false });
  });

  it('as a property: it qualifies as the latest two consecutive years that agree, else as its first year', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 9 }), (m) => {
        let expected = m[0]!;
        for (let k = 1; k < m.length; k++) if (m[k] === m[k - 1]) expected = m[k]!;
        expect(qualification(m.map((x, i) => year(i, x)), LIMITS, { firstYear: true }).qualifies).toBe(expected);
      }),
    );
  });

  it('with the year before not known, takes what you say of it only where it settles the question', () => {
    const q = (m: boolean, previousQualified?: boolean) => qualification([year(0, undefined), year(1, m)], LIMITS, { firstYear: false, previousQualified }).qualifies;
    expect(q(true)).toBeUndefined();
    expect(q(true, true)).toBe(true);
    expect(q(false, false)).toBe(false);
    // Over this year after qualifying: it still qualifies if last year was within, not if it was over too.
    expect(q(false, true)).toBeUndefined();
    expect(q(true, false)).toBeUndefined();
    // Asked for only while it would settle the year.
    expect(qualification([year(0, undefined), year(1, true)], LIMITS, { firstYear: false }).askPrevious).toBe(true);
    expect(qualification([year(0, true), year(1, true)], LIMITS, { firstYear: true }).askPrevious).toBe(false);
    // A year whose test is not known at all cannot be decided.
    expect(qualification([year(0, true), year(1, undefined)], LIMITS, { firstYear: true }).qualifies).toBeUndefined();
  });
});

describe('a director’s advances (s413)', () => {
  it('finds none while the company owes the director: money the director lent is not an advance', () => {
    const a = directorAdvances({ opening: 35_000, movements: [{ date: '2025-03-01', amount: 150_000 }, { date: '2025-08-01', amount: -50_000 }] });
    expect(a).toMatchObject({ any: false, advanced: 0, repaid: 0, lentToCompany: true, opening: 0, closing: 0 });
  });
  it('advances only what the director comes to owe, day by day, and repays what comes off it', () => {
    const a = directorAdvances({
      opening: 100_000,
      movements: [
        { date: '2025-03-15', amount: -250_000 },
        { date: '2025-05-01', amount: 40_000 },
        { date: '2025-05-01', amount: -10_000 },
        { date: '2025-11-30', amount: 200_000 },
      ],
    });
    // From £1,000 owed to the director to £1,500 owed by them: £1,500 advanced; £300 repaid (the day's net), then the rest.
    expect(a).toMatchObject({ any: true, opening: 0, advanced: 150_000, repaid: 150_000, maximum: 150_000, closing: 0, lentToCompany: true });
  });
  it('counts an advance owed at the start, and what is still owed at the end', () => {
    expect(directorAdvances({ opening: -20_000, movements: [{ date: '2025-02-01', amount: -5_000 }] })).toMatchObject({ any: true, opening: 20_000, advanced: 5_000, closing: 25_000, maximum: 25_000, lentToCompany: false });
  });
});

describe('the accounting policies', () => {
  it('says a life that changed in the period from its day, with the life before it', () => {
    const text = accountingPolicies({ lives: [{ class: 'computer', months: 24, from: '2025-07-01', before: 36 }, { class: 'office', months: 60 }], ownLives: false, residual: false, months: 'acquisition', tangible: true, intangible: false, vat: false, accruals: false }).join('\n');
    expect(text).toContain('computer equipment 24 months from 1 July 2025 (36 months before); office equipment 60 months.');
  });
});

describe('an accounts filing’s approval', () => {
  const books = (f: Record<string, unknown>) => ({ incorporatedOn: '2024-01-01', periods: [], ctPeriods: [], filings: [{ id: 'fil_000000000001', kind: 'accounts' as const, periodEnd: '2024-12-31', filedOn: '2025-03-01', addedBy: 'owner' as const, ...f }] });
  it('is given whole, on or after the balance sheet date and not after the filing', () => {
    expect(booksProblems(books({ approvedOn: '2025-02-20', approvedBy: 'Jo Example' }))).toEqual([]);
    expect(booksProblems(books({ approvedOn: '2025-02-20' }))[0]).toMatch(/together/);
    expect(booksProblems(books({ approvedBy: 'Jo Example' }))[0]).toMatch(/together/);
    expect(booksProblems(books({ approvedOn: '2024-12-30', approvedBy: 'Jo Example' }))[0]).toMatch(/before the balance sheet date/);
    expect(booksProblems(books({ approvedOn: '2025-03-02', approvedBy: 'Jo Example' }))[0]).toMatch(/after they were filed/);
  });
});

describe('the statements and the months of a year', () => {
  it('words the statements as Companies House does, "year" for a year and "period" for any other', () => {
    const y = balanceSheetStatements({ start: '2025-01-01', end: '2025-12-31' });
    expect(y.map((s) => s.key)).toEqual(['audit-exemption', 'members', 'responsibilities', 'micro-entity']);
    expect(y[0]!.text).toBe('For the year ending 31 December 2025 the company was entitled to exemption from audit under section 477 of the Companies Act 2006 relating to small companies.');
    expect(y[1]!.text).toBe('The members have not required the company to obtain an audit of its accounts for the year in question in accordance with section 476.');
    expect(y[3]!.text).toBe('The accounts have been prepared in accordance with the micro-entity provisions and have been delivered in accordance with the provisions applicable to companies subject to the small companies regime.');
    expect(balanceSheetStatements({ start: '2023-05-02', end: '2024-05-31' })[0]!.text).toMatch(/^For the period ending 31 May 2024/);
  });
  it('counts the months of a year from its first day (s411(3)–(4))', () => {
    expect(monthsOfYear({ start: '2025-01-01', end: '2025-12-31' })).toHaveLength(12);
    expect(monthsOfYear({ start: '2025-03-15', end: '2026-03-14' })).toHaveLength(12);
    const long = monthsOfYear({ start: '2023-05-02', end: '2024-05-31' });
    expect(long).toHaveLength(13);
    expect(long[0]).toEqual({ start: '2023-05-02', end: '2023-06-01' });
    expect(long.at(-1)).toEqual({ start: '2024-05-02', end: '2024-05-31' });
  });
});

// ─── The sheet from the books ─────────────────────────────────────────────────────────────────────

const CO = 'example-works';
const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
const coded = (ledger: string) => ({ books: { ledger, setBy: 'user' as const } });
const shares = (companyId: string): Journal => ({ id: 'jnl_00000000a001', companyId, date: '2024-01-01', memo: 'Shares issued at incorporation', lines: [{ ledger: 'share-capital-unpaid', amount: 100 }, { ledger: 'share-capital', amount: -100 }], createdBy: 'owner', createdAt: stamp, updatedAt: stamp });
const statement = (accountId: string, date: string, balance: number): BalanceSnapshot => ({ id: balanceId(accountId, date, balance, 'statement'), accountId, date, balance, currency: 'GBP', kind: 'statement', dateSource: 'document', source: {}, createdAt: stamp });
/** Its rows: sales and costs over two years, and the director's loan, in credit, then overdrawn by £1,500. */
const ROWS = (bank: string) => [
  tx(bank, '2024-01-10', 1_000, 'J BLOGGS LOAN', coded('directors-loan')),
  tx(bank, '2024-03-01', 5_000, 'EXAMPLE CLIENT LTD INV 1', coded('turnover')),
  tx(bank, '2024-06-01', -300, 'EXAMPLE HOSTING LTD', coded('software-hosting')),
  tx(bank, '2025-02-01', 6_000, 'EXAMPLE CLIENT LTD INV 2', coded('turnover')),
  tx(bank, '2025-03-15', -2_500, 'J BLOGGS ADVANCE', coded('directors-loan')),
  tx(bank, '2025-09-01', -200, 'EXAMPLE HOSTING LTD', coded('software-hosting')),
];

describe('the filing sheet', () => {
  const ACCOUNTS: Account[] = [acct('works-bank', 'Works Account', 'current', { companyId: CO, includeInNetWorth: false })];
  function source(company: Company, rows: Transaction[]): LedgerSource {
    return {
      balances: () => [],
      transactions: (accountId?: string) => (accountId ? rows.filter((t) => t.accountId === accountId) : []),
      transaction: (id) => rows.find((t) => t.id === id),
      account: (id) => ACCOUNTS.find((a) => a.id === id),
      company: (id) => (id === CO ? company : undefined),
      companyAccounts: (id) => ACCOUNTS.filter((a) => a.companyId === id),
      companyTransactions: (id) => (id === CO ? rows : []),
      companyJournals: (id) => (id === CO ? [shares(CO)] : []),
      bookRules: () => [],
    };
  }
  const engine = (rows: Transaction[], snapshots: BalanceSnapshot[]) => {
    const src: BalanceSource = { accounts: ACCOUNTS, settings: SettingsSchema.parse({}), transactions: (id?: string) => rows.filter((t) => !id || t.accountId === id), balances: (id?: string) => snapshots.filter((b) => !id || b.accountId === id) };
    return new BalanceEngine(src);
  };
  const company = (books: Partial<NonNullable<Company['books']>> = {}, extra: Partial<Company> = {}): Company => ({
    id: CO,
    name: 'Example Works Ltd',
    number: '01234567',
    holdings: [{ shareClass: 'Ordinary', shares: 25, totalShares: 100, source: {} }],
    valuations: [],
    accountId: 'works-shares',
    createdBy: 'owner',
    createdAt: stamp,
    updatedAt: stamp,
    books: { incorporatedOn: '2024-01-01', accountingReferenceDate: '12-31', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp, ...books },
    ...extra,
  });
  const sheetOf = (c: Company, rows = ROWS('works-bank'), snapshots = [statement('works-bank', '2024-12-31', 5_700), statement('works-bank', '2025-12-31', 9_000)]) => companyFiling({ src: source(c, rows), company: c, engine: engine(rows, snapshots), today: '2026-03-01', period: '2025-12-31' })!;

  it('gives the balance sheet in the form’s order, B and C from their sub-lines, the totals worked out, capital and reserves adding up to K', () => {
    const v = sheetOf(company());
    expect(v.sheet.map((l) => l.key)).toEqual(['A', 'B:Intangible assets', 'B:Tangible assets', 'B:Investments (fixed assets)', 'B', 'C:Stocks', 'C:Debtors', 'C:Investments (current assets)', 'C:Cash at bank and in hand', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
    const w = (k: string) => v.sheet.find((l) => l.key === k)!.whole;
    // The director owes £1,500 (a debtor), the bank holds £9,000.
    expect([w('A'), w('C:Debtors'), w('C:Cash at bank and in hand'), w('C'), w('K')]).toEqual([100, 1_500, 9_000, 10_500, 10_600]);
    expect(w('F')).toBe(w('C') + w('D') - w('E'));
    expect(w('K')).toBe(w('G') - w('H') - w('I') - w('J'));
    expect(v.capital.map((l) => l.label)).toEqual(['Called up share capital', 'Share premium account', 'Revaluation reserve', 'Other reserves', 'Profit and loss account', 'Shareholders’ funds']);
    expect(v.capital.slice(0, -1).reduce((s, l) => s + l.whole, 0)).toBe(w('K'));
    expect(v.capital.at(-1)!.whole).toBe(w('K'));
    // The period before, worked out from the books, sub-lines too.
    expect(v.comparative).toMatchObject({ end: '2024-12-31', sheet: 'computed' });
    expect(v.sheet.find((l) => l.key === 'C:Cash at bank and in hand')!.prior).toBe(5_700);
    expect(v.sheet.find((l) => l.key === 'K')!.prior).toBe(4_800);
    expect(v.lines).toMatchObject({ A: 100, B: 0, C: 10_500, K: 10_600 });
    // Each line traced to its codes.
    expect(v.sheet.find((l) => l.key === 'C:Debtors')!.trace).toEqual([expect.objectContaining({ ledger: 'directors-loan', amount: 150_000 })]);
  });

  it('shows the advance the director’s loan made, and asks for its interest and conditions before it is ready', () => {
    const v = sheetOf(company({ employees: [{ periodEnd: '2024-12-31', average: 1 }, { periodEnd: '2025-12-31', average: 1 }], accountsNotes: [{ periodEnd: '2025-12-31', offBalanceSheet: { none: true }, commitments: { none: true }, directors: { none: true }, notExcluded: true, particulars: PARTICULARS }] }));
    expect(v.notes.advances).toMatchObject({ any: true, opening: 0, advanced: 150_000, closing: 150_000, given: null });
    expect(v.gate.filter((g) => !g.ok).map((g) => g.key)).toEqual(['notes']);
    const done = sheetOf(company({ employees: [{ periodEnd: '2024-12-31', average: 1 }, { periodEnd: '2025-12-31', average: 1 }], accountsNotes: [{ periodEnd: '2025-12-31', offBalanceSheet: { none: true }, commitments: { none: true }, directors: { none: true }, advances: { interest: 'none', conditions: 'unsecured, repayable on demand' }, notExcluded: true, particulars: PARTICULARS }] }));
    expect(done.ready).toBe(true);
    expect(done.eligibility.micro).toMatchObject({ qualifies: true, rule: 'two-years' });
    expect(done.eligibility.small.qualifies).toBe(true);
  });

  it('is not ready without the employees, the notes and your confirmation that no exclusion applies, and never says it qualifies without them', () => {
    const v = sheetOf(company());
    expect(v.ready).toBe(false);
    expect(v.gate.filter((g) => !g.ok).map((g) => g.key)).toEqual(['employees', 'notes', 'particulars', 'eligibility']);
    // Without its number, the accounts cannot name it as Companies House asks.
    expect(sheetOf(company({}, { number: undefined })).gate.find((g) => g.key === 'number')!.ok).toBe(false);
    // Turnover and assets within the limits decide each year without the employees.
    expect(v.eligibility.micro.qualifies).toBe(true);
    expect(v.notes.employees.average).toBeNull();
  });

  it('lists the exclusions an owner confirms, the group and special register bodies among them (ss478(c), 479(1))', () => {
    const keys = sheetOf(company()).eligibility.exclusions.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['public', 'parent', 'special-register', 'group-audit', 'audit']));
    expect(sheetOf(company()).eligibility.exclusions.find((x) => x.key === 'group-audit')!.source).toBe('CA 2006 s479(1)');
  });

  it('gives the period before’s employees and commitments beside this period’s (FRS 105 paras 3.7, 3.10)', () => {
    const v = sheetOf(company({ employees: [{ periodEnd: '2024-12-31', average: 2 }, { periodEnd: '2025-12-31', average: 1 }], accountsNotes: [{ periodEnd: '2024-12-31', commitments: { text: 'A van on hire purchase.', amount: 4_800 } }] }));
    expect(v.notes.employees).toMatchObject({ average: 1, prior: 2 });
    expect(v.notes.commitmentsPrior).toEqual({ text: 'A van on hire purchase.', amount: 4_800 });
    // The years before, whose employees the size test reads, offered to give.
    expect(v.eligibility.earlier).toEqual([{ start: '2024-01-01', end: '2024-12-31', employees: 2 }]);
  });

  it('describes a depreciation life that changed in the period, with the life before', () => {
    const rows = [...ROWS('works-bank'), tx('works-bank', '2024-05-01', -1_200, 'EXAMPLE COMPUTERS LTD', { books: { ledger: 'fixed-assets:computer:cost', asset: { class: 'computer' }, setBy: 'user' } })];
    const v = sheetOf(company({ policies: [{ class: 'computer', months: 36 }, { class: 'computer', months: 24, effectiveFrom: '2025-07-01' }] }), rows);
    expect(v.policies.join(' ')).toContain('computer equipment 24 months from 1 July 2025 (36 months before)');
  });

  it('values one class of share only, and says what a book value leaves out', () => {
    expect(sheetOf(company({}, { holdings: [{ shareClass: 'A ordinary', shares: 25, totalShares: 100, source: {} }, { shareClass: 'B ordinary', shares: 5, totalShares: 100, source: {} }] })).bookValue.why).toMatch(/more than one class/);
    const v = sheetOf(company());
    expect(v.bookValue.shareClass).toBe('Ordinary');
    // Line A: £100 of share capital not paid, owed by the shareholders.
    expect(v.bookValue.caveats).toEqual([expect.stringMatching(/share capital not paid \(£100, line A\)/)]);
    // Net liabilities while it owes you £1,000 on the loan: the estate may overstate by up to £1,000.
    const rows = [...ROWS('works-bank').filter((t) => t.description !== 'J BLOGGS ADVANCE'), tx('works-bank', '2025-10-01', -20_000, 'EXAMPLE LAWYERS LLP', coded('professional-fees'))];
    const loss = sheetOf(company(), rows, [statement('works-bank', '2024-12-31', 5_700), statement('works-bank', '2025-12-31', -8_500)]);
    expect(loss.bookValue).toMatchObject({ value: 0 });
    expect(loss.bookValue.netAssets).toBeLessThan(0);
    expect(loss.bookValue.caveats[0]).toMatch(/overstate by up to £1,000\.00/);
  });

  it('offers the book value of your shares, never below nothing', () => {
    expect(sheetOf(company()).bookValue).toMatchObject({ netAssets: 10_600, shares: 25, totalShares: 100, value: 2_650 });
    // A loss that leaves net liabilities: nothing.
    const rows = [...ROWS('works-bank'), tx('works-bank', '2025-10-01', -20_000, 'EXAMPLE LAWYERS LLP', coded('professional-fees'))];
    const v = sheetOf(company(), rows, [statement('works-bank', '2024-12-31', 5_700), statement('works-bank', '2025-12-31', -11_000)]);
    expect(v.bookValue.netAssets).toBe(-9_400);
    expect(v.bookValue.value).toBe(0);
    // Without the shares it issued, or an account for yours, it is not offered.
    expect(sheetOf(company({}, { holdings: [{ shareClass: 'Ordinary', shares: 25, source: {} }] })).bookValue.why).toMatch(/shares it has issued/);
    expect(sheetOf(company({}, { accountId: undefined })).bookValue.why).toMatch(/no account/);
  });
});

// ─── Through the app ──────────────────────────────────────────────────────────────────────────────

describe('filing the accounts through the app', () => {
  const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
  let app: App;
  let dir: string;
  let agent: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-filing-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
    const store = app.ctx.store;
    await store.setAccounts([acct('works-shares', 'Example Works Ltd shares', 'other_asset')]);
    await store.setCompanies([
      { id: CO, name: 'Example Works Ltd', number: '01234567', holdings: [{ shareClass: 'Ordinary', shares: 25, totalShares: 100, source: {} }], valuations: [], accountId: 'works-shares', createdBy: 'owner', createdAt: stamp, updatedAt: stamp, books: { incorporatedOn: '2024-01-01', accountingReferenceDate: '12-31', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp } },
    ]);
    await store.upsertAccount(acct('works-bank', 'Works Account', 'current', { companyId: CO, includeInNetWorth: false }));
    await store.addTransactions(ROWS('works-bank'), 'test: rows');
    await store.putJournal(shares(CO), 'test: shares');
    await store.addBalances([statement('works-bank', '2024-12-31', 5_700), statement('works-bank', '2025-12-31', 9_000)], 'test: statements');
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records', 'imports', 'jobs'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const sheet = async () => (await (await req(`/api/companies/${CO}/filing?period=2025-12-31`)).json()) as CompanyFilingResponse;
  const send = async (method: string, p: string, body: unknown, auth?: string) => {
    const r = await req(p, { method, headers: { ...CSRF, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const NOTES = { offBalanceSheet: { none: true }, commitments: { text: 'A lease of the workshop to 2028.', amount: 14_400 }, directors: { none: true }, advances: { interest: 'none', conditions: 'unsecured, repayable on demand' }, notExcluded: true, particulars: PARTICULARS };

  it('takes what the owner confirms, refuses an agent, and keeps it when the books are set up again', async () => {
    expect((await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2025-12-31', employees: 1 }, agent)).status).toBe(403);
    expect((await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2025-06-30', employees: 1 })).status).toBe(422);
    expect((await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2025-12-31', employees: 1.5, notes: NOTES })).status).toBe(200);
    expect((await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2024-12-31', employees: 1 })).status).toBe(200);
    const v = await sheet();
    expect(v.notes.employees.average).toBe(1.5);
    expect(v.notes.commitments).toEqual({ text: 'A lease of the workshop to 2028.', amount: 14_400 });
    expect(v.ready).toBe(true);
    // The books set up again by the owner keep it.
    const books = (await (await req(`/api/companies/${CO}/books`)).json()) as CompanyBooksResponse;
    const { filings: _f, setBy: _s, updatedAt, employees: _e, accountsNotes: _n, ...setup } = books.books!;
    expect((await send('PUT', `/api/companies/${CO}/books`, { books: { ...setup, policies: [{ class: 'computer', months: 36 }] }, was: updatedAt })).status).toBe(200);
    expect((await sheet()).notes.employees.average).toBe(1.5);
    // null takes the employees away.
    expect((await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2025-12-31', employees: null })).status).toBe(200);
    expect((await sheet()).notes.employees.average).toBeNull();
  });

  it('exports the figures as CSV and JSON, each ending with the disclaimer', async () => {
    const csv = await (await req(`/api/companies/${CO}/filing?period=2025-12-31&format=csv`)).text();
    expect(csv.split('\n')[0]).toBe('line,item,this period (£),period to 2024-12-31 (£)');
    expect(csv).toContain('K,Total net assets (liabilities),10600,4800');
    expect(csv.trim().split('\n').at(-1)).toContain(FILING_DISCLAIMER.slice(0, 60));
    const json = (await (await req(`/api/companies/${CO}/filing?period=2025-12-31&format=json`)).json()) as { disclaimer: string; lines: Record<string, number> };
    expect(json.disclaimer).toBe(FILING_DISCLAIMER);
    expect(json.lines.K).toBe(10_600);
    // The notes in pounds and pence, as labelled: the £1,500 advance, not 150000 pence.
    const notes = (json as unknown as { currency: string; notes: { advances: Record<string, unknown> } });
    expect(notes.currency).toMatch(/notes in pounds and pence/);
    expect(notes.notes.advances).toMatchObject({ owedAtStart: 0, advanced: 1_500, repaid: 0, owedAtEnd: 1_500, mostOwed: 1_500, any: true });
  });

  it('records the accounts as filed only when ready and as the books give them, locking the books; never twice', async () => {
    const filed = (body: Record<string, unknown>, auth?: string) => send('POST', `/api/companies/${CO}/accounts/filed`, { periodEnd: '2025-12-31', filedOn: '2026-02-20', approvedOn: '2026-02-18', approvedBy: 'Jo Example', registeredOffice: '1 Example Street, Exampleton, CR2 6XH', lines: { A: 100, B: 0, C: 10_500, D: 0, E: 0, F: 10_500, G: 10_600, H: 0, I: 0, J: 0, K: 10_600 }, ...body }, auth);
    expect((await filed({}, agent)).status).toBe(403);
    // Not ready: no employees or notes yet.
    expect((await filed({})).status).toBe(422);
    await send('PUT', `/api/companies/${CO}/accounts-notes`, { periodEnd: '2025-12-31', employees: 1, notes: NOTES });
    // Lines other than the books give, an approval before the balance sheet date or after filing.
    expect((await filed({ lines: { A: 100, B: 0, C: 10_501, D: 0, E: 0, F: 10_501, G: 10_601, H: 0, I: 0, J: 0, K: 10_601 } })).status).toBe(409);
    expect((await filed({ approvedOn: '2025-12-30' })).status).toBe(422);
    expect((await filed({ approvedOn: '2026-02-21' })).status).toBe(422);
    // The registered office is stated on the accounts, so it is asked for.
    expect((await filed({ registeredOffice: undefined })).status).toBe(400);
    const ok = await filed({ reference: 'EX12345' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'accounts', periodStart: '2025-01-01', periodEnd: '2025-12-31', approvedOn: '2026-02-18', approvedBy: 'Jo Example', registeredOffice: '1 Example Street, Exampleton, CR2 6XH', figures: { C: 10_500, K: 10_600 } });
    expect((await filed({})).status).toBe(409);
    const books = (await (await req(`/api/companies/${CO}/books`)).json()) as CompanyBooksResponse;
    expect(books.books!.lockedThrough).toBe('2025-12-31');
    const v = await sheet();
    expect(v.filing).toMatchObject({ filedOn: '2026-02-20', reference: 'EX12345', approvedBy: 'Jo Example', matches: true });
    expect(v.ready).toBe(false);
  });

  it('checks an accounts filing’s approval however it is recorded: by hand, or by an agent’s proposal', async () => {
    const base = { kind: 'accounts', periodStart: '2024-01-01', periodEnd: '2024-12-31', filedOn: '2025-03-01' };
    expect((await send('POST', `/api/companies/${CO}/filings`, { ...base, approvedOn: '2025-02-20' })).status).toBe(422);
    expect((await send('POST', `/api/companies/${CO}/filings`, { ...base, approvedOn: '2024-12-01', approvedBy: 'Jo Example' })).status).toBe(422);
    expect((await send('POST', `/api/companies/${CO}/filings`, { ...base, approvedOn: '2025-03-02', approvedBy: 'Jo Example' })).status).toBe(422);
    const r = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ title: 'Accounts filed', summary: 'Its filing history.', changes: [{ kind: 'add_filing', why: 'Its filing history lists them.', company: CO, filing: { ...base, approvedOn: '2025-04-01', approvedBy: 'Jo Example' } }] }) });
    const proposal = (await r.json()) as ProposalView & { problems?: { problem: string }[] };
    expect(proposal.problems?.[0]?.problem).toMatch(/after they were filed/);
    expect((await send('POST', `/api/companies/${CO}/filings`, { ...base, approvedOn: '2025-02-20', approvedBy: 'Jo Example' })).status).toBe(201);
  });

  it('takes away only a balance it added when the valuation is not kept: never one another request wrote meanwhile', async () => {
    const store = app.ctx.store;
    const add = store.addBalances.bind(store);
    const value = () => store.balances('works-shares').filter((b) => b.date === '2025-12-31').length;
    // Another request writes the same balance just before this one: this one adds nothing, and keeps it when it fails.
    const adds = vi.spyOn(store, 'addBalances').mockImplementationOnce(async (snaps, message) => {
      await add(snaps, message);
      return add(snaps, message);
    });
    const updates = vi.spyOn(store, 'updateCompany').mockImplementationOnce(() => Promise.reject(new Error('the company changed meanwhile')));
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31', oneClass: true })).status).toBe(500);
    expect(value()).toBe(1);
    // Alone, the balance it added is taken away again.
    await store.deleteBalance(store.balances('works-shares').find((b) => b.date === '2025-12-31')!.id, 'test: reset');
    updates.mockImplementationOnce(() => Promise.reject(new Error('the company changed meanwhile')));
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31', oneClass: true })).status).toBe(500);
    expect(value()).toBe(0);
    adds.mockRestore();
    updates.mockRestore();
  });

  it('records the book value of your shares only when asked, once', async () => {
    // Without confirming its shares are of your one class, refused.
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31' })).status).toBe(400);
    const before = (await (await req('/api/companies')).json()) as CompanyView[];
    expect(before[0]!.valuation).toBeUndefined();
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31', oneClass: true }, agent)).status).toBe(403);
    // A period not ended: the figure could still change.
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2026-12-31', oneClass: true })).status).toBe(422);
    // Its accounts ready is enough: the notes do not move net assets.
    const r = await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31', oneClass: true });
    expect(r).toMatchObject({ status: 201, body: { value: 2_650 } });
    const after = (await (await req('/api/companies')).json()) as CompanyView[];
    expect(after[0]!.valuation).toMatchObject({ asOf: '2025-12-31', method: 'net-assets', netAssets: 10_600, value: 2_650 });
    expect(after[0]!.value).toMatchObject({ amount: 2_650, date: '2025-12-31' });
    expect((await send('POST', `/api/companies/${CO}/accounts/book-value`, { periodEnd: '2025-12-31', oneClass: true })).status).toBe(409);
    expect((await sheet()).bookValue.recorded).toEqual({ value: 2_650, netAssets: 10_600 });
  });
});
