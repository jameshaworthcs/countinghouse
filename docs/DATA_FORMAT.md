# Data format (v2)

Everything the app knows lives in the data directory (`data/`, or `demo-data/` for the demo) as
plain JSON and JSONL. The Zod schemas in [`src/shared/schema.ts`](../src/shared/schema.ts) are the
source of truth. JSON Schemas generated from them are in [`schemas/`](../schemas/); the JSON files
point at them with `"$schema"` so editors validate as you type.

## Conventions

| | |
|---|---|
| Money | JSON number in **pounds** (major units), at most 2 dp: `-4.5`, `1234.56`. Integer pence internally. |
| Sign | From your point of view. Positive increases net worth (money in, assets); negative decreases it (money out, balances owed). A credit-card purchase is negative; a card balance owed is negative. |
| Dates | `YYYY-MM-DD` calendar dates. Timestamps are ISO 8601 with offset (`2026-09-28T21:08:17+01:00`). |
| Ids | Accounts, institutions, categories and jobs are readable slugs (`monzo-current`). Records have prefixed content hashes assigned once at creation: `tx_`, `bal_`, `hld_`, `fig_` + 16 hex. HMRC's records: `hmrc_` + 16 hex of what the record says, and payslips: `pay_` + 16 hex of what identifies one, so one read twice is stored once. Imports: `imp_YYYYMMDD_HHMMSS_xxxx`. Documents: `doc_` + first 16 hex of the SHA-256. |
| Unknown fields | Not part of the format. They are reported by `npm run validate`, and a record that fails validation is kept verbatim (quarantined) rather than lost. |
| Versioning | `meta.json → version`. Migrations upgrade files in place (see `src/server/migrations.ts` and "Versions" below). |

## Layout

```
data/
  meta.json            format + version + base currency
  profile.json         you: date of birth, region, salary, retirement age (the tax band is computed), and `employers`: how many months after the work a payroll with no job yet pays a timesheet (`[{name, payLagMonths}]`, optional; a job keeps its own)
  settings.json        extraction engine/model (and reading receipts or stored documents again, both off by default), agents (with the background budget, and `labelImports`: Claude names imports, off by default), git behaviour, stale threshold, FX rates
  institutions.json    { institutions: [...] }   banks, platforms, providers (+ FSCS group)
  accounts.json        { accounts: [...] }
  categories.json      { categories: [...] }     editable taxonomy (system ones drive calculations)
  rules.json           { rules: [...] }          your categorisation rules
  goals.json           { goals: [...] }
  budgets.json         { budgets: [...] }            monthly spending budgets
  capture.json         { items: [...] }          what to collect from each provider (the capture list)
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
  companies.json       { companies: [...] }      companies you hold shares in: the holding and its valuations
  agreements.json      { agreements: [...] }     agreements: an offer's, contract's or award's schedule of payments, and what its document says
  coverage.json        { confirmations: [...] }  stretches you confirmed nothing is missing from, which count as covered
  people.json          { people: [...] }         people you send money to or get money from: the names their payments carry, and how money with them usually goes
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
| `type` | enum | `current` `savings` `cash_isa` `stocks_isa` `lisa` `ifisa` `gia` `sipp` `workplace_pension` `personal_pension` `db_pension` `state_pension` `premium_bonds` `crypto` `property` `other_asset` `credit_card` `loan` `mortgage` `student_loan` `other_liability` |
| `institutionId` | slug? | → institutions.json |
| `currency` | ISO 4217 | default `GBP` |
| `status` | `open` \| `closed` | plus optional `openedOn`, `closedOn` |
| `last4` | digits? | last 2–6 digits of the account/card number, never more |
| `aliases` | string[] | other names it appears under in payment descriptions (links transfers) |
| `spaces` | string[]? | Spaces (or pots) inside it whose money its statements count in the balance: moves to and from them are left out of imports ([INGESTION.md](INGESTION.md), "Moves inside an account") |
| `balanceMode` | `ledger` \| `market`? | overrides the type default (see ARCHITECTURE.md) |
| `includeInNetWorth` | boolean | the estate value includes it |
| `flexibleIsa`, `interestRate`, `maturesOn`, `pension{employer,method}`, `notes`, `attributes` | optional | |
| `continues` | `{accountId, from}`? | the account this one carries on from, from that day: a product change under one account number (a fixed rate maturing into easy access). A statement that runs across the day is split between the two ([INGESTION.md](INGESTION.md), "Linked accounts") |

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
| `attributes`? | anything else, namespaced keys welcome |

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
| `notes` | yours: free text, found by search, never grouped by. Added to many at once on a line of its own, never twice (`src/shared/annotations.ts`) |
| `tags` | yours: short labels to group and filter by (up to 20, each up to 40 characters, one spelling per tag whatever the case). Tag Gift Aided donations `gift-aid` |
| `splits` | yours: `[{amount, category, note?}]`, two or more lines adding up to `amount`, each signed like it, in spending or income categories. Spending, income and budgets count the lines ([FORMULAS.md §14](FORMULAS.md)). A transfer is never split, and correcting the amount so the lines no longer add up removes the split |

**Provenance**: `source{importId, documentId, row}`, `createdAt`, `updatedAt`, and:

| Field | Notes |
|---|---|
| `seenIn`? | other documents that showed this payment and filled in source fields it lacked, oldest first: `[{importId?, documentId?, row?, at, added, said?}]`. `added` names the fields filled in; `said` keeps what that document said where the record says something else (its own `description`, another `time`). The source fields above hold what the first document said, and what later ones filled in only where they were empty ([INGESTION.md](INGESTION.md), "Adding detail to a recorded payment") |

## balances/&lt;account&gt;.jsonl

A balance or valuation at the end of `date`, or at `at` on it when that is known:

| Field | Notes |
|---|---|
| `id`, `accountId`, `date`, `balance`, `currency` | |
| `kind` | `statement` `screenshot` `export` `manual` |
| `dateSource` | `document` `exif` `filename` `file-modified` `upload` `manual`: how the date was known |
| `availableBalance` | optional |
| `contributions`, `gain`, `cash` | provider-reported total paid in, growth and uninvested cash (optional) |
| `bonusToDate` | LISA government bonus received (optional) |
| `taxYearContributions`, `taxYear` | provider-reported "allowance used this tax year" (optional) |
| `annualIncome` | DB / State Pension forecast (optional) |
| `approximate` | `true` for a rough figure you gave: it stands in only for what is newer than the account's real data (optional) |
| `at` | when on `date` it was seen, when known (optional): a screenshot's capture time, or when you gave a balance for that same day. Without it a statement's, an export's or your own balance is the day's close, and a screenshot's some time that day. Of two on one day, the later stands for it (FORMULAS.md §9) |
| `enteredBy` | `"user"`: you typed or changed this figure yourself, while reviewing an import or by editing it. It weighs as your own balance whatever document it came with (optional) |
| `note`, `attributes`, `source`, `createdAt` | |

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
notes?, createdBy, createdAt, updatedAt}`:

- `number`: its Companies House number.
- `holdings`: `[{shareClass, shares, totalShares?, certificate?, acquiredOn?, source}]`, your
  shares by class, with the shares of every class it has issued when known.
- `valuations`: `[{asOf, method, netAssets?, value, note?, balanceId?, source}]`. `method` is
  `net-assets` (book value: its net assets × your shares ÷ its shares) or `yours`. Each is recorded
  as a balance of its account (`balanceId`), its note saying how it was worked out
  ([FORMULAS.md §9](FORMULAS.md), "Shares in a company").
- `accountId`: the "other asset" account that carries its value in your estate. `employmentId`:
  your job there, when you work for it.
- `createdBy`: `owner`, or `agent` when a proposal you applied added it.

An agent proposes a company from its documents (`add_company`); you change one with
`PUT /api/companies/:id`.

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
- `extraction`: `{engine, engineVersion, detail, model, durationMs, costUsd, warnings, raw,
  verification?, alternative?}`.
  - `raw` is the engine's complete output, kept for audit and re-derivation. A reading that read
    everything (`extract-14`) also has `payslips`, `hmrc`, each account's `terms` and `printed`:
    every other labelled value the document prints, `{section?, label, value}` as printed. Since
    `extract-15` it also has `schedules`: each schedule of payments the document gives, `{provider,
    name, direction (to-you, from-you, to-other), paidTo?, from?, until?, reference?, total?,
    payments [{date, amount, label?, status?}], details}`.
  - `verification` records how the reading was checked (docs/INGESTION.md, "Checking every
    figure"): `{method: checks|second-reading, firstModel, secondModel?, reasons, disagreements,
    kept: first|second, error?}`.
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
  its period covers, as you gave them while reviewing (the range you chose for an export). They
  widen its coverage beyond its first and last rows; they never narrow it.
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
  - `add_agreement {agreement}`: an agreement, from its document (`agreements.json`). The payments
    already recorded that it schedules take its category, except one you, a rule of yours or a
    transfer link categorised.
  - `set_terms {account, asOf, importId, terms}`: an account's terms as one of its documents gives
    them on its date (`{rates, limit?, minimumPayment?, paymentDue?}`), in place of what its reading
    kept for that account and day.
  - `remove_terms {account, asOf, importId}`: the terms one of its documents was read as giving an
    account on a day, taken away because they are another account's (a statement split at a link
    gave the older account the rate it prints for the newer). `before.terms` keeps them.
- `applied`: the keys of the changes you applied. `dismissedReason`: what you said, if anything.
- `before`: `{transactions, accounts, balances?, terms?, categories?, rules?}`, the rows, accounts,
  balances, terms, categories and rules the applied changes touched (a rule removed, a category
  changed), as they were before: the audit trail, and a way back. (A rule or category a proposal
  added has no before: the change itself says it.)

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
  - `match`: `{field: description|payee, op: contains|equals|startsWith|endsWith|regex, value, caseSensitive, accountIds?, amountMin?, amountMax?, direction?}`.
  - `set`: `{category?, payee?, tags?, counterpartyAccountId?}`.
  - `priority` (lower runs first), `enabled`.
- **CSV profile**: `headerSignature` (normalised header names), column mapping, `dateOrder`,
  `amountSign`, `filter`, `splitBy`, `negativeWhen`, `positiveWhen`. Same shape as the built-in bank profiles in
  `src/server/ingest/csv-profiles.ts`.

## Assumptions, research, insights and context

These hold the app's modelling assumptions and what agents and you have added. The rules for
writing them are in [AGENTS.md](AGENTS.md); how they are used is in [FORMULAS.md](FORMULAS.md).

Shared pieces:

- **Provenance** is `{setBy: owner|agent|system, model?, promptVersion?, jobId?, session?}`.
  Records you set (`owner`) always win.
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
| `reading` | only when reading receipts with Claude is on: `{model, promptVersion, at, costUsd, merchant, date, total, lines: [{description, amount, category}], notes}`. Lines are signed like the payment, and a category is one of yours or null. It is a proposal: the transaction's `splits` change only when you save them |
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
  year; `from` limits it to a P60's (`p60`) or a payslip's (`payslip`) figures, and `payer` to one
  employer's.

An ask without a check is ticked by you (`doneAt`). Agents cannot set `doneAt` or `skippedAt`.

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

Data written by a newer version of the app than the one running is read-only until the app is
updated.

## Querying

```bash
# Groceries this tax year
jq -s '[.[] | select(.category=="groceries" and .date>="2026-04-06") | .amount] | add' data/transactions/*/*.jsonl
# DuckDB reads JSONL directly
duckdb -c "select strftime(date::date,'%Y-%m') m, sum(-amount) from read_json('data/transactions/*/*.jsonl') where category='eating-out' group by 1 order by 1"
```
