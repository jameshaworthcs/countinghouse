// Request hardening: Host allow-list (DNS-rebinding guard), trusted-proxy handling, CSRF guard,
// security headers, and the authentication gate.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import type { Auth } from './auth';
import { isLoopbackHost } from './config';
import { maskIdentifiers } from './audit';
import { nowISO } from './fsutil';
import { AGENT_SESSION_HEADER, isAgentSessionId } from '../shared/sessions';
import { requiredScope, type AgentTokens } from './tokens';

export interface SecurityOptions {
  allowedHosts: string[];
  production: boolean;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

/** The direct TCP peer. */
export function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

function peerIsLoopback(c: Context): boolean {
  const a = peerAddress(c);
  return a === '' || a === '::1' || a.startsWith('127.') || a === '::ffff:127.0.0.1';
}

/** True when the request came through the local reverse proxy (Caddy). */
export function isProxied(c: Context): boolean {
  return peerIsLoopback(c) && Boolean(c.req.header('x-forwarded-for') || c.req.header('x-forwarded-proto'));
}

/** Client IP: X-Forwarded-For is only believed when the peer is the local proxy. */
export function clientAddress(c: Context): string {
  if (isProxied(c)) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
  }
  return peerAddress(c) || 'local';
}

export function isHttps(c: Context): boolean {
  if (isProxied(c)) return c.req.header('x-forwarded-proto') === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

/** A direct request from this machine, not via the proxy. */
export function isDirectLocal(c: Context): boolean {
  return peerIsLoopback(c) && !isProxied(c) && isLoopbackHost(hostname(c.req.header('host')));
}

export function hostGuard(opts: SecurityOptions): MiddlewareHandler {
  const allowed = new Set([...LOCAL_HOSTS, ...opts.allowedHosts.map((h) => h.toLowerCase())]);
  return async (c, next) => {
    const host = hostname(c.req.header('host'));
    if (!allowed.has(host) && !host.startsWith('127.')) {
      return c.text(`Host "${host}" is not allowed. Add it to FINANCE_ALLOWED_HOSTS.`, 421);
    }
    await next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-finance-csrf';

/**
 * Mutating API calls must carry a custom header (which a cross-site page cannot send without a CORS
 * preflight this server never grants) and, when present, a same-origin Origin header.
 */
export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || !c.req.path.startsWith('/api/')) return next();
    if (c.req.header(CSRF_HEADER) !== '1') return c.json({ error: 'Missing CSRF header' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return c.json({ error: 'Bad Origin' }, 403);
      }
      const host = (c.req.header('x-forwarded-host') && isProxied(c) ? c.req.header('x-forwarded-host') : c.req.header('host'))?.toLowerCase();
      if (originHost !== host) return c.json({ error: 'Cross-origin request refused' }, 403);
    }
    await next();
  };
}

export function securityHeaders(opts: SecurityOptions): MiddlewareHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (opts.production) c.header('Content-Security-Policy', csp);
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  };
}

const PUBLIC_API = new Set(['/api/health', '/api/auth/login', '/api/auth/status', '/api/auth/oidc/login', '/api/auth/oidc/callback']);

/** A browser opening one of the app's pages (not the API, and not a file such as a bundle or icon). */
export function isPageRequest(c: Context): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  const p = c.req.path;
  if (p.startsWith('/api/') || p.startsWith('/assets/')) return false;
  return !p.slice(p.lastIndexOf('/') + 1).includes('.');
}

/**
 * Everything under /api requires a session, except sign-in, status and health. Static files (the SPA shell
 * and bundles) are public so the login page can render; they contain no data.
 *
 * An agent's bearer token (tokens.ts) stands in for a session, for what its scopes allow. A request
 * that carries one is judged by it alone: cookies sent with it count for nothing.
 */
export function authGate(auth: Auth, tokens?: AgentTokens): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith('/api/') || PUBLIC_API.has(path)) return next();
    const authorization = c.req.header('authorization');
    if (authorization !== undefined) {
      const credential = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
      const token = credential && tokens ? tokens.verify(credential) : undefined;
      if (!token || !tokens) return c.json({ error: 'The token is not valid: wrong, expired or revoked.', code: 'bad_token' }, 401);
      // What it asked for, whole (the query too), and which of the agent's sessions asked.
      const query = new URL(c.req.url).search;
      const agentSession = c.req.header(AGENT_SESSION_HEADER);
      const use = { tokenId: token.id, name: token.name, method: c.req.method, path, ...(query ? { query: maskIdentifiers(query).slice(0, 500) } : {}), ...(isAgentSessionId(agentSession) ? { agentSession } : {}), from: clientAddress(c) };
      const scope = requiredScope(c.req.method, path);
      if (!scope || !token.scopes.includes(scope)) {
        await tokens.recordUse({ ...use, at: nowISO(), status: 403 });
        return c.json({ error: scope ? `This token may not do that: it needs the "${scope}" scope.` : 'No token may do that: it is yours to do in the app.', code: 'token_scope' }, 403);
      }
      c.set('user' as never, `agent:${token.name}` as never);
      c.set('agentToken' as never, token.id as never);
      await next();
      await tokens.recordUse({ ...use, at: nowISO(), status: c.res.status, ...(await responseBytes(c.res)) });
      return;
    }
    if (!auth.configured) {
      if (isDirectLocal(c)) return next();
      return c.json({ error: 'Login is not configured. Run `npm run set-password` on the server.', code: 'auth_not_configured' }, 403);
    }
    const session = auth.sessionFrom(c);
    if (!session) return c.json({ error: 'Not signed in', code: 'unauthenticated' }, 401);
    if (auth.shouldRefresh(session)) auth.setSessionCookie(c, session.user, isHttps(c));
    c.set('user' as never, session.user as never);
    await next();
  };
}

/** A response's size: its Content-Length, or its body counted (never a stream, which has no end). */
async function responseBytes(res: Response): Promise<{ bytes?: number }> {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) return { bytes: length };
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) return {};
  try {
    return { bytes: (await res.clone().arrayBuffer()).byteLength };
  } catch {
    return {};
  }
}
