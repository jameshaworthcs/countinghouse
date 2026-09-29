// The agent job runner: a small persistent queue (in the work area, not data/), one job at a time,
// through the logged-in claude CLI. It knows what is stale, and it starts jobs on its own only in
// a few conservative cases, each of which can be turned off in Settings → Agents:
//   - a fund or provider you hold that has never been researched;
//   - research older than the staleness setting (at most three refreshes a day);
//   - assumptions still on fallbacks, or past their review date (at most once a week);
//   - insights after imports are committed; a month in review once a month's data is complete.
// Outputs go through the validated write path (records.ts) with provenance naming the job.

import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { assumptionDef, AssumptionSet } from '../../shared/assumptions';
import { addDays, diffDays, today } from '../../shared/dates';
import { fullerName } from '../../shared/funds';
import type { Analytics } from '../analytics';
import { latestResearch, matchInstrument } from '../analytics/research';
import type { Config } from '../config';
import type { JobQueue } from '../context';
import { atomicWrite, nowISO, randomHex } from '../fsutil';
import { detectEngines } from '../ingest/engines';
import { applyRecords } from '../records';
import type { Store } from '../store';
import { runAgent } from './claude';
import { JOB_DEFS, JOB_KINDS, outputJsonSchema, REFRESHABLE_KEYS, type JobKind } from './kinds';

export const JobRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(JOB_KINDS),
  label: z.string(),
  params: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  /** Who started it: you, an agent's token (waits for the budget, like the app's own), or the app. */
  trigger: z.enum(['owner', 'agent', 'post-import', 'schedule', 'stale']),
  privacy: z.enum(['public', 'personal']),
  promptVersion: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  model: z.string().optional(),
  costUsd: z.number().optional(),
  turns: z.number().optional(),
  summary: z.string().optional(),
  written: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
  error: z.string().optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export interface Suggestion {
  kind: JobKind;
  params: Record<string, unknown>;
  label: string;
  reason: string;
  /** Started automatically (subject to the daily limits) when agents are on. */
  auto: boolean;
}

const MAX_KEPT = 300;
/** Jobs that research on the web: they start by themselves only when Settings → Agents allows it. */
const RESEARCH_KINDS = new Set(['research-instrument', 'research-provider', 'refresh-assumptions']);
const MAX_STALE_REFRESH_PER_DAY = 3;

/**
 * What a job of each kind costs, measured (docs/AGENTS.md): it stands in for a job that ended
 * without reporting its cost (failed, timed out, cancelled), which still used the plan.
 */
const TYPICAL_COST_USD: Record<string, number> = {
  'refresh-assumptions': 8.5,
  'research-instrument': 1.6,
  'research-provider': 0.7,
  'insights-after-import': 0.3,
  'monthly-review': 0.25,
  'interpret-note': 0.1,
};

export interface BackgroundBudget {
  perDayUsd: number;
  perMonthUsd: number;
  spentTodayUsd: number;
  spentThisMonthUsd: number;
  /** Whether a job the app starts by itself may start now. */
  open: boolean;
}

export class JobRunner extends EventEmitter implements JobQueue {
  private jobs = new Map<string, JobRecord>();
  private current?: { id: string; abort: AbortController } | undefined;
  private importIds: string[] = [];
  private importTimer?: NodeJS.Timeout | undefined;
  private timer?: NodeJS.Timeout | undefined;
  private firstTick?: NodeJS.Timeout | undefined;
  readonly dir: string;

  constructor(
    private readonly store: Store,
    private readonly analytics: Analytics,
    private readonly config: Config,
    /** autoRun: start due jobs by themselves. paused: queue jobs without running them (tests). */
    private readonly opts: { autoRun: boolean; paused?: boolean } = { autoRun: true },
  ) {
    super();
    this.dir = path.join(config.workDir, 'jobs');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const f of (await readdir(this.dir)).filter((x) => x.endsWith('.json'))) {
      try {
        const job = JobRecordSchema.parse(JSON.parse(await readFile(path.join(this.dir, f), 'utf8')));
        // A job interrupted by a restart goes back in the queue.
        if (job.status === 'running') job.status = 'queued';
        this.jobs.set(job.id, job);
      } catch {
        // an unreadable job record is ignored
      }
    }
    if (this.opts.autoRun) {
      this.timer = setInterval(() => void this.tick(), 6 * 3600_000);
      this.timer.unref();
      this.firstTick = setTimeout(() => void this.tick(), 20_000);
      this.firstTick.unref();
    }
    this.pump();
  }

  /** Whether due jobs start by themselves (a serving instance over real data). */
  get startsJobs(): boolean {
    return this.opts.autoRun;
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.firstTick);
    clearTimeout(this.importTimer);
    this.current?.abort.abort();
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  private async save(job: JobRecord): Promise<void> {
    this.jobs.set(job.id, job);
    await atomicWrite(path.join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 1));
    this.emit('update', job);
    // Keep the most recent records.
    const all = this.list();
    for (const old of all.slice(MAX_KEPT)) {
      if (old.status === 'queued' || old.status === 'running') continue;
      this.jobs.delete(old.id);
      await rm(path.join(this.dir, `${old.id}.json`), { force: true });
    }
  }

  enqueue(input: { kind: string; params?: Record<string, unknown>; trigger: JobRecord['trigger'] }): JobRecord | undefined {
    const kind = input.kind as JobKind;
    const def = JOB_DEFS[kind];
    if (!def) throw new Error(`Unknown job kind ${input.kind}`);
    if (!this.store.settings.agents.enabled && input.trigger !== 'owner') return undefined;
    const params = input.params ?? {};
    const same = [...this.jobs.values()].find((j) => j.kind === kind && JSON.stringify(j.params) === JSON.stringify(params) && (j.status === 'queued' || j.status === 'running'));
    if (same) return same;
    const job: JobRecord = {
      id: `job_${Date.now().toString(36)}${randomHex(3)}`,
      kind,
      label: def.label({ store: this.store, params }),
      params,
      status: 'queued',
      trigger: input.trigger,
      privacy: def.privacy,
      promptVersion: def.promptVersion,
      createdAt: nowISO(),
    };
    void this.save(job).then(() => this.pump());
    return job;
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job');
    if (job.status === 'running' && this.current?.id === id) this.current.abort.abort();
    if (job.status === 'queued' || job.status === 'running') await this.save({ ...job, status: 'cancelled', finishedAt: nowISO() });
    return this.jobs.get(id)!;
  }

  rerun(id: string, trigger: 'owner' | 'agent' = 'owner'): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job');
    return this.enqueue({ kind: job.kind, params: job.params, trigger });
  }

  /** An import was committed: insights follow once imports stop arriving for a while. */
  onImportCommitted(importId: string): void {
    if (!this.store.settings.agents.enabled || !this.store.settings.agents.insightsAfterImport || !this.opts.autoRun) return;
    this.importIds.push(importId);
    clearTimeout(this.importTimer);
    this.importTimer = setTimeout(() => {
      const ids = [...this.importIds];
      this.importIds = [];
      this.enqueue({ kind: 'insights-after-import', params: { importIds: ids }, trigger: 'post-import' });
      void this.tick();
    }, 120_000);
    this.importTimer.unref();
  }

  /** What jobs started by the app itself have spent today and this month, against the budget. */
  budget(on: string = today()): BackgroundBudget {
    const settings = this.store.settings.agents;
    let day = 0;
    let month = 0;
    for (const j of this.list()) {
      if (j.trigger === 'owner' || j.status === 'queued') continue;
      const when = (j.startedAt ?? j.createdAt).slice(0, 10);
      if (when.slice(0, 7) !== on.slice(0, 7)) continue;
      // A running job, or one that ended without a cost, counts at what its kind typically costs.
      const cost = j.costUsd ?? (j.status === 'running' || j.status === 'failed' || (j.status === 'cancelled' && j.startedAt) ? (TYPICAL_COST_USD[j.kind] ?? 1) : 0);
      month += cost;
      if (when === on) day += cost;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      perDayUsd: settings.backgroundBudgetPerDayUsd,
      perMonthUsd: settings.backgroundBudgetPerMonthUsd,
      spentTodayUsd: round(day),
      spentThisMonthUsd: round(month),
      open: day < settings.backgroundBudgetPerDayUsd && month < settings.backgroundBudgetPerMonthUsd,
    };
  }

  private pump(): void {
    if (this.current || this.opts.paused) return;
    // Jobs you started go first and are never held back; the app's own wait for the budget.
    const queued = this.list()
      .filter((j) => j.status === 'queued')
      .sort((a, b) => Number(b.trigger === 'owner') - Number(a.trigger === 'owner') || a.createdAt.localeCompare(b.createdAt));
    const open = this.budget().open;
    const autoResearch = this.store.settings.agents.autoResearch;
    const next = queued.find((j) => j.trigger === 'owner' || (open && (autoResearch || !RESEARCH_KINDS.has(j.kind))));
    if (!next) return;
    const abort = new AbortController();
    this.current = { id: next.id, abort };
    void this.run(next, abort.signal).finally(() => {
      this.current = undefined;
      this.pump();
    });
  }

  private async run(queued: JobRecord, signal: AbortSignal): Promise<void> {
    const def = JOB_DEFS[queued.kind];
    const started = Date.now();
    let job: JobRecord = { ...queued, status: 'running', startedAt: nowISO() };
    delete job.error;
    await this.save(job);
    const scratch = path.join(this.config.workDir, 'agent', job.id);
    try {
      const { engines, claudeBin } = await detectEngines({ apiKey: this.config.anthropicApiKey });
      if (!claudeBin || !engines.find((e) => e.id === 'claude-cli')?.available) throw new Error('The claude CLI is not available; agent jobs need it.');
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const ctx = { store: this.store, analytics: this.analytics, params: job.params, scratch };
      const prompt = await Promise.resolve(def.prepare(ctx));
      const settings = this.store.settings.agents;
      const res = await runAgent({
        bin: claudeBin,
        cwd: scratch,
        prompt,
        systemPrompt: def.systemPrompt,
        schema: outputJsonSchema(def),
        tools: def.tools,
        model: settings.model,
        effort: settings.effort,
        timeoutMs: settings.timeoutSeconds * 1000,
        signal,
      });
      const output = def.output.parse(res.output);
      const outcome = await def.apply(ctx, output, { setBy: 'agent', model: res.model, promptVersion: def.promptVersion, jobId: job.id });
      job = {
        ...job,
        status: 'succeeded',
        finishedAt: nowISO(),
        durationMs: Date.now() - started,
        model: res.model,
        ...(res.costUsd !== undefined ? { costUsd: Math.round(res.costUsd * 10_000) / 10_000 } : {}),
        ...(res.turns !== undefined ? { turns: res.turns } : {}),
        summary: outcome.summary,
        written: outcome.result?.written ?? [],
      };
    } catch (err) {
      const cancelled = signal.aborted || this.jobs.get(job.id)?.status === 'cancelled';
      job = { ...job, status: cancelled ? 'cancelled' : 'failed', finishedAt: nowISO(), durationMs: Date.now() - started, error: (err as Error).message.slice(0, 2000) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    await this.save(job);
  }

  // ─── What is stale, and what runs by itself ──────────────────────────────────────────────────

  /**
   * Instruments for holdings that have none yet: the app records the fund's name and identifiers
   * as they appear on the statement (a fact, not an inference), so research can follow.
   */
  async ensureInstrumentsFromHoldings(): Promise<number> {
    const seen = new Map<string, { name: string; isin?: string; ticker?: string; sedol?: string }>();
    // A fund first recorded under a name cut short takes the full name when a statement prints
    // it; the short one stays as an alias, so older holdings still match.
    const renamed = new Map<string, { id: string; name: string; aliases: string[]; sedol?: string }>();
    for (const a of this.store.accounts.filter((x) => x.status === 'open')) {
      const snap = this.store.holdings(a.id).at(-1);
      for (const h of snap?.holdings ?? []) {
        const known = matchInstrument(h, this.store.instruments);
        if (known) {
          const name = fullerName(renamed.get(known.id)?.name ?? known.name, h.name);
          const sedol = !known.sedol && h.sedol ? h.sedol : undefined;
          if (name !== known.name || sedol) renamed.set(known.id, { id: known.id, name, aliases: name !== known.name ? [known.name] : [], ...(sedol ? { sedol } : {}) });
          continue;
        }
        const key = h.isin?.toUpperCase() ?? h.sedol?.toUpperCase() ?? h.ticker?.toUpperCase() ?? h.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: h.name, ...(h.isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(h.isin.toUpperCase()) ? { isin: h.isin.toUpperCase() } : {}), ...(h.ticker ? { ticker: h.ticker } : {}), ...(h.sedol ? { sedol: h.sedol } : {}) });
      }
    }
    if (!seen.size && !renamed.size) return 0;
    await applyRecords(this.store, {
      provenance: { setBy: 'system', session: 'holdings' },
      supersede: false,
      records: [
        ...[...seen.values()].map((r) => ({ type: 'instrument' as const, record: { ...r, aliases: [] } })),
        ...[...renamed.values()].map((r) => ({ type: 'instrument' as const, record: r })),
      ],
    });
    return seen.size;
  }

  suggestions(on: string = today()): Suggestion[] {
    const out: Suggestion[] = [];
    const staleDays = this.store.settings.agents.researchStaleAfterDays;
    const age = (createdAt: string) => diffDays(createdAt.slice(0, 10), on);
    for (const i of this.store.instruments) {
      const facts = latestResearch(this.store, 'instrument.facts', { instrumentId: i.id });
      if (!facts) out.push({ kind: 'research-instrument', params: { instrumentId: i.id }, label: `Research ${i.name}`, reason: 'Never researched', auto: true });
      else if (age(facts.createdAt) > staleDays) out.push({ kind: 'research-instrument', params: { instrumentId: i.id }, label: `Research ${i.name}`, reason: `Last researched ${age(facts.createdAt)} days ago`, auto: true });
    }
    const providers = new Map<string, Set<string>>();
    for (const a of this.store.accounts.filter((x) => x.status === 'open' && x.institutionId)) {
      const meta = ACCOUNT_TYPE_META[a.type];
      const wantsRates = a.type === 'savings' || a.type === 'cash_isa';
      const wantsFees = meta.balanceMode === 'market' && a.type !== 'db_pension' && a.type !== 'state_pension' && a.type !== 'property' && a.type !== 'other_asset' && a.type !== 'crypto';
      if (wantsRates || wantsFees) (providers.get(a.institutionId!) ?? providers.set(a.institutionId!, new Set()).get(a.institutionId!)!).add(wantsRates ? 'rates' : 'fees');
    }
    for (const [institutionId, wants] of providers) {
      const inst = this.store.institution(institutionId);
      if (!inst || inst.kind === 'government') continue;
      const latest = [...wants].map((w) => latestResearch(this.store, w === 'rates' ? 'provider.rates' : 'provider.fees', { institutionId }));
      const missing = latest.some((r) => !r);
      const oldest = latest.filter((r) => r).map((r) => age(r!.createdAt));
      if (missing) out.push({ kind: 'research-provider', params: { institutionId }, label: `Research ${inst.name}`, reason: `No ${[...wants].join(' or ')} researched yet`, auto: true });
      else if (Math.max(...oldest) > staleDays) out.push({ kind: 'research-provider', params: { institutionId }, label: `Research ${inst.name}`, reason: `Last researched ${Math.max(...oldest)} days ago`, auto: true });
    }
    const set = new AssumptionSet(this.store.assumptions, on);
    const onFallback = REFRESHABLE_KEYS.filter((k) => !k.startsWith('return.') && set.resolve(k).source === 'fallback');
    const classFallback = ['equity', 'bond'].filter((c) => set.resolve('return.expected', { assetClass: c as 'equity' }).source === 'fallback');
    const stale = set.active().filter((a) => a.provenance.setBy !== 'owner' && a.reviewBy && a.reviewBy < on);
    if (onFallback.length || classFallback.length || stale.length) {
      out.push({
        kind: 'refresh-assumptions',
        params: {},
        label: 'Refresh modelling assumptions',
        reason: stale.length
          ? `${stale.length} assumption${stale.length > 1 ? 's' : ''} past ${stale.length > 1 ? 'their' : 'its'} review date`
          : `Still on fallbacks: ${[...onFallback.map((k) => assumptionDef(k)?.label.toLowerCase() ?? k), ...classFallback.map((c) => `${c === 'equity' ? 'share' : c} returns`)].join(', ')}`,
        auto: true,
      });
    }
    const month = this.analytics.coverage().lastCompleteMonth;
    if (month && this.store.settings.agents.monthlyReview && !this.store.insights.some((i) => i.kind === 'month-review' && i.subject.month === month && i.status !== 'dismissed')) {
      out.push({ kind: 'monthly-review', params: { month }, label: `Month in review: ${month}`, reason: 'Every account has data for the whole month', auto: true });
    }
    return out;
  }

  /** Start what is due: at most a few research refreshes a day, assumptions at most weekly. */
  async tick(on: string = today()): Promise<void> {
    // Jobs held back yesterday by the budget may start today.
    this.pump();
    if (!this.store.settings.agents.enabled || !this.opts.autoRun) return;
    try {
      await this.ensureInstrumentsFromHoldings();
    } catch (err) {
      console.error(`[agents] could not record instruments from holdings: ${(err as Error).message}`);
    }
    const recent = this.list().filter((j) => j.createdAt.slice(0, 10) >= addDays(on, -1) && j.trigger !== 'owner');
    let refreshBudget = MAX_STALE_REFRESH_PER_DAY - recent.filter((j) => j.trigger === 'stale').length;
    const staleDays = this.store.settings.agents.researchStaleAfterDays;
    for (const s of this.suggestions(on)) {
      if (!s.auto) continue;
      // Research runs when you ask for it, unless you let it start by itself.
      if (RESEARCH_KINDS.has(s.kind) && !this.store.settings.agents.autoResearch) continue;
      if (s.kind === 'refresh-assumptions' && this.list().some((j) => j.kind === 'refresh-assumptions' && j.createdAt.slice(0, 10) >= addDays(on, -7))) continue;
      // The same job ran successfully within the staleness window: it recorded what it could find,
      // and running it again by itself would only spend the plan (the owner can still rerun it).
      const last = this.list().find((j) => j.kind === s.kind && JSON.stringify(j.params) === JSON.stringify(s.params));
      if (last?.status === 'succeeded' && diffDays((last.finishedAt ?? last.createdAt).slice(0, 10), on) < staleDays) continue;
      const neverDone = /Never|No .* researched/.test(s.reason);
      if (!neverDone && s.kind !== 'monthly-review') {
        if (refreshBudget <= 0) continue;
        refreshBudget--;
      }
      // A failed job is not retried by itself within a day.
      if (this.list().some((j) => j.kind === s.kind && JSON.stringify(j.params) === JSON.stringify(s.params) && j.status === 'failed' && j.createdAt.slice(0, 10) >= addDays(on, -1))) continue;
      this.enqueue({ kind: s.kind, params: s.params, trigger: neverDone || s.kind === 'monthly-review' ? 'schedule' : 'stale' });
    }
  }
}
