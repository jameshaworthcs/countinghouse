// Goals: progress from the accounts that fund each, when it is reached at the recent pace, and an
// editor (docs/FORMULAS.md §16). The full card is on Projections; a short one on the Overview.

import { Flag, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import type { GoalProgress, GoalsResponse } from '../../shared/api';
import { formatMonth } from '../../shared/dates';
import { GOAL_KINDS, type Goal } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money, pct } from '../lib/format';
import { Badge, Button, Callout, Card, Checkbox, Dialog, EmptyState, Field, Input, Loading, Select, StatusBadge, Textarea, useToast } from './ui';

const KIND_LABEL: Record<(typeof GOAL_KINDS)[number], string> = { savings: 'Savings', 'emergency-fund': 'Emergency fund', 'home-deposit': 'Home deposit' };
const STATUS: Record<GoalProgress['status'], { tone: 'good' | 'warn' | 'info' | 'pending'; label: string } | null> = {
  reached: { tone: 'good', label: 'Reached' },
  'on-track': { tone: 'good', label: 'On track' },
  behind: { tone: 'warn', label: 'Behind' },
  'no-date': null,
  unknown: null,
};

/** Progress towards a goal: neutral, since how far along it is is not a status. */
function GoalBar({ current, target }: { current: number; target: number | null }) {
  const ratio = target ? Math.min(1, Math.max(0, current / target)) : 0;
  return (
    <div className="h-2.5 rounded-full" style={{ background: 'var(--seq-1)' }} role="meter" aria-valuemin={0} aria-valuemax={target ?? undefined} aria-valuenow={current}>
      <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: 'var(--seq-5)' }} />
    </div>
  );
}

function reachText(g: GoalProgress): string | null {
  if (g.status === 'reached' || g.target === null) return null;
  if (!g.reach?.median) return 'Not reached within 40 years at the recent pace.';
  const { early, median, late } = g.reach;
  const range = early && late && early !== late ? ` (between ${formatMonth(early)} and ${formatMonth(late)})` : early && !late ? ` (from ${formatMonth(early)})` : '';
  return `At the recent pace, reached around ${formatMonth(median)}${range}.`;
}

function GoalRow({ g, full }: { g: GoalProgress; full: boolean }) {
  const status = STATUS[g.status];
  const reach = reachText(g);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{g.name}</span>
          {full && <Badge tone="muted">{KIND_LABEL[g.kind]}</Badge>}
          {status && <StatusBadge status={status.tone}>{status.label}</StatusBadge>}
        </span>
        <span className="shrink-0 text-[12.5px] text-ink-3">
          <span className="sensitive tabular font-semibold text-ink">{money(g.current, { decimals: 0 })}</span>
          {g.target !== null && (
            <>
              {' '}
              of <span className="sensitive tabular">{money(g.target, { decimals: 0 })}</span>
            </>
          )}
          {g.targetDate && <> by {formatDate(g.targetDate)}</>}
        </span>
      </div>
      <GoalBar current={g.current} target={g.target} />
      <div className="text-[12.5px] text-ink-2">
        {g.target === null ? g.targetBasis : g.status === 'reached' ? `Reached: ${pct(g.share ?? 1, 0)} of the goal.` : reach}
        {full && g.status === 'behind' && g.neededMonthly ? ` ${money(g.neededMonthly, { decimals: 0 })} a month more would reach it by ${formatDate(g.targetDate!)}.` : ''}
      </div>
      {full && (
        <div className="flex flex-col gap-0.5 text-[12px] text-ink-3">
          {g.kind === 'emergency-fund' && g.target !== null && <span>{g.targetBasis}.</span>}
          {g.atTargetDate && g.status !== 'reached' && (
            <span>
              On {formatDate(g.targetDate!)}: about <span className="sensitive">{money(g.atTargetDate.p50, { decimals: 0 })}</span> (80% range <span className="sensitive">{money(g.atTargetDate.p10, { decimals: 0 })}</span>–<span className="sensitive">{money(g.atTargetDate.p90, { decimals: 0 })}</span>)
            </span>
          )}
          {g.accounts.map((a) => (
            <span key={a.accountId} title={a.monthlyBasis}>
              <Link to={`/accounts/${a.accountId}`} className="text-accent hover:underline">
                {a.name}
              </Link>{' '}
              <span className="sensitive">{money(a.counted, { decimals: 0 })}</span>
              {a.monthly ? (
                <>
                  , <span className="sensitive">{money(a.monthly, { decimals: 0, sign: true })}</span> a month
                </>
              ) : (
                ', nothing coming in recently'
              )}
              {a.note ? ` · ${a.note}` : ''}
            </span>
          ))}
          {g.notes.filter((n) => !g.accounts.some((a) => a.note && n.endsWith(`${a.note}.`))).map((n) => (
            <span key={n}>{n}</span>
          ))}
          {g.ownerNotes && <span className="italic">{g.ownerNotes}</span>}
        </div>
      )}
    </div>
  );
}

type Draft = { id: string; name: string; kind: (typeof GOAL_KINDS)[number]; amount: string; months: string; price: string; date: string; accountIds: string[]; notes: string; createdAt?: string };

function toDraft(g: Goal): Draft {
  return { id: g.id, name: g.name, kind: g.kind ?? 'savings', amount: g.targetAmount !== undefined ? String(g.targetAmount) : '', months: g.months !== undefined ? String(g.months) : '', price: g.propertyPrice !== undefined ? String(g.propertyPrice) : '', date: g.targetDate ?? '', accountIds: g.accountIds, notes: g.notes ?? '', createdAt: g.createdAt };
}

function GoalEditor({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useAppData();
  const toast = useToast();
  const [rows, setRows] = useState<Draft[]>([]);
  useEffect(() => {
    if (open) setRows(data.goals.map(toDraft));
  }, [open, data.goals]);
  const assets = data.accounts.filter((a) => a.status === 'open' && !ACCOUNT_TYPE_META[a.type].liability && a.type !== 'state_pension' && a.type !== 'db_pension');
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = useApiMutation(
    () =>
      api('/goals', {
        method: 'PUT',
        body: rows.map((r) => ({
          id: r.id,
          name: r.name.trim() || KIND_LABEL[r.kind],
          kind: r.kind,
          accountIds: r.accountIds,
          ...(r.kind !== 'emergency-fund' && r.amount ? { targetAmount: Math.round(Number(r.amount) * 100) / 100 } : {}),
          ...(r.kind === 'emergency-fund' && r.months ? { months: Number(r.months) } : {}),
          ...(r.kind === 'home-deposit' && r.price ? { propertyPrice: Math.round(Number(r.price) * 100) / 100 } : {}),
          ...(r.date ? { targetDate: r.date } : {}),
          ...(r.notes.trim() ? { notes: r.notes.trim() } : {}),
          ...(r.createdAt ? { createdAt: r.createdAt } : {}),
        })) as unknown as Record<string, unknown>,
      }),
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Goals saved' });
        onOpenChange(false);
      },
    },
  );
  const add = () => {
    const taken = rows.map((r) => r.id);
    setRows([...rows, { id: slugify(`goal ${rows.length + 1}`, taken), name: '', kind: 'savings', amount: '', months: '6', price: '', date: '', accountIds: [], notes: '' }]);
  };
  const invalid = rows.some((r) => (r.kind === 'emergency-fund' ? !(Number(r.months) >= 1) : !(Number(r.amount) > 0)));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Goals"
      description="What you are saving towards, and the accounts that fund it."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={invalid} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {rows.length === 0 && <p className="text-[13px] text-ink-3">No goals yet.</p>}
        {rows.map((r, i) => (
          <div key={r.id} className="rounded-lg border border-line p-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto]">
              <Field label="Name">
                <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={KIND_LABEL[r.kind]} />
              </Field>
              <Field label="Kind">
                <Select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Draft['kind'] })}>
                  {GOAL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <button className="rounded p-2 text-ink-3 hover:bg-panel-2" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove goal">
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {r.kind === 'emergency-fund' ? (
                <Field label="Months of spending">
                  <Input value={r.months} onChange={(e) => set(i, { months: e.target.value })} inputMode="decimal" />
                </Field>
              ) : (
                <Field label="Amount">
                  <Input value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} inputMode="decimal" placeholder="£" />
                </Field>
              )}
              <Field label="By (optional)">
                <Input type="date" value={r.date} onChange={(e) => set(i, { date: e.target.value })} />
              </Field>
              {r.kind === 'home-deposit' && (
                <Field label="Home’s price (optional)" hint="For the LISA’s price cap">
                  <Input value={r.price} onChange={(e) => set(i, { price: e.target.value })} inputMode="decimal" placeholder="£" />
                </Field>
              )}
            </div>
            <div className="mt-3">
              <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Accounts that fund it</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {assets.map((a) => (
                  <Checkbox key={a.id} checked={r.accountIds.includes(a.id)} onChange={(v) => set(i, { accountIds: v ? [...r.accountIds, a.id] : r.accountIds.filter((x) => x !== a.id) })} label={<span className="text-[13px]">{a.name}</span>} />
                ))}
              </div>
            </div>
            <Field label="Notes" className="mt-3">
              <Textarea value={r.notes} onChange={(e) => set(i, { notes: e.target.value })} rows={2} />
            </Field>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={add}>
            Add a goal
          </Button>
        </div>
        {save.error && <Callout tone="bad">{save.error.message}</Callout>}
      </div>
    </Dialog>
  );
}

/** Projections: every goal with its range, accounts and what more a month would reach it. */
export function GoalsCard() {
  const q = useApi<GoalsResponse>(['goals-progress'], '/goals/progress');
  const [editing, setEditing] = useState(false);
  const d = q.data;
  return (
    <Card
      id="goals"
      title={
        <span className="inline-flex items-center gap-2">
          <Flag className="size-4 text-ink-3" aria-hidden /> Goals
        </span>
      }
      description={d?.goals.length ? `Each account grows at its own expected return after charges (cash at its interest rate)${d.pace ? `, with money coming in at the pace of ${d.pace}` : ''}. ${d.notes.join(' ')}` : undefined}
      actions={
        <Button size="sm" onClick={() => setEditing(true)}>
          {d?.goals.length ? 'Edit' : 'Add a goal'}
        </Button>
      }
    >
      {!d ? (
        <Loading />
      ) : d.goals.length === 0 ? (
        <EmptyState title="No goals yet">A house deposit from your LISA and savings, an emergency fund of a few months’ spending, or any amount by a date: see when you get there at your recent pace.</EmptyState>
      ) : (
        <div className={cn('flex flex-col gap-5', q.isFetching && 'opacity-70')}>
          {d.goals.map((g) => (
            <GoalRow key={g.id} g={g} full />
          ))}
        </div>
      )}
      <GoalEditor open={editing} onOpenChange={setEditing} />
    </Card>
  );
}

/** Overview: each goal's progress in a line; nothing when there are none. */
export function GoalsPanel() {
  const q = useApi<GoalsResponse>(['goals-progress'], '/goals/progress');
  if (!q.data?.goals.length) return null;
  return (
    <Card title="Goals" actions={<Link to="/projections#goals" className="text-[13px] font-medium text-accent hover:underline">Details</Link>}>
      <div className="flex flex-col gap-4">
        {q.data.goals.map((g) => (
          <GoalRow key={g.id} g={g} full={false} />
        ))}
      </div>
    </Card>
  );
}
