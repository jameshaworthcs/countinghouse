import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';
import { oidcSettingsFromEnv } from '../src/server/oidc';
import { safeNext } from '../src/server/routes/auth';
import { startMockIdp, type MockIdp } from './mock-idp';

const HOST = 'finance.example.test';
const REDIRECT = `https://${HOST}/api/auth/oidc/callback`;
const CSRF = { 'x-finance-csrf': '1' };

describe('OIDC settings', () => {
  const base = { FINANCE_USERNAME: 'james', FINANCE_OIDC_ISSUER: 'https://auth.example.com/', FINANCE_OIDC_CLIENT_ID: 'finance', FINANCE_OIDC_CLIENT_SECRET: 's3cret', FINANCE_OIDC_ALLOWED_EMAILS: ' James@EXAMPLE.com , ' };

  it('is off without a client id, and derives the rest from the allowed host', () => {
    expect(oidcSettingsFromEnv({}, [HOST])).toBeNull();
    expect(oidcSettingsFromEnv(base, [HOST])).toEqual({
      issuer: 'https://auth.example.com',
      name: 'auth.example.com',
      clientId: 'finance',
      clientSecret: 's3cret',
      redirectUri: REDIRECT,
      allowedEmails: ['james@example.com'],
    });
  });

  it('names the provider as you say, else by its host', () => {
    expect(oidcSettingsFromEnv({ ...base, FINANCE_OIDC_NAME: ' Example ID ' }, [HOST])!.name).toBe('Example ID');
  });

  it('fails closed when half configured', () => {
    // No issuer is assumed: whoever runs it names their own provider.
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_ISSUER: '' }, [HOST])).toThrow(/FINANCE_OIDC_ISSUER/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_ISSUER: 'http://auth.example.com' }, [HOST])).toThrow(/https/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_ISSUER: 'not a url' }, [HOST])).toThrow(/URL/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_CLIENT_SECRET: '' }, [HOST])).toThrow(/FINANCE_OIDC_CLIENT_SECRET/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_ALLOWED_EMAILS: ' , ' }, [HOST])).toThrow(/FINANCE_OIDC_ALLOWED_EMAILS/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_USERNAME: '' }, [HOST])).toThrow(/FINANCE_USERNAME/);
    expect(() => oidcSettingsFromEnv(base, [])).toThrow(/REDIRECT_URI/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_REDIRECT_URI: `http://${HOST}/api/auth/oidc/callback` }, [HOST])).toThrow(/https/);
    expect(() => oidcSettingsFromEnv({ ...base, FINANCE_OIDC_REDIRECT_URI: `https://${HOST}/callback` }, [HOST])).toThrow(/must end in/);
  });

  it('only follows on to a path on this site', () => {
    expect(safeNext('/accounts?x=1')).toBe('/accounts?x=1');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/api/summary']) expect(safeNext(bad)).toBe('/');
  });
});

describe('sign-in with an OIDC provider', () => {
  let idp: MockIdp;
  let app: App;
  let dir: string;

  beforeAll(async () => {
    idp = await startMockIdp({ redirectUri: REDIRECT });
  });
  afterAll(async () => {
    await idp.close();
  });

  async function makeApp(extra: Record<string, string> = {}): Promise<App> {
    const env = {
      FINANCE_USERNAME: 'james',
      FINANCE_SESSION_SECRET: 'x'.repeat(40),
      FINANCE_OIDC_ISSUER: idp.issuer,
      FINANCE_OIDC_CLIENT_ID: idp.clientId,
      FINANCE_OIDC_CLIENT_SECRET: idp.clientSecret,
      FINANCE_OIDC_ALLOWED_EMAILS: 'james@example.com',
      ...extra,
    };
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: HOST });
    config.webDist = path.join(dir, 'no-web');
    return createApp(config, { version: 'test', env, inbox: false });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-oidc-'));
    idp.user = { sub: 'user-1', email: 'james@example.com', email_verified: true };
    idp.denyWith = null;
    idp.emailOnlyInUserinfo = false;
    idp.requests = [];
    app = await makeApp();
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  // As Caddy forwards it: over https, from a tailnet address.
  const req = (p: string, init: RequestInit = {}) =>
    app.app.request(`http://${HOST}${p}`, { ...init, headers: { host: HOST, 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https', ...(init.headers ?? {}) } });
  const cookieOf = (res: Response, name: string) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0];

  /** Start at /api/auth/oidc/login and go round the provider; returns the callback's response. */
  async function signIn(next = '/accounts'): Promise<{ res: Response; flowCookie: string; callback: string }> {
    const start = await req(`/api/auth/oidc/login?next=${encodeURIComponent(next)}`);
    expect(start.status).toBe(302);
    const flowCookie = cookieOf(start, 'finance_oidc')!;
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    const res = await req(callback.pathname + callback.search, { headers: { cookie: flowCookie } });
    return { res, flowCookie, callback: callback.pathname + callback.search };
  }

  it('reports the method, and refuses password sign-in even with a password configured', async () => {
    await app.close();
    app = await makeApp({ FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_OIDC_NAME: 'Example ID' });
    const status = (await (await req('/api/auth/status')).json()) as { configured: boolean; method: string; provider: string | null; user: string | null };
    expect(status).toMatchObject({ configured: true, method: 'oidc', provider: 'Example ID', user: null });
    const res = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Password sign-in is off. Sign in with Example ID.');
    expect(cookieOf(res, 'finance_session')).toBeUndefined();
  });

  it('sends a signed-out page load to the provider, but not the API, files or /login', async () => {
    const page = await req('/accounts?tab=1');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(`/api/auth/oidc/login?next=${encodeURIComponent('/accounts?tab=1')}`);
    expect((await req('/')).headers.get('location')).toBe('/api/auth/oidc/login?next=%2F');
    expect((await req('/login?error=not_allowed')).status).toBe(200);
    expect((await req('/favicon.svg')).status).not.toBe(302);
    expect((await req('/api/summary')).status).toBe(401);
  });

  it('asks for the code flow with PKCE, state and nonce, in a Lax, HttpOnly, Secure flow cookie', async () => {
    const start = await req('/api/auth/oidc/login?next=/spending');
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/oauth/authorize`);
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(idp.clientId);
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('scope')).toBe('openid profile email');
    expect(p.get('code_challenge_method')).toBe('S256');
    for (const k of ['code_challenge', 'state', 'nonce']) expect(p.get(k)?.length).toBeGreaterThanOrEqual(20);
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith('finance_oidc='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth\/oidc/);
  });

  it('signs the allowed address in as the one user, and moves on with a same-site page', async () => {
    const { res } = await signIn('/accounts?tab=1');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="0;url=/accounts?tab=1"');
    const session = cookieOf(res, 'finance_session')!;
    expect(session).toBeTruthy();
    expect(res.headers.getSetCookie().find((c) => c.startsWith('finance_session='))).toMatch(/SameSite=Strict/);
    // The flow cookie is used up.
    expect(res.headers.getSetCookie().find((c) => c.startsWith('finance_oidc='))).toMatch(/Max-Age=0/);
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(200);
    const status = (await (await req('/api/auth/status', { headers: { cookie: session } })).json()) as { user: string };
    expect(status.user).toBe('james');
    expect((await req('/accounts', { headers: { cookie: session } })).status).not.toBe(302);
  });

  it('matches the address whatever its case, and asks userinfo when the ID token has none', async () => {
    idp.user = { sub: 'user-1', email: 'James@Example.COM', email_verified: true };
    idp.emailOnlyInUserinfo = true;
    const { res } = await signIn();
    expect(res.status).toBe(200);
    expect(cookieOf(res, 'finance_session')).toBeTruthy();
  });

  it('refuses any other address, and an unverified one', async () => {
    for (const user of [
      { sub: 'user-2', email: 'someone@example.com', email_verified: true },
      { sub: 'user-3', email: 'james@example.com', email_verified: false },
      { sub: 'user-4' },
    ]) {
      idp.user = user;
      const { res } = await signIn();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=not_allowed');
      expect(cookieOf(res, 'finance_session')).toBeUndefined();
    }
  });

  it('explains a refusal at the provider without echoing its text', async () => {
    idp.denyWith = 'access_denied';
    const { res } = await signIn();
    expect(res.headers.get('location')).toBe('/login?error=idp_denied');
  });

  it('refuses a callback without its flow cookie, a replayed one, and a swapped state', async () => {
    const { callback, flowCookie } = await signIn();
    // Replayed: the code is spent and the cookie cleared in the browser; without the cookie it is refused.
    expect((await req(callback)).headers.get('location')).toBe('/login?error=flow_expired');
    // Replayed with the old cookie: the provider refuses the spent code.
    expect((await req(callback, { headers: { cookie: flowCookie } })).headers.get('location')).toBe('/login?error=invalid_response');
    // A forged flow cookie is not accepted.
    expect((await req(callback, { headers: { cookie: `${flowCookie}x` } })).headers.get('location')).toBe('/login?error=flow_expired');

    // A code from another sign-in (someone else's state) against this browser's flow.
    const mine = await req('/api/auth/oidc/login?next=/');
    const theirs = await req('/api/auth/oidc/login?next=/');
    const authorize = await fetch(theirs.headers.get('location')!, { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    const res = await req(cb.pathname + cb.search, { headers: { cookie: cookieOf(mine, 'finance_oidc')! } });
    expect(res.headers.get('location')).toBe('/login?error=invalid_response');
    expect(cookieOf(res, 'finance_session')).toBeUndefined();
  });

  it('signs sessions out when the allowed addresses change', async () => {
    const session = cookieOf((await signIn()).res, 'finance_session')!;
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(200);
    await app.close();
    app = await makeApp({ FINANCE_OIDC_ALLOWED_EMAILS: 'someone@example.com' });
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(401);
  });

  it('does not accept a session from password sign-in', async () => {
    await app.close();
    app = await makeApp({ FINANCE_OIDC_CLIENT_ID: '', FINANCE_PASSWORD_HASH: await hashPassword('correct horse') });
    const login = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    const session = cookieOf(login, 'finance_session')!;
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(200);
    await app.close();
    app = await makeApp({ FINANCE_PASSWORD_HASH: await hashPassword('correct horse') });
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(401);
  });

  it('sends you back to sign in, not an error page, when the provider is unreachable', async () => {
    await app.close();
    app = await makeApp({ FINANCE_OIDC_ISSUER: 'http://127.0.0.1:1' });
    const res = await req('/api/auth/oidc/login?next=/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=idp_unreachable');
  });
});
