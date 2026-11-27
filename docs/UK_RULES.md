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

What the books let the company claim (FORMULAS.md §22, "What VAT may be claimed"):

- **Blocked input tax.** VAT on business entertainment (Value Added Tax (Input Tax) Order 1992, SI
  1992/3222, art 5) and on a motor car (art 7) is not reclaimable: coded there, it takes no VAT. A van
  is not a car, and has a class of its own.
- **VAT paid by a director.** The company may treat VAT as its input tax only on a supply made to it
  (VATA 1994 s24(1)), and must hold a VAT invoice for it (VAT Regulations 1995 reg 29(2); VAT Notice
  700, "Who can reclaim"): a supply invoiced to the director personally is the director's. Under the cash
  accounting scheme (Part VIII of the Regulations, regs 56–65) input tax is claimed when payment is made
  (reg 57): the books take the day the director paid the supplier as the company's agent, the company
  meeting the full cost (HMRC's VIT13400), a judgment; the cautious alternative is the day the company
  repays the director ("VAT returns", below).
- **Before registration** (VAT Regulations 1995 reg 111): input tax on goods supplied to the company
  within 4 years before it registered, and still held (or used to make goods still held) when it
  registered, and on services supplied within 6 months before it, may be claimed in its first return,
  with the invoices and, for goods, a stock account. Goods on hand or used up before registration, and
  services used up for goods disposed of before it, are not claimable; the app checks the 4 years and
  6 months, and leaves "still held" to you.
- **Pre-incorporation costs** (Companies Act 2006 s51): a contract made for a company before it is
  formed is the person's who made it, until the company adopts it; the books take such a cost in on the
  day of incorporation. Reg 111(2) lets a company claim VAT on goods and services supplied to the person
  who became a member or officer, for its business, before it was incorporated, on the same terms.

### VAT returns (a company's books)

What the VAT return worked out from the books follows (FORMULAS.md §22, "VAT returns";
`analytics/vat-return.ts`; the dated rows in `src/shared/uk.ts`, "VAT returns from a company's books").
The return is prepared and checked here; it is filed through Making Tax Digital software, never from
the app. A UK VAT specialist's review (27 November 2026) confirmed the box rules, the exclusions, the
pence, the reverse charge's timing, reg 111 in the first return, the error-correction limits and netting,
the penalty points rules and the thresholds.

- **The boxes** (VAT Notice 700/12 section 3). Box 1 is "the VAT due on all goods and services you
  supplied in the period", reverse charge VAT included; box 2 VAT on acquisitions, since 1 January 2021
  only of goods brought into Northern Ireland from the EU (not supported: 0); box 3 boxes 1 and 2; box 4
  "the total amount of deductible VAT charged on your business purchases", the reverse charge's
  included; box 5 the difference of boxes 3 and 4, never negative (HMRC repay when box 4 is larger).
  Box 6 is "the total value of all your business sales and other specific outputs but leave out any
  VAT": zero-rated, reduced rate and exempt supplies, reverse charge transactions, and supplies outside
  the scope of UK VAT under the place of supply rules of Notice 741A; not money put in by the owner,
  loans, dividends, gifts of money or insurance claims. Box 7 is "the total value of your purchases and
  expenses but leave out any VAT": reverse charge transactions and imports included; not wages and
  salaries, PAYE and National Insurance, money taken out by the owner, loans, dividends, gifts of money,
  insurance claims, MOT certificates, vehicle licence duty, local authority rates, or "expenditure that's
  outside the scope of VAT because it is not consideration for a supply". A purchase outside UK VAT
  because of where it was supplied (a hotel abroad) is not that, and is in box 7. So the books have two
  treatments: `outside` (not a supply: left out) and `abroad` (supplied outside the UK: in box 6 or 7).
  Boxes 8 and 9 are goods between Northern Ireland and the EU (not supported: 0), also in boxes 6 and 7.
- **Cash accounting** (VAT Regulations 1995 Part VIII, reg 57; VAT Notice 731 paras 4.4–4.7): output tax
  goes on the return for the period in which payment is received, input tax on the one in which payment
  is made (a card payment on the day of its voucher, a cheque on the later of its date and when it was
  sent or received, a transfer on the day the account is credited); boxes 6 and 7 are by payments too
  (Notice 700/12 para 4.2). The books post each payment on its day, which is the return's. A cost a
  director pays for the company is taken on the day the director paid the supplier as the company's
  agent, the supply being the company's because it meets the full cost (HMRC's VIT13400): a judgment;
  the cautious alternative is to claim when the company repays the director. VAT on goods and services
  bought before registration that qualifies is treated as input tax of the first return (reg 111(3);
  Notice 731 para 3.2: "reclaim the VAT as though it was input tax on your first VAT Return"), so its
  amount is in box 7 of that return beside its VAT in box 4, keeping the two consistent.
- **The scheme's limits** (Notice 731 paras 2.1, 2.5 and 6.4; reg 58(1), the joining limit of
  £1,350,000 substituted from 1 April 2007 by SI 2007/768): a business may join when it expects its
  taxable supplies in the next year to be £1.35 million or less, and must leave at the end of the period
  in which the annual value of its taxable supplies, the disposal of stock and capital assets included,
  reaches £1.6 million, accounting then for the VAT on everything outstanding (or over a further 6
  months, where allowed). The scheme excludes hire purchase and similar agreements, imports and
  acquisitions, the domestic reverse charge (para 2.7), and supplies whose payment is not due in full
  within 6 months or that are invoiced before they are made (reg 58(2)(e)–(f)): the books cover none of
  the first, and do not detect the last two (`VAT_CASH_ACCOUNTING_RULES`).
- **The reverse charge** on services bought from abroad (Notice 741A para 5.2): output tax in box 1,
  input tax in box 4, the full value of the supply in boxes 6 and 7. Its tax point is reg 82's (HMRC's
  VATTOS9450; Notice 700 para 15.12): a service is "treated as being made when [it is] performed", or
  when paid if that is earlier (reg 82(2), (5)(a)); one supplied over a period, "at the end of the
  periods in respect of which payments are made or invoices issued", or when paid if earlier (reg 82(4),
  (5)(b)); a continuous supply with no billing period and no payment, at the end of each calendar year
  (Notice 700 para 15.12). The books take the earlier of payment and the end of the period the coding
  says the service covers, warning when it says none; for a journal (no payment), that period's end if
  invoiced, else the year's end.
- **Pence.** Boxes 1–5 are pounds and pence. Boxes 6–9 are whole pounds: HMRC's Making Tax Digital API
  types them as numbers with zero decimals, and the paper return said "whole pounds only". No current
  HMRC guidance says whether pence are dropped or rounded; the app leaves them out, which never
  overstates a box.
- **Correcting errors** (VAT Notice 700/45 sections 4.2–4.7; Notice 700/12 para 6.6). The net value of
  errors on earlier returns (the VAT due to HMRC less the VAT due to the business) may be corrected on
  the current return, "using boxes 1 and 4 of the return for the period of discovery" (method 1), when
  it is no more than £10,000, or between £10,000 and £50,000 and no more than "1% of the box 6 (net
  outputs) VAT Return declaration due for the return period in which you discover the errors"
  (Notice 700/12 para 6.6 says "before correction"). Above that, or for errors made deliberately, they
  are reported separately (method 2), which may be chosen for errors of any size: online or in writing,
  since form VAT652 was withdrawn ("You can no longer correct errors in your VAT Returns using form
  VAT652", GOV.UK, 8 September 2025). Each part of an error is corrected within 4 years: output tax, and
  input tax over-claimed, from the end of the period the error was in; input tax under-claimed from the
  return's due date; the limit does not apply to deliberate errors. These limits apply from 1 July 2008
  (`VAT_ERROR_CORRECTION_RULES`).
- **Late submission penalty points** (Finance Act 2021 Sch 24; GOV.UK, "Penalty points and penalties if
  you submit your VAT Return late" and "Remove penalty points"). For VAT periods starting on or after
  1 January 2023 (the default surcharge for periods to 31 December 2022): a point for each return
  submitted late, nil and repayment returns included, but not the first return after registration, the
  final return after cancellation or a one-off return (Sch 24 para 2's table). The thresholds go by the
  length of the period: more than 20 weeks, 2 (annual returns); more than 8 weeks and up to 20, 4
  (quarterly); 8 weeks or less, 5 (monthly). At the threshold a £200 penalty, and another for each later
  late return. Below it a point expires "on the last day of the month, 24 months after" the deadline's
  month, 25 months when the deadline was a month's last day. At it, points are reset after a period of
  compliance (annual 24 months, quarterly 12, monthly 6) with all returns due in the previous 24 months
  submitted. Changing frequency adjusts them: annual to quarterly +2, annual to monthly +3, quarterly to
  annual −2, quarterly to monthly +1, monthly to annual −3, monthly to quarterly −1, never below zero.
  The app lists returns filed late and shows these rules; HMRC's own count is in the business's VAT
  account (`VAT_PENALTY_RULES`, `vatPointExpiry`, `vatFrequencyOfPeriod`).
- **Late payment penalties** (Finance Act 2021 Sch 26; GOV.UK, "How late payment penalties work if you
  pay VAT late", updated 10 July 2025), for VAT periods starting on or after 1 January 2023: none if paid
  within 15 days; "3% on the VAT you owe at day 15" for 16 to 30 days; "3% of what was outstanding at day
  15 plus 3% of what is still outstanding at day 30" from day 31, and a second penalty at "a daily rate
  of 10% per year on the outstanding balance" from day 31. The page does not say since when: the app
  dates these rates from 1 April 2025, when they took effect as far as is known, and shows a payment due
  earlier without figures (earlier rates not covered). Late payment interest is charged besides and not
  worked out (`VAT_LATE_PAYMENT_RULES`).
- **Registration and deregistration thresholds** (VATA 1994 Sch 1 paras 1 and 4; VAT Notice 700/1 and
  its supplement). A business must register when its taxable turnover in the last 12 months goes over
  the registration threshold (effective from the first day of the second month after), or it expects to
  go over it in the next 30 days alone. Turnover is counted by the supplies made (their tax point, Sch 1
  para 1); the books count by payment, so credit sales not yet paid are missing and an unregistered
  company's figure can be too low. A registered business may cancel when HMRC are satisfied that "the
  value of his taxable supplies in the period of one year then beginning will not exceed £88,000" (Sch 1
  para 4(1)): a test of the year ahead, so the past 12 months below it are a hint only. Taxable turnover
  is "the total value of everything you sell that is not VAT exempt or 'out of scope'", zero-rated sales
  included, with services received from abroad under the reverse charge (Notice 700 para 5.4); interest
  is exempt, and supplies of the business's capital assets are disregarded (Sch 1 para 1(7)).
  Registration / deregistration: £70,000 / £68,000 from 1 April 2010; £73,000 / £71,000 from 1 April
  2011; £77,000 / £75,000 from 1 April 2012; £79,000 / £77,000 from 1 April 2013; £81,000 / £79,000
  from 1 April 2014; £82,000 / £80,000 from 1 April 2015; £83,000 / £81,000 from 1 April 2016; £85,000 /
  £83,000 from 1 April 2017; £90,000 / £88,000 from 1 April 2024, unchanged from April 2026
  (`VAT_REGISTRATION_THRESHOLDS`).
- **Deregistration's final return** accounts for VAT on the stock and other assets held on the day of
  cancellation when VAT on them was or could have been reclaimed and "the total VAT due on these assets
  is over £1,000" (GOV.UK, "Cancel your VAT registration"; Notice 700/11; VATA 1994 Sch 4 para 8): not
  worked out; the final return says so (`VAT_DEREGISTRATION_ASSETS_RULES`).

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

### A period's accounts (FRS 105)

The period-end postings and the period's accounts (FORMULAS.md §22, "At a period's end", "The period's
accounts" and "Locking") follow FRS 105, The Financial Reporting Standard applicable to the
Micro-entities Regime (the Financial Reporting Council; paragraphs as in its September 2024 edition):

- **The accrual basis** (para 2.24): items are recognised when they meet the definitions, not when cash
  moves, so a cost or income covering other periods is prepaid, accrued or deferred by its days; one
  billed or invoiced and not yet paid at a period end is a trade creditor or debtor.
- **Comparatives** (paras 3.7 and 3.10): the preceding period's amount beside every amount; and the
  level of rounding used is stated (para 3.13(d)).
- **Property, plant and equipment** (Section 12): measured at cost less accumulated depreciation (para
  12.14); major components with different patterns of use depreciated separately (12.15: one asset each
  here, so a component is coded as an asset of its own); the depreciable amount (cost less residual
  value) allocated on a systematic basis over its useful life (12.17), the charge in profit or loss
  (12.16); a change of residual value or useful life is a change in an accounting estimate (12.18),
  recognised prospectively from the period of the change (paras 8.12–8.13); depreciation begins when it
  is available for use and ceases when it is derecognised (12.19); a method that reflects how its
  benefits are used, straight line among them (12.21). Derecognised on disposal or when no benefits are
  expected (12.26), the gain or loss in profit or loss, never as turnover (12.27). The app's convention,
  by whole months with a full month when bought and none when it leaves (or a full month in each, the
  company's choice), is a policy within these (DECISIONS 2026-11-27).
- **Intangible assets other than goodwill** (Section 13): only those acquired separately are recognised;
  one generated internally is an expense (paras 13.4–13.5); a finite useful life (13.9), not more than
  ten years when it cannot be estimated reliably (13.10); amortised on a systematic basis, straight line
  when the pattern cannot be determined reliably (13.11–13.12), residual value nil unless 13.13 applies.
  **Goodwill** acquired with a trade follows the same (para 14.2, applying 13.9–13.14), at most 10 years
  when its life cannot be estimated reliably.
- **Provisions** (Section 16): written in a journal to `provisions` (balance sheet line I).
- **Impairment** (Section 22): not supported yet; the books refuse a hand-written write-down on a
  depreciation code.
- **Errors** (Section 8): a material prior period error is corrected retrospectively, by restating the
  comparatives or the opening balances (paras 8.16–8.17), with a note; accounts already delivered that
  were defective are revised under CA 2006 s454. Neither is supported here: a correction after filing
  goes through a journal in a later period, and the period filed shows the drift.
- **Distributions** (CA 2006 s830): a dividend only out of profits available for distribution
  (accumulated realised profits less accumulated realised losses), justified by the relevant accounts
  (ss836–838). The books check each dividend against the profit and loss reserve on the day it is paid,
  a practical test that leaves unrealised profits and interim accounts to you.
- **Whole pounds**: Companies House's online filing of micro-entity accounts takes the figures in whole
  pounds and works out every total (it has no boxes for net current assets, total assets less current
  liabilities or net assets, and totals fixed assets, current assets and capital and reserves from their
  sub-lines when a breakdown is entered), so the totals are worked out from the rounded figures here
  too, and the rounding difference sits in the profit and loss reserve.
- Capital allowances for the tax computation are below ("Corporation Tax"); a car's own rules and the
  intangibles regime (CTA 2009 Part 8) are not worked out yet.

### Corporation Tax (a company's books)

What the Corporation Tax computation worked out from the books follows (FORMULAS.md §22, "Corporation
Tax"; `analytics/corporation-tax.ts`, `shared/corporation-tax.ts`, `shared/ct600.ts`; the dated rows in
`src/shared/uk.ts`, "Companies: Corporation Tax"). It is prepared and checked here, and filed through
commercial software, never from the app. Each rule was read on legislation.gov.uk (the latest revised
text) or GOV.UK on 27 November 2026; Sources, below.

**Periods and the trading profit**

- A period begins when the company comes within the charge, for a UK resident company when it starts
  to carry on business ([CTA 2009 s9](https://www.legislation.gov.uk/ukpga/2009/4/section/9); HMRC's
  [CTM01410](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm01410): when it
  acquires a source of income), and ends on starting or ceasing to trade among other things
  ([s10(1)](https://www.legislation.gov.uk/ukpga/2009/4/section/10)), so a period with only interest
  before the trade is one of its own.
- Where a period of account does not coincide with an accounting period, profits and losses are
  apportioned "by reference to the number of days in the periods concerned"
  ([CTA 2009 s52](https://www.legislation.gov.uk/ukpga/2009/4/section/52)(3)). The Act gives no other
  method.
- No deduction for items of a capital nature ([s53](https://www.legislation.gov.uk/ukpga/2009/4/section/53)),
  for expenses not "incurred wholly and exclusively for the purposes of the trade"
  ([s54](https://www.legislation.gov.uk/ukpga/2009/4/section/54)), for "expenses in providing
  entertainment or gifts" ([s1298](https://www.legislation.gov.uk/ukpga/2009/4/section/1298)), or for the
  tax penalties and interest of [s1303](https://www.legislation.gov.uk/ukpga/2009/4/section/1303).
- **Pre-trading expenses** ([s61](https://www.legislation.gov.uk/ukpga/2009/4/section/61)): incurred
  within 7 years before the trade starts and deductible had they been incurred then, they are "treated
  as if they were incurred on the start date"; loan relationship debits are not (s61(3)), but may be
  treated as trading debits of the period the trade starts in by an election within 2 years
  ([s330](https://www.legislation.gov.uk/ukpga/2009/4/section/330)), not worked out here.
- **Management expenses** ([s1219](https://www.legislation.gov.uk/ukpga/2009/4/section/1219)) are only
  for a "company with investment business", one "whose business consists wholly or partly of making
  investments" ([s1218B](https://www.legislation.gov.uk/ukpga/2009/4/section/1218B)). HMRC's
  [CTM08070](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm08070): funds on
  deposit pending use do not normally make one ("the mere provision of cash at the bank pending its
  subsequent use is not the 'holding' of investments", EYL Trading). So a pre-trading company's
  expenses wait for the trade under s61, and are never set against its interest.
- **Loan relationships**: those for the trade give trading credits and debits
  ([s297](https://www.legislation.gov.uk/ukpga/2009/4/section/297)); the rest a non-trading profit or
  deficit ([s301](https://www.legislation.gov.uk/ukpga/2009/4/section/301)). A deficit may be claimed
  against the same period's profits or carried back ([s459](https://www.legislation.gov.uk/ukpga/2009/4/section/459),
  within 2 years, [s460](https://www.legislation.gov.uk/ukpga/2009/4/section/460)); unrelieved, it is
  carried forward and may be claimed against total profits of a later period
  ([s463G](https://www.legislation.gov.uk/ukpga/2009/4/section/463G)), or is set against non-trading
  profits where s463G is barred ([s463H](https://www.legislation.gov.uk/ukpga/2009/4/section/463H)).

**Rates and marginal relief** ([CTA 2010 Part 3A](https://www.legislation.gov.uk/ukpga/2010/4/part/3A),
inserted by FA 2021 Sch 1)

- Main rate 20% for FY 2015 and FY 2016, 19% for FY 2017 to FY 2022, 25% from FY 2023 (FA 2021
  [s6](https://www.legislation.gov.uk/ukpga/2021/26/section/6); FY 2024 to FY 2026 by F(No.2)A 2023 s5,
  F(No.2)A 2024 s12 and FA 2025 s13); the small profits rate 19% and the marginal relief fraction 3/200
  from FY 2023 (FA 2021 [s7](https://www.legislation.gov.uk/ukpga/2021/26/section/7); F(No.2)A 2023 s6,
  F(No.2)A 2024 s13, FA 2025 s14). GOV.UK's [rates and allowances](https://www.gov.uk/government/publications/rates-and-allowances-corporation-tax/rates-and-allowances-corporation-tax)
  table agrees for FY 2023 to FY 2026. The rows before FY 2023 were taken from the Acts as cited and a
  search for FY 2015 (FA 2013 s6(1)); worth a check if an old period is ever worked out.
- The small profits rate applies when augmented profits "do not exceed the lower limit"
  ([s18A](https://www.legislation.gov.uk/ukpga/2010/4/section/18A)); marginal relief F × (U − A) × N ÷ A
  when they exceed it but not the upper limit ([s18B](https://www.legislation.gov.uk/ukpga/2010/4/section/18B));
  both are for a company that is not a close investment-holding company.
- Limits £50,000 and £250,000, divided by 1 + N associated companies, and for a period of less than 12
  months "proportionately reduced" ([s18D](https://www.legislation.gov.uk/ukpga/2010/4/section/18D)).
  HMRC: "strictly the calculation should be carried out by reference to the number of days in the short
  AP" ([CTM03930](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm03930)); the app
  uses days ÷ 365.
- A period in two financial years: profits are apportioned between them
  ([CTA 2009 s8(5)](https://www.legislation.gov.uk/ukpga/2009/4/section/8)) "on a time basis"
  ([CTA 2010 s1172](https://www.legislation.gov.uk/ukpga/2010/4/section/1172)). Where the limits differ,
  the parts are treated as separate periods, profits by the period's days and the limits by the days of
  each financial year ([CTM03640](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm03640),
  [CTM03955](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm03955), whose worked
  example the tests reproduce); where they do not, the period is not split.
- **Associated companies** ([s18E](https://www.legislation.gov.uk/ukpga/2010/4/section/18E)): associated
  "for any part of the accounting period" when one controls the other or both are under the same
  control (control as in [ss450](https://www.legislation.gov.uk/ukpga/2010/4/section/450)–451); one that
  "has not carried on a trade or business at any time in the accounting period" is left out, as is a
  passive holding company ([s18F](https://www.legislation.gov.uk/ukpga/2010/4/section/18F)). The CT600
  guide: box 326 counts companies associated "for any part of the accounting period", not this one.
- **Augmented profits** ([s18L](https://www.legislation.gov.uk/ukpga/2010/4/section/18L)): taxable total
  profits plus exempt distributions of a qualifying kind from companies other than 51% group companies.
  Not tracked: taken as the taxable total profits.
- **Close investment-holding companies** ([s18N](https://www.legislation.gov.uk/ukpga/2010/4/section/18N)):
  a close company is one unless "throughout that period" it "exists wholly or mainly for one or more of
  the permitted purposes" (trading on a commercial basis; letting land to people not connected with it;
  holding or financing qualifying companies; and the like). The Act says nothing of a company before it
  trades. HMRC's [CTM60720](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm60720):
  a company "may exist for the purpose of carrying on a trade, even though in a particular accounting
  period it does not receive any trading income, or, indeed, actually carry on a trade. This would be
  exceptional", looking at what it actually does ([CTM60730](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm60730)).
  So a pre-trading company with interest only may be one: the app asks, and never decides.

**Capital allowances** ([CAA 2001](https://www.legislation.gov.uk/ukpga/2001/2/contents) Part 2)

- Expenditure by a person about to carry on a qualifying activity is treated as incurred on its first
  day ([s12](https://www.legislation.gov.uk/ukpga/2001/2/section/12)).
- **Annual investment allowance**: £1,000,000 ([s51A(5)](https://www.legislation.gov.uk/ukpga/2001/2/section/51A)),
  "proportionately increased or reduced" for a period longer or shorter than a year (s51A(6)); history:
  £500,000 from 1 April 2014 ([FA 2014 s10](https://www.legislation.gov.uk/ukpga/2014/26/section/10), Sch 2),
  £200,000 from 1 January 2016 ([F(No.2)A 2015 s8](https://www.legislation.gov.uk/ukpga/2015/33/section/8)),
  £1,000,000 from 1 January 2019 ([FA 2019 s32](https://www.legislation.gov.uk/ukpga/2019/1/section/32),
  Sch 13), permanent from 1 April 2023 ([F(No.2)A 2023 s8](https://www.legislation.gov.uk/ukpga/2023/30/section/8)).
  The transitional rules for a period over a change are not worked out (refused). One allowance is
  shared by a group, or by companies under common control that are related
  ([s51C](https://www.legislation.gov.uk/ukpga/2001/2/section/51C), [s51E](https://www.legislation.gov.uk/ukpga/2001/2/section/51E),
  [s51G](https://www.legislation.gov.uk/ukpga/2001/2/section/51G)), allocated as they think fit:
  `books.aiaAllocated`. No AIA on cars ([s38B](https://www.legislation.gov.uk/ukpga/2001/2/section/38B),
  general exclusion 2).
- **Full expensing and the 50% allowance** ([s45S](https://www.legislation.gov.uk/ukpga/2001/2/section/45S),
  inserted by F(No.2)A 2023 s7, made permanent by [FA 2024 s1](https://www.legislation.gov.uk/ukpga/2024/3/section/1)):
  a company's expenditure from 1 April 2023 on plant "unused and not second-hand", 100% for main rate and
  50% for special rate ([s52](https://www.legislation.gov.uk/ukpga/2001/2/section/52)'s table), subject
  to [s46](https://www.legislation.gov.uk/ukpga/2001/2/section/46)'s exclusions (cars, plant for leasing).
  On a disposal, "the relevant proportion of the disposal value" is a balancing charge, not deducted from
  the pool ([s59A](https://www.legislation.gov.uk/ukpga/2001/2/section/59A); for 50%,
  [s59B](https://www.legislation.gov.uk/ukpga/2001/2/section/59B), the expenditure halved; GOV.UK,
  [disposing of an asset](https://www.gov.uk/guidance/disposing-an-asset-if-you-claimed-full-expensing-or-50-first-year-allowance)).
  The 40% allowance from 1 January 2026 for cases outside s45S ([s45U](https://www.legislation.gov.uk/ukpga/2001/2/section/45U),
  [FA 2026 s29](https://www.legislation.gov.uk/ukpga/2026/11/section/29)) and the super-deduction (FA 2021
  s9) are not covered.
- **Writing-down allowances**: main rate 18%, 14% for periods beginning on or after 1 April 2026
  ([s56](https://www.legislation.gov.uk/ukpga/2001/2/section/56)(1), [FA 2026 s28](https://www.legislation.gov.uk/ukpga/2026/11/section/28));
  special rate 6% from 1 April 2019, 8% before ([s104D](https://www.legislation.gov.uk/ukpga/2001/2/section/104D),
  [FA 2019 s31](https://www.legislation.gov.uk/ukpga/2019/1/section/31)). A period over the change takes
  X = 18 × BRD/CP + 14 × ARD/CP (or 8 and 6), "rounded up to the nearest second decimal place". For a
  period shorter or longer than a year the allowance is proportionately reduced or increased (s56(3)).
  A pool of £1,000 or less (pro rata) may be written off ([s56A](https://www.legislation.gov.uk/ukpga/2001/2/section/56A)).
- **Disposals**: the disposal value is "limited to the qualifying expenditure incurred by the person on
  its provision" ([s62](https://www.legislation.gov.uk/ukpga/2001/2/section/62)); a balancing allowance
  only in the final chargeable period ([s55(4)](https://www.legislation.gov.uk/ukpga/2001/2/section/55),
  [s65](https://www.legislation.gov.uk/ukpga/2001/2/section/65)), when the trade is permanently
  discontinued: not worked out.
- **Connected persons** ([s214](https://www.legislation.gov.uk/ukpga/2001/2/section/214)): "no annual
  investment allowance or first-year allowance" on the buyer's expenditure ([s217](https://www.legislation.gov.uk/ukpga/2001/2/section/217)),
  and its qualifying expenditure capped ([s218](https://www.legislation.gov.uk/ukpga/2001/2/section/218))
  at the seller's disposal value where the seller brings one in, otherwise the smallest of the market
  value, the seller's capital expenditure and a connected person's: the app takes the market value given
  (or the cost, asking for it).

**Losses** ([CTA 2010 Part 4](https://www.legislation.gov.uk/ukpga/2010/4/part/4))

- A loss may be set against total profits of the period and carried back 12 months by claim within 2
  years ([s37](https://www.legislation.gov.uk/ukpga/2010/4/section/37)): an option, never made here.
- Losses of periods beginning before 1 April 2017 are carried forward against the same trade's profits
  automatically ([s45](https://www.legislation.gov.uk/ukpga/2010/4/section/45)); later ones may be
  claimed against total profits ([s45A](https://www.legislation.gov.uk/ukpga/2010/4/section/45A)), or
  where s45A is barred are set against the trade's profits ([s45B](https://www.legislation.gov.uk/ukpga/2010/4/section/45B)).
- Carried-forward losses and deficits are restricted to half the profits above a deductions allowance
  of £5 million ([s269ZB](https://www.legislation.gov.uk/ukpga/2010/4/section/269ZB),
  [s269ZD](https://www.legislation.gov.uk/ukpga/2010/4/section/269ZD), [s269ZR](https://www.legislation.gov.uk/ukpga/2010/4/section/269ZR),
  [s269ZW](https://www.legislation.gov.uk/ukpga/2010/4/section/269ZW)), which is the amount the company
  specifies in its return, nil if none: the app says so, and refuses losses beyond it.

**The CT600**

- The current form is [Company Tax Return CT600 (2026) Version 3](https://www.gov.uk/government/publications/corporation-tax-company-tax-return-ct600-2015-version-3)
  (HMRC 04/26, for accounting periods starting on or after 1 April 2015); the box labels in
  `shared/ct600.ts` are verbatim from its PDF. The [Company Tax Return guide](https://www.gov.uk/guidance/the-company-tax-return-guide)
  says box 160 is for losses "that can only be set against trading profit", box 285 for carried-forward
  losses set against total profits, box 263 for carried-forward non-trading deficits from periods from 1
  April 2017; boxes 695 and 705 "the total allowances, including any Annual Investment Allowance"
  on each pool; boxes 327 and 328 replace 326 when the period straddles two financial years; box 4 is 0
  when no type applies (2: a close investment-holding company); box 3 is the 10-digit tax reference.
- The form prints ".00" against the profit, income and expenditure boxes (whole pounds) and pence
  against the tax boxes. HMRC's [COM130040](https://www.gov.uk/hmrc-internal-manuals/cotax-manual/com130040)
  and [CTM93220](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm93220) rule out
  rounding (to thousands) on the form; no text found says how the pence of a whole-pound box go, so the
  app rounds to the nearest pound and adds the totals from the rounded boxes.

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

Cited 26 November 2026 (companies: a company's ledger, its VAT rates and the micro-entity formats; and,
after review, blocked input tax, a director's VAT, reg 111, pre-incorporation costs, penalties and
connected persons' assets), from the legislation as known, not fetched again for this change, so worth
a check against the current text:

- legislation.gov.uk, [VATA 1994 s24](https://www.legislation.gov.uk/ukpga/1994/23/section/24) (input tax: supplies to the taxable person), [VAT Regulations 1995 reg 29](https://www.legislation.gov.uk/uksi/1995/2518/regulation/29) (the claim and the VAT invoice) and [reg 111](https://www.legislation.gov.uk/uksi/1995/2518/regulation/111) (VAT before registration and incorporation), [Value Added Tax (Input Tax) Order 1992 arts 5 and 7](https://www.legislation.gov.uk/uksi/1992/3222) (business entertainment; motor cars), [Companies Act 2006 s51](https://www.legislation.gov.uk/ukpga/2006/46/section/51) (pre-incorporation contracts), [CTA 2009 s1303](https://www.legislation.gov.uk/ukpga/2009/4/section/1303) (tax penalties and interest not deductible), [CAA 2001 ss214–218](https://www.legislation.gov.uk/ukpga/2001/2/part/2/chapter/17) (connected persons and plant: no annual investment allowance, qualifying cost capped, s217–218); GOV.UK, VAT Notice 700 (who can reclaim VAT)

- legislation.gov.uk, [VATA 1994 s2](https://www.legislation.gov.uk/ukpga/1994/23/section/2) (the standard rate), [s8](https://www.legislation.gov.uk/ukpga/1994/23/section/8) (the reverse charge on services received from abroad), [s29A](https://www.legislation.gov.uk/ukpga/1994/23/section/29A) and [Sch 7A](https://www.legislation.gov.uk/ukpga/1994/23/schedule/7A) (the reduced rate), [Finance (No. 2) Act 2010 s3](https://www.legislation.gov.uk/ukpga/2010/31/section/3) (20% from 4 January 2011); [SI 2013/3008](https://www.legislation.gov.uk/uksi/2013/3008) (the micro-entity formats inserted into SI 2008/409 Sch 1 Part 1 Section C); [CTA 2009 s53](https://www.legislation.gov.uk/ukpga/2009/4/section/53) (capital expenditure), [s1298](https://www.legislation.gov.uk/ukpga/2009/4/section/1298) (business entertainment); FRS 105 (the Financial Reporting Council's standard for the micro-entities regime); GOV.UK, VAT Notice 741A (place of supply of services)

Checked 27 November 2026 (companies: VAT returns):

- GOV.UK, [VAT Notice 700/12: how to fill in and submit your VAT Return](https://www.gov.uk/guidance/how-to-fill-in-and-submit-your-vat-return-vat-notice-70012) (section 3: each box, boxes 6 and 7's inclusions and exclusions, boxes 8 and 9 for Northern Ireland; para 4.2: cash accounting's boxes; para 4.6: reverse charges; para 6.6: correcting errors in boxes 1 and 4)
- GOV.UK, [VAT Notice 731: cash accounting scheme](https://www.gov.uk/guidance/vat-cash-accounting-scheme-notice-731) (paras 2.7–2.8: what the scheme excludes; para 3.2: VAT from before registration on the first return; paras 4.4–4.7: payments received and made)
- GOV.UK, [VAT Notice 741A: place of supply of services](https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a) (para 5.2: the reverse charge in boxes 1, 4, 6 and 7; para 5.7: reverse charge services and registration)
- GOV.UK, [VAT Notice 700: the VAT guide](https://www.gov.uk/guidance/vat-guide-notice-700) (para 5.4: services from abroad count towards taxable turnover; section 11: VAT before registration; para 15.12: the tax point of reverse charge services)
- GOV.UK, [VAT Notice 700/45: how to correct VAT errors](https://www.gov.uk/guidance/how-to-correct-vat-errors-and-make-adjustments-or-claims-vat-notice-70045) (sections 4.2–4.7: methods 1 and 2, the £10,000 and £50,000 limits and 1% of box 6, net value, deliberate errors, 4 years)
- GOV.UK, [Penalty points and penalties if you submit your VAT Return late](https://www.gov.uk/guidance/penalty-points-and-penalties-if-you-submit-your-vat-return-late) (periods from 1 January 2023, thresholds, £200, nil and repayment returns, frequency changes, exclusions) and [Remove penalty points you've received after submitting your VAT Return late](https://www.gov.uk/guidance/remove-penalty-points-youve-received-after-submitting-your-vat-return-late) (expiry after 24 or 25 months; periods of compliance)
- GOV.UK, [VAT registration: when to register](https://www.gov.uk/vat-registration/when-to-register) (the 12-month and 30-day tests; what taxable turnover is), [VAT Notice 700/1 supplement](https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-supplement--2) (registration and deregistration limits from 1 April 2010), [Cancel your VAT registration](https://www.gov.uk/register-for-vat/cancel-your-registration) (below £88,000)
- legislation.gov.uk, [VATA 1994 Sch 1](https://www.legislation.gov.uk/ukpga/1994/23/schedule/1) (registration; para 1(7): capital assets disregarded), [Finance Act 2021 Sch 24](https://www.legislation.gov.uk/ukpga/2021/26/schedule/24) (penalties for failure to make returns), [VAT Regulations 1995 reg 111](https://www.legislation.gov.uk/uksi/1995/2518/regulation/111) (VAT before registration)
- GOV.UK, [Check if you need to report errors in your VAT Return](https://www.gov.uk/guidance/check-if-you-need-to-report-errors-in-your-vat-return) (updated 8 September 2025: form VAT652 withdrawn; errors corrected on the next return, online or in writing), [How late payment penalties work if you pay VAT late](https://www.gov.uk/guidance/how-late-payment-penalties-work-if-you-pay-vat-late) (updated 10 July 2025: 3% at day 15, a further 3% at day 30, 10% a year from day 31), [Cancel your VAT registration](https://www.gov.uk/register-for-vat/cancel-your-registration) (the final return; stock and assets over £1,000)
- legislation.gov.uk, [VAT Regulations 1995 reg 57](https://www.legislation.gov.uk/uksi/1995/2518/regulation/57) (cash accounting: the day payment is made or received), [reg 58](https://www.legislation.gov.uk/uksi/1995/2518/regulation/58) (joining at £1,350,000, from 1 April 2007 by SI 2007/768; the supplies excluded), [reg 82](https://www.legislation.gov.uk/uksi/1995/2518/regulation/82) (the time of supply of services received from abroad), [VATA 1994 Sch 1 para 4](https://www.legislation.gov.uk/ukpga/1994/23/schedule/1/paragraph/4) (cancelling: the year "then beginning"); HMRC's manuals [VIT13400](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit13400) (supplies to the employer when it meets the full cost) and VATTOS9450 (the reverse charge's time of supply; cited after the specialist's review, not fetched)
- Not found in HMRC's current guidance: how the pence of boxes 6–9 are dropped (the Making Tax Digital API takes numbers with zero decimals); a reverse charge's timing rests on reg 82, not Notice 731

Checked 27 November 2026 (companies: a period's accounts):

- The Financial Reporting Council, [FRS 105, September 2024](https://media.frc.org.uk/documents/FRS_105_September_2024_Redacted_edition_zZFkzvN.pdf): para 2.24 (the accrual basis), paras 3.7, 3.10 and 3.13(d) (comparatives; the level of rounding stated), Section 8 paras 8.11–8.13 (changes in estimate) and 8.16–8.17 (prior period errors), Section 12 paras 12.14–12.21 and 12.26–12.27 (property, plant and equipment: components, depreciation, changes in estimate, derecognition), Section 13 paras 13.4–13.13 (intangible assets: internally generated, useful life, amortisation), para 14.2 (goodwill), Sections 16 and 22 (provisions; impairment)
- legislation.gov.uk, [CA 2006 s830](https://www.legislation.gov.uk/ukpga/2006/46/section/830) (distributions out of profits available), [ss836–838](https://www.legislation.gov.uk/ukpga/2006/46/section/836) (the relevant accounts), [s454](https://www.legislation.gov.uk/ukpga/2006/46/section/454) (voluntary revision of defective accounts), [s610](https://www.legislation.gov.uk/ukpga/2006/46/section/610) (share premium)
- Companies House's online filing of micro-entity accounts in whole pounds, its totals worked out from what is entered: as an accountant's review of this slice confirmed (no boxes for F, G and K; B, C and capital and reserves totalled from a breakdown), not fetched here

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

Checked 27 November 2026 (companies: Corporation Tax): each link in "Corporation Tax (a company's
books)" above, on legislation.gov.uk (the latest revised text), GOV.UK and HMRC's Company Taxation,
Capital Allowances and Company Tax manuals; the CT600 (2026) Version 3 PDF
(<https://assets.publishing.service.gov.uk/media/69c543424a06660f085442bd/ct600.pdf>) for the box
labels.
