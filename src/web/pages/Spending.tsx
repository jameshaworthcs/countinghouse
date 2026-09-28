import { ArrowDownRight, ArrowUpRight, CircleCheck, Info, Repeat, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { CashflowResponse, SpendingResponse } from '../../shared/api';
import { addDays, addMonths, endOfMonth, formatMonth, startOfMonth, today } from '../../shared/dates';
import { taxYearOf } from '../../shared/uk';
import { BarList, ColumnChart, Heatmap } from '../components/charts/bars';
import { ChartFrame } from '../components/charts/common';
import { TransactionList } from '../components/TransactionList';
import { Badge, Card, EmptyState, Loading, Money, PageHeader, Segmented, Select, Stat, tableClasses } from '../components/ui';
import { qs, useApi } from '../lib/api';
import { cn, formatDate, money, pct } from '../lib/format';

type Period = 'month' | 'last-month' | '3m' | '12m' | 'tax-year';

function periodRange(p: Period): [string, string] {
  const t = today();
  switch (p) {
    case 'month':
      return [startOfMonth(t), t];
    case 'last-month':
      return [startOfMonth(addMonths(t, -1)), endOfMonth(addMonths(t, -1))];
    case '12m':
      return [startOfMonth(addMonths(t, -11)), t];
    case 'tax-year':
      return [taxYearOf(t).start, t];
    default:
      return [addDays(t, -89), t];
  }
}

function ChangeNote({ change }: { change: number | null | undefined }) {
  if (change === null || change === undefined || !Number.isFinite(change) || Math.abs(change) < 0.05) return null;
  const up = change > 0;
  return (
    <span className={cn('inline-flex items-center text-[12px]', up ? 'text-bad-ink' : 'text-good-ink')}>
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {pct(Math.abs(change), 0)}
    </span>
  );
}

export default function Spending() {
  const [period, setPeriod] = useState<Period>('3m');
  const [from, to] = periodRange(period);
  const [level, setLevel] = useState<'groups' | 'categories'>('groups');
  const navigate = useNavigate();
  const q = useApi<SpendingResponse>(['spending', from, to], `/spending${qs({ from, to })}`);
  const cfFrom = startOfMonth(addMonths(today(), -11));
  const cf = useApi<CashflowResponse>(['cashflow', cfFrom, today()], `/cashflow${qs({ from: cfFrom, to: today() })}`);
  const s = q.data;
  const drill = (category: string, f = from, t = to) => void navigate(`/transactions?categories=${category}&period=custom&from=${f}&to=${t}`);
  const rows = s ? (level === 'groups' ? s.groups : s.categories) : [];
  const recurring = s?.recurring.filter((r) => r.active) ?? [];

  return (
    <div>
      <PageHeader
        title="Spending"
        subtitle={`${formatDate(from)} – ${formatDate(to)}`}
        actions={
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-44" aria-label="Period">
            <option value="month">This month</option>
            <option value="last-month">Last month</option>
            <option value="3m">Last 3 months</option>
            <option value="12m">Last 12 months</option>
            <option value="tax-year">This tax year</option>
          </Select>
        }
      />
      {!s ? (
        <Loading />
      ) : s.total === 0 && s.previousTotal === 0 ? (
        <Card>
          <EmptyState title="No spending yet">Import current-account and credit-card statements to see where your money goes.</EmptyState>
        </Card>
      ) : (
        <div className={cn('flex flex-col gap-5', q.isFetching ? 'opacity-70' : '')}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Spent"
              value={<Money value={s.total} decimals={0} />}
              delta={
                s.previousTotal > 0 && Math.abs(s.total - s.previousTotal) / s.previousTotal >= 0.005 ? (
                  <span className={cn('inline-flex items-center gap-0.5', s.total > s.previousTotal ? 'text-bad-ink' : 'text-good-ink')}>
                    {s.total > s.previousTotal ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                    {pct(Math.abs(s.total - s.previousTotal) / s.previousTotal, 0)}
                  </span>
                ) : undefined
              }
              sub="vs the previous period"
            />
            <Stat label="Per day" value={<Money value={s.dailyAverage} />} sub="average" />
            <Stat label="Biggest category" value={s.groups[0]?.name ?? '—'} sub={s.groups[0] ? <span><Money value={s.groups[0].amount} decimals={0} /> · {pct(s.groups[0].share, 0)}</span> : undefined} />
            <Stat label="Regular payments" value={<Money value={recurring.reduce((x, r) => x + r.monthlyCost, 0)} decimals={0} />} sub={`a month across ${recurring.length}`} />
          </div>

          {s.insights.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {s.insights.map((i) => {
                const Icon = i.tone === 'good' ? CircleCheck : i.tone === 'warning' ? TriangleAlert : Info;
                return (
                  <div key={i.id} className="flex gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-card">
                    <Icon className={cn('mt-0.5 size-4 shrink-0', i.tone === 'good' ? 'text-good-ink' : i.tone === 'warning' ? 'text-warn-ink' : 'text-accent')} />
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">{i.title}</div>
                      <div className="sensitive text-[12.5px] text-ink-3">{i.detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {cf.data && (
            <ChartFrame
              title="Income and spending by month"
              subtitle="Last 12 months. Transfers between your accounts and investments are excluded; refunds reduce spending."
              legend={[
                { label: 'Income', color: 'var(--s1)', kind: 'bar' },
                { label: 'Spending', color: 'var(--s2)', kind: 'bar' },
                { label: 'Left over', color: 'var(--ink-2)', kind: 'dot' },
              ]}
              table={{ columns: ['Month', 'Income', 'Spending', 'Left over', 'Savings rate'], rows: cf.data.months.map((m) => [formatMonth(m.month), money(m.income), money(m.spending), money(m.net), pct(m.savingsRate, 0)]) }}
            >
              <ColumnChart
                labels={cf.data.months.map((m) => formatMonth(m.month, { short: true }).split(' ')[0]!)}
                series={[
                  { id: 'income', label: 'Income', color: 'var(--s1)', values: cf.data.months.map((m) => m.income) },
                  { id: 'spending', label: 'Spending', color: 'var(--s2)', values: cf.data.months.map((m) => m.spending) },
                ]}
                mode="diverging"
                marker={{ label: 'Left over', color: 'var(--ink-2)', values: cf.data.months.map((m) => m.net) }}
                height={260}
                ariaLabel="Monthly income and spending"
                onSelect={(i) => {
                  const m = cf.data.months[i]!;
                  void navigate(`/transactions?period=custom&from=${m.month}-01&to=${endOfMonth(`${m.month}-01`)}&transfers=exclude`);
                }}
              />
            </ChartFrame>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="Where it went"
              description="Compared with the previous period of the same length"
              actions={<Segmented size="sm" value={level} onChange={setLevel} options={[{ value: 'groups', label: 'Groups' }, { value: 'categories', label: 'Categories' }]} />}
            >
              <BarList
                rows={rows.slice(0, 14).map((c) => ({
                  id: c.id,
                  label: c.name,
                  value: c.amount,
                  note: <ChangeNote change={c.change} />,
                  sub: c.groupName ? c.groupName : undefined,
                }))}
                onSelect={(id) => drill(id)}
              />
            </Card>
            <Card title="Top merchants" padded={false}>
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th className={tableClasses.th}>Merchant</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Visits</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Average</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {s.merchants.slice(0, 12).map((m) => (
                    <tr key={m.payee} className="hover:bg-panel-2">
                      <td className={tableClasses.td}>
                        <div className="font-medium">{m.payee}</div>
                        <div className="text-[12px] text-ink-3">{m.categoryName}</div>
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num)}>{m.count}</td>
                      <td className={cn(tableClasses.td, tableClasses.num)}>
                        <Money value={m.average} />
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                        <Money value={m.amount} decimals={0} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {s.heatmap.rows.length > 0 && s.heatmap.months.length > 1 && (
            <ChartFrame
              title="Categories by month"
              subtitle="Darker means more. Click a cell to see the transactions."
              table={{ columns: ['Category', ...s.heatmap.months.map((m) => formatMonth(m, { short: true })), 'Total'], rows: s.heatmap.rows.map((r) => [r.name, ...r.values.map((v) => money(v, { decimals: 0 })), money(r.total, { decimals: 0 })]) }}
            >
              <Heatmap
                columns={s.heatmap.months.map((m) => formatMonth(m, { short: true }))}
                rows={s.heatmap.rows}
                onSelect={(id, col) => {
                  const m = s.heatmap.months[col]!;
                  drill(id, `${m}-01`, endOfMonth(`${m}-01`));
                }}
              />
            </ChartFrame>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartFrame title="Day of the week" subtitle="Average spent on each day" table={{ columns: ['Day', 'Average', 'Total', 'Purchases'], rows: s.weekday.map((d) => [d.label, money(d.average), money(d.total), d.count]) }}>
              <ColumnChart labels={s.weekday.map((d) => d.label.slice(0, 3))} series={[{ id: 'avg', label: 'Average per day', color: 'var(--s1)', values: s.weekday.map((d) => d.average) }]} height={200} ariaLabel="Average spending by weekday" />
            </ChartFrame>
            {s.hours ? (
              <ChartFrame title="Time of day" subtitle="Total spent by hour (where the bank records a time)" table={{ columns: ['Hour', 'Total', 'Purchases'], rows: s.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, money(h.total), h.count]) }}>
                <ColumnChart labels={s.hours.map((h) => String(h.hour).padStart(2, '0'))} series={[{ id: 'hour', label: 'Spent', color: 'var(--s1)', values: s.hours.map((h) => h.total) }]} height={200} ariaLabel="Spending by hour" />
              </ChartFrame>
            ) : (
              <Card title="Small purchases">
                <div className="text-[28px] font-semibold text-ink">{s.small.count.toLocaleString()}</div>
                <div className="text-[13px] text-ink-3">
                  purchases of {money(s.small.threshold, { decimals: 0 })} or less, adding up to <Money value={s.small.total} />
                </div>
              </Card>
            )}
          </div>

          <Card title={<span className="inline-flex items-center gap-2"><Repeat className="size-4 text-ink-3" /> Regular payments and subscriptions</span>} description="Detected from repeating payments to the same payee" padded={false}>
            {s.recurring.length ? (
              <div className="overflow-x-auto">
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>Payee</th>
                      <th className={tableClasses.th}>How often</th>
                      <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
                      <th className={cn(tableClasses.th, 'text-right')}>Per month</th>
                      <th className={tableClasses.th}>Next</th>
                      <th className={tableClasses.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {s.recurring.slice(0, 40).map((r) => (
                      <tr key={r.key} className={r.active ? '' : 'opacity-50'}>
                        <td className={tableClasses.td}>
                          <div className="font-medium">{r.payee}</div>
                          <div className="text-[12px] text-ink-3">{r.categoryName}</div>
                        </td>
                        <td className={cn(tableClasses.td, 'capitalize')}>{r.cadence}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={r.typicalAmount} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                          <Money value={r.monthlyCost} />
                        </td>
                        <td className={tableClasses.td}>{r.active ? formatDate(r.nextDate) : <span className="text-ink-3">stopped?</span>}</td>
                        <td className={tableClasses.td}>
                          {r.priceChange && r.priceChange.to > r.priceChange.from && (
                            <Badge tone="warn" icon={<ArrowUpRight className="size-3" />}>
                              was {money(r.priceChange.from)}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="Nothing regular found yet">Needs at least three payments to the same payee.</EmptyState>
            )}
          </Card>

          <Card title="Largest purchases" padded={false}>
            <TransactionList items={s.largest} />
          </Card>
        </div>
      )}
    </div>
  );
}
