// Names for imports (the `label-imports` job), without calling Claude: what the job is told, how its
// answer is kept, your own names, History's search, and the switch that keeps it all off.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportHistoryResponse } from '../src/shared/api';
import { JobRunner } from '../src/server/agents/jobs';
import { cleanLabel, importsToLabel, JOB_DEFS, type JobContext } from '../src/server/agents/kinds';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { requiredScope } from '../src/server/tokens';

const CSRF = { 'x-finance-csrf': '1' };
const json = { ...CSRF, 'content-type': 'application/json' };
const provenance = { setBy: 'agent' as const, model: 'claude-test', promptVersion: 'label-imports-1', jobId: 'job_test' };

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
const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
const ctx = (params: Record<string, unknown>): JobContext => ({ store: app.ctx.store, analytics: app.ctx.analytics, params, scratch: dir });
const history = async (q = '') => (await (await req(`/api/imports/history${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json()) as ImportHistoryResponse;
const setLabelling = (on: boolean) => app.ctx.store.setSettings({ ...app.ctx.store.settings, agents: { ...app.ctx.store.settings.agents, enabled: false, labelImports: on } });

async function importCsv(name: string, body: string | Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([body]), name);
  const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
  const id = results[0]!.id;
  await waitFor(async () => (((await (await req(`/api/imports/${id}`)).json()) as { status: string }).status === 'review' ? true : undefined));
  expect((await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
  return id;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-labels-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(dir, 'no-web');
  app = await createApp(config, { version: 'test', env: {}, inbox: false });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('naming imports', () => {
  it('is off until you turn it on, for you and agents alike; it does not need agents on', async () => {
    const runner = app.ctx.runner!;
    expect(app.ctx.store.settings.agents.labelImports).toBe(false);
    expect(runner.enqueue({ kind: 'label-imports', trigger: 'owner' })).toBeUndefined();
    const refused = await req('/api/jobs', { method: 'POST', headers: json, body: JSON.stringify({ kind: 'label-imports' }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Naming imports with Claude is off/);
    await setLabelling(true);
    expect(app.ctx.store.settings.agents.enabled).toBe(false);
    // Queued, not run: a test never calls Claude (the server is not watching, so nothing starts by itself).
    const job = runner.enqueue({ kind: 'label-imports', trigger: 'owner' });
    expect(job).toMatchObject({ kind: 'label-imports', privacy: 'personal', promptVersion: 'label-imports-1' });
    await runner.cancel(job!.id);
  });

  it('tells the job what each document is, never its amounts, numbers or rows', async () => {
    const id = await importCsv('starling.csv', await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv')));
    expect(importsToLabel(app.ctx.store, {})).toEqual([id]);
    const prompt = await JOB_DEFS['label-imports'].prepare(ctx({}));
    expect(prompt).toContain(id);
    expect(prompt).toContain('starling.csv');
    expect(prompt).toMatch(/"from":"2026-09-0\d"/);
    for (const secret of ['2927.66', '2,927.66', '987.66', '12.34', 'TESCO', 'LONDON']) expect(prompt).not.toContain(secret);
    expect(JOB_DEFS['label-imports'].tools).toEqual([]);
  });

  it('keeps Claude’s names, never over yours, and only for the imports it was asked about', async () => {
    const a = await importCsv('a.csv', 'Date,Description,Amount,Balance\n01/09/2026,SHOP,-1.00,99.00\n');
    const b = await importCsv('b.csv', 'Date,Description,Amount,Balance\n02/10/2026,SHOP,-2.00,97.00\n');
    expect((await history()).unnamed).toBe(2);

    // Yours first: Claude's answer for it is not kept.
    expect((await req(`/api/imports/${b}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: '  October   shop  ' }) })).status).toBe(200);
    expect(importsToLabel(app.ctx.store, {})).toEqual([a]);
    expect(importsToLabel(app.ctx.store, { importIds: [a, b] })).toEqual([a]);

    const out = { labels: [{ importId: a, label: '“Example Bank current account statement, Sep 2026”' }, { importId: b, label: 'Something else' }, { importId: 'imp_20260101_000000_ffff', label: 'Made up' }] };
    const outcome = await JOB_DEFS['label-imports'].apply(ctx({}), out, provenance);
    expect(outcome.summary).toBe('Named 1 import; 2 names not kept');
    const rec = await app.ctx.store.readImport(a);
    expect(rec!.label).toMatchObject({ text: 'Example Bank current account statement, Sep 2026', provenance });
    expect((await app.ctx.store.readImport(b))!.label).toMatchObject({ text: 'October shop', provenance: { setBy: 'owner' } });

    const h = await history();
    expect(h.unnamed).toBe(0);
    expect(h.items.map((i) => i.label)).toEqual([
      { text: 'October shop', setBy: 'owner' },
      { text: 'Example Bank current account statement, Sep 2026', setBy: 'agent' },
    ]);
    // The file name stays as it was, and either finds it.
    expect(h.items.map((i) => i.fileName)).toEqual(['b.csv', 'a.csv']);
    expect((await history('statement sep')).items.map((i) => i.id)).toEqual([a]);
    expect((await history('a.csv')).items.map((i) => i.id)).toEqual([a]);
    expect((await history('nothing like it')).total).toBe(0);

    // Taking your name away lets Claude name it.
    expect((await req(`/api/imports/${b}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: null }) })).status).toBe(200);
    expect((await app.ctx.store.readImport(b))!.label).toBeUndefined();
    expect(importsToLabel(app.ctx.store, {})).toEqual([b]);
  });

  it('only you name an import, and only a committed one', async () => {
    expect(requiredScope('PUT', '/api/imports/imp_20260901_120000_abcd/label')).toBeNull();
    expect((await req('/api/imports/imp_20260901_120000_abcd/label', { method: 'PUT', headers: json, body: JSON.stringify({ text: 'x' }) })).status).toBe(404);
    const a = await importCsv('a.csv', 'Date,Description,Amount,Balance\n01/09/2026,SHOP,-1.00,99.00\n');
    expect((await req(`/api/imports/${a}/label`, { method: 'PUT', headers: json, body: JSON.stringify({ text: ' ' }) })).status).toBe(400);
  });

  it('cleans a name to one line, without wrapping quotes', () => {
    expect(cleanLabel(' "Monzo\n statement,  Sep 2026" ')).toBe('Monzo statement, Sep 2026');
    expect(cleanLabel('ab')).toBeUndefined();
    expect(cleanLabel('x'.repeat(121))).toBeUndefined();
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
