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
| HSBC CSV (no header) | `hsbc` | Matched by the shape of the first row |
| first direct and other Date/Description/Amount CSVs | `date-description-amount` | |
| Trading 212 CSV | `trading-212` | Buys and withdrawals are money out; deposits count as contributions |
| Holdings exports (interactive investor's portfolio export, and any CSV with a name, quantity and value column but no dates) | `holdings-csv` | One holdings snapshot: units, price (pence or pounds), value, book cost and gain per holding, SEDOL or ticker from the symbol; the account's value is what the holdings are worth (cash is not in the file); the wrapper from the file name (`…-ISA.csv`, `…-SIPP.csv`) |
| Anything else CSV | auto-detected mapping | Confident mappings import straight away (flagged), and the review page can change their columns and signs and save them as a profile; otherwise you map the columns once and save them. The description is a column named for it ("description", "details", "narrative"…) before one naming the other party, and never a type column ("Transaction Type") while another will do. A file for a credit card (the one you upload it to, or the one a committed import went to when it is read again) reads a single amount column card style, money out positive, when its rows fail the card-signs check ([FORMULAS.md §13](FORMULAS.md)) as they stand and pass it flipped: a card's own export lists purchases as positive |
| Excel `.xlsx`, `.xls`, and HTML tables saved as `.xls` | `xlsx` → the CSV profiles | The first sheet with a table becomes rows (`src/server/ingest/xlsx.ts`, SheetJS), which go through the same profiles, holdings detection and column mapping as a CSV. Date cells become `YYYY-MM-DD`; text cells stay text, so "01/09/2026" is read day first; numbers keep full precision. The review page shows the sheet as a table |
| OFX / QFX (1.x SGML and 2.x XML) | `ofx` | Bank and credit-card statements, FITID as id, ledger/available balance; foreign amounts per `<ORIGCURRENCY>` (already converted) or `<CURRENCY>` (converted at CURRATE) |
| QIF | `qif` | Day/month order detected across the whole file |
| Santander text export | `santander-txt` | Newest-first, running balances |

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
- The rest are options: `dateOrder`, `amountSign`, `filter`, `splitBy`, `negativeWhen`.

## Documents and screenshots (read by Claude)

PDF statements, P60s, interest certificates, pension statements and screenshots of any banking,
ISA, LISA, SIPP or pension app go to the extraction engine chosen in Settings:

| Engine | When | How |
|---|---|---|
| `claude-cli` | Default when the `claude` CLI is installed and logged in | `claude -p` with `--json-schema`, `--tools Read`, `--restricted` (file tools confined to the scratch directory), `--safe-mode`, `--no-session-persistence`, run in a scratch directory containing only the document |
| `claude-api` | When `ANTHROPIC_API_KEY` is set (or chosen) | Messages API with structured outputs (`output_config.format`), streaming, and `fallbacks: "default"` so a refusal is retried on the recommended fallback model |
| `ocr` | Always available offline | tesseract / pdftotext; proposes the headline balance and candidate values, and parses statement-style lines using running balances to infer signs. Low confidence, so review carefully |

Sonnet reads every document, with effort `high`, and its reading is checked (below): Opus reads the
document again whenever a figure cannot be confirmed from the document itself. Both are set in
Settings → Import & extraction. You can re-read any draft with a different engine or model from the
review screen.

### Checking every figure

`src/server/ingest/verify.ts`, after each Claude reading:

1. **The document's own arithmetic** confirms what it can, through the review checks
   ([FORMULAS.md §13](FORMULAS.md)):
   - rows and balances, when opening + rows = closing, running balances follow, or printed
     totals match;
   - holdings, when they (with cash) add up to the value.
2. **A reading every check confirms is kept.** Typically a bank or card statement with balances.
3. **Otherwise Opus reads the document again.** That is when a check failed (balances that don't
   add up, wrong card signs, dates outside the period, rows the reader was unsure of, dropped
   rows), or when some figures have nothing to be checked against:
   - a feed screenshot with no balances;
   - a balance on its own;
   - contribution and allowance figures;
   - tax figures;
   - a reading that finds nothing to record (a second reader has to find nothing too, or the two
     disagree and you are asked).
4. **The two readings are compared figure by figure:**
   - each account's balances and dates;
   - every row's date, amount, pending flag and running balance;
   - each holding's value and units;
   - each tax figure.

   Wording may differ; figures may not.
5. **The stronger reading (Opus's) is kept** unless the arithmetic finds more wrong with it. Rows
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
  (`extract-6`); a P60 gives the year's. Two payslips of equal pay are two figures: a figure is a
  duplicate only for the same payer, amount, tax year and period. For the tax band and Self
  Assessment, an employer's P60 replaces its payslips rather than adding to them.
- **Overlapping tiles.** Long scrolling screenshots are cut into overlapping tiles, and rows in the
  overlaps are reported once.
- **Only this account's movements** (`extract-9`). Apps have lists with dates and amounts that are
  not the account's movements: a history of prizes, interest, dividends or bonuses, bond or
  certificate numbers, scheduled payments, payees. Such a list usually repeats what the account's
  own transactions show, or concerns money that went elsewhere, and it seldom says which. None of
  its rows are transactions or holdings, and no missing day is filled in.
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
  - Being your only account of the detected type adds a little: apps rarely show their own name
    on screen. It is never enough on its own.
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
  1. your rules;
  2. transfers to your own accounts (by alias, or by provider name outside investment accounts);
  3. wrapper flows (contribution, employer contribution, tax relief, LISA bonus, fees, trades,
     withdrawals). A row with a settlement date is a trade, whatever the fund is called
     (interactive investor: "12 VANGUARD FTSE GLOB Del 105.20 S Date 03/02/25"), and "Div 250 …" is
     a dividend; both take the investment's name as the payee. "Reg Contribution (E)" is an
     employer's regular payment into a pension;
  4. the built-in UK merchant list (`src/shared/merchants.ts`, about 200 patterns);
  5. the bank's own category;
  6. Claude's suggestion.
  - When the app starts, rows in investment and pension accounts that nothing categorised get the
    category the built-in wording now gives them, and its payee unless you set one
    (`categoriseInvestmentRows`). Nothing else changes: a category set by anyone stays, and so does
    a row you left uncategorised. **Re-run on all history** (Settings → Rules) works everything
    out again instead; it currently loses Claude's payees and some of its categories.
- **Duplicates** (`dedup.ts`) are checked in this order:
  1. same bank id;
  2. same date + amount + simplified description, matched as a multiset (two identical coffees
     stay two);
  3. same date + amount + balance after it (both known), matched as a multiset. The running
     balance places a row whatever each source calls it: Chase's statement says "To Credit Card"
     where its export says "To Revolving Line Account";
  4. same amount within ±3 days, flagged as a *possible* duplicate for you to decide, when the
     descriptions are similar. Described differently, only from £20 (`DIFFERENT_WORDS_FROM`), and
     then on the same day or for an amount with pence. Sources date a payment differently (made, or
     cleared two days later) and describe it differently, so a difference in one is not enough to
     call it new; but everyday prices repeat (two £3.50 coffees at different cafés are two
     coffees), and so do round sums on different days. Never when both rows show a balance after
     them and the balances differ (either sign: sources disagree on a card's).
- **Recorded twice** (`storedTwice` in `dedup.ts`). A document can show that the account already
  has a payment twice: one of its rows matches a recorded row, and another recorded row has the
  same date and amount, with nothing on the document matching it, recorded by another import (one
  document listing both is two payments: a spend, its refund and the spend again). When both copies
  show the same balance after them it is certain, and the copy comes ticked; when the document just
  shows that date and amount fewer times than they are recorded, and no balances say otherwise, it
  is offered unticked for you to judge. Only copies on the same day are found: a payment recorded
  on the day it was made and again on the day it cleared is yours to spot.
  - The copy offered has nothing of yours on it (a category, payee, note, tag or split you set, a
    correction, a receipt, a transfer link): the one the document did not match, unless only the
    other is clean. When both have something of yours, nothing is offered.
  - The review page lists it under the account ("recorded twice"), while the section goes to that
    account and you have not ticked the matching row in as a payment of its own. Committing takes a
    ticked copy away, after checking it again: both copies still there, alike, nothing of yours added since,
    and no row of the import that you ticked in as a different payment. The import records what
    it took away (`result.transactionsRemoved`), and the git history of `data/` keeps the row.
  - An import that takes a copy away is never "nothing new".
- **Transfers.** An opposite amount within ±4 days in another of your accounts is proposed as
  the other leg. On commit both legs get a `transferGroup`, and money arriving in an ISA or
  pension becomes a `contribution`. A commit also links its new rows to other legs already stored
  (the other account's statement committed earlier), without recategorising anything else.
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
  closed: it is created closed and counts for nothing after that day.
- **Liabilities.** A credit-card balance printed as a positive "amount owed" is stored as
  negative, with a note.
- **Review checks** (`shared/review.ts`, [FORMULAS.md §13](FORMULAS.md)) run on each account:
  balances (in either row order; the cash on an activity list), printed totals, holdings, the
  statement period, future dates, card signs, unsure, repeated and pending rows. A warning holds the import back from "Commit all ready".
- **Pending rows** are shown in the draft but not included by default, and reconciliation leaves
  them out. Statement balances are of settled transactions, and the settled row arrives with the
  next statement. Include one only if you know it will never appear settled.
- **Figures** are matched to an account by last 4 digits only when exactly one account has them.
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
  one, with its name and identifiers exactly as printed, and researched by an agent job
  ([AGENTS.md](AGENTS.md)).
  - A name cut short on screen ("HSBC FTSE 100 Index Accum…") matches the full name it begins, when
    only one instrument fits (`shared/funds.ts`).
  - When a later statement prints the full name, the instrument takes it and keeps the short one
    as an alias. Holdings keep the names their documents printed.

## Nothing new

A document the reader understood can add nothing: a prize history that repeats the account's
transactions, a second tab showing the same balance, the same screen uploaded twice. The import
page and the review page say so plainly ("Nothing new", with the reason), and it is put away in one
click, not left looking failed or stuck (`src/server/ingest/novelty.ts`).

- **Nothing to record.** The reader understood it and says what it shows (`nothingToRecord`, in
  its words), with no balance, rows, holdings or figures. A reading that found nothing and could not
  say what the document is stays a document to look at ("Nothing was found to record").
- **Already here.** Everything it would record is already stored (rows already imported, the same
  balance and figures on the same day for that account, the same holdings, the same tax figures),
  or is in another import waiting beside it. The reason says which: "its balance (£1,250.00 on 29
  Sep 2026) is also on IMG_0102.PNG, and its 5 transactions are already imported".
  - Of imports waiting together, the one with the most to add is kept and the others are checked
    against it; of two identical ones, the earlier upload is kept.
  - Everything counts: rows left unticked or pending, another day, one more figure (cash, rate,
    paid in), a section still waiting for its account. A rough balance you gave covers nothing.
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

## Reading a stored document again

The reader improves (`PROMPT_VERSION`: `extract-4` … `extract-9`), and a document read by an earlier
version may hold something it missed or misread. A CSV whose columns were worked out automatically
may have been read with the wrong ones, and a layout may fit it now. A committed document can be
read again from its page (Import → History → the document → *Read it again*). The Import page lists
the documents worth reading again: those an earlier reader read, and CSVs whose columns were worked
out.

- **A PDF or screenshot is read with the current reader and its check.** That is off until you
  turn it on (Settings → Import & extraction → *Read stored documents again*). A reading costs what
  an upload does. Nothing reads by itself.
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
