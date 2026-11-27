// A company's VAT returns, worked out from its general ledger (docs/FORMULAS.md §22, "VAT returns"):
// the nine boxes of each VAT period with the postings behind them, what stops a return being ready to
// file, each return filed against what the books give, the errors on filed returns and how they may be
// corrected (VAT Notice 700/45), HMRC's late submission penalty points as information, and taxable
// turnover against the registration thresholds. Pure but for the ledger it reads; nothing is stored, and
// nothing is sent to HMRC: the owner files through Making Tax Digital software.
//
// This is company data: one company's books at a time, served only from its own routes
// (routes/company-books.ts), never joining a figure of yours (ESLint's allowlist, eslint.config.js).

import type { CompanyVatResponse, LedgerCheck, LedgerPosting, VatBoxKey, VatBoxLine, VatBoxView, VatCorrectionsView, VatErrorRow, VatFiledComparison, VatLeftOut, VatPenaltyView, VatPeriodRow, VatReturnCheck, VatReturnView, VatThresholdView } from '../../shared/api';
import { vatPeriodsOf, type VatPeriod } from '../../shared/company-books';
import { addDays, addMonths, diffDays, endOfMonth, startOfMonth, type ISODate } from '../../shared/dates';
import { VAT_RETURN_DISCLAIMER } from '../../shared/disclaimers';
import { ledgerCode, takesVat } from '../../shared/ledger';
import { formatMoney, fromMinor, poundsWithoutPence, toMinor } from '../../shared/money';
import type { Company, CompanyFiling, VatBoxes } from '../../shared/schema';
import { ruleOn, VAT_ERROR_CORRECTION_RULES, VAT_PENALTY_POINTS_FROM, VAT_PENALTY_RULES, vatCorrectionDeadline, vatCorrectionMethod, vatFrequencyOf, vatPointExpiry, vatReturnDue, vatThresholdsOn } from '../../shared/uk';
import { companyLedger, type Ledger, type LedgerSource } from './ledger';

/** The nine boxes in order: their key (HMRC's Making Tax Digital names) and what VAT Notice 700/12 calls them. */
export const VAT_BOX_META: readonly { box: number; key: VatBoxKey; label: string }[] = [
  { box: 1, key: 'vatDueSales', label: 'VAT due on sales and other outputs' },
  { box: 2, key: 'vatDueAcquisitions', label: 'VAT due on acquisitions of goods from the EU (Northern Ireland)' },
  { box: 3, key: 'totalVatDue', label: 'Total VAT due (boxes 1 and 2)' },
  { box: 4, key: 'vatReclaimedCurrPeriod', label: 'VAT reclaimed on purchases and other inputs' },
  { box: 5, key: 'netVatDue', label: 'Net VAT to pay or reclaim (the difference of boxes 3 and 4)' },
  { box: 6, key: 'totalValueSalesExVAT', label: 'Total value of sales and all other outputs, excluding VAT' },
  { box: 7, key: 'totalValuePurchasesExVAT', label: 'Total value of purchases and all other inputs, excluding VAT' },
  { box: 8, key: 'totalValueGoodsSuppliedExVAT', label: 'Total value of supplies of goods to the EU, excluding VAT (Northern Ireland)' },
  { box: 9, key: 'totalAcquisitionsExVAT', label: 'Total value of acquisitions of goods from the EU, excluding VAT (Northern Ireland)' },
];

/**
 * Codes whose postings are never a supply for boxes 6 and 7, whatever VAT treatment a coding gives them
 * (VAT Notice 700/12 paras 3.7–3.8: wages and salaries, PAYE and National Insurance; and expenditure
 * outside the scope because it is not consideration for a supply): pay, employer's National Insurance
 * and pension contributions, depreciation (no payment at all), the Corporation Tax charge, penalties
 * and fines, and donations.
 */
export const NOT_A_SUPPLY: ReadonlySet<string> = new Set(['directors-salaries', 'employer-ni', 'staff-pensions', 'depreciation', 'corporation-tax-charge', 'penalties', 'donations']);

/** The ledger checks that stop a return being ready when they are about something in its period. */
const BLOCKING: ReadonlySet<LedgerCheck['kind']> = new Set(['uncoded', 'coding-invalid', 'foreign-currency', 'transfer-unmatched', 'journal-invalid', 'bank-not-imported', 'vat-no-invoice', 'reverse-charge-rate', 'vat-unregistered', 'reg111']);

const sourceKey = (s: LedgerPosting['source']) => `${s.kind}:${s.id}`;
const lineKey = (s: LedgerPosting['source']) => `${s.kind}:${s.id}:${s.line ?? ''}`;
const signedNet = (b: { box3: number; box4: number }) => b.box3 - b.box4;

/** A period's boxes in pence (6 and 7 exact, before the pence are left out), and the working. */
interface Worked {
  box1: number;
  box4: number;
  box6: number;
  box7: number;
  lines: Record<number, VatBoxLine[]>;
  leftOut: VatLeftOut[];
  /** The sources whose VAT or values are in it (for checks about them). */
  sources: Set<string>;
  /** Reverse charges in it: their VAT (box 1 and 4 each) and value (6 and 7 each), pence. */
  reverseTax: number;
  reverseNet: number;
}

const emptyWorked = (): Worked => ({ box1: 0, box4: 0, box6: 0, box7: 0, lines: { 1: [], 4: [], 6: [], 7: [] }, leftOut: [], sources: new Set(), reverseTax: 0, reverseNet: 0 });

export interface VatInput {
  src: LedgerSource;
  company: Company;
  today: ISODate;
  /** The return to show, by its last day; absent: the next to file. */
  period?: ISODate | undefined;
  ledger?: Ledger;
}

/**
 * Where each posting's VAT and value belong: the VAT period of the day its rule gives (FORMULAS.md §22,
 * "VAT returns"). Under cash accounting the posting's own day, its payment's (VAT Notice 731 paras
 * 4.4–4.5; a row of yours paid for the company falls on its day, when the company credits your loan); a
 * claim under reg 111 in the first return, whatever its day (Notice 731 para 3.2); a reverse charge on
 * the earlier of its payment and the last day of the service it covers (Notice 700 para 15.12: a single
 * supply's tax point is when it is completed, or paid if earlier; a continuous one's the end of its
 * billing period, or payment if earlier). An opening journal is the balances brought in, never a supply.
 */
function workOut(postings: readonly LedgerPosting[], periods: readonly VatPeriod[], opening: ReadonlySet<string>): Worked[] {
  const out = periods.map(emptyWorked);
  if (!periods.length) return out;
  const periodOf = (d: ISODate) => periods.findIndex((p) => p.start <= d && p.end >= d);
  // A reverse charge's service end, from its net posting (its VAT postings share the line).
  const coversTo = new Map<string, ISODate>();
  for (const p of postings) if (p.vat?.treatment === 'reverse-charge' && p.vat.part === 'net' && p.covers) coversTo.set(lineKey(p.source), p.covers.to);
  const own = (p: LedgerPosting) => p.source.kind === 'row' || p.source.kind === 'personal' || (p.source.kind === 'journal' && !opening.has(p.source.id));
  for (const p of postings) {
    if (!own(p)) continue;
    const entry = ledgerCode(p.ledger);
    let day = p.date;
    let counted: VatBoxLine['counted'];
    if (p.vat?.claim === 'reg111') {
      day = periods[0]!.start;
      counted = 'reg111';
    } else if (p.vat?.treatment === 'reverse-charge') {
      const end = coversTo.get(lineKey(p.source));
      if (end && end < p.date) {
        day = end;
        counted = 'tax-point';
      }
    }
    const i = periodOf(day);
    if (i < 0) continue;
    const w = out[i]!;
    const line = (amount: number): VatBoxLine => ({ postingId: p.id, source: p.source, date: p.date, ...(counted && periodOf(p.date) !== i ? { counted } : {}), ledger: p.ledger, ...(p.vat ? { treatment: p.vat.treatment } : {}), amount, memo: p.memo });
    const add = (box: 1 | 4 | 6 | 7, amount: number) => {
      if (!amount) return;
      w.lines[box]!.push(line(amount));
      w.sources.add(sourceKey(p.source));
      if (box === 1) w.box1 += amount;
      else if (box === 4) w.box4 += amount;
      else if (box === 6) w.box6 += amount;
      else w.box7 += amount;
    };
    const leave = (reason: VatLeftOut['reason'], side: VatLeftOut['side'], amount: number) => {
      if (amount) w.leftOut.push({ ...line(amount), reason, side });
    };
    if (!p.vat) {
      // No VAT treatment said: a sale or purchase code's value is left out of boxes 6 and 7 (listed),
      // never guessed at. Codes that are never a supply are left out by their nature.
      if (!entry || !takesVat(p.ledger)) continue;
      const side = entry.kind === 'income' ? 'sales' : 'purchases';
      const amount = side === 'sales' ? -p.amount : p.amount;
      leave(NOT_A_SUPPLY.has(p.ledger) ? 'not-a-supply' : 'untreated', side, amount);
      continue;
    }
    if (p.vat.part === 'tax') {
      // Box 1: output tax, a credit to VAT; box 4: input tax, a debit (a refund takes it away).
      if (p.vat.side === 'output') add(1, -p.amount);
      else add(4, p.amount);
      if (p.vat.treatment === 'reverse-charge' && p.vat.side === 'output') w.reverseTax -= p.amount;
      continue;
    }
    // The net amount: a reverse charge's value is in both boxes 6 and 7 (Notice 741A para 5.2).
    if (p.vat.treatment === 'reverse-charge') {
      add(6, p.amount);
      add(7, p.amount);
      w.reverseNet += p.amount;
      continue;
    }
    if (p.vat.side === 'output') {
      const amount = -p.amount;
      if (NOT_A_SUPPLY.has(p.ledger)) leave('not-a-supply', 'sales', amount);
      // Outside the scope: a sale whose place of supply is abroad (Notice 741A) is in box 6 (Notice
      // 700/12 para 3.7); anything else outside the scope is not a supply.
      else if (p.vat.treatment === 'outside' && p.ledger !== 'turnover') leave('outside', 'sales', amount);
      else add(6, amount);
      continue;
    }
    if (p.vat.claim === 'reg111') leave('reg111', 'purchases', p.amount);
    else if (NOT_A_SUPPLY.has(p.ledger)) leave('not-a-supply', 'purchases', p.amount);
    else if (p.vat.treatment === 'outside') leave('outside', 'purchases', p.amount);
    else add(7, p.amount);
  }
  return out;
}

/** A return's nine boxes from its worked figures (boxes 1–5 pence, 6–9 whole pounds with the pence left out). */
function boxesOf(w: Worked): VatBoxView[] {
  const box3 = w.box1;
  const values: Record<VatBoxKey, { value: number; exact?: number; lines: VatBoxLine[]; unsupported?: true }> = {
    vatDueSales: { value: w.box1, lines: w.lines[1]! },
    vatDueAcquisitions: { value: 0, lines: [], unsupported: true },
    totalVatDue: { value: box3, lines: [] },
    vatReclaimedCurrPeriod: { value: w.box4, lines: w.lines[4]! },
    netVatDue: { value: Math.abs(box3 - w.box4), lines: [] },
    totalValueSalesExVAT: { value: poundsWithoutPence(w.box6), exact: w.box6, lines: w.lines[6]! },
    totalValuePurchasesExVAT: { value: poundsWithoutPence(w.box7), exact: w.box7, lines: w.lines[7]! },
    totalValueGoodsSuppliedExVAT: { value: 0, exact: 0, lines: [], unsupported: true },
    totalAcquisitionsExVAT: { value: 0, exact: 0, lines: [], unsupported: true },
  };
  return VAT_BOX_META.map((m) => ({ ...m, ...values[m.key] }));
}

const boxValue = (boxes: readonly VatBoxView[], key: VatBoxKey) => boxes.find((b) => b.key === key)!.value;

/** The nine boxes as a filing records them (pounds, boxes 6–9 whole): what the demo files, and what a CSV gives. */
export function vatFigures(boxes: readonly VatBoxView[]): VatBoxes {
  const pounds = (k: VatBoxKey) => (k === 'totalValueSalesExVAT' || k === 'totalValuePurchasesExVAT' || k === 'totalValueGoodsSuppliedExVAT' || k === 'totalAcquisitionsExVAT' ? boxValue(boxes, k) : fromMinor(boxValue(boxes, k)));
  return Object.fromEntries(VAT_BOX_META.map((m) => [m.key, pounds(m.key)])) as unknown as VatBoxes;
}

/** A filing's boxes in the units the comparison works in: 1–5 pence, 6–9 whole pounds. */
const filedUnits = (f: VatBoxes): Record<VatBoxKey, number> =>
  Object.fromEntries(VAT_BOX_META.map((m) => [m.key, m.box <= 5 ? toMinor(f[m.key]) : f[m.key]])) as Record<VatBoxKey, number>;

/** The date a ledger check is about, and the source it names, if any. */
function checkWhere(c: LedgerCheck): { date?: ISODate; source?: string } {
  const date = 'date' in c ? c.date : undefined;
  if ('source' in c) return { ...(date ? { date } : {}), source: sourceKey(c.source) };
  if (c.kind === 'vat-no-invoice') return { date: c.date, source: `personal:${c.transactionId}` };
  return date ? { date } : {};
}

/**
 * A company's VAT returns from its books (FORMULAS.md §22, "VAT returns"): its VAT periods with their
 * state, the return asked for (or the next to file) with its boxes and working, the errors on returns
 * filed, penalty points information and taxable turnover against the thresholds. Undefined when its
 * books are not kept here.
 */
export function companyVat({ src, company, today, period: wanted, ledger: given }: VatInput): CompanyVatResponse | undefined {
  const books = company.books;
  if (!books) return undefined;
  const ledger = given ?? companyLedger(src, company.id, { until: today });
  const vat = books.vat;
  const periods = vatPeriodsOf(books, today);
  const opening = new Set(src.companyJournals(company.id).filter((j) => j.opening).map((j) => j.id));
  const worked = workOut(ledger.postings, periods, opening);
  const first = books.ledgerFrom ?? books.incorporatedOn;
  const vatFilings = books.filings.filter((f): f is Extract<CompanyFiling, { kind: 'vat' }> => f.kind === 'vat');

  // The ledger checks that belong to each period: by the source its VAT is in, else by date; VAT on a
  // day the company was not registered belongs to the first return (or, after deregistration, the last).
  const checksOf = (i: number): LedgerCheck[] => {
    const p = periods[i]!;
    return ledger.checks.filter((c) => {
      if (!BLOCKING.has(c.kind)) return false;
      const where = checkWhere(c);
      if (c.kind === 'reg111') return i === 0;
      if (c.kind === 'vat-unregistered' && vat) return where.date! < vat.registeredFrom ? i === 0 : i === periods.length - 1 && Boolean(vat.deregisteredOn);
      if (where.source && worked.some((w) => w.sources.has(where.source!))) return worked[i]!.sources.has(where.source);
      return where.date !== undefined && where.date >= p.start && where.date <= p.end;
    });
  };

  const views: VatReturnView[] = periods.map((p, i) => {
    const w = worked[i]!;
    const due = vatReturnDue(p, p.stagger);
    const inBooks = first <= p.end;
    const ended = p.end < today;
    const checks: VatReturnCheck[] = [];
    if (!ended) checks.push({ kind: 'not-ended', end: p.end });
    if (first > p.start) checks.push({ kind: 'not-in-books', ledgerFrom: first });
    if (inBooks) {
      for (const c of checksOf(i)) checks.push({ kind: 'ledger', check: c });
      const suspense = ledger.postings.filter((x) => x.ledger === 'suspense' && x.date >= p.start && x.date <= p.end).reduce((s, x) => s + x.amount, 0);
      if (suspense) checks.push({ kind: 'suspense', amount: suspense });
    }
    const boxes = inBooks ? boxesOf(w) : boxesOf(emptyWorked());
    const box3 = boxValue(boxes, 'totalVatDue');
    const box4 = boxValue(boxes, 'vatReclaimedCurrPeriod');
    const filing = p.filing?.kind === 'vat' ? p.filing : undefined;
    const late = Boolean(filing && filing.filedOn > due);
    const ready = ended && inBooks && checks.length === 0;
    const isFirst = i === 0;
    const isFinal = Boolean(vat?.deregisteredOn && p.end === vat.deregisteredOn);
    const row: VatPeriodRow = {
      start: p.start,
      end: p.end,
      due,
      stagger: p.stagger,
      status: filing ? (late ? 'filed-late' : 'filed') : !inBooks ? 'before-books' : !ended ? 'open' : ready ? 'ready' : 'not-ready',
      overdue: !filing && due < today && !(books.deadlinesFrom && due < books.deadlinesFrom),
      first: isFirst,
      final: isFinal,
      computed: inBooks ? signedNet({ box3, box4 }) : null,
      filed: filing?.figures ? toMinor(filing.figures.totalVatDue) - toMinor(filing.figures.vatReclaimedCurrPeriod) : null,
      ...(filing ? { filedOn: filing.filedOn, ...(filing.reference ? { reference: filing.reference } : {}), filingId: filing.id } : {}),
    };
    const notes: string[] = [];
    if (isFirst && w.lines[4]!.some((l) => l.counted === 'reg111' || l.date < p.start)) notes.push('It includes VAT claimed on goods and services bought before registration (VAT Regulations 1995 reg 111): the first return is where it is claimed.');
    if (isFinal) notes.push('The final return after deregistration also accounts for VAT on the stock and assets held then, if more than £1,000 (VAT Notice 700/11): not worked out here.');
    if (w.lines[1]!.some((l) => l.counted === 'tax-point')) notes.push('A reverse charge paid after the period is in it: its service ended within it, and the tax point is the earlier of that and payment (VAT Notice 700 para 15.12).');
    let filed: VatFiledComparison | undefined;
    // Only a period the books cover whole is compared: part of one would differ by what is not in them.
    if (filing?.figures && first <= p.start) filed = compare(filing, boxes, w, due);
    if (filed && !filed.matches) row.differs = true;
    return { period: row, boxes, direction: box3 > box4 ? 'pay' : box3 < box4 ? 'reclaim' : 'nil', inBooks, checks, ready, leftOut: inBooks ? w.leftOut : [], notes, ...(filed ? { filed } : {}) };
  });

  // The return to file next: the earliest ended and not filed (that the books reach, and not settled
  // before they were kept here), else the one running.
  const from = books.deadlinesFrom;
  const next = views.find((v) => !v.period.filedOn && v.period.end < today && v.inBooks && !(from && v.period.due < from)) ?? views.find((v) => v.period.start <= today && v.period.end >= today);
  const shown = wanted ? views.find((v) => v.period.end === wanted) : next;
  if (wanted && !shown) return undefined;

  const running = views.find((v) => v.period.start <= today && v.period.end >= today) ?? views.at(-1);
  return {
    company: { id: company.id, name: company.name },
    registration: vat ? { registeredFrom: vat.registeredFrom, scheme: vat.scheme, ...(vat.deregisteredOn ? { deregisteredOn: vat.deregisteredOn } : {}), stagger: periods.at(-1)?.stagger ?? vat.schedule[0]!.stagger } : null,
    periods: views.map((v) => v.period),
    ...(next ? { next: next.period.end } : {}),
    ret: shown ?? null,
    corrections: corrections(views, vatFilings, running, today),
    penalties: vat ? penalties(views, vat.schedule, today, books.deadlinesFrom) : null,
    threshold: threshold(ledger.postings, opening, books, today),
    disclaimer: VAT_RETURN_DISCLAIMER,
  };
}

/**
 * A return filed against what the books give for its period: the filing's boxes 1 and 4 include the
 * corrections of earlier errors it says it made (positive in box 1, negative in box 4: VAT Notice
 * 700/12 para 6.6), so the books' boxes with those are what it should show. Never "corrected" here.
 */
function compare(filing: Extract<CompanyFiling, { kind: 'vat' }>, boxes: readonly VatBoxView[], w: Worked, due: ISODate): VatFiledComparison {
  const f = filedUnits(filing.figures!);
  const corrections = (filing.corrections ?? []).map((c) => ({ periodEnd: c.periodEnd, amount: toMinor(c.amount) }));
  const plus = corrections.reduce((s, c) => s + Math.max(0, c.amount), 0);
  const minus = corrections.reduce((s, c) => s - Math.min(0, c.amount), 0);
  const computed = Object.fromEntries(boxes.map((b) => [b.key, b.value])) as Record<VatBoxKey, number>;
  const expected = { ...computed };
  expected.vatDueSales += plus;
  expected.totalVatDue = expected.vatDueSales + expected.vatDueAcquisitions;
  expected.vatReclaimedCurrPeriod += minus;
  expected.netVatDue = Math.abs(expected.totalVatDue - expected.vatReclaimedCurrPeriod);
  const rows = VAT_BOX_META.map((m) => ({ box: m.box, key: m.key, filed: f[m.key], computed: computed[m.key], expected: expected[m.key], difference: f[m.key] - expected[m.key] }));
  const d = (box: number) => rows[box - 1]!.difference;
  const causes: string[] = [];
  const money = (minor: number) => formatMoney(fromMinor(Math.abs(minor)));
  const rcPounds = Math.abs(w.reverseNet) / 100;
  if (w.reverseTax && d(1) === -w.reverseTax && d(4) === -w.reverseTax) {
    const values = Math.abs(d(6) + rcPounds) <= 1 && Math.abs(d(7) + rcPounds) <= 1;
    causes.push(`The reverse charge looks left out of the filing: boxes 1 and 4 are each ${money(w.reverseTax)} short, which nets to nothing (box 5 is the same)${values ? `, and boxes 6 and 7 about £${Math.round(rcPounds).toLocaleString('en-GB')} short` : ''}. A reverse charge goes in boxes 1, 4, 6 and 7 (VAT Notice 741A para 5.2).`);
  } else if (d(1) && d(1) === d(4)) causes.push(`Boxes 1 and 4 differ by the same ${money(d(1))}, so the net VAT is the same: VAT accounted both ways (a reverse charge, say) is in one and not the other.`);
  else {
    if (d(1) && !d(4)) causes.push('Only box 1 differs: sales VAT counted differently (a sale in another period, or a credit note), or a correction of an earlier return the filing included and this does not know of (record it below).');
    if (d(4) && !d(1)) causes.push('Only box 4 differs: input VAT counted differently (a purchase in another period, a claim without a VAT invoice), or a correction of an earlier return the filing included and this does not know of (record it below).');
  }
  if (!d(1) && !d(4) && (d(6) || d(7))) {
    if (Math.abs(d(6)) <= 1 && Math.abs(d(7)) <= 1) causes.push('Boxes 6 and 7 differ by a pound at most: the pence were rounded in the filing, not left out.');
    else causes.push('The VAT is the same; only the values before VAT differ: exempt, zero-rated or outside-the-scope items, or a reverse charge’s value, counted differently.');
  }
  if (d(3) !== d(1) + d(2)) causes.push('The filing’s box 3 is not its boxes 1 and 2 together.');
  const expectedNet = expected.totalVatDue - expected.vatReclaimedCurrPeriod;
  const filedNet = f.totalVatDue - f.vatReclaimedCurrPeriod;
  if (Math.sign(expectedNet) * Math.sign(filedNet) < 0) causes.push('Box 5 goes the other way: the books have VAT to ' + (expectedNet > 0 ? 'pay' : 'reclaim') + ', the filing to ' + (filedNet > 0 ? 'pay' : 'reclaim') + '.');
  return { filedOn: filing.filedOn, ...(filing.reference ? { reference: filing.reference } : {}), late: filing.filedOn > due, corrections, boxes: rows, matches: rows.every((r) => r.difference === 0), causes };
}

/**
 * The errors on returns filed, as the books find them, and how they may be corrected (VAT Notice
 * 700/45): for each filed return the books cover whole, the net VAT the books give (box 3 less box 4)
 * less what it declared for its own period (its boxes less the corrections of earlier returns it
 * included), its parts (output tax, input tax), what was corrected since (on later returns, or reported
 * separately), and what is left. The errors that count (in time, and from books with nothing to clear
 * for the period) add up to a net, which may go on the current return when it is within the limits.
 */
function corrections(views: readonly VatReturnView[], filings: readonly Extract<CompanyFiling, { kind: 'vat' }>[], running: VatReturnView | undefined, today: ISODate): VatCorrectionsView {
  const rules = ruleOn(VAT_ERROR_CORRECTION_RULES, today);
  const errors: VatErrorRow[] = [];
  let total = 0;
  for (const v of views) {
    const f = v.filed;
    if (!f || v.checks.some((c) => c.kind === 'not-in-books')) continue;
    const filing = filings.find((x) => x.periodEnd === v.period.end)!;
    const by = (k: VatBoxKey) => f.boxes.find((b) => b.key === k)!;
    const plus = f.corrections.reduce((s, c) => s + Math.max(0, c.amount), 0);
    const minus = f.corrections.reduce((s, c) => s - Math.min(0, c.amount), 0);
    // Output tax declared too little is due to HMRC; input tax claimed too much is too.
    const output = by('vatDueSales').computed - (by('vatDueSales').filed - plus);
    const input = by('vatReclaimedCurrPeriod').filed - minus - by('vatReclaimedCurrPeriod').computed;
    const error = output + input;
    if (!error) continue;
    const correctedBy: VatErrorRow['correctedBy'] = [
      ...filings.flatMap((x) => (x.corrections ?? []).filter((c) => c.periodEnd === v.period.end).map((c) => ({ kind: 'return' as const, periodEnd: x.periodEnd, amount: toMinor(c.amount) }))),
      ...(filing.disclosed ? [{ kind: 'separately' as const, on: filing.disclosed.on, amount: toMinor(filing.disclosed.amount), ...(filing.disclosed.reference ? { reference: filing.disclosed.reference } : {}) }] : []),
    ];
    const uncorrected = error - correctedBy.reduce((s, c) => s + c.amount, 0);
    // Input tax under-claimed has 4 years from the return's due day; the rest from the period's end.
    const inTimeUntil = vatCorrectionDeadline(v.period.end, v.period.due, error < 0 && input < 0);
    const outOfTime = today > inTimeUntil;
    const unsettled = v.checks.length > 0;
    if (!outOfTime && !unsettled) total += uncorrected;
    errors.push({ start: v.period.start, end: v.period.end, due: v.period.due, error, output, input, correctedBy, uncorrected, runningTotal: total, inTimeUntil, outOfTime, unsettled });
  }
  const on = running ? { start: running.period.start, end: running.period.end, box6: boxValue(running.boxes, 'totalValueSalesExVAT'), provisional: !running.ready } : undefined;
  const chosen = total ? vatCorrectionMethod(total, on?.box6 ?? 0, today) : undefined;
  return { errors, net: total, ...(on ? { on } : {}), method: chosen?.method ?? 'none', limit: chosen?.limit ?? null, maxMinor: chosen?.maxMinor ?? rules.limit * 100, rules: { from: rules.from, limit: rules.limit, upperLimit: rules.upperLimit, box6Percent: rules.box6Percent, years: rules.years } };
}

/**
 * HMRC's late submission penalty points, as information (FORMULAS.md §22, "VAT returns"): every return
 * filed after its due day, or not filed with its day passed, under the regime of its period (points from
 * periods starting on 1 January 2023, the default surcharge before; the first and final returns never
 * take a point); when each point would expire below the threshold; how many would still count today if
 * the threshold was never reached; and each change of frequency with HMRC's adjustment. Not HMRC's count.
 */
function penalties(views: readonly VatReturnView[], schedule: NonNullable<NonNullable<Company['books']>['vat']>['schedule'], today: ISODate, settledBefore: ISODate | undefined): VatPenaltyView {
  const r = ruleOn(VAT_PENALTY_RULES, today);
  const now = views.find((v) => v.period.start <= today && v.period.end >= today) ?? views.at(-1);
  const frequency = vatFrequencyOf(now?.period.stagger ?? schedule.at(-1)!.stagger);
  const late: VatPenaltyView['late'] = [];
  for (const v of views) {
    const p = v.period;
    // Not filed and due before the books were kept here (`deadlinesFrom`): settled then, as the deadlines take it.
    const isLate = p.filedOn ? p.filedOn > p.due : p.due < today && !(settledBefore && p.due < settledBefore);
    if (!isLate) continue;
    const excluded = p.first ? ('first' as const) : p.final ? ('final' as const) : undefined;
    const regime = p.start < VAT_PENALTY_POINTS_FROM ? ('surcharge' as const) : excluded ? ('excluded' as const) : ('points' as const);
    late.push({ start: p.start, end: p.end, due: p.due, filedOn: p.filedOn ?? null, days: diffDays(p.due, p.filedOn ?? today), expires: vatPointExpiry(p.due), regime, ...(excluded ? { excluded } : {}) });
  }
  const sorted = [...schedule].sort((a, b) => a.from.localeCompare(b.from));
  const changes: VatPenaltyView['changes'] = [];
  for (let i = 1; i < sorted.length; i++) {
    const was = vatFrequencyOf(sorted[i - 1]!.stagger);
    const to = vatFrequencyOf(sorted[i]!.stagger);
    if (was !== to && sorted[i]!.from >= VAT_PENALTY_POINTS_FROM) changes.push({ from: sorted[i]!.from, was, to, adjustment: r.frequencyChange[was][to] });
  }
  return {
    from: VAT_PENALTY_POINTS_FROM,
    frequency,
    rules: { thresholds: r.thresholds, penalty: r.penalty, expiryMonths: r.expiryMonths, complianceMonths: r.complianceMonths, outstandingMonths: r.outstandingMonths, frequencyChange: r.frequencyChange },
    late,
    live: late.filter((l) => l.regime === 'points' && l.expires >= today).length,
    changes,
  };
}

/**
 * Taxable turnover in the 12 months to a day, from the books (VATA 1994 Sch 1 para 1; GOV.UK, "When to
 * register"): sales at the standard, reduced or zero rate, and sales coded with no VAT treatment (counted
 * as taxable, since nothing says they are exempt or outside the scope), but not those exempt or outside
 * the scope, nor supplies of the company's capital assets (`disposals`, Sch 1 para 1(7)); and the value
 * of services received from abroad under the reverse charge (VAT Notice 700 para 5.4). By the day paid,
 * as the books are kept (cash accounting): a supply not yet paid for is not in it.
 */
export function taxableTurnover(postings: readonly LedgerPosting[], opening: ReadonlySet<string>, from: ISODate, to: ISODate): VatThresholdView['parts'] {
  const parts = { sales: 0, untreated: 0, reverseCharge: 0 };
  for (const p of postings) {
    if (p.date < from || p.date > to) continue;
    if (!(p.source.kind === 'row' || p.source.kind === 'personal' || (p.source.kind === 'journal' && !opening.has(p.source.id)))) continue;
    const entry = ledgerCode(p.ledger);
    if (p.vat?.treatment === 'reverse-charge' && p.vat.part === 'net') {
      parts.reverseCharge += p.amount;
      continue;
    }
    if (entry?.kind !== 'income' || p.ledger === 'disposals') continue;
    if (!p.vat) parts.untreated -= p.amount;
    else if (p.vat.part === 'net' && (p.vat.treatment === 'standard' || p.vat.treatment === 'reduced' || p.vat.treatment === 'zero')) parts.sales -= p.amount;
  }
  return parts;
}

function threshold(postings: readonly LedgerPosting[], opening: ReadonlySet<string>, books: NonNullable<Company['books']>, today: ISODate): VatThresholdView {
  const to = today;
  const from = addDays(addMonths(to, -12), 1);
  const parts = taxableTurnover(postings, opening, from, to);
  const t = vatThresholdsOn(to);
  const months: VatThresholdView['months'] = [];
  for (let k = 12; k >= 1; k--) {
    const end = endOfMonth(addMonths(startOfMonth(today), -k));
    const m = taxableTurnover(postings, opening, startOfMonth(addMonths(end, -11)), end);
    const tm = vatThresholdsOn(end);
    months.push({ end, taxable: m.sales + m.untreated + m.reverseCharge, registration: tm.registration, deregistration: tm.deregistration });
  }
  const vat = books.vat;
  return {
    from,
    to,
    taxable: parts.sales + parts.untreated + parts.reverseCharge,
    parts,
    registration: t.registration,
    deregistration: t.deregistration,
    thresholdsFrom: t.from,
    months,
    partial: (books.ledgerFrom ?? books.incorporatedOn) > from,
    registered: Boolean(vat && vat.registeredFrom <= to && !(vat.deregisteredOn && vat.deregisteredOn < to)),
  };
}

/** A VAT return as CSV: its period, the nine boxes as they are filed, and the disclaimer last. */
export function vatReturnCsv(company: Pick<Company, 'name'>, ret: VatReturnView, cell: (v: string | number) => string): string {
  const lines = ['box,description,value'];
  for (const b of ret.boxes) lines.push([String(b.box), b.label, b.box <= 5 ? fromMinor(b.value).toFixed(2) : String(b.value)].map(cell).join(','));
  lines.push('', ['company', company.name].map(cell).join(','), ['period', `${ret.period.start} to ${ret.period.end}`].map(cell).join(','), ['due', ret.period.due].map(cell).join(','));
  lines.push(['box 5 is', ret.direction === 'pay' ? 'to pay' : ret.direction === 'reclaim' ? 'to reclaim' : 'nil'].map(cell).join(','));
  lines.push(['state', ret.period.status].map(cell).join(','));
  if (!ret.ready) lines.push(cell(`Not ready to file: ${ret.checks.length} check${ret.checks.length === 1 ? '' : 's'} to clear (see the VAT tab).`));
  lines.push(cell('Boxes 1 to 5 are in pounds and pence; boxes 6 to 9 in whole pounds, the pence left out. Boxes 2, 8 and 9 (goods between Northern Ireland and the EU) are not supported here.'));
  lines.push('', cell(VAT_RETURN_DISCLAIMER));
  return lines.join('\n') + '\n';
}
