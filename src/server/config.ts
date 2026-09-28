// Runtime configuration from environment variables (and ./.env when present).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Ports. The live service (finance.service) sets PORT=4750 in its own .env; everything run from a
 * development checkout defaults elsewhere so it can never clash with it: the dev API on 4760 (Vite
 * on 4761), the demo on 4770.
 */
export const DEV_PORT = 4760;

export interface Config {
  host: string;
  port: number;
  production: boolean;
  projectRoot: string;
  dataDir: string;
  inboxDir: string;
  /** Pending uploads and drafts; never committed. */
  workDir: string;
  webDist: string;
  allowedHosts: string[];
  anthropicApiKey?: string;
  /** Watch the inbox folder and the data directory for changes. */
  watch: boolean;
  /** Branch that data auto-commits must land on; commits are held (and reported) on any other. */
  dataBranch: string;
  /** Allow creating a fresh data directory in production (otherwise a missing one is an error). */
  initData: boolean;
}

let envLoaded = false;

export function loadDotEnv(root = PROJECT_ROOT): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = path.join(root, '.env');
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`Could not read ${file}: ${(err as Error).message}`);
    }
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith('127.');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = PROJECT_ROOT): Config {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));
  const dataDir = abs(env.FINANCE_DATA_DIR || 'data');
  const dataName = path.basename(dataDir);
  const host = env.HOST || '127.0.0.1';
  const config: Config = {
    host,
    port: Number(env.PORT || DEV_PORT),
    production: env.NODE_ENV === 'production',
    projectRoot: root,
    dataDir,
    inboxDir: abs(env.FINANCE_INBOX_DIR || (dataName === 'data' ? 'inbox' : path.join('.work', `inbox-${dataName}`))),
    workDir: abs(env.FINANCE_WORK_DIR || path.join('.work', dataName)),
    webDist: path.join(root, 'dist', 'web'),
    allowedHosts: (env.FINANCE_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    watch: env.FINANCE_WATCH !== '0',
    dataBranch: env.FINANCE_DATA_BRANCH || 'main',
    initData: env.FINANCE_INIT_DATA === '1',
  };
  if (env.ANTHROPIC_API_KEY) config.anthropicApiKey = env.ANTHROPIC_API_KEY;
  return config;
}
