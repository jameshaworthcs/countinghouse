import { Plus, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { WRAPPER_GROUP_LABELS, WRAPPER_GROUPS } from '../../shared/accounts';
import type { AccountSummary, DataHealthResponse } from '../../shared/api';
import { AccountDialog } from '../components/AccountForms';
import { Sparkline } from '../components/charts/bars';
import { Badge, Button, Callout, Card, EmptyState, Loading, Money, PageHeader } from '../components/ui';
import { DropZone } from '../components/Upload';
import { useApi } from '../lib/api';
import { cn, formatDate, money, timeAgo } from '../lib/format';
import { wrapperColor } from '../lib/groups';

function Row({ a }: { a: AccountSummary }) {
  return (
    <Link to={`/accounts/${a.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-3 hover:bg-panel-2 sm:grid-cols-[1fr_140px_100px_130px]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-ink">{a.name}</span>
          {!a.includeInNetWorth && <Badge tone="muted">not in estate</Badge>}
          {a.status === 'closed' && <Badge tone="muted">closed</Badge>}
        </div>
        <div className="truncate text-[12.5px] text-ink-3">
          {[a.institutionName, a.typeLabel].filter(Boolean).join(' · ')}
          {a.transactionCount ? ` · ${a.transactionCount.toLocaleString()} transactions` : ''}
        </div>
      </div>
      <div className="hidden text-[12.5px] sm:block">
        {a.stale ? (
          <span className="inline-flex items-center gap-1 text-warn-ink">
            <TriangleAlert className="size-3.5" /> {a.asOf ? `updated ${timeAgo(a.asOf)}` : 'no data yet'}
          </span>
        ) : (
          <span className="text-ink-3">{a.asOf ? `as of ${formatDate(a.asOf)}` : '—'}</span>
        )}
      </div>
      <div className="hidden sm:block">
        <Sparkline values={a.sparkline} width={96} height={26} />
      </div>
      <div className="text-right">
        {a.annualIncome !== null && !a.balance ? (
          <>
            <Money value={a.annualIncome} decimals={0} className="tabular text-[14px] font-semibold" />
            <div className="text-[11.5px] text-ink-3">a year, forecast</div>
          </>
        ) : (
          <Money value={a.balance} currency={a.currency} className="tabular text-[14px] font-semibold" />
        )}
        {a.currency !== 'GBP' && a.balanceGBP !== null && <div className="text-[11.5px] text-ink-3">{money(a.balanceGBP)}</div>}
        {a.estimated && <div className="text-[11.5px] text-ink-3">estimated</div>}
      </div>
    </Link>
  );
}

export default function Accounts() {
  const q = useApi<AccountSummary[]>(['accounts'], '/accounts');
  const health = useApi<DataHealthResponse>(['data-health'], '/data-health');
  const [adding, setAdding] = useState(false);
  if (!q.data) return <Loading />;
  const open = q.data.filter((a) => a.status === 'open');
  const closed = q.data.filter((a) => a.status === 'closed');
  const groups = WRAPPER_GROUPS.map((g) => ({ id: g, label: WRAPPER_GROUP_LABELS[g], items: open.filter((a) => (a.liability ? 'liabilities' : a.group) === g) })).filter((g) => g.items.length);
  const fscs = health.data?.fscs.filter((f) => f.near) ?? [];
  return (
    <div>
      <PageHeader title="Accounts" subtitle={`${open.length} open accounts`} actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add account</Button>} />
      {fscs.map((f) => (
        <Callout key={f.group} tone={f.over ? 'warn' : 'neutral'} className="mb-4" title={f.over ? 'Above the FSCS limit' : 'Close to the FSCS limit'}>
          <ShieldAlert className="mr-1 inline size-3.5" />
          {money(f.total, { decimals: 0 })} is held with {f.institutions.join(' / ')}, which share one banking licence. Deposits are protected up to {money(f.limit, { decimals: 0 })} per person per licence.
        </Callout>
      ))}
      {q.data.length === 0 ? (
        <Card>
          <EmptyState title="No accounts yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Add an account</Button>}>
            Accounts are created for you when you import a statement or screenshot. You can also add one by hand.
          </EmptyState>
          <DropZone compact />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <Card
              key={g.id}
              padded={false}
              title={
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block size-2.5 rounded-[3px]" style={{ background: wrapperColor(g.id) }} />
                  {g.label}
                </span>
              }
              actions={<Money value={g.items.filter((a) => a.includeInNetWorth).reduce((s, a) => s + (a.balanceGBP ?? 0), 0)} className="tabular text-[15px] font-semibold" />}
            >
              <div className="divide-y divide-line border-t border-line">
                {g.items.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </div>
            </Card>
          ))}
          {closed.length > 0 && (
            <details className="rounded-xl border border-line bg-panel">
              <summary className={cn('cursor-pointer px-5 py-3 text-[14px] font-medium text-ink-2')}>Closed accounts ({closed.length})</summary>
              <div className="divide-y divide-line border-t border-line">
                {closed.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {adding && <AccountDialog open onOpenChange={setAdding} />}
    </div>
  );
}
