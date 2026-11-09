// Live feeds (feeds/): their state, today's readings, "the app is open" and a refresh. Optional:
// with no key set, the list says so and the rest answer 404.

import { Hono } from 'hono';
import type { FeedsResponse, FeedTodayResponse } from '../../shared/feeds';
import type { AppContext } from '../context';
import { StoreError } from '../store';

export function feedRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const configured = (id: string) => {
    if (id !== 'trading-212') throw new StoreError(`No feed called "${id}".`, 404);
    if (!ctx.feeds.configured) throw new StoreError('The Trading 212 feed is optional and not set up here: it needs FINANCE_T212_API_KEY and FINANCE_T212_API_SECRET in .env (docs/SELF_HOSTING.md, "Trading 212 live feed").', 404);
  };

  app.get('/', (c) => c.json<FeedsResponse>({ feeds: [ctx.feeds.status()] }));

  app.get('/:id/today', (c) => {
    configured(c.req.param('id'));
    return c.json<FeedTodayResponse>(ctx.feeds.today());
  });

  // The browser says a page is open and visible (every 30s while it is): read often for a while.
  app.post('/:id/watch', (c) => {
    configured(c.req.param('id'));
    ctx.feeds.watch();
    return c.json(ctx.feeds.status());
  });

  // Read now, unless a reading was taken in the last few seconds or a rate limit says to wait.
  app.post('/:id/refresh', async (c) => {
    configured(c.req.param('id'));
    await ctx.feeds.refresh();
    return c.json(ctx.feeds.status());
  });

  return app;
}
