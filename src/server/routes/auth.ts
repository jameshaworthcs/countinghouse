import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AuditActor, AuditOutcome } from '../../shared/audit';
import { whoFrom } from '../audit';
import { readJson, type AppContext } from '../context';
import { OidcError, type OidcFlow } from '../oidc';
import { clientAddress, isDirectLocal, isHttps } from '../security';

const FLOW_COOKIE = 'finance_oidc';
const FLOW_PATH = '/api/auth/oidc';
const FLOW_SECONDS = 10 * 60;

/** Only a path on this site, and not an API call: anything else becomes "/". */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/api/')) return '/';
  return next;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** Signing in and out, refused attempts too, go in the audit log with where they came from. */
  const audit = async (c: Context, action: string, outcome: AuditOutcome, summary: string, user: string | null, details: Record<string, unknown> = {}) => {
    const who = await whoFrom(c, ctx.devices);
    const actor: AuditActor = user ? { type: 'owner', user, via: 'session', ...who } : { type: 'anonymous', ...who };
    ctx.audit.record({ category: 'auth', action, outcome, actor, summary, details });
  };

  app.get('/status', (c) => {
    const session = ctx.auth.sessionFrom(c);
    return c.json({
      configured: ctx.auth.configured,
      method: ctx.auth.method,
      user: session?.user ?? null,
      // Without configured credentials only direct local access works.
      localAccess: !ctx.auth.configured && isDirectLocal(c),
    });
  });

  app.post('/login', async (c) => {
    const body = await readJson(c, z.object({ username: z.string().max(200), password: z.string().max(500) }));
    const result = await ctx.auth.login(body.username.trim(), body.password, clientAddress(c));
    if (result === 'ok') {
      ctx.auth.setSessionCookie(c, body.username.trim(), isHttps(c));
      await audit(c, 'auth.sign-in', 'ok', 'Signed in with the password', body.username.trim(), { method: 'password' });
      return c.json({ ok: true, user: body.username.trim() });
    }
    const why = { 'use-oidc': 'password sign-in is off', throttled: 'too many attempts', 'not-configured': 'no login is configured', invalid: 'wrong username or password' }[result] ?? result;
    await audit(c, 'auth.sign-in', 'refused', `Sign-in refused: ${why}`, null, { method: 'password', reason: result });
    if (result === 'use-oidc') return c.json({ error: 'Password sign-in is off. Sign in with JEMEDIA.', code: 'use_oidc' }, 403);
    // A small constant delay blunts guessing and timing differences.
    await new Promise((r) => setTimeout(r, 400));
    if (result === 'throttled') return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    if (result === 'not-configured') return c.json({ error: 'Login is not configured on this server.' }, 403);
    return c.json({ error: 'Wrong username or password.' }, 401);
  });

  app.post('/logout', async (c) => {
    const user = ctx.auth.sessionFrom(c)?.user;
    if (user) await audit(c, 'auth.sign-out', 'ok', 'Signed out', user);
    ctx.auth.clearSessionCookie(c, isHttps(c));
    return c.json({ ok: true });
  });

  // jemedia-auth. Both are top-level browser navigations, so they answer with redirects, and every
  // failure lands on the sign-in page with a short code it explains (never the provider's own text).
  const fail = (c: Context, code: string) => c.redirect(`/login?error=${code}`, 302);

  app.get('/oidc/login', async (c) => {
    const oidc = ctx.oidc;
    if (!oidc) return c.json({ error: 'Not found' }, 404);
    try {
      const { url, flow } = await oidc.start(safeNext(c.req.query('next')));
      // Lax, not Strict: the callback arrives as a navigation from auth.jemedia.xyz, and a Strict
      // cookie would not be sent with it.
      setCookie(c, FLOW_COOKIE, ctx.auth.seal(flow, FLOW_SECONDS), { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: FLOW_PATH, maxAge: FLOW_SECONDS });
      return c.redirect(url, 302);
    } catch (err) {
      console.error(`[auth] ${(err as Error).message}`);
      return fail(c, err instanceof OidcError ? err.code : 'idp_unreachable');
    }
  });

  app.get('/oidc/callback', async (c) => {
    const oidc = ctx.oidc;
    if (!oidc) return c.json({ error: 'Not found' }, 404);
    const flow = ctx.auth.unseal(getCookie(c, FLOW_COOKIE)) as OidcFlow | null;
    deleteCookie(c, FLOW_COOKIE, { path: FLOW_PATH, secure: isHttps(c), sameSite: 'Lax', httpOnly: true });
    // No flow: it expired, it was started in another tab, or this is a replayed callback URL.
    if (!flow?.state || !flow.nonce || !flow.verifier) {
      await audit(c, 'auth.sign-in', 'refused', 'Sign-in with JEMEDIA refused: the sign-in had expired or was started elsewhere', null, { method: 'jemedia-auth', reason: 'flow_expired' });
      return fail(c, 'flow_expired');
    }
    try {
      const who = await oidc.finish(new URL(c.req.url).searchParams, flow);
      ctx.auth.setSessionCookie(c, ctx.auth.username!, isHttps(c));
      console.log(`[auth] signed in as ${ctx.auth.username} via jemedia-auth (${who.email})`);
      await audit(c, 'auth.sign-in', 'ok', `Signed in with JEMEDIA as ${who.email}`, ctx.auth.username!, { method: 'jemedia-auth', email: who.email });
    } catch (err) {
      console.error(`[auth] ${(err as Error).message}`);
      const code = err instanceof OidcError ? err.code : 'invalid_response';
      await audit(c, 'auth.sign-in', 'refused', `Sign-in with JEMEDIA refused (${code})`, null, { method: 'jemedia-auth', reason: code });
      return fail(c, code);
    }
    // The session cookie is SameSite=Strict, and this response ends a navigation that began at
    // auth.jemedia.xyz: a redirect would still count as cross-site, the cookie would be left off, and
    // the app would send you back to sign in. A page that moves on by itself is a same-site
    // navigation, so the cookie goes with it. (A meta refresh, since the CSP allows no inline script.)
    const next = escapeHtml(safeNext(flow.next));
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${next}"><title>Signing in…</title><body style="font-family:system-ui;padding:2rem"><p>Signing in… <a href="${next}">Continue</a></p></body></html>`,
    );
  });

  return app;
}
