// Settings → Audit log: who did what to your data and when, searchable (src/server/audit.ts).

import { ChevronDown, ChevronRight, Download, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { actorName, type AuditActor, type AuditEntry, type AuditResponse, type AuditVerifyResponse, type ChangeDiff, type FieldChanges } from '../../shared/audit';
import { formatDate } from '../../shared/dates';
import { api, qs, useApi } from '../lib/api';
import { cn, fileSize, plural } from '../lib/format';
import { Badge, Button, Callout, Card, Checkbox, Field, Input, KeyValue, Loading, Select, StatusBadge, useDebounced } from './ui';

const WHO: [string, string][] = [
  ['', 'Anyone'],
  ['owner', 'You'],
  ['token', 'Agent tokens'],
  ['job', 'Agent jobs'],
  ['app', 'The app'],
  ['outside', 'Outside the app'],
  ['anonymous', 'Not signed in'],
];

const WHAT: [string, string][] = [
  ['', 'Everything'],
  ['data', 'Changes to the data'],
  ['request', 'Requests'],
  ['auth', 'Signing in and out'],
  ['import', 'Imports'],
  ['job', 'Agent jobs'],
  ['session', 'Claude sessions'],
  ['proposal', 'Proposed fixes'],
  ['token', 'Tokens'],
  ['app', 'App start and stop'],
];

const CATEGORY_NAMES: Record<string, string> = { data: 'Data', request: 'Request', auth: 'Sign-in', import: 'Import', job: 'Job', session: 'Claude session', proposal: 'Proposal', token: 'Token', app: 'App' };
const STEP = 100;

/** "2 Oct 2026 14:03:07", in this browser's time. */
export function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Where a person or agent was: "100.64.0.9 · my-laptop". */
function place(a: AuditActor): string | undefined {
  if (a.type !== 'owner' && a.type !== 'token' && a.type !== 'anonymous') return undefined;
  return [a.ip, a.device].filter(Boolean).join(' · ');
}

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-ink-3">none</span>;
  return <span className="sensitive font-mono text-[12px] break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</span>;
}

function Fields({ fields }: { fields: FieldChanges }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {Object.entries(fields).map(([k, [a, b]]) => (
        <li key={k} className="min-w-0">
          <span className="text-ink-2">{k}</span>: <Value v={a} /> <span className="text-ink-3">→</span> <Value v={b} />
        </li>
      ))}
    </ul>
  );
}

const OP_WORDS = { added: 'Added', removed: 'Removed', changed: 'Changed' };

function Diff({ diff, onSearch }: { diff: ChangeDiff; onSearch: (q: string) => void }) {
  const counts = (['added', 'changed', 'removed'] as const).filter((k) => diff[k]).map((k) => `${diff[k]} ${k}`);
  const shown = diff.items?.length ?? 0;
  const total = (diff.added ?? 0) + (diff.changed ?? 0) + (diff.removed ?? 0);
  return (
    <div className="flex flex-col gap-2">
      {counts.length > 0 && (
        <p className="text-ink-2">
          {counts.join(', ')}
          {total > shown && shown > 0 ? ` (the first ${shown} shown)` : ''}
        </p>
      )}
      {diff.fields && <Fields fields={diff.fields} />}
      {diff.items && (
        <ul className="flex flex-col gap-1.5">
          {diff.items.map((it) => (
            <li key={`${it.op}-${it.id}`} className="min-w-0">
              <span className="text-ink-2">{OP_WORDS[it.op]}</span>{' '}
              <button type="button" className="font-mono text-[12px] text-accent hover:underline" onClick={() => onSearch(it.id)}>
                {it.id}
              </button>
              {it.label && <span className="sensitive text-ink-2"> {it.label}</span>}
              {it.fields && (
                <div className="mt-0.5 pl-4">
                  <Fields fields={it.fields} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A value you can click to search for everything else with it. */
function Find({ children, q, onSearch, mono }: { children: ReactNode; q: string; onSearch: (q: string) => void; mono?: boolean }) {
  return (
    <button type="button" title={`Search for ${q}`} className={cn('text-left text-accent hover:underline', mono && 'font-mono text-[12px]')} onClick={() => onSearch(q)}>
      {children}
    </button>
  );
}

function actorRows(a: AuditActor, onSearch: (q: string) => void): [ReactNode, ReactNode][] {
  const rows: [ReactNode, ReactNode][] = [['Who', actorName(a)]];
  if (a.type === 'token') {
    rows.push(['Token', <Find key="t" q={a.tokenId} onSearch={onSearch} mono>{a.tokenId}</Find>]);
    rows.push(['Its scopes', a.scopes.join(', ') || 'none']);
  }
  if (a.type === 'job') {
    rows.push(['Job', <Find key="j" q={a.jobId} onSearch={onSearch} mono>{a.jobId}</Find>]);
    rows.push(['Kind', `${a.kind}${a.label ? `: ${a.label}` : ''}`]);
    rows.push(['Started by', a.trigger]);
  }
  if (a.type === 'owner' || a.type === 'token' || a.type === 'anonymous') {
    rows.push(['Address', <Find key="ip" q={a.ip} onSearch={onSearch} mono>{a.ip}</Find>]);
    if (a.device) rows.push(['Device', <Find key="d" q={a.device} onSearch={onSearch}>{a.device}</Find>]);
    if (a.tailnetUser) rows.push(['Tailnet user', a.tailnetUser]);
    if (a.userAgent) rows.push(['Browser', <span key="ua" className="text-[12px] break-all text-ink-2">{a.userAgent}</span>]);
  }
  if (a.type === 'anonymous' && a.claimedToken) rows.push(['Token presented', <Find key="c" q={a.claimedToken} onSearch={onSearch} mono>{a.claimedToken} (not valid)</Find>]);
  return rows;
}

function EntryDetails({ e, onSearch, onRequest }: { e: AuditEntry; onSearch: (q: string) => void; onRequest: (id: string) => void }) {
  const items: [ReactNode, ReactNode][] = [['When', `${when(e.at)} (entry #${e.seq})`], ...actorRows(e.actor, onSearch), ['Action', <span key="a" className="font-mono text-[12px]">{e.action}</span>]];
  if (e.request) {
    const r = e.request;
    items.push([
      'Request',
      <span key="r" className="font-mono text-[12px] break-all">
        {r.method} {r.path} → {r.status}
        {r.ms !== undefined ? ` in ${r.ms} ms` : ''}
        {r.bytes !== undefined && r.contentType && !r.body ? ` (${r.contentType}, ${fileSize(r.bytes)})` : ''}
      </span>,
    ]);
    if (r.error) items.push(['Answer', r.error]);
    if (r.body !== undefined) items.push(['Sent', <pre key="b" className="sensitive max-h-60 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[12px] whitespace-pre-wrap">{JSON.stringify(r.body, null, 2)}</pre>]);
  }
  if (e.changes?.length) {
    items.push([
      'What it did',
      <ol key="c" className="flex list-decimal flex-col gap-1 pl-4">
        {e.changes.map((c) => (
          <li key={c.seq}>
            {c.summary}
            {c.commit && (
              <>
                {' '}
                <Badge tone="muted">commit {c.commit}</Badge>
              </>
            )}
            {c.paths && <div className="font-mono text-[12px] break-all text-ink-3">{c.paths.join(', ')}</div>}
          </li>
        ))}
      </ol>,
    ]);
  }
  if (e.paths?.length) items.push(['Files', <span key="p" className="font-mono text-[12px] break-all">{e.paths.join(', ')}</span>]);
  if (e.commit) items.push(['Git commit', <Find key="g" q={e.commit} onSearch={onSearch} mono>{e.commit}</Find>]);
  if (e.diff) items.push(['Changed', <Diff key="d" diff={e.diff} onSearch={onSearch} />]);
  if (e.details) items.push(['Details', <pre key="x" className="sensitive max-h-60 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[12px] whitespace-pre-wrap">{JSON.stringify(e.details, null, 2)}</pre>]);
  if (e.targets?.length)
    items.push([
      'Concerns',
      <span key="t" className="flex flex-wrap gap-x-3 gap-y-1">
        {e.targets.map((t) => (
          <Find key={t} q={t} onSearch={onSearch} mono>
            {t}
          </Find>
        ))}
      </span>,
    ]);
  if (e.sessions?.length)
    items.push([
      'Claude sessions',
      <span key="s" className="flex flex-col gap-0.5">
        {e.sessions.map((s) => (
          <Link key={s.id} to={`/sessions/${s.id}`} className="text-accent hover:underline">
            {s.title}
          </Link>
        ))}
      </span>,
    ]);
  if (e.requestId)
    items.push([
      'Request id',
      <button key="q" type="button" className="font-mono text-[12px] text-accent hover:underline" onClick={() => onRequest(e.requestId!)}>
        {e.requestId} (everything it did)
      </button>,
    ]);
  items.push(['Chain hash', <span key="h" className="font-mono text-[11px] break-all text-ink-3">{e.hash}</span>]);
  return <KeyValue items={items} className="border-t border-line bg-panel-2/40 px-5 py-4" />;
}

function Row({ e, open, onToggle, onSearch, onRequest }: { e: AuditEntry; open: boolean; onToggle: () => void; onSearch: (q: string) => void; onRequest: (id: string) => void }) {
  const where = place(e.actor);
  return (
    <li className="border-t border-line">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-panel-2/60">
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] break-words text-ink">{e.summary}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <span className="whitespace-nowrap">{when(e.at)}</span>
            <span>{actorName(e.actor)}</span>
            {where && <span className="font-mono">{where}</span>}
            <Badge tone="muted">{CATEGORY_NAMES[e.category] ?? e.category}</Badge>
            {e.changes && e.changes.length > 0 && <span>{plural(e.changes.length, 'step')}</span>}
            {e.sessions && e.sessions.length > 0 && <Badge tone="accent">{e.sessions.length === 1 ? 'Claude session' : `${e.sessions.length} Claude sessions`}</Badge>}
            {e.outcome === 'refused' && <StatusBadge status="warn">Refused</StatusBadge>}
            {e.outcome === 'failed' && <StatusBadge status="bad">Failed</StatusBadge>}
          </span>
        </span>
      </button>
      {open && <EntryDetails e={e} onSearch={onSearch} onRequest={onRequest} />}
    </li>
  );
}

export function AuditLog() {
  // Opened from elsewhere (a Claude session's rows): Settings?audit=<search>#audit.
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get('audit') ?? '');
  const [who, setWho] = useState('');
  const [what, setWhat] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(STEP);
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<AuditVerifyResponse | 'checking' | Error | null>(null);
  const q = useDebounced(text.trim(), 300);
  const filters = { q, actor: who, category: what, outcome, from, to, all: all ? 1 : undefined };
  const res = useApi<AuditResponse>(['audit', filters, limit], `/audit${qs({ ...filters, limit })}`);
  const d = res.data;
  const search = (v: string) => {
    setText(v);
    setLimit(STEP);
  };
  const showRequest = (id: string) => {
    setText(id);
    setAll(true);
    setWho('');
    setWhat('');
    setOutcome('');
    setLimit(STEP);
  };
  const check = () => {
    setVerify('checking');
    api<AuditVerifyResponse>('/audit/verify').then(setVerify, (err: Error) => setVerify(err));
  };
  const filtered = Boolean(q || who || what || outcome || from || to);
  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Audit log"
        description="Every change to your data and to the app’s work area: who made it (you, with the address and device it came from; an agent’s token; an agent job; the app by itself; or a file changed outside the app), when, and what it changed, field by field. It sits beside git’s history and is kept in the work area, never in your data."
      >
        {d ? (
          <div className="flex flex-col gap-3 text-[13px] text-ink-2">
            <p>
              {plural(d.status.entries, 'entry', 'entries')}
              {d.status.firstAt ? ` since ${when(d.status.firstAt)}` : ''}, {fileSize(d.status.bytes)}. Each entry is written to disk before the app answers and carries a hash of the one before it, so an entry removed or altered afterwards shows up when the chain is checked.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<ShieldCheck className="size-3.5" />} loading={verify === 'checking'} onClick={check}>
                Check the chain
              </Button>
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => window.location.assign(`/api/audit/export${qs(filters)}`)}>
                {filtered ? 'Export these' : 'Export all'} (JSON lines)
              </Button>
            </div>
            {verify instanceof Error && <Callout tone="bad">{verify.message}</Callout>}
            {verify && verify !== 'checking' && !(verify instanceof Error) && (
              <Callout tone={verify.ok ? 'good' : 'bad'} title={verify.ok ? 'The chain is whole' : 'The chain is broken'}>
                {plural(verify.entries, 'entry', 'entries')} in {plural(verify.files, 'file')} checked.
                {verify.unreadable > 0 && ` ${plural(verify.unreadable, 'line')} could not be read.`}
                {verify.problems.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {verify.problems.map((p, i) => (
                      <li key={i}>
                        {p.file} line {p.line}
                        {p.seq !== undefined ? ` (#${p.seq})` : ''}: {p.problem}
                      </li>
                    ))}
                  </ul>
                )}
              </Callout>
            )}
            {(d.status.failures > 0 || d.status.unwritten > 0) && (
              <Callout tone="bad" title="Some entries could not be written">
                {d.status.unwritten > 0 ? `${plural(d.status.unwritten, 'entry', 'entries')} waiting to be written; the app keeps trying. ` : ''}
                {d.status.lastError ? `Last error: ${d.status.lastError}` : 'Writing works again.'}
              </Callout>
            )}
          </div>
        ) : res.error ? (
          <Callout tone="bad">{res.error.message}</Callout>
        ) : (
          <Loading />
        )}
      </Card>

      <Card padded={false}>
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Search" className="sm:col-span-2 lg:col-span-3">
            <Input type="search" value={text} onChange={(e) => search(e.target.value)} placeholder="Any words: a payee, an id, an address, a device, a file, a commit…" />
          </Field>
          <Field label="Who">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              {WHO.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What">
            <Select value={what} onChange={(e) => setWhat(e.target.value)}>
              {WHAT.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Outcome">
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Any</option>
              <option value="ok">Done</option>
              <option value="refused">Refused</option>
              <option value="failed">Failed</option>
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox checked={all} onChange={setAll} label="Each step separately" />
          </div>
        </div>
        <p className="border-t border-line px-5 py-2.5 text-[12px] text-ink-3">
          {all ? 'Every entry on its own, including each write a request made and each git commit.' : 'One line per action: what a request did is inside it (open it to see each step and its commit).'}
        </p>
        {!d ? null : d.entries.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">{filtered ? 'Nothing matches.' : 'Nothing recorded yet.'}</p>
        ) : (
          <ul className={cn(res.isFetching && 'opacity-70')}>
            {d.entries.map((e) => (
              <Row key={e.seq} e={e} open={open === e.seq} onToggle={() => setOpen(open === e.seq ? null : e.seq)} onSearch={search} onRequest={showRequest} />
            ))}
          </ul>
        )}
        {d?.next !== undefined && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px] text-ink-3">
            <span>Showing the latest {d.entries.length}.</span>
            {limit < 1000 ? (
              <Button size="sm" loading={res.isFetching} onClick={() => setLimit((l) => Math.min(l + STEP * 2, 1000))}>
                Show older
              </Button>
            ) : (
              <span>Narrow the search, or export, to see older ones.</span>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
