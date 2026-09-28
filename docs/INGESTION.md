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
| OFX / QFX (1.x SGML and 2.x XML) | `ofx` | Bank and credit-card statements, FITID as id, ledger/available balance |
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
| `claude-cli` | Default when the `claude` CLI is installed and logged in | `claude -p` with `--json-schema`, `--tools Read`, `--safe-mode`, `--no-session-persistence`, run in a scratch directory containing only the document |
| `claude-api` | When `ANTHROPIC_API_KEY` is set (or chosen) | Messages API with structured outputs (`output_config.format`), streaming, and `fallbacks: "default"` so a refusal is retried on the recommended fallback model |
| `ocr` | Always available offline | tesseract / pdftotext; proposes the headline balance and candidate values, and parses statement-style lines using running balances to infer signs. Low confidence, so review carefully |

The model defaults to Opus (most accurate for financial figures), with effort `high`. You can
re-read any draft with a different engine or model from the review screen.

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

Screenshot dates come from the first available of:

1. a date visible in the image;
2. EXIF/XMP metadata;
3. the file name (Android, macOS, iOS and GNOME patterns);
4. the file's modified time;
5. the upload date (flagged for you to fix).

## From extraction to draft

`src/server/ingest/draft.ts` does the following:

- **Account matching** scores on last 4 digits (and a mismatch vetoes), provider, type, name
  words and currency. An account you pinned the upload to always wins. Below the threshold a new
  account is proposed.
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
