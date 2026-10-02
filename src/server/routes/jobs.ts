// Agent jobs: what is queued, running, finished or stale; start, cancel and rerun.

import { Hono } from 'hono';
import { z } from 'zod';
import { JOB_DEFS, JOB_KINDS } from '../agents/kinds';
import { agentTokenOf, readJson, type AppContext } from '../context';
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

  // A job an agent's token starts waits for the background budget, and is refused while agents are
  // off in Settings: only you can start one then.
  const AGENTS_OFF = 'Agents are turned off in Settings, so an agent cannot start a job.';
  const LABELS_OFF = 'Naming imports with the agent is off: turn it on in Settings → Agents.';

  app.post('/', async (c) => {
    const body = await readJson(c, z.object({ kind: z.enum(JOB_KINDS), params: z.record(z.string(), z.unknown()).default({}) }));
    const before = runner().pending(body.kind, body.params);
    const job = runner().enqueue({ kind: body.kind, params: body.params, trigger: agentTokenOf(c) ? 'agent' : 'owner' });
    if (!job) throw new StoreError(body.kind === 'label-imports' ? LABELS_OFF : AGENTS_OFF, 409);
    // The same job was queued or running already: that one is the answer, and nothing new starts.
    if (job.id === before?.id) return c.json({ ...job, existing: true }, 200);
    return c.json(job, 201);
  });

  app.post('/tick', async (c) => {
    await runner().tick();
    return c.json({ ok: true });
  });

  app.post('/:id/cancel', async (c) => c.json(await runner().cancel(c.req.param('id'))));
  app.post('/:id/rerun', (c) => {
    const agent = Boolean(agentTokenOf(c));
    const job = runner().rerun(c.req.param('id'), agent ? 'agent' : 'owner');
    if (!job && runner().get(c.req.param('id'))?.kind === 'label-imports') throw new StoreError(LABELS_OFF, 409);
    if (!job && agent) throw new StoreError(AGENTS_OFF, 409);
    return c.json(job ?? null);
  });

  return app;
}
