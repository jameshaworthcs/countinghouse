// The local model's own work (src/shared/tasks.ts): suggesting categories for the payments the rules
// leave, and answering questions from the computed figures. Both are yours to start, signed in; no
// agent token can.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ask, listQuestions } from '../ask';
import { agentTokenOf, readJson, type AppContext } from '../context';
import { StoreError } from '../store';
import { leftUncategorised, suggestCategories, type SuggestResult } from '../suggest';

export function modelRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  let last: (SuggestResult & { at: string }) | { error: string; at: string } | undefined;
  let running = false;

  /** Only you start these, signed in: no agent token can. */
  const yours = (c: Context) => {
    if (agentTokenOf(c)) throw new StoreError('Only you can start this, signed in.', 403);
  };

  /** How many payment descriptions the rules leave, and the last run's outcome. */
  app.get('/suggest-categories', (c) => c.json({ waiting: leftUncategorised(ctx.store).length, running, last: last ?? null }));

  /** Start a run: the local model reads each description, and what it suggests becomes a proposal. */
  app.post('/suggest-categories', (c) => {
    yours(c);
    if (running) throw new StoreError('Categories are being suggested already.', 409);
    if (!ctx.config.inference) throw new StoreError('Suggesting categories runs on the local model service, which is not set up here.', 503);
    running = true;
    void suggestCategories(ctx.store, ctx.config, ctx.proposals, { sessions: ctx.sessions })
      .then((r) => (last = { ...r, at: new Date().toISOString() }))
      .catch((err: Error) => (last = { error: err.message, at: new Date().toISOString() }))
      .finally(() => (running = false));
    return c.json({ running: true }, 202);
  });

  app.get('/ask', (c) => c.json({ questions: listQuestions() }));

  app.post('/ask', async (c) => {
    yours(c);
    const body = await readJson(c, z.object({ question: z.string().min(1).max(1000) }));
    return c.json(ask(ctx.store, ctx.analytics, ctx.config, body.question, { sessions: ctx.sessions }), 202);
  });

  return app;
}
