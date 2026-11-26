// A company's chart of accounts, and what coding a payment or writing a journal must say
// (docs/FORMULAS.md §22, "The general ledger"; docs/DATA_FORMAT.md, transactions `books`, journals.jsonl).
//
// The chart is structure, like categories: a small, conventional set of ledger codes for a UK micro
// company, each with its kind, the line of the micro-entity balance sheet or profit and loss account it
// is shown on (Small Companies and Groups (Accounts and Directors' Report) Regulations 2008, SI 2008/409,
// Sch 1 Part 1 Section C, formats inserted by SI 2013/3008; FRS 105), and how Corporation Tax treats it.
// It is not a UK rule table (those are dated, in uk.ts): the lines a code is shown on are the format's,
// and the treatment is a starting point for the tax computation, which is the company's to check.
//
// Pure: no store. Amounts here are pounds as stored, worked in integer pence (shared/money.ts).

import { markCounts, type MarkContext } from './company';
import { formatDate, type ISODate } from './dates';
import { formatMoney, fromMinor, toMinor } from './money';
import type { Account, BooksCoding, BooksLine, Journal, Rule, Transaction, VatTreatment } from './schema';
import { lastDayOfMonths, vatRateOn } from './uk';

export type LedgerKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/**
 * The micro-entity balance sheet's lines (format 1): A called up share capital not paid, B fixed
 * assets, C current assets, D prepayments and accrued income, E creditors due within one year,
 * H creditors due after more than one year, I provisions for liabilities, J accruals and deferred
 * income, K capital and reserves. F (net current assets) and G (total assets less current liabilities)
 * are totals, so no code is shown on them.
 */
export type SheetLine = 'A' | 'B' | 'C' | 'D' | 'E' | 'H' | 'I' | 'J' | 'K';

/**
 * The micro-entity profit and loss account's lines: A turnover, B other income, C cost of raw
 * materials and consumables, D staff costs, E depreciation and other amounts written off assets,
 * F other charges, G tax (H, the profit or loss, is their total).
 */
export type ProfitLine = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/**
 * How Corporation Tax treats a code, for the tax computation later: trading income, non-trading income
 * (interest received: a loan relationship credit), an allowable or a disallowable expense, capital (a
 * fixed asset's cost: capital allowances instead of a deduction), the tax itself, or none (the rest of
 * the balance sheet).
 */
export type CtTreatment = 'trading-income' | 'non-trading-income' | 'allowable' | 'disallowable' | 'capital' | 'tax' | 'none';

/** The classes of fixed asset a cost can be capitalised in. Motor vehicles have capital allowance rules of their own, not worked out here. */
export const FIXED_ASSET_CLASSES = ['computer', 'office', 'furniture', 'motor'] as const;
export type FixedAssetClass = (typeof FIXED_ASSET_CLASSES)[number];
export const FIXED_ASSET_CLASS_META: Record<FixedAssetClass, { name: string; capitalAllowances: 'supported' | 'not-supported' }> = {
  computer: { name: 'Computer equipment', capitalAllowances: 'supported' },
  office: { name: 'Office equipment', capitalAllowances: 'supported' },
  furniture: { name: 'Furniture and fittings', capitalAllowances: 'supported' },
  motor: { name: 'Motor vehicles', capitalAllowances: 'not-supported' },
};

export interface LedgerCode {
  code: string;
  name: string;
  kind: LedgerKind;
  /** A balance sheet code: the line a debit balance and a credit balance is shown on (a bank account overdrawn is a creditor). */
  sheet?: { debit: SheetLine; credit: SheetLine };
  /** A profit and loss code: its line. */
  profit?: ProfitLine;
  ct: CtTreatment;
  /** A payment can be coded to it (`books`); the rest are posted by the ledger itself, or written in journals. */
  codable: boolean;
  /** The ledger's own clearing codes: never written by you, and anything on them is a check to clear. */
  clearing?: boolean;
  /** A fixed asset class's cost or depreciation. */
  asset?: { class: FixedAssetClass; part: 'cost' | 'depreciation' };
  /** One of the company's own accounts: `bank:<accountId>`, `card:<accountId>`, `loans:<accountId>`. */
  account?: true;
  /** What goes there, in a few words. */
  hint?: string;
}

const both = (line: SheetLine) => ({ debit: line, credit: line });
const assetLine = (debit: SheetLine, credit: SheetLine = 'E') => ({ debit, credit });

const BASE: LedgerCode[] = [
  // Assets.
  { code: 'share-capital-unpaid', name: 'Called up share capital not paid', kind: 'asset', sheet: both('A'), ct: 'none', codable: false, hint: 'Shares issued and not yet paid for (a journal at incorporation).' },
  ...FIXED_ASSET_CLASSES.flatMap((c): LedgerCode[] => [
    { code: `fixed-assets:${c}:cost`, name: `${FIXED_ASSET_CLASS_META[c].name}: cost`, kind: 'asset', sheet: both('B'), ct: 'capital', codable: true, asset: { class: c, part: 'cost' }, hint: 'Equipment kept and used for more than a year, capitalised rather than spent.' },
    { code: `fixed-assets:${c}:depreciation`, name: `${FIXED_ASSET_CLASS_META[c].name}: depreciation`, kind: 'asset', sheet: both('B'), ct: 'none', codable: false, asset: { class: c, part: 'depreciation' }, hint: 'What its cost has been written down by (worked out from its life).' },
  ]),
  { code: 'debtors:trade', name: 'Trade debtors', kind: 'asset', sheet: assetLine('C'), ct: 'none', codable: true, hint: 'Invoices sent and not yet paid.' },
  { code: 'prepayments', name: 'Prepayments', kind: 'asset', sheet: both('D'), ct: 'none', codable: false, hint: 'Costs paid for a later period.' },
  { code: 'accrued-income', name: 'Accrued income', kind: 'asset', sheet: both('D'), ct: 'none', codable: false, hint: 'Income earned and not yet invoiced.' },
  { code: 'bank', name: 'Bank', kind: 'asset', sheet: assetLine('C'), ct: 'none', codable: false, account: true, hint: 'The company’s current and savings accounts, one each.' },
  { code: 'vat', name: 'VAT', kind: 'liability', sheet: assetLine('C'), ct: 'none', codable: true, hint: 'VAT charged and reclaimed; a payment to HMRC for a return, or a repayment from it.' },
  { code: 'suspense', name: 'Suspense: not coded yet', kind: 'asset', sheet: assetLine('C'), ct: 'none', codable: false, clearing: true, hint: 'The other side of a payment not coded yet.' },
  { code: 'bank-not-imported', name: 'Company bank: not imported', kind: 'asset', sheet: assetLine('C'), ct: 'none', codable: false, clearing: true, hint: 'Money between you and the company whose company side is not in its imported accounts.' },
  // Liabilities.
  { code: 'card', name: 'Credit card', kind: 'liability', sheet: { debit: 'C', credit: 'E' }, ct: 'none', codable: false, account: true, hint: 'The company’s cards, one each.' },
  { code: 'loans', name: 'Loans', kind: 'liability', sheet: { debit: 'C', credit: 'H' }, ct: 'none', codable: false, account: true, hint: 'The company’s loan accounts, one each.' },
  { code: 'creditors:trade', name: 'Trade creditors', kind: 'liability', sheet: { debit: 'C', credit: 'E' }, ct: 'none', codable: true, hint: 'Bills received and not yet paid.' },
  { code: 'paye', name: 'PAYE and National Insurance', kind: 'liability', sheet: { debit: 'C', credit: 'E' }, ct: 'none', codable: true, hint: 'Tax and National Insurance owed to HMRC on pay: a payment to HMRC for PAYE.' },
  { code: 'corporation-tax', name: 'Corporation Tax', kind: 'liability', sheet: { debit: 'C', credit: 'E' }, ct: 'none', codable: true, hint: 'Corporation Tax owed: a payment of it to HMRC.' },
  { code: 'directors-loan', name: 'Director’s loan', kind: 'liability', sheet: { debit: 'C', credit: 'E' }, ct: 'none', codable: true, hint: 'Money between the company and you that is not pay or a dividend: what it owes you (or you owe it).' },
  { code: 'accruals', name: 'Accruals', kind: 'liability', sheet: { debit: 'D', credit: 'J' }, ct: 'none', codable: false, hint: 'Costs of the period not yet billed.' },
  { code: 'deferred-income', name: 'Deferred income', kind: 'liability', sheet: { debit: 'D', credit: 'J' }, ct: 'none', codable: false, hint: 'Income received for a later period.' },
  // Capital and reserves.
  { code: 'share-capital', name: 'Share capital', kind: 'equity', sheet: both('K'), ct: 'none', codable: true, hint: 'What shareholders paid for their shares.' },
  { code: 'retained-earnings', name: 'Retained earnings', kind: 'equity', sheet: both('K'), ct: 'none', codable: false, hint: 'Profits kept from earlier years.' },
  { code: 'dividends', name: 'Dividends', kind: 'equity', sheet: both('K'), ct: 'none', codable: true, hint: 'Dividends paid to shareholders: from reserves, not a cost.' },
  // Income.
  { code: 'turnover', name: 'Sales', kind: 'income', profit: 'A', ct: 'trading-income', codable: true, hint: 'What the company is paid for its work or goods.' },
  { code: 'interest-receivable', name: 'Interest received', kind: 'income', profit: 'B', ct: 'non-trading-income', codable: true, hint: 'Interest on the company’s bank accounts.' },
  // Expenses.
  { code: 'cost-of-sales', name: 'Cost of sales', kind: 'expense', profit: 'C', ct: 'allowable', codable: true, hint: 'Materials and subcontractors bought for the work sold.' },
  { code: 'directors-salaries', name: 'Directors’ salaries', kind: 'expense', profit: 'D', ct: 'allowable', codable: true, hint: 'Pay to directors, before tax.' },
  { code: 'employer-ni', name: 'Employer’s National Insurance', kind: 'expense', profit: 'D', ct: 'allowable', codable: true },
  { code: 'staff-pensions', name: 'Pension contributions', kind: 'expense', profit: 'D', ct: 'allowable', codable: true, hint: 'The company’s contributions to a pension of a director or employee.' },
  { code: 'depreciation', name: 'Depreciation', kind: 'expense', profit: 'E', ct: 'disallowable', codable: false, hint: 'Fixed assets written down (capital allowances are given instead).' },
  { code: 'software-hosting', name: 'Software and hosting', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'bank-charges', name: 'Bank charges', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'interest-payable', name: 'Interest paid', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'professional-fees', name: 'Accountancy and legal fees', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'companies-house-fees', name: 'Companies House fees', kind: 'expense', profit: 'F', ct: 'allowable', codable: true, hint: 'A confirmation statement’s fee (incorporation’s is a formation cost).' },
  { code: 'formation-costs', name: 'Formation costs', kind: 'expense', profit: 'F', ct: 'disallowable', codable: true, hint: 'Setting the company up: capital in nature, so not allowable.' },
  { code: 'registered-office', name: 'Registered office', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'rent', name: 'Rent', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'telephone-internet', name: 'Telephone and internet', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'travel', name: 'Travel', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'small-equipment', name: 'Small equipment', kind: 'expense', profit: 'F', ct: 'allowable', codable: true, hint: 'Equipment too small to capitalise.' },
  { code: 'advertising', name: 'Advertising', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'insurance', name: 'Insurance', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'office-costs', name: 'Office costs', kind: 'expense', profit: 'F', ct: 'allowable', codable: true, hint: 'Stationery, postage and the like.' },
  { code: 'entertainment', name: 'Entertaining', kind: 'expense', profit: 'F', ct: 'disallowable', codable: true, hint: 'Entertaining clients: not allowable (CTA 2009 s1298).' },
  { code: 'general-expenses', name: 'General expenses', kind: 'expense', profit: 'F', ct: 'allowable', codable: true },
  { code: 'corporation-tax-charge', name: 'Corporation Tax charge', kind: 'expense', profit: 'G', ct: 'tax', codable: false, hint: 'The year’s Corporation Tax (a journal).' },
];

/** The chart, in the order it is shown: balance sheet first, then profit and loss. */
export const LEDGER_CODES: readonly LedgerCode[] = BASE;
const BY_CODE = new Map(BASE.map((c) => [c.code, c]));
/** The codes the ledger posts to an account of the company's own: one per account, after the colon. */
export const ACCOUNT_LEDGER_PREFIXES = ['bank', 'card', 'loans'] as const;

/** The chart's entry for a code: one of the chart's, or one of the company's own accounts (`bank:<accountId>`), under its parent. */
export function ledgerCode(code: string): LedgerCode | undefined {
  const exact = BY_CODE.get(code);
  if (exact) return exact.account ? undefined : exact;
  const [prefix, id, ...rest] = code.split(':');
  if (!id || rest.length || !(ACCOUNT_LEDGER_PREFIXES as readonly string[]).includes(prefix!)) return undefined;
  return { ...BY_CODE.get(prefix!)!, code };
}

/** A code's name, or the code itself when it is not in the chart. */
export const ledgerName = (code: string, accountName?: (id: string) => string | undefined): string => {
  const entry = ledgerCode(code);
  if (entry?.account) return `${entry.name}: ${accountName?.(code.split(':')[1]!) ?? code.split(':')[1]}`;
  return entry?.name ?? code;
};

/** The ledger a company's own account posts to: a card's, a loan's, or a bank account's. */
export function accountLedger(account: Pick<Account, 'id' | 'type'>): string {
  if (account.type === 'credit_card') return `card:${account.id}`;
  if (account.type === 'loan' || account.type === 'mortgage' || account.type === 'other_liability' || account.type === 'student_loan') return `loans:${account.id}`;
  return `bank:${account.id}`;
}

/** The account a code names (`bank:<accountId>`…), if it is one. */
export function ledgerAccountId(code: string): string | undefined {
  return ledgerCode(code)?.account ? code.split(':')[1] : undefined;
}

// ─── VAT ─────────────────────────────────────────────────────────────────────────────────────────

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  standard: 'Standard rate',
  reduced: 'Reduced rate',
  zero: 'Zero rate',
  exempt: 'Exempt',
  outside: 'Outside the scope',
  'reverse-charge': 'Reverse charge',
};

/** Treatments that carry no VAT on the payment. */
const NO_VAT: ReadonlySet<VatTreatment> = new Set(['zero', 'exempt', 'outside']);

/**
 * The VAT in an amount that includes it, at a rate on a day (`vatRateOn`, uk.ts): gross × r ÷ (1 + r),
 * to the penny (half a penny up, away from nothing), signed like the gross. £120 at 20% holds £20.
 */
export function vatInGross(gross: number, date: ISODate, rate: 'standard' | 'reduced'): number {
  const r = vatRateOn(date, rate);
  const minor = toMinor(gross);
  const vat = Math.round((Math.abs(minor) * r) / (1 + r));
  return fromMinor(Math.sign(minor) * vat);
}

/**
 * The VAT a reverse charge accounts for on an amount that does not include it (a service bought from
 * abroad): amount × the standard rate, to the penny, signed like the amount. Both output and input VAT
 * are posted, so nothing is paid (FORMULAS.md §22).
 */
export function reverseChargeVat(amount: number, date: ISODate): number {
  const minor = toMinor(amount);
  return fromMinor(Math.sign(minor) * Math.round(Math.abs(minor) * vatRateOn(date, 'standard')));
}

// ─── Coding a payment ────────────────────────────────────────────────────────────────────────────

/** A coding's lines, as one list: its own ledger as one line of the whole amount, or its split. */
export function codingLines(amount: number, books: Pick<BooksCoding, 'ledger' | 'vat' | 'covers' | 'asset' | 'lines'>): BooksLine[] {
  if (books.lines?.length) return books.lines;
  return books.ledger ? [{ ledger: books.ledger, amount, ...(books.vat ? { vat: books.vat } : {}), ...(books.covers ? { covers: books.covers } : {}), ...(books.asset ? { asset: books.asset } : {}) }] : [];
}

/** Which row a coding is on: a company account's own row, or a row of yours paid for the company (its cost to the company). */
export type CodedRow = 'company' | 'paid-for';

/** Where a row is in a company's books: a row it can be coded as, and whose. */
export type CodingPlace = { row: CodedRow; companyId: string } | { problem: string };

/**
 * Whether a row takes a coding (`books`), and as what: a company account's own row (but not a leg of a
 * transfer between two of the company's own accounts, which posts by itself), or a row of yours marked
 * as paid for a company with a mark that counts (shared/company.ts, `markCounts`). Nothing else does.
 */
export function codingPlace(t: Pick<Transaction, 'accountId' | 'amount' | 'currency' | 'transferGroup' | 'counterpartyAccountId' | 'splits' | 'company'>, ctx: MarkContext): CodingPlace {
  const account = ctx.account(t.accountId);
  if (account?.companyId) {
    const other = t.transferGroup && t.counterpartyAccountId ? ctx.account(t.counterpartyAccountId) : undefined;
    if (other?.companyId === account.companyId) return { problem: `A transfer between the company’s own accounts posts by itself (${account.name} and ${other.name}): it takes no coding.` };
    return { row: 'company', companyId: account.companyId };
  }
  if (t.company?.as === 'paid-for' && markCounts(t, ctx)) return { row: 'paid-for', companyId: t.company.id };
  return { problem: 'Only a company account’s row, or a row of yours marked as paid for the company, is coded in its books.' };
}

/**
 * Why a coding does not fit its row, in words (an empty list: it fits). A coding is a ledger (or two or
 * more lines adding up to the row), each:
 * - a code of the chart a payment can be coded to: never one of the company's own accounts (money
 *   between them is a transfer, linked as one), nor the director's loan on a row of yours paid for the
 *   company (that row moves the loan already);
 * - not nothing, and lines add up to the row's amount;
 * - VAT signed like its line and no larger than it: none for zero rate, exempt or outside the scope;
 *   some for the standard and reduced rates and a reverse charge (whose VAT is the notional VAT on an
 *   amount that does not include it);
 * - a fixed asset only on a fixed asset's cost, of that class, with a life in whole months;
 * - a period it covers that does not end before it starts.
 */
export function codingProblems(amount: number, books: Pick<BooksCoding, 'ledger' | 'vat' | 'covers' | 'asset' | 'lines'>, row: CodedRow): string[] {
  const out: string[] = [];
  if (books.lines?.length && (books.ledger || books.vat || books.covers || books.asset)) out.push('A split codes each line: give its ledger, VAT, period and asset on the lines, not beside them.');
  if (!books.lines?.length && !books.ledger) out.push('Give a ledger to code it to, or split it across two or more.');
  if (books.lines && books.lines.length === 1) out.push('A split has two lines or more: code it to one ledger instead.');
  const lines = codingLines(amount, books);
  if (books.lines?.length) {
    const sum = lines.reduce((s, l) => s + toMinor(l.amount), 0);
    if (sum !== toMinor(amount)) out.push(`The lines add up to ${formatMoney(fromMinor(sum))}, not ${formatMoney(amount)}.`);
  }
  for (const [i, l] of lines.entries()) {
    const where = lines.length > 1 ? `Line ${i + 1}: ` : '';
    const entry = ledgerCode(l.ledger);
    if (!entry) {
      out.push(ledgerAccountId(l.ledger) || BY_CODE.get(l.ledger)?.account ? `${where}${l.ledger} is one of the company’s own accounts: money between them is a transfer, linked as one, not coded.` : `${where}there is no ledger "${l.ledger}" in the chart.`);
      continue;
    }
    if (entry.account) out.push(`${where}${entry.name} is one of the company’s own accounts: money between them is a transfer, linked as one, not coded.`);
    else if (!entry.codable) out.push(`${where}${entry.name} is posted by the books themselves or written in a journal: a payment is not coded to it.`);
    if (row === 'paid-for' && l.ledger === 'directors-loan') out.push(`${where}a payment of yours for the company moves your director’s loan already: code it to what it bought.`);
    if (toMinor(l.amount) === 0) out.push(`${where}a line of nothing.`);
    out.push(...vatProblems(l, where));
    if (l.asset && entry.asset?.part !== 'cost') out.push(`${where}a fixed asset is coded to a fixed asset’s cost.`);
    if (l.asset && entry.asset && l.asset.class !== entry.asset.class) out.push(`${where}${entry.name} is for ${FIXED_ASSET_CLASS_META[entry.asset.class].name.toLowerCase()}, not ${FIXED_ASSET_CLASS_META[l.asset.class].name.toLowerCase()}.`);
    if (l.covers && l.covers.from > l.covers.to) out.push(`${where}the period it covers ends (${formatDate(l.covers.to)}) before it starts (${formatDate(l.covers.from)}).`);
  }
  return out;
}

/** Why a line's VAT does not fit it, in words. */
function vatProblems(l: Pick<BooksLine, 'amount' | 'vat'>, where: string): string[] {
  if (!l.vat) return [];
  const vat = toMinor(l.vat.amount);
  const gross = toMinor(l.amount);
  const label = VAT_TREATMENT_LABELS[l.vat.treatment].toLowerCase();
  if (NO_VAT.has(l.vat.treatment)) return vat ? [`${where}${label} carries no VAT: its VAT is £0.`] : [];
  if (!vat) return [`${where}${label} carries VAT: give it, or say it is zero rate, exempt or outside the scope.`];
  if (Math.sign(vat) !== Math.sign(gross)) return [`${where}the VAT (${formatMoney(l.vat.amount)}) is signed the other way from the amount (${formatMoney(l.amount)}).`];
  if (Math.abs(vat) > Math.abs(gross)) return [`${where}the VAT (${formatMoney(l.vat.amount)}) is more than the amount (${formatMoney(l.amount)}).`];
  if (l.vat.treatment !== 'reverse-charge' && Math.abs(vat) === Math.abs(gross)) return [`${where}the VAT is the whole amount: code a payment of VAT alone to VAT, with no VAT of its own.`];
  return [];
}

// ─── Book rules ──────────────────────────────────────────────────────────────────────────────────

/** A rule that codes rows in a company's books (`set.books`, with `match.company`), not one that categorises yours. */
export const isBookRule = (r: Pick<Rule, 'match' | 'set'>): boolean => Boolean(r.match.company || r.set.books);

/**
 * Why a book rule does not fit, in words (empty: it fits), before its accounts are looked at: a coding
 * and a company go together, and it sets nothing of yours (no category, payee, tags or account); its
 * ledger is one a payment can be coded to (not the director's loan for rows of yours paid for the
 * company); a fixed asset only on that class's cost.
 */
export function ruleBooksProblems(r: Pick<Rule, 'match' | 'set'>): string[] {
  if (!isBookRule(r)) return [];
  const out: string[] = [];
  if (!r.match.company) out.push('A rule that codes rows in a company’s books names the company (`match.company`).');
  if (!r.set.books) out.push('A rule for a company’s rows codes them (`set.books`): your categories are not for its rows.');
  if (r.set.category || r.set.payee || r.set.tags?.length || r.set.counterpartyAccountId) out.push('A book rule only codes rows in the company’s books: it sets no category, payee, tags or account of yours.');
  const b = r.set.books;
  if (!b) return out;
  const entry = ledgerCode(b.ledger);
  if (!entry || entry.account || !entry.codable) out.push(entry ? `${entry.name} is not a ledger a payment is coded to.` : `There is no ledger "${b.ledger}" in the chart.`);
  if (b.ledger === 'directors-loan' && r.match.company && r.match.company.rows !== 'own') out.push('A payment of yours for the company moves your director’s loan already: a rule for those rows codes them to what they bought.');
  if (b.asset && entry?.asset?.part !== 'cost') out.push('A fixed asset is coded to a fixed asset’s cost.');
  if (b.asset && entry?.asset && b.asset.class !== entry.asset.class) out.push(`${entry.name} is not for ${FIXED_ASSET_CLASS_META[b.asset.class].name.toLowerCase()}.`);
  return out;
}

/**
 * What a book rule codes a row as: its ledger, its VAT (the treatment's amount on the row's day: the
 * VAT in it at the standard or reduced rate, the notional VAT for a reverse charge, none otherwise), its
 * asset, and the months it covers from the row's day.
 */
export function ruleCoding(r: Pick<Rule, 'id' | 'set'>, t: Pick<Transaction, 'amount' | 'date'>): BooksCoding | undefined {
  const b = r.set.books;
  if (!b) return undefined;
  const treatment = b.vat?.treatment;
  const amount = treatment === 'standard' || treatment === 'reduced' ? vatInGross(t.amount, t.date, treatment) : treatment === 'reverse-charge' ? reverseChargeVat(t.amount, t.date) : 0;
  return {
    ledger: b.ledger,
    ...(treatment ? { vat: { amount, treatment } } : {}),
    ...(b.coversMonths ? { covers: { from: t.date, to: lastDayOfMonths(t.date, b.coversMonths) } } : {}),
    ...(b.asset ? { asset: b.asset } : {}),
    setBy: 'rule',
    ruleId: r.id,
  };
}

// ─── Journals ────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a journal does not fit, in words (empty: it fits): two lines or more, none of nothing, adding up
 * to nothing (debits positive, credits negative); each on a code of the chart (an account of the
 * company's own only when it is that company's: `ownAccount`), never the ledger's own clearing codes;
 * a fixed asset only on a fixed asset's cost; periods that do not end before they start.
 */
export function journalProblems(j: Pick<Journal, 'lines'>, ownAccount: (accountId: string) => boolean): string[] {
  const out: string[] = [];
  if (j.lines.length < 2) out.push('A journal has two lines or more.');
  const sum = j.lines.reduce((s, l) => s + toMinor(l.amount), 0);
  if (sum !== 0) out.push(`Its lines add up to ${formatMoney(fromMinor(sum))}: debits (positive) and credits (negative) must add up to nothing.`);
  for (const [i, l] of j.lines.entries()) {
    const where = `Line ${i + 1}: `;
    const entry = ledgerCode(l.ledger);
    if (!entry) {
      out.push(`${where}there is no ledger "${l.ledger}" in the chart.`);
      continue;
    }
    if (entry.clearing) out.push(`${where}${entry.name} is the books’ own: code the payment it stands for instead.`);
    const accountId = ledgerAccountId(l.ledger);
    if (accountId && !ownAccount(accountId)) out.push(`${where}${l.ledger} is not one of the company’s own accounts.`);
    if (toMinor(l.amount) === 0) out.push(`${where}a line of nothing.`);
    if (l.asset && entry.asset?.part !== 'cost') out.push(`${where}a fixed asset is on a fixed asset’s cost.`);
    if (l.asset && entry.asset && l.asset.class !== entry.asset.class) out.push(`${where}${entry.name} is for ${FIXED_ASSET_CLASS_META[entry.asset.class].name.toLowerCase()}.`);
    if (l.covers && l.covers.from > l.covers.to) out.push(`${where}the period it covers ends before it starts.`);
  }
  return out;
}

// ─── Linking money with you to the company's own rows ───────────────────────────────────────────

/** Days apart a row of yours lent to (or repaid by) the company and its row may be, to be linked without you. */
export const AUTO_LINK_DAYS = 4;
/** Days apart an unlinked loan of yours and a company row coded to the director's loan may be, to be flagged as maybe the same money twice. */
export const DOUBLE_COUNT_DAYS = 10;
/** Days apart the rows of a link may be at most, linked by hand. */
export const LINK_DAYS = 31;

/**
 * The most a link's two sides may differ by, in pence, as a fee the company bears: 3% of your side (a
 * card processor's fee), at least £1 (a fixed charge) and at most £25. Linked automatically, the two
 * sides are the same to the penny.
 */
export const LINK_FEE = { percent: 3, minMinor: 100, maxMinor: 2_500 } as const;
export function linkTolerance(personalMinor: number): number {
  return Math.min(LINK_FEE.maxMinor, Math.max(LINK_FEE.minMinor, Math.round((Math.abs(personalMinor) * LINK_FEE.percent) / 100)));
}

interface LinkRow {
  id: string;
  date: ISODate;
  amount: number;
}

/**
 * Why a link group does not fit, in words, or undefined: the company's rows that say they are the
 * other side of rows of yours lent to it or repaid by it, and those rows of yours. One side has one row
 * (one of yours settled as several of the company's, or several of yours as one of its); every row of
 * yours is the same way round and every company row the other; at most `LINK_DAYS` apart; and what
 * arrived is no more than what was sent, short by at most `linkTolerance` of your side (`linkFeeMinor`:
 * a fee taken on the way, which the company bears).
 */
export function linkGroupProblem(personal: readonly LinkRow[], company: readonly LinkRow[]): string | undefined {
  if (!personal.length || !company.length) return 'A link joins a row of yours with a row of the company’s.';
  if (personal.length > 1 && company.length > 1) return 'Several rows of yours and several of the company’s cannot be one link: link one to many, or many to one.';
  const ps = new Set(personal.map((t) => Math.sign(t.amount)));
  const cs = new Set(company.map((t) => Math.sign(t.amount)));
  if (ps.size !== 1 || cs.size !== 1 || ps.has(0) || cs.has(0)) return 'Every row of yours goes one way and every row of the company’s the other.';
  if ([...ps][0] === [...cs][0]) return 'Money you lent the company arrives in its account, and money it paid you back leaves it: the two sides go opposite ways.';
  const dates = [...personal, ...company].map((t) => t.date).sort();
  const span = (Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000;
  if (span > LINK_DAYS) return `The rows are ${span} days apart: a link is at most ${LINK_DAYS}.`;
  const p = personal.reduce((s, t) => s + toMinor(t.amount), 0);
  const c = company.reduce((s, t) => s + toMinor(t.amount), 0);
  const fee = -(p + c);
  if (fee < 0) return `More arrived (${formatMoney(fromMinor(Math.min(Math.abs(p), Math.abs(c)) + Math.abs(fee)))}) than was sent (${formatMoney(fromMinor(Math.min(Math.abs(p), Math.abs(c))))}): a link allows only a fee taken on the way.`;
  if (fee > linkTolerance(p)) return `The two sides differ by ${formatMoney(fromMinor(fee))}, more than the ${formatMoney(fromMinor(linkTolerance(p)))} a fee may be (${LINK_FEE.percent}% of yours, at least ${formatMoney(fromMinor(LINK_FEE.minMinor))}, at most ${formatMoney(fromMinor(LINK_FEE.maxMinor))}).`;
  return undefined;
}

/** What a link group's two sides differ by, in pence: what was sent less what arrived (a fee taken on the way, which the company bears). */
export function linkFeeMinor(personal: readonly Pick<LinkRow, 'amount'>[], company: readonly Pick<LinkRow, 'amount'>[]): number {
  return -(personal.reduce((s, t) => s + toMinor(t.amount), 0) + company.reduce((s, t) => s + toMinor(t.amount), 0));
}

/** A link group: the company's rows that name rows of yours, and the rows of yours they name, joined wherever a row of yours is named twice. */
export interface LinkGroup {
  companyIds: string[];
  personalIds: string[];
}

/** The link groups among a company's rows (`companyLink`): rows naming one row of yours are one group. In id order, so the same rows give the same groups. */
export function linkGroups(companyRows: readonly Pick<Transaction, 'id' | 'companyLink'>[]): LinkGroup[] {
  const linked = companyRows.filter((t) => t.companyLink?.rows.length).sort((a, b) => a.id.localeCompare(b.id));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const t of linked) {
    join(`c:${t.id}`, `c:${t.id}`);
    for (const p of t.companyLink!.rows) join(`c:${t.id}`, `p:${p}`);
  }
  const groups = new Map<string, LinkGroup>();
  for (const key of [...parent.keys()].sort()) {
    const g = groups.get(find(key)) ?? groups.set(find(key), { companyIds: [], personalIds: [] }).get(find(key))!;
    if (key.startsWith('c:')) g.companyIds.push(key.slice(2));
    else g.personalIds.push(key.slice(2));
  }
  return [...groups.values()];
}

/** A company row linked to rows of yours (a link that names none, your "not linked", is not one). */
export const isLinked = (t: Pick<Transaction, 'companyLink'>): boolean => Boolean(t.companyLink?.rows.length);

/** A company row's coding that a link leaves as it is: none, or the director's loan alone (no split, no VAT). */
export const linkableCoding = (books: BooksCoding | undefined): boolean => !books || (books.ledger === 'directors-loan' && !books.lines?.length && !books.vat);

/**
 * Why a link group does not fit, in words, or undefined (`linkGroupProblem` for the amounts and days):
 * its company rows are one company's own account rows, not legs of a transfer between its accounts,
 * not coded to anything but the director's loan; the rows of yours they name are yours, marked as a
 * loan with that company, with marks that count.
 */
export function companyLinkProblem(group: LinkGroup, row: (id: string) => Transaction | undefined, ctx: MarkContext): string | undefined {
  const company = group.companyIds.map(row);
  const personal = group.personalIds.map(row);
  if (company.some((t) => !t) || personal.some((t) => !t)) return 'A row it links is no longer in your data.';
  const companyIds = new Set(company.map((t) => ctx.account(t!.accountId)?.companyId));
  if (companyIds.size !== 1 || companyIds.has(undefined)) return 'A link is between one company’s own rows and rows of yours.';
  const companyId = [...companyIds][0]!;
  for (const t of company) {
    const place = codingPlace(t!, ctx);
    if ('problem' in place) return place.problem;
    if (!linkableCoding(t!.books)) return `${formatMoney(t!.amount)} on ${formatDate(t!.date)} is coded to something other than the director’s loan: a row linked to money you lent or were repaid is the director’s loan.`;
  }
  for (const t of personal) {
    if (ctx.account(t!.accountId)?.companyId) return `${formatMoney(t!.amount)} on ${formatDate(t!.date)} is a company’s own row, not one of yours.`;
    if (t!.company?.id !== companyId || t!.company.as !== 'loan' || !markCounts(t!, ctx)) return `${formatMoney(t!.amount)} on ${formatDate(t!.date)} is not marked as a loan with ${ctx.company(companyId)?.name ?? companyId} (with a mark that counts).`;
  }
  return linkGroupProblem(personal as Transaction[], company as Transaction[]);
}
