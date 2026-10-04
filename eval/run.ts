// Run the evaluation set through the real import pipeline and score what comes out.
//
//   npm run eval                          every case, with the app's extraction settings
//   npm run eval -- --only pdf-amex-card,png-revolut-fx
//   npm run eval -- --tag fx              cases with a tag
//   npm run eval -- --render              write the documents to eval/.out/docs and stop
//   npm run eval -- --model sonnet --effort medium --concurrency 3 --label note
//   npm run eval -- --everything --only png-payslip-scan,pdf-p60,pdf-barclaycard,pdf-marcus-savings   the reader that reads everything (extract-14)
//   npm run eval -- --verify-model off    the first reading alone, without the second reading
//   npm run eval -- --engine inference    read on the local model service (check with it too)
//   npm run eval -- --engine inference --model chat-q8 --label q8   a bake-off alias (swaps the GPU)
//   npm run eval -- --engine claude-cli --model sonnet --verify-model opus   Claude (the default)
//
// Each case (or group) gets a temporary store holding the accounts in cases.ts, so account
// matching and duplicate detection are measured too. PDFs and screenshots go to the model Settings →
// Models gives reading documents, exactly as uploads do (--engine and --model choose another): on
// Claude that spends the Claude plan; on the local model service (INFERENCE_BASE_URL and
// INFERENCE_API_KEY in .env) it takes minutes a document on the shared GPU. Results are written to
// eval/results/ (small JSON, kept in git) with the prompt version, so runs can be compared.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { loadConfig, loadDotEnv, PROJECT_ROOT } from '../src/server/config';
import { ImportService } from '../src/server/ingest/service';
import { promptVersion } from '../src/server/ingest/prompt';
import { WorkArea } from '../src/server/ingest/workarea';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import type { ImportRecord, Settings } from '../src/shared/schema';
import { isInferenceAlias, type TaskEngine } from '../src/shared/tasks';
import { buildCases, EVAL_ACCOUNTS, type EvalCase } from './cases';
import { renderPdf, renderPng } from './render';
import { scoreCase, type CaseScore, type Tally } from './score';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = path.join(PROJECT_ROOT, 'eval', '.out');
const RESULTS = path.join(PROJECT_ROOT, 'eval', 'results');

async function renderAll(cases: EvalCase[]): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const needsBrowser = cases.some((c) => c.file.kind !== 'csv');
  const browser = needsBrowser ? await puppeteer.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] }) : null;
  try {
    for (const c of cases) {
      const bytes = c.file.kind === 'csv' ? Buffer.from(c.file.text!, 'utf8') : c.file.kind === 'pdf' ? await renderPdf(browser!, c.file.html!) : await renderPng(browser!, c.file.html!);
      files.set(c.id, bytes);
    }
  } finally {
    await browser?.close();
  }
  await mkdir(path.join(OUT, 'docs'), { recursive: true });
  for (const c of cases) await writeFile(path.join(OUT, 'docs', `${c.id}${path.extname(c.file.name).toLowerCase()}`), files.get(c.id)!);
  return files;
}

interface CaseResult {
  id: string;
  title: string;
  tags: string[];
  kind: string;
  status: string;
  engine?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  confidence?: string;
  warnings: string[];
  notes: string[];
  /** How the reading was checked (docs/INGESTION.md). */
  verification?: { method: string; firstModel: string; secondModel?: string; reasons: number; disagreements: string[]; kept: string };
  score: CaseScore;
}

interface RunOptions {
  engine?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  verifyModel?: string | undefined;
  thinking: boolean;
  everything: boolean;
}

/** The models Settings → Models would hold for this run: the app's defaults, with the flags over them. */
function modelSettings(opts: RunOptions): Settings['models'] {
  const engineOf = (m: string): TaskEngine => (isInferenceAlias(m) ? 'inference' : 'claude-cli');
  const engine = (opts.engine ?? (opts.model ? engineOf(opts.model) : undefined)) as TaskEngine | undefined;
  const read = { ...(engine ? { engine } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort as 'high' } : {}), ...(opts.thinking ? { thinking: true } : {}) };
  // The reading's engine checks too (the local model checks a local reading; never Claude unless
  // asked: a local run must not spend the Claude plan), unless --verify-model says otherwise.
  const check = opts.verifyModel === 'off' ? { engine: 'off' as const } : opts.verifyModel ? { engine: engineOf(opts.verifyModel), model: opts.verifyModel } : engine && engine !== 'ocr' ? { engine } : {};
  return { tasks: { 'read-document': read, 'check-reading': check } };
}

async function runGroup(cases: EvalCase[], files: Map<string, Buffer>, opts: RunOptions): Promise<CaseResult[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-eval-'));
  const store = await Store.open(path.join(dir, 'data'), { watch: false });
  const out: CaseResult[] = [];
  try {
    await store.setCategories(defaultCategories());
    for (const a of EVAL_ACCOUNTS) {
      if (!store.institution(a.institutionId)) await store.upsertInstitution({ id: a.institutionId, name: a.institutionId.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), kind: 'bank' });
    }
    const stamp = new Date().toISOString();
    await store.setAccounts(EVAL_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, type: a.type, institutionId: a.institutionId, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...(a.last4 ? { last4: a.last4 } : {}) })));
    await store.setSettings({
      ...store.settings,
      extraction: { ...store.settings.extraction, readEverything: opts.everything },
      models: modelSettings(opts),
      agents: { ...store.settings.agents, enabled: false },
    });
    const env = process.env;
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', ...(env.INFERENCE_BASE_URL && env.INFERENCE_API_KEY ? { INFERENCE_BASE_URL: env.INFERENCE_BASE_URL, INFERENCE_API_KEY: env.INFERENCE_API_KEY } : {}) });
    const svc = new ImportService(store, config, new WorkArea(path.join(dir, 'work')));
    await svc.init();
    const wait = async (id: string, started: number) => {
      let rec = svc.getPending(id);
      // The local model reads one document at a time, for minutes each: a group waits its turn.
      while (rec && (rec.status === 'queued' || rec.status === 'processing') && Date.now() - started < 12 * 3600_000) {
        await new Promise((r) => setTimeout(r, 1000));
        rec = svc.getPending(id);
      }
      return rec;
    };
    const result = (c: EvalCase, rec: ImportRecord | undefined, nothingNew: boolean): CaseResult => {
      const score = scoreCase(c.expected, rec?.status === 'review' ? rec.draft : undefined, { nothingNew }, { everything: opts.everything, printed: rec?.extraction.raw?.printed ?? [] });
      const v = rec?.extraction.verification;
      const how = !v ? '' : v.method === 'checks' ? '  [confirmed by its own figures]' : `  [read twice${v.disagreements.length ? `, ${v.disagreements.length} disagreement(s), kept ${v.kept}` : ', agreed'}]`;
      console.log(`${(score.score * 100).toFixed(1).padStart(6)}%  ${c.id}${how}${nothingNew ? '  [nothing new]' : ''}${rec?.status !== 'review' ? `  (${rec?.status}${rec?.extraction.error ? `: ${rec.extraction.error.slice(0, 120)}` : ''})` : ''}`);
      return {
        id: c.id,
        title: c.title,
        tags: c.tags,
        kind: c.file.kind,
        status: rec?.status ?? 'missing',
        ...(rec?.extraction.engine ? { engine: rec.extraction.engine } : {}),
        ...(rec?.extraction.model ? { model: rec.extraction.model } : {}),
        ...(rec?.extraction.durationMs !== undefined ? { durationMs: rec.extraction.durationMs } : {}),
        ...(rec?.extraction.costUsd !== undefined ? { costUsd: rec.extraction.costUsd } : {}),
        ...(rec?.draft?.confidence ? { confidence: rec.draft.confidence } : {}),
        warnings: [...(rec?.extraction.warnings ?? []), ...(rec?.extraction.error ? [`error: ${rec.extraction.error}`] : [])],
        notes: rec?.draft?.notes ?? [],
        ...(v ? { verification: { method: v.method, firstModel: v.firstModel, ...(v.secondModel ? { secondModel: v.secondModel } : {}), reasons: v.reasons.length, disagreements: v.disagreements, kept: v.kept } } : {}),
        score,
      };
    };
    if (cases[0]?.together) {
      // Uploaded together, as from a phone: read side by side, judged together, none committed.
      const started = Date.now();
      const ids: string[] = [];
      for (const c of cases) ids.push((await svc.create({ fileName: c.file.name, bytes: files.get(c.id)!, origin: 'upload', hintAccountId: c.hintAccountId })).record!.id);
      const recs: (ImportRecord | undefined)[] = [];
      for (const id of ids) recs.push(await wait(id, started));
      const nothingNew = svc.novelty();
      cases.forEach((c, i) => out.push(result(c, svc.getPending(ids[i]!) ?? recs[i], nothingNew.has(ids[i]!))));
      return out;
    }
    for (const [n, c] of cases.entries()) {
      const { record } = await svc.create({ fileName: c.file.name, bytes: files.get(c.id)!, origin: 'upload', hintAccountId: c.hintAccountId });
      const rec = await wait(record!.id, Date.now());
      out.push(result(c, rec, svc.novelty().has(record!.id)));
      // Later cases in a group see this one as already imported.
      if (n < cases.length - 1 && rec?.status === 'review') await svc.commit(rec.id);
    }
  } finally {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  // The local model service's address and key (INFERENCE_*), as the app reads them.
  loadDotEnv();
  const only = arg('only')?.split(',');
  const tag = arg('tag');
  let cases = buildCases();
  if (only || tag) {
    const wanted = cases.filter((c) => only?.includes(c.id) || (tag && c.tags.includes(tag)));
    // A later case in a group needs the earlier ones in its store.
    const groups = new Set(wanted.map((c) => c.group).filter(Boolean));
    cases = cases.filter((c) => wanted.includes(c) || (c.group && groups.has(c.group) && cases.indexOf(c) < Math.max(...wanted.filter((w) => w.group === c.group).map((w) => cases.indexOf(w)))));
  }
  console.log(`Rendering ${cases.length} documents…`);
  const files = await renderAll(cases);
  if (argv.includes('--render')) {
    console.log(`Documents in ${path.join(OUT, 'docs')}`);
    return;
  }
  const groups: EvalCase[][] = [];
  for (const c of cases) {
    const g = c.group ? groups.find((x) => x[0]!.group === c.group) : undefined;
    if (g) g.push(c);
    else groups.push([c]);
  }
  const concurrency = Number(arg('concurrency') ?? 3);
  // --everything: the reader that keeps everything a document prints (extract-14).
  const opts: RunOptions = { engine: arg('engine'), model: arg('model'), effort: arg('effort'), verifyModel: arg('verify-model'), thinking: argv.includes('--thinking'), everything: argv.includes('--everything') };
  const results: CaseResult[] = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < groups.length) {
        const g = groups[next++]!;
        results.push(...(await runGroup(g, files, opts)));
      }
    }),
  );
  results.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));

  // Totals: overall, by field, by kind of document and by tag.
  const add = (into: Record<string, Tally>, from: Record<string, Tally>) => {
    for (const [k, t] of Object.entries(from)) {
      const x = (into[k] ??= { correct: 0, total: 0 });
      x.correct += t.correct;
      x.total += t.total;
    }
  };
  const byField: Record<string, Tally> = {};
  for (const r of results) add(byField, r.score.fields);
  const pct = (t: Tally) => (t.total ? (t.correct / t.total) * 100 : 100);
  const overall = Object.values(byField).reduce((s, t) => ({ correct: s.correct + t.correct, total: s.total + t.total }), { correct: 0, total: 0 });
  const group = (key: (r: CaseResult) => string[]) => {
    const m: Record<string, Tally> = {};
    for (const r of results) for (const k of key(r)) {
      const x = (m[k] ??= { correct: 0, total: 0 });
      for (const t of Object.values(r.score.fields)) {
        x.correct += t.correct;
        x.total += t.total;
      }
    }
    return Object.fromEntries(Object.entries(m).map(([k, t]) => [k, Math.round(pct(t) * 10) / 10]));
  };
  const summary = {
    ranAt: new Date().toISOString(),
    promptVersion: promptVersion(opts.everything),
    label: arg('label') ?? null,
    engine: opts.engine ?? 'app default',
    model: opts.model ?? 'app default',
    effort: opts.effort ?? 'app default',
    verifyModel: opts.verifyModel ?? 'app default',
    readTwice: results.filter((r) => r.verification?.method === 'second-reading').length,
    confirmedByFigures: results.filter((r) => r.verification?.method === 'checks').length,
    withDisagreements: results.filter((r) => r.verification?.disagreements.length).length,
    cases: results.length,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
    costUsd: Math.round(results.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100,
    fieldAccuracy: Math.round(pct(overall) * 10) / 10,
    rows: results.reduce((s, r) => ({ expected: s.expected + r.score.rows.expected, found: s.found + r.score.rows.found, extra: s.extra + r.score.rows.extra }), { expected: 0, found: 0, extra: 0 }),
    byField: Object.fromEntries(Object.entries(byField).map(([k, t]) => [k, { ...t, pct: Math.round(pct(t) * 10) / 10 }])),
    byKind: group((r) => [r.kind]),
    byTag: group((r) => r.tags),
  };
  console.log(`\nField accuracy ${summary.fieldAccuracy}% over ${results.length} documents (${summary.rows.found}/${summary.rows.expected} rows found, ${summary.rows.extra} extra), ${summary.minutes} min, $${summary.costUsd}`);
  console.log(`Checking: ${summary.confirmedByFigures} confirmed by their own figures, ${summary.readTwice} read twice (${summary.withDisagreements} with disagreements)`);
  console.log(`By field: ${Object.entries(summary.byField).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}`);
  console.log(`By kind:  ${Object.entries(summary.byKind).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
  console.log(`By tag:   ${Object.entries(summary.byTag).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
  for (const r of results.filter((x) => x.score.errors.length)) {
    console.log(`\n${r.id} (${(r.score.score * 100).toFixed(1)}%):`);
    for (const e of r.score.errors.slice(0, 8)) console.log(`  - ${e}`);
  }
  if (!existsSync(RESULTS)) await mkdir(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${summary.ranAt.slice(0, 16).replace(/[:T]/g, '-')}_${summary.promptVersion}${summary.label ? `_${summary.label}` : ''}.json`);
  // The summary readable, then one line per case: small, and diffs between runs stay legible.
  await writeFile(file, `{"summary": ${JSON.stringify(summary, null, 1)},\n"results": [\n${results.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`);
  console.log(`\nResults in ${path.relative(PROJECT_ROOT, file)}`);
}

await main();
