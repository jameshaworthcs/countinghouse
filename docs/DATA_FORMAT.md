# Data format (v1)

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
| Versioning | `meta.json → version`. Migrations upgrade files in place (see `src/server/migrations.ts`). |

## Layout

```
data/
  meta.json            format + version + base currency
  profile.json         you: date of birth, tax band, region, salary, retirement age, assumed return
  settings.json        extraction engine/model, git behaviour, stale threshold, FX rates
  institutions.json    { institutions: [...] }   banks, platforms, providers (+ FSCS group)
  accounts.json        { accounts: [...] }
  categories.json      { categories: [...] }     editable taxonomy (system ones drive calculations)
  rules.json           { rules: [...] }          your categorisation rules
  goals.json           { goals: [...] }
  csv-profiles.json    { profiles: [...] }       your saved CSV column mappings
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

**Enrichment** is recomputable:

| Field | Notes |
|---|---|
| `payee` | clean name |
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
| `interestRate`, `note`, `attributes`, `source`, `createdAt` | |

## holdings/&lt;account&gt;.jsonl

`{ id, accountId, date, holdings: [{ name, isin?, ticker?, units?, price?, value, currency, costBasis?, gain?, assetClass?, weight?, attributes? }], cash?, totalValue, source, createdAt }`

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

- `document`: `{id, sha256, fileName, mediaType, size, path, capturedOn, capturedOnSource}`.
- `extraction`: `{engine, engineVersion, detail, model, durationMs, costUsd, warnings, raw}`.
  `raw` is the engine's complete output, kept for audit and re-derivation.
- `draft`: exactly what you reviewed and committed.
- `result`: `{accountIds, accountsCreated, transactionsAdded, transactionsSkipped, balancesAdded, holdingsAdded, figuresAdded}`.

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

## Querying

```bash
# Groceries this tax year
jq -s '[.[] | select(.category=="groceries" and .date>="2026-04-06") | .amount] | add' data/transactions/*/*.jsonl
# DuckDB reads JSONL directly
duckdb -c "select strftime(date::date,'%Y-%m') m, sum(-amount) from read_json('data/transactions/*/*.jsonl') where category='eating-out' group by 1 order by 1"
```
