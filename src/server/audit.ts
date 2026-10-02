// The audit log (Settings → Audit log): every action that changes your data or the app's work
// area, who did it, from where, and what it changed. It sits beside git's history of data/, which
// says what changed but not who asked for it (docs/ARCHITECTURE.md, "Audit log").
//
// - Who: you (your session, with the client's address and, on the tailnet, the device's name), an
//   agent's token, an agent job, the app by itself, or a file changed outside the app. The actor
//   travels with the work through AsyncLocalStorage, so a write deep in the store knows who asked.
// - What: each request that could change something (refused ones too), each write to data/ with
//   its records' fields before and after, imports, jobs, proposals, tokens and sign-ins.
// - Kept: append-only JSONL in the work area (audit/<yyyy-mm>.jsonl, 0600), written and synced
//   before the request answers. A write that fails is retried with the next entry and reported.
// - Each entry carries sha256(previous hash + itself): a removed or altered entry breaks the chain,
//   which Settings checks on request.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { closeSync, fdatasyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { withoutNiNumbers } from '../shared/privacy';
import type { AuditActor, AuditActorType, AuditCategory, AuditChild, AuditEntry, AuditOutcome, AuditStatus, AuditVerifyResponse, ChangeDiff } from '../shared/audit';
import type { Auth } from './auth';
import { nowISO, randomHex, sha256 } from './fsutil';
import { clientAddress, isDirectLocal } from './security';
import type { AgentTokens } from './tokens';

// ─── Who is acting ───────────────────────────────────────────────────────────────────────────────

interface Scope {
  actor: () => AuditActor;
  requestId?: string;
  /** What the request did, for its own entry. */
  children?: AuditChild[];
  /** The request has answered: work it started later keeps its actor but not its request. */
  closed?: boolean;
}

const scopes = new AsyncLocalStorage<Scope>();
const BACKGROUND: AuditActor = { type: 'app', task: 'background' };

/** Run `fn` (and everything it starts) as `actor`. */
export function runAs<T>(actor: AuditActor, fn: () => T): T {
  return scopes.run({ actor: () => actor }, fn);
}

/** Who is acting here: the request's caller, the job, or the app. */
export function currentActor(): AuditActor {
  return scopes.getStore()?.actor() ?? BACKGROUND;
}

// ─── The log ─────────────────────────────────────────────────────────────────────────────────────

export interface AuditInput {
  category: AuditCategory;
  action: string;
  summary: string;
  outcome?: AuditOutcome;
  /** Who did it; by default whoever is acting here (currentActor). */
  actor?: AuditActor;
  /** The request it belongs to; by default the one being answered here. */
  requestId?: string | undefined;
  request?: AuditEntry['request'];
  changes?: AuditChild[];
  paths?: string[];
  targets?: string[];
  details?: Record<string, unknown>;
  diff?: ChangeDiff | undefined;
}

export interface AuditQuery {
  /** Words that must all appear (any field: names, ids, addresses, paths, values). */
  q?: string;
  categories?: AuditCategory[];
  actors?: AuditActorType[];
  outcome?: AuditOutcome;
  /** Local dates, inclusive. */
  from?: string;
  to?: string;
  /** Entries older than this sequence number (paging). */
  before?: number;
  limit?: number;
  /** Every entry, rather than one per action: a request's writes are folded into its own entry. */
  all?: boolean;
  /** Entries about any of these ids: in what they concern, or the job or token that acted. */
  about?: string[];
}

const GENESIS = '0'.repeat(64);
const FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;
const RETRY_MS = 5000;

const monthOf = (iso: string) => iso.slice(0, 7);
/** The local calendar date of a UTC timestamp (the server's time zone, as everywhere else). */
const localDate = (iso: string) => nowISO(new Date(iso)).slice(0, 10);
const prevMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

/** The text an entry's hash covers: everything but the hash, as written. */
function hashed(prev: string, entry: Omit<AuditEntry, 'hash'>): string {
  return sha256(`${prev}\n${JSON.stringify(entry)}`);
}

function parseLine(line: string): AuditEntry | undefined {
  try {
    const e = JSON.parse(line) as AuditEntry;
    return typeof e.seq === 'number' && typeof e.hash === 'string' ? e : undefined;
  } catch {
    return undefined;
  }
}

export class AuditLog {
  private seq = 0;
  private last = GENESIS;
  private firstAt?: string | undefined;
  private fd?: number | undefined;
  private fdMonth?: string | undefined;
  private unwritten: { month: string; line: string }[] = [];
  private retry?: NodeJS.Timeout | undefined;
  private failures = 0;
  private lastError?: string | undefined;

  private constructor(readonly dir: string) {}

  /** Open the log in `dir`, carrying on its chain. */
  static open(dir: string): AuditLog {
    const log = new AuditLog(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = log.files();
    if (files.length) {
      const first = readFileSync(path.join(dir, files[0]!), 'utf8').split('\n', 1)[0];
      log.firstAt = first ? parseLine(first)?.at : undefined;
    }
    for (const f of [...files].reverse()) {
      const abs = path.join(dir, f);
      const text = readFileSync(abs, 'utf8');
      // A line cut off by a crash: the next entry starts on a line of its own.
      if (text && !text.endsWith('\n')) log.unwritten.push({ month: f.slice(0, 7), line: '\n' });
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = lines[i] ? parseLine(lines[i]!) : undefined;
        if (!e) continue;
        log.seq = e.seq;
        log.last = e.hash;
        break;
      }
      if (log.seq) break;
    }
    log.drain();
    return log;
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => FILE_RE.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  /** Write an entry now (synced to disk before this returns, unless the disk refuses). */
  record(input: AuditInput): AuditEntry {
    const scope = scopes.getStore();
    const live = scope && !scope.closed ? scope : undefined;
    const requestId = 'requestId' in input ? input.requestId : live?.requestId;
    const at = new Date().toISOString();
    const base: Omit<AuditEntry, 'hash'> = {
      seq: this.seq + 1,
      at,
      category: input.category,
      action: input.action,
      outcome: input.outcome ?? 'ok',
      summary: input.summary.slice(0, 500),
      actor: input.actor ?? scope?.actor() ?? BACKGROUND,
      ...(requestId ? { requestId } : {}),
      ...(input.request ? { request: input.request } : {}),
      ...(input.changes?.length ? { changes: input.changes } : {}),
      ...(input.paths?.length ? { paths: input.paths.slice(0, 200) } : {}),
      ...(input.targets?.length ? { targets: [...new Set(input.targets)].slice(0, 50) } : {}),
      ...(input.details && Object.keys(input.details).length ? { details: input.details } : {}),
      ...(input.diff && Object.keys(input.diff).length ? { diff: input.diff } : {}),
    };
    // Round-trip first, so the hash covers exactly what a reader will parse back.
    const clean = JSON.parse(JSON.stringify(base)) as Omit<AuditEntry, 'hash'>;
    const entry: AuditEntry = { ...clean, hash: hashed(this.last, clean) };
    this.seq = entry.seq;
    this.last = entry.hash;
    this.firstAt ??= at;
    if (live?.children && requestId === live.requestId && input.category !== 'request') {
      live.children.push({ seq: entry.seq, action: entry.action, summary: entry.summary, ...(entry.paths ? { paths: entry.paths.slice(0, 20) } : {}) });
    }
    this.unwritten.push({ month: monthOf(at), line: `${JSON.stringify(entry)}\n` });
    this.drain();
    return entry;
  }

  private drain(): void {
    while (this.unwritten.length) {
      const { month, line } = this.unwritten[0]!;
      try {
        if (this.fdMonth !== month || this.fd === undefined) {
          if (this.fd !== undefined) closeSync(this.fd);
          this.fd = undefined;
          this.fd = openSync(path.join(this.dir, `${month}.jsonl`), 'a', 0o600);
          this.fdMonth = month;
        }
        const buf = Buffer.from(line, 'utf8');
        let off = 0;
        while (off < buf.length) off += writeSync(this.fd, buf, off);
        fdatasyncSync(this.fd);
        this.unwritten.shift();
      } catch (err) {
        this.failures++;
        if (this.lastError !== (err as Error).message) console.error(`[audit] could not write the audit log: ${(err as Error).message}`);
        this.lastError = (err as Error).message;
        if (this.fd !== undefined) {
          try {
            closeSync(this.fd);
          } catch {
            // already gone
          }
          this.fd = undefined;
        }
        if (!this.retry) {
          this.retry = setTimeout(() => {
            this.retry = undefined;
            this.drain();
          }, RETRY_MS);
          this.retry.unref();
        }
        return;
      }
    }
    this.lastError = undefined;
  }

  close(): void {
    clearTimeout(this.retry);
    this.drain();
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  status(): AuditStatus {
    return {
      entries: this.seq,
      ...(this.firstAt ? { firstAt: this.firstAt } : {}),
      dir: this.dir,
      bytes: this.files().reduce((sum, f) => sum + statSync(path.join(this.dir, f)).size, 0),
      failures: this.failures,
      unwritten: this.unwritten.filter((u) => u.line !== '\n').length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Entries, newest first, that match; with the git commit each data change went into. */
  async query(q: AuditQuery = {}): Promise<{ entries: AuditEntry[]; next?: number }> {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const out: AuditEntry[] = [];
    let next: number | undefined;
    for await (const e of this.scan(q)) {
      if (out.length === limit) {
        next = out[out.length - 1]!.seq;
        break;
      }
      out.push(e);
    }
    return next !== undefined ? { entries: out, next } : { entries: out };
  }

  /** Every matching entry, newest first (export). */
  async *scan(q: AuditQuery = {}): AsyncGenerator<AuditEntry> {
    // "#123": that one entry, folded into a request or not.
    const seqOnly = /^#(\d+)$/.exec((q.q ?? '').trim());
    const seq = seqOnly ? Number(seqOnly[1]) : undefined;
    const terms = seqOnly ? [] : (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const commits = new Map<number, string>();
    const fromMonth = q.from ? prevMonth(monthOf(q.from)) : undefined;
    const toMonth = q.to ? monthOf(q.to) : undefined;
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => FILE_RE.test(f)).sort().reverse();
    for (const f of files) {
      const month = f.slice(0, 7);
      // A commit follows its changes within seconds, so past the range only the next month is read
      // (for the commits of changes in range).
      if (toMonth && month > toMonth && prevMonth(month) !== toMonth) continue;
      if (fromMonth && month < fromMonth) break;
      const lines = (await readFile(path.join(this.dir, f), 'utf8')).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line) continue;
        if (line.includes('"git.commit"')) {
          const c = parseLine(line);
          const hash = c?.details?.hash;
          if (typeof hash === 'string') for (const s of (c!.details!.changes as number[] | undefined) ?? []) commits.set(s, hash);
        }
        const e = parseLine(line);
        if (!e) continue;
        if (q.before !== undefined && e.seq >= q.before) continue;
        if (seq !== undefined && e.seq !== seq) continue;
        if (toMonth && month > toMonth) continue;
        const day = localDate(e.at);
        if (q.to && day > q.to) continue;
        if (q.from && day < q.from) continue;
        if (!q.all && seq === undefined && ((e.requestId && e.category !== 'request') || e.action === 'git.commit')) continue;
        if (q.categories?.length && !q.categories.includes(e.category)) continue;
        if (q.actors?.length && !q.actors.includes(e.actor.type)) continue;
        if (q.outcome && e.outcome !== q.outcome) continue;
        if (q.about?.length && !concerns(e, q.about)) continue;
        const commit = commits.get(e.seq);
        if (commit) e.commit = commit;
        if (e.changes) for (const c of e.changes) if (commits.has(c.seq)) c.commit = commits.get(c.seq)!;
        if (terms.length) {
          const text = `${line.slice(0, line.lastIndexOf(',"hash"'))} ${commit ?? ''} ${(e.changes ?? []).map((c) => c.commit ?? '').join(' ')}`.toLowerCase();
          if (!terms.every((t) => text.includes(t))) continue;
        }
        yield e;
      }
    }
  }

  /** Walk the whole log, oldest first, checking that every entry is whole and the chain unbroken. */
  async verify(): Promise<AuditVerifyResponse> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => FILE_RE.test(f)).sort();
    const problems: AuditVerifyResponse['problems'] = [];
    let prev = GENESIS;
    let seq = 0;
    let entries = 0;
    let unreadable = 0;
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line) continue;
        const e = parseLine(line);
        if (!e) {
          unreadable++;
          if (problems.length < 50) problems.push({ file: f, line: i + 1, problem: 'Not a whole entry (a write cut off by a crash?)' });
          continue;
        }
        entries++;
        const { hash, ...rest } = e;
        if (e.seq !== seq + 1 && problems.length < 50) problems.push({ file: f, line: i + 1, seq: e.seq, problem: e.seq <= seq ? `Out of order: after #${seq}` : `Entries #${seq + 1}–#${e.seq - 1} are missing` });
        if (hashed(prev, rest) !== hash && problems.length < 50) problems.push({ file: f, line: i + 1, seq: e.seq, problem: 'Its hash does not match: the entry, or one before it, was changed or removed' });
        prev = hash;
        seq = e.seq;
      }
    }
    return { ok: problems.length === 0, entries, files: files.length, unreadable, problems };
  }

}

/** Whether an entry concerns one of these ids: a target, or the job or token that acted. */
export function concerns(e: AuditEntry, ids: string[]): boolean {
  const a = e.actor;
  const actorId = a.type === 'job' ? a.jobId : a.type === 'token' ? a.tokenId : undefined;
  return ids.some((id) => e.targets?.includes(id) || id === actorId);
}

// ─── Devices on the tailnet ──────────────────────────────────────────────────────────────────────

export interface DeviceInfo {
  device?: string;
  tailnetUser?: string;
}

/**
 * The tailnet's name for an address, from the local tailscaled (`tailscale whois`): which of your
 * devices made a request. Nothing leaves this machine. Remembered for ten minutes.
 */
export class DeviceNames {
  private cache = new Map<string, { at: number; info: DeviceInfo | undefined }>();

  constructor(private readonly bin = 'tailscale') {}

  static isTailnet(ip: string): boolean {
    const v4 = /^(?:::ffff:)?100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
    if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
    return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
  }

  async lookup(ip: string): Promise<DeviceInfo | undefined> {
    if (!DeviceNames.isTailnet(ip)) return undefined;
    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < 600_000) return hit.info;
    const info = await new Promise<DeviceInfo | undefined>((resolve) => {
      execFile(this.bin, ['whois', '--json', ip.replace(/^::ffff:/, '')], { timeout: 1500 }, (err, stdout) => {
        if (err) return resolve(undefined);
        try {
          const w = JSON.parse(stdout) as { Node?: { ComputedName?: string; Name?: string; Hostinfo?: { Hostname?: string } }; UserProfile?: { LoginName?: string } };
          const device = w.Node?.ComputedName || w.Node?.Name?.split('.')[0] || w.Node?.Hostinfo?.Hostname;
          const user = w.UserProfile?.LoginName;
          resolve({ ...(device ? { device } : {}), ...(user ? { tailnetUser: user } : {}) });
        } catch {
          resolve(undefined);
        }
      });
    });
    this.cache.set(ip, { at: Date.now(), info });
    return info;
  }
}

// ─── Requests ────────────────────────────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** POSTs that only look: previews and checks change nothing. */
const LOOK_ONLY = [/^\/api\/rules\/preview$/, /^\/api\/categorise\/preview$/, /^\/api\/proposals\/[^/]+\/check$/];
/** Bodies that hold a document's contents (an import's draft): kept as their shape, never their text. */
const SHAPE_ONLY = [/^\/api\/imports\/[^/]+\/draft$/];
/** Signing in and out are recorded as what they are, by the auth routes. */
const OWN_ENTRIES = /^\/api\/auth\//;
const SECRET_KEY = /pass(word)?|secret|token|hash|authori[sz]ation|cookie|credential/i;
const MAX_BODY_READ = 512 * 1024;
const MAX_BODY_KEPT = 8 * 1024;

/** Whether a request is one the audit log records. */
export function isAudited(method: string, pathname: string): boolean {
  return !SAFE_METHODS.has(method) && pathname.startsWith('/api/') && !OWN_ENTRIES.test(pathname) && !LOOK_ONLY.some((re) => re.test(pathname));
}

/** Account and card numbers (8 digits or more) keep their last 4, as the data does; NI numbers go. */
export function maskIdentifiers(s: string): string {
  return withoutNiNumbers(s).replace(/\b\d(?: ?\d){7,}\b/g, (m) => `••••${m.replace(/ /g, '').slice(-4)}`);
}

/** A value with secrets and identifiers taken out and long parts cut. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    const s = maskIdentifiers(v);
    return s.length > 300 ? `${s.slice(0, 300)}… (${s.length} characters)` : s;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > 6) return '…';
  if (Array.isArray(v)) {
    const head = v.slice(0, 20).map((x) => redact(x, depth + 1));
    return v.length > 20 ? [...head, `… ${v.length - 20} more`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1);
  return out;
}

/** What a value holds, without its contents: keys, and how many items or characters. */
export function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (typeof v === 'string') return `(${v.length} characters)`;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 2) return '{…}';
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
}

async function captureBody(c: Context): Promise<Pick<NonNullable<AuditEntry['request']>, 'contentType' | 'bytes' | 'body'>> {
  const type = c.req.header('content-type') ?? '';
  const length = Number(c.req.header('content-length'));
  const out: Pick<NonNullable<AuditEntry['request']>, 'contentType' | 'bytes' | 'body'> = {};
  if (type) out.contentType = type.split(';')[0]!.trim();
  if (Number.isFinite(length)) out.bytes = length;
  // Uploads are not read here: the import's own entries name the file, its size and hash.
  if (!type.includes('application/json') || length > MAX_BODY_READ) return out;
  try {
    // Hono keeps the text, so the route reads the same body after this.
    const parsed = JSON.parse(await c.req.text()) as unknown;
    let body = SHAPE_ONLY.some((re) => re.test(c.req.path)) ? shape(parsed) : redact(parsed);
    if (JSON.stringify(body).length > MAX_BODY_KEPT) body = shape(parsed);
    out.body = body;
  } catch {
    // not JSON after all: the route says so
  }
  return out;
}

/** Where a request came from: address, device and browser. */
export async function whoFrom(c: Context, devices?: DeviceNames): Promise<{ ip: string; device?: string; tailnetUser?: string; userAgent?: string }> {
  const ip = clientAddress(c);
  const info = devices ? await devices.lookup(ip) : undefined;
  const ua = c.req.header('user-agent');
  return { ip, ...(info ?? {}), ...(ua ? { userAgent: ua.slice(0, 200) } : {}) };
}

function actorOf(c: Context, who: Awaited<ReturnType<typeof whoFrom>>, auth: Auth, tokens: AgentTokens): AuditActor {
  // A token is judged alone, as the gate judges it: a valid one refused for its scopes is still that token.
  const credential = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (credential !== undefined || c.get('agentToken' as never)) {
    const t = credential ? tokens.verify(credential) : undefined;
    if (t) return { type: 'token', tokenId: t.id, name: t.name, scopes: t.scopes, ...who };
    const claimed = /^fin_([0-9a-f]{12})_/.exec(credential ?? '')?.[1];
    return { type: 'anonymous', ...who, ...(claimed ? { claimedToken: `tok_${claimed}` } : {}) };
  }
  const user = c.get('user' as never) as string | undefined;
  if (typeof user === 'string') return { type: 'owner', user, via: 'session', ...who };
  if (!auth.configured && isDirectLocal(c)) return { type: 'owner', user: 'local', via: 'local', ...who };
  return { type: 'anonymous', ...who };
}

/** Plain words for requests that write nothing the log records by itself. */
const ROUTE_WORDS: [string, RegExp, string][] = [
  ['PUT', /^\/api\/imports\/[^/]+\/draft$/, 'Edited an import’s draft'],
  ['POST', /^\/api\/imports\/[^/]+\/hint$/, 'Chose the account for an import'],
  ['POST', /^\/api\/imports\/[^/]+\/mapping$/, 'Mapped an import’s columns'],
  ['POST', /^\/api\/imports\/[^/]+\/refresh$/, 'Drafted an import again'],
  ['POST', /^\/api\/imports\/[^/]+\/reread$/, 'Read a stored document again'],
  ['DELETE', /^\/api\/imports\/[^/]+\/reread$/, 'Put a second reading away'],
  ['POST', /^\/api\/git\/commit$/, 'Committed pending data changes'],
  ['POST', /^\/api\/jobs\/tick$/, 'Checked for agent jobs that are due'],
  ['POST', /^\/api\/receipts\/[^/]+\/read$/, 'Asked Claude to read a receipt'],
];

function requestSummary(method: string, pathname: string, children: AuditChild[], outcome: AuditOutcome, error: string | undefined): string {
  // A refusal did nothing, so it is named by what was asked, not by words for what it would have done.
  if (outcome !== 'ok') return `${outcome === 'refused' ? 'Refused' : 'Failed'}: ${method} ${pathname}${error ? ` (${error})` : ''}`;
  const words = ROUTE_WORDS.find(([m, re]) => m === method && re.test(pathname))?.[2];
  const first = children.find((c) => c.action !== 'git.commit') ?? children[0];
  if (first) return `${first.summary}${children.length > 1 ? ` (+${children.length - 1} more)` : ''}`;
  return words ?? `${method} ${pathname}`;
}

/** Ids in a path (`/api/transactions/tx_…`): what the request was about. */
function idsIn(pathname: string): string[] {
  return pathname.split('/').filter((s) => /^[a-z]+_[0-9a-z_]+$/i.test(s) && s.length > 4);
}

async function errorOf(res: Response): Promise<string | undefined> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records every request that could change something, refused ones included, with who made it and
 * what it did; and lets everything it causes know who is acting.
 */
export function auditRequests(audit: AuditLog, deps: { auth: Auth; tokens: AgentTokens; devices?: DeviceNames | undefined }): MiddlewareHandler {
  return async (c, next) => {
    if (!isAudited(c.req.method, c.req.path)) return next();
    const started = Date.now();
    const who = await whoFrom(c, deps.devices);
    const body = await captureBody(c);
    const requestId = `req_${randomHex(6)}`;
    const children: AuditChild[] = [];
    const scope: Scope = { requestId, children, actor: () => actorOf(c, who, deps.auth, deps.tokens) };
    try {
      await scopes.run(scope, () => next());
    } finally {
      scope.closed = true;
      const status = c.res.status;
      const outcome: AuditOutcome = status < 400 ? 'ok' : status === 401 || status === 403 || status === 429 ? 'refused' : 'failed';
      const error = status >= 400 ? await errorOf(c.res) : undefined;
      audit.record({
        category: 'request',
        action: 'request',
        outcome,
        actor: scope.actor(),
        requestId,
        summary: requestSummary(c.req.method, c.req.path, children, outcome, error),
        request: { method: c.req.method, path: c.req.path, status, ms: Date.now() - started, ...body, ...(error ? { error } : {}) },
        changes: children,
        targets: idsIn(c.req.path),
      });
    }
  };
}
