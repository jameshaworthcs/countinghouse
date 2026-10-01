# UK rules

All figures live in dated tables in [`src/shared/uk.ts`](../src/shared/uk.ts). A tax year runs from
**6 April to 5 April**; rows apply from the tax year they name until superseded. When the rules
change, add a row there and update this page. The 2026/27 figures were checked against gov.uk,
HMRC, the FSCS and the Bank of England on 29 September 2026 (sources at the end).

## Tax-year allowances

| From | ISA | Cash ISA (under 65) | LISA | JISA | Pension AA | Taper threshold / adjusted / min | MPAA | Dividend allowance | CGT exempt |
|---|---|---|---|---|---|---|---|---|---|
| 2016/17 | £15,240 | none | none | £4,080 | £40,000 | £110k / £150k / £10k | £10,000 | £5,000 | £11,100 |
| 2017/18 | £20,000 | none | £4,000 | £4,128 | £40,000 | | £4,000 | £5,000 | £11,300 |
| 2018/19 | | | | £4,260 | | | | £2,000 | £11,700 |
| 2019/20 | | | | £4,368 | | | | | £12,000 |
| 2020/21 | | | | £9,000 | | £200k / £240k / £4k | | | £12,300 |
| 2023/24 | | | | | £60,000 | £200k / £260k / £10k | £10,000 | £1,000 | £6,000 |
| 2024/25 | | | | | | | | £500 | £3,000 |
| 2027/28 | £20,000 | **£12,000** | £4,000 | | | | | | |

Other parameters:

- **Personal Savings Allowance:** £1,000 basic, £500 higher, £0 additional (since 2016/17).
- **Starting rate for savings:** £5,000. It shrinks by £1 for every £1 of other income above the
  personal allowance, and is gone at £17,570. It is kept at £5,000 to 2030/31.
- **Personal allowance:** £12,570 (from 2021/22). It tapers by £1 for every £2 of income over
  £100,000, and is frozen to 2030/31 (Budget 2025).
- **Income tax (England, Wales, Northern Ireland), 2026/27:**
  - 20% on the first £37,700 above the allowance;
  - 40% up to £125,140;
  - 45% above.
  - The basic-rate band is frozen to 2030/31.
  - Earlier years: £32,000 (2016/17), £33,500, £34,500, £37,500 (2019/20 and 2020/21), then
    £37,700.
  - The additional rate started at £150,000 until 2022/23.
  - Scottish rates are not modelled.
- **Lump Sum Allowance:** £268,275; **Lump Sum and Death Benefit Allowance:** £1,073,100 (both from
  2024/25). Usually 25% of a pension can be taken tax-free, within the Lump Sum Allowance.
- **Dividend tax rates:**
  - 8.75%, 33.75% and 39.35% to 2025/26;
  - from 2026/27, 10.75% basic, 35.75% higher and 39.35% additional (unchanged).
  - The dividend allowance is £500.
- **Savings income tax rates:** from 2027/28, 22% basic, 42% higher, 47% additional (property
  income likewise).
- **Relief at source:** a net pension contribution is grossed up at the basic rate, 20% (£80 →
  £100).
- **High Income Child Benefit Charge:**
  - from 2024/25, it starts above £60,000 of adjusted net income, at 1% of the benefit for every
    £200, reaching the full benefit at £80,000;
  - before that, £50,000 and £60,000.
- **Trading and property allowances:** £1,000 each (from 2017/18). Gross trading income above
  £1,000 must be reported; above £2,500 you must register for Self Assessment.
- **Capital gains:**
  - The annual exempt amount is £3,000.
  - If you are registered for Self Assessment, gains must be reported when total disposal
    proceeds exceed £50,000, even with no tax due. Before 2023/24 the threshold was 4 × the
    exempt amount.

### Payroll: PAYE and employee NI

Used only to estimate the deductions on pay that is owed and not yet paid ([FORMULAS.md §17](FORMULAS.md),
"Expected pay"); a payslip's own figures always stand. Monthly pay only.

- **Employee Class 1 NI, category A** (`employeeNi`), from 2024/25 (2026/27 checked on 1 October
  2026):

  | | a week | a month | a year |
  |---|---|---|---|
  | Primary threshold | £242 | £1,048 | £12,570 |
  | Upper earnings limit | £967 | £4,189 | £50,270 |

  8% between them, 2% above. It is worked out for each pay period on its own, never over the year,
  so two months' pay in one payslip uses one threshold, not two. Years before 2024/25 are not
  modelled (2022/23 and 2023/24 changed rates part-way through).
- **PAYE tax codes** (`shared/paye.ts`): `L`, `M`, `N` and `T` codes and `0T` give an allowance of
  (number × 10 + 9) a year; `K` codes add that to pay instead, and the tax they take is at most
  half the pay; `BR`, `D0` and `D1` tax all pay at 20%, 40% and 45%; `NT` takes none. `M1`, `W1`
  or `X` after a code means each month is taxed on its own (the emergency basis, `1257L M1`);
  otherwise it is cumulative over the tax year. Bands are pro rata to the months counted. A `C`
  (Welsh) code uses these rates; an `S` (Scottish) code is not worked out.

### ISA reform, April 2027 (Autumn Budget 2025)

- The overall ISA allowance stays £20,000, but at most **£12,000 a year may go into cash ISAs** for
  savers under 65.
- The full £20,000 cash limit applies **from the start of the tax year in which you turn 65**.
- Transfers from stocks & shares or IF ISAs into cash ISAs are no longer allowed (except for
  over-65s).
- Interest on cash held inside stocks & shares ISAs is charged at a flat 22%.
- The app applies the cash cap using your date of birth. If no date of birth is set, the cap is
  assumed to apply.

### State Pension

| From | Full new State Pension a week | a year |
|---|---|---|
| 2016/17 | £155.65 | |
| 2017/18 | £159.55 | |
| 2018/19 | £164.35 | |
| 2019/20 | £168.60 | |
| 2020/21 | £175.20 | |
| 2021/22 | £179.60 | |
| 2022/23 | £185.15 | |
| 2023/24 | £203.85 | |
| 2024/25 | £221.20 | |
| 2025/26 | £230.25 | |
| 2026/27 | **£241.30** (+4.8%, with earnings) | £12,547.60 |

- **How it rises:** the triple lock, by the highest of earnings growth, CPI inflation and 2.5%.
  The app's `statePension.growth` assumption follows it.
- **Fallback:** without your forecast, the app uses the full rate, labelled as a fallback. Your
  gov.uk forecast replaces it, since the amount depends on your National Insurance record.
- **State Pension age** (current law, `statePensionDate`):

  | Born | State Pension age |
  |---|---|
  | 6 October 1954 – 5 April 1960 | 66 |
  | 6 April 1960 – 5 March 1961 | 66 and 1–11 months (6 April – 5 May 1960: 66 and 1 month; each later month of birth one more) |
  | 6 March 1961 – 5 April 1977 | 67 |
  | 6 April 1977 – 5 April 1978 | a fixed date from 6 May 2044 (born 6 April – 5 May 1977) to 6 March 2046, two months later for each later month of birth |
  | 6 April 1978 onwards | 68 |

  The move from 67 to 68 is subject to the statutory reviews and may change.

### Lifetime ISA

- £4,000 a year, counted within the £20,000.
- 25% government bonus (up to £1,000 a year).
- Open aged 18–39; contributions and bonus stop at 50.
- 25% withdrawal charge, except:
  - for a first home up to £450,000;
  - from age 60;
  - on terminal illness.
- The charge applies to the whole withdrawal, so you get back 75% of the value. That loses the
  bonus plus 6.25% of your own money; the app shows this "penalty-adjusted value".
- **Proposed:** a First Time Buyer ISA, to be offered in place of the LISA once available.
  - HM Treasury consulted in June 2026; responses closed 18 August 2026.
  - No start date has been set ("as soon as practically possible").
  - Until then LISAs can still be opened, and existing holders can keep saving under the current
    rules indefinitely.
  - The new bonus is to be paid on subscriptions at purchase. Limits, bonus and price cap are to
    be announced at a future fiscal event.

### Pensions

- Annual allowance £60,000 since 2023/24, including employer contributions and tax relief.
- Tapered by £1 for every £2 of adjusted income over £260,000 (when threshold income exceeds
  £200,000), down to £10,000.
- Unused allowance can be carried forward from the previous 3 tax years if you were a member of a
  scheme.
- Relief at source: a net £80 personal contribution is grossed up to £100. Higher and additional
  rate relief is claimed through Self Assessment.
- **Normal minimum pension age** rises from **55 to 57 on 6 April 2028**. The app uses 55 if you
  reach 55 before that date, otherwise 57; protected pension ages are not modelled.
- Salary sacrifice: from 6 April 2029, pension contributions above £2,000 a year made by salary
  sacrifice become subject to National Insurance (Budget 2025; informational only).

### FSCS

- Deposit protection is **£120,000 per person per banking licence from 1 December 2025** (it was
  £85,000). Joint accounts are covered to £240,000, and temporary high balances to £1.4m.
- The app sums cash (current, savings, cash ISA) per institution FSCS group and warns at 80% of
  the limit.
- Brands sharing a licence (e.g. Halifax and Bank of Scotland; HSBC, first direct and M&S Bank)
  share a group. Edit the groups in Settings → Data & git.
- NS&I is 100% Treasury-backed and excluded.

## Self Assessment

The Self Assessment prep page maps your data to SA100/SA102/SA103/SA108 sections. Box numbers
change between years, so the page names sections, not boxes. Filing and payment are due online by
**31 January** after the tax year ends. Check-if-you-need-to-file hints are only hints; see
[gov.uk/check-if-you-need-tax-return](https://www.gov.uk/check-if-you-need-tax-return).
**Everything on that page must be checked by you against your own documents before you submit.**

**Dividends over the allowance** (`dividendsReturnThreshold`, `untaxedIncomeNoticeBy` in
`src/shared/uk.ts`):

- Up to **£10,000**: if you send a return, they go on it. If not, HMRC must hear of them after the
  tax year ends and **before 5 October**, by asking it to collect the tax through your tax code or
  by calling its helpline.
- Over £10,000: you must send a return. If you do not usually send one, register for Self
  Assessment by **5 October** after the tax year.
- Within the dividend allowance there is nothing to report.

## Sources

Checked 1 October 2026:

- GOV.UK, [Rates and thresholds for employers 2026 to 2027](https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027) (Class 1 NI thresholds and rates, emergency tax code)
- GOV.UK, [Tax on dividends: how to report tax on dividends](https://www.gov.uk/tax-on-dividends/how-to-report-tax-on-dividends) (up to £10,000 through your tax code by 5 October; over £10,000 a return, registering by 5 October; 2026/27 dividend rates 10.75%, 35.75%, 39.35%)

Checked 29 September 2026:

- GOV.UK, [The new State Pension: what you'll get](https://www.gov.uk/new-state-pension/what-youll-get) and [Over 12 million pensioners to receive £575 State Pension boost](https://www.gov.uk/government/news/over-12-million-pensioners-to-receive-575-state-pension-boost) (£241.30 a week from April 2026)
- GOV.UK, [State Pension age timetable](https://www.gov.uk/government/publications/state-pension-age-timetable/state-pension-age-timetable)
- GOV.UK, [Income Tax rates and allowances for current and past years](https://www.gov.uk/government/publications/rates-and-allowances-income-tax/income-tax-rates-and-allowances-current-and-past)
- GOV.UK, [Budget 2025: overview of tax legislation and rates](https://www.gov.uk/government/publications/budget-2025-overview-of-tax-legislation-and-rates-ootlar/budget-2025-overview-of-tax-legislation-and-rates-ootlar) (freezes to 2030/31, savings and property rates from 2027/28, dividend rates from 2026/27, cash-ISA limit, salary sacrifice)
- GOV.UK, [Pension schemes rates and allowances](https://www.gov.uk/government/publications/rates-and-allowances-pension-schemes/pension-schemes-rates) and [Work out your tapered annual allowance](https://www.gov.uk/guidance/pension-schemes-work-out-your-tapered-annual-allowance)
- GOV.UK, [Individual Savings Accounts](https://www.gov.uk/individual-savings-accounts), [Lifetime ISA](https://www.gov.uk/lifetime-isa) and [withdrawing from a Lifetime ISA](https://www.gov.uk/lifetime-isa/withdrawing-money-from-your-lifetime-isa)
- GOV.UK, [First Time Buyer ISA: consultation](https://www.gov.uk/government/consultations/first-time-buyer-isa-consultation/first-time-buyer-isa-consultation)
- GOV.UK, [High Income Child Benefit Charge](https://www.gov.uk/child-benefit-tax-charge)
- GOV.UK, [Tax on savings interest: how much is tax-free](https://www.gov.uk/apply-tax-free-interest-on-savings/how-much-is-tax-free)
- GOV.UK, [Tax-free allowances on property and trading income](https://www.gov.uk/guidance/tax-free-allowances-on-property-and-trading-income)
- GOV.UK, [Capital Gains Tax: work out if you need to pay](https://www.gov.uk/capital-gains-tax/work-out-need-to-pay) and [allowances](https://www.gov.uk/capital-gains-tax/allowances)
- GOV.UK, [Who must send a tax return](https://www.gov.uk/self-assessment-tax-returns/who-must-send-a-tax-return). It no longer lists a £10,000 savings-income threshold, so the Self Assessment page does not claim one.
- Bank of England, [PRA confirms FSCS deposit limit to be increased to £120,000 from 1 December](https://www.bankofengland.co.uk/news/2025/november/pra-confirms-fscs-deposit-limit-to-be-increased-to-120000-from-1-december)

Earlier:

- GOV.UK, [Cash ISA limit reduction](https://www.gov.uk/government/publications/reduction-in-the-cash-individual-savings-account-isa-limit/cash-individual-savings-account-isa-limit-reduction)
- GOV.UK, [ISA reform 2027: anti-circumvention rules factsheet](https://www.gov.uk/government/publications/fiscal-events-2026-factsheets/isa-reform-2027-anti-circumvention-rules-factsheet)
- FSCS, [Deposit protection limit rising to £120,000](https://www.fscs.org.uk/industry-resources/deposit-limit-change-stakeholder-materials/)
- FSCS press release, [FSCS welcomes higher deposit protection limit of £120,000](https://www.fscs.org.uk/media/press/2025/nov/fscs-welcomes-higher-deposit-protection-limit-of-120000--giving-people-confidence-their-money-is-protected/)
- AJ Bell, [HMRC confirms new ISA will replace Lifetime ISA for first-time buyers only](https://www.ajbell.co.uk/group/news/hmrc-confirms-new-isa-will-replace-lifetime-isa-first-time-buyers-only)
- Fidelity, [2026/2027 tax allowances, what's changed?](https://www.fidelity.co.uk/markets-insights/personal-finance/personal-finance/20262027-tax-allowances-whats-changed/)
- Historic allowances: HMRC rates and allowances pages for each year
