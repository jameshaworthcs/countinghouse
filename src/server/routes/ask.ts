// Ask (src/server/ask.ts): conversations, each on a page of its own; follow-ups, Stop, Delete
// (which hides), and "This is wrong". Only you ask, signed in: no agent token can. Tokens can read
// them, like everything else, and one with the records scope can mark an answer wrong.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ASK_MODEL_OPTIONS, type AskListResponse, type AskServiceState } from '../../shared/ask';
import { suggestions } from '../ask';
import { agentTokenOf, readJson, type AppContext } from '../context';
import { inferenceHealth } from '../inference';
import { resolveClaudeBin } from '../ingest/claude-cli';
import { StoreError } from '../store';

const Question = z.object({
  question: z.string().min(1).max(2000),
  model: z.enum(ASK_MODEL_OPTIONS.map((o) => o.id) as [string, ...string[]]).optional(),
  defaults: z.object({ from: z.string().optional(), to: z.string().optional(), accounts: z.array(z.string()).max(50).optional() }).optional(),
});

export function askRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const ask = () => {
    if (!ctx.ask) throw new StoreError('Ask is not available here.', 503);
    return ctx.ask;
  };
  const yours = (c: Context) => {
    if (agentTokenOf(c)) throw new StoreError('Only you can ask, signed in.', 403);
  };
  // The local model's state, for the expected wait (asked at most every 15 seconds).
  let health: { at: number; value: AskServiceState | null } | undefined;
  const service = async (): Promise<AskServiceState | null> => {
    if (!ctx.config.inference) return null;
    if (health && Date.now() - health.at < 15_000) return health.value;
    const h = await inferenceHealth(ctx.config.inference, { timeoutMs: 3000 });
    const alias = h?.aliases['fast-chat'];
    const lease = h?.gpu?.lease;
    let value: AskServiceState | null = null;
    if (!h) value = { state: 'unreachable', note: 'The local model service is not answering: a question to it waits, and gives up after 10 minutes.' };
    else if (alias) {
      const leased = lease && lease.state !== 'none' && lease.until ? lease.until : undefined;
      const ahead = (alias.queued ?? 0) + (alias.in_flight ?? 0);
      const note = leased
        ? `Its GPU is lent to another program until ${leased.slice(11, 16)}: a question waits until then.`
        : alias.state === 'ready'
          ? ahead
            ? `Ready; ${ahead} request${ahead === 1 ? '' : 's'} of other work in hand (a question does not queue behind them).`
            : 'Ready.'
          : alias.state === 'cold' || alias.state === 'loading'
            ? 'Its model loads first: the first answer takes a minute or two longer.'
            : `Its state is ${alias.state}.`;
      value = { state: alias.state, ...(alias.queued !== undefined ? { queued: alias.queued } : {}), ...(alias.in_flight !== undefined ? { inFlight: alias.in_flight } : {}), ...(leased ? { leasedUntil: leased } : {}), note };
    }
    health = { at: Date.now(), value };
    return value;
  };

  app.get('/', async (c) => {
    const a = ask();
    const claude = Boolean(await resolveClaudeBin());
    return c.json({
      conversations: a.list(),
      suggestions: suggestions(ctx.store, ctx.analytics),
      models: ASK_MODEL_OPTIONS.map((o) => {
        const available = o.engine === 'inference' ? Boolean(ctx.config.inference) : claude;
        return { id: o.id, label: o.label, available, ...(available ? {} : { why: o.engine === 'inference' ? 'The local model service is not set up here.' : 'The claude CLI is not installed or not logged in here.' }) };
      }),
      defaultModel: a.defaultModel(),
      maxToolCalls: ctx.store.settings.ask.maxToolCalls,
      busy: a.busy(),
      service: await service(),
      retentionDays: ctx.sessions.limits.days,
    } satisfies AskListResponse);
  });

  /** The answers marked wrong: the evaluation set a new prompt version must do at least as well on. */
  app.get('/feedback', (c) => c.json({ items: ask().feedbackSet() }));

  /** Start a conversation. */
  app.post('/', async (c) => {
    yours(c);
    const body = await readJson(c, Question);
    return c.json(await ask().start({ question: body.question, model: body.model as never, defaults: body.defaults }), 202);
  });

  app.get('/:id', (c) => {
    const conv = ask().get(c.req.param('id'));
    if (!conv) throw new StoreError('No such conversation: it may have passed the retention period.', 404);
    return c.json(conv);
  });

  /** A follow-up: it waits for any question being answered. */
  app.post('/:id/turns', async (c) => {
    yours(c);
    const body = await readJson(c, Question);
    return c.json(await ask().ask(c.req.param('id'), { question: body.question, model: body.model as never, defaults: body.defaults }), 202);
  });

  /** Stop the question being answered (or take back one waiting: `turnId`). */
  app.post('/:id/cancel', async (c) => {
    yours(c);
    const body = await readJson(c, z.object({ turnId: z.string().optional() }));
    return c.json(await ask().cancel(c.req.param('id'), body.turnId));
  });

  /** "This is wrong": you, or an agent token with the records scope (it changes no data; who said so is kept). */
  app.post('/:id/turns/:turnId/feedback', async (c) => {
    const body = await readJson(c, z.object({ wrong: z.boolean(), note: z.string().max(2000).default('') }));
    return c.json(await ask().feedback(c.req.param('id'), c.req.param('turnId'), body));
  });

  /** Delete: off the list. It is kept until the retention period ends (the owner's choice). */
  app.delete('/:id', async (c) => {
    yours(c);
    await ask().hide(c.req.param('id'));
    return c.json({ hidden: true });
  });

  return app;
}
