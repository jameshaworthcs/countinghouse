import { FileText, Pencil, Plus, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { AccountDetailResponse, CoverageResponse, TransactionsResponse } from '../../shared/api';
import { AccountDialog, BalanceDialog } from '../components/AccountForms';
import { ChartFrame } from '../components/charts/common';
import { TimeChart } from '../components/charts/TimeChart';
import { CoverageGrid } from '../components/Coverage';
import { InsightsPanel } from '../components/Intel';
import { TransactionList } from '../components/TransactionList';
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Loading, Money, PageHeader, SortHeader, Stat, Tabs, tableClasses, useToast } from '../components/ui';
import { FilePickerButton } from '../components/Upload';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { cn, formatDate, money, pct, timeAgo } from '../lib/format';
import { Sorted } from '../lib/sort';

type Tab = 'transactions' | 'balances' | 'holdings' | 'documents';

export default function AccountDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi<AccountDetailResponse>(['account', id], `/accounts/${id}`);
  const txs = useApi<TransactionsResponse>(['transactions', 'account', id], `/transactions${qs({ accounts: id, limit: 50 })}`);
  const cov = useApi<CoverageResponse>(['coverage'], '/coverage');
  const [tab, setTab] = useState<Tab>('transactions');
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const delBalance = useApiMutation((bid: string) => api(`/balances/${bid}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Balance deleted' }) });
  const delAccount = useApiMutation(() => api(`/accounts/${id}`, { method: 'DELETE' }), { onSuccess: () => void navigate('/accounts') });
  const close = useApiMutation(() => api(`/accounts/${id}`, { method: 'PATCH', body: { status: 'closed', closedOn: new Date().toISOString().slice(0, 10) } }));

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { account, summary, balances, holdings, series, gaps, imports } = q.data;
  const meta = ACCOUNT_TYPE_META[account.type];
  const market = balanceModeOf(account) === 'market';
  const latestHoldings = holdings[holdings.length - 1];
  const lastBal = balances[balances.length - 1];
  const points = series.filter((p) => p.value !== null);
  const snapshotDates = new Set(balances.map((b) => b.date));
  const empty = !summary.transactionCount && !balances.length;

  return (
    <div>
      <PageHeader
        title={account.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {[summary.institutionName, meta.label, account.last4 ? `•••• ${account.last4}` : null].filter(Boolean).join(' · ')}
            {account.status === 'closed' && <Badge tone="muted">closed</Badge>}
            {!account.includeInNetWorth && <Badge tone="muted">not in estate value</Badge>}
          </span>
        }
        actions={
          <>
            <FilePickerButton accountId={account.id} icon={<Upload className="size-4" />}>
              Upload for this account
            </FilePickerButton>
            <Button icon={<Plus className="size-4" />} onClick={() => setRecording(true)}>
              {market ? 'Record value' : 'Record balance'}
            </Button>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          </>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={market ? 'Value' : 'Balance'} value={<Money value={summary.balance} currency={account.currency} />} sub={summary.asOf ? `as of ${formatDate(summary.asOf)}${summary.estimated ? ' (estimated)' : ''}` : summary.balance !== null ? 'estimated: no statement data yet' : 'no data yet'} />
        <Stat label="Last updated" value={summary.asOf ? timeAgo(summary.asOf) : '—'} sub={summary.stale ? <span className="inline-flex items-center gap-1 text-warn-ink"><TriangleAlert className="size-3.5" /> needs new data</span> : 'up to date'} />
        {market && lastBal?.contributions !== undefined ? (
          <Stat label="Paid in" value={<Money value={lastBal.contributions} />} sub={summary.balance !== null ? <span>growth {money(summary.balance - lastBal.contributions - (lastBal.bonusToDate ?? 0))} ({pct((summary.balance - lastBal.contributions - (lastBal.bonusToDate ?? 0)) / Math.max(1, lastBal.contributions + (lastBal.bonusToDate ?? 0)))})</span> : undefined} />
        ) : (
          <Stat label="Transactions" value={summary.transactionCount.toLocaleString()} sub={summary.lastTransaction ? `latest ${formatDate(summary.lastTransaction)}` : undefined} />
        )}
        {account.type === 'lisa' && lastBal?.bonusToDate !== undefined ? (
          <Stat label="Government bonus" value={<Money value={lastBal.bonusToDate} />} sub="received to date" />
        ) : (
          <Stat label="Snapshots" value={balances.length.toLocaleString()} sub={lastBal ? `latest ${formatDate(lastBal.date)}` : 'none yet'} />
        )}
      </div>

      <InsightsPanel page="accounts" accountId={id} title="Claude’s notes on this account" className="mb-5" />
      {gaps.length > 0 && (
        <Callout tone="warn" className="mb-5" title={`${gaps.length} gap${gaps.length > 1 ? 's' : ''} in this account’s history`}>
          Balances don’t add up between some statements, which usually means a statement or some transactions are missing:
          <ul className="mt-1 list-disc pl-5">
            {gaps.slice(0, 5).map((g) => (
              <li key={g.from + g.to}>
                {formatDate(g.from)} to {formatDate(g.to)}: <span className="sensitive">{money(g.difference)}</span> unexplained
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {empty ? (
        <Card>
          <EmptyState icon={<Upload className="size-8" />} title="No data for this account yet" action={<FilePickerButton accountId={account.id} variant="primary">Upload a statement or screenshot</FilePickerButton>}>
            Upload a statement, export or screenshot and it will be matched to this account.
          </EmptyState>
        </Card>
      ) : (
        points.length > 1 && (
          <ChartFrame
            className="mb-5"
            title={market ? 'Value over time' : 'Balance over time'}
            subtitle={market ? 'Dots are recorded valuations; between them, contributions are added' : 'Rebuilt from statements and transactions'}
            table={{ columns: ['Date', 'Balance'], rows: [...points].reverse().map((p) => [formatDate(p.date), money(p.value)]) }}
          >
            <TimeChart
              dates={series.map((p) => p.date)}
              series={[
                { id: 'balance', label: market ? 'Value' : 'Balance', color: 'var(--s1)', values: series.map((p) => p.value), kind: 'area' },
                ...(market ? [{ id: 'snaps', label: 'Recorded value', color: 'var(--s1)', values: series.map((p) => (snapshotDates.has(p.date) ? p.value : null)), kind: 'line' as const, markers: true, quiet: true }] : []),
              ]}
              height={240}
              ariaLabel={`${account.name} balance over time`}
            />
          </ChartFrame>
        )
      )}

      {cov.data && !empty && cov.data.accounts.some((a) => a.accountId === id && a.source !== 'none') && (
        <Card
          className="mb-5"
          title="Data coverage"
          description={(() => {
            const row = cov.data.accounts.find((a) => a.accountId === id)!;
            const span = row.from && row.to ? `${formatDate(row.from)} to ${formatDate(row.to)}` : 'no dates yet';
            return `Days with transaction data in each of the last 13 months (${row.source === 'imports' ? 'from the periods your statements cover' : 'from the first to the last transaction'}; ${span}). Months without data are left out of averages rather than counted as no spending.`;
          })()}
        >
          <CoverageGrid cov={cov.data} only={id} />
        </Card>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'transactions', label: 'Transactions', count: summary.transactionCount },
          { value: 'balances', label: market ? 'Valuations' : 'Balances', count: balances.length },
          ...(holdings.length ? [{ value: 'holdings' as Tab, label: 'Holdings' }] : []),
          { value: 'documents', label: 'Documents', count: imports.length },
        ]}
      />
      {tab === 'transactions' && (
        <Card padded={false}>
          {txs.data?.items.length ? (
            <>
              <TransactionList items={txs.data.items} showAccount={false} />
              {txs.data.total > txs.data.items.length && (
                <div className="px-5 py-3 text-[13px]">
                  <Link to={`/transactions?accounts=${account.id}&period=all`} className="text-accent hover:underline">
                    See all {txs.data.total.toLocaleString()} transactions
                  </Link>
                </div>
              )}
            </>
          ) : (
            <EmptyState title="No transactions">{market ? 'Investment accounts are usually tracked by valuations; transactions (contributions, fees) are optional.' : 'Import a statement to see transactions.'}</EmptyState>
          )}
        </Card>
      )}
      {tab === 'balances' && (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <Sorted rows={[...balances].reverse()} columns={{ date: { value: (b) => b.date, first: 'desc' }, balance: { value: (b) => b.balance }, paidIn: { value: (b) => b.contributions }, source: { value: (b) => b.kind } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Date" sort={sortProps('date')} />
                      <SortHeader label={market ? 'Value' : 'Balance'} sort={sortProps('balance')} numeric />
                      {market && <SortHeader label="Paid in" sort={sortProps('paidIn')} numeric />}
                      <SortHeader label="Source" sort={sortProps('source')} />
                      <th className={tableClasses.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id}>
                        <td className={tableClasses.td}>{formatDate(b.date)}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={b.balance} currency={b.currency} />
                        </td>
                        {market && <td className={cn(tableClasses.td, tableClasses.num)}>{b.contributions !== undefined ? <Money value={b.contributions} /> : '—'}</td>}
                        <td className={cn(tableClasses.td, 'text-ink-3')}>
                          {b.approximate ? <Badge tone="muted">approximate</Badge> : b.kind}
                          {b.dateSource && b.dateSource !== 'document' && b.dateSource !== 'manual' ? ` · date from ${b.dateSource}` : ''}
                          {b.note && <div className="text-[12px]">{b.note}</div>}
                          {b.source.importId && (
                            <Link to={`/import/${b.source.importId}`} className="ml-2 text-accent hover:underline">
                              import
                            </Link>
                          )}
                        </td>
                        <td className={cn(tableClasses.td, 'text-right')}>
                          <button className="text-ink-3 hover:text-bad-ink" aria-label="Delete balance" onClick={() => confirm('Delete this balance snapshot?') && delBalance.mutate(b.id)}>
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        </Card>
      )}
      {tab === 'holdings' && latestHoldings && (
        <Card title={`Holdings on ${formatDate(latestHoldings.date)}`} padded={false}>
          <div className="overflow-x-auto">
            <Sorted rows={latestHoldings.holdings} columns={{ name: { value: (h) => h.name }, units: { value: (h) => h.units }, price: { value: (h) => h.price }, value: { value: (h) => h.value }, weight: { value: (h) => h.value } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Holding" sort={sortProps('name')} />
                      <SortHeader label="Units" sort={sortProps('units')} numeric />
                      <SortHeader label="Price" sort={sortProps('price')} numeric />
                      <SortHeader label="Value" sort={sortProps('value')} numeric />
                      <SortHeader label="Weight" sort={sortProps('weight')} numeric />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => (
                      <tr key={h.name}>
                        <td className={tableClasses.td}>
                          <div className="font-medium">{h.name}</div>
                          <div className="text-[12px] text-ink-3">{[h.isin, h.sedol, h.ticker, h.assetClass].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{h.units?.toLocaleString('en-GB', { maximumFractionDigits: 4 }) ?? '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{h.price !== undefined ? h.price.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={h.value} currency={h.currency} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{pct(h.value / latestHoldings.totalValue)}</td>
                      </tr>
                    ))}
                    {latestHoldings.cash !== undefined && (
                      <tr>
                        <td className={tableClasses.td}>Cash</td>
                        <td className={tableClasses.td} />
                        <td className={tableClasses.td} />
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={latestHoldings.cash} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{pct(latestHoldings.cash / latestHoldings.totalValue)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        </Card>
      )}
      {tab === 'documents' && (
        <Card padded={false}>
          {imports.length ? (
            <ul className="divide-y divide-line">
              {imports.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <FileText className="size-4 text-ink-3" />
                  <a href={`/api/documents/${i.documentId}`} target="_blank" rel="noreferrer" className="flex-1 truncate text-accent hover:underline">
                    {i.fileName}
                  </a>
                  <span className="text-ink-3">{i.committedAt ? formatDate(i.committedAt.slice(0, 10)) : ''}</span>
                  <Link to={`/import/${i.id}`} className="text-ink-2 hover:underline">
                    details
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No documents yet" />
          )}
        </Card>
      )}

      <div className="no-print mt-8 flex flex-wrap gap-2 border-t border-line pt-5">
        {account.status === 'open' && (
          <Button variant="ghost" loading={close.isPending} onClick={() => confirm('Mark this account as closed? Its history is kept.') && close.mutate(undefined)}>
            Mark as closed
          </Button>
        )}
        {empty && (
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={delAccount.isPending} onClick={() => confirm('Delete this account?') && delAccount.mutate(undefined)}>
            Delete account
          </Button>
        )}
        {delAccount.error && <span className="text-[13px] text-bad-ink">{delAccount.error.message}</span>}
      </div>
      {editing && <AccountDialog open onOpenChange={setEditing} account={account} />}
      {recording && <BalanceDialog open onOpenChange={setRecording} account={account} />}
    </div>
  );
}
