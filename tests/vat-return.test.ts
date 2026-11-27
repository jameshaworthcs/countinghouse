// A company's VAT returns from its books (docs/FORMULAS.md §22, "VAT returns"; analytics/vat-return.ts):
// the nine boxes and what goes in each, cash accounting's dates, reg 111 claims in the first return, a
// reverse charge's tax point, the pence of boxes 6–9, what stops a return being ready, a return filed
// against the books, errors and how they may be corrected (VAT Notice 700/45), penalty points
// information and taxable turnover against the thresholds. Pure functions over an in-memory source, and
// properties over generated rows. Every name and figure is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CompanyVatResponse, VatBoxKey, VatReturnView } from '../src/shared/api';
import { companyLedger, type LedgerSource } from '../src/server/analytics/ledger';
import { companyVat, NOT_A_SUPPLY, reverseChargeTaxPoint, taxableTurnover, vatFigures, vatReturnCsv } from '../src/server/analytics/vat-return';
import { transactionId } from '../src/server/ids';
import { addVatCorrection, addVatDisclosure, booksProblems } from '../src/shared/company-books';
import { VAT_RETURN_DISCLAIMER } from '../src/shared/disclaimers';
import { addDays } from '../src/shared/dates';
import { poundsWithoutPence } from '../src/shared/money';
import type { Account, BooksCoding, Company, CompanyFiling, Journal, Transaction, VatBoxes } from '../src/shared/schema';
import { VAT_DEREGISTRATION_ASSETS_RULES, vatCorrectionDeadline, vatCorrectionMethod, vatFrequencyOfPeriod, vatPointExpiry, vatThresholdsOn } from '../src/shared/uk';

const stamp = '2024-01-01T00:00:00+00:00';
const CO = 'example-kiln';
const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
type Books = NonNullable<Company['books']>;
/** Incorporated on 1 January 2024, registered for VAT from 1 April 2024, quarters to March, June, September and December. */
const booksOf = (extra: Partial<Books> = {}): Books => ({ incorporatedOn: '2024-01-01', accountingReferenceDate: '12-31', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp, vat: { registeredFrom: '2024-04-01', scheme: 'cash', schedule: [{ from: '2024-04-01', stagger: 'quarterly-1' }] }, ...extra });
const companyOf = (books: Partial<Books> = {}): Company => ({ id: CO, name: 'Example Kiln Ltd', holdings: [], valuations: [], directorLoanAccountId: 'loan', createdBy: 'owner', createdAt: stamp, updatedAt: stamp, books: booksOf(books) });
const journal = (date: string, memo: string, lines: Journal['lines'], extra: Partial<Journal> = {}): Journal => ({ id: `jnl_${(n++).toString(16).padStart(12, '0')}`, companyId: CO, date, memo, lines, createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
const coded = (ledger: string, extra: Partial<BooksCoding> = {}): BooksCoding => ({ ledger, setBy: 'user', ...extra });
const std = (amount: number) => ({ amount, treatment: 'standard' as const });
const vatOf = (treatment: 'zero' | 'exempt' | 'outside' | 'abroad') => ({ amount: 0, treatment });

const ACCOUNTS: Account[] = [acct('current', 'Everyday', 'current'), acct('card', 'Example Card', 'credit_card'), acct('loan', 'Director’s loan', 'director_loan'), acct('kiln-bank', 'Kiln Account', 'current', { companyId: CO, includeInNetWorth: false })];
const bank = (date: string, amount: number, description: string, books?: BooksCoding) => tx('kiln-bank', date, amount, description, books ? { books } : {});

function memory(rows: Transaction[], opts: { journals?: Journal[]; company?: Company } = {}): LedgerSource {
  const companies = [opts.company ?? companyOf()];
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const companyOfAccount = (id: string) => ACCOUNTS.find((a) => a.id === id)?.companyId;
  return {
    balances: () => [],
    transactions: (accountId?: string) => (accountId ? sorted.filter((t) => t.accountId === accountId) : sorted.filter((t) => !companyOfAccount(t.accountId))),
    transaction: (id) => byId.get(id),
    account: (id) => ACCOUNTS.find((a) => a.id === id),
    company: (id) => companies.find((c) => c.id === id),
    companyAccounts: (id) => ACCOUNTS.filter((a) => a.companyId === id),
    companyTransactions: (id) => sorted.filter((t) => companyOfAccount(t.accountId) === id),
    companyJournals: (id) => (opts.journals ?? []).filter((j) => j.companyId === id),
    bookRules: () => [],
  };
}

const vatOn = (src: LedgerSource, today: string, period?: string): CompanyVatResponse => companyVat({ src, company: src.company(CO)!, today, period })!;
const box = (ret: VatReturnView, key: VatBoxKey) => ret.boxes.find((b) => b.key === key)!;
const values = (ret: VatReturnView) => Object.fromEntries(ret.boxes.map((b) => [b.box, b.value]));
const kinds = (ret: VatReturnView) => ret.checks.map((c) => (c.kind === 'ledger' ? c.check.kind : c.kind));
const filing = (start: string, end: string, filedOn: string, figures?: VatBoxes, extra: Partial<Extract<CompanyFiling, { kind: 'vat' }>> = {}): CompanyFiling => ({ id: `fil_${end.replace(/-/g, '').padStart(12, '0')}`, kind: 'vat', periodStart: start, periodEnd: end, filedOn, addedBy: 'owner', ...(figures ? { figures } : {}), ...extra });

/** The quarter to 30 September 2024: sales and purchases at every treatment, a reverse charge, pay, a credit note each way. */
const QUARTER = [
  bank('2024-07-05', 1200, 'EXAMPLE CLIENT LTD', coded('turnover', { vat: std(200) })),
  bank('2024-07-06', 500, 'EXAMPLE OVERSEAS CLIENT', coded('turnover', { vat: vatOf('outside') })),
  bank('2024-07-31', 3.21, 'INTEREST', coded('interest-receivable', { vat: vatOf('exempt') })),
  bank('2024-07-10', -240, 'EXAMPLE SOFTWARE LTD', coded('software-hosting', { vat: std(-40) })),
  bank('2024-07-31', -5, 'MONTHLY FEE', coded('bank-charges', { vat: vatOf('exempt') })),
  bank('2024-08-01', -100, 'EXAMPLE BOOKS LTD', coded('office-costs', { vat: vatOf('zero') })),
  bank('2024-08-02', -50, 'EXAMPLE GIFT', coded('general-expenses', { vat: vatOf('outside') })),
  bank('2024-08-03', -36, 'EXAMPLE CLOUD INC', coded('software-hosting', { vat: { amount: -7.2, treatment: 'reverse-charge' } })),
  bank('2024-08-28', -1000, 'J BLOGGS SALARY', coded('directors-salaries')),
  bank('2024-09-01', -12.34, 'EXAMPLE TRAIN', coded('travel')),
  bank('2024-09-02', 60, 'EXAMPLE SOFTWARE LTD REFUND', coded('software-hosting', { vat: std(10) })),
  bank('2024-09-03', -120, 'EXAMPLE CLIENT LTD REFUND', coded('turnover', { vat: std(-20) })),
  bank('2024-09-05', -1.19, 'EXAMPLE STAMPS', coded('office-costs', { vat: vatOf('zero') })),
];

describe('the nine boxes', () => {
  const v = vatOn(memory(QUARTER), '2024-12-15', '2024-09-30');
  const ret = v.ret!;

  it('puts output VAT in box 1 and input VAT in box 4, a reverse charge in both, credit notes taking away', () => {
    // 200 + 7.20 (reverse charge) − 20 (a refund to a customer); 40 + 7.20 − 10 (a supplier's credit note).
    expect(box(ret, 'vatDueSales').value).toBe(18_720);
    expect(box(ret, 'vatReclaimedCurrPeriod').value).toBe(3_720);
    expect(box(ret, 'totalVatDue').value).toBe(18_720);
    expect(box(ret, 'netVatDue').value).toBe(15_000);
    expect(ret.direction).toBe('pay');
    expect(box(ret, 'vatDueAcquisitions')).toMatchObject({ value: 0, unsupported: true });
  });

  it('puts every sale in box 6 but those outside the scope that are not a supply, and the reverse charge’s value', () => {
    // 1,000 + 500 (a sale abroad, outside the scope by its place of supply: Notice 700/12 para 3.7) + 3.21 (exempt interest) + 36 − 100.
    expect(box(ret, 'totalValueSalesExVAT')).toMatchObject({ exact: 143_921, value: 1_439 });
  });

  it('puts purchases in box 7 at every rate but outside the scope, leaving out pay and what has no treatment', () => {
    // 200 + 5 (exempt) + 100 (zero) + 36 (reverse charge) − 50 + 1.19.
    expect(box(ret, 'totalValuePurchasesExVAT')).toMatchObject({ exact: 29_219, value: 292 });
    const left = Object.fromEntries(ret.leftOut.map((l) => [l.reason, l.amount]));
    expect(left).toEqual({ outside: 5_000, 'not-a-supply': 100_000, untreated: 1_234 });
    expect([...NOT_A_SUPPLY]).toContain('directors-salaries');
  });

  it('shows the working: each box’s postings add up to it', () => {
    for (const b of ret.boxes.filter((x) => x.lines.length)) expect(b.lines.reduce((s, l) => s + l.amount, 0)).toBe(b.exact ?? b.value);
    expect(box(ret, 'vatDueSales').lines.map((l) => l.treatment)).toEqual(['standard', 'reverse-charge', 'standard']);
  });

  it('is ready once the period has ended and nothing stops it; a warning about no treatment does not', () => {
    expect(ret.checks).toEqual([]);
    expect(ret.ready).toBe(true);
    expect(ret.period.status).toBe('ready');
    expect(ret.period.computed).toBe(15_000);
  });

  it('gives the boxes as a filing records them, and as CSV ending with the disclaimer', () => {
    expect(vatFigures(ret.boxes)).toEqual({ vatDueSales: 187.2, vatDueAcquisitions: 0, totalVatDue: 187.2, vatReclaimedCurrPeriod: 37.2, netVatDue: 150, totalValueSalesExVAT: 1439, totalValuePurchasesExVAT: 292, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 });
    const csv = vatReturnCsv(companyOf(), ret, (x) => String(x));
    expect(csv.split('\n').slice(1, 10).map((l) => l.split(',').at(-1))).toEqual(['187.20', '0.00', '187.20', '37.20', '150.00', '1439', '292', '0', '0']);
    expect(csv.trim().split('\n').at(-1)).toBe(VAT_RETURN_DISCLAIMER);
    expect(v.disclaimer).toBe(VAT_RETURN_DISCLAIMER);
  });
});

describe('the pence of boxes 6 to 9', () => {
  it('are left out, never rounded up, either way', () => {
    expect([199, 100, 99, 0, -99, -199, 143_921].map(poundsWithoutPence)).toEqual([1, 1, 0, 0, 0, -1, 1_439]);
    expect(Object.is(poundsWithoutPence(-50), 0)).toBe(true);
  });

  it('a quarter of credit notes has a negative box 6', () => {
    const v = vatOn(memory([bank('2024-07-05', -120.5, 'REFUND', coded('turnover', { vat: std(-20.08) }))]), '2024-12-15', '2024-09-30');
    expect(box(v.ret!, 'totalValueSalesExVAT')).toMatchObject({ exact: -10_042, value: -100 });
    expect(box(v.ret!, 'vatDueSales').value).toBe(-2_008);
  });
});

describe('which return a posting is in', () => {
  it('under cash accounting, by the day paid', () => {
    const v = vatOn(memory([bank('2024-09-30', 120, 'PAID SEPTEMBER', coded('turnover', { vat: std(20) })), bank('2024-10-01', 240, 'PAID OCTOBER', coded('turnover', { vat: std(40) }))]), '2025-02-15');
    const q3 = v.periods.find((p) => p.end === '2024-09-30')!;
    const q4 = v.periods.find((p) => p.end === '2024-12-31')!;
    expect([q3.computed, q4.computed]).toEqual([2_000, 4_000]);
  });

  it('a row of yours paid for the company, on its day, when the company credits your loan; without an invoice to the company it is a check', () => {
    const paid = tx('card', '2024-08-14', -24, 'EXAMPLE DOMAINS', { company: { id: CO, as: 'paid-for', setBy: 'user' }, books: coded('software-hosting', { vat: std(-4), invoiceToCompany: true }) });
    const noInvoice = tx('card', '2024-11-14', -36, 'EXAMPLE PRINTERS', { company: { id: CO, as: 'paid-for', setBy: 'user' }, books: coded('office-costs', { vat: std(-6) }) });
    const src = memory([paid, noInvoice]);
    const q3 = vatOn(src, '2025-02-15', '2024-09-30').ret!;
    expect(box(q3, 'vatReclaimedCurrPeriod').value).toBe(400);
    expect(q3.ready).toBe(true);
    const q4 = vatOn(src, '2025-02-15', '2024-12-31').ret!;
    expect(kinds(q4)).toEqual(['vat-no-invoice']);
    expect(q4.period.status).toBe('not-ready');
  });

  it('a claim under reg 111 in the first return, whatever its day, its value in box 7 beside its VAT; one out of time stops the first return', () => {
    const laptop = bank('2024-02-10', -1200, 'EXAMPLE COMPUTERS', coded('fixed-assets:computer:cost', { vat: { amount: -200, treatment: 'standard', claim: 'reg111' }, asset: { class: 'computer', months: 36 } }));
    const first = vatOn(memory([laptop]), '2024-12-15', '2024-06-30').ret!;
    expect(first.period.first).toBe(true);
    expect(box(first, 'vatReclaimedCurrPeriod')).toMatchObject({ value: 20_000, lines: [expect.objectContaining({ counted: 'reg111', date: '2024-02-10' })] });
    expect(box(first, 'totalValuePurchasesExVAT')).toMatchObject({ value: 1_000, lines: [expect.objectContaining({ counted: 'reg111', amount: 100_000 })] });
    expect(first.leftOut).toEqual([]);
    expect(first.notes.join(' ')).toMatch(/reg 111\(3\)/);
    expect(first.notes.join(' ')).toMatch(/box 7 beside their VAT in box 4/);
    expect(first.ready).toBe(true);
    // Services more than 6 months before registration: out of time, which stops the first return.
    const late = bank('2023-09-01', -120, 'EXAMPLE ADVICE', coded('professional-fees', { vat: { amount: -20, treatment: 'standard', claim: 'reg111' } }));
    const stopped = vatOn(memory([late], { company: companyOf({ incorporatedOn: '2023-06-01' }) }), '2024-12-15', '2024-06-30').ret!;
    expect(kinds(stopped)).toEqual(['reg111']);
  });

  it('VAT on a day before registration that is not a reg 111 claim stops the first return', () => {
    const early = bank('2024-03-10', -60, 'EXAMPLE TOOLS', coded('small-equipment', { vat: std(-10) }));
    const first = vatOn(memory([early]), '2024-12-15', '2024-06-30').ret!;
    expect(kinds(first)).toEqual(['vat-unregistered']);
    expect(box(first, 'vatReclaimedCurrPeriod').value).toBe(0);
  });

  it('a reverse charge on the earlier of payment and the end of the service it covers (Notice 700 para 15.12)', () => {
    // A September service paid in October is September's; a subscription paid ahead is the day paid.
    const arrears = bank('2024-10-03', -36, 'EXAMPLE CLOUD INC', coded('software-hosting', { vat: { amount: -7.2, treatment: 'reverse-charge' }, covers: { from: '2024-09-01', to: '2024-09-30' } }));
    const ahead = bank('2024-10-04', -120, 'EXAMPLE DESIGN INC', coded('software-hosting', { vat: { amount: -24, treatment: 'reverse-charge' }, covers: { from: '2024-10-04', to: '2025-10-03' } }));
    const src = memory([arrears, ahead]);
    const q3 = vatOn(src, '2025-02-15', '2024-09-30').ret!;
    const q4 = vatOn(src, '2025-02-15', '2024-12-31').ret!;
    expect(values(q3)).toMatchObject({ 1: 720, 4: 720, 6: 36, 7: 36 });
    expect(box(q3, 'vatDueSales').lines[0]).toMatchObject({ counted: 'tax-point', date: '2024-10-03' });
    expect(q3.notes.join(' ')).toMatch(/para 15\.12/);
    expect(values(q4)).toMatchObject({ 1: 2_400, 4: 2_400, 6: 120, 7: 120 });
  });

  it('a journal’s VAT lines by the side they say; an opening journal never', () => {
    const sold = journal('2024-08-20', 'Old printer sold, VAT corrected', [
      { ledger: 'debtors:other', amount: 60 },
      { ledger: 'disposals', amount: -50, vat: { treatment: 'standard', side: 'output' } },
      { ledger: 'vat', amount: -10, vat: { treatment: 'standard', side: 'output' } },
    ]);
    const opening = journal('2024-07-01', 'Opening balances', [
      { ledger: 'office-costs', amount: 100, vat: { treatment: 'standard', side: 'input' } },
      { ledger: 'vat', amount: 20, vat: { treatment: 'standard', side: 'input' } },
      { ledger: 'retained-earnings', amount: -120 },
    ], { opening: true });
    const ret = vatOn(memory([], { journals: [sold, opening] }), '2024-12-15', '2024-09-30').ret!;
    expect(values(ret)).toMatchObject({ 1: 1_000, 4: 0, 6: 50, 7: 0 });
  });
});

describe('what stops a return being ready', () => {
  it('a period not ended, with a row not coded and its suspense', () => {
    const filed = companyOf({ filings: [filing('2024-04-01', '2024-06-30', '2024-07-20'), filing('2024-07-01', '2024-09-30', '2024-10-20')] });
    const running = vatOn(memory([bank('2024-11-02', -18.4, 'EXAMPLE STATIONERS')], { company: filed }), '2024-11-20');
    expect(running.next).toBe('2024-12-31');
    expect(running.ret!.period.status).toBe('open');
    expect(kinds(running.ret!).sort()).toEqual(['not-ended', 'suspense', 'uncoded']);
  });

  it('a loan of yours with no company row', () => {
    const loan = tx('current', '2024-08-02', -500, 'TO KILN', { company: { id: CO, as: 'loan', setBy: 'user' } });
    expect(kinds(vatOn(memory([loan]), '2024-12-15', '2024-09-30').ret!)).toEqual(['bank-not-imported']);
  });

  it('books that start within the period, and a period before them', () => {
    const company = companyOf({ ledgerFrom: '2024-08-01' });
    const later = vatOn(memory([], { company }), '2024-12-15');
    expect(later.periods.map((p) => p.status)).toEqual(['before-books', 'not-ready', 'open']);
    expect(vatOn(memory([], { company }), '2024-12-15', '2024-09-30').ret!.checks).toEqual([{ kind: 'not-in-books', ledgerFrom: '2024-08-01' }]);
  });

  it('a check about another period does not stop this one', () => {
    const v = vatOn(memory([...QUARTER, bank('2024-10-02', -18.4, 'EXAMPLE STATIONERS')]), '2025-02-15', '2024-09-30');
    expect(v.ret!.ready).toBe(true);
    expect(v.periods.find((p) => p.end === '2024-12-31')!.status).toBe('not-ready');
    // The next to file is the earliest ended and not filed.
    expect(v.next).toBe('2024-06-30');
  });

  it('a reverse charge whose VAT is not the standard rate stops its return', () => {
    const rc = bank('2024-08-03', -36, 'EXAMPLE CLOUD INC', coded('software-hosting', { vat: { amount: -6, treatment: 'reverse-charge' } }));
    expect(kinds(vatOn(memory([rc]), '2024-12-15', '2024-09-30').ret!)).toEqual(['reverse-charge-rate']);
  });
});

/** The boxes of the quarter to 30 September 2024 as filed, with changes. */
const FILED: VatBoxes = { vatDueSales: 187.2, vatDueAcquisitions: 0, totalVatDue: 187.2, vatReclaimedCurrPeriod: 37.2, netVatDue: 150, totalValueSalesExVAT: 1439, totalValuePurchasesExVAT: 292, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 };

describe('a return filed, against the books', () => {
  it('matches when the filing is what the books give; filed late when after its due day', () => {
    const v = vatOn(memory(QUARTER, { company: companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-09', FILED)] }) }), '2024-12-15', '2024-09-30');
    expect(v.ret!.filed).toMatchObject({ matches: true, late: true, causes: [] });
    expect(v.ret!.period).toMatchObject({ status: 'filed-late', filed: 15_000, computed: 15_000 });
  });

  it('names a reverse charge left out: boxes 1 and 4 short by its VAT, 6 and 7 by its value, net nil', () => {
    const without = { ...FILED, vatDueSales: 180, totalVatDue: 180, vatReclaimedCurrPeriod: 30, netVatDue: 150, totalValueSalesExVAT: 1403, totalValuePurchasesExVAT: 256 };
    const v = vatOn(memory(QUARTER, { company: companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', without)] }) }), '2024-12-15', '2024-09-30');
    const f = v.ret!.filed!;
    expect(f.matches).toBe(false);
    expect(Object.fromEntries(f.boxes.filter((b) => b.difference).map((b) => [b.box, b.difference]))).toEqual({ 1: -720, 3: -720, 4: -720, 6: -36, 7: -36 });
    expect(f.causes[0]).toMatch(/reverse charge looks left out/);
    expect(v.periods.find((p) => p.end === '2024-09-30')!.differs).toBe(true);
    // Net nil: no error to correct.
    expect(v.corrections.errors).toEqual([]);
  });

  it('says when only boxes 6 and 7 differ by a pound: pence rounded, not left out', () => {
    const rounded = { ...FILED, totalValuePurchasesExVAT: 293 };
    const f = vatOn(memory(QUARTER, { company: companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', rounded)] }) }), '2024-12-15', '2024-09-30').ret!.filed!;
    expect(f.causes).toEqual([expect.stringMatching(/rounded/)]);
  });
});

describe('errors on returns filed (VAT Notice 700/45)', () => {
  // Box 1 filed £30 short.
  const short = { ...FILED, vatDueSales: 157.2, totalVatDue: 157.2, netVatDue: 120 };

  it('finds the net error by output and input tax, and what is left after a correction on a later return', () => {
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', short)] });
    const v = vatOn(memory(QUARTER, { company }), '2024-12-15');
    expect(v.corrections.errors).toEqual([expect.objectContaining({ end: '2024-09-30', error: 3_000, output: 3_000, input: 0, uncorrected: 3_000, counted: 3_000, runningTotal: 3_000, outOfTime: false, unsettled: false, outputUntil: '2028-09-30', inputUntil: '2028-09-30' })]);
    expect(v.corrections).toMatchObject({ net: 3_000, method: 'next-return', limit: 'basic', on: { end: '2024-12-31', provisional: true } });
    // Corrected on the next return: its box 1 includes it, so its filing matches the books with it.
    const q4Filed = { vatDueSales: 30, vatDueAcquisitions: 0, totalVatDue: 30, vatReclaimedCurrPeriod: 0, netVatDue: 30, totalValueSalesExVAT: 0, totalValuePurchasesExVAT: 0, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 };
    const after = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', short), filing('2024-10-01', '2024-12-31', '2025-01-20', q4Filed, { corrections: [{ periodEnd: '2024-09-30', amount: 30 }] })] });
    const w = vatOn(memory(QUARTER, { company: after }), '2025-02-15');
    expect(w.corrections.errors[0]).toMatchObject({ uncorrected: 0, correctedBy: [{ kind: 'return', periodEnd: '2024-12-31', amount: 3_000 }] });
    expect(w.corrections.method).toBe('none');
    expect(w.periods.find((p) => p.end === '2024-12-31')!.differs).toBeUndefined();
  });

  it('counts an error reported separately (method 2) as corrected', () => {
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', short, { disclosed: { on: '2024-12-01', amount: 30, reference: 'EXAMPLE-REF' } })] });
    expect(vatOn(memory(QUARTER, { company }), '2024-12-15').corrections.errors[0]).toMatchObject({ uncorrected: 0, correctedBy: [{ kind: 'separately', on: '2024-12-01' }] });
  });

  it('leaves out an error from books with checks to clear, or past 4 years', () => {
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', short)] });
    const unsettled = vatOn(memory([...QUARTER, bank('2024-08-09', -9.99, 'EXAMPLE UNKNOWN')], { company }), '2024-12-15');
    expect(unsettled.corrections.errors[0]).toMatchObject({ unsettled: true, runningTotal: 0 });
    expect(unsettled.corrections.net).toBe(0);
    const old = vatOn(memory(QUARTER, { company }), '2028-10-01');
    expect(old.corrections.errors[0]).toMatchObject({ outOfTime: true });
    expect(old.corrections.net).toBe(0);
  });

  it('applies the limits: £10,000, or £50,000 within 1% of box 6; past them, separately', () => {
    expect(vatCorrectionMethod(1_000_000, 0, '2026-01-01')).toMatchObject({ method: 'next-return', limit: 'basic' });
    expect(vatCorrectionMethod(-1_000_000, 0, '2026-01-01')).toMatchObject({ method: 'next-return', limit: 'basic' });
    expect(vatCorrectionMethod(1_000_001, 1_000_000, '2026-01-01')).toMatchObject({ method: 'separately' });
    // 1% of a box 6 of £1,000,001 is £10,000.01.
    expect(vatCorrectionMethod(1_000_001, 1_000_001, '2026-01-01')).toMatchObject({ method: 'next-return', limit: 'box6' });
    expect(vatCorrectionMethod(5_000_000, 10_000_000, '2026-01-01')).toMatchObject({ method: 'next-return', limit: 'box6' });
    expect(vatCorrectionMethod(5_000_001, 900_000_000, '2026-01-01')).toMatchObject({ method: 'separately', limit: 'over' });
  });

  it('gives 4 years from the period’s end, or from the due day for input tax under-claimed', () => {
    expect(vatCorrectionDeadline('2024-09-30', '2024-11-07', false)).toBe('2028-09-30');
    expect(vatCorrectionDeadline('2024-09-30', '2024-11-07', true)).toBe('2028-11-07');
  });

  it('refuses a correction of a period not before the return, twice over, or reported before filing', () => {
    const f = filing('2024-07-01', '2024-09-30', '2024-11-01', FILED, { corrections: [{ periodEnd: '2024-09-30', amount: 10 }, { periodEnd: '2024-06-30', amount: 5 }, { periodEnd: '2024-06-30', amount: 6 }], disclosed: { on: '2024-10-31', amount: 4 } });
    const problems = booksProblems({ ...booksOf(), filings: [f] }).join(' ');
    expect(problems).toMatch(/not before it/);
    expect(problems).toMatch(/twice/);
    expect(problems).toMatch(/before it was filed/);
  });
});

describe('penalty points (information)', () => {
  it('lists returns filed late under the regime of their period: points from 2023, the first return never', () => {
    const company = companyOf({
      incorporatedOn: '2022-01-01',
      vat: { registeredFrom: '2022-04-01', scheme: 'cash', schedule: [{ from: '2022-04-01', stagger: 'quarterly-1' }, { from: '2024-01-01', stagger: 'monthly' }] },
      filings: [filing('2022-04-01', '2022-06-30', '2022-08-20'), filing('2022-07-01', '2022-09-30', '2022-11-20'), filing('2023-01-01', '2023-03-31', '2023-05-20')],
    });
    const p = vatOn(memory([], { company }), '2024-03-20').penalties!;
    expect(p.frequency).toBe('monthly');
    expect(p.late.slice(0, 3).map((l) => [l.end, l.regime, l.excluded ?? ''])).toEqual([
      ['2022-06-30', 'surcharge', 'first'],
      ['2022-09-30', 'surcharge', ''],
      ['2022-12-31', 'surcharge', ''],
    ]);
    // Not filed and past due counts as late too.
    expect(p.late.filter((l) => l.filedOn === null).map((l) => l.end)).toEqual(['2022-12-31', '2023-06-30', '2023-09-30', '2023-12-31', '2024-01-31']);
    expect(p.late.find((l) => l.end === '2023-03-31')).toMatchObject({ regime: 'points', expires: '2025-05-31' });
    expect(p.live).toBe(5);
    expect(p.changes).toEqual([{ from: '2024-01-01', was: 'quarterly', to: 'monthly', adjustment: 1 }]);
    expect(p.rules.thresholds).toEqual({ annual: 2, quarterly: 4, monthly: 5 });
  });

  it('a point expires at the end of the month 24 months after the month it was due (25 when due on a month’s end)', () => {
    expect(vatPointExpiry('2024-05-07')).toBe('2026-05-31');
    expect(vatPointExpiry('2024-05-31')).toBe('2026-06-30');
    expect(vatPointExpiry('2024-02-29')).toBe('2026-03-31');
  });
});

describe('the registration thresholds', () => {
  it('are dated rows', () => {
    expect(vatThresholdsOn('2024-03-31')).toMatchObject({ registration: 85_000, deregistration: 83_000 });
    expect(vatThresholdsOn('2024-04-01')).toMatchObject({ registration: 90_000, deregistration: 88_000 });
    expect(vatThresholdsOn('2011-04-01')).toMatchObject({ registration: 73_000 });
  });

  it('count taxable sales, untreated sales and the reverse charge, but not exempt, outside the scope or capital assets', () => {
    const rows = [
      bank('2024-07-05', 1200, 'SALE', coded('turnover', { vat: std(200) })),
      bank('2024-07-06', 300, 'ZERO SALE', coded('turnover', { vat: vatOf('zero') })),
      bank('2024-07-07', 400, 'ABROAD', coded('turnover', { vat: vatOf('outside') })),
      bank('2024-07-08', 50, 'EXEMPT', coded('interest-receivable', { vat: vatOf('exempt') })),
      // Interest is exempt whatever a coding says.
      bank('2024-07-12', 60, 'INTEREST', coded('interest-receivable')),
      bank('2024-07-13', 80, 'SOLD ABROAD', coded('turnover', { vat: vatOf('abroad') })),
      bank('2024-07-09', 70, 'UNTREATED', coded('turnover')),
      bank('2024-07-10', 240, 'OLD LAPTOP', coded('disposals', { vat: std(40) })),
      bank('2024-07-11', -36, 'EXAMPLE CLOUD INC', coded('software-hosting', { vat: { amount: -7.2, treatment: 'reverse-charge' } })),
    ];
    const src = memory(rows);
    expect(taxableTurnover(companyLedger(src, CO).postings, new Set(), '2024-01-01', '2024-12-31')).toEqual({ sales: 130_000, untreated: 7_000, reverseCharge: 3_600, capital: 20_000 });
    const t = vatOn(src, '2024-12-15').threshold;
    expect(t).toMatchObject({ taxable: 140_600, registration: 90_000, deregistration: 88_000, registered: true, partial: true, cash: { turnover: 157_000, join: 1_350_000, leave: 1_600_000, over: false } });
    expect(t.months).toHaveLength(12);
  });
});

describe('after review', () => {
  it('records a second correction or disclosure for a period by adding to the first, never replacing it', () => {
    const once = addVatCorrection(undefined, '2024-09-30', 30);
    expect(once).toEqual([{ periodEnd: '2024-09-30', amount: 30 }]);
    const twice = addVatCorrection([...once, { periodEnd: '2024-03-31', amount: -4.5 }], '2024-09-30', 12.35);
    expect(twice).toEqual([{ periodEnd: '2024-03-31', amount: -4.5 }, { periodEnd: '2024-09-30', amount: 42.35 }]);
    // One that comes to nothing is taken away.
    expect(addVatCorrection(twice, '2024-03-31', 4.5)).toEqual([{ periodEnd: '2024-09-30', amount: 42.35 }]);
    const first = addVatDisclosure(undefined, '2024-12-01', 30, 'EXAMPLE-A');
    expect(addVatDisclosure(first, '2025-01-10', 15, '')).toEqual({ on: '2025-01-10', amount: 45, reference: 'EXAMPLE-A' });
    expect(addVatDisclosure(first, '2025-01-10', -30)).toBeUndefined();
    // Through the corrections: the two parts together correct the error.
    const short = { ...FILED, vatDueSales: 157.2, totalVatDue: 157.2, netVatDue: 120 };
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', short, { disclosed: addVatDisclosure(addVatDisclosure(undefined, '2024-12-01', 10), '2024-12-05', 20)! })] });
    expect(vatOn(memory(QUARTER, { company }), '2024-12-15').corrections.errors[0]).toMatchObject({ uncorrected: 0, correctedBy: [{ kind: 'separately', amount: 3_000 }] });
  });

  it('shows the last return of a company deregistered with everything filed', () => {
    const company = companyOf({
      vat: { registeredFrom: '2024-04-01', scheme: 'cash', schedule: [{ from: '2024-04-01', stagger: 'quarterly-1' }], deregisteredOn: '2024-09-30' },
      filings: [filing('2024-04-01', '2024-06-30', '2024-07-20'), filing('2024-07-01', '2024-09-30', '2024-10-20', FILED)],
    });
    const v = vatOn(memory(QUARTER, { company }), '2025-03-01');
    expect(v.next).toBeUndefined();
    expect(v.ret!.period).toMatchObject({ end: '2024-09-30', final: true, status: 'filed' });
    expect(v.ret!.notes.join(' ')).toContain(`£${VAT_DEREGISTRATION_ASSETS_RULES[0]!.limit.toLocaleString('en-GB')}`);
  });

  it('gives a filed net for its own period, beside the corrections its filing included', () => {
    const q4 = { vatDueSales: 30, vatDueAcquisitions: 0, totalVatDue: 30, vatReclaimedCurrPeriod: 0, netVatDue: 30, totalValueSalesExVAT: 0, totalValuePurchasesExVAT: 0, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 };
    const company = companyOf({ filings: [filing('2024-10-01', '2024-12-31', '2025-01-20', q4, { corrections: [{ periodEnd: '2024-09-30', amount: 30 }] })] });
    expect(vatOn(memory(QUARTER, { company }), '2025-02-15').periods.find((p) => p.end === '2024-12-31')).toMatchObject({ computed: 0, filed: 0, correctionsIncluded: 3_000 });
  });

  it('says a filed return with checks left is filed, in the CSV too', () => {
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', FILED)] });
    const ret = vatOn(memory([...QUARTER, bank('2024-08-09', -9.99, 'EXAMPLE UNKNOWN')], { company }), '2024-12-15', '2024-09-30').ret!;
    expect(ret.ready).toBe(false);
    const csv = vatReturnCsv(companyOf(), ret, (x) => String(x));
    expect(csv).toContain('Filed; the books have 2 checks to clear');
    expect(csv).not.toContain('Not ready to file');
  });

  it('counts a supply abroad in box 6 or 7, and outside the scope only when it is a sale read from before', () => {
    const rows = [
      bank('2024-07-05', 500, 'EXAMPLE OVERSEAS CLIENT', coded('turnover', { vat: vatOf('abroad') })),
      bank('2024-07-06', -180, 'EXAMPLE HOTEL ABROAD', coded('travel', { vat: vatOf('abroad') })),
      bank('2024-07-07', -40, 'EXAMPLE CHARITY FEE', coded('general-expenses', { vat: vatOf('outside') })),
      bank('2024-07-08', 60, 'EXAMPLE GRANT', coded('interest-receivable', { vat: vatOf('outside') })),
      bank('2024-07-09', 70, 'EXAMPLE OLD SALE ABROAD', coded('turnover', { vat: vatOf('outside') })),
    ];
    const ret = vatOn(memory(rows), '2024-12-15', '2024-09-30').ret!;
    expect(values(ret)).toMatchObject({ 6: 570, 7: 180 });
    expect(ret.leftOut.map((l) => [l.reason, l.amount])).toEqual([
      ['outside', 4_000],
      ['outside', 6_000],
    ]);
    expect(ret.notes.join(' ')).toMatch(/coded outside the scope is counted in box 6 as supplied outside the UK/);
  });

  it('takes a reverse charge on reg 82’s tax point: a journal neither paid nor invoiced at the year’s end, an invoiced one at its period’s end', () => {
    expect(reverseChargeTaxPoint('2024-10-03', true)).toBe('2024-10-03');
    expect(reverseChargeTaxPoint('2024-10-03', true, { from: '2024-09-01', to: '2024-09-30' })).toBe('2024-09-30');
    expect(reverseChargeTaxPoint('2024-10-03', true, { from: '2024-10-03', to: '2025-10-02' })).toBe('2024-10-03');
    expect(reverseChargeTaxPoint('2025-03-10', false, { from: '2024-11-01', to: '2025-02-28' })).toBe('2024-12-31');
    expect(reverseChargeTaxPoint('2025-03-10', false, { from: '2024-11-01', to: '2025-02-28' }, '2025-03-01')).toBe('2025-02-28');
    expect(reverseChargeTaxPoint('2025-03-10', false)).toBe('2025-03-10');
    const rc = (extra: Partial<Journal['lines'][number]> = {}) =>
      journal('2025-03-10', 'Design service from abroad, not yet paid', [
        { ledger: 'software-hosting', amount: 100, vat: { treatment: 'reverse-charge', side: 'input' }, covers: { from: '2024-11-01', to: '2025-02-28' }, ...extra },
        { ledger: 'vat', amount: -20, vat: { treatment: 'reverse-charge', side: 'output' } },
        { ledger: 'vat', amount: 20, vat: { treatment: 'reverse-charge', side: 'input' } },
        { ledger: 'creditors:trade', amount: -100 },
      ]);
    const yearEnd = vatOn(memory([], { journals: [rc()] }), '2025-06-15', '2024-12-31').ret!;
    expect(values(yearEnd)).toMatchObject({ 1: 2_000, 4: 2_000, 6: 100, 7: 100 });
    const invoiced = vatOn(memory([], { journals: [rc({ invoicedOn: '2025-03-01' })] }), '2025-06-15', '2025-03-31').ret!;
    expect(values(invoiced)).toMatchObject({ 1: 2_000, 4: 2_000, 6: 100, 7: 100 });
  });

  it('warns when a reverse charge paid says no period for its service', () => {
    const ret = vatOn(memory(QUARTER), '2024-12-15', '2024-09-30').ret!;
    expect(ret.notes.join(' ')).toMatch(/A reverse charge is taken on the day paid, with no period said/);
  });

  it('gives each part of an error its own 4 years: input tax under-claimed from the due day', () => {
    // Box 1 £30 short (output under-declared), box 4 £10 short (input under-claimed).
    const both = { ...FILED, vatDueSales: 157.2, totalVatDue: 157.2, vatReclaimedCurrPeriod: 27.2, netVatDue: 130 };
    const company = companyOf({ filings: [filing('2024-07-01', '2024-09-30', '2024-11-01', both)] });
    const inTime = vatOn(memory(QUARTER, { company }), '2025-02-15').corrections.errors[0]!;
    expect(inTime).toMatchObject({ error: 2_000, output: 3_000, input: -1_000, counted: 2_000, outputUntil: '2028-09-30', inputUntil: '2028-11-07' });
    // Between the two: the output part is out of time, the input part is not.
    const later = vatOn(memory(QUARTER, { company }), '2028-10-15');
    expect(later.corrections.errors[0]).toMatchObject({ outOfTime: false, counted: -1_000 });
    expect(later.corrections.net).toBe(-1_000);
  });

  it('stops returns once taxable supplies reach the cash accounting scheme’s limit for leaving', () => {
    const big = bank('2024-08-01', 1_920_000, 'EXAMPLE BIG CLIENT', coded('turnover', { vat: std(320_000) }));
    const v = vatOn(memory([big]), '2025-02-15');
    const q3 = vatOn(memory([big]), '2025-02-15', '2024-09-30').ret!;
    expect(q3.checks).toEqual([{ kind: 'cash-limit', periodEnd: '2024-09-30', turnover: 160_000_000, limit: 1_600_000 }]);
    expect(v.periods.find((p) => p.end === '2024-12-31')!.status).toBe('not-ready');
    expect(v.threshold.cash.over).toBe(true);
  });

  it('gives late payment penalties beside a return to pay, at the rates of its due day', () => {
    const sale = bank('2025-07-05', 1200, 'EXAMPLE CLIENT LTD', coded('turnover', { vat: std(200) }));
    const ret = vatOn(memory([sale]), '2025-12-15', '2025-09-30').ret!;
    expect(ret.latePayment).toEqual({ due: '2025-11-07', rates: { graceDays: 15, firstPercent: 3, secondDays: 30, secondPercent: 3, dailyFromDay: 31, yearlyPercent: 10 }, atFirst: 600, atSecond: 1_200 });
    // Due before the rates covered: shown without figures; nothing to pay: none.
    expect(vatOn(memory(QUARTER), '2024-12-15', '2024-09-30').ret!.latePayment).toMatchObject({ rates: null });
    expect(vatOn(memory([]), '2025-12-15', '2025-09-30').ret!.latePayment).toBeUndefined();
  });

  it('puts a period in the penalty points table by its length', () => {
    expect(vatFrequencyOfPeriod({ start: '2024-04-01', end: '2024-06-30' })).toBe('quarterly');
    expect(vatFrequencyOfPeriod({ start: '2024-04-01', end: '2024-04-30' })).toBe('monthly');
    // A short first period with a quarterly stagger: 5 weeks.
    expect(vatFrequencyOfPeriod({ start: '2024-05-27', end: '2024-06-30' })).toBe('monthly');
    // 20 weeks exactly is still quarterly; a day more is annual.
    expect(vatFrequencyOfPeriod({ start: '2024-01-01', end: addDays('2024-01-01', 139) })).toBe('quarterly');
    expect(vatFrequencyOfPeriod({ start: '2024-01-01', end: addDays('2024-01-01', 140) })).toBe('annual');
  });
});

describe('properties', () => {
  const treatments = ['standard', 'zero', 'exempt', 'outside', 'reverse-charge', 'none'] as const;
  const codes = ['turnover', 'software-hosting', 'office-costs', 'travel'] as const;
  const spec = fc.record({ day: fc.integer({ min: 0, max: 400 }), pence: fc.integer({ min: 7, max: 500_000 }), refund: fc.boolean(), treatment: fc.constantFrom(...treatments), code: fc.constantFrom(...codes) });
  type Spec = { day: number; pence: number; refund: boolean; treatment: (typeof treatments)[number]; code: (typeof codes)[number] };
  const build = (specs: Spec[]) =>
    specs.map((s, i) => {
      const income = s.code === 'turnover';
      const minor = (income ? 1 : -1) * (s.refund ? -1 : 1) * s.pence;
      const treatment = income && s.treatment === 'reverse-charge' ? 'standard' : s.treatment;
      const vat =
        treatment === 'none' ? undefined : treatment === 'standard' ? std(Math.round(minor / 6) / 100) : treatment === 'reverse-charge' ? { amount: Math.round(minor / 5) / 100, treatment: 'reverse-charge' as const } : vatOf(treatment);
      return bank(addDays('2024-04-01', s.day), minor / 100, `ROW ${i}`, coded(s.code, vat ? { vat } : {}));
    });

  it('box 3 is boxes 1 and 2, box 5 their difference with box 4, boxes 6 and 7 the exact values without pence', () => {
    fc.assert(
      fc.property(fc.array(spec, { maxLength: 30 }), (specs) => {
        const src = memory(build(specs));
        for (const end of vatOn(src, '2025-06-15').periods.map((p) => p.end)) {
          const b = Object.fromEntries(vatOn(src, '2025-06-15', end).ret!.boxes.map((x) => [x.key, x]));
          expect(b.totalVatDue!.value).toBe(b.vatDueSales!.value + b.vatDueAcquisitions!.value);
          expect(b.netVatDue!.value).toBe(Math.abs(b.totalVatDue!.value - b.vatReclaimedCurrPeriod!.value));
          for (const k of ['totalValueSalesExVAT', 'totalValuePurchasesExVAT'] as const) expect(b[k]!.value).toBe(poundsWithoutPence(b[k]!.exact!));
        }
      }),
      { numRuns: 30 },
    );
  });

  it('every VAT posting from registration on is in exactly one return: the returns’ net VAT is the VAT ledger’s tagged movement', () => {
    fc.assert(
      fc.property(fc.array(spec, { maxLength: 30 }), (specs) => {
        const src = memory(build(specs));
        const today = '2025-06-15';
        const tagged = companyLedger(src, CO, { until: today }).postings.filter((p) => p.ledger === 'vat' && p.vat?.part === 'tax' && p.date >= '2024-04-01' && p.date <= today);
        // Box 3 less box 4 is output less input: the credit balance of the VAT postings.
        expect(vatOn(src, today).periods.reduce((s, p) => s + (p.computed ?? 0), 0)).toBe(-tagged.reduce((s, p) => s + p.amount, 0) || 0);
      }),
      { numRuns: 30 },
    );
  });
});
