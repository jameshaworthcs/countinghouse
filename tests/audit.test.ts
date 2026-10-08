// The audit log (src/server/audit.ts; Settings → Audit log): every change, who made it and from
// where, kept whole and in order. No test here starts a job: one that ran would spend the owner's
// Claude plan.

import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry, AuditResponse, AuditVerifyResponse } from '../src/shared/audit';
import { createApp, type App } from '../src/server/app';
import { AuditLog, DeviceNames, isAudited, redact, runAs, shape } from '../src/server/audit';
import { diffById, diffFields } from '../src/server/auditdiff';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';
import { auditRange, GitCommitter } from '../src/server/git';

const CSRF = { 'x-finance-csrf': '1' };
const ME = { type: 'owner', user: 'james', via: 'session', ip: '100.64.0.2' } as const;

describe('the log', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-audit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('writes each entry at once, readable by you alone, and carries the chain on after a restart', async () => {
    const log = AuditLog.open(dir);
    const a = log.record({ category: 'data', action: 'data.change', summary: 'rules: update', actor: ME, paths: ['rules.json'] });
    // On disk before record() returns, not when a buffer gets round to it.
    const file = path.join(dir, `${a.at.slice(0, 7)}.jsonl`);
    expect(JSON.parse((await readFile(file, 'utf8')).trim()) as AuditEntry).toEqual(a);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    log.close();

    const again = AuditLog.open(dir);
    const b = again.record({ category: 'app', action: 'app.start', summary: 'Started', actor: { type: 'app', task: 'start-up' } });
    expect(b.seq).toBe(a.seq + 1);
    expect(await again.verify()).toMatchObject({ ok: true, entries: 2, unreadable: 0, problems: [] });
    again.close();
  });

  it('shows an entry changed or removed afterwards when the chain is checked', async () => {
    const log = AuditLog.open(dir);
    for (const n of [1, 2, 3]) log.record({ category: 'data', action: 'data.change', summary: `change ${n}`, actor: ME });
    log.close();
    const [file] = (await import('node:fs')).readdirSync(dir);
    const abs = path.join(dir, file!);
    const lines = (await readFile(abs, 'utf8')).trim().split('\n');

    await writeFile(abs, `${[lines[0], lines[1]!.replace('change 2', 'change 9'), lines[2]].join('\n')}\n`);
    let check = await AuditLog.open(dir).verify();
    expect(check.ok).toBe(false);
    expect(check.problems[0]?.seq).toBe(2);
    expect(check.problems[0]?.problem).toContain('hash does not match');

    await writeFile(abs, `${[lines[0], lines[2]].join('\n')}\n`);
    check = await AuditLog.open(dir).verify();
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.problem)).toEqual(expect.arrayContaining([expect.stringContaining('#2–#2 are missing')]));
  });

  it('after a write cut off by a crash, carries on from the last whole entry on a line of its own', async () => {
    const log = AuditLog.open(dir);
    const a = log.record({ category: 'data', action: 'data.change', summary: 'whole', actor: ME });
    log.close();
    const file = path.join(dir, `${a.at.slice(0, 7)}.jsonl`);
    await appendFile(file, '{"seq":2,"at":"2026-');
    const reopened = AuditLog.open(dir);
    const b = reopened.record({ category: 'data', action: 'data.change', summary: 'after the crash', actor: ME });
    expect(b.seq).toBe(2);
    const check = await reopened.verify();
    expect(check).toMatchObject({ entries: 2, unreadable: 1 });
    expect(check.problems).toHaveLength(1);
    expect((await readFile(file, 'utf8')).split('\n').at(-2)).toBe(JSON.stringify(b));
  });

  it('finds entries by any words, who, what, outcome and day, newest first and a page at a time', async () => {
    const log = AuditLog.open(dir);
    log.record({ category: 'data', action: 'data.change', summary: 'transaction: categorise TESCO', actor: ME, diff: { changed: 1, items: [{ id: 'tx_0123456789abcdef', op: 'changed', fields: { category: ['shopping', 'groceries'] } }] } });
    log.record({ category: 'request', action: 'request', outcome: 'refused', summary: 'Refused: POST /api/records', actor: { type: 'token', tokenId: 'tok_aaaaaaaaaaaa', name: 'Claude', scopes: ['read'], ip: '100.64.0.9', device: 'my-server' } });
    log.record({ category: 'job', action: 'job.succeeded', summary: 'Agent job research-instrument: finished', actor: { type: 'job', jobId: 'job_x1', kind: 'research-instrument', trigger: 'owner' } });
    const seqs = async (q: Parameters<AuditLog['query']>[0]) => (await log.query({ all: true, ...q })).entries.map((e) => e.seq);
    expect(await seqs({})).toEqual([3, 2, 1]);
    expect(await seqs({ q: 'groceries' })).toEqual([1]);
    expect(await seqs({ q: 'my-server claude' })).toEqual([2]);
    expect(await seqs({ q: 'groceries claude' })).toEqual([]);
    expect(await seqs({ actors: ['job'] })).toEqual([3]);
    expect(await seqs({ categories: ['data', 'request'] })).toEqual([2, 1]);
    expect(await seqs({ outcome: 'refused' })).toEqual([2]);
    const day = new Date().toLocaleDateString('en-CA');
    expect(await seqs({ from: day, to: day })).toEqual([3, 2, 1]);
    expect(await seqs({ to: '2000-01-01' })).toEqual([]);
    const first = await log.query({ all: true, limit: 2 });
    expect(first.entries.map((e) => e.seq)).toEqual([3, 2]);
    expect((await log.query({ all: true, limit: 2, before: first.next! })).entries.map((e) => e.seq)).toEqual([1]);
    // The hash is not searched: hex in it would match anything.
    const hash = first.entries[0]!.hash.slice(0, 8);
    expect(await seqs({ q: hash })).toEqual([]);
    log.close();
  });

  it('keeps who is acting through everything the work starts, and only that work', async () => {
    const log = AuditLog.open(dir);
    const job = { type: 'job', jobId: 'job_x', kind: 'monthly-review', trigger: 'schedule' } as const;
    await runAs(job, async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.record({ category: 'data', action: 'data.change', summary: 'insights: add' });
    });
    log.record({ category: 'data', action: 'data.change', summary: 'outside any work' });
    const [outside, inJob] = (await log.query({ all: true })).entries;
    expect(inJob!.actor).toEqual(job);
    expect(outside!.actor).toEqual({ type: 'app', task: 'background' });
    log.close();
  });
});

describe('what a change says', () => {
  it('lists records added, removed and changed, with fields before and after', () => {
    const before = [
      { id: 'r1', name: 'Tesco', category: 'shopping', updatedAt: '2026-01-01' },
      { id: 'r2', name: 'Gone' },
    ];
    const after = [
      { id: 'r1', name: 'Tesco', category: 'groceries', updatedAt: '2026-10-02' },
      { id: 'r3', name: 'New', amount: -12.5, date: '2026-10-01' },
    ];
    expect(diffById(before, after)).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      items: [
        { id: 'r1', op: 'changed', label: 'Tesco', fields: { category: ['shopping', 'groceries'] } },
        { id: 'r3', op: 'added', label: '2026-10-01 -12.5 New' },
        { id: 'r2', op: 'removed', label: 'Gone' },
      ],
    });
    expect(diffFields({ agents: { enabled: false, model: 'x' }, git: { autoCommit: true } }, { agents: { enabled: true, model: 'x' }, git: { autoCommit: true } })).toEqual({ 'agents.enabled': [false, true] });
  });

  it('keeps secrets and documents out of what it records of a request', () => {
    expect(redact({ username: 'james', password: 'correct horse', nested: { clientSecret: 'x', note: 'n'.repeat(400) } })).toEqual({
      username: 'james',
      password: '[redacted]',
      nested: { clientSecret: '[redacted]', note: `${'n'.repeat(300)}… (400 characters)` },
    });
    expect(redact({ reference: 'QQ 12 34 56 C', card: '4111 1111 1111 1234', account: '12345678', sortCode: '12-34-56', date: '2026-10-02' })).toEqual({
      reference: '[NI number]',
      card: '••••1234',
      account: '••••5678',
      sortCode: '12-34-56',
      date: '2026-10-02',
    });
    expect(shape({ draft: { sections: [{ rows: [] }, {}], title: 'Statement' } })).toEqual({ draft: { sections: '[2 items]', title: '(9 characters)' } });
    expect(isAudited('POST', '/api/rules/preview')).toBe(false);
    expect(isAudited('POST', '/api/proposals/prop_x/check')).toBe(false);
    expect(isAudited('GET', '/api/transactions')).toBe(false);
    expect(isAudited('POST', '/api/auth/login')).toBe(false); // recorded as a sign-in instead
    expect(isAudited('PATCH', '/api/transactions/tx_1')).toBe(true);
    expect(isAudited('DELETE', '/api/imports/imp_1')).toBe(true);
  });

  it('asks the tailnet only about tailnet addresses', () => {
    expect(DeviceNames.isTailnet('100.64.0.2')).toBe(true);
    expect(DeviceNames.isTailnet('100.127.255.1')).toBe(true);
    expect(DeviceNames.isTailnet('::ffff:100.64.0.9')).toBe(true);
    expect(DeviceNames.isTailnet('fd7a:115c:a1e0::1:2')).toBe(true);
    expect(DeviceNames.isTailnet('100.128.0.1')).toBe(false);
    expect(DeviceNames.isTailnet('192.168.0.10')).toBe(false);
    expect(DeviceNames.isTailnet('127.0.0.1')).toBe(false);
  });
});

describe('commits name their audit entries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-audit-git-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('folds runs of entries, and says which entries each commit holds', async () => {
    expect(auditRange([7, 3, 4, 5, 9, 4])).toBe('#3–#5, #7, #9');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    await mkdir(path.join(dir, 'data'));
    await writeFile(path.join(dir, 'data', 'rules.json'), '{}\n');
    const committer = await GitCommitter.create(path.join(dir, 'data'), () => true, 10_000, 'main');
    const commits: { hash: string; auditSeqs: number[] }[] = [];
    committer.onCommit = (c) => commits.push(c);
    committer.queue({ message: 'rules: update', paths: ['rules.json'], auditSeq: 12 });
    committer.queue({ message: 'rules: update', paths: ['rules.json'], auditSeq: 13 });
    await committer.flush();
    expect(commits).toEqual([{ hash: git('rev-parse', '--short', 'HEAD').trim(), subject: 'rules: update', auditSeqs: [12, 13] }]);
    expect(git('log', '-1', '--format=%b')).toContain('Audit: #12–#13');
  });
});

describe('the app records who did what', () => {
  let app: App;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-audit-api-'));
    const env = { FINANCE_USERNAME: 'james', FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_SESSION_SECRET: 'x'.repeat(40) };
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test', ...env });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env, inbox: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) =>
    app.app.request(`http://finance.example.test${p}`, { ...init, headers: { host: 'finance.example.test', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https', 'user-agent': 'TestBrowser/1.0', ...(init.headers ?? {}) } });
  const signIn = async () => {
    const res = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  };
  const audit = async (cookie: string, query = '') => (await (await req(`/api/audit${query}`, { headers: { cookie } })).json()) as AuditResponse;

  it('your change: the request, from where, what it sent, and each record’s fields before and after', async () => {
    const cookie = await signIn();
    const json = { ...CSRF, cookie, 'content-type': 'application/json' };
    expect((await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify({ id: 'test-card', name: 'Test card', type: 'credit_card' }) })).status).toBe(201);
    expect((await req('/api/accounts/test-card', { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'Travel card' }) })).status).toBe(200);

    const { entries } = await audit(cookie);
    const rename = entries[0]!;
    expect(rename).toMatchObject({
      category: 'request',
      outcome: 'ok',
      actor: { type: 'owner', user: 'james', via: 'session', ip: '100.64.0.2', userAgent: 'TestBrowser/1.0' },
      request: { method: 'PATCH', path: '/api/accounts/test-card', status: 200, body: { name: 'Travel card' } },
    });
    expect(rename.changes).toHaveLength(1);
    expect(rename.changes![0]!.paths).toEqual(['accounts.json']);
    expect(entries.map((e) => e.action)).toEqual(['request', 'request', 'auth.sign-in', 'app.start']);
    expect(entries[2]).toMatchObject({ category: 'auth', outcome: 'ok', actor: { type: 'owner', ip: '100.64.0.2' }, details: { method: 'password' } });

    // Each step on its own: the write, with what it changed, belongs to the request.
    const all = await audit(cookie, '?all=1&category=data');
    const write = all.entries[0]!;
    expect(write).toMatchObject({ action: 'data.change', requestId: rename.requestId, actor: { type: 'owner' }, paths: ['accounts.json'] });
    expect(write.diff).toMatchObject({ changed: 1, items: [{ id: 'test-card', op: 'changed', fields: { name: ['Test card', 'Travel card'] } }] });
    expect(rename.changes![0]!.seq).toBe(write.seq);

    // Searchable by what changed, and the chain is whole.
    expect((await audit(cookie, '?q=travel%20card')).entries.map((e) => e.seq)).toEqual([rename.seq]);
    const check = (await (await req('/api/audit/verify', { headers: { cookie } })).json()) as AuditVerifyResponse;
    expect(check.ok).toBe(true);
  });

  it('refusals are recorded with who tried: a wrong password, no session, a token out of scope, a bad token', async () => {
    await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'wrong' }) });
    expect((await req('/api/settings', { method: 'PUT', headers: { ...CSRF, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const made = await app.ctx.tokens.create({ name: 'Claude Code on my-server', scopes: ['imports'], days: 30 });
    expect((await req('/api/records', { method: 'POST', headers: { ...CSRF, authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const fake = `fin_${made.view.id.slice(4)}_${'A'.repeat(43)}`;
    expect((await req('/api/records', { method: 'POST', headers: { ...CSRF, authorization: `Bearer ${fake}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);

    const cookie = await signIn();
    const refused = (await audit(cookie, '?outcome=refused')).entries;
    expect(refused.map((e) => e.actor.type)).toEqual(['anonymous', 'token', 'anonymous', 'anonymous']);
    expect(refused[0]).toMatchObject({ actor: { claimedToken: made.view.id }, request: { status: 401 } });
    expect(refused[1]).toMatchObject({ actor: { tokenId: made.view.id, name: 'Claude Code on my-server', scopes: ['read', 'imports'] }, request: { path: '/api/records', status: 403 } });
    expect(refused[1]!.request?.error).toContain('"records" scope');
    expect(refused[2]).toMatchObject({ request: { method: 'PUT', path: '/api/settings', status: 401 } });
    expect(refused[3]).toMatchObject({ category: 'auth', action: 'auth.sign-in', summary: 'Sign-in refused: wrong username or password' });
    // A password typed in is never kept.
    const raw = await readFile(path.join(dir, 'work', 'audit', `${refused[0]!.at.slice(0, 7)}.jsonl`), 'utf8');
    expect(raw).not.toContain('correct horse');
    expect(raw).not.toContain(made.token);
  });

  it('tokens made and revoked, settings changed field by field', async () => {
    const cookie = await signIn();
    const json = { ...CSRF, cookie, 'content-type': 'application/json' };
    const made = (await (await req('/api/tokens', { method: 'POST', headers: json, body: JSON.stringify({ name: 'script', scopes: ['jobs'], days: 7 }) })).json()) as { view: { id: string } };
    await req(`/api/tokens/${made.view.id}/revoke`, { method: 'POST', headers: json });
    const settings = app.ctx.store.settings;
    await req('/api/settings', { method: 'PUT', headers: json, body: JSON.stringify({ ...settings, git: { ...settings.git, trackDocuments: !settings.git.trackDocuments } }) });

    const all = (await audit(cookie, '?all=1')).entries;
    expect(all.find((e) => e.action === 'token.create')).toMatchObject({ actor: { type: 'owner' }, details: { name: 'script', scopes: ['read', 'jobs'] } });
    expect(all.find((e) => e.action === 'token.revoke')).toMatchObject({ targets: [made.view.id] });
    expect(all.find((e) => e.action === 'data.change' && e.paths?.includes('settings.json'))?.diff?.fields).toEqual({ 'git.trackDocuments': [settings.git.trackDocuments, !settings.git.trackDocuments] });
  });

  it('a job’s writes are the job’s, and a file changed outside the app is said to be', async () => {
    const job = { type: 'job', jobId: 'job_test', kind: 'monthly-review', trigger: 'schedule' } as const;
    await runAs(job, () => app.ctx.store.setRules([], 'rules: cleared by a job'));
    const store = app.ctx.store as unknown as { pendingPaths: Set<string>; checkExternalChanges(): Promise<void> };
    await writeFile(path.join(dir, 'data', 'goals.json'), '{"goals":[]}\n');
    store.pendingPaths.add('goals.json');
    await store.checkExternalChanges();

    const cookie = await signIn();
    const all = (await audit(cookie, '?all=1')).entries;
    expect(all.find((e) => e.summary === 'rules: cleared by a job')?.actor).toEqual(job);
    expect(all.find((e) => e.action === 'data.external')).toMatchObject({ actor: { type: 'outside' }, paths: ['goals.json'] });
  });

  it('closing the app says so, and the next start carries the same chain on', async () => {
    await app.close();
    const env = { FINANCE_USERNAME: 'james', FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_SESSION_SECRET: 'x'.repeat(40) };
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test', ...env });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env, inbox: false });
    const cookie = await signIn();
    expect((await audit(cookie)).entries.map((e) => e.action)).toEqual(['auth.sign-in', 'app.start', 'app.stop', 'app.start']);
    expect(((await (await req('/api/audit/verify', { headers: { cookie } })).json()) as AuditVerifyResponse).ok).toBe(true);
  });
});
