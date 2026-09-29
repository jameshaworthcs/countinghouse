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
| Fund make-up | your allocation on the instrument → researched allocation → the asset class on the statement → "mixed" (unknown) |

## 2. Money

- `toMinor(x) = round(100x)`; sums are of integers; `fromMinor(p) = p/100`.
- A value is valid money iff `round(100x)/100 = x`, exactly. That is the double a 2-dp decimal
  parses to; an absolute tolerance would reject amounts above about £86 million.
- Signs are from your point of view: money in and assets positive; money out and debts negative.

## 3. Coverage and baselines

**Coverage of an account** (`analytics/coverage.ts`) is the union of intervals:

- each committed import's statement period for the account (`periodStart`–`periodEnd`), or the
  span of its rows;
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

- Anchors are statement or screenshot balances and end-of-day running balances (the last row of a
  day that has one).
- balance(D):
  - with an anchor on or before D, balance(D) = anchor + Σ tx in (anchor, D];
  - otherwise, rolled back from the next anchor;
  - with no anchors, Σ tx ≤ D, flagged estimated.
- Prefix sums and binary search make each lookup O(log n).

**Market accounts:**

- Anchors are valuations. Between them, only external flows move the value (contributions,
  employer, relief, bonus, withdrawals, transfers).
- Before the first valuation:
  - within 45 days, rolled back by the flows since;
  - further back, contributions + (growth at the first valuation) × elapsed fraction since the
    first flow, flagged estimated.

**Approximate figures** (a balance you gave roughly, `approximate: true`):

- used only when dated after all of the account's real data (its last transaction and last real
  balance); dropped once real data reaches past them;
- balances computed from one are marked estimated;
- never counted as data for "last updated", staleness or gaps.

**Gaps:**

- Consecutive strong anchors (not screenshots or approximate figures) with
  anchor_b ≠ anchor_a + Σ tx in (a, b].
- The difference is what is unexplained.

**Estate value on D:**

- Σ over included accounts of balance(D) in GBP (manual FX).
- A balance's sign decides assets or liabilities: an overdraft is a debt; a card in credit is cash.

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
- Compared against the allowance for your tax band.

**Dividends:** dividends outside ISAs and pensions, plus vouchers, against the dividend allowance.

## 12. Money-weighted return (XIRR)

- Flows: the first recorded value as money put in, later external flows, and today's value as
  money out.
- Solve Σ F_i / (1+r)^(t_i) = 0 with t in years (days/365.25).
- Newton's method, with bisection on [−0.99, 5] as a fallback.
- Undefined for spans under a month.

## 13. Reconciliation and review checks (`shared/reconcile.ts`, `shared/review.ts`)

- **Opening and closing balance:** opening + Σ settled rows = closing.
- **Running balances:** each row's running balance = the previous row's running balance + its
  amount.
- Pending rows are excluded: statement and export balances are of settled transactions.

**Review checks** run on each account in a draft, on the review page and for "Commit all ready".
A warning holds an import back from bulk commit:

| Check | Warns when |
|---|---|
| Balances | the reconciliation above fails (the rows breaking a running balance are marked) |
| Totals | Σ settled money in or money out ≠ the totals printed on the statement, to the penny |
| Period | a row is dated outside the statement's printed period (not for exports, whose period is their first and last rows) |
| Future | a row is dated after the upload day |
| Card signs | on a credit card with ≥ 3 settled rows, most are money in, or a payment to the card is money out |
| Unsure | the reader marked a row as uncertain |
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
