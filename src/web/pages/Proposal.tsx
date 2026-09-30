// A proposed fix, for you to review: what the agent found, each change with the rows it is about and
// its reason, checked against your data as you choose which to apply (src/server/proposals.ts).

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, CircleDashed, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ProposalCheckResponse, ProposalView } from '../../shared/api';
import { CHANGE_LABELS, ChangeBody, proposedBy, useProposals } from '../components/Proposals';
import { Badge, Button, Callout, Card, Checkbox, Dialog, ErrorNote, Field, Loading, PageHeader, StatusBadge, Textarea, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, plural, timeAgo } from '../lib/format';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

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

  // With changes left out, the server checks the rest again: a link may need an unlink you left out.
  const check = useQuery<ProposalCheckResponse>({
    queryKey: ['proposal', id, 'check', left.join(','), view?.proposal.updatedAt],
    queryFn: () => api<ProposalCheckResponse>(`/proposals/${id}/check`, { body: { leaveOut: left } }),
    enabled: pending && left.length > 0,
    placeholderData: (prev) => prev,
  });
  const results = useMemo(() => {
    const map = new Map<string, { problem?: string; alreadySo?: true }>();
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
  const toggle = (key: string, include: boolean) => {
    const nextSet = new Set(leaveOut);
    if (include) nextSet.delete(key);
    else nextSet.add(key);
    setLeaveOut(nextSet);
  };

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
          {p.changes.map((c, i) => {
            const out = pending ? leaveOut.has(c.key) : !applied.has(c.key);
            const r = pending && !out ? results.get(c.key) : undefined;
            const label = CHANGE_LABELS[c.kind];
            return (
              <li key={c.key} className={cn('px-5 py-4', out && pending && 'bg-panel-2/50')}>
                <div className="flex items-start gap-3">
                  <div className="pt-0.5">
                    {pending ? (
                      <Checkbox checked={!out} onChange={(v) => toggle(c.key, v)} label={<span className="sr-only">Apply change {i + 1}</span>} />
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
          })}
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
