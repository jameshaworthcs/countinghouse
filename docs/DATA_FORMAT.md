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
| Ids | Accounts, institutions and categories are readable slugs (`monzo-current`). Records have prefixed content hashes assigned once at creation: `tx_`, `bal_`, `hld_`, `fig_` + 16 hex. Imports: `imp_YYYYMMDD_HHMMSS_xxxx`. Documents: `doc_` + first 16 hex of the SHA-256. |
| Unknown fields | Not part of the format. They are reported by `npm run validate`, and a record that fails validation is kept verbatim (quarantined) rather than lost. |
| Versioning | `meta.json → version`. Migrations upgrade files in place (see `src/server/migrations.ts` and "Versions" below). |

## Layout

```
data/
  meta.json            format + version + base currency
  profile.json         you: date of birth, region, salary, retirement age (the tax band is computed)
  settings.json        extraction engine/model, agents (with the background budget), git behaviour, stale threshold, FX rates
  institutions.json    { institutions: [...] }   banks, platforms, providers (+ FSCS group)
  accounts.json        { accounts: [...] }
  categories.json      { categories: [...] }     editable taxonomy (system ones drive calculations)
  rules.json           { rules: [...] }          your categorisation rules
  goals.json           { goals: [...] }
  capture.json         { items: [...] }          what to collect from each provider (the capture list)
  csv-profiles.json    { profiles: [...] }       your saved CSV column mappings
  instruments.json     { instruments: [...] }    funds, ETFs and shares you hold
  assumptions.jsonl    every version of every modelling assumption (append-only)
  research.jsonl       dated, sourced research about funds, providers and the economy (append-only)
  insights.jsonl       Claude's inferences, with evidence and provenance
  context.jsonl        what you have told the app about yourself and your plans
  notes.jsonl          your words, and the records proposed from them
  figures.jsonl        one tax figure per line (P60, interest certificates, …)
  transactions/<account-id>/<yyyy>.jsonl    one transaction per line, by posting date
  balances/<account-id>.jsonl               balance / valuation snapshots
  holdings/<account-id>.jsonl               holdings snapshots
  imports/<yyyy>/<import-id>.json           provenance for every committed import
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
| `balanceMode` | `ledger` \| `market`? | overrides the type default (see ARCHITECTURE.md) |
| `includeInNetWorth` | boolean | the estate value includes it |
| `flexibleIsa`, `interestRate`, `maturesOn`, `pension{employer,method}`, `notes`, `attributes` | optional | |

## transactions/&lt;account&gt;/&lt;yyyy&gt;.jsonl

One JSON object per line, ordered by date (source order within a day, which running balances
depend on).

**Source facts** are exactly what the document said, and never rewritten:

| Field | Notes |
|---|---|
| `id`, `accountId` | |
| `date` | posting date |
| `transactionDate`?, `time`? | when the purchase happened, if different; `HH:MM[:SS]` |
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
| `payeeSetBy` | `user` when you set the payee: re-running enrichment keeps it |
| `category` | category id; absent = uncategorised |
| `categorisedBy` | `user` (never overwritten), `rule`, `builtin`, `bank`, `ai`, `transfer` |
| `ruleId` | the rule that set it |
| `transferGroup` | shared by both legs of a transfer between your accounts |
| `counterpartyAccountId` | the other account |
| `notes`, `tags` | yours; tag Gift Aided donations `gift-aid` |

**Provenance**: `source{importId, documentId, row}`, `createdAt`, `updatedAt`.

## balances/&lt;account&gt;.jsonl

A balance or valuation at the end of `date`:

| Field | Notes |
|---|---|
| `id`, `accountId`, `date`, `balance`, `currency` | |
| `kind` | `statement` `screenshot` `export` `manual` |
| `dateSource` | `document` `exif` `filename` `file-modified` `upload` `manual`: how the date was known |
| `availableBalance`, `creditLimit` | optional |
| `contributions`, `gain`, `cash` | provider-reported total paid in, growth and uninvested cash (optional) |
| `bonusToDate` | LISA government bonus received (optional) |
| `taxYearContributions`, `taxYear` | provider-reported "allowance used this tax year" (optional) |
| `annualIncome` | DB / State Pension forecast (optional) |
| `approximate` | `true` for a rough figure you gave: it stands in only for what is newer than the account's real data (optional) |
| `interestRate`, `note`, `attributes`, `source`, `createdAt` | |

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

Standalone figures from documents, used for Self Assessment:

- `kind` is one of: `interest_paid` `interest_tax_deducted` `dividends_paid` `gross_pay`
  `tax_deducted` `national_insurance` `pension_contribution_employee`
  `pension_contribution_employer` `pension_tax_relief` `student_loan_deducted` `benefit_in_kind`
  `gift_aid_donation` `child_benefit` `self_employment_income` `self_employment_expenses`
  `capital_gain` `capital_loss` `rental_income` `other_income` `other`.
- Other fields: `label` (as printed), `amount`, `currency`, `taxYear` (`2025/26`), `periodStart`,
  `periodEnd`, `date`, `accountId`, `payer`, `payerReference`, `notes`, `attributes`, `source`,
  `createdAt`.

## imports/&lt;yyyy&gt;/&lt;id&gt;.json

- `document`: `{id, sha256, fileName, mediaType, size, path, capturedOn, capturedOnSource,
  capturedAt?, image?}`.
  - `capturedAt` is when a screenshot was taken, to the second, when its source gives a time
    (same provenance as `capturedOn`).
  - `image` is `{width, height, device?}`: the size in pixels, upright, and the make and model its
    metadata names. With `capturedAt`, it tells which screenshots were taken together.
- `extraction`: `{engine, engineVersion, detail, model, durationMs, costUsd, warnings, raw,
  verification?, alternative?}`.
  - `raw` is the engine's complete output, kept for audit and re-derivation.
  - `verification` records how the reading was checked (docs/INGESTION.md, "Checking every
    figure"): `{method: checks|second-reading, firstModel, secondModel?, reasons, disagreements,
    kept: first|second, error?}`.
  - `alternative` is the reading that was not kept.
- `draft`: exactly what you reviewed and committed. Since `extract-4` a draft section can carry
  `statedTotals` (`{moneyIn, moneyOut}` printed on the statement) and a row `uncertain` (what the
  reader was unsure of). Both are optional and only used while reviewing. Since `extract-9` a
  draft can carry `nothingToRecord`: what a document the reader understood, but found nothing to
  record in, shows (one sentence). `batchMatch` (`{accountId, importId}`) says a section's account
  came from another screenshot taken and uploaded with it.
- `draftEditedAt`: when you last saved changes to a pending draft; such a draft is never redrafted
  by itself.
- `result`: `{accountIds, accountsCreated, transactionsAdded, transactionsSkipped, balancesAdded, holdingsAdded, figuresAdded, sections}`.
  `sections` maps each draft section to the account it was committed to; with the sections'
  statement periods it gives each account's **coverage** (the days it has data for).
  `nothingNew` (optional) is set when the import was dismissed as adding nothing new: why, in words.
  Only the document and this record were written; the counts are all zero.

## categories.json, rules.json, csv-profiles.json

- **Category**: `{ id, name, parent?, kind: expense|income|transfer|investment, system?, hidden? }`.
  - Two levels: a group, then categories.
  - `transfer` and `investment` kinds are excluded from spending.
  - `refunds` reduces spending.
  - `interest` feeds the savings allowance.
  - `contribution` / `employer-contribution` / `tax-relief` / `government-bonus` feed the ISA and
    pension allowances.
- **Rule**:
  - `match`: `{field: description|payee, op: contains|equals|startsWith|endsWith|regex, value, caseSensitive, accountIds?, amountMin?, amountMax?, direction?}`.
  - `set`: `{category?, payee?, tags?, counterpartyAccountId?}`.
  - `priority` (lower runs first), `enabled`.
- **CSV profile**: `headerSignature` (normalised header names), column mapping, `dateOrder`,
  `amountSign`, `filter`, `splitBy`, `negativeWhen`. Same shape as the built-in bank profiles in
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

Holdings are matched to instruments by ISIN, then ticker, then name or alias.

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
| `kind` | `instrument.facts` `instrument.performance` `provider.rates` `provider.fees` `market.outlook` `economy.indicator` |
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
| `evidence` | what it rests on: `{type: transactions, ids}`, `{type: balance\|holdings\|figure\|research\|assumption\|context\|account, id}` or `{type: computed, metric, value?}`, each with an optional `label` |
| `confidence` | |
| `period`, `expiresOn` | optional |
| `provenance` | model, prompt version, job |
| `status` | `active`, `dismissed` (by you) or `superseded` (by a newer run of the same job) |
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

**Notes** are what you told the app in your own words:

- Fields: `{id: note_…, text, status, proposals, jobId?, error?, createdAt, updatedAt}`.
- `status` is one of `new` `interpreting` `proposed` `applied` `dismissed` `failed`.
- `proposals` are records suggested from your words, each `{key, type: context|instrument, record,
  explanation, accepted?}`. Nothing is recorded until you accept it.

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

- `{type: "coverage", from, to?}`: the account's imported statements cover the period. `to`
  defaults to 35 days ago. Gaps of up to 4 days are ignored, and the period is clipped to the
  account's opening and closing dates.
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

Data written by a newer version of the app than the one running is read-only until the app is
updated.

## Querying

```bash
# Groceries this tax year
jq -s '[.[] | select(.category=="groceries" and .date>="2026-04-06") | .amount] | add' data/transactions/*/*.jsonl
# DuckDB reads JSONL directly
duckdb -c "select strftime(date::date,'%Y-%m') m, sum(-amount) from read_json('data/transactions/*/*.jsonl') where category='eating-out' group by 1 order by 1"
```
