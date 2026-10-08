# The leak guard

Everything in this repository (code, tests, fixtures, docs and commit messages) uses invented
values. The leak guard (`scripts/leak-guard.ts`) checks that, at every place something could leave:
before a commit, in a commit message, before a push, in CI, and before Claude Code writes a file.
Most real values that reach code arrive the same way: a regression test or a comment written
while debugging a real import. The guard catches those.

It runs under plain Node (types stripped, no build), so a hook takes a fraction of a second. Its
output is always masked (`O*** P********`, `£2*,***.**`): it never prints a value it found, so CI
logs and Claude transcripts stay clean.

## What it looks for

1. **The denylist**, built from your own data directory and never committed. It looks for the
   data in this order: the `--data` option, `dataDir` in `~/.config/finance/leak-guard.json`, then
   `FINANCE_DATA_DIR`. With none, it runs on patterns and extras only, and says so. It collects:
   - from `profile.json`: your name, your surname, and your date of birth in the usual formats;
   - from `people.json`: every name and alias;
   - from `accounts.json`: names and aliases that are not just a provider and a product ("Chase
     Saver" is left out), and last-4s;
   - from `employments.json`, payslips, figures and HMRC's records: employers and their aliases
     (and each name's own distinctive word), PAYE references with their spacing variants, and
     payroll numbers;
   - from `companies.json` and `agreements.json`: names, numbers, counterparties, references and
     the details that name a place or a person;
   - from transactions: payees that are not on the public lists (`src/shared/merchants.ts` and
     `src/shared/institutions.ts`) and not plain bank wording, with their places; and, for a payee
     seen at most three times, its descriptions and references;
   - amounts that are distinctive (£100 or more with pence, or £1,000 or more in whole pounds that
     is not a multiple of £50 or a year), from every record that holds money, except figures the UK
     rules make public (`src/shared/uk.ts`, `docs/UK_RULES.md`); and holdings' units.

   Words the system dictionary (`/usr/share/dict`) knows in lower case count as plain wording for
   payees, descriptions and places; an initial ("J Smith") keeps a name a name. A town a payment
   was made in is not an employer's word: a city may show.
   The denylist is cached in `~/.cache/finance/leak-denylist.json` (0600) and rebuilt when a file
   in the data directory changes. The guard refuses to write the cache inside a git repository.
2. **Extras**, `~/.config/finance/leak-extra.txt` (0600): what the data cannot supply, such as your
   addresses, NI number, phone numbers, private hostnames and addresses on your network. One token
   per line, `#` for comments, `re:` before a regular expression (matched against lower-cased
   text). `head:` before either flags it everywhere except a `--history` scan, for a name that is
   fine in old commits but must not appear again. `npm run leak-guard -- --deep` writes postcode
   and address candidates from the readings under `data/imports` to
   `~/.config/finance/leak-extra.candidates.txt` for you to pick from; nothing is added by itself.
3. **The allowlist**, `.leakguard-allow` (public): generic or invented terms that collide with the
   denylist or a pattern. `path-glob:term` allows a term only in matching paths (the part before the
   first colon has no spaces). Never add a real value to silence a finding: change the value.
4. **Built-in patterns**, which need no data, so CI runs them too:
   - NI numbers with a valid prefix (HMRC's examples, such as `QQ123456C`, are allowed);
   - card numbers (13 to 19 digits that pass Luhn), except the networks' test numbers and
     timestamps;
   - IBANs that pass the mod-97 check, except documented examples;
   - a sort code followed by an 8-digit account number within 20 characters;
   - email addresses outside `example.com`/`.org`/`.net`, `*.test`, `*.invalid`, `*.example`,
     `*.localhost` and `users.noreply.github.com`;
   - addresses on a tailnet: CGNAT IPv4 (`100.64.0.0/10`) and Tailscale's IPv6 range (a prefix or
     a range on its own is documentation, not an address);
   - UK postcodes;
   - employer PAYE references (tax offices 000 and 123 are left for examples).
5. **File rules**: a new PDF, image, spreadsheet, CSV, OFX, QIF or Word file outside
   `tests/fixtures/`, `eval/`, `docs/images/` and `src/web/public/`; an image carrying GPS or camera
   (EXIF) metadata; and, as a warning, any file over 1 MB.

Text is NFKC-normalised and lower-cased. A token must be bounded by something that is not a letter
or a digit; a token of several words matches any whitespace between them, so one wrapped across
lines is found; ’ and ' are the same. An amount is found however it is written (`-£1,234.56`,
`1234.5`), and an integer of six or more digits is read as pence with `--pence`. A last-4 counts
only within 24 characters after "ending", "last 4", `**`, `xx`, `•`, "account" or "card".

## Modes

| Command (`npm run leak-guard -- …`) | Scans |
|---|---|
| `--staged` | Added lines and new files in the index (the pre-commit hook) |
| `--commit-msg <file>` | A commit message (the commit-msg hook) |
| `--range <a>..<b>` | Each commit's message, its author's and committer's email (they must be yours), the lines it adds and its new files |
| `--pre-push <remote>` | The same, for what git is about to push (the pre-push hook; for a new branch, every commit on no remote) |
| `--tree [<rev>]` | Every file at a revision |
| `--history` | Every file version and every message reachable from any ref; `--json` adds each finding's line key (sha256 of the line) |
| `--stdin --path <p>` | Standard input, as the content of `<p>` |
| `--claude-hook` | A Claude Code PreToolUse call (Write, Edit, NotebookEdit) |
| `--deep` | Postcode and address candidates from the readings, for the extras file |
| `--rebuild` | Rebuild the denylist now |

Options: `--data <dir>`, `--patterns-only` (CI, which has no data), `--json`, `--summary` (counts
only), `--pence`, `--exclude <glob>` (repeatable), `--repo <dir>`. Exit codes: 0 clean, 1
findings, 2 error. For `--claude-hook`, 2 blocks the write; a guard that cannot run blocks it too.

`data/` and `ops/` are private paths. In a repository that tracks its data beside the code (where
`data/meta.json` is tracked), they are left out of every scan, and a commit that changes nothing
else (the app's own data commits) is not scanned at all. Anywhere else, adding a file under them is
itself a finding.

## Hooks

- **Git:** `npm run hooks:install` (also run by `npm install`, as `prepare`) writes `pre-commit`,
  `commit-msg` and `pre-push` into the repository's common hooks directory, which every worktree
  shares. A hook that was already there is kept as `<name>.chained` and runs after the guard. An
  older checkout's `npm install` never replaces a newer version of the hooks. If you set
  `core.hooksPath`, make its hooks call the repository's own.
  - The data-only check runs in the shell before Node starts, so the app's commits work wherever
    it runs.
  - Never commit with `--no-verify`.
- **Claude Code:** `.claude/settings.json` runs `--claude-hook` before every Write, Edit and
  NotebookEdit. A write into the project that holds a finding is blocked, and Claude is told
  what was found, masked. Paths outside the project or ignored by git are not checked.

## When it finds something

Replace the value with an invented one, keeping what the test or example means: adjust the expected
results and keep the arithmetic consistent. A test never needs a real value; build a fixture from
invented names, shifted dates and changed amounts. If the match is a generic term that happens to
collide (a product name that is also an account's name), add it to `.leakguard-allow`.

Run `npm run leak-guard -- --history` now and then: the denylist grows with the data, so an old
commit can match something new. Most such matches are coincidences.
