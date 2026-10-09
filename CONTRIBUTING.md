# Contributing

Thank you for helping. This is a personal-finance app, so one rule comes before all the others:

> **Synthetic data only.** Never put a real value in code, tests, fixtures, docs, issues, pull
> requests or commit messages: not your names, employers, references, account numbers, amounts,
> merchants or places, and not anyone else's. Invent them.

## Before you start

```bash
npm ci                 # also installs the git hooks (npm run hooks:install)
npm run demo           # generated demo data on :4770
npm run check          # typecheck, lint and tests: green before you open a pull request
```

Work on the demo data (`npm run dev`, `npm run demo`). Screenshots come from the demo too:
`npm run screens` refuses a server on real data.

## The leak guard

[docs/LEAK_GUARD.md](docs/LEAK_GUARD.md) checks what you add for personal data:

- git hooks check every commit and its message, and every push;
- a Claude Code hook checks each file it writes;
- CI checks the shapes of personal data (NI numbers, card numbers, IBANs, sort codes with account
  numbers, emails, postcodes, private-network addresses).

If you keep your own data with the app, point the guard at it (`dataDir` in
`~/.config/finance/leak-guard.json`) and it also looks for your own names, references and amounts.
Its output is always masked. Never commit with `--no-verify`. If it flags a generic term (a product
name, say), add it to `.leakguard-allow`; never add a real value there.

## Real imports, synthetic fixtures

When a real document fails to import, do not copy its rows into a test. Make a fixture from it:

```bash
npm run fixture:anonymise -- path/to/statement.csv    # writes tests/fixtures/statement-anon.csv
```

It moves the dates by whole weeks, scales every amount by one factor (sums and running balances
still agree to within a penny or two), replaces identifiers, emails and postcodes, and swaps names
and places for invented words, keeping column headers, common words and well-known chains. It then
runs the leak guard on the result. Read the fixture before you commit it, and adjust the totals your
test relies on.

## Tests and docs

- A parser change comes with a fixture and a test (`tests/fixtures/`).
- A change to a computed figure updates [docs/FORMULAS.md](docs/FORMULAS.md) and its tests
  (property-based tests for money and the balance engine).
- A change to the data format bumps the format version with a migration
  ([docs/DATA_FORMAT.md](docs/DATA_FORMAT.md)); existing data must never need re-importing.
- Keep docs describing the system as built, and add a line to
  [docs/DECISIONS.md](docs/DECISIONS.md) when you change a decision.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), checked by commitlint in the
commit-msg hook and in CI:

```
<type>(<scope>)!: <summary, imperative, lower case, no full stop, at most 72 characters>

<what changed and why, wrapped at 72 columns>

BREAKING CHANGE: <what someone running the app must do>
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style`,
  `revert`.
- **Scopes** (optional; leave it out when a change spans many areas): `import`, `pay`, `tax`,
  `investments`, `analytics`, `projections`, `records`, `agents`, `ask`, `models`, `proposals`,
  `sessions`, `audit`, `auth`, `security`, `store`, `web`, `charts`, `deploy`, `eval`, `demo`,
  `deps`.
- `BREAKING CHANGE:` only when someone running the app must act (new required configuration, a
  removed default). No other trailers: no `Co-authored-by`, `Signed-off-by` or `Refs`.
- Dependabot's security updates are the one exception: their headers are Conventional
  (`build(deps): …`, `ci(deps): …`, set in `.github/dependabot.yml`), and commitlint skips the rest
  of their messages.

## Issues and pull requests

Describe problems with invented examples. Screenshots must come from the demo data. Never attach a
real statement, export or screenshot.
