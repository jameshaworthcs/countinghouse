// Claude sessions: every time the app ran Claude (agent jobs, readings of imports, reading stored
// documents again, receipts), and agents with your tokens by their requests. One session shows what
// started it, its transcript, everything it produced and its rows in the audit log
// (src/server/sessions.ts, sessionviews.ts).

import { ArrowLeft, ChevronDown, ChevronRight, CircleStop } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { actorName, type AuditEntry } from '../../shared/audit';
import type { SessionDetail, SessionListResponse, SessionSearchResponse, SessionSummary, SessionTotalsResponse, SessionTotalsRow, TranscriptResponse } from '../../shared/sessions';
import { when } from '../components/Audit';
import { Badge, Button, Callout, Card, Checkbox, Field, Input, KeyValue, Loading, PageHeader, Select, StatusBadge, tableClasses, useDebounced } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, fileSize, plural } from '../lib/format';

const KIND_NAMES: Record<SessionSummary['kind'], string> = { job: 'Agent job', reading: 'Import reading', reread: 'Read again', receipt: 'Receipt', ask: 'Question (Ask)', token: 'Agent with a token' };
/** What a session belongs to, in a word. */
const PARENT_WORD = (s: SessionSummary) => (s.kind === 'job' ? 'job' : s.kind === 'receipt' ? 'receipt' : s.kind === 'ask' ? 'conversation' : 'import');
const ROLE_NAMES = { first: 'first reading', second: 'second reading (the check)' };
const ENGINE_NAMES = { inference: 'Local model service (this machine)', 'claude-cli': 'Claude Code CLI', 'claude-api': 'Claude API' };

function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

const cost = (usd: number | undefined) => (usd === undefined ? '' : `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`);

export function SessionStatus({ s }: { s: Pick<SessionSummary, 'status' | 'source'> }) {
  if (s.status === 'running') return <StatusBadge status="pending">{s.source === 'token' ? 'Active' : 'Running'}</StatusBadge>;
  if (s.status === 'failed') return <StatusBadge status="bad">Failed</StatusBadge>;
  if (s.status === 'cancelled') return <Badge tone="muted">Cancelled</Badge>;
  return <StatusBadge status="good">{s.source === 'token' ? 'Ended' : 'Done'}</StatusBadge>;
}

function TranscriptBadge({ s }: { s: SessionSummary }) {
  if (s.transcript === 'kept') return null;
  if (s.transcript === 'truncated') return <Badge tone="muted">Transcript cut at its cap</Badge>;
  if (s.transcript === 'removed') return <Badge tone="muted">Transcript deleted</Badge>;
  return <Badge tone="muted">{s.source === 'token' ? 'Requests only' : 'No transcript'}</Badge>;
}

function Facts({ s }: { s: SessionSummary }) {
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
      <span className="whitespace-nowrap">{when(s.startedAt)}</span>
      <Badge tone="neutral">{KIND_NAMES[s.kind]}</Badge>
      <span>{s.startedBy}</span>
      {s.model && <span className="font-mono">{s.model}</span>}
      {s.promptVersion && <span className="font-mono">{s.promptVersion}</span>}
      {s.durationMs !== undefined && <span>{duration(s.durationMs)}</span>}
      {s.costUsd !== undefined && <span className="tabular">{cost(s.costUsd)}</span>}
      {s.requests && (
        <span>
          {plural(s.requests.total, 'request')}
          {s.requests.changes ? `, ${plural(s.requests.changes, 'change')}` : ''}
          {s.requests.refused ? `, ${s.requests.refused} refused` : ''}
        </span>
      )}
      <SessionStatus s={s} />
      <TranscriptBadge s={s} />
    </span>
  );
}

/** Spend and local-model time by month, task and engine. */
function Totals() {
  const res = useApi<SessionTotalsResponse>(['sessions', 'totals'], '/sessions/totals');
  const months = useMemo(() => [...new Set((res.data?.rows ?? []).map((r) => r.month))], [res.data]);
  const [month, setMonth] = useState('');
  const shown = month || months[0] || '';
  const rows = (res.data?.rows ?? []).filter((r) => r.month === shown);
  const sum = (k: keyof Pick<SessionTotalsRow, 'sessions' | 'failed' | 'cancelled' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'gpuMs'>) => rows.reduce((n, r) => n + r[k], 0);
  if (!res.data || !months.length) return null;
  const th = tableClasses.th;
  const td = tableClasses.td;
  const num = `${tableClasses.td} ${tableClasses.num}`;
  return (
    <Card
      title="Totals"
      description="Each kind of work the app ran, by engine. Claude’s cost is what it reports at API prices: on your plan (the CLI) it is an estimate of the plan’s use, not a charge; on the API it is the charge. Local model time is the GPU reading prompts and writing answers."
      actions={
        <Select value={shown} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="h-8 w-36">
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={th}>Work</th>
              <th className={th}>Engine</th>
              <th className={`${th} text-right`}>Sessions</th>
              <th className={`${th} text-right`}>Failed / stopped</th>
              <th className={`${th} text-right`}>Tokens in / out</th>
              <th className={`${th} text-right`}>Claude, at API prices</th>
              <th className={`${th} text-right`}>Local model time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.task}|${r.engine}`}>
                <td className={td}>{r.task}</td>
                <td className={td}>{r.engine === 'inference' ? 'Local model' : r.engine === 'claude-api' ? 'Claude API' : 'Claude (plan)'}</td>
                <td className={num}>{r.sessions}</td>
                <td className={num}>{r.failed || r.cancelled ? `${r.failed} / ${r.cancelled}` : ''}</td>
                <td className={num}>{r.inputTokens || r.outputTokens ? `${r.inputTokens.toLocaleString()} / ${r.outputTokens.toLocaleString()}` : ''}</td>
                <td className={num}>{r.engine === 'inference' ? '' : cost(r.costUsd)}</td>
                <td className={num}>{r.gpuMs ? duration(r.gpuMs) : ''}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className={td}>All</td>
              <td className={td} />
              <td className={num}>{sum('sessions')}</td>
              <td className={num}>{`${sum('failed')} / ${sum('cancelled')}`}</td>
              <td className={num}>{`${sum('inputTokens').toLocaleString()} / ${sum('outputTokens').toLocaleString()}`}</td>
              <td className={num}>{cost(sum('costUsd'))}</td>
              <td className={num}>{duration(sum('gpuMs'))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Row({ s, snippet }: { s: SessionSummary; snippet?: string | undefined }) {
  return (
    <li className="border-t border-line">
      <Link to={`/sessions/${s.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-panel-2/60">
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] break-words text-ink">
            {s.title}
            {s.role && <span className="text-ink-3"> · {ROLE_NAMES[s.role]}</span>}
          </span>
          <Facts s={s} />
          {snippet && <span className="sensitive mt-1 block font-mono text-[11.5px] break-words text-ink-3">{snippet}</span>}
        </span>
      </Link>
    </li>
  );
}

const STEP = 100;

function SessionList() {
  const [params, setParams] = useSearchParams();
  const forId = params.get('for') ?? '';
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(STEP);
  const q = useDebounced(text.trim().toLowerCase(), 200);
  const [inside, setInside] = useState(false);
  const res = useApi<SessionListResponse>(['sessions'], '/sessions');
  // Searching inside the transcripts too: on the server, newest first.
  const found = useApi<SessionSearchResponse>(['sessions', 'search', q], inside && q.length >= 2 ? `/sessions/search?q=${encodeURIComponent(q)}` : null);
  const hits = useMemo(() => new Map((found.data?.hits ?? []).map((h) => [h.id, h])), [found.data]);
  const d = res.data;
  const rows = useMemo(
    () =>
      (d?.sessions ?? []).filter(
        (s) =>
          (!forId || [s.id, s.jobId, s.importId, s.receiptId, s.conversationId, s.tokenId].includes(forId)) &&
          (!kind || s.kind === kind) &&
          (!status || s.status === status) &&
          (!q || hits.has(s.id) || `${s.title} ${s.startedBy} ${s.reason ?? ''} ${s.model ?? ''} ${s.promptVersion ?? ''} ${s.id} ${s.jobKind ?? ''} ${s.jobId ?? ''} ${s.importId ?? ''} ${s.conversationId ?? ''} ${s.agentSession ?? ''}`.toLowerCase().includes(q)),
      ),
    [d, forId, kind, status, q, hits],
  );
  const running = d?.sessions.filter((s) => s.status === 'running' && s.source !== 'token').length ?? 0;
  const spent = rows.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  return (
    <div>
      <PageHeader title="Agent sessions" subtitle="Every time the app has run an agent, and agents using your tokens, with what each one did" />
      <div className="flex flex-col gap-5">
        {d && (
          <Callout tone="neutral">
            Transcripts include what the agent saw, document contents too, apart from the files’ own bytes. Account and card numbers keep only their last 4 digits. They’re kept in the work area beside their job or import, never in your data, git or logs. Each is deleted after {d.retention.days} days, and each is cut at {fileSize(d.retention.maxBytesPerSession)}. Together they’re held under {fileSize(d.retention.maxBytesTotal)}, oldest deleted first, and they use {fileSize(d.retention.bytes)} now. Sessions from before transcripts were kept show what their job, import or receipt recorded.
          </Callout>
        )}
        <Totals />
        <Card padded={false}>
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
            <Field label="Search" className="sm:col-span-3">
              <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={inside ? 'Words in what agents were given and said: a payee, a tool, an error…' : 'A file, a job, a model, a prompt version, an id…'} />
            </Field>
            <div className="sm:col-span-3">
              <Checkbox checked={inside} onChange={setInside} label="Search inside the transcripts too (every word must appear)" />
              {inside && q.length >= 2 && (
                <div className="mt-1 text-[12px] text-ink-3">
                  {found.isLoading ? 'Searching…' : found.error ? found.error.message : found.data ? `Found in ${plural(found.data.hits.length, 'transcript')}, of ${found.data.searched} searched${found.data.partial ? '; it stopped early, so older ones were not searched: add a word' : ''}.` : ''}
                </div>
              )}
            </div>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Every kind</option>
                {Object.entries(KIND_NAMES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any</option>
                <option value="running">Running</option>
                <option value="succeeded">Done</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </Field>
          </div>
          {forId && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-2.5 text-[12.5px] text-ink-2">
              Only the sessions of <span className="font-mono">{forId}</span>
              <button type="button" className="text-accent hover:underline" onClick={() => setParams({}, { replace: true })}>
                Show all
              </button>
            </div>
          )}
          <p className="border-t border-line px-5 py-2.5 text-[12px] text-ink-3">
            {d ? `${plural(rows.length, 'session')}${spent ? `, ${cost(spent)} at API prices` : ''}${running ? `; ${running} running now` : ''}.` : ''}
          </p>
          {!d ? (
            res.error ? <Callout tone="bad" className="m-5">{res.error.message}</Callout> : <Loading />
          ) : rows.length === 0 ? (
            <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">{d.sessions.length ? 'Nothing matches.' : 'No agent has run yet.'}</p>
          ) : (
            <ul>
              {rows.slice(0, limit).map((s) => (
                <Row key={s.id} s={s} snippet={inside ? hits.get(s.id)?.snippet : undefined} />
              ))}
            </ul>
          )}
          {rows.length > limit && (
            <div className="border-t border-line px-5 py-3 text-[13px]">
              <button type="button" className="text-accent hover:underline" onClick={() => setLimit((l) => l + STEP * 2)}>
                Show older ({rows.length - limit} more)
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── The transcript ──────────────────────────────────────────────────────────────────────────────

type Ev = Record<string, unknown>;

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn('sensitive max-h-[32rem] overflow-auto rounded-md bg-panel-2 p-2.5 font-mono text-[12px] whitespace-pre-wrap break-words text-ink', className)}>{children}</pre>;
}

/** Text for any value from a transcript. */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? `${v}` : v === null || v === undefined ? '' : JSON.stringify(v));

const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** A block that opens when clicked: long things start closed. */
function Fold({ title, open: start = false, children, tone }: { title: ReactNode; open?: boolean; children: ReactNode; tone?: 'bad' }) {
  const [open, setOpen] = useState(start);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn('flex items-center gap-1.5 text-left text-[12.5px] font-medium hover:underline', tone === 'bad' ? 'text-bad-ink' : 'text-ink-2')}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function Step({ label, at, children, tone }: { label: ReactNode; at?: unknown; children: ReactNode; tone?: 'muted' | 'bad' | 'accent' }) {
  return (
    <li className="flex flex-col gap-1 border-t border-line px-5 py-3 sm:flex-row sm:gap-3">
      <div className={cn('shrink-0 text-[12px] sm:w-28', tone === 'bad' ? 'text-bad-ink' : tone === 'accent' ? 'text-accent' : 'text-ink-3')}>
        <div className="font-medium">{label}</div>
        {typeof at === 'string' && <div className="font-mono text-[11px] text-ink-3">{at.slice(11, 19)}</div>}
      </div>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </li>
  );
}

/** A tool result's content: text, or blocks of text and files (a file's bytes are not kept). */
function ResultContent({ content }: { content: unknown }) {
  if (typeof content === 'string') return <Pre>{content}</Pre>;
  if (Array.isArray(content))
    return (
      <div className="flex flex-col gap-1.5">
        {content.map((b: Ev, i) =>
          b.type === 'text' ? (
            <Pre key={i}>{str(b.text)}</Pre>
          ) : (
            <div key={i} className="text-[12px] text-ink-3">
              {str(b.type)}
              {b.source && typeof b.source === 'object' ? `: ${str((b.source as Ev).media_type ?? '')} ${str((b.source as Ev).data ?? '')}` : ''}
            </div>
          ),
        )}
      </div>
    );
  return <Pre>{json(content)}</Pre>;
}

function ContentBlock({ b, at }: { b: Ev; at: unknown }) {
  if (b.type === 'text') return <Step label="Agent" at={at}><Pre className="bg-transparent p-0 font-sans text-[13px]">{str(b.text)}</Pre></Step>;
  if (b.type === 'thinking' || b.type === 'redacted_thinking')
    return (
      <Step label="Thinking" at={at} tone="muted">
        {b.type === 'thinking' && str(b.thinking) ? (
          <Fold title="Show its thinking">
            <Pre>{str(b.thinking)}</Pre>
          </Fold>
        ) : (
          <span className="text-[12.5px] text-ink-3">It thought first; the engine did not return the text.</span>
        )}
      </Step>
    );
  if (b.type === 'tool_use') {
    const name = str(b.name);
    if (name === 'StructuredOutput')
      return (
        <Step label="Final output" at={at} tone="accent">
          <Fold title="The output it returned" open>
            <Pre>{json(b.input)}</Pre>
          </Fold>
        </Step>
      );
    return (
      <Step label={`Tool call: ${name}`} at={at} tone="accent">
        <Pre>{json(b.input)}</Pre>
      </Step>
    );
  }
  if (b.type === 'tool_result')
    return (
      <Step label={b.is_error ? 'Tool error' : 'Tool result'} at={at} tone={b.is_error ? 'bad' : undefined}>
        <Fold title={b.is_error ? 'What the tool said' : 'What the tool gave back'} tone={b.is_error ? 'bad' : undefined}>
          <ResultContent content={b.content} />
        </Fold>
      </Step>
    );
  if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result')
    return (
      <Step label={str(b.type).replace(/_/g, ' ')} at={at}>
        <Fold title={str(b.name ?? b.type)}>
          <Pre>{json(b)}</Pre>
        </Fold>
      </Step>
    );
  return (
    <Step label={str(b.type)} at={at} tone="muted">
      <Fold title="Show">
        <Pre>{json(b)}</Pre>
      </Fold>
    </Step>
  );
}

function Event({ e }: { e: Ev }) {
  const at = e.at;
  switch (e.type) {
    case 'finance.request':
      return (
        <Step label="Sent by the app" at={at}>
          <div className="flex flex-col gap-2">
            <div className="text-[12.5px] text-ink-2">
              {ENGINE_NAMES[e.engine as 'claude-cli'] ?? str(e.engine)}, model {str(e.model)}
              {e.effort ? `, effort ${str(e.effort)}` : ''}; tools: {Array.isArray(e.tools) && e.tools.length ? e.tools.join(', ') : 'none'}
              {e.engine === 'inference' && <>; {e.thinking ? 'thinking on' : 'thinking off'}, {str(e.priority)} priority{typeof e.maxTokens === 'number' ? `, at most ${e.maxTokens.toLocaleString()} tokens` : ''}</>}
              {Array.isArray(e.files) && e.files.length > 0 && <>; {e.engine === 'inference' ? 'images it was shown' : 'files it could read'}: {(e.files as Ev[]).map((f) => `${str(f.name)}${f.source && typeof (f.source as Ev).page === 'number' ? ` (page ${str((f.source as Ev).page)})` : ''}${typeof f.bytes === 'number' ? ` (${fileSize(f.bytes)})` : ''}`).join(', ')}</>}
            </div>
            <Fold title="System prompt">
              <Pre>{str(e.systemPrompt ?? '')}</Pre>
            </Fold>
            {Array.isArray(e.texts) &&
              (e.texts as unknown[]).map((t, i) => (
                <Fold key={i} title={`Text it was given${(e.texts as unknown[]).length > 1 ? ` (${i + 1})` : ''}: ${fileSize(str(t).length)}`}>
                  <Pre>{str(t)}</Pre>
                </Fold>
              ))}
            <Fold title="Prompt" open>
              <Pre>{str(e.prompt ?? '')}</Pre>
            </Fold>
            {e.schema !== undefined && (
              <Fold title="Output schema">
                <Pre>{json(e.schema)}</Pre>
              </Fold>
            )}
            {e.request !== undefined && (
              <Fold title="The request as sent to the API">
                <Pre>{json(e.request)}</Pre>
              </Fold>
            )}
          </div>
        </Step>
      );
    case 'system':
      if (e.subtype === 'init')
        return (
          <Step label="Started" at={at} tone="muted">
            <span className="text-[12.5px] text-ink-2">
              {e.model ? `Model ${str(e.model)}` : 'Session started'}
              {Array.isArray(e.tools) ? `; tools ${e.tools.length ? e.tools.join(', ') : 'none'}` : ''}
              {e.permissionMode ? `; permissions ${str(e.permissionMode)}` : ''}
            </span>
          </Step>
        );
      return (
        <Step label={`System: ${str(e.subtype ?? '')}`} at={at} tone="muted">
          <Fold title="Show">
            <Pre>{json(e)}</Pre>
          </Fold>
        </Step>
      );
    case 'assistant':
    case 'user': {
      // The local model's answer: its text, and what it thought first (top-level, not a message).
      if (e.type === 'assistant' && !e.message && (typeof e.content === 'string' || typeof e.reasoning === 'string'))
        return (
          <>
            {typeof e.reasoning === 'string' && e.reasoning && (
              <Step label="Thinking" at={at} tone="muted">
                <Fold title={`Show its thinking (${plural(e.reasoning.length, 'character')})`}>
                  <Pre>{e.reasoning}</Pre>
                </Fold>
              </Step>
            )}
            <Step label="Agent" at={at}>
              <div className="flex flex-col gap-1">
                {e.finish_reason !== undefined && e.finish_reason !== 'stop' && <span className="text-[12px] text-bad-ink">Stopped: {str(e.finish_reason)}</span>}
                <Pre>{json(parsed(e.content))}</Pre>
              </div>
            </Step>
          </>
        );
      const content = (e.message as Ev | undefined)?.content;
      if (typeof content === 'string') return <Step label={e.type === 'user' ? 'Prompt' : 'Agent'} at={at}><Pre>{content}</Pre></Step>;
      if (!Array.isArray(content)) return null;
      return (
        <>
          {(content as Ev[]).map((b, i) => (
            <ContentBlock key={i} b={b} at={at} />
          ))}
        </>
      );
    }
    case 'finance.content_block':
      return <ContentBlock b={e.block as Ev} at={at} />;
    case 'result':
      return (
        <Step label={e.subtype === 'success' ? 'Finished' : `Ended: ${str(e.subtype ?? 'error')}`} at={at} tone={e.subtype === 'success' ? 'accent' : 'bad'}>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] text-ink-2">
              {[typeof e.num_turns === 'number' ? plural(e.num_turns, 'turn') : '', typeof e.duration_ms === 'number' ? duration(e.duration_ms) : '', typeof e.total_cost_usd === 'number' ? cost(e.total_cost_usd) : '', e.stop_reason ? `stopped: ${str(e.stop_reason)}` : ''].filter(Boolean).join(' · ')}
            </span>
            {e.structured_output !== undefined && (
              <Fold title="The final output" open>
                <Pre>{json(e.structured_output)}</Pre>
              </Fold>
            )}
            {e.structured_output === undefined && typeof e.result === 'string' && e.result && <Pre>{e.result}</Pre>}
            {e.usage !== undefined && (
              <Fold title="Tokens used">
                <Pre>{json(e.usage)}</Pre>
              </Fold>
            )}
          </div>
        </Step>
      );
    case 'finance.cancelled':
      return (
        <Step label="Stopped" at={at} tone="bad">
          <span className="text-ink-2">Stopped by {str(e.by)}. Nothing it would have produced was applied.</span>
        </Step>
      );
    case 'finance.check':
      return (
        <Step label={`App's check ${str(e.attempt)}`} at={at} tone={Array.isArray(e.problems) && e.problems.length ? 'bad' : 'accent'}>
          {Array.isArray(e.problems) && e.problems.length ? (
            <div className="flex flex-col gap-1 text-ink-2">
              <span>
                {plural(e.problems.length, 'problem')} the app found in its answer{e.recheck ? '; it was asked again, with them' : '; they go with the answer as unresolved'}:
              </span>
              <ul className="list-disc pl-4">
                {(e.problems as unknown[]).map((p, i) => (
                  <li key={i}>{str(p)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <span className="text-ink-2">Its answer passed the app’s checks.</span>
          )}
        </Step>
      );
    case 'finance.applied':
      return (
        <Step label="Applied" at={at} tone="accent">
          <div className="flex flex-col gap-1 text-ink-2">
            <span>{str(e.summary)}</span>
            {Array.isArray(e.written) && e.written.length > 0 && <span className="text-[12.5px]">Written: {(e.written as Ev[]).map((w) => `${str(w.type)} ${str(w.id)}`).join(', ')}</span>}
            {Array.isArray(e.proposals) &&
              (e.proposals as Ev[]).map((p) => (
                <Link key={str(p.id)} to={`/proposals/${str(p.id)}`} className="text-[12.5px] text-accent hover:underline">
                  Proposal: {str(p.title)}
                </Link>
              ))}
          </div>
        </Step>
      );
    case 'finance.waiting':
    case 'finance.unavailable':
      return (
        <Step label={e.type === 'finance.waiting' ? 'Waiting' : 'Gave up waiting'} at={at} tone={e.type === 'finance.waiting' ? 'muted' : 'bad'}>
          <span className="text-ink-2">
            The local model service could not take it: {str(e.reason)}
            {typeof e.retryInSeconds === 'number' ? `. Trying again in ${duration(e.retryInSeconds * 1000)}.` : '.'}
          </span>
        </Step>
      );
    case 'finance.tool':
      return (
        <Step label={`Step ${str(e.step)}: ${str(e.tool)}`} at={at} tone={e.error ? 'bad' : 'accent'}>
          <div className="flex flex-col gap-1.5">
            <span className="text-ink-2">
              {str(e.why)}
              {e.summary ? ` → ${str(e.summary)} (computed by the app)` : ''}
              {e.error ? ` → failed: ${str(e.error)}` : ''}
            </span>
            {typeof e.href === 'string' && (
              <Link to={e.href} className="text-[12.5px] text-accent hover:underline">
                See it in the app
              </Link>
            )}
            <Fold title="The call">
              <Pre>{json(e.args)}</Pre>
            </Fold>
            <Fold title="What the app gave back">
              <Pre>{str(e.result)}</Pre>
            </Fold>
          </div>
        </Step>
      );
    case 'finance.answer':
      return (
        <Step label="Answer" at={at} tone="accent">
          <Pre className="bg-transparent p-0 font-sans text-[13px]">{str((e.answer as Ev | undefined)?.answer)}</Pre>
        </Step>
      );
    case 'finance.proposed':
      return (
        <Step label="Proposed" at={at} tone="accent">
          <Link to={`/proposals/${str(e.proposalId)}`} className="text-accent hover:underline">
            A proposal of {plural(Number(e.changes), 'change')}
          </Link>
        </Step>
      );
    case 'finance.truncated':
    case 'finance.omitted':
      return (
        <Step label="Left out" at={at} tone="muted">
          <span className="text-ink-2">{e.type === 'finance.truncated' ? str(e.note) : `One ${str(e.was)} event of ${fileSize(Number(e.bytes))} was too big to keep.`}</span>
        </Step>
      );
    case 'finance.error':
    case 'finance.api_error':
      return (
        <Step label="Error" at={at} tone="bad">
          <Pre>{str(e.error)}</Pre>
        </Step>
      );
    case 'finance.stderr':
    case 'finance.output':
      return (
        <Step label={e.type === 'finance.stderr' ? 'Error output' : 'Output'} at={at} tone="muted">
          <Fold title="Show">
            <Pre>{str(e.text)}</Pre>
          </Fold>
        </Step>
      );
    default:
      return (
        <Step label={str(e.type ?? 'Event')} at={at} tone="muted">
          <Fold title="Show">
            <Pre>{json(e)}</Pre>
          </Fold>
        </Step>
      );
  }
}

/** The engine's own bookkeeping (screen refreshes, token estimates, rate limits): hidden unless asked for. */
const housekeeping = (e: Ev) => e.type === 'rate_limit_event' || (e.type === 'system' && (e.subtype === 'ui_invalidate' || e.subtype === 'thinking_tokens' || e.subtype === 'status'));

/** The transcript so far; a running session's grows as its events arrive. */
function useTranscript(id: string, total: number | undefined): { events: Ev[]; error?: string } {
  const [state, setState] = useState<{ id: string; events: Ev[]; error?: string }>({ id, events: [] });
  const busy = useRef(false);
  const events = state.id === id ? state.events : [];
  useEffect(() => {
    if (total === undefined || busy.current || events.length >= total) return;
    busy.current = true;
    api<TranscriptResponse>(`/sessions/${id}/transcript?from=${events.length}`)
      .then((t) => setState((s) => ({ id, events: [...(s.id === id ? s.events : []).slice(0, t.from), ...(t.events as Ev[])] })))
      .catch((err: Error) => setState((s) => ({ ...s, id, error: err.message })))
      .finally(() => {
        busy.current = false;
      });
  }, [id, total, events.length]);
  return { events, ...(state.id === id && state.error ? { error: state.error } : {}) };
}

/** Text that is JSON, parsed (a local model's structured answer), else the text. */
function parsed(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** The session's final output, whichever engine gave it: the result's, or its last StructuredOutput call. */
function finalOutput(events: Ev[]): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'result' && e.structured_output !== undefined) return e.structured_output;
    // The local model (sessions before its result carried the output).
    if (e.type === 'assistant' && !e.message && typeof e.content === 'string' && e.content) return parsed(e.content);
    const content = (e.message as Ev | undefined)?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      const so = (content as Ev[]).findLast((b) => b.type === 'tool_use' && b.name === 'StructuredOutput');
      if (so) return so.input;
      // The Claude API: the answer is the message's text, JSON when a schema was asked for.
      const text = (content as Ev[]).filter((b) => b.type === 'text').map((b) => str(b.text)).join('');
      if (text) return parsed(text);
    }
    if (e.type === 'finance.content_block' && (e.block as Ev | undefined)?.type === 'text') return parsed(str((e.block as Ev).text));
  }
  return undefined;
}

function Output({ events, s }: { events: Ev[]; s: SessionSummary }) {
  const out = finalOutput(events);
  if (out === undefined) return null;
  return (
    <Card title="Its output" description={`What it returned, as it returned it${s.kind === 'ask' || (s.kind === 'job' && s.jobKind === 'ask') ? ': an inference, not a figure the app computed' : ''}. What the app made of it is under What it produced.`}>
      <Pre>{json(out)}</Pre>
    </Card>
  );
}

function Transcript({ d, events, error }: { d: SessionDetail; events: Ev[]; error?: string | undefined }) {
  const r = d.record;
  const [all, setAll] = useState(false);
  if (!r || r.transcript.removed) return null;
  const hidden = events.filter(housekeeping).length;
  const shown = all ? events : events.filter((e) => !housekeeping(e));
  return (
    <Card title="Transcript" description={`${plural(r.transcript.events, 'event')}, ${fileSize(r.transcript.bytes)}${r.transcript.truncated ? ': cut at its size cap (the final result is still in it)' : ''}. Kept in the work area at ${r.transcript.path}.`} padded={false}>
      {error && <Callout tone="bad" className="mx-5 mb-4">{error}</Callout>}
      {hidden > 0 && (
        <div className="px-5 pb-3">
          <Checkbox checked={all} onChange={setAll} label={`Show the engine’s bookkeeping too (${plural(hidden, 'event')}: screen refreshes, token estimates, rate limits)`} />
        </div>
      )}
      <ol className="mt-3">
        {shown.map((e, i) => (
          <Event key={i} e={e} />
        ))}
      </ol>
      {d.session.status === 'running' && (
        <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-[12.5px] text-ink-3">
          <StatusBadge status="pending">Running</StatusBadge> New events appear here as they arrive.
        </div>
      )}
    </Card>
  );
}

// ─── One session ─────────────────────────────────────────────────────────────────────────────────

function AuditRows({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">No rows in the audit log.</p>;
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.seq} className="border-t border-line px-5 py-2.5">
          <Link to={`/settings?audit=${encodeURIComponent(`#${e.seq}`)}#audit`} className="block text-[13px] break-words text-accent hover:underline">
            {e.summary}
          </Link>
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-ink-3">
            <span className="whitespace-nowrap">{when(e.at)}</span>
            <span>{actorName(e.actor)}</span>
            <span className="font-mono">#{e.seq}</span>
            <span className="font-mono">{e.action}</span>
            {e.outcome !== 'ok' && <StatusBadge status={e.outcome === 'refused' ? 'warn' : 'bad'}>{e.outcome === 'refused' ? 'Refused' : 'Failed'}</StatusBadge>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function parentLinks(s: SessionSummary): [ReactNode, ReactNode][] {
  const rows: [ReactNode, ReactNode][] = [];
  if (s.jobId) rows.push(['Job', <Link key="j" to="/assumptions#jobs" className="font-mono text-[12px] text-accent hover:underline">{s.jobId}</Link>]);
  if (s.importId) rows.push(['Import', <Link key="i" to={`/import/${s.importId}`} className="font-mono text-[12px] text-accent hover:underline">{s.importId}</Link>]);
  if (s.receiptId) rows.push(['Receipt', <span key="r" className="font-mono text-[12px]">{s.receiptId}</span>]);
  if (s.conversationId) rows.push(['Conversation', <Link key="c" to={`/ask/${s.conversationId}`} className="font-mono text-[12px] text-accent hover:underline">{s.conversationId}</Link>]);
  if (s.tokenId) rows.push(['Token', <Link key="t" to="/settings#access" className="font-mono text-[12px] text-accent hover:underline">{s.tokenId}</Link>]);
  if (s.agentSession) rows.push(['Its session', <span key="as" className="font-mono text-[12px] break-all">{s.agentSession}</span>]);
  return rows;
}

/** The local model's timings: reading the prompt, and writing the answer, with their speed. */
function timings(r: NonNullable<SessionDetail['record']>): string | undefined {
  const t = (r.inference?.timings_ms ?? {}) as Record<string, number | undefined>;
  if (t.prompt === undefined && t.generate === undefined) return undefined;
  const rate = (tokens: number | undefined, ms: number | undefined) => (tokens && ms ? ` (${(tokens / (ms / 1000)).toFixed(1)} tokens/s)` : '');
  return [
    t.prompt !== undefined ? `reading the prompt ${duration(Math.round(t.prompt))}${rate(r.usage?.inputTokens, t.prompt)}` : '',
    t.prompt_tokens_cached ? `${t.prompt_tokens_cached.toLocaleString()} prompt tokens already cached` : '',
    t.generate !== undefined ? `writing ${duration(Math.round(t.generate))}${rate(r.usage?.outputTokens, t.generate)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function StopButton({ id }: { id: string }) {
  const stop = useApiMutation(() => api(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="danger" icon={<CircleStop className="size-4" />} loading={stop.isPending} disabled={stop.isSuccess} onClick={() => confirm('Stop this session? Nothing it would have produced is applied; its transcript is kept.') && stop.mutate(undefined)}>
        {stop.isSuccess ? 'Stopping…' : 'Stop'}
      </Button>
      {stop.error && <span className="text-[12px] text-bad-ink">{stop.error.message}</span>}
    </div>
  );
}

function SessionPage({ id }: { id: string }) {
  const res = useApi<SessionDetail>(['session', id], `/sessions/${encodeURIComponent(id)}`, { refetchInterval: 10_000 });
  const d = res.data;
  if (!d) return res.error ? <Callout tone="bad">{res.error.message}</Callout> : <Loading />;
  return <SessionView d={d} />;
}

function SessionView({ d }: { d: SessionDetail }) {
  const s = d.session;
  const r = d.record;
  const { events, error } = useTranscript(s.id, r && !r.transcript.removed ? r.transcript.events : undefined);
  const items: [ReactNode, ReactNode][] = [
    ['Kind', `${KIND_NAMES[s.kind]}${s.jobKind ? `: ${s.jobKind}` : ''}${s.role ? `, ${ROLE_NAMES[s.role]}` : ''}`],
    ['Started by', `${s.startedBy}${s.reason ? `. ${s.reason}` : ''}`],
    ['Status', <SessionStatus key="st" s={s} />],
    ['Started', when(s.startedAt)],
  ];
  if (s.finishedAt) items.push([s.source === 'token' ? 'Last request' : 'Ended', `${when(s.finishedAt)}${s.durationMs !== undefined ? ` (${duration(s.durationMs)})` : ''}`]);
  if (s.engine) items.push(['Engine', ENGINE_NAMES[s.engine]]);
  if (s.model) items.push(['Model', <span key="m" className="font-mono text-[12px]">{r && r.modelUsed && r.modelUsed !== r.model ? `${r.modelUsed} (asked for ${r.model})` : s.model}</span>]);
  if (r?.effort) items.push(['Effort', r.effort]);
  if (r?.thinking !== undefined) items.push(['Thinking', r.thinking ? 'on' : 'off']);
  if (r && timings(r)) items.push(['Time', timings(r)]);
  if (r?.inference) {
    const p = r.inference;
    const t = (p.timings_ms ?? {}) as Record<string, number>;
    const sampling = (p.sampling ?? {}) as Record<string, unknown>;
    items.push(['Provenance', <span key="pv" className="font-mono text-[12px] break-all">{[`request ${String(p.request_id)}`, `alias ${String(p.alias)}`, `model ${String(p.model_id)}`, `sha256 ${String(p.model_sha256).slice(0, 16)}…`, `fingerprint ${String(p.system_fingerprint)}`, `seed ${String(sampling.seed)}`, ...(p.schema_valid !== undefined ? [`schema ${p.schema_valid ? 'valid' : 'invalid'}`] : []), ...(t.queue ? [`queued ${duration(t.queue)}`] : []), ...(t.load ? [`model load ${duration(t.load)}`] : [])].join(' · ')}</span>]);
  }
  if (s.promptVersion) items.push(['Prompt version', <span key="p" className="font-mono text-[12px]">{s.promptVersion}</span>]);
  if (r) items.push(['Tools', r.tools.length ? r.tools.join(', ') : 'none']);
  if (r?.privacy) items.push(['Privacy', r.privacy === 'public' ? 'Public identifiers only, with web tools' : 'Your data, no web access']);
  if (s.costUsd !== undefined) items.push(['Cost', `${cost(s.costUsd)} at API prices${s.source === 'earlier' && s.kind === 'reading' && s.title.includes('checked by') ? ' (both readings together)' : ''}`]);
  if (r?.turns !== undefined) items.push(['Turns', str(r.turns)]);
  if (r?.usage) items.push(['Tokens', (Object.entries(r.usage) as [string, number][]).map(([k, v]) => `${k.replace(/Tokens$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()} ${v.toLocaleString()}`).join(' · ')]);
  if (s.requests) items.push(['Requests', `${plural(s.requests.total, 'request')}: ${s.requests.changes} that changed something, ${s.requests.refused} refused`]);
  items.push(...parentLinks(s));
  if (r?.fallbackOf)
    items.push([
      'Stood in for',
      <span key="fb">
        <Link to={`/sessions/${r.fallbackOf}`} className="font-mono text-[12px] text-accent hover:underline">
          {r.fallbackOf}
        </Link>
        {r.fallbackReason ? `: the local model could not (${r.fallbackReason})` : ''}
      </span>,
    ]);
  if (d.related.some((x) => x.fallbackOf === s.id))
    items.push(['Taken over by', <span key="tb">{d.related.filter((x) => x.fallbackOf === s.id).map((x) => <Link key={x.id} to={`/sessions/${x.id}`} className="font-mono text-[12px] text-accent hover:underline">{x.id}</Link>)} (Claude, when this could not finish)</span>]);
  if (r?.requestId)
    items.push([
      'Started by request',
      <Link key="rq" to={`/settings?audit=${encodeURIComponent(r.requestId)}#audit`} className="font-mono text-[12px] text-accent hover:underline">
        {r.requestId}
      </Link>,
    ]);
  if (r?.stoppedBy) items.push(['Stopped by', `${actorName(r.stoppedBy.actor)}, ${when(r.stoppedBy.at)}`]);
  if (r?.data) items.push(['Data it ran on', <span key="da" className="font-mono text-[12px]">{[r.data.commit ? `commit ${r.data.commit.slice(0, 10)}` : 'no git commit', r.data.uncommitted ? `${plural(r.data.uncommitted, 'file')} not yet committed` : '', r.data.format !== undefined ? `format v${r.data.format}` : ''].filter(Boolean).join(' · ')}</span>]);
  if (r?.transcript.sha256) items.push(['Transcript SHA-256', <span key="sh" className="font-mono text-[12px] break-all">{r.transcript.sha256}</span>]);
  items.push(['Session id', <span key="id" className="font-mono text-[12px]">{s.id}</span>]);
  if (r?.error) items.push(['Error', <span key="e" className="text-bad-ink">{r.error}</span>]);
  return (
    <div>
      <Link to="/sessions" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Agent sessions
      </Link>
      <PageHeader title={s.title} subtitle={s.source === 'token' ? 'An agent outside the app, seen by its requests' : s.source === 'earlier' ? 'From before transcripts were kept' : undefined} actions={s.source === 'recorded' && s.status === 'running' ? <StopButton id={s.id} /> : undefined} />
      <div className="flex flex-col gap-5">
        <Card>
          <KeyValue items={items} />
        </Card>
        <Output events={events} s={s} />
        {d.noTranscript && <Callout tone="neutral" title="No transcript">{d.noTranscript}</Callout>}
        {d.recorded && (
          <Card title="What was recorded" description="As its job, import or receipt recorded it at the time.">
            <Pre>{json(d.recorded)}</Pre>
          </Card>
        )}
        {s.source !== 'token' && (
          <Card title="What it produced" description="Each thing this session made, and where it lives now." padded={false}>
            {d.produced.length === 0 ? (
              <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">{s.status === 'running' ? 'Nothing yet: it is still running.' : 'Nothing.'}</p>
            ) : (
              <ul>
                {d.produced.map((o, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 border-t border-line px-5 py-2.5 text-[13px]">
                    <Badge tone="neutral">{o.type}</Badge>
                    {o.href ? (
                      <Link to={o.href} className="sensitive min-w-0 break-words text-accent hover:underline">
                        {o.label}
                      </Link>
                    ) : (
                      <span className="sensitive min-w-0 break-words">{o.label}</span>
                    )}
                    {o.note && <span className="text-[12px] text-ink-3">{o.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {d.requests && (
          <Card title="Its requests" description="From the token use log: every request it made to the app, refused ones included." padded={false}>
            <ul>
              {d.requests.map((u, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 border-t border-line px-5 py-2 text-[12.5px]">
                  <span className="font-mono text-[11.5px] text-ink-3">{u.at.slice(11, 19)}</span>
                  <span className="sensitive font-mono break-all">
                    {u.method} {u.path}
                    {u.query ?? ''}
                  </span>
                  {u.bytes !== undefined && <span className="text-ink-3">{fileSize(u.bytes)}</span>}
                  {u.status < 400 ? <StatusBadge status="good">{u.status}</StatusBadge> : <StatusBadge status="bad">{u.status}</StatusBadge>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {r?.inputs && (r.inputs.files.length > 0 || r.inputs.skipped?.length) && (
          <Card title="Its input files" description={r.inputs.removed ? `Deleted on ${r.inputs.removed.at.slice(0, 10)}, with its transcript.` : 'The files it was given to read, as they were, kept gzipped beside its transcript and deleted with it.'} padded={false}>
            <ul>
              {r.inputs.files.map((f) => (
                <li key={f.name} className="flex flex-wrap items-baseline gap-x-3 border-t border-line px-5 py-2 text-[12.5px]">
                  <span className="font-mono">{f.name}</span>
                  <span className="text-ink-3">{fileSize(f.bytes)}</span>
                  {!r.inputs!.removed && (
                    <>
                      <a href={`/api/sessions/${encodeURIComponent(s.id)}/inputs/${f.name.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        Open
                      </a>
                      <a href={`/api/sessions/${encodeURIComponent(s.id)}/inputs/${f.name.split('/').map(encodeURIComponent).join('/')}?download=1`} className="text-accent hover:underline">
                        Download
                      </a>
                    </>
                  )}
                </li>
              ))}
              {r.inputs.skipped?.map((f) => (
                <li key={f.name} className="border-t border-line px-5 py-2 text-[12.5px] text-ink-3">
                  <span className="font-mono">{f.name}</span> ({fileSize(f.bytes)}): not kept, over the size cap
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Transcript d={d} events={events} error={error} />
        <Card
          title="In the audit log"
          description={s.source === 'token' ? 'What its requests did, in this stretch of activity.' : `This session’s own rows, and those of its ${PARENT_WORD(s)}. Open one to see it in Settings → Audit log.`}
          actions={
            <Link to={`/settings?audit=${encodeURIComponent(s.source === 'recorded' ? s.id : (s.jobId ?? s.importId ?? s.receiptId ?? s.conversationId ?? s.tokenId ?? s.id))}#audit`} className="text-[12.5px] text-accent hover:underline">
              Search the audit log
            </Link>
          }
          padded={false}
        >
          <AuditRows entries={d.audit} />
        </Card>
        {d.related.length > 0 && (
          <Card title={`Other sessions of this ${PARENT_WORD(s)}`} padded={false}>
            <ul>
              {d.related.map((x) => (
                <Row key={x.id} s={x} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function Sessions() {
  const { id } = useParams();
  return id ? <SessionPage id={id} /> : <SessionList />;
}
