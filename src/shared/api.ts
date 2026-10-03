// Response shapes of the HTTP API, shared by the server and the web app.

import type { AccessGroup, WrapperGroup } from './accounts';
import type { PersonSuggestion } from './people';
import type {
  Account,
  Agreement,
  BalanceEvidence,
  CoverageConfirmation,
  Terms,
  TermsRate,
  TermsRateApplies,
  BalanceSnapshot,
  Category,
  Company,
  CsvProfile,
  Figure,
  Goal,
  PensionArrangement,
  Budget,
  HoldingsSnapshot,
  ImportRecord,
  SetBy,
  Institution,
  Profile,
  Person,
  Proposal,
  ProposedChange,
  Rule,
  Settings,
  Transaction,
} from './schema';
import type { TaxBand } from './uk';

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
  /**
   * Spending this month so far: null until some day of it has data for every account. `change` is
   * against the same days last month, over the days both months have data; `note` says why a
   * figure is missing.
   */
  monthToDate: { spending: number | null; change: number | null; note: string | null };
  /** Pay earned on timesheets and not yet paid: pending, not counted in the estate. */
  owed: OwedPay | null;
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

/**
 * Days an account's data does not cover that a figure needs (docs/FORMULAS.md §3, "Missing days"),
 * and what its balances say about them.
 */
export interface MissingDaysView {
  accountId: string;
  name: string;
  from: string;
  to: string;
  days: number;
  /** The account has no data at all. */
  noData?: boolean;
  /** It has no opening date and its data starts later: setting the date settles these days if it opened then. */
  openingUnknown?: boolean;
  /** What its balances say: days that `adds-up` can be confirmed in Settings → Data health. */
  evidence: BalanceEvidence['status'];
}

export interface AllowancesResponse {
  taxYear: { label: string; start: string; end: string; daysLeft: number | null; current: boolean };
  /**
   * `incomplete` (here and below): which accounts' data does not cover the tax year, so the amount
   * used is a minimum and what is left a maximum, in a sentence; null when the year is covered.
   * `missing`: the same days, account by account.
   */
  isa: { allowance: number; used: number; remaining: number; cashLimit: number; cashUsed: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[] };
  lisa: { allowance: number; contributed: number; remaining: number; bonusReceived: number; bonusExpected: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[] } | null;
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
    missing: MissingDaysView[];
  };
  /** The allowance follows the tax band worked out from the year's income (`taxBand`). */
  savings: { interest: number; allowance: number; band: TaxBand; bandBasis: TaxBandEstimate['basis']; remaining: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[] };
  dividends: { amount: number; allowance: number; remaining: number; lines: AllowanceLine[] };
  taxBand: TaxBandEstimate;
  ruleNotes: string[];
}

/**
 * The highest income tax band the year's income reaches, worked out from your data (FORMULAS.md §11).
 * `basis`: `documents` when pay comes from P60 or payslip figures; `estimate` when it comes from
 * your salary in Settings or last year's P60; `minimum` when no gross pay is known, so only the
 * income found counts and the band may be higher.
 */
export interface TaxBandEstimate {
  band: TaxBand;
  basis: 'documents' | 'estimate' | 'minimum';
  lines: { label: string; amount: number; kind: 'pay' | 'self-employment' | 'interest' | 'dividends' | 'extension' }[];
  total: number;
  personalAllowance: number;
  taxable: number;
  higherFrom: number;
  additionalFrom: number;
  notes: string[];
}

export interface SaSource {
  /** `hmrc`: HMRC's record of a payment an employer reported (hmrc.jsonl); `payslip`: a payslip's year-to-date column (payslips.jsonl). */
  type: 'figure' | 'transaction' | 'account' | 'hmrc' | 'payslip';
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

/** One job's SA102 Employment page for the year: one page per job. */
export interface SaEmployment {
  key: string;
  employmentId?: string;
  employer: string;
  payeReference?: string;
  pay: number | null;
  tax: number | null;
  studentLoan: number | null;
  /** When it started or ended within the year: the return asks for those dates. */
  startedOn?: string;
  endedOn?: string;
  /** The year's figure, nothing more to come (a P60, or a job that ended). */
  final: boolean;
  /** Where its pay comes from, in words ("its P60"). */
  basis: string;
  sources: SaSource[];
}

/** A payment matched to the bank: the transaction that made it. */
export interface SaPaymentLink {
  transactionId: string;
  accountId: string;
  date: string;
  amount: number;
}

export interface SelfAssessmentResponse {
  taxYear: { label: string; start: string; end: string; filingDeadline: string; paymentDeadline: string };
  disclaimer: string;
  sections: SaSection[];
  /** One SA102 page per job, from the one source that counts for each (FORMULAS §11). */
  employments: SaEmployment[];
  /** The year's return deadlines (UK rules: `saDeadlines`), each with whether it has passed. */
  deadlines: { date: string; kind: string; what: string; passed: boolean }[];
  /** HMRC's working out of the year (its settlement record), with the bank payments that settled it. */
  settlement?: {
    outcome: 'underpaid' | 'overpaid' | 'settled';
    amount?: number;
    calculatedOn?: string;
    outstanding: number;
    asOf: string;
    payments: { date: string; amount: number; how: string; paidFrom?: SaPaymentLink }[];
    /** A refund HMRC paid into your bank, when it overpaid and one is found. */
    refund?: SaPaymentLink;
  };
  /** The year on your National Insurance record, as HMRC's page last showed it. */
  ni?: { status: 'full' | 'not-full' | 'not-available' | 'other'; voluntaryCost?: number; payBy?: string; text?: string; asOf: string };
  checklist: { id: string; done: boolean; label: string; detail?: string }[];
  mayNeedToFile: { reason: string; detail: string }[];
}

export interface InvestmentAccountSummary {
  id: string;
  name: string;
  type: Account['type'];
  typeLabel: string;
  value: number | null;
  /** The value is an estimate: an approximate figure you gave, or one rolled back from data. */
  estimated: boolean;
  asOf: string | null;
  /** Total paid in: as the provider reports it, or summed from contributions that go back to the start. */
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
  /**
   * `contributions` (paid in) and `growth` cover only the accounts where both the value and what
   * went in are known, null when none are; `paidInUnknown` counts the accounts left out.
   */
  totals: { value: number; contributions: number | null; growth: number | null; growthPct: number | null; paidInUnknown: number; pensions: number; isas: number; annualCharges: number };
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
    statePension: {
      annual: number;
      source: 'forecast' | 'fallback';
      basis: string;
      startsOn: string | null;
      /** HMRC's forecast in full, when it is the one used. */
      hmrc?: { asOf: string; weekly: number; monthly?: number; annual: number; payableFrom?: string; recordTo?: string; qualifyingYears?: number; yearsNeeded?: number; assumesYears?: number; maximum?: boolean };
    } | null;
    /** Your National Insurance record, year by year as HMRC's page last showed each, newest first. */
    niRecord: { taxYear: string; status: 'full' | 'not-full' | 'not-available' | 'other'; contributions: { kind: string; amount?: number }[]; voluntaryCost?: number; payBy?: string; text?: string; asOf: string }[];
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

export interface CaptureAskView {
  id: string;
  what: string;
  how?: string;
  why?: string;
  /** `done` when your data shows it or you ticked it; `partial` when the data shows some of it. */
  state: 'done' | 'partial' | 'todo';
  /** The app ticks this ask off from your data; otherwise only you can. */
  checkedByData: boolean;
  tickedByYou: boolean;
  /** What the data shows so far, e.g. which months are missing. */
  progress?: string;
}

export interface CaptureItemView {
  id: string;
  title: string;
  priority: 'high' | 'normal' | 'low';
  note?: string;
  accountId?: string;
  institutionId?: string;
  institutionName?: string;
  asks: CaptureAskView[];
  done: boolean;
  skipped: boolean;
}

export interface CaptureResponse {
  items: CaptureItemView[];
  /** Asks on items you have not skipped, and how many are done. */
  asks: number;
  asksDone: number;
  /** Items not skipped with something left to collect. */
  open: number;
}

/** A stretch of days an account should have data for that nothing covers (docs/FORMULAS.md §3). */
export interface CoverageGapView {
  accountId: string;
  name: string;
  from: string;
  to: string;
  days: number;
  /** Rows recorded inside it. */
  rows: number;
  evidence: BalanceEvidence;
  /** The account has no data at all. */
  noData?: boolean;
  /** It has no opening date and its data starts later: setting the date settles this if it opened then. */
  openingUnknown?: boolean;
  /** A valued account (an ISA, a pension): its balances cannot show what was paid in or out. */
  valuations?: boolean;
}

/**
 * What carried over when one account took over from another (`Account.continues`): the older one's
 * balance at the end of its last day against the newer one's at the start of its first (docs/FORMULAS.md §9).
 */
export interface Handover {
  older: { accountId: string; name: string };
  newer: { accountId: string; name: string };
  /** The newer account's first day. */
  from: string;
  /** The older account's balance at the end of the day before `from`, when known. */
  closing: number | null;
  /** The newer account's balance at the start of `from`, before that day's rows, when known. */
  opening: number | null;
  /** opening − closing, when both are known. */
  difference: number | null;
  /** `unknown`: a side has no data then, or is valued (`valued`). */
  status: 'adds-up' | 'unexplained' | 'unknown';
  /** A side is valued (it moves with markets), so what carried over is not checked. */
  valued?: boolean;
  /** A side's balance is worked out with no statement balance to rest on. */
  estimated: boolean;
}

/** A closed account that still held money (or owed it) on its last day, with nothing carrying it on. */
export interface ClosedHolding {
  accountId: string;
  name: string;
  closedOn: string;
  balance: number;
  estimated: boolean;
}

export interface DataHealthResponse {
  coverage?: CoverageResponse;
  /** Each link between your accounts, with what carried over. */
  handovers?: Handover[];
  /** Closed accounts that still held money on their last day, with no account carrying it on. */
  closedHolding?: ClosedHolding[];
  /**
   * Stretches that nothing covers, with what their balances say (docs/FORMULAS.md §3, "Missing
   * days"): from the coverage grid's first month, and for the accounts a tax figure rests on, from
   * the start of the oldest tax year still open (`openTaxYear`).
   */
  coverageGaps?: CoverageGapView[];
  /** The oldest tax year whose return can still be sent or corrected, and until when. */
  openTaxYear?: { label: string; start: string; correctBy: string };
  /** The stretches you confirmed nothing is missing from, with what their balances say now. */
  confirmations?: (CoverageConfirmation & { name: string; now: BalanceEvidence })[];
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
  budgets: Budget[];
  csvProfiles: CsvProfile[];
  user: string | null;
  dataDir: string;
  inboxDir: string;
  demo: boolean;
}

export interface AccountDetailResponse {
  account: Account;
  /** The account it carries on from, and the one that carries on from it, with what carried over. */
  links?: { carriesOnFrom?: Handover; carriedOnAs?: Handover };
  summary: AccountSummary;
  balances: BalanceSnapshot[];
  holdings: HoldingsSnapshot[];
  series: { date: string; value: number | null }[];
  gaps: { from: string; to: string; difference: number }[];
  figures: Figure[];
  imports: { id: string; fileName: string; label?: string; committedAt?: string; documentId: string }[];
}

export interface TransactionsResponse {
  total: number;
  sum: { in: number; out: number; net: number };
  items: Transaction[];
}

/** An import waiting for review that adds nothing new (src/server/ingest/novelty.ts). */
export interface NothingNewView {
  reason: string;
  /** Imports waiting beside it that already have what it shows. */
  coveredBy: { id: string; fileName: string }[];
}

export type PendingImport = ImportRecord & { readiness?: { ready: boolean; reasons: string[] }; nothingNew?: NothingNewView };

/**
 * The other side of a draft row's transfer (src/server/ingest/links.ts): a row of an import waiting
 * for review (`pending`), a recorded transaction (`recorded`), or one no longer there (`gone`).
 */
export interface DraftLinkView {
  kind: 'pending' | 'recorded' | 'gone';
  /** Chosen by you, or found by the draft itself (a recorded transaction only). */
  by: 'user' | 'draft';
  importId?: string;
  key?: string;
  /** The import's file, for a pending row. */
  fileName?: string;
  transactionId?: string;
  accountName?: string;
  date?: string;
  amount?: number;
  description?: string;
  /** A pending row left unticked: the link holds only if both are recorded. */
  included?: boolean;
}

/** A row or recorded transaction a draft row could be linked to as the other leg of a transfer. */
export interface LinkCandidate {
  kind: 'pending' | 'recorded';
  importId?: string;
  key?: string;
  fileName?: string;
  transactionId?: string;
  accountName: string;
  date: string;
  amount: number;
  description: string;
  /** Days from the row's date. */
  days: number;
  included?: boolean;
}

/** One import, as the review page has it. */
export type ImportView = PendingImport & { links?: Record<string, DraftLinkView> };

/** The imports waiting for review (committed ones are paged through `ImportHistoryResponse`). */
export interface ImportListResponse {
  pending: PendingImport[];
}

export interface CommittedImport {
  id: string;
  createdAt: string;
  committedAt?: string;
  fileName: string;
  /** The name to find it by: Claude's (`agent`) or yours (`owner`). */
  label?: { text: string; setBy: SetBy };
  mediaType: string;
  documentId: string;
  engine?: string;
  result?: ImportRecord['result'];
}

/** Imports Claude names in one `label-imports` job. */
export const LABEL_BATCH = 40;

/** GET /imports/history?page=&q=: committed imports, the latest committed first, a page at a time. */
export interface ImportHistoryResponse {
  items: CommittedImport[];
  /** How many there are (that match `q`, when given). */
  total: number;
  /** Committed imports with no name yet, of all of them. */
  unnamed: number;
  /** A naming run you started (History's button) is waiting its turn, or running. */
  naming?: 'queued' | 'running';
  /** The page these are: the one asked for, or the last there is when it asked past the end. */
  page: number;
  pageSize: number;
}

/** A transaction a proposed change is about, as it is now (or was, for a decided proposal). */
export interface ProposalRow {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  category?: string;
  categorisedBy?: Transaction['categorisedBy'];
  transferGroup?: string;
  /** The other row of its transfer, when it is linked. */
  partner?: { id: string; accountId: string; date: string; amount: number; description: string };
  /** The document it came from. */
  source?: { importId: string; fileName?: string };
  /** It is no longer in your data. */
  missing?: true;
}

export interface ProposalChangeView {
  change: ProposedChange;
  /** Why it cannot be applied as things stand (the data changed, or a change it needs is left out). */
  problem?: string;
  /** Your data already says this: nothing to do. */
  alreadySo?: true;
  /** A link's rows as it would leave them: their category, and the account each is a transfer with. */
  after?: Record<string, { category?: string; transferWith: string }>;
  /** A move inside an account: the balances either side of it, which add up without it. */
  between?: { from: { date: string; balance: number }; to: { date: string; balance: number } };
  /** A balance moved: why it is not the account's it is in, and the balances it adds up with where it goes. */
  moved?: { misfit: string; beside: { date: string; balance: number }[] };
  /** An agreement added: the payments in your data it files under its category, with the category each has now. */
  files?: { transactionId: string; accountId: string; date: string; amount: number; category?: string }[];
  /** Terms set: the document they are from, and the terms its reading kept, which they replace. */
  terms?: { fileName?: string; before?: Pick<Terms, 'rates' | 'limit' | 'minimumPayment' | 'paymentDue'> };
  /**
   * A rule made: the payments it categorises now (newest first, a few shown); those a guess put in
   * its category already, which it settles (they become the rule's); and how many it matches that
   * you categorised otherwise yourself, which it leaves as they are.
   */
  rule?: { count: number; amount: number; examples: ProposalRuleExample[]; settles: number; yours: number };
  /** A category added or changed: where it sits after (its group's name), and how it was. */
  category?: { group?: string; was?: { name: string; group?: string } };
  /** A rule removed: the payments it categorised that change without it, with what each becomes (`after`). */
  removes?: { count: number; examples: ProposalRuleExample[] };
}

/** A payment a proposed rule would categorise (or a removed one stop categorising), with the category it has now, and after a removal. */
export interface ProposalRuleExample {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  category?: string;
  after?: string;
}

/** A balance a proposal moves, as it is now (as it was, once decided). */
export interface ProposalBalance {
  id: string;
  accountId: string;
  date: string;
  balance: number;
  currency: string;
  kind: BalanceSnapshot['kind'];
  interestRate?: number;
  /** The document it came from. */
  source?: { importId: string; fileName?: string };
  /** It is no longer in your data. */
  missing?: true;
}

export interface ProposalView {
  proposal: Omit<Proposal, 'before'>;
  changes: ProposalChangeView[];
  /** Every transaction the changes name, by id. */
  rows: Record<string, ProposalRow>;
  /** Every balance the changes name, by id. */
  balances: Record<string, ProposalBalance>;
  /** Every account those rows, balances or changes name, by id. */
  accounts: Record<string, { id: string; name: string; type: Account['type']; status: Account['status']; openedOn?: string; closedOn?: string; institutionName?: string }>;
  /** Every rule a change removes, as it is now (as it was, once decided), by id. */
  rules?: Record<string, { name?: string; match: Rule['match']; category?: string }>;
  /** The terms each `remove_terms` change takes away, as they are now (as they were, once decided), by change key. */
  removedTerms?: Record<string, Pick<Terms, 'rates' | 'limit' | 'minimumPayment' | 'paymentDue'> & { fileName?: string }>;
  /** Changes that can be applied now, and those that cannot. */
  ready: number;
  problems: number;
  /** Waiting, but applying it would change nothing: your data already says all of it. It closes as already done. */
  alreadyDone?: true;
}

/** What applying, dismissing or closing a proposal returns. */
export interface ProposalDecision extends ProposalView {
  /** Other proposals it left with nothing to do, closed as already done. */
  alsoDone?: { id: string; title: string }[];
}

export interface ProposalSummary {
  id: string;
  status: Proposal['status'];
  title: string;
  changes: number;
  applied: number;
  provenance: Proposal['provenance'];
  createdAt: string;
  decidedAt?: string;
}

export interface ProposalListResponse {
  /** Waiting for you, the newest first. */
  pending: ProposalView[];
  /** Applied, dismissed or already done, the latest first. */
  decided: ProposalSummary[];
}

/** POST /api/proposals/:id/check: what each change would do with some left out. */
export interface ProposalCheckResponse {
  changes: { key: string; problem?: string; alreadySo?: true; after?: ProposalChangeView['after'] }[];
  ready: number;
  problems: number;
  /** The changes kept would change nothing: your data already says them. */
  alreadyDone?: true;
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
  auth: { configured: boolean; method: 'oidc' | 'password' | null; user: string | null };
  counts: { accounts: number; transactions: number; balances: number; imports: number; figures: number };
}

/** Settings → Agent access (GET /api/tokens): tokens as you see them, never the token itself. */
export interface AgentTokenInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  lastUsedFrom?: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface AgentTokenUse {
  at: string;
  tokenId: string;
  name: string;
  method: string;
  path: string;
  status: number;
  from: string;
}

export interface TokensResponse {
  tokens: AgentTokenInfo[];
  uses: AgentTokenUse[];
  scopes: { id: string; label: string }[];
}

/** One budget against a month's spending (GET /api/budgets; docs/FORMULAS.md §15). */
export interface BudgetLine {
  /** The category or group; absent for all spending. */
  category?: string;
  name: string;
  scope: 'total' | 'group' | 'category';
  monthly: number;
  /** Spending recorded in the month so far. */
  spent: number;
  /** What is left (negative when over). */
  left: number;
  /** Spent ÷ budget. */
  share: number;
  /** How much of a usual month's spending the data reaches (1 for a past month), or null. */
  expectedShare: number | null;
  /** Where the month is heading at its usual pace, once a pace can be judged. */
  projected: number | null;
  status: 'over' | 'pace' | 'near' | 'ok';
  /** What the pace is measured against, in words. */
  paceBasis: string | null;
  /** The median of your recent complete months, rounded up: a starting point. */
  suggested: number | null;
  notes?: string;
}

export interface BudgetsResponse {
  month: string;
  /** The month is over. */
  complete: boolean;
  /** The last day, from the 1st, with data for every account. */
  dataTo: string | null;
  lines: BudgetLine[];
  /** All spending and groups with no budget yet, with a suggestion from recent complete months. */
  suggestions: { category?: string; name: string; scope: BudgetLine['scope']; suggested: number; typical: number; months: number }[];
  /** Complete months in the year before, which the pace and suggestions come from. */
  pastMonths: number;
  note: string | null;
}

/** A goal's progress (GET /api/goals/progress; docs/FORMULAS.md §16). */
export interface GoalProgress {
  id: string;
  name: string;
  kind: 'savings' | 'emergency-fund' | 'home-deposit';
  /** The amount to reach, or null when it is not known yet (an emergency fund before spending is). */
  target: number | null;
  targetBasis: string;
  targetDate: string | null;
  /** What the accounts count for today (a LISA may count at 75%). */
  current: number;
  share: number | null;
  /** Money coming in each month at the recent pace, as counted. */
  monthly: number;
  accounts: { accountId: string; name: string; value: number; counted: number; monthly: number; monthlyBasis: string; note?: string }[];
  /** When the target is reached: early (the 90th percentile path), median, late (the 10th). Null past the horizon. */
  reach: { early: string | null; median: string | null; late: string | null } | null;
  /** The range on the target date. */
  atTargetDate: { p10: number; p50: number; p90: number } | null;
  /** More a month needed to reach it by the target date, at the median (0 when on track). */
  neededMonthly: number | null;
  status: 'reached' | 'on-track' | 'behind' | 'no-date' | 'unknown';
  notes: string[];
  ownerNotes?: string;
}

export interface GoalsResponse {
  goals: GoalProgress[];
  /** The period the pace comes from, e.g. "the last 3 months". */
  pace: string | null;
  notes: string[];
}

/** One pay period (a payslip), or a payment of pay with no payslip (GET /api/pay; FORMULAS §17). */
export interface PayMonth {
  periodStart: string | null;
  periodEnd: string | null;
  /** The payslip's date, or the day the pay arrived. */
  payDate: string | null;
  gross: number | null;
  tax: number | null;
  ni: number | null;
  pension: number | null;
  studentLoan: number | null;
  /** The net pay the payslip prints (`netPrinted`), else its gross less the deductions read from it. */
  expectedNet: number | null;
  netPrinted?: boolean;
  /** The payslip in full (payslips.jsonl), when it was read in full: its id, tax code (with " M1" for week 1/month 1) and NI letter. */
  payslipId?: string;
  taxCode?: string;
  niLetter?: string;
  /** What the employer paid on top this period: printed, else worked out from the year to date. */
  employerCosts?: { ni?: number; pension?: number };
  /** The payment into your bank matched to it. */
  paidIn: { amount: number; date: string; transactionId: string; accountId: string } | null;
  /** What the payslip's other deductions come to: expected net less what arrived. */
  otherDeductions: number | null;
  /**
   * nothing: a payslip with nothing to pay in (£0, or deductions as much as the pay); owed: not in
   * the bank, and you said it is owed to you (it will be paid).
   */
  status: 'paid' | 'differs' | 'not-seen' | 'due' | 'nothing' | 'no-payslip' | 'owed';
  note?: string;
  figureIds: string[];
  /** HMRC's record of the payment in the same tax month: what the employer reported (FORMULAS §17). */
  hmrc?: { payDate: string; taxablePay: number; tax: number; ni: number | null; recordId: string };
  /**
   * The tax the code HMRC issued for the job would take, when it is not what was taken (by more than
   * £1): the code, its basis, the day HMRC issued it, and that tax.
   */
  check?: { code: string; cumulative: boolean; issuedOn: string; tax: number; taken: number; note: string };
  /** You said its pay is owed to you: on the Pay tab (`employments.json` → owed), or by telling the app it had not arrived (the context record `contextId`). */
  owed?: { markedAt: string; note?: string; contextId?: string };
}

/** A timesheet's period: what was earned, and the payslip that paid it or when it should come (FORMULAS §17, "Earned pay"). */
export interface EarnedPeriod {
  figureId: string;
  label: string;
  /** The employer or entity the timesheet names. */
  payer: string;
  role?: string;
  periodStart: string | null;
  periodEnd: string;
  amount: number;
  daysWorked?: number;
  holidayDays?: number;
  hoursWorked?: number;
  rate?: number;
  ratePer?: 'day' | 'hour';
  /** paid: on a payslip; arrived: in the bank before its payslip was imported; owed; late: owed past its expected pay day. */
  status: 'paid' | 'arrived' | 'owed' | 'late';
  payslip?: { periodEnd: string | null; payDate: string | null; gross: number; periods: number; figureIds: string[] };
  paidIn?: { amount: number; date: string; transactionId: string; accountId: string };
  expected?: { month: string | null; payDate: string | null };
  note?: string;
}

/** Owed pay expected together, on one payslip: its estimate is computed from the payroll's payslips and the UK rules. */
export interface ExpectedPay {
  /** The payslip month (YYYY-MM); null when when it comes cannot be told. */
  month: string | null;
  payDate: string | null;
  gross: number;
  /** The work periods it pays, by their last day. */
  periods: string[];
  figureIds: string[];
  status: 'owed' | 'late' | 'arrived';
  arrived?: { amount: number; date: string; transactionId: string; accountId: string };
  estimate: { tax: number | null; ni: number | null; pension: number | null; net: number | null; basis: string | null; notes: string[] };
  /** With two periods or more: the deductions if each had been paid in a month of its own, and what paying them together adds. */
  apart: { tax: number | null; ni: number | null; extraTax: number | null; extraNi: number | null } | null;
}

/** A payroll that pays timesheet work. */
export interface EarnedPayroll {
  key: string;
  /** The payroll's job (employments.json), where you set how long after the work it pays. */
  employmentId?: string;
  /** The employer as its payslips name it. */
  payroll: string;
  /** The timesheets it pays: "Halden Systems Limited, Role A". */
  timesheets: string[];
  /** Months between the work and the payslip: yours (Settings), or learned from payslips matched to timesheets. */
  lag: { months: number | null; source: 'yours' | 'learned' | null };
  periods: EarnedPeriod[];
  expected: ExpectedPay[];
}

/** One source of a job's figure for a year (analytics/sources.ts): the one that counts, or another. */
export interface TaxDocSource {
  /** `year`: for the whole tax year; `to-date`: the year so far; `payslips`: the payslips added up; `yours`: typed by you. */
  kind: 'yours' | 'year' | 'to-date' | 'payslips';
  label: string;
  amount: number;
  asOf: string;
  final: boolean;
  /** The document it came from, when one did. */
  importId?: string;
  fileName?: string;
  /** The figures it adds up, HMRC's payment records it adds up, or the payslip whose year to date it is. */
  figureIds: string[];
  hmrcRecords?: number;
  payslipId?: string;
}

/** Settings → Tax documents: a tax year's tax figures, by job, each value with its sources. */
export interface TaxDocumentsResponse {
  taxYear: { label: string; start: string; end: string };
  /** Tax years with anything in them, newest first. */
  years: string[];
  jobs: {
    key: string;
    employmentId?: string;
    employer: string;
    names: string[];
    payeReference?: string;
    payrollNumbers?: string[];
    startedOn?: string;
    endedOn?: string;
    /** Pay, tax, NI and student loan: the source that counts, and the others that state it. */
    values: { kind: string; label: string; chosen: TaxDocSource; others: TaxDocSource[] }[];
    /** Its payslips this year, oldest first: read in full (`id`), or only as tax figures. */
    payslips: { id?: string; importId?: string; fileName?: string; payDate: string; period?: string; gross: number | null; net: number | null; taxCode?: string }[];
    /** HMRC's records of its payments this year. */
    hmrcPayments: number;
  }[];
  /** The year's other tax figures (interest, dividends, pension statements, gift aid…), by kind. */
  other: { kind: string; label: string; total: number; figures: { id: string; label: string; amount: number; payer?: string; accountId?: string; date?: string; importId?: string; fileName?: string; yours: boolean }[] }[];
}

/** A company you hold shares in, with what it is worth and the dividends it paid you. */
export interface CompanyView {
  company: Company;
  /** Its value now: the latest balance on its account (each valuation is recorded as one). */
  value?: { amount: number; date: string; approximate: boolean };
  /** The latest valuation, and how it was worked out. */
  valuation?: Company['valuations'][number];
  /** Each dividend: a voucher (with the credit that paid it, when found), or a credit with no voucher. */
  dividends: { date: string; amount: number; taxYear?: string; figureId?: string; importId?: string; paidIn?: { transactionId: string; accountId: string; date: string } }[];
  dividendsTotal: number;
}

/** Where one part of an account's terms is from: the latest document that gives it. */
export interface TermsFrom {
  asOf: string;
  importId?: string;
  fileName?: string;
}

/** GET /accounts/:id/terms: an account's terms as its documents give them (FORMULAS §4, "Terms"). */
export interface TermsResponse {
  /** The latest of each part, from the latest document that gives it: its rates, its limit, a card's minimum payment. */
  rates?: TermsFrom & { rates: TermsRate[] };
  limit?: TermsFrom & { value: number };
  minimum?: TermsFrom & { amount: number; due?: string };
  /** How its limit and each kind of rate changed, oldest first: each time one differs from the one before. */
  changes: { asOf: string; what: 'limit' | TermsRateApplies; from?: number; to: number }[];
  /** Its latest rates that end within 60 days or have ended, with the days left (below 0: since). */
  ending: { rate: TermsRate; days: number }[];
  /** How many documents gave its terms. */
  records: number;
}

/** An agreement, its schedule checked against what you paid (FORMULAS §10, "Agreements"). */
export interface AgreementView {
  agreement: Agreement;
  payments: {
    due: string;
    amount: number;
    label?: string;
    /**
     * `paid`: a payment of it was found; `upcoming`: not due yet; `due`: due, and it may still come
     * (up to 45 days after, or 7 for one paid to the penny); `unseen`: no payment of it was found in
     * your accounts; `documented`: none was found, but its document says it was paid (before your
     * data begins, say); `cancelled`: its document says it was cancelled.
     */
    status: 'paid' | 'upcoming' | 'due' | 'unseen' | 'documented' | 'cancelled';
    /** The payment found, as a positive amount, and by how much it is more (or, below 0, less) than what was due: up to a tenth. */
    paid?: { transactionId: string; accountId: string; date: string; amount: number; difference?: number };
  }[];
  /** Other payments to it in its category, from 45 days before it to 45 days after, that no scheduled payment accounts for. */
  others: { transactionId: string; accountId: string; date: string; amount: number }[];
  /** What you paid it: the scheduled payments found, and the others. */
  paid: number;
}

/** A pension account's arrangements with your employers, each checked against what arrived (FORMULAS §11). */
export interface PensionArrangementsResponse {
  arrangements: {
    employmentId: string;
    employer: string;
    arrangement: PensionArrangement;
    /** A single payment: when it arrived. */
    arrived?: { date: string; transactionId: string };
    /** A monthly one: each collection, and the months since the first with none (YYYY-MM). */
    collected?: { date: string; transactionId: string }[];
    missing?: string[];
    /** False when its first collection was not found within two months of the form. */
    firstSeen?: boolean;
  }[];
  /** Employer contributions into the account that no arrangement accounts for. */
  others: { date: string; amount: number; transactionId: string }[];
}

/** Pay owed to you and not yet in the bank: shown beside the estate value, never counted in it. */
export interface OwedPay {
  gross: number;
  /** After the estimated deductions; null when some cannot be estimated. */
  net: number | null;
  next: string | null;
  late: boolean;
  /** `payslip`: a payslip's pay you said is owed, or told the app had not arrived (its pay after deductions is known); else timesheet work. */
  items: { payroll: string; gross: number; net: number | null; payDate: string | null; periods: string[]; status: 'owed' | 'late'; kind?: 'payslip' | 'timesheet' }[];
}

export interface PayEmployer {
  key: string;
  payer: string;
  /** The job (employments.json), with what HMRC and its documents say of it. */
  employmentId?: string;
  payeReference?: string;
  payrollNumbers?: string[];
  startedOn?: string;
  endedOn?: string;
  /** Tax codes HMRC issued for the job that apply in the year, oldest first. */
  codes?: { date: string; code: string; cumulative: boolean }[];
  /**
   * Pay the year-to-date column shows on no imported payslip (FORMULAS §17, "Payslips in full"):
   * between the payslips paid on `after` and `before`, or before the first (`after` absent).
   */
  gaps?: { after?: string; before: string; amount: number }[];
  months: PayMonth[];
  /** Timesheet work this payroll pays (FORMULAS §17, "Earned pay"). */
  earned?: EarnedPayroll;
  /**
   * The document beside the payslips: the year's P60 (or another figure for the whole year), else the
   * latest one to a date (a P45, an HMRC page). The payslips paid by then should add up to it; `note`
   * says whether they do (FORMULAS §11, "One source per employer and year").
   */
  document: { title: string; fileName?: string; importId?: string; final: boolean; asOf: string; gross: number | null; tax: number | null; ni: number | null; note: string } | null;
  totals: { gross: number | null; tax: number | null; ni: number | null; pension: number | null; studentLoan: number | null; paidIn: number };
}

export interface PayResponse {
  taxYear: { label: string; start: string; end: string };
  employers: PayEmployer[];
  notes: string[];
}

/** A stored document read again with the current reader, compared with what its import recorded. */
export interface RereadRow {
  key: string;
  /** same: recorded as read; changed: recorded with another date, amount or description; added: read now, not recorded; missing: recorded, not read now. */
  kind: 'same' | 'changed' | 'added' | 'missing';
  stored?: { id: string; date: string; amount: number; description: string };
  /** As read now; `type` (a CSV's transaction type) is filled in on a correction when missing. */
  read?: { date: string; amount: number; description: string; type?: string };
  changes?: ('date' | 'amount' | 'description')[];
  /** Read now, not recorded by this import, but maybe recorded by another in other words. */
  maybe?: { id: string; date: string; amount: number; description: string };
  applied?: boolean;
}

export interface RereadSection {
  accountId: string;
  accountName: string;
  rows: RereadRow[];
  balance: { stored: { id: string; date: string; balance: number } | null; read: { date: string; balance: number } | null; changed: boolean; applied?: boolean } | null;
}

export interface Reread {
  importId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  engine?: string;
  model?: string;
  engineVersion?: string;
  /** The reader version that made the import. */
  previousVersion?: string;
  /** A CSV or spreadsheet: the layout it was parsed with now ("Chase UK", or columns worked out). */
  layout?: string;
  costUsd?: number;
  sections: RereadSection[];
  notes: string[];
  error?: string;
}

/** A payment in a preview of re-applying categorisation. */
export interface EnrichExample {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
}

/** One payee's payments in a group of a preview of re-applying categorisation. */
export interface EnrichPayee {
  payee: string;
  count: number;
  /** The amounts added up, ignoring sign. */
  amount: number;
  /** Its payments, newest first. */
  rows: EnrichExample[];
  /** The rule "always" would make for it, when one catches every one of its payments. */
  match?: Rule['match'];
}

/** Rows whose category would change the same way: from one category to another, by the same means. */
export interface EnrichGroup {
  from: string | null;
  to: string | null;
  by: Transaction['categorisedBy'] | null;
  count: number;
  /** The amounts added up, ignoring sign. */
  amount: number;
  /** Who they are with, the most first, each with its payments. */
  payees: EnrichPayee[];
}

/** What re-applying categorisation to all history would change (POST /enrich/preview); nothing is written. */
export interface EnrichPreview {
  recategorised: number;
  transfersLinked: number;
  /** Rows whose payee alone would be tidied. */
  payeesTidied: number;
  /**
   * Transfers whose payee names another account of yours than the one they are linked with, and
   * would take that one's name (`linkedPayee`): each listed, as any of them can be left as it is.
   */
  accountPayees: { id: string; accountId: string; date: string; amount: number; description: string; from: string | null; to: string }[];
  groups: EnrichGroup[];
}

/** A payment to show on the To categorise page. */
export interface QueueExample {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
}

/** A payment with a person for you to decide (GET /categorise/queue). */
export interface PersonRow extends QueueExample {
  /** The payment's reference ("xmas", "Train"), when the bank gives one. */
  reference?: string;
  /** The category it has now and what gave it: never yours, which are decided. */
  category?: string;
  categorisedBy?: Transaction['categorisedBy'];
  suggestion?: PersonSuggestion;
  /** In the cash group, a cheque rather than cash. */
  cheque?: boolean;
}

/** One person, however their payments write the name (docs/FORMULAS.md §10, "People"). */
export interface PersonGroup {
  /** The person you saved, else the key their names share ("whitlock|h"). */
  key: string;
  person?: Person;
  /** A name to show: the saved one, or the fullest the payments carry. */
  name: string;
  /** Every name their payments carry, the most used first. */
  names: string[];
  /** Their surname is yours: family, most likely. */
  sharesYourSurname: boolean;
  /** Not a person: cash and cheques paid in, whose money nothing on them says (docs/FORMULAS.md §10, "Cash and cheques paid in"). */
  cash?: boolean;
  /** Their payments waiting for you, newest first. */
  rows: PersonRow[];
  /** Their payments you decided already. */
  decided: number;
  /** Money from them and to them, over the payments listed and decided. */
  in: number;
  out: number;
}

/** A rule your decisions point to: you categorised a payee the same way again and again. */
export interface RuleSuggestion {
  payee: string;
  category: string;
  direction?: 'in' | 'out';
  match: Rule['match'];
  /** The decisions it comes from: yours, or the reader's when you made none. */
  from: { by: 'user' | 'ai'; count: number };
  /** The rows it would categorise now: not yours, and not in that category already. */
  fills: { count: number; amount: number; ids: string[] };
  /** What it would categorise now, or, for a rule for the next ones, the payments you decided. */
  examples: QueueExample[];
  /** You decided every payment from them: nothing to fill now, the rule is for the next ones. */
  next?: true;
}

/** What making a rule would move (POST /rules/preview): payments in one category now, or uncategorised. */
export interface RuleMove {
  category?: string;
  count: number;
  amount: number;
}

/** Uncategorised payments to or from one payee, one way. */
export interface PayeeGroup {
  payee: string;
  direction: 'in' | 'out';
  count: number;
  /** The amounts added up, with their sign. */
  amount: number;
  first: string;
  last: string;
  accountIds: string[];
  ids: string[];
  examples: QueueExample[];
  /** The rule "always" would make: the description holds the payee. */
  match: Rule['match'];
}

/**
 * Payments to or from one payee, one way, that the app put in one category from a guess: the bank's
 * own category, or the reader's suggestion when it read the document (docs/FORMULAS.md §10, "Guesses
 * to check"). They count as categorised until you change them.
 */
export interface GuessGroup extends PayeeGroup {
  category: string;
  /** How many each guess gave. */
  by: { bank: number; ai: number };
  /** The bank's own words for the category it gave ("Business Services-Conferences & Training"). */
  bankSays: string[];
}

// ─── The month in review (GET /month/:month, docs/FORMULAS.md §18) ─────────────────────────────

/** A month's figure against the complete months before it. */
export interface MonthCompared {
  /** The median, lowest and highest of the complete months among the 12 before, and how many there were. */
  median: number;
  low: number;
  high: number;
  months: number;
  /** The same month a year before, when its data is complete. */
  lastYear?: number;
}

/** One line of a month: what it adds up to, by category group, against the months before. */
export interface MonthLine {
  id: string;
  label: string;
  amount: number;
  count: number;
  /** By category group, the largest first. */
  groups: { id: string; name: string; amount: number }[];
  compared?: MonthCompared;
}

export interface MonthPayment {
  id: string;
  date: string;
  accountId: string;
  payee: string;
  amount: number;
  category?: string;
}

/**
 * What a balance on a day is worked out from (docs/FORMULAS.md §9): the balance or valuation on its
 * day (a statement's or your own, a running balance printed beside a row, a screenshot's, or a rough
 * one you gave) and the rows since; `after` when worked back from a later one.
 */
export interface BalanceBasis {
  date: string;
  kind: 'balance' | 'running' | 'screenshot' | 'approximate';
  after?: true;
}

/** An account's value at the start and end of a month, and what the end value rests on. */
export interface MonthAccountValue {
  accountId: string;
  name: string;
  group: WrapperGroup;
  /** On the day before the month, and on its last day; null where nothing is known yet. */
  start: number | null;
  end: number | null;
  /**
   * The balance or valuation the end value is worked out from: its day, and what it was (a statement's
   * or your own balance or valuation, a running balance, a screenshot's, or a rough one you gave),
   * after the day when worked back from a later one.
   */
  basis?: BalanceBasis;
  estimated: boolean;
  /** Valued at market on a valuation more than 31 days before the month's end: its change is not the month's. */
  oldValuation?: boolean;
}

export interface MonthRegularChange {
  payee: string;
  cadence: RecurringItem['cadence'];
  amount: number;
  date: string;
  from?: number;
}

/** A month's figures, worked out by fixed rules (docs/FORMULAS.md §18). */
export interface MonthSummary {
  month: string;
  from: string;
  to: string;
  /** Every account has data for at least 90% of the month's days (§3). */
  complete: boolean;
  /** The accounts that leave days of the month without data. */
  limitedBy: { accountId: string; name: string; missingDays: number }[];
  /** Pay, other income, gifts received and uncategorised money in add up to `income` (§14); borrowing is apart. */
  moneyIn: { income: number; borrowed: number; total: number; lines: MonthLine[] };
  /** What a loan lent you or paid for you this month (cards excepted), each payment once. */
  borrowed: MonthPayment[];
  /** Scheduled, regular, one-offs, everyday and money back add up to `total` (§14). */
  spending: { total: number; lines: MonthLine[]; scheduled: MonthPayment[]; oneOffs: MonthPayment[]; compared?: MonthCompared };
  /** Income less spending. */
  net: { amount: number; compared?: MonthCompared };
  /** Money moved between your current accounts and your others, by where it went: positive is moved there. */
  moved: { id: string; label: string; amount: number }[];
  worth: {
    start: number;
    end: number;
    change: number;
    estimated: boolean;
    groups: { id: WrapperGroup; label: string; start: number; end: number }[];
    accounts: MonthAccountValue[];
  };
  quality: {
    uncategorisedSpending: number;
    uncategorisedSpendingShare: number | null;
    uncategorisedIn: number;
    uncategorisedInShare: number | null;
    /** Payments with people not decided by you (the To categorise page). */
    peopleToConfirm: { count: number; in: number; out: number };
    /** Cash and cheques paid in not decided by you: a gift, your own cash back or something else. */
    cashToConfirm: { count: number; amount: number };
    /**
     * Spending and money in the app categorised from a guess, the bank's category or the reader's,
     * that you haven't checked (not people's, cash or cheques, counted above), and their shares.
     */
    guessedSpending: number;
    guessedSpendingShare: number | null;
    guessedIn: number;
    guessedInShare: number | null;
  };
  payees: {
    /** Paid this month, and not in the 12 months before. */
    new: { payee: string; amount: number; count: number }[];
    started: MonthRegularChange[];
    stopped: MonthRegularChange[];
    priceChanged: MonthRegularChange[];
  };
  /** What your agreements have due in the 60 days after the month, in and out. */
  coming: { date: string; amount: number; direction: 'in' | 'out'; agreementId: string; name: string; label?: string }[];
}

/** The To categorise page (GET /categorise/queue): people's payments, rules to make, and what's left by payee. */
export interface CategoriseQueue {
  /** Only payments from this day on are listed (rules look at all of history). */
  from?: string;
  /** People, and cash and cheques paid in first when there are any to decide. */
  people: PersonGroup[];
  rules: RuleSuggestion[];
  payees: PayeeGroup[];
  guesses: GuessGroup[];
  counts: { people: number; rules: number; payees: number; guesses: number };
}
