// The digest an analysis job reads: computed figures from the app (never raw documents), with the
// ids of the records behind them so every insight can cite its evidence. Built deterministically;
// it goes only to Claude, in a job that has no web tools.

import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { CategoryIndex } from '../../shared/categories';
import { addDays, addMonths, endOfMonth, startOfMonth, today, type ISODate } from '../../shared/dates';
import { ageOn, taxYearOf } from '../../shared/uk';
import type { Analytics } from '../analytics';
import { flows } from '../analytics/cashflow';
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
  const accounts = summary.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, institution: a.institutionName ?? null, balance: a.balanceGBP, asOf: a.asOf, stale: a.stale, inEstate: a.includeInNetWorth }));
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
      taxBand: profile.taxBand ?? null,
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
      imports: importSummaries.map((i) => ({ id: i.id, file: i.fileName, sections: i.sections, added: i.result?.transactionsAdded ?? 0 })),
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
      accounts: inv.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, value: a.value, chargesRate: r2(a.charges.rate * 10_000) / 10_000, chargesPerYear: a.charges.annual, expectedReturn: a.params.expectedReturn.value, expectedReturnSource: a.params.expectedReturn.source, holdings: a.params.holdings.map((h) => ({ name: h.name, value: Math.round(h.value), fundCharge: h.fundFee.value, fundChargeSource: h.fundFee.source })) })),
      retirement: { potToday: inv.retirement.potToday, potAtRetirement: inv.retirement.pot, incomeAtRetirement: inv.retirement.income, withdrawalRate: inv.retirement.withdrawalRate.value, statePension: inv.retirement.statePension },
    },
    projection: recent?.available ? { basis: recent.basis, monthlyIncome: recent.monthly.income, monthlySpending: recent.monthly.spending, monthlyNet: recent.monthly.net, confidence: recent.confidence } : null,
    ownerContext: store.context.filter((c) => c.status === 'active').map((c) => ({ id: c.id, kind: c.kind, statement: c.statement, detail: c.detail })),
    earlierInsights: store.insights
      .filter((i) => i.status === 'active')
      .slice(-20)
      .map((i) => ({ kind: i.kind, title: i.title, createdAt: i.createdAt.slice(0, 10), feedback: i.feedback?.useful ?? null })),
    assetTypes: [...new Set(store.accounts.map((a) => ACCOUNT_TYPE_META[a.type].label))],
  };
}

export type Digest = ReturnType<typeof buildDigest>;
