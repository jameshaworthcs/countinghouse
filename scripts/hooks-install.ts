// Install the leak guard's git hooks (pre-commit, commit-msg, pre-push) into the repository's common
// hooks directory, which every worktree shares. Run by `npm install` (prepare) and
// `npm run hooks:install`. A hook already there that is not ours is kept as <name>.chained and runs
// after ours. A newer version of ours is never replaced by an older one (an old checkout's npm ci).
//
//   npm run hooks:install            install or update
//   node scripts/hooks-install.ts --quiet

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Bump when a hook's text changes. */
export const HOOKS_VERSION = 2;
const MARKER = '# leak-guard hooks';

const quiet = process.argv.includes('--quiet');
const say = (s: string) => {
  if (!quiet) console.log(s);
};

/** Shell that exits 0 when something is staged and all of it is data or ops material, in a repository that tracks its data. */
const DATA_ONLY = `data_only() {
  git ls-files --error-unmatch -- data/meta.json >/dev/null 2>&1 &&
    [ -n "$(git diff --cached --name-only --no-renames -- data ops)" ] &&
    [ -z "$(git diff --cached --name-only --no-renames -- . ':(exclude)data' ':(exclude)ops')" ]
}`;

const GUARD = `guard() {
  if [ ! -f "$root/scripts/leak-guard.ts" ]; then
    echo "leak-guard: $root/scripts/leak-guard.ts is missing, so this cannot be checked" >&2
    exit 1
  fi
  command -v node >/dev/null 2>&1 || { echo "leak-guard: node is not on PATH, so this cannot be checked" >&2; exit 1; }
  node "$root/scripts/leak-guard.ts" "$@"
}`;

function hook(name: string, body: string): string {
  return `#!/bin/sh
${MARKER} v${HOOKS_VERSION}: written by scripts/hooks-install.ts (npm run hooks:install); edits are overwritten.
root=$(git rev-parse --show-toplevel) || exit 1
hooks=$(git rev-parse --git-common-dir)/hooks
${DATA_ONLY}
${GUARD}
${body}
`.replace(/__CHAINED__/g, `"$hooks/${name}.chained"`);
}

const HOOKS: Record<string, string> = {
  // The app's own data commits (only data/ and ops/, where the data is tracked here) are not
  // scanned: they need no Node, so they work wherever the app runs.
  'pre-commit': hook(
    'pre-commit',
    `if ! data_only; then guard --staged || exit 1; fi
if [ -x __CHAINED__ ]; then exec __CHAINED__ "$@"; fi
exit 0`,
  ),
  // Then Conventional Commits, where the repository has a commitlint config (CONTRIBUTING.md).
  'commit-msg': hook(
    'commit-msg',
    `if ! data_only; then
  guard --commit-msg "$1" || exit 1
  if [ -f "$root/commitlint.config.js" ]; then
    if [ ! -x "$root/node_modules/.bin/commitlint" ]; then
      echo "commitlint is not installed, so this message cannot be checked: run npm ci" >&2
      exit 1
    fi
    "$root/node_modules/.bin/commitlint" --edit "$1" || exit 1
  fi
fi
if [ -x __CHAINED__ ]; then exec __CHAINED__ "$@"; fi
exit 0`,
  ),
  'pre-push': hook(
    'pre-push',
    `input=$(cat)
printf '%s\\n' "$input" | guard --pre-push "$1" || exit 1
if [ -x __CHAINED__ ]; then printf '%s\\n' "$input" | __CHAINED__ "$@" || exit 1; fi
exit 0`,
  ),
};

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function installedVersion(text: string): number | undefined {
  const m = new RegExp(`${MARKER} v(\\d+)`).exec(text);
  return m ? Number(m[1]) : undefined;
}

function main(): void {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) {
    say('hooks:install: not a git repository; nothing to do');
    return;
  }
  const dir = path.join(common, 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(HOOKS)) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      const current = readFileSync(file, 'utf8');
      const version = installedVersion(current);
      if (version === undefined) {
        const chained = `${file}.chained`;
        if (existsSync(chained)) throw new Error(`${file} is not ours and ${chained} already exists: merge them by hand`);
        renameSync(file, chained);
        say(`hooks:install: kept your ${name} hook as ${name}.chained; it runs after the leak guard`);
      } else if (version > HOOKS_VERSION) {
        say(`hooks:install: ${name} is a newer version (v${version}); left as it is`);
        continue;
      } else if (current === text) continue;
    }
    writeFileSync(file, text);
    chmodSync(file, 0o755);
    say(`hooks:install: installed ${name}`);
  }
  const hooksPath = git(['config', 'core.hooksPath']);
  if (hooksPath && path.resolve(hooksPath) !== dir) {
    const delegate = path.join(hooksPath.replace(/^~(?=\/)/, process.env.HOME ?? '~'), 'pre-commit');
    const delegates = existsSync(delegate) && /git-common-dir|_delegate/.test(readFileSync(delegate, 'utf8'));
    if (!delegates) console.warn(`hooks:install: core.hooksPath is ${hooksPath}, so git does not run ${dir}; make its hooks call ours, or the leak guard will not run`);
  }
}

try {
  main();
} catch (err) {
  console.warn(`hooks:install: ${(err as Error).message}`);
  // npm install must not fail over hooks; `npm run hooks:install` says what went wrong.
  process.exitCode = quiet ? 0 : 1;
}
