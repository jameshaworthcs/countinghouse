// The Overview's month in review: a month's figures as the app works them out by fixed rules
// (docs/FORMULAS.md §18), and beside them Claude's review of that month, labelled as inference, with
// what it said to watch and how the review before's lines turned out.

import { Bot, Calculator, CalendarClock, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { CoverageResponse, MonthLine, MonthSummary } from '../../shared/api';
import { formatDate, formatMonth } from '../../shared/dates';
import type { Insight } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, money, pct, plural } from '../lib/format';
import { EvidenceLinks } from './Intel';
import { Badge, Button, Card, Dialog, EmptyState, Loading, Money, Select, tableClasses, useToast } from './ui';

interface MonthJob {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}

interface JobsView {
  jobs: MonthJob[];
  catchUpMonths?: string[];
}

const FOLLOW_UP: Record<string, { label: string; tone: 'good' | 'warn' | 'muted' }> = { done: { label: 'Done', tone: 'good' }, open: { label: 'Still open', tone: 'warn' }, unclear: { label: 'Unclear', tone: 'muted' } };

export function MonthReviewCard() {
  const coverage = useApi<CoverageResponse>(['coverage'], '/coverage');
  const months = [...(coverage.data?.completeMonths ?? [])].reverse();
  const [picked, setPicked] = useState<string | undefined>();
  const month = picked && months.includes(picked) ? picked : months[0];
  const latest = months[0];
  const summary = useApi<MonthSummary>(['month', month ?? ''], month ? `/month/${month}` : null);
  const reviews = useApi<Insight[]>(['insights', 'month-review'], '/insights?kind=month-review&all=1');
  const jobs = useApi<JobsView>(['jobs'], '/jobs', { refetchInterval: 15_000 });
  const review = (reviews.data ?? []).filter((i) => i.subject.month === month && i.status !== 'superseded').sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt.localeCompare(a.createdAt))[0];
  const pending = (jobs.data?.jobs ?? []).filter((j) => j.kind === 'monthly-review' && (j.status === 'queued' || j.status === 'running'));
  const thisPending = pending.find((j) => j.params.month === month);

  if (!coverage.data) return null;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <CalendarClock className="size-4 text-ink-3" aria-hidden /> Month in review
        </span>
      }
      description="The month’s figures by the app’s fixed rules, and Claude’s review of them."
      actions={
        months.length > 0 && (
          <Select value={month} onChange={(e) => setPicked(e.target.value)} aria-label="Month" className="w-40">
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonth(m)}
              </option>
            ))}
          </Select>
        )
      }
      padded={false}
    >
      {!month ? (
        <EmptyState title="No complete month yet">A month shows here once every account has data for nearly all of its days.</EmptyState>
      ) : (
        <div className="grid border-t border-line lg:grid-cols-[1.15fr_1fr]">
          <div className="border-b border-line px-5 py-4 lg:border-r lg:border-b-0">{summary.data ? <Figures s={summary.data} /> : <Loading />}</div>
          <div className="px-5 py-4">
            <Review month={month} review={review} pending={thisPending} latest={month === latest} catchUp={jobs.data?.catchUpMonths ?? []} queued={pending.length} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Typical for a line: the median and range of the complete months before, as words. */
function typical(l: Pick<MonthLine, 'compared'>): string {
  const c = l.compared;
  if (!c) return 'no earlier month to compare';
  return `${money(c.median, { decimals: 0 })} typical (${money(c.low, { decimals: 0 })}–${money(c.high, { decimals: 0 })}, ${plural(c.months, 'month')})`;
}

function Figures({ s }: { s: MonthSummary }) {
  const { lines: inLines } = s.moneyIn;
  const old = s.worth.accounts.filter((a) => a.oldValuation);
  // A line shows when it has something this month or in the months it is compared with.
  const shown = (l: MonthLine) => l.amount !== 0 || (l.compared !== undefined && (l.compared.low !== 0 || l.compared.high !== 0));
  const rows: [string, MonthLine[]][] = [
    ['Money in', inLines.filter(shown)],
    ['Spending', s.spending.lines.filter(shown)],
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Calculator className="size-3.5" aria-hidden /> Computed from your data{!s.complete && <Badge tone="warn">Some days have no data</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Money in" value={s.moneyIn.total} sub={s.moneyIn.borrowed ? `${money(s.moneyIn.borrowed, { decimals: 0 })} of it borrowed` : undefined} />
        <Figure label="Spent" value={s.spending.total} sub={s.spending.compared ? `typical ${money(s.spending.compared.median, { decimals: 0 })}` : undefined} />
        <Figure label="Left over" value={s.net.amount} sub="income less spending" />
        <Figure label="Worth" value={s.worth.change} sign sub={`${money(s.worth.end, { decimals: 0 })} at the end${s.worth.estimated ? ', partly estimated' : ''}`} />
      </div>
      <div className="overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Line</th>
              <th className={cn(tableClasses.th, 'text-right')}>{formatMonth(s.month, { short: true })}</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Against the months before</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([title, lines]) => [
              <tr key={title}>
                <td colSpan={3} className="px-3 pt-3 pb-1 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  {title}
                </td>
              </tr>,
              ...lines.map((l) => (
                <tr key={`${title}-${l.id}`}>
                  <td className={tableClasses.td}>
                    {l.label}
                    <div className="text-[11.5px] text-ink-3 sm:hidden">{typical(l)}</div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={l.amount} decimals={0} />
                  </td>
                  <td className={cn(tableClasses.td, 'hidden text-[12px] text-ink-3 sm:table-cell')}>{typical(l)}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-1.5 text-[12.5px] text-ink-2">
        {s.borrowed.length > 0 && (
          <li>
            Borrowed: {s.borrowed.map((b) => `${money(Math.abs(b.amount))} ${b.payee} (${formatDate(b.date, { year: false })})`).join(', ')}.
          </li>
        )}
        {s.spending.scheduled.length > 0 && <li>Scheduled: {s.spending.scheduled.map((p) => `${p.payee} ${money(-p.amount, { decimals: 0 })}`).join(', ')}.</li>}
        {s.spending.oneOffs.length > 0 && <li>One-offs: {s.spending.oneOffs.map((p) => `${p.payee} ${money(-p.amount, { decimals: 0 })}`).join(', ')}.</li>}
        {s.moved.length > 0 && <li>Moved: {s.moved.map((m) => `${m.amount >= 0 ? 'to' : 'from'} ${m.label} ${money(Math.abs(m.amount), { decimals: 0 })}`).join(', ')}.</li>}
        {old.length > 0 && <li className="text-warn-ink">Valued long before the month ended, so their change isn’t the month’s: {old.map((a) => `${a.name}${a.basis ? ` (${formatDate(a.basis.date)})` : ''}`).join(', ')}.</li>}
        {(s.quality.uncategorisedSpendingShare ?? 0) > 0.05 && <li>Uncategorised: {pct(s.quality.uncategorisedSpendingShare ?? 0, 0)} of spending.</li>}
        {s.quality.peopleToConfirm.count > 0 && (
          <li>
            {plural(s.quality.peopleToConfirm.count, 'payment')} with people to confirm (
            <Link to="/spending/categorise" className="text-accent hover:underline">
              To categorise
            </Link>
            ).
          </li>
        )}
        {s.coming.length > 0 && <li>Coming in the 60 days after: {s.coming.map((c) => `${formatDate(c.date, { year: false })} ${c.direction === 'in' ? '+' : '−'}${money(c.amount, { decimals: 0 })} ${c.name}`).join(', ')}.</li>}
      </ul>
    </div>
  );
}

function Figure({ label, value, sub, sign }: { label: string; value: number; sub?: string | undefined; sign?: boolean }) {
  return (
    <div>
      <div className="text-[12px] text-ink-3">{label}</div>
      <Money value={value} decimals={0} sign={sign} className="tabular text-[17px] font-semibold text-ink" />
      {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Review({ month, review, pending, latest, catchUp, queued }: { month: string; review: Insight | undefined; pending: MonthJob | undefined; latest: boolean; catchUp: string[]; queued: number }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const write = useApiMutation(() => api('/jobs', { method: 'POST', body: { kind: 'monthly-review', params: { month } } }), { onSuccess: () => toast({ tone: 'good', text: `Writing the review of ${formatMonth(month)}` }) });
  const earlier = useApiMutation(() => api<{ months: string[] }>('/jobs/month-reviews', { method: 'POST' }), {
    onSuccess: (r) => {
      setConfirm(false);
      toast({ tone: 'good', text: r.months.length ? `${plural(r.months.length, 'review')} queued, oldest first` : 'Every earlier month has a review' });
    },
  });
  const feedback = useApiMutation((useful: boolean) => api(`/insights/${review!.id}/feedback`, { method: 'POST', body: { useful } }));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Bot className="size-3.5" aria-hidden /> Claude’s review: inferred, not calculated
      </div>
      {pending && <Badge tone="accent">{pending.status === 'running' ? 'Writing this review now' : 'This review is queued'}</Badge>}
      {review ? (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[14px] font-semibold text-ink">{review.title}</div>
            <p className="mt-1 text-[13px] whitespace-pre-line text-ink-2">{review.body}</p>
          </div>
          {review.followUp && review.followUp.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-ink">What the month before said to watch</div>
              <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                {review.followUp.map((f) => (
                  <li key={f.watch} className="flex items-baseline gap-2">
                    <Badge tone={FOLLOW_UP[f.outcome]?.tone ?? 'muted'}>{FOLLOW_UP[f.outcome]?.label ?? f.outcome}</Badge>
                    <span>
                      {f.watch}
                      {f.note && <span className="text-ink-3"> · {f.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {review.watch && review.watch.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-ink">To watch next month</div>
              <ul className="list-disc pl-5 text-[12.5px] text-ink-2">
                {review.watch.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
            <Badge tone={review.confidence === 'high' ? 'neutral' : 'muted'}>{review.confidence} confidence</Badge>
            {review.status === 'dismissed' && <Badge tone="muted">Dismissed</Badge>}
            <span>
              Evidence: <EvidenceLinks insight={review} />
            </span>
            <span title={`${review.provenance.model ?? ''} · prompt ${review.provenance.promptVersion ?? ''}`}>Written {formatDate(review.createdAt.slice(0, 10))}</span>
            <button type="button" className={cn('rounded p-1 hover:bg-panel-2', review.feedback?.useful === true ? 'text-good-ink' : 'text-ink-3')} aria-label="Useful" title="Useful: later reviews read this" onClick={() => feedback.mutate(true)}>
              <ThumbsUp className="size-3.5" />
            </button>
            <button type="button" className={cn('rounded p-1 hover:bg-panel-2', review.feedback?.useful === false ? 'text-bad-ink' : 'text-ink-3')} aria-label="Not useful" title="Not useful: later reviews read this" onClick={() => feedback.mutate(false)}>
              <ThumbsDown className="size-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">No review of {formatMonth(month)} yet.</p>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {latest && (
          <Button size="sm" variant={review ? 'secondary' : 'primary'} disabled={Boolean(pending)} loading={write.isPending} onClick={() => write.mutate(undefined)}>
            {review ? 'Write this month’s review again' : 'Write this month’s review'}
          </Button>
        )}
        {catchUp.length > 0 && (
          <Button size="sm" onClick={() => setConfirm(true)}>
            Write reviews for earlier months ({catchUp.length})
          </Button>
        )}
        {queued > 0 && <span className="self-center text-[12px] text-ink-3">{plural(queued, 'review')} queued or running</span>}
      </div>
      {(write.error || earlier.error) && <div className="text-[12px] text-bad-ink">{(write.error ?? earlier.error)!.message}</div>}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Write reviews for earlier months?"
        description={`${formatMonth(catchUp[0] ?? month)} to ${formatMonth(catchUp[catchUp.length - 1] ?? month)}: ${plural(catchUp.length, 'month')} with no review.`}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" loading={earlier.isPending} onClick={() => earlier.mutate(undefined)}>
              Write {plural(catchUp.length, 'review')}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          Each is a Claude run on your plan (about $0.50 each). They run one after another, oldest first, so each reads the one before; each is written as at its month’s end, with nothing from after it. Write this month’s review after them.
        </p>
      </Dialog>
    </div>
  );
}
