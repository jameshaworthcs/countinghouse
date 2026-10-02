// Receipts on transactions: attach, read (only when you have turned reading on), take off.

import { Hono } from 'hono';
import type { AppContext } from '../context';
import { attachReceipt, detachReceipt, readReceipt } from '../receipts';
import { StoreError } from '../store';

export function receiptRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { store } = ctx;

  app.get('/receipts', (c) => {
    const tx = c.req.query('transactionId');
    return c.json(store.receipts.filter((r) => !tx || r.transactionId === tx).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  /** multipart/form-data: file. Read by Claude straight away only when reading receipts is on. */
  app.post('/transactions/:id/receipts', async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new StoreError('No file uploaded (field name "file").');
    const receipt = await attachReceipt(store, ctx.config.workDir, c.req.param('id'), { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    if (store.settings.extraction.readReceipts && !receipt.reading) return c.json(await readReceipt(store, ctx.config, receipt.id, { sessions: ctx.sessions }), 201);
    return c.json(receipt, 201);
  });

  app.post('/receipts/:id/read', async (c) => c.json(await readReceipt(store, ctx.config, c.req.param('id'), { sessions: ctx.sessions })));

  app.delete('/receipts/:id', async (c) => {
    await detachReceipt(store, c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
