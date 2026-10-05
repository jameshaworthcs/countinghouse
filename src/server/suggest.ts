// Suggesting categories for the payments your rules leave (src/shared/tasks.ts, `suggest-categories`;
// DECISIONS 2026-10-04). The categoriser (src/shared/categorise.ts) decides first: your rules,
// transfers between your accounts, the merchant list, the bank's category. What it leaves without a
// category goes to the local model, one payment description at a time (it matched 20 of 22
// merchants in the service's tests, but only 9 of 18 transfers between your own accounts, which is
// why the rules go first), and what it suggests becomes one proposal you review: nothing is
// categorised until you apply it. It runs only on the local model: the payments never leave this
// machine.

import type { Provenance, Transaction } from '../shared/schema';
import { balanceModeOf } from '../shared/accounts';
import { CategoryIndex } from '../shared/categories';
import { descriptionKey } from '../shared/merchants';
import { resolveTask, TASKS } from '../shared/tasks';
import { currentActor } from './audit';
import { paidInto, personParties } from './analytics/queue';
import type { Config } from './config';
import { chat, InferenceFailed, InferenceUnavailable } from './inference';
import { ProposalProblems, type ProposalService } from './proposals';
import type { SessionLog, TranscriptSink } from './sessions';
import { StoreError, type Store } from './store';

export const SUGGEST_PROMPT_VERSION = 'suggest-categories-1';
/** Descriptions asked about in one run (each takes a few seconds), newest first. */
export const MAX_SUGGEST = 60;

/** Payments the categoriser left without a category, that you have not categorised, grouped by what they say. */
export function leftUncategorised(store: Store, limit = MAX_SUGGEST): { key: string; rows: Transaction[] }[] {
  const groups = new Map<string, Transaction[]>();
  // Payments with people, and cash and cheques paid in, are yours to decide (To categorise →
  // People and cash), and a valued account's moves are not payments: none goes to the model.
  const people = personParties(store);
  const cash = paidInto(store);
  const market = new Set(store.accounts.filter((a) => balanceModeOf(a) === 'market').map((a) => a.id));
  const rows = store
    .transactions()
    .filter((t) => !t.category && t.categorisedBy !== 'user' && !t.transferGroup && !t.splits?.length && !people.has(t.id) && !cash.has(t.id) && !market.has(t.accountId))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const t of rows) {
    // Money in and money out under one description are different things (a refund, a purchase).
    const key = `${t.amount < 0 ? 'out' : 'in'}|${t.accountId}|${descriptionKey(t.payee ?? t.description)}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else if (groups.size < limit) groups.set(key, [t]);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, rows }));
}

const SYSTEM = `You categorise one payment from a UK bank account for a private personal-finance app.
- Choose the category it belongs in from the list, by what the description says: the shop, service or payee.
- Use null when the description does not say what it is (a person's name, a reference, a bank code), or when you are unsure. A wrong category is worse than none.
- A payment between the owner's own accounts is a transfer only when the description says so; otherwise null.
- Answer with the category id only, and how sure you are.`;

function prompt(t: Transaction, count: number, accountType: string | undefined, categories: { id: string; name: string; group?: string | undefined; kind: string }[]): string {
  const dir = t.amount < 0 ? 'money out' : 'money in';
  const fit = categories.filter((c) => (t.amount < 0 ? c.kind !== 'income' : c.kind !== 'expense'));
  return [
    `Payment: "${t.description}"${t.payee && t.payee !== t.description ? ` (payee as cleaned: "${t.payee}")` : ''}`,
    `It is ${dir}, £${Math.abs(t.amount).toFixed(2)}, on ${t.date}, from a ${accountType ?? 'bank'} account${count > 1 ? `; ${count} payments say the same` : ''}.`,
    '',
    'Categories (id: group › name):',
    ...fit.map((c) => `- ${c.id}: ${c.group ? `${c.group} › ` : ''}${c.name}`),
  ].join('\n');
}

export interface SuggestResult {
  asked: number;
  suggested: number;
  proposalId?: string;
  /** The run stopped early: the local model could not take it. */
  stopped?: string;
}

let running = false;

/**
 * Ask the local model about each description the categoriser left, and propose what it suggests
 * with medium or high confidence. One run at a time.
 */
export async function suggestCategories(store: Store, config: Config, proposals: ProposalService, opts: { sessions?: SessionLog | undefined; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<SuggestResult> {
  if (running) throw new StoreError('Categories are being suggested already.', 409);
  const choice = resolveTask('suggest-categories', store.settings.models.tasks);
  if (!config.inference) throw new StoreError('Suggesting categories runs on the local model service, which is not set up here (INFERENCE_BASE_URL and INFERENCE_API_KEY in .env).', 503);
  running = true;
  try {
    const groups = leftUncategorised(store);
    if (!groups.length) return { asked: 0, suggested: 0 };
    const index = new CategoryIndex(store.categories);
    const categories = store.categories
      .filter((c) => c.parent && !c.hidden && (c.kind === 'expense' || c.kind === 'income' || c.kind === 'transfer'))
      .map((c) => ({ id: c.id, name: c.name, group: index.get(c.parent)?.name, kind: c.kind }));
    const ids = categories.map((c) => c.id);
    const schema = { type: 'object', additionalProperties: false, required: ['category', 'confidence'], properties: { category: { type: ['string', 'null'], enum: [...ids, null] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } } };
    const def = TASKS['suggest-categories'];
    // The run's id: its session's transcript sits under it, and its proposal names it.
    const runId = `sug_${Date.now().toString(36)}`;
    const session = await opts.sessions?.start({
      kind: 'job',
      title: `Suggest categories for ${groups.length} payment description${groups.length === 1 ? '' : 's'}`,
      jobKind: 'suggest-categories',
      jobId: runId,
      engine: 'inference',
      model: choice.model,
      thinking: choice.thinking,
      promptVersion: SUGGEST_PROMPT_VERSION,
      tools: [],
      privacy: 'personal',
      startedBy: { actor: currentActor(), reason: 'Suggest categories for the payments the rules leave' },
    });
    const run = async (transcript: TranscriptSink | undefined): Promise<SuggestResult> => {
      const changes: { key: string; kind: 'set_category'; why: string; transaction: string; category: string }[] = [];
      let provenance: Provenance = { setBy: 'agent', engine: 'inference', promptVersion: SUGGEST_PROMPT_VERSION, jobId: runId };
      let asked = 0;
      let stopped: string | undefined;
      for (const g of groups) {
        const t = g.rows[0]!;
        try {
          const text = prompt(t, g.rows.length, store.account(t.accountId)?.type, categories);
          const res = await chat(config.inference, {
            alias: choice.model,
            system: SYSTEM,
            content: [{ type: 'text', text }],
            // The transcript shows what was asked: the system prompt, this payment's prompt, the schema.
            describe: { model: choice.model, systemPrompt: SYSTEM, prompt: text, schema },
            schema: { name: 'category', schema },
            thinking: choice.thinking,
            maxTokens: def.maxTokens,
            priority: def.priority,
            runMinutes: def.runMinutes,
            // A run that cannot get a turn soon stops: what it has suggested so far is proposed.
            waitUpToMs: 10 * 60_000,
            signal: opts.signal,
            transcript,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          });
          asked++;
          provenance = { ...provenance, model: res.provenance.modelId ?? choice.model, inference: res.provenance };
          const out = res.output as { category: string | null; confidence: string };
          if (!out.category || out.confidence === 'low' || !ids.includes(out.category)) continue;
          const name = categories.find((c) => c.id === out.category)!.name;
          for (const row of g.rows.slice(0, 50)) {
            if (changes.length >= 400) break;
            changes.push({ key: `c${changes.length + 1}`, kind: 'set_category', why: `The local model (${choice.model}) read “${row.description}” as ${name}, with ${out.confidence} confidence. Nothing your rules, the merchant list or the bank said placed it.`, transaction: row.id, category: out.category });
          }
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
        title: `Categories for ${changes.length} payment${changes.length === 1 ? '' : 's'} the rules leave`,
        summary: `The local model read the descriptions of payments that nothing else placed and suggests a category for each it was sure enough of (${asked} descriptions asked about). Check each against the description before you apply it: it is a guess from the words, not a fact.`,
        changes,
      };
      let proposal: { proposal: { id: string } };
      try {
        proposal = await proposals.create(input, provenance);
      } catch (err) {
        // Payments categorised meanwhile no longer fit: leave them out and propose the rest.
        if (!(err instanceof ProposalProblems) || !err.problems.length) throw err;
        const bad = new Set(err.problems.map((p) => p.key));
        const rest = changes.filter((c) => !bad.has(c.key));
        if (!rest.length) return { asked, suggested: 0, ...(stopped ? { stopped } : {}) };
        proposal = await proposals.create({ ...input, title: `Categories for ${rest.length} payment${rest.length === 1 ? '' : 's'} the rules leave`, changes: rest }, provenance);
      }
      transcript?.write({ type: 'finance.proposed', proposalId: proposal.proposal.id, changes: changes.length });
      return { asked, suggested: changes.length, proposalId: proposal.proposal.id, ...(stopped ? { stopped } : {}) };
    };
    return session ? await session.run(run, opts.signal) : await run(undefined);
  } finally {
    running = false;
  }
}

