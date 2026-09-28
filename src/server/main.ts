// Start the server: `npm run dev` (with Vite on :4751) or `npm start` (built UI on :4750).

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

const instance = await createApp(config, { version });
const { app, ctx } = instance;

const server = serve({ fetch: app.fetch.bind(app), hostname: config.host, port: config.port }, (info) => {
  const url = `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`;
  console.log(`finance ${version} listening on ${url}`);
  console.log(`  data:   ${config.dataDir}${ctx.git.enabled ? ' (git auto-commit on)' : ' (not committed to git)'}`);
  console.log(`  inbox:  ${config.inboxDir}`);
  console.log(`  login:  ${passwordConfigured ? `required (user ${process.env.FINANCE_USERNAME})` : 'not configured: only direct local access is allowed'}`);
  if (config.allowedHosts.length) console.log(`  hosts:  ${config.allowedHosts.join(', ')}`);
  if (ctx.store.issues.length) console.log(`  ⚠ ${ctx.store.issues.length} data issue(s); see Settings → Data health`);
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
