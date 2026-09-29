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
- **Login is username/password now, OIDC later** (superseded on 2026-09-29: see "Sign-in through
  jemedia-auth"). Sessions are independent of how you logged in,
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

## 2026-09-29: Data format v2, the modelling engine and agents

- **Assumptions are append-only records with scopes and layers.**
  - One file, `assumptions.jsonl`: a change appends a version, so the file is the audit trail as
    well as git.
  - Resolution is layers first (owner, then agent, then fallback), then specificity, then
    recency. That makes "your override wins" hold even against an agent's fund-level value; the
    alternative (specificity first) would let an agent's fund figure silently beat a global value
    the owner had set.
  - Keys, units, bounds, scopes and fallbacks are a registry in code. The values are data.
- **Facts and forecasts are kept apart.**
  - A fund's charge and make-up, a platform's fee schedule and an account's current rate are facts
    (statements and research).
  - Returns, volatility, inflation, growth and the withdrawal rate are forecasts: assumption
    records only.
  - Historical performance is research, never used as a forecast directly; an assumption cites the
    outlooks it rests on (`basedOn`).
- **Projections run per account, with ranges from moments, not Monte Carlo.**
  - Each account compounds at its median growth after charges. Cash earns its interest; spending
    and pay grow with their assumptions; results are shown in today's money.
  - The p10–p90 range comes from an exact recursion of the portfolio's first two moments, with
    uncertainty in the expected return integrated by Gauss–Hermite quadrature and a lognormal fit.
  - This was chosen over seeded Monte Carlo because it is deterministic, fast, and written down
    as equations. Monte Carlo stays in the tests as the oracle.
  - The uncertainty in the saving estimate grows linearly and is combined root-sum-square.
- **Coverage drives every average.**
  - Baselines use complete months where every account has data, else at least 28 jointly covered
    days (low confidence). An account counts from its opening or first data until it closes.
  - The minimum was 14 days until the one-month demo showed 23 days before payday reading as a
    £3,700 monthly loss: a baseline needs a month's cycle of pay and bills.
  - The alternative, dividing by calendar months, understated a 12-month projection threefold with
    four months of data.
- **Withdrawal-rate fallback is 3.5%, not 4%.** UK studies put a 30-year sustainable rate nearer
  3–3.5% than the US-derived "4% rule". It is a fallback, labelled as such, and agents and the
  owner replace it.
- **Agents are in-app jobs through the same locked-down claude CLI**, with two privacy classes:
  - research gets web tools and public identifiers only;
  - analysis gets the owner's data (a digest of computed figures with record ids) and no web tools.
  - Automatic starts are conservative: new funds and providers, at most three stale refreshes a
    day, assumptions at most weekly, insights after imports, a monthly review.
  - Plain-word notes become proposals that the owner confirms, following "review before commit".
- **Research ids are content hashes of canonical JSON.** Writing the same findings twice is a
  no-op, and an assumption can cite research from the same batch.
- **Pending rows are excluded by default** and never reconciled. They double-counted when the
  settled row arrived.
- **`isMoney` became an exact check.** The property tests found that an absolute tolerance
  rejected valid amounts above about £86 million.
- **The Self Assessment hint "£10,000 of interest means you must file" was removed.** Current
  gov.uk guidance on who must send a return no longer lists it.
- **Spending compares like for like.** "Last 3 months" became this month and the two before, and
  the previous period is the same stretch shifted by whole months (or a year for a tax year).
  A rolling 90 days held two rent payments in one window and three in the next, which showed as
  a 27% drop in spending on the demo data.
- **A subscription moved to another card stays one regular payment.** Runs of the same payee on
  different accounts join when one ends as the next begins; running at the same time, they stay
  separate.
- **Owner corrections keep what was read.** Correcting a transaction's date, amount or
  description records the previous value in `corrections`, and saving other fields no longer
  marks the payee as set by the owner.
- **Pages say what they do not know.** Checked against a one-month demo (`npm run demo:sparse`):
  - allowances say "at least" and "up to" when an account's data does not cover the tax year, and
    name the accounts;
  - the estate chart starts when the data does, and washes out the stretch before every account
    has data;
  - "vs last month" and "Where it went" compare only with periods that have data;
  - contributions to pensions are "not known yet" rather than £0;
  - "left over" shows only for months every account covers.
- **Review checks are shared code.** The review page and "Commit all ready" run the same checks
  (`shared/review.ts`): balances, printed totals, the statement period, future dates, card signs,
  unsure rows, repeated and pending rows. Warnings from reading the document are shown and hold an
  import back.
- **Agents do not repeat themselves.** A job that succeeded for the same subject within the research
  staleness window (90 days) is not started again by itself, even if it found nothing. Measured
  costs on the demo: refreshing assumptions took 7.7 minutes and 62 turns ($9.74 at API prices on
  Opus, high effort); researching one fund took 4.6 minutes ($1.56).
- **Extraction is measured, not assumed.** `npm run eval` runs 28 synthetic documents through
  the real pipeline and scores them field by field (`eval/`). The baseline on `extract-3` was
  99.7%; the failures it found drove `extract-4`:
  - prize lists paid to another account are not transactions;
  - a sharper balance-date rule;
  - relative dates flagged when the capture date is unknown;
  - unsure rows and printed totals (for the review checks);
  - foreign amounts signed like the payment, empty sections dropped, and being your only account
    of a type counted as matching evidence.
  - One case was corrected after the baseline. The Starling screenshot's "Today" could not be
    dated without a capture date, so its feed now shows dates.
- **Backups ride the host's encrypted nightly backup (the owner chose option A).** The host's
  backup script writes the finance repository as its own `age`-encrypted file into a replicated
  backup tree, verified by cloning it and kept for 14 days. No third party holds a copy, even
  encrypted, and the repository keeps no remote. A restore drill passed on 29 September 2026.
- **Sonnet reads, Opus checks, Opus analyses (the owner's choice).**
  - Settings: `extraction.model` is Sonnet, `extraction.verifyModel` Opus, `agents.model` Opus.
  - A reading is kept only when the document's own arithmetic confirms it. Otherwise Opus reads the
    document again, and the two readings are compared figure by figure. Disagreements are marked
    for review, and the stronger reading is kept.
  - On the evaluation set, all three configurations score 100%. Checking costs about the same as
    Opus alone there, because most of the set is screenshots; statements are mostly confirmed at
    Sonnet's cost. In an earlier run the check caught a real Sonnet error: a net-interest figure
    beside the gross one, which would have counted interest twice.
- **Tax figures are copied as printed; the app does the sums (`extract-5`).** A pension document's
  "you paid" and "tax relief" are separate figures, and the app adds them for the allowance.
  Asking the model to add them contradicted "never compute a value" and made it inconsistent.
  - Interest certificates give one gross figure.
  - A statement's interest is a transaction, not a figure.
  - The eval now costs a point for a figure the document does not state (a printed zero excepted),
    and the Nest and SIPP cases expect the figures they print.
- **Accounts are set up from what the owner knows, and learn the rest from statements.**
  - The credit report's account-number digits are kept in each account's notes, not as `last4`.
    They are agreement numbers, not the card numbers statements print, and a wrong `last4` vetoes
    a match.
  - The first statement committed into an account teaches it its `last4`.
  - Closed accounts take their old statements (they matched nothing before).
- **The Overview's changes compare only with a fully known estate.** The first real setup showed
  a "Past 30 days" gain of thousands of per cent: the approximate figures given that day counted as growth.
  A change is now shown only when every account with data had data on the earlier day, or had not
  opened yet (FORMULAS §9). The profile alert asks only for what is missing.
- **A first snapshot reads as one.** Seen on the live site after the setup from `tmp.json`:
  - This month's spending is unknown, not £0, until some day of the month has data for every
    account. Its change compares the same days of both months, where both have data.
  - The estate chart draws a history only from two days on which every account has data.
  - The headline says how much of the estate is estimated.
  - Paid in and growth count only what is known. A value whose paid in is unknown is not growth,
    and contributions summed from a few months of statements are not everything paid in.
  - The analyst is told which figures are estimates, and that a null is not zero
    (`insights-after-import-2`, `monthly-review-2`).
- **Only real data starts agent jobs by itself.** A throwaway data directory made for a visual
  check ran `refresh-assumptions` on the owner's plan: the demo turns agents off in its settings,
  but other copies did not. Jobs now start on their own only when the data is tracked in git, the
  same signal that decides a login is needed.
- **The tax band is worked out, not set.** It comes from the year's income in the data (FORMULAS
  §11):
  - P60 and payslip pay, else your salary or last year's P60 for the year in progress;
  - side income, interest and dividends;
  - relief-at-source pensions and Gift Aid widen the bands.
  The band carries its basis (from documents, estimated, or a minimum), and every page that shows
  it says which. `profile.taxBand` is no longer read; old files keep it until the profile is next
  saved, which drops it (an optional field, so no migration).
- **A capture list for the first big import** (`data/capture.json`, written through `records.ts`).
  - Each ask ticks itself off from the data where it can (statement coverage, a real valuation, a
    tax figure); otherwise the owner ticks it.
  - It sits above the monthly checklist on the Import page.
  - While items remain, its Overview alert replaces the monthly one, which would name the same
    accounts.
- **Investment app screenshots are read as the parts of an account they are (`extract-6`).** The
  first real import of a batch of LISA screenshots read each activity list's cash balance as the
  LISA's value (a few pounds instead of the whole value), proposed a new account for every fund's own page and for scrolled
  screens, and would have let each partial holdings list replace the others. Now:
  - the reader says what a running balance tracks; the draft treats an investment account's
    running balance as cash when the reader or the evidence says so;
  - a fund's page is a holding, matched to the account that holds the fund; a screen naming only
    the provider goes to your only account there; a screen naming nothing waits for you to choose;
  - holdings of one account and day merge;
  - running balances are checked newest first as well as oldest first.
  Being your only LISA stays a suggestion, not a match: the screens that need it name the account
  in their selector or the provider in a charge row.
- **A number ending in letters has no last four digits.** "QK7WM3P" was being stored as "73" and
  would have taught the account a wrong number.
- **Payslips are pay so far; a P60 is the year.** Figures record where they came from (the import's
  document type), and pay is taken employer by employer: the P60, else the payslips added up, never
  both. Salary received from an employer with no figures still counts, after tax, as a floor.
  Payslips gave the same amount two months running, so a figure is a duplicate only for the same
  period too. Capture-list checks can ask for a P60 specifically.
- **Fund names cut short on screen match the full name**, and an instrument takes the full name when
  one arrives. Holdings keep what their documents printed.
- **A fact read from a document with nothing to import** (an email about pay not received) is a
  context record with `origin.kind: "document"`, not an import that can never be committed.

## 2026-09-29: Sign-in through jemedia-auth

- **jemedia-auth replaces the password on the live site, at the owner's request.**
  - An OIDC client in its own jemedia-auth tenant, whose only member is the owner. Membership is
    what jemedia-auth checks before it will sign anyone in to the client.
  - The app checks again: only the owner's email address, verified, gets in, and it maps to the existing
    user `james`, so nothing keyed on the user changes.
  - A signed-out visit goes straight to jemedia-auth. Password sign-in is refused while OIDC is
    configured, with no break-glass: a password beside SSO is a second way in to guard. If
    jemedia-auth is down, the way back is to unset `FINANCE_OIDC_CLIENT_ID` and set a password
    in the live `.env`.
  - The demo and the screenshot run keep the password login, since they have no client.
- **The site stays tailnet-only.** Only the browser visits `auth.jemedia.xyz`; the callback comes
  back to the tailnet name. The server's own calls to the provider (discovery, token exchange,
  signing keys) are outbound HTTPS from P360.
- **jemedia-auth is the one other service the server may call.** The privacy invariant in
  CLAUDE.md now names it next to Claude. Only the OIDC protocol goes there, never financial data.
- **The session cookie stays `SameSite=Strict`.** The callback ends a navigation that started on
  another site, so it returns a page that moves on by meta refresh (the CSP allows no inline
  script) rather than a redirect, and the cookie is sent with the next request.
- **Signing out of Finance does not sign you out of jemedia-auth.** That would end every JEMEDIA
  session. The sign-in page then waits for a click instead of going straight back.
- **`openid-client` (v6, with `jose`) does the protocol,** as in verifiedhandles, rather than
  hand-written JWT checks.
- **Background agent jobs have a budget** ($5 a day, $40 a month by default, in Settings). The first
  big import found many new funds and queued all their research at once, about $22 in a morning; the
  three-a-day cap only covered stale research. Jobs the app starts wait for the budget; yours do not.
- **Holdings exports are read as holdings.** interactive investor's portfolio CSV failed as "no date
  column": it is a list of holdings, not transactions. It now gives one holdings snapshot (SEDOL or
  ticker, pence or pounds), and several byte-order marks before the header no longer hide it.
- **A statement's balance is at the end of its period.** Chase card statements print a "statement
  date" the day after the period; read as the balance date, it made false balance gaps (the
  next period's first day counted twice).
- **An import is not empty because it added no transactions.** The analyst saw only transaction
  counts and called value screenshots and payslips "files that added nothing"
  (`insights-after-import-3`).
- **Research runs only when the owner asks.** After the first import queued research for many funds
  at once, the owner chose to start research by hand; "Research by itself" (off by default) brings
  back the automatic behaviour, within the budget.

## 2026-09-29: Screenshots from a phone

Six NS&I screenshots taken a minute apart and uploaded together went wrong four ways: the balance
dated at the last prize, a prize history read as "paid out to another account", bond numbers read
as holdings, and five views that added nothing looking like failures.

- **An app screen's balance is dated when it was taken, not at its latest row.** The latest-row
  rule is right for a statement (its closing balance follows its last row) and stays there. On an
  app the headline is what the account held when you looked, which for a market account, or any
  account whose list is not every movement, can differ from the day of its last row.
  - A photo or screenshot of a statement is a statement: the reader's document type decides, not
    the file type.
  - With nothing to say when it was taken, it is dated on the upload day and flagged, instead of
    at its latest row labelled "from the document": that was a guess presented as a fact.
  - A settled row later than the capture date keeps the capture date and marks the row. The
    alternative, trusting the row, would let one misread date move the balance.
- **The reader's misleading example is gone, not patched.** `extract-8`'s rule "a list of prizes
  paid out to another account (Premium Bond prizes paid to a bank account, say)" came from an eval
  screen that said so; readers then said it of screens that did not. `extract-9` replaces it with
  what such lists are (views that repeat the movements or concern money elsewhere, rarely saying
  which), says notes state only what the document shows, and says what holdings are. An interest or
  dividend history on its own now records nothing: the account's transactions are where movements
  come from, and the history rarely says whether the money stayed in the account.
- **Finding nothing is a reading that gets checked.** A reading with no accounts and no figures
  passed as "confirmed by its own figures" on Sonnet alone; it now needs a second reader to agree,
  since what it finds nothing in can be dismissed in one click.
- **Screenshots taken together lend each other their account, conservatively.** "Together" is
  uploaded within 2 minutes, taken within 10, same screen width (and device, when named): no upload
  batch id was added, because the times already say it and they work for the inbox and for files
  uploaded before this change. The nearest identified screenshots before and after must agree, a
  borrowed account is never lent on, and anything on the screen that disagrees wins. The owner's
  saved edits are never redrafted.
- **"Nothing new" is worked out, not stored, and dismissing it keeps the document.** Whether an
  import adds anything depends on what else is committed or waiting, so it is recomputed each time
  the list is shown rather than saved on the draft. Dismissing archives the document and writes an
  import record with zero counts and the reason, rather than deleting the file:
  - the document is the bottom layer of the data model: a prize history holds prizes recorded
    nowhere else, and a better reader can return to it;
  - the account it was about lists it, and uploading it again is recognised;
  - it costs a few hundred kilobytes in `data/`, once. *Discard* remains for files you do not want
    kept.
  Considered and rejected: a new import status for dismissed files (every reader of `committed`
  would need to learn it), and letting "Commit all ready" commit them (it would record the same
  balance twice).

## 2026-09-29: Premium Bonds screens, and rows recorded twice

Four scrolled screenshots of the NS&I Transactions tab showed no provider, name or number. Each
proposed a new account, `premium-bonds-2`. Committed, it would have had no balance, so its rows
would have added the whole holding to the estate a second time.

- **A Premium Bonds screen is your Premium Bonds (the owner's choice).** NS&I allows one holding
  per person, so being your only Premium Bonds decides it, unless the screen shows another number,
  provider or name. Being your only LISA stays a suggestion: people can hold several.
- **A screen that shows only the kind of account never proposes a new account while you have one
  of that kind.** The reader had named the kind, so the screen counted as identified, and a new
  account was proposed while the reason named the existing one. It now asks which, and offers your
  only one in one click.
- **Rows are checked again at commit.** The last row of one scrolled screen was the first of the
  next. Each draft had been checked only against what was stored when it was made, so committing
  both would have recorded that row twice.
  - Exact repeats are now left out, with a note.
  - Rows that only look the same wait for the owner.
  - Considered: checking waiting drafts against each other. Rejected: the check at commit also
    covers a section given its account by hand, and the set of waiting drafts changes under the
    review page.
- **"Auto prize reinvestment" is a Premium Bonds prize** (other income, from the built-in list).
  The reader's guess had filed one screen's prizes as savings interest.

## 2026-09-29: Agent access to the live API

The owner asked for agents to do API tasks without them: re-reading six pending NS&I imports had
needed a `fetch` loop pasted into the signed-in browser console.

- **Tokens the owner makes in Settings, not a jemedia-auth machine client (the owner's choice).**
  - A client-credentials client would need admin setup at jemedia-auth, and support there, for one
    user.
  - App tokens are small and local, and are revoked in one click.
- **Only a hash is kept, outside `data/` and git.**
  - A token is `fin_<id>_<secret>`. The secret is 32 random bytes, and the work area keeps its
    SHA-256.
  - A plain hash is enough for a random 256-bit secret. A password-style slow hash would only slow
    every request.
- **Read everything; change only what a scope lists; never commit (the owner's choice).**
  - Scopes: import upkeep (read again, draft again, choose an account, edit a draft), agent records,
    and jobs.
  - The routes are an explicit list, so a new route is closed to tokens until it is added.
  - Committing, dismissing, discarding, uploading, source facts, accounts, settings and token
    management stay with the owner.
  - A new token has read and import upkeep ticked. Records and jobs must be ticked on purpose.
  - A job an agent starts waits for the background budget, and is refused while agents are off,
    because agent work stays off unless the owner turns it on.
- **Reachable from P360 and the tailnet (the owner's choice).** The helper defaults to the loopback
  service. Caddy passes tokens from other tailnet devices.
- **The CSRF header is still required with a token.** A token is not a cookie, so CSRF cannot
  forge it, but keeping one rule for every change is simpler to reason about. The helper sends the
  header.
- **A request with a token is judged by it alone.** A session cookie sent alongside counts for
  nothing, so an agent's request is never mistaken for the owner's.
- **Every use is logged, refused ones too**, in the work area, and Settings shows the latest 30.

## 2026-09-29: Budgets

- **Monthly, with no rollover (the owner's choice).** Unspent money does not carry into the next
  month. A budget covers all spending, a group, or one category.
- **The pace is measured against your usual month, not the calendar.** Rent on the 1st makes a
  straight-line pace read as a month's bills gone in a day. So "on pace to go over" compares the
  spending so far with the share usually spent by that day, from past complete months. With fewer
  than two such months it falls back to the share of days gone. Nothing is judged before a quarter
  of the usual month's spending would be done.
- **Only data for every account counts towards the pace.** Spending after the last day that every
  account covers may be incomplete. The page says so, as the Overview's "spent this month" does.
- **Refunds stay in their own category.** A refund is not taken off the budget of what was refunded:
  nothing links the two, and a guess would move figures that are computed.
- **Suggestions are the median of recent complete months, rounded up.** The median resists one
  unusual month, and rounding up gives a starting point, not a target.

