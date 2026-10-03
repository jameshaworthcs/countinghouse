// Assumptions, instruments, research, insights, owner context and notes: reading them, your
// overrides, and the validated batch write agents use (the same path as `npm run records`).

import { Hono } from 'hono';
import { z } from 'zod';
import { ASSUMPTION_DEFS, AssumptionSet, assumptionDef, scopeKey } from '../../shared/assumptions';
import { today } from '../../shared/dates';
import { AllocationSchema, ASSET_CLASSES, AssumptionScopeSchema, CONTEXT_KINDS, INSIGHT_PAGES, INSTRUMENT_TYPES, SlugSchema, type ContextRecord, type Note } from '../../shared/schema';
import { readJson, type AppContext } from '../context';
import { nowISO, randomHex, shortHash } from '../fsutil';
import { applyRecords, RecordBatchSchema, setOwnerAssumption } from '../records';
import { StoreError } from '../store';

export function recordRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { store } = ctx;

  // ─── Assumptions ─────────────────────────────────────────────────────────────────────────────

  app.get('/assumptions', (c) => {
    const set = new AssumptionSet(store.assumptions, today());
    const active = set.active().sort((a, b) => a.key.localeCompare(b.key) || scopeKey(a.scope).localeCompare(scopeKey(b.scope)));
    const history = new Map<string, number>();
    for (const a of store.assumptions) {
      const k = `${a.key}|${scopeKey(a.scope)}`;
      history.set(k, (history.get(k) ?? 0) + 1);
    }
    return c.json({
      defs: ASSUMPTION_DEFS.map((d) => ({ key: d.key, label: d.label, unit: d.unit, description: d.description, scopes: d.scopes, min: d.min, max: d.max, fallback: { value: set.fallback(d).value, range: set.fallback(d).range, note: d.fallback.note, byAssetClass: d.fallback.byAssetClass, byAccountType: d.fallback.byAccountType } })),
      active: active.map((a) => ({ ...a, versions: history.get(`${a.key}|${scopeKey(a.scope)}`) ?? 1, stale: a.provenance.setBy !== 'owner' && a.reviewBy !== undefined && a.reviewBy < today() })),
      global: ASSUMPTION_DEFS.filter((d) => d.scopes.includes('global')).map((d) => {
        const r = set.resolve(d.key);
        return { key: d.key, value: r.value, range: r.range, source: r.source, recordId: r.record?.id, note: r.note, stale: r.stale ?? false };
      }),
      // What each asset class and account type resolves to, for keys that vary by them.
      byClass: ['return.expected', 'return.volatility'].flatMap((key) =>
        ASSET_CLASSES.map((assetClass) => {
          const r = set.resolve(key, { assetClass });
          return { key, assetClass, value: r.value, range: r.range, source: r.source, recordId: r.record?.id, stale: r.stale ?? false };
        }),
      ),
      byType: (['current', 'savings', 'cash_isa', 'premium_bonds'] as const).map((accountType) => {
        const r = set.resolve('interest.rate', { accountType });
        return { key: 'interest.rate', accountType, value: r.value, source: r.source, recordId: r.record?.id, stale: r.stale ?? false };
      }),
    });
  });

  app.get('/assumptions/history', (c) => {
    const key = c.req.query('key') ?? '';
    if (!assumptionDef(key)) throw new StoreError('Unknown assumption key', 404);
    let scope;
    try {
      scope = AssumptionScopeSchema.parse(JSON.parse(c.req.query('scope') ?? '{"kind":"global"}'));
    } catch {
      throw new StoreError('Bad scope', 400);
    }
    const set = new AssumptionSet(store.assumptions, today());
    return c.json(set.history(key, scope).reverse());
  });

  const OverrideBody = z.object({
    key: z.string(),
    scope: AssumptionScopeSchema,
    value: z.number().optional(),
    range: z.object({ low: z.number(), high: z.number() }).optional(),
    rationale: z.string().max(2000).optional(),
    retire: z.boolean().optional(),
  });

  app.post('/assumptions/override', async (c) => {
    const body = await readJson(c, OverrideBody);
    const rec = await setOwnerAssumption(store, {
      key: body.key,
      scope: body.scope,
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.range ? { range: body.range } : {}),
      ...(body.rationale ? { rationale: body.rationale } : {}),
      ...(body.retire ? { retire: true } : {}),
    });
    return c.json(rec, 201);
  });

  // ─── The validated write path (agents; also `npm run records -- write`) ─────────────────────

  app.post('/records', async (c) => {
    const body = await readJson(c, RecordBatchSchema);
    if (body.provenance.setBy === 'owner') throw new StoreError('Owner records are written through the app’s own forms.', 400);
    return c.json(await applyRecords(store, body), 201);
  });

  // ─── Instruments and research ────────────────────────────────────────────────────────────────

  app.get('/instruments', (c) => c.json(store.instruments));

  const InstrumentBody = z.object({
    name: z.string().min(1).max(200),
    type: z.enum(INSTRUMENT_TYPES).optional(),
    isin: z.string().max(12).optional(),
    ticker: z.string().max(20).optional(),
    manager: z.string().max(120).optional(),
    allocation: AllocationSchema.optional(),
    aliases: z.array(z.string().max(200)).max(20).optional(),
    notes: z.string().max(2000).optional(),
  });

  app.post('/instruments', async (c) => {
    const body = await readJson(c, InstrumentBody);
    const res = await applyRecords(store, { provenance: { setBy: 'owner' }, supersede: false, records: [{ type: 'instrument', record: { ...body, isin: body.isin?.toUpperCase(), aliases: body.aliases ?? [] } }] });
    return c.json(store.instrument(res.written[0]!.id), 201);
  });

  app.patch('/instruments/:id', async (c) => {
    const existing = store.instrument(c.req.param('id'));
    if (!existing) throw new StoreError('Unknown instrument', 404);
    const body = await readJson(c, InstrumentBody.partial().extend({ allocation: AllocationSchema.nullable().optional() }));
    const { allocation, ...rest } = body;
    const next = { ...existing, ...rest, updatedAt: nowISO() } as Record<string, unknown>;
    if (allocation === null) delete next.allocation;
    else if (allocation) next.allocation = allocation;
    await store.setInstruments(
      store.instruments.map((i) => (i.id === existing.id ? (next as typeof existing) : i)),
      `instrument: edit ${existing.name}`,
    );
    return c.json(store.instrument(existing.id));
  });

  app.get('/research', (c) => {
    const instrumentId = c.req.query('instrumentId');
    const institutionId = c.req.query('institutionId');
    const kind = c.req.query('kind');
    return c.json(
      store.research
        .filter((r) => (!instrumentId || r.subject.instrumentId === instrumentId) && (!institutionId || r.subject.institutionId === institutionId) && (!kind || r.kind === kind))
        .slice()
        .reverse(),
    );
  });

  // ─── Insights ────────────────────────────────────────────────────────────────────────────────

  app.get('/insights', (c) => {
    const page = c.req.query('page');
    const accountId = c.req.query('accountId');
    const kind = c.req.query('kind');
    const all = c.req.query('all') === '1';
    const now = today();
    const list = store.insights
      .filter((i) => (all ? true : i.status === 'active' && (!i.expiresOn || i.expiresOn >= now)))
      .filter((i) => !kind || i.kind === kind)
      .filter((i) => !page || i.pages.includes(page as (typeof INSIGHT_PAGES)[number]))
      .filter((i) => !accountId || i.subject.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json(list);
  });

  app.post('/insights/:id/dismiss', async (c) => {
    const i = store.insights.find((x) => x.id === c.req.param('id'));
    if (!i) throw new StoreError('Unknown insight', 404);
    await store.upsertRecords('insights', [{ ...i, status: 'dismissed' }], `insight: dismiss ${i.title}`);
    return c.json({ ok: true });
  });

  app.post('/insights/:id/feedback', async (c) => {
    const i = store.insights.find((x) => x.id === c.req.param('id'));
    if (!i) throw new StoreError('Unknown insight', 404);
    const body = await readJson(c, z.object({ useful: z.boolean(), note: z.string().max(500).optional() }));
    await store.upsertRecords('insights', [{ ...i, feedback: { useful: body.useful, ...(body.note ? { note: body.note } : {}), at: nowISO() } }], `insight: feedback on ${i.title}`);
    return c.json({ ok: true });
  });

  // ─── Owner context and notes ─────────────────────────────────────────────────────────────────

  app.get('/context', (c) => c.json(store.context.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));

  const ContextBody = z.object({
    kind: z.enum(CONTEXT_KINDS),
    statement: z.string().min(1).max(1000),
    detail: z
      .object({
        accountId: SlugSchema.optional(),
        instrumentId: SlugSchema.optional(),
        event: z.string().max(40).optional(),
        amount: z.number().optional(),
        annualAmount: z.number().optional(),
        date: z.string().optional(),
        accountIds: z.array(SlugSchema).optional(),
      })
      .default({}),
  });

  app.post('/context', async (c) => {
    const body = await readJson(c, ContextBody);
    const res = await applyRecords(store, { provenance: { setBy: 'owner' }, supersede: false, records: [{ type: 'context', record: { ...body, status: 'active', origin: { kind: 'form' } } }] });
    return c.json(store.context.find((x) => x.id === res.written[0]!.id), 201);
  });

  app.patch('/context/:id', async (c) => {
    const rec = store.context.find((x) => x.id === c.req.param('id'));
    if (!rec) throw new StoreError('Unknown context record', 404);
    const body = await readJson(c, z.object({ status: z.enum(['active', 'done', 'retired']).optional(), statement: z.string().min(1).max(1000).optional() }));
    const next: ContextRecord = { ...rec, ...body, updatedAt: nowISO() };
    await store.upsertRecords('context', [next], `context: ${body.status ?? 'edit'} ${rec.statement.slice(0, 40)}`);
    return c.json(next);
  });

  app.get('/notes', (c) => c.json(store.notes.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))));

  app.post('/notes', async (c) => {
    const body = await readJson(c, z.object({ text: z.string().min(1).max(4000) }));
    const stamp = nowISO();
    const note: Note = { id: `note_${shortHash('note', body.text, stamp, randomHex(4))}`, text: body.text.trim(), status: 'new', proposals: [], createdAt: stamp, updatedAt: stamp };
    await store.upsertRecords('notes', [note], 'note: add');
    ctx.jobs?.enqueue({ kind: 'interpret-note', params: { noteId: note.id }, trigger: 'owner' });
    return c.json(note, 201);
  });

  /** Accept (some of) a note's proposals: each goes through the validated write path as yours. */
  app.post('/notes/:id/accept', async (c) => {
    const note = store.notes.find((n) => n.id === c.req.param('id'));
    if (!note) throw new StoreError('Unknown note', 404);
    const body = await readJson(c, z.object({ keys: z.array(z.string()).min(1), edits: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }));
    const chosen = note.proposals.filter((p) => body.keys.includes(p.key));
    if (!chosen.length) throw new StoreError('Nothing to accept', 400);
    const records = chosen.map((p) => {
      const record = { ...p.record, ...(body.edits?.[p.key] ?? {}) };
      return p.type === 'context'
        ? { type: 'context' as const, record: { ...record, status: 'active', origin: { kind: 'note', noteId: note.id, ...(note.jobId ? { interpretedBy: { setBy: 'agent', jobId: note.jobId } } : {}) } } }
        : { type: 'instrument' as const, record };
    });
    const res = await applyRecords(store, { provenance: { setBy: 'owner' }, supersede: false, records: records as never });
    const proposals = note.proposals.map((p) => (body.keys.includes(p.key) ? { ...p, accepted: true } : p));
    await store.upsertRecords('notes', [{ ...note, proposals, status: proposals.every((p) => p.accepted !== undefined) ? 'applied' : note.status, updatedAt: nowISO() }], 'note: accept proposals');
    return c.json(res);
  });

  app.post('/notes/:id/dismiss', async (c) => {
    const note = store.notes.find((n) => n.id === c.req.param('id'));
    if (!note) throw new StoreError('Unknown note', 404);
    await store.upsertRecords('notes', [{ ...note, status: 'dismissed', updatedAt: nowISO() }], 'note: dismiss');
    return c.json({ ok: true });
  });

  return app;
}
