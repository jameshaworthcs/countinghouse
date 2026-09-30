// Proposed fixes: what an agent proposes changing in your data, each change with its reason and the
// rows it is about, waiting for you on the Import page (src/server/proposals.ts).

import { ArrowDown, ArrowRight, CalendarDays, ChevronRight, CopyX, FileText, Link2, Sparkles, Tag, Unlink, Wand2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { ProposalListResponse, ProposalRow, ProposalSummary, ProposalView } from '../../shared/api';
import type { ProposedChange, ProposedChangeKind, Provenance } from '../../shared/schema';
import { useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural, timeAgo } from '../lib/format';
import { Badge, Button, Card, StatusBadge } from './ui';

export function useProposals() {
  return useApi<ProposalListResponse>(['proposals'], '/proposals', { refetchInterval: 30_000 });
}

export const CHANGE_LABELS: Record<ProposedChangeKind, { title: string; count: (n: number) => string; icon: ReactNode }> = {
  unlink_transfer: { title: 'Undo a transfer link', count: (n) => `${plural(n, 'transfer link')} undone`, icon: <Unlink className="size-4" aria-hidden /> },
  link_transfer: { title: 'Link as a transfer', count: (n) => `${plural(n, 'transfer')} linked`, icon: <Link2 className="size-4" aria-hidden /> },
  set_category: { title: 'Change a category', count: (n) => plural(n, 'category', 'categories'), icon: <Tag className="size-4" aria-hidden /> },
  remove_duplicate: { title: 'Remove a duplicate', count: (n) => `${plural(n, 'duplicate')} removed`, icon: <CopyX className="size-4" aria-hidden /> },
  set_account_dates: { title: 'Change an account’s dates', count: (n) => (n === 1 ? 'an account’s dates' : `${n} accounts’ dates`), icon: <CalendarDays className="size-4" aria-hidden /> },
};

/** "5 transfers linked, 2 transfer links undone, 1 category" */
export function describeChanges(changes: ProposedChange[]): string {
  const counts = new Map<ProposedChangeKind, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => CHANGE_LABELS[kind].count(n)).join(', ');
}

/** "Claude Code on P360 (claude-opus-5-5)", or the in-app job that proposed it. */
export function proposedBy(p: Provenance): string {
  const who = p.jobId ? `an agent job${p.promptVersion ? ` (${p.promptVersion})` : ''}` : (p.session ?? 'an agent');
  return p.model ? `${who}, ${p.model}` : who;
}

/** A transaction as a proposal shows it: where, when, how much, what it said, and where it came from. */
export function TxLine({ row, view, muted, className }: { row: ProposalRow | undefined; view: ProposalView; muted?: boolean; className?: string }) {
  const { cats, accountName } = useAppData();
  if (!row || row.missing) return <div className={cn('rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-ink-3', className)}>No longer in your data</div>;
  const acc = view.accounts[row.accountId];
  const partnerAcc = row.partner ? (view.accounts[row.partner.accountId]?.name ?? accountName(row.partner.accountId)) : undefined;
  return (
    <div className={cn('min-w-0 rounded-lg border border-line bg-panel px-3 py-2', muted && 'opacity-60', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <Link to={`/accounts/${row.accountId}`} className="truncate font-medium text-ink hover:underline">
            {acc?.name ?? accountName(row.accountId)}
          </Link>
          <span className="whitespace-nowrap text-ink-3">{formatDate(row.date)}</span>
        </div>
        <span className={cn('sensitive shrink-0 text-[13.5px] font-semibold tabular-nums', row.amount > 0 ? 'text-good-ink' : 'text-ink', muted && 'line-through')}>{money(row.amount, { currency: row.currency, sign: true })}</span>
      </div>
      <div className="sensitive mt-0.5 truncate text-[12.5px] text-ink-2" title={row.description}>
        {row.description}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={row.category ? 'neutral' : 'muted'}>{cats.name(row.category)}</Badge>
        {row.partner && (
          <Badge tone="accent" icon={<Link2 className="size-3" aria-hidden />}>
            transfer with {partnerAcc}
          </Badge>
        )}
        {row.source && (
          <Link to={`/import/${row.source.importId}`} className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-ink-3 hover:text-accent hover:underline" title="The document it came from">
            <FileText className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{row.source.fileName ?? 'document'}</span>
          </Link>
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <span className="flex justify-center text-ink-3" aria-hidden>
      <ArrowDown className="size-4 sm:hidden" />
      <ArrowRight className="hidden size-4 sm:block" />
    </span>
  );
}

/** What a change does, drawn with the rows and accounts it is about. */
export function ChangeBody({ change, view }: { change: ProposedChange; view: ProposalView }) {
  const { cats, accountName } = useAppData();
  const row = (id: string) => view.rows[id];
  switch (change.kind) {
    case 'link_transfer': {
      const from = row(change.from);
      const to = row(change.to);
      // How the link leaves the two rows (worked out by the server, as applying would).
      const after = view.changes.find((c) => c.change.key === change.key)?.after;
      const cats2 = [...new Set([change.from, change.to].map((id) => after?.[id]?.category))].filter(Boolean) as string[];
      return (
        <div className="grid gap-2">
          <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <TxLine row={from} view={view} />
            <Arrow />
            <TxLine row={to} view={view} />
          </div>
          {after && from && to && !from.missing && !to.missing && (
            <p className="text-[12.5px] leading-6 text-ink-3">
              <Link2 className="mr-1 inline size-3.5 align-[-2px] text-accent" aria-hidden />
              Then a transfer from <span className="text-ink-2">{view.accounts[from.accountId]?.name ?? accountName(from.accountId)}</span> to <span className="text-ink-2">{view.accounts[to.accountId]?.name ?? accountName(to.accountId)}</span>
              {cats2.length ? ', as ' : ''}
              {cats2.map((c, i) => (
                <span key={c}>
                  {i > 0 && ' and '}
                  <Badge tone="accent">{cats.name(c)}</Badge>
                </span>
              ))}
            </p>
          )}
        </div>
      );
    }
    case 'unlink_transfer': {
      const t = row(change.transaction);
      const partner = t?.partner ? row(t.partner.id) : undefined;
      return (
        <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <TxLine row={t} view={view} />
          <span className="flex justify-center text-bad-ink" title="No longer linked" aria-label="no longer linked with">
            <Unlink className="size-4" aria-hidden />
          </span>
          {partner ? <TxLine row={partner} view={view} /> : <div className="text-[12.5px] text-ink-3">Not linked to anything now.</div>}
        </div>
      );
    }
    case 'set_category': {
      const t = row(change.transaction);
      return (
        <div className="grid gap-2">
          <TxLine row={t} view={view} />
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-ink-3">Category</span>
            <Badge tone="muted">{cats.name(t?.category)}</Badge>
            <ArrowRight className="size-3.5 text-ink-3" aria-hidden />
            <Badge tone="accent">{cats.path(change.category)}</Badge>
          </div>
        </div>
      );
    }
    case 'remove_duplicate': {
      const t = row(change.transaction);
      const same = change.sameAs.map(row);
      const sum = same.reduce((s, r) => s + Math.round((r?.amount ?? 0) * 100), 0) / 100;
      return (
        <div className="grid gap-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-bad-ink">Remove</div>
            <TxLine row={t} view={view} muted />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-ink-3">The same money, already recorded as</div>
            <div className="grid gap-1.5">
              {change.sameAs.map((id) => (
                <TxLine key={id} row={row(id)} view={view} />
              ))}
            </div>
          </div>
          {same.length > 1 && t && !t.missing && (
            <div className="sensitive text-[12.5px] text-ink-3 tabular-nums">
              {same.map((r) => money(r?.amount)).join(' + ')} = {money(sum)} {Math.round(sum * 100) === Math.round(t.amount * 100) ? '✓' : ''}
            </div>
          )}
        </div>
      );
    }
    case 'set_account_dates': {
      const acc = view.accounts[change.account];
      const line = (label: string, was: string | undefined, now: string | null | undefined) =>
        now === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="w-16 text-ink-3">{label}</span>
            <Badge tone="muted">{was ? formatDate(was) : 'not set'}</Badge>
            <ArrowRight className="size-3.5 text-ink-3" aria-hidden />
            <Badge tone="accent">{now ? formatDate(now) : 'not set'}</Badge>
          </div>
        );
      return (
        <div className="grid gap-1.5 rounded-lg border border-line bg-panel px-3 py-2">
          <Link to={`/accounts/${change.account}`} className="text-[13px] font-medium text-ink hover:underline">
            {acc?.name ?? accountName(change.account)}
            {acc?.institutionName ? <span className="font-normal text-ink-3"> · {acc.institutionName}</span> : null}
          </Link>
          {line('Opened', acc?.openedOn, change.openedOn)}
          {line('Closed', acc?.closedOn, change.closedOn)}
          {change.closedOn !== undefined && (acc?.status === 'closed') !== (change.closedOn !== null) && <div className="text-[12.5px] text-ink-3">{change.closedOn ? 'It will show as closed, and stop counting after that day.' : 'It will show as open again.'}</div>}
        </div>
      );
    }
  }
}

function QueueRow({ v }: { v: ProposalView }) {
  const p = v.proposal;
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Wand2 className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proposals/${p.id}`} className="text-[14px] font-medium text-ink hover:underline">
              {p.title}
            </Link>
            {v.problems > 0 ? <StatusBadge status="warn">{plural(v.problems, 'change')} no longer fit{v.problems === 1 ? 's' : ''}</StatusBadge> : <StatusBadge status="info">Waiting for you</StatusBadge>}
          </div>
          <div className="truncate text-[12.5px] text-ink-3">
            {describeChanges(p.changes)} · proposed by {proposedBy(p.provenance)} · {timeAgo(p.createdAt)}
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <Link to={`/proposals/${p.id}`}>
          <Button size="sm" variant="primary" icon={<ChevronRight className="size-3.5" />}>
            Review
          </Button>
        </Link>
      </div>
    </li>
  );
}

function DecidedRow({ s }: { s: ProposalSummary }) {
  return (
    <li className="flex items-center gap-3 px-5 py-2 text-[13px]">
      {s.status === 'applied' ? <StatusBadge status="good">Applied</StatusBadge> : <Badge tone="muted">Dismissed</Badge>}
      <Link to={`/proposals/${s.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
        {s.title}
      </Link>
      <span className="hidden text-ink-3 sm:inline">{s.status === 'applied' ? `${s.applied} of ${plural(s.changes, 'change')}` : plural(s.changes, 'change')}</span>
      <span className="w-24 text-right text-ink-3">{s.decidedAt ? formatDate(s.decidedAt.slice(0, 10)) : ''}</span>
    </li>
  );
}

/** Import page: proposals waiting for you, and the ones you decided lately. */
export function ProposalQueue() {
  const q = useProposals();
  const [showDecided, setShowDecided] = useState(false);
  const location = useLocation();
  const list = q.data;
  const shown = Boolean(list && (list.pending.length || list.decided.length));
  // The card renders after its data arrives, too late for the browser's own jump to #proposals.
  useEffect(() => {
    if (shown && location.hash === '#proposals') document.getElementById('proposals')?.scrollIntoView({ block: 'start' });
  }, [shown, location.hash]);
  if (!list || !shown) return null;
  const decided = list.decided.slice(0, 10);
  return (
    <Card
      id="proposals"
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden /> Proposed fixes
        </span>
      }
      description={list.pending.length ? 'Changes an agent found reasons for in your data, each with its evidence. Nothing changes until you apply them.' : 'Nothing is waiting for you.'}
      padded={false}
      className="scroll-mt-16 lg:scroll-mt-5"
      actions={
        decided.length ? (
          <Button size="sm" variant="ghost" onClick={() => setShowDecided(!showDecided)}>
            {showDecided ? 'Hide decided' : `Decided (${list.decided.length})`}
          </Button>
        ) : undefined
      }
    >
      {list.pending.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {list.pending.map((v) => (
            <QueueRow key={v.proposal.id} v={v} />
          ))}
        </ul>
      )}
      {showDecided && (
        <ul className="divide-y divide-line border-t border-line bg-panel-2/40">
          {decided.map((s) => (
            <DecidedRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </Card>
  );
}
