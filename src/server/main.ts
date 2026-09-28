// Start the server. The live service runs this from its own worktree on 127.0.0.1:4750 (see
// docs/DEPLOY.md); from a development checkout `npm run dev` serves the API on :4760 (Vite on :4761)
// and `npm run demo` serves the built UI on :4770.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { isLoopbackHost, loadConfig, loadDotEnv, PROJECT_ROOT } from './config';

loadDotEnv();
const config = loadConfig();
const version = (JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const passwordConfigured = Boolean(process.env.FINANCE_USERNAME && process.env.FINANCE_PASSWORD_HASH);
if (!isLoopbackHost(config.host) && !passwordConfigured) {
  console.error(`Refusing to listen on ${config.host} without a login. Run \`npm run set-password\` first, or keep HOST=127.0.0.1.`);
  process.exit(1);
}

let commit: string | undefined;
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
} catch {
  commit = undefined;
}

let instance: Awaited<ReturnType<typeof createApp>>;
try {
  instance = await createApp(config, { version, commit });
} catch (err) {
  console.error(`finance: ${(err as Error).message}`);
  process.exit(1);
}
const { app, ctx } = instance;

const server = serve({ fetch: app.fetch.bind(app), hostname: config.host, port: config.port }, (info) => {
  const url = `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`;
  console.log(`finance ${version}${commit ? ` (${commit})` : ''} listening on ${url}`);
  console.log(`  data:   ${config.dataDir}${ctx.git.enabled ? ' (git auto-commit on)' : ' (not committed to git)'}`);
  console.log(`  inbox:  ${config.inboxDir}`);
  console.log(`  login:  ${passwordConfigured ? `required (user ${process.env.FINANCE_USERNAME})` : 'not configured: only direct local access is allowed'}`);
  if (config.allowedHosts.length) console.log(`  hosts:  ${config.allowedHosts.join(', ')}`);
  if (ctx.store.issues.length) console.log(`  ⚠ ${ctx.store.issues.length} data issue(s); see Settings → Data health`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. The live service uses 4750, \`npm run dev\` 4760 and \`npm run demo\` 4770; set PORT to use another.`);
  } else console.error(`finance: ${err.message}`);
  void instance.close().finally(() => process.exit(1));
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: flushing pending commits and stopping…`);
  server.close();
  await instance.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
