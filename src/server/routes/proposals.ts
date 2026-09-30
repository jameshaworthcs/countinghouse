// Proposed fixes (src/server/proposals.ts): agents propose with a token; you check, apply or dismiss
// them signed in. No token can apply or dismiss one (tokens.ts lists what a token may do).

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ProposalInputSchema, type Provenance } from '../../shared/schema';
import { agentTokenOf as tokenOf, readJson, type AppContext } from '../context';
import { StoreError } from '../store';

const LeaveOut = z.object({ leaveOut: z.array(z.string().max(40)).max(60).default([]) });
const Dismiss = z.object({ reason: z.string().max(1000).optional() });

/** The name the owner gave the token ("Claude Code on P360"): where the agent ran. */
const agentName = (c: Context) => String(c.get('user' as never) ?? '').replace(/^agent:/, '');

export function proposalRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const svc = ctx.proposals;

  app.get('/', (c) => c.json(svc.list()));

  /** An agent proposes a fix (with `dryRun`, it only checks it). */
  app.post('/', async (c) => {
    if (!tokenOf(c)) throw new StoreError('Proposals come from agents. Make the change yourself instead.', 403);
    const body = await readJson(c, ProposalInputSchema);
    const provenance: Provenance = { setBy: 'agent', ...(body.provenance ?? {}), session: body.provenance?.session ?? agentName(c) };
    const view = await svc.create(body, provenance, { dryRun: body.dryRun === true });
    return c.json(view, body.dryRun ? 200 : 201);
  });

  app.get('/:id', async (c) => c.json(await svc.get(c.req.param('id'))));

  /** What applying it would do with some changes left out. */
  app.post('/:id/check', async (c) => {
    const { leaveOut } = await readJson(c, LeaveOut);
    return c.json(svc.check(c.req.param('id'), leaveOut));
  });

  app.post('/:id/apply', async (c) => {
    if (tokenOf(c)) throw new StoreError('Only the owner applies a proposal.', 403);
    const { leaveOut } = await readJson(c, LeaveOut);
    const view = await svc.apply(c.req.param('id'), leaveOut);
    // Commit now, so the data's history has the proposal as one commit of its own.
    await ctx.git.flush();
    return c.json(view);
  });

  app.post('/:id/dismiss', async (c) => {
    if (tokenOf(c)) throw new StoreError('Only the owner dismisses a proposal. An agent withdraws its own with DELETE.', 403);
    const { reason } = await readJson(c, Dismiss);
    return c.json(await svc.dismiss(c.req.param('id'), reason));
  });

  /** An agent withdraws a proposal the owner has not decided yet. */
  app.delete('/:id', async (c) => {
    if (!tokenOf(c)) throw new StoreError('Dismiss it instead: that keeps a record of it.', 405);
    await svc.withdraw(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
