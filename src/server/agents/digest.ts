// The digest an analysis job reads: computed figures from the app (never raw documents), with the
// ids of the records behind them so every insight can cite its evidence. Built deterministically;
// it goes only to Claude, in a job that has no web tools.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { CategoryIndex } from '../../shared/categories';
import { addDays, addMonths, endOfMonth, startOfMonth, today, type ISODate } from '../../shared/dates';
import { ageOn, taxYearOf } from '../../shared/uk';
import type { Analytics } from '../analytics';
import { agreementsView } from '../analytics/agreements';
import { arrangementsInto } from '../analytics/arrangements';
import { flows } from '../analytics/cashflow';
import { companiesView } from '../analytics/companies';
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
    ...documentsDigest(store, analytics, { from, to, baseFrom, now }),
    ownerContext: store.context.filter((c) => c.status === 'active').map((c) => ({ id: c.id, kind: c.kind, statement: c.statement, detail: c.detail })),
    earlierInsights: store.insights
      .filter((i) => i.status === 'active')
      .slice(-20)
      .map((i) => ({ kind: i.kind, title: i.title, createdAt: i.createdAt.slice(0, 10), feedback: i.feedback?.useful ?? null })),
    assetTypes: [...new Set(store.accounts.map((a) => ACCOUNT_TYPE_META[a.type].label))],
  };
}

export type Digest = ReturnType<typeof buildDigest>;

/**
 * What the owner's documents say beyond transactions and balances, as the app has computed and
 * checked it: pay against the bank and HMRC, HMRC's records, each account's terms, agreements to
 * pay, pension arrangements, companies, and budgets and goals when there are any. Months of pay
 * from the three before the focus period to its end. Identifiers the analysis does not need (PAYE
 * references, payroll numbers) are left out.
 */
function documentsDigest(store: Store, analytics: Analytics, p: { from: ISODate; to: ISODate; baseFrom: ISODate; now: ISODate }) {
  const year = taxYearOf(p.to);
  const lastYear = taxYearOf(addDays(year.start, -1)).label;
  const within = (d: string | null | undefined, from: ISODate, to: ISODate) => d !== null && d !== undefined && d >= from && d <= to;

  const payView = analytics.pay(year.label);
  const pay = {
    taxYear: year.label,
    about: 'Each pay period: its payslip, the payment into your bank matched to it, and what HMRC says the employer reported. inFocus marks those paid in the focus period; the rest are the months before, for comparison.',
    employers: payView.employers
      .map((e) => ({
        employmentId: e.employmentId ?? null,
        payer: e.payer,
        startedOn: e.startedOn ?? null,
        endedOn: e.endedOn ?? null,
        taxCodesIssued: (e.codes ?? []).slice(-3),
        months: e.months
          .filter((m) => within(m.payDate ?? m.periodEnd, p.baseFrom, p.to))
          .map((m) => ({
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
            status: m.status,
            note: m.note ?? null,
            payslipId: m.payslipId ?? null,
            paidIn: m.paidIn ? { amount: m.paidIn.amount, date: m.paidIn.date, transactionId: m.paidIn.transactionId } : null,
            otherDeductions: m.otherDeductions,
            hmrcReported: m.hmrc ? { taxablePay: m.hmrc.taxablePay, tax: m.hmrc.tax, recordId: m.hmrc.recordId } : null,
            taxCodeCheck: m.check?.note ?? null,
            owed: m.owed !== undefined,
          })),
        missingPayslips: e.gaps ?? [],
        yearToDate: e.totals,
        yearDocument: e.document ? { title: e.document.title, final: e.document.final, asOf: e.document.asOf, gross: e.document.gross, tax: e.document.tax, note: e.document.note } : null,
      }))
      .filter((e) => e.months.length > 0 || e.endedOn === null),
    notes: payView.notes,
  };
  const owed = owedPay(analytics.earned(), owedPayslips(store));

  const hmrcOf = <T extends (typeof store.hmrc)[number]['type']>(type: T) => store.hmrc.filter((r): r is Extract<(typeof store.hmrc)[number], { type: T }> => r.type === type);
  const latestForecast = hmrcOf('state-pension-forecast').sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1);
  const niYears = hmrcOf('ni-year');
  const hmrc = {
    taxCodes: hmrcOf('tax-code')
      .filter((r) => r.taxYear === year.label || r.taxYear === lastYear)
      .map((r) => ({ id: r.id, employmentId: r.employmentId ?? null, employer: r.employer ?? null, date: r.date, code: r.code, cumulative: r.cumulative, taxYear: r.taxYear })),
    settlements: hmrcOf('settlement').map((r) => ({ id: r.id, taxYear: r.taxYear, asOf: r.asOf, outcome: r.outcome, amount: r.amount ?? null, outstanding: r.outstanding })),
    events: hmrcOf('event')
      .filter((r) => r.date >= addDays(p.to, -365))
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
      const v = termsView(store, a.id, p.now);
      return {
        accountId: a.id,
        rates: v.rates ? { asOf: v.rates.asOf, rates: v.rates.rates } : null,
        limit: v.limit ? { asOf: v.limit.asOf, value: v.limit.value } : null,
        minimumPayment: v.minimum ? { asOf: v.minimum.asOf, amount: v.minimum.amount, due: v.minimum.due ?? null } : null,
        endingSoon: v.ending.map((e) => ({ rate: e.rate, daysLeft: e.days })),
      };
    });

  const agreements = agreementsView(store, p.now)
    .filter((v) => !v.agreement.until || v.agreement.until >= p.baseFrom)
    .map((v) => ({
      id: v.agreement.id,
      name: v.agreement.name,
      counterparty: v.agreement.counterparty,
      category: v.agreement.category,
      from: v.agreement.from,
      until: v.agreement.until ?? null,
      total: v.agreement.total ?? null,
      paidSoFar: v.paid,
      payments: v.payments
        .filter((x) => within(x.due, p.baseFrom, addDays(p.to, 60)))
        .map((x) => ({ due: x.due, amount: x.amount, label: x.label ?? null, status: x.status, paid: x.paid ? { transactionId: x.paid.transactionId, date: x.paid.date, amount: x.paid.amount, difference: x.paid.difference ?? null } : null })),
      otherPayments: v.others.length,
    }));

  const pensionAccounts = [...new Set(store.employments.flatMap((e) => e.pensionArrangements.map((a) => a.accountId)))];
  const pensionArrangements = pensionAccounts.flatMap((accountId) =>
    arrangementsInto(store, accountId, p.now).arrangements.map((a) => ({
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
    value: c.value ?? null,
    valuation: c.valuation ? { asOf: c.valuation.asOf, method: c.valuation.method, value: c.valuation.value } : null,
    dividends: c.dividends.filter((d) => d.taxYear === year.label || d.taxYear === lastYear).map((d) => ({ date: d.date, amount: d.amount, taxYear: d.taxYear ?? null, transactionId: d.paidIn?.transactionId ?? null })),
    dividendsTotal: c.dividendsTotal,
  }));

  const month = p.to.slice(0, 7);
  const budgetView = store.budgets.length ? analytics.budgets(month) : null;
  const goalView = store.goals.length ? analytics.goals() : null;
  return {
    pay,
    owedPay: owed ? { gross: owed.gross, net: owed.net, next: owed.next, late: owed.late, items: owed.items.map((i) => ({ payroll: i.payroll, gross: i.gross, net: i.net, payDate: i.payDate, status: i.status })) } : null,
    hmrc,
    terms,
    agreements,
    pensionArrangements,
    companies,
    budgets: budgetView ? { month: budgetView.month, complete: budgetView.complete, lines: budgetView.lines.map((l) => ({ name: l.name, scope: l.scope, monthly: l.monthly, spent: l.spent, left: l.left, status: l.status })) } : null,
    goals: goalView ? goalView.goals.map((g) => ({ id: g.id, name: g.name, kind: g.kind, target: g.target, targetDate: g.targetDate, current: g.current, monthly: g.monthly, status: g.status, neededMonthly: g.neededMonthly })) : null,
  };
}
