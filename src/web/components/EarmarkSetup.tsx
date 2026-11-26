// Set aside's setup, by hand (docs/FORMULAS.md §21): which accounts are everyday and which hold
// set-aside money, the pots, and their rules in order, with the figure they give shown as you go.
// Agents propose the same changes as `set_earmarks`.

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EarmarksResponse } from '../../shared/api';
import { today } from '../../shared/dates';
import { EARMARK_EFFECTS, type EarmarkEffect, type EarmarkRule, type EarmarkSetup, type Earmarks } from '../../shared/schema';
import { api, useApiMutation, type Json } from '../lib/api';
import { useAppData } from '../lib/data';
import { EFFECT_WORDS } from '../lib/earmarks';
import { cn, money, plural } from '../lib/format';
import { CategorySelect } from './TransactionList';
import { Button, Card, Checkbox, Dialog, ErrorNote, Field, IconButton, Input, NumberInput, Select, useToast } from './ui';

type Pot = EarmarkSetup['pots'][number];
type Role = 'none' | 'everyday' | 'set-aside';

const slug = (s: string, taken: readonly string[]) => {
  const base =
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'pot';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
};

const newRule = (taken: readonly string[]): EarmarkRule => ({ id: slug('rule', taken), name: 'New rule', effect: 'source', text: { field: 'description', op: 'contains', value: '', caseSensitive: false }, direction: 'in' });
const newPot = (taken: readonly string[]): Pot => ({ id: slug('pot', taken), name: 'Pot', start: today(), opening: 0, rules: [] });

/** What a setup's draft is, from the one in use (or a first one). */
function draftOf(e: Earmarks | null): EarmarkSetup {
  if (!e) return { everyday: [], setAside: [], pots: [newPot([])] };
  return { everyday: e.everyday, setAside: e.setAside, pots: e.pots.map(({ checks: _c, ...p }) => p) };
}

/** A setup as it can be sent: a rule with no words has no text condition. */
function cleaned(d: EarmarkSetup): EarmarkSetup {
  return {
    ...d,
    pots: d.pots.map((p) => ({
      ...p,
      rules: p.rules.map((r) => {
        const { text, ...rest } = r;
        return text && text.value.trim() ? { ...rest, text: { ...text, value: text.value.trim() } } : rest;
      }),
    })),
  };
}

export function EarmarkSetupForm({ current, onDone }: { current: Earmarks | null; onDone: () => void }) {
  const { data, accountName } = useAppData();
  const toast = useToast();
  const [draft, setDraft] = useState<EarmarkSetup>(() => draftOf(current));
  const [preview, setPreview] = useState<EarmarksResponse | null>(null);
  const [removing, setRemoving] = useState(false);
  const body = useMemo(() => ({ setup: cleaned(draft) }), [draft]);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!draft.everyday.length) return;
    const timer = setTimeout(() => {
      api<EarmarksResponse>('/earmarks/setup/preview', { body: body as unknown as Json })
        .then(setPreview)
        .catch((e: Error) => setPreview({ setup: null, result: null, problems: [e.message] }));
    }, 400);
    return () => clearTimeout(timer);
    // `key` stands for the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const save = useApiMutation(() => api('/earmarks/setup', { method: 'PUT', body: { ...body, was: current?.updatedAt ?? null } as unknown as Json }), {
    onSuccess: () => {
      toast({ tone: 'good', text: current ? 'Set aside changed' : 'Set aside set up' });
      onDone();
    },
  });
  const remove = useApiMutation(() => api('/earmarks', { method: 'DELETE' }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Set aside removed' });
      onDone();
    },
  });

  const roleOf = (id: string): Role => (draft.everyday.includes(id) ? 'everyday' : draft.setAside.includes(id) ? 'set-aside' : 'none');
  const setRole = (id: string, role: Role) =>
    setDraft({
      ...draft,
      everyday: role === 'everyday' ? [...draft.everyday.filter((x) => x !== id), id] : draft.everyday.filter((x) => x !== id),
      setAside: role === 'set-aside' ? [...draft.setAside.filter((x) => x !== id), id] : draft.setAside.filter((x) => x !== id),
    });
  const setPot = (i: number, p: Pot) => setDraft({ ...draft, pots: draft.pots.map((x, j) => (j === i ? p : x)) });
  // Accounts that hold money you could spend or keep aside, open ones first.
  const accounts = data.accounts
    .filter((a) => ['current', 'savings', 'credit_card', 'cash_isa', 'premium_bonds', 'loan', 'other_asset', 'other_liability'].includes(a.type) || draft.everyday.includes(a.id) || draft.setAside.includes(a.id))
    .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.name.localeCompare(b.name));
  // What each rule catches in the preview: payments and their total.
  const caught = new Map<string, { count: number; total: number }>();
  // Only the part a rule decides: a limited payment's rest (your own money) is not what it caught.
  const effectOf = new Map(draft.pots.flatMap((p) => p.rules.map((x) => [`${p.id}:${x.id}`, x.effect] as const)));
  for (const pot of preview?.result?.pots ?? []) {
    for (const line of pot.lines) {
      for (const row of line.rows) {
        if (!row.ruleId || effectOf.get(`${pot.id}:${row.ruleId}`) !== line.effect) continue;
        const k = `${pot.id}:${row.ruleId}`;
        const c = caught.get(k) ?? { count: 0, total: 0 };
        caught.set(k, { count: c.count + 1, total: Math.round((c.total + row.counted) * 100) / 100 });
      }
    }
  }
  const r = preview?.result;
  const setAside = r ? r.pots.reduce((s, p) => s + Math.round(p.setAside * 100), 0) / 100 : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Accounts" description="Everyday: where your money and the pots’ mix (current accounts, and the cards you pay from them). Set aside: everything in them is set aside, your own money moved in included.">
          <ul className="grid gap-1.5 text-[13.5px]">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3">
                <span className={cn('min-w-0 truncate', a.status === 'closed' ? 'text-ink-3' : 'text-ink')}>
                  {a.name}
                  {a.status === 'closed' && ' (closed)'}
                </span>
                <Select className="w-40 shrink-0" value={roleOf(a.id)} onChange={(e) => setRole(a.id, e.target.value as Role)} aria-label={`${a.name}: counted as`}>
                  <option value="none">Not counted</option>
                  <option value="everyday">Everyday</option>
                  <option value="set-aside">Set aside</option>
                </Select>
              </li>
            ))}
          </ul>
        </Card>

        {draft.pots.map((pot, i) => (
          <Card
            key={i}
            title={pot.name || 'Pot'}
            actions={
              draft.pots.length > 1 ? (
                <IconButton label="Remove this pot" onClick={() => setDraft({ ...draft, pots: draft.pots.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4" />
                </IconButton>
              ) : undefined
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input value={pot.name} maxLength={60} onChange={(e) => setPot(i, { ...pot, name: e.target.value, ...(current?.pots.some((p) => p.id === pot.id) ? {} : { id: slug(e.target.value, draft.pots.filter((_, j) => j !== i).map((p) => p.id)) }) })} />
              </Field>
              <Field label="What it’s for" hint="Optional.">
                <Input value={pot.purpose ?? ''} maxLength={500} onChange={(e) => setPot(i, { ...pot, ...(e.target.value ? { purpose: e.target.value } : { purpose: undefined }) })} />
              </Field>
              <Field label="Counted from" hint="Payments from this day count.">
                <Input type="date" value={pot.start} max={today()} onChange={(e) => e.target.value && setPot(i, { ...pot, start: e.target.value })} />
              </Field>
              <Field label="Set aside at the start" hint="In the everyday accounts, that morning. Negative: the pot owed you.">
                <NumberInput signed value={pot.opening} onValue={(v) => setPot(i, { ...pot, opening: v ?? 0 })} />
              </Field>
            </div>
            <div className="mt-4">
              <div className="mb-1 text-[13px] font-medium text-ink">Rules, in order: the first that fits a payment decides</div>
              <p className="mb-2 text-[12.5px] text-ink-3">Payments no rule fits are your own money; money to or from a set-aside account is put back into, or borrowed from, the pot.</p>
              <ol className="grid gap-3">
                {pot.rules.map((rule, k) => (
                  <RuleEditor
                    key={k}
                    rule={rule}
                    sources={pot.rules.filter((x) => x.effect === 'source' && x.id !== rule.id)}
                    caught={caught.get(`${pot.id}:${rule.id}`)}
                    onChange={(next) => setPot(i, { ...pot, rules: pot.rules.map((x, j) => (j === k ? next : x)) })}
                    onMove={(d) => {
                      const rules = [...pot.rules];
                      const [moved] = rules.splice(k, 1);
                      rules.splice(k + d, 0, moved!);
                      setPot(i, { ...pot, rules });
                    }}
                    onRemove={() => setPot(i, { ...pot, rules: pot.rules.filter((_, j) => j !== k).map((x) => (x.limitTo ? { ...x, limitTo: x.limitTo.filter((id) => id !== rule.id) } : x)).map((x) => (x.limitTo && !x.limitTo.length ? (({ limitTo: _l, ...y }) => y)(x) : x)) })}
                    first={k === 0}
                    last={k === pot.rules.length - 1}
                    accountName={accountName}
                  />
                ))}
              </ol>
              <Button size="sm" className="mt-3" icon={<Plus className="size-4" />} onClick={() => setPot(i, { ...pot, rules: [...pot.rules, newRule(pot.rules.map((x) => x.id))] })}>
                Add a rule
              </Button>
            </div>
          </Card>
        ))}
        <div>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setDraft({ ...draft, pots: [...draft.pots, newPot(draft.pots.map((p) => p.id))] })}>
            Add another pot
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:sticky lg:top-4">
        <Card title="With these settings" description="Not saved yet: worked out as you change them.">
          {!draft.everyday.length ? (
            <p className="text-[13px] text-ink-3">Choose your everyday accounts first.</p>
          ) : preview?.problems.length ? (
            <p className="text-[13px] text-bad-ink">{preview.problems[0]}</p>
          ) : r ? (
            <div className="grid gap-1 text-[13.5px]">
              <div className="flex justify-between">
                <span className="text-ink-3">Spendable</span>
                <span className="sensitive font-semibold text-ink">{money(r.spendable)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">{setAside !== null && setAside < 0 ? 'You’ve covered' : 'Set aside'}</span>
                <span className="sensitive text-ink">{money(Math.abs(setAside ?? 0))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">To check</span>
                <span className="text-ink">{r.toCheck.length}</span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">Working it out…</p>
          )}
        </Card>
        {save.error && <ErrorNote error={save.error} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={save.isPending} disabled={!draft.everyday.length || !draft.pots.length} onClick={() => save.mutate()}>
            {current ? 'Save changes' : 'Set it up'}
          </Button>
          <Button onClick={onDone}>Cancel</Button>
          {current && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(true)}>
              Remove set aside
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove set aside?"
        description="Its setup, your decisions and checks go; nothing else in your data changes. Your data’s history keeps them, so it can be brought back."
        footer={
          <Button variant="primary" loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove it
          </Button>
        }
      >
        {remove.error ? <ErrorNote error={remove.error} /> : <p className="text-[13.5px] text-ink-2">The page, the Overview card and the drawer’s section stop showing.</p>}
      </Dialog>
    </div>
  );
}

function RuleEditor({
  rule,
  sources,
  caught,
  onChange,
  onMove,
  onRemove,
  first,
  last,
  accountName,
}: {
  rule: EarmarkRule;
  sources: EarmarkRule[];
  caught: { count: number; total: number } | undefined;
  onChange: (r: EarmarkRule) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
  accountName: (id: string) => string;
}) {
  const { data } = useAppData();
  const set = (patch: Partial<EarmarkRule>) => {
    const next: Record<string, unknown> = { ...rule, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    onChange(next as EarmarkRule);
  };
  const text = rule.text ?? { field: 'description' as const, op: 'contains' as const, value: '', caseSensitive: false };
  const portionKind = !rule.portion ? 'all' : 'percent' in rule.portion ? 'percent' : 'upTo';
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
        <Field label="Name">
          <Input value={rule.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Counts as">
          <Select value={rule.effect} onChange={(e) => set({ effect: e.target.value as EarmarkEffect, ...(e.target.value !== 'use' ? { limitTo: undefined } : {}) })}>
            {EARMARK_EFFECTS.map((e) => (
              <option key={e} value={e}>
                {EFFECT_WORDS[e]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-1">
          <IconButton label="Move up" disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton label="Move down" disabled={last} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" />
          </IconButton>
          <IconButton label="Remove this rule" onClick={onRemove}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)]">
        <Field label="Words in">
          <Select value={text.field} onChange={(e) => set({ text: { ...text, field: e.target.value as 'description' | 'payee' } })}>
            <option value="description">Description</option>
            <option value="payee">Payee</option>
          </Select>
        </Field>
        <Field label="That">
          <Select value={text.op} onChange={(e) => set({ text: { ...text, op: e.target.value as typeof text.op } })}>
            <option value="contains">contain</option>
            <option value="startsWith">start with</option>
            <option value="endsWith">end with</option>
            <option value="equals">are exactly</option>
            <option value="regex">match the pattern</option>
          </Select>
        </Field>
        <Field label="Words" hint="Leave empty to match by the other conditions only.">
          <Input value={text.value} onChange={(e) => set({ text: { ...text, value: e.target.value } })} />
        </Field>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label="Money">
          <Select value={rule.direction ?? ''} onChange={(e) => set({ direction: (e.target.value || undefined) as 'in' | 'out' | undefined })}>
            <option value="">In or out</option>
            <option value="in">In</option>
            <option value="out">Out</option>
          </Select>
        </Field>
        <Field label="Category">
          <CategorySelect value={rule.category} placeholder="Any category" onChange={(v) => set({ category: v })} />
        </Field>
        <Field label="To or from your account">
          <Select value={rule.counterpartyAccountId ?? ''} onChange={(e) => set({ counterpartyAccountId: e.target.value || undefined })}>
            <option value="">Any</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountName(a.id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="At least">
          <NumberInput value={rule.amountMin} onValue={(v) => set({ amountMin: v === undefined || v <= 0 ? undefined : v })} />
        </Field>
        <Field label="At most">
          <NumberInput value={rule.amountMax} onValue={(v) => set({ amountMax: v === undefined || v <= 0 ? undefined : v })} />
        </Field>
        <Field label="Counts">
          <div className="flex gap-2">
            <Select value={portionKind} onChange={(e) => set({ portion: e.target.value === 'all' ? undefined : e.target.value === 'percent' ? { percent: 30 } : { upTo: 100 } })}>
              <option value="all">All of it</option>
              <option value="percent">A share (%)</option>
              <option value="upTo">Up to an amount</option>
            </Select>
            {rule.portion && 'percent' in rule.portion && <NumberInput className="w-20" value={rule.portion.percent} onValue={(v) => set({ portion: { percent: Math.min(100, Math.max(0.01, v ?? 1)) } })} />}
            {rule.portion && 'upTo' in rule.portion && <NumberInput className="w-24" value={rule.portion.upTo} onValue={(v) => set({ portion: { upTo: Math.max(0.01, v ?? 1) } })} />}
          </div>
        </Field>
      </div>
      {rule.effect === 'use' && sources.length > 0 && (
        <div className="mt-2 text-[13px]">
          <div className="text-ink-3">Only up to what these brought in (optional):</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {sources.map((s) => (
              <Checkbox
                key={s.id}
                label={s.name}
                checked={Boolean(rule.limitTo?.includes(s.id))}
                onChange={(on) => {
                  const next = on ? [...(rule.limitTo ?? []), s.id] : (rule.limitTo ?? []).filter((x) => x !== s.id);
                  set({ limitTo: next.length ? next : undefined });
                }}
              />
            ))}
          </div>
        </div>
      )}
      <p className="mt-2 text-[12.5px] text-ink-3">{caught ? `Catches ${plural(caught.count, 'payment')}, ${money(caught.total)} counted.` : 'Catches nothing yet.'}</p>
    </li>
  );
}
