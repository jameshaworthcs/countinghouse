// The data format. These Zod schemas are the single source of truth for everything stored under
// data/ and everything sent over the API. JSON Schemas in schemas/ are generated from them
// (`npm run schemas`), and docs/DATA_FORMAT.md explains them field by field.
//
// Conventions (see src/shared/money.ts and dates.ts):
//   - money: JSON number in major units, max 2 dp, signed from the owner's point of view
//   - dates: "YYYY-MM-DD"; timestamps: ISO 8601 with offset
//   - ids: account/institution/category ids are slugs; records use prefixed hashes (tx_, bal_, …)

import { z } from 'zod';
import { isISODate } from './dates';
import { isMoney } from './money';
import { TASK_KINDS, TaskChoiceSchema } from './tasks';

// ─── Primitives ──────────────────────────────────────────────────────────────────────────────────

export const ISODateSchema = z
  .string()
  .refine(isISODate, { message: 'Expected a real date as YYYY-MM-DD' })
  .meta({ description: 'Calendar date, YYYY-MM-DD' });

export const TimestampSchema = z.iso.datetime({ offset: true }).meta({ description: 'ISO 8601 timestamp' });

export const MoneySchema = z
  .number()
  .refine(isMoney, { message: 'Money must be a finite number with at most 2 decimal places' })
  .meta({ description: 'Amount in major units (e.g. pounds), at most 2 dp. Positive increases net worth.' });

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code such as GBP')
  .meta({ description: 'ISO 4217 currency code' });

export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens')
  .meta({ description: 'Stable, human-readable identifier (lowercase-hyphenated)' });

/** Open-ended extra detail: anything a source provides that has no dedicated field yet. */
export const AttributesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .meta({ description: 'Extra detail from the source with no dedicated field yet (namespaced keys welcome)' });

/** The source row exactly as it appeared (CSV columns, OFX tags, QIF fields), for re-derivation. */
export const RawRowSchema = z.record(z.string(), z.string());

// ─── Accounts & institutions ─────────────────────────────────────────────────────────────────────

export const ACCOUNT_TYPES = [
  'current',
  'savings',
  'cash_isa',
  'stocks_isa',
  'lisa',
  'ifisa',
  'gia',
  'sipp',
  'workplace_pension',
  'personal_pension',
  'db_pension',
  'state_pension',
  'premium_bonds',
  'crypto',
  'property',
  'other_asset',
  'credit_card',
  'loan',
  'mortgage',
  'student_loan',
  'other_liability',
] as const;

export const AccountTypeSchema = z.enum(ACCOUNT_TYPES);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const INSTITUTION_KINDS = [
  'bank',
  'building_society',
  'investment_platform',
  'pension_provider',
  'card_issuer',
  'lender',
  'government',
  'crypto_exchange',
  'other',
] as const;

export const InstitutionSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  kind: z.enum(INSTITUTION_KINDS).default('bank'),
  /**
   * FSCS protection is per banking licence, and several brands share one (e.g. Halifax and Bank of
   * Scotland). Institutions with the same group are summed for the FSCS exposure check.
   */
  fscsGroup: z.string().optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
});
export type Institution = z.infer<typeof InstitutionSchema>;

export const BALANCE_MODES = ['ledger', 'market'] as const;

export const PensionDetailsSchema = z.object({
  employer: z.string().optional(),
  /** How personal contributions receive tax relief. */
  method: z.enum(['relief_at_source', 'net_pay', 'salary_sacrifice']).optional(),
});

export const AccountSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  type: AccountTypeSchema,
  institutionId: SlugSchema.optional(),
  currency: CurrencySchema.default('GBP'),
  status: z.enum(['open', 'closed']).default('open'),
  openedOn: ISODateSchema.optional(),
  closedOn: ISODateSchema.optional(),
  /** Last digits of the account or card number, used to match statements. Never the full number. */
  last4: z
    .string()
    .regex(/^\d{2,6}$/)
    .optional(),
  /** Other names this account appears under in documents and payment descriptions. */
  aliases: z.array(z.string()).default([]),
  /**
   * Spaces (or pots) inside this account whose money its statements count in its balance, as
   * Starling's do: moves between them and the main balance are not money in or out.
   */
  spaces: z.array(z.string().min(1).max(80)).max(30).optional(),
  /**
   * ledger: balance moves exactly with transactions (bank, savings, cards, loans, cash ISAs).
   * market: balance is a valuation that moves with markets (investments, pensions, property);
   * valuations are anchors and only external cash flows are added between them.
   * Defaults from the account type when absent.
   */
  balanceMode: z.enum(BALANCE_MODES).optional(),
  includeInNetWorth: z.boolean().default(true),
  /** Flexible ISA: withdrawals can be replaced in the same tax year without using allowance. */
  flexibleIsa: z.boolean().optional(),
  /** Current interest rate (AER %), informational. */
  interestRate: z.number().min(-100).max(100).optional(),
  maturesOn: ISODateSchema.optional(),
  pension: PensionDetailsSchema.optional(),
  /**
   * The account this one carries on from, and from which day: a product change under the same
   * account number (a fixed rate maturing into easy access). A statement that runs across the day is
   * split between the two (docs/INGESTION.md, "Linked accounts").
   */
  continues: z.object({ accountId: SlugSchema, from: ISODateSchema }).optional(),
  notes: z.string().optional(),
  attributes: AttributesSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Account = z.infer<typeof AccountSchema>;

// ─── Transactions ────────────────────────────────────────────────────────────────────────────────

export const CATEGORISED_BY = ['user', 'rule', 'builtin', 'bank', 'ai', 'transfer', 'agreement'] as const;
export type CategorisedBy = (typeof CATEGORISED_BY)[number];

export const SourceRefSchema = z.object({
  importId: z.string().optional(),
  documentId: z.string().optional(),
  /** Row / line index within the source document, when known. */
  row: z.number().int().nonnegative().optional(),
});

export const ForeignAmountSchema = z.object({ amount: MoneySchema, currency: CurrencySchema });

export const MerchantDetailSchema = z.object({
  name: z.string().optional(),
  /** The bank's merchant category, verbatim. */
  category: z.string().optional(),
  /** ISO 18245 merchant category code, when the source exposes it. */
  mcc: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  postcode: z.string().optional(),
  country: z.string().optional(),
  website: z.string().optional(),
  online: z.boolean().optional(),
});

export const SplitLineSchema = z.object({
  amount: MoneySchema,
  category: z.string().min(1).max(64),
  note: z.string().max(200).optional(),
});
export type SplitLine = z.infer<typeof SplitLineSchema>;

/** HH:MM or HH:MM:SS. */
export const TimeOfDaySchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

/**
 * The source fields another document can fill in on a recorded payment when they are empty
 * (shared/detail.ts). Never the date, amount or description: those are what the payment was
 * recorded by.
 */
export const DETAIL_FIELDS = ['transactionDate', 'transactionTime', 'time', 'sourceId', 'type', 'reference', 'counterpartyName', 'merchant', 'bankCategory', 'cardLast4', 'balanceAfter', 'original', 'exchangeRate', 'fee', 'attributes'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

/**
 * Another document that showed a recorded payment and filled in some of its empty source fields:
 * which, and what else that document said differently (its own description, say). Oldest first.
 */
export const SeenInSchema = z.object({
  importId: z.string().optional(),
  documentId: z.string().optional(),
  row: z.number().int().nonnegative().optional(),
  at: TimestampSchema,
  /** The fields it filled in. */
  added: z.array(z.enum(DETAIL_FIELDS)).min(1),
  /** What it said where the record already says something else: `{description: "…", date: "…"}`. */
  said: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type SeenIn = z.infer<typeof SeenInSchema>;

export const TransactionSchema = z.object({
  id: z.string().regex(/^tx_[0-9a-f]{16}$/),
  accountId: SlugSchema,

  // ── Source facts: exactly what the statement/export/screenshot said. Never rewritten. ──
  /** Posting date (the date the balance moved). */
  date: ISODateSchema,
  /** When the purchase itself happened, if the source shows a different date. */
  transactionDate: ISODateSchema.optional(),
  /** Local time of day, if known: HH:MM or HH:MM:SS. */
  time: TimeOfDaySchema.optional(),
  /**
   * The time of `transactionDate`, when a document gives it apart from `time`: an app shows when a
   * card was used (14 Sep 21:15) where the export shows when it cleared (16 Sep 09:02).
   */
  transactionTime: TimeOfDaySchema.optional(),
  amount: MoneySchema,
  currency: CurrencySchema,
  /** Description exactly as the source gave it. Never edited; see `payee` and `notes`. */
  description: z.string(),
  /** Identifier the bank/provider assigned to this transaction (strongest dedup key when present). */
  sourceId: z.string().optional(),
  /** The bank's transaction type, verbatim ("Card payment", "DD", "FPO", "Faster payment"…). */
  type: z.string().optional(),
  /** Payment reference, when separate from the description. */
  reference: z.string().optional(),
  /** Name of the other party for transfers and bank payments, as the source gave it. */
  counterpartyName: z.string().optional(),
  merchant: MerchantDetailSchema.optional(),
  /** The bank's own category, verbatim. */
  bankCategory: z.string().optional(),
  cardLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  /** Account balance straight after this transaction, if the source provided it. */
  balanceAfter: MoneySchema.optional(),
  /** Original amount for foreign-currency payments. */
  original: z.object({ amount: MoneySchema, currency: CurrencySchema }).optional(),
  exchangeRate: z.number().positive().optional(),
  /** Fee charged on this transaction, if reported separately (already included in `amount`). */
  fee: MoneySchema.optional(),
  pending: z.boolean().optional(),
  raw: RawRowSchema.optional(),
  attributes: AttributesSchema.optional(),
  /**
   * Your corrections to what was read from the document (a misread amount, a wrong date), oldest
   * first. The fields above hold the corrected values; each entry keeps what was there before.
   */
  corrections: z
    .array(
      z.object({
        field: z.enum(['date', 'amount', 'description']),
        from: z.union([z.string(), z.number()]),
        to: z.union([z.string(), z.number()]),
        at: TimestampSchema,
        note: z.string().max(500).optional(),
      }),
    )
    .optional(),

  // ── Enrichment: derived and recomputable (except where categorisedBy = "user"). ──
  /** Clean merchant or counterparty name. */
  payee: z.string().optional(),
  /** The merchant's address tidied into one line, from `merchant` (shared/places.ts); worked out again when the rules improve. */
  place: z.string().optional(),
  /** "user" when you set the payee yourself: re-running enrichment never changes it. */
  payeeSetBy: z.enum(['user']).optional(),
  /** Category id from categories.json. Absent = uncategorised. */
  category: z.string().optional(),
  categorisedBy: z.enum(CATEGORISED_BY).optional(),
  ruleId: z.string().optional(),
  /**
   * Yours: the payment split across categories, lines adding up to the amount (a supermarket shop
   * that was groceries and household). Spending, income and budgets count the lines. A line
   * shortfall (after a correction to the amount, say) stays in the transaction's own category.
   */
  splits: z.array(SplitLineSchema).min(2).max(30).optional(),
  /** Shared by both legs of a transfer between your own accounts. */
  transferGroup: z.string().optional(),
  /** Your own account on the other side of this transfer, when known. */
  counterpartyAccountId: SlugSchema.optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // ── Provenance ──
  source: SourceRefSchema.default({}),
  /** Other documents that showed this payment and filled in its empty source fields. */
  seenIn: z.array(SeenInSchema).optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

// ─── Balances & holdings ─────────────────────────────────────────────────────────────────────────

export const DATE_SOURCES = ['document', 'exif', 'filename', 'file-modified', 'upload', 'manual'] as const;
export type DateSource = (typeof DATE_SOURCES)[number];

export const BalanceSnapshotSchema = z.object({
  id: z.string().regex(/^bal_[0-9a-f]{16}$/),
  accountId: SlugSchema,
  /** End-of-day date the balance applies to. */
  date: ISODateSchema,
  /** Balance or valuation. Negative for money owed. */
  balance: MoneySchema,
  currency: CurrencySchema,
  kind: z.enum(['statement', 'screenshot', 'export', 'manual']).default('manual'),
  availableBalance: MoneySchema.optional(),
  /** Total net contributions to date, as reported by the provider. */
  contributions: MoneySchema.optional(),
  /** Gain / loss to date, as reported by the provider. */
  gain: MoneySchema.optional(),
  /** Uninvested cash inside an investment account. */
  cash: MoneySchema.optional(),
  /** LISA: government bonus received to date. */
  bonusToDate: MoneySchema.optional(),
  /** Provider-reported contributions/subscriptions in `taxYear` (e.g. ISA allowance used). */
  taxYearContributions: MoneySchema.optional(),
  /**
   * Interest added in `taxYear` up to `date`, as the provider reports it: a student loan's summary
   * of the tax year so far. Positive; it adds to what you owe. The gap check counts what it grew by
   * between two balances as interest (docs/FORMULAS.md §9, "Gaps").
   */
  taxYearInterest: MoneySchema.optional(),
  taxYear: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .optional(),
  /** DB / state pension: forecast annual income. */
  annualIncome: MoneySchema.optional(),
  note: z.string().optional(),
  /**
   * A figure you gave roughly (a starting snapshot, a range's middle). It stands in only for what
   * is newer than the account's real data, and balances from it are marked estimated.
   */
  approximate: z.boolean().optional(),
  dateSource: z.enum(DATE_SOURCES).optional(),
  /**
   * When on `date` the balance was seen, when known: a screenshot's capture time, or when you gave
   * a balance for the day you gave it. Without it a statement's, an export's or your own balance is
   * the day's close, and a screenshot's some time that day. On the same day, the later one wins.
   */
  at: TimestampSchema.optional(),
  /**
   * You typed or changed this figure yourself, while reviewing an import or by editing it: it
   * weighs as your own balance, whatever document it came with.
   */
  enteredBy: z.literal('user').optional(),
  attributes: AttributesSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type BalanceSnapshot = z.infer<typeof BalanceSnapshotSchema>;

/**
 * What a rate applies to: `interest` is paid to you on what the account holds (a saver's AER, a
 * current account's credit interest, an investment account's cash); the others are charged.
 */
export const TERMS_RATE_APPLIES = ['interest', 'purchases', 'cash', 'balance-transfers', 'overdraft', 'loan', 'other'] as const;
export type TermsRateApplies = (typeof TERMS_RATE_APPLIES)[number];

/** A rate an account's document gives, as it gives it. */
export const TermsRateSchema = z.object({
  applies: z.enum(TERMS_RATE_APPLIES),
  /** A percentage: a year's, unless `per` says a month's. */
  rate: z.number().min(0).max(100),
  /** `month` when the document gives a monthly rate (a card's "2.104% monthly interest rate"). */
  per: z.literal('month').optional(),
  /** How it is stated: AER, APR, EAR (an overdraft's), a simple annual rate (a card's), or gross. */
  basis: z.enum(['AER', 'APR', 'EAR', 'simple', 'gross']).optional(),
  /** Whether it can change: false for a fixed rate. */
  variable: z.boolean().optional(),
  /** The last day it applies, when it ends: a promotional rate, a boost, a fixed term. */
  until: ISODateSchema.optional(),
  /** The balance at this rate, when the document gives it (a promotional balance). */
  balance: MoneySchema.optional(),
  /** As printed ("Promotional purchases", "Boosted rate"). */
  label: z.string().min(1).max(120).optional(),
});
export type TermsRate = z.infer<typeof TermsRateSchema>;

/**
 * An account's terms as one document gives them on its date (terms.jsonl, docs/DATA_FORMAT.md): its
 * rates, its credit limit or overdraft, and a card's minimum payment. A later document adds a new
 * record; the history of them is how the terms changed (FORMULAS.md §4, "Terms").
 */
export const TermsSchema = z.object({
  id: z.string().regex(/^trm_[0-9a-f]{16}$/),
  accountId: SlugSchema,
  /** The day they are given for: a statement's balance date. */
  asOf: ISODateSchema,
  rates: z.array(TermsRateSchema).max(20).default([]),
  /** A card's credit limit, or a current account's arranged overdraft. */
  limit: MoneySchema.optional(),
  /** A card's minimum payment, and the day it is due. */
  minimumPayment: MoneySchema.optional(),
  paymentDue: ISODateSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type Terms = z.infer<typeof TermsSchema>;

/** An account's terms as a reading gives them: with its limit and headline rate, kept as a terms record. */
export const ExtractedTermsSchema = z.object({ rates: z.array(TermsRateSchema).max(20).default([]), minimumPayment: MoneySchema.optional(), paymentDue: ISODateSchema.optional() });
export type ExtractedTerms = z.infer<typeof ExtractedTermsSchema>;

export const ASSET_CLASSES = ['equity', 'bond', 'mixed', 'property', 'cash', 'commodity', 'crypto', 'other'] as const;

export const HoldingSchema = z.object({
  name: z.string().min(1),
  isin: z.string().optional(),
  ticker: z.string().optional(),
  /** SEDOL, as UK platforms print for funds. */
  sedol: z.string().optional(),
  units: z.number().optional(),
  /** Price per unit in `currency` (major units, any precision). */
  price: z.number().optional(),
  value: MoneySchema,
  currency: CurrencySchema.default('GBP'),
  costBasis: MoneySchema.optional(),
  /** Gain/loss on this holding as reported. */
  gain: MoneySchema.optional(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  /** Portfolio weight as reported (0-1). */
  weight: z.number().optional(),
  attributes: AttributesSchema.optional(),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const HoldingsSnapshotSchema = z.object({
  id: z.string().regex(/^hld_[0-9a-f]{16}$/),
  accountId: SlugSchema,
  date: ISODateSchema,
  holdings: z.array(HoldingSchema),
  cash: MoneySchema.optional(),
  totalValue: MoneySchema,
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type HoldingsSnapshot = z.infer<typeof HoldingsSnapshotSchema>;

// ─── Figures (standalone facts from documents; the basis of Self Assessment prep) ───────────────

export const FIGURE_KINDS = [
  'interest_paid',
  'interest_tax_deducted',
  'dividends_paid',
  'gross_pay',
  'tax_deducted',
  'national_insurance',
  'pension_contribution_employee',
  'pension_contribution_employer',
  'pension_tax_relief',
  'student_loan_deducted',
  'benefit_in_kind',
  'gift_aid_donation',
  'child_benefit',
  'self_employment_income',
  'self_employment_expenses',
  'capital_gain',
  'capital_loss',
  'rental_income',
  'other_income',
  /** Pay earned for work done (a timesheet), not paid yet: never income for tax, which counts pay when it is paid. */
  'earned_pay',
  /**
   * A State Pension or defined-benefit pension's forecast income per year, as at `date`, on its
   * account: a forecast has no balance to carry it (FORMULAS.md §9). Never income for tax.
   */
  'pension_income_forecast',
  'other',
] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** What a timesheet says about one period's work: an `earned_pay` figure's detail. */
export const WorkDetailSchema = z.object({
  /** The job, assignment or role the timesheet is for, as printed ("Role A"). */
  role: z.string().max(120).optional(),
  daysWorked: z.number().min(0).max(400).optional(),
  holidayDays: z.number().min(-400).max(400).optional(),
  hoursWorked: z.number().min(0).max(5000).optional(),
  /** Pay per day or hour, as printed. */
  rate: MoneySchema.optional(),
  ratePer: z.enum(['day', 'hour']).optional(),
});
export type WorkDetail = z.infer<typeof WorkDetailSchema>;

export const FigureSchema = z.object({
  id: z.string().regex(/^fig_[0-9a-f]{16}$/),
  kind: z.enum(FIGURE_KINDS),
  /** Label exactly as printed on the document ("Gross interest paid", "Pay", "Tax"). */
  label: z.string(),
  amount: MoneySchema,
  currency: CurrencySchema.default('GBP'),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  /** "2025/26" when the figure belongs to a tax year. */
  taxYear: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .optional(),
  /** Document date. */
  date: ISODateSchema.optional(),
  accountId: SlugSchema.optional(),
  /** Employer, bank or other payer named on the document. */
  payer: z.string().optional(),
  /** Payer reference (e.g. employer PAYE reference) if shown. */
  payerReference: z.string().optional(),
  /** PAYE tax code printed on a payslip or P60 ("1257L", "1257L M1"). */
  taxCode: z.string().max(20).optional(),
  /** `earned_pay`: the employer as its payslips name it, when another name is on the timesheet (FORMULAS.md §17). */
  paidBy: z.string().max(200).optional(),
  /** `earned_pay`: days, holiday and rate from the timesheet. */
  work: WorkDetailSchema.optional(),
  /** The job a pay figure is from (employments.json): its pay, tax, NI and pension deductions, or the payroll that pays earned pay. */
  employmentId: SlugSchema.optional(),
  notes: z.string().optional(),
  attributes: AttributesSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type Figure = z.infer<typeof FigureSchema>;

// ─── Jobs and HMRC's records ─────────────────────────────────────────────────────────────────────

/** An employer PAYE reference, tidied: the three-digit office number and the reference ("123/AB456"). */
export const PayeReferenceSchema = z.string().regex(/^\d{3}\/[A-Z0-9]{1,10}$/);
const TaxYearLabelSchema = z.string().regex(/^\d{4}\/\d{2}$/);

/**
 * An employer's contribution to a pension account of yours, as a form set it up (a SIPP's contribution
 * form, say): a single payment, or one each month. Gross: an employer's contribution has no tax relief
 * to add (FORMULAS.md §11, "Pension arrangements").
 */
export const PensionArrangementSchema = z.object({
  accountId: SlugSchema,
  kind: z.enum(['single', 'monthly']),
  amount: MoneySchema,
  /** The form's date. A single payment is expected within 60 days of it; a monthly one's first collection within two months. */
  from: ISODateSchema,
  /** The last month a monthly one is for, when it was set to end. */
  until: ISODateSchema.optional(),
  note: z.string().max(300).optional(),
  source: SourceRefSchema.default({}),
});
export type PensionArrangement = z.infer<typeof PensionArrangementSchema>;

/**
 * A job: one employment with one employer, as its documents and HMRC know it (docs/DATA_FORMAT.md,
 * employments.json). Its documents name the employer in several ways (a group name on the
 * payslips, the employing company on the P60, a payroll company in the bank). They are one job when
 * they share its PAYE reference or payroll number, or when you say so.
 */
export const EmploymentSchema = z.object({
  id: SlugSchema,
  /** The employer as HMRC and its P60 name it. */
  employer: z.string().min(1).max(200),
  /** Other names it comes under: on payslips, a group's name, how the bank shows its pay. */
  aliases: z.array(z.string().min(1).max(200)).max(30).default([]),
  payeReference: PayeReferenceSchema.optional(),
  /** Your works or payroll numbers there, as its documents and bank references print them. */
  payrollNumbers: z.array(z.string().regex(/^[A-Za-z0-9]{1,20}$/)).max(10).default([]),
  startedOn: ISODateSchema.optional(),
  endedOn: ISODateSchema.optional(),
  /** The pension account its payroll's pension deductions go into. */
  pensionAccountId: SlugSchema.optional(),
  /** Months after the work that a timesheet's pay comes (yours; unset, it is learned: FORMULAS.md §17). */
  payLagMonths: z.number().int().min(0).max(3).optional(),
  /** Pay periods (by their last day) whose pay has not arrived and that you say is owed to you. */
  owed: z.array(z.object({ periodEnd: ISODateSchema, note: z.string().max(500).optional(), markedAt: TimestampSchema })).max(36).default([]),
  /** Pension contributions the employer pays into a pension account of yours, as a form set them up. */
  pensionArrangements: z.array(PensionArrangementSchema).max(20).default([]),
  /** How the record began: from an import, by you, or by a data migration. */
  createdBy: z.enum(['import', 'owner', 'migration']).default('import'),
  notes: z.string().max(2000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Employment = z.infer<typeof EmploymentSchema>;

/**
 * A company you hold shares in (companies.json, docs/DATA_FORMAT.md): your holding by class, and what
 * it is worth, dated. Its value counts in your estate on its account (an "other asset"), where each
 * valuation is a balance (`balanceId`).
 */
const CompanyHoldingSchema = z.object({
  /** As the certificate names it ("B ordinary"). */
  shareClass: z.string().min(1).max(60),
  shares: z.number().positive(),
  /** Shares of every class the company has issued, when known: yours as a share of them. */
  totalShares: z.number().positive().optional(),
  certificate: z.string().max(40).optional(),
  acquiredOn: ISODateSchema.optional(),
  source: SourceRefSchema.default({}),
});
const CompanyValuationSchema = z.object({
  /** The day it is worth this: a balance sheet's date for a book value. */
  asOf: ISODateSchema,
  /** `net-assets`: its net assets on its balance sheet, as your share of its shares; `yours`: what you say. */
  method: z.enum(['net-assets', 'yours']),
  netAssets: MoneySchema.optional(),
  value: MoneySchema,
  note: z.string().max(400).optional(),
  /** The account balance it is (set when it is recorded). */
  balanceId: z.string().regex(/^bal_[0-9a-f]{16}$/).optional(),
  source: SourceRefSchema.default({}),
});
export const CompanySchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(200),
  /** Its Companies House number. */
  number: z
    .string()
    .regex(/^[A-Z0-9]{8}$/)
    .optional(),
  holdings: z.array(CompanyHoldingSchema).max(20).default([]),
  valuations: z.array(CompanyValuationSchema).max(100).default([]),
  /** The account that carries its value in your estate, and your job there if you work for it. */
  accountId: SlugSchema.optional(),
  employmentId: SlugSchema.optional(),
  notes: z.string().max(2000).optional(),
  createdBy: z.enum(['owner', 'agent']).default('owner'),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Company = z.infer<typeof CompanySchema>;

/** A payment's state as its document gives it: paid, due (or ready to be paid), expected, awaiting confirmation, or cancelled. */
export const AGREEMENT_PAYMENT_STATUSES = ['paid', 'due', 'scheduled', 'awaiting', 'cancelled'] as const;
export type AgreementPaymentStatus = (typeof AGREEMENT_PAYMENT_STATUSES)[number];

/**
 * An agreement that sets out payments between you and someone (agreements.json, docs/DATA_FORMAT.md):
 * an accommodation offer or tenancy, a contract, a payment plan, a student finance award. Its
 * schedule is kept as its document gives it, with everything else the document says; its payments
 * are filed under its category as they come, and checked against the schedule (FORMULAS.md §10,
 * "Agreements").
 */
const AgreementPaymentSchema = z.object({
  due: ISODateSchema,
  /** What is due, as the document gives it: always a positive amount, whichever way it goes. */
  amount: MoneySchema.refine((n) => n > 0, { message: 'A payment due is a positive amount' }),
  /** As the document names it ("Instalment 1"). */
  label: z.string().min(1).max(120).optional(),
  /** What its document said of it (`statusAsOf`): the check pairs it with your payments whatever this says. */
  status: z.enum(AGREEMENT_PAYMENT_STATUSES).optional(),
});
export const AgreementSchema = z.object({
  id: SlugSchema,
  /** What it is, in a few words ("Example College room, 2023/24"). */
  name: z.string().min(1).max(160),
  /** Who you pay, or who pays you. */
  counterparty: z.string().min(1).max(200),
  /** Other names its payments carry in your accounts ("UNI OF EXAMPLETON"): with the counterparty's, how they are recognised. */
  names: z.array(z.string().min(3).max(100)).max(10).default([]),
  /**
   * The category its payments take: a spending category for money you pay; for money paid to you,
   * a transfer (a loan lending it) or an income category.
   */
  category: z.string().min(1).max(64),
  /** Money you pay (out, when absent) or money paid to you (in: a student finance award's maintenance). */
  direction: z.enum(['out', 'in']).optional(),
  /**
   * The account its payments move through when not your everyday ones: a loan that lends you the
   * payments in, or pays the payments out for you (a Tuition Fee Loan paid to your university).
   */
  accountId: SlugSchema.optional(),
  /** Who pays it for you, when you do not ("Student Finance England" paying your university). */
  paidBy: z.string().min(1).max(200).optional(),
  /** The day its document gave the payments' statuses. */
  statusAsOf: ISODateSchema.optional(),
  /** The period it covers (a let's first and last days). */
  from: ISODateSchema,
  until: ISODateSchema.optional(),
  /** Its total cost, as the document gives it. */
  total: MoneySchema.optional(),
  /** Its schedule: what is due, and when. */
  payments: z.array(AgreementPaymentSchema).min(1).max(120),
  /** Everything else its document says, as it says it ("Bedroom type": "Standard ensuite"). */
  details: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(400) })).max(40).default([]),
  /** The day it was offered or signed. */
  agreedOn: ISODateSchema.optional(),
  /** Its reference: a booking, contract or account number. */
  reference: z.string().min(1).max(80).optional(),
  notes: z.string().max(2000).optional(),
  source: SourceRefSchema.default({}),
  createdBy: z.enum(['owner', 'agent']).default('owner'),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Agreement = z.infer<typeof AgreementSchema>;

/**
 * What the balances showed about a stretch of days no document covers (docs/FORMULAS.md §3,
 * "Balance evidence"): they add up across it, they leave an amount unexplained, or there is no
 * balance on one side.
 */
export const BalanceEvidenceSchema = z.object({
  status: z.enum(['adds-up', 'unexplained', 'no-balance']),
  /** The balances either side: the last before the stretch and the first on or after its end (or the last inside it). */
  from: ISODateSchema.optional(),
  to: ISODateSchema.optional(),
  /** The last day the balances speak for (before the stretch's end when the last balance is inside it). */
  through: ISODateSchema.optional(),
  /** What the rows between leave unexplained, summed over each pair of balances. */
  difference: MoneySchema.optional(),
  /** The first balance is the £0 the account opened with, not one recorded. */
  fromOpening: z.boolean().optional(),
});
export type BalanceEvidence = z.infer<typeof BalanceEvidenceSchema>;

/** How money with a person usually goes, to pre-fill a suggestion: never applied without you. */
export const PERSON_IN = ['gift', 'repaid', 'own'] as const;
export const PERSON_OUT = ['gift', 'shared', 'own'] as const;

/**
 * Someone you send money to or get money from (people.json, docs/DATA_FORMAT.md): the names their
 * payments carry, who they are to you, and how money with them usually goes. Each of their payments
 * is still yours to decide (the To categorise page).
 */
export const PersonSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(120),
  /** Every name their payments carry ("H WHITLOCK", "Hannah Whitlock"), as they appear. */
  names: z.array(z.string().min(1).max(120)).max(30).default([]),
  relation: z.enum(['family', 'partner', 'friend', 'other']).optional(),
  usually: z.object({ in: z.enum(PERSON_IN).optional(), out: z.enum(PERSON_OUT).optional() }).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * You confirmed that nothing is missing from an account over a stretch of days no document covers:
 * it counts as covered, like a statement's period (docs/FORMULAS.md §3).
 */
export const CoverageConfirmationSchema = z.object({
  id: z.string().regex(/^cov_[0-9a-f]{12}$/),
  accountId: SlugSchema,
  from: ISODateSchema,
  to: ISODateSchema,
  /** What the balances showed when you confirmed it. */
  evidence: BalanceEvidenceSchema.optional(),
  note: z.string().max(500).optional(),
  confirmedAt: TimestampSchema,
});
export type CoverageConfirmation = z.infer<typeof CoverageConfirmationSchema>;

// What HMRC's services hold about you, as their pages show it (docs/DATA_FORMAT.md, hmrc.jsonl).
const HmrcWho = {
  /** The employer as HMRC's page names it. */
  employer: z.string().max(200).optional(),
  payeReference: PayeReferenceSchema.optional(),
};
const hmrcTaxCode = z.object({
  type: z.literal('tax-code'),
  ...HmrcWho,
  /** The day HMRC's account says the code was issued or updated. */
  date: ISODateSchema,
  /** As written, without the basis: "1257L", "BR", "K475". */
  code: z.string().min(1).max(20),
  /** False for a week 1 / month 1 (non-cumulative) code. */
  cumulative: z.boolean(),
  taxYear: TaxYearLabelSchema,
});
const hmrcPayment = z.object({
  type: z.literal('payment'),
  ...HmrcWho,
  /** The pay date the employer reported. */
  payDate: ISODateSchema,
  taxablePay: MoneySchema,
  tax: MoneySchema,
  ni: MoneySchema.optional(),
  taxYear: TaxYearLabelSchema,
});
const hmrcEmployment = z.object({
  type: z.literal('employment'),
  ...HmrcWho,
  /** The day the page showed it. */
  asOf: ISODateSchema,
  taxYear: TaxYearLabelSchema,
  payrollNumber: z.string().regex(/^[A-Za-z0-9]{1,20}$/).optional(),
  startedOn: ISODateSchema.optional(),
  endedOn: ISODateSchema.optional(),
  /** HMRC's estimate of the year's taxable pay from it: an estimate, never income. */
  estimatedPay: MoneySchema.optional(),
  /** The pay on its P45, when it has ended. */
  leavingPay: MoneySchema.optional(),
  code: z.string().max(20).optional(),
  cumulative: z.boolean().optional(),
});
const hmrcEvent = z.object({
  type: z.literal('event'),
  ...HmrcWho,
  date: ISODateSchema,
  event: z.enum(['started', 'ended', 'allowance', 'year-started', 'other']),
  /** As the page words it. */
  text: z.string().min(1).max(500),
  amount: MoneySchema.optional(),
});
const hmrcSettlement = z.object({
  type: z.literal('settlement'),
  taxYear: TaxYearLabelSchema,
  asOf: ISODateSchema,
  /** What HMRC worked out: tax still to pay, tax to repay, or nothing either way. */
  outcome: z.enum(['underpaid', 'overpaid', 'settled']),
  /** The amount its calculation said (positive), and when. */
  amount: MoneySchema.optional(),
  calculatedOn: ISODateSchema.optional(),
  /** Still to pay (positive) or to be repaid (negative) as at `asOf`. */
  outstanding: MoneySchema,
  payments: z.array(z.object({ date: ISODateSchema, amount: MoneySchema, how: z.string().max(100) })).default([]),
});
const hmrcNiYear = z.object({
  type: z.literal('ni-year'),
  asOf: ISODateSchema,
  taxYear: TaxYearLabelSchema,
  status: z.enum(['full', 'not-full', 'not-available', 'other']),
  /** What made the year up, as listed ("Paid employment", "National Insurance credits"). */
  contributions: z.array(z.object({ kind: z.string().min(1).max(80), amount: MoneySchema.optional() })).default([]),
  /** A voluntary contribution that would fill the year, and the day it can be paid by. */
  voluntaryCost: MoneySchema.optional(),
  payBy: ISODateSchema.optional(),
  text: z.string().max(500).optional(),
});
const hmrcStatePension = z.object({
  type: z.literal('state-pension-forecast'),
  asOf: ISODateSchema,
  weekly: MoneySchema,
  monthly: MoneySchema.optional(),
  annual: MoneySchema,
  /** Your State Pension age. */
  payableFrom: ISODateSchema.optional(),
  /** The National Insurance record it is based on, to the end of this tax year. */
  recordTo: ISODateSchema.optional(),
  qualifyingYears: z.number().int().min(0).max(80).optional(),
  yearsNeeded: z.number().int().min(0).max(80).optional(),
  /** The years more it assumes you contribute. */
  assumesYears: z.number().int().min(0).max(80).optional(),
  /** It is the most you can get. */
  maximum: z.boolean().optional(),
});

/** A record as a page or document shows it, before it is matched to a job and stored. */
export const ExtractedHmrcSchema = z.discriminatedUnion('type', [hmrcTaxCode, hmrcPayment, hmrcEmployment, hmrcEvent, hmrcSettlement, hmrcNiYear, hmrcStatePension]);
export type ExtractedHmrc = z.infer<typeof ExtractedHmrcSchema>;

const HmrcStored = {
  id: z.string().regex(/^hmrc_[0-9a-f]{16}$/),
  /** The job it is about, when it is about one. */
  employmentId: SlugSchema.optional(),
  /** The account it is about (the State Pension account for a forecast). */
  accountId: SlugSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
};
export const HmrcRecordSchema = z.discriminatedUnion('type', [
  hmrcTaxCode.extend(HmrcStored),
  hmrcPayment.extend(HmrcStored),
  hmrcEmployment.extend(HmrcStored),
  hmrcEvent.extend(HmrcStored),
  hmrcSettlement.extend(HmrcStored),
  hmrcNiYear.extend(HmrcStored),
  hmrcStatePension.extend(HmrcStored),
]);
export type HmrcRecord = z.infer<typeof HmrcRecordSchema>;
export type HmrcRecordType = HmrcRecord['type'];

// A payslip in full, as printed (docs/DATA_FORMAT.md, payslips.jsonl): everything on it except your
// name and National Insurance number. Its pay, tax, NI, pension and student loan for the period are
// also tax figures (figures.jsonl), which the calculations read; this keeps the rest.
const PayslipLineSchema = z.object({
  /** As printed ("Monthly Salary", "Scheme - Pension Deduction"). */
  label: z.string().min(1).max(80),
  /** Signed as printed: a line printed with a minus (an adjustment, a refund) is negative. */
  amount: MoneySchema,
  quantity: z.number().optional(),
  rate: z.number().optional(),
});
export type PayslipLine = z.infer<typeof PayslipLineSchema>;
const PAYSLIP_YTD = ['gross', 'taxable', 'tax', 'ni', 'niEmployer', 'niablePay', 'pension', 'pensionEmployer', 'studentLoan', 'ssp', 'smp', 'taxCredit'] as const;
export type PayslipYtdKey = (typeof PAYSLIP_YTD)[number];

export const ExtractedPayslipSchema = z.object({
  /** The employer as the payslip names it, and any other name it prints (a group company). */
  employer: z.string().min(1).max(200),
  otherNames: z.array(z.string().min(1).max(200)).max(5).default([]),
  payeReference: PayeReferenceSchema.optional(),
  /** Your payroll or works number there. */
  payrollNumber: z.string().regex(/^[A-Za-z0-9]{1,20}$/).optional(),
  /** The date it prints (the pay date). */
  payDate: ISODateSchema,
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  /** The period as printed ("Sep-2026"), and its number in the tax year (month 1 is April's). */
  periodLabel: z.string().max(40).optional(),
  periodNumber: z.number().int().min(1).max(56).optional(),
  frequency: z.enum(['weekly', 'fortnightly', 'four-weekly', 'monthly']).optional(),
  /** As printed, without the basis ("1257L", "BR"); `cumulative` false for week 1 / month 1. */
  taxCode: z.string().max(20).optional(),
  cumulative: z.boolean().optional(),
  /** The National Insurance category letter ("A"); never the number. */
  niLetter: z.string().regex(/^[A-Z]$/).optional(),
  payMethod: z.string().max(40).optional(),
  department: z.string().max(80).optional(),
  payments: z.array(PayslipLineSchema).max(60).default([]),
  deductions: z.array(PayslipLineSchema).max(60).default([]),
  /** The totals it prints for the period. */
  totals: z
    .object({ payments: MoneySchema.optional(), deductions: MoneySchema.optional(), taxable: MoneySchema.optional(), nonTaxable: MoneySchema.optional(), net: MoneySchema.optional() })
    .default({}),
  /** What the employer paid on top this period, when printed: its NI and pension contributions. */
  employerCosts: z.object({ ni: MoneySchema.optional(), pension: MoneySchema.optional() }).default({}),
  /** The year-to-date column, as printed. */
  yearToDate: z.partialRecord(z.enum(PAYSLIP_YTD), MoneySchema).default({}),
});
export type ExtractedPayslip = z.infer<typeof ExtractedPayslipSchema>;

export const PayslipRecordSchema = ExtractedPayslipSchema.extend({
  id: z.string().regex(/^pay_[0-9a-f]{16}$/),
  /** The job it is from. */
  employmentId: SlugSchema.optional(),
  taxYear: TaxYearLabelSchema,
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type PayslipRecord = z.infer<typeof PayslipRecordSchema>;

// ─── Categories, rules, goals ────────────────────────────────────────────────────────────────────

export const CATEGORY_KINDS = ['expense', 'income', 'transfer', 'investment'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CategorySchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  /** Parent group id; groups themselves have no parent. */
  parent: SlugSchema.optional(),
  kind: z.enum(CATEGORY_KINDS),
  /** System categories carry meaning in calculations (transfers, pension relief, …). */
  system: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /**
   * Money in under it counts against spending, not as income: money back for something spent (a
   * refund, or what someone paid you back for their share).
   */
  offsetsSpending: z.boolean().optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const RuleSchema = z.object({
  id: z.string().regex(/^rule_[0-9a-z]+$/),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Lower runs first. */
  priority: z.number().int().default(100),
  match: z.object({
    field: z.enum(['description', 'payee']).default('description'),
    op: z.enum(['contains', 'equals', 'startsWith', 'endsWith', 'regex']).default('contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().default(false),
    accountIds: z.array(SlugSchema).optional(),
    amountMin: MoneySchema.optional(),
    amountMax: MoneySchema.optional(),
    direction: z.enum(['in', 'out']).optional(),
  }),
  set: z.object({
    category: z.string().optional(),
    payee: z.string().optional(),
    tags: z.array(z.string()).optional(),
    counterpartyAccountId: SlugSchema.optional(),
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

export const GOAL_KINDS = ['savings', 'emergency-fund', 'home-deposit'] as const;

/**
 * Something you are saving towards, from the accounts that fund it (docs/FORMULAS.md §16).
 * - savings: an amount, by a date if you like;
 * - emergency-fund: a number of months of your spending (the amount follows your spending);
 * - home-deposit: an amount for a first home; a Lifetime ISA counts in full only when the home's
 *   price is within the LISA cap and the LISA is a year old by then.
 */
export const GoalSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  /** Absent means savings (goals made before kinds existed). */
  kind: z.enum(GOAL_KINDS).optional(),
  /** The amount to reach; an emergency fund's comes from `months` instead. */
  targetAmount: MoneySchema.optional(),
  /** Emergency fund: how many months of spending. */
  months: z.number().min(1).max(36).optional(),
  /** Home deposit: the price of the home, for the LISA's price cap. */
  propertyPrice: MoneySchema.optional(),
  targetDate: ISODateSchema.optional(),
  accountIds: z.array(SlugSchema).default([]),
  notes: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Goal = z.infer<typeof GoalSchema>;

/**
 * A monthly spending budget (docs/FORMULAS.md §15). For a category, for a group (all its
 * categories), or with no category for all spending. Unspent money does not carry over.
 */
export const BudgetSchema = z.object({
  /** A category or group id from categories.json; absent for all spending. */
  category: SlugSchema.optional(),
  /** How much a month, in pounds. */
  monthly: MoneySchema.refine((v) => v > 0, { message: 'A budget is more than £0 a month' }),
  notes: z.string().max(500).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Budget = z.infer<typeof BudgetSchema>;

// ─── CSV profiles ────────────────────────────────────────────────────────────────────────────────

export const CsvProfileSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  institutionId: SlugSchema.optional(),
  /** Suggested account type for new accounts created from this profile. */
  accountType: AccountTypeSchema.optional(),
  /** Normalised header names that must all be present for this profile to match. */
  headerSignature: z.array(z.string()).min(1),
  /** For header-less files: the column names to assign, in order. */
  headerless: z.array(z.string()).optional(),
  dateOrder: z.enum(['DMY', 'MDY', 'YMD', 'auto']).default('DMY'),
  columns: z.object({
    date: z.string(),
    description: z.array(z.string()).min(1),
    amount: z.string().optional(),
    /** Money out column (positive numbers). */
    debit: z.string().optional(),
    /** Money in column (positive numbers). */
    credit: z.string().optional(),
    balance: z.string().optional(),
    currency: z.string().optional(),
    category: z.string().optional(),
    payee: z.string().optional(),
    /** Added to the amount (e.g. Revolut's separate Fee column, charged as money out). */
    fee: z.string().optional(),
    /** Foreign amount / currency for card payments abroad. */
    localAmount: z.string().optional(),
    localCurrency: z.string().optional(),
    /** Time of day, or a combined date-time column (time is taken from it). */
    time: z.string().optional(),
    /** The bank's transaction id. */
    id: z.string().optional(),
    type: z.string().optional(),
    reference: z.string().optional(),
    counterparty: z.string().optional(),
    /** Alternative date (e.g. transaction vs posting date). */
    transactionDate: z.string().optional(),
    merchantAddress: z.string().optional(),
    merchantCity: z.string().optional(),
    merchantPostcode: z.string().optional(),
    merchantCountry: z.string().optional(),
    /** Column giving the account number / identifier (last 4 digits are kept). */
    accountNumber: z.string().optional(),
  }),
  /** Split one export into several accounts by these columns (e.g. Revolut Product + Currency). */
  splitBy: z.array(z.string()).optional(),
  /** Amounts are positive in the file but money OUT when `column` starts with one of `values`. */
  negativeWhen: z.object({ column: z.string(), values: z.array(z.string()) }).optional(),
  /** Money IN when `column` starts with one of `values`, whatever the amount's sign in the file. */
  positiveWhen: z.object({ column: z.string(), values: z.array(z.string()) }).optional(),
  /** "inverted": positive numbers in the amount column are money OUT (e.g. Amex). */
  amountSign: z.enum(['normal', 'inverted']).default('normal'),
  /** Keep only rows whose `column` is one of `values` (e.g. Revolut State = COMPLETED). */
  filter: z.object({ column: z.string(), values: z.array(z.string()) }).optional(),
  /** Rows whose description matches one of these (case-insensitive substrings) are dropped. */
  skipDescriptions: z.array(z.string()).optional(),
  builtin: z.boolean().optional(),
  createdAt: TimestampSchema.optional(),
});
export type CsvProfile = z.infer<typeof CsvProfileSchema>;

// ─── Profile & settings ──────────────────────────────────────────────────────────────────────────

export const ProfileSchema = z.object({
  name: z.string().optional(),
  /** Drives LISA age limits, cash-ISA cap exemption at 65 and pension access age. */
  dateOfBirth: ISODateSchema.optional(),
  taxRegion: z.enum(['england', 'wales', 'scotland', 'northern-ireland']).default('england'),
  // Format v2 files may still carry `taxBand`: it is now worked out from your income (FORMULAS.md
  // §11) and is dropped when the profile is next saved.
  /** Gross annual salary, optional: estimates your tax band before your P60 arrives, and pension headroom hints. */
  grossSalary: MoneySchema.optional(),
  /** When you plan to stop work: drives the retirement outlook. */
  retirementAge: z.number().int().min(50).max(80).default(67),
  /**
   * What you have told the app about an employer's payroll, by the name its payslips give:
   * `payLagMonths` is how many months after the work a timesheet's pay comes (0: the same month).
   * Unset, it is learned from payslips matched to timesheets (FORMULAS.md §17).
   */
  employers: z
    .array(z.object({ name: z.string().min(1).max(200), payLagMonths: z.number().int().min(0).max(3).optional() }))
    .max(50)
    .optional(),
  // Returns, inflation and other modelling parameters are assumption records (assumptions.jsonl),
  // not profile fields. Format v1's `assumedRealReturn` was moved there by the v2 migration.
});
export type Profile = z.infer<typeof ProfileSchema>;

export const EXTRACTION_ENGINES = ['auto', 'inference', 'claude-cli', 'claude-api', 'ocr'] as const;
export type ExtractionEnginePreference = (typeof EXTRACTION_ENGINES)[number];

export const SettingsSchema = z.object({
  extraction: z
    .object({
      maxConcurrent: z.number().int().min(1).max(4).default(2),
      /** Seconds before a reading by Claude is abandoned (the local model's limits are in src/shared/tasks.ts). */
      timeoutSeconds: z.number().int().min(30).max(3600).default(900),
      /** Read receipts you attach, to propose split lines. Off until you turn it on. */
      readReceipts: z.boolean().default(false),
      /** Read stored documents again with the current reader, to compare with what was recorded. Off until you turn it on. */
      rereadDocuments: z.boolean().default(false),
      /**
       * Read everything a document prints (extract-14): a payslip in full, HMRC's pages as records, an
       * account's terms, and every other labelled value. Off until its evaluation has passed.
       */
      readEverything: z.boolean().default(false),
    })
    .default({ maxConcurrent: 2, timeoutSeconds: 900, readReceipts: false, rereadDocuments: false, readEverything: false }),
  /**
   * Which model does each piece of model work (src/shared/tasks.ts): your choices over the table's
   * defaults. Format v10 moved `extraction.engine/model/verifyModel/effort` and `agents.model/effort`
   * here.
   */
  models: z
    .object({
      tasks: z.partialRecord(z.enum(TASK_KINDS), TaskChoiceSchema).default({}),
    })
    .default({ tasks: {} }),
  /** Ask (src/server/ask.ts): how many tools the model may call for one question before it must answer. */
  ask: z
    .object({
      maxToolCalls: z.number().int().min(1).max(30).default(8),
    })
    .default({ maxToolCalls: 8 }),
  git: z
    .object({
      autoCommit: z.boolean().default(true),
      /** Commit original statements/screenshots under data/documents. */
      trackDocuments: z.boolean().default(true),
    })
    .default({ autoCommit: true, trackDocuments: true }),
  /** An account is flagged stale when its newest data point is older than this. */
  staleAfterDays: z.number().int().min(1).max(3650).default(35),
  /** Manual FX: value of one unit of each currency in GBP, e.g. { "USD": 0.74 }. */
  fx: z.record(CurrencySchema, z.number().positive()).default({}),
  /**
   * In-app agent jobs (research, insights, reviews) run through the same Claude engine. Off until you
   * turn them on: a new data directory spends nothing by itself.
   */
  agents: z
    .object({
      enabled: z.boolean().default(false),
      /** Research older than this is refreshed. */
      researchStaleAfterDays: z.number().int().min(7).max(730).default(90),
      /** Produce insights after each committed import. */
      insightsAfterImport: z.boolean().default(true),
      /** Write a month in review once last month's data is in. */
      monthlyReview: z.boolean().default(true),
      timeoutSeconds: z.number().int().min(60).max(3600).default(1200),
      /**
       * What jobs the app starts by itself may spend, in US dollars of Claude usage (API prices; on
       * a plan this is usage, not a bill). A job starts only while today's and this month's spend
       * are under these; the rest wait. Jobs you start yourself are not limited.
       */
      /**
       * Research (funds, providers, the modelling assumptions) starts only when you ask, unless
       * this is on. Insights after imports and the month in review still follow the switches above.
       */
      autoResearch: z.boolean().default(false),
      /**
       * Claude names each committed import (the `label-imports` job), so History can be searched by
       * what a document is rather than its file name. Off until you turn it on.
       */
      labelImports: z.boolean().default(false),
      backgroundBudgetPerDayUsd: z.number().min(0).max(100).default(5),
      backgroundBudgetPerMonthUsd: z.number().min(0).max(1000).default(40),
    })
    .default({ enabled: false, researchStaleAfterDays: 90, insightsAfterImport: true, monthlyReview: true, timeoutSeconds: 1200, autoResearch: false, labelImports: false, backgroundBudgetPerDayUsd: 5, backgroundBudgetPerMonthUsd: 40 }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const MetaSchema = z.object({
  format: z.literal('finance-data'),
  version: z.number().int().positive(),
  baseCurrency: CurrencySchema.default('GBP'),
  createdAt: TimestampSchema,
});
export type Meta = z.infer<typeof MetaSchema>;

// ─── Provenance shared by agent-maintained records ───────────────────────────────────────────────

/** Who set a record. The owner's records always win over an agent's (see docs/AGENTS.md). */
export const SET_BY = ['owner', 'agent', 'system'] as const;
export type SetBy = (typeof SET_BY)[number];

/**
 * What the local model service says produced an answer (its README §4): enough to tell two answers
 * from the same setup. The whole provenance object is kept in the session record (sessions.ts).
 */
export const InferenceProvenanceSchema = z.object({
  requestId: z.string(),
  /** The alias asked for (vision-extract, fast-chat…). */
  alias: z.string(),
  /** The model file that answered, by its id and sha256. */
  modelId: z.string().optional(),
  modelSha256: z.string().optional(),
  /** inf-…: the model file, runtime, launch arguments, chat template and driver together. */
  systemFingerprint: z.string().optional(),
  seed: z.number().int().optional(),
  thinking: z.boolean().optional(),
  /** The service checked the output against the schema sent. */
  schemaValid: z.boolean().optional(),
  /** Milliseconds it waited for its turn (and for a model to load). */
  queueMs: z.number().nonnegative().optional(),
});
export type InferenceProvenance = z.infer<typeof InferenceProvenanceSchema>;

export const ProvenanceSchema = z.object({
  setBy: z.enum(SET_BY),
  /** Model that produced it (agents), e.g. "claude-opus-5-5", or the local model's id. */
  model: z.string().optional(),
  /** The engine that ran it, when not Claude's CLI: "inference" is the local model service. */
  engine: z.enum(['inference', 'claude-cli', 'claude-api']).optional(),
  /** The local model service's own record of the answer. */
  inference: InferenceProvenanceSchema.optional(),
  /** Version of the job prompt that produced it, e.g. "research-instrument-1". */
  promptVersion: z.string().optional(),
  /** The in-app job that wrote it. */
  jobId: z.string().optional(),
  /** Where an agent ran outside the app, e.g. "claude-code". */
  session: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ─── Documents & imports ─────────────────────────────────────────────────────────────────────────

export const DocumentRefSchema = z.object({
  /** doc_<first 16 hex of sha256> */
  id: z.string().regex(/^doc_[0-9a-f]{16}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  /** Path relative to the data directory once committed (documents/…); absent while pending. */
  path: z.string().optional(),
  /** Best-known capture date for screenshots and its provenance. */
  capturedOn: ISODateSchema.optional(),
  capturedOnSource: z.enum(DATE_SOURCES).optional(),
  /** When a screenshot was taken, to the second, when its source gives a time (same provenance). */
  capturedAt: TimestampSchema.optional(),
  /** An image's size in pixels (upright) and the device named in its metadata, if any. */
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), device: z.string().max(80).optional() }).optional(),
  /** Browser-reported last-modified time of the uploaded file. */
  lastModified: TimestampSchema.optional(),
});
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

/** What an extraction engine returns: faithful to the document, not yet matched to your accounts. */
export const EXTRACTION_DOC_TYPES = [
  'bank_statement',
  'credit_card_statement',
  'savings_statement',
  'investment_statement',
  'pension_statement',
  'account_overview_screenshot',
  'transactions_screenshot',
  'holdings_screenshot',
  'holding_detail_screenshot',
  'annual_summary',
  'interest_certificate',
  'payslip',
  'p60',
  'p11d',
  'timesheet',
  'tax_document',
  'csv_export',
  'other',
] as const;

export const ExtractedTransactionSchema = z.object({
  date: ISODateSchema,
  description: z.string(),
  amount: MoneySchema,
  balanceAfter: MoneySchema.nullable().default(null),
  category: z.string().nullable().default(null),
  payee: z.string().nullable().default(null),
  pending: z.boolean().default(false),
  currency: CurrencySchema.nullable().default(null),
  originalAmount: MoneySchema.nullable().default(null),
  originalCurrency: CurrencySchema.nullable().default(null),
  transactionDate: ISODateSchema.nullable().default(null),
  time: z.string().nullable().default(null),
  sourceId: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  reference: z.string().nullable().default(null),
  counterpartyName: z.string().nullable().default(null),
  merchantLocation: z.string().nullable().default(null),
  cardLast4: z.string().nullable().default(null),
  bankCategory: z.string().nullable().default(null),
  fee: MoneySchema.nullable().default(null),
  exchangeRate: z.number().nullable().default(null),
  /** Deterministic parsers keep the source row verbatim. */
  raw: RawRowSchema.nullable().default(null),
  /** Deterministic parsers: extra structured detail. */
  attributes: AttributesSchema.nullable().default(null),
  merchant: MerchantDetailSchema.nullable().default(null),
  /** Row index in the source (for provenance). */
  row: z.number().int().nullable().default(null),
  /** What the reader could not read with certainty on this row. */
  uncertain: z.string().nullable().default(null),
});
export type ExtractedTransaction = z.infer<typeof ExtractedTransactionSchema>;

export const ExtractedHoldingSchema = z.object({
  name: z.string(),
  isin: z.string().nullable().default(null),
  ticker: z.string().nullable().default(null),
  sedol: z.string().nullable().default(null),
  units: z.number().nullable().default(null),
  price: z.number().nullable().default(null),
  value: MoneySchema,
  currency: CurrencySchema.nullable().default(null),
  assetClass: z.enum(ASSET_CLASSES).nullable().default(null),
  /** "Book cost", "amount invested". */
  costBasis: MoneySchema.nullable().default(null),
  /** "Growth", "change since you invested", in money. */
  gain: MoneySchema.nullable().default(null),
});

export const ExtractedAccountSchema = z.object({
  institutionName: z.string().nullable().default(null),
  accountName: z.string().nullable().default(null),
  accountType: AccountTypeSchema.nullable().default(null),
  last4: z.string().nullable().default(null),
  currency: CurrencySchema.nullable().default(null),
  periodStart: ISODateSchema.nullable().default(null),
  periodEnd: ISODateSchema.nullable().default(null),
  openingBalance: MoneySchema.nullable().default(null),
  closingBalance: MoneySchema.nullable().default(null),
  balanceDate: ISODateSchema.nullable().default(null),
  availableBalance: MoneySchema.nullable().default(null),
  creditLimit: MoneySchema.nullable().default(null),
  contributionsToDate: MoneySchema.nullable().default(null),
  gainLoss: MoneySchema.nullable().default(null),
  governmentBonusToDate: MoneySchema.nullable().default(null),
  taxYearContributions: MoneySchema.nullable().default(null),
  /** Interest added since 6 April, from a student loan's summary of the tax year so far (positive). */
  taxYearInterest: MoneySchema.nullable().default(null),
  cashBalance: MoneySchema.nullable().default(null),
  annualIncome: MoneySchema.nullable().default(null),
  interestRate: z.number().nullable().default(null),
  /** Its terms in detail: every rate printed, and a card's minimum payment (the reader that keeps everything). */
  terms: ExtractedTermsSchema.optional(),
  /** Totals of money in and money out printed on the statement, unsigned. */
  statedMoneyIn: MoneySchema.nullable().default(null),
  statedMoneyOut: MoneySchema.nullable().default(null),
  /** What a running Balance column tracks: the account itself, or only its uninvested cash (an investment account's activity list). */
  runningBalanceOf: z.enum(['account', 'cash']).nullable().default(null),
  transactions: z.array(ExtractedTransactionSchema).default([]),
  holdings: z.array(ExtractedHoldingSchema).default([]),
});
export type ExtractedAccount = z.infer<typeof ExtractedAccountSchema>;

export const ExtractedFigureSchema = z.object({
  kind: z.enum(FIGURE_KINDS),
  label: z.string(),
  amount: MoneySchema,
  currency: CurrencySchema.nullable().default(null),
  periodStart: ISODateSchema.nullable().default(null),
  periodEnd: ISODateSchema.nullable().default(null),
  taxYear: z.string().nullable().default(null),
  payer: z.string().nullable().default(null),
  payerReference: z.string().nullable().default(null),
  /** last4 of the account this figure relates to, if any. */
  accountLast4: z.string().nullable().default(null),
  taxCode: z.string().nullable().default(null),
  /** A timesheet's period: days, holiday and rate. */
  work: z
    .object({
      role: z.string().nullable().default(null),
      daysWorked: z.number().nullable().default(null),
      holidayDays: z.number().nullable().default(null),
      hoursWorked: z.number().nullable().default(null),
      rate: z.number().nullable().default(null),
      ratePer: z.enum(['day', 'hour']).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type ExtractedFigure = z.infer<typeof ExtractedFigureSchema>;

export const SCHEDULE_DIRECTIONS = ['to-you', 'from-you', 'to-other'] as const;

/**
 * A schedule of payments between you and an organisation, or made for you, that is not an account's
 * own movements (extract-15, rule 24): a student finance award or payments page, an accommodation
 * offer's instalments, a council tax bill, a loan's payment dates. Recorded as an agreement.
 */
export const ExtractedScheduleSchema = z.object({
  /** Who pays or is paid, as printed ("Student Finance England"). */
  provider: z.string().min(1).max(200),
  /** What it is, with its period ("Maintenance Loan 2026/27"). */
  name: z.string().min(1).max(160),
  /** The provider pays you, you pay it, or it pays someone else for you (`paidTo`). */
  direction: z.enum(SCHEDULE_DIRECTIONS),
  paidTo: z.string().min(1).max(200).optional(),
  from: ISODateSchema.optional(),
  until: ISODateSchema.optional(),
  reference: z.string().min(1).max(80).optional(),
  total: MoneySchema.optional(),
  payments: z
    .array(
      z.object({
        date: ISODateSchema,
        amount: MoneySchema.refine((n) => n > 0, { message: 'A scheduled payment is a positive amount' }),
        label: z.string().min(1).max(120).optional(),
        status: z.enum(AGREEMENT_PAYMENT_STATUSES).optional(),
      }),
    )
    .min(1)
    .max(120),
  /** Other facts it prints about itself (course, course year, room), as printed. */
  details: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(400) })).max(40).default([]),
});
export type ExtractedSchedule = z.infer<typeof ExtractedScheduleSchema>;

export const ExtractionSchema = z.object({
  documentType: z.enum(EXTRACTION_DOC_TYPES).default('other'),
  institutionName: z.string().nullable().default(null),
  /** Date printed on the document / screenshot, if any. */
  documentDate: ISODateSchema.nullable().default(null),
  accounts: z.array(ExtractedAccountSchema).default([]),
  figures: z.array(ExtractedFigureSchema).default([]),
  /** What HMRC's pages show: tax codes, payments, jobs, events, settlements, NI years, forecasts (ingest/govuk.ts). */
  hmrc: z.array(ExtractedHmrcSchema).default([]),
  /** Payslips in full (ingest/payslips.ts). */
  payslips: z.array(ExtractedPayslipSchema).default([]),
  /**
   * Every other labelled value the document prints, as printed (extract-14, "read everything"):
   * kept with the import so nothing on a document is lost, though nothing reads it yet.
   */
  printed: z.array(z.object({ section: z.string().max(120).optional(), label: z.string().min(1).max(200), value: z.string().min(1).max(500) })).max(400).default([]),
  /** Schedules of payments it gives (extract-15): recorded as agreements. */
  schedules: z.array(ExtractedScheduleSchema).default([]),
  notes: z.array(z.string()).default([]),
  /** Understood, but nothing to record: what the document shows, in a sentence (extract-9). */
  nothingToRecord: z.string().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// Drafts: the editable, reviewable form of an extraction, after matching against your data.

export const DRAFT_TX_STATUSES = ['new', 'duplicate', 'possible_duplicate'] as const;

export const DraftTransactionSchema = z.object({
  key: z.string(),
  include: z.boolean(),
  status: z.enum(DRAFT_TX_STATUSES),
  /** Existing transaction this row duplicates (or probably duplicates). */
  duplicateOf: z.string().optional(),
  date: ISODateSchema,
  amount: MoneySchema,
  description: z.string(),
  payee: z.string().optional(),
  category: z.string().optional(),
  categorisedBy: z.enum(CATEGORISED_BY).optional(),
  ruleId: z.string().optional(),
  balanceAfter: MoneySchema.optional(),
  original: ForeignAmountSchema.optional(),
  pending: z.boolean().optional(),
  counterpartyAccountId: SlugSchema.optional(),
  /** An existing transaction in another of your accounts that is the other leg of this transfer. */
  transferMatch: z.string().optional(),
  /**
   * You chose `transferMatch`, or that there is none: drafting again keeps your choice rather than
   * looking for one itself.
   */
  transferMatchBy: z.literal('user').optional(),
  /**
   * The other leg of this transfer as you linked it, while it waits for review too: a row (`key`)
   * of another import waiting for review, or of another account in this one (docs/INGESTION.md,
   * "Linking transfers before commit"). The two are linked as a transfer once both are committed.
   */
  pendingLink: z.object({ importId: z.string().max(80), key: z.string().max(40) }).optional(),
  row: z.number().int().optional(),
  /** What the reader was unsure of on this row ("year not shown", "amount partly hidden"). */
  uncertain: z.string().max(300).optional(),
  /**
   * The Space this row moves money to or from, inside the account (shared/spaces.ts): not money in
   * or out, so it is left unticked. Ticked, it is recorded all the same.
   */
  insideAccount: z.string().max(80).optional(),
  /**
   * A row matched to a recorded payment (`duplicateOf`) that knows more about it: the recorded
   * payment's empty source fields this document fills in (shared/detail.ts). Ticked `include`, they
   * are filled in on commit, while the row itself is not recorded again.
   */
  adds: z
    .object({
      include: z.boolean(),
      /** The values to fill in, only where the recorded payment has none. */
      fields: TransactionSchema.pick({
        transactionDate: true,
        transactionTime: true,
        time: true,
        sourceId: true,
        type: true,
        reference: true,
        counterpartyName: true,
        merchant: true,
        bankCategory: true,
        cardLast4: true,
        balanceAfter: true,
        original: true,
        exchangeRate: true,
        fee: true,
        attributes: true,
      }),
      /** What this document says where the record says something else, for you to see; nothing changes. */
      differs: z.array(z.object({ field: z.string(), recorded: z.union([z.string(), z.number()]), here: z.union([z.string(), z.number()]) })).default([]),
      /** The category the recorded payment would get from what is filled in, when it changes. */
      category: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
    })
    .optional(),
  /** Source detail carried through to the stored transaction untouched. */
  detail: TransactionSchema.pick({
    sourceId: true,
    transactionDate: true,
    time: true,
    type: true,
    reference: true,
    counterpartyName: true,
    merchant: true,
    bankCategory: true,
    cardLast4: true,
    exchangeRate: true,
    fee: true,
    raw: true,
    attributes: true,
  }).optional(),
});
export type DraftTransaction = z.infer<typeof DraftTransactionSchema>;

export const NewAccountInputSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  type: AccountTypeSchema,
  institutionId: SlugSchema.optional(),
  institutionName: z.string().optional(),
  currency: CurrencySchema.default('GBP'),
  last4: z
    .string()
    .regex(/^\d{2,6}$/)
    .optional(),
  openedOn: ISODateSchema.optional(),
  /** Set when the account has already closed: it is created closed, worth nothing after this day. */
  closedOn: ISODateSchema.optional(),
});
export type NewAccountInput = z.infer<typeof NewAccountInputSchema>;

export const DraftTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), accountId: SlugSchema }),
  z.object({ mode: z.literal('new'), account: NewAccountInputSchema }),
  z.object({ mode: z.literal('skip') }),
]);
export type DraftTarget = z.infer<typeof DraftTargetSchema>;

export const DraftSectionSchema = z.object({
  key: z.string(),
  detected: z.object({
    institutionName: z.string().optional(),
    accountName: z.string().optional(),
    accountType: AccountTypeSchema.optional(),
    last4: z.string().optional(),
    currency: CurrencySchema.optional(),
  }),
  target: DraftTargetSchema,
  matchReason: z.string().optional(),
  /**
   * Rows a document's schedules give, not a statement of the account: student finance's paid
   * instalments as its loan's movements. They cover no days of it, and have no balance to give.
   */
  fromSchedule: z.boolean().optional(),
  /** The screen says only what kind of account it is, and you have one of that kind: offered in one click. */
  suggestedAccountId: SlugSchema.optional(),
  currency: CurrencySchema.default('GBP'),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  /**
   * The days the document covers as you gave them, when it does not print its period (the range you
   * chose for an export): coverage runs over them, not just from its first row to its last.
   */
  coversFrom: ISODateSchema.optional(),
  coversTo: ISODateSchema.optional(),
  openingBalance: MoneySchema.optional(),
  /** Totals printed on the statement, for checking the rows against. Money out is positive. */
  statedTotals: z.object({ moneyIn: MoneySchema.optional(), moneyOut: MoneySchema.optional() }).optional(),
  /** Whether to record the balance snapshot below. */
  recordBalance: z.boolean().default(true),
  balance: MoneySchema.optional(),
  /** The balance the draft proposed from the reading (null: none): a different `balance` is yours. */
  readBalance: MoneySchema.nullable().optional(),
  balanceDate: ISODateSchema.optional(),
  balanceDateSource: z.enum(DATE_SOURCES).optional(),
  availableBalance: MoneySchema.optional(),
  creditLimit: MoneySchema.optional(),
  contributions: MoneySchema.optional(),
  gain: MoneySchema.optional(),
  cash: MoneySchema.optional(),
  bonusToDate: MoneySchema.optional(),
  taxYearContributions: MoneySchema.optional(),
  taxYearInterest: MoneySchema.optional(),
  annualIncome: MoneySchema.optional(),
  interestRate: z.number().optional(),
  /** Its terms in detail, when the reading gives them: with the limit and the rate, kept as a terms record. */
  terms: ExtractedTermsSchema.optional(),
  transactions: z.array(DraftTransactionSchema).default([]),
  /**
   * The opening balance and running balances are the account's uninvested cash, not its value (an
   * investment app's activity list). `cash` holds the closing cash; no value is recorded from it.
   */
  cashLedger: z.boolean().optional(),
  recordHoldings: z.boolean().default(true),
  holdings: z.array(HoldingSchema).default([]),
  /** The document shows only some of the account's holdings; they join the others recorded that day. */
  holdingsPartial: z.boolean().optional(),
  /**
   * Payments this account has recorded twice that the document shows once (ingest/dedup.ts,
   * `storedTwice`). A copy ticked `remove` is taken away when the import is committed.
   */
  extraCopies: z
    .array(
      z.object({
        /** The recorded copy to take away, and the copy that stays, in this account. */
        transactionId: z.string(),
        keepId: z.string(),
        accountId: SlugSchema.optional(),
        date: ISODateSchema,
        amount: MoneySchema,
        description: z.string(),
        /** The document the copy to take away came from. */
        fromFile: z.string().optional(),
        /** Both copies show the same balance after them: the same payment, for certain. */
        sameBalance: z.boolean(),
        remove: z.boolean(),
      }),
    )
    .optional(),
});
export type DraftSection = z.infer<typeof DraftSectionSchema>;
export type ExtraCopy = NonNullable<DraftSection['extraCopies']>[number];

/**
 * A job a document is about, and the job of yours it is (`existing`) or would be (`new`). Its pay
 * figures and HMRC records point at it by `jobKey`; choosing another job moves them all.
 */
export const DraftJobSchema = z.object({
  key: z.string(),
  /** The employer as the document names it. */
  employer: z.string().min(1).max(200),
  payeReference: PayeReferenceSchema.optional(),
  payrollNumber: z.string().regex(/^[A-Za-z0-9]{1,20}$/).optional(),
  /** What matched it to a job of yours. */
  matchedBy: z.enum(['payeReference', 'payrollNumber', 'name', 'hmrc', 'you']).optional(),
  target: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), employmentId: SlugSchema }),
    z.object({ mode: z.literal('new'), employment: z.object({ id: SlugSchema, employer: z.string().min(1).max(200) }) }),
  ]),
});
export type DraftJob = z.infer<typeof DraftJobSchema>;

/** An HMRC record on the review page: ticked to be recorded, under its job. */
export const DraftHmrcSchema = z.object({
  key: z.string(),
  include: z.boolean(),
  jobKey: z.string().optional(),
  /** The same record is stored already. */
  duplicateOf: z.string().optional(),
  record: ExtractedHmrcSchema,
});
export type DraftHmrc = z.infer<typeof DraftHmrcSchema>;

/**
 * A schedule a document gives, as the agreement it records (docs/INGESTION.md, "Schedules"): a new
 * one, or one recorded already that it fills in (new payments, their latest statuses).
 */
export const DraftAgreementSchema = z.object({
  key: z.string(),
  include: z.boolean(),
  target: z.discriminatedUnion('mode', [z.object({ mode: z.literal('new') }), z.object({ mode: z.literal('existing'), agreementId: SlugSchema })]),
  /** The agreement as this document gives it. */
  record: AgreementSchema.omit({ createdBy: true, createdAt: true, updatedAt: true }),
  /** For one recorded already: how many of its payments this adds, and how many statuses it updates. */
  adds: z.object({ payments: z.number().int().nonnegative(), statuses: z.number().int().nonnegative() }).optional(),
  /** Recorded payments its payments are, by their place in its schedule. */
  explains: z.array(z.object({ index: z.number().int().nonnegative(), transactionId: z.string(), accountId: SlugSchema, date: ISODateSchema, amount: MoneySchema })).max(120).default([]),
});
export type DraftAgreement = z.infer<typeof DraftAgreementSchema>;

export const DraftPayslipSchema = z.object({
  key: z.string(),
  include: z.boolean(),
  jobKey: z.string().optional(),
  /** The same payslip is stored already. */
  duplicateOf: z.string().optional(),
  record: ExtractedPayslipSchema,
});
export type DraftPayslip = z.infer<typeof DraftPayslipSchema>;

export const DraftFigureSchema = z.object({
  key: z.string(),
  include: z.boolean(),
  /** The job a pay figure is from (`DraftJob.key`). */
  jobKey: z.string().optional(),
  kind: z.enum(FIGURE_KINDS),
  label: z.string(),
  amount: MoneySchema,
  currency: CurrencySchema.default('GBP'),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  taxYear: z.string().optional(),
  payer: z.string().optional(),
  payerReference: z.string().optional(),
  accountId: SlugSchema.optional(),
  taxCode: z.string().max(20).optional(),
  /** `earned_pay`: the employer as its payslips name it (FORMULAS.md §17). */
  paidBy: z.string().max(200).optional(),
  work: WorkDetailSchema.optional(),
  /** An identical figure already stored. */
  duplicateOf: z.string().optional(),
  /** `earned_pay`: the figure an earlier upload of the timesheet gave for the same period, which this one replaces. */
  replaces: z.object({ id: z.string(), amount: MoneySchema }).optional(),
});
export type DraftFigure = z.infer<typeof DraftFigureSchema>;

export const DraftSchema = z.object({
  documentType: z.enum(EXTRACTION_DOC_TYPES),
  institutionName: z.string().optional(),
  documentDate: ISODateSchema.optional(),
  sections: z.array(DraftSectionSchema),
  figures: z.array(DraftFigureSchema).default([]),
  /** The jobs its pay figures and HMRC records are about (none on drafts made before jobs). */
  jobs: z.array(DraftJobSchema).optional(),
  hmrc: z.array(DraftHmrcSchema).optional(),
  payslips: z.array(DraftPayslipSchema).optional(),
  /** Schedules it gives, as agreements to record. */
  agreements: z.array(DraftAgreementSchema).optional(),
  notes: z.array(z.string()).default([]),
  /** The reader understood the document but found nothing to record: what it shows, in its words. */
  nothingToRecord: z.string().max(300).optional(),
  /** The account was taken from a screenshot taken and uploaded with this one (that import's id). */
  batchMatch: z.object({ accountId: SlugSchema, importId: z.string() }).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** OCR engine: recognised text and candidate values for the reviewer. */
  ocrText: z.string().optional(),
  candidates: z.object({ amounts: z.array(z.number()), dates: z.array(z.string()) }).optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const IMPORT_STATUSES = ['queued', 'processing', 'needs_mapping', 'review', 'committed', 'failed', 'discarded'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const ENGINE_IDS = ['csv', 'ofx', 'qif', 'santander-txt', 'govuk', 'payslip', 'inference', 'claude-cli', 'claude-api', 'ocr', 'manual'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const ImportRecordSchema = z.object({
  id: z.string().regex(/^imp_\d{8}_\d{6}_[0-9a-f]{4}$/),
  status: z.enum(IMPORT_STATUSES),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  committedAt: TimestampSchema.optional(),
  origin: z.enum(['upload', 'inbox', 'cli']).default('upload'),
  /** The account the user said this document belongs to (e.g. dropped onto that account). */
  hintAccountId: SlugSchema.optional(),
  /** The import that filed this document as adding nothing new, which this one opens again. */
  reopens: z.string().regex(/^imp_\d{8}_\d{6}_[0-9a-f]{4}$/).optional(),
  document: DocumentRefSchema,
  /** When you last saved changes to the draft: it is never drafted again by itself after that. */
  draftEditedAt: TimestampSchema.optional(),
  /**
   * A name to find it by in History, in place of the file's own name: given by Claude (the
   * `label-imports` job) or by you. Yours is never replaced. The document's `fileName` stays as it was.
   */
  label: z
    .object({
      text: z.string().min(1).max(120),
      provenance: ProvenanceSchema,
      at: TimestampSchema,
    })
    .optional(),
  /** CSV files in an unknown layout: the suggested column mapping awaiting confirmation. */
  mapping: z
    .object({
      profile: CsvProfileSchema,
      headers: z.array(z.string()),
      sample: z.array(z.array(z.string())),
      headerIndex: z.number().int(),
    })
    .optional(),
  extraction: z
    .object({
      engine: z.enum(ENGINE_IDS).optional(),
      /** e.g. csv profile id, or the model used. */
      detail: z.string().optional(),
      /** Version of the parser / prompt that produced `raw`, so old imports can be re-derived. */
      engineVersion: z.string().optional(),
      model: z.string().optional(),
      startedAt: TimestampSchema.optional(),
      finishedAt: TimestampSchema.optional(),
      durationMs: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      /** The local model service's record of the reading kept (engine "inference"). */
      inference: InferenceProvenanceSchema.optional(),
      /**
       * Waiting for the local model (it is down, or its GPU is lent out): since when, why, and until
       * when it said to try again. Cleared when the reading ends.
       */
      waiting: z.object({ since: TimestampSchema, reason: z.string(), until: TimestampSchema.optional() }).optional(),
      error: z.string().optional(),
      warnings: z.array(z.string()).default([]),
      /** Raw engine output, kept for audit and re-processing. */
      raw: ExtractionSchema.optional(),
      /**
       * How the reading was checked: by the document's own arithmetic (balances that reconcile,
       * printed totals, holdings that add up), or by a second reading with a stronger model.
       */
      verification: z
        .object({
          method: z.enum(['checks', 'second-reading']),
          firstModel: z.string(),
          secondModel: z.string().optional(),
          /** The local model service's record of each reading it made. */
          firstInference: InferenceProvenanceSchema.optional(),
          secondInference: InferenceProvenanceSchema.optional(),
          /**
           * Both readings still failed a check, and the check falls back to Claude (Settings → Models):
           * Claude read it a third time, and kept says which of the two compared was kept.
           */
          byClaude: z.boolean().optional(),
          /** Why a second reading was made. */
          reasons: z.array(z.string()).default([]),
          /** Figures the two readings did not agree on (the rows are marked). */
          disagreements: z.array(z.string()).default([]),
          kept: z.enum(['first', 'second']),
          /** Why the second reading could not be made, if it could not. */
          error: z.string().optional(),
        })
        .optional(),
      /** The reading that was not kept, for audit. */
      alternative: ExtractionSchema.optional(),
    })
    .default({ warnings: [] }),
  draft: DraftSchema.optional(),
  result: z
    .object({
      accountIds: z.array(SlugSchema),
      accountsCreated: z.array(SlugSchema).default([]),
      transactionsAdded: z.number().int().nonnegative(),
      transactionsSkipped: z.number().int().nonnegative(),
      balancesAdded: z.number().int().nonnegative(),
      holdingsAdded: z.number().int().nonnegative(),
      figuresAdded: z.number().int().nonnegative().default(0),
      /** HMRC records written, and the jobs it set up or that learned something from it. */
      hmrcAdded: z.number().int().nonnegative().optional(),
      payslipsAdded: z.number().int().nonnegative().optional(),
      /** Accounts whose terms (rates, limit, minimum payment) it recorded. */
      termsAdded: z.number().int().nonnegative().optional(),
      /** Agreements it recorded or filled in, from the schedules it gives. */
      agreementsAdded: z.number().int().nonnegative().optional(),
      employmentsCreated: z.array(SlugSchema).optional(),
      /** The job each draft job was committed to (new jobs get their final id). */
      jobs: z.array(z.object({ key: z.string(), employmentId: SlugSchema })).optional(),
      /** Dismissed as adding nothing new: why. Only the document and this record were written. */
      nothingNew: z.string().max(500).optional(),
      /** Copies of payments recorded twice that this import took away (the draft's `extraCopies`). */
      transactionsRemoved: z.array(z.object({ id: z.string(), date: ISODateSchema, amount: MoneySchema, description: z.string(), importId: z.string().optional() })).optional(),
      /** Recorded payments this import filled in details on (the draft rows' `adds`), and which. */
      transactionsDetailed: z.array(z.object({ id: z.string(), date: ISODateSchema, amount: MoneySchema, description: z.string(), added: z.array(z.enum(DETAIL_FIELDS)) })).optional(),
      /** The account each draft section was committed to (new accounts get their final id). */
      sections: z.array(z.object({ key: z.string(), accountId: SlugSchema })).optional(),
    })
    .optional(),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

// ─── Proposed fixes ──────────────────────────────────────────────────────────────────────────────
// Changes an agent found reasons for in your data, each with its reason (docs/AGENTS.md, "Proposing
// fixes"). Nothing changes until you apply them; you can leave any change out.

/**
 * - `pending`: waiting for you.
 * - `applied`: you applied it.
 * - `dismissed`: you said no; the same changes are refused after.
 * - `superseded`: your data came to say all of it first (an import or an edit got there), so it
 *   closed without changing anything. Not a no.
 */
export const PROPOSAL_STATUSES = ['pending', 'applied', 'dismissed', 'superseded'] as const;
/** Changes in one proposal: enough for one pattern across years of history (the page groups them). */
export const MAX_PROPOSED_CHANGES = 400;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const TransactionIdSchema = z.string().regex(/^tx_[0-9a-f]{16}$/);
const BalanceIdSchema = z.string().regex(/^bal_[0-9a-f]{16}$/);
/** Names a change within its proposal ("c1", "link-saver-oct"). */
const ChangeKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/** What in the data shows it, in a sentence or two. */
const ChangeWhySchema = z.string().trim().min(1).max(1000);

const changeUnion = <K extends z.ZodType<string | undefined>>(key: K) =>
  z.discriminatedUnion('kind', [
    /** Undo a transfer link: both rows of the pair are left unlinked (their categories stay). */
    z.object({ key, kind: z.literal('unlink_transfer'), why: ChangeWhySchema, transaction: TransactionIdSchema }),
    /** Link money out of one of your accounts with the same money into another, as a transfer. */
    z.object({ key, kind: z.literal('link_transfer'), why: ChangeWhySchema, from: TransactionIdSchema, to: TransactionIdSchema }),
    /**
     * Give a transaction a category (applied, it is yours: nothing re-categorises it). One the bank or
     * the reader guessed already is confirmed: it becomes yours.
     */
    z.object({ key, kind: z.literal('set_category'), why: ChangeWhySchema, transaction: TransactionIdSchema, category: z.string().min(1).max(64) }),
    /**
     * Make a rule, as you would in Settings → Rules: the payments it matches take its category, now
     * and as they come. Yours are left as they are.
     */
    z.object({ key, kind: z.literal('add_rule'), why: ChangeWhySchema, rule: z.object({ name: z.string().trim().min(1).max(120).optional(), match: RuleSchema.shape.match, category: z.string().min(1).max(64) }) }),
    /** Remove one of your rules: what it categorised goes back to what the app makes of it without it (yours stay yours). */
    z.object({ key, kind: z.literal('remove_rule'), why: ChangeWhySchema, rule: z.string().regex(/^rule_[0-9a-z]+$/) }),
    /** Add a group to your categories, or a category to one of the groups (`parent`). */
    z.object({ key, kind: z.literal('add_category'), why: ChangeWhySchema, category: z.object({ id: SlugSchema, name: z.string().trim().min(1).max(60), kind: z.enum(CATEGORY_KINDS), parent: SlugSchema.optional() }) }),
    /** Rename a group or a category, or move a category to another group (`parent`; null makes it a group of its own). */
    z.object({ key, kind: z.literal('change_category'), why: ChangeWhySchema, category: SlugSchema, name: z.string().trim().min(1).max(60).optional(), parent: SlugSchema.nullable().optional() }),
    /**
     * Give a transaction a note saying what the payment was for, from a document (the room and term
     * a rent instalment paid, say). Applied, it is yours, like a note you typed; it never replaces one.
     */
    z.object({ key, kind: z.literal('set_note'), why: ChangeWhySchema, transaction: TransactionIdSchema, note: z.string().trim().min(1).max(500) }),
    /** Remove a transaction that repeats money already recorded: the rows it repeats add up to it. */
    z.object({ key, kind: z.literal('remove_duplicate'), why: ChangeWhySchema, transaction: TransactionIdSchema, sameAs: z.array(TransactionIdSchema).min(1).max(10) }),
    /**
     * Remove a row a document was read into with the wrong sign: rows from another document record
     * the same money the right way round (they add up to it with its sign turned over).
     */
    z.object({ key, kind: z.literal('remove_wrong_sign'), why: ChangeWhySchema, transaction: TransactionIdSchema, recordedAs: z.array(TransactionIdSchema).min(1).max(10) }),
    /**
     * Remove a move inside an account (between its main balance and a Space its statements count
     * in the balance): the balances either side of it add up only without it.
     */
    z.object({ key, kind: z.literal('remove_internal_move'), why: ChangeWhySchema, transaction: TransactionIdSchema }),
    /** Set when an account opened or closed (null clears it; a closing date closes the account). */
    z.object({ key, kind: z.literal('set_account_dates'), why: ChangeWhySchema, account: SlugSchema, openedOn: ISODateSchema.nullable().optional(), closedOn: ISODateSchema.nullable().optional() }),
    /** Link an account to the one it carries on from, from a day: a product change under one account number. */
    z.object({ key, kind: z.literal('link_accounts'), why: ChangeWhySchema, account: SlugSchema, continues: SlugSchema, from: ISODateSchema }),
    /**
     * Move a balance a document was read into the wrong account to the account it is of: where it
     * is, that account was not open that day or its balances do not add up with it; where it goes,
     * they do.
     */
    z.object({ key, kind: z.literal('move_balance'), why: ChangeWhySchema, balance: BalanceIdSchema, to: SlugSchema }),
    /** Add a pension arrangement to a job: what its employer said it would pay into a pension account of yours. */
    z.object({ key, kind: z.literal('add_pension_arrangement'), why: ChangeWhySchema, employmentId: SlugSchema, arrangement: PensionArrangementSchema }),
    /**
     * Add an agreement that sets out payments you make (an accommodation offer, a contract), from its
     * document: its payments already in your data, and those to come, are filed under its category.
     */
    z.object({ key, kind: z.literal('add_agreement'), why: ChangeWhySchema, agreement: AgreementSchema.omit({ createdBy: true, createdAt: true, updatedAt: true }) }),
    /**
     * Set an account's terms as one of its documents (an import) gives them on its date: every rate
     * it prints, with what each applies to and until when, its limit and a card's minimum payment.
     * They replace the terms its reading kept for that account and day.
     */
    z.object({ key, kind: z.literal('set_terms'), why: ChangeWhySchema, account: SlugSchema, asOf: ISODateSchema, importId: z.string().regex(/^imp_\d{8}_\d{6}_[0-9a-f]{4}$/), terms: TermsSchema.pick({ rates: true, limit: true, minimumPayment: true, paymentDue: true }) }),
    /**
     * Take away the terms one of an account's documents (an import) was read as giving it on a day,
     * when they are not that account's: a statement split at a link gave the older account the rate
     * it prints for the newer.
     */
    z.object({ key, kind: z.literal('remove_terms'), why: ChangeWhySchema, account: SlugSchema, asOf: ISODateSchema, importId: z.string().regex(/^imp_\d{8}_\d{6}_[0-9a-f]{4}$/) }),
    /**
     * Add a company you hold shares in, from its documents (a share certificate, its accounts): your
     * holding, and its value as a new "other asset" account in your estate, valued on `valuation.asOf`.
     */
    z.object({
      key,
      kind: z.literal('add_company'),
      why: ChangeWhySchema,
      company: CompanySchema.pick({ id: true, name: true, number: true, holdings: true, employmentId: true, notes: true }),
      valuation: CompanyValuationSchema.omit({ balanceId: true }),
      account: z.object({ id: SlugSchema, name: z.string().min(1).max(120) }),
    }),
  ]);

export const ProposedChangeSchema = changeUnion(ChangeKeySchema);
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;
export type ProposedChangeKind = ProposedChange['kind'];

export const ProposalSchema = z.object({
  id: z.string().regex(/^prop_\d{8}_\d{6}_[0-9a-f]{4}$/),
  status: z.enum(PROPOSAL_STATUSES),
  title: z.string().min(1).max(160),
  /** What the data shows, in a few sentences. */
  summary: z.string().min(1).max(4000),
  /** In the order they apply: an unlink comes before the link that needs it. */
  changes: z.array(ProposedChangeSchema).min(1).max(MAX_PROPOSED_CHANGES),
  provenance: ProvenanceSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  /** Keys of the changes applied. */
  applied: z.array(z.string()).optional(),
  /** Why it was dismissed, if you said. */
  dismissedReason: z.string().max(1000).optional(),
  /** The rows, accounts, balances, categories and rules the applied changes touched, as they were before: the audit trail. */
  before: z.object({ transactions: z.array(TransactionSchema), accounts: z.array(AccountSchema), balances: z.array(BalanceSnapshotSchema).optional(), terms: z.array(TermsSchema).optional(), categories: z.array(CategorySchema).optional(), rules: z.array(RuleSchema).optional() }).optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** What an agent sends (POST /api/proposals): keys are given when missing. */
export const ProposalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(changeUnion(ChangeKeySchema.optional())).min(1).max(MAX_PROPOSED_CHANGES),
  provenance: ProvenanceSchema.omit({ setBy: true }).optional(),
  /** Check it against the data and show how it would look, without saving it. */
  dryRun: z.boolean().optional(),
});
export type ProposalInput = z.infer<typeof ProposalInputSchema>;

/** A public source a record rests on. */
export const SourceLinkSchema = z.object({
  title: z.string().min(1).max(300),
  url: z.url({ protocol: /^https?$/ }).optional(),
  publisher: z.string().max(120).optional(),
  /** When the page was read. */
  retrievedOn: ISODateSchema.optional(),
  /** A short verbatim excerpt supporting the value. */
  quote: z.string().max(600).optional(),
});
export type SourceLink = z.infer<typeof SourceLinkSchema>;

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

// ─── Instruments (funds, ETFs, shares…) ──────────────────────────────────────────────────────────

export const INSTRUMENT_TYPES = ['fund', 'etf', 'investment_trust', 'share', 'bond', 'gilt', 'money_market', 'crypto', 'other'] as const;

/** Fractions by asset class, summing to 1 (±0.02). */
export const AllocationSchema = z
  .object({
    equity: z.number().min(0).max(1).optional(),
    bond: z.number().min(0).max(1).optional(),
    cash: z.number().min(0).max(1).optional(),
    property: z.number().min(0).max(1).optional(),
    commodity: z.number().min(0).max(1).optional(),
    crypto: z.number().min(0).max(1).optional(),
    other: z.number().min(0).max(1).optional(),
  })
  .refine((a) => {
    const total = Object.values(a).reduce((s, v) => s + (v ?? 0), 0);
    return total > 0.98 && total < 1.02;
  }, 'Allocation fractions must sum to 1');
export type Allocation = z.infer<typeof AllocationSchema>;

export const InstrumentSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  type: z.enum(INSTRUMENT_TYPES).optional(),
  isin: z
    .string()
    .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, 'ISIN: 2 letters, 9 characters, 1 check digit')
    .optional(),
  ticker: z.string().max(20).optional(),
  sedol: z
    .string()
    .regex(/^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}\d$/)
    .optional(),
  currency: CurrencySchema.optional(),
  /** Fund manager or issuer, e.g. "Vanguard". */
  manager: z.string().optional(),
  /** Your own allocation for it; beats researched allocation. */
  allocation: AllocationSchema.optional(),
  /** Other names it appears under on statements and screenshots. */
  aliases: z.array(z.string()).default([]),
  notes: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Instrument = z.infer<typeof InstrumentSchema>;

// ─── Assumptions (forward-looking modelling parameters) ──────────────────────────────────────────

export const ASSUMPTION_SCOPE_KINDS = ['global', 'assetClass', 'accountType', 'institution', 'account', 'instrument'] as const;
export type AssumptionScopeKind = (typeof ASSUMPTION_SCOPE_KINDS)[number];

export const AssumptionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('assetClass'), assetClass: z.enum(ASSET_CLASSES) }),
  z.object({ kind: z.literal('accountType'), accountType: AccountTypeSchema }),
  z.object({ kind: z.literal('institution'), institutionId: SlugSchema }),
  z.object({ kind: z.literal('account'), accountId: SlugSchema }),
  z.object({ kind: z.literal('instrument'), instrumentId: SlugSchema }),
]);
export type AssumptionScope = z.infer<typeof AssumptionScopeSchema>;

/**
 * One version of one assumption. The file is append-only: a change appends a new record, so the
 * file itself is the history. The current value for (key, scope, who) is the newest record, unless
 * that record retires it. Keys, units, bounds and fallbacks are defined in src/shared/assumptions.ts.
 */
export const AssumptionSchema = z.object({
  id: z.string().regex(/^asm_[0-9a-f]{16}$/),
  key: z.string().min(1).max(64),
  scope: AssumptionScopeSchema,
  /** Rates are decimals (0.05 = 5% a year); money in pounds. */
  value: z.number(),
  /** Plausible range (roughly the 10th to 90th percentile of the long-run value). */
  range: z.object({ low: z.number(), high: z.number() }).optional(),
  /** The date the value reflects (e.g. the publication date of the outlook it rests on). */
  asOf: ISODateSchema,
  /** Short name of the source, e.g. "Vanguard economic and market outlook, Aug 2026". */
  source: z.string().min(1).max(300),
  evidence: z.array(SourceLinkSchema).default([]),
  /** Research records this value was derived from (the reasoning that links history to outlook). */
  basedOn: z.array(z.string().regex(/^res_[0-9a-f]{16}$/)).default([]),
  rationale: z.string().min(1).max(2000),
  provenance: ProvenanceSchema,
  /** "retired" withdraws this (key, scope) for this setter, e.g. an override you removed. */
  status: z.enum(['active', 'retired']).default('active'),
  /** Refresh after this date (agents treat the value as stale). */
  reviewBy: ISODateSchema.optional(),
  createdAt: TimestampSchema,
});
export type Assumption = z.infer<typeof AssumptionSchema>;

// ─── Research (dated, sourced facts about what you hold) ─────────────────────────────────────────

const Rate = z.number().min(-1).max(10);
const PeriodReturns = z.object({
  /** Annualised returns (decimals) over standard periods ending `periodEnd`. */
  y1: Rate.optional(),
  y3: Rate.optional(),
  y5: Rate.optional(),
  y10: Rate.optional(),
  sinceLaunch: Rate.optional(),
});

export const ResearchDataSchemas = {
  /** Identity, charges, allocation and benchmark of a fund, ETF or share. */
  'instrument.facts': z.object({
    name: z.string().optional(),
    isin: z.string().optional(),
    ticker: z.string().optional(),
    type: z.enum(INSTRUMENT_TYPES).optional(),
    manager: z.string().optional(),
    /** Ongoing charges figure, a decimal (0.0022 = 0.22% a year). */
    ocf: z.number().min(0).max(0.05).optional(),
    /** Transaction costs disclosed in the KID/factsheet, a decimal a year. */
    transactionCosts: z.number().min(-0.01).max(0.05).optional(),
    allocation: AllocationSchema.optional(),
    /** Fractions by region for the equity part, free-form keys (uk, northAmerica, europe, japan, asiaPacific, emerging…). */
    regions: z.record(z.string(), z.number().min(0).max(1)).optional(),
    benchmark: z.string().optional(),
    launchDate: ISODateSchema.optional(),
    distribution: z.enum(['accumulation', 'income']).optional(),
    /** Summary risk indicator 1-7 from the KID. */
    riskIndicator: z.number().int().min(1).max(7).optional(),
    currency: CurrencySchema.optional(),
    fundSizeGbp: z.number().nonnegative().optional(),
  }),
  /** Historical performance: past, not a forecast. */
  'instrument.performance': z.object({
    currency: CurrencySchema.default('GBP'),
    periodEnd: ISODateSchema,
    returns: PeriodReturns,
    benchmarkReturns: PeriodReturns.optional(),
    /** Calendar-year returns, oldest first. */
    calendarYears: z.array(z.object({ year: z.number().int(), return: Rate })).default([]),
    /** Annualised volatility of returns (standard deviation), decimals. */
    volatility: z.object({ y3: z.number().min(0).max(5).optional(), y5: z.number().min(0).max(5).optional() }).default({}),
    maxDrawdown: z.number().min(-1).max(0).optional(),
  }),
  /**
   * Published prices of a fund, ETF or share on past days (closing prices, or a fund's daily price),
   * in its currency's main unit (pounds, not pence): what values a holding between its valuations
   * (docs/FORMULAS.md §9, "Between valuations").
   */
  'instrument.prices': z.object({
    currency: CurrencySchema.default('GBP'),
    /** Where the prices are quoted ("LSE: SWDA"), and the share class when another class of the same fund stands in for it. */
    listing: z.string().max(200).optional(),
    points: z.array(z.object({ date: ISODateSchema, price: z.number().positive() })).min(1).max(1500),
  }),
  /** Interest rates of a provider's savings products. */
  'provider.rates': z.object({
    products: z
      .array(
        z.object({
          name: z.string().min(1),
          accountType: AccountTypeSchema.optional(),
          /** AER, a decimal. */
          aer: z.number().min(0).max(0.25),
          variable: z.boolean().default(true),
          /** An introductory bonus included in `aer`, and when it ends. */
          bonus: z.number().min(0).max(0.25).optional(),
          bonusEndsOn: ISODateSchema.optional(),
          conditions: z.string().optional(),
        }),
      )
      .min(1),
  }),
  /** Platform or provider charges. */
  'provider.fees': z.object({
    /** Percentage fee on assets, in tiers of account value (last tier has no upper bound). */
    tiers: z.array(z.object({ upToGbp: z.number().positive().optional(), rate: z.number().min(0).max(0.05) })).default([]),
    capGbpPerYear: z.number().nonnegative().optional(),
    fixedGbpPerYear: z.number().nonnegative().optional(),
    /** Which account types the schedule applies to (all when absent). */
    accountTypes: z.array(AccountTypeSchema).optional(),
    notes: z.string().optional(),
  }),
  /** A published long-run outlook (capital market assumptions) for an asset class. */
  'market.outlook': z.object({
    assetClass: z.enum(ASSET_CLASSES),
    publisher: z.string().min(1),
    horizonYears: z.number().int().min(1).max(50),
    currency: CurrencySchema.default('GBP'),
    expectedReturnNominal: Rate.optional(),
    expectedReturnReal: Rate.optional(),
    range: z.object({ low: Rate, high: Rate }).optional(),
    volatility: z.number().min(0).max(5).optional(),
  }),
  /** An economic series or forecast (inflation, earnings growth, Bank Rate). */
  'economy.indicator': z.object({
    indicator: z.enum(['cpi', 'earnings', 'bank-rate', 'house-prices', 'gilt-yield']),
    /** "latest" is an observed figure; "forecast" a published projection. */
    basis: z.enum(['latest', 'forecast', 'target']),
    value: z.number().min(-1).max(1),
    period: z.string().max(40),
    publisher: z.string().min(1),
  }),
} as const;

export const RESEARCH_KINDS = Object.keys(ResearchDataSchemas) as (keyof typeof ResearchDataSchemas)[];
export type ResearchKind = keyof typeof ResearchDataSchemas;

export const ResearchSubjectSchema = z
  .object({
    instrumentId: SlugSchema.optional(),
    institutionId: SlugSchema.optional(),
    assetClass: z.enum(ASSET_CLASSES).optional(),
    topic: z.string().max(80).optional(),
  })
  .refine((s) => Boolean(s.instrumentId || s.institutionId || s.assetClass || s.topic), 'A research record needs a subject');

/** What a writer supplies; the app adds id, provenance and createdAt. */
const researchInputBase = {
  subject: ResearchSubjectSchema,
  /** The date the facts describe (factsheet date, rate-table date). */
  asOf: ISODateSchema,
  sources: z.array(SourceLinkSchema).min(1),
  confidence: z.enum(CONFIDENCE).default('medium'),
  notes: z.string().max(2000).optional(),
};
const researchBase = {
  id: z.string().regex(/^res_[0-9a-f]{16}$/),
  ...researchInputBase,
  provenance: ProvenanceSchema,
  createdAt: TimestampSchema,
};
const D = ResearchDataSchemas;

export const ResearchInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...researchInputBase, kind: z.literal('instrument.facts'), data: D['instrument.facts'] }),
  z.object({ ...researchInputBase, kind: z.literal('instrument.performance'), data: D['instrument.performance'] }),
  z.object({ ...researchInputBase, kind: z.literal('instrument.prices'), data: D['instrument.prices'] }),
  z.object({ ...researchInputBase, kind: z.literal('provider.rates'), data: D['provider.rates'] }),
  z.object({ ...researchInputBase, kind: z.literal('provider.fees'), data: D['provider.fees'] }),
  z.object({ ...researchInputBase, kind: z.literal('market.outlook'), data: D['market.outlook'] }),
  z.object({ ...researchInputBase, kind: z.literal('economy.indicator'), data: D['economy.indicator'] }),
]);

export const ResearchSchema = z.discriminatedUnion('kind', [
  z.object({ ...researchBase, kind: z.literal('instrument.facts'), data: D['instrument.facts'] }),
  z.object({ ...researchBase, kind: z.literal('instrument.performance'), data: D['instrument.performance'] }),
  z.object({ ...researchBase, kind: z.literal('instrument.prices'), data: D['instrument.prices'] }),
  z.object({ ...researchBase, kind: z.literal('provider.rates'), data: D['provider.rates'] }),
  z.object({ ...researchBase, kind: z.literal('provider.fees'), data: D['provider.fees'] }),
  z.object({ ...researchBase, kind: z.literal('market.outlook'), data: D['market.outlook'] }),
  z.object({ ...researchBase, kind: z.literal('economy.indicator'), data: D['economy.indicator'] }),
]);
export type Research = z.infer<typeof ResearchSchema>;

// ─── Insights (inferred by Claude, never computed) ───────────────────────────────────────────────

export const INSIGHT_KINDS = ['month-review', 'habit', 'subscription', 'opportunity', 'risk', 'anomaly', 'fund', 'allowance', 'projection', 'data-quality', 'note'] as const;
export const INSIGHT_PAGES = ['overview', 'accounts', 'transactions', 'spending', 'projections', 'investments', 'tax', 'import'] as const;
export type InsightPage = (typeof INSIGHT_PAGES)[number];

/** What an insight rests on. Ids must resolve to stored records when the insight is written. */
export const InsightEvidenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transactions'), ids: z.array(z.string().regex(/^tx_[0-9a-f]{16}$/)).min(1).max(200), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('balance'), id: z.string().regex(/^bal_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('holdings'), id: z.string().regex(/^hld_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('figure'), id: z.string().regex(/^fig_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('research'), id: z.string().regex(/^res_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('assumption'), id: z.string().regex(/^asm_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('context'), id: z.string().regex(/^ctx_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('account'), id: SlugSchema, label: z.string().max(200).optional() }),
  /** A payslip in full (payslips.jsonl), a record of HMRC's (hmrc.jsonl), an agreement, a company or a job. */
  z.object({ type: z.literal('payslip'), id: z.string().regex(/^pay_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('hmrc'), id: z.string().regex(/^hmrc_[0-9a-f]{16}$/), label: z.string().max(200).optional() }),
  z.object({ type: z.literal('agreement'), id: SlugSchema, label: z.string().max(200).optional() }),
  z.object({ type: z.literal('company'), id: SlugSchema, label: z.string().max(200).optional() }),
  z.object({ type: z.literal('employment'), id: SlugSchema, label: z.string().max(200).optional() }),
  /** A computed figure the insight quotes, as the app reported it to the job. */
  z.object({ type: z.literal('computed'), metric: z.string().min(1).max(120), value: z.number().optional(), label: z.string().max(200).optional() }),
]);
export type InsightEvidence = z.infer<typeof InsightEvidenceSchema>;

/**
 * What became of a line a month in review said to watch: it happened, it did not, or the figures
 * cannot tell. "done" and "open" are older reviews' words for the first two.
 */
export const INSIGHT_FOLLOW_UP = ['happened', 'not-happened', 'unclear', 'done', 'open'] as const;

/** The parts of a month in review, in order (docs/AGENTS.md, "monthly-review"). */
export const REVIEW_SECTIONS = ['month', 'typical', 'people', 'worth', 'coming', 'now'] as const;

export const InsightSchema = z.object({
  id: z.string().regex(/^inf_[0-9a-f]{16}$/),
  kind: z.enum(INSIGHT_KINDS),
  /** Pages that show it. */
  pages: z.array(z.enum(INSIGHT_PAGES)).min(1),
  subject: z
    .object({
      accountId: SlugSchema.optional(),
      instrumentId: SlugSchema.optional(),
      category: z.string().optional(),
      taxYear: z
        .string()
        .regex(/^\d{4}\/\d{2}$/)
        .optional(),
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    })
    .default({}),
  title: z.string().min(1).max(160),
  body: z.string().max(4000),
  evidence: z.array(InsightEvidenceSchema).min(1),
  confidence: z.enum(CONFIDENCE),
  /** The data period the insight is about. */
  period: z.object({ from: ISODateSchema, to: ISODateSchema }).optional(),
  /** When it stops being relevant (hidden afterwards). */
  expiresOn: ISODateSchema.optional(),
  provenance: ProvenanceSchema,
  status: z.enum(['active', 'dismissed', 'superseded']).default('active'),
  /** The insight this one replaces (same job kind and subject, newer run). */
  supersedes: z.string().optional(),
  /** A month in review's lines to check the month after (docs/AGENTS.md, "monthly-review"). */
  watch: z.array(z.string().min(1).max(300)).max(3).optional(),
  /** How the review before's lines to watch turned out, by this month's figures. */
  followUp: z.array(z.object({ watch: z.string().min(1).max(300), outcome: z.enum(INSIGHT_FOLLOW_UP), note: z.string().max(500).optional() })).max(6).optional(),
  /** A month in review's few points that mattered most, each with what shows it. */
  keyPoints: z.array(z.object({ text: z.string().min(1).max(400), evidence: z.array(InsightEvidenceSchema).max(6).optional() })).max(5).optional(),
  /** A month in review's parts, in order; `body` holds them as text too. */
  sections: z.array(z.object({ id: z.enum(REVIEW_SECTIONS), heading: z.string().min(1).max(80), body: z.string().min(1).max(2500) })).max(REVIEW_SECTIONS.length).optional(),
  /** What the data does not let it say, said once: new limits only, not those an earlier review raised. */
  caveats: z.array(z.string().min(1).max(300)).max(4).optional(),
  /** Figures it quotes that the app could not find in the month's data (docs/AGENTS.md, "Checking a review"). */
  unchecked: z.array(z.string().max(40)).max(20).optional(),
  /** Proposals it made to fix the data, for you to apply or dismiss. */
  proposals: z.array(z.string().regex(/^prop_\d{8}_\d{6}_[0-9a-f]{4}$/)).max(5).optional(),
  /** Your reaction: kept with the insight so later jobs learn from it. */
  feedback: z.object({ useful: z.boolean(), note: z.string().max(500).optional(), at: TimestampSchema }).optional(),
  createdAt: TimestampSchema,
});
export type Insight = z.infer<typeof InsightSchema>;

// ─── Owner context (what you tell the app about yourself and your plans) ─────────────────────────

export const CONTEXT_KINDS = ['holding', 'plan', 'goal', 'preference', 'income', 'household', 'property', 'fact'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const ContextSchema = z.object({
  id: z.string().regex(/^ctx_[0-9a-f]{16}$/),
  kind: z.enum(CONTEXT_KINDS),
  /** A one-line statement in plain words ("We plan to buy a house in 2028 for about £400,000"). */
  statement: z.string().min(1).max(1000),
  /** Structured detail; every field optional, used as the kind needs. */
  detail: z
    .object({
      accountId: SlugSchema.optional(),
      institutionId: SlugSchema.optional(),
      instrumentId: SlugSchema.optional(),
      /** "buy-home", "retire", "career-break", "child", "wedding"… */
      event: z.string().max(40).optional(),
      amount: MoneySchema.optional(),
      /** A yearly amount (salary, pension income wanted, contributions). */
      annualAmount: MoneySchema.optional(),
      rate: z.number().min(-1).max(1).optional(),
      date: ISODateSchema.optional(),
      from: ISODateSchema.optional(),
      to: ISODateSchema.optional(),
      /** Accounts a plan draws on (e.g. the LISA and savings for a deposit). */
      accountIds: z.array(SlugSchema).optional(),
      attributes: AttributesSchema.optional(),
    })
    .default({}),
  status: z.enum(['active', 'done', 'retired']).default('active'),
  /** Where it came from: typed in a form, interpreted from one of your notes, or read from a document you gave (named). */
  origin: z.object({ kind: z.enum(['form', 'note', 'document']), noteId: z.string().optional(), document: z.string().max(200).optional(), interpretedBy: ProvenanceSchema.optional() }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ContextRecord = z.infer<typeof ContextSchema>;

/** Something you told the app in plain words, and what an agent proposed to record from it. */
export const NoteSchema = z.object({
  id: z.string().regex(/^note_[0-9a-f]{16}$/),
  text: z.string().min(1).max(4000),
  status: z.enum(['new', 'interpreting', 'proposed', 'applied', 'dismissed', 'failed']).default('new'),
  /** Records proposed by the interpreting job, waiting for you to accept or edit. */
  proposals: z
    .array(
      z.object({
        key: z.string(),
        type: z.enum(['context', 'instrument']),
        /** The record as proposed (validated again when you accept it). */
        record: z.record(z.string(), z.unknown()),
        explanation: z.string().max(500),
        accepted: z.boolean().optional(),
      }),
    )
    .default([]),
  jobId: z.string().optional(),
  error: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Note = z.infer<typeof NoteSchema>;

// ─── Receipts ────────────────────────────────────────────────────────────────────────────────────

/**
 * A receipt you attached to a transaction: the document (kept with your other documents, served by
 * id) and, when reading receipts with Claude is on, what it read, proposed as split lines that you
 * accept or edit. Nothing about the transaction changes until you do.
 */
export const ReceiptSchema = z.object({
  id: z.string().regex(/^rct_[0-9a-f]{16}$/),
  transactionId: z.string().regex(/^tx_[0-9a-f]{16}$/),
  document: DocumentRefSchema,
  status: z.enum(['attached', 'reading', 'read', 'failed']).default('attached'),
  reading: z
    .object({
      model: z.string(),
      promptVersion: z.string(),
      at: TimestampSchema,
      costUsd: z.number().nonnegative().optional(),
      /** Read by the local model service: its record of the answer. */
      inference: InferenceProvenanceSchema.optional(),
      merchant: z.string().nullable().default(null),
      date: ISODateSchema.nullable().default(null),
      total: MoneySchema.nullable().default(null),
      /** Lines as printed, signed like the payment (money out negative), with a suggested category. */
      lines: z.array(z.object({ description: z.string().max(200), amount: MoneySchema, category: z.string().nullable().default(null) })).max(200),
      notes: z.array(z.string().max(300)).default([]),
    })
    .optional(),
  error: z.string().max(500).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

// ─── Capture list ────────────────────────────────────────────────────────────────────────────────
//
// What to collect from each provider for a big import: which statements, screenshots and
// documents, and why. The app ticks an ask off when the data shows it (`check`); you tick the rest.

export const CaptureCheckSchema = z.discriminatedUnion('type', [
  /** The account's imported statements cover `from`–`to` (to: about a month ago when omitted). */
  z.object({ type: z.literal('coverage'), from: ISODateSchema, to: ISODateSchema.optional() }),
  /** A balance or valuation that is not approximate, dated on or after `since`; with a holdings snapshot too when `holdings`. */
  z.object({ type: z.literal('valuation'), since: ISODateSchema, holdings: z.boolean().default(false) }),
  /** Tax figures of one of these kinds for the tax year (e.g. `gross_pay` from a P60). */
  z.object({
    type: z.literal('figures'),
    kinds: z.array(z.enum(FIGURE_KINDS)).min(1),
    taxYear: z.string().regex(/^\d{4}\/\d{2}$/),
    /** Only figures from a P60 (the whole year) or only from payslips (a pay period). */
    from: z.enum(['p60', 'payslip']).optional(),
    /** Only this employer's or payer's figures. */
    payer: z.string().optional(),
  }),
]);
export type CaptureCheck = z.infer<typeof CaptureCheckSchema>;

export const CaptureAskSchema = z.object({
  /** Unique within its item. */
  id: SlugSchema,
  /** What to capture, in a few words: "Statements from 6 April 2025 to now". */
  what: z.string().min(1),
  /** Where to find it, and in what form. */
  how: z.string().optional(),
  /** What the app does with it. */
  why: z.string().optional(),
  check: CaptureCheckSchema.optional(),
  /** When you ticked it off yourself. */
  doneAt: TimestampSchema.optional(),
});
export type CaptureAsk = z.infer<typeof CaptureAskSchema>;

export const CaptureItemSchema = z.object({
  id: SlugSchema,
  /** The account or document to collect: "Santander current account", "P60 from your employer". */
  title: z.string().min(1),
  accountId: SlugSchema.optional(),
  institutionId: SlugSchema.optional(),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  /** One line of context for the whole item. */
  note: z.string().optional(),
  asks: z.array(CaptureAskSchema).min(1),
  /** When you decided not to collect it. */
  skippedAt: TimestampSchema.optional(),
  provenance: ProvenanceSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type CaptureItem = z.infer<typeof CaptureItemSchema>;

// ─── On-disk file envelopes ──────────────────────────────────────────────────────────────────────

export const AccountsFileSchema = z.object({ accounts: z.array(AccountSchema) });
export const InstrumentsFileSchema = z.object({ instruments: z.array(InstrumentSchema) });
export const EmploymentsFileSchema = z.object({ employments: z.array(EmploymentSchema) });
export const CompaniesFileSchema = z.object({ companies: z.array(CompanySchema) });
export const AgreementsFileSchema = z.object({ agreements: z.array(AgreementSchema) });
export const CoverageFileSchema = z.object({ confirmations: z.array(CoverageConfirmationSchema) });
/** people.json: the people you send money to or get money from. */
export const PeopleFileSchema = z.object({ people: z.array(PersonSchema) });
export const InstitutionsFileSchema = z.object({ institutions: z.array(InstitutionSchema) });
export const CategoriesFileSchema = z.object({ categories: z.array(CategorySchema) });
export const RulesFileSchema = z.object({ rules: z.array(RuleSchema) });
export const GoalsFileSchema = z.object({ goals: z.array(GoalSchema) });
export const BudgetsFileSchema = z.object({ budgets: z.array(BudgetSchema) });
export const CaptureFileSchema = z.object({ items: z.array(CaptureItemSchema) });
export const CsvProfilesFileSchema = z.object({ profiles: z.array(CsvProfileSchema) });
