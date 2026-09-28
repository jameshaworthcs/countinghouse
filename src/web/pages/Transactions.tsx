import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, Search, StickyNote, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { TransactionsResponse } from '../../shared/api';
import { addDays, addMonths, endOfMonth, startOfMonth, today } from '../../shared/dates';
import type { Transaction } from '../../shared/schema';
import { taxYearOf } from '../../shared/uk';
import { CategorySelect, SelectionBar, TransactionDrawer } from '../components/TransactionList';
import { Button, Checkbox, EmptyState, ErrorNote, Input, Loading, Money, PageHeader, Select, useDebounced, useToast } from '../components/ui';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, plural } from '../lib/format';

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
    limit: 5000,
  };
  const query = useApi<TransactionsResponse>(['transactions', filters], `/transactions${qs(filters)}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Transaction | null>(null);
  const [bulkCategory, setBulkCategory] = useState<string | undefined>();
  const [bulkTag, setBulkTag] = useState('');
  const set = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  const recategorise = useApiMutation((v: { id: string; category: string | undefined }) => api(`/transactions/${v.id}`, { method: 'PATCH', body: { category: v.category ?? null } }));
  const bulk = useApiMutation((body: Record<string, unknown>) => api<{ updated: number }>('/transactions/bulk', { body }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: `${plural(r.updated, 'transaction')} updated` });
      setSelected(new Set());
    },
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => 52, overscan: 12 });
  const allSelected = items.length > 0 && selected.size === items.length;
  const exportHref = `/api/transactions/export.csv${qs({ ...filters, limit: undefined })}`;
  const active = [filters.accounts, filters.categories, filters.direction, filters.transfers, filters.tag, filters.source, q].some(Boolean);

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
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => { setSearch(''); setParams(new URLSearchParams(period !== '90d' ? { period } : {}), { replace: true }); }}>
            Clear
          </Button>
        )}
      </div>
      {filters.tag && <div className="mb-2 text-[13px] text-ink-3">Tagged “{filters.tag}”</div>}
      {query.error && <ErrorNote error={query.error} />}
      <div className="print-plain overflow-hidden rounded-xl border border-line bg-panel shadow-card">
        <div className="grid grid-cols-[28px_76px_1fr_120px] items-center gap-3 border-b border-line px-4 py-2 text-[12px] font-medium text-ink-3 md:grid-cols-[28px_84px_1fr_180px_200px_120px]">
          <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={(v) => setSelected(v ? new Set(items.map((t) => t.id)) : new Set())} />
          <span>Date</span>
          <span>Description</span>
          <span className="hidden md:block">Account</span>
          <span className="hidden md:block">Category</span>
          <span className="text-right">Amount</span>
        </div>
        {!query.data ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState title="No transactions match">Try a longer period or clear the filters.</EmptyState>
        ) : (
          <div ref={parentRef} className={cn('scrollbar-thin h-[calc(100dvh-300px)] min-h-[360px] overflow-y-auto', query.isFetching ? 'opacity-60' : '')}>
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((row) => {
                const t = items[row.index]!;
                const checked = selected.has(t.id);
                return (
                  <div
                    key={t.id}
                    className={cn('absolute inset-x-0 grid grid-cols-[28px_76px_1fr_120px] items-center gap-3 border-b border-line px-4 md:grid-cols-[28px_84px_1fr_180px_200px_120px]', checked ? 'bg-accent-soft' : 'hover:bg-panel-2')}
                    style={{ top: row.start, height: row.size }}
                  >
                    <Checkbox
                      checked={checked}
                      onChange={(v) => {
                        const next = new Set(selected);
                        if (v) next.add(t.id);
                        else next.delete(t.id);
                        setSelected(next);
                      }}
                    />
                    <span className="text-[12.5px] text-ink-3 tabular">{formatDate(t.date)}</span>
                    <button type="button" className="min-w-0 text-left" onClick={() => setOpen(t)}>
                      <div className="truncate text-[13.5px] font-medium text-ink">
                        {t.payee ?? t.description}
                        {t.notes && <StickyNote className="ml-1.5 inline size-3.5 text-ink-3" aria-label="Has notes" />}
                        {t.pending && <span className="ml-1.5 text-[11px] text-ink-3">pending</span>}
                      </div>
                      <div className="truncate text-[12px] text-ink-3">
                        {t.payee && t.payee.toLowerCase() !== t.description.toLowerCase() ? t.description : null}
                        {t.tags?.length ? <span className="ml-1.5 text-accent">#{t.tags.join(' #')}</span> : null}
                      </div>
                    </button>
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
      {query.data && query.data.total > items.length && <div className="mt-2 text-[12.5px] text-ink-3">Showing the newest {items.length.toLocaleString()} of {query.data.total.toLocaleString()}. Narrow the filters to see the rest.</div>}
      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <div className="w-48">
          <CategorySelect value={bulkCategory} onChange={setBulkCategory} placeholder="Choose category" />
        </div>
        <Button size="sm" variant="primary" disabled={!bulkCategory} loading={bulk.isPending} onClick={() => bulk.mutate({ ids: [...selected], category: bulkCategory })}>
          Set category
        </Button>
        <Input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder="tag" className="h-8 w-28" aria-label="Tag" />
        <Button size="sm" disabled={!bulkTag.trim()} onClick={() => bulk.mutate({ ids: [...selected], addTags: [bulkTag.trim()] })}>
          Add tag
        </Button>
      </SelectionBar>
      {open && <TransactionDrawer tx={open} onClose={() => setOpen(null)} />}
      <span className="sr-only">{cats.list.length} categories</span>
    </div>
  );
}
