import { ArrowRight, CircleAlert, Info, ListChecks, TriangleAlert, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { WRAPPER_GROUP_LABELS, WRAPPER_GROUPS } from '../../shared/accounts';
import type { AccountSummary, AllowancesResponse, EstateSeriesResponse, MonthlyChecklistResponse, SummaryResponse, TransactionsResponse } from '../../shared/api';
import { addMonths, formatDate, today } from '../../shared/dates';
import { Meter, Sparkline } from '../components/charts/bars';
import { ChartFrame, type LegendItem } from '../components/charts/common';
import { TimeChart, type TimeSeries } from '../components/charts/TimeChart';
import { TransactionList } from '../components/TransactionList';
import { Badge, Button, Card, Callout, Delta, EmptyState, ErrorNote, Loading, Money, PageHeader, Segmented, Stat } from '../components/ui';
import { GoalsPanel } from '../components/Goals';
import { InsightsPanel } from '../components/Intel';
import { DropZone } from '../components/Upload';
import { qs, useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { bandLabel, cn, formatMonth, money, pct, timeAgo } from '../lib/format';
import { accessColor, wrapperColor } from '../lib/groups';

type Range = '6m' | '1y' | '3y' | 'all';

function rangeFrom(r: Range): string | undefined {
  const t = today();
  if (r === '6m') return addMonths(t, -6);
  if (r === '1y') return addMonths(t, -12);
  if (r === '3y') return addMonths(t, -36);
  return undefined;
}

function EstateChart() {
  const [range, setRange] = useState<Range>('1y');
  const [grouping, setGrouping] = useState<'wrapper' | 'access'>('wrapper');
  const q = useApi<EstateSeriesResponse>(['estate', range, grouping], `/estate${qs({ from: rangeFrom(range), grouping })}`);
  const d = q.data;
  const color = grouping === 'wrapper' ? wrapperColor : accessColor;
  // Before every account has data the total leaves some out: that stretch is marked partial and has
  // no total line, only what is known.
  const firstComplete = d?.completeFrom ? d.dates.findIndex((x) => x >= d.completeFrom!) : 0;
  const partialBefore = d && firstComplete < 0 ? d.dates.length : firstComplete;
  const totalLine = d ? d.dates.length - partialBefore >= 2 : false;
  // A history needs at least two days on which some account has data.
  const history = d ? d.dates.filter((_, i) => d.groups.some((g) => g.values[i] !== 0)).length >= 2 : false;
  const series: TimeSeries[] = d
    ? [
        ...d.groups.map((g) => ({ id: g.id, label: g.label, color: color(g.id), values: g.values, kind: 'area' as const, stack: true })),
        { id: 'total', label: 'Estate value', color: 'var(--ink-2)', values: d.total.map((v, i) => (i < partialBefore ? null : v)), kind: 'line' as const },
      ]
    : [];
  const requested = rangeFrom(range);
  const legend: LegendItem[] = d
    ? [...d.groups.map((g) => ({ label: g.label, color: color(g.id), kind: 'area' as const })), ...(totalLine ? [{ label: 'Estate value', color: 'var(--ink-2)', kind: 'line' as const }] : [])]
    : [];
  return (
    <ChartFrame
      title="Estate value over time"
      subtitle={`${grouping === 'wrapper' ? 'By tax wrapper; debts below the line' : 'By when you could spend it'}${d && requested && d.dates[0]! > requested ? `. Your data starts on ${formatDate(d.dates[0]!)}` : ''}`}
      legend={history ? legend : undefined}
      loading={q.isFetching}
      actions={
        <>
          <Segmented size="sm" value={grouping} onChange={setGrouping} label="Grouping" options={[{ value: 'wrapper', label: 'Wrapper' }, { value: 'access', label: 'Access' }]} />
          <Segmented
            size="sm"
            value={range}
            onChange={setRange}
            label="Range"
            options={[
              { value: '6m', label: '6M' },
              { value: '1y', label: '1Y' },
              { value: '3y', label: '3Y' },
              { value: 'all', label: 'All' },
            ]}
          />
        </>
      }
      table={
        d
          ? {
              columns: ['Date', ...d.groups.map((g) => g.label), 'Estate value'],
              rows: d.dates.map((date, i) => [formatDate(date), ...d.groups.map((g) => money(g.values[i])), i < partialBefore ? `${money(d.total[i])} (incomplete)` : money(d.total[i])]).reverse(),
            }
          : undefined
      }
    >
      {d ? (
        history ? (
          <TimeChart dates={d.dates} series={series} height={280} partialBefore={partialBefore} partialLabel={d.completeFrom ? `Not every account has data before ${formatDate(d.completeFrom, { year: false })}` : undefined} ariaLabel="Estate value over time" />
        ) : (
          <div className="py-12 text-center text-sm text-ink-3">Not enough history yet. Older statements or balances will draw it.</div>
        )
      ) : (
        <Loading />
      )}
    </ChartFrame>
  );
}

function AccountsPanel({ accounts }: { accounts: AccountSummary[] }) {
  const open = accounts.filter((a) => a.status === 'open');
  const groups = WRAPPER_GROUPS.map((g) => ({ id: g, label: WRAPPER_GROUP_LABELS[g], items: open.filter((a) => (a.liability ? 'liabilities' : a.group) === g) })).filter((g) => g.items.length);
  return (
    <Card title="Accounts" actions={<Link to="/accounts" className="text-[13px] font-medium text-accent hover:underline">All accounts</Link>} padded={false}>
      <div className="divide-y divide-line">
        {groups.map((g) => (
          <div key={g.id} className="px-5 py-3">
            <div className="mb-1.5 flex items-center justify-between text-[12px] font-medium text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-[2px]" style={{ background: wrapperColor(g.id) }} />
                {g.label}
              </span>
              <Money value={g.items.reduce((s, a) => s + (a.includeInNetWorth ? (a.balanceGBP ?? 0) : 0), 0)} className="tabular" />
            </div>
            <ul>
              {g.items.map((a) => (
                <li key={a.id}>
                  <Link to={`/accounts/${a.id}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-panel-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-ink">{a.name}</div>
                      <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
                        {a.institutionName ?? a.typeLabel}
                        <span aria-hidden>·</span>
                        {a.stale ? (
                          <span className="inline-flex items-center gap-0.5 text-warn-ink">
                            <TriangleAlert className="size-3" /> {a.asOf ? timeAgo(a.asOf) : 'no data'}
                          </span>
                        ) : (
                          <span>{timeAgo(a.asOf)}</span>
                        )}
                      </div>
                    </div>
                    <span className="hidden sm:block">
                      <Sparkline values={a.sparkline} width={72} height={24} />
                    </span>
                    <div className="w-28 text-right">
                      {a.annualIncome !== null && !a.balanceGBP ? (
                        <>
                          <Money value={a.annualIncome} decimals={0} className="tabular text-[13.5px] font-medium text-ink" />
                          <div className="text-[11px] text-ink-3">a year, forecast</div>
                        </>
                      ) : (
                        <>
                          <Money value={a.balanceGBP} className={cn('tabular text-[13.5px] font-medium', a.includeInNetWorth ? 'text-ink' : 'text-ink-3')} />
                          {a.estimated ? <div className="text-[11px] text-ink-3">estimated</div> : !a.includeInNetWorth ? <div className="text-[11px] text-ink-3">not in estate</div> : null}
                        </>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TaxPanel() {
  const q = useApi<AllowancesResponse>(['allowances', 'current'], '/allowances');
  const a = q.data;
  if (!a) return <Card title="Tax year"><Loading /></Card>;
  return (
    <Card
      title={`Tax year ${a.taxYear.label}`}
      description={a.taxYear.daysLeft !== null ? `${a.taxYear.daysLeft} days left (ends 5 April)` : undefined}
      actions={<Link to="/tax" className="text-[13px] font-medium text-accent hover:underline">Details</Link>}
    >
      <div className="flex flex-col gap-4">
        <Meter label="ISA allowance" used={a.isa.used} limit={a.isa.allowance} atLeast={a.isa.incomplete !== null} />
        {a.lisa && <Meter label="Lifetime ISA" used={a.lisa.contributed} limit={a.lisa.allowance} atLeast={a.lisa.incomplete !== null} sub={<>Bonus <Money value={a.lisa.bonusExpected} decimals={0} /></>} />}
        <Meter label="Pension annual allowance" used={a.pension.total} limit={a.pension.annualAllowance} atLeast={a.pension.incomplete !== null} sub="Incl. employer and tax relief" />
        <Meter label="Savings interest vs allowance" used={a.savings.interest} limit={a.savings.allowance} atLeast={a.savings.incomplete !== null} overLabel="Taxable" sub={`Tax band: ${bandLabel({ band: a.savings.band, basis: a.savings.bandBasis })}`} />
      </div>
    </Card>
  );
}

function MonthlyPanel() {
  const q = useApi<MonthlyChecklistResponse>(['monthly'], '/monthly');
  const m = q.data;
  if (!m || m.total === 0) return null;
  const due = m.items.filter((i) => i.due);
  return (
    <Card title="Monthly update" description={`${m.done} of ${m.total} accounts up to date for ${formatMonth(m.month)}`} actions={<Link to="/import"><Button size="sm" variant={due.length ? 'primary' : 'secondary'} icon={<Upload className="size-3.5" />}>Update</Button></Link>}>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full rounded-full bg-[var(--seq-5)]" style={{ width: `${(m.done / m.total) * 100}%` }} />
      </div>
      {due.length ? (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {due.slice(0, 5).map((i) => (
            <li key={i.accountId} className="flex items-center justify-between gap-2">
              <span className="truncate text-ink">{i.name}</span>
              <Badge tone={i.status === 'overdue' || i.status === 'never' ? 'warn' : 'neutral'}>{i.want === 'statement' ? 'statement' : i.want === 'screenshot' ? 'screenshot' : 'balance'}</Badge>
            </li>
          ))}
          {due.length > 5 && <li className="text-ink-3">and {due.length - 5} more</li>}
        </ul>
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-good-ink">
          <ListChecks className="size-4" /> Everything is up to date.
        </div>
      )}
    </Card>
  );
}

function Kpis({ summary }: { summary: SummaryResponse }) {
  const k = summary.kpis;
  const m = summary.monthToDate;
  const pensions = summary.groups.find((g) => g.id === 'pensions')?.value ?? 0;
  const basis = (
    <span className="inline-flex flex-wrap items-center gap-1">
      {k.basis}
      {k.savingsRate !== null && k.confidence !== 'high' && <Badge tone="muted">{k.confidence} confidence</Badge>}
    </span>
  );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Spent this month" value={<Money value={m.spending} decimals={0} />} delta={m.change !== null ? <Delta value={m.change} upIsGood={false} label="vs last month so far" /> : undefined} sub={m.note ?? undefined} />
      <Stat label="Savings rate" value={pct(k.savingsRate, 0)} sub={k.monthlySaving !== null ? <span>{money(k.monthlySaving, { decimals: 0 })} a month saved · {basis}</span> : basis} />
      <Stat label="Cash runway" value={k.runwayMonths !== null ? `${k.runwayMonths.toFixed(1)} months` : '—'} sub={k.runwayMonths !== null ? 'accessible cash ÷ monthly spending' : basis} />
      <Stat label="Pensions" value={<Money value={pensions} decimals={0} />} sub={<Link to="/investments" className="text-accent hover:underline">Retirement outlook</Link>} />
    </div>
  );
}

function CoverageNote({ summary }: { summary: SummaryResponse }) {
  const c = summary.coverage;
  if (!summary.hasData) return null;
  if (!c.jointTo && !c.limiting.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
      <span>
        {c.lastCompleteMonth ? <>Complete data for every account up to <span className="text-ink-2">{formatMonth(c.lastCompleteMonth)}</span></> : 'No month has data for every account yet'}
        {c.jointTo && <>; latest day covered by all: <span className="text-ink-2">{formatDate(c.jointTo)}</span></>}.
      </span>
      {c.limiting.length > 0 && <span>Missing most recently: {c.limiting.slice(0, 3).map((l) => l.name).join(', ')}.</span>}
      <Link to="/settings#health" className="text-accent hover:underline">Coverage</Link>
    </div>
  );
}

function Onboarding() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="grid gap-6 md:grid-cols-[1fr_1.2fr] md:items-center">
          <div>
            <h2 className="text-xl font-semibold text-ink">Let’s build your picture</h2>
            <p className="mt-2 text-sm text-ink-2">Everything stays on this machine as plain files in <code className="rounded bg-panel-2 px-1">data/</code>, versioned in git. Three steps get you going:</p>
            <ol className="mt-4 flex flex-col gap-3 text-sm text-ink-2">
              <li><span className="font-semibold text-ink">1. Tell it a little about you.</span> Date of birth and tax band unlock the LISA, pension and savings-allowance rules. <button className="text-accent hover:underline" onClick={() => navigate('/settings')}>Open settings</button></li>
              <li><span className="font-semibold text-ink">2. Drop in last month’s statements.</span> CSV exports are read instantly; PDFs and app screenshots are read by Claude.</li>
              <li><span className="font-semibold text-ink">3. Review and commit.</span> Nothing is saved until you check it against the original.</li>
            </ol>
          </div>
          <DropZone />
        </div>
      </Card>
    </div>
  );
}

/** Pay owed to you and not yet paid (timesheet work, payslips you said are owed): pending beside the estate, not counted in it (FORMULAS §17). */
function OwedLine({ owed }: { owed: NonNullable<SummaryResponse['owed']> }) {
  const payslips = owed.items.filter((i) => i.kind === 'payslip');
  const work = owed.items.filter((i) => i.kind !== 'payslip');
  const when = owed.late ? 'late' : owed.next ? `expected about ${formatDate(owed.next, { year: false })}` : 'when its payslip comes';
  return (
    <Link to="/tax/pay" className="-mx-2 mt-2 flex items-start gap-2 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-panel-2">
      <Badge tone={owed.late ? 'warn' : 'muted'}>Pending</Badge>
      <span className="min-w-0 flex-1 text-ink-3">
        <span className="font-medium text-ink-2">{owed.net !== null ? <Money value={owed.net} decimals={0} /> : <Money value={owed.gross} decimals={0} />}</span> pay owed to you{owed.net !== null ? <> after {work.length ? 'estimated ' : ''}tax and NI (<Money value={owed.gross} decimals={0} /> before)</> : ' before tax'}
        {payslips.length > 0 && (
          <>
            : {payslips.map((i) => `${i.payroll}’s ${i.periods[0] ? formatMonth(i.periods[0]) : ''} pay`).join(', ')}, which you said will be paid
            {work.length > 0 && <>, and timesheet work {when}</>}
          </>
        )}
        {!payslips.length && <>, {when}</>}. Not counted until it arrives.
      </span>
    </Link>
  );
}

const ALERT_ICON = { info: Info, warning: TriangleAlert, critical: CircleAlert };

export default function Dashboard() {
  const q = useApi<SummaryResponse>(['summary'], '/summary');
  const recent = useApi<TransactionsResponse>(['transactions', 'recent'], `/transactions${qs({ limit: 8, transfers: 'exclude' })}`);
  const { data } = useAppData();
  const s = q.data;
  const groups = useMemo(() => (s ? [...s.groups].sort((a, b) => WRAPPER_GROUPS.indexOf(a.id) - WRAPPER_GROUPS.indexOf(b.id)) : []), [s]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!s) return <Loading />;
  const first = data.profile.name ? `, ${data.profile.name.split(' ')[0]}` : '';
  const estimates = s.accounts.filter((a) => a.includeInNetWorth && a.estimated && a.balanceGBP);
  return (
    <div>
      <PageHeader title={`Overview${first}`} subtitle={formatDate(s.asOf)} actions={s.hasData ? <Link to="/import"><Button variant="primary" icon={<Upload className="size-4" />}>Import</Button></Link> : undefined} />
      {!s.hasData ? (
        <Onboarding />
      ) : (
        <div className="flex flex-col gap-5">
          {s.alerts.length > 0 && (
            <ul className="flex flex-col gap-2">
              {s.alerts.map((a) => {
                const Icon = ALERT_ICON[a.level];
                return (
                  <li key={a.id} className={cn('flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[13px]', a.level === 'critical' ? 'border-transparent bg-bad-soft' : a.level === 'warning' ? 'border-transparent bg-warn-soft' : 'border-line bg-panel')}>
                    <Icon className={cn('size-4 shrink-0', a.level === 'critical' ? 'text-bad-ink' : a.level === 'warning' ? 'text-warn-ink' : 'text-accent')} />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-ink">{a.title}</span>
                      {a.detail && <span className="ml-2 text-ink-3">{a.detail}</span>}
                    </div>
                    {a.action && (
                      <Link to={a.action.href} className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline">
                        {a.action.label} <ArrowRight className="size-3.5" />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <section className="grid gap-5 xl:grid-cols-[minmax(260px,320px)_1fr]">
            <div className="flex flex-col justify-center rounded-xl border border-line bg-panel px-6 py-5 shadow-card">
              <div className="text-[13px] font-medium text-ink-3">Estate value</div>
              <div className="sensitive mt-1 text-[48px] leading-none font-semibold tracking-tight text-ink">{money(s.estate.value, { decimals: 0 })}</div>
              <div className="mt-1.5 text-[12.5px] text-ink-3">
                Everything you hold, minus <Money value={Math.abs(s.estate.liabilities)} decimals={0} /> you owe
              </div>
              {estimates.length > 0 && (
                <div className="mt-1 text-[12.5px] text-ink-3">
                  Includes estimates for {estimates.length} account{estimates.length > 1 ? 's' : ''}: <Money value={estimates.reduce((sum, a) => sum + (a.balanceGBP ?? 0), 0)} decimals={0} />
                </div>
              )}
              {s.owed && <OwedLine owed={s.owed} />}
              <ul className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
                {s.deltas.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="text-ink-3">{d.label}</span>
                    <Delta value={d.change} percent={d.pct} />
                  </li>
                ))}
                {s.deltas.every((d) => d.change === null) && <li className="text-[12px] text-ink-3">Changes show once every account has data from before then.</li>}
              </ul>
              <ul className="mt-4 flex flex-col gap-1 border-t border-line pt-3 text-[12.5px]">
                {groups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-ink-2">
                      <span className="inline-block size-2 rounded-[2px]" style={{ background: wrapperColor(g.id) }} />
                      {g.label}
                    </span>
                    <Money value={g.value} decimals={0} className="tabular text-ink" />
                  </li>
                ))}
              </ul>
            </div>
            <EstateChart />
          </section>

          <Kpis summary={s} />
          <CoverageNote summary={s} />
          <InsightsPanel page="overview" title="Month in review and what to look at" />

          <section className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <AccountsPanel accounts={s.accounts} />
            <div className="flex flex-col gap-5">
              <MonthlyPanel />
              <GoalsPanel />
              <TaxPanel />
            </div>
          </section>

          <Card title="Recent activity" actions={<Link to="/transactions" className="text-[13px] font-medium text-accent hover:underline">All transactions</Link>} padded={false}>
            {recent.data?.items.length ? <TransactionList items={recent.data.items} compact /> : <EmptyState title="No transactions yet" />}
          </Card>
          {data.demo && <Callout tone="neutral">You are looking at generated demo data. Your real data lives in <code>data/</code>.</Callout>}
        </div>
      )}
    </div>
  );
}
