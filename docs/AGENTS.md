# Agents: the contract

Agents keep the app's knowledge current: they research what the owner holds, set forward-looking
assumptions from evidence, and write insights. This page is the contract any agent follows, whether
it is an in-app job or a Claude Code session working on this repository. The code that enforces
it is `src/server/records.ts` (validation and writing) and `src/server/agents/` (in-app jobs).

## 1. The ground rules

1. **Source facts are never touched.** Transactions, balances, holdings, figures and documents are
   what the owner's documents said. Agents never write them, and inference never changes them.
   When the data looks wrong, an agent proposes a fix and the owner decides (§5).
2. **The owner wins.**
   - A record with `provenance.setBy: "owner"` beats any agent record for the same thing, at any
     scope ([FORMULAS.md §1](FORMULAS.md)).
   - Agents never write owner records, never retire them, and never "correct" them.
   - If evidence contradicts an owner's value, say so in an insight and leave the value alone.
3. **Computed is not inferred.**
   - Agents do not recompute figures the app computes (estate value, balances, cash flow,
     allowances); they read them.
   - An insight is an interpretation, with evidence, confidence and provenance.
4. **Privacy boundary.**
   - Research sends only public, non-personal queries: fund names, ISINs, provider product pages.
     No balances, transactions or personal details ever go into one.
   - Work that reads the owner's data does not use the web.
5. **Everything goes through the validated write path:** the same Zod schemas as the rest of the
   data, plus checks for keys, scopes, bounds and references. Nothing is written by hand into
   `data/`.

## 2. Reading the data

| What | Where |
|---|---|
| The format, field by field | [DATA_FORMAT.md](DATA_FORMAT.md) |
| How every figure is computed | [FORMULAS.md](FORMULAS.md) |
| Assumption keys, units, scopes, fallbacks | `npm run records -- keys` (or `src/shared/assumptions.ts`) |
| What exists and what is stale | `npm run records -- status` |
| Assumptions (append-only history) | `data/assumptions.jsonl` |
| Funds and other instruments | `data/instruments.json` |
| Research (append-only) | `data/research.jsonl` |
| Insights | `data/insights.jsonl` |
| What the owner has told the app | `data/context.jsonl` (records), `data/notes.jsonl` (their words and proposals) |
| The capture list (what to collect from each provider) | `data/capture.json` |
| Accounts, transactions, balances, holdings | `data/accounts.json`, `data/transactions/`, `data/balances/`, `data/holdings/` |
| Tax figures (P60s, payslips, certificates) | `data/figures.jsonl`, `GET /figures` |
| Jobs: each employer once, with its names, PAYE reference and payroll numbers | `data/employments.json`, `GET /employments` |
| What HMRC's pages say (tax codes, payments, settlements, NI years, the State Pension forecast) | `data/hmrc.jsonl`, `GET /hmrc` |
| Payslips in full (every line, the totals, the codes, the year to date) | `data/payslips.jsonl`, `GET /payslips?taxYear=2026/27` |
| Companies you hold shares in, their valuations and dividends | `data/companies.json`, `GET /companies` |
| Agreements to pay (an offer's or contract's schedule), each checked against the payments | `data/agreements.json`, `GET /agreements` |
| Each account's terms (rates, limit, a card's minimum payment) as each document gives them | `data/terms.jsonl`, `GET /accounts/:id/terms` |
| A tax year's figures by job, each with the source that counts and the others | `GET /tax-documents?taxYear=2025/26` |

In-app analysis jobs do not read `data/`. They read a **digest**: the app's own computed figures,
with the ids of the records behind them (`src/server/agents/digest.ts`). A Claude Code session may
read `data/` directly, but should quote computed figures from the app rather than recompute them.

The digest holds:
- the estate, accounts, coverage, months, the focus period's spending and income, regular payments,
  allowances, investments and the projection;
- what the documents say beyond transactions, as the app has checked it:
  - `pay`: each pay period of the tax year from the three months before the focus period to its
    end, with its payslip, the payment into the bank matched to it, what HMRC says the employer
    reported, and the tax code check; and `owedPay`;
  - `hmrc`: tax codes of this tax year and the last, settlements, events of the last year, the
    National Insurance years that are not full, and the latest State Pension forecast;
  - `terms`: each open account's rates, limit and minimum payment, and the rates ending within 60
    days;
  - `agreements` with their payments due around the focus period, `pensionArrangements` with their
    collections, and `companies` with their valuations and dividends;
  - `budgets` and `goals`, when there are any;
- the owner's context and the earlier insights.

It leaves out identifiers the analysis does not need: PAYE references, payroll numbers and account
numbers.

The digest, Ask's tools and every figure in them are the owner's own: a company's own accounts
(`Account.companyId`) and their rows are never in them (ARCHITECTURE.md, "Company accounts"). An
import's part for a company's account is left out of the digest's imports, and an import of a
company's accounts alone starts no `insights-after-import` job. A payment of the owner's marked as
money with their company (`company`: paid for it or a loan, which are not spending or income; pay or
a dividend, which are) carries its mark in the month in review's `transactions.jsonl` (`company`,
`companyAs`) and in Ask's search rows; the digest's companies give the director's loan's balance on
the day (`directorLoan`).

**The live app's API** is open to an agent that holds a token the owner made (SELF_HOSTING.md, "Agent
access"): `npm run -s api -- GET /imports`.
- It is how an agent does upkeep on imports waiting for review. It can read a document again, draft
  it again, choose its account, edit its draft or link its transfers.
- It can also write records (`POST /records`, the same batches as below), propose fixes
  (`POST /proposals`, §5) and start jobs, but only if the token has those scopes.
- Committing, dismissing and discarding stay with the owner, and so do applying and dismissing a
  proposed fix.
- Never sign in any other way: never forge a session from the server's secret, and never edit the
  work area's files behind the app's back.

## 3. Researching

Only for public subjects: a fund (name, ISIN, ticker), a provider (name, the kinds of account held
there), an asset class, or an economic indicator.

- **Prefer primary sources:**
  - the fund manager's factsheet and KID/KIID;
  - the provider's own rates and charges pages;
  - the Bank of England, ONS, OBR and gov.uk;
  - the publisher's own capital market assumptions.
- **Every record cites its sources:** a URL, a title, the publisher, and a short verbatim quote of
  the key figure.
- **Report only what a source states.** Use `null` for anything not found. Never fill gaps from
  memory.
- **Units:**
  - rates are decimal fractions (0.22% → `0.0022`);
  - returns over more than a year are annualised;
  - money is in pounds;
  - dates are `YYYY-MM-DD`;
  - `asOf` is the date the facts describe (the factsheet date), not the day you read it.
- **Past and future stay apart.**
  - Historical performance is an `instrument.performance` research record.
  - Past prices are an `instrument.prices` research record: public prices by a fund's or ETF's
    identifiers only, never a balance or a number of units.
  - A forward-looking return is an assumption with `basedOn` pointing at the research
    (`market.outlook`, `economy.indicator`) it rests on, and a `rationale` explaining the link.

Research record kinds (`ResearchDataSchemas` in `src/shared/schema.ts`):

| Kind | Subject | Holds |
|---|---|---|
| `instrument.facts` | instrumentId | OCF, transaction costs, allocation by class, regions, benchmark, launch date, distribution, risk indicator, fund size |
| `instrument.performance` | instrumentId | annualised returns (1, 3, 5, 10 years, since launch), benchmark returns, calendar years, volatility, maximum drawdown |
| `instrument.prices` | instrumentId | published prices on past days (closing prices, or a fund's daily price) in pounds, with the listing they are quoted on and the share class when another stands in: what values a holding between its valuations (FORMULAS.md §9) |
| `provider.rates` | institutionId | savings products: AER, variable, bonus and end date, conditions |
| `provider.fees` | institutionId | platform fee tiers, cap, flat fee, which account types |
| `market.outlook` | assetClass | a publisher's long-run expected return (nominal or real), range, volatility, horizon |
| `economy.indicator` | topic | CPI, earnings, Bank Rate, house prices, gilt yield: latest, forecast or target |

Research is content-addressed: writing identical findings again is skipped. Newer research does
not delete older; the newest is used, and the history stays.

## 4. Writing records

Write a **batch**:

```json
{
  "provenance": { "setBy": "agent", "model": "claude-opus-5-5", "promptVersion": "manual", "session": "claude-code" },
  "supersede": false,
  "records": [
    { "type": "instrument", "record": { "id": "vanguard-lifestrategy-80", "name": "Vanguard LifeStrategy 80% Equity Fund Acc", "isin": "GB00B4PQW151", "aliases": [] } },
    { "type": "research", "record": { "kind": "instrument.facts", "subject": { "instrumentId": "vanguard-lifestrategy-80" }, "asOf": "2026-08-31",
      "sources": [{ "title": "Factsheet", "url": "https://…", "publisher": "Vanguard", "quote": "Ongoing charges 0.20%" }],
      "confidence": "high", "data": { "ocf": 0.002, "allocation": { "equity": 0.8, "bond": 0.2 } } } },
    { "type": "assumption", "record": { "key": "return.expected", "scope": { "kind": "assetClass", "assetClass": "equity" },
      "value": 0.062, "range": { "low": 0.04, "high": 0.085 }, "asOf": "2026-09-29", "source": "Vanguard, BlackRock 10-year outlooks",
      "evidence": [{ "title": "…", "url": "https://…" }], "basedOn": [], "rationale": "…", "reviewBy": "2027-03-29", "status": "active" } }
  ]
}
```

- **Check, then write:** `npm run records -- check batch.json`, then
  `npm run records -- write batch.json`.
  - The write goes through the app (`POST /api/records` with your agent token, which needs the
    *Agent records* scope), so the audit log records which token, and which Claude Code session,
    wrote it. The app commits it to git.
  - Only when the app cannot be reached, or there is no token, does it write the files itself and
    commit them, saying so; the audit log then sees the change as made outside the app. With
    `FINANCE_DATA_DIR` set (the demo, a copy) it writes there itself, unless `FINANCE_API_URL`
    names an app serving that directory.
  - In a Claude Code session, the batch's `provenance.session` becomes
    `claude-code:<CLAUDE_CODE_SESSION_ID>`, unless the batch names a session of its own.
- **In-app jobs** call the same `applyRecords`. So does `POST /api/records`, which accepts agents'
  batches only.
- **The app assigns** ids, `createdAt` and the stored provenance.
- **Provenance:**
  - `setBy` is `agent` for anything an agent produced;
  - `model` or `session` is required;
  - in-app jobs add `jobId` and `promptVersion`.
- **A batch is all or nothing:** one invalid record rejects it, with every problem listed. Checks:
  - unknown keys, scopes a key does not allow, values outside a key's bounds, ranges that do not
    contain the value;
  - references to accounts, institutions, instruments or research that do not exist;
  - evidence ids that do not exist;
  - an agent's assumption without `evidence` or `basedOn`;
  - research without a sourced URL;
  - a capture item whose asks check an account's data without naming the account, or repeat an
    ask id.
- **Capture items** (`"type": "capture"`, format in [DATA_FORMAT.md](DATA_FORMAT.md)) are keyed by
  id. Writing one again replaces it but keeps the owner's ticks and skips; agents cannot tick or
  skip.
- **Assumptions are append-only.** To change a value, write a new record for the same key and
  scope; the history keeps every version. Set `reviewBy` so the app knows when it goes stale
  (about six months for market assumptions).
- **Instruments:**
  - A record with an existing `id` updates it; aliases are merged.
  - Fill identity blanks (ISIN, ticker, type, manager).
  - Never overwrite what the owner set, including `allocation`.
- **Insights:**
  - `evidence` must cite records that exist: transaction ids, account ids, research, assumption
    or context ids, payslips (`pay_…`), HMRC's records (`hmrc_…`), agreements, companies or jobs
    (`employment`). A `computed` metric must be named as the digest names it.
  - Choose the `pages` it belongs on and an `expiresOn`.
  - With `"supersede": true`, a batch's insights replace the writer's earlier active insights with
    the same kind and subject (a rerun of a job).
- **Context** from the owner's words is never written directly.
  - The `interpret-note` job stores **proposals** on the note; the owner accepts or edits them.
  - Agents read context; they do not change it.

## 5. Proposing fixes

When the data itself looks wrong (a transfer linked to the wrong account, money recorded twice, an
account's dates), an agent does not change it. It **proposes a fix**, and the owner applies or
dismisses it on the Import page, under "Proposed fixes", change by change. The code is
`src/server/proposals.ts`.

- **Only the owner's data.** A change that names a company's own account, one of its rows or
  balances (`Account.companyId`), is refused as a problem: a proposal changes only the owner's data.
  The exceptions are the changes to a company's books, which are about its rows by design:
  `set_company_books`, `add_filing`, `set_books`, `link_company`, `add_journal`, `remove_journal` and
  `add_rule` with `books`.
- **How.** `POST /api/proposals` with a token that has the `records` scope (`npm run -s api --
  POST /proposals @proposal.json`), or, in an in-app job, `ctx.proposals.create(input, provenance)`
  from the job's `apply`, with the provenance it is given. Both are checked the same way.
  `"dryRun": true` checks a proposal and returns how it would look, without keeping it.

  ```json
  {
    "title": "Re-link the October moves between the current account and the saver",
    "summary": "What the data shows, in a few sentences.",
    "provenance": { "model": "claude-opus-5-5", "session": "claude-code" },
    "changes": [
      { "kind": "unlink_transfer", "transaction": "tx_…", "why": "…" },
      { "kind": "link_transfer", "from": "tx_… (money out)", "to": "tx_… (money in)", "why": "…" },
      { "kind": "set_category", "transaction": "tx_…", "category": "takeaway", "why": "…" },
      { "kind": "add_rule", "rule": { "match": { "field": "description", "op": "contains", "value": "Example Cafe", "direction": "out" }, "category": "coffee" }, "why": "…" },
      { "kind": "remove_rule", "rule": "rule_…", "why": "…" },
      { "kind": "add_category", "category": { "id": "example-group", "name": "Example group", "kind": "expense" }, "why": "…" },
      { "kind": "change_category", "category": "example-category", "name": "New name", "parent": "example-group", "why": "…" },
      { "kind": "set_note", "transaction": "tx_…", "note": "Room 4, Example Court: instalment 1 of 3", "why": "…" },
      { "kind": "set_company", "transaction": "tx_…", "company": { "id": "example-ltd", "as": "paid-for" }, "why": "…" },
      { "kind": "remove_duplicate", "transaction": "tx_…", "sameAs": ["tx_…", "tx_…"], "why": "…" },
      { "kind": "remove_wrong_sign", "transaction": "tx_…", "recordedAs": ["tx_…"], "why": "…" },
      { "kind": "remove_internal_move", "transaction": "tx_…", "why": "…" },
      { "kind": "set_account_dates", "account": "example-fixed", "closedOn": "2026-02-01", "why": "…" },
      { "kind": "link_accounts", "account": "example-easy-access", "continues": "example-fixed", "from": "2026-02-02", "why": "…" },
      { "kind": "move_balance", "balance": "bal_…", "to": "example-easy-access", "why": "…" },
      { "kind": "add_pension_arrangement", "employmentId": "example-job", "arrangement": { "accountId": "example-sipp", "kind": "monthly", "amount": 250, "from": "2024-11-14" }, "why": "…" },
      { "kind": "add_company", "company": { "id": "example-ltd", "name": "Example Ltd", "number": "01234567", "holdings": [{ "shareClass": "A ordinary", "shares": 4, "totalShares": 120, "certificate": "12" }] }, "valuation": { "asOf": "2025-12-31", "method": "net-assets", "netAssets": 100000, "value": 3333.33, "note": "…" }, "account": { "id": "example-ltd-shares", "name": "Example Ltd shares" }, "why": "…" },
      { "kind": "add_agreement", "agreement": { "id": "example-hall-2025-26", "name": "Example Hall room, 2025/26", "counterparty": "Example University", "names": ["EXAMPLE UNI"], "category": "rent", "from": "2025-09-13", "until": "2026-06-20", "total": 6720, "payments": [{ "due": "2025-10-31", "amount": 2240, "label": "Instalment 1" }], "details": [{ "label": "Let length", "value": "40 weeks" }], "source": { "importId": "imp_…" } }, "why": "…" },
      { "kind": "set_terms", "account": "example-card", "asOf": "2026-08-14", "importId": "imp_…", "terms": { "limit": 3000, "rates": [{ "applies": "purchases", "rate": 0, "until": "2027-03-31", "balance": 87.4, "label": "Promotional purchases" }, { "applies": "purchases", "rate": 24.9, "basis": "simple", "variable": true }], "minimumPayment": 5, "paymentDue": "2026-09-08" }, "why": "…" },
      { "kind": "remove_terms", "account": "example-fixed", "asOf": "2025-01-31", "importId": "imp_…", "why": "…" },
      { "kind": "set_return_entry", "taxYear": "2025/26", "entry": "SA102:job-example-job:6", "value": false, "why": "…" },
      { "kind": "set_earmarks", "setup": { "everyday": ["example-current", "example-card"], "setAside": ["example-saver"], "pots": [{ "id": "tax-to-pay", "name": "Tax to pay", "start": "2026-04-06", "opening": 0, "rules": [{ "id": "marking", "name": "Marking pay", "effect": "source", "text": { "value": "EXAMPLE MARKING LTD" }, "direction": "in", "portion": { "percent": 30 } }, { "id": "hmrc", "name": "Self Assessment", "effect": "use", "text": { "value": "HMRC SELF ASSESSMENT" }, "direction": "out" }] }] }, "was": null, "why": "…" },
      { "kind": "decide_earmark_flow", "pot": "tax-to-pay", "transaction": "tx_…", "parts": [{ "effect": "topped-up", "amount": 200 }], "was": null, "why": "…" },
      { "kind": "set_company_books", "company": "example-ltd", "books": { "incorporatedOn": "2024-03-15", "accountingReferenceDate": "12-31", "periods": [], "ctPeriods": [], "vat": { "registeredFrom": "2025-01-01", "scheme": "cash", "schedule": [{ "from": "2025-01-01", "stagger": "quarterly-1" }] } }, "was": null, "why": "…" },
      { "kind": "add_filing", "company": "example-ltd", "filing": { "kind": "confirmation", "periodEnd": "2025-03-14", "filedOn": "2025-03-20" }, "why": "…" },
      { "kind": "set_books", "transaction": "tx_…", "books": { "ledger": "software-hosting", "vat": { "amount": -4.17, "treatment": "standard" } }, "why": "…" },
      { "kind": "link_company", "transaction": "tx_… (the company's row)", "rows": ["tx_… (yours)"], "why": "…" },
      { "kind": "add_journal", "company": "example-ltd", "journal": { "date": "2025-06-30", "memo": "June payroll: tax and NI taken from pay", "lines": [{ "ledger": "directors-salaries", "amount": 92.4 }, { "ledger": "paye", "amount": -92.4 }], "evidence": "Payroll summary" }, "why": "…" },
      { "kind": "remove_journal", "journal": "jnl_…", "why": "…" },
      { "kind": "add_rule", "rule": { "match": { "field": "description", "op": "contains", "value": "EXAMPLE HOSTING", "company": { "id": "example-ltd", "rows": "own" } }, "books": { "ledger": "software-hosting", "vat": { "treatment": "standard" } } }, "why": "…" }
    ]
  }
  ```

- **Grounded in the data.** Every change names the rows or account it is about. Its `why` says
  what in the data shows it: the words or account number in a description, the same amount a day
  apart, the document a row came from. The owner sees those rows, and their documents, beside each
  change.
- **Checked when made, when shown and when applied.** The changes run in order on a copy of the
  data, so an unlink comes before the link that needs it.
  - A link joins money out with the same amount in, in two different accounts, at most 10 days
    apart, neither linked already.
  - A duplicate's `sameAs` rows are in its account, at most 10 days from it, and add up to it.
  - A row read with the wrong sign (`remove_wrong_sign`) came from a document. Its `recordedAs`
    rows are in its account, came from another document, are at most 10 days from it, and add up
    to it with its sign turned over. A category or payee the owner gave the misread row goes with it
    (the rows recorded the right way round keep theirs); anything else of theirs on it stops it.
  - A move inside an account (`remove_internal_move`: to or from a Space its statements count in
    the balance) came from a document and is not linked. Once every change of the proposal has
    run, the strongest balances either side of it (a statement's, a running balance or the
    owner's own; not a screenshot's) must add up without it. The same category or payee rule as a
    misread row applies.
  - A balance moved to another account (`move_balance`) was read from a document, and the owner
    did not give or change it. Once every change has run, it must not belong where it is: that
    account was not open that day, or the strong balances either side of it there do not add up
    with it. Where it goes, the account is open that day, has a strong balance on at least one
    side, and they add up with it (and any balance of that day agrees).
  - A pension arrangement (`add_pension_arrangement`) is for a job and a pension account you pay
    into (not a State or defined-benefit pension), does not start in the future, and is not there
    already.
  - Set aside (`set_earmarks`, [FORMULAS.md](FORMULAS.md) §21) names your accounts in pounds,
    categories you have and patterns that work, and no pot starts in the future. Its `was` is the
    setup's `updatedAt` from `GET /api/earmarks` (null when there is none): a setup the owner
    changed since does not fit. Keep the rules few and ordered: the first that fits decides.
  - A payment decided (`decide_earmark_flow`) is in an everyday account, on or after its pot's start;
    its parts suit its direction (money out can't be borrowed from the pot) and add up to no more
    than it. Its `why` is kept as the decision's reason, so write it for the owner. Its `was` is the
    payment's `decidedAt` (null: undecided). The owner's own routes for set aside
    (`/api/earmarks/decisions`, `preview`, `checks`, `restart`, `setup`, `setup/preview`,
    `suggest`, and removing it) are closed to tokens. A proposal may
    replace a decision the owner made: the
    page marks it "Replaces your decision", and the owner applies it or not. Propose only what the
    evidence settles (a reference, a matching amount, the owner's words); leave the rest on the
    page's "To check" list.
  - A return answer (`set_return_entry`) is a question or an editable box the year's return has, as
    the changes before it leave the return (a director's Yes opens the close company boxes), with a
    value of its kind; a box that needs a figure takes no nil. One the owner set already is theirs:
    the same value is already so, another does not fit.
  - A company's books (`set_company_books`, DATA_FORMAT.md, companies.json `books`) are for a
    company in the owner's data: its dates, registrations and period overrides from its documents
    (the certificate of incorporation, a VAT registration certificate, Companies House's page,
    HMRC's notice of its accounting periods), without filings, which stay as they are, as do the
    average employees and accounts notes the owner confirmed (the owner's alone to set). They pass the
    same checks as the owner's own (no accounting period over 18 months, no Corporation Tax period
    over 12, in order, only the cash VAT scheme). `withinChargeFrom` is the day it came within the
    charge to Corporation Tax (business or income, interest included), not the day it started to
    trade; give it only when a document shows it, `null` only when it is dormant for Corporation Tax.
    Its `was` is the books' `updatedAt` from
    `GET /api/companies/:id/books` (null when there are none): books changed since do not fit, and
    books the owner set (`setBy: "owner"`) are never replaced; the same books again are already so.
    No VAT number is proposed: none is kept.
  - A filing (`add_filing`) is for a company whose books are kept here (set them up earlier in the
    same proposal if need be), filed on a day that is not in the future and not before its period
    ends. There is one per kind and period's end: the same filing again is already so, another for
    that period does not fit. Its `why` names the document it is from (the filing history, a
    submission receipt, a payment confirmation). A VAT return's `corrections` (errors on earlier
    returns it corrected) and `disclosed` (its own errors reported separately) are proposed only from a
    document that says so. Accounts' `approvedOn` and `approvedBy` (and `registeredOffice`) are given
    only as the filed accounts print them, the day and the director together, the day on or after the
    balance sheet date and not after the filing. The owner's own routes for the books
    (`PUT /api/companies/:id/books`, `POST` and `DELETE /api/companies/:id/filings`) are closed to
    tokens.
  - A coding (`set_books`, DATA_FORMAT.md transactions `books`; FORMULAS.md §22) is on a row of a
    company's books: one of its own accounts' rows (not a leg of a transfer between them), or a row of
    the owner's marked as paid for it. Its ledger is one of the chart's a payment can be coded to (never
    the director's loan on a row paid for the company), its VAT signed like the row and smaller, none
    for zero rate, exempt, outside the scope (`outside`: not a supply) and supplied outside the UK
    (`abroad`: outside the scope by its place of supply), and a reverse charge's the notional VAT on
    what was paid; lines add up to the row; a fixed asset only on that class's cost. A coding the owner set is
    never changed (`books: null` takes only an agent's or a rule's away, and leaves the row uncoded so
    book rules leave it); the same coding is already so. VAT only on income, expenses and an asset's
    cost, never on entertaining or a car (blocked input tax), a reverse charge never on a sale; on a row
    of the owner's, `invoiceToCompany: true` only when the invoice is addressed to the company. Both
    `set_books` and `link_company` are only for a company whose books are kept here.
    A company row linked to the owner's loans is the director's loan and takes no other coding. Code
    from the invoice or receipt (its VAT as printed), never from a guess at a rate.
  - A link (`link_company`, transactions `companyLink`) is set on a company account's row and names the
    owner's rows marked as a loan with that company that are the same money: opposite ways, at most 31
    days apart, what arrived no more than what was sent and short by at most 3% of the owner's side
    (at least £1, at most £25), one row on one side. Never over a link the owner made; `rows: null`
    takes an agent's or the app's away. The app links exact, unique matches within 4 days by itself:
    propose the rest (a fee taken on the way, several card payments settled as one receipt), with the
    rows' words and amounts in the `why`.
  - A journal (`add_journal`, journals.jsonl) is for a company whose books are kept here, dated no
    later than today, its lines on codes of the chart (or the company's own accounts), never the books'
    clearing codes, debits positive and credits negative, adding up to nothing; a VAT line says its side
    (`input` or `output`) and a reg 111 claim (`claim: "reg111"`) outright; the same journal there
    already is already so. Its `evidence` names the document (a payroll summary, a board minute).
    Taking one away (`remove_journal`) is only for an agent's journal; the owner's is theirs.
  - A book rule (`add_rule` with `rule.books` and `rule.match.company`) codes a company's rows: its own
    (`rows: own`), the owner's rows paid for it (`paid-for`) or both; it sets no category, and its
    accounts are those whose rows it reaches. It never codes a row the owner or a proposal coded, or a
    linked one. The proposal shows the rows it codes now. Propose one for a supplier that comes again
    and is always one thing.
  - A company added (`add_company`) is new: no company with its id or number, and no account with
    the id its account would take. Its valuation is not in the future. A book value's `why` names
    the documents its figures come from (the share certificate, the accounts, the confirmation
    statement that gives the shares in issue).
  - An account linked (`link_accounts`) carries on from another of the owner's accounts that closed
    before the day given, and opened (if its opening is known) no later than that day. Its `why`
    names what shows the product change: the same account number, the day the older one matured.
  - An agreement added (`add_agreement`) is new (none with its id, unless it has the same schedule:
    then it is there already), takes a spending category (money paid to the owner, `direction:
    "in"`: a transfer or income category), and does not end before it starts. Its
    schedule, total and `details` are its document's own words and figures; its `names` are only
    the names its payments carry in the owner's accounts. The proposal shows the payments already
    recorded that it would file under its category: not one the owner, a rule of theirs or a
    transfer link categorised.
  - Terms set (`set_terms`) come from one of the owner's committed imports (`importId`), for a day
    that is not in the future, and give at least a rate, a limit or a minimum payment. They replace
    what that document's reading kept for the account and day, which the proposal shows; the same
    terms again are there already. Each rate is as printed: what it applies to, the rate, how it is
    stated, whether it is variable, when it ends and the amount at it. Never a rate worked out from
    others (a standard rate from a boosted one less its boost).
  - Terms taken away (`remove_terms`) are the ones a committed import (`importId`) was read as
    giving the account on that day, still there; gone already, there is nothing to do. Its `why`
    says whose they are instead: a statement split at a link gave the older account the rate it
    prints for the newer one as at its end. The proposal shows them, and `before.terms` keeps them.
  - A category exists, and a row linked as a transfer keeps a transfer category. A category that
    is not a transfer one, on a row not linked as one, also takes away the account of yours the row
    named as the other side, and works its payee out again when that was one of your accounts'
    names (unless the owner set the payee). A row the bank, the reader or the app's own patterns
    put in that category already is **confirmed**: it becomes the owner's. One the owner, a rule of
    theirs, an agreement or a transfer link put there is already so.
  - A rule made (`add_rule`) is one the owner could make in Settings → Rules: words to find in the
    description (or the payee), with an optional direction, amount range and accounts, and the
    category it sets. The category exists, and no enabled rule of the owner's has the same match (the
    same category: already so; another: the owner's wins, so it does not fit). The proposal shows the
    payments it categorises now, newest first, the guesses already in its category that it settles
    (they become the rule's), and how many of the owner's own categories it matches but leaves. Applied, it is added to the owner's rules (priority 100), and the payments it decides
    are categorised by it now (`categorisedBy: rule`), as making a rule does; the next ones are as
    they come. A rule's words match however a bank spaces them (FORMULAS.md §10). Propose one only
    for a payee that comes again and is always one thing, with its `why` naming the payments that
    show it; a one-off takes `set_category`.
  - A rule removed (`remove_rule`) is one of the owner's (gone already: already so). The proposal
    shows the rule and the payments it categorised that change without it, with what each becomes:
    what the app makes of it without the rule (its merchant patterns, the bank's category, another
    rule). The owner's own categories stay. Propose one when a rule does harm (it catches payments
    that are something else) or is a duplicate, naming the payments that show it.
  - A category added (`add_category`) has a new id (a slug) and a name no other category in its
    group, or no other group, has. Without `parent` it is a group, of its `kind`; with one, a
    category in that group, which is a group (not a category in another) of the same kind.
  - A category changed (`change_category`) is renamed (`name`), moved into another group of its
    kind (`parent`), or made a group of its own (`parent: null`). A group with categories in it
    stays a group. Its payments, rules and budgets keep it: only its name or its place changes.
    Changes run in order, so a group added first can take a category moved next, and a later
    change can use either.
  - A mark of money with a company (`set_company`, DATA_FORMAT.md transactions `company`) names a
    company in companies.json and fits the row as any mark must: a row of the owner's on an account
    that moves with its rows, not linked as a transfer between their accounts, not £0; `pay` and
    `dividend` only on money in; `paid-for` and `loan` only in pounds and on a row not split.
    `company: null` takes a mark away. A mark the owner set is never changed or taken away (an
    agent's own may be); the same mark is already so. Applied, it is the agent's (`setBy: agent`),
    and the owner can change it. A marked row is never linked as a transfer (`link_transfer` does not
    fit). Propose `paid-for` for a cost of the company's paid from the owner's own account or card
    (its words name a supplier the company uses, a receipt or invoice in the company's name), and
    `loan` for money between the owner and the company's own account that is neither pay nor a
    dividend; its `why` names what shows it. Never from a guess: a payment that could be the owner's
    own spending is theirs to mark.
  - The owner wins: a category the owner set is not changed, a note already on a row is not
    replaced (`set_note` adds one only where there is none), a mark of theirs is not changed
    (`set_company`), and a duplicate with something of theirs on it (a category, payee, note, tag,
    split, correction, receipt, set-aside decision, a mark of money with their company or details
    another document filled in) is not removed. One exception the owner chose: a set-aside
    decision may be replaced by a proposal, which says so (`decide_earmark_flow`).
  - Dates are in order and not in the future.
  - A proposal with a change that does not fit, or that the data already says, is refused (422,
    with each problem). One that stops fitting later is shown with the problem, and applying it
    needs that change left out.
- **One proposal, one decision.** Group the changes that stand or fall together (the legs of one set
  of moves) and keep unrelated fixes apart. The owner can leave any change out; the rest are checked
  again.
- **What the owner decided** is in `GET /api/proposals` (`decided`) and `data/proposals/`:
  - `applied`: they applied it (`applied` lists the changes they kept).
  - `dismissed`: a no. The same changes cannot be proposed again. Read the reason
    (`GET /api/proposals/:id`) before proposing anything like it.
  - `superseded`: already done. The data came to say all of it before the owner decided (an import
    or an edit got there first), so it closed by itself and changed nothing. It says nothing about
    what the owner thinks: if the data changes back, propose it again.
- **Not again.** The same changes cannot be proposed while they wait, or after the owner dismissed
  them. A proposal whose changes undo each other is refused too.
- **Applying** goes through the store's own writes under one commit message. The proposal is kept
  in `data/proposals/`, with the rows, accounts, categories and rules it changed as they were before. A
  category it sets counts as the owner's (`categorisedBy: user`); a rule it makes is the owner's
  rule from then on. Another proposal that this leaves with nothing to
  do closes as already done, in a commit of its own.
- **Only the owner decides.** No token can apply, dismiss or close a proposal. An agent can withdraw
  its own while it waits (`DELETE /api/proposals/:id`); one the data has caught up with needs no
  withdrawing, as it closes by itself.

## 6. Resolving conflicts

| Situation | What to do |
|---|---|
| Your research disagrees with earlier research | Write the new research (it is dated); the newest is used. Note the disagreement in `notes`. |
| Evidence contradicts an owner override | Leave the override. Write an insight on the relevant page citing the research. |
| Sources disagree with each other | Prefer the most recent primary source; record the others in `notes`; widen the range. |
| An assumption is stale (`reviewBy` passed) | Research again and append a new version; do not edit the old one. |
| A fund's identity is ambiguous (share classes) | Record what the holding's ISIN says; if there is none, say so and use `confidence: "low"`. |
| An insight would repeat an earlier one | Skip it unless something changed; the digest lists earlier insights and the owner's feedback. |

## 7. In-app jobs

Each job runs on the engine Settings → Models gives its task (`src/shared/tasks.ts`; ARCHITECTURE.md,
"Models per task"; `agents/run-model.ts`), with the same check-and-retry (`check`, `recheck`) on
either engine. Naming imports and understanding notes run on the local model service by default: the prompt holds everything the job sees (they have no tools anyway), and
nothing leaves the machine. Research needs the web and the month in review and insights read with
tools, so they run on Claude. A job kind declares its privacy class as before; one that reads the
owner's data may run locally, and one that needs the web only on Claude.

On Claude, jobs run through the logged-in `claude` CLI (`src/server/agents/claude.ts`), locked down
like extraction:

- an empty scratch directory is the working directory;
- `--restricted`: file tools are confined to it and code-running tools removed;
- `--safe-mode`, no session persistence, no MCP servers;
- output is constrained by a JSON Schema and parsed again with Zod.

| Job | Reads | Tools | Writes | Starts by itself |
|---|---|---|---|---|
| `research-instrument` | public identifiers of one fund | WebSearch, WebFetch | instrument identity blanks, `instrument.facts`, `instrument.performance`, a fund insight | only when you ask (or with "Research by itself" on: when a fund is new; when research is stale, ≤ 3 a day) |
| `research-provider` | a provider's name and the kinds of account held there | WebSearch, WebFetch | `provider.rates`, `provider.fees` | only when you ask (or with "Research by itself" on: when a provider is new or stale) |
| `refresh-assumptions` | the asset classes held (no amounts) | WebSearch, WebFetch | `economy.indicator`, `market.outlook`, assumptions with `basedOn` | only when you ask (or with "Research by itself" on: when assumptions are on fallbacks or past review, at most weekly) |
| `insights-after-import` | the digest, focused on the new imports | Read (the digest only) | insights | 2 minutes after imports stop arriving |
| `monthly-review` | the month digest (version 7): the month's figures and what its title rests on, the 12 months to it, the year's payees, trips, cards and trends, every review before, documents as of the month's end, and, for the latest month only, today's figures, the alerts shown and earlier reviews' actions; and a file of the 24 months' payments to the month's end | Read, Grep, Glob (its scratch directory only) | a month in review (a title saying how it went, key points, parts, new limits) with lines to watch and how the last ones turned out; proposals to fix data it found wrong; for the latest month, up to 3 actions (actions.json) and up to 3 notes for other pages; replacing every note an earlier review of the month wrote | once a month's data is complete for every account; earlier months only when you ask |
| `interpret-note` | the owner's note, account and instrument names | none | proposals on the note | when a note is added |
| `label-imports` | each committed import's file name, kind, provider, accounts (name, type, period) and dates, a payslip's employer, the tax figures' kinds and years; never amounts, account numbers, references or rows | none | a name on each import (`label`) that has none | only with "Name imports with the agent" on (off by default): a minute after imports stop being committed or filed; History offers the ones from before |
| receipt reading (not a job; `receipt-2`) | one receipt file, the payment's amount, date and payee, the category names | Read (the receipt only) on Claude; none locally (the receipt goes in as images) | a reading on the receipt: proposed split lines | when a receipt is attached, only with "Read receipts" on (off by default); on the local model (the default), it reads in the background |
| category suggestions (not a job; `suggest-categories-1`, local model only) | one payment description at a time that nothing else placed: its words, direction, amount, date and account type, and the category names | none | one proposal of `set_category` changes, each with its reason | only when you press *Suggest categories* (To categorise) |
| set-aside suggestions (not a job; `suggest-earmarks-1`, local model only) | one of Set aside's payments to check at a time: its words, amount, date and account, why the app asks and what it counts meanwhile, the pot's rules in words, and the owner's decisions for payments like it and latest decisions, with their reasons | none | one proposal of `decide_earmark_flow` changes (high and medium confidence only), each with its reason; never one for a payment the owner decided, one already proposed, or one whose suggestion the owner dismissed | only when you press *Suggest decisions* (Set aside → To check), and only with `agents.earmarkSuggest` on (Settings → Set aside; off by default) |
| a question (not a job; `ask-4`) | your question, the accounts, categories, the last 13 months' totals and recent trips, then what the app's tools return for each call it makes (your payments too) | the app's read-only tools (`find_transactions`, `spending_by`, `compare`, `trips`, `month`, `balances`, `coverage`, `sum`, and `set_aside` when something is set aside), run by the app; no web, no files | an answer in a conversation kept 90 days in the work area, shown as an inference with its figures marked computed where the app found them in a tool's result, never a record. Answers marked wrong are the evaluation set a new prompt version must pass (`npm run ask:eval`) | when you ask (Ask), on the model you pick: the local model by default |

Other behaviour:

- **Settings → Agents** turns off automatic starts, insights after imports and the monthly review;
  **Settings → Models** picks each job's engine, model, and effort or thinking.
- **The local model costs nothing:** a job it ran has no `costUsd` and does not count against the
  background budget. Its records keep `provenance.engine: "inference"` and the service's own record
  (`provenance.inference`).
- **Insights after imports** (`insights-after-import-6`) are told where schedules of payments are
  (`digest.agreements`, with each one's direction): money in that one pays you is borrowing or that
  agreement's payment, not income.
- **A Lifetime ISA's bonus in a digest** (`taxYear.lisa`, both jobs): `bonusEarned` (what the
  year's payments earn), `bonusReceived` (what has arrived for them, wherever dated) and
  `bonusStillDue` (the rest; FORMULAS.md §11, "LISA bonus"). The analyst's prompt says only the last
  is still to come.
- **Holdings create instruments.** Funds listed on statements become instrument records
  (`setBy: system`, identifiers exactly as printed), so research can follow. They are recorded at
  each commit that records holdings and when the app starts, whether or not agents are on: a fact
  from the statement, not agent work. Researching them waits for agents.
- **Job state** lives in the work area, not `data/`. Assumptions & research → Agent jobs shows
  what is due, queued, running and finished, with rerun and cancel.
- **Every run is an agent session** with its full transcript: the system prompt and prompt the job
  sent, each turn, tool call and tool result, and the output. Its page lists what it wrote,
  proposed or named, and its rows in the audit log (*Agent sessions*, linked from each job;
  ARCHITECTURE.md, "Agent sessions"). An agent outside the app, with a token, is seen there by its
  requests. A job that ends with nothing to do (`NothingToDo`) never runs Claude, so it has no
  session.
- **No repeats.** A job that succeeded for the same subject within the research staleness window
  (Settings → Agents, 90 days by default) is not started again by itself, even if it found nothing;
  a failed one waits a day. The owner can rerun either at any time.
- **Naming imports has its own switch.** Settings → Agents → "Name imports with the agent" is off by
  default, and while it is off no one can start `label-imports`, you included. On, it starts by
  itself without "Let agents start jobs by themselves" (within the background budget), and Import →
  History offers to name the imports from before, up to 40 a job. An unnamed import's own page
  offers to name that one alone (the same job, with its `importIds`). History and an import's page
  show the name, with the file name beside it; you can rename an import or take its name away
  there (`PUT /api/imports/:id/label`, which no token can reach).
  - **An import is named once.** A run never replaces a name, Claude's or yours; to have Claude name
    one again, take its name away. A run keeps names only for the imports it showed Claude, each
    given as a short ref (1, 2, 3…) rather than its id. A run that finds every import it was asked
    about named already (one queued after a commit, when History's button got there first) ends
    without calling Claude.
  - **History's button follows its run.** While a run you started waits or runs, it says so and
    starts nothing. Asking for a job that is already queued or running, by `POST /api/jobs` with the
    same kind and params, returns that job with `existing: true` (200) rather than a new one (201).
- **Research runs when you ask.** Fund, provider and assumption research (`research-instrument`,
  `research-provider`, `refresh-assumptions`) never starts by itself unless Settings → Agents →
  "Research by itself" is on (off by default). Assumptions & research → Agent jobs lists what is due,
  with Run now. Insights after imports and the month in review still start by themselves.
- **Background budget.** Jobs the app starts by itself (insights after imports, the month in review,
  and research when allowed) start only while their spend today and this month is under Settings →
  Agents → background budget ($5 a day and $40 a month by default).
  The rest stay queued, marked "Waiting for budget", and start when the day or month turns over.
  - A job that ended without reporting its cost (failed, timed out, cancelled while running)
    counts at its kind's typical cost below.
  - Jobs you start yourself are never held back and do not count.
  - New funds are all queued at once but researched one at a time within the budget; stale
    research is also capped at three a day.
- **Cost.** Measured with Opus at high effort, at API prices (on a Claude plan this is usage, not a
  bill; choose a smaller model or lower effort in Settings → Agents):

  | Job | Time | Cost |
  |---|---|---|
  | `refresh-assumptions` | 7–8 min, about 60 turns | $7.50–9.75 |
  | `research-instrument` (one fund) | 4.6 min | $1.56 |
  | `research-provider` (one provider) | 47 s | $0.66 |
  | `insights-after-import` | 25 s | $0.17 |
  | `monthly-review` | 46–73 s (`monthly-review-5`) | $0.28–0.39 |
  | `interpret-note` | 15 s | $0.07 |
  | `label-imports` | 2 s (one import) to 16 s (twelve) | $0.007 to $0.08 |
- **The month in review** (`monthly-review-8`; FORMULAS.md §18; the Overview's month card and the Reviews page). Written to be read once a month, often on a phone: about 300 words, whole pounds, people by the names you saved, none of the app's own words, and the title saying how the month went and whether that is a problem.
  - **Its digest** (`buildMonthDigest`, version 7):
    - `focus` is the month's figures exactly as the Overview's month card shows them (`GET /api/month/:month`): where the money went, adding up, spending by category group and category against typical with each of the 12 months, the worth split and cash cover; with the month's payments to cite, each with the person it was with (by the name you saved them by).
    - `verdictInputs`: what the title rests on, computed: spending against its median and range (and how many months typical rests on), left over, borrowing, the change in worth and its split, cash cover.
    - `focus.quality` says what is still yours to confirm (payments with people, cash and cheques paid in) and how much rests on a category the bank or the reader guessed (each payment's `categorisedBy` says which).
    - `history` is the 12 months up to and including it, each as its lines; the complete ones are what "typical" means.
    - `payeesYear`: the 40 payees spent with most over the 12 months, with how often, in how many months and this month's part. `trips`: spending filed as holidays in runs with gaps of up to 6 days, across months. `spendingTrends`: categories whose last 3 months moved from the 9 before (FORMULAS.md §10's signals). `cards`: each credit card's year: interest charged, months with interest, months with payments, so a card paid in full is not watched. `people`: the people you saved.
    - `previousReview` is the latest review of an earlier month (never one replaced), its key points and parts in full (a review older than parts, its body), with its watch lines, follow-ups, status, your feedback and the titles of that run's other notes. `earlierReviews` is every one before that, in short: title, key points, the limits it raised, its watch lines and how each turned out, your feedback. A limit an earlier review raised is not raised again; a watch line that did not happen twice becomes a judgement, not another watch line.
    - The documents (pay, HMRC's records, terms, agreements, pension arrangements, companies) stand as at the month's end: records dated later are left out, a job that started later is not there, and pay or an agreement payment that arrived later was "not paid by then".
    - `transactions.jsonl` beside it: every row on every account in the 24 months to the month's end, one a line, for the review to search with Grep (what else went to a payee, a person, an amount) before it rests a finding on it.
  - **Two modes:**
    - **Latest** (the last complete month, "Write this month's review"): the digest adds `asOfToday` (the estate, accounts, allowances, investments, projection, pay owed, goals and tax codes since the month, labelled as today's; `alertsShown`, what the Overview's alerts already say; `selfAssessment`, the two years before as the app works them out and as you told it), `actions` (what earlier reviews asked that is still open, and what you decided), your context and earlier notes. The review may ask up to 3 actions and write up to 3 notes for other pages.
    - **Written later** (`params.catchUp`, "Write reviews for earlier months", or any month before the last complete one, or before a month whose review wrote actions): none of today. The review alone, as at the month's end, with no advice about now, no actions and no notes. The evaluation can ask an earlier month as the latest (`params.asLatest`).
  - **Its output:** the review (a title of up to 95 characters resting on `verdictInputs`; 2 or 3 key points, each with its evidence; parts in order, each only when it has something to say: why the month looked like this, what moved (with any pattern), worth, people, coming up; new limits that change a conclusion only; confidence), `actions` and `dropActions` (latest only, below), `watch` (up to 2 lines about your money or decisions for the next review to check, each saying why it matters; never routine, never about how the app files something), `followUp` (each of the last review's lines: happened, did not happen, or cannot tell, with a note; older reviews said done and still open), up to 3 `proposals`, and up to 3 notes for other pages, never the Overview. All but the actions are kept on the month's review insight; `body` holds the parts as text.
  - **Actions** (latest only; `actions.json`, DATA_FORMAT.md): up to 3 things to do now that the Overview's alerts do not already ask (a Self Assessment deadline is an alert, never an action): judgements only the review can make. 0 is right for a quiet month. Each has a key (`acct-`, `job-`, `payee-`, `tax-`, `cat-` or `plan-`, then words; `acct-`, `job-` and `cat-` name a record by id), what, why with its figure, a date only for a real deadline, the page to do it on, a kind (money, tax, data) and evidence. Every open action from an earlier review is asked again under the same key or dropped with a reason (an overdue one dropped if its chance has passed, else asked with a new date); one you decided, at any time, is never asked again, and a review never changes it. A rerun of the month takes back what its earlier run did first. The month's title never names an alert: the Overview shows them above it. The review insight keeps the keys it asked (`actionKeys`); done and not relevant are yours alone (`PATCH /api/actions/:key`, your session only).
  - **Proposing fixes.** A change the review proposes is one of `set_category`, `add_rule` or `set_note`, each with why. A proposal goes to Proposals through `ctx.proposals`, like any other (§5), less the changes that do not fit the data; never a payment with a person. The review lists the ones it made.
  - **Checking a review.** Every £ figure in its text and its actions must be one the app has: a figure in the digest or a payment's amount (to the penny, or to the pound either way when written without pence: £142 or £143 for £142.40), or the sum or difference of two of the month's headline figures. Figures written as "about …" are not checked. Its actions are checked too: the key's grammar, length and the record it names, a real date not already gone (an open action's own date carried unchanged excepted), every open action asked again or dropped with a reason and not both, none you decided (as the data stands when it answers), none a Self Assessment alert already asks, no key twice. Figures the digest gives in words (a spending trend, an alert) count as known. Nothing is written unless the review itself can be: a quiet month with no parts keeps its key points as its text. When something is wrong, it is asked once more with what is wrong and its first answer (a second run in the same session, its cost added); figures still not found are kept on the review (`unchecked`) and shown beside it, and an action still breaking a rule is left out.
  - **Before a prompt version goes live** (`npm run review:eval -- <month>`): the month written again on a copy of the data (its documents left out, deleted afterwards), beside the review that stands, with the automated gates (`src/server/agents/review-gates.ts`: length, title, key points, the app's words, names in capitals, whole pounds, figures found, actions, no alert repeated, open actions carried, decided ones kept, no routine line to watch). `--dry-run` shows what Claude would read and stops, free; `--catch-up` writes it as written later; `--model` picks another Claude model for the run; on demo data, `--scenario sa` (dividends last year over the allowance, nothing told) and `--scenario actions` (an action left open, one you decided). Every run but a dry run is a Claude run on your plan, started only by you; results stay in `.work/review-eval/`.
  - **A rerun replaces its month:** every active note an earlier `monthly-review` run wrote for that month is superseded (yours never are), not only one of the same kind and subject.
  - **Earlier months, oldest first.** `POST /api/jobs/month-reviews` (yours alone: no token may) queues a review, written later, for each complete month before the latest with no standing review by this prompt version, among the last 13. The runner runs month reviews oldest month first however they were queued, so each reads the ones before; one that fails does not stop the rest, and the next reads the latest review there is.
  - **Shown by month.** The Overview's month card shows the review of the month you pick (`?month=`), beside its figures, whether or not it has expired; expiry only takes a note out of "What to look at". The Reviews page (`/reviews`) lists every month's review, newest first. Your thumbs and note on a review are read by the next ones.
- **The output's records** carry the job's id, model and prompt version.
- **A job can propose fixes** through `ctx.proposals` (§5), under the job's provenance. The month
  in review does (above). A job that checks the owner's data for fixes reads the owner's data, so it
  gets no web tools, and like every job it waits for agents to be on or for your click.
- **Only real data starts jobs by itself.** Jobs start on their own only when the data directory
  is tracked in git; the demo and throwaway copies never start them, though you can still start
  one by hand.

## 8. Prompt versions

Each job has a `promptVersion` (in `src/server/agents/kinds.ts`), recorded on everything it
writes. Change the version whenever a prompt or output schema changes, so old output can be told
apart from new.
