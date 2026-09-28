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
  notes: z.string().optional(),
  attributes: AttributesSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Account = z.infer<typeof AccountSchema>;

// ─── Transactions ────────────────────────────────────────────────────────────────────────────────

export const CATEGORISED_BY = ['user', 'rule', 'builtin', 'bank', 'ai', 'transfer'] as const;
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

export const TransactionSchema = z.object({
  id: z.string().regex(/^tx_[0-9a-f]{16}$/),
  accountId: SlugSchema,

  // ── Source facts: exactly what the statement/export/screenshot said. Never rewritten. ──
  /** Posting date (the date the balance moved). */
  date: ISODateSchema,
  /** When the purchase itself happened, if the source shows a different date. */
  transactionDate: ISODateSchema.optional(),
  /** Local time of day, if known: HH:MM or HH:MM:SS. */
  time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
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

  // ── Enrichment: derived and recomputable (except where categorisedBy = "user"). ──
  /** Clean merchant or counterparty name. */
  payee: z.string().optional(),
  /** Category id from categories.json. Absent = uncategorised. */
  category: z.string().optional(),
  categorisedBy: z.enum(CATEGORISED_BY).optional(),
  ruleId: z.string().optional(),
  /** Shared by both legs of a transfer between your own accounts. */
  transferGroup: z.string().optional(),
  /** Your own account on the other side of this transfer, when known. */
  counterpartyAccountId: SlugSchema.optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // ── Provenance ──
  source: SourceRefSchema.default({}),
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
  creditLimit: MoneySchema.optional(),
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
  taxYear: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .optional(),
  /** DB / state pension: forecast annual income. */
  annualIncome: MoneySchema.optional(),
  interestRate: z.number().optional(),
  note: z.string().optional(),
  dateSource: z.enum(DATE_SOURCES).optional(),
  attributes: AttributesSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type BalanceSnapshot = z.infer<typeof BalanceSnapshotSchema>;

export const ASSET_CLASSES = ['equity', 'bond', 'mixed', 'property', 'cash', 'commodity', 'crypto', 'other'] as const;

export const HoldingSchema = z.object({
  name: z.string().min(1),
  isin: z.string().optional(),
  ticker: z.string().optional(),
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
  'other',
] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

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
  notes: z.string().optional(),
  attributes: AttributesSchema.optional(),
  source: SourceRefSchema.default({}),
  createdAt: TimestampSchema,
});
export type Figure = z.infer<typeof FigureSchema>;

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

export const GoalSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  targetAmount: MoneySchema,
  targetDate: ISODateSchema.optional(),
  accountIds: z.array(SlugSchema).default([]),
  notes: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Goal = z.infer<typeof GoalSchema>;

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
  /** Highest income tax band you pay; drives the Personal Savings Allowance. */
  taxBand: z.enum(['none', 'basic', 'higher', 'additional']).optional(),
  /** Gross annual salary, optional; used for savings rate and pension headroom hints. */
  grossSalary: MoneySchema.optional(),
  retirementAge: z.number().int().min(50).max(80).default(67),
  /** Assumed real (after inflation) annual growth for projections, e.g. 0.04. */
  assumedRealReturn: z.number().min(-0.1).max(0.2).default(0.04),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const EXTRACTION_ENGINES = ['auto', 'claude-cli', 'claude-api', 'ocr'] as const;
export type ExtractionEnginePreference = (typeof EXTRACTION_ENGINES)[number];

export const SettingsSchema = z.object({
  extraction: z
    .object({
      engine: z.enum(EXTRACTION_ENGINES).default('auto'),
      /** "opus", "sonnet" or a full model id. */
      model: z.string().default('opus'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
      maxConcurrent: z.number().int().min(1).max(4).default(2),
      /** Seconds before an extraction is abandoned. */
      timeoutSeconds: z.number().int().min(30).max(3600).default(900),
    })
    .default({ engine: 'auto', model: 'opus', effort: 'high', maxConcurrent: 2, timeoutSeconds: 900 }),
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
});
export type Settings = z.infer<typeof SettingsSchema>;

export const MetaSchema = z.object({
  format: z.literal('finance-data'),
  version: z.number().int().positive(),
  baseCurrency: CurrencySchema.default('GBP'),
  createdAt: TimestampSchema,
});
export type Meta = z.infer<typeof MetaSchema>;

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
  'annual_summary',
  'interest_certificate',
  'payslip',
  'p60',
  'p11d',
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
});
export type ExtractedTransaction = z.infer<typeof ExtractedTransactionSchema>;

export const ExtractedHoldingSchema = z.object({
  name: z.string(),
  isin: z.string().nullable().default(null),
  ticker: z.string().nullable().default(null),
  units: z.number().nullable().default(null),
  price: z.number().nullable().default(null),
  value: MoneySchema,
  currency: CurrencySchema.nullable().default(null),
  assetClass: z.enum(ASSET_CLASSES).nullable().default(null),
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
  cashBalance: MoneySchema.nullable().default(null),
  annualIncome: MoneySchema.nullable().default(null),
  interestRate: z.number().nullable().default(null),
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
});
export type ExtractedFigure = z.infer<typeof ExtractedFigureSchema>;

export const ExtractionSchema = z.object({
  documentType: z.enum(EXTRACTION_DOC_TYPES).default('other'),
  institutionName: z.string().nullable().default(null),
  /** Date printed on the document / screenshot, if any. */
  documentDate: ISODateSchema.nullable().default(null),
  accounts: z.array(ExtractedAccountSchema).default([]),
  figures: z.array(ExtractedFigureSchema).default([]),
  notes: z.array(z.string()).default([]),
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
  row: z.number().int().optional(),
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
  currency: CurrencySchema.default('GBP'),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  openingBalance: MoneySchema.optional(),
  /** Whether to record the balance snapshot below. */
  recordBalance: z.boolean().default(true),
  balance: MoneySchema.optional(),
  balanceDate: ISODateSchema.optional(),
  balanceDateSource: z.enum(DATE_SOURCES).optional(),
  availableBalance: MoneySchema.optional(),
  creditLimit: MoneySchema.optional(),
  contributions: MoneySchema.optional(),
  gain: MoneySchema.optional(),
  cash: MoneySchema.optional(),
  bonusToDate: MoneySchema.optional(),
  taxYearContributions: MoneySchema.optional(),
  annualIncome: MoneySchema.optional(),
  interestRate: z.number().optional(),
  transactions: z.array(DraftTransactionSchema).default([]),
  recordHoldings: z.boolean().default(true),
  holdings: z.array(HoldingSchema).default([]),
});
export type DraftSection = z.infer<typeof DraftSectionSchema>;

export const DraftFigureSchema = z.object({
  key: z.string(),
  include: z.boolean(),
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
  /** An identical figure already stored. */
  duplicateOf: z.string().optional(),
});
export type DraftFigure = z.infer<typeof DraftFigureSchema>;

export const DraftSchema = z.object({
  documentType: z.enum(EXTRACTION_DOC_TYPES),
  institutionName: z.string().optional(),
  documentDate: ISODateSchema.optional(),
  sections: z.array(DraftSectionSchema),
  figures: z.array(DraftFigureSchema).default([]),
  notes: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** OCR engine: recognised text and candidate values for the reviewer. */
  ocrText: z.string().optional(),
  candidates: z.object({ amounts: z.array(z.number()), dates: z.array(z.string()) }).optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const IMPORT_STATUSES = ['queued', 'processing', 'needs_mapping', 'review', 'committed', 'failed', 'discarded'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const ENGINE_IDS = ['csv', 'ofx', 'qif', 'santander-txt', 'claude-cli', 'claude-api', 'ocr', 'manual'] as const;
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
  document: DocumentRefSchema,
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
      error: z.string().optional(),
      warnings: z.array(z.string()).default([]),
      /** Raw engine output, kept for audit and re-processing. */
      raw: ExtractionSchema.optional(),
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
    })
    .optional(),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

// ─── On-disk file envelopes ──────────────────────────────────────────────────────────────────────

export const AccountsFileSchema = z.object({ accounts: z.array(AccountSchema) });
export const InstitutionsFileSchema = z.object({ institutions: z.array(InstitutionSchema) });
export const CategoriesFileSchema = z.object({ categories: z.array(CategorySchema) });
export const RulesFileSchema = z.object({ rules: z.array(RuleSchema) });
export const GoalsFileSchema = z.object({ goals: z.array(GoalSchema) });
export const CsvProfilesFileSchema = z.object({ profiles: z.array(CsvProfileSchema) });
