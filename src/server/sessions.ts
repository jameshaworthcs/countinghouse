// Claude sessions (the Claude sessions page; docs/ARCHITECTURE.md, "Claude sessions"): every time
// the app runs Claude, a record of what started it, the model, prompt version, timing and cost, and
// a transcript of the whole run: the system prompt and prompt the app sent, then every event the
// engine streamed back (turns, tool calls and their results, the final output).
//
// - Kept in the work area, never in data/, git or logs. The record is in sessions/<id>.json; the
//   transcript beside what it belongs to: jobs/<jobId>/, imports/<importId>/, rereads/<importId>/
//   or receipts/<receiptId>/, as <id>.jsonl (0600, directories 0700).
// - Transcripts hold what Claude saw, document contents included, with two exceptions: a file's
//   bytes (base64 images and PDFs) are left out, being the document itself, and account and card
//   numbers keep their last 4 digits, as everywhere else.
// - Capped: one transcript stops at a size (its final result is still written), all of them
//   together at another (the oldest go first), and each is deleted after the retention period. The
//   record stays, saying so.

import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionKind, SessionRecord, SessionStatus } from '../shared/sessions';
import { currentActor, maskIdentifiers, type AuditLog } from './audit';
import { atomicWrite, randomHex } from './fsutil';

/** Session times: UTC to the millisecond, so the order of quick runs is kept. */
const nowISO = (d: Date = new Date()) => d.toISOString();

export interface SessionLimits {
  /** Days a transcript is kept after its session ends. */
  days: number;
  /** One transcript's cap. */
  maxBytes: number;
  /** All transcripts together. */
  totalBytes: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = { days: 90, maxBytes: 10 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 };

/** Where a session's events go as they arrive (the engines write to it). */
export interface TranscriptSink {
  write(event: Record<string, unknown>): void;
}

export type StartSession = Omit<SessionRecord, 'id' | 'status' | 'startedAt' | 'transcript' | 'startedBy'> & { startedBy?: SessionRecord['startedBy'] };

/** Records kept: the newest this many (each is small; their transcripts go much sooner). */
const MAX_RECORDS = 5000;
/** One event's strings are cut at this length, and an event bigger than MAX_EVENT is left out. */
const MAX_STRING = 200_000;
const MAX_EVENT = 1024 * 1024;
/** The record on disk, and the browser, hear about a running session at most this often. */
const SAVE_EVERY_MS = 1000;
const SWEEP_EVERY_MS = 6 * 3600_000;

/** A file's bytes left out of a transcript; long strings cut; identifiers masked. */
export function sanitiseEvent(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    // An image sent inline (the local model service takes them as data: URIs).
    if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(v)) return `[not kept: the file's ${v.length} characters of base64]`;
    const s = maskIdentifiers(v);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… [cut: ${s.length} characters]` : s;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > 40) return '…';
  if (Array.isArray(v)) return v.map((x) => sanitiseEvent(x, depth + 1));
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    // A file sent as base64 (an image, a PDF): the document itself, kept elsewhere.
    if (k === 'data' && o.type === 'base64' && typeof x === 'string') out[k] = `[not kept: the file's ${x.length} characters of base64]`;
    else out[k] = sanitiseEvent(x, depth + 1);
  }
  return out;
}

/** Which directory of the work area a session's transcript sits in, beside what it belongs to. */
function transcriptDir(kind: SessionKind, r: Pick<SessionRecord, 'jobId' | 'importId' | 'receiptId'>): string {
  const safe = (s: string | undefined) => (s ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  if (kind === 'job') return path.join('jobs', safe(r.jobId));
  if (kind === 'reading') return path.join('imports', safe(r.importId));
  if (kind === 'reread') return path.join('rereads', safe(r.importId));
  return path.join('receipts', safe(r.receiptId));
}

/** One running session: its transcript is written as events arrive. */
export class Session implements TranscriptSink {
  private fd: number | undefined;
  private done = false;
  private cut = false;

  constructor(
    private readonly log: SessionLog,
    public record: SessionRecord,
    private readonly file: string,
  ) {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.fd = openSync(file, 'a', 0o600);
    } catch (err) {
      console.warn(`[sessions] could not open a transcript: ${(err as Error).message}`);
    }
  }

  get id(): string {
    return this.record.id;
  }

  write(event: Record<string, unknown>): void {
    if (this.done) return;
    this.learn(event);
    const result = event.type === 'result';
    // Over the cap, only the final result is still written.
    if (this.cut && !result) return;
    let line = `${JSON.stringify({ at: nowISO(), ...(sanitiseEvent(event) as Record<string, unknown>) })}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT) line = `${JSON.stringify({ at: nowISO(), type: 'finance.omitted', was: typeof event.type === 'string' ? event.type : 'event', bytes: Buffer.byteLength(line) })}\n`;
    const t = this.record.transcript;
    if (!result && t.bytes + Buffer.byteLength(line) > this.log.limits.maxBytes) {
      this.cut = true;
      t.truncated = true;
      line = `${JSON.stringify({ at: nowISO(), type: 'finance.truncated', note: `The transcript reached its cap of ${Math.round(this.log.limits.maxBytes / 1024 / 1024)} MB: later events are left out, except the final result.` })}\n`;
    }
    this.append(line);
  }

  private append(line: string): void {
    if (this.fd === undefined) return;
    try {
      const buf = Buffer.from(line, 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(this.fd, buf, off);
      this.record.transcript.events++;
      this.record.transcript.bytes += buf.length;
      this.log.touched(this);
    } catch (err) {
      console.warn(`[sessions] could not write a transcript: ${(err as Error).message}`);
    }
  }

  /** What the engine's own events say: the model that answered, turns, tokens and cost. */
  private learn(e: Record<string, unknown>): void {
    const r = this.record;
    if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') r.modelUsed ??= e.model;
    if (e.type !== 'result') return;
    if (typeof e.total_cost_usd === 'number') r.costUsd = Math.round(e.total_cost_usd * 10_000) / 10_000;
    if (typeof e.num_turns === 'number') r.turns = e.num_turns;
    const models = e.modelUsage && typeof e.modelUsage === 'object' ? Object.keys(e.modelUsage) : [];
    if (models[0]) r.modelUsed = models[0];
    if (typeof e.model === 'string') r.modelUsed = e.model;
    if (e.provenance && typeof e.provenance === 'object' && !Array.isArray(e.provenance)) r.inference = e.provenance as Record<string, unknown>;
    const u = e.usage as Record<string, unknown> | undefined;
    if (u && typeof u === 'object') {
      const n = (k: string) => (typeof u[k] === 'number' ? (u[k]) : undefined);
      const usage = { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadTokens: n('cache_read_input_tokens'), cacheCreationTokens: n('cache_creation_input_tokens') };
      r.usage = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined));
    }
  }

  /** The session ended. Its record is saved and the audit log told. */
  async finish(status: Exclude<SessionStatus, 'running'>, error?: string): Promise<void> {
    if (this.done) return;
    if (error) this.write({ type: 'finance.error', status, error: error.slice(0, 4000) });
    this.done = true;
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = undefined;
    }
    const r = this.record;
    r.status = status;
    r.finishedAt = nowISO();
    r.durationMs = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    if (error) r.error = maskIdentifiers(error).slice(0, 2000);
    await this.log.ended(this);
  }

  /** Run `fn` as this session: it ends succeeded, or failed (cancelled when `signal` was aborted). */
  async run<T>(fn: (sink: TranscriptSink) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      const out = await fn(this);
      await this.finish('succeeded');
      return out;
    } catch (err) {
      await this.finish(signal?.aborted ? 'cancelled' : 'failed', (err as Error).message);
      throw err;
    }
  }
}

export class SessionLog extends EventEmitter {
  private records = new Map<string, SessionRecord>();
  private live = new Map<string, Session>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private saving = new Map<string, Promise<void>>();
  private sweepTimer?: NodeJS.Timeout | undefined;
  /** When the app first kept sessions here: anything before has no transcript. */
  since = nowISO();
  readonly dir: string;

  constructor(
    readonly workDir: string,
    readonly limits: SessionLimits = DEFAULT_SESSION_LIMITS,
    private readonly audit?: AuditLog,
  ) {
    super();
    this.dir = path.join(workDir, 'sessions');
  }

  async init(opts: { sweep?: boolean } = {}): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const sinceFile = path.join(this.dir, 'since');
    try {
      this.since = (await readFile(sinceFile, 'utf8')).trim() || this.since;
    } catch {
      await atomicWrite(sinceFile, `${this.since}\n`, 0o600);
    }
    for (const f of (await readdir(this.dir)).filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(await readFile(path.join(this.dir, f), 'utf8')) as SessionRecord;
        if (typeof r.id !== 'string' || !r.transcript) continue;
        // A session the app stopped in the middle of is not coming back.
        if (r.status === 'running') {
          r.status = 'failed';
          r.error = 'Stopped when the app restarted.';
          r.finishedAt ??= nowISO();
          await this.persist(r);
        }
        this.records.set(r.id, r);
      } catch {
        console.warn(`[sessions] ignoring unreadable session record ${f}`);
      }
    }
    if (opts.sweep !== false) {
      await this.sweep();
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
      this.sweepTimer.unref();
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    for (const t of this.saveTimers.values()) clearTimeout(t);
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id));
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  /** A session starts: its record is written and the audit log told before the engine runs. */
  async start(input: StartSession): Promise<Session> {
    const id = `ses_${Date.now().toString(36)}${randomHex(4)}`;
    const rel = path.join(transcriptDir(input.kind, input), `${id}.jsonl`);
    const record: SessionRecord = {
      ...input,
      id,
      startedBy: input.startedBy ?? { actor: currentActor(), reason: '' },
      status: 'running',
      startedAt: nowISO(),
      transcript: { path: rel, events: 0, bytes: 0 },
    };
    this.records.set(id, record);
    const session = new Session(this, record, path.join(this.workDir, rel));
    this.live.set(id, session);
    await this.persist(record);
    const parent = record.jobId ?? record.importId ?? record.receiptId;
    this.audit?.record({
      category: 'session',
      action: 'session.start',
      summary: `Agent session started: ${record.title} (${record.model}, ${record.engine})`,
      targets: [id, ...(parent ? [parent] : []), ...(record.transactionId ? [record.transactionId] : [])],
      details: { sessionId: id, kind: record.kind, ...(record.jobKind ? { jobKind: record.jobKind } : {}), ...(record.role ? { role: record.role } : {}), engine: record.engine, model: record.model, ...(record.promptVersion ? { promptVersion: record.promptVersion } : {}), tools: record.tools, reason: record.startedBy.reason },
    });
    this.emit('update', record);
    this.prune();
    return session;
  }

  /** A running session wrote something: save its record and tell the browser, at most once a second. */
  touched(s: Session): void {
    if (this.saveTimers.has(s.id)) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(s.id);
      if (this.live.has(s.id)) {
        void this.persist(s.record);
        this.emit('update', s.record);
      }
    }, SAVE_EVERY_MS);
    t.unref();
    this.saveTimers.set(s.id, t);
  }

  async ended(s: Session): Promise<void> {
    clearTimeout(this.saveTimers.get(s.id));
    this.saveTimers.delete(s.id);
    this.live.delete(s.id);
    const r = s.record;
    await this.persist(r);
    const parent = r.jobId ?? r.importId ?? r.receiptId;
    const cost = r.costUsd !== undefined ? `, $${r.costUsd.toFixed(2)}` : '';
    this.audit?.record({
      category: 'session',
      action: `session.${r.status}`,
      outcome: r.status === 'failed' ? 'failed' : 'ok',
      summary: `Agent session ${r.status === 'succeeded' ? 'finished' : r.status}: ${r.title}${cost}${r.error ? ` (${r.error.slice(0, 200)})` : ''}`,
      targets: [r.id, ...(parent ? [parent] : [])],
      details: {
        sessionId: r.id,
        kind: r.kind,
        model: r.modelUsed ?? r.model,
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
        ...(r.turns !== undefined ? { turns: r.turns } : {}),
        events: r.transcript.events,
        ...(r.transcript.truncated ? { truncated: true } : {}),
        ...(r.error ? { error: r.error } : {}),
      },
    });
    this.emit('update', r);
  }

  private persist(r: SessionRecord): Promise<void> {
    // One write at a time per record, the latest last.
    const prev = this.saving.get(r.id) ?? Promise.resolve();
    const next = prev
      .then(() => atomicWrite(path.join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 1), 0o600))
      .catch((err: Error) => console.warn(`[sessions] could not save ${r.id}: ${err.message}`));
    this.saving.set(r.id, next);
    return next;
  }

  /** A transcript's events, from `from` on (at most `limit`), and how many there are. */
  async transcript(id: string, from = 0, limit = 5000): Promise<{ events: unknown[]; total: number } | undefined> {
    const r = this.records.get(id);
    if (!r) return undefined;
    if (r.transcript.removed) return { events: [], total: 0 };
    let text: string;
    try {
      text = await readFile(path.join(this.workDir, r.transcript.path), 'utf8');
    } catch {
      return { events: [], total: 0 };
    }
    const lines = text.split('\n').filter(Boolean);
    const events: unknown[] = [];
    for (const line of lines.slice(from, from + limit)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ type: 'finance.unreadable', text: line.slice(0, 500) });
      }
    }
    return { events, total: lines.length };
  }

  /** Bytes held by transcripts not yet removed. */
  bytes(): number {
    return this.list().reduce((sum, r) => sum + (r.transcript.removed ? 0 : r.transcript.bytes), 0);
  }

  /** Delete transcripts past the retention period, then the oldest while over the total cap. */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    const cutoff = now - this.limits.days * 86_400_000;
    const ended = this.list()
      .filter((r) => r.status !== 'running' && !r.transcript.removed)
      .reverse();
    let total = this.bytes();
    for (const r of ended) {
      const expired = Date.parse(r.finishedAt ?? r.startedAt) < cutoff;
      if (!expired && total <= this.limits.totalBytes) continue;
      await rm(path.join(this.workDir, r.transcript.path), { force: true });
      total -= r.transcript.bytes;
      r.transcript.removed = { at: nowISO(new Date(now)), why: expired ? 'expired' : 'over-total' };
      await this.persist(r);
      removed++;
    }
    // A transcript directory left empty goes too.
    for (const sub of ['jobs', 'imports', 'rereads', 'receipts']) {
      let dirs: string[] = [];
      try {
        dirs = (await readdir(path.join(this.workDir, sub), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const d of dirs) {
        const abs = path.join(this.workDir, sub, d);
        try {
          if ((await readdir(abs)).length === 0 && (await stat(abs)).mtimeMs < now - 3600_000) await rm(abs, { recursive: true, force: true });
        } catch {
          // gone already
        }
      }
    }
    return removed;
  }

  /** Keep the newest records; the oldest go with their transcripts. */
  private prune(): void {
    if (this.records.size <= MAX_RECORDS) return;
    for (const r of this.list().slice(MAX_RECORDS)) {
      if (r.status === 'running') continue;
      this.records.delete(r.id);
      void rm(path.join(this.dir, `${r.id}.json`), { force: true });
      void rm(path.join(this.workDir, r.transcript.path), { force: true });
    }
  }
}

/** The limits from the environment: FINANCE_TRANSCRIPT_DAYS, FINANCE_TRANSCRIPT_MAX_MB, FINANCE_TRANSCRIPTS_TOTAL_MB. */
export function sessionLimitsFromEnv(env: NodeJS.ProcessEnv): SessionLimits {
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return v && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const mb = 1024 * 1024;
  return {
    days: num(env.FINANCE_TRANSCRIPT_DAYS, DEFAULT_SESSION_LIMITS.days, 1, 3650),
    maxBytes: Math.round(num(env.FINANCE_TRANSCRIPT_MAX_MB, DEFAULT_SESSION_LIMITS.maxBytes / mb, 0.1, 500) * mb),
    totalBytes: Math.round(num(env.FINANCE_TRANSCRIPTS_TOTAL_MB, DEFAULT_SESSION_LIMITS.totalBytes / mb, 1, 100_000) * mb),
  };
}
