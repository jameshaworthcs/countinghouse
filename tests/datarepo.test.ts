// The data repository apart from the code (src/server/datarepo.ts): making one, the remotes it
// should never have, and telling data tracked in the code's own repository.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataInCodeRepository, initDataRepository, parseRemotes, remoteWarning } from '../src/server/datarepo';
import { GitCommitter } from '../src/server/git';
import { Store } from '../src/server/store';

let tmp: string;
const env = () => ({ ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'finance-datarepo-'));
  writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('a new data repository', () => {
  it('is a repository of its own, with data the app can open, nothing to push and a first commit', async () => {
    const code = path.join(tmp, 'code');
    mkdirSync(path.join(code, 'schemas'), { recursive: true });
    const made = await initDataRepository(path.join(tmp, 'money'), code);
    expect(made.env).toEqual([`FINANCE_DATA_DIR=${made.dir}/data`, `FINANCE_WORK_DIR=${made.dir}/.work/live`, `FINANCE_INBOX_DIR=${made.dir}/inbox`, 'FINANCE_DATA_BRANCH=main']);
    expect(existsSync(path.join(made.dir, 'data', 'meta.json'))).toBe(true);
    expect(readlinkSync(path.join(made.dir, 'schemas'))).toBe(path.join(code, 'schemas'));
    expect(readFileSync(path.join(made.dir, '.gitignore'), 'utf8')).toMatch(/^\.work\/$/m);
    expect(git(made.dir, 'log', '--format=%s').trim()).toBe('data: a new data repository');
    expect(git(made.dir, 'remote').trim()).toBe('');
    expect(statSync(path.join(made.dir, '.git', 'hooks', 'pre-push')).mode & 0o111).toBeTruthy();
    // Pushing anywhere is refused by its hook.
    const bare = path.join(tmp, 'bare.git');
    git(tmp, 'init', '--quiet', '--bare', bare);
    git(made.dir, 'remote', 'add', 'oops', bare);
    const push = spawnSync('git', ['push', 'oops', 'main'], { cwd: made.dir, env: env(), encoding: 'utf8' });
    expect(push.status).not.toBe(0);
    expect(push.stderr).toMatch(/never pushed/);
    // The app sees the remote, and says so.
    const store = await Store.open(path.join(made.dir, 'data'));
    const committer = await GitCommitter.create(path.join(made.dir, 'data'), () => true, 10, 'main');
    const status = await committer.status();
    expect(status.remotes).toEqual([{ name: 'oops', url: bare, public: false }]);
    expect(status.remoteWarning).toMatch(/has a remote: oops/);
    store.stopWatching();
    // Its data is not in the code's repository.
    expect(dataInCodeRepository(path.join(made.dir, 'data'), code)).toBe(false);
  });

  it('is never made inside another repository, or over something already there', async () => {
    const repo = path.join(tmp, 'outer');
    mkdirSync(repo);
    git(repo, 'init', '--quiet');
    await expect(initDataRepository(path.join(repo, 'money'), repo)).rejects.toThrow(/inside a git repository/);
    const full = path.join(tmp, 'full');
    mkdirSync(full);
    writeFileSync(path.join(full, 'x'), '');
    await expect(initDataRepository(full, repo)).rejects.toThrow(/not empty/);
  });
});

describe('remotes', () => {
  it('reads them without credentials, and warns louder for a public host', () => {
    // Put together here: a URL with credentials, and an scp-like one, look like email addresses.
    const github = `https://user:${['tok3n', 'github.com'].join('@')}/someone/money.git`;
    const nas = `${['git', 'nas.local'].join('@')}:money.git`;
    const remotes = parseRemotes(`origin\t${github} (fetch)\norigin\t${github} (push)\nnas\t${nas} (fetch)\n`);
    expect(remotes).toEqual([
      { name: 'origin', url: 'https://github.com/someone/money.git', public: true },
      { name: 'nas', url: nas, public: false },
    ]);
    expect(remoteWarning(remotes)).toMatch(/public host.*publish your finances.*git remote remove origin; git remote remove nas/);
    expect(remoteWarning(remotes.slice(1))).toMatch(/^Your data repository has a remote: nas/);
    expect(remoteWarning([])).toBeUndefined();
  });
});

describe('data tracked in the code repository', () => {
  it('is recognised, through a worktree too', () => {
    const repo = path.join(tmp, 'combined');
    mkdirSync(path.join(repo, 'data'), { recursive: true });
    writeFileSync(path.join(repo, 'data', 'meta.json'), '{}\n');
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'add', 'data');
    git(repo, 'commit', '--quiet', '-m', 'start');
    git(repo, 'worktree', 'add', '--quiet', '--detach', path.join(tmp, 'combined-live'));
    expect(dataInCodeRepository(path.join(repo, 'data'), repo)).toBe(true);
    expect(dataInCodeRepository(path.join(repo, 'data'), path.join(tmp, 'combined-live'))).toBe(true);
    // Untracked data (the demo's, gitignored) is not.
    mkdirSync(path.join(repo, 'demo'));
    writeFileSync(path.join(repo, 'demo', 'meta.json'), '{}\n');
    expect(dataInCodeRepository(path.join(repo, 'demo'), repo)).toBe(false);
  });
});
