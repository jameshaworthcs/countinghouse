# Formulas

Every computed figure in the app, written down. These are deterministic: the same data and
assumption records always give the same result. Inferences (Claude's insights) are not here; they
are records with evidence (see [AGENTS.md](AGENTS.md)).

Notation:

- Money is pounds.
- Recorded amounts are summed in integer pence (`src/shared/money.ts`).
- Projections are estimates in floating-point pounds, rounded for display.
- Rates are decimals: 0.05 is 5% a year.

## 1. Which assumption applies

For a key *k* and a target (a fund, an account, its provider, its type, an asset class), the value
is the first found in this order (`src/shared/assumptions.ts`):

1. **Layer.** Your records (`setBy: owner`), then agents' (`agent` or `system`), then the code
   fallback. The first layer with any matching record wins, so your global override beats an
   agent's fund-level value.
2. **Scope, within a layer.** The most specific wins: instrument → account → institution → account
   type → asset class → global.
3. **Time, within a layer and scope.** The newest record wins. A newest record with
   `status: retired` means the layer has nothing at that scope.

Fallbacks may derive from other keys:

- salary growth = earnings growth;
- contribution growth = salary growth;
- spending growth = inflation;
- State Pension growth = max(earnings growth, inflation, 2.5%) (the triple lock).

An agent record whose `reviewBy` has passed is still used, but flagged **stale**.

**Facts and forecasts.** Returns, volatility, inflation, growth and the withdrawal rate are
forecasts, and come only from assumption records. A fund's charge, its make-up, a platform's fee
schedule and an account's current interest rate are facts. They come from statements and research,
in this order:

| Value | Order of precedence |
|---|---|
| Fund charge | your `fee.fund` record → researched OCF → agents' `fee.fund` → fallback |
| Platform fee | your `fee.platform` → researched fee schedule (tiers on the account value, then cap and flat fee) → agents' → fallback |
| Interest | your `interest.rate` → the rate on the account → the interest rate the latest of the account's terms to give one gives, unless it has ended (§4, "Terms") → researched product rate (best name match) → agents' → fallback by account type |
| Fund make-up | your allocation on the instrument → researched allocation → the asset class on the statement (when the latest holdings give none, as a platform's export does not: the latest holdings in any account that gave one for the same fund, by instrument, else ISIN, SEDOL, ticker or name) → "mixed" (unknown) |

## 2. Money

- `toMinor(x) = round(100x)`; sums are of integers; `fromMinor(p) = p/100`.
- A value is valid money iff `round(100x)/100 = x`, exactly. That is the double a 2-dp decimal
  parses to; an absolute tolerance would reject amounts above about £86 million.
- Signs are from your point of view: money in and assets positive; money out and debts negative.

## 3. Coverage and baselines

**Coverage of an account** (`analytics/coverage.ts`) is the union of intervals:

- each committed import's statement period for the account (`periodStart`–`periodEnd`), or the
  span of its rows (a statement with an opening balance and no rows: its closing day);
  - a document that does not print its period (an export, a screenshot of a list) covers from its
    first row to its last, widened to the range you gave while reviewing it (`coversFrom`,
    `coversTo`). A range inside its rows never narrows it;
  - a statement that does not print its start runs from the day after the statement before it
    (the latest-ending one with a closing balance) when it opens on that one's closing balance and
    ends within `STATEMENT_CYCLE_DAYS` = 40 of it (`importIntervals`). The balances chain, so a
    quiet stretch before its first row is covered, not missing. Two cycles apart, a statement is
    missing between, and it is not linked;
- each hand-entered transaction's day;
- each stretch you confirmed nothing is missing from (`coverage.json`);
- for an account with transactions but no import records: from its first to its last transaction.

**Balance evidence** (`BalanceEngine.evidence`, shown with each stretch no document covers, in
Settings → Data health). For the days from *f* to *t*, with the anchors usable for gaps (§9):

- the balance before them is the last anchor dated before *f*. When nothing is recorded on or
  before the day before the account opened (`openedOn`), that day counts as an anchor of £0, and
  the evidence says so (`fromOpening`);
- the balances after them run to the first anchor dated on or after *t*, or else to the last one
  inside them (the evidence then speaks only `through` that day);
- `adds-up` when every consecutive pair from the one before to the last one after has nothing
  unexplained (§9, **Gaps**); `unexplained`, with the sum of what each pair leaves, when one does
  not; `no-balance` with no anchor before them, or none after the one before.

Adding up shows only the net: a payment and its refund inside the stretch would cancel out. So the
evidence never covers days by itself. You confirm a stretch, and only then does it count
(`shared/coverage.ts`):

- **One at a time:** any stretch except one that leaves something unexplained. It is confirmed to
  the day its balances reach when they add up, else to its end, and never today.
- **All that add up, at once:** only settled days, up to the end of the month before last
  (`settledThrough`: 31 Aug on any day of October). By then every monthly statement that includes
  those days has been issued. A stretch is capped there, and one that starts later is left out.
  Later days are recent: their statements are still due, and the monthly update asks for them.
- A confirmed stretch whose balances later stop adding up is marked, and stays until you withdraw
  it.

**Joint coverage over [from, to]** is the set of days *d* on which every transaction account in the
estate that is open on *d* covers *d*. An account counts from `openedOn`, or its first covered day,
until `closedOn`. The accounts that leave days uncovered are reported, with how many.

A month is **complete** when it lies inside the period and ≥ 90% of its days are jointly covered.

**Baseline** for a period (`analytics/baseline.ts`):

- **If some months are complete:** use only those days.
  - monthly income = Σ income on those days ÷ number of complete months;
  - likewise spending and net.
  - Confidence is high with ≥ 3 complete months, medium with 1–2.
- **Else, if jointly covered days ≥ 28** (`MIN_BASELINE_DAYS`, a month's cycle of pay and bills):
  use those days.
  - monthly x = Σ x on covered days ÷ (covered days ÷ 30.4375).
  - Confidence is low.
  - Fewer days can miss a payday altogether: 20 days of June before the salary on the 25th
    read as a monthly loss.
- **Else:** unavailable, with the limiting accounts named.
- **Spending a student loan pays for you** (tuition fees paid to your university, rows on a
  student loan account) is left out: it is not your own money, and it stops when the course does.
  The month's figures (§14) still count it, as you chose.

**Standard periods** (`standardPeriods`): the last 3 and the last 12 full months. When the last 3
full months have neither a complete month nor 28 covered days (after a first import), the recent
period runs up to today instead, so this month's covered days count.

Income and spending classification is §14.

**Standard error of monthly saving:**

- With ≥ 3 complete months: sd(monthly net) / √n.
- Otherwise: `cashflow.uncertainty` × monthly spending (fallback 25%).

**Contributions per wrapper account**, monthly:

- **Personal (from your cash):** outflows from your bank accounts with that account as
  counterparty, on covered days, per covered month.
  - If there are none, the wrapper's own `contribution` rows ÷ the months it has data for in the
    period.
  - Payroll-funded pensions (workplace, net pay, salary sacrifice) never count as from your cash.
- **External (not from your cash):** employer contributions, tax relief, LISA bonus, and
  payroll-funded contributions, ÷ the months with data.
- **Expected but not yet seen:**
  - LISA bonus = min(personal, allowance/12) × bonus rate;
  - relief at source = personal × r/(1−r), with r = 20% from the UK tables.
- Bank-side investing with no known destination joins the combined portfolio.

**Averages on the Spending page and Overview** divide by covered days (daily average) or covered
months (rates). A period-on-period change compares rates over covered days, and only when both
periods are at least half covered.

## 4. Parameters of an account

**Holdings** are the latest holdings snapshot (≤ `YEARLY_STALE_AFTER_DAYS` = 400 days old), scaled to today's value:

- v_h = today's value × h's share of the snapshot;
- uninvested cash is a holding of class cash with no fund charge;
- with no snapshot, the whole account is one holding of unknown ("mixed") make-up.

**Exposure** e_h is fractions by asset class (§1 for the source).

**Expected return of a holding:** μ_h = Σ_c e_h,c · μ(target, c), where μ(target, c) resolves
`return.expected` for the holding's fund, account, provider, type and asset class c. The range
combines the classes' ranges the same way.

**Volatility of a holding:**

- If every class resolves to the same fund-, account-, provider- or type-level record, σ_h is that
  value.
- Otherwise σ_h² = Σ_c Σ_d e_c e_d σ_c σ_d ρ_cd, with ρ_cc = 1 and ρ_cd = `correlation.assetClasses`.

**Correlation between two holdings,** implied by their exposures:
ρ_hk = eₕᵀ R e_k / √(eₕᵀ R eₕ · e_kᵀ R e_k), with R as above.

**Account figures,** by weights w_h = v_h / Σ v:

- μ_a = Σ w_h μ_h;
- σ_a² = Σ_h Σ_k w_h w_k σ_h σ_k ρ_hk;
- fund charge f_a = Σ w_h f_h.

**Charges** a year = V × (f_a + platform rate) + flat fee.

**Combined portfolio** (market and pension accounts, `poolStats`): the same sums over every holding
in every account, weighted by value.

**Terms** (`terms.jsonl`; `shared/terms.ts`, `analytics/terms.ts`). An account's terms are its
rates, its limit and a card's minimum payment, as each document gives them on its date.

- **From a reading:** the credit limit (or overdraft) and the one rate every reading gives, read as
  what the account's type makes it (an AER is interest paid to you; a card's rate, its purchase
  rate; a loan's, interest charged), with every rate in detail when the reading keeps everything.
  The same terms already given for the account that day are not kept again.
- **The latest** of each part comes from the latest document that gives it: the rates, the limit
  and a card's minimum payment, each with its date and document. A screenshot showing only the
  limit does not hide the rates the statement before it gave. **How they changed:** the limit, and
  each kind of rate's standing rate (the one with no end, else the first), each time it differs
  from the one before.
- **Ending:** a rate among the latest rates whose last day (`until`) is within 60 days
  (`TERMS_ENDING_DAYS`) is shown on the account's page with what applies after it (the standing
  rate of its kind, when the document gives one), or as ended once past. On an open account, one
  that has not ended is an alert on the overview.
- **The rate projections use** (the interest row above): the first interest rate a year (not a
  monthly one) in the latest terms that give one that is still running on the day projected from. When every one has ended
  (a boost, a fixed term), what follows is not known from the documents, and the next source
  stands in, its basis saying which rate ended when.

## 5. Projection (`analytics/model.ts`, `simulate`)

The projection runs month by month, t = 0…T−1, in nominal pounds.

**Growth factors:**

- g(x, t) = (1+x)^(t/12);
- the monthly factor of an annual rate is m(x) = (1+x)^(1/12);
- median annual growth: μ̃ = e^m − 1 with m = ln(1+μ) − s²/2 and s² = ln(1 + σ²/(1+μ)²).

**Each market or pension account a:**
V_a ← (V_a + c_a·g(γ_c, t) + x_a·g(γ_c, t)) · m(μ̃_a) · m(−f_a) − flat_a/12

- c = personal contribution; x = external money; γ_c = contribution growth.

**Cash** (current, savings, cash ISA, Premium Bonds, cards):
C ← C · m(i) [if C > 0] + income·g(γ_s, t)·… − spending·(1+adj)·g(γ_p, t) − Σ personal contributions

- i = the balance-weighted rate of cash accounts;
- γ_s = pay growth; γ_p = spending growth; adj = the spending slider.

**Other buckets:**

- Property: P ← P · m(g_property).
- Debts: held flat.

**Display:**

- Each point in today's money = nominal ÷ (1+π)^(t/12), with π = inflation.
- The central line is the sum of each account's median path.

## 6. Ranges (the moment recursion)

For the combined portfolio with monthly contributions C_t (all money in, less flat fees), the two
moments evolve exactly for independent lognormal monthly returns:

- W_{t+1} = (W_t + C_t)·G;
- E[G] = a₁ = m(μ)·m(−f);
- E[G²] = a₂ = a₁²·e^(s²/12);
- E[W_{t+1}] = (E[W_t] + C_t)·a₁;
- E[W²_{t+1}] = (E[W_t²] + 2C_t E[W_t] + C_t²)·a₂.

**Uncertainty in μ itself** is integrated by 3-point Gauss–Hermite quadrature:

- δ = (μ_high − μ_low) / (2 × 1.2816), reading the range as its 10th–90th percentiles;
- nodes μ ± √3δ with weight 1/6 each, and μ with weight 2/3;
- the moments are mixed with those weights.

**Percentiles** come from a lognormal with those moments (Fenton–Wilkinson):

- σ² = ln(E[W²]/E[W]²);
- median = E[W]/e^(σ²/2);
- p10 = median·e^(−1.2816σ); p90 = median·e^(1.2816σ).

**The saving estimate's error** grows linearly: sd_cash(t) = se × t. It is combined with the
portfolio's spread assumed independent:

- down = √((p50 − p10)² + (1.2816·sd_cash)²);
- up = √((p90 − p50)² + (1.2816·sd_cash)²);
- band = central − down … central + up.

This is checked against a seeded Monte Carlo in `tests/model.test.ts`: means within 1.5%, spread
within 5%, percentiles within 3–6%.

## 7. Retirement

- Retirement date = date of birth + retirement age (Settings).
- T = months to it.
- Pension pots (pension accounts only) are projected with §6:
  - start = today's pots;
  - C_t = (personal + external monthly) × g(γ_c, t).
- Pots in today's money: p ÷ (1+π)^(T/12).
- Income a year = pots × `withdrawal.rate`, rising with inflation (so constant in today's money).
- **State Pension:**
  - your latest forecast (today's money), whichever is newest:
    - HMRC's: a `state-pension-forecast` record, read from your gov.uk forecast;
    - one you recorded: a `pension_income_forecast` figure on the State Pension account (a forecast
      has no balance to carry it), or a balance with `annualIncome`;
  - else the full new State Pension for the current tax year (52 × weekly rate, UK tables);
  - from the State Pension age that forecast gives, else yours by the legislated timetable
    (`statePensionDate`).
  - HMRC's forecast is shown in full beside it: per week, from when, the qualifying years so far
    and those it assumes, the years needed for any State Pension, and whether it is the most you
    can get, as the page says.
- **National Insurance record**: each tax year as HMRC's page last showed it (`ni-year` records,
  the latest `asOf` per year), newest first, with a year that is not full given with the voluntary
  contribution that fills it and the day to pay it by. Nothing is worked out: the costs and dates
  are HMRC's.
- DB pensions: their recorded yearly income.
- Tax-free cash: 25% of each pot, up to the Lump Sum Allowance (UK tables).

## 8. The cost of charges

For an account with value V₀ and contribution c a month, over M months (to retirement, or 10
years), both paths grow at the median:

- with charges: V ← (V + c)·m(μ̃)·m(−f) − flat/12;
- without charges: V′ ← (V′ + c)·m(μ̃).
- Drag = V′ − V, shown in today's money: ÷ (1+π)^(M/12).

## 9. Balances and estate value

**Ledger accounts** (`analytics/balances.ts`):

- Anchors are statement or screenshot balances and end-of-day running balances. One stands for
  each day:
  - A balance is a day's close unless it says when it was seen (`at`): a screenshot's capture
    time, or when you gave a balance for that same day. A screenshot that does not say is some
    time that day.
  - Of two that both say when, the later stands for the day; a close is the latest.
  - Otherwise, or at the same moment, the stronger: a statement's or your own balance, then a
    screenshot's, then a running balance. A figure you typed while reviewing an import
    (`enteredBy: "user"`) is your own balance, whatever document it came with.
  - A day closes where its printed balances end: each row's balance − its amount is the balance
    before it, and the close is the one balance no row of the day starts from.
  - That holds whatever order the rows are stored in, as when two statements that overlap by a day
    each add some of its rows. When the chain shows no single end, the day's last row with a
    balance stands in.
- A transaction counts from its own date, with one exception (`ledgerDates`): a row printed on
  one statement but dated on or before the previous statement's close counts from the day after
  that close, since that closing balance did not include it.
  - Cards print a payment made on or just before the closing day on the next statement when it
    posts late.
  - Only when every such row of that statement is within `LATE_POSTING_DAYS` = 7 of the close; a
    document with older rows spans several periods and its rows keep their dates.
  - Rows with a printed running balance keep their dates: the balance pins them.
  - Only the balance engine uses this day; the transaction's own date is unchanged everywhere else.
- balance(D):
  - with an anchor on or before D, balance(D) = anchor + Σ tx in (anchor, D];
  - otherwise, rolled back from the next anchor;
  - with no anchors, Σ tx ≤ D, flagged estimated.
- **What it rests on** (`basis`, for ledger and market accounts alike): the anchor it is worked out
  from, its day and kind (a statement's or your own balance or valuation, a running balance, a
  screenshot's, or a rough one you gave), marked `after` when worked back from a later one. A
  running sum of rows with no anchor, or a closed account's £0, rests on none.
- An account whose interest its documents do not list as movements (a student loan,
  `interestUnrecorded`) has every balance but a statement's own day flagged estimated: worked out
  from its movements (instalments lent and fees paid), it leaves the interest out.
- Prefix sums and binary search make each lookup O(log n).

**Market accounts:**

- Anchors are valuations. Between them, only external flows move the value (contributions,
  employer, relief, bonus, withdrawals, transfers).
- Before the first valuation, flagged estimated:
  - within 45 days, rolled back by the flows since;
  - further back, when the flows go back to the account's start (§12, **Paid in**):
    contributions + (growth at the first valuation) × elapsed fraction since the first flow;
  - otherwise rolled back by the flows since, as if nothing grew. The data starts part-way
    through the account's life, so it was not empty when the first flow arrived: an ISA export
    that opens with cash in hand and funds already held;
  - a rolled-back value is never below nothing.

**Approximate figures** (a balance you gave roughly, `approximate: true`):

- used only when dated after all of the account's real data (its last transaction and last real
  balance); dropped once real data reaches past them;
- balances computed from one are marked estimated;
- never counted as data for "last updated", staleness or gaps.

**Gaps:**

- Consecutive usable anchors with anchor_b ≠ anchor_a + Σ tx in (a, b], each transaction on the
  day it counts from.
- Usable anchors are the strong ones (not screenshots or approximate figures), and each weak one
  that adds up exactly (`usableAnchors`).
- A balance seen mid-day (`at`) is strong only when every row of its day shows a time no later
  than it. A row with no time, or a later one, may follow it, and would look like a gap.
  - Its day's balance(D) is still that balance: rows of the day after it are not added.
- A weak anchor (a screenshot's balance, or one seen mid-day) on day D is usable when the usable
  anchor before it (or, before the first, the strong one after it), carried by the rows between,
  comes to it exactly:
  - at the close of D: it stands for D;
  - otherwise at the close of D − 1, as when it was seen before the day's rows posted: it stands
    for D − 1.

  One that adds up neither way is left out, as before. It may have been seen before rows that
  were still to post, so it never shows a gap by itself.
- `between` (used by proposals, AGENTS.md §5) still takes only the strong anchors.
- The difference is what is unexplained.
- The strong anchors either side of a day (`between`): the last one before it and the first on or
  after it, and what is unexplained between them. A proposal that takes away a move inside the
  account (§ "Proposed fixes" in AGENTS.md) must leave that at nothing.

**Shares in a company** (`companies.json`, `analytics/companies.ts`). Your shares in a company that
is not listed count in the estate on their own account (an "other asset"), at the account's latest
balance. Each valuation is recorded as one of its balances, dated, its note saying how it was worked
out; an "other asset" is valued yearly, so it asks for a newer one after 400 days:

- **Book value** (`net-assets`) = its net assets on its balance sheet × your shares ÷ the shares
  of every class it has issued, as at the balance sheet's date. It assumes every share ranks alike
  for capital, as its confirmation statement says when it does. It is what the company is worth on
  its books, not what anyone would pay.
- **Yours** (`yours`): a value you give.
- **Its dividends**: each voucher (a `dividends_paid` figure naming it) with the bank credit that
  paid it (the same amount to the penny, within 10 days, naming it; the rule of §11), then its
  dividend credits no voucher accounts for.

**Estate value on D:**

- Σ over included accounts of balance(D) in GBP (manual FX).
- A balance's sign decides assets or liabilities: an overdraft is a debt; a card in credit is cash.
- Before an account's first data it adds nothing, so a total on D can leave accounts out.
- **Pay owed is never in it.** Pay earned on timesheets and not yet in the bank (§17, "Earned
  pay") is shown beside the headline as pending: its estimated take-home (else its gross), and
  when it is expected. It counts once it arrives, as the bank balance it lands in.

**Known on D** (`estateKnownOn`): every included account with data has data on or before D, or
opened after D (`openedOn`), so it held nothing then. Accounts with no data at all don't count.

**Changes on the Overview** (past 30 days, since the tax year began, past year):

- change = estate(today) − estate(then); pct = change ÷ |estate(then)|, none when that is 0.
- Only when the estate is known on *then*.
  - Otherwise there is no figure: an account whose data starts later would show its arrival as
    growth.
  - An approximate figure given today leaves every change empty until older data arrives.

**Complete from** (`completeFromDate`, the estate chart): the latest first-data date among
accounts that were already open before their data starts.

- The chart marks the stretch before it as partial, with no total line there: the areas show what
  is known.
- It draws a history from two sampled dates on which some account has data; otherwise it says
  there is not enough history yet.
- The headline says how much of today's value comes from estimated balances, and from how many
  accounts.

**Stale accounts:** an open account whose latest data is more than `settings.staleAfterDays` old
(default 35), or `YEARLY_STALE_AFTER_DAYS` = 400 for accounts updated once a year (pensions with
an annual statement): a year plus a month for the statement to arrive
(`shared/accounts.ts`, `staleAfterDays`).

- An account's latest data is its newest transaction or balance, or the newest HMRC State Pension
  forecast on it, which has no balance (`analytics/balances.ts`, `lastUpdated`).
- The same date drives "last updated" and the monthly update checklist, where a yearly account is
  up to date while its latest data is ≤ 365 days old.

## 10. Computed signals (Spending)

Deterministic rules with named thresholds (`SIGNAL_RULES` in `analytics/spending.ts`):

- **Change on the previous period:** the daily rate over covered days moved ≥ 10%. Both periods
  must be ≥ 50% covered.
  - The previous period is like for like (`previousPeriod`), so monthly bills fall the same way
    in both. From the start of a tax year, it is the same dates a year earlier. From the 1st of a
    month, it is the same days as many months earlier as the period spans (whole months when the
    period ends on a month's last day). Otherwise, it is the same number of days just before.
  - "Last 3 months" is this month and the two before, not a rolling 90 days, which would hold
    two rent payments one time and three the next.
- **Category trend:**
  - the last 3 months against the 9 before, as monthly averages over covered days (≥ 28 recent
    days, ≥ 60 base days);
  - a signal needs ≥ 25% and ≥ £20 a month of change, on a base of ≥ £30 a month.
- **Regular payments** (`RECURRING_RULES` in `analytics/recurring.ts`):
  - same payee on the same account, over the last 730 days, on ≥ 3 distinct days;
  - a payee paid from one account after another (runs overlapping by ≤ 7 days, as when a
    subscription moves to a new card) is one group; paid from two accounts at once, one per
    account;
  - interval median in a cadence band; ≥ 60% of intervals within ±max(3 days, 35%);
  - amounts steady (median spread ≤ 25%, or the last three equal);
  - active while the last payment is at most 1.6 median intervals old.
- **Price change:** first and last amounts differ by > 3%, and the last three are equal.
- **Habit:** ≥ 6 purchases in a category in the last 30 days (≥ 25 of them covered).
- **Weekends:** the weekend daily average is ≥ 1.5× the weekday one.
- **Small purchases:** ≥ 20 of £10 or less.
- **Cash:** withdrawals > 10% of spending.
- **Uncategorised:** > 8% of spending.
- **Top category:** > 25% of spending.

**Agreements** (`agreements.json`; `shared/agreements.ts`, `analytics/agreements.ts`). An agreement
is what an offer, contract, payment plan or student finance award says will be paid: a schedule of
payments due, each a date and an amount, paid by you, to you (`direction: "in"`), or by a loan for
you (`accountId`, `paidBy`).

- **Its payments:** money out of an everyday account (not an investment or pension) whose
  description, or the merchant or payer its source gives, names its counterparty or one of its
  other names, as whole words.
  - **Paid to you:** money in to an everyday account other than the one that lends it, for exactly
    a payment's amount within 7 days of its date (`AGREEMENT_RECEIPT_DAYS`): the bank seldom names
    who sent it. Filed under its category (borrowing: a transfer from the loan, which is named as
    the other side) with its counterparty as the payee. The loan's own row for the same instalment
    takes the category too.
  - **Paid by a loan for you:** money out of that loan's account, the same way (a Tuition Fee
    Loan's fees on the student loan).
  - **Paid for you outside your accounts** (`paidBy` with no `accountId`): none of your payments is
    one of its.
- **A scheduled payment** is one of those within 45 days either side of a due date
  (`AGREEMENT_PAYMENT_DAYS`), for that payment's amount or within a tenth of it
  (`AGREEMENT_PAYMENT_TOLERANCE`): an advance taken off an instalment, or a small charge added to
  one, still makes it that instalment. One made before the agreement was (`agreedOn`, when known)
  is not: last year's bill paid a month before this year's first instalment.
- **Filing** (the categoriser's step 3b): a scheduled payment takes the agreement's category
  (`categorisedBy: "agreement"`). Its payee is worked out as any other's, so it groups with the
  payments to the same payee before and after the agreement. It comes after your rules, transfers
  and wrapper flows, and before the merchant list, which knows a name but not what it was paid
  for. When an agreement is added, the scheduled payments already recorded are filed the same way,
  except one you, a rule of yours or a transfer link categorised.
- **The check** pairs payments due with payments, across all your agreements at once, so two never
  share one (a tenancy and its renewal): pairs of exactly the amount due first, then the fewest
  days apart, then the nearest amount; each payment pairs once. A payment due with none is *not due
  yet* before its date, *due* for 45 days after it (7 for one paid to the penny), then *no payment
  seen*. With none found, what its document says comes first: *paid, says its document* (before your
  data begins, say) or *cancelled*. A paired payment that differs from what was due shows the
  difference.
- **Other payments:** those to its counterparty in its category that no agreement's payment due
  pairs with, from when it was agreed (its start, if that is not known; its first due date, if
  earlier) to 45 days after its end (or its last due date, if later), as a charge after a let comes.
  None for one known only by its exact amounts.
- **Paid** is the paired payments and the other payments added up. Its total is the document's,
  shown beside it; nothing is worked out from the two.

**Payees** (`shared/merchants.ts`, `paymentParts` and `cleanPayee`). A payment worded with the other
party inside other words gives that party, and its reference is kept apart:

- Santander: "BILL PAYMENT | STANDING ORDER | THIRD PARTY PAYMENT MADE VIA FASTER PAYMENT TO *name*
  REFERENCE *ref*", "FASTER PAYMENTS RECEIPT REF.*ref* FROM *name*" (the last FROM, as a reference
  can hold one), "BANK GIRO CREDIT REF *payer*, *ref*" and "DIRECT DEBIT PAYMENT TO *payee* REF *ref*,
  MANDATE NO …".
- Apple Pay and Google Pay: "*merchant* (VIA APPLE PAY), ON *date*".
- Chase: "*merchant* Purchase", "*merchant* Purchase | EUR 24.50 | FX rate …" (one payee whatever
  the rate), "From *name* - *ref*".
- HTML entities an export leaves in ("&amp;") are read as their characters, and a brand whose name
  ends in a number keeps it ("Trading 212").

**Pay by name** (`analytics/pay.ts`, `paidAs`; the categoriser's step 4d). The payments paired with a
job's payslips (§17) teach the name the bank gives its pay. Money in under that name is salary when
it is between half the least and twice the most of those payments, and dated from a year before
the first to three months after the last. A job at a company you hold shares in is left out, as its
dividends and transfers come under the same name.

**Refunds onto a card** (the categoriser's step 7, `CARD_REFUND_DAYS`). Money in on a credit card from
a payee the card paid in the 120 days before, that nothing else categorised, is that purchase's
refund. It takes the purchase's category, so the two net off in that category (§14), or "Refunds"
when the purchase had none.

**Re-applying categorisation** (`enrich.ts`). Every row you did not categorise is worked out again:

- a payee from elsewhere (the reader's) is kept when all it would get is a name cut from the
  description;
- one cut by an earlier version of the tidying, or left in the bank's words, is replaced
  (`nextPayee`);
- a general word in the merchant list ("COUNCIL", "TICKET") never overrules the category Claude
  gave a row; a brand it knows does.

Its preview lists every payment it would recategorise, by group and payee. Before applying, you can
leave any of them as it is this time (`skip`: neither changed nor linked, and offered again next
time), or give it a category of yours (`decided`: written first, as yours, so re-applying never
changes it again). "Always" adds a rule for a payee, in the category you gave all its payments
there: a description that holds the payee, else the payee as the categoriser sees it, whichever
catches every one of them (`payeeRuleMatch`). A payment you put in a category that isn't a transfer
is never linked as one.

**A rule you make** (`applyRule` in `enrich.ts`) applies at once to the rows it matches, and, when you
change one, to the rows it categorised before; each takes what the categoriser now says of it. Nothing
else changes: re-applying everything is its own step, with its preview.

**People** (`shared/people.ts`; the To categorise page, `analytics/queue.ts`). A payment is with a
person when:

- the bank words it as a payment between two people's accounts (a Faster Payment to or from a name,
  Chase's "From *name* - *ref*", or the other party a source gives on a transfer), in its description
  or another document's; not a card payment, a giro credit or a direct debit;
- and the name is shaped like a person's: a title, initials ("H J REED", "REED AJ", "REED R&C"), or
  one of about 500 common first names on either side ("WHITLOCK HANNAH"), with no word a business uses
  (Ltd, Pay, Cash, Card, Estates…). A whole name a brand also goes by ("Capital One") is the brand;
  an initial makes it someone ("J Morrison");
- and it is not you (your profile's surname and first initial, or a joint name you are in), nor the
  name or an alias of one of your accounts or banks, nor a transfer linked between your accounts.
  Someone you saved (`people.json`) is a person whatever their name looks like.

One person's names share a **key**, their surname and first initial: "Hannah Reed", "H REED" and "REED
HANNAH" are one. A joint name keys on the surname and every first initial ("REED R&C" is "R & C REED").
Two first names could be either way round ("TAYLOR SAM"); someone you saved is found either way.

What each payment was is **yours to decide**: payments with people stay as they are until you
confirm each one, and those not decided by you, a rule of yours or an agreement are listed. A
suggestion, with its reason, only fills in the choice (`suggestFor`). For money in:

1. a loan ("loan", "lend", "borrow"): no suggestion;
2. words that square something up ("half", "share", "owe", "paying back", "expenses", "refund"):
   paid back, in the category of what was shared when the words say (a share of a present goes in
   gifts);
3. an occasion, pocket money, love or kisses ("xmas", "birthday", "congrats", "xx"; the occasion is
   the reason given): a gift. Who it is from ("FROM NAN") is not: most money from family is a gift,
   not all of it;
4. half, a third, a quarter or all of a payment you made in the 90 days before (`SHARE_DAYS`), to
   the penny (within a penny a part for a split that doesn't divide evenly): paid back, in that
   payment's category, else in what the reference says was shared. Not cash, transfers or other
   people's payments; not under £5; "all" needs £20 or more, not in round pounds. A share in round
   pounds counts only when the reference doesn't say what was shared ("Train home" for £40 is a
   train, not half of an £80 shop);
5. words for your own money ("top up", "savings"): yours moving;
6. what you said the person usually is;
7. what you chose for 3 or more of their earlier payments the same way, if 70% or more were one
   category;
8. what was shared, from the reference's words alone (trains, a holiday, the phone) or a brand in it;
9. the category the reader, the bank or the built-in list gave it;
10. your surname: a gift, marked "check".

Money out goes the same way, a gift or your share of something, without 4 and 10. Only 2–4 come from
the payment itself, and of 4 only a share not in round pounds: those are ticked for you to confirm.
Where each choice goes:

| | Money in | Money out |
|---|---|---|
| A gift | Gifts received | Gifts |
| Paid back / your share | what was shared, else Paid back to you | what was shared, else Other spending |
| Your own money | Between my accounts | Between my accounts |

Money paid back in a spending category counts against spending in it, and Paid back to you
counts against spending as refunds do (§14).

**Cash and cheques paid in** (the categoriser's step 1b; `suggestForCash` in `shared/people.ts`) to a
current or savings account are yours to decide like a payment with a person: nothing on them says
whose money it was. Cash is known by its words ("CASH PAID IN AT", "POST OFFICE CASH DEPOSIT",
"COUNTER CREDIT") or the bank's type for it ("ATM", "Cash"); a cheque by "CHEQUE" or "CHQ" in either.
No category is given them but by a rule of yours: not the merchant list, the bank's category or the
reader's. They are listed first among people on the To categorise page, uncategorised money in until
you decide. A suggestion only fills in the choice, and none is ticked:

1. cash: a cash withdrawal of exactly the amount in the 30 days before (`CASH_BACK_DAYS`), your own
   cash back;
2. what you chose for 3 or more of the same (cash, or cheques) paid in before, if 70% or more were
   one category;
3. paid in from a week before Christmas Day or your birthday (your profile) to a month after
   (`CASH_GIFT_WINDOW`): a gift;
4. cash: withdrawals in the 30 days before adding up to the amount or more, your own cash back;
5. else a gift, marked "check": cash or a cheque paid in is often a gift, not always.

Your own cash back goes in Cash withdrawal, so it nets off the withdrawal it came from (§14), and a
cheque of your own money is a transfer; a gift goes in Gifts received, and paid back in Paid back to
you.

**Rules from your decisions** (`analytics/queue.ts`):

- **When:** a payee you put in one category at least twice one way (`RULE_FROM_DECISIONS`), all in
  that category; or, when you put none of them anywhere, one the reader put in one category three
  times or more (`RULE_FROM_READER`). Only spending and income categories; never a person's payments
  or cash and cheques paid in; only when the rule would categorise a payment now.
- **The rule:** money that way whose description holds the payee (one of 4 letters or more); else
  whose payee, as the categoriser sees it, is the payee. A rule that would catch a payment you put
  in another category is too wide and isn't offered. When some payments it would catch are under a
  quarter of the smallest you decided or over four times the largest, it keeps to half the
  smallest to twice the largest.
- Two payees that are one (a statement's wording and an app's) offer the rule that fills more,
  once.

**What's left** is the uncategorised payments in the period, not a person's, not cash or a cheque paid
in and not one a suggested rule would fill, grouped by payee and direction, the largest total first.

**Guesses to check** are the payments in the period the app categorised from a guess: the bank's own
category (`categorisedBy: "bank"`) or the reader's suggestion (`"ai"`). They are grouped by payee,
direction and category, the largest total first, with the bank's own words for its category. Not
listed: a person's payments and cash and cheques paid in (decided above), transfers linked between your accounts,
split payments, and payments a suggested rule would fill. They count as categorised until you act;
confirming or changing one makes it yours, and "always" makes a rule for its payee. Your rules,
schedules and the names the merchant list knows are not guesses.

## 11. Allowances (`analytics/allowances.ts`)

**ISA:**

- Subscriptions in the tax year are, per ISA:
  - the provider-reported `taxYearContributions` for that tax year, if any;
  - else positive `contribution` rows (net of withdrawals for flexible ISAs);
  - plus bank payments to it on dates its own statements do not cover (allowing 10 days to
    arrive).
- The LISA counts within the £20,000.
- The cash-ISA cap applies from 2027/28 for under-65s (UK tables).

**LISA:**

- Contributions against £4,000.
- Expected bonus = 25% × min(contributions, £4,000).

**Pension annual allowance** (`pensionTotals`), scheme by scheme, then added up:

- **A pension account from its own rows:** personal contributions, grossed up for relief at source
  by 1/(1−r) when no relief rows are recorded; plus employer contributions and recorded relief.
- **A pension statement's figures for the year replace its account's rows**, kind by kind (what
  you paid, the relief, the employer's), as an interest certificate replaces its account's interest.
  The statement's scheme is the account its figures name, else the one pension account the same
  statement updated, else a scheme of its own. Documents state what you paid and the basic-rate
  relief the provider added separately (`pension_contribution_employee`, `pension_tax_relief`):
  their sum is your gross contribution, and a statement that shows relief is relief at source.
  Salary sacrifice is an employer contribution.
- **Payslip deductions** are their job's scheme (else their employer's). For a job whose payslips
  were read in full, the year so far is the year to date they print (your contributions and the
  employer's, "Payslips in full" in §17), so contributions the employer makes, which payslips show
  only in that column, count. When they add up to a statement's figure to the penny (your
  contributions, else the employer's), they are that statement's money and count once. A job whose
  pension goes into an account that has its own rows or statement for the year (the job's
  `pensionAccountId`, or an account whose `pension.employer` is the job) is counted there, not
  again. Otherwise they are a scheme of their own.
- The total is every scheme's: a SIPP's employer contributions and a workplace scheme's both count.

**Pension arrangements** (a job's `pensionArrangements`, `analytics/arrangements.ts`): what an
employer's form set up to pay into a pension account of yours, checked against the account's
`employer-contribution` credits of that amount, to the penny, each used once:

- **A single payment** arrived when such a credit falls within 60 days of the form's date
  (`SINGLE_PAYMENT_DAYS`).
- **A monthly one** is checked from its first collection, looked for within two months of the form
  (`FIRST_COLLECTION_MONTHS`), to the month it ends or now. Each month has a collection or is
  listed as having none; this month's may not have come yet, so it is never listed.
- Employer contributions into the account from the first arrangement on that none accounts for are
  listed apart.
- The contributions count for the annual allowance as above, whatever an arrangement says: the
  arrangement is only what was set up.
- **Not yet known** (`incomplete`) when a pension account's data does not cover the tax year so
  far (±45 days) and no statement figures exist for it: the amount used is then a minimum.
- Taper per the UK tables when income is given.
- **Carry-forward** from each of the previous 3 years is **unknown** (not assumed) unless every
  pension account that existed then has statements covering that whole year (±45 days), or
  statement totals exist for it.

**Personal Savings Allowance:**

- Interest on taxable accounts: `interest` rows, replaced per account by interest-certificate
  figures.
- Compared against the allowance for your tax band, which is worked out, not set (below).

**Tax band** (`taxBandEstimate`, with the pure `taxBandFor` in `shared/uk.ts`):

- Income for the year, in whole pounds:
  - pay, job by job, from **one source per employer and year** (below), never two. A figure is a
    payslip's when its document was a payslip, else when its period is under 200 days;
    - salary received (category `salary`, after tax) from employers no figure names counts as a
      floor; figures naming no employer are taken to cover all salary received. Salary the Pay tab
      pairs with a payslip, or lists under an employer with payslips (§17), is that employer's
      and never counts again;
    - for the year in progress, a larger full-year estimate wins: your salary in Settings, else
      last year's figures for the whole year;
  - benefits in kind (`benefit_in_kind`);
  - side income: turnover (`side-income` rows and `self_employment_income` figures) less the
    trading allowance, when over it;
  - interest and dividends: the amounts counted for the allowances above.
- Band extension E = gross relief-at-source pension contributions (your part, relief included) +
  Gift Aid paid ÷ (1 − basic rate).
- Adjusted net income = total − E. Personal allowance = max(0, PA − ⌊max(0, ANI − £100,000) ÷ 2⌋).
- Taxable = max(0, total − allowance). The band is the highest one taxable income reaches:
  - none at 0;
  - basic up to the basic-rate limit + E;
  - higher up to the additional-rate threshold + E;
  - additional above.
- These are the UK bands that savings and dividends use everywhere. Scottish rates on pay are not
  modelled, and the page says so.
- **Basis:**
  - `documents`: every employer's pay is a figure for the whole year (a P60, HMRC's figure for a
    finished year, or yours), and no salary is unaccounted for;
  - `estimate`: pay comes from your salary or last year's figures;
  - `minimum`: pay is known only so far (payslips, a page to a date, or salary after tax), so the
    band may be higher.
  The pages label the band with its basis.

**One source per employer and year** (`analytics/sources.ts`). A job's pay, tax, NI and student
loan for a year can be stated by its P60, its P45, HMRC's taxable-income pages and records, and the
payslips. Each kind of figure counts from exactly one of them; the others are kept and shown beside
it.

- **One employer:** the figures and HMRC records of one job (`employmentId`, `employments.json`)
  are one employer's. Figures with no job are one employer's when their names match once reduced
  (`payerKey`), or they carry the same PAYE reference ("123 AB456" = "123/AB456"), transitively.
- **Candidate sources**, for each kind:
  - the payslips added up (as at the last one's date);
  - each other document's figures added up (as at the last date they cover: a year's end, a
    leaving date, a pay date);
  - your own figures typed in Settings;
  - HMRC's record of the job's payments (`payment` records) added up, as at the last pay date: its
    taxable pay for pay, its tax and NI for those. It states no student loan;
  - the payroll's own count: the year-to-date column on the job's latest payslip read in full (its
    taxable pay for pay, else its gross; its tax, NI and student loan), plus the figures of any
    payslips paid after it that were not read in full, as at the last of their dates.
- **A job that has ended** (on your date, else HMRC's: an employment page's end date, or the
  account's "ended" event) has nothing more to come that year. A source as at or after the day it
  ended is final: the year's figure for it, and Self Assessment says so.
- **The one that counts:**
  1. yours;
  2. a document for the whole tax year (its figures reach the year's end), a P60 first;
  3. else the most recent, as at its date. On the same date a document (or HMRC's record, or a
     payslip's year to date), which states the total, wins over the payslips added up, and an
     imported document over HMRC's record. So the precedence is: yours, a P60, a P45 or other
     document for the whole year, then the latest of HMRC's record, a document to a date and the
     payslips' year to date, then the payslips added up.
- So a P45 and an HMRC page to a later date state one job's year so far once, and a page to a date
  never stops later payslips counting.

**Self Assessment, a page per job** (`selfAssessment`). Each job with pay in the year has its SA102
page: its pay, tax and student loan from the one source that counts for each (above), its PAYE
reference, and the days it started or ended when they fall in the year (yours, else HMRC's). It is
the year's figure when that source is final. The totals above are the sum of these pages.

**HMRC's working out of a year** (a `settlement` record, the latest for the year): the outcome,
the amount and when it was worked out, what is outstanding, and each payment the page lists. A
payment is matched to the money out of your bank that made it: the same amount to the penny, within
7 days of the day the page gives, worded as a payment to HMRC; the nearest such. A refund HMRC owed
you is matched to a credit of that amount from HMRC, on or after the day it was worked out and
within 120 days of it.

**Dividends** (`dividendsOf`): dividends outside ISAs and pensions against the dividend allowance,
**each counted once**. A dividend voucher and the bank credit that paid it are one dividend: a
`dividends` credit (or, in a general investment account, investment income worded as a dividend:
`DIVIDEND_WORDING`, "dividend", "distribution", or interactive investor's "Div 250 …") is a
voucher's when it is the same amount to the penny, within 10 days of the payment date
(`DIVIDEND_MATCH_DAYS`), and names the company. Credits no voucher accounts for count as they are,
and so does a voucher whose payment is not in your data.

## 12. Paid in, growth and money-weighted return (`analytics/investments.ts`)

**Paid in** (per account), the first that applies:

- the total paid in on the latest valuation that states one;
  - approximate figures count only when you entered a total with them;
- Σ external flows (contributions, employer, relief, bonus, withdrawals, transfers), only when they
  go back to the start;
  - every valuation before the first flow is nothing, and there is one;
  - or the first flow comes within 31 days of `openedOn`;
- otherwise not known: a few months of statements are not everything paid in.

**Growth** = value − (paid in + a LISA bonus the provider reports separately), only with both
known. It is marked when the value is an estimate.

**Totals:**

- Paid in and growth are summed over the accounts where both are known, with the rest counted as
  not known.
- An unknown paid in never turns an account's value into growth.

**Money-weighted return (XIRR):**

- Flows: the first real valuation as money put in, later external flows, and the end value as
  money out.
  - The end value is today's value, or the last real valuation when today's is an estimate.
- Solve Σ F_i / (1+r)^(t_i) = 0 with t in years (days/365.25).
- Newton's method, with bisection on [−0.99, 5] as a fallback.
- Undefined for spans under a month.

## 13. Reconciliation and review checks (`shared/reconcile.ts`, `shared/review.ts`)

- **Opening and closing balance:** opening + Σ settled rows = closing.
- **Running balances:** each row's running balance = the previous row's running balance + its
  amount, in whichever order the rows fit. Statements list rows oldest first and apps newest
  first; the order with fewer breaks is used.
- Pending rows are excluded: statement and export balances are of settled transactions.
- **An investment account's activity list** (`cashLedger`): the running balances and opening
  balance are the uninvested cash, so the closing balance checked is the closing cash. No value is
  recorded from it.

**Review checks** run on each account in a draft, on the review page and for "Commit all ready".
A warning holds an import back from bulk commit:

| Check | Warns when |
|---|---|
| Balances | the reconciliation above fails (the rows breaking a running balance are marked) |
| Totals | Σ settled money in or money out ≠ the totals printed on the statement, to the penny |
| Period | a row is dated outside the statement's printed period (not for exports, whose period is their first and last rows) |
| Future | a row is dated after the upload day |
| Balance date | a settled row is dated after the balance recorded with it (no statement period); on a screenshot, after the day it was taken |
| Card signs | on a credit card, a payment to the card (its usual wordings, or just "Payment") is money out, or, with ≥ 3 settled rows, most are money in. Fewer rows with no payment to the card can't tell. The same rule picks the signs of a CSV layout that names no bank, for a card: [INGESTION.md](INGESTION.md) |
| Unsure | the reader marked a row as uncertain |
| Holdings | the holdings and cash come to more than the value shown, or less when the list is not marked as part of the account's holdings; ±max(£1, 0.1%) |
| Holdings, part of the list (information) | a screen lists only some holdings, or one fund's own page: they join that day's other holdings |
| Cash (information) | the balances are an investment account's cash, not its value |
| Repeated (information) | two rows share a date, amount and description |
| Pending (information) | pending rows are left out unless ticked |

Warnings from reading the document (rows dropped as unreadable) also hold an import back.

## 14. Income and spending

A transaction counts as follows (`classifyFlow`):

- **Excluded:**
  - it is on a market account;
  - or it is linked as a transfer;
  - or its category is a transfer or investment kind.
- **Income:** an income category, except one that offsets spending.
- **Spending:**
  - an expense category: money in under one (your share of something paid back, a card's refund in
    the purchase's category) counts as negative spending in it;
  - or an income category that offsets spending (`offsetsSpending`: Refunds, and Paid back to you),
    which counts as negative spending.
- **Uncategorised:** by sign.
- **A split payment** counts as its lines, each in its own category and with its own amount
  (`categoryLines`). What the lines do not add up to stays in the transaction's own category. A
  transfer is never split.

**Spent this month** (the Overview, `monthToDate`):

- Σ spending from the 1st to today.
- Unknown (not £0) until some day of the month has data for every account (§3, joint coverage).
- The change is like for like: day *n* of this month against day *n* of last month, while last
  month has one.
  - Only pairs where both days have data for every account count.
  - It needs pairs for at least half the days so far (`SIGNAL_RULES.minCoverage`); otherwise a
    note says what is missing.

## 15. Budgets (`analytics/budgets.ts`)

A budget is a monthly amount you set (`data/budgets.json`). It can cover all spending, a group
(every category in it) or one category. Spending is §14's: refunds count against their own category,
**Refunds**, not against the budget of what was refunded.

For a budget *B* and a month:

- **Spent** *S* = Σ spending in the month so far, from all the data there is.
- **Data to** *d*: the last day, counting from the 1st, with data for every account (§3). Spending
  after *d* may be incomplete, and the page says so.
- **Usual share by day *d*** *u*: over the past complete months (§3) in the 12 before, the share
  of each month's spending in *B* that was spent by day *d* (the month's own last day if it is
  shorter), averaged over the months with some spending there.
  - It needs 2 such months (`BUDGET_RULES.paceMonths`).
  - Without them, *u* = *d* ÷ days in the month.
  - It is 1 for a month that is over.
- **Heading for** *P* = *S*<sub>≤d</sub> ÷ *u*, where *S*<sub>≤d</sub> is spending up to day
  *d*. It is judged only once *u* ≥ 25% (`paceFrom`); earlier, one bill decides it.
- **Status**, first that applies:
  1. **over**: *S* > *B*;
  2. **on pace to go over**: *P* > *B* × 1.1 (`paceMargin`);
  3. **nearly spent**: *S* ≥ 90% of *B* (`near`);
  4. **fine**.
- **Suggestion:** the median of the spending in *B* over the last 6 complete months (zeros
  included), rounded up. It rounds to £5 steps under £100, £10 under £1,000, and £50 above.
  Groups and all spending with no budget get one too.

The Overview warns about each budget over, or on pace to go over, this month. These are computed
signals, not insights.

## 16. Goals (`analytics/goals.ts`)

A goal is a target funded by accounts you choose (`data/goals.json`). There are three kinds:

- **savings**: an amount;
- **emergency fund**: *k* months of spending, target = *k* × the monthly spending of the recent
  baseline (§3), so it follows your spending;
- **home deposit**: an amount for a first home.

**What the accounts count for:** each account's value today (§9) × its share *s*:

- *s* = 1, except for a Lifetime ISA;
- a LISA counts in full only for a home deposit. The home must be within the LISA price cap
  (£450,000, `uk.ts`), and the LISA at least 12 months old by the target date (from its opening, or
  its first data). The same holds from age 60. Otherwise *s* = 1 − the withdrawal charge (0.75).

**Money coming in** *C* each month:

- a wrapper's personal and outside money from the baseline (§3; the LISA bonus included);
- a cash account's net movement in and out over the baseline's period, leaving out income rows
  (interest, prizes), which its rate stands for;
- counted at the same share *s*.

**The path:** each account runs through the moment recursion (§6) with its own parameters (§4)
and its *C*, for up to 40 years.

- Market and pension accounts: expected return, volatility and charges.
- Cash: its interest rate, with no spread.
- The means add up. The standard deviations add up too, as if the accounts moved together; this
  errs wide.
- The p10, p50 and p90 at each month come from a lognormal fit (§6).
- Amounts are in pounds of the day, not deflated. A target is the owner's amount when they reach it.

**Reached:** the first month in which p50 ≥ target (the median date). The p90 path gives the
earliest likely month, and the p10 path the latest.

**Status:**

1. **reached**: value counted ≥ target;
2. **on track**: the median date is on or before the target date;
3. **behind**: it is after, or beyond the horizon;
4. with no target date, just the dates.

**More a month:** to reach the target by its date *T* months away, at the median:
*X* = (target − p50<sub>T</sub>) ÷ Σ<sub>t=0..T−1</sub> (1 + *g*)<sup>T−t</sup>, rounded up.
*g* is the accounts' median monthly growth after charges, weighted by value.

## 17. Pay (`analytics/pay.ts`)

The Tax year page's **Pay** tab covers each employer in the year. A figure counts as a payslip's
when its document was a payslip, or, failing that, when its period is under 200 days. Earned pay
from a timesheet is never a payslip's figure: it is shown under the payroll that pays it ("Earned
pay", below).

- **A pay period** is one job's payslip figures with one period (`employmentId`). Figures with no
  job are an employer's when the names match once reduced (`payerKey`: case, spaces and "Ltd" go).
  - Its **gross**, **tax**, **NI**, **pension** and **student loan** are the figures of those
    kinds. A printed £0 is a figure.
  - **After these** = gross − tax − NI − pension − student loan (the deductions read).
  - **HMRC's record of it**: the one `payment` record of the job in the year whose tax is the
    payslip's and whose taxable pay is its gross, or its gross less pension (taken before tax), to
    the penny. Two such records (equal months) give neither.
- **Into your bank** is a salary credit (category *salary*, money in) between the period's end −
  10 days and the later of the pay date and the period's end + 10 days (`PAY_MATCH_DAYS`). A
  payslip that prints no period (a last one, dated the day you left) is looked for 10 days either
  side of the pay date on HMRC's record of it, when it has one. Each credit is used once, found in
  these passes over the year's payslips in date order (`pairPay`):
  1. one from the job: its text names the job (any name it comes under) or carries your payroll
     number there (5 characters or more, not inside a longer number). First one within £1 of
     *after these*, so no payslip takes another's own payment. Then pay brought forward (before
     Christmas, say): exactly *after these*, to the penny, earlier in the pay period than those
     days, the nearest the pay date. Then the closest to *after these*;
  2. else one of exactly *after these*, to the penny, whatever name the bank gives it (an
     employer's payroll often pays under a group company's name), the nearest the pay date;
  3. pay you said is owed, arriving late: a credit from the job of exactly *after these*, after
     the period's days, for the oldest owed period first. A credit naming the period's month is
     taken first.
- **Status**, first that applies:
  1. **nothing due**: *after these* is £0 or less (a £0 payslip); no payment is looked for;
  2. **paid**: the credit is within £1 of *after these*. Pay you said was owed that came after
     the period's days says it arrived late;
  3. **differs**: it is not. The difference is other deductions the reader did not list (a cycle
     scheme, say) or an adjustment;
  4. **owed**: you said its pay is owed to you, and none has come. You say so on the Pay tab (the
     job's `owed`), or by telling the app it had not arrived: an active context record with
     `detail.event` `pay_not_received` whose `attributes.employer` is the job and whose days
     (`from` to `to`) the period ends in;
  5. **due**: the pay date has not come;
  6. **not seen**: none was found. The note says whether your bank data covers those days, in
     the accounts the employer's pay goes into, else any your salary goes into.
- Salary credits no payslip explains are pay with no payslip, listed under the job their text names
  (or whose payroll number it carries), else the employer the same payer paid (the nearest such
  payment), else their own name.
- **HMRC's record beside each month**: each `payment` record of the year goes beside the payslip it
  is the record of (above), else the month of the same tax month (month 1 runs 6 April to 5 May),
  a payslip's month first. A record no month has is a pay date with no payslip imported; one with
  no pay and no tax is nothing paid.
- **Tax on HMRC's code** (`taxChecks`): for each month with HMRC's record, in pay-date order, the
  tax HMRC's code would take (`payeTax`, below) on the record's taxable pay, with the record's
  earlier pay and tax in the year for a cumulative code. The code is the one in force: the latest
  `tax-code` record for the job issued at least 14 days before the pay date (`CODE_NOTICE_DAYS`; an
  employer works a new code from the first pay day after it gets the notice, and runs the payroll a
  while before). When it differs from the tax taken by more than £1, the month says so, with the
  code and when it was issued.
- **Payslips in full** (`analytics/payslips.ts`, `payslips.jsonl`). A payslip read in full keeps
  every line, its totals and its year-to-date column. Its pay period's figures are the ones the
  calculations above use; the record adds:
  - **Net pay**: the net the payslip prints is the pay looked for in the bank (*after these* is
    then that net, and the Pay tab says it is printed), so deductions that are not tax figures (a
    cycle scheme) never show as a difference.
  - **Payslips not imported**: a payroll's year to date of pay is the sum of its payslips that tax
    year. So the first payslip imported, less its own pay, is pay on earlier payslips; and a rise
    between two that is more than the later one's pay is pay on payslips between them. Each gap is
    shown under the job, with its amount.
  - **What the employer paid on top** in a period (its NI and pension): as printed, else the year
    to date's whole value on the year's first payslip (with no pay before it), else its rise from
    the payslip before, when nothing is missing between them.
  - Each month shows the tax code and NI category letter its payslip prints.
- **Owed pay** (`owedPayslips`): periods of this tax year and the last that you said are owed (either way),
  with no pay yet, count in the Overview's owed line (their *after these* and gross) beside
  timesheet work not yet paid. They are never the next payment expected: that is the timesheet
  work's.
- **Year so far** adds up each column. Beside it is the employer's document for the year (§11, "One
  source per employer and year"): its P60 or another figure for the whole year, else the latest one
  to a date (a P45, an HMRC page). Its pay, tax and NI are shown, and whether the payslips paid by
  its date (with 10 days for a pay date to move) add up to it:
  - they do when their tax and NI are within £1 of the document's. Its pay can still be less than
    their gross by the pension taken before tax (a net pay arrangement): that is said;
  - payslip tax short of the document's means payslips are missing; more than it, they need
    checking (a refund on a payslip not imported, say).
- A payslip or P60 names its employer as the document does. On the review page the payer can be
  renamed for all of a document's figures, so a payslip that prints a group name and a P60 that
  prints the employing company count as one employer.

### Earned pay (`analytics/earned.ts`)

A timesheet gives `earned_pay` figures: what a period's work earned, before it is paid. They are
followed to the payslip that paid them and to the bank. They are never income for tax: the
payslip that pays them is, in the tax year it is paid.

- **The figure that counts** for one timesheet (payer and role) and period is the one committed
  last (`effectiveEarned`).
- **Payroll.** A figure is paid through its job (`employmentId`), else `paidBy` (the employer as
  its payslips name it), else its own payer; names compare as `payerKey` does.
- **Which payslip paid which months** (`matchEarned`), payslips in order of their period's end:
  - a payslip with gross > 0 pays the run of consecutive unpaid months, oldest first, all ending
    by the payslip's own end, whose earned pay adds up to its gross to the penny: the first such
    run, then the shortest;
  - a £0 payslip pays nothing. A month the usual delay put on it is noted as not on it (a
    timesheet that went in late);
  - a payslip no run adds up to (expenses, a bonus, a correction) pays none of them.
- **The delay** *L*, in months, from the work to the payslip that pays it: yours (the job's
  `payLagMonths`, set on the Pay tab; for a payroll with no job yet, `profile.employers`), else
  learned from the latest payslip that paid some months (its month − the month of the latest work
  on it).
- **What is owed**: the months no payslip paid. Each is expected with the payslip of month
  max(work month + *L*, the month after this payroll's latest payslip), so a late timesheet's month
  comes with the next payslip. Months expected on the same payslip are one expected payment. With
  no *L* the month is unknown.
- **Pay day**: the day of the month this payroll's pay last reached the bank, else its latest
  payslip's date, in the expected month (its last day when shorter); a Saturday or Sunday becomes
  the Friday before. Bank holidays are not known.
- **Status** of an expected payment, first that applies:
  1. **arrived**: a salary credit no payslip explains, from a name the bank gave this payroll's
     earlier pay (or naming it), after the latest work it pays and no more than 15 days before the
     pay day. It is no longer owed; the Pay tab lists the credit under the payroll and says what
     it is for;
  2. **late**: the pay day has passed;
  3. **owed**.

### Expected pay (`analytics/earned.ts`, `shared/paye.ts`)

The deductions on an expected payment are estimates, labelled as such. *G* is its gross and the
pay day is *D*.

- **NI** (employee Class 1, category A, `employeeNi`): 8% of *G* between the monthly primary
  threshold and upper earnings limit, 2% above (`uk.ts`, `employeeNi`), to the penny, a half penny
  down. NI is worked out pay period by pay period, never over the year.
- **Tax basis** (`taxBasis`), from this payroll's latest payslip with pay and a tax figure:
  1. the tax code it prints (`taxCode`);
  2. else the standard code (personal allowance ÷ 10, `1257L`) on a month-1 basis, then
     cumulatively, whichever gives that payslip's tax within £1;
  3. else no tax estimate.
- **PAYE** (`payeTax`), England, Wales and Northern Ireland rates; a Scottish code is not worked
  out:
  - allowance for *m* months = (code number × 10 + 9) × *m* ÷ 12, *m* = 1 on a month-1 basis, else
    the tax month of *D* (month 1 runs 6 April to 5 May);
  - taxable = ⌊pay − allowance⌋ in whole pounds, pay being *G*, or on a cumulative code *G* plus
    this payroll's earlier pay in the tax year (a K code adds the allowance instead);
  - tax = 20% up to ⌈basic-rate band × *m* ÷ 12⌉, 40% up to ⌈(additional-rate threshold −
    personal allowance) × *m* ÷ 12⌉, 45% above; BR, D0 and D1 tax everything at one rate; NT
    nothing;
  - this payment's tax = that − the tax already paid in the year (cumulative codes; negative is a
    refund). A K code's is at most half of *G*.
- **Pension**: the latest payslip's pension ÷ its gross × *G*, when it had one.
- **Student loan**: not estimated; said when the latest payslip had one.
- **Take-home** = *G* − tax − NI − pension, when tax and NI are both estimated.
- **Paid at once**: when one payment pays two months or more, the same deductions with each
  month's pay as a payment of its own on *D*. NI adds what the extra threshold would have spared;
  a month-1 code taxes each alone; a cumulative code's tax is the same either way. The difference
  is shown: the NI part is never refunded, the tax part is settled after the tax year.

## 18. The month in review (`analytics/month.ts`)

A month's figures, by fixed rules (`MONTH_RULES`), for the Overview's month card
(`GET /api/month/:month`) and the month in review's digest alike. A month is **complete** when every
account has data for at least 90% of its days (§3); a month's comparisons use complete months only.

**Money in** is the month's income (§14) in four lines, with borrowing apart:

- **Pay:** salary and bonus. **Gifts received.** **Other income:** every other income category.
  **Uncategorised money in.**
- **Borrowed:** what a loan (any liability but a card) lent you or paid for you, each payment once:
  - a row on a loan that took its balance further into debt, not its interest or fees (a Tuition
    Fee Loan's payment to the university, a maintenance instalment's row);
  - money into another account from a loan whose own row isn't recorded yet (a credit linked to
    the loan as its other side, with no transfer link to a row of the loan's).
  Borrowing is never income; total money in = income + borrowed.

**Spending** (§14), in lines that add up to it to the penny, each payment in one:

- **Money back:** spending lines below zero (refunds, money paid back to you, a refund in its
  purchase's category).
- **Scheduled:** a payment one of your agreements schedules (paired with one of its payments, or
  filed by it).
- **Regular:** a payment in a regular-payment group (§10) as the groups stood at the month's end.
- **One-offs:** a payment of £250 or more (`oneOffMinimum`) to a payee you paid fewer than 3 times
  (`oneOffPriorPayments`) in the 365 days before it. Cash from a machine is nobody's.
- **Everyday:** the rest.

Each line is broken down by category group.

**Left over** = income − spending.

**Moved:** money between your current accounts and your others, by where it went (savings, ISAs, the
Lifetime ISA, pensions, investments, credit cards, loans, or an account the app doesn't know): a
transfer's amount on the current account, by the other side's type. A loan's money in is borrowing,
not moved; current account to current account is neither.

**Worth:** the estate (§9) on the day before the month and on its last day, by group, and each
account's value at both ends with what the end value rests on (§9, `basis`). A value at market
resting on a valuation more than 31 days before the month's end (`valuationDays`), or worked back
from a later one, is marked `oldValuation`: its change is not the month's.

**Quality:**

- uncategorised spending and money in, with their shares;
- payments with people (§10) in the month not decided by you, a rule or an agreement (count, in and
  out), and cash and cheques paid in likewise (count and amount);
- spending and money in categorised from a guess, the bank's category or the reader's suggestion,
  that you haven't confirmed (§10, "Guesses to check"), with their shares. People's payments and cash
  and cheques paid in are counted above instead.

**Compared:** each line, spending and left over against the complete months among the 12 before
(`historyMonths`): their median (the mean of the middle two for an even count), lowest and highest,
and how many there were; and the same month a year before, when complete. None when no month before
is complete.

**Payees:** those paid this month and not in the 365 days before (people's payments apart), the
largest first; regular payments that started this month (their first payment), stopped (not active
at the month's end, the next one due in it) or changed price in it.

**Coming:** your agreements' payments due in the 60 days after the month (`comingDays`), in and out,
not cancelled.

