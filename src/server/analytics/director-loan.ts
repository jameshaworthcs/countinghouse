// A director's loan (docs/FORMULAS.md §9, "A director's loan"): what a company of yours owes you, on
// an account of yours of type `director_loan` that its company names (`Company.directorLoanAccountId`).
//
// The account has no rows of its own. Its movements are worked out here from the payments of yours
// you marked as paid for the company or lent to it (or repaid by it), and handed to the balance engine
// as that account's rows, where the balances you record on it (the figure in the company's filed
// accounts) anchor them as statement balances anchor a bank account. So staleness, gaps, what the
// estate is known on and the chart all come from the engine's usual paths. Nothing here is written.
//
// Each movement is the negated amount of the row it comes from: money out of your account into the
// company's costs or its bank grows what it owes you, money in from it shrinks it. The row itself is
// neither spending nor income (cashflow.ts) and stays in its own account's balance, so marking a row
// moves value between two of your accounts and never makes or loses any.
//
// A later source (the company's own books' postings to the director's loan) will join these here,
// with the two matched so nothing counts twice.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import type { DirectorLoanMovement, DirectorLoanView, DirectorLoanWarning } from '../../shared/api';
import { directorLoanKind, movesDirectorLoan } from '../../shared/company';
import { addDays, formatDate, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Account, Company, Transaction } from '../../shared/schema';
import { beneficialLoanThreshold, S455_DUE_MONTHS, S455_REBORROWING, s455Rate, taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';

export type { DirectorLoanMovement, DirectorLoanWarning } from '../../shared/api';

/** A movement's id, from its source row's: `tx_<hex>` → `dlm_<hex>`. */
export const movementId = (transactionId: string): string => `dlm_${transactionId.replace(/^tx_/, '')}`;

/**
 * The movements of a company's director's loan, oldest first (source order within a day): every row
 * of yours marked as paid for it or a loan with it, in pounds, not linked as a transfer between your
 * accounts (a row that breaks those rules by a hand edit is left out; reading the data warns of it).
 */
export function directorLoanMovements(store: { transactions(accountId?: string): Transaction[] }, companyId: string): DirectorLoanMovement[] {
  const out: DirectorLoanMovement[] = [];
  for (const t of store.transactions()) {
    if (!movesDirectorLoan(t) || t.company!.id !== companyId || t.transferGroup || t.currency !== 'GBP' || !t.amount) continue;
    const as = t.company!.as as DirectorLoanMovement['as'];
    out.push({
      id: movementId(t.id),
      transactionId: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: fromMinor(-toMinor(t.amount)),
      as,
      kind: directorLoanKind(as, t.amount)!,
      description: t.description,
      ...(t.payee ? { payee: t.payee } : {}),
    });
  }
  return out;
}

/** The company whose director's loan an account is, if it is one that a company names. */
export function directorLoanCompany(companies: readonly Company[] | undefined, accountId: string): Company | undefined {
  return companies?.find((c) => c.directorLoanAccountId === accountId);
}

/**
 * What the balance engine reads as a director's loan account's rows: its movements as rows of that
 * account (never written). A director's loan account no company names has none.
 */
export function directorLoanRows(store: { transactions(accountId?: string): Transaction[]; companies?: readonly Company[] | undefined }, account: Account): Transaction[] {
  if (!ACCOUNT_TYPE_META[account.type].derived) return [];
  const company = directorLoanCompany(store.companies, account.id);
  if (!company) return [];
  return directorLoanMovements(store, company.id).map((m) => ({ id: m.id, accountId: account.id, date: m.date, amount: m.amount, currency: account.currency, description: m.description, source: {} }));
}

const pct = (r: number) => `${(Math.round(r * 10_000) / 100).toString()}%`;

/**
 * The warnings a director's loan carries on a day (docs/UK_RULES.md, "Companies"), from its balance
 * then and the most you owed the company at any time in that day's tax year (`owedMost`, positive):
 * - you owe the company (the balance is below nothing): it may owe tax under CTA 2010 s455 on what is
 *   still owed 9 months and a day after the end of its accounting period, at the dividend upper rate of
 *   the tax year the money was lent, unless repaid by then (s458), with repaying and borrowing again
 *   not counting as repaid (s464ZA). The company's year end is not known here, so no date is given;
 * - you owed it more than the beneficial loan threshold at some time in the tax year: a taxable
 *   benefit unless you paid interest at the official rate (ITEPA 2003 s180).
 */
export function directorLoanWarnings(companyName: string, balance: number | null, owedMost: { amount: number; date: ISODate } | null, on: ISODate): DirectorLoanWarning[] {
  const out: DirectorLoanWarning[] = [];
  const ty = taxYearOf(on);
  if (balance !== null && balance < 0) {
    const owed = formatMoney(-balance);
    const rate = s455Rate(on);
    const before = s455Rate(addDays(ty.start, -1));
    out.push({
      kind: 's455',
      title: `You owe ${companyName} ${owed}`,
      detail:
        `If any of it is still owed ${S455_DUE_MONTHS} months and a day after the end of the company’s accounting period it was lent in, the company owes Corporation Tax on what is still owed (CTA 2010 s455): ` +
        `${pct(rate)} of money lent in ${ty.label}${before !== rate ? ` (${pct(before)} for money lent before ${formatDate(ty.start)})` : ''}, the dividend upper rate of the tax year it was lent. ` +
        `Paid back before then, none is due on what was paid back (s458), and tax paid is refunded once it is paid back later. ` +
        `Paying back ${formatMoney(S455_REBORROWING.repaid, { decimals: 0 })} or more and borrowing as much again within ${S455_REBORROWING.days} days, or while ${formatMoney(S455_REBORROWING.owedWithArrangements, { decimals: 0 })} or more is owed with plans to borrow again, does not count as paying back (s464ZA). Check the company’s year end and its accounts.`,
    });
  }
  const threshold = beneficialLoanThreshold(ty);
  if (owedMost && owedMost.amount > threshold) {
    out.push({
      kind: 'beneficial-loan',
      title: `You owed ${companyName} more than ${formatMoney(threshold, { decimals: 0 })} in ${ty.label}`,
      detail: `${formatMoney(owedMost.amount)} on ${formatDate(owedMost.date)}. A loan from a company you work for (as a director or an employee) that is over ${formatMoney(threshold, { decimals: 0 })} at any time in a tax year is a taxable benefit, unless you paid it interest at HMRC’s official rate (ITEPA 2003 s180): the company reports it, and you pay tax on it.`,
    });
  }
  return out;
}

/** The most you owed the company (a balance below nothing) on any day of `on`'s tax year up to `on`, from the engine. */
export function owedMostInTaxYear(engine: Pick<BalanceEngine, 'balanceOn'>, accountId: string, on: ISODate): { amount: number; date: ISODate } | null {
  let most: { minor: number; date: ISODate } | null = null;
  for (let d = taxYearOf(on).start; d <= on; d = addDays(d, 1)) {
    const v = engine.balanceOn(accountId, d)?.value;
    if (v === undefined || v >= 0) continue;
    const minor = -toMinor(v);
    if (!most || minor > most.minor) most = { minor, date: d };
  }
  return most ? { amount: fromMinor(most.minor), date: most.date } : null;
}

/** A director's loan account's page: its company, its movements (newest first, each with its source row's account) and its warnings. */
export function directorLoanView(store: Pick<Store, 'companies' | 'transactions' | 'account'>, engine: Pick<BalanceEngine, 'balanceOn'>, account: Account, on: ISODate): DirectorLoanView {
  const company = directorLoanCompany(store.companies, account.id);
  if (!company) return { movements: [], warnings: [] };
  const movements = directorLoanMovements(store, company.id)
    .map((m) => ({ ...m, accountName: store.account(m.accountId)?.name ?? m.accountId }))
    .reverse();
  const balance = engine.balanceOn(account.id, on)?.value ?? null;
  const owedMost = owedMostInTaxYear(engine, account.id, on);
  return { company: { id: company.id, name: company.name }, movements, warnings: directorLoanWarnings(company.name, balance, owedMost, on), ...(owedMost ? { owedMost } : {}) };
}
