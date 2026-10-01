// Extraction through the Anthropic Messages API (used when ANTHROPIC_API_KEY is set, or when chosen
// in Settings). Images and PDFs are sent as content blocks, a spreadsheet as text; the reply is
// constrained with structured outputs. Server-side refusal fallback is enabled so a policy decline is
// retried on the recommended fallback model instead of failing the import.

import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
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
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: opts.systemPrompt,
      output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content }],
    },
    { signal: opts.signal },
  );
  const message = await stream.finalMessage();
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
  const { extraction, warnings } = normaliseExtraction(json);
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
  return { extraction, warnings, model: message.model, costUsd, durationMs: Date.now() - started };
}
