// Everything a request handler might need.

import type { Context } from 'hono';
import { z } from 'zod';
import type { JobRunner } from './agents/jobs';
import type { Analytics } from './analytics';
import type { Auth } from './auth';
import type { Config } from './config';
import type { GitCommitter } from './git';
import type { InboxWatcher } from './ingest/inbox';
import type { ImportService } from './ingest/service';
import type { OidcClient } from './oidc';
import { StoreError, type Store } from './store';

/** What routes need from the agent job runner (src/server/agents/jobs.ts). */
export interface JobQueue {
  enqueue(input: { kind: string; params?: Record<string, unknown>; trigger: 'owner' | 'post-import' | 'schedule' | 'stale' }): unknown;
}

export interface AppContext {
  config: Config;
  store: Store;
  analytics: Analytics;
  imports: ImportService;
  git: GitCommitter;
  auth: Auth;
  /** Sign-in through jemedia-auth, when configured (it then replaces the password). */
  oidc?: OidcClient | undefined;
  inbox?: InboxWatcher | undefined;
  jobs?: JobQueue | undefined;
  runner?: JobRunner | undefined;
  version: string;
}

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError('Request body must be JSON', 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StoreError(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);
  }
  return parsed.data;
}

export function queryDate(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/** One CSV cell: quoted when needed, with spreadsheet formula injection neutralised. */
export function csvCell(v: string | number | null | undefined): string {
  const s = v === undefined || v === null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
