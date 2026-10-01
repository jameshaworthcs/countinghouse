import { Archive, ChevronRight, CircleCheck, CircleDashed, CopyCheck, FileImage, FileSpreadsheet, FileText, FolderInput, LoaderCircle, Sparkles, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { CaptureAskView, CaptureItemView, CaptureResponse, ImportHistoryResponse, ImportListResponse, MonthlyChecklistResponse, SystemResponse } from '../../shared/api';
import type { ImportRecord } from '../../shared/schema';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Loading, PageHeader, Pager, StatusBadge, useToast } from '../components/ui';
import { ProposalQueue } from '../components/Proposals';
import { DropZone, FilePickerButton } from '../components/Upload';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, fileSize, formatDate, formatMonth, money, plural, timeAgo } from '../lib/format';
import { OlderReadings } from '../components/ReadAgain';

type Pending = ImportListResponse['pending'][number];

export function FileIcon({ mediaType, className }: { mediaType: string; className?: string }) {
  const Icon = mediaType.startsWith('image/') ? FileImage : mediaType === 'application/pdf' ? FileText : FileSpreadsheet;
  return <Icon className={cn('size-5 shrink-0 text-ink-3', className)} aria-hidden />;
}

export function importStatus(r: Pick<ImportRecord, 'status'> & { nothingNew?: unknown }) {
  // Understood, and adds nothing: not a problem, and nothing to commit.
  if (r.status === 'review' && r.nothingNew) {
    return (
      <Badge tone="neutral" icon={<CopyCheck className="size-3.5" aria-hidden />}>
        Nothing new
      </Badge>
    );
  }
  switch (r.status) {
    case 'queued':
      return <StatusBadge status="pending">Queued</StatusBadge>;
    case 'processing':
      return <StatusBadge status="pending">Reading…</StatusBadge>;
    case 'needs_mapping':
      return <StatusBadge status="warn">Map columns</StatusBadge>;
    case 'review':
      return <StatusBadge status="info">Ready to review</StatusBadge>;
    case 'failed':
      return <StatusBadge status="bad">Failed</StatusBadge>;
    case 'committed':
      return <StatusBadge status="good">Committed</StatusBadge>;
    default:
      return <Badge tone="muted">{r.status}</Badge>;
  }
}

function describeDraft(p: Pending, accountName: (id: string) => string): string {
  if (!p.draft) return '';
  const parts = p.draft.sections.map((s) => {
    const name = s.target.mode === 'existing' ? accountName(s.target.accountId) : s.target.mode === 'new' ? `new: ${s.target.account.name}` : 'skipped';
    const n = s.transactions.filter((t) => t.include).length;
    const bits = [n ? plural(n, 'transaction') : '', s.recordBalance && s.balance !== undefined ? money(s.balance) : ''].filter(Boolean);
    return `${name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  });
  if (p.draft.figures.length) parts.push(plural(p.draft.figures.length, 'tax figure'));
  return parts.join(' · ');
}

function QueueItem({ p }: { p: Pending }) {
  const { accountName } = useAppData();
  const toast = useToast();
  const commit = useApiMutation(() => api(`/imports/${p.id}/commit`, { method: 'POST' }), { onSuccess: () => toast({ tone: 'good', text: `${p.document.fileName} committed` }) });
  const discard = useApiMutation(() => api(`/imports/${p.id}`, { method: 'DELETE' }));
  const dismiss = useApiMutation(() => api(`/imports/${p.id}/dismiss`, { method: 'POST' }), { onSuccess: () => toast({ tone: 'good', text: `${p.document.fileName} filed with your documents; nothing recorded` }) });
  const busy = p.status === 'processing' || p.status === 'queued';
  const nothingNew = p.status === 'review' ? p.nothingNew : undefined;
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
      {busy ? <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-accent" /> : <FileIcon mediaType={p.document.mediaType} className="mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/import/${p.id}`} className="truncate text-[14px] font-medium text-ink hover:underline">
            {p.document.fileName}
          </Link>
          {importStatus(p)}
        </div>
        <div className={cn('text-[12.5px] text-ink-3', nothingNew ? 'line-clamp-2' : 'truncate')}>
          {busy
            ? `${fileSize(p.document.size)} · ${p.document.mediaType.startsWith('image/') || p.document.mediaType === 'application/pdf' ? 'being read by Claude, usually under a minute' : 'parsing'}`
            : p.status === 'failed'
              ? p.extraction.error
              : nothingNew
                ? nothingNew.reason
                : describeDraft(p, accountName)}
        </div>
        {p.status === 'review' && p.readiness && !p.readiness.ready && !nothingNew && <div className="text-[12px] text-ink-3">Needs a look: {p.readiness.reasons.join(', ')}</div>}
        {dismiss.error && <div className="text-[12px] text-bad-ink">{dismiss.error.message}</div>}
      </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {p.status === 'review' && p.readiness?.ready && (
          <Button size="sm" variant="primary" loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
            Commit
          </Button>
        )}
        {nothingNew && (
          <Button size="sm" icon={<Archive className="size-3.5" />} loading={dismiss.isPending} onClick={() => dismiss.mutate(undefined)}>
            Dismiss
          </Button>
        )}
        {!busy && (
          <Link to={`/import/${p.id}`}>
            <Button size="sm" icon={<ChevronRight className="size-3.5" />}>
              {p.status === 'needs_mapping' ? 'Map' : p.status === 'failed' ? 'Details' : 'Review'}
            </Button>
          </Link>
        )}
        <button className="rounded-lg p-2 text-ink-3 hover:bg-panel-2 hover:text-bad-ink" aria-label={`Discard ${p.document.fileName}`} onClick={() => discard.mutate(undefined)}>
          <Trash2 className="size-4" />
        </button>
      </div>
    </li>
  );
}

function EngineLine() {
  const sys = useApi<SystemResponse>(['system'], '/system');
  const { data } = useAppData();
  if (!sys.data) return null;
  const engine = sys.data.engines.find((e) => e.id === sys.data.selectedEngine);
  return (
    <p className="text-[12.5px] text-ink-3">
      <Sparkles className="mr-1 inline size-3.5 align-[-2px] text-accent" />
      PDFs and screenshots are read by{' '}
      {engine ? (
        <span className="text-ink-2">
          {engine.id === 'claude-cli' ? `Claude (${data.settings.extraction.model}) via your Claude login` : engine.id === 'claude-api' ? `the Claude API (${data.settings.extraction.model})` : 'offline OCR (lower accuracy)'}
          {engine.external ? ', which sends them to Anthropic' : ''}
        </span>
      ) : (
        <span className="text-bad-ink">nothing yet: no engine is available</span>
      )}
      . CSV, OFX, QIF and TXT exports, HMRC’s pages saved from gov.uk and payslips in a layout known here are read on this machine.{' '}
      <Link to="/settings#extraction" className="text-accent hover:underline">
        Change
      </Link>
    </p>
  );
}

function CaptureAskRow({ itemId, ask }: { itemId: string; ask: CaptureAskView }) {
  const tick = useApiMutation((done: boolean) => api(`/capture/${itemId}/asks/${ask.id}`, { method: 'PATCH', body: { done } }));
  const byData = ask.state === 'done' && !ask.tickedByYou;
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      {byData ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" aria-label="Done: your data shows it" />
      ) : (
        <Checkbox className="mt-0.5" checked={ask.state === 'done'} disabled={tick.isPending} onChange={(v) => tick.mutate(v)} />
      )}
      <div className="min-w-0 flex-1 text-[13px]">
        <div className={cn('text-ink', ask.state === 'done' && 'text-ink-3 line-through decoration-ink-3/40')}>{ask.what}</div>
        {ask.state !== 'done' && ask.how && <div className="mt-0.5 text-[12.5px] text-ink-3">{ask.how}</div>}
        {ask.state !== 'done' && ask.why && <div className="mt-0.5 text-[12.5px] text-ink-3">Why: {ask.why}</div>}
        {ask.progress && <div className={cn('mt-0.5 text-[12px]', ask.state === 'partial' ? 'text-warn-ink' : 'text-ink-3')}>{ask.progress}</div>}
        {ask.state !== 'done' && ask.checkedByData && <div className="mt-0.5 text-[11.5px] text-ink-3">Ticks itself once imported.</div>}
      </div>
    </li>
  );
}

function CaptureItemRow({ item }: { item: CaptureItemView }) {
  const skip = useApiMutation((skipped: boolean) => api(`/capture/${item.id}`, { method: 'PATCH', body: { skipped } }));
  const left = item.asks.filter((a) => a.state !== 'done').length;
  return (
    <li className={cn('px-5 py-3.5', item.skipped && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {item.done ? <CircleCheck className="size-4 shrink-0 text-good-ink" /> : <CircleDashed className="size-4 shrink-0 text-ink-3" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {item.accountId ? (
              <Link to={`/accounts/${item.accountId}`} className="text-[14px] font-medium text-ink hover:underline">
                {item.title}
              </Link>
            ) : (
              <span className="text-[14px] font-medium text-ink">{item.title}</span>
            )}
            {item.priority === 'high' && !item.done && !item.skipped && <Badge tone="accent">first</Badge>}
            {item.skipped && <Badge tone="muted">skipped</Badge>}
            {!item.done && !item.skipped && <span className="text-[12px] text-ink-3">{plural(left, 'thing')} left</span>}
          </div>
          {item.note && !item.done && <div className="mt-0.5 text-[12.5px] text-ink-3">{item.note}</div>}
        </div>
        <div className="flex items-center gap-2">
          {!item.done && !item.skipped && (
            <FilePickerButton accountId={item.accountId} size="sm" icon={<Upload className="size-3.5" />}>
              Upload
            </FilePickerButton>
          )}
          {!item.done && (
            <Button size="sm" variant="ghost" loading={skip.isPending} onClick={() => skip.mutate(!item.skipped)}>
              {item.skipped ? 'Restore' : 'Skip'}
            </Button>
          )}
        </div>
      </div>
      {!item.skipped && (
        <ul className="mt-1.5 pl-6.5">
          {item.asks.map((a) => (
            <CaptureAskRow key={a.id} itemId={item.id} ask={a} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** What to collect from each provider for a big import; items come from data/capture.json. */
function CaptureList() {
  const q = useApi<CaptureResponse>(['capture'], '/capture');
  const [showAll, setShowAll] = useState(false);
  const location = useLocation();
  const c = q.data;
  const ready = Boolean(c?.items.length);
  // The card renders after its data arrives, too late for the browser's own jump to #capture.
  useEffect(() => {
    if (ready && location.hash === '#capture') document.getElementById('capture')?.scrollIntoView({ block: 'start' });
  }, [ready, location.hash]);
  if (!c || !c.items.length) return null;
  const open = c.items.filter((i) => !i.done && !i.skipped);
  const rest = c.items.length - open.length;
  const shown = showAll ? c.items : open;
  return (
    <Card
      id="capture"
      title="Capture list"
      description={`${c.asksDone} of ${plural(c.asks, 'thing')} collected. Statements and valuations tick themselves once imported; tick the rest as you collect them.`}
      padded={false}
      actions={
        rest > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Hide done and skipped' : `Show done and skipped (${rest})`}
          </Button>
        ) : undefined
      }
    >
      <div className="mx-5 mb-3 h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={c.asks} aria-valuenow={c.asksDone} aria-label="Collected">
        <div className="h-full rounded-full bg-[var(--seq-5)]" style={{ width: `${c.asks ? (c.asksDone / c.asks) * 100 : 0}%` }} />
      </div>
      {shown.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {shown.map((i) => (
            <CaptureItemRow key={i.id} item={i} />
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2 border-t border-line px-5 py-4 text-[13px] text-good-ink">
          <CircleCheck className="size-4" /> Everything on the list is collected.
        </div>
      )}
    </Card>
  );
}

function Monthly() {
  const q = useApi<MonthlyChecklistResponse>(['monthly'], '/monthly');
  const m = q.data;
  if (!m) return <Loading />;
  if (!m.total) return null;
  return (
    <Card title={`Monthly update · ${formatMonth(m.month)}`} description={`${m.done} of ${m.total} accounts are up to date. Upload straight onto an account to skip matching.`} padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {m.items.map((i) => (
          <li key={i.accountId} className="flex flex-wrap items-center gap-3 px-5 py-3">
            {i.due ? <TriangleAlert className={cn('size-4 shrink-0', i.status === 'due' ? 'text-ink-3' : 'text-warn-ink')} /> : <CircleCheck className="size-4 shrink-0 text-good-ink" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/accounts/${i.accountId}`} className="text-[14px] font-medium text-ink hover:underline">
                  {i.name}
                </Link>
                <Badge tone="muted">{i.want}</Badge>
                <span className="text-[12px] text-ink-3">{i.lastData ? `latest data ${formatDate(i.lastData)} (${timeAgo(i.lastData)})` : 'no data yet'}</span>
              </div>
              {i.due && <div className="mt-0.5 text-[12.5px] text-ink-3">{i.tip}</div>}
            </div>
            {i.due && (
              <FilePickerButton accountId={i.accountId} size="sm" icon={<Upload className="size-3.5" />}>
                Upload
              </FilePickerButton>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Every committed import, the latest first, a page at a time. The page is kept in the address
 * (`?history=`), so coming back from an import's page returns to it.
 */
function History() {
  const [params, setParams] = useSearchParams();
  const asked = Math.max(1, Math.trunc(Number(params.get('history'))) || 1);
  const q = useApi<ImportHistoryResponse>(['imports', 'history', asked], `/imports/history${qs({ page: asked > 1 ? asked : undefined })}`);
  const h = q.data;
  const pages = h ? Math.max(1, Math.ceil(h.total / h.pageSize)) : 1;
  const go = (page: number) => {
    const next = new URLSearchParams(params);
    if (page > 1) next.set('history', String(page));
    else next.delete('history');
    setParams(next, { replace: true });
    document.getElementById('history')?.scrollIntoView({ block: 'start' });
  };
  return (
    <Card id="history" title="History" padded={false} className="scroll-mt-16 lg:scroll-mt-5">
      {!h ? (
        <div className="px-5">
          <Loading />
        </div>
      ) : h.items.length ? (
        <>
          <ul className="divide-y divide-line border-t border-line">
            {h.items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                <FileIcon mediaType={c.mediaType} className="size-4" />
                <Link to={`/import/${c.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                  {c.fileName}
                </Link>
                <span className="hidden text-ink-3 sm:inline">
                  {c.result?.nothingNew ? 'filed, nothing new' : c.result ? [c.result.transactionsAdded ? `+${plural(c.result.transactionsAdded, 'transaction')}` : '', c.result.balancesAdded ? 'balance' : '', c.result.holdingsAdded ? 'holdings' : '', c.result.figuresAdded ? plural(c.result.figuresAdded, 'figure') : ''].filter(Boolean).join(', ') : ''}
                </span>
                <span className="w-24 text-right text-ink-3">{c.committedAt ? formatDate(c.committedAt.slice(0, 10)) : ''}</span>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <Pager page={h.page} pages={pages} onPage={go} label="History pages" className="border-t border-line px-5 py-2">
              <span className="text-[13px] text-ink-3 tabular-nums">
                {(h.page - 1) * h.pageSize + 1}–{(h.page - 1) * h.pageSize + h.items.length} of {h.total}
              </span>
            </Pager>
          )}
        </>
      ) : (
        <EmptyState title="Nothing imported yet" />
      )}
    </Card>
  );
}

export default function Import() {
  const q = useApi<ImportListResponse>(['imports'], '/imports', { refetchInterval: 5000 });
  const { data } = useAppData();
  const toast = useToast();
  const commitReady = useApiMutation(() => api<{ committed: string[]; skipped: { id: string }[] }>('/imports/commit-ready', { method: 'POST' }), {
    onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.committed.length, 'import')} committed${r.skipped.length ? `, ${r.skipped.length} need a look` : ''}` }),
  });
  const dismissAll = useApiMutation(() => api<{ dismissed: string[] }>('/imports/dismiss-nothing-new', { method: 'POST' }), {
    onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.dismissed.length, 'file')} with nothing new filed with your documents` }),
  });
  const pending = q.data?.pending ?? [];
  const ready = pending.filter((p) => p.readiness?.ready).length;
  const nothingNew = pending.filter((p) => p.status === 'review' && p.nothingNew).length;
  return (
    <div>
      <PageHeader title="Import" subtitle="Statements, exports and screenshots in; reviewed data out" />
      <div className="flex flex-col gap-5">
        <DropZone />
        <EngineLine />
        {pending.length > 0 && (
          <Card
            title="Waiting for you"
            padded={false}
            actions={
              ready > 1 || nothingNew > 1 ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {nothingNew > 1 && (
                    <Button size="sm" icon={<Archive className="size-3.5" />} loading={dismissAll.isPending} onClick={() => dismissAll.mutate(undefined)}>
                      Dismiss {nothingNew} with nothing new
                    </Button>
                  )}
                  {ready > 1 && (
                    <Button size="sm" variant="primary" loading={commitReady.isPending} onClick={() => commitReady.mutate(undefined)}>
                      Commit all ready ({ready})
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          >
            <ul className="divide-y divide-line border-t border-line">
              {pending.map((p) => (
                <QueueItem key={p.id} p={p} />
              ))}
            </ul>
          </Card>
        )}
        <ProposalQueue />
        <CaptureList />
        <Monthly />
        <Callout tone="neutral" title="Inbox folder" action={<FolderInput className="size-5 text-ink-3" />}>
          Files saved into <code className="rounded bg-panel px-1">{data.inboxDir}</code> are imported automatically. Point a Syncthing or cloud-sync folder that your phone saves screenshots to at it, and your monthly screenshots arrive here on their own.
        </Callout>
        <History />
        <OlderReadings />
      </div>
    </div>
  );
}
