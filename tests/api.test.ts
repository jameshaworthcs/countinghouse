import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { loadConfig } from '../src/server/config';

const CSRF = { 'x-finance-csrf': '1' };

async function makeApp(env: Record<string, string> = {}): Promise<{ app: App; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-api-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', FINANCE_ALLOWED_HOSTS: 'finance.example.test', ...env });
  config.webDist = path.join(dir, 'no-web');
  const app = await createApp(config, { version: 'test', env, inbox: false });
  return { app, dir };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('agent jobs on throwaway data', () => {
  it('a serving instance over data not tracked in git never starts jobs by itself', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-jobs-'));
    try {
      // The inbox is set explicitly: for a data directory called "data" it defaults to the project's own.
      const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_INBOX_DIR: path.join(dir, 'inbox'), FINANCE_WATCH: '1', FINANCE_ALLOWED_HOSTS: 'finance.example.test' });
      config.webDist = path.join(dir, 'no-web');
      const app = await createApp(config, { version: 'test', env: {} });
      try {
        const { git, store } = app.ctx;
        const runner = app.ctx.runner!;
        expect(git.tracked).toBe(false);
        // Agents are on and research is due (none has been done), yet nothing starts by itself.
        // (No tick is run here: if this ever failed, a tick would spend the owner's plan.)
        expect(store.settings.agents.enabled).toBe(true);
        expect(runner.suggestions().some((s) => s.auto)).toBe(true);
        expect(runner.startsJobs).toBe(false);
        expect(runner.list()).toEqual([]);
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('API without login configured', () => {
  let ctx: { app: App; dir: string };
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}, host = 'localhost') =>
    ctx.app.app.request(`http://${host}${p}`, { ...init, headers: { host, ...(init.headers ?? {}) } });

  it('guards Host headers and CSRF', async () => {
    expect((await req('/api/health', {}, 'evil.example.com')).status).toBe(421);
    expect((await req('/api/health')).status).toBe(200);
    expect((await req('/api/accounts', { method: 'POST', body: '{}' })).status).toBe(403);
    const cross = await req('/api/accounts', { method: 'POST', headers: { ...CSRF, origin: 'https://evil.example.com', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', type: 'current' }) });
    expect(cross.status).toBe(403);
  });

  it('refuses proxied or remote requests when no login is configured', async () => {
    const res = await req('/api/summary', { headers: { 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https' } }, 'finance.example.test');
    expect(res.status).toBe(403);
  });

  it('imports a CSV end to end: upload → draft → commit → summary', async () => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv'))]), 'starling.csv');
    const up = await req('/api/imports', { method: 'POST', headers: CSRF, body: form });
    expect(up.status).toBe(201);
    const { results } = (await up.json()) as { results: { id: string }[] };
    const id = results[0]!.id;
    const record = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${id}`)).json()) as { status: string; draft?: { sections: { target: { mode: string }; balance?: number }[] } };
      return r.status === 'review' ? r : undefined;
    });
    expect(record.draft!.sections[0]!.target.mode).toBe('new');
    expect(record.draft!.sections[0]!.balance).toBe(2927.66);

    const commit = await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF });
    expect(commit.status).toBe(200);
    const summary = (await (await req('/api/summary')).json()) as { estate: { value: number }; accounts: { id: string; balance: number }[] };
    expect(summary.estate.value).toBe(2927.66);
    expect(summary.accounts[0]!.balance).toBe(2927.66);

    // The same file again is recognised as already imported.
    const again = new FormData();
    again.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/starling.csv'))]), 'starling-copy.csv');
    const dup = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: again })).json()) as { results: { duplicateOf?: { id: string } }[] };
    expect(dup.results[0]!.duplicateOf?.id).toBe(id);

    const txs = (await (await req('/api/transactions?q=tesco')).json()) as { total: number; items: { category?: string; id: string }[] };
    expect(txs.total).toBe(1);
    expect(txs.items[0]!.category).toBe('groceries');
    const patched = await req(`/api/transactions/${txs.items[0]!.id}`, { method: 'PATCH', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ category: 'home-garden', notes: 'bulbs' }) });
    const edited = (await patched.json()) as { categorisedBy: string; payeeSetBy?: string; amount: number };
    expect(edited.categorisedBy).toBe('user');
    // Saving a note without touching the payee does not lock the payee.
    expect(edited.payeeSetBy).toBeUndefined();

    // Correcting a misread amount keeps what the document said.
    const before = edited.amount;
    const corrected = await req(`/api/transactions/${txs.items[0]!.id}`, { method: 'PATCH', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ amount: before - 1, correctionNote: 'scan misread' }) });
    const fixed = (await corrected.json()) as { amount: number; corrections: { field: string; from: number; to: number; note?: string }[] };
    expect(fixed.amount).toBe(before - 1);
    expect(fixed.corrections).toEqual([expect.objectContaining({ field: 'amount', from: before, to: before - 1, note: 'scan misread' })]);
  });

  it('asks for a column mapping when a CSV layout is unknown', async () => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/unknown.csv'))]), 'unknown.csv');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    const rec = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${results[0]!.id}`)).json()) as { status: string; mapping?: { profile: unknown } };
      return r.status === 'needs_mapping' ? r : undefined;
    });
    const mapped = await req(`/api/imports/${results[0]!.id}/mapping`, {
      method: 'POST',
      headers: { ...CSRF, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: rec.mapping!.profile, saveAs: 'My Credit Union' }),
    });
    expect(((await mapped.json()) as { status: string }).status).toBe('review');
    const profiles = (await (await req('/api/csv-profiles')).json()) as { name: string }[];
    expect(profiles.map((p) => p.name)).toContain('My Credit Union');
  });

  it('reads an unknown card export card style, and the columns you choose win', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' };
    expect((await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify({ id: 'test-card', name: 'Test card', type: 'credit_card' }) })).status).toBe(201);
    const form = new FormData();
    form.append('file', new Blob(['Date,Merchant,Amount (GBP)\n01/09/2026,TESCO,12.34\n03/09/2026,TRAINLINE,30.00\n21/09/2026,PAYMENT RECEIVED - THANK YOU,-42.34\n']), 'card.csv');
    form.append('accountId', 'test-card');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    type Rec = { status: string; extraction: { warnings: string[] }; mapping?: { profile: { amountSign: string } }; draft?: { sections: { target: { accountId?: string }; transactions: { amount: number }[] }[] } };
    const id = results[0]!.id;
    const rec = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${id}`)).json()) as Rec;
      return r.status === 'review' ? r : undefined;
    });
    expect(rec.draft!.sections[0]!.target.accountId).toBe('test-card');
    expect(rec.draft!.sections[0]!.transactions.map((t) => t.amount)).toEqual([-12.34, -30, 42.34]);
    expect(rec.mapping!.profile.amountSign).toBe('inverted');
    expect(rec.extraction.warnings).toHaveLength(2);
    expect(rec.extraction.warnings[1]).toContain('card style');

    // Signs chosen on the review page: the draft is made again, and the warnings have done their job.
    const mapped = await req(`/api/imports/${id}/mapping`, { method: 'POST', headers: json, body: JSON.stringify({ profile: { ...rec.mapping!.profile, amountSign: 'normal' } }) });
    const after = (await mapped.json()) as Rec;
    expect(after.status).toBe('review');
    expect(after.draft!.sections[0]!.transactions.map((t) => t.amount)).toEqual([12.34, 30, -42.34]);
    expect(after.extraction.warnings).toEqual([]);
  });

  it('reads a card export in a layout that names no bank card style, and the signs can be changed back', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' };
    expect((await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify({ id: 'test-card', name: 'Test card', type: 'credit_card' }) })).status).toBe(201);
    const form = new FormData();
    form.append('file', new Blob(['Date,Description,Amount\n07/09/2026,SOFTWARE CO,3.49\n29/09/2026,Payment,-3.49\n']), 'card.csv');
    form.append('accountId', 'test-card');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    type Rec = { status: string; readiness?: { ready: boolean }; extraction: { detail?: string; warnings: string[] }; mapping?: { profile: { amountSign: string } }; draft?: { sections: { transactions: { amount: number }[] }[] } };
    const id = results[0]!.id;
    const rec = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${id}`)).json()) as Rec;
      return r.status === 'review' ? r : undefined;
    });
    expect(rec.extraction.detail).toBe('date-description-amount');
    expect(rec.draft!.sections[0]!.transactions.map((t) => t.amount)).toEqual([-3.49, 3.49]);
    expect(rec.extraction.warnings).toEqual([expect.stringContaining('card style')]);
    expect(rec.mapping!.profile.amountSign).toBe('inverted');
    const after = (await (await req(`/api/imports/${id}/mapping`, { method: 'POST', headers: json, body: JSON.stringify({ profile: { ...rec.mapping!.profile, amountSign: 'normal' } }) })).json()) as Rec;
    expect(after.draft!.sections[0]!.transactions.map((t) => t.amount)).toEqual([3.49, -3.49]);
  });

  it('commits a holdings export as it stands, and its funds become instruments with agents off', async () => {
    const store = ctx.app.ctx.store;
    await store.setSettings({ ...store.settings, agents: { ...store.settings.agents, enabled: false } });
    const json = { ...CSRF, 'content-type': 'application/json' };
    expect((await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify({ id: 'isa', name: 'ISA', type: 'stocks_isa' }) })).status).toBe(201);
    const form = new FormData();
    form.append('file', new Blob([await readFile(path.join(import.meta.dirname, 'fixtures/ii-holdings.csv'))]), 'ii-29-09-2026-ISA.csv');
    form.append('accountId', 'isa');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    const id = results[0]!.id;
    const rec = await waitFor(async () => {
      const r = (await (await req(`/api/imports/${id}`)).json()) as { status: string; readiness?: { ready: boolean; reasons: string[] } };
      return r.status === 'review' ? r : undefined;
    });
    // Dated by its file name, so nothing holds it back.
    expect(rec.readiness).toEqual({ ready: true, reasons: [] });
    expect(store.instruments).toEqual([]);
    expect((await req(`/api/imports/${id}/commit`, { method: 'POST', headers: CSRF })).status).toBe(200);
    expect(store.instruments.map((i) => i.sedol ?? i.ticker).sort()).toEqual(['B0000C4', 'B3X7QG6', 'XMPL']);
    expect(store.balances('isa').at(-1)).toMatchObject({ date: '2026-09-29', balance: 8978.1, gain: 1478.1, dateSource: 'filename' });
  });

  it('an account’s dates can be edited: a closing date closes it, clearing it opens it again', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' };
    await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify({ id: 'fixed', name: 'Fixed', type: 'savings', openedOn: '2023-09-14' }) });
    const patch = async (body: object) => req('/api/accounts/fixed', { method: 'PATCH', headers: json, body: JSON.stringify(body) });
    expect(await (await patch({ closedOn: '2025-09-12' })).json()).toMatchObject({ status: 'closed', closedOn: '2025-09-12', openedOn: '2023-09-14' });
    expect((await patch({ closedOn: '2020-01-01' })).status).toBe(400);
    expect((await patch({ closedOn: '2999-01-01' })).status).toBe(400);
    const reopened = (await (await patch({ closedOn: null })).json()) as { status: string; closedOn?: string };
    expect(reopened.status).toBe('open');
    expect(reopened.closedOn).toBeUndefined();
  });

  it('pages History through every committed import, the latest committed first', async () => {
    const store = ctx.app.ctx.store;
    // 30 documents uploaded a minute apart. The first two were committed last, either side of the
    // clocks going back: the one committed at 01:10 GMT came after the one at 01:30 BST.
    for (let n = 0; n < 30; n++) {
      const mm = String(n).padStart(2, '0');
      await store.saveImport(
        {
          id: `imp_20260901_09${mm}00_${(0xa000 + n).toString(16)}`,
          status: 'committed',
          createdAt: `2026-09-01T09:${mm}:00+01:00`,
          updatedAt: `2026-09-01T09:${mm}:00+01:00`,
          committedAt: n === 0 ? '2026-10-25T01:10:00+00:00' : n === 1 ? '2026-10-25T01:30:00+01:00' : `2026-09-01T10:${mm}:00+01:00`,
          origin: 'inbox',
          document: { id: `doc_${n.toString(16).padStart(16, '0')}`, sha256: n.toString(16).padStart(64, '0'), fileName: `statement-${n}.pdf`, mediaType: 'application/pdf', size: 1 },
          extraction: { warnings: [] },
          result: { accountIds: [], accountsCreated: [], transactionsAdded: 0, transactionsSkipped: 0, balancesAdded: 0, holdingsAdded: 0, figuresAdded: 1 },
        },
        'test import',
      );
    }
    const history = async (query = '') => (await (await req(`/api/imports/history${query}`)).json()) as { items: { fileName: string }[]; total: number; page: number; pageSize: number };
    const names = (h: { items: { fileName: string }[] }) => h.items.map((i) => i.fileName.replace(/^statement-(\d+)\.pdf$/, '$1'));
    const first = await history();
    expect(first).toMatchObject({ total: 30, page: 1, pageSize: 25 });
    expect(names(first).slice(0, 4)).toEqual(['0', '1', '29', '28']);
    expect(names(await history('?page=2'))).toEqual(['6', '5', '4', '3', '2']);
    // Asked past the end (an old address): the last page there is.
    expect((await history('?page=9')).page).toBe(2);
    expect((await history('?page=first')).page).toBe(1);
    // The list the app polls is only what waits for review.
    expect(await (await req('/api/imports')).json()).toEqual({ pending: [] });
  });

  it('sorts transactions by any column, with no category last either way', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' };
    for (const a of [{ id: 'zed', name: 'Zed Bank', type: 'current' }, { id: 'amex', name: 'Amex', type: 'credit_card' }]) {
      expect((await req('/api/accounts', { method: 'POST', headers: json, body: JSON.stringify(a) })).status).toBe(201);
    }
    const add = async (body: Record<string, unknown>) => ((await (await req('/api/transactions', { method: 'POST', headers: json, body: JSON.stringify(body) })).json()) as { id: string }).id;
    const cherry = await add({ accountId: 'zed', date: '2026-09-03', amount: -50, description: 'CHERRY CAFE', category: 'groceries' });
    const apple = await add({ accountId: 'amex', date: '2026-09-01', amount: -5, description: 'apple store' });
    const banana = await add({ accountId: 'zed', date: '2026-09-02', amount: 20, description: 'Banana Co', category: 'home-garden' });
    const order = async (sort?: string) => ((await (await req(`/api/transactions${sort ? `?sort=${sort}` : ''}`)).json()) as { items: { id: string }[] }).items.map((t) => t.id);

    expect(await order()).toEqual([cherry, banana, apple]);
    expect(await order('date_asc')).toEqual([apple, banana, cherry]);
    // Money out is negative, so ascending puts the biggest spend first.
    expect(await order('amount_asc')).toEqual([cherry, apple, banana]);
    expect(await order('amount_desc')).toEqual([banana, apple, cherry]);
    expect(await order('payee_asc')).toEqual([apple, banana, cherry]);
    expect(await order('payee_desc')).toEqual([cherry, banana, apple]);
    // Ties (both Zed Bank) fall back to newest first.
    expect(await order('account_asc')).toEqual([apple, cherry, banana]);
    expect((await order('category_asc')).at(-1)).toBe(apple);
    expect((await order('category_desc')).at(-1)).toBe(apple);
    expect((await order('category_asc')).slice(0, 2)).toEqual((await order('category_desc')).slice(0, 2).reverse());
    // Anything else is the default, newest first.
    expect(await order('nonsense')).toEqual([cherry, banana, apple]);
    expect(await order('description_asc')).toEqual([cherry, banana, apple]);
  });
});

describe('API with login configured', () => {
  let ctx: { app: App; dir: string };
  beforeEach(async () => {
    ctx = await makeApp({ FINANCE_USERNAME: 'james', FINANCE_PASSWORD_HASH: await hashPassword('correct horse'), FINANCE_SESSION_SECRET: 'x'.repeat(40) });
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) =>
    ctx.app.app.request(`http://finance.example.test${p}`, {
      ...init,
      headers: { host: 'finance.example.test', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-proto': 'https', ...(init.headers ?? {}) },
    });

  it('requires a session and issues a secure, HttpOnly cookie on login', async () => {
    expect((await req('/api/summary')).status).toBe(401);
    const bad = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'nope' }) });
    expect(bad.status).toBe(401);
    const good = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie')!;
    expect(cookie).toMatch(/finance_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(';')[0]!;
    expect((await req('/api/summary', { headers: { cookie: session } })).status).toBe(200);
    expect((await req('/api/summary', { headers: { cookie: `${session}x` } })).status).toBe(401);
  });

  it('throttles repeated failures', async () => {
    for (let i = 0; i < 10; i++) {
      await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: `x${i}` }) });
    }
    const res = await req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'james', password: 'correct horse' }) });
    expect(res.status).toBe(429);
  }, 30_000);
});
