import { ChevronDown, ChevronRight, Copy, Eye, GitCommitHorizontal, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { AllowancesResponse, DataHealthResponse, EnrichGroup, EnrichPreview, Handover, SystemResponse, TaxDocSource, TaxDocumentsResponse, TokensResponse } from '../../shared/api';
import { formatDate, today } from '../../shared/dates';
import { FIGURE_KINDS, type Category, type Figure, type Profile, type Rule, type Settings as SettingsT } from '../../shared/schema';
import { taxYearOf } from '../../shared/uk';
import { AuditLog } from '../components/Audit';
import { CoverageGaps, CoverageGrid } from '../components/Coverage';
import { HandoverText } from '../components/Handover';
import { CategorySelect } from '../components/TransactionList';
import { Badge, Button, Callout, Card, Checkbox, Dialog, Field, Input, KeyValue, Loading, Money, NumberInput, PageHeader, Segmented, Select, SortHeader, StatusBadge, Switch, Tabs, tableClasses, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { bandLabel, cn, money, timeAgo } from '../lib/format';
import { Sorted } from '../lib/sort';
import { SessionsLink } from '../components/SessionsLink';
import { ModelsCard } from '../components/ModelsCard';

type Section = 'profile' | 'extraction' | 'categories' | 'rules' | 'tax-documents' | 'data' | 'access' | 'audit' | 'health';

/** The tax band is computed, not set: show this year's and where it comes from. */
function TaxBandLine() {
  const q = useApi<AllowancesResponse>(['allowances', 'current'], '/allowances');
  const t = q.data?.taxBand;
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2 text-[13.5px] text-ink">
      {t ? (
        <>
          {bandLabel(t)}
          <Link to="/tax" className="text-[12.5px] text-accent hover:underline">
            How it is worked out
          </Link>
        </>
      ) : (
        <span className="text-ink-3">…</span>
      )}
    </div>
  );
}

/** The same settings, whatever order their keys are in. */
const sameSettings = (a: unknown, b: unknown): boolean => {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)])) : v);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/**
 * Save, with what is not saved yet said plainly: while anything is changed, the bar stays in view
 * at the foot of the screen with Undo beside Save, so a switch turned on is not left unsaved.
 */
function SaveBar({ dirty, saving, label = 'Save', onSave, onUndo }: { dirty: boolean; saving: boolean; label?: string; onSave: () => void; onUndo: () => void }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2', dirty && 'sticky bottom-3 z-20 rounded-xl border border-line bg-panel px-4 py-3 shadow-card')}>
      {dirty && <span className="mr-auto text-[13px] font-medium text-warn-ink">Not saved yet: your changes apply once you save.</span>}
      {dirty && (
        <Button variant="secondary" onClick={onUndo}>
          Undo
        </Button>
      )}
      <Button variant="primary" loading={saving} onClick={onSave}>
        {label}
      </Button>
    </div>
  );
}

function ProfileForm() {
  const { data } = useAppData();
  const toast = useToast();
  const [p, setP] = useState<Profile>(data.profile);
  const save = useApiMutation(() => api('/profile', { method: 'PUT', body: p as unknown as Record<string, unknown> }), { onSuccess: () => toast({ tone: 'good', text: 'Profile saved' }) });
  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  return (
    <Card title="About you" description="Used for UK rules: LISA age limits, the cash-ISA cap exemption at 65, pension access age, and your savings allowance.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={p.name ?? ''} onChange={(e) => set({ name: e.target.value || undefined })} />
        </Field>
        <Field label="Date of birth">
          <Input type="date" value={p.dateOfBirth ?? ''} onChange={(e) => set({ dateOfBirth: e.target.value || undefined })} />
        </Field>
        <Field label="Income tax band" hint="Worked out from your P60, salary, interest and dividends">
          <TaxBandLine />
        </Field>
        <Field label="Where you pay tax">
          <Select value={p.taxRegion} onChange={(e) => set({ taxRegion: e.target.value as Profile['taxRegion'] })}>
            <option value="england">England</option>
            <option value="wales">Wales</option>
            <option value="scotland">Scotland</option>
            <option value="northern-ireland">Northern Ireland</option>
          </Select>
        </Field>
        <Field label="Gross salary (optional)" hint="Estimates your tax band until your P60 is imported; pension taper warnings">
          <NumberInput value={p.grossSalary} onValue={(v) => set({ grossSalary: v })} />
        </Field>
        <Field label="Retirement age">
          <Input type="number" min={50} max={80} value={p.retirementAge} onChange={(e) => set({ retirementAge: Number(e.target.value) || 67 })} />
        </Field>
        <div className="text-[13px] text-ink-3 sm:col-span-2">
          Returns, inflation, charges, interest and the withdrawal rate are assumption records, set from research and overridable by you: see <Link to="/assumptions" className="text-accent hover:underline">Assumptions &amp; research</Link>.
        </div>
      </div>
      {save.error && <Callout tone="bad" className="mt-3">{save.error.message}</Callout>}
      <div className="mt-4">
        <SaveBar dirty={!sameSettings(p, data.profile)} saving={save.isPending} label="Save profile" onSave={() => save.mutate(undefined)} onUndo={() => setP(data.profile)} />
      </div>
    </Card>
  );
}

function ExtractionForm() {
  const { data } = useAppData();
  const toast = useToast();
  const sys = useApi<SystemResponse>(['system'], '/system');
  const [s, setS] = useState<SettingsT>(data.settings);
  const save = useApiMutation(() => api('/settings', { method: 'PUT', body: s as unknown as Record<string, unknown> }), { onSuccess: () => toast({ tone: 'good', text: 'Settings saved' }) });
  const ex = s.extraction;
  const setEx = (patch: Partial<SettingsT['extraction']>) => setS({ ...s, extraction: { ...ex, ...patch } });
  return (
    <div className="flex flex-col gap-5">
      <ModelsCard s={s} setS={setS} sys={sys.data} />
      <Card title="Reading PDFs and screenshots" description="CSV, OFX, QIF and Santander TXT files, HMRC’s pages saved from gov.uk, and payslips in a layout known here (SAP paystubs, the classic UK payslip), are always read on this machine. The rest is read by the model Models gives reading documents, and checked by the one it gives checking.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Files read at once">
            <Input type="number" min={1} max={4} value={ex.maxConcurrent} onChange={(e) => setEx({ maxConcurrent: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
        </div>
        <div className="mt-4">
          <Switch checked={ex.readReceipts} onChange={(v) => setEx({ readReceipts: v })} label="Read receipts" description="When you attach a receipt to a transaction, the model Models gives receipts reads its lines and suggests how to split the payment (the local model takes a minute or two; Claude costs about $0.05 each). Nothing changes until you save the split. Off: receipts are only kept." />
          <Switch checked={ex.rereadDocuments} onChange={(v) => setEx({ rereadDocuments: v })} label="Read stored documents again" description="On a committed import’s page, read its document again with the current reader and see what it finds different from what was recorded (a reading takes what an upload does). You apply each difference yourself." />
          <Switch checked={ex.readEverything} onChange={(v) => setEx({ readEverything: v })} label="Read everything a document prints" description="The agent also keeps what has nowhere else to go: a scanned payslip in full, HMRC’s pages as their records, and every other labelled value (rates, limits, a P60’s NI table). A reading takes a little longer. Off until its evaluation run has passed; your gov.uk pages and known payslip layouts are read in full on this machine either way." />
        </div>
      </Card>
      <Card title="Agents" description="Jobs that research what you hold, keep assumptions current, write insights, name imports and understand your notes, each with the model Models gives it. Research jobs send only public identifiers (fund names, ISINs, providers); jobs that read your data get no web access.">
        <div className="flex flex-col gap-3">
          <Switch checked={s.agents.enabled} onChange={(v) => setS({ ...s, agents: { ...s.agents, enabled: v } })} label="Let agents start jobs by themselves" description="Insights after imports and the month in review, within the budget below. You can always start any job yourself." />
          <Switch checked={s.agents.autoResearch} onChange={(v) => setS({ ...s, agents: { ...s.agents, autoResearch: v } })} label="Research by itself too" description="Off: fund, provider and assumption research runs only when you press Run now on Assumptions & research → Agent jobs. On: new funds and providers, stale research (at most three a day) and assumptions on fallbacks (at most weekly) start within the budget." />
          <Switch checked={s.agents.insightsAfterImport} onChange={(v) => setS({ ...s, agents: { ...s.agents, insightsAfterImport: v } })} label="Insights after each import" />
          <Switch checked={s.agents.monthlyReview} onChange={(v) => setS({ ...s, agents: { ...s.agents, monthlyReview: v } })} label="A month in review once a month’s data is complete" />
          <Switch checked={s.agents.labelImports} onChange={(v) => setS({ ...s, agents: { ...s.agents, labelImports: v } })} label="Name imports with the agent" description="A minute after you commit or file imports, the agent names each from what was read from it (“Monzo current account statement, Sep 2026”), so Import → History can be searched by what a document is. It sees the kind, provider, accounts and dates, never amounts or numbers, and gets no tools; on Claude a batch costs a few cents, within the budget below, and on the local model nothing. Your own names are kept. On: History also offers to name the ones from before. This switch is enough on its own." />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Refresh research after (days)">
              <Input type="number" min={7} max={730} value={s.agents.researchStaleAfterDays} onChange={(e) => setS({ ...s, agents: { ...s.agents, researchStaleAfterDays: Math.min(730, Math.max(7, Number(e.target.value) || 90)) } })} />
            </Field>
            <Field label="Background budget per day ($)" hint="Claude usage at API prices; the local model costs nothing">
              <Input type="number" min={0} max={100} step={1} value={s.agents.backgroundBudgetPerDayUsd} onChange={(e) => setS({ ...s, agents: { ...s.agents, backgroundBudgetPerDayUsd: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } })} />
            </Field>
            <Field label="Background budget per month ($)">
              <Input type="number" min={0} max={1000} step={5} value={s.agents.backgroundBudgetPerMonthUsd} onChange={(e) => setS({ ...s, agents: { ...s.agents, backgroundBudgetPerMonthUsd: Math.min(1000, Math.max(0, Number(e.target.value) || 0)) } })} />
            </Field>
          </div>
          <div className="text-[12.5px] text-ink-3">
            See what is queued, running or stale on <Link to="/assumptions#jobs" className="text-accent hover:underline">Assumptions &amp; research → Agent jobs</Link>. Every agent session the app has run (jobs, import readings, receipts) and what it did, with its transcript: <SessionsLink />.
          </div>
        </div>
      </Card>
      <Card title="Other">
        <Field label="Flag accounts as stale after (days)">
          <Input type="number" min={7} max={365} value={s.staleAfterDays} onChange={(e) => setS({ ...s, staleAfterDays: Number(e.target.value) || 35 })} className="w-32" />
        </Field>
        <Field label="Exchange rates for foreign-currency accounts" hint='GBP per unit, e.g. USD=0.74, EUR=0.85' className="mt-3">
          <Input
            value={Object.entries(s.fx)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}
            onChange={(e) =>
              setS({
                ...s,
                fx: Object.fromEntries(
                  e.target.value
                    .split(',')
                    .map((p) => p.split('=').map((x) => x.trim()))
                    .filter(([k, v]) => k && /^[A-Z]{3}$/i.test(k) && Number(v) > 0)
                    .map(([k, v]) => [k!.toUpperCase(), Number(v)]),
                ),
              })
            }
          />
        </Field>
      </Card>
      {save.error && <Callout tone="bad">{save.error.message}</Callout>}
      <SaveBar dirty={!sameSettings(s, data.settings)} saving={save.isPending} onSave={() => save.mutate(undefined)} onUndo={() => setS(data.settings)} />
    </div>
  );
}

/** Where money of each kind goes, as the add-a-group form says it. */
const KIND_WORDS: Record<Category['kind'], string> = { expense: 'Spending', income: 'Money in', transfer: 'Transfers', investment: 'Investing' };

function CategoriesEditor() {
  const { data, cats } = useAppData();
  const toast = useToast();
  const [list, setList] = useState<Category[]>(data.categories);
  // Payments go in categories; a group only holds them. Adding one or the other is a choice made
  // first, so a new name never becomes a group by default.
  const [adding, setAdding] = useState<'category' | 'group'>('category');
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [newKind, setNewKind] = useState<Category['kind']>('expense');
  const save = useApiMutation((l: Category[]) => api('/categories', { method: 'PUT', body: l }), { onSuccess: () => toast({ tone: 'good', text: 'Categories saved' }) });
  const groups = list.filter((c) => !c.parent);
  const id = newName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const taken = Boolean(id) && list.some((c) => c.id === id);
  const parent = adding === 'category' ? list.find((c) => c.id === newParent) : undefined;
  const ready = Boolean(id) && !taken && (adding === 'group' || Boolean(parent));
  const add = () => {
    if (!ready) return;
    const next = [...list, adding === 'group' ? { id, name: newName.trim(), kind: newKind } : { id, name: newName.trim(), kind: parent!.kind, parent: parent!.id }];
    setList(next);
    setNewName('');
    save.mutate(next);
  };
  const rename = (c: Category, name: string) => {
    if (!name.trim() || name.trim() === c.name) return;
    const next = list.map((x) => (x.id === c.id ? { ...x, name: name.trim() } : x));
    setList(next);
    save.mutate(next);
  };
  return (
    <Card title="Categories" description="Payments go in categories, and each category sits in a group. Rename, hide or add; system categories (marked) drive calculations and can't be removed." padded={false}>
      <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
        <Segmented
          label="Add"
          value={adding}
          onChange={setAdding}
          options={[
            { value: 'category', label: 'Add a category' },
            { value: 'group', label: 'Add a group' },
          ]}
          className="self-start"
        />
        <p className="text-[12.5px] text-ink-3">
          {adding === 'category' ? 'A category to put payments in, inside one of your groups (as Groceries is in Food & drink).' : 'A group only holds categories (as Food & drink holds Groceries): add a category to it after, to put payments in.'}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={adding === 'category' ? 'Category name' : 'Group name'}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={adding === 'category' ? 'e.g. Climbing' : 'e.g. Business'} className="w-52" />
          </Field>
          {adding === 'category' ? (
            <Field label="In the group">
              <Select value={newParent} onChange={(e) => setNewParent(e.target.value)} className="w-52">
                <option value="">Choose a group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="For">
              <Select value={newKind} onChange={(e) => setNewKind(e.target.value as Category['kind'])} className="w-40">
                {(Object.keys(KIND_WORDS) as Category['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_WORDS[k]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button icon={<Plus className="size-4" />} onClick={add} disabled={!ready}>
            {adding === 'group' ? 'Add the group' : parent ? `Add to ${parent.name}` : 'Add the category'}
          </Button>
        </div>
        {taken && <div className="text-[12px] text-bad-ink">“{cats.name(id)}” is in your categories already.</div>}
      </div>
      <div className="grid gap-x-8 border-t border-line px-5 py-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => (
          <div key={g.id} className="mb-4 break-inside-avoid">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-ink">
              <input
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-semibold text-ink hover:border-line focus:border-accent focus:outline-none"
                defaultValue={g.name}
                onBlur={(e) => rename(g, e.target.value)}
                aria-label={`Rename the group ${g.name}`}
              />
              <Badge tone="muted">{KIND_WORDS[g.kind]}</Badge>
            </div>
            {!list.some((c) => c.parent === g.id) && <p className="px-1 text-[12.5px] text-ink-3">No categories in it: payments go in the group itself. Add one above, choosing this group, to split it.</p>}
            <ul className="flex flex-col gap-0.5">
              {list
                .filter((c) => c.parent === g.id)
                .map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-[13px]">
                    <input
                      className={cn('min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:outline-none', c.hidden ? 'text-ink-3 line-through' : 'text-ink-2')}
                      defaultValue={c.name}
                      onBlur={(e) => rename(c, e.target.value)}
                      aria-label={`Rename ${c.name}`}
                    />
                    {c.system ? (
                      <Badge tone="muted">system</Badge>
                    ) : (
                      <button
                        className="text-[12px] text-ink-3 hover:text-ink"
                        onClick={() => {
                          const next = list.map((x) => (x.id === c.id ? { ...x, hidden: !x.hidden } : x));
                          setList(next);
                          save.mutate(next);
                        }}
                      >
                        {c.hidden ? 'show' : 'hide'}
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="sr-only">{cats.list.length}</div>
    </Card>
  );
}

function RulesEditor() {
  const { data, cats, accountName } = useAppData();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [op, setOp] = useState<Rule['match']['op']>('contains');
  // Money in only, money out only, or either way.
  const [direction, setDirection] = useState<'in' | 'out' | ''>('');
  const [category, setCategory] = useState<string | undefined>();
  const [payee, setPayee] = useState('');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const match = { field: 'description' as const, op, value, caseSensitive: false, ...(direction ? { direction } : {}) };
  useEffect(() => {
    if (!value.trim()) return setPreviewCount(null);
    const t = setTimeout(() => {
      void api<{ count: number }>('/rules/preview', { body: { enabled: true, priority: 100, match: { field: 'description', op, value, caseSensitive: false, ...(direction ? { direction } : {}) }, set: {} } })
        .then((r) => setPreviewCount(r.count))
        .catch(() => setPreviewCount(null));
    }, 300);
    return () => clearTimeout(t);
  }, [value, op, direction]);
  const add = useApiMutation(
    () => api<{ result: { recategorised: number } | null }>('/rules', { body: { name: `${value} → ${cats.name(category)}`, enabled: true, priority: 100, match, set: { ...(category ? { category } : {}), ...(payee ? { payee } : {}) }, apply: true } }),
    {
      onSuccess: (r) => {
        toast({ tone: 'good', text: `Rule added; ${r.result?.recategorised ?? 0} transactions updated` });
        setValue('');
        setPayee('');
        setDirection('');
      },
    },
  );
  const toggle = useApiMutation((r: Rule) => api(`/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }));
  const del = useApiMutation((id: string) => api(`/rules/${id}`, { method: 'DELETE' }));
  const [preview, setPreview] = useState<EnrichPreview | null>(null);
  const check = useApiMutation(() => api<EnrichPreview>('/enrich/preview', { method: 'POST' }), { onSuccess: setPreview });
  const rerun = useApiMutation((body: ReapplyBody) => api<{ recategorised: number; transfersLinked: number; decided: number; rules: number }>('/enrich', { body: body as unknown as Record<string, unknown> }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: [`${r.recategorised} recategorised`, r.decided && `${r.decided} with your category`, r.rules && `${r.rules} rule${r.rules === 1 ? '' : 's'} made`, r.transfersLinked && `${r.transfersLinked} transfers linked`].filter(Boolean).join(', ') });
      setPreview(null);
    },
  });
  return (
    <div className="flex flex-col gap-5">
      <Card title="Add a rule" description="Rules run before the built-in UK merchant list. Your manual edits are never overwritten.">
        <div className="grid gap-3 sm:grid-cols-[140px_1fr_130px_1fr_1fr_auto] sm:items-end">
          <Field label="When description">
            <Select value={op} onChange={(e) => setOp(e.target.value as Rule['match']['op'])}>
              <option value="contains">contains</option>
              <option value="startsWith">starts with</option>
              <option value="equals">equals</option>
              <option value="regex">matches regex</option>
            </Select>
          </Field>
          <Field label="Text" hint={previewCount !== null ? `${previewCount} existing transactions match` : ' '}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. PAYPAL *STEAM" />
          </Field>
          <Field label="For">
            <Select value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out' | '')}>
              <option value="">In or out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </Select>
          </Field>
          <Field label="Set category">
            <CategorySelect value={category} onChange={setCategory} placeholder="(leave)" direction={direction || undefined} />
          </Field>
          <Field label="Set payee">
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="(leave)" />
          </Field>
          <Button variant="primary" icon={<Plus className="size-4" />} loading={add.isPending} disabled={!value.trim() || (!category && !payee)} onClick={() => add.mutate(undefined)}>
            Add
          </Button>
        </div>
        {add.error && <Callout tone="bad" className="mt-3">{add.error.message}</Callout>}
      </Card>
      <Card
        title={`Your rules (${data.rules.length})`}
        description="The preview shows what re-applying categorisation would change. Nothing changes until you apply it."
        padded={false}
        actions={
          <Button size="sm" icon={<Eye className="size-3.5" />} loading={check.isPending} onClick={() => check.mutate(undefined)}>
            Preview re-applying to history
          </Button>
        }
      >
        {check.error && <Callout tone="bad" className="mx-5 my-3">{check.error.message}</Callout>}
        {preview && <ReapplyPreview key={JSON.stringify([preview.recategorised, preview.groups.length])} preview={preview} applying={rerun.isPending} error={rerun.error?.message} onApply={(body) => rerun.mutate(body)} onCancel={() => setPreview(null)} />}
        {data.rules.length ? (
          <Sorted rows={[...data.rules].sort((a, b) => a.priority - b.priority)} columns={{ when: { value: (r) => r.match.value }, then: { value: (r) => (r.set.category ? cats.path(r.set.category) : r.set.payee) }, on: { value: (r) => (r.enabled ? 0 : 1), first: 'asc' } }}>
            {({ rows, sortProps }) => (
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <SortHeader label="When" sort={sortProps('when')} />
                    <SortHeader label="Then" sort={sortProps('then')} />
                    <SortHeader label="On" sort={sortProps('on')} />
                    <th className={tableClasses.th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.enabled ? '' : 'opacity-50'}>
                      <td className={tableClasses.td}>
                        {r.match.field} {r.match.op} <code className="rounded bg-panel-2 px-1">{r.match.value}</code>
                        {r.match.direction && <span className="text-ink-3">, money {r.match.direction}</span>}
                        {r.match.amountMin !== undefined && r.match.amountMax !== undefined && <span className="text-ink-3">, {money(r.match.amountMin, { decimals: 0 })} to {money(r.match.amountMax, { decimals: 0 })}</span>}
                        {r.match.accountIds?.length ? <div className="text-[12px] text-ink-3">only {r.match.accountIds.map(accountName).join(', ')}</div> : null}
                      </td>
                      <td className={tableClasses.td}>{[r.set.category ? cats.path(r.set.category) : null, r.set.payee ? `payee “${r.set.payee}”` : null, r.set.tags?.length ? `tags ${r.set.tags.join(', ')}` : null].filter(Boolean).join(' · ')}</td>
                      <td className={tableClasses.td}>
                        <Checkbox checked={r.enabled} onChange={() => toggle.mutate(r)} />
                      </td>
                      <td className={cn(tableClasses.td, 'text-right')}>
                        <button className="text-ink-3 hover:text-bad-ink" aria-label="Delete rule" onClick={() => del.mutate(r.id)}>
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Sorted>
        ) : (
          <div className="border-t border-line px-5 py-6 text-[13px] text-ink-3">No rules yet. The quickest way to make one is to recategorise a transaction and accept the “always categorise like this?” prompt.</div>
        )}
      </Card>
      <CsvProfilesCard />
    </div>
  );
}

/** How a category came to be, in words, for the preview of re-applying categorisation. */
const BY_WORDS: Record<string, string> = {
  builtin: 'the app’s own list',
  bank: 'the bank’s category',
  rule: 'your rule',
  transfer: 'a transfer between your accounts',
  agreement: 'an agreement’s schedule',
  ai: 'the reader’s suggestion',
};

/** What you chose for a payment on the preview: a category of yours, or to leave it as it is this time. Absent, it is as proposed. */
type ReapplyChoice = { skip: true } | { category: string };

/** Your choices on the preview, as `POST /enrich` takes them. */
export interface ReapplyBody {
  decided: { id: string; category: string }[];
  skip: string[];
  rules: { name: string; match: Rule['match']; category: string }[];
}

const PROPOSED = '@proposed';
const SKIP = '@skip';
const MIXED = '@mixed';

/** A rule's match in words: "the description holds “X”, money out". */
function ruleWords(m: Rule['match']): string {
  const what = m.field === 'payee' ? `the payee is “${m.value}”` : `the description holds “${m.value}”`;
  return `${what}${m.direction === 'in' ? ', money in' : m.direction === 'out' ? ', money out' : ''}`;
}

/**
 * What re-applying categorisation would change, before anything is written. Each group opens to its
 * payments by payee; any of them can be left as it is this time, or given a category of yours, which
 * re-applying never changes again. Your own categories are never in it.
 */
function ReapplyPreview({ preview, applying, error, onApply, onCancel }: { preview: EnrichPreview; applying: boolean; error: string | undefined; onApply: (body: ReapplyBody) => void; onCancel: () => void }) {
  const { cats, accountName } = useAppData();
  const [choices, setChoices] = useState<Record<string, ReapplyChoice>>({});
  const [always, setAlways] = useState<Record<string, boolean>>({});
  // Linked transfers whose payee is to take the name of the account they are linked with: any can be left.
  const [keepPayee, setKeepPayee] = useState<Record<string, boolean>>({});
  const nothing = !preview.groups.length && !preview.transfersLinked && !preview.payeesTidied && !preview.accountPayees.length;
  const label = (g: EnrichGroup) => `${g.from ? cats.path(g.from) : 'Uncategorised'} → ${g.to ? cats.path(g.to) : 'Uncategorised'}`;
  const choose = (ids: string[], value: string | undefined) =>
    setChoices((cur) => {
      const next = { ...cur };
      for (const id of ids) {
        if (!value || value === PROPOSED) delete next[id];
        else next[id] = value === SKIP ? { skip: true } : { category: value };
      }
      return next;
    });
  const valueOf = (id: string) => {
    const c = choices[id];
    return !c ? PROPOSED : 'skip' in c ? SKIP : c.category;
  };
  const payeeKey = (g: EnrichGroup, payee: string) => `${g.from ?? ''}|${g.to ?? ''}|${g.by ?? ''}|${payee}`;

  const rows = preview.groups.flatMap((g) => g.payees.flatMap((p) => p.rows));
  const decided = rows.flatMap((r) => {
    const c = choices[r.id];
    return c && 'category' in c ? [{ id: r.id, category: c.category }] : [];
  });
  const skip = [
    ...rows.filter((r) => {
      const c = choices[r.id];
      return c && 'skip' in c;
    }).map((r) => r.id),
    ...preview.accountPayees.filter((r) => keepPayee[r.id]).map((r) => r.id),
  ];
  const rules = preview.groups.flatMap((g) =>
    g.payees.flatMap((p) => {
      const value = new Set(p.rows.map((r) => valueOf(r.id)));
      const category = value.size === 1 ? [...value][0]! : undefined;
      if (!always[payeeKey(g, p.payee)] || !p.match || !category || category === PROPOSED || category === SKIP) return [];
      return [{ name: `${p.payee} → ${cats.name(category)}`, match: p.match, category }];
    }),
  );
  const asProposed = rows.length - decided.length - skip.length;

  return (
    <div className="border-t border-line bg-panel-2 px-5 py-4">
      <div className="mb-1 text-[13.5px] font-medium text-ink">{nothing ? 'Nothing would change' : 'Re-applying would change'}</div>
      {!nothing && (
        <p className="mb-3 text-[12.5px] text-ink-3">
          {preview.recategorised} row{preview.recategorised === 1 ? '' : 's'} recategorised
          {preview.transfersLinked ? `, ${preview.transfersLinked} transfer${preview.transfersLinked === 1 ? '' : 's'} linked` : ''}
          {preview.payeesTidied ? `, ${preview.payeesTidied} payee${preview.payeesTidied === 1 ? '' : 's'} tidied` : ''}
          {preview.accountPayees.length ? `, ${preview.accountPayees.length} transfer${preview.accountPayees.length === 1 ? '' : 's'} named for the account ${preview.accountPayees.length === 1 ? 'it is' : 'they are'} linked with` : ''}. Nothing has changed yet. Open a group to see its payments and change any you disagree with: a category you choose is yours, and
          re-applying never changes it again; “Leave as it is” skips a payment this time. Categories you set yourself are never in this list.
        </p>
      )}
      {preview.groups.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {preview.groups.map((g) => (
            <ReapplyGroup key={`${g.from}|${g.to}|${g.by}`} group={g} label={label(g)} valueOf={valueOf} choose={choose} always={(p) => always[payeeKey(g, p)] ?? false} setAlways={(p, v) => setAlways((cur) => ({ ...cur, [payeeKey(g, p)]: v }))} />
          ))}
        </ul>
      )}
      {preview.accountPayees.length > 0 && (
        <div className="mb-3 rounded-lg border border-line bg-panel text-[13px]">
          <div className="px-3 py-2">
            <div className="font-medium text-ink">Transfers that name the wrong one of your accounts</div>
            <div className="text-[12px] text-ink-3">Each is linked with one account, but its payee names another of yours (two accounts at one bank, or one under the same number). It takes the name of the account it is linked with.</div>
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {preview.accountPayees.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-ink-2">
                    {formatDate(r.date)} · {accountName(r.accountId)} · <Money value={r.amount} className="tabular" />
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {r.from ?? 'no payee'} → <span className="text-ink">{r.to}</span>
                  </div>
                </div>
                <Checkbox label="Leave as it is" checked={keepPayee[r.id] ?? false} onChange={(v) => setKeepPayee((cur) => ({ ...cur, [r.id]: v }))} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <Callout tone="bad" className="mb-3">{error}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        {!nothing && (
          <Button variant="primary" size="sm" loading={applying} onClick={() => onApply({ decided, skip, rules })}>
            Apply these changes
          </Button>
        )}
        <Button size="sm" onClick={onCancel}>
          {nothing ? 'Close' : 'Cancel'}
        </Button>
        {(decided.length > 0 || skip.length > 0) && (
          <span className="text-[12px] text-ink-3">
            {[`${asProposed} as proposed`, decided.length && `${decided.length} with your category`, skip.length && `${skip.length} left as ${skip.length === 1 ? 'it is' : 'they are'}`, rules.length && `${rules.length} rule${rules.length === 1 ? '' : 's'} to make`].filter(Boolean).join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

function ReapplyGroup({
  group: g,
  label,
  valueOf,
  choose,
  always,
  setAlways,
}: {
  group: EnrichGroup;
  label: string;
  valueOf: (id: string) => string;
  choose: (ids: string[], value: string | undefined) => void;
  always: (payee: string) => boolean;
  setAlways: (payee: string, v: boolean) => void;
}) {
  const { cats } = useAppData();
  const [open, setOpen] = useState(false);
  const ids = g.payees.flatMap((p) => p.rows.map((r) => r.id));
  const changed = ids.filter((id) => valueOf(id) !== PROPOSED).length;
  const named = g.payees.slice(0, 8).map((p) => `${p.payee} (${p.count})`).join(', ') + (g.payees.length > 8 ? `, and ${g.payees.length - 8} more` : '');
  return (
    <li className="rounded-lg border border-line bg-panel text-[13px]">
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium text-ink">{label}</span>
          <span className="tabular text-ink-2">
            {g.count} row{g.count === 1 ? '' : 's'} · <Money value={g.amount} />
          </span>
        </div>
        <div className="text-[12px] text-ink-3">
          {g.to ? `by ${BY_WORDS[g.by ?? ''] ?? 'the app'}` : 'nothing gives it one now'}: {named}
        </div>
        <button type="button" className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? 'Hide the payments' : `Show the ${g.count === 1 ? 'payment' : `${g.count} payments`}`}
          {changed > 0 && <Badge tone="accent">{changed} changed by you</Badge>}
        </button>
      </div>
      {open && (
        <div className="border-t border-line">
          {g.payees.map((p) => (
            <ReapplyPayee key={p.payee} group={g} payee={p} valueOf={valueOf} choose={choose} always={always(p.payee)} setAlways={(v) => setAlways(p.payee, v)} cats={cats} />
          ))}
        </div>
      )}
    </li>
  );
}

function ReapplyPayee({
  group: g,
  payee: p,
  valueOf,
  choose,
  always,
  setAlways,
  cats,
}: {
  group: EnrichGroup;
  payee: EnrichGroup['payees'][number];
  valueOf: (id: string) => string;
  choose: (ids: string[], value: string | undefined) => void;
  always: boolean;
  setAlways: (v: boolean) => void;
  cats: ReturnType<typeof useAppData>['cats'];
}) {
  const { accountName } = useAppData();
  const ids = p.rows.map((r) => r.id);
  const values = new Set(ids.map(valueOf));
  const all = values.size === 1 ? [...values][0]! : MIXED;
  const mine = all !== MIXED && all !== PROPOSED && all !== SKIP ? all : undefined;
  const direction = p.rows.every((r) => r.amount >= 0) ? 'in' : p.rows.every((r) => r.amount < 0) ? 'out' : undefined;
  const leading = (forAll: boolean) => [
    { value: PROPOSED, label: `As proposed: ${g.to ? cats.name(g.to) : 'uncategorised'}` },
    { value: SKIP, label: `Leave as it is: ${g.from ? cats.name(g.from) : 'uncategorised'}` },
    ...(forAll && all === MIXED ? [{ value: MIXED, label: 'Some of each', disabled: true }] : []),
  ];
  // How many payments the rule would match in all, once "always" is ticked.
  const [reach, setReach] = useState<number | null>(null);
  useEffect(() => {
    if (!always || !p.match) return setReach(null);
    let live = true;
    void api<{ count: number }>('/rules/preview', { body: { enabled: true, priority: 100, match: p.match, set: {} } })
      .then((r) => live && setReach(r.count))
      .catch(() => live && setReach(null));
    return () => {
      live = false;
    };
  }, [always, p.match]);
  return (
    <div className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{p.payee}</div>
          <div className="text-[12px] text-ink-3">
            {p.count} payment{p.count === 1 ? '' : 's'} · <Money value={p.amount} />
          </div>
        </div>
        {p.rows.length > 1 && (
          <label className="flex w-full items-center gap-2 sm:w-auto">
            <span className="shrink-0 text-[12px] text-ink-3">All {p.count}</span>
            <CategorySelect value={all} onChange={(v) => choose(ids, v)} allowEmpty={false} leading={leading(true)} direction={direction} className="h-8 w-full text-[12.5px] sm:w-72" ariaLabel={`All ${p.count} from ${p.payee}`} />
          </label>
        )}
      </div>
      {mine && p.match && (
        <div className="mt-1.5">
          <Checkbox checked={always} onChange={setAlways} label={`Always: a rule (${ruleWords(p.match)})${always && reach !== null ? `, which matches ${reach} payment${reach === 1 ? '' : 's'} in all` : ''}`} />
        </div>
      )}
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {p.rows.map((r) => (
          <li key={r.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[1fr_auto_18rem]">
            <div className="min-w-0 text-[12.5px]">
              <div className="truncate text-ink-2" title={r.description}>
                {r.description}
              </div>
              <div className="text-[12px] text-ink-3">
                {formatDate(r.date)} · {accountName(r.accountId)}
              </div>
            </div>
            <Money value={r.amount} className={cn('tabular text-[12.5px]', r.amount > 0 ? 'text-good-ink' : 'text-ink')} />
            <div className="col-span-2 sm:col-span-1">
              <CategorySelect value={valueOf(r.id)} onChange={(v) => choose([r.id], v)} allowEmpty={false} leading={leading(false)} direction={r.amount >= 0 ? 'in' : 'out'} className="h-8 w-full text-[12.5px]" ariaLabel={`${formatDate(r.date)} ${money(r.amount)}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CsvProfilesCard() {
  const { data } = useAppData();
  const del = useApiMutation((id: string) => api(`/csv-profiles/${id}`, { method: 'DELETE' }));
  if (!data.csvProfiles.length) return null;
  return (
    <Card title="Saved CSV layouts" padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {data.csvProfiles.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
            <span className="flex-1 font-medium text-ink">{p.name}</span>
            <span className="truncate text-ink-3">{p.headerSignature.slice(0, 5).join(', ')}</span>
            <button className="text-ink-3 hover:text-bad-ink" aria-label={`Delete ${p.name}`} onClick={() => del.mutate(p.id)}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** How a source of a job's figure is named on the page. */
function sourceName(s: TaxDocSource): string {
  const name =
    s.label === 'P60'
      ? 'P60'
      : s.kind === 'yours'
        ? 'Your figure'
        : s.hmrcRecords
          ? `HMRC’s record of ${s.hmrcRecords} payment${s.hmrcRecords === 1 ? '' : 's'}, ${s.label.replace(/^HMRC /, '')}`
          : s.label === 'the whole year'
            ? 'For the whole year'
            : s.label.charAt(0).toUpperCase() + s.label.slice(1);
  return `${name}${s.final && s.kind !== 'year' && s.kind !== 'yours' ? ' (the job has ended)' : ''}`;
}

function SourceDoc({ s }: { s: TaxDocSource }) {
  if (!s.importId) return null;
  return (
    <Link to={`/import/${s.importId}`} className="text-ink-3 hover:underline">
      {s.fileName ?? 'the document'}
    </Link>
  );
}

/** Settings → Tax documents: a tax year's figures by job, each value with the source that counts and the others. */
function TaxDocuments() {
  const toast = useToast();
  const { data } = useAppData();
  const [year, setYear] = useState('');
  const docs = useApi<TaxDocumentsResponse>(['tax-documents', year], `/tax-documents${year ? `?taxYear=${encodeURIComponent(year)}` : ''}`);
  const figures = useApi<Figure[]>(['figures'], '/figures');
  const [kind, setKind] = useState<Figure['kind']>('gross_pay');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [ty, setTy] = useState(taxYearOf(today()).label);
  const [payer, setPayer] = useState('');
  const [accountId, setAccountId] = useState('');
  const add = useApiMutation(
    () => api('/figures', { body: { kind, label: label || kind.replace(/_/g, ' '), amount: Number(amount), taxYear: ty, ...(payer ? { payer } : {}), ...(accountId ? { accountId } : {}) } }),
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Figure added' });
        setAmount('');
        setLabel('');
      },
    },
  );
  const del = useApiMutation((id: string) => api(`/figures/${id}`, { method: 'DELETE' }));
  const d = docs.data;
  const yearFigures = (figures.data ?? []).filter((f) => d && f.taxYear === d.taxYear.label);
  const accountName = (id: string | undefined) => (id ? (data.accounts.find((a) => a.id === id)?.name ?? id) : undefined);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-ink-2">Each job’s pay, tax and NI for the year, from the one source that counts, with the others that state it. Then the year’s other tax figures. Every value links to the document it came from.</p>
        {d && (
          <Select value={d.taxYear.label} onChange={(e) => setYear(e.target.value)} className="w-auto" aria-label="Tax year">
            {d.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        )}
      </div>
      {!d ? (
        <Loading />
      ) : (
        <>
          {d.jobs.map((job) => (
            <Card
              key={job.key}
              title={job.employer || 'An employer'}
              description={[
                job.payeReference ? `PAYE ${job.payeReference}` : '',
                job.payrollNumbers?.length ? `payroll no. ${job.payrollNumbers.join(', ')}` : '',
                job.startedOn ? `started ${formatDate(job.startedOn)}` : '',
                job.endedOn ? `ended ${formatDate(job.endedOn)}` : '',
                job.names.length > 1 ? `also called ${job.names.filter((n) => n !== job.employer).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              padded={false}
            >
              <div className="overflow-x-auto border-t border-line">
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>What</th>
                      <th className={tableClasses.th}>Counts, and other sources</th>
                      <th className={cn(tableClasses.th, 'hidden text-right sm:table-cell')}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.values.map((v) => (
                      <tr key={v.kind}>
                        <td className={cn(tableClasses.td, 'align-top sm:whitespace-nowrap')}>
                          {v.label}
                          {/* On a phone the amount goes under what it is. */}
                          <div className="mt-0.5 font-medium sm:hidden">
                            <Money value={v.chosen.amount} className="tabular" />
                          </div>
                        </td>
                        <td className={cn(tableClasses.td, 'align-top')}>
                          <div>
                            {sourceName(v.chosen)} <SourceDoc s={v.chosen} />
                          </div>
                          {v.others.map((o, i) => (
                            <div key={i} className="text-[12px] text-ink-3">
                              Also: {sourceName(o)}, <Money value={o.amount} className="tabular" /> <SourceDoc s={o} />
                            </div>
                          ))}
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'hidden align-top sm:table-cell')}>
                          <Money value={v.chosen.amount} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(job.payslips.length > 0 || job.hmrcPayments > 0) && (
                <div className="flex flex-col gap-1 border-t border-line px-5 py-3 text-[12.5px] text-ink-2">
                  {job.payslips.length > 0 && (
                    <div>
                      <span className="font-medium text-ink">
                        {job.payslips.length} payslip{job.payslips.length === 1 ? '' : 's'}
                      </span>
                      {job.payslips.some((p) => p.id) && <span className="text-ink-3"> ({job.payslips.filter((p) => p.id).length} kept in full)</span>}:{' '}
                      {job.payslips.map((p, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          {p.importId ? (
                            <Link to={`/import/${p.importId}`} className="hover:underline">
                              {p.period ?? formatDate(p.payDate)}
                            </Link>
                          ) : (
                            (p.period ?? formatDate(p.payDate))
                          )}
                          {p.taxCode && <span className="text-ink-3"> ({p.taxCode})</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {job.hmrcPayments > 0 && (
                    <div>
                      HMRC’s record of {job.hmrcPayments} payment{job.hmrcPayments === 1 ? '' : 's'} this year. <Link to="/tax/pay" className="text-accent hover:underline">Pay tab</Link>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
          {d.other.length > 0 && (
            <Card title="Other tax figures" description="Interest, dividends, pension statements and the rest, as their documents give them." padded={false}>
              <div className="overflow-x-auto border-t border-line">
                <table className={tableClasses.table}>
                  <tbody>
                    {d.other.map((group) => (
                      <Fragment key={group.kind}>
                        <tr className="bg-panel-2">
                          <td className={cn(tableClasses.td, 'font-medium')}>{group.label}</td>
                          <td className={cn(tableClasses.td, 'hidden sm:table-cell')} />
                          <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                            <Money value={group.total} />
                          </td>
                          <td className={tableClasses.td} />
                        </tr>
                        {group.figures.map((f) => (
                          <tr key={f.id}>
                            <td className={tableClasses.td}>
                              {f.label}
                              {(f.payer ?? accountName(f.accountId)) && <div className="text-[12px] text-ink-3">{f.payer ?? accountName(f.accountId)}</div>}
                            </td>
                            <td className={cn(tableClasses.td, 'hidden text-[12.5px] text-ink-3 sm:table-cell')}>
                              {f.importId ? (
                                <Link to={`/import/${f.importId}`} className="hover:underline">
                                  {f.fileName ?? 'the document'}
                                </Link>
                              ) : (
                                'your figure'
                              )}
                            </td>
                            <td className={cn(tableClasses.td, tableClasses.num)}>
                              <Money value={f.amount} />
                            </td>
                            <td className={cn(tableClasses.td, 'text-right')}>
                              <button className="text-ink-3 hover:text-bad-ink" aria-label="Delete figure" onClick={() => confirm('Delete this figure?') && del.mutate(f.id)}>
                                <Trash2 className="size-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {!d.jobs.length && !d.other.length && <Card><div className="text-[13px] text-ink-3">No tax figures for {d.taxYear.label} yet.</div></Card>}
          {yearFigures.length > 0 && (
            <details className="rounded-xl border border-line bg-panel">
              <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-2">Every figure stored for {d.taxYear.label} ({yearFigures.length})</summary>
              <div className="overflow-x-auto border-t border-line">
                <table className={tableClasses.table}>
                  <tbody>
                    {yearFigures.map((f) => (
                      <tr key={f.id}>
                        <td className={tableClasses.td}>
                          {f.label}
                          <div className="text-[12px] text-ink-3">
                            {f.kind.replace(/_/g, ' ')}
                            {f.periodEnd ? ` · ${formatDate(f.periodEnd)}` : ''}
                            <span className="sm:hidden">{(f.payer ?? accountName(f.accountId)) ? ` · ${f.payer ?? accountName(f.accountId)}` : ''}</span>
                          </div>
                        </td>
                        <td className={cn(tableClasses.td, 'hidden sm:table-cell')}>{f.payer ?? accountName(f.accountId) ?? '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={f.amount} />
                        </td>
                        <td className={cn(tableClasses.td, 'text-right')}>
                          <button className="text-ink-3 hover:text-bad-ink" aria-label="Delete figure" onClick={() => confirm('Delete this figure?') && del.mutate(f.id)}>
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
      <Card title="Add a figure by hand" description="For documents you only have on paper, such as a P60 or an annual interest statement. Uploading the document extracts these automatically.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="What">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Figure['kind'])}>
              {FIGURE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label as on the document">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Pay" />
          </Field>
          <Field label="Amount">
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Tax year">
            <Input value={ty} onChange={(e) => setTy(e.target.value)} placeholder="2025/26" />
          </Field>
          <Field label="Payer (employer, bank…)">
            <Input value={payer} onChange={(e) => setPayer(e.target.value)} />
          </Field>
          <Field label="Account (optional)">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {add.error && <Callout tone="bad" className="mt-3">{add.error.message}</Callout>}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={add.isPending} disabled={!amount || !/^\d{4}\/\d{2}$/.test(ty)} onClick={() => add.mutate(undefined)}>
            Add figure
          </Button>
        </div>
      </Card>
    </div>
  );
}

function DataAndGit() {
  const { data } = useAppData();
  const toast = useToast();
  const sys = useApi<SystemResponse>(['system'], '/system');
  const log = useApi<{ hash: string; date: string; subject: string }[]>(['git-log'], '/git/log?limit=25');
  const [s, setS] = useState<SettingsT>(data.settings);
  const save = useApiMutation((next: SettingsT) => api('/settings', { method: 'PUT', body: next as unknown as Record<string, unknown> }), { onSuccess: () => toast({ tone: 'good', text: 'Saved' }) });
  const commit = useApiMutation(() => api('/git/commit', { method: 'POST' }), { onSuccess: () => toast({ tone: 'good', text: 'Committed' }) });
  const g = sys.data?.git;
  const setGit = (patch: Partial<SettingsT['git']>) => {
    const next = { ...s, git: { ...s.git, ...patch } };
    setS(next);
    save.mutate(next);
  };
  return (
    <div className="flex flex-col gap-5">
      <Card title="Version history (git)" description="Every change to your data becomes a commit, so any mistake can be undone and every number has a history.">
        {g && !g.enabled && <Callout tone="neutral" className="mb-3">This data directory is not committed to git (demo data, or not inside a repository).</Callout>}
        <Switch checked={s.git.autoCommit} onChange={(v) => setGit({ autoCommit: v })} label="Commit changes automatically" description="One commit per import or edit, touching only the data directory" />
        <Switch checked={s.git.trackDocuments} onChange={(v) => setGit({ trackDocuments: v })} label="Keep original documents in git" description="Statements and screenshots under data/documents are committed too (roughly 0.1–1 MB each)" />
        {g?.enabled && (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-ink-2">
            <GitCommitHorizontal className="size-4 text-ink-3" />
            <span>
              Branch <code>{g.branch}</code> · {g.dirty ? `${g.dirty} uncommitted change(s)` : 'clean'}
              {g.remote ? ` · ${g.ahead ?? 0} ahead of ${g.remote}` : ' · no remote'}
            </span>
            {g.dirty > 0 && (
              <Button size="sm" loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
                Commit now
              </Button>
            )}
          </div>
        )}
        {g?.lastError && <Callout tone="bad" className="mt-3">{g.lastError}</Callout>}
      </Card>
      {log.data && log.data.length > 0 && (
        <Card title="Recent data commits" padded={false}>
          <ul className="divide-y divide-line border-t border-line">
            {log.data.map((c) => (
              <li key={c.hash} className="flex items-center gap-3 px-5 py-2 text-[13px]">
                <code className="text-ink-3">{c.hash}</code>
                <span className="min-w-0 flex-1 truncate text-ink">{c.subject}</span>
                <span className="text-ink-3">{timeAgo(c.date)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Where things live">
        <KeyValue
          items={[
            ['Data', <code>{sys.data?.dataDir}</code>],
            ['Inbox folder', <code>{sys.data?.inboxDir}</code>],
            ['Work area (unreviewed uploads)', <code>{sys.data?.workDir}</code>],
            ['Data format', `v${sys.data?.formatVersion ?? '?'} · see docs/DATA_FORMAT.md`],
            ['App version', sys.data?.version],
            ['Stored', sys.data ? `${sys.data.counts.accounts} accounts, ${sys.data.counts.transactions.toLocaleString()} transactions, ${sys.data.counts.balances} balances, ${sys.data.counts.figures} tax figures, ${sys.data.counts.imports} imports` : ''],
            ['Signed in as', sys.data?.auth.user ? `${sys.data.auth.user}${sys.data.auth.method === 'oidc' ? ' (with JEMEDIA)' : ''}` : (sys.data?.auth.configured ? '—' : 'local access (no login configured)')],
          ]}
        />
      </Card>
      <InstitutionsCard />
    </div>
  );
}

function InstitutionsCard() {
  const { data } = useAppData();
  const update = useApiMutation((v: { id: string; fscsGroup: string }) => api(`/institutions/${v.id}`, { method: 'PATCH', body: { fscsGroup: v.fscsGroup || null } }));
  if (!data.institutions.length) return null;
  return (
    <Card title="Providers and FSCS groups" description="Brands that share a banking licence share one FSCS limit. Give them the same group name." padded={false}>
      <table className={tableClasses.table}>
        <tbody>
          {data.institutions.map((i) => (
            <tr key={i.id}>
              <td className={tableClasses.td}>{i.name}</td>
              <td className={cn(tableClasses.td, 'text-ink-3')}>{i.kind.replace(/_/g, ' ')}</td>
              <td className={cn(tableClasses.td, 'w-56')}>
                <Input defaultValue={i.fscsGroup ?? ''} placeholder={i.id} className="h-8" onBlur={(e) => e.target.value !== (i.fscsGroup ?? '') && update.mutate({ id: i.id, fscsGroup: e.target.value.trim() })} aria-label={`FSCS group for ${i.name}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Each link between two of your accounts, with whether the money carried over adds up (docs/FORMULAS.md §9). */
function Handovers({ list }: { list: Handover[] }) {
  return (
    <Card title="Accounts that carry on from another" description="An account that carries on from another under the same number starts from what the other ended with. Where it does not, a statement or a row is missing on one side.">
      <ul className="flex flex-col divide-y divide-line text-[13px]">
        {list.map((x) => (
          <li key={x.newer.accountId} className="py-2">
            <div>
              <Link to={`/accounts/${x.newer.accountId}`} className="font-medium text-accent hover:underline">
                {x.newer.name}
              </Link>{' '}
              <span className="text-ink-2">carries on from</span>{' '}
              <Link to={`/accounts/${x.older.accountId}`} className="font-medium text-accent hover:underline">
                {x.older.name}
              </Link>{' '}
              <span className="text-ink-2">from {formatDate(x.from)}</span>
            </div>
            <div className="text-ink-3">
              <HandoverText h={x} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Health() {
  const q = useApi<DataHealthResponse>(['data-health'], '/data-health');
  const h = q.data;
  if (!h) return <Loading />;
  const clean =
    !h.issues.length && !h.gaps.length && !h.noBalance.length && !h.stale.length && !h.coverageGaps?.some((g) => g.evidence.status === 'unexplained') && !h.handovers?.some((x) => x.status === 'unexplained') && !h.closedHolding?.length;
  const cov = h.coverage;
  return (
    <div className="flex flex-col gap-5">
      {clean && <Callout tone="good" title="All good">No problems found in your data.</Callout>}
      {cov && cov.accounts.length > 0 && (
        <Card
          title="Coverage"
          description="Which months each account has transaction data for. Averages, projections and signals use only days every account covers; a ✓ marks a month that is complete for all of them."
          padded={false}
        >
          <div className="px-5 py-3">
            <CoverageGrid cov={cov} />
          </div>
        </Card>
      )}
      <CoverageGaps gaps={h.coverageGaps ?? []} confirmations={h.confirmations ?? []} gridFrom={cov?.months[0] ? `${cov.months[0]}-01` : undefined} openTaxYear={h.openTaxYear} />
      {h.issues.length > 0 && (
        <Card title="Problems in the data files" description="Records that don’t match the format are kept untouched and ignored until fixed.">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {h.issues.map((i, n) => (
              <li key={n} className="flex gap-2">
                <StatusBadge status={i.severity === 'error' ? 'bad' : 'warn'}>{i.severity}</StatusBadge>
                <code className="text-ink-2">{i.file}</code>
                <span className="text-ink-3">{i.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {h.gaps.length > 0 && (
        <Card title="Gaps between statements" description="Balances that the transactions in between don’t explain, usually a missing statement.">
          <ul className="flex flex-col gap-1 text-[13px]">
            {h.gaps.map((g) => (
              <li key={g.accountId + g.from}>
                <Link to={`/accounts/${g.accountId}`} className="font-medium text-accent hover:underline">
                  {g.name}
                </Link>{' '}
                <span className="text-ink-3">
                  {formatDate(g.from)} → {formatDate(g.to)}: <span className="sensitive">{money(g.difference)}</span> unexplained
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(h.handovers?.length ?? 0) > 0 && <Handovers list={h.handovers!} />}
      {(h.closedHolding?.length ?? 0) > 0 && (
        <Card title="Closed with money still in them" description="Accounts closed while their balance was not £0, with no account carrying on from them: nothing shows the money leaving, so it drops out of your estate the day after.">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {h.closedHolding!.map((c) => (
              <li key={c.accountId}>
                <Link to={`/accounts/${c.accountId}`} className="font-medium text-accent hover:underline">
                  {c.name}
                </Link>{' '}
                <span className="text-ink-3">
                  closed on {formatDate(c.closedOn)} {c.balance > 0 ? 'holding' : 'owing'} <span className="sensitive">{money(Math.abs(c.balance))}</span>
                  {c.estimated ? ' (estimated: no statement balance to rest on)' : ''}. Record the money leaving (its closing statement), link the account that carries on from it on that account’s page, or correct its closing date.
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {h.noBalance.length > 0 && (
        <Card title="Accounts without a known balance" description="They have transactions but no statement balance or screenshot, so their balance is estimated from zero.">
          <ul className="flex flex-col gap-1 text-[13px]">
            {h.noBalance.map((a) => (
              <li key={a.accountId}>
                <Link to={`/accounts/${a.accountId}`} className="text-accent hover:underline">
                  {a.name}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {h.stale.length > 0 && (
        <Card title="Stale accounts">
          <ul className="flex flex-col gap-1 text-[13px]">
            {h.stale.map((a) => (
              <li key={a.accountId}>
                <Link to={`/accounts/${a.accountId}`} className="text-accent hover:underline">
                  {a.name}
                </Link>{' '}
                <span className="text-ink-3">last data {a.days} days ago</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Uncategorised">
        <div className="text-[13px] text-ink-2">
          {h.uncategorised} spending or income transactions in the last year have no category.{' '}
          {h.uncategorised > 0 && (
            <Link to="/transactions?categories=uncategorised&period=12m" className="text-accent hover:underline">
              Categorise them
            </Link>
          )}
        </div>
      </Card>
      {h.fscs.length > 0 && (
        <Card title="FSCS exposure" description="Cash held per banking licence against the deposit protection limit" padded={false}>
          <table className={tableClasses.table}>
            <tbody>
              {h.fscs.map((f) => (
                <tr key={f.group}>
                  <td className={tableClasses.td}>{f.institutions.join(' / ')}</td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={f.total} decimals={0} />
                  </td>
                  <td className={tableClasses.td}>{f.over ? <StatusBadge status="warn">over {money(f.limit, { decimals: 0 })}</StatusBadge> : <span className="text-ink-3">within limit</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <div>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void q.refetch()}>
          Re-check
        </Button>
      </div>
    </div>
  );
}

const SCOPE_NAMES: Record<string, string> = { read: 'Read', imports: 'Import upkeep', records: 'Agent records', jobs: 'Jobs' };
const whenTime = (iso: string) => `${formatDate(iso.slice(0, 10))} ${iso.slice(11, 16)}`;

/** Tokens for agents (docs/DEPLOY.md, "Agent access"): made, seen and revoked only here. */
function AgentAccess() {
  const toast = useToast();
  const q = useApi<TokensResponse>(['tokens'], '/tokens');
  const [name, setName] = useState('Claude Code on P360');
  const [scopes, setScopes] = useState<string[]>(['imports']);
  const [days, setDays] = useState('90');
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const create = useApiMutation(() => api<{ token: string; view: { name: string } }>('/tokens', { body: { name, scopes, days: Number(days) } }), { onSuccess: (r) => setMade({ token: r.token, name: r.view.name }) });
  const revoke = useApiMutation((id: string) => api(`/tokens/${id}/revoke`, { method: 'POST' }), { onSuccess: () => toast({ tone: 'good', text: 'Revoked: the token stops working now' }) });
  const d = q.data;
  const toggle = (id: string, on: boolean) => setScopes((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)));
  const copy = () => {
    if (!made) return;
    navigator.clipboard.writeText(made.token).then(
      () => toast({ tone: 'good', text: 'Copied' }),
      () => toast({ tone: 'bad', text: 'Could not copy: select the token and copy it' }),
    );
  };
  if (!d) return q.error ? <Callout tone="bad">{q.error.message}</Callout> : <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <Card title="Agent access" description="A token lets an agent, such as a Claude Code session on this server, use the app’s API without signing in. Only a hash of it is kept, in the work area, never in your data or git, and every use is logged.">
        <p className="mb-4 text-[13px] text-ink-2">
          Every token can read everything, and change only what you tick. No token can commit, dismiss or discard an import, change transactions, balances, figures, accounts or settings, or make and revoke tokens.
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Expires after">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex flex-col gap-2 text-[13px]">
          {d.scopes.map((s) => (
            <Checkbox key={s.id} checked={s.id === 'read' || scopes.includes(s.id)} disabled={s.id === 'read'} onChange={(v) => toggle(s.id, v)} label={s.label} />
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" icon={<KeyRound className="size-4" />} loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate(undefined)}>
            Create token
          </Button>
        </div>
        {create.error && <Callout tone="bad" className="mt-3">{create.error.message}</Callout>}
      </Card>
      <Dialog
        open={made !== null}
        onOpenChange={(o) => !o && setMade(null)}
        title="Your new token"
        description={made?.name}
        footer={
          <Button variant="primary" onClick={() => setMade(null)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-[13px] text-ink-2">
          <p>This is the only time it is shown. If it is lost, revoke it and make another.</p>
          <code className="block rounded-lg bg-panel-2 p-3 font-mono text-[12px] break-all text-ink select-all">{made?.token}</code>
          <div>
            <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>
              Copy
            </Button>
          </div>
          <p>
            For agents on P360, keep it where <code>npm run api</code> looks. Run this, paste the token, press Enter, then Ctrl-D:
          </p>
          <code className="block rounded-lg bg-panel-2 p-3 font-mono text-[12px] break-all text-ink">mkdir -p ~/.config/finance && (umask 077; cat &gt; ~/.config/finance/token)</code>
        </div>
      </Dialog>
      <Card title="Tokens" padded={false}>
        {d.tokens.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">No tokens yet.</p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <Sorted rows={d.tokens} columns={{ name: { value: (t) => t.name }, can: { value: (t) => t.scopes.map((s) => SCOPE_NAMES[s] ?? s).join(', ') }, expires: { value: (t) => t.expiresAt }, used: { value: (t) => t.lastUsedAt, first: 'desc' } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Name" sort={sortProps('name')} />
                      <SortHeader label="Can" sort={sortProps('can')} />
                      <SortHeader label="Expires" sort={sortProps('expires')} />
                      <SortHeader label="Last used" sort={sortProps('used')} />
                      <th className={tableClasses.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id}>
                        <td className={tableClasses.td}>{t.name}</td>
                        <td className={tableClasses.td}>{t.scopes.map((s) => SCOPE_NAMES[s] ?? s).join(', ')}</td>
                        <td className={tableClasses.td}>{formatDate(t.expiresAt.slice(0, 10))}</td>
                        <td className={tableClasses.td}>{t.lastUsedAt ? `${whenTime(t.lastUsedAt)}${t.lastUsedFrom ? ` from ${t.lastUsedFrom}` : ''}` : 'never'}</td>
                        <td className={cn(tableClasses.td, 'text-right')}>
                          {t.status === 'active' ? (
                            <Button size="sm" loading={revoke.isPending && revoke.variables === t.id} onClick={() => revoke.mutate(t.id)}>
                              Revoke
                            </Button>
                          ) : (
                            <Badge tone="muted">{t.status === 'revoked' ? 'Revoked' : 'Expired'}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        )}
      </Card>
      <Card title="Recent uses" description={<>The latest 30 requests made with a token, including refused ones. Each agent’s activity, request by request: <SessionsLink>Agent sessions</SessionsLink>.</>} padded={false}>
        {d.uses.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">No token has been used yet.</p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <Sorted rows={d.uses} columns={{ when: { value: (u) => u.at, first: 'desc' }, token: { value: (u) => u.name }, request: { value: (u) => `${u.path} ${u.method}` }, answer: { value: (u) => u.status }, from: { value: (u) => u.from } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="When" sort={sortProps('when')} />
                      <SortHeader label="Token" sort={sortProps('token')} />
                      <SortHeader label="Request" sort={sortProps('request')} />
                      <SortHeader label="Answer" sort={sortProps('answer')} />
                      <SortHeader label="From" sort={sortProps('from')} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u, i) => (
                      <tr key={`${u.at}-${i}`}>
                        <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{whenTime(u.at)}</td>
                        <td className={tableClasses.td}>{u.name}</td>
                        <td className={cn(tableClasses.td, 'font-mono text-[12px]')}>
                          {u.method} {u.path}
                        </td>
                        <td className={tableClasses.td}>{u.status < 400 ? <StatusBadge status="good">{u.status}</StatusBadge> : <StatusBadge status="bad">{u.status}</StatusBadge>}</td>
                        <td className={tableClasses.td}>{u.from}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const section = ((location.hash.slice(1) || 'profile') as Section) ?? 'profile';
  const tabs: { value: Section; label: string }[] = [
    { value: 'profile', label: 'Profile' },
    { value: 'extraction', label: 'Models & import' },
    { value: 'categories', label: 'Categories' },
    { value: 'rules', label: 'Rules' },
    { value: 'tax-documents', label: 'Tax documents' },
    { value: 'data', label: 'Data & git' },
    { value: 'access', label: 'Agent access' },
    { value: 'audit', label: 'Audit log' },
    { value: 'health', label: 'Data health' },
  ];
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tabs.some((t) => t.value === section) ? section : 'profile'} onChange={(v) => navigate({ hash: v }, { replace: true })} tabs={tabs} />
      {section === 'profile' && <ProfileForm />}
      {section === 'extraction' && <ExtractionForm />}
      {section === 'categories' && <CategoriesEditor />}
      {section === 'rules' && <RulesEditor />}
      {section === 'tax-documents' && <TaxDocuments />}
      {section === 'data' && <DataAndGit />}
      {section === 'access' && <AgentAccess />}
      {section === 'audit' && <AuditLog />}
      {section === 'health' && <Health />}
    </div>
  );
}
