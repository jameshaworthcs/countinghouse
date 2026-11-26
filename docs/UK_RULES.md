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
- **Savings income tax rates:** from 2027/28, 24% basic, 44% higher, 49% additional (property
  income likewise). Budget 2025 had set 22%, 42% and 47%; Budget 2026 raised them two points more.
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

### Cash ISAs from April 2027 (cut dropped in Budget 2026)

- Autumn Budget 2025 announced a **£12,000** cash-ISA limit for savers under 65 from 2027/28, with
  anti-circumvention rules to support it: no transfers from stocks & shares or IF ISAs into cash
  ISAs, and a 22% charge on interest on cash held inside stocks & shares ISAs.
- Budget 2026 (28 October 2026) dropped the cut: "the government will retain the cash ISA limit at
  £20,000 for all savers over 18 years old from April 2027". The whole ISA allowance can still go
  into cash, so the app sets no separate cash cap for any year.
- The anti-circumvention rules existed only to support the lower cash limit. Budget 2026's overview
  does not restate them, and the app does not model them.
- `cashIsaLimitUnder65` stays in the tables (null in every year) in case a cap returns; the app
  would apply it using your date of birth, with the full limit from the start of the tax year in
  which you turn 65.

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
- From **29 October 2026** a first home **over** the £450,000 cap pays a 20% charge instead of 25%
  (Budget 2026; `LISA_OVER_CAP_CHARGES` in `uk.ts`). Every other unauthorised withdrawal still pays
  25%.
- The charge applies to the whole withdrawal, so you get back 75% of the value. That loses the
  bonus plus 6.25% of your own money; the app shows this "penalty-adjusted value" (the 25% case).
- **First Time Buyer ISA** (Budget 2026): it replaces the LISA for new savers, launching **April
  2029** once primary and secondary legislation are in place.
  - A 25% government bonus on the final balance, up to £20,000, paid on withdrawal for a first home
    worth up to £450,000.
  - Existing LISA holders can keep saving into and using their accounts under the current rules.
  - HM Treasury consulted on it from June to 18 August 2026.
  - The app does not model it yet: nothing can be opened before 2029.
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

## Companies

A director's loan (FORMULAS.md §9): what your company owes you, or you owe it. The app warns of
two rules, from the account's balance (`src/shared/uk.ts`, analytics/director-loan.ts). It does not
work out a date or a sum due: the company's accounting period is not known here, and a loan's tax is
the company's to work out with its accountant.

- **Loans to participators (CTA 2010 s455).** A close company that has lent money to a participator
  (you, as its shareholder) owes Corporation Tax on what is still owed when it is due: **the day after
  9 months from the end of the accounting period** the loan was made in (s455(3)). The rate is the
  **dividend upper rate of the tax year the loan was made** (ITA 2007 s8(2); Finance Act 2016 s50,
  for loans made on or after 6 April 2016; a flat **25%** before). `s455Rate` reads it from the
  year's dividend rates in `TAX_YEAR_PARAMS`, so the two never disagree: **32.5%** for loans made
  2016/17 to 2021/22, **33.75%** 2022/23 to 2025/26, **35.75%** from 6 April 2026 (the dividend
  upper rate's rise in Budget 2025). Repaid or released, the tax on what was repaid is relieved
  (s458): before the due date none is paid; after it, it is repaid 9 months after the end of the
  period in which the loan was repaid.
- **Repaying and borrowing again (CTA 2010 s464ZA).** A repayment of **£5,000** or more followed
  within **30 days** by new borrowing of £5,000 or more (in a later accounting period) is matched to
  the new borrowing, not the old; so is a repayment made while **£15,000** or more is owed when there
  are arrangements to borrow again (£5,000 or more). These rules were s464C until 30 October 2024,
  when Finance Act 2025 s81 replaced Chapter 3B with ss464ZA and 464ZB (`S455_REBORROWING`).
- **Beneficial loans (ITEPA 2003 s180).** A loan to an employee or director (the company you work
  for) whose total outstanding is over **£10,000 at any time in a tax year** is a benefit in kind,
  taxed on the interest at HMRC's official rate less any interest paid (Finance Act 2014 s22: £10,000
  from 2014/15, £5,000 before; `BENEFICIAL_LOAN_THRESHOLDS`). The app warns when the most you owed the
  company on any day of this tax year so far is over it; the official rate itself is not used.

## Self Assessment

For 2025/26 on, the Self Assessment prep page is the return box by box (FORMULAS.md §20), on the
forms of `src/shared/saforms.ts`: the 2026 editions of the SA100, SA102, SA106, SA108 and SA110, for
2025–26. Box numbers and wording change between years, so each year's forms are a catalogue of
their own, worded as the form prints them, never as the notes do. HMRC's notes have errors the
forms do not: the SA150 notes say box 5 for small foreign dividends (the form: box 6), print last
year's split capital gains rates in their rough guide, and show an SA102 box 8.1 the form does not
have; the SA110 notes give the 2024/25 Plan 4 threshold (£31,395) where HMRC's calculation uses
£32,745. Earlier years keep the section-by-section prep. Check-if-you-need-to-file hints are
only hints; see [gov.uk/check-if-you-need-tax-return](https://www.gov.uk/check-if-you-need-tax-return).
**Everything on that page must be checked by you against your own documents before you submit.**

**New on the 2025–26 return** (the Income Tax (Additional Information) Regulations, SI 2025/84):
SA102 box 6 (director) and box 7 (close company) must be answered Yes or No; a director of a close
company gives its name, registration number, the dividends received from it (0 if none; they are
in TR 3 box 4 too) and the highest percentage shareholding in the year (boxes 7.1–7.4).
Self-employment pages gain start and end date questions. TR 3 box 6 takes foreign dividends only up
to £500 and only when total dividends are within it; above that they go on the Foreign page, where
Foreign Tax Credit Relief is claimed.

**The calculation** (`src/shared/taxcalc.ts`, the year's rows in `uk.ts`): HMRC's online
calculation specification for 2025–26 ("Calculate Tax and NIC", v1.5.1a, and its payments on
account stage) sets the rounding: income boxes down to whole pounds, each band's tax down to the
penny, the High Income Child Benefit Charge and student loan down to whole pounds, the odd penny of
payments on account on the second. 2025/26 figures:

- Scottish bands (taxable income): starter 19% to £2,827, basic 20% to £14,921, intermediate 21% to
  £31,092, higher 42% to £62,430, advanced 45% to £125,140, top 48%. The Personal Savings Allowance
  turns on the UK limits for everyone.
- Marriage Allowance £1,260 (a 20% reducer for the one receiving it).
- Student loans through Self Assessment: Plan 1 £26,065, Plan 2 £28,470, Plan 4 £32,745 at 9%;
  Postgraduate Loan £21,000 at 6%; unearned income counts in full once over £2,000. No Plan 5
  repayments are due through the 2025/26 return (they start from April 2026).
- Class 4 NI: 6% on profits from £12,570 to £50,270, 2% above.
- Capital gains tax: 18% and 24% on all gains from 6 April 2025 (`cgtRates`); 2024/25's rates
  changed on 30 October 2024, so its tax is not worked out here.
- Payments on account: none if the income tax and Class 4 left after tax taken off is under
  £1,000, or under 20% of the year's; capital gains tax and student loans never count. A balance
  under £3,000 coded out leaves none.

**Deadlines for a tax year's return** (`saDeadlines` in `src/shared/uk.ts`), the year ending on 5
April:

- **5 October** after the year: tell HMRC you need to send a return (register), if you have not
  sent one before. Registering later gives you a later date to send it by (3 months from HMRC's
  letter), but the tax is still due on 31 January.
- **31 October**: a paper return must reach HMRC.
- **30 December**: send it online by then to pay a bill through your tax code, if you already pay
  tax through PAYE and owe less than **£3,000** (`codingOutLimit`), with no part payment to get
  under it.
- **31 January**: send it online, and pay the tax you owe (with the first payment on account for
  the next year, if you make them).
- **31 July**: the second payment on account, if you make them.

**Correcting a return** (`saCorrectBy`, `oldestOpenTaxYear` in `src/shared/uk.ts`): within 12
months of the 31 January deadline, so a 2024/25 return can be corrected until **31 January 2027**.
Until then the year is still open: Settings → Data health lists the days no document covers back
to the start of the oldest open year, since its figures can still change what you send.
Overpayment relief can be claimed for 4 years after the year ends; the app does not use that.

**Dividends over the allowance** (`dividendsReturnThreshold`, `untaxedIncomeNoticeBy` in
`src/shared/uk.ts`):

- Up to **£10,000**: if you send a return, they go on it. If not, HMRC must hear of them after the
  tax year ends and **before 5 October**, by asking it to collect the tax through your tax code or
  by calling its helpline.
- Over £10,000: you must send a return. If you do not usually send one, register for Self
  Assessment by **5 October** after the tax year.
- Within the dividend allowance there is nothing to report.

## Sources

Checked 26 November 2026 (companies: a director's loan):

- legislation.gov.uk, [CTA 2010 s455](https://www.legislation.gov.uk/ukpga/2010/4/section/455) (the charge at the dividend upper rate of the tax year the loan is made; due under TMA 1970 s59D the day after 9 months from the end of the accounting period; s458 relief), [Finance Act 2016 s50](https://www.legislation.gov.uk/ukpga/2016/24/section/50) (25% replaced by the dividend upper rate, for loans made on or after 6 April 2016), [CTA 2010 s464ZA](https://www.legislation.gov.uk/ukpga/2010/4/section/464ZA) (repayments matched to new borrowing: £5,000 within 30 days; £15,000 owed with arrangements), [Finance Act 2025 s81](https://www.legislation.gov.uk/ukpga/2025/8/section/81) (ss464ZA and 464ZB in place of Chapter 3B, s464C, from 30 October 2024), [ITEPA 2003 s180](https://www.legislation.gov.uk/ukpga/2003/1/section/180) and [Finance Act 2014 s22](https://www.legislation.gov.uk/ukpga/2014/26/section/22) (the £10,000 threshold from 2014/15, £5,000 before)
- GOV.UK, [Tax on dividends](https://www.gov.uk/tax-on-dividends) (2026/27 rates: 10.75%, 35.75%, 39.35%), the dividend upper rate s455 follows

Checked 25 November 2026 (the 2025–26 return):

- HMRC, [SA100 Tax Return 2026](https://assets.publishing.service.gov.uk/media/69c14d07cfa346b9d4704a8d/SA100-2026.pdf), the SA150 notes, [SA102 Employment 2026 and its notes](https://www.gov.uk/government/publications/self-assessment-employment-sa102), [SA106 Foreign 2026 notes](https://assets.publishing.service.gov.uk/media/69bbd6144c478213a823ce14/SA106_Notes_2026.pdf), [SA108 Capital Gains 2026 notes](https://assets.publishing.service.gov.uk/media/6a02e5df4fb0713aa63ea77c/SA108-Notes-2026.pdf), [SA110 Tax calculation summary 2026](https://assets.publishing.service.gov.uk/media/69c4fc1123fcbcd838a6f6e8/SA110-2026.pdf) and [its notes](https://assets.publishing.service.gov.uk/media/69c4fc274a06660f0854422a/SA110-Notes-2026.pdf)
- HMRC, [Calculate Tax and NIC, MTR v1.5.1a](https://assets.publishing.service.gov.uk/media/69c26e8dcfa346b9d4704b3f/Calculate_Tax_and_NIC_MTR_version_1.5.1a.odt) and [Payments on Account, stage 13](https://assets.publishing.service.gov.uk/media/699315137149b335a315b487/Payments_on_Account__Stage_13__Tax_and_NIC_calculation_version_1.0.0a.odt) (the online calculation, 2025–26)
- HMRC, [HS263 Relief for foreign tax paid 2026](https://www.gov.uk/government/publications/calculating-foreign-tax-credit-relief-on-income-hs263-self-assessment-helpsheet/relief-for-foreign-tax-paid-2026-hs263)
- GOV.UK, [Scottish Income Tax 2025 to 2026](https://www.gov.uk/scottish-income-tax/2025-to-2026-tax-year), [Previous annual repayment thresholds](https://www.gov.uk/guidance/previous-annual-repayment-thresholds), [Tell HMRC about a student loan in your tax return](https://www.gov.uk/guidance/tell-hmrc-about-a-student-loan-in-your-tax-return), [Rates and allowances: National Insurance contributions](https://www.gov.uk/government/publications/rates-and-allowances-national-insurance-contributions/rates-and-allowances-national-insurance-contributions), [Capital Gains Tax rates and allowances](https://www.gov.uk/guidance/capital-gains-tax-rates-and-allowances), [Adjusted net income](https://www.gov.uk/guidance/adjusted-net-income)
- legislation.gov.uk, [ITA 2007 s.25](https://www.legislation.gov.uk/ukpga/2007/3/section/25) (allowances set where they save most tax), [TMA 1970 s.59A](https://www.legislation.gov.uk/ukpga/1970/9/section/59A) (payments on account)

Checked 3 October 2026:

- GOV.UK, [Correct a Self Assessment tax return](https://www.gov.uk/self-assessment-tax-returns/corrections) (within 12 months of the deadline: by 31 January 2027 for 2024/25; overpayment relief up to 4 years after the year)

Checked 1 October 2026:

- GOV.UK, [Self Assessment tax returns: deadlines](https://www.gov.uk/self-assessment-tax-returns/deadlines) (5 October, 31 October, 30 December, 31 January, 31 July)
- GOV.UK, [Pay your Self Assessment tax bill: through your tax code](https://www.gov.uk/pay-self-assessment-tax-bill/through-your-tax-code) (under £3,000, online by 30 December, already paying through PAYE)

- GOV.UK, [Rates and thresholds for employers 2026 to 2027](https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027) (Class 1 NI thresholds and rates, emergency tax code)
- GOV.UK, [Tax on dividends: how to report tax on dividends](https://www.gov.uk/tax-on-dividends/how-to-report-tax-on-dividends) (up to £10,000 through your tax code by 5 October; over £10,000 a return, registering by 5 October; 2026/27 dividend rates 10.75%, 35.75%, 39.35%)

Checked 2 November 2026:

- GOV.UK, [Budget 2026: overview of tax legislation and rates](https://www.gov.uk/government/publications/budget-2026-overview-of-tax-legislation-and-rates-ootlar/budget-2026-overview-of-tax-legislation-and-rates-ootlar) (cash ISA limit kept at £20,000, savings and property rates 24%, 44%, 49% from 2027/28, LISA over-cap charge 20% from 29 October 2026, First Time Buyer ISA from April 2029) and its [Annex A: rates and allowances](https://www.gov.uk/government/publications/budget-2026-overview-of-tax-legislation-and-rates-ootlar/annex-a-rates-and-allowances)

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
