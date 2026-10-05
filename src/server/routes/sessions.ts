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

  /**
   * Stop a running session (yours only, signed in: no token may). The engine is stopped, nothing it
   * would have produced is applied, its transcript is kept, and the audit log says who stopped it.
   * A job's session stops its job.
   */
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    const r = ctx.sessions.get(id);
    if (!r) throw new StoreError('No such session', 404);
    if (!ctx.sessions.running(id)) throw new StoreError('It is not running.', 409);
    ctx.sessions.cancel(id);
    if (r.kind === 'job' && r.jobId && ctx.runner?.get(r.jobId)?.status === 'running') await ctx.runner.cancel(r.jobId);
    return c.json({ stopped: true });
  });

  /** One of the files a session was given to read, as it was (kept gzipped beside its transcript). */
  app.get('/:id/inputs/:name{.+}', async (c) => {
    const name = c.req.param('name');
    const bytes = await ctx.sessions.input(c.req.param('id'), name);
    if (!bytes) throw new StoreError('Not kept: no such file, or it has been deleted with the transcript', 404);
    const file = name.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '_');
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...(c.req.query('download') ? { 'Content-Disposition': `attachment; filename="${file}"` } : {}),
    });
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
