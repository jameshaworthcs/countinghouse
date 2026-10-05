// The tools Ask's model may call for the data a question needs (src/server/ask.ts; DECISIONS
// 2026-10-05). Each is read-only and built by fixed rules from the app's own code: the search the
// Transactions page runs, the cash-flow classes the Spending page uses, the trips the month in
// review reads, a month's figures, balances and missing days. None reaches the web, so a question's
// privacy class stays "your data, no web". Every sum is the app's, in integer pence: the model is
// told to quote them, never to add up rows itself. Results are cut to a size the model reads well;
// counts and totals always cover every row, cut or not.

import { z } from 'zod';
import { CategoryIndex } from '../shared/categories';
import { addDays, addMonths, diffDays, eachMonth, endOfMonth, isISODate, maxDate, minDate, today, type ISODate } from '../shared/dates';
import { fromMinor, toMinor } from '../shared/money';
import { trips } from './agents/digest';
import type { Analytics } from './analytics';
import { flows, type FlowTx } from './analytics/cashflow';
import { estateOn } from './analytics/estate';
import { isTransactionAccount, missingDays } from './analytics/coverage';
import { filterTransactions } from './routes/data';
import type { Store } from './store';

export const ASK_TOOLS = ['find_transactions', 'spending_by', 'compare', 'trips', 'month', 'balances', 'coverage', 'sum'] as const;
export type AskTool = (typeof ASK_TOOLS)[number];

/** What each tool does, for the model (the system prompt lists them). */
export const TOOL_HELP: Record<AskTool, string> = {
  find_transactions: 'find_transactions(text?, accounts?, categories?, from?, to?, direction? "in"|"out", min?, max?, currency?, limit?): payments matching every filter given. text matches the description, payee, merchant, notes and reference (every word must appear). currency is the original currency of a payment made abroad (MYR, EUR, USD…). min and max are amounts in pounds, either sign. Returns the exact count, money in, money out and net over every match, totals by original currency, and up to limit rows (default 30, at most 100), newest first.',
  spending_by: 'spending_by(by "category"|"payee"|"month"|"account", from?, to?, accounts?, categories?, text?): spending (as the Spending page counts it: transfers between your accounts and money moved to savings left out) grouped that way, largest first (by month: in order), with the total. Each group gives spent (net of refunds), paid (before refunds), refunds and payments. By month, each month says whether every account has data for all of it, and byYear gives each year\'s total, months and average a month. text narrows it like find_transactions.',
  compare: 'compare(from, to, compareFrom?, compareTo?, accounts?, categories?, text?, direction? "in"|"out"): spending (or money in, with direction "in") in one period against another: the default other period is the same dates a year earlier. Gives each period\'s total, paid, refunds, payments, months and average a month, whether every account has data for all of it (and which days are missing), the difference and the change in per cent, and the categories that changed most. Use it for any "more or less than", "compared with" or "change" question.',
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
  compareFrom: z.string().nullish(),
  compareTo: z.string().nullish(),
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
  required: ['text', 'accounts', 'categories', 'from', 'to', 'compareFrom', 'compareTo', 'direction', 'min', 'max', 'currency', 'limit', 'by', 'month', 'on', 'ids'],
  properties: {
    text: { type: ['string', 'null'] },
    accounts: { type: ['array', 'null'], items: { type: 'string' } },
    categories: { type: ['array', 'null'], items: { type: 'string' } },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    compareFrom: { type: ['string', 'null'] },
    compareTo: { type: ['string', 'null'] },
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

/** Spending (or money in) over a period, as the Spending page counts it, narrowed as asked. */
function flowsFor(store: Store, cats: CategoryIndex, o: { from: ISODate; to: ISODate; accounts?: string[] | undefined; categories?: string[] | undefined; text?: string | null | undefined; cls?: 'spending' | 'income' }): FlowTx[] {
  const words = o.text?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return flows(store, o.from, o.to, o.accounts ? new Set(o.accounts) : undefined).filter((f) => {
    if (f.cls !== (o.cls ?? 'spending')) return false;
    const cat = f.t.category ?? 'uncategorised';
    if (o.categories && !o.categories.some((c) => c === cat || cats.groupOf(cat)?.id === c)) return false;
    if (!words.length) return true;
    const hay = `${f.t.description} ${f.t.payee ?? ''} ${f.t.merchant?.name ?? ''} ${f.t.notes ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Totals of flows in pence, given back in pounds: net (refunds taken off), what was paid before
 * refunds, the refunds, and how many payments. A refund is a flow with a negative amount.
 */
function totals(list: FlowTx[]): { total: number; paid: number; refunds: number; payments: number } {
  let paid = 0;
  let refunds = 0;
  for (const f of list) {
    if (f.minor >= 0) paid += f.minor;
    else refunds -= f.minor;
  }
  return { total: fromMinor(paid - refunds), paid: fromMinor(paid), refunds: fromMinor(refunds), payments: list.length };
}

/** The calendar months a period spans, counting a part month by its share of days (2 dp). */
function monthsIn(from: ISODate, to: ISODate): number {
  let n = 0;
  for (const m of eachMonth(from, to)) {
    const start = maxDate(`${m}-01`, from)!;
    const end = minDate(endOfMonth(`${m}-01`), to)!;
    n += (diffDays(start, end) + 1) / (diffDays(`${m}-01`, endOfMonth(`${m}-01`)) + 1);
  }
  return Math.round(n * 100) / 100;
}

/** The accounts a question is about: those asked for, else every account with payments. */
function accountsAbout(store: Store, ids: string[] | undefined) {
  return ids ? ids.map((id) => store.account(id)!).filter(Boolean) : store.accounts.filter((a) => isTransactionAccount(a) && store.transactions(a.id).length > 0);
}

/** The days in a period these accounts have no data for (after today, none is expected). */
function missingIn(store: Store, ids: string[] | undefined, from: ISODate, to: ISODate): { account: string; from: string; to: string }[] {
  const end = minDate(to, today())!;
  if (from > end) return [];
  return accountsAbout(store, ids).flatMap((a) => missingDays(store, a, from, end).map((g) => ({ account: a.name, from: g.from, to: g.to })));
}

/** When each account's data ends: a period past it is not all there. */
function dataUntil(store: Store, analytics: Analytics, ids: string[] | undefined): { account: string; until: string | null }[] {
  return accountsAbout(store, ids)
    .slice(0, 12)
    .map((a) => ({ account: a.name, until: analytics.engine.lastDataDate(a.id) }));
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
      const byYear = new Map<string, { in: number; out: number; payments: number }>();
      for (const t of rows) {
        const m = toMinor(t.amount);
        if (m >= 0) inMinor += m;
        else outMinor += m;
        const y = byYear.get(t.date.slice(0, 4)) ?? { in: 0, out: 0, payments: 0 };
        if (m >= 0) y.in += m;
        else y.out += m;
        y.payments++;
        byYear.set(t.date.slice(0, 4), y);
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
          ...(byYear.size > 1 ? { byYear: [...byYear.entries()].sort().map(([year, y]) => ({ year, moneyIn: fromMinor(y.in), moneyOut: fromMinor(y.out), net: fromMinor(y.in + y.out), payments: y.payments })) } : {}),
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
      const list = flowsFor(store, cats, { from, to, accounts, categories, text: args.text });
      const groups = new Map<string, { label: string; flows: FlowTx[] }>();
      for (const f of list) {
        const cat = f.t.category ?? 'uncategorised';
        const key = by === 'category' ? cat : by === 'payee' ? (f.t.payee ?? f.t.description) : by === 'month' ? f.t.date.slice(0, 7) : f.t.accountId;
        const label = by === 'category' ? (cats.get(cat)?.name ?? 'Uncategorised') : by === 'account' ? accountName(key) : key;
        const g = groups.get(key) ?? { label, flows: [] };
        g.flows.push(f);
        groups.set(key, g);
      }
      const all = totals(list);
      const sorted = [...groups.entries()]
        .map(([key, g]) => ({ key, label: g.label, ...totals(g.flows) }))
        .sort((a, b) => (by === 'month' ? a.key.localeCompare(b.key) : b.total - a.total));
      // By month: every month of the period, with or without spending, and whether its data is all there.
      const months = by === 'month' ? eachMonth(from, minDate(to, today())!) : [];
      const monthRows = months.map((m) => {
        const g = sorted.find((x) => x.key === m);
        const start = maxDate(`${m}-01`, from)!;
        const end = minDate(endOfMonth(`${m}-01`), to)!;
        const missing = missingIn(store, accounts, start, end);
        return { month: m, spent: g?.total ?? 0, paid: g?.paid ?? 0, refunds: g?.refunds ?? 0, payments: g?.payments ?? 0, ...(start !== `${m}-01` || end !== endOfMonth(`${m}-01`) ? { partOfMonth: `${start} to ${end}` } : {}), complete: !missing.length && end <= today() };
      });
      const byYear = [...new Set(months.map((m) => m.slice(0, 4)))].map((y) => {
        const rows = monthRows.filter((r) => r.month.startsWith(y));
        const yFrom = maxDate(`${y}-01-01`, from)!;
        const yTo = minDate(`${y}-12-31`, to, today())!;
        const t = totals(list.filter((f) => f.t.date.startsWith(y)));
        const span = monthsIn(yFrom, yTo);
        return { year: y, from: yFrom, to: yTo, spent: t.total, paid: t.paid, refunds: t.refunds, payments: t.payments, months: span, averagePerMonth: span ? fromMinor(Math.round(toMinor(t.total) / span)) : null, monthsComplete: rows.filter((r) => r.complete).length, monthsCounted: rows.length };
      });
      return {
        result: {
          period: { from, to },
          by,
          total: all.total,
          paid: all.paid,
          refunds: all.refunds,
          payments: all.payments,
          ...(by === 'month'
            ? { months: monthRows, byYear, note: 'spent is net of refunds: a negative month had more refunds than payments. byYear gives each year’s totals: quote them, do not add months up.' }
            : {
                groups: sorted.slice(0, GROUPS_MAX).map((g) => ({ ...(by === 'category' || by === 'account' ? { id: g.key } : {}), label: g.label, spent: g.total, paid: g.paid, refunds: g.refunds, payments: g.payments })),
                ...(sorted.length > GROUPS_MAX ? { groupsLeftOut: sorted.length - GROUPS_MAX, note: 'the totals cover every group' } : {}),
              }),
          dataUntil: dataUntil(store, analytics, accounts),
        },
        summary: `Spending by ${by}: ${by === 'month' ? `${months.length} month${months.length === 1 ? '' : 's'}` : `${sorted.length} group${sorted.length === 1 ? '' : 's'}`}, ${pounds(toMinor(all.total))} in all`,
        href: `/spending?from=${from}&to=${to}`,
      };
    }
    case 'compare': {
      const direction = args.direction === 'in' ? 'in' : 'out';
      const aFrom = date(args.from, 'from') ?? date(defaults.from, 'from') ?? `${today().slice(0, 4)}-01-01`;
      const aTo = date(args.to, 'to') ?? date(defaults.to, 'to') ?? today();
      if (aFrom > aTo) throw new ToolError(`from (${aFrom}) is after to (${aTo}).`);
      const bFrom = date(args.compareFrom, 'compareFrom') ?? addMonths(aFrom, -12);
      const bTo = date(args.compareTo, 'compareTo') ?? addMonths(aTo, -12);
      if (bFrom > bTo) throw new ToolError(`compareFrom (${bFrom}) is after compareTo (${bTo}).`);
      const accounts = accountsOf(store, args, defaults);
      const categories = categoriesOf(store, args.categories);
      const cls = direction === 'in' ? ('income' as const) : ('spending' as const);
      const side = (from: ISODate, to: ISODate) => {
        const list = flowsFor(store, cats, { from, to, accounts, categories, text: args.text, cls });
        const t = totals(list);
        const span = monthsIn(from, minDate(to, today())!);
        const missing = missingIn(store, accounts, from, to);
        return { list, summary: { from, to, total: t.total, paid: t.paid, refunds: t.refunds, payments: t.payments, months: span, averagePerMonth: span ? fromMinor(Math.round(toMinor(t.total) / span)) : null, complete: !missing.length && to <= today(), ...(missing.length ? { missingDays: missing.slice(0, 10) } : {}), ...(to > today() ? { note: `runs past today (${today()}): only the days to today can have data` } : {}) } };
      };
      const a = side(aFrom, aTo);
      const b = side(bFrom, bTo);
      const diff = toMinor(a.summary.total) - toMinor(b.summary.total);
      const byCat = new Map<string, { a: number; b: number }>();
      for (const [k, list] of [['a', a.list] as const, ['b', b.list] as const]) {
        for (const f of list) {
          const c = byCat.get(f.t.category ?? 'uncategorised') ?? { a: 0, b: 0 };
          c[k] += f.minor;
          byCat.set(f.t.category ?? 'uncategorised', c);
        }
      }
      const changes = [...byCat.entries()]
        .map(([id, v]) => ({ id, label: cats.get(id)?.name ?? 'Uncategorised', period: fromMinor(v.a), comparedWith: fromMinor(v.b), difference: fromMinor(v.a - v.b) }))
        .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference))
        .slice(0, 10);
      const word = direction === 'in' ? 'money in' : 'spending';
      return {
        result: {
          measure: word,
          period: a.summary,
          comparedWith: b.summary,
          difference: fromMinor(diff),
          changePercent: toMinor(b.summary.total) ? Math.round((diff / toMinor(b.summary.total)) * 1000) / 10 : null,
          verdict: diff > 0 ? `more ${word} in the period than in the one compared with` : diff < 0 ? `less ${word} in the period than in the one compared with` : 'the same',
          ...(a.summary.months !== b.summary.months ? { note: 'the periods are of different lengths: compare averagePerMonth, or choose periods of the same length' } : {}),
          categoriesChangedMost: changes,
          dataUntil: dataUntil(store, analytics, accounts),
        },
        summary: `${word[0]!.toUpperCase()}${word.slice(1)} ${aFrom} to ${aTo}: ${pounds(toMinor(a.summary.total))}, against ${pounds(toMinor(b.summary.total))} for ${bFrom} to ${bTo}`,
        href: `/spending?from=${aFrom}&to=${aTo}`,
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
