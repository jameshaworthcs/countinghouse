// The general ledger of a company whose books are kept here (docs/FORMULAS.md §22, "The general ledger").
//
// Its postings are worked out from records, never stored: each money movement of the company's own
// accounts, each row of yours paid for it or lent to it, and each journal, as two sides or more that add
// up to nothing, in integer pence, debits positive. Pure and deterministic: the same records give the
// same postings, in the same order, with the same ids.
//
// This is company data: it reads the company's own accounts' rows and journals (ESLint's allowlist,
// eslint.config.js), and is served only from the company's own routes. The one way it reaches anything
// of yours is by design: once the company keeps books here, your director's loan's movements are its
// postings to the director's loan (director-loan.ts, `loanMovements`), and nothing else.

import type { BooksRowView, CompanyCodingResponse, CompanyLedgerResponse, DirectorLoanMovement, FixedAsset, LedgerCheck, LedgerPosting, LinkSuggestion, LinkView } from '../../shared/api';
import { directorLoanKind, markCounts, movesDirectorLoan, type MarkContext } from '../../shared/company';
import { accountingPeriodsOf, type BooksPeriod } from '../../shared/company-books';
import { addDays, addMonths, diffDays, formatDate, startOfMonth, type ISODate } from '../../shared/dates';
import { CategoryIndex } from '../../shared/categories';
import { Categoriser } from '../../shared/categorise';
import { accountLedger, AUTO_LINK_DAYS, codingLines, codingPlace, codingProblems, companyLinkProblem, DOUBLE_COUNT_DAYS, isLinked, journalProblems, ledgerCode, linkableCoding, linkFeeMinor, linkGroups, linkTolerance, reg111Problem, REVERSE_CHARGE_TOLERANCE_MINOR, reverseChargeVat, ruleBooksProblems, ruleCoding, type LinkGroup } from '../../shared/ledger';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import { carriedAt, costOn, coverParts, depreciationTo } from '../../shared/period-end';
import type { Account, BalanceSnapshot, BooksCoding, BooksLine, Company, CompanyBooks, Journal, Rule, Transaction } from '../../shared/schema';
import { ruleCatches } from '../categoriser';

/** What the ledger reads: any record by id, your rows, and one company's own accounts, rows and journals. */
export interface LedgerSource extends MarkContext {
  company(id: string | undefined): Company | undefined;
  transaction(id: string): Transaction | undefined;
  /** Your rows (the store's own accessor: never a company's). */
  transactions(accountId?: string): Transaction[];
  companyAccounts(companyId: string): Account[];
  companyTransactions(companyId: string): Transaction[];
  companyJournals(companyId: string): Journal[];
  bookRules(companyId?: string): Rule[];
  /** The balances recorded on an account (your director's loan's, checked against the books). */
  balances(accountId: string): BalanceSnapshot[];
}

/** Whether a balance engine's source can give a company's books (the store can; a test's plain object cannot). */
export function isLedgerSource(s: object): s is LedgerSource {
  const x = s as Partial<LedgerSource>;
  return typeof x.companyTransactions === 'function' && typeof x.companyJournals === 'function' && typeof x.companyAccounts === 'function' && typeof x.transaction === 'function';
}

export interface Ledger {
  postings: LedgerPosting[];
  checks: LedgerCheck[];
  /** The link groups that fit, and those that do not (with why). */
  links: { group: LinkGroup; problem?: string }[];
  /** The fixed asset register (FORMULAS.md §22, "Depreciation"). */
  assets: FixedAsset[];
  /** The accounting periods its period-end postings were worked out for: up to the one holding its last posting, a cover's last day, or a disposal. */
  periods: BooksPeriod[];
}

const brief = (t: Transaction) => t.payee ?? t.description;

/**
 * A company's general ledger (FORMULAS.md §22): every posting, in source order (its own accounts' rows
 * by date, then the transfers between them, rows of yours, link fees and journals), and its checks.
 *
 * - A company account's row posts its amount to its account's own ledger (`bank:<id>`, `card:<id>`,
 *   `loans:<id>`), and the opposite to what it means: a row linked to loans of yours to the director's
 *   loan; a coded row, each line's amount less its VAT to the line's ledger and its VAT to `vat` (a
 *   reverse charge posts the line in full, and its notional VAT both ways on `vat`); an uncoded row (or
 *   one whose coding does not fit) to `suspense`.
 * - The two legs of a transfer between the company's own accounts post each to its own account's
 *   ledger, together as one source (`transfer`); a leg whose other leg is not there posts to `suspense`.
 * - A row of yours paid for the company posts its cost as a coded company row would (uncoded: to
 *   `suspense`), against the director's loan in place of a bank: amount m (yours, signed from your side)
 *   posts m to `directors-loan` (a cost you paid, m < 0, is a credit: the company owes you more).
 * - A row of yours marked as a loan, linked to company rows, posts nothing itself (the company rows post
 *   it), but the fee its two sides differ by: d to `bank-charges`, −d to `directors-loan`, so the loan
 *   moves by your own side. Not linked: m to `directors-loan` and −m to `bank-not-imported` (the
 *   company's bank side is not in its imported accounts).
 * - A journal posts its lines as written. One that does not fit posts nothing, and is a check.
 * - At each accounting period's end (`periodEnd`): each fixed asset's depreciation, its disposal, and
 *   the parts of postings with `covers` that belong to other periods, for every period up to the one
 *   holding its last posting (or `until`, when later: today, for the reports).
 */
export function companyLedger(src: LedgerSource, companyId: string, opts: { until?: ISODate } = {}): Ledger {
  const company = src.company(companyId);
  const own = src.companyAccounts(companyId);
  const ownIds = new Set(own.map((a) => a.id));
  const books = company?.books;
  const rows = src.companyTransactions(companyId);
  const postings: LedgerPosting[] = [];
  const checks: LedgerCheck[] = [];
  const counters = new Map<string, number>();
  // Before the ledger's first day (books taken over mid-life) nothing posts but opening journals.
  const before = (date: ISODate) => Boolean(books?.ledgerFrom && date < books.ledgerFrom);
  // A source dated before incorporation is taken in on incorporation (CA 2006 s51: the promoter's until
  // the company adopts it), its own day kept in its memo.
  const day = (date: ISODate) => (books && date < books.incorporatedOn ? books.incorporatedOn : date);
  const memoOf = (memo: string, date: ISODate) => (books && date < books.incorporatedOn ? `${memo} (${formatDate(date)}, before incorporation: taken in on incorporation)` : memo);
  const post = (source: LedgerPosting['source'], date: ISODate, ledger: string, minor: number, memo: string, extra: Pick<LedgerPosting, 'vat' | 'covers' | 'asset' | 'reduces' | 'invoicedOn'> = {}) => {
    if (!minor) return;
    const key = `${source.kind}:${source.id}`;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    postings.push({ id: `${key}:${n}`, date: day(date), ledger, amount: minor, source, memo: memoOf(memo, date), ...extra });
  };
  /** A VAT claimed under reg 111, said of the source and line it is on, with the code that says whether it was goods or services. */
  const reg111 = (source: LedgerPosting['source'], date: ISODate, code: string) => {
    const problem = reg111Problem(code, date, books?.vat?.registeredFrom);
    if (problem) checks.push({ kind: 'reg111', source: { kind: source.kind, id: source.id }, date, problem });
  };
  /** A coding's lines posted against what paid them (its own account's ledger, or the director's loan). */
  const postLines = (source: LedgerPosting['source'], date: ISODate, lines: readonly BooksLine[], memo: string) => {
    lines.forEach((l, line) => {
      const at = { ...source, ...(lines.length > 1 ? { line } : {}) };
      const gross = toMinor(l.amount);
      const vat = l.vat ? toMinor(l.vat.amount) : 0;
      const side = ledgerCode(l.ledger)?.kind === 'income' ? 'output' : 'input';
      const claim = l.vat?.claim ? { claim: l.vat.claim } : {};
      const meta = lineMeta(l);
      if (l.vat?.claim === 'reg111') reg111(at, date, l.ledger);
      if (l.vat?.treatment === 'reverse-charge') {
        post(at, date, l.ledger, -gross, memo, { ...meta, vat: { treatment: 'reverse-charge', side: 'input', part: 'net' } });
        post(at, date, 'vat', vat, memo, { vat: { treatment: 'reverse-charge', side: 'output', part: 'tax' } });
        post(at, date, 'vat', -vat, memo, { vat: { treatment: 'reverse-charge', side: 'input', part: 'tax' } });
        // The notional VAT is the standard rate on what was paid: a penny out is asked about.
        const expected = toMinor(reverseChargeVat(l.amount, date));
        if (Math.abs(vat - expected) > REVERSE_CHARGE_TOLERANCE_MINOR) checks.push({ kind: 'reverse-charge-rate', source: { kind: at.kind, id: at.id }, date, amount: fromMinor(vat), expected: fromMinor(expected) });
      } else {
        post(at, date, l.ledger, -(gross - vat), memo, { ...meta, ...(l.vat ? { vat: { treatment: l.vat.treatment, side, part: 'net' as const, ...claim } } : {}) });
        if (l.vat) post(at, date, 'vat', -vat, memo, { vat: { treatment: l.vat.treatment, side, part: 'tax', ...claim } });
      }
    });
  };
  /** A row's coding when it fits (shared/ledger.ts); a check when it is there and does not. Left uncoded on purpose: none. */
  const fitting = (t: Transaction, side: 'company' | 'paid-for'): BooksLine[] | undefined => {
    if (!t.books || t.books.uncoded) return undefined;
    const problem = codingProblems(t.amount, t.books, side)[0];
    if (!problem) return codingLines(t.amount, t.books);
    checks.push({ kind: 'coding-invalid', transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description, problem });
    return undefined;
  };
  const uncoded = (t: Transaction, side: 'company' | 'paid-for') => {
    if (!t.books || t.books.uncoded) checks.push({ kind: 'uncoded', transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description, side, ...(t.books?.uncoded ? { leftUncoded: true } : {}) });
  };

  // Links: the groups that fit count; the rest are checks, and their rows post as not linked.
  const links = linkGroups(rows).map((group) => ({ group, problem: companyLinkProblem(group, (id) => src.transaction(id), src) }));
  for (const { group, problem } of links) if (problem) checks.push({ kind: 'link-invalid', companyRowIds: group.companyIds, personalIds: group.personalIds, problem });
  const counting = links.filter((l) => !l.problem).map((l) => l.group);
  const linkedCompany = new Set(counting.flatMap((g) => g.companyIds));
  const linkedPersonal = new Set(counting.flatMap((g) => g.personalIds));

  // The company's own accounts' rows.
  const transfers = new Map<string, Transaction[]>();
  for (const t of rows) {
    if (before(t.date)) continue;
    const account = src.account(t.accountId)!;
    const other = t.transferGroup && t.counterpartyAccountId ? src.account(t.counterpartyAccountId) : undefined;
    if (other && ownIds.has(other.id) && t.currency === 'GBP') {
      (transfers.get(t.transferGroup!) ?? transfers.set(t.transferGroup!, []).get(t.transferGroup!)!).push(t);
      continue;
    }
    // The books are in pounds: a row in another currency is not posted until it is in pounds (a check).
    if (t.currency !== 'GBP') {
      checks.push({ kind: 'foreign-currency', transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description, currency: t.currency });
      continue;
    }
    const source = { kind: 'row' as const, id: t.id };
    const memo = brief(t);
    post(source, t.date, accountLedger(account), toMinor(t.amount), memo);
    if (linkedCompany.has(t.id)) {
      post(source, t.date, 'directors-loan', -toMinor(t.amount), memo);
      continue;
    }
    const lines = fitting(t, 'company');
    if (lines) postLines(source, t.date, lines, memo);
    else {
      post(source, t.date, 'suspense', -toMinor(t.amount), memo);
      uncoded(t, 'company');
    }
  }
  for (const [group, legs] of transfers) {
    if (legs.length === 2 && toMinor(legs[0]!.amount) + toMinor(legs[1]!.amount) === 0) {
      for (const t of legs) post({ kind: 'transfer', id: group }, t.date, accountLedger(src.account(t.accountId)!), toMinor(t.amount), brief(t));
      continue;
    }
    for (const t of legs) {
      const source = { kind: 'row' as const, id: t.id };
      post(source, t.date, accountLedger(src.account(t.accountId)!), toMinor(t.amount), brief(t));
      post(source, t.date, 'suspense', -toMinor(t.amount), brief(t));
      checks.push({ kind: 'transfer-unmatched', transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description });
    }
  }

  // Rows of yours with the company: paid for it, or lent to it (or repaid by it).
  const unlinkedLoans: Transaction[] = [];
  const marked: Transaction[] = [];
  for (const t of src.transactions()) {
    if (t.company?.id !== companyId || !movesDirectorLoan(t, src) || before(t.date)) continue;
    marked.push(t);
    const source = { kind: 'personal' as const, id: t.id };
    const memo = brief(t);
    if (t.company.as === 'paid-for') {
      post(source, t.date, 'directors-loan', toMinor(t.amount), memo);
      const lines = fitting(t, 'paid-for');
      if (lines) {
        postLines(source, t.date, lines, memo);
        // The company reclaims VAT you paid only on a supply made to it, invoiced to it (VATA 1994 s24(1), reg 29(2)).
        const claimed = lines.reduce((sum, l) => sum + (l.vat && l.vat.treatment !== 'reverse-charge' ? toMinor(l.vat.amount) : 0), 0);
        if (claimed && !t.books?.invoiceToCompany) checks.push({ kind: 'vat-no-invoice', transactionId: t.id, accountId: t.accountId, date: t.date, amount: fromMinor(claimed), description: t.description });
      } else {
        post(source, t.date, 'suspense', -toMinor(t.amount), memo);
        uncoded(t, 'paid-for');
      }
      continue;
    }
    if (linkedPersonal.has(t.id)) continue;
    post(source, t.date, 'directors-loan', toMinor(t.amount), memo);
    post(source, t.date, 'bank-not-imported', -toMinor(t.amount), memo);
    checks.push({ kind: 'bank-not-imported', transactionId: t.id, accountId: t.accountId, date: t.date, amount: t.amount, description: t.description });
    unlinkedLoans.push(t);
  }
  // The fee each link's two sides differ by: the company's bank charge on the company row's day (the
  // latest of them), and your loan moved by your own side.
  for (const g of counting) {
    const personal = g.personalIds.map((id) => src.transaction(id)!);
    const companyRows = g.companyIds.map((id) => src.transaction(id)!);
    const fee = linkFeeMinor(personal, companyRows);
    const date = companyRows.map((t) => t.date).sort().at(-1)!;
    if (!fee || before(date)) continue;
    const source = { kind: 'link' as const, id: g.personalIds[0]! };
    post(source, date, 'bank-charges', fee, `Fee on ${brief(personal[0]!)}`);
    post(source, date, 'directors-loan', -fee, `Fee on ${brief(personal[0]!)}`);
  }

  // Journals, as written; before the ledger's first day, only opening balances.
  const journalLoan: { j: Journal; minor: number }[] = [];
  for (const j of src.companyJournals(companyId)) {
    if (before(j.date) && !j.opening) continue;
    const problem = journalProblems(j, (id) => ownIds.has(id))[0];
    if (problem) {
      checks.push({ kind: 'journal-invalid', journalId: j.id, date: j.date, memo: j.memo, problem });
      continue;
    }
    // What a reg 111 claim was for: the journal's first line that is not VAT itself.
    const what = j.lines.find((l) => l.ledger !== 'vat')?.ledger ?? 'vat';
    j.lines.forEach((l, line) => {
      const source = { kind: 'journal' as const, id: j.id, line };
      if (l.vat?.claim === 'reg111') reg111(source, j.date, what);
      post(source, j.date, l.ledger, toMinor(l.amount), j.memo, { ...(l.vat ? { vat: { treatment: l.vat.treatment, side: l.vat.side, part: l.ledger === 'vat' ? ('tax' as const) : ('net' as const), ...(l.vat.claim ? { claim: l.vat.claim } : {}) } } : {}), ...lineMeta(l) });
      if (l.ledger === 'directors-loan') journalLoan.push({ j, minor: toMinor(l.amount) });
    });
  }

  // Maybe the same money twice: a loan of yours with no company row linked, and a company row coded to
  // the director's loan with no row of yours linked, the other way within 10 days, the two sides within
  // a link's fee of each other. A company row you said is linked to none of yours is not asked about.
  const dlRows = rows.filter((t) => !before(t.date) && !linkedCompany.has(t.id) && !t.companyLink && t.currency === 'GBP' && t.books?.ledger === 'directors-loan' && !t.books.lines?.length && !codingProblems(t.amount, t.books, 'company').length);
  for (const p of unlinkedLoans) {
    for (const c of dlRows) {
      const fee = linkFeeMinor([p], [c]);
      if (Math.sign(p.amount) === Math.sign(c.amount) || fee < 0 || fee > linkTolerance(toMinor(p.amount)) || Math.abs(diffDays(p.date, c.date)) > DOUBLE_COUNT_DAYS) continue;
      checks.push({ kind: 'possible-double-count', personalId: p.id, companyRowId: c.id, date: c.date, amount: c.amount, description: c.description });
    }
  }
  // A journal on the loan that says again what a row of yours says (the same way, within a link's fee, within 10 days).
  for (const { j, minor } of journalLoan) {
    for (const t of marked) {
      const p = toMinor(t.amount);
      if (Math.sign(p) !== Math.sign(minor) || Math.abs(p - minor) > linkTolerance(p) || Math.abs(diffDays(t.date, j.date)) > DOUBLE_COUNT_DAYS) continue;
      checks.push({ kind: 'journal-double-count', journalId: j.id, personalId: t.id, date: j.date, amount: fromMinor(minor), description: t.description });
    }
  }

  // VAT before the company was registered for it (or after it deregistered), unless claimed under reg 111.
  const vat = books?.vat;
  const vatSources = new Map<string, LedgerPosting>();
  for (const p of postings) if (p.vat?.part === 'tax' && !p.vat.claim && (!vat || p.date < vat.registeredFrom || (vat.deregisteredOn && p.date > vat.deregisteredOn))) vatSources.set(`${p.source.kind}:${p.source.id}`, p);
  for (const p of vatSources.values()) {
    // The VAT it carries: a reverse charge posts it both ways, so the larger side, not the two added.
    const tax = postings.filter((x) => x.source.kind === p.source.kind && x.source.id === p.source.id && x.vat?.part === 'tax');
    const [debits, credits] = [tax.reduce((s, x) => s + Math.max(0, x.amount), 0), tax.reduce((s, x) => s - Math.min(0, x.amount), 0)];
    checks.push({ kind: 'vat-unregistered', source: { kind: p.source.kind, id: p.source.id }, date: p.date, amount: fromMinor(Math.max(debits, credits)) });
  }

  // The balances recorded on your director's loan against the books: a recorded balance anchors the
  // loan, so one the books do not add up to is said, with the difference, never passed over.
  const loanAccount = company?.directorLoanAccountId;
  if (loanAccount && books) {
    const loanPostings = postings.filter((p) => p.ledger === 'directors-loan');
    for (const b of src.balances(loanAccount)) {
      const ledger = -loanPostings.filter((p) => p.date <= b.date).reduce((sum, p) => sum + p.amount, 0);
      const recorded = toMinor(b.balance);
      if (recorded !== ledger) checks.push({ kind: 'loan-balance-differs', balanceId: b.id, date: b.date, recorded: b.balance, ledger: fromMinor(ledger), difference: fromMinor(recorded - ledger) });
    }
  }

  // At each accounting period's end: depreciation, disposals, prepayments and accruals.
  const end = books ? periodEnd(src, companyId, books, postings, post, checks, opts.until) : { assets: [], periods: [] };

  // A dividend paid beyond the profits available (CA 2006 s830): the practical test is the profit and
  // loss reserve on the day it is paid, the dividend taken off (retained earnings, every income and
  // expense posting and the dividends to that day, the period's own depreciation and accruals not yet
  // posted: interim figures).
  const reserveTo = (d: ISODate) => -postings.filter((p) => p.date <= d && (p.ledger === 'retained-earnings' || p.ledger === 'dividends' || ['income', 'expense'].includes(ledgerCode(p.ledger)?.kind ?? ''))).reduce((sum, p) => sum + p.amount, 0);
  const paid = new Map<string, { source: LedgerPosting['source']; date: ISODate; minor: number }>();
  for (const p of postings) {
    if (p.ledger !== 'dividends') continue;
    const key = `${p.source.kind}:${p.source.id}`;
    const e = paid.get(key) ?? paid.set(key, { source: { kind: p.source.kind, id: p.source.id }, date: p.date, minor: 0 }).get(key)!;
    e.minor += p.amount;
  }
  for (const e of paid.values()) {
    const after = reserveTo(e.date);
    if (e.minor > 0 && after < 0) checks.push({ kind: 'dividend-exceeds-reserves', source: e.source, date: e.date, amount: fromMinor(e.minor), available: fromMinor(after + e.minor) });
  }

  // Every source adds up to nothing: by construction, so this never fires; it is here to say so if it did.
  const sums = new Map<string, { source: LedgerPosting['source']; minor: number }>();
  for (const p of postings) {
    const key = `${p.source.kind}:${p.source.id}`;
    const e = sums.get(key) ?? sums.set(key, { source: { kind: p.source.kind, id: p.source.id }, minor: 0 }).get(key)!;
    e.minor += p.amount;
  }
  for (const e of sums.values()) if (e.minor) checks.push({ kind: 'unbalanced', source: e.source, amount: fromMinor(e.minor) });

  return { postings, checks, links, assets: end.assets, periods: end.periods };
}

/** What a coding's or journal's line carries onto its posting for the period end: its cover, asset, the asset it reduces and the day it was invoiced. */
const lineMeta = (l: Pick<BooksLine, 'covers' | 'asset' | 'reduces' | 'invoicedOn'>): Pick<LedgerPosting, 'covers' | 'asset' | 'reduces' | 'invoicedOn'> => ({
  ...(l.covers ? { covers: l.covers } : {}),
  ...(l.asset ? { asset: l.asset } : {}),
  ...(l.reduces ? { reduces: l.reduces } : {}),
  ...(l.invoicedOn ? { invoicedOn: l.invoicedOn } : {}),
});

/** An asset's own fields for Corporation Tax, as the register carries them (amounts in pence), when it has any. */
function taxOf(a: NonNullable<LedgerPosting['asset']>): Pick<FixedAsset, 'tax'> {
  const tax: NonNullable<FixedAsset['tax']> = {
    ...(a.connected ? { connected: true as const } : {}),
    ...(a.marketValue !== undefined ? { marketValue: toMinor(a.marketValue) } : {}),
    ...(a.proceeds !== undefined ? { proceeds: toMinor(a.proceeds) } : {}),
    ...(a.pool ? { pool: a.pool } : {}),
    ...(a.used ? { used: true as const } : {}),
    ...(a.allowance ? { allowance: a.allowance } : {}),
  };
  return Object.keys(tax).length ? { tax } : {};
}

/** A posting's source and line, as one id: `row:tx_…`, `row:tx_…:1`, `journal:jnl_…:0`. */
export const assetIdOf = (source: LedgerPosting['source']): string => `${source.kind}:${source.id}${source.line !== undefined ? `:${source.line}` : ''}`;

type Post = (source: LedgerPosting['source'], date: ISODate, ledger: string, minor: number, memo: string) => void;

/**
 * What the books work out at each accounting period's end (FORMULAS.md §22, "At a period's end"),
 * posted after everything else, from the postings so far:
 *
 * - **The register**: each posting to a fixed (or intangible) asset's cost that says it is one (`asset`),
 *   its cost that posting (net of VAT), its life its own `months` or the company's policy for its class
 *   (none: a check, and no depreciation). It counts from the day it was posted, or, brought in on an
 *   opening journal before the ledger's first day (its carrying amount, with its remaining life), from
 *   that first day.
 * - **Depreciation** for each period: depreciation to its end less depreciation to the day before it
 *   starts (`depreciationTo`: straight line by whole months, the month of acquisition in full,
 *   cumulative rounding), Dr `depreciation`, Cr the class's depreciation (or amortisation) code, on the
 *   period's last day, or the day it left in the period it left.
 * - **A disposal** (`disposedOn`), on that day: Cr its cost, Dr its depreciation to then, Dr `disposals`
 *   with the rest (its net book value; what it fetched is coded to `disposals` on its own row).
 * - **Covers**: a posting to income or an expense with `covers` is recognised over its days, inclusive
 *   (`coverParts`; days before the ledger's first day count on it). At the end of each period between
 *   the one it was posted in and the last it covers, what is due by then less what is posted by then
 *   (`carriedAt`) moves to the balance sheet, and back the next day: a cost paid ahead to `prepayments`,
 *   one not yet paid to `accruals`; income received ahead to `deferred-income`, not yet received to
 *   `accrued-income`.
 */
function periodEnd(src: LedgerSource, companyId: string, books: CompanyBooks, postings: readonly LedgerPosting[], post: Post, checks: LedgerCheck[], later?: ISODate): { assets: FixedAsset[]; periods: BooksPeriod[] } {
  const snapshot = [...postings];
  const first = books.ledgerFrom ?? books.incorporatedOn;
  const opening = new Set(src.companyJournals(companyId).filter((j) => j.opening).map((j) => j.id));
  const convention = books.depreciationMonths ?? 'acquisition';
  const policies = [...(books.policies ?? [])].sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''));
  /** An asset's life over time: its own, or each policy for its class in force from the day it counts from, then each taking effect later. */
  const livesOf = (cls: FixedAsset['class'], from: ISODate, own: number | undefined): FixedAsset['lives'] => {
    if (own) return [{ from, months: own }];
    const rows = policies.filter((p) => p.class === cls);
    const inForce = rows.filter((r) => !r.effectiveFrom || r.effectiveFrom <= from).at(-1);
    return [{ from, ...(inForce ? { months: inForce.months } : {}) }, ...rows.filter((r) => r.effectiveFrom && r.effectiveFrom > from).map((r) => ({ from: r.effectiveFrom!, months: r.months }))];
  };
  const dates = snapshot.flatMap((p) => [p.date, ...(p.covers ? [p.covers.to] : []), ...(p.asset?.disposedOn ? [p.asset.disposedOn] : [])]);
  if (!dates.length) return { assets: [], periods: [] };
  if (later) dates.push(later);
  const until = dates.reduce((m, d) => (d > m ? d : m));
  const periods = accountingPeriodsOf(books, until);
  const periodOf = (d: ISODate) => periods.findIndex((p) => p.start <= d && p.end >= d);

  // The register: each debit to a cost code that says it is an asset.
  const assets: FixedAsset[] = [];
  const credits: LedgerPosting[] = [];
  for (const p of snapshot) {
    const entry = ledgerCode(p.ledger);
    if (entry?.asset?.part === 'depreciation' && p.source.kind === 'journal') {
      checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: `A journal writes to ${entry.name.toLowerCase()} by hand: the books work depreciation out from the register, so bring an asset in at its carrying amount with its remaining life, and record one that left by the day it left (impairment, FRS 105 Section 22, is not supported yet).` });
      continue;
    }
    if (entry?.asset?.part !== 'cost') continue;
    if (p.reduces && !p.asset && p.amount < 0) {
      credits.push(p);
      continue;
    }
    if (!p.asset) {
      checks.push({ kind: 'fixed-asset-unmarked', source: p.source, date: p.date, ledger: p.ledger, amount: fromMinor(p.amount), memo: p.memo });
      continue;
    }
    if (p.amount <= 0) {
      checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: 'A fixed asset on the register is a debit to its cost: this one is a credit, so it is left off the register (a credit says which asset it reduces instead).' });
      continue;
    }
    const id = assetIdOf(p.source);
    // Brought in on an opening journal: from the books' first day, or, when that is not a month's first
    // day, the next month's (the accounts before counted that month in full).
    const broughtIn = p.source.kind === 'journal' && opening.has(p.source.id) && books.ledgerFrom !== undefined && p.date < books.ledgerFrom;
    const from = broughtIn ? (books.ledgerFrom!.endsWith('-01') ? books.ledgerFrom! : addMonths(startOfMonth(books.ledgerFrom!), 1)) : p.date;
    let disposedOn = p.asset.disposedOn;
    if (disposedOn && disposedOn < (broughtIn ? books.ledgerFrom! : p.date)) {
      checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: broughtIn ? `It left the company on ${formatDate(disposedOn)}, before its books here start (${formatDate(books.ledgerFrom!)}): leave it out of the opening balances instead. Its disposal is left out.` : `It left the company on ${formatDate(disposedOn)}, before it was bought (${formatDate(p.date)}): its disposal is left out until that is put right.` });
      disposedOn = undefined;
    }
    const lives = livesOf(entry.asset.class, from, p.asset.months);
    if (!lives.some((l) => l.months)) checks.push({ kind: 'no-depreciation-policy', assetId: id, source: p.source, date: p.date, amount: fromMinor(p.amount), class: entry.asset.class, memo: p.memo });
    const residual = p.asset.residual !== undefined ? toMinor(p.asset.residual) : undefined;
    if (residual !== undefined && residual > p.amount) checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: `Its residual value (${formatMoney(fromMinor(residual))}) is more than its cost net of VAT (${formatMoney(fromMinor(p.amount))}): nothing is written down.` });
    const depreciationLedger = entry.asset.class === 'intangible' ? 'intangible-assets:amortisation' : `fixed-assets:${entry.asset.class}:depreciation`;
    const months = lives[0]!.months;
    assets.push({
      id,
      source: p.source,
      ledger: p.ledger,
      depreciationLedger,
      class: entry.asset.class,
      cost: p.amount,
      acquired: p.date,
      from,
      ...(months ? { months } : {}),
      life: p.asset.months ? 'asset' : lives.some((l) => l.months) ? 'policy' : 'none',
      lives,
      ...(residual ? { residual } : {}),
      reductions: [],
      ...(disposedOn ? { disposedOn } : {}),
      convention,
      memo: p.memo,
      ...(broughtIn ? { broughtIn: true as const } : {}),
      ...taxOf(p.asset),
    });
  }
  // Credits that reduce an asset's cost (a supplier's part refund, a cost moved off it), on its own cost code, while it is held.
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const p of credits) {
    const a = byId.get(p.reduces!);
    const problem = !a
      ? `It reduces ${p.reduces}, which is not a fixed asset on the register.`
      : a.ledger !== p.ledger
        ? `It reduces an asset on ${ledgerCode(a.ledger)?.name.toLowerCase() ?? a.ledger}, but is posted to ${ledgerCode(p.ledger)?.name.toLowerCase() ?? p.ledger}.`
        : p.date < a.from
          ? `It reduces an asset before it counts on the register (${formatDate(a.from)}).`
          : a.disposedOn && p.date > a.disposedOn
            ? `It reduces an asset after it left the company (${formatDate(a.disposedOn)}).`
            : undefined;
    if (problem || !a) {
      checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: `${problem} Until that is put right it reduces no asset, so nothing writes it down.` });
      continue;
    }
    const before = addDays(p.date, -1);
    const bookValue = costOn(a, before) - depreciationTo(a, before);
    if (-p.amount > bookValue) checks.push({ kind: 'fixed-asset-invalid', source: p.source, date: p.date, problem: `It reduces ${a.memo}'s cost by ${formatMoney(fromMinor(-p.amount))}, more than its net book value then (${formatMoney(fromMinor(bookValue))}).` });
    a.reductions.push({ date: p.date, amount: -p.amount, source: p.source });
  }

  // Depreciation for each period, and disposals.
  for (const a of assets) {
    const word = a.class === 'intangible' ? 'Amortisation' : 'Depreciation';
    for (const period of periods) {
      if (period.end < a.from || (a.disposedOn && period.start > a.disposedOn)) continue;
      const charge = depreciationTo(a, period.end) - depreciationTo(a, addDays(period.start, -1));
      const leftHere = a.disposedOn && a.disposedOn <= period.end;
      const source = { kind: 'depreciation' as const, id: `${a.id}@${period.end}` };
      post(source, leftHere ? a.disposedOn! : period.end, 'depreciation', charge, `${word}: ${a.memo}`);
      post(source, leftHere ? a.disposedOn! : period.end, a.depreciationLedger, -charge, `${word}: ${a.memo}`);
    }
    if (a.disposedOn) {
      const toDate = depreciationTo(a, a.disposedOn);
      const cost = costOn(a, a.disposedOn);
      const source = { kind: 'disposal' as const, id: a.id };
      const memo = `Disposal: ${a.memo}`;
      post(source, a.disposedOn, a.ledger, -cost, memo);
      post(source, a.disposedOn, a.depreciationLedger, toDate, memo);
      post(source, a.disposedOn, 'disposals', cost - toDate, memo);
    }
  }

  // Covers: prepayments, accruals, deferred and accrued income.
  for (const p of snapshot) {
    if (!p.covers || p.vat?.part === 'tax') continue;
    const kind = ledgerCode(p.ledger)?.kind;
    if (kind !== 'income' && kind !== 'expense') {
      checks.push({ kind: 'covers-not-spread', source: p.source, date: p.date, ledger: p.ledger, amount: fromMinor(p.amount) });
      continue;
    }
    const parts = coverParts(p.amount, p.covers, periods, first);
    const q = periodOf(p.date);
    const covered = parts.flatMap((x, i) => (x ? [i] : []));
    if (q < 0 || !covered.length) continue;
    const lo = Math.min(q, covered[0]!);
    const hi = Math.max(q, covered.at(-1)!);
    for (let k = lo; k < hi; k++) {
      const carried = carriedAt(k, parts, p.amount, p.date, periods);
      if (!carried) continue;
      const paid = p.date <= periods[k]!.end;
      // Not paid by then but invoiced: a trade creditor (a bill received) or debtor (an invoice sent), not an accrual.
      const invoiced = !paid && p.invoicedOn !== undefined && p.invoicedOn <= periods[k]!.end;
      const sheet = kind === 'expense' ? (paid ? 'prepayments' : invoiced ? 'creditors:trade' : 'accruals') : paid ? 'deferred-income' : invoiced ? 'debtors:trade' : 'accrued-income';
      const word = kind === 'expense' ? (paid ? 'Prepaid' : invoiced ? 'Billed, not yet paid' : 'Accrued') : paid ? 'Received ahead' : invoiced ? 'Invoiced, not yet received' : 'Accrued income';
      const source = { kind: 'deferral' as const, id: `${p.id}@${periods[k]!.end}` };
      const memo = `${word}: ${p.memo}`;
      post(source, periods[k]!.end, p.ledger, carried, memo);
      post(source, periods[k]!.end, sheet, -carried, memo);
      post(source, addDays(periods[k]!.end, 1), p.ledger, -carried, `${memo} (reversed)`);
      post(source, addDays(periods[k]!.end, 1), sheet, carried, `${memo} (reversed)`);
    }
  }
  return { assets, periods };
}

/** The ledger's postings for a company, in a date range (either end open), as served. */
export function ledgerView(src: LedgerSource, company: Company, from: ISODate | undefined, to: ISODate | undefined, until?: ISODate): CompanyLedgerResponse {
  const { postings, checks } = companyLedger(src, company.id, until ? { until } : {});
  const inRange = postings.filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const p of inRange) {
    const e = totals.get(p.ledger) ?? totals.set(p.ledger, { debit: 0, credit: 0 }).get(p.ledger)!;
    if (p.amount > 0) e.debit += p.amount;
    else e.credit -= p.amount;
  }
  return {
    company: { id: company.id, name: company.name },
    from: from ?? null,
    to: to ?? null,
    postings: [...inRange].sort((a, b) => a.date.localeCompare(b.date)),
    totals: [...totals.entries()].map(([ledger, t]) => ({ ledger, debit: t.debit, credit: t.credit, net: t.debit - t.credit })).sort((a, b) => a.ledger.localeCompare(b.ledger)),
    checks,
    accounts: src.companyAccounts(company.id).map((a) => ({ id: a.id, name: a.name, ledger: accountLedger(a) })),
  };
}

// ─── The director's loan, from the books ─────────────────────────────────────────────────────────

/**
 * The movements of a company's director's loan from its books: its postings to `directors-loan`, by
 * source, each added up and negated to your side (a credit in the company's books is what it owes you
 * growing). A row of yours keeps its mark's id and kind, so with books kept and nothing but your marks
 * and links, the loan moves exactly as it did without them (FORMULAS.md §22).
 */
export function ledgerDirectorLoanMovements(src: LedgerSource, companyId: string, postings: readonly LedgerPosting[] = companyLedger(src, companyId).postings): DirectorLoanMovement[] {
  const bySource = new Map<string, { source: LedgerPosting['source']; date: ISODate; minor: number; memo: string }>();
  for (const p of postings) {
    if (p.ledger !== 'directors-loan') continue;
    const key = `${p.source.kind}:${p.source.id}`;
    const e = bySource.get(key) ?? bySource.set(key, { source: { kind: p.source.kind, id: p.source.id }, date: p.date, minor: 0, memo: p.memo }).get(key)!;
    e.minor += p.amount;
  }
  const out: DirectorLoanMovement[] = [];
  for (const { source, date, minor, memo } of bySource.values()) {
    if (!minor) continue;
    const amount = fromMinor(-minor);
    if (source.kind === 'journal') {
      out.push({ id: `dlm_${source.id}`, source: 'journal', journalId: source.id, date, amount, kind: 'journal', description: memo });
      continue;
    }
    const t = src.transaction(source.id)!;
    const hex = t.id.replace(/^tx_/, '');
    if (source.kind === 'link') {
      out.push({ id: `dlm_fee_${hex}`, source: 'link-fee', transactionId: t.id, accountId: t.accountId, date, amount, kind: 'fee', description: memo });
      continue;
    }
    if (source.kind === 'personal') {
      const as = t.company!.as as 'paid-for' | 'loan';
      out.push({ id: `dlm_${hex}`, source: 'mark', transactionId: t.id, accountId: t.accountId, date, amount, as, kind: directorLoanKind(as, t.amount)!, description: t.description, ...(t.payee ? { payee: t.payee } : {}) });
      continue;
    }
    const linked = isLinked(t);
    out.push({ id: `dlm_${hex}`, source: 'company-row', transactionId: t.id, accountId: t.accountId, date, amount, kind: linked ? (amount > 0 ? 'lent' : 'repaid') : amount > 0 ? 'received' : 'paid-out', description: t.description, ...(t.payee ? { payee: t.payee } : {}) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─── Links ───────────────────────────────────────────────────────────────────────────────────────

/** A company row that can be the other side of a loan of yours: not a leg of a transfer between its accounts, coded to nothing but the director's loan. */
function linkable(src: LedgerSource, t: Transaction, ownIds: ReadonlySet<string>): boolean {
  const other = t.transferGroup && t.counterpartyAccountId ? src.account(t.counterpartyAccountId) : undefined;
  return !(other && ownIds.has(other.id)) && linkableCoding(t.books) && t.amount !== 0 && t.currency === 'GBP';
}

/**
 * The links the app makes by itself (FORMULAS.md §22, "Links"): a row of yours marked as a loan with
 * the company and a company row the same amount the other way, at most 4 days apart, neither linked by
 * you or a proposal, the company row coded to the director's loan or not at all, where each is the
 * other's only such row. Company row id → the row of yours. Worked out again whenever rows are.
 */
export function autoLinks(src: LedgerSource, companyId: string): Map<string, string> {
  const own = new Set(src.companyAccounts(companyId).map((a) => a.id));
  const rows = src.companyTransactions(companyId);
  const byHand = new Set(rows.filter((t) => t.companyLink && t.companyLink.setBy !== 'auto').flatMap((t) => t.companyLink!.rows));
  const personal = src.transactions().filter((t) => t.company?.id === companyId && t.company.as === 'loan' && markCounts(t, src) && !byHand.has(t.id));
  const company = rows.filter((t) => (!t.companyLink || t.companyLink.setBy === 'auto') && linkable(src, t, own));
  const candidates = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const byAmount = new Map<number, Transaction[]>();
  for (const c of company) (byAmount.get(toMinor(c.amount)) ?? byAmount.set(toMinor(c.amount), []).get(toMinor(c.amount))!).push(c);
  for (const p of personal) {
    for (const c of byAmount.get(-toMinor(p.amount)) ?? []) {
      if (Math.abs(diffDays(p.date, c.date)) > AUTO_LINK_DAYS) continue;
      (candidates.get(p.id) ?? candidates.set(p.id, []).get(p.id)!).push(c.id);
      (reverse.get(c.id) ?? reverse.set(c.id, []).get(c.id)!).push(p.id);
    }
  }
  const out = new Map<string, string>();
  for (const [p, cs] of candidates) if (cs.length === 1 && reverse.get(cs[0]!)!.length === 1) out.set(cs[0]!, p);
  return out;
}

/** The company's rows with their link as the app would leave it: the patches that set or take away automatic links. */
export function autoLinkPatches(src: LedgerSource, companyId: string): { id: string; patch: Partial<Transaction> }[] {
  const want = autoLinks(src, companyId);
  const lock = src.company(companyId)?.books?.lockedThrough;
  const out: { id: string; patch: Partial<Transaction> }[] = [];
  for (const t of src.companyTransactions(companyId)) {
    if (t.companyLink && t.companyLink.setBy !== 'auto') continue;
    // A row dated within the lock keeps its link as filed (and one of yours it would name is checked by the store's lock).
    if (lock && t.date <= lock) continue;
    const p = want.get(t.id);
    if (p && !(t.companyLink && t.companyLink.rows.length === 1 && t.companyLink.rows[0] === p)) out.push({ id: t.id, patch: { companyLink: { rows: [p], setBy: 'auto' } } });
    else if (!p && t.companyLink) out.push({ id: t.id, patch: { companyLink: undefined } });
  }
  return out;
}

// ─── The Books tab ───────────────────────────────────────────────────────────────────────────────

/** A company's rows to code, its links and what could be linked, its journals and book rules (GET /companies/:id/coding). */
export function codingView(src: LedgerSource, company: Company, from?: ISODate, to?: ISODate): CompanyCodingResponse {
  const own = src.companyAccounts(company.id);
  const ownIds = new Set(own.map((a) => a.id));
  const accountName = (id: string) => src.account(id)?.name ?? id;
  const inRange = (d: ISODate) => (!from || d >= from) && (!to || d <= to);
  const ledger = companyLedger(src, company.id);
  const counting = ledger.links.filter((l) => !l.problem);
  const linkOf = new Map(counting.flatMap((l) => l.group.companyIds.map((id) => [id, l.group] as const)));
  const linkedPersonal = new Set(counting.flatMap((l) => l.group.personalIds));
  const view = (t: Transaction) => ({ id: t.id, accountId: t.accountId, accountName: accountName(t.accountId), date: t.date, amount: t.amount, description: t.description });

  const rows: BooksRowView[] = [];
  const consider = [...src.companyTransactions(company.id), ...src.transactions().filter((t) => t.company?.id === company.id && t.company.as === 'paid-for')];
  for (const t of consider) {
    if (!inRange(t.date)) continue;
    const place = codingPlace(t, src);
    if ('problem' in place) continue;
    const problem = t.books ? codingProblems(t.amount, t.books, place.row)[0] : undefined;
    const group = linkOf.get(t.id);
    rows.push({
      ...view(t),
      ...(t.payee ? { payee: t.payee } : {}),
      side: place.row,
      ...(t.books ? { books: t.books } : {}),
      ...(problem ? { problem } : {}),
      ...(group && t.companyLink ? { linked: { personalIds: group.personalIds, setBy: t.companyLink.setBy } } : {}),
    });
  }
  // Uncoded (or coded where it does not fit) first, then the newest.
  const needs = (r: BooksRowView) => (!r.books && !r.linked) || r.problem !== undefined;
  rows.sort((a, b) => Number(needs(b)) - Number(needs(a)) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  const links: LinkView[] = ledger.links.map(({ group, problem }) => {
    const companyRows = group.companyIds.map((id) => src.transaction(id)).filter((t): t is Transaction => t !== undefined);
    const personal = group.personalIds.map((id) => src.transaction(id)).filter((t): t is Transaction => t !== undefined);
    return { companyRows: companyRows.map(view), personalRows: personal.map(view), setBy: companyRows[0]?.companyLink?.setBy ?? 'user', fee: linkFeeMinor(personal, companyRows), ...(problem ? { problem } : {}) };
  });

  // Loans of yours with no company row linked, and the company rows that could be their other side.
  // Your "not linked" stops the app linking a row, not you: it is still offered here.
  const free = src.companyTransactions(company.id).filter((t) => !linkOf.has(t.id) && !isLinked(t) && linkable(src, t, ownIds));
  const suggestions: LinkSuggestion[] = [];
  for (const p of src.transactions()) {
    if (p.company?.id !== company.id || p.company.as !== 'loan' || !markCounts(p, src) || linkedPersonal.has(p.id)) continue;
    const candidates = free
      .map((c) => ({ c, days: Math.abs(diffDays(p.date, c.date)), fee: linkFeeMinor([p], [c]) }))
      .filter((x) => Math.sign(x.c.amount) !== Math.sign(p.amount) && x.days <= DOUBLE_COUNT_DAYS && x.fee >= 0 && x.fee <= linkTolerance(toMinor(p.amount)))
      .sort((a, b) => a.fee - b.fee || a.days - b.days || a.c.id.localeCompare(b.c.id))
      .slice(0, 5)
      .map(({ c, days, fee }) => ({ ...view(c), days, fee, exact: fee === 0 && days <= AUTO_LINK_DAYS }));
    suggestions.push({ personal: view(p), candidates });
  }
  suggestions.sort((a, b) => b.personal.date.localeCompare(a.personal.date));

  const vat = company.books?.vat;
  return {
    company: { id: company.id, name: company.name },
    rows,
    links,
    suggestions,
    journals: src.companyJournals(company.id),
    rules: src.bookRules(company.id),
    accounts: own.map((a) => ({ id: a.id, name: a.name, ledger: accountLedger(a) })),
    ...(vat ? { vat: { registeredFrom: vat.registeredFrom, ...(vat.deregisteredOn ? { deregisteredOn: vat.deregisteredOn } : {}) } } : {}),
    assets: ledger.assets.map((a) => ({ id: a.id, ledger: a.ledger, memo: a.memo, acquired: a.acquired, cost: a.cost })),
    ...(company.books?.lockedThrough ? { lockedThrough: company.books.lockedThrough } : {}),
  };
}

// ─── Book rules ──────────────────────────────────────────────────────────────────────────────────

/** A row's coding without who set it or by which rule: two that say the same compare equal. */
export const codingKey = (b: BooksCoding | undefined): string => {
  if (!b) return 'none';
  const { setBy: _s, ruleId: _r, ...rest } = b;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, (rest as Record<string, unknown>)[k]]));
};

/**
 * What a company's book rules make of its rows (FORMULAS.md §22, "Book rules"), as patches: each row a
 * rule's scope reaches (the company's own rows, the rows of yours paid for it, or both) that no one coded
 * by hand or by proposal takes the coding of the first rule that matches it (by priority, then age; the
 * same matcher as your rules), when that coding fits it; a row a rule coded before that none matches now
 * loses it. Never a row you or a proposal coded, a leg of a transfer between the company's accounts, or
 * a company row linked to money with you. `rules`: in place of the company's own (a rule proposed).
 */
export function bookRulePatches(src: LedgerSource, companyId: string, opts: { rules?: readonly Rule[]; only?: ReadonlySet<string> } = {}): { id: string; patch: Partial<Transaction>; ruleId?: string }[] {
  const rules = [...(opts.rules ?? src.bookRules(companyId))].filter((r) => r.enabled && r.match.company?.id === companyId && r.set.books && !ruleBooksProblems(r).length).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const alone = new Map(rules.map((r) => [r.id, new Categoriser([r], new CategoryIndex([]), [], [])]));
  const scopeOf = (r: Rule) => r.match.company!.rows;
  const rows = [...src.companyTransactions(companyId).map((t) => ({ t, side: 'own' as const })), ...src.transactions().filter((t) => t.company?.id === companyId && t.company.as === 'paid-for').map((t) => ({ t, side: 'paid-for' as const }))];
  const out: { id: string; patch: Partial<Transaction>; ruleId?: string }[] = [];
  // Rows dated within the lock keep their coding as filed.
  const lock = src.company(companyId)?.books?.lockedThrough;
  for (const { t, side } of rows) {
    if (opts.only && !opts.only.has(t.id)) continue;
    if (lock && t.date <= lock) continue;
    if (t.books && t.books.setBy !== 'rule') continue;
    const place = codingPlace(t, src);
    if ('problem' in place || isLinked(t)) continue;
    let next: BooksCoding | undefined;
    for (const r of rules) {
      const scope = scopeOf(r);
      if (scope !== 'both' && scope !== side) continue;
      if (!ruleCatches(r, t, alone.get(r.id))) continue;
      const coding = ruleCoding(r, t);
      if (coding && !codingProblems(t.amount, coding, place.row).length) {
        next = coding;
        break;
      }
    }
    if (codingKey(next) === codingKey(t.books) && next?.ruleId === t.books?.ruleId) continue;
    out.push({ id: t.id, patch: { books: next }, ...(next?.ruleId ? { ruleId: next.ruleId } : {}) });
  }
  return out;
}

/** A journal of the company's that says the same as `input` (its day, memo and lines), if one is there. */
export function sameJournal(src: LedgerSource, companyId: string, input: Pick<Journal, 'date' | 'memo' | 'lines'>): Journal | undefined {
  const key = (j: Pick<Journal, 'date' | 'memo' | 'lines'>) => JSON.stringify([j.date, j.memo.trim(), j.lines.map((l) => [l.ledger, toMinor(l.amount)])]);
  return src.companyJournals(companyId).find((j) => key(j) === key(input));
}

/** The company rows whose link names any of `personalIds`, and the rows of yours those rows name: what a link would join. */
export function linkNeighbours(src: LedgerSource, companyId: string, personalIds: readonly string[]): Transaction[] {
  const want = new Set(personalIds);
  return src.companyTransactions(companyId).filter((t) => t.companyLink?.rows.some((id) => want.has(id)));
}

/** A company's book rules (rules.json, `set.books`). */
export const companyBookRules = (src: Pick<LedgerSource, 'bookRules'>, companyId: string): Rule[] => src.bookRules(companyId);

/**
 * A company's books as a proposal's changes leave them, for the balance engine's director's loan
 * (proposals.ts, `sourceAsLeft`): every row as `row` gives it (undefined: removed), the company's
 * journals with those the proposal writes and without those it takes away. So a proposal's checks read
 * the loan from the same source the app does.
 */
export function ledgerAsLeft(src: Omit<LedgerSource, 'transactions' | 'balances'>, row: (id: string) => Transaction | undefined, journals: { add?: readonly Journal[]; remove?: ReadonlySet<string> } = {}): Omit<LedgerSource, 'transactions' | 'balances'> {
  return {
    account: (id) => src.account(id),
    company: (id) => src.company(id),
    transaction: (id) => row(id),
    companyAccounts: (id) => src.companyAccounts(id),
    companyTransactions: (id) => src.companyTransactions(id).flatMap((t) => row(t.id) ?? []),
    companyJournals: (id) =>
      [...src.companyJournals(id).filter((j) => !journals.remove?.has(j.id)), ...(journals.add ?? []).filter((j) => j.companyId === id)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    bookRules: (id) => src.bookRules(id),
  };
}

// ─── The lock (books.lockedThrough) ─────────────────────────────────────────────────────────────

/**
 * What a lock keeps (FORMULAS.md §22, "Locking"): the postings dated on or before `through`, added up
 * by day, ledger and source (memos and ids aside), as one string. Two that differ mean a write would
 * change the books of a period whose accounts are filed.
 */
export function lockedPostingsKey(src: LedgerSource, companyId: string, through: ISODate): string {
  const sums = new Map<string, number>();
  for (const p of companyLedger(src, companyId, { until: through }).postings) {
    if (p.date > through) continue;
    const key = `${p.date}|${p.ledger}|${p.source.kind}:${p.source.id}`;
    sums.set(key, (sums.get(key) ?? 0) + p.amount);
  }
  return JSON.stringify([...sums].filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A ledger source as a write would leave it: rows changed (null: taken away), journals added (or
 * replaced) and taken away, a company's record replaced. What the lock compares against.
 */
export function sourceWith(src: LedgerSource, change: { rows?: ReadonlyMap<string, Transaction | null>; journals?: { add?: readonly Journal[]; remove?: ReadonlySet<string> }; company?: Company }): LedgerSource {
  const rows = change.rows ?? new Map<string, Transaction | null>();
  const swap = (list: Transaction[]) => list.flatMap((t) => (rows.has(t.id) ? (rows.get(t.id) ? [rows.get(t.id)!] : []) : [t]));
  const added = change.journals?.add ?? [];
  const removed = new Set([...(change.journals?.remove ?? []), ...added.map((j) => j.id)]);
  return {
    account: (id) => src.account(id),
    company: (id) => (change.company && id === change.company.id ? change.company : src.company(id)),
    transaction: (id) => (rows.has(id) ? (rows.get(id) ?? undefined) : src.transaction(id)),
    transactions: (accountId) => swap(src.transactions(accountId)),
    companyAccounts: (id) => src.companyAccounts(id),
    companyTransactions: (id) => swap(src.companyTransactions(id)),
    companyJournals: (id) => [...src.companyJournals(id).filter((j) => !removed.has(j.id)), ...added.filter((j) => j.companyId === id)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    bookRules: (id) => src.bookRules(id),
    balances: (id) => src.balances(id),
  };
}

/** The message a write the lock refuses gets. */
export const lockedMessage = (company: Pick<Company, 'name'>, through: ISODate): string =>
  `${company.name}’s books are locked through ${formatDate(through)} (its accounts to then are filed): this would change them. Correct it with a journal in a later period, or, if the filing itself was wrong, move the lock in its Settings first.`;
