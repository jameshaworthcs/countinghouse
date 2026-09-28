// Upload, review and commit.

import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ImportListResponse } from '../../shared/api';
import { CsvProfileSchema, DraftSchema, EXTRACTION_ENGINES, SlugSchema } from '../../shared/schema';
import { readJson, type AppContext } from '../context';
import { StoreError } from '../store';

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function importRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const svc = ctx.imports;

  app.get('/', (c) => {
    const body: ImportListResponse = {
      pending: svc.listPending().map((r) => ({ ...r, readiness: svc.readiness(r) })),
      committed: ctx.store.imports.slice(0, 200).map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        fileName: i.fileName,
        mediaType: i.mediaType,
        documentId: i.documentId,
        ...(i.committedAt ? { committedAt: i.committedAt } : {}),
        ...(i.engine ? { engine: i.engine } : {}),
        ...(i.result ? { result: i.result } : {}),
      })),
    };
    return c.json(body);
  });

  /** multipart/form-data: file (repeatable), lastModified (repeatable, ms since epoch), accountId? */
  app.post('/', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(form.file ?? form['file[]'] ?? []).filter((f): f is File => f instanceof File);
    if (!files.length) throw new StoreError('No files uploaded (field name "file").');
    const lastModified = ([] as unknown[]).concat(form.lastModified ?? []).map(String);
    const accountId = typeof form.accountId === 'string' && form.accountId ? form.accountId : undefined;
    const force = form.force === '1';
    const results = [];
    for (const [i, file] of files.entries()) {
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        const lm = Number(lastModified[i] ?? file.lastModified);
        const res = await svc.create({
          fileName: file.name || `upload-${i + 1}`,
          bytes,
          origin: 'upload',
          hintAccountId: accountId,
          force,
          ...(Number.isFinite(lm) && lm > 0 ? { lastModified: new Date(lm).toISOString() } : {}),
        });
        results.push({ fileName: file.name, id: res.record?.id, duplicateOf: res.duplicateOf ? { id: res.duplicateOf.id } : undefined });
      } catch (err) {
        results.push({ fileName: file.name, error: (err as Error).message });
      }
    }
    return c.json({ results }, 201);
  });

  app.post('/commit-ready', async (c) => c.json(await svc.commitReady()));

  app.get('/:id', async (c) => {
    const rec = await svc.get(c.req.param('id'));
    if (!rec) throw new StoreError('Unknown import', 404);
    const pending = svc.getPending(rec.id);
    return c.json({ ...rec, ...(pending ? { readiness: svc.readiness(pending) } : {}) });
  });

  app.put('/:id/draft', async (c) => {
    const draft = await readJson(c, DraftSchema);
    return c.json(await svc.updateDraft(c.req.param('id'), draft));
  });

  app.post('/:id/commit', async (c) => {
    let draft;
    const text = await c.req.text();
    if (text.trim()) {
      const parsed = DraftSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new StoreError(`Invalid draft: ${parsed.error.issues[0]?.message ?? ''}`);
      draft = parsed.data;
    }
    return c.json(await svc.commit(c.req.param('id'), draft));
  });

  app.post('/:id/reprocess', async (c) => {
    const body = await readJson(c, z.object({ engine: z.enum(EXTRACTION_ENGINES).optional(), model: z.string().max(80).optional() }));
    return c.json(await svc.reprocess(c.req.param('id'), body));
  });

  app.post('/:id/refresh', async (c) => c.json(await svc.refreshDraft(c.req.param('id'))));

  app.post('/:id/hint', async (c) => {
    const body = await readJson(c, z.object({ accountId: SlugSchema.nullable() }));
    return c.json(await svc.setHint(c.req.param('id'), body.accountId ?? undefined));
  });

  app.post('/:id/mapping', async (c) => {
    const body = await readJson(c, z.object({ profile: CsvProfileSchema, saveAs: z.string().min(1).max(80).optional() }));
    return c.json(await svc.applyMapping(c.req.param('id'), body.profile, body.saveAs));
  });

  app.delete('/:id', async (c) => {
    await svc.discard(c.req.param('id'));
    return c.json({ ok: true });
  });

  /** The original document, for side-by-side review. */
  app.get('/:id/file', async (c) => {
    const rec = await svc.get(c.req.param('id'));
    if (!rec) throw new StoreError('Unknown import', 404);
    const pending = svc.getPending(rec.id);
    const file = pending ? svc.workFile(pending) : rec.document.path ? ctx.store.documentAbsPath(rec.document.path) : null;
    if (!file) throw new StoreError('Document not available', 404);
    const bytes = await readFile(file);
    const mediaType = rec.document.mediaType.startsWith('text/') || rec.document.mediaType.includes('ofx') || rec.document.mediaType.includes('qif') ? 'text/plain; charset=utf-8' : rec.document.mediaType;
    return new Response(bytes, {
      headers: { 'Content-Type': mediaType, 'Content-Disposition': contentDisposition(rec.document.fileName), 'Cache-Control': 'private, max-age=300' },
    });
  });

  return app;
}

export function documentRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.get('/:docId', async (c) => {
    const summary = ctx.store.imports.find((i) => i.documentId === c.req.param('docId'));
    if (!summary?.documentPath) throw new StoreError('Unknown document', 404);
    const bytes = await readFile(ctx.store.documentAbsPath(summary.documentPath));
    const mediaType = summary.mediaType.startsWith('image/') || summary.mediaType === 'application/pdf' ? summary.mediaType : 'text/plain; charset=utf-8';
    return new Response(bytes, { headers: { 'Content-Type': mediaType, 'Content-Disposition': contentDisposition(summary.fileName), 'Cache-Control': 'private, max-age=3600' } });
  });
  return app;
}
