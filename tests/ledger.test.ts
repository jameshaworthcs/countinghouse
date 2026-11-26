// A company's general ledger (docs/FORMULAS.md §22, "The general ledger"): the chart, coding a payment,
// journals, links between the company's rows and yours, the postings each source makes, and the
// director's loan once the company keeps books here. Pure functions over an in-memory source, and
// properties over generated books: every source's postings add up to nothing, and the director's loan
// moves exactly as it did from your marks alone, plus what only the books know. Every name and figure is
// invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BalanceEngine, type BalanceSource } from '../src/server/analytics/balances';
import { directorLoanMovements, loanMovements } from '../src/server/analytics/director-loan';
import { autoLinks, bookRulePatches, companyLedger, ledgerDirectorLoanMovements, type LedgerSource } from '../src/server/analytics/ledger';
import { transactionId } from '../src/server/ids';
import { addDays } from '../src/shared/dates';
import {
  accountLedger,
  codingProblems,
  companyLinkProblem,
  FIXED_ASSET_CLASSES,
  journalProblems,
  LEDGER_CODES,
  ledgerCode,
  linkGroupProblem,
  linkGroups,
  linkTolerance,
  reverseChargeVat,
  ruleBooksProblems,
  ruleCoding,
  vatInGross,
} from '../src/shared/ledger';
import { fromMinor, toMinor } from '../src/shared/money';
import { SettingsSchema, type Account, type BooksCoding, type Company, type Journal, type Rule, type Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const CO = 'example-studio';
const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
const books = (extra: Partial<NonNullable<Company['books']>> = {}): NonNullable<Company['books']> => ({ incorporatedOn: '2024-03-01', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp, vat: { registeredFrom: '2024-04-01', scheme: 'cash', schedule: [{ from: '2024-04-01', stagger: 'quarterly-1' }] }, ...extra });
const company = (withBooks = true): Company => ({ id: CO, name: 'Example Studio Ltd', holdings: [], valuations: [], directorLoanAccountId: 'loan', createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...(withBooks ? { books: books() } : {}) });
const journal = (date: string, memo: string, lines: [string, number][], extra: Partial<Journal> = {}): Journal => ({ id: `jnl_${(n++).toString(16).padStart(12, '0')}`, companyId: CO, date, memo, lines: lines.map(([ledger, amount]) => ({ ledger, amount })), createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
const paidFor = { id: CO, as: 'paid-for' as const, setBy: 'user' as const };
const loanMark = { id: CO, as: 'loan' as const, setBy: 'user' as const };
const coded = (ledger: string, extra: Partial<BooksCoding> = {}): BooksCoding => ({ ledger, setBy: 'user', ...extra });

const ACCOUNTS: Account[] = [
  acct('current', 'Everyday', 'current'),
  acct('card', 'Example Card', 'credit_card'),
  acct('loan', 'Director’s loan', 'director_loan'),
  acct('studio-bank', 'Studio Account', 'current', { companyId: CO, includeInNetWorth: false }),
  acct('studio-card', 'Studio Card', 'credit_card', { companyId: CO, includeInNetWorth: false }),
];

/** An in-memory store: what the ledger and the balance engine read, with the personal-only defaults the store keeps. */
function memory(rows: Transaction[], opts: { journals?: Journal[]; rules?: Rule[]; company?: Company; accounts?: Account[] } = {}): LedgerSource & BalanceSource {
  const accounts = opts.accounts ?? ACCOUNTS;
  const companies = [opts.company ?? company()];
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const companyOf = (id: string) => accounts.find((a) => a.id === id)?.companyId;
  return {
    accounts: accounts.filter((a) => !a.companyId),
    settings: SettingsSchema.parse({}),
    companies,
    balances: () => [],
    transactions: (accountId?: string) => (accountId ? sorted.filter((t) => t.accountId === accountId) : sorted.filter((t) => !companyOf(t.accountId))),
    transaction: (id) => byId.get(id),
    account: (id) => accounts.find((a) => a.id === id),
    company: (id) => companies.find((c) => c.id === id),
    companyAccounts: (id) => accounts.filter((a) => a.companyId === id),
    companyTransactions: (id) => sorted.filter((t) => companyOf(t.accountId) === id),
    companyJournals: (id) => (opts.journals ?? []).filter((j) => j.companyId === id),
    bookRules: (id) => (opts.rules ?? []).filter((r) => !id || r.match.company?.id === id),
  };
}

/** Postings of a ledger added up by ledger code, in pence. */
const byLedger = (postings: { ledger: string; amount: number }[]) => {
  const out: Record<string, number> = {};
  for (const p of postings) out[p.ledger] = (out[p.ledger] ?? 0) + p.amount;
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
};
const ofSource = (postings: { source: { id: string }; ledger: string; amount: number }[], id: string) => byLedger(postings.filter((p) => p.source.id === id));

describe('the chart of accounts', () => {
  it('has one entry per code, each on a micro-entity line and with a Corporation Tax treatment', () => {
    const codes = LEDGER_CODES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of LEDGER_CODES) {
      if (['asset', 'liability', 'equity'].includes(c.kind)) expect(c.sheet, c.code).toBeDefined();
      else expect(c.profit, c.code).toBeDefined();
      expect(c.ct).toBeTruthy();
    }
    // The micro-entity format's lines: share capital not paid (A), fixed assets (B), prepayments (D), accruals (J), capital and reserves (K).
    expect(ledgerCode('share-capital-unpaid')?.sheet).toEqual({ debit: 'A', credit: 'A' });
    expect(ledgerCode('fixed-assets:computer:cost')?.sheet?.debit).toBe('B');
    expect(ledgerCode('prepayments')?.sheet?.debit).toBe('D');
    expect(ledgerCode('accruals')?.sheet?.credit).toBe('J');
    expect(ledgerCode('directors-loan')?.sheet).toEqual({ debit: 'C', credit: 'E' });
    expect(ledgerCode('dividends')?.sheet?.debit).toBe('K');
    expect(ledgerCode('turnover')?.profit).toBe('A');
    expect(ledgerCode('directors-salaries')?.profit).toBe('D');
    expect(ledgerCode('depreciation')?.profit).toBe('E');
    expect(ledgerCode('corporation-tax-charge')?.profit).toBe('G');
    expect(ledgerCode('entertainment')?.ct).toBe('disallowable');
    expect(ledgerCode('formation-costs')?.ct).toBe('disallowable');
    expect(ledgerCode('fixed-assets:motor:cost')?.ct).toBe('capital');
    for (const c of FIXED_ASSET_CLASSES) expect(ledgerCode(`fixed-assets:${c}:depreciation`)?.asset).toEqual({ class: c, part: 'depreciation' });
  });

  it('gives each of the company’s own accounts a ledger of its own: a bank account’s, a card’s, a loan’s', () => {
    expect(accountLedger(ACCOUNTS[3]!)).toBe('bank:studio-bank');
    expect(accountLedger(ACCOUNTS[4]!)).toBe('card:studio-card');
    expect(accountLedger(acct('studio-bbl', 'Loan', 'loan'))).toBe('loans:studio-bbl');
    expect(ledgerCode('bank:studio-bank')).toMatchObject({ kind: 'asset', account: true });
    expect(ledgerCode('card:studio-card')?.sheet).toEqual({ debit: 'C', credit: 'E' });
    expect(ledgerCode('bank')).toBeUndefined();
    expect(ledgerCode('nothing-here')).toBeUndefined();
  });
});

describe('VAT', () => {
  it('is the VAT in a gross amount at the rate of the day, and a reverse charge’s notional VAT on a net one', () => {
    expect(vatInGross(-120, '2025-05-01', 'standard')).toBe(-20);
    expect(vatInGross(240, '2025-05-01', 'standard')).toBe(40);
    expect(vatInGross(105, '2025-05-01', 'reduced')).toBe(5);
    expect(vatInGross(-99.99, '2025-05-01', 'standard')).toBe(-16.67);
    expect(reverseChargeVat(-36, '2025-05-01')).toBe(-7.2);
  });
});

describe('coding a payment', () => {
  it('takes a ledger a payment can be coded to, with VAT that fits', () => {
    expect(codingProblems(-120, coded('software-hosting', { vat: { amount: -20, treatment: 'standard' } }), 'company')).toEqual([]);
    expect(codingProblems(-36, coded('software-hosting', { vat: { amount: -7.2, treatment: 'reverse-charge' } }), 'company')).toEqual([]);
    expect(codingProblems(-50, coded('travel', { vat: { amount: 0, treatment: 'zero' } }), 'company')).toEqual([]);
    const bad = (amount: number, b: BooksCoding, side: 'company' | 'paid-for' = 'company') => codingProblems(amount, b, side).join(' ');
    expect(bad(-120, coded('software-hosting', { vat: { amount: 20, treatment: 'standard' } }))).toMatch(/signed the other way/);
    expect(bad(-12, coded('software-hosting', { vat: { amount: -20, treatment: 'standard' } }))).toMatch(/more than the amount/);
    expect(bad(-12, coded('software-hosting', { vat: { amount: -12, treatment: 'standard' } }))).toMatch(/whole amount/);
    expect(bad(-12, coded('software-hosting', { vat: { amount: 0, treatment: 'standard' } }))).toMatch(/carries VAT/);
    expect(bad(-12, coded('software-hosting', { vat: { amount: -2, treatment: 'exempt' } }))).toMatch(/carries no VAT/);
    expect(bad(-12, coded('suspense'))).toMatch(/posted by the books/);
    expect(bad(-12, coded('bank:studio-card'))).toMatch(/own accounts/);
    expect(bad(-12, coded('made-up'))).toMatch(/no ledger/);
    expect(bad(-12, coded('directors-loan'), 'paid-for')).toMatch(/moves your director’s loan already/);
    expect(bad(-12, coded('travel', { asset: { class: 'computer' } }))).toMatch(/fixed asset’s cost/);
    expect(bad(-12, coded('fixed-assets:office:cost', { asset: { class: 'computer' } }))).toMatch(/for office equipment/);
    expect(bad(-12, coded('travel', { covers: { from: '2025-02-01', to: '2025-01-01' } }))).toMatch(/ends .* before it starts/);
  });

  it('splits across lines that add up to the row', () => {
    const split = { lines: [{ ledger: 'vat', amount: 80 }, { ledger: 'interest-receivable', amount: 3.21 }] };
    expect(codingProblems(83.21, split, 'company')).toEqual([]);
    expect(codingProblems(83.2, split, 'company').join(' ')).toMatch(/add up to £83\.21, not £83\.20/);
    expect(codingProblems(83.21, { ...split, ledger: 'vat' }, 'company').join(' ')).toMatch(/on the lines/);
    expect(codingProblems(83.21, { lines: [split.lines[0]!] }, 'company').join(' ')).toMatch(/two lines or more/);
  });
});

describe('journals', () => {
  it('add up to nothing, on codes of the chart, never the books’ own clearing codes', () => {
    const own = (id: string) => id === 'studio-bank';
    expect(journalProblems(journal('2024-03-01', 'Shares issued', [['share-capital-unpaid', 100], ['share-capital', -100]]), own)).toEqual([]);
    expect(journalProblems(journal('2024-03-01', 'Off', [['share-capital-unpaid', 100], ['share-capital', -99.99]]), own).join(' ')).toMatch(/add up to £0\.01/);
    expect(journalProblems(journal('2024-03-01', 'One', [['share-capital', 0]]), own).join(' ')).toMatch(/two lines or more/);
    expect(journalProblems(journal('2024-03-01', 'Clear', [['suspense', 5], ['travel', -5]]), own).join(' ')).toMatch(/the books’ own/);
    expect(journalProblems(journal('2024-03-01', 'Other', [['bank:someone-else', 5], ['travel', -5]]), own).join(' ')).toMatch(/not one of the company’s own accounts/);
    expect(journalProblems(journal('2024-03-01', 'Opening', [['bank:studio-bank', 5], ['retained-earnings', -5]]), own)).toEqual([]);
  });
});

describe('links between the company’s rows and yours', () => {
  const p = (amount: number, date = '2025-05-10') => ({ id: `p${amount}${date}`, date, amount });
  const c = (amount: number, date = '2025-05-11') => ({ id: `c${amount}${date}`, date, amount });

  it('allows a fee taken on the way, within 3% of your side, at least £1 and at most £25', () => {
    expect(linkTolerance(-1000_00)).toBe(25_00);
    expect(linkTolerance(-300_00)).toBe(9_00);
    expect(linkTolerance(-10_00)).toBe(1_00);
    expect(linkGroupProblem([p(-300)], [c(300)])).toBeUndefined();
    expect(linkGroupProblem([p(-300)], [c(291)])).toBeUndefined();
    expect(linkGroupProblem([p(-300)], [c(290.99)])).toMatch(/differ by £9\.01/);
    expect(linkGroupProblem([p(-300)], [c(300.01)])).toMatch(/More arrived/);
    // Repaid: the company sends more than arrives with you.
    expect(linkGroupProblem([p(295)], [c(-300)])).toBeUndefined();
    expect(linkGroupProblem([p(300)], [c(-295)])).toMatch(/More arrived/);
  });

  it('is one to many or many to one, opposite ways, within a month', () => {
    expect(linkGroupProblem([p(-100, '2025-05-01'), p(-100, '2025-05-02'), p(-100, '2025-05-03')], [c(297, '2025-05-06')])).toBeUndefined();
    expect(linkGroupProblem([p(-300)], [c(100), c(200, '2025-05-12')])).toBeUndefined();
    expect(linkGroupProblem([p(-100), p(-200, '2025-05-12')], [c(100), c(200, '2025-05-13')])).toMatch(/one to many, or many to one/);
    expect(linkGroupProblem([p(-300)], [c(-300)])).toMatch(/opposite ways/);
    expect(linkGroupProblem([p(-300, '2025-05-01')], [c(300, '2025-06-15')])).toMatch(/45 days apart/);
  });

  it('joins company rows naming one row of yours into one group', () => {
    const rows = [
      { id: 'tx_b', companyLink: { rows: ['tx_p1'], setBy: 'user' as const } },
      { id: 'tx_a', companyLink: { rows: ['tx_p1'], setBy: 'user' as const } },
      { id: 'tx_c', companyLink: { rows: ['tx_p2', 'tx_p3'], setBy: 'auto' as const } },
      { id: 'tx_d', companyLink: { rows: [], setBy: 'user' as const } },
      { id: 'tx_e' },
    ];
    expect(linkGroups(rows)).toEqual([
      { companyIds: ['tx_a', 'tx_b'], personalIds: ['tx_p1'] },
      { companyIds: ['tx_c'], personalIds: ['tx_p2', 'tx_p3'] },
    ]);
  });

  it('links on its own only exact, unique matches within 4 days', () => {
    const lent = tx('current', '2025-05-10', -500, 'TO STUDIO', { company: loanMark });
    const arrived = tx('studio-bank', '2025-05-12', 500, 'FROM J BLOGGS');
    const far = tx('studio-bank', '2025-05-20', 500, 'FROM J BLOGGS');
    expect([...autoLinks(memory([lent, arrived, far]), CO)]).toEqual([[arrived.id, lent.id]]);
    // Two the same: neither is linked.
    const twin = tx('studio-bank', '2025-05-11', 500, 'FROM J BLOGGS');
    expect(autoLinks(memory([lent, arrived, twin]), CO).size).toBe(0);
    // Coded to something else, or one you linked by hand: not a candidate.
    expect(autoLinks(memory([lent, { ...arrived, books: coded('turnover') }]), CO).size).toBe(0);
    expect(autoLinks(memory([lent, { ...arrived, companyLink: { rows: [], setBy: 'user' } }]), CO).size).toBe(0);
    expect(autoLinks(memory([lent, { ...arrived, books: coded('directors-loan') }]), CO).size).toBe(1);
  });

  it('fits only between one company’s rows and loans of yours with that company', () => {
    const lent = tx('current', '2025-05-10', -500, 'TO STUDIO', { company: loanMark });
    const paid = tx('current', '2025-05-10', -500, 'TO STUDIO', { company: paidFor });
    const arrived = tx('studio-bank', '2025-05-12', 500, 'FROM J BLOGGS', { companyLink: { rows: [lent.id], setBy: 'user' } });
    const src = memory([lent, paid, arrived]);
    expect(companyLinkProblem({ companyIds: [arrived.id], personalIds: [lent.id] }, (id) => src.transaction(id), src)).toBeUndefined();
    expect(companyLinkProblem({ companyIds: [arrived.id], personalIds: [paid.id] }, (id) => src.transaction(id), src)).toMatch(/not marked as a loan/);
    const codedSales = { ...arrived, books: coded('turnover') };
    expect(companyLinkProblem({ companyIds: [arrived.id], personalIds: [lent.id] }, (id) => (id === arrived.id ? codedSales : src.transaction(id)), src)).toMatch(/other than the director’s loan/);
  });
});

describe('the postings', () => {
  const sale = tx('studio-bank', '2025-05-02', 1200, 'EXAMPLE CLIENT LTD', { books: coded('turnover', { vat: { amount: 200, treatment: 'standard' } }) });
  const hosting = tx('studio-card', '2025-05-03', -36, 'EXAMPLE CLOUD INC', { books: coded('software-hosting', { vat: { amount: -7.2, treatment: 'reverse-charge' } }) });
  const laptop = tx('studio-bank', '2025-05-04', -1440, 'EXAMPLE COMPUTERS', { books: coded('fixed-assets:computer:cost', { vat: { amount: -240, treatment: 'standard' }, asset: { class: 'computer', months: 36 } }) });
  const repayment = tx('studio-bank', '2025-05-05', 83.21, 'HMRC VAT REPAYMENT', { books: { lines: [{ ledger: 'vat', amount: 80 }, { ledger: 'interest-receivable', amount: 3.21 }], setBy: 'user' } });
  const uncoded = tx('studio-bank', '2025-05-06', -12.5, 'SOMETHING');
  const cardPaid = tx('studio-bank', '2025-05-07', -250, 'PAYMENT TO STUDIO CARD', { transferGroup: 'tg_one', counterpartyAccountId: 'studio-card' });
  const cardIn = tx('studio-card', '2025-05-08', 250, 'PAYMENT RECEIVED', { transferGroup: 'tg_one', counterpartyAccountId: 'studio-bank' });
  const domain = tx('card', '2025-05-09', -24, 'EXAMPLE DOMAINS', { company: paidFor, books: coded('software-hosting', { vat: { amount: -4, treatment: 'standard' }, covers: { from: '2025-05-09', to: '2026-05-08' } }) });
  const lent = tx('current', '2025-05-10', -500, 'TO STUDIO ACCOUNT', { company: loanMark });
  const arrived = tx('studio-bank', '2025-05-11', 491, 'FROM J BLOGGS VIA EXAMPLE PAY', { companyLink: { rows: [lent.id], setBy: 'user' } });
  const lentAgain = tx('current', '2025-05-12', -300, 'TO STUDIO ACCOUNT', { company: loanMark });
  const shares = journal('2024-03-01', 'Shares issued at incorporation', [['share-capital-unpaid', 100], ['share-capital', -100]]);
  const pay = journal('2025-05-31', 'May salary', [['directors-salaries', 1048], ['paye', -48], ['directors-loan', -1000]]);
  const rows = [sale, hosting, laptop, repayment, uncoded, cardPaid, cardIn, domain, lent, arrived, lentAgain];
  const src = memory(rows, { journals: [shares, pay] });
  const { postings, checks } = companyLedger(src, CO);

  it('posts each coded company row against its own account: net to its ledger, VAT to VAT', () => {
    expect(ofSource(postings, sale.id)).toEqual({ 'bank:studio-bank': 120000, turnover: -100000, vat: -20000 });
    expect(ofSource(postings, laptop.id)).toEqual({ 'bank:studio-bank': -144000, 'fixed-assets:computer:cost': 120000, vat: 24000 });
    expect(postings.find((p) => p.source.id === laptop.id && p.ledger.startsWith('fixed'))?.asset).toEqual({ class: 'computer', months: 36 });
    expect(ofSource(postings, repayment.id)).toEqual({ 'bank:studio-bank': 8321, vat: -8000, 'interest-receivable': -321 });
    expect(postings.filter((p) => p.source.id === repayment.id && p.source.line !== undefined).map((p) => p.source.line)).toEqual([0, 1]);
  });

  it('posts a reverse charge’s notional VAT both ways, so it nets to nothing', () => {
    const vat = postings.filter((p) => p.source.id === hosting.id && p.ledger === 'vat');
    expect(vat.map((p) => [p.amount, p.vat?.side])).toEqual([
      [-720, 'output'],
      [720, 'input'],
    ]);
    expect(ofSource(postings, hosting.id)).toEqual({ 'card:studio-card': -3600, 'software-hosting': 3600 });
  });

  it('posts an uncoded row to suspense, and asks for it to be coded', () => {
    expect(ofSource(postings, uncoded.id)).toEqual({ 'bank:studio-bank': -1250, suspense: 1250 });
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'uncoded', transactionId: uncoded.id, side: 'company' }));
  });

  it('posts a transfer between the company’s own accounts once, bank against card, with no coding', () => {
    expect(ofSource(postings, 'tg_one')).toEqual({ 'bank:studio-bank': -25000, 'card:studio-card': 25000 });
    expect(postings.some((p) => p.source.id === cardPaid.id || p.source.id === cardIn.id)).toBe(false);
  });

  it('posts a row of yours paid for the company as its cost, against your director’s loan', () => {
    expect(ofSource(postings, domain.id)).toEqual({ 'directors-loan': -2400, 'software-hosting': 2000, vat: 400 });
    expect(postings.find((p) => p.source.id === domain.id && p.ledger === 'software-hosting')?.covers).toEqual({ from: '2025-05-09', to: '2026-05-08' });
  });

  it('posts a linked loan through the company’s row, the fee taken on the way as its bank charge', () => {
    expect(ofSource(postings, arrived.id)).toEqual({ 'bank:studio-bank': 49100, 'directors-loan': -49100 });
    expect(ofSource(postings, lent.id)).toEqual({ 'bank-charges': 900, 'directors-loan': -900 });
    expect(postings.find((p) => p.source.id === lent.id)?.source.kind).toBe('link');
  });

  it('posts a loan with no company row against the company’s bank not imported, and says so', () => {
    expect(ofSource(postings, lentAgain.id)).toEqual({ 'directors-loan': -30000, 'bank-not-imported': 30000 });
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'bank-not-imported', transactionId: lentAgain.id }));
  });

  it('posts journals as written', () => {
    expect(ofSource(postings, shares.id)).toEqual({ 'share-capital-unpaid': 10000, 'share-capital': -10000 });
    expect(ofSource(postings, pay.id)).toEqual({ 'directors-salaries': 104800, paye: -4800, 'directors-loan': -100000 });
  });

  it('balances every source, and nothing is unbalanced', () => {
    const sums = new Map<string, number>();
    for (const p of postings) sums.set(`${p.source.kind}:${p.source.id}`, (sums.get(`${p.source.kind}:${p.source.id}`) ?? 0) + p.amount);
    expect([...sums.values()].every((v) => v === 0)).toBe(true);
    expect(checks.some((c) => c.kind === 'unbalanced')).toBe(false);
    expect(new Set(postings.map((p) => p.id)).size).toBe(postings.length);
  });

  it('moves your director’s loan by its postings, negated to your side: your marks, plus the journal', () => {
    const movements = ledgerDirectorLoanMovements(src, CO);
    const marks = directorLoanMovements(src, CO);
    const total = (list: { amount: number }[]) => fromMinor(list.reduce((s, m) => s + toMinor(m.amount), 0));
    expect(total(marks)).toBe(24 + 500 + 300);
    expect(total(movements)).toBe(24 + 500 + 300 + 1000);
    expect(movements.find((m) => m.source === 'journal')).toMatchObject({ journalId: pay.id, amount: 1000, kind: 'journal' });
    expect(movements.find((m) => m.transactionId === arrived.id)).toMatchObject({ source: 'company-row', amount: 491, kind: 'lent' });
    expect(movements.find((m) => m.source === 'link-fee')).toMatchObject({ amount: 9, kind: 'fee' });
    // A row of yours not linked keeps its mark's id and kind.
    expect(movements.find((m) => m.transactionId === lentAgain.id)).toEqual(marks.find((m) => m.transactionId === lentAgain.id));
    expect(loanMovements(src, company(false))).toEqual(marks);
  });

  it('flags a loan of yours and a company row coded to the loan the same amount within 10 days', () => {
    const twice = tx('studio-bank', '2025-05-16', 300, 'FROM J BLOGGS', { books: coded('directors-loan') });
    const res = companyLedger(memory([...rows, twice], { journals: [shares, pay] }), CO);
    expect(res.checks).toContainEqual(expect.objectContaining({ kind: 'possible-double-count', personalId: lentAgain.id, companyRowId: twice.id }));
  });

  it('says what does not fit, and leaves it out: a coding, a link, a journal; VAT before registration', () => {
    const badCoding = tx('studio-bank', '2025-05-20', -10, 'BAD', { books: coded('nothing-like-it') });
    const early = tx('studio-bank', '2024-03-20', -12, 'EARLY', { books: coded('office-costs', { vat: { amount: -2, treatment: 'standard' } }) });
    const badJournal = journal('2025-05-21', 'Off by a penny', [['travel', 1], ['bank:studio-bank', -0.99]]);
    const badLink = tx('studio-bank', '2025-05-22', 900, 'FROM J BLOGGS', { companyLink: { rows: [domain.id], setBy: 'user' } });
    const res = companyLedger(memory([...rows, badCoding, early, badLink], { journals: [shares, pay, badJournal] }), CO);
    expect(res.checks).toContainEqual(expect.objectContaining({ kind: 'coding-invalid', transactionId: badCoding.id }));
    expect(ofSource(res.postings, badCoding.id)).toEqual({ 'bank:studio-bank': -1000, suspense: 1000 });
    expect(res.checks).toContainEqual(expect.objectContaining({ kind: 'journal-invalid', journalId: badJournal.id }));
    expect(res.postings.some((p) => p.source.id === badJournal.id)).toBe(false);
    expect(res.checks).toContainEqual(expect.objectContaining({ kind: 'link-invalid', companyRowIds: [badLink.id] }));
    expect(res.checks).toContainEqual(expect.objectContaining({ kind: 'vat-unregistered', date: early.date }));
  });
});

describe('book rules', () => {
  const rule = (extra: Partial<Rule['match']> = {}, set: Partial<NonNullable<Rule['set']['books']>> = {}, created = stamp): Rule => ({ id: `rule_${(n++).toString(36)}`, enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE CLOUD', caseSensitive: false, company: { id: CO, rows: 'own' }, ...extra }, set: { books: { ledger: 'software-hosting', ...set } }, createdAt: created, updatedAt: created });

  it('set nothing of yours, and name their company', () => {
    expect(ruleBooksProblems(rule())).toEqual([]);
    expect(ruleBooksProblems({ ...rule(), set: { category: 'software', books: { ledger: 'software-hosting' } } }).join(' ')).toMatch(/no category/);
    expect(ruleBooksProblems({ ...rule(), match: { ...rule().match, company: undefined } }).join(' ')).toMatch(/names the company/);
    expect(ruleBooksProblems(rule({ company: { id: CO, rows: 'paid-for' } }, { ledger: 'directors-loan' })).join(' ')).toMatch(/moves your director’s loan already/);
  });

  it('code what they match with the VAT of the day and the months it covers', () => {
    const r = rule({}, { vat: { treatment: 'standard' }, coversMonths: 12 });
    expect(ruleCoding(r, { amount: -120, date: '2025-02-28' })).toEqual({ ledger: 'software-hosting', vat: { amount: -20, treatment: 'standard' }, covers: { from: '2025-02-28', to: '2026-02-27' }, setBy: 'rule', ruleId: r.id });
    expect(ruleCoding(rule({}, { vat: { treatment: 'reverse-charge' } }), { amount: -36, date: '2025-02-28' })?.vat).toEqual({ amount: -7.2, treatment: 'reverse-charge' });
  });

  it('code the rows in their scope, never one you coded or linked, and take away what they no longer match', () => {
    const own = tx('studio-card', '2025-05-03', -36, 'EXAMPLE CLOUD INC');
    const yours = tx('studio-card', '2025-05-04', -36, 'EXAMPLE CLOUD INC', { books: coded('general-expenses') });
    const paid = tx('card', '2025-05-05', -36, 'EXAMPLE CLOUD INC', { company: paidFor });
    const stale = tx('studio-card', '2025-05-06', -5, 'OTHER', { books: { ledger: 'travel', setBy: 'rule', ruleId: 'rule_gone' } });
    const r = rule({}, { vat: { treatment: 'reverse-charge' } });
    const patches = bookRulePatches(memory([own, yours, paid, stale], { rules: [r] }), CO);
    expect(patches.map((p) => p.id).sort()).toEqual([own.id, stale.id].sort());
    expect(patches.find((p) => p.id === stale.id)?.patch).toEqual({ books: undefined });
    // Both scopes, the earliest rule first at the same priority.
    const both = rule({ company: { id: CO, rows: 'both' } }, { ledger: 'office-costs' }, '2025-01-01T00:00:00+00:00');
    expect(bookRulePatches(memory([own, paid], { rules: [r, both] }), CO).map((p) => p.patch.books?.ledger)).toEqual(['office-costs', 'office-costs']);
  });
});

// ─── Properties over generated books ─────────────────────────────────────────────────────────────

const START = '2025-04-06';
const CODABLE = LEDGER_CODES.filter((c) => c.codable && c.code !== 'directors-loan' && !c.asset).map((c) => c.code);
const JOURNAL_CODES = ['share-capital', 'share-capital-unpaid', 'directors-salaries', 'paye', 'dividends', 'directors-loan', 'corporation-tax', 'corporation-tax-charge', 'accruals', 'prepayments', 'bank:studio-bank'];

interface World {
  loans: { day: number; pence: number; out: boolean; shape: 'exact' | 'fee' | 'split' | 'many' | 'none'; parts: number; fee: number; lag: number }[];
  paid: { day: number; pence: number; code: number; vat: boolean; coded: boolean }[];
  own: { day: number; pence: number; out: boolean; code: number; vat: boolean; coded: boolean }[];
  dlRows: { day: number; pence: number; out: boolean }[];
  transfers: { day: number; pence: number }[];
  journals: { day: number; lines: { code: number; pence: number }[] }[];
}

const world: fc.Arbitrary<World> = fc.record({
  loans: fc.array(fc.record({ day: fc.nat(300), pence: fc.integer({ min: 500, max: 900_000 }), out: fc.boolean(), shape: fc.constantFrom('exact', 'fee', 'split', 'many', 'none'), parts: fc.integer({ min: 2, max: 4 }), fee: fc.nat(100), lag: fc.integer({ min: 0, max: 4 }) }), { maxLength: 12 }),
  paid: fc.array(fc.record({ day: fc.nat(300), pence: fc.integer({ min: 100, max: 200_000 }), code: fc.nat(CODABLE.length - 1), vat: fc.boolean(), coded: fc.boolean() }), { maxLength: 10 }),
  own: fc.array(fc.record({ day: fc.nat(300), pence: fc.integer({ min: 100, max: 500_000 }), out: fc.boolean(), code: fc.nat(CODABLE.length - 1), vat: fc.boolean(), coded: fc.boolean() }), { maxLength: 15 }),
  dlRows: fc.array(fc.record({ day: fc.nat(300), pence: fc.integer({ min: 1_000_001, max: 2_000_000 }), out: fc.boolean() }), { maxLength: 3 }),
  transfers: fc.array(fc.record({ day: fc.nat(300), pence: fc.integer({ min: 100, max: 300_000 }) }), { maxLength: 4 }),
  journals: fc.array(fc.record({ day: fc.nat(300), lines: fc.array(fc.record({ code: fc.nat(JOURNAL_CODES.length - 1), pence: fc.integer({ min: -500_000, max: 500_000 }).filter((v) => v !== 0) }), { minLength: 1, maxLength: 4 }) }), { maxLength: 5 }),
});

/** A company's books from a world: the rows, and what only the books add to the director's loan (`extras`, by day, your side, pence). */
function build(w: World): { rows: Transaction[]; journals: Journal[]; extras: { date: string; minor: number }[]; windows: { from: string; to: string }[] } {
  const rows: Transaction[] = [];
  const journals: Journal[] = [];
  const extras: { date: string; minor: number }[] = [];
  const windows: { from: string; to: string }[] = [];
  const day = (d: number) => addDays(START, d);
  for (const l of w.loans) {
    const sign = l.out ? -1 : 1;
    const total = l.pence;
    // Your side and the company's: as they are linked, with a fee taken on the way within the tolerance.
    const fee = l.shape === 'fee' || l.shape === 'split' || l.shape === 'many' ? Math.min(l.fee, linkTolerance(total)) : 0;
    const parts = (whole: number, k: number) => Array.from({ length: k }, (_, i) => Math.floor(whole / k) + (i < whole % k ? 1 : 0));
    // What was sent, and what arrived: lent, you sent it and the company's account received it; repaid, the other way.
    const [yourSide, theirSide] = l.out ? [total, total - fee] : [total - fee, total];
    const personalParts = l.shape === 'many' ? parts(yourSide, l.parts) : [yourSide];
    const personal = personalParts.map((pp, i) => tx('current', day(l.day + i), fromMinor(sign * pp), 'TO STUDIO ACCOUNT', { company: loanMark }));
    rows.push(...personal);
    if (l.shape === 'none') continue;
    const companyParts = l.shape === 'split' ? parts(theirSide, l.parts) : [theirSide];
    const companyRows = companyParts.map((cp, i) => tx('studio-bank', day(l.day + l.lag + i), fromMinor(-sign * cp), 'J BLOGGS LOAN'));
    // Linked: one company row naming every row of yours, or each company row naming your one.
    const dates = [...personal, ...companyRows].map((t) => t.date).sort();
    windows.push({ from: dates[0]!, to: dates.at(-1)! });
    for (const c of companyRows) rows.push({ ...c, ...(l.shape === 'exact' && l.fee % 2 === 0 ? { books: coded('directors-loan') } : {}), companyLink: { rows: personal.map((p) => p.id), setBy: 'user' } });
  }
  for (const p of w.paid) {
    const amount = fromMinor(-p.pence);
    const code = CODABLE[p.code]!;
    const vat = p.vat ? vatInGross(amount, day(p.day), 'standard') : 0;
    const vatOk = vat !== 0 && Math.abs(toMinor(vat)) < p.pence;
    rows.push(tx('card', day(p.day), amount, 'EXAMPLE SUPPLIER', { company: paidFor, ...(p.coded ? { books: coded(code, vatOk ? { vat: { amount: vat, treatment: 'standard' } } : {}) } : {}) }));
  }
  for (const o of w.own) {
    const amount = fromMinor((o.out ? -1 : 1) * o.pence);
    const vat = o.vat ? vatInGross(amount, day(o.day), 'standard') : 0;
    const vatOk = vat !== 0 && Math.abs(toMinor(vat)) < o.pence;
    rows.push(tx(o.out ? 'studio-card' : 'studio-bank', day(o.day), amount, 'EXAMPLE TRADE', o.coded ? { books: coded(CODABLE[o.code]!, vatOk ? { vat: { amount: vat, treatment: 'standard' } } : {}) } : {}));
  }
  for (const d of w.dlRows) {
    const amount = fromMinor((d.out ? -1 : 1) * d.pence);
    rows.push(tx('studio-bank', day(d.day), amount, 'J BLOGGS', { books: coded('directors-loan') }));
    extras.push({ date: day(d.day), minor: toMinor(amount) });
  }
  for (const [i, t] of w.transfers.entries()) {
    const group = `tg_${i.toString(16).padStart(16, '0')}`;
    rows.push(tx('studio-bank', day(t.day), fromMinor(-t.pence), 'TO CARD', { transferGroup: group, counterpartyAccountId: 'studio-card' }));
    rows.push(tx('studio-card', day(t.day + 1), fromMinor(t.pence), 'FROM BANK', { transferGroup: group, counterpartyAccountId: 'studio-bank' }));
  }
  for (const j of w.journals) {
    const lines: [string, number][] = j.lines.map((l) => [JOURNAL_CODES[l.code]!, fromMinor(l.pence)]);
    const sum = j.lines.reduce((s, l) => s + l.pence, 0);
    lines.push(['retained-earnings', fromMinor(-sum || -1)]);
    if (!sum) lines.push(['retained-earnings', 0.01]);
    journals.push(journal(day(j.day), 'A journal', lines.filter(([, a]) => a !== 0)));
    for (const [ledger, amount] of lines) if (ledger === 'directors-loan') extras.push({ date: day(j.day), minor: -toMinor(amount) });
  }
  return { rows, journals, extras, windows };
}

describe('properties of the ledger', () => {
  it('every source’s postings add up to nothing, and so does the whole ledger', () => {
    fc.assert(
      fc.property(world, (w) => {
        const { rows, journals } = build(w);
        const { postings, checks } = companyLedger(memory(rows, { journals }), CO);
        const sums = new Map<string, number>();
        for (const p of postings) {
          expect(Number.isInteger(p.amount)).toBe(true);
          sums.set(`${p.source.kind}:${p.source.id}`, (sums.get(`${p.source.kind}:${p.source.id}`) ?? 0) + p.amount);
        }
        expect([...sums.values()].filter((v) => v !== 0)).toEqual([]);
        expect(checks.filter((c) => c.kind === 'unbalanced' || c.kind === 'link-invalid' || c.kind === 'journal-invalid' || c.kind === 'coding-invalid')).toEqual([]);
        expect(postings.reduce((s, p) => s + p.amount, 0)).toBe(0);
      }),
      { seed: 20261126, numRuns: 200 },
    );
  });

  // A linked loan moves the loan on the company row's day (the books' side), so between your row and the
  // company's (at most a link's span apart) the two can differ: on every other day they agree.
  it('the director’s loan from the books is the loan from your marks, plus what only the books know, on every day outside a link’s span', () => {
    fc.assert(
      fc.property(world, (w) => {
        const { rows, journals, extras, windows } = build(w);
        const withBooks = memory(rows, { journals });
        const without = memory(rows, { journals, company: company(false) });
        const [eBooks, eMarks] = [new BalanceEngine(withBooks), new BalanceEngine(without)];
        for (let d = -1; d <= 320; d++) {
          const date = addDays(START, d);
          if (windows.some((x) => x.from <= date && date < x.to)) continue;
          const extra = extras.filter((e) => e.date <= date).reduce((s, e) => s + e.minor, 0);
          const a = toMinor(eBooks.balanceOn('loan', date)?.value ?? 0);
          const b = toMinor(eMarks.balanceOn('loan', date)?.value ?? 0);
          expect(a - b).toBe(extra);
        }
      }),
      { seed: 20261127, numRuns: 120 },
    );
  });
});
