# Extraction evaluation

How well the import pipeline reads documents, measured field by field on a fixed set of synthetic
documents. Nothing here is real: names, numbers and references are invented, and the documents
imitate layouts, not any bank's branding.

```bash
npm run eval                                  # every case; PDFs and screenshots go to Claude
npm run eval -- --only pdf-amex-card          # some cases (comma-separated)
npm run eval -- --tag card-signs              # cases with a tag
npm run eval -- --render                      # write the documents to eval/.out/docs and stop
npm run eval -- --model sonnet --effort medium --concurrency 3 --label try-sonnet
npm run eval -- --verify-model off            # the reading model alone, without the check
npm run eval -- --everything --only png-payslip-scan,pdf-p60,pdf-barclaycard,pdf-marcus-savings   # the reader that reads everything (extract-14)
```

By default a run uses the app's own settings: Sonnet reads, and Opus checks anything the
document's arithmetic cannot confirm (docs/INGESTION.md). Each case records how it was checked.

## What it runs

- **The cases** are in `cases.ts`.
  - The kinds of document: CSV exports, PDF statements and phone screenshots, across current,
    card, savings, ISA, LISA, SIPP and workplace pension accounts, Premium Bonds, a P60 and an
    interest certificate.
  - The awkward ones are tagged: `multi-account`, `pending`, `refund`, `fx`, `overlap`,
    `long-screenshot`, `card-signs`, `new-account`.
  - Each case's expected result comes from the same data as its document.
- **The pipeline** is the real one. Each case (or group of cases) gets a temporary store with the
  accounts in `EVAL_ACCOUNTS`, and the file goes through `ImportService`, as an upload does:
  - detection, CSV parsing, image tiling;
  - the prompt and the logged-in `claude` CLI;
  - normalising, drafting, account matching and duplicate detection.
- **Groups** share a store: each document is committed before the next. This checks that an
  overlapping statement or screenshot is recognised as already imported.
- **Groups uploaded together** (`together`) are what a phone sends: every file is uploaded at
  once, read side by side and judged together, and none is committed. This checks screenshots that
  lean on each other: the account a scrolled screen belongs to, and views that add nothing new.

## What it measures

Every expected field is one point (`score.ts`):

| Field | Point for |
|---|---|
| `account` | the account the rows are imported into |
| `row` | each expected row found |
| `noExtra` | each extracted row that is expected |
| `date`, `sign`, `amount`, `description`, `pending` | each found row |
| `balanceAfter` | each found row that prints a running balance |
| `original` | each payment in a foreign currency |
| `duplicate` | each row correctly marked (or not) as already imported |
| `balance`, `period`, `balanceDate` | each statement or screen |
| `wrapper` | contributions, bonus, allowance used and cash, on investment accounts |
| `totals` | the money in and money out totals a statement prints |
| `holding`, `holdingValue`, `holdingUnits`, `holdingIsin` | each holding |
| `figure`, `figureYear` | each tax figure |
| `noExtraFigure`, `noExtraSection` | each figure or account the document does not state (a point lost) |
| `noExtraHolding` | each holding read from a document that shows none, or other ones (a point lost) |
| `nothingNew` | every case: recognised as adding nothing new when it adds nothing, and never otherwise |
| `noClaim` | a note that states what the document does not say, such as where money went (a point lost) |
| `payslip`, `payslipNet`, `payslipCodes`, `payslipLine`, `payslipNoExtraLine`, `payslipYtd` | with `--everything`: each payslip read in full, its net pay, codes and period, every line, no extra line, each year-to-date value and employer cost |
| `printed`, `printedPrivate` | with `--everything`: each value the document prints that nothing else holds; a name or NI number kept among them (a point lost) |
| `termsLimit`, `termsRate`, `termsNoExtraRate`, `termsMinimum` | with `--everything`: an account's credit limit, each rate it prints (what it applies to, the rate, when it ends), no extra rate, and a card's minimum payment and due date |

Rows are aligned before scoring: an exact date and amount first, then near misses. So a sign or
date error counts as that error, not as a missing row plus an extra one.

## Results

Each run writes `results/<time>_<prompt version>_<label>.json`: the totals by field, kind and tag,
and each case's score, errors, cost and duration. The files are small and kept in git, so a prompt
or parser change can be compared with the runs before it. PDFs and screenshots spend the Claude
plan: a full run is about 22 extractions.
