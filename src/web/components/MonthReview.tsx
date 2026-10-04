// The Overview's month in review: a month's figures as the app works them out by fixed rules
// (docs/FORMULAS.md §18): where the money went, adding up, and spending by category against the
// months before. Beside them Claude's review of that month, labelled as inference: its headline,
// the few points that mattered, its parts, what it rests on, the fixes it proposed, and how the
// review before's lines to watch turned out.

import { Bot, Calculator, CalendarClock, Check, CircleHelp, ListChecks, ThumbsDown, ThumbsUp, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CoverageResponse, MonthCategory, MonthLine, MonthSummary } from '../../shared/api';
import { formatDate, formatMonth } from '../../shared/dates';
import type { Insight } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, money, pct, plural } from '../lib/format';
import { MiniBars } from './charts/bars';
import { EvidenceChips, EvidenceLinks } from './Intel';
import { Badge, Button, Card, Dialog, EmptyState, Loading, Money, Segmented, Select, Textarea, tableClasses, useToast } from './ui';

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

/** How a line to watch turned out; "done" and "open" are older reviews' words. */
const FOLLOW_UP: Record<string, { label: string; icon: typeof Check }> = {
  happened: { label: 'Happened', icon: Check },
  done: { label: 'Happened', icon: Check },
  'not-happened': { label: 'Didn’t happen', icon: X },
  open: { label: 'Didn’t happen', icon: X },
  unclear: { label: 'Can’t tell', icon: CircleHelp },
};

export function MonthReviewCard() {
  const coverage = useApi<CoverageResponse>(['coverage'], '/coverage');
  const [params, setParams] = useSearchParams();
  const months = [...(coverage.data?.completeMonths ?? [])].reverse();
  const picked = params.get('month') ?? undefined;
  const month = picked && months.includes(picked) ? picked : months[0];
  const latest = months[0];
  const summary = useApi<MonthSummary>(['month', month ?? ''], month ? `/month/${month}` : null);
  const reviews = useApi<Insight[]>(['insights', 'month-review'], '/insights?kind=month-review&all=1');
  const jobs = useApi<JobsView>(['jobs'], '/jobs', { refetchInterval: 15_000 });
  const review = latestReview(reviews.data ?? [], month);
  const pending = (jobs.data?.jobs ?? []).filter((j) => j.kind === 'monthly-review' && (j.status === 'queued' || j.status === 'running'));
  const thisPending = pending.find((j) => j.params.month === month);
  const pick = (m: string) =>
    setParams(
      (p) => {
        p.set('month', m);
        return p;
      },
      { replace: true, preventScrollReset: true },
    );

  if (!coverage.data) return null;
  return (
    <Card
      id="month-review"
      title={
        <span className="inline-flex items-center gap-2">
          <CalendarClock className="size-4 text-ink-3" aria-hidden /> Month in review
        </span>
      }
      description="The month’s figures by the app’s fixed rules, and Claude’s review of them."
      actions={
        months.length > 0 && (
          <div className="flex items-center gap-2">
            <Link to="/reviews" className="text-[12.5px] text-accent hover:underline">
              All reviews
            </Link>
            <Select value={month} onChange={(e) => pick(e.target.value)} aria-label="Month" className="w-40">
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonth(m)}
                </option>
              ))}
            </Select>
          </div>
        )
      }
      padded={false}
    >
      {!month ? (
        <EmptyState title="No complete month yet">A month shows here once every account has data for nearly all of its days.</EmptyState>
      ) : (
        <div className="grid border-t border-line lg:grid-cols-[1fr_1fr]">
          <div className="min-w-0 border-b border-line px-5 py-4 lg:border-r lg:border-b-0">{summary.data ? <Figures s={summary.data} /> : <Loading />}</div>
          <div className="min-w-0 px-5 py-4">
            <Review month={month} review={review} pending={thisPending} latest={month === latest} catchUp={jobs.data?.catchUpMonths ?? []} queued={pending.length} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** The standing review of a month: the active one, else the newest. */
export function latestReview(reviews: Insight[], month: string | undefined): Insight | undefined {
  return reviews.filter((i) => i.subject.month === month && i.status !== 'superseded').sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt.localeCompare(a.createdAt))[0];
}

/** Typical for a line: the median and range of the complete months before, as words. */
function typical(l: Pick<MonthLine, 'compared'>): string {
  const c = l.compared;
  if (!c) return 'no earlier month to compare';
  return `${money(c.median, { decimals: 0 })} typical (${money(c.low, { decimals: 0 })}–${money(c.high, { decimals: 0 })}, ${plural(c.months, 'month')})`;
}

/** Where a figure sits against its range, in words: the table says the figures. */
function against(c: MonthCategory): string | undefined {
  if (!c.compared) return undefined;
  if (c.amount > c.compared.high) return 'above its range';
  if (c.amount < c.compared.low) return 'below its range';
  return undefined;
}

function Figures({ s }: { s: MonthSummary }) {
  const { lines: inLines } = s.moneyIn;
  const old = s.worth.accounts.filter((a) => a.oldValuation);
  const priced = s.worth.accounts.filter((a) => a.basis?.prices);
  const [by, setBy] = useState<'groups' | 'top'>('groups');
  // A line shows when it has something this month or in the months it is compared with.
  const shown = (l: MonthLine) => l.amount !== 0 || (l.compared !== undefined && (l.compared.low !== 0 || l.compared.high !== 0));
  const rows: [string, MonthLine[]][] = [
    ['Money in', inLines.filter(shown)],
    ['Spending', s.spending.lines.filter(shown)],
  ];
  const cats = s.categories[by];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Calculator className="size-3.5" aria-hidden /> Computed from your data{!s.complete && <Badge tone="warn">Some days have no data</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Money in" value={s.moneyIn.total} sub={s.moneyIn.borrowed ? `${money(s.moneyIn.borrowed, { decimals: 0 })} of it borrowed` : undefined} />
        <Figure label="Spent" value={s.spending.total} sub={s.spending.compared ? `typical ${money(s.spending.compared.median, { decimals: 0 })}` : undefined} />
        <Figure label="Left over" value={s.net.amount} sub="income less spending" />
        <Figure label="Worth" value={s.worth.change} sign sub={`${money(s.worth.end, { decimals: 0 })} at the end${s.worth.estimated ? ', partly estimated' : ''}`} />
      </div>

      <section>
        <h3 className="mb-1 text-[12.5px] font-semibold text-ink">Where it went</h3>
        <table className={tableClasses.table}>
          <tbody>
            {s.whereItWent.items.map((i) => (
              <tr key={i.id}>
                <td className={tableClasses.td}>
                  {i.label}
                  {i.parts.length > 0 && (
                    <div className="text-[11.5px] text-ink-3">
                      {i.parts
                        .slice(0, 4)
                        .map((p) => `${p.name} ${money(p.amount, { decimals: 0, sign: i.parts.length > 1 })}`)
                        .join(' · ')}
                      {i.parts.length > 4 && ` · and ${i.parts.length - 4} more`}
                    </div>
                  )}
                </td>
                <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                  <Money value={i.amount} decimals={0} />
                </td>
              </tr>
            ))}
            <tr>
              <td className={cn(tableClasses.td, 'font-medium')}>{s.moneyIn.borrowed ? 'Left over, and borrowed' : 'Left over'}</td>
              <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                <Money value={s.whereItWent.total} decimals={0} />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-[12.5px] font-semibold text-ink">Spending by category</h3>
          <Segmented
            size="sm"
            label="Show"
            value={by}
            onChange={setBy}
            options={[
              { value: 'groups', label: 'Groups' },
              { value: 'top', label: 'Largest' },
            ]}
          />
        </div>
        <div className="overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>{by === 'groups' ? 'Group' : 'Category'}</th>
                <th className={cn(tableClasses.th, 'text-right')}>{formatMonth(s.month, { short: true })}</th>
                <th className={cn(tableClasses.th, 'text-right')}>Typical</th>
                <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>
                  <span className="sr-only">The 12 months up to it</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id}>
                  <td className={tableClasses.td}>
                    {c.name}
                    {(against(c) || c.group) && <div className="text-[11.5px] text-ink-3">{[c.group?.name, against(c)].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={c.amount} decimals={0} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'text-ink-3')} title={c.compared ? `${money(c.compared.low, { decimals: 0 })}–${money(c.compared.high, { decimals: 0 })} over ${plural(c.compared.months, 'month')}` : undefined}>
                    {c.compared ? money(c.compared.median, { decimals: 0 }) : '–'}
                  </td>
                  <td className={cn(tableClasses.td, 'hidden sm:table-cell')}>
                    <MiniBars values={c.history.map((h) => ({ value: h.amount, faint: !h.complete }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11.5px] text-ink-3">
          Typical is the median of the complete months among the 12 before<span className="hidden sm:inline">; the bars are those 12 months, this one last</span>.
        </p>
      </section>

      <details className="group">
        <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">Money in and spending by kind</summary>
        <div className="mt-1 overflow-x-auto">
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
      </details>

      <ul className="flex flex-col gap-1.5 text-[12.5px] text-ink-2">
        {s.borrowed.length > 0 && (
          <li>
            Borrowed: {s.borrowed.map((b) => `${money(Math.abs(b.amount))} ${b.payee} (${formatDate(b.date, { year: false })})`).join(', ')}.
          </li>
        )}
        {s.spending.scheduled.length > 0 && <li>Scheduled: {s.spending.scheduled.map((p) => `${p.payee} ${money(-p.amount, { decimals: 0 })}`).join(', ')}.</li>}
        {s.spending.oneOffs.length > 0 && <li>One-offs: {s.spending.oneOffs.map((p) => `${p.payee} ${money(-p.amount, { decimals: 0 })}`).join(', ')}.</li>}
        {priced.length > 0 && <li>Valued from their holdings at published prices on the day, an estimate: {priced.map((a) => a.name).join(', ')}.</li>}
        {old.length > 0 && <li className="text-warn-ink">Valued at another time, so their change isn’t the month’s: {old.map((a) => `${a.name}${a.basis ? ` (${formatDate(a.basis.date)})` : ''}`).join(', ')}.</li>}
        {(s.quality.uncategorisedSpendingShare ?? 0) > 0.05 && <li>Uncategorised: {pct(s.quality.uncategorisedSpendingShare ?? 0, 0)} of spending.</li>}
        {(s.quality.guessedSpendingShare ?? 0) > 0.05 && (
          <li>
            Guessed from the bank’s category or the reader, not checked: {pct(s.quality.guessedSpendingShare ?? 0, 0)} of spending (
            <Link to="/spending/categorise#guesses" className="text-accent hover:underline">
              Guesses to check
            </Link>
            ).
          </li>
        )}
        {(s.quality.peopleToConfirm.count > 0 || s.quality.cashToConfirm.count > 0) && (
          <li>
            {[s.quality.peopleToConfirm.count > 0 && `${plural(s.quality.peopleToConfirm.count, 'payment')} with people`, s.quality.cashToConfirm.count > 0 && `${money(s.quality.cashToConfirm.amount, { decimals: 0 })} of cash paid in`].filter(Boolean).join(' and ')} to confirm (
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

/** A month's review as written: headline, key points, parts, limits, fixes proposed, lines to watch, and your feedback. */
export function ReviewView({ review, compact = false }: { review: Insight; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[15px] leading-snug font-semibold text-ink">{review.title}</div>
      {review.keyPoints && review.keyPoints.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {review.keyPoints.map((k, i) => (
            <li key={i} className="flex gap-2 text-[13px] text-ink-2">
              <span className="tabular mt-px w-4 shrink-0 text-ink-3">{i + 1}.</span>
              <span>
                {k.text}
                {k.evidence && k.evidence.length > 0 && !compact && (
                  <span className="ml-1.5 text-[11.5px]">
                    <EvidenceChips evidence={k.evidence} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        !review.sections && <p className={cn('text-[13px] whitespace-pre-line text-ink-2', compact && 'line-clamp-4')}>{review.body}</p>
      )}
      {review.unchecked && review.unchecked.length > 0 && (
        <p className="flex items-start gap-1.5 text-[12px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {plural(review.unchecked.length, 'figure')} in this review {review.unchecked.length === 1 ? 'isn’t' : 'aren’t'} in your data as the app has it: {review.unchecked.join(', ')}. Check {review.unchecked.length === 1 ? 'it' : 'them'} before relying on {review.unchecked.length === 1 ? 'it' : 'them'}.
          </span>
        </p>
      )}
      {review.proposals && review.proposals.length > 0 && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <ListChecks className="size-3.5 text-ink-3" aria-hidden />
          It proposed {review.proposals.length === 1 ? 'a fix' : `${review.proposals.length} fixes`} to your data:
          {review.proposals.map((id, i) => (
            <Link key={id} to={`/proposals/${id}`} className="text-accent hover:underline">
              {review.proposals!.length === 1 ? 'review it' : `fix ${i + 1}`}
            </Link>
          ))}
        </p>
      )}
      {!compact && review.sections && review.sections.length > 0 && (
        <div className="flex flex-col divide-y divide-line rounded-md border border-line">
          {review.sections.map((x, i) => (
            <details key={x.id} open={i === 0} className="group px-3 py-2">
              <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">{x.heading}</summary>
              <p className="mt-1 text-[13px] whitespace-pre-line text-ink-2">{x.body}</p>
            </details>
          ))}
        </div>
      )}
      {!compact && review.caveats && review.caveats.length > 0 && (
        <div>
          <div className="mb-0.5 text-[12px] font-medium text-ink">What this rests on</div>
          <ul className="list-disc pl-5 text-[12px] text-ink-3">
            {review.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {review.followUp && review.followUp.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-medium text-ink">What the month before said to watch</div>
          <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
            {review.followUp.map((f) => {
              const o = FOLLOW_UP[f.outcome] ?? { label: f.outcome, icon: CircleHelp };
              const Icon = o.icon;
              return (
                <li key={f.watch} className="flex items-baseline gap-2">
                  <Badge tone={f.outcome === 'unclear' ? 'muted' : 'neutral'} icon={<Icon className="size-3" aria-hidden />}>
                    {o.label}
                  </Badge>
                  <span>
                    {f.watch}
                    {f.note && !compact && <span className="text-ink-3"> · {f.note}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!compact && review.watch && review.watch.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-medium text-ink">To watch next month</div>
          <ul className="list-disc pl-5 text-[12.5px] text-ink-2">
            {review.watch.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <Feedback review={review} compact={compact} />
    </div>
  );
}

/** Your reaction to a review, with a note: later reviews read both. */
function Feedback({ review, compact }: { review: Insight; compact: boolean }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(review.feedback?.note ?? '');
  const feedback = useApiMutation((v: { useful: boolean; note?: string }) => api(`/insights/${review.id}/feedback`, { method: 'POST', body: v }), { onSuccess: () => setNoting(false) });
  const useful = review.feedback?.useful;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
        <Badge tone={review.confidence === 'high' ? 'neutral' : 'muted'}>{review.confidence} confidence</Badge>
        {review.status === 'dismissed' && <Badge tone="muted">Dismissed</Badge>}
        {!compact && (
          <span>
            Evidence: <EvidenceLinks insight={review} />
          </span>
        )}
        <span title={`${review.provenance.model ?? ''} · prompt ${review.provenance.promptVersion ?? ''}`}>Written {formatDate(review.createdAt.slice(0, 10))}</span>
        <button type="button" className={cn('rounded p-1 hover:bg-panel-2', useful === true ? 'text-good-ink' : 'text-ink-3')} aria-label="Useful" title="Useful: later reviews read this" onClick={() => feedback.mutate({ useful: true, ...(note.trim() ? { note: note.trim() } : {}) })}>
          <ThumbsUp className="size-3.5" />
        </button>
        <button type="button" className={cn('rounded p-1 hover:bg-panel-2', useful === false ? 'text-bad-ink' : 'text-ink-3')} aria-label="Not useful" title="Not useful: later reviews read this" onClick={() => feedback.mutate({ useful: false, ...(note.trim() ? { note: note.trim() } : {}) })}>
          <ThumbsDown className="size-3.5" />
        </button>
        <button type="button" className="text-accent hover:underline" onClick={() => setNoting((v) => !v)}>
          {review.feedback?.note ? 'Your note' : 'Add a note'}
        </button>
      </div>
      {review.feedback?.note && !noting && <p className="text-[12px] text-ink-2">“{review.feedback.note}”</p>}
      {noting && (
        <div className="flex flex-col gap-1.5">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="What was right, wrong or missing: the next review reads it." aria-label="Your note on this review" />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={feedback.isPending} disabled={!note.trim()} onClick={() => feedback.mutate({ useful: useful ?? true, note: note.trim() })}>
              Save note
            </Button>
            <Button size="sm" onClick={() => setNoting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Bot className="size-3.5" aria-hidden /> Claude’s review: inferred, not calculated
      </div>
      {pending && <Badge tone="accent">{pending.status === 'running' ? 'Writing this review now' : 'This review is queued'}</Badge>}
      {review ? <ReviewView review={review} /> : <p className="text-[13px] text-ink-3">No review of {formatMonth(month)} yet.</p>}
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
        description={`${formatMonth(catchUp[0] ?? month)} to ${formatMonth(catchUp[catchUp.length - 1] ?? month)}: ${plural(catchUp.length, 'month')} with no review by the current prompt.`}
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
          Each is a Claude run on your plan (about $0.50 to $1 each). They run one after another, oldest first, so each reads the ones before; each is written as at its month’s end, with nothing from after it. A month with a review already gets a new one in its place. Write this month’s review after them.
        </p>
      </Dialog>
    </div>
  );
}
