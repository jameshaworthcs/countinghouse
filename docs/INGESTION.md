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
| Lloyds / Halifax / Bank of Scotland / TSB CSV | `lloyds-group` | Debit/credit columns |
| NatWest / RBS / Ulster CSV | `natwest-group` | Blank first line, spaced headers |
| Nationwide CSV | `nationwide-current`, `nationwide-credit-card` | Windows-1252 `£`, preamble with account name and balance |
| Amex CSV | `amex` | Positive = charge (signs inverted); merchant address; reference as id |
| HSBC CSV (no header) | `hsbc` | Matched by the shape of the first row |
| first direct and other Date/Description/Amount CSVs | `date-description-amount` | |
| Trading 212 CSV | `trading-212` | Buys and withdrawals are money out; deposits count as contributions |
| Anything else CSV | auto-detected mapping | Confident mappings import straight away (flagged); otherwise you map the columns once and save them as a profile |
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
   - tax figures.
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

Measured on the evaluation set (`extract-5`, 28 documents):

| Configuration | Field accuracy | Cost | Time |
|---|---|---|---|
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
  year, uninvested cash, and each holding with ISIN, units, price and value.
- **Tax figures** from P60s, payslips, P11Ds, interest certificates, pension and dividend
  statements.
- **Last 4 digits only.** A full account or card number is never output.
- **Overlapping tiles.** Long scrolling screenshots are cut into overlapping tiles, and rows in the
  overlaps are reported once.
- **Only this account's movements.** A list of prizes, interest or dividends paid out to another
  account (Premium Bond prizes paid to your bank) is not a transaction of this one.
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
3. the file name (Android, macOS, iOS and GNOME patterns);
4. the file's modified time;
5. the upload date (flagged for you to fix).

## From extraction to draft

`src/server/ingest/draft.ts` does the following:

- **Account matching** scores on last 4 digits (and a mismatch vetoes), provider, type, name
  words and currency.
  - An account you pinned the upload to always wins.
  - Being your only account of the detected type adds a little: apps rarely show their own name
    on screen. It is never enough on its own.
  - Closed accounts still take their old statements, with a small penalty so an open account wins
    a tie; the review page lists them separately.
  - Below the threshold a new account is proposed.
  - An existing account set up without its number learns the last digits its first statement
    shows, so later statements match it by themselves. An account that has its number keeps it.
- **Accounts with nothing to import** (the account an interest certificate names, say) are left
  out of the draft.
- **Foreign amounts** take the sign of the sterling amount; documents often print them unsigned.
- **Categorisation** follows `src/shared/categorise.ts`:
  1. your rules;
  2. transfers to your own accounts (by alias, or by provider name outside investment accounts);
  3. wrapper flows (contribution, employer contribution, tax relief, LISA bonus, fees, trades,
     withdrawals);
  4. the built-in UK merchant list (`src/shared/merchants.ts`, about 200 patterns);
  5. the bank's own category;
  6. Claude's suggestion.
- **Duplicates** (`dedup.ts`) are checked in this order:
  1. same bank id;
  2. same date + amount + simplified description, matched as a multiset (two identical coffees
     stay two);
  3. same amount within ±3 days with a similar description, flagged as a *possible* duplicate
     for you to decide.
- **Transfers.** An opposite amount within ±4 days in another of your accounts is proposed as
  the other leg. On commit both legs get a `transferGroup`, and money arriving in an ISA or
  pension becomes a `contribution`.
- **Liabilities.** A credit-card balance printed as a positive "amount owed" is stored as
  negative, with a note.
- **Review checks** (`shared/review.ts`, [FORMULAS.md §13](FORMULAS.md)) run on each account:
  balances, printed totals, the statement period, future dates, card signs, unsure, repeated and
  pending rows. A warning holds the import back from "Commit all ready".
- **Pending rows** are shown in the draft but not included by default, and reconciliation leaves
  them out. Statement balances are of settled transactions, and the settled row arrives with the
  next statement. Include one only if you know it will never appear settled.
- **Figures** are matched to an account by last 4 digits only when exactly one account has them.
- **Committing is safe to retry.** Everything is validated before the first write. Transaction ids
  include the import id, so committing the same import again adds nothing twice.
- **Funds on statements become instruments.** A holding with no matching instrument is recorded as
  one, with its name and identifiers exactly as printed, and researched by an agent job
  ([AGENTS.md](AGENTS.md)).

## Measuring extraction

`npm run eval` runs a fixed set of synthetic documents through this pipeline and scores the
result field by field ([eval/README.md](../eval/README.md)). Run it before and after changing the
prompt, a parser or the matching, and keep the results file it writes.
