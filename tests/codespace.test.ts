// The demo in a GitHub codespace (FINANCE_DEMO_CODESPACE): a throwaway login shown on the sign-in
// form, and the Origin GitHub's proxy writes accepted, only ever over untracked demo data.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
// What the app sees through Codespaces' port forwarding (seen in a real codespace): a loopback peer,
// Host rewritten to localhost, the public host in X-Forwarded-Host, and the page's own Origin
// rewritten to http://localhost:<port>.
const PUBLIC_HOST = 'example-codespace-4770.app.github.dev';
const FORWARDED = { host: 'localhost:4770', 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' };
const PROXY_ORIGIN = 'http://localhost:4770';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-codespace-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function open(env: Record<string, string>, dataName = 'demo-data'): Promise<App> {
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, dataName), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_INBOX_DIR: path.join(dir, 'inbox'), FINANCE_WATCH: '0', ...env });
  config.webDist = path.join(dir, 'no-web');
  return createApp(config, { version: 'test', env, inbox: false });
}

/** The data made first, as `npm run demo` does before serving. */
async function demoData(dataName = 'demo-data'): Promise<void> {
  await (await open({}, dataName)).close();
}

const send = (app: App, p: string, headers: Record<string, string>, body?: unknown) =>
  app.app.request(`http://${headers.host ?? 'localhost'}${p}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

interface Status {
  configured: boolean;
  method: string | null;
  demoLogin: { username: string; password: string } | null;
}

describe('FINANCE_DEMO_CODESPACE is refused', () => {
  it('over data not generated yet', async () => {
    await expect(open({ FINANCE_DEMO_CODESPACE: '1' })).rejects.toThrow(/generated first/);
  });

  it('over a data directory not named as a demo', async () => {
    await demoData('data');
    await expect(open({ FINANCE_DEMO_CODESPACE: '1' }, 'data')).rejects.toThrow(/not a demo directory/);
  });

  it('over data tracked in git, even one called demo', async () => {
    await demoData();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await expect(open({ FINANCE_DEMO_CODESPACE: '1' })).rejects.toThrow(/tracked in git/);
  });

  it('beside a login of its own, so no real credential could ever be shown', async () => {
    await demoData();
    const hash = await hashPassword('an-invented-password');
    await expect(open({ FINANCE_DEMO_CODESPACE: '1', FINANCE_USERNAME: 'someone', FINANCE_PASSWORD_HASH: hash })).rejects.toThrow(/makes its own throwaway login/);
    await expect(open({ FINANCE_DEMO_CODESPACE: '1', FINANCE_PASSWORD_HASH: hash })).rejects.toThrow(/makes its own throwaway login/);
    await expect(open({ FINANCE_DEMO_CODESPACE: '1', FINANCE_OIDC_CLIENT_ID: 'client' })).rejects.toThrow(/makes its own throwaway login|OIDC/);
  });
});

describe('the sign-in hint', () => {
  it('is never sent without the setting', async () => {
    await demoData();
    const app = await open({ FINANCE_USERNAME: 'demo', FINANCE_PASSWORD_HASH: await hashPassword('an-invented-password') });
    try {
      const status = (await (await send(app, '/api/auth/status', FORWARDED)).json()) as Status;
      expect(status.method).toBe('password');
      expect(status.demoLogin).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('carries a fresh throwaway login, and never its hash', async () => {
    await demoData();
    const first = await open({ FINANCE_DEMO_CODESPACE: '1' });
    let password: string;
    try {
      const res = await send(first, '/api/auth/status', FORWARDED);
      const text = await res.text();
      expect(text).not.toMatch(/scrypt/);
      const status = JSON.parse(text) as Status;
      expect(status.method).toBe('password');
      expect(status.demoLogin?.username).toBe('demo');
      password = status.demoLogin!.password;
      expect(password.length).toBeGreaterThanOrEqual(12);
    } finally {
      await first.close();
    }
    // Each start makes a new one.
    const second = await open({ FINANCE_DEMO_CODESPACE: '1' });
    try {
      const status = (await (await send(second, '/api/auth/status', FORWARDED)).json()) as Status;
      expect(status.demoLogin?.password).not.toBe(password);
    } finally {
      await second.close();
    }
  });
});

describe('signing in through the Codespaces proxy', () => {
  it('works with the setting: the proxy’s Origin is accepted and the cookie is Secure', async () => {
    await demoData();
    const app = await open({ FINANCE_DEMO_CODESPACE: '1' });
    try {
      const { demoLogin } = (await (await send(app, '/api/auth/status', FORWARDED)).json()) as Status;
      expect((await send(app, '/api/summary', FORWARDED)).status).toBe(401);
      const wrong = await send(app, '/api/auth/login', { ...FORWARDED, ...CSRF, origin: PROXY_ORIGIN }, { username: 'demo', password: 'not-it' });
      expect(wrong.status).toBe(401);
      const res = await send(app, '/api/auth/login', { ...FORWARDED, ...CSRF, origin: PROXY_ORIGIN }, demoLogin);
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/Secure/);
      const session = cookie.split(';')[0]!;
      expect((await send(app, '/api/summary', { ...FORWARDED, cookie: session })).status).toBe(200);
      // A change made from the page, with the Origin the proxy writes.
      const change = await send(app, '/api/auth/logout', { ...FORWARDED, ...CSRF, origin: PROXY_ORIGIN, cookie: session }, {});
      expect(change.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('still refuses other origins, a missing CSRF header and other hosts', async () => {
    await demoData();
    const app = await open({ FINANCE_DEMO_CODESPACE: '1', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
    try {
      const { demoLogin } = (await (await send(app, '/api/auth/status', FORWARDED)).json()) as Status;
      const login = (headers: Record<string, string>) => send(app, '/api/auth/login', headers, demoLogin);
      // The proxy passes a foreign Origin through unchanged.
      expect((await login({ ...FORWARDED, ...CSRF, origin: 'https://evil.example' })).status).toBe(403);
      expect((await login({ ...FORWARDED, ...CSRF, origin: 'http://localhost:9999' })).status).toBe(403);
      expect((await login({ ...FORWARDED, ...CSRF, origin: 'https://localhost:4770' })).status).toBe(403);
      expect((await login({ ...FORWARDED, 'content-type': 'application/json', origin: PROXY_ORIGIN })).status).toBe(403);
      // Only for a loopback Host: an Origin that merely repeats any other Host is still refused.
      expect((await login({ ...FORWARDED, ...CSRF, host: 'finance.example.test', origin: 'http://finance.example.test' })).status).toBe(403);
      // The public host itself is still not on the Host allow-list: the proxy never sends it as Host.
      expect((await send(app, '/api/health', { host: PUBLIC_HOST })).status).toBe(421);
      // The page's own public Origin, were the proxy ever to leave it alone, matches X-Forwarded-Host.
      expect((await login({ ...FORWARDED, ...CSRF, origin: `https://${PUBLIC_HOST}` })).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('is refused without the setting: the proxy’s Origin is not accepted', async () => {
    await demoData();
    const app = await open({ FINANCE_USERNAME: 'demo', FINANCE_PASSWORD_HASH: await hashPassword('an-invented-password') });
    try {
      const res = await send(app, '/api/auth/login', { ...FORWARDED, ...CSRF, origin: PROXY_ORIGIN }, { username: 'demo', password: 'an-invented-password' });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
