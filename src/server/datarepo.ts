// The data repository: the git repository that holds data/, its work area and its inbox, apart from
// the code (docs/SELF_HOSTING.md, "The layout"). Making one (`npm run init-data`), the remotes it
// should never have, and whether data is tracked in the code's own repository.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Variables a git hook sets, which would point every call at that one repository. */
const REPO_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPO_VARS.has(k)));

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** The repository's common git directory (one for all its worktrees), or undefined outside git. */
export const commonDir = (dir: string) => gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

/**
 * True when the data directory is tracked in the code's own repository (or a worktree of it): the
 * layout before code and data were split, which must not carry on once the code is shared.
 */
export function dataInCodeRepository(dataDir: string, codeRoot: string): boolean {
  if (!existsSync(dataDir)) return false;
  const data = commonDir(dataDir);
  if (!data || data !== commonDir(codeRoot)) return false;
  return Boolean(gitOut(dataDir, ['ls-files', '--', 'meta.json']));
}

/** Hosts where a pushed repository can be public. */
const PUBLIC_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|gitea\.com|huggingface\.co|sourceforge\.net)$/i;

export interface DataRemote {
  name: string;
  /** Without any user name or token. */
  url: string;
  /** On a host where repositories can be public. */
  public: boolean;
}

/** A URL's host, for `https://…`, `ssh://…` and scp-like `git@host:path`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return /^(?:[^@/]+@)?([^:/]+):/.exec(url)?.[1] ?? '';
  }
}

/** The data repository's remotes: it should have none, since nothing in it is ever pushed. */
export const remotesOf = (repoRoot: string) => parseRemotes(gitOut(repoRoot, ['remote', '-v']) ?? '');

/** `git remote -v`'s output, each remote once. */
export function parseRemotes(output: string): DataRemote[] {
  const out = new Map<string, DataRemote>();
  for (const line of output.split('\n')) {
    const [name, raw] = line.split(/\s+/);
    if (!name || !raw || out.has(name)) continue;
    const url = raw.replace(/\/\/[^/@]*@/, '//');
    out.set(name, { name, url, public: PUBLIC_HOSTS.test(hostOf(raw)) });
  }
  return [...out.values()];
}

/** A sentence on the remotes, for the log, Settings and Data health; undefined when there are none. */
export function remoteWarning(remotes: DataRemote[]): string | undefined {
  if (!remotes.length) return undefined;
  const list = remotes.map((r) => `${r.name} (${r.url})`).join(', ');
  const remove = remotes.map((r) => `git remote remove ${r.name}`).join('; ');
  return remotes.some((r) => r.public)
    ? `Your data repository has a remote on a public host: ${list}. Pushing would publish your finances. Remove it (${remove}).`
    : `Your data repository has a remote: ${list}. Nothing in it should leave this machine through git. Remove it (${remove}).`;
}

const README = `# Your Counting House data

This is a private git repository of your financial data, made by \`npm run init-data\`. The app
reads and writes \`data/\` and commits each change, so git's history is the audit log of your data.

- \`data/\`: your records (docs/DATA_FORMAT.md in the code checkout). Change them through the app,
  never by hand.
- \`.work/\`: uploads waiting for review, job state and the audit log (not in git).
- \`inbox/\`: drop statements and screenshots here while the app runs (not in git).
- \`schemas\`: a link to the code checkout's JSON schemas, which the data files name.

It has no remote, and its pre-push hook refuses every push: back it up instead (an encrypted
\`git bundle\`, off the machine). Never push it anywhere.
`;

const PRE_PUSH = `#!/bin/sh
# A data repository is never pushed anywhere (docs/SELF_HOSTING.md). Back it up instead.
echo "This is your private data repository: it is never pushed." >&2
exit 1
`;

export interface InitResult {
  dir: string;
  /** The lines to add to the live service's .env (and the code checkout's, to use it there). */
  env: string[];
}

/**
 * Make a data repository at `dir`: git, a data directory the app can open, a `.gitignore` for the
 * work area and the inbox, a link to the code's schemas, a pre-push hook that refuses every push, a
 * README, and a first commit. `dir` must not exist yet or be empty, and must not be inside another
 * repository (the code's least of all).
 */
export async function initDataRepository(dir: string, codeRoot: string): Promise<InitResult> {
  const abs = path.resolve(dir);
  if (existsSync(abs) && readdirSync(abs).length) throw new Error(`${abs} is not empty: choose a new directory.`);
  let probe = abs;
  while (!existsSync(probe)) probe = path.dirname(probe);
  if (gitOut(probe, ['rev-parse', '--is-inside-work-tree']) === 'true') throw new Error(`${abs} is inside a git repository: a data repository must be one of its own, apart from the code.`);

  mkdirSync(abs, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: abs, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  // Loaded here: git.ts uses this module's remotes, and the store must not load with it.
  const { Store } = await import('./store');
  const store = await Store.open(path.join(abs, 'data'));
  store.stopWatching();
  writeFileSync(path.join(abs, '.gitignore'), '# Uploads waiting for review, job state and the audit log; files waiting in the inbox.\n.work/\ninbox/*\n!inbox/.gitkeep\n');
  mkdirSync(path.join(abs, '.work'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(abs, 'inbox'), { recursive: true });
  writeFileSync(path.join(abs, 'inbox', '.gitkeep'), '');
  writeFileSync(path.join(abs, 'README.md'), README);
  symlinkSync(path.join(path.resolve(codeRoot), 'schemas'), path.join(abs, 'schemas'));
  const hook = path.join(abs, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, PRE_PUSH);
  chmodSync(hook, 0o755);
  git('add', '--', '.gitignore', 'README.md', 'schemas', 'inbox/.gitkeep', 'data');
  git('commit', '--quiet', '--message', 'data: a new data repository');
  return {
    dir: abs,
    env: [`FINANCE_DATA_DIR=${path.join(abs, 'data')}`, `FINANCE_WORK_DIR=${path.join(abs, '.work', 'live')}`, `FINANCE_INBOX_DIR=${path.join(abs, 'inbox')}`, 'FINANCE_DATA_BRANCH=main'],
  };
}
