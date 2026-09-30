// Agent access tokens (src/server/tokens.ts; docs/DEPLOY.md, "Agent access"): how a token is kept,
// what it can and cannot do, and that every use is logged. No test here starts a job: one that ran
// would spend the owner's Claude plan.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';
import { AgentTokens, requiredScope, type TokenScope } from '../src/server/tokens';

const CSRF = { 'x-finance-csrf': '1' };

describe('the token store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-tokens-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps only a hash, readable by you alone, and always lets a token read', async () => {
    const tokens = AgentTokens.forWorkDir(dir);
    await tokens.load();
    const made = await tokens.create({ name: 'Claude Code on P360', scopes: ['imports'], days: 30 });
    expect(made.token).toMatch(/^fin_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const file = path.join(dir, 'agent-tokens.json');
    expect(await readFile(file, 'utf8')).not.toContain(made.token.slice(17));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(made.view).toMatchObject({ name: 'Claude Code on P360', scopes: ['read', 'imports'], status: 'active' });
    expect(made.view).not.toHaveProperty('hash');
  });

  it('a token works until it expires or is revoked, across restarts; a changed one never does', async () => {
    const tokens = AgentTokens.forWorkDir(dir);
    await tokens.load();
    const at = new Date('2026-09-29T12:00:00Z');
    const made = await tokens.create({ name: 'script', scopes: [], days: 7 }, at);
    expect(tokens.verify(made.token, Date.parse('2026-10-01T00:00:00Z'))?.id).toBe(made.view.id);
    expect(tokens.verify(made.token, Date.parse('2026-10-07T00:00:00Z'))).toBeUndefined();
    const last = made.token.at(-1) === 'A' ? 'B' : 'A';
    expect(tokens.verify(`${made.token.slice(0, -1)}${last}`, Date.parse('2026-10-01T00:00:00Z'))).toBeUndefined();
    expect(tokens.verify('fin_000000000000_' + 'A'.repeat(43), Date.parse('2026-10-01T00:00:00Z'))).toBeUndefined();

    const reloaded = AgentTokens.forWorkDir(dir);
    await reloaded.load();
    expect(reloaded.verify(made.token, Date.parse('2026-10-01T00:00:00Z'))?.name).toBe('script');
    expect(await reloaded.revoke(made.view.id)).toBe(true);
    expect(reloaded.verify(made.token, Date.parse('2026-10-01T00:00:00Z'))).toBeUndefined();
    expect(reloaded.list(Date.parse('2026-10-01T00:00:00Z'))[0]!.status).toBe('revoked');
  });

  it('opens only the listed routes to changes; tokens and sign-in never', () => {
    const cases: [string, string, TokenScope | null][] = [
      ['GET', '/api/summary', 'read'],
      ['GET', '/api/imports/imp_20260929_220730_9e18', 'read'],
      ['POST', '/api/imports/imp_20260929_220730_9e18/refresh', 'imports'],
      ['POST', '/api/imports/imp_20260929_220730_9e18/reprocess', 'imports'],
      ['POST', '/api/imports/imp_20260929_220730_9e18/hint', 'imports'],
      ['PUT', '/api/imports/imp_20260929_220730_9e18/draft', 'imports'],
      ['POST', '/api/imports/imp_20260929_220730_9e18/commit', null],
      ['POST', '/api/imports/imp_20260929_220730_9e18/dismiss', null],
      ['DELETE', '/api/imports/imp_20260929_220730_9e18', null],
      ['POST', '/api/imports/commit-ready', null],
      ['POST', '/api/imports', null],
      ['POST', '/api/records', 'records'],
      // An agent proposes a fix or takes it back; applying, dismissing and checking are the owner's.
      ['POST', '/api/proposals', 'records'],
      ['DELETE', '/api/proposals/prop_20260930_170000_ab12', 'records'],
      ['POST', '/api/proposals/prop_20260930_170000_ab12/apply', null],
      ['POST', '/api/proposals/prop_20260930_170000_ab12/dismiss', null],
      ['POST', '/api/proposals/prop_20260930_170000_ab12/check', null],
      ['POST', '/api/jobs', 'jobs'],
      ['POST', '/api/jobs/job_abc123/rerun', 'jobs'],
      ['PATCH', '/api/transactions/tx_0123456789abcdef', null],
      ['PUT', '/api/settings', null],
      ['POST', '/api/accounts', null],
      ['GET', '/api/tokens', null],
      ['POST', '/api/tokens', null],
      ['POST', '/api/auth/logout', null],
    ];
    for (const [method, p, scope] of cases) expect(requiredScope(method, p), `${method} ${p}`).toBe(scope);
  });
});

describe('the API with a token', () => {
  let app: App;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-tokens-api-'));
    const env = { FINANCE_USERNAME: 'james', FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_SESSION_SECRET: 'x'.repeat(40) };
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test', ...env });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env, inbox: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) =>
    app.app.request(`http://finance.example.test${p}`, { ...init, headers: { host: 'finance.example.test', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https', ...(init.headers ?? {}) } });
  const token = async (scopes: TokenScope[]) => `Bearer ${(await app.ctx.tokens.create({ name: `agent ${scopes.join('+') || 'read'}`, scopes, days: 30 })).token}`;
  const signIn = async () => {
    const res = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('reads with no session, and nothing without a valid token', async () => {
    const authorization = await token([]);
    expect((await req('/api/summary', { headers: { authorization } })).status).toBe(200);
    expect((await req('/api/imports', { headers: { authorization } })).status).toBe(200);
    expect((await req('/api/summary', { headers: { authorization: 'Bearer fin_000000000000_' + 'A'.repeat(43) } })).status).toBe(401);
    expect((await req('/api/summary', { headers: { authorization: 'Basic amFtZXM6eA==' } })).status).toBe(401);
  });

  it('a request with a token is judged by the token alone: your session cookie adds nothing', async () => {
    const cookie = await signIn();
    expect((await req('/api/summary', { headers: { cookie } })).status).toBe(200);
    expect((await req('/api/summary', { headers: { cookie, authorization: 'Bearer nonsense' } })).status).toBe(401);
    const authorization = await token([]);
    const refused = await req('/api/settings', { method: 'PUT', headers: { ...CSRF, cookie, authorization, 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
  });

  it('changes only what its scopes allow, and never what is yours to do', async () => {
    const reader = await token([]);
    const upkeep = await token(['imports']);
    const post = (p: string, authorization: string, body = '{}', method = 'POST') => req(p, { method, headers: { ...CSRF, authorization, 'content-type': 'application/json' }, body });
    const refused = await post('/api/records', reader);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('This token may not do that: it needs the "records" scope.');
    // Past the gate, the route answers: there is no such import.
    expect((await post('/api/imports/imp_20260929_220730_9e18/refresh', upkeep)).status).toBe(404);
    for (const [p, method] of [['/api/imports/imp_20260929_220730_9e18/commit', 'POST'], ['/api/imports/imp_20260929_220730_9e18/dismiss', 'POST'], ['/api/imports/commit-ready', 'POST'], ['/api/imports/imp_20260929_220730_9e18', 'DELETE'], ['/api/transactions/tx_0123456789abcdef', 'PATCH'], ['/api/tokens', 'POST']] as const) {
      const res = await post(p, await token(['imports', 'records', 'jobs']), '{}', method);
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('No token may do that: it is yours to do in the app.');
    }
    expect((await req('/api/tokens', { headers: { authorization: reader } })).status).toBe(403);
  });

  it('still needs the CSRF header to change anything', async () => {
    const authorization = await token(['imports']);
    const res = await req('/api/imports/imp_20260929_220730_9e18/refresh', { method: 'POST', headers: { authorization } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Missing CSRF header');
  });

  it('cannot start a job while agents are off; you still can', async () => {
    const { store, runner } = app.ctx;
    await store.setSettings({ ...store.settings, agents: { ...store.settings.agents, enabled: false } });
    const authorization = await token(['jobs']);
    const res = await req('/api/jobs', { method: 'POST', headers: { ...CSRF, authorization, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'research-provider', params: {} }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('Agents are turned off in Settings, so an agent cannot start a job.');
    expect(runner!.list()).toEqual([]);
  });

  it('you make and revoke tokens with your session; every use is logged, refusals too', async () => {
    const cookie = await signIn();
    const made = await req('/api/tokens', { method: 'POST', headers: { ...CSRF, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Claude Code on P360', scopes: ['imports'], days: 90 }) });
    expect(made.status).toBe(201);
    const { token: secret, view } = (await made.json()) as { token: string; view: { id: string; scopes: string[] } };
    expect(view.scopes).toEqual(['read', 'imports']);
    const authorization = `Bearer ${secret}`;
    expect((await req('/api/summary', { headers: { authorization } })).status).toBe(200);
    expect((await req('/api/records', { method: 'POST', headers: { ...CSRF, authorization, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const listed = (await (await req('/api/tokens', { headers: { cookie } })).json()) as { tokens: { id: string; lastUsedFrom?: string }[]; uses: { path: string; status: number; from: string }[] };
    expect(JSON.stringify(listed)).not.toContain(secret.slice(17));
    expect(listed.tokens[0]).toMatchObject({ id: view.id, lastUsedFrom: '100.64.0.2' });
    expect(listed.uses.map((u) => `${u.status} ${u.path}`)).toEqual(['403 /api/records', '200 /api/summary']);
    expect((await req(`/api/tokens/${view.id}/revoke`, { method: 'POST', headers: { ...CSRF, cookie } })).status).toBe(200);
    expect((await req('/api/summary', { headers: { authorization } })).status).toBe(401);
  });
});
