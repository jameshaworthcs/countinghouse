// Agent access tokens: yours to make, see and revoke (tokens.ts). No token can reach these routes.

import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, type AppContext } from '../context';
import { StoreError } from '../store';
import { TOKEN_SCOPE_LABELS, TOKEN_SCOPES } from '../tokens';

export function tokenRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/', async (c) =>
    c.json({
      tokens: ctx.tokens.list(),
      uses: await ctx.tokens.recentUses(30),
      scopes: TOKEN_SCOPES.map((id) => ({ id, label: TOKEN_SCOPE_LABELS[id] })),
    }),
  );

  /** The token is in this answer and nowhere else: only its hash is kept. */
  app.post('/', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.enum(TOKEN_SCOPES)).default([]), days: z.number().int().min(1).max(365).default(90) }));
    const made = await ctx.tokens.create(body);
    console.log(`[tokens] created ${made.view.id} "${made.view.name}" (${made.view.scopes.join(', ')}), expires ${made.view.expiresAt}`);
    ctx.audit.record({ category: 'token', action: 'token.create', summary: `Made the token “${made.view.name}” (${made.view.scopes.join(', ')}), until ${made.view.expiresAt.slice(0, 10)}`, targets: [made.view.id], details: { tokenId: made.view.id, name: made.view.name, scopes: made.view.scopes, expiresAt: made.view.expiresAt } });
    return c.json(made, 201);
  });

  app.post('/:id/revoke', async (c) => {
    if (!(await ctx.tokens.revoke(c.req.param('id')))) throw new StoreError('No such token, or it is already revoked.', 404);
    console.log(`[tokens] revoked ${c.req.param('id')}`);
    const t = ctx.tokens.list().find((x) => x.id === c.req.param('id'));
    ctx.audit.record({ category: 'token', action: 'token.revoke', summary: `Revoked the token “${t?.name ?? c.req.param('id')}”`, targets: [c.req.param('id')], details: { tokenId: c.req.param('id'), ...(t ? { name: t.name, scopes: t.scopes } : {}) } });
    return c.json({ ok: true });
  });

  return app;
}
