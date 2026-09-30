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
| The capture list (what to collect from each provider) | `data/capture.json` |
| Accounts, transactions, balances, holdings | `data/accounts.json`, `data/transactions/`, `data/balances/`, `data/holdings/` |

In-app analysis jobs do not read `data/`. They read a **digest**: the app's own computed figures,
with the ids of the records behind them (`src/server/agents/digest.ts`). A Claude Code session may
read `data/` directly, but should quote computed figures from the app rather than recompute them.

**The live app's API** is open to an agent that holds a token the owner made (DEPLOY.md, "Agent
access"): `npm run -s api -- GET /imports`.
- It is how an agent does upkeep on imports waiting for review. It can read a document again, draft
  it again, choose its account or edit its draft.
- It can also write records (`POST /records`, the same batches as below) and start jobs, but only
  if the token has those scopes.
- Committing, dismissing and discarding stay with the owner.
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
| `research-instrument` | public identifiers of one fund | WebSearch, WebFetch | instrument identity blanks, `instrument.facts`, `instrument.performance`, a fund insight | only when you ask (or with "Research by itself" on: when a fund is new; when research is stale, ≤ 3 a day) |
| `research-provider` | a provider's name and the kinds of account held there | WebSearch, WebFetch | `provider.rates`, `provider.fees` | only when you ask (or with "Research by itself" on: when a provider is new or stale) |
| `refresh-assumptions` | the asset classes held (no amounts) | WebSearch, WebFetch | `economy.indicator`, `market.outlook`, assumptions with `basedOn` | only when you ask (or with "Research by itself" on: when assumptions are on fallbacks or past review, at most weekly) |
| `insights-after-import` | the digest, focused on the new imports | Read (the digest only) | insights | 2 minutes after imports stop arriving |
| `monthly-review` | the digest, focused on the last complete month | Read (the digest only) | a month in review, plus page insights (superseding the last run's) | once a month's data is complete for every account |
| `interpret-note` | the owner's note, account and instrument names | none | proposals on the note | when a note is added |
| receipt reading (not a job) | one receipt file, the payment's amount, date and payee, the category names | Read (the receipt only) | a reading on the receipt: proposed split lines | when a receipt is attached, only with "Read receipts with Claude" on (off by default) |

Other behaviour:

- **Settings → Agents** turns off automatic starts, insights after imports and the monthly review,
  and picks the model and effort.
- **Holdings create instruments.** Funds listed on statements become instrument records
  (`setBy: system`, identifiers exactly as printed), so research can follow. They are recorded at
  each commit that records holdings and when the app starts, whether or not agents are on: a fact
  from the statement, not agent work. Researching them waits for agents.
- **Job state** lives in the work area, not `data/`. Assumptions & research → Agent jobs shows
  what is due, queued, running and finished, with rerun and cancel.
- **No repeats.** A job that succeeded for the same subject within the research staleness window
  (Settings → Agents, 90 days by default) is not started again by itself, even if it found nothing;
  a failed one waits a day. The owner can rerun either at any time.
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
  | `monthly-review` | 61 s | $0.24 |
  | `interpret-note` | 15 s | $0.07 |
- **The output's records** carry the job's id, model and prompt version.
- **Only real data starts jobs by itself.** Jobs start on their own only when the data directory
  is tracked in git; the demo and throwaway copies never start them, though you can still start
  one by hand.

## 7. Prompt versions

Each job has a `promptVersion` (in `src/server/agents/kinds.ts`), recorded on everything it
writes. Change the version whenever a prompt or output schema changes, so old output can be told
apart from new.
