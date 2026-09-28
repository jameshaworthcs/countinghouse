import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';

const CSRF = { 'x-finance-csrf': '1' };

async function makeApp(env: Record<string, string> = {}): Promise<{ app: App; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-api-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test', ...env });
  config.webDist = path.join(dir, 'no-web');
  const app = await createApp(config, { version: 'test', env, inbox: false });
  return { app, dir };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('API without login configured', () => {
  let ctx: { app: App; dir: string };
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}, host = 'localhost') =>
    ctx.app.app.request(`http://${host}${p}`, { ...init, headers: { host, ...(init.headers ?? {}) } });

  it('guards Host headers and CSRF', async () => {
    expect((await req('/api/health', {}, 'evil.example.com')).status).toBe(421);
    expect((await req('/api/health')).status).toBe(200);
    expect((await req('/api/accounts', { method: 'POST', body: '{}' })).status).toBe(403);
    const cross = await req('/api/accounts', { method: 'POST', headers: { ...CSRF, origin: 'https://evil.example.com', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', type: 'current' }) });
    expect(cross.status).toBe(403);
  });

  it('refuses proxied or remote requests when no login is configured', async () => {
    const res = await req('/api/summary', { headers: { 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https' } }, 'finance.example.test');
    expect(res.status).toBe(403);
  });

  it('imports a CSV end to end: upload → draft → commit → summary', async () => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv'))]), 'starling.csv');
    const up = await req('/api/imports', { method: 'POST', headers: CSRF, body: form });
    expect(up.status).toBe(201);
    const { results } = (await up.json()) as { results: { id: string }[] };
    const id = results[0]!.id;
    const record = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${id}`)).json()) as { status: string; draft?: { sections: { target: { mode: string }; balance?: number }[] } };
      return r.status === 'review' ? r : undefined;
    });
    expect(record.draft!.sections[0]!.target.mode).toBe('new');
    expect(record.draft!.sections[0]!.balance).toBe(2927.66);

    const commit = await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF });
    expect(commit.status).toBe(200);
    const summary = (await (await req('/api/summary')).json()) as { estate: { value: number }; accounts: { id: string; balance: number }[] };
    expect(summary.estate.value).toBe(2927.66);
    expect(summary.accounts[0]!.balance).toBe(2927.66);

    // The same file again is recognised as already imported.
    const again = new FormData();
    again.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv'))]), 'starling-copy.csv');
    const dup = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: again })).json()) as { results: { duplicateOf?: { id: string } }[] };
    expect(dup.results[0]!.duplicateOf?.id).toBe(id);

    const txs = (await (await req('/api/transactions?q=tesco')).json()) as { total: number; items: { category?: string; id: string }[] };
    expect(txs.total).toBe(1);
    expect(txs.items[0]!.category).toBe('groceries');
    const patched = await req(`/api/transactions/${txs.items[0]!.id}`, { method: 'PATCH', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ category: 'home-garden', notes: 'bulbs' }) });
    const edited = (await patched.json()) as { categorisedBy: string; payeeSetBy?: string; amount: number };
    expect(edited.categorisedBy).toBe('user');
    // Saving a note without touching the payee does not lock the payee.
    expect(edited.payeeSetBy).toBeUndefined();

    // Correcting a misread amount keeps what the document said.
    const before = edited.amount;
    const corrected = await req(`/api/transactions/${txs.items[0]!.id}`, { method: 'PATCH', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ amount: before - 1, correctionNote: 'scan misread' }) });
    const fixed = (await corrected.json()) as { amount: number; corrections: { field: string; from: number; to: number; note?: string }[] };
    expect(fixed.amount).toBe(before - 1);
    expect(fixed.corrections).toEqual([expect.objectContaining({ field: 'amount', from: before, to: before - 1, note: 'scan misread' })]);
  });

  it('asks for a column mapping when a CSV layout is unknown', async () => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/unknown.csv'))]), 'unknown.csv');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    const rec = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${results[0]!.id}`)).json()) as { status: string; mapping?: { profile: unknown } };
      return r.status === 'needs_mapping' ? r : undefined;
    });
    const mapped = await req(`/api/imports/${results[0]!.id}/mapping`, {
      method: 'POST',
      headers: { ...CSRF, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: rec.mapping!.profile, saveAs: 'My Credit Union' }),
    });
    expect(((await mapped.json()) as { status: string }).status).toBe('review');
    const profiles = (await (await req('/api/csv-profiles')).json()) as { name: string }[];
    expect(profiles.map((p) => p.name)).toContain('My Credit Union');
  });
});

describe('API with login configured', () => {
  let ctx: { app: App; dir: string };
  beforeEach(async () => {
    ctx = await makeApp({ FINANCE_USERNAME: 'james', FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_SESSION_SECRET: 'x'.repeat(40) });
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) =>
    ctx.app.app.request(`http://finance.example.test${p}`, {
      ...init,
      headers: { host: 'finance.example.test', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https', ...(init.headers ?? {}) },
    });

  it('requires a session and issues a secure, HttpOnly cookie on login', async () => {
    expect((await req('/api/summary')).status).toBe(401);
    const bad = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'nope' }) });
    expect(bad.status).toBe(401);
    const good = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie')!;
    expect(cookie).toMatch(/finance_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(';')[0]!;
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(200);
    expect((await req('/api/summary', { headers: { cookie: `${session}x` } })).status).toBe(401);
  });

  it('throttles repeated failures', async () => {
    for (let i = 0; i < 10; i++) {
      await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: `x${i}` }) });
    }
    const res = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    expect(res.status).toBe(429);
  }, 30_000);
});
