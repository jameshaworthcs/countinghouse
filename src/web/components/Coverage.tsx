import { Link } from 'react-router';
import type { CoverageGapView, CoverageResponse, DataHealthResponse } from '../../shared/api';
import { addDays, formatDate, today } from '../../shared/dates';
import type { BalanceEvidence } from '../../shared/schema';
import { api, useApiMutation } from '../lib/api';
import { cn, formatMonth, money, plural } from '../lib/format';
import { Button, Card, StatusBadge, useToast } from './ui';

/** Sequential shade for the share of a month's days that have data. */
const shade = (f: number) => (f <= 0 ? 'var(--panel-2)' : f < 0.5 ? 'var(--seq-2)' : f < 0.9 ? 'var(--seq-4)' : 'var(--seq-6)');

/**
 * Which months each account has transaction data for. With `only`, one account's row, without the
 * account column and the marks for months complete across every account.
 */
export function CoverageGrid({ cov, only }: { cov: CoverageResponse; only?: string }) {
  const rows = only ? cov.accounts.filter((a) => a.accountId === only) : cov.accounts;
  if (!rows.length) return null;
  const starred = rows.some((a) => a.source === 'transactions');
  const years: { year: string; span: number }[] = [];
  for (const m of cov.months) {
    const y = m.slice(0, 4);
    if (years.at(-1)?.year === y) years.at(-1)!.span++;
    else years.push({ year: y, span: 1 });
  }
  return (
    // Positioned, so the cells' screen-reader labels (absolutely placed) scroll with the grid
    // instead of widening the page on a phone.
    <div className="relative overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-[12px]">
        <thead>
          <tr>
            {!only && <th />}
            {years.map((y) => (
              <th key={y.year} colSpan={y.span} className="border-b border-line pb-0.5 text-left text-[11px] font-medium text-ink-3">
                {y.year}
              </th>
            ))}
          </tr>
          <tr>
            {!only && <th className="pr-3 text-left align-bottom font-medium text-ink-3">Account</th>}
            {cov.months.map((m) => (
              <th key={m} className="min-w-8 text-center align-top font-medium text-ink-3">
                {formatMonth(m, { short: true }).split(' ')[0]}
                {!only && (
                  <div className="text-good-ink" aria-label={cov.completeMonths.includes(m) ? 'complete' : undefined}>
                    {cov.completeMonths.includes(m) ? '✓' : '\u00a0'}
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.accountId}>
              {!only && (
                <td className="pr-3 whitespace-nowrap">
                  <Link to={`/accounts/${a.accountId}`} className="text-ink hover:underline">
                    {a.name}
                  </Link>
                  {a.source === 'transactions' && (
                    <span className="ml-1 text-ink-3" title="No import records: covered from first to last transaction">
                      *
                    </span>
                  )}
                </td>
              )}
              {a.source === 'none' ? (
                // Tracked by balances or valuations alone: nothing is missing, so no empty months.
                <td colSpan={a.months.length} className="h-6 px-2 text-[11.5px] text-ink-3">
                  no transactions: tracked by its balances
                </td>
              ) : (
                a.months.map((m) => (
                  <td key={m.month} className="h-6 min-w-8 rounded-[3px]" style={{ background: shade(m.fraction) }} title={`${a.name}, ${formatMonth(m.month)}: ${Math.round(m.fraction * 100)}% of days covered`}>
                    <span className="sr-only">
                      {formatMonth(m.month)}: {Math.round(m.fraction * 100)}%
                    </span>
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-3">
        {(
          [
            ['none', 0],
            ['under half', 0.3],
            ['most days', 0.7],
            ['complete', 1],
          ] as const
        ).map(([label, f]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="inline-block size-3 rounded-[3px]" style={{ background: shade(f) }} /> {label}
          </span>
        ))}
        {starred && <span>{only ? 'Covered from its first to its last transaction: there are no statements with dates to go by' : '* covered from its first to its last transaction (no import records)'}</span>}
      </div>
    </div>
  );
}

/** The last day a gap can be confirmed to: where its balances stop, and never today (it is still going). */
function confirmableTo(g: CoverageGapView, now: string): string | null {
  let end = g.evidence.status === 'adds-up' && g.evidence.through ? g.evidence.through : g.to;
  if (end >= now) end = addDays(now, -1);
  return end >= g.from ? end : null;
}

function span(from: string, to: string): string {
  return from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
}

/** What the balances say about a stretch, in words (docs/FORMULAS.md §3, "Balance evidence"). */
function EvidenceText({ e, to }: { e: BalanceEvidence; to: string }) {
  if (e.status === 'adds-up') {
    const start = e.fromOpening ? `the £0 it opened with (${formatDate(e.from!)})` : formatDate(e.from!);
    return (
      <span>
        Balances add up from {start} to {formatDate(e.to!)}
        {e.through && e.through < to ? `, so up to ${formatDate(e.through)}` : ''}
      </span>
    );
  }
  if (e.status === 'unexplained')
    return (
      <span className="text-warn-ink">
        <span className="sensitive">{money(e.difference ?? 0)}</span> unexplained between the balances on {formatDate(e.from!)} and {formatDate(e.to!)}
      </span>
    );
  return <span>{e.from ? `No balance after ${formatDate(e.from)} to check it against` : 'No balance before it to check it against'}</span>;
}

/**
 * The stretches no document covers, with what their balances say, and the ones you confirmed
 * nothing is missing from. A confirmed stretch counts as covered.
 */
export function CoverageGaps({ gaps, confirmations }: { gaps: CoverageGapView[]; confirmations: NonNullable<DataHealthResponse['confirmations']> }) {
  const now = today();
  const toast = useToast();
  const confirm = useApiMutation((stretches: { accountId: string; from: string; to: string }[]) => api<{ added: unknown[] }>('/coverage/confirmations', { method: 'POST', body: { stretches } }), {
    onSuccess: (r) => toast({ tone: 'good', text: r.added.length === 1 ? 'Confirmed: it counts as covered' : `Confirmed ${r.added.length} stretches: they count as covered` }),
    onError: (e) => toast({ tone: 'bad', text: e.message }),
  });
  const withdraw = useApiMutation((id: string) => api(`/coverage/confirmations/${id}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Withdrawn' }) });
  // Days up to today with nothing after the last balance yet: newer documents will cover them.
  const waiting = gaps.filter((g) => g.to >= now && g.evidence.status === 'no-balance');
  const listed = gaps.filter((g) => !waiting.includes(g));
  const addingUp = listed.flatMap((g) => {
    const to = g.evidence.status === 'adds-up' ? confirmableTo(g, now) : null;
    return to ? [{ accountId: g.accountId, from: g.from, to }] : [];
  });
  return (
    <>
      {gaps.length > 0 && (
        <Card
          title="Days no document covers"
          description="Days an account was open that no statement, export or screenshot covers. Where the balances either side add up with the rows recorded, nothing is missing on balance: confirm it, and those days count as covered. Balances show only the net, so a payment and its refund inside would cancel out."
          actions={
            addingUp.length > 1 && (
              <Button size="sm" variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate(addingUp)}>
                Confirm the {addingUp.length} that add up
              </Button>
            )
          }
        >
          <ul className="flex flex-col divide-y divide-line text-[13px]">
            {listed.map((g) => {
              const to = g.evidence.status === 'unexplained' ? null : confirmableTo(g, now);
              return (
                <li key={`${g.accountId}-${g.from}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <div className="min-w-0">
                    <Link to={`/accounts/${g.accountId}`} className="font-medium text-accent hover:underline">
                      {g.name}
                    </Link>{' '}
                    <span className="text-ink-2">
                      {span(g.from, g.to)} ({plural(g.days, 'day')}
                      {g.rows ? `, ${plural(g.rows, 'row')} recorded` : ''})
                    </span>
                    {to && to < g.to && (
                      <span className="font-medium text-ink">
                        {' '}
                        · {g.evidence.status === 'adds-up' ? 'balances confirm' : 'confirms'} to {formatDate(to)}
                      </span>
                    )}
                    <div className="text-ink-3">
                      <EvidenceText e={g.evidence} to={g.evidence.through ?? g.to} />
                    </div>
                  </div>
                  {to && (
                    <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate([{ accountId: g.accountId, from: g.from, to }])}>
                      Confirm nothing missing
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {waiting.length > 0 && (
            <p className={cn('text-[13px] text-ink-3', listed.length > 0 && 'mt-2 border-t border-line pt-2')}>
              Waiting for newer documents:{' '}
              {waiting.map((g, i) => (
                <span key={g.accountId}>
                  {i > 0 && ', '}
                  <Link to={`/accounts/${g.accountId}`} className="text-accent hover:underline">
                    {g.name}
                  </Link>{' '}
                  since {formatDate(g.from)}
                </span>
              ))}
              .
            </p>
          )}
        </Card>
      )}
      {confirmations.length > 0 && (
        <Card title="Confirmed: nothing missing" description="Stretches you confirmed nothing is missing from. They count as covered, like a statement’s period. One whose balances stop adding up is marked.">
          <ul className="flex flex-col divide-y divide-line text-[13px]">
            {confirmations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                <div className="min-w-0">
                  <Link to={`/accounts/${c.accountId}`} className="font-medium text-accent hover:underline">
                    {c.name}
                  </Link>{' '}
                  <span className="text-ink-2">{span(c.from, c.to)}</span> <span className="text-ink-3">· confirmed {formatDate(c.confirmedAt.slice(0, 10))}</span>
                  <div className="text-ink-3">
                    {c.now.status === 'unexplained' ? (
                      <StatusBadge status="warn">
                        Balances no longer add up: <span className="sensitive">{money(c.now.difference ?? 0)}</span> unexplained
                      </StatusBadge>
                    ) : (
                      <EvidenceText e={c.now} to={c.to} />
                    )}
                  </div>
                </div>
                <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate(c.id)}>
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
