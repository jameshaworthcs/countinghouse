// Which extraction engines are available on this machine, and which to use.

import type { Extraction, InferenceProvenance } from '../../shared/schema';
import { inferenceHealth, SERVING_STATES, type InferenceConfig, type InferenceHealth } from '../inference';
import { resolveClaudeBin, runProcess } from './claude-cli';

export interface EngineResult {
  extraction: Extraction;
  warnings: string[];
  model?: string;
  costUsd?: number;
  durationMs: number;
  /** What was put right or done another way, shown with the warnings but not counted against the reading. */
  notices?: string[];
  /** The engine that made it (a fallback may not be the one asked for). */
  engine?: AiEngineId;
  /** The local model service's record of it. */
  inference?: InferenceProvenance;
}

export type AiEngineId = 'inference' | 'claude-cli' | 'claude-api' | 'ocr';

export interface EngineStatus {
  id: AiEngineId;
  available: boolean;
  detail: string;
  /** Sends documents to Anthropic. */
  external: boolean;
  /** The local model service: each alias's state, and who holds its GPU. */
  health?: InferenceHealth;
}

let cache: { at: number; value: EngineStatus[]; claudeBin: string | null } | null = null;

/** The local model service's line: whether it answers, and what its GPU is doing. */
async function inferenceStatus(cfg: InferenceConfig | undefined): Promise<EngineStatus> {
  if (!cfg) return { id: 'inference', available: false, detail: 'Set INFERENCE_BASE_URL and INFERENCE_API_KEY in .env to use the local model service', external: false };
  const health = await inferenceHealth(cfg);
  if (!health) return { id: 'inference', available: false, detail: `${new URL(cfg.baseUrl).host} is not answering; work for it waits until it does`, external: false };
  const lease = health.gpu?.lease;
  const leased = lease && lease.state !== 'none' ? `; its GPU is lent out${lease.until ? ` until ${lease.until.slice(11, 16)}` : ''}, so work queues` : '';
  const ready = Object.entries(health.aliases).filter(([, a]) => SERVING_STATES.has(a.state)).map(([id]) => id);
  return {
    id: 'inference',
    available: ready.length > 0,
    detail: `${new URL(cfg.baseUrl).host}: ${health.status}${health.gpu?.resident ? `, GPU holds ${health.gpu.resident}` : ''}${leased} (on this machine; nothing leaves it)`,
    external: false,
    health,
  };
}

export async function detectEngines(opts: { apiKey?: string | undefined; inference?: InferenceConfig | undefined; force?: boolean } = {}): Promise<{ engines: EngineStatus[]; claudeBin: string | null }> {
  if (cache && !opts.force && Date.now() - cache.at < 60_000) return { engines: cache.value, claudeBin: cache.claudeBin };
  const claudeBin = await resolveClaudeBin();
  let cliDetail = 'claude CLI not found (install Claude Code and log in)';
  let cliOk = false;
  if (claudeBin) {
    try {
      const v = await runProcess(claudeBin, ['--version'], { cwd: process.cwd(), timeoutMs: 15_000 });
      cliOk = v.code === 0;
      cliDetail = cliOk ? `${v.stdout.trim()} at ${claudeBin}, using your Claude login` : `claude --version failed: ${v.stderr.slice(0, 200)}`;
    } catch (err) {
      cliDetail = `claude CLI error: ${(err as Error).message}`;
    }
  }
  const has = async (bin: string, args: string[]) => {
    try {
      const r = await runProcess(bin, args, { cwd: process.cwd(), timeoutMs: 10_000 });
      return r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0;
    } catch {
      return false;
    }
  };
  const [tesseract, pdftotext, local] = await Promise.all([has('tesseract', ['--version']), has('pdftotext', ['-v']), inferenceStatus(opts.inference)]);
  const engines: EngineStatus[] = [
    local,
    { id: 'claude-cli', available: cliOk, detail: cliDetail, external: true },
    {
      id: 'claude-api',
      available: Boolean(opts.apiKey),
      detail: opts.apiKey ? 'ANTHROPIC_API_KEY is set' : 'Set ANTHROPIC_API_KEY in .env to enable',
      external: true,
    },
    {
      id: 'ocr',
      available: tesseract && pdftotext,
      detail: tesseract && pdftotext ? 'tesseract + poppler (fully offline, lower accuracy)' : 'Install tesseract-ocr and poppler-utils',
      external: false,
    },
  ];
  cache = { at: Date.now(), value: engines, claudeBin };
  return { engines, claudeBin };
}

/** Is this engine available now? */
export function engineAvailable(engines: EngineStatus[], id: AiEngineId): boolean {
  return engines.find((e) => e.id === id)?.available ?? false;
}

/** The Claude engine to use: the CLI login, else the API key. */
export function claudeEngine(engines: EngineStatus[]): 'claude-cli' | 'claude-api' | null {
  if (engineAvailable(engines, 'claude-cli')) return 'claude-cli';
  if (engineAvailable(engines, 'claude-api')) return 'claude-api';
  return null;
}
