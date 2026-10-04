// Extraction through the Anthropic Messages API (used when ANTHROPIC_API_KEY is set, or when chosen
// in Settings). Images and PDFs are sent as content blocks, a spreadsheet as text; the reply is
// constrained with structured outputs. Server-side refusal fallback is enabled so a policy decline is
// retried on the recommended fallback model instead of failing the import.
//
// The session's transcript (sessions.ts) gets the request as sent (a file's bytes left out), each
// content block as it completes, the final message, and its usage and cost.

import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { TranscriptSink } from '../sessions';
import { normaliseExtraction } from './normalise';
import type { EngineResult } from './engines';

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

export function apiModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export interface ApiOptions {
  apiKey: string;
  files: { path: string; mediaType: string }[];
  userPrompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Tests only: stands in for the network. */
  fetch?: typeof fetch;
  /** Where the session's events go as they arrive. */
  transcript?: TranscriptSink | undefined;
}

export async function extractWithClaudeApi(opts: ApiOptions): Promise<EngineResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const content: BetaContentBlockParam[] = [];
  for (const f of opts.files) {
    if (f.mediaType === 'text/plain') {
      // A spreadsheet, as text (ingest/xlsx.ts, `workbookText`).
      content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: (await readFile(f.path)).toString('utf8') } });
      continue;
    }
    const data = (await readFile(f.path)).toString('base64');
    if (f.mediaType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    } else {
      const mediaType = (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.mediaType) ? f.mediaType : 'image/png') as
        | 'image/png'
        | 'image/jpeg'
        | 'image/gif'
        | 'image/webp';
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
  }
  content.push({ type: 'text', text: opts.userPrompt });

  const model = apiModelId(opts.model);
  const started = Date.now();
  const params = {
    model,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    system: opts.systemPrompt,
    output_config: { effort: opts.effort, format: { type: 'json_schema' as const, schema: opts.schema } },
    messages: [{ role: 'user' as const, content }],
  };
  const sink = opts.transcript;
  // The request as sent; the transcript leaves a file's base64 out (sessions.ts).
  sink?.write({ type: 'finance.request', engine: 'claude-api', model: opts.model, effort: opts.effort, tools: [], systemPrompt: opts.systemPrompt, prompt: opts.userPrompt, schema: opts.schema, files: opts.files.map((f) => ({ name: f.path.split('/').pop(), mediaType: f.mediaType })), request: params });
  const stream = client.beta.messages.stream(params, { signal: opts.signal });
  if (sink) {
    stream.on('streamEvent', (e) => {
      if (e.type === 'message_start') sink.write({ type: 'system', subtype: 'init', model: e.message.model, id: e.message.id });
    });
    stream.on('contentBlock', (block) => sink.write({ type: 'finance.content_block', block }));
  }
  let message: Awaited<ReturnType<typeof stream.finalMessage>>;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    sink?.write({ type: 'finance.api_error', error: (err as Error).message.slice(0, 2000) });
    throw err;
  }
  sink?.write({ type: 'assistant', message });
  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') sink?.write({ type: 'result', subtype: message.stop_reason, model: message.model, stop_reason: message.stop_reason, usage: message.usage });
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined to process this document${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The document produced more output than one request allows. Split it into smaller files and import them separately.');
  }
  const text = message.content
    .filter((b): b is Extract<(typeof message.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Claude returned output that was not valid JSON.');
  }
  const { extraction, warnings, notices } = normaliseExtraction(json);
  const usage = message.usage;
  // List prices per million tokens, for a rough cost record only.
  const price: Record<string, [number, number]> = {
    'claude-opus-5-5': [4, 20],
    'claude-sonnet-5-5': [2, 10],
    'claude-haiku-4-5': [1, 5],
    'claude-fable-5-1': [10, 50],
  };
  const [pin, pout] = price[message.model] ?? price[model] ?? [0, 0];
  const costUsd = ((usage.input_tokens ?? 0) * pin + (usage.output_tokens ?? 0) * pout) / 1_000_000;
  sink?.write({ type: 'result', subtype: 'success', model: message.model, stop_reason: message.stop_reason, usage, total_cost_usd: costUsd, duration_ms: Date.now() - started, num_turns: 1 });
  return { extraction, warnings, ...(notices.length ? { notices } : {}), model: message.model, costUsd, durationMs: Date.now() - started };
}
