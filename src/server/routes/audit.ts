// Settings → Audit log: search the log, check its chain, and export it (audit.ts).

import type { Context } from 'hono';
import { Hono } from 'hono';
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, type AuditActorType, type AuditCategory, type AuditResponse } from '../../shared/audit';
import type { AuditQuery } from '../audit';
import { queryDate, type AppContext } from '../context';
import { nowISO } from '../fsutil';

const EXPORT_MAX = 200_000;

function list<T extends string>(value: string | undefined, allowed: readonly T[]): T[] | undefined {
  const out = (value ?? '').split(',').filter((v): v is T => (allowed as readonly string[]).includes(v));
  return out.length ? out : undefined;
}

function queryOf(c: Context): AuditQuery {
  const q: AuditQuery = {};
  const text = c.req.query('q')?.trim().slice(0, 200);
  if (text) q.q = text;
  const categories = list<AuditCategory>(c.req.query('category'), AUDIT_CATEGORIES);
  if (categories) q.categories = categories;
  const actors = list<AuditActorType>(c.req.query('actor'), AUDIT_ACTOR_TYPES);
  if (actors) q.actors = actors;
  const outcome = c.req.query('outcome');
  if (outcome === 'ok' || outcome === 'refused' || outcome === 'failed') q.outcome = outcome;
  const from = queryDate(c.req.query('from'));
  if (from) q.from = from;
  const to = queryDate(c.req.query('to'));
  if (to) q.to = to;
  const before = Number(c.req.query('before'));
  if (Number.isInteger(before) && before > 0) q.before = before;
  const limit = Number(c.req.query('limit'));
  if (Number.isInteger(limit) && limit > 0) q.limit = limit;
  if (c.req.query('all') === '1') q.all = true;
  return q;
}

export function auditRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const page = await ctx.audit.query(queryOf(c));
    return c.json({ ...page, status: ctx.audit.status() } satisfies AuditResponse);
  });

  app.get('/verify', async (c) => c.json(await ctx.audit.verify()));

  /** The matching entries as JSON lines, newest first: for a spreadsheet, jq or another tool. */
  app.get('/export', async (c) => {
    const lines: string[] = [];
    for await (const e of ctx.audit.scan(queryOf(c))) {
      lines.push(JSON.stringify(e));
      if (lines.length >= EXPORT_MAX) break;
    }
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="finance-audit-${nowISO().slice(0, 10)}.jsonl"`);
    return c.body(lines.length ? `${lines.join('\n')}\n` : '');
  });

  return app;
}
