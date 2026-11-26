// Set aside (docs/FORMULAS.md §21): the figures, and the owner's own changes to it. Agents change it
// only by proposing (src/server/proposals.ts); no token may use the routes that change it (tokens.ts
// lists none of them).

import { Hono } from 'hono';
import { z } from 'zod';
import { addDays, today } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import { EARMARK_EFFECTS, MoneySchema, POT_EFFECTS, SlugSchema, type EarmarkDecision, type Earmarks, type Transaction } from '../../shared/schema';
import { decisionProblem, earmarkFigures } from '../analytics/earmarks';
import { agentTokenOf as tokenOf, readJson, type AppContext } from '../context';
import { nowISO } from '../fsutil';
import { StoreError } from '../store';

const Parts = z.array(z.object({ effect: z.enum(EARMARK_EFFECTS), amount: MoneySchema.refine((v) => v > 0, { message: 'A part is more than £0' }) })).min(1).max(5);
const Decide = z.object({
  decisions: z
    .array(
      z.object({
        pot: SlugSchema,
        transaction: z.string().regex(/^tx_[0-9a-f]{16}$/),
        /** null takes the decision away: the payment counts by the rules again. */
        parts: Parts.nullable(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});
const PotBody = z.object({ pot: SlugSchema });

/** Decisions as they would be with these changes, each checked; throws with every problem. */
function withDecisions(setup: Earmarks, txById: (id: string) => Transaction | undefined, changes: z.infer<typeof Decide>['decisions']): Earmarks {
  const decisions: Record<string, EarmarkDecision> = { ...setup.decisions };
  const problems: string[] = [];
  for (const c of changes) {
    const t = txById(c.transaction);
    const problem = decisionProblem(setup, c.pot, t, c.parts);
    if (problem || !t) {
      problems.push(problem ?? 'That payment is no longer in your data.');
      continue;
    }
    if (!c.parts) delete decisions[t.id];
    else decisions[t.id] = { pot: c.pot, parts: c.parts, reason: c.reason || 'Decided on the Set aside page', seen: { accountId: t.accountId, date: t.date, amount: t.amount }, decidedAt: nowISO() };
  }
  if (problems.length) throw new StoreError(problems.join(' '), 422);
  return { ...setup, decisions };
}

export function earmarkRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { store } = ctx;
  const ownerOnly = (c: Parameters<typeof tokenOf>[0]) => {
    if (tokenOf(c)) throw new StoreError('Only the owner changes what is set aside: propose it instead.', 403);
  };
  const setupOrThrow = () => {
    if (!store.earmarks) throw new StoreError('Nothing is set aside.', 404);
    return store.earmarks;
  };

  app.get('/', (c) => c.json(ctx.analytics.earmarks()));

  /** What deciding these would do to the figures, without saving anything. */
  app.post('/preview', async (c) => {
    ownerOnly(c);
    const { decisions } = await readJson(c, Decide);
    const setup = setupOrThrow();
    const next = withDecisions(setup, (id) => store.transaction(id), decisions);
    const txs = store.transactions();
    return c.json({ before: earmarkFigures(store, setup, txs, ctx.analytics.engine), after: earmarkFigures(store, next, txs, ctx.analytics.engine) });
  });

  /** Decide payments (or take decisions away), in one change to your data. */
  app.post('/decisions', async (c) => {
    ownerOnly(c);
    const { decisions } = await readJson(c, Decide);
    const next = withDecisions(setupOrThrow(), (id) => store.transaction(id), decisions);
    await store.setEarmarks({ ...next, updatedAt: nowISO() }, `set aside: ${decisions.length === 1 ? (decisions[0]!.parts ? 'decide a payment' : 'take a decision away') : `decide ${decisions.length} payments`}`);
    return c.json(ctx.analytics.earmarks());
  });

  /** "I've checked this": the figures as they are now, kept with each pot. */
  app.post('/checks', async (c) => {
    ownerOnly(c);
    const setup = setupOrThrow();
    const r = ctx.analytics.earmarks().result;
    if (!r) throw new StoreError('There is no figure to check: see the problems on the page.', 409);
    const at = nowISO();
    const pots = setup.pots.map((p) => {
      const now = r.pots.find((x) => x.id === p.id);
      return now ? { ...p, checks: [...p.checks, { at, setAside: now.setAside, spendable: r.spendable }].slice(-100) } : p;
    });
    await store.setEarmarks({ ...setup, pots, updatedAt: at }, 'set aside: checked');
    return c.json(ctx.analytics.earmarks());
  });

  /**
   * Start a pot again from here: from the day after the oldest of the everyday accounts' latest days
   * (every account has data to then), with what it had set aside on that day as its opening. Its
   * decisions before then no longer count and go (git keeps them).
   */
  app.post('/restart', async (c) => {
    ownerOnly(c);
    const { pot: potId } = await readJson(c, PotBody);
    const setup = setupOrThrow();
    const pot = setup.pots.find((p) => p.id === potId);
    if (!pot) throw new StoreError(`There is no pot "${potId}".`, 404);
    const r = ctx.analytics.earmarks().result;
    const now = r?.pots.find((p) => p.id === potId);
    if (!r || !now || !r.oldest) throw new StoreError('There is no figure to start again from: see the problems on the page.', 409);
    const through = r.oldest;
    if (through < pot.start) throw new StoreError(`${pot.name} started after the latest day every everyday account has data for.`, 409);
    // What it had set aside at the end of that day: the opening and every part with an effect on it to then.
    let n = toMinor(pot.opening);
    for (const line of now.lines) if (POT_EFFECTS.includes(line.effect)) for (const row of line.rows) if (row.date <= through) n += toMinor(row.counted);
    const start = addDays(through, 1);
    if (start > today()) throw new StoreError('Every everyday account has data up to today: start again tomorrow.', 409);
    const decisions = Object.fromEntries(Object.entries(setup.decisions).filter(([, d]) => d.pot !== potId || d.seen.date >= start));
    const pots = setup.pots.map((p) => (p.id === potId ? { ...p, start, opening: fromMinor(n) } : p));
    await store.setEarmarks({ ...setup, pots, decisions, updatedAt: nowISO() }, `set aside: ${pot.name} starts again on ${start}`);
    return c.json(ctx.analytics.earmarks());
  });

  return app;
}
