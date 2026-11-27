// A company's micro-entity accounts as it files them (docs/FORMULAS.md §22, "Filing the accounts"): for
// one accounting period, the balance sheet in the order and words of Companies House's micro-entity
// form, in whole pounds with the period before, each figure traced to the books; the notes a micro-entity
// gives (employees, advances to directors, commitments and arrangements off the balance sheet); the
// statements above the director's signature; the rounding statement; the optional accounting policies;
// whether the company qualifies for the micro-entity provisions; and what must be done before filing.
// Worked out from the period's accounts (analytics/period-accounts.ts) and what you confirm
// (`books.employees`, `books.accountsNotes`); nothing is stored here, and nothing is sent anywhere.
//
// This is company data, served only from its own routes (routes/company-books.ts). The book value of
// your shares it offers is recorded only when you choose to (POST /api/companies/:id/accounts/book-value).

import { accountingPolicies, approvalLine, balanceSheetStatements, directorAdvances, monthsOfYear, qualification, ROUNDING_STATEMENT, type Qualification, type YearFigures } from '../../shared/accounts-filing';
import type { CompanyAccountsResponse, CompanyFilingResponse, EligibilityView, FilingGateItem, FilingSheetLine, ReportCode } from '../../shared/api';
import { accountingPeriodsOf } from '../../shared/company-books';
import type { ISODate } from '../../shared/dates';
import { ASSET_REGISTER_CLASSES, type AssetRegisterClass } from '../../shared/ledger';
import { FILING_DISCLAIMER } from '../../shared/disclaimers';
import { fromMinor, mulDivRound, toMinor } from '../../shared/money';
import { MICRO_ENTITY_LINES, type Company, type MicroEntityLines } from '../../shared/schema';
import { ACCOUNTS_FILING_CHANNEL_RULES, companySizeRulesFor, ruleOn, type SizeLimits } from '../../shared/uk';
import type { BalanceEngine } from './balances';
import { companyLedger, type Ledger, type LedgerSource } from './ledger';
import { accountsPeriods, periodAccounts } from './period-accounts';

/** Staff costs (profit and loss line D): a month with any is a month payroll ran. */
const STAFF_COSTS = new Set(['directors-salaries', 'employer-ni', 'staff-pensions']);

/**
 * What would stop a company being a micro-entity, or filing with audit exemption, that only you can
 * say (CA 2006 ss384, 384A(8), 384B, 476, 478): none may apply at any time in the period.
 */
export const MICRO_EXCLUSIONS: readonly { key: string; text: string; source: string }[] = [
  { key: 'public', text: 'A public company.', source: 'CA 2006 ss384(1)(a), 478(a)' },
  { key: 'regulated', text: 'An authorised insurance company, a banking company, an e-money issuer, a MiFID investment firm or a UCITS management company; carrying on insurance market activity; or a Master Trust scheme funder.', source: 'CA 2006 ss384(1)(b), 478(b)' },
  { key: 'group', text: 'A member of an ineligible group (one with a traded or listed company, a Part 4A FSMA permission holder, or another regulated firm in it).', source: 'CA 2006 s384(1)(c), (2)' },
  { key: 'investment', text: 'An investment undertaking or a financial holding undertaking (Directive 2013/34/EU, Article 2(14) and (15)).', source: 'CA 2006 s384B(1)(b)–(c)' },
  { key: 'credit-insurance', text: 'A credit institution (a CRR firm) or an insurance undertaking.', source: 'CA 2006 s384B(1)(d)–(e)' },
  { key: 'charity', text: 'A charity.', source: 'CA 2006 s384B(1)(f)' },
  { key: 'parent', text: 'A parent company (it qualifies only when its group qualifies as small, and not when it prepares group accounts), or a subsidiary whose accounts are included in consolidated group accounts for the year.', source: 'CA 2006 ss384A(8), 384B(2)' },
  { key: 'audit', text: 'Members holding 10% or more of its shares (of any class) asked for an audit, by notice deposited at least one month before the end of the year.', source: 'CA 2006 s476' },
];

/** Companies House's words for the sub-lines of B and C (its micro-entity form), in its order: a breakdown it takes but does not ask for. */
const SUB_LINES: Record<'B' | 'C', { part: string | null; label: string }[]> = {
  B: [
    { part: 'Intangible assets', label: 'Intangible assets' },
    { part: 'Tangible assets', label: 'Tangible assets' },
    { part: 'Investments', label: 'Investments (fixed assets)' },
  ],
  C: [
    { part: 'Stocks', label: 'Stocks' },
    { part: 'Debtors', label: 'Debtors' },
    { part: null, label: 'Investments (current assets)' },
    { part: 'Cash at bank and in hand', label: 'Cash at bank and in hand' },
  ],
};
/** Companies House's words for lines A–K (its micro-entity form, the format's own words where the form's help has none). */
const LINE_LABELS: Record<(typeof MICRO_ENTITY_LINES)[number], string> = {
  A: 'Called up share capital not paid',
  B: 'Total fixed assets',
  C: 'Total current assets',
  D: 'Prepayments and accrued income',
  E: 'Creditors: amounts falling due within one year',
  F: 'Net current assets (liabilities)',
  G: 'Total assets less current liabilities',
  H: 'Creditors: amounts falling due after more than one year',
  I: 'Provisions for liabilities',
  J: 'Accruals and deferred income',
  K: 'Total net assets (liabilities)',
};
const TOTAL_WORKING: Partial<Record<string, string>> = { F: 'C + D − E', G: 'A + B + F', K: 'G − H − I − J' };

export interface CompanyFilingInput {
  src: LedgerSource;
  company: Company;
  engine: Pick<BalanceEngine, 'balanceOn' | 'statementFor'>;
  today: ISODate;
  /** The period's last day; absent: the latest period ended, or the current one. */
  period?: ISODate | undefined;
}

/** The whole-pound lines A–K as the accounts give them now: what a filing records. */
export function filingLines(accounts: CompanyAccountsResponse): Required<MicroEntityLines> {
  return Object.fromEntries(MICRO_ENTITY_LINES.map((l) => [l, accounts.balanceSheet.lines.find((x) => x.line === l)!.whole])) as Required<MicroEntityLines>;
}

/** The balance sheet total (gross assets, A + B + C + D) of lines in whole pounds; absent when none of them is given. */
function assetsOf(lines: Partial<Record<string, number | undefined>>): number | undefined {
  const given = (['A', 'B', 'C', 'D'] as const).map((l) => lines[l]);
  return given.some((v) => v !== undefined) ? given.reduce<number>((s, v) => s + (v ?? 0), 0) : undefined;
}

/**
 * One period's filing sheet (FORMULAS.md §22, "Filing the accounts"), or undefined when the company has
 * no such period in its books.
 */
export function companyFiling({ src, company, engine, today, period }: CompanyFilingInput): CompanyFilingResponse | undefined {
  const books = company.books;
  if (!books) return undefined;
  const offered = accountsPeriods(company, today);
  if (!offered.length) return undefined;
  const ledger: Ledger = companyLedger(src, company.id, { until: offered[0]!.end });
  const acc = periodAccounts({ src, company, engine, today, period, ledger });
  if (!acc) return undefined;
  const p = acc.period;
  const first = books.ledgerFrom ?? books.incorporatedOn;
  const notes = books.accountsNotes?.find((n) => n.periodEnd === p.end);
  const employees = books.employees?.find((e) => e.periodEnd === p.end)?.average;
  const filed = books.filings.find((f) => f.kind === 'accounts' && f.periodEnd === p.end);
  const filedFigures = (end: ISODate) => {
    const f = books.filings.find((x) => x.kind === 'accounts' && x.periodEnd === end);
    return f?.kind === 'accounts' && f.figures && Object.values(f.figures).some((v) => v !== undefined) ? f.figures : undefined;
  };

  // ─── The balance sheet, in the form's order ─────────────────────────────────────────────────────
  const line = (l: string) => acc.balanceSheet.lines.find((x) => x.line === l)!;
  const priorSheet = acc.comparative?.sheet;
  const sheet: FilingSheetLine[] = [];
  for (const l of MICRO_ENTITY_LINES) {
    const at = line(l);
    if (l === 'B' || l === 'C') {
      for (const s of SUB_LINES[l]) {
        const part = s.part ? at.parts?.find((x) => x.label === s.part) : undefined;
        sheet.push({ key: `${l}:${s.label}`, line: l, label: s.label, sub: true, whole: part?.whole ?? 0, exact: part?.exact ?? 0, ...(acc.comparative ? (part?.prior !== undefined ? { prior: part.prior } : priorSheet === 'computed' ? { prior: 0 } : {}) : {}), trace: part?.codes ?? [] });
      }
    }
    const working = TOTAL_WORKING[l];
    sheet.push({ key: l, line: l, label: LINE_LABELS[l], whole: at.whole, exact: at.exact, ...(at.prior !== undefined ? { prior: at.prior } : {}), ...(working ? { total: true, working } : l === 'B' || l === 'C' ? { working: 'the sum of the lines above it, each rounded' } : {}), trace: working || l === 'K' ? [] : at.codes });
  }
  const cap = acc.balanceSheet.capital;
  const capitalLine = (key: string, label: string, f: { exact: number; whole: number; prior?: number }, trace: ReportCode[], extra: Partial<FilingSheetLine> = {}): FilingSheetLine => ({ key, label, whole: f.whole, exact: f.exact, ...(f.prior !== undefined ? { prior: f.prior } : {}), trace, ...extra });
  const capCode = (ledgerCode: string) => line('K').codes.filter((c) => c.ledger === ledgerCode);
  const capital: FilingSheetLine[] = [
    capitalLine('share-capital', 'Called up share capital', cap.shareCapital, capCode('share-capital')),
    capitalLine('share-premium', 'Share premium account', cap.sharePremium, capCode('share-premium')),
    capitalLine('revaluation', 'Revaluation reserve', { exact: 0, whole: 0, ...(acc.comparative ? { prior: 0 } : {}) }, [], { note: 'Assets are measured at cost under FRS 105: never revalued.' }),
    capitalLine('other-reserves', 'Other reserves', cap.otherReserves, capCode('other-reserves')),
    capitalLine('reserve', 'Profit and loss account', cap.reserve, capCode('retained-earnings'), { note: 'Total net assets less the share capital and other reserves, each rounded: so they add up to it.' }),
    capitalLine('funds', 'Shareholders’ funds', cap.total, [], { total: true, working: 'the sum of the lines above it: total net assets (K)' }),
  ];

  // ─── The notes ──────────────────────────────────────────────────────────────────────────────────
  const loan = acc.directorLoan;
  const advances = directorAdvances(loan ? { opening: loan.opening, movements: loan.movements } : { opening: 0, movements: [] });
  const months = monthsOfYear(p);
  const staff = ledger.postings.filter((x) => STAFF_COSTS.has(x.ledger) && x.date >= p.start && x.date <= p.end);
  const paye = Boolean(books.paye && books.paye.from <= p.end && !(books.paye.closedOn && books.paye.closedOn < p.start));
  const payrollMonths = months.filter((m) => staff.some((x) => x.date >= m.start && x.date <= m.end && x.amount)).length;
  const staffCosts = staff.reduce((s, x) => s + x.amount, 0);
  const hint = paye || staff.length ? { paye, months: months.length, payrollMonths, staffCosts, onePerson: Math.round((payrollMonths * 100) / months.length) / 100 } : undefined;

  // ─── Eligibility ────────────────────────────────────────────────────────────────────────────────
  const rules = companySizeRulesFor(p.start);
  const periods = accountingPeriodsOf(books, p.end).filter((x) => x.end <= p.end);
  const years: YearFigures[] = periods.map((y) => {
    const people = books.employees?.find((e) => e.periodEnd === y.end)?.average;
    if (y.end === p.end) {
      const turnover = y.start >= first ? acc.profitAndLoss.lines.find((l) => l.line === 'A')!.amount : undefined;
      return { start: y.start, end: y.end, turnover, assets: assetsOf(filedFigures(y.end) ?? filingLines(acc)), employees: people };
    }
    const figures = filedFigures(y.end);
    const there = y.end >= first ? periodAccounts({ src, company, engine, today, period: y.end, ledger }) : undefined;
    const turnover = there && y.start >= first ? there.profitAndLoss.lines.find((l) => l.line === 'A')!.amount : undefined;
    return { start: y.start, end: y.end, turnover, assets: assetsOf(figures ?? (there ? filingLines(there) : {})), employees: people };
  });
  const firstYear = periods[0]?.start === books.incorporatedOn;
  const view = (kind: 'micro' | 'small', limits: SizeLimits, q: Qualification): EligibilityView => ({ kind, limits, ...(q.qualifies === undefined ? {} : { qualifies: q.qualifies }), rule: q.rule, years: q.years });
  const micro = qualification(years, rules.micro, { firstYear, previousQualified: notes?.previousQualified });
  let small = qualification(years, rules.small, { firstYear, ...(notes?.previousQualified ? { previousQualified: true } : {}) });
  // Within the micro-entity limits is within the small ones, so a micro-entity is small (FORMULAS.md §22).
  if (small.qualifies === undefined && micro.qualifies) small = { ...small, qualifies: true, rule: micro.rule };
  const last = micro.years.at(-1);
  const before = micro.years.at(-2);
  const askPrevious = rules.covered && micro.qualifies === undefined && last?.meets !== undefined && !(micro.years.length === 1 && firstYear);
  const eligibility: CompanyFilingResponse['eligibility'] = {
    from: rules.from,
    covered: rules.covered,
    micro: view('micro', rules.micro, micro),
    small: view('small', rules.small, small),
    notExcluded: notes?.notExcluded ?? null,
    previousQualified: notes?.previousQualified ?? null,
    askPrevious: askPrevious || notes?.previousQualified !== undefined,
    ...(before && before.meets === undefined ? { previousUnknown: true } : {}),
    exclusions: MICRO_EXCLUSIONS.map((x) => ({ ...x })),
  };

  // ─── What must be done before filing ─────────────────────────────────────────────────────────────
  const notesDone = Boolean(notes?.offBalanceSheet && notes.commitments && notes.directors && (!advances.any || notes.advances));
  const eligible = rules.covered && micro.qualifies === true && small.qualifies === true && notes?.notExcluded === true;
  const gate: FilingGateItem[] = [
    { key: 'ended', ok: p.ended, label: 'The period has ended', detail: p.ended ? 'Its last day has passed.' : `It runs to its last day, ${p.end}.` },
    { key: 'accounts', ok: acc.ready, label: 'Its accounts are ready', detail: acc.ready ? 'Every check on the Accounts tab is clear.' : `${acc.checks.length} check${acc.checks.length === 1 ? '' : 's'} on the Accounts tab to clear.` },
    { key: 'employees', ok: employees !== undefined, label: 'The average number of employees is given', detail: employees !== undefined ? `${employees}.` : 'Give it below: a note every company gives (CA 2006 s411(1)).' },
    { key: 'notes', ok: notesDone, label: 'The notes are confirmed', detail: notesDone ? 'Arrangements off the balance sheet, advances and guarantees for directors, commitments.' : 'Confirm each note below, “none” where there is none.' },
    { key: 'eligibility', ok: eligible, label: 'It qualifies for the micro-entity provisions', detail: !rules.covered ? 'Periods beginning before 1 January 2016 are not covered.' : eligible ? 'By its size, and none of the exclusions applies, as you confirmed.' : micro.qualifies === false ? 'Not by its size: micro-entity accounts are not for it.' : notes?.notExcluded !== true ? 'Confirm that none of the exclusions applies.' : 'Its size cannot be told yet: see below.' },
  ];

  // ─── The book value of your shares ──────────────────────────────────────────────────────────────
  const k = filedFigures(p.end)?.K ?? line('K').whole;
  const shares = company.holdings.reduce((s, h) => s + h.shares, 0);
  const totals = [...new Set(company.holdings.map((h) => h.totalShares).filter((t): t is number => t !== undefined))];
  const recorded = company.valuations.find((v) => v.asOf === p.end && v.method === 'net-assets');
  let why: string | undefined;
  if (!p.ended) why = 'The period has not ended.';
  else if (!acc.ready && !filed) why = 'Its accounts are not ready or filed: the figure could still change.';
  else if (!company.holdings.length) why = 'You hold no shares in it here: add your holding on its account page.';
  else if (totals.length !== 1 || company.holdings.some((h) => h.totalShares === undefined)) why = 'Give the shares it has issued (of every class) with your holding on its account page.';
  else if (!company.accountId) why = 'Your shares in it have no account in your estate to record a value on.';
  const value = why ? undefined : k <= 0 ? 0 : fromMinor(mulDivRound(toMinor(k), Math.round(shares * 1e6), Math.round(totals[0]! * 1e6)));

  const channel = ruleOn(ACCOUNTS_FILING_CHANNEL_RULES, today);
  const softwareOnly = ACCOUNTS_FILING_CHANNEL_RULES.find((r) => !r.webFiling)!.from;
  const filedLines = filed?.kind === 'accounts' ? (acc.filing?.lines ?? []) : [];
  return {
    company: { id: company.id, name: company.name, ...(company.number ? { number: company.number } : {}) },
    periods: acc.periods,
    period: acc.period,
    channel: { webFiling: channel.webFiling, softwareOnlyFrom: softwareOnly, enhancedAuditStatement: channel.enhancedAuditStatement },
    accounts: { ready: acc.ready, checks: acc.checks.length, ...(acc.lockedThrough ? { lockedThrough: acc.lockedThrough } : {}) },
    ...(acc.comparative ? { comparative: { start: acc.comparative.start, end: acc.comparative.end, sheet: acc.comparative.sheet } } : {}),
    sheet,
    capital,
    lines: filingLines(acc),
    rounding: ROUNDING_STATEMENT,
    notes: {
      offBalanceSheet: notes?.offBalanceSheet ?? null,
      commitments: notes?.commitments ?? null,
      directors: notes?.directors ?? null,
      employees: { average: employees ?? null, ...(hint ? { hint } : {}) },
      advances: { ...advances, loan: Boolean(loan), given: notes?.advances ?? null },
    },
    statements: balanceSheetStatements(p),
    approval: { line: approvalLine(filed?.kind === 'accounts' ? filed.approvedOn : undefined, filed?.kind === 'accounts' ? filed.approvedBy : undefined) },
    policies: accountingPolicies({
      lives: policiesInForce(books.policies ?? [], new Set(acc.register.map((a) => a.class)), p),
      ownLives: acc.register.some((a) => a.life === 'asset'),
      residual: acc.register.some((a) => a.residual !== undefined),
      months: books.depreciationMonths ?? 'acquisition',
      tangible: acc.register.some((a) => a.class !== 'intangible'),
      intangible: acc.register.some((a) => a.class === 'intangible'),
      vat: Boolean(books.vat && books.vat.registeredFrom <= p.end && !(books.vat.deregisteredOn && books.vat.deregisteredOn < p.start)),
      accruals: (['prepayments', 'accruals', 'deferred-income', 'accrued-income'] as const).some((c) => acc.trialBalance.rows.some((r) => r.ledger === c)),
    }),
    eligibility,
    gate,
    ready: gate.every((g) => g.ok) && !filed,
    ...(filed?.kind === 'accounts'
      ? { filing: { filedOn: filed.filedOn, ...(filed.reference ? { reference: filed.reference } : {}), ...(filed.approvedOn ? { approvedOn: filed.approvedOn } : {}), ...(filed.approvedBy ? { approvedBy: filed.approvedBy } : {}), lines: filedLines, matches: filedLines.every((l) => l.filed === l.computed) } }
      : {}),
    bookValue: { asOf: p.end, netAssets: k, ...(why ? { why } : {}), ...(shares ? { shares } : {}), ...(totals.length === 1 ? { totalShares: totals[0]! } : {}), ...(value !== undefined ? { value } : {}), ...(recorded ? { recorded: { value: recorded.value, ...(recorded.netAssets !== undefined ? { netAssets: recorded.netAssets } : {}) } } : {}) },
    disclaimer: FILING_DISCLAIMER,
  };
}

/** Each class's depreciation policy in force at a period's end, for the classes on its register: the day it took effect when that was in the period. */
function policiesInForce(policies: NonNullable<NonNullable<Company['books']>['policies']>, classes: ReadonlySet<string>, p: { start: ISODate; end: ISODate }): { class: AssetRegisterClass; months: number; from?: ISODate }[] {
  const out: { class: AssetRegisterClass; months: number; from?: ISODate }[] = [];
  for (const c of ASSET_REGISTER_CLASSES) {
    if (!classes.has(c)) continue;
    const inForce = policies.filter((x) => x.class === c && (!x.effectiveFrom || x.effectiveFrom <= p.end)).sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? '')).at(-1);
    if (inForce) out.push({ class: c, months: inForce.months, ...(inForce.effectiveFrom && inForce.effectiveFrom >= p.start ? { from: inForce.effectiveFrom } : {}) });
  }
  return out;
}

/**
 * The filing sheet's figures as CSV (`format=csv`): the balance sheet in the form's order with the
 * period before, capital and reserves, the notes, the statements and the rounding statement, ending with
 * the disclaimer.
 */
export function filingCsv(company: Pick<Company, 'name' | 'number'>, v: CompanyFilingResponse, cell: (x: string | number) => string): string {
  const out = [['line', 'item', 'this period (£)', v.comparative ? `period to ${v.comparative.end} (£)` : 'period before (£)'].map(cell).join(',')];
  const row = (l: FilingSheetLine) => [l.line && !l.sub ? l.line : '', `${l.sub ? '  ' : ''}${l.label}`, l.whole, l.prior ?? ''].map((x) => cell(x)).join(',');
  for (const l of v.sheet) out.push(row(l));
  out.push(cell('Capital and reserves'));
  for (const l of v.capital) out.push(row(l));
  out.push('', ['company', company.name].map(cell).join(','), ['company number', company.number ?? ''].map(cell).join(','), ['period', `${v.period.start} to ${v.period.end}`].map(cell).join(','));
  const n = v.notes;
  const note = (label: string, x: CompanyFilingResponse['notes']['commitments']) => [label, x === null ? 'not confirmed' : 'none' in x ? 'None' : `${x.text}${x.amount !== undefined ? ` (total £${x.amount.toFixed(2)})` : ''}`].map(cell).join(',');
  out.push(['average number of employees', n.employees.average ?? 'not given'].map((x) => cell(x)).join(','));
  out.push(
    [
      'advances and credits to directors (books)',
      n.advances.any ? `owed at the start £${fromMinor(n.advances.opening).toFixed(2)}, advanced £${fromMinor(n.advances.advanced).toFixed(2)}, repaid £${fromMinor(n.advances.repaid).toFixed(2)}, owed at the end £${fromMinor(n.advances.closing).toFixed(2)}, most owed £${fromMinor(n.advances.maximum).toFixed(2)}${n.advances.given ? `; interest ${n.advances.given.interest}; ${n.advances.given.conditions}; written off £${(n.advances.given.writtenOff ?? 0).toFixed(2)}; waived £${(n.advances.given.waived ?? 0).toFixed(2)}` : ''}` : 'None',
    ]
      .map(cell)
      .join(','),
  );
  out.push(note('other advances, credits and guarantees for directors', n.directors));
  out.push(note('financial commitments, guarantees and contingencies', n.commitments));
  out.push(note('arrangements not on the balance sheet', n.offBalanceSheet));
  out.push('');
  for (const s of v.statements) out.push(cell(s.text));
  out.push(cell(v.rounding));
  if (!v.ready && !v.filing) out.push(cell(`Not ready to file: ${v.gate.filter((g) => !g.ok).map((g) => g.label.toLowerCase()).join('; ')}.`));
  out.push('', cell(v.disclaimer));
  return out.join('\n') + '\n';
}

/** The filing sheet's figures as JSON (`format=json`): what to file, the notes and statements, ending with the disclaimer. */
export function filingJson(company: Pick<Company, 'name' | 'number'>, v: CompanyFilingResponse): Record<string, unknown> {
  return {
    company: { name: company.name, ...(company.number ? { number: company.number } : {}) },
    period: { start: v.period.start, end: v.period.end },
    ...(v.comparative ? { comparative: { start: v.comparative.start, end: v.comparative.end, sheet: v.comparative.sheet } } : {}),
    currency: 'GBP, whole pounds',
    balanceSheet: v.sheet.map((l) => ({ ...(l.line ? { line: l.line } : {}), label: l.label, ...(l.sub ? { subLine: true } : {}), value: l.whole, ...(l.prior !== undefined ? { prior: l.prior } : {}) })),
    capitalAndReserves: v.capital.map((l) => ({ label: l.label, value: l.whole, ...(l.prior !== undefined ? { prior: l.prior } : {}) })),
    lines: v.lines,
    notes: { averageEmployees: v.notes.employees.average, advances: v.notes.advances, directors: v.notes.directors, commitments: v.notes.commitments, offBalanceSheet: v.notes.offBalanceSheet },
    statements: v.statements.map((s) => s.text),
    rounding: v.rounding,
    ready: v.ready,
    disclaimer: v.disclaimer,
  };
}
