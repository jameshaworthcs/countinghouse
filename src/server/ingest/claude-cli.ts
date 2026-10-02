// Extraction through your logged-in Claude Code CLI (`claude -p`), so no API key is needed.
//
// Isolation: runs in a throwaway directory holding only the files to read, with only the Read tool
// allowed and confined to that directory (--restricted), --safe-mode (no hooks, plugins, MCP
// servers or CLAUDE.md), no session persistence, and non-essential traffic disabled. The output is
// constrained by --json-schema.
//
// The CLI streams its events (--output-format stream-json): each one goes to the session's
// transcript as it arrives (sessions.ts), and the last, the result, carries the output. Claude
// Code itself keeps nothing (--no-session-persistence): the app's transcript is the only one.

import { spawn } from 'node:child_process';
import { access, constants, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptSink } from '../sessions';
import { normaliseExtraction } from './normalise';
import type { EngineResult } from './engines';

export interface CliOptions {
  bin: string;
  cwd: string;
  userPrompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  model: string;
  effort: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Where the session's events go as they arrive. */
  transcript?: TranscriptSink | undefined;
}

export interface CliResult {
  type?: string;
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  modelUsage?: Record<string, unknown>;
}

/** Find the claude binary: FINANCE_CLAUDE_BIN, PATH, then the usual install locations. */
export async function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates = [
    env.FINANCE_CLAUDE_BIN,
    ...(env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'claude')),
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/usr/local/bin/claude',
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function runProcess(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    input?: string;
    /** Each line of output as it arrives; stdout then keeps only its last few thousand characters. */
    onLine?: (line: string) => void;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    let partial = '';
    let settled = false;
    const lines = (text: string, end: boolean) => {
      partial += text;
      const parts = partial.split('\n');
      partial = end ? '' : parts.pop()!;
      for (const l of parts) if (l.trim()) opts.onLine!(l);
    };
    const kill = (reason: string) => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      settled = true;
      reject(new Error(reason));
    };
    const timer = setTimeout(() => kill(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);
    opts.signal?.addEventListener('abort', () => kill('Cancelled'), { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (!opts.onLine) return void (stdout += d);
      stdout = (stdout + d).slice(-4000);
      lines(d, false);
    });
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.onLine) lines('', true);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, code });
      }
    });
  });
}

/** The files a run can read: its scratch directory's, by name and size (never their contents). */
async function filesIn(dir: string): Promise<{ name: string; bytes: number }[]> {
  try {
    const names = await readdir(dir);
    return await Promise.all(names.map(async (name) => ({ name, bytes: (await stat(path.join(dir, name))).size })));
  } catch {
    return [];
  }
}

/** The flags every run shares: streamed events, nothing kept by Claude Code, locked down. */
export function lockedDownArgs(opts: { schema: Record<string, unknown>; tools: string; model: string; effort: string; systemPrompt: string }): string[] {
  return [
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(opts.schema),
    '--tools',
    opts.tools,
    ...(opts.tools ? ['--allowedTools', opts.tools] : []),
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--safe-mode',
    '--restricted',
    '--model',
    opts.model,
    '--effort',
    opts.effort,
    '--system-prompt',
    opts.systemPrompt,
  ];
}

/**
 * Run `claude -p` and read its streamed events: each goes to the transcript as it arrives, and the
 * result (the last) is returned. The transcript starts with what the app sent.
 */
export async function runClaudeCli(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined; input?: string; transcript?: TranscriptSink | undefined; request: Record<string, unknown> },
): Promise<{ result?: CliResult; stderr: string; stdout: string; code: number | null }> {
  const sink = opts.transcript;
  sink?.write({ type: 'finance.request', engine: 'claude-cli', ...opts.request, files: await filesIn(opts.cwd) });
  let result: CliResult | undefined;
  let stderr = '';
  try {
    const out = await runProcess(bin, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
      onLine: (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          sink?.write({ type: 'finance.output', text: line.slice(0, 4000) });
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const e = event as CliResult & Record<string, unknown>;
        sink?.write(e);
        // The result: the last event (an older CLI, or a stand-in, may give it without a type).
        if (e.type === 'result' || (e.type === undefined && ('structured_output' in e || 'subtype' in e))) result = e;
      },
    });
    stderr = out.stderr;
    if (stderr.trim()) sink?.write({ type: 'finance.stderr', text: stderr.slice(-4000) });
    return { ...(result ? { result } : {}), stderr, stdout: out.stdout, code: out.code };
  } catch (err) {
    if (stderr.trim()) sink?.write({ type: 'finance.stderr', text: stderr.slice(-4000) });
    throw err;
  }
}

export async function extractWithClaudeCli(opts: CliOptions): Promise<EngineResult> {
  const args = ['-p', opts.userPrompt, ...lockedDownArgs({ schema: opts.schema, tools: 'Read', model: opts.model, effort: opts.effort, systemPrompt: opts.systemPrompt })];
  const started = Date.now();
  const { result, stderr, stdout, code } = await runClaudeCli(opts.bin, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    transcript: opts.transcript,
    request: { model: opts.model, effort: opts.effort, tools: ['Read'], systemPrompt: opts.systemPrompt, prompt: opts.userPrompt, schema: opts.schema },
  });
  if (!result) {
    throw new Error(`claude CLI returned no JSON (exit ${code}). ${(stderr || stdout).trim().slice(0, 500)}`);
  }
  if (result.is_error || result.subtype !== 'success' || result.structured_output === undefined) {
    throw new Error(`claude CLI failed (${result.subtype ?? 'error'}): ${(result.result ?? stderr).slice(0, 500)}`);
  }
  const { extraction, warnings } = normaliseExtraction(result.structured_output);
  const model = Object.keys(result.modelUsage ?? {})[0] ?? opts.model;
  return {
    extraction,
    warnings,
    model,
    ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
    durationMs: result.duration_ms ?? Date.now() - started,
  };
}
