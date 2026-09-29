# Architecture

```
Browser (React SPA, TanStack Query)
   │  JSON over HTTP · server-sent events for live updates
   ▼
Hono server  (Node 24, tsx; 127.0.0.1:4750 live, 4760 in development)
   ├─ security: Host allow-list · CSRF (custom header + Origin) · auth gate · CSP
   ├─ routes/   auth · data (CRUD) · imports · analytics · records · jobs · system (SSE, git)
   ├─ Store ─────────────────► data/*.json(l)  (atomic writes, validation, quarantine, file watcher)
   │    └─ 'change' events ──► GitCommitter ──► git commit -- data/   (debounced, pathspec-limited, main only)
   ├─ records.ts: the validated write path for assumptions, research, insights, context, instruments,
   │    the capture list
   │    (in-app jobs · POST /api/records · npm run records)
   ├─ JobRunner (agents/) ───► claude CLI, locked down, one job at a time; state in the work area
   │    ├─ research-instrument · research-provider · refresh-assumptions   (web tools, public inputs)
   │    └─ insights-after-import · monthly-review · interpret-note          (the owner's data, no web)
   ├─ ImportService (queue) ─► work area .work/<data-dir>/   (uploads + drafts, never committed)
   │    ├─ detect → csv profiles · ofx · qif · santander-txt   (deterministic, local)
   │    ├─ images: capture date (EXIF/filename/mtime), tiling of long screenshots
   │    ├─ engines: claude-cli · claude-api · ocr (tesseract/pdftotext)
   │    ├─ normalise → buildDraft (match accounts, categorise, dedup, transfers)
   │    └─ commitDraft → Store (+ document archived, import record written)
   ├─ InboxWatcher: inbox/ → ImportService
   └─ Analytics (cached per store version)
        BalanceEngine · Coverage · estate · cashflow · spending (+ computed signals) · recurring
        params (per account and fund, from assumptions, research and statements) · model (pure
        projection, bands, retirement, fee drag) · projections · investments · allowances
        selfassessment · monthly · capture list · health (+coverage, FSCS)
```

Source layout:

| Path | What lives there |
|---|---|
| `src/shared/` | Isomorphic code: schemas (`schema.ts`), money, dates, UK rules, account-type metadata, categories, merchants, categoriser, reconciliation, API types |
| `src/server/` | Store, git, auth, security, migrations, enrichment, routes, app composition |
| `src/server/ingest/` | Everything from bytes to committed records |
| `src/server/analytics/` | Read-only computations over the store; `model.ts` is pure (no store access) |
| `src/server/agents/` | Agent jobs: the CLI runner, job kinds and prompts, the digest, the queue |
| `src/server/records.ts` | The validated write path for agent-maintained records |
| `src/web/` | The React app: `pages/`, `components/` (UI kit, charts), `lib/` (API client, prefs, data context) |
| `scripts/` | Demo data, import CLI, records CLI, validate, schema export, screenshots, set-password, deploy |
| `tests/` | Vitest suites + synthetic fixtures for every supported bank format |
| `deploy/` | systemd unit template, Caddy site block, installer |

## The layered data model

Every number can be traced back, and every derived value can be rebuilt without re-importing:

1. **Documents.** The original file under `data/documents/<yyyy>/<mm>/<sha12>-<name>`. It is
   content-addressed and immutable.
2. **Extractions.** `data/imports/<yyyy>/<import>.json` keeps the engine's full output (`raw`), the
   engine and prompt version, the reviewed draft, and the result. For deterministic parsers every
   source row is also kept verbatim on the transaction itself (`raw`).
3. **Records.** Transactions, balances, holdings and figures, with every source field the document
   offered: time, bank id, type, reference, merchant details, bank category, FX, fees, running
   balance, plus open-ended `attributes`.
4. **Enrichment.** `payee`, `category`, `transferGroup` and `counterpartyAccountId` are
   recomputable by `enrich()` (Settings → Rules → *Re-run on all history*). The owner's manual
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
  - It knows which days each account has data for, from import statement periods.
  - Averages, baselines and signals use covered time only, and every page can say what is missing.
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
- Each mutation emits a `change` event, which feeds git auto-commit and the browser's live-update
  stream.

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
   - PDF and images, via `claude-cli` (`claude -p --json-schema … --tools Read --safe-mode`, run in
     an empty scratch directory), `claude-api` (Messages API with structured outputs and
     server-side refusal fallback) or `ocr` (offline).
   - The output is normalised (money to pence precision, dates repaired) into an `Extraction`.
4. **Build the draft.**
   - Each extracted account is matched to one of yours by last 4 digits, provider, type and name
     (an account you dropped the file onto wins). A scrolled screen that names no account takes
     the one a screenshot taken and uploaded with it shows, when nothing on it disagrees.
   - Each row is categorised: your rules, then own-account transfers, then wrapper flows, then the
     UK merchant list, then the bank's category, then Claude's suggestion.
   - Duplicates are found by bank id, then exact multiset match, then fuzzy match.
   - Opposite-amount rows in your other accounts are proposed as the other leg of a transfer.
   - Investment app screens are read as the part of the account they show: an activity list's
     running balance is its cash, a fund's own page is one holding (INGESTION.md).
   - The balance date and its provenance are resolved.
   - Tax figures (P60, interest certificates…) are matched to accounts and deduplicated.
5. **Review.** The UI edits the draft; reconciliation runs live in the browser.
6. **Commit.** `commitDraft` builds and validates everything first, then writes.
   - It creates accounts and institutions.
   - It assigns stable ids: a content hash plus occurrence, including the import id, so retrying
     a failed commit adds nothing twice.
   - It links transfers on both legs, and writes balances, holdings and figures. Holdings of one
     account and day, from several screens, merge into one snapshot.
   - It archives the document and writes the import record, including the account each section
     went to, which gives coverage.
   - The result is a single git commit.

   Pending rows are shown but not recorded unless you include them: the settled row arrives with
   the next statement.

"Commit all ready" commits only drafts with:

- every account matched to an existing one;
- no possible duplicates;
- a known balance date;
- reconciling balances;
- extraction confidence that isn't low (not offline OCR).

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
- **Gaps** are consecutive strong anchors that transactions don't explain, usually a missing
  statement. They are surfaced in Data health.

The estate value on a date is the sum of included accounts, converted to GBP (manual FX rates).
Groups are assigned by the sign of the balance, so an overdrawn current account counts as a debt
and a card in credit counts as cash.

## Web app

- React 19, React Router, TanStack Query with `keepPreviousData` (refetches never flash
  skeletons), and Tailwind v4 with CSS-variable tokens for light and dark.
- Live updates come over server-sent events (`/api/events`): a `data` event invalidates queries,
  and an `import` event refreshes the import queue.
- Charts are hand-built SVG on `d3-scale`/`d3-shape`, following the validated data-viz palette:
  - fixed categorical order;
  - 2px lines and rounded bar ends;
  - crosshair tooltips with keyboard support;
  - a table view on every chart;
  - privacy blur on all amounts.
- Pages: Overview, Accounts (+ detail), Transactions (virtualised), Spending, Projections,
  Investments & pensions, Tax year (Allowances, Self Assessment prep), Assumptions & research,
  Import (+ Review), Settings, Login.

## Security model

- **Network.** The server binds to `127.0.0.1`. Caddy fronts it on the tailnet (see DEPLOY.md). A
  non-loopback `HOST` refuses to start without a login.
- **Host guard.** Unknown `Host` headers get a 421 (DNS rebinding).
- **CSRF.** Mutating `/api` calls require the `x-finance-csrf: 1` header, and `Origin` must match
  `Host`. The session cookie is `SameSite=Strict`.
- **Auth.** One user (`FINANCE_USERNAME`), signed in one of two ways; a server uses exactly one.
  - **jemedia-auth** (`src/server/oidc.ts`, when `FINANCE_OIDC_CLIENT_ID` is set; the live site):
    - authorization code flow with PKCE (S256), state and nonce, through `openid-client`;
    - the ES256 ID token is checked against the provider's JWKS (issuer, audience, expiry, nonce);
    - who may reach the client at all is jemedia-auth's tenant membership; the app then admits only
      a verified address on `FINANCE_OIDC_ALLOWED_EMAILS`, as `FINANCE_USERNAME`;
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
    the password hash, or the jemedia-auth issuer, client and allowed addresses. Changing either,
    or switching method, signs everyone out.
  - Client IP and `https` are trusted from `X-Forwarded-*` only when the peer is loopback (Caddy).
- **Claude CLI extraction** runs with `--tools Read`, `--restricted` (file tools confined to the
  working directory), `--safe-mode` (no hooks, plugins, MCP or CLAUDE.md),
  `--no-session-persistence`, and non-essential traffic disabled, in a scratch directory holding
  only that document.
- **Agent jobs** run the same way, with the tools their privacy class allows:
  - research gets WebSearch and WebFetch, with a prompt built only from public identifiers;
  - analysis gets Read of a digest in its scratch directory, or no tools.
