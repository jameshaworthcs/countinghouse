// Response shapes of the HTTP API, shared by the server and the web app.

import type { AccessGroup, WrapperGroup } from './accounts';
import type {
  Account,
  BalanceSnapshot,
  Category,
  CsvProfile,
  Figure,
  Goal,
  HoldingsSnapshot,
  ImportRecord,
  Institution,
  Profile,
  Rule,
  Settings,
  Transaction,
} from './schema';

export interface Alert {
  id: string;
  level: 'info' | 'warning' | 'critical';
  title: string;
  detail?: string;
  action?: { label: string; href: string };
}

export interface AccountSummary {
  id: string;
  name: string;
  type: Account['type'];
  typeLabel: string;
  institutionId?: string;
  institutionName?: string;
  group: WrapperGroup;
  access: AccessGroup;
  currency: string;
  liability: boolean;
  status: 'open' | 'closed';
  includeInNetWorth: boolean;
  balance: number | null;
  balanceGBP: number | null;
  estimated: boolean;
  /** Newest date with any data. */
  asOf: string | null;
  staleDays: number | null;
  stale: boolean;
  /** DB / State Pension forecast income per year, from the latest snapshot. */
  annualIncome: number | null;
  lastSnapshot: string | null;
  lastTransaction: string | null;
  transactionCount: number;
  /** Balance at the last 13 month-ends, oldest first (GBP). */
  sparkline: (number | null)[];
}

export interface SummaryResponse {
  asOf: string;
  estate: { value: number; assets: number; liabilities: number };
  deltas: { id: string; label: string; since: string; change: number | null; pct: number | null }[];
  groups: { id: WrapperGroup; label: string; value: number }[];
  access: { id: AccessGroup; label: string; value: number }[];
  accounts: AccountSummary[];
  alerts: Alert[];
  imports: Record<string, number>;
  taxYear: { label: string; daysLeft: number; start: string; end: string };
  hasData: boolean;
  /** From the last 3 full months (or the days so far, after a first import), counting covered time only. */
  kpis: {
    savingsRate: number | null;
    monthlySaving: number | null;
    monthlySpending: number | null;
    runwayMonths: number | null;
    confidence: 'high' | 'medium' | 'low';
    basis: string;
  };
  /** Spending this month so far; `previous` is the same days last month, null when those days lack data. */
  monthToDate: { spending: number; previous: number | null; previousFrom: string; previousTo: string };
  coverage: { lastCompleteMonth: string | null; jointTo: string | null; limiting: { accountId: string; name: string; missingDays: number }[] };
}

export interface EstateSeriesResponse {
  grouping: 'wrapper' | 'access';
  dates: string[];
  total: number[];
  assets: number[];
  liabilities: number[];
  groups: { id: string; label: string; values: number[] }[];
  /** Dates where at least one included account's value was estimated. */
  estimated: boolean[];
  /** From this date every included account has data; before it the total is incomplete. */
  completeFrom: string | null;
}

export interface CategoryAmount {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  kind: string;
  amount: number;
  count: number;
  share: number;
  previous?: number;
  change?: number | null;
}

export interface CashflowMonth {
  month: string;
  income: number;
  spending: number;
  net: number;
  savingsRate: number | null;
  /** Share of the month's days (within the period) that every account has data for. */
  covered: number;
}

export interface CashflowResponse {
  from: string;
  to: string;
  months: CashflowMonth[];
  totals: { income: number; spending: number; net: number; savingsRate: number | null };
  categories: CategoryAmount[];
  groups: CategoryAmount[];
}

/** A computed signal: a deterministic observation from a named rule (never an inference). */
export interface Signal {
  id: string;
  tone: 'good' | 'neutral' | 'warning';
  title: string;
  detail: string;
  /** The rule that produced it, in plain words. */
  rule: string;
}

export interface RecurringItem {
  key: string;
  payee: string;
  category?: string;
  categoryName: string;
  cadence: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annual';
  typicalAmount: number;
  monthlyCost: number;
  annualCost: number;
  count: number;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  active: boolean;
  accountId: string;
  priceChange?: { from: number; to: number; date: string };
  transactionIds: string[];
}

export interface SpendingResponse {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  total: number;
  previousTotal: number;
  dailyAverage: number;
  /** Days in the period (and the previous one) on which every account has data. */
  coverage: { days: number; totalDays: number; previousDays: number; limiting: { accountId: string; name: string; missingDays: number }[] };
  categories: CategoryAmount[];
  groups: CategoryAmount[];
  heatmap: { months: string[]; rows: { id: string; name: string; values: number[]; total: number }[] };
  merchants: { payee: string; category?: string; categoryName: string; amount: number; count: number; average: number; lastDate: string }[];
  weekday: { day: number; label: string; total: number; average: number; count: number }[];
  hours: { hour: number; total: number; count: number }[] | null;
  largest: Transaction[];
  small: { threshold: number; count: number; total: number };
  signals: Signal[];
  recurring: RecurringItem[];
}

/** A modelling value and where it came from (see src/server/analytics/params.ts). */
export interface SourcedValue {
  value: number;
  range?: { low: number; high: number } | undefined;
  source: 'owner' | 'agent' | 'research' | 'statement' | 'account' | 'fallback';
  basis: string;
  recordId?: string | undefined;
  asOf?: string | undefined;
  stale?: boolean | undefined;
}

export interface Band {
  p10: number;
  p50: number;
  p90: number;
}

export interface CoverageResponse {
  months: string[];
  accounts: {
    accountId: string;
    name: string;
    source: 'imports' | 'transactions' | 'none';
    from: string | null;
    to: string | null;
    months: { month: string; fraction: number }[];
  }[];
  /** Months in which every account has data (≥ 90% of days). */
  completeMonths: string[];
  lastCompleteMonth: string | null;
  /** The last day on which every account has data. */
  jointTo: string | null;
}

export interface BaselineSummary {
  from: string;
  to: string;
  available: boolean;
  reason?: string | undefined;
  confidence: 'high' | 'medium' | 'low';
  basis: { kind: 'months' | 'days'; months: string[]; days: number; limiting: { accountId: string; name: string; missingDays: number }[] };
  monthly: { income: number; spending: number; net: number; investing: number; external: number };
  netSd: number;
  netSdBasis: string;
  wrappers: { accountId: string; name: string; personal: number; external: number; notes: string[] }[];
}

export interface ProjectionScenario extends BaselineSummary {
  id: string;
  label: string;
}

export interface ProjectionPoint {
  date: string;
  month: number;
  cash: number;
  market: number;
  pension: number;
  property: number;
  debt: number;
  total: number;
  band: Band;
}

export interface HoldingParamsSummary {
  name: string;
  instrumentId?: string | undefined;
  value: number;
  exposureBasis: string;
  expectedReturn: SourcedValue;
  volatility: SourcedValue;
  fundFee: SourcedValue;
}

export interface AccountParamsSummary {
  id: string;
  name: string;
  type: Account['type'];
  bucket: 'cash' | 'market' | 'pension' | 'property' | 'debt' | 'income';
  value: number;
  holdingsKnown: boolean;
  holdingsAsOf?: string | undefined;
  holdings: HoldingParamsSummary[];
  expectedReturn: SourcedValue;
  volatility: SourcedValue;
  fundFee: SourcedValue;
  platformFee: SourcedValue;
  platformFixed: SourcedValue;
  interest?: SourcedValue | undefined;
  growth?: SourcedValue | undefined;
  /** Median growth a year after charges (market and pension accounts). */
  netGrowth?: number | undefined;
  /** Charges this year, in pounds, at today's value. */
  annualCharges?: number | undefined;
}

export interface AssumptionInUse {
  key: string;
  label: string;
  unit: 'rate' | 'gbpPerYear' | 'ratio';
  value: number;
  range?: { low: number; high: number } | undefined;
  source: 'owner' | 'agent' | 'fallback';
  basis: string;
  recordId?: string | undefined;
  asOf?: string | undefined;
  stale?: boolean | undefined;
}

export interface ProjectionResponse {
  startDate: string;
  months: number;
  /** "real": today's money (deflated by the inflation assumption); "nominal": future pounds. */
  units: 'real' | 'nominal';
  spendingAdjustment: number;
  start: { cash: number; market: number; pension: number; property: number; debt: number; total: number };
  scenarios: ProjectionScenario[];
  history: { date: string; value: number }[];
  series: { id: string; label: string; points: ProjectionPoint[] }[];
  /** The global assumptions the projection used. */
  assumptions: AssumptionInUse[];
  /** Each account's parameters. */
  accounts: AccountParamsSummary[];
  /** The market and pension accounts as one portfolio. */
  pool: { value: number; mu: number; muRange?: { low: number; high: number } | undefined; sigma: number; fee: number };
  categories: { id: string; name: string; recentAnnual: number; lastYear: number }[];
  runwayMonths: number | null;
  retirement: { date: string; age: number } | null;
  notes: string[];
}

export interface AllowanceLine {
  accountId?: string;
  label: string;
  amount: number;
  date?: string;
  source: 'transactions' | 'provider' | 'figure' | 'estimate';
  transactionIds?: string[];
}

export interface AllowancesResponse {
  taxYear: { label: string; start: string; end: string; daysLeft: number | null; current: boolean };
  /**
   * `incomplete` (here and below): which accounts' data does not cover the tax year, so the amount
   * used is a minimum and what is left a maximum. Null when the year is covered.
   */
  isa: { allowance: number; used: number; remaining: number; cashLimit: number; cashUsed: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null };
  lisa: { allowance: number; contributed: number; remaining: number; bonusReceived: number; bonusExpected: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null } | null;
  pension: {
    annualAllowance: number;
    personal: number;
    personalGross: number;
    employer: number;
    relief: number;
    total: number;
    remaining: number;
    /** Unused allowance from earlier years; null when contributions for that year are not fully known. */
    carryForward: { taxYear: string; unused: number | null; basis: string }[];
    lines: AllowanceLine[];
    notes: string[];
    incomplete: string | null;
  };
  savings: { interest: number; allowance: number; band: string; remaining: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null };
  dividends: { amount: number; allowance: number; remaining: number; lines: AllowanceLine[] };
  ruleNotes: string[];
}

export interface SaSource {
  type: 'figure' | 'transaction' | 'account';
  id: string;
  date?: string;
  label: string;
  amount?: number;
}

export interface SaItem {
  id: string;
  label: string;
  /** Where it goes on the return, e.g. "SA100 page TR 3 — Untaxed UK interest". Check the form. */
  where: string;
  amount: number | null;
  status: 'ready' | 'check' | 'missing' | 'not-applicable';
  basis: string;
  notes: string[];
  sources: SaSource[];
}

export interface SaSection {
  id: string;
  title: string;
  description: string;
  items: SaItem[];
}

export interface SelfAssessmentResponse {
  taxYear: { label: string; start: string; end: string; filingDeadline: string; paymentDeadline: string };
  disclaimer: string;
  sections: SaSection[];
  checklist: { id: string; done: boolean; label: string; detail?: string }[];
  mayNeedToFile: { reason: string; detail: string }[];
}

export interface InvestmentAccountSummary {
  id: string;
  name: string;
  type: Account['type'];
  typeLabel: string;
  value: number | null;
  asOf: string | null;
  contributions: number | null;
  contributionsSource: 'provider' | 'transactions' | null;
  growth: number | null;
  growthPct: number | null;
  xirr: number | null;
  history: { date: string; value: number; contributions: number | null }[];
  holdings: HoldingsSnapshot | null;
  params: AccountParamsSummary;
  /** Charges in pounds: this year, and their cost by retirement (or over 10 years). */
  charges: { annual: number; drag: number; horizonYears: number; rate: number };
  lisa?: { bonusToDate: number | null; penaltyAdjustedValue: number | null; penaltyFreeFrom: string | null };
  pension?: { accessDate: string | null };
}

export interface InvestmentsResponse {
  totals: { value: number; contributions: number; growth: number; pensions: number; isas: number; annualCharges: number };
  accounts: InvestmentAccountSummary[];
  allocation: { assetClass: string; value: number; share: number }[];
  retirement: {
    age: number;
    date: string | null;
    potToday: number;
    /** Monthly into pensions: from your cash, and from payroll, employer and relief. */
    monthlyPersonal: number;
    monthlyExternal: number;
    /** False when there is too little data to know them: the pots then grow with nothing paid in. */
    contributionsKnown: boolean;
    /** Pension pots at retirement and the yearly income they sustain, today's money. */
    pot: Band | null;
    income: Band | null;
    withdrawalRate: AssumptionInUse;
    statePension: { annual: number; source: 'forecast' | 'fallback'; basis: string; startsOn: string | null } | null;
    /** Defined-benefit pensions' yearly income, from their statements. */
    dbIncome: number;
    taxFreeCash: { share: number; lumpSumAllowance: number | null };
    pool: { mu: number; sigma: number; fee: number };
    assumptions: AssumptionInUse[];
    notes: string[];
  };
}

export interface MonthlyItem {
  accountId: string;
  name: string;
  institutionName?: string;
  type: Account['type'];
  lastData: string | null;
  due: boolean;
  status: 'up-to-date' | 'due' | 'overdue' | 'never';
  want: 'statement' | 'screenshot' | 'balance';
  tip: string;
}

export interface MonthlyChecklistResponse {
  month: string;
  items: MonthlyItem[];
  done: number;
  total: number;
}

export interface DataHealthResponse {
  coverage?: CoverageResponse;
  issues: { file: string; severity: 'error' | 'warning'; message: string }[];
  gaps: { accountId: string; name: string; from: string; to: string; difference: number }[];
  uncategorised: number;
  noBalance: { accountId: string; name: string }[];
  stale: { accountId: string; name: string; days: number }[];
  /** Deposits per banking licence; `near` from 80% of the limit, `over` above it. */
  fscs: { group: string; institutions: string[]; total: number; limit: number; over: boolean; near: boolean }[];
}

export interface BootstrapResponse {
  profile: Profile;
  settings: Settings;
  accounts: Account[];
  institutions: Institution[];
  categories: Category[];
  rules: Rule[];
  goals: Goal[];
  csvProfiles: CsvProfile[];
  user: string | null;
  dataDir: string;
  inboxDir: string;
  demo: boolean;
}

export interface AccountDetailResponse {
  account: Account;
  summary: AccountSummary;
  balances: BalanceSnapshot[];
  holdings: HoldingsSnapshot[];
  series: { date: string; value: number | null }[];
  gaps: { from: string; to: string; difference: number }[];
  figures: Figure[];
  imports: { id: string; fileName: string; committedAt?: string; documentId: string }[];
}

export interface TransactionsResponse {
  total: number;
  sum: { in: number; out: number; net: number };
  items: Transaction[];
}

export interface ImportListResponse {
  pending: (ImportRecord & { readiness?: { ready: boolean; reasons: string[] } })[];
  committed: { id: string; createdAt: string; committedAt?: string; fileName: string; mediaType: string; documentId: string; engine?: string; result?: ImportRecord['result'] }[];
}

export interface SystemResponse {
  version: string;
  dataDir: string;
  inboxDir: string;
  workDir: string;
  formatVersion: number;
  engines: { id: string; available: boolean; detail: string; external: boolean }[];
  selectedEngine: string | null;
  git: { enabled: boolean; branch?: string; dirty: number; ahead?: number; behind?: number; remote?: string; lastCommit?: { hash: string; date: string; subject: string }; lastError?: string };
  inbox: { dir: string; lastError?: string };
  auth: { configured: boolean; user: string | null };
  counts: { accounts: number; transactions: number; balances: number; imports: number; figures: number };
}
