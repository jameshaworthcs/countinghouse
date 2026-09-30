// A proposed fix, for you to review: what the agent found, each change with the rows it is about and
// its reason, checked against your data as you choose which to apply (src/server/proposals.ts).
// A run of category changes with one reason (one pattern across years of history) shows as a table.

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, CircleDashed, Info, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ProposalCheckResponse, ProposalView } from '../../shared/api';
import type { ProposedChange } from '../../shared/schema';
import { CHANGE_LABELS, ChangeBody, proposedBy, useProposals } from '../components/Proposals';
import { Badge, Button, Callout, Card, Checkbox, Dialog, ErrorNote, Field, Loading, PageHeader, StatusBadge, Textarea, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural, timeAgo } from '../lib/format';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

type Result = { problem?: string; alreadySo?: true };
type CategoryChange = Extract<ProposedChange, { kind: 'set_category' }>;
/** A change on its own, or a run of category changes to one category for one reason. */
type Block = { kind: 'one'; change: ProposedChange; index: number } | { kind: 'categories'; category: string; why: string; items: { change: CategoryChange; index: number }[] };

/** Runs this long or longer show as a table. */
const TABLE_FROM = 4;
/** A table's rows shown before "Show all". */
const TABLE_ROWS = 25;

function blocksOf(changes: ProposedChange[]): Block[] {
  const blocks: Block[] = [];
  let run: Extract<Block, { kind: 'categories' }> | undefined;
  const flush = () => {
    if (!run) return;
    if (run.items.length >= TABLE_FROM) blocks.push(run);
    else for (const it of run.items) blocks.push({ kind: 'one', ...it });
    run = undefined;
  };
  changes.forEach((change, index) => {
    if (change.kind === 'set_category') {
      if (!run || run.category !== change.category || run.why !== change.why) {
        flush();
        run = { kind: 'categories', category: change.category, why: change.why, items: [] };
      }
      run.items.push({ change, index });
      return;
    }
    flush();
    blocks.push({ kind: 'one', change, index });
  });
  flush();
  return blocks;
}

interface Choosing {
  view: ProposalView;
  pending: boolean;
  leaveOut: ReadonlySet<string>;
  applied: ReadonlySet<string>;
  results: Map<string, Result>;
  setIncluded: (keys: string[], include: boolean) => void;
}

function ChangeItem({ change: c, index: i, view, pending, leaveOut, applied, results, setIncluded }: Choosing & { change: ProposedChange; index: number }) {
  const out = pending ? leaveOut.has(c.key) : !applied.has(c.key);
  const r = pending && !out ? results.get(c.key) : undefined;
  const label = CHANGE_LABELS[c.kind];
  return (
    <li className={cn('px-5 py-4', out && pending && 'bg-panel-2/50')}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          {pending ? (
            <Checkbox checked={!out} onChange={(v) => setIncluded([c.key], v)} label={<span className="sr-only">Apply change {i + 1}</span>} />
          ) : applied.has(c.key) ? (
            <CircleCheck className="size-4 text-good-ink" aria-label="applied" />
          ) : (
            <CircleDashed className="size-4 text-ink-3" aria-label="not applied" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-[12px] text-ink-3 tabular-nums">{i + 1}.</span>
            <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-ink">
              <span className="text-accent">{label.icon}</span>
              {label.title}
            </span>
            {r?.alreadySo && <Badge tone="neutral">Already so: nothing to do</Badge>}
            {r?.problem && <StatusBadge status="warn">Does not fit your data</StatusBadge>}
            {out && <Badge tone="muted">{pending ? 'Left out' : 'Not applied'}</Badge>}
          </div>
          <div className={cn('mt-2.5', out && 'opacity-55')}>
            <ChangeBody change={c} view={view} />
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            <span className="font-medium text-ink-2">Why: </span>
            {c.why}
          </p>
          {r?.problem && <p className="mt-1 text-[12.5px] text-bad-ink">{r.problem}</p>}
        </div>
      </div>
    </li>
  );
}

/** Many rows given one category for one reason: a table, each row ticked in or out. */
function CategoryTable({ block, view, pending, leaveOut, applied, results, setIncluded }: Choosing & { block: Extract<Block, { kind: 'categories' }> }) {
  const { cats, accountName } = useAppData();
  const [all, setAll] = useState(false);
  const keys = block.items.map((it) => it.change.key);
  const inCount = pending ? keys.filter((k) => !leaveOut.has(k)).length : keys.filter((k) => applied.has(k)).length;
  const rows = block.items.map((it) => ({ ...it, row: view.rows[it.change.transaction] }));
  const out = rows.reduce((s, r) => s + Math.min(0, Math.round((r.row?.amount ?? 0) * 100)), 0) / 100;
  const inn = rows.reduce((s, r) => s + Math.max(0, Math.round((r.row?.amount ?? 0) * 100)), 0) / 100;
  const dates = rows.flatMap((r) => (r.row && !r.row.missing ? [r.row.date] : [])).sort();
  const misfits = pending ? rows.filter((r) => !leaveOut.has(r.change.key) && results.get(r.change.key)?.problem) : [];
  const shown = all ? rows : rows.slice(0, TABLE_ROWS);
  const first = block.items[0]!.index + 1;
  const last = block.items[block.items.length - 1]!.index + 1;
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          {pending ? (
            <Checkbox checked={inCount > 0} indeterminate={inCount > 0 && inCount < keys.length} onChange={(v) => setIncluded(keys, v)} label={<span className="sr-only">Apply changes {first} to {last}</span>} />
          ) : inCount ? (
            <CircleCheck className="size-4 text-good-ink" aria-label="applied" />
          ) : (
            <CircleDashed className="size-4 text-ink-3" aria-label="not applied" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-ink-3 tabular-nums">
              {first}–{last}.
            </span>
            <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-ink">
              <Tag className="size-4 text-accent" aria-hidden />
              {plural(keys.length, 'row')} to
            </span>
            <Badge tone="accent">{cats.path(block.category)}</Badge>
            {inCount < keys.length && <Badge tone="muted">{pending ? `${keys.length - inCount} left out` : `${keys.length - inCount} not applied`}</Badge>}
            {misfits.length > 0 && <StatusBadge status="warn">{plural(misfits.length, 'row')} no longer fit</StatusBadge>}
          </div>
          {dates.length > 0 && (
            <p className="mt-1 text-[12.5px] text-ink-3">
              {formatDate(dates[0]!)} to {formatDate(dates[dates.length - 1]!)}: <span className="sensitive">{money(-out)}</span> out and <span className="sensitive">{money(inn)}</span> in
            </p>
          )}
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            <span className="font-medium text-ink-2">Why: </span>
            {block.why}
          </p>
          <div className="mt-2.5 overflow-hidden rounded-lg border border-line">
            <table className="w-full table-fixed text-[12.5px]">
              <thead className="bg-panel-2 text-left text-[11.5px] text-ink-3">
                <tr>
                  <th className="w-9 px-2 py-1.5" aria-label="Apply" />
                  <th className="w-24 px-2 py-1.5 font-medium">Date</th>
                  <th className="hidden w-40 px-2 py-1.5 font-medium sm:table-cell">Account</th>
                  <th className="px-2 py-1.5 font-medium">Description</th>
                  <th className="w-24 px-2 py-1.5 text-right font-medium">Amount</th>
                  <th className="hidden w-32 px-2 py-1.5 font-medium md:table-cell">Now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map(({ change, index, row }) => {
                  const left = pending ? leaveOut.has(change.key) : !applied.has(change.key);
                  const r = pending && !left ? results.get(change.key) : undefined;
                  return (
                    <tr key={change.key} className={cn(left && 'bg-panel-2/50 text-ink-3')}>
                      <td className="px-2 py-1.5 align-top">
                        {pending ? (
                          <Checkbox checked={!left} onChange={(v) => setIncluded([change.key], v)} label={<span className="sr-only">Apply change {index + 1}</span>} />
                        ) : applied.has(change.key) ? (
                          <CircleCheck className="size-3.5 text-good-ink" aria-label="applied" />
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 align-top whitespace-nowrap tabular-nums">{row && !row.missing ? formatDate(row.date) : '—'}</td>
                      <td className="hidden truncate px-2 py-1.5 align-top sm:table-cell">{row && !row.missing ? (view.accounts[row.accountId]?.name ?? accountName(row.accountId)) : ''}</td>
                      <td className="px-2 py-1.5 align-top">
                        <div className="sensitive truncate" title={row?.description}>
                          {row?.missing ? 'No longer in your data' : row?.description}
                        </div>
                        {r?.problem && <div className="text-[11.5px] text-bad-ink">{r.problem}</div>}
                        {r?.alreadySo && <div className="text-[11.5px] text-ink-3">Already so</div>}
                      </td>
                      <td className={cn('sensitive px-2 py-1.5 text-right align-top whitespace-nowrap tabular-nums', row && row.amount > 0 && 'text-good-ink')}>{row && !row.missing ? money(row.amount, { currency: row.currency, sign: true }) : ''}</td>
                      <td className="hidden truncate px-2 py-1.5 align-top md:table-cell">{row && !row.missing ? cats.name(row.category) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > TABLE_ROWS && (
              <div className="border-t border-line bg-panel-2/40 px-3 py-1.5 text-center">
                <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
                  {all ? `Show the first ${TABLE_ROWS}` : `Show all ${rows.length}`}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default function Proposal() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi<ProposalView>(['proposal', id], `/proposals/${id}`);
  const list = useProposals();
  const [leaveOut, setLeaveOut] = useState<ReadonlySet<string>>(new Set());
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const view = q.data;
  const pending = view?.proposal.status === 'pending';
  const left = [...leaveOut].sort();
  const blocks = useMemo(() => (view ? blocksOf(view.proposal.changes) : []), [view]);

  // With changes left out, the server checks the rest again: a link may need an unlink you left out.
  const check = useQuery<ProposalCheckResponse>({
    queryKey: ['proposal', id, 'check', left.join(','), view?.proposal.updatedAt],
    queryFn: () => api<ProposalCheckResponse>(`/proposals/${id}/check`, { body: { leaveOut: left } }),
    enabled: pending && left.length > 0,
    placeholderData: (prev) => prev,
  });
  const results = useMemo(() => {
    const map = new Map<string, Result>();
    if (!view) return map;
    if (left.length && check.data) for (const c of check.data.changes) map.set(c.key, c);
    else for (const c of view.changes) map.set(c.change.key, c);
    return map;
  }, [view, check.data, left.length]);

  const next = () => list.data?.pending.find((v) => v.proposal.id !== id)?.proposal.id;
  const leave = () => void navigate(next() ? `/proposals/${next()}` : '/import#proposals');
  const apply = useApiMutation(() => api<ProposalView>(`/proposals/${id}/apply`, { body: { leaveOut: left } }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: `Applied ${plural(r.proposal.applied?.length ?? 0, 'change')}` });
      leave();
    },
    onError: () => undefined,
  });
  const dismiss = useApiMutation(() => api<ProposalView>(`/proposals/${id}/dismiss`, { body: reason.trim() ? { reason: reason.trim() } : {} }), {
    onSuccess: () => {
      setDismissing(false);
      toast({ tone: 'neutral', text: 'Dismissed: nothing changed' });
      leave();
    },
  });

  if (q.error) return <ErrorNote error={q.error} />;
  if (!view) return <Loading />;
  const p = view.proposal;
  const included = p.changes.filter((c) => !leaveOut.has(c.key));
  const problems = included.filter((c) => results.get(c.key)?.problem);
  const alreadySo = included.filter((c) => results.get(c.key)?.alreadySo).length;
  const ready = included.length - problems.length - alreadySo;
  const applied = new Set(p.applied ?? []);
  const setIncluded = (keys: string[], include: boolean) => {
    const nextSet = new Set(leaveOut);
    for (const key of keys) {
      if (include) nextSet.delete(key);
      else nextSet.add(key);
    }
    setLeaveOut(nextSet);
  };
  const choosing: Choosing = { view, pending, leaveOut, applied, results, setIncluded };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={p.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {p.status === 'pending' ? <StatusBadge status="info">Waiting for you</StatusBadge> : p.status === 'applied' ? <StatusBadge status="good">Applied</StatusBadge> : <Badge tone="muted">Dismissed</Badge>}
            <span>
              Proposed by {proposedBy(p.provenance)} · {timeAgo(p.createdAt)}
            </span>
          </span>
        }
        actions={
          <Link to="/import#proposals">
            <Button variant="ghost" icon={<ArrowLeft className="size-4" />}>
              All proposals
            </Button>
          </Link>
        }
      />

      {p.status === 'applied' && (
        <Callout tone="good" className="mb-5" title={`Applied ${when(p.decidedAt!)}`}>
          {applied.size} of {plural(p.changes.length, 'change')} applied. The rows below are as they were before, so you can see what changed. It is kept in your data’s history.
        </Callout>
      )}
      {p.status === 'dismissed' && (
        <Callout tone="neutral" className="mb-5" title={`Dismissed ${when(p.decidedAt!)}`}>
          Nothing in your data changed.{p.dismissedReason ? ` You said: “${p.dismissedReason}”` : ''}
        </Callout>
      )}

      <Card title="What the agent found" className="mb-5">
        <p className="text-[14px] leading-relaxed whitespace-pre-line text-ink-2">{p.summary}</p>
      </Card>

      <Card
        title={`${p.status === 'pending' ? 'Changes it proposes' : 'Changes'} (${p.changes.length})`}
        description={pending ? 'They apply in this order. Untick any you disagree with: the rest are checked again, in case one needs another.' : undefined}
        padded={false}
        actions={
          pending && p.changes.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => setLeaveOut(leaveOut.size ? new Set() : new Set(p.changes.map((c) => c.key)))}>
              {leaveOut.size ? 'Include all' : 'Leave all out'}
            </Button>
          ) : undefined
        }
      >
        <ol className="divide-y divide-line border-t border-line">
          {blocks.map((b) => (b.kind === 'one' ? <ChangeItem key={b.change.key} change={b.change} index={b.index} {...choosing} /> : <CategoryTable key={b.items[0]!.change.key} block={b} {...choosing} />))}
        </ol>
      </Card>

      {pending && (
        <div className="no-print sticky bottom-3 z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-lg">
          <div className="text-[13px] text-ink-2">
            <Info className="mr-1 inline size-4 text-accent" aria-hidden />
            {ready ? (
              <>
                Applies <span className="font-semibold text-ink">{plural(ready, 'change')}</span>
              </>
            ) : (
              'Nothing to apply'
            )}
            {alreadySo > 0 && `, skips ${alreadySo} already so`}
            {leaveOut.size > 0 && `, leaves ${leaveOut.size} out`}
            {problems.length > 0 && <span className="text-bad-ink"> · {plural(problems.length, 'change')} to leave out first</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {problems.length > 0 && (
              <Button size="sm" onClick={() => setLeaveOut(new Set([...leaveOut, ...problems.map((c) => c.key)]))}>
                Leave out {problems.length === 1 ? 'the one that does not fit' : `the ${problems.length} that do not fit`}
              </Button>
            )}
            <Button onClick={() => setDismissing(true)}>Dismiss</Button>
            <Button variant="primary" disabled={!ready || problems.length > 0 || check.isFetching} loading={apply.isPending} onClick={() => apply.mutate(undefined)}>
              Apply {ready ? plural(ready, 'change') : ''}
            </Button>
          </div>
          {apply.error && <div className="w-full text-[12.5px] text-bad-ink">{apply.error.message}</div>}
        </div>
      )}
      {pending && <p className="mt-3 text-center text-[12px] text-ink-3">Nothing changes until you apply. Each change is checked against your data again as it is applied, and the proposal is kept in your data’s history with what it changed.</p>}

      <Dialog
        open={dismissing}
        onOpenChange={setDismissing}
        title="Dismiss this proposal?"
        description="Nothing in your data changes. It is kept, so the same fix is not proposed again."
        footer={
          <>
            <Button onClick={() => setDismissing(false)}>Cancel</Button>
            <Button variant="danger" loading={dismiss.isPending} onClick={() => dismiss.mutate(undefined)}>
              Dismiss
            </Button>
          </>
        }
      >
        <Field label="Why (optional)" hint="Agents read this, so they know what you do not want.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="e.g. That payment did go to my saver" />
        </Field>
        {dismiss.error && <Callout tone="bad" className="mt-3">{dismiss.error.message}</Callout>}
      </Dialog>
    </div>
  );
}
