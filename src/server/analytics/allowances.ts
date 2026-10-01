// UK tax-year allowances: ISA (and the cash-ISA cap from 2027/28), LISA, pension annual allowance
// with carry-forward, Personal Savings Allowance and the dividend allowance.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { DIVIDEND_WORDING } from '../../shared/categorise';
import type { AllowanceLine, AllowancesResponse, TaxBandEstimate } from '../../shared/api';
import { addDays, diffDays, formatDate, maxDate, minDate, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Figure, Transaction } from '../../shared/schema';
import {
  ageOn,
  cashIsaLimit,
  daysLeftInTaxYear,
  parseTaxYear,
  pensionAnnualAllowance,
  personalSavingsAllowance,
  RULE_NOTES,
  taxBandFor,
  taxYear as makeTaxYear,
  taxYearOf,
  taxYearParams,
  type TaxYear,
} from '../../shared/uk';
import type { Store } from '../store';
import { covers, importIntervals, mergeIntervals, type Interval } from './coverage';
import { fromEmployer, isPayslipFigure, pairPay, payerKey } from './pay';
import { payByEmployer } from './sources';
import { yearSoFar } from './payslips';
import { namesOf } from '../employments';

export { payByEmployer };

const inYear = (t: { date: string }, ty: TaxYear) => t.date >= ty.start && t.date <= ty.end;

/** Slack when deciding whether an account's data covers a stretch: statements arrive on their own dates. */
export const COVERAGE_SLACK_DAYS = 45;

/**
 * Accounts whose data does not cover the tax year (up to `on` for the current one): what they show
 * for the year is a minimum. Returns a sentence saying which, or null when every account is covered.
 */
export function yearCoverageGap(store: Store, accounts: Account[], ty: TaxYear, on: ISODate, what: string): string | null {
  const short: { name: string; from: ISODate | null }[] = [];
  for (const a of accounts) {
    if (a.closedOn && a.closedOn < ty.start) continue;
    // An account's data need only reach from when it opened to when it closed.
    const start = maxDate(ty.start, a.openedOn) ?? ty.start;
    const end = minDate(ty.end, on, a.closedOn)!;
    if (start > end) continue;
    const span = wrapperDataSpan(store, a);
    if (span.some((i) => diffDays(start, i.from) <= COVERAGE_SLACK_DAYS && diffDays(i.to, end) <= COVERAGE_SLACK_DAYS)) continue;
    short.push({ name: a.name, from: span.find((i) => i.to >= start)?.from ?? null });
  }
  if (!short.length) return null;
  const who = short.map((x) => (x.from && x.from > ty.start ? `${x.name} (data from ${formatDate(x.from)})` : x.name)).join(', ');
  return `Not counted yet: ${what} before your data starts, for ${who}. Import statements from ${formatDate(ty.start)}, or set an account's opening date if it opened later.`;
}
const TRANSFER_OUT = new Set(['savings-transfer', 'investment-transfer', 'transfer']);

/**
 * The periods a wrapper account's own records cover: its imported statements' periods, or the span
 * of its transactions when it has no import records.
 */
export function wrapperDataSpan(store: Store, account: Account): Interval[] {
  const intervals = importIntervals(store, account.id);
  const txs = store.transactions(account.id);
  if (!intervals.length && txs.length) intervals.push({ from: txs[0]!.date, to: txs[txs.length - 1]!.date });
  return mergeIntervals(intervals);
}

/** Money into a wrapper account in the tax year that counts as a new subscription/contribution. */
export function wrapperContributions(store: Store, account: Account, ty: TaxYear): { minor: number; lines: AllowanceLine[] } {
  let minor = 0;
  const ids: string[] = [];
  const own = store.transactions(account.id).filter((t) => inYear(t, ty));
  for (const t of own) {
    if (t.amount > 0 && t.category === 'contribution') {
      minor += toMinor(t.amount);
      ids.push(t.id);
    }
  }
  if (account.flexibleIsa) {
    for (const t of own) if (t.amount < 0 && t.category === 'withdrawal') minor += toMinor(t.amount);
    minor = Math.max(0, minor);
  }
  // Payments recorded only in the paying account. Where the wrapper's own statements cover the
  // date (allowing 10 days for the money to arrive), they are the record and the payment is not
  // counted again.
  const span = wrapperDataSpan(store, account);
  const oneSided: Transaction[] = [];
  for (const other of store.accounts) {
    if (other.id === account.id || balanceModeOf(other) !== 'ledger') continue;
    for (const t of store.transactions(other.id)) {
      if (!inYear(t, ty) || t.amount >= 0 || t.transferGroup) continue;
      if (t.counterpartyAccountId !== account.id || !t.category || !TRANSFER_OUT.has(t.category)) continue;
      if (covers(span, t.date) || covers(span, addDays(t.date, 10))) continue;
      oneSided.push(t);
    }
  }
  for (const t of oneSided) {
    minor += -toMinor(t.amount);
    ids.push(t.id);
  }
  const lines: AllowanceLine[] = minor
    ? [{ accountId: account.id, label: account.name, amount: fromMinor(minor), source: 'transactions', transactionIds: ids }]
    : [];
  return { minor, lines };
}

function providerFigure(store: Store, accountId: string, ty: TaxYear): number | null {
  const snaps = store.balances(accountId).filter((b) => b.taxYear === ty.label && b.taxYearContributions !== undefined);
  const latest = snaps[snaps.length - 1];
  return latest ? toMinor(latest.taxYearContributions!) : null;
}

function sumCategory(store: Store, accounts: Account[], ty: TaxYear, category: string, sign: 1 | -1 = 1, match?: RegExp) {
  let minor = 0;
  const lines: AllowanceLine[] = [];
  for (const a of accounts) {
    const hits = store.transactions(a.id).filter((t) => inYear(t, ty) && t.category === category && Math.sign(t.amount) === sign && (!match || match.test(t.description)));
    const m = hits.reduce((s, t) => s + toMinor(t.amount), 0) * sign;
    if (m) {
      minor += m;
      lines.push({ accountId: a.id, label: a.name, amount: fromMinor(m), source: 'transactions', transactionIds: hits.map((t) => t.id) });
    }
  }
  return { minor, lines };
}

/** Days either side of a dividend's payment date that the credit paying it may fall on. */
export const DIVIDEND_MATCH_DAYS = 10;

/**
 * Dividends outside ISAs and pensions in the tax year, each counted once (FORMULAS.md §12): a voucher
 * and the bank credit that paid it are one dividend. A credit is a voucher's when it is the same
 * amount to the penny, within 10 days of the payment date, and names the company. That is the rule an
 * interest certificate follows for its account's interest. Credits no voucher accounts for count as
 * they are; so does a voucher whose payment is not in your data.
 */
export function dividendsOf(store: Store, ty: TaxYear): { minor: number; lines: AllowanceLine[] } {
  const ledger = store.accounts.filter((a) => !ACCOUNT_TYPE_META[a.type].taxFreeInterest && balanceModeOf(a) === 'ledger');
  const gias = store.accounts.filter((a) => a.type === 'gia' && !ledger.includes(a));
  const credits = [
    ...ledger.flatMap((a) => store.transactions(a.id).filter((t) => inYear(t, ty) && t.category === 'dividends' && t.amount > 0)),
    ...gias.flatMap((a) => store.transactions(a.id).filter((t) => inYear(t, ty) && t.category === 'investment-income' && t.amount > 0 && DIVIDEND_WORDING.test(t.description))),
  ];
  const vouchers = store.figures.filter((f) => f.taxYear === ty.label && f.kind === 'dividends_paid').sort((a, b) => (a.periodEnd ?? a.date ?? '').localeCompare(b.periodEnd ?? b.date ?? ''));
  const used = new Set<string>();
  const lines: AllowanceLine[] = [];
  let minor = 0;
  for (const f of vouchers) {
    const day = f.periodEnd ?? f.date;
    const paid = day && f.payer
      ? credits
          .filter((t) => !used.has(t.id) && toMinor(t.amount) === toMinor(f.amount) && Math.abs(diffDays(day, t.date)) <= DIVIDEND_MATCH_DAYS && fromEmployer(t, f.payer!))
          .sort((a, b) => Math.abs(diffDays(day, a.date)) - Math.abs(diffDays(day, b.date)))[0]
      : undefined;
    if (paid) used.add(paid.id);
    minor += toMinor(f.amount);
    lines.push({
      label: `${f.payer ?? f.label} (voucher${paid ? `, paid into ${store.account(paid.accountId)?.name ?? paid.accountId} on ${formatDate(paid.date)}` : ''})`,
      amount: f.amount,
      source: 'figure',
      ...(day ? { date: day } : {}),
      ...(paid ? { accountId: paid.accountId, transactionIds: [paid.id] } : {}),
    });
  }
  for (const a of [...ledger, ...gias]) {
    const rest = credits.filter((t) => t.accountId === a.id && !used.has(t.id));
    if (!rest.length) continue;
    const m = rest.reduce((x, t) => x + toMinor(t.amount), 0);
    minor += m;
    lines.push({ accountId: a.id, label: a.name, amount: fromMinor(m), source: 'transactions', transactionIds: rest.map((t) => t.id) });
  }
  return { minor, lines };
}

/** A pension account whose contributions get basic-rate relief added by the provider. */
const reliefAtSourceAccount = (a: Account) => a.type === 'sipp' || a.type === 'personal_pension' || a.pension?.method === 'relief_at_source';

/** The one pension account an import updated, when it updated exactly one: its statement's figures are that account's. */
function pensionAccountOfImport(store: Store, importId: string | undefined): string | undefined {
  if (!importId) return undefined;
  const ids = [...new Set(store.imports.find((i) => i.id === importId)?.sections.map((s) => s.accountId) ?? [])].filter((id) => {
    const a = store.account(id);
    return a && ACCOUNT_TYPE_META[a.type].pension && a.type !== 'state_pension' && a.type !== 'db_pension';
  });
  return ids.length === 1 ? ids[0] : undefined;
}

/** One pension scheme's contributions for a tax year, in pence. */
export interface SchemeYear {
  key: string;
  accountId?: string;
  label: string;
  /** What you paid in (for relief at source, before the provider's relief). */
  personal: number;
  /** What you paid in, gross: with the relief at source added. */
  personalGross: number;
  employer: number;
  relief: number;
  reliefAtSource: boolean;
  source: 'transactions' | 'figure';
  transactionIds: string[];
  figureIds: string[];
  /** Said about the figures: relief at source estimated when none was recorded. */
  note?: string;
}

const PENSION_FIGURES = ['pension_contribution_employee', 'pension_contribution_employer', 'pension_tax_relief'] as const;

/**
 * The year's pension contributions, scheme by scheme (FORMULAS.md §14):
 * - each pension account from its own rows;
 * - a pension statement's figures for the year replace its account's rows, kind by kind, as an
 *   interest certificate does (the account it names, else the one pension account the same statement
 *   updated);
 * - payslip deductions are their employer's scheme, and that statement's money when they add up to
 *   its figure to the penny;
 * - anything else from documents is a scheme of its own.
 * Schemes add up: a SIPP's and a workplace scheme's contributions are both counted.
 */
export function pensionTotals(store: Store, ty: TaxYear) {
  const pensionAccounts = store.accounts.filter((a) => ACCOUNT_TYPE_META[a.type].pension && a.type !== 'state_pension' && a.type !== 'db_pension');
  const rate = taxYearParams(ty).reliefAtSourceRate;
  const schemes = new Map<string, SchemeYear>();
  for (const a of pensionAccounts) {
    const contrib = wrapperContributions(store, a, ty);
    const emp = sumCategory(store, [a], ty, 'employer-contribution');
    const rel = sumCategory(store, [a], ty, 'tax-relief');
    const ras = reliefAtSourceAccount(a);
    let gross = contrib.minor;
    let note: string | undefined;
    if (ras) {
      if (rel.minor) gross = contrib.minor + rel.minor;
      else if (contrib.minor) {
        gross = Math.round(contrib.minor / (1 - rate));
        note = `${a.name}: no tax-relief payments recorded yet, so basic-rate relief at source (${Math.round(rate * 100)}% of the gross) is estimated.`;
      }
    }
    if (!contrib.minor && !emp.minor && !rel.minor) continue;
    schemes.set(a.id, {
      key: a.id,
      accountId: a.id,
      label: a.name,
      personal: contrib.minor,
      personalGross: gross,
      employer: emp.minor,
      relief: rel.minor,
      reliefAtSource: ras,
      source: 'transactions',
      transactionIds: [...(contrib.lines[0]?.transactionIds ?? []), ...(emp.lines[0]?.transactionIds ?? []), ...(rel.lines[0]?.transactionIds ?? [])],
      figureIds: [],
      ...(note ? { note } : {}),
    });
  }

  const figs = store.figures.filter((f) => f.taxYear === ty.label && (PENSION_FIGURES as readonly string[]).includes(f.kind));
  const of = (list: Figure[], kind: (typeof PENSION_FIGURES)[number]) => list.filter((f) => f.kind === kind);
  const minorOf = (list: Figure[]) => list.reduce((x, f) => x + toMinor(f.amount), 0);
  // Pension statements: by the scheme they are about.
  const statements = new Map<string, Figure[]>();
  for (const f of figs.filter((x) => !isPayslipFigure(store, x))) {
    const key = f.accountId ?? pensionAccountOfImport(store, f.source.importId) ?? (f.source.importId ? `document:${f.source.importId}` : `payer:${payerKey(f.payer)}`);
    (statements.get(key) ?? statements.set(key, []).get(key)!).push(f);
  }
  for (const [key, list] of statements) {
    const account = store.account(key);
    const before = schemes.get(key);
    const [employee, employer, relief] = [of(list, 'pension_contribution_employee'), of(list, 'pension_contribution_employer'), of(list, 'pension_tax_relief')];
    // Relief the statement shows is relief at source, whatever the account.
    const ras = account ? reliefAtSourceAccount(account) || relief.length > 0 : relief.length > 0;
    const personal = employee.length ? minorOf(employee) : (before?.personal ?? 0);
    const reliefMinor = relief.length ? minorOf(relief) : (before?.relief ?? 0);
    // A statement's own relief figure makes its payments gross; without one, what it says you paid is
    // taken as the gross (docs/INGESTION.md: a lone total is the gross).
    const personalGross = employee.length || relief.length ? personal + (ras ? reliefMinor : 0) : (before?.personalGross ?? 0);
    schemes.set(key, {
      key,
      ...(account ? { accountId: account.id } : {}),
      label: account?.name ?? list.find((f) => f.payer)?.payer ?? 'A pension statement',
      personal,
      personalGross,
      employer: employer.length ? minorOf(employer) : (before?.employer ?? 0),
      relief: reliefMinor,
      reliefAtSource: ras,
      source: 'figure',
      transactionIds: before?.transactionIds ?? [],
      figureIds: list.map((f) => f.id),
      // The statement's own payments replace the estimate made from the rows.
      ...(before?.note && !employee.length && !relief.length ? { note: before.note } : {}),
    });
  }
  // Payslip deductions: by job (else employer). A job whose payslips were read in full counts the year
  // to date they print (analytics/payslips.ts), which has the employer's contributions too. The same
  // money as a statement's when they add up to it to the penny.
  const payslips = new Map<string, Figure[]>();
  for (const f of figs.filter((x) => isPayslipFigure(store, x))) {
    const key = f.employmentId ? `job:${f.employmentId}` : payerKey(f.payer);
    (payslips.get(key) ?? payslips.set(key, []).get(key)!).push(f);
  }
  for (const p of store.payslips) if (p.taxYear === ty.label && p.employmentId && (p.yearToDate.pension || p.yearToDate.pensionEmployer) && !payslips.has(`job:${p.employmentId}`)) payslips.set(`job:${p.employmentId}`, []);
  for (const [key, list] of payslips) {
    const job = key.startsWith('job:') ? key.slice(4) : undefined;
    // A job whose pension goes into an account that has its own records this year (its rows or its
    // statement) is counted there: the job says which (`pensionAccountId`), or the account names it.
    const employment = store.employment(job);
    const linked = employment ? pensionAccounts.filter((a) => a.id === employment.pensionAccountId || (a.pension?.employer && namesOf(employment).some((n) => payerKey(n) === payerKey(a.pension!.employer)))) : [];
    if (linked.some((a) => schemes.has(a.id))) continue;
    const soFar = (kind: 'pension_contribution_employee' | 'pension_contribution_employer') => (job ? yearSoFar(store, job, ty, kind, list) : undefined);
    const employee = soFar('pension_contribution_employee') ? toMinor(soFar('pension_contribution_employee')!.amount) : minorOf(of(list, 'pension_contribution_employee'));
    const employer = soFar('pension_contribution_employer') ? toMinor(soFar('pension_contribution_employer')!.amount) : minorOf(of(list, 'pension_contribution_employer'));
    const statementOf = [...statements.keys()].map((k) => schemes.get(k)!).find((s) => (employee && s.personal === employee) || (!employee && employer && s.employer === employer));
    if (statementOf) continue;
    if (!employee && !employer) continue;
    schemes.set(`payslips:${key}`, {
      key: `payslips:${key}`,
      label: `${store.employment(job)?.employer ?? list.find((f) => f.payer)?.payer ?? 'Your employer'} (payslips)`,
      personal: employee,
      personalGross: employee,
      employer,
      relief: 0,
      reliefAtSource: false,
      source: 'figure',
      transactionIds: [],
      figureIds: list.map((f) => f.id),
    });
  }

  const all = [...schemes.values()];
  const total = (pick: (s: SchemeYear) => number) => all.reduce((x, s) => x + pick(s), 0);
  const personal = total((s) => s.personal);
  const personalGross = total((s) => s.personalGross);
  const employer = total((s) => s.employer);
  const relief = total((s) => s.relief);
  const lines: AllowanceLine[] = all.map((s) => ({
    ...(s.accountId ? { accountId: s.accountId } : {}),
    label: `${s.label}: you ${fromMinor(s.personal).toFixed(2)}${s.relief ? `, relief ${fromMinor(s.relief).toFixed(2)}` : ''}${s.employer ? `, employer ${fromMinor(s.employer).toFixed(2)}` : ''}${s.source === 'figure' && !s.key.startsWith('payslips:') ? ' (its statement)' : ''}`,
    amount: fromMinor(s.personalGross + s.employer),
    source: s.source,
    ...(s.transactionIds.length ? { transactionIds: s.transactionIds } : {}),
  }));
  const notes = all.flatMap((s) => (s.note ? [s.note] : []));
  return { personal, personalGross, employer, relief, total: personalGross + employer, lines, notes, hasAccounts: pensionAccounts.length > 0, schemes: all };
}

/** Relief-at-source pensions (SIPPs, personal pensions) and your gross contributions to them in the year. */
export function reliefAtSource(store: Store, ty: TaxYear, pen: ReturnType<typeof pensionTotals> = pensionTotals(store, ty)) {
  const accounts = store.accounts.filter(reliefAtSourceAccount);
  const grossMinor = pen.schemes.filter((s) => s.reliefAtSource && s.accountId && accounts.some((a) => a.id === s.accountId)).reduce((x, s) => x + s.personalGross, 0);
  return { accounts, personalGross: fromMinor(grossMinor) };
}

/** Charity payments in the year, the ones tagged "gift-aid", Gift Aid figures from documents, and what was paid under Gift Aid. */
export function giftAid(store: Store, ty: TaxYear) {
  const charity = store.transactions().filter((t) => inYear(t, ty) && t.category === 'charity' && t.amount < 0);
  const aided = charity.filter((t) => t.tags?.some((tag) => tag.toLowerCase() === 'gift-aid'));
  const figures = store.figures.filter((f) => f.kind === 'gift_aid_donation' && (f.taxYear === ty.label || (!f.taxYear && inYear({ date: f.periodEnd ?? f.date ?? '' }, ty))));
  const paid = fromMinor(-aided.reduce((s, t) => s + toMinor(t.amount), 0) + figures.reduce((s, f) => s + toMinor(f.amount), 0));
  return { charity, aided, figures, paid };
}

/** Salary received in the year from employers the figures do not cover (after tax: a floor). */
export function unexplainedSalary(store: Store, ty: TaxYear, employers: { payer: string; names?: string[] }[]): Transaction[] {
  // Figures that name no employer cannot be told apart: take them to cover the salary received.
  if (employers.some((e) => !payerKey(e.payer))) return [];
  // Any name an employer's figures give it (its P60's, its payslips', HMRC's).
  const keys = [...new Set(employers.flatMap((e) => [e.payer, ...(e.names ?? [])]).map((n) => payerKey(n).slice(0, 8)))].filter((k) => k.length >= 4);
  // Pay the Pay tab pairs with a payslip, or puts under an employer with payslips, is that employer's.
  const { periods, others } = pairPay(store, ty);
  const explained = new Set([...periods.flatMap((p) => (p.credit ? [p.credit.id] : [])), ...others.flatMap((o) => (o.employer ? [o.t.id] : []))]);
  return store.transactions().filter((t) => inYear(t, ty) && t.category === 'salary' && t.amount > 0 && !explained.has(t.id) && !keys.some((k) => payerKey(`${t.description} ${t.payee ?? ''}`).includes(k)));
}

const figuresFor = (store: Store, ty: TaxYear, kind: Figure['kind']) =>
  store.figures.filter((f) => f.kind === kind && (f.taxYear === ty.label || (!f.taxYear && inYear({ date: f.periodEnd ?? f.date ?? '' }, ty))));

/**
 * The tax band the year's income reaches, from your data: pay (P60 and payslip figures, else your
 * salary in Settings or last year's P60 for the year in progress, else net pay received as a
 * minimum), side income over the trading allowance, and the interest and dividends counted for the
 * allowances. Relief-at-source pension contributions and Gift Aid widen the bands. FORMULAS.md §11.
 */
export function taxBandEstimate(store: Store, ty: TaxYear, now: ISODate, found: { interest: number; dividends: number }): TaxBandEstimate {
  const params = taxYearParams(ty);
  const lines: TaxBandEstimate['lines'] = [];
  const notes: string[] = [];
  const sum = (list: Figure[]) => fromMinor(list.reduce((s, f) => s + toMinor(f.amount), 0));
  let basis: TaxBandEstimate['basis'];
  const inProgress = ty.end >= now;
  // Each employer's pay, from the one source that counts (sources.ts): its P60 or another figure for
  // the whole year, else the latest of its documents to date and its payslips so far. Salary received
  // from an employer with none of them counts too, after tax, as a floor.
  const employers = payByEmployer(store, ty);
  const net = unexplainedSalary(store, ty, employers);
  const netTotal = fromMinor(net.reduce((s, t) => s + toMinor(t.amount), 0));
  const documented = fromMinor(employers.reduce((s, e) => s + toMinor(e.amount), 0) + toMinor(netTotal));
  const lastYearP60 = payByEmployer(store, makeTaxYear(ty.startYear - 1)).filter((e) => e.final);
  // For the year in progress a full-year estimate wins over pay to date when it is larger.
  const fullYear = inProgress ? (store.profile.grossSalary ?? fromMinor(lastYearP60.reduce((s, e) => s + toMinor(e.amount), 0))) : 0;
  if (fullYear > 0 && fullYear > documented) {
    basis = 'estimate';
    lines.push(
      store.profile.grossSalary
        ? { label: 'Pay (your salary in Settings)', amount: store.profile.grossSalary, kind: 'pay' }
        : { label: `Pay (last year’s, ${makeTaxYear(ty.startYear - 1).label})`, amount: fullYear, kind: 'pay' },
    );
  } else {
    for (const e of employers) {
      lines.push({ label: `Pay from ${e.payer || 'your employer'} (${e.source.label})`, amount: e.amount, kind: 'pay' });
    }
    if (net.length) lines.push({ label: `Other pay (at least: ${net.length} salary payment${net.length === 1 ? '' : 's'} received, after tax)`, amount: netTotal, kind: 'pay' });
    basis = employers.length && employers.every((e) => e.final) && !net.length ? 'documents' : 'minimum';
    if (basis === 'minimum') {
      notes.push(
        employers.length
          ? `Pay for ${ty.label} is known only so far${net.length ? ', and some of it only after tax' : ''}, so the band may be higher. Each employer’s P60 settles it.`
          : `No gross pay is known for ${ty.label}, so only the income found counts and the band may be higher. Import your P60${inProgress ? ' or your payslips, or add your salary in Settings' : ''}.`,
      );
    }
  }
  const benefits = figuresFor(store, ty, 'benefit_in_kind');
  if (benefits.length) lines.push({ label: 'Benefits in kind (P11D)', amount: sum(benefits), kind: 'pay' });
  const side = store.transactions().filter((t) => inYear(t, ty) && t.category === 'side-income' && t.amount > 0);
  const turnover = fromMinor(side.reduce((s, t) => s + toMinor(t.amount), 0) + figuresFor(store, ty, 'self_employment_income').reduce((s, f) => s + toMinor(f.amount), 0));
  if (turnover > params.tradingAllowance) {
    lines.push({ label: 'Side income over the trading allowance', amount: fromMinor(toMinor(turnover) - toMinor(params.tradingAllowance)), kind: 'self-employment' });
    notes.push('Side income counts as turnover less the trading allowance; your expenses may make the profit lower.');
  }
  if (found.interest > 0) lines.push({ label: 'Interest outside ISAs', amount: found.interest, kind: 'interest' });
  if (found.dividends > 0) lines.push({ label: 'Dividends outside ISAs', amount: found.dividends, kind: 'dividends' });
  const ras = reliefAtSource(store, ty).personalGross;
  const gift = giftAid(store, ty).paid;
  const giftGross = fromMinor(Math.round(toMinor(gift) / (1 - params.reliefAtSourceRate)));
  if (ras > 0) lines.push({ label: 'Pension contributions with relief at source (gross): widen the bands', amount: ras, kind: 'extension' });
  if (giftGross > 0) lines.push({ label: 'Gift Aid donations (gross): widen the bands', amount: giftGross, kind: 'extension' });
  const of = (kind: TaxBandEstimate['lines'][number]['kind']) => fromMinor(lines.filter((l) => l.kind === kind).reduce((s, l) => s + toMinor(l.amount), 0));
  const r = taxBandFor(ty, { nonSavings: of('pay') + of('self-employment'), savings: of('interest'), dividends: of('dividends'), bandExtension: of('extension') });
  if (store.profile.taxRegion === 'scotland') notes.push('Scottish rates on pay are not modelled; this uses the UK bands, which are the ones savings and dividends use.');
  return { band: r.band, basis, lines, total: r.total, personalAllowance: r.personalAllowance, taxable: r.taxable, higherFrom: r.higherFrom, additionalFrom: r.additionalFrom, notes };
}

export function allowances(store: Store, label?: string, now: ISODate = today()): AllowancesResponse {
  const ty = (label ? parseTaxYear(label) : null) ?? taxYearOf(now);
  const params = taxYearParams(ty);
  const dob = store.profile.dateOfBirth;
  const current = now >= ty.start && now <= ty.end;

  // ISA.
  const isaAccounts = store.accounts.filter((a) => ACCOUNT_TYPE_META[a.type].isa);
  let isaUsed = 0;
  let cashUsed = 0;
  let lisaUsed = 0;
  const isaLines: AllowanceLine[] = [];
  const lisaLines: AllowanceLine[] = [];
  const isaNotes: string[] = [];
  for (const a of isaAccounts) {
    const provider = providerFigure(store, a.id, ty);
    const computed = wrapperContributions(store, a, ty);
    const minor = provider ?? computed.minor;
    const line: AllowanceLine | undefined = provider !== null
      ? { accountId: a.id, label: `${a.name} (as reported by the provider)`, amount: fromMinor(provider), source: 'provider' }
      : computed.lines[0];
    if (!minor || !line) continue;
    isaUsed += minor;
    isaLines.push(line);
    const kind = ACCOUNT_TYPE_META[a.type].isa;
    if (kind === 'cash') cashUsed += minor;
    if (kind === 'lisa') {
      lisaUsed += minor;
      lisaLines.push(line);
    }
  }
  if (isaAccounts.length && !isaLines.length) isaNotes.push('No ISA subscriptions found for this tax year. Import ISA statements or the transfers from your current account.');
  // A provider's "paid in this tax year" figure is complete; otherwise the transactions must cover the year.
  const isaIncomplete = yearCoverageGap(store, isaAccounts.filter((a) => providerFigure(store, a.id, ty) === null), ty, now, 'subscriptions');
  const lisaIncomplete = yearCoverageGap(store, isaAccounts.filter((a) => a.type === 'lisa' && providerFigure(store, a.id, ty) === null), ty, now, 'contributions');
  isaNotes.push('Transfers between ISAs do not use allowance; they are excluded when recorded as transfers.');

  const cashLimit = cashIsaLimit(ty, dob);
  if (params.cashIsaLimitUnder65 !== null) {
    isaNotes.push(
      dob && ageOn(dob, ty.end) >= 65
        ? 'You reach 65 in or before this tax year, so the full £20,000 can go into cash ISAs.'
        : `From 2027/28, at most £${cashLimit.toLocaleString('en-GB')} of your ISA allowance can go into cash ISAs while you are under 65.`,
    );
  }

  // LISA.
  const lisaAccounts = isaAccounts.filter((a) => a.type === 'lisa');
  let lisa: AllowancesResponse['lisa'] = null;
  if (lisaAccounts.length) {
    const bonus = sumCategory(store, lisaAccounts, ty, 'government-bonus');
    const notes: string[] = [];
    if (dob) {
      const age = ageOn(dob, ty.start);
      if (age >= 50) notes.push('You are 50 or over, so LISA contributions and bonuses have stopped.');
    } else notes.push('Add your date of birth in Settings to check LISA age limits.');
    notes.push(`The ${Math.round(params.lisaBonusRate * 100)}% bonus is paid monthly by HMRC on contributions up to £${params.lisaAllowance.toLocaleString('en-GB')} a year.`);
    const allowance = toMinor(params.lisaAllowance);
    lisa = {
      allowance: params.lisaAllowance,
      contributed: fromMinor(lisaUsed),
      remaining: fromMinor(Math.max(0, allowance - lisaUsed)),
      bonusReceived: fromMinor(bonus.minor),
      bonusExpected: fromMinor(Math.round(Math.min(lisaUsed, allowance) * params.lisaBonusRate)),
      lines: [...lisaLines, ...bonus.lines.map((l) => ({ ...l, label: `${l.label}: bonus received` }))],
      notes,
      incomplete: lisaIncomplete,
    };
  }

  // Pensions, with carry-forward from the previous three years. A year counts only when its
  // contributions are known: every pension account's statements cover the whole year, or pension
  // statements gave the year's totals. Otherwise the unused amount is unknown, never assumed.
  const pen = pensionTotals(store, ty);
  const aa = pensionAnnualAllowance(ty);
  const pensionAccounts = store.accounts.filter((a) => ACCOUNT_TYPE_META[a.type].pension && a.type !== 'state_pension' && a.type !== 'db_pension');
  const carryForward: AllowancesResponse['pension']['carryForward'] = [];
  for (let back = 3; back >= 1; back--) {
    const prev = makeTaxYear(ty.startYear - back);
    const existed = pensionAccounts.filter((a) => store.transactions(a.id).some((t) => t.date <= prev.end) || store.balances(a.id).some((b) => b.date <= prev.end) || (a.openedOn !== undefined && a.openedOn <= prev.end));
    const figures = store.figures.some((f) => f.taxYear === prev.label && (f.kind === 'pension_contribution_employee' || f.kind === 'pension_contribution_employer'));
    const fullyCovered = existed.length > 0 && existed.every((a) => {
      const span = wrapperDataSpan(store, a);
      return span.some((i) => diffDays(prev.start, i.from) <= 45 && diffDays(i.to, prev.end) <= 45);
    });
    if (!existed.length && !figures) {
      carryForward.push({ taxYear: prev.label, unused: null, basis: 'No pension data for this year. If you were in a pension scheme, import its statement to count what you left unused.' });
      continue;
    }
    if (!fullyCovered && !figures) {
      carryForward.push({ taxYear: prev.label, unused: null, basis: 'Contributions for this year are not fully known: import statements covering the whole year.' });
      continue;
    }
    const used = pensionTotals(store, prev).total;
    carryForward.push({ taxYear: prev.label, unused: fromMinor(Math.max(0, toMinor(pensionAnnualAllowance(prev)) - used)), basis: figures ? 'From pension statement totals' : 'From statements covering the whole year' });
  }
  const pensionFigures = store.figures.some((f) => f.taxYear === ty.label && (f.kind === 'pension_contribution_employee' || f.kind === 'pension_contribution_employer'));
  const pensionIncomplete = pensionFigures ? null : yearCoverageGap(store, pensionAccounts, ty, now, 'contributions');
  const pensionNotes = [...pen.notes];
  if ((store.profile.grossSalary ?? 0) > params.pensionTaperThresholdIncome) {
    pensionNotes.push(`Your salary is above £${params.pensionTaperThresholdIncome.toLocaleString('en-GB')}, so the tapered annual allowance may apply (down to £${params.pensionTaperMinimum.toLocaleString('en-GB')}).`);
  }
  pensionNotes.push('Salary-sacrifice contributions usually appear as employer contributions on pension statements.');

  // Savings interest vs PSA (interest outside ISAs and pensions).
  const taxable = store.accounts.filter((a) => !ACCOUNT_TYPE_META[a.type].taxFreeInterest);
  const interest = sumCategory(store, taxable, ty, 'interest');
  const interestFigures = store.figures.filter((f) => f.taxYear === ty.label && f.kind === 'interest_paid');
  let interestMinor = interest.minor;
  const interestLines = [...interest.lines];
  for (const f of interestFigures) {
    const covered = f.accountId ? interestLines.findIndex((l) => l.accountId === f.accountId) : -1;
    if (covered >= 0) {
      interestMinor += toMinor(f.amount) - toMinor(interestLines[covered]!.amount);
      interestLines[covered] = { accountId: f.accountId!, label: `${store.account(f.accountId!)?.name ?? f.payer ?? 'Interest'} (interest statement)`, amount: f.amount, source: 'figure' };
    } else {
      interestMinor += toMinor(f.amount);
      interestLines.push({ label: `${f.payer ?? f.label} (interest statement)`, amount: f.amount, source: 'figure', ...(f.accountId ? { accountId: f.accountId } : {}) });
    }
  }
  // Interest statements for the year are complete; otherwise the accounts' data must cover it.
  const interestIncomplete = yearCoverageGap(
    store,
    taxable.filter((a) => balanceModeOf(a) === 'ledger' && !ACCOUNT_TYPE_META[a.type].liability && !interestFigures.some((f) => f.accountId === a.id)),
    ty,
    now,
    'interest',
  );
  // Dividends outside ISAs and pensions, each counted once: a voucher and the credit that paid it are one.
  const dividends = dividendsOf(store, ty);
  const dividendsMinor = dividends.minor;

  // The band, and with it the Personal Savings Allowance, follows from the year's income.
  const taxBand = taxBandEstimate(store, ty, now, { interest: fromMinor(interestMinor), dividends: fromMinor(dividendsMinor) });
  const band = taxBand.band;
  const psa = personalSavingsAllowance(ty, band);
  const savingsNotes: string[] = [];
  if (taxBand.basis !== 'documents') {
    savingsNotes.push(
      taxBand.basis === 'estimate'
        ? `Your ${band === 'none' ? 'band' : `${band}-rate band`} is estimated from ${taxBand.lines.find((l) => l.kind === 'pay')?.label.replace(/^Pay \((.*)\)$/, '$1') ?? 'your income'}; your P60 settles it.`
        : `Your band is worked out from the income found so far, so it may be higher. Import your P60 to settle it.`,
    );
  }
  savingsNotes.push('Premium Bond prizes and ISA interest are tax-free and not counted.');

  const ruleNotes = RULE_NOTES.filter((n) => n.from > addYearsISO(ty.start, -1) && n.from <= addYearsISO(ty.end, 2)).map((n) => `${n.from}: ${n.text}`);

  return {
    taxYear: { label: ty.label, start: ty.start, end: ty.end, daysLeft: current ? daysLeftInTaxYear(now) : null, current },
    isa: {
      allowance: params.isaAllowance,
      used: fromMinor(isaUsed),
      remaining: fromMinor(Math.max(0, toMinor(params.isaAllowance) - isaUsed)),
      cashLimit,
      cashUsed: fromMinor(cashUsed),
      lines: isaLines,
      notes: isaNotes,
      incomplete: isaIncomplete,
    },
    lisa,
    pension: {
      annualAllowance: aa,
      personal: fromMinor(pen.personal),
      personalGross: fromMinor(pen.personalGross),
      employer: fromMinor(pen.employer),
      relief: fromMinor(pen.relief),
      total: fromMinor(pen.total),
      remaining: fromMinor(Math.max(0, toMinor(aa) - pen.total)),
      carryForward,
      lines: pen.lines,
      notes: pensionNotes,
      incomplete: pensionIncomplete,
    },
    savings: { interest: fromMinor(interestMinor), allowance: psa, band, bandBasis: taxBand.basis, remaining: fromMinor(Math.max(0, toMinor(psa) - interestMinor)), lines: interestLines, notes: savingsNotes, incomplete: interestIncomplete },
    dividends: {
      amount: fromMinor(dividendsMinor),
      allowance: params.dividendAllowance,
      remaining: fromMinor(Math.max(0, toMinor(params.dividendAllowance) - dividendsMinor)),
      lines: dividends.lines,
    },
    taxBand,
    ruleNotes,
  };
}

function addYearsISO(date: string, years: number): string {
  return `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;
}
