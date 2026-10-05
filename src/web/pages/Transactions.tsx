import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, Search, StickyNote, Tag, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { TransactionsResponse } from '../../shared/api';
import { addDays, addMonths, endOfMonth, startOfMonth, today } from '../../shared/dates';
import type { Transaction } from '../../shared/schema';
import { formatSortParam, parseSortParam, type SortDir } from '../../shared/sort';
import { taxYearOf } from '../../shared/uk';
import { CategorySelect, NoteDialog, SelectionBar, TAG_LIST_ID, TagOptions, TAGS_HINT, TransactionDrawer } from '../components/TransactionList';
import { Button, Checkbox, EmptyState, ErrorNote, Input, Loading, Money, PageHeader, Select, SortHeader, useDebounced, useToast } from '../components/ui';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural } from '../lib/format';
import { useRowSelection } from '../lib/useSelection';
import type { SortProps } from '../lib/sort';

const PERIODS: { id: string; label: string; range: () => [string | undefined, string | undefined] }[] = [
  { id: 'all', label: 'All time', range: () => [undefined, undefined] },
  { id: '30d', label: 'Last 30 days', range: () => [addDays(today(), -29), undefined] },
  { id: '90d', label: 'Last 90 days', range: () => [addDays(today(), -89), undefined] },
  { id: 'month', label: 'This month', range: () => [startOfMonth(today()), undefined] },
  { id: 'last-month', label: 'Last month', range: () => [startOfMonth(addMonths(today(), -1)), endOfMonth(addMonths(today(), -1))] },
  { id: 'tax-year', label: 'This tax year', range: () => [taxYearOf(today()).start, undefined] },
  { id: 'last-tax-year', label: 'Last tax year', range: () => { const t = taxYearOf(addMonths(taxYearOf(today()).start, -1)); return [t.start, t.end]; } },
  { id: '12m', label: 'Last 12 months', range: () => [addMonths(today(), -12), undefined] },
];

/** Sortable columns and the direction of their first click (sorted by the API: the list is capped). */
const SORT_FIRST: Record<string, SortDir> = { date: 'desc', payee: 'asc', account: 'asc', category: 'asc', amount: 'asc' };
const DEFAULT_SORT = 'date_desc';

export default function Transactions() {
  const [params, setParams] = useSearchParams();
  const { data, cats, accountName } = useAppData();
  const toast = useToast();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search);
  const period = params.get('period') ?? (params.get('from') ? 'custom' : '90d');
  const [from, to] = period === 'custom' ? [params.get('from') ?? undefined, params.get('to') ?? undefined] : (PERIODS.find((p) => p.id === period) ?? PERIODS[2]!).range();
  const filters = {
    from,
    to,
    q,
    accounts: params.get('accounts') ?? undefined,
    categories: params.get('categories') ?? undefined,
    direction: params.get('direction') ?? undefined,
    transfers: params.get('transfers') ?? undefined,
    tag: params.get('tag') ?? undefined,
    source: params.get('source') ?? undefined,
    currency: params.get('currency') ?? undefined,
    sort: params.get('sort') ?? undefined,
    limit: 5000,
  };
  const query = useApi<TransactionsResponse>(['transactions', filters], `/transactions${qs(filters)}`);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const order = useMemo(() => items.map((t) => t.id), [items]);
  const { selected, click, set: setSelected, clear: clearSelection } = useRowSelection(order);
  const [open, setOpen] = useState<Transaction | null>(null);
  // The transactions a note is being written on: one row's, or the selection's.
  const [noteFor, setNoteFor] = useState<Transaction[] | null>(null);
  const [bulkCategory, setBulkCategory] = useState<string | undefined>();
  const [bulkTag, setBulkTag] = useState('');
  const set = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    clearSelection();
  };

  const recategorise = useApiMutation((v: { id: string; category: string | undefined }) => api(`/transactions/${v.id}`, { method: 'PATCH', body: { category: v.category ?? null } }));
  const bulk = useApiMutation((body: Record<string, unknown>) => api<{ updated: number }>('/transactions/bulk', { body }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: `${plural(r.updated, 'transaction')} updated` });
      setBulkTag('');
    },
  });
  // Esc lets go of the selection, unless a box, a drawer or a dialog has the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !selected.size || open || noteFor) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, open, noteFor, clearSelection]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => 52, overscan: 12 });
  const allSelected = items.length > 0 && selected.size === items.length;
  const selectedItems = useMemo(() => items.filter((t) => selected.has(t.id)), [items, selected]);
  const exportHref = `/api/transactions/export.csv${qs({ ...filters, sort: undefined, limit: undefined })}`;
  const sort = parseSortParam(filters.sort ?? DEFAULT_SORT) ?? { key: 'date', dir: 'desc' as const };
  const sortProps = (key: string): SortProps => ({
    dir: sort.key === key ? sort.dir : undefined,
    onSort: () => {
      const first = SORT_FIRST[key] ?? 'asc';
      const dir = sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : first;
      const next = formatSortParam(key, dir);
      set('sort', next === DEFAULT_SORT ? undefined : next);
    },
  });
  // A new order starts from its top. (A block body: scrollTo can return a promise, which isn't a cleanup.)
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [filters.sort]);
  const active = [filters.accounts, filters.categories, filters.direction, filters.transfers, filters.tag, filters.source, filters.currency, q].some(Boolean);

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle={query.data ? `${plural(query.data.total, 'transaction')} · in ${money(query.data.sum.in)} · out ${money(query.data.sum.out)}` : ' '}
        actions={
          <a href={exportHref}>
            <Button icon={<Download className="size-4" />}>Export CSV</Button>
          </a>
        }
      />
      <div className="no-print mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); set('q', e.target.value || undefined); }} placeholder="Search description, payee, notes, amount" className="pl-9" aria-label="Search" />
        </div>
        <Select value={period} onChange={(e) => set('period', e.target.value)} className="w-40" aria-label="Period">
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {period === 'custom' && <option value="custom">{from} – {to ?? 'today'}</option>}
        </Select>
        <Select value={filters.accounts ?? ''} onChange={(e) => set('accounts', e.target.value || undefined)} className="w-48" aria-label="Account">
          <option value="">All accounts</option>
          {data.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <div className="w-52">
          <CategorySelect value={filters.categories} onChange={(v) => set('categories', v)} placeholder="All categories" />
        </div>
        <Button size="sm" variant={filters.categories === 'uncategorised' ? 'primary' : 'ghost'} onClick={() => set('categories', filters.categories === 'uncategorised' ? undefined : 'uncategorised')}>
          Uncategorised
        </Button>
        <Select value={filters.direction ?? ''} onChange={(e) => set('direction', e.target.value || undefined)} className="w-32" aria-label="Direction">
          <option value="">In and out</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </Select>
        <Select value={filters.transfers ?? ''} onChange={(e) => set('transfers', e.target.value || undefined)} className="w-40" aria-label="Transfers">
          <option value="">With transfers</option>
          <option value="exclude">Hide transfers</option>
          <option value="only">Only transfers</option>
        </Select>
        {active && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => { setSearch(''); setParams(new URLSearchParams({ ...(period !== '90d' ? { period } : {}), ...(filters.sort ? { sort: filters.sort } : {}) }), { replace: true }); }}>
            Clear
          </Button>
        )}
      </div>
      {filters.tag && (
        <div className="mb-2 flex items-center gap-1.5 text-[13px] text-ink-3">
          <Tag className="size-3.5" aria-hidden /> Tagged “{filters.tag}”
          <button type="button" className="rounded p-0.5 hover:bg-panel-2 hover:text-ink" onClick={() => set('tag', undefined)} aria-label={`Stop filtering by ${filters.tag}`}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {filters.currency && (
        <div className="mb-2 flex items-center gap-1.5 text-[13px] text-ink-3">
          Paid in {filters.currency}
          <button type="button" className="rounded p-0.5 hover:bg-panel-2 hover:text-ink" onClick={() => set('currency', undefined)} aria-label={`Stop filtering by ${filters.currency}`}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {query.error && <ErrorNote error={query.error} />}
      <div className="print-plain overflow-hidden rounded-xl border border-line bg-panel shadow-card">
        <div className="grid grid-cols-[28px_76px_1fr_120px] items-center gap-3 border-b border-line px-4 py-2 text-[12px] font-medium text-ink-3 md:grid-cols-[28px_84px_1fr_180px_200px_120px]">
          <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={(v) => (v ? setSelected(order) : clearSelection())} ariaLabel="Select all" />
          <SortHeader as="div" label="Date" sort={sortProps('date')} />
          <SortHeader as="div" label="Description" sort={sortProps('payee')} />
          <SortHeader as="div" label="Account" sort={sortProps('account')} className="hidden md:block" />
          <SortHeader as="div" label="Category" sort={sortProps('category')} className="hidden md:block" />
          <SortHeader as="div" label="Amount" sort={sortProps('amount')} numeric />
        </div>
        {!query.data ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState title="No transactions match">Try a longer period or clear the filters.</EmptyState>
        ) : (
          <div ref={parentRef} data-scroll-top className={cn('scrollbar-thin h-[calc(100dvh-300px)] min-h-[360px] overflow-y-auto', query.isFetching ? 'opacity-60' : '')}>
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((row) => {
                const t = items[row.index]!;
                const checked = selected.has(t.id);
                return (
                  <div
                    key={t.id}
                    className={cn('group absolute inset-x-0 grid grid-cols-[28px_76px_1fr_120px] items-center gap-3 border-b border-line px-4 md:grid-cols-[28px_84px_1fr_180px_200px_120px]', checked ? 'bg-accent-soft' : 'hover:bg-panel-2')}
                    style={{ top: row.start, height: row.size }}
                    // Shift-clicking rows chooses them, so it must not select their text.
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                  >
                    <Checkbox checked={checked} onChange={(_, mods) => click(t.id, mods)} ariaLabel={`Select ${t.payee ?? t.description}`} />
                    <div className="text-[12.5px] leading-tight text-ink-3 tabular">
                      {formatDate(t.date)}
                      {/* When the card was used, where it posted later: a statement dates it on posting, an app on the day. */}
                      {t.transactionDate && t.transactionDate !== t.date && (
                        <div className="text-[11px]" title={`Made on ${formatDate(t.transactionDate)}${t.transactionTime ? ` at ${t.transactionTime.slice(0, 5)}` : ''}; it posted on ${formatDate(t.date)}`}>
                          made {formatDate(t.transactionDate, { year: false })}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1">
                        <button
                          type="button"
                          className="min-w-0 truncate text-left text-[13.5px] font-medium text-ink"
                          // With Shift or Ctrl/⌘ a click chooses the row, as in a file list; without, it opens it.
                          onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? click(t.id, e) : setOpen(t))}
                        >
                          {t.payee ?? t.description}
                          {t.pending && <span className="ml-1.5 text-[11px] font-normal text-ink-3">pending</span>}
                        </button>
                        <button
                          type="button"
                          onClick={() => setNoteFor([t])}
                          // Without a note it shows on hover (and to the keyboard); on a phone, notes are in the drawer.
                          className={cn('shrink-0 rounded p-0.5 text-ink-3 hover:bg-panel-2 hover:text-ink focus:opacity-100', t.notes ? '' : 'hidden opacity-0 group-hover:opacity-100 md:inline-flex')}
                          aria-label={t.notes ? 'Edit note' : 'Add a note'}
                          title={t.notes ? `Note: ${t.notes}` : 'Add a note'}
                        >
                          <StickyNote className="size-3.5" />
                        </button>
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
                        {t.payee && t.payee.toLowerCase() !== t.description.toLowerCase() && <span className="min-w-0 shrink truncate">{t.description}</span>}
                        {t.notes && <span className="sensitive hidden min-w-0 shrink truncate text-ink-2 italic md:inline" title={t.notes}>{t.notes.split('\n')[0]}</span>}
                        {t.tags?.map((tag) => (
                          <button key={tag} type="button" className="shrink-0 text-accent hover:underline" onClick={() => set('tag', tag)} title={`Show everything tagged “${tag}”`}>
                            #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                    <span className="hidden truncate text-[12.5px] text-ink-2 md:block">{accountName(t.accountId)}</span>
                    <div className="hidden md:block">
                      <CategorySelect
                        value={t.category}
                        onChange={(v) => recategorise.mutate({ id: t.id, category: v })}
                        className={cn('h-8 text-[12.5px]', !t.category ? 'border-warn text-warn-ink' : '')}
                      />
                    </div>
                    <Money value={t.amount} className={cn('tabular text-right text-[13.5px] font-medium', t.amount > 0 ? 'text-good-ink' : 'text-ink')} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {query.data && query.data.total > items.length && <div className="mt-2 text-[12.5px] text-ink-3">Showing the {sort.key === 'date' && sort.dir === 'desc' ? 'newest' : 'first'} {items.length.toLocaleString()} of {query.data.total.toLocaleString()}{sort.key === 'date' && sort.dir === 'desc' ? '' : ' in this order'}. Narrow the filters to see the rest.</div>}
      <SelectionBar
        count={selected.size}
        onClear={clearSelection}
        hint={<>Shift-click chooses a range; let go of Shift and hold it again for another group. Ctrl/⌘-click adds or removes one. Esc lets go.</>}
      >
        <div className="w-48">
          <CategorySelect value={bulkCategory} onChange={setBulkCategory} placeholder="Choose category" />
        </div>
        <Button size="sm" variant="primary" disabled={!bulkCategory} loading={bulk.isPending} onClick={() => bulk.mutate({ ids: [...selected], category: bulkCategory })}>
          Set category
        </Button>
        <span className="flex items-center gap-1.5" title={TAGS_HINT}>
          <Input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder="tag" className="h-8 w-32" aria-label="Tag" list={TAG_LIST_ID} />
          <Button size="sm" disabled={!bulkTag.trim()} onClick={() => bulk.mutate({ ids: [...selected], addTags: [bulkTag.trim()] })}>
            Add tag
          </Button>
          {bulkTag.trim() && selectedItems.some((t) => t.tags?.some((x) => x.toLowerCase() === bulkTag.trim().toLowerCase())) && (
            <Button size="sm" variant="ghost" onClick={() => bulk.mutate({ ids: [...selected], removeTags: [bulkTag.trim()] })}>
              Remove tag
            </Button>
          )}
        </span>
        <Button size="sm" icon={<StickyNote className="size-3.5" />} onClick={() => setNoteFor(selectedItems)}>
          Note
        </Button>
      </SelectionBar>
      <TagOptions />
      {noteFor && <NoteDialog txs={noteFor} onClose={() => setNoteFor(null)} onDone={() => noteFor.length > 1 && clearSelection()} />}
      {open && <TransactionDrawer tx={open} onClose={() => setOpen(null)} />}
      <span className="sr-only">{cats.list.length} categories</span>
    </div>
  );
}
