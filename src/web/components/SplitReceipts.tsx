// A transaction's split across categories and its receipts, in the transaction drawer.

import { Paperclip, Plus, ScanText, Split, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatMoney, fromMinor, parseAmount, toMinor } from '../../shared/money';
import type { Receipt, Transaction } from '../../shared/schema';
import { proposedSplit } from '../../shared/splits';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money } from '../lib/format';
import { CategorySelect } from './TransactionList';
import { Badge, Button, Callout, Input, Money, useToast } from './ui';
import { SessionsLink } from './SessionsLink';

type Line = { category: string | undefined; amount: string; note: string };

const toLines = (lines: { category: string; amount: number; note?: string }[]): Line[] => lines.map((l) => ({ category: l.category, amount: Math.abs(l.amount).toFixed(2), note: l.note ?? '' }));

/** Split a payment across categories: the lines, as positive amounts, must add up to it. */
export function SplitSection({ tx, proposal, onProposalUsed }: { tx: Transaction; proposal: Line[] | null; onProposalUsed: () => void }) {
  const { cats } = useAppData();
  const toast = useToast();
  const [editing, setEditing] = useState<Line[] | null>(null);
  const lines = proposal ?? editing;
  const sign = tx.amount < 0 ? -1 : 1;
  const totalMinor = Math.abs(toMinor(tx.amount));
  const usedMinor = (lines ?? []).reduce((s, l) => s + Math.abs(toMinor(parseAmount(l.amount) ?? 0)), 0);
  const left = totalMinor - usedMinor;
  const save = useApiMutation(
    (splits: { category: string; amount: number; note?: string }[] | null) => api<Transaction>(`/transactions/${tx.id}`, { method: 'PATCH', body: { splits } }),
    {
      onSuccess: (_r, splits) => {
        toast({ tone: 'good', text: splits ? 'Split saved' : 'Split removed' });
        setEditing(null);
        onProposalUsed();
      },
    },
  );
  if (tx.transferGroup) return null;
  const set = (i: number, patch: Partial<Line>) => {
    const next = (lines ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l));
    if (proposal) onProposalUsed();
    setEditing(next);
  };
  const valid = lines && lines.length >= 2 && left === 0 && lines.every((l) => l.category && (parseAmount(l.amount) ?? 0) > 0);
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <Split className="size-4 text-ink-3" /> Split
      </h3>
      {!lines && !tx.splits?.length && (
        <Button size="sm" onClick={() => setEditing([{ category: tx.category, amount: '', note: '' }, { category: undefined, amount: '', note: '' }])}>
          Split this payment across categories
        </Button>
      )}
      {!lines && tx.splits?.length ? (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1 text-[13px]">
            {tx.splits.map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  {cats.path(l.category)}
                  {l.note && <span className="text-ink-3"> · {l.note}</span>}
                </span>
                <Money value={l.amount} className="tabular" />
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setEditing(toLines(tx.splits!))}>
              Change
            </Button>
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate(null)}>
              Remove the split
            </Button>
          </div>
        </div>
      ) : null}
      {lines && (
        <div className="flex flex-col gap-2">
          {proposal && <p className="text-[12.5px] text-ink-3">From the receipt: check the lines, then save.</p>}
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_6.5rem_auto] items-center gap-2">
              <CategorySelect value={l.category} onChange={(v) => set(i, { category: v })} placeholder="Category…" />
              <Input value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} inputMode="decimal" placeholder="£" aria-label="Amount" />
              <button className="rounded p-1.5 text-ink-3 hover:bg-panel-2 disabled:opacity-40" disabled={lines.length <= 2} onClick={() => setEditing(lines.filter((_, j) => j !== i))} aria-label="Remove line">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
            <span className={cn(left === 0 ? 'text-good-ink' : 'text-ink-2')}>
              {left === 0 ? 'Adds up to the payment' : left > 0 ? `${formatMoney(fromMinor(left))} left to split` : `${formatMoney(fromMinor(-left))} more than the payment`}
            </span>
            <span className="flex gap-2">
              {left > 0 && (
                <Button size="sm" onClick={() => setEditing(lines.map((x, j) => (j === lines.length - 1 ? { ...x, amount: fromMinor(Math.abs(toMinor(parseAmount(x.amount) ?? 0)) + left).toFixed(2) } : x)))}>
                  Put the rest on the last line
                </Button>
              )}
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditing([...lines, { category: undefined, amount: '', note: '' }])}>
                Line
              </Button>
            </span>
          </div>
          {save.error && <Callout tone="bad">{save.error.message}</Callout>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                onProposalUsed();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(lines.map((x) => ({ category: x.category!, amount: sign * (parseAmount(x.amount) ?? 0), ...(x.note.trim() ? { note: x.note.trim() } : {}) })))}>
              Save the split
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Receipts on a transaction: attach, open, read with Claude when that is on, use as a split. */
export function ReceiptsSection({ tx, onPropose }: { tx: Transaction; onPropose: (lines: Line[]) => void }) {
  const { data, cats } = useAppData();
  const toast = useToast();
  const q = useApi<Receipt[]>(['receipts', tx.id], `/receipts?transactionId=${tx.id}`);
  const reading = data.settings.extraction.readReceipts;
  const attach = useApiMutation(
    (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return api<Receipt>(`/transactions/${tx.id}/receipts`, { body: form });
    },
    { onSuccess: (r) => toast({ tone: 'good', text: r.status === 'read' ? 'Receipt attached and read' : r.status === 'failed' ? 'Receipt attached; it could not be read' : 'Receipt attached' }) },
  );
  const read = useApiMutation((id: string) => api<Receipt>(`/receipts/${id}/read`, { method: 'POST' }));
  const remove = useApiMutation((id: string) => api(`/receipts/${id}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Receipt removed' }) });
  const receipts = q.data ?? [];
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <Paperclip className="size-4 text-ink-3" /> Receipts
      </h3>
      <div className="flex flex-col gap-3">
        {receipts.map((r) => (
          <div key={r.id} className="rounded-lg border border-line p-3 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a href={`/api/documents/${r.document.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent hover:underline">
                {r.document.fileName}
              </a>
              <span className="flex items-center gap-2">
                {r.status === 'failed' && <Badge tone="warn">Not read</Badge>}
                {reading && r.status !== 'read' && (
                  <Button size="sm" icon={<ScanText className="size-3.5" />} loading={read.isPending && read.variables === r.id} onClick={() => read.mutate(r.id)}>
                    Read with the agent
                  </Button>
                )}
                <button className="rounded p-1 text-ink-3 hover:bg-panel-2" onClick={() => remove.mutate(r.id)} aria-label="Remove receipt">
                  <Trash2 className="size-4" />
                </button>
              </span>
            </div>
            {r.error && <div className="mt-1 text-[12px] text-ink-3">{r.error}</div>}
            {r.reading && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="text-[12px] text-ink-3">
                  Read by the agent ({r.reading.model.replace(/^claude-/, '')}): {r.reading.merchant ?? 'shop not read'}
                  {r.reading.date ? `, ${formatDate(r.reading.date)}` : ''}
                  {r.reading.total !== null ? `, total ${money(r.reading.total)}` : ''}. A reading, not a record: nothing changes until you save a split. <SessionsLink of={r.id}>What the agent did</SessionsLink>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {r.reading.lines.map((l, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate">
                        {l.description} <span className="text-ink-3">· {l.category ? cats.name(l.category) : 'no category'}</span>
                      </span>
                      <Money value={l.amount} className="tabular" />
                    </li>
                  ))}
                </ul>
                {r.reading.notes.length > 0 && <div className="text-[12px] text-ink-3">{r.reading.notes.join(' ')}</div>}
                {!tx.transferGroup && r.reading.lines.length > 0 && (
                  <div>
                    <Button size="sm" onClick={() => onPropose(toLines(proposedSplit(tx, r.reading!)))}>
                      Use as a split
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-panel-2">
          <Paperclip className="size-3.5" /> {attach.isPending ? (reading ? 'Attaching and reading…' : 'Attaching…') : 'Attach a receipt'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf"
            className="sr-only"
            disabled={attach.isPending}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) attach.mutate(f);
              e.target.value = '';
            }}
          />
        </label>
        {!reading && (
          <p className="text-[12px] text-ink-3">
            Receipts are kept with your documents. Reading them with the agent to suggest split lines is off (<Link to="/settings#extraction" className="text-accent hover:underline">Settings → Import & extraction</Link>).
          </p>
        )}
        {(attach.error || read.error || remove.error) && <Callout tone="bad">{(attach.error ?? read.error ?? remove.error)!.message}</Callout>}
      </div>
    </section>
  );
}

export type { Line as SplitLineDraft };
