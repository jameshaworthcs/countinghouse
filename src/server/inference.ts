// The local model service (inference.service on this machine; its README "For callers"): an
// OpenAI-compatible API, reached over the tailnet with finance's own key. Nothing sent to it leaves
// P360, and it keeps no prompt, image or output. It has no web access and no tools, and it is slow
// (minutes per document), so every call here:
//   - names an alias (vision-extract, fast-chat…), never a model file;
//   - asks for the task's priority (batch for anything that takes minutes);
//   - waits its turn: one batch or normal request of finance's at a time, since the GPU model has
//     one slot for them, and an interactive one beside it;
//   - retries while the service cannot take it (starting, a crash, its GPU lent out, its queue full),
//     after the wait it gives, for up to `waitUpToMs`, then gives up as unavailable;
//   - keeps the service's provenance with what it produced.
// Its events go to the session's transcript (sessions.ts), images left out.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { InferenceProvenance } from '../shared/schema';
import type { Priority } from '../shared/tasks';
import { stopSignal, type TranscriptSink } from './sessions';

export interface InferenceConfig {
  baseUrl: string;
  apiKey: string;
  /** How long work waits for the service before giving up as unavailable (default 12 hours). */
  waitUpToMs?: number;
}

/** A part of the user's message: text, or an image (PNG or JPEG), with the stored document it is a page of. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: Buffer; name?: string; source?: { importId?: string; receiptId?: string; page?: number } };

export interface ChatRequest {
  alias: string;
  system?: string;
  /** Earlier turns of a conversation, before `content` (Ask's steps): the service reuses their cached prompt. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  content: ContentPart[];
  /** Constrains the output to this JSON Schema; the service checks the output against it too. */
  schema?: { name: string; schema: Record<string, unknown> };
  thinking?: boolean;
  maxTokens?: number;
  priority: Priority;
  /** Minutes the answer may take once its turn comes. */
  runMinutes: number;
  /** How long to keep trying while the service cannot take the request (default 12 hours). */
  waitUpToMs?: number;
  signal?: AbortSignal | undefined;
  transcript?: TranscriptSink | undefined;
  /** Called each time the request has to wait for the service, with why and until when. */
  onWait?: ((wait: { reason: string; until?: string }) => void) | undefined;
  /** What the transcript's first event says about the request (prompt, schema, files). */
  describe?: Record<string, unknown>;
  /**
   * Stream the answer: called with its reasoning and text so far as they arrive (Ask shows them).
   * Without it the answer comes whole, as before.
   */
  onDelta?: ((so: { reasoning: string; content: string }) => void) | undefined;
  /** Tests only: stand in for the network and the clock. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ChatResult {
  text: string;
  /** The output parsed as JSON, when a schema was sent. */
  output?: unknown;
  reasoning?: string;
  provenance: InferenceProvenance;
  /** The whole provenance object, as the service sent it. */
  provenanceFull: Record<string, unknown>;
  usage: { promptTokens?: number; completionTokens?: number };
  durationMs: number;
}

/** The service could not take the work in time (down, its GPU lent out, or not set up). */
export class InferenceUnavailable extends Error {}
/** The service took the work and could not finish it (cut off, output not in the schema, a request it refused). */
export class InferenceFailed extends Error {}

const QUEUE_LIMIT_MS: Record<Priority, number> = { interactive: 30_000, normal: 5 * 60_000, batch: 60 * 60_000 };
const DEFAULT_WAIT_MS = 12 * 3600_000;
const RETRYABLE = new Set([429, 502, 503]);

/**
 * A POST without the 5-minute wait for headers that Node's fetch has (undici's headersTimeout): the
 * service answers a long reading only when it is done, often after more than 5 minutes, and fetch
 * would cut it off. Only `signal` (the caller's timeout and cancelling) ends the wait.
 */
export function postLong(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, { method: init.method ?? 'POST', headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body ?? '')) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
      });
      res.on('error', reject);
    });
    const abort = () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Cancelled'));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    req.on('error', reject);
    req.on('close', () => init.signal?.removeEventListener('abort', abort));
    req.end(init.body);
  });
}

/**
 * A streamed POST (`stream: true`): the service's server-sent events are read as they arrive, the
 * reasoning and text so far passed to `onDelta`, and the whole given back as the response a request
 * without `stream` would have had (its usage chunk carries the provenance). An error answer (a 503
 * while the service cannot take it) is not a stream and comes back as it is.
 */
export function postStream(url: string, init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }, onDelta: (so: { reasoning: string; content: string }) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, { method: 'POST', headers: { ...init.headers, Accept: 'text/event-stream', 'Content-Length': String(Buffer.byteLength(init.body ?? '')) } }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
      if (res.statusCode !== 200 || !String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers })));
        res.on('error', reject);
        return;
      }
      let buf = '';
      let reasoning = '';
      let content = '';
      let finish: string | undefined;
      let error: unknown;
      const whole: Record<string, unknown> = {};
      const event = (data: string) => {
        if (data === '[DONE]') return;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (chunk.error) error = chunk.error;
        for (const k of ['id', 'model', 'system_fingerprint', 'usage', 'provenance']) if (chunk[k] !== undefined && chunk[k] !== null) whole[k] = chunk[k];
        const choice = (chunk.choices as { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }[] | undefined)?.[0];
        if (!choice) return;
        if (typeof choice.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
        if (typeof choice.delta?.content === 'string') content += choice.delta.content;
        if (choice.finish_reason) finish = choice.finish_reason;
        if (choice.delta?.reasoning_content || choice.delta?.content) onDelta({ reasoning, content });
      };
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.startsWith('data:')) event(line.slice(5).trim());
        }
      });
      let ended = false;
      // Cut off before its end (stopped, or the connection dropped): not an answer.
      res.on('close', () => {
        if (!ended) reject(init.signal?.aborted ? new Error('Cancelled') : new Error('The stream ended before the answer did.'));
      });
      res.on('end', () => {
        ended = true;
        if (buf.startsWith('data:')) event(buf.slice(5).trim());
        // An error sent mid-stream: the service failed after it took the request.
        if (error) return resolve(new Response(JSON.stringify({ error }), { status: 502, headers }));
        resolve(new Response(JSON.stringify({ ...whole, choices: [{ message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish ?? null }] }), { status: 200, headers }));
      });
      res.on('error', reject);
    });
    const abort = () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Cancelled'));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    req.on('error', reject);
    req.on('close', () => init.signal?.removeEventListener('abort', abort));
    req.end(init.body);
  });
}

let turn: Promise<void> = Promise.resolve();

/**
 * One batch or normal request of finance's at a time: the service runs them in one slot, and a
 * second sent beside the first only spends its queue wait. Interactive requests have a slot of
 * their own and do not wait here.
 */
async function inTurn<T>(priority: Priority, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (priority === 'interactive') return fn();
  const before = turn;
  let release!: () => void;
  turn = new Promise<void>((r) => (release = r));
  try {
    // Cancelled while waiting its turn: the turn passes on when the one before it ends.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled'));
      signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      void before.then(resolve);
    });
  } catch (err) {
    void before.then(release);
    throw err;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Cancelled'));
      },
      { once: true },
    );
  });
}

/** The provenance minimum kept with a record (the service's README §4). */
export function provenanceOf(p: Record<string, unknown>, fallbackFingerprint?: string): InferenceProvenance {
  const sampling = (p.sampling ?? {}) as Record<string, unknown>;
  const timings = (p.timings_ms ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const queue = (num(timings.queue) ?? 0) + (num(timings.load) ?? 0);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const out: InferenceProvenance = { requestId: str(p.request_id), alias: str(p.alias) };
  if (typeof p.model_id === 'string') out.modelId = p.model_id;
  if (typeof p.model_sha256 === 'string') out.modelSha256 = p.model_sha256;
  const fp = typeof p.system_fingerprint === 'string' ? p.system_fingerprint : fallbackFingerprint;
  if (fp) out.systemFingerprint = fp;
  if (Number.isInteger(sampling.seed)) out.seed = sampling.seed as number;
  if (typeof sampling.thinking === 'boolean') out.thinking = sampling.thinking;
  if (typeof p.schema_valid === 'boolean') out.schemaValid = p.schema_valid;
  if (queue > 0) out.queueMs = Math.round(queue);
  return out;
}

/** Why the service could not take a request, in plain words, from its error. */
function waitReason(status: number, code: string | undefined, message: string | undefined): string {
  if (status === 503 && code === 'queue_timeout' && /lease|lent/i.test(message ?? '')) return 'its GPU is lent to another program';
  if (status === 503 && code === 'queue_timeout') return 'its queue is long';
  if (status === 503) return 'it is starting or restarting';
  if (status === 502) return 'it failed mid-request and is recovering';
  if (status === 429) return 'too many of finance’s requests are waiting';
  return 'it is not answering';
}

export async function chat(cfg: InferenceConfig | undefined, req: ChatRequest): Promise<ChatResult> {
  if (!cfg) throw new InferenceUnavailable('The local model service is not set up here: set INFERENCE_BASE_URL and INFERENCE_API_KEY in .env.');
  const onDelta = req.onDelta;
  const doFetch =
    req.fetch ??
    ((url: string | URL | Request, init?: RequestInit) => {
      const i = init as { headers?: Record<string, string>; body?: string; signal?: AbortSignal };
      return onDelta ? postStream(url as string, i, onDelta) : postLong(url as string, i);
    });
  const sleep = req.sleep ?? defaultSleep;
  const sink = req.transcript;
  // Stopping the session (its page's Stop) stops the request too.
  const signal = stopSignal(req.signal, sink);
  const content = req.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data.toString('base64')}` } }));
  const body: Record<string, unknown> = {
    model: req.alias,
    messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...(req.history ?? []), { role: 'user', content }],
    ...(req.onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(req.thinking ? { chat_template_kwargs: { enable_thinking: true } } : req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: req.schema.name, schema: req.schema.schema, strict: true } } } : {}),
  };
  // Every part of the request: text the description does not already give (a spreadsheet's text),
  // and each image by name, size and the stored document it came from (its bytes are not kept).
  const described = typeof req.describe?.prompt === 'string' ? req.describe.prompt : undefined;
  const texts = req.content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && p.text !== described).map((p) => p.text);
  sink?.write({
    type: 'finance.request',
    engine: 'inference',
    alias: req.alias,
    priority: req.priority,
    thinking: Boolean(req.thinking),
    ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    ...(req.history?.length ? { earlierMessages: req.history.length } : {}),
    ...req.describe,
    ...(texts.length ? (described === undefined && texts.length === 1 ? { prompt: texts[0] } : { texts }) : {}),
    files: req.content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image').map((p) => ({ name: p.name, mediaType: p.mediaType, bytes: p.data.length, ...(p.source ? { source: p.source } : {}) })),
  });
  const started = Date.now();
  const waitUpTo = req.waitUpToMs ?? cfg.waitUpToMs ?? DEFAULT_WAIT_MS;
  const attemptMs = QUEUE_LIMIT_MS[req.priority] + req.runMinutes * 60_000 + 2 * 60_000;
  const payload = JSON.stringify(body);
  let waited = 0;
  let dropped = 0;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    let status = 0;
    let json: Record<string, unknown> | undefined;
    let retryAfterMs: number | undefined;
    let netError: string | undefined;
    const sent = Date.now();
    try {
      const res = await inTurn(req.priority, signal, () =>
        doFetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'X-Inference-Priority': req.priority },
          body: payload,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]) : AbortSignal.timeout(attemptMs),
        }),
      );
      status = res.status;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
      json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    } catch (err) {
      if (signal?.aborted) throw new Error('Cancelled');
      if ((err as Error).name === 'TimeoutError') throw new InferenceFailed(`The local model did not answer within ${Math.round(attemptMs / 60_000)} minutes.`);
      status = 0; // not answering: down, or the network
      netError = (err as NodeJS.ErrnoException).code ?? (err as Error).message.slice(0, 120);
      // A connection that drops after the service took the request (a minute or more in) wastes
      // the work done: the second time, the request fails rather than run again and again.
      if (Date.now() - sent > 60_000 && ++dropped >= 2) {
        sink?.write({ type: 'finance.api_error', status: 0, error: netError });
        throw new InferenceFailed(`The connection to the local model dropped twice while it was answering (${netError}).`);
      }
    }
    if (status === 200 && json) return finish(json, req, started);
    const error = (json?.error ?? {}) as { code?: string; message?: string };
    if (status !== 0 && !RETRYABLE.has(status)) {
      sink?.write({ type: 'finance.api_error', status, code: error.code, error: (error.message ?? '').slice(0, 2000) });
      throw new InferenceFailed(`The local model refused the request (${status}${error.code ? ` ${error.code}` : ''}): ${(error.message ?? '').slice(0, 300)}`);
    }
    const reason = `${waitReason(status, error.code, error.message)}${netError ? ` (${netError})` : ''}`;
    const waitMs = Math.min(Math.max(retryAfterMs ?? 30_000, 1_000), 15 * 60_000);
    const until = retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : undefined;
    // Time spent waiting: the clock's, or the waits themselves when they took no time (a test's clock).
    if (Math.max(Date.now() - started, waited) + waitMs > waitUpTo) {
      sink?.write({ type: 'finance.unavailable', status, code: error.code, reason, attempts: attempt });
      throw new InferenceUnavailable(`The local model could not take this for ${Math.round((Date.now() - started) / 60_000)} minutes: ${reason}.`);
    }
    sink?.write({ type: 'finance.waiting', status, code: error.code, reason, retryInSeconds: Math.round(waitMs / 1000), ...(until ? { until } : {}) });
    req.onWait?.({ reason, ...(until ? { until } : {}) });
    await sleep(waitMs, signal);
    waited += waitMs;
  }
}

function finish(json: Record<string, unknown>, req: ChatRequest, started: number): ChatResult {
  const sink = req.transcript;
  const choice = ((json.choices as unknown[] | undefined)?.[0] ?? {}) as { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string };
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
  const reasoning = typeof choice.message?.reasoning_content === 'string' ? choice.message.reasoning_content : undefined;
  const full = (json.provenance ?? {}) as Record<string, unknown>;
  const provenance = provenanceOf(full, typeof json.system_fingerprint === 'string' ? json.system_fingerprint : undefined);
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const usage = { ...(typeof u.prompt_tokens === 'number' ? { promptTokens: u.prompt_tokens } : {}), ...(typeof u.completion_tokens === 'number' ? { completionTokens: u.completion_tokens } : {}) };
  const model = typeof json.model === 'string' ? json.model : provenance.modelId;
  sink?.write({ type: 'assistant', model, finish_reason: choice.finish_reason, ...(reasoning ? { reasoning } : {}), content: text });
  const result = (subtype: string, output?: unknown) =>
    sink?.write({ type: 'result', subtype, model, finish_reason: choice.finish_reason, usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens }, duration_ms: Date.now() - started, ...(output !== undefined ? { structured_output: output } : {}), provenance: full });
  if (choice.finish_reason === 'length') {
    result('max_tokens');
    throw new InferenceFailed('The local model ran out of room before it finished (its output was cut off).');
  }
  let output: unknown;
  if (req.schema) {
    if (full.schema_valid === false) {
      result('invalid_output');
      const errors = Array.isArray(full.schema_errors) ? (full.schema_errors as unknown[]).slice(0, 3).join('; ') : '';
      throw new InferenceFailed(`The local model's output did not match the schema${errors ? `: ${errors.slice(0, 400)}` : ''}.`);
    }
    try {
      output = JSON.parse(text);
    } catch {
      result('invalid_output');
      throw new InferenceFailed('The local model returned output that was not valid JSON.');
    }
  }
  result('success', output);
  return { text, ...(output !== undefined ? { output } : {}), ...(reasoning ? { reasoning } : {}), provenance, provenanceFull: full, usage, durationMs: Date.now() - started };
}

export interface InferenceHealth {
  status: string;
  aliases: Record<string, { state: string; queued?: number; in_flight?: number; model_id?: string; last_error?: string }>;
  gpu?: { resident?: string; home?: string; lease?: { state: string; until?: string } };
}

/** The service's /health, read with the key (each alias's state, and who holds the GPU); null when it does not answer. */
export async function inferenceHealth(cfg: InferenceConfig, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<InferenceHealth | null> {
  try {
    const res = await (opts.fetch ?? fetch)(`${cfg.baseUrl.replace(/\/v1$/, '')}/health`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: typeof json.status === 'string' ? json.status : 'unknown', aliases: (json.aliases ?? {}) as InferenceHealth['aliases'], ...(json.gpu ? { gpu: json.gpu } : {}) };
  } catch {
    return null;
  }
}

/** Alias states in which a request will be served, perhaps after a wait (the service's README §7). */
export const SERVING_STATES = new Set(['ready', 'cold', 'loading', 'leased']);
