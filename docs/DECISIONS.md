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
  the owner's identity provider"). Sessions are independent of how you logged in,
  so an OIDC login can issue the same session cookie later (SELF_HOSTING.md). No login
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
  start without one. The host runs network-facing services as isolated local users; a login-free
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

## 2026-09-29: Sign-in through the owner's identity provider

- **OIDC replaces the password on the live site, at the owner's request.**
  - An OIDC client at the owner's own identity provider, in a tenant whose only member is the
    owner. Membership is what the provider checks before it will sign anyone in to the client.
  - The app checks again: only the owner's email address, verified, gets in, and it maps to the existing
    user `james`, so nothing keyed on the user changes.
  - A signed-out visit goes straight to the provider. Password sign-in is refused while OIDC is
    configured, with no break-glass: a password beside SSO is a second way in to guard. If
    the provider is down, the way back is to unset `FINANCE_OIDC_CLIENT_ID` and set a password
    in the live `.env`.
  - The demo and the screenshot run keep the password login, since they have no client.
- **The site stays tailnet-only.** Only the browser visits the provider; the callback comes
  back to the tailnet name. The server's own calls to the provider (discovery, token exchange,
  signing keys) are outbound HTTPS from the host.
- **The identity provider is the one other service the server may call.** The privacy invariant in
  CLAUDE.md now names it next to Claude. Only the OIDC protocol goes there, never financial data.
- **The session cookie stays `SameSite=Strict`.** The callback ends a navigation that started on
  another site, so it returns a page that moves on by meta refresh (the CSP allows no inline
  script) rather than a redirect, and the cookie is sent with the next request.
- **Signing out of Finance does not sign you out of the provider.** That would end every session
  there. The sign-in page then waits for a click instead of going straight back.
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

- **Tokens the owner makes in Settings, not a machine client at the identity provider (the owner's
  choice).**
  - A client-credentials client would need admin setup at the provider, and support there, for one
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
- **Reachable from the host and the tailnet (the owner's choice).** The helper defaults to the loopback
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

## 2026-09-29: Goals

- **A goal names its accounts, and each grows at its own rate.** Each account runs through the same
  moment recursion as Projections, with its own return, charges or interest, and the money its
  recent pace brings in. That money is a wrapper's contributions, bonus and relief, or a cash
  account's net deposits. The estate projection has one cash pot, which cannot say when a named
  savings account reaches an amount.
- **The accounts' spreads are added, as if they moved together.** This errs wide. A correlation
  model for two or three accounts would promise precision the inputs do not have.
- **Pounds of the day, not today's money.** A deposit target is what the owner needs when they
  buy. Projections keeps its choice of units.
- **A LISA counts at 75% unless the goal is a qualifying first home.** A qualifying home is within
  the £450,000 cap, with the LISA a year old by the date, or the owner is 60. Counting the charge
  up front stops an emergency fund in a LISA from looking bigger than it is.
- **An emergency fund follows your spending.** Its target is months × the recent baseline's
  spending, so it stays true as spending changes. Until spending is known it has no amount.

## 2026-09-29: Pay from payslips

- **From what is read today; net pay from the bank (the owner's choice).** A net-pay figure on the
  payslip would need a new reader version, and an eval run to check it. The owner chose not to spend
  on that. The payment into the bank is the stronger evidence of what arrived anyway. Where the two
  differ by more than £1, the difference shows as other deductions.
- **A payment is matched to a payslip by the employer's name and date, not by amount.** The name
  comes from the payee and description, reduced as for the tax band. The date is within 10 days of
  the period's end or the pay date. Matching on amount alone would take one employer's pay for
  another's.
- **Pay not seen says whether the bank data could have shown it.** The first real payslips had one
  month whose pay was not in the statements. That was because the statements stopped before the
  pay date, not because the pay was missing.

## 2026-09-29: Tidy merchant addresses

- **Fixed rules, not a model.** The plan allowed a local model on the owner's machine, but that is a new engine
  under the privacy rules. A deterministic tidy handles the card exports seen so far: wrapped lines,
  capitals, quoted towns, stray phone numbers, and postcodes missing their space.
- **Enrichment beside the source, worked out again at every start.** `place` is a function of the
  merchant fields, which stay as printed. Recomputing it when the app starts is the "back-clean":
  the first start after this change tidied the stored history, as one data commit. Later rule
  changes reach history the same way, with no migration or re-import.
- **The UK is left out; other countries are kept.** Nearly every address is in the UK, so
  "United Kingdom of GB and NI" is noise; a foreign country is information.

## 2026-09-29: Split transactions and receipts

- **A split lives on the transaction, as yours, like a category you set.** Lines must add up to
  the payment when saved. Reports count the lines through one place, `categoryLines`, used by cash
  flow, spending, budgets and the baselines.
  - A correction to the amount that breaks the sum removes the split rather than leaving it
    inconsistent.
  - Lines short of the amount in a file edited by hand put the rest in the transaction's category.
    Invalid data should never quarantine a real payment.
- **Receipts are their own records, `receipts.jsonl`, not import records.** A receipt adds nothing
  to the ledger and has no draft to review. Keeping it out of the import pipeline keeps "Commit all
  ready", coverage and "nothing new" unaware of it. The file sits with the statements and is served
  by id, as documents are.
- **Reading receipts is built but off (the owner's instruction).** When on, a receipt is read as it
  is attached, in the same sandbox as extraction, with `Read` only. What Claude reads is a proposal
  of lines grouped by category, and nothing changes until the owner saves the split. A receipt
  whose total differs from the payment (a tip, cashback) leaves the difference in the payment's own
  category.

## 2026-09-29: Reading stored documents again

- **Compare, then apply by hand; never replace.** A new reading is not trusted over the old one
  just for being newer. Each difference is shown with both values, and applying one goes through
  the same correction trail an edit uses.
- **No deletions.** A row the new reading misses may be a row it failed to see. Removing it stays a
  deliberate edit on the transaction.
- **Rows from other imports count as the same row.** Overlapping statements record a row once. The
  new reading of either should not call the shared row new.
- **The reader was moved out of `process` into `readDocument`**, so an upload and a re-reading run
  the same engines, prompt and check. The re-reading pins the upload to the account the import went
  to.
- **Off by default (the owner's instruction), and never automatic.** The Import page lists what an
  earlier reader read, but only the owner starts a reading.

## 2026-09-29: Spreadsheet exports

- **SheetJS 0.20.3, from its own tarball.** The `xlsx` package on npm stopped at 0.18.5, which has
  published advisories. SheetJS now publishes to `cdn.sheetjs.com`. The lockfile pins the tarball
  by integrity hash. It is a build-time dependency: the app still calls nothing at runtime.
- **A spreadsheet is a table of rows for the CSV profiles, not a new importer.** Profiles,
  holdings detection, auto-mapping and saved mappings all apply unchanged. The engine is recorded
  as `csv`, with the reader version `xlsx-1+…` and the sheet's name in the detail.
- **Text cells stay text (`raw`).** SheetJS otherwise guesses dates in HTML tables in US order.
  One test caught "01/09/2026" read as 9 January. Real date cells are converted from their serial
  value, so they need no guessing.
- **The first sheet with a table.** Exports put a summary or notes sheet first surprisingly often.
  The review page names the sheet it read.


## 2026-09-30: Duplicates across sources, and an import that corrects the record

A Chase export recorded a card payment the August statement had already recorded. The export was
mapped automatically, and "Transaction Type" ("Transfer") was taken as the description because
it contains the word "transaction". "Transfer" looked nothing like the statement's "To Credit
Card", so the row counted as new, though both rows showed the same balance after it.

- **The balance after a payment identifies it.** Same date, amount and balance after it is a
  duplicate, whatever each source calls it. Chase names the same payment "To Credit Card" on its
  statement, "To Revolving Line Account" in its export, and "<name>'s Account to Credit card" in
  its app.
- **A different description no longer makes a payment new, from £20.** The same amount a few days
  apart is offered for you to check when the descriptions are similar, or, from £20, when it is
  the same day or the amount has pence. Below £20 everyday prices repeat: on a busy card, two
  £3.50 coffees at different cafés a day apart are two coffees, and flagging one leaves it out by
  default. Round sums on different days repeat too. Balances after them that differ always mean
  two payments.
- **Recorded twice needs two imports.** One document listing the same amount twice on a day, even
  with the same balance after both (a spend, its refund, the spend again), is two payments. Only
  copies from different imports are offered, and never when their balances differ.
- **Chase's words for paying its card are card payments.** "To Credit Card" and "To Revolving Line
  Account" are categorised as card payments, so the current account's side is a transfer by itself.
  Otherwise, from a CSV (which carries no suggested category), it counted as spending until the
  card's side was imported and linked.
- **The Chase layout names no account type.** Chase exports its current account, saver and card in
  one format, so a layout saying "current" would have put a card's export in the current account.
- **The description column comes before a type column.** Auto-mapping prefers a header naming the
  description over one naming the other party. It never takes a type column while another will
  do. Chase's export is a built-in layout now.
- **An import can take away a copy recorded twice.** Whatever duplicated a payment, the next
  document that shows the payment once can say so and remove the copy on commit. The copy removed
  is always one with nothing of yours on it. Removal waits for review like everything else, and
  comes ticked only when the balances prove it. The import records what it removed. This beats
  deleting the row by hand: the document is the evidence, and the import is the audit trail.

## 2026-09-30: Pay under another name

Payslips from one employer came under three names: a group name on the payslips, the employing
company on the P60, and a sister company's payroll in the bank. Matching by name paired none of
them, and counted the year's pay and tax twice, once from the P60 and once from the payslips.

- **A payment of exactly a payslip's pay after deductions is its pay**, whatever the bank calls
  the employer. A payment within 10 days of the pay date that matches to the penny is not a
  coincidence. Other payments from the same payer then belong to that employer.
- **The tax band uses the same pairing**, so pay the Pay tab gives an employer is never counted
  again as salary received from someone unknown.
- **A P60 is checked by its tax and NI, not its pay.** Its "pay in this employment" is taxable pay.
  Under a net pay arrangement that is the gross less the pension taken before tax, so every
  payslip being there still looked like some were missing.
- **The payer is the owner's to name on review.** No rule can know which companies belong to one group. One
  name per payer on the review page renames it on all of a document's figures, and a payslip under
  the P60's name counts as the same job.
- **A £0 payslip expects nothing.** It is kept (it says the job paid nothing that month) and shown
  as nothing due, not as a missing payment.

## 2026-09-30: Reading a CSV again

A Chase export was committed with the transaction type as its description. The file itself was
fine and was kept, and a built-in layout now reads it right. So "Read it again" applies to CSVs and
spreadsheets too.

- **Parsed on this machine, so no setting.** The switch for reading stored documents again is
  about spending the Claude plan. A CSV costs nothing and sends nothing.
- **The layout that fits now wins.** A layout you saved, or a built-in bank's, comes first; then the
  columns you chose by hand for that import; then columns worked out again. Reading it again with
  the same guess would change nothing.
- **Rows pair by their line in the file.** A parser's rows keep their places, so a row read with new
  columns is the same row whatever changed, even its whole description. Claude's readings pair by
  what the rows say, because a new reading can split or merge rows.
- **The same balance after it means the same row, from any import.** Otherwise a copy that was
  taken away as recorded twice would come back as "read now, not recorded", one click from being
  added again.
- **A correction refreshes what the old words decided**: the payee and category, unless you set
  them or a transfer link did, and a transfer link. The old description stays in `corrections`.

## 2026-09-30: An investment account's value before its first valuation

An interactive investor ISA export opened two years back, part-way through the account's life, with
cash in hand and funds already held. Before the account's first valuation the chart assumed it
started from nothing at the first payment in, so it showed a few thousand pounds climbing to the
valuation: growth that never happened.

- **The same test as "paid in".** Summed flows are everything that went in only when they go back
  to the start: a nil valuation before them, or an opening date within a month of the first. Only
  then does the value climb from them to the first valuation.
- **Otherwise it is rolled back as if nothing grew**: the first valuation less what arrived since,
  as within 45 days of it already. Growth is unknown there, and leaving it out is closer than
  inventing it. Setting the account's opening date says the data goes back to the start.
- **Never below nothing.** A transfer in followed by a fall would otherwise roll back to a
  negative asset.

## 2026-09-30: interactive investor's wording

- **A settlement date marks a trade.** ii writes "12 VANGUARD FTSE GLOB Del 105.20 S Date 03/02/25",
  with no "buy" or "sell". The settlement date is on trades only, so it wins over fund names: an
  income fund is not investment income when it is bought or sold.
- **"Div 250 …" is a dividend**, in the ISA and pension rules and in a general investment account's
  dividends for tax, which share `DIVIDEND_WORDING`.
- **The investment is the payee.** Both kinds of row name it, so the list shows "VANGUARD FTSE GLOB"
  rather than the whole line or "Div".
- **"Reg Contribution (E)" is an employer's.** ii marks a regular employer payment into a SIPP
  "(E)"; such a payment comes from the employer directly, not through a payslip. No tax relief follows
  such a payment, so counting it as the owner's own would have estimated 20% relief that never
  comes and widened the basic-rate band by it.
- **Rows already committed get it when the app starts**, like tidy addresses: only rows in
  investment and pension accounts that nothing categorised, and only a built-in category. Re-run
  on all history would reach them too, but it works out every row again, payees included.

## 2026-09-30: The estate chart draws what is known

The Overview's "Estate value over time" was empty in every range. A pension added the day before
with a single valuation made that day the first on which every account had data, and the chart
needed two such days. Years of history for every other account were hidden behind one account
worth a few per cent of the estate.

- **Two days with any data draw the chart.** Before every account has data, the stretch is marked
  partial as before, and the total line starts only where the estate is fully known. This revises
  "The estate chart draws a history only from two days on which every account has data" (see "A
  first snapshot reads as one" above).
- **A first snapshot still reads as one.** Figures all given on one day are one day with data, so
  the chart still says there is not enough history yet.
- **A group with nothing yet sits on the stack.** d3's diverging stack puts a zero at the axis, so
  a group before its first data ran along £0 and leapt up the stack where it started. A zero now
  sits on top of its side of the stack, and debts stay below the line.

## 2026-09-30: A card's own CSV export is read card style

An Aqua export uploaded to the Aqua card came in with every sign the wrong way round. No layout
knew its columns, so they were worked out automatically, and a worked-out amount column was always
read as money out negative. A card's own export lists purchases as positive. The card-signs check
warned, but the review page offered no way to change the signs: the column editor showed only
before anything was drafted, even though the warning said to save the mapping.

- **Aqua's layout is built in**, signs inverted like Amex's, with its Note column (what the
  statement shows) as the reference.
- **For a card, the rows pick the signs.** A file for a credit card (the account it was uploaded to,
  or the one a committed import went to when it is read again) reads its single amount column card
  style when its rows fail the card-signs check as they stand and pass it flipped. It is the same
  rule the review page checks, so the two cannot disagree. Debit and credit columns already say
  which way round they are. A note says the signs were read that way.
- **The columns worked out can be changed on the review page**, and saved for the next file like
  it. Changing them drafts the import again from the file and clears the warning about columns
  worked out automatically: the owner has now chosen them.

## 2026-09-30: A holdings export keeps what statements said about each fund

interactive investor's portfolio export for the ISA read every figure right, but committing it
would have made things worse. It has no asset classes, so the ISA's latest holdings would have
had none, and every fund would have fallen from "shares" (the PDF statement the day before) to
the "mixed" fallback: 6.3% expected return and 16% volatility from the owner's assumptions became
5.5% and 10% from fallbacks. Some of its ETFs had no instrument either, because instruments were
only recorded by the agents' background run, which is off.

- **The asset class comes from the latest statement that gave one.** When the latest holdings give
  a fund none, the model uses the latest holdings in any account that did, for the same fund (by
  instrument, else ISIN, SEDOL, ticker or name), and says which day's. The export's snapshot stays
  what the file said: nothing is copied into it. A class is a fact about the fund, and a later
  document that does not print one has not changed it.
- **Instruments are recorded at commit and at start-up, whether or not agents are on.** An
  instrument from a statement is a fact, not agent work; only researching it is. The agents'
  background run still records any it finds missing (holdings changed outside the app). The git
  log says "by the app" for these, not "by agent", which read as an agent running while agents
  were off.
- **An export with no date is dated by its file**: the date in its file name, else the day the
  file was saved, never after the upload. An export is made as it is downloaded. A PDF is not
  dated this way: a statement saved today can be last year's.
- **The export's growth is kept**: the totals line's gain becomes the balance's `gain`, as a
  statement's does.

## 2026-09-30: History pages through every committed import

The owner uploaded two dividend vouchers, was told they were already imported, and could not find
them. They had come in through the inbox with the first big import and were committed, but the
Import page's History showed only the latest 50 committed imports, so they sat on no page.

- **History is paged, 25 a page, the latest committed first**, from `GET /api/imports/history?page=`,
  with numbered pages. The page is kept in the address (`/import?history=3`), so coming back from an
  import returns to it. Imports committed together (*Commit all ready*) go the latest uploaded
  first. Times are compared as instants, not strings: the offset changes when the clocks do.
- **`GET /api/imports` lists only what waits for review.** It carried up to 200 committed summaries
  too, which the Import page (every 5 seconds) and the menu badge (every 15) fetched without
  needing.

## 2026-09-30: Agents propose fixes; the owner applies them

Checking the Aldermore and Santander imports turned up data that was wrong rather than missing:
- transfers linked to the wrong account;
- a deposit recorded twice (once from a letter);
- an account closed a day late.

The app had no way for the owner to fix most of it: no control for an account's dates, no delete
for a transaction, and no way to change a transfer link. The owner did not want hand edits either:
an agent should propose each fix, grounded in the data, in a queue like the imports, for the owner
to decide.

- **Proposals are drafts of changes, reviewed before they are applied**, like imports: pending ones
  wait in the work area, never in `data/`.
  - One the owner applies or dismisses is kept in `data/proposals/`, with the rows and accounts it
    changed as they were before. That record is the audit trail and the way back.
  - An applied proposal is one git commit.
- **A few kinds of change, each checked against the data**:
  - unlink and link transfers;
  - set a category;
  - remove a duplicate whose rows add up to it;
  - set an account's dates.

  No general "patch any field": each kind has rules a wrong proposal fails (AGENTS.md §5). Checking
  runs when a proposal is made, whenever it is shown, and when it is applied, so one that stopped
  fitting says why.
- **Agents propose with the `records` scope; only the owner applies or dismisses.** Proposing
  changes nothing, so it sits with the other agent-written records. The existing "Claude Code on
  the server" token can propose without a new token.
  - Applying, dismissing and checking are closed to every token.
  - An agent can withdraw its own waiting proposal.
- **Background agents use the same service** through `JobContext.proposals`, under the job's
  provenance. No job proposes yet, and agents stay off.
- **A category a proposal sets is the owner's** (`categorisedBy: user`): the owner approved that
  row's category, so nothing re-categorises it. A transfer it links gets the transfer category, as
  an import's link does.
- **Dismissed means not again**: the same changes are refused while they wait or once dismissed,
  and the owner's reason is kept for agents to read.

## 2026-09-30: Transfers are matched by what the descriptions say

The wrong links the proposals had to fix came from how transfers were matched. Both matchers (at
draft time, and when a commit links rows to ones already stored) took the closest opposite amount
within 4 days. They took the first when several fitted, and never read the descriptions:
- a card payment to AJ Bell became a Chase saver deposit;
- a payment whose description gave Santander's sort code and account became another Chase deposit;
- a Lifetime ISA deposit took a bank transfer "REFERENCE SAVING".

Payments to the owner's own name ("TO … REFERENCE SAVING", "TOPUP") were never counted as
transfers at all: many such rows counted as spending and income.

- **Accounts are recognised by their numbers**: a long number in a description ending in an
  account's last digits (a sort code and account, a card number in a direct debit's reference) names
  that account. It wins over a bank's name, which several accounts can share. Digits are joined only
  in card-style fours, so a date never reads as a number. Aqua's direct debit reads "AQUA CREDIT
  CARD", which its pattern now takes.
- **Money to or from the owner by name is a transfer**, from the name in the profile, only after
  "to" or "from": a payer naming the owner as payee is not the owner's own money.
- **One evidence rule for both matchers** (`transferEvidence`):
  - A row naming the other's account counts most, then the owner's name and transfer categories.
  - A row naming only other accounts of the owner's rules a pair out.
  - Pairs are taken best evidence first, then closest date, so the result does not depend on which
    statement arrives first.
- **Existing links are left alone**: re-linking history would change data the owner has not seen.
  Wrong links are fixed through proposals.
- **A letter that restates payments is a possible duplicate**. From a document that is not a list
  of transactions, a row that two or three recorded rows add up to (within 3 days, from £100) is
  flagged. A deposit made in two payments had been recorded a third time from its confirmation
  letter.
- **Running balances close a day where their chain ends.** Where two Santander exports overlap by a
  day, the last stored row of that day was not the day's last payment. That made two false
  "gaps" that were not there.
- **A Santander export of 600 rows starts at its oldest row.** Santander exports at most 600
  transactions, so a full file stops short of its header's "From" date. The header's date would
  have counted the missing months as covered.
- **Account dates can be edited** (the app's own advice said to correct a closing date on the
  account page, which had no field for it). A closing date closes the account; clearing it reopens
  it. A closed account's data is expected only up to its closing date on the Tax page.
- **A new account made on the review page is named from its bank and name**, not
  `new-account-<n>`.

## 2026-09-30: A proposal the data has caught up with closes as already done

The Aqua card proposal became moot before the owner reached it: committing the card's statements
linked the Santander direct debits to the card's payments, which is all it proposed. The only way to
clear it was Dismiss, which records a no. The server then refuses the same changes, and an agent
reading the history would take it as "these are not card payments".

- **A third outcome, `superseded` ("Already done")**:
  - A waiting proposal that applying would change nothing closes by itself: every change already so,
    or changes that undo each other (an unlink and the same link again).
  - It is checked at start-up, after each change to the data (once it has been quiet for a second),
    and after each proposal applied.
  - It is kept in `data/proposals/` like the others, in a commit of its own. It changes no data and is
    not a no: only a dismissal stops the same changes being proposed again.
  - Considered: leaving it to the owner to close by hand. With agents proposing in the background,
    imports will often get there first, like Dependabot's pull requests once a dependency is updated
    elsewhere. The owner would have to clear each one, and anything they dismissed would read as a
    no. The page still offers "Close as already done" for the moment before it closes. Apply on
    such a proposal closes it the same way.
- **Each decision is its own commit.** The service commits whatever came before it (an import's
  writes), then the decision. The route no longer does it.
- **Moving through the queue**:
  - ‹ › and the arrow keys go to the one before or after, round the ends. Proposals you skip stay
    waiting, with what you left out of each kept for the tab.
  - After a decision, the next one waiting opens after the one decided, not at the top of the list.
    A note says what was decided and that this is the next one.
  - The action bar says which one it acts on ("2 of 4"). Its buttons wait 1.2 s after the page moves
    on, so a click meant for the last one lands on nothing.
- **Each proposal gets a fresh page**, shown at once from the list while it loads. The same page had
  been reused, so the proposal just decided could show for a moment under the next one's buttons.
  Its unticked changes and a typed reason for dismissing also carried to the next one.

## 2026-09-30: A statement's rows count in its own period

The Aqua card showed small balance gaps and "missing" stretches, though its
statements chain from the first to today. Two causes:

- **A payment made on a statement's closing day is sometimes printed on the next statement.** By
  date it fell before the close that did not include it, so one period came up short and the next
  over by the same amount.
  - The balance engine now counts such a row from the day after the previous close (`ledgerDates`,
    FORMULAS §9). The transaction keeps its date everywhere else.
  - Only rows within 7 days of that close, and only when all such rows of the document are, so a
    document spanning months keeps its dates. Rows with a running balance keep their dates.
  - Considered: tolerating gaps that cancel out over consecutive periods. That hides a real
    missing payment offset by a later one, and leaves the closing day's balance wrong.
- **Most statements were read without a period start**, so each covered only its first to its last
  row, and a quiet week after a close read as missing.
  - A statement that opens on the closing balance of the one before it, within 40 days, now runs
    on from it (`importIntervals`, FORMULAS §3). A statement with no rows covers its closing day.
  - Considered: asking the reader for the period start again. It is not printed on every
    statement, and re-reading costs the owner's plan; the chained balances are already stored.

## 2026-09-30: A card export in a plain layout is read card style

PayPal Credit's monthly exports came in with every sign the wrong way round, on a card the files
were uploaded to. Their header (`date,id,amount,description`) fitted the built-in Date / Description
/ Amount layout, which reads amounts as they stand, and the card-style rule only ran for layouts no
profile knew. Most of the files have one to three rows, too few for the card-signs check to count,
and it did not know "Payment" alone as a payment to the card.

- **PayPal Credit's layout is built in**, signs inverted.
- **A built-in layout that names no bank** (no institution or account type) goes through the same
  card-style rule as columns worked out, for a file going to a credit card: on upload and when read
  again. It carries the same warning, and the review page can change the signs back. A bank's
  layout, or one you saved, is kept as it is.
- **The card-signs check can tell from a payment to the card in a short file**, and knows "Payment"
  alone as one. Without a payment, fewer than 3 rows still can't tell.
  - Considered: reading every file for a card card style unless its rows say otherwise. A file of
    purchases alone cannot say, and one already signed the app's way would be turned round.

## 2026-09-30: A document can fill in a payment already recorded

A screenshot of the Chase app showed two payments a Chase export had recorded that morning. It knew
more about both: the day and time the cash was taken out (the export has the day it cleared, two
days later), and that the card payment went to "Credit card". Dedup marked both as duplicates, and
leaving them out lost what the screenshot said. The only other choice was to record them twice.

- **A matched row can fill in its record's empty source fields**, as a third outcome beside
  "leave it out" and "record it". The date, amount and description are never touched: the payment
  is recorded by them. A value the record has is never replaced. This reads "source facts are
  immutable" as "never rewritten": every value is still what a document said, and `seenIn` says
  which document, with what it said differently. Reading a CSV again already filled in a missing
  type this way.
  - Considered: keeping each document's sighting as a separate record beside the transaction.
    Everything that reads a transaction (the drawer, dedup, the categoriser, exports) would need to
    merge them, and the details would stay invisible until it did.
  - Considered: letting a later document win. A screenshot's reading is weaker than an export's
    row, and "the latest wins" would make the record depend on upload order.
- **An earlier date is when it was made.** A document dating a payment before the record's posting
  date gives `transactionDate`, and its time for that day goes in a new `transactionTime`: `time`
  already holds the posting's time, and putting the other day's time there would pair it with the
  wrong day. It is an additive optional field, so no migration.
- **The balance after it only from the same day.** A running balance places a payment in one
  ledger's day. An app listing it by when the card was used is another view of the account.
- **Ticked by itself only when the match is certain.** A possible duplicate may be another payment
  of the same amount, and filling in a balance or bank id on the wrong row would mislead dedup and
  the balance engine. Ticking it is the owner saying it is the same payment.
- **The same date, amount and time to the minute is the same payment**, like the same balance
  after it. Two payments of one amount in the same minute on one day are rare, and a document
  listing both still matches both (as a multiset). A midnight on every row of an export is not a
  time. After a record is filled in, its made date and time count too, so the same screenshot
  uploaded again is nothing new.
- **The category is worked out again only when a field the categoriser reads is filled in** (type,
  other party, merchant, bank category), never on the owner's category or a linked transfer, so
  filling in a time never re-categorises a row by surprise.
- **Details filled in count as the owner's** when "recorded twice" or a proposal chooses a copy to
  take away: they were committed by the owner, and taking that copy would lose them.

## 2026-09-30: Cash from a machine is never a transfer

The same export had categorised the withdrawal as a transfer to the owner's Santander current
account: "Cash withdrawal, Santander, <town>" names Santander, and a provider's name in a description
is how the categoriser finds money moving between the owner's own accounts.

- **A cash withdrawal names none of your accounts**, by its words or by the bank's type for the row
  (the Chase app lists it as "Santander", typed "Cash withdrawal"). The categoriser and the transfer
  matcher now see the row's type. A row only the type calls cash is categorised as cash.
- **The record already wrong is fixed by a proposal**, not by the fix: nothing re-categorises
  history by itself (a re-run on all history would, but loses Claude's payees). The
  proposal sets the category, and a category that is not a transfer one now also takes away the
  account the row named, and works a payee that was one of the owner's account names out again.

## 2026-09-30: A row read with the wrong sign can be taken away by a proposal; Tesco Bank's export is built in

A one-row Tesco Bank card export was read before the card-signs check could tell from a short file,
so its payment to the card went in as money out. The card's statement then recorded the same
payment the right way round, and dedup did not match the two (their signs differ), leaving a gap of
that amount between statements.

- **`remove_wrong_sign`** takes away a row read from a document when rows from another document, in
  the same account and within 10 days, add up to it with its sign turned over.
  - Not a stretched `remove_duplicate`: a copy adds up to what it repeats, and saying "or its
    negative" there would let a refund pass as a repeat of its purchase.
  - A category or payee the owner gave the misread row does not stop it: it was set on a row whose
    amount was wrong, and the rows recorded the right way round keep theirs. A note, tag, split,
    correction, receipt or details from another document still do, as they would be lost.
  - A row typed in by hand, or recorded by the same document, cannot be the misread one.
  - A refund and its purchase, from two documents, fit the same checks. What tells them apart is
    what the documents say (the other document shows the row once, the right way round), so the
    `why` must say it, and the owner sees both rows and their documents beside the change.
  - Considered: "Read again" on the export, which now corrects the sign. It leaves the payment
    recorded twice, which no proposal could then take away (the copy carries the owner's category).
- **Tesco Bank's credit-card CSV is a built-in layout.** Its `Debit/Credit Flag` gives the sign
  (`positiveWhen`, the counterpart of `negativeWhen`), so no rule has to guess from the rows. The
  posting date is the date, as on its statements.

## 2026-09-30: Moves inside an account are left out of imports; a proposal can take one away

Two screenshots of the Starling app listed moves between the main balance and the owner's Space
("Rainy day", typed "Saving"). Starling's statements count Space money in the balance and list no
such move: a statement's balances add up without the app's move from the Space. Committed, the
moves were money in or out no statement saw: a gap in January, another hidden in September, and the
September move linked as a transfer to a Monzo payment of the same amount that day, on its savings
category alone.

- **The draft leaves a Space move unticked** (`shared/spaces.ts`): a row the bank types as one
  (Starling's "Saving"), or one naming a Space listed on the account (`spaces`, additive, no
  migration) with no type saying otherwise. Committed unticked, its Space is remembered on the
  account, so a row cut off above its type is known next time.
  - Considered: leaving Space moves to the reader's prompt. The rows carry what is needed (type,
    name), prompts cost a version bump and a re-read, and the rule stays testable in code.
  - Considered: all savings-pot moves. Monzo's pots sit outside the balance its statements show,
    so money into one does leave the account; only banks known to count Spaces in the balance,
    or Spaces named on the account, are left out.
- **`remove_internal_move`** takes a recorded one away when, after the whole proposal, the strong
  balances either side of it add up without it (`BalanceEngine.between`). That is the evidence a
  statement gives; the name alone is not.
- **One side's transfer category alone no longer links a transfer.** It says nothing about the
  other side: the Space move had `savings-transfer`, the Monzo payment nothing that named a
  transfer.
- **A statement's or your own balance outranks a screenshot's on the same day** in the balance
  engine. The screenshot's balance had replaced the owner's for the same day, and gap checks skip
  screenshots, so September's gap went unreported.

## 2026-09-30: A confirmation of one payment is that payment (`extract-10`)

A "payment sent" screenshot (£5.00 from a current account ending 1234 to the owner's
Santander account, reference TOPUP, dated Today) recorded nothing. Both readers called it "not a
list of account movements": `extract-9`'s rule 5 said only the account's own list of movements
gives transactions, and said nothing of a screen or letter confirming one payment. The same reader
had recorded a deposit confirmation letter's deposit that morning, so the outcome was a coin toss.

- **Rule 5 now says so**: a confirmation or receipt of one payment made or received gives that
  payment, dated as shown, described by its payee and reference (so a statement's row later finds
  it as a duplicate, `dedup.ts`). A payment set up for a later day is scheduled and gives nothing,
  as scheduled payments in a list already did.
- Considered: leaving it to the draft (a confirmation's figures read into a row in code). The
  reader already returns rows and dates "Today"; the gap was only the rule.

## 2026-09-30: The later balance of a day stands for it; a figure you typed is yours

After a £5 payment was recorded from its confirmation, HSBC showed £5 and a £5 gap. The owner had
given £5 as the balance at 18:00 and typed £0 into the import at 23:00, after the payment. The
engine kept one balance a day and ranked the owner's own over a screenshot's (added this morning,
Starling). Every balance counted as the day's close, so the 18:00 £5 hid the £0. It also counted
the evening's −£5, which made a £5 "gap".

- **Balances say when on their day they were seen** (`at`, format v3): a screenshot's capture
  time, or when you gave a balance for that same day. Of two that say when, the later stands for
  the day; a close (statement, export, running balance, or your balance for an earlier day) is
  the latest. Without times, the old ranking holds.
  - Considered: ranking yours over a screenshot's always (as this morning). That is right only
    when yours is the close, and a balance given for today is not.
- **A balance seen mid-day is not evidence of a gap** when a row of its day could come after it:
  no time, or a later one. Rows seldom have times, so in practice a mid-day balance with rows that
  day is left out of gap checks, as a screenshot is.
- **A figure you typed while reviewing is yours** (`enteredBy: "user"`). A draft section keeps the
  balance it proposed (`readBalance`), and a different committed figure is yours. It weighs as your
  own balance: over a screenshot's, and in gap checks. Editing an imported balance's figure makes
  it yours too. Applying a re-read replaces it with the reader's, and the mark goes.
  - Considered: storing it as `kind: "manual"`. `kind` says what document it came from, and the
    import link stays; weighting is the engine's business.
- **Backfilled, not guessed** (migration `from: 2`). The times come from `createdAt` (your own
  balance, given on its day) and the import's `capturedAt`. `enteredBy` is set where the committed
  figure is not what the reader read, sign aside, since the draft turns a balance owed negative.

## 2026-09-30: Another product is not the account; a balance read into the wrong one can move

A fixed-rate account matured into an easy-access account at the same bank, under the same account
number. The maturity letter names the new product and prints no number. Uploaded with the new
account's first statement, it matched the closed fixed-rate account (provider, kind, and "your only
savings account", which the closed account borrowed from an open one elsewhere), so the new
account's opening balance became the old one's last, a day after it closed.

- **Being your only account of a kind is the open one's.** A closed account never gets it.
- **A named product that shares no word with the account counts against it** (−25). The provider
  and kind alone no longer make a match. Replayed over every committed import, no match changed.
  - Considered: vetoing, as `fitsAccount` does for screens taken together. Account names come from
    their first document, but you can rename one; a penalty still lets a number decide.
- **A commit that creates an account matches the waiting drafts again** (those you have not
  edited), as the app's start already did. Otherwise a letter drafted before its account existed
  proposes a second new account.
- **`move_balance` proposals** fix balances already committed to the wrong account. The checks
  mirror `remove_internal_move`: it must not fit where it is (the account was closed or not yet
  open that day, or its balances do not add up with it), and must add up where it goes. A balance
  you gave or changed is yours. `before.balances` keeps it as it was (additive, no format change).
  - Considered: deleting it (the new account's statement already has the figure). Moving keeps the
    letter's evidence, and its interest rate, on the account it describes.

## 2026-10-01: Timesheets: earned pay, followed to the payslip and the bank; owed pay is pending

A timesheet workbook (a sheet a month, days worked, a day rate with holiday pay rolled in) went to
column mapping as if it were a bank export, and only its first sheet (an empty month) was read.
Its pay comes through another employer's payroll a month after the work, and a timesheet that goes
in late is paid with the next month's.

- **A spreadsheet that is not a list of payments is read by Claude**, every sheet as text
  (`looksLikeLedger`: no amount column, or several sheets and no confident mapping). The owner
  allowed Claude for spreadsheets. Bank exports keep the local route; either way round can be
  chosen on the review page. Without Claude it falls back to mapping, and says so.
  - Considered: a parser for this template. Templates differ by employer, and the reading is
    checked against the cells anyway: each month's pay must be on its sheet to the penny, and a
    sheet with pay must have been read. A reading that passes needs no second one.
- **`earned_pay` is a figure kind, with no tax year.** It is never income: the payslip that pays it
  is, when it is paid. Additive (a new enum value and optional `work`, `paidBy`, `taxCode`), so no
  format change. The last committed figure for a timesheet's period counts, so an upload of the
  grown timesheet can correct a month without rewriting the earlier one.
- **Matched by amount, not by date.** A payslip pays the run of unpaid months whose pay adds up to
  its gross to the penny, so a £0 payslip and a two-month payslip need no rule of their own. The
  delay is learned from those matches; the owner can set it (`profile.employers`), as they said
  this payroll always pays a month later.
  - Considered: a fixed one-month delay. It would be a hard-coded constant, and wrong for other
    payrolls.
- **The payroll is linked per timesheet (`paidBy`), not by merging employer names.** The timesheet's
  entity (Halden Systems Limited) is also the name on an earlier salaried job's payslips, which are another
  employment: an alias would have merged them.
- **Owed pay is pending beside the estate, never in it** (the owner's choice: visible, not
  counted). It shows its estimated take-home and when it should come, and leaves once a payment
  from that payroll arrives, before its payslip is imported.
- **Deductions are estimated from UK rules plus the payroll's own last payslip.** Employee NI is
  now in `uk.ts` (from 2024/25). The tax basis is the printed code, else whichever of `1257L` month 1
  or cumulative gives the last payslip's tax: this payroll's matched month 1, which no other basis
  does. Paying two months at once is shown with what it costs: NI per pay period is never
  refunded.
- There is no short-term cash forecast to add the expected payment to; the projections use average
  income and would count it twice.

## 2026-10-01: Each fact counts once: one source per job and year, dividends, pensions; forecasts and NI numbers kept right

The first of five slices that give everything on a document somewhere to go (the owner approved
the plan on 2026-10-01). Reviewing the pending imports showed facts counted twice or dropped:
- a P45 and an HMRC page each stated one job's year so far, and both counted;
- any HMRC page to a date counted as a P60 and froze that employer's pay;
- a dividend voucher and the bank credit that paid it both counted;
- a pension statement and the payslips that paid the same contributions both counted, and the
  larger of two schemes' employer contributions replaced the other;
- a State Pension forecast was dropped at commit;
- the owner's National Insurance number sat in three figures.

- **One source per employer and year** (`analytics/sources.ts`). Every document's figure is kept,
  and exactly one counts: your own, else a figure for the whole year (a P60 first), else the most
  recent as at its date (a document over the payslips on the same date).
  - Considered: adding up different documents and taking out repeated amounts. One total stated by
    two documents to different dates is not a repeat by amount. The date it is true at says which
    is the year so far.
- **Employers are matched by PAYE reference as well as name.** HMRC prints names its own way
  ("(UK)", capitals, LIMITED), and the reference is printed on P60s, P45s and HMRC's pages.
- **A dividend voucher and its credit are one dividend:** the same amount to the penny, within 10
  days, from the company named. This is the rule an interest certificate already follows.
  - Considered: re-categorising the bank credit away from Dividends. That mislabels income.
  - Considered: a stored link now. It comes with dividend records in a later slice. Until then the
    match is computed, and the owner sees it on the line ("paid into … on …").
- **Pension contributions are counted scheme by scheme.** A statement replaces its scheme's rows,
  as an interest certificate does. Payslip deductions that add up to a statement to the penny are
  its money. Schemes add up.
- **A forecast with no balance is a figure** (`pension_income_forecast`).
  - Considered: a balance of £0. The account would show a £0 State Pension.
  - Considered: making a balance's amount optional. Every reader of balances would need to handle
    it.
- **National Insurance numbers stay out of what the app derives.** Format v4 takes them out of
  figures and the readings kept with imports. Anything shaped like one is caught, since keeping a
  number out matters more than telling a real one from HMRC's example. Bank descriptions are source
  facts and keep theirs.
- **A proposal can note what a payment was for** (`set_note`), from a document: the room and term a
  rent instalment paid. Applied, it is the owner's note; it never replaces one.
- **Dividends over the allowance are a filing hint.** The deadline to tell HMRC (5 October) and the
  £10,000 threshold are UK rules in `uk.ts`, from gov.uk's "How to report tax on dividends".

## 2026-10-01: Jobs, HMRC's records, and pay owed to you (format v5)

The second slice. HMRC's pages said more than the figures could hold. Each pay date's taxable pay
and tax, every tax code with the day it was issued, when a job started and ended, the year's
settlement, the National Insurance years and the State Pension forecast were read and then dropped,
or squeezed into figures that counted them wrongly. One employer appeared under three names (a
group name on payslips, the company on the P60, a payroll company in the bank), and only its name
joined them. Pay owed to the owner (a missed month the employer will pay) had nowhere to go.

- **A job is a record** (`employments.json`), not a name. It holds every name the employer comes by,
  its PAYE reference and the owner's payroll numbers. Figures and HMRC's records carry its id.
  - An import matches a job by PAYE reference, payroll number, a name only one job has, then HMRC's
    record of the payment to the penny. Otherwise it proposes a new job, which the owner sees and
    which holds the import back from "Commit all ready".
  - Considered: keeping name matching (`payerKey`) and adding references to it. A payslip printing a
    group's name and no reference would still be a separate employer, and nothing could hold the
    pay lag, the owed months or the dates.
- **HMRC's records are records of their own** (`hmrc.jsonl`), a typed list: tax codes, payments,
  employments, events, settlements, NI years and the State Pension forecast. Each has an id from
  what it says, so the same page printed twice is stored once.
  - Considered: more figure kinds. A tax code, an event or an NI year is not an amount for a tax
    year, and a payment record is not income on top of the payslip it records.
  - HMRC's record of a job's payments is one more source for its year (§11). A job that has ended
    makes a source to its leaving date final.
- **HMRC's pages are read on this machine** (`ingest/govuk.ts`, from their text with `pdftotext`).
  Their layouts are fixed and their figures exact, so a reader per page is more faithful than
  Claude, costs nothing, and keeps the owner's tax records out of any model. Pages already imported
  are read again by the v5 migration, which takes out the figures they replace.
- **The tax a code would take sits beside the tax taken.** It uses the code in force 14 days before
  the pay date (`CODE_NOTICE_DAYS`): a code issued days before a pay date is too late for that
  payroll. A difference is a note on the month, never a correction: HMRC settles it after the year.
  - Considered: the code printed on the payslip. It is what the payroll used, so it cannot show
    that the payroll used the wrong one.
- **Pay owed to you is the owner's word**: `owed` on the job, set from the Pay tab, or what the
  owner told the app (an active context record of pay not received for the job and period). A late
  payment of that exact amount from the job pairs with it, and until then it counts in the
  Overview's owed line. A month is never marked owed by itself: one not seen may be a bank
  statement not imported yet.
- **A payslip that prints no period is looked for at HMRC's pay date**, when HMRC's record of the
  payment matches it to the penny. A last payslip dated the day a job ended, weeks before its pay
  day, was taking the previous month's payment. A payment within £1 of the expected amount is now
  paired before the nearest one, so no payslip takes another's own payment.
- **The same figure from two kinds of document is two sources.** A draft figure is a duplicate only
  of one from the same kind of document: a P60 and HMRC's year page that agree are both kept (one
  counts), and the same P60 read twice is one.
- **The State Pension forecast is HMRC's record when there is one.** The retirement outlook takes
  the newest forecast, HMRC's or the owner's, and starts it at the State Pension age the forecast
  gives.
- **One employer's documents waiting together set up one job.** Drafts were matched again only
  after a commit set up an account. Now that also happens after a commit that sets up or teaches a
  job, or adds HMRC's records. A draft you edited, and so is not drafted again, joins the job set up
  since with the id it proposes when that job is the same employer.
- **Pay carrying your payroll number is salary.** A payroll's bank reference prints the payroll
  number. A statement export with no categories left months of pay uncategorised, so the Pay tab
  could not find it. The categoriser now knows the jobs' payroll numbers. When a job learns one,
  pay already recorded with it and no category is filled in. A category anyone set stays.
  - Considered: the employer's name. A company you own pays you dividends and transfers under its
    name, and those are not pay.
  - Considered: re-running enrichment on all history. That would also apply rules you chose not to
    apply to history.

## 2026-10-01: Payslips in full, read on this machine; Tax documents by year and job (format v6)

The third slice. A payslip prints far more than the figures kept from it:
- every payment and deduction line, the taxable and net pay;
- the employer's NI and pension, the tax code and NI letter, the pay date and period number;
- the year-to-date column.

All of it was read and dropped. The two layouts behind the stored payslips (SAP paystubs, and those from
one UK payroll package) are the same every month.

- **A payslip is kept in full** (`payslips.jsonl`), beside its tax figures rather than instead of
  them. The figures stay what every calculation reads; the record keeps the rest: the lines (signed
  as printed), the totals, the codes and the year to date. Never your name or NI number: only the
  NI letter.
  - Considered: replacing a payslip's figures with the record and deriving them. Every calculation
    and proposal that reads figures would change at once, for no gain in what is stored.
- **Known layouts are read by rule, on this machine** (`ingest/payslips.ts`). Their figures are
  exact, a reading checks itself against the printed totals and net, and nothing goes to Claude. The
  v6 migration read the stored payslips again. All read cleanly and agreed with their first
  reading; each pay figure got the tax code it prints.
  - Considered: correcting stored figures silently. The migration corrects a figure only when the
    payslip read again adds up to every total it prints, keeps the old amount in the figure's note,
    and leaves several figures of one kind alone.
- **The net pay printed is the pay looked for in the bank.** Deductions that are not tax figures (a
  cycle scheme) no longer show as a difference.
- **The year-to-date column is a source**, as the approved precedence has it (P60, P45, HMRC,
  latest year to date, payslips summed). It also shows payslips not imported: a rise more than the
  later payslip's pay.
- **Employer pension comes from the payslips' year to date** when no statement or account record
  covers it. Payslips print it only in that column. A job whose pension goes into an account with
  its own records that year counts there, not twice.
- **Settings → Tax documents shows a year by job.** For pay, tax, NI, student loan and payslip
  pension, it shows the source that counts and the others, each linked to its document. The year's
  other figures follow, by kind.

## 2026-10-01: The reader keeps everything a document prints (extract-12), off until evaluated

The fourth slice. The local readers keep payslips and HMRC's pages in full, but a scanned payslip,
a screenshot of HMRC's app, or a P60's NI table still lost everything with no figure kind. The
prompt now has three more rules and their part of the schema: payslips in full, HMRC's records, and
every other labelled value (`printed`).

- **It ships off** (`settings.extraction.readEverything`), and the reader stays `extract-11` until
  the evaluation run passes. The owner's standing rule is that no Claude runs while building or
  testing, and the reader is too central to change on faith. The eval has a scanned payslip in a
  layout no rule reads, and checks the P60's NI table; `npm run eval -- --everything` runs it.
  - Considered: switching the reader over untested. A worse reader of every upload costs more than
    waiting for one run.
- **Other values are kept as printed text**, with the import, not as records. Nothing reads them
  yet; the last slice gives some of them homes (terms, companies, arrangements).
  - Considered: a record kind per document type. Too many kinds for values nothing reads, and a
    reading would fail on any it got slightly wrong.
- **A payslip that adds up checks itself.** Its lines, totals and net agree, so its tax figures need
  no second reading by the stronger model. That is cheaper, and it is the same arithmetic the local
  readers use.
- **No personal identifier is kept**, by the prompt's rule and by the normaliser, which takes NI
  numbers out of all of it.

## 2026-10-01: The tax year in full: a page per job, deadlines, HMRC's working out, the NI record

The fifth slice, first part. HMRC's records (slice 2) held a year's settlement, every NI year and
the State Pension forecast, but nothing showed them, and Self Assessment gave one total for all of
a year's jobs although the return wants a page for each.

- **One SA102 page per job** on the Self Assessment tab: pay, tax and student loan from the source
  that counts, the PAYE reference, and the dates a job started or ended in the year. The totals stay
  as the sum.
- **The year's deadlines** are UK rules in `uk.ts` (`saDeadlines`, `codingOutLimit`), from GOV.UK,
  with the next one first in weight.
- **HMRC's working out of the year** is shown with the bank payment that settled it, matched by
  amount, nearness and wording (FORMULAS §11). The match is computed, not stored, as for dividends.
- **The NI record and the forecast in full** go beside the retirement outlook. Each gap shows
  HMRC's cost and pay-by date. Whether filling one would help is left to HMRC's own words: the
  forecast says when it is already the most you can get.

## 2026-10-01: Shares in a company: a record, an account at book value, and its dividends

The fifth slice, second part. An owner may hold shares in a company, often the one they work for. Its share
certificate, its confirmation statement and its accounts had nowhere to go (each was "nothing to
record"). Asked whether the shares should count, the owner said it was up to me, if they can be
quantified.

- **A company is a record** (`companies.json`): the holding by class, the shares in issue, the
  certificate, and dated valuations.
- **Its value counts in the estate on an "other asset" account**, at book value: net assets × your
  shares ÷ all its shares, as at the balance sheet date. The confirmation statement says every share
  carries full rights to capital, so pro rata is fair. The balance is not marked approximate: that
  flag means a rough figure standing in until real data arrives, and would leave the account asking
  for new data forever. The card and the balance's note say it is a book value.
  - Considered: no value. That would leave out something that can be quantified, against what the
    owner allowed.
  - Considered: an investment account. The projection would grow it at a fund's expected return.
- **An agent proposes it** (`add_company`), from the documents, and the owner applies it, as with any
  other change to their data.
- **Its dividends are listed with the credits that paid them**, by the rule the dividend allowance
  already uses. The match is computed, not stored.

## 2026-10-01: Pension arrangements: what an employer set up, checked against what arrived

The fifth slice, third part. An employer's contribution form for the owner's SIPP (a single payment
and a monthly one by Direct Debit) was "nothing to record", although the SIPP's own rows show the
payments, and when they stopped.

- **An arrangement is kept on the job** (`pensionArrangements`): the account, single or monthly,
  the gross amount, the form's date and its document.
  - Considered: a record of its own. It is always one employer's, and the job is where its pay,
    codes and owed months already are.
- **The pension's page checks it against the account's employer contributions.** A single payment
  is looked for within 60 days of the form. A monthly one is checked from its first collection,
  looked for within two months, so a Direct Debit's start-up wait is not a gap. A month with none is
  listed, and contributions on no arrangement are listed apart.
- **It changes no total.** The allowance counts the contributions that arrived, as before.
- **An agent proposes it** (`add_pension_arrangement`), from the form; the owner applies it.

## 2026-10-01: Agreements to pay: an offer's schedule, filed and checked

The fifth slice, fourth part. Two University of Exampleton accommodation offers (the college, the room,
the let, its total and three instalments) were "nothing to record". Their rent was filed as
courses, because the merchant list read any "UNIVERSITY" as a course.

- **An agreement is a record** (`agreements.json`): who you pay, the period, the total, the
  schedule as the document gives it, and everything else it says as label and value, in its own
  words.
  - Considered: a field for each thing an offer says (college, bedroom type, let length). Every
    kind of agreement says different things; label and value keeps them all without a schema for
    each.
  - Considered: a rule (`rules.json`) for its payments. A rule has no dates or amounts to check
    against, and would file every £1 printing charge to the university as rent.
- **Its payments take its category as they come** (categoriser step 3b): money out naming its
  counterparty, within 45 days of a due date, for that payment's amount or within a tenth of it.
  The tenth covers a £150 advance taken off an instalment and a £12 charge added to one, as the
  2023/24 let had; a £1 charge is far outside it. A payment made before the agreement was is never
  its: last year's bill, a month before this year's first instalment. Its payee is worked out as
  any other's, so it groups with the payments to the same payee outside the agreement.
- **The check pairs payments across all agreements at once**, so a tenancy and its renewal never
  share the month's rent between them.
- **A university's name alone is not a course any more.** The merchant list kept "UNIVERSITY" for
  courses, but a person pays a university rent, printing and cafés as well as fees, and is paid
  wages by it. "TUITION" and the Open University stay. Rows filed by the old pattern keep it until
  categorisation is re-run (Settings → Rules).
- **Its card on the Spending page checks the schedule**, each payment due paired with one payment
  (exactly the amount first), with the other payments in its category around it. The check is
  computed, not stored.
- **An agent proposes it** (`add_agreement`), from the document; the owner applies it, and the
  proposal shows which recorded payments it would file.

## 2026-10-01: An account's terms: one home, dated, with what ends soon (format 7)

The fifth slice, fifth part. The owner's statements print their terms: card limits, purchase and
cash rates, a 0% promotional rate until 31 Mar 2027, minimum payments, savings AERs and a boost
ending on 1 Jun 2026, an overdraft limit. Only the limit and one rate were kept, on each balance
snapshot (the card's rate sometimes its purchase rate, sometimes left out as "not an AER"); the
rest was in the readings' notes.

- **Terms are a record of their own** (`terms.jsonl`): an account's rates, each with what it
  applies to, how it is stated, whether it is variable, when it ends and the amount at it; its
  limit; a card's minimum payment. One record per account, document and day, as `hmrc.jsonl` keeps
  what a page said on its day.
  - Considered: more fields on the balance snapshot, where the limit and rate were. A letter about
    a new rate has no balance, and terms belong with the account whether or not a balance is
    recorded (a section can leave its balance out).
- **The limit and rate move off the balances** (migration to format 7), so they are kept once.
  The same terms from two balances of one day are one record. A moved balance takes its reading's
  terms with it.
- **A rate that has ended is not used** by projections: what follows a boost or a fixed term is
  not on the document, so the next source stands in and says which rate ended. It is not worked
  out (a boosted rate less its boost) either.
- **The account's page shows them**, each part (rates, limit, minimum payment) from the latest
  document that gives it, so a screenshot showing only the limit does not hide the statement's
  rates; how the limit and each kind of rate changed; and any rate ending within 60 days, with what
  applies after it when the document says. The overview alerts on open accounts.
- **The reader that keeps everything reads them in full** (`extract-13`, rule 23, still off until
  its evaluation runs); the reader in use keeps the limit and one rate, as before. The evaluation
  scores terms on two cases, so one run covers it.
- **An agent sets a document's terms in full** (`set_terms`) from the documents already imported;
  the owner applies it.

## 2026-10-01: The reader that keeps everything, evaluated (extract-14)

The owner asked for its evaluation run. On four cases (a scanned payslip, a P60, a card statement
and a savings statement) `extract-13` scored 99.6%: everything it adds (payslips in full, printed
values, terms) was right, but on the payslip it also gave the employer's £75 pension as a tax
figure, which the payslip in full already holds. The same fact twice is what this work set out to
end, so `extract-14`:

- **names a payslip's figures in rule 20**: pay, tax, NI, your pension and student loan; never the
  employer's NI or pension, which go in its employer costs. Rule 13, shared with the reader in use,
  lists "the same kinds as a P60" (no pension) and is left alone: a first attempt that pointed at
  it made the reader drop your pension too (its result is kept as `extract-14-draft`).
- **drops a repeat in the normaliser** (not left to the reader): an employer's pension figure is
  dropped when the payslip's employer costs hold it, moved there when they do not, and kept when
  the two disagree.

`extract-14` scored 100% on the four cases (eval/results, `owner-go-final`), three confirmed by
their own figures and the P60 read twice with no disagreement. The four runs cost $1.11.

## 2026-10-01: A job learns what its payslips print (format 8)

A Halden payslip, a scan, was drafted as a new job, "Fennick Group Ltd": the reading took the
group's name for the employer. The Halden job's payslips already in the data print that
name, and a payroll number, but the job had learnt neither: format 6 filed them under it
without teaching it, and a commit taught a job only the draft's one employer name.

- **A payslip filed under a job teaches it** the payroll number and every name the payslip prints,
  a group's as an alias (the job's `aliases` were always meant to hold "a group's name" on
  payslips). The next payslip is the same job by its payroll number, or by whichever of its names
  the reading takes.
- **Format 8 teaches each job from the payslips already stored under it**, once. A startup routine
  was considered: it would put back an alias or number you had taken off.
- The bank shows both Fennick jobs' pay as "FENNICK THERMAL" with the payroll number, so the group's
  name as an alias pairs no other job's pay.
- **A payroll number is learnt only at 5 characters or more**, as bank references are matched. The
  scan prints "Payroll Ref.: Q1", a payroll's group code, not the owner's number (which is not on
  it); learnt, it could take another Fennick payslip printing the same code for this job.

## 2026-10-01: Settings say what is not saved

A switch on Settings → Import & extraction changed only the page until Save, at the foot of a
long page, was pressed; the owner turned on reading everything and it never reached the data.
While a form differs from what is saved, its Save bar now stays in view at the foot of the screen,
says the changes are not saved yet, and offers Undo.

## 2026-10-02: Claude names imports, behind its own switch (off)

Import → History listed committed imports by file name ("IMG_1234.PNG", "statement.ofx",
"Monzo-export-again.csv"), which says little about what each document is. A `label-imports` job now
names each one ("Monzo current account export, 1 – 30 Sep 2026"), and History shows the name
over the file name and searches both, with the accounts.

- **From what was read, not the document.** The job sees each import's kind, provider, accounts
  (name, type, period), dates, a payslip's employer and the tax figures' kinds and years. It never
  sees amounts, account numbers, references or rows, and gets no tools. Reading the document again
  would cost a reading each and add nothing a name needs.
- **Batched.** One job names up to 40 imports: twelve took 16 s and $0.08 with Opus at high effort;
  one after a commit, 2 s and under a cent.
- **Its own switch, off by default.** Settings → Agents → "Name imports with Claude". While it is off
  no one can start the job, the owner included. On, it starts by itself a minute after imports stop
  being committed or filed (within the background budget), without "Let agents start jobs by
  themselves": the switch is the owner's opt-in for this one use, as "Read receipts with Claude" is
  for receipts.
- **The owner's name wins.** The name is an optional `label` on the import record (`{text,
  provenance, at}`; additive, so no format change), and `document.fileName` stays as it was. A name
  the owner gives on the import's page is never replaced; taking it away lets Claude name it again.
  No token can rename.
- A deterministic name (provider, kind, period) was considered: it would do for statements, but not
  for screenshots, HMRC's pages or files the reader understood only in part, which are the ones
  hardest to find.

Later the same day, after the owner's first runs (`label-imports-2`):

- **The first run of 40 named 39.** Claude's answer for one import was not kept, and the job does
  not keep the answer, so why is not known; an id copied wrong is the likeliest. Imports are now
  given to Claude as short refs (1, 2, 3…), and a run keeps names for exactly the imports it
  showed. `label-imports-1` worked out the newest 40 again when keeping the names, so an import
  committed while Claude was at it could push one out.
- **An import is named once.** A run asked about particular imports (one queued after a commit)
  used to name them again even when History's button had named them first. Now no run replaces a
  name, and one with nothing left to name ends as done, without calling Claude (`NothingToDo`, which
  any job's `prepare` can throw; the runner now prepares before it looks for the CLI).
- **Pressing History's button twice** started one run but showed two toasts: the button was only
  busy while the request was sent, and the run takes 20 to 40 seconds. It now says "Naming…" until
  the run it started ends, and asking for a job already queued or running returns it with
  `existing: true`, which shows no toast.

## 2026-10-02: An audit log beside git's history

- **Asked:** a log in Settings of every action that modifies data, with its actor (you and your
  address, an agent token, or an agent job), reliable, searchable and detailed.
- **One choke point per kind of change, not a call in every route.** Every store write already
  emits `change`; the audit log listens first (so the git commit can name its entries). Requests
  are recorded by one middleware, placed before the CSRF and auth guards so refusals are recorded
  too. Imports, jobs and proposals are recorded from their `update` events. A new route or write is
  covered without anyone remembering to add a line.
- **The actor travels in `AsyncLocalStorage`**, set by the request middleware, a job's run, the
  import queue, the inbox and the app's timers. Passing it down every call was the alternative: it
  would have touched almost every function, and any one missed would be silently wrong.
- **In the work area, not `data/`.** `data/` is the product and is committed: an audit entry per
  write would be a commit (or a dirty tree) per write, and would put addresses and device names in
  git. The work area is private, backed up nightly, and already holds the token log.
- **Written and synced before answering, hash-chained, never trimmed.** A database was considered;
  JSON lines match the rest of the app, read with any tool, and are small (a busy day is tens of
  KB). The chain shows an entry changed or removed later; it is evidence, not prevention.
- **Request bodies kept, with limits.** Secrets redacted, NI numbers removed, account and card
  numbers cut to their last 4 digits (they arrive before the app's own rules apply), long values cut, an import's draft only as
  its shape (it is a document's contents), uploads never read.
- **Device names from the tailnet** (`tailscale whois` on the host's own daemon): an address alone
  (100.x.y.z) says little. It is local, so nothing leaves the machine.
- **Not covered by name:** `npm run records`, hand edits and `git checkout` write `data/` from
  another process; the live app records them as changed outside the app, with the files, when its
  watcher sees them.

## 2026-10-02: Claude sessions, with their transcripts

- **Asked:** a section listing every Claude session the app runs, current and past, so the owner
  can see exactly what each agent did. Each session should show what started it, its model,
  timing and cost, its full transcript, everything it produced, and its audit rows, linked both
  ways. Transcripts are to be captured from now on, for the API engine too, and earlier sessions
  must never get a made-up one.
- **A page of its own (`/sessions`), not a Settings tab or a panel on Agent jobs.**
  - A session can belong to a job (Assumptions & research), an import (Import), a receipt
    (Transactions) or a token (Settings), and the audit log points at all of them. No one page owns
    them.
  - Each session needs an address of its own, to link from the audit log, a job or an import, and
    room for a long transcript. Settings' tabs are hash-addressed forms.
  - It was first kept out of the sidebar, which is about money. Since 2026-10-02 it is in the sidebar
    (see "Notes, tags, choosing rows, and links before commit" below). It is also reached from
    Settings → Agents and Agent access, Agent jobs, each import and receipt, and the audit log.
- **Streamed, not rebuilt.** The CLI moved from `--output-format json` to `stream-json --verbose`.
  Its last event is the same result as before, so nothing else changed. Each event is written as
  it arrives, so a running session's page follows it.
  - `--no-session-persistence` stays: Claude Code's own copy would sit in `~/.claude`, outside the
    work area, the backup and the retention period.
  - The API engine records the request and its reply the same way.
- **In the work area, beside what it belongs to.** Transcripts hold document contents, so they get
  the work area's protection (0600, never in `data/`, git or logs, in the encrypted backup). They
  sit under the job's, import's or receipt's own directory, as the owner asked, with one small
  record per session in `sessions/` so the list is cheap.
- **What is left out.** A file's base64 bytes (the document is kept anyway, and a PDF would
  multiply a transcript's size). Account and card numbers keep their last 4 digits, the data's own
  rule, as in the audit log.
- **Capped.** 10 MB per transcript (the final result always kept), 1 GB together (oldest first), 90
  days. All three can be changed in `.env`, since they are operations, not modelling. The record
  outlives its transcript and says when and why it went.
- **Earlier sessions** come from what their job, import, re-reading or receipt recorded. An earlier
  import's two readings stay one row: only their total cost was recorded.
- **Token agents** run outside the app. Their requests (the token use log), cut into stretches by a
  30-minute gap, stand in for a session, with no transcript.

## 2026-10-02: Notes, tags, choosing rows, and links before commit

- **Claude sessions in the sidebar**, under Import. The owner asked for it to be easy to find. It is
  where Claude's spending and work show, and the sidebar now says how many sessions are running
  (`GET /api/sessions/running`, from the records in memory). This reverses "not in the sidebar"
  above.
- **Notes and tags say what each is for**, wherever you write either:
  - Notes are free text for you, and search finds them.
  - Tags are labels to group and filter by. A tag in the list filters by it, and tags in use are
    offered as you type.

  A note can be added from a row's note button or to a whole selection. For a selection it is added
  on a line of its own (or replaces the notes, if you choose), and never twice. Tags keep one
  spelling whatever the case (`src/shared/annotations.ts`). No format change: both fields were
  there already.
- **Choosing rows with Shift and Ctrl/⌘.** The rules are a file manager's, with one difference the
  owner asked for: each new hold of Shift starts a group of its own. So several groups can be
  chosen without the gaps between them, and no Ctrl is needed. A Shift-click straight after a plain
  click still extends from it. The same rules tick an import's rows in and out.
- **Links before commit.** A transfer whose two legs arrive in two documents could only be linked
  after both were committed, and only when the descriptions agreed. Now a row can be linked by
  hand, while both wait, to:
  - a row of another pending import (`pendingLink` on both);
  - another account's row in the same document;
  - a recorded transaction (`transferMatch`, `transferMatchBy: "user"`).

  How it was built:
  - A pending link becomes a `transferMatch` when its other side is committed. That reuses the
    existing commit path, so committing in either order ends the same.
  - The server owns a row's links. A draft saved from a page opened before a link keeps the link,
    so linking from one import's page is never undone from the other's.
  - Links are additive optional fields on a draft row: no format change.
  - Token "Import upkeep" may link and unlink, since it edits a draft and records nothing.

## 2026-10-02: "Agent", not "Claude", for who does the work

- **Asked:** the owner wanted "Claude sessions" renamed "Agent sessions", and "Claude" changed to
  "agent" across the app, except where the text names the model to be used or used.
- **Done:**
  - The sessions page, sidebar, audit log labels, insight panels ("Agent notes"), import naming,
    receipt reading, the review page and transcript steps now say "agent".
  - So do the errors and audit summaries the server writes from now on. Earlier audit entries keep
    their wording: the log is hash-chained.
- **Kept as "Claude":**
  - the engine choices and their descriptions ("Claude via your Claude Code login", "Claude API");
  - the login the jobs use, and "Claude usage at API prices" for costs;
  - Claude Code, the tool an agent with a token runs in;
  - the model names, and errors from the API about the model itself.

## 2026-10-02: Coverage you confirm, from what the balances show

- **Found:** only a few of the last 365 days counted as covered by every account, so no month was
  complete. That left the month in review incomplete and the baselines at low confidence. Most of
  the gaps were quiet periods, not missing data:
  - card issuers send no statement for a month with no activity and a nil balance;
  - an export covers only its first row to its last;
  - screenshots counted only for the days their rows showed.

  The balances proved it to the penny: for example, every HSBC row since the account opened adds
  up to the next statement's balance.
- **Asked:** the owner chose:
  - a stretch whose balances add up should *not* count as covered by itself;
  - a screenshot, or a balance seen mid-day, *should* count when it adds up exactly;
  - an export's range can be given on upload, and past data must be put right without uploading
    files again.
- **Done:**
  - **Balance evidence on every gap.** Data health lists each stretch no document covers, with
    whether its balances add up (FORMULAS.md §3). An account opened on a known day starts from the
    £0 it opened with, labelled as such.
  - **You confirm.** "Nothing missing" on one stretch, or "Confirm the N that add up" at once
    (each only to the day its balances reach). A confirmation goes into a new `coverage.json`,
    counts as covered, records the evidence it was confirmed on, and is marked if its balances
    later stop adding up. It is additive data, so there is no format version. No token can confirm
    or withdraw one.
  - **Weak balances that add up exactly are usable** in gap checks and evidence (FORMULAS.md §9).
    One that does not add up is still left out: it may predate rows still to post, so it never
    shows a gap by itself. `between`, which proposals rely on, still takes only strong balances.
  - **An export's range.** The review page offers "It covers from … to …" for a document that does
    not print its period (`coversFrom`/`coversTo` on the draft section). Past exports are covered
    by confirming the stretches between them, with no re-uploads. So there is no control to edit a
    committed import's period.
- **Confirm all keeps to settled days** (added the same day). At first it took every stretch that
  added up, recent ones included, such as a card's last two days of a month. Those rested on a screenshot
  balance a card payment may not have posted to yet, and the next statement would cover them
  anyway. The owner chose the end of the month before last as the line, over 7 days (late posting
  only) or 40 (one statement cycle, which splits months). Recent days are the monthly update's
  job. A stretch is capped at that line rather than dropped, and each can still be confirmed on its
  own, marked "recent" when it runs past the line.

## 2026-10-02: What the month in review reads

- **Found:** the digest the analysis jobs read had not changed since data format v4. So the month
  in review could not see what the document overhaul stored: payslips in full, HMRC's records,
  jobs, account terms, agreements, pension arrangements and companies. It saw only their effect on
  transactions and categories.
- **Done:**
  - The digest carries the app's own checked views of them (AGENTS.md §2), not the raw records:
    - pay periods matched to the bank and to HMRC's figures, with the tax code check;
    - HMRC's tax codes, settlements, events, NI years and State Pension forecast;
    - each account's terms and the rates ending;
    - agreement payments due;
    - pension collections, including one whose first collection never came;
    - companies' valuations and dividends;
    - budgets and goals when there are any.

    On the owner's data this added about 13 kB, and the August digest is about 15k tokens.
  - PAYE references and payroll numbers stay out: the analysis has no use for them.
  - Insights may cite a payslip, HMRC record, agreement, company or job by id. These are new
    evidence types: additive, so there is no format version. Both write paths check that the record
    exists, and the insight panels link them to the Pay tab, Spending or Accounts.
  - The month in review's prompt names what to look for in each section, and says that anything
    dated after the month (a tax code issued since) is what has happened since. It is now
    `monthly-review-3`, and the post-import prompt `insights-after-import-4`.
  - No job was run on the owner's data to test this: the tests build the digest and apply a job's
    output without Claude.

## 2026-10-03: Categorisation that gets more right by itself

- **Found** (Oct 2025 to Sep 2026, on a copy of the owner's data):
  - 19% of spending and 46% of money in were uncategorised, and uncategorised money
    in counts as income.
  - American Express's own category was on almost all of its rows, but its "Group-Subgroup" form was
    never read.
  - Santander's and Chase's wordings left payees as whole descriptions, so one payee was many and
    regular payments were missed.
  - Money in from Trading 212, card repayments ("Payment") and card refunds counted as income.
  - Pay from a job before its payslips began was not salary, since its name alone was not enough.
  - Re-running categorisation on all history was unsafe: it lost the payees Claude had read.
- **Done** (FORMULAS.md §10; INGESTION.md, "Categorisation"):
  - payees from the banks' wordings, with the reference kept apart;
  - Amex's categories;
  - money in from investment platforms is a withdrawal;
  - a card's own repayments, and refunds onto a card in the purchase's category;
  - disputed charges and their reversals;
  - cash paid in;
  - conversion fees and the Underground;
  - pay under the name the bank gives a job's pay, learnt from payments paired with its payslips,
    never for a company recorded as a shareholding;
  - each step also reads what other documents said of the same payment.
- **Fixed:** a payee from elsewhere is kept unless it is the bank's wording or was cut from the
  description, and a general word in the merchant list no longer overrules Claude's category.
- **Re-apply to history** now shows what it would change, grouped, before anything is written (owner
  reviews before data changes).
- **Rehearsed** on a copy of the owner's data: hundreds of rows recategorised and payees tidied.
  Uncategorised spending falls by about two fifths, and money in by over two thirds. Most of what
  is left is money with people and the Student Finance credit, which later work handles.
- **Business costs** paid personally stay in personal spending (owner, 2026-10-03).

## 2026-10-03: Imports where every document finds a home

- **Found:**
  - Several Student Finance PDFs were read as "nothing new": the reader had no place for a schedule of
    payments, though the 2026/27 page shows the £1,236.70 maintenance instalment that was the one
    unexplained credit of September. Its instalments survived only in prose remarks.
  - A filed "nothing new" document could never be read again.
  - A full-history savings statement spanning a fixed rate and the easy-access account it became,
    under one number, was marked ready although it would re-add the fixed account's deposits.
- **Owner's decisions:**
  - Maintenance instalments are borrowing: a transfer from the student loan, not income.
  - Tuition paid straight to the university counts as education spending, when Student Finance
    pays it.
- **Done** (INGESTION.md, "Schedules", "Linked accounts", "Nothing new"; FORMULAS.md §3, §9, §10):
  - Reader rule 24 (`extract-15`): schedules of payments as structured records, never transactions
    and never "nothing to record".
  - A schedule is drafted as an agreement, new or filling in the one recorded. Agreements now carry
    money paid to you (`direction: "in"`) and payments a loan makes for you (`accountId`,
    `paidBy`), known by exact amount within 7 days.
  - Student finance's paid instalments become the student loan's rows: maintenance linked to its
    bank credit as a transfer, fees as education spending. The loan's derived balances are
    estimates, since its interest is on no such document.
  - Projections leave out spending a student loan pays for you, which stops with the course.
  - A reading that mentions recorded payments it had no place for is not "nothing new": read it
    again. A filed document can be opened again, drafted as the app drafts now.
  - Linked accounts (`Account.continues`, the `link_accounts` proposal): a statement across the day
    is split, with the balance carried over. Same-number duplicates and rows outside an account's
    open dates hold an import back. A section moved to another account is checked again.
- **Rehearsed** on a copy of the owner's data, with no Claude:
  - the two years' schedules pair every maintenance instalment with its bank credit, and the fees
    fall in the months the schedules give;
  - the Aldermore statement splits on the day the fixed rate ended, adding only the fixed account's
    interest and the easy-access account's own rows.

## 2026-10-03: Money with people, decided by you; rules from your decisions

- **Found:** money with people was most of what stayed uncategorised. Uncategorised money in counts
  as income, so family gifts, friends paying back their share of a trip, and your own money passing
  through someone else's account all looked like income. Payees you had categorised the same way
  several times had no rule, so each new payment came in uncategorised again.
- **Owner's decision:** most money from family is a gift, but not all of it. Nothing may file it as
  one wholesale: each payment is decided, past and future.
- **Done** (FORMULAS.md §10 "People", "Rules from your decisions", §14; DATA_FORMAT.md
  `people.json`, format 9):
  - Payments with people are found by the shape of the payment and the name, never you or your
    accounts. One person's variants are grouped by surname and first initial.
  - Each gets a suggestion with its reason, from the payment's own words, a share of a payment you
    made, what you said they usually are, or what you chose before. Only a payment's own words or a
    share not in round pounds tick it for you; nothing is categorised until you confirm it. Who it is
    from ("FROM NAN") is not taken for a gift.
  - Money paid back counts against spending: in what was shared, or in "Paid back to you", which
    offsets spending as refunds do (`offsetsSpending`, format 9).
  - Rules from your decisions are offered with what they would fill, kept to sizes like yours and
    never wider than your decisions; a rule you make applies only to what it matches. This changes
    what "apply" did for rules made elsewhere: it no longer re-applies everything unseen.
  - Your surname followed by your initials ("FROM TAYLOR SR") is you.
- **Rehearsed** on a copy of the owner's data, after re-applying: payments with several people
  wait to be decided (some ticked by their own words or amount), a few rules are offered, and the
  other uncategorised payments are left by payee.

## 2026-10-03: The month in review, worked out first and read in sequence

- **Found:** the month in review's digest gave today's estate for a month long past (well above
  what it was at August's end, with the ISAs on a valuation from the year before). It
  compared each category with a 3-month mean that one rent payment could swing, could not see
  borrowing, saving or one-offs, and did not know how well the month was categorised. Each review
  started from nothing: none read the one before.
- **Owner's decisions:** the earlier months back to the start of the data get reviews too, written
  before August's, as a chain; extra cost for better analysis is fine.
- **Done** (FORMULAS.md §18, §9; AGENTS.md "The month in review"):
  - A month's figures are worked out by fixed rules, once, for the Overview's new month card and
    for the digest alike: money in with borrowing apart, spending as scheduled, regular, one-offs,
    everyday and money back, where the net went, the estate at both ends with what each value rests
    on, how well the month is categorised, and each line against the median and range of the
    complete months before.
  - The balance engine says what each value rests on, so a value on an old valuation is never read
    as the month's change.
  - Version 4 of the review reads the month's figures, its 12 months, and the review before with
    its lines to watch, and writes lines for the next one. A review written later for an earlier
    month knows nothing after the month's end; only the latest month's review sees today's figures,
    labelled as such. A rerun replaces every note the month's earlier review wrote.
  - Earlier months are reviewed oldest first, on your click, never by a token.
- **Rehearsed** on a copy of the owner's data, with no Claude: August's figures add up to the cash
  flow to the penny, its worth at both ends is shown with the ISA marked as resting on an older
  valuation, and a review of the first month written later
  holds nothing dated after that month but values worked back from later valuations, marked as such.

## 2026-10-03: Cash and cheques paid in are yours to decide; the app's guesses are listed to check

- **Found:**
  - Categorisation filed cash paid in as money moving between your accounts. The owner says it is
    not always theirs: often it is a gift. Cheques paid in waited uncategorised, a payee to put in
    one category for all.
  - A card top-up to a business account took the card's own category, "Business
    Services-Conferences & Training", and became tuition.
  - Hundreds of payments took their category from a guess, the bank's
    category or the reader's suggestion. Nothing showed them for checking, and the month in review
    could not tell them from settled ones.
- **Owner's concern:** most re-categorisations are right, but future ones will sometimes be wrong.
- **Done** (FORMULAS.md §10, "Cash and cheques paid in" and "Guesses to check"; §18, "Quality"):
  - Cash and cheques paid in to current and savings accounts get no category but from a rule of
    yours. Each is listed first on the To categorise page's People tab, with a suggestion and its
    reason; none is ticked:
    - your own cash back, when you took out as much in the 30 days before;
    - a gift, from a week before Christmas Day or your birthday to a month after;
    - otherwise a gift, marked "check".
  - **Guesses to check** lists the payments the bank's category or the reader's suggestion
    categorised, by payee and category, the largest first, each to confirm or change. "Always"
    makes a rule, so the next ones from that payee are categorised by it, not guessed.
  - A month's figures count cash and cheques still to confirm beside people's payments, and the
    share of spending and money in resting on guesses. The Overview's month card says so when over
    5% of spending is guessed.
  - Version 5 of the month in review checks a guessed category against the payment's description
    before resting a finding on it, and says when much of the month rests on guesses.
  - The owner had not seen Gifts received, and put gifts to them in Gifts, which is spending. For
    money in, the category picker now lists the income categories first. The transaction editor
    says that money in under a spending category lowers that spending and isn't income, and
    points a gift to Gifts received. A rule can now be made for money in only, or money out only.
- **Rehearsed** on a copy of the owner's data, after re-applying:
  - cash and cheque payments in to decide, a few of them recent;
  - payee groups of guesses, the largest a rent payment the reader categorised;
  - guessed spending varies widely from month to month, most of it a few large payments.

## 2026-10-03: Re-applying categorisation shows every payment, and takes your choices

- **Owner:** the preview should show the payments behind each change and let them override any,
  with the override counting from then on. The button should say it only previews.
- **Done** (FORMULAS.md §10, "Re-applying categorisation"; INGESTION.md, "Categorisation" and
  "Transfers"):
  - The button is **Preview re-applying to history**. Each group of the preview opens to its
    payments by payee.
  - Any payment, or a payee's at once, can be left as it is this time or given a category of the
    owner's. "Always" makes a rule for the payee, saying how many payments it matches in all.
  - Applying writes the owner's categories first, as theirs, so re-applying never changes them
    again and they count toward the rules To categorise suggests; then the new rules; then the
    rest, leaving out what the owner left as it is.
  - A payment the owner put in a category that isn't a transfer is never linked as a transfer. A
    gift the owner sent had been paired with a gift they received as money moving between their
    accounts.
- **Not done:** a payment left as it is is offered again next time. Recording "not that category"
  would need a new field, and giving it a category of your own does the same job.

## 2026-10-03: Proposals make rules and categories, and confirm guesses

- **Owner:** an agent should propose as much of the categorising as it can, rules included ("can you
  propose rules? If not, add that feature"). A group "Advertising", made by mistake, should become
  "Business" with an Advertising category in it, by a proposal. And it should be easier to tell
  adding a group from adding a category: that is how the mistake was made.
- **Done** (AGENTS.md, "Proposing fixes"; DATA_FORMAT.md, "proposals"; FORMULAS.md §10):
  - Three new changes. `add_rule` makes a rule as Settings → Rules does, and shows the payments it
    categorises now and the owner's own it leaves. `add_category` adds a group or a category in
    one. `change_category` renames one or moves a category to another group. They run in order
    with the rest, so one proposal can add a group, move a category into it and categorise
    payments with it. The categories a proposal changed are kept as they were, with its rows.
  - `set_category` on a row the bank, the reader or the app's own patterns put in that category
    already confirms it: the category becomes the owner's. Before, it was refused as already so,
    so a proposal could not settle a guess that was right.
  - A category or a proposal's category alone never categorises the next payment from the payee:
    only a rule does. To categorise now offers a rule for the next ones when the owner decided
    every payment from a payee paid in the last year, where before it offered one only when there
    were payments left to fill. So deciding a payee's payments one by one, by hand or by applying
    a proposal, leads to its rule in one click.
  - A rule's words match however a bank spaces a description: a run of spaces counts as one. The
    owner's rule for their barber, made from the Amex payee, missed the same barber on another
    card, whose description is not padded.
  - Settings → Categories asks first whether to add a category or a group, says what each is, and
    needs a group chosen for a category. A group can be renamed, and an empty one says so. Before,
    a name typed with the group left as "(new group)", the default, became a group.
- **Not done:** jobs that run in the app (the month in review among them) still write notes, not
  proposals, though each is given the proposal service. Having the month in review propose the
  fixes it finds is a prompt change and a new output, for the owner to ask for.

## 2026-10-03: Rules to make suggests only rules that make sense, and ends when you answer

- **Owner:** check the rules To categorise suggests make sense, and find why a suggestion stays
  after "Make this rule".
- **Found:**
  - The owner changed "Uber → Holidays" to Taxis and made it; the card stayed, so they made it
    again (two identical rules). The suggestion was recomputed from the same three decisions in
    Holidays, and its other Ubers were still not in Holidays.
  - The three were Ubers on a trip (a proposal put a trip's spending in Holidays). Rules from such
    decisions would have made every Uber, and every McDonald's, a holiday: the "too wide" check only
    counted the owner's own categories elsewhere, not the many the merchant list files as taxis. Its
    match, "Uber" across its range of amounts, also took Uber Eats orders from Takeaway into Taxis.
  - Rules "for the next ones" came for a trip's one-off cafés and shops (a convenience store, a ride
    app's wallet, one café abroad paid five times in a day), for pay the app files as salary already,
    and for a former landlord whose rows share the payee "BP" with fuel.
  - HSBC ends a row with its type, "BP" for a bill payment; the merchant list read it as BP fuel
    (two HSBC card payments and a top-up to the owner's Lloyds account, as fuel).
- **Done** (FORMULAS.md §10, "Rules from your decisions", "Changing or deleting a rule"; AGENTS.md;
  DATA_FORMAT.md):
  - No suggestion for a payee an enabled rule of the owner's catches, whatever its category: making
    the rule ends the suggestion. The card says the rule is made at once, so a second click can't
    make it twice, and says what making it would move, by category, before the click.
  - No suggestion when the app files the payee elsewhere more often than the owner put it there,
    nor when a rule would move more payments the app settled than the owner decided. A rule's
    fills leave out what a rule of the owner's catches.
  - A rule for the next ones needs decisions in two months or more, one in the last year, and the
    app not already getting the newest right by itself.
  - Switching a rule off or deleting it gives back what it categorised (before, its payments kept
    its category). A proposal can remove a rule (`remove_rule`), showing what each payment becomes.
  - A "BP" that ends a description is not the fuel brand.

## 2026-10-03: Chase's "Outgoing transaction" rows take the app's names

- **Owner:** what are the "Outgoing transaction" payments? See the pending screenshots and the
  Chase statements.
- **Found:**
  - One month's Chase statement prints nine card payments as "Outgoing
    transaction", with no merchant and no "Purchase" line, dated the day each posted. Every other
    Chase statement names every payment. The reader read it right.
  - Chase's app names them, dated the day each was made. The screenshot shows three: ALDI £3.15,
    eBay £48.20 and TfL £2.80, on the month's last days. The six before them (all small) are below
    where it stops.
  - Its draft matched only eBay to its "Outgoing transaction": a payment under £20 described
    differently is taken as another payment, so ALDI and TfL were new and would have been counted
    twice. Matched, the app's name would not have categorised the row either: it was worked out
    before the name was kept. And the cancelled card checks it shows (a bus operator's and a ride
    app's, a few pence each) were drafted to be recorded.
- **Done** (INGESTION.md, "Duplicates", "Adding detail to a recorded payment", "Cancelled rows"):
  - A row that names no one ("Outgoing transaction", "Incoming transaction") is similar to any
    description in the fuzzy match, whatever the amount.
  - What a matched document calls the payment counts in working out its payee and category, on the
    review page and on commit. Its details are ticked by itself when the record names no one.
  - A row the reader says was cancelled or declined is drafted left out, like a pending one.

## 2026-10-03: Committing an import keeps everything a matched row adds

- **Owner:** must anything be done on the review page, beyond committing, to get the most from an
  upload?
- **Found:** yes. A possible duplicate's details (when a card was used, its time, a foreign amount)
  were added only when ticked, and only a certain match ticked them. On one Chase statement,
  payments recorded from the app's screens would have lost their foreign amounts, and on other
  screens, when each payment was made. The two cancelled card checks still counted as
  rows the reader was unsure of, holding the screens back from "Commit all ready" though they were
  left out.
- **Done** (INGESTION.md, "Adding detail to a recorded payment", "Cancelled rows"):
  - A match on like words whose details don't conflict ticks them by itself. A match on the same
    money described differently, or with details that disagree, still waits.
  - Cancelled rows are a note ("cancelled: left out"), not a warning.
  - "Car park" is parking.
- **Not done:** possible duplicates still hold an import back from "Commit all ready". A statement
  dates a payment when it posts and the app when it was made, so the same payment is a few days
  apart; two payments of the same amount at the same place a few days apart look the same (two Example
  Sport bookings in a week). Only the owner can tell them apart.

## 2026-10-03: A payment its statement names no one for is shown, and found, by the app's name

- **Owner:** the £2.40 of 3 May was hard to find: its title was still "Outgoing transaction", on
  4 May, with the café's name only in its details.
- **Found:** committing the screens gave the payments the app's names only where the merchant list
  knows the brand (Aldi, eBay, TfL). The other six kept "Outgoing transaction" as their payee, even
  with a category from the name (a pharmacy, a pub, a car park). Search looked at the description
  and payee, not at what other documents called a payment. Lists showed only the day it posted.
- **Done** (INGESTION.md, "Adding detail to a recorded payment"):
  - When a payment's own description names no one, its payee is the name another document gave it,
    with a card reader's tag (" - Zettle / Paypal POS", "- CCV Payments") taken off. Re-applying
    categorisation brings this to the payments already recorded (they show as payees tidied).
  - Searching transactions matches the names other documents gave a payment, and the merchant's.
  - The transaction lists show the day a payment was made under its date when it differs.
- **Not done:** a payment still counts in the month it posted (a fare paid on a month's last day is in
  the next), as its statement and balance have it.

## 2026-10-03: Guesses to check, and why they were guesses

- **Owner:** look into "Guesses to check" and propose what it needs.
- **Found:** payments categorised from a guess (the reader's or the bank's), most of them right.
  - Some were guesses only because a pattern missed how a card spaces a brand ("SPORTSDIRECT",
    "Lasiguanas") or names Kraken by its company (Payward).
  - Some payees were split by what a card adds: Starling's rate abroad made three payees of one metro
    abroad, and Capital One's "on 01 Sep" stayed in a payee.
  - Amex's "General Attractions" (a cathedral's entry) went to Hobbies.
  - Rows from a banking app's list name only the other party, with no type. So £15 from a
    relative was not seen as money from people: it sat in the guesses as a move between accounts,
    not on the People tab.
- **Done:**
  - Proposals for all the guesses: going out; shopping, services and money; trips (one abroad, and
    the euros taken on another).
  - The patterns match "SPORTS ?DIRECT", "LAS ?IGUANAS" and "PAYWARD".
  - Payees leave out Starling's rate and Capital One's day (FORMULAS.md, "Payees").
  - Amex's "General Attractions" is Events & tickets.
  - Such a row with no type is a payment with a person when it says no more than their name, or
    names someone saved (FORMULAS.md, "People"). Someone saved is found however a payment writes
    them: an app's "Reed Al&S" for the bank's "REED AL&S", which did not read as a name.
- **Not done:** the merchant list still reads only descriptions, not the merchant name a bank gives
  apart (Monzo's "Payward Services Ltd." beside a reference). A rule on the payee covers Kraken.

## 2026-10-03: One rule for missing days; linked accounts checked and named by date

- **Owner:** after the Aldermore statement went in, fix what the review of it found: one rule for
  whether data is complete, a split that gives rates only to the part they are dated in (and a way
  to take away the rate it misplaced), payees around linked accounts, and guards for linked and
  closed accounts.
- **Found:**
  - Four rules said whether an account's data covered a period, and they disagreed. Data health
    looked back 13 months. The Tax year page ignored the stretches the owner had confirmed (Chase
    flagged for 2025/26), needed one unbroken stretch (HSBC flagged for days whose balances add
    up), and blamed "before your data starts" for gaps inside a year. Self Assessment judged by an
    account's first and last row, so a savings account paying interest once a year looked
    uncovered after its last interest. The capture list ignored confirmations and 4-day gaps.
  - A statement split at a link gave its older part the rate printed as at its end: the fixed rate
    was recorded as paying 1.50% from 1 Mar 2024 (it paid 5%). No proposal could take a terms
    record away.
  - The categoriser never named a closed account, so the fixed rate's first deposits from the bank
    were named for the easy access, which did not exist yet. Re-applying never touches linked
    transfers, so that could not right itself.
  - Nothing checked that a linked account starts from what the other ended with, or that a closed
    account's money left it: the first year's interest was missing for a year without a sign.
- **Done** (FORMULAS.md §3 "Missing days", §9 "Linked and closed accounts", §10; INGESTION.md
  "Linked accounts", "Categorisation"; DATA_FORMAT.md; AGENTS.md §5; UK_RULES.md):
  - `missingDays` is the one rule, used by Data health, the Tax year page (with each account's
    missing days, whether they add up, and what settles them), Self Assessment and the capture
    list. Statement periods, confirmations and the owner's rows count; a year still settling needs
    its days to the end of the month before last; an account with no opening date whose data starts
    more than 45 days in may have been open before.
  - Data health looks back to the start of the oldest tax year whose return can still be corrected
    (`oldestOpenTaxYear`: 12 months after the 31 January deadline, from GOV.UK), lists accounts with
    no data, and the valued accounts a tax figure rests on (ISAs, pensions), whose days can be
    confirmed too. Older stretches are listed apart.
  - A split statement's older part keeps only its rows, ending on its last day with its running
    balance; the rate, limit and other figures as at the statement's end are the newer account's.
    The `remove_terms` proposal takes away terms a reading gave the wrong account.
  - Account naming follows the row's date: a closed account while it was open (and 7 days after),
    and of two accounts a number or alias names, the one open that day. A bank's name alone never
    chooses between open accounts: rehearsed on the owner's data, it would have named the Chase
    saver for a payment to Santander that carried "Chase" as a reference.
  - A transfer's payee naming another account of the owner's than the one it is linked with takes
    that one's name, on linking and when re-applying (listed in the preview, each can be left).
  - Data health shows each link with what carried over, and closed accounts that still held money
    with nothing carrying them on; the Overview warns of either. Account pages show the link.
  - Closing an account from its page uses today's date where the owner is, not UTC.
- **Rehearsed** on a copy of the owner's data: the savings hand-over adds up to the penny;
  re-applying would rename the fixed rate's first deposits and name the card a direct debit paid;
  each tax year lists the accounts still missing days, with how many, and the latest is complete.
- **Not done:** an account's id cannot be renamed (`new-account-1`); the categoriser does not yet
  read an account's own name as an alias ("From Chase Saver").

## 2026-10-04: A confirmation can say why; a prize is never the other side of a transfer

- **Owner:** two small accounts will get no statements (there was next to no
  interest); confirm their days with a note, so the tax pages say what the figure rests on. Fix the
  Premium Bonds prize linked as a transfer, in the data and in the code.
- **Found:**
  - A stretch confirmed with no balances to show it (an account with no data, a valued one) counted
    as covered with nothing on the tax pages saying so: the interest figure would have looked
    complete. The API took a note, but the page never asked for one.
  - The £25 prize reinvested on 2 May 2025 was linked to a £25 payment "to James Ashby" the
    day before: one row naming the owner and its transfer category were evidence enough, though
    the app knew the other row as a Premium Bonds prize.
- **Done** (FORMULAS.md §3 "Missing days"; DATA_FORMAT.md `coverage.json`; INGESTION.md
  "Transfers"):
  - Confirming one stretch in Data health asks why (optional), and the confirmation keeps the
    note. The Tax year page lists, under each figure, the days counted as nil on a confirmation
    whose balances do not show it, with the note; Self Assessment says the same beside the
    interest. Confirmations whose balances add up are not listed.
  - `transferEvidence` rules out a row the app knows by its own wording as someone else's money (a
    built-in category that is not a transfer) when it says nothing of the owner's accounts or the
    owner. Cash withdrawals are left out of that, as cash can go into a cash account.
- **Rehearsed** on a copy of the owner's data: of all the links, the new rule would have refused
  only the prize. The prize and the PayPal direct debits filed as subscriptions (each paid PayPal
  Credit for a charge already counted there) are fixed by proposals the owner
  reviews.

## 2026-10-04: The month in review, rebuilt for the August run; investments valued between valuations

- **Owner:** the catch-up reviews were checked. Improve the job and how its results show,
  significantly, before the August run. Use the latest ii uploads and
  public prices to fill the investment gaps; frequent captures will make that unneeded later.
- **Found:**
  - The reviews' sums were right, but they read as a check of the app. A third of each repeated
    standing caveats or recited the figures table. A third of the watch lines tested how the app
    filed something. "Done" and "still open" meant different things in different reviews.
  - They could not see below line totals (no categories or payees over time), nor where the money
    went in a way that adds up, nor who "accounts the app doesn't know" were. They found wrong data
    but could not propose a fix.
  - The ISA had no valuation for over a year. Its month ends were the older value plus
    contributions, well below its value by the end. The SIPP was low too, and the LISA rolled back
    with no growth.
  - ii's monthly membership, by direct debit, was left out of spending as an in-account fee,
    and showed every month as money sent to an unknown account.
  - ii's statement posts a trade on its settlement date and its export on the trade date: the
    same trade would have been added twice.
- **Done:**
  - **Between valuations** (FORMULAS.md §9): a market account's value between two valuations is
    its holdings path when the trades and prices allow it. That is the units held each day, from a
    holdings snapshot walked through every trade, at published prices, with its cash, adjusted to
    meet both valuations. Failing that, a price index of its holdings. Failing that, one steady
    rate on the money in it. Before the first valuation, the same, rolled back. Prices are research
    of a new kind, `instrument.prices`: the funds and ETFs held, weekly and month-end closes over
    the accounts' history, from public quote pages, by identifiers only. Rehearsed: the ISA's path,
    walked back over a year from its latest holdings, lands within 0.2% of the earlier statement.
  - **The month summary** (§18): "Where it went", item by item, adding up to left over plus
    borrowed, with the unknown accounts named; spending by category group and the largest
    categories against typical, with each of the 12 months. A platform fee paid from a bank
    account is spending (§14).
  - **monthly-review-6** (AGENTS.md): digest version 5 (the year's payees, trips, every earlier
    review in short with the limits it raised), and a file of 24 months' payments it searches with
    Grep and Glob, confined to its scratch directory. Its output is a headline, 3 to 5 key points
    with evidence, parts in a fixed order, new limits only, watch lines about money and decisions,
    and outcomes as happened / did not happen / cannot tell. It may propose up to 3 fixes
    (`set_category`, `add_rule`, `set_note`). Every £ figure is checked against the data; it is
    asked once more with any not found, and what is still not found shows beside the review.
  - **The display:** the month card shows the headline, key points with evidence, parts that open
    and close, "What this rests on", fixes proposed, figures not found, outcome chips, and a note
    with the thumbs. A new Reviews page lists every month's review. The card takes `?month=`.
  - Claude and AWS keep one payee name however the card prints them; a payment id before a name
    and Santander's fee wording on a foreign payment leave payees. Duplicates rule 2b: the same
    amount and description with the same printed date, up to 10 days apart.
- **A holdings page's total** (owner: "I shouldn't have to untick values"): ii's holdings PDF and
  a SIPP statement gave the funds' total, with no cash, and it was recorded as the
  account's value (short by the cash each held). Such a value is now recognised (its import's
  holdings add up to it and neither shows cash) and stands for itself plus the cash the account
  held that day (FORMULAS.md §9, "Investments alone"); the review page says so. No reading change
  or migration: the figure is kept as read.
- **Not done:** the workplace pension and company shares have no holdings or prices, so
  they stay at their last valuation. Prices are not refreshed by a job; captures are meant to make
  that unneeded.

## 2026-10-04: Model work moves to the local model service, task by task

- **Owner:** a shared, OpenAI-compatible model service (`inference`, on the owner's machine, tailnet only) now
  runs Qwen3.6-35B-A3B and smaller models. Decide with the owner which of finance's model work
  moves to it; documents then never leave the machine.
- **Measured by inference on finance's own samples** (its README §9 and BENCH "M2"): 99.4% / 99.3%
  of fields right on synthetic / real documents with prompt extract-8, every wrong reading failing
  reconciliation; a median 2.7 min per document, 28 min for a 7-page card statement; a second
  reading with thinking on (16k budget) fixed 5 of the 10 imperfect ones in 4–34 min. Categorising
  merchants 20/22, own-account transfers 9/18; Q&A over about 210 rows 5/6 with thinking on, about
  5 min each.
- **Found here:** nearly half of the documents Claude read had a second reading, mostly because nothing
  on the document confirms its figures (tax figures, screenshots without totals), not because a
  check failed. Claude reads in a median 12 s (Sonnet) plus 16 s (Opus); the local model takes
  minutes.
- **Decided (owner, 2026-10-04):**
  - One task table (`src/shared/tasks.ts`) says, for each piece of model work, what it needs
    (vision, web, reasoning), its privacy class, its default engine and model, its priority and
    timeout. Settings → Models overrides it per task. It replaces `extraction.engine/model/
    verifyModel/effort` and `agents.model/effort`; format v10 migrates them.
  - **Local** (decided, gated on the evaluation below): reading documents (first and second
    reading, reading again), receipts, naming imports and understanding notes. **Claude stays** for
    the month in review, insights after imports and the three research jobs (they need web tools,
    which the local model does not have).
  - **Second readings stay local:** when the checks fail or nothing confirms the figures, the
    document is read again by `vision-extract` with thinking on, compared and the better reading
    kept, as before.
  - **When the local model cannot** (down, its GPU lent out, or both readings fail): the work
    waits and retries (up to 12 hours), and each import offers "Read with Claude". A per-task
    switch, off by default, falls back to Claude by itself; it sends the document to Anthropic.
  - **Priorities:** `batch` for everything that takes minutes, `normal` for a note, `interactive`
    only for a question asked in the app.
  - **Provenance:** each reading and record keeps the service's request id, alias, model sha256,
    system fingerprint and seed beside `model`; sessions keep the whole provenance object.
  - **Bake-off aliases** (`chat-q8`, `chat-9b`) can be chosen in Settings, marked as experiments
    that swap the GPU, and in `npm run eval -- --engine inference --model …`.
  - **New:** suggesting categories for the payments the rules leave (`fast-chat`, one row per
    request, as proposals the owner reviews) and asking questions over computed tables (`fast-chat`
    with thinking on).
  - CLAUDE.md's privacy invariant names the service: personal data may go to it, and it gets no
    web tools.
- **Considered:** a fallback to Claude by default (rejected: it sends documents to Anthropic
  without asking), no second reading for documents with nothing to check (rejected: half of all
  documents would go unchecked), keeping the old settings beside an overlay (rejected: two places
  would decide).
- **Built** (ARCHITECTURE.md, "Models per task"; INGESTION.md, "The local model: waiting, Claude,
  and balance lines"; AGENTS.md §7):
  - `src/server/inference.ts` is the client: one batch or normal request of finance's at a time
    (the service has one slot for them), retries after the service's `Retry-After` for up to
    `INFERENCE_WAIT_MINUTES` (720; 10 for a question), and fails at once on any other refusal,
    output cut off, or output outside the schema.
  - What a reading put right or did another way (a balance line left out, Claude reading instead)
    is a *notice*, shown with the warnings but not counted against the reading, so it calls for no
    second reading. Only warnings are problems (verify.ts).
  - "Read with Claude instead" stops a reading under way (`reprocess` with `interrupt`).
  - Receipts read on the local model run in the background (`status: reading`); the prompt now
    says how the receipt arrives (`receipt-2`).
  - Suggestions leave out what To categorise → People and cash keeps for the owner (payments with
    people, cash and cheques paid in) and valued accounts, ask once per description and direction,
    and propose only medium or high confidence. They start only when the owner presses *Suggest
    categories*.
  - A question's answer is kept in memory only, labelled as an inference, and is given the
    analysis digest (computed figures), never documents.
  - Rehearsed: the v10 migration on a copy of the owner's data changes only `meta.json` and
    `settings.json`.
  - Found while evaluating: Node's `fetch` gives up on a response whose headers take more than 5
    minutes (undici's `headersTimeout`), and the service answers a long reading only when it is
    done, so every long reading was cut off and sent again. Requests now go through `node:http(s)`
    (`postLong`), ended only by their own timeout, and a connection that drops twice mid-answer
    fails instead of running again.
- **The gate** (agreed before building: at least 98% of fields, and every wrong reading caught by
  a check): `npm run eval -- --everything --engine inference` on 40 documents (`extract-15`,
  eval/results/2026-10-04-16-46_extract-15_local-v10.json): **98.9% of fields**, 275 of 280 rows,
  4.9 hours (Claude, Sonnet checked by Opus: 100% on 36 documents in about 4 minutes, $2.90).
  Wrong figures (two pension contributions, an ISA's and a LISA's allowance read as tax, five
  Premium Bonds prize rows missed, a long scroll's date) were each marked as a disagreement
  between the two readings. **It failed the second bar:** a LISA fund page went to another
  provider's existing account; four statements' periods were left blank (rows and balances right);
  two screenshots lost their foreign amounts; two made a new account instead of matching (visible,
  and held back from "Commit all ready"). None of these failed a check.
- **Owner (2026-10-04), on that result:** ship the plumbing now, with documents, checking and
  receipts on Claude (format v10 keeps the reading choices as they were) and import names and notes
  on the local model; fix the silent misses on the finance side, run the local evaluation again,
  and move documents only when it passes. Suggestions and questions, being new and started by the
  owner, run locally.

## 2026-10-05: Documents move to the local model, except NS&I's

- **Owner (2026-10-04):** fix what the local model's first evaluation let through unnoticed, run it
  again, and move documents only when it passes.
- **Fixed:** rules for the local model only (`LOCAL_RULES`, `local-1`: the statement period,
  foreign amounts in every reading, a fund's manager is not the provider, the document's own date);
  a provider named only by the start of a fund's name no longer decides the account, for any
  engine; the evaluation pins the check to the reading's engine (one run, by that bug, was checked
  by Opus and spent $2.70 of the Claude plan; its results were discarded).
- **Evaluated** (`npm run eval -- --everything --engine inference`, 40 documents, every reading and
  check local, $0; eval/results/2026-10-05-04-19_extract-15_local-v10-local1.json): **99.3% of
  fields**, 271 of 280 rows, 5.4 hours. Every wrong figure (an employer pension contribution, a
  LISA's allowance read as tax, pension figures without their tax year, missed Premium Bonds prize
  rows) was marked as a disagreement between the two readings. Not marked: a credit card's 0%
  balance-transfer rate left out of its terms, and a Revolut screen made a new account (which the
  review shows, and which keeps it out of "Commit all ready"). NS&I's Premium Bonds screens scored
  50% and 29%.
- **Owner (2026-10-05):** move documents, checking and receipts to the local model, and have Claude
  read NS&I's documents (`read-document`'s `claudeFor`, a switch in Settings → Models). A document
  is known to be NS&I's when it is dropped onto an NS&I account, or once the local model has read
  it; Claude then reads and checks it, and the review page says why.

## 2026-10-05: Every session can be stopped, and shows everything it was given and gave back

A review of how sessions are recorded found the local model's answers hidden on
session pages, no way to stop a run, job inputs deleted, and fallbacks unlinked. The owner approved
all of it. First part:

- **Shown:** the local model's answer, reasoning and timings; each session's output as returned;
  Ask answers under "What it produced"; spreadsheet text and image pages sent to the local model;
  suggest-categories' prompts.
- **Stop** on every running session, through a signal each engine honours. Stopping discards what
  the run would have produced and keeps its transcript (owner's decision).
- **Recorded:** the request that started a session, the data commit it ran on, the session a
  fallback stood in for, a job's checks and what it applied, and its input files (gzipped, 90 days,
  owner's decision).
- **The transcript's SHA-256** is in the session's end row of the hash-chained audit log.
- A session's audit rows stay rows of their own and name the request in their details: folded into
  the request's row, a job's session (started long after the request answered) would vanish from
  the log's default view.

## 2026-10-05: Ask looks things up with the app's tools, in conversations of its own

"How much did I spend on holiday?" took 6.5 minutes on the local model and answered that it could
not say. It had been given only a fixed digest (16,000 tokens: the last 30 days, the largest
payments, monthly totals), though the payments were in the data, in a foreign currency, categorised Holidays.
Ask v2 (`ask-2`), as the owner decided it:

- **Tools, not a digest.** A small opening (accounts, categories, months, trips; about 2,000
  tokens), then a step loop: the model calls read-only tools built from the app's own code, and
  quotes their sums. A schema step loop works on the local model and the Claude CLI alike; native
  tool calls come later.
- **Figures checked.** A figure is marked computed only when the app finds it in the result of the
  step it names. The rest is shown as the model's.
- **Conversations** in the work area for 90 days; Delete hides (the owner's choice). Follow-ups
  queue; Stop works at any point; one turn at a time.
- **The model is the owner's pick per question** (the local model by default; Claude if picked).
  The tool-call cap is a setting, 8 by default. It ships on: it runs only when the owner asks.
- **"This is wrong"** builds the evaluation set the next prompt version must pass.
- Suggested questions are computed by fixed rules, with no model.
- **Checked on the real service** (4 interactive requests on `fast-chat`, thinking off, invented
  data): the flat schema with nullable types is accepted (`schema_valid`), and the stream parses
  (first text after about 9–12 s on a 1,100–1,600-token prompt, about 25 s a step). Two things it
  showed, now held by the app rather than the prompt: it answered "cannot say" before looking, so
  a question's first step must be a call (the schema allows only that); and it sent a search with
  every argument null while its `why` named the currency, so a search with no filter is refused
  with a message saying so, and the next step corrects it.

## 2026-10-05: Agents outside the app are seen by their own sessions

- `npm run api` sends `X-Agent-Session: $CLAUDE_CODE_SESSION_ID`. The token log keeps it, with the
  query string (account numbers masked) and the answer's size; the audit log's token actor names
  it. The Agent sessions page groups a token's requests by it, falling back to 30-minute stretches
  for requests without one. Claude Code's own transcript stays out of the app (the owner's choice).
- `npm run records write` goes through `POST /api/records` with the token, so the audit log knows
  who wrote it, and stamps `provenance.session` with the Claude Code session. It writes the files
  itself only when the app cannot be reached, there is no token, or `FINANCE_DATA_DIR` names another
  directory (the demo, a copy), and says so.

## 2026-10-05: Totals and search on Agent sessions

The last part of the research (§3, "Overview"): a Totals card (sessions, failures and stops,
tokens, Claude at API prices labelled as an estimate on the plan, local model time, by month, work
and engine) and a search inside transcripts, run on the server within a time and size budget.

## 2026-10-05: The first real question on Ask v2

The owner asked a year-on-year question about one card's spending (local model,
thinking).

- **What worked.** It looked rather than guessed: one `spending_by` call (the card, by month, both
  years), the right tool and arguments, with the app's sums in pence. It took 1 minute 42 seconds
  (13 s reading a 4,200-token prompt, 3,385 of them already cached; 35 s writing), against 6.5
  minutes for the digest-only `ask-1` question that could not answer. The session, its step and
  its answer are all on the Agent sessions page.
- **What did not.** It then added the months up itself, against the prompt's rule, and both yearly
  totals it gave are wrong (one by more than £1,000; checked against the step's own result). Its
  headline ("more in 2026") contradicts its own figures, and it made a year-end projection the app
  never gave. It labelled its confidence high.
- **The guard held.** Both figures are marked on the page as the model's own, not in what the app
  gave it: the check this version added is what tells the owner not to trust them.
- **What follows.** A rule in the prompt does not stop the model adding up. The app should give the
  sums a comparison needs, so there is nothing left to add: `spending_by` by month to give totals
  by year (and the period's total, which it does), or a comparison tool. A figure the app cannot
  find should also lower the answer's confidence rather than leave it as the model set it.

## 2026-10-05: Ask gives the model the totals a question needs (`ask-3`)

What the first real question showed (above), built:

- **Nothing left to add up.** `spending_by` by month gives totals, averages and completeness by
  year, and what was paid and refunded (a refund month no longer reads as a puzzle); a new
  `compare` tool gives two periods' totals (by default the same dates a year earlier), their
  difference, change and verdict, whether each is complete, and the categories that moved most;
  a search across years gives each year's totals; the opening gives this year to date, last year
  to the same date and last year whole. Formulas in FORMULAS.md §19.
- **The prompt** forbids sums, averages and forecasts of its own, sends comparisons to `compare`,
  and asks that the headline agree with the figures.
- **A figure the app cannot find lowers the answer's confidence to low**, keeps the model's own
  beside it, and adds a caveat saying why.
- **Agents may mark an answer wrong** (a token with `records`; it changes no data, and names who).
- **The gate** (`npm run ask:eval`, on a copy of the data in a throwaway directory): the one answer
  marked wrong, asked again on `ask-3` (local model, thinking, 168 s), made one `compare` call and
  answered the right way round, every figure the app's, saying which days at the end were not in
  yet. Passed; shipped.

## 2026-10-05: A period with nothing in it covers no days

The student loan's balance page prints a "2026-27 summary" of what
was repaid and the interest added since 6 April. One reading took that as the page's period
(6 April to 4 October), the other left it out, so the import was held for a disagreement. Kept, the
period would have counted the loan as complete for six months from a page that lists none of its
payments, and Data health would no longer have said if one was missing.

- **The draft keeps a period only with rows or an opening balance** (`draft.ts`). With neither, the
  period is dropped with a note, both readings agree, and the page records its balance and rate.
  Every committed statement with a period and no rows had an opening balance, so none would change.
- **Not a prompt rule.** A rule for the local model needs its five-hour evaluation; this is a
  deterministic rule about what counts as coverage, so it belongs in the draft.

## 2026-10-06: A local rule for summary pages, tried and dropped

The loan's balance page was read by the local model as three rows
(its "2026-27 summary": interest added and two £0.00 repayment lines), dated at the balance's date
or at 6 April, and held for the disagreement. A rule for the local model only (`L5`, `local-2`)
was tried against a new evaluation case, `pdf-student-loan-balance`, an invented copy of the page.

- **Three wordings.** Telling the reader a summary of totals is never rows also stopped it
  recording the figures in such boxes: an ISA's subscriptions this tax year, a pension's
  contributions, a card's rates. Naming only pages with no movements of their own (the last
  wording) kept those, and made no rows of the loan page in every run.
- **Why it was dropped.** A payslip is a page with no movements too: on the last wording the
  payslip scan lost its deduction lines or its tax figures in all three runs (84.8%, 82.1%,
  84.8%; 100% in every run without the rule), and the Amex statement its opening balance in three
  of five. The full run scored 99.1% against 99.3%
  (eval/results/2026-10-06-17-47_extract-15_local-v10-local2.json). Each loss was marked as a
  disagreement, but payslips come monthly and feed the tax pages; the loan page is rare, and its
  invented rows are already marked and held. The local rules stay at `local-1`.
- **Kept.** The evaluation case (it shows the loan page still read as rows at times). A local
  evaluation now reads NS&I's documents locally too and stops if any document reaches Claude: one
  run of this work sent the six NS&I cases to Claude through `read-document`'s `claudeFor` and
  spent $0.94 of the Claude plan (its results,
  eval/results/2026-10-05-19-19_extract-15_local-v10-local2.json, are not a local measure).
- **What handles the page meanwhile.** The draft keeps no period without rows or an opening
  balance (DECISIONS 2026-10-05), so a summary's dates never count as covered; rows a reading
  makes of a summary are marked as a disagreement and are yours to untick.


## 2026-10-08: A pension provider's own exports, and payroll pension money counted once

Four exports from a workplace pension's site (its trade history, current investments, and two
contribution summaries) were uploaded together. Two failed ("no date and description column"), the
history's columns were guessed (the fund's name as the description, so no row was categorised),
and the holdings were dated by the file rather than their "Price Date". A rehearsal on a copy of
the data showed what committing them would have done: once categorised, the year's pension
contributions counted twice (the account's rows and the job's payslips); the projection kept paying
in after the job had ended; and a contribution taken from a tax year's last pay but invested in the
next was counted again after a statement at the year's end that already held it.

- **New readers** (`ingest/pension-csv.ts`): a fund trade history (units and price kept, its total
  lines a check that makes it the whole history to the day it was downloaded) and a contributions
  summary (figures since the start, or this tax year's when its file name says so). They are
  generic headers, not one provider's profile: other providers' exports have these columns too.
- **Type before description** for wrapper flows: the description of a switch into a "Fixed
  Interest Fund" says interest.
- **Payroll pensions** (`analytics/payroll-pensions.ts`): a row that is a payslip's deduction and
  the employer's together, to the penny, within 62 days, is that payslip's money, counted in its
  tax year and split as it splits it. The job's link to the account is found from the money when
  neither names the other, so no proposal or setting is needed for it. The match is exact to the
  penny on purpose: a near match is not evidence.
- **Ended jobs** stop their payroll money in the projection. The job's end date comes from HMRC's
  record when you have not set one.
- **Valuations that hold later flows**, and **summaries that prove a start**: only when a stated
  total is matched to the penny, never by a tolerance.
- **Paid in** prefers a provider's summary as new as the latest valuation. Adding the flows since
  an older total was tried and dropped: without the flows going back to the start, it double
  counts a contribution the older statement already held.
- The summary since the start is stored as two figures with no tax year, not on a balance: it has
  no value of its own, and a balance needs one.

## 2026-10-08: A leak guard keeps personal data out of the repository

Real values have reached code before: a regression test copied from a real import, a comment
written while debugging one, an example in a doc. Reviews catch some; a check at every exit catches
the rest.

- **What it knows** (`scripts/leak-guard.ts`, [LEAK_GUARD.md](LEAK_GUARD.md)): a denylist built
  from the data directory and cached outside every repository (0600), a private extras file for
  what the data cannot supply, built-in patterns for shapes of personal data (they need no data, so
  CI can run them), and file rules for documents and images with location metadata.
- **Where it runs:** git's pre-commit, commit-msg and pre-push hooks (installed by `npm install`),
  a Claude Code PreToolUse hook on every write, and CI with patterns only.
- **Plain Node:** it runs with types stripped, not through tsx, so a hook costs about 0.2 s; its
  own modules import each other with `.ts` extensions (`allowImportingTsExtensions`), and the
  engines field asks for Node 22.18 or later.
- **Masked output only:** it never prints what it found, so CI logs and transcripts stay clean.
- **The app's data commits** are not scanned where data and code share a repository: the hooks
  check that in the shell before starting Node, so the live service's commits are untouched.
- **Noise, tuned against the code:** payees made only of common words ("Cheque paid in") are bank
  wording, not anyone's; amounts must be distinctive and not public UK figures; an employer's own
  word counts unless it is a given name, a common word or a town.

## 2026-10-08: The code is published; the data stays private

The app is to be published as open source, under the owner's name. Data and code have shared one
repository; the published one holds only the code, with its history rebuilt from this one's.

- **Two repositories.** The code is public. The data moves to a private repository of its own, with
  no remote, which the app reads and writes as before; its history, the audit log's record, stays
  as it is.
- **Invented values only**, in code, tests, fixtures, docs and commit messages. The leak guard
  (above) checks every exit.
- **Real values taken out.** Tests, fixtures, comments, docs and prompt examples that had the
  owner's values (names, employers, references, amounts, places, holdings, a card's terms) now have
  invented ones: one invented value for each real one, everywhere, with each test's arithmetic kept.
  Decision-log entries keep what was decided and why, without the owner's figures.
- **Swapping an example's values is not a prompt change.** The extraction prompt
  (`extract-11`, `extract-15`) and the month in review (`monthly-review-6`) keep their versions:
  their rules and schemas are the same, and a new version would list every stored document as worth
  reading again and every month as not reviewed.
- **Exposure the owner accepts:** their name, and what a reader can infer from the providers the
  code supports. Not: real values, people, references, amounts, local places or private
  infrastructure.

## 2026-10-08: OIDC names its provider in configuration

The sign-in code named one provider, the owner's: its issuer was the default and its name was on
the sign-in page. Published, it should work with anyone's.

- **`FINANCE_OIDC_ISSUER` is required** whenever `FINANCE_OIDC_CLIENT_ID` is set: there is no
  default issuer. It must be https (plain http only on this machine, for the tests' stand-in).
- **`FINANCE_OIDC_NAME`** is what the sign-in page, its messages and Settings call the provider
  ("Sign in with …"); without it, the issuer's host. New audit entries record the method as
  `oidc`.
- **The ID token's algorithm comes from the provider**: RS256, OIDC's default, when it offers it,
  else the first it lists (the owner's signs with ES256). Nothing to configure.

## 2026-10-08: The app is called Counting House

Published, "Finance" says what it is about but not what it is. The app is now **Counting House**:
the page title, the wordmark, the sign-in page, messages that name the app, the web manifest
(`short_name` "Counting", so a phone's home screen does not cut it off), the API-only page, the
package and the service's description. Settings (`FINANCE_*`), the `finance.service` unit, the
cookies and every path keep their names, so nothing about a running installation changes.
