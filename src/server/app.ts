// Assemble the application: store, git, analytics, imports, auth, routes and static files.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import { JobRunner } from './agents/jobs';
import { Analytics } from './analytics';
import { Auth, loadSessionSecret } from './auth';
import { refreshPlaces } from './enrich';
import type { Config } from './config';
import type { AppContext } from './context';
import { GitCommitter } from './git';
import { InboxWatcher } from './ingest/inbox';
import { ImportService } from './ingest/service';
import { WorkArea } from './ingest/workarea';
import { runMigrations } from './migrations';
import { LOGIN_PATH, OidcClient, oidcSettingsFromEnv } from './oidc';
import { analyticsRoutes } from './routes/analytics';
import { authRoutes, safeNext } from './routes/auth';
import { dataRoutes } from './routes/data';
import { documentRoutes, importRoutes } from './routes/imports';
import { jobRoutes } from './routes/jobs';
import { recordRoutes } from './routes/records';
import { receiptRoutes } from './routes/receipts';
import { systemRoutes } from './routes/system';
import { tokenRoutes } from './routes/tokens';
import { AgentTokens } from './tokens';
import { authGate, csrfGuard, hostGuard, isPageRequest, securityHeaders } from './security';
import type { ImportRecord } from '../shared/schema';
import { Store, StoreError, type ChangeEvent } from './store';

export interface CreateAppOptions {
  version: string;
  /** Short hash of the code commit being served (shown by /api/health, used to verify deploys). */
  commit?: string | undefined;
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
  // In production a missing data directory is a misconfiguration (a wrong FINANCE_DATA_DIR), not a
  // request to start an empty one: refuse rather than quietly create and commit a blank dataset.
  if (config.production && !config.initData && !existsSync(path.join(config.dataDir, 'meta.json'))) {
    throw new Error(`No data directory at ${config.dataDir}. Check FINANCE_DATA_DIR, or set FINANCE_INIT_DATA=1 to create a new one.`);
  }
  const migrated = await runMigrations(config.dataDir);
  const store = await Store.open(config.dataDir, { watch: config.watch });
  const git = await GitCommitter.create(config.dataDir, () => store.settings.git.autoCommit, 2500, config.dataBranch);
  store.on('change', (e: ChangeEvent) => git.queue(e));
  if (migrated) await git.flush(`data: migrate format v${migrated.from} → v${migrated.to}`);
  if (store.created) await git.flush('data: initialise data directory');
  // Enrichment that follows the code: tidy addresses are worked out again from the merchant fields.
  try {
    if (await refreshPlaces(store)) await git.flush();
  } catch (err) {
    console.warn(`[data] merchant addresses were not tidied: ${(err as Error).message}`);
  }

  const analytics = new Analytics(store);
  const work = new WorkArea(config.workDir);
  const imports = new ImportService(store, config, work);
  await imports.init();

  let oidcSettings: ReturnType<typeof oidcSettingsFromEnv>;
  try {
    oidcSettings = oidcSettingsFromEnv(env, config.allowedHosts);
  } catch (err) {
    store.stopWatching();
    throw err;
  }
  const oidc = oidcSettings ? new OidcClient(oidcSettings) : undefined;
  const auth = new Auth({
    username: env.FINANCE_USERNAME,
    passwordHash: env.FINANCE_PASSWORD_HASH,
    oidcIdentity: oidcSettings ? [oidcSettings.issuer, oidcSettings.clientId, ...oidcSettings.allowedEmails].join(' ') : undefined,
    secret: await loadSessionSecret(env, config.workDir),
  });
  // Local access without a login is for throwaway data only (demo-data, temporary directories).
  // Real data, tracked in git, always needs a login, even on loopback: other local accounts (the
  // isolated service users on P360) must not be able to read it from a development server.
  if (git.tracked && !auth.configured) {
    store.stopWatching();
    throw new Error(`${config.dataDir} holds real data (it is tracked in git), so a login is required. Run \`npm run set-password\`, or use the demo data (npm run dev / npm run demo).`);
  }

  // Agent jobs start on their own only in a watching (serving) instance over real data (tracked in
  // git), never in tests, scripts, the demo or a throwaway copy: they spend the owner's Claude plan.
  const runner = new JobRunner(store, analytics, config, { autoRun: config.watch && opts.inbox !== false && git.tracked });
  await runner.init();
  imports.on('update', (r: ImportRecord) => {
    // A document filed as adding nothing new has nothing for the analyst to look at.
    if (r.status === 'committed' && !r.result?.nothingNew) runner.onImportCommitted(r.id);
  });

  let inbox: InboxWatcher | undefined;
  if (opts.inbox !== false && config.watch) {
    inbox = new InboxWatcher(config.inboxDir, imports);
    await inbox.start();
  }

  const tokens = AgentTokens.forWorkDir(config.workDir);
  await tokens.load();

  const ctx: AppContext = { config, store, analytics, imports, git, auth, oidc, inbox, jobs: runner, runner, tokens, version: opts.version };
  const app = new Hono();
  const secOpts = { allowedHosts: config.allowedHosts, production: config.production };

  app.use('*', securityHeaders(secOpts));
  app.use('*', hostGuard(secOpts));
  app.use('/api/*', csrfGuard());
  app.use('/api/*', authGate(auth, tokens));
  // With jemedia-auth, opening any page signed out goes straight to it. (The SPA does the same for
  // the pages Vite serves in development.) /login stays reachable: it explains failed sign-ins.
  if (oidc) {
    app.use('*', async (c: Context, next) => {
      if (!isPageRequest(c) || c.req.path === '/login' || auth.sessionFrom(c)) return next();
      const url = new URL(c.req.url);
      return c.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`, 302);
    });
  }

  app.get('/api/health', (c) => c.json({ ok: true, version: opts.version, ...(opts.commit ? { commit: opts.commit } : {}) }));
  app.route('/api/auth', authRoutes(ctx));
  app.route('/api/imports', importRoutes(ctx));
  app.route('/api/jobs', jobRoutes(ctx));
  app.route('/api/tokens', tokenRoutes(ctx));
  app.route('/api/documents', documentRoutes(ctx));
  app.route('/api', dataRoutes(ctx));
  app.route('/api', recordRoutes(ctx));
  app.route('/api', receiptRoutes(ctx));
  app.route('/api', analyticsRoutes(ctx));
  app.route('/api', systemRoutes(ctx));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built web app (production). In development Vite serves it instead.
  const indexFile = path.join(config.webDist, 'index.html');
  if (existsSync(indexFile)) {
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
      // Read per request, like `/` above: a rebuild replaces the hashed assets, and a copy held
      // since start-up would point every other route at files that no longer exist.
      return c.html(readFileSync(indexFile, 'utf8'));
    });
  } else {
    app.get('*', (c) =>
      c.html(
        '<!doctype html><meta charset="utf-8"><title>Finance</title><body style="font-family:system-ui;padding:2rem"><h1>Finance API is running</h1><p>The web app is not built. Run <code>npm run build</code> (or use <code>npm run dev</code> and open port 4761).</p></body>',
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
      runner.stop();
      inbox?.stop();
      store.stopWatching();
      await git.flush();
    },
  };
}
