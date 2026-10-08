// Call the app's API with an agent token, for Claude Code sessions and scripts on P360
// (docs/SELF_HOSTING.md, "Agent access"). The token never appears in the output.
//
//   npm run -s api -- GET /imports
//   npm run -s api -- POST /imports/imp_20260929_220730_9e18/refresh
//   npm run -s api -- PUT /imports/imp_…/draft @draft.json
//   npm run -s api -- POST /records '{"provenance":{…},"records":[…]}'
//
// The token comes from FINANCE_TOKEN or ~/.config/finance/token; the server from FINANCE_API_URL
// (default: the live service on this machine, http://127.0.0.1:4750). Paths may leave out "/api".
// In a Claude Code session, its id goes with each request (scripts/agent-api.ts).

import { readFile } from 'node:fs/promises';
import { agentRequest, agentToken, TOKEN_FILE } from './agent-api';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function main(): Promise<number> {
  const [methodArg, pathArg, bodyArg] = process.argv.slice(2);
  const method = methodArg?.toUpperCase();
  if (!method || !METHODS.has(method) || !pathArg) {
    console.error('Usage: npm run -s api -- <GET|POST|PUT|PATCH|DELETE> <path> [json | @file.json]');
    return 2;
  }
  const token = await agentToken();
  if (!token) {
    console.error(`No token: set FINANCE_TOKEN, or save one from Settings → Agent access to ${TOKEN_FILE} (chmod 600).`);
    return 2;
  }
  let body: string | undefined;
  if (bodyArg !== undefined) body = bodyArg.startsWith('@') ? await readFile(bodyArg.slice(1), 'utf8') : bodyArg;
  if (body !== undefined) JSON.parse(body); // fail here, not on the server, on a malformed body
  const res = await agentRequest(token, method, pathArg, body);
  let out = res.text;
  try {
    out = JSON.stringify(JSON.parse(res.text), null, 2);
  } catch {
    // not JSON: print as is
  }
  (res.ok ? process.stdout : process.stderr).write(out.endsWith('\n') ? out : `${out}\n`);
  if (!res.ok) console.error(`HTTP ${res.status} ${method} ${res.url}`);
  return res.ok ? 0 : 1;
}

// exitCode, not exit(): a large answer written to a pipe must drain before the process ends.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  },
);
