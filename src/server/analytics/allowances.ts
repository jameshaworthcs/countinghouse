// UK tax-year allowances: ISA (and the cash-ISA cap from 2027/28), LISA, pension annual allowance
// with carry-forward, Personal Savings Allowance and the dividend allowance.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { AllowanceLine, AllowancesResponse } from '../../shared/api';
import { addDays, diffDays, formatDate, maxDate, minDate, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account, Transaction } from '../../shared/schema';
import {
  ageOn,
  cashIsaLimit,
  daysLeftInTaxYear,
  parseTaxYear,
  pensionAnnualAllowance,
  personalSavingsAllowance,
  RULE_NOTES,
  taxYear as makeTaxYear,
  taxYearOf,
  taxYearParams,
  type TaxYear,
} from '../../shared/uk';
import type { Store } from '../store';
import { covers, mergeIntervals, type Interval } from './coverage';

const inYear = (t: { date: string }, ty: TaxYear) => t.date >= ty.start && t.date <= ty.end;

/** Slack when deciding whether an account's data covers a stretch: statements arrive on their own dates. */
export const COVERAGE_SLACK_DAYS = 45;

/**
 * Accounts whose data does not cover the tax year (up to `on` for the current one): what they show
 * for the year is a minimum. Returns a sentence saying which, or null when every account is covered.
 */
export function yearCoverageGap(store: Store, accounts: Account[], ty: TaxYear, on: ISODate, what: string): string | null {
  const end = minDate(ty.end, on)!;
  const short: { name: string; from: ISODate | null }[] = [];
  for (const a of accounts) {
    if (a.closedOn && a.closedOn < ty.start) continue;
    const start = maxDate(ty.start, a.openedOn) ?? ty.start;
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
  const intervals: Interval[] = [];
  for (const imp of store.imports) for (const s of imp.sections ?? []) if (s.accountId === account.id) intervals.push({ from: s.from, to: s.to });
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

export function pensionTotals(store: Store, ty: TaxYear) {
  const pensionAccounts = store.accounts.filter((a) => ACCOUNT_TYPE_META[a.type].pension && a.type !== 'state_pension' && a.type !== 'db_pension');
  let personal = 0;
  let personalGross = 0;
  let employer = 0;
  let relief = 0;
  const lines: AllowanceLine[] = [];
  const notes: string[] = [];
  for (const a of pensionAccounts) {
    const contrib = wrapperContributions(store, a, ty);
    const emp = sumCategory(store, [a], ty, 'employer-contribution');
    const rel = sumCategory(store, [a], ty, 'tax-relief');
    const reliefAtSource = a.type === 'sipp' || a.type === 'personal_pension' || a.pension?.method === 'relief_at_source';
    let gross = contrib.minor;
    if (reliefAtSource) {
      if (rel.minor) gross = contrib.minor + rel.minor;
      else if (contrib.minor) {
        const rate = taxYearParams(ty).reliefAtSourceRate;
        gross = Math.round(contrib.minor / (1 - rate));
        notes.push(`${a.name}: no tax-relief payments recorded yet, so basic-rate relief at source (${Math.round(rate * 100)}% of the gross) is estimated.`);
      }
    }
    personal += contrib.minor;
    personalGross += gross;
    employer += emp.minor;
    relief += rel.minor;
    if (contrib.minor || emp.minor || rel.minor) {
      lines.push({
        accountId: a.id,
        label: `${a.name}: you ${fromMinor(contrib.minor).toFixed(2)}${rel.minor ? `, relief ${fromMinor(rel.minor).toFixed(2)}` : ''}${emp.minor ? `, employer ${fromMinor(emp.minor).toFixed(2)}` : ''}`,
        amount: fromMinor(gross + emp.minor),
        source: 'transactions',
        transactionIds: [...(contrib.lines[0]?.transactionIds ?? []), ...(emp.lines[0]?.transactionIds ?? []), ...(rel.lines[0]?.transactionIds ?? [])],
      });
    }
  }
  // Figures from pension statements / payslips take precedence when present. Documents state what
  // you paid and the basic-rate relief the provider added separately; together they are the gross.
  const figs = store.figures.filter((f) => f.taxYear === ty.label);
  const figEmployee = figs.filter((f) => f.kind === 'pension_contribution_employee').reduce((s, f) => s + toMinor(f.amount), 0);
  const figRelief = figs.filter((f) => f.kind === 'pension_tax_relief').reduce((s, f) => s + toMinor(f.amount), 0);
  const figEmployer = figs.filter((f) => f.kind === 'pension_contribution_employer').reduce((s, f) => s + toMinor(f.amount), 0);
  if (figEmployee && figEmployee + figRelief > personalGross) {
    personalGross = figEmployee + figRelief;
    lines.push({ label: `Your contributions (from documents${figRelief ? ', with the tax relief added' : ''})`, amount: fromMinor(figEmployee + figRelief), source: 'figure' });
  }
  if (figEmployer && figEmployer > employer) {
    employer = figEmployer;
    lines.push({ label: 'Employer contributions (from documents)', amount: fromMinor(figEmployer), source: 'figure' });
  }
  return { personal, personalGross, employer, relief, total: personalGross + employer, lines, notes, hasAccounts: pensionAccounts.length > 0 };
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
  const band = store.profile.taxBand ?? 'basic';
  const psa = personalSavingsAllowance(ty, band);
  const savingsNotes: string[] = [];
  if (!store.profile.taxBand) savingsNotes.push('Assuming basic-rate tax. Set your tax band in Settings for the right allowance.');
  savingsNotes.push('Premium Bond prizes and ISA interest are tax-free and not counted.');

  // Dividends outside ISAs and pensions.
  const ledger = store.accounts.filter((a) => !ACCOUNT_TYPE_META[a.type].taxFreeInterest && balanceModeOf(a) === 'ledger');
  const gias = store.accounts.filter((a) => a.type === 'gia');
  const divLedger = sumCategory(store, ledger, ty, 'dividends');
  const divGia = sumCategory(store, gias, ty, 'investment-income', 1, /DIVIDEND|DISTRIBUTION/i);
  const divFigures = store.figures.filter((f) => f.taxYear === ty.label && f.kind === 'dividends_paid');
  const dividendsMinor = divLedger.minor + divGia.minor + divFigures.reduce((s, f) => s + toMinor(f.amount), 0);

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
    savings: { interest: fromMinor(interestMinor), allowance: psa, band, bandAssumed: !store.profile.taxBand, remaining: fromMinor(Math.max(0, toMinor(psa) - interestMinor)), lines: interestLines, notes: savingsNotes, incomplete: interestIncomplete },
    dividends: {
      amount: fromMinor(dividendsMinor),
      allowance: params.dividendAllowance,
      remaining: fromMinor(Math.max(0, toMinor(params.dividendAllowance) - dividendsMinor)),
      lines: [...divLedger.lines, ...divGia.lines, ...divFigures.map((f) => ({ label: `${f.payer ?? f.label} (voucher)`, amount: f.amount, source: 'figure' as const }))],
    },
    ruleNotes,
  };
}

function addYearsISO(date: string, years: number): string {
  return `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;
}
