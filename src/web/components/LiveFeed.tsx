// The optional Trading 212 live feed in the app: its state (GET /api/feeds), "the app is open" while
// a page is visible, the live value on its account's page, and its card in Settings.

import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FeedsResponse, FeedStatus } from '../../shared/feeds';
import { formatDate } from '../../shared/dates';
import { sumMoney } from '../../shared/money';
import { api, useApi, useApiMutation } from '../lib/api';
import { money } from '../lib/format';
import { Badge, Button, Callout, Card, KeyValue, Money } from './ui';

/** The Trading 212 feed's state; undefined until known. The live stream ('feed') refreshes it. */
export function useTrading212(): FeedStatus | undefined {
  const q = useApi<FeedsResponse>(['feeds'], '/feeds', { refetchInterval: 60_000 });
  return q.data?.feeds.find((f) => f.id === 'trading-212');
}

const WATCH_EVERY_MS = 30_000;

/**
 * While a page of the app is visible, tell the server every 30 seconds, so the feed reads often (and
 * at once when its latest reading is stale). Nothing is sent when the feed is not set up.
 */
export function useFeedWatch(): void {
  const feed = useTrading212();
  const on = Boolean(feed?.configured);
  useEffect(() => {
    if (!on) return;
    const ping = () => {
      if (document.visibilityState === 'visible') void api('/feeds/trading-212/watch', { method: 'POST' }).catch(() => undefined);
    };
    ping();
    const timer = setInterval(ping, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
    };
  }, [on]);
}

/** "8s ago", "3 min ago", "2 h ago", or the date: ticking each second. */
function useAgo(iso: string | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return formatDate(iso.slice(0, 10));
}

/** HH:MM:SS: readings come seconds apart. */
const timeOf = (iso: string) => iso.slice(11, 19);

function RefreshButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const refresh = useApiMutation(() => api('/feeds/trading-212/refresh', { method: 'POST' }));
  return (
    <Button size={size} icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined)}>
      Refresh
    </Button>
  );
}

/** On the linked account's page: what Trading 212 says it is worth now. Shown only when the feed is on and linked to it. */
export function LiveAccountValue({ accountId, currency }: { accountId: string; currency: string }) {
  const feed = useTrading212();
  const latest = feed?.latest;
  const ago = useAgo(latest?.at);
  if (!feed?.configured || feed.accountId !== accountId || !latest) return null;
  return (
    <Callout
      tone={feed.lastError ? 'warn' : 'neutral'}
      className="mb-5"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Live from Trading 212: <Money value={latest.totalValue} currency={latest.currency || currency} />
          <span className="font-normal text-ink-3">
            read {timeOf(latest.at)} ({ago})
          </span>
          {feed.environment === 'demo' && <Badge tone="warn">practice account</Badge>}
        </span>
      }
      action={<RefreshButton />}
    >
      Invested <span className="sensitive">{money(latest.investments.value)}</span> · cash <span className="sensitive">{money(sumMoney([latest.cash.free, latest.cash.inPies, latest.cash.reserved]))}</span> · gain{' '}
      <span className="sensitive">{money(latest.investments.unrealisedGain, { sign: true })}</span>. Kept in the work area, not yet recorded as a valuation.
      {feed.lastError && <> Last try failed: {feed.lastError}</>}
    </Callout>
  );
}

/** Settings → Live feeds: whether the optional feed is set up, and how it is doing. */
export function LiveFeedsSettings() {
  const feed = useTrading212();
  const ago = useAgo(feed?.latest?.at);
  if (!feed) return null;
  const minutes = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  return (
    <div className="flex flex-col gap-5">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            Trading 212 <Badge tone="muted">optional</Badge>
          </span>
        }
        description="Reads an Invest or Stocks ISA account’s value and holdings from Trading 212’s own API: every few seconds while the app is open, less often otherwise. Readings stay in the work area; nothing is recorded in your data. Only your API key goes to Trading 212; nothing of yours is sent."
        actions={feed.configured ? <RefreshButton size="md" /> : undefined}
      >
        {!feed.configured ? (
          <Callout tone="neutral" title="Not set up">
            The app works the same without it. To turn it on, make an API key in Trading 212 (Settings → API, with only the account data and portfolio permissions, and limited to this server’s IP address), then set <code>FINANCE_T212_API_KEY</code> and <code>FINANCE_T212_API_SECRET</code> in the server’s <code>.env</code> and restart it. See docs/SELF_HOSTING.md, “Trading 212 live feed”.
          </Callout>
        ) : (
          <>
            {feed.lastError && (
              <Callout tone="bad" className="mb-3" title="The last reading failed">
                {feed.lastError}
              </Callout>
            )}
            {feed.linkProblem && (
              <Callout tone="warn" className="mb-3" title="Not linked to an account">
                {feed.linkProblem}
              </Callout>
            )}
            <KeyValue
              items={[
                ['Service', feed.environment === 'demo' ? 'Practice money (demo.trading212.com)' : 'Real money (live.trading212.com)'],
                ['Account', feed.accountName ? `${feed.accountName}${feed.latest?.accountLast4 ? ` (•••• ${feed.latest.accountLast4})` : ''}` : '—'],
                ['Latest reading', feed.latest ? <span><Money value={feed.latest.totalValue} currency={feed.latest.currency} /> at {timeOf(feed.latest.at)} on {formatDate(feed.latest.at.slice(0, 10))} ({ago})</span> : 'none yet'],
                ['Now', !feed.running ? 'Not reading by itself (this instance does not serve the app)' : feed.watched ? `The app is open: reading every ${feed.intervals.watchedSeconds}s` : `Reading every ${minutes(feed.intervals.backgroundMinutes)} in market hours, every ${minutes(feed.intervals.quietMinutes)} otherwise`],
                ['Next reading', feed.nextAt ? `${timeOf(feed.nextAt)}${feed.failures ? ` (after ${feed.failures} failure${feed.failures === 1 ? '' : 's'} in a row)` : ''}` : '—'],
              ]}
            />
          </>
        )}
      </Card>
    </div>
  );
}
