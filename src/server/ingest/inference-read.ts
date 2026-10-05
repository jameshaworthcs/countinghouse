// Reading a document with the local model service (`vision-extract`; its README §9, "finance:
// statement extraction"). The contract is the one Claude gets: the same system prompt, user prompt
// and JSON Schema. What differs is how the document goes in: the service takes images only, so a
// PDF is rendered page by page at 150 dpi (as good as 200 dpi in its tests, and 28% faster), a
// screenshot goes as prepareImage's tiles, and a spreadsheet as its text.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chat, type ChatRequest, type ContentPart, type InferenceConfig } from '../inference';
import type { Priority } from '../../shared/tasks';
import type { TranscriptSink } from '../sessions';
import { runProcess } from './claude-cli';
import type { EngineResult } from './engines';
import { normaliseExtraction } from './normalise';

/** A PDF longer than this is more than one request holds well (about 2.1k image tokens a page). */
export const MAX_PDF_PAGES = 40;
const DPI = 150;

/** Render each page of a PDF as a PNG in `dir`, in page order. */
export async function renderPdfPages(pdf: string, dir: string, opts: { run?: typeof runProcess } = {}): Promise<string[]> {
  const prefix = path.join(dir, 'page');
  const r = await (opts.run ?? runProcess)('pdftoppm', ['-r', String(DPI), '-png', '-l', String(MAX_PDF_PAGES + 1), pdf, prefix], { cwd: dir, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`Could not render the PDF's pages for the local model: ${r.stderr.trim().slice(0, 300) || `pdftoppm exited ${r.code}`}`);
  const pages = (await readdir(dir))
    .filter((f) => /^page-\d+\.png$/.test(f))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((f) => path.join(dir, f));
  if (!pages.length) throw new Error('The PDF has no pages the local model could be shown.');
  if (pages.length > MAX_PDF_PAGES) throw new Error(`The PDF has more than ${MAX_PDF_PAGES} pages, more than the local model reads well in one go: split it, or read it with Claude.`);
  return pages;
}

export interface InferenceReadOptions {
  cfg: InferenceConfig | undefined;
  files: { path: string; mediaType: string }[];
  /** Where PDF pages are rendered (the reading's scratch directory). */
  scratch: string;
  userPrompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  alias: string;
  thinking: boolean;
  priority: Priority;
  runMinutes: number;
  maxTokens: number;
  signal?: AbortSignal | undefined;
  transcript?: TranscriptSink | undefined;
  onWait?: ChatRequest['onWait'];
  /** Tests only. */
  fetch?: typeof fetch;
  run?: typeof runProcess;
}

export async function extractWithInference(opts: InferenceReadOptions): Promise<EngineResult> {
  const content: ContentPart[] = [];
  for (const f of opts.files) {
    if (f.mediaType === 'text/plain') {
      content.push({ type: 'text', text: (await readFile(f.path)).toString('utf8') });
    } else if (f.mediaType === 'application/pdf') {
      const pages = await renderPdfPages(f.path, opts.scratch, opts.run ? { run: opts.run } : {});
      // Each page names its page of the stored document (the session belongs to its import).
      for (const [i, page] of pages.entries()) content.push({ type: 'image', mediaType: 'image/png', data: await readFile(page), name: path.basename(page), source: { page: i + 1 } });
    } else {
      content.push({ type: 'image', mediaType: f.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png', data: await readFile(f.path), name: path.basename(f.path) });
    }
  }
  content.push({ type: 'text', text: opts.userPrompt });
  const res = await chat(opts.cfg, {
    alias: opts.alias,
    system: opts.systemPrompt,
    content,
    schema: { name: 'extraction', schema: opts.schema },
    thinking: opts.thinking,
    maxTokens: opts.maxTokens,
    priority: opts.priority,
    runMinutes: opts.runMinutes,
    signal: opts.signal,
    transcript: opts.transcript,
    onWait: opts.onWait,
    describe: { model: opts.alias, systemPrompt: opts.systemPrompt, prompt: opts.userPrompt, schema: opts.schema },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const { extraction, warnings, notices } = normaliseExtraction(res.output);
  return { extraction, warnings, ...(notices.length ? { notices } : {}), model: res.provenance.modelId ?? opts.alias, durationMs: res.durationMs, engine: 'inference', inference: res.provenance };
}
