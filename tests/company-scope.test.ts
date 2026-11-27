// Company accounts never touch a personal figure (docs/ARCHITECTURE.md, "Company accounts").
//
// The metamorphic property: for a personal store S and a company's own data C (its accounts, rows,
// balances, figures, imports, terms and confirmations, its books with their filings, and its general
// ledger: codings, book rules, journals and links to S's rows), every GET route of the API answers the
// same for S and for S ∪ C. C is drawn from the same pools as S — pay, dividends, interest, HMRC, child
// benefit, your own name, your accounts' names and numbers, amounts and days that would pair as
// transfers with S's rows, the same banks — so a filter missed anywhere changes a figure. The routes
// are read from the app's own router: a new route is covered without being listed here.
//
// One thing of yours changes by design (DECISIONS 2026-11-26, "The ledger is the director's loan's
// source once books are kept"): once the company keeps its books here, your director's loan moves by
// its books' postings to the loan, so what only the books know (a journal on the loan, a company row
// coded to it) and the company's own day for money linked to yours move it. That is encoded exactly,
// not allowed broadly: while the books say what your marks say, nothing at all differs, the loan
// included; with what only the books know, every account but the loan is the same on every day, the
// loan differs by exactly what the books add (worked out here from C), and the estate by exactly the
// loan's difference; and with the loan taken away from the company, nothing at all differs again.
//
// A canary turns the store's scope off (a test-only hook) and checks that the property then fails:
// the test can catch a leak. Every name and figure is invented.

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { balanceId, figureId, filingId, termsId, transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { addDays, addMonths, addYears, eachDay, endOfMonth, startOfMonth, today } from '../src/shared/dates';
import { vatInGross } from '../src/shared/ledger';
import { toMinor } from '../src/shared/money';
import { taxYearOf } from '../src/shared/uk';
import { estateOn } from '../src/server/analytics/estate';
import type { AccountDetailResponse, CompanyBooksResponse } from '../src/shared/api';
import type { Account, BalanceSnapshot, CategorisedBy, Figure, ImportRecord, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const TODAY = today();
const MONTHS = 14;
const FIRST = startOfMonth(addMonths(TODAY, -(MONTHS - 1)));
const COMPANY = 'example-studio';
const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };

// ─── The data ──────────────────────────────────────────────────────────────────────────────────────

const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });

/**
 * Yours: a current account, a saver and a card at the same banks as the company's, an ISA, a pension,
 * the shares the company's value is carried on, and your director's loan with it, moved by the rows of
 * yours marked as paid for it or lent to it (so the company's data must change none of that either).
 */
const PERSONAL: Account[] = [
  acct('current', 'Everyday', 'current', { institutionId: 'example-bank', last4: '1111', aliases: ['Everyday Account'] }),
  acct('saver', 'Rainy Day', 'savings', { institutionId: 'example-bank', last4: '2222' }),
  acct('card', 'Example Card', 'credit_card', { institutionId: 'example-cards', last4: '3333' }),
  acct('isa', 'Stocks ISA', 'stocks_isa', { institutionId: 'example-invest' }),
  acct('pension', 'Example SIPP', 'sipp', { institutionId: 'example-pensions' }),
  acct('shares', 'Example Studio Ltd shares', 'other_asset'),
  acct('studio-loan', 'Director’s loan', 'director_loan'),
];
/** The company's own: its current account at your bank and its card at your card's issuer, named like yours. */
const COMPANY_ACCOUNTS: Account[] = [
  acct('studio-current', 'Studio Account', 'current', { institutionId: 'example-bank', last4: '4444', aliases: ['Studio Account'], companyId: COMPANY, includeInNetWorth: false }),
  acct('studio-card', 'Studio Card', 'credit_card', { institutionId: 'example-cards', last4: '5555', companyId: COMPANY, includeInNetWorth: false }),
];

/** Words both sides' rows are drawn from: each has a figure of yours that would change if a company row counted. */
const POOL: { description: string; sign: 1 | -1; category?: string; company?: 'paid-for' | 'loan' | 'pay' | 'dividend' }[] = [
  { description: 'EXAMPLE STUDIO LTD SALARY ES12345', sign: 1, category: 'salary', company: 'pay' },
  { description: 'EXAMPLE STUDIO LTD SALARY', sign: 1 },
  { description: 'EXAMPLE STUDIO LTD DIVIDEND', sign: 1, category: 'dividends', company: 'dividend' },
  { description: 'EXAMPLE STUDIO LTD REPAYMENT', sign: 1, category: 'salary', company: 'loan' },
  { description: 'GROSS INTEREST', sign: 1, category: 'interest' },
  { description: 'HMRC SELF ASSESSMENT', sign: -1, category: 'tax' },
  { description: 'HMRC CORPORATION TAX', sign: -1 },
  { description: 'HMRC REPAYMENT', sign: 1, category: 'tax-refund' },
  { description: 'CHILD BENEFIT', sign: 1, category: 'benefits' },
  { description: 'TESCO STORES 3297', sign: -1, category: 'groceries' },
  { description: 'EXAMPLE HOSTING LTD', sign: -1, category: 'software', company: 'paid-for' },
  { description: 'GIFT AID DONATION EXAMPLE CHARITY', sign: -1, category: 'charity' },
  { description: 'EXAMPLE CLIENT INVOICE', sign: 1, category: 'side-income' },
  { description: 'TO JO BLOGGS', sign: -1, category: 'transfers' },
  { description: 'FROM JO BLOGGS', sign: 1 },
  { description: 'TRANSFER TO EVERYDAY ACCOUNT 12341111', sign: -1 },
  { description: 'TRANSFER TO STUDIO ACCOUNT 12344444', sign: -1, company: 'loan' },
  { description: 'PAYMENT TO EXAMPLE CARDS', sign: -1, category: 'credit-card-payment' },
  { description: 'PAYMENT RECEIVED THANK YOU', sign: 1 },
  { description: 'CASH WITHDRAWAL EXAMPLE BANK', sign: -1, category: 'cash-withdrawal' },
  { description: 'EXAMPLE CAFE', sign: -1, category: 'coffee' },
];
const BY: (CategorisedBy | undefined)[] = [undefined, 'user', 'rule', 'builtin', 'bank', 'ai'];

interface RowDraw {
  pool: number;
  account: number;
  day: number;
  pence: number;
  by: number;
}
/** A company row that mirrors one of yours: the opposite amount within 3 days, its words saying it is a transfer. */
interface MirrorDraw {
  of: number;
  days: number;
  words: number;
}
interface World {
  personal: RowDraw[];
  company: RowDraw[];
  mirrors: MirrorDraw[];
  balances: number[];
}

const rowDraw = fc.record({ pool: fc.nat(POOL.length - 1), account: fc.nat(10), day: fc.nat(MONTHS * 30 - 1), pence: fc.integer({ min: 100, max: 400_000 }), by: fc.nat(BY.length - 1) });
const world: fc.Arbitrary<World> = fc.record({
  personal: fc.array(rowDraw, { minLength: 30, maxLength: 70 }),
  company: fc.array(rowDraw, { minLength: 10, maxLength: 40 }),
  mirrors: fc.array(fc.record({ of: fc.nat(1000), days: fc.integer({ min: -3, max: 3 }), words: fc.nat(3) }), { minLength: 3, maxLength: 12 }),
  balances: fc.array(fc.integer({ min: -200_000, max: 2_000_000 }), { minLength: 8, maxLength: 8 }),
});

const MIRROR_WORDS = ['TRANSFER FROM EVERYDAY ACCOUNT 12341111', 'FROM JO BLOGGS', 'TO JO BLOGGS', 'PAYMENT TO EXAMPLE CARDS'];
const dayOf = (n: number) => {
  const d = addDays(FIRST, n);
  return d > TODAY ? TODAY : d;
};

function rows(draws: readonly RowDraw[], accounts: readonly Account[], kept: (a: Account) => boolean): Transaction[] {
  const usable = accounts.filter(kept);
  const occ = new Map<string, number>();
  return draws.map((d) => {
    const p = POOL[d.pool]!;
    const account = usable[d.account % usable.length]!;
    const date = dayOf(d.day);
    const amount = (p.sign * d.pence) / 100;
    const key = `${account.id}|${date}|${amount}|${p.description}`;
    const n = occ.get(key) ?? 0;
    occ.set(key, n + 1);
    const by = p.category ? BY[d.by] : undefined;
    // Your rows with the company are marked as what they were (never a company's own row), and half of
    // those paid for it are coded in its books by you (the rest by the book rule for them, below).
    const mark = p.company && !account.companyId ? { company: { id: COMPANY, as: p.company, setBy: 'user' as const } } : {};
    const coding = p.company === 'paid-for' && !account.companyId && d.by % 2 === 0 ? { books: { ledger: 'software-hosting', vat: { amount: vatInGross(amount, date, 'standard'), treatment: 'standard' as const }, setBy: 'user' as const } } : {};
    return { id: transactionId(account.id, date, amount, p.description, n), accountId: account.id, date, amount, currency: 'GBP', description: p.description, source: {}, createdAt: stamp, ...(p.category && by !== undefined ? { category: p.category, categorisedBy: by } : {}), ...mark, ...coding };
  });
}

/** A committed statement of an account for a month: what coverage is worked out from. */
function statement(accountId: string, month: string, n: number): ImportRecord {
  const id = `imp_${month.replace('-', '')}01_000000_${n.toString(16).padStart(4, '0')}`;
  return {
    id,
    status: 'committed',
    createdAt: stamp,
    updatedAt: stamp,
    committedAt: stamp,
    origin: 'upload',
    document: { id: `doc_${n.toString(16).padStart(16, '0')}`, sha256: n.toString(16).padStart(64, '0'), fileName: `${accountId}-${month}.csv`, mediaType: 'text/csv', size: 1 },
    extraction: { warnings: [] },
    draft: { documentType: 'csv_export', sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId }, currency: 'GBP', periodStart: `${month}-01`, periodEnd: endOfMonth(`${month}-01`), recordBalance: false, transactions: [], recordHoldings: false, holdings: [] }], figures: [], notes: [] },
    result: { accountIds: [accountId], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 0 },
  };
}

const balance = (accountId: string, date: string, value: number): BalanceSnapshot => ({ id: balanceId(accountId, date, value, 'statement'), accountId, date, balance: value, currency: 'GBP', kind: 'statement', dateSource: 'document', source: {}, createdAt: stamp });

const MONTH_LIST = Array.from({ length: MONTHS }, (_, i) => addMonths(FIRST, i).slice(0, 7));

const INCORPORATED = addMonths(FIRST, -20);
/**
 * The company's books as kept here: its dates and registrations, in S as in S ∪ C, so whatever keeping
 * books changes of yours (book rules for the rows you paid for it, your loan read from its books) is the
 * same on both sides; C adds its filings, its rows, journals and book rules for its own rows. (Your loan
 * from its books against your marks alone is tests/ledger.test.ts's property.)
 */
const BOOKS = {
  incorporatedOn: INCORPORATED,
  accountingReferenceDate: '01-31',
  periods: [],
  ctPeriods: [],
  tradeStartedOn: addDays(INCORPORATED, 30),
  vat: { registeredFrom: FIRST, scheme: 'cash' as const, schedule: [{ from: FIRST, stagger: 'quarterly-1' as const }] },
  paye: { from: addDays(INCORPORATED, 40) },
  deadlinesFrom: addDays(INCORPORATED, 1),
};

/** Your data alone: S. */
async function writePersonal(dir: string, w: World, extra: { date: string; amount: number; description: string }[] = []): Promise<{ txIds: string[] }> {
  const store = await Store.open(dir);
  await store.setProfile({ ...store.profile, name: 'Jo Bloggs', dateOfBirth: '1990-05-14' });
  for (const inst of [
    { id: 'example-bank', name: 'Example Bank', kind: 'bank' as const },
    { id: 'example-cards', name: 'Example Cards', kind: 'card_issuer' as const },
    { id: 'example-invest', name: 'Example Invest', kind: 'investment_platform' as const },
    { id: 'example-pensions', name: 'Example Pensions', kind: 'pension_provider' as const },
  ])
    await store.upsertInstitution(inst);
  await store.setAccounts(PERSONAL);
  await store.setEmployments([{ id: 'studio-job', employer: 'EXAMPLE STUDIO LTD', aliases: [], payrollNumbers: ['ES12345'], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
  await store.setCompanies([{ id: COMPANY, name: 'EXAMPLE STUDIO LTD', number: '12345678', holdings: [{ shareClass: 'Ordinary', shares: 100, totalShares: 100, acquiredOn: '2024-05-14', source: {} }], valuations: [], accountId: 'shares', directorLoanAccountId: 'studio-loan', employmentId: 'studio-job', books: { ...BOOKS, filings: [], setBy: 'owner', updatedAt: stamp }, createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
  await store.setRules([{ id: 'rule_hosting', name: 'Hosting', enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE HOSTING', caseSensitive: false }, set: { category: 'software' }, createdAt: stamp, updatedAt: stamp }]);
  // A book rule for the rows of yours paid for the company: about your rows, so it is yours, in S.
  await store.setBookRules(COMPANY, [{ id: 'rule_paidhosting', name: 'Hosting you paid', enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE HOSTING', caseSensitive: false, company: { id: COMPANY, rows: 'paid-for' } }, set: { books: { ledger: 'software-hosting', vat: { treatment: 'standard' } } }, createdAt: stamp, updatedAt: stamp }]);
  await store.setGoals([{ id: 'rainy-day', name: 'Rainy day', kind: 'savings', targetAmount: 10_000, accountIds: ['saver'], createdAt: stamp, updatedAt: stamp }]);
  const txs = [...rows(w.personal, PERSONAL, (a) => ['current', 'saver', 'card'].includes(a.id)), ...extra.map((x, i) => ({ id: transactionId('current', x.date, x.amount, x.description, 900 + i), accountId: 'current', currency: 'GBP', source: {}, createdAt: stamp, ...x }))];
  await store.addTransactions(txs, 'test: your rows');
  const ledger = ['current', 'saver', 'card'];
  await store.addBalances(
    ledger.flatMap((id, i) => [balance(id, endOfMonth(`${MONTH_LIST[2]}-01`), w.balances[i]! / 100), balance(id, endOfMonth(`${MONTH_LIST[MONTHS - 2]}-01`), w.balances[i + 3]! / 100)]),
    'test: your balances',
  );
  await store.addBalances([balance('isa', endOfMonth(`${MONTH_LIST[6]}-01`), 18_250), balance('pension', endOfMonth(`${MONTH_LIST[6]}-01`), 42_100), balance('shares', endOfMonth(`${MONTH_LIST[3]}-01`), 25_000), balance('studio-loan', endOfMonth(`${MONTH_LIST[5]}-01`), 1_250)], 'test: valuations');
  const ty = taxYearOf(TODAY);
  await store.addFigures(
    [
      { id: figureId('interest_paid', 182.4, ty.label, 'Example Bank', 'Interest'), kind: 'interest_paid', label: 'Interest', amount: 182.4, currency: 'GBP', taxYear: ty.label, accountId: 'saver', payer: 'Example Bank', source: {}, createdAt: stamp },
      { id: figureId('dividends_paid', 2400, ty.label, 'EXAMPLE STUDIO LTD', 'Dividend'), kind: 'dividends_paid', label: 'Dividend', amount: 2400, currency: 'GBP', taxYear: ty.label, periodEnd: TODAY, payer: 'EXAMPLE STUDIO LTD', source: {}, createdAt: stamp },
    ] as Figure[],
    'test: your figures',
  );
  let n = 1;
  for (const month of MONTH_LIST) for (const id of ['current', 'card']) await store.saveImport(statement(id, month, n++), 'test: statement');
  store.stopWatching();
  return { txIds: txs.map((t) => t.id) };
}

/** The company's own data on top: S ∪ C. */
async function writeCompany(dir: string, w: World, personalTx: readonly Transaction[]): Promise<void> {
  const store = await Store.open(dir);
  for (const a of COMPANY_ACCOUNTS) await store.upsertAccount(a);
  // Its rows, every other one coded in its books (sales for money in, expenses for money out).
  const own = rows(w.company, COMPANY_ACCOUNTS, () => true).map((t, i) => (i % 2 ? t : { ...t, books: { ledger: t.amount > 0 ? 'turnover' : 'general-expenses', setBy: 'user' as const } }));
  // Rows that mirror yours: the other leg of a transfer, if the line were not there.
  const linkable = personalTx.filter((t) => ['current', 'saver', 'card'].includes(t.accountId));
  const mirrors = w.mirrors.map((m, i) => {
    const t = linkable[m.of % linkable.length]!;
    const date = addDays(t.date, m.days) > TODAY ? TODAY : addDays(t.date, m.days);
    const description = MIRROR_WORDS[m.words]!;
    const accountId = COMPANY_ACCOUNTS[i % 2]!.id;
    return { id: transactionId(accountId, date, -t.amount, description, 100 + i), accountId, date, amount: -t.amount, currency: 'GBP', description, source: {}, createdAt: stamp } satisfies Transaction;
  });
  await store.addTransactions([...own, ...mirrors], 'test: company rows');
  await store.addBalances([balance('studio-current', endOfMonth(`${MONTH_LIST[4]}-01`), w.balances[6]! / 100), balance('studio-card', endOfMonth(`${MONTH_LIST[5]}-01`), -Math.abs(w.balances[7]!) / 100)], 'test: company balances');
  const ty = taxYearOf(TODAY);
  await store.addFigures([{ id: figureId('interest_paid', 97.5, ty.label, 'Example Bank', 'Interest', 'studio'), kind: 'interest_paid', label: 'Interest', amount: 97.5, currency: 'GBP', taxYear: ty.label, accountId: 'studio-current', payer: 'Example Bank', source: {}, createdAt: stamp }], 'test: company figure');
  // Its statements stop two months short: behind, with a gap, as a company's books often are.
  let n = 0x800;
  for (const month of MONTH_LIST.slice(0, -3)) await store.saveImport(statement('studio-current', month, n++), 'test: company statement');
  await store.saveImport(statement('studio-card', MONTH_LIST[1]!, n++), 'test: company statement');
  await store.addCoverageConfirmations([{ id: 'cov_00000000c0de', accountId: 'studio-card', from: `${MONTH_LIST[2]}-01`, to: endOfMonth(`${MONTH_LIST[3]}-01`), confirmedAt: stamp }]);
  await store.upsertRecords('terms', [{ id: termsId('studio-card', TODAY, {}), accountId: 'studio-card', asOf: TODAY, rates: [{ applies: 'purchases', rate: 24.9 }], limit: 5000, source: {}, createdAt: stamp }], 'test: company terms');
  // Its books: its dates, VAT, PAYE and filings, some overdue and due soon, so its deadlines are there
  // to leak (and named like your Self Assessment's: tax, a return, HMRC, 31 January).
  const company = store.company(COMPANY)!;
  const inc = INCORPORATED;
  const quarter = (n: number) => endOfMonth(addMonths(FIRST, 3 * n + 2));
  await store.upsertCompany({
    ...company,
    books: {
      ...BOOKS,
      filings: [
        { id: filingId(COMPANY, 'vat', quarter(0)), kind: 'vat', periodStart: FIRST, periodEnd: quarter(0), filedOn: addDays(quarter(0), 45), reference: '975318642', figures: { vatDueSales: 2412.6, vatDueAcquisitions: 0, totalVatDue: 2412.6, vatReclaimedCurrPeriod: 318.45, netVatDue: 2094.15, totalValueSalesExVAT: 12063, totalValuePurchasesExVAT: 1592, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 }, addedBy: 'owner' },
        { id: filingId(COMPANY, 'confirmation', addDays(addYears(inc, 1), -1)), kind: 'confirmation', periodEnd: addDays(addYears(inc, 1), -1), filedOn: addYears(inc, 1), addedBy: 'agent' },
        { id: filingId(COMPANY, 'accounts', endOfMonth(addYears(inc, 1))), kind: 'accounts', periodStart: inc, periodEnd: endOfMonth(addYears(inc, 1)), filedOn: addMonths(endOfMonth(addYears(inc, 1)), 8), figures: { B: 1873, C: 9412, E: -2317, F: 7095, G: 8968, K: 8968 }, addedBy: 'owner' },
      ],
      setBy: 'owner',
      updatedAt: stamp,
    },
    updatedAt: stamp,
  });
  // Its book rule for its own rows, named like your rules' words, and a journal that is not about your loan.
  await store.setBookRules(COMPANY, [...store.bookRules(COMPANY), { id: 'rule_studiotax', name: 'Corporation Tax', enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'HMRC CORPORATION TAX', caseSensitive: false, company: { id: COMPANY, rows: 'own' } }, set: { books: { ledger: 'corporation-tax' } }, createdAt: stamp, updatedAt: stamp }]);
  await store.putJournal({ id: 'jnl_0000000000a1', companyId: COMPANY, date: inc, memo: 'Shares issued at incorporation', lines: [{ ledger: 'share-capital-unpaid', amount: 100 }, { ledger: 'share-capital', amount: -100 }], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }, 'test: journal');
  store.stopWatching();
}

/** A movement of your director's loan, from your side, in pence: what the books add to it, or where they put it on another day. */
interface LoanChange {
  date: string;
  minor: number;
}

/**
 * What only the books know about your loan, added to C through the running app: a dividend declared and
 * credited to the loan (a journal), the company paying something of yours (its row coded to the loan),
 * and a company row you linked to a loan of yours two days after it. Returns each change to your loan
 * from your side: the journal and the coded row as they are, and the linked loan as taken off its own
 * day and put on the company row's.
 */
async function addLoanBooks(store: Store): Promise<LoanChange[]> {
  const out: LoanChange[] = [];
  const dividend = { date: `${MONTH_LIST[7]}-15`, amount: 612.34 };
  await store.putJournal({ id: 'jnl_0000000000a2', companyId: COMPANY, date: dividend.date, memo: 'Dividend declared, credited to the director’s loan', lines: [{ ledger: 'dividends', amount: dividend.amount }, { ledger: 'directors-loan', amount: -dividend.amount }], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }, 'test: dividend');
  out.push({ date: dividend.date, minor: toMinor(dividend.amount) });
  // More than any row of yours, so nothing links it.
  const paid = { date: `${MONTH_LIST[9]}-12`, amount: -4321.09 };
  await store.addTransactions([{ id: transactionId('studio-current', paid.date, paid.amount, 'PAID FOR J BLOGGS', 0), accountId: 'studio-current', date: paid.date, amount: paid.amount, currency: 'GBP', description: 'PAID FOR J BLOGGS', source: {}, createdAt: stamp, books: { ledger: 'directors-loan', setBy: 'user' } }], 'test: paid for you');
  out.push({ date: paid.date, minor: toMinor(paid.amount) });
  const loan = store.transactions().find((t) => t.company?.as === 'loan');
  if (loan) {
    const date = addDays(loan.date, 2) > TODAY ? loan.date : addDays(loan.date, 2);
    await store.addTransactions([{ id: transactionId('studio-current', date, -loan.amount, 'J BLOGGS LOAN', 0), accountId: 'studio-current', date, amount: -loan.amount, currency: 'GBP', description: 'J BLOGGS LOAN', source: {}, createdAt: stamp, companyLink: { rows: [loan.id], setBy: 'user' } }], 'test: linked');
    out.push({ date: loan.date, minor: toMinor(loan.amount) }, { date, minor: -toMinor(loan.amount) });
  }
  return out;
}

/**
 * The links the app made by itself (auto), each checked to be exact and within 4 days, as changes to
 * your loan's days: off your row's day, onto the company row's.
 */
function autoLinkShifts(store: Store): LoanChange[] {
  const out: LoanChange[] = [];
  for (const c of store.companyTransactions(COMPANY)) {
    if (c.companyLink?.setBy !== 'auto') continue;
    const [p] = c.companyLink.rows.map((id) => store.transaction(id)!);
    expect(c.companyLink.rows).toHaveLength(1);
    expect(toMinor(p!.amount) + toMinor(c.amount)).toBe(0);
    expect(Math.abs(Date.parse(p!.date) - Date.parse(c.date)) / 86_400_000).toBeLessThanOrEqual(4);
    out.push({ date: p!.date, minor: toMinor(p!.amount) }, { date: c.date, minor: -toMinor(p!.amount) });
  }
  return out;
}

// ─── The comparison ───────────────────────────────────────────────────────────────────────────────

/**
 * Routes that legitimately answer differently, whole: each is about a company's accounts or about
 * documents and this run, not a personal figure.
 */
const DIFFERENT: Record<string, string> = {
  '/api/company-accounts': "the company's own accounts: that is what it lists",
  '/api/company-books': "the companies whose books are kept here, with their deadlines: the company's records",
  '/api/company-alerts': "the company's deadlines due soon or overdue: the company's, shown beside your alerts, never among them",
  '/api/companies/:id/books': "a company's own records and the deadlines worked out from them: that is what it serves",
  '/api/companies/:id/ledger': "a company's general ledger: its postings and checks",
  '/api/companies/:id/coding': "a company's rows to code, its links, journals and book rules",
  '/api/companies/:id/accounts': "a company's accounts for a period (trial balance, profit and loss, balance sheet, register, its bank reconciled), from its ledger",
  '/api/companies/:id/vat': "a company's VAT returns from its ledger (boxes, returns filed, errors, penalty points, thresholds)",
  '/api/imports/history': 'every committed document, a company account’s statements too (no figure; an account’s own page lists its own)',
  '/api/audit': 'the log of this process: its own times and hashes',
  '/api/audit/export': 'the log of this process: its own times and hashes',
  '/api/audit/verify': 'the log of this process: its own times and hashes',
};
/** Routes that cannot be called here at all. */
const SKIP: Record<string, string> = {
  '/api/events': 'a server-sent event stream: it never ends',
  '/*': 'the web app, not the API',
};

interface Probe {
  url: string;
  status: number;
  body: unknown;
}

function urls(routes: readonly string[], ids: { tx: string[] }): string[] {
  const ty = taxYearOf(TODAY);
  const lastTy = taxYearOf(addDays(ty.start, -1));
  const month = TODAY.slice(0, 7);
  const lastMonth = addMonths(TODAY, -1).slice(0, 7);
  const fill: Record<string, string[]> = {
    ':id': ['none'],
    ':docId': ['doc_0000000000000001', 'doc_0000000000000800'],
    ':month': [month, lastMonth, MONTH_LIST[0]!],
    ':key': ['t0'],
    ':name{.+}': ['none'],
  };
  const firstImport = `imp_${MONTH_LIST[0]!.replace('-', '')}01_000000_0001`;
  const byRoute: Record<string, string[]> = {
    '/api/accounts/:id': PERSONAL.map((a) => a.id),
    '/api/accounts/:id/terms': PERSONAL.map((a) => a.id),
    '/api/accounts/:id/arrangements': PERSONAL.map((a) => a.id),
    '/api/transactions/:id/similar': ids.tx.slice(0, 6),
    '/api/imports/:id': [firstImport],
    '/api/imports/:id/table': [firstImport],
    '/api/imports/:id/file': [firstImport],
    '/api/imports/:id/reread': [firstImport],
    '/api/feeds/:id/today': ['trading-212'],
  };
  const queries: Record<string, string[]> = {
    '/api/transactions': ['', '?limit=10000', '?q=hmrc', '?q=example%20studio', '?transfers=only', '?transfers=exclude', '?categories=salary,dividends,interest,tax,benefits', `?accounts=${PERSONAL.map((a) => a.id).join(',')}`, `?from=${MONTH_LIST[0]}-01&to=${TODAY}&direction=in`],
    '/api/transactions/export.csv': ['', '?q=example'],
    '/api/allowances': ['', `?taxYear=${ty.label}`, `?taxYear=${lastTy.label}`],
    '/api/self-assessment': ['', `?taxYear=${lastTy.label}`, `?taxYear=${lastTy.label}&format=csv`],
    '/api/pay': ['', `?taxYear=${lastTy.label}`],
    '/api/tax-documents': ['', `?taxYear=${lastTy.label}`],
    '/api/figures': ['', `?taxYear=${ty.label}`],
    '/api/estate': ['', `?from=${MONTH_LIST[0]}-01&grouping=access`],
    '/api/cashflow': ['', `?from=${MONTH_LIST[0]}-01`],
    '/api/spending': ['', `?from=${MONTH_LIST[0]}-01`],
    '/api/budgets': ['', `?month=${lastMonth}`],
    '/api/projections': ['', '?units=nominal&months=120'],
  };
  const out: string[] = [];
  for (const route of routes) {
    if (route in SKIP || route in DIFFERENT) continue;
    const params = route.match(/:[A-Za-z]+(\{[^}]+\})?/g) ?? [];
    let filled = [route];
    for (const p of params) {
      const values = byRoute[route] && p === ':id' ? byRoute[route] : fill[p];
      if (!values) throw new Error(`No values for ${p} in ${route}: add them to the test (or a reason to skip it)`);
      filled = filled.flatMap((u) => values.map((v) => u.replace(p, v)));
    }
    for (const u of filled) for (const q of queries[route] ?? ['']) out.push(`${u}${q}`);
  }
  return out;
}

/** When this file started: a timestamp from then on was made by this run (a write's `updatedAt`, a log's start), not read from the data. */
const STARTED = Date.now() - 1000;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

async function probe(app: App, root: string, url: string): Promise<Probe> {
  const res = await app.app.request(`http://localhost${url}`, { headers: { host: 'localhost' } });
  // The two stores live in different directories, and were written moments apart: their paths and
  // the times this run made are all that is told apart. No figure is.
  const text = (await res.text())
    .split(root)
    .join('<root>')
    .replace(TIMESTAMP, (t) => (Date.parse(t) >= STARTED ? '<now>' : t));
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // CSV and other text: compared as it is.
  }
  return { url, status: res.status, body };
}

/** The first place two JSON values differ, as a path, or null. */
function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${at}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array ≠ object`;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return `${at}: ${a.length} items ≠ ${(b as unknown[]).length}`;
  for (const k of new Set([...ka, ...kb])) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

interface Pair {
  root: string;
  personal: { app: App; root: string };
  both: { app: App; root: string };
  txIds: string[];
}

async function openApp(root: string): Promise<App> {
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(root, 'data'), FINANCE_WORK_DIR: path.join(root, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(root, 'no-web');
  return createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
}

/** A row of yours dated and sized as the other leg of the Tide export's top up, naming the company's account. */
const LURE = { date: '2026-09-02', amount: -500, description: 'TRANSFER TO STUDIO ACCOUNT 12347788' };

/**
 * S in one directory, S ∪ C in another, an app over each. `company: false` leaves C out (a test
 * adds it through the app); `lure` adds a row of yours that looks like the other leg of the Tide
 * fixture's top up.
 */
async function pairFor(w: World, opts: { company?: boolean; lure?: boolean } = {}): Promise<Pair> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finance-scope-'));
  const s = path.join(root, 's');
  const sc = path.join(root, 'sc');
  const { txIds } = await writePersonal(path.join(s, 'data'), w, opts.lure ? [LURE] : []);
  await cp(s, sc, { recursive: true });
  if (opts.company !== false) {
    const store = await Store.open(path.join(sc, 'data'));
    const personalTx = store.transactions();
    store.stopWatching();
    await writeCompany(path.join(sc, 'data'), w, personalTx);
  }
  return { root, personal: { app: await openApp(s), root: s }, both: { app: await openApp(sc), root: sc }, txIds };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function closePair(p: Pair): Promise<void> {
  await p.personal.app.close();
  await p.both.app.close();
  await rm(p.root, { recursive: true, force: true, maxRetries: 5 });
}

/** Every GET route for S and for S ∪ C: the differences found (none, when nothing leaks). */
async function differences(p: Pair): Promise<string[]> {
  const routes = [...new Set(p.personal.app.app.routes.filter((r) => r.method === 'GET').map((r) => r.path))];
  const out: string[] = [];
  for (const url of urls(routes, { tx: p.txIds })) {
    const a = await probe(p.personal.app, p.personal.root, url);
    const b = await probe(p.both.app, p.both.root, url);
    const d = a.status !== b.status ? `status ${a.status} ≠ ${b.status}` : firstDifference(a.body, b.body);
    if (d) out.push(`${url} ${d}`);
  }
  return out;
}

/** The day your director's loan's recorded balance anchors it (S's own: a balance on the loan). */
const LOAN_ANCHOR = endOfMonth(`${MONTH_LIST[5]}-01`);

/**
 * The one difference by design, exactly: on every day from before the data to today, every account of
 * yours but the director's loan has the same balance in S and S ∪ C; the loan differs by exactly what
 * `changes` say, as its anchor reads movements (after it, those since; before it, those up to it, the
 * other way), on each day it has a balance on both sides; and the estate differs by exactly the loan's
 * difference.
 */
function expectOnlyTheLoan(p: Pair, changes: readonly LoanChange[]): void {
  const [s, b] = [p.personal.app.ctx, p.both.app.ctx];
  const [eS, eB] = [s.analytics.engine, b.analytics.engine];
  const ids = s.store.accounts.map((a) => a.id);
  expect(b.store.accounts.map((a) => a.id)).toEqual(ids);
  const moved = (d: string) => (d >= LOAN_ANCHOR ? changes.filter((c) => c.date > LOAN_ANCHOR && c.date <= d) : changes.filter((c) => c.date > d && c.date <= LOAN_ANCHOR).map((c) => ({ ...c, minor: -c.minor }))).reduce((sum, c) => sum + c.minor, 0);
  const minor = (v: number | null | undefined) => toMinor(v ?? 0);
  for (const d of eachDay(addDays(FIRST, -1), TODAY)) {
    for (const id of ids) if (id !== 'studio-loan') expect(eB.balanceOn(id, d), `${id} on ${d}`).toEqual(eS.balanceOn(id, d));
    const [lb, ls] = [eB.balanceOn('studio-loan', d), eS.balanceOn('studio-loan', d)];
    const loan = minor(lb?.value) - minor(ls?.value);
    // Before a loan's first movement it has no balance at all (an account adds nothing before its data):
    // a day the books' first movement comes later, or sooner, than your marks' has a balance on one side only.
    if (lb && ls) expect(loan, `the loan on ${d}`).toBe(moved(d));
    expect(minor(estateOn(b.store, eB, d).total) - minor(estateOn(s.store, eS, d).total), `the estate on ${d}`).toBe(loan);
  }
}

/** Take your director's loan away from the company in both (null), or give it back. */
async function setLoan(p: Pair, accountId: string | null): Promise<void> {
  for (const app of [p.personal.app, p.both.app]) {
    const company = app.ctx.store.company(COMPANY)!;
    const { directorLoanAccountId: _l, ...rest } = company;
    await app.ctx.store.upsertCompany(accountId ? { ...rest, directorLoanAccountId: accountId } : rest);
  }
}

/** Re-apply categorisation and link transfers on both: what enrichment makes of S must not change with C beside it. */
async function enrichBoth(p: Pair): Promise<void> {
  for (const app of [p.personal.app, p.both.app]) {
    const res = await app.app.request('http://localhost/api/enrich', { method: 'POST', headers: { host: 'localhost', ...CSRF }, body: '{}' });
    expect(res.status).toBe(200);
  }
}

const RUN = { seed: 20261126, numRuns: 4, endOnFailure: true } as const;

describe('company accounts never touch a personal figure', () => {
  it('every GET route answers the same for your data alone and with a company’s beside it, before and after re-applying categorisation, but for your director’s loan by exactly what its books add', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const p = await pairFor(w);
        try {
          // Its books kept here, and saying what your marks say: nothing at all differs, your loan included.
          expect(await differences(p)).toEqual([]);
          // What only its books know moves your loan, and through it the estate: by exactly that.
          const changes = await addLoanBooks(p.both.app.ctx.store);
          expectOnlyTheLoan(p, changes);
          // With your loan taken away from the company, nothing at all differs, before and after re-working rows out.
          await setLoan(p, null);
          expect(await differences(p)).toEqual([]);
          await enrichBoth(p);
          expect(await differences(p)).toEqual([]);
          // Given back, with the links the app made by itself: by exactly what the books add, again.
          await setLoan(p, 'studio-loan');
          expectOnlyTheLoan(p, [...changes, ...autoLinkShifts(p.both.app.ctx.store)]);
          // The company's rows are there, and enrichment left them uncategorised but for transfers
          // between its own two accounts, and never linked one of them with one of yours.
          const { store } = p.both.app.ctx;
          const company = new Set(COMPANY_ACCOUNTS.map((a) => a.id));
          for (const id of company) {
            for (const t of store.transactions(id)) {
              if (t.categorisedBy === 'user') continue;
              if (t.transferGroup) expect(company.has(t.counterpartyAccountId!)).toBe(true);
              else expect(t.category).toBeUndefined();
            }
          }
          for (const t of store.transactions()) if (t.counterpartyAccountId) expect(company.has(t.counterpartyAccountId)).toBe(false);
          // The director's loan was there to be changed, and re-working rows out kept every mark.
          const loan = (await (await p.both.app.app.request('http://localhost/api/accounts/studio-loan', { headers: { host: 'localhost' } })).json()) as AccountDetailResponse;
          expect(loan.directorLoan?.movements.length).toBeGreaterThan(0);
          // Each row of yours paid for it or lent to it, or the company row linked to it; and what only the books know.
          expect(loan.directorLoan?.movements.filter((m) => m.source === 'mark' || m.source === 'company-row').reduce((sum, m) => sum + toMinor(m.amount), 0)).toBe(store.transactions().filter((t) => t.company?.as === 'paid-for' || t.company?.as === 'loan').reduce((sum, t) => sum - toMinor(t.amount), 0) + toMinor(-4321.09));
          expect(loan.directorLoan?.movements.filter((m) => m.source === 'journal').map((m) => m.amount)).toEqual([612.34]);
          // Every row of yours paid for it is coded: by you, or by the book rule for them.
          for (const t of store.transactions()) if (t.company?.as === 'paid-for') expect(t.books?.ledger).toBe('software-hosting');
          for (const t of store.transactions()) if (t.company) expect(t.transferGroup).toBeUndefined();
          // The company's books were there, and their own routes serve them (the routes left out above).
          const books = async (a: App) => (await (await a.app.request(`http://localhost/api/companies/${COMPANY}/books`, { headers: { host: 'localhost' } })).json()) as CompanyBooksResponse;
          expect((await books(p.personal.app)).books?.filings).toEqual([]);
          const theirs = await books(p.both.app);
          expect(theirs.books?.filings).toHaveLength(3);
          expect(theirs.deadlines.some((d) => d.status === 'overdue' || d.status === 'due-soon')).toBe(true);
          expect(theirs.problems).toEqual([]);
        } finally {
          await closePair(p);
        }
      }),
      RUN,
    );
  }, 120_000);

  it('importing a company’s statements through the app (a Tide export, a Capital on Tap export) changes no personal figure', async () => {
    const w = fc.sample(world, { seed: RUN.seed + 1, numRuns: 1 })[0]!;
    const p = await pairFor(w, { company: false, lure: true });
    try {
      const app = p.both.app;
      const req = (url: string, init: RequestInit = {}) => app.app.request(`http://localhost${url}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
      const json = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
      for (const body of [
        { id: 'studio-tide', name: 'Studio Tide', type: 'current', institutionId: 'tide', last4: '7788', companyId: COMPANY },
        { id: 'studio-cot', name: 'Studio card', type: 'credit_card', institutionId: 'capital-on-tap', companyId: COMPANY },
      ]) {
        const res = await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
        expect(((await res.json()) as Account).includeInNetWorth).toBe(false);
      }
      for (const [file, accountId] of [
        ['tide.csv', 'studio-tide'],
        ['capital-on-tap.csv', 'studio-cot'],
      ] as const) {
        const form = new FormData();
        form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures', file))]), file);
        form.append('accountId', accountId);
        const up = await req('/api/imports', { method: 'POST', headers: { 'x-finance-csrf': '1' }, body: form });
        expect(up.status).toBe(201);
        const id = ((await up.json()) as { results: { id: string }[] }).results[0]!.id;
        type Draft = { status: string; draft?: { notes: string[]; sections: { target: { accountId?: string }; transactions: { category?: string; categorisedBy?: string; transferMatch?: string }[] }[] } };
        const rec = await waitFor(async () => {
          const r = (await (await req(`/api/imports/${id}`)).json()) as Draft;
          return r.status === 'review' ? r : undefined;
        });
        const [section] = rec.draft!.sections;
        expect(section!.target.accountId).toBe(accountId);
        // The pending row Tide's export lists is left out, and the review page says so.
        if (file === 'tide.csv') expect(rec.draft!.notes).toContainEqual(expect.stringContaining('1 row left out: Status is "Pending"'));
        // Nothing of yours names its rows (your rules, the bank's categories), and no row of yours is
        // their other leg: the only category is a transfer's, with the company's other account.
        for (const t of section!.transactions) {
          if (!t.transferMatch) expect(t.category).toBeUndefined();
          else {
            expect(p.both.app.ctx.store.transaction(t.transferMatch)!.accountId).toBe('studio-tide');
            expect(t.categorisedBy).toBe('transfer');
          }
        }
        expect((await req(`/api/imports/${id}/commit`, { method: 'POST', headers: { 'x-finance-csrf': '1' } })).status).toBe(200);
      }
      const { store } = app.ctx;
      // The card's repayment from the company's account is linked, within the company.
      const repaid = store.transactions('studio-tide').find((t) => t.amount === -250)!;
      expect(repaid).toMatchObject({ counterpartyAccountId: 'studio-cot', categorisedBy: 'transfer' });
      // The row of yours that looks like the other leg of its top up is not.
      const lure = store.transactions('current').find((t) => t.description === LURE.description)!;
      expect(lure.transferGroup).toBeUndefined();
      expect(await differences(p)).toEqual([]);
      await enrichBoth(p);
      expect(await differences(p)).toEqual([]);
    } finally {
      await closePair(p);
    }
  }, 60_000);

  describe('the canary', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await pairFor(fc.sample(world, { seed: RUN.seed, numRuns: 1 })[0]!);
    });
    afterAll(async () => closePair(p));

    it('with the store’s scope off, the same comparison finds the company’s data in personal figures', async () => {
      expect(await differences(p)).toEqual([]);
      p.both.app.ctx.store.widenScopeForTest();
      const found = await differences(p);
      expect(found.length).toBeGreaterThan(10);
      // Among them the figures that matter most.
      for (const route of ['/api/summary', '/api/transactions', '/api/cashflow', '/api/accounts', '/api/data-health']) expect(found.some((d) => d.startsWith(`${route} `) || d.startsWith(`${route}?`))).toBe(true);
    }, 60_000);
  });
});
