# Finance data

This directory is written by the finance app and versioned in git: every change is a commit.
Records are plain JSON and JSONL, readable by people, `jq`, DuckDB, pandas or an LLM.

- **Money** is in pounds (at most 2 decimal places), signed from the owner's point of view:
  positive increases net worth, negative decreases it. A card balance owed is negative.
- **Dates** are `YYYY-MM-DD`.
- **Transactions** live in `transactions/<account>/<year>.jsonl`, one per line. Balances and
  valuations are in `balances/`, holdings in `holdings/`, tax figures in `figures.jsonl`.
- **Provenance:** `imports/` records how each piece of data arrived, and `documents/` keeps the
  original files.

The full field-by-field specification is in `docs/DATA_FORMAT.md` in the app repository, with
JSON Schemas in `schemas/`. Prefer editing through the app; if you edit by hand, run
`npm run validate` afterwards. The app picks up external edits automatically.
