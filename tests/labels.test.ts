// Names for imports (the `label-imports` job), without calling Claude: what the job is told, how its
// answer is kept, your own names, History's search and button, and the switch that keeps it all off.
// A run end to end goes through a stand-in `claude`, the only one this file can find.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportHistoryResponse } from '../src/shared/api';
import { JobRunner, type JobRecord } from '../src/server/agents/jobs';
import { cleanLabel, importsToLabel, JOB_DEFS, NothingToDo, type JobContext } from '../src/server/agents/kinds';
import { createApp, type App } from '../src/server/app';
import { CLAUDE_TASKS } from './claude-tasks';
import { loadConfig } from '../src/server/config';
import { requiredScope } from '../src/server/tokens';

const CSRF = { 'x-finance-csrf': '1' };
const json = { ...CSRF, 'content-type': 'application/json' };
const provenance = { setBy: 'agent' as const, model: 'claude-test', promptVersion: 'label-imports-2', jobId: 'job_test' };

/** The stand-in: names each import it is shown after its file, and logs each call. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ prompt }) + '\\n');
const labels = prompt.split('\\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((f) => ({ ref: f.ref, label: 'Stand-in name for ' + f.fileName }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { labels }, total_cost_usd: 0.001, num_turns: 1, duration_ms: 5, modelUsage: { 'claude-stand-in': {} } }));
`;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let app: App;
let dir: string;
let binDir: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, bin: process.env.FINANCE_CLAUDE_BIN, log: process.env.FAKE_CLAUDE_LOG };
const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
const ctx = (params: Record<string, unknown>): JobContext => ({ store: app.ctx.store, analytics: app.ctx.analytics, params, scratch: dir });
const history = async (q = '') => (await (await req(`/api/imports/history${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json()) as ImportHistoryResponse;
const setLabelling = (on: boolean) => app.ctx.store.setSettings({ ...app.ctx.store.settings, agents: { ...app.ctx.store.settings.agents, enabled: false, labelImports: on } });
const startNaming = () => req('/api/jobs', { method: 'POST', headers: json, body: JSON.stringify({ kind: 'label-imports' }) });
/** The imports a run showed, in ref order (what `prepare` left in the scratch directory). */
const shown = async () => JSON.parse(await readFile(path.join(dir, 'imports.json'), 'utf8')) as string[];

async function importCsv(name: string, body: string | Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([body]), name);
  const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
  const id = results[0]!.id;
  await waitFor(async () => (((await (await req(`/api/imports/${id}`)).json()) as { status: string }).status === 'review' ? true : undefined));
  expect((await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
  return id;
}
const csv = (date: string, amount: string, balance: string) => `Date,Description,Amount,Balance\n${date},SHOP,${amount},${balance}\n`;

beforeAll(async () => {
  // Only the stand-in can be found: no real claude on the PATH or in the home directory.
  binDir = await mkdtemp(path.join(os.tmpdir(), 'finance-fake-claude-'));
  await mkdir(path.join(binDir, 'home'));
  const bin = path.join(binDir, 'claude');
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  process.env.PATH = path.dirname(process.execPath);
  process.env.HOME = path.join(binDir, 'home');
  process.env.FINANCE_CLAUDE_BIN = bin;
});
afterAll(async () => {
  await rm(binDir, { recursive: true, force: true, maxRetries: 5 });
  for (const [k, v] of Object.entries({ HOME: saved.HOME, PATH: saved.PATH, FINANCE_CLAUDE_BIN: saved.bin, FAKE_CLAUDE_LOG: saved.log })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-labels-'));
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'claude.log');
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(dir, 'no-web');
  // The app's own runner queues without running: the run end to end below has a runner of its own.
  app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
  await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: CLAUDE_TASKS });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('naming imports', () => {
  it('is off until you turn it on, for you and agents alike; it does not need agents on', async () => {
    const runner = app.ctx.runner!;
    expect(app.ctx.store.settings.agents.labelImports).toBe(false);
    expect(runner.enqueue({ kind: 'label-imports', trigger: 'owner' })).toBeUndefined();
    const refused = await startNaming();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Naming imports with the agent is off/);
    await setLabelling(true);
    expect(app.ctx.store.settings.agents.enabled).toBe(false);
    const job = runner.enqueue({ kind: 'label-imports', trigger: 'owner' });
    expect(job).toMatchObject({ kind: 'label-imports', privacy: 'personal', promptVersion: 'label-imports-2', status: 'queued' });
  });

  it('tells the job what each document is, by a ref, never its amounts, numbers or rows', async () => {
    const id = await importCsv('starling.csv', await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv')));
    expect(importsToLabel(app.ctx.store, {})).toEqual([id]);
    const prompt = await JOB_DEFS['label-imports'].prepare(ctx({}));
    expect(prompt).toContain('{"ref":1,"fileName":"starling.csv"');
    expect(prompt).not.toContain(id);
    expect(await shown()).toEqual([id]);
    expect(prompt).toMatch(/"from":"2026-09-0\d"/);
    for (const secret of ['2927.66', '2,927.66', '987.66', '12.34', 'TESCO', 'LONDON']) expect(prompt).not.toContain(secret);
    expect(JOB_DEFS['label-imports'].tools).toEqual([]);
  });

  it('keeps Claude’s names for the imports it was shown, never over a name, yours or its own', async () => {
    const a = await importCsv('a.csv', csv('01/09/2026', '-1.00', '99.00'));
    const b = await importCsv('b.csv', csv('02/10/2026', '-2.00', '97.00'));
    expect((await history()).unnamed).toBe(2);

    // Yours first: it is not shown, and a name for it is not kept.
    expect((await req(`/api/imports/${b}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: '  October   shop  ' }) })).status).toBe(200);
    expect(importsToLabel(app.ctx.store, {})).toEqual([a]);
    expect(importsToLabel(app.ctx.store, { importIds: [a, b] })).toEqual([a]);
    await JOB_DEFS['label-imports'].prepare(ctx({}));
    expect(await shown()).toEqual([a]);

    // A ref it was not given, and the same ref twice, are not kept.
    const out = { labels: [{ ref: 1, label: '“Example Bank current account statement, Sep 2026”' }, { ref: 2, label: 'Something else' }, { ref: 1, label: 'Twice' }] };
    const outcome = await JOB_DEFS['label-imports'].apply(ctx({}), out, provenance);
    expect(outcome.summary).toBe('Named 1 import; 2 names not kept');
    expect((await app.ctx.store.readImport(a))!.label).toMatchObject({ text: 'Example Bank current account statement, Sep 2026', provenance });
    expect((await app.ctx.store.readImport(b))!.label).toMatchObject({ text: 'October shop', provenance: { setBy: 'owner' } });
    // Named once is named: neither a run of all nor one asked about it names it again.
    expect(importsToLabel(app.ctx.store, {})).toEqual([]);
    expect(importsToLabel(app.ctx.store, { importIds: [a] })).toEqual([]);
    await expect(JOB_DEFS['label-imports'].prepare(ctx({ importIds: [a] }))).rejects.toBeInstanceOf(NothingToDo);

    const h = await history();
    expect(h.unnamed).toBe(0);
    // Both were committed within the same second here, which History's order leaves to their ids.
    const items = [...h.items].sort((x, y) => y.fileName.localeCompare(x.fileName));
    expect(items.map((i) => i.label)).toEqual([
      { text: 'October shop', setBy: 'owner' },
      { text: 'Example Bank current account statement, Sep 2026', setBy: 'agent' },
    ]);
    // The file name stays as it was, and either finds it.
    expect(items.map((i) => i.fileName)).toEqual(['b.csv', 'a.csv']);
    expect((await history('statement sep')).items.map((i) => i.id)).toEqual([a]);
    expect((await history('a.csv')).items.map((i) => i.id)).toEqual([a]);
    expect((await history('nothing like it')).total).toBe(0);

    // Taking your name away lets Claude name it.
    expect((await req(`/api/imports/${b}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: null }) })).status).toBe(200);
    expect((await app.ctx.store.readImport(b))!.label).toBeUndefined();
    expect(importsToLabel(app.ctx.store, {})).toEqual([b]);
  });

  it('keeps names only for the imports it showed, whatever is committed or named meanwhile', async () => {
    const a = await importCsv('a.csv', csv('01/09/2026', '-1.00', '99.00'));
    const b = await importCsv('b.csv', csv('02/10/2026', '-2.00', '97.00'));
    await JOB_DEFS['label-imports'].prepare(ctx({}));
    const refs = await shown();
    expect([...refs].sort()).toEqual([a, b].sort());
    // While Claude is at it: an import is committed, which is now the newest without a name, and
    // you name one of those it was shown.
    const c = await importCsv('c.csv', csv('03/11/2026', '-3.00', '94.00'));
    expect((await req(`/api/imports/${refs[1]}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: 'Mine' }) })).status).toBe(200);
    const outcome = await JOB_DEFS['label-imports'].apply(ctx({}), { labels: [{ ref: 1, label: 'First shown' }, { ref: 2, label: 'Second shown' }] }, provenance);
    expect(outcome.summary).toBe('Named 1 import; 1 name not kept');
    expect((await app.ctx.store.readImport(refs[0]!))!.label?.text).toBe('First shown');
    expect((await app.ctx.store.readImport(refs[1]!))!.label?.text).toBe('Mine');
    expect((await app.ctx.store.readImport(c))!.label).toBeUndefined();
  });

  it('only you name an import, and only a committed one', async () => {
    expect(requiredScope('PUT', '/api/imports/imp_20260901_120000_abcd/label')).toBeNull();
    expect((await req('/api/imports/imp_20260901_120000_abcd/label', { method: 'PUT', headers: json, body: JSON.stringify({ text: 'x' }) })).status).toBe(404);
    const a = await importCsv('a.csv', csv('01/09/2026', '-1.00', '99.00'));
    expect((await req(`/api/imports/${a}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: ' ' }) })).status).toBe(400);
  });

  it('cleans a name to one line, without wrapping quotes', () => {
    expect(cleanLabel(' "Monzo\n statement,  Sep 2026" ')).toBe('Monzo statement, Sep 2026');
    expect(cleanLabel('ab')).toBeUndefined();
    expect(cleanLabel('x'.repeat(121))).toBeUndefined();
  });
});

describe('History’s naming button', () => {
  it('pressed twice at once starts one run, and says so until it ends', async () => {
    await setLabelling(true);
    await importCsv('a.csv', csv('01/09/2026', '-1.00', '99.00'));
    const answers = await Promise.all([startNaming(), startNaming()]);
    const bodies = (await Promise.all(answers.map((r) => r.json()))) as (JobRecord & { existing?: true })[];
    expect(answers.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(bodies[0]!.id).toBe(bodies[1]!.id);
    // Only the second press is told it found a run already going: the page shows no second toast.
    expect(bodies.filter((b) => b.existing).length).toBe(1);
    expect(app.ctx.runner!.list().filter((j) => j.kind === 'label-imports')).toHaveLength(1);
    expect((await history()).naming).toBe('queued');

    // Once it ends, the button offers a new run.
    await app.ctx.runner!.cancel(bodies[0]!.id);
    expect((await history()).naming).toBeUndefined();
    const again = await startNaming();
    expect(again.status).toBe(201);
    expect(((await again.json()) as JobRecord).id).not.toBe(bodies[0]!.id);
  });
});

describe('a run end to end, through the stand-in', () => {
  it('names what it was shown; asked again, it has nothing to do and does not call Claude', async () => {
    await setLabelling(true);
    const a = await importCsv('a.csv', csv('01/09/2026', '-1.00', '99.00'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work2'), FINANCE_WATCH: '0' });
    const runner = new JobRunner(app.ctx.store, app.ctx.analytics, config, { autoRun: false });
    await runner.init();
    const ended = (id: string) => waitFor(() => Promise.resolve(['succeeded', 'failed', 'cancelled'].includes(runner.get(id)!.status) ? runner.get(id)! : undefined));
    const calls = async () => (await readFile(process.env.FAKE_CLAUDE_LOG!, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    try {
      const first = await ended(runner.enqueue({ kind: 'label-imports', trigger: 'owner' })!.id);
      expect(first).toMatchObject({ status: 'succeeded', summary: 'Named 1 import', costUsd: 0.001 });
      expect((await app.ctx.store.readImport(a))!.label).toMatchObject({ text: 'Stand-in name for a.csv', provenance: { setBy: 'agent', promptVersion: 'label-imports-2', jobId: first.id } });
      expect(await calls()).toHaveLength(1);
      expect((await calls())[0]).not.toContain('99.00');

      // A run queued for it after a commit, once another has named it: done, with nothing spent.
      const late = await ended(runner.enqueue({ kind: 'label-imports', params: { importIds: [a] }, trigger: 'post-import' })!.id);
      expect(late).toMatchObject({ status: 'succeeded', summary: 'Nothing to name: every import it was asked about has a name' });
      expect(late.costUsd).toBeUndefined();
      expect(await calls()).toHaveLength(1);
      expect((await app.ctx.store.readImport(a))!.label!.provenance.jobId).toBe(first.id);
    } finally {
      runner.stop();
    }
  });
});

describe('naming after a commit', () => {
  it('waits for imports to stop arriving, then queues one job for them; never with naming off', async () => {
    vi.useFakeTimers();
    try {
      await setLabelling(false);
      const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work2'), FINANCE_WATCH: '0' });
      const runner = new JobRunner(app.ctx.store, app.ctx.analytics, config, { autoRun: true, paused: true });
      await runner.init();
      runner.onImportFiled('imp_20260901_120000_aaaa');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(runner.list()).toEqual([]);

      await setLabelling(true);
      runner.onImportFiled('imp_20260901_120000_aaaa');
      await vi.advanceTimersByTimeAsync(30_000);
      runner.onImportFiled('imp_20260901_120000_bbbb');
      runner.onImportFiled('imp_20260901_120000_bbbb');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runner.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(runner.list().map((j) => [j.kind, j.trigger, j.params])).toEqual([['label-imports', 'post-import', { importIds: ['imp_20260901_120000_aaaa', 'imp_20260901_120000_bbbb'] }]]);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
