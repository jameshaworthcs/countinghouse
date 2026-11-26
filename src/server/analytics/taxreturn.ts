// A tax year's Self Assessment return, box by box (docs/FORMULAS.md §20): what the records give for
// each box on the year's forms, what you told the app (returns.json), and the liability worked out
// from the boxes as HMRC works it out (shared/taxcalc.ts), with what is still to pay and when.
//
// Each box says where its figure came from (the records, your entry, a nil you confirmed) or that it
// is missing, so a gap is never shown as a zero. The calculation reads the boxes as entered on the
// return (whole pounds where the form takes them), so the liability is the return's, not a second
// estimate beside it.

import { movesDirectorLoan } from '../../shared/company';
import type { ReturnBoxView, ReturnCheck, ReturnPageView, ReturnQuestion, ReturnTrace, TaxReturnView } from '../../shared/api';
import { formatDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import { saFormsFor, type SaBoxDef, type SaFormSet } from '../../shared/saforms';
import type { Figure, ReturnEntry, Transaction } from '../../shared/schema';
import { computeTax, planLabel, type ForeignSource, type StudentLoanPlan, type TaxCalcInput } from '../../shared/taxcalc';
import { codingOutLimit, parseTaxYear, saDeadlines, taxYear as makeTaxYear, taxYearParams, type TaxYear } from '../../shared/uk';
import type { Store } from '../store';
import { allowances, giftAid, pensionTotals, reliefAtSource } from './allowances';
import type { BalanceEngine } from './balances';
import { payerKey } from './sources';
import { employerYears, type EmployerYear, type PaySource } from './sources';
import { ownerStatusOf } from './selfassessment';

type Value = number | string | boolean | null;

const inYear = (d: string | undefined, ty: TaxYear) => Boolean(d && d >= ty.start && d <= ty.end);
/** Pence down (or up) to whole pounds, still in pence: HMRC's £down and £up. */
const floorPounds = (pence: number) => Math.floor(pence / 100 + 1e-9) * 100;
const ceilPounds = (pence: number) => Math.ceil(pence / 100 - 1e-9) * 100;
const pounds = (n: number, round: SaBoxDef['round']) => (round === 'pence' ? fromMinor(toMinor(n)) : round === 'up' ? Math.ceil(fromMinor(toMinor(n)) - 1e-9) : Math.floor(fromMinor(toMinor(n)) + 1e-9));

/** ISIN country prefixes and the three-letter codes the Foreign pages use. */
/** The highest share of a dividend most tax treaties let you credit (HMRC DT manuals: the US and Canada, 15%). */
const TREATY_DIVIDEND_RATE = 0.15;

const COUNTRY: Record<string, string> = { US: 'USA', CA: 'CAN', IE: 'IRL', CH: 'CHE', NL: 'NLD', DE: 'DEU', FR: 'FRA', JP: 'JPN', AU: 'AUS', LU: 'LUX', KY: 'CYM', BM: 'BMU', JE: 'JEY', GG: 'GGY', IM: 'IMN', AN: 'CUW', DK: 'DNK', SE: 'SWE', NO: 'NOR', ES: 'ESP', IT: 'ITA', BE: 'BEL', FI: 'FIN', HK: 'HKG', SG: 'SGP', TW: 'TWN', KR: 'KOR', CN: 'CHN', IN: 'IND', BR: 'BRA', IL: 'ISR', MX: 'MEX', ZA: 'ZAF' };

/** The keys of the questions, and what each needs. */
const Q = {
  employment: 'q:employment',
  selfEmployment: 'q:self-employment',
  partnership: 'q:partnership',
  property: 'q:property',
  trusts: 'q:trusts',
  residence: 'q:residence',
  foreignOther: 'q:foreign-other',
  lessCommon: 'q:less-common',
  allJobs: 'q:all-jobs',
  additional: 'q:additional',
  pensionsBenefits: 'q:pensions-benefits',
  otherIncome: 'q:other-income',
  otherDirectorships: 'q:other-directorships',
  benefitsExpenses: 'q:benefits-expenses',
  giftAid: 'q:gift-aid',
  childBenefit: 'q:child-benefit',
  marriage: 'q:marriage-allowance',
  studentLoan: 'q:student-loan',
  postgraduate: 'q:postgraduate-loan',
  inCode: 'q:underpaid-in-code',
  refunded: 'q:refunded',
  capitalGains: 'q:capital-gains',
} as const;

/** One question's possible answers (yes/no unless listed). */
const CHOICES: Partial<Record<string, { value: string; label: string }[]>> = {
  [Q.marriage]: [
    { value: 'none', label: 'Neither' },
    { value: 'transferring', label: 'I transfer it to my spouse or civil partner' },
    { value: 'receiving', label: 'My spouse or civil partner transfers it to me' },
  ],
  [Q.studentLoan]: [
    { value: 'none', label: 'No student loan' },
    { value: 'not-started', label: 'A loan, but repayments were not due before 6 April (still studying, or Plan 5)' },
    { value: 'plan1', label: 'Plan 1, repayments due' },
    { value: 'plan2', label: 'Plan 2, repayments due' },
    { value: 'plan4', label: 'Plan 4, repayments due' },
    { value: 'plan5', label: 'Plan 5, repayments due (from April 2026)' },
  ],
};

interface BoxOpts {
  /** The figure from the records (undefined: the records say nothing; null: they show none for certain). */
  records?: Value | undefined;
  /** Where the records' figure came from. */
  trace?: ReturnTrace[];
  basis?: string;
  notes?: string[];
  /** Your entry may set it. */
  editable?: boolean;
  /** Needed for the return: unknown is a gap that stops it being ready. */
  required?: boolean;
  /** The records' figure needs checking (a figure so far, days not covered). */
  check?: string | undefined;
  /** Shown even when blank (a Yes/No the form says you must answer). */
  always?: boolean;
  /** What a nil means here: not allowed (a figure or answer is needed), "None" written in, or 0 entered. */
  nil?: 'refused' | 'none' | 'zero';
}

/**
 * The year's return. `entriesOverride` stands in for what returns.json holds (a proposal checking its
 * answers as the ones before it leave the return).
 */
export function taxReturn(store: Store, label?: string, engine?: BalanceEngine, now: ISODate = today(), entriesOverride?: Record<string, ReturnEntry>): TaxReturnView | null {
  const ty = (label ? parseTaxYear(label) : null) ?? makeTaxYear(Number(now.slice(0, 4)) - 1);
  const found = saFormsFor(ty.label);
  if (!found) return null;
  const forms = found.forms;
  const params = taxYearParams(ty);
  const entries = entriesOverride ?? store.taxReturn(ty.label)?.entries ?? {};
  const entry = (key: string): ReturnEntry | undefined => entries[key];
  const answer = (key: string): Value | undefined => entry(key)?.value;
  const allow = allowances(store, ty.label, now, engine);
  const finished = ty.end < now;

  const pages: ReturnPageView[] = [];
  const questions: ReturnQuestion[] = [];
  const blockers: TaxReturnView['readiness']['blockers'] = [];
  const checks: ReturnCheck[] = [];

  // ─── Questions ──────────────────────────────────────────────────────────────────────────────
  const ask = (key: string, text: string, opts: { help?: string; inferred?: { answer: Value; why: string }; coverage: ReturnQuestion['coverage']; notCovered?: string }) => {
    const e = entry(key);
    const choices = CHOICES[key];
    const q: ReturnQuestion = {
      key,
      text,
      ...(opts.help ? { help: opts.help } : {}),
      ...(choices ? { choices } : {}),
      answer: e ? e.value : opts.inferred ? opts.inferred.answer : null,
      state: e ? 'answered' : opts.inferred ? 'inferred' : 'unanswered',
      ...(opts.inferred ? { inferred: opts.inferred } : {}),
      ...(e?.note ? { note: e.note } : {}),
      coverage: opts.coverage,
      ...(opts.notCovered ? { notCovered: opts.notCovered } : {}),
    };
    questions.push(q);
    const yes = q.answer === true;
    if (q.state === 'unanswered') blockers.push({ key, kind: 'question', text: `Answer: ${text}` });
    else if (yes && opts.coverage === 'not-covered') blockers.push({ key, kind: 'not-covered', text: opts.notCovered ?? `${text}: Counting House does not prepare this part of the return.` });
    return q.answer;
  };
  const isYes = (v: Value | undefined) => v === true;

  // ─── Employment (SA102), one page per job ──────────────────────────────────────────────────
  const jobs = employerYears(store, ty).filter((e) => e.chosen.gross_pay || e.chosen.tax_deducted);
  ask(Q.employment, 'Were you an employee, director, office holder or agency worker in the year?', {
    coverage: 'covered',
    ...(jobs.length ? { inferred: { answer: true, why: `${jobs.length} ${jobs.length === 1 ? 'job has' : 'jobs have'} pay in your records for the year` } } : {}),
  });
  const employedQ = questions.at(-1)!.answer;
  if (employedQ === true && !jobs.length) blockers.push({ key: Q.employment, kind: 'missing', text: 'Employment: no job with pay in your records for the year. Add each job’s P60 figures (Settings → Tax documents) and its page appears' });
  if (jobs.length)
    ask(Q.allJobs, `Are these all your jobs and PAYE pensions for the year: ${jobs.map((j) => j.payer || 'an employer').join(', ')}?`, {
      coverage: 'covered',
      help: 'Each job needs its own Employment page. A job missing here needs its figures (its P60 or P45) in Settings → Tax documents, or uploaded on the Import page.',
    });
  if (questions.find((q) => q.key === Q.allJobs)?.answer === false) blockers.push({ key: Q.allJobs, kind: 'missing', text: 'A job missing from the return: add its P60 or P45 figures (Settings → Tax documents)' });
  ask(Q.otherDirectorships, 'Were you a director of any company that is not one of the jobs below (one that paid you nothing, or a dormant one)?', {
    help: 'Each directorship needs its own Employment page, even with no pay.',
    coverage: 'not-covered',
    notCovered: 'A directorship with no pay needs its own Employment page (SA102): add it on the return yourself, with the director and close company boxes.',
  });
  const benefitsQ = ask(Q.benefitsExpenses, 'Did you have taxable benefits from a job that were not payrolled (a P11D), tips not on a P60, or work expenses your employer did not repay?', {
    coverage: 'figures',
    help: 'For example a company car or private medical insurance on a P11D, professional subscriptions, or business mileage in your own car. The boxes for each job open for you to fill in.',
    ...(store.figures.some((f) => f.kind === 'benefit_in_kind' && inYear(f.periodEnd ?? f.date, ty)) || store.figures.some((f) => f.kind === 'benefit_in_kind' && f.taxYear === ty.label) ? { inferred: { answer: true, why: 'Your records have benefits in kind for the year' } } : {}),
  });

  const companies = store.companies;
  const dividendLines = allow.dividends.lines;
  const sa102Inputs: { key: string; pay: number; income: number; slEarned: number; tax: number; studentLoan: number }[] = [];
  for (const job of jobs) {
    const slug = job.key.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    const base = `SA102:${slug}`;
    const page = newPage(forms, 'SA102', job.payer || 'An employer', base);
    const p = job.chosen.gross_pay;
    const t = job.chosen.tax_deducted;
    const sl = job.chosen.student_loan_deducted;
    const company = companies.find((c) => (job.employmentId && c.employmentId === job.employmentId) || payerKey(c.name) === payerKey(job.payer));
    const so = (s: PaySource | undefined) => (s && !s.final ? `${describe(s)}: not the whole year yet. Its P60 (or a P45 for a job you left) gives the figure to enter.` : undefined);
    const pay = box(page, '1', {
      records: p ? p.amount : undefined,
      trace: p ? sourceTrace(p, 'pay') : [],
      basis: p ? describe(p) : 'No pay figure for this job',
      required: true,
      editable: true,
      nil: 'refused',
      check: so(p),
    });
    const tax = box(page, '2', {
      records: t ? t.amount : undefined,
      trace: t ? sourceTrace(t, 'tax') : [],
      basis: t ? describe(t) : 'Not in your records: its P60, P45, or HMRC’s page for the job (Check your Income Tax) gives it. If no tax was taken off, say None',
      required: true,
      editable: true,
      check: so(t),
    });
    const tips = isYes(benefitsQ) ? box(page, '3', { editable: true }) : null;
    box(page, '4', { records: job.payeReference ?? (store.employment(job.employmentId)?.payeReference ?? undefined), basis: job.payeReference ? 'From the job’s records' : 'Not in your records: on its P60 or P45 (“None” if it has none)', editable: true, required: true, nil: 'none' });
    box(page, '5', { records: job.payer, basis: 'The employer’s name in your records', editable: true });
    const director = box(page, '6', { editable: true, required: true, always: true, nil: 'refused', basis: 'Only you know: answer Yes or No (the form says you must)' });
    if (director === true) {
      box(page, '6.1', { editable: true, basis: 'Only if you stopped being a director before 6 April' });
      const close = box(page, '7', { editable: true, required: true, always: true, nil: 'refused', basis: 'A UK company controlled by its directors, or by five or fewer shareholders (CTA 2010 s.439): HMRC’s notes say what counts' });
      if (close === true) {
        box(page, '7.1', { records: company?.name ?? job.payer, basis: company ? 'The company in your records: its full name' : 'The employer’s name in your records: its full name', editable: true, required: true, nil: 'refused' });
        box(page, '7.2', { records: company?.number, basis: company?.number ? 'Its Companies House number in your records' : 'Not in your records: its Companies House number', editable: true, required: true, nil: 'refused' });
        // Dividends from it: the year's dividends whose payer is this company (they are also in TR 3 box 4).
        const names = new Set([payerKey(job.payer), ...(company ? [payerKey(company.name)] : []), ...job.names.map(payerKey)]);
        const from = dividendLines.filter((l) => names.has(payerKey(l.label.replace(/\s*\(.*$/, ''))));
        const sum = from.reduce((s, l) => s + toMinor(l.amount), 0);
        box(page, '7.3', {
          records: from.length ? fromMinor(sum) : undefined,
          trace: from.map((l) => ({ label: l.label, amount: l.amount, ...(l.date ? { date: l.date } : {}) })),
          basis: from.length ? 'Its dividends in your records (also in TR 3 box 4)' : 'No dividends from it in your records: say None if it paid you none (the form takes 0); one you received goes in TR 3 box 4 too',
          editable: true,
          required: true,
          nil: 'zero',
        });
        const holding = company?.holdings.length ? company.holdings.reduce((best, h) => (h.totalShares ? Math.max(best, (h.shares / h.totalShares) * 100) : best), 0) : undefined;
        box(page, '7.4', {
          records: holding ? Math.round(holding * 100) / 100 : undefined,
          basis: holding ? 'Your shares as a share of all its shares, from your records: the form wants it by nominal value, at its highest in the year (check if its classes differ in value)' : 'Not in your records: the highest percentage of its share capital you held in the year, by nominal value',
          check: holding && company!.holdings.some((h) => !h.totalShares) ? 'Some holdings do not say how many shares the company has' : undefined,
          editable: true,
          required: true,
          nil: 'zero',
        });
      }
    }
    box(page, '8', { editable: true, basis: 'Only for work inside the off-payroll rules (IR35)' });
    // Benefits and expenses: your figures, or benefits in kind figures under the job.
    let benefits = 0;
    let expenses = 0;
    let slBenefits = 0;
    let payrolled = 0;
    if (isYes(benefitsQ)) {
      const bik = store.figures.filter((f) => f.kind === 'benefit_in_kind' && (f.taxYear === ty.label || inYear(f.periodEnd ?? f.date, ty)) && ((job.employmentId && f.employmentId === job.employmentId) || payerKey(f.payer) === payerKey(job.payer)));
      payrolled = toMinor(num(box(page, '1.1', { editable: true, basis: 'Only payrolled cars, vans, fuel, medical insurance and goods (already in box 1): they do not count towards student loan repayments' })));
      for (const b of ['9', '10', '11', '12', '13', '14', '15', '16']) {
        const v = box(page, b, b === '15' && bik.length ? { records: fromMinor(bik.reduce((s, f) => s + toMinor(f.amount), 0)), trace: figureTrace(bik), basis: 'Benefits in kind in your records: put each in the box its P11D section gives', editable: true, check: 'Split it across the boxes as the P11D does' } : { editable: true });
        if (typeof v === 'number') {
          benefits += toMinor(v);
          if (b === '12' || b === '16') slBenefits += toMinor(v);
        }
      }
      for (const b of ['17', '18', '19', '20']) {
        const v = box(page, b, { editable: true });
        if (typeof v === 'number') expenses += toMinor(v);
      }
    }
    const payV = typeof pay === 'number' ? pay : 0;
    const tipsV = typeof tips === 'number' ? tips : 0;
    // HMRC's grouping (c1.1, c1.5, c1.5a–c): pay and tips down to the pound, benefits down, expenses
    // up, and expenses no more than the job's pay and benefits. The student loan's own (c27.1a–c):
    // pay, tips, boxes 12 and 16, less payrolled benefits, down; expenses up.
    const payGroup = floorPounds(toMinor(payV) + toMinor(tipsV));
    const benefitGroup = floorPounds(benefits);
    const expenseGroup = ceilPounds(expenses);
    const income = payGroup + benefitGroup - Math.min(floorPounds(toMinor(payV) + toMinor(tipsV) + benefits), expenseGroup);
    const slEarned = floorPounds(toMinor(payV) + toMinor(tipsV) + slBenefits - payrolled) - expenseGroup;
    sa102Inputs.push({ key: base, income: fromMinor(income), slEarned: fromMinor(slEarned), tax: typeof tax === 'number' ? tax : 0, studentLoan: sl ? sl.amount : 0, pay: payV });
    pages.push(page);
  }

  // ─── Interest and dividends (TR 3) ───────────────────────────────────────────────────────────
  const tr3 = newPage(forms, 'TR3');
  // Interest: outside ISAs and pensions, from the same working as Tax → Allowances.
  const interestTrace: ReturnTrace[] = allow.savings.lines.map((l) => ({ label: l.label, amount: l.amount, ...(l.date ? { date: l.date } : {}), ...(l.accountId ? { ref: { type: 'account' as const, id: l.accountId } } : {}) }));
  const interestNotes: string[] = [];
  let interestCheck: string | undefined;
  const missing = allow.savings.missing;
  if (missing.length) {
    const byAccount = new Map<string, string[]>();
    for (const mm of missing) (byAccount.get(mm.name) ?? byAccount.set(mm.name, []).get(mm.name)!).push(mm.noData ? 'no data for the year' : `${formatDate(mm.from)} – ${formatDate(mm.to)}`);
    interestCheck = `Interest may be missing: ${[...byAccount].map(([n, d]) => `${n} (${d.join(', ')})`).join('; ')}. The bank’s annual interest statement is the reliable figure.`;
  }
  for (const c of allow.savings.confirmedNil) interestNotes.push(`${c.name}: ${formatDate(c.from)} – ${formatDate(c.to)} counted as no interest on your confirmation${c.note ? ` (“${c.note}”)` : ''}.`);
  box(tr3, '1', { editable: true, basis: 'Interest paid after tax was taken off (the net amount): rare now, most is paid gross. Interest you put here must come out of box 2' });
  const untaxed = box(tr3, '2', {
    records: allow.savings.interest > 0 ? allow.savings.interest : allow.savings.lines.length || !missing.length ? 0 : undefined,
    trace: interestTrace,
    basis: 'Interest outside ISAs and pensions: from your transactions and interest statements, as on Tax → Allowances',
    notes: interestNotes,
    editable: true,
    check: interestCheck,
  });
  box(tr3, '3', { editable: true, basis: 'Interest from abroad with no tax taken off (up to £2,000): none found in your records' });

  // Dividends: UK companies (box 4); on a trading platform, each dividend by its ISIN: UK ones in
  // box 4, foreign ones on the Foreign page with the tax taken off them.
  const foreign = foreignDividends(store, ty, dividendLines);
  const ukTrace: ReturnTrace[] = [];
  let ukMinor = 0;
  for (const l of dividendLines) {
    const split = foreign.byAccount.get(l.accountId ?? '');
    if (split) {
      if (split.ukMinor) {
        ukMinor += split.ukMinor;
        ukTrace.push({ label: `${l.label}: dividends on UK shares (GB ISINs)`, amount: fromMinor(split.ukMinor) });
      }
      continue;
    }
    ukMinor += toMinor(l.amount);
    ukTrace.push({ label: l.label, amount: l.amount, ...(l.date ? { date: l.date } : {}), ...(l.accountId ? { ref: { type: 'account' as const, id: l.accountId } } : {}) });
  }
  const ukDiv = box(tr3, '4', {
    records: dividendLines.length ? fromMinor(ukMinor) : 0,
    trace: ukTrace,
    basis: 'Dividends outside ISAs and pensions: vouchers, and the UK part of a platform’s dividends',
    notes: ['Dividends from a close company you are a director of go here too, and again in that job’s box 7.3.'],
    editable: true,
    check: foreign.unsplit.length ? `${foreign.unsplit.join('; ')}: if any of it was paid by companies abroad, it belongs on the Foreign page instead` : undefined,
  });
  box(tr3, '5', { editable: true, basis: 'Distributions from unit trusts, OEICs and investment trusts held outside ISAs: none found in your records' });

  // Pensions, benefits and other income: figures you give, when you say you had them.
  const pensionsQ = ask(Q.pensionsBenefits, 'Did you get a State Pension, a private pension or annuity, or taxable state benefits (Jobseeker’s Allowance, contribution-based ESA, Carer’s Allowance) in the year?', { coverage: 'figures' });
  const otherQ = ask(Q.otherIncome, 'Did you have other UK income not on any other page, such as casual earnings or commission, that was not taxed through PAYE?', { coverage: 'figures', help: 'Not self-employment (that has its own question), and not income from abroad.' });
  const tr3Values: Record<string, number> = {};
  if (isYes(pensionsQ)) {
    for (const b of ['8', '11', '12', '13', '14', '15', '16']) tr3Values[b] = num(box(tr3, b, { editable: true }));
    if (!['8', '11', '13', '15', '16'].some((b) => entry(`TR3:${b}`))) blockers.push({ key: 'TR3:8', kind: 'missing', text: 'SA100 TR 3: the pensions or benefits you said you had (boxes 8 to 16)' });
  }
  if (isYes(otherQ)) {
    for (const b of ['17', '18', '19']) tr3Values[b] = num(box(tr3, b, { editable: true, ...(b === '17' ? { required: true, nil: 'refused' as const } : {}) }));
    box(tr3, '21', { editable: true, required: true, nil: 'refused' });
  }
  pages.push(tr3);

  // ─── Foreign (SA106): foreign dividends, with Foreign Tax Credit Relief ─────────────────────
  // TR 3 box 6 takes foreign dividends only up to £500, with total dividends within £500 (SA150).
  const smallLimit = 500;
  const totalDividends = fromMinor(toMinor(num(ukDiv)) + toMinor(num(answer('TR3:5') ?? null)) + foreign.grossMinor);
  const foreignOnTr3 = foreign.grossMinor > 0 && totalDividends <= smallLimit;
  let foreignPage: ReturnPageView | null = null;
  let tr3Foreign = 0;
  const foreignSources: ForeignSource[] = [];
  let foreignTaxable = 0;
  if (foreign.grossMinor > 0) {
    if (foreignOnTr3) {
      tr3Foreign = num(box(tr3, '6', { records: fromMinor(foreign.grossMinor - foreign.taxMinor), trace: foreign.trace, basis: 'Foreign dividends after the foreign tax (deduction relief): all your dividends are within £500, so no Foreign page is needed', editable: true }));
      box(tr3, '7', { records: fromMinor(foreign.taxMinor), trace: foreign.taxTrace, basis: 'The foreign tax taken off them: for HMRC’s information, not a credit', editable: true });
    } else {
      foreignPage = newPage(forms, 'SA106', undefined, 'SA106');
      const add = (b: ReturnBoxView) => {
        foreignPage!.boxes.push(b);
        return b.value;
      };
      let totalF = 0;
      for (const row of foreign.rows) {
        const rb = `SA106:${row.country}`;
        add(makeBox(forms, 'SA106', 'A', `${rb}:A`, entries, { records: row.country, basis: `From the ISINs of the shares that paid them (${row.isins.slice(0, 3).join(', ')}${row.isins.length > 3 ? '…' : ''}): the country of the company, which an ISIN usually but not always gives`, editable: true, nil: 'refused' }));
        const b = num(add(makeBox(forms, 'SA106', 'B', `${rb}:B`, entries, { records: fromMinor(row.grossMinor), trace: row.trace, basis: 'Dividends before foreign tax: what was paid in plus the tax taken off', editable: true, nil: 'refused' })));
        const cGross = fromMinor(row.taxMinor);
        // A treaty usually allows a credit of at most 15% of a dividend; any more is reclaimed from that country.
        const c = num(add(makeBox(forms, 'SA106', 'C', `${rb}:C`, entries, { records: cGross || null, basis: 'The tax taken off, in pounds at each payment’s exchange rate: at most what the tax treaty allows', editable: true, check: b > 0 && cGross > b * TREATY_DIVIDEND_RATE + 0.01 ? `More than ${TREATY_DIVIDEND_RATE * 100}% of the dividends: usually only ${TREATY_DIVIDEND_RATE * 100}% can be credited under the treaty` : undefined })));
        const claim = add(makeBox(forms, 'SA106', 'E', `${rb}:E`, entries, { records: c > 0 ? true : null, basis: c > 0 ? 'Claim the relief: it takes the foreign tax off the UK tax on these dividends' : 'No foreign tax, so no relief to claim', editable: true }));
        const f = claim === true ? b : Math.max(0, b - c);
        add(makeBox(forms, 'SA106', 'F', `${rb}:F`, {}, { records: f, basis: claim === true ? 'Claiming the relief: the same as column B' : 'Column B less column C' }));
        totalF += toMinor(f);
        if (claim === true && c > 0) foreignSources.push({ label: row.country, amount: b, taxTaken: c });
      }
      add(makeBox(forms, 'SA106', '6', 'SA106:6', {}, { records: fromMinor(totalF), basis: 'The total of column F' }));
      foreignTaxable = fromMinor(totalF);
      if (foreign.note) foreignPage.boxes[0]!.notes.push(foreign.note);
    }
  }
  // ─── Reliefs (TR 4) ──────────────────────────────────────────────────────────────────────────
  const tr4 = newPage(forms, 'TR4');
  const pen = pensionTotals(store, ty);
  const ras = reliefAtSource(store, ty, pen);
  const rasBox = box(tr4, '1', {
    records: ras.personalGross > 0 ? ras.personalGross : ras.accounts.length ? 0 : null,
    trace: ras.accounts.map((a) => ({ label: a.name, ref: { type: 'account' as const, id: a.id } })),
    basis: ras.accounts.length ? 'What you paid into personal pensions yourself, plus the 20% the provider claimed: not what an employer paid' : 'No personal pension you pay into yourself in your records',
    notes: ras.accounts.length ? ['Contributions from your employer, or taken from pay before tax, do not go here.'] : [],
    editable: true,
  });
  const gift = giftAid(store, ty);
  const untagged = gift.charity.length - gift.aided.length;
  const giftQ = ask(Q.giftAid, 'Did you make Gift Aid donations in the year (or want to treat some made after 5 April as made in it)?', {
    coverage: 'figures',
    ...(gift.paid > 0 ? { inferred: { answer: true, why: 'Donations in your records are tagged “gift-aid”' } } : {}),
    help: untagged > 0 ? `${untagged === 1 ? 'One charity payment in your records is' : `${untagged} charity payments in your records are`} not tagged “gift-aid”: only donations you made a Gift Aid declaration for count.` : 'Only donations you made a Gift Aid declaration for count.',
  });
  let giftNet = 0;
  if (isYes(giftQ)) {
    giftNet = num(box(tr4, '5', { records: gift.paid > 0 ? gift.paid : undefined, trace: [...gift.aided.map((t) => txTrace(t, -t.amount)), ...figureTrace(gift.figures)], basis: gift.paid > 0 ? 'Donations tagged “gift-aid”, and Gift Aid figures from documents' : 'Enter what you gave under Gift Aid (what you paid, not the charity’s extra)', editable: true, required: true, nil: 'refused', check: gift.aided.length && gift.figures.length ? 'Both tagged donations and a document’s figures: check none is counted twice' : undefined }));
    box(tr4, '6', { editable: true, basis: 'One-off donations you do not expect to repeat' });
    const back = num(box(tr4, '7', { editable: true, basis: 'Part of box 5 you want treated as given in the year before (only by the time you send that year’s return)' }));
    giftNet = giftNet - Math.min(back, giftNet) + num(box(tr4, '8', { editable: true }));
  }
  pages.push(tr4);

  // ─── Student loans, Child Benefit, Marriage Allowance (TR 5) ───────────────────────────────
  const tr5 = newPage(forms, 'TR5');
  const hasLoanAccount = store.accounts.some((a) => a.type === 'student_loan');
  const slDeducted = sa102Inputs.reduce((s, j) => s + toMinor(j.studentLoan), 0);
  const slQ = ask(Q.studentLoan, 'Had Student Loans Company told you your repayments were due before 6 April? Which plan?', {
    coverage: 'covered',
    ...(!hasLoanAccount && slDeducted === 0 ? { inferred: { answer: 'none', why: 'No student loan in your records' } } : {}),
    help: `${slDeducted > 0 ? `Your employers took ${formatMoney(fromMinor(slDeducted))} of student loan repayments off your pay, so repayments were due: choose your plan. ` : ''}${params.studentLoan?.plan5 === null ? `Plan 5 loans (courses from August 2023) have no repayments due for ${ty.label}.` : ''}`,
  });
  const plans: StudentLoanPlan[] = typeof slQ === 'string' && /^plan[1245]$/.test(slQ) && !(slQ === 'plan5' && params.studentLoan?.plan5 === null) ? [slQ as StudentLoanPlan] : [];
  const pgQ = ask(Q.postgraduate, 'Did you have a Postgraduate Loan with repayments due before 6 April?', { coverage: 'covered', ...(!hasLoanAccount ? { inferred: { answer: false, why: 'No student loan in your records' } } : {}) });
  if (isYes(pgQ)) plans.push('postgraduate');
  box(tr5, 'SL1', { records: plans.length ? true : null, basis: plans.length ? `Repayments were due (${plans.map(planLabel).join(', ')})` : 'Leave blank: no repayments were due before 6 April' });
  const slBox = plans.some((x) => x !== 'postgraduate') || slDeducted > 0 ? num(box(tr5, 'SL2', { records: fromMinor(slDeducted), trace: jobs.flatMap((j) => (j.chosen.student_loan_deducted ? sourceTrace(j.chosen.student_loan_deducted, 'student loan') : [])), basis: 'Taken off your pay: from each job’s P60 or payslips', editable: true })) : 0;
  const pgBox = isYes(pgQ) ? num(box(tr5, 'SL3', { editable: true, required: true, basis: 'Postgraduate Loan repayments taken off your pay (P60)' })) : 0;

  const cbTx = store.transactions().filter((t) => inYear(t.date, ty) && t.amount > 0 && /CHILD BENEFIT/i.test(t.description));
  const cbFigures = store.figures.filter((f) => f.kind === 'child_benefit' && (f.taxYear === ty.label || inYear(f.periodEnd ?? f.date, ty)));
  const cbQ = ask(Q.childBenefit, 'Did you or a partner get Child Benefit in the year, with your income the higher of the two?', {
    coverage: 'covered',
    ...(cbTx.length || cbFigures.length ? { inferred: { answer: true, why: 'Child Benefit payments are in your records: say No if your partner’s income was higher' } } : {}),
    help: 'The charge applies only to the partner with the higher income, once it is over £60,000 (also when someone else claims for a child living with you and pays you for its upkeep).',
  });
  let childBenefit = 0;
  if (isYes(cbQ)) {
    // A document's figure for the year, else the payments: never both, which would count it twice.
    const recorded = cbFigures.length ? fromMinor(cbFigures.reduce((s, f) => s + toMinor(f.amount), 0)) : fromMinor(cbTx.reduce((s, t) => s + toMinor(t.amount), 0));
    childBenefit = num(box(tr5, 'CB1', { records: recorded || undefined, trace: cbFigures.length ? figureTrace(cbFigures) : cbTx.map((t) => txTrace(t, t.amount)), basis: 'Child Benefit for the weeks whose Monday falls in the year (7 April 2025 to 30 March 2026), yours and your partner’s', editable: true, required: true, nil: 'refused', check: recorded ? 'Payments in your records: check they are the year’s weeks, not arrears for an earlier year' : undefined }));
    box(tr5, 'CB2', { editable: true, required: true });
    box(tr5, 'CB3', { editable: true });
  }
  const maQ = ask(Q.marriage, 'Marriage Allowance: do you transfer part of your personal allowance to a spouse or civil partner, or do they transfer theirs to you?', { coverage: 'covered', inferred: { answer: 'none', why: 'Nothing in your records suggests it' } });
  if (maQ === 'transferring') box(tr5, 'MA1–5', { editable: true, required: true, basis: 'Their name, National Insurance number and date of birth, and the date you married: not kept here' });
  pages.push(tr5);

  // ─── Finishing (TR 6) and the tax code boxes (SA110) ───────────────────────────────────────
  const tr6 = newPage(forms, 'TR6');
  const refunds = finished ? hmrcRefunds(store, ty) : [];
  const refundQ = ask(Q.refunded, 'Did HMRC (or Jobcentre Plus) refund you any of this year’s income tax during the year, outside your pay?', {
    coverage: 'covered',
    help: [
      'For example a refund after you stopped work. A refund through your pay is already in your P60 figures, and a refund of an earlier year’s tax does not count.',
      ...(refunds.length ? [`From HMRC in the year: ${refunds.map((t) => `${formatMoney(t.amount)} on ${formatDate(t.date)}`).join(', ')}. HMRC pays refunds for the year before from June, so check what each was for.`] : []),
    ].join(' '),
  });
  const refunded = isYes(refundQ) ? num(box(tr6, '1', { editable: true, required: true, basis: 'Refunds of this year’s income tax HMRC paid you in the year', trace: refunds.map((t) => txTrace(t, t.amount)) })) : 0;
  const noCoding = box(tr6, '2', { editable: true, basis: 'Leave blank to let HMRC try to collect a bill under £3,000 through your tax code (when the return is sent online by 30 December and you have enough pay or pension through PAYE)' });
  box(tr6, '3', { editable: true, basis: 'Leave blank to let HMRC try to collect next year’s tax on savings, casual earnings or the Child Benefit charge through your tax code' });
  pages.push(tr6);

  const inCodeQ = ask(Q.inCode, 'Did your tax code for the year collect underpaid tax for an earlier year or a debt, or has HMRC put this year’s underpayment into next year’s code?', {
    coverage: 'covered',
    help: `Your P2 PAYE Coding Notices say so (“amount of underpaid tax for earlier years”, “estimated underpayment”). ${inCodeHint(store, ty)}`,
  });
  let earlier = 0;
  let debt = 0;
  let nextCode = 0;
  if (isYes(inCodeQ)) {
    const sa110 = newPage(forms, 'SA110');
    earlier = num(box(sa110, '7', { editable: true, basis: 'From the 2025–26 coding notice (P2): “amount of underpaid tax for earlier years”' }));
    nextCode = num(box(sa110, '8', { editable: true, basis: 'From the 2026–27 coding notice: “estimated underpayment for 2025–26”' }));
    debt = num(box(sa110, '9', { editable: true, basis: 'From the 2025–26 coding notice: an outstanding debt it collected' }));
    if (!['7', '8', '9'].some((b) => entry(`SA110:${b}`))) blockers.push({ key: 'SA110:7', kind: 'missing', text: 'SA110 boxes 7 to 9: the amounts your coding notices give' });
    pages.push(sa110);
  }

  // ─── Capital gains (SA108) ───────────────────────────────────────────────────────────────────
  const gainsFig = store.figures.filter((f) => (f.kind === 'capital_gain' || f.kind === 'capital_loss') && (f.taxYear === ty.label || (f.periodStart === ty.start && f.periodEnd === ty.end) || (!f.taxYear && inYear(f.periodEnd ?? f.date, ty))));
  const gainsRec = fromMinor(gainsFig.filter((f) => f.kind === 'capital_gain').reduce((s, f) => s + toMinor(f.amount), 0));
  const lossesRec = fromMinor(gainsFig.filter((f) => f.kind === 'capital_loss').reduce((s, f) => s + toMinor(Math.abs(f.amount)), 0));
  const sales = store.accounts.filter((a) => a.type === 'gia' || a.type === 'crypto').flatMap((a) => store.transactions(a.id).filter((t) => inYear(t.date, ty) && t.category === 'trade' && t.amount > 0));
  const crypto = sales.some((t) => store.account(t.accountId)?.type === 'crypto');
  const proceeds = fromMinor(sales.reduce((s, t) => s + toMinor(t.amount), 0));
  const disposals = new Set(sales.map((t) => `${t.date}|${t.description.replace(/^.*·\s*/, '')}`)).size;
  const reportProceeds = params.cgtReportingProceeds ?? params.cgtAnnualExemptAmount * 4;
  // Gains not in the records for sales that are: unknown, never a nil.
  const gainsUnknown = sales.length > 0 && !gainsFig.length;
  const mustReport = gainsRec > params.cgtAnnualExemptAmount || proceeds > reportProceeds || (lossesRec > gainsRec && lossesRec > 0);
  if (gainsUnknown && !entry('SA108:26')) blockers.push({ key: 'q:capital-gains', kind: 'missing', text: `The gains or losses on ${formatMoney(proceeds)} of sales: not in your records (a platform’s realised gains report gives them)` });
  const cgQ = ask(Q.capitalGains, 'Did you sell or give away shares, funds, crypto or other assets outside ISAs and pensions (apart from those in your records)?', {
    coverage: 'figures',
    help: `Your records show ${sales.length ? `${disposals} disposals worth ${formatMoney(proceeds)}` : 'no disposals'}. The Capital Gains page is needed when proceeds are over ${formatMoney(reportProceeds, { decimals: 0 })}, gains are over ${formatMoney(params.cgtAnnualExemptAmount, { decimals: 0 })}, or you want to claim a loss.`,
    inferred: { answer: false, why: sales.length ? 'Only the disposals already in your records' : 'None in your records' },
  });
  let gains: TaxCalcInput['gains'] | undefined;
  const cgNeeded = mustReport || isYes(cgQ);
  if (gainsFig.length || isYes(cgQ)) {
    gains = { gains: fromMinor(floorPounds(toMinor(gainsRec))), losses: fromMinor(ceilPounds(toMinor(lossesRec))) };
    if (cgNeeded) {
      const sa108 = newPage(forms, 'SA108');
      box(sa108, '23', { records: sales.length ? disposals : undefined, basis: 'Sales on different days, or of different shares, count separately', editable: true, required: true });
      box(sa108, '24', { records: sales.length ? proceeds : undefined, trace: sales.slice(0, 50).map((t) => txTrace(t, t.amount)), basis: 'What the sales raised', editable: true, required: true });
      const g = num(box(sa108, '26', { records: gainsFig.length ? gainsRec : undefined, trace: figureTrace(gainsFig.filter((f) => f.kind === 'capital_gain')), basis: 'The platform’s realised gains for the year', editable: true, required: true, check: 'A platform works out gains on its own account only: shares of the same company held elsewhere, and the 30-day rule, change them' }));
      const l = num(box(sa108, '27', { records: gainsFig.length ? lossesRec : undefined, trace: figureTrace(gainsFig.filter((f) => f.kind === 'capital_loss')), basis: 'The platform’s realised losses for the year', editable: true, required: true }));
      box(sa108, '25', { records: sales.length && gainsFig.length ? fromMinor(toMinor(proceeds) - toMinor(gainsRec) + toMinor(lossesRec)) : undefined, basis: 'Proceeds less gains plus losses', editable: true, required: true });
      const bf = num(box(sa108, '45', { editable: true, basis: 'Losses from earlier years you reported that this year uses: only down to the annual exempt amount (the working below says how much can be)' }));
      gains = { gains: fromMinor(floorPounds(toMinor(g))), losses: fromMinor(ceilPounds(toMinor(l))), broughtForward: fromMinor(ceilPounds(toMinor(bf))) };
      pages.push(sa108);
      blockers.push({ key: 'SA108', kind: 'not-covered', text: 'The Capital Gains page needs your own computations (share matching, costs, exchange rates): Counting House fills in the totals from your platform’s figures but does not work them out.' });
    }
  }
  if (gainsUnknown || cgNeeded) blockers.push({ key: 'cgt-rates', kind: 'not-covered', text: 'Capital gains: only ordinary gains at 18% and 24% are worked out here, not Business Asset Disposal or Investors’ Relief (14%), carried interest (32%) or tax already paid on a property return.' });
  if (crypto) blockers.push({ key: 'crypto', kind: 'not-covered', text: 'Crypto disposals: Counting House does not work out their gains. They go in their own section of the Capital Gains page.' });

  // ─── Areas Counting House does not prepare ───────────────────────────────────────────────────
  const side = store.transactions().filter((t) => inYear(t.date, ty) && t.category === 'side-income' && t.amount > 0 && !movesDirectorLoan(t, store));
  const sideTotal = fromMinor(side.reduce((s, t) => s + toMinor(t.amount), 0) + store.figures.filter((f) => f.kind === 'self_employment_income' && (f.taxYear === ty.label || inYear(f.periodEnd ?? f.date, ty))).reduce((s, f) => s + toMinor(f.amount), 0));
  ask(Q.selfEmployment, 'Did you do any work for yourself in the year (freelancing, a side business, selling things you made or bought to sell), however small?', {
    coverage: 'not-covered',
    notCovered: 'Self-employment is not prepared here. Up to £1,000 of income may be covered by the trading allowance, but not income from your employer or a company you are connected with: check, and if it must be reported, fill in the Self-employment pages (SA103) yourself; the tax here leaves out the profit and its Class 4 NI.',
    ...(sideTotal > 0 ? { inferred: { answer: true, why: `${formatMoney(sideTotal)} of side income in your records` } } : {}),
  });
  ask(Q.property, 'Did you have income from UK property (rent, or renting a room) over £1,000?', { coverage: 'not-covered', notCovered: 'UK property pages (SA105) are not prepared here.', ...(store.figures.some((f) => f.kind === 'rental_income' && (f.taxYear === ty.label || inYear(f.periodEnd ?? f.date, ty))) ? { inferred: { answer: true, why: 'Rental income in your records' } } : {}) });
  ask(Q.partnership, 'Were you in a partnership?', { coverage: 'not-covered', notCovered: 'Partnership pages (SA104) are not prepared here.' });
  ask(Q.trusts, 'Did you receive income from a trust, settlement or a deceased person’s estate?', { coverage: 'not-covered', notCovered: 'Trust pages (SA107) are not prepared here.' });
  ask(Q.foreignOther, 'Did you have any income from abroad not shown on these pages: interest from a foreign account, a foreign pension, rent from property abroad, or dividends from foreign shares held outside the platforms in your records?', {
    coverage: 'not-covered',
    notCovered: 'Foreign income other than the dividends shown is not prepared here: it goes on the Foreign pages (SA106), or TR 3 box 3 for up to £2,000 of untaxed foreign interest.',
  });
  ask(Q.lessCommon, 'Any of these: a State Pension lump sum, a benefit from pre-owned assets, pension payments not through pay into a retirement annuity, an employer’s scheme or an overseas scheme, Blind Person’s Allowance, or (over State Pension age with income over £35,000) a Winter Fuel Payment?', {
    coverage: 'not-covered',
    notCovered: 'These boxes (TR 3 boxes 9, 10 and 20, TR 4 boxes 2 to 4 and 13 to 16, the Winter Fuel Payment charge on TR 5) are not prepared here, and the tax worked out here leaves them out.',
  });
  ask(Q.residence, 'Were you not resident in the UK, or resident in another country as well, for any of the year, or making a claim on the Residence pages (the foreign income and gains regime, Overseas Workday Relief)?', { coverage: 'not-covered', notCovered: 'Residence pages (SA109) are not prepared here, and the tax worked out here assumes you were UK resident all year.' });
  ask(Q.additional, 'Anything for the Additional information pages: interest from gilts, bonds or peer-to-peer lending, life insurance gains, share schemes, employment lump sums, a pension savings tax charge, or relief for losses?', {
    coverage: 'not-covered',
    notCovered: 'The Additional information pages (SA101) are not prepared here.',
    help: 'Includes a charge when pension savings (yours and your employers’) go over the £60,000 annual allowance.',
  });

  // ─── The calculation, from the boxes ────────────────────────────────────────────────────────
  const poa = poaMade(store, ty, entries);
  const employment = sa102Inputs.reduce((s, j) => s + toMinor(j.income), 0);
  const paye = sa102Inputs.reduce((s, j) => s + toMinor(j.tax), 0) + toMinor(tr3Values['12'] ?? 0) + toMinor(tr3Values['14'] ?? 0) + toMinor(tr3Values['19'] ?? 0);
  const taxedInterest = num(answer('TR3:1') ?? null);
  // Pensions and benefits as one group, other income net of its expenses, each down to the pound (c1.52, c1.53).
  const pensionsGroup = floorPounds(['8', '11', '13', '15', '16'].reduce((s, b) => s + toMinor(tr3Values[b] ?? 0), 0));
  const otherGroup = floorPounds(Math.max(0, toMinor(tr3Values['17'] ?? 0) - toMinor(tr3Values['18'] ?? 0)));
  const ukInterest = pounds((taxedInterest * 100) / 80, 'down') + pounds(num(untaxed), 'down');
  const ukDividends = pounds(num(ukDiv), 'down') + pounds(num(answer('TR3:5') ?? null), 'down');
  const foreignDividendsTotal = foreignOnTr3 ? pounds(tr3Foreign, 'down') : pounds(foreignTaxable, 'down');
  // Gift Aid: the year's net gifts rounded up, grossed up, rounded up again (c4.56–c4.57).
  const giftGross = giftNet > 0 ? Math.ceil(Math.ceil(giftNet - 1e-9) / (1 - params.reliefAtSourceRate) - 1e-9) : 0;
  const rasGross = pounds(num(rasBox), 'up');
  // The student loan's own income (HMRC's stage 27): pay, tips and the loan's benefits by job, pensions
  // and taxable benefits; unearned is interest, dividends, foreign income, Jobseeker's Allowance and
  // other income; less pension contributions with relief on the return.
  const slEarned = sa102Inputs.reduce((s, j) => s + toMinor(j.slEarned), 0) + floorPounds(['8', '11', '16'].reduce((s, b) => s + toMinor(tr3Values[b] ?? 0), 0));
  const slUnearned = toMinor(ukInterest + ukDividends + foreignDividendsTotal + pounds(num(answer('TR3:3') ?? null), 'down')) + floorPounds(toMinor(tr3Values['15'] ?? 0)) + otherGroup;
  // Paying through the tax code: only with pay or a pension through PAYE, online by 30 December, and not refused.
  const codingBy = saDeadlines(ty).find((d) => d.kind === 'online-through-code')!.date;
  const canCode = (jobs.length > 0 || (tr3Values['11'] ?? 0) > 0) && now <= codingBy && noCoding !== true;
  const input: TaxCalcInput = {
    ty,
    scottish: store.profile.taxRegion === 'scotland',
    nonSavings: { employment: fromMinor(employment), pensions: fromMinor(pensionsGroup), other: fromMinor(otherGroup) },
    savings: ukInterest + pounds(num(answer('TR3:3') ?? null), 'down'),
    dividends: ukDividends + foreignDividendsTotal,
    ...(foreignSources.length ? { foreignDividends: foreignSources } : {}),
    bandExtension: { reliefAtSource: rasGross, giftAid: giftGross },
    ...(maQ === 'transferring' ? { marriageAllowance: 'transferred' as const } : maQ === 'receiving' ? { marriageAllowance: 'received' as const } : {}),
    ...(childBenefit > 0 ? { childBenefit } : {}),
    ...(gains ? { gains } : {}),
    ...(plans.length ? { studentLoan: { plans, deductedByEmployers: slBox, postgraduateDeductedByEmployers: pgBox, earned: fromMinor(slEarned), unearned: fromMinor(slUnearned), deductions: rasGross } } : {}),
    // Tax on taxed interest: the net amount × 25%, up to the penny, in whole pence (c11.27).
    deducted: { paye: fromMinor(paye), taxedInterest: fromMinor(Math.ceil((toMinor(taxedInterest) * 25) / 100 - 1e-9)) },
    earlierYearsInCode: earlier,
    outstandingDebtInCode: debt,
    thisYearInNextCode: nextCode,
    refundedInYear: refunded,
    paymentsOnAccountMade: poa.amount ?? 0,
    codeOut: canCode,
  };
  const calc = computeTax(input);
  if (poa.amount === null) blockers.push({ key: 'owed:poa-made', kind: 'missing', text: `Payments on account you made for ${ty.label}: ${poa.why}` });
  const calcNoCoding = computeTax({ ...input, codeOut: false });
  // The foreign page's relief box: the relief worked out.
  if (foreignPage && calc.reducers.some((r) => r.id === 'foreign-tax-credit')) {
    const relief = -(calc.reducers.find((r) => r.id === 'foreign-tax-credit')!.tax ?? 0);
    foreignPage.boxes.push(makeBox(forms, 'SA106', '2', 'SA106:2', entries, { records: relief, basis: 'The relief as worked out below (optional: HMRC works it out if you leave it blank)' }));
  }
  if (foreignPage) pages.splice(pages.indexOf(tr3) + 1, 0, foreignPage);

  // ─── TR 2: which pages, from the answers ────────────────────────────────────────────────────
  const tr2 = newPage(forms, 'TR2');
  const qa = (key: string) => questions.find((q) => q.key === key)?.answer;
  // A page's Yes or No rests on its question: until that is answered, the box is too.
  const open = (...keys: string[]) => keys.some((k) => questions.find((q) => q.key === k)?.state === 'unanswered');
  const yesNo = (key: string, records: boolean | null, basis: string, dependsOn: string[] = []) =>
    tr2.boxes.push(makeBox(forms, 'TR2', key, `TR2:${key}`, {}, open(...dependsOn) && records !== true ? { required: true, basis: 'Answer the question above first', always: true } : { records, basis, always: true }));
  yesNo('Q1', jobs.length > 0 || isYes(qa(Q.otherDirectorships)), jobs.length ? `${jobs.length} Employment ${jobs.length === 1 ? 'page' : 'pages'}` : 'No employment', [Q.employment]);
  if (jobs.length) tr2.boxes.push(makeBox(forms, 'TR2', 'Q1 number', 'TR2:Q1 number', {}, { records: jobs.length, basis: 'One per job or directorship' }));
  yesNo('Q2', isYes(qa(Q.selfEmployment)), 'Your answer below', [Q.selfEmployment]);
  yesNo('Q3', isYes(qa(Q.partnership)), 'Your answer below', [Q.partnership]);
  yesNo('Q4', isYes(qa(Q.property)), 'Your answer below', [Q.property]);
  yesNo('Q5', Boolean(foreignPage) || isYes(qa(Q.residence)), foreignPage ? 'Foreign dividends over the £500 the Income page takes, with relief for the foreign tax' : 'No foreign income needing the Foreign pages');
  yesNo('Q6', isYes(qa(Q.trusts)), 'Your answer below', [Q.trusts]);
  yesNo('Q7', cgNeeded, cgNeeded ? 'Over a reporting limit, or a loss to claim' : sales.length ? `Not needed: proceeds ${formatMoney(proceeds)} and gains ${formatMoney(gainsRec)} are under the limits` : 'No disposals');
  yesNo('Q8', isYes(qa(Q.residence)), 'Your answer below', [Q.residence]);
  yesNo('Q9', isYes(qa(Q.additional)), 'Your answer below', [Q.additional]);
  pages.unshift(tr2);

  // ─── Readiness ──────────────────────────────────────────────────────────────────────────────
  for (const page of pages)
    for (const b of page.boxes) {
      // TR 2's boxes follow the questions, which are listed already.
      if (page.id === 'TR2') continue;
      if (b.state === 'missing') blockers.push({ key: b.key, kind: 'missing', text: `${page.form} ${page.page}${page.instance ? ` (${page.instance})` : ''} box ${b.box}: ${b.label.replace(/ [–-] .*$/, '')}` });
      else if (b.state === 'check') blockers.push({ key: b.key, kind: 'check', text: `${page.form} ${page.page}${page.instance ? ` (${page.instance})` : ''} box ${b.box}: ${b.check ?? 'check this figure'}` });
    }
  if (!finished) blockers.unshift({ key: 'year', kind: 'not-covered', text: `The tax year ends on ${formatDate(ty.end)}: these are the figures so far.` });
  if (!found.own) blockers.unshift({ key: 'forms', kind: 'not-covered', text: `HMRC has not published the ${ty.label} forms yet: the boxes are those of the ${forms.taxYear} forms.` });

  // ─── Checks: the return against the rest of the app ────────────────────────────────────────
  const payTotal = jobs.reduce((s, j) => s + toMinor(j.chosen.gross_pay?.amount ?? 0), 0);
  const payBoxes = sa102Inputs.reduce((s, j) => s + toMinor(j.pay), 0);
  checks.push({ label: 'Pay on the Employment pages matches Tax → Pay', ok: payTotal === payBoxes, detail: `${formatMoney(fromMinor(payBoxes))} on the pages; ${formatMoney(fromMinor(payTotal))} from the same sources${payTotal === payBoxes ? '' : ': a box you set differs'}` });
  checks.push({ label: 'Interest matches Tax → Allowances', ok: toMinor(num(untaxed)) === toMinor(allow.savings.interest), detail: `${formatMoney(num(untaxed))} in TR 3 box 2; ${formatMoney(allow.savings.interest)} against the Personal Savings Allowance` });
  const divReturn = toMinor(num(ukDiv)) + foreign.grossMinor;
  checks.push({ label: 'Dividends match Tax → Allowances', ok: Math.abs(divReturn - toMinor(allow.dividends.amount)) <= 5, detail: `${formatMoney(fromMinor(divReturn))} across TR 3 and the Foreign page; ${formatMoney(allow.dividends.amount)} against the dividend allowance${foreign.note ? ` (${foreign.note})` : ''}` });
  const allowBand = allow.taxBand?.band;
  const calcBand = calc.taxableIncome > calc.higherRateLimit ? 'additional' : calc.taxableIncome > calc.basicRateLimit ? 'higher' : calc.taxableIncome > 0 ? 'basic' : 'none';
  if (allowBand) checks.push({ label: 'Tax band matches Tax → Allowances', ok: allowBand === calcBand, detail: `${calcBand} rate on the return; ${allowBand} rate on Allowances${allowBand === calcBand ? '' : ' (Allowances works from your records alone, the return from its boxes)'}` });
  const hmrcPayments = store.hmrc.filter((r) => r.type === 'payment' && r.taxYear === ty.label);
  if (hmrcPayments.length) {
    const hmrcTax = hmrcPayments.reduce((s, r) => s + toMinor(r.type === 'payment' ? r.tax : 0), 0);
    checks.push({ label: 'Tax on pay matches HMRC’s record of your payments', ok: hmrcTax === paye, detail: `${formatMoney(fromMinor(paye))} on the return; ${formatMoney(fromMinor(hmrcTax))} in HMRC’s record` });
  }
  const settlement = store.hmrc.filter((r) => r.type === 'settlement' && r.taxYear === ty.label).sort((a, b) => (a.type === 'settlement' && b.type === 'settlement' ? a.asOf.localeCompare(b.asOf) : 0)).at(-1);
  if (settlement && settlement.type === 'settlement' && settlement.amount !== undefined) {
    const theirs = settlement.outcome === 'overpaid' ? -settlement.amount : settlement.outcome === 'underpaid' ? settlement.amount : 0;
    checks.push({ label: 'The balance matches HMRC’s working out of the year', ok: Math.abs(toMinor(theirs) - toMinor(calcNoCoding.balancing)) <= 100, detail: `${formatMoney(calcNoCoding.balancing)} here; ${formatMoney(theirs)} on HMRC’s page of ${formatDate(settlement.asOf)}` });
  }

  const owner = ownerStatusOf(store, ty.label);
  return {
    taxYear: { label: ty.label, start: ty.start, end: ty.end, finished },
    forms: { taxYear: forms.taxYear, edition: forms.edition, own: found.own },
    questions,
    pages,
    calculation: calc,
    owed: {
      liability: calc.totalLiability,
      deductedAtSource: calc.deductedAtSource,
      balance: calcNoCoding.balancing,
      paymentsOnAccountMade: input.paymentsOnAccountMade ?? 0,
      paymentsOnAccountWhy: poa.why,
      withoutCoding: { dueJanuary: calcNoCoding.dueJanuary, dueJuly: calcNoCoding.dueJuly, poa: calcNoCoding.paymentsOnAccount },
      withCoding: calc.codable > 0 && (jobs.length > 0 || (tr3Values['11'] ?? 0) > 0) && now <= codingBy ? { coded: calc.codable, dueJanuary: computeTax({ ...input, codeOut: true }).dueJanuary, dueJuly: computeTax({ ...input, codeOut: true }).dueJuly, by: codingBy } : null,
      codingOutLimit,
      januaryDue: `${ty.startYear + 2}-01-31`,
      julyDue: `${ty.startYear + 2}-07-31`,
      ownerStatus: owner.status ?? null,
    },
    readiness: { ready: blockers.length === 0, blockers },
    checks,
  };

  // ─── Helpers that close over the year ───────────────────────────────────────────────────────
  function box(page: ReturnPageView, boxNo: string, opts: BoxOpts): Value {
    const b = makeBox(forms, page.id, boxNo, `${page.keyPrefix}:${boxNo}`, entries, opts);
    page.boxes.push(b);
    return b.value;
  }
}

// ─── Building boxes ─────────────────────────────────────────────────────────────────────────────

function newPage(forms: SaFormSet, id: string, instance?: string, keyPrefix?: string): ReturnPageView {
  const def = forms.pages.find((p) => p.id === id)!;
  return { id, form: def.form, page: def.page, title: def.title, ...(instance ? { instance } : {}), keyPrefix: keyPrefix ?? id, boxes: [] };
}

function makeBox(forms: SaFormSet, pageId: string, boxNo: string, key: string, entries: Record<string, ReturnEntry>, opts: BoxOpts): ReturnBoxView {
  const def = forms.pages.find((p) => p.id === pageId)!.sections.flatMap((s) => s.boxes).find((b) => b.box === boxNo)!;
  const e = entries[key];
  const records = opts.records;
  const hasRecords = records !== undefined;
  let value: Value;
  let state: ReturnBoxView['state'];
  let basis = opts.basis ?? '';
  if (e && !(e.value === null && opts.nil === 'refused')) {
    value = e.value;
    state = e.value === null ? 'nil' : 'yours';
    basis = e.value === null ? 'None, as you confirmed' : 'Your figure';
  } else if (hasRecords && records !== null && records !== 0 && records !== false) {
    value = records;
    state = opts.check ? 'check' : 'records';
  } else if (hasRecords && (records === 0 || records === null || records === false)) {
    // The records show none for certain: a nil, left blank on the form (a Yes/No still answered No).
    value = def.kind === 'yesno' ? false : records === 0 && opts.required ? 0 : null;
    state = opts.check ? 'check' : 'nil';
  } else {
    value = null;
    state = opts.required ? 'missing' : 'blank';
  }
  const nilText = state === 'nil' ? (opts.nil === 'none' ? 'None' : opts.nil === 'zero' ? (def.kind === 'money' ? '0.00' : '0') : '') : '';
  const entered = nilText || enteredAs(def, value, 'online');
  const paper = nilText ? (opts.nil === 'zero' ? '0' : nilText) : enteredAs(def, value, 'paper');
  return {
    key,
    box: def.box,
    ...(def.page ? { page: def.page } : {}),
    label: def.label,
    kind: def.kind,
    ...(def.round ? { round: def.round } : {}),
    value: def.kind === 'money' && typeof value === 'number' ? value : value,
    entered,
    ...(paper !== entered ? { paper } : {}),
    ...(e && hasRecords ? { fromRecords: records ?? null } : {}),
    state,
    basis,
    ...(opts.check && !e ? { check: opts.check } : {}),
    trace: opts.trace ?? [],
    notes: [...(opts.notes ?? []), ...(e?.note ? [`Your note: ${e.note}`] : [])],
    editable: opts.editable ?? false,
    ...(opts.nil === 'refused' ? { nilRefused: true } : {}),
    ...(opts.always ? { always: true } : {}),
  };
}

/**
 * The figure as you type it in: online, pounds and pence as the records give it (HMRC's calculation
 * rounds income down to the pound itself, and keeps the pence of tax taken off); on paper, whole
 * pounds rounded as the form says (income down, expenses and tax paid up). An X, Yes or No.
 */
function enteredAs(def: SaBoxDef, value: Value, how: 'online' | 'paper'): string {
  if (value === null || value === undefined) return '';
  if (def.kind === 'money' && typeof value === 'number') {
    if (how === 'online' || def.round === 'pence') return fromMinor(toMinor(value)).toFixed(2);
    return String(pounds(value, def.round ?? 'down'));
  }
  if (def.kind === 'yesno') return value === true ? 'Yes' : value === false ? 'No' : String(value);
  if (def.kind === 'x') return value === true ? 'X' : '';
  if (def.kind === 'percent' && typeof value === 'number') return `${value}%`;
  return String(value);
}

function num(v: Value | undefined): number {
  return typeof v === 'number' ? v : 0;
}

function describe(s: PaySource): string {
  if (s.kind === 'yours') return 'Your figure in Settings → Tax documents';
  if (s.label === 'P60') return 'Its P60';
  if (s.kind === 'year') return 'A document for the whole year';
  if (s.kind === 'payslips') return `${s.label}`;
  if (s.records) return `HMRC’s record of its payments to ${formatDate(s.asOf)}${s.final ? ' (the job has ended)' : ''}`;
  if (s.payslipId) return `The year to date on its payslip of ${formatDate(s.asOf)}${s.final ? ' (the job has ended)' : ''}`;
  return `A document ${s.label}${s.final ? ' (the job has ended)' : ''}`;
}

function sourceTrace(s: PaySource, what: string): ReturnTrace[] {
  return [
    ...figureTrace(s.figures),
    ...(s.records ?? []).map((r) => ({ label: `HMRC’s record of a payment: ${what}`, amount: what === 'tax' ? r.tax : r.taxablePay, date: r.payDate, ref: { type: 'hmrc' as const, id: r.id } })),
    ...(s.payslipId ? [{ label: `Payslip: ${what} for the year to date`, amount: s.amount, date: s.asOf, ref: { type: 'payslip' as const, id: s.payslipId } }] : []),
  ];
}

function figureTrace(list: Figure[]): ReturnTrace[] {
  return list.map((f) => ({ label: `${f.label}${f.payer ? `, ${f.payer}` : ''}`, amount: f.amount, ...(f.date ?? f.periodEnd ? { date: (f.date ?? f.periodEnd)! } : {}), ref: { type: 'figure' as const, id: f.id } }));
}

function txTrace(t: Transaction, amount: number): ReturnTrace {
  return { label: t.payee ?? t.description, amount, date: t.date, ref: { type: 'transaction', id: t.id, accountId: t.accountId } };
}

// ─── Records the boxes read ─────────────────────────────────────────────────────────────────────

interface ForeignRow {
  country: string;
  isins: string[];
  grossMinor: number;
  taxMinor: number;
  trace: ReturnTrace[];
}

/**
 * Dividends paid on a trading platform, by the ISIN each payment carries: GB ones are UK dividends,
 * the rest foreign, by country, with the withholding tax taken off them (in pounds at the payment's
 * exchange rate). The platform's credit is after that tax, so the dividend is the credit plus the
 * tax. Used only when the payments add up, within 5p, to the platform's statement for the year.
 */
function foreignDividends(store: Store, ty: TaxYear, lines: { accountId?: string; amount: number; source: string; label: string }[]) {
  const byAccount = new Map<string, { ukMinor: number }>();
  const rows = new Map<string, ForeignRow>();
  let grossMinor = 0;
  let taxMinor = 0;
  const trace: ReturnTrace[] = [];
  const taxTrace: ReturnTrace[] = [];
  let note: string | undefined;
  /** Platform dividends that could not be split by country, so stay in TR 3 box 4: each said, never hidden. */
  const unsplit: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const account = l.accountId ? store.account(l.accountId) : undefined;
    if (!account || account.type !== 'gia' || seen.has(account.id)) continue;
    seen.add(account.id);
    // Each line of the account once: a statement stands for its payments, else the payments are the line.
    const ofAccount = lines.filter((x) => x.accountId === account.id);
    const lineTotal = ofAccount.reduce((a, x) => a + toMinor(x.amount), 0);
    const credits = store.transactions(account.id).filter((t) => inYear(t.date, ty) && t.amount > 0 && /^dividend/i.test(String(t.raw?.['Action'] ?? t.description)));
    const paid = credits.filter((t) => typeof t.raw?.['ISIN'] === 'string');
    const statement = ofAccount.some((x) => x.source === 'figure');
    const isinNet = paid.reduce((a, t) => a + toMinor(t.amount), 0);
    if (!paid.length || ofAccount.length > 1 || (!statement && (paid.length !== credits.length || isinNet !== lineTotal))) {
      unsplit.push(`${formatMoney(fromMinor(lineTotal))} of dividends in ${account.name} could not be split by the country of the company that paid them`);
      continue;
    }
    let uk = 0;
    const local = new Map<string, ForeignRow>();
    let total = 0;
    for (const t of paid) {
      const isin = String(t.raw!['ISIN']);
      const wht = Number(t.raw!['Withholding tax'] ?? 0) || 0;
      const rate = Number(t.raw!['Exchange rate'] ?? 0) || 0;
      const whtCcy = String(t.raw!['Currency (Withholding tax)'] ?? 'GBP');
      const whtMinor = whtCcy === 'GBP' ? toMinor(wht) : rate > 0 ? Math.round(wht * rate * 100) : 0;
      const gross = toMinor(t.amount) + whtMinor;
      total += gross;
      const cc = isin.slice(0, 2).toUpperCase();
      if (cc === 'GB') {
        uk += gross;
        continue;
      }
      const code = COUNTRY[cc] ?? cc;
      const row = local.get(code) ?? local.set(code, { country: code, isins: [], grossMinor: 0, taxMinor: 0, trace: [] }).get(code)!;
      if (!row.isins.includes(isin)) row.isins.push(isin);
      row.grossMinor += gross;
      row.taxMinor += whtMinor;
      row.trace.push({ label: `${t.description.replace(/^Dividend[^·]*·\s*/, '')}: ${formatMoney(t.amount)} paid in${whtMinor ? ` + ${formatMoney(fromMinor(whtMinor))} tax` : ''}`, amount: fromMinor(gross), date: t.date, ref: { type: 'transaction', id: t.id, accountId: t.accountId } });
    }
    // Only when the payments are the statement's dividends (or there is no statement): else leave the line as it is.
    if (l.source === 'figure' && Math.abs(total - toMinor(l.amount)) > 5) {
      unsplit.push(`${account.name}: its payments add up to ${formatMoney(fromMinor(total))} with the tax taken off them, not the statement’s ${formatMoney(l.amount)}, so its dividends are not split by country`);
      continue;
    }
    if (l.source === 'figure' && total !== toMinor(l.amount)) note = `${account.name}: its payments add up to ${formatMoney(fromMinor(total))} with the tax taken off them, the statement says ${formatMoney(l.amount)}; the difference is rounding`;
    byAccount.set(account.id, { ukMinor: uk });
    for (const r of local.values()) {
      const into = rows.get(r.country) ?? rows.set(r.country, { country: r.country, isins: [], grossMinor: 0, taxMinor: 0, trace: [] }).get(r.country)!;
      into.isins.push(...r.isins.filter((i) => !into.isins.includes(i)));
      into.grossMinor += r.grossMinor;
      into.taxMinor += r.taxMinor;
      into.trace.push(...r.trace);
      grossMinor += r.grossMinor;
      taxMinor += r.taxMinor;
      trace.push(...r.trace);
      taxTrace.push({ label: `${r.country}: tax taken off`, amount: fromMinor(r.taxMinor) });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => b.grossMinor - a.grossMinor);
  return { byAccount, rows: sorted, grossMinor, taxMinor, netMinor: grossMinor - taxMinor, trace, taxTrace, note, unsplit };
}

/** Payments from HMRC into your bank during the year (refunds of tax, say): for you to say what each was. */
function hmrcRefunds(store: Store, ty: TaxYear): Transaction[] {
  return store.transactions().filter((t) => inYear(t.date, ty) && t.amount > 0 && /\bHMRC\b|HM REVENUE|INLAND REVENUE/i.test(`${t.description} ${t.payee ?? ''} ${t.counterpartyName ?? ''}`) && !/CHILD BENEFIT|TAX CREDIT|TAX-FREE CHILDCARE|CHB/i.test(t.description));
}

/** What the year's tax codes suggest: a code below the usual allowance can mean HMRC collected something through it. Only the coding notice settles it. */
function inCodeHint(store: Store, ty: TaxYear): string {
  const codes = [...new Set(store.hmrc.filter((r) => r.type === 'tax-code' && r.taxYear === ty.label).map((r) => (r.type === 'tax-code' ? r.code : '')))];
  const usual = Math.floor(taxYearParams(ty).personalAllowance / 10);
  const lower = codes.filter((c) => /^\d+L$/.test(c) && Number(c.slice(0, -1)) < usual);
  return lower.length ? `Your records have the code ${lower.join(', ')} for the year, below the usual ${usual}L: its coding notice says why.` : 'A code below the usual one, or a K code, is a sign to check.';
}

/**
 * Payments on account already made for the year: yours (`owed:poa-made`), else none when the year
 * before had no return (HMRC sets them only from a return); otherwise unknown (null).
 */
function poaMade(store: Store, ty: TaxYear, entries: Record<string, ReturnEntry> = store.taxReturn(ty.label)?.entries ?? {}): { amount: number | null; why: string } {
  const yours = entries['owed:poa-made'];
  if (yours) return { amount: typeof yours.value === 'number' ? yours.value : 0, why: 'Your figure' };
  const before = ownerStatusOf(store, makeTaxYear(ty.startYear - 1).label);
  if (before.status === 'not-needed' || before.status === 'told-hmrc') return { amount: 0, why: `None: there was no ${makeTaxYear(ty.startYear - 1).label} return to set them` };
  if (!before.status && !before.sendsReturns) return { amount: 0, why: `None, as far as the app knows: you have not said you sent a ${makeTaxYear(ty.startYear - 1).label} return` };
  return { amount: null, why: `Your ${makeTaxYear(ty.startYear - 1).label} return may have set payments on account for this year: your HMRC statement shows them` };
}

export type { EmployerYear };
