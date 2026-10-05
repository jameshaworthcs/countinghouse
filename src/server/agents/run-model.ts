// One agent job's model call, on the engine Settings → Models gives its task (src/shared/tasks.ts):
// the local model service (nothing leaves this machine; no tools, so the prompt holds everything
// the job sees), or the claude CLI, locked down as claude.ts describes. When the local model cannot
// do it and the task allows a fallback, Claude does it instead, as a session of its own.

import type { InferenceProvenance } from '../../shared/schema';
import { claudeChoice, TASKS, type TaskChoice, type TaskKind } from '../../shared/tasks';
import { chat, InferenceFailed, InferenceUnavailable, type InferenceConfig } from '../inference';
import type { SessionLog, TranscriptSink } from '../sessions';
import type { SessionRecord } from '../../shared/sessions';
import { runAgent, type AgentRunResult, type AgentTool } from './claude';

export interface ModelRunOptions {
  task: TaskKind;
  choice: TaskChoice;
  /** The claude binary, when Claude is available. */
  bin: string | null;
  inference: InferenceConfig | undefined;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  tools: AgentTool[];
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Starts the session each call is recorded in (one per engine tried; Claude's names the one it stands in for). */
  session?: ((s: Pick<SessionRecord, 'engine' | 'model' | 'effort' | 'thinking' | 'tools' | 'fallbackOf' | 'fallbackReason'>) => ReturnType<SessionLog['start']>) | undefined;
  /** Tests only. */
  fetch?: typeof fetch;
}

export interface ModelRunResult extends AgentRunResult {
  engine: 'inference' | 'claude-cli';
  inference?: InferenceProvenance;
  /** Set when Claude did the work because the local model could not. */
  fellBack?: string;
}

/** One call on one engine, inside a session the caller runs (or none). */
export async function callModel(opts: Omit<ModelRunOptions, 'choice' | 'session'>, c: TaskChoice, transcript: TranscriptSink | undefined, prompt: string = opts.prompt): Promise<ModelRunResult> {
  if (c.engine === 'inference') {
    const def = TASKS[opts.task];
    const res = await chat(opts.inference, {
      alias: c.model,
      system: opts.systemPrompt,
      content: [{ type: 'text', text: prompt }],
      schema: { name: 'output', schema: opts.schema },
      thinking: c.thinking,
      maxTokens: def.maxTokens,
      priority: def.priority,
      runMinutes: def.runMinutes,
      // Someone is waiting on an interactive answer: it stops waiting for the service sooner.
      ...(def.priority === 'interactive' ? { waitUpToMs: 10 * 60_000 } : {}),
      signal: opts.signal,
      transcript,
      describe: { model: c.model, systemPrompt: opts.systemPrompt, prompt, schema: opts.schema },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { output: res.output, model: res.provenance.modelId ?? c.model, durationMs: res.durationMs, engine: 'inference', inference: res.provenance };
  }
  if (!opts.bin) throw new Error('The claude CLI is not available; this job needs it.');
  const r = await runAgent({ bin: opts.bin, cwd: opts.cwd, prompt, systemPrompt: opts.systemPrompt, schema: opts.schema, tools: opts.tools, model: c.model, effort: c.effort, timeoutMs: opts.timeoutMs, signal: opts.signal, transcript });
  return { ...r, engine: 'claude-cli' };
}

/** What a session records about the engine a call runs on. */
export function sessionEngine(c: TaskChoice, tools: AgentTool[]): Pick<SessionRecord, 'engine' | 'model' | 'effort' | 'thinking' | 'tools'> {
  const local = c.engine === 'inference';
  return { engine: local ? 'inference' : 'claude-cli', model: c.model, ...(local ? { thinking: c.thinking } : { effort: c.effort }), tools: local ? [] : tools };
}

/** Did the local model fail in a way Claude may stand in for (when the task allows it)? */
export function mayFallBack(c: TaskChoice, err: unknown, bin: string | null, signal?: AbortSignal): boolean {
  return c.engine === 'inference' && c.fallback && Boolean(bin) && !signal?.aborted && (err instanceof InferenceUnavailable || err instanceof InferenceFailed);
}

async function once(opts: ModelRunOptions, c: TaskChoice, started: { id?: string }, fallback?: Pick<SessionRecord, 'fallbackOf' | 'fallbackReason'>): Promise<ModelRunResult> {
  const s = await opts.session?.({ ...sessionEngine(c, opts.tools), ...fallback });
  started.id = s?.id;
  const run = (transcript: TranscriptSink | undefined) => callModel(opts, c, transcript);
  return s ? s.run(run, opts.signal) : run(undefined);
}

export async function runModel(opts: ModelRunOptions): Promise<ModelRunResult> {
  const first: { id?: string } = {};
  try {
    return await once(opts, opts.choice, first);
  } catch (err) {
    if (!mayFallBack(opts.choice, err, opts.bin, opts.signal)) throw err;
    const reason = (err as Error).message;
    const r = await once(opts, claudeChoice(opts.task), {}, { ...(first.id ? { fallbackOf: first.id } : {}), fallbackReason: reason });
    return { ...r, fellBack: reason };
  }
}
