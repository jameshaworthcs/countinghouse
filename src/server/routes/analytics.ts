import { Hono } from 'hono';
import { addDays, addMonths, startOfMonth, today } from '../../shared/dates';
import { csvCell, queryDate, type AppContext } from '../context';
import { StoreError } from '../store';

export function analyticsRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const a = ctx.analytics;

  // Today's figures count a live feed's reading that stands for today (FORMULAS.md §9, "Live readings").
  app.get('/summary', (c) => c.json(a.summary(ctx.imports.counts(), ctx.feeds.liveOverride())));

  app.get('/estate', (c) => {
    const grouping = c.req.query('grouping') === 'access' ? 'access' : 'wrapper';
    return c.json(a.estateSeries(queryDate(c.req.query('from')), queryDate(c.req.query('to')), grouping));
  });

  app.get('/cashflow', (c) => {
    const to = queryDate(c.req.query('to')) ?? today();
    const from = queryDate(c.req.query('from')) ?? addDays(to, -364);
    return c.json(a.cashflow(from, to));
  });

  app.get('/spending', (c) => {
    const to = queryDate(c.req.query('to')) ?? today();
    const from = queryDate(c.req.query('from')) ?? startOfMonth(addMonths(to, -2));
    return c.json(a.spending(from, to));
  });

  app.get('/recurring', (c) => c.json(a.recurring()));
  app.get('/budgets', (c) => c.json(a.budgets(c.req.query('month'))));
  app.get('/goals/progress', (c) => c.json(a.goals()));
  app.get('/earmarks', (c) => c.json(a.earmarks()));
  app.get('/pay', (c) => c.json(a.pay(c.req.query('taxYear'))));

  app.get('/projections', (c) => {
    const months = Number(c.req.query('months') ?? 60);
    const adjust = Number(c.req.query('adjust') ?? 0);
    const pastFrom = queryDate(c.req.query('pastFrom'));
    const pastTo = queryDate(c.req.query('pastTo'));
    return c.json(
      a.projections({
        months: Number.isFinite(months) ? months : 60,
        spendingAdjustment: Number.isFinite(adjust) ? Math.max(-0.9, Math.min(2, adjust)) : 0,
        units: c.req.query('units') === 'nominal' ? 'nominal' : 'real',
        ...(pastFrom ? { pastFrom } : {}),
        ...(pastTo ? { pastTo } : {}),
      }),
    );
  });

  app.get('/coverage', (c) => c.json(a.coverage()));

  app.get('/allowances', (c) => c.json(a.allowances(c.req.query('taxYear'))));

  app.get('/self-assessment', (c) => {
    const sa = a.selfAssessment(c.req.query('taxYear'));
    if (c.req.query('format') !== 'csv') return c.json(sa);
    const esc = csvCell;
    const r = sa.taxReturn;
    const lines: string[] = [];
    if (r) {
      // The return box by box: what to enter online, on paper, and where it came from.
      lines.push('form,page,for,box,wording,enter online,on paper,state,basis');
      for (const p of r.pages) for (const b of p.boxes) if (b.state !== 'blank' || b.always) lines.push([p.form, p.page, p.instance ?? '', b.box, b.label, b.entered, b.paper ?? b.entered, b.state, b.basis].map(esc).join(','));
      const c = r.calculation;
      lines.push('', 'step,amount,rate,tax');
      lines.push(['Total income', c.totalIncome, '', ''].map(String).map(esc).join(','));
      lines.push(['Personal allowance', -c.personalAllowance, '', ''].map(String).map(esc).join(','));
      for (const l of [...c.lines, ...c.reducers, ...c.class4Lines, ...(c.capitalGains?.lines ?? []), ...(c.studentLoan?.lines ?? [])]) lines.push([l.label, l.amount, l.rate ?? '', l.tax ?? ''].map(String).map(esc).join(','));
      lines.push(['Total tax for the year', '', '', c.totalLiability].map(String).map(esc).join(','));
      lines.push(['Tax taken off at source', '', '', -c.deductedAtSource].map(String).map(esc).join(','));
      lines.push(['Left to pay for the year', '', '', c.balancing].map(String).map(esc).join(','));
      if (!r.readiness.ready) lines.push('', esc(`Not ready: ${r.readiness.blockers.map((b) => b.text).join('; ')}`));
    } else {
      lines.push('section,item,where,amount,status,basis,notes');
      for (const s of sa.sections) for (const i of s.items) lines.push([s.title, i.label, i.where, i.amount?.toFixed(2) ?? '', i.status, i.basis, i.notes.join(' ')].map(esc).join(','));
    }
    lines.push('', esc(sa.disclaimer));
    return new Response(lines.join('\n') + '\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="self-assessment-${sa.taxYear.label.replace('/', '-')}.csv"` },
    });
  });

  app.get('/investments', (c) => c.json(a.investments(ctx.feeds.liveOverride())));
  app.get('/monthly', (c) => c.json(a.monthly()));
  /** A month's figures (docs/FORMULAS.md §18): YYYY-MM, not after this month. */
  app.get('/month/:month', (c) => {
    const month = c.req.param('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > today().slice(0, 7)) throw new StoreError('A month is YYYY-MM, and not after this one.', 400);
    return c.json(a.month(month));
  });
  app.get('/capture', (c) => c.json(a.capture()));
  app.get('/data-health', async (c) => {
    // A data repository with a remote is a health problem of its own: one push publishes it.
    const g = await ctx.git.status();
    return c.json({ ...a.health(), ...(g.remoteWarning ? { remotes: { warning: g.remoteWarning, public: Boolean(g.remotes?.some((r) => r.public)) } } : {}) });
  });

  return app;
}
