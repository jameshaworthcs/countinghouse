// Assemble the application: store, git, analytics, imports, auth, routes and static files.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import { JobRunner, type JobRecord } from './agents/jobs';
import { Analytics } from './analytics';
import { AuditLog, auditRequests, DeviceNames, runAs } from './audit';
import { Auth, hashPassword, loadSessionSecret } from './auth';
import { codespaceRefusal, codespaceRequested, newDemoLogin, type DemoLogin } from './codespace';
import { categoriseInvestmentRows, refreshPlaces } from './enrich';
import type { Config } from './config';
import type { AppContext } from './context';
import { GitCommitter } from './git';
import { InboxWatcher } from './ingest/inbox';
import { ImportService } from './ingest/service';
import { WorkArea } from './ingest/workarea';
import { recordInstrumentsFromHoldings } from './instruments';
import { runMigrations } from './migrations';
import { dataInCodeRepository } from './datarepo';
import { LOGIN_PATH, OidcClient, oidcSettingsFromEnv } from './oidc';
import { ProposalProblems, ProposalService } from './proposals';
import { SessionLog, sessionLimitsFromEnv } from './sessions';
import { analyticsRoutes } from './routes/analytics';
import { authRoutes, safeNext } from './routes/auth';
import { dataRoutes } from './routes/data';
import { documentRoutes, importRoutes } from './routes/imports';
import { jobRoutes } from './routes/jobs';
import { proposalRoutes } from './routes/proposals';
import { recordRoutes } from './routes/records';
import { receiptRoutes } from './routes/receipts';
import { sessionRoutes } from './routes/sessions';
import { auditRoutes } from './routes/audit';
import { systemRoutes } from './routes/system';
import { modelRoutes } from './routes/models';
import { askRoutes } from './routes/ask';
import { AskService } from './ask';
import { tokenRoutes } from './routes/tokens';
import { AgentTokens } from './tokens';
import { authGate, csrfGuard, hostGuard, isPageRequest, securityHeaders } from './security';
import type { AuditActor } from '../shared/audit';
import type { ImportRecord, Proposal } from '../shared/schema';
import { Store, StoreError, type ChangeEvent } from './store';

export interface CreateAppOptions {
  version: string;
  /** Short hash of the code commit being served (shown by /api/health, used to verify deploys). */
  commit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Start the inbox watcher (off in tests). */
  inbox?: boolean;
  /** Queue agent jobs without running them (tests: nothing a test starts can reach Claude). */
  pauseJobs?: boolean;
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
  // The demo in a codespace makes its own throwaway login (codespace.ts). Refused over real data
  // before anything else, so nothing (a migration, start-up's tidying) has touched it.
  let demoLogin: DemoLogin | undefined;
  if (codespaceRequested(env)) {
    const tracked = (await GitCommitter.create(config.dataDir, () => false)).tracked;
    const why = codespaceRefusal({ dataDir: config.dataDir, exists: existsSync(path.join(config.dataDir, 'meta.json')), tracked, env });
    if (why) throw new Error(why);
    demoLogin = newDemoLogin();
  }
  // Who did what, beside git's history: open first, so start-up's own changes are in it too.
  const audit = AuditLog.open(path.join(config.workDir, 'audit'));
  const startUp: AuditActor = { type: 'app', task: 'start-up' };
  audit.record({ category: 'app', action: 'app.start', actor: startUp, summary: `Started finance ${opts.version}${opts.commit ? ` (${opts.commit})` : ''}`, details: { version: opts.version, ...(opts.commit ? { commit: opts.commit } : {}), pid: process.pid, dataDir: config.dataDir } });
  const migrated = await runMigrations(config.dataDir);
  if (migrated) audit.record({ category: 'data', action: 'data.migrate', actor: startUp, summary: `Migrated the data from format v${migrated.from} to v${migrated.to}`, details: { from: migrated.from, to: migrated.to } });
  const store = await Store.open(config.dataDir, { watch: config.watch });
  const git = await GitCommitter.create(config.dataDir, () => store.settings.git.autoCommit, 2500, config.dataBranch);
  // Data tracked in the code's own repository (or a worktree of it), the layout before code and data
  // were split: its commits would land in the code's history, which is shared. In production that
  // is refused outright; in development the data is left as it is, and nothing is committed.
  if (dataInCodeRepository(config.dataDir, config.projectRoot)) {
    const why = `${config.dataDir} is tracked in the code's own repository, which is shared. Move your data to a data repository of its own (npm run init-data; docs/SELF_HOSTING.md, "The layout").`;
    if (config.production) {
      store.stopWatching();
      throw new Error(why);
    }
    git.refuse(`Data changes are not being committed: ${why}`);
  }
  store.on('change', (e: ChangeEvent) => {
    // The audit entry first, so the commit can name it.
    e.auditSeq = audit.record({ category: 'data', action: 'data.change', summary: e.message, paths: e.paths, diff: e.diff, targets: e.diff?.items?.map((i) => i.id) ?? [] }).seq;
    git.queue(e);
  });
  store.on('external', (paths: string[]) => audit.record({ category: 'data', action: 'data.external', actor: { type: 'outside' }, requestId: undefined, summary: `Files in the data changed outside the app (a hand edit, git or a script); reloaded`, paths }));
  git.onCommit = (c) => audit.record({ category: 'data', action: 'git.commit', actor: { type: 'app', task: 'git' }, summary: `Committed ${c.hash}: ${c.subject}`, details: { hash: c.hash, subject: c.subject, changes: c.auditSeqs } });
  await runAs(startUp, async () => {
    if (migrated) await git.flush(`data: migrate format v${migrated.from} → v${migrated.to}`);
    if (store.created) await git.flush('data: initialise data directory');
    // Enrichment that follows the code: tidy addresses are worked out again from the merchant fields.
    try {
      if (await refreshPlaces(store)) await git.flush();
    } catch (err) {
      console.warn(`[data] merchant addresses were not tidied: ${(err as Error).message}`);
    }
    // …and investment rows nothing categorised get a category once the app knows the provider's words.
    try {
      if (await categoriseInvestmentRows(store)) await git.flush();
    } catch (err) {
      console.warn(`[data] investment rows were not categorised: ${(err as Error).message}`);
    }
    // …and funds in the latest holdings that have no instrument get one, whether or not agents are on.
    try {
      if (await recordInstrumentsFromHoldings(store)) await git.flush();
    } catch (err) {
      console.warn(`[data] funds were not recorded as instruments: ${(err as Error).message}`);
    }
  });

  const analytics = new Analytics(store);
  const work = new WorkArea(config.workDir);
  // Every Claude session the app runs, with its transcript, in the work area (sessions.ts).
  const sessions = new SessionLog(config.workDir, sessionLimitsFromEnv(env), audit);
  // Each session records the state of data/ it ran against, so its inputs can be rebuilt.
  sessions.dataState = async () => ({ ...(await git.head()), format: store.meta.version });
  await sessions.init();
  const imports = new ImportService(store, config, work, sessions);
  await imports.init();
  // Fixes agents propose (an agent with a token, or a job here) wait in the work area for the owner.
  const proposals = ProposalService.forWorkDir(store, config.workDir, () => git.flush());
  await proposals.init();

  let oidcSettings: ReturnType<typeof oidcSettingsFromEnv>;
  try {
    oidcSettings = oidcSettingsFromEnv(env, config.allowedHosts);
  } catch (err) {
    store.stopWatching();
    throw err;
  }
  const oidc = oidcSettings ? new OidcClient(oidcSettings) : undefined;
  const auth = new Auth({
    username: demoLogin?.username ?? env.FINANCE_USERNAME,
    passwordHash: demoLogin ? await hashPassword(demoLogin.password) : env.FINANCE_PASSWORD_HASH,
    oidcIdentity: oidcSettings ? [oidcSettings.issuer, oidcSettings.clientId, ...oidcSettings.allowedEmails].join(' ') : undefined,
    secret: await loadSessionSecret(env, config.workDir),
  });
  // Local access without a login is for throwaway data only (demo-data, temporary directories).
  // Real data, tracked in git, always needs a login, even on loopback: other local accounts (the
  // isolated service users on a shared host) must not be able to read it from a development server.
  if (git.tracked && !auth.configured) {
    store.stopWatching();
    throw new Error(`${config.dataDir} holds real data (it is tracked in git), so a login is required. Run \`npm run set-password\`, or use the demo data (npm run dev / npm run demo).`);
  }

  // A proposal the data comes to say all of (an import got there first) closes as already done: one
  // that did while the app was stopped now, and from then on whenever the data changes.
  try {
    await runAs(startUp, () => proposals.closeDone());
  } catch (err) {
    console.warn(`[proposals] could not close the ones already done: ${(err as Error).message}`);
  }
  proposals.watch();

  // Agent jobs start on their own only in a watching (serving) instance over real data (tracked in
  // git), never in tests, scripts, the demo or a throwaway copy: they spend the owner's Claude plan.
  const runner = new JobRunner(store, analytics, config, { autoRun: config.watch && opts.inbox !== false && git.tracked, ...(opts.pauseJobs ? { paused: true } : {}), proposals, sessions });
  await runner.init();
  auditLifecycles(audit, imports, runner, proposals);
  imports.on('update', (r: ImportRecord) => {
    // A document filed as adding nothing new has nothing for the analyst to look at.
    if (r.status === 'committed' && !r.result?.nothingNew) runner.onImportCommitted(r.id);
    if (r.status === 'committed') runner.onImportFiled(r.id);
  });

  let inbox: InboxWatcher | undefined;
  if (opts.inbox !== false && config.watch) {
    inbox = new InboxWatcher(config.inboxDir, imports);
    await inbox.start();
  }

  const tokens = AgentTokens.forWorkDir(config.workDir);
  await tokens.load();
  const devices = config.auditDevices ? new DeviceNames() : undefined;

  // Ask's conversations, in the work area (ask.ts).
  const ask = new AskService(store, analytics, config, sessions, audit);
  await ask.init();

  const ctx: AppContext = { config, store, analytics, imports, proposals, git, auth, oidc, inbox, jobs: runner, runner, tokens, audit, sessions, ask, devices, demoLogin, version: opts.version };
  const app = new Hono();
  const secOpts = { allowedHosts: config.allowedHosts, production: config.production };

  app.use('*', securityHeaders(secOpts));
  app.use('*', hostGuard(secOpts));
  // Before the guards, so what they refuse is recorded too.
  app.use('/api/*', auditRequests(audit, { auth, tokens, devices }));
  app.use('/api/*', csrfGuard({ codespace: Boolean(demoLogin) }));
  app.use('/api/*', authGate(auth, tokens));
  // With OIDC, opening any page signed out goes straight to the provider. (The SPA does the same for
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
  app.route('/api/proposals', proposalRoutes(ctx));
  app.route('/api/jobs', jobRoutes(ctx));
  app.route('/api/tokens', tokenRoutes(ctx));
  app.route('/api/audit', auditRoutes(ctx));
  app.route('/api/sessions', sessionRoutes(ctx));
  app.route('/api/ask', askRoutes(ctx));
  app.route('/api/documents', documentRoutes(ctx));
  app.route('/api', dataRoutes(ctx));
  app.route('/api', recordRoutes(ctx));
  app.route('/api', receiptRoutes(ctx));
  app.route('/api', analyticsRoutes(ctx));
  app.route('/api', systemRoutes(ctx));
  app.route('/api', modelRoutes(ctx));
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
        '<!doctype html><meta charset="utf-8"><title>Counting House</title><body style="font-family:system-ui;padding:2rem"><h1>Counting House API is running</h1><p>The web app is not built. Run <code>npm run build</code> (or use <code>npm run dev</code> and open port 4761).</p></body>',
      ),
    );
  }

  app.onError((err, c) => {
    if (err instanceof ProposalProblems) return c.json({ error: err.message, problems: err.problems }, err.status as 400);
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
      ask.stop();
      sessions.stop();
      proposals.stop();
      inbox?.stop();
      store.stopWatching();
      await git.flush();
      audit.record({ category: 'app', action: 'app.stop', actor: { type: 'app', task: 'shut-down' }, summary: 'Stopped' });
      audit.close();
    },
  };
}

const IMPORT_WORDS: Record<ImportRecord['status'], string> = {
  queued: 'queued',
  processing: 'being read',
  needs_mapping: 'needs its columns mapped',
  review: 'ready for review',
  committed: 'committed',
  failed: 'failed',
  discarded: 'discarded',
};

/** Imports, jobs and proposals live in the work area: each change of state is an audit entry. */
function auditLifecycles(audit: AuditLog, imports: ImportService, runner: JobRunner, proposals: ProposalService): void {
  const importWas = new Map(imports.listPending().map((r) => [r.id, r.status]));
  imports.on('update', (r: ImportRecord) => {
    const was = importWas.get(r.id);
    if (was === r.status) return;
    importWas.set(r.id, r.status);
    if (r.status === 'committed' || r.status === 'discarded') importWas.delete(r.id);
    const res = r.result;
    const error = r.status === 'failed' ? r.extraction.error : undefined;
    const nothingNew = r.status === 'committed' && res?.nothingNew;
    audit.record({
      category: 'import',
      action: `import.${r.status}`,
      outcome: r.status === 'failed' ? 'failed' : 'ok',
      summary: `Import ${r.document.fileName}: ${nothingNew ? 'filed, nothing new' : IMPORT_WORDS[r.status]}${error ? ` (${error.slice(0, 200)})` : ''}`,
      targets: [r.id, r.document.id, ...(res?.accountIds ?? [])],
      details: {
        importId: r.id,
        fileName: r.document.fileName,
        size: r.document.size,
        sha256: r.document.sha256,
        origin: r.origin,
        ...(was ? { from: was } : {}),
        ...(r.extraction.engine ? { engine: r.extraction.engine } : {}),
        ...(r.extraction.model ? { model: r.extraction.model } : {}),
        ...(error ? { error } : {}),
        ...(res ? { result: { accounts: res.accountIds, transactionsAdded: res.transactionsAdded, transactionsSkipped: res.transactionsSkipped, balancesAdded: res.balancesAdded, holdingsAdded: res.holdingsAdded, figuresAdded: res.figuresAdded, ...(res.nothingNew ? { nothingNew: res.nothingNew } : {}) } } : {}),
      },
    });
  });

  const jobWas = new Map(runner.list().map((j) => [j.id, j.status]));
  runner.on('update', (j: JobRecord) => {
    if (jobWas.get(j.id) === j.status) return;
    jobWas.set(j.id, j.status);
    const cost = j.costUsd !== undefined ? `, $${j.costUsd.toFixed(2)}` : '';
    const words = { queued: 'queued', running: 'started', succeeded: `finished${cost}`, failed: `failed${cost}`, cancelled: 'cancelled' }[j.status];
    audit.record({
      category: 'job',
      action: `job.${j.status}`,
      outcome: j.status === 'failed' ? 'failed' : 'ok',
      summary: `Agent job ${j.kind}: ${words}${j.status === 'succeeded' && j.summary ? `: ${j.summary}` : ''}${j.error ? ` (${j.error.slice(0, 200)})` : ''}`,
      targets: [j.id, ...(j.written ?? []).map((w) => w.id)],
      details: {
        jobId: j.id,
        kind: j.kind,
        label: j.label,
        trigger: j.trigger,
        privacy: j.privacy,
        promptVersion: j.promptVersion,
        params: j.params,
        ...(j.model ? { model: j.model } : {}),
        ...(j.costUsd !== undefined ? { costUsd: j.costUsd } : {}),
        ...(j.durationMs !== undefined ? { durationMs: j.durationMs } : {}),
        ...(j.written?.length ? { written: j.written } : {}),
        ...(j.error ? { error: j.error } : {}),
      },
    });
  });

  proposals.on('update', (p: Proposal) => {
    // An account changed or an agreement added: the drafts waiting are drafted again to match.
    const applied = new Set(p.applied ?? []);
    if (p.status === 'applied' && p.changes.some((c) => applied.has(c.key) && ['link_accounts', 'set_account_dates', 'move_balance', 'add_agreement'].includes(c.kind))) {
      void imports.redraftWaiting().catch((err: Error) => console.warn(`[imports] drafts waiting could not be drafted again: ${err.message}`));
    }
    const words = { pending: 'proposed', applied: `applied (${p.applied?.length ?? 0} of ${p.changes.length} changes)`, dismissed: 'dismissed', superseded: 'closed: your data already says it' }[p.status];
    audit.record({
      category: 'proposal',
      action: `proposal.${p.status}`,
      summary: `Proposal “${p.title}”: ${words}`,
      targets: [p.id],
      details: { proposalId: p.id, title: p.title, changes: p.changes.length, provenance: p.provenance, ...(p.applied ? { applied: p.applied } : {}) },
    });
  });
}
