// Monthly budgets on the Spending page: each against the month's spending, and an editor with
// suggestions from your complete months (docs/FORMULAS.md §15).

import { Plus, Trash2, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BudgetLine, BudgetsResponse } from '../../shared/api';
import { addMonths, formatMonth, monthKey, today } from '../../shared/dates';
import type { Budget } from '../../shared/schema';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money } from '../lib/format';
import { BudgetMeter } from './charts/bars';
import { Button, Callout, Card, Dialog, EmptyState, Input, Loading, Select, useToast } from './ui';

type Draft = { category: string; monthly: string; notes?: string };
const ALL = '*';

/** What a line says under its meter: what is left, how far over, or where it is heading. */
function lineSub(l: BudgetLine, complete: boolean) {
  if (l.status === 'over') return <span className="font-medium text-bad-ink">{money(-l.left, { decimals: 0 })} over</span>;
  if (l.status === 'pace' && l.projected !== null)
    return (
      <span title={l.paceBasis ?? undefined}>
        <span className="font-medium text-warn-ink">On pace for {money(l.projected, { decimals: 0 })}</span> · {money(l.left, { decimals: 0 })} left
      </span>
    );
  return (
    <span title={l.paceBasis ?? undefined}>
      {money(l.left, { decimals: 0 })} {complete ? 'unspent' : 'left'}
      {l.status === 'near' && !complete ? ' · nearly spent' : ''}
    </span>
  );
}

function BudgetEditor({ open, onOpenChange, suggestions }: { open: boolean; onOpenChange: (o: boolean) => void; suggestions: BudgetsResponse['suggestions'] }) {
  const { data, cats } = useAppData();
  const toast = useToast();
  const [rows, setRows] = useState<Draft[]>([]);
  useEffect(() => {
    if (open) setRows(data.budgets.map((b) => ({ category: b.category ?? ALL, monthly: String(b.monthly), ...(b.notes ? { notes: b.notes } : {}) })));
  }, [open, data.budgets]);
  const save = useApiMutation(
    () =>
      api<Budget[]>('/budgets', {
        method: 'PUT',
        body: rows.filter((r) => Number(r.monthly) > 0).map((r) => ({ ...(r.category !== ALL ? { category: r.category } : {}), monthly: Math.round(Number(r.monthly) * 100) / 100, ...(r.notes ? { notes: r.notes } : {}) })) as unknown as Record<string, unknown>,
      }),
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Budgets saved' });
        onOpenChange(false);
      },
    },
  );
  const used = new Set(rows.map((r) => r.category));
  const groups = cats.groups().filter((g) => g.kind === 'expense' && !g.hidden);
  const options = (current: string) => (
    <>
      <option value={ALL} disabled={used.has(ALL) && current !== ALL}>
        All spending
      </option>
      {groups.map((g) => (
        <optgroup key={g.id} label={g.name}>
          <option value={g.id} disabled={used.has(g.id) && current !== g.id}>
            {g.name} (all)
          </option>
          {cats
            .children(g.id)
            .filter((c) => !c.hidden && c.kind === 'expense')
            .map((c) => (
              <option key={c.id} value={c.id} disabled={used.has(c.id) && current !== c.id}>
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
  const firstFree = [ALL, ...groups.map((g) => g.id)].find((id) => !used.has(id)) ?? ALL;
  const suggestionFor = (category: string) => suggestions.find((s) => (s.category ?? ALL) === category)?.suggested;
  const invalid = rows.some((r) => !(Number(r.monthly) > 0));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Budgets"
      description="A monthly amount for all spending, a group or a category. A group’s budget covers every category in it. Unspent money does not carry over."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={invalid} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {rows.length === 0 && <p className="text-[13px] text-ink-3">No budgets yet.</p>}
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_7.5rem_auto] items-center gap-2">
            <Select value={r.category} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))} aria-label="Budget for">
              {options(r.category)}
            </Select>
            <Input value={r.monthly} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, monthly: e.target.value } : x)))} inputMode="decimal" placeholder={suggestionFor(r.category) ? String(suggestionFor(r.category)) : '£ a month'} aria-label="Monthly amount" className={cn(!(Number(r.monthly) > 0) && 'border-bad')} />
            <button className="rounded p-1.5 text-ink-3 hover:bg-panel-2" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove budget">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows([...rows, { category: firstFree, monthly: suggestionFor(firstFree) ? String(suggestionFor(firstFree)) : '' }])}>
            Add a budget
          </Button>
        </div>
        {suggestions.filter((s) => !used.has(s.category ?? ALL)).length > 0 && (
          <div className="mt-3 rounded-lg border border-line p-3">
            <div className="mb-2 text-[12.5px] font-medium text-ink">From your last {suggestions[0]!.months} complete month{suggestions[0]!.months === 1 ? '' : 's'}</div>
            <div className="flex flex-wrap gap-2">
              {suggestions
                .filter((s) => !used.has(s.category ?? ALL))
                .map((s) => (
                  <Button key={s.category ?? ALL} size="sm" onClick={() => setRows([...rows, { category: s.category ?? ALL, monthly: String(s.suggested) }])} title={`Typically ${money(s.typical, { decimals: 0 })} a month (the median)`}>
                    {s.name}: {money(s.suggested, { decimals: 0 })}
                  </Button>
                ))}
            </div>
          </div>
        )}
        {save.error && <Callout tone="bad">{save.error.message}</Callout>}
      </div>
    </Dialog>
  );
}

export function BudgetsCard() {
  const now = today();
  const [month, setMonth] = useState(monthKey(now));
  const [editing, setEditing] = useState(false);
  const q = useApi<BudgetsResponse>(['budgets', month], `/budgets${qs({ month })}`);
  const b = q.data;
  const months = Array.from({ length: 12 }, (_, i) => monthKey(addMonths(`${monthKey(now)}-01`, -i)));
  return (
    <Card
      id="budgets"
      title={
        <span className="inline-flex items-center gap-2">
          <Wallet className="size-4 text-ink-3" aria-hidden /> Budgets
        </span>
      }
      description={b?.dataTo ? `Spending in ${formatMonth(month)}${b.complete ? '' : `, with data for every account to ${formatDate(b.dataTo)}`}. The tick is how much of a usual month’s spending is done by then.` : undefined}
      actions={
        <div className="flex items-center gap-2">
          <Select value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-36 text-[13px]" aria-label="Month">
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonth(m)}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setEditing(true)}>
            {b?.lines.length ? 'Edit' : 'Set budgets'}
          </Button>
        </div>
      }
    >
      {!b ? (
        <Loading />
      ) : b.lines.length === 0 ? (
        <EmptyState title="No budgets yet">
          {b.suggestions.length
            ? `Set a monthly amount for all spending, a group or a category. Suggestions come from your last ${b.suggestions[0]!.months} complete month${b.suggestions[0]!.months === 1 ? '' : 's'}.`
            : 'Set a monthly amount for all spending, a group or a category. Once a month has data for every account, suggestions come from what you spent.'}
        </EmptyState>
      ) : (
        <div className={cn('flex flex-col gap-4', q.isFetching && 'opacity-70')}>
          {b.note && (
            <Callout tone="neutral" className="text-[12.5px]">
              {b.note}
            </Callout>
          )}
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            {b.lines.map((l) => (
              <BudgetMeter key={l.category ?? '*'} label={l.name} spent={l.spent} budget={l.monthly} expected={b.complete ? null : l.expectedShare} status={l.status} sub={lineSub(l, b.complete)} />
            ))}
          </div>
        </div>
      )}
      <BudgetEditor open={editing} onOpenChange={setEditing} suggestions={b?.suggestions ?? []} />
    </Card>
  );
}
