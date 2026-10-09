# Architecture

```
Browser (React SPA, TanStack Query)
   │  JSON over HTTP · server-sent events for live updates
   ▼
Hono server  (Node 24, tsx; 127.0.0.1:4750 live, 4760 in development)
   ├─ security: Host allow-list · CSRF (custom header + Origin) · auth gate · CSP
   ├─ AuditLog (audit.ts) ──► work area audit/<yyyy-mm>.jsonl: who did what, from where (Settings → Audit log)
   ├─ SessionLog (sessions.ts) ► every Claude run: work area sessions/<id>.json + its transcript beside its job,
   │    import or receipt (/sessions, "Agent sessions" below)
   ├─ routes/   auth · data (CRUD) · imports · proposals · analytics · records · jobs · sessions · system (SSE, git)
   ├─ Store ─────────────────► data/*.json(l)  (atomic writes, validation, quarantine, file watcher)
   │    └─ 'change' events ──► AuditLog, then GitCommitter ──► git commit -- data/   (debounced, pathspec-limited, main only)
   ├─ records.ts: the validated write path for assumptions, research, insights, context, instruments,
   │    the capture list
   │    (in-app jobs · POST /api/records · npm run records)
   ├─ JobRunner (agents/) ───► claude CLI, locked down, one job at a time; state in the work area
   │    ├─ research-instrument · research-provider · refresh-assumptions   (web tools, public inputs)
   │    └─ insights-after-import · monthly-review · interpret-note · label-imports   (the owner's data, no web)
   ├─ ProposalService ───────► proposed fixes: an agent (token or job) proposes, you apply or dismiss
   │    (pending in the work area; decided → data/proposals/, with what they changed; one the
   │    data comes to say all of closes by itself as already done)
   ├─ ImportService (queue) ─► work area .work/<data-dir>/   (uploads + drafts, never committed)
   │    ├─ detect → csv profiles (and spreadsheets' first table) · ofx · qif · santander-txt   (deterministic, local)
   │    ├─ spreadsheets that are not a list of payments (timesheets) → every sheet as text → Claude
   │    ├─ images: capture date (EXIF/filename/mtime), tiling of long screenshots
   │    ├─ engines: claude-cli · claude-api · ocr (tesseract/pdftotext)
   │    ├─ normalise → buildDraft (match accounts, categorise, dedup and what it adds to a recorded payment, transfers)
   │    └─ commitDraft → Store (+ document archived, import record written)
   │    └─ read a stored document again → compare with what was recorded → apply what you choose
   ├─ InboxWatcher: inbox/ → ImportService
   └─ Analytics (cached per store version)
        BalanceEngine · Coverage · estate · cashflow · spending (+ computed signals) · recurring · budgets · goals · pay
        · earned pay (timesheets → payslips → bank, owed pay pending beside the estate)
        params (per account and fund, from assumptions, research and statements) · model (pure
        projection, bands, retirement, fee drag) · projections · investments · allowances
        selfassessment · monthly · capture list · health (+coverage, FSCS)
```

Code and data live in two repositories (docs/SELF_HOSTING.md, "The layout"): this one, the code,
and a private **data repository** of your own (`npm run init-data`) holding `data/`, the work area
(`.work/`) and the inbox, with no remote. The server finds them through `FINANCE_DATA_DIR`,
`FINANCE_WORK_DIR` and `FINANCE_INBOX_DIR` (`src/server/config.ts`); in production the data
directory must be named. Development and the demo use generated data in the code checkout,
gitignored. `src/server/datarepo.ts` makes a data repository and warns when it has a remote.

Source layout:

| Path | What lives there |
|---|---|
| `src/shared/` | Isomorphic code: schemas (`schema.ts`), money, dates, UK rules, account-type metadata, categories, merchants, categoriser, who a payment is with when a person and what it looks like (`people.ts`), which payments an agreement schedules (`agreements.ts`), an account's terms as a reading gives them (`terms.ts`), reconciliation, what a document adds to a recorded payment (`detail.ts`), identifiers kept out of the data (`privacy.ts`), API types |
| `src/server/` | Store, git, auth, security, migrations, enrichment, routes, app composition; `employments.ts` matches a document's employer to one of your jobs |
| `src/server/ingest/` | Everything from bytes to committed records; `govuk.ts` reads HMRC's gov.uk pages and `payslips.ts` known payslip layouts from their text, on this machine; `pension-csv.ts` a pension or fund provider's trade histories and contribution summaries; `schedules.ts` drafts a document's schedules of payments as agreements (and student finance's as its student loan's movements) |
| `src/server/analytics/` | Read-only computations over the store; `model.ts` is pure (no store access); `sources.ts` decides which document's figure counts when several state one job's year; `payslips.ts` reads payslips in full (their year to date, gaps, employer costs); `taxdocuments.ts` is Settings → Tax documents; `companies.ts` is your shares in companies; `arrangements.ts` checks what employers set up to pay into your pensions; `payroll-pensions.ts` pairs a pension's rows with the payslips whose money they are; `agreements.ts` checks an agreement's schedule against your payments; `terms.ts` is an account's terms over time and what ends soon; `queue.ts` is the To categorise page (people's payments and cash and cheques paid in, rules your decisions point to, what's left by payee, the categories the app guessed); `month.ts` is a month's figures, for the Overview's month card and the month in review's digest alike; `prices.ts` is published prices and what they say an account of investments was worth between its valuations (its holdings path, or a price index) |
| `src/server/agents/` | Agent jobs: the CLI runner, job kinds and prompts, the digest, the queue |
| `src/server/records.ts` | The validated write path for agent-maintained records |
| `src/server/audit.ts` | The audit log: who is acting (carried through async work), the request middleware, the hash-chained log, search and the chain check; `auditdiff.ts` says what a write changed, record by record |
| `src/server/sessions.ts` | Agent sessions: each run's record and transcript in the work area, their caps and retention; `sessionviews.ts` lists them (with earlier ones and agents with tokens) and says what each produced |
| `src/server/proposals.ts` | Fixes agents propose to your data, checked against it and applied only by you ([AGENTS.md §5](AGENTS.md)) |
| `src/web/` | The React app: `pages/`, `components/` (UI kit, charts), `lib/` (API client, prefs, data context) |
| `scripts/` | Demo data, import CLI, records CLI, validate, schema export, screenshots (demo data only), set-password, deploy, `init-data` (a new data repository); the leak guard (`leak-guard.ts`, `leak-guard/`) and its git hooks (`hooks-install.ts`) keep personal data out of the repository ([LEAK_GUARD.md](LEAK_GUARD.md)), and `fixture-anonymise.ts` turns a real import's document into a synthetic fixture |
| `tests/` | Vitest suites + synthetic fixtures for every supported bank format |
| `deploy/` | systemd unit template and an example Caddy site block ([SELF_HOSTING.md](SELF_HOSTING.md)) |

## The layered data model

Every number can be traced back, and every derived value can be rebuilt without re-importing:

1. **Documents.** The original file under `data/documents/<yyyy>/<mm>/<sha12>-<name>`. It is
   content-addressed and immutable.
2. **Extractions.** `data/imports/<yyyy>/<import>.json` keeps the engine's full output (`raw`), the
   engine and prompt version, the reviewed draft, and the result. For deterministic parsers every
   source row is also kept verbatim on the transaction itself (`raw`).
3. **Records.** Transactions, balances, holdings, figures, HMRC's records and payslips in full, with every source field the document
   offered: time, bank id, type, reference, merchant details, bank category, FX, fees, running
   balance, plus open-ended `attributes`.
4. **Enrichment.** `payee`, `category`, `transferGroup` and `counterpartyAccountId` are
   recomputable by `enrich()` (Settings → Rules → *Preview re-applying to history*). The owner's manual
   edits (`categorisedBy: "user"`) are never overwritten.

"Future changes without re-ingestion" follows from this:

- New derived features read existing records.
- New source fields are backfilled by a migration from `raw` or from the stored extraction.
- A better extraction prompt can be re-run on the archived document.

## Assumptions, research and insights

The equations are in [FORMULAS.md](FORMULAS.md); the rules for writing these records are in
[AGENTS.md](AGENTS.md).

- **Assumptions** (`data/assumptions.jsonl`) are append-only versions. `AssumptionSet`
  (`src/shared/assumptions.ts`) resolves a key for a target:
  - your records first, then agents', then the code fallback;
  - within each, the most specific scope wins.
- **Parameters** (`analytics/params.ts`):
  - Each account's and holding's expected return, volatility, charges and interest come with their
    source and a plain-words basis.
  - Facts (fund charges, make-up, fee schedules, current rates) come from statements and research;
    forecasts only from assumptions.
- **The model** (`analytics/model.ts`) is pure. It simulates month by month, with inflation and
  charges, and computes the p10–p90 range from exact moment recursions (with the uncertainty in
  expected returns integrated), checked against Monte Carlo in the tests.
- **Coverage** (`analytics/coverage.ts`):
  - It knows which days each account has data for, from import statement periods (an export's
    range when you gave one) and the stretches you confirmed nothing is missing from
    (`coverage.json`).
  - Averages, baselines and signals use covered time only, and every page can say what is missing.
  - One rule says which days a period is missing (`missingDays`, FORMULAS.md §3): Data health, the
    Tax year page, Self Assessment and the capture list all use it, so they never disagree.
  - Data health lists each stretch no document covers, back to the oldest tax year still open, with
    what its balances say (`BalanceEngine.evidence`). You confirm a stretch; the balances never
    cover one by themselves.
- **Research and insights** are written by agent jobs through `records.ts`, with provenance.
  - Pages show insights in a panel labelled as Claude's inferences, apart from computed figures
    and computed signals.
  - The **Assumptions & research** page shows every assumption with its source and history, your
    overrides, funds and providers with their research, what you have told the app, and the agent
    jobs.

## Store

- Everything is loaded into memory at start-up (10 years of transactions is well under 100k rows).
- **Writes** are serialised by a mutex, validated with the Zod schemas (which also gives canonical
  key order), and written atomically (temp file + rename).
- **Invalid records are quarantined, not dropped.** A line or item that fails validation is kept
  verbatim and written back unchanged alongside valid records, and is reported under Settings →
  Data health.
- **External edits** (by hand, `git checkout`, Claude Code) are detected by a recursive `fs.watch`
  plus content hashes of the app's own writes, and trigger a reload.
- Each mutation emits a `change` event, which feeds the audit log (with what it changed, record by
  record), git auto-commit and the browser's live-update stream.

## Audit log

Git's history says what changed in `data/`; the audit log (`src/server/audit.ts`, Settings → Audit
log) says who did it, from where, and also covers what git never sees: the work area (imports
waiting for review, jobs, proposals waiting for you, tokens), sign-ins and refused requests.

- **Who.** Every entry has an actor:
  - you, signed in, with the client's address (from Caddy's `X-Forwarded-For`), the tailnet's name
    for the device and its tailnet user (`tailscale whois` on the local daemon, remembered for ten
    minutes; on in production, `FINANCE_AUDIT_DEVICES=0|1` to choose), and the browser;
  - an agent token (its id, name and scopes, and the same address details);
  - an agent job (its id, kind and what started it);
  - the app by itself (start-up upkeep, reading imports, the inbox folder, the job scheduler,
    closing proposals already done, git);
  - outside the app (the store's watcher saw a file it did not write: a hand edit, `git checkout`,
    `npm run records`);
  - not signed in (a refused request; a token that is not valid is named by its claimed id).

  The actor travels with the work through `AsyncLocalStorage`: the request middleware sets it, and a
  job run, the import queue, the inbox and the app's timers each set their own, so a write deep in
  the store knows who asked for it. Work a request started that outlives it keeps the request's
  actor but not its request id.
- **What.** Entries, by category:
  - `request`: every request that could change something (any method but GET, HEAD and OPTIONS,
    except previews and checks), refused ones too, with method, path, answer, time taken, what it
    did (`changes`) and the JSON it sent. Secrets (`password`, `token`, `secret`…) are redacted,
    NI numbers removed, account and card numbers cut to their last 4 digits, long values cut, and
    an import's draft kept only as its shape, never its contents. Uploads
    are not read; the import's own entries name the file, its size and its SHA-256.
  - `data`: each store write (`data.change`) with its files and what it changed: records added
    and removed, and each changed record's fields before → after (the first 50 records; counts
    cover the rest); a single file such as settings field by field. Also `data.external`,
    `data.migrate`, and `git.commit` naming the entries each commit holds (the commit message
    carries `Audit: #12–#14` back).
  - `auth`: signing in (password or OIDC, refused attempts with why) and out.
  - `import`, `job`, `proposal`: each change of state of an import, an agent job (with its cost,
    what it wrote, or its error) and a proposed fix.
  - `session`: each agent session's start and end (`session.start`, `session.succeeded`,
    `.failed`, `.cancelled`), with its model, cost and what it belongs to.
  - `token`: tokens made and revoked.
  - `app`: start (version, commit) and stop.
- **Kept.** Append-only JSON lines, one file per month (UTC), in the work area's `audit/`
  (a 0700 directory of 0600 files, never in `data/` or git; back it up with the rest of the work
  area). Nothing is ever trimmed.
  - Each entry is written and `fdatasync`ed before the request answers.
  - A write that fails stays queued, is retried every 5 seconds and with the next entry, and
    Settings says so.
  - A line cut off by a crash is reported, and the next entry starts on a fresh line.
- **Tamper-evident.** Each entry has a sequence number and `hash = sha256(previous hash + the
  entry)`. *Check the chain* walks the log and names any entry altered, removed or out of order.
  It shows tampering after the fact; it cannot stop someone with the files from rewriting the whole
  chain.
- **Searched** on the server (`GET /api/audit`): any words (every field but the hash, plus the git
  commit), who, what, outcome and dates, newest first. By default one line per action: a request's
  writes are folded into its entry; *Each step separately* shows them all. `GET /api/audit/export`
  gives the same search as JSON lines, `GET /api/audit/verify` checks the chain. A token with
  `read` can read the log, like everything else. `?q=#123` finds entry 123 alone (folded or not),
  and `?about=<id>,…` keeps the entries that name one of the ids or whose job or token acted. Each
  entry read carries the agent sessions it concerns (`sessions`), and the log links to them.

## Agent sessions

Every time the app runs a model (Claude, or the local model service) is a session (`src/server/sessions.ts`), listed on its own page,
`/sessions` (*Agent sessions*). The page is linked from Settings → Agents and Agent access, from
Assumptions & research → Agent jobs, from each import's page and its *Read again* card, from a
receipt's reading, and from the audit log. A session can belong to any of these, so it has a page
and an address of its own, and links back to each.

- **What is a session.** One run of an engine, through the `claude` CLI, the Messages API or the
  local model service (engine `inference`: its request without the images, any waits, its answer
  with any reasoning, and its provenance, kept whole in the record):
  - an agent job (each kind; a job interrupted by a restart and run again is two);
  - reading an upload: the first reading, and the check by a second model when there is one, each
    a session. Reading again before review (reprocess) makes new sessions;
  - reading a stored document again, for comparison (first reading and check);
  - a run suggesting categories (named by its own id);
  - a question asked (kind `ask`: one per question in a conversation, beside it in `ask/<id>/`);
  - reading a receipt.
  `claude --version`, which looks for the engine, is not a session. Neither is `eval/` (a
  development tool that runs outside the app).
- **Recorded as it runs.** The record (`sessions/<id>.json` in the work area) holds:
  - who started it (the audit log's actor, carried from the upload, the request or the job's
    queueing) and why;
  - its kind, the job, import or receipt it belongs to, the engine, the model asked for and the one
    that answered, effort, prompt version, tools and privacy class;
  - status, start, end, turns, tokens and cost (from the engine's result event), and any error;
  - the request that started it (`requestId`, its audit row: a job carries the one that queued
    it), the state of `data/` it ran against (the git commit, files not yet committed, the format),
    and who stopped it, if someone did;
  - for a session Claude ran because the local model could not (where Settings → Models allows
    it), the session it stood in for (`fallbackOf`) and why;
  - when it ends, the SHA-256 of its transcript (also in its audit row).
- **Its input files.** A job's scratch directory (the files it was given to read, such as the month
  in review's transactions) is kept gzipped beside the transcript, as `<sessionId>.inputs/`, under
  the same retention and total cap. It is deleted with the transcript. One session keeps up to the
  transcript cap; files over it are listed as not kept. Its page opens or downloads each.
- **The transcript** is a JSON-lines file beside what it belongs to: `jobs/<jobId>/`,
  `imports/<importId>/`, `rereads/<importId>/` or `receipts/<receiptId>/`, as `<sessionId>.jsonl`.
  Files are 0600 and directories 0700. It is never in `data/`, git or the server's log.
  - The first event is what the app sent: system prompt, prompt, output schema, tools, model,
    effort, and the files the run could read (names and sizes). For the API, it is the request as
    sent. For the local model, every text part (a spreadsheet's text too) and each image by name,
    size and page of its document.
  - Then every event the engine gave. The CLI runs with `--output-format stream-json --verbose`:
    its init, each assistant turn (text, thinking, tool calls), each tool result, the final output
    and the result with usage and cost. The API gives its content blocks as they complete, the
    final message, then a result with usage and cost. The local model gives its answer and
    reasoning, then a result with its parsed output (`structured_output`), usage and provenance.
  - The app's own steps: a job's check of the answer (`finance.check`: the problems found, and
    whether it was asked again), what it wrote (`finance.applied`: records, proposals, what is
    unresolved), a run's proposal (`finance.proposed`), waits for the local model, and a stop
    (`finance.cancelled`, who stopped it).
  - Each event is written as it arrives. A running session's page shows them live: the record is
    saved and a `session` event sent at most once a second.
  - Claude Code keeps nothing itself (`--no-session-persistence`): this file is the only
    transcript.
- **What a transcript leaves out.** It holds what Claude saw, document contents included, except:
  - a file's bytes (base64 images and PDFs), being the document itself, kept with the import;
  - account and card numbers, which keep their last 4 digits (`maskIdentifiers`, as in the audit
    log);
  - strings over 200,000 characters, which are cut, and events over 1 MB, which are left out and
    marked.
- **Capped and kept for a time.**
  - One transcript stops at 10 MB (`FINANCE_TRANSCRIPT_MAX_MB`) with a marker, but its final result
    is still written.
  - Transcripts are deleted 90 days after their session ends (`FINANCE_TRANSCRIPT_DAYS`).
  - The oldest go first while all of them together pass 1 GB (`FINANCE_TRANSCRIPTS_TOTAL_MB`).
  - A sweep runs at start-up and every 6 hours. The record stays and says when and why its
    transcript went. The newest 5,000 records are kept.
- **Before transcripts.** Sessions that ran before the app first kept them (`sessions/since`) are
  listed from what their job, import, re-reading or receipt recorded: model, prompt version, timing
  and cost (an earlier import's two readings are one row, with their cost together). Their page
  shows that record as it is and says plainly that no transcript was kept. None is ever
  reconstructed.
- **Agents with your tokens** run outside the app, so the app sees only their requests. The token
  use log is split into stretches of activity (a gap of 30 minutes ends one), each listed with its
  requests, how many changed something or were refused, and its audit rows. They have no transcript.
- **What it produced**, linked to where each thing lives:
  - a job: the records it wrote (research, assumptions, insights, instruments, what you told the
    app), the proposals it made, the note it read, the imports it named, its summary or error;
  - a reading: the import, its extraction (kept, or stored beside it as the other reading, or
    replaced by a later reading), the check, the draft, and what was committed;
  - a re-reading: the comparison;
  - a receipt: the lines it read, a proposed split.
- **Stop.** A running session's page has Stop (signed in; no token may). The session's signal
  reaches its engine: the CLI's process is ended, the API's stream and the local model's request
  are aborted. It ends `cancelled`, nothing it would have produced is applied, its transcript is
  kept, and a job's session cancels its job. The audit log records the stop (`session.cancel`, in
  the request's row) with who did it.
- **The page.** Besides the record and transcript: its output as returned (whichever engine), the
  local model's answer and reasoning, its timings (reading the prompt and writing, with tokens per
  second), the request that started it, the session it stood in for or that took it over, the data
  it ran on, the transcript's hash and its input files.
- **Audit log.** A session's start and end are entries of their own (category `session`, with
  model, cost and outcome, the request that started it, and the end's transcript hash: the log is
  hash-chained and the transcript is not, so an edited or cut transcript shows, even after it has
  been deleted). A session's page lists those, and its job's, import's, receipt's or
  token's rows (`about`); each opens in Settings → Audit log. The log, in turn, links every entry
  that concerns a session (by its id, its job, import or receipt) to that session.
- **API.** `GET /api/sessions` (the list, and how transcripts are kept), `GET /api/sessions/:id`
  (one, with what it produced, its audit rows and related sessions), `GET
  /api/sessions/:id/transcript?from=<n>` (events from the nth, for a page following a run), `GET
  /api/sessions/:id/inputs/<name>` (an input file, `?download=1` to save it), `POST
  /api/sessions/:id/stop`, `GET /api/sessions/totals`, `GET /api/sessions/search?q=`. A token
  with `read` can read them, like everything else.
- **Totals and search.** The page's Totals card counts sessions by month, kind of work and engine:
  how many, failed and stopped, tokens, what Claude reported at API prices (on the plan an estimate,
  on the API the charge) and the local model's time (its prompt and generation timings). Search
  can look inside the transcripts too: on the server, newest first, every word must appear, within
  5 seconds and 300 MB (it says when it stopped early), with a snippet of where it matched.

## Ask

Questions about your money, asked on the Ask page (`src/server/ask.ts`, `ask-tools.ts`; DECISIONS
2026-10-05). Each conversation has a page of its own, `/ask/:id`.

- **Kept** in the work area, `ask/<conversationId>.json` (0600), never in `data/`: an answer is an
  inference. A conversation goes 90 days after its last question (the transcripts' retention).
  Delete only takes it off the list (the owner's choice); a follow-up puts it back.
- **A question is a turn**, and each turn a session (kind `ask`) with its transcript in
  `ask/<conversationId>/`. Follow-ups wait behind the turn running, and one turn runs at a time
  across conversations (the local model has one interactive slot). Stop works on the one running,
  and takes back one waiting; the audit log records both, with who did it.
- **Step by step (prompt `ask-3`).** The model is given the accounts, categories, the last 13
  months' totals, this year to date and last year (to the same date and whole), and recent trips (`openingContext`, about 2,000 tokens, kept with the
  conversation so every turn starts from the same prefix and the local model reuses its cached
  prompt). Each step is either a call of one tool or the answer, as one flat JSON schema. The app
  runs the tool and gives back its result, cut to 12,000 characters with counts and totals over
  every row. At most `settings.ask.maxToolCalls` calls (8 by default; Settings → Models), then it
  must answer. A follow-up is given the earlier turns, whole while they fit in 60,000 characters,
  else their questions and answers.
- **The tools** are read-only, built by fixed rules from the app's code, with no web access:
  `find_transactions` (the Transactions page's search, plus the original currency of a payment
  abroad; totals by year when it spans more than one), `spending_by` (category, payee, month or
  account, as the Spending page counts, with what was paid and refunded; by month, whether each
  month's data is complete and totals and averages by year), `compare` (two periods, by default
  the same dates a year earlier: totals, averages, completeness, the difference, the change and the
  categories that moved most), `trips`, `month`, `balances`, `coverage` (missing days) and `sum`
  (of chosen ids). Every sum is in integer pence (FORMULAS.md §19). The results give the totals a
  question needs, so the model has nothing left to add up. Each result links to where it can be checked: the Transactions page with the
  same filters (which takes `currency` too), or the page it came from.
- **The answer**: its text, figures with the step each is from, confidence, caveats, and whether
  it could not answer. A figure is marked computed when the app finds its number in that step's
  result; otherwise the page says it is the model's own, the answer's confidence is set to low
  (the model's own is kept beside it), and a caveat says why. The whole answer is labelled an
  inference.
- **The model** is picked per question: the local model thinking (the default, from Settings →
  Models), or not thinking, or Claude Sonnet or Opus (each step one `claude -p` call, no tools,
  in an empty directory, its prompt the conversation so far; what it looks up goes to Anthropic).
  When the local model cannot answer and Settings → Models lets Claude stand in for Ask, Claude
  starts the turn again, as a session of its own linked to the one it replaces.
- **Live.** On the local model each step is streamed (`stream: true`; the provenance comes in the
  usage chunk). The page shows what it is doing: waiting for the service and why, thinking (how
  much), the step it is writing, the tool it is running, the answer as it is written. An `ask`
  event on `/api/events` tells the page, at most once a second.
- **The input.** Enter sends, Shift+Enter starts a new line. Options: the model, a period and
  accounts (the tools' defaults when the model gives none). Suggested questions are built from the
  data by fixed rules (the latest trip, a currency used abroad, the last complete month), with no
  model. The local model's state (`/health`: ready, loading, its GPU lent out until when) is shown.
- **"This is wrong"**, with a note and who said so, is kept with the turn. An agent token with the
  `records` scope may mark one too (it changes no data). `GET /api/ask/feedback` lists them: a new
  prompt version must answer them at least as well before it ships. `npm run ask:eval` asks them
  again on the current prompt, over this checkout's `data/` in a throwaway work area (the live app
  untouched), and shows the old answer, why it was wrong and the new one.
- **API.** `GET /api/ask` (conversations, suggestions, models, the service's state), `POST
  /api/ask` (start), `GET /api/ask/:id`, `POST /api/ask/:id/turns` (a follow-up), `POST
  /api/ask/:id/cancel` (`turnId` for one waiting), `POST /api/ask/:id/turns/:turnId/feedback`,
  `DELETE /api/ask/:id` (hide). Only the owner asks, signed in; a token can read.

## Models per task

Every piece of model work is a task in `src/shared/tasks.ts` (DECISIONS 2026-10-04): what it needs
(images, the web, tools, reasoning), whose data it sees, which engines may run it, its default
engine and model, the priority it asks the local model service for, and how long a run may take.
Settings → Models (`settings.models.tasks`) overrides it per task, and `resolveTask` keeps only what
the task allows.

| Task | Default | Priority | Why |
|---|---|---|---|
| Read documents (`read-document`), and read them again | local `vision-extract`; NS&I's documents by Claude (CLI), Sonnet | batch | 99.3% of fields on the evaluation set, every wrong figure marked as a disagreement (DECISIONS 2026-10-05); NS&I's screens read poorly |
| Check a reading (`check-reading`) | local `vision-extract`, thinking (Claude, Opus, for a document Claude read) | batch | as above |
| Read receipts (`read-receipt`) | local `vision-extract` | batch | a proposal you accept; not measured on receipts |
| Name imports, understand notes (`label-imports`, `interpret-note`) | local `fast-chat` | batch, normal | short answers |
| Suggest categories (`suggest-categories`) | local `fast-chat`, local only | batch | one payment description per request, as a proposal |
| Answer questions (`ask`) | local `fast-chat`, thinking | interactive | someone is waiting |
| Month in review, insights after imports | Claude (CLI), Opus | — | they read with tools, which the local model does not have |
| Research (funds, providers, assumptions) | Claude (CLI), Opus | — | they need the web, which the local model does not have |

- **The local model service** (`src/server/inference.ts`) is a model service on a machine of your
  own (an OpenAI-compatible API), reached over your private network at
  `INFERENCE_BASE_URL` with finance's own key (`INFERENCE_API_KEY`), both in `.env`. It keeps no
  prompt or output. Settings → Models shows its state from `/health` (each alias, and who holds the
  GPU); `engines.ts` lists it beside Claude and OCR with `external: false`.
- **One batch or normal request of finance's at a time**: the service runs them in one slot, so a
  second would only spend its queue wait. An interactive one (a question) has a slot of its own.
- **Waits, failures and Claude:** a request the service cannot take (503, 502, 429) is retried
  after the wait it gives (`Retry-After` points past a GPU lease), for up to 12 hours
  (`INFERENCE_WAIT_MINUTES`; 10 minutes for a question), then the work fails as unavailable. Any
  other refusal, output cut off, or output outside the schema fails at once. A task falls back to
  Claude only when its switch in Settings → Models is on (off by default), since that sends what
  it sees to Anthropic.
- **Aliases:** `vision-extract` reads images; `fast-chat` and `classify-small` answer text. The
  bake-off aliases `chat-q8` and `chat-9b` can be chosen as experiments: loading one swaps the GPU
  (its first answer takes 2–3 minutes, and it holds the card for at least 10). `embed` and
  `rerank` are not used yet.
- **Thinking** is off except for the check of a reading and a question: it helps there, and on a
  first reading it is slower and worse (the service's BENCH, "M2").
- **Provenance:** everything a local model produces keeps the service's record of it beside
  `model` (request id, alias, model sha256, system fingerprint, seed, thinking, schema check):
  `extraction.inference`, `verification.firstInference/secondInference`, a receipt's
  `reading.inference`, a record's `provenance.inference` with `provenance.engine: "inference"`.
  Its session keeps the whole object. Local work has no `costUsd` and does not count against the
  agents' budget.

## Ingestion pipeline

`POST /api/imports` (or the inbox watcher, or `npm run import`) goes through
`ImportService.create`:

1. **Hash and dedupe the file.** The SHA-256 is computed and the file is checked against committed
   and pending imports.
2. **Capture date.** Screenshots get a capture date (and time, when known) from EXIF/XMP, then
   the file name, then the file's modified time, with the image's size and device. An app screen's
   balance is dated then, unless a date is printed beside it.
3. **Queue.** Processing runs in a concurrency-limited queue:
   - CSV: header signature → profile (yours first, then built-in). Unknown layouts are
     auto-mapped when confident, otherwise marked `needs_mapping`.
   - OFX/QFX, QIF, Santander TXT: dedicated parsers.
   - A PDF that is one of HMRC's gov.uk pages, or a payslip in a layout known here: read from its
     text on this machine (`govuk`, `payslip`), never sent to Claude (INGESTION.md, "HMRC's pages"
     and "Payslips read on this machine").
   - Other PDFs and images, with the model Settings → Models gives reading documents ("Models
     per task", below): the local model service (`inference`: page images at 150 dpi to its
     OpenAI-compatible API, on this machine), `claude-cli` (`claude -p --json-schema … --tools
     Read --safe-mode`, run in an empty scratch directory), `claude-api` (Messages API with
     structured outputs and server-side refusal fallback) or `ocr` (offline).
   - The output is normalised (money to pence precision, dates repaired) into an `Extraction`.
4. **Build the draft.**
   - Each extracted account is matched to one of yours by last 4 digits, provider, type and name
     (an account you dropped the file onto wins). A scrolled screen that names no account takes
     the one a screenshot taken and uploaded with it shows, when nothing on it disagrees.
   - Each row is categorised: your rules, then own-account transfers, then wrapper flows, then a
     payment one of your agreements schedules, then a card's own repayments and money from an
     investment platform, then the UK merchant list, then pay (your payroll number, or the name
     the bank gives a job's pay), then the bank's category, then Claude's suggestion, then a
     card's refunds (INGESTION.md, "Categorisation").
   - Duplicates are found by bank id, then exact multiset match, then fuzzy match.
   - Opposite-amount rows in your other accounts are proposed as the other leg of a transfer.
   - Investment app screens are read as the part of the account they show: an activity list's
     running balance is its cash, a fund's own page is one holding (INGESTION.md).
   - The balance date and its provenance are resolved.
   - Tax figures (P60, interest certificates…) are matched to accounts and deduplicated.
   - Pay figures and HMRC's records are matched to your jobs (`employments.ts`: PAYE reference,
     payroll number, a name only one job has, HMRC's record of the payment), else a new job is
     proposed.
5. **Review.** The UI edits the draft; reconciliation runs live in the browser.
6. **Commit.** `commitDraft` builds and validates everything first, then writes.
   - It creates accounts and institutions.
   - It assigns stable ids: a content hash plus occurrence, including the import id, so retrying
     a failed commit adds nothing twice.
   - It links transfers on both legs, and writes balances, holdings and figures. Holdings of one
     account and day, from several screens, merge into one snapshot.
   - It writes each account's terms for the day (`terms.jsonl`: its rates, limit and a card's
     minimum payment), whether or not the balance is recorded, unless the same terms are there.
   - It sets up the jobs the draft proposed, teaches existing ones what the document said about
     them (each payslip's payroll number and every name it prints, a group's too), and writes
     HMRC's records under their jobs.
   - It archives the document and writes the import record, including the account each section
     went to, which gives coverage.
   - The result is a single git commit.

   Pending rows are shown but not recorded unless you include them: the settled row arrives with
   the next statement.

"Commit all ready" commits only drafts with:

- every account matched to an existing one;
- no new job to set up;
- no possible duplicates;
- a known balance date;
- reconciling balances;
- extraction confidence that isn't low (not offline OCR);
- something new to add. An import that adds nothing new (INGESTION.md, "Nothing new") is dismissed
  instead: its document is filed and nothing is recorded.

## Balance engine

Per account:

- **Ledger mode** (bank, savings, cards, loans, cash ISA). Anchors are statement or screenshot
  balances and end-of-day running balances. `balance(D)` = nearest anchor ± the sum of
  transactions in between, using prefix sums and binary search.
- **Market mode** (investments, pensions, property). Anchors are valuations; between them, only
  external flows (contributions, relief, bonus, withdrawals, transfers) move the value.
  - Shortly before the first valuation, the value is rolled back from it.
  - Further back, the estimate is contributions plus linearly accrued growth, flagged as
    estimated.
- **Gaps** are consecutive usable anchors that transactions don't explain, usually a missing
  statement: the strong ones, and each screenshot or mid-day balance that adds up exactly. They
  are surfaced in Data health.

The estate value on a date is the sum of included accounts, converted to GBP (manual FX rates).
Groups are assigned by the sign of the balance, so an overdrawn current account counts as a debt
and a card in credit counts as cash.

## Web app

- React 19, React Router, TanStack Query with `keepPreviousData` (refetches never flash
  skeletons), and Tailwind v4 with CSS-variable tokens for light and dark.
- Live updates come over server-sent events (`/api/events`): a `data` event invalidates queries,
  an `import` event refreshes the import queue, and a `session` event an agent session's page.
- A page that fails to show gets `RouteError` (`components/RouteError.tsx`), never React Router's
  developer error page:
  - an ended session (a 401) goes to sign-in, coming back to the same page;
  - a page bundle a deploy removed (the old hashed file is gone) reloads onto the new build, once
    per 30 seconds so a real failure can't loop;
  - anything else first checks `/api/auth/status` and goes to sign-in if signed out, and otherwise
    says so in plain words with Reload, with the error folded under "Technical details";
  - a request that can't reach the server says so, not the browser's "Failed to fetch".
- Charts are hand-built SVG on `d3-scale`/`d3-shape`, following the validated data-viz palette:
  - fixed categorical order;
  - 2px lines and rounded bar ends;
  - crosshair tooltips with keyboard support;
  - a table view on every chart;
  - privacy blur on all amounts.
- List tables sort by column (`useSort`/`Sorted` in `lib/sort.ts`, `SortHeader` in the UI kit,
  comparison in `src/shared/sort.ts`):
  - each click on a header goes first direction, the other, then the table's own order;
  - blanks sort last either way;
  - chart table views sort too, by raw values where given (`TableView.sortValues`);
  - Transactions sorts on the server (`GET /api/transactions?sort=<date|amount|payee|account|category>_<asc|desc>`)
    because the list is capped, and keeps the sort in the address.
  - Tables whose order is the meaning (tax breakdowns, import review, proposals, key/value lists)
    don't sort.
- Clicking the sidebar link of the page you're on keeps its address (filters, sort) and scrolls it
  back to the top, as does any inner list marked `data-scroll-top`.
- Pages: Overview, Accounts (+ detail), Transactions (virtualised), Spending (+ To categorise), Projections,
  Investments & pensions, Tax year (Allowances, Self Assessment prep), Assumptions & research,
  Import (+ Review), Agent sessions (+ one session; the sidebar says how many are running),
  Settings, Login.
- Lists you choose rows from (Transactions, an import's rows) share one set of rules
  (`src/web/lib/selection.ts`):
  - a click or Ctrl/⌘-click ticks one row;
  - Shift-click ticks a range from it;
  - each new hold of Shift starts a group of its own, so separate groups never fill the gap
    between them;
  - Esc lets go of a selection.

## Security model

- **Network.** The server binds to `127.0.0.1`. Caddy fronts it on the tailnet (see SELF_HOSTING.md). A
  non-loopback `HOST` refuses to start without a login.
- **Host guard.** Unknown `Host` headers get a 421 (DNS rebinding).
- **CSRF.** Mutating `/api` calls require the `x-finance-csrf: 1` header, and `Origin` must match
  `Host` (`X-Forwarded-Host` through the local proxy). The session cookie is `SameSite=Strict`.
  The demo in a codespace (`FINANCE_DEMO_CODESPACE`, untracked demo data only; SELF_HOSTING.md)
  also accepts the `http://localhost:<port>` Origin GitHub's port forwarding writes.
- **Auth.** One user (`FINANCE_USERNAME`), signed in one of two ways; a server uses exactly one.
  - **OIDC** (`src/server/oidc.ts`, when `FINANCE_OIDC_CLIENT_ID` is set, with the provider's
    `FINANCE_OIDC_ISSUER`; `FINANCE_OIDC_NAME` is what the sign-in page calls it):
    - authorization code flow with PKCE (S256), state and nonce, through `openid-client`;
    - the ID token is checked against the provider's JWKS (issuer, audience, expiry, nonce), signed
      with RS256 when the provider offers it, else the first algorithm it lists;
    - the provider may limit who reaches the client at all; the app then admits only a verified
      address on `FINANCE_OIDC_ALLOWED_EMAILS`, as `FINANCE_USERNAME`;
    - state, nonce and verifier ride in a signed, 10-minute, `SameSite=Lax` cookie scoped to
      `/api/auth/oidc` (Lax, because the callback arrives from the provider's site);
    - the callback answers with a page that moves on by meta refresh, so the Strict session cookie
      is sent with the next request (a redirect would still count as cross-site);
    - a signed-out page load is redirected to the provider by the server; `/login` stays reachable
      to explain a failed sign-in, and after signing out it waits for a click;
    - password sign-in is refused.
  - **Password** otherwise: a scrypt hash in `.env`, throttled at 10 failures per client and 50 in
    total per 15 minutes.
  - The session cookie is an HMAC-signed `v1.user.expiry.sig`, keyed by a secret plus an epoch:
    the password hash, or the OIDC issuer, client and allowed addresses. Changing either,
    or switching method, signs everyone out.
  - Client IP and `https` are trusted from `X-Forwarded-*` only when the peer is loopback (Caddy).
- **Agent tokens** (`src/server/tokens.ts`; SELF_HOSTING.md, "Agent access") let an agent use the API
  without a session.
  - The owner makes them in Settings. Each has scopes and an expiry, is shown once, and is kept only
    as a SHA-256 hash in the work area.
  - A bearer token can read everything. It can change only the routes its scopes list: import
    upkeep, agent records and jobs.
  - No token can commit, dismiss or discard an import, change source facts or settings, or manage
    tokens. A request with a token ignores any cookie.
  - Every use, refused ones included, is logged in the work area.
- **Audit log.** Every change, sign-in and refused request, with who and from where (see "Audit
  log" above).
- **Claude CLI extraction** runs with `--tools Read`, `--restricted` (file tools confined to the
  working directory), `--safe-mode` (no hooks, plugins, MCP or CLAUDE.md),
  `--no-session-persistence`, and non-essential traffic disabled, in a scratch directory holding
  only that document. Its streamed events go to the session's transcript in the work area (see
  "Agent sessions"), with the document's bytes left out.
- **Receipts** (`src/server/receipts.ts`) are read by Claude only when Settings → Import &
  extraction → "Read receipts with the agent" is on (off by default). They run the same way: `Read`
  only, in a scratch directory holding just the receipt. The prompt carries the payment's amount,
  date and payee, and your category names. What comes back is a proposal of split lines.
- **Agent jobs** run the same way, with the tools their privacy class allows:
  - research gets WebSearch and WebFetch, with a prompt built only from public identifiers;
  - analysis gets Read of a digest in its scratch directory, or no tools.
