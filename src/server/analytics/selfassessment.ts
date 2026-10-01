// Self Assessment preparation: gathers, per tax year, the figures a UK SA100 return usually asks for,
// shows where each one came from, and flags gaps. It is an aid for filling the return yourself, not
// tax advice; every figure must be checked against your own records before you submit.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { SaItem, SaSection, SaSource, SelfAssessmentResponse } from '../../shared/api';
import { addDays, formatDate, maxDate, minDate, today } from '../../shared/dates';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import type { Figure, FigureKind } from '../../shared/schema';
import { parseTaxYear, taxYearOf, taxYearParams, untaxedIncomeNoticeBy, type TaxYear } from '../../shared/uk';
import type { Store } from '../store';
import { allowances, giftAid, pensionTotals, reliefAtSource } from './allowances';
import { employerYears, type PaySource } from './sources';

export const SA_DISCLAIMER =
  'This page gathers figures from your own data to help you fill in your Self Assessment return. It is not tax advice and it can be incomplete or wrong: bank data shows net pay, may miss interest paid into accounts you have not imported, and cannot know which donations were Gift Aided. Check every figure against your P60, P11D, bank interest statements, pension and dividend statements before you submit. You are responsible for your return.';

const inYear = (d: string | undefined, ty: TaxYear) => Boolean(d && d >= ty.start && d <= ty.end);

function figuresOf(store: Store, ty: TaxYear, kind: FigureKind): Figure[] {
  return store.figures.filter((f) => f.kind === kind && (f.taxYear === ty.label || (!f.taxYear && inYear(f.periodEnd ?? f.date, ty))));
}

function sumFigures(list: Figure[]): number {
  return fromMinor(list.reduce((s, f) => s + toMinor(f.amount), 0));
}

function figureSources(list: Figure[]): SaSource[] {
  return list.map((f) => ({ type: 'figure', id: f.id, label: `${f.label}${f.payer ? `, ${f.payer}` : ''}`, amount: f.amount, ...(f.date ? { date: f.date } : {}) }));
}

export function selfAssessment(store: Store, label?: string): SelfAssessmentResponse {
  const ty = (label ? parseTaxYear(label) : null) ?? taxYearOf(today());
  const params = taxYearParams(ty);
  const allow = allowances(store, ty.label);
  const sections: SaSection[] = [];
  const checklist: SelfAssessmentResponse['checklist'] = [];
  const mayNeedToFile: SelfAssessmentResponse['mayNeedToFile'] = [];

  // ── Employment (SA102) ──
  // Each job's pay and tax from the one source that counts (sources.ts): its P60 or another figure for
  // the whole year, else the latest of its documents to date and its payslips so far. Never two of
  // them, so nothing counts twice.
  const jobs = employerYears(store, ty);
  const withPay = jobs.filter((e) => e.chosen.gross_pay);
  const pay = withPay.flatMap((e) => e.chosen.gross_pay!.figures);
  const tax = jobs.flatMap((e) => e.chosen.tax_deducted?.figures ?? []);
  const soFar = withPay.filter((e) => !e.chosen.gross_pay!.final);
  const taxUnknown = withPay.filter((e) => !e.chosen.tax_deducted);
  const taxSoFar = jobs.filter((e) => e.chosen.tax_deducted && !e.chosen.tax_deducted.final);
  const fromWhat = (src: PaySource) =>
    src.kind === 'payslips' ? `${src.label}: its P60 for ${ty.label} gives the year's figure` : src.kind === 'yours' ? 'your figure' : src.final ? (src.label === 'P60' ? 'its P60' : 'a document for the whole year') : `a document ${src.label}: its P60 gives the year's figure`;
  const jobNotes = withPay.map((e) => {
    const t = e.chosen.tax_deducted;
    return `${e.payer || 'An employer'}${e.payeReference ? ` (PAYE ${e.payeReference})` : ''}: pay ${formatMoney(e.chosen.gross_pay!.amount)}, from ${fromWhat(e.chosen.gross_pay!)}; tax ${t ? formatMoney(t.amount) : 'not known'}.`;
  });
  // What the year's figures came from, for the basis: "P60 figures", else each kind there is.
  const kinds = new Set(withPay.map((e) => (e.chosen.gross_pay!.label === 'P60' ? 'P60s' : e.chosen.gross_pay!.kind === 'yours' ? 'your own' : 'other documents')));
  const wholeYear = kinds.size === 1 && kinds.has('P60s') ? 'P60 figures' : `Figures for the whole year: ${[...kinds].sort().join(' and ')}`;
  const bik = figuresOf(store, ty, 'benefit_in_kind');
  // Student loan deducted, like pay: one source per job.
  const slDeducted = jobs.flatMap((e) => e.chosen.student_loan_deducted?.figures ?? []);
  const salaryTx = store.transactions().filter((t) => inYear(t.date, ty) && t.category === 'salary' && t.amount > 0);
  const employment: SaItem[] = [
    {
      id: 'pay',
      label: 'Pay from employment',
      where: 'SA102 Employment: pay from this employment (from your P60/P45)',
      amount: pay.length ? sumFigures(pay) : null,
      status: pay.length ? (soFar.length ? 'check' : 'ready') : salaryTx.length ? 'missing' : 'not-applicable',
      basis: pay.length ? (soFar.length ? (soFar.length === withPay.length ? 'So far this year' : 'The year’s figures, and so far for some jobs') : wholeYear) : 'No P60 imported',
      notes: pay.length
        ? ['Use one SA102 per employer. The figure should match box "Pay" on its P60 (or P45 for a job you left).', ...jobNotes]
        : salaryTx.length
          ? [`${salaryTx.length} salary payments were found in your bank data, but those are net of tax. Upload your ${ty.label} P60 to get the gross figure.`]
          : [],
      sources: figureSources(pay),
    },
    {
      id: 'paye-tax',
      label: 'UK tax taken off pay',
      where: 'SA102 Employment: UK tax taken off pay',
      amount: tax.length ? sumFigures(tax) : null,
      status: tax.length ? (taxUnknown.length || taxSoFar.length ? 'check' : 'ready') : pay.length || salaryTx.length ? 'missing' : 'not-applicable',
      basis: tax.length ? (taxUnknown.length ? 'Some jobs only' : taxSoFar.length ? 'So far this year' : 'Figures for the whole year') : 'Not found',
      notes: taxUnknown.length
        ? [`Tax taken off is not known for ${taxUnknown.map((e) => e.payer || 'an employer').join(', ')}: ${taxUnknown.length === 1 ? 'its P60 gives it' : 'their P60s give it'} (or HMRC’s page for each job, under Check your Income Tax).`]
        : [],
      sources: figureSources(tax),
    },
    {
      id: 'bik',
      label: 'Benefits in kind',
      where: 'SA102 Employment: benefits from your P11D',
      amount: bik.length ? sumFigures(bik) : null,
      status: bik.length ? 'check' : 'not-applicable',
      basis: bik.length ? 'P11D figures' : 'None recorded',
      notes: bik.length ? ['Enter each benefit in its own box as it appears on your P11D.'] : [],
      sources: figureSources(bik),
    },
    {
      id: 'student-loan',
      label: 'Student loan repayments deducted by employer',
      where: 'SA100 page TR 2: Student loan repayments deducted by your employer',
      amount: slDeducted.length ? sumFigures(slDeducted) : null,
      status: slDeducted.length ? 'ready' : store.accounts.some((a) => a.type === 'student_loan') ? 'check' : 'not-applicable',
      basis: slDeducted.length ? 'P60 figures' : 'Not found',
      notes: slDeducted.length ? [] : store.accounts.some((a) => a.type === 'student_loan') ? ['You have a student loan account; the deductions are on your P60.'] : [],
      sources: figureSources(slDeducted),
    },
  ];
  sections.push({ id: 'employment', title: 'Employment', description: 'From your P60 (and P11D if you have benefits).', items: employment });
  checklist.push({ id: 'p60', done: withPay.length > 0 && !soFar.length && !taxUnknown.length, label: `P60 for ${ty.label} imported for every job`, detail: 'Drop the PDF on the Import page; the pay and tax figures are extracted.' });

  // ── Savings and investment income (SA100 TR 3) ──
  const interestItemNotes: string[] = [];
  let interestStatus: SaItem['status'] = allow.savings.interest > 0 ? 'ready' : 'not-applicable';
  const taxable = store.accounts.filter((a) => !ACCOUNT_TYPE_META[a.type].taxFreeInterest && balanceModeOf(a) === 'ledger' && a.type !== 'credit_card' && a.type !== 'loan' && a.type !== 'mortgage');
  for (const a of taxable) {
    // An account closed before the year, or opened after it, paid no interest in it.
    if ((a.closedOn && a.closedOn < ty.start) || (a.openedOn && a.openedOn > ty.end)) continue;
    const txs = store.transactions(a.id);
    const hasInterest = txs.some((t) => t.category === 'interest');
    if (!hasInterest && a.type !== 'savings') continue;
    const certificate = figuresOf(store, ty, 'interest_paid').some((f) => f.accountId === a.id);
    if (certificate) continue;
    const first = txs[0]?.date;
    const last = txs[txs.length - 1]?.date;
    // For a tax year still in progress, coverage up to about a month ago is complete enough.
    // An account opened or closed during the year needs data only for the part it was open.
    const needFrom = maxDate(ty.start, a.openedOn)!;
    const needTo = minDate(ty.end < today() ? ty.end : addDays(today(), -35), a.closedOn)!;
    if (!first || first > needFrom || !last || last < needTo) {
      interestStatus = 'check';
      interestItemNotes.push(
        `${a.name}: transactions ${first ? `cover ${formatDate(first)} to ${formatDate(last!)}` : 'are missing'}, not the whole tax year, so interest may be missing. The bank's annual interest statement is the reliable figure.`,
      );
    }
  }
  if (allow.savings.interest > 0) {
    interestItemNotes.unshift(
      allow.savings.interest > allow.savings.allowance
        ? `This is above your Personal Savings Allowance (${formatMoney(allow.savings.allowance, { decimals: 0 })}), so tax is due on ${formatMoney(allow.savings.interest - allow.savings.allowance)}.`
        : `This is within your Personal Savings Allowance (${formatMoney(allow.savings.allowance, { decimals: 0 })}). You still enter it if you file a return.`,
    );
  }
  const savingsItems: SaItem[] = [
    {
      id: 'interest',
      label: 'Untaxed UK interest',
      where: 'SA100 page TR 3: Untaxed UK interest etc.',
      amount: allow.savings.interest || null,
      status: interestStatus,
      basis: 'Interest outside ISAs and pensions, from transactions and interest statements',
      notes: interestItemNotes,
      sources: allow.savings.lines.map((l) => ({ type: l.source === 'figure' ? 'figure' : 'account', id: l.accountId ?? l.label, label: l.label, amount: l.amount })),
    },
    {
      id: 'dividends',
      label: 'Dividends from UK companies',
      where: 'SA100 page TR 3: Dividends from UK companies',
      amount: allow.dividends.amount || null,
      status: allow.dividends.amount > 0 ? 'check' : 'not-applicable',
      basis: 'Dividends outside ISAs and pensions',
      notes: allow.dividends.amount > 0 ? ['Foreign dividends go on SA106 instead. Check each against its dividend voucher.'] : [],
      sources: allow.dividends.lines.map((l) => ({ type: l.source === 'figure' ? 'figure' : 'account', id: l.accountId ?? l.label, label: l.label, amount: l.amount })),
    },
  ];
  sections.push({ id: 'savings', title: 'Interest and dividends', description: 'Income outside ISAs and pensions. ISA interest and Premium Bond prizes are tax-free and not entered.', items: savingsItems });
  checklist.push({ id: 'interest', done: interestStatus !== 'check', label: 'Interest covered for every savings account for the whole year', detail: 'Import the bank’s annual interest statement for any account flagged above.' });

  // ── Tax reliefs (SA100 TR 4) ──
  const pen = pensionTotals(store, ty);
  const ras = reliefAtSource(store, ty, pen);
  const rasAccounts = ras.accounts;
  const rasPersonalGross = ras.personalGross;
  const band = allow.taxBand.band;
  const gift = giftAid(store, ty);
  const charityTx = gift.charity;
  const giftAided = gift.aided;
  const giftFigures = gift.figures;
  const giftTotal = gift.paid;
  const reliefs: SaItem[] = [
    {
      id: 'pension-ras',
      label: 'Pension contributions with relief at source',
      where: 'SA100 page TR 4: Payments to registered pension schemes where basic rate tax relief will be claimed by your pension provider',
      amount: rasPersonalGross > 0 ? rasPersonalGross : null,
      status: rasPersonalGross > 0 ? 'check' : 'not-applicable',
      basis: 'Your payments into SIPPs / personal pensions plus the basic-rate relief added (gross)',
      notes:
        rasPersonalGross > 0
          ? [
              'Enter the gross amount (what you paid plus the 20% the provider claimed).',
              band === 'higher' || band === 'additional'
                ? 'As a higher/additional-rate taxpayer this is how you claim the extra relief.'
                : 'At basic rate there is no extra relief, but entering it is harmless.',
              'Do not include workplace contributions taken from pay before tax (net pay / salary sacrifice).',
            ]
          : [],
      sources: rasAccounts.map((a) => ({ type: 'account' as const, id: a.id, label: a.name })),
    },
    {
      id: 'gift-aid',
      label: 'Gift Aid payments',
      where: 'SA100 page TR 4: Gift Aid payments made in the year to 5 April',
      amount: giftTotal > 0 ? giftTotal : null,
      status: giftTotal > 0 ? 'check' : charityTx.length ? 'check' : 'not-applicable',
      basis: 'Donations tagged "gift-aid" plus Gift Aid figures from documents',
      notes:
        charityTx.length > giftAided.length
          ? [`${charityTx.length - giftAided.length === 1 ? '1 charity payment is' : `${charityTx.length - giftAided.length} charity payments are`} not tagged "gift-aid". Tag the ones you Gift Aided on the Transactions page.`]
          : [],
      sources: [
        ...giftAided.map((t) => ({ type: 'transaction' as const, id: t.id, date: t.date, label: t.payee ?? t.description, amount: -t.amount })),
        ...figureSources(giftFigures),
      ],
    },
  ];
  sections.push({ id: 'reliefs', title: 'Pension contributions and charity', description: 'Reliefs you claim on the return.', items: reliefs });
  if (rasAccounts.length) checklist.push({ id: 'pension', done: pen.lines.length > 0, label: 'Pension contributions recorded for the year', detail: 'Import SIPP / pension statements showing contributions and tax relief.' });
  if (charityTx.length) checklist.push({ id: 'gift-aid', done: charityTx.length === giftAided.length, label: 'Gift Aided donations tagged', detail: 'Tag Gift Aided donations with "gift-aid" on the Transactions page.' });

  // ── Other income and charges ──
  const other: SaItem[] = [];
  const childBenefit = store.transactions().filter((t) => inYear(t.date, ty) && t.amount > 0 && /CHILD BENEFIT/i.test(t.description));
  const cbFigures = figuresOf(store, ty, 'child_benefit');
  if (childBenefit.length || cbFigures.length) {
    const cb = fromMinor(childBenefit.reduce((s, t) => s + toMinor(t.amount), 0)) + sumFigures(cbFigures);
    other.push({
      id: 'hicbc',
      label: 'Child Benefit received (High Income Child Benefit Charge)',
      where: 'SA100 page TR 5: High Income Child Benefit Charge',
      amount: cb,
      status: 'check',
      basis: 'Child Benefit payments found in your bank data',
      notes: [`The charge applies if you or your partner have adjusted net income over £${params.hicbc.threshold.toLocaleString('en-GB')}, rising to the full amount of the benefit at £${params.hicbc.fullAt.toLocaleString('en-GB')}.`],
      sources: childBenefit.map((t) => ({ type: 'transaction' as const, id: t.id, date: t.date, label: t.description, amount: t.amount })),
    });
  }
  const side = store.transactions().filter((t) => inYear(t.date, ty) && t.category === 'side-income' && t.amount > 0);
  const sideFigures = figuresOf(store, ty, 'self_employment_income');
  const sideTotal = fromMinor(side.reduce((s, t) => s + toMinor(t.amount), 0)) + sumFigures(sideFigures);
  if (sideTotal > 0) {
    other.push({
      id: 'self-employment',
      label: 'Self-employment / side income (turnover)',
      where: 'SA103S Self-employment (short)',
      amount: sideTotal,
      status: 'check',
      basis: 'Transactions categorised "Side income"',
      notes: [
        params.tradingAllowance && sideTotal <= params.tradingAllowance
          ? `Under £${params.tradingAllowance.toLocaleString('en-GB')}: the trading allowance may mean you do not need to declare it.`
          : `Over the £${params.tradingAllowance.toLocaleString('en-GB')} trading allowance: record expenses as well (or deduct the allowance instead of expenses). Above £2,500 you must register for Self Assessment.`,
      ],
      sources: side.slice(0, 50).map((t) => ({ type: 'transaction' as const, id: t.id, date: t.date, label: t.payee ?? t.description, amount: t.amount })),
    });
    if (sideTotal > params.tradingAllowance) mayNeedToFile.push({ reason: `Self-employment income over £${params.tradingAllowance.toLocaleString('en-GB')}`, detail: `${formatMoney(sideTotal)} of side income this tax year. Sole traders earning more than this must send a return.` });
  }
  const giaSales = store.accounts
    .filter((a) => a.type === 'gia' || a.type === 'crypto')
    .flatMap((a) => store.transactions(a.id).filter((t) => inYear(t.date, ty) && t.category === 'trade' && t.amount > 0));
  if (giaSales.length || figuresOf(store, ty, 'capital_gain').length) {
    other.push({
      id: 'capital-gains',
      label: 'Disposals in taxable accounts',
      where: 'SA108 Capital gains summary',
      amount: null,
      status: 'check',
      basis: 'Sales in general investment or crypto accounts',
      notes: [
        `Gains are not calculated here. The annual exempt amount is ${formatMoney(params.cgtAnnualExemptAmount, { decimals: 0 })}; you must report if gains exceed it, or, if you are registered for Self Assessment, if total sale proceeds exceed ${formatMoney(params.cgtReportingProceeds ?? params.cgtAnnualExemptAmount * 4, { decimals: 0 })}.`,
      ],
      sources: giaSales.slice(0, 30).map((t) => ({ type: 'transaction' as const, id: t.id, date: t.date, label: t.description, amount: t.amount })),
    });
  }
  if (other.length) sections.push({ id: 'other', title: 'Other income and charges', description: 'Only shown when something in your data suggests it applies.', items: other });

  // ── Do you need to file? (hints only; gov.uk/check-if-you-need-tax-return is the authority) ──
  if (allow.savings.interest > allow.savings.allowance) {
    mayNeedToFile.push({
      reason: 'Interest above your Personal Savings Allowance',
      detail: 'HMRC usually collects the tax through your tax code or sends a tax calculation (simple assessment). You can also declare it on a return.',
    });
  }
  if (allow.dividends.amount > allow.dividends.allowance) {
    // gov.uk, "How to report tax on dividends": over £10,000 a return; up to it, through your tax code.
    const noticeBy = formatDate(untaxedIncomeNoticeBy(ty));
    const threshold = formatMoney(params.dividendsReturnThreshold, { decimals: 0 });
    mayNeedToFile.push(
      allow.dividends.amount > params.dividendsReturnThreshold
        ? { reason: `Dividends over ${threshold}`, detail: `${formatMoney(allow.dividends.amount)} of dividends this tax year: above ${threshold} you must send a Self Assessment return. If you do not usually send one, register by ${noticeBy}.` }
        : {
            reason: 'Dividends over the dividend allowance',
            detail: `${formatMoney(allow.dividends.amount)} of dividends, over the ${formatMoney(allow.dividends.allowance, { decimals: 0 })} allowance. If you send a return, they go on it. If not, HMRC must hear of them by ${noticeBy}: ask it to collect the tax through your tax code, or call its helpline.`,
          },
    );
  }
  if (rasPersonalGross > 0 && (band === 'higher' || band === 'additional')) {
    mayNeedToFile.push({ reason: 'Higher-rate relief on pension contributions', detail: 'Claim the extra relief on relief-at-source contributions via your return (or by contacting HMRC).' });
  }
  if (childBenefit.length) mayNeedToFile.push({ reason: 'Child Benefit received', detail: `You may owe the High Income Child Benefit Charge if your or your partner's income is over £${params.hicbc.threshold.toLocaleString('en-GB')}.` });
  checklist.push({
    id: 'band',
    done: allow.taxBand.basis === 'documents',
    label: `Tax band worked out from your pay (${allow.taxBand.band === 'none' ? 'no tax band' : `${allow.taxBand.band} rate`}${allow.taxBand.basis === 'documents' ? '' : allow.taxBand.basis === 'estimate' ? ', estimated' : ', at least'})`,
    detail: 'Import your P60 so the band, the Personal Savings Allowance and the pension relief hints rest on your gross pay.',
  });

  return {
    taxYear: {
      label: ty.label,
      start: ty.start,
      end: ty.end,
      filingDeadline: `${ty.startYear + 2}-01-31`,
      paymentDeadline: `${ty.startYear + 2}-01-31`,
    },
    disclaimer: SA_DISCLAIMER,
    sections,
    checklist,
    mayNeedToFile,
  };
}
