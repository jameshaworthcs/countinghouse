// Agent jobs: what is queued, running, finished or stale; start, cancel and rerun.

import { Hono } from 'hono';
import { z } from 'zod';
import { JOB_DEFS, JOB_KINDS } from '../agents/kinds';
import { readJson, type AppContext } from '../context';
import { StoreError } from '../store';

export function jobRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const runner = () => {
    if (!ctx.runner) throw new StoreError('Agent jobs are not running in this server.', 503);
    return ctx.runner;
  };

  app.get('/', (c) => {
    const r = runner();
    return c.json({
      enabled: ctx.store.settings.agents.enabled,
      jobs: r.list().slice(0, 100),
      suggestions: r.suggestions(),
      budget: r.budget(),
      autoResearch: ctx.store.settings.agents.autoResearch,
      kinds: JOB_KINDS.map((k) => ({ kind: k, privacy: JOB_DEFS[k].privacy, tools: JOB_DEFS[k].tools, promptVersion: JOB_DEFS[k].promptVersion })),
    });
  });

  app.post('/', async (c) => {
    const body = await readJson(c, z.object({ kind: z.enum(JOB_KINDS), params: z.record(z.string(), z.unknown()).default({}) }));
    const job = runner().enqueue({ kind: body.kind, params: body.params, trigger: 'owner' });
    return c.json(job, 201);
  });

  app.post('/tick', async (c) => {
    await runner().tick();
    return c.json({ ok: true });
  });

  app.post('/:id/cancel', async (c) => c.json(await runner().cancel(c.req.param('id'))));
  app.post('/:id/rerun', (c) => c.json(runner().rerun(c.req.param('id')) ?? null));

  return app;
}
