import { ArrowLeftRight, ExternalLink, FileText, History, Link2, PencilLine, StickyNote, Tag, Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { parseAmount } from '../../shared/money';
import type { Rule, Transaction } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money } from '../lib/format';
import { Badge, Button, Callout, Checkbox, Drawer, Field, Input, KeyValue, Money, Select, Textarea, useToast } from './ui';

export function CategorySelect({ value, onChange, allowEmpty = true, className, placeholder = 'Uncategorised', id }: { value: string | undefined; onChange: (v: string | undefined) => void; allowEmpty?: boolean; className?: string; placeholder?: string; id?: string }) {
  const { cats } = useAppData();
  const groups = cats.groups().filter((g) => !g.hidden);
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className={className}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {groups.map((g) => {
        const children = cats.children(g.id).filter((c) => !c.hidden);
        return (
          <optgroup key={g.id} label={g.name}>
            {children.length === 0 && <option value={g.id}>{g.name}</option>}
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </Select>
  );
}

export function categoryBadge(t: Transaction, name: string): ReactNode {
  if (!t.category) return <Badge tone="warn">Uncategorised</Badge>;
  return (
    <Badge tone={t.transferGroup ? 'accent' : 'neutral'} icon={t.transferGroup ? <ArrowLeftRight className="size-3" /> : undefined}>
      {name}
    </Badge>
  );
}

/** Compact list of transactions; each row opens the detail drawer. */
export function TransactionList({ items, compact = false, showAccount = true }: { items: Transaction[]; compact?: boolean; showAccount?: boolean }) {
  const { cats, accountName } = useAppData();
  const [open, setOpen] = useState<Transaction | null>(null);
  return (
    <>
      <ul className="divide-y divide-line">
        {items.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpen(t)} className={cn('flex w-full items-center gap-3 px-5 text-left hover:bg-panel-2', compact ? 'py-2' : 'py-2.5')}>
              <div className="w-14 shrink-0 text-[12px] text-ink-3 tabular">{formatDate(t.date, { year: false })}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-ink">{t.payee ?? t.description}</div>
                <div className="truncate text-[12px] text-ink-3">
                  {showAccount && <span>{accountName(t.accountId)} · </span>}
                  {cats.name(t.category)}
                  {t.notes && <StickyNote className="ml-1 inline size-3" aria-label="Has notes" />}
                </div>
              </div>
              <Money value={t.amount} className={cn('tabular shrink-0 text-[13.5px] font-medium', t.amount > 0 ? 'text-good-ink' : 'text-ink')} />
            </button>
          </li>
        ))}
      </ul>
      {open && <TransactionDrawer tx={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RuleFromTransaction({ tx, category, onDone }: { tx: Transaction; category: string | undefined; onDone: () => void }) {
  const toast = useToast();
  const similar = useApi<{ count: number; differentCategory: number; suggestedMatch: string }>(['similar', tx.id], `/transactions/${tx.id}/similar`);
  const [value, setValue] = useState<string | null>(null);
  const match = value ?? similar.data?.suggestedMatch ?? '';
  const create = useApiMutation(
    () =>
      api<{ rule: Rule; result: { recategorised: number } | null }>('/rules', {
        body: {
          name: `${match} → ${category}`,
          enabled: true,
          priority: 100,
          match: { field: tx.payee && match === tx.payee ? 'payee' : 'description', op: 'contains', value: match, caseSensitive: false },
          set: { category, ...(tx.payee ? { payee: tx.payee } : {}) },
          apply: true,
        },
      }),
    {
      onSuccess: (r) => {
        toast({ tone: 'good', text: `Rule created; ${r.result?.recategorised ?? 0} transactions updated` });
        onDone();
      },
    },
  );
  if (!category || !similar.data) return null;
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink">
        <Wand2 className="size-4 text-accent" /> Always categorise like this?
      </div>
      <p className="mb-2 text-[12.5px] text-ink-3">
        {similar.data.count} other transaction{similar.data.count === 1 ? '' : 's'} look similar{similar.data.differentCategory ? `; ${similar.data.differentCategory} would change` : ''}. A rule applies to history and future imports (your manual edits are kept).
      </p>
      <div className="flex gap-2">
        <Input value={match} onChange={(e) => setValue(e.target.value)} aria-label="Match text" />
        <Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)} disabled={!match.trim()}>
          Create rule
        </Button>
      </div>
      {create.error && <div className="mt-2 text-[12px] text-bad-ink">{create.error.message}</div>}
    </div>
  );
}

export function TransactionDrawer({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const { cats, accountName, accountsById } = useAppData();
  const toast = useToast();
  const [payee, setPayee] = useState(tx.payee ?? '');
  const [category, setCategory] = useState(tx.category);
  const [notes, setNotes] = useState(tx.notes ?? '');
  const [tags, setTags] = useState((tx.tags ?? []).join(', '));
  const [showRule, setShowRule] = useState(false);
  const save = useApiMutation(
    () =>
      api<Transaction>(`/transactions/${tx.id}`, {
        method: 'PATCH',
        body: {
          // Only a changed payee is sent: sending it marks it as yours, and enrichment then leaves it alone.
          ...(payee.trim() !== (tx.payee ?? '') ? { payee: payee.trim() || null } : {}),
          ...(category !== tx.category ? { category: category ?? null } : {}),
          notes: notes.trim() || null,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      }),
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Saved' });
        if (category && category !== tx.category) setShowRule(true);
        else onClose();
      },
    },
  );
  const other = tx.counterpartyAccountId ? accountsById.get(tx.counterpartyAccountId) : undefined;
  const detail: [ReactNode, ReactNode][] = [
    ['Date', `${formatDate(tx.date)}${tx.time ? ` ${tx.time}` : ''}${tx.transactionDate ? ` (purchased ${formatDate(tx.transactionDate)})` : ''}`],
    ['Account', <Link to={`/accounts/${tx.accountId}`} className="text-accent hover:underline">{accountName(tx.accountId)}</Link>],
    ['Description', <span className="font-mono text-[12px]">{tx.description}</span>],
  ];
  if (tx.type) detail.push(['Type', tx.type]);
  if (tx.reference) detail.push(['Reference', tx.reference]);
  if (tx.counterpartyName) detail.push(['Counterparty', tx.counterpartyName]);
  if (tx.place) detail.push(['Where', tx.place]);
  if (tx.merchant && Object.keys(tx.merchant).length) detail.push([tx.place ? 'Merchant, as printed' : 'Merchant', Object.values(tx.merchant).filter((v) => typeof v === 'string').join(' · ')]);
  if (tx.bankCategory) detail.push(["Bank's category", tx.bankCategory]);
  if (tx.original) detail.push(['Original amount', money(tx.original.amount, { currency: tx.original.currency })]);
  if (tx.fee) detail.push(['Fee', money(tx.fee)]);
  if (tx.balanceAfter !== undefined) detail.push(['Balance after', <Money value={tx.balanceAfter} />]);
  if (tx.cardLast4) detail.push(['Card', `•••• ${tx.cardLast4}`]);
  if (tx.sourceId) detail.push(['Bank id', <span className="font-mono text-[12px]">{tx.sourceId}</span>]);
  if (other) detail.push(['Transfer with', <Link to={`/accounts/${other.id}`} className="inline-flex items-center gap-1 text-accent hover:underline"><Link2 className="size-3.5" />{other.name}</Link>]);
  detail.push(['Categorised by', tx.categorisedBy ?? '—']);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={tx.payee ?? tx.description}>
      <div className="flex flex-col gap-5">
        <div>
          <Money value={tx.amount} className={cn('text-[28px] font-semibold', tx.amount > 0 ? 'text-good-ink' : 'text-ink')} />
          <div className="mt-1">{categoryBadge(tx, cats.path(tx.category))}</div>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <Field label="Payee" hint={tx.payeeSetBy === 'user' ? 'Set by you: rules and re-running enrichment leave it alone.' : undefined}>
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} />
          </Field>
          <Field label="Category">
            <CategorySelect value={category} onChange={setCategory} />
          </Field>
          <Field label="Tags" hint='Comma separated. Tag Gift Aided donations "gift-aid" for Self Assessment.'>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. holiday-2026, gift-aid" />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </Field>
          {save.error && <Callout tone="bad">{save.error.message}</Callout>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
        {showRule && <RuleFromTransaction tx={tx} category={category} onDone={onClose} />}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Tag className="size-4 text-ink-3" /> Source details
          </h3>
          <KeyValue items={detail} />
        </section>
        {tx.corrections?.length ? <CorrectionTrail tx={tx} /> : null}
        <CorrectSource tx={tx} onDone={onClose} />
        {tx.raw && (
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-ink-2">Original row, exactly as imported</summary>
            <div className="border-t border-line px-3 py-2">
              <KeyValue items={Object.entries(tx.raw).map(([k, v]) => [k, <span className="font-mono text-[12px]">{v}</span>])} />
            </div>
          </details>
        )}
        {tx.source.importId && (
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Link to={`/import/${tx.source.importId}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              <FileText className="size-3.5" /> Import record
            </Link>
            {tx.source.documentId && (
              <a href={`/api/documents/${tx.source.documentId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                <ExternalLink className="size-3.5" /> Original document
              </a>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

const CORRECTION_LABEL = { date: 'Date', amount: 'Amount', description: 'Description' } as const;

function correctionValue(field: keyof typeof CORRECTION_LABEL, v: string | number): string {
  if (field === 'amount' && typeof v === 'number') return money(v);
  if (field === 'date' && typeof v === 'string') return formatDate(v);
  return String(v);
}

/** What you corrected, oldest first: the document's reading is kept alongside your value. */
function CorrectionTrail({ tx }: { tx: Transaction }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <History className="size-4 text-ink-3" /> Your corrections
      </h3>
      <ul className="flex flex-col gap-1.5 text-[12.5px] text-ink-2">
        {(tx.corrections ?? []).map((c, i) => (
          <li key={i}>
            <span className="font-medium text-ink">{CORRECTION_LABEL[c.field]}</span> was {correctionValue(c.field, c.from)}, now {correctionValue(c.field, c.to)}
            <span className="text-ink-3"> · {formatDate(c.at.slice(0, 10))}</span>
            {c.note && <div className="text-ink-3">{c.note}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Fix a value the import misread. The previous value is kept in the transaction's corrections. */
function CorrectSource({ tx, onDone }: { tx: Transaction; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(tx.date);
  const [amount, setAmount] = useState(tx.amount.toFixed(2));
  const [description, setDescription] = useState(tx.description);
  const [note, setNote] = useState('');
  const parsed = parseAmount(amount);
  const changes = {
    ...(date !== tx.date ? { date } : {}),
    ...(parsed !== null && parsed !== tx.amount ? { amount: parsed } : {}),
    ...(description.trim() && description.trim() !== tx.description ? { description: description.trim() } : {}),
  };
  const save = useApiMutation(() => api<Transaction>(`/transactions/${tx.id}`, { method: 'PATCH', body: { ...changes, ...(note.trim() ? { correctionNote: note.trim() } : {}) } }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Corrected; the value that was read is kept' });
      onDone();
    },
  });
  return (
    <details className="rounded-lg border border-line">
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-ink-2">
        <PencilLine className="size-3.5" /> Correct a misread date, amount or description
      </summary>
      <form
        className="flex flex-col gap-3 border-t border-line px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <p className="text-[12.5px] text-ink-3">Only for values the import got wrong. Balances and totals use your value; the transaction keeps a note of what was read.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Amount" hint="Money out is negative" error={parsed === null ? 'Not an amount' : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Why (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. statement shows £12.50; the scan read £72.50" />
        </Field>
        {save.error && <Callout tone="bad">{save.error.message}</Callout>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!Object.keys(changes).length || parsed === null}>
            Save correction
          </Button>
        </div>
      </form>
    </details>
  );
}

export function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (!count) return null;
  return (
    <div className="no-print sticky bottom-4 z-20 mx-auto mt-3 flex w-fit flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 shadow-lg">
      <span className="text-[13px] font-medium text-ink">{count} selected</span>
      {children}
      <Checkbox checked={false} onChange={onClear} label="Clear" />
    </div>
  );
}
