# UK rules

All figures live in dated tables in [`src/shared/uk.ts`](../src/shared/uk.ts). A tax year runs from
**6 April to 5 April**; rows apply from the tax year they name until superseded. When the rules
change, add a row there and update this page. Figures were checked on 28 September 2026.

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
- **Starting rate for savings:** £5,000.
- **Personal allowance:** £12,570 (from 2021/22, frozen).
- **Lump Sum Allowance:** £268,275 (from 2024/25).
- **Dividend tax rates:** from 2026/27, 10.75% basic, 35.75% higher, 39.35% additional.
- **Savings income tax rates:** from 2027/28, 22% basic, 42% higher, 47% additional.

### ISA reform, April 2027 (Autumn Budget 2025)

- The overall ISA allowance stays £20,000, but at most **£12,000 a year may go into cash ISAs** for
  savers under 65.
- The full £20,000 cash limit applies **from the start of the tax year in which you turn 65**.
- Transfers from stocks & shares or IF ISAs into cash ISAs are no longer allowed (except for
  over-65s).
- Interest on cash held inside stocks & shares ISAs is charged at a flat 22%.
- The app applies the cash cap using your date of birth. If no date of birth is set, the cap is
  assumed to apply.

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
- **Proposed:** a First-Time Buyer ISA replacing the LISA for new savers from April 2028. The
  consultation was published 23 June 2026. Existing LISAs continue.

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
- Salary sacrifice: NI-free pension sacrifice is to be capped at £2,000 a year from April 2029
  (Autumn Budget 2025; informational only).

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

## Sources

- GOV.UK, [Cash ISA limit reduction](https://www.gov.uk/government/publications/reduction-in-the-cash-individual-savings-account-isa-limit/cash-individual-savings-account-isa-limit-reduction)
- GOV.UK, [ISA reform 2027: anti-circumvention rules factsheet](https://www.gov.uk/government/publications/fiscal-events-2026-factsheets/isa-reform-2027-anti-circumvention-rules-factsheet)
- FSCS, [Deposit protection limit rising to £120,000](https://www.fscs.org.uk/industry-resources/deposit-limit-change-stakeholder-materials/)
- FSCS press release, [FSCS welcomes higher deposit protection limit of £120,000](https://www.fscs.org.uk/media/press/2025/nov/fscs-welcomes-higher-deposit-protection-limit-of-120000--giving-people-confidence-their-money-is-protected/)
- AJ Bell, [HMRC confirms new ISA will replace Lifetime ISA for first-time buyers only](https://www.ajbell.co.uk/group/news/hmrc-confirms-new-isa-will-replace-lifetime-isa-first-time-buyers-only)
- Fidelity, [2026/2027 tax allowances, what's changed?](https://www.fidelity.co.uk/markets-insights/personal-finance/personal-finance/20262027-tax-allowances-whats-changed/)
- Historic allowances: HMRC rates and allowances pages for each year
