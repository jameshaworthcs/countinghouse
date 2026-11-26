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
// Once the company keeps its books here (`Company.books`), the movements come from its books instead
// (ledger.ts, `ledgerDirectorLoanMovements`): its postings to the director's loan, which are your marked
// rows (or the company rows linked to them) and what only the books know (a journal, a company row coded
// to the loan). Without books, nothing changes.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import type { DirectorLoanMovement, DirectorLoanView, DirectorLoanWarning } from '../../shared/api';
import { directorLoanKind, movesDirectorLoan, type MarkContext } from '../../shared/company';
import { addDays, formatDate, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Account, Company, Transaction } from '../../shared/schema';
import { beneficialLoanThreshold, S455_DUE_MONTHS, S455_REBORROWING, s455Rate, s455RateHistory, taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { isLedgerSource, ledgerDirectorLoanMovements } from './ledger';

export type { DirectorLoanMovement, DirectorLoanWarning } from '../../shared/api';

/** A movement's id, from its source row's: `tx_<hex>` → `dlm_<hex>`. */
export const movementId = (transactionId: string): string => `dlm_${transactionId.replace(/^tx_/, '')}`;

/**
 * The movements of a company's director's loan, oldest first (source order within a day): every row
 * of yours marked as paid for it or a loan with it whose mark counts (shared/company.ts, `markCounts`:
 * the one test cashflow and every other figure use). A mark that no longer fits its row (its account
 * now valued at market, a split, a company gone) moves nothing, and its row is an ordinary row.
 */
export function directorLoanMovements(store: { transactions(accountId?: string): Transaction[] } & MarkContext, companyId: string): DirectorLoanMovement[] {
  const out: DirectorLoanMovement[] = [];
  for (const t of store.transactions()) {
    if (t.company?.id !== companyId || !movesDirectorLoan(t, store)) continue;
    const as = t.company.as as 'paid-for' | 'loan';
    out.push({
      id: movementId(t.id),
      source: 'mark',
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

/**
 * A company's director's loan's movements, from its source (FORMULAS.md §22, "The director's loan from
 * the books"): with its books kept here and a source that can give them (the store), its books' postings
 * to the director's loan; otherwise, the marks on your rows (`directorLoanMovements`).
 */
export function loanMovements(store: { transactions(accountId?: string): Transaction[] } & MarkContext, company: Pick<Company, 'id' | 'books'>): DirectorLoanMovement[] {
  return company.books && isLedgerSource(store) ? ledgerDirectorLoanMovements(store, company.id) : directorLoanMovements(store, company.id);
}

/** The company whose director's loan an account is, if it is one that a company names. */
export function directorLoanCompany(companies: readonly Company[] | undefined, accountId: string): Company | undefined {
  return companies?.find((c) => c.directorLoanAccountId === accountId);
}

/**
 * What the balance engine reads as a director's loan account's rows: its movements as rows of that
 * account (never written). A director's loan account no company names has none.
 */
export function directorLoanRows(store: { transactions(accountId?: string): Transaction[]; accounts: readonly Account[]; companies?: readonly Company[] | undefined }, account: Account): Transaction[] {
  if (!ACCOUNT_TYPE_META[account.type].derived) return [];
  const company = directorLoanCompany(store.companies, account.id);
  if (!company) return [];
  // With its books kept here, from them (the store gives them); otherwise from the marks, which the
  // engine's own accounts and companies judge, as the store does.
  const movements = company.books && isLedgerSource(store)
    ? ledgerDirectorLoanMovements(store, company.id)
    : directorLoanMovements({ transactions: (id?: string) => store.transactions(id), account: (id) => store.accounts.find((a) => a.id === id), company: (id) => store.companies?.find((c) => c.id === id) }, company.id);
  return movements.map((m) => ({ id: m.id, accountId: account.id, date: m.date, amount: m.amount, currency: account.currency, description: m.description, source: {} }));
}

const pct = (r: number) => `${(Math.round(r * 10_000) / 100).toString()}%`;

/** What you owe the company, by when you borrowed it: `date` null for what you owed before the first day known. */
export interface OwedLot {
  date: ISODate | null;
  amount: number;
}

/**
 * What you owe the company on `on`, split by when you borrowed it (each lot's date), from the
 * engine's balance on each day the loan moved (`dates`: its movements' days, and an anchor's day
 * moves it too, when given) and on `on`. A day the balance goes further below nothing is borrowing on
 * that day; a day it comes back up pays off the oldest borrowing first. What was owed before the first
 * of those days has no known date (`date: null`). The lots add up to what is owed on `on`.
 */
export function owedLots(engine: Pick<BalanceEngine, 'balanceOn'>, accountId: string, dates: readonly ISODate[], on: ISODate): OwedLot[] {
  const days = [...new Set([...dates.filter((d) => d <= on), on])].sort();
  const minorOn = (d: ISODate, fallback: number) => {
    const v = engine.balanceOn(accountId, d)?.value;
    return v === undefined ? fallback : toMinor(v);
  };
  let prev = minorOn(addDays(days[0]!, -1), 0);
  const lots: { date: ISODate | null; minor: number }[] = prev < 0 ? [{ date: null, minor: -prev }] : [];
  for (const d of days) {
    const now = minorOn(d, prev);
    const [before, after] = [Math.max(0, -prev), Math.max(0, -now)];
    if (after > before) lots.push({ date: d, minor: after - before });
    let repaid = before - after;
    while (repaid > 0 && lots.length) {
      const take = Math.min(repaid, lots[0]!.minor);
      lots[0]!.minor -= take;
      repaid -= take;
      if (!lots[0]!.minor) lots.shift();
    }
    prev = now;
  }
  return lots.filter((l) => l.minor > 0).map((l) => ({ date: l.date, amount: fromMinor(l.minor) }));
}

/** The s455 rates by when the money was lent, in words: "25% before 6 April 2016, 32.5% to 5 April 2022, …". */
function rateHistoryWords(on: ISODate): string {
  return s455RateHistory(on)
    .map((r, i, all) => `${pct(r.rate)} ${i === 0 ? `before ${formatDate(all[1]?.from ?? on)}` : i === all.length - 1 ? `from ${formatDate(r.from)}` : `from ${formatDate(r.from)} to ${formatDate(addDays(all[i + 1]!.from, -1))}`}`)
    .join(', ');
}

/**
 * The warnings a director's loan carries on a day (docs/UK_RULES.md, "Companies"), from its balance
 * then, what you owe by when you borrowed it (`lots`, `owedLots`), and the most you owed the company at
 * any time in that day's tax year (`owedMost`, positive):
 * - you owe the company (the balance is below nothing): if it is a close company and you are a
 *   participator, it owes tax under CTA 2010 s455 on what is still owed 9 months and a day after the
 *   end of the accounting period it was lent in, at the dividend upper rate of the tax year it was
 *   lent (said for each lot), unless repaid by then (s458: else reclaimed later), with repaying and
 *   borrowing again not counting as repaid (s464ZA), and a loan written off taxed as your income
 *   (ITTOIA 2005 s415). The company's year end is not known here, so no date is given;
 * - you owed it more than the beneficial loan threshold at some time in the tax year: a taxable
 *   benefit unless you paid interest at the official rate, with Class 1A National Insurance for the
 *   company (ITEPA 2003 s180).
 */
export function directorLoanWarnings(companyName: string, balance: number | null, owedMost: { amount: number; date: ISODate } | null, on: ISODate, lots: readonly OwedLot[] = []): DirectorLoanWarning[] {
  const out: DirectorLoanWarning[] = [];
  const ty = taxYearOf(on);
  if (balance !== null && balance < 0) {
    // What is owed, by the tax year it was borrowed in, each at its year's rate; what has no known date, by the table.
    const byYear = new Map<string, { minor: number; rate: number }>();
    let undated = 0;
    for (const l of lots) {
      if (!l.date) {
        undated += toMinor(l.amount);
        continue;
      }
      const label = taxYearOf(l.date).label;
      const e = byYear.get(label) ?? byYear.set(label, { minor: 0, rate: s455Rate(l.date) }).get(label)!;
      e.minor += toMinor(l.amount);
    }
    const dated = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([label, e]) => `${formatMoney(fromMinor(e.minor))} borrowed in ${label}, at ${pct(e.rate)}`);
    const earliest = lots.find((l) => l.date)?.date;
    if (undated || !lots.length) dated.push(`${lots.length ? formatMoney(fromMinor(undated)) : 'what you owe'} borrowed ${earliest ? `before ${formatDate(earliest)}` : 'at a time not known here'}, at the rate of the year it was borrowed (${rateHistoryWords(on)})`);
    out.push({
      kind: 's455',
      title: `You owe ${companyName} ${formatMoney(-balance)}`,
      detail:
        `If ${companyName} is a close company (most owner-managed companies are) and you are a participator in it, such as a shareholder, it owes Corporation Tax on what you still owe ${S455_DUE_MONTHS} months and a day after the end of the accounting period you borrowed it in (CTA 2010 s455), at the dividend upper rate of the tax year you borrowed it: ${dated.join('; ')}. ` +
        `Paid back by then, none is due on what you paid back (s458). Paid back later, the company can claim the tax back, but not until ${S455_DUE_MONTHS} months after the end of the accounting period in which you paid it back, and within 4 years of the end of the financial year you paid it back in. ` +
        `Paying back ${formatMoney(S455_REBORROWING.repaid, { decimals: 0 })} or more and borrowing ${formatMoney(S455_REBORROWING.repaid, { decimals: 0 })} or more again within ${S455_REBORROWING.days} days, the new borrowing in a later accounting period, does not count as paying back (s464ZA), unless what pays it back is taxed as your income (a dividend or salary); nor does paying back while ${formatMoney(S455_REBORROWING.owedWithArrangements, { decimals: 0 })} or more is owed when you plan to borrow ${formatMoney(S455_REBORROWING.repaid, { decimals: 0 })} or more again. ` +
        `If the company writes off what you owe instead, its s455 tax is relieved, but the amount is taxed as your income (ITTOIA 2005 s415). Check the company’s year end and its accounts.`,
    });
  }
  const threshold = beneficialLoanThreshold(ty);
  if (owedMost && owedMost.amount > threshold) {
    out.push({
      kind: 'beneficial-loan',
      title: `You owed ${companyName} more than ${formatMoney(threshold, { decimals: 0 })} in ${ty.label}`,
      detail: `${formatMoney(owedMost.amount)} on ${formatDate(owedMost.date)}. A loan from a company you work for (as a director or an employee) that is over ${formatMoney(threshold, { decimals: 0 })} at any time in a tax year is a taxable benefit, unless you paid it interest at HMRC’s official rate (ITEPA 2003 s180): the company reports it and owes Class 1A National Insurance on it, and you pay income tax on it.`,
    });
  }
  return out;
}

/** The days a director's loan moved: its movements' and its recorded balances' (an anchor moves it too). */
export function loanDays(store: Pick<Store, 'balances'>, accountId: string, movements: readonly { date: ISODate }[]): ISODate[] {
  return [...movements.map((m) => m.date), ...store.balances(accountId).map((b) => b.date)];
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
export function directorLoanView(store: Pick<Store, 'companies' | 'transactions' | 'account' | 'company' | 'balances'>, engine: Pick<BalanceEngine, 'balanceOn'>, account: Account, on: ISODate): DirectorLoanView {
  const company = directorLoanCompany(store.companies, account.id);
  if (!company) return { movements: [], warnings: [] };
  const movements = loanMovements(store, company)
    .map((m) => ({ ...m, accountName: m.accountId ? (store.account(m.accountId)?.name ?? m.accountId) : 'Journal' }))
    .reverse();
  const balance = engine.balanceOn(account.id, on)?.value ?? null;
  const owedMost = owedMostInTaxYear(engine, account.id, on);
  const lots = balance !== null && balance < 0 ? owedLots(engine, account.id, loanDays(store, account.id, movements), on) : [];
  return { company: { id: company.id, name: company.name }, movements, warnings: directorLoanWarnings(company.name, balance, owedMost, on, lots), ...(owedMost ? { owedMost } : {}) };
}
