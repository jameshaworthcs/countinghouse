// Running one agent job through the logged-in `claude` CLI, locked down the same way extraction is:
// an empty scratch directory as the working directory, --restricted (file tools confined to it,
// code-running tools removed), --safe-mode (no hooks, plugins, MCP servers or CLAUDE.md), no session
// persistence, non-essential traffic off, and output constrained by a JSON Schema.
//
// Tools are chosen per job and are the privacy boundary (docs/AGENTS.md):
//   - research jobs get WebSearch and WebFetch, and a prompt built only from public identifiers;
//   - jobs that read personal data get Read (of the digest in their scratch directory) or nothing,
//     so what they see cannot leave except to Claude itself.

import { runProcess } from '../ingest/claude-cli';

export type AgentTool = 'Read' | 'WebSearch' | 'WebFetch';

export interface AgentRunOptions {
  bin: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  tools: AgentTool[];
  model: string;
  effort: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface AgentRunResult {
  output: unknown;
  model: string;
  costUsd?: number;
  durationMs: number;
  turns?: number;
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  modelUsage?: Record<string, unknown>;
}

export function agentArgs(opts: Pick<AgentRunOptions, 'schema' | 'tools' | 'model' | 'effort' | 'systemPrompt'>): string[] {
  const tools = opts.tools.length ? opts.tools.join(',') : '';
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(opts.schema),
    '--tools',
    tools,
    ...(tools ? ['--allowedTools', tools] : []),
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

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const started = Date.now();
  const { stdout, stderr, code } = await runProcess(opts.bin, agentArgs(opts), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    input: opts.prompt,
    env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
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
  if (!result) throw new Error(`claude CLI returned no JSON (exit ${code}). ${(stderr || stdout).trim().slice(0, 500)}`);
  if (result.structured_output === undefined || (result.subtype !== 'success' && result.subtype !== undefined)) {
    throw new Error(`claude CLI failed (${result.subtype ?? 'error'}): ${(result.result ?? stderr).slice(0, 500)}`);
  }
  return {
    output: result.structured_output,
    model: Object.keys(result.modelUsage ?? {})[0] ?? opts.model,
    ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
    durationMs: result.duration_ms ?? Date.now() - started,
    ...(typeof result.num_turns === 'number' ? { turns: result.num_turns } : {}),
  };
}
