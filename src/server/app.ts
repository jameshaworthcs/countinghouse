// Assemble the application: store, git, analytics, imports, auth, routes and static files.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { Analytics } from './analytics';
import { Auth, loadSessionSecret } from './auth';
import type { Config } from './config';
import type { AppContext } from './context';
import { GitCommitter } from './git';
import { InboxWatcher } from './ingest/inbox';
import { ImportService } from './ingest/service';
import { WorkArea } from './ingest/workarea';
import { runMigrations } from './migrations';
import { analyticsRoutes } from './routes/analytics';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { documentRoutes, importRoutes } from './routes/imports';
import { systemRoutes } from './routes/system';
import { authGate, csrfGuard, hostGuard, securityHeaders } from './security';
import { Store, StoreError, type ChangeEvent } from './store';

export interface CreateAppOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  /** Start the inbox watcher (off in tests). */
  inbox?: boolean;
}

export interface App {
  app: Hono;
  ctx: AppContext;
  close(): Promise<void>;
}

export async function createApp(config: Config, opts: CreateAppOptions): Promise<App> {
  const env = opts.env ?? process.env;
  const migrated = await runMigrations(config.dataDir);
  const store = await Store.open(config.dataDir, { watch: config.watch });
  const git = await GitCommitter.create(config.dataDir, () => store.settings.git.autoCommit);
  store.on('change', (e: ChangeEvent) => git.queue(e));
  if (migrated) await git.flush(`data: migrate format v${migrated.from} → v${migrated.to}`);
  if (store.created) await git.flush('data: initialise data directory');

  const analytics = new Analytics(store);
  const work = new WorkArea(config.workDir);
  const imports = new ImportService(store, config, work);
  await imports.init();

  const auth = new Auth({
    username: env.FINANCE_USERNAME,
    passwordHash: env.FINANCE_PASSWORD_HASH,
    secret: await loadSessionSecret(env, config.workDir),
  });

  let inbox: InboxWatcher | undefined;
  if (opts.inbox !== false && config.watch) {
    inbox = new InboxWatcher(config.inboxDir, imports);
    await inbox.start();
  }

  const ctx: AppContext = { config, store, analytics, imports, git, auth, inbox, version: opts.version };
  const app = new Hono();
  const secOpts = { allowedHosts: config.allowedHosts, production: config.production };

  app.use('*', securityHeaders(secOpts));
  app.use('*', hostGuard(secOpts));
  app.use('/api/*', csrfGuard());
  app.use('/api/*', authGate(auth));

  app.get('/api/health', (c) => c.json({ ok: true, version: opts.version }));
  app.route('/api/auth', authRoutes(ctx));
  app.route('/api/imports', importRoutes(ctx));
  app.route('/api/documents', documentRoutes(ctx));
  app.route('/api', dataRoutes(ctx));
  app.route('/api', analyticsRoutes(ctx));
  app.route('/api', systemRoutes(ctx));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built web app (production). In development Vite serves it instead.
  const indexFile = path.join(config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    const indexHtml = readFileSync(indexFile, 'utf8');
    const root = path.relative(process.cwd(), config.webDist) || '.';
    app.use(
      '/assets/*',
      serveStatic({
        root,
        onFound: (_p, c) => {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  } else {
    app.get('*', (c) =>
      c.html(
        '<!doctype html><meta charset="utf-8"><title>Finance</title><body style="font-family:system-ui;padding:2rem"><h1>Finance API is running</h1><p>The web app is not built. Run <code>npm run build</code> (or use <code>npm run dev</code> and open port 4751).</p></body>',
      ),
    );
  }

  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: (err).message || 'Internal error' }, 500);
  });

  return {
    app,
    ctx,
    async close() {
      inbox?.stop();
      store.stopWatching();
      await git.flush();
    },
  };
}
