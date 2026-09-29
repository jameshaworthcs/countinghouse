// Authentication.
//
// One user (FINANCE_USERNAME) and a signed, HttpOnly session cookie. The session doesn't care how
// the user proved who they are; there are two ways, and a server uses exactly one:
//
// - jemedia-auth (OIDC, oidc.ts) when FINANCE_OIDC_CLIENT_ID is set. This is the live site's.
//   Password sign-in is then refused outright.
// - Otherwise a password (scrypt hash in .env, set with `npm run set-password`): the demo, the
//   screenshot run and any server without an OIDC client.
//
// Without either the app only answers direct local requests (Host: localhost and no proxy headers),
// which keeps development frictionless and a misconfigured deployment closed.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/**
 * "scrypt:N:r:p:salt:hash" with base64url parts: no characters that a shell, systemd or a .env
 * parser could interpret.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const SESSION_COOKIE = 'finance_session';
const SESSION_DAYS = 30;

export type AuthMethod = 'oidc' | 'password';

export interface AuthConfig {
  username?: string | undefined;
  passwordHash?: string | undefined;
  /**
   * Set when sign-in goes through jemedia-auth: what identifies that setup (issuer, client and the
   * allowed addresses). Changing any of it signs every session out, as a new password does.
   */
  oidcIdentity?: string | undefined;
  secret: Buffer;
}

export interface Session {
  user: string;
  expiresAt: number;
}

/** Load (or create) the HMAC secret used to sign session cookies. */
export async function loadSessionSecret(env: NodeJS.ProcessEnv, workDir: string): Promise<Buffer> {
  if (env.FINANCE_SESSION_SECRET && env.FINANCE_SESSION_SECRET.length >= 32) return Buffer.from(env.FINANCE_SESSION_SECRET, 'utf8');
  const file = path.join(workDir, 'session-secret');
  try {
    const hex = (await readFile(file, 'utf8')).trim();
    if (hex.length >= 64) return Buffer.from(hex, 'hex');
  } catch {
    // create below
  }
  const secret = randomBytes(32);
  await mkdir(workDir, { recursive: true });
  await writeFile(file, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

export class Auth {
  private failures = new Map<string, number[]>();
  private globalFailures: number[] = [];

  constructor(private readonly cfg: AuthConfig) {}

  /** How this server signs people in, or null when it has no login (local access only). */
  get method(): AuthMethod | null {
    if (!this.cfg.username) return null;
    if (this.cfg.oidcIdentity) return 'oidc';
    return this.cfg.passwordHash ? 'password' : null;
  }

  get configured(): boolean {
    return this.method !== null;
  }

  get username(): string | undefined {
    return this.cfg.username;
  }

  /**
   * Changing the password, or the jemedia-auth setup, changes this, which invalidates every existing
   * session. Switching between the two methods does too.
   */
  private get epoch(): string {
    const basis = this.method === 'oidc' ? `oidc:${this.cfg.oidcIdentity}` : (this.cfg.passwordHash ?? 'none');
    return createHmac('sha256', this.cfg.secret).update(basis).digest('hex').slice(0, 12);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.cfg.secret).update(`${payload}.${this.epoch}`).digest('base64url');
  }

  issue(user: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
    const payload = `v1.${Buffer.from(user).toString('base64url')}.${exp}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined, now = Date.now()): Session | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const payload = parts.slice(0, 3).join('.');
    const given = Buffer.from(parts[3]!, 'base64url');
    const expected = Buffer.from(this.sign(payload), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const exp = Number(parts[2]) * 1000;
    if (!Number.isFinite(exp) || exp < now) return null;
    const user = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    if (this.cfg.username && user !== this.cfg.username) return null;
    return { user, expiresAt: exp };
  }

  /** Throttle: 10 failures per client per 15 minutes, 50 overall. */
  isThrottled(clientKey: string, now = Date.now()): boolean {
    const windowStart = now - 15 * 60_000;
    const recent = (this.failures.get(clientKey) ?? []).filter((t) => t > windowStart);
    this.failures.set(clientKey, recent);
    this.globalFailures = this.globalFailures.filter((t) => t > windowStart);
    return recent.length >= 10 || this.globalFailures.length >= 50;
  }

  private recordFailure(clientKey: string, now = Date.now()): void {
    const list = this.failures.get(clientKey) ?? [];
    list.push(now);
    this.failures.set(clientKey, list);
    this.globalFailures.push(now);
  }

  async login(username: string, password: string, clientKey: string): Promise<'ok' | 'invalid' | 'throttled' | 'not-configured' | 'use-oidc'> {
    if (this.method === 'oidc') return 'use-oidc';
    if (this.method !== 'password') return 'not-configured';
    if (this.isThrottled(clientKey)) return 'throttled';
    const userOk = timingSafeEqualStr(username, this.cfg.username!);
    const passOk = await verifyPassword(password, this.cfg.passwordHash!);
    if (userOk && passOk) {
      this.failures.delete(clientKey);
      return 'ok';
    }
    this.recordFailure(clientKey);
    return 'invalid';
  }

  setSessionCookie(c: Context, user: string, secure: boolean): void {
    setCookie(c, SESSION_COOKIE, this.issue(user), {
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });
  }

  clearSessionCookie(c: Context, secure: boolean): void {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure, sameSite: 'Strict', httpOnly: true });
  }

  /**
   * A signed, expiring value for a short-lived cookie (the OIDC flow's state, nonce and PKCE
   * verifier). Tamper-proof, not secret: it stays in the browser that started the sign-in.
   */
  seal(value: unknown, ttlSeconds: number, now = Date.now()): string {
    const payload = `s1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${Math.floor(now / 1000) + ttlSeconds}`;
    return `${payload}.${this.sign(payload)}`;
  }

  unseal(token: string | undefined, now = Date.now()): unknown {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 's1') return null;
    const payload = parts.slice(0, 3).join('.');
    const given = Buffer.from(parts[3]!, 'base64url');
    const expected = Buffer.from(this.sign(payload), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (!(Number(parts[2]) * 1000 >= now)) return null;
    try {
      return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  sessionFrom(c: Context): Session | null {
    return this.verify(getCookie(c, SESSION_COOKIE));
  }

  /** Re-issue the cookie when less than half its lifetime remains. */
  shouldRefresh(session: Session, now = Date.now()): boolean {
    return session.expiresAt - now < (SESSION_DAYS / 2) * 86400_000;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
