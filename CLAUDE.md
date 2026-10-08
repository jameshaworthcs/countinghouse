# CLAUDE.md: Counting House (operating contract)

A private, local-first UK personal-finance tracker: a Hono + React app over a git-versioned data
directory. This repository is the code, and it is public: real data lives in a private **data
repository** of its own (`npm run init-data`; [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), "The
layout"), never here. Read this file, then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map
and [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md) before touching data or schemas.

## Commands

- `npm run check`: typecheck (server + web), ESLint, Vitest. Must be green before you call
  anything done.
- `npm run dev`: demo data, API on :4760 (tsx watch), UI on :4761 (Vite, proxies `/api`). Point
  it elsewhere with `FINANCE_DATA_DIR`; data tracked in git (the real `data/`) needs a login.
- Visual check of every page (light, dark and mobile), starting with the sign-in:
  - It fails on any console error, or if signing in bounces back to the form.
  - Look at the PNGs in `screens/`, don't just count them.
  - Run the demo with a throwaway login, so the sign-in is exercised:
    ```bash
    npm run demo:reset && npm run build
    export SCREENS_USER=demo SCREENS_PASSWORD=demo-password-1
    FINANCE_USERNAME=$SCREENS_USER FINANCE_PASSWORD_HASH="$(FINANCE_NEW_PASSWORD=$SCREENS_PASSWORD npm run -s set-password -- --print-hash)" \
      FINANCE_DATA_DIR=demo-data PORT=4770 npm run serve &
    npm run screens -- --base http://127.0.0.1:4770
    ```
  - When a change touches what a page shows with little data, repeat it on one month of data:
    `npm run demo:sparse`, serve `FINANCE_DATA_DIR=demo-sparse` on another port, and pass
    `--out <dir>` to `npm run screens`.
- **A live site runs from its own worktree**, at the commit last deployed (`finance.service`; see
  [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)).
  - Nothing here reaches it until `npm run deploy` (main by default; it rolls back on failure).
    `npm run deploy -- --status` shows what is live.
  - While it reads and writes this checkout's `data/`, keep this checkout on `main`: data
    auto-commits are held while it is on another branch.
  - Commit code with explicit paths, never `git add -A`, so a pending data change is not swept
    into a code commit.
  - A live site signs in through OIDC or a password; its settings are in the live worktree's
    `.env`, never this checkout's.
    - The screenshot run and the demo use a throwaway password login instead (no OIDC client set).
- `npm run validate`: format check of the data directory (`FINANCE_DATA_DIR`).
- `npm run init-data -- <dir>`: a new private data repository (no remote; pushes refused).
- `npm run fixture:anonymise -- <file>`: a document a real import failed on, as a synthetic
  fixture (checked by the leak guard).
- `npm run -s api -- GET /imports` (any method and path): the live API with an agent token the owner
  made in Settings → Agent access, kept in `~/.config/finance/token`. Tokens can read, and change
  only what their scopes allow (import upkeep, agent records, jobs); never commit
  ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), "Agent access").
- `npm run records -- keys | status | check <batch.json> | write <batch.json>`: the validated
  write path for assumptions, research, insights and instruments
  ([docs/AGENTS.md](docs/AGENTS.md)). Research and assumptions go through this, never by hand
  edits of `data/`.

## Invariants: do not change without asking the owner

- **The data is the product.** Never delete or rewrite files in `data/` by hand to "clean up".
  Changes go through the app or a migration. Git history in `data/` is the audit log; never
  rewrite it (no rebase, amend or force-push of data commits).
- **Money** is a JSON number in pounds with ≤ 2 dp, signed from the owner's point of view (money
  in and assets positive; money out and debts negative). All arithmetic goes through
  `src/shared/money.ts` (integer pence). Dates are `YYYY-MM-DD` strings; never `new Date(isoDate)`
  for calendar maths (use `src/shared/dates.ts`).
- **Source facts are immutable.** `description`, `raw` and the other source fields on a
  transaction are what the document said. Enrichment (`payee`, `category`, `transferGroup`…) is
  recomputable, except where `categorisedBy === "user"`, which is never overwritten.
- **Format changes need a migration.** When you change a persisted schema in a way old files
  don't satisfy: bump `FORMAT_VERSION` in `src/server/store.ts`, add a migration in
  `src/server/migrations.ts`, update `docs/DATA_FORMAT.md`, and run `npm run schemas`. Additive
  optional fields don't need one. Never require re-importing documents; backfill from `raw` or the
  stored extraction instead.
- **Review before commit.** Imports are drafts until the owner commits them. Don't add paths that
  write extracted data straight to `data/`.
- **Privacy.**
  - Nothing may call third-party services except Claude, the engine the owner chose (CLI or API),
    for extraction and agent jobs, and the identity provider the owner configures for sign-in
    (OIDC). Only the OIDC protocol goes there, never financial data.
  - The local model service (`inference`, `INFERENCE_BASE_URL`, on a machine of the owner's,
    reached over their private network) is not a third party: personal data may go to it, and nothing sent to it
    leaves the machine. It has no web access or tools. Its key (`INFERENCE_API_KEY`) is in `.env`
    and is never logged. Which task runs where is `src/shared/tasks.ts` (Settings → Models); a
    task falls back from it to Claude only where the owner turned that on.
  - Research sends only public, non-personal queries: fund names, ISINs, provider product pages.
    No balances, transactions or personal details ever go into one.
    - Research jobs get the web tools and are built only from public identifiers.
    - Jobs that read personal data get no web tools.
  - No CDNs, analytics or fonts from the web.
  - Keep only the last 4 digits of any account or card number.
  - Never print `.env`, the password file or document contents into logs or commits.
- **Assumptions are data, not code.** Every modelling parameter (return, volatility, inflation,
  fee, interest rate, withdrawal rate, growth rate, State Pension…) is an assumption record in
  `data/`.
  - A record has a value, range, scope (global down to one fund), source, evidence, as-of date,
    rationale and who set it, with history.
  - Agents set them from research. The owner's records win, like `categorisedBy: "user"`.
  - Code keeps only fallbacks, and the UI labels them as fallbacks.
  - Never add a hard-coded modelling constant.
- **Computed vs inferred.** Estate value, balances, cash flow, allowances and tax positions are
  pure, deterministic equations, written down in `docs/FORMULAS.md` and tested hard.
  - Insights are inferred by Claude and stored as records with evidence, confidence, model,
    prompt version and date.
  - The UI never shows an inference as a computed figure.
  - Inference never changes source facts.
- **Security guards stay on:**
  - loopback bind;
  - Host allow-list (`FINANCE_ALLOWED_HOSTS`);
  - CSRF header + Origin check;
  - auth gate on `/api/*` (a session, or an agent token within its scopes);
  - CSP in production;
  - documents served by id, never by path.
- **UK rules are data.** Figures live in the dated tables in `src/shared/uk.ts` with sources in
  `docs/UK_RULES.md`. Update both together.
- **Self Assessment output always carries the "check everything yourself" disclaimer.**

## How to work here

- Tests live in `tests/`. Add a fixture and a test for any parser change (`tests/fixtures/*`).
  Synthetic data only: never commit real statements to `tests/`. A real import that fails becomes
  a fixture through `npm run fixture:anonymise`, never by copying its rows.
- Screenshots come from the demo data (`npm run screens` refuses real data); keep screenshots of
  real data out of every repository.
- Invented values only, in code, tests, fixtures, docs and commit messages: never copy a real
  name, reference, amount or descriptor from `data/`. The leak guard
  ([docs/LEAK_GUARD.md](docs/LEAK_GUARD.md)) blocks them before a write (Claude Code hook), a
  commit and a push; `npm run leak-guard -- --tree` checks the whole tree. Never `--no-verify`.
- Any change to a computed figure updates [docs/FORMULAS.md](docs/FORMULAS.md) and its tests:
  - property-based tests (fast-check) for money and the balance engine;
  - the Monte Carlo check for the projection model.
- Modelling values come from `AssumptionSet` and `analytics/params.ts` with their sources. A new
  parameter is a key in `src/shared/assumptions.ts`, with a labelled fallback.
- Agents follow [docs/AGENTS.md](docs/AGENTS.md).
  - A new job kind declares its privacy class: web tools with public inputs, or the owner's data
    with no web.
  - Bump a job's `promptVersion` whenever its prompt or output schema changes (an example's values
    swapped for other invented ones is not a change).
  - Only real data (tracked in git) starts jobs by itself: never the demo or a throwaway copy (they
    spend the owner's Claude plan).
- Charts follow the data-viz rules baked into `src/web/components/charts/`:
  - fixed categorical order (`SERIES`) that never cycles;
  - one axis;
  - a legend for 2+ series;
  - a table view on every chart;
  - status colours only for status.
- Keep docs describing the system as built. When you deviate from a doc, fix the doc in the same
  change and add a line to `docs/DECISIONS.md`.
- The app auto-commits `data/` only (pathspec-limited). Code commits are yours to make when asked.
- Your own operating notes (where your live site runs, how it signs in) belong in a gitignored
  `CLAUDE.local.md`, never in this file.
