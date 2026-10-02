// Intelligence on every page, kept visibly apart from computed figures:
//   - SourceTag: where a modelling value came from (yours, researched, agent, statement, fallback);
//   - SignalList: computed signals, each with the rule that produced it;
//   - InsightsPanel: Claude's inferences, with confidence, model, date and the evidence they cite.

import { Bot, Calculator, ExternalLink, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Signal, SourcedValue } from '../../shared/api';
import type { Insight, InsightPage } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, formatDate } from '../lib/format';
import { Badge, Card, type Tone } from './ui';

const SOURCE_LABEL: Record<SourcedValue['source'], { label: string; tone: Tone; title: string }> = {
  owner: { label: 'Yours', tone: 'accent', title: 'Set by you: it beats everything else' },
  research: { label: 'Researched', tone: 'neutral', title: 'From dated, sourced research' },
  agent: { label: 'Agent', tone: 'neutral', title: 'Set by an agent from research' },
  statement: { label: 'Statement', tone: 'neutral', title: 'From one of your statements' },
  account: { label: 'Account', tone: 'neutral', title: 'From the account’s own settings' },
  fallback: { label: 'Fallback', tone: 'muted', title: 'The app’s built-in fallback: no research or figure of yours yet' },
};

/** A small tag saying where a value came from; hover for the full basis. */
export function SourceTag({ value, className }: { value: Pick<SourcedValue, 'source' | 'basis' | 'stale' | 'asOf'>; className?: string }) {
  const s = SOURCE_LABEL[value.source];
  return (
    <span className={cn('inline-flex items-center gap-1', className)} title={`${s.title}. ${value.basis}${value.asOf ? ` (as of ${formatDate(value.asOf)})` : ''}`}>
      <Badge tone={s.tone}>{s.label}</Badge>
      {value.stale && <Badge tone="warn">stale</Badge>}
    </span>
  );
}

/** Computed signals: deterministic, each with its rule. */
export function SignalList({ signals, empty }: { signals: Signal[]; empty?: ReactNode }) {
  if (!signals.length) return empty ? <>{empty}</> : null;
  return (
    <ul className="flex flex-col gap-2.5">
      {signals.map((s) => (
        <li key={s.id} className="flex gap-2.5">
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', s.tone === 'warning' ? 'bg-[var(--warn)]' : s.tone === 'good' ? 'bg-[var(--good)]' : 'bg-[var(--ink-3)]')} aria-hidden />
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-ink">{s.title}</div>
            <div className="text-[12.5px] text-ink-3">{s.detail}</div>
            <div className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-ink-3" title="A computed signal: a fixed rule over your data, not an inference">
              <Calculator className="size-3" aria-hidden /> {s.rule}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EvidenceLinks({ insight }: { insight: Insight }) {
  const chips: ReactNode[] = [];
  insight.evidence.forEach((e, i) => {
    const key = `${e.type}-${i}`;
    if (e.type === 'transactions') chips.push(<Link key={key} to={`/transactions?ids=${e.ids.join(',')}`} className="text-accent hover:underline">{e.label ?? `${e.ids.length} transaction${e.ids.length > 1 ? 's' : ''}`}</Link>);
    else if (e.type === 'account') chips.push(<Link key={key} to={`/accounts/${e.id}`} className="text-accent hover:underline">{e.label ?? 'account'}</Link>);
    else if (e.type === 'research' || e.type === 'assumption') chips.push(<Link key={key} to={`/assumptions#${e.id}`} className="text-accent hover:underline">{e.label ?? (e.type === 'research' ? 'research' : 'assumption')}</Link>);
    else if (e.type === 'payslip' || e.type === 'hmrc' || e.type === 'employment') chips.push(<Link key={key} to="/tax/pay" className="text-accent hover:underline">{e.label ?? { payslip: 'payslip', hmrc: 'HMRC record', employment: 'job' }[e.type]}</Link>);
    else if (e.type === 'agreement') chips.push(<Link key={key} to="/spending" className="text-accent hover:underline">{e.label ?? 'agreement'}</Link>);
    else if (e.type === 'company') chips.push(<Link key={key} to="/accounts" className="text-accent hover:underline">{e.label ?? 'company'}</Link>);
    else if (e.type === 'computed') chips.push(<span key={key}>{e.label ?? e.metric}</span>);
    else chips.push(<span key={key}>{e.label ?? e.type}</span>);
  });
  return <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">{chips}</span>;
}

/** Claude's inferences for a page, labelled as such. Renders nothing when there are none and no `empty`. */
export function InsightsPanel({ page, accountId, title = 'Agent notes', empty, className, limit = 6 }: { page: InsightPage; accountId?: string; title?: ReactNode; empty?: ReactNode; className?: string; limit?: number }) {
  const q = useApi<Insight[]>(['insights', page, accountId ?? ''], `/insights?page=${page}${accountId ? `&accountId=${accountId}` : ''}`);
  const dismiss = useApiMutation((id: string) => api(`/insights/${id}/dismiss`, { method: 'POST' }));
  const feedback = useApiMutation((v: { id: string; useful: boolean }) => api(`/insights/${v.id}/feedback`, { method: 'POST', body: { useful: v.useful } }));
  const items = (q.data ?? []).slice(0, limit);
  if (!items.length && !empty) return null;
  return (
    <Card
      className={className}
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4 text-ink-3" aria-hidden /> {title}
        </span>
      }
      description="Inferred by an agent from your data and research: judgement, not calculation. Each cites what it rests on."
    >
      {!items.length ? (
        empty
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((i) => (
            <li key={i.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold text-ink">{i.title}</div>
                  <p className="mt-0.5 text-[13px] whitespace-pre-line text-ink-2">{i.body}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
                    <Badge tone={i.confidence === 'high' ? 'neutral' : 'muted'}>{i.confidence} confidence</Badge>
                    <span>
                      Evidence: <EvidenceLinks insight={i} />
                    </span>
                    <span title={`${i.provenance.model ?? ''} · prompt ${i.provenance.promptVersion ?? ''}`}>
                      {i.provenance.setBy === 'agent' ? 'Agent' : i.provenance.setBy} · {formatDate(i.createdAt.slice(0, 10))}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button type="button" className={cn('rounded p-1 hover:bg-panel-2', i.feedback?.useful === true ? 'text-good-ink' : 'text-ink-3')} aria-label="Useful" title="Useful" onClick={() => feedback.mutate({ id: i.id, useful: true })}>
                    <ThumbsUp className="size-3.5" />
                  </button>
                  <button type="button" className={cn('rounded p-1 hover:bg-panel-2', i.feedback?.useful === false ? 'text-bad-ink' : 'text-ink-3')} aria-label="Not useful" title="Not useful" onClick={() => feedback.mutate({ id: i.id, useful: false })}>
                    <ThumbsDown className="size-3.5" />
                  </button>
                  <button type="button" className="rounded p-1 text-ink-3 hover:bg-panel-2" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss.mutate(i.id)}>
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A link to where assumptions and research are managed. */
export function AssumptionsLink({ children = 'Assumptions & research' }: { children?: ReactNode }) {
  return (
    <Link to="/assumptions" className="inline-flex items-center gap-1 text-accent hover:underline">
      {children} <ExternalLink className="size-3" aria-hidden />
    </Link>
  );
}
