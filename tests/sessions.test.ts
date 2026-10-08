// Claude sessions (src/server/sessions.ts, sessionviews.ts): each run of Claude is recorded with
// its transcript, beside its import, job or receipt in the work area; what it produced and its audit
// rows are linked both ways; earlier sessions say they have no transcript; agents with tokens are
// seen by their requests. The reader here is a stand-in `claude` that streams events like the real
// CLI: no Claude is run. All data is invented.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { CLAUDE_TASKS } from './claude-tasks';
import { loadConfig } from '../src/server/config';
import { extractWithClaudeApi } from '../src/server/ingest/claude-api';
import { AuditLog } from '../src/server/audit';
import { SessionLog, SessionStopped } from '../src/server/sessions';
import { allSessions, sessionDetail } from '../src/server/sessionviews';
import type { AuditResponse } from '../src/shared/audit';
import type { ImportRecord } from '../src/shared/schema';
import type { SessionDetail, SessionListResponse, SessionTotalsResponse, TranscriptResponse } from '../src/shared/sessions';
import { textPdf } from './pdf';

const CSRF = { 'x-finance-csrf': '1' };

/**
 * The stand-in reader. It streams what the real CLI does with --output-format stream-json: the
 * init, a Read tool call and its result (the file as base64, as the CLI gives a PDF), the output
 * through StructuredOutput, then the result. FAKE_CLAUDE_MODE: "unbalanced" (the first model's
 * reading does not add up, so the checking model reads it again), "fail", "slow".
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const arg = (f) => args[args.indexOf(f) + 1];
const model = arg('--model');
const mode = process.env.FAKE_CLAUDE_MODE || '';
const schema = JSON.parse(arg('--json-schema'));
const fromStdin = args[1] && args[1].startsWith('--');
const stdin = fromStdin ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin }) + '\\n');
const full = model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: 'fake' }) + '\\n');
(async () => {
  if (!args.includes('stream-json') || !args.includes('--verbose') || !args.includes('--no-session-persistence')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'not streamed' });
    process.exit(1);
  }
  out({ type: 'system', subtype: 'init', model: full, tools: (arg('--tools') || '').split(',').filter(Boolean), permissionMode: 'dontAsk' });
  if (mode === 'slow') await sleep(1500);
  let output;
  if (schema.properties && schema.properties.labels) {
    output = { labels: [{ ref: 1, label: 'Example Bank current account statement, Sep 2026' }] };
  } else {
    const file = fs.readdirSync('.').find((f) => f.endsWith('.pdf'));
    out({ type: 'assistant', message: { role: 'assistant', model: full, content: [{ type: 'thinking', thinking: 'A bank statement.' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: './' + file } }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(file).toString('base64') } }, { type: 'text', text: 'Account number 12345678, sort code 12-34-56' }] }] } });
    const closing = mode === 'unbalanced' && model !== 'opus' ? 999 : 87.7;
    output = { documentType: 'bank_statement', institutionName: 'Example Bank', documentDate: '2026-09-30', accounts: [{ accountType: 'current', name: 'Current account', last4: '5678', currency: 'GBP', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: 100, closingBalance: closing, transactions: [{ date: '2026-09-12', description: 'TESCO STORES', amount: -12.3 }] }], figures: [], notes: [], confidence: 'high' };
  }
  if (mode === 'fail') {
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'It ran out of turns', total_cost_usd: 0.02, num_turns: 3, duration_ms: 40, modelUsage: { [full]: {} } });
    process.exit(1);
  }
  out({ type: 'assistant', message: { role: 'assistant', model: full, content: [{ type: 'text', text: 'Here is what it says.' }, { type: 'tool_use', id: 'tu_2', name: 'StructuredOutput', input: output }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: output, total_cost_usd: 0.0123, num_turns: 2, duration_ms: 50, usage: { input_tokens: 1500, output_tokens: 200 }, modelUsage: { [full]: {} } });
})();
`;

let binDir: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, bin: process.env.FINANCE_CLAUDE_BIN, log: process.env.FAKE_CLAUDE_LOG, mode: process.env.FAKE_CLAUDE_MODE };
beforeAll(async () => {
  // Only the stand-in can be found: no real claude on the PATH or in the home directory.
  binDir = await mkdtemp(path.join(os.tmpdir(), 'finance-fake-claude-'));
  await mkdir(path.join(binDir, 'home'));
  const bin = path.join(binDir, 'claude');
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.HOME = path.join(binDir, 'home');
  process.env.FINANCE_CLAUDE_BIN = bin;
});
afterAll(async () => {
  await rm(binDir, { recursive: true, force: true, maxRetries: 5 });
  for (const [k, v] of Object.entries({ HOME: saved.HOME, PATH: saved.PATH, FINANCE_CLAUDE_BIN: saved.bin, FAKE_CLAUDE_LOG: saved.log, FAKE_CLAUDE_MODE: saved.mode })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Claude sessions in the app', () => {
  let app: App;
  let dir: string;
  let work: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-sessions-'));
    work = path.join(dir, 'work');
    process.env.FAKE_CLAUDE_LOG = path.join(dir, 'claude.log');
    delete process.env.FAKE_CLAUDE_MODE;
  });
  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const start = async (env: Record<string, string> = {}) => {
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: work, FINANCE_INBOX_DIR: path.join(dir, 'inbox'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env, inbox: false });
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: CLAUDE_TASKS });
  };
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://127.0.0.1${p}`, { ...init, headers: { host: '127.0.0.1', ...(init.headers ?? {}) } });
  const get = async <T,>(p: string) => (await (await req(p)).json()) as T;
  const json = (body: unknown, method = 'POST') => ({ method, headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const until = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let v = await fn();
    for (let i = 0; i < 200 && !ok(v); i++) {
      await new Promise((r) => setTimeout(r, 50));
      v = await fn();
    }
    return v;
  };
  async function upload(name = 'statement.pdf'): Promise<ImportRecord> {
    const form = new FormData();
    form.append('file', new Blob([textPdf(['Example Bank', 'Your statement', `Ref ${name}`])]), name);
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    return until(
      () => get<ImportRecord>(`/api/imports/${results[0]!.id}`),
      (r) => ['review', 'failed', 'needs_mapping'].includes(r.status),
    );
  }

  it('records a reading with its whole transcript, beside the import, and links what it produced and its audit rows', async () => {
    await start();
    const rec = await upload();
    expect(rec.extraction.error).toBeUndefined();
    expect(rec.status).toBe('review');
    const list = await get<SessionListResponse>('/api/sessions');
    const readings = list.sessions.filter((s) => s.importId === rec.id);
    expect(readings).toHaveLength(1);
    const s = readings[0]!;
    expect(s).toMatchObject({ source: 'recorded', kind: 'reading', role: 'first', engine: 'claude-cli', model: 'claude-sonnet-5-5', status: 'succeeded', costUsd: 0.0123, startedBy: 'You (on this machine, no login)', transcript: 'kept' });
    expect(s.reason).toBe('Uploaded: statement.pdf');
    expect(s.promptVersion).toMatch(/^extract-/);
    expect(list.retention).toMatchObject({ days: 90 });

    // The transcript is in the work area beside the import, never in the data. The import shows its
    // new state before its audit row is written (on the save's update event), so wait for that row.
    const d = await until(
      () => get<SessionDetail>(`/api/sessions/${s.id}`),
      (x) => x.audit.some((e) => e.action === 'import.review'),
    );
    expect(d.record!.transcript.path).toBe(path.join('imports', rec.id, `${s.id}.jsonl`));
    const file = path.join(work, d.record!.transcript.path);
    expect(existsSync(file)).toBe(true);
    expect(((await readdir(path.join(dir, 'data'), { recursive: true }))).some((f) => f.includes(s.id))).toBe(false);
    expect(d.record).toMatchObject({ turns: 2, usage: { inputTokens: 1500, outputTokens: 200 }, tools: ['Read'] });

    const t = await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript`);
    const types = t.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['finance.request', 'system', 'assistant', 'user', 'assistant', 'result']);
    const request = t.events[0] as { systemPrompt: string; prompt: string; schema: unknown; files: { name: string }[] };
    expect(request.systemPrompt.length).toBeGreaterThan(100);
    expect(request.prompt).toMatch(/document\.pdf/);
    expect(request.files.map((f) => f.name)).toEqual(['document.pdf']);
    const text = await readFile(file, 'utf8');
    // The file's bytes are left out; account numbers keep their last 4 digits.
    expect(text).toContain("[not kept: the file's");
    expect(text).not.toContain('JVBERi0');
    expect(text).not.toContain('12345678');
    expect(text).toContain('••••5678');
    // Later events only, for a page following a running session.
    expect((await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript?from=4`)).events).toHaveLength(2);

    // What it produced, linked to where it lives.
    expect(d.produced.map((o) => o.type)).toEqual(['import', 'extraction', 'verification', 'draft']);
    expect(d.produced[0]!.href).toBe(`/import/${rec.id}`);
    expect(d.produced[1]!.note).toMatch(/^kept/);

    // Its audit rows; and the audit log links back to it.
    const actions = d.audit.map((e) => e.action);
    expect(actions).toContain('session.start');
    expect(actions).toContain('session.succeeded');
    expect(actions).toContain('import.review');
    const audit = await get<AuditResponse>('/api/audit?category=session');
    expect(audit.entries.length).toBe(2);
    expect(audit.entries.every((e) => e.sessions?.some((x) => x.id === s.id))).toBe(true);
    const seq = audit.entries[0]!.seq;
    expect((await get<AuditResponse>(`/api/audit?q=${encodeURIComponent(`#${seq}`)}`)).entries.map((e) => e.seq)).toEqual([seq]);
    const importEntries = await get<AuditResponse>(`/api/audit?about=${rec.id}`);
    expect(importEntries.entries.find((e) => e.action === 'import.review')?.sessions?.map((x) => x.id)).toEqual([s.id]);
  });

  it('records the check by a second model as a session of its own, and says which reading was kept', async () => {
    process.env.FAKE_CLAUDE_MODE = 'unbalanced';
    await start();
    const rec = await upload();
    expect(rec.extraction.verification).toMatchObject({ method: 'second-reading', kept: 'second' });
    const sessions = (await get<SessionListResponse>('/api/sessions')).sessions.filter((s) => s.importId === rec.id);
    expect(sessions.map((s) => [s.role, s.model])).toEqual([
      ['second', 'claude-opus-5-5'],
      ['first', 'claude-sonnet-5-5'],
    ]);
    const first = await get<SessionDetail>(`/api/sessions/${sessions[1]!.id}`);
    expect(first.produced.find((o) => o.type === 'extraction')!.note).toMatch(/^not kept/);
    expect(first.related.map((r) => r.id)).toEqual([sessions[0]!.id]);
    const second = await get<SessionDetail>(`/api/sessions/${sessions[0]!.id}`);
    expect(second.produced.find((o) => o.type === 'extraction')!.note).toMatch(/^kept/);
  });

  it('a failed run keeps its transcript, error and cost', async () => {
    process.env.FAKE_CLAUDE_MODE = 'fail';
    await start();
    const rec = await upload();
    expect(rec.status).toBe('failed');
    const s = (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.importId === rec.id)!;
    expect(s).toMatchObject({ status: 'failed', costUsd: 0.02 });
    const d = await get<SessionDetail>(`/api/sessions/${s.id}`);
    expect(d.record!.error).toMatch(/error_max_turns/);
    const types = (await get<TranscriptResponse>(`/api/sessions/${s.id}/transcript`)).events.map((e) => (e as { type: string }).type);
    expect(types.slice(-2)).toEqual(['result', 'finance.error']);
    expect((await get<AuditResponse>('/api/audit?category=session&outcome=failed')).entries).toHaveLength(1);
  });

  it('an agent job is a session: its prompt from stdin, its transcript beside the job, the names it wrote', async () => {
    await start();
    const rec = await upload();
    await req(`/api/imports/${rec.id}/commit`, { method: 'POST', headers: CSRF });
    const settings = await get<{ agents: Record<string, unknown> }>('/api/settings');
    await req('/api/settings', json({ ...settings, agents: { ...settings.agents, labelImports: true } }, 'PUT'));
    const job = (await (await req('/api/jobs', json({ kind: 'label-imports', params: { importIds: [rec.id] } }))).json()) as { id: string };
    const s = await until(
      async () => (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.jobId === job.id),
      (x) => x?.status === 'succeeded',
    );
    expect(s).toMatchObject({ kind: 'job', jobKind: 'label-imports', promptVersion: 'label-imports-2', startedBy: 'You (on this machine, no login)', reason: 'You started it' });
    // Its last steps (the names written) follow the end of the Claude session.
    const d = await until(
      () => get<SessionDetail>(`/api/sessions/${s!.id}`),
      (x) => x.produced.some((o) => o.type === 'import name') && x.audit.some((e) => e.action === 'session.succeeded'),
    );
    expect(d.record!.transcript.path).toBe(path.join('jobs', job.id, `${s!.id}.jsonl`));
    expect(d.record!.privacy).toBe('personal');
    expect(d.record!.tools).toEqual([]);
    expect(d.produced.find((o) => o.type === 'import name')).toMatchObject({ id: rec.id, label: 'Example Bank current account statement, Sep 2026', href: `/import/${rec.id}` });
    const request = (await get<TranscriptResponse>(`/api/sessions/${s!.id}/transcript`)).events[0] as { prompt: string };
    expect(request.prompt).toMatch(/Name these 1 imports/);
    // Writes the job made are its rows in the audit log, and link back.
    expect(d.audit.some((e) => e.action === 'data.change' && e.actor.type === 'job')).toBe(true);
    const jobRows = await get<AuditResponse>(`/api/audit?about=${job.id}`);
    expect(jobRows.entries.every((e) => e.sessions?.some((x) => x.id === s!.id))).toBe(true);
    // The request that queued the job is linked from its session, and the session's own audit rows carry it.
    expect(d.record!.requestId).toMatch(/^req_[0-9a-f]{12}$/);
    expect(d.audit.find((e) => e.action === 'session.start')?.details).toMatchObject({ requestId: d.record!.requestId });
    // What the answer became is in the transcript; the data it ran on is on the record.
    const events = (await get<TranscriptResponse>(`/api/sessions/${s!.id}/transcript`)).events as { type: string; summary?: string }[];
    expect(events.find((e) => e.type === 'finance.applied')?.summary).toBeTruthy();
    expect(typeof d.record!.data?.format).toBe('number');
    // The transcript's hash is on the record and in the hash-chained audit log.
    const sha = createHash('sha256').update(await readFile(path.join(work, d.record!.transcript.path))).digest('hex');
    expect(d.record!.transcript.sha256).toBe(sha);
    expect(d.audit.find((e) => e.action === 'session.succeeded')?.details).toMatchObject({ transcriptSha256: sha });
 
    // The totals count it, with the reading before it, at what Claude reported.
    const totals = await get<SessionTotalsResponse>('/api/sessions/totals');
    expect(totals.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: 'Job: label-imports', engine: 'claude-cli', sessions: 1, failed: 0, costUsd: 0.0123 }),
        expect.objectContaining({ task: 'Reading documents', engine: 'claude-cli', sessions: 1, inputTokens: 1500, outputTokens: 200 }),
      ]),
    );
  });

  it('a running session can be stopped from its page: the engine stops, and the audit log says who', async () => {
    process.env.FAKE_CLAUDE_MODE = 'slow';
    await start();
    const form = new FormData();
    form.append('file', new Blob([textPdf(['Example Bank', 'stop me'])]), 'stop.pdf');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    const running = await until(
      async () => (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.kind === 'reading'),
      (x) => x?.status === 'running',
    );
    // Not for a session that is not running, and not for an agent token (the route is not open to one).
    expect((await req('/api/sessions/ses_nope/stop', { method: 'POST', headers: CSRF })).status).toBe(404);
    expect((await req(`/api/sessions/${running!.id}/stop`, { method: 'POST', headers: CSRF })).status).toBe(200);
    const d = await until(
      () => get<SessionDetail>(`/api/sessions/${running!.id}`),
      (x) => x.audit.some((e) => e.action === 'session.cancelled'),
    );
    expect(d.session.status).toBe('cancelled');
    expect(d.record!.stoppedBy?.actor.type).toBeTruthy();
    expect(d.record!.error).toMatch(/^Stopped by /);
    const types = (await get<TranscriptResponse>(`/api/sessions/${running!.id}/transcript`)).events.map((e) => (e as { type: string }).type);
    expect(types).toContain('finance.cancelled');
    expect(types).not.toContain('result');
    // The stop is the request's doing: its row names the session and lists the stop.
    expect(d.audit.find((e) => e.action === 'request' && e.request?.path === `/api/sessions/${running!.id}/stop`)?.changes?.map((x) => x.action)).toEqual(['session.cancel']);
    const rec = await until(
      () => get<ImportRecord>(`/api/imports/${results[0]!.id}`),
      (r) => r.status !== 'processing' && r.status !== 'queued',
    );
    expect(rec.status).toBe('failed');
    expect((await req(`/api/sessions/${running!.id}/stop`, { method: 'POST', headers: CSRF })).status).toBe(409);
  });

  it('a running session updates: its record and transcript grow before it ends', async () => {
    process.env.FAKE_CLAUDE_MODE = 'slow';
    await start();
    const form = new FormData();
    form.append('file', new Blob([textPdf(['Example Bank', 'slow'])]), 'slow.pdf');
    await req('/api/imports', { method: 'POST', headers: CSRF, body: form });
    const running = await until(
      async () => (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.kind === 'reading'),
      (x) => x?.status === 'running',
    );
    const live = await until(
      () => get<TranscriptResponse>(`/api/sessions/${running!.id}/transcript`),
      (t) => t.total >= 2,
    );
    expect(live.events.map((e) => (e as { type: string }).type)).toEqual(['finance.request', 'system']);
    const done = await until(
      () => get<SessionDetail>(`/api/sessions/${running!.id}`),
      (d) => d.session.status === 'succeeded',
    );
    expect(done.record!.transcript.events).toBe(6);
  });

  it('sessions from before transcripts show what was recorded, and say no transcript was kept', async () => {
    await mkdir(path.join(work, 'jobs'), { recursive: true });
    const old = { id: 'job_old1', kind: 'monthly-review', label: 'Month in review: 2026-08', params: { month: '2026-08' }, status: 'succeeded', trigger: 'schedule', privacy: 'personal', promptVersion: 'monthly-review-2', createdAt: '2026-09-01T09:00:00.000+01:00', startedAt: '2026-09-01T09:00:01.000+01:00', finishedAt: '2026-09-01T09:01:00.000+01:00', durationMs: 59000, model: 'claude-opus-5-5', costUsd: 0.21, summary: '2 insights', written: [] };
    await writeFile(path.join(work, 'jobs', 'job_old1.json'), JSON.stringify(old));
    await start();
    const s = (await get<SessionListResponse>('/api/sessions')).sessions.find((x) => x.jobId === 'job_old1')!;
    expect(s).toMatchObject({ id: 'earlier-job_old1', source: 'earlier', transcript: 'none', costUsd: 0.21, model: 'claude-opus-5-5', startedBy: 'The app', reason: 'Due: started by the app' });
    const d = await get<SessionDetail>('/api/sessions/earlier-job_old1');
    expect(d.noTranscript).toMatch(/No transcript was kept, and the app does not reconstruct one/);
    expect(d.recorded).toMatchObject({ summary: '2 insights', costUsd: 0.21 });
    expect(d.record).toBeUndefined();
    expect((await req('/api/sessions/earlier-job_old1/transcript')).status).toBe(404);
  });

  it('agents with a token are seen by their requests, without a transcript', async () => {
    await start({ FINANCE_USERNAME: 'owner', FINANCE_PASSWORD_HASH: 'scrypt$x$y' });
    const made = (await app.ctx.tokens.create({ name: 'Claude Code on my-server', scopes: ['imports'], days: 30 })) as { token: string };
    const bearer = { authorization: `Bearer ${made.token}` };
    await req('/api/imports', { headers: bearer });
    await req('/api/accounts', { headers: bearer });
    await req('/api/settings', { method: 'PUT', headers: { ...bearer, ...CSRF, 'content-type': 'application/json' }, body: '{}' });
    const list = await until(
      () => allSessions(app.ctx),
      (l) => l.some((s) => s.source === 'token'),
    );
    const s = list.find((x) => x.source === 'token')!;
    expect(s).toMatchObject({ kind: 'token', title: 'Agent with the token “Claude Code on my-server”', status: 'running', requests: { total: 3, changes: 0, refused: 1 }, transcript: 'none' });
    const d = (await sessionDetail(app.ctx, s.id))!;
    expect(d.requests!.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['GET /api/imports 200', 'GET /api/accounts 200', 'PUT /api/settings 403']);
    expect(d.noTranscript).toMatch(/ran outside the app/);
    expect(d.audit.some((e) => e.actor.type === 'token' && e.outcome === 'refused')).toBe(true);
  });

  it("groups an agent's requests by the session it names, keeping each query and answer size", async () => {
    await start({ FINANCE_USERNAME: 'owner', FINANCE_PASSWORD_HASH: 'scrypt$x$y' });
    const made = (await app.ctx.tokens.create({ name: 'Claude Code on my-server', scopes: ['imports'], days: 30 })) as { token: string };
    const as = (session?: string) => ({ authorization: `Bearer ${made.token}`, ...(session ? { 'x-agent-session': session } : {}) });
    await req('/api/transactions?q=tesco&accounts=12345678', { headers: as('cc-one') });
    await req('/api/imports', { headers: as('cc-two') });
    await req('/api/accounts', { headers: as('cc-one') });
    await req('/api/settings', { method: 'PUT', headers: { ...as('cc-two'), ...CSRF, 'content-type': 'application/json' }, body: '{}' });
    await req('/api/imports', { headers: as('not a valid id!') });
    const list = await until(
      () => allSessions(app.ctx),
      (l) => l.filter((s) => s.source === 'token').length === 3,
    );
    const tokens = list.filter((x) => x.source === 'token');
    expect(tokens.map((x) => [x.agentSession ?? null, x.requests!.total]).sort()).toEqual([
      [null, 1],
      ['cc-one', 2],
      ['cc-two', 2],
    ]);
    const one = (await sessionDetail(app.ctx, tokens.find((x) => x.agentSession === 'cc-one')!.id))!;
    expect(one.session.title).toBe('Agent with the token “Claude Code on my-server” (session cc-one)');
    // The query is kept, an account number in it masked; the answer's size too.
    expect(one.requests![0]).toMatchObject({ path: '/api/transactions', query: '?q=tesco&accounts=••••5678' });
    expect(one.requests![0]!.bytes).toBeGreaterThan(0);
    expect(one.noTranscript).toMatch(/It named its session: cc-one/);
    // The audit log names the session on the request it refused.
    const refused = (await app.ctx.audit.query({ outcome: 'refused', limit: 10 })).entries.find((e) => e.actor.type === 'token');
    expect(refused?.actor).toMatchObject({ type: 'token', agentSession: 'cc-two' });
  });
});

describe('transcript limits', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-transcripts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const session = (log: SessionLog, jobId = 'job_a') => log.start({ kind: 'job', title: 'A job', jobKind: 'monthly-review', jobId, engine: 'claude-cli', model: 'opus', tools: [], startedBy: { actor: { type: 'app', task: 'test' }, reason: 'test' } });

  it('one transcript stops at its cap, but still keeps the final result', async () => {
    const log = new SessionLog(dir, { days: 90, maxBytes: 2000, totalBytes: 1e9 });
    await log.init({ sweep: false });
    const s = await session(log);
    for (let i = 0; i < 20; i++) s.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } });
    s.write({ type: 'result', subtype: 'success', total_cost_usd: 0.5, structured_output: { ok: true } });
    await s.finish('succeeded');
    const t = (await log.transcript(s.id))!;
    const types = t.events.map((e) => (e as { type: string }).type);
    expect(types.at(-2)).toBe('finance.truncated');
    expect(types.at(-1)).toBe('result');
    expect(types.filter((x) => x === 'finance.truncated')).toHaveLength(1);
    expect(log.get(s.id)).toMatchObject({ costUsd: 0.5, transcript: { truncated: true } });
  });

  it('transcripts go after the retention period, and the oldest go first over the total cap; the record says so', async () => {
    const log = new SessionLog(dir, { days: 90, maxBytes: 1e6, totalBytes: 1e9 });
    await log.init({ sweep: false });
    const a = await session(log, 'job_a');
    a.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } });
    await a.finish('succeeded');
    const file = path.join(dir, log.get(a.id)!.transcript.path);
    expect(existsSync(file)).toBe(true);
    expect(await log.sweep(Date.now() + 89 * 86_400_000)).toBe(0);
    expect(await log.sweep(Date.now() + 91 * 86_400_000)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(log.get(a.id)!.transcript.removed).toMatchObject({ why: 'expired' });

    const small = new SessionLog(path.join(dir, 'w2'), { days: 90, maxBytes: 1e6, totalBytes: 600 });
    await small.init({ sweep: false });
    const ids: string[] = [];
    for (const j of ['job_1', 'job_2', 'job_3']) {
      const s = await session(small, j);
      s.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(150) }] } });
      await s.finish('succeeded');
      ids.push(s.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    await small.sweep();
    expect(ids.map((id) => small.get(id)!.transcript.removed?.why ?? 'kept')).toEqual(['over-total', 'kept', 'kept']);
    // Kept across a restart; a session the app stopped in the middle of says so.
    const again = new SessionLog(path.join(dir, 'w2'));
    await again.init({ sweep: false });
    expect(again.get(ids[0]!)!.transcript.removed?.why).toBe('over-total');
  });

  it('a stopped session tells its engine through its signal, ends cancelled, and is audited with who stopped it', async () => {
    const audit = AuditLog.open(path.join(dir, 'audit'));
    const log = new SessionLog(dir, { days: 90, maxBytes: 1e6, totalBytes: 1e9 }, audit);
    await log.init({ sweep: false });
    const s = await session(log);
    const engine = new Promise<void>((_, reject) => s.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    const run = s.run(async (sink) => {
      sink.write({ type: 'system', subtype: 'init' });
      await engine;
    });
    expect(log.cancel(s.id, { type: 'owner', user: 'owner', via: 'session', ip: '127.0.0.1' })).toBe(true);
    await expect(run).rejects.toBeInstanceOf(SessionStopped);
    expect(log.get(s.id)).toMatchObject({ status: 'cancelled', error: 'Stopped by You.', stoppedBy: { actor: { type: 'owner' } } });
    expect(log.cancel(s.id)).toBe(false);
    const t = (await log.transcript(s.id))!;
    expect(t.events.map((e) => (e as { type: string }).type)).toEqual(['system', 'finance.cancelled', 'finance.error']);
    const rows = await audit.query({ about: [s.id], limit: 10 });
    expect(rows.entries.map((e) => e.action).sort()).toEqual(['session.cancel', 'session.cancelled', 'session.start']);
  });

  it("keeps a session's input files gzipped beside its transcript, serves them back, and deletes them with it", async () => {
    const log = new SessionLog(dir, { days: 90, maxBytes: 1e6, totalBytes: 1e9 });
    await log.init({ sweep: false });
    const scratch = path.join(dir, 'scratch');
    await mkdir(path.join(scratch, 'sub'), { recursive: true });
    await writeFile(path.join(scratch, 'transactions.jsonl'), '{"id":"t1"}\n'.repeat(100));
    await writeFile(path.join(scratch, 'sub', 'digest.json'), '{"months":[]}');
    const s = await session(log);
    await s.keepInputs(scratch);
    await s.finish('succeeded');
    const r = log.get(s.id)!;
    expect(r.inputs!.files.map((f) => f.name)).toEqual([path.join('sub', 'digest.json'), 'transactions.jsonl']);
    expect(r.inputs!.files[1]!.storedBytes).toBeLessThan(r.inputs!.files[1]!.bytes);
    expect((await log.input(s.id, 'transactions.jsonl'))!.toString()).toBe('{"id":"t1"}\n'.repeat(100));
    expect(await log.input(s.id, '../escape')).toBeUndefined();
    expect(log.bytes()).toBe(r.transcript.bytes + r.inputs!.files.reduce((n, f) => n + f.storedBytes, 0));
    await log.sweep(Date.now() + 91 * 86_400_000);
    expect(existsSync(path.join(dir, r.inputs!.dir))).toBe(false);
    expect(log.get(s.id)!.inputs!.removed).toMatchObject({ why: 'expired' });
    expect(await log.input(s.id, 'transactions.jsonl')).toBeUndefined();
  });

  it('finds transcripts by their words, newest first, within its budget', async () => {
    const log = new SessionLog(dir, { days: 90, maxBytes: 1e6, totalBytes: 1e9 });
    await log.init({ sweep: false });
    const a = await session(log, 'job_a');
    a.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Payments at EXAMPLE CAFE in ringgit' }] } });
    await a.finish('succeeded');
    await new Promise((r) => setTimeout(r, 5));
    const b = await session(log, 'job_b');
    b.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing in ringgit here' }] } });
    await b.finish('succeeded');
    const both = await log.search('Ringgit');
    expect(both.hits.map((h) => h.id)).toEqual([b.id, a.id]);
    const one = await log.search('ringgit cafe');
    expect(one.hits.map((h) => h.id)).toEqual([a.id]);
    expect(one.hits[0]!.snippet).toContain('EXAMPLE CAFE in ringgit');
    expect(await log.search('ringgit', { limit: 1 })).toMatchObject({ hits: [{ id: b.id }], partial: true });
  });

  it('a session stopped by a restart is marked failed', async () => {
    const log = new SessionLog(dir);
    await log.init({ sweep: false });
    const s = await session(log);
    s.write({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    await new Promise((r) => setTimeout(r, 1100));
    const after = new SessionLog(dir);
    await after.init({ sweep: false });
    expect(after.get(s.id)).toMatchObject({ status: 'failed', error: 'Stopped when the app restarted.' });
  });

  it('the API engine records the request without the file, the reply, and its usage and cost', async () => {
    const log = new SessionLog(dir);
    await log.init({ sweep: false });
    await writeFile(path.join(dir, 'page.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    const reply = JSON.stringify({ documentType: 'transactions_screenshot', institutionName: null, documentDate: null, accounts: [], figures: [], notes: [], confidence: 'high' });
    const events: [string, unknown][] = [
      ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 300 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const fetch = (() => Promise.resolve(new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }))) as typeof globalThis.fetch;
    const s = await log.start({ kind: 'reading', title: 'Read page.png', role: 'first', importId: 'imp_x', engine: 'claude-api', model: 'opus', tools: [], startedBy: { actor: { type: 'app', task: 'test' }, reason: 'test' } });
    await s.run((transcript) => extractWithClaudeApi({ apiKey: 'sk-test', files: [{ path: path.join(dir, 'page.png'), mediaType: 'image/png' }], userPrompt: 'Extract.', systemPrompt: 'System.', schema: { type: 'object' }, model: 'opus', effort: 'high', timeoutMs: 60_000, fetch, transcript }));
    const t = (await log.transcript(s.id))!;
    expect(t.events.map((e) => (e as { type: string }).type)).toEqual(['finance.request', 'system', 'finance.content_block', 'assistant', 'result']);
    const text = await readFile(path.join(dir, log.get(s.id)!.transcript.path), 'utf8');
    expect(text).toContain("[not kept: the file's");
    expect(text).not.toContain(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64'));
    expect(log.get(s.id)).toMatchObject({ status: 'succeeded', modelUsed: 'claude-opus-5-5', usage: { inputTokens: 1200, outputTokens: 300 } });
    expect(log.get(s.id)!.costUsd).toBeGreaterThan(0);
  });
});
