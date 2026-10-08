// Split transactions and receipts: lines that must add up, reports that count the lines, receipts
// kept by id and read only when that is turned on (never really read here: the reader is a fake).
// All data here is invented.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { CLAUDE_TASKS } from './claude-tasks';
import { categoryLines, flows } from '../src/server/analytics/cashflow';
import { loadConfig } from '../src/server/config';
import { transactionId } from '../src/server/ids';
import { readReceipt } from '../src/server/receipts';
import { proposedSplit } from '../src/shared/splits';
import type { Receipt, Transaction } from '../src/shared/schema';

const CSRF = { 'x-finance-csrf': '1' };
const stamp = '2026-01-01T00:00:00+00:00';
const shopId = transactionId('current', '2026-09-12', -60, 'TESCO STORES', 0);
const transferId = transactionId('current', '2026-09-13', -100, 'TO SAVINGS', 0);

let app: App;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-splits-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(dir, 'no-web');
  app = await createApp(config, { version: 'test', env: {}, inbox: false });
  await app.ctx.store.setSettings({ ...app.ctx.store.settings, models: CLAUDE_TASKS });
  const { store } = app.ctx;
  await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
  const rows: Transaction[] = [
    { id: shopId, accountId: 'current', date: '2026-09-12', amount: -60, currency: 'GBP', description: 'TESCO STORES', category: 'groceries', source: {} },
    { id: transferId, accountId: 'current', date: '2026-09-13', amount: -100, currency: 'GBP', description: 'TO SAVINGS', category: 'savings-transfer', transferGroup: 'tg_1', source: {} },
  ];
  await store.addTransactions(rows, 'test');
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});
const req = (p: string, init: RequestInit = {}) => app.app.request(`http://127.0.0.1${p}`, { ...init, headers: { host: '127.0.0.1', ...(init.headers ?? {}) } });
const patch = (id: string, body: unknown) => req(`/api/transactions/${id}`, { method: 'PATCH', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('splitting a payment', () => {
  it('lines must add up to the payment, signed like it, in spending or income categories', async () => {
    const bad = async (splits: unknown) => ((await (await patch(shopId, { splits })).json()) as { error: string }).error;
    expect(await bad([{ category: 'groceries', amount: -40 }, { category: 'home-garden', amount: -10 }])).toBe('The lines add up to -50.00, not -60.00.');
    expect(await bad([{ category: 'groceries', amount: -70 }, { category: 'home-garden', amount: 10 }])).toBe('Each line has an amount, signed like the payment.');
    expect(await bad([{ category: 'groceries', amount: -50 }, { category: 'savings-transfer', amount: -10 }])).toBe('"To/from savings" is not a spending or income category.');
    expect(((await (await patch(transferId, { splits: [{ category: 'groceries', amount: -50 }, { category: 'gifts', amount: -50 }] })).json()) as { error: string }).error).toBe('A transfer between your accounts cannot be split.');
    expect((await patch(shopId, { splits: [{ category: 'groceries', amount: -45 }, { category: 'home-garden', amount: -15, note: 'bin bags' }] })).status).toBe(200);
  });

  it('spending counts the lines; the list finds it under each line’s category', async () => {
    await patch(shopId, { splits: [{ category: 'groceries', amount: -45 }, { category: 'home-garden', amount: -15 }] });
    const spent = flows(app.ctx.store, '2026-09-01', '2026-09-30').map((f) => [f.t.category, f.minor]);
    expect(spent).toEqual([
      ['groceries', 4500],
      ['home-garden', 1500],
    ]);
    const list = (await (await req('/api/transactions?categories=home-garden&period=custom&from=2026-09-01&to=2026-09-30')).json()) as { total: number };
    expect(list.total).toBe(1);
  });

  it('a corrected amount the lines no longer add up to takes the split away; a shortfall stays in the category', async () => {
    await patch(shopId, { splits: [{ category: 'groceries', amount: -45 }, { category: 'home-garden', amount: -15 }] });
    const fixed = (await (await patch(shopId, { amount: -62, correctionNote: 'misread' })).json()) as Transaction;
    expect(fixed.splits).toBeUndefined();
    // Written by hand, lines short of the amount leave the rest in the transaction's own category.
    const t = { ...fixed, splits: [{ category: 'groceries', amount: -40 }, { category: 'home-garden', amount: -12 }] };
    expect(categoryLines(t).map((l) => [l.category, l.amount])).toEqual([
      ['groceries', -40],
      ['home-garden', -12],
      ['groceries', -10],
    ]);
  });
});

describe('receipts', () => {
  const attach = async (name = 'receipt.png', bytes = Buffer.from('a receipt image')) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    return req(`/api/transactions/${shopId}/receipts`, { method: 'POST', headers: CSRF, body: form });
  };

  it('are kept with your documents, served by id, once per file; not read while reading is off', async () => {
    const res = await attach();
    expect(res.status).toBe(201);
    const r = (await res.json()) as Receipt;
    expect(r).toMatchObject({ transactionId: shopId, status: 'attached', document: { fileName: 'receipt.png', mediaType: 'image/png' } });
    expect(r.reading).toBeUndefined();
    expect(r.document.path).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f]{12}-receipt\.png$/);
    expect(existsSync(app.ctx.store.documentAbsPath(r.document.path!))).toBe(true);
    const doc = await req(`/api/documents/${r.document.id}`);
    expect(doc.status).toBe(200);
    expect(Buffer.from(await doc.arrayBuffer()).toString()).toBe('a receipt image');
    expect(((await (await attach()).json()) as Receipt).id).toBe(r.id);
    expect(app.ctx.store.receipts).toHaveLength(1);
    const readOff = await req(`/api/receipts/${r.id}/read`, { method: 'POST', headers: CSRF });
    expect(readOff.status).toBe(409);
    expect(((await readOff.json()) as { error: string }).error).toBe('Reading receipts is off: turn it on in Settings → Models & import.');
  });

  it('only photos and PDFs', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'notes.txt');
    expect((await req(`/api/transactions/${shopId}/receipts`, { method: 'POST', headers: CSRF, body: form })).status).toBe(415);
  });

  it('when reading is on: lines signed like the payment, unknown categories dropped, a split proposed that adds up', async () => {
    const r = (await (await attach()).json()) as Receipt;
    const { store, config } = app.ctx;
    await store.setSettings({ ...store.settings, extraction: { ...store.settings.extraction, readReceipts: true } });
    const read = await readReceipt(store, config, r.id, {
      bin: '/bin/false',
      sessions: app.ctx.sessions,
      reader: (opts) => {
        opts.transcript?.write({ type: 'result', subtype: 'success', total_cost_usd: 0.04 });
        // Only the receipt goes in the scratch directory, and only Read is allowed.
        expect(opts.tools).toEqual(['Read']);
        expect(opts.prompt).toMatch(/payment of £60\.00 on 2026-09-12/);
        return Promise.resolve({ model: 'claude-sonnet-5-5', durationMs: 1, costUsd: 0.04, output: { merchant: 'TESCO', date: '2026-09-12', total: 58.5, lines: [{ description: 'BANANAS', amount: 1.5, category: 'groceries' }, { description: 'BIN BAGS', amount: 12, category: 'home-garden' }, { description: 'MILK', amount: 45, category: 'not-a-category' }], notes: [] } });
      },
    });
    expect(read.status).toBe('read');
    expect(read.reading!.lines.map((l) => [l.amount, l.category])).toEqual([
      [-1.5, 'groceries'],
      [-12, 'home-garden'],
      [-45, null],
    ]);
    // The £1.50 receipt gap (the payment was £60) stays in the transaction's category.
    expect(proposedSplit(store.transaction(shopId)!, read.reading!)).toEqual([
      { category: 'groceries', amount: -48 },
      { category: 'home-garden', amount: -12 },
    ]);
    expect(store.transaction(shopId)!.splits).toBeUndefined();
    // The reading is a Claude session, its transcript beside the receipt in the work area.
    const [session] = app.ctx.sessions.list();
    expect(session).toMatchObject({ kind: 'receipt', receiptId: r.id, transactionId: shopId, status: 'succeeded', costUsd: 0.04, promptVersion: 'receipt-2' });
    expect(session!.transcript.path).toBe(path.join('receipts', r.id, `${session!.id}.jsonl`));
  });

  it('a reading that fails says why; taking a receipt off removes its file', async () => {
    const r = (await (await attach()).json()) as Receipt;
    const { store, config } = app.ctx;
    await store.setSettings({ ...store.settings, extraction: { ...store.settings.extraction, readReceipts: true } });
    const failed = await readReceipt(store, config, r.id, { bin: '/bin/false', reader: () => Promise.reject(new Error('Timed out after 600s')) });
    expect(failed).toMatchObject({ status: 'failed', error: 'Timed out after 600s' });
    const file = store.documentAbsPath(r.document.path!);
    expect((await req(`/api/receipts/${r.id}`, { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect(store.receipts).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});
