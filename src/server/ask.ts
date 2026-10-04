// Asking a question about your money (src/shared/tasks.ts, `ask`; DECISIONS 2026-10-04). The model
// is given the figures the app works out by fixed rules (the digest the analysis jobs read:
// agents/digest.ts), never raw documents, and told to answer from them rather than add things up
// itself: on the local model's tests, sums over rows were where answers went wrong. The answer is an
// inference, kept only in memory and shown as one; it never changes a computed figure.
//
// By default the local model answers, thinking, at interactive priority (it does not queue behind
// readings, and they pause while you ask); a question still takes minutes.

import { z } from 'zod';
import { today } from '../shared/dates';
import type { InferenceProvenance } from '../shared/schema';
import { resolveTask } from '../shared/tasks';
import { buildDigest } from './agents/digest';
import { runModel } from './agents/run-model';
import type { Analytics } from './analytics';
import { currentActor } from './audit';
import type { Config } from './config';
import { resolveClaudeBin } from './ingest/claude-cli';
import type { SessionLog } from './sessions';
import { StoreError, type Store } from './store';

export const ASK_PROMPT_VERSION = 'ask-1';
const KEPT = 20;

const AnswerOut = z.object({
  answer: z.string(),
  /** The digest's figures the answer rests on, as it gives them. */
  figures: z.array(z.object({ label: z.string(), value: z.string(), from: z.string() })).max(20),
  confidence: z.enum(['high', 'medium', 'low']),
  caveats: z.array(z.string()).max(8),
  /** The figures do not say: the answer says what would. */
  cannotAnswer: z.boolean(),
});
export type Answer = z.infer<typeof AnswerOut>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'figures', 'confidence', 'caveats', 'cannotAnswer'],
  properties: {
    answer: { type: 'string' },
    figures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'from'], properties: { label: { type: 'string' }, value: { type: 'string' }, from: { type: 'string' } } } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    caveats: { type: 'array', items: { type: 'string' } },
    cannotAnswer: { type: 'boolean' },
  },
};

const SYSTEM = `You answer the owner's question about their money, for a private UK personal-finance app, from the figures it gives you (the digest, JSON). The app computed them by fixed rules from the owner's data.
- Answer from the digest's figures. Quote them as it gives them: do not add up rows or work out totals the digest does not give, and never invent a figure.
- When the digest does not hold what the question needs, set cannotAnswer and say what is missing (a month not covered, an account with no data).
- figures: each figure the answer rests on, with the digest field it is from ("months[2025-08].spending").
- Plain British English, short. Money as £1,234.56. Amounts in the digest are signed: money in positive, money out negative.
- caveats: what limits the answer (months with incomplete data, estimated balances). This is not advice.`;

export interface Question {
  id: string;
  question: string;
  askedAt: string;
  status: 'running' | 'answered' | 'failed';
  answer?: Answer;
  error?: string;
  engine?: string;
  model?: string;
  inference?: InferenceProvenance;
  finishedAt?: string;
}

const questions: Question[] = [];

export function listQuestions(): Question[] {
  return questions;
}

/** Ask: the question is answered in the background; poll `listQuestions` for the answer. */
export function ask(store: Store, analytics: Analytics, config: Config, text: string, opts: { sessions?: SessionLog | undefined; fetch?: typeof fetch } = {}): Question {
  const question = text.trim();
  if (question.length < 3) throw new StoreError('Ask a question.', 400);
  if (questions.some((q) => q.status === 'running')) throw new StoreError('A question is being answered already: wait for it.', 409);
  const choice = resolveTask('ask', store.settings.models.tasks);
  if (choice.engine === 'inference' && !config.inference) throw new StoreError('Questions are answered by the local model service, which is not set up here (INFERENCE_BASE_URL and INFERENCE_API_KEY in .env), or by Claude: see Settings → Models.', 503);
  const q: Question = { id: `ask_${Date.now().toString(36)}`, question: question.slice(0, 1000), askedAt: new Date().toISOString(), status: 'running' };
  questions.unshift(q);
  questions.splice(KEPT);
  const actor = currentActor();
  void (async () => {
    try {
      const digest = buildDigest(store, analytics);
      const prompt = [`Today is ${today()}. The owner asks:`, '"""', q.question, '"""', '', 'The digest (the app’s computed figures):', JSON.stringify(digest)].join('\n');
      const bin = choice.engine === 'inference' && !choice.fallback ? null : await resolveClaudeBin();
      const res = await runModel({
        task: 'ask',
        choice,
        bin,
        inference: config.inference,
        cwd: config.workDir,
        prompt,
        systemPrompt: SYSTEM,
        schema: SCHEMA,
        tools: [],
        timeoutMs: 10 * 60_000,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        session: opts.sessions
          ? (s) => opts.sessions!.start({ kind: 'job', title: `Answer: ${q.question.slice(0, 80)}`, jobKind: 'ask', jobId: q.id, ...s, promptVersion: ASK_PROMPT_VERSION, privacy: 'personal', startedBy: { actor, reason: 'You asked a question' } })
          : undefined,
      });
      Object.assign(q, { status: 'answered', answer: AnswerOut.parse(res.output), engine: res.engine, model: res.model, ...(res.inference ? { inference: res.inference } : {}), finishedAt: new Date().toISOString() });
    } catch (err) {
      Object.assign(q, { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date().toISOString() });
    }
  })();
  return q;
}
