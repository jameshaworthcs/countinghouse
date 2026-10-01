// Turn whatever an engine produced into a valid Extraction: round money to pence, repair dates,
// drop rows that cannot be salvaged (with a note), and fill defaults.

import { isISODate, parseFlexibleDate } from '../../shared/dates';
import { parseAmount, roundMoney } from '../../shared/money';
import { isNiNumber, withoutNiNumbers } from '../../shared/privacy';
import { ExtractedHmrcSchema, ExtractedPayslipSchema, ExtractionSchema, TermsRateSchema, type Extraction } from '../../shared/schema';
import { payeReference } from '../analytics/sources';
import { formatZodError } from '../store';

const MONEY_KEYS = new Set([
  'amount',
  'balanceAfter',
  'originalAmount',
  'fee',
  'value',
  'openingBalance',
  'closingBalance',
  'availableBalance',
  'creditLimit',
  'contributionsToDate',
  'gainLoss',
  'governmentBonusToDate',
  'taxYearContributions',
  'cashBalance',
  'annualIncome',
  'costBasis',
  'gain',
  'statedMoneyIn',
  'statedMoneyOut',
  // A timesheet's day or hourly rate, and a payslip line's.
  'rate',
  // A payslip in full: its totals (`payments` and `deductions` are lists on the payslip itself, and
  // left alone), employer costs and year to date; HMRC's records.
  'payments',
  'deductions',
  'taxable',
  'nonTaxable',
  'net',
  'gross',
  'tax',
  'ni',
  'niEmployer',
  'niablePay',
  'pension',
  'pensionEmployer',
  'studentLoan',
  'ssp',
  'smp',
  'taxCredit',
  'taxablePay',
  'estimatedPay',
  'leavingPay',
  'outstanding',
  'voluntaryCost',
  'weekly',
  'monthly',
  'annual',
]);
const DATE_KEYS = new Set(['date', 'transactionDate', 'periodStart', 'periodEnd', 'balanceDate', 'documentDate', 'payDate', 'asOf', 'startedOn', 'endedOn', 'calculatedOn', 'payBy', 'payableFrom', 'recordTo']);

/** An object without its null values (the reader gives null for anything not printed). */
const present = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** The fields each kind of HMRC record has; the reader gives every field on every record. */
const HMRC_FIELDS: Record<string, string[]> = {
  payment: ['employer', 'payeReference', 'payDate', 'taxablePay', 'tax', 'ni', 'taxYear'],
  'tax-code': ['employer', 'payeReference', 'date', 'code', 'cumulative', 'taxYear'],
  employment: ['employer', 'payeReference', 'asOf', 'taxYear', 'payrollNumber', 'startedOn', 'endedOn', 'estimatedPay', 'leavingPay', 'code', 'cumulative'],
  event: ['employer', 'payeReference', 'date', 'event', 'text', 'amount'],
  settlement: ['taxYear', 'asOf', 'outcome', 'amount', 'calculatedOn', 'outstanding', 'payments'],
  'ni-year': ['asOf', 'taxYear', 'status', 'contributions', 'voluntaryCost', 'payBy', 'text'],
  'state-pension-forecast': ['asOf', 'weekly', 'monthly', 'annual', 'payableFrom', 'recordTo', 'qualifyingYears', 'yearsNeeded', 'assumesYears', 'maximum'],
};

/**
 * A payslip in full, HMRC's records, an account's terms and the other values printed (extract-13),
 * as the reader gives them, made into what an extraction keeps. One that cannot be made valid is left out, with a
 * warning; a National Insurance number in any of them is taken out.
 */
function readEverything(fixed: Record<string, unknown>, original: Record<string, unknown>, warnings: string[]): void {
  // Anything but a list where one belongs is left out, not the reason the whole reading is lost.
  for (const k of ['payslips', 'hmrc', 'printed']) if (k in fixed && !Array.isArray(fixed[k])) delete fixed[k];
  if (Array.isArray(fixed.payslips)) {
    fixed.payslips = (fixed.payslips as Record<string, unknown>[]).flatMap((raw, i) => {
      const p = present(raw);
      const lines = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).map(present).filter((l) => typeof l.label === 'string' && typeof l.amount === 'number') : []);
      const ref = typeof p.payeReference === 'string' ? payeReference(p.payeReference) : undefined;
      const letter = typeof p.niLetter === 'string' ? /^\s*([A-Z])\s*$/.exec(p.niLetter.toUpperCase())?.[1] : undefined;
      const payroll = typeof p.payrollNumber === 'string' ? p.payrollNumber.replace(/\s+/g, '') : undefined;
      const slip = ExtractedPayslipSchema.safeParse({
        ...p,
        otherNames: Array.isArray(p.otherNames) ? (p.otherNames as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim() !== '') : [],
        payeReference: ref,
        payrollNumber: payroll && /^[A-Za-z0-9]{1,20}$/.test(payroll) && !isNiNumber(payroll) ? payroll : undefined,
        periodNumber: typeof p.periodNumber === 'number' ? Math.round(p.periodNumber) : undefined,
        niLetter: letter,
        department: typeof p.department === 'string' ? withoutNiNumbers(p.department) : undefined,
        payments: lines(p.payments),
        deductions: lines(p.deductions),
        totals: present((p.totals ?? {}) as Record<string, unknown>),
        employerCosts: present((p.employerCosts ?? {}) as Record<string, unknown>),
        yearToDate: present((p.yearToDate ?? {}) as Record<string, unknown>),
      });
      if (slip.success) return [slip.data];
      warnings.push(`Payslip ${i + 1} could not be kept in full: ${formatZodError(slip.error)}`);
      return [];
    });
  }
  if (Array.isArray(fixed.hmrc)) {
    fixed.hmrc = (fixed.hmrc as Record<string, unknown>[]).flatMap((raw, i) => {
      const fields = HMRC_FIELDS[String(raw.type)];
      if (!fields) return [];
      const kept = present(Object.fromEntries(fields.map((k) => [k, raw[k]])));
      if (Array.isArray(kept.contributions)) kept.contributions = (kept.contributions as Record<string, unknown>[]).map(present);
      if (typeof kept.payeReference === 'string') kept.payeReference = payeReference(kept.payeReference);
      if (typeof kept.payrollNumber === 'string' && isNiNumber(kept.payrollNumber)) delete kept.payrollNumber;
      for (const k of ['qualifyingYears', 'yearsNeeded', 'assumesYears']) if (typeof kept[k] === 'number') kept[k] = Math.round(kept[k]);
      const record = ExtractedHmrcSchema.safeParse({ type: raw.type, ...kept });
      if (record.success) return [record.data];
      warnings.push(`HMRC record ${i + 1} (${String(raw.type)}) could not be kept: ${formatZodError(record.error)}`);
      return [];
    });
  }
  // Each account's terms. Its rates are taken as the reading gives them, not as amounts (34.940% is
  // not £34.94), with their dates and balances repaired; one that cannot be kept is left out.
  const originals = Array.isArray(original.accounts) ? (original.accounts as Record<string, unknown>[]) : [];
  (Array.isArray(fixed.accounts) ? (fixed.accounts as Record<string, unknown>[]) : []).forEach((acc, i) => {
    const raw = originals[i]?.terms;
    delete acc.terms;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const t = raw as Record<string, unknown>;
    const money = (v: unknown) => {
      const x = fixValue('amount', v);
      return typeof x === 'number' ? x : undefined;
    };
    const day = (v: unknown) => {
      const x = fixValue('date', v);
      return typeof x === 'string' ? x : undefined;
    };
    const rates = (Array.isArray(t.rates) ? (t.rates as Record<string, unknown>[]) : []).flatMap((r, ri) => {
      const rate = typeof r.rate === 'number' ? r.rate : typeof r.rate === 'string' ? Number.parseFloat(r.rate.replace(/[%\s]/g, '')) : Number.NaN;
      const label = typeof r.label === 'string' && r.label.trim() ? withoutNiNumbers(r.label.trim()).slice(0, 120) : undefined;
      const parsed = TermsRateSchema.safeParse(present({ applies: r.applies, rate: Number.isFinite(rate) ? Math.round(rate * 1000) / 1000 : undefined, basis: r.basis, variable: r.variable, until: day(r.until), balance: money(r.balance), label }));
      if (parsed.success) return [parsed.data];
      warnings.push(`Account ${i + 1}: a rate it prints could not be kept (${ri + 1}): ${formatZodError(parsed.error)}`);
      return [];
    });
    const minimumPayment = money(t.minimumPayment);
    const paymentDue = day(t.paymentDue);
    if (rates.length || minimumPayment !== undefined) acc.terms = { rates, ...(minimumPayment !== undefined ? { minimumPayment } : {}), ...(paymentDue ? { paymentDue } : {}) };
  });
  // Printed values are text as printed: taken from the reading before amounts and dates were
  // repaired (a value is not an amount).
  if (Array.isArray(original.printed)) {
    fixed.printed = (original.printed as Record<string, unknown>[]).flatMap((raw) => {
      const label = typeof raw.label === 'string' ? withoutNiNumbers(raw.label.trim()).slice(0, 200) : '';
      const value = typeof raw.value === 'string' ? withoutNiNumbers(raw.value.trim()).slice(0, 500) : typeof raw.value === 'number' ? String(raw.value) : '';
      const section = typeof raw.section === 'string' && raw.section.trim() ? withoutNiNumbers(raw.section.trim()).slice(0, 120) : undefined;
      return label && value ? [{ label, value, ...(section ? { section } : {}) }] : [];
    });
  }
}

function fixValue(key: string, v: unknown): unknown {
  if (MONEY_KEYS.has(key)) {
    if (typeof v === 'string') return parseAmount(v);
    if (typeof v === 'number') return Number.isFinite(v) ? roundMoney(v) : null;
    return v;
  }
  if (DATE_KEYS.has(key) && typeof v === 'string') {
    if (isISODate(v)) return v;
    return parseFlexibleDate(v) ?? null;
  }
  if ((key === 'currency' || key === 'originalCurrency') && typeof v === 'string') {
    const c = v.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : c === '£' ? 'GBP' : null;
  }
  if ((key === 'last4' || key === 'cardLast4' || key === 'accountLast4') && typeof v === 'string') {
    // The number's own last characters: "••••4471" is 4471, but an account number that ends in
    // letters ("QK7WM3P") has no last four digits, and its scattered digits must not stand in.
    const chars = v.replace(/[^0-9A-Za-z]/g, '');
    const tail = /(\d+)$/.exec(chars)?.[1] ?? '';
    return tail.length >= 2 ? tail.slice(-4) : null;
  }
  return v;
}

function walk(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(fixValue(k, v), k);
    return out;
  }
  return value;
}

export function normaliseExtraction(raw: unknown): { extraction: Extraction; warnings: string[] } {
  const warnings: string[] = [];
  const fixed = walk(raw) as Record<string, unknown>;
  // Drop transactions / holdings that lost a required value in repair.
  const accounts = Array.isArray(fixed.accounts) ? (fixed.accounts as Record<string, unknown>[]) : [];
  for (const [ai, acc] of accounts.entries()) {
    if (Array.isArray(acc.transactions)) {
      const before = acc.transactions.length;
      acc.transactions = (acc.transactions as Record<string, unknown>[]).filter(
        (t) => typeof t.date === 'string' && typeof t.amount === 'number' && typeof t.description === 'string',
      );
      const dropped = before - (acc.transactions as unknown[]).length;
      if (dropped) warnings.push(`Account ${ai + 1}: ${dropped} transaction row(s) had an unreadable date or amount and were dropped.`);
    }
    // Apps and many statements list newest first; store chronologically (stable within a day).
    const list = acc.transactions as { date: string }[] | undefined;
    if (Array.isArray(list) && list.length > 1 && list[0]!.date > list[list.length - 1]!.date) list.reverse();
    if (Array.isArray(acc.holdings)) {
      acc.holdings = (acc.holdings as Record<string, unknown>[]).filter((h) => typeof h.value === 'number' && typeof h.name === 'string');
    }
  }
  if (Array.isArray(fixed.figures)) {
    fixed.figures = (fixed.figures as Record<string, unknown>[]).filter((f) => typeof f.amount === 'number' && typeof f.kind === 'string');
  }
  readEverything(fixed, (raw ?? {}) as Record<string, unknown>, warnings);
  const parsed = ExtractionSchema.safeParse(fixed);
  if (!parsed.success) throw new Error(`Extraction did not match the expected shape: ${formatZodError(parsed.error)}`);
  return { extraction: parsed.data, warnings };
}
