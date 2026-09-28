# Roadmap

Counting House is a private, local-first personal finance tracker for one UK household: statements,
exports and screenshots in; validated, git-versioned data out. This page says what it holds to, what
it does not do yet, and what is worth revisiting. [ARCHITECTURE.md](ARCHITECTURE.md) describes the
system as built, and [DECISIONS.md](DECISIONS.md) records why it is the way it is.

## Principles

1. **The data is the product.** Plain JSON and JSONL with JSON Schemas, in a git repository of your
   own, whose history is the audit log. The app is replaceable; the data isn't.
2. **Nothing enters the data without review.** Every import is a draft you check side by side with
   the original document.
3. **Every number has provenance.** Records link to the import and the document they came from.
4. **Fine detail, recomputable enrichment.** Every source field is kept, including the raw row.
   Categories, payees and transfer links are derived and can be worked out again at any time.
   Format changes are versioned migrations; nothing ever needs importing again.
5. **Local and private.** The server binds to loopback and sits behind a login, reached on your own
   machine or private network. The only third party is Claude, through the engine you choose, for
   reading documents.
6. **UK-native.** The tax year runs from 6 April to 5 April. ISA, LISA, pension, Personal Savings
   Allowance and FSCS rules are dated tables with sources ([UK_RULES.md](UK_RULES.md)).
7. **Deterministic where possible, AI where necessary, verified always.** CSV, OFX, QIF and text
   exports parse locally. PDFs and screenshots are read by a model into a strict schema. Both then
   go through validation, reconciliation, duplicate checks and account matching.

## Not built yet

- **Capital gains** on general investment accounts: Section 104 pooling, with the same-day and
  30-day rules.
- **Several currencies** with exchange-rate history. Card payments abroad keep their original amount;
  an account in another currency takes one manual rate (Settings).
- **Open Banking** read-only feeds, in place of exports.
- **A household mode:** joint accounts and split ownership.

## Worth revisiting

- **Documents in git.** Original statements and screenshots are committed with the data (roughly
  0.1–1 MB each). If the repository grows heavy: Git LFS, or turning that off in Settings.
