// System status, git, and a server-sent event stream that tells the browser when data changes.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SystemResponse } from '../../shared/api';
import type { ImportRecord } from '../../shared/schema';
import type { AppContext } from '../context';
import { detectEngines, pickEngine } from '../ingest/engines';
import { FORMAT_VERSION } from '../store';

export function systemRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/system', async (c) => {
    const { engines } = await detectEngines({ apiKey: ctx.config.anthropicApiKey, force: c.req.query('refresh') === '1' });
    const git = await ctx.git.status();
    const body: SystemResponse = {
      version: ctx.version,
      dataDir: ctx.config.dataDir,
      inboxDir: ctx.config.inboxDir,
      workDir: ctx.config.workDir,
      formatVersion: FORMAT_VERSION,
      engines,
      selectedEngine: pickEngine(ctx.store.settings.extraction.engine, engines),
      git: { ...git, ...(ctx.git.lastError ? { lastError: ctx.git.lastError } : {}) },
      inbox: { dir: ctx.config.inboxDir, ...(ctx.inbox?.lastError ? { lastError: ctx.inbox.lastError } : {}) },
      auth: { configured: ctx.auth.configured, method: ctx.auth.method, user: ctx.auth.sessionFrom(c)?.user ?? null },
      counts: {
        accounts: ctx.store.accounts.length,
        transactions: ctx.store.transactionCount(),
        balances: ctx.store.balances().length,
        imports: ctx.store.imports.length,
        figures: ctx.store.figures.length,
      },
    };
    return c.json(body);
  });

  app.get('/git/log', async (c) => c.json(await ctx.git.log(Number(c.req.query('limit') ?? 50))));

  app.post('/git/commit', async (c) => {
    await ctx.git.flush('data: manual commit');
    return c.json(await ctx.git.status());
  });

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (!closed) void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      const onData = () => send('data', { version: ctx.store.version });
      const onImport = (r: ImportRecord) => send('import', { id: r.id, status: r.status });
      const onJob = (j: { id: string; status: string }) => send('job', { id: j.id, status: j.status });
      const onProposal = (p: { id: string; status: string }) => send('proposal', { id: p.id, status: p.status });
      const onSession = (s: { id: string; status: string; transcript: { events: number } }) => send('session', { id: s.id, status: s.status, events: s.transcript.events });
      ctx.store.on('change', onData);
      ctx.store.on('reload', onData);
      ctx.imports.on('update', onImport);
      ctx.runner?.on('update', onJob);
      ctx.proposals.on('update', onProposal);
      ctx.sessions.on('update', onSession);
      stream.onAbort(() => {
        closed = true;
        ctx.store.off('change', onData);
        ctx.store.off('reload', onData);
        ctx.imports.off('update', onImport);
        ctx.runner?.off('update', onJob);
        ctx.proposals.off('update', onProposal);
        ctx.sessions.off('update', onSession);
      });
      send('hello', { version: ctx.store.version });
      while (!closed) {
        await stream.sleep(25_000);
        send('ping', { t: Date.now() });
      }
    }),
  );

  return app;
}
