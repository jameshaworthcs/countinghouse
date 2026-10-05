// The tools Ask's model may call for the data a question needs (src/server/ask.ts; DECISIONS
// 2026-10-05). Each is read-only and built by fixed rules from the app's own code: the search the
// Transactions page runs, the cash-flow classes the Spending page uses, the trips the month in
// review reads, a month's figures, balances and missing days. None reaches the web, so a question's
// privacy class stays "your data, no web". Every sum is the app's, in integer pence: the model is
// told to quote them, never to add up rows itself. Results are cut to a size the model reads well;
// counts and totals always cover every row, cut or not.

import { z } from 'zod';
import { CategoryIndex } from '../shared/categories';
import { addDays, isISODate, today, type ISODate } from '../shared/dates';
import { fromMinor, toMinor } from '../shared/money';
import { trips } from './agents/digest';
import type { Analytics } from './analytics';
import { flows } from './analytics/cashflow';
import { estateOn } from './analytics/estate';
import { missingDays } from './analytics/coverage';
import { filterTransactions } from './routes/data';
import type { Store } from './store';

export const ASK_TOOLS = ['find_transactions', 'spending_by', 'trips', 'month', 'balances', 'coverage', 'sum'] as const;
export type AskTool = (typeof ASK_TOOLS)[number];

/** What each tool does, for the model (the system prompt lists them). */
export const TOOL_HELP: Record<AskTool, string> = {
  find_transactions: 'find_transactions(text?, accounts?, categories?, from?, to?, direction? "in"|"out", min?, max?, currency?, limit?): payments matching every filter given. text matches the description, payee, merchant, notes and reference (every word must appear). currency is the original currency of a payment made abroad (MYR, EUR, USD…). min and max are amounts in pounds, either sign. Returns the exact count, money in, money out and net over every match, totals by original currency, and up to limit rows (default 30, at most 100), newest first.',
  spending_by: 'spending_by(by "category"|"payee"|"month"|"account", from?, to?, accounts?, categories?, text?): spending (money out, as the Spending page counts it: transfers between your accounts and money moved to savings left out) grouped that way, largest first, with the total. text narrows it like find_transactions.',
  trips: 'trips(from?, to?): runs of spending categorised Holidays, a gap of more than a few days ending one: each trip\'s dates, total spent, number of payments and main payees.',
  month: 'month(month "YYYY-MM"): the month\'s figures as the Overview shows them: money in, spending by category, net, what was moved to savings, net worth at its start and end, and whether every account has data for it.',
  balances: 'balances(on? "YYYY-MM-DD", accounts?): each account\'s balance on that day (default today) in pounds, whether it is estimated, and the estate\'s assets, debts and net worth.',
  coverage: 'coverage(from?, to?, accounts?): the days each account has no data for in the period, so an answer can say what it does not cover.',
  sum: 'sum(ids): the exact count and total of the transactions with these ids, in and out apart. Use it whenever you need a total of rows you chose.',
};

/** The arguments a step may give (one flat object: the step's schema stays flat for the local model). */
export const ToolArgs = z.object({
  text: z.string().max(200).nullish(),
  accounts: z.array(z.string()).max(50).nullish(),
  categories: z.array(z.string()).max(50).nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  direction: z.enum(['in', 'out']).nullish(),
  min: z.number().nullish(),
  max: z.number().nullish(),
  currency: z.string().max(3).nullish(),
  limit: z.number().int().nullish(),
  by: z.enum(['category', 'payee', 'month', 'account']).nullish(),
  month: z.string().nullish(),
  on: z.string().nullish(),
  ids: z.array(z.string()).max(500).nullish(),
});
export type ToolArgs = z.infer<typeof ToolArgs>;

/** The args' JSON Schema: every field there, null when not used (strict schemas need them all). */
export const TOOL_ARGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'accounts', 'categories', 'from', 'to', 'direction', 'min', 'max', 'currency', 'limit', 'by', 'month', 'on', 'ids'],
  properties: {
    text: { type: ['string', 'null'] },
    accounts: { type: ['array', 'null'], items: { type: 'string' } },
    categories: { type: ['array', 'null'], items: { type: 'string' } },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    direction: { type: ['string', 'null'], enum: ['in', 'out', null] },
    min: { type: ['number', 'null'] },
    max: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    limit: { type: ['integer', 'null'] },
    by: { type: ['string', 'null'], enum: ['category', 'payee', 'month', 'account', null] },
    month: { type: ['string', 'null'] },
    on: { type: ['string', 'null'] },
    ids: { type: ['array', 'null'], items: { type: 'string' } },
  },
};

export interface ToolResult {
  /** What the model is given back. */
  result: unknown;
  /** One line for the page: "13 payments found, money out £1,234.56". */
  summary: string;
  /** Where the owner can check it: the Transactions page with the same filters, or the page it came from. */
  href?: string;
}

/** The defaults the owner set on the question: the period and accounts, used when the model gives none. */
export interface ToolDefaults {
  from?: string | undefined;
  to?: string | undefined;
  accounts?: string[] | undefined;
}

export class ToolError extends Error {}

const ROWS_DEFAULT = 30;
const ROWS_MAX = 100;
const GROUPS_MAX = 40;
const pounds = (minor: number) => `£${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function date(v: string | null | undefined, field: string): ISODate | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const given: string = v;
  if (!isISODate(v)) throw new ToolError(`${field} must be a date, YYYY-MM-DD (it was "${given}").`);
  return v;
}

function period(args: ToolArgs, d: ToolDefaults, fallbackDays: number): { from: ISODate; to: ISODate } {
  const to = date(args.to, 'to') ?? date(d.to, 'to') ?? today();
  const from = date(args.from, 'from') ?? date(d.from, 'from') ?? addDays(to, -fallbackDays);
  if (from > to) throw new ToolError(`from (${from}) is after to (${to}).`);
  return { from, to };
}

function accountsOf(store: Store, args: ToolArgs, d: ToolDefaults): string[] | undefined {
  const ids = args.accounts?.length ? args.accounts : d.accounts?.length ? d.accounts : undefined;
  if (!ids) return undefined;
  const unknown = ids.filter((id) => !store.account(id));
  if (unknown.length) throw new ToolError(`No account with the id ${unknown.join(', ')}: use the ids from the list of accounts.`);
  return ids;
}

function categoriesOf(store: Store, ids: string[] | null | undefined): string[] | undefined {
  if (!ids?.length) return undefined;
  const known = new Set([...store.categories.map((c) => c.id), 'uncategorised']);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new ToolError(`No category with the id ${unknown.join(', ')}: use the ids from the list of categories.`);
  return ids;
}

/** The Transactions page with these filters: where the owner checks what a search found. */
function transactionsHref(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  if (q.from || q.to) p.set('period', 'custom');
  return `/transactions?${p.toString()}`;
}

export function runTool(store: Store, analytics: Analytics, tool: AskTool, raw: unknown, defaults: ToolDefaults = {}): ToolResult {
  const parsed = ToolArgs.safeParse(raw ?? {});
  if (!parsed.success) throw new ToolError(`Its arguments are not right: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}.`);
  const args = parsed.data;
  const cats = new CategoryIndex(store.categories);
  const accountName = (id: string) => store.account(id)?.name ?? id;
  switch (tool) {
    case 'find_transactions': {
      // A search with nothing to search by lists everything: on the real service, the local model
      // without thinking sent one, its why naming the currency it then left out.
      const filters = [args.text, args.currency, args.from, args.to, args.direction, args.min, args.max].some((v) => v !== null && v !== undefined && v !== '') || Boolean(args.accounts?.length || args.categories?.length);
      if (!filters && !defaults.from && !defaults.to && !defaults.accounts?.length) throw new ToolError('Give at least one filter in args (text, currency, categories, accounts, from, to, direction, min or max): this call had none, so it would list every payment.');
      const { from, to } = period(args, defaults, 3650);
      const accounts = accountsOf(store, args, defaults);
      const categories = categoriesOf(store, args.categories);
      const q = {
        from,
        to,
        q: args.text?.trim() || undefined,
        accounts: accounts?.join(','),
        categories: categories?.join(','),
        direction: args.direction ?? undefined,
        min: args.min !== null && args.min !== undefined ? String(Math.abs(args.min)) : undefined,
        max: args.max !== null && args.max !== undefined ? String(Math.abs(args.max)) : undefined,
        currency: args.currency?.trim().toUpperCase() || undefined,
      };
      const rows = filterTransactions({ store }, q).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      let inMinor = 0;
      let outMinor = 0;
      const byCurrency = new Map<string, { minor: number; payments: number }>();
      for (const t of rows) {
        const m = toMinor(t.amount);
        if (m >= 0) inMinor += m;
        else outMinor += m;
        if (t.original) {
          const c = byCurrency.get(t.original.currency) ?? { minor: 0, payments: 0 };
          c.minor += toMinor(t.original.amount);
          c.payments++;
          byCurrency.set(t.original.currency, c);
        }
      }
      const limit = Math.min(Math.max(args.limit ?? ROWS_DEFAULT, 1), ROWS_MAX);
      const shown = rows.slice(0, limit);
      return {
        result: {
          period: { from, to },
          count: rows.length,
          moneyIn: fromMinor(inMinor),
          moneyOut: fromMinor(outMinor),
          net: fromMinor(inMinor + outMinor),
          ...(byCurrency.size ? { byOriginalCurrency: [...byCurrency.entries()].map(([currency, c]) => ({ currency, amount: fromMinor(c.minor), payments: c.payments })) } : {}),
          rows: shown.map((t) => ({
            id: t.id,
            date: t.date,
            account: accountName(t.accountId),
            description: t.description,
            ...(t.payee && t.payee !== t.description ? { payee: t.payee } : {}),
            amount: t.amount,
            ...(t.original ? { original: `${t.original.amount} ${t.original.currency}` } : {}),
            category: t.category ? (cats.get(t.category)?.name ?? t.category) : null,
            ...(t.transferGroup ? { transfer: true } : {}),
          })),
          ...(rows.length > shown.length ? { rowsLeftOut: rows.length - shown.length, note: 'count and the totals cover every match; only the newest rows are listed' } : {}),
        },
        summary: `${rows.length} payment${rows.length === 1 ? '' : 's'} found${outMinor ? `, money out ${pounds(outMinor)}` : ''}${inMinor ? `, money in ${pounds(inMinor)}` : ''}`,
        href: transactionsHref(q),
      };
    }
    case 'spending_by': {
      const by = args.by ?? 'category';
      const { from, to } = period(args, defaults, 365);
      const accounts = accountsOf(store, args, defaults);
      const categories = categoriesOf(store, args.categories);
      const words = args.text?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const groups = new Map<string, { label: string; minor: number; payments: number }>();
      let total = 0;
      for (const f of flows(store, from, to, accounts ? new Set(accounts) : undefined)) {
        if (f.cls !== 'spending') continue;
        const cat = f.t.category ?? 'uncategorised';
        if (categories && !categories.some((c) => c === cat || cats.groupOf(cat)?.id === c)) continue;
        if (words.length) {
          const hay = `${f.t.description} ${f.t.payee ?? ''} ${f.t.merchant?.name ?? ''} ${f.t.notes ?? ''}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
        }
        const key = by === 'category' ? cat : by === 'payee' ? (f.t.payee ?? f.t.description) : by === 'month' ? f.t.date.slice(0, 7) : f.t.accountId;
        const label = by === 'category' ? (cats.get(cat)?.name ?? 'Uncategorised') : by === 'account' ? accountName(key) : key;
        const g = groups.get(key) ?? { label, minor: 0, payments: 0 };
        g.minor += f.minor;
        g.payments++;
        groups.set(key, g);
        total += f.minor;
      }
      const list = [...groups.entries()].sort((a, b) => (by === 'month' ? a[0].localeCompare(b[0]) : b[1].minor - a[1].minor));
      return {
        result: {
          period: { from, to },
          by,
          total: fromMinor(total),
          groups: list.slice(0, GROUPS_MAX).map(([key, g]) => ({ ...(by === 'category' || by === 'account' ? { id: key } : {}), label: g.label, spent: fromMinor(g.minor), payments: g.payments })),
          ...(list.length > GROUPS_MAX ? { groupsLeftOut: list.length - GROUPS_MAX, note: 'the total covers every group' } : {}),
        },
        summary: `Spending by ${by}: ${list.length} group${list.length === 1 ? '' : 's'}, ${pounds(total)} in all`,
        href: `/spending?from=${from}&to=${to}`,
      };
    }
    case 'trips': {
      const { from, to } = period(args, defaults, 3650);
      const list = trips(store, from, to);
      return {
        result: { period: { from, to }, trips: list },
        summary: `${list.length} trip${list.length === 1 ? '' : 's'} found`,
        href: transactionsHref({ from, to, categories: 'holidays' }),
      };
    }
    case 'month': {
      const month = args.month ?? args.from?.slice(0, 7) ?? today().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ToolError(`month must be YYYY-MM (it was "${month}").`);
      const m = analytics.month(month);
      return {
        result: {
          month: m.month,
          complete: m.complete,
          ...(m.limitedBy.length ? { accountsMissingDays: m.limitedBy } : {}),
          moneyIn: { income: m.moneyIn.income, borrowed: m.moneyIn.borrowed, total: m.moneyIn.total, lines: m.moneyIn.lines },
          spending: { total: m.spending.total, lines: m.spending.lines },
          net: m.net.amount,
          movedToOtherAccounts: m.moved,
          netWorth: { start: m.worth.start, end: m.worth.end, change: m.worth.change, estimated: m.worth.estimated },
        },
        summary: `The figures for ${month}${m.complete ? '' : ' (not every account has data for it)'}`,
        href: `/?month=${month}`,
      };
    }
    case 'balances': {
      const on = date(args.on, 'on') ?? today();
      const accounts = accountsOf(store, args, defaults);
      const engine = analytics.engine;
      const rows = store.accounts
        .filter((a) => !accounts || accounts.includes(a.id))
        .map((a) => {
          const p = engine.balanceOn(a.id, on);
          return { id: a.id, name: a.name, type: a.type, ...(p ? { balance: p.gbp, ...(a.currency !== 'GBP' ? { ownCurrency: `${p.value} ${a.currency}` } : {}), estimated: p.estimated } : { balance: null, note: 'no data on that day' }) };
        });
      const estate = estateOn(store, engine, on);
      return {
        result: { on, accounts: rows, estate },
        summary: `Balances on ${on}`,
        href: '/accounts',
      };
    }
    case 'coverage': {
      const { from, to } = period(args, defaults, 365);
      const accounts = accountsOf(store, args, defaults);
      const list = store.accounts
        .filter((a) => (!accounts || accounts.includes(a.id)) && a.status !== 'closed')
        .map((a) => ({ id: a.id, name: a.name, missing: missingDays(store, a, from, to).map((g) => ({ from: g.from, to: g.to, ...(g.noData ? { noData: true } : {}) })) }))
        .filter((a) => a.missing.length);
      return {
        result: { period: { from, to }, accountsWithMissingDays: list, ...(list.length ? {} : { note: 'every account has data for every day of the period' }) },
        summary: list.length ? `${list.length} account${list.length === 1 ? '' : 's'} with days missing` : 'Every account has data for the whole period',
        href: '/settings#health',
      };
    }
    case 'sum': {
      const ids = args.ids ?? [];
      if (!ids.length) throw new ToolError('Give the ids of the transactions to add up.');
      const found = ids.map((id) => store.transaction(id)).filter((t) => t !== undefined);
      const missing = ids.filter((id) => !store.transaction(id));
      let inMinor = 0;
      let outMinor = 0;
      for (const t of found) {
        const m = toMinor(t.amount);
        if (m >= 0) inMinor += m;
        else outMinor += m;
      }
      return {
        result: { count: found.length, moneyIn: fromMinor(inMinor), moneyOut: fromMinor(outMinor), net: fromMinor(inMinor + outMinor), ...(missing.length ? { notFound: missing } : {}) },
        summary: `${found.length} payment${found.length === 1 ? '' : 's'} added up: net ${inMinor + outMinor < 0 ? '−' : ''}${pounds(inMinor + outMinor)}`,
      };
    }
  }
}
