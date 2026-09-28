// CRUD over the data: accounts, balances, transactions, categories, rules, figures, goals,
// profile and settings.

import { Hono } from 'hono';
import { z } from 'zod';
import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import type { AccountDetailResponse, BootstrapResponse, TransactionsResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { Categoriser, ruleMatches } from '../../shared/categorise';
import { today } from '../../shared/dates';
import { catalogInstitution, findInstitution, INSTITUTION_CATALOG } from '../../shared/institutions';
import { cleanPayee, descriptionKey } from '../../shared/merchants';
import { fromMinor, toMinor } from '../../shared/money';
import {
  AccountTypeSchema,
  CategorySchema,
  CurrencySchema,
  FIGURE_KINDS,
  GoalSchema,
  ISODateSchema,
  MoneySchema,
  PensionDetailsSchema,
  ProfileSchema,
  RuleSchema,
  SettingsSchema,
  SlugSchema,
  type Account,
  type BalanceSnapshot,
  type Figure,
  type Rule,
  type Transaction,
} from '../../shared/schema';
import { SYSTEM_CATEGORY_IDS } from '../../shared/categories';
import { csvCell, queryDate, readJson, type AppContext } from '../context';
import { enrich } from '../enrich';
import { nowISO } from '../fsutil';
import { balanceId, figureId, ruleId, transactionId } from '../ids';
import { StoreError } from '../store';
import { accountSummary } from '../analytics/estate';

const NewAccountBody = z.object({
  name: z.string().min(1).max(120),
  type: AccountTypeSchema,
  id: SlugSchema.optional(),
  institutionId: SlugSchema.optional(),
  institutionName: z.string().max(120).optional(),
  currency: CurrencySchema.default('GBP'),
  last4: z
    .string()
    .regex(/^\d{2,6}$/)
    .optional(),
  openedOn: ISODateSchema.optional(),
  includeInNetWorth: z.boolean().optional(),
  aliases: z.array(z.string().max(80)).max(20).optional(),
  notes: z.string().max(2000).optional(),
  pension: PensionDetailsSchema.optional(),
  flexibleIsa: z.boolean().optional(),
  interestRate: z.number().optional(),
  maturesOn: ISODateSchema.optional(),
  /** Optional opening balance recorded as a manual snapshot. */
  balance: MoneySchema.optional(),
  balanceDate: ISODateSchema.optional(),
});

const AccountPatch = NewAccountBody.omit({ id: true, balance: true, balanceDate: true })
  .partial()
  .extend({
    status: z.enum(['open', 'closed']).optional(),
    closedOn: ISODateSchema.optional().nullable(),
    balanceMode: z.enum(['ledger', 'market']).optional().nullable(),
    last4: z
      .string()
      .regex(/^\d{2,6}$/)
      .optional()
      .nullable(),
  });

const ManualBalance = z.object({
  date: ISODateSchema,
  balance: MoneySchema,
  contributions: MoneySchema.optional(),
  gain: MoneySchema.optional(),
  cash: MoneySchema.optional(),
  bonusToDate: MoneySchema.optional(),
  taxYearContributions: MoneySchema.optional(),
  taxYear: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .optional(),
  annualIncome: MoneySchema.optional(),
  interestRate: z.number().optional(),
  note: z.string().max(500).optional(),
});

const TxPatch = z.object({
  payee: z.string().max(120).optional().nullable(),
  category: z.string().max(64).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  pending: z.boolean().optional(),
  // Corrections to what was read from the document: the previous value is kept in `corrections`.
  date: ISODateSchema.optional(),
  amount: MoneySchema.optional(),
  description: z.string().max(500).optional(),
  correctionNote: z.string().max(500).optional(),
});

const NewTx = z.object({
  accountId: SlugSchema,
  date: ISODateSchema,
  amount: MoneySchema,
  description: z.string().min(1).max(500),
  category: z.string().optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string()).optional(),
});

const FigureBody = z.object({
  kind: z.enum(FIGURE_KINDS),
  label: z.string().min(1).max(200),
  amount: MoneySchema,
  taxYear: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .optional(),
  periodStart: ISODateSchema.optional(),
  periodEnd: ISODateSchema.optional(),
  date: ISODateSchema.optional(),
  accountId: SlugSchema.optional(),
  payer: z.string().max(200).optional(),
  payerReference: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
});

/** `null` in a patch clears the field. */
function applyNulls<T extends Record<string, unknown>>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === null ? undefined : v;
  return out;
}

export function filterTransactions(ctx: AppContext, q: Record<string, string | undefined>): Transaction[] {
  const from = queryDate(q.from);
  const to = queryDate(q.to);
  const accounts = q.accounts ? new Set(q.accounts.split(',')) : null;
  const categories = q.categories ? new Set(q.categories.split(',')) : null;
  const cats = new CategoryIndex(ctx.store.categories);
  const text = q.q?.trim().toLowerCase();
  const min = q.min ? Number(q.min) : undefined;
  const max = q.max ? Number(q.max) : undefined;
  const tag = q.tag?.toLowerCase();
  return ctx.store.transactions().filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (accounts && !accounts.has(t.accountId)) return false;
    if (categories) {
      const id = t.category ?? 'uncategorised';
      const group = cats.groupOf(t.category)?.id;
      if (!categories.has(id) && !(group && categories.has(group))) return false;
    }
    if (q.direction === 'in' && t.amount < 0) return false;
    if (q.direction === 'out' && t.amount >= 0) return false;
    if (q.transfers === 'exclude' && (t.transferGroup || cats.kindOf(t.category) === 'transfer')) return false;
    if (q.transfers === 'only' && !(t.transferGroup || cats.kindOf(t.category) === 'transfer')) return false;
    if (min !== undefined && Math.abs(t.amount) < min) return false;
    if (max !== undefined && Math.abs(t.amount) > max) return false;
    if (tag && !t.tags?.some((x) => x.toLowerCase() === tag)) return false;
    if (q.source && t.source.importId !== q.source) return false;
    if (text) {
      const hay = `${t.description} ${t.payee ?? ''} ${t.notes ?? ''} ${t.reference ?? ''} ${t.counterpartyName ?? ''} ${(t.tags ?? []).join(' ')} ${t.amount.toFixed(2)}`.toLowerCase();
      if (!text.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function dataRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { store } = ctx;

  app.get('/bootstrap', (c) => {
    const body: BootstrapResponse = {
      profile: store.profile,
      settings: store.settings,
      accounts: store.accounts,
      institutions: store.institutions,
      categories: store.categories,
      rules: store.rules,
      goals: store.goals,
      csvProfiles: store.csvProfiles,
      user: ctx.auth.sessionFrom(c)?.user ?? null,
      dataDir: ctx.config.dataDir,
      inboxDir: ctx.config.inboxDir,
      demo: !ctx.git.enabled && /demo/.test(ctx.config.dataDir),
    };
    return c.json(body);
  });

  app.get('/institutions/catalog', (c) => c.json(INSTITUTION_CATALOG.map(({ match: _m, ...rest }) => rest)));

  // ─── Accounts ────────────────────────────────────────────────────────────────────────────────

  app.get('/accounts', (c) => c.json(ctx.analytics.accountSummaries()));

  app.post('/accounts', async (c) => {
    const body = await readJson(c, NewAccountBody);
    let institutionId = body.institutionId;
    if (!institutionId && body.institutionName) {
      const cat = findInstitution(body.institutionName);
      institutionId = cat?.id ?? slugify(body.institutionName, store.institutions.map((i) => i.id));
    }
    if (institutionId && !store.institution(institutionId)) {
      const cat = catalogInstitution(institutionId);
      await store.upsertInstitution({
        id: institutionId,
        name: cat?.name ?? body.institutionName ?? institutionId,
        kind: cat?.kind ?? 'bank',
        ...(cat?.fscsGroup ? { fscsGroup: cat.fscsGroup } : {}),
      });
    }
    const id = body.id && !store.account(body.id) ? body.id : slugify(body.id ?? `${institutionId ?? ''} ${body.name}`, store.accounts.map((a) => a.id));
    const stamp = nowISO();
    const account: Account = {
      id,
      name: body.name,
      type: body.type,
      currency: body.currency,
      status: 'open',
      aliases: body.aliases ?? [],
      includeInNetWorth: body.includeInNetWorth ?? ACCOUNT_TYPE_META[body.type].defaultInNetWorth,
      createdAt: stamp,
      updatedAt: stamp,
      ...(institutionId ? { institutionId } : {}),
      ...(body.last4 ? { last4: body.last4 } : {}),
      ...(body.openedOn ? { openedOn: body.openedOn } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.pension ? { pension: body.pension } : {}),
      ...(body.flexibleIsa !== undefined ? { flexibleIsa: body.flexibleIsa } : {}),
      ...(body.interestRate !== undefined ? { interestRate: body.interestRate } : {}),
      ...(body.maturesOn ? { maturesOn: body.maturesOn } : {}),
    };
    await store.upsertAccount(account);
    if (body.balance !== undefined) {
      const date = body.balanceDate ?? today();
      await store.addBalances(
        [{ id: balanceId(id, date, body.balance, 'manual', stamp), accountId: id, date, balance: body.balance, currency: body.currency, kind: 'manual', dateSource: 'manual', source: {}, createdAt: stamp }],
        `balance: ${account.name} ${date}`,
      );
    }
    return c.json(account, 201);
  });

  app.get('/accounts/:id', (c) => {
    const account = store.account(c.req.param('id'));
    if (!account) throw new StoreError('Unknown account', 404);
    const engine = ctx.analytics.engine;
    const first = engine.firstDataDate(account.id);
    const series = first ? ctx.analytics.estateSeries(first, today()).dates.map((d) => ({ date: d, value: engine.balanceOn(account.id, d)?.value ?? null })) : [];
    const body: AccountDetailResponse = {
      account,
      summary: accountSummary(store, engine, account),
      balances: store.balances(account.id),
      holdings: store.holdings(account.id),
      series,
      gaps: engine.gaps(account.id),
      figures: store.figures.filter((f) => f.accountId === account.id),
      imports: store.imports
        .filter((i) => i.result?.accountIds.includes(account.id))
        .map((i) => ({ id: i.id, fileName: i.fileName, documentId: i.documentId, ...(i.committedAt ? { committedAt: i.committedAt } : {}) })),
    };
    return c.json(body);
  });

  app.patch('/accounts/:id', async (c) => {
    const account = store.account(c.req.param('id'));
    if (!account) throw new StoreError('Unknown account', 404);
    const body = await readJson(c, AccountPatch);
    const { institutionName, ...rest } = body;
    const merged = { ...account, ...applyNulls(rest) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    if (institutionName && !body.institutionId) {
      const cat = findInstitution(institutionName);
      const instId = cat?.id ?? slugify(institutionName, store.institutions.map((i) => i.id));
      if (!store.institution(instId)) await store.upsertInstitution({ id: instId, name: cat?.name ?? institutionName, kind: cat?.kind ?? 'bank', ...(cat?.fscsGroup ? { fscsGroup: cat.fscsGroup } : {}) });
      merged.institutionId = instId;
    }
    await store.upsertAccount(merged as Account);
    return c.json(store.account(account.id));
  });

  app.delete('/accounts/:id', async (c) => {
    await store.deleteAccount(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.patch('/institutions/:id', async (c) => {
    const inst = store.institution(c.req.param('id'));
    if (!inst) throw new StoreError('Unknown institution', 404);
    const body = await readJson(c, z.object({ name: z.string().min(1).optional(), fscsGroup: z.string().optional().nullable(), notes: z.string().optional() }));
    const next = { ...inst, ...applyNulls(body) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    await store.upsertInstitution(next as typeof inst);
    return c.json(next);
  });

  // ─── Balances & holdings ─────────────────────────────────────────────────────────────────────

  app.post('/accounts/:id/balances', async (c) => {
    const account = store.account(c.req.param('id'));
    if (!account) throw new StoreError('Unknown account', 404);
    const body = await readJson(c, ManualBalance);
    const stamp = nowISO();
    const snap: BalanceSnapshot = {
      id: balanceId(account.id, body.date, body.balance, 'manual', stamp),
      accountId: account.id,
      currency: account.currency,
      kind: 'manual',
      dateSource: 'manual',
      source: {},
      createdAt: stamp,
      ...body,
    };
    await store.addBalances([snap], `balance: ${account.name} ${body.date}`);
    return c.json(snap, 201);
  });

  app.patch('/balances/:id', async (c) => {
    const body = await readJson(c, ManualBalance.partial());
    return c.json(await store.updateBalance(c.req.param('id'), body, 'balance: edit'));
  });

  app.delete('/balances/:id', async (c) => {
    await store.deleteBalance(c.req.param('id'), 'balance: delete');
    return c.json({ ok: true });
  });

  app.delete('/holdings/:id', async (c) => {
    await store.deleteHoldings(c.req.param('id'), 'holdings: delete');
    return c.json({ ok: true });
  });

  // ─── Transactions ────────────────────────────────────────────────────────────────────────────

  app.get('/transactions', (c) => {
    const q = c.req.query();
    const list = filterTransactions(ctx, q);
    const sort = q.sort ?? 'date_desc';
    const sorted = [...list].sort((a, b) => {
      switch (sort) {
        case 'date_asc':
          return a.date.localeCompare(b.date);
        case 'amount_asc':
          return a.amount - b.amount;
        case 'amount_desc':
          return b.amount - a.amount;
        default:
          return b.date.localeCompare(a.date);
      }
    });
    const limit = Math.min(Number(q.limit ?? 500), 10_000);
    const offset = Number(q.offset ?? 0);
    let inMinor = 0;
    let outMinor = 0;
    for (const t of list) {
      if (t.amount >= 0) inMinor += toMinor(t.amount);
      else outMinor += toMinor(t.amount);
    }
    const body: TransactionsResponse = {
      total: list.length,
      sum: { in: fromMinor(inMinor), out: fromMinor(outMinor), net: fromMinor(inMinor + outMinor) },
      items: sorted.slice(offset, offset + limit),
    };
    return c.json(body);
  });

  app.get('/transactions/export.csv', (c) => {
    const list = filterTransactions(ctx, c.req.query()).sort((a, b) => a.date.localeCompare(b.date));
    const cats = new CategoryIndex(store.categories);
    const esc = csvCell;
    const header = ['date', 'account', 'amount', 'currency', 'description', 'payee', 'category', 'group', 'notes', 'tags', 'id'];
    const rows = list.map((t) =>
      [t.date, store.account(t.accountId)?.name ?? t.accountId, t.amount.toFixed(2), t.currency, t.description, t.payee, cats.name(t.category), cats.groupOf(t.category)?.name, t.notes, (t.tags ?? []).join(' '), t.id]
        .map(esc)
        .join(','),
    );
    return new Response([header.join(','), ...rows].join('\n') + '\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="transactions-${today()}.csv"` },
    });
  });

  app.post('/transactions', async (c) => {
    const body = await readJson(c, NewTx);
    const account = store.account(body.accountId);
    if (!account) throw new StoreError('Unknown account', 404);
    let occurrence = 0;
    let id = transactionId(account.id, body.date, body.amount, body.description, occurrence);
    while (store.transaction(id)) id = transactionId(account.id, body.date, body.amount, body.description, ++occurrence);
    const tx: Transaction = {
      id,
      accountId: account.id,
      date: body.date,
      amount: body.amount,
      currency: account.currency,
      description: body.description,
      payee: cleanPayee(body.description),
      source: {},
      createdAt: nowISO(),
      ...(body.category ? { category: body.category, categorisedBy: 'user' as const } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.tags?.length ? { tags: body.tags } : {}),
    };
    await store.addTransactions([tx], `transaction: add ${body.description}`);
    return c.json(tx, 201);
  });

  app.patch('/transactions/:id', async (c) => {
    const { correctionNote, ...body } = await readJson(c, TxPatch);
    const current = store.transaction(c.req.param('id'));
    if (!current) throw new StoreError('Unknown transaction', 404);
    const patch = applyNulls(body) as Partial<Transaction>;
    if ('category' in body) patch.categorisedBy = body.category ? 'user' : undefined;
    if ('category' in body) patch.ruleId = undefined;
    if ('payee' in body) patch.payeeSetBy = body.payee ? 'user' : undefined;
    const at = nowISO();
    const corrections = (['date', 'amount', 'description'] as const)
      .filter((f) => body[f] !== undefined && body[f] !== current[f])
      .map((f) => ({ field: f, from: current[f], to: body[f]!, at, ...(correctionNote ? { note: correctionNote } : {}) }));
    if (corrections.length) patch.corrections = [...(current.corrections ?? []), ...corrections];
    const [updated] = await store.updateTransactions([{ id: c.req.param('id'), patch }], `transaction: edit ${c.req.param('id')}`);
    return c.json(updated);
  });

  app.post('/transactions/bulk', async (c) => {
    const body = await readJson(
      c,
      z.object({
        ids: z.array(z.string()).min(1).max(5000),
        category: z.string().optional().nullable(),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
    );
    const updates = body.ids.map((id) => {
      const t = store.transaction(id);
      if (!t) throw new StoreError(`Unknown transaction ${id}`, 404);
      const patch: Partial<Transaction> = {};
      if (body.category !== undefined) {
        patch.category = body.category ?? undefined;
        patch.categorisedBy = body.category ? 'user' : undefined;
        patch.ruleId = undefined;
      }
      if (body.addTags || body.removeTags) {
        const tags = new Set(t.tags ?? []);
        for (const x of body.addTags ?? []) tags.add(x);
        for (const x of body.removeTags ?? []) tags.delete(x);
        patch.tags = tags.size ? [...tags] : undefined;
      }
      if (body.notes !== undefined) patch.notes = body.notes || undefined;
      return { id, patch };
    });
    const out = await store.updateTransactions(updates, `transactions: bulk edit (${updates.length})`);
    return c.json({ updated: out.length });
  });

  app.delete('/transactions/:id', async (c) => {
    const n = await store.deleteTransactions([c.req.param('id')], `transaction: delete ${c.req.param('id')}`);
    if (!n) throw new StoreError('Unknown transaction', 404);
    return c.json({ ok: true });
  });

  /** Other transactions that look like this one (same payee or simplified description). */
  app.get('/transactions/:id/similar', (c) => {
    const t = store.transaction(c.req.param('id'));
    if (!t) throw new StoreError('Unknown transaction', 404);
    const key = descriptionKey(t.description);
    const payee = t.payee?.toLowerCase();
    const similar = store.transactions().filter((x) => x.id !== t.id && ((payee && x.payee?.toLowerCase() === payee) || descriptionKey(x.description) === key));
    return c.json({
      count: similar.length,
      differentCategory: similar.filter((x) => x.category !== t.category && x.categorisedBy !== 'user').length,
      ids: similar.map((x) => x.id),
      suggestedMatch: t.payee ?? cleanPayee(t.description),
    });
  });

  // ─── Categories, rules, goals ────────────────────────────────────────────────────────────────

  app.get('/categories', (c) => c.json(store.categories));

  app.put('/categories', async (c) => {
    const list = await readJson(c, z.array(CategorySchema));
    const ids = new Set(list.map((x) => x.id));
    for (const sys of SYSTEM_CATEGORY_IDS) if (store.categories.some((x) => x.id === sys) && !ids.has(sys)) throw new StoreError(`"${sys}" is a system category and cannot be removed`, 409);
    await store.setCategories(list);
    return c.json(store.categories);
  });

  app.get('/rules', (c) => c.json(store.rules));

  const RuleBody = RuleSchema.omit({ id: true, createdAt: true, updatedAt: true }).extend({ apply: z.boolean().optional() });

  app.post('/rules', async (c) => {
    const body = await readJson(c, RuleBody);
    const { apply, ...rest } = body;
    const stamp = nowISO();
    const rule: Rule = { ...rest, id: ruleId(), createdAt: stamp, updatedAt: stamp };
    await store.setRules([...store.rules, rule], `rule: add ${rule.name ?? rule.match.value}`);
    const result = apply ? await enrich(store) : null;
    return c.json({ rule, result }, 201);
  });

  app.patch('/rules/:id', async (c) => {
    const existing = store.rules.find((r) => r.id === c.req.param('id'));
    if (!existing) throw new StoreError('Unknown rule', 404);
    const body = await readJson(c, RuleBody.partial());
    const { apply, ...rest } = body;
    const next: Rule = RuleSchema.parse({ ...existing, ...rest, updatedAt: nowISO() });
    await store.setRules(
      store.rules.map((r) => (r.id === next.id ? next : r)),
      `rule: edit ${next.name ?? next.match.value}`,
    );
    const result = apply ? await enrich(store) : null;
    return c.json({ rule: next, result });
  });

  app.delete('/rules/:id', async (c) => {
    await store.setRules(
      store.rules.filter((r) => r.id !== c.req.param('id')),
      'rule: delete',
    );
    return c.json({ ok: true });
  });

  /** How many transactions a (draft) rule would match. */
  app.post('/rules/preview', async (c) => {
    const body = await readJson(c, RuleBody);
    const stamp = nowISO();
    const { apply: _a, ...rest } = body;
    const rule: Rule = { ...rest, id: 'rule_preview', createdAt: stamp, updatedAt: stamp };
    const hits = store.transactions().filter((t) => ruleMatches(rule, { accountId: t.accountId, description: t.description, amount: t.amount, payee: t.payee }));
    return c.json({ count: hits.length, sample: hits.slice(-8).reverse() });
  });

  app.post('/enrich', async (c) => c.json(await enrich(store)));

  app.post('/categorise/preview', async (c) => {
    const body = await readJson(c, z.object({ accountId: SlugSchema, description: z.string(), amount: MoneySchema }));
    const categoriser = new Categoriser(store.rules, new CategoryIndex(store.categories), store.accounts, store.institutions);
    return c.json(categoriser.categorise(body));
  });

  app.get('/goals', (c) => c.json(store.goals));
  app.put('/goals', async (c) => {
    const list = await readJson(c, z.array(GoalSchema.omit({ createdAt: true, updatedAt: true }).extend({ createdAt: z.string().optional() })));
    const stamp = nowISO();
    await store.setGoals(list.map((g) => ({ ...g, createdAt: g.createdAt ?? stamp, updatedAt: stamp })));
    return c.json(store.goals);
  });

  // ─── Figures ─────────────────────────────────────────────────────────────────────────────────

  app.get('/figures', (c) => {
    const ty = c.req.query('taxYear');
    return c.json(ty ? store.figures.filter((f) => f.taxYear === ty) : store.figures);
  });

  app.post('/figures', async (c) => {
    const body = await readJson(c, FigureBody);
    const stamp = nowISO();
    const fig: Figure = {
      id: figureId(body.kind, body.amount, body.taxYear ?? body.periodEnd ?? '', body.payer ?? '', body.label, stamp),
      currency: 'GBP',
      source: {},
      createdAt: stamp,
      ...body,
    };
    await store.addFigures([fig], `figure: ${body.label}`);
    return c.json(fig, 201);
  });

  app.patch('/figures/:id', async (c) => {
    const body = await readJson(c, FigureBody.partial());
    return c.json(await store.updateFigure(c.req.param('id'), body, 'figure: edit'));
  });

  app.delete('/figures/:id', async (c) => {
    await store.deleteFigure(c.req.param('id'), 'figure: delete');
    return c.json({ ok: true });
  });

  // ─── Profile, settings, CSV profiles ─────────────────────────────────────────────────────────

  app.get('/profile', (c) => c.json(store.profile));
  app.put('/profile', async (c) => {
    await store.setProfile(await readJson(c, ProfileSchema));
    return c.json(store.profile);
  });

  app.get('/settings', (c) => c.json(store.settings));
  app.put('/settings', async (c) => {
    await store.setSettings(await readJson(c, SettingsSchema));
    return c.json(store.settings);
  });

  app.get('/csv-profiles', (c) => c.json(store.csvProfiles));
  app.delete('/csv-profiles/:id', async (c) => {
    await store.setCsvProfiles(
      store.csvProfiles.filter((p) => p.id !== c.req.param('id')),
      'csv profile: delete',
    );
    return c.json({ ok: true });
  });

  app.get('/tax-years', (c) => {
    const dates = [store.transactions()[0]?.date, store.balances()[0]?.date, ...store.figures.map((f) => f.periodEnd ?? f.date)].filter(Boolean) as string[];
    const first = dates.sort()[0] ?? today();
    const years: string[] = [];
    const startYear = Number(first.slice(0, 4)) - (first.slice(5) < '04-06' ? 1 : 0);
    const nowYear = Number(today().slice(0, 4)) - (today().slice(5) < '04-06' ? 1 : 0);
    for (let y = nowYear; y >= Math.min(startYear, nowYear); y--) years.push(`${y}/${String((y + 1) % 100).padStart(2, '0')}`);
    return c.json(years);
  });

  return app;
}
