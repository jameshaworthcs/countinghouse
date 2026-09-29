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
  /** "user" when you set the payee yourself: re-running enrichment never changes it. */
  payeeSetBy: z.enum(['user']).optional(),
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
  /**
   * A figure you gave roughly (a starting snapshot, a range's middle). It stands in only for what
   * is newer than the account's real data, and balances from it are marked estimated.
   */
  approximate: z.boolean().optional(),
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
  // Format v2 files may still carry `taxBand`: it is now worked out from your income (FORMULAS.md
  // §11) and is dropped when the profile is next saved.
  /** Gross annual salary, optional: estimates your tax band before your P60 arrives, and pension headroom hints. */
  grossSalary: MoneySchema.optional(),
  /** When you plan to stop work: drives the retirement outlook. */
  retirementAge: z.number().int().min(50).max(80).default(67),
  // Returns, inflation and other modelling parameters are assumption records (assumptions.jsonl),
  // not profile fields. Format v1's `assumedRealReturn` was moved there by the v2 migration.
});
export type Profile = z.infer<typeof ProfileSchema>;

export const EXTRACTION_ENGINES = ['auto', 'claude-cli', 'claude-api', 'ocr'] as const;
export type ExtractionEnginePreference = (typeof EXTRACTION_ENGINES)[number];

export const SettingsSchema = z.object({
  extraction: z
    .object({
      engine: z.enum(EXTRACTION_ENGINES).default('auto'),
      /** The model that reads every document: "sonnet", "opus" or a full model id. */
      model: z.string().default('sonnet'),
      /**
       * The model that checks it: it reads the document again whenever the checks fail or the
       * document has nothing to check its figures against. Empty turns checking off.
       */
      verifyModel: z.string().default('opus'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
      maxConcurrent: z.number().int().min(1).max(4).default(2),
      /** Seconds before an extraction is abandoned. */
      timeoutSeconds: z.number().int().min(30).max(3600).default(900),
    })
    .default({ engine: 'auto', model: 'sonnet', verifyModel: 'opus', effort: 'high', maxConcurrent: 2, timeoutSeconds: 900 }),
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
  /** In-app agent jobs (research, insights, reviews) run through the same Claude engine. */
  agents: z
    .object({
      enabled: z.boolean().default(true),
      /** "opus", "sonnet" or a full model id. */
      model: z.string().default('opus'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
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
      backgroundBudgetPerDayUsd: z.number().min(0).max(100).default(5),
      backgroundBudgetPerMonthUsd: z.number().min(0).max(1000).default(40),
    })
    .default({ enabled: true, model: 'opus', effort: 'high', researchStaleAfterDays: 90, insightsAfterImport: true, monthlyReview: true, timeoutSeconds: 1200, autoResearch: false, backgroundBudgetPerDayUsd: 5, backgroundBudgetPerMonthUsd: 40 }),
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
  cashBalance: MoneySchema.nullable().default(null),
  annualIncome: MoneySchema.nullable().default(null),
  interestRate: z.number().nullable().default(null),
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
  row: z.number().int().optional(),
  /** What the reader was unsure of on this row ("year not shown", "amount partly hidden"). */
  uncertain: z.string().max(300).optional(),
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
  currency: CurrencySchema.default('GBP'),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  openingBalance: MoneySchema.optional(),
  /** Totals printed on the statement, for checking the rows against. Money out is positive. */
  statedTotals: z.object({ moneyIn: MoneySchema.optional(), moneyOut: MoneySchema.optional() }).optional(),
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
  /**
   * The opening balance and running balances are the account's uninvested cash, not its value (an
   * investment app's activity list). `cash` holds the closing cash; no value is recorded from it.
   */
  cashLedger: z.boolean().optional(),
  recordHoldings: z.boolean().default(true),
  holdings: z.array(HoldingSchema).default([]),
  /** The document shows only some of the account's holdings; they join the others recorded that day. */
  holdingsPartial: z.boolean().optional(),
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
  /** The reader understood the document but found nothing to record: what it shows, in its words. */
  nothingToRecord: z.string().max(300).optional(),
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
      /**
       * How the reading was checked: by the document's own arithmetic (balances that reconcile,
       * printed totals, holdings that add up), or by a second reading with a stronger model.
       */
      verification: z
        .object({
          method: z.enum(['checks', 'second-reading']),
          firstModel: z.string(),
          secondModel: z.string().optional(),
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
      /** The account each draft section was committed to (new accounts get their final id). */
      sections: z.array(z.object({ key: z.string(), accountId: SlugSchema })).optional(),
    })
    .optional(),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

// ─── Provenance shared by agent-maintained records ───────────────────────────────────────────────

/** Who set a record. The owner's records always win over an agent's (see docs/AGENTS.md). */
export const SET_BY = ['owner', 'agent', 'system'] as const;
export type SetBy = (typeof SET_BY)[number];

export const ProvenanceSchema = z.object({
  setBy: z.enum(SET_BY),
  /** Model that produced it (agents), e.g. "claude-opus-5-5". */
  model: z.string().optional(),
  /** Version of the job prompt that produced it, e.g. "research-instrument-1". */
  promptVersion: z.string().optional(),
  /** The in-app job that wrote it. */
  jobId: z.string().optional(),
  /** Where an agent ran outside the app, e.g. "claude-code". */
  session: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

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
  z.object({ ...researchInputBase, kind: z.literal('provider.rates'), data: D['provider.rates'] }),
  z.object({ ...researchInputBase, kind: z.literal('provider.fees'), data: D['provider.fees'] }),
  z.object({ ...researchInputBase, kind: z.literal('market.outlook'), data: D['market.outlook'] }),
  z.object({ ...researchInputBase, kind: z.literal('economy.indicator'), data: D['economy.indicator'] }),
]);

export const ResearchSchema = z.discriminatedUnion('kind', [
  z.object({ ...researchBase, kind: z.literal('instrument.facts'), data: D['instrument.facts'] }),
  z.object({ ...researchBase, kind: z.literal('instrument.performance'), data: D['instrument.performance'] }),
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
  /** A computed figure the insight quotes, as the app reported it to the job. */
  z.object({ type: z.literal('computed'), metric: z.string().min(1).max(120), value: z.number().optional(), label: z.string().max(200).optional() }),
]);
export type InsightEvidence = z.infer<typeof InsightEvidenceSchema>;

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
export const InstitutionsFileSchema = z.object({ institutions: z.array(InstitutionSchema) });
export const CategoriesFileSchema = z.object({ categories: z.array(CategorySchema) });
export const RulesFileSchema = z.object({ rules: z.array(RuleSchema) });
export const GoalsFileSchema = z.object({ goals: z.array(GoalSchema) });
export const CaptureFileSchema = z.object({ items: z.array(CaptureItemSchema) });
export const CsvProfilesFileSchema = z.object({ profiles: z.array(CsvProfileSchema) });
