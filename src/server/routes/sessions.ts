// The Claude sessions page: every session the app ran (and agents with your tokens, by their
// requests), one session in full, and its transcript (sessions.ts, sessionviews.ts).

import { Hono } from 'hono';
import type { SessionListResponse, TranscriptResponse } from '../../shared/sessions';
import type { AppContext } from '../context';
import { allSessions, sessionDetail } from '../sessionviews';
import { StoreError } from '../store';

export function sessionRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const { limits, workDir } = ctx.sessions;
    return c.json({
      sessions: await allSessions(ctx),
      retention: { days: limits.days, maxBytesPerSession: limits.maxBytes, maxBytesTotal: limits.totalBytes, bytes: ctx.sessions.bytes(), dir: workDir },
    } satisfies SessionListResponse);
  });

  /** How many sessions are running now, for the sidebar (cheap: the records are in memory). */
  app.get('/running', (c) => c.json({ running: ctx.sessions.list().filter((s) => s.status === 'running').length }));

  app.get('/:id', async (c) => {
    const detail = await sessionDetail(ctx, c.req.param('id'));
    if (!detail) throw new StoreError('No such session', 404);
    return c.json(detail);
  });

  /** The transcript's events from `from` on: a running session's page asks for what is new. */
  app.get('/:id/transcript', async (c) => {
    const from = Math.max(0, Number(c.req.query('from')) || 0);
    const t = await ctx.sessions.transcript(c.req.param('id'), from);
    if (!t) throw new StoreError('No transcript: this session ran before transcripts were kept, or outside the app', 404);
    return c.json({ events: t.events, from, total: t.total } satisfies TranscriptResponse);
  });

  return app;
}
