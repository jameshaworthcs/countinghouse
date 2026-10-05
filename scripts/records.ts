// The validated write path for agents working outside the app (a Claude Code session): the same
// schemas and checks as in-app jobs (src/server/records.ts). See docs/AGENTS.md.
//
//   npm run records -- keys                     assumption keys, units, scopes and fallbacks
//   npm run records -- status                   what exists and what is stale (no amounts)
//   npm run records -- check <batch.json>       validate a batch without writing
//   npm run records -- write <batch.json>       validate, write and commit it
//
// write goes through the app (POST /api/records with your agent token: scripts/agent-api.ts), so
// the audit log knows which token and which Claude Code session wrote it. Only when the app cannot
// be reached, or there is no token, does it write the files itself, and it says so; the audit log
// then sees the change as made outside the app. In a Claude Code session, the batch's
// provenance.session names it (claude-code:<CLAUDE_CODE_SESSION_ID>) unless it names one already.
//
// A batch is { "provenance": { "setBy": "agent", "model": "...", "session": "claude-code" },
//              "records": [ { "type": "assumption" | "research" | "insight" | "context" | "instrument", "record": {...} } ],
//              "supersede": false }
// FINANCE_DATA_DIR picks the data directory (default: data/). The running app notices the change.

import { readFile } from 'node:fs/promises';
import { ASSUMPTION_DEFS, AssumptionSet, formatAssumptionValue } from '../src/shared/assumptions';
import { today } from '../src/shared/dates';
import { loadConfig, loadDotEnv } from '../src/server/config';
import { GitCommitter } from '../src/server/git';
import { applyRecords, checkRecords, RecordBatchSchema, RecordsError } from '../src/server/records';
import { Store, type ChangeEvent } from '../src/server/store';
import { agentRequest, agentSession, agentToken, TOKEN_FILE } from './agent-api';

loadDotEnv();
const config = loadConfig();
const [command, file] = process.argv.slice(2);

async function readBatch(path: string | undefined) {
  if (!path) throw new Error('Give the batch file: npm run records -- check <batch.json>');
  const parsed = RecordBatchSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) throw new RecordsError(parsed.error.issues.map((i) => `${i.path.join('.') || 'batch'}: ${i.message}`));
  if (parsed.data.provenance.setBy === 'owner') throw new Error('Owner records are made in the app, not by agents.');
  // The Claude Code session that wrote it, unless the batch names a session of its own.
  const session = agentSession();
  if (session && (!parsed.data.provenance.session || parsed.data.provenance.session === 'claude-code')) parsed.data.provenance.session = `claude-code:${session}`;
  return parsed.data;
}

async function main() {
  if (command === 'keys') {
    const set = new AssumptionSet([], today());
    for (const d of ASSUMPTION_DEFS) {
      const f = set.fallback(d);
      console.log(`${d.key.padEnd(26)} ${d.unit.padEnd(11)} scopes: ${d.scopes.join(', ')}`);
      console.log(`${''.padEnd(26)} ${d.label}: ${d.description}`);
      console.log(`${''.padEnd(26)} fallback ${formatAssumptionValue(d.key, f.value)}${f.range ? ` (${formatAssumptionValue(d.key, f.range.low)}–${formatAssumptionValue(d.key, f.range.high)})` : ''}${d.fallback.byAssetClass ? ', by asset class' : ''}${d.fallback.byAccountType ? ', by account type' : ''}`);
    }
    return;
  }
  const store = await Store.open(config.dataDir);
  try {
    if (command === 'status') {
      const set = new AssumptionSet(store.assumptions, today());
      console.log(`${config.dataDir}: format v${store.meta.version}`);
      console.log(`instruments: ${store.instruments.length}, research: ${store.research.length}, assumption versions: ${store.assumptions.length}, insights: ${store.insights.filter((i) => i.status === 'active').length} active, context: ${store.context.filter((c) => c.status === 'active').length}`);
      for (const d of ASSUMPTION_DEFS.filter((x) => x.scopes.includes('global'))) {
        const r = set.resolve(d.key);
        console.log(`  ${d.key.padEnd(26)} ${formatAssumptionValue(d.key, r.value).padEnd(10)} ${r.source}${r.stale ? ' (stale)' : ''}`);
      }
      for (const i of store.instruments) {
        const facts = store.research.filter((r) => r.kind === 'instrument.facts' && r.subject.instrumentId === i.id).at(-1);
        console.log(`  instrument ${i.id}: ${i.name}${i.isin ? ` (${i.isin})` : ''}: ${facts ? `researched ${facts.createdAt.slice(0, 10)}` : 'not researched'}`);
      }
      return;
    }
    if (command === 'check') {
      const batch = await readBatch(file);
      const problems = checkRecords(store, batch);
      if (problems.length) throw new RecordsError(problems);
      console.log(`valid: ${batch.records.length} record(s)`);
      return;
    }
    if (command === 'write') {
      const batch = await readBatch(file);
      const problems = checkRecords(store, batch);
      if (problems.length) throw new RecordsError(problems);
      // Through the app, as the token: audited with who wrote it.
      const token = await agentToken();
      // Another data directory (the demo, a copy) is not what the app serves: written here.
      const elsewhere = Boolean(process.env.FINANCE_DATA_DIR) && !process.env.FINANCE_API_URL;
      let why: string;
      if (elsewhere) why = `FINANCE_DATA_DIR names ${config.dataDir}, not what the app at the default address serves (set FINANCE_API_URL to write through an app serving it)`;
      else if (token) {
        try {
          const res = await agentRequest(token, 'POST', '/records', JSON.stringify(batch));
          if (!res.ok) {
            let error = res.text;
            try {
              const said = (JSON.parse(res.text) as { error?: unknown }).error;
              if (typeof said === 'string') error = said;
            } catch {
              // as it came
            }
            throw new Error(`The app refused it (HTTP ${res.status}): ${error}`);
          }
          const out = JSON.parse(res.text) as { written: { type: string; id: string }[]; skipped: { type: string; reason: string }[] };
          for (const w of out.written) console.log(`written ${w.type} ${w.id} (through the app)`);
          for (const s of out.skipped) console.log(`skipped ${s.type}: ${s.reason}`);
          return;
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          why = `the app at ${process.env.FINANCE_API_URL ?? 'http://127.0.0.1:4750'} could not be reached (${(err.cause as Error | undefined)?.message ?? err.message})`;
        }
      } else why = `there is no agent token (FINANCE_TOKEN, or ${TOKEN_FILE})`;
      console.error(`Writing the files directly: ${why}. The audit log will see this change as made outside the app.`);
      const git = await GitCommitter.create(config.dataDir, () => store.settings.git.autoCommit, 0, config.dataBranch);
      store.on('change', (e: ChangeEvent) => git.queue(e));
      const res = await applyRecords(store, batch);
      await git.flush();
      if (git.lastError) console.error(`warning: ${git.lastError}`);
      for (const w of res.written) console.log(`written ${w.type} ${w.id}`);
      for (const s of res.skipped) console.log(`skipped ${s.type}: ${s.reason}`);
      return;
    }
    console.error('Usage: npm run records -- keys | status | check <batch.json> | write <batch.json>');
    process.exitCode = 1;
  } finally {
    store.stopWatching();
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof RecordsError) {
    console.error('Rejected:');
    for (const p of err.problems) console.error(`  - ${p}`);
  } else console.error((err as Error).message);
  process.exit(1);
}
