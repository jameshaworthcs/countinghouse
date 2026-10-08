// The local model service (src/server/inference.ts, src/shared/tasks.ts; DECISIONS 2026-10-04): the
// task table and Settings → Models, the format v10 migration, the client's waits and failures, and
// documents, receipts and jobs read on it. The service here is a stand-in on a loopback port that
// answers as the real one does (its README "For callers"); no model is run, and no Claude: the one
// Claude below is a stand-in CLI. All data is invented.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { chat, InferenceFailed, InferenceUnavailable, postLong, provenanceOf } from '../src/server/inference';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { providerOf } from '../src/server/ingest/draft';
import { migrateModelSettings } from '../src/server/migrations';
import { readReceipt } from '../src/server/receipts';
import { runModel } from '../src/server/agents/run-model';
import { sanitiseEvent } from '../src/server/sessions';
import type { ImportRecord, Receipt, Transaction } from '../src/shared/schema';
import { SettingsSchema } from '../src/shared/schema';
import type { SessionDetail, SessionListResponse, TranscriptResponse } from '../src/shared/sessions';
import type { AskConversation, AskFeedbackItem, AskListResponse } from '../src/shared/ask';
import type { AuditResponse } from '../src/shared/audit';
import { AskService, markFigures, openingContext } from '../src/server/ask';
import { runTool } from '../src/server/ask-tools';
import type { AskStep } from '../src/shared/ask';
import { claudeChoice, resolveTask, taskOfJob } from '../src/shared/tasks';

const CSRF = { 'x-finance-csrf': '1' };

describe('the task table', () => {
  it('gives documents (but NS&I’s), receipts, names and notes to the local model, and the month in review, insights and research to Claude', () => {
    expect(resolveTask('read-document')).toEqual({ engine: 'inference', model: 'vision-extract', thinking: false, effort: 'high', fallback: false, claudeFor: ['ns-and-i'] });
    expect(resolveTask('check-reading')).toMatchObject({ engine: 'inference', model: 'vision-extract', thinking: true, claudeFor: [] });
    expect(resolveTask('read-receipt')).toMatchObject({ engine: 'inference', model: 'vision-extract' });
    // Moved to Claude, a task takes Claude's model, and back again its local alias and thinking.
    expect(resolveTask('read-document', { 'read-document': { engine: 'claude-cli' } })).toMatchObject({ engine: 'claude-cli', model: 'sonnet', claudeFor: [] });
    expect(resolveTask('check-reading', { 'check-reading': { engine: 'claude-api' } })).toMatchObject({ engine: 'claude-api', model: 'opus' });
    expect(resolveTask('read-document', { 'read-document': { claudeFor: [] } }).claudeFor).toEqual([]);
    expect(resolveTask('label-imports')).toMatchObject({ engine: 'inference', model: 'fast-chat', thinking: false });
    expect(resolveTask('interpret-note')).toMatchObject({ engine: 'inference', model: 'fast-chat' });
    expect(resolveTask('ask')).toMatchObject({ engine: 'inference', model: 'fast-chat', thinking: true });
    for (const t of ['monthly-review', 'insights-after-import', 'research'] as const) expect(resolveTask(t)).toMatchObject({ engine: 'claude-cli', model: 'opus', effort: 'high' });
    expect(taskOfJob('research-provider')).toBe('research');
    expect(taskOfJob('label-imports')).toBe('label-imports');
  });

  it('keeps a choice only where the task allows it', () => {
    // Research needs the web: the local model is not an option, whatever the settings say.
    expect(resolveTask('research', { research: { engine: 'inference', model: 'fast-chat' } })).toMatchObject({ engine: 'claude-cli', model: 'opus' });
    // A text-only alias cannot read a document; a Claude model is not a local alias.
    const local = (model: string) => resolveTask('read-document', { 'read-document': { engine: 'inference', model } }).model;
    expect(local('fast-chat')).toBe('vision-extract');
    expect(local('opus')).toBe('vision-extract');
    expect(local('chat-q8')).toBe('chat-q8');
    expect(resolveTask('read-document', { 'read-document': { engine: 'claude-cli', model: 'vision-extract' } }).model).toBe('sonnet');
    // Moving a task to Claude takes Claude's model for it, not the alias.
    expect(resolveTask('read-document', { 'read-document': { engine: 'claude-cli' } })).toMatchObject({ engine: 'claude-cli', model: 'sonnet', thinking: false, fallback: false });
    expect(resolveTask('check-reading', { 'check-reading': { engine: 'claude-api', effort: 'max' } })).toMatchObject({ engine: 'claude-api', model: 'opus', effort: 'max' });
    expect(resolveTask('check-reading', { 'check-reading': { engine: 'off' } }).engine).toBe('off');
    // Falling back to Claude is the local model's switch, and only where Claude can do the task.
    expect(resolveTask('read-document', { 'read-document': { engine: 'inference', fallback: true } }).fallback).toBe(true);
    expect(resolveTask('read-document', { 'read-document': { engine: 'claude-cli', fallback: true } }).fallback).toBe(false);
    expect(resolveTask('suggest-categories', { 'suggest-categories': { fallback: true } }).fallback).toBe(false);
    expect(claudeChoice('check-reading')).toMatchObject({ engine: 'claude-cli', model: 'opus' });
  });
});

describe('format v10 migration', () => {
  it('moves the reading engine and models into the task table, keeping only what the defaults do not say', () => {
    const owners = { extraction: { engine: 'auto', model: 'sonnet', verifyModel: 'opus', effort: 'high', maxConcurrent: 2, timeoutSeconds: 900, readReceipts: true, rereadDocuments: true, readEverything: true }, agents: { enabled: false, model: 'opus', effort: 'high', labelImports: true } };
    const s = structuredClone(owners) as Record<string, unknown>;
    expect(migrateModelSettings(s)).toEqual({});
    expect(s).toEqual({ extraction: { maxConcurrent: 2, timeoutSeconds: 900, readReceipts: true, rereadDocuments: true, readEverything: true }, agents: { enabled: false, labelImports: true }, models: { tasks: {} } });
    const parsed = SettingsSchema.parse(s);
    expect(resolveTask('read-document', parsed.models.tasks)).toMatchObject({ engine: 'inference', model: 'vision-extract' });
    expect(resolveTask('check-reading', parsed.models.tasks)).toMatchObject({ engine: 'inference', thinking: true });
    expect(resolveTask('label-imports', parsed.models.tasks).engine).toBe('inference');

    const other = { extraction: { engine: 'ocr', model: 'opus', verifyModel: '' }, agents: { model: 'sonnet', effort: 'medium' } } as Record<string, unknown>;
    const tasks = migrateModelSettings(other);
    expect(tasks).toEqual({
      'read-document': { engine: 'ocr' },
      'check-reading': { engine: 'off' },
      'read-receipt': { engine: 'claude-cli', model: 'opus' },
      'monthly-review': { engine: 'claude-cli', model: 'sonnet', effort: 'medium' },
      'insights-after-import': { engine: 'claude-cli', model: 'sonnet', effort: 'medium' },
      research: { engine: 'claude-cli', model: 'sonnet', effort: 'medium' },
    });
    const p = SettingsSchema.parse(other);
    expect(resolveTask('research', p.models.tasks)).toMatchObject({ engine: 'claude-cli', model: 'sonnet', effort: 'medium' });
    expect(resolveTask('read-document', p.models.tasks).engine).toBe('ocr');

    // The API, another checking model and effort are kept for reading and checking.
    const api = { extraction: { engine: 'claude-api', model: 'sonnet', verifyModel: 'fable', effort: 'max' } } as Record<string, unknown>;
    expect(migrateModelSettings(api)).toEqual({
      'read-document': { engine: 'claude-api', effort: 'max' },
      'check-reading': { engine: 'claude-api', model: 'fable', effort: 'max' },
      'read-receipt': { engine: 'claude-cli', effort: 'max' },
    });
  });
});

describe('readings', () => {
  it('leave out a balance line read as a row, and say so without counting it against them', () => {
    const { extraction, warnings, notices } = normaliseExtraction({
      documentType: 'bank_statement',
      accounts: [{ accountType: 'current', openingBalance: 100, closingBalance: 87.7, transactions: [{ date: '2026-09-01', description: 'BALANCE BROUGHT FORWARD', amount: 100 }, { date: '2026-09-12', description: 'TESCO STORES', amount: -12.3 }, { date: '2026-09-30', description: 'Closing balance', amount: 87.7 }, { date: '2026-09-30', description: 'Balance transfer fee', amount: -3 }] }],
      figures: [],
      notes: [],
      confidence: 'high',
    });
    expect(extraction.accounts[0]!.transactions.map((t) => t.description)).toEqual(['TESCO STORES', 'Balance transfer fee']);
    // Put right, so not a problem that calls for a second reading.
    expect(warnings).toEqual([]);
    expect(notices).toEqual(['Account 1: 2 balance lines were read as rows and left out (a balance brought or carried forward is not a payment).']);
  });

  it('do not take a fund’s manager for the provider of the account holding it', () => {
    const holding = (name: string) => ({ name, value: 5204.77 }) as never;
    const page = { institutionName: 'Fidelity', holdings: [holding('Fidelity Index World Fund P Acc')], transactions: [] };
    expect(providerOf(page, { institutionName: null })).toBeUndefined();
    // Named by something other than its funds, or with payments, the provider stands.
    expect(providerOf({ ...page, holdings: [holding('Fidelity Index World Fund P Acc'), holding('Vanguard LifeStrategy 80%')] }, { institutionName: null })).toBe('Fidelity');
    expect(providerOf({ ...page, institutionName: 'Moneybox' }, { institutionName: null })).toBe('Moneybox');
    expect(providerOf({ ...page, transactions: [{ date: '2026-09-01', description: 'Fidelity fee', amount: -1 }] as never }, { institutionName: null })).toBe('Fidelity');
  });

  it('keep no image in a transcript', () => {
    const kept = JSON.stringify(sanitiseEvent({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAA' } }] }] }));
    expect(kept).not.toContain('iVBOR');
    expect(kept).toContain("[not kept: the file's");
  });
});

// ─── The client ─────────────────────────────────────────────────────────────────────────────────

const PROVENANCE = { request_id: 'inf_test_1', alias: 'fast-chat', model_id: 'qwen-test-q4', model_sha256: 'ab'.repeat(32), system_fingerprint: 'inf-0123456789abcdef', sampling: { seed: 42, thinking: false }, schema_valid: true, timings_ms: { queue: 1200, load: 300, prompt: 10, generate: 20 } };
const answer = (content: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: 'qwen-test-q4', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 }, provenance: { ...PROVENANCE, ...extra } }), { status: 200 });
const refuse = (status: number, code: string, message = '', retryAfter?: number) => new Response(JSON.stringify({ error: { code, message, type: 'x' } }), { status, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });
const CFG = { baseUrl: 'http://inference.test/v1', apiKey: 'inf_finance_test' };
const base = { alias: 'fast-chat', content: [{ type: 'text' as const, text: 'Name it.' }], schema: { name: 'output', schema: { type: 'object' } }, priority: 'batch' as const, runMinutes: 1 };

describe('the client', () => {
  it('names the alias, asks for the priority, and returns the output with its provenance', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const res = await chat(CFG, {
      ...base,
      system: 'You name things.',
      maxTokens: 512,
      fetch: (url, init) => {
        seen.push({ url: url as string, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return Promise.resolve(answer({ labels: [] }));
      },
    });
    expect(seen[0]!.url).toBe('http://inference.test/v1/chat/completions');
    expect(seen[0]!.headers).toMatchObject({ Authorization: 'Bearer inf_finance_test', 'X-Inference-Priority': 'batch' });
    expect(seen[0]!.body).toMatchObject({ model: 'fast-chat', max_tokens: 512, response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true } } });
    expect(seen[0]!.body.chat_template_kwargs).toBeUndefined();
    expect(res.output).toEqual({ labels: [] });
    expect(res.provenance).toEqual({ requestId: 'inf_test_1', alias: 'fast-chat', modelId: 'qwen-test-q4', modelSha256: 'ab'.repeat(32), systemFingerprint: 'inf-0123456789abcdef', seed: 42, thinking: false, schemaValid: true, queueMs: 1500 });
    expect(provenanceOf({ request_id: 'r', alias: 'a' }, 'inf-fallback')).toEqual({ requestId: 'r', alias: 'a', systemFingerprint: 'inf-fallback' });
  });

  it('records every part of the request and the parsed output in the transcript, but no image', async () => {
    const events: Record<string, unknown>[] = [];
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    await chat(CFG, {
      ...base,
      content: [{ type: 'text', text: 'Sheet 1\nDate,Amount' }, { type: 'image', mediaType: 'image/png', data: png, name: 'page-1.png', source: { page: 1 } }, { type: 'text', text: 'Read it.' }],
      describe: { model: 'fast-chat', systemPrompt: 'You read.', prompt: 'Read it.', schema: { type: 'object' } },
      transcript: { write: (e) => events.push(e) },
      fetch: () => Promise.resolve(answer({ ok: true })),
    });
    expect(events.map((e) => e.type)).toEqual(['finance.request', 'assistant', 'result']);
    expect(events[0]).toMatchObject({ prompt: 'Read it.', texts: ['Sheet 1\nDate,Amount'], files: [{ name: 'page-1.png', mediaType: 'image/png', bytes: png.length, source: { page: 1 } }] });
    expect(JSON.stringify(events[0])).not.toContain(png.toString('base64'));
    expect(events[2]).toMatchObject({ subtype: 'success', structured_output: { ok: true } });
    // Without a description, its one text is the prompt.
    const plain: Record<string, unknown>[] = [];
    await chat(CFG, { ...base, transcript: { write: (e) => plain.push(e) }, fetch: () => Promise.resolve(answer({ ok: true })) });
    expect(plain[0]).toMatchObject({ prompt: 'Name it.' });
    expect(plain[0]!.texts).toBeUndefined();
  });

  it('stops when its session is stopped, mid-request', async () => {
    const stop = new AbortController();
    let sent = false;
    const call = chat(CFG, {
      ...base,
      priority: 'interactive',
      transcript: { write: () => undefined, signal: stop.signal },
      fetch: (_url, init) =>
        new Promise<Response>((_, reject) => {
          sent = true;
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toBe(true);
    stop.abort();
    await expect(call).rejects.toThrow('Cancelled');
  });

  it('thinks only when asked, within the service’s own limits', async () => {
    let body: Record<string, unknown> = {};
    await chat(CFG, {
      ...base,
      thinking: true,
      maxTokens: 512,
      fetch: (_u, init) => {
        body = JSON.parse(init!.body as string) as Record<string, unknown>;
        return Promise.resolve(answer({}));
      },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.max_tokens).toBeUndefined();
  });

  it('waits while the service cannot take the work, as long as it says, and says why', async () => {
    const replies = [refuse(503, 'queue_timeout', 'GPU leased to uni until 14:30', 120), refuse(503, 'backend_unavailable', 'loading', 30), answer({ ok: true })];
    const slept: number[] = [];
    const waits: string[] = [];
    const res = await chat(CFG, { ...base, fetch: () => Promise.resolve(replies.shift()!), sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      }, onWait: (w) => waits.push(w.reason) });
    expect(res.output).toEqual({ ok: true });
    expect(slept).toEqual([120_000, 30_000]);
    expect(waits).toEqual(['its GPU is lent to another program', 'it is starting or restarting']);
  });

  it('gives up as unavailable after the wait it is allowed; a refused request fails at once', async () => {
    await expect(chat(CFG, { ...base, waitUpToMs: 50_000, fetch: () => Promise.resolve(refuse(503, 'backend_unavailable', '', 30)), sleep: () => Promise.resolve() })).rejects.toBeInstanceOf(InferenceUnavailable);
    await expect(chat(CFG, { ...base, waitUpToMs: 50_000, fetch: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), sleep: () => Promise.resolve() })).rejects.toThrow(/not answering \(ECONNREFUSED\)/);
    let calls = 0;
    await expect(
      chat(CFG, {
        ...base,
        fetch: () => {
          calls++;
          return Promise.resolve(refuse(400, 'context_length_exceeded', 'too long'));
        },
      }),
    ).rejects.toThrow(/refused the request \(400 context_length_exceeded\)/);
    expect(calls).toBe(1);
    await expect(chat(undefined, base)).rejects.toThrow(/not set up here/);
  });

  it('waits for a long answer without a deadline of its own: only the caller’s timeout ends it', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    try {
      const res = await postLong(url, { headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      await expect(postLong(url, { body: '{}', signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      server.close();
    }
  });

  it('fails a reading it could not finish: cut off, or outside the schema', async () => {
    const cut = new Response(JSON.stringify({ choices: [{ message: { content: '{"acc' }, finish_reason: 'length' }], provenance: PROVENANCE }), { status: 200 });
    await expect(chat(CFG, { ...base, fetch: () => Promise.resolve(cut) })).rejects.toBeInstanceOf(InferenceFailed);
    await expect(chat(CFG, { ...base, fetch: () => Promise.resolve(answer({ a: 1 }, { schema_valid: false, schema_errors: ['choice 0: /a: got number, want string'] })) })).rejects.toThrow(/did not match the schema: choice 0/);
    await expect(chat(CFG, { ...base, fetch: () => Promise.resolve(answer('not json')) })).rejects.toThrow(/not valid JSON/);
  });

  it('runs a job on the local model, and on Claude instead only when the task allows it', async () => {
    const opts = { task: 'label-imports' as const, bin: null, inference: CFG, cwd: os.tmpdir(), prompt: 'Imports: …', systemPrompt: 'Name them.', schema: { type: 'object' }, tools: [], timeoutMs: 1000 };
    const r = await runModel({ ...opts, choice: resolveTask('label-imports'), fetch: () => Promise.resolve(answer({ labels: [{ ref: 1, label: 'Example Bank statement, Sep 2026' }] })) });
    expect(r).toMatchObject({ engine: 'inference', model: 'qwen-test-q4', output: { labels: [{ ref: 1 }] }, inference: { requestId: 'inf_test_1' } });
    // No Claude to fall back to: the local model's failure stands.
    await expect(runModel({ ...opts, choice: { ...resolveTask('label-imports'), fallback: true }, fetch: () => Promise.resolve(answer('nope')) })).rejects.toBeInstanceOf(InferenceFailed);
  });
});

// ─── Through the app, with a stand-in service ───────────────────────────────────────────────────

/** The extraction the stand-in returns; "unbalanced" makes the first reading fail its check. */
const statement = (closing: number) => ({ documentType: 'bank_statement', institutionName: 'Example Bank', documentDate: '2026-09-30', accounts: [{ accountType: 'current', name: 'Current account', last4: '5678', currency: 'GBP', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: 100, closingBalance: closing, transactions: [{ date: '2026-09-12', description: 'TESCO STORES', amount: -12.3 }] }], figures: [], notes: [], confidence: 'high' });

type Mode = 'ok' | 'unbalanced' | 'busy-once' | 'down' | 'garbled' | 'nsandi' | 'hang';
interface Seen {
  alias: string;
  priority: string | undefined;
  thinking: boolean;
  images: number;
  schema: string | undefined;
  /** Ask's steps: how many messages it was sent, and whether it asked for a stream. */
  messages?: number;
  stream?: boolean;
}

const NO_ARGS = { text: null, accounts: null, categories: null, from: null, to: null, compareFrom: null, compareTo: null, direction: null, min: null, max: null, currency: null, limit: null, by: null, month: null, on: null, ids: null };
const NO_ANSWER = { answer: null, figures: null, confidence: null, caveats: null, cannotAnswer: null };

function standIn(): { server: Server; seen: Seen[]; mode: { value: Mode }; url: () => string } {
  const seen: Seen[] = [];
  const mode = { value: 'ok' as Mode };
  let busy = true;
  const body = (req: IncomingMessage) => new Promise<string>((r) => {
    let s = '';
    req.on('data', (d: Buffer) => (s += d.toString()));
    req.on('end', () => r(s));
  });
  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== 'Bearer inf_finance_test') return send(401, { error: { code: 'invalid_api_key' } });
      if (req.url === '/health') return send(200, { status: mode.value === 'down' ? 'down' : 'ok', aliases: { 'vision-extract': { state: mode.value === 'down' ? 'unavailable' : 'ready' }, 'fast-chat': { state: 'ready' } }, gpu: { resident: 'moe35', lease: { state: 'none' } } });
      const b = JSON.parse(await body(req)) as { model: string; messages: { role: string; content: unknown }[]; stream?: boolean; chat_template_kwargs?: { enable_thinking?: boolean }; response_format?: { json_schema?: { name: string } } };
      const user = b.messages.find((m) => m.role === 'user')!.content as { type: string }[] | string;
      const thinking = Boolean(b.chat_template_kwargs?.enable_thinking);
      const step = b.response_format?.json_schema?.name === 'step';
      seen.push({ alias: b.model, priority: req.headers['x-inference-priority'] as string | undefined, thinking, images: Array.isArray(user) ? user.filter((p) => p.type === 'image_url').length : 0, schema: b.response_format?.json_schema?.name, ...(step ? { messages: b.messages.length, stream: Boolean(b.stream) } : {}) });
      if (mode.value === 'down') return send(503, { error: { code: 'backend_unavailable', message: 'restarting' } }, { 'retry-after': '1' });
      if (mode.value === 'busy-once' && busy) {
        busy = false;
        return send(503, { error: { code: 'queue_timeout', message: 'the GPU is leased until 14:30' } }, { 'retry-after': '1' });
      }
      const name = b.response_format?.json_schema?.name;
      if (step) {
        // Ask: look for payments in ringgit, then answer from the result (and one figure made up).
        const last = b.messages.at(-1)!.content as { type: string; text: string }[];
        const after = last.some((p) => p.text.startsWith('Result of step'));
        const out = after
          ? { step: 'answer', why: 'The search gives the total', tool: null, args: NO_ARGS, answer: 'You spent £8.40 in ringgit.', figures: [{ label: 'Spent in MYR', value: '£8.40', step: 1 }, { label: 'A guess', value: '£99.99', step: 1 }], confidence: 'high', caveats: [], cannotAnswer: false }
          : { step: 'call', why: 'Payments in Malaysian ringgit', tool: 'find_transactions', args: { ...NO_ARGS, currency: 'MYR' }, ...NO_ANSWER };
        const text = JSON.stringify(out);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ choices: [{ delta: { reasoning_content: 'Malaysia: ringgit.' } }] });
        if (mode.value === 'hang') return void req.on('close', () => res.end());
        chunk({ choices: [{ delta: { content: text.slice(0, 25) } }] });
        chunk({ choices: [{ delta: { content: text.slice(25) }, finish_reason: 'stop' }] });
        chunk({ model: 'qwen3.6-35b-a3b-q4_k_m', choices: [], usage: { prompt_tokens: 2000, completion_tokens: 60 }, provenance: { ...PROVENANCE, request_id: `inf_${seen.length}`, alias: b.model, sampling: { seed: 42, thinking }, schema_valid: true } });
        res.write('data: [DONE]\n\n');
        return void res.end();
      }
      if (mode.value === 'nsandi' && name === 'extraction') {
        const bonds = { documentType: 'account_overview_screenshot', institutionName: 'NS&I', accounts: [{ accountType: 'premium_bonds', name: 'Premium Bonds', currency: 'GBP', closingBalance: 5000, transactions: [] }], figures: [], notes: [], confidence: 'high' };
        return send(200, { model: 'qwen3.6-35b-a3b-q4_k_m', choices: [{ message: { content: JSON.stringify(bonds) }, finish_reason: 'stop' }], usage: {}, provenance: { ...PROVENANCE, request_id: `inf_${seen.length}`, alias: b.model, schema_valid: true } });
      }
      const out = name === 'category' ? { category: 'groceries', confidence: 'high' } : name === 'output' ? { answer: 'You spent £12.30 at Tesco in September.', figures: [{ label: 'Spending', value: '£12.30', from: 'months[2026-09].spending' }], confidence: 'high', caveats: [], cannotAnswer: false } : name === 'receipt' ? { merchant: 'Example Shop', date: '2026-09-12', total: 12.3, lines: [{ description: 'Bread', amount: 2.3, category: 'groceries' }, { description: 'Socks', amount: 10, category: 'clothing' }], notes: [] } : statement(mode.value === 'unbalanced' && !thinking ? 999 : 87.7);
      send(200, {
        model: 'qwen3.6-35b-a3b-q4_k_m',
        system_fingerprint: 'inf-0123456789abcdef',
        choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 400 },
        provenance: { ...PROVENANCE, request_id: `inf_${seen.length}`, alias: b.model, model_id: 'qwen3.6-35b-a3b-q4_k_m', sampling: { seed: 42, thinking }, schema_valid: mode.value !== 'garbled' },
      });
    })();
  });
  return { server, seen, mode, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

/** A stand-in claude CLI: reads any document as a statement that adds up. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' });
out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: ${JSON.stringify(statement(87.7))}, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5, modelUsage: { 'claude-sonnet-5-5': {} } });
`;

const LOCAL = { 'read-document': { engine: 'inference' as const }, 'check-reading': { engine: 'inference' as const }, 'read-receipt': { engine: 'inference' as const } };

describe('through the app', () => {
  let app: App;
  let dir: string;
  let binDir: string;
  const svc = standIn();
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, bin: process.env.FINANCE_CLAUDE_BIN };
  beforeAll(async () => {
    await new Promise<void>((r) => svc.server.listen(0, '127.0.0.1', r));
    // Only the stand-in claude can be found.
    binDir = await mkdtemp(path.join(os.tmpdir(), 'finance-fake-claude-'));
    await mkdir(path.join(binDir, 'home'));
    await writeFile(path.join(binDir, 'claude'), FAKE_CLAUDE);
    await chmod(path.join(binDir, 'claude'), 0o755);
    process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
    process.env.HOME = path.join(binDir, 'home');
    process.env.FINANCE_CLAUDE_BIN = path.join(binDir, 'claude');
  });
  afterAll(async () => {
    svc.server.close();
    await rm(binDir, { recursive: true, force: true, maxRetries: 5 });
    for (const [k, v] of Object.entries({ HOME: saved.HOME, PATH: saved.PATH, FINANCE_CLAUDE_BIN: saved.bin })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    svc.seen.length = 0;
    svc.mode.value = 'ok';
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-inference-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', INFERENCE_BASE_URL: svc.url(), INFERENCE_API_KEY: 'inf_finance_test', INFERENCE_WAIT_MINUTES: '0.03' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    // Documents and receipts on the local model (Claude by default until its evaluation passes).
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: { tasks: LOCAL } });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://127.0.0.1${p}`, { ...init, headers: { host: '127.0.0.1', ...(init.headers ?? {}) } });
  const get = async <T,>(p: string) => (await (await req(p)).json()) as T;
  const until = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let v = await fn();
    for (let i = 0; i < 300 && !ok(v); i++) {
      await new Promise((r) => setTimeout(r, 50));
      v = await fn();
    }
    return v;
  };
  async function upload(): Promise<ImportRecord> {
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'screenshot.png');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    return until(
      () => get<ImportRecord>(`/api/imports/${results[0]!.id}`),
      (r) => ['review', 'failed', 'needs_mapping'].includes(r.status),
    );
  }

  it('reads an upload on the local model when Settings → Models says so, keeps its provenance, and records the session', async () => {
    const rec = await upload();
    expect(rec.status).toBe('review');
    expect(rec.extraction).toMatchObject({ engine: 'inference', model: 'qwen3.6-35b-a3b-q4_k_m', inference: { alias: 'vision-extract', modelSha256: 'ab'.repeat(32), systemFingerprint: 'inf-0123456789abcdef', seed: 42, thinking: false, schemaValid: true } });
    expect(rec.extraction.costUsd).toBeUndefined();
    // The local model's own rules are part of its reader's version.
    expect(rec.extraction.engineVersion).toMatch(/^extract-\d+\+local-1$/);
    expect(rec.extraction.waiting).toBeUndefined();
    expect(rec.extraction.verification).toMatchObject({ method: 'checks', firstModel: 'vision-extract', firstInference: { alias: 'vision-extract' } });
    expect(svc.seen).toEqual([{ alias: 'vision-extract', priority: 'batch', thinking: false, images: 1, schema: 'extraction' }]);
    const s = (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.importId === rec.id)!;
    expect(s).toMatchObject({ engine: 'inference', model: 'qwen3.6-35b-a3b-q4_k_m', status: 'succeeded', role: 'first' });
    const detail = await get<{ record: { inference: Record<string, unknown>; thinking: boolean; tools: string[] } }>(`/api/sessions/${s.id}`);
    expect(detail.record).toMatchObject({ thinking: false, tools: [], inference: { alias: 'vision-extract', request_id: 'inf_1' } });
    const t = await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript`);
    expect(t.events.map((e) => (e as { type: string }).type)).toEqual(['finance.request', 'assistant', 'result']);
    const text = await readFile(path.join(dir, 'work', 'sessions', '..', 'imports', rec.id, `${s.id}.jsonl`), 'utf8').catch(() => JSON.stringify(t.events));
    expect(text).not.toContain('base64,');
  });

  it('checks a reading that does not add up with a second local reading, thinking', async () => {
    svc.mode.value = 'unbalanced';
    const rec = await upload();
    expect(svc.seen.map((x) => [x.alias, x.thinking, x.priority])).toEqual([
      ['vision-extract', false, 'batch'],
      ['vision-extract', true, 'batch'],
    ]);
    expect(rec.extraction.verification).toMatchObject({ method: 'second-reading', firstModel: 'vision-extract', secondModel: 'vision-extract, thinking', kept: 'second', firstInference: { thinking: false }, secondInference: { thinking: true } });
    expect(rec.extraction.inference).toMatchObject({ thinking: true });
    expect(rec.extraction.raw!.accounts[0]!.closingBalance).toBe(87.7);
  });

  it('waits while the service cannot take the reading, then reads it', async () => {
    svc.mode.value = 'busy-once';
    const rec = await upload();
    expect(rec.status).toBe('review');
    expect(rec.extraction.engine).toBe('inference');
    expect(rec.extraction.waiting).toBeUndefined();
    expect(svc.seen).toHaveLength(2);
    const s = (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.importId === rec.id)!;
    const t = await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript`);
    expect(t.events.find((e) => (e as { type: string }).type === 'finance.waiting')).toMatchObject({ status: 503, code: 'queue_timeout', reason: 'its GPU is lent to another program' });
  });

  it('never sends a document to Claude by itself: down, the reading fails, and Claude reads it when you ask', async () => {
    svc.mode.value = 'down';
    const rec = await upload();
    expect(rec.status).toBe('failed');
    expect(rec.extraction.error).toMatch(/could not take this .*it is starting or restarting/);
    expect(rec.extraction.waiting).toBeUndefined();
    expect(svc.seen.length).toBeGreaterThan(1);
    // Read with Claude: your click.
    await req(`/api/imports/${rec.id}/reprocess`, { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'claude-cli', interrupt: true }) });
    const again = await until(
      () => get<ImportRecord>(`/api/imports/${rec.id}`),
      (r) => ['review', 'failed'].includes(r.status),
    );
    expect(again).toMatchObject({ status: 'review', extraction: { engine: 'claude-cli', model: 'claude-sonnet-5-5' } });
  });

  it('falls back to Claude by itself only where Settings → Models allows it, and says so', async () => {
    svc.mode.value = 'down';
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: { tasks: { ...LOCAL, 'read-document': { engine: 'inference', fallback: true } } } });
    const rec = await upload();
    expect(rec).toMatchObject({ status: 'review', extraction: { engine: 'claude-cli', model: 'claude-sonnet-5-5' } });
    expect(rec.extraction.warnings[0]).toMatch(/The local model could not take this .* Claude read it instead, as Settings → Models allows for read documents\./);
    const sessions = (await get<SessionListResponse>('/api/sessions')).sessions.filter((x) => x.importId === rec.id);
    expect(sessions.map((x) => [x.engine, x.status]).sort()).toEqual([
      ['claude-cli', 'succeeded'],
      ['inference', 'failed'],
    ]);
    // Claude's session names the one it stood in for, and why.
    const local = sessions.find((x) => x.engine === 'inference')!;
    const claude = (await get<SessionDetail>(`/api/sessions/${sessions.find((x) => x.engine === 'claude-cli')!.id}`)).record!;
    expect(claude.fallbackOf).toBe(local.id);
    expect(claude.fallbackReason).toMatch(/The local model could not take this/);
  });

  it('has Claude read a document of a provider Settings → Models names, and says so', async () => {
    svc.mode.value = 'nsandi';
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: { tasks: {} } });
    const rec = await upload();
    expect(rec).toMatchObject({ status: 'review', extraction: { engine: 'claude-cli', model: 'claude-sonnet-5-5' } });
    expect(rec.extraction.engineVersion).not.toMatch(/local/);
    expect(rec.extraction.warnings[0]).toMatch(/The local model read it as NS&I's, whose documents Claude reads \(Settings → Models\)/);
    // One local reading found it out; Claude read it (and its own figures confirmed it).
    expect(svc.seen).toHaveLength(1);
    const sessions = (await get<SessionListResponse>('/api/sessions')).sessions.filter((x) => x.importId === rec.id);
    expect(sessions.map((x) => x.engine).sort()).toEqual(['claude-cli', 'inference']);
  });

  it('fails a reading outside the schema rather than keep it', async () => {
    svc.mode.value = 'garbled';
    const rec = await upload();
    expect(rec.status).toBe('failed');
    expect(rec.extraction.error).toMatch(/did not match the schema/);
  });

  it('reads a receipt on the local model in the background', async () => {
    const { store, config } = app.ctx;
    const stamp = '2026-09-12T10:00:00.000Z';
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const tx: Transaction = { id: 'tx_0123456789abcdef', accountId: 'current', date: '2026-09-12', amount: -12.3, currency: 'GBP', description: 'EXAMPLE SHOP', source: {} };
    await store.addTransactions([tx], 'test: a payment');
    await store.setSettings({ ...store.settings, extraction: { ...store.settings.extraction, readReceipts: true } });
    const png = await sharp({ create: { width: 300, height: 500, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
    const first = (await (await req(`/api/transactions/${tx.id}/receipts`, { method: 'POST', headers: CSRF, body: form })).json()) as Receipt;
    expect(first.status).toBe('reading');
    const read = await until(
      () => Promise.resolve(store.receipts.find((r) => r.id === first.id)!),
      (r) => r.status !== 'reading',
    );
    expect(read).toMatchObject({ status: 'read', reading: { model: 'qwen3.6-35b-a3b-q4_k_m', promptVersion: 'receipt-2', inference: { alias: 'vision-extract' }, merchant: 'Example Shop', total: 12.3 } });
    expect(read.reading!.lines.map((l) => l.amount)).toEqual([-2.3, -10]);
    expect(svc.seen.at(-1)).toMatchObject({ alias: 'vision-extract', schema: 'receipt', images: 1 });
    // Asked to wait (the CLI, a test), it answers when the reading is done.
    const again = await readReceipt(store, config, first.id, { wait: true, sessions: app.ctx.sessions });
    expect(again.status).toBe('read');
  });

  it('suggests categories for what the rules leave, one description at a time, as a proposal', async () => {
    const { store } = app.ctx;
    const stamp = '2026-09-12T10:00:00.000Z';
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const row = (id: string, date: string, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id, accountId: 'current', date, amount: -4.2, currency: 'GBP', description, source: {}, ...extra });
    await store.addTransactions(
      [
        row('tx_00000000000000a1', '2026-09-01', 'CORNER STORE 123'),
        row('tx_00000000000000a2', '2026-09-08', 'CORNER STORE 123'),
        row('tx_00000000000000a3', '2026-09-09', 'TESCO STORES', { category: 'groceries', categorisedBy: 'builtin' }),
        row('tx_00000000000000a4', '2026-09-10', 'A FRIEND', { category: 'gifts', categorisedBy: 'user' }),
        // Cash paid in is yours to decide (To categorise → People and cash): never asked about.
        row('tx_00000000000000a5', '2026-09-11', 'CASH DEPOSIT HIGH STREET', { amount: 60, type: 'Cash deposit' }),
      ],
      'test: payments',
    );
    const before = await get<{ waiting: number }>('/api/suggest-categories');
    expect(before.waiting).toBe(1);
    expect((await req('/api/suggest-categories', { method: 'POST', headers: CSRF })).status).toBe(202);
    const done = await until(
      () => get<{ running: boolean; last: { proposalId?: string; asked?: number; suggested?: number } | null }>('/api/suggest-categories'),
      (x) => !x.running && Boolean(x.last),
    );
    expect(done.last).toMatchObject({ asked: 1, suggested: 2 });
    expect(svc.seen).toEqual([{ alias: 'fast-chat', priority: 'batch', thinking: false, images: 0, schema: 'category' }]);
    const view = await app.ctx.proposals.get(done.last!.proposalId!);
    expect(view.proposal.provenance).toMatchObject({ setBy: 'agent', engine: 'inference', promptVersion: 'suggest-categories-1', inference: { alias: 'fast-chat' } });
    expect(view.proposal.changes.map((c) => [c.kind, (c as { transaction: string }).transaction, (c as { category: string }).category])).toEqual([
      ['set_category', 'tx_00000000000000a2', 'groceries'],
      ['set_category', 'tx_00000000000000a1', 'groceries'],
    ]);
    // Nothing is categorised until you apply it.
    expect(store.transaction('tx_00000000000000a1')!.category).toBeUndefined();
  });

  /** Two payments made abroad in ringgit, and one at home. */
  async function abroad() {
    const stamp = '2026-08-12T10:00:00.000Z';
    await app.ctx.store.setAccounts([{ id: 'card', name: 'Card', type: 'credit_card', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const row = (id: string, date: string, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id, accountId: 'card', date, amount: -4.2, currency: 'GBP', description, source: {}, ...extra });
    await app.ctx.store.addTransactions(
      [row('tx_00000000000000b1', '2026-08-03', 'NASI KANDAR KL', { original: { amount: -25, currency: 'MYR' }, category: 'holidays' }), row('tx_00000000000000b2', '2026-08-04', 'GRAB KUALA LUMPUR', { original: { amount: -25, currency: 'MYR' }, category: 'holidays' }), row('tx_00000000000000b3', '2026-08-20', 'TESCO STORES')],
      'test: payments',
    );
  }
  const post = (p: string, body: unknown) => req(p, { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const turnDone = (id: string, n: number) =>
    until(
      () => get<AskConversation>(`/api/ask/${id}`),
      (c) => c.turns.length >= n && c.turns[n - 1]!.status !== 'running' && c.turns[n - 1]!.status !== 'queued',
    );

  it('answers a question step by step with the app’s tools, streamed at interactive priority, and marks which figures the app computed', async () => {
    await abroad();
    const res = await post('/api/ask', { question: 'How much did I spend in Malaysia?' });
    expect(res.status).toBe(202);
    const conv = (await res.json()) as AskConversation;
    const c = await turnDone(conv.id, 1);
    const t = c.turns[0]!;
    expect(t).toMatchObject({ status: 'answered', promptVersion: 'ask-3', model: { id: 'local-thinking' } });
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0]).toMatchObject({ n: 1, tool: 'find_transactions', args: { currency: 'MYR' }, why: 'Payments in Malaysian ringgit', summary: '2 payments found, money out £8.40' });
    expect(t.steps[0]!.href).toContain('currency=MYR');
    expect(t.steps[0]!.resultText).toContain('"byOriginalCurrency":[{"currency":"MYR","amount":-50,"payments":2}]');
    // A figure is the app's only when it is in what the app gave back.
    expect(t.answer!.figures.map((f) => [f.value, f.computed])).toEqual([
      ['£8.40', true],
      ['£99.99', false],
    ]);
    // A figure of the model's own lowers the answer's confidence, and says why.
    expect(t.answer).toMatchObject({ confidence: 'low', modelConfidence: 'high' });
    expect(t.answer!.caveats[0]).toMatch(/^One figure is not in what the app gave the model/);
    expect(svc.seen.map((x) => [x.schema, x.priority, x.thinking, x.stream, x.messages])).toEqual([
      ['step', 'interactive', true, true, 2],
      ['step', 'interactive', true, true, 4],
    ]);
    // Its session: kind ask, beside the conversation, every step in the transcript.
    const s = (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.kind === 'ask')!;
    expect(s).toMatchObject({ conversationId: c.id, status: 'succeeded', promptVersion: 'ask-3' });
    expect(t.sessions).toEqual([s.id]);
    const types = (await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript`)).events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['finance.request', 'assistant', 'result', 'finance.tool', 'finance.request', 'assistant', 'result', 'finance.answer']);
    const detail = await get<SessionDetail>(`/api/sessions/${s.id}`);
    expect(detail.produced.map((o) => o.type)).toEqual(['step 1: find_transactions', 'answer']);
    expect(detail.record!.requestId).toMatch(/^req_/);

    // A follow-up carries the conversation: the first question, its step and answer come before it.
    await post(`/api/ask/${c.id}/turns`, { question: 'And how many payments was that?' });
    const c2 = await turnDone(c.id, 2);
    expect(c2.turns[1]!.status).toBe('answered');
    expect(svc.seen[2]!.messages).toBe(6);

    // Listed, and kept across a restart.
    expect((await get<AskListResponse>('/api/ask')).conversations.map((x) => [x.id, x.turns])).toEqual([[c.id, 2]]);
    const again = new AskService(app.ctx.store, app.ctx.analytics, app.ctx.config, app.ctx.sessions);
    await again.init({ sweep: false });
    expect(again.get(c.id)!.turns.map((x) => x.status)).toEqual(['answered', 'answered']);

    // "This is wrong" goes into the evaluation set; Delete takes it off the list but keeps it.
    await post(`/api/ask/${c.id}/turns/${t.id}/feedback`, { wrong: true, note: 'It missed the hotel.' });
    expect((await get<{ items: AskFeedbackItem[] }>('/api/ask/feedback')).items).toMatchObject([{ conversationId: c.id, turnId: t.id, note: 'It missed the hotel.', promptVersion: 'ask-3' }]);
    // An agent token with the records scope may mark one too, and is named; it may not ask.
    const made = (await app.ctx.tokens.create({ name: 'Reviewer', scopes: ['records'], days: 7 })) as { token: string };
    const bearer = { authorization: `Bearer ${made.token}`, ...CSRF, 'content-type': 'application/json' };
    expect((await req(`/api/ask/${c.id}/turns/${c2.turns[1]!.id}/feedback`, { method: 'POST', headers: bearer, body: JSON.stringify({ wrong: true, note: 'Counted twice.' }) })).status).toBe(200);
    expect((await get<AskConversation>(`/api/ask/${c.id}`)).turns[1]!.feedback).toMatchObject({ wrong: true, by: 'Agent token “Reviewer”' });
    expect((await req(`/api/ask/${c.id}/turns`, { method: 'POST', headers: bearer, body: JSON.stringify({ question: 'And in July?' }) })).status).toBe(403);
    expect((await req(`/api/ask/${c.id}`, { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect((await get<AskListResponse>('/api/ask')).conversations).toEqual([]);
    expect((await get<AskConversation>(`/api/ask/${c.id}`)).hidden).toBeTruthy();
  });

  it('gives the model the app’s own sums from its tools, and says plainly what is wrong with a call', async () => {
    await abroad();
    const { store, analytics } = app.ctx;
    const by = runTool(store, analytics, 'spending_by', { by: 'category', from: '2026-08-01', to: '2026-08-31' });
    expect(by.result).toMatchObject({ total: 12.6, groups: [{ id: 'holidays', spent: 8.4, payments: 2 }, { spent: 4.2, payments: 1 }] });
    expect(runTool(store, analytics, 'sum', { ids: ['tx_00000000000000b1', 'tx_00000000000000b2', 'tx_nope'] }).result).toEqual({ count: 2, moneyIn: 0, moneyOut: -8.4, net: -8.4, notFound: ['tx_nope'] });
    const tesco = runTool(store, analytics, 'find_transactions', { text: 'tesco', limit: 1 });
    expect(tesco.result).toMatchObject({ count: 1, moneyOut: -4.2 });
    // The owner's defaults apply when the model gives no period.
    expect(runTool(store, analytics, 'find_transactions', { text: null }, { from: '2026-08-10', to: '2026-08-31' }).result).toMatchObject({ count: 1 });
    expect(runTool(store, analytics, 'trips', { from: '2026-08-01', to: '2026-08-31' }).result).toMatchObject({ trips: [{ from: '2026-08-03', to: '2026-08-04', spent: 8.4, payments: 2 }] });
    expect(() => runTool(store, analytics, 'find_transactions', { accounts: ['nope'] })).toThrow(/No account with the id nope/);
    expect(() => runTool(store, analytics, 'find_transactions', { text: null, currency: null })).toThrow(/at least one filter/);
    expect(() => runTool(store, analytics, 'find_transactions', { from: 'last week' })).toThrow(/YYYY-MM-DD/);
    expect(() => runTool(store, analytics, 'month', { month: '2026-13' })).toThrow(/YYYY-MM/);
    // Figures with thousands separators are found; the step they name is the one looked in.
    const steps = [{ n: 1, resultText: '{"moneyOut":-1234.56}' }, { n: 2, resultText: '{"count":3}' }] as AskStep[];
    expect(markFigures([{ label: 'a', value: '£1,234.56', step: 1 }, { label: 'b', value: '£1,234.56', step: 2 }, { label: 'c', value: '3 payments', step: null }], steps).map((f) => f.computed)).toEqual([true, false, true]);
  });

  it('gives a year-on-year question totals by year and a comparison, so there is nothing left to add up', async () => {
    const stamp = '2025-01-01T10:00:00.000Z';
    const { store, analytics } = app.ctx;
    await store.setAccounts([{ id: 'amex', name: 'Amex', type: 'credit_card', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const row = (id: string, date: string, amount: number): Transaction => ({ id, accountId: 'amex', date, amount, currency: 'GBP', description: 'SHOP', category: 'groceries', source: {} });
    // A refund in September 2025 counts as negative spending, as the Spending page counts it.
    await store.addTransactions([row('tx_00000000000000c1', '2025-03-10', -100), row('tx_00000000000000c2', '2025-09-10', 50), row('tx_00000000000000c3', '2025-11-10', -80), row('tx_00000000000000c4', '2026-03-10', -120), row('tx_00000000000000c5', '2026-08-10', -30)], 'test: payments');
    const by = runTool(store, analytics, 'spending_by', { by: 'month', accounts: ['amex'], from: '2025-01-01', to: '2026-08-31' }).result as { total: number; refunds: number; months: { month: string; spent: number }[]; byYear: { year: string; spent: number; paid: number; refunds: number; months: number; averagePerMonth: number }[] };
    expect(by).toMatchObject({ total: 280, refunds: 50 });
    expect(by.months).toHaveLength(20);
    expect(by.months.find((m) => m.month === '2025-09')!.spent).toBe(-50);
    expect(by.byYear).toEqual([
      expect.objectContaining({ year: '2025', spent: 130, paid: 180, refunds: 50, months: 12, averagePerMonth: 10.83 }),
      expect.objectContaining({ year: '2026', spent: 150, paid: 150, refunds: 0, months: 8, averagePerMonth: 18.75 }),
    ]);
    // compare: the same dates a year earlier unless told; its verdict, difference and change are the app's.
    const cmp = runTool(store, analytics, 'compare', { accounts: ['amex'], from: '2026-01-01', to: '2026-08-31' }).result as Record<string, unknown>;
    expect(cmp).toMatchObject({ measure: 'spending', period: { from: '2026-01-01', to: '2026-08-31', total: 150 }, comparedWith: { from: '2025-01-01', to: '2025-08-31', total: 100 }, difference: 50, changePercent: 50, verdict: 'more spending in the period than in the one compared with' });
    const unequal = runTool(store, analytics, 'compare', { accounts: ['amex'], from: '2026-01-01', to: '2026-08-31', compareFrom: '2025-01-01', compareTo: '2025-12-31' }).result as { comparedWith: { total: number; months: number }; difference: number; note: string };
    expect(unequal).toMatchObject({ comparedWith: { total: 130, months: 12 }, difference: 20 });
    expect(unequal.note).toMatch(/different lengths/);
    // A search over two years gives each year's totals too.
    expect(runTool(store, analytics, 'find_transactions', { accounts: ['amex'], from: '2025-01-01', to: '2026-12-31' }).result).toMatchObject({ byYear: [{ year: '2025', moneyIn: 50, moneyOut: -180, net: -130 }, { year: '2026', moneyOut: -150 }] });
    // The opening gives years, so the model need not add months either.
    expect(openingContext(store, analytics)).toMatch(/to the same date \(/);
  });

  it('stops a question being answered, and takes back one waiting', async () => {
    await abroad();
    svc.mode.value = 'hang';
    const conv = (await (await post('/api/ask', { question: 'How much did I spend in Malaysia?' })).json()) as AskConversation;
    await until(
      () => get<AskConversation>(`/api/ask/${conv.id}`),
      (c) => c.turns[0]!.live?.phase === 'thinking',
    );
    // A follow-up waits behind it, and can be taken back.
    const queued = (await (await post(`/api/ask/${conv.id}/turns`, { question: 'And in July?' })).json()) as AskConversation;
    expect(queued.turns[1]!.status).toBe('queued');
    await post(`/api/ask/${conv.id}/cancel`, { turnId: queued.turns[1]!.id });
    expect((await post(`/api/ask/${conv.id}/cancel`, {})).status).toBe(200);
    const c = await turnDone(conv.id, 1);
    expect(c.turns.map((t) => [t.status, t.stoppedBy])).toEqual([
      ['cancelled', 'You (on this machine, no login)'],
      ['cancelled', 'You (on this machine, no login)'],
    ]);
    const s = await until(
      async () => (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.kind === 'ask')!,
      (x) => x.status !== 'running',
    );
    expect(s.status).toBe('cancelled');
    expect((await get<AuditResponse>('/api/audit?all=1')).entries.map((e) => e.action)).toEqual(expect.arrayContaining(['session.cancel', 'ask.cancel']));
  });
});
