// Money between you and a company of yours (docs/DATA_FORMAT.md, transactions, `company`): a payment of
// yours marked as paid for the company, a loan to it or from it, or pay or a dividend from it. The
// first two move your director's loan (FORMULAS.md §9, "A director's loan") and are not your spending
// or income (§14); pay and dividends stay your income.
//
// The mark lives on your own row, not on the company's: what counts as your spending never depends on
// whether the company's accounts are kept here too.

import { ACCOUNT_TYPE_META, balanceModeOf } from './accounts';
import { formatDate } from './dates';
import { formatMoney } from './money';
import type { Account, Company, CompanyMarkKind, Transaction } from './schema';

/** What each mark says, as the transaction shows it. */
export const COMPANY_MARK_LABELS: Record<CompanyMarkKind, string> = {
  'paid-for': 'Paid for the company',
  loan: 'Lent to the company, or paid back by it',
  pay: 'Pay from the company',
  dividend: 'Dividend from the company',
};

/** Marks that move your director's loan: the money is the company's debt to you (or yours to it), not your spending or income. */
export const DIRECTOR_LOAN_MARKS: ReadonlySet<CompanyMarkKind> = new Set(['paid-for', 'loan']);

/**
 * What a marked row did to the director's loan, in words: you paid a cost of the company's (or it was
 * refunded to you), you lent it money, or it paid you back. Only for marks that move the loan.
 */
export type DirectorLoanKind = 'paid-for' | 'refund' | 'lent' | 'repaid';
export function directorLoanKind(as: CompanyMarkKind, amount: number): DirectorLoanKind | undefined {
  if (as === 'paid-for') return amount < 0 ? 'paid-for' : 'refund';
  if (as === 'loan') return amount < 0 ? 'lent' : 'repaid';
  return undefined;
}

export const DIRECTOR_LOAN_KIND_LABELS: Record<DirectorLoanKind, string> = {
  'paid-for': 'Paid for the company',
  refund: 'Refund of a cost you paid for it',
  lent: 'Lent to the company',
  repaid: 'Paid back to you',
};

/** Why a mark does not fit its row, as a code (`markMisfit`): cheap enough to ask of every row. */
export type MarkMisfit = 'no-company' | 'no-account' | 'company-account' | 'derived' | 'market' | 'transfer' | 'zero' | 'pay-out' | 'currency' | 'split';

type MarkRow = Pick<Transaction, 'amount' | 'currency' | 'transferGroup' | 'splits'>;

/**
 * Whether a mark fits its row (docs/DATA_FORMAT.md, transactions), as a code, or undefined when it does:
 * - the company is in your data, and the row is on an account of yours (never a company's own) that
 *   moves with its rows (not an investment or pension valued at market, nor a director's loan);
 * - it is not linked as a transfer between your accounts (unlink it first) and not £0;
 * - pay and a dividend are money in; a payment that moves the director's loan is in pounds and not
 *   split across categories (it is not your spending at all).
 */
export function markMisfit(t: MarkRow, mark: { id: string; as: CompanyMarkKind }, account: Account | undefined, companyKnown: boolean): MarkMisfit | undefined {
  if (!companyKnown) return 'no-company';
  if (!account) return 'no-account';
  if (account.companyId) return 'company-account';
  if (ACCOUNT_TYPE_META[account.type].derived) return 'derived';
  if (balanceModeOf(account) === 'market') return 'market';
  if (t.transferGroup) return 'transfer';
  if (t.amount === 0) return 'zero';
  if ((mark.as === 'pay' || mark.as === 'dividend') && t.amount < 0) return 'pay-out';
  if (DIRECTOR_LOAN_MARKS.has(mark.as)) {
    if (t.currency !== 'GBP') return 'currency';
    if (t.splits?.length) return 'split';
  }
  return undefined;
}

/** Where a mark is judged: any account by id (a company's too, so its rows are refused), and your companies. */
export interface MarkContext {
  account(id: string): Account | undefined;
  company(id: string | undefined): Pick<Company, 'id' | 'name'> | undefined;
}

/**
 * The one test of whether a row's mark counts (the store, cashflow, the tax pages, pay, the queue and
 * the director's loan's movements all ask this): a mark that no longer fits its row (its account
 * became one valued at market, it was split, its company is gone) counts for nothing, and the row is
 * an ordinary row of yours everywhere. Data health lists such marks (`marksThatDoNotCount`).
 */
export function markCounts(t: MarkRow & Pick<Transaction, 'accountId' | 'company'>, ctx: MarkContext): boolean {
  return t.company !== undefined && markMisfit(t, t.company, ctx.account(t.accountId), Boolean(ctx.company(t.company.id))) === undefined;
}

/** Is this row money that moves a director's loan (paid for a company, or lent to it or repaid by it), with a mark that counts? */
export function movesDirectorLoan(t: MarkRow & Pick<Transaction, 'accountId' | 'company'>, ctx: MarkContext): boolean {
  return t.company !== undefined && DIRECTOR_LOAN_MARKS.has(t.company.as) && markCounts(t, ctx);
}

/** Why a row of yours cannot carry a mark, in words (`markMisfit`), or undefined when it can. */
export function companyMarkProblem(
  t: MarkRow & Pick<Transaction, 'date'>,
  mark: { id: string; as: CompanyMarkKind },
  ctx: { account: Account | undefined; company: Pick<Company, 'id' | 'name'> | undefined; companyName?: (id: string) => string | undefined },
): string | undefined {
  const misfit = markMisfit(t, mark, ctx.account, Boolean(ctx.company));
  if (!misfit) return undefined;
  const what = `${formatMoney(t.amount, { currency: t.currency })} on ${formatDate(t.date)}`;
  const account = ctx.account!;
  const name = ctx.company?.name ?? mark.id;
  switch (misfit) {
    case 'no-company':
      return `There is no company "${mark.id}" in your data.`;
    case 'no-account':
      return `${what} is on an account that is not in your data.`;
    case 'company-account':
      return `${what} is on ${account.name}, ${ctx.companyName?.(account.companyId!) ?? 'a company'}’s own account: a mark is for a payment of yours with a company.`;
    case 'derived':
      return `${account.name} is a director’s loan account: its movements are the payments you mark, never rows of its own.`;
    case 'market':
      return `${what} is on ${account.name}, which is valued at market: mark the payment on the account the money left or arrived in.`;
    case 'transfer':
      return `${what} is linked as a transfer between two of your accounts: money with ${name} is not that. Unlink it first.`;
    case 'zero':
      return `${what} moves no money.`;
    case 'pay-out':
      return `${what} is money out: ${mark.as === 'pay' ? 'pay' : 'a dividend'} from ${name} is money in.`;
    case 'currency':
      return `${what} is in ${t.currency}: a director’s loan is kept in pounds, so only a payment in pounds moves it.`;
    case 'split':
      return `${what} is split across categories: money ${mark.as === 'loan' ? 'lent to or repaid by' : 'paid for'} ${name} is not your spending, so take the split away first.`;
  }
}

/** The same mark: the same company, as the same thing (who set it aside). */
export function sameMark(a: { id: string; as: CompanyMarkKind } | null | undefined, b: { id: string; as: CompanyMarkKind } | null | undefined): boolean {
  return (a ?? null) === null ? (b ?? null) === null : Boolean(b) && a!.id === b!.id && a!.as === b!.as;
}
