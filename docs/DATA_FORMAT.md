# Data format (v2)

Everything the app knows lives in the data directory (`data/`, or `demo-data/` for the demo) as
plain JSON and JSONL. The Zod schemas in [`src/shared/schema.ts`](../src/shared/schema.ts) are the
source of truth. JSON Schemas generated from them are in [`schemas/`](../schemas/); the JSON files
point at them with `"$schema"` so editors validate as you type.

## Conventions

| | |
|---|---|
| Money | JSON number in **pounds** (major units), at most 2 dp: `-4.5`, `1234.56`. Integer pence internally. |
| Sign | From your point of view. Positive increases net worth (money in, assets); negative decreases it (money out, balances owed). A credit-card purchase is negative; a card balance owed is negative. One exception: a company's journal lines (`journals.jsonl`) are inside its books, so debits are positive and credits negative (below). |
| Dates | `YYYY-MM-DD` calendar dates. Timestamps are ISO 8601 with offset (`2026-09-28T21:08:17+01:00`). |
| Ids | Accounts, institutions, categories and jobs are readable slugs (`monzo-current`). Records have prefixed content hashes assigned once at creation: `tx_`, `bal_`, `hld_`, `fig_` + 16 hex. HMRC's records: `hmrc_` + 16 hex of what the record says, and payslips: `pay_` + 16 hex of what identifies one, so one read twice is stored once. Imports: `imp_YYYYMMDD_HHMMSS_xxxx`. Documents: `doc_` + first 16 hex of the SHA-256. |
| Unknown fields | Not part of the format. They are reported by `npm run validate`, and a record that fails validation is kept verbatim (quarantined) rather than lost. |
| Versioning | `meta.json → version`. Migrations upgrade files in place (see `src/server/migrations.ts` and "Versions" below). |

## Layout

```
data/
  meta.json            format + version + base currency
  profile.json         you: date of birth, region, salary, retirement age (the tax band is computed), and `employers`: how many months after the work a payroll with no job yet pays a timesheet (`[{name, payLagMonths}]`, optional; a job keeps its own); and `selfAssessment` (optional): `{sendsReturns?, years?: {"2025/26": {status: not-needed | told-hmrc | registered | filed | paid, updatedAt, note?}}}`, what you told the app on Tax → Self Assessment prep (FORMULAS.md §11, "Self Assessment alerts")
  settings.json        models per task (`models.tasks`: the engine, model, thinking or effort, and Claude fallback for each task in src/shared/tasks.ts), Ask (`ask.maxToolCalls`: tool calls for one question, 8 by default; optional), extraction (reading receipts or stored documents again, both off by default; reading everything), agents (off by default; with the background budget, and `labelImports`: names for imports, and `earmarkSuggest`: the local model suggesting set-aside decisions, both off by default), git behaviour, stale threshold, FX rates
  institutions.json    { institutions: [...] }   banks, platforms, providers (+ FSCS group)
  accounts.json        { accounts: [...] }
  categories.json      { categories: [...] }     editable taxonomy (system ones drive calculations)
  rules.json           { rules: [...] }          your categorisation rules
  goals.json           { goals: [...] }
  budgets.json         { budgets: [...] }            monthly spending budgets
  capture.json         { items: [...] }          what to collect from each provider (the capture list)
  actions.json         { actions: [...] }        what the months in review asked you to do (optional)
  csv-profiles.json    { profiles: [...] }       your saved CSV column mappings
  instruments.json     { instruments: [...] }    funds, ETFs and shares you hold
  assumptions.jsonl    every version of every modelling assumption (append-only)
  research.jsonl       dated, sourced research about funds, providers and the economy (append-only)
  insights.jsonl       Claude's inferences, with evidence and provenance
  context.jsonl        what you have told the app about yourself and your plans
  notes.jsonl          your words, and the records proposed from them
  receipts.jsonl       receipts attached to transactions, and what Claude read on them (when turned on)
  figures.jsonl        one tax figure per line (P60, interest certificates, …)
  employments.json     { employments: [...] }    your jobs: each employer once, under every name it comes by
  hmrc.jsonl           what HMRC's pages say: tax codes, payments, employments, settlements, NI years, the State Pension forecast
  payslips.jsonl       payslips in full: every line, the totals, the codes and the year to date
  terms.jsonl          each account's terms as each document gives them: its rates, its limit and a card's minimum payment
  journals.jsonl       a company's journals: the entries in its books that are not payments (optional: no file, none)
  companies.json       { companies: [...] }      companies you hold shares in: the holding and its valuations
  agreements.json      { agreements: [...] }     agreements: an offer's, contract's or award's schedule of payments, and what its document says
  coverage.json        { confirmations: [...] }  stretches you confirmed nothing is missing from, which count as covered
  people.json          { people: [...] }         people you send money to or get money from: the names their payments carry, and how money with them usually goes
  returns.json         { returns: [...] }        what you told the app for each tax year's Self Assessment return: answers and box figures
  earmarks.json        { everyday, setAside, pots, decisions, updatedAt }  optional: money set aside inside your everyday accounts (no file, no feature)
  transactions/<account-id>/<yyyy>.jsonl    one transaction per line, by posting date
  balances/<account-id>.jsonl               balance / valuation snapshots
  holdings/<account-id>.jsonl               holdings snapshots
  imports/<yyyy>/<import-id>.json           provenance for every committed import
  proposals/<yyyy>/<proposal-id>.json       fixes an agent proposed that you applied or dismissed
  documents/<yyyy>/<mm>/<sha12>-<file>      original statements and screenshots
```

## accounts.json

| Field | Type | Notes |
|---|---|---|
| `id` | slug | Stable; used in file paths |
| `name` | string | |
| `type` | enum | `current` `savings` `cash_isa` `stocks_isa` `lisa` `ifisa` `gia` `sipp` `workplace_pension` `personal_pension` `db_pension` `state_pension` `premium_bonds` `crypto` `property` `other_asset` `credit_card` `loan` `mortgage` `student_loan` `other_liability` `director_loan` |
| `institutionId` | slug? | → institutions.json |
| `currency` | ISO 4217 | default `GBP` |
| `status` | `open` \| `closed` | plus optional `openedOn`, `closedOn` |
| `last4` | digits? | last 2–6 digits of the account/card number, never more |
| `aliases` | string[] | other names it appears under in payment descriptions (links transfers) |
| `spaces` | string[]? | Spaces (or pots) inside it whose money its statements count in the balance: moves to and from them are left out of imports ([INGESTION.md](INGESTION.md), "Moves inside an account") |
| `balanceMode` | `ledger` \| `market`? | overrides the type default (see ARCHITECTURE.md) |
| `includeInNetWorth` | boolean | the estate value includes it |
| `flexibleIsa`, `interestRate`, `maturesOn`, `pension{employer,method}`, `notes`, `attributes` | optional | |
| `continues` | `{accountId, from}`? | the account this one carries on from, from that day: a product change under one account number (a fixed rate maturing into easy access). A statement that runs across the day is split between the two ([INGESTION.md](INGESTION.md), "Linked accounts"). Only between two accounts on one side (both yours, or both one company's) |
| `companyId` | slug? | → companies.json. A company's own account (its bank account, its card), not yours: its money is the company's. Absent: yours |

**A company's own account** (`companyId` set) is never in your estate: `includeInNetWorth` is always
`false`. Every write that would make it `true` is refused (a 400), whoever writes (the Accounts page,
the API, an import, a proposal); a new one is out of the estate by default. It must name a company in
companies.json, and cannot be the account that carries your shares in a company (`Company.accountId`,
which is yours). Nothing of yours names one: a goal's accounts, an agreement's account, a rule's
accounts or counterparty and money set aside (its accounts, and its pots' rules' accounts and
counterparties) are refused when they would, and an account cannot change side while one of them
names it. Its rows get no category of yours, not even one set by hand (each leg of a transfer
between two of its company's accounts has the transfer category), and it counts in no
personal figure ([FORMULAS.md §9](FORMULAS.md), [ARCHITECTURE.md](ARCHITECTURE.md), "Company
accounts"). Reading the data warns of one naming a company that is not there, one that says it counts
in the estate, a link carrying on across the line, and a record of yours that names one. Adding the field needed no format change: an
account without it is yours, as every account was.

**A director's loan account** (`type: "director_loan"`) is yours: what a company of yours owes you
(negative: what you owe it), in your estate by default, in the "Property & other" net-worth group
beside your shares in the company (its own type label, "Director's loan"), illiquid. A company names it (`Company.directorLoanAccountId`, companies.json), never
`companyId`, which would make it the company's. It has no rows of its own: its movements are the
payments of yours marked as paid for that company or as a loan with it (`company`, transactions,
below), each the other way round, worked out when needed and never written ([FORMULAS.md §9](FORMULAS.md),
"A director's loan"). Its balances (Record balance: the director's loan figure in the company's filed
accounts) anchor those movements as a statement anchors a bank account. The store refuses a row added
to one (an import, a row typed in), `companyId` on one, `balanceMode: "market"`, a currency other than
pounds, an account with rows of its own becoming one, and one a company names changing type or being
deleted. It takes no document (no account matching, no "Import into"), and covers no days of its own
(coverage). Reading the data warns of rows stored in one (they are left out of its balance), of a
company naming an account that cannot be its director's loan, and of a mark where it does not fit (it
counts for nothing). Adding the type, the mark and the link needed no format change: each is new and
optional.

## transactions/&lt;account&gt;/&lt;yyyy&gt;.jsonl

One JSON object per line, ordered by date (source order within a day, which running balances
depend on).

**Source facts** are exactly what the document said, and never rewritten:

| Field | Notes |
|---|---|
| `id`, `accountId` | |
| `date` | posting date |
| `transactionDate`?, `time`? | when the purchase happened, if different; `HH:MM[:SS]` |
| `transactionTime`? | the time of `transactionDate`, when a document gives it apart from `time` (an app shows when the card was used, the export when it cleared) |
| `amount`, `currency` | signed |
| `description` | verbatim |
| `sourceId`? | the bank's own transaction id (the strongest dedup key) |
| `type`?, `reference`?, `counterpartyName`? | as printed |
| `merchant`? | `{ name, category, mcc, address, city, postcode, country, website, online }` |
| `bankCategory`? | the bank's category, verbatim |
| `cardLast4`? | |
| `balanceAfter`? | running balance printed by the bank |
| `original`?, `exchangeRate`?, `fee`? | foreign amount `{amount, currency}`; FX; fee included in `amount` |
| `pending`? | |
| `raw`? | the source row verbatim (every CSV column, OFX tag or QIF field) |
| `attributes`? | anything else, namespaced keys welcome. A fund trade history's rows keep `units` (signed: units sold are negative), `price` and `fund` |

**Corrections** to what was read (a misread amount or date) keep what was there:

| Field | Notes |
|---|---|
| `corrections` | `[{field: date\|amount\|description, from, to, at, note?}]`, oldest first; the fields above hold the corrected values |

**Enrichment** is recomputable:

| Field | Notes |
|---|---|
| `payee` | clean name |
| `place` | the merchant's address in one tidy line, worked out from `merchant` (`src/shared/places.ts`); the merchant fields keep what the document said |
| `payeeSetBy` | `user` when you set the payee: re-running enrichment keeps it |
| `category` | category id; absent = uncategorised |
| `categorisedBy` | `user` (never overwritten), `rule`, `builtin`, `bank`, `ai`, `transfer`, `agreement` (a payment one of your agreements schedules) |
| `ruleId` | the rule that set it |
| `transferGroup` | shared by both legs of a transfer between your accounts |
| `counterpartyAccountId` | the other account |
| `books` | what the payment means to a company whose books are kept here ("Coding a payment", below): on a company account's own row, or on a row of yours marked as paid for the company (its cost to the company); never on any other |
| `companyLink` | on a company account's row: the rows of yours marked as a loan with that company that are the same money ("Linking money with you", below) |
| `company` | yours: money with a company of yours, `{id, as, setBy}`. `id` names a company (companies.json); `as` is `paid-for` (a cost of the company's you paid, or its refund to you), `loan` (money you lent it, or it paid you back), `pay` or `dividend` (what it paid you); `setBy` is `user`, or `agent` when a proposal you applied set it. Paid-for and loan rows move its director's loan and are not your spending or income ([FORMULAS.md §14](FORMULAS.md)); pay and dividends stay income. Only on a row of an account of yours that moves with its rows (never a company's own account, an account valued at market or a director's loan), never on a row linked as a transfer between your accounts (unlink it first; enrichment never links a marked row), never £0; pay and dividends are money in; paid-for and loan rows are in pounds and not split. Every write is checked, re-working rows out never changes it, and an account cannot change type, valuation (`balanceMode`) or side (`companyId`) while that would break a mark on its rows (refused, naming them). A mark that no longer fits anyway (a hand edit, its company taken away) counts for nothing: its row is an ordinary row of yours everywhere, and Data health lists it. On a company's own row (a hand edit) it is taken away when its rows are worked out |
| `notes` | yours: free text, found by search, never grouped by. Added to many at once on a line of its own, never twice (`src/shared/annotations.ts`) |
| `tags` | yours: short labels to group and filter by (up to 20, each up to 40 characters, one spelling per tag whatever the case). Tag Gift Aided donations `gift-aid` |
| `splits` | yours: `[{amount, category, note?}]`, two or more lines adding up to `amount`, each signed like it, in spending or income categories. Spending, income and budgets count the lines ([FORMULAS.md §14](FORMULAS.md)). A transfer is never split, and correcting the amount so the lines no longer add up removes the split |

**Coding a payment** (`books`): `{ledger?, vat?, covers?, invoicedOn?, asset?, reduces?, lines?, invoiceToCompany?, uncoded?, setBy, ruleId?}`, the
company's chart of accounts and what each code means being [FORMULAS.md §22](FORMULAS.md), "The
general ledger" (`src/shared/ledger.ts`):

- `ledger`: a code a payment can be coded to (`software-hosting`, `turnover`,
  `fixed-assets:computer:cost`…); never one of the company's own accounts (money between them is a
  transfer, linked as one), and on a row of yours paid for the company never `directors-loan` (that
  row moves the loan already).
- `vat`: `{amount, treatment, claim?}`. `treatment` is `standard`, `reduced`, `zero`, `exempt`,
  `outside` (outside the scope: not a supply at all, such as a grant, compensation or a fine), `abroad`
  (supplied outside the UK: outside the scope of UK VAT by its place of supply, such as services sold to
  a business abroad or a hotel abroad; a VAT return counts it in box 6 or 7) or `reverse-charge`;
  `abroad` is additive, and a sale on `turnover` coded `outside` before it existed is read as one
  abroad. `amount` is the VAT in the row's amount, signed like it and smaller than it, `0` for zero
  rate, exempt, outside the scope and supplied outside the UK. For a reverse charge it is the notional VAT on an amount that
  does not include it (a service bought from abroad), posted both ways; never on income. `claim:
  "reg111"`: input tax on a purchase before the company registered for VAT, claimed under VAT
  Regulations 1995 reg 111. VAT goes only on income, expenses and a fixed or intangible asset's cost,
  and never on business entertainment or a car, whose input VAT is blocked (FORMULAS.md §22).
- `covers`: `{from, to}`, the period a cost or income is for (a year's subscription), not ending
  before it starts. On income or an expense the books recognise it over those days (FORMULAS.md §22,
  "Covers"); on any other code it says nothing (a check).
- `invoicedOn`: beside `covers` only, the day the bill or invoice for it was issued: not yet paid at a
  period end it is then a trade creditor (a cost) or debtor (income), not an accrual.
- `asset`: `{class, months?, connected?, disposedOn?, residual?, marketValue?, proceeds?, pool?, used?, allowance?}` on a fixed (or intangible) asset's
  cost only, of that code's class (`computer`, `office`, `furniture`, `van`, `motor` (cars), or
  `intangible` on `intangible-assets:cost`), and only on money going out (a debit): it puts the asset on
  the company's register (FORMULAS.md §22, "The register"). `months`: its life in whole months; absent,
  the company's policy for the class (`books.policies`). `connected` when it was bought from a connected
  person (CAA 2001 ss214–218; never on an intangible). `disposedOn`: the day it was sold, scrapped or
  given away, on or after the day it was bought: depreciation stops (the month it left counted as
  `books.depreciationMonths` says), its cost and depreciation leave the books and the rest goes to
  `disposals`; what it fetched is coded to `disposals` on the row it came in on. `residual`: pounds,
  what it is expected to fetch at the end of its life, not negative and at most its cost; only its cost
  less this is written down.
  For Corporation Tax (FORMULAS.md §22, "Corporation Tax"; none on an intangible asset or a car, each
  refused where it does not fit): `marketValue`, pounds, beside `connected` only, its market value when
  bought, which caps its qualifying expenditure (CAA 2001 s218); `proceeds`, pounds net of VAT, beside
  `disposedOn` only, what it fetched (its disposal value, capped at its cost; absent, what was coded to
  `disposals` in the Corporation Tax period it left in, when it alone left then); `pool`, `main` or
  `special` (special rate expenditure: integral features, long-life assets); `used`, not unused or
  second-hand (no full expensing or 50% allowance); `allowance`, the owner's choice over the default
  order: `aia`, `first-year` (never with `connected`, nor `first-year` with `used`) or `none`
  (writing-down allowances only). A book rule never carries `marketValue` or `proceeds`. Optional and
  additive.
- `reduces`: on money coming in (a credit) to a fixed asset's cost, without `asset`: the id of the
  asset on the register whose cost it reduces (`row:tx_…`, `row:tx_…:1` for a split's line,
  `personal:tx_…`, `journal:jnl_…:<line>`), a supplier's part refund, say. Additive (no format version:
  `intangible`, `disposedOn`, `residual`, `reduces` and `invoicedOn` are new, optional values).
- `lines`: two or more `{ledger, amount, vat?, covers?, invoicedOn?, asset?, reduces?}` adding up to the row's amount (an HMRC
  repayment that is part VAT, part interest), in place of `ledger` and the rest beside it.
- `invoiceToCompany`: on a row of yours paid for the company, that the supply was made to it and its VAT
  invoice is addressed to it, so it may reclaim the VAT (VATA 1994 s24(1), reg 29(2)); VAT claimed
  without it is a check.
- `uncoded: true`, with no ledger, lines or VAT: left uncoded on purpose, by you or a proposal (taking a
  coding away), so book rules leave it; it posts to suspense like any row not coded.
- `setBy`: `user` (you: nothing else changes it), `rule` (a book rule, `ruleId`), `agent` (a proposal
  you applied).

Every write is checked: a coding only where it applies (a company account's row that is not a leg of
a transfer between two of its own accounts, which posts by itself, or a row of yours paid for the
company with a mark that counts), and only one that fits. Re-working rows out takes away one left on a
row it does not apply to (a hand edit, a mark taken away), whoever set it, and never changes yours;
one that applies but does not fit counts for nothing and is listed on the company's Books tab. Changing
a row's mark away from paid for that company takes its coding away in the same write.

**Linking money with you** (`companyLink`): `{rows, setBy, fee?}` on a company account's row, naming the
rows of yours marked as a loan with that company that are the same money (you lent it; it paid you
back). `setBy` is `auto` (the app, worked out again whenever rows are: an exact, unique match within 4
days), `user` (you; no rows says it is linked to none, so the app never links it) or `agent` (a
proposal you applied). One company row naming several rows of yours, or several naming one, is one
link; several and several are not. It fits when the two sides go opposite ways, are at most 31 days
apart, and what arrived is no more than what was sent, short by at most 3% of your side (at least £1,
at most £25): a fee taken on the way, unless you confirmed a larger one on your own link (`fee`, in
pounds, exactly what the two sides differ by). Every company row in it is in pounds. A linked company
row is coded to the director's loan or not at all. The store refuses a link that does not fit; a change to a row that breaks one (a mark taken away,
an amount corrected, a row removed) takes an automatic link with it and is refused for one you or a
proposal made. The link is on the company's row, not yours, so your rows never change because a
company's data is here (DECISIONS 2026-11-26).

Adding `books` and `companyLink` needed no format change: each is new and optional.

**Provenance**: `source{importId, documentId, row}`, `createdAt`, `updatedAt`, and:

| Field | Notes |
|---|---|
| `seenIn`? | other documents that showed this payment and filled in source fields it lacked, oldest first: `[{importId?, documentId?, row?, at, added, said?}]`. `added` names the fields filled in; `said` keeps what that document said where the record says something else (its own `description`, another `time`). The source fields above hold what the first document said, and what later ones filled in only where they were empty ([INGESTION.md](INGESTION.md), "Adding detail to a recorded payment") |

## balances/&lt;account&gt;.jsonl

A balance or valuation at the end of `date`, or at `at` on it when that is known:

| Field | Notes |
|---|---|
| `id`, `accountId`, `date`, `balance`, `currency` | |
| `kind` | `statement` `screenshot` `export` `manual` `feed` (a live feed's reading, recorded: [FORMULAS.md](FORMULAS.md) §9, "Live readings") |
| `dateSource` | `document` `exif` `filename` `file-modified` `upload` `manual` `feed`: how the date was known |
| `availableBalance` | optional |
| `contributions`, `gain`, `cash` | provider-reported total paid in, growth and uninvested cash (optional) |
| `bonusToDate` | LISA government bonus received (optional) |
| `taxYearContributions`, `taxYear` | provider-reported "allowance used this tax year" (optional) |
| `taxYearInterest`, `taxYear` | a student loan's "interest added" in the tax year so far, positive (optional); the gap check counts what it grew by as interest ([FORMULAS.md](FORMULAS.md) §9) |
| `annualIncome` | DB / State Pension forecast (optional) |
| `approximate` | `true` for a rough figure you gave: it stands in only for what is newer than the account's real data (optional) |
| `at` | when on `date` it was seen, when known (optional): a screenshot's capture time, or when you gave a balance for that same day. Without it a statement's, an export's or your own balance is the day's close, and a screenshot's some time that day. Of two on one day, the later stands for it (FORMULAS.md §9) |
| `enteredBy` | `"user"`: you typed or changed this figure yourself, while reviewing an import or by editing it. It weighs as your own balance whatever document it came with (optional) |
| `note`, `attributes`, `source`, `createdAt` | `source.feed` (`trading-212`) for a live feed's reading, which has no document |

A live feed (optional; ARCHITECTURE.md, "Live feeds") records about one reading an hour in market
hours, and the close, as `kind: "feed"` balances with `at`, `cash` and `contributions`, and the
day's holdings snapshot with `source.feed`, committed without review. Every reading, recorded or
not, is kept in the work area (`feeds/<feed>/<yyyy-mm>.jsonl`), never here.

A balance keeps the account's money, not its terms: the credit limit and rates its document gives
are in `terms.jsonl` (since format 7).

## terms.jsonl

An account's terms as one document gives them on its date, one record per account, document and
day:

| Field | Notes |
|---|---|
| `id` | `trm_…`, from the account, the day and the document (your own share one a day) |
| `accountId`, `asOf` | the account, and the day they are given for: a statement's balance date |
| `rates` | every rate it gives, `[{applies, rate, per?, basis?, variable?, until?, balance?, label?}]` |
| `limit` | a card's credit limit, or a current account's arranged overdraft (optional) |
| `minimumPayment`, `paymentDue` | a card's minimum payment, and the day it is due (optional) |
| `source`, `createdAt` | the document (`importId`, `documentId`) |

- `applies`: `interest` (paid to you on what the account holds: a saver's AER, a current account's
  credit interest, an investment account's cash), `purchases`, `cash` and `balance-transfers` (a
  card's), `overdraft`, `loan` (charged on a loan or mortgage), `other`.
- `rate` is the percentage printed (`34.94`): a year's, or a month's with `per: "month"` (a card's
  "2.104% monthly interest rate", never made into a year's). `basis` is how it is stated: `AER`,
  `APR`, `EAR`, `simple` (a card's annual simple rate) or `gross`. `variable` is false for a fixed
  rate.
- `until` is the last day a rate applies when it ends: a promotional rate, a boost, a fixed term.
  `balance` is the amount at that rate when the document gives it. `label` is its name as printed.

A committed import records its accounts' terms whether or not their balances are recorded: the
limit and the one rate every reading gives (an AER is interest paid; a card's rate is its purchase
rate), with every rate in detail when the reading keeps everything. The same terms already given
for the account that day are not recorded again. An agent sets a document's terms in full with
`set_terms`. How they are shown, and which rate projections use: [FORMULAS.md §4](FORMULAS.md),
"Terms".

## holdings/&lt;account&gt;.jsonl

`{ id, accountId, date, holdings: [{ name, isin?, ticker?, sedol?, units?, price?, value, currency, costBasis?, gain?, assetClass?, weight?, attributes? }], cash?, totalValue, source, createdAt }`

One snapshot per account and day. A document showing only part of the holdings (a list split over
screens, one fund's own page) merges into that day's snapshot when committed:

- holdings are matched by ISIN, then ticker, then name (a name cut short matches the one it
  begins);
- the later document's figures win, and figures only the earlier one had (units, amount invested)
  are kept.

A document listing all the holdings replaces the day's snapshot, keeping only the extra figures for
funds it still lists. `totalValue` is the value the document shows, else a value recorded for that
day, else the holdings plus cash.

## figures.jsonl

Standalone figures from documents, used for Self Assessment and the Pay tab:

- `kind` is one of: `interest_paid` `interest_tax_deducted` `dividends_paid` `gross_pay`
  `tax_deducted` `national_insurance` `pension_contribution_employee`
  `pension_contribution_employer` `pension_tax_relief` `student_loan_deducted` `benefit_in_kind`
  `gift_aid_donation` `child_benefit` `self_employment_income` `self_employment_expenses`
  `capital_gain` `capital_loss` `rental_income` `other_income` `earned_pay`
  `pension_income_forecast` `other`.
- Other fields: `label` (as printed), `amount`, `currency`, `taxYear` (`2025/26`), `periodStart`,
  `periodEnd`, `date`, `accountId`, `payer`, `payerReference` (the employer's PAYE reference or a
  company number; never a National Insurance number, which is left out), `taxCode` (a payslip's or
  P60's PAYE code, `1257L M1`), `employmentId` (the job a pay figure, a payslip's pension deduction
  or a timesheet's earned pay is about: its id in `employments.json`), `notes`, `attributes`,
  `source`, `createdAt`.
- Several documents can state one job's figure for a year (a P60, a P45, HMRC's pages, the
  payslips). All are kept; exactly one counts ([FORMULAS.md §11](FORMULAS.md), "One source per
  employer and year").
- `pension_contribution_employee` and `pension_contribution_employer` on an `accountId` with no
  `taxYear` and no `periodStart` are a provider's summary of what was paid in since the start, up
  to `periodEnd` (the day it was downloaded): its "Contributor / Contribution Amount" export. They
  count for no tax year; summed, they are the account's paid in ([FORMULAS.md §12](FORMULAS.md)).
  With a `taxYear`, they are the year's (or the year so far, to `periodEnd`).
- `pension_income_forecast` is a State Pension or defined-benefit pension's forecast income per
  year, as at `date`, on its `accountId`: a forecast has no balance to carry it. It is never
  income for tax.
- `earned_pay` is a timesheet's pay for one period of work, before it is paid. It has no
  `taxYear` and is never income for tax: the payslip that pays it is. It has `work` (`role`,
  `daysWorked`, `holidayDays`, `hoursWorked`, `rate`, `ratePer`: `day` or `hour`) and, when the
  timesheet names another entity than the payslips, `paidBy`: the payroll as its payslips name it.
  For one timesheet (`payer` and `work.role`) and period, the figure committed last counts; an
  earlier one stays as the record of what that upload said ([FORMULAS.md §17](FORMULAS.md)).

## employments.json

Your jobs. One employer's documents name it in several ways: a group's name on the payslips, the
employing company on the P60, a payroll company in the bank. A job holds them all, so its figures
and HMRC's records about it are one employer's.

- `id` (slug), `employer`: the name HMRC and its P60 give it. `aliases`: its other names.
- `payeReference` (`120/AB12345`, office number and reference), `payrollNumbers` (your works or
  payroll numbers there, as its documents and bank references print them).
- `startedOn`, `endedOn`: yours, when you set them. Unset, HMRC's records give them (an employment
  page's dates, the account's "started" and "ended" events).
- `pensionAccountId`: the pension account its payroll's pension deductions go into.
- `payLagMonths`: how many months after the work its payroll pays a timesheet (yours; unset, it is
  learned: [FORMULAS.md §17](FORMULAS.md)).
- `owed`: `[{periodEnd, note?, markedAt}]`, pay periods whose pay has not arrived and that you say
  is owed to you (a context record of pay not received says so too, below). Pay arriving later
  pairs with it.
- `pensionArrangements`: `[{accountId, kind, amount, from, until?, note?, source}]`, what the
  employer set up to pay into a pension account of yours (a SIPP's contribution form, say): `kind`
  `single` or `monthly`, `amount` gross, `from` the form's date. The account's page checks each
  against what arrived ([FORMULAS.md §11](FORMULAS.md), "Pension arrangements").
- `createdBy`: `import` (set up on reviewing a document), `owner` or `migration`. `notes`,
  `createdAt`, `updatedAt`.

An import matches a document's employer to a job by PAYE reference (a payroll number or name
decides between two jobs with one reference), then payroll number, then a name only one job has,
then HMRC's record of a payment with the document's pay and tax to the penny; else it sets up a new
job. You see which, and can change it, before committing ([INGESTION.md](INGESTION.md), "Jobs").
Importing teaches a job a name, reference or payroll number it did not have, and a payslip filed
under it teaches it the payroll number and every name the payslip prints (a group's too: an SAP
paystub that prints both "Halden Systems Ltd" and "Fennick Group Ltd"), so its next payslip is the same job
whichever name a reading takes for the employer. A payroll number is learnt only at 5 to 20
letters and digits: a shorter code is more often a payroll's group code ("Payroll Ref.: Q1")
shared by everyone on it. In the Pay tab you set
a job's pay lag and say which periods' pay is owed; `PUT /api/employments/:id` (you only, not an
agent's token) changes the rest, and what you set wins over what documents taught it.

## hmrc.jsonl

What HMRC's online services hold about you, one record per line, as their pages show it. Each has
`id` (`hmrc_` + a hash of what it says), `type`, `employmentId` (the job it is about, when it is
about one), `accountId` (the State Pension account, for a forecast), `source` (the import) and
`createdAt`. A record about an employer also has `employer` (as the page names it) and
`payeReference` when the page prints one.

| `type` | Fields | From |
|---|---|---|
| `tax-code` | `date` issued, `code` (`1257L`, `BR`, `K475`), `cumulative` (false: week 1/month 1), `taxYear` | Your PAYE account's activity |
| `payment` | `payDate`, `taxablePay`, `tax`, `ni?`, `taxYear`: one pay date as the employer reported it | Taxable income from an employer |
| `employment` | `asOf`, `taxYear`, `payrollNumber?`, `startedOn?`, `endedOn?`, `estimatedPay?` (HMRC's estimate: never income), `leavingPay?`, `code?`, `cumulative?` | Employment details |
| `event` | `date`, `event` (`started`, `ended`, `allowance`, `year-started`, `other`), `text` as worded, `amount?` | Your PAYE account's activity |
| `settlement` | `taxYear`, `asOf`, `outcome` (`underpaid`, `overpaid`, `settled`), `amount?`, `calculatedOn?`, `outstanding` (to pay positive, to be repaid negative), `payments` | Tax you paid (a year's calculation) |
| `ni-year` | `asOf`, `taxYear`, `status` (`full`, `not-full`, `not-available`, `other`), `contributions` (`[{kind, amount?}]`), `voluntaryCost?`, `payBy?`, `text?` | Your National Insurance record |
| `state-pension-forecast` | `asOf`, `weekly`, `monthly?`, `annual`, `payableFrom?` (your State Pension age), `recordTo?`, `qualifyingYears?`, `yearsNeeded?`, `assumesYears?`, `maximum?` | Check your State Pension |

The same record read twice (two printouts of one page, or one page imported twice) has one id and
is stored once. A record is what HMRC said on its `asOf` day: a later page adds new records rather
than changing old ones. National Insurance numbers are never stored.

## companies.json

Companies you hold shares in that are not listed (shares in a listed company are a holding in an
investment account). Each is `{id, name, number?, holdings, valuations, accountId?, employmentId?,
directorLoanAccountId?, books?, notes?, createdBy, createdAt, updatedAt}`:

- `number`: its Companies House number.
- `holdings`: `[{shareClass, shares, totalShares?, certificate?, acquiredOn?, source}]`, your
  shares by class, with the shares of every class it has issued when known.
- `valuations`: `[{asOf, method, netAssets?, value, note?, balanceId?, source}]`. `method` is
  `net-assets` (book value: its net assets × your shares ÷ its shares, never below nothing) or `yours`.
  Each is recorded as a balance of its account (`balanceId`), its note saying how it was worked out
  ([FORMULAS.md §9](FORMULAS.md), "Shares in a company"). For a company whose books are kept here, its
  filing sheet offers one at a period's end from its net assets (K), for one class of share, recorded only
  on your click (`POST /api/companies/:id/accounts/book-value`, `{periodEnd, oneClass: true}`: you confirm
  it has issued your class only), one per day.
- `accountId`: the "other asset" account that carries its value in your estate (yours: never one
  of the company's own accounts). `employmentId`: your job there, when you work for it.
- `directorLoanAccountId`: your director's loan account with it (accounts.json, `director_loan`):
  one of yours, of that type, not its `accountId`, and no other company's. Set or taken away (`null`)
  with `PUT /api/companies/:id`; `POST /api/companies/:id/director-loan` adds the account and links it
  in one request, with a first balance when you give one.

The company's own accounts, when you keep them here, are accounts with its `companyId`
(accounts.json): listed under it on the Accounts page, apart from yours.
- `createdBy`: `owner`, or `agent` when a proposal you applied added it.

An agent proposes a company from its documents (`add_company`); you change one with
`PUT /api/companies/:id`.

### A company's books (`books`)

The records of a company you run, when you keep them here: its dates, registrations and filings, from
which its deadlines are worked out ([FORMULAS.md §22](FORMULAS.md)). They are the company's, never
yours: `GET /api/companies` leaves them out, and only the company's own routes serve them
(`GET /api/companies/:id/books`, `/api/company-books`, `/api/company-alerts`). Optional and additive
(no format version). `{incorporatedOn, accountingReferenceDate?, periods, vat?, paye?,
confirmationStatement?, tradeStartedOn?, ctPeriods, associatedCompanies?, aiaAllocated?, closeInvestmentHolding?, taxBroughtForward?, deadlinesFrom?, ledgerFrom?, policies?, depreciationMonths?, lockedThrough?, filings, employees?, accountsNotes?, setBy, updatedAt}`:

- `incorporatedOn`: the day Companies House incorporated it.
- `accountingReferenceDate`: `"MM-DD"`, its reference date from incorporation. Absent, the default:
  the last day of the month in which the anniversary of incorporation falls (CA 2006 s391(4)). The
  last day of February is `"02-28"` or `"02-29"` and means the 29th in a leap year. A later change
  of reference date is not written here but as the period it shortened or extended (below).
- `periods`: `[{start, end}]`, accounting reference periods other than the worked-out ones (one
  shortened or extended by notice, CA 2006 s392): never over 18 months, in order, not overlapping,
  none before incorporation. The worked-out period before one ends the day before it starts, and
  the next ones run 12 months on from its end.
- `vat`: `{registeredFrom, scheme, schedule, firstPeriodEnd?, deregisteredOn?}`. `scheme` is
  `"cash"` (accrual and flat rate are refused as not supported yet). `schedule` is
  `[{from, stagger}]`, how often it makes returns from a day, in order of date: `monthly`,
  `quarterly-1` (quarters to March, June, September, December), `quarterly-2` (April, July,
  October, January), `quarterly-3` (May, August, November, February) or `annual`; the first applies
  from registration, a later one when HMRC changed it. `firstPeriodEnd`: the end of its first VAT
  period when HMRC set one other than its stagger's. The VAT number is not kept.
- `paye`: `{from, closedOn?}`, its PAYE scheme: a record only (no deadlines are worked out from it).
- `confirmationStatement`: `{nextMadeUpTo}`, the next confirmation statement's made-up date as
  Companies House shows it. Absent, it is worked out from incorporation and the statements filed.
- `withinChargeFrom`: the day it came within the charge to Corporation Tax (it began to carry on
  business, or had a source of income such as interest on its bank account: not only trade, CTA 2009
  s9), when its first Corporation Tax period starts. `null`: dormant for Corporation Tax (no CT600 or
  payment is listed; a notice from HMRC to deliver a return must still be answered, entered as a
  period in `ctPeriods`). Absent: assumed from incorporation, and the company's page says so.
- `tradeStartedOn`: the day it started to trade, which ends a Corporation Tax period there (CTA 2009
  s10(1)(d)); `null` or absent when it has not, or it is not known.
- `ctPeriods`: `[{start, end}]`, Corporation Tax accounting periods other than the worked-out ones
  (HMRC's notice sets them in practice): each 12 months at most, in order, none before
  incorporation.
- For Corporation Tax (FORMULAS.md §22, "Corporation Tax"; optional and additive):
  - `associatedCompanies`: `[{periodEnd, count, secondYear?}]`, the number of associated companies (0 to
    99) in each Corporation Tax period, by its last day, one per period (CTA 2010 s18E): `count` for the
    period (or its first financial year when it runs over 1 April), `secondYear` for its second financial
    year when that differs; a period with none given is taken as none, and labelled so.
  - `aiaAllocated`: `[{periodEnd, amount}]`, pounds, the annual investment allowance allocated to this
    company for a period when it shares one (CAA 2001 ss51B–51N), one per period; absent, the whole limit.
  - `closeInvestmentHolding`: `true` or `false` as the owner decides it (CTA 2010 s18N: `true` charges the
    main rate on all profits); `null` or absent, not said.
  - `loanRelationshipBasis`: `time` (absent: the default), interest shared between the CT periods of a
    period of account by days (CTA 2009 s307(2A)–(2B)); or `accrued`, as accounts drawn up for each CT
    period would recognise it (s307(2C)).
  - `taxBroughtForward`: `{mainPool?, specialPool?, tradingLosses?, nonTradingDeficits?, tradingLossesBefore2017?, nonTradingDeficitsBefore2017?, preTradingExpenditure?}`,
    pounds, each not negative (absent: nil), only with `ledgerFrom`: what the last computation before
    these books carried forward to the first Corporation Tax period they reach; losses and deficits of
    periods beginning before 1 April 2017 apart (relieved only against the trade's profits, CTA 2010 s45,
    and non-trading profits, CTA 2009 s457). Present with nothing in
    it says there is none; absent, the computation asks for it.
- `deadlinesFrom`: deadlines due before this day that no filing here does are not listed (they were
  settled before the books were kept here).
- `ledgerFrom`: the day its general ledger starts (books taken over mid-life): nothing dated before it
  posts but journals marked `opening`. Not before incorporation.
- `policies`: `[{class, months, effectiveFrom?}]`, its depreciation policies: the life in whole months
  (1 to 600) of each class of asset (`computer`, `office`, `furniture`, `van`, `motor`, `intangible`)
  whose own coding gives none, one per class and day. A row with `effectiveFrom` is a change in estimate
  from that day: what is left of each asset's cost is written down over what is left of the new life,
  earlier periods untouched (FORMULAS.md §22, "A change in estimate"). Optional and additive.
- `depreciationMonths`: how months are counted, `acquisition` (absent: the default) a full month when an
  asset is bought and none when it leaves, or `both`, a full month in each.
- `lockedThrough`: the books are locked through this day: no write that changes a posting dated on or
  before it is accepted (FORMULAS.md §22, "Locking"). Set to a period's end when its accounts are recorded
  as filed (never earlier than it was); only the owner moves it (a proposal keeps it).
- `filings`: what the company filed or paid, each `{id, kind, periodStart?, periodEnd, filedOn,
  reference?, note?, figures?, addedBy}`:
  - `kind`: `accounts`, `ct600` (a company tax return), `ct-payment` (Corporation Tax paid;
    `filedOn` is the day it was paid), `vat` (a VAT return) or `confirmation`.
  - `periodEnd`: the balance sheet date, the end of the CT or VAT period, or a confirmation
    statement's made-up date. `periodStart` for a VAT return or CT600 when known.
  - `id`: `fil_` + 12 hex of its company, kind and period's end, set once. There is one filing per
    kind and period's end. It is filed on or after its period ends (a payment may come earlier).
  - `reference`: a submission receipt or payment reference. `addedBy`: `owner`, or `agent` when a
    proposal you applied added it.
  - `figures`, as the document gives them: for `vat`, the nine boxes by the names of HMRC's Making Tax
    Digital API (`vatDueSales`, `vatDueAcquisitions`, `totalVatDue`, `vatReclaimedCurrPeriod`,
    `netVatDue`, `totalValueSalesExVAT`, `totalValuePurchasesExVAT`,
    `totalValueGoodsSuppliedExVAT`, `totalAcquisitionsExVAT`): boxes 1–5 in pounds and pence, box 3
    being boxes 1 and 2 together and box 5 the difference of boxes 3 and 4 (never negative), boxes
    6–9 in whole pounds; for `accounts`, optionally the micro-entity balance sheet lines `A`–`K`
    (Small Companies Regulations 2008, Sch 1 Part 1 Section C, format 1) in whole pounds; for
    `ct600`, `{taxPayable}` (0 says there is nothing to pay, which does the payment too); for
    `ct-payment`, `{amount}`, never negative: `0` records that there is no Corporation Tax to pay for
    the period ("Nothing to pay" on the payment's deadline, or an agent's `add_filing`).
  - On an `accounts` filing, optionally, the approval as filed (CA 2006 ss414(1)–(2), 444(6)):
    `approvedOn`, the day the board approved the accounts (on or after the balance sheet date, not after
    `filedOn`), and `approvedBy`, the director who signed them (at most 120 characters: the only name
    kept, and only here), given together (the store refuses one without the other, on every path); and
    `registeredOffice`, the registered office as the accounts state it (s396(A1); at most 200
    characters, kept only here). The filing sheet's `POST /api/companies/:id/accounts/filed` records all
    three, with lines `A`–`K` as the books give them. Optional and additive.
  - On a `vat` filing, optionally, what was done about errors (VAT Notice 700/45; FORMULAS.md §22,
    "VAT returns"): `corrections`, `[{periodEnd, amount}]`, the errors on earlier returns this return
    corrected (method 1), each the earlier period's last day (before this one's) and the net VAT in
    pounds and pence, signed as HMRC sees it (positive: VAT the company owed, in this return's box 1;
    negative: VAT due to it, in box 4), one per period; and `disclosed`, `{on, amount, reference?}`, this
    return's own errors reported to HMRC separately (method 2), on or after the day it was filed. The
    figures stay as filed. Set with `PUT /api/companies/:id/filings/:filingId/vat-corrections`
    (`{corrections?, disclosed?}`, each `null` to take it away). Optional and additive.
- `employees`: `[{periodEnd, average}]`, the average number of persons employed under contracts of
  service in each accounting period, by its last day (0 to 100,000, at most two decimal places; CA 2006
  s411(1), (3)–(4)): yours to give, one per period, never worked out (FORMULAS.md §22, "Filing the
  accounts"). Optional and additive.
- `accountsNotes`: `[{periodEnd, offBalanceSheet?, commitments?, directors?, advances?, notExcluded?,
  previousQualified?, particulars?}]`, what you confirm for a period's micro-entity accounts before filing them, one
  per period: `offBalanceSheet` (arrangements not on the balance sheet, s410A), `commitments`
  (financial commitments, guarantees and contingencies not on it, SI 2008/409 Sch 1 para 57) and
  `directors` (advances, credits and guarantees for directors that the books do not hold, s413) are
  each `{none: true}` or `{text, amount?}` (text up to 2,000 characters, `amount` its total in pounds,
  not negative); `advances` is `{interest, conditions, writtenOff?, waived?}`, what the books cannot say
  of an advance on the director's loan they hold (s413(3)); `notExcluded`, that none of the exclusions
  from the micro-entity provisions and audit exemption applied (ss384, 384A(8), 384B, 476, 478);
  `previousQualified`, whether it qualified as a micro-entity for the period before, used only while the
  books cannot tell; `particulars`, `{registeredIn, type, notWoundUp: true}`, what the accounts state of
  it that the books do not hold (s396(A1)): `registeredIn` is `england-and-wales`, `wales`, `scotland` or
  `northern-ireland`, `type` `private-limited-by-shares` or `private-limited-by-guarantee`. Optional and
  additive.
- `employees` and `accountsNotes` are kept whoever sets the books up again (your form, an applied
  proposal), as the filings are, and set with `PUT /api/companies/:id/accounts-notes` (`{periodEnd,
  employees?, notes?}`: each `null` takes it away, `notes` is replaced whole); no agent token may use it.
- `setBy`: `owner`, or `agent` when a proposal you applied set them; `updatedAt` changes with every
  change to the books other than a filing, the employees and the notes.

You keep them with `PUT /api/companies/:id/books` (`{books, was, company}`; the filings stay;
`company`, the page's, must be this one) and record or
remove a filing with `POST /api/companies/:id/filings` and `DELETE
/api/companies/:id/filings/:filingId`, and say what was done about a VAT return's errors with `PUT
/api/companies/:id/filings/:filingId/vat-corrections`, what you confirm for a period's accounts with
`PUT /api/companies/:id/accounts-notes`, and record the accounts as filed from the filing sheet with
`POST /api/companies/:id/accounts/filed`. No agent token may use these; an agent proposes
(`set_company_books`, `add_filing`). Every write is built on the company as it is at that moment
(`Store.updateCompany`), so two at once never lose one another. The store refuses a write that adds a
problem to the books; problems already there (a hand edit) do not block one, so they can be put right
a step at a time, and they are listed on the company's page.

Its **general ledger** is not stored: it is worked out from its own accounts' rows and their codings
(transactions, `books`), the rows of yours paid for it or lent to it, the links between them
(`companyLink`), its book rules (rules.json) and its journals (journals.jsonl), and served from
`GET /api/companies/:id/ledger` and `GET /api/companies/:id/coding` ([FORMULAS.md §22](FORMULAS.md),
"The general ledger"). Once the company keeps books here, your director's loan with it moves by the
ledger's postings to the loan (§22, "The director's loan from the books"). Its VAT returns are not
stored either: they are worked out from the ledger and served from `GET /api/companies/:id/vat` (§22,
"VAT returns"); only what was filed is a record. Nor are its Corporation Tax computations and CT600
boxes: worked out from the ledger and its accounts, and served from `GET
/api/companies/:id/corporation-tax` (§22, "Corporation Tax"); the CT600 and the payment filed are
records (`filings`).

## agreements.json

Agreements that set out payments between you and someone: an accommodation offer or tenancy, a
contract, a payment plan, a student finance award. Each is `{id, name, counterparty, names,
category, direction?, accountId?, paidBy?, from, until?, total?, payments, details, agreedOn?,
reference?, statusAsOf?, notes?, source, createdBy, createdAt, updatedAt}`:

- `counterparty`: who you pay, or who pays you. `names`: other names its payments carry in your
  accounts ("UNI OF EXAMPLETON"); with the counterparty's own, how its payments are recognised, as whole
  words.
- `category`: the category its payments take: a spending category for money you pay; for money paid
  to you, a transfer (a loan lending it) or an income category.
- `direction` (optional): `in` for money paid to you (a student finance award's maintenance); absent
  for money you pay.
- `accountId` (optional): the account its payments move through when not your everyday ones: a
  loan that lends you the payments in, or pays the payments out for you. Such payments are known by
  their exact amount within 7 days of their dates.
- `paidBy` (optional): who pays it for you, when you do not ("Student Finance England" paying your
  university). With no `accountId`, none of your payments is one of its.
- `from`, `until`: the period it covers (a let's first and last days). `total`: its total cost, as
  its document gives it.
- `payments`: its schedule, `[{due, amount, label?, status?}]`, each amount what is due (always
  positive). `status` is what its document said: `paid`, `due`, `scheduled`, `awaiting` or
  `cancelled`, as on `statusAsOf`.
- `details`: everything else its document says, as `[{label, value}]` in its own words ("Bedroom
  type": "Standard ensuite"). `agreedOn`: the day it was offered or signed; `reference`: a booking,
  contract or account number.
- `source`: the document it is from. `createdBy`: `owner`, or `agent` when a proposal you applied
  added it.

A payment it schedules takes its category as it comes, ahead of the merchant list
(`categorisedBy: "agreement"`), and its card on the Spending page checks each scheduled payment
against what was paid ([FORMULAS.md §10](FORMULAS.md), "Agreements"). An import records one from a
schedule its document gives (`draft.agreements`, below), or fills in one recorded already; an agent
proposes one from its document (`add_agreement`); you change its name, names, category, end or
notes with `PUT /api/agreements/:id`.

## coverage.json

Stretches of days no document covers that you confirmed nothing is missing from. Each counts as
covered, like a statement's period ([FORMULAS.md §3](FORMULAS.md)). Each is
`{id, accountId, from, to, evidence?, note?, confirmedAt}`:

- `id`: `cov_` and 12 hex digits.
- `from`, `to`: the days, inclusive; never after the day you confirmed it.
- `evidence`: what the balances showed when you confirmed it, `{status, from?, to?, through?,
  difference?, fromOpening?}`. `status` is `adds-up`, `unexplained` or `no-balance`. `from` and `to`
  are the balances either side, and `through` is the last day they speak for. `difference` is what
  the rows between leave unexplained. `fromOpening` says the first is the £0 the account opened
  with.
- `note`: optional, your words: why nothing is missing. Kept trimmed; the Tax year page and Self
  Assessment show it beside days that no balances show are complete.

You confirm or withdraw one in Settings → Data health (`POST /api/coverage/confirmations`,
`DELETE /api/coverage/confirmations/:id`). No agent token can. Withdrawing takes the record out of
the file, and git keeps the history. The file is optional: data from before it has none.

## people.json

People you send money to or get money from ([FORMULAS.md §10](FORMULAS.md), "People"). Each is
`{id, name, names, relation?, usually, createdAt, updatedAt}`:

- `id`: a slug of the name.
- `names`: every other name their payments carry ("A REED", "REED ALEX"), as printed. A name is
  one person's: saving it under someone takes it from anyone else.
- `relation`: `family`, `partner`, `friend` or `other`.
- `usually`: `{in?, out?}`, how money with them usually goes. In: `gift`, `repaid` (paying you
  back) or `own` (your own money). Out: `gift`, `shared` (your share of something) or `own`. It only
  fills in the choice for their next payments: each is still yours to confirm.

You save someone when you confirm their payments on the To categorise page
(`POST /api/categorise/decisions` with `person`), and forget them there
(`DELETE /api/people/:id`); their payments keep the categories you gave them. No agent token can.
The migration to format 9 writes an empty one.

## returns.json

What you told the app for a tax year's Self Assessment return, one record per year (Tax → Self
Assessment prep; FORMULAS.md §20). Optional: a missing file is no answers.

| Field | Type | |
|---|---|---|
| `id` | `"2025-26"` | the tax year as a slug |
| `taxYear` | `"2025/26"` | |
| `entries` | `{ [key]: { value, note?, updatedAt } }` | your answer to a question (`q:gift-aid`: true or false, or a choice such as `q:student-loan`: `not-started`) or your figure for a box (`TR3:2`, `SA102:<job>:2`, `SA106:USA:C`), or `owed:poa-made`; `value` null is a nil you confirmed |
| `updatedAt` | timestamp | |

An entry wins over the records' figure for its box, as a category you set does. Keys are checked
against the year's return when set: only a box or question it has, with a value of its kind.

## earmarks.json

Money set aside inside the accounts you spend from, and what is yours to spend
([FORMULAS.md](FORMULAS.md) §21). Optional: without the file nothing is worked out or shown. It is
written when you set it up or decide a payment on the Set aside page, or apply a proposal that does
(`set_earmarks`, `decide_earmark_flow`). Removing it on the page deletes the file (git keeps it).

| Field | Notes |
|---|---|
| `everyday` | account ids where your money and the pots' mix: current accounts, and the cards paid from them |
| `setAside` | account ids whose money is all set aside (savers) |
| `pots` | `[{id, name, purpose?, start, opening, rules, carried?, checks}]`: `opening` is set aside in the everyday accounts at `start` (negative: the pot owed you); `carried` is what each rule limited to its sources could still pay when it started again from here, by rule id; `checks` are the figures you checked (`{at, setAside, spendable}`) |
| `pots[].rules` | in order, the first that fits decides: `{id, name, effect, text?: {field, op, value, caseSensitive}, direction?, amountMin?, amountMax?, accountIds?, category?, counterpartyAccountId?, portion?: {percent} \| {upTo}, limitTo?: [rule ids], note?}`. At least one condition. `effect` is one of `source`, `use`, `from-pot`, `to-pot`, `topped-up`, `own-back`, `own`. `limitTo` (a `use` only) names rules of the pot adding to it |
| `decisions` | by transaction id: `{pot, parts: [{effect, amount}], reason, seen: {accountId, date, amount}, proposalId?, decidedAt}`. Amounts are positive (the payment's sign applies); what the parts don't cover is your own money. `seen` is the payment when decided: a change to it puts the decision back to check. `proposalId` is the proposal it came from (the decision is still yours) |
| `updatedAt` | when it was last changed: a proposal names it (`was`), so a change made since stops it fitting |

Nothing is written on the transactions themselves. A row with a decision counts as having something
of yours on it: proposals to remove it as a duplicate, misread or internal move leave it to you.

## payslips.jsonl

Payslips in full, one per line: everything a payslip prints except your name and National Insurance
number. Its pay, tax, NI, pension and student loan for the period are also tax figures in
`figures.jsonl` (with its tax code on the pay), which the calculations read; this keeps the rest
([FORMULAS.md §17](FORMULAS.md), "Payslips in full").

| Field | Notes |
|---|---|
| `id` | `pay_` + 16 hex of what identifies it: your payroll number there (else the employer's name, reduced), its pay date, its period and its net pay. The same payslip read twice, or by two readers, is one record |
| `employer`, `otherNames` | the employer as the payslip names it, and any other name it prints (a group company) |
| `employmentId`, `taxYear` | its job, and the tax year of its pay date |
| `payeReference`, `payrollNumber` | when printed |
| `payDate`, `periodStart`, `periodEnd` | the date it prints, and its pay period |
| `periodLabel`, `periodNumber`, `frequency` | the period as printed (`Sep-2026`), its number in the tax year (month 1 is April's), `weekly` `fortnightly` `four-weekly` `monthly` |
| `taxCode`, `cumulative` | as printed without the basis (`1257L`), and `false` for week 1/month 1 |
| `niLetter` | the National Insurance category letter (`A`, `M`); never the number |
| `payMethod`, `department` | when printed |
| `payments`, `deductions` | every line, `{label, amount, quantity?, rate?}`, signed as printed: a line printed with a minus is negative |
| `totals` | `{payments?, deductions?, taxable?, nonTaxable?, net?}` as printed for the period |
| `employerCosts` | `{ni?, pension?}`: what the employer paid on top this period, when printed |
| `yearToDate` | the year-to-date column as printed: `gross`, `taxable`, `tax`, `ni`, `niEmployer`, `niablePay`, `pension`, `pensionEmployer`, `studentLoan`, `ssp`, `smp`, `taxCredit` |
| `source`, `createdAt` | the import it came from |

## imports/&lt;yyyy&gt;/&lt;id&gt;.json

- `document`: `{id, sha256, fileName, mediaType, size, path, capturedOn, capturedOnSource,
  capturedAt?, image?}`.
  - `capturedAt` is when a screenshot was taken, to the second, when its source gives a time
    (same provenance as `capturedOn`).
  - `image` is `{width, height, device?}`: the size in pixels, upright, and the make and model its
    metadata names. With `capturedAt`, it tells which screenshots were taken together.
- `extraction`: `{engine, engineVersion, detail, model, durationMs, costUsd, inference?, waiting?,
  warnings, raw, verification?, alternative?}`.
  - `engine` is the reader: `inference` (the local model service), `claude-cli`, `claude-api`,
    `ocr`, or a reader of this app (`csv`, `ofx`, `qif`, `santander-txt`, `govuk`, `payslip`).
  - `inference` is the local model service's record of the reading kept: `{requestId, alias,
    modelId?, modelSha256?, systemFingerprint?, seed?, thinking?, schemaValid?, queueMs?}`. A local
    reading has no `costUsd`.
  - `waiting` is set while a reading waits for the local model: `{since, reason, until?}`.
  - `raw` is the engine's complete output, kept for audit and re-derivation. A reading that read
    everything (`extract-14`) also has `payslips`, `hmrc`, each account's `terms` and `printed`:
    every other labelled value the document prints, `{section?, label, value}` as printed. Since
    `extract-15` it also has `schedules`: each schedule of payments the document gives, `{provider,
    name, direction (to-you, from-you, to-other), paidTo?, from?, until?, reference?, total?,
    payments [{date, amount, label?, status?}], details}`. Since `extract-17` each account can have
    `listShows`: how much of a screenshot's list of movements is in view, `{newestEnd, oldestEnd,
    from, to}` (each null when not known; the whole of it null on a statement or export).
  - `verification` records how the reading was checked (docs/INGESTION.md, "Checking every
    figure"): `{method: checks|second-reading, firstModel, secondModel?, firstInference?,
    secondInference?, byClaude?, reasons, disagreements, kept: first|second, error?}`. A model is
    Claude's model id, or the local model's alias (`vision-extract, thinking`); `byClaude` says
    Claude read it a third time because both local readings failed a check.
  - `alternative` is the reading that was not kept.
- `draft`: exactly what you reviewed and committed. Since `extract-4` a draft section can carry
  `statedTotals` (`{moneyIn, moneyOut}` printed on the statement) and a row `uncertain` (what the
  reader was unsure of). Both are optional and only used while reviewing. Since `extract-9` a
  draft can carry `nothingToRecord`: what a document the reader understood, but found nothing to
  record in, shows (one sentence). `batchMatch` (`{accountId, importId}`) says a section's account
  came from another screenshot taken and uploaded with it. A section's `readBalance` is the balance
  the draft proposed from the reading (`null`: none); a committed `balance` that differs is one you
  typed (`enteredBy` on the balance).
  A section's `coversFrom` and `coversTo` (optional) are the days a document that does not print
  its period covers: proposed by the draft from the range in an export's file name or from how much
  of a screenshot's list is in view, with why in `coversWhy` (optional: what the draft proposed and
  why, shown while reviewing and kept when you change the dates), or given by you (the range you
  chose for an export). They widen its coverage beyond its first and last rows; they never narrow it.
  A row's `insideAccount` names the Space it moves money to or from, inside the account: left
  unticked, and remembered on the account's `spaces` when committed so.
  A row's `pendingLink` (`{importId, key}`) is a transfer leg you linked to a row of another import
  waiting for review (or of another account in this one). `transferMatchBy: "user"` says you chose
  its `transferMatch`, or that it has none ([INGESTION.md](INGESTION.md), "Linking transfers before
  commit"). Both are optional.
  A draft's `agreements` (optional) are the schedules its document gives, each `{key, include,
  target (new, or existing with its agreementId), record, adds?, explains}`: the agreement as the
  document gives it (laid over the one recorded already), what it adds to that one (`{payments,
  statuses}`), and the recorded payments its payments are (`{index, transactionId, accountId, date,
  amount}`) ([INGESTION.md](INGESTION.md), "Schedules").
- `reopens` (optional): the import that filed this document as adding nothing new, which this one
  opens again.
- `draftEditedAt`: when you last saved changes to a pending draft; such a draft is never redrafted
  by itself.
- `label` (optional, committed imports): the name History shows and searches in place of the file
  name, `{text, provenance, at}`. `text` is 1 to 120 characters. Claude gives it (`provenance.setBy:
  agent`, with the `label-imports` job's model, prompt version and job id), or you do (`owner`),
  and yours is never replaced. `document.fileName` stays what the file was called.
- `readAgain` (optional, committed imports): what later readings of the document added to it, as
  you chose ([INGESTION.md](INGESTION.md), "Reading a stored document again"), `[{at,
  engineVersion, model?, inference?, printed}]`. `printed` is the values it prints, `{section?,
  label, value}` as in `extraction.raw.printed`, that the import did not keep yet. `extraction`
  stays what the import was read with.
- `result`: `{accountIds, accountsCreated, transactionsAdded, transactionsSkipped, balancesAdded, holdingsAdded, figuresAdded, sections}`.
  `sections` maps each draft section to the account it was committed to; with the sections'
  statement periods it gives each account's **coverage** (the days it has data for).
  `nothingNew` (optional) is set when the import was dismissed as adding nothing new: why, in words.
  Only the document and this record were written; the counts are all zero.
  `agreementsAdded` (optional): the agreements it recorded or filled in from its schedules.
  `transactionsRemoved` (optional): copies of payments recorded twice that the import took away
  (`{id, date, amount, description, importId}`, the import that had recorded the copy). A draft
  section offers them as `extraCopies` (`{transactionId, keepId, date, amount, description,
  fromFile?, sameBalance, remove}`) ([INGESTION.md](INGESTION.md), "Recorded twice").
  `transactionsDetailed` (optional): recorded payments the import filled in details on
  (`{id, date, amount, description, added}`). A draft row matched to a recorded payment offers
  them as `adds` (`{include, fields, differs, category?}`: the values to fill in, what the document
  says differently, and the category the payment would change to).

## proposals/&lt;yyyy&gt;/&lt;id&gt;.json

A fix an agent proposed ([AGENTS.md §5](AGENTS.md)) that is no longer waiting. One waiting for you
lives in the work area (`<work>/proposals/`), never here.

- `id` (`prop_<yyyymmdd>_<hhmmss>_<hex4>`), `title`, `summary` (what the agent found), `provenance`
  (as on agent records), `createdAt`, `decidedAt` (when it stopped waiting).
- `status`:
  - `applied`: you applied it.
  - `dismissed`: you said no.
  - `superseded`: already done. Your data came to say all of it first, so it closed by itself and
    changed nothing.
- `changes`: in order, each `{key, kind, why, …}`:
  - `unlink_transfer {transaction}`: both rows of its transfer are left unlinked.
  - `link_transfer {from, to}`: money out and the same money in, linked as a transfer.
  - `set_category {transaction, category}`. On a row the bank, the reader or the app's own
    patterns put in that category already, it confirms it: the category becomes yours.
  - `add_rule {rule: {name?, match, category}}`: a rule (`rules.json`), as one you make in
    Settings → Rules; the payments it decides are categorised by it when applied (`categorisedBy:
    rule`), yours left as they are.
  - `remove_rule {rule}`: one of your rules removed; what it categorised goes back to what the app
    makes of it without it (yours left as they are).
  - `add_category {category: {id, name, kind, parent?}}`: a group (no `parent`) or a category in
    one (`categories.json`).
  - `change_category {category, name?, parent?}`: a category renamed, moved into another group of
    its kind, or made a group (`parent: null`). Its payments, rules and budgets keep it.
  - `set_note {transaction, note}`: what the payment was for, from a document. Applied, it is your
    note; it never replaces one already there.
  - `set_company {transaction, company: {id, as} | null}`: mark a payment of yours as money with a
    company of yours (transactions, `company`), or take a mark away (`null`). Applied, the mark is
    `setBy: "agent"`; a mark you set (`setBy: "user"`) is never changed or taken away by a proposal.
    The mark must fit the row as any mark must; a marked row is never linked as a transfer by
    `link_transfer`.
  - `remove_duplicate {transaction, sameAs}`: a row that repeats rows adding up to it.
  - `remove_wrong_sign {transaction, recordedAs}`: a row a document was read into with the wrong
    sign, whose money rows from another document record the right way round.
  - `remove_internal_move {transaction}`: a move between an account's main balance and one of its
    Spaces, which the balances either side of it add up only without.
  - `set_account_dates {account, openedOn?, closedOn?}` (`null` clears one).
  - `link_accounts {account, continues, from}`: an account carries on from another from a day (a
    product change under one account number), set as its `continues`. The other must have closed
    before that day.
  - `move_balance {balance, to}`: a balance a document was read into the wrong account, moved to
    the account it is of. It keeps its id and everything else, and the terms its reading gave that
    day (`terms.jsonl`) go with it.
  - `add_pension_arrangement {employmentId, arrangement}`: what a job's employer set up to pay into
    a pension of yours, added to the job's `pensionArrangements`.
  - `add_company {company, valuation, account}`: shares you hold in a company, from its documents:
    the company (`companies.json`), a new "other asset" account `{id, name}`, and its valuation
    recorded as that account's balance.
  - `set_return_entry {taxYear, entry, value}`: an answer or a box's figure on a tax year's Self
    Assessment return (`returns.json`), with the reason as its note; never over an entry of yours.
  - `add_agreement {agreement}`: an agreement, from its document (`agreements.json`). The payments
    already recorded that it schedules take its category, except one you, a rule of yours or a
    transfer link categorised.
  - `set_terms {account, asOf, importId, terms}`: an account's terms as one of its documents gives
    them on its date (`{rates, limit?, minimumPayment?, paymentDue?}`), in place of what its reading
    kept for that account and day.
  - `remove_terms {account, asOf, importId}`: the terms one of its documents was read as giving an
    account on a day, taken away because they are another account's (a statement split at a link
    gave the older account the rate it prints for the newer). `before.terms` keeps them.
  - `set_earmarks {setup, was}`: set up money set aside, or change its accounts, pots and rules
    (`earmarks.json`; your decisions and checks stay, and a pot taken away takes its decisions).
    `was` is the setup's `updatedAt` when proposed (null: none), so a change made since stops it
    fitting.
  - `decide_earmark_flow {pot, transaction, parts | null, was}`: what a payment did to a pot (null
    takes a decision away); the change's `why` is kept as the decision's reason. `was` is the
    payment's `decidedAt` when proposed (null: undecided). A proposal may replace a decision of
    yours, and says so.
  - `set_company_books {company, books, was}`: a company's books (companies.json `books`) without
    its filings, which stay. `was` is the books' `updatedAt` when proposed (null: none), so a change
    made since stops it fitting; books you set (`setBy: "owner"`) are never replaced. Applied, they
    are `setBy: "agent"`.
  - `add_filing {company, filing}`: one filing of a company whose books are kept here, without its
    id (given as the store gives it) and `addedBy: "agent"`; never a second for the same kind and
    period's end.
  - `set_books {transaction, books | null}`: code a row in a company's books (transactions, `books`,
    without `setBy`), or take an agent's or a rule's coding away (`null`: left uncoded, `uncoded: true`,
    so book rules leave it); applied, it is `setBy: "agent"`, and a coding you set is never changed.
    Only for a company whose books are kept here, as `link_company` is.
  - `link_company {transaction, rows | null}`: on a company account's row, the rows of yours that are
    the same money (transactions, `companyLink`), or no link (`null`); applied, `setBy: "agent"`, never
    over a link you made.
  - `add_journal {company, journal}`: a journal in a company's books (journals.jsonl, without its id,
    which is the proposal's and the change's, and `createdBy: "agent"`).
  - `remove_journal {journal}`: a journal an agent's proposal wrote, taken away (never one of yours);
    `before.journals` keeps it.
  - `add_rule` with `rule: {name?, match, books}` (and `match.company`) in place of `category`: a book
    rule (rules.json), coding the company's rows it matches when applied.
- `applied`: the keys of the changes you applied. `dismissedReason`: what you said, if anything.
- `before`: `{transactions, accounts, balances?, terms?, categories?, rules?, earmarks?, companies?, journals?}`, the rows, accounts,
  balances, terms, categories, rules, companies and journals the applied changes touched (a rule removed, a
  category changed, a company's books set or a filing added, a journal taken away), as they were before: the audit trail, and a way back. (A rule or category a proposal
  added has no before: the change itself says it.)

## journals.jsonl

A company's journals: the entries in its books that are not payments (shares issued at incorporation,
a month's pay and its PAYE, a dividend declared), one per line. Optional: no file, none. Each is
`{id, companyId, date, memo, lines, evidence?, createdBy, createdAt, updatedAt}`:

- `id`: `jnl_` + 12 hex, set once.
- `companyId`: a company in companies.json whose books are kept here.
- `lines`: two or more `{ledger, amount, vat?, covers?, invoicedOn?, asset?, reduces?}`. **Inside the company's books, debits
  are positive and credits negative**, not signed from your point of view (DECISIONS 2026-11-26):
  a journal is written as an accountant writes one. They add up to nothing, none is £0, each `ledger`
  is a code of the chart or one of the company's own accounts (`bank:<accountId>`, an opening balance),
  never the ledger's own clearing codes (`suspense`, `bank-not-imported`). `vat` is `{treatment, side,
  claim?}`, said outright for the VAT return: `side` is `input` (reclaimed) or `output` (charged), never
  inferred from the ledger, and `claim: "reg111"` a claim of input tax from before registration; a VAT
  line is on `vat` itself, or on income, an expense or an asset's cost. `covers` and `asset` as on a
  coding; a line with `asset` is a debit (its cost), one with `reduces` a credit to a cost code. The books work depreciation out from the register,
  so a line on a depreciation or amortisation code is a check.
- `opening`: an opening balance, which posts even before the books' first day (`books.ledgerFrom`). A
  fixed asset on an opening journal is its carrying amount then, with its remaining life in `months`:
  it is depreciated from the books' first day.
- `memo`: what it is; `evidence`: what shows it (a payroll summary, a board minute).
- `createdBy`: `owner`, or `agent` when a proposal you applied wrote it.

You write, change and take away journals on the company's Books tab
(`POST /api/companies/:id/journals`, `PUT` and `DELETE /api/companies/:id/journals/:jid`); no token may.
The store refuses one that does not fit, and one that would change the books on or before `books.lockedThrough`; one a hand edit left that does not fit is reported and posts
nothing. Adding the file needed no format change.

## goals.json

Something you are saving towards (Projections → Goals). How progress is measured is
[FORMULAS.md §16](FORMULAS.md).

| Field | Type | Notes |
|---|---|---|
| `id`, `name` | slug, string | |
| `kind` | `savings` \| `emergency-fund` \| `home-deposit`? | absent means savings |
| `targetAmount` | money? | the amount to reach (not for an emergency fund) |
| `months` | number? | emergency fund: months of spending |
| `propertyPrice` | money? | home deposit: the home's price, for the LISA price cap |
| `targetDate` | date? | |
| `accountIds` | slug[] | the accounts that fund it |
| `notes`, `createdAt`, `updatedAt` | | |

## budgets.json

A monthly spending budget, yours to set (Spending → Budgets). How it is measured is
[FORMULAS.md §15](FORMULAS.md).

| Field | Type | Notes |
|---|---|---|
| `category` | slug? | A category or group from `categories.json` (a group covers all its categories). Absent: all spending. At most one budget each |
| `monthly` | money | Pounds a month, more than 0. Unspent money does not carry over |
| `notes`, `createdAt`, `updatedAt` | | |

## categories.json, rules.json, csv-profiles.json

- **Category**: `{ id, name, parent?, kind: expense|income|transfer|investment, system?, hidden?, offsetsSpending? }`.
  - Two levels: a group, then categories.
  - `transfer` and `investment` kinds are excluded from spending.
  - `offsetsSpending`: money in under it reduces spending rather than counting as income. It is set
    on `refunds` and `repaid` ("Paid back to you": someone's share of something you paid for).
  - `interest` feeds the savings allowance.
  - `contribution` / `employer-contribution` / `tax-relief` / `government-bonus` feed the ISA and
    pension allowances.
- **Rule**:
  - `match`: `{field: description|payee, op: contains|equals|startsWith|endsWith|regex, value, caseSensitive, accountIds?, amountMin?, amountMax?, direction?, company?}`.
  - `set`: `{category?, payee?, tags?, counterpartyAccountId?, books?}`.
  - `priority` (lower runs first), `enabled`.
  - **A book rule** codes rows in a company's books: `match.company` is `{id, rows}`, the company and
    which rows it reaches (`own`: its own accounts' rows; `paid-for`: your rows paid for it; `both`), and
    `set.books` is `{ledger, vat?: {treatment}, asset?, coversMonths?}` (its VAT amount worked out from
    the rate on each row's day; `coversMonths`: the months a payment covers from its day). It sets nothing
    else of yours, and its `accountIds` are accounts whose rows it reaches. A rule without them never
    touches a company's rows, as before; a book rule never touches your rows but those paid for its
    company, and never a row you or a proposal coded. Book rules live in `rules.json` beside yours but
    are company data: `GET /api/rules` and Settings → Rules list yours only, and the company's Books tab
    keeps its own (`/api/companies/:id/book-rules`).
- **CSV profile**: `headerSignature` (normalised header names), column mapping, `dateOrder`,
  `timeZone?` (`"UTC"`: the date column's date-times are UTC, read as the UK day and time),
  `amountSign`, `filter`, `splitBy`, `negativeWhen`, `positiveWhen`, `skipDescriptions`. Same shape as the built-in bank profiles in
  `src/server/ingest/csv-profiles.ts`.

## Assumptions, research, insights and context

These hold the app's modelling assumptions and what agents and you have added. The rules for
writing them are in [AGENTS.md](AGENTS.md); how they are used is in [FORMULAS.md](FORMULAS.md).

Shared pieces:

- **Provenance** is `{setBy: owner|agent|system, model?, engine?, inference?, promptVersion?,
  jobId?, session?}`. Records you set (`owner`) always win. `engine` is `inference` when the local
  model service produced it, and `inference` its record of the answer (as an import's
  `extraction.inference`).
- **A source** is `{title, url?, publisher?, retrievedOn?, quote?}`: a public page a record rests
  on, with a short quote of the key figure.

### instruments.json

| Field | Notes |
|---|---|
| `id` | slug |
| `name` | as printed or as you gave it |
| `type` | `fund` `etf` `investment_trust` `share` `bond` `gilt` `money_market` `crypto` `other` |
| `isin`, `ticker`, `sedol`, `currency`, `manager` | identifiers, all optional |
| `allocation` | your own `{equity, bond, cash, property, commodity, crypto, other}` fractions summing to 1; beats research |
| `aliases` | other names it appears under on statements |

Holdings are matched to instruments by ISIN, then SEDOL, then ticker, then name or alias.

### assumptions.jsonl

One record per line, **append-only**: a change adds a version, and the file is the history.

| Field | Notes |
|---|---|
| `id` | `asm_` + 16 hex |
| `key` | from the registry in `src/shared/assumptions.ts` (`npm run records -- keys`): `inflation`, `earnings.growth`, `salary.growth`, `contribution.growth`, `spending.growth`, `return.expected`, `return.volatility`, `correlation.assetClasses`, `fee.fund`, `fee.platform`, `fee.platformFixed`, `interest.rate`, `withdrawal.rate`, `statePension.growth`, `property.growth`, `mortgage.rate`, `cashflow.uncertainty` |
| `scope` | `{kind: global}` · `{kind: assetClass, assetClass}` · `{kind: accountType, accountType}` · `{kind: institution, institutionId}` · `{kind: account, accountId}` · `{kind: instrument, instrumentId}`; each key allows some |
| `value`, `range` | rates as decimals; `range` is `{low, high}`, roughly the 10th–90th percentile |
| `asOf` | the date the value reflects |
| `source`, `evidence`, `basedOn` | a short source name, sources, and the research records (`res_…`) it rests on |
| `rationale` | why this value |
| `provenance` | who set it |
| `status` | `active`, or `retired` to withdraw it (e.g. an override you removed) |
| `reviewBy` | when agents should refresh it |
| `createdAt` | |

The value in force for (key, scope, who) is the newest record. Which one applies is
[FORMULAS.md §1](FORMULAS.md).

### research.jsonl

One record per line, **append-only**, content-addressed (the same findings get the same id).

| Field | Notes |
|---|---|
| `id` | `res_` + 16 hex |
| `kind` | `instrument.facts` `instrument.performance` `instrument.prices` `provider.rates` `provider.fees` `market.outlook` `economy.indicator` |
| `subject` | `{instrumentId?, institutionId?, assetClass?, topic?}` |
| `data` | per kind: see `ResearchDataSchemas` in `src/shared/schema.ts` and [AGENTS.md §3](AGENTS.md) |
| `asOf` | the date the facts describe |
| `sources` | at least one |
| `confidence` | `high` `medium` `low` |
| `notes`, `provenance`, `createdAt` | |

### insights.jsonl

| Field | Notes |
|---|---|
| `id` | `inf_` + 16 hex |
| `kind` | `month-review` `habit` `subscription` `opportunity` `risk` `anomaly` `fund` `allowance` `projection` `data-quality` `note` |
| `pages` | where it shows: `overview` `accounts` `transactions` `spending` `projections` `investments` `tax` `import` |
| `subject` | `{accountId?, instrumentId?, category?, taxYear?, month?}` |
| `title`, `body` | |
| `evidence` | what it rests on: `{type: transactions, ids}`, `{type: balance\|holdings\|figure\|research\|assumption\|context\|account\|payslip\|hmrc\|agreement\|company\|employment, id}` or `{type: computed, metric, value?}`, each with an optional `label` |
| `confidence` | |
| `period`, `expiresOn` | optional |
| `provenance` | model, prompt version, job |
| `status` | `active`, `dismissed` (by you) or `superseded` (by a newer run of the same job, or a newer review of the same month) |
| `watch`, `followUp` | a month in review's: up to 3 lines for the next month's review to check, and how the review before's lines turned out (`{watch, outcome: happened\|not-happened\|unclear, note?}`; older reviews say `done` and `open`); optional |
| `keyPoints`, `sections`, `caveats` | a month in review's (since `monthly-review-6`): up to 5 points that mattered (`{text, evidence?}`), its parts in order (`{id: month\|typical\|people\|worth\|coming\|now, heading, body}`, held as text in `body` too), and up to 4 limits no earlier review raised; optional |
| `unchecked`, `proposals` | a month in review's: figures it quotes the app could not find in the month's data, and the ids of the proposals it made; optional |
| `supersedes`, `feedback`, `createdAt` | `feedback` is `{useful, note?, at}` |

### context.jsonl and notes.jsonl

**Context** is facts and plans about you:

| Field | Notes |
|---|---|
| `id` | `ctx_` + 16 hex |
| `kind` | `holding` `plan` `goal` `preference` `income` `household` `property` `fact` |
| `statement` | one plain sentence |
| `detail` | optional `{accountId, institutionId, instrumentId, event, amount, annualAmount, rate, date, from, to, accountIds, attributes}` |
| `status` | `active` `done` `retired` |
| `origin` | `{kind: form}`, `{kind: note, noteId, interpretedBy}`, or `{kind: document, document, interpretedBy}` for a fact read from a document you gave (an email, a letter) that has nothing to import |
| `createdAt`, `updatedAt` | |

A record the app acts on: `kind: income` with `detail.event: "pay_not_received"`, `from`/`to` (the
pay period), `amount` and `attributes.employer` says a job's pay for that period has not arrived.
While it is active, the Pay tab counts that payslip's pay as owed to you ([FORMULAS.md §17](FORMULAS.md)).

**Notes** are what you told the app in your own words:

- Fields: `{id: note_…, text, status, proposals, jobId?, error?, createdAt, updatedAt}`.
- `status` is one of `new` `interpreting` `proposed` `applied` `dismissed` `failed`.
- `proposals` are records suggested from your words, each `{key, type: context|instrument, record,
  explanation, accepted?}`. Nothing is recorded until you accept it.

## receipts.jsonl

A receipt you attached to a transaction (the transaction drawer → Receipts). One record per line.

| Field | Notes |
|---|---|
| `id` | `rct_` + 16 hex, from the transaction and the file: the same file on the same payment is one receipt |
| `transactionId` | the payment it belongs to |
| `document` | as an import's (`{id, sha256, fileName, mediaType, size, path}`). The file is kept under `data/documents/` with your statements and served by id |
| `status` | `attached`, `read`, `failed` (`reading` while it is read) |
| `reading` | only when reading receipts is on: `{model, promptVersion, at, costUsd?, inference?, merchant, date, total, lines: [{description, amount, category}], notes}` (`inference` as an import's, when the local model read it). Lines are signed like the payment, and a category is one of yours or null. It is a proposal: the transaction's `splits` change only when you save them |
| `error`, `createdAt`, `updatedAt` | |

## capture.json

The capture list: what to collect from each provider for a big import. Items are written through
`records.ts` (`npm run records`, type `capture`) with provenance. Writing an item with the same id
replaces it but keeps what you ticked or skipped. It shows on the Import page, and on the Overview
while anything is left.

| Field | Type | Notes |
|---|---|---|
| `id`, `title` | slug, string | |
| `accountId`, `institutionId` | slug? | The account the item is for; needed by `coverage` and `valuation` checks |
| `priority` | `high` \| `normal` \| `low` | `high` shows as "first" |
| `note` | string? | |
| `asks` | array | Each has `id`, `what`, `how?`, `why?`, `check?`, `doneAt?` |
| `skippedAt` | timestamp? | You chose not to collect it |
| `provenance`, `createdAt`, `updatedAt` | | |

`check` ticks an ask off from the data:

- `{type: "coverage", from, to?}`: no day of the period is missing for the account, by the rule
  the Tax year page and Data health use ([FORMULAS.md §3](FORMULAS.md), "Missing days"): its
  statements' periods, the days you confirmed nothing is missing from, and its opening and closing
  dates count. `to` defaults to the end of the month before last, when every statement for those
  days is out.
- `{type: "valuation", since, holdings?}`: a balance that is not approximate, dated on or after
  `since`, plus a holdings snapshot when `holdings` is true.
- `{type: "figures", kinds, taxYear, from?, payer?}`: a tax figure of one of those kinds for that
  year (its `taxYear`, else the year its end or date falls in, except a summary of what was paid
  in since the start, which is no year's); `from` limits it to a P60's (`p60`) or a payslip's
  (`payslip`) figures, and `payer` to one employer's.

An ask without a check is ticked by you (`doneAt`). Agents cannot set `doneAt` or `skippedAt`.

## actions.json

What the months in review asked you to do ([AGENTS.md](AGENTS.md), "monthly-review"). Optional: a
data directory without it has none. Only the review of the latest month writes it, by key; a review
written later for an earlier month never does.

| Field | Type | Notes |
|---|---|---|
| `key` | string | `acct-`, `job-`, `payee-`, `tax-`, `cat-` or `plan-`, then words: `acct-` names an account by id, `job-` a job, `cat-` a category, `tax-` a tax year ("tax-2026-27-isa") |
| `what`, `why` | string | What to do; why it matters, with the figure that shows it |
| `by` | date? | When it must be done by |
| `where` | page? | `overview`, `accounts`, `transactions`, `spending`, `categorise`, `budgets`, `investments`, `projections`, `tax`, `tax-pay`, `tax-self-assessment`, `import`, `assumptions` |
| `kind` | `money` \| `tax` \| `data` | |
| `evidence` | array | As an insight's |
| `months` | `YYYY-MM`[] | The months whose reviews asked it, oldest first |
| `firstMonth`, `lastMonth` | `YYYY-MM` | The first and the latest of them |
| `closed` | `{month, reason}`? | A later review found it no longer applies |
| `decision` | `{status: done \| not-relevant, at, note?}`? | Yours alone; agents cannot set it, and a rerun keeps it |
| `provenance`, `createdAt`, `updatedAt` | | |

A review asking an action again adds its month, and opens it again if a review had closed it; one
you decided it never changes. A rerun of a month first takes back what its earlier run did (its
month, a close it made; an action only that run asked goes, unless you decided it). A review of a
month before one whose review wrote actions writes none. On the page, an action is due soon from 14 days before its date, overdue after it,
and gone 30 days after it; one with no date that no review has asked again for 60 days asks whether
it still matters, and is gone after 90 (`src/shared/actions.ts`).

## Versions

| Version | Change | Migration |
|---|---|---|
| 1 | first format | |
| 2 | Assumptions become data. `profile.assumedRealReturn` is removed: kept as your global `return.expected` override (nominal, at 2% inflation) if you had changed it from 4%. Added `instruments.json`, `assumptions.jsonl`, `research.jsonl`, `insights.jsonl`, `context.jsonl`, `notes.jsonl`, `settings.agents`, and the optional `payeeSetBy`, `corrections` and `result.sections` fields | `from: 1` in `src/server/migrations.ts` |
| 3 | Balances say when on their day they were seen (`at`) and which imported figures you typed (`enteredBy`). Backfilled: your own balances given on their own day take the time you gave them; imported balances take the capture time of their screenshot, or, when the committed figure is not what the reader read, `enteredBy: "user"` and the time you committed it. Draft sections gain `readBalance` | `from: 2` in `src/server/migrations.ts` |
| 4 | A pension forecast with no balance (a State Pension forecast) is kept as a `pension_income_forecast` figure. Backfilled from each committed import whose section had income per year and recorded no balance. National Insurance numbers are taken out of figures (a `payerReference` that is one is removed) and of the readings and drafts kept with imports (replaced by "[NI number]"); bank descriptions keep theirs, as source facts | `from: 3` in `src/server/migrations.ts` |
| 5 | Jobs and HMRC's records. Added `employments.json` and `hmrc.jsonl`, the figures' `employmentId`, and the imports' `draft.jobs`, `draft.hmrc` and `result.hmrcAdded`/`employmentsCreated`/`jobs`. HMRC's pages already imported are read again on this machine into `hmrc.jsonl`; the figures their earlier reading made for what the records now hold (a National Insurance record's amounts, a State Pension forecast) are taken out, and a forecast's record keeps its account. Jobs are set up from the pay figures: figures whose employer names (reduced) or PAYE references meet are one job's, named as its P60 names it. Pay, payslip pension and earned pay figures get their job. `profile.employers` (pay lag) moves to the jobs | `from: 4` in `src/server/migrations.ts` |
| 6 | Payslips in full. Added `payslips.jsonl`, the readings' and drafts' `payslips`, `result.payslipsAdded`, and the `payslip` engine. Payslips already imported, in a layout read on this machine, are read again from their stored PDFs: each is kept in full under its job, its pay figure gets the tax code it prints, and, when every line on it adds up to the totals it prints, a figure its first reading got wrong is put right (its note keeps the old amount) and one it left out is added. Several figures of one kind are left as they are | `from: 5` in `src/server/migrations.ts` |
| 7 | Terms. Added `terms.jsonl`, the readings' and drafts' `terms`, `result.termsAdded`, the `set_terms` proposal and `before.terms`. The credit limit and rate each balance kept move into the account's terms for that day and document (the same terms from two balances of one day kept once); balances no longer have `creditLimit` or `interestRate`. One that cannot be made a terms record stays on its balance, and the migration says which | `from: 6` in `src/server/migrations.ts` |
| 8 | Jobs learn what their payslips print. Each job takes from the payslips stored under it the payroll number and every name they print (a group's as an alias), which payslips filed by format 6 never taught it. No file changes shape | `from: 7` in `src/server/migrations.ts` |
| 9 | Money paid back to you counts against spending, as refunds do. Categories gain `offsetsSpending`, set on `refunds`; a system category "Paid back to you" (`repaid`, income, `offsetsSpending`) is added beside it. Added `people.json` (empty until you save someone) | `from: 8` in `src/server/migrations.ts` |
| 10 | Models per task (DECISIONS 2026-10-04). `settings.extraction.engine`, `model`, `verifyModel` and `effort`, and `settings.agents.model` and `effort`, are removed; `settings.models.tasks` holds a choice per task over the defaults in `src/shared/tasks.ts`, which give import names and notes to the local model service, and since 2026-10-05 documents and receipts too (NS&I's documents by Claude; a choice's `claudeFor` lists such providers). Kept as choices: the Claude API or offline OCR for documents, another reading or checking model or effort (receipts take the reading model's), checking turned off, and an agents' model or effort other than Opus/high for the jobs that stay on Claude. Added the optional `extraction.inference`, `extraction.waiting`, `verification.firstInference`/`secondInference`/`byClaude`, a receipt reading's `inference`, the `inference` engine, and a provenance's `engine` and `inference` | `from: 9` in `src/server/migrations.ts` |
| 11 | A student loan's interest. Balances gain `taxYearInterest` (with `taxYear`), the readings `taxYearInterest` and the drafts' sections `taxYearInterest`. Backfilled for each student loan balance from the reading that recorded it: its printed "Interest added" in a summary of the balance's tax year, else a note that gives it with that year | `from: 10` in `src/server/migrations.ts` |

Data written by a newer version of the app than the one running is read-only until the app is
updated.

## Querying

```bash
# Groceries this tax year
jq -s '[.[] | select(.category=="groceries" and .date>="2026-04-06") | .amount] | add' data/transactions/*/*.jsonl
# DuckDB reads JSONL directly
duckdb -c "select strftime(date::date,'%Y-%m') m, sum(-amount) from read_json('data/transactions/*/*.jsonl') where category='eating-out' group by 1 order by 1"
```
