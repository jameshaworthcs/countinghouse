// Which extraction engines are available on this machine, and which to use.

import type { ExtractionEnginePreference, Extraction } from '../../shared/schema';
import { resolveClaudeBin, runProcess } from './claude-cli';

export interface EngineResult {
  extraction: Extraction;
  warnings: string[];
  model?: string;
  costUsd?: number;
  durationMs: number;
}

export type AiEngineId = 'claude-cli' | 'claude-api' | 'ocr';

export interface EngineStatus {
  id: AiEngineId;
  available: boolean;
  detail: string;
  /** Sends documents to Anthropic. */
  external: boolean;
}

let cache: { at: number; value: EngineStatus[]; claudeBin: string | null } | null = null;

export async function detectEngines(opts: { apiKey?: string | undefined; force?: boolean } = {}): Promise<{ engines: EngineStatus[]; claudeBin: string | null }> {
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
  const [tesseract, pdftotext] = await Promise.all([has('tesseract', ['--version']), has('pdftotext', ['-v'])]);
  const engines: EngineStatus[] = [
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

/** Resolve a preference to a concrete, available engine. */
export function pickEngine(pref: ExtractionEnginePreference, engines: EngineStatus[]): AiEngineId | null {
  const ok = (id: AiEngineId) => engines.find((e) => e.id === id)?.available ?? false;
  if (pref !== 'auto') return ok(pref) ? pref : null;
  if (ok('claude-cli')) return 'claude-cli';
  if (ok('claude-api')) return 'claude-api';
  if (ok('ocr')) return 'ocr';
  return null;
}
