// Suggesting decisions for Set aside's payments to check (src/shared/tasks.ts, `suggest-earmarks`;
// docs/FORMULAS.md §21). Only when you ask, only with its switch on (Settings → Set aside), and only
// on the local model: the payments never leave this machine. Each payment to check goes to the
// model with its question, the pot's rules in words and your earlier decisions with their reasons;
// what it is sure enough of becomes one proposal of `decide_earmark_flow` changes, which you review.
// Nothing is decided until you apply it, and it never re-decides a payment you decided.

import { EFFECT_WORDS } from '../shared/earmarks';
import { descriptionKey } from '../shared/merchants';
import { formatMoney } from '../shared/money';
import type { EarmarkEffect, Provenance, Transaction } from '../shared/schema';
import { resolveTask, TASKS } from '../shared/tasks';
import type { Analytics } from './analytics';
import { EFFECTS_IN, EFFECTS_OUT } from './analytics/earmarks';
import { currentActor } from './audit';
import type { Config } from './config';
import { chat, InferenceFailed, InferenceUnavailable } from './inference';
import { ProposalProblems, type ProposalService } from './proposals';
import type { SessionLog, TranscriptSink } from './sessions';
import { StoreError, type Store } from './store';

export const EARMARK_SUGGEST_PROMPT_VERSION = 'suggest-earmarks-1';
/** Payments asked about in one run. */
export const MAX_EARMARK_SUGGEST = 25;

const SYSTEM = `You help decide what one payment did to a pot of money set aside inside a UK person's everyday bank accounts, for a private personal-finance app.
- The app could not tell from the data, and says why. It also says what it counts for now (its suggestion).
- Choose "as-suggested" when the suggestion fits, one effect for the whole payment when the evidence says so (the payment's reference, a matching earlier decision of the owner's, the pot's rules), or "leave" when it is the owner's own intention that decides (savings of their own or money put back, for example) and nothing shows which. A wrong decision is worse than none.
- reason: one short sentence the owner will read, saying what you went on. British English.`;

export interface EarmarkSuggestResult {
  asked: number;
  suggested: number;
  proposalId?: string;
  stopped?: string;
}

let running = false;

/** The payments to check that are worth asking about: undecided, not proposed already, in the data. */
export function toAsk(store: Store, analytics: Analytics, proposals: ProposalService): { pot: string; t: Transaction; question: string; suggestion?: { effect: EarmarkEffect; amount: number }[] }[] {
  const r = analytics.earmarks().result;
  const setup = store.earmarks;
  if (!r || !setup) return [];
  const proposed = new Set(proposals.list().pending.flatMap((v) => v.proposal.changes.flatMap((c) => (c.kind === 'decide_earmark_flow' ? [c.transaction] : []))));
  const out: ReturnType<typeof toAsk> = [];
  for (const c of r.toCheck) {
    if (c.kind === 'stale-decision') continue;
    for (const id of c.transactionIds) {
      const t = store.transaction(id);
      if (!t || setup.decisions[id] || proposed.has(id)) continue;
      const suggestion = c.suggestion?.find((s) => s.transactionId === id)?.parts;
      out.push({ pot: c.pot, t, question: c.question, ...(suggestion ? { suggestion } : {}) });
      if (out.length >= MAX_EARMARK_SUGGEST) return out;
    }
  }
  return out;
}

function prompt(store: Store, item: ReturnType<typeof toAsk>[number]): string {
  const setup = store.earmarks!;
  const pot = setup.pots.find((p) => p.id === item.pot)!;
  const t = item.t;
  const key = descriptionKey(t.description);
  const decisions = Object.entries(setup.decisions).map(([id, d]) => ({ d, t: store.transaction(id) }));
  const similar = decisions.filter((x) => x.t && x.t.accountId === t.accountId && descriptionKey(x.t.description) === key).slice(-5);
  const recent = decisions.sort((a, b) => b.d.decidedAt.localeCompare(a.d.decidedAt)).slice(0, 8);
  const line = (x: (typeof decisions)[number]) => `- ${x.d.seen.date}, ${formatMoney(x.d.seen.amount)}${x.t ? ` "${x.t.description}"` : ''}: ${x.d.parts.map((p) => `${EFFECT_WORDS[p.effect].toLowerCase()} ${formatMoney(p.amount)}`).join(', ')}. Reason: ${x.d.reason}`;
  return [
    `Pot: ${pot.name}${pot.purpose ? ` (${pot.purpose})` : ''}, counted from ${pot.start}.`,
    `Its rules, in order: ${pot.rules.map((r) => `${r.name} (${EFFECT_WORDS[r.effect].toLowerCase()})`).join('; ') || 'none'}.`,
    '',
    `Payment: "${t.description}", ${formatMoney(t.amount)} on ${t.date}, ${t.amount < 0 ? 'money out' : 'money in'}, in ${store.account(t.accountId)?.name ?? t.accountId}.`,
    `Why the app asks: ${item.question}`,
    item.suggestion ? `Counted for now: ${item.suggestion.map((p) => `${EFFECT_WORDS[p.effect].toLowerCase()} ${formatMoney(p.amount)}`).join(', ')}.` : '',
    '',
    similar.length ? `The owner's decisions for payments like it:\n${similar.map(line).join('\n')}` : 'The owner has decided no payment like it.',
    recent.length ? `The owner's latest decisions:\n${recent.map(line).join('\n')}` : '',
    '',
    `Effects: ${(t.amount < 0 ? EFFECTS_OUT : EFFECTS_IN).map((e) => `${e} = ${EFFECT_WORDS[e].toLowerCase()}`).join('; ')}.`,
  ]
    .filter((s, i, all) => s !== '' || all[i - 1] !== '')
    .join('\n');
}

/**
 * Ask the local model about each payment to check, and propose what it suggests with medium or high
 * confidence, as one proposal. One run at a time.
 */
export async function suggestEarmarks(store: Store, analytics: Analytics, config: Config, proposals: ProposalService, opts: { sessions?: SessionLog | undefined; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<EarmarkSuggestResult> {
  if (running) throw new StoreError('Decisions are being suggested already.', 409);
  if (!store.settings.agents.earmarkSuggest) throw new StoreError('Suggesting set-aside decisions is off: turn it on in Settings → Set aside.', 409);
  if (!store.earmarks) throw new StoreError('Nothing is set aside.', 404);
  if (!config.inference) throw new StoreError('Suggesting decisions runs on the local model service, which is not set up here (INFERENCE_BASE_URL and INFERENCE_API_KEY in .env).', 503);
  running = true;
  try {
    const items = toAsk(store, analytics, proposals);
    if (!items.length) return { asked: 0, suggested: 0 };
    const choice = resolveTask('suggest-earmarks', store.settings.models.tasks);
    const def = TASKS['suggest-earmarks'];
    const runId = `ems_${Date.now().toString(36)}`;
    const session = await opts.sessions?.start({
      kind: 'job',
      title: `Suggest set-aside decisions for ${items.length} payment${items.length === 1 ? '' : 's'}`,
      jobKind: 'suggest-earmarks',
      jobId: runId,
      engine: 'inference',
      model: choice.model,
      thinking: choice.thinking,
      promptVersion: EARMARK_SUGGEST_PROMPT_VERSION,
      tools: [],
      privacy: 'personal',
      startedBy: { actor: currentActor(), reason: 'Suggest decisions for Set aside’s payments to check' },
    });
    const run = async (transcript: TranscriptSink | undefined): Promise<EarmarkSuggestResult> => {
      const changes: { key: string; kind: 'decide_earmark_flow'; why: string; pot: string; transaction: string; parts: { effect: EarmarkEffect; amount: number }[]; was: null }[] = [];
      let provenance: Provenance = { setBy: 'agent', engine: 'inference', promptVersion: EARMARK_SUGGEST_PROMPT_VERSION, jobId: runId };
      let asked = 0;
      let stopped: string | undefined;
      for (const item of items) {
        const allowed = item.t.amount < 0 ? EFFECTS_OUT : EFFECTS_IN;
        const schema = {
          type: 'object',
          additionalProperties: false,
          required: ['choice', 'reason', 'confidence'],
          properties: { choice: { type: 'string', enum: [...(item.suggestion ? ['as-suggested'] : []), ...allowed, 'leave'] }, reason: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
        };
        try {
          const text = prompt(store, item);
          const res = await chat(config.inference, {
            alias: choice.model,
            system: SYSTEM,
            content: [{ type: 'text', text }],
            describe: { model: choice.model, systemPrompt: SYSTEM, prompt: text, schema },
            schema: { name: 'decision', schema },
            thinking: choice.thinking,
            maxTokens: def.maxTokens,
            priority: def.priority,
            runMinutes: def.runMinutes,
            waitUpToMs: 10 * 60_000,
            signal: opts.signal,
            transcript,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          });
          asked++;
          provenance = { ...provenance, model: res.provenance.modelId ?? choice.model, inference: res.provenance };
          const out = res.output as { choice: string; reason: string; confidence: string };
          if (out.confidence === 'low' || out.choice === 'leave') continue;
          const parts = out.choice === 'as-suggested' ? item.suggestion : allowed.includes(out.choice as EarmarkEffect) ? [{ effect: out.choice as EarmarkEffect, amount: Math.abs(item.t.amount) }] : undefined;
          if (!parts?.length) continue;
          changes.push({ key: `c${changes.length + 1}`, kind: 'decide_earmark_flow', why: `${out.reason.trim().slice(0, 400)} (the local model, ${choice.model}, with ${out.confidence} confidence)`, pot: item.pot, transaction: item.t.id, parts, was: null });
        } catch (err) {
          if (err instanceof InferenceUnavailable || err instanceof InferenceFailed) {
            stopped = err.message;
            break;
          }
          throw err;
        }
      }
      if (!changes.length) return { asked, suggested: 0, ...(stopped ? { stopped } : {}) };
      const input = {
        title: `Set-aside decisions for ${changes.length} payment${changes.length === 1 ? '' : 's'} to check`,
        summary: `The local model read each of Set aside's payments to check (${asked} asked about), with the pot's rules and your earlier decisions, and suggests a decision for those it was sure enough of. It is a reading of the evidence, not a fact: check each before you apply it.`,
        changes,
      };
      let proposal: { proposal: { id: string } };
      try {
        proposal = await proposals.create(input, provenance);
      } catch (err) {
        // A payment decided meanwhile no longer fits: leave it out and propose the rest.
        if (!(err instanceof ProposalProblems) || !err.problems.length) throw err;
        const bad = new Set(err.problems.map((p) => p.key));
        const rest = changes.filter((c) => !bad.has(c.key));
        if (!rest.length) return { asked, suggested: 0, ...(stopped ? { stopped } : {}) };
        proposal = await proposals.create({ ...input, title: `Set-aside decisions for ${rest.length} payment${rest.length === 1 ? '' : 's'} to check`, changes: rest }, provenance);
      }
      transcript?.write({ type: 'finance.proposed', proposalId: proposal.proposal.id, changes: changes.length });
      return { asked, suggested: changes.length, proposalId: proposal.proposal.id, ...(stopped ? { stopped } : {}) };
    };
    return session ? await session.run(run, opts.signal) : await run(undefined);
  } finally {
    running = false;
  }
}
