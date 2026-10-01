// Payslips read from their text layer on this machine, with no Claude (docs/INGESTION.md, "Payslips
// read on this machine"). A payroll prints the same layout every month, so a layout read once by rule
// is read the same way every time, in full: every payment and deduction line, the totals, the codes
// and the year-to-date column. A payslip in another layout, or a scan, goes to Claude as before.
//
// Two layouts are known:
//   SAP paystubs (a boxed table: PAYMENTS | DEDUCTIONS, then CUMULATIVES; amounts as 1.234,56 with
//     a trailing minus for a negative), read from the page laid out;
//   the classic UK payslip (EMPLOYER, DATE, TAX CODE, PAY METHOD, PERIOD headings; a YEAR TO DATE
//     column; EMPLOYERS N.I.; NET PAY), read in the order its text was drawn.
//
// Your name and National Insurance number are on both and are never kept: only the NI category
// letter is.

import { endOfMonth, makeDate, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import { hasNiNumber, withoutNiNumbers } from '../../shared/privacy';
import { ExtractionSchema, type ExtractedFigure, type ExtractedPayslip, type Extraction, type PayslipLine, type PayslipYtdKey } from '../../shared/schema';
import { taxYearOf } from '../../shared/uk';
import type { PageText } from './govuk';

/** Bump when a reader changes what it reads. */
export const PAYSLIP_ENGINE_VERSION = 'payslip-1';

/** Which reader read it, for the import's record. */
export interface PayslipReading {
  extraction: Extraction;
  layout: 'sap' | 'uk';
}

/** A payslip in a layout known here, read in full; null when it is not one. */
export function readPayslipPage(page: PageText): PayslipReading | null {
  const sap = readSapPaystub(page.layout);
  if (sap) return { extraction: sap, layout: 'sap' };
  const uk = readUkPayslip(page.raw);
  return uk ? { extraction: uk, layout: 'uk' } : null;
}

/** "1.234,56" → 1234.56, "172,39-" → -172.39; null when it is not an amount. */
export function sapAmount(text: string): number | null {
  const m = /^\s*(-)?([\d.]+),(\d{2})(-)?\s*$/.exec(text);
  if (!m) return null;
  const n = Number(`${m[2]!.replace(/\./g, '')}.${m[3]}`);
  return Number.isFinite(n) ? (m[1] || m[4] ? -n : n) : null;
}

/** "1,012.50", "-120.45" → pounds; null when it is not an amount. */
function ukAmount(text: string): number | null {
  const m = /^\s*(-)?£?([\d,]+\.\d{2})(-)?\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[2]!.replace(/,/g, ''));
  return Number.isFinite(n) ? (m[1] || m[3] ? -n : n) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "05-Oct-2026" → ISO. */
function ukDate(text: string): ISODate | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1;
  return m && month >= 0 ? makeDate(Number(m[3]), month + 1, Number(m[1])) : null;
}

/** A tax code as printed, split from its basis: "1257L M1" → 1257L, not cumulative. */
function taxCodeOf(text: string | undefined): { taxCode: string; cumulative?: boolean } | null {
  const t = (text ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const basis = /^(.+?)\s*(?:\/|\s)\s*(M1|W1|X|W1\/M1|WK1\/MTH1)$/.exec(t);
  return basis ? { taxCode: basis[1]!, cumulative: false } : { taxCode: t };
}

// What a deduction line is, by its words.
const IS_TAX = /^(income\s+)?tax\b(?!\s*credit)|^paye\b/i;
const IS_NI = /\bnic\b|\bn\.?i\.?\b|national insurance/i;
const IS_PENSION = /pension|superannuation|\bavc\b/i;
const IS_STUDENT_LOAN = /student\s*loan|postgrad|\bpgl\b|\bsl\b/i;
const IS_DEDUCTION = new RegExp([IS_TAX, IS_NI, IS_PENSION, IS_STUDENT_LOAN, /deduction|union|charity|give as you earn|payroll giving|attachment|court order|advance|loan|cycle|salary sacrifice|repayment/i].map((r) => r.source).join('|'), 'i');

const sum = (lines: PayslipLine[], re: RegExp): number | null => {
  const of = lines.filter((l) => re.test(l.label));
  return of.length ? fromMinor(of.reduce((x, l) => x + toMinor(l.amount), 0)) : null;
};

/**
 * The figures a payslip gives for its period (as the reader always has): its gross (the total of its
 * payments), and the tax, NI, pension and student loan taken. The tax code goes on the gross.
 */
function figuresOf(p: ExtractedPayslip): ExtractedFigure[] {
  const taxYear = taxYearOf(p.payDate).label;
  const base = { currency: 'GBP', taxYear, payer: p.employer, ...(p.periodStart ? { periodStart: p.periodStart } : {}), ...(p.periodEnd ? { periodEnd: p.periodEnd } : {}), ...(p.payeReference ? { payerReference: p.payeReference } : {}) };
  const gross = p.totals.payments ?? fromMinor(p.payments.reduce((x, l) => x + toMinor(l.amount), 0));
  const out: ExtractedFigure[] = [{ ...base, kind: 'gross_pay', label: 'Total pay', amount: gross, ...(p.taxCode ? { taxCode: `${p.taxCode}${p.cumulative === false ? ' M1' : ''}` } : {}) } as ExtractedFigure];
  const kinds: [ExtractedFigure['kind'], RegExp, string][] = [
    ['tax_deducted', IS_TAX, 'Tax'],
    ['national_insurance', IS_NI, 'National Insurance'],
    ['pension_contribution_employee', IS_PENSION, 'Pension'],
    ['student_loan_deducted', IS_STUDENT_LOAN, 'Student loan'],
  ];
  for (const [kind, re, label] of kinds) {
    const amount = sum(p.deductions, re);
    if (amount !== null) out.push({ ...base, kind, label, amount } as ExtractedFigure);
  }
  return out;
}

/**
 * Do the lines add up to the totals printed, and the totals to the net pay? Notes for what does not.
 * `extra` is paid on top of the total of the payments (SAP's net claims).
 */
function checks(p: ExtractedPayslip, extra: number): string[] {
  const notes: string[] = [];
  const total = (lines: PayslipLine[]) => lines.reduce((x, l) => x + toMinor(l.amount), 0);
  if (p.totals.payments !== undefined && total(p.payments) !== toMinor(p.totals.payments)) notes.push(`The payment lines read come to ${fromMinor(total(p.payments)).toFixed(2)}, not the ${p.totals.payments.toFixed(2)} printed: check them against the payslip.`);
  if (p.totals.deductions !== undefined && total(p.deductions) !== toMinor(p.totals.deductions)) notes.push(`The deduction lines read come to ${fromMinor(total(p.deductions)).toFixed(2)}, not the ${p.totals.deductions.toFixed(2)} printed: check them against the payslip.`);
  if (p.totals.payments !== undefined && p.totals.deductions !== undefined && p.totals.net !== undefined) {
    const net = toMinor(p.totals.payments) + toMinor(extra) - toMinor(p.totals.deductions);
    if (net !== toMinor(p.totals.net)) notes.push(`Its pay less its deductions is ${fromMinor(net).toFixed(2)}, not the net pay of ${p.totals.net.toFixed(2)} printed.`);
  }
  return notes;
}

function finish(p: ExtractedPayslip, layout: string, extra = 0): Extraction {
  const problems = checks(p, extra);
  return ExtractionSchema.parse({
    documentType: 'payslip',
    institutionName: p.employer,
    documentDate: p.payDate,
    figures: figuresOf(p),
    payslips: [p],
    notes: [`A ${layout} payslip, read in full: ${p.payments.length} payment line${p.payments.length === 1 ? '' : 's'}, ${p.deductions.length} deduction line${p.deductions.length === 1 ? '' : 's'}, the totals and the year to date.`, ...problems],
    confidence: problems.length ? 'medium' : 'high',
  });
}

/** A monthly period from its pay date, when the date is a month's last day (a payroll's period end). */
const monthOf = (date: ISODate): { periodStart: ISODate; periodEnd: ISODate } | null => (endOfMonth(date) === date ? { periodStart: `${date.slice(0, 8)}01`, periodEnd: date } : null);

// ─── SAP paystubs ─────────────────────────────────────────────────────────────────────────────────

const SAP_YTD: [RegExp, PayslipYtdKey][] = [
  [/^Gross Pay$/i, 'gross'],
  [/^Taxable Pay$/i, 'taxable'],
  [/^Tax$/i, 'tax'],
  [/^NI Employee\b/i, 'ni'],
  [/^NI Employer\b/i, 'niEmployer'],
  [/^Pension Employee$/i, 'pension'],
  [/^Pension Employer$/i, 'pensionEmployer'],
  [/^Student Loan\b/i, 'studentLoan'],
];

/** An SAP paystub, from its laid-out text; null when it is not one. */
export function readSapPaystub(text: string): Extraction | null {
  if (!/\bPAYMENTS\b/.test(text) || !/\bCUMULATIVES\b/.test(text) || !/Week\/Month No\./.test(text) || !/Tax Code:/.test(text)) return null;
  const field = (label: string) => new RegExp(`${label}\\s*([^|]*?)\\s*\\|`).exec(text)?.[1]?.trim() || undefined;
  const date = /Date:\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  const payDate = date ? makeDate(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!payDate) return null;
  const rows = text.split('\n');
  const cellsOf = (line: string) => line.split('|').map((c) => c.trim());

  // The address box: the company, then (after "PRIVATE & CONFIDENTIAL" and your name) your payroll number.
  const box = rows.slice(0, rows.findIndex((l) => /TO OPEN|Date:/.test(l)) + 1 || 30).map((l) => cellsOf(l).filter(Boolean).join(' ')).filter((l) => l && !/^-+$/.test(l));
  const company = box.find((l) => !/PRIVATE|CONFIDENTIAL|^\d|^(Mr|Mrs|Ms|Miss|Dr|Mx)\b/i.test(l));
  const payrollNumber = box.find((l) => /^\d{5,12}$/.test(l));
  const employerField = field('Employer:');
  const employer = company ?? employerField;
  if (!employer) return null;

  // The PAYMENTS | DEDUCTIONS table, to its totals.
  const payments: PayslipLine[] = [];
  const deductions: PayslipLine[] = [];
  let totals: ExtractedPayslip['totals'] = {};
  const start = rows.findIndex((l) => /\bPAYMENTS\b/.test(l) && /\bDEDUCTIONS\b/.test(l));
  for (const line of rows.slice(start + 1)) {
    const c = cellsOf(line);
    if (c.length < 7) continue;
    if (/^TOTAL PAYMENTS/i.test(c[1]!)) {
      totals = { ...(sapAmount(c[4]!) !== null ? { payments: sapAmount(c[4]!)! } : {}), ...(sapAmount(c[6]!) !== null ? { deductions: sapAmount(c[6]!)! } : {}) };
      break;
    }
    const amount = sapAmount(c[4]!);
    if (c[1] && amount !== null) {
      const [quantity, rate] = [sapAmount(c[2]!), sapAmount(c[3]!)];
      payments.push({ label: c[1], amount, ...(quantity ? { quantity } : {}), ...(rate ? { rate } : {}) });
    }
    const taken = sapAmount(c[6]!);
    if (c[5] && taken !== null) deductions.push({ label: c[5], amount: taken });
  }
  if (start < 0 || totals.payments === undefined) return null;

  // CUMULATIVES: the year to date.
  const yearToDate: ExtractedPayslip['yearToDate'] = {};
  const cum = rows.findIndex((l) => /CUMULATIVES/.test(l));
  for (const line of rows.slice(cum + 1)) {
    const c = cellsOf(line).filter((x, i, all) => i > 0 && i < all.length - 1);
    for (let i = 0; i + 1 < c.length; i++) {
      const key = SAP_YTD.find(([re]) => re.test(c[i]!))?.[1];
      const value = key ? sapAmount(c[i + 1]!) : null;
      if (key && value !== null && yearToDate[key] === undefined) yearToDate[key] = value;
    }
  }
  const net = /NET PAYMENT\s*\|\s*([\d.,]+-?)/.exec(text)?.[1];
  const claims = /NET CLAIMS\s*\|\s*([\d.,]+-?)/.exec(text)?.[1];
  if (net && sapAmount(net) !== null) totals.net = sapAmount(net)!;
  // Expense claims paid with the pay, on top of its payments: not taxed.
  if (claims && sapAmount(claims)) totals.nonTaxable = sapAmount(claims)!;

  const code = taxCodeOf(field('Tax Code:'));
  const letter = /NI Code:\s*([A-Z])\b/.exec(text)?.[1];
  const number = /Week\/Month No\.\s*(\d{1,2})/.exec(text)?.[1];
  const month = monthOf(payDate);
  const others = employerField && employerField !== employer ? [employerField] : [];
  const p: ExtractedPayslip = {
    employer,
    otherNames: others,
    ...(payrollNumber ? { payrollNumber } : {}),
    payDate,
    ...(month ?? {}),
    ...(number ? { periodNumber: Number(number) } : {}),
    ...(month ? { frequency: 'monthly' as const } : {}),
    ...(code ?? {}),
    ...(letter ? { niLetter: letter } : {}),
    ...(field('Pay Method:') ? { payMethod: field('Pay Method:')! } : {}),
    ...(field('Department:') ? { department: withoutNiNumbers(field('Department:')!) } : {}),
    payments,
    deductions,
    totals,
    employerCosts: {},
    yearToDate,
  };
  return finish(p, 'SAP', totals.nonTaxable ?? 0);
}

// ─── The classic UK payslip ───────────────────────────────────────────────────────────────────────

const UK_YTD: [RegExp, PayslipYtdKey][] = [
  [/^Total Pay$/i, 'gross'],
  [/^Taxable Pay$/i, 'taxable'],
  [/^Tax$/i, 'tax'],
  [/^Tax Credit$/i, 'taxCredit'],
  [/^N\.?I\.? Employee$/i, 'ni'],
  [/^N\.?I\.? Employer$/i, 'niEmployer'],
  [/^N\.?I\.? Pay$/i, 'niablePay'],
  [/^SSP$/i, 'ssp'],
  [/^SMP$/i, 'smp'],
  [/^Pension Employee$/i, 'pension'],
  [/^Pension Employer$/i, 'pensionEmployer'],
  [/^Student Loan$/i, 'studentLoan'],
];

/** A line of labels and amounts ("Basic Pay 1,012.50 Income Tax 0.00"): each label with its numbers. */
function pairsOf(line: string): { label: string; numbers: number[] }[] {
  const out: { label: string; numbers: number[] }[] = [];
  for (const token of line.split(' ')) {
    const n = /^-?[\d,]+\.\d{2}-?$/.test(token) ? ukAmount(token) : null;
    const last = out.at(-1);
    if (n !== null) {
      if (last) last.numbers.push(n);
      continue;
    }
    if (!last || last.numbers.length) out.push({ label: token, numbers: [] });
    else last.label = `${last.label} ${token}`;
  }
  return out.filter((p) => p.numbers.length);
}

/** The classic UK payslip, from its text in drawing order; null when it is not one. */
export function readUkPayslip(text: string): Extraction | null {
  const rows = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const after = (heading: RegExp) => {
    const i = rows.findIndex((l) => heading.test(l));
    return i >= 0 ? rows[i + 1] : undefined;
  };
  if (!rows.some((l) => /^YEAR TO DATE\b/.test(l)) || !rows.includes('EMPLOYER') || !rows.includes('TAX CODE') || !rows.some((l) => /^PAY [\d,]+\.\d{2}$/.test(l) || l === 'NET')) return null;
  const employer = after(/^EMPLOYER$/);
  const payDate = ukDate(after(/^DATE$/) ?? '');
  if (!employer || !payDate) return null;
  const period = /^([A-Za-z]{3})-(\d{4})$/.exec(after(/^PERIOD$/) ?? '');
  const periodMonth = period ? MONTHS.indexOf(period[1]!.toLowerCase()) : -1;
  const periodStart = period && periodMonth >= 0 ? makeDate(Number(period[2]), periodMonth + 1, 1) : null;

  // Your NI number and its table letter ("AB 12 34 56 C - A"): only the letter is kept, and a
  // department printed before them.
  const niLine = rows[rows.findIndex((l) => /N\.I\. NUMBER AND TABLE/.test(l)) + 1] ?? '';
  const niLetter = hasNiNumber(niLine) ? /-\s*([A-Z])\s*$/.exec(niLine)?.[1] : undefined;
  const department = niLetter ? withoutNiNumbers(niLine).replace('[NI number]', '').replace(/-\s*[A-Z]\s*$/, '').trim() : '';

  // The year to date, then the payment and deduction lines, to TOTAL.
  const yearToDate: ExtractedPayslip['yearToDate'] = {};
  const payments: PayslipLine[] = [];
  const deductions: PayslipLine[] = [];
  const start = rows.findIndex((l) => /^YEAR TO DATE\b/.test(l));
  let inYtd = true;
  for (const line of rows.slice(start + 1)) {
    if (/^TOTAL$/.test(line)) break;
    const pairs = pairsOf(line);
    if (!pairs.length) continue;
    const ytd = pairs.length === 1 && pairs[0]!.numbers.length === 1 ? UK_YTD.find(([re]) => re.test(pairs[0]!.label))?.[1] : undefined;
    if (inYtd && ytd) {
      yearToDate[ytd] = pairs[0]!.numbers[0]!;
      continue;
    }
    inYtd = false;
    const line_ = (p: { label: string; numbers: number[] }): PayslipLine => {
      const amount = p.numbers.at(-1)!;
      const [rate, quantity] = p.numbers.length === 3 ? [p.numbers[0]!, p.numbers[1]!] : p.numbers.length === 2 ? [p.numbers[0]!, undefined] : [undefined, undefined];
      return { label: p.label, amount, ...(rate !== undefined ? { rate } : {}), ...(quantity !== undefined ? { quantity } : {}) };
    };
    if (pairs.length >= 2) {
      payments.push(line_(pairs[0]!));
      deductions.push(line_(pairs[1]!));
    } else if (IS_DEDUCTION.test(pairs[0]!.label)) deductions.push(line_(pairs[0]!));
    else payments.push(line_(pairs[0]!));
  }

  const amountAfter = (heading: RegExp) => {
    const v = after(heading);
    return v ? ukAmount(v.replace(/^PAY /, '').replace(/^N\.I\. /, '')) : null;
  };
  const totals: ExtractedPayslip['totals'] = {};
  const totalPay = amountAfter(/^TOTAL PAY$/);
  const taxable = amountAfter(/^TAXABLE PAY$/);
  const nonTaxable = amountAfter(/^NON-TAXABLE PAY$/);
  const deducted = (() => {
    // "DEDUCTIONS" heads the deductions column too; the total is the one after TOTAL PAY.
    const i = rows.findIndex((l) => /^TOTAL PAY$/.test(l));
    const j = rows.findIndex((l, k) => k > i && /^DEDUCTIONS$/.test(l));
    return i >= 0 && j >= 0 && rows[j + 1] ? ukAmount(rows[j + 1]!) : null;
  })();
  const net = /^PAY ([\d,]+\.\d{2})$/.exec(rows.find((l, k) => k > 0 && rows[k - 1] === 'NET' && /^PAY /.test(l)) ?? '')?.[1];
  if (totalPay !== null) totals.payments = totalPay;
  if (taxable !== null) totals.taxable = taxable;
  if (nonTaxable !== null) totals.nonTaxable = nonTaxable;
  if (deducted !== null) totals.deductions = deducted;
  if (net) totals.net = ukAmount(net)!;
  const employerNi = /^N\.I\. ([\d,]+\.\d{2})$/.exec(after(/^EMPLOYERS$/) ?? '')?.[1];
  const code = taxCodeOf(after(/^TAX CODE$/));
  const payMethod = after(/^PAY METHOD$/);

  const p: ExtractedPayslip = {
    employer,
    otherNames: [],
    payDate,
    ...(periodStart ? { periodStart, periodEnd: endOfMonth(periodStart), periodLabel: `${period![1]}-${period![2]}`, frequency: 'monthly' as const } : {}),
    ...(code ?? {}),
    ...(niLetter ? { niLetter } : {}),
    ...(payMethod ? { payMethod } : {}),
    ...(department ? { department: withoutNiNumbers(department) } : {}),
    payments,
    deductions,
    totals,
    employerCosts: employerNi ? { ni: ukAmount(employerNi)! } : {},
    yearToDate,
  };
  return finish(p, 'UK');
}
