// Ask: conversations about your money (src/shared/ask.ts; docs/ARCHITECTURE.md, "Ask"; DECISIONS
// 2026-10-05). A question is answered step by step: at each step the model either calls one of the
// app's read-only tools (ask-tools.ts) for the data it needs, or answers. It never adds up rows
// itself: totals come from the tools, and a figure in an answer that the app finds in a tool's
// result is marked computed and links to where it can be checked; anything else is the model's.
//
// - Conversations are kept in the work area (`ask/<id>.json`, 0600), never in data/: an answer is an
//   inference. They go after the transcripts' retention period (90 days); Delete only hides one.
// - Each question (a turn) is a session of its own (kind `ask`), with its transcript beside the
//   conversation (`ask/<id>/`). Follow-ups queue behind the turn running; one turn runs at a time,
//   across conversations (the local model has one interactive slot). Stop works at any point.
// - The model is the owner's choice per question: the local model by default (nothing leaves the
//   machine), or Claude (what it looks up goes to Anthropic). On the local model the answer is
//   streamed, so the page shows what it is doing.

import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ASK_MODEL_OPTIONS, ASK_PROMPT_VERSION, type AskAnswer, type AskConversation, type AskConversationSummary, type AskDefaults, type AskFeedbackItem, type AskFigure, type AskLive, type AskModel, type AskModelId, type AskStep, type AskTurn } from '../shared/ask';
import { actorName, type AuditActor } from '../shared/audit';
import { CategoryIndex } from '../shared/categories';
import { addDays, addMonths, isISODate, startOfMonth, today } from '../shared/dates';
import { claudeChoice, resolveTask, TASKS } from '../shared/tasks';
import { runAgent } from './agents/claude';
import { trips } from './agents/digest';
import type { Analytics } from './analytics';
import { ASK_TOOLS, runTool, TOOL_ARGS_SCHEMA, TOOL_HELP, ToolError, type AskTool } from './ask-tools';
import { currentActor, currentRequestId, type AuditLog } from './audit';
import type { Config } from './config';
import { atomicWrite, nowISO, randomHex } from './fsutil';
import { chat, InferenceFailed, InferenceUnavailable } from './inference';
import { resolveClaudeBin } from './ingest/claude-cli';
import { SessionStopped, type Session, type SessionLog, type TranscriptSink } from './sessions';
import { StoreError, type Store } from './store';

export { ASK_PROMPT_VERSION };

/** A tool result is cut to this many characters (its counts and totals cover every row). */
const RESULT_CHARS = 12_000;
/** Earlier turns past this many characters are given as their questions and answers only. */
const HISTORY_CHARS = 60_000;
const SWEEP_EVERY_MS = 6 * 3600_000;
const LIVE_EVERY_MS = 1000;

// ─── The prompt (ask-2) ──────────────────────────────────────────────────────────────────────────

export function systemPrompt(maxToolCalls: number): string {
  return `You answer the owner's questions about their money, for a private UK personal-finance app. You look things up with the app's tools: the app runs them on its own data and gives you the results.

You work one step at a time. Each step is either:
- step "call": one tool, its args (every arg you do not use is null), and in why a few words on what you are looking for ("Payments in Malaysian ringgit"). The app answers with the result.
- step "answer": your answer, in answer, figures, confidence, caveats and cannotAnswer (tool, and every arg, null).

Tools:
${ASK_TOOLS.map((t) => `- ${TOOL_HELP[t]}`).join('\n')}

Rules:
- Every figure in your answer is from a tool's result, quoted as the result gives it, with the number of the step it came from (figures[].step). Never add up or work out a figure yourself: when you need a total no result gives, call sum with the ids, or find_transactions with filters that select exactly those rows.
- Look before you say you cannot answer. A country rarely appears in a payment's description: look for its currency (currency: MYR, EUR, THB…), its towns, the Holidays category, or trips. A shop or service: text. A kind of spending: spending_by or categories.
- Use the ids from the lists you are given for accounts and categories.
- When the results cannot answer it, set cannotAnswer and say what is missing; coverage says which days have no data.
- Amounts are signed: money in positive, money out negative. Write money as £1,234.56. Plain British English, short: a sentence or two, then the figures.
- caveats: what limits the answer: missing days, estimated balances, rows only partly listed, a guess about which payments belong. This is not advice.
- Your first step for each question is a call: look before you answer. At most ${maxToolCalls} tool calls for one question; then answer from what you have.
- In an answer, give confidence (high, medium or low), and figures and caveats (empty lists when there are none).
- An earlier question in the conversation and its answer are context: a follow-up ("and in July?") keeps their subject.`;
}

const nullable = (type: string | string[]) => ({ type: [...(Array.isArray(type) ? type : [type]), 'null'] });

/**
 * One step's schema: flat, every field present (null when not used), as the local model's grammar
 * needs. A question's first step must be a call (on the real service, the local model without
 * thinking otherwise answered "cannot say" before looking); after the last call allowed, an answer.
 */
export function stepSchema(only?: 'call' | 'answer'): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['step', 'why', 'tool', 'args', 'answer', 'figures', 'confidence', 'caveats', 'cannotAnswer'],
    properties: {
      step: { type: 'string', enum: only ? [only] : ['call', 'answer'] },
      why: { type: 'string' },
      tool: { type: ['string', 'null'], enum: [...ASK_TOOLS, null] },
      args: TOOL_ARGS_SCHEMA,
      answer: nullable('string'),
      figures: { type: ['array', 'null'], items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'step'], properties: { label: { type: 'string' }, value: { type: 'string' }, step: nullable('integer') } } },
      confidence: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
      caveats: { type: ['array', 'null'], items: { type: 'string' } },
      cannotAnswer: nullable('boolean'),
    },
  };
}

const StepOut = z.object({
  step: z.enum(['call', 'answer']),
  why: z.string().default(''),
  tool: z.string().nullable().default(null),
  args: z.record(z.string(), z.unknown()).nullable().default(null),
  answer: z.string().nullable().default(null),
  figures: z.array(z.object({ label: z.string(), value: z.string(), step: z.number().int().nullable().default(null) })).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
  caveats: z.array(z.string()).nullable().default(null),
  cannotAnswer: z.boolean().nullable().default(null),
});
type StepOut = z.infer<typeof StepOut>;

/**
 * What every question in a conversation starts from (about 2,000 tokens): the accounts, the
 * categories and the last 13 months' totals, computed by the app. The rest the model looks up.
 */
export function openingContext(store: Store, analytics: Analytics, now = today()): string {
  const cats = new CategoryIndex(store.categories);
  const engine = analytics.engine;
  const accounts = store.accounts.map((a) => {
    const first = engine.firstDataDate(a.id);
    const last = engine.lastDataDate(a.id);
    return `- ${a.id}: ${a.name} (${a.type}${a.currency !== 'GBP' ? `, ${a.currency}` : ''}${a.status === 'closed' ? ', closed' : ''}${first ? `; data ${first} to ${last}` : '; no data'})`;
  });
  const categories = store.categories
    .filter((c) => c.parent && !c.hidden && (c.kind === 'expense' || c.kind === 'income'))
    .map((c) => `${c.id} (${cats.get(c.parent)?.name ?? ''} › ${c.name})`);
  const from = startOfMonth(addMonths(now, -12));
  const cf = analytics.cashflow(from, now);
  const complete = new Set(analytics.coverage().completeMonths);
  const months = cf.months.map((m) => `- ${m.month}: spending £${m.spending.toFixed(2)}, money in £${m.income.toFixed(2)}, net £${m.net.toFixed(2)}${complete.has(m.month) ? '' : ' (not every account has data for all of it)'}`);
  const recent = trips(store, addMonths(now, -24), now).slice(-6);
  return [
    `Today is ${now}.`,
    '',
    'Accounts (id: name, type; the days it has data for):',
    ...accounts,
    '',
    `Categories (id (group › name)): ${categories.join('; ')}; uncategorised.`,
    '',
    'Months (computed by the app, as the Spending page counts them):',
    ...months,
    ...(recent.length ? ['', `Trips in the last two years (runs of Holidays spending): ${recent.map((t) => `${t.from} to ${t.to}`).join('; ')}.`] : []),
  ].join('\n');
}

function questionText(turn: Pick<AskTurn, 'question' | 'defaults'>, store: Store): string {
  const d = turn.defaults;
  const defaults = [
    d.from || d.to ? `the period ${d.from ?? 'the start'} to ${d.to ?? 'today'}` : '',
    d.accounts?.length ? `the accounts ${d.accounts.map((id) => `${id} (${store.account(id)?.name ?? id})`).join(', ')}` : '',
  ].filter(Boolean);
  return [`The owner asks:`, '"""', turn.question, '"""', ...(defaults.length ? [`They chose ${defaults.join(' and ')}: the tools use these when you give no period or accounts.`] : [])].join('\n');
}

/** The numbers in a figure ("£1,234.56", "13 payments", "-42.5"), as numbers. */
function numbersIn(s: string): number[] {
  return [...s.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Math.abs(Number(m[0])));
}

/** A figure is the app's when its number is in the result of the step it names (or of any step, when it names none). */
export function markFigures(figures: StepOut['figures'], steps: AskStep[]): AskFigure[] {
  return (figures ?? []).slice(0, 20).map((f) => {
    const want = numbersIn(f.value);
    const from = f.step !== null ? steps.filter((s) => s.n === f.step) : steps;
    const found = want.length > 0 && from.find((s) => !s.error && want.every((n) => numbersIn(s.resultText).some((x) => Math.abs(x - n) < 0.005)));
    return { label: f.label.slice(0, 200), value: f.value.slice(0, 100), step: f.step, computed: Boolean(found), ...(found && found.href ? { href: found.href } : {}) };
  });
}

/** The answer, or the text so far of the field being written, from a step's JSON as it streams. */
function streamingField(json: string): string | undefined {
  const pick = (k: string) => {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]!.replace(/\\$/, '')}"`) as string;
    } catch {
      return m[1];
    }
  };
  return pick('answer') ?? pick('why');
}

// ─── The service ─────────────────────────────────────────────────────────────────────────────────

interface Running {
  conversationId: string;
  turnId: string;
  abort: AbortController;
  session?: Session | undefined;
}

export class AskService extends EventEmitter {
  private conversations = new Map<string, AskConversation>();
  private queue: { conversationId: string; turnId: string }[] = [];
  private running?: Running | undefined;
  private liveTimers = new Map<string, NodeJS.Timeout>();
  private sweepTimer?: NodeJS.Timeout | undefined;
  readonly dir: string;
  /** Tests only: stand in for the network. */
  fetch?: typeof fetch;

  constructor(
    private readonly store: Store,
    private readonly analytics: Analytics,
    private readonly config: Config,
    private readonly sessions: SessionLog,
    private readonly audit?: AuditLog,
  ) {
    super();
    this.dir = path.join(config.workDir, 'ask');
  }

  async init(opts: { sweep?: boolean } = {}): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const f of (await readdir(this.dir)).filter((x) => x.endsWith('.json'))) {
      try {
        const c = JSON.parse(await readFile(path.join(this.dir, f), 'utf8')) as AskConversation;
        if (typeof c.id !== 'string' || !Array.isArray(c.turns)) continue;
        let changed = false;
        for (const t of c.turns) {
          if (t.status === 'running' || t.status === 'queued') {
            Object.assign(t, { status: 'failed', error: 'Stopped when the app restarted.', finishedAt: t.finishedAt ?? nowISO() });
            changed = true;
          }
        }
        this.conversations.set(c.id, c);
        if (changed) await this.save(c);
      } catch {
        console.warn(`[ask] ignoring unreadable conversation ${f}`);
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
    for (const t of this.liveTimers.values()) clearTimeout(t);
    this.running?.abort.abort();
  }

  get(id: string): AskConversation | undefined {
    return this.conversations.get(id);
  }

  /** The conversations on the list (not hidden), newest first. */
  list(): AskConversationSummary[] {
    return [...this.conversations.values()]
      .filter((c) => !c.hidden)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => {
        const last = c.turns.at(-1);
        const answered = c.turns.findLast((t) => t.answer);
        return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.turns.length, status: last?.status ?? 'answered', ...(answered?.answer ? { lastAnswer: answered.answer.answer.slice(0, 300) } : {}) };
      });
  }

  /** Turns waiting or running. */
  busy(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** The turn (and its conversation) a session ran. */
  turnOf(conversationId: string | undefined, turnId: string | undefined): { conversation: AskConversation; turn: AskTurn } | undefined {
    const conversation = conversationId ? this.conversations.get(conversationId) : undefined;
    const turn = conversation?.turns.find((t) => t.id === turnId);
    return conversation && turn ? { conversation, turn } : undefined;
  }

  /** The model a question runs on: the owner's pick, or Settings → Models' default for Ask. */
  modelOf(id: AskModelId | undefined): AskModel {
    const pick = ASK_MODEL_OPTIONS.find((o) => o.id === (id ?? this.defaultModel()));
    if (!pick) throw new StoreError('Unknown model.', 400);
    return { id: pick.id, engine: pick.engine, model: pick.model, ...('thinking' in pick ? { thinking: pick.thinking } : {}), ...('effort' in pick ? { effort: pick.effort } : {}) };
  }

  /** Settings → Models' choice for Ask, as one of the options. */
  defaultModel(): AskModelId {
    const c = resolveTask('ask', this.store.settings.models.tasks);
    if (c.engine === 'inference') return c.thinking ? 'local-thinking' : 'local-quick';
    return c.model === 'opus' ? 'claude-opus' : 'claude-sonnet';
  }

  /** Start a conversation with its first question. */
  async start(input: { question: string; model?: AskModelId | undefined; defaults?: AskDefaults | undefined }): Promise<AskConversation> {
    const now = nowISO();
    const c: AskConversation = {
      id: `conv_${Date.now().toString(36)}${randomHex(3)}`,
      title: input.question.trim().slice(0, 120),
      createdAt: now,
      updatedAt: now,
      context: openingContext(this.store, this.analytics),
      turns: [],
    };
    this.conversations.set(c.id, c);
    return this.ask(c.id, input);
  }

  /** Ask a question in a conversation: it queues behind any turn running. */
  async ask(conversationId: string, input: { question: string; model?: AskModelId | undefined; defaults?: AskDefaults | undefined }): Promise<AskConversation> {
    const c = this.conversations.get(conversationId);
    if (!c) throw new StoreError('No such conversation.', 404);
    const question = input.question.trim();
    if (question.length < 3) throw new StoreError('Ask a question.', 400);
    const model = this.modelOf(input.model);
    if (model.engine === 'inference' && !this.config.inference) throw new StoreError('The local model service is not set up here (INFERENCE_BASE_URL and INFERENCE_API_KEY in .env): pick Claude, or set it up.', 503);
    const defaults = cleanDefaults(this.store, input.defaults);
    const requestId = currentRequestId();
    const turn: AskTurn = {
      id: `turn_${Date.now().toString(36)}${randomHex(2)}`,
      question: question.slice(0, 2000),
      askedAt: nowISO(),
      model,
      defaults,
      status: 'queued',
      steps: [],
      sessions: [],
      promptVersion: ASK_PROMPT_VERSION,
      ...(requestId ? { requestId } : {}),
    };
    // Who asked: their turn's session says so, however long it waits.
    turn.askedBy = currentActor();
    c.turns.push(turn);
    c.updatedAt = turn.askedAt;
    delete c.hidden;
    await this.save(c);
    this.queue.push({ conversationId, turnId: turn.id });
    this.changed(c, turn);
    this.pump();
    return c;
  }

  /** Stop a turn: the one running (its engine is stopped), or one waiting. Without a turn, the one running. */
  async cancel(conversationId: string, turnId?: string, actor: AuditActor = currentActor()): Promise<AskConversation> {
    const c = this.conversations.get(conversationId);
    if (!c) throw new StoreError('No such conversation.', 404);
    const running = this.running?.conversationId === conversationId && (!turnId || this.running.turnId === turnId) ? this.running : undefined;
    if (running) {
      const t = c.turns.find((x) => x.id === running.turnId)!;
      t.stoppedBy = actorName(actor);
      if (running.session) this.sessions.cancel(running.session.id, actor);
      running.abort.abort(new Error(`Stopped by ${actorName(actor)}`));
      return c;
    }
    const t = c.turns.find((x) => x.id === turnId && x.status === 'queued');
    if (!t) throw new StoreError('Nothing to stop: that question is not waiting or being answered.', 409);
    this.queue = this.queue.filter((q) => q.turnId !== t.id);
    Object.assign(t, { status: 'cancelled', stoppedBy: actorName(actor), finishedAt: nowISO() });
    this.audit?.record({ category: 'session', action: 'ask.cancel', actor, summary: `Question taken back before it was answered: ${t.question.slice(0, 120)}`, targets: [c.id, t.id] });
    await this.save(c);
    this.changed(c, t);
    return c;
  }

  /** Take a conversation off the list. It is kept until retention removes it (the owner's choice). */
  async hide(conversationId: string, actor: AuditActor = currentActor()): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (!c) throw new StoreError('No such conversation.', 404);
    if (this.running?.conversationId === conversationId) await this.cancel(conversationId, undefined, actor);
    for (const t of c.turns.filter((x) => x.status === 'queued')) await this.cancel(conversationId, t.id, actor);
    c.hidden = { at: nowISO(), by: actorName(actor) };
    await this.save(c);
    this.changed(c);
  }

  /** "This is wrong" (or not), with why: kept with the turn, and in the evaluation set. */
  async feedback(conversationId: string, turnId: string, input: { wrong: boolean; note: string }): Promise<AskTurn> {
    const found = this.turnOf(conversationId, turnId);
    if (!found) throw new StoreError('No such question.', 404);
    const { conversation, turn } = found;
    if (input.wrong) turn.feedback = { wrong: true, note: input.note.trim().slice(0, 2000), at: nowISO() };
    else delete turn.feedback;
    await this.save(conversation);
    this.changed(conversation, turn);
    return turn;
  }

  /** Every answer marked wrong: the questions a new prompt version must answer at least as well. */
  feedbackSet(): AskFeedbackItem[] {
    const out: AskFeedbackItem[] = [];
    for (const c of this.conversations.values()) {
      for (const t of c.turns) {
        if (!t.feedback?.wrong) continue;
        out.push({ conversationId: c.id, turnId: t.id, question: t.question, ...(t.answer ? { answer: t.answer.answer } : {}), note: t.feedback.note, at: t.feedback.at, promptVersion: t.promptVersion, model: t.model.id });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Conversations past the retention period go (their transcripts go with the sessions'). */
  async sweep(now = Date.now()): Promise<number> {
    const cutoff = now - this.sessions.limits.days * 86_400_000;
    let removed = 0;
    for (const c of [...this.conversations.values()]) {
      if (Date.parse(c.updatedAt) >= cutoff || c.turns.some((t) => t.status === 'running' || t.status === 'queued')) continue;
      this.conversations.delete(c.id);
      await rm(path.join(this.dir, `${c.id}.json`), { force: true });
      removed++;
    }
    return removed;
  }

  private async save(c: AskConversation): Promise<void> {
    const kept = { ...c, turns: c.turns.map(({ live: _live, ...t }) => t) };
    await atomicWrite(path.join(this.dir, `${c.id}.json`), JSON.stringify(kept, null, 1), 0o600);
  }

  private changed(c: AskConversation, t?: AskTurn): void {
    this.emit('update', { id: c.id, ...(t ? { turnId: t.id, status: t.status } : {}) });
  }

  /** What it is doing now, to the page at most once a second. */
  private live(c: AskConversation, t: AskTurn, live: Partial<AskLive>): void {
    const prev = t.live;
    const phase = live.phase ?? prev?.phase ?? 'reading';
    const next: AskLive = { ...prev, ...live, phase, reasoningChars: live.reasoningChars ?? prev?.reasoningChars ?? 0, since: !prev || phase !== prev.phase ? nowISO() : prev.since };
    if (phase !== 'waiting') delete next.waiting;
    t.live = next;
    if (this.liveTimers.has(t.id)) return;
    const timer = setTimeout(() => {
      this.liveTimers.delete(t.id);
      this.changed(c, t);
    }, LIVE_EVERY_MS);
    timer.unref();
    this.liveTimers.set(t.id, timer);
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const c = this.conversations.get(next.conversationId);
    const t = c?.turns.find((x) => x.id === next.turnId);
    if (!c || !t || t.status !== 'queued') return this.pump();
    const abort = new AbortController();
    this.running = { conversationId: c.id, turnId: t.id, abort };
    void this.answer(c, t, abort.signal).finally(() => {
      this.running = undefined;
      this.pump();
    });
  }

  private async answer(c: AskConversation, t: AskTurn, signal: AbortSignal): Promise<void> {
    t.status = 'running';
    t.startedAt = nowISO();
    this.live(c, t, { phase: 'reading', reasoningChars: 0 });
    await this.save(c);
    this.changed(c, t);
    try {
      let model = t.model;
      try {
        await this.run(c, t, model, signal);
      } catch (err) {
        // The local model could not, and Settings → Models lets Claude stand in for it on Ask.
        const choice = resolveTask('ask', this.store.settings.models.tasks);
        const bin = model.engine === 'inference' && choice.fallback && !signal.aborted && (err instanceof InferenceUnavailable || err instanceof InferenceFailed) ? await resolveClaudeBin() : null;
        if (!bin) throw err;
        t.fellBack = (err as Error).message;
        t.steps = [];
        const claude = claudeChoice('ask');
        model = { id: claude.model === 'opus' ? 'claude-opus' : 'claude-sonnet', engine: 'claude-cli', model: claude.model, effort: claude.effort };
        await this.run(c, t, model, signal, { fallbackOf: t.sessions.at(-1), fallbackReason: t.fellBack });
      }
      t.status = 'answered';
    } catch (err) {
      const stopped = signal.aborted || err instanceof SessionStopped;
      t.status = stopped ? 'cancelled' : 'failed';
      t.error = stopped ? `Stopped${t.stoppedBy ? ` by ${t.stoppedBy}` : ''}.` : (err as Error).message.slice(0, 1000);
    } finally {
      clearTimeout(this.liveTimers.get(t.id));
      this.liveTimers.delete(t.id);
      delete t.live;
      t.finishedAt = nowISO();
      c.updatedAt = t.finishedAt;
      await this.save(c);
      this.changed(c, t);
    }
  }

  /** The messages before this turn's: earlier turns, whole while they fit, else their questions and answers. */
  private history(c: AskConversation, t: AskTurn): { role: 'user' | 'assistant'; content: string }[] {
    const earlier = c.turns.slice(0, c.turns.indexOf(t)).filter((x) => x.status === 'answered' && x.answer);
    const whole = (x: AskTurn, i: number) => [
      { role: 'user' as const, content: i === 0 ? `${c.context}\n\n${questionText(x, this.store)}` : questionText(x, this.store) },
      ...x.steps.flatMap((s) => [
        { role: 'assistant' as const, content: s.said },
        { role: 'user' as const, content: s.resultText },
      ]),
      { role: 'assistant' as const, content: JSON.stringify({ step: 'answer', why: 'Answered', ...x.answer, figures: x.answer!.figures.map((f) => ({ label: f.label, value: f.value, step: f.step })) }) },
    ];
    let out = earlier.flatMap((x, i) => whole(x, i));
    if (out.reduce((n, m) => n + m.content.length, 0) > HISTORY_CHARS) {
      out = earlier.flatMap((x, i) => [
        { role: 'user' as const, content: i === 0 ? `${c.context}\n\n${questionText(x, this.store)}` : questionText(x, this.store) },
        { role: 'assistant' as const, content: JSON.stringify({ step: 'answer', why: 'Answered', answer: x.answer!.answer, figures: x.answer!.figures.map((f) => ({ label: f.label, value: f.value, step: null })) }) },
      ]);
    }
    return out;
  }

  /** One turn on one engine, as a session: steps until it answers, or the tool calls run out. */
  private async run(c: AskConversation, t: AskTurn, model: AskModel, signal: AbortSignal, fallback?: { fallbackOf?: string | undefined; fallbackReason: string }): Promise<void> {
    const maxCalls = this.store.settings.ask.maxToolCalls;
    const system = systemPrompt(maxCalls);
    const history = this.history(c, t);
    const first = history.length ? questionText(t, this.store) : `${c.context}\n\n${questionText(t, this.store)}`;
    const bin = model.engine === 'claude-cli' ? await resolveClaudeBin() : null;
    if (model.engine === 'claude-cli' && !bin) throw new Error('The claude CLI is not available here: ask the local model instead.');
    const actor = t.askedBy ?? currentActor();
    const session = await this.sessions.start({
      kind: 'ask',
      title: `Ask: ${t.question.slice(0, 100)}`,
      conversationId: c.id,
      turnId: t.id,
      engine: model.engine,
      model: model.model,
      ...(model.engine === 'inference' ? { thinking: Boolean(model.thinking) } : { effort: model.effort ?? 'high' }),
      promptVersion: ASK_PROMPT_VERSION,
      tools: [...ASK_TOOLS],
      privacy: 'personal',
      startedBy: { actor, reason: c.turns.indexOf(t) === 0 ? 'You asked a question' : 'You asked a follow-up question' },
      ...(t.requestId ? { requestId: t.requestId } : {}),
      ...(fallback?.fallbackOf ? { fallbackOf: fallback.fallbackOf } : {}),
      ...(fallback ? { fallbackReason: fallback.fallbackReason } : {}),
    });
    t.sessions.push(session.id);
    this.running!.session = session;
    await this.save(c);
    this.changed(c, t);
    const sink: TranscriptSink = session;
    const runSteps = async (): Promise<void> => {
      // This turn's messages after the history: its question, then each step and its result.
      const mine: { role: 'user' | 'assistant'; content: string }[] = [];
      let next = first;
      let calls = 0;
      let lastCall = '';
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled');
        const answerOnly = calls >= maxCalls;
        const prompt = answerOnly ? `${next}\n\nYou have made ${calls} tool calls, the most for one question: answer now from what you have.` : next;
        this.live(c, t, { phase: 'reading', reasoningChars: 0, text: '' });
        const out = await this.step(model, { system, history: [...history, ...mine], prompt, schema: stepSchema(answerOnly ? 'answer' : calls === 0 ? 'call' : undefined), sink, signal, bin, c, t });
        mine.push({ role: 'user', content: prompt }, { role: 'assistant', content: out.text });
        const step = out.step;
        if (step.step === 'answer' || answerOnly) {
          t.answer = toAnswer(step, t.steps);
          sink.write({ type: 'finance.answer', answer: t.answer });
          return;
        }
        calls++;
        const n = t.steps.length + 1;
        const started = Date.now();
        const tool = step.tool as AskTool | null;
        const key = JSON.stringify([tool, step.args]);
        this.live(c, t, { phase: 'looking', text: step.why });
        let resultText: string;
        const s: AskStep = { n, at: nowISO(), why: step.why.slice(0, 300), tool: tool ?? '(none)', args: compactArgs(step.args), ms: 0, said: out.text, resultText: '' };
        try {
          if (!tool || !ASK_TOOLS.includes(tool)) throw new ToolError(`Choose one of the tools: ${ASK_TOOLS.join(', ')}.`);
          if (key === lastCall) throw new ToolError('You made this same call in the step before: use its result, or change the call.');
          const r = runTool(this.store, this.analytics, tool, step.args ?? {}, t.defaults);
          let json = JSON.stringify(r.result);
          if (json.length > RESULT_CHARS) json = `${json.slice(0, RESULT_CHARS)}… [cut here: the counts and totals above cover every row]`;
          resultText = `Result of step ${n} (${tool}):\n${json}`;
          Object.assign(s, { summary: r.summary, ...(r.href ? { href: r.href } : {}) });
        } catch (err) {
          if (!(err instanceof ToolError) && !(err instanceof z.ZodError)) throw err;
          resultText = `Step ${n} (${tool ?? 'no tool'}) failed: ${err.message}`;
          s.error = err.message;
        }
        lastCall = key;
        s.resultText = resultText;
        s.ms = Date.now() - started;
        t.steps.push(s);
        sink.write({ type: 'finance.tool', step: n, tool: s.tool, why: s.why, args: s.args, ...(s.summary ? { summary: s.summary } : {}), ...(s.error ? { error: s.error } : {}), ...(s.href ? { href: s.href } : {}), ms: s.ms, result: resultText });
        await this.save(c);
        this.changed(c, t);
        next = resultText;
      }
    };
    await session.run(runSteps, signal);
  }

  /** One step of the model's: the local model (streamed, with the conversation as messages) or Claude. */
  private async step(model: AskModel, o: { system: string; history: { role: 'user' | 'assistant'; content: string }[]; prompt: string; schema: Record<string, unknown>; sink: TranscriptSink; signal: AbortSignal; bin: string | null; c: AskConversation; t: AskTurn }): Promise<{ step: StepOut; text: string }> {
    const def = TASKS.ask;
    if (model.engine === 'inference') {
      const res = await chat(this.config.inference, {
        alias: model.model,
        system: o.system,
        history: o.history,
        content: [{ type: 'text', text: o.prompt }],
        schema: { name: 'step', schema: o.schema },
        thinking: Boolean(model.thinking),
        maxTokens: def.maxTokens,
        priority: def.priority,
        runMinutes: def.runMinutes,
        waitUpToMs: 10 * 60_000,
        signal: o.signal,
        transcript: o.sink,
        describe: { model: model.model, ...(o.history.length ? {} : { systemPrompt: o.system }), prompt: o.prompt, schema: o.schema },
        onWait: (w) => this.live(o.c, o.t, { phase: 'waiting', waiting: `${w.reason}${w.until ? `, until ${w.until.slice(11, 16)}` : ''}` }),
        onDelta: ({ reasoning, content }) => this.live(o.c, o.t, { phase: content ? 'writing' : 'thinking', reasoningChars: reasoning.length, ...(content ? { text: streamingField(content) ?? '' } : {}) }),
        ...(this.fetch ? { fetch: this.fetch } : {}),
      });
      return { step: StepOut.parse(res.output), text: res.text };
    }
    // Claude: one call per step, the conversation so far written into its prompt.
    const prompt = [...o.history.map((m) => (m.role === 'user' ? m.content : `Your step: ${m.content}`)), o.prompt, '', 'Your next step:'].join('\n\n');
    this.live(o.c, o.t, { phase: 'thinking' });
    // An empty directory: Claude is given no tools and no files, only what the steps found.
    const cwd = path.join(this.config.workDir, 'agent', 'ask');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const r = await runAgent({ bin: o.bin!, cwd, prompt, systemPrompt: o.system, schema: o.schema, tools: [], model: model.model, effort: model.effort ?? 'high', timeoutMs: 10 * 60_000, signal: o.signal, transcript: o.sink });
    return { step: StepOut.parse(r.output), text: JSON.stringify(r.output) };
  }
}

function toAnswer(step: StepOut, steps: AskStep[]): AskAnswer {
  return {
    answer: (step.answer ?? '').trim() || 'It gave no answer.',
    figures: markFigures(step.figures, steps),
    confidence: step.confidence ?? 'low',
    caveats: (step.caveats ?? []).slice(0, 8).map((x) => x.slice(0, 500)),
    cannotAnswer: Boolean(step.cannotAnswer),
  };
}

/** The args the model used (the nulls left out). */
function compactArgs(args: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
}

function cleanDefaults(store: Store, d: AskDefaults | undefined): AskDefaults {
  if (!d) return {};
  const out: AskDefaults = {};
  if (d.from && isISODate(d.from)) out.from = d.from;
  if (d.to && isISODate(d.to)) out.to = d.to;
  if (out.from && out.to && out.from > out.to) throw new StoreError('The period starts after it ends.', 400);
  const accounts = (d.accounts ?? []).filter((id) => store.account(id));
  if (accounts.length) out.accounts = accounts;
  return out;
}

// ─── Suggested questions ─────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayName = (d: string) => `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]!.slice(0, 3)}`;

/** Questions built from the data by fixed rules (no model): a recent trip, a currency used abroad, the last month. */
export function suggestions(store: Store, analytics: Analytics, now = today()): string[] {
  const out: string[] = [];
  const trip = trips(store, addMonths(now, -18), now).at(-1);
  if (trip) out.push(`How much did the trip from ${dayName(trip.from)} to ${dayName(trip.to)} ${trip.to.slice(0, 4)} cost, and on what?`);
  const currencies = new Map<string, number>();
  for (const t of store.transactions()) if (t.original && t.date >= addDays(now, -540)) currencies.set(t.original.currency, (currencies.get(t.original.currency) ?? 0) + 1);
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (currency) {
    let name = currency;
    try {
      name = new Intl.DisplayNames(['en-GB'], { type: 'currency' }).of(currency) ?? currency;
    } catch {
      // the code alone
    }
    out.push(`How much have I spent in ${name} (${currency})?`);
  }
  const month = analytics.coverage().lastCompleteMonth;
  if (month) {
    out.push(`What did I spend most on in ${monthName(month)}?`);
    const before = addMonths(`${month}-01`, -1).slice(0, 7);
    out.push(`Why was my spending in ${monthName(month)} different from ${monthName(before)}?`);
  }
  out.push('How much is in my accounts today?');
  out.push('Who did I pay the most in the last 12 months?');
  return out.slice(0, 6);
}
