// Companies you hold shares in (companies.json): the holding, what it is worth and how that was
// worked out, and the dividends it paid you (FORMULAS.md §9, "Shares in a company").

import { movesDirectorLoan } from '../../shared/company';
import type { CompanyView } from '../../shared/api';
import { diffDays, today } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Company } from '../../shared/schema';
import type { Store } from '../store';
import { BalanceEngine } from './balances';
import { DIVIDEND_MATCH_DAYS } from './allowances';
import { fromEmployer } from './pay';

/** Every company, with its dividends and its value now. */
export function companiesView(store: Store, engine?: BalanceEngine): CompanyView[] {
  return store.companies.map((c) => companyView(store, c, engine));
}

export function companyView(store: Store, c: Company, engine: BalanceEngine = new BalanceEngine(store)): CompanyView {
  // Its dividends: each voucher (a dividend figure naming it), with the bank credit that paid it (the
  // same amount, within 10 days, naming it); then credits of its dividends no voucher accounts for.
  const names = [c.name];
  const vouchers = store.figures.filter((f) => f.kind === 'dividends_paid' && f.payer && names.some((n) => fromEmployer({ description: f.payer!, payee: undefined, counterpartyName: undefined }, n))).sort((a, b) => (a.periodEnd ?? a.date ?? '').localeCompare(b.periodEnd ?? b.date ?? ''));
  // A credit you marked as a loan repaid (or a refund of a cost you paid for it) is not a dividend.
  const credits = store.transactions().filter((t) => t.amount > 0 && !movesDirectorLoan(t, store) && (t.category === 'dividends' || t.category === 'investment-income') && names.some((n) => fromEmployer(t, n)));
  const used = new Set<string>();
  const dividends: CompanyView['dividends'] = vouchers.map((f) => {
    const day = f.periodEnd ?? f.date;
    const paid = day
      ? credits.filter((t) => !used.has(t.id) && toMinor(t.amount) === toMinor(f.amount) && Math.abs(diffDays(day, t.date)) <= DIVIDEND_MATCH_DAYS).sort((a, b) => Math.abs(diffDays(day, a.date)) - Math.abs(diffDays(day, b.date)))[0]
      : undefined;
    if (paid) used.add(paid.id);
    return {
      date: day ?? paid?.date ?? '',
      amount: f.amount,
      ...(f.taxYear ? { taxYear: f.taxYear } : {}),
      figureId: f.id,
      ...(f.source.importId ? { importId: f.source.importId } : {}),
      ...(paid ? { paidIn: { transactionId: paid.id, accountId: paid.accountId, date: paid.date } } : {}),
    };
  });
  for (const t of credits) if (!used.has(t.id) && t.category === 'dividends') dividends.push({ date: t.date, amount: t.amount, paidIn: { transactionId: t.id, accountId: t.accountId, date: t.date } });
  dividends.sort((a, b) => a.date.localeCompare(b.date));

  // What it is worth now: the account's latest balance, which each valuation is recorded as.
  const latest = c.accountId ? store.balances(c.accountId).at(-1) : undefined;
  const valuation = [...c.valuations].sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1);
  // Your director's loan with it: its balance today, from the balance engine (FORMULAS.md §9).
  const loanAccount = c.directorLoanAccountId ? store.accounts.find((a) => a.id === c.directorLoanAccountId) : undefined;
  const loanNow = loanAccount ? engine.latest(loanAccount.id, today()) : null;
  // Its books are the company's own records, never part of this personal view (routes/company-books.ts serves them).
  const { books: _books, ...company } = c;
  return {
    company,
    ...(loanAccount ? { directorLoan: { accountId: loanAccount.id, name: loanAccount.name, balance: loanNow?.value ?? null, asOf: engine.lastDataDate(loanAccount.id), estimated: loanNow?.estimated ?? false } } : {}),
    ...(latest ? { value: { amount: latest.balance, date: latest.date, approximate: Boolean(latest.approximate) } } : {}),
    ...(valuation ? { valuation } : {}),
    dividends,
    dividendsTotal: fromMinor(dividends.reduce((x, d) => x + toMinor(d.amount), 0)),
  };
}
