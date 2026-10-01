// Checking a model's reading of a PDF or screenshot before you review it. Every figure is either
// confirmed by the document's own arithmetic (balances that reconcile, printed totals, holdings
// that add up to the value) or by a second, independent reading with a stronger model; where two
// readings disagree, the rows are marked for you to look at. See docs/INGESTION.md.

import { formatMoney } from '../../shared/money';
import { sectionChecks } from '../../shared/review';
import type { AccountType, Draft, DraftSection, ExtractedPayslip } from '../../shared/schema';
import { payslipAddsUp, payslipFigures, payslipProblems } from './payslips';
import type { TimesheetCheck } from './timesheet';

/** Checks whose failure means a figure was probably misread. */
const READING_CHECKS = new Set(['reconcile', 'totals', 'period', 'future', 'balance-date', 'card-signs', 'uncertain', 'holdings']);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The same text as printed, allowing a bank code or a place added or dropped. */
export function sameText(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = norm(expected);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  const common = [...ta].filter((t) => tb.has(t)).length;
  return common / Math.max(ta.size, tb.size) >= 0.6;
}

const pence = (v: number | undefined | null) => (v === undefined || v === null ? null : Math.round(v * 100));
export const sameMoney = (a: number | undefined | null, b: number | undefined | null) => pence(a) !== null && pence(a) === pence(b);
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export interface RowLike {
  date: string;
  amount: number;
  description: string;
}

/** One-to-one alignment of two lists of rows: exact matches first, then near misses. */
export function alignRows(left: RowLike[], right: RowLike[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const used = new Set<number>();
  const passes: ((a: RowLike, b: RowLike) => boolean)[] = [
    (a, b) => a.date === b.date && sameMoney(a.amount, b.amount) && sameText(a.description, b.description),
    (a, b) => a.date === b.date && sameMoney(a.amount, b.amount),
    (a, b) => sameMoney(a.amount, b.amount) && dayGap(a.date, b.date) <= 3 && sameText(a.description, b.description),
    (a, b) => a.date === b.date && sameMoney(Math.abs(a.amount), Math.abs(b.amount)) && sameText(a.description, b.description),
    (a, b) => a.date === b.date && sameText(a.description, b.description),
  ];
  for (const pass of passes) {
    left.forEach((a, i) => {
      if (pairs.has(i)) return;
      const j = right.findIndex((b, k) => !used.has(k) && pass(a, b));
      if (j >= 0) {
        pairs.set(i, j);
        used.add(j);
      }
    });
  }
  return pairs;
}

export interface ReadingAssessment {
  /** Checks the reading failed: it should be read again. */
  problems: string[];
  /** Figures nothing on the document could confirm: they need a second reading to be checked. */
  unconfirmed: string[];
}

const labelOf = (s: DraftSection, i: number) => s.detected.accountName ?? s.detected.institutionName ?? `Account ${i + 1}`;

/**
 * What the document's own arithmetic confirms about a reading, and what it contradicts. Rows and
 * balances are confirmed when they reconcile or match the printed totals; holdings when they add
 * up to the value. Contribution and allowance figures, a balance on its own and tax figures have
 * nothing to be checked against.
 */
export function assessReading(
  draft: Draft,
  ctx: { accountTypeOf: (s: DraftSection) => AccountType | undefined; latest: string; warnings: string[]; periodFromRows?: boolean; sheetCheck?: TimesheetCheck | undefined },
): ReadingAssessment {
  const problems: string[] = [];
  const unconfirmed: string[] = [];
  if (draft.confidence === 'low') problems.push('The reader was not confident');
  problems.push(...ctx.warnings);
  // A spreadsheet's own cells confirm the earned pay read from it (./timesheet.ts).
  if (ctx.sheetCheck) problems.push(...ctx.sheetCheck.problems);
  draft.sections.forEach((s, i) => {
    const label = labelOf(s, i);
    const checks = sectionChecks(s, { accountType: ctx.accountTypeOf(s), latest: ctx.latest, periodFromRows: ctx.periodFromRows });
    for (const c of checks) if (c.status === 'warn' && READING_CHECKS.has(c.id)) problems.push(`${label}: ${c.title.charAt(0).toLowerCase()}${c.title.slice(1)}`);
    const passed = new Set(checks.filter((c) => c.status === 'ok').map((c) => c.id));
    const settled = s.transactions.filter((t) => !t.pending);
    if (settled.length && !passed.has('reconcile') && !passed.has('totals')) unconfirmed.push(`${label}: no balances or totals to check the rows against`);
    if (!settled.length && s.balance !== undefined && !(s.holdings.length && passed.has('holdings'))) unconfirmed.push(`${label}: a balance with nothing to check it against`);
    if (s.holdings.length && !passed.has('holdings')) unconfirmed.push(`${label}: holdings with no total to check them against`);
    if ([s.contributions, s.bonusToDate, s.taxYearContributions, s.gain, s.annualIncome].some((v) => v !== undefined)) unconfirmed.push(`${label}: contribution and allowance figures`);
  });
  // A payslip read in full confirms its own figures when it adds up (its lines to its totals, its
  // totals to its net pay) and the figures read are what its lines say (ingest/payslips.ts).
  const slips = draft.payslips ?? [];
  for (const p of slips) problems.push(...payslipProblems(p.record));
  const bySlips = slips.length > 0 && slips.every((p) => payslipAddsUp(p.record)) && slipFiguresAgree(draft, slips.map((p) => p.record));
  if (slips.length && slips.every((p) => payslipAddsUp(p.record)) && !bySlips) problems.push('The tax figures read are not what the payslip’s lines say');
  const unchecked = draft.figures.filter((f) => !ctx.sheetCheck?.confirmed.has(f.key) && !(bySlips && SLIP_KINDS.has(f.kind)));
  if (unchecked.some((f) => f.kind !== 'earned_pay')) unconfirmed.push('Tax figures');
  if (unchecked.some((f) => f.kind === 'earned_pay')) unconfirmed.push('Earned pay');
  // Finding nothing to record is a reading too, and a missed balance or row would be dismissed with
  // it: a second reader has to find nothing as well.
  if (!draft.sections.length && !draft.figures.length) unconfirmed.push('Nothing to record');
  return { problems, unconfirmed };
}

/** The kinds of tax figure a payslip's lines give. */
const SLIP_KINDS = new Set<string>(['gross_pay', 'tax_deducted', 'national_insurance', 'pension_contribution_employee', 'student_loan_deducted']);

/** Are a draft's payslip figures, kind by kind, what its payslips' own lines add up to? */
function slipFiguresAgree(draft: Draft, slips: ExtractedPayslip[]): boolean {
  const sum = (list: { kind: string; amount: number }[], kind: string) => list.filter((f) => f.kind === kind).reduce((x, f) => x + Math.round(f.amount * 100), 0);
  const fromSlips = slips.flatMap((p) => payslipFigures(p));
  const read = draft.figures.filter((f) => SLIP_KINDS.has(f.kind));
  return [...SLIP_KINDS].every((k) => sum(read, k) === sum(fromSlips, k));
}

export interface Comparison {
  /** Figures the two readings did not agree on, in words. */
  disagreements: string[];
  /** Notes for rows of the second reading whose figures the first did not share, by row key. */
  rowNotes: Map<string, string>;
}

/**
 * Compare two readings of one document, figure by figure: each account's balances and dates, every
 * row's date, amount and pending flag, each holding's value and units, and each tax figure.
 * Wording (descriptions, names) may differ; figures may not.
 */
export function compareReadings(first: Draft, second: Draft, names: { first: string; second: string }): Comparison {
  const disagreements: string[] = [];
  const rowNotes = new Map<string, string>();
  const note = (key: string, text: string) => rowNotes.set(key, rowNotes.has(key) ? `${rowNotes.get(key)}; ${text}` : text);
  if (first.sections.length !== second.sections.length) disagreements.push(`${names.first} found ${first.sections.length} account(s), ${names.second} ${second.sections.length}`);
  const money = (v: number | undefined) => (v === undefined ? 'nothing' : formatMoney(v));
  second.sections.forEach((b, i) => {
    const a = first.sections[i];
    const label = labelOf(b, i);
    if (!a) return;
    const scalars: [string, number | string | undefined, number | string | undefined][] = [
      ['opening balance', a.openingBalance, b.openingBalance],
      ['balance', a.balance, b.balance],
      ['balance date', a.balanceDate, b.balanceDate],
      ['period start', a.periodStart, b.periodStart],
      ['period end', a.periodEnd, b.periodEnd],
      ['total paid in', a.contributions, b.contributions],
      ['LISA bonus', a.bonusToDate, b.bonusToDate],
      ['paid in this tax year', a.taxYearContributions, b.taxYearContributions],
      ['cash', a.cash, b.cash],
      ['credit limit', a.creditLimit, b.creditLimit],
      ['income per year', a.annualIncome, b.annualIncome],
    ];
    for (const [what, x, y] of scalars) {
      const same = typeof x === 'number' || typeof y === 'number' ? (x === undefined && y === undefined) || sameMoney(x as number, y as number) : x === y;
      if (!same) disagreements.push(`${label}, ${what}: ${names.first} read ${typeof x === 'number' ? money(x) : (x ?? 'nothing')}, ${names.second} ${typeof y === 'number' ? money(y) : (y ?? 'nothing')}`);
    }
    const pairs = alignRows(b.transactions, a.transactions);
    const matchedInFirst = new Set(pairs.values());
    b.transactions.forEach((t, j) => {
      const k = pairs.get(j);
      const where = `${label}, ${t.date} ${t.description} ${money(t.amount)}`;
      if (k === undefined) {
        disagreements.push(`${where}: only ${names.second} read this row`);
        note(t.key, `only ${names.second} read this row`);
        return;
      }
      const o = a.transactions[k]!;
      if (o.date !== t.date) {
        disagreements.push(`${where}: ${names.first} dated it ${o.date}`);
        note(t.key, `${names.first} read the date as ${o.date}`);
      }
      if (!sameMoney(o.amount, t.amount)) {
        disagreements.push(`${where}: ${names.first} read ${money(o.amount)}`);
        note(t.key, `${names.first} read the amount as ${money(o.amount)}`);
      }
      if (Boolean(o.pending) !== Boolean(t.pending)) {
        disagreements.push(`${where}: pending in one reading only`);
        note(t.key, `pending in one reading only`);
      }
      if (t.balanceAfter !== undefined && o.balanceAfter !== undefined && !sameMoney(o.balanceAfter, t.balanceAfter)) {
        disagreements.push(`${where}: running balance ${money(o.balanceAfter)} in ${names.first}`);
        note(t.key, `${names.first} read the running balance as ${money(o.balanceAfter)}`);
      }
    });
    a.transactions.forEach((t, k) => {
      if (!matchedInFirst.has(k)) disagreements.push(`${label}, ${t.date} ${t.description} ${money(t.amount)}: only ${names.first} read this row`);
    });
    const usedHoldings = new Set<number>();
    for (const h of b.holdings) {
      const k = a.holdings.findIndex((x, n) => !usedHoldings.has(n) && ((h.isin && x.isin && h.isin.toUpperCase() === x.isin.toUpperCase()) || sameText(h.name, x.name)));
      if (k < 0) {
        disagreements.push(`${label}, holding ${h.name}: only ${names.second} read it`);
        continue;
      }
      usedHoldings.add(k);
      const o = a.holdings[k]!;
      if (!sameMoney(o.value, h.value)) disagreements.push(`${label}, holding ${h.name}: ${names.first} read ${money(o.value)}, ${names.second} ${money(h.value)}`);
      if (o.units !== undefined && h.units !== undefined && Math.abs(o.units - h.units) > 0.0005) disagreements.push(`${label}, holding ${h.name}: ${names.first} read ${o.units} units, ${names.second} ${h.units}`);
    }
    a.holdings.forEach((h, n) => {
      if (!usedHoldings.has(n)) disagreements.push(`${label}, holding ${h.name}: only ${names.first} read it`);
    });
  });
  const usedFigures = new Set<number>();
  // A period's figure pairs with the same period's first (two months of equal pay are two figures).
  const samePeriod = (x: Draft['figures'][number], f: Draft['figures'][number]) => (x.periodEnd ?? '') === (f.periodEnd ?? '');
  for (const f of second.figures) {
    const k = [(x: Draft['figures'][number]) => samePeriod(x, f) && sameMoney(x.amount, f.amount), (x: Draft['figures'][number]) => sameMoney(x.amount, f.amount), (x: Draft['figures'][number]) => samePeriod(x, f), () => true]
      .map((pass) => first.figures.findIndex((x, n) => !usedFigures.has(n) && x.kind === f.kind && pass(x)))
      .find((i) => i >= 0);
    const j = k ?? -1;
    if (j < 0) {
      disagreements.push(`${f.label}: only ${names.second} read it`);
      continue;
    }
    usedFigures.add(j);
    const o = first.figures[j]!;
    if (!sameMoney(o.amount, f.amount)) disagreements.push(`${f.label}: ${names.first} read ${money(o.amount)}, ${names.second} ${money(f.amount)}`);
    if ((o.taxYear ?? '') !== (f.taxYear ?? '')) disagreements.push(`${f.label}: tax year ${o.taxYear ?? 'none'} in ${names.first}, ${f.taxYear ?? 'none'} in ${names.second}`);
    if (!samePeriod(o, f)) disagreements.push(`${f.label}: period ending ${o.periodEnd ?? 'none'} in ${names.first}, ${f.periodEnd ?? 'none'} in ${names.second}`);
  }
  first.figures.forEach((f, n) => {
    if (!usedFigures.has(n)) disagreements.push(`${f.label}: only ${names.first} read it`);
  });
  return { disagreements: disagreements.slice(0, 50), rowNotes: new Map([...rowNotes].map(([k, v]) => [k, `The two readings differed: ${v}. Check it against the document.`])) };
}

/** "claude-sonnet-5-5" or "sonnet" → "Sonnet", for messages. */
export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() : model;
}

/**
 * Which of two readings to keep: the second (the stronger model's) unless the document's own
 * arithmetic finds more wrong with it than with the first.
 */
export function chooseReading(first: ReadingAssessment, second: ReadingAssessment): 'first' | 'second' {
  return second.problems.length > first.problems.length ? 'first' : 'second';
}
