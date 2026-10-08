// Agent access: bearer tokens that let agents (a Claude Code session on the server, a script) use the API
// without a browser session (docs/SELF_HOSTING.md, "Agent access").
//
// - You make a token in Settings while signed in. It has a name, scopes and an expiry, and it is
//   shown once.
// - Only its SHA-256 hash is kept, in the work area (0600), never in data/ or git.
// - It can read everything. It can change only what its scopes allow, through an explicit list of
//   routes. No token can commit, dismiss or discard an import, change source facts, accounts or
//   settings, apply or dismiss a proposed fix, or manage tokens. It can propose a fix, which
//   changes nothing until the owner applies it.
// - Every use is logged: when, which token, what, the answer, and from where.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, nowISO } from './fsutil';

export const TOKEN_SCOPES = ['read', 'imports', 'records', 'jobs'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const TOKEN_SCOPE_LABELS: Record<TokenScope, string> = {
  read: 'Read everything',
  imports: 'Import upkeep: read a pending import again, draft it again, choose its account, edit its draft, link its transfers',
  records: 'Agent records: research, instruments, insights (POST /api/records), and proposed fixes for you to apply or dismiss (POST /api/proposals)',
  jobs: 'Agent jobs: start, rerun, cancel (only while agents are on in Settings)',
};

const TokenSchema = z.object({
  id: z.string().regex(/^tok_[0-9a-f]{12}$/),
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  /** SHA-256 of the token's secret part, hex. The token itself is never stored. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  lastUsedFrom: z.string().optional(),
});
export type AgentToken = z.infer<typeof TokenSchema>;
/** What the owner sees: everything but the hash. */
export type AgentTokenView = Omit<AgentToken, 'hash'> & { status: 'active' | 'expired' | 'revoked' };

const FileSchema = z.object({ tokens: z.array(TokenSchema) });

export interface TokenUse {
  at: string;
  tokenId: string;
  name: string;
  method: string;
  path: string;
  /** The query string, identifiers masked and cut at 500 characters. */
  query?: string;
  status: number;
  /** The answer's size in bytes. */
  bytes?: number;
  /** The agent's own session (X-Agent-Session: a Claude Code session id). */
  agentSession?: string;
  from: string;
}

/** `fin_<id>_<secret>`: the id finds the record, the secret is checked against its hash. */
const TOKEN_RE = /^fin_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const MAX_DAYS = 365;
/** The use log keeps about this many lines. */
const LOG_KEEP = 2000;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The scope a request needs, or null when no token may make it. Reading is any GET except token
 * management; each change is listed here, so a new route is closed to tokens until it is added.
 */
export function requiredScope(method: string, pathname: string): TokenScope | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/api/tokens' || p.startsWith('/api/tokens/') || p.startsWith('/api/auth/')) return null;
  if (method === 'GET' || method === 'HEAD') return 'read';
  const routes: [string, RegExp, TokenScope][] = [
    ['POST', /^\/api\/imports\/imp_[0-9a-z_]+\/(reprocess|refresh|hint)$/, 'imports'],
    ['PUT', /^\/api\/imports\/imp_[0-9a-z_]+\/draft$/, 'imports'],
    ['POST', /^\/api\/imports\/imp_[0-9a-z_]+\/rows\/[0-9a-z-]+\/link$/, 'imports'],
    ['DELETE', /^\/api\/imports\/imp_[0-9a-z_]+\/rows\/[0-9a-z-]+\/link$/, 'imports'],
    ['POST', /^\/api\/records$/, 'records'],
    // An agent proposes a fix, or withdraws its proposal; only the owner applies or dismisses one.
    ['POST', /^\/api\/proposals$/, 'records'],
    ['DELETE', /^\/api\/proposals\/prop_[0-9a-z_]+$/, 'records'],
    ['POST', /^\/api\/jobs(\/tick)?$/, 'jobs'],
    ['POST', /^\/api\/jobs\/[0-9a-z_]+\/(cancel|rerun)$/, 'jobs'],
    // Marking an Ask answer wrong (or not): it adds to the evaluation set, and changes no data.
    ['POST', /^\/api\/ask\/conv_[0-9a-z]+\/turns\/turn_[0-9a-z]+\/feedback$/, 'records'],
  ];
  return routes.find(([m, re]) => m === method && re.test(p))?.[2] ?? null;
}

export class AgentTokens {
  private tokens: AgentToken[] = [];
  private logLines = 0;

  constructor(
    private readonly file: string,
    private readonly logFile: string,
  ) {}

  static forWorkDir(workDir: string): AgentTokens {
    return new AgentTokens(path.join(workDir, 'agent-tokens.json'), path.join(workDir, 'agent-tokens.log.jsonl'));
  }

  async load(): Promise<void> {
    try {
      this.tokens = FileSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).tokens;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[tokens] ${this.file} could not be read, so no token is accepted: ${(err as Error).message}`);
      this.tokens = [];
    }
    try {
      this.logLines = (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean).length;
    } catch {
      this.logLines = 0;
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify({ tokens: this.tokens }, null, 2) + '\n', 0o600);
  }

  list(now = Date.now()): AgentTokenView[] {
    return this.tokens
      .map(({ hash: _hash, ...t }) => ({ ...t, status: t.revokedAt ? ('revoked' as const) : Date.parse(t.expiresAt) <= now ? ('expired' as const) : ('active' as const) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A new token: returned once, with the record kept (hashed). Read is always included. */
  async create(input: { name: string; scopes: TokenScope[]; days: number }, now = new Date()): Promise<{ token: string; view: AgentTokenView }> {
    const days = Math.min(Math.max(Math.round(input.days), 1), MAX_DAYS);
    const id = `tok_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const record: AgentToken = {
      id,
      name: input.name.trim().slice(0, 60) || 'Agent',
      scopes: TOKEN_SCOPES.filter((s) => s === 'read' || input.scopes.includes(s)),
      hash: sha256hex(secret),
      createdAt: nowISO(now),
      expiresAt: nowISO(new Date(now.getTime() + days * 86_400_000)),
    };
    this.tokens.push(TokenSchema.parse(record));
    await this.save();
    return { token: `fin_${id.slice(4)}_${secret}`, view: this.list(now.getTime()).find((t) => t.id === id)! };
  }

  async revoke(id: string, now = new Date()): Promise<boolean> {
    const t = this.tokens.find((x) => x.id === id);
    if (!t || t.revokedAt) return false;
    t.revokedAt = nowISO(now);
    await this.save();
    return true;
  }

  /** The token a bearer credential belongs to, if it is valid now. */
  verify(credential: string, now = Date.now()): AgentToken | undefined {
    const m = TOKEN_RE.exec(credential.trim());
    if (!m) return undefined;
    const t = this.tokens.find((x) => x.id === `tok_${m[1]}`);
    if (!t || t.revokedAt || Date.parse(t.expiresAt) <= now) return undefined;
    const given = Buffer.from(sha256hex(m[2]!), 'hex');
    const expected = Buffer.from(t.hash, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected) ? t : undefined;
  }

  /** Log a use and remember when and from where the token was last used. */
  async recordUse(use: TokenUse): Promise<void> {
    const t = this.tokens.find((x) => x.id === use.tokenId);
    if (t) {
      const previous = t.lastUsedAt;
      t.lastUsedAt = use.at;
      t.lastUsedFrom = use.from;
      // Settings shows the last use; saving it at most once a minute is plenty (the log has each).
      if (!previous || Date.parse(use.at) - Date.parse(previous) >= 60_000) await this.save().catch(() => undefined);
    }
    await mkdir(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    await appendFile(this.logFile, JSON.stringify(use) + '\n', { mode: 0o600 });
    if (++this.logLines > LOG_KEEP * 1.5) await this.trimLog();
  }

  private async trimLog(): Promise<void> {
    const lines = (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean).slice(-LOG_KEEP);
    await writeFile(this.logFile, lines.join('\n') + '\n', { mode: 0o600 });
    this.logLines = lines.length;
  }

  /** The most recent uses, newest first. */
  async recentUses(limit = 50): Promise<TokenUse[]> {
    try {
      const lines = (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean).slice(-limit);
      return lines
        .map((l) => {
          try {
            return JSON.parse(l) as TokenUse;
          } catch {
            return undefined;
          }
        })
        .filter((u): u is TokenUse => u !== undefined)
        .reverse();
    } catch {
      return [];
    }
  }
}
