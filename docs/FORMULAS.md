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
| Interest | your `interest.rate` → the rate on the account → the latest statement's rate → researched product rate (best name match) → agents' → fallback by account type |
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
  - a statement that does not print its start runs from the day after the statement before it
    (the latest-ending one with a closing balance) when it opens on that one's closing balance and
    ends within `STATEMENT_CYCLE_DAYS` = 40 of it (`importIntervals`). The balances chain, so a
    quiet stretch before its first row is covered, not missing. Two cycles apart, a statement is
    missing between, and it is not linked;
- each hand-entered transaction's day;
- for an account with transactions but no import records: from its first to its last transaction.

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
  - your recorded forecast (today's money), else the full new State Pension for the current tax
    year (52 × weekly rate, UK tables);
  - from your State Pension age (`statePensionDate`, the legislated timetable).
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

- Anchors are statement or screenshot balances and end-of-day running balances.
  - On a day with both, a statement's or your own balance outranks a screenshot's, which may
    have been taken mid-day.
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

- Consecutive strong anchors (not screenshots or approximate figures) with
  anchor_b ≠ anchor_a + Σ tx in (a, b], each transaction on the day it counts from.
- The difference is what is unexplained.
- The strong anchors either side of a day (`between`): the last one before it and the first on or
  after it, and what is unexplained between them. A proposal that takes away a move inside the
  account (§ "Proposed fixes" in AGENTS.md) must leave that at nothing.

**Estate value on D:**

- Σ over included accounts of balance(D) in GBP (manual FX).
- A balance's sign decides assets or liabilities: an overdraft is a debt; a card in credit is cash.
- Before an account's first data it adds nothing, so a total on D can leave accounts out.

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

**Pension annual allowance:**

- Per account: personal contributions, grossed up for relief at source by 1/(1−r) when no relief
  rows are recorded; plus employer contributions and recorded relief.
- Pension-statement figures win when larger. Documents state what you paid and the basic-rate
  relief the provider added separately (`pension_contribution_employee`, `pension_tax_relief`);
  their sum is your gross contribution. Salary sacrifice is an employer contribution.
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
  - pay, employer by employer (figures grouped by payer): its P60 for the year, else its payslips
    added up (pay so far), never both. A figure is a payslip's when its document was a payslip,
    else when its period is under 200 days;
    - salary received (category `salary`, after tax) from employers no figure names counts as a
      floor; figures naming no employer are taken to cover all salary received. Salary the Pay tab
      pairs with a payslip, or lists under an employer with payslips (§17), is that employer's
      and never counts again;
    - for the year in progress, a larger full-year estimate wins: your salary in Settings, else
      last year's P60s;
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
  - `documents`: every employer's pay comes from its P60, and no salary is unaccounted for;
  - `estimate`: pay comes from your salary or last year's P60;
  - `minimum`: pay is known only so far (payslips, or salary after tax), so the band may be higher.
  The pages label the band with its basis.

**Dividends:** dividends outside ISAs and pensions, plus vouchers, against the dividend allowance.
In a general investment account, a dividend is investment income worded as one
(`DIVIDEND_WORDING`: "dividend", "distribution", or interactive investor's "Div 250 …").

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
- **Income:** an income category (refunds excepted).
- **Spending:** an expense category, or refunds, which count as negative spending.
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
when its document was a payslip, or, failing that, when its period is under 200 days.

- **A pay period** is an employer's payslip figures with one period, where two employers' names
  match once reduced (`payerKey`: case, spaces and "Ltd" go).
  - Its **gross**, **tax**, **NI**, **pension** and **student loan** are the figures of those
    kinds. A printed £0 is a figure.
  - **After these** = gross − tax − NI − pension − student loan (the deductions read).
- **Into your bank** is a salary credit (category *salary*, money in) between the period's end −
  10 days and the later of the pay date and the period's end + 10 days (`PAY_MATCH_DAYS`). Each
  credit is used once, found in two passes over all the year's payslips (`pairPay`):
  1. one whose text names the employer, the closest to *after these*;
  2. else one of exactly *after these*, to the penny, whatever name the bank gives it (an
     employer's payroll often pays under a group company's name), the nearest the pay date.
- **Status**, first that applies:
  1. **nothing due**: *after these* is £0 or less (a £0 payslip); no payment is looked for;
  2. **paid**: the credit is within £1 of *after these*;
  3. **differs**: it is not. The difference is other deductions the reader did not list (a cycle
     scheme, say) or an adjustment;
  4. **due**: the pay date has not come;
  5. **not seen**: none was found. The note says whether your bank data covers those days, in
     the accounts the employer's pay goes into, else any your salary goes into.
- Salary credits no payslip explains are pay with no payslip, listed under the employer their text
  names, else the employer the same payer paid (the nearest such payment), else their own name.
- **Year so far** adds up each column. With a P60 for the year (the same payer), its pay, tax and
  NI are shown beside the total, and whether the payslips add up to it:
  - they do when their tax and NI are within £1 of the P60's. Its pay can still be less than
    their gross by the pension taken before tax (a net pay arrangement): that is said;
  - payslip tax short of the P60's means payslips are missing; more than it, they need checking.
- A payslip or P60 names its employer as the document does. On the review page the payer can be
  renamed for all of a document's figures, so a payslip that prints a group name and a P60 that
  prints the employing company count as one employer.
