// A proposed fix, for you to review: what the agent found, each change with the rows it is about and
// its reason, checked against your data as you choose which to apply (src/server/proposals.ts).
// A run of category changes with one reason (one pattern across years of history) shows as a table.
// ‹ › (or the arrow keys) move through the ones waiting, leaving any undecided. Once you decide one,
// the next one waiting opens under a note of what you did, and its buttons wait a moment.

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleCheck, CircleDashed, Info, Tag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { ProposalCheckResponse, ProposalDecision, ProposalView } from '../../shared/api';
import type { ProposedChange } from '../../shared/schema';
import { CHANGE_LABELS, ChangeBody, DecidedNotice, ProposalStatusBadge, proposedBy, useProposals, type DecidedHandoff, type DecidedState } from '../components/Proposals';
import { Badge, Button, Callout, Card, Checkbox, Dialog, ErrorNote, Field, Kbd, Loading, PageHeader, StatusBadge, Textarea } from '../components/ui';
import { api, useApiMutation, type ApiError } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural, timeAgo } from '../lib/format';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** How long the next proposal's buttons wait after it opens on a decision: a second click meant for the last one lands on nothing. */
const ARRIVAL_PAUSE_MS = 1200;

/** The changes you left out of each proposal, kept while you look at the others (this tab only). */
const leftOutKey = (id: string) => `finance.proposal.leftOut.${id}`;
function readLeftOut(id: string): ReadonlySet<string> {
  try {
    const keys: unknown = JSON.parse(sessionStorage.getItem(leftOutKey(id)) ?? '[]');
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}
function keepLeftOut(id: string, keys: ReadonlySet<string>): void {
  try {
    if (keys.size) sessionStorage.setItem(leftOutKey(id), JSON.stringify([...keys]));
    else sessionStorage.removeItem(leftOutKey(id));
  } catch {
    // Storage is off (a private window): the choice lasts while the page is open.
  }
}

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
  /** Waiting, with something to choose: it is not already done. */
  pending: boolean;
  /** Already done (closed as such, or about to be): each change is already so. */
  superseded: boolean;
  leaveOut: ReadonlySet<string>;
  applied: ReadonlySet<string>;
  results: Map<string, Result>;
  setIncluded: (keys: string[], include: boolean) => void;
}

function ChangeItem({ change: c, index: i, view, pending, superseded, leaveOut, applied, results, setIncluded }: Choosing & { change: ProposedChange; index: number }) {
  const out = pending ? leaveOut.has(c.key) : !superseded && !applied.has(c.key);
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
          ) : superseded ? (
            <CircleCheck className="size-4 text-ink-3" aria-label="already so" />
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
            {superseded ? <Badge tone="neutral">Already so</Badge> : r?.alreadySo && <Badge tone="neutral">Already so: nothing to do</Badge>}
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
function CategoryTable({ block, view, pending, superseded, leaveOut, applied, results, setIncluded }: Choosing & { block: Extract<Block, { kind: 'categories' }> }) {
  const { cats, accountName } = useAppData();
  const [all, setAll] = useState(false);
  const keys = block.items.map((it) => it.change.key);
  const inCount = pending ? keys.filter((k) => !leaveOut.has(k)).length : superseded ? keys.length : keys.filter((k) => applied.has(k)).length;
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
            <CircleCheck className={cn('size-4', superseded ? 'text-ink-3' : 'text-good-ink')} aria-label={superseded ? 'already so' : 'applied'} />
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
            {superseded && <Badge tone="neutral">Already so</Badge>}
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
                  const left = pending ? leaveOut.has(change.key) : !superseded && !applied.has(change.key);
                  const r = pending && !left ? results.get(change.key) : undefined;
                  return (
                    <tr key={change.key} className={cn(left && 'bg-panel-2/50 text-ink-3')}>
                      <td className="px-2 py-1.5 align-top">
                        {pending ? (
                          <Checkbox checked={!left} onChange={(v) => setIncluded([change.key], v)} label={<span className="sr-only">Apply change {index + 1}</span>} />
                        ) : applied.has(change.key) ? (
                          <CircleCheck className="size-3.5 text-good-ink" aria-label="applied" />
                        ) : superseded ? (
                          <CircleCheck className="size-3.5 text-ink-3" aria-label="already so" />
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
                      <td className="hidden truncate px-2 py-1.5 align-top md:table-cell">{row && !row.missing ? (row.category === block.category ? `${cats.name(row.category)}, a guess: confirmed` : cats.name(row.category)) : ''}</td>
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

/** Where this one is among those waiting, and the way to the one before and after (round the ends). */
function QueueNav({ at, total, prev, next, first }: { at: number; total: number; prev: string | undefined; next: string | undefined; first: string | undefined }) {
  const navigate = useNavigate();
  return (
    <nav aria-label="Proposals waiting" className="no-print mb-2 flex flex-wrap items-center justify-between gap-2">
      <Link to="/import#proposals" className="inline-flex items-center gap-1.5 py-1 text-[13px] font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        All proposals
      </Link>
      {at >= 0 ? (
        <div className="flex items-center gap-0.5">
          {prev && <Button size="sm" variant="ghost" className="px-2" icon={<ChevronLeft className="size-4" />} aria-label="Previous proposal" title="Previous proposal (←)" onClick={() => void navigate(`/proposals/${prev}`)} />}
          <span className="px-1.5 text-[13px] text-ink-2 tabular-nums" aria-current="page">
            {total === 1 ? 'The only one waiting' : `${at + 1} of ${total} waiting`}
          </span>
          {next && <Button size="sm" variant="ghost" className="px-2" icon={<ChevronRight className="size-4" />} aria-label="Next proposal" title="Next proposal (→)" onClick={() => void navigate(`/proposals/${next}`)} />}
        </div>
      ) : first ? (
        <Button size="sm" variant="ghost" onClick={() => void navigate(`/proposals/${first}`)}>
          {total === 1 ? 'The one waiting' : `${total} waiting`}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      ) : null}
    </nav>
  );
}

export default function Proposal() {
  const { id = '' } = useParams();
  // A page of its own for each proposal: nothing chosen or typed on one carries to the next.
  return <ProposalPage key={id} id={id} />;
}

function ProposalPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const list = useProposals();
  // While it loads, it shows from the list of those waiting: never the rows of the one before.
  const q = useQuery<ProposalView, ApiError>({
    queryKey: ['proposal', id],
    queryFn: ({ signal }) => api<ProposalView>(`/proposals/${id}`, { signal }),
    placeholderData: () => list.data?.pending.find((v) => v.proposal.id === id),
  });
  // Opened after you decided another: what you did, until you hide it or move on.
  const [decided, setDecided] = useState(() => (location.state as DecidedState | null)?.decided);
  const [armed, setArmed] = useState(!decided);
  const [leaving, setLeaving] = useState(false);
  const [leaveOut, setLeaveOutState] = useState(() => readLeftOut(id));
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const setLeaveOut = (keys: ReadonlySet<string>) => {
    setLeaveOutState(keys);
    keepLeftOut(id, keys);
  };
  const view = q.data;
  const pending = view?.proposal.status === 'pending';
  const left = [...leaveOut].sort();
  const blocks = useMemo(() => (view ? blocksOf(view.proposal.changes) : []), [view]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    // A reload does not show the note again.
    if (location.state) void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [location, navigate]);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), ARRIVAL_PAUSE_MS);
    return () => clearTimeout(t);
  }, [armed]);

  // Those waiting, less the ones you just decided (the list catches up a moment later).
  const gone = new Set([decided?.id, ...(decided?.alsoDone ?? []).map((d) => d.id)]);
  const waiting = (list.data?.pending ?? []).filter((v) => !gone.has(v.proposal.id));
  const at = waiting.findIndex((v) => v.proposal.id === id);
  const around = at >= 0 && waiting.length > 1;
  const prev = around ? waiting[(at - 1 + waiting.length) % waiting.length]!.proposal.id : undefined;
  const next = around ? waiting[(at + 1) % waiting.length]!.proposal.id : undefined;

  // ← and → move between the ones waiting, except while typing or in a dialog.
  useEffect(() => {
    if (!prev || !next) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type !== 'checkbox'))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void navigate(`/proposals/${e.key === 'ArrowLeft' ? prev : next}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, navigate]);

  // With changes left out, the server checks the rest again: a link may need an unlink you left out.
  const check = useQuery<ProposalCheckResponse>({
    queryKey: ['proposal', id, 'check', left.join(','), view?.proposal.updatedAt],
    queryFn: () => api<ProposalCheckResponse>(`/proposals/${id}/check`, { body: { leaveOut: left } }),
    enabled: pending && left.length > 0,
    placeholderData: (prevData) => prevData,
  });
  const results = useMemo(() => {
    const map = new Map<string, Result>();
    if (!view) return map;
    if (left.length && check.data) for (const c of check.data.changes) map.set(c.key, c);
    else for (const c of view.changes) map.set(c.change.key, c);
    return map;
  }, [view, check.data, left.length]);

  /** After a decision: on to the next one waiting after this one (round from the first), or back to the queue. */
  const moveOn = (d: ProposalDecision) => {
    setLeaving(true);
    keepLeftOut(id, new Set());
    const status = d.proposal.status === 'pending' ? 'applied' : d.proposal.status;
    const handoff: DecidedHandoff = { id, title: d.proposal.title, status, ...(status === 'applied' ? { applied: d.proposal.applied?.length ?? 0 } : {}), ...(d.alsoDone?.length ? { alsoDone: d.alsoDone } : {}) };
    const closed = new Set([id, ...(d.alsoDone ?? []).map((x) => x.id)]);
    const order = waiting.map((v) => v.proposal.id);
    const after = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find((x) => !closed.has(x));
    void navigate(after ? `/proposals/${after}` : '/import#proposals', { state: { decided: handoff } satisfies DecidedState });
  };
  const apply = useApiMutation(() => api<ProposalDecision>(`/proposals/${id}/apply`, { body: { leaveOut: left } }), { onSuccess: moveOn, onError: () => undefined });
  const close = useApiMutation(() => api<ProposalDecision>(`/proposals/${id}/close`, { body: {} }), { onSuccess: moveOn, onError: () => undefined });
  const dismiss = useApiMutation(() => api<ProposalDecision>(`/proposals/${id}/dismiss`, { body: reason.trim() ? { reason: reason.trim() } : {} }), {
    onSuccess: (d) => {
      setDismissing(false);
      moveOn(d);
    },
  });

  if (q.error) return <ErrorNote error={q.error} />;
  if (!view) return <Loading />;
  const p = view.proposal;
  const superseded = p.status === 'superseded';
  // Waiting, but your data already says all of it: there is nothing to apply, only to close.
  const done = pending && view.alreadyDone === true;
  const included = p.changes.filter((c) => !leaveOut.has(c.key));
  const problems = included.filter((c) => results.get(c.key)?.problem);
  const alreadySo = included.filter((c) => results.get(c.key)?.alreadySo).length;
  const ready = included.length - problems.length - alreadySo;
  // The changes you kept would change nothing (your data says them already, or they undo each other).
  const keptDone = included.length > 0 && (left.length ? check.data?.alreadyDone === true : done);
  const applied = new Set(p.applied ?? []);
  const setIncluded = (keys: string[], include: boolean) => {
    const nextSet = new Set(leaveOut);
    for (const key of keys) {
      if (include) nextSet.delete(key);
      else nextSet.add(key);
    }
    setLeaveOut(nextSet);
  };
  const choosing: Choosing = { view, pending: pending && !done, superseded: superseded || done, leaveOut, applied, results, setIncluded };
  const position = at >= 0 ? { position: at + 1, total: waiting.length } : undefined;
  // Not while the page has just changed under you, is on its way out, or shows the list's copy.
  const paused = !armed || leaving || q.isPlaceholderData;
  const failed = apply.error ?? close.error;

  return (
    <div className="mx-auto max-w-5xl">
      {decided && <DecidedNotice decided={decided} next={position} onHide={() => setDecided(undefined)} />}
      <QueueNav at={at} total={waiting.length} prev={prev} next={next} first={waiting[0]?.proposal.id} />
      <div className={cn('-mx-3 rounded-xl px-3 pt-1', decided && 'motion-safe:animate-[arrive_1.6s_ease-out]')}>
        <PageHeader
          title={p.title}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-2">
              <ProposalStatusBadge status={p.status} />
              <span>
                Proposed by {proposedBy(p.provenance)} · {timeAgo(p.createdAt)}
              </span>
            </span>
          }
        />
      </div>

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
      {superseded && (
        <Callout tone="neutral" className="mb-5" title={`Already done: closed ${when(p.decidedAt!)}`}>
          Your data came to say everything it proposes before you decided (an import or an edit got there first), so it closed without changing anything. That is not a no: an agent may propose the same again if your data changes back. The rows below are as they are now.
        </Callout>
      )}
      {done && (
        <Callout tone="good" className="mb-5" title="Already done">
          Your data already says everything this proposes (an import or an edit got there first), so applying it would change nothing. It closes by itself; you can close it now. That is not a no: an agent may propose the same again if your data changes back.
        </Callout>
      )}

      <Card title="What the agent found" className="mb-5">
        <p className="text-[14px] leading-relaxed whitespace-pre-line text-ink-2">{p.summary}</p>
      </Card>

      <Card
        title={`${pending ? 'Changes it proposes' : 'Changes'} (${p.changes.length})`}
        description={pending ? (done ? 'Your data says each of these already.' : 'They apply in this order. Untick any you disagree with: the rest are checked again, in case one needs another.') : undefined}
        padded={false}
        actions={
          pending && !done && p.changes.length > 1 ? (
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
        <div className="no-print sticky bottom-3 z-20 mt-5 overflow-hidden rounded-xl border border-line bg-panel shadow-lg">
          {!armed && <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 origin-left bg-accent motion-safe:animate-[pause-fill_1200ms_linear_forwards]" />}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
              {position && waiting.length > 1 && (
                <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px] font-medium text-ink-2 tabular-nums" title="Where this one is among those waiting">
                  {position.position} of {position.total}
                </span>
              )}
              {done ? (
                <span>
                  <CircleCheck className="mr-1 inline size-4 text-good-ink" aria-hidden />
                  Nothing to apply: your data already says all of it
                </span>
              ) : (
                <span>
                  <Info className="mr-1 inline size-4 text-accent" aria-hidden />
                  {keptDone ? (
                    'Nothing to apply: your data already says the ones you kept'
                  ) : ready ? (
                    <>
                      Applies <span className="font-semibold text-ink">{plural(ready, 'change')}</span>
                    </>
                  ) : (
                    'Nothing to apply'
                  )}
                  {!keptDone && alreadySo > 0 && `, skips ${alreadySo} already so`}
                  {leaveOut.size > 0 && `, leaves ${leaveOut.size} out`}
                  {problems.length > 0 && <span className="text-bad-ink"> · {plural(problems.length, 'change')} to leave out first</span>}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {done ? (
                <Button variant="primary" disabled={paused} loading={close.isPending} onClick={() => close.mutate(undefined)}>
                  Close as already done
                </Button>
              ) : (
                <>
                  {problems.length > 0 && (
                    <Button size="sm" disabled={paused} onClick={() => setLeaveOut(new Set([...leaveOut, ...problems.map((c) => c.key)]))}>
                      Leave out {problems.length === 1 ? 'the one that does not fit' : `the ${problems.length} that do not fit`}
                    </Button>
                  )}
                  <Button disabled={paused} onClick={() => setDismissing(true)}>
                    Dismiss…
                  </Button>
                  <Button variant="primary" disabled={paused || !ready || keptDone || problems.length > 0 || check.isFetching} loading={apply.isPending} onClick={() => apply.mutate(undefined)}>
                    Apply {ready && !keptDone ? plural(ready, 'change') : ''}
                  </Button>
                </>
              )}
            </div>
            {failed && <div className="w-full text-[12.5px] text-bad-ink">{failed.message}</div>}
          </div>
        </div>
      )}
      {pending && (
        <p className="mt-3 text-center text-[12px] text-ink-3">
          {done ? 'Closing it changes nothing in your data; it is kept in your data’s history as already done.' : 'Nothing changes until you apply. Each change is checked against your data again as it is applied, and the proposal is kept in your data’s history with what it changed.'}
          {around && (
            <span className="hidden sm:inline">
              {' '}
              <Kbd>←</Kbd> <Kbd>→</Kbd> move between the ones waiting; any you skip stay waiting.
            </span>
          )}
        </p>
      )}

      <Dialog
        open={dismissing}
        onOpenChange={setDismissing}
        title="Dismiss this proposal?"
        description="Nothing in your data changes. It is kept as your no, so agents do not propose the same changes again."
        footer={
          <>
            <Button onClick={() => setDismissing(false)}>Cancel</Button>
            <Button variant="danger" loading={dismiss.isPending} onClick={() => dismiss.mutate(undefined)}>
              Dismiss
            </Button>
          </>
        }
      >
        <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] font-medium text-ink">{p.title}</div>
        <Field label="Why (optional)" hint="Agents read this, so they know what you do not want.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="e.g. That payment did go to my saver" />
        </Field>
        {dismiss.error && <Callout tone="bad" className="mt-3">{dismiss.error.message}</Callout>}
      </Dialog>
    </div>
  );
}
