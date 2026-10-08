// The Messages API engine without a network: the request it builds, and how it reads a
// streamed reply, a refusal and a reply cut off at the output limit. Whether the API accepts the
// request can only be checked with a key.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractWithClaudeApi } from '../src/server/ingest/claude-api';
import { extractionJsonSchema, SYSTEM_PROMPT } from '../src/server/ingest/prompt';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-api-engine-'));
  await writeFile(path.join(dir, 'page.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(dir, 'doc.pdf'), '%PDF-1.4 test');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A streamed Messages API reply carrying `text`, as server-sent events. */
function sse(text: string, stopReason = 'end_turn', extra: Record<string, unknown> = {}): Response {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 300 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const reply = JSON.stringify({ documentType: 'transactions_screenshot', institutionName: null, documentDate: null, accounts: [{ accountType: 'current', last4: '4821', closingBalance: '£3,041.70', transactions: [{ date: '2026-09-28', description: 'TESCO', amount: '-12.30' }] }], figures: [], notes: [], confidence: 'high' });

describe('Messages API engine', () => {
  it('sends the files, the prompt, the schema and the options the app chose', async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetch = ((url: string | URL, init?: RequestInit) => {
      seen = { url: url.toString(), headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) as Record<string, unknown> };
      return Promise.resolve(sse(reply));
    }) as typeof globalThis.fetch;
    const res = await extractWithClaudeApi({ apiKey: 'sk-test', files: [{ path: path.join(dir, 'page.png'), mediaType: 'image/png' }, { path: path.join(dir, 'doc.pdf'), mediaType: 'application/pdf' }], userPrompt: 'Extract.', systemPrompt: SYSTEM_PROMPT, schema: extractionJsonSchema(), model: 'opus', effort: 'high', timeoutMs: 60_000, fetch });
    expect(seen!.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(seen!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(seen!.headers.get('x-api-key')).toBe('sk-test');
    const body = seen!.body as { model: string; stream: boolean; system: string; output_config: { effort: string; format: { type: string; schema: unknown } }; messages: { content: { type: string }[] }[] };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.stream).toBe(true);
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: extractionJsonSchema() });
    expect(body.messages[0]!.content.map((c) => c.type)).toEqual(['image', 'document', 'text']);
    // The reply is normalised like the CLI's: money strings parsed.
    expect(res.extraction.accounts[0]!.closingBalance).toBe(3041.7);
    expect(res.extraction.accounts[0]!.transactions[0]!.amount).toBe(-12.3);
    expect(res.model).toBe('claude-opus-5-5');
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('turns a refusal and a reply cut off at the limit into clear errors', async () => {
    const opts = { apiKey: 'sk-test', files: [], userPrompt: 'Extract.', systemPrompt: 's', schema: {}, model: 'sonnet', effort: 'medium' as const, timeoutMs: 60_000 };
    const answering = (res: () => Response): typeof globalThis.fetch => () => Promise.resolve(res());
    await expect(extractWithClaudeApi({ ...opts, fetch: answering(() => sse('', 'refusal')) })).rejects.toThrow(/declined/);
    await expect(extractWithClaudeApi({ ...opts, fetch: answering(() => sse('{"accounts": [', 'max_tokens')) })).rejects.toThrow(/more output than one request allows/);
    await expect(extractWithClaudeApi({ ...opts, fetch: answering(() => sse('not json')) })).rejects.toThrow(/not valid JSON/);
  });
});
