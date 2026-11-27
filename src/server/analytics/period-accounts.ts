// A company's accounts for one accounting period (docs/FORMULAS.md §22, "The period's accounts"): its
// trial balance, profit and loss account and balance sheet in the micro-entity formats (exact and in
// whole pounds, as Companies House takes them), its fixed asset register, the director's loan over the
// period, its bank reconciled against the balance engine, and what stops it being ready, all worked out
// from its general ledger (analytics/ledger.ts). Pure but for the ledger it reads; nothing is stored.
//
// This is company data: one company's books at a time, served only from its own routes
// (routes/company-books.ts), never joining a figure of yours (ESLint's allowlist, eslint.config.js).

import type { AccountsCheck, AccountsPeriodChoice, BalanceSheet, BankReconciliation, CompanyAccountsResponse, LedgerCheck, LedgerPosting, LoanStatement, ProfitAndLoss, RegisterRow, ReportCode, TrialBalance } from '../../shared/api';
import { accountingPeriodsOf, type BooksPeriod } from '../../shared/company-books';
import { addDays, type ISODate } from '../../shared/dates';
import { accountLedger, LEDGER_CODES, ledgerCode, ledgerName, PROFIT_LINE_LABELS, SHEET_LINE_LABELS, type ProfitLine, type SheetLine } from '../../shared/ledger';
import { roundToPounds, toMinor } from '../../shared/money';
import { depreciationTo } from '../../shared/period-end';
import { MICRO_ENTITY_LINES, type Company } from '../../shared/schema';
import type { BalanceEngine } from './balances';
import { companyLedger, ledgerDirectorLoanMovements, type Ledger, type LedgerSource } from './ledger';

const PROFIT_LINES: ProfitLine[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const SHEET_LINES: SheetLine[] = ['A', 'B', 'C', 'D', 'E', 'H', 'I', 'J', 'K'];
/** Lines whose codes are presented as debit balances (assets); the rest as credit balances. */
const DEBIT_LINES = new Set<string>(['A', 'B', 'C', 'D']);
/** The ledger's own clearing codes: a balance on either at a period's end stops it being ready. */
const CLEARING = ['suspense', 'bank-not-imported'];

/** Whether a code is a profit and loss code (closed to retained earnings at each period's end). */
const isProfit = (code: string) => {
  const kind = ledgerCode(code)?.kind;
  return kind === 'income' || kind === 'expense';
};

/** The date a ledger check is about, if it has one: a check dated after a period's end does not stop that period. */
function checkDate(c: LedgerCheck): ISODate | undefined {
  return 'date' in c ? c.date : undefined;
}

/**
 * The accounting periods the Accounts tab offers, newest first: those that reach the books' first day
 * (`ledgerFrom`, else incorporation), up to the one containing `today`.
 */
export function accountsPeriods(company: Company, today: ISODate): BooksPeriod[] {
  const books = company.books;
  if (!books) return [];
  const first = books.ledgerFrom ?? books.incorporatedOn;
  return accountingPeriodsOf(books, today)
    .filter((p) => p.end >= first)
    .reverse();
}

/** Balances by code from postings (pence, debit positive), those `keep` admits. */
function balances(postings: readonly LedgerPosting[], keep: (p: LedgerPosting) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of postings) if (keep(p)) out.set(p.ledger, (out.get(p.ledger) ?? 0) + p.amount);
  return out;
}
const sumOf = (m: ReadonlyMap<string, number>, test: (code: string) => boolean) => [...m].reduce((s, [code, v]) => s + (test(code) ? v : 0), 0);

export interface PeriodAccountsInput {
  src: LedgerSource;
  company: Company;
  /** The company's own balance engine (analytics/company-accounts.ts): the bank reconciliation's other side. */
  engine: Pick<BalanceEngine, 'balanceOn'>;
  today: ISODate;
  /** The period's last day; absent: the latest period ended, or the current one when none has. */
  period?: ISODate | undefined;
  /** The ledger, when the caller has it already. */
  ledger?: Ledger;
}

/**
 * A company's accounts for one accounting period (FORMULAS.md §22, "The period's accounts"), or
 * undefined when it has no such period (none kept here, or not one of `accountsPeriods`).
 */
export function periodAccounts({ src, company, engine, today, period: wanted, ledger: given }: PeriodAccountsInput): CompanyAccountsResponse | undefined {
  const books = company.books;
  if (!books) return undefined;
  const offered = accountsPeriods(company, today);
  const period = wanted ? offered.find((p) => p.end === wanted) : (offered.find((p) => p.end < today) ?? offered[0]);
  if (!period) return undefined;
  // Worked out to the end of the latest period offered, so each one shown holds its period-end postings.
  const ledger = given ?? companyLedger(src, company.id, { until: offered[0]!.end });
  const { start, end } = period;
  const accountsFiling = (e: ISODate) => books.filings.find((f) => f.kind === 'accounts' && f.periodEnd === e);
  const choice = (p: BooksPeriod): AccountsPeriodChoice => {
    const f = accountsFiling(p.end);
    const lines = f?.kind === 'accounts' && f.figures ? Object.values(f.figures).some((v) => v !== undefined) : false;
    return { start: p.start, end: p.end, ended: p.end < today, ...(f ? { filed: { filedOn: f.filedOn, ...(f.reference ? { reference: f.reference } : {}), lines } } : {}) };
  };
  const openingJournals = new Set(src.companyJournals(company.id).filter((j) => j.opening).map((j) => j.id));
  const atEnd = balances(ledger.postings, (p) => p.date <= end);
  const before = balances(ledger.postings, (p) => p.date < start);
  const inPeriod = (code: string) => (atEnd.get(code) ?? 0) - (before.get(code) ?? 0);
  // Retained earnings written in the period by an opening journal are the opening balance, not a movement.
  const openingInPeriod = ledger.postings.filter((p) => p.ledger === 'retained-earnings' && p.date >= start && p.date <= end && p.source.kind === 'journal' && openingJournals.has(p.source.id)).reduce((s, p) => s + p.amount, 0);
  const name = (code: string) => ledgerName(code, (id) => src.account(id)?.name);

  // Profit and loss for the period: each code's movement, on its line (by its sign where it can be either).
  const profitCodes = [...atEnd.keys()].filter(isProfit).sort();
  const lines = PROFIT_LINES.map((line) => ({ line, label: PROFIT_LINE_LABELS[line], amount: 0, codes: [] as ReportCode[] }));
  for (const code of profitCodes) {
    const movement = inPeriod(code);
    if (!movement) continue;
    const entry = ledgerCode(code)!;
    const line = movement > 0 ? (entry.profitDebit ?? entry.profit!) : entry.profit!;
    const target = lines.find((l) => l.line === line)!;
    target.amount -= movement;
    target.codes.push({ ledger: code, name: name(code), amount: -movement });
  }
  const profitBeforeTax = lines.filter((l) => l.line !== 'G').reduce((s, l) => s + l.amount, 0);
  const tax = lines.find((l) => l.line === 'G')!.amount;
  const profitAndLoss: ProfitAndLoss = { lines, profitBeforeTax, tax, profit: profitBeforeTax + tax };

  // Retained earnings: everything before the period closed into it, and its own movements.
  const profitBefore = sumOf(before, isProfit);
  const reOpeningBooks = (before.get('retained-earnings') ?? 0) + profitBefore + (before.get('dividends') ?? 0) + openingInPeriod;
  const reOtherBooks = inPeriod('retained-earnings') - openingInPeriod;
  const dividends = inPeriod('dividends');

  // Trial balance at the end: balance sheet codes to date, profit and loss codes and dividends for the
  // period, retained earnings as at its start (with its own movements in the period).
  const tbRows: TrialBalance['rows'] = [];
  const tbCodes = new Set([...atEnd.keys(), 'retained-earnings']);
  for (const code of [...tbCodes].sort(byChart)) {
    const v = isProfit(code) || code === 'dividends' ? inPeriod(code) : code === 'retained-earnings' ? reOpeningBooks + reOtherBooks : (atEnd.get(code) ?? 0);
    if (!v) continue;
    tbRows.push({ ledger: code, name: name(code), debit: Math.max(0, v), credit: Math.max(0, -v) });
  }
  const trialBalance: TrialBalance = { rows: tbRows, debit: tbRows.reduce((s, r) => s + r.debit, 0), credit: tbRows.reduce((s, r) => s + r.credit, 0) };

  // The balance sheet: every balance sheet code but capital and reserves, on its line by its sign.
  const sheet = new Map<SheetLine, ReportCode[]>(SHEET_LINES.map((l) => [l, []]));
  for (const [code, balance] of [...atEnd].sort(([a], [b]) => byChart(a, b))) {
    if (!balance || isProfit(code)) continue;
    const entry = ledgerCode(code);
    if (entry?.kind === 'equity') continue;
    // A code outside the chart (never written: every write is checked) is shown, not lost.
    const line = entry?.sheet ? (balance > 0 ? entry.sheet.debit : entry.sheet.credit) : balance > 0 ? 'C' : 'E';
    sheet.get(line)!.push({ ledger: code, name: name(code), amount: DEBIT_LINES.has(line) ? balance : -balance });
  }
  const exact = (l: SheetLine) => sheet.get(l)!.reduce((s, c) => s + c.amount, 0);
  const whole = (l: SheetLine) => roundToPounds(exact(l));
  const [eA, eB, eC, eD, eE, eH, eI, eJ] = (['A', 'B', 'C', 'D', 'E', 'H', 'I', 'J'] as const).map(exact) as [number, number, number, number, number, number, number, number];
  const [wA, wB, wC, wD, wE, wH, wI, wJ] = (['A', 'B', 'C', 'D', 'E', 'H', 'I', 'J'] as const).map(whole) as [number, number, number, number, number, number, number, number];
  const eF = eC + eD - eE;
  const eG = eA + eB + eF;
  const eK = eG - eH - eI - eJ;
  const wF = wC + wD - wE;
  const wG = wA + wB + wF;
  const wK = wG - wH - wI - wJ;
  const shareCapital = -(atEnd.get('share-capital') ?? 0);
  const reserve = -(reOpeningBooks + reOtherBooks + dividends + sumOf(atEnd, isProfit) - profitBefore);
  const shareWhole = roundToPounds(shareCapital);
  const figure = (e: number, w: number) => ({ exact: e, whole: w });
  const lineOf = (l: SheetLine | 'F' | 'G', e: number, w: number, codes: ReportCode[] = []) => ({ line: l, label: SHEET_LINE_LABELS[l], codes, ...figure(e, w) });
  const capitalCodes: ReportCode[] = [
    { ledger: 'share-capital', name: 'Called up share capital', amount: shareCapital },
    { ledger: 'retained-earnings', name: 'Profit and loss account', amount: reserve },
  ];
  const balanceSheet: BalanceSheet = {
    lines: [
      lineOf('A', eA, wA, sheet.get('A')),
      lineOf('B', eB, wB, sheet.get('B')),
      lineOf('C', eC, wC, sheet.get('C')),
      lineOf('D', eD, wD, sheet.get('D')),
      lineOf('E', eE, wE, sheet.get('E')),
      lineOf('F', eF, wF),
      lineOf('G', eG, wG),
      lineOf('H', eH, wH, sheet.get('H')),
      lineOf('I', eI, wI, sheet.get('I')),
      lineOf('J', eJ, wJ, sheet.get('J')),
      lineOf('K', eK, wK, capitalCodes),
    ],
    capital: {
      shareCapital: figure(shareCapital, shareWhole),
      reserve: { ...figure(reserve, wK - shareWhole), opening: -reOpeningBooks, profit: profitAndLoss.profit, dividends, other: -reOtherBooks },
      total: figure(shareCapital + reserve, wK),
    },
    balances: eK === shareCapital + reserve,
  };

  // The fixed asset register at the period's end.
  const register: RegisterRow[] = ledger.assets
    .filter((a) => a.acquired <= end && !(a.disposedOn && a.disposedOn < start))
    .map((a) => {
      const was = depreciationTo(a, addDays(start, -1));
      const toDate = depreciationTo(a, end);
      const gone = Boolean(a.disposedOn && a.disposedOn <= end);
      return { ...a, before: was, charge: toDate - was, toDate, netBookValue: gone ? 0 : a.cost - toDate, disposedInPeriod: gone };
    });

  // The director's loan over the period, from its postings, in your sign.
  const loanPostings = ledger.postings.filter((p) => p.ledger === 'directors-loan');
  let directorLoan: LoanStatement | null = null;
  if (company.directorLoanAccountId || loanPostings.length) {
    const booksOpening = loanPostings.filter((p) => p.date < start).reduce((s, p) => s + p.amount, 0);
    const booksClosing = loanPostings.filter((p) => p.date <= end).reduce((s, p) => s + p.amount, 0);
    const movements = ledgerDirectorLoanMovements(src, company.id, ledger.postings)
      .filter((m) => m.date >= start && m.date <= end)
      .map((m) => ({ date: m.date, description: m.description, kind: m.kind, source: m.source, amount: toMinor(m.amount) }));
    directorLoan = { opening: -booksOpening, closing: -booksClosing, movements, books: { opening: booksOpening, closing: booksClosing } };
  }

  // Each company account's ledger against its balance from the balance engine on the period's last day.
  const reconciliation: BankReconciliation[] = src.companyAccounts(company.id).map((a) => {
    const code = accountLedger(a);
    const held = atEnd.get(code) ?? 0;
    const base = { accountId: a.id, name: a.name, ledger: code, books: held };
    if (a.currency !== 'GBP') return { ...base, statement: null, difference: null, status: 'other-currency' as const };
    const point = engine.balanceOn(a.id, end);
    if (!point) return { ...base, statement: null, difference: null, status: 'no-balance' as const };
    const statement = toMinor(point.value);
    const basis = point.basis ? { basis: { date: point.basis.date, kind: point.basis.kind } } : {};
    if (!point.basis) return { ...base, statement, difference: statement - held, status: 'rows-only' as const };
    return { ...base, statement, difference: statement - held, status: statement === held ? ('reconciled' as const) : ('differs' as const), ...basis };
  });

  // Locking against what was filed: the whole-pound lines filed against those worked out now.
  const filed = accountsFiling(end);
  const computed: Record<string, number> = { A: wA, B: wB, C: wC, D: wD, E: wE, F: wF, G: wG, H: wH, I: wI, J: wJ, K: wK };
  const filing =
    filed?.kind === 'accounts'
      ? (() => {
          const figures = filed.figures ?? {};
          const compared = MICRO_ENTITY_LINES.flatMap((l) => (figures[l] !== undefined ? [{ line: l, filed: figures[l], computed: computed[l]! }] : []));
          return { filedOn: filed.filedOn, ...(filed.reference ? { reference: filed.reference } : {}), lines: compared, matches: compared.every((l) => l.filed === l.computed) };
        })()
      : undefined;

  // What stops it being ready.
  const checks: AccountsCheck[] = [];
  if (end >= today) checks.push({ kind: 'not-ended', end });
  for (const c of ledger.checks) {
    const d = checkDate(c);
    if (!d || d <= end) checks.push({ kind: 'ledger', check: c });
  }
  for (const code of CLEARING) if (atEnd.get(code)) checks.push({ kind: 'clearing', ledger: code, amount: atEnd.get(code)! });
  if (trialBalance.debit !== trialBalance.credit) checks.push({ kind: 'trial-balance', debit: trialBalance.debit, credit: trialBalance.credit });
  if (!balanceSheet.balances) checks.push({ kind: 'sheet', netAssets: eK, capital: shareCapital + reserve });
  for (const r of reconciliation) if (r.status === 'differs' || r.status === 'other-currency' || (r.status === 'no-balance' && r.books !== 0)) checks.push({ kind: 'bank', reconciliation: r });
  if (filing && !filing.matches) checks.push({ kind: 'drift', lines: filing.lines.filter((l) => l.filed !== l.computed) });

  return {
    company: { id: company.id, name: company.name },
    periods: offered.map(choice),
    period: { ...choice(period), first: period.start === books.incorporatedOn },
    profitAndLoss,
    balanceSheet,
    trialBalance,
    register,
    directorLoan,
    reconciliation,
    checks,
    ready: checks.length === 0,
    ...(filing ? { filing } : {}),
  };
}

/** The chart's order (balance sheet, then profit and loss), each of the company's own accounts under its parent (`bank:<id>` as `bank`). */
const CHART_ORDER = new Map(LEDGER_CODES.map((c, i) => [c.code, i]));
const chartIndex = (code: string): number => CHART_ORDER.get(code) ?? CHART_ORDER.get(code.split(':')[0]!) ?? Number.MAX_SAFE_INTEGER;
function byChart(a: string, b: string): number {
  return chartIndex(a) - chartIndex(b) || a.localeCompare(b);
}
