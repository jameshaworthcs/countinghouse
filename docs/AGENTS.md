# Agents: the contract

Agents keep the app's knowledge current: they research what the owner holds, set forward-looking
assumptions from evidence, and write insights. This page is the contract any agent follows, whether
it is an in-app job or a Claude Code session working on this repository. The code that enforces
it is `src/server/records.ts` (validation and writing) and `src/server/agents/` (in-app jobs).

## 1. The ground rules

1. **Source facts are never touched.** Transactions, balances, holdings, figures and documents are
   what the owner's documents said. Agents never write them, and inference never changes them.
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
| Accounts, transactions, balances, holdings | `data/accounts.json`, `data/transactions/`, `data/balances/`, `data/holdings/` |

In-app analysis jobs do not read `data/`. They read a **digest**: the app's own computed figures,
with the ids of the records behind them (`src/server/agents/digest.ts`). A Claude Code session may
read `data/` directly, but should quote computed figures from the app rather than recompute them.

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
  - A forward-looking return is an assumption with `basedOn` pointing at the research
    (`market.outlook`, `economy.indicator`) it rests on, and a `rationale` explaining the link.

Research record kinds (`ResearchDataSchemas` in `src/shared/schema.ts`):

| Kind | Subject | Holds |
|---|---|---|
| `instrument.facts` | instrumentId | OCF, transaction costs, allocation by class, regions, benchmark, launch date, distribution, risk indicator, fund size |
| `instrument.performance` | instrumentId | annualised returns (1, 3, 5, 10 years, since launch), benchmark returns, calendar years, volatility, maximum drawdown |
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
  `npm run records -- write batch.json`. The write commits to git. The running app picks the change
  up.
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
  - research without a sourced URL.
- **Assumptions are append-only.** To change a value, write a new record for the same key and
  scope; the history keeps every version. Set `reviewBy` so the app knows when it goes stale
  (about six months for market assumptions).
- **Instruments:**
  - A record with an existing `id` updates it; aliases are merged.
  - Fill identity blanks (ISIN, ticker, type, manager).
  - Never overwrite what the owner set, including `allocation`.
- **Insights:**
  - `evidence` must cite records that exist: transaction ids, account ids, research, assumption
    or context ids. A `computed` metric must be named as the digest names it.
  - Choose the `pages` it belongs on and an `expiresOn`.
  - With `"supersede": true`, a batch's insights replace the writer's earlier active insights with
    the same kind and subject (a rerun of a job).
- **Context** from the owner's words is never written directly.
  - The `interpret-note` job stores **proposals** on the note; the owner accepts or edits them.
  - Agents read context; they do not change it.

## 5. Resolving conflicts

| Situation | What to do |
|---|---|
| Your research disagrees with earlier research | Write the new research (it is dated); the newest is used. Note the disagreement in `notes`. |
| Evidence contradicts an owner override | Leave the override. Write an insight on the relevant page citing the research. |
| Sources disagree with each other | Prefer the most recent primary source; record the others in `notes`; widen the range. |
| An assumption is stale (`reviewBy` passed) | Research again and append a new version; do not edit the old one. |
| A fund's identity is ambiguous (share classes) | Record what the holding's ISIN says; if there is none, say so and use `confidence: "low"`. |
| An insight would repeat an earlier one | Skip it unless something changed; the digest lists earlier insights and the owner's feedback. |

## 6. In-app jobs

Jobs run through the logged-in `claude` CLI (`src/server/agents/claude.ts`), locked down like
extraction:

- an empty scratch directory is the working directory;
- `--restricted`: file tools are confined to it and code-running tools removed;
- `--safe-mode`, no session persistence, no MCP servers;
- output is constrained by a JSON Schema and parsed again with Zod.

| Job | Reads | Tools | Writes | Starts by itself |
|---|---|---|---|---|
| `research-instrument` | public identifiers of one fund | WebSearch, WebFetch | instrument identity blanks, `instrument.facts`, `instrument.performance`, a fund insight | when a fund is new; when research is stale (≤ 3 a day) |
| `research-provider` | a provider's name and the kinds of account held there | WebSearch, WebFetch | `provider.rates`, `provider.fees` | when a provider is new or stale |
| `refresh-assumptions` | the asset classes held (no amounts) | WebSearch, WebFetch | `economy.indicator`, `market.outlook`, assumptions with `basedOn` | when assumptions are on fallbacks or past review (at most weekly) |
| `insights-after-import` | the digest, focused on the new imports | Read (the digest only) | insights | 2 minutes after imports stop arriving |
| `monthly-review` | the digest, focused on the last complete month | Read (the digest only) | a month in review, plus page insights (superseding the last run's) | once a month's data is complete for every account |
| `interpret-note` | the owner's note, account and instrument names | none | proposals on the note | when a note is added |

Other behaviour:

- **Settings → Agents** turns off automatic starts, insights after imports and the monthly review,
  and picks the model and effort.
- **Holdings create instruments.** Funds listed on statements become instrument records
  (`setBy: system`, identifiers exactly as printed), so research can follow.
- **Job state** lives in the work area, not `data/`. Assumptions & research → Agent jobs shows
  what is due, queued, running and finished, with rerun and cancel.
- **The output's records** carry the job's id, model and prompt version.
- **Demo data never starts jobs by itself.**

## 7. Prompt versions

Each job has a `promptVersion` (in `src/server/agents/kinds.ts`), recorded on everything it
writes. Change the version whenever a prompt or output schema changes, so old output can be told
apart from new.
