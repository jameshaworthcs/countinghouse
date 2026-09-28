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
}

export interface CashflowResponse {
  from: string;
  to: string;
  months: CashflowMonth[];
  totals: { income: number; spending: number; net: number; savingsRate: number | null };
  categories: CategoryAmount[];
  groups: CategoryAmount[];
}

export interface Insight {
  id: string;
  tone: 'good' | 'neutral' | 'warning';
  title: string;
  detail: string;
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
  categories: CategoryAmount[];
  groups: CategoryAmount[];
  heatmap: { months: string[]; rows: { id: string; name: string; values: number[]; total: number }[] };
  merchants: { payee: string; category?: string; categoryName: string; amount: number; count: number; average: number; lastDate: string }[];
  weekday: { day: number; label: string; total: number; average: number; count: number }[];
  hours: { hour: number; total: number; count: number }[] | null;
  largest: Transaction[];
  small: { threshold: number; count: number; total: number };
  insights: Insight[];
  recurring: RecurringItem[];
}

export interface ProjectionScenario {
  id: string;
  label: string;
  from: string;
  to: string;
  available: boolean;
  reason?: string;
  monthly: { income: number; spending: number; net: number; investing: number; pensionInflow: number };
}

export interface ProjectionResponse {
  startDate: string;
  months: number;
  assumedRealReturn: number;
  spendingAdjustment: number;
  start: { liquid: number; invested: number; pensions: number; property: number; debts: number; total: number };
  scenarios: ProjectionScenario[];
  history: { date: string; value: number }[];
  series: { id: string; label: string; points: { date: string; value: number; liquid: number }[] }[];
  categories: { id: string; name: string; recentAnnual: number; lastYear: number }[];
  runwayMonths: number | null;
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
  isa: { allowance: number; used: number; remaining: number; cashLimit: number; cashUsed: number; lines: AllowanceLine[]; notes: string[] };
  lisa: { allowance: number; contributed: number; remaining: number; bonusReceived: number; bonusExpected: number; lines: AllowanceLine[]; notes: string[] } | null;
  pension: {
    annualAllowance: number;
    personal: number;
    personalGross: number;
    employer: number;
    relief: number;
    total: number;
    remaining: number;
    carryForward: { taxYear: string; unused: number }[];
    lines: AllowanceLine[];
    notes: string[];
  };
  savings: { interest: number; allowance: number; band: string; remaining: number; lines: AllowanceLine[]; notes: string[] };
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
  lisa?: { bonusToDate: number | null; penaltyAdjustedValue: number | null; penaltyFreeFrom: string | null };
  pension?: { accessDate: string | null; projectedAtRetirement: number | null };
}

export interface InvestmentsResponse {
  totals: { value: number; contributions: number; growth: number; pensions: number; isas: number };
  accounts: InvestmentAccountSummary[];
  allocation: { assetClass: string; value: number; share: number }[];
  retirement: {
    age: number;
    date: string | null;
    potToday: number;
    monthlyContribution: number;
    projectedPot: number | null;
    projectedIncome: number | null;
    statePension: number | null;
    assumedRealReturn: number;
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
  issues: { file: string; severity: 'error' | 'warning'; message: string }[];
  gaps: { accountId: string; name: string; from: string; to: string; difference: number }[];
  uncategorised: number;
  noBalance: { accountId: string; name: string }[];
  stale: { accountId: string; name: string; days: number }[];
  fscs: { group: string; institutions: string[]; total: number; limit: number; over: boolean }[];
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
