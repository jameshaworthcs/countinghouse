// Proposed fixes: what an agent proposes changing in your data, each change with its reason and the
// rows it is about, waiting for you on the Import page (src/server/proposals.ts).

import { ArrowDown, ArrowRight, ArrowRightLeft, ArrowUpDown, Building2, CalendarDays, ChevronRight, CircleCheck, CircleSlash, CopyX, FileText, Handshake, Link2, NotebookPen, PiggyBank, Sparkles, Tag, Unlink, Wand2, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ProposalBalance, ProposalListResponse, ProposalRow, ProposalSummary, ProposalView } from '../../shared/api';
import type { ProposalStatus, ProposedChange, ProposedChangeKind, Provenance } from '../../shared/schema';
import { useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural, timeAgo } from '../lib/format';
import { Badge, Button, Card, IconButton, StatusBadge } from './ui';

export function useProposals() {
  return useApi<ProposalListResponse>(['proposals'], '/proposals', { refetchInterval: 30_000 });
}

export const CHANGE_LABELS: Record<ProposedChangeKind, { title: string; count: (n: number) => string; icon: ReactNode }> = {
  unlink_transfer: { title: 'Undo a transfer link', count: (n) => `${plural(n, 'transfer link')} undone`, icon: <Unlink className="size-4" aria-hidden /> },
  link_transfer: { title: 'Link as a transfer', count: (n) => `${plural(n, 'transfer')} linked`, icon: <Link2 className="size-4" aria-hidden /> },
  set_category: { title: 'Change a category', count: (n) => plural(n, 'category', 'categories'), icon: <Tag className="size-4" aria-hidden /> },
  set_note: { title: 'Add a note', count: (n) => plural(n, 'note'), icon: <NotebookPen className="size-4" aria-hidden /> },
  remove_duplicate: { title: 'Remove a duplicate', count: (n) => `${plural(n, 'duplicate')} removed`, icon: <CopyX className="size-4" aria-hidden /> },
  remove_internal_move: { title: 'Remove a move inside the account', count: (n) => `${plural(n, 'move')} inside an account removed`, icon: <PiggyBank className="size-4" aria-hidden /> },
  remove_wrong_sign: { title: 'Remove a row read with the wrong sign', count: (n) => `${plural(n, 'row')} with the wrong sign removed`, icon: <ArrowUpDown className="size-4" aria-hidden /> },
  set_account_dates: { title: 'Change an account’s dates', count: (n) => (n === 1 ? 'an account’s dates' : `${n} accounts’ dates`), icon: <CalendarDays className="size-4" aria-hidden /> },
  move_balance: { title: 'Move a balance to its account', count: (n) => `${plural(n, 'balance')} moved`, icon: <ArrowRightLeft className="size-4" aria-hidden /> },
  add_company: { title: 'Add shares you hold in a company', count: (n) => plural(n, 'company', 'companies'), icon: <Building2 className="size-4" aria-hidden /> },
  add_pension_arrangement: { title: 'Add what an employer pays into your pension', count: (n) => plural(n, 'pension arrangement'), icon: <PiggyBank className="size-4" aria-hidden /> },
  add_agreement: { title: 'Add an agreement to pay', count: (n) => plural(n, 'agreement'), icon: <Handshake className="size-4" aria-hidden /> },
};

/** "5 transfers linked, 2 transfer links undone, 1 category" */
export function describeChanges(changes: ProposedChange[]): string {
  const counts = new Map<ProposedChangeKind, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => CHANGE_LABELS[kind].count(n)).join(', ');
}

/** Where a proposal stands, as a badge. */
export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  switch (status) {
    case 'pending':
      return <StatusBadge status="info">Waiting for you</StatusBadge>;
    case 'applied':
      return <StatusBadge status="good">Applied</StatusBadge>;
    case 'dismissed':
      return <Badge tone="muted">Dismissed</Badge>;
    case 'superseded':
      return (
        <Badge tone="neutral" icon={<CircleCheck className="size-3.5 text-good-ink" aria-hidden />}>
          Already done
        </Badge>
      );
  }
}

/** A proposal you just decided, carried to where you land next (the next one waiting, or the queue). */
export interface DecidedHandoff {
  id: string;
  title: string;
  status: Exclude<ProposalStatus, 'pending'>;
  /** Changes applied. */
  applied?: number;
  /** Other proposals it left with nothing to do, closed as already done. */
  alsoDone?: { id: string; title: string }[];
}

/** Router state for landing after a decision. */
export interface DecidedState {
  decided: DecidedHandoff;
}

/**
 * Says what you just decided and that the page moved on, so the next proposal is never mistaken
 * for the last one. It takes the focus, so a screen reader says it too.
 */
export function DecidedNotice({ decided, next, last, onHide }: { decided: DecidedHandoff; next?: { position: number; total: number } | undefined; last?: boolean; onHide: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const { status } = decided;
  const title = (
    <Link to={`/proposals/${decided.id}`} className="hover:underline">
      “{decided.title}”
    </Link>
  );
  const detail = status === 'applied' ? `${plural(decided.applied ?? 0, 'change')} applied, and kept in your data’s history.` : status === 'dismissed' ? 'Nothing in your data changed.' : 'Your data already said all of it, so nothing changed.';
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className={cn('no-print mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px] outline-none motion-safe:animate-[notice-in_220ms_ease-out]', status === 'applied' ? 'border-transparent bg-good-soft' : 'border-line bg-panel-2')}
    >
      {status === 'dismissed' ? <CircleSlash className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ink">
          {status === 'applied' ? <>Applied {title}</> : status === 'dismissed' ? <>Dismissed {title}</> : <>Closed {title} as already done</>}
        </div>
        <div className="mt-0.5 text-ink-2">{detail}</div>
        {decided.alsoDone?.map((d) => (
          <div key={d.id} className="mt-0.5 text-ink-2">
            That also finished{' '}
            <Link to={`/proposals/${d.id}`} className="text-ink hover:underline">
              {d.title}
            </Link>
            , so it closed as already done.
          </div>
        ))}
        {next ? (
          <div className="mt-2 flex items-center gap-1.5 font-medium text-ink">
            <ArrowDown className="size-4 text-accent" aria-hidden />
            {next.total === 1 ? 'Below is the last one waiting.' : `Below is the next one waiting (${next.position} of ${next.total}).`}
          </div>
        ) : last ? (
          <div className="mt-2 font-medium text-ink">That was the last one waiting.</div>
        ) : null}
      </div>
      <IconButton label="Hide this note" className="-my-1.5 -mr-2 size-8 shrink-0" onClick={onHide}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
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

/** A balance as a proposal shows it: whose, on what day, how much, and the document it came from. */
function BalanceLine({ b, view, muted }: { b: ProposalBalance | undefined; view: ProposalView; muted?: boolean }) {
  const { accountName } = useAppData();
  if (!b || b.missing) return <div className="rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-ink-3">No longer in your data</div>;
  return (
    <div className={cn('min-w-0 rounded-lg border border-line bg-panel px-3 py-2', muted && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <Link to={`/accounts/${b.accountId}`} className="truncate font-medium text-ink hover:underline">
            {view.accounts[b.accountId]?.name ?? accountName(b.accountId)}
          </Link>
          <span className="whitespace-nowrap text-ink-3">{formatDate(b.date)}</span>
        </div>
        <span className={cn('sensitive shrink-0 text-[13.5px] font-semibold tabular-nums text-ink', muted && 'line-through')}>{money(b.balance, { currency: b.currency })}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink-2">
        Balance{b.interestRate !== undefined ? ` · ${b.interestRate}% interest` : ''}
      </div>
      {b.source && (
        <Link to={`/import/${b.source.importId}`} className="mt-1 inline-flex min-w-0 items-center gap-1 text-[11.5px] text-ink-3 hover:text-accent hover:underline" title="The document it came from">
          <FileText className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{b.source.fileName ?? 'document'}</span>
        </Link>
      )}
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
    case 'set_note': {
      const t = row(change.transaction);
      return (
        <div className="grid gap-2">
          <TxLine row={t} view={view} />
          <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
            <span className="text-ink-3">Note</span>
            <span className="text-ink">{change.note}</span>
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
    case 'remove_wrong_sign': {
      const t = row(change.transaction);
      return (
        <div className="grid gap-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-bad-ink">Remove</div>
            <TxLine row={t} view={view} muted />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-ink-3">The same money, recorded the right way round by another document as</div>
            <div className="grid gap-1.5">
              {change.recordedAs.map((id) => (
                <TxLine key={id} row={row(id)} view={view} />
              ))}
            </div>
          </div>
          {t && !t.missing && t.categorisedBy === 'user' && <div className="text-[12.5px] text-ink-3">The category you gave it goes with it; the rows above keep theirs.</div>}
        </div>
      );
    }
    case 'remove_internal_move': {
      const t = row(change.transaction);
      const between = view.changes.find((c) => c.change.key === change.key)?.between;
      return (
        <div className="grid gap-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-bad-ink">Remove</div>
            <TxLine row={t} view={view} muted />
          </div>
          {between && (
            <div className="sensitive text-[12.5px] text-ink-3 tabular-nums">
              Without it, {money(between.from.balance)} on {formatDate(between.from.date)} and {money(between.to.balance)} on {formatDate(between.to.date)} add up ✓
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
    case 'add_pension_arrangement': {
      const a = change.arrangement;
      return (
        <div className="grid gap-1 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
          <div className="text-ink">
            <span className="font-medium">{change.employmentId}</span> pays <span className="sensitive tabular-nums">{money(a.amount)}</span> {a.kind === 'single' ? 'once' : 'a month'}, gross, into{' '}
            <Link to={`/accounts/${a.accountId}`} className="hover:underline">
              {view.accounts[a.accountId]?.name ?? accountName(a.accountId)}
            </Link>
            , from its form of {formatDate(a.from)}
            {a.until ? ` to ${formatDate(a.until)}` : ''}.
          </div>
          {a.note && <div className="text-[12.5px] text-ink-3">{a.note}</div>}
          <div className="text-[12.5px] text-ink-3">The account’s page then checks it against the contributions that arrive.</div>
        </div>
      );
    }
    case 'add_agreement': {
      const a = change.agreement;
      const files = view.changes.find((c) => c.change.key === change.key)?.files ?? [];
      return (
        <div className="grid gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
          <div className="font-medium text-ink">
            {a.name}
            <span className="font-normal text-ink-3"> · {a.counterparty}</span>
          </div>
          <div className="text-ink-2">
            {formatDate(a.from)}
            {a.until ? ` to ${formatDate(a.until)}` : ''}
            {a.total !== undefined && (
              <>
                , <span className="sensitive tabular-nums">{money(a.total)}</span> in all
              </>
            )}
            {a.agreedOn ? `, agreed ${formatDate(a.agreedOn)}` : ''}.
          </div>
          <ul className="grid gap-0.5 text-ink-2">
            {a.payments.map((p, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {p.label ?? `Payment ${i + 1}`}, due {formatDate(p.due)}
                </span>
                <span className="sensitive tabular-nums">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
          {a.details.length > 0 && (
            <dl className="grid gap-x-3 gap-y-0.5 text-[12.5px] sm:grid-cols-[auto_minmax(0,1fr)]">
              {a.details.map((d, i) => (
                <Fragment key={i}>
                  <dt className="text-ink-3">{d.label}</dt>
                  <dd className="text-ink-2">{d.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          <div className="text-[12.5px] text-ink-3">
            Its payments take <Badge tone="accent">{cats.path(a.category)}</Badge> as they come
            {files.length ? `, and so do ${files.length === 1 ? 'this one' : `these ${files.length}`} in your data:` : '. None in your data needs it now.'}
          </div>
          {files.length > 0 && (
            <ul className="grid gap-0.5 text-[12.5px]">
              {files.map((f) => (
                <li key={f.transactionId} className="flex flex-wrap justify-between gap-x-3">
                  <span className="text-ink-2">
                    {formatDate(f.date)} · {view.accounts[f.accountId]?.name ?? accountName(f.accountId)}
                    <span className="text-ink-3"> · now {f.category ? cats.name(f.category) : 'uncategorised'}</span>
                  </span>
                  <span className="sensitive tabular-nums">{money(f.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'add_company': {
      const v = change.valuation;
      return (
        <div className="grid gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
          <div className="font-medium text-ink">
            {change.company.name}
            {change.company.number && <span className="font-normal text-ink-3"> · company {change.company.number}</span>}
          </div>
          {change.company.holdings.map((h, i) => (
            <div key={i} className="text-ink-2">
              {h.shares} {h.shareClass} share{h.shares === 1 ? '' : 's'}
              {h.totalShares ? ` of the ${h.totalShares} it has issued` : ''}
              {h.certificate ? `, certificate ${h.certificate}` : ''}
              {h.acquiredOn ? `, from ${formatDate(h.acquiredOn)}` : ''}
            </div>
          ))}
          <div className="sensitive text-ink-2 tabular-nums">
            Worth about {money(v.value)} on {formatDate(v.asOf)}
            {v.method === 'net-assets' && v.netAssets !== undefined ? `: its net assets of ${money(v.netAssets)}, as your share of its shares` : ''}.
          </div>
          {v.note && <div className="text-[12.5px] text-ink-3">{v.note}</div>}
          <div className="text-[12.5px] text-ink-3">
            A new account, <span className="text-ink-2">{change.account.name}</span>, carries it in your estate (Property &amp; other), at this value until a newer one.
          </div>
        </div>
      );
    }
    case 'move_balance': {
      const b = view.balances[change.balance];
      const to = view.accounts[change.to];
      const moved = view.changes.find((c) => c.change.key === change.key)?.moved;
      return (
        <div className="grid gap-2">
          <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <BalanceLine b={b} view={view} muted={b?.accountId !== change.to} />
            <Arrow />
            <div className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
              <Link to={`/accounts/${change.to}`} className="font-medium text-ink hover:underline">
                {to?.name ?? accountName(change.to)}
              </Link>
              {to?.institutionName ? <span className="text-ink-3"> · {to.institutionName}</span> : null}
            </div>
          </div>
          {moved && (
            <div className="sensitive grid gap-0.5 text-[12.5px] text-ink-3 tabular-nums">
              <div>{moved.misfit}</div>
              <div>
                In {to?.name ?? accountName(change.to)}, it adds up with {moved.beside.map((x) => `${money(x.balance)} on ${formatDate(x.date)}`).join(' and ')} ✓
              </div>
            </div>
          )}
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
            {v.problems > 0 ? <StatusBadge status="warn">{plural(v.problems, 'change')} no longer fit{v.problems === 1 ? 's' : ''}</StatusBadge> : v.alreadyDone ? <ProposalStatusBadge status="superseded" /> : <ProposalStatusBadge status="pending" />}
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
      <ProposalStatusBadge status={s.status} />
      <Link to={`/proposals/${s.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
        {s.title}
      </Link>
      <span className="hidden text-ink-3 sm:inline">{s.status === 'applied' ? `${s.applied} of ${plural(s.changes, 'change')}` : s.status === 'superseded' ? `${plural(s.changes, 'change')}, already so` : plural(s.changes, 'change')}</span>
      <span className="w-24 text-right text-ink-3">{s.decidedAt ? formatDate(s.decidedAt.slice(0, 10)) : ''}</span>
    </li>
  );
}

/** Import page: proposals waiting for you, and the ones you decided lately. */
export function ProposalQueue() {
  const q = useProposals();
  const [showDecided, setShowDecided] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  // Arriving from the last one waiting you decided: what you did, until you hide it or leave.
  const [justDecided, setJustDecided] = useState(() => (location.state as DecidedState | null)?.decided);
  useEffect(() => {
    // A reload does not show it again.
    if (location.state) void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [location, navigate]);
  const list = q.data;
  const shown = Boolean(list && (list.pending.length || list.decided.length));
  // The card renders after its data arrives, too late for the browser's own jump to #proposals.
  useEffect(() => {
    if (shown && location.hash === '#proposals') document.getElementById('proposals')?.scrollIntoView({ block: 'start' });
  }, [shown, location.hash]);
  if (!list || !shown) return null;
  const decided = list.decided.slice(0, 10);
  const waiting = list.pending.filter((v) => v.proposal.id !== justDecided?.id);
  return (
    <Card
      id="proposals"
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden /> Proposed fixes
        </span>
      }
      description={waiting.length ? 'Changes an agent found reasons for in your data, each with its evidence. Nothing changes until you apply them.' : 'Nothing is waiting for you.'}
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
      {justDecided && (
        <div className="px-5 pb-1">
          <DecidedNotice decided={justDecided} last={waiting.length === 0} onHide={() => setJustDecided(undefined)} />
        </div>
      )}
      {waiting.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {waiting.map((v) => (
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
