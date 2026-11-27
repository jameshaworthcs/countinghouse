// Response shapes of the HTTP API, shared by the server and the web app.

import type { BooksPeriod, CompanyDeadline, CtPeriod, VatPeriod } from './company-books';
import type { AccessGroup, WrapperGroup } from './accounts';
import type { ActionState } from './actions';
import type { DirectorLoanKind } from './company';
import type { PersonSuggestion } from './people';
import type {
  InferenceProvenance,
  Account,
  Agreement,
  BalanceEvidence,
  CoverageConfirmation,
  Terms,
  TermsRate,
  TermsRateApplies,
  BalanceSnapshot,
  Category,
  BooksCoding,
  Company,
  CompanyBooks,
  CsvProfile,
  Figure,
  Goal,
  Journal,
  PensionArrangement,
  Budget,
  HoldingsSnapshot,
  ImportRecord,
  SetBy,
  Institution,
  Profile,
  Person,
  PrintedValue,
  Proposal,
  ProposedChange,
  Rule,
  Settings,
  Transaction,
  SaStatus,
  ReviewAction,
  EarmarkEffect,
  Earmarks,
  VatTreatment,
  VatBoxes,
  AccountsNotes,
  MicroEntityLines,
  OwnerNote,
} from './schema';
import type { BalanceSheetStatement, DirectorAdvances, QualificationRule, SizeTest } from './accounts-filing';
import type { AssetRegisterClass, ProfitLine, SheetLine } from './ledger';
import type { SizeLimits, TaxBand, VatFrequency, VatStagger } from './uk';

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
  /**
   * The balance is a live feed's reading, standing for today's value (docs/FORMULAS.md §9, "Live
   * readings"): when it was read, and the recorded value it stands in for.
   */
  live?: LiveFigure;
  /** A company's own account (`Account.companyId`): never in your estate or any personal figure. */
  companyId?: string;
}

/** A company's own accounts, for the Accounts page's group of them (GET /api/company-accounts). */
export interface CompanyAccountsGroup {
  company: { id: string; name: string; known: boolean };
  accounts: AccountSummary[];
  /** The same accounts as stored (dates, type, provider), for the forms and the import review. */
  records: Account[];
  /** The providers its accounts are at (one only a company's accounts are at is not among yours). */
  providers: Institution[];
}

/** A live feed's reading standing for an account's value today, beside the recorded one. */
export interface LiveFigure {
  at: string;
  feed: string;
  /** The recorded value it stands in for, and the day of the account's latest data. */
  recorded: number | null;
  recordedAsOf: string | null;
}

export interface SummaryResponse {
  asOf: string;
  estate: { value: number; assets: number; liabilities: number };
  /** Accounts whose value today is a live feed's reading (docs/FORMULAS.md §9, "Live readings"). */
  live?: { accountId: string; name: string; feed: string; at: string }[];
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
  /**
   * Stretches of [first date, last date] in which some included account was open (or may have
   * been: it has no opening date) but has no data yet, so the total leaves it out
   * (`incompleteStretches`, docs/FORMULAS.md §9). Sorted, not overlapping.
   */
  incomplete: { from: string; to: string; accounts: { id: string; name: string }[] }[];
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

/**
 * Days of a tax year you confirmed nothing is missing from with no balances to show it (an account
 * with no data, no balance after the days, or a valued account): the figure counts them as nil on
 * your word, so the tax pages list them, with the note you gave (docs/FORMULAS.md §3, "Missing days").
 */
export interface ConfirmedNilView {
  accountId: string;
  name: string;
  from: string;
  to: string;
  days: number;
  note?: string;
}

export interface AllowancesResponse {
  taxYear: { label: string; start: string; end: string; daysLeft: number | null; current: boolean };
  /**
   * `incomplete` (here and below): which accounts' data does not cover the tax year, so the amount
   * used is a minimum and what is left a maximum, in a sentence; null when the year is covered.
   * `missing`: the same days, account by account.
   */
  isa: { allowance: number; used: number; remaining: number; cashLimit: number; cashUsed: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[]; confirmedNil: ConfirmedNilView[] };
  /** `bonusEarned`: what the year's payments earn; `bonusReceived`: what came for them, wherever dated; `bonusStillDue`: the rest (FORMULAS.md §11, "LISA bonus"). */
  lisa: { allowance: number; contributed: number; remaining: number; bonusEarned: number; bonusReceived: number; bonusStillDue: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[]; confirmedNil: ConfirmedNilView[] } | null;
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
    confirmedNil: ConfirmedNilView[];
  };
  /** The allowance follows the tax band worked out from the year's income (`taxBand`). */
  savings: { interest: number; allowance: number; band: TaxBand; bandBasis: TaxBandEstimate['basis']; remaining: number; lines: AllowanceLine[]; notes: string[]; incomplete: string | null; missing: MissingDaysView[]; confirmedNil: ConfirmedNilView[] };
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
  /**
   * The year's return deadlines (UK rules: `saDeadlines`), each with whether it has passed and
   * whether what you told the app (`ownerStatus`) means it is done.
   */
  deadlines: { date: string; kind: string; what: string; passed: boolean; done: boolean }[];
  /** What you told the app about this year's Self Assessment (profile.selfAssessment). */
  ownerStatus: { sendsReturns: boolean; status?: SaStatus; updatedAt?: string; note?: string };
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
  /** The year's return box by box, for a year with forms in the catalogue (2025/26 on). */
  taxReturn: TaxReturnView | null;
  /** Hints that you may need to file. `requiresNotice`: HMRC must be told by the year's notice date (dividends over the allowance, side income over the trading allowance), not a hint it usually sorts out itself. */
  mayNeedToFile: { reason: string; detail: string; requiresNotice: boolean }[];
}

/** Where one figure on the return came from: a document's figure, a transaction, an account, HMRC's record. */
export interface ReturnTrace {
  label: string;
  amount?: number;
  date?: string;
  ref?: { type: 'figure' | 'transaction' | 'account' | 'hmrc' | 'payslip'; id: string; accountId?: string };
}

/**
 * One box on the return (docs/FORMULAS.md §20). `state`: from the records; your figure; a nil (the
 * records show none, or you confirmed none); missing (needed, not known); to check (the records' figure
 * may be incomplete); blank (does not apply).
 */
export interface ReturnBoxView {
  /** Its key in returns.json ("TR3:2", "SA102:job-oak:2"). */
  key: string;
  box: string;
  /** The printed page, where it differs from its page's ("F 3"). */
  page?: string;
  /** The form's wording, verbatim. */
  label: string;
  kind: import('./saforms').SaBoxKind;
  round?: 'down' | 'up' | 'pence';
  value: number | string | boolean | null;
  /** As you type it in online: pounds and pence (HMRC's calculation rounds income down itself), "X", "Yes" or "No". */
  entered: string;
  /** On the paper form, where it differs: whole pounds, income rounded down, expenses and tax paid up. */
  paper?: string;
  /** What the records give, when your figure replaces it. */
  fromRecords?: number | string | boolean | null;
  state: 'records' | 'yours' | 'nil' | 'missing' | 'check' | 'blank';
  basis: string;
  check?: string;
  trace: ReturnTrace[];
  notes: string[];
  editable: boolean;
  /** A nil is no answer here: the form needs a figure, a name or a Yes or No. */
  nilRefused?: boolean;
  /** Shown even when blank: a Yes/No the form says you must answer. */
  always?: boolean;
}

export interface ReturnPageView {
  id: string;
  form: 'SA100' | 'SA102' | 'SA106' | 'SA108' | 'SA110';
  page: string;
  title: string;
  /** Whose page, for one of several (the employer). */
  instance?: string;
  keyPrefix: string;
  boxes: ReturnBoxView[];
}

/** A question the return turns on: answered by you, inferred from your records, or still open. */
export interface ReturnQuestion {
  key: string;
  text: string;
  help?: string;
  /** For a question that is not yes or no. */
  choices?: { value: string; label: string }[];
  answer: number | string | boolean | null;
  state: 'answered' | 'inferred' | 'unanswered';
  inferred?: { answer: number | string | boolean | null; why: string };
  note?: string;
  /** What Counting House does when the answer is yes: works it out, takes your figures, or does not cover it. */
  coverage: 'covered' | 'figures' | 'not-covered';
  notCovered?: string;
}

export interface ReturnCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** A tax year's return, box by box, with the liability worked out from it (docs/FORMULAS.md §20). */
export interface TaxReturnView {
  taxYear: { label: string; start: string; end: string; finished: boolean };
  /** The forms the boxes are from: the year's own, or the latest before it. */
  forms: { taxYear: string; edition: string; own: boolean };
  questions: ReturnQuestion[];
  pages: ReturnPageView[];
  calculation: import('./taxcalc').TaxCalcResult;
  owed: {
    liability: number;
    deductedAtSource: number;
    /** The year's balance once tax taken off (and payments on account made) are counted: negative is a refund. */
    balance: number;
    paymentsOnAccountMade: number;
    paymentsOnAccountWhy: string;
    withoutCoding: { dueJanuary: number; dueJuly: number; poa: import('./taxcalc').TaxCalcResult['paymentsOnAccount'] };
    /** Paying the balance through next year's tax code, when it is under the limit: nothing in January for it, and no payments on account. */
    withCoding: { coded: number; dueJanuary: number; dueJuly: number; by: string } | null;
    codingOutLimit: number;
    januaryDue: string;
    julyDue: string;
    ownerStatus: SaStatus | null;
  };
  /** Ready to check and enter: nothing missing, unanswered, to check, or outside what Counting House prepares. */
  readiness: { ready: boolean; blockers: { key: string; kind: 'question' | 'missing' | 'check' | 'not-covered'; text: string }[] };
  /** The return against the rest of the app. */
  checks: ReturnCheck[];
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
  /** The value is a live feed's reading (docs/FORMULAS.md §9, "Live readings"). */
  live?: LiveFigure;
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
  /**
   * From its opening date to the day before its first data: the estate leaves it out until then.
   * Confirming nothing is missing counts it from its opening.
   */
  beforeData?: boolean;
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
  /** The data repository has a remote (it should have none): what to do, and whether its host can be public. */
  remotes?: { warning: string; public: boolean };
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
  /** Director's loans with a warning today (docs/UK_RULES.md, "Companies"): you owe the company, or owed it more than the benefit threshold this tax year. */
  directorLoans?: { accountId: string; name: string; companyName: string; balance: number | null; warnings: DirectorLoanWarning[] }[];
  /** Payments marked as money with your company whose mark no longer fits (shared/company.ts): it counts for nothing until you change it. */
  marksThatDoNotCount?: { transactionId: string; accountId: string; name: string; date: string; amount: number; description: string; problem: string }[];
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
  /** Your pots of money set aside (earmarks.json): none without the file, so nothing about them shows. */
  earmarks: { id: string; name: string }[];
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
  /** A market account's total paid in, when known (FORMULAS.md §12): a document's, or its flows from the start. */
  paidIn?: { amount: number; source: 'provider' | 'transactions'; asOf?: string };
  /** A company's account: its own coverage grid (it is never in GET /api/coverage, which is yours). */
  coverage?: CoverageResponse;
  /** A director's loan account: its company, its movements (the payments you marked) and its warnings. */
  directorLoan?: DirectorLoanView;
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
/** One movement of a director's loan (analytics/director-loan.ts), from the row of yours it comes from. */
export interface DirectorLoanMovement {
  /** `dlm_` and its source's own id (a row's hex, a journal's id): the same every time it is worked out. */
  id: string;
  /**
   * Where it comes from: a row of yours you marked (`mark`); or, once the company's books are kept here
   * (FORMULAS.md §22), a company account's own row coded to the director's loan or linked to a loan of
   * yours (`company-row`), a journal's lines on it (`journal`), or the fee a link's two sides differ by
   * (`link-fee`).
   */
  source: 'mark' | 'company-row' | 'journal' | 'link-fee';
  /** The row it comes from (yours, or the company's), and its account; none for a journal. */
  transactionId?: string;
  accountId?: string;
  /** A journal's. */
  journalId?: string;
  date: string;
  /** Signed from your side: positive grows what the company owes you. A row of yours: its amount, negated. */
  amount: number;
  /** A row of yours: its mark. */
  as?: 'paid-for' | 'loan';
  kind: DirectorLoanKind;
  description: string;
  payee?: string;
}

/** A director's loan's warnings (docs/UK_RULES.md, "Companies"). */
export interface DirectorLoanWarning {
  kind: 's455' | 'beneficial-loan';
  title: string;
  detail: string;
}

/** A director's loan account's own part of its page. No company: no company names it yet. */
export interface DirectorLoanView {
  company?: { id: string; name: string };
  /** Newest first. */
  movements: (DirectorLoanMovement & { accountName: string })[];
  warnings: DirectorLoanWarning[];
  /** The most you owed the company on a day of this tax year, when you owed it any. */
  owedMost?: { amount: number; date: string };
}

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
  /** Its mark of money with a company of yours, as it is now (a decided proposal: as it was). */
  company?: Transaction['company'];
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
  /** A return's box or question set: what it is, and the value as you would enter it. */
  returnEntry?: { what: string; value: string };
  /** Set aside: what the change does, in words, and the decision of yours it replaces. */
  earmark?: { what: string; replaces?: string };
  /** A mark set or taken away: the company's name, and the mark it replaces, in words. */
  mark?: { company?: string; was?: string };
  /** A company's books set up, or a filing recorded: what the change does, in words. */
  books?: { what: string };
}

/** Set aside's figures, for a proposal's effect: before it and as it would leave them. */
export interface EarmarkFigures {
  setAside: number;
  spendable: number;
  toCheck: number;
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
  /** What it would do to the money set aside (only when it changes it): the figures now, and after it. */
  earmarks?: { before: EarmarkFigures | null; after: EarmarkFigures | null };
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
  /** What the changes kept would do to the money set aside. */
  earmarks?: { before: EarmarkFigures | null; after: EarmarkFigures | null };
}

export interface SystemResponse {
  version: string;
  dataDir: string;
  inboxDir: string;
  workDir: string;
  formatVersion: number;
  engines: {
    id: string;
    available: boolean;
    detail: string;
    external: boolean;
    /** The local model service: each alias's state, and who holds its GPU. */
    health?: { status: string; aliases: Record<string, { state: string; queued?: number; in_flight?: number }>; gpu?: { resident?: string; lease?: { state: string; until?: string } } };
  }[];
  /** The engine documents are read with (Settings → Models). */
  selectedEngine: string | null;
  git: { enabled: boolean; branch?: string; dirty: number; ahead?: number; behind?: number; remote?: string; lastCommit?: { hash: string; date: string; subject: string }; lastError?: string; remotes?: { name: string; url: string; public: boolean }[]; remoteWarning?: string };
  inbox: { dir: string; lastError?: string };
  auth: { configured: boolean; method: 'oidc' | 'password' | null; provider: string | null; user: string | null };
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
  /** The server's host name: a new token's name says where its agent runs ("Claude Code on …"). */
  host: string;
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

// ─── Set aside (docs/FORMULAS.md §21) ────────────────────────────────────────────────────────────

/** Why a payment counts as it does in a pot. */
export type EarmarkBy = 'decision' | 'rule' | 'default' | 'suggested';

export interface EarmarkRow {
  transactionId: string;
  date: string;
  accountId: string;
  description: string;
  /** The payment's amount, signed. */
  amount: number;
  /** What counts towards this line, signed like the payment. */
  counted: number;
  by: EarmarkBy;
  ruleId?: string;
  ruleName?: string;
  reason?: string;
}

export interface EarmarkLine {
  effect: EarmarkEffect;
  /** Signed: what it did to the money set aside (0 for your own money). */
  total: number;
  /** Money in and out under it. */
  in: number;
  out: number;
  count: number;
  /** The payments behind it; none listed for your own everyday money (too many), only its totals. */
  rows: EarmarkRow[];
}

export type EarmarkCheckKind = 'more-than-held' | 'missing-other-side' | 'stale-decision';

/** Something to check: the app can't tell, and has counted its suggestion (or the default) meanwhile. */
export interface EarmarkToCheck {
  kind: EarmarkCheckKind;
  pot: string;
  date: string;
  transactionIds: string[];
  /** Plain words: what is asked and why. */
  question: string;
  /** What is counted meanwhile, per payment. */
  suggestion?: { transactionId: string; parts: { effect: EarmarkEffect; amount: number }[] }[];
  /** How much of the set-aside figure rests on it (pounds, positive). */
  amount: number;
}

export interface EarmarkPotResult {
  id: string;
  name: string;
  purpose?: string;
  start: string;
  opening: number;
  /** Set aside in the everyday accounts now (negative: you've covered that much for the pot). */
  setAside: number;
  lines: EarmarkLine[];
  /** How much of `setAside` rests on payments still to check. */
  provisional: number;
  checks: { at: string; setAside: number; spendable: number }[];
  /** What each rule limited to its sources could still pay, by rule id (only those with something left). */
  allowances: Record<string, number>;
}

export interface EarmarkAccount {
  accountId: string;
  name: string;
  role: 'everyday' | 'set-aside';
  balance: number;
  /** The latest day it has data for: its figures run to here. */
  asOf: string | null;
  /** Closed: it has no later data to wait for. */
  closed: boolean;
  stale: boolean;
}

export interface EarmarksResult {
  accounts: EarmarkAccount[];
  /** The everyday accounts' balances, each to its own latest day. */
  everydayTotal: number;
  /** Money between two everyday accounts seen leaving one but not yet arriving (its statements end sooner), or the other way round. */
  onItsWay: { transactionId: string; date: string; accountId: string; otherAccountId: string; amount: number }[];
  onItsWayTotal: number;
  pots: EarmarkPotResult[];
  /** Everyday total + on its way − every pot's set aside. */
  spendable: number;
  /** What the set-aside accounts hold, each to its own latest day. */
  heldInSetAside: number;
  /** The oldest and newest latest days among the everyday accounts. */
  oldest: string | null;
  newest: string | null;
  toCheck: EarmarkToCheck[];
  /** The lowest spendable since the start, for information: short dips are fine. */
  lowest: { date: string; spendable: number } | null;
  /** Weekly, for a chart. */
  series: { date: string; spendable: number; setAside: number; total: number }[];
  /** Payments between everyday accounts, paired so they change nothing. */
  internal: { count: number };
}

export interface EarmarksResponse {
  setup: Earmarks | null;
  result: EarmarksResult | null;
  /** Why there is no figure: the setup can't be worked out as it is. */
  problems: string[];
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
  /** The document the payslip was read from, when it is kept: served by id at /api/documents/:id. */
  document?: { id: string; fileName: string; mediaType: string; importId: string };
  /** The payment into your bank matched to it. */
  paidIn: { amount: number; date: string; transactionId: string; accountId: string } | null;
  /** What the payslip's other deductions come to: expected net less what arrived. */
  otherDeductions: number | null;
  /** Pay sent early that the payslip takes back (a salary advance): its deduction line as printed and the payment (FORMULAS §17). */
  advanced?: { label: string; amount: number; date: string; transactionId: string; accountId: string }[];
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
  /** The payslip's pay that came early, as an advance it takes back. */
  advanced?: { label: string; amount: number; date: string; transactionId: string; accountId: string }[];
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
  /** The company as you hold it: never its books (its own records, served by its own routes). */
  company: Omit<Company, 'books'>;
  /** Its value now: the latest balance on its account (each valuation is recorded as one). */
  value?: { amount: number; date: string; approximate: boolean };
  /** The latest valuation, and how it was worked out. */
  valuation?: Company['valuations'][number];
  /** Each dividend: a voucher (with the credit that paid it, when found), or a credit with no voucher. */
  dividends: { date: string; amount: number; taxYear?: string; figureId?: string; importId?: string; paidIn?: { transactionId: string; accountId: string; date: string } }[];
  dividendsTotal: number;
  /** Your director's loan with it (`directorLoanAccountId`): what it owes you now (negative: you owe it). */
  directorLoan?: { accountId: string; name: string; balance: number | null; asOf: string | null; estimated: boolean };
}

/**
 * GET /companies/:id/books: a company's own records, its periods and deadlines (FORMULAS.md §22). The
 * company's, served apart from every personal route.
 */
export interface CompanyBooksResponse {
  company: { id: string; name: string; number?: string };
  /** Its books: null until you keep them here. */
  books: CompanyBooks | null;
  /** The accounting reference date the periods are worked out from, and whether it is the default (CA 2006 s391(4)). */
  accountingReferenceDate: { value: string; isDefault: boolean } | null;
  /** Its periods, as worked out up to the ones containing today. */
  periods: { accounts: BooksPeriod[]; ct: CtPeriod[]; vat: Omit<VatPeriod, 'filing'>[] };
  deadlines: CompanyDeadline[];
  /** What is wrong with its books (a hand edit), in words. */
  problems: string[];
  /**
   * When it came within the charge to Corporation Tax, as its CT periods are worked out from (null:
   * dormant for Corporation Tax); `assumed` when the books do not say and incorporation is taken.
   */
  withinCharge: { from: string | null; assumed: boolean } | null;
  /** Your director's loan with it: what it owes you now (your own account). */
  directorLoan?: CompanyView['directorLoan'];
}

/**
 * A posting of a company's general ledger (FORMULAS.md §22, "The general ledger"): one side of what a
 * source means to the company, in integer pence, debits positive. The postings of one source add up to
 * nothing.
 */
export interface LedgerPosting {
  /** `<source kind>:<source id>:<n>`: the same every time it is worked out. */
  id: string;
  date: string;
  ledger: string;
  /** Pence, debit positive. */
  amount: number;
  /**
   * What it comes from: a company account's row (`row`); a row of yours paid for the company or lent to
   * it (`personal`); a journal (`journal`, with its `line`); a transfer between two of the company's own
   * accounts (`transfer`, the group's id); the fee a link's two sides differ by (`link`, its row of yours).
   * `line`: the coding's or journal's line. Worked out at a period's end (FORMULAS.md §22, "At a
   * period's end"): a fixed asset's depreciation for the period (`depreciation`, `<asset id>@<period
   * end>`), its disposal (`disposal`, its asset id), and the part of a posting with `covers` carried to
   * the balance sheet at a period end and back the next day (`deferral`, `<posting id>@<period end>`).
   */
  source: { kind: 'row' | 'personal' | 'journal' | 'transfer' | 'link' | 'depreciation' | 'disposal' | 'deferral'; id: string; line?: number };
  /** Its VAT: the treatment, input (reclaimed) or output (charged), and whether this is the net amount or the tax. */
  vat?: { treatment: VatTreatment; side: 'input' | 'output'; part: 'net' | 'tax'; claim?: 'reg111' };
  covers?: { from: string; to: string };
  asset?: { class: AssetRegisterClass; months?: number; connected?: boolean; disposedOn?: string; residual?: number; marketValue?: number; proceeds?: number; pool?: 'main' | 'special'; used?: boolean; allowance?: 'aia' | 'first-year' | 'none' };
  /** On a credit to a fixed asset's cost: the asset on the register whose cost it reduces. */
  reduces?: string;
  /** Beside `covers`: the day it was invoiced (an amount not yet paid at a period end is then a trade creditor or debtor). */
  invoicedOn?: string;
  memo: string;
}

/**
 * A fixed (or intangible) asset on a company's register (FORMULAS.md §22, "Depreciation"): one posting
 * to a fixed asset's cost that says it is one (`asset`), its cost that posting's amount (net of VAT).
 */
export interface FixedAsset {
  /** `<source kind>:<source id>[:<line>]`: the posting's source and line, the same every time. */
  id: string;
  source: LedgerPosting['source'];
  /** The cost code it is on, and its depreciation (or amortisation) code. */
  ledger: string;
  depreciationLedger: string;
  class: AssetRegisterClass;
  /** Pence, positive. */
  cost: number;
  /** The day it was posted (taken in), and the day depreciation counts from: the ledger's first day for one brought in on an opening journal. */
  acquired: string;
  from: string;
  /** Its life in months when it counts from: its own, or the company's policy for its class; none: no policy then (a check when none ever is), and no depreciation. */
  months?: number;
  life: 'asset' | 'policy' | 'none';
  /** Its life over time: the first from `from`, each later one a policy taking effect (a change in estimate, written forward). */
  lives: { from: string; months?: number }[];
  /** Pence: what it is expected to fetch at the end of its life. */
  residual?: number;
  /** Credits that reduced its cost (pence, positive), each with the posting it came from. */
  reductions: { date: string; amount: number; source: LedgerPosting['source'] }[];
  disposedOn?: string;
  /** How months were counted: a full month on acquisition and none on disposal, or a full month on both (`books.depreciationMonths`). */
  convention: 'acquisition' | 'both';
  memo: string;
  /** Brought in on an opening journal dated before the books' first day (books taken over mid-life): it counts from that first day. */
  broughtIn?: true;
  /** On an opening journal, whatever its day: for tax, an asset brought in (in the pools brought forward), never one bought in these books. */
  opening?: true;
  /** For Corporation Tax (`asset`'s own fields): bought from a connected person, its market value then and what it fetched when it left (pence), its pool, not new and unused, and the allowance chosen for it. */
  tax?: { connected?: true; marketValue?: number; proceeds?: number; pool?: 'main' | 'special'; used?: true; allowance?: 'aia' | 'first-year' | 'none' };
}

/** What the ledger asks of you: a row to code, a missing side, a link that does not fit, money maybe counted twice. */
export type LedgerCheck =
  | { kind: 'uncoded'; transactionId: string; accountId: string; date: string; amount: number; description: string; side: 'company' | 'paid-for'; leftUncoded?: true }
  | { kind: 'coding-invalid'; transactionId: string; accountId: string; date: string; amount: number; description: string; problem: string }
  | { kind: 'bank-not-imported'; transactionId: string; accountId: string; date: string; amount: number; description: string }
  | { kind: 'transfer-unmatched'; transactionId: string; accountId: string; date: string; amount: number; description: string }
  | { kind: 'foreign-currency'; transactionId: string; accountId: string; date: string; amount: number; description: string; currency: string }
  | { kind: 'possible-double-count'; personalId: string; companyRowId: string; date: string; amount: number; description: string }
  | { kind: 'link-invalid'; companyRowIds: string[]; personalIds: string[]; problem: string }
  | { kind: 'journal-invalid'; journalId: string; date: string; memo: string; problem: string }
  | { kind: 'vat-unregistered'; source: LedgerPosting['source']; date: string; amount: number }
  | { kind: 'reg111'; source: LedgerPosting['source']; date: string; problem: string }
  | { kind: 'reverse-charge-rate'; source: LedgerPosting['source']; date: string; amount: number; expected: number }
  | { kind: 'vat-no-invoice'; transactionId: string; accountId: string; date: string; amount: number; description: string }
  | { kind: 'journal-double-count'; journalId: string; personalId: string; date: string; amount: number; description: string }
  | { kind: 'loan-balance-differs'; balanceId: string; date: string; recorded: number; ledger: number; difference: number }
  | { kind: 'unbalanced'; source: LedgerPosting['source']; amount: number }
  /** A fixed asset with no life of its own and no policy for its class: not depreciated. */
  | { kind: 'no-depreciation-policy'; assetId: string; source: LedgerPosting['source']; date: string; amount: number; class: AssetRegisterClass; memo: string }
  /** A posting to a fixed asset's cost that does not say it is one (`asset`): it is not on the register, so never depreciated. */
  | { kind: 'fixed-asset-unmarked'; source: LedgerPosting['source']; date: string; ledger: string; amount: number; memo: string }
  /** A fixed asset that does not fit (disposed of before it was bought), or a posting to a depreciation code written by hand. */
  | { kind: 'fixed-asset-invalid'; source: LedgerPosting['source']; date: string; problem: string }
  /** A dividend more than the profit and loss reserve on the day it was paid (CA 2006 s830: profits available for distribution); `available` the reserve before it. */
  | { kind: 'dividend-exceeds-reserves'; source: LedgerPosting['source']; date: string; amount: number; available: number }
  /** A period said on a code that is not income or an expense: it is posted as it is, not spread. */
  | { kind: 'covers-not-spread'; source: LedgerPosting['source']; date: string; ledger: string; amount: number };

/** GET /companies/:id/ledger: a company's postings in a date range, what is posted to each ledger there, and the ledger's checks. */
export interface CompanyLedgerResponse {
  company: { id: string; name: string };
  from: string | null;
  to: string | null;
  postings: LedgerPosting[];
  /** By ledger, the postings in the range added up (pence, debit positive). */
  totals: { ledger: string; debit: number; credit: number; net: number }[];
  checks: LedgerCheck[];
  /** The company's own accounts, with the ledger each posts to. */
  accounts: { id: string; name: string; ledger: string }[];
}

// ─── A company's accounts for a period (analytics/period-accounts.ts, FORMULAS.md §22) ───────────

/** A code's figure on a report line, in pence: signed as the line presents it (an asset's debit, a creditor's credit, a P&L line's part of the profit). */
export interface ReportCode {
  ledger: string;
  name: string;
  amount: number;
}

/** An accounting period the Accounts tab can show. */
export interface AccountsPeriodChoice {
  start: string;
  end: string;
  /** Its last day has passed (as on today): a period not ended is shown as at its end, from what is recorded so far. */
  ended: boolean;
  /** Its accounts as recorded filed, and whether the filing gives lines to compare. */
  filed?: { filedOn: string; reference?: string; lines: boolean };
}

/** The micro-entity profit and loss account for a period (pence: income positive, charges negative, each line's part of the profit). */
export interface ProfitAndLoss {
  /** `prior`: the line for the period before (pence), when its profit and loss is in these books. */
  lines: { line: ProfitLine; label: string; amount: number; codes: ReportCode[]; prior?: number }[];
  /** Lines A to F together. */
  profitBeforeTax: number;
  /** Line G: the Corporation Tax charge posted for the period (a journal: the computation, analytics/corporation-tax.ts, posts nothing). */
  tax: number;
  /** H: the profit or loss for the period, after tax. */
  profit: number;
  /** The same for the period before, when its profit and loss is in these books. */
  prior?: { profitBeforeTax: number; tax: number; profit: number };
}

/** A balance sheet line, exact (pence) and in whole pounds as Companies House takes it. */
export interface SheetFigure {
  exact: number;
  whole: number;
}

/** The micro-entity balance sheet at a period's end (format 1, lines A to K). */
export interface BalanceSheet {
  /**
   * Lines A to K: A–E and H–J from their codes (an asset line's debit balances, a creditor line's credit
   * balances, both positive when they are what the line says), each rounded to the pound; F, G and K
   * worked out from the rounded lines (F = C + D − E, G = A + B + F, K = G − H − I − J).
   */
  lines: ({
    line: SheetLine | 'F' | 'G';
    label: string;
    codes: ReportCode[];
    /** B and C: the sub-lines Companies House's form totals them from when a breakdown is entered, each rounded, the line their sum in whole pounds. */
    parts?: ({ label: string; codes: ReportCode[]; /** At the end of the period before, in whole pounds, where it is worked out (never from a filing, which records only the lines). */ prior?: number } & SheetFigure)[];
    /** The line at the end of the period before, in whole pounds (as filed, or worked out). */
    prior?: number;
  } & SheetFigure)[];
  /**
   * Capital and reserves: called-up share capital, share premium and other reserves, each rounded, and
   * the profit and loss reserve (K less them, in whole pounds), with the period before's beside each.
   */
  capital: {
    shareCapital: SheetFigure & { prior?: number };
    sharePremium: SheetFigure & { prior?: number };
    otherReserves: SheetFigure & { prior?: number };
    reserve: SheetFigure & { opening: number; profit: number; dividends: number; other: number; prior?: number };
    total: SheetFigure & { prior?: number };
  };
  /** Net assets (K worked out from the lines) is capital and reserves, to the penny. */
  balances: boolean;
}

/** Every code's balance at a period's end, profit and loss codes for the period alone and retained earnings at its start (pence). */
export interface TrialBalance {
  rows: { ledger: string; name: string; debit: number; credit: number }[];
  debit: number;
  credit: number;
}

/** A fixed asset on the register at a period's end (pence). */
export interface RegisterRow extends FixedAsset {
  /** Depreciation to the period's start, for the period, and to its end (to the day it left, if it left in the period). */
  before: number;
  charge: number;
  toDate: number;
  /** Its cost at the period's end, after any reductions. */
  costAtEnd: number;
  /** Cost (after reductions) less depreciation to date; 0 once it has left. */
  netBookValue: number;
  /** It left the company in this period: its cost and depreciation were taken away, its net book value then posted to disposals. */
  disposedInPeriod: boolean;
}

/** One movement of the director's loan in a period, in your sign (positive: what the company owes you grows). */
export interface LoanStatementMovement {
  date: string;
  description: string;
  kind: DirectorLoanKind;
  source: DirectorLoanMovement['source'];
  amount: number;
}

/** The director's loan over a period (pence), in your sign, with the books' (debit positive) beside it. */
export interface LoanStatement {
  opening: number;
  closing: number;
  movements: LoanStatementMovement[];
  /** The same in the company's books: the loan's balance, debit positive (a credit: it owes you). */
  books: { opening: number; closing: number };
}

/** A company account's ledger at a period's end against its balance from the balance engine (pence). */
export interface BankReconciliation {
  accountId: string;
  name: string;
  ledger: string;
  /** The ledger's balance (debit positive: what the account holds; a card or loan owed is negative, as on its page). */
  books: number;
  /** The balance engine's on the day, from its statements; null when none is known then. */
  statement: number | null;
  difference: number | null;
  /**
   * reconciled: a statement balance on the day (or the first after it, the rows between adding up from
   * the one before) agrees with the books; differs: it does not; unverified: no such balance, and the
   * account moved in the period or holds a balance (a block: record its statement balance on its page);
   * dormant: no such balance, nothing moved and nothing held (said, not a block); other-currency: not in
   * pounds.
   */
  status: 'reconciled' | 'differs' | 'unverified' | 'dormant' | 'other-currency';
  /** The statement balance it was settled by. */
  basis?: { date: string; on: boolean };
}

/** What stops a period's accounts being ready. */
export type AccountsCheck =
  | { kind: 'not-ended'; end: string }
  | { kind: 'ledger'; check: LedgerCheck }
  /** A clearing code (suspense, the bank not imported) with a balance at the period end. */
  | { kind: 'clearing'; ledger: string; amount: number }
  | { kind: 'trial-balance'; debit: number; credit: number }
  | { kind: 'sheet'; netAssets: number; capital: number }
  | { kind: 'bank'; reconciliation: BankReconciliation }
  /** The accounts filed for the period give lines that the books no longer work out to. */
  | { kind: 'drift'; lines: { line: string; filed: number; computed: number }[] };

/** GET /companies/:id/accounts?period=<end>: a company's accounts for one accounting period, worked out from its ledger. */
export interface CompanyAccountsResponse {
  company: { id: string; name: string };
  /** The periods it can show, newest first: those its ledger reaches, up to the one containing today. */
  periods: AccountsPeriodChoice[];
  period: AccountsPeriodChoice & { first: boolean };
  /** The period before, shown beside it (FRS 105 para 3.7): its balance sheet as filed when its accounts are recorded with lines (a line left blank as worked out), else worked out; its profit and loss when it is in these books. */
  comparative?: { start: string; end: string; sheet: 'filed' | 'computed'; profit: boolean };
  /** The books are locked through this day (books.lockedThrough). */
  lockedThrough?: string;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  trialBalance: TrialBalance;
  register: RegisterRow[];
  /** Your director's loan with it, when the company names one. */
  directorLoan: LoanStatement | null;
  reconciliation: BankReconciliation[];
  /** What stops it being ready; none: ready (and ended). */
  checks: AccountsCheck[];
  ready: boolean;
  /** The accounts filed for it: the lines filed against those worked out now. */
  filing?: { filedOn: string; reference?: string; lines: { line: string; filed: number; computed: number }[]; matches: boolean };
}

// ─── Filing a company's accounts (analytics/accounts-filing.ts, FORMULAS.md §22, "Filing the accounts") ──

/** A line of the filing sheet, in the order and words of Companies House's micro-entity form (whole pounds). */
export interface FilingSheetLine {
  /** `A`–`K`, `B:<sub-line>`, `C:<sub-line>`, or a capital and reserves item. */
  key: string;
  /** Its micro-entity balance sheet line, for A–K and their sub-lines. */
  line?: string;
  label: string;
  whole: number;
  /** Pence: the exact figure it is rounded from (a total: worked out from the exact lines). */
  exact: number;
  /** At the end of the period before, in whole pounds (as filed or worked out); absent when not known. */
  prior?: number;
  /** A sub-line of the line after it: the form takes a breakdown but does not ask for one. */
  sub?: boolean;
  /** Worked out from the lines entered, never entered itself (F, G, K, shareholders' funds). */
  total?: boolean;
  working?: string;
  note?: string;
  /** The codes it comes from, with their exact balances (pence). */
  trace: ReportCode[];
}

/** Whether a company qualifies for one size of company in the period (micro-entity: CA 2006 s384A; small: s382), with each year's test. */
export interface EligibilityView {
  kind: 'micro' | 'small';
  limits: SizeLimits;
  qualifies?: boolean;
  rule: QualificationRule;
  years: SizeTest[];
}

export type FilingGateKey = 'ended' | 'accounts' | 'employees' | 'notes' | 'number' | 'particulars' | 'eligibility';
export interface FilingGateItem {
  key: FilingGateKey;
  ok: boolean;
  label: string;
  detail: string;
}

/** One accounting period's micro-entity accounts as the company files them (FORMULAS.md §22, "Filing the accounts"). */
export interface CompanyFilingResponse {
  company: { id: string; name: string; number?: string };
  periods: AccountsPeriodChoice[];
  period: AccountsPeriodChoice & { first: boolean };
  /** How accounts reach Companies House on the day: WebFiling until software-only filing begins (`ACCOUNTS_FILING_CHANNEL_RULES`). */
  channel: { webFiling: boolean; softwareOnlyFrom: string; enhancedAuditStatement: boolean; enhancedStatementFrom: string; identity: { directorsFrom: string; presentersNotBefore: string } };
  accounts: { ready: boolean; checks: number; lockedThrough?: string };
  comparative?: { start: string; end: string; sheet: 'filed' | 'computed' };
  /** Lines A–K and the sub-lines of B and C, in the form's order. */
  sheet: FilingSheetLine[];
  capital: FilingSheetLine[];
  /** Lines A–K in whole pounds, as a filing records them. */
  lines: Required<MicroEntityLines>;
  rounding: string;
  notes: {
    offBalanceSheet: OwnerNote | null;
    commitments: OwnerNote | null;
    directors: OwnerNote | null;
    /** `prior`: the period before's, beside it (FRS 105 paras 3.7, 3.10), when there is a period before. */
    employees: { average: number | null; prior?: number | null; hint?: { paye: boolean; months: number; payrollMonths: number; staffCosts: number; onePerson: number } };
    /** The period before's commitments as confirmed, when there is a period before. */
    commitmentsPrior?: OwnerNote | null;
    advances: DirectorAdvances & { loan: boolean; given: NonNullable<AccountsNotes['advances']> | null };
  };
  /** The particulars you confirmed (CA 2006 s396(A1)); the number is the company's, the registered office the filing's. */
  particulars: NonNullable<AccountsNotes['particulars']> | null;
  statements: BalanceSheetStatement[];
  approval: { line: string };
  /** Accounting policies in words from the books: optional for a micro-entity. */
  policies: string[];
  eligibility: {
    /** The limits' row, by the period's first day; `covered`: false before the first row. */
    from: string;
    covered: boolean;
    /** The first day of a financial year the limits cover. */
    coveredFrom: string;
    micro: EligibilityView;
    small: EligibilityView;
    notExcluded: boolean | null;
    previousQualified: boolean | null;
    /** Whether to ask you if it qualified for the period before: the books cannot work that out, and your answer would settle this one. Your answer is shown, and used, only then. */
    askPrevious: boolean;
    /** The years before this one (up to three), with the average employees you gave for each: the size test reads them. */
    earlier: { start: string; end: string; employees: number | null }[];
    exclusions: { key: string; text: string; source: string }[];
  };
  gate: FilingGateItem[];
  /** Every item of the gate is done, and the accounts are not recorded as filed. */
  ready: boolean;
  filing?: { filedOn: string; reference?: string; approvedOn?: string; approvedBy?: string; registeredOffice?: string; lines: { line: string; filed: number; computed: number }[]; matches: boolean };
  /** The book value of your shares at the period's end (FORMULAS.md §9): offered, never recorded by itself. */
  bookValue: { asOf: string; netAssets: number; why?: string; shares?: number; shareClass?: string; totalShares?: number; value?: number; caveats: string[]; recorded?: { value: number; netAssets?: number } };
  disclaimer: string;
}

// ─── A company's VAT returns (analytics/vat-return.ts, FORMULAS.md §22, "VAT returns") ──────────────

/** A VAT return's box, by the name HMRC's Making Tax Digital API gives it (`VatBoxes`). */
export type VatBoxKey = keyof VatBoxes;

/** A posting's part in a box of a VAT return: the working behind the box. */
export interface VatBoxLine {
  postingId: string;
  source: LedgerPosting['source'];
  /** The posting's own day (its payment's, under cash accounting). */
  date: string;
  /**
   * Why it is in this return though its day is not in the period: a claim of VAT from before
   * registration (`reg111`, the first return), or a reverse charge's tax point (`tax-point`, VAT
   * Regulations 1995 reg 82: the end of the period it covers when that comes before it was paid, or a
   * year's end for a continuous supply neither paid nor invoiced).
   */
  counted?: 'reg111' | 'tax-point';
  ledger: string;
  treatment?: VatTreatment;
  /** What it adds to the box, in pence (a refund or a credit note takes away). */
  amount: number;
  memo: string;
}

export interface VatBoxView {
  /** 1 to 9. */
  box: number;
  key: VatBoxKey;
  label: string;
  /** Boxes 1–5 in pence; boxes 6–9 in whole pounds, the pence left out. */
  value: number;
  /** Boxes 6–9: the exact value in pence, before the pence are left out. */
  exact?: number;
  lines: VatBoxLine[];
  /** Boxes 2, 8 and 9 (goods between Northern Ireland and the EU): not supported, so 0. */
  unsupported?: true;
}

/**
 * A posting to a sales or purchase code left out of boxes 6 and 7: outside the scope, not a supply
 * (`outside`), not a supply by its code (`not-a-supply`: wages, pensions, depreciation, Corporation Tax,
 * penalties, donations), or no VAT treatment said (`untreated`).
 */
export interface VatLeftOut extends VatBoxLine {
  reason: 'outside' | 'not-a-supply' | 'untreated';
  side: 'sales' | 'purchases';
}

/** What stops a VAT return being ready to file. */
export type VatReturnCheck =
  | { kind: 'not-ended'; end: string }
  /** The books start after the period does: what came before is not in them. */
  | { kind: 'not-in-books'; ledgerFrom: string }
  /** A ledger check on something that belongs to this return (an uncoded row, a loan not imported, VAT with no invoice…). */
  | { kind: 'ledger'; check: LedgerCheck }
  /** Rows posted to suspense in the period, net (pence): not coded, so their VAT is not known. */
  | { kind: 'suspense'; amount: number }
  /**
   * Taxable supplies in the 12 months to the period's end (or an earlier period's) reached the cash
   * accounting scheme's limit for leaving (pence; the limit in pounds): the scheme ends with that period,
   * and the VAT on everything outstanding is due (VAT Notice 731 paras 2.5 and 6.4), which the books do
   * not work out.
   */
  | { kind: 'cash-limit'; periodEnd: string; turnover: number; limit: number };

/** open: not ended; not-ready: ended, not filed, a check stops it; ready: ended, nothing stops it; filed and filed late: recorded; before-books: not filed and not in the books. */
export type VatPeriodStatus = 'open' | 'not-ready' | 'ready' | 'filed' | 'filed-late' | 'before-books';

/** One VAT period, as the VAT tab lists it. */
export interface VatPeriodRow {
  start: string;
  end: string;
  due: string;
  stagger: VatStagger;
  status: VatPeriodStatus;
  /** Not filed, and its due day has passed. */
  overdue: boolean;
  /** The first return after registration (reg 111 claims fall in it), and the last before deregistration. */
  first: boolean;
  final: boolean;
  /** The books' net VAT, box 3 less box 4 in pence (positive to pay, negative to reclaim); null when the books do not cover the period. */
  computed: number | null;
  /** The return filed for its own period: its box 3 less box 4, less the corrections of earlier returns it included, in pence (on the same basis as `computed`); null without figures. */
  filed: number | null;
  /** The corrections of earlier returns its filing included, net, in pence (positive: due to HMRC). */
  correctionsIncluded?: number;
  filedOn?: string;
  reference?: string;
  /** The filing recorded for it. */
  filingId?: string;
  /** The filing's boxes differ from what the books give (with the corrections it included). */
  differs?: boolean;
}

/** A return filed, against what the books give for its period. */
export interface VatFiledComparison {
  filedOn: string;
  reference?: string;
  late: boolean;
  /** Errors on earlier returns it corrected, in its boxes 1 (positive) and 4 (negative): pence. */
  corrections: { periodEnd: string; amount: number }[];
  /** Each box: as filed, as the books give it, as the filing should show with its corrections (`expected`), and filed less expected. Boxes 1–5 pence, 6–9 whole pounds. */
  boxes: { box: number; key: VatBoxKey; filed: number; computed: number; expected: number; difference: number }[];
  matches: boolean;
  /** Likely causes of the differences, where they can be told. */
  causes: string[];
}

/** One VAT return worked out from the books (FORMULAS.md §22, "VAT returns"). */
export interface VatReturnView {
  period: VatPeriodRow;
  /** The nine boxes, with their working. */
  boxes: VatBoxView[];
  /** Box 5's direction: box 3 more than box 4 is to pay. */
  direction: 'pay' | 'reclaim' | 'nil';
  /** Whether the books reach the period at all (a period before them shows only what was filed). */
  inBooks: boolean;
  checks: VatReturnCheck[];
  /** Ended, and nothing stops it. */
  ready: boolean;
  leftOut: VatLeftOut[];
  /** What it does not cover, in words (a final return's stock and assets, say). */
  notes: string[];
  filed?: VatFiledComparison;
  /**
   * For a return with VAT to pay (box 5), the late payment penalties if none of it were paid by its due
   * day (Finance Act 2021 Sch 26), as information: what the first penalty would be at day 15 and day 30
   * (pence), and the yearly rate of the second from its day. `rates: null` when the due day is before the
   * rates covered. Interest is not worked out.
   */
  latePayment?: { due: string; rates: { graceDays: number; firstPercent: number; secondDays: number; secondPercent: number; dailyFromDay: number; yearlyPercent: number } | null; atFirst: number; atSecond: number };
}

/** A filed return's error, as the books find it (VAT Notice 700/45). */
export interface VatErrorRow {
  start: string;
  end: string;
  due: string;
  /** The net VAT error in pence, as HMRC sees it: positive, the return declared too little. Its parts: output tax (box 1) and input tax (box 4, positive when too much was claimed). */
  error: number;
  output: number;
  input: number;
  /** Corrected since: on later returns, or reported separately (pence, signed as the error). */
  correctedBy: ({ kind: 'return'; periodEnd: string; amount: number } | { kind: 'separately'; on: string; amount: number; reference?: string })[];
  uncorrected: number;
  /** What of it counts towards the net: the parts still in time, less what was corrected (pence). */
  counted: number;
  /** The uncorrected errors that count up to and including this one, added up. */
  runningTotal: number;
  /** The last day each part may be corrected (4 years, VAT Notice 700/45 para 4.7): output tax, and input tax claimed too much, from the period's end; input tax under-claimed from the return's due day. */
  outputUntil: string;
  inputUntil: string;
  /** Every part that is not nothing is out of time. */
  outOfTime: boolean;
  /** The books for the period have checks to clear: the difference may be theirs, so it is not counted. */
  unsettled: boolean;
}

/** The errors on filed returns, and how they may be corrected (VAT Notice 700/45). */
export interface VatCorrectionsView {
  errors: VatErrorRow[];
  /** The net of the uncorrected errors that count (in time, settled), pence. */
  net: number;
  /** The return they would be corrected on: the next to file, with its box 6 (whole pounds; provisional until it ends). */
  on?: { start: string; end: string; box6: number; provisional: boolean };
  method: 'next-return' | 'separately' | 'none';
  limit: 'basic' | 'box6' | 'over' | null;
  /** The most the net may be for the next return (pence). */
  maxMinor: number;
  rules: { from: string; limit: number; upperLimit: number; box6Percent: number; years: number };
}

/** HMRC's late submission penalty points, for information: the returns filed late, and the rules. */
export interface VatPenaltyView {
  from: string;
  frequency: VatFrequency;
  rules: { thresholds: Record<VatFrequency, number>; penalty: number; expiryMonths: number; complianceMonths: Record<VatFrequency, number>; outstandingMonths: number; frequencyChange: Record<VatFrequency, Record<VatFrequency, number>> };
  /** Returns filed late, or not filed and past due: points apply from periods starting on `from`; earlier ones were under the default surcharge. */
  late: { start: string; end: string; due: string; filedOn: string | null; days: number; expires: string; regime: 'points' | 'surcharge' | 'excluded'; excluded?: 'first' | 'final' }[];
  /** Points from these late returns that would not have expired by today, were the threshold never reached: indicative only. */
  live: number;
  /** Changes of frequency since points began, and HMRC's adjustment for each. */
  changes: { from: string; was: VatFrequency; to: VatFrequency; adjustment: number }[];
}

/** Taxable turnover over the last 12 months against the registration thresholds (information). */
export interface VatThresholdView {
  /** The 12 months to this day. */
  from: string;
  to: string;
  /** Pence: taxable sales (standard, reduced, zero-rated, or untreated sales), and services received under the reverse charge. */
  taxable: number;
  parts: { sales: number; untreated: number; reverseCharge: number };
  registration: number;
  deregistration: number;
  thresholdsFrom: string;
  /** The rolling 12 months to each month's end, the latest last. */
  months: { end: string; taxable: number; registration: number; deregistration: number }[];
  /** The books start within the 12 months: what came before is not in them. */
  partial: boolean;
  registered: boolean;
  /** The cash accounting scheme's limits (pounds) against taxable supplies in the same 12 months with the disposal of capital assets (pence). */
  cash: { turnover: number; join: number; leave: number; over: boolean };
}

/** GET /companies/:id/vat?period=<end>: a company's VAT returns from its books. */
export interface CompanyVatResponse {
  company: { id: string; name: string };
  registration: { registeredFrom: string; scheme: string; deregisteredOn?: string; stagger: VatStagger } | null;
  periods: VatPeriodRow[];
  /** The return to file next: the earliest ended and not filed, else the one running. */
  next?: string;
  /** The return shown: the one asked for, else the next. */
  ret: VatReturnView | null;
  corrections: VatCorrectionsView;
  penalties: VatPenaltyView | null;
  threshold: VatThresholdView;
  disclaimer: string;
}

// ─── A company's Corporation Tax (analytics/corporation-tax.ts, FORMULAS.md §22, "Corporation Tax") ───

/** before-books: a period the books do not reach whole; open: not ended; not-ready / ready: ended, by its checks; filed / filed-late: a CT600 is recorded. */
export type CtPeriodStatus = 'before-books' | 'open' | 'not-ready' | 'ready' | 'filed' | 'filed-late';

/** A Corporation Tax accounting period, as the Corporation Tax tab lists it (pence). */
export interface CtPeriodRow {
  start: string;
  end: string;
  /** The period of account (accounting period at Companies House) its last day falls in. */
  periodOfAccount: { start: string; end: string };
  /** Before the trade started (pre-trading), or trading. */
  phase: 'pre-trading' | 'trading';
  returnDue: string;
  paymentDue: string;
  status: CtPeriodStatus;
  /** Corporation Tax payable worked out from the books (pence); null for a period before them. */
  payable: number | null;
  /** What is recorded for it: its CT600 (with the tax it gave, pence) and its payment (pence; 0: nothing to pay). */
  ct600?: { filedOn: string; reference?: string; taxPayable?: number };
  payment?: { filedOn: string; amount?: number };
  /** Ended and ready, nothing to pay, and neither a payment nor its CT600 saying so recorded: the tab offers to record it (never by itself). */
  offerNothingToPay?: true;
  /** Its CT600 gives tax payable that differs from the books' figure. */
  differs?: true;
}

/** A line of the profit and loss account as allocated to a Corporation Tax period (pence: income positive, charges negative). */
export interface CtAccountsLine {
  ledger: string;
  name: string;
  amount: number;
  /** How it is allocated from the period of account: by days (trading items, CTA 2009 s52; loan relationships by default, s307(2A)–(2B)), as accrued to the CT period (loan relationships on the s307(2C) basis), or by its date (before the trade started). */
  basis: 'days' | 'accrued' | 'date';
  treatment: CtTreatmentKey;
}
/** A code's Corporation Tax treatment (shared/ledger.ts, `CtTreatment`), as the computation uses it. */
export type CtTreatmentKey = 'trading-income' | 'non-trading-income' | 'allowable' | 'disallowable' | 'loan-relationship' | 'capital' | 'tax' | 'none';

/** An adjustment from the accounts' profit to the trading result (pence: positive adds to the profit). */
export interface CtAdjustment {
  kind: 'disallowable' | 'capital' | 'non-trading' | 'pre-trading' | 'pre-trading-released';
  ledger?: string;
  label: string;
  amount: number;
  why: string;
}

/** An item of plant or machinery in a period's capital allowances (pence). */
export interface CtAssetRow {
  /** The register's id (`row:tx_…`), or the posting's for small equipment. */
  id: string;
  memo: string;
  class: string;
  pool: 'main' | 'special';
  /** The day it was bought, and the day it counts from for capital allowances (the trade's first day for plant bought before it: CAA 2001 s12). */
  acquired: string;
  incurred: string;
  cost: number;
  /** Its qualifying expenditure: its cost, capped for a connected seller (CAA 2001 s218). */
  qualifying: number;
  treatment: 'aia' | 'full-expensing' | 'fya-50' | 'pool';
  aia: number;
  firstYear: number;
  /** What goes into its pool: the rest of its qualifying expenditure. */
  toPool: number;
  /** Expensed in the accounts as small equipment (capital for tax: CTA 2009 s53). */
  smallEquipment?: true;
  connected?: true;
  /** Why it was treated so, and anything to confirm. */
  notes: string[];
}

/** An asset that left in a period, and its disposal value for capital allowances (pence). */
export interface CtDisposalRow {
  id: string;
  memo: string;
  date: string;
  /** What it fetched, as the books or the asset say; its disposal value is that, capped at its qualifying expenditure (CAA 2001 s62). */
  proceeds: number;
  disposalValue: number;
  /** How it was relieved when bought: the pool, or a first-year allowance (whose disposal is a balancing charge). */
  treatment: 'pool' | 'full-expensing' | 'fya-50';
  pool: 'main' | 'special';
  /** Deducted from its pool, and brought in as a balancing charge outside it. */
  fromPool: number;
  balancingCharge: number;
  notes: string[];
}

/** A pool for one period (pence). */
export interface CtPoolView {
  pool: 'main' | 'special';
  broughtForward: number;
  additions: number;
  disposals: number;
  /** Brought forward + additions − disposals, before writing-down allowances. */
  available: number;
  /** Of the additions, what is left of expenditure that had the 50% allowance: it joins after this period's writing-down allowance (CAA 2001 s58). */
  afterAllowance: number;
  balancingCharge: number;
  /** The writing-down allowance (or the small pool allowance), its yearly rate (percent) and the period's share of a year. */
  wda: number;
  rate: number;
  smallPool: boolean;
  carriedForward: number;
}

/** A period's capital allowances (pence). */
export interface CtCapitalAllowances {
  /** The annual investment allowance: the yearly limit (pounds), this period's (pence: pro rata, or what was allocated to it), and what was used. */
  aiaLimit: { annual: number; period: number; allocated: boolean; used: number };
  assets: CtAssetRow[];
  disposals: CtDisposalRow[];
  pools: CtPoolView[];
  aia: number;
  firstYear: number;
  wda: number;
  balancingCharges: number;
  /** Allowances less balancing charges: what the trading result is reduced by. */
  net: number;
  /** Plant bought before the trade started, waiting for its first day (CAA 2001 s12). */
  deferred: CtAssetRow[];
}

/** One financial year's part of a period's tax (pence, the profit in whole pounds). */
export interface CtTaxPart {
  /** The financial year by the year it starts in (FY 2025 runs from 1 April 2025 to 31 March 2026). */
  fy: number;
  start: string;
  end: string;
  days: number;
  /** Its share of the profits chargeable, whole pounds (by days). */
  profit: number;
  /** The rate charged (percent), and how: the small profits rate, the main rate with marginal relief, the main rate, or the one rate of the year. */
  rate: number;
  band: 'small' | 'marginal' | 'main' | 'single';
  /** The lower and upper limits for this part (pence), after associated companies and the period's length. */
  lower?: number;
  upper?: number;
  /** Tax at the rate, marginal relief, and what is left (pence). */
  tax: number;
  marginalRelief: number;
  net: number;
}

/** A box of the CT600 as the books give it. */
export interface Ct600BoxView {
  box: string;
  label: string;
  /** The form's column for boxes printed in pairs ("Capital allowances", "Balancing charges"). */
  column?: string;
  /** Whole pounds, pence, a date, a number, text, or an X. */
  kind: 'pounds' | 'money' | 'date' | 'number' | 'text' | 'x' | 'percent';
  /** Pounds (whole) for `pounds`; pence for `money`; the day for `date`; null when it is left for you (the tax reference). */
  value: number | string | boolean | null;
  section: string;
  /** How it was worked out, in words. */
  working: string;
}

/** What stops a period's computation being ready, or is not supported here. */
export type CtCheck =
  | { kind: 'not-ended'; end: string }
  | { kind: 'accounts-not-ready'; periodOfAccount: { start: string; end: string }; checks: number; ended: boolean }
  | { kind: 'earlier-not-ready'; end: string }
  | { kind: 'brought-forward'; ledgerFrom: string }
  | { kind: 'before-books'; ledgerFrom: string }
  | { kind: 'sales-before-trade'; amount: number }
  /** Interest, sales or interest paid dated before it came within the charge (in no CT period). */
  | { kind: 'income-before-charge'; amount: number; from: string; ledger: string }
  /** An opening journal dated on or after the books' first day that brings in a fixed asset. */
  | { kind: 'opening-journal'; date: string; ledgerFrom: string }
  | { kind: 'disposal-proceeds'; count: number; amount: number }
  /** A pre-trading period with profits, from FY 2023, not said whether it is a close investment-holding company (CTA 2010 s18N): the rate depends on it. */
  | { kind: 'close-investment-holding' }
  | { kind: 'unsupported'; what: string };

/** A note beside the computation: an assumption, an option the company may claim, or something to confirm. */
export interface CtNote {
  level: 'info' | 'warn';
  text: string;
}

/** A period's computation (pence unless said). */
export interface CtComputationView {
  period: CtPeriodRow;
  days: number;
  /** The accounts' profit before tax allocated to the period: each code's part, by days or by date. */
  accounts: { lines: CtAccountsLine[]; profit: number };
  adjustments: CtAdjustment[];
  /** The trading result before capital allowances: the accounts' profit with the adjustments. */
  beforeAllowances: number;
  capitalAllowances: CtCapitalAllowances;
  /** The trading result: a profit (positive) or a loss (negative); nothing before the trade starts. */
  tradingResult: number;
  /** Pre-trading expenditure: `added` is the period's day-share of its period of account's (`dayShare`, when that holds more than one pre-trading CT period) or, where none is shared, its dated items; `items` are the dated postings, the working. */
  preTrading: { broughtForward: number; added: number; released: number; lapsed: number; carriedForward: number; items: { date: string; memo: string; amount: number; ledger: string }[]; dayShare?: true };
  nonTrading: { credits: number; debits: number; net: number; items: { date: string; memo: string; ledger: string; amount: number }[] };
  losses: {
    trading: { broughtForward: number; usedAgainstTrading: number; usedAgainstTotal: number; arising: number; carriedForward: number };
    nonTrading: { broughtForward: number; used: number; arising: number; carriedForward: number };
  };
  /** Profits before other deductions (trading profits less losses set against them, and non-trading profits), and the profits chargeable (whole pounds as the CT600 takes them; exact beside). */
  totalProfits: number;
  chargeable: { exact: number; whole: number };
  tax: { parts: CtTaxPart[]; atRates: number; marginalRelief: number; chargeable: number };
  payable: number;
  carriedForward: { preTrading: number; tradingLosses: number; nonTradingDeficits: number; mainPool: number; specialPool: number };
  settings: { associatedCompanies: number; associatedByYear: number[]; associatedSaid: boolean; aiaAllocated: number | null; closeInvestmentHolding: boolean | null };
  /**
   * Tax on loans to participators (CTA 2010 s455), when you owed the company at the period's end on loans
   * it made you in the period (pence): owed at the end, the part lent in the period, the tax on it at the
   * rate for each part's day, what has been repaid since (by today, before relief runs out) and the
   * relief for it (s458), and so the tax (box 480). Provisional until 9 months after the period ends.
   */
  s455?: { owedAtEnd: number; outstanding: number; charge: number; relief: number; reliefTax: number; tax: number; due: string; provisional: boolean; parts: { date: string; amount: number; rate: number }[] };
  boxes: Ct600BoxView[];
  checks: CtCheck[];
  notes: CtNote[];
  ready: boolean;
}

/** GET /companies/:id/corporation-tax?period=<end>: a company's Corporation Tax computations from its books. */
export interface CompanyCtResponse {
  company: { id: string; name: string };
  periods: CtPeriodRow[];
  /** The period to work on next: the earliest ended in the books with no CT600 recorded, else the earliest ended with its tax not recorded as paid, else the one running. */
  next?: string;
  computation: CtComputationView | null;
  /** What the computation reads from the books' settings. */
  setup: { tradeStartedOn: string | null; withinCharge: { from: string | null; assumed: boolean }; closeInvestmentHolding: boolean | null; ledgerFrom: string | null; broughtForward: boolean };
  form: { name: string; version: string; url: string };
  /** What the owner should know beside the computation: being dormant, filing in iXBRL. */
  guidance: string[];
  disclaimer: string;
}

/** A row that takes a coding in a company's books (shared/ledger.ts, `codingPlace`), as the Books tab lists it. */
export interface BooksRowView {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  amount: number;
  description: string;
  payee?: string;
  side: 'company' | 'paid-for';
  books?: BooksCoding;
  /** A coding a hand edit left that does not fit: it counts for nothing. */
  problem?: string;
  /** A company row linked to rows of yours: the director's loan, needing no coding. */
  linked?: { personalIds: string[]; setBy: 'auto' | 'user' | 'agent' };
}

/** A link between a company row and rows of yours lent to it or repaid by it, as the Books tab lists it. */
export interface LinkView {
  companyRows: { id: string; accountId: string; accountName: string; date: string; amount: number; description: string }[];
  personalRows: { id: string; accountId: string; accountName: string; date: string; amount: number; description: string }[];
  setBy: 'auto' | 'user' | 'agent';
  /** Pence: what was sent less what arrived (a fee the company bears). */
  fee: number;
  problem?: string;
}

/** A row of yours marked as a loan with no company row linked, and the company rows that could be its other side. */
export interface LinkSuggestion {
  personal: { id: string; accountId: string; accountName: string; date: string; amount: number; description: string };
  candidates: { id: string; accountId: string; accountName: string; date: string; amount: number; description: string; days: number; fee: number; exact: boolean }[];
}

/** GET /companies/:id/coding: the rows to code (uncoded first), the links and what could be linked, its journals and book rules. */
export interface CompanyCodingResponse {
  company: { id: string; name: string };
  rows: BooksRowView[];
  links: LinkView[];
  suggestions: LinkSuggestion[];
  journals: Journal[];
  rules: Rule[];
  accounts: { id: string; name: string; ledger: string }[];
  /** Its VAT registration, so the coding editor offers VAT only when it is registered. */
  vat?: { registeredFrom: string; deregisteredOn?: string };
  /** The fixed asset register, so a credit to a cost code can say which asset it reduces. */
  assets: { id: string; ledger: string; memo: string; acquired: string; cost: number }[];
  /** The books are locked through this day: rows on or before it keep their coding as filed. */
  lockedThrough?: string;
}

/** GET /company-books: the companies whose books are kept here, with how many of their deadlines need you. */
export interface CompanyBooksListItem {
  id: string;
  name: string;
  overdue: number;
  dueSoon: number;
  /** The next deadline not done. */
  next?: CompanyDeadline;
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
  /** The local model service's record of the reading (engine "inference"). */
  inference?: InferenceProvenance;
  engineVersion?: string;
  /** The reader version that made the import. */
  previousVersion?: string;
  /** A CSV or spreadsheet: the layout it was parsed with now ("Chase UK", or columns worked out). */
  layout?: string;
  costUsd?: number;
  sections: RereadSection[];
  /**
   * The values the document prints that this reading found and the import does not keep yet (in
   * its reading or an earlier re-reading's): kept with the import only when you choose.
   */
  printed?: PrintedValue[];
  printedApplied?: boolean;
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
  /** Estimated between this valuation and the next, on this day (docs/FORMULAS.md §9, "Between valuations"). */
  to?: string;
  /** Shaped by the holdings' published prices, not shared out evenly by days. */
  prices?: true;
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

/**
 * A month's change in worth, four ways that add up to it to the penny (FORMULAS.md §18, "Worth
 * split"). `market` counts only values at market that are the month's (`marketAccounts`); one resting
 * on a valuation from another time falls in `other`, with borrowing, money to or from accounts the app
 * does not hold, and transfers whose other side is in another month.
 */
export interface MonthWorthSplit {
  /** Income less spending: the month's left over. */
  saved: number;
  /** Employer pension payments, tax relief and government bonuses paid into your accounts. */
  fromOutside: number;
  /** What values at market moved by, less what was paid in or taken out. */
  market: number;
  /** What the other three do not explain. */
  other: number;
  /** A market value was estimated from published prices or is otherwise rough. */
  marketEstimated: boolean;
  marketAccounts: string[];
}

/** Cash you could reach at once at the month's end, against typical spending (FORMULAS.md §18, "Cash cover"). */
export interface MonthRunway {
  accessibleCash: number;
  /** The median spending of the complete months among the 12 before; none without one. */
  typicalSpending: number | null;
  months: number | null;
}

/** An action a month in review asked of you, as it stands today (GET /api/actions; docs/DATA_FORMAT.md, actions.json). */
export interface ActionView extends ReviewAction {
  state: ActionState;
  href?: string;
}

/** Your actions: those on your list, most pressing first, and those decided or closed in the last 90 days. */
export interface ActionsResponse {
  open: ActionView[];
  recent: ActionView[];
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
    /** The change split into left over, money from outside, market movement and the rest (§18). */
    split: MonthWorthSplit;
  };
  /** Months of typical spending the cash you could reach at the month's end would cover (§18). */
  runway: MonthRunway;
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
  /** Where the money left over (and any borrowed) went, item by item: they add up to `total` exactly (§18, "Where it went"). */
  whereItWent: MonthWhereItWent;
  /** Spending by category group, and the largest categories, each against the months before (§18, "By category"). */
  categories: { groups: MonthCategory[]; top: MonthCategory[] };
}

/** One item of where a month's money went. */
export interface MonthWhereItem {
  id: 'cash' | 'cards' | 'invested' | 'loans' | 'company' | 'unknown' | 'unexplained';
  label: string;
  /** Positive: money that went there (kept in cash, paid off cards, invested, paid for or lent to your company, sent away). */
  amount: number;
  /** By account (cash, cards, invested), by company (company), or by who it went to (unknown), the largest first. */
  parts: { id: string; name: string; amount: number; count?: number }[];
}

export interface MonthWhereItWent {
  /** Left over (income less spending) plus borrowed. */
  total: number;
  items: MonthWhereItem[];
}

/** A category group's or a category's spending in a month, against the months before. */
export interface MonthCategory {
  id: string;
  name: string;
  /** For a category, its group. */
  group?: { id: string; name: string };
  amount: number;
  count: number;
  compared?: MonthCompared;
  /** The 12 months up to and including this one, oldest first; `complete` says whether each counts for typical. */
  history: { month: string; amount: number; complete: boolean }[];
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
