// Upload, review and commit.

import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ImportHistoryResponse, ImportListResponse } from '../../shared/api';
import { CsvProfileSchema, DraftSchema, EXTRACTION_ENGINES, SlugSchema } from '../../shared/schema';
import { readJson, type AppContext } from '../context';
import { detectKind } from '../ingest/detect';
import { promptVersion } from '../ingest/prompt';
import { sheetRows } from '../ingest/xlsx';
import { StoreError, type ImportSummary } from '../store';

/** Committed imports on a page of the Import page's History. */
const HISTORY_PAGE_SIZE = 25;

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * The latest committed first, as History dates them. Imports committed together (Commit all ready)
 * go the latest uploaded first. Times are compared as instants: the offsets change with the clocks.
 */
function latestCommittedFirst(a: ImportSummary, b: ImportSummary): number {
  const at = (iso: string) => Date.parse(iso);
  return at(b.committedAt ?? b.createdAt) - at(a.committedAt ?? a.createdAt) || at(b.createdAt) - at(a.createdAt) || b.id.localeCompare(a.id);
}

export function importRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const svc = ctx.imports;

  app.get('/', (c) => {
    const novelty = svc.novelty();
    const body: ImportListResponse = {
      pending: svc.listPending().map((r) => {
        const nothingNew = novelty.get(r.id);
        return { ...r, readiness: svc.readiness(r, nothingNew), ...(nothingNew ? { nothingNew } : {}) };
      }),
    };
    return c.json(body);
  });

  /** Every committed import, a page at a time (`?page=`, from 1), for the Import page's History. */
  app.get('/history', (c) => {
    const all = [...ctx.store.imports].sort(latestCommittedFirst);
    const pages = Math.max(1, Math.ceil(all.length / HISTORY_PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(c.req.query('page'))) || 1));
    const body: ImportHistoryResponse = {
      items: all.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE).map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        fileName: i.fileName,
        mediaType: i.mediaType,
        documentId: i.documentId,
        ...(i.committedAt ? { committedAt: i.committedAt } : {}),
        ...(i.engine ? { engine: i.engine } : {}),
        ...(i.result ? { result: i.result } : {}),
      })),
      total: all.length,
      page,
      pageSize: HISTORY_PAGE_SIZE,
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

  /**
   * Committed documents worth reading again, and any re-reading of them: read by an older version of
   * the reader, or a CSV whose columns were worked out automatically (a layout may fit it now).
   */
  app.get('/rereads', (c) => {
    // The reader now: extract-12 when it reads everything a document prints (prompt.ts).
    const current = promptVersion(ctx.store.settings.extraction.readEverything);
    const number = (v: string | undefined) => Number(/extract-(\d+)/.exec(v ?? '')?.[1] ?? 0);
    return c.json({
      current,
      enabled: ctx.store.settings.extraction.rereadDocuments,
      older: ctx.store.imports
        .filter((i) => !i.result?.nothingNew && (((i.engine === 'claude-cli' || i.engine === 'claude-api') && number(i.engineVersion) < number(current)) || (i.engine === 'csv' && /auto-detected/.test(i.detail ?? ''))))
        .map((i) => ({ id: i.id, fileName: i.fileName, engineVersion: i.engineVersion ?? null, reason: i.engine === 'csv' ? 'columns worked out' : null, committedAt: i.committedAt ?? null, reread: svc.getReread(i.id)?.status ?? null })),
      rereads: svc.listRereads(),
    });
  });
  app.post('/commit-ready', async (c) => c.json(await svc.commitReady()));

  /** Dismiss every import that adds nothing new (their documents are filed, nothing recorded). */
  app.post('/dismiss-nothing-new', async (c) => c.json({ dismissed: await svc.dismissNothingNew() }));

  app.get('/:id', async (c) => {
    const rec = await svc.get(c.req.param('id'));
    if (!rec) throw new StoreError('Unknown import', 404);
    const pending = svc.getPending(rec.id);
    const nothingNew = pending ? svc.novelty().get(pending.id) : undefined;
    return c.json({ ...rec, ...(pending ? { readiness: svc.readiness(pending, nothingNew) } : {}), ...(nothingNew ? { nothingNew } : {}) });
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

  app.post('/:id/dismiss', async (c) => c.json(await svc.dismiss(c.req.param('id'))));

  // ─── Reading a stored document again (docs/INGESTION.md): yours only, and off unless turned on ──

  app.get('/:id/reread', (c) => c.json(svc.getReread(c.req.param('id')) ?? null));
  app.post('/:id/reread', async (c) => c.json(await svc.startReread(c.req.param('id')), 202));
  app.post('/:id/reread/apply', async (c) => {
    const body = await readJson(c, z.object({ key: z.string().min(1).max(80) }));
    return c.json(await svc.applyReread(c.req.param('id'), body.key));
  });
  app.delete('/:id/reread', async (c) => {
    await svc.forgetReread(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/:id/reprocess', async (c) => {
    const body = await readJson(c, z.object({ engine: z.enum(EXTRACTION_ENGINES).optional(), model: z.string().max(80).optional(), verifyModel: z.string().max(80).optional(), readAs: z.enum(['document', 'columns']).optional() }));
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

  /** A spreadsheet's table (its first, or the sheet named by `?sheet=`), for side-by-side review. */
  app.get('/:id/table', async (c) => {
    const rec = await svc.get(c.req.param('id'));
    if (!rec) throw new StoreError('Unknown import', 404);
    const pending = svc.getPending(rec.id);
    const file = pending ? svc.workFile(pending) : rec.document.path ? ctx.store.documentAbsPath(rec.document.path) : null;
    if (!file) throw new StoreError('Document not available', 404);
    const bytes = await readFile(file);
    if (detectKind(rec.document.fileName, bytes) !== 'xlsx') throw new StoreError('Not a spreadsheet', 404);
    const { rows, sheet, sheets } = sheetRows(bytes, c.req.query('sheet') || undefined);
    return c.json({ sheet, sheets, rows: rows.slice(0, 500), total: rows.length });
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
    // A statement or screenshot an import filed, or a receipt on a transaction: by id, never by path.
    const id = c.req.param('docId');
    const summary = ctx.store.imports.find((i) => i.documentId === id);
    const receipt = summary ? undefined : ctx.store.receipts.find((r) => r.document.id === id);
    const doc = summary?.documentPath ? { path: summary.documentPath, mediaType: summary.mediaType, fileName: summary.fileName } : receipt?.document.path ? { path: receipt.document.path, mediaType: receipt.document.mediaType, fileName: receipt.document.fileName } : undefined;
    if (!doc) throw new StoreError('Unknown document', 404);
    const bytes = await readFile(ctx.store.documentAbsPath(doc.path));
    const mediaType = doc.mediaType.startsWith('image/') || doc.mediaType === 'application/pdf' || /spreadsheet|ms-excel/.test(doc.mediaType) ? doc.mediaType : 'text/plain; charset=utf-8';
    return new Response(bytes, { headers: { 'Content-Type': mediaType, 'Content-Disposition': contentDisposition(doc.fileName), 'Cache-Control': 'private, max-age=3600' } });
  });
  return app;
}
