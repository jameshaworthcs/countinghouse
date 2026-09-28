import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, type AppContext } from '../context';
import { clientAddress, isDirectLocal, isHttps } from '../security';

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/status', (c) => {
    const session = ctx.auth.sessionFrom(c);
    return c.json({
      configured: ctx.auth.configured,
      user: session?.user ?? null,
      // Without configured credentials only direct local access works.
      localAccess: !ctx.auth.configured && isDirectLocal(c),
    });
  });

  app.post('/login', async (c) => {
    const body = await readJson(c, z.object({ username: z.string().max(200), password: z.string().max(500) }));
    const result = await ctx.auth.login(body.username.trim(), body.password, clientAddress(c));
    if (result === 'ok') {
      ctx.auth.setSessionCookie(c, body.username.trim(), isHttps(c));
      return c.json({ ok: true, user: body.username.trim() });
    }
    // A small constant delay blunts guessing and timing differences.
    await new Promise((r) => setTimeout(r, 400));
    if (result === 'throttled') return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    if (result === 'not-configured') return c.json({ error: 'Login is not configured on this server.' }, 403);
    return c.json({ error: 'Wrong username or password.' }, 401);
  });

  app.post('/logout', (c) => {
    ctx.auth.clearSessionCookie(c, isHttps(c));
    return c.json({ ok: true });
  });

  return app;
}
