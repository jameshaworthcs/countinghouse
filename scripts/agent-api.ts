// Calling the app's API as an agent outside it (docs/DEPLOY.md, "Agent access"), for `npm run api`
// and `npm run records`. The token comes from FINANCE_TOKEN or ~/.config/finance/token, and never
// appears in the output; the server from FINANCE_API_URL (default: the live service on this
// machine). A Claude Code session's id (CLAUDE_CODE_SESSION_ID) goes with each request, so the
// app's Agent sessions page groups its requests by the session that made them.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILE = path.join(os.homedir(), '.config', 'finance', 'token');

export async function agentToken(): Promise<string | undefined> {
  const env = process.env.FINANCE_TOKEN?.trim();
  if (env) return env;
  try {
    return (await readFile(TOKEN_FILE, 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The Claude Code session this runs in, when it does. */
export function agentSession(): string | undefined {
  const id = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  return id && /^[A-Za-z0-9._:-]{1,100}$/.test(id) ? id : undefined;
}

export function apiUrl(p: string): string {
  const base = (process.env.FINANCE_API_URL ?? 'http://127.0.0.1:4750').replace(/\/+$/, '');
  return `${base}${p.startsWith('/api/') ? '' : '/api'}${p.startsWith('/') ? '' : '/'}${p}`;
}

/** One request with the token. Throws only when the server could not be reached. */
export async function agentRequest(token: string, method: string, p: string, body?: string): Promise<{ status: number; ok: boolean; text: string; url: string }> {
  const url = apiUrl(p);
  const session = agentSession();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      // The API's CSRF guard asks every change for this header; a browser page elsewhere cannot send it.
      'x-finance-csrf': '1',
      ...(session ? { 'x-agent-session': session } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  return { status: res.status, ok: res.ok, text: await res.text(), url };
}
