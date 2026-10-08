// Guards that keep the live data safe once development and the live service are separated.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';
import { GitCommitter } from '../src/server/git';
import { Store, type ChangeEvent } from '../src/server/store';

const stamp = '2026-01-01T00:00:00+00:00';

async function repoWithData(): Promise<{ repo: string; git: (...args: string[]) => string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'finance-deploy-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  return { repo, git };
}

describe('data auto-commits', () => {
  it('holds commits while the checkout is on another branch, then commits everything on main', async () => {
    const { repo, git } = await repoWithData();
    try {
      const store = await Store.open(path.join(repo, 'data'));
      const committer = await GitCommitter.create(path.join(repo, 'data'), () => true, 10, 'main');
      store.on('change', (e: ChangeEvent) => committer.queue(e));
      await committer.flush('data: initialise');
      git('checkout', '-q', '-b', 'feature');
      await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }], 'account: add current');
      await committer.flush();
      expect(committer.lastError).toMatch(/branch "feature"/);
      expect(git('log', '--format=%s', 'feature').trim().split('\n')[0]).toBe('data: initialise');
      git('checkout', '-q', 'main');
      await committer.flush('data: catch up');
      expect(committer.lastError).toBeUndefined();
      expect(git('log', '--format=%s', 'main').trim().split('\n')[0]).toBe('data: catch up');
      expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/accounts.json');
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('commits new data files though the repository leaves data/ out, and keeps documents out when you say so', async () => {
    const { repo, git } = await repoWithData();
    try {
      const store = await Store.open(path.join(repo, 'data'));
      await (await GitCommitter.create(path.join(repo, 'data'), () => true, 10, 'main')).flush('data: initialise');
      // A code checkout that tracks its data, with a .gitignore that leaves data/ out (as the code
      // repository's does): new data files must not wait on it.
      await writeFile(path.join(repo, '.gitignore'), 'data/\n');
      git('add', '.gitignore');
      git('commit', '-q', '-m', 'ignore data');
      const committer = await GitCommitter.create(path.join(repo, 'data'), () => true, 10, 'main');
      expect(committer.tracked).toBe(true);
      // A new file (a document) in a directory the repository ignores is committed too.
      await mkdir(path.join(repo, 'data', 'documents', '2026', '10'), { recursive: true });
      await writeFile(path.join(repo, 'data', 'documents', '2026', '10', 'a.pdf'), 'one');
      await committer.flush('data: a document');
      expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/documents/2026/10/a.pdf');
      // Documents kept out of git: the next is left out, and the marker that says so is committed.
      await store.setSettings({ ...store.settings, git: { ...store.settings.git, trackDocuments: false } });
      await writeFile(path.join(repo, 'data', 'documents', '2026', '10', 'b.pdf'), 'two');
      await committer.flush();
      const last = git('show', '--name-only', '--format=', 'HEAD');
      expect(last).toMatch(/^data\/documents\/\.gitignore$/m);
      expect(last).not.toMatch(/b\.pdf/);
      expect(git('status', '--porcelain', '--ignored', '--', 'data/documents/2026/10/b.pdf')).toMatch(/b\.pdf/);
      store.stopWatching();
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('never commits onto a detached HEAD', async () => {
    const { repo, git } = await repoWithData();
    try {
      const store = await Store.open(path.join(repo, 'data'));
      const committer = await GitCommitter.create(path.join(repo, 'data'), () => true, 10, null);
      store.on('change', (e: ChangeEvent) => committer.queue(e));
      git('checkout', '-q', '--detach');
      await committer.flush('data: initialise');
      expect(committer.lastError).toMatch(/detached HEAD/);
      expect(git('log', '--format=%s').trim()).toBe('start');
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('start-up guards', () => {
  it('requires a login for data tracked in git, even on loopback', async () => {
    const { repo } = await repoWithData();
    try {
      const config = loadConfig({ FINANCE_DATA_DIR: path.join(repo, 'data'), FINANCE_WORK_DIR: path.join(repo, '.work'), FINANCE_WATCH: '0' });
      await expect(createApp(config, { version: 'test', env: {}, inbox: false })).rejects.toThrow(/login is required/);
      const env = { FINANCE_USERNAME: 'owner', FINANCE_PASSWORD_HASH: await hashPassword('a long test password') };
      const app = await createApp(config, { version: 'test', env, inbox: false });
      await app.close();
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('needs the data named in production, and keeps a data repository\'s work area and inbox beside its data', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/FINANCE_DATA_DIR must be set in production/);
    const outside = loadConfig({ FINANCE_DATA_DIR: '/srv/money/data' });
    expect([outside.workDir, outside.inboxDir]).toEqual(['/srv/money/.work/data', '/srv/money/inbox']);
    // Data in the code checkout (the demo's) keeps them in the checkout, as before.
    const demo = loadConfig({ FINANCE_DATA_DIR: 'demo-data' });
    expect([path.relative(demo.projectRoot, demo.workDir), path.relative(demo.projectRoot, demo.inboxDir)]).toEqual([path.join('.work', 'demo-data'), path.join('.work', 'inbox-demo-data')]);
  });

  it('refuses data tracked in the code repository: in production it will not start, in development nothing is committed', async () => {
    const { repo, git } = await repoWithData();
    try {
      // The code checkout is the repository the data is tracked in (projectRoot = repo).
      const store = await Store.open(path.join(repo, 'data'));
      store.stopWatching();
      git('add', 'data');
      git('commit', '-q', '-m', 'data in the code repository');
      const env = { FINANCE_USERNAME: 'owner', FINANCE_PASSWORD_HASH: await hashPassword('a long test password') };
      const base = { FINANCE_DATA_DIR: path.join(repo, 'data'), FINANCE_WORK_DIR: path.join(repo, '.work'), FINANCE_WATCH: '0' };
      await expect(createApp(loadConfig({ ...base, NODE_ENV: 'production' }, repo), { version: 'test', env, inbox: false })).rejects.toThrow(/tracked in the code's own repository.*npm run init-data/);
      const app = await createApp(loadConfig(base, repo), { version: 'test', env, inbox: false });
      expect(app.ctx.git.tracked).toBe(true);
      expect(app.ctx.git.enabled).toBe(false);
      expect(app.ctx.git.lastError).toMatch(/^Data changes are not being committed/);
      await app.close();
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('refuses to create a missing data directory in production unless asked to', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-init-'));
    try {
      const base = { FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', NODE_ENV: 'production' };
      await expect(createApp(loadConfig(base), { version: 'test', env: {}, inbox: false })).rejects.toThrow(/No data directory/);
      const app = await createApp(loadConfig({ ...base, FINANCE_INIT_DATA: '1' }), { version: 'test', env: {}, inbox: false });
      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('reports the commit being served', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-health-'));
    try {
      const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
      const app = await createApp(config, { version: 'test', commit: 'abc1234', env: {}, inbox: false });
      const res = await app.app.request('http://localhost/api/health', { headers: { host: 'localhost' } });
      expect(await res.json()).toEqual({ ok: true, version: 'test', commit: 'abc1234' });
      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
