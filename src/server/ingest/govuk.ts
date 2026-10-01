// HMRC's pages on gov.uk, read from their text layer on this machine, with no Claude (docs/INGESTION.md,
// "HMRC's pages"). A printed or saved gov.uk page has its words as text, in one layout per page kind,
// so each kind has a reader here. A page no reader knows goes to Claude as before.
//
// What each page gives (shared/schema.ts, ExtractedHmrc):
//   Check your Income Tax: taxable income from an employer → one `payment` per pay date (the
//     employer's own reports to HMRC), and the job's estimate or leaving date;
//   Check your Income Tax: your taxable income for a year → each job's pay for the year (figures);
//   PAYE Service: employment details → the `employment` as HMRC shows it that day;
//   PAYE Service: all activity → `tax-code` notices and `event`s (a job started or ended);
//   Check how much Income Tax you paid → the year's `settlement`;
//   Check your State Pension: summary → the `state-pension-forecast`; NI record → `ni-year`s.

import { runProcess } from './claude-cli';
import { formatDate, makeDate, type ISODate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import { ExtractionSchema, type Extraction, type ExtractedFigure, type ExtractedHmrc } from '../../shared/schema';
import { taxYearOf, taxYear as makeTaxYear } from '../../shared/uk';
import { payeReference } from '../analytics/sources';

/** Bump when a reader changes what it reads. */
export const GOVUK_ENGINE_VERSION = 'govuk-1';

/** A page's text: as laid out (columns kept apart), and in the order it was drawn (one block after another). */
export interface PageText {
  layout: string;
  raw: string;
}

/** The text of a PDF, both ways, or null when it has none (a scan). */
export async function pdfText(file: string, cwd: string): Promise<PageText | null> {
  try {
    const [layout, raw] = await Promise.all([runProcess('pdftotext', ['-layout', file, '-'], { cwd, timeoutMs: 30_000 }), runProcess('pdftotext', ['-raw', file, '-'], { cwd, timeoutMs: 30_000 })]);
    if (layout.code !== 0 || raw.code !== 0 || raw.stdout.replace(/\s/g, '').length < 40) return null;
    return { layout: layout.stdout, raw: raw.stdout };
  } catch {
    // No pdftotext here: Claude reads the page as before.
    return null;
  }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "27 August 2026", "30 September2026", "19August 2026" → ISO; null when it is not a date. */
export function parseLongDate(text: string): ISODate | null {
  const m = /^\s*(\d{1,2})\s*([A-Za-z]+)\s*(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return makeDate(Number(m[3]), month + 1, day);
}

/** "£1,150.00", "1,150.00", "-120.45", "£6,750" → pounds; null when it is not an amount. */
export function parseMoney(text: string): number | null {
  const m = /^\s*(-)?\s*£?\s*(-)?([\d,]+(?:\.\d{1,2})?)\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[3]!.replace(/,/g, ''));
  return Number.isFinite(n) ? (m[1] || m[2] ? -n : n) : null;
}

/** The day a browser printed the page: "01/10/2026, 15:49" in its header. */
function printedOn(text: string): ISODate | null {
  const m = /\b(\d{2})\/(\d{2})\/(\d{4}),\s*\d{1,2}:\d{2}\b/.exec(text);
  return m ? makeDate(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

/** The page's lines, trimmed and without blanks or the site's own menus and footers. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !CHROME.some((re) => re.test(l)));
}

const CHROME = [
  /^(Cookies|Accessibility statement|Privacy policy|Terms and conditions|Help using GOV\.UK|Contact|Rhestr o Wasanaethau Cymraeg)\b/i,
  /Open Government Licence|Crown copyright|opens in new tab|beta-feedback|report-technical-problem|^Beta\b|^newTab=|^you-earn\/\)|^https?:\/\//i,
  /^(Sign out|Account home|Messages|Form tracker|Profile and settings|Business tax account|Check progress|English Cymraeg|Back|Get help|Hide|message|PAYE ?Service|View details|View payments|Other actions|Print (this|your) .*)$/i,
  // The service's menu on one line, and the footer's licence line as it wraps.
  /^Account home\b.*\bSign out$/i,
  /^All content is available under the Open Government/i,
];

/** "2025 to 2026" → "2025/26". */
const yearLabel = (start: number) => `${start}/${String((start + 1) % 100).padStart(2, '0')}`;

const extraction = (e: Partial<Extraction>): Extraction => ExtractionSchema.parse({ documentType: 'tax_document', institutionName: 'HM Revenue & Customs', confidence: 'high', ...e });

/** "Check your Income Tax": taxable income, Income Tax and NI from one employer, pay date by pay date. */
function taxableIncomeFromEmployer(page: PageText): Extraction | null {
  const text = lines(page.raw).join('\n');
  const head = /Taxable income from\s+([\s\S]+?)\s+Income Tax and National Insurance paid to\s+(\d{1,2}\s*[A-Za-z]+\s*\d{4})/.exec(text);
  if (!head || !/Taxable income \(£\)/.test(text)) return null;
  const employer = head[1]!.replace(/\s+/g, ' ').trim();
  const paidTo = parseLongDate(head[2]!);
  if (!paidTo) return null;
  const hmrc: ExtractedHmrc[] = [];
  const sums: [number, number, number] = [0, 0, 0];
  let total: number[] | null = null;
  for (const line of text.split('\n')) {
    const row = /^(\d{1,2} [A-Za-z]+ \d{4}) (-?[\d,]+\.\d{2}) (-?[\d,]+\.\d{2})(?: (-?[\d,]+\.\d{2}))?$/.exec(line);
    if (row) {
      const payDate = parseLongDate(row[1]!);
      const [pay, tax, ni] = [parseMoney(row[2]!), parseMoney(row[3]!), row[4] ? parseMoney(row[4]) : null];
      if (!payDate || pay === null || tax === null) continue;
      sums[0] += Math.round(pay * 100);
      sums[1] += Math.round(tax * 100);
      sums[2] += Math.round((ni ?? 0) * 100);
      hmrc.push({ type: 'payment', employer, payDate, taxablePay: pay, tax, ...(ni !== null ? { ni } : {}), taxYear: taxYearOf(payDate).label });
      continue;
    }
    const t = /^Total (-?[\d,]+\.\d{2}) (-?[\d,]+\.\d{2})(?: (-?[\d,]+\.\d{2}))?$/.exec(line);
    if (t) total = [parseMoney(t[1]!)!, parseMoney(t[2]!)!, t[3] ? parseMoney(t[3])! : 0];
  }
  if (!hmrc.length) return null;
  const notes = [`HMRC's record of the pay ${employer} reported, pay date by pay date, to ${formatDate(paidTo)}.`];
  const totalsAgree = !total || total.every((v, i) => Math.round(v * 100) === sums[i]);
  if (!totalsAgree) notes.push(`The rows do not add up to the page's printed total (${total!.map((v) => v.toFixed(2)).join(', ')}): check them against the page.`);
  const estimate = /estimate your annual taxable income from them will be\s*£([\d,]+(?:\.\d{2})?)/.exec(text.replace(/\n/g, ' '));
  const ended = /paid up to (\d{1,2}\s*[A-Za-z]+\s*\d{4}) when your employment with them ended/.exec(text.replace(/\n/g, ' '));
  const endedOn = ended ? parseLongDate(ended[1]!) : null;
  if (estimate || endedOn) {
    hmrc.push({ type: 'employment', employer, asOf: paidTo, taxYear: taxYearOf(paidTo).label, ...(estimate ? { estimatedPay: parseMoney(estimate[1]!)! } : {}), ...(endedOn ? { endedOn } : {}) });
    if (estimate) notes.push(`HMRC estimates £${estimate[1]} of taxable pay from ${employer} this year: an estimate, kept with the job, never counted as income.`);
  }
  return extraction({ documentDate: paidTo, hmrc, notes, confidence: totalsAgree ? 'high' : 'medium' });
}

/** "Check your Income Tax": your taxable income for a tax year, job by job. */
function yearTaxableIncome(page: PageText): Extraction | null {
  const all = lines(page.raw);
  const text = all.join('\n');
  const head = /Your taxable income for\s+(\d{1,2}\s*[A-Za-z]+\s*\d{4})\s+to\s+(\d{1,2}\s*[A-Za-z]+\s*\d{4})/.exec(text);
  if (!head) return null;
  const [from, to] = [parseLongDate(head[1]!), parseLongDate(head[2]!)];
  if (!from || !to) return null;
  const ty = taxYearOf(from);
  const start = all.findIndex((l) => /^Your income from employment$/i.test(l));
  if (start < 0) return null;
  const figures: ExtractedFigure[] = [];
  let name: string[] = [];
  let pending: { employer: string; amount: number; ref?: string } | null = null;
  const flush = () => {
    if (pending) {
      figures.push({
        kind: 'gross_pay',
        label: 'Taxable income from employment',
        amount: pending.amount,
        currency: 'GBP',
        periodStart: from,
        periodEnd: to,
        taxYear: ty.label,
        payer: pending.employer,
        payerReference: pending.ref ?? null,
        accountLast4: null,
        taxCode: null,
        work: null,
      });
    }
    pending = null;
    name = [];
  };
  for (const line of all.slice(start + 1)) {
    if (/^(Your income from|HM Revenue & Customs$)/i.test(line)) break;
    const amount = /^£[\d,]+(?:\.\d{2})?$/.test(line) ? parseMoney(line) : null;
    if (amount !== null && name.length && !pending) {
      pending = { employer: name.join(' ').replace(/\s+/g, ' ').trim(), amount };
      continue;
    }
    const ref = /^Employer PAYE reference:?\s*(.+)$/i.exec(line);
    if (ref && pending) {
      const tidy = payeReference(ref[1]);
      if (tidy) pending.ref = tidy;
      continue;
    }
    if (/^Check the income details sent to us$/i.test(line)) {
      flush();
      continue;
    }
    if (/^Tax code at end of year/i.test(line)) continue;
    if (!pending) name.push(line);
  }
  flush();
  if (!figures.length) return null;
  return extraction({
    documentDate: to,
    figures,
    notes: [`HMRC's record of your taxable pay from each job for ${ty.label}. The page shows no tax taken off; each job's own page, or its P60, has that.`],
  });
}

/** "PAYE Service": one job as HMRC shows it (dates, payroll number, PAYE reference, code). */
function employmentDetails(page: PageText): Extraction | null {
  const all = lines(page.raw);
  const text = all.join('\n');
  const head = /Employment details for\s+([\s\S]+?)\n(?=(?:Start date|End date|Estimated taxable|P45 amount|Tax code|Payroll number)\b)/.exec(text);
  if (!head) return null;
  const employer = head[1]!.replace(/\s+/g, ' ').trim();
  const asOf = printedOn(page.raw) ?? printedOn(page.layout);
  if (!asOf) return null;
  const field = (label: RegExp) => {
    const m = label.exec(text);
    return m ? m[1]!.trim() : undefined;
  };
  const startedOn = field(/^Start date\s+(.+)$/m);
  const endedOn = field(/^End date\s+(.+)$/m);
  const estimated = field(/Estimated taxable\s*\n?\s*income\s*\n?\s*(£[\d,]+(?:\.\d{2})?)/);
  const leaving = field(/^P45 amount\s+(£[\d,]+(?:\.\d{2})?)/m);
  const code = /^Tax code\s+([A-Z0-9]{1,8})(\s+(?:Week\s*1\s*\/\s*Month\s*1|W1\/M1|M1|W1|X))?/m.exec(text);
  const payroll = /^Payroll number\s+([A-Za-z0-9]{1,20})\s*$/m.exec(text);
  const ref = /Employer PAYE\s*\n?\s*reference\s*\n?\s*(\d{3}\s*\/\s*[A-Z0-9]+)/.exec(text);
  const record: ExtractedHmrc = {
    type: 'employment',
    employer,
    asOf,
    taxYear: taxYearOf(asOf).label,
    ...(ref && payeReference(ref[1]) ? { payeReference: payeReference(ref[1])! } : {}),
    ...(payroll ? { payrollNumber: payroll[1]! } : {}),
    ...(startedOn && parseLongDate(startedOn) ? { startedOn: parseLongDate(startedOn)! } : {}),
    ...(endedOn && parseLongDate(endedOn) ? { endedOn: parseLongDate(endedOn)! } : {}),
    ...(estimated && parseMoney(estimated) !== null ? { estimatedPay: parseMoney(estimated)! } : {}),
    ...(leaving && parseMoney(leaving) !== null ? { leavingPay: parseMoney(leaving)! } : {}),
    ...(code ? { code: code[1]!, cumulative: !code[2] } : {}),
  };
  return extraction({ documentDate: asOf, hmrc: [record], notes: [`HMRC's PAYE record of your job at ${employer}, as on ${formatDate(asOf)}.`] });
}

/** "PAYE Service": all activity on your PAYE account (tax codes issued, jobs started and ended). */
function payeActivity(page: PageText): Extraction | null {
  if (!/All activity on your PAYE/i.test(page.layout)) return null;
  const asOf = printedOn(page.layout) ?? printedOn(page.raw);
  if (!asOf) return null;
  const all = lines(page.layout).filter((l) => !/All activity on your PAYE|^account$|PAYE Service - GOV\.UK|^\d{2}\/\d{2}\/\d{4},/.test(l));
  const STARTS = /^(Your updated tax code for|New employment at|Employment ended at|Tax year started|Personal Allowance of)/i;
  const hmrc: ExtractedHmrc[] = [];
  let text: string[] = [];
  let last: ExtractedHmrc | null = null;
  // Entries begin at the first one: anything above it is the page's heading.
  const first = all.findIndex((l) => STARTS.test(l));
  for (const line of first >= 0 ? all.slice(first) : all) {
    const date = parseLongDate(line);
    if (date && text.length) {
      const entry = text.join(' ').replace(/\s+/g, ' ').trim();
      last = activityEntry(entry, date);
      if (last) hmrc.push(last);
      text = [];
      continue;
    }
    if (!text.length && !STARTS.test(line) && last && last.type === 'event') {
      // A line after an entry's date that starts no new entry says more about it.
      last.text = `${last.text} ${line}`.slice(0, 500);
      continue;
    }
    if (!text.length && !STARTS.test(line) && last && last.type === 'tax-code') continue;
    text.push(line);
  }
  if (!hmrc.length) return null;
  const codes = hmrc.filter((r) => r.type === 'tax-code').length;
  return extraction({ documentDate: asOf, hmrc, notes: [`HMRC's PAYE account activity as on ${formatDate(asOf)}: ${codes} tax code${codes === 1 ? '' : 's'} issued, and ${hmrc.length - codes} other event${hmrc.length - codes === 1 ? '' : 's'}.`] });
}

function activityEntry(entry: string, date: ISODate): ExtractedHmrc | null {
  const ty = taxYearOf(date).label;
  const code = /^Your updated tax code for (.+?) is ([A-Z0-9]{1,8})(?:\s*(Week\s*1\s*\/\s*Month\s*1|W1\/M1|M1|W1|X))?\b/i.exec(entry);
  if (code) return { type: 'tax-code', employer: code[1]!.trim(), date, code: code[2]!.toUpperCase(), cumulative: !code[3], taxYear: ty };
  const started = /^New employment at (.+)$/i.exec(entry);
  if (started) return { type: 'event', employer: started[1]!.trim(), date, event: 'started', text: entry };
  const ended = /^Employment ended at (.+)$/i.exec(entry);
  if (ended) return { type: 'event', employer: ended[1]!.trim(), date, event: 'ended', text: entry };
  const allowance = /^Personal Allowance of £([\d,]+(?:\.\d{2})?) added/i.exec(entry);
  if (allowance) return { type: 'event', date, event: 'allowance', text: entry, amount: parseMoney(allowance[1]!)! };
  if (/^Tax year started/i.test(entry)) return { type: 'event', date, event: 'year-started', text: entry };
  return { type: 'event', date, event: 'other', text: entry.slice(0, 500) };
}

/** "Check how much Income Tax you paid": HMRC's working out of a finished year, and how it was settled. */
function taxYouPaid(page: PageText): Extraction | null {
  const text = lines(page.raw).join(' ');
  if (!/Check how much Income Tax you paid/i.test(text)) return null;
  const year = /for (\d{1,2} [A-Za-z]+ (\d{4})) to (\d{1,2} [A-Za-z]+ \d{4})/.exec(text);
  if (!year) return null;
  const ty = makeTaxYear(Number(year[2]));
  const asOf = printedOn(page.raw) ?? printedOn(page.layout);
  if (!asOf) return null;
  const owe = /Tax you owe £([\d,]+(?:\.\d{2})?)/.exec(text);
  const refund = /(?:We owe you|You are owed|Your refund is) £([\d,]+(?:\.\d{2})?)/i.exec(text);
  const calc = /(\d{1,2} [A-Za-z]+ \d{4}) Amount as shown on your tax calculation letter £([\d,]+(?:\.\d{2})?)/i.exec(text);
  const payments = [...text.matchAll(/(\d{1,2} [A-Za-z]+ \d{4}) You paid by ([a-z ]+?) £([\d,]+(?:\.\d{2})?)/gi)].flatMap((m) => {
    const date = parseLongDate(m[1]!);
    return date ? [{ date, amount: parseMoney(m[3]!)!, how: m[2]!.trim() }] : [];
  });
  const outstanding = owe ? parseMoney(owe[1]!)! : refund ? -parseMoney(refund[1]!)! : 0;
  const underpaid = /paid too little|You owe|Why you owed tax/i.test(text) || Boolean(calc);
  const outcome = refund || /paid too much|repayment/i.test(text) ? 'overpaid' : underpaid ? 'underpaid' : 'settled';
  const record: ExtractedHmrc = {
    type: 'settlement',
    taxYear: ty.label,
    asOf,
    outcome,
    ...(calc ? { amount: parseMoney(calc[2]!)!, ...(parseLongDate(calc[1]!) ? { calculatedOn: parseLongDate(calc[1]!)! } : {}) } : {}),
    outstanding,
    payments,
  };
  return extraction({ documentDate: asOf, hmrc: [record], notes: [`HMRC's working out of ${ty.label}: ${outcome === 'underpaid' ? 'tax was still owed' : outcome === 'overpaid' ? 'tax was overpaid' : 'nothing owed either way'}; ${outstanding > 0 ? `${formatMoney(outstanding)} still to pay` : outstanding < 0 ? `${formatMoney(-outstanding)} to be repaid` : 'nothing outstanding'} on ${formatDate(asOf)}.`] });
}

/** "Check your State Pension": your State Pension summary (the forecast). */
function statePensionSummary(page: PageText): Extraction | null {
  const text = lines(page.raw).join(' ');
  if (!/Your State Pension summary/i.test(text)) return null;
  const forecast = /Your forecast is £([\d,]+\.\d{2}) a week,? £([\d,]+\.\d{2}) a month,? £([\d,]+\.\d{2}) a year/i.exec(text);
  if (!forecast) return null;
  const asOf = printedOn(page.raw) ?? printedOn(page.layout);
  if (!asOf) return null;
  const from = /get your State Pension on (\d{1,2} [A-Za-z]+ \d{4})/i.exec(text);
  const recordTo = /based on your National Insurance record up to (\d{1,2} [A-Za-z]+ \d{4})/i.exec(text);
  const assumes = /assumes that you.?ll contribute another (\d+) years?/i.exec(text);
  const years = /You currently have (\d+) years? on your record and you need at least (\d+) years?/i.exec(text);
  const record: ExtractedHmrc = {
    type: 'state-pension-forecast',
    asOf,
    weekly: parseMoney(forecast[1]!)!,
    monthly: parseMoney(forecast[2]!)!,
    annual: parseMoney(forecast[3]!)!,
    ...(from && parseLongDate(from[1]!) ? { payableFrom: parseLongDate(from[1]!)! } : {}),
    ...(recordTo && parseLongDate(recordTo[1]!) ? { recordTo: parseLongDate(recordTo[1]!)! } : {}),
    ...(assumes ? { assumesYears: Number(assumes[1]) } : {}),
    ...(years ? { qualifyingYears: Number(years[1]), yearsNeeded: Number(years[2]) } : {}),
    ...(/is the most you can get/i.test(text) ? { maximum: true } : {}),
  };
  return extraction({ documentDate: asOf, hmrc: [record], notes: [`Your State Pension forecast on ${formatDate(asOf)}: £${forecast[1]} a week (£${forecast[3]} a year)${from ? `, from ${from[1]}` : ''}.`] });
}

/** "Check your State Pension": your National Insurance record, year by year. */
function niRecord(page: PageText): Extraction | null {
  const all = lines(page.raw);
  if (!all.some((l) => /^Your National Insurance$/i.test(l) || /Your National Insurance record/i.test(l))) return null;
  const asOf = printedOn(page.raw) ?? printedOn(page.layout);
  if (!asOf) return null;
  const hmrc: ExtractedHmrc[] = [];
  let current: { start: number; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const text = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const status = /^Full year/i.test(text) ? 'full' : /^Year is not full/i.test(text) ? 'not-full' : /not available yet/i.test(text) ? 'not-available' : 'other';
    const contributions = [...text.matchAll(/(Paid employment|Self-employment|National Insurance credits|Voluntary contributions?|Class \d[^:]*):\s*£([\d,]+(?:\.\d{2})?)/gi)].map((m) => ({ kind: m[1]!, amount: parseMoney(m[2]!)! }));
    const voluntary = /Pay a voluntary contribution of £([\d,]+(?:\.\d{2})?) by (\d{1,2} [A-Za-z]+ \d{4})/i.exec(text);
    hmrc.push({
      type: 'ni-year',
      asOf,
      taxYear: yearLabel(current.start),
      status,
      contributions,
      ...(voluntary ? { voluntaryCost: parseMoney(voluntary[1]!)!, ...(parseLongDate(voluntary[2]!) ? { payBy: parseLongDate(voluntary[2]!)! } : {}) } : {}),
      text: text.slice(0, 500),
    });
    current = null;
  };
  for (const line of all) {
    const year = /^(\d{4}) to (\d{4})\s*(.*)$/.exec(line);
    if (year && Number(year[2]) === Number(year[1]) + 1) {
      close();
      current = { start: Number(year[1]), lines: year[3] ? [year[3]] : [] };
      continue;
    }
    if (current) {
      if (/^(Print|View payable gaps|Check your State Pension|Show your National Insurance)/i.test(line) || /^\d{2}\/\d{2}\/\d{4},/.test(line)) {
        close();
        continue;
      }
      current.lines.push(line);
    }
  }
  close();
  if (!hmrc.length) return null;
  return extraction({ documentDate: asOf, hmrc, notes: [`Your National Insurance record on ${formatDate(asOf)}: ${hmrc.length} tax year${hmrc.length === 1 ? '' : 's'}.`] });
}

const READERS = [taxableIncomeFromEmployer, yearTaxableIncome, employmentDetails, payeActivity, taxYouPaid, statePensionSummary, niRecord];

/** Read a gov.uk page from HMRC's services, or null when it is not one this knows. */
export function readGovUkPage(page: PageText): Extraction | null {
  if (!/GOV\.UK|tax\.service\.gov\.uk|account\.hmrc\.gov\.uk|HM Revenue & Customs/i.test(`${page.raw}\n${page.layout}`)) return null;
  for (const read of READERS) {
    const e = read(page);
    if (e) return e;
  }
  return null;
}
