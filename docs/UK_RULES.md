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

A company you run, from two sides: your director's loan with it, and, when you keep its books here,
its own periods and deadlines.

### A director's loan

What your company owes you, or you owe it (FORMULAS.md §9). The app warns of two rules, from the
account's balance (`src/shared/uk.ts`, analytics/director-loan.ts). It does not work out a date or a
sum due: a loan's tax is the company's to work out with its accountant, and the warning does not read
the company's books (below), which are the company's records, kept apart.

- **Loans to participators (CTA 2010 s455).** Only for a **close company** (most owner-managed
  companies are) lending to a **participator** in it, such as a shareholder: the warning says so. It
  owes Corporation Tax on what is still owed when it is due: **the day after 9 months from the end of
  the accounting period** the loan was made in (s455(3)). The rate is the **dividend upper rate of
  the tax year the loan was made** (ITA 2007 s8(2); Finance Act 2016 s50, for loans made on or after
  6 April 2016; a flat **25%** before). `s455Rate` reads it from the year's dividend rates in
  `TAX_YEAR_PARAMS`, so the two never disagree: **32.5%** for loans made 2016/17 to 2021/22,
  **33.75%** 2022/23 to 2025/26, **35.75%** from 6 April 2026 (the dividend upper rate's rise in
  Budget 2025). The warning gives each part of what you owe at the rate of the tax year you borrowed
  it (FORMULAS.md §9), and the table for a part borrowed before the first day the app knows.
- **Relief on repayment (CTA 2010 s458).** Repaid (or released) before the tax is due, none is paid
  on what was repaid. Repaid later, the company claims the tax back: within **4 years** of the end of
  the financial year in which it was repaid, and the relief is not given until **9 months** after the
  end of the accounting period in which it was repaid.
- **Released or written off.** The company's s455 tax is relieved (s458), but the amount released is
  taxed as the participator's income (ITTOIA 2005 s415).
- **Repaying and borrowing again (CTA 2010 s464ZA).** Repayments of **£5,000 or more** and new
  borrowing of **£5,000 or more** within any **30-day** period, the new borrowing in a later
  accounting period than the loan repaid, are matched: the repayment counts against the new borrowing,
  not the old. So is a repayment made while **£15,000 or more** is owed, when there are arrangements
  to borrow again (£5,000 or more). Neither applies where the repayment is itself taxed as the
  participator's income, such as a dividend or salary used to clear the loan (s464ZA(6)). Finance Act
  2025 s81 re-enacted ss464C and 464D in Chapter 3 as ss464ZA and 464ZB, treated as in force from
  30 October 2024, and repealed s464B (`S455_REBORROWING`).
- **Beneficial loans (ITEPA 2003 s180).** A loan to an employee or director (the company you work
  for) whose total outstanding is over **£10,000 at any time in a tax year** is a benefit in kind,
  taxed on the interest at HMRC's official rate less any interest paid, and the company owes Class 1A
  National Insurance on it (Finance Act 2014 s22: £10,000 from 2014/15, £5,000 to 2013/14; both rows
  in `BENEFICIAL_LOAN_THRESHOLDS`). The app warns when the most you owed the company on any day of
  this tax year so far is over it; the official rate itself is not used.

### Periods and deadlines (a company's books)

For a private limited company whose books are kept here (FORMULAS.md §22): what it must file and pay,
and by when, worked out by the pure functions and tables in `src/shared/uk.ts` ("Companies: periods
and deadlines"). Months are calendar months; a number of months after a day ends on the
corresponding day, or the month's last day when the month has none (CA 2006 s443(2), (4)). A month's
end runs to a month's end: by s443(3) for Companies House's periods, and by HMRC's practice for
Corporation Tax (CTM01800 for payment; CTM93040 for returns: a period to 28 February before a leap year
files on 29 February, one to 29 February on 28 February). Each rule is a row dated from when it is in
force (`ruleOn`), looked up by the period's own date, so a later change is never applied to an earlier
period: accounts from 6 April 2008 (CA 2006 Part 15, SI 2007/3495 art 3; CA 1985's earlier periods are
not covered), confirmation statements from 30 June 2016 (Part 24 as substituted by the Small Business,
Enterprise and Employment Act 2015 s92, SI 2016/321; annual returns are not covered), Corporation Tax
for accounting periods ending from 1 July 1999 (Corporation Tax Self Assessment), and VAT returns
from 1 April 2019 (Making Tax Digital, every return made online).

- **Accounting reference periods (CA 2006 ss391–392).** The default accounting reference date is the
  last day of the month in which the anniversary of incorporation falls (s391(4), for a company
  incorporated in Great Britain from 1 April 1996, in Northern Ireland from 22 August 1997, or after
  the Act's commencement). The first period begins on the day of incorporation and is more than 6
  months and not more than 18 months, ending on the reference date (s391(5)); later ones are 12
  months. A notice under s392 shortens or extends a period, never past 18 months (s392(5)), and an
  extension is not effective within 5 years of an earlier one (s392(3), with exceptions); the app
  takes the periods you set and refuses one over 18 months, but does not check the 5 years: copy
  shortened or extended periods from the Companies House register. A February reference date means the month's last day, the 29th in a leap year: the default is "the
  last day of the month" (`ACCOUNTING_PERIOD_RULES`, `defaultAccountingReferenceDate`).
- **Accounts (CA 2006 s442).** A private company delivers its accounts within **9 months** after the
  end of the period (s442(2)(a)). For a first period longer than 12 months, the later of **9 months
  from the first anniversary of incorporation** and **3 months from the end of the period**
  (s442(3)): 21 months from incorporation for most. Not worked out: a shortened period's 3 months
  from the notice (s442(4)) and the Secretary of State's extension (s442(5)–(5A)). The first
  anniversary of a 29 February incorporation is taken as 28 February: the Act does not settle it, and
  this errs early (1 March would give a day later) (`ACCOUNTS_FILING_RULES`,
  `accountsFilingDeadline`).
- **Confirmation statement (CA 2006 s853A).** Delivered within **14 days** after the end of each
  review period (s853A(1)). The first review period is 12 months beginning with the day of
  incorporation, each later one 12 months beginning the day after the last (s853A(5)); a statement
  made up to an earlier day starts the next review period the day after it (s853A(6)), and its
  made-up date is no later than the review period's last day (s853A(4)). So the first is made up to
  the day before the anniversary of incorporation, as Companies House shows it, and **one made up
  early is still due 14 days after its review period's end**, not after its made-up date: filed by
  then, it is not late (`CONFIRMATION_STATEMENT_RULES`, `confirmationStatementDue`).
- **Corporation Tax accounting periods (CTA 2009 ss9–10).** One begins when the company **comes
  within the charge** (s9(1)(a)): when it starts to carry on business (s9(2)) or has a source of
  income. That is wider than trade: interest on its bank account alone brings it within the charge
  (GOV.UK, "Dormant for Corporation Tax": "Trading includes … getting interest"). Another begins
  straight after one ends (s9(1)(b)). One ends on the first of: **12 months from its beginning**
  (s10(1)(a)); its accounting date, or the end of a period it makes up no accounts for
  (s10(1)(b)–(c)); **starting or ceasing to trade** (s10(1)(d)); and the other events of s10(1) the
  app does not know of. So a period of account longer than 12 months is two accounting periods: 12
  months, and the rest. The books say when it came within the charge (`withinChargeFrom`); when they
  do not, the app assumes incorporation and the company's page says it is an assumption. Dormant for
  Corporation Tax (`null`): no CT600 or payment is listed; a company that has received a notice to
  deliver a Company Tax Return must still file one (showing it dormant), so a period HMRC's notice
  sets is entered as a period you set. The day trade started (`tradeStartedOn`) ends a period there,
  the next beginning on it; periods you set (HMRC's notice) are used as they are (`CT_PERIOD_RULES`).
- **Corporation Tax payment (TMA 1970 s59D).** Due on **the day after 9 months from the end of the
  accounting period** (s59D(1)): 1 January for a period to 31 March, the first day of the tenth month
  for any period to a month's end (CTM01800). This is for companies that do not pay by instalments:
  large companies pay quarterly instalments (s59E and the Corporation Tax (Instalment Payments)
  Regulations 1998), which the app does not work out (`CT_PAYMENT_RULES`, `ctPaymentDue`).
- **Company tax return, CT600 (FA 1998 Sch 18 para 14).** Due on the last day of the latest of: **12
  months from the end of the accounting period**; **12 months from the end of the period of account**
  its last day falls in, if that is not longer than 18 months, or **30 months from its beginning** if
  it is; and **3 months from HMRC's notice** to deliver it (para 14(1)(a)–(d), (2)). So both returns
  for a 15-month period of account are due 12 months after it ends (CTM93050, example 3), with
  months counted a month's end to a month's end (CTM93040). The
  notice's 3 months are not worked out: a notice served late gives a later date (`CT_RETURN_RULES`,
  `ct600Due`).
- **VAT returns.** Each return is for a period ending on the dates HMRC set (VAT Regulations 1995 reg
  25(1)): monthly (HMRC's "stagger 0"), or quarterly in one of three **staggers**: stagger 1 quarters
  end in **March, June, September and December**, stagger 2 in **April, July, October and January**,
  stagger 3 in **May, August, November and February** (HMRC's DMBM530020). The first return is for the
  period that includes the day of registration and begins on it (reg 25(1)). A return is due "not
  later than **the last day of the month next following the end of the period**" (reg 25(1)); HMRC
  allow **7 days more** for one made online and paid electronically, by direction under reg 25A(20)
  (VAT Notice 700/12), and under Making Tax Digital every return is made online. So a period to 31
  March is due by 7 May, and one to 10 February by 7 April (the last day of March, and 7 days), not
  17 March; the day does not move for a weekend. Under **annual accounting**, the return for the year
  is due by **the last working day of the second month after it** (reg 50(2)(b)). For an annual
  accounting period shorter than 4 months, GOV.UK's guidance gives 1 month after it ("VAT Annual
  Accounting Scheme: return and payment deadlines"): that is guidance, not reg 50, and the app follows
  it. The app counts a working day as a weekday that is not one of the bank holidays in England and
  Wales that can end a month (Good Friday, Easter Monday, the last Mondays of May and August; Banking
  and Financial Dealings Act 1971 Sch 1): a holiday moved by proclamation is not known. Payments are
  due by the same day; annual accounting's advance payments and payments on account are not worked
  out. Only the **cash accounting scheme** is taken for now (accrual and the flat rate scheme are
  refused as not supported yet) (`VAT_STAGGERS`, `VAT_QUARTER_END_MONTHS`, `VAT_RETURN_RULES`,
  `vatReturnDue`, `lastWorkingDayOfMonth`).
- **Micro-entity accounts.** A filing of accounts may keep the balance sheet's lines **A to K** of
  the micro-entity format 1 (Small Companies and Groups (Accounts and Directors' Report) Regulations
  2008, Sch 1 Part 1 Section C): called up share capital not paid, fixed assets, current assets,
  prepayments and accrued income, creditors due within one year, net current assets (liabilities),
  total assets less current liabilities, creditors due after more than one year, provisions for
  liabilities, accruals and deferred income, capital and reserves.

### VAT rates (a company's books)

The rates a coding's VAT helper works with (`VAT_RATES`, `vatRateOn`; FORMULAS.md §22): the **standard
rate, 20%** from 4 January 2011 (VATA 1994 s2(1), as amended by Finance (No. 2) Act 2010 s3), and the
**reduced rate, 5%** (VATA 1994 s29A and Sch 7A). The temporary rates for hospitality, holiday
accommodation and attractions (5% from 15 July 2020, 12.5% from 1 October 2021 to 31 March 2022) were
rates for those supplies alone, not changes to these; earlier rates (17.5%, 15%) are not covered. VAT
in a VAT-inclusive amount is the amount × rate ÷ (1 + rate): one sixth at 20%, one twenty-first at 5%.
A **reverse charge** (VATA 1994 s8, services bought from abroad; VAT Notice 741A) has the buyer account
for the VAT on what it paid: output VAT and input VAT of the same amount, which a fully taxable company
reclaims in the same return, so nothing is paid. The amounts are the coding's: the helper only fills
them in.

### The micro-entity formats (a company's chart of accounts)

The chart of accounts (`shared/ledger.ts`, FORMULAS.md §22) maps each code to a line of the
micro-entity accounts: the balance sheet's format 1 and the profit and loss account's format in the
Small Companies and Groups (Accounts and Directors' Report) Regulations 2008 (SI 2008/409), Sch 1 Part 1
Section C, inserted by the Small Companies (Micro-Entities' Accounts) Regulations 2013 (SI 2013/3008),
for a company preparing micro-entity accounts under FRS 105.

- **Balance sheet (format 1):** A called up share capital not paid; B fixed assets; C current assets;
  D prepayments and accrued income; E creditors: amounts falling due within one year; F net current
  assets (liabilities); G total assets less current liabilities; H creditors: amounts falling due after
  more than one year; I provisions for liabilities; J accruals and deferred income; K capital and
  reserves. F and G are totals; a code whose balance can be either way (a bank account, the director's
  loan, VAT) is shown under C as a debit and E (or H for a loan) as a credit.
- **Profit and loss account:** A turnover; B other income; C cost of raw materials and consumables; D
  staff costs; E depreciation and other amounts written off assets; F other charges; G tax; H profit or
  loss (their total).

The Corporation Tax treatment beside each code is where the tax computation starts, not a ruling:
depreciation is added back for capital allowances (CTA 2009 s53, capital expenditure not deductible),
client entertaining is not allowable (s1298), formation costs are capital in nature, and interest
received is a non-trading loan relationship credit (Part 5). A car's capital allowances have rules of
their own (CAA 2001 Part 2 Ch 10A), not worked out.

**These are aids, not advice:** check every date with Companies House and HMRC, whose own records
(the company's page, its HMRC online account and notices) are the authority.

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

Checked 26 November 2026 (companies: periods and deadlines):

- legislation.gov.uk, [CA 2006 s391](https://www.legislation.gov.uk/ukpga/2006/46/section/391) (the default accounting reference date, s391(4); the first period more than 6 and not more than 18 months, s391(5)), [CA 2006 s392](https://www.legislation.gov.uk/ukpga/2006/46/section/392) (shortening and extending; never over 18 months, s392(5); not again within 5 years, s392(3)), [CA 2006 s442](https://www.legislation.gov.uk/ukpga/2006/46/section/442) (9 months for a private company; a first period over 12 months, s442(3); a shortened one, s442(4); extensions, s442(5)–(5A)), [CA 2006 s443](https://www.legislation.gov.uk/ukpga/2006/46/section/443) (counting months: the corresponding date, a month's end, February), [CA 2006 s853A](https://www.legislation.gov.uk/ukpga/2006/46/section/853A) (confirmation statements: 14 days after each 12-month review period)
- legislation.gov.uk, [CTA 2009 s9](https://www.legislation.gov.uk/ukpga/2009/4/section/9) and [s10](https://www.legislation.gov.uk/ukpga/2009/4/section/10) (when an accounting period begins and ends), [TMA 1970 s59D](https://www.legislation.gov.uk/ukpga/1970/9/section/59D) (the day after 9 months from the period's end; subject to s59E's instalments), [FA 1998 Sch 18 para 14](https://www.legislation.gov.uk/ukpga/1998/36/schedule/18/paragraph/14) (the CT600's filing date)
- legislation.gov.uk, [VAT Regulations 1995 reg 25](https://www.legislation.gov.uk/uksi/1995/2518/regulation/25) (periods and the month after), [reg 25A](https://www.legislation.gov.uk/uksi/1995/2518/regulation/25A) (additional time for electronic returns by direction, para (20)), [reg 50](https://www.legislation.gov.uk/uksi/1995/2518/regulation/50) (annual accounting: the last working day of the second month, para (2)(b)); [Small Companies Regulations 2008 Sch 1](https://www.legislation.gov.uk/uksi/2008/409/schedule/1) (the micro-entity balance sheet, Part 1 Section C)
- HMRC's manuals, [CTM01800](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm01800) (Corporation Tax due dates, with examples), [CTM92010](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm92010) (nine months and one day), [CTM93030](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm93030), [CTM93040](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm93040) (counting the months; 28 and 29 February) and [CTM93050](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm93050) (the filing date and its examples), [DMBM530020](https://www.gov.uk/hmrc-internal-manuals/debt-management-and-banking/dmbm530020) (VAT staggers 1–3, and monthly returns as stagger 0)
- GOV.UK, [Dormant for Corporation Tax](https://www.gov.uk/dormant-company/dormant-for-corporation-tax) ("Trading includes … getting interest"; a notice to deliver a return must be answered), [VAT Returns: deadlines](https://www.gov.uk/vat-returns/deadlines) (1 calendar month and 7 days, online), [VAT Annual Accounting Scheme: return and payment deadlines](https://www.gov.uk/vat-annual-accounting-scheme/return-and-payment-deadlines) (2 months; 1 month under 4 months), [Filing your company's confirmation statement](https://www.gov.uk/guidance/confirmation-statement-guidance) (the review period and 14 days)

Cited 26 November 2026 (companies: a company's ledger, its VAT rates and the micro-entity formats),
from the legislation as known, not fetched again for this change, so worth a check against the current
text:

- legislation.gov.uk, [VATA 1994 s2](https://www.legislation.gov.uk/ukpga/1994/23/section/2) (the standard rate), [s8](https://www.legislation.gov.uk/ukpga/1994/23/section/8) (the reverse charge on services received from abroad), [s29A](https://www.legislation.gov.uk/ukpga/1994/23/section/29A) and [Sch 7A](https://www.legislation.gov.uk/ukpga/1994/23/schedule/7A) (the reduced rate), [Finance (No. 2) Act 2010 s3](https://www.legislation.gov.uk/ukpga/2010/31/section/3) (20% from 4 January 2011); [SI 2013/3008](https://www.legislation.gov.uk/uksi/2013/3008) (the micro-entity formats inserted into SI 2008/409 Sch 1 Part 1 Section C); [CTA 2009 s53](https://www.legislation.gov.uk/ukpga/2009/4/section/53) (capital expenditure), [s1298](https://www.legislation.gov.uk/ukpga/2009/4/section/1298) (business entertainment); FRS 105 (the Financial Reporting Council's standard for the micro-entities regime); GOV.UK, VAT Notice 741A (place of supply of services)

Checked 26 November 2026 (companies: a director's loan):

- legislation.gov.uk, [CTA 2010 s455](https://www.legislation.gov.uk/ukpga/2010/4/section/455) (the charge at the dividend upper rate of the tax year the loan is made; due under TMA 1970 s59D the day after 9 months from the end of the accounting period), [CTA 2010 s458](https://www.legislation.gov.uk/ukpga/2010/4/section/458) (relief on repayment or release: a claim within 4 years of the end of the financial year of repayment, given no sooner than 9 months after the end of its accounting period), [ITTOIA 2005 s415](https://www.legislation.gov.uk/ukpga/2005/5/section/415) (a loan released taxed as the participator's income), [Finance Act 2016 s50](https://www.legislation.gov.uk/ukpga/2016/24/section/50) (25% replaced by the dividend upper rate, for loans made on or after 6 April 2016), [CTA 2010 s464ZA](https://www.legislation.gov.uk/ukpga/2010/4/section/464ZA) (repayments matched to new borrowing: £5,000 or more each way within 30 days; £15,000 owed with arrangements; not where the repayment is taxed as income, s464ZA(6)), [Finance Act 2025 s81](https://www.legislation.gov.uk/ukpga/2025/8/section/81) (ss464C–D re-enacted as ss464ZA–ZB, treated as in force from 30 October 2024; s464B repealed), [ITEPA 2003 s180](https://www.legislation.gov.uk/ukpga/2003/1/section/180) and [Finance Act 2014 s22](https://www.legislation.gov.uk/ukpga/2014/26/section/22) (the £10,000 threshold from 2014/15, £5,000 before)
- GOV.UK, [Tax on dividends](https://www.gov.uk/tax-on-dividends) and the [Budget 2025 overview, Annex A: rates and allowances](https://www.gov.uk/government/publications/budget-2025-overview-of-tax-legislation-and-rates-ootlar/annex-a-rates-and-allowances) (2026/27 dividend rates: 10.75%, 35.75%, 39.35%), the dividend upper rate s455 follows

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
