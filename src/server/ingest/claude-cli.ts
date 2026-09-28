// Extraction through your logged-in Claude Code CLI (`claude -p`), so no API key is needed.
//
// Isolation: runs in a throwaway directory holding only the files to read, with only the Read tool
// allowed and confined to that directory (--restricted), --safe-mode (no hooks, plugins, MCP
// servers or CLAUDE.md), no session persistence, and non-essential traffic disabled. The output is
// constrained by --json-schema.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
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
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal | undefined; input?: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const kill = (reason: string) => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      settled = true;
      reject(new Error(reason));
    };
    const timer = setTimeout(() => kill(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);
    opts.signal?.addEventListener('abort', () => kill('Cancelled'), { once: true });
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
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
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, code });
      }
    });
  });
}

export async function extractWithClaudeCli(opts: CliOptions): Promise<EngineResult> {
  const args = [
    '-p',
    opts.userPrompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(opts.schema),
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
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
  const started = Date.now();
  const { stdout, stderr, code } = await runProcess(opts.bin, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  });
  let result: CliResult | undefined;
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      result = JSON.parse(line) as CliResult;
      break;
    } catch {
      // not the JSON line
    }
  }
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
