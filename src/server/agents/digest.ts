// The digest an analysis job reads: computed figures from the app (never raw documents), with the
// ids of the records behind them so every insight can cite its evidence. Built deterministically;
// it goes only to Claude, in a job that has no web tools.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { CategoryIndex } from '../../shared/categories';
import { nameKey } from '../../shared/categorise';
import { cleanPayee } from '../../shared/merchants';
import { toMinor, fromMinor } from '../../shared/money';
import { addDays, addMonths, eachMonth, endOfMonth, startOfMonth, today, type ISODate } from '../../shared/dates';
import { ageOn, taxYearOf } from '../../shared/uk';
import type { Analytics } from '../analytics';
import { agreementsView } from '../analytics/agreements';
import { arrangementsInto } from '../analytics/arrangements';
import { flows } from '../analytics/cashflow';
import { companiesView } from '../analytics/companies';
import { estateOn } from '../analytics/estate';
import { owedPay, owedPayslips } from '../analytics/earned';
import { termsView } from '../analytics/terms';
import type { Store } from '../store';

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface DigestOptions {
  /** The month under review (YYYY-MM), for the monthly review. */
  month?: string;
  /** Imports just committed, for post-import insights. */
  importIds?: string[];
}

export function buildDigest(store: Store, analytics: Analytics, opts: DigestOptions = {}) {
  const now = today();
  const cats = new CategoryIndex(store.categories);
  const summary = analytics.summary({});
  const coverage = analytics.coverage();
  const profile = store.profile;
  const accounts = summary.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, institution: a.institutionName ?? null, balance: a.balanceGBP, estimated: a.estimated, asOf: a.asOf, stale: a.stale, inEstate: a.includeInNetWorth }));
  const cf = analytics.cashflow(startOfMonth(addMonths(now, -12)), now);
  const complete = new Set(coverage.completeMonths);

  // The period in focus: the month under review, or the span of the imports just committed.
  let from: ISODate;
  let to: ISODate;
  const importSummaries = (opts.importIds ?? []).map((id) => store.imports.find((i) => i.id === id)).filter((i) => i !== undefined);
  if (opts.month) {
    from = `${opts.month}-01`;
    to = endOfMonth(from);
  } else if (importSummaries.length) {
    const dates = importSummaries.flatMap((i) => i.sections.flatMap((s) => [s.from, s.to])).sort();
    from = dates[0] ?? addDays(now, -30);
    to = dates[dates.length - 1] ?? now;
  } else {
    from = addDays(now, -30);
    to = now;
  }
  const focusFlows = flows(store, from, to);
  const spendByCat = new Map<string, number>();
  for (const f of focusFlows) if (f.cls === 'spending') spendByCat.set(f.t.category ?? 'uncategorised', (spendByCat.get(f.t.category ?? 'uncategorised') ?? 0) + f.minor);
  // The three complete months before the focus period, for comparison.
  const baseFrom = startOfMonth(addMonths(from, -3));
  const baseTo = addDays(startOfMonth(from), -1);
  const baseMonths = [0, 1, 2].map((k) => startOfMonth(addMonths(from, -(k + 1))).slice(0, 7)).filter((m) => complete.has(m));
  const baseByCat = new Map<string, number>();
  for (const f of flows(store, baseFrom, baseTo)) if (f.cls === 'spending' && baseMonths.includes(f.t.date.slice(0, 7))) baseByCat.set(f.t.category ?? 'uncategorised', (baseByCat.get(f.t.category ?? 'uncategorised') ?? 0) + f.minor);
  const spending = [...new Set([...spendByCat.keys(), ...baseByCat.keys()])]
    .map((id) => ({
      category: id,
      name: id === 'uncategorised' ? 'Uncategorised' : cats.path(id),
      amount: r2((spendByCat.get(id) ?? 0) / 100),
      previousMonthlyAverage: baseMonths.length ? r2((baseByCat.get(id) ?? 0) / 100 / baseMonths.length) : null,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);
  const txView = (t: (typeof focusFlows)[number]['t']) => ({ id: t.id, date: t.date, account: t.accountId, payee: t.payee ?? null, description: t.description, amount: t.amount, category: t.category ?? null });
  const largest = focusFlows
    .filter((f) => f.cls === 'spending')
    .sort((a, b) => b.minor - a.minor)
    .slice(0, 15)
    .map((f) => txView(f.t));
  const income = focusFlows.filter((f) => f.cls === 'income').map((f) => txView(f.t));
  const recurring = analytics
    .recurring()
    .filter((r) => r.active || r.lastDate >= baseFrom)
    .slice(0, 30)
    .map((r) => ({ payee: r.payee, cadence: r.cadence, monthlyCost: r.monthlyCost, active: r.active, lastDate: r.lastDate, priceChange: r.priceChange ?? null, recentTransactionIds: r.transactionIds.slice(-3) }));
  const allow = analytics.allowances();
  const inv = analytics.investments();
  const proj = analytics.projections({ months: 120 });
  const recent = proj.scenarios.find((s) => s.id === 'recent');

  return {
    about: 'Computed by the finance app from the owner’s data. Amounts in GBP; money in positive, money out negative. Cite ids from here as evidence.',
    today: now,
    owner: {
      age: profile.dateOfBirth ? ageOn(profile.dateOfBirth, now) : null,
      taxBand: { band: allow.taxBand.band, basis: allow.taxBand.basis },
      taxRegion: profile.taxRegion,
      retirementAge: profile.retirementAge,
      grossSalary: profile.grossSalary ?? null,
    },
    estate: { value: summary.estate.value, assets: summary.estate.assets, liabilities: summary.estate.liabilities, changes: summary.deltas.map((d) => ({ label: d.label, change: d.change })) },
    accounts,
    coverage: { completeMonths: coverage.completeMonths, lastCompleteMonth: coverage.lastCompleteMonth, lastDayAllAccounts: coverage.jointTo, limitedBy: summary.coverage.limiting },
    months: cf.months.map((m) => ({ month: m.month, income: m.income, spending: m.spending, net: m.net, completeData: complete.has(m.month) })),
    focus: {
      from,
      to,
      completeData: opts.month ? complete.has(opts.month) : null,
      spendingByCategory: spending,
      largestSpending: largest,
      income,
      // Everything each import recorded: a screenshot of a value, holdings or a payslip adds no
      // transactions and is not empty for that; one recording nothing was reviewed as covered by another.
      imports: importSummaries.map((i) => ({
        id: i.id,
        file: i.fileName,
        document: i.documentType ?? null,
        sections: i.sections.map((s) => ({ accountId: s.accountId, from: s.from, to: s.to })),
        added: { transactions: i.result?.transactionsAdded ?? 0, balances: i.result?.balancesAdded ?? 0, holdings: i.result?.holdingsAdded ?? 0, figures: i.result?.figuresAdded ?? 0 },
      })),
    },
    regularPayments: recurring,
    taxYear: {
      label: allow.taxYear.label,
      daysLeft: allow.taxYear.daysLeft,
      isa: { allowance: allow.isa.allowance, used: allow.isa.used, remaining: allow.isa.remaining, cashLimit: allow.isa.cashLimit, cashUsed: allow.isa.cashUsed },
      lisa: allow.lisa ? { contributed: allow.lisa.contributed, remaining: allow.lisa.remaining, bonusExpected: allow.lisa.bonusExpected } : null,
      pension: { annualAllowance: allow.pension.annualAllowance, used: allow.pension.total, remaining: allow.pension.remaining, carryForward: allow.pension.carryForward },
      savingsInterest: { interest: allow.savings.interest, allowance: allow.savings.allowance, band: allow.savings.band },
      dividends: { amount: allow.dividends.amount, allowance: allow.dividends.allowance },
      taxYearLabel: taxYearOf(now).label,
    },
    investments: {
      totals: inv.totals,
      accounts: inv.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, value: a.value, estimated: a.estimated, paidIn: a.contributions, growth: a.growth, chargesRate: r2(a.charges.rate * 10_000) / 10_000, chargesPerYear: a.charges.annual, expectedReturn: a.params.expectedReturn.value, expectedReturnSource: a.params.expectedReturn.source, holdings: a.params.holdings.map((h) => ({ name: h.name, value: Math.round(h.value), fundCharge: h.fundFee.value, fundChargeSource: h.fundFee.source })) })),
      retirement: { potToday: inv.retirement.potToday, potAtRetirement: inv.retirement.pot, incomeAtRetirement: inv.retirement.income, withdrawalRate: inv.retirement.withdrawalRate.value, statePension: inv.retirement.statePension },
    },
    projection: recent?.available ? { basis: recent.basis, monthlyIncome: recent.monthly.income, monthlySpending: recent.monthly.spending, monthlyNet: recent.monthly.net, confidence: recent.confidence } : null,
    ...documentsDigest(store, analytics, { from, to, baseFrom, asOf: now }),
    owedPay: owedPayDigest(store, analytics),
    goals: goalsDigest(store, analytics),
    ownerContext: store.context.filter((c) => c.status === 'active').map((c) => ({ id: c.id, kind: c.kind, statement: c.statement, detail: c.detail })),
    earlierInsights: store.insights
      .filter((i) => i.status === 'active')
      .slice(-20)
      .map((i) => ({ kind: i.kind, title: i.title, createdAt: i.createdAt.slice(0, 10), feedback: i.feedback?.useful ?? null })),
    assetTypes: [...new Set(store.accounts.map((a) => ACCOUNT_TYPE_META[a.type].label))],
  };
}

export type Digest = ReturnType<typeof buildDigest>;

export interface MonthDigestOptions {
  /** The month under review (YYYY-MM). */
  month: string;
  /** Written later, as of the month's end: nothing of today, and no advice about now. */
  catchUp?: boolean;
}

/**
 * The month in review's digest (version 5, docs/AGENTS.md): the month's figures as the app works them
 * out (`focus`, the same as the Overview's month card: where the money went, spending by category
 * against typical), the 12 months up to it (`history`), the year's payees (`payeesYear`) and trips
 * (`trips`), the review of the month before in full (`previousReview`) and every earlier one in short
 * (`earlierReviews`), and what the documents say as of the month's end. Only a review of the latest
 * month also gets today's figures (`asOfToday`, labelled as such), the owner's context and the earlier
 * notes; a review written later for an earlier month knows nothing after it.
 */
export function buildMonthDigest(store: Store, analytics: Analytics, opts: MonthDigestOptions) {
  const { month } = opts;
  const now = today();
  const from = `${month}-01`;
  const to = endOfMonth(from);
  const cats = new CategoryIndex(store.categories);
  const focus = analytics.month(month);
  const context = analytics.monthContext;

  // The month's payments to cite: every payment in, the largest out, and those with people to confirm.
  const monthFlows = flows(store, from, to);
  const txView = (t: (typeof monthFlows)[number]['t']) => ({ id: t.id, date: t.date, account: t.accountId, payee: t.payee ?? null, person: context.personOf(t.id) ?? null, description: t.description, amount: t.amount, category: t.category ?? null, categorisedBy: t.categorisedBy ?? null });
  const seen = new Set<string>();
  const once = <T extends { t: { id: string } }>(list: T[]) => list.filter((f) => !seen.has(f.t.id) && seen.add(f.t.id));
  const moneyIn = once(monthFlows.filter((f) => f.cls === 'income')).map((f) => txView(f.t));
  seen.clear();
  const largestSpending = once(monthFlows.filter((f) => f.cls === 'spending' && f.minor > 0).sort((a, b) => b.minor - a.minor))
    .slice(0, 20)
    .map((f) => txView(f.t));
  seen.clear();
  const moneyBack = once(monthFlows.filter((f) => f.cls === 'spending' && f.minor < 0)).map((f) => txView(f.t));

  // The 12 months up to and including it, each as its lines (complete ones are the comparison).
  const end = addMonths(from, 0);
  const history = eachMonth(addMonths(end, -11), end).map((m) => {
    const l = context.lines(m);
    const worth = estateOn(store, analytics.engine, endOfMonth(`${m}-01`));
    const p = (v: number) => r2(v / 100);
    return {
      month: m,
      completeData: l.complete,
      income: p(l.income),
      pay: p(l.moneyIn.pay),
      otherIncome: p(l.moneyIn['other-income']),
      giftsReceived: p(l.moneyIn.gifts),
      uncategorisedIn: p(l.moneyIn['uncategorised-in']),
      borrowed: p(l.moneyIn.borrowed),
      spending: p(l.spendingTotal),
      scheduled: p(l.spending.scheduled),
      regular: p(l.spending.regular),
      oneOffs: p(l.spending['one-offs']),
      everyday: p(l.spending.everyday),
      moneyBack: p(l.spending['money-back']),
      net: p(l.net),
      worthAtEnd: worth.total,
      worthEstimated: worth.estimated,
    };
  });

  // The review of the latest month before it, as written, with what you said of it.
  const previous = store.insights
    .filter((i) => i.kind === 'month-review' && i.subject.month && i.subject.month < month && i.status !== 'superseded')
    .sort((a, b) => b.subject.month!.localeCompare(a.subject.month!) || b.createdAt.localeCompare(a.createdAt))[0];
  const previousReview = previous
    ? {
        month: previous.subject.month,
        title: previous.title,
        body: previous.body,
        watch: previous.watch ?? [],
        followUp: previous.followUp ?? [],
        status: previous.status,
        feedback: previous.feedback ? { useful: previous.feedback.useful, note: previous.feedback.note ?? null } : null,
        writtenOn: previous.createdAt.slice(0, 10),
        otherNotes: store.insights.filter((i) => i.id !== previous.id && i.provenance.jobId && i.provenance.jobId === previous.provenance.jobId).map((i) => ({ kind: i.kind, title: i.title, status: i.status })),
      }
    : null;

  // Every earlier review in short, oldest first: what each said mattered, what it raised as limits,
  // its lines to watch and how they turned out, and what you made of it.
  const earlierReviews = store.insights
    .filter((i) => i.kind === 'month-review' && i.subject.month && i.subject.month < month && i.status !== 'superseded')
    .sort((a, b) => a.subject.month!.localeCompare(b.subject.month!) || a.createdAt.localeCompare(b.createdAt))
    .map((i) => ({
      month: i.subject.month,
      title: i.title,
      keyPoints: (i.keyPoints ?? []).map((k) => k.text),
      caveats: i.caveats ?? [],
      watch: i.watch ?? [],
      followUp: (i.followUp ?? []).map((f) => ({ watch: f.watch, outcome: f.outcome })),
      feedback: i.feedback ? { useful: i.feedback.useful, note: i.feedback.note ?? null } : null,
    }));

  const baseFrom = startOfMonth(addMonths(from, -3));
  const asOfToday = opts.catchUp ? null : todayDigest(store, analytics, now, to);
  return {
    about:
      'Computed by the finance app from the owner’s data, by fixed rules (docs/FORMULAS.md §18). Amounts in GBP; money in positive, money out negative. Cite ids from here as evidence. ' +
      (opts.catchUp ? `Written later, as of the end of ${month}: it holds nothing from after that.` : `The month is ${month}; asOfToday holds today’s figures, apart from the month’s.`),
    month,
    asOf: to,
    writtenOn: now,
    mode: opts.catchUp ? 'catch-up' : 'latest',
    focus: { ...focus, transactions: { moneyIn, largestSpending, moneyBack } },
    history,
    previousReview,
    earlierReviews,
    payeesYear: payeesYear(store, cats, context, addMonths(from, -11), to, from),
    trips: trips(store, addMonths(from, -12), to),
    files: {
      'transactions.jsonl': `Every payment on every account in the 24 months to ${to}, one JSON object a line: search it with Grep (a payee, a person, a category, an amount) to check or follow up a finding.`,
    },
    categories: [...new Set(monthFlows.map((f) => f.t.category).filter((c): c is string => Boolean(c)))].map((id) => ({ id, name: cats.path(id) })),
    ...documentsDigest(store, analytics, { from, to, baseFrom, asOf: to }),
    ...(asOfToday
      ? {
          asOfToday,
          ownerContext: store.context.filter((c) => c.status === 'active').map((c) => ({ id: c.id, kind: c.kind, statement: c.statement, detail: c.detail })),
          earlierInsights: store.insights
            .filter((i) => i.status === 'active' && i.kind !== 'month-review')
            .slice(-20)
            .map((i) => ({ kind: i.kind, title: i.title, createdAt: i.createdAt.slice(0, 10), feedback: i.feedback?.useful ?? null })),
        }
      : {}),
  };
}

/** Today's figures, apart from the month's: the estate and accounts now, allowances, investments, the projection, pay owed, goals, and tax codes issued since the month. */
function todayDigest(store: Store, analytics: Analytics, now: ISODate, since: ISODate) {
  const summary = analytics.summary({});
  const allow = analytics.allowances();
  const inv = analytics.investments();
  const proj = analytics.projections({ months: 120 });
  const recent = proj.scenarios.find((s) => s.id === 'recent');
  const profile = store.profile;
  return {
    about: `As of today, ${now}: not the month's figures.`,
    owner: { age: profile.dateOfBirth ? ageOn(profile.dateOfBirth, now) : null, taxBand: { band: allow.taxBand.band, basis: allow.taxBand.basis }, taxRegion: profile.taxRegion, retirementAge: profile.retirementAge, grossSalary: profile.grossSalary ?? null },
    estate: { value: summary.estate.value, assets: summary.estate.assets, liabilities: summary.estate.liabilities },
    accounts: summary.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balanceGBP, estimated: a.estimated, asOf: a.asOf, stale: a.stale, inEstate: a.includeInNetWorth })),
    taxYear: {
      label: allow.taxYear.label,
      daysLeft: allow.taxYear.daysLeft,
      isa: { allowance: allow.isa.allowance, used: allow.isa.used, remaining: allow.isa.remaining },
      lisa: allow.lisa ? { contributed: allow.lisa.contributed, remaining: allow.lisa.remaining, bonusExpected: allow.lisa.bonusExpected } : null,
      pension: { annualAllowance: allow.pension.annualAllowance, used: allow.pension.total, remaining: allow.pension.remaining },
      savingsInterest: { interest: allow.savings.interest, allowance: allow.savings.allowance },
      dividends: { amount: allow.dividends.amount, allowance: allow.dividends.allowance },
    },
    investments: { totals: inv.totals, retirement: { potToday: inv.retirement.potToday, potAtRetirement: inv.retirement.pot, incomeAtRetirement: inv.retirement.income } },
    projection: recent?.available ? { basis: recent.basis, monthlyIncome: recent.monthly.income, monthlySpending: recent.monthly.spending, monthlyNet: recent.monthly.net, confidence: recent.confidence } : null,
    owedPay: owedPayDigest(store, analytics),
    goals: goalsDigest(store, analytics),
    taxCodesSince: store.hmrc.flatMap((r) => (r.type === 'tax-code' && r.date > since ? [{ id: r.id, employmentId: r.employmentId ?? null, employer: r.employer ?? null, date: r.date, code: r.code, cumulative: r.cumulative, taxYear: r.taxYear }] : [])),
  };
}

/** Pay owed now (earned, not yet paid), as of today. */
function owedPayDigest(store: Store, analytics: Analytics) {
  const owed = owedPay(analytics.earned(), owedPayslips(store));
  return owed ? { gross: owed.gross, net: owed.net, next: owed.next, late: owed.late, items: owed.items.map((i) => ({ payroll: i.payroll, gross: i.gross, net: i.net, payDate: i.payDate, status: i.status })) } : null;
}

/** Goals and how they stand today, when there are any. */
function goalsDigest(store: Store, analytics: Analytics) {
  const goalView = store.goals.length ? analytics.goals() : null;
  return goalView ? goalView.goals.map((g) => ({ id: g.id, name: g.name, kind: g.kind, target: g.target, targetDate: g.targetDate, current: g.current, monthly: g.monthly, status: g.status, neededMonthly: g.neededMonthly })) : null;
}

/**
 * What the owner's documents say beyond transactions and balances, as the app has computed and
 * checked it: pay against the bank and HMRC, HMRC's records, each account's terms, agreements to
 * pay, pension arrangements, companies, and budgets when there are any. Months of pay from the
 * three before the focus period to its end. Identifiers the analysis does not need (PAYE references,
 * payroll numbers) are left out.
 *
 * As of `asOf`: records dated after it are left out, statuses are as they stood then, and a payment
 * paired after it was not paid by then. Looking back on a month, nothing later leaks in.
 */
function documentsDigest(store: Store, analytics: Analytics, p: { from: ISODate; to: ISODate; baseFrom: ISODate; asOf: ISODate }) {
  const year = taxYearOf(p.to);
  const lastYear = taxYearOf(addDays(year.start, -1)).label;
  const within = (d: string | null | undefined, from: ISODate, to: ISODate) => d !== null && d !== undefined && d >= from && d <= to;

  const payView = analytics.pay(year.label);
  // Each job as it stood on `asOf`: started by then, its codes issued by then, its pay found by then,
  // and its year so far added up to then.
  const sum = (list: (number | null)[]) => (list.some((v) => v !== null) ? r2(list.reduce<number>((t, v) => t + (v ?? 0), 0)) : null);
  const pay = {
    taxYear: year.label,
    about: 'Each pay period: its payslip, the payment into your bank matched to it, and what HMRC says the employer reported. inFocus marks those paid in the focus period; the rest are the months before, for comparison.',
    employers: payView.employers
      .filter((e) => !e.startedOn || e.startedOn <= p.asOf)
      .map((e) => {
        const known = e.months.filter((m) => (m.payDate ?? m.periodEnd ?? '') <= p.asOf);
        return {
          employmentId: e.employmentId ?? null,
          payer: e.payer,
          startedOn: e.startedOn ?? null,
          endedOn: e.endedOn && e.endedOn <= p.asOf ? e.endedOn : null,
          taxCodesIssued: (e.codes ?? []).filter((c) => c.date <= p.asOf).slice(-3),
          months: known
            .filter((m) => within(m.payDate ?? m.periodEnd, p.baseFrom, p.to))
            .map((m) => {
              // Pay that arrived after the day it is seen from had not arrived by then.
              const late = m.paidIn !== null && m.paidIn.date > p.asOf;
              return {
                periodEnd: m.periodEnd,
                payDate: m.payDate,
                inFocus: within(m.payDate ?? m.periodEnd, p.from, p.to),
                gross: m.gross,
                tax: m.tax,
                ni: m.ni,
                pension: m.pension,
                studentLoan: m.studentLoan,
                expectedNet: m.expectedNet,
                taxCode: m.taxCode ?? null,
                status: late ? 'not paid by then' : m.status,
                note: late ? null : (m.note ?? null),
                payslipId: m.payslipId ?? null,
                paidIn: m.paidIn && !late ? { amount: m.paidIn.amount, date: m.paidIn.date, transactionId: m.paidIn.transactionId } : null,
                otherDeductions: late ? null : m.otherDeductions,
                hmrcReported: m.hmrc ? { taxablePay: m.hmrc.taxablePay, tax: m.hmrc.tax, recordId: m.hmrc.recordId } : null,
                taxCodeCheck: m.check?.note ?? null,
                owed: !late && m.owed !== undefined,
              };
            }),
          missingPayslips: (e.gaps ?? []).filter((g) => g.before <= p.asOf),
          yearToDate: { gross: sum(known.map((m) => m.gross)), tax: sum(known.map((m) => m.tax)), ni: sum(known.map((m) => m.ni)), pension: sum(known.map((m) => m.pension)), studentLoan: sum(known.map((m) => m.studentLoan)), paidIn: r2(known.reduce((t, m) => t + (m.paidIn && m.paidIn.date <= p.asOf ? m.paidIn.amount : 0), 0)) },
          yearDocument: e.document && e.document.asOf <= p.asOf ? { title: e.document.title, final: e.document.final, asOf: e.document.asOf, gross: e.document.gross, tax: e.document.tax, note: e.document.note } : null,
        };
      })
      .filter((e) => e.months.length > 0 || e.endedOn === null),
    notes: payView.notes,
  };
  const hmrcOf = <T extends (typeof store.hmrc)[number]['type']>(type: T) => store.hmrc.filter((r): r is Extract<(typeof store.hmrc)[number], { type: T }> => r.type === type);
  const latestForecast = hmrcOf('state-pension-forecast')
    .filter((r) => r.asOf <= p.asOf)
    .sort((a, b) => a.asOf.localeCompare(b.asOf))
    .at(-1);
  const niYears = hmrcOf('ni-year').filter((r) => r.asOf <= p.asOf);
  const hmrc = {
    taxCodes: hmrcOf('tax-code')
      .filter((r) => (r.taxYear === year.label || r.taxYear === lastYear) && r.date <= p.asOf)
      .map((r) => ({ id: r.id, employmentId: r.employmentId ?? null, employer: r.employer ?? null, date: r.date, code: r.code, cumulative: r.cumulative, taxYear: r.taxYear })),
    settlements: hmrcOf('settlement')
      .filter((r) => r.asOf <= p.asOf)
      .map((r) => ({ id: r.id, taxYear: r.taxYear, asOf: r.asOf, outcome: r.outcome, amount: r.amount ?? null, outstanding: r.outstanding })),
    events: hmrcOf('event')
      .filter((r) => r.date >= addDays(p.to, -365) && r.date <= p.asOf)
      .map((r) => ({ id: r.id, employer: r.employer ?? null, date: r.date, event: r.event, text: r.text, amount: r.amount ?? null })),
    niYears: {
      full: niYears.filter((r) => r.status === 'full').length,
      notFull: niYears.filter((r) => r.status === 'not-full').map((r) => ({ id: r.id, taxYear: r.taxYear, asOf: r.asOf, voluntaryCost: r.voluntaryCost ?? null, payBy: r.payBy ?? null })),
    },
    statePensionForecast: latestForecast
      ? { id: latestForecast.id, asOf: latestForecast.asOf, weekly: latestForecast.weekly, annual: latestForecast.annual, payableFrom: latestForecast.payableFrom ?? null, qualifyingYears: latestForecast.qualifyingYears ?? null, yearsNeeded: latestForecast.yearsNeeded ?? null }
      : null,
  };

  // Rates, limits and minimum payments as each account's latest documents give them; rates that end within 60 days (or have ended).
  const terms = store.accounts
    .filter((a) => a.status === 'open' && store.terms(a.id).length > 0)
    .map((a) => {
      const v = termsView(store, a.id, p.asOf);
      return {
        accountId: a.id,
        rates: v.rates ? { asOf: v.rates.asOf, rates: v.rates.rates } : null,
        limit: v.limit ? { asOf: v.limit.asOf, value: v.limit.value } : null,
        minimumPayment: v.minimum ? { asOf: v.minimum.asOf, amount: v.minimum.amount, due: v.minimum.due ?? null } : null,
        endingSoon: v.ending.map((e) => ({ rate: e.rate, daysLeft: e.days })),
      };
    })
    .filter((t) => t.rates || t.limit || t.minimumPayment);

  // Agreements known by then (agreed by then, or with a payment due within 60 days), as they stood.
  const agreements = agreementsView(store, p.asOf)
    .filter((v) => (!v.agreement.until || v.agreement.until >= p.baseFrom) && (v.agreement.agreedOn ? v.agreement.agreedOn <= p.asOf : v.agreement.payments.some((x) => x.due <= addDays(p.asOf, 60))))
    .map((v) => ({
      id: v.agreement.id,
      name: v.agreement.name,
      counterparty: v.agreement.counterparty,
      direction: v.agreement.direction ?? 'out',
      paidBy: v.agreement.paidBy ?? null,
      accountId: v.agreement.accountId ?? null,
      category: v.agreement.category,
      from: v.agreement.from,
      until: v.agreement.until ?? null,
      total: v.agreement.total ?? null,
      paidSoFar: v.paid,
      payments: v.payments
        .filter((x) => within(x.due, p.baseFrom, addDays(p.to, 60)))
        .map((x) => {
          // Paid after the day it is seen from: not paid by then.
          const later = x.paid && x.paid.date > p.asOf;
          const status = later ? (x.due > p.asOf ? 'upcoming' : 'not paid by then') : x.status;
          return { due: x.due, amount: x.amount, label: x.label ?? null, status, paid: x.paid && !later ? { transactionId: x.paid.transactionId, date: x.paid.date, amount: x.paid.amount, difference: x.paid.difference ?? null } : null };
        }),
      otherPayments: v.others.length,
    }));

  const pensionAccounts = [...new Set(store.employments.flatMap((e) => e.pensionArrangements.map((a) => a.accountId)))];
  const pensionArrangements = pensionAccounts.flatMap((accountId) =>
    arrangementsInto(store, accountId, p.asOf).arrangements.filter((a) => a.arrangement.from <= p.asOf).map((a) => ({
      accountId,
      employmentId: a.employmentId,
      employer: a.employer,
      kind: a.arrangement.kind,
      amount: a.arrangement.amount,
      from: a.arrangement.from,
      until: a.arrangement.until ?? null,
      arrived: a.arrived ?? null,
      lastCollected: a.collected?.at(-1) ?? null,
      // A monthly one whose first collection was not found within two months of its form: none has come.
      firstCollectionSeen: a.firstSeen ?? null,
      missingMonths: a.missing ?? [],
    })),
  );

  const companies = companiesView(store).map((c) => ({
    id: c.company.id,
    name: c.company.name,
    accountId: c.company.accountId ?? null,
    // Its valuation then: the latest made by that day.
    valuation: (() => {
      const v = c.company.valuations.filter((x) => x.asOf <= p.asOf).sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1);
      return v ? { asOf: v.asOf, method: v.method, value: v.value } : null;
    })(),
    dividends: c.dividends.filter((d) => (d.taxYear === year.label || d.taxYear === lastYear) && d.date <= p.asOf).map((d) => ({ date: d.date, amount: d.amount, taxYear: d.taxYear ?? null, transactionId: d.paidIn?.transactionId ?? null })),
  }));

  const month = p.to.slice(0, 7);
  const budgetView = store.budgets.length ? analytics.budgets(month) : null;
  return {
    pay,
    hmrc,
    terms,
    agreements,
    pensionArrangements,
    companies,
    budgets: budgetView ? { month: budgetView.month, complete: budgetView.complete, lines: budgetView.lines.map((l) => ({ name: l.name, scope: l.scope, monthly: l.monthly, spent: l.spent, left: l.left, status: l.status })) } : null,
  };
}

/** A year's payees, the most spent first: who the money went to, how often and in how many months (digest v5). */
function payeesYear(store: Store, cats: CategoryIndex, context: Analytics['monthContext'], from: ISODate, to: ISODate, focusFrom: ISODate) {
  const by = new Map<string, { payee: string; person: boolean; minor: number; count: number; months: Set<string>; focus: number; categories: Map<string, number>; last: string }>();
  for (const f of flows(store, from, to)) {
    if (f.cls !== 'spending' || cats.kindOf(f.t.category) === 'income') continue;
    const person = context.personOf(f.t.id);
    const name = person ?? f.t.payee ?? cleanPayee(f.t.description);
    const key = nameKey(name);
    if (!key) continue;
    const e = by.get(key) ?? by.set(key, { payee: name, person: Boolean(person), minor: 0, count: 0, months: new Set(), focus: 0, categories: new Map(), last: '' }).get(key)!;
    e.minor += f.minor;
    e.count++;
    e.months.add(f.t.date.slice(0, 7));
    if (f.t.date >= focusFrom) e.focus += f.minor;
    if (f.t.category) e.categories.set(f.t.category, (e.categories.get(f.t.category) ?? 0) + 1);
    if (f.t.date > e.last) e.last = f.t.date;
  }
  return [...by.values()]
    .filter((e) => e.minor > 0)
    .sort((a, b) => b.minor - a.minor)
    .slice(0, 40)
    .map((e) => ({
      payee: e.payee,
      ...(e.person ? { person: true } : {}),
      category: [...e.categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      total: fromMinor(e.minor),
      count: e.count,
      months: e.months.size,
      thisMonth: fromMinor(e.focus),
      lastPaid: e.last,
    }));
}

/** Days a trip's holiday spending may pause and still be one trip. */
const TRIP_GAP_DAYS = 6;

/** Trips: spending filed as holidays, in runs with no gap longer than a few days, with where it went (digest v5). */
function trips(store: Store, from: ISODate, to: ISODate) {
  const rows = flows(store, from, to)
    .filter((f) => f.cls === 'spending' && f.t.category === 'holidays')
    .sort((a, b) => a.t.date.localeCompare(b.t.date));
  const out: { from: string; to: string; spent: number; payments: number; months: string[]; payees: string[] }[] = [];
  let run: typeof rows = [];
  const close = () => {
    if (!run.length) return;
    const by = new Map<string, number>();
    for (const f of run) {
      const p = f.t.payee ?? cleanPayee(f.t.description);
      by.set(p, (by.get(p) ?? 0) + f.minor);
    }
    out.push({
      from: run[0]!.t.date,
      to: run[run.length - 1]!.t.date,
      spent: fromMinor(run.reduce((s, f) => s + f.minor, 0)),
      payments: run.length,
      months: [...new Set(run.map((f) => f.t.date.slice(0, 7)))],
      payees: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p),
    });
    run = [];
  };
  for (const f of rows) {
    if (run.length && addDays(run[run.length - 1]!.t.date, TRIP_GAP_DAYS) < f.t.date) close();
    run.push(f);
  }
  close();
  return out.filter((t) => t.payments >= 2 || toMinor(t.spent) >= 10_000);
}

/**
 * The month in review's file of payments (transactions.jsonl): every row on every account in the 24
 * months to the month's end, one JSON object a line, for the review to search (docs/AGENTS.md).
 */
export function monthTransactionsFile(store: Store, analytics: Analytics, month: string): string {
  const to = endOfMonth(`${month}-01`);
  const from = startOfMonth(addMonths(`${month}-01`, -23));
  const context = analytics.monthContext;
  const lines: string[] = [];
  for (const t of store.transactions()) {
    if (t.date < from || t.date > to) continue;
    lines.push(
      JSON.stringify({
        id: t.id,
        date: t.date,
        account: t.accountId,
        payee: t.payee ?? null,
        person: context.personOf(t.id) ?? null,
        description: t.description,
        amount: t.amount,
        category: t.category ?? null,
        categorisedBy: t.categorisedBy ?? null,
        ...(t.counterpartyAccountId ? { otherAccount: t.counterpartyAccountId } : {}),
        ...(t.notes ? { note: t.notes } : {}),
      }),
    );
  }
  return lines.sort().join('\n') + '\n';
}
