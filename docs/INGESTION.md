# Ingestion

How files become data. The pipeline itself is described in [ARCHITECTURE.md](ARCHITECTURE.md);
this page covers the formats, the engines, and how to extend them.

## Ways in

- **Import page**: drag and drop, or *Choose files*. On a phone this opens the camera roll.
- **Anywhere in the app**: drop a file on any page.
- **An account page** (or a row in the monthly checklist): the upload is pinned to that account,
  so no matching is needed.
- **The `inbox/` folder**, or wherever `FINANCE_INBOX_DIR` points. Files are ingested when they
  stop growing, then moved out. Point a Syncthing folder here and phone screenshots arrive
  automatically.
- **The terminal**: `npm run import -- files…` copies them to the inbox.

The same file twice (by SHA-256) is recognised as already imported.

## Deterministic formats (parsed on this machine)

| Format | Parser | Notes |
|---|---|---|
| Monzo CSV | profile `monzo` | Keeps time, transaction id, merchant name/address, Monzo category, local-currency amount |
| Starling CSV | `starling` | Running balance; "Opening Balance" row becomes the opening balance |
| Revolut CSV | `revolut` | Completed rows only, fee applied, split into one account per product × currency |
| Barclays CSV | `barclays` | Newest-first handled; last 4 of the account column |
| Chase UK CSV | `chase` | Running balance and time; the description is "Transaction Description", and "Transaction Type" (Transfer, Payment, the FX rate of a cash withdrawal abroad) is kept as the type. No account type: Chase exports its current account, saver and card alike, so the account is the one you upload it to, or your choice. Its card payments ("To Credit Card", "To Revolving Line Account") are card payments |
| Lloyds / Halifax / Bank of Scotland / TSB CSV | `lloyds-group` | Debit/credit columns |
| NatWest / RBS / Ulster CSV | `natwest-group` | Blank first line, spaced headers |
| Nationwide CSV | `nationwide-current`, `nationwide-credit-card` | Windows-1252 `£`, preamble with account name and balance |
| Amex CSV | `amex` | Positive = charge (signs inverted); merchant address; reference as id |
| Aqua CSV | `aqua` | Positive = charge (signs inverted); the Note column, what the statement shows, as the reference |
| PayPal Credit CSV | `paypal-credit` | Positive = charge (signs inverted); `date,id,amount,description`, amounts as `£3.49` |
| Tesco Bank credit card CSV | `tesco-bank-card` | Sign from `Debit/Credit Flag` (a payment is `-£9.99`, `Credit`); posting date is the date, transaction date kept; Windows-1252 |
| HSBC CSV (no header) | `hsbc` | Matched by the shape of the first row |
| first direct and other Date/Description/Amount CSVs | `date-description-amount` | Names no bank, so says nothing about signs: a file for a credit card is read card style on the same rule as an auto-detected mapping (below), with the same warning, and the review page can change the signs back |
| Trading 212 CSV | `trading-212` | Buys and withdrawals are money out; deposits count as contributions |
| Holdings exports (interactive investor's portfolio export, and any CSV with a name, quantity and value column but no dates) | `holdings-csv` | One holdings snapshot: units, price (pence or pounds), value, book cost and gain per holding, SEDOL or ticker from the symbol; the account's value is what the holdings are worth (cash is not in the file), and its growth the totals line's gain; the wrapper from the file name (`…-ISA.csv`, `…-SIPP.csv`). With no date in it, it is dated by the date in its file name, else the day the file was saved: an export is made as it is downloaded. It gives no asset classes, so the model takes each fund's from the latest statement that gave one ([FORMULAS.md §1](FORMULAS.md)) |
| Anything else CSV | auto-detected mapping | Confident mappings import straight away (flagged), and the review page can change their columns and signs and save them as a profile; otherwise you map the columns once and save them. The description is a column named for it ("description", "details", "narrative"…) before one naming the other party, and never a type column ("Transaction Type") while another will do. A file for a credit card (the one you upload it to, or the one a committed import went to when it is read again) reads a single amount column card style, money out positive, when its rows fail the card-signs check ([FORMULAS.md §13](FORMULAS.md)) as they stand and pass it flipped: a card's own export lists purchases as positive |
| Excel `.xlsx`, `.xls`, and HTML tables saved as `.xls` | `xlsx` → the CSV profiles | The first sheet with a table becomes rows (`src/server/ingest/xlsx.ts`, SheetJS), which go through the same profiles, holdings detection and column mapping as a CSV. Date cells become `YYYY-MM-DD`; text cells stay text, so "01/09/2026" is read day first; numbers keep full precision. The review page shows the sheets as tables, one at a time. A spreadsheet that is not a list of payments (a timesheet, a sheet a month) is read by Claude instead: see "Spreadsheets that are not a list of payments" below |
| OFX / QFX (1.x SGML and 2.x XML) | `ofx` | Bank and credit-card statements, FITID as id, ledger/available balance; foreign amounts per `<ORIGCURRENCY>` (already converted) or `<CURRENCY>` (converted at CURRATE) |
| QIF | `qif` | Day/month order detected across the whole file |
| Santander text export | `santander-txt` | Newest-first, running balances. Santander exports at most 600 transactions: a file with 600 covers from its oldest row, not from the "From" date in its header, and a note says which days to download separately (otherwise the days it lacks would count as covered) |

### Adding a bank's CSV layout

The easy way: import the file, map the columns on the review screen and give the mapping a name. It
is saved to `data/csv-profiles.json`, and the next file with the same headers imports
automatically.

To make it built in:

1. Add an entry to `src/server/ingest/csv-profiles.ts`.
2. Add a synthetic fixture to `tests/fixtures/`.
3. Add a test to `tests/parsers.test.ts`.

A profile is data:

- `headerSignature` identifies the file.
- `columns` map roles (date, description, amount or debit/credit, balance, id, time, type,
  reference, category, merchant fields…) to header names.
- The rest are options: `dateOrder`, `amountSign`, `filter`, `splitBy`, `negativeWhen`, `positiveWhen`.

### HMRC's pages

A page saved or printed from HMRC's online services (gov.uk) is a PDF with its words as text, in one
layout per kind of page. `src/server/ingest/govuk.ts` reads it from that text (`pdftotext`, engine
`govuk`, "gov.uk page, read on this machine"): nothing goes to Claude. A PDF that is none of these,
or has no text (a scan), goes to Claude as before.

| Page | Gives |
|---|---|
| Check your Income Tax: taxable income from an employer | a `payment` for each pay date, as the employer reported it, and the job's estimate or leaving date |
| Check your Income Tax: your taxable income for a year | each job's pay for the year (figures) |
| PAYE Service: employment details | the `employment` as HMRC shows it that day: payroll number, dates, tax code |
| PAYE Service: all activity | `tax-code` notices and `event`s (a job started or ended, an allowance changed) |
| Check how much Income Tax you paid | the year's `settlement`: underpaid, overpaid or settled, and what is outstanding |
| Check your State Pension: summary | the `state-pension-forecast` |
| Check your State Pension: National Insurance record | an `ni-year` for each year |

The records go to `hmrc.jsonl` ([DATA_FORMAT.md](DATA_FORMAT.md)) under the job each is about.
The same record read twice (two printouts of one page) is stored once. To read another page: a
reader in `govuk.ts`, an invented fixture in `tests/fixtures/govuk/` and a test in
`tests/govuk.test.ts`. Bump `GOVUK_ENGINE_VERSION` when a reader changes what it reads.

### Payslips read on this machine

A payroll prints the same layout every month, so a payslip PDF in a layout known here is read by
rule from its text (`src/server/ingest/payslips.ts`, engine `payslip`), in full, and never goes to
Claude. A scan, or a layout not known here, goes to Claude as before.

| Layout | How it is told | Read from |
|---|---|---|
| SAP paystub | a boxed table: `PAYMENTS` and `DEDUCTIONS`, then `CUMULATIVES`; `Week/Month No.`; amounts as `1.234,56`, with a trailing minus for a negative | the page laid out (`pdftotext -layout`), cell by cell |
| The classic UK payslip | `EMPLOYER`, `DATE`, `TAX CODE`, `PAY METHOD` and `PERIOD` headings; a `YEAR TO DATE` column; `EMPLOYERS N.I.`; `NET PAY` | its text in drawing order (`pdftotext -raw`): the year-to-date lines come first, then the payment and deduction lines. A line with two amounts is a payment and a deduction; a line with one is a deduction when its words say so (tax, NI, pension, student loan, a scheme or loan…), else a payment |

- **Everything printed is kept** (`payslips.jsonl`): every payment and deduction line with its sign,
  quantity and rate; the totals; the net pay; what the employer paid on top; the tax code and its
  basis; the NI category letter; the pay date, period and its number; the payroll number, pay
  method and department; the year-to-date column. Your name and National Insurance number are
  never kept: only the letter after the number is.
- **Its tax figures** are what a reader always gave: the total of its payments as gross pay (with the
  tax code), and the tax, NI, pension and student loan lines, each kind added up.
- **Checked against itself.** The lines must add up to the totals printed, and the totals to the net
  pay. A payslip that does not is read with medium confidence, and a note says which total.
- **Its job** is matched by the payroll number it prints, else its employer's name ("Jobs", below).
  The same payslip read twice is one record (its id is what identifies it), and is left unticked.
- To read another layout: a reader in `payslips.ts`, an invented fixture in
  `tests/fixtures/payslips/` and a test in `tests/payslips.test.ts`. Bump `PAYSLIP_ENGINE_VERSION`
  when a reader changes what it reads.

## Documents and screenshots (read by a model)

PDF statements, P60s, interest certificates, pension statements and screenshots of any banking,
ISA, LISA, SIPP or pension app go to the model Settings → Models gives reading documents
(`src/shared/tasks.ts`, task `read-document`; DECISIONS 2026-10-04):

| Engine | When | How |
|---|---|---|
| `inference` | The default since 2026-10-05: the local model service on this machine (`vision-extract`, Qwen3.6-35B-A3B) | `ingest/inference-read.ts`: the same system prompt, user prompt and JSON Schema as Claude gets, sent to the service's OpenAI-compatible API at `batch` priority. The service takes images only: a PDF is rendered page by page at 150 dpi (`pdftoppm`; at most 40 pages), a screenshot goes as `prepareImage`'s tiles, a spreadsheet as its text. Minutes per document, not seconds. Nothing leaves the machine. Each reading is a session with its transcript, the images left out |
| `claude-cli` | Default when the `claude` CLI is installed and logged in | `claude -p` with `--json-schema`, `--tools Read`, `--restricted` (file tools confined to the scratch directory), `--safe-mode`, `--no-session-persistence`, `--output-format stream-json`, run in a scratch directory containing only the document. Each reading (the first, and the check) is a Claude session with its transcript (ARCHITECTURE.md, "Claude sessions") |
| `claude-api` | When `ANTHROPIC_API_KEY` is set (or chosen) | Messages API with structured outputs (`output_config.format`), streaming, and `fallbacks: "default"` so a refusal is retried on the recommended fallback model |
| `ocr` | Always available offline | tesseract / pdftotext; proposes the headline balance and candidate values, and parses statement-style lines using running balances to infer signs. Low confidence, so review carefully |

The local model reads every document, thinking off, and its reading is checked (below): it reads
the document again, thinking (within the service's 16k-token budget), whenever a figure cannot be
confirmed from the document itself. It follows four rules of its own besides Claude's prompt
(`LOCAL_RULES`: the statement period, foreign amounts, a fund's manager is not the provider, the
document's own date), and its reader's version says so (`extract-15+local-1`). On `extract-15` it
read 99.3% of fields right on 40 documents (5.4 hours, about 8 minutes a document), and every
wrong figure was marked as a disagreement between its two readings (DECISIONS 2026-10-05).

**NS&I's documents are read by Claude** (Sonnet, checked by Opus): the local model read its
Premium Bonds screens poorly. A document dropped onto an NS&I account goes to Claude straight away;
otherwise the local model's reading says whose it is (NS&I by name, or Premium Bonds), and Claude
reads it again; the review page says so. Settings → Models can turn that off. Before 2026-10-05,
Sonnet read and Opus checked every document; both remain a choice in Settings → Models & import.
You can re-read any draft with a different engine or model from the review screen.

### The local model: waiting, Claude, and balance lines

- **It waits rather than fails** while the service cannot take a reading (it is starting, a
  backend crashed, its GPU is lent to another program, its queue is full): the request is retried
  after the wait the service gives, for up to 12 hours (`INFERENCE_WAIT_MINUTES`). The import
  says so (`extraction.waiting`: since when, why, and until when), and a restart picks the
  reading up again.
- **It never sends a document to Claude by itself.** A reading the local model could not take or
  finish fails, and the review page offers "Read with Claude instead" (it stops a reading under
  way); that sends the document to Anthropic, so it is a click each time. A task's
  "When the local model cannot, use Claude" switch (Settings → Models, off by default) makes it
  automatic; the import then says Claude read it, and why.
- **A reading it could not finish is not kept:** output cut off by its token limit, or not in the
  schema (the service checks every output against the schema sent: `provenance.schema_valid`).
- **Balance lines read as rows are left out**, for every engine (`normalise.ts`, `BALANCE_LINE`):
  "Balance brought forward", "Opening balance", "C/F". The prompt says a balance is not a payment
  (rule 5), and the CSV reader drops such lines too, but a reader sometimes lists one, and the
  statement then no longer reconciles: the local model did so in 4 of its 7 statements that did not
  (the service's BENCH, "M2"). Each one left out is a notice on the review page, not a problem: it
  calls for no second reading.
- **Provenance:** the import keeps the service's record of the reading kept
  (`extraction.inference`: request id, alias, model sha256, system fingerprint, seed, thinking,
  whether the output matched the schema, time queued), and of each reading in
  `extraction.verification` (`firstInference`, `secondInference`). The session record keeps the
  whole provenance object. A local reading has no cost.

### Spreadsheets that are not a list of payments

A spreadsheet no layout knows, that is not a holdings export, and that is not a list of payments
goes to the reader like a PDF (`looksLikeLedger`, `src/server/ingest/xlsx.ts`). It is not a list of
payments when no column could hold an amount, or when it has several sheets with tables and its
columns could not be worked out with confidence. A timesheet with a sheet a month is both.

- **What is sent** is the workbook as text (`workbookText`): every sheet with two rows or more,
  row by row, each non-empty cell as `CELL=value`, with how the sheet shows it in brackets
  (`P10=115 [£115.00]`). Dates are `YYYY-MM-DD`. Nothing else of the file is sent. The CLI reads it
  as `workbook.txt` in its scratch directory; the API gets it as a text document.
- **Claude only.** With no Claude engine (Settings → Models set to offline OCR, or none
  installed) the first table is mapped like a CSV, and the review page says why.
- **Either way round**: the review page can *Map its columns instead*, or *Read it with Claude
  instead* for one mapped like a CSV (`POST /api/imports/:id/reprocess` with `readAs`).
- The import records `engineVersion` as `xlsx-1+extract-11` and the sheets it read in `detail`.

**Timesheets** (`extract-11`). A timesheet is `documentType: "timesheet"`. It gives one `earned_pay`
figure for each period with work or holiday recorded: the period's total pay as the timesheet
totals it, holiday pay included, with the period's days worked, holiday days, rate and role
(`work`), and the employer or entity it names as `payer`. It has no tax year: pay is taxed when it
is paid ([FORMULAS.md §17](FORMULAS.md), "Earned pay").

- **The sheets check the reading** (`src/server/ingest/timesheet.ts`). Each period's amount must be
  a cell, to the penny, on a sheet dated in that period. A sheet with money on two dated days or
  more must have had its period read. What passes needs no second reading; what fails is read
  again by the checking model, and what still fails is listed on the review page.
- **The payroll that pays it** (`paidBy`): the employer as its payslips name it, when the timesheet
  names another (a legal entity, an agency). The draft takes the one an earlier upload of the
  timesheet was linked to, else the one with a payslip whose gross is exactly a run of its
  consecutive months. The review page's *Work and pay earned* card can change it, and so can the
  Pay tab later (`POST /api/earned/link`, all of that timesheet's figures).
- **The same timesheet uploaded again** (it grows a month at a time): a period it gives as already
  stored is a duplicate; one with another amount replaces the stored figure for that period, which
  stays in `figures.jsonl` and no longer counts. The draft says what it replaces, and is held back
  from "Commit all ready".

### Reading everything (`extract-15`)

The reader keeps every value a document prints when **Read everything a document prints** is on
(Settings → Models & import; `settings.extraction.readEverything`). With it off, readings are
`extract-11`. The gov.uk pages and payslip layouts read on this machine (above) are read in full
either way. Five rules are added to the prompt (`prompt.ts`), each with its part of the schema:

- **20. Payslips in full**, as the local readers keep them (`payslips.jsonl`): every payment and
  deduction line, signed as printed; the totals and net pay; employer costs; the tax code and its
  basis; the NI letter; the pay date, period and its number; the payroll number; and the
  year-to-date column. Its tax figures are given as before: pay, tax, NI, your pension and student
  loan, never the employer's NI or pension, which are kept with the payslip only. A figure for the
  employer's pension that the reader gives anyway is dropped when the payslip's employer costs hold
  it, moved there when they leave it out, and kept when they disagree.
- **21. HMRC's pages as records** (`hmrc.jsonl`), for a screenshot or scan of HMRC's services or
  app. Each fact is one flat record with the fields of its kind; the normaliser keeps those and
  checks it as the gov.uk readers' records are checked.
- **22. Every other labelled value** (`extraction.raw.printed`): plan and policy details,
  charges, transfer and projected values, estimated interest, a P60's NI table, a P45's details.
  Each is `{section?, label, value}` as printed, kept with the import and shown on the review page
  ("Everything else it prints"), though nothing reads it yet.
- **23. An account's terms** (`terms` on each account, kept in `terms.jsonl`): every rate it prints,
  with what it applies to, how it is stated, whether it is variable, when it ends (a promotional
  rate, a boost, a fixed term) and the amount at it; and a card's minimum payment and due date. The
  limit and the AER stay in `creditLimit` and `interestRate`, which every reading gives. A rate is
  taken as the reader gives it, not as an amount (34.940% is not £34.94), and a monthly rate stays
  a month's (`per: "month"`); one that cannot be kept is left out with a warning.
- **24. Schedules** (`extract-15`; `extraction.raw.schedules`): each schedule of payments between
  you and an organisation, or made for you, that is not an account's own movements. These are
  student finance payments pages and entitlement letters, accommodation offers, council tax bills,
  and loans' or plans' payment dates. Each part is its own schedule (a Maintenance Loan and a Tuition
  Fee Loan are two). A schedule records:
  - who pays whom (to you, from you, or to someone else for you);
  - every payment with its date, amount and status as printed (paid, due, expected, awaiting
    confirmation, cancelled);
  - what else it says about itself (course, room).

  Its payments are never transactions (rule 5 stays), a document that gives one is never "nothing to
  record", and a payment is never left only in the remarks or `printed`. A schedule is recorded as an
  agreement ("Schedules", below).
- **Never a personal identifier.** The prompt says to leave out names, addresses, dates of birth,
  NI numbers and full account numbers. The normaliser also takes any NI number out of all three,
  drops a payroll number that is one, and keeps only the NI letter.
- A payslip that adds up confirms its own figures, so it needs no second reading ("Checking every
  figure", below). One that does not add up is read again.
- With it on, documents an older reader read are listed as worth reading again (by version
  number).

### Checking every figure

`src/server/ingest/verify.ts`, after each Claude reading:

1. **The document's own arithmetic** confirms what it can, through the review checks
   ([FORMULAS.md §13](FORMULAS.md)):
   - rows and balances, when opening + rows = closing, running balances follow, or printed
     totals match;
   - holdings, when they (with cash) add up to the value;
   - a payslip read in full (below, "Reading everything"), when its lines add up to its totals,
     its totals to its net pay, and the tax figures read are what its lines say.
2. **A reading every check confirms is kept.** Typically a bank or card statement with balances.
3. **Otherwise the checking model reads the document again** (Settings → Models, `check-reading`: the
   the local model thinking by default; Opus for a document Claude read). That is when a check failed (balances that don't
   add up, wrong card signs, dates outside the period, rows the reader was unsure of, dropped
   rows), or when some figures have nothing to be checked against:
   - a feed screenshot with no balances;
   - a balance on its own;
   - contribution and allowance figures;
   - tax figures;
   - a timesheet's earned pay that its sheets do not confirm (above);
   - a reading that finds nothing to record (a second reader has to find nothing too, or the two
     disagree and you are asked).
4. **The two readings are compared figure by figure:**
   - each account's balances and dates;
   - every row's date, amount, pending flag and running balance;
   - each holding's value and units;
   - each tax figure, paired by its period first (two months of equal pay are two figures).

   Wording may differ; figures may not.
5. **The second reading is kept** unless the arithmetic finds more wrong with it. When both
   readings by the local model still fail a check and checking may fall back to Claude (off by
   default), Claude reads it a third time and stands in for the second reading when it finds no
   more wrong than the better local one (`verification.byClaude`). Rows
   the readings disagree on are marked on the review page, the disagreements are listed, and the
   import is held back from "Commit all ready".

The import record keeps how it was checked (`extraction.verification`) and the reading that was
not kept (`extraction.alternative`).

Measured on the evaluation set (`extract-5`, 28 documents; `extract-6` adds three investment-app
LISA screens: an overview, an activity list and a fund's own page; the `extract-9` runs add five
savings-app screens uploaded together, and score "nothing new" on every document):

| Configuration | Field accuracy | Cost | Time |
|---|---|---|---|
| `extract-9`: Sonnet, checked by Opus, 36 documents with five savings-app screens uploaded together | 100% | $2.90 | 4.1 min |
| `extract-8` on the same 36 (before): balance dated at the latest row, a new account for the scrolled tab, "prizes paid out to another account", nothing recognised as adding nothing new | 99.8% | $2.72 | 4.4 min |
| `extract-6`: Sonnet, checked by Opus (the default), 31 documents | 100% | $2.52 | 4.1 min |
| Sonnet, checked by Opus (the default) | 100% | $2.05 | 3.3 min |
| Sonnet alone | 100% | $1.04 | 2.0 min |
| Opus alone | 100% | $1.86 | 2.6 min |

With checking, 8 of the 24 documents Claude read were confirmed by their own figures and 16 were
read twice. The set is heavy on screenshots and pension documents, which have nothing to check
against. Months of bank and card statements are mostly confirmed, at Sonnet's cost.

What the prompt asks for (`src/server/ingest/prompt.ts`, versioned as `PROMPT_VERSION` and recorded
on every import):

- **Signs** from your point of view. Debit/credit columns and DR/CR markers are converted, and each
  sign is checked against the running balance.
- **UK dates**, day first. A missing year is resolved from the statement period.
- **Every row, in order**, with balance lines moved into the opening/closing balances.
- **Account type** clues for LISA, S&S ISA, cash ISA, SIPP, workplace pension, GIA and Premium
  Bonds.
- **Investment detail** where shown: total paid in, growth, LISA bonus, allowance used this tax
  year, uninvested cash, and each holding with ISIN, units, price, value, amount invested and
  growth.
- **Investment apps' partial screens** (`extract-6`):
  - An activity list's Balance column is the cash (`runningBalanceOf: "cash"`): it goes in
    `cashBalance`, and the account's value is left out unless the screen prints a total.
  - One fund's own page is `holding_detail_screenshot`: the holding only, never an account worth
    that fund. A nickname the app gives the fund is not the account's name.
  - The account's name is taken from the screen (a heading, a selector), or from rows only one
    kind of account has (a Lifetime ISA bonus), never from the look of the app. The provider can
    come from a row alone (a platform's own charge).
- **Last 4 digits only.** A full account or card number is never output. A number ending in
  letters has no last four digits.
- **Statement dates.** A statement's balance is dated at the end of its period, never at its
  "statement date" (the day it was produced); the draft corrects a balance dated after the period
  when no rows run past it (`extract-7`).
- **Tax figures** from P60s, payslips, P11Ds, interest certificates, pension and dividend
  statements. A payslip gives the figures for its own pay period, never its year-to-date column
  (`extract-6`); a P60 gives the year's. A payslip's or P60's tax code goes on its gross pay
  (`taxCode`, `extract-11`). Two payslips of equal pay are two figures: a figure is a
  duplicate only for the same payer (or job), amount, tax year and period, from the same kind of
  document. A P60 and HMRC's page that agree are two sources, both kept. For the tax band and Self
  Assessment, an employer's P60 replaces its payslips rather than adding to them.
- **Timesheets** (`extract-11`): earned pay for each period with work in it, holiday balances
  left out, and no tax year (above).
- **Overlapping tiles.** Long scrolling screenshots are cut into overlapping tiles, and rows in the
  overlaps are reported once.
- **Only this account's movements** (`extract-9`). Apps have lists with dates and amounts that are
  not the account's movements: a history of prizes, interest, dividends or bonuses, bond or
  certificate numbers, scheduled payments, payees. Such a list usually repeats what the account's
  own transactions show, or concerns money that went elsewhere, and it seldom says which. None of
  its rows are transactions or holdings, and no missing day is filled in.
- **A confirmation of one payment is that payment** (`extract-10`). A "payment sent" screen or a
  deposit letter gives the one payment it confirms, dated as shown ("Today" from the capture
  date), described by its payee and reference. A payment set up for a later day is scheduled, and
  gives nothing.
- **Notes say only what the document shows**: never where money went or what became of it unless
  the document says so in words. (`extract-8` taught the opposite by example, "Premium Bond prizes
  paid to your bank", and readers repeated it of a prize history that said no such thing.)
- **Holdings are investments with a price**: funds, shares, ETFs, trusts, bonds and gilts. Ranges
  of Premium Bond numbers and savings certificate issues are the make-up of a balance, not
  holdings. A balance shown above such a tab (a bond record, certificates, details) is an overview:
  the balance, and nothing from the list.
- **Nothing to record** (`nothingToRecord`): when the reader understood the document but it shows
  nothing to record, it says what it shows, in a sentence (see "Nothing new" below).
- **What it was unsure of** (`extract-4`):
  - each row it could not read with certainty carries a short note (`uncertain`), shown on the
    review page;
  - rows dated "Today" or "Yesterday" with no capture date are dated from the upload day and
    flagged.
- **The statement's own totals** of money in and money out, when printed (`statedMoneyIn`,
  `statedMoneyOut`). The review checks compare the rows with them.

Screenshot dates come from the first available of:

1. a date visible in the image;
2. EXIF/XMP metadata;
3. the file name: Android, macOS, iOS and GNOME patterns, day-first digits (`05072026`), and dates
   with the month's name (`5th_June_2024`, `17th Apr 2026`, `2025Sept18th`);
4. the file's modified time (`npm run import` keeps it when copying into the inbox);
5. the upload date (flagged for you to fix).

The time it was taken is kept too when the source gives one (metadata, a name like `Screenshot
2026-09-24 at 19.42.10`, the file's modified time), with the image's size in pixels and the device
its metadata names. They say which screenshots were taken together (below).

### When a balance applies

The balance on a document is dated by the first of:

1. a date printed beside it ("as at", "valued on");
2. the end of the statement's period (a balance dated after the period, with no rows past it, is
   moved back to the period's end);
3. **on an app screen, when it was taken** (the screenshot dates above, without the upload day). An
   app shows its figures as they are when you look: a holding seen on 29 September is not the
   holding on 2 September, the day of the last prize it lists. An app screen is a screenshot the
   reader recognised as one (`…_screenshot`), or an image it could not classify; a photo or
   screenshot of a statement is a statement;
4. on a statement, the day of its latest row, then the date printed on it;
5. the upload day, flagged: nothing says when it applies. On an app screen with rows, a note gives
   the earliest day it can be (its latest row).

A settled row dated after the balance it is shown with cannot be right: on a screenshot, it is later
than the moment the screen was captured. The capture date stands (the phone's clock is the better
witness), the row is marked for you to check (the *balance date* review check), and the document is
read again.

## From extraction to draft

`src/server/ingest/draft.ts` does the following:

- **Account matching** scores on last 4 digits (and a mismatch vetoes), provider, type, name
  words and currency.
  - An account you pinned the upload to always wins.
  - Being your only open account of the detected type adds a little: apps rarely show their own
    name on screen. It is never enough on its own, and a closed account never has it.
  - A product the document names that shares no word with the account's name, aliases or kind
    ("Easy Access Issue 4" against a "2 Year Fixed Rate") counts against the account: provider
    and kind alone are then not enough, and a new account is proposed.
  - Premium Bonds are the exception. A person can hold only one, so a Premium Bonds screen is your
    Premium Bonds unless it shows another number, provider or name. Only NS&I issues them, so a new
    Premium Bonds account gets NS&I as its provider.
  - A screen that shows only what kind of account it is (a scrolled list of a LISA's rows) is
    one of your accounts of that kind, never a new one. The section waits for you to choose, and
    offers your only account of that kind in one click.
  - A screen naming only the provider (a scrolled app screen) matches your only open account
    there.
  - A fund's own page matches the account whose latest holdings include that fund.
  - A screen with no confident match of its own can take its account from a **screenshot taken
    with it** (below).
  - With nothing on the screen to say which account it is, no new account is proposed: the
    section waits for you to choose. Uploading from an account's page or its capture-list row
    pins the account.
  - Closed accounts still take their old statements, with a small penalty so an open account wins
    a tie; the review page lists them separately.
  - Below the threshold a new account is proposed.
  - When a commit creates an account, the drafts still waiting that you have not edited are
    matched again, so a letter uploaded with a new account's first statement goes to that account
    rather than an older one, or a second new one.
  - An existing account set up without its number learns the last digits its first statement
    shows, so later statements match it by themselves. An account that has its number keeps it.
- **Screenshots taken together.** Scrolled app screens rarely name their account; the one at the
  top of the account usually does. Two screenshots were taken together when they were uploaded
  within 2 minutes of each other, taken within 10 minutes (their capture times), and have the same
  width in pixels (and the same device, when both name one).
  - A screenshot *shows* an account when it is of one account, matched by what is on it (or by
    you), not by this rule. Pending and committed screenshots both count, so one that created its
    account on commit counts too.
  - A section takes that account only when its screen shows one account, has no confident match
    of its own and no account you pinned, and nothing on it says otherwise (another number,
    provider, kind of account, currency or name). Being your only account of a kind does not
    count as a confident match here, so such a screen no longer proposes a new account.
  - The nearest screenshot before it and the nearest after that show an account must agree: a
    batch can move from one account's screens to another's. With no agreement, you choose.
  - The review page says why ("taken 1 minute before IMG_0102.PNG, which shows Premium Bonds, on the
    same phone, and uploaded with it"), and the draft records which import it came from.
  - When a screenshot of the batch is read, discarded or given its account by you, the others are
    drafted again from their readings (nothing is read twice). A draft you have saved changes to is
    never redrafted by itself.
- **Accounts with nothing to import** (the account an interest certificate names, say) are left
  out of the draft.
- **Foreign amounts** take the sign of the sterling amount; documents often print them unsigned.
- **Merchant addresses** are tidied into one line, `place` (`src/shared/places.ts`), by fixed rules.
  Card exports print them in capitals, with lines wrapped mid-name, towns like `"NEWBURY, ENGLAND"`,
  a phone number on a line of its own, and postcodes without their space.
  - The rules join the lines, put back wrapped names, set the case (keeping "PO Box", "7th" and
    "20B"), space full UK postcodes, and leave out the UK itself.
  - The merchant fields stay exactly as printed.
  - The app works every `place` out again when it starts, so better rules reach history without
    re-importing. No model is involved.
  - A local model could tidy harder cases, but it would be a new engine under the privacy rules.
    It is not built.
- **Categorisation** follows `src/shared/categorise.ts`:
  1. your rules; then cash and cheques paid in to a current or savings account, which nothing else
     categorises, as nothing on them says whose money it was: that is yours to say
     ([FORMULAS.md §10](FORMULAS.md), "Cash and cheques paid in");
  2. transfers to your own accounts (by alias, or by provider name outside investment accounts),
     and money to or from you by name after "to" or "from" (your profile's name, or your surname
     and initials, "FROM TAYLOR SR"). The row's date counts: a closed account is named only while
     it was open (and up to `CLOSED_POSTING_DAYS` = 7 after, `aliveOn`), and of two accounts a
     number or an alias names (a fixed rate and the easy access it became, under one number), the
     one open that day (`openOnTheDay`). A bank's name alone never chooses between your open
     accounts there: "To Sam Taylor - Chase" may name the bank only as a reference. Never cash from a machine: "Cash withdrawal, Santander, Faro" names the bank that runs the
     machine, not your account there. A row is cash by its words or by the bank's type for it (an
     app lists a withdrawal under the machine's bank, typed "Cash withdrawal"), and a row only its
     type calls cash is categorised as cash;
  3. wrapper flows (contribution, employer contribution, tax relief, LISA bonus, fees, trades,
     withdrawals). A row with a settlement date is a trade, whatever the fund is called
     (interactive investor: "12 VANGUARD FTSE GLOB Del 105.20 S Date 03/02/25"), and "Div 250 …" is
     a dividend; both take the investment's name as the payee. "Reg Contribution (E)" is an
     employer's regular payment into a pension;
  4. a payment one of your agreements schedules (`agreements.json`: to its counterparty, near a
     due date, for about what was due) takes the agreement's category ([FORMULAS.md §10](FORMULAS.md),
     "Agreements"). A university is paid rent as well as fees, so its name alone says nothing;
  5. money into a credit card that the card's statement calls a payment ("Payment", "Direct
     debit") is paying it off;
  6. money in from an investment platform the list knows (Trading 212, eToro, MoonPay…) is taken
     out of your investments, outside the platform's own accounts;
  7. the built-in UK merchant list (`src/shared/merchants.ts`, about 220 patterns). A brand it knows
     wins; a general word it matches ("COUNCIL", "TICKET") does not overrule Claude's category for
     the row;
  8. money in that carries one of your payroll numbers at your jobs (`employments.json`; 5
     characters or more, not inside a longer number) is salary. So is money in under the name the
     bank gives a job's pay, learnt from payments paired with its payslips, when it is about that
     pay (half the least to twice the most) and from a year before the first such payment to three
     months after the last ([FORMULAS.md §10](FORMULAS.md), "Pay by name"). A job at a company you
     hold shares in is left out: it pays you dividends and transfers under its name too;
  9. the bank's own category, including American Express's "Group-Subgroup" categories;
  10. Claude's suggestion;
  11. money back onto a card from a payee it paid in the 120 days before is that purchase's refund,
      in its category.
  - Each step reads the row's description, then what other documents that showed the same payment
    said of it (`seenIn`) and its reference: an app screenshot's "Bank Giro Credit" is categorised
    by the statement that printed "BANK GIRO CREDIT REF SLC DISBURSEMENTS".
  - **Payees** come from the ways banks word a payment ([FORMULAS.md §10](FORMULAS.md), "Payees"):
    Santander's "…VIA FASTER PAYMENT TO *name* REFERENCE…", "FASTER PAYMENTS RECEIPT REF.… FROM
    *name*", "BANK GIRO CREDIT REF *payer*, …" and "DIRECT DEBIT PAYMENT TO *payee* REF…", Apple
    Pay's "(VIA APPLE PAY)", and Chase's "*merchant* Purchase | EUR 24.50 | FX rate …".
  - When an agreement is added, the payments already recorded that it schedules take its category,
    except one you, a rule of yours or a transfer link categorised.
  - When a job learns a payroll number (a document gave it, or you added it), money in already
    recorded with that number and no category becomes salary (`salaryByPayroll`). A category set by
    anyone stays.
  - When the app starts, rows in investment and pension accounts that nothing categorised get the
    category the built-in wording now gives them, and its payee unless you set one
    (`categoriseInvestmentRows`). Nothing else changes: a category set by anyone stays, and so does
    a row you left uncategorised.
  - **Preview re-applying to history** (Settings → Rules) works everything out again for rows you
    did not categorise. It shows first what would change, grouped by from and to category and what
    gives it, then by payee with every payment (`POST /enrich/preview`), and changes nothing until
    you apply it. A payee from elsewhere (the reader's) is kept when all it would get instead is a
    name cut from the description; one cut by an earlier version of the tidying, or left in the
    bank's words, is replaced (`nextPayee`).
    - Before applying, any payment, or all of a payee's, can be left as it is this time, or given a
      category of yours. "Always" makes a rule for the payee, in that category.
    - Applying (`POST /enrich`, `reapply`) writes your categories first, as yours, then your rules,
      then works out the rest, but for the payments you left as they are. Re-applying never changes
      a category of yours again, and two or more of yours for a payee suggest a rule (To
      categorise). One you left is offered again next time.
  - **A rule you make** applies at once to the payments it matches, and nothing else (`applyRule`):
    whatever else re-applying would change waits for its preview.
  - **To categorise** (Spending → To categorise, `GET /api/categorise/queue`) lists what's left
    for you ([FORMULAS.md §10](FORMULAS.md), "People", "Cash and cheques paid in", "Rules from your
    decisions", "Guesses to check"):
    - payments with people, by person however their payments write the name, each with what it
      looks like and why. Each is yours to confirm: a gift, your share of something paid back, your
      own money, or any category. Confirming saves the person (`people.json`) with every name their
      payments carry and, if you say, how money with them usually goes;
    - cash and cheques paid in, first among them, each yours to confirm the same way (no one is
      saved);
    - rules your decisions point to, each with the payments it would categorise, or, when you
      decided every payment from a payee still paid, for the next ones;
    - the uncategorised rest by payee, with "always" making a rule for the payee;
    - the categories the app guessed, from the bank's category or the reader's suggestion, by payee
      and category, to confirm or change, with "always" making a rule.
    Your choices go in one write (`POST /api/categorise/decisions`): the categories as yours, the
    person, and the rule, applied to what it matches.
- **Duplicates** (`dedup.ts`) are checked in this order:
  1. same bank id;
  2. same date + amount + simplified description, matched as a multiset (two identical coffees
     stay two);
  2b. same amount + simplified description with the same date printed in both ("S Date
     16/06/26"), up to 10 days apart, matched as a multiset: ii's export posts a trade on the day it
     was made and its statement on the day it settled;
  3. same date + amount + balance after it (both known), matched as a multiset. The running
     balance places a row whatever each source calls it: Chase's statement says "To Credit Card"
     where its export says "To Revolving Line Account";
  3b. same date + amount + time to the minute (both known), matched as a multiset. The date and time
     may be the record's own or when it was made (`transactionDate`, `transactionTime`), so an app
     that lists a payment by when the card was used finds it once it has been filled in (below). A
     midnight on every row of an export is not a time;
  4. same amount within ±3 days (of when it cleared, or when it was made), flagged as a *possible* duplicate for you to decide, when the
     descriptions are similar. Described differently, only from £20 (`DIFFERENT_WORDS_FROM`), and
     then on the same day or for an amount with pence. Sources date a payment differently (made, or
     cleared two days later) and describe it differently, so a difference in one is not enough to
     call it new; but everyday prices repeat (two £3.50 coffees at different cafés are two
     coffees), and so do round sums on different days. Never when both rows show a balance after
     them and the balances differ (either sign: sources disagree on a card's). A row that names no
     one counts as similar to any description, whatever the amount: Chase's statement prints some
     card payments as "Outgoing transaction", which its app names ("ALDI"), dated the day before;
  5. from a document that is not a list of transactions (a letter, a confirmation, an annual
     summary), a row that two or three recorded rows add up to exactly, within ±3 days and the same
     way, from £100: a *possible* duplicate. A deposit made in two payments is confirmed by letter as
     one.
- **Adding detail to a recorded payment** (`src/shared/detail.ts`). A row matched to a recorded
  payment often knows more about it: an app shows when a card was used where the export shows when
  it cleared, names the other party, or gives a time, a bank id or a foreign amount. The review
  page shows what it would fill in under the row, and what it says differently.
  - **What it fills in**: only source fields the record lacks. Never the date, amount or
    description, which the payment was recorded by, and never a value the record already has.
    - A document dating the payment earlier than the record gives the day it was made
      (`transactionDate`), with its own time for that day (`transactionTime`); a printed purchase
      date beside the posting date does too. A later date says nothing about when it was made.
    - A time goes with the day it is of: the record's `time` only from a document that posts it the
      same day.
    - The balance after it, only from a document that dates it the same day: a running balance is
      the ledger's.
    - The bank id, type, reference, other party, bank category, card, foreign amount, rate and fee;
      the merchant and other details key by key.
    - Nothing from a pending row, or from a row a letter restates as several payments (step 5).
  - **What it is called there** is kept with the payment (`seenIn`, what that document said) and
    counts in working out its payee and category, on the review page and on commit: a statement's
    "Outgoing transaction" that an app calls "ALDI" is groceries. The description it was recorded
    by stays. When that description names no one, the other document's name is the payee
    (`fallbackPayeeOf`): the name the lists show and group by ("Example Cafe B", its card reader's
    " - Zettle / Paypal POS" taken off), with the recorded description beneath it. Searching
    transactions finds a payment by any name a document gave it.
  - **The day it was made** shows under the date in the transaction lists when it differs from the
    day it posted ("made 17 Jul" under 18 Jul). The posting day stays the payment's date, as its
    statement and balances have it.
  - **Ticked by itself** when the match is certain; when the record names no one (its
    description says nothing but "Outgoing transaction"), as what the document adds is all gain;
    and when the match is on like words ("Example Sport" and "Example Sport Purchase") and nothing it
    says conflicts (only the day it posted, or the wording, differs). Only what the record lacks is
    filled in, and a row you tick in as a payment of its own adds nothing to the other. Left
    unticked: a match on the same money described differently, or one whose details disagree with
    the record's. A possible duplicate is still yours to confirm.
  - **What it says differently** (its own words for the payment, another time) is shown, and kept
    with what it filled in; the record keeps its own. A shorter wording within the record's
    ("Cash withdrawal" in "Cash withdrawal | EUR 40.00 | …") is not a difference.
  - **Ticked by itself** only when the match is certain (the same bank id; the same date and
    amount with the same description, balance after it or time). For a possible duplicate, ticking
    it says it is the same payment. Ticking the row in as a payment of its own unticks it.
  - **The category** is worked out again when what is filled in is something the categoriser reads
    (the type, the other party, the merchant, the bank's category), as a re-run would, except on a
    row you categorised or one linked as a transfer. The review page says when it changes, and the
    payment is then linked as a transfer if it now is one.
  - **On commit** it is worked out again against the record as it is then, keeping only what you
    saw and what is still empty: another import may have filled some in since. Each record keeps
    where its details came from (`seenIn`: the import, the document, the row, the fields it filled
    in and what it said differently), and the import lists the payments it filled in
    (`result.transactionsDetailed`). The transaction's panel shows both.
- **Recorded twice** (`storedTwice` in `dedup.ts`). A document can show that the account already
  has a payment twice: one of its rows matches a recorded row, and another recorded row has the
  same date and amount, with nothing on the document matching it, recorded by another import (one
  document listing both is two payments: a spend, its refund and the spend again). When both copies
  show the same balance after them it is certain, and the copy comes ticked; when the document just
  shows that date and amount fewer times than they are recorded, and no balances say otherwise, it
  is offered unticked for you to judge. Only copies on the same day are found: a payment recorded
  on the day it was made and again on the day it cleared is yours to spot.
  - The copy offered has nothing of yours on it (a category, payee, note, tag or split you set, a
    correction, a receipt, details another document filled in, a transfer link): the one the document did not match, unless only the
    other is clean. When both have something of yours, nothing is offered.
  - The review page lists it under the account ("recorded twice"), while the section goes to that
    account and you have not ticked the matching row in as a payment of its own. Committing takes a
    ticked copy away, after checking it again: both copies still there, alike, nothing of yours added since,
    and no row of the import that you ticked in as a different payment. The import records what
    it took away (`result.transactionsRemoved`), and the git history of `data/` keeps the row.
  - An import that takes a copy away is never "nothing new".
- **Your own accounts in a description.** A row names one of your accounts by:
  - **its number:** a long number ending in its last digits (a sort code and account number, a
    card number in a direct debit's reference, "EAV1234567"), which names that one account;
  - otherwise its aliases, or its bank's name.

  Money to or from you by name ("TO SAM TAYLOR", "FROM S TAYLOR"), from the name in your
  profile, is money moving between your accounts: a transfer, not spending or income, even when it
  does not say which account. Only after "to" or "from", so a payer naming you as the payee is not
  taken for your own money.
- **Transfers.** The other leg of a transfer is the opposite amount within ±4 days in another of
  your accounts that the descriptions say is the same money (`transferEvidence` in
  `src/server/enrich.ts`).
  - A row naming the other's account counts most; your name or a transfer category counts too.
  - A row naming only other accounts of yours rules a pair out: "AJ BELL" is not a payment to the
    Chase saver, and "TESCO BANK" is not an Amex refund.
  - So does a row you put in a category that isn't a transfer: you said where the money went (a
    gift you sent is not money moving between your accounts).
  - So does a row the app knows by its own wording as someone else's money, when it says nothing
    of your accounts or you: a built-in category that isn't a transfer (a Premium Bonds prize, pay,
    a refund, a shop). "TO SAM TAYLOR" the day before does not make a reinvested prize the money
    you moved. Cash withdrawals are the exception: cash can go into a cash account of yours.
  - Among the rest, the best evidence wins, then the closest date. The busiest day links the same
    whichever statement arrives first.
  - On commit both legs get a `transferGroup`, and money arriving in an ISA or pension becomes a
    `contribution`. A commit also links its new rows to other legs already stored (the other
    account's statement committed earlier), without recategorising anything else. Links already
    made are not changed: an agent proposes fixing a wrong one ([AGENTS.md §5](AGENTS.md)).
- **Linking transfers before commit** (`src/server/ingest/links.ts`). A row's link button on the
  review page links it as the other leg of a transfer, by hand, to:
  - a row of another import waiting for review, or another account's row in the same document;
  - a recorded transaction.

  It offers the opposite amount in another of your accounts within 14 days, the nearest first. It
  leaves out rows already recorded, rows linked elsewhere and transactions in a transfer already.
  - Linking two pending rows puts a `pendingLink` on both. When one is committed, the other's link
    becomes a `transferMatch` to the transaction it recorded. When that one is committed too, both
    get their `transferGroup`, as for any matched transfer, in either order. Two rows of one
    document are linked when it is committed.
  - A row held for a pending link is not paired with anything else at commit.
  - A link to a recorded transaction is a `transferMatch` with `transferMatchBy: "user"`. Unlinking
    (yours or the draft's own match) leaves `transferMatchBy: "user"` with no match.
  - Linking sets both rows' transfer category (unless you chose one). Unlinking puts the category
    back to what the rules say.
  - Drafting again or reading again keeps your links on rows that are still the same payment (same
    key, date and amount). A draft saved from the review page keeps the server's links, because
    the other import's page may have changed them meanwhile.
  - An import dismissed or discarded, or committed without the linked row, takes the link away from
    the row still waiting, with a note on its draft. A link stays only if both rows are ticked in;
    the review page warns when either is not.
- **Investment app screens.** On an investment, ISA, LISA or pension account:
  - An activity list whose running balance is the cash (the reader says so, or the closing
    balance is a running balance and there are trades, holdings or an investment provider) records
    its rows and the closing cash, never the cash as the account's value.
  - One fund's own page records that holding only; its value, gain and amount invested are the
    fund's.
  - Holdings that do not reach the value shown, or come with no value, are marked as part of the
    list. On commit they merge into that day's holdings ([DATA_FORMAT.md](DATA_FORMAT.md)), so an
    overview, a list scrolled over two screens and each fund's page make one set.
- **New accounts** can be given the day they opened and, for an account already closed, the day it
  closed: it is created closed and counts for nothing after that day. Both dates can be changed on
  the account's page (Edit); a closing date closes the account, and clearing it opens it again. A
  new account made on the review page gets its id from its bank's and its own name.
- **Liabilities.** A credit-card balance printed as a positive "amount owed" is stored as
  negative, with a note.
- **Review checks** (`shared/review.ts`, [FORMULAS.md §13](FORMULAS.md)) run on each account:
  balances (in either row order; the cash on an activity list), printed totals, holdings, the
  statement period, future dates, card signs, unsure, repeated and pending rows. A warning holds the import back from "Commit all ready".
- **Pending rows** are shown in the draft but not included by default, and reconciliation leaves
  them out. Statement balances are of settled transactions, and the settled row arrives with the
  next statement. Include one only if you know it will never appear settled.
- **Cancelled rows** (struck through, "Cancelled", "Declined"; the reader says so in `uncertain`)
  are shown but not included: no money moved. An app lists a card check or a cancelled fare that
  way. The review notes them ("cancelled: left out"); they don't count as rows the reader was
  unsure of, so they don't hold an import back from "Commit all ready".
- **Figures** are matched to an account by last 4 digits only when exactly one account has them.
  Several documents can state one job's figure for a year; all are kept and exactly one counts
  ([FORMULAS.md §11](FORMULAS.md), "One source per employer and year").
- **A forecast with no balance** (a State Pension forecast: income per year, nothing held) is
  recorded as a `pension_income_forecast` figure on its account, and the review page counts it as
  "a pension forecast". With a balance, the balance carries the income. HMRC's State Pension page,
  read on this machine, gives a `state-pension-forecast` record instead ("HMRC's pages", above).
- **Jobs** (`server/employments.ts`). A document's pay figures and HMRC's records are grouped by
  the job they are about: one PAYE reference, or one employer once names are reduced. Each group is
  matched to a job of yours:
  1. by PAYE reference (a payroll number or name decides between two jobs with one reference);
  2. else by payroll number;
  3. else by a name only one job has;
  4. else by HMRC's record of a payment with the payslip's tax and taxable pay to the penny (a
     payslip that prints a group's name, not the employer's, is still its job's).

  Otherwise a new job is proposed. The review page shows each job and how it matched, and you can
  choose another or a new one. A new job holds the import back from "Commit all ready". Only a job
  that something ticked is about is set up or changed. Committing teaches it any name, PAYE
  reference or payroll number the document gave that it lacked.
  - Documents about one employer often wait together (a P60 beside HMRC's page). After a commit
    that sets up or teaches a job, or adds HMRC's records, the drafts still waiting that you have
    not edited are matched again.
  - A draft you edited still proposes the job as new. When it is committed, a job set up since with
    the id it proposes, which this employer is (and no other PAYE reference says otherwise), is
    that job: it is not set up twice.
- **HMRC's records** are ticked unless the same record is stored already.
- **National Insurance numbers stay out.** A figure's `payerReference` that is one is left out (a
  pension statement prints it as your "Reference"), and one in the reader's notes becomes
  "[NI number]" (`shared/privacy.ts`). The document itself keeps it.
- **Committing is safe to retry.** Everything is validated before the first write. Transaction ids
  include the import id, so committing the same import again adds nothing twice.
- **Rows recorded meanwhile.** A draft's rows are checked against what was stored when it was
  drafted. At commit they are checked again against the account's rows, which catches two cases:
  another import recorded them since (scrolled screens of one list share a row or two), or you
  chose the account by hand.
  - An exact match (same bank id, or same date, amount and description) is left out, and the
    draft's notes say so.
  - A row that only looks like one (same amount, similar description, a few days apart) is marked,
    and the commit waits for you.
  - Only rows that were new and included are checked, so your own choices stand.
- **Waiting drafts follow the app.** When the app starts, each draft you haven't edited is rebuilt
  from its reading. Nothing is read again. A newer version's matching, categories and checks then
  apply to imports already waiting.
- **Funds on statements become instruments.** A holding with no matching instrument is recorded as
  one, with its name and identifiers exactly as printed, at the commit (and, for holdings already
  stored, when the app starts), whether or not agents are on. An agent job researches it when
  agents are on ([AGENTS.md](AGENTS.md)).
  - A name cut short on screen ("HSBC FTSE 100 Index Accum…") matches the full name it begins, when
    only one instrument fits (`shared/funds.ts`).
  - When a later statement prints the full name, the instrument takes it and keeps the short one
    as an alias. Holdings keep the names their documents printed.

### Moves inside an account

Some banks keep Spaces (or pots) inside an account whose money its statements count in the
balance. Starling's do: a statement lists no move between the main balance and a Space, while its
app lists each one, typed "Saving" and named after the Space. Recorded, such a move would be money
in or out that the statements on either side never saw, and a gap between them
(`src/shared/spaces.ts`).

- A row is a **move inside the account** when the bank types it so (Starling: "Saving"), or when
  it names one of the account's Spaces (`spaces` on the account) and no type says otherwise ("Max ·
  Payments" is a payment to someone called Max).
  - A row cut off above its type still counts when another row of the same screen shows that
    Space's name with its type.
- The draft leaves it unticked, badged with the Space, and never offers it as a transfer leg.
  Ticked, it is recorded all the same.
- Committed unticked, its Space's name is added to the account's `spaces`, so a later row that
  shows only the name is known. The account form lists them under "Spaces in its balance".
- A move recorded before this is taken away by a proposal (`remove_internal_move`,
  [AGENTS.md](AGENTS.md) §5) when the balances either side add up only without it.
- A bank whose pots are outside the account's balance (Monzo's pots, say) is not one of these:
  money into a pot does leave the balance its statements show.

## Schedules

A schedule a document gives (rule 24) is drafted as the agreement it is (`src/server/ingest/schedules.ts`;
`draft.agreements`; [FORMULAS.md §10](FORMULAS.md), "Agreements"):

- **New, or filling in one recorded already.** One recorded already is the same way round, with
  the same counterparty, and the same name or a payment in common. The schedule is laid over it:
  payments it lacks are added, and a payment's status is the one the latest document gives. It is
  ticked only when it adds a payment or a newer status; with nothing to add it is "already here".
- **Its category** comes from what it is, and can be changed on the review page:
  - student finance paid to you is borrowing, a transfer from the student loan;
  - other money paid to you is other income;
  - a payment made for you to a university or college is its fees;
  - rent, council tax, insurance and loans by their words.
- **The payments it explains**: the recorded payments that are its paid ones, shown beside them
  ("Received 14 Sep 2026 · Current account"). Money paid to you is known by its exact amount
  within 7 days of its date, as the bank seldom names who sent it.
- **Student finance** (Student Finance England, Wales, Northern Ireland, SAAS, the Student Loans
  Company) lends and pays through your student loan. Each paid instalment is also a row on the
  student loan (on a new student loan account when you have none), as money it lent you or paid for
  you:
  - one paid to you is the other leg of the bank credit of exactly that amount within 7 days, and
    commit links the two as a transfer, so the instalment is borrowing, not income;
  - one paid to your university is its fees (education spending), on the loan account;
  - a later instalment the bank shows before a newer page does is still filed as borrowing, by the
    agreement.

  The loan's interest is on no such document, so its balance away from a statement is an estimate
  ([FORMULAS.md §9](FORMULAS.md)).
- **Held back once.** An import with a new schedule is not ready to commit by itself ("a new
  schedule to check"): recording it files payments already recorded under it.

## Linked accounts

A product change under one account number (a fixed rate that matures into easy access) is two
accounts, the newer carrying on from the older (`Account.continues {accountId, from}`). You set
it on the newer account's page ("Carries on from"), or apply an agent's `link_accounts`
proposal.

- **A statement that runs across the day** is split there (`splitAtLinks` in `draft.ts`):
  - the rows before go to the older account, ending on its last day (the day before the link)
    with the balance its running balances reach;
  - the rest go to the newer, starting from that balance (the review says so);
  - what the statement gives as at its end is the newer account's alone: its closing balance, its
    rates and limit, what was paid in, its holdings. The older account had closed by then, so it
    never takes the newer one's interest rate as its own;
  - each part is checked for duplicates against its own account, and says why it went there.

  A statement wholly on one side goes to that side's account.
- **Unlinked**, a row another of your accounts under the same number and provider has recorded is
  left out as a possible duplicate, and the review page says to link the two.
- **Rows outside the account's open dates** (before it opened, after it closed) are a check that
  holds the import back: another account's rows, or a misread date.
- **Changing a section's account** on the review page checks its rows again against the account
  chosen (`POST /api/imports/:id/sections/redraft`): which are recorded there already decides which
  are ticked.

## Nothing new

A document the reader understood can add nothing: a prize history that repeats the account's
transactions, a second tab showing the same balance, the same screen uploaded twice. The import
page and the review page say so plainly ("Nothing new", with the reason), and it is put away in one
click, not left looking failed or stuck (`src/server/ingest/novelty.ts`).

- **Nothing to record.** The reader understood it and says what it shows (`nothingToRecord`, in
  its words), with no balance, rows, holdings, figures or schedules. A reading that found nothing and could not
  say what the document is stays a document to look at ("Nothing was found to record").
- **Not when it mentions recorded payments.** A reading with nothing to record whose printed values
  or remarks give a date and an amount that a recorded payment is (exact amount, within 7 days)
  had no place for something real: an older reader kept a schedule only in its remarks. It is not
  "nothing new", and is held back with "it mentions … already recorded … read it again"
  (`mentionedPayments`).
- **Already here.** Everything it would record is already stored (rows already imported, the same
  balance and figures on the same day for that account, the same terms that day, the same
  holdings, the same tax figures, the same HMRC records),
  or is in another import waiting beside it. The reason says which: "its balance (£1,250.00 on 29
  Sep 2026) is also on IMG_0102.PNG, and its 5 transactions are already imported".
  - Of imports waiting together, the one with the most to add is kept and the others are checked
    against it; of two identical ones, the earlier upload is kept.
  - Everything counts: rows left unticked or pending, another day, one more figure (cash, rate,
    paid in), a section still waiting for its account. A rough balance you gave covers nothing.
  - A row already imported that would fill in details its record lacks is something to add. Another
    import waiting beside it covers it only if it fills in the same.
    Once filled in, the same screen uploaded again adds nothing.
- **Never for a reading that needs a look**: readers that disagreed, warnings, low confidence,
  offline OCR.
- It is worked out afresh whenever the import list is shown, so it follows what is committed,
  discarded or edited.

**Dismissing** (`POST /api/imports/:id/dismiss`, or all at once) files the document with your
other documents and writes its import record, with the reason (`result.nothingNew`) and the
reading. Nothing else is written: no rows, balances or holdings, no new account, not even an
account's last digits. The account it was about lists the document; the same file uploaded again is
recognised; and a later, better reader can go back to it. *Discard* still deletes a file instead.
It must still add nothing when you click: otherwise it is refused and the page says to review it.
No analyst job follows a dismissal.

**Opening it again** (the filed import's page, "Open it again"; `POST /api/imports/:id/reopen`)
puts the document back in review as an import of its own (`reopens`: the filed one), drafted from
its stored reading as the app drafts now, with no Claude, so a newer app finds what an older one had
no place for. The filing stays in History as it was. When the stored reading is not enough, "Read
it again" on the review page reads the document afresh.

## Reading a stored document again

The reader improves (`PROMPT_VERSION`: `extract-4` … `extract-11`), and a document read by an earlier
version may hold something it missed or misread. A CSV whose columns were worked out automatically
may have been read with the wrong ones, and a layout may fit it now. A committed document can be
read again from its page (Import → History → the document → *Read it again*). The Import page lists
the documents worth reading again: those an earlier reader read, and CSVs whose columns were worked
out.

- **A PDF or screenshot, or a spreadsheet a model read, is read with the current reader and its
  check** (the models Settings → Models gives reading and checking documents). That is off until
  you turn it on (Settings → Models & import → *Read stored documents again*). A reading takes
  what an upload does (on Claude, it costs what an upload does). Nothing reads by itself.
- **A CSV or spreadsheet is parsed again on this machine**, at once, whatever that setting says:
  nothing is sent anywhere. It takes a layout that fits it now (one you saved, or a built-in bank's),
  else the columns you chose for this import, else columns worked out afresh. A holdings export has
  no rows to compare. OFX, QIF and Santander text files are parsed the same way every time, and are
  not read again.
- **The new reading is compared with what the import recorded**, account by account
  (`src/server/ingest/reread.ts`). Each row is:
  - for a CSV, **the row this import recorded from the same line** of the file first, the same row
    whatever changed (read differently, or the same);
  - **the same**: same date, amount and description, or same date, amount and balance after it,
    whichever import recorded it (a copy taken away as recorded twice is the other import's row);
  - **read differently**: a row of this import with the same amount and description a few days
    apart (its date), the same date and description (its amount), or the same date and amount with
    a similar description;
  - **read now, not recorded**. When another import may have recorded it in other words (the
    duplicate rules above), it says so, and adding it asks you to add it anyway;
  - **recorded, not read now**.

  The balance is compared too.
- **Nothing changes until you apply a difference**, one at a time. The actions don't delete: a row
  missing from the new reading is yours to look at. Each is recorded as the new reading's:
  - a row read differently is corrected, and its `corrections` keep what was recorded, noting the
    reader or the layout ("Read again with the Chase UK layout"). A type the new reading has and the
    row lacks is filled in. What was worked out from the old words is worked out again: the payee,
    unless you set it; the category, unless you or a transfer link set it; and a transfer link, when
    the row is not yours to categorise;
  - a row read now is added, with the import's provenance;
  - a balance takes the new reading, and its note keeps the old figure.
- The comparison waits in the work area (`rereads/`), never in `data/`, until you put it away.

## Measuring extraction

`npm run eval` runs a fixed set of synthetic documents through this pipeline and scores the
result field by field ([eval/README.md](../eval/README.md)). Run it before and after changing the
prompt, a parser or the matching, and keep the results file it writes.
