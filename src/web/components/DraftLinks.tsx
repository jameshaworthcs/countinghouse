// Linking the two legs of a transfer while they wait for review (src/server/ingest/links.ts): what
// a draft row is linked to, and choosing a row of another import (or a recorded transaction) to link
// it to. A link between two imports waiting for review becomes a transfer once both are committed.

import { ArrowLeftRight, Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { DraftLinkView, LinkCandidate } from '../../shared/api';
import { formatDate } from '../../shared/dates';
import type { Draft, DraftTransaction, ImportRecord } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn } from '../lib/format';
import { Badge, Button, Callout, Dialog, EmptyState, Loading, Money } from './ui';

const LINK_FIELDS = ['pendingLink', 'transferMatch', 'transferMatchBy'] as const;
/** What linking or unlinking a row changes on it (./links.ts on the server). */
const CHANGED_BY_LINKING = [...LINK_FIELDS, 'category', 'categorisedBy', 'ruleId', 'counterpartyAccountId'] as const;

const linkOf = (t: DraftTransaction) => JSON.stringify(LINK_FIELDS.map((f) => t[f] ?? null));

/**
 * The review page's draft, with the links (and the categories linking set) of the server's copy:
 * only rows whose links differ change, so edits not yet saved stay.
 */
export function withServerLinks(local: Draft, server: Draft | undefined): Draft {
  if (!server) return local;
  const rows = new Map(server.sections.flatMap((s) => s.transactions.map((t) => [t.key, t] as const)));
  const same = local.sections.every((s) => s.transactions.every((t) => !rows.has(t.key) || linkOf(rows.get(t.key)!) === linkOf(t)));
  if (same) return local;
  return {
    ...local,
    sections: local.sections.map((s) => ({
      ...s,
      transactions: s.transactions.map((t) => {
        const there = rows.get(t.key);
        if (!there || linkOf(there) === linkOf(t)) return t;
        const next: DraftTransaction = { ...t };
        for (const f of CHANGED_BY_LINKING) {
          if (there[f] === undefined) delete next[f];
          else (next as Record<string, unknown>)[f] = there[f];
        }
        return next;
      }),
    })),
  };
}

function Other({ v, importId }: { v: DraftLinkView | LinkCandidate; importId: string }) {
  return (
    <span className="sensitive">
      {v.accountName && <span className="text-ink-2">{v.accountName}</span>}
      {v.date && <> · {formatDate(v.date)}</>}
      {v.description && <> · {v.description}</>}
      {v.amount !== undefined && (
        <>
          {' '}
          · <Money value={v.amount} />
        </>
      )}
      {v.kind === 'pending' && v.importId && (
        <>
          {' '}
          ·{' '}
          {v.importId === importId ? (
            'this import'
          ) : (
            <Link to={`/import/${v.importId}`} className="text-accent hover:underline">
              {v.fileName}
            </Link>
          )}
        </>
      )}
    </span>
  );
}

/** Under a row: what it is linked to as a transfer, and a way to take the link away. */
export function LinkLine({ importId, row, view, onChanged }: { importId: string; row: DraftTransaction; view: DraftLinkView | undefined; onChanged: (r: ImportRecord) => void }) {
  const unlink = useApiMutation(() => api<ImportRecord>(`/imports/${importId}/rows/${row.key}/link`, { method: 'DELETE' }), { onSuccess: onChanged });
  if (!view) return null;
  // The badge stays short (it does not wrap); the rest wraps beside it.
  const label = view.kind === 'gone' ? 'Link gone' : 'Transfer';
  const rest = view.kind === 'gone' ? 'what it was linked to is no longer there' : `with ${view.accountName ?? 'another account'}${view.kind === 'pending' ? ', waiting for review' : view.by === 'draft' ? ', found by matching' : ''}`;
  const why =
    view.kind === 'pending'
      ? 'Linked by you to a row of an import waiting for review: recorded as a transfer once both are committed, in either order.'
      : view.kind === 'recorded'
        ? view.by === 'user'
          ? 'Linked by you to a recorded transaction: a transfer when this import is committed.'
          : 'Found by matching: the same amount the other way, in another of your accounts, and descriptions that agree.'
        : `The ${view.transactionId ? 'transaction' : 'row'} it was linked to has gone: unlink it, or link it again.`;
  const details = view.kind === 'gone' ? '' : [view.date ? formatDate(view.date) : '', view.description ?? ''].filter(Boolean).join(' · ');
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-[11.5px] text-ink-3">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={`${why}${details ? `\n${details}` : ''}`}>
        <Badge tone={view.kind === 'gone' ? 'warn' : 'accent'} icon={<ArrowLeftRight className="size-3" />}>
          {label}
        </Badge>
        <span>{rest}</span>
        {view.kind === 'pending' && view.importId && view.importId !== importId && (
          <Link to={`/import/${view.importId}`} className="max-w-[12rem] truncate text-accent hover:underline">
            {view.fileName}
          </Link>
        )}
        <button type="button" className="inline-flex items-center gap-0.5 rounded px-1 text-ink-3 hover:bg-panel-2 hover:text-ink" onClick={() => unlink.mutate(undefined)} disabled={unlink.isPending}>
          <Unlink className="size-3" /> Unlink
        </button>
      </div>
      {(!row.include || (view.kind === 'pending' && view.included === false)) && (
        <span className="text-warn-ink">{!row.include ? 'This row is not ticked' : 'The other row is not ticked'}: nothing is linked unless both are recorded.</span>
      )}
      {unlink.error && <span className="text-bad-ink">{unlink.error.message}</span>}
    </div>
  );
}

/** Choose what a row is the other leg of: a row waiting for review, or a recorded transaction. */
function LinkDialog({ importId, row, onClose, onLinked }: { importId: string; row: DraftTransaction; onClose: () => void; onLinked: (r: ImportRecord) => void }) {
  const q = useApi<{ candidates: LinkCandidate[] }>(['import-links', importId, row.key], `/imports/${importId}/rows/${row.key}/links`);
  const link = useApiMutation((c: LinkCandidate) => api<ImportRecord>(`/imports/${importId}/rows/${row.key}/link`, { body: c.kind === 'pending' ? { importId: c.importId, key: c.key } : { transactionId: c.transactionId } }), {
    onSuccess: (r) => {
      onLinked(r);
      onClose();
    },
  });
  const all = q.data?.candidates ?? [];
  const groups: [string, LinkCandidate[], string][] = [
    ['Waiting for review', all.filter((c) => c.kind === 'pending'), 'Linked as a transfer once both are committed.'],
    ['Recorded', all.filter((c) => c.kind === 'recorded'), 'Linked as a transfer when this import is committed.'],
  ];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Link the other side of this transfer"
      description={
        <span className="sensitive">
          {formatDate(row.date)} · {row.payee ?? row.description} · <Money value={row.amount} />. Offered: the same amount the other way, in another of your accounts, within 14 days.
        </span>
      }
    >
      {!q.data ? (
        <Loading />
      ) : all.length === 0 ? (
        <EmptyState title="Nothing to link it to">No row waiting for review, and no recorded transaction, is {row.amount < 0 ? 'paid in' : 'paid out'} for this amount in another account within 14 days. Rows already recorded, and transactions already in a transfer, are left out.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([title, list, note]) =>
            list.length ? (
              <section key={title}>
                <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
                <p className="mb-1.5 text-[12px] text-ink-3">{note}</p>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {list.map((c) => (
                    <li key={c.transactionId ?? `${c.importId}:${c.key}`} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                      <div className="min-w-0 flex-1">
                        <Other v={c} importId={importId} />
                        <div className="text-[11.5px] text-ink-3">
                          {c.days === 0 ? 'the same day' : `${c.days} day${c.days === 1 ? '' : 's'} apart`}
                          {c.kind === 'pending' && c.included === false && <span className="text-warn-ink"> · not ticked there</span>}
                        </div>
                      </div>
                      <Button size="sm" icon={<Link2 className="size-3.5" />} loading={link.isPending && link.variables === c} onClick={() => link.mutate(c)}>
                        Link
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
        </div>
      )}
      {link.error && <Callout tone="bad">{link.error.message}</Callout>}
    </Dialog>
  );
}

/** The row's button for linking it as one leg of a transfer. */
export function LinkButton({ importId, row, linked, onLinked }: { importId: string; row: DraftTransaction; linked: boolean; onLinked: (r: ImportRecord) => void }) {
  const [open, setOpen] = useState(false);
  if (row.status === 'duplicate') return null;
  return (
    <>
      <button type="button" className={cn('rounded p-1 hover:bg-panel-2', linked ? 'text-accent' : 'text-ink-3')} onClick={() => setOpen(true)} aria-label={linked ? 'Link to something else' : 'Link the other side of a transfer'} title={linked ? 'Link to something else' : 'Link the other side of a transfer'}>
        <Link2 className="size-3.5" />
      </button>
      {open && <LinkDialog importId={importId} row={row} onClose={() => setOpen(false)} onLinked={onLinked} />}
    </>
  );
}
