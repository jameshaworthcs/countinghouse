// The gate for a new Ask prompt version (docs/AGENTS.md; DECISIONS 2026-10-05): ask again, on the
// current prompt, the questions whose answers were marked wrong, and show the old answer, why it was
// wrong and the new one, with which figures the app found in its tools' results.
//
//   npm run ask:eval                         every answer marked wrong (GET /api/ask/feedback)
//   npm run ask:eval -- conv_…               the questions of these conversations
//   npm run ask:eval -- --model local-quick  another model (default: Settings → Models' choice)
//
// It reads the conversations through the live API with your agent token (scripts/agent-api.ts),
// and answers over a copy of this checkout's data/ (what the live app serves; its documents left
// out), in a throwaway directory deleted afterwards: data/ itself, the live app, its conversations
// and its sessions are never touched. It runs the local model (or Claude,
// if picked): tell anyone else using the GPU first. Output stays in the terminal and the work area
// (`.work/ask-eval/`), never in git: the answers are about your money.

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ASK_MODEL_OPTIONS, ASK_PROMPT_VERSION, type AskConversation, type AskFeedbackItem, type AskModelId } from '../src/shared/ask';
import { Analytics } from '../src/server/analytics';
import { AskService } from '../src/server/ask';
import { loadConfig, loadDotEnv } from '../src/server/config';
import { SessionLog } from '../src/server/sessions';
import { Store } from '../src/server/store';
import { agentRequest, agentToken, TOKEN_FILE } from './agent-api';

loadDotEnv();

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const modelAt = args.indexOf('--model');
  const model = modelAt >= 0 ? (args[modelAt + 1] as AskModelId) : undefined;
  if (model && !ASK_MODEL_OPTIONS.some((o) => o.id === model)) throw new Error(`Unknown model ${model}: ${ASK_MODEL_OPTIONS.map((o) => o.id).join(', ')}`);
  const ids = args.filter((a, i) => a.startsWith('conv_') && args[i - 1] !== '--model');
  const token = await agentToken();
  if (!token) throw new Error(`No token: set FINANCE_TOKEN, or save one to ${TOKEN_FILE}.`);
  const get = async <T>(p: string): Promise<T> => {
    const res = await agentRequest(token, 'GET', p);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${res.text.slice(0, 300)}`);
    return JSON.parse(res.text) as T;
  };
  // What to ask: the conversations named, else every answer marked wrong.
  const items: { question: string; was?: string | undefined; why?: string | undefined; promptVersion: string; from: string }[] = [];
  if (ids.length) {
    for (const id of ids) {
      const c = await get<AskConversation>(`/ask/${id}`);
      for (const t of c.turns) items.push({ question: t.question, was: t.answer?.answer, why: t.feedback?.note, promptVersion: t.promptVersion, from: `${c.id} ${t.id}` });
    }
  } else {
    for (const f of (await get<{ items: AskFeedbackItem[] }>('/ask/feedback')).items) items.push({ question: f.question, was: f.answer, why: f.note, promptVersion: f.promptVersion, from: `${f.conversationId} ${f.turnId}` });
  }
  if (!items.length) {
    console.log('Nothing to ask: no answer is marked wrong.');
    return 0;
  }
  const config = loadConfig();
  // A copy of the data: a Store opened on data/ itself could write to it (start-up upkeep).
  const scratch = await mkdtemp(path.join(config.workDir, '..', 'ask-eval-'));
  const dataCopy = path.join(scratch, 'data');
  await cp(config.dataDir, dataCopy, { recursive: true, filter: (src) => path.relative(config.dataDir, src).split(path.sep)[0] !== 'documents' });
  const store = await Store.open(dataCopy);
  const workDir = path.join(scratch, 'work');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const sessions = new SessionLog(workDir);
  await sessions.init({ sweep: false });
  const ask = new AskService(store, new Analytics(store), { ...config, workDir }, sessions);
  await ask.init({ sweep: false });
  const results: unknown[] = [];
  try {
    for (const item of items) {
      console.log(`\n━━ ${item.question}\n   (${item.from}, asked on ${item.promptVersion})`);
      if (item.was) console.log(`   Was: ${item.was.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (item.why) console.log(`   Marked wrong: ${item.why}`);
      const started = Date.now();
      const c = await ask.start({ question: item.question, model });
      let t = c.turns[0]!;
      while (t.status === 'queued' || t.status === 'running') {
        await new Promise((r) => setTimeout(r, 2000));
        t = ask.get(c.id)!.turns[0]!;
      }
      console.log(`   Now (${ASK_PROMPT_VERSION}, ${t.model.id}, ${Math.round((Date.now() - started) / 1000)} s, ${t.status}):`);
      for (const s of t.steps) console.log(`     ${s.n}. ${s.tool} ${JSON.stringify(s.args)} → ${s.summary ?? `failed: ${s.error}`}`);
      if (t.answer) {
        console.log(`   ${t.answer.answer.replace(/\n+/g, '\n   ')}`);
        for (const f of t.answer.figures) console.log(`     ${f.computed ? 'app   ' : 'MODEL '} ${f.label}: ${f.value}${f.step ? ` (step ${f.step})` : ''}`);
        console.log(`   confidence ${t.answer.confidence}${t.answer.modelConfidence ? ` (the model said ${t.answer.modelConfidence})` : ''}; ${t.answer.caveats.join(' ')}`);
      } else console.log(`   ${t.error}`);
      results.push({ ...item, now: { status: t.status, steps: t.steps.map(({ said: _s, resultText: _r, ...s }) => s), answer: t.answer, error: t.error } });
    }
  } finally {
    ask.stop();
    sessions.stop();
    store.stopWatching();
  }
  // Only the results are kept; the copy of the data goes.
  await rm(dataCopy, { recursive: true, force: true });
  const out = path.join(config.workDir, '..', 'ask-eval');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}_${ASK_PROMPT_VERSION}.json`);
  await writeFile(file, JSON.stringify(results, null, 1), { mode: 0o600 });
  console.log(`\nKept in ${file} (the sessions in ${workDir}; the copy of the data deleted). Judge each: at least as good as before?`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  },
);
