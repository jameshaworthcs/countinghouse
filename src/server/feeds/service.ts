// The live feed: readings of an account's value and holdings from Trading 212's API (trading212.ts),
// often while someone has the app open and less often otherwise (docs/ARCHITECTURE.md, "Live feeds").
//
//   - Optional. With no key set it is off: nothing is scheduled and nothing is asked.
//   - Every reading is appended to the work area (feeds/trading-212/<yyyy-mm>.jsonl), never to
//     data/: it is not a Store write, so it changes no figure, makes no commit and refreshes no page
//     but the ones showing it (the 'feed' server-sent event).
//   - Cadence: every `watchedSeconds` while a page in the app is visible (the browser says so through
//     POST /api/feeds/trading-212/watch), every `backgroundMinutes` in market hours (weekdays
//     07:00–22:00 UK time, covering London and US trading), and every `quietMinutes` otherwise.
//     Failures back off; a refused key waits an hour; a rate limit waits for its reset.

import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FeedReading, FeedStatus, FeedTodayResponse } from '../../shared/feeds';
import type { Account } from '../../shared/schema';
import { nowISO } from '../fsutil';
import { T212Error, Trading212Client, toReading, type T212Config } from './trading212';

/** How long one "the app is open" from the browser counts for: it says so every 30s while visible. */
export const WATCH_HOLD_MS = 45_000;
/** A refresh asked for this soon after the last attempt is answered with the reading already held. */
export const MIN_REFRESH_GAP_MS = 5_000;
/** The longest wait after failures. */
const MAX_BACKOFF_MS = 60 * 60_000;

const FEED_ID = 'trading-212';

/** Monday–Friday, 07:00 to 22:00 in London: when London or New York is trading. */
export function inMarketHours(at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return !['Sat', 'Sun'].includes(day) && hour >= 7 && hour < 22;
}

interface Reader {
  summary: Trading212Client['summary'];
  positions: Trading212Client['positions'];
  readyAt: Trading212Client['readyAt'];
}

export interface LiveFeedOptions {
  /** The API client (tests pass one with a fake fetch). */
  client?: Reader;
  now?: () => number;
  /** Take readings by itself (a serving instance). Off in tests and scripts. */
  autoRun?: boolean;
  /** Told when the feed starts working or stops (the audit log records it). */
  onStateChange?: (change: { ok: boolean; message: string }) => void;
}

export class LiveFeedService extends EventEmitter {
  private readonly client: Reader | undefined;
  private readonly now: () => number;
  private readonly autoRun: boolean;
  private readonly dir: string;
  private latest: FeedReading | undefined;
  private todays: { date: string; points: { at: string; totalValue: number }[] } = { date: '', points: [] };
  private lastAttemptAt = 0;
  private lastError: string | undefined;
  private failures = 0;
  private waitUntil = 0;
  private watchedUntil = 0;
  private linkProblem: string | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private nextAt = 0;
  private running = false;
  private everOk: boolean | undefined;

  constructor(
    private readonly accounts: () => Account[],
    workDir: string,
    private readonly cfg: T212Config | undefined,
    private readonly opts: LiveFeedOptions = {},
  ) {
    super();
    // One listener per open page's event stream.
    this.setMaxListeners(0);
    this.now = opts.now ?? Date.now;
    this.autoRun = Boolean(opts.autoRun);
    this.dir = path.join(workDir, 'feeds', FEED_ID);
    this.client = cfg ? (opts.client ?? new Trading212Client(cfg, { now: this.now })) : undefined;
  }

  get configured(): boolean {
    return Boolean(this.cfg);
  }

  /** Load the latest reading and today's from the work area, then start taking readings when on. */
  async init(): Promise<void> {
    if (!this.cfg) return;
    const at = new Date(this.now());
    const readings = await this.readMonth(nowISO(at).slice(0, 7));
    this.latest = readings[readings.length - 1];
    const date = nowISO(at).slice(0, 10);
    this.todays = { date, points: readings.filter((r) => r.at.slice(0, 10) === date).map((r) => ({ at: r.at, totalValue: r.totalValue })) };
    if (this.autoRun) {
      this.running = true;
      this.schedule();
    }
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  status(): FeedStatus {
    const cfg = this.cfg;
    const intervals = { watchedSeconds: cfg?.watchedSeconds ?? 15, backgroundMinutes: cfg?.backgroundMinutes ?? 15, quietMinutes: cfg?.quietMinutes ?? 180 };
    const status: FeedStatus = { id: FEED_ID, name: 'Trading 212', configured: Boolean(cfg), running: this.running, accountId: null, failures: this.failures, watched: this.watched(), intervals };
    if (!cfg) return status;
    status.environment = cfg.environment;
    const linked = this.link(this.latest?.accountLast4);
    status.accountId = linked.accountId;
    if (linked.accountId) {
      const name = this.accounts().find((a) => a.id === linked.accountId)?.name;
      if (name) status.accountName = name;
    }
    const problem = linked.problem ?? this.linkProblem;
    if (problem && this.latest) status.linkProblem = problem;
    if (this.latest) status.latest = { ...this.latest, accountId: linked.accountId };
    if (this.lastAttemptAt) status.lastAttemptAt = nowISO(new Date(this.lastAttemptAt));
    if (this.lastError) status.lastError = this.lastError;
    if (this.running && this.nextAt) status.nextAt = nowISO(new Date(this.nextAt));
    return status;
  }

  /** Today's readings, oldest first. */
  today(): FeedTodayResponse {
    const date = nowISO(new Date(this.now())).slice(0, 10);
    return { id: FEED_ID, date, points: this.todays.date === date ? [...this.todays.points] : [] };
  }

  /** Someone has the app open: read often from now, and at once if the latest reading is older than that. */
  watch(): void {
    if (!this.cfg) return;
    this.watchedUntil = this.now() + WATCH_HOLD_MS;
    const age = this.latest ? this.now() - Date.parse(this.latest.at) : Infinity;
    if (age >= this.cfg.watchedSeconds * 1000 && this.now() >= this.dueAt()) void this.refresh();
    else this.schedule();
  }

  /**
   * Take a reading now, unless one is under way (it is waited for), one was tried in the last few
   * seconds, or a rate limit or failure says to wait.
   */
  async refresh(): Promise<void> {
    if (!this.cfg || !this.client) return;
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (now - this.lastAttemptAt < MIN_REFRESH_GAP_MS || now < this.waitUntil) {
      this.schedule();
      return;
    }
    this.inFlight = this.read().finally(() => {
      this.inFlight = undefined;
      this.schedule();
    });
    return this.inFlight;
  }

  private watched(): boolean {
    return this.now() < this.watchedUntil;
  }

  /** How long until the next reading is due, by what is happening now. */
  private intervalMs(): number {
    const cfg = this.cfg!;
    if (this.watched()) return cfg.watchedSeconds * 1000;
    return inMarketHours(new Date(this.now())) ? cfg.backgroundMinutes * 60_000 : cfg.quietMinutes * 60_000;
  }

  private dueAt(): number {
    if (!this.lastAttemptAt) return Math.max(this.waitUntil, 0);
    return Math.max(this.lastAttemptAt + this.intervalMs(), this.waitUntil);
  }

  private schedule(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const now = this.now();
    this.nextAt = Math.max(this.dueAt(), now);
    // Wake at least each minute, so a change of cadence (the app opened, market hours) is noticed.
    const wait = Math.min(this.nextAt - now, 60_000);
    this.timer = setTimeout(() => {
      if (this.now() >= this.dueAt()) void this.refresh();
      else this.schedule();
    }, wait);
    this.timer.unref?.();
  }

  private async read(): Promise<void> {
    const client = this.client!;
    const started = this.now();
    this.lastAttemptAt = started;
    try {
      const summary = await client.summary();
      const positions = await client.positions();
      const at = nowISO(new Date(this.now()));
      const reading = toReading(summary, positions, at, null);
      const linked = this.link(reading.accountLast4);
      reading.accountId = linked.accountId;
      this.linkProblem = linked.problem;
      await this.append(reading);
      this.latest = reading;
      const date = at.slice(0, 10);
      if (this.todays.date !== date) this.todays = { date, points: [] };
      this.todays.points.push({ at, totalValue: reading.totalValue });
      this.failures = 0;
      this.lastError = undefined;
      this.waitUntil = 0;
      if (this.everOk !== true) this.opts.onStateChange?.({ ok: true, message: `Trading 212 feed is reading the account${linked.accountId ? ` (${linked.accountId})` : ', not linked to an account yet'}` });
      this.everOk = true;
      this.emit('reading', reading);
    } catch (err) {
      const e = err instanceof T212Error ? err : new T212Error((err as Error).message || 'The reading failed.');
      if (e.status === 429 && e.retryAt) {
        // A rate limit is not a failure: wait for its reset.
        this.waitUntil = e.retryAt;
      } else {
        this.failures++;
        this.lastError = e.message;
        const interval = this.cfg ? this.intervalMs() : 60_000;
        const backoff = e.keyRefused ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, Math.max(interval, 15_000) * 2 ** Math.min(this.failures - 1, 10));
        this.waitUntil = this.now() + backoff;
        if (this.everOk !== false) this.opts.onStateChange?.({ ok: false, message: `Trading 212 feed failed: ${e.message}` });
        this.everOk = false;
      }
      this.emit('status');
    }
  }

  /** The app's account for a reading: the one named in .env, else the open Trading 212 account with its last 4 digits. */
  private link(last4: string | undefined): { accountId: string | null; problem?: string } {
    const accounts = this.accounts();
    if (this.cfg?.accountId) {
      const named = accounts.find((a) => a.id === this.cfg!.accountId);
      return named ? { accountId: named.id } : { accountId: null, problem: `FINANCE_T212_ACCOUNT names "${this.cfg.accountId}", which is not one of your accounts.` };
    }
    const t212 = accounts.filter((a) => a.institutionId === 'trading-212' && a.status === 'open');
    const named4 = this.cfg?.accountLast4;
    if (named4) {
      if (last4 && last4 !== named4) return { accountId: null, problem: `The key reads the Trading 212 account ending ${last4}, but FINANCE_T212_ACCOUNT gives one ending ${named4}.` };
      const matches = t212.filter((a) => a.last4 && (a.last4.endsWith(named4) || named4.endsWith(a.last4)));
      if (matches.length === 1) return { accountId: matches[0]!.id };
      return { accountId: null, problem: matches.length > 1 ? `More than one Trading 212 account ends in ${named4}: set FINANCE_T212_ACCOUNT to the app's account id instead.` : `No open Trading 212 account here ends in ${named4}: give the account those last 4 digits, or set FINANCE_T212_ACCOUNT to its account id.` };
    }
    if (!last4) return t212.length === 1 ? { accountId: t212[0]!.id } : { accountId: null, problem: 'Trading 212 did not give an account number: set FINANCE_T212_ACCOUNT to the account its readings belong to.' };
    const matches = t212.filter((a) => a.last4 && (a.last4.endsWith(last4) || last4.endsWith(a.last4)));
    if (matches.length === 1) return { accountId: matches[0]!.id };
    if (matches.length > 1) return { accountId: null, problem: `More than one Trading 212 account ends in ${last4}: set FINANCE_T212_ACCOUNT to the one its readings belong to.` };
    return { accountId: null, problem: `No open Trading 212 account here ends in ${last4}: give the account those last 4 digits, or set FINANCE_T212_ACCOUNT.` };
  }

  private async append(reading: FeedReading): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${reading.at.slice(0, 7)}.jsonl`), `${JSON.stringify(reading)}\n`, { mode: 0o600 });
  }

  private async readMonth(month: string): Promise<FeedReading[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.dir, `${month}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const out: FeedReading[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as FeedReading;
        if (r && typeof r.at === 'string' && typeof r.totalValue === 'number') out.push(r);
      } catch {
        // A line cut short by a crash: skip it.
      }
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}
