# Decisions

Newest last. Each entry says what was decided, what else was considered, and why.

## 2026-09-28: Initial build

- **TypeScript end to end: Hono + React 19 + Vite + Tailwind v4, Zod shared.** This matches the
  stack of the owner's other projects (verifiedhandles uses Hono + Zod + Vitest + tsx). One
  language means one set of schemas for server, client and JSON Schema export. The server runs
  under `tsx` (no build step); the UI is built by Vite.
- **Files, not a database.** Data is JSON and JSONL in `data/` because the owner asked for the
  data to live in the repo in a machine-readable form, and text files diff and merge in git.
  - SQLite was rejected: its binary file can't be diffed or reviewed.
  - Everything is held in memory at start-up; the volumes are tiny.
- **Money in pounds (2 dp), not pence.** The data must be readable by people, `jq`, DuckDB and
  LLMs. A reader seeing `-450` for a £4.50 coffee is the more dangerous mistake. Code does all
  arithmetic in integer pence through `money.ts`.
- **Layered records (source facts, enrichment, provenance) with `raw` rows kept.** This meets the
  "future changes without re-ingesting" requirement:
  - derived fields are recomputable;
  - new source fields can be backfilled by migrations from `raw` or from the stored extraction;
  - documents are archived and can be re-read by a better engine.
- **Drafts and review before anything is written.** LLM extraction can be wrong, so trust comes
  from checking against the original side by side. Reconciliation (opening + transactions =
  closing) and duplicate flags make the check fast. "Commit all ready" covers clean drafts.
- **Extraction through the `claude` CLI by default.** There is no API key on this machine, but
  Claude Code is logged in. `claude -p --json-schema` gives schema-validated output using the
  existing subscription. It runs locked down: `--tools Read`, `--safe-mode`, no session
  persistence, and a scratch directory holding one file. The Messages API engine exists for when
  a key is added. OCR is the offline fallback. The default model is Opus: accuracy beats speed for
  financial figures.
- **Built-in UK merchant list, plus rules, plus bank categories, plus AI suggestions.** Most UK
  card spending is categorised with no AI and no training. The owner's corrections become rules
  in one click.
- **Estate value = net worth.** "Estate value" is the owner's term: everything held minus what is
  owed, including pensions and property. Student loans and DB/State Pension forecasts are
  excluded by default (a per-account toggle), because they don't behave like assets or debts you
  own.
- **Git auto-commit of `data/` only (pathspec-limited, debounced).** Every change becomes a commit,
  and the owner's code changes are never swept in. Original documents are committed by default
  because the owner wants everything in the repo; Settings can turn that off.
- **Login is username/password now, OIDC later.** Sessions are independent of how you logged in,
  so a jemedia-auth OIDC login can issue the same session cookie later (DEPLOY.md). No login
  configured means local-only access, so a mis-deployment fails closed.
- **Charts are hand-built SVG, not a charting library.** This was the way to meet the data-viz
  rules exactly:
  - a validated colour-blind-safe palette in fixed order;
  - 2px lines and 4px rounded bar ends;
  - crosshair tooltips with keyboard access;
  - a table view on every chart;
  - privacy blur.
  Recharts and ECharts would have fought several of those.
- **Projections are deliberately simple and explained.** They take average monthly income,
  spending and contributions for a chosen period, with real returns on investments only, shown
  next to history. Assumptions are shown on the page, and the return is editable in the profile.

## 2026-09-28: Hosting

- **The live site is tailnet-only, confirmed by the owner.** Its name resolves only to the host's
  tailnet addresses; Caddy binds only those addresses, and the app listens on loopback. This keeps
  a finance app off the public internet and off the host that serves public sites.
  - Login is password-based for now; OIDC can be added in-app later.
- **The login is generated, not chosen.** A random password is stored outside the repo (0600). Only
  its scrypt hash is in `.env`.

## 2026-09-28: Development separated from the live site

- **The live service runs from its own worktree, `~/dev/finance-live`, at a deployed commit.**
  - Until now the service ran from the development checkout itself: any `npm run build` replaced
    the live UI, a crash-restart picked up half-edited server code, and `npm run start` or
    `npm run demo` clashed with it on port 4750.
  - The owner suggested building into a separate directory or using a worktree of main. The
    worktree was chosen because it isolates the server code as well as the build, and a rollback
    is a checkout of the previous commit.
  - `npm run deploy` builds, restarts, checks `/api/health` for the new commit, and rolls back on
    failure.
- **The live worktree has no `data/`; the service keeps using the development checkout's.** A
  sparse checkout leaves `data/` out, and `FINANCE_DATA_DIR` points at `~/dev/finance/data`. Git
  resolves that directory to the main worktree, so auto-commits land on `main` as before.
- **Data auto-commits are held unless the data checkout is on `main`** (`FINANCE_DATA_BRANCH`).
  Committing onto a feature branch or a detached HEAD would scatter the audit log. The changes
  stay on disk, the reason shows in Settings, and the next change commits everything.
- **Real data needs a login even on loopback.** A server on a directory tracked in git refuses to
  start without one. P360 runs network-facing services as isolated local users; a login-free
  development server on real data would have let any of them read it.
- **Ports:** live 4750, development 4760 (Vite 4761), demo 4770.
- **A missing data directory in production is an error, not an empty start.**
  `FINANCE_INIT_DATA=1` creates one on purpose.

## 2026-09-28: Assumptions as data, computed vs inferred, research, intelligence throughout

The owner's direction for the rebuild before real statements arrive. It is recorded in CLAUDE.md
as invariants.

- **Assumptions are data, not code.** The trigger was one global `assumedRealReturn` (4%), a
  hard-coded 4% withdrawal rate, cash that never grew, and no fees or inflation.
  - Every modelling parameter becomes a record with scope, provenance and history. Agents set
    it from research; the owner's overrides win.
  - Code keeps only labelled fallbacks.
  - Uncertain parameters carry ranges, and projections show them.
- **Computed vs inferred.** Deterministic figures are equations in FORMULAS.md with tests.
  Claude's insights are records with evidence, confidence, model, prompt version and date,
  displayed as inferences and never mixed with computed figures.
- **Research accumulates.** Funds, providers and rates the owner holds are researched once,
  stored dated and sourced, and refreshed when stale. Historical statistics are stored apart
  from forward-looking assumptions, with the reasoning that links them.
- **Intelligence throughout.** No insights page; each page carries its own inferences and
  researched context. What the owner tells the app becomes structured context.
- **The privacy invariant now covers research.** It now reads: "Research sends only public,
  non-personal queries: fund names, ISINs, provider product pages. No balances, transactions or
  personal details ever go into one."
  - It is enforced by construction. Research jobs get the web tools, and their prompts are built
    only from public identifiers.
  - Jobs that read personal data (insights, reviews, interpreting notes) get no web tools, so
    they cannot send it anywhere but Claude.
