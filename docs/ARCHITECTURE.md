# Architecture

```
Browser (React SPA, TanStack Query)
   │  JSON over HTTP · server-sent events for live updates
   ▼
Hono server  (Node 24, tsx; 127.0.0.1:4750 live, 4760 in development)
   ├─ security: Host allow-list · CSRF (custom header + Origin) · auth gate · CSP
   ├─ routes/   auth · data (CRUD) · imports · analytics · system (SSE, git)
   ├─ Store ─────────────────► data/*.json(l)  (atomic writes, validation, quarantine, file watcher)
   │    └─ 'change' events ──► GitCommitter ──► git commit -- data/   (debounced, pathspec-limited)
   ├─ ImportService (queue) ─► work area .work/<data-dir>/   (uploads + drafts, never committed)
   │    ├─ detect → csv profiles · ofx · qif · santander-txt   (deterministic, local)
   │    ├─ images: capture date (EXIF/filename/mtime), tiling of long screenshots
   │    ├─ engines: claude-cli · claude-api · ocr (tesseract/pdftotext)
   │    ├─ normalise → buildDraft (match accounts, categorise, dedup, transfers)
   │    └─ commitDraft → Store (+ document archived, import record written)
   ├─ InboxWatcher: inbox/ → ImportService
   └─ Analytics (cached per store version)
        BalanceEngine · estate · cashflow · spending · recurring · projections
        allowances · selfassessment · investments · monthly · health (+FSCS)
```

Source layout:

| Path | What lives there |
|---|---|
| `src/shared/` | Isomorphic code: schemas (`schema.ts`), money, dates, UK rules, account-type metadata, categories, merchants, categoriser, reconciliation, API types |
| `src/server/` | Store, git, auth, security, migrations, enrichment, routes, app composition |
| `src/server/ingest/` | Everything from bytes to committed records |
| `src/server/analytics/` | Read-only computations over the store |
| `src/web/` | The React app: `pages/`, `components/` (UI kit, charts), `lib/` (API client, prefs, data context) |
| `scripts/` | Demo data, import CLI, validate, schema export, screenshots, set-password |
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
2. **Capture date.** Screenshots get a capture date from EXIF/XMP, then the file name, then the
   file's modified time.
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
     (an account you dropped the file onto wins).
   - Each row is categorised: your rules, then own-account transfers, then wrapper flows, then the
     UK merchant list, then the bank's category, then Claude's suggestion.
   - Duplicates are found by bank id, then exact multiset match, then fuzzy match.
   - Opposite-amount rows in your other accounts are proposed as the other leg of a transfer.
   - The balance date and its provenance are resolved.
   - Tax figures (P60, interest certificates…) are matched to accounts and deduplicated.
5. **Review.** The UI edits the draft; reconciliation runs live in the browser.
6. **Commit.** `commitDraft` creates accounts and institutions, assigns stable ids (content hash
   plus occurrence), links transfers on both legs, writes balances, holdings and figures, archives
   the document and writes the import record. The result is a single git commit.

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
  Investments & pensions, Tax year (Allowances, Self Assessment prep), Import (+ Review),
  Settings, Login.

## Security model

- **Network.** The server binds to `127.0.0.1`. Caddy fronts it on the tailnet (see DEPLOY.md). A
  non-loopback `HOST` refuses to start without a login.
- **Host guard.** Unknown `Host` headers get a 421 (DNS rebinding).
- **CSRF.** Mutating `/api` calls require the `x-finance-csrf: 1` header, and `Origin` must match
  `Host`. The session cookie is `SameSite=Strict`.
- **Auth.**
  - The password is a scrypt hash in `.env`.
  - The session cookie is an HMAC-signed `v1.user.expiry.sig`, keyed by a secret plus a
    password-hash epoch (changing the password logs everyone out).
  - Logins are throttled at 10 failures per client and 50 in total per 15 minutes.
  - Client IP and `https` are trusted from `X-Forwarded-*` only when the peer is loopback (Caddy).
- **Claude CLI extraction** runs with `--tools Read`, `--safe-mode` (no hooks, plugins, MCP or
  CLAUDE.md), `--no-session-persistence`, and non-essential traffic disabled, in a scratch
  directory holding only that document.
