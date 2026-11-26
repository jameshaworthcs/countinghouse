// Set aside (docs/FORMULAS.md §21): the figures, and the owner's own changes to it. Agents change it
// only by proposing (src/server/proposals.ts); no token may use the routes that change it (tokens.ts
// lists none of them).

import { Hono } from 'hono';
import { z } from 'zod';
import { addDays, today } from '../../shared/dates';
import { EARMARK_EFFECTS, EarmarkSetupSchema, MoneySchema, SlugSchema, TimestampSchema, type EarmarkDecision, type Earmarks, type Transaction } from '../../shared/schema';
import { decisionProblem, earmarkFigures, earmarks, setupProblem, withSetup } from '../analytics/earmarks';
import { agentTokenOf as tokenOf, readJson, type AppContext } from '../context';
import { nowISO } from '../fsutil';
import { StoreError } from '../store';
import { suggestEarmarks, toAsk, type EarmarkSuggestResult } from '../earmark-suggest';

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
const SetupBody = z.object({ setup: EarmarkSetupSchema, was: TimestampSchema.nullable().optional() });

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

  // The local model suggesting decisions for the payments to check: yours to start, with its switch on.
  let last: (EarmarkSuggestResult & { at: string }) | { error: string; at: string } | undefined;
  let suggesting = false;
  app.get('/suggest', (c) =>
    c.json({ enabled: store.settings.agents.earmarkSuggest, available: Boolean(ctx.config.inference), running: suggesting, waiting: store.earmarks ? toAsk(store, ctx.analytics, ctx.proposals).length : 0, last: last ?? null }),
  );
  app.post('/suggest', (c) => {
    ownerOnly(c);
    setupOrThrow();
    if (!store.settings.agents.earmarkSuggest) throw new StoreError('Suggesting set-aside decisions is off: turn it on in Settings → Set aside.', 409);
    if (!ctx.config.inference) throw new StoreError('Suggesting decisions runs on the local model service, which is not set up here.', 503);
    if (suggesting) throw new StoreError('Decisions are being suggested already.', 409);
    suggesting = true;
    void suggestEarmarks(store, ctx.analytics, ctx.config, ctx.proposals, { sessions: ctx.sessions })
      .then((r) => (last = { ...r, at: new Date().toISOString() }))
      .catch((err: Error) => (last = { error: err.message, at: new Date().toISOString() }))
      .finally(() => (suggesting = false));
    return c.json({ running: true }, 202);
  });

  /** What a setup being edited would give, without saving it. */
  app.post('/setup/preview', async (c) => {
    ownerOnly(c);
    const { setup } = await readJson(c, SetupBody);
    const problem = setupProblem(setup, (id) => store.accounts.find((a) => a.id === id), (id) => store.categories.some((x) => x.id === id));
    if (problem) return c.json({ setup: null, result: null, problems: [problem] });
    return c.json(earmarks(store, ctx.analytics.engine, today(), withSetup(store.earmarks, setup, nowISO())));
  });

  /** Set it up, or change its accounts, pots and rules: your decisions and checks stay. */
  app.put('/setup', async (c) => {
    ownerOnly(c);
    const { setup, was } = await readJson(c, SetupBody);
    const problem = setupProblem(setup, (id) => store.accounts.find((a) => a.id === id), (id) => store.categories.some((x) => x.id === id));
    if (problem) throw new StoreError(problem, 422);
    await store.updateEarmarks((current) => {
      if (was !== undefined && was !== (current?.updatedAt ?? null)) throw new StoreError('Set aside changed since you opened it (an applied proposal, or another tab): reload it and make your change again.', 409);
      return withSetup(current, setup, nowISO());
    }, store.earmarks ? 'set aside: change the setup' : 'set aside: set up');
    return c.json(ctx.analytics.earmarks());
  });

  /** Stop using it: the file goes (your data's history keeps it), and nothing about it shows. */
  app.delete('/', (c) => {
    ownerOnly(c);
    setupOrThrow();
    return store.setEarmarks(null, 'set aside: removed').then(() => c.json({ ok: true }));
  });

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
    setupOrThrow();
    await store.updateEarmarks(
      (current) => {
        if (!current) throw new StoreError('Nothing is set aside.', 404);
        return { ...withDecisions(current, (id) => store.transaction(id), decisions), updatedAt: nowISO() };
      },
      `set aside: ${decisions.length === 1 ? (decisions[0]!.parts ? 'decide a payment' : 'take a decision away') : `decide ${decisions.length} payments`}`,
    );
    return c.json(ctx.analytics.earmarks());
  });

  /** "I've checked this": the figures as they are now, kept with each pot. */
  app.post('/checks', async (c) => {
    ownerOnly(c);
    setupOrThrow();
    const r = ctx.analytics.earmarks().result;
    if (!r) throw new StoreError('There is no figure to check: see the problems on the page.', 409);
    const at = nowISO();
    await store.updateEarmarks((current) => {
      if (!current) throw new StoreError('Nothing is set aside.', 404);
      const pots = current.pots.map((p) => {
        const now = r.pots.find((x) => x.id === p.id);
        return now ? { ...p, checks: [...p.checks, { at, setAside: now.setAside, spendable: r.spendable }].slice(-100) } : p;
      });
      return { ...current, pots, updatedAt: at };
    }, 'set aside: checked');
    return c.json(ctx.analytics.earmarks());
  });

  /**
   * Start again from here: every pot from the day after the latest day every open everyday account
   * has data for (D), with what it had set aside at the end of D as its opening, and what its capped
   * rules could still pay carried in. All pots together, so no payment moves from one to another.
   * Decisions for payments to D go (git keeps them), and what was still to check is settled as
   * suggested. The figure is the same before and after.
   */
  app.post('/restart', async (c) => {
    ownerOnly(c);
    setupOrThrow();
    const r = ctx.analytics.earmarks().result;
    if (!r?.oldest) throw new StoreError('There is no figure to start again from: see the problems on the page.', 409);
    const through = r.oldest;
    const start = addDays(through, 1);
    if (start > today()) throw new StoreError('Every everyday account has data up to today: start again tomorrow.', 409);
    const at = earmarks(store, ctx.analytics.engine, today(), store.earmarks, through).result;
    if (!at) throw new StoreError('There is no figure to start again from: see the problems on the page.', 409);
    await store.updateEarmarks((current) => {
      if (!current) throw new StoreError('Nothing is set aside.', 404);
      const restarted = new Set(current.pots.filter((p) => p.start <= through).map((p) => p.id));
      if (!restarted.size) throw new StoreError(`Every pot starts after ${through}, the latest day every everyday account has data for: there is nothing to start again.`, 409);
      const pots = current.pots.map((p) => {
        const then = at.pots.find((x) => x.id === p.id);
        if (!restarted.has(p.id) || !then) return p;
        const { carried: _old, ...rest } = p;
        return { ...rest, start, opening: then.setAside, ...(Object.keys(then.allowances).length ? { carried: then.allowances } : {}) };
      });
      const decisions = Object.fromEntries(Object.entries(current.decisions).filter(([, d]) => !restarted.has(d.pot) || d.seen.date >= start));
      return { ...current, pots, decisions, updatedAt: nowISO() };
    }, `set aside: starts again on ${start}`);
    return c.json(ctx.analytics.earmarks());
  });

  return app;
}
