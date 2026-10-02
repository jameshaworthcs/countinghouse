import { Bot, History, Play, Plus, RefreshCw, RotateCcw, Square, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { formatAssumptionValue } from '../../shared/assumptions';
import { ASSET_CLASSES, CONTEXT_KINDS, INSTRUMENT_TYPES, type Assumption, type AssumptionScope, type ContextRecord, type Instrument, type Note, type Research } from '../../shared/schema';
import { SourceTag } from '../components/Intel';
import { Badge, Button, Callout, Card, Dialog, EmptyState, Field, Input, Loading, PageHeader, Select, StatusBadge, Tabs, Textarea, tableClasses, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, timeAgo } from '../lib/format';
import { SessionsLink } from '../components/SessionsLink';

type Tab = 'assumptions' | 'research' | 'about' | 'jobs';

interface AssumptionDefView {
  key: string;
  label: string;
  unit: 'rate' | 'gbpPerYear' | 'ratio';
  description: string;
  scopes: AssumptionScope['kind'][];
  min: number;
  max: number;
  fallback: { value: number; range?: { low: number; high: number }; note: string };
}
interface ResolvedView {
  key: string;
  value: number;
  range?: { low: number; high: number };
  source: 'owner' | 'agent' | 'fallback';
  recordId?: string;
  note?: string;
  stale: boolean;
  assetClass?: string;
  accountType?: string;
}
interface AssumptionsView {
  defs: AssumptionDefView[];
  active: (Assumption & { versions: number; stale: boolean })[];
  global: ResolvedView[];
  byClass: ResolvedView[];
  byType: ResolvedView[];
}
interface JobView {
  id: string;
  kind: string;
  label: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  trigger: string;
  privacy: 'public' | 'personal';
  promptVersion: string;
  createdAt: string;
  startedAt?: string;
  durationMs?: number;
  model?: string;
  costUsd?: number;
  summary?: string;
  error?: string;
  written?: { type: string; id: string }[];
}
interface JobsView {
  enabled: boolean;
  jobs: JobView[];
  suggestions: { kind: string; params: Record<string, unknown>; label: string; reason: string; auto: boolean }[];
  budget: { perDayUsd: number; perMonthUsd: number; spentTodayUsd: number; spentThisMonthUsd: number; open: boolean };
  autoResearch: boolean;
}

const RESEARCH_JOB_KINDS = new Set(['research-instrument', 'research-provider', 'refresh-assumptions']);

const TYPE_LABEL: Record<string, string> = { current: 'current accounts', savings: 'savings accounts', cash_isa: 'cash ISAs', premium_bonds: 'Premium Bonds' };
const CLASS_LABEL: Record<string, string> = { equity: 'Shares', bond: 'Bonds', cash: 'Cash', property: 'Property', mixed: 'Mixed', commodity: 'Commodities', crypto: 'Crypto', other: 'Other' };
const fmt = (key: string, v: number) => formatAssumptionValue(key, v);

function scopeLabel(scope: AssumptionScope, names: { account: (id: string) => string; instrument: (id: string) => string; institution: (id: string) => string }): string {
  switch (scope.kind) {
    case 'global':
      return 'Everything';
    case 'assetClass':
      return CLASS_LABEL[scope.assetClass] ?? scope.assetClass;
    case 'accountType':
      return scope.accountType.replace(/_/g, ' ');
    case 'institution':
      return names.institution(scope.institutionId);
    case 'account':
      return names.account(scope.accountId);
    case 'instrument':
      return names.instrument(scope.instrumentId);
  }
}

// ─── Override dialog ─────────────────────────────────────────────────────────────────────────────

function OverrideDialog({ def, scope, current, onClose }: { def: AssumptionDefView; scope: AssumptionScope; current?: { value: number; range?: { low: number; high: number } }; onClose: () => void }) {
  const toast = useToast();
  const pctUnit = def.unit === 'rate';
  const show = (v: number | undefined) => (v === undefined ? '' : pctUnit ? String(Math.round(v * 10_000) / 100) : String(v));
  const [value, setValue] = useState(show(current?.value));
  const [low, setLow] = useState(show(current?.range?.low));
  const [high, setHigh] = useState(show(current?.range?.high));
  const [why, setWhy] = useState('');
  const parse = (s: string) => (s.trim() === '' ? undefined : pctUnit ? Number(s) / 100 : Number(s));
  const save = useApiMutation(
    () =>
      api('/assumptions/override', {
        method: 'POST',
        body: { key: def.key, scope, value: parse(value), ...(parse(low) !== undefined && parse(high) !== undefined ? { range: { low: parse(low), high: parse(high) } } : {}), ...(why.trim() ? { rationale: why.trim() } : {}) },
      }),
    { onSuccess: () => (toast({ tone: 'good', text: `Your ${def.label.toLowerCase()} is saved` }), onClose()) },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Your ${def.label.toLowerCase()}`}
      description={def.description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={parse(value) === undefined || Number.isNaN(parse(value))} onClick={() => save.mutate(undefined)}>
            Save override
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={`Value${pctUnit ? ' (% a year)' : def.unit === 'gbpPerYear' ? ' (£ a year)' : ''}`}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Range: low (optional)" hint="Roughly the 10th percentile">
            <Input value={low} onChange={(e) => setLow(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Range: high (optional)" hint="Roughly the 90th percentile">
            <Input value={high} onChange={(e) => setHigh(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <Field label="Why (optional)">
          <Textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} placeholder="e.g. I would rather plan cautiously" />
        </Field>
        <p className="text-[12.5px] text-ink-3">Your value wins over research and agents until you remove it. Every change is kept in the history.</p>
        {save.error && <Callout tone="bad">{save.error.message}</Callout>}
      </div>
    </Dialog>
  );
}

function HistoryDialog({ def, scope, onClose }: { def: AssumptionDefView; scope: AssumptionScope; onClose: () => void }) {
  const q = useApi<Assumption[]>(['assumption-history', def.key, JSON.stringify(scope)], `/assumptions/history?key=${encodeURIComponent(def.key)}&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`History: ${def.label}`} wide>
      {!q.data ? (
        <Loading />
      ) : (
        <ol className="flex flex-col gap-3">
          {q.data.map((a) => (
            <li key={a.id} id={a.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{a.status === 'retired' ? 'Removed' : fmt(a.key, a.value)}</span>
                {a.range && a.status !== 'retired' && <span className="text-ink-3">({fmt(a.key, a.range.low)}–{fmt(a.key, a.range.high)})</span>}
                <Badge tone={a.provenance.setBy === 'owner' ? 'accent' : 'neutral'}>{a.provenance.setBy === 'owner' ? 'You' : 'Agent'}</Badge>
                <span className="text-ink-3">
                  {formatDate(a.createdAt.slice(0, 10))} · as of {formatDate(a.asOf)}
                  {a.provenance.model ? ` · ${a.provenance.model}` : ''}
                </span>
              </div>
              <div className="mt-1 text-ink-2">{a.rationale}</div>
              <div className="mt-1 text-[12px] text-ink-3">{a.source}</div>
              {a.evidence.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-[12px]">
                  {a.evidence.map((e, i) => (
                    <li key={i}>
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                          {e.title}
                        </a>
                      ) : (
                        e.title
                      )}
                      {e.quote && <span className="text-ink-3"> — “{e.quote}”</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

// ─── Tab: assumptions ────────────────────────────────────────────────────────────────────────────

function AssumptionsTab() {
  const q = useApi<AssumptionsView>(['assumptions'], '/assumptions');
  const { data, accountName } = useAppData();
  const instruments = useApi<Instrument[]>(['instruments'], '/instruments');
  const [editing, setEditing] = useState<{ def: AssumptionDefView; scope: AssumptionScope; current?: { value: number; range?: { low: number; high: number } } } | null>(null);
  const [history, setHistory] = useState<{ def: AssumptionDefView; scope: AssumptionScope } | null>(null);
  const toast = useToast();
  const retire = useApiMutation((v: { key: string; scope: AssumptionScope }) => api('/assumptions/override', { method: 'POST', body: { ...v, retire: true } }), { onSuccess: () => toast({ tone: 'good', text: 'Override removed' }) });
  const names = {
    account: accountName,
    instrument: (id: string) => instruments.data?.find((i) => i.id === id)?.name ?? id,
    institution: (id: string) => data.institutions.find((i) => i.id === id)?.name ?? id,
  };
  if (!q.data) return <Loading />;
  const d = q.data;
  const row = (def: AssumptionDefView, r: ResolvedView, scope: AssumptionScope, label?: string) => {
    const ownerActive = d.active.find((a) => a.key === def.key && a.provenance.setBy === 'owner' && JSON.stringify(a.scope) === JSON.stringify(scope));
    const record = d.active.find((a) => a.id === r.recordId);
    return (
      <tr key={`${def.key}-${JSON.stringify(scope)}`} id={r.recordId}>
        <td className={tableClasses.td}>
          <div className="font-medium text-ink">{label ?? def.label}</div>
          {!label && <div className="max-w-md text-[12px] text-ink-3">{def.description}</div>}
        </td>
        <td className={cn(tableClasses.td, 'text-right')}>
          <div className="tabular font-semibold text-ink">{fmt(def.key, r.value)}</div>
          {r.range && <div className="text-[11.5px] text-ink-3">{fmt(def.key, r.range.low)}–{fmt(def.key, r.range.high)}</div>}
        </td>
        <td className={tableClasses.td}>
          <div className="flex flex-col items-start gap-0.5">
            <SourceTag value={{ source: r.source, basis: r.source === 'fallback' ? (r.note ?? def.fallback.note) : (record?.source ?? ''), stale: r.stale, ...(record ? { asOf: record.asOf } : {}) }} />
            <div className="max-w-sm text-[12px] text-ink-3">{r.source === 'fallback' ? (r.note ?? def.fallback.note) : record ? `${record.source}${record.rationale ? ` — ${record.rationale.slice(0, 160)}${record.rationale.length > 160 ? '…' : ''}` : ''}` : ''}</div>
          </div>
        </td>
        <td className={cn(tableClasses.td, 'text-right whitespace-nowrap')}>
          <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => setHistory({ def, scope })} disabled={!record && !ownerActive}>
            History
          </Button>
          {ownerActive ? (
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => retire.mutate({ key: def.key, scope })}>
              Remove yours
            </Button>
          ) : (
            <Button size="sm" onClick={() => setEditing({ def, scope, current: { value: r.value, ...(r.range ? { range: r.range } : {}) } })}>
              Override
            </Button>
          )}
        </td>
      </tr>
    );
  };
  const perClass = (key: string) => d.byClass.filter((b) => b.key === key && ['equity', 'bond', 'cash', 'property', 'mixed'].includes(b.assetClass!));
  const scoped = d.active.filter((a) => a.scope.kind !== 'global' && a.scope.kind !== 'assetClass');
  return (
    <div className="flex flex-col gap-5">
      <Callout tone="neutral" title="How these work">
        Each value is the first of: your override, an agent’s value from research (with its sources and reasoning), or the app’s fallback. Within each, the most specific scope wins (a fund, then its account, its provider, the account type, the asset class, everything). Every change is kept.
      </Callout>
      <Card title="Economy and your circumstances" padded={false}>
        <table className={tableClasses.table}>
          <tbody>
            {d.defs
              .filter((def) => !def.key.startsWith('return.') && !def.key.startsWith('fee.') && def.key !== 'interest.rate' && def.scopes.includes('global'))
              .map((def) => row(def, d.global.find((g) => g.key === def.key)!, { kind: 'global' }))}
          </tbody>
        </table>
      </Card>
      <Card title="Expected returns and volatility by asset class" description="Before charges and inflation. Funds are projected from their make-up." padded={false}>
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Asset class</th>
              <th className={cn(tableClasses.th, 'text-right')}>Value</th>
              <th className={tableClasses.th}>Source</th>
              <th className={tableClasses.th} />
            </tr>
          </thead>
          <tbody>
            {perClass('return.expected').map((b) => row(d.defs.find((x) => x.key === 'return.expected')!, b, { kind: 'assetClass', assetClass: b.assetClass as (typeof ASSET_CLASSES)[number] }, `${CLASS_LABEL[b.assetClass!]}: expected return`))}
            {perClass('return.volatility').map((b) => row(d.defs.find((x) => x.key === 'return.volatility')!, b, { kind: 'assetClass', assetClass: b.assetClass as (typeof ASSET_CLASSES)[number] }, `${CLASS_LABEL[b.assetClass!]}: volatility`))}
          </tbody>
        </table>
      </Card>
      <Card title="Charges and interest" description="Researched fund charges, platform fees and savings rates are used where known; these are the defaults beneath them." padded={false}>
        <table className={tableClasses.table}>
          <tbody>
            {d.defs.filter((def) => def.key.startsWith('fee.') && def.scopes.includes('global')).map((def) => row(def, d.global.find((g) => g.key === def.key)!, { kind: 'global' }))}
            {d.byType.map((b) => row(d.defs.find((x) => x.key === 'interest.rate')!, b, { kind: 'accountType', accountType: b.accountType as 'savings' }, `Interest: ${TYPE_LABEL[b.accountType!] ?? b.accountType}`))}
          </tbody>
        </table>
      </Card>
      {scoped.length > 0 && (
        <Card title="Set for a provider, account or fund" padded={false}>
          <table className={tableClasses.table}>
            <tbody>
              {scoped.map((a) =>
                row(d.defs.find((x) => x.key === a.key)!, { key: a.key, value: a.value, ...(a.range ? { range: a.range } : {}), source: a.provenance.setBy === 'owner' ? 'owner' : 'agent', recordId: a.id, stale: a.stale }, a.scope, `${d.defs.find((x) => x.key === a.key)?.label}: ${scopeLabel(a.scope, names)}`),
              )}
            </tbody>
          </table>
        </Card>
      )}
      {editing && <OverrideDialog def={editing.def} scope={editing.scope} {...(editing.current ? { current: editing.current } : {})} onClose={() => setEditing(null)} />}
      {history && <HistoryDialog def={history.def} scope={history.scope} onClose={() => setHistory(null)} />}
    </div>
  );
}

// ─── Tab: funds and providers ────────────────────────────────────────────────────────────────────

function pctOrDash(v: number | undefined) {
  return v === undefined ? '—' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}

function ResearchSummary({ records }: { records: Research[] }) {
  const facts = records.find((r) => r.kind === 'instrument.facts');
  const perf = records.find((r) => r.kind === 'instrument.performance');
  if (!facts && !perf) return <span className="text-ink-3">Not researched yet</span>;
  return (
    <div className="flex flex-col gap-1 text-[12.5px]">
      {facts && facts.kind === 'instrument.facts' && (
        <div>
          OCF <span className="tabular font-medium text-ink">{pctOrDash(facts.data.ocf)}</span>
          {facts.data.allocation && (
            <span className="text-ink-3">
              {' · '}
              {Object.entries(facts.data.allocation)
                .filter(([, v]) => (v ?? 0) > 0)
                .map(([k, v]) => `${Math.round((v ?? 0) * 100)}% ${CLASS_LABEL[k]?.toLowerCase() ?? k}`)
                .join(', ')}
            </span>
          )}
          {facts.data.benchmark && <span className="text-ink-3"> · tracks {facts.data.benchmark}</span>}
        </div>
      )}
      {perf && perf.kind === 'instrument.performance' && (
        <div className="text-ink-3">
          Past returns a year to {formatDate(perf.data.periodEnd)}: 1y {pctOrDash(perf.data.returns.y1)}, 3y {pctOrDash(perf.data.returns.y3)}, 5y {pctOrDash(perf.data.returns.y5)}
          {perf.data.returns.y10 !== undefined && `, 10y ${pctOrDash(perf.data.returns.y10)}`}
          {perf.data.volatility.y5 !== undefined && ` · volatility ${pctOrDash(perf.data.volatility.y5)}`}. Past, not a forecast.
        </div>
      )}
      <div className="text-[11.5px] text-ink-3">
        {[facts, perf]
          .flatMap((r) => (r ? r.sources.slice(0, 2) : []))
          .map((s, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {s.url ? (
                <a className="text-accent hover:underline" href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.publisher ?? s.title}
                </a>
              ) : (
                s.title
              )}
            </span>
          ))}
        {' · '}
        {facts ? `researched ${timeAgo(facts.createdAt)}` : ''}
      </div>
    </div>
  );
}

function ResearchTab() {
  const instruments = useApi<Instrument[]>(['instruments'], '/instruments');
  const research = useApi<Research[]>(['research'], '/research');
  const { data } = useAppData();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', isin: '', ticker: '', type: '' });
  const run = useApiMutation((v: { kind: string; params: Record<string, unknown> }) => api('/jobs', { method: 'POST', body: v }), { onSuccess: () => toast({ tone: 'good', text: 'Research queued. It runs in the background; results appear here.' }) });
  const add = useApiMutation(() => api('/instruments', { method: 'POST', body: { name: form.name.trim(), ...(form.isin.trim() ? { isin: form.isin.trim().toUpperCase() } : {}), ...(form.ticker.trim() ? { ticker: form.ticker.trim() } : {}), ...(form.type ? { type: form.type } : {}) } }), {
    onSuccess: () => {
      setAdding(false);
      setForm({ name: '', isin: '', ticker: '', type: '' });
      toast({ tone: 'good', text: 'Fund added' });
    },
  });
  if (!instruments.data || !research.data) return <Loading />;
  const all = research.data;
  const byInstrument = (id: string) => all.filter((r) => r.subject.instrumentId === id);
  const byInstitution = (id: string) => all.filter((r) => r.subject.institutionId === id);
  // Providers whose rates or charges matter: savings, ISAs, investment platforms and pensions.
  const researchable = new Set(['savings', 'cash_isa', 'stocks_isa', 'lisa', 'ifisa', 'gia', 'sipp', 'workplace_pension', 'personal_pension']);
  const providers = data.institutions.filter((i) => data.accounts.some((a) => a.institutionId === i.id && a.status === 'open' && researchable.has(a.type)) && i.kind !== 'government');
  const general = research.data.filter((r) => r.kind === 'market.outlook' || r.kind === 'economy.indicator');
  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Funds and investments"
        description="Added from your holdings or by you. Each is researched once (charges, make-up, benchmark, past returns) and refreshed when stale."
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add a fund
          </Button>
        }
        padded={false}
      >
        {!instruments.data.length ? (
          <EmptyState title="No funds yet">They appear when a statement or screenshot lists your holdings, or when you add one.</EmptyState>
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {instruments.data.map((i) => (
                <tr key={i.id} id={i.id}>
                  <td className={cn(tableClasses.td, 'w-[34%]')}>
                    <div className="font-medium text-ink">{i.name}</div>
                    <div className="text-[12px] text-ink-3">{[i.isin, i.ticker, i.type?.replace(/_/g, ' '), i.manager].filter(Boolean).join(' · ') || 'No identifiers yet'}</div>
                  </td>
                  <td className={tableClasses.td}>
                    <ResearchSummary records={byInstrument(i.id)} />
                  </td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => run.mutate({ kind: 'research-instrument', params: { instrumentId: i.id } })}>
                      Research now
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Providers" description="Current savings rates and platform charges where you hold accounts." padded={false}>
        {!providers.length ? (
          <EmptyState title="No providers yet" />
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {providers.map((p) => {
                const rs = byInstitution(p.id);
                const rates = rs.find((r) => r.kind === 'provider.rates');
                const fees = rs.find((r) => r.kind === 'provider.fees');
                return (
                  <tr key={p.id} id={p.id}>
                    <td className={cn(tableClasses.td, 'w-[34%] font-medium text-ink')}>{p.name}</td>
                    <td className={cn(tableClasses.td, 'text-[12.5px]')}>
                      {!rates && !fees && <span className="text-ink-3">Not researched yet</span>}
                      {rates && rates.kind === 'provider.rates' && (
                        <div>
                          {rates.data.products.slice(0, 4).map((x) => `${x.name} ${pctOrDash(x.aer)}`).join(' · ')}
                          <span className="text-ink-3"> (as of {formatDate(rates.asOf)})</span>
                        </div>
                      )}
                      {fees && fees.kind === 'provider.fees' && (
                        <div>
                          Platform fee {fees.data.tiers.map((t) => `${pctOrDash(t.rate)}${t.upToGbp ? ` to £${t.upToGbp.toLocaleString('en-GB')}` : ''}`).join(', then ')}
                          {fees.data.capGbpPerYear !== undefined && `, capped at £${fees.data.capGbpPerYear}`}
                          <span className="text-ink-3"> (as of {formatDate(fees.asOf)})</span>
                        </div>
                      )}
                    </td>
                    <td className={cn(tableClasses.td, 'text-right')}>
                      <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => run.mutate({ kind: 'research-provider', params: { institutionId: p.id } })}>
                        Research now
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title="Economy and market outlooks"
        description="The evidence behind the return and inflation assumptions: past figures and published forecasts, kept apart from the assumptions themselves."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => run.mutate({ kind: 'refresh-assumptions', params: {} })}>
            Refresh assumptions
          </Button>
        }
        padded={false}
      >
        {!general.length ? (
          <EmptyState title="No outlooks recorded yet">Refreshing the assumptions records the outlooks and indicators they rest on.</EmptyState>
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {general.slice(0, 30).map((r) => (
                <tr key={r.id} id={r.id}>
                  <td className={tableClasses.td}>
                    {r.kind === 'market.outlook' ? `${CLASS_LABEL[r.data.assetClass]}: ${r.data.publisher}, ${r.data.horizonYears}-year outlook` : r.kind === 'economy.indicator' ? `${r.data.indicator.toUpperCase()} (${r.data.basis}), ${r.data.period}: ${r.data.publisher}` : ''}
                  </td>
                  <td className={cn(tableClasses.td, 'text-right tabular')}>
                    {r.kind === 'market.outlook' ? pctOrDash(r.data.expectedReturnNominal ?? r.data.expectedReturnReal) : r.kind === 'economy.indicator' ? pctOrDash(r.data.value) : ''}
                  </td>
                  <td className={cn(tableClasses.td, 'text-[12px] text-ink-3')}>
                    {formatDate(r.asOf)} ·{' '}
                    {r.sources[0]?.url ? (
                      <a className="text-accent hover:underline" href={r.sources[0].url} target="_blank" rel="noreferrer noopener">
                        source
                      </a>
                    ) : (
                      r.sources[0]?.title
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && (
        <Dialog
          open
          onOpenChange={(o) => !o && setAdding(false)}
          title="Add a fund"
          description="Its public identifiers are researched: charges, make-up and past returns. Nothing about you or your holdings is sent."
          footer={
            <>
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" disabled={!form.name.trim()} loading={add.isPending} onClick={() => add.mutate(undefined)}>
                Add
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Vanguard LifeStrategy 80% Equity Fund Acc" autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ISIN (optional)">
                <Input value={form.isin} onChange={(e) => setForm({ ...form, isin: e.target.value })} placeholder="GB00B4PQW151" />
              </Field>
              <Field label="Ticker (optional)">
                <Input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} />
              </Field>
            </div>
            <Field label="Type (optional)">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="">Not sure</option>
                {INSTRUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            {add.error && <Callout tone="bad">{add.error.message}</Callout>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ─── Tab: about you ──────────────────────────────────────────────────────────────────────────────

function NoteCard({ note }: { note: Note }) {
  const toast = useToast();
  const [chosen, setChosen] = useState<string[]>(note.proposals.filter((p) => p.accepted === undefined).map((p) => p.key));
  const accept = useApiMutation(() => api(`/notes/${note.id}/accept`, { method: 'POST', body: { keys: chosen } }), { onSuccess: () => toast({ tone: 'good', text: 'Recorded' }) });
  const dismiss = useApiMutation(() => api(`/notes/${note.id}/dismiss`, { method: 'POST' }));
  const pending = note.proposals.filter((p) => p.accepted === undefined);
  return (
    <li className="rounded-lg border border-line px-3.5 py-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13.5px] text-ink">“{note.text}”</p>
        {note.status === 'new' || note.status === 'interpreting' ? (
          <StatusBadge status="pending">Understanding…</StatusBadge>
        ) : note.status === 'failed' ? (
          <StatusBadge status="bad">Could not read</StatusBadge>
        ) : note.status === 'applied' ? (
          <StatusBadge status="good">Recorded</StatusBadge>
        ) : note.status === 'dismissed' ? (
          <Badge tone="muted">Dismissed</Badge>
        ) : null}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{timeAgo(note.createdAt)}</div>
      {pending.length > 0 && note.status === 'proposed' && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-ink-2">The agent proposes to record:</div>
          {pending.map((p) => (
            <label key={p.key} className="flex cursor-pointer gap-2 rounded-md bg-panel-2 px-2.5 py-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={chosen.includes(p.key)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.key] : c.filter((k) => k !== p.key)))} />
              <span>
                <span className="font-medium text-ink">{p.type === 'context' ? String(p.record.statement) : `Fund: ${String(p.record.name)}`}</span>
                <span className="block text-[12px] text-ink-3">{p.explanation}</span>
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!chosen.length} loading={accept.isPending} onClick={() => accept.mutate(undefined)}>
              Record {chosen.length === pending.length ? 'all' : `${chosen.length}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(undefined)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function AboutTab() {
  const notes = useApi<Note[]>(['notes'], '/notes', { refetchInterval: 8000 });
  const context = useApi<ContextRecord[]>(['context'], '/context');
  const toast = useToast();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ContextRecord['kind']>('plan');
  const [statement, setStatement] = useState('');
  const send = useApiMutation(() => api('/notes', { method: 'POST', body: { text } }), { onSuccess: () => (setText(''), toast({ tone: 'good', text: 'Noted. The agent will propose what to record; confirm it below.' })) });
  const addContext = useApiMutation(() => api('/context', { method: 'POST', body: { kind, statement } }), { onSuccess: () => setStatement('') });
  const setStatus = useApiMutation((v: { id: string; status: 'active' | 'done' | 'retired' }) => api(`/context/${v.id}`, { method: 'PATCH', body: { status: v.status } }));
  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
      <div className="flex flex-col gap-5">
        <Card title="Tell the app" description="In plain words: what you hold, your plans, your circumstances. An agent turns it into records you confirm; the agents and insights read them. Nothing goes on the web.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="e.g. I hold Vanguard LifeStrategy 80 in my ISA. We plan to buy a house in 2028 for about £400,000, using my LISA for the deposit." />
          <div className="mt-2 flex justify-end">
            <Button variant="primary" disabled={!text.trim()} loading={send.isPending} onClick={() => send.mutate(undefined)} icon={<Bot className="size-4" />}>
              Send
            </Button>
          </div>
        </Card>
        <Card title="What you’ve told it">
          {!notes.data?.length ? (
            <div className="text-[13px] text-ink-3">Nothing yet.</div>
          ) : (
            <ul className="flex flex-col gap-3">
              {notes.data.slice(0, 20).map((n) => (
                <NoteCard key={n.id} note={n} />
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="About you" description="The facts and plans on record. Agents read these; they never change them.">
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Kind" className="w-36">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ContextRecord['kind'])}>
              {CONTEXT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Statement" className="min-w-48 flex-1">
            <Input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. I want an emergency fund of six months’ spending" />
          </Field>
          <Button disabled={!statement.trim()} loading={addContext.isPending} onClick={() => addContext.mutate(undefined)}>
            Add
          </Button>
        </div>
        {!context.data?.length ? (
          <div className="text-[13px] text-ink-3">Nothing recorded yet.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {context.data.map((c) => (
              <li key={c.id} className={cn('flex items-start gap-2 py-2.5', c.status !== 'active' && 'opacity-60')}>
                <Badge tone="neutral">{c.kind}</Badge>
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="text-ink">{c.statement}</div>
                  <div className="text-[11.5px] text-ink-3">
                    {c.origin.kind === 'note' ? 'From something you told the app' : c.origin.kind === 'document' ? `From ${c.origin.document ?? 'a document you gave'}` : 'Added by you'} · {timeAgo(c.updatedAt)}
                    {c.status !== 'active' && ` · ${c.status}`}
                  </div>
                </div>
                {c.status === 'active' ? (
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: c.id, status: 'retired' })}>
                    No longer true
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: c.id, status: 'active' })}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ─── Tab: agent jobs ─────────────────────────────────────────────────────────────────────────────

function JobsTab() {
  const q = useApi<JobsView>(['jobs'], '/jobs', { refetchInterval: 10_000 });
  const toast = useToast();
  const start = useApiMutation((v: { kind: string; params: Record<string, unknown> }) => api('/jobs', { method: 'POST', body: v }), { onSuccess: () => toast({ tone: 'good', text: 'Queued' }) });
  const cancel = useApiMutation((id: string) => api(`/jobs/${id}/cancel`, { method: 'POST' }));
  const rerun = useApiMutation((id: string) => api(`/jobs/${id}/rerun`, { method: 'POST' }), { onSuccess: () => toast({ tone: 'good', text: 'Queued again' }) });
  if (!q.data) return <Loading />;
  const d = q.data;
  const active = d.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const done = d.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
  return (
    <div className="flex flex-col gap-5">
      {!d.enabled && <Callout tone="neutral">Agents are off: nothing starts by itself. You can still start jobs here. Turn them on in Settings → Agents.</Callout>}
      <Callout tone={d.budget.open ? 'neutral' : 'warn'} title={`Background budget: $${d.budget.spentTodayUsd.toFixed(2)} of $${d.budget.perDayUsd} today, $${d.budget.spentThisMonthUsd.toFixed(2)} of $${d.budget.perMonthUsd} this month`}>
        {d.budget.open
          ? 'Jobs the app starts by itself stop once either limit is reached; jobs you start are not limited. Costs are Claude usage at API prices.'
          : `The ${d.budget.spentTodayUsd >= d.budget.perDayUsd ? 'daily' : 'monthly'} limit is reached, so queued jobs the app started wait for ${d.budget.spentTodayUsd >= d.budget.perDayUsd ? 'tomorrow' : 'next month'}. Run one now to start it anyway, or change the limits in Settings → Agents.`}
      </Callout>
      <Card title="Due or stale" description={`What needs researching, refreshing or reviewing.${d.autoResearch ? '' : ' Research runs only when you press Run now (Settings → Agents).'} Research jobs send only public identifiers; jobs that read your data have no web access.`} padded={false}>
        {!d.suggestions.length ? (
          <div className="px-5 py-4 text-[13px] text-ink-3">Everything is up to date.</div>
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {d.suggestions.map((s) => (
                <tr key={`${s.kind}-${JSON.stringify(s.params)}`}>
                  <td className={tableClasses.td}>
                    <div className="font-medium text-ink">{s.label}</div>
                    <div className="text-[12px] text-ink-3">{s.reason}</div>
                  </td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => start.mutate({ kind: s.kind, params: s.params })}>
                      Run now
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Running and queued" padded={false}>
        {!active.length ? (
          <div className="px-5 py-4 text-[13px] text-ink-3">Nothing running.</div>
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {active.map((j) => (
                <tr key={j.id}>
                  <td className={tableClasses.td}>
                    <div className="font-medium text-ink">{j.label}</div>
                    <div className="text-[12px] text-ink-3">
                      {j.privacy === 'public' ? 'Web research, public identifiers only' : 'Reads your data, no web access'} · queued {timeAgo(j.createdAt)} · {j.trigger}
                      {j.status === 'running' && (
                        <>
                          {' · '}
                          <SessionsLink of={j.id}>Watch it</SessionsLink>
                        </>
                      )}
                    </div>
                  </td>
                  <td className={tableClasses.td}>{j.status === 'running' ? <StatusBadge status="pending">Running</StatusBadge> : j.trigger !== 'owner' && !d.budget.open ? <Badge tone="muted">Waiting for budget</Badge> : j.trigger !== 'owner' && !d.autoResearch && RESEARCH_JOB_KINDS.has(j.kind) ? <Badge tone="muted">Waiting for you: Run now, or cancel</Badge> : <Badge tone="neutral">Queued</Badge>}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => cancel.mutate(j.id)}>
                      Cancel
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Finished" description={<>Each job’s records carry its id, model and prompt version. Override any output from the page it appears on. Every run’s transcript is on <SessionsLink />.</>} padded={false}>
        {!done.length ? (
          <div className="px-5 py-4 text-[13px] text-ink-3">No jobs have run yet.</div>
        ) : (
          <table className={tableClasses.table}>
            <tbody>
              {done.slice(0, 50).map((j) => (
                <tr key={j.id}>
                  <td className={tableClasses.td}>
                    <div className="font-medium text-ink">{j.label}</div>
                    <div className="text-[12px] text-ink-3">{j.status === 'failed' ? j.error : j.summary}</div>
                    <div className="text-[11.5px] text-ink-3">
                      {formatDate(j.createdAt.slice(0, 10))} · {j.trigger}
                      {j.durationMs !== undefined && ` · ${Math.round(j.durationMs / 1000)}s`}
                      {j.model && ` · ${j.model}`} · {j.promptVersion}
                      {j.startedAt && (
                        <>
                          {' · '}
                          <SessionsLink of={j.id}>What it did</SessionsLink>
                        </>
                      )}
                    </div>
                  </td>
                  <td className={tableClasses.td}>{j.status === 'succeeded' ? <StatusBadge status="good">Done</StatusBadge> : j.status === 'failed' ? <StatusBadge status="bad">Failed</StatusBadge> : <Badge tone="muted">{j.status}</Badge>}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => rerun.mutate(j.id)}>
                      Rerun
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export default function Assumptions() {
  const location = useLocation();
  const navigate = useNavigate();
  const fromHash = (location.hash.replace('#', '') as Tab) || 'assumptions';
  const [tab, setTab] = useState<Tab>(['assumptions', 'research', 'about', 'jobs'].includes(fromHash) ? fromHash : 'assumptions');
  useEffect(() => {
    if (['assumptions', 'research', 'about', 'jobs'].includes(fromHash)) setTab(fromHash);
  }, [fromHash]);
  const jobs = useApi<JobsView>(['jobs'], '/jobs');
  const running = useMemo(() => jobs.data?.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length ?? 0, [jobs.data]);
  return (
    <div>
      <PageHeader title="Assumptions & research" subtitle="What the projections assume and why, what has been researched, what you have told the app, and the agents that keep it current" />
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          void navigate({ hash: t === 'assumptions' ? '' : t }, { replace: true });
        }}
        tabs={[
          { value: 'assumptions', label: 'Assumptions' },
          { value: 'research', label: 'Funds & providers' },
          { value: 'about', label: 'About you' },
          { value: 'jobs', label: 'Agent jobs', ...(running ? { count: running } : {}) },
        ]}
      />
      <div className="mt-5">
        {tab === 'assumptions' && <AssumptionsTab />}
        {tab === 'research' && <ResearchTab />}
        {tab === 'about' && <AboutTab />}
        {tab === 'jobs' && <JobsTab />}
      </div>
    </div>
  );
}

