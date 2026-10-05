// Ask (src/server/ask.ts): conversations about your money, each on a page of its own. The model looks
// things up with the app's tools, step by step, and the page shows each step as it happens. An
// answer is an inference: the figures in it the app found in what its tools gave back are marked
// computed, with a link to check them; anything else is the model's, and said so.

import { ArrowLeft, ChevronDown, ChevronRight, CircleStop, MessageCircleQuestion, Send, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AskConversation, AskListResponse, AskModelId, AskTurn } from '../../shared/ask';
import { addDays, today } from '../../shared/dates';
import { SessionsLink } from '../components/SessionsLink';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, Input, Loading, PageHeader, Select, StatusBadge, Textarea } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { plural, timeAgo } from '../lib/format';

const PERIODS = [
  { id: '', label: 'Any time (the model chooses)' },
  { id: '30d', label: 'The last 30 days' },
  { id: '90d', label: 'The last 90 days' },
  { id: '12m', label: 'The last 12 months' },
  { id: 'year', label: 'This calendar year' },
  { id: 'custom', label: 'From… to…' },
] as const;

function periodRange(id: string, from: string, to: string): { from?: string; to?: string } {
  const now = today();
  if (id === '30d') return { from: addDays(now, -30), to: now };
  if (id === '90d') return { from: addDays(now, -90), to: now };
  if (id === '12m') return { from: addDays(now, -365), to: now };
  if (id === 'year') return { from: `${now.slice(0, 4)}-01-01`, to: now };
  if (id === 'custom') return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return {};
}

/** The question box: Enter sends, Shift+Enter starts a new line; the model, a period and accounts are options. */
function Composer({ list, conversationId, text, setText, placeholder }: { list: AskListResponse | undefined; conversationId?: string; text: string; setText: (s: string) => void; placeholder: string }) {
  const { data } = useAppData();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<AskModelId | ''>('');
  const [period, setPeriod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [accounts, setAccounts] = useState<string[]>([]);
  const chosen = model || list?.defaultModel || 'local-thinking';
  const send = useApiMutation(
    (question: string) => {
      const range = periodRange(period, from, to);
      const body = { question, model: chosen, defaults: { ...range, ...(accounts.length ? { accounts } : {}) } };
      return api<AskConversation>(conversationId ? `/ask/${conversationId}/turns` : '/ask', { body });
    },
    {
      onSuccess: (c) => {
        setText('');
        if (!conversationId) void navigate(`/ask/${c.id}`);
      },
    },
  );
  const submit = () => {
    if (text.trim().length >= 3 && !send.isPending) send.mutate(text.trim());
  };
  const local = chosen.startsWith('local');
  const open_ = data.accounts.filter((a) => a.status !== 'closed');
  const options = [model && model !== list?.defaultModel ? list?.models.find((m) => m.id === model)?.label : '', period ? PERIODS.find((p) => p.id === period)?.label.toLowerCase() : '', accounts.length ? plural(accounts.length, 'account') : ''].filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={placeholder}
          className="flex-1 resize-y"
          maxLength={2000}
          aria-label="Your question"
        />
        <Button type="submit" variant="primary" icon={<Send className="size-4" />} loading={send.isPending} disabled={text.trim().length < 3}>
          Ask
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          Options{options.length ? `: ${options.join(', ')}` : ''}
        </button>
        <span>Enter sends; Shift+Enter starts a new line.</span>
        {list && list.busy > 0 && <span>{plural(list.busy, 'question')} being answered or waiting: yours goes after.</span>}
      </div>
      {open && (
        <div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
          <Field label="Model" hint={local ? 'On this machine: nothing leaves it.' : 'Claude: what it looks up (your payments too) goes to Anthropic, and it spends your plan.'}>
            <Select value={chosen} onChange={(e) => setModel(e.target.value as AskModelId)}>
              {list?.models.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}
                  {m.id === list.defaultModel ? ' (default)' : ''}
                  {m.available ? '' : ` (${m.why ?? 'not available'})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period" hint="What the tools look at when the question does not say.">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
              </Field>
            </div>
          )}
          <div className="sm:col-span-2">
            <div className="mb-1 text-[12.5px] font-medium text-ink-2">Accounts {accounts.length ? '' : <span className="font-normal text-ink-3">(all, unless the question says)</span>}</div>
            <div className="grid max-h-40 gap-1 overflow-auto sm:grid-cols-2">
              {open_.map((a) => (
                <Checkbox key={a.id} checked={accounts.includes(a.id)} onChange={(v) => setAccounts((xs) => (v ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} label={a.name} />
              ))}
            </div>
          </div>
        </div>
      )}
      {local && list?.service && list.service.state !== 'ready' && <div className="text-[12.5px] text-ink-3">The local model: {list.service.note}</div>}
      {send.error && <Callout tone="bad">{send.error.message}</Callout>}
    </div>
  );
}

function useAskList() {
  return useApi<AskListResponse>(['ask'], '/ask', { refetchInterval: (d) => (d?.busy ? 5000 : 60_000) });
}

// ─── The list ────────────────────────────────────────────────────────────────────────────────────

const TURN_STATUS: Record<AskTurn['status'], { status: 'good' | 'warn' | 'bad' | 'info' | 'pending'; label: string }> = {
  queued: { status: 'pending', label: 'Waiting' },
  running: { status: 'pending', label: 'Answering' },
  answered: { status: 'good', label: 'Answered' },
  failed: { status: 'bad', label: 'Failed' },
  cancelled: { status: 'warn', label: 'Stopped' },
};

function AskList() {
  const list = useAskList();
  const [text, setText] = useState('');
  const d = list.data;
  return (
    <div>
      <PageHeader title="Ask" subtitle="Questions about your money, answered from the app’s own figures" />
      <div className="flex flex-col gap-5">
        <Card>
          <Composer list={d} text={text} setText={setText} placeholder="How much did I spend in Malaysia? What did the car cost me last year?" />
          <p className="mt-3 text-[12.5px] text-ink-3">
            The model looks things up with the app’s tools (searching payments, spending by category or payee, trips, a month’s figures, balances, missing days) and answers from what they give back. Totals are the app’s, never the model’s own sums. Figures the app found in those results are marked computed; the rest is an inference to check. Conversations are kept for {d?.retentionDays ?? 90} days in the work area, never in your data. <Link to="/settings#extraction" className="text-accent hover:underline">Settings → Models</Link> sets the default model.
          </p>
        </Card>
        {d && d.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {d.suggestions.map((s) => (
              <button key={s} type="button" onClick={() => setText(s)} className="sensitive rounded-full border border-line bg-panel px-3 py-1 text-left text-[12.5px] text-ink-2 hover:border-accent hover:text-ink">
                {s}
              </button>
            ))}
          </div>
        )}
        <Card title="Conversations" padded={false}>
          {!d ? (
            list.error ? <Callout tone="bad" className="m-5">{list.error.message}</Callout> : <Loading />
          ) : d.conversations.length === 0 ? (
            <EmptyState icon={<MessageCircleQuestion className="size-8" />} title="No questions yet">
              Ask one above, or pick a suggestion.
            </EmptyState>
          ) : (
            <ul>
              {d.conversations.map((c) => (
                <li key={c.id} className="border-t border-line">
                  <Link to={`/ask/${c.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-panel-2/60">
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="sensitive block text-[13.5px] break-words text-ink">{c.title}</span>
                      {c.lastAnswer && <span className="sensitive mt-0.5 line-clamp-2 block text-[12.5px] text-ink-3">{c.lastAnswer}</span>}
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                        <span>{timeAgo(c.updatedAt)}</span>
                        <span>{plural(c.turns, 'question')}</span>
                        <StatusBadge status={TURN_STATUS[c.status].status}>{TURN_STATUS[c.status].label}</StatusBadge>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── One conversation ────────────────────────────────────────────────────────────────────────────

function seconds(since: string | undefined): string {
  if (!since) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** Re-render every second while something runs, so its clock moves. */
function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function LiveLine({ t }: { t: AskTurn }) {
  const l = t.live;
  const what = !l
    ? 'Starting…'
    : l.phase === 'waiting'
      ? `Waiting for the local model: ${l.waiting ?? 'it is busy'}`
      : l.phase === 'reading'
        ? 'Reading the question and what it has found…'
        : l.phase === 'thinking'
          ? `Thinking${l.reasoningChars ? ` (${l.reasoningChars.toLocaleString()} characters so far)` : ''}…`
          : l.phase === 'looking'
            ? `Looking: ${l.text ?? ''}`
            : `Writing${l.text ? `: ${l.text}` : '…'}`;
  return (
    <div className="flex items-start gap-2 text-[13px] text-ink-2">
      <StatusBadge status="pending">{seconds(t.startedAt)}</StatusBadge>
      <span className="sensitive min-w-0 flex-1 break-words whitespace-pre-line">{what}</span>
    </div>
  );
}

function Steps({ t }: { t: AskTurn }) {
  if (!t.steps.length) return null;
  return (
    <ol className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[12.5px]">
      {t.steps.map((s) => (
        <li key={s.n} className="text-ink-2">
          <span className="text-ink-3">{s.n}. </span>
          <span className="sensitive">{s.why}</span>
          {s.error ? (
            <span className="text-bad-ink"> — failed: {s.error}</span>
          ) : (
            <>
              {' '}
              → <span className="sensitive">{s.summary}</span> <span className="text-ink-3">(computed by the app)</span>
              {s.href && (
                <>
                  {' '}
                  <Link to={s.href} className="text-accent hover:underline">
                    See them
                  </Link>
                </>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function Feedback({ c, t }: { c: AskConversation; t: AskTurn }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(t.feedback?.note ?? '');
  const save = useApiMutation((wrong: boolean) => api(`/ask/${c.id}/turns/${t.id}/feedback`, { body: { wrong, note } }), { onSuccess: () => setEditing(false) });
  if (t.feedback?.wrong && !editing)
    return (
      <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
        <Badge tone="warn">{t.feedback.by && !t.feedback.by.startsWith('You') ? `Marked wrong by ${t.feedback.by}` : 'You marked this wrong'}</Badge>
        {t.feedback.note && <span className="sensitive text-ink-2">{t.feedback.note}</span>}
        <button type="button" className="text-accent hover:underline" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="text-accent hover:underline" onClick={() => save.mutate(false)}>
          Undo
        </button>
      </div>
    );
  if (!editing)
    return (
      <button type="button" className="self-start text-[12.5px] text-accent hover:underline" onClick={() => setEditing(true)}>
        This is wrong
      </button>
    );
  return (
    <div className="flex flex-col gap-2">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What is wrong, and what the right answer is, if you know it" aria-label="What is wrong" />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(true)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <span className="text-[12px] text-ink-3">Kept with the question: the next version of Ask’s prompt must answer it at least as well.</span>
      </div>
      {save.error && <Callout tone="bad">{save.error.message}</Callout>}
    </div>
  );
}

function TurnCard({ c, t, list }: { c: AskConversation; t: AskTurn; list: AskListResponse | undefined }) {
  const stop = useApiMutation(() => api(`/ask/${c.id}/cancel`, { body: { turnId: t.id } }));
  const label = list?.models.find((m) => m.id === t.model.id)?.label.replace(/ \(.*\)$/, '') ?? t.model.model;
  const d = t.defaults;
  return (
    <Card>
      <div id={t.id} className="flex scroll-mt-20 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="sensitive min-w-0 flex-1 text-[14.5px] font-medium break-words whitespace-pre-line text-ink">{t.question}</div>
          {(t.status === 'running' || t.status === 'queued') && (
            <Button size="sm" variant="danger" icon={<CircleStop className="size-3.5" />} loading={stop.isPending} disabled={stop.isSuccess} onClick={() => stop.mutate(undefined)}>
              {t.status === 'queued' ? 'Take back' : 'Stop'}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span>{timeAgo(t.askedAt)}</span>
          <span>{label}</span>
          {(d.from || d.to) && (
            <span>
              {d.from ?? '…'} to {d.to ?? 'today'}
            </span>
          )}
          {d.accounts?.length ? <span>{plural(d.accounts.length, 'account')}</span> : null}
          {t.status !== 'answered' && <StatusBadge status={TURN_STATUS[t.status].status}>{TURN_STATUS[t.status].label}</StatusBadge>}
        </div>
        {t.fellBack && <Callout tone="warn">The local model could not answer ({t.fellBack}). Claude answered instead, as Settings → Models allows for Ask.</Callout>}
        <Steps t={t} />
        {t.status === 'queued' && <div className="text-[13px] text-ink-3">Waiting for the question before it to be answered.</div>}
        {t.status === 'running' && <LiveLine t={t} />}
        {(t.status === 'failed' || t.status === 'cancelled') && t.error && <Callout tone={t.status === 'failed' ? 'bad' : 'neutral'}>{t.error}</Callout>}
        {t.answer && (
          <div className="flex flex-col gap-2 text-[13.5px] text-ink-2">
            <div className="flex flex-wrap gap-2">
              <Badge tone="neutral">inferred by {t.model.engine === 'inference' && !t.fellBack ? 'the local model' : 'Claude'}</Badge>
              <Badge tone={t.answer.confidence === 'high' ? 'good' : 'warn'}>{t.answer.confidence} confidence</Badge>
              {t.answer.modelConfidence && <Badge tone="warn">lowered from {t.answer.modelConfidence}: not every figure is the app’s</Badge>}
              {t.answer.cannotAnswer && <Badge tone="warn">it could not answer</Badge>}
            </div>
            <p className="sensitive whitespace-pre-line text-ink">{t.answer.answer}</p>
            {t.answer.figures.length > 0 && (
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {t.answer.figures.map((f, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="sensitive text-ink">
                      {f.label}: <span className="font-medium tabular-nums">{f.value}</span>
                    </span>
                    {f.computed ? (
                      <span className="text-ink-3">
                        computed by the app{f.step ? ` (step ${f.step})` : ''}
                        {f.href && (
                          <>
                            {' · '}
                            <Link to={f.href} className="text-accent hover:underline">
                              check it
                            </Link>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="text-warn-ink">the model’s figure: not in what the app gave it</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {t.answer.caveats.length > 0 && <div className="sensitive text-[12.5px] text-ink-3">{t.answer.caveats.join(' ')}</div>}
            <Feedback c={c} t={t} />
          </div>
        )}
        {t.sessions.length > 0 && (
          <div className="flex flex-wrap gap-3 text-[12px]">
            {t.sessions.map((id, i) => (
              <Link key={id} to={`/sessions/${id}`} className="text-accent hover:underline">
                {t.sessions.length > 1 ? `Session ${i + 1}: everything it was given and said` : 'Everything it was given and said'}
              </Link>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Conversation({ id }: { id: string }) {
  const list = useAskList();
  const res = useApi<AskConversation>(['ask', id], `/ask/${encodeURIComponent(id)}`, { refetchInterval: (d) => (d?.turns.some((t) => t.status === 'running' || t.status === 'queued') ? 3000 : false) });
  const [text, setText] = useState('');
  const navigate = useNavigate();
  const hide = useApiMutation(() => api(`/ask/${encodeURIComponent(id)}`, { method: 'DELETE' }), { onSuccess: () => void navigate('/ask') });
  const c = res.data;
  const active = useMemo(() => c?.turns.some((t) => t.status === 'running') ?? false, [c]);
  useTick(active);
  // Opened at one question (a session's link): scroll to it once it is there.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!c || scrolled || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
    setScrolled(true);
  }, [c, scrolled]);
  if (!c) return res.error ? <Callout tone="bad">{res.error.message}</Callout> : <Loading />;
  return (
    <div>
      <Link to="/ask" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Ask
      </Link>
      <PageHeader
        title={<span className="sensitive">{c.title}</span>}
        subtitle={`Started ${timeAgo(c.createdAt)} · ${plural(c.turns.length, 'question')}`}
        actions={
          !c.hidden && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={hide.isPending} onClick={() => confirm('Delete this conversation? It leaves the list now, and is deleted with its transcripts at the end of the retention period.') && hide.mutate(undefined)}>
              Delete
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-4">
        {c.hidden && <Callout tone="neutral">Deleted {timeAgo(c.hidden.at)}: it is off the list, and kept until the retention period ends. Asking a follow-up puts it back.</Callout>}
        {c.turns.map((t) => (
          <TurnCard key={t.id} c={c} t={t} list={list.data} />
        ))}
        <Card>
          <Composer list={list.data} conversationId={c.id} text={text} setText={setText} placeholder="A follow-up: “and in July?”, “which of those were hotels?”" />
        </Card>
        <div className="text-[12px] text-ink-3">
          <SessionsLink of={c.id}>Its sessions</SessionsLink>
        </div>
      </div>
    </div>
  );
}

export default function Ask(): ReactNode {
  const { id } = useParams();
  return id ? <Conversation key={id} id={id} /> : <AskList />;
}
