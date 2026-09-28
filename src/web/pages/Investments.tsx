import { useState } from 'react';
import { Link } from 'react-router';
import type { InvestmentsResponse } from '../../shared/api';
import { formatDate } from '../../shared/dates';
import { AllocationBar } from '../components/charts/bars';
import { ChartFrame, SERIES } from '../components/charts/common';
import { TimeChart } from '../components/charts/TimeChart';
import { formatAssumptionValue } from '../../shared/assumptions';
import { AssumptionsLink, InsightsPanel, SourceTag } from '../components/Intel';
import { Callout, Card, EmptyState, KeyValue, Loading, Money, PageHeader, Select, Stat, tableClasses } from '../components/ui';
import { useApi } from '../lib/api';
import { cn, money, pct } from '../lib/format';

const ASSET_LABELS: Record<string, string> = {
  equity: 'Shares',
  bond: 'Bonds',
  mixed: 'Mixed funds',
  property: 'Property',
  cash: 'Cash',
  commodity: 'Commodities',
  crypto: 'Crypto',
  other: 'Other',
  unclassified: 'Unclassified',
  unknown: 'Holdings not known',
};
const ASSET_ORDER = ['equity', 'mixed', 'bond', 'property', 'commodity', 'crypto', 'cash', 'other', 'unclassified', 'unknown'];

export default function Investments() {
  const q = useApi<InvestmentsResponse>(['investments'], '/investments');
  const [selected, setSelected] = useState<string>('');
  const d = q.data;
  if (!d) return <Loading />;
  if (!d.accounts.length) {
    return (
      <div>
        <PageHeader title="Investments & pensions" />
        <Card>
          <EmptyState title="No investment or pension accounts yet">Upload a screenshot of your ISA, LISA, SIPP or workplace pension app. Its value, contributions and holdings are read automatically.</EmptyState>
        </Card>
      </div>
    );
  }
  const current = d.accounts.find((a) => a.id === selected) ?? d.accounts.find((a) => a.history.length > 1) ?? d.accounts[0]!;
  const lisas = d.accounts.filter((a) => a.lisa);
  const funds = d.accounts.flatMap((a) => a.params.holdings.filter((h) => h.name !== 'Uninvested cash' && a.params.holdingsKnown).map((h) => ({ ...h, account: a.name, accountId: a.id })));
  const r = d.retirement;
  return (
    <div>
      <PageHeader title="Investments & pensions" subtitle="ISAs, LISA, general accounts and pensions" />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Invested value" value={<Money value={d.totals.value} decimals={0} />} />
        <Stat label="Paid in" value={<Money value={d.totals.contributions} decimals={0} />} sub="as reported or from your contributions" />
        <Stat label="Growth" value={<Money value={d.totals.growth} decimals={0} />} sub={d.totals.contributions ? pct(d.totals.growth / d.totals.contributions, 1, true) : undefined} />
        <Stat label="Pensions" value={<Money value={d.totals.pensions} decimals={0} />} sub={<>ISAs <Money value={d.totals.isas} decimals={0} /></>} />
        <Stat label="Charges this year" value={<Money value={d.totals.annualCharges} decimals={0} />} sub={d.totals.value ? `${pct(d.totals.annualCharges / d.totals.value, 2)} of the value` : undefined} />
      </div>

      <Card title="Accounts" padded={false} className="mb-5">
        <div className="overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Account</th>
                <th className={cn(tableClasses.th, 'text-right')}>Value</th>
                <th className={cn(tableClasses.th, 'text-right')}>Paid in</th>
                <th className={cn(tableClasses.th, 'text-right')}>Growth</th>
                <th className={cn(tableClasses.th, 'text-right')} title="Money-weighted annual return">Annual return</th>
                <th className={cn(tableClasses.th, 'text-right')} title="Fund charges plus the platform fee, this year">Charges</th>
                <th className={cn(tableClasses.th, 'text-right')} title="What the charges cost by retirement (or over 10 years), in today's money">Cost of charges</th>
                <th className={tableClasses.th}>As of</th>
              </tr>
            </thead>
            <tbody>
              {d.accounts.map((a) => (
                <tr key={a.id} className="hover:bg-panel-2">
                  <td className={tableClasses.td}>
                    <Link to={`/accounts/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-[12px] text-ink-3">{a.typeLabel}</div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                    <Money value={a.value} decimals={0} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={a.contributions} decimals={0} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, a.growth !== null && a.growth < 0 ? 'text-bad-ink' : '')}>
                    {a.growth !== null ? (
                      <>
                        <Money value={a.growth} decimals={0} />
                        <span className="ml-1 text-ink-3">{pct(a.growthPct, 1, true)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{a.xirr !== null ? pct(a.xirr, 1, true) : '—'}</td>
                  <td className={cn(tableClasses.td, 'text-right')} title={`Fund: ${a.params.fundFee.basis}\nPlatform: ${a.params.platformFee.basis}`}>
                    <div className="tabular">{formatAssumptionValue('fee.fund', a.charges.rate)}</div>
                    <div className="inline-flex items-center gap-1 text-[11.5px] text-ink-3">
                      <Money value={a.charges.annual} decimals={0} /> a year <SourceTag value={a.params.fundFee.source === 'fallback' ? a.params.platformFee : a.params.fundFee} />
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={a.charges.drag} decimals={0} />
                    <div className="text-[11.5px] text-ink-3">over {a.charges.horizonYears} years</div>
                  </td>
                  <td className={cn(tableClasses.td, 'text-ink-3')}>{a.asOf ? formatDate(a.asOf) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <ChartFrame
          title="Value and money paid in"
          subtitle={current.name}
          actions={
            <Select value={current.id} onChange={(e) => setSelected(e.target.value)} className="h-8 w-56 text-[13px]" aria-label="Account">
              {d.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          }
          legend={[
            { label: 'Value', color: SERIES[0]!, kind: 'line' },
            { label: 'Paid in', color: SERIES[1]!, kind: 'line' },
          ]}
          table={{ columns: ['Date', 'Value', 'Paid in'], rows: [...current.history].reverse().map((h) => [formatDate(h.date), money(h.value), h.contributions !== null ? money(h.contributions) : null]) }}
        >
          {current.history.length > 1 ? (
            <TimeChart
              dates={current.history.map((h) => h.date)}
              series={[
                { id: 'value', label: 'Value', color: SERIES[0]!, values: current.history.map((h) => h.value), kind: 'line', markers: true },
                { id: 'paid', label: 'Paid in', color: SERIES[1]!, values: current.history.map((h) => h.contributions), kind: 'line' },
              ]}
              height={250}
              ariaLabel={`${current.name} value and contributions`}
            />
          ) : (
            <div className="py-10 text-center text-[13px] text-ink-3">One valuation so far. Upload a screenshot each month to build the history.</div>
          )}
        </ChartFrame>
        <Card title="What you own" description="From the latest holdings of each account; accounts whose holdings are not known yet are shown apart">
          {d.allocation.length ? (
            <>
              <AllocationBar
                parts={[...d.allocation]
                  .sort((a, b) => ASSET_ORDER.indexOf(a.assetClass) - ASSET_ORDER.indexOf(b.assetClass))
                  .map((a) => ({ id: a.assetClass, label: ASSET_LABELS[a.assetClass] ?? a.assetClass, value: a.value, color: a.assetClass === 'unclassified' || a.assetClass === 'unknown' ? 'var(--deemph)' : SERIES[ASSET_ORDER.indexOf(a.assetClass) % 7]! }))}
              />
              <table className={cn(tableClasses.table, 'mt-4')}>
                <tbody>
                  {d.allocation.map((a) => (
                    <tr key={a.assetClass}>
                      <td className={tableClasses.td}>{ASSET_LABELS[a.assetClass] ?? a.assetClass}</td>
                      <td className={cn(tableClasses.td, tableClasses.num)}>
                        <Money value={a.value} decimals={0} />
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num, 'text-ink-3')}>{pct(a.share, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="text-[13px] text-ink-3">Holdings appear when a screenshot or statement lists your funds.</div>
          )}
        </Card>
      </div>

      {funds.length > 0 && (
        <Card title="Your funds" description="Each holding’s charge and make-up, and where each figure came from" padded={false} className="mb-5">
          <div className="overflow-x-auto">
            <table className={tableClasses.table}>
              <thead>
                <tr>
                  <th className={tableClasses.th}>Holding</th>
                  <th className={tableClasses.th}>Account</th>
                  <th className={cn(tableClasses.th, 'text-right')}>Value</th>
                  <th className={cn(tableClasses.th, 'text-right')}>Fund charge</th>
                  <th className={tableClasses.th}>Make-up</th>
                </tr>
              </thead>
              <tbody>
                {funds.map((h) => (
                  <tr key={`${h.accountId}-${h.name}`}>
                    <td className={tableClasses.td}>
                      <div className="font-medium text-ink">{h.name}</div>
                      {!h.instrumentId && <div className="text-[11.5px] text-ink-3">Not researched yet</div>}
                    </td>
                    <td className={cn(tableClasses.td, 'text-ink-2')}>{h.account}</td>
                    <td className={cn(tableClasses.td, tableClasses.num)}>
                      <Money value={h.value} decimals={0} />
                    </td>
                    <td className={cn(tableClasses.td, 'text-right')} title={h.fundFee.basis}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="tabular">{formatAssumptionValue('fee.fund', h.fundFee.value)}</span> <SourceTag value={h.fundFee} />
                      </span>
                    </td>
                    <td className={cn(tableClasses.td, 'text-[12.5px] text-ink-3')}>{h.exposureBasis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <InsightsPanel page="investments" title="Claude’s notes on your investments" className="mb-5" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Retirement outlook" description={`At age ${r.age}${r.date ? ` (${formatDate(r.date)})` : ''}, in today’s money`}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Pension pots today" value={<Money value={r.potToday} decimals={0} />} />
            <Stat
              label="Going in each month"
              value={<Money value={r.monthlyPersonal + r.monthlyExternal} decimals={0} />}
              sub={
                <span>
                  <Money value={r.monthlyPersonal} decimals={0} /> from your bank · <Money value={r.monthlyExternal} decimals={0} /> from pay, employer and relief
                </span>
              }
            />
            <Stat
              label="Pots at retirement"
              value={r.pot ? <Money value={r.pot.p50} decimals={0} /> : '—'}
              sub={r.pot ? <span className="sensitive">range {money(r.pot.p10, { decimals: 0 })} – {money(r.pot.p90, { decimals: 0 })}</span> : 'add your date of birth'}
            />
            <Stat
              label="Income they sustain"
              value={r.income ? <Money value={r.income.p50} decimals={0} /> : '—'}
              sub={
                <span className="inline-flex flex-wrap items-center gap-1">
                  a year at {formatAssumptionValue('withdrawal.rate', r.withdrawalRate.value)} <SourceTag value={r.withdrawalRate} />
                </span>
              }
            />
          </div>
          <KeyValue
            className="mt-4"
            items={[
              [
                'State Pension',
                r.statePension ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Money value={r.statePension.annual} decimals={0} /> a year{r.statePension.startsOn ? ` from ${formatDate(r.statePension.startsOn)}` : ''}
                    <SourceTag value={{ source: r.statePension.source === 'forecast' ? 'statement' : 'fallback', basis: r.statePension.basis }} />
                  </span>
                ) : (
                  'Add your date of birth in Settings'
                ),
              ],
              ...(r.dbIncome ? ([['Defined-benefit pensions', <span><Money value={r.dbIncome} decimals={0} /> a year</span>]] as [string, React.ReactNode][]) : []),
              ['Tax-free cash', `Usually ${Math.round(r.taxFreeCash.share * 100)}% of each pot${r.taxFreeCash.lumpSumAllowance ? `, up to £${r.taxFreeCash.lumpSumAllowance.toLocaleString('en-GB')} in all` : ''}`],
            ]}
          />
          <ul className="mt-3 list-disc pl-5 text-[12.5px] text-ink-3">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>
              Change the assumptions on <AssumptionsLink />.
            </li>
          </ul>
        </Card>
        {lisas.length > 0 ? (
          <Card title="Lifetime ISA">
            {lisas.map((a) => (
              <KeyValue
                key={a.id}
                className="mb-3"
                items={[
                  ['Account', a.name],
                  ['Value', <Money value={a.value} />],
                  ['Bonus received', <Money value={a.lisa!.bonusToDate} />],
                  ['If withdrawn early', <span><Money value={a.lisa!.penaltyAdjustedValue} /> <span className="text-ink-3">after the 25% charge</span></span>],
                  ['Penalty-free from', a.lisa!.penaltyFreeFrom ? `${formatDate(a.lisa!.penaltyFreeFrom)} (age 60), or for a first home up to £450,000` : 'Age 60, or for a first home up to £450,000'],
                ]}
              />
            ))}
            <Callout tone="neutral">A First Time Buyer ISA is to be offered in place of the LISA once available (no date yet). Existing LISAs carry on under today’s rules.</Callout>
          </Card>
        ) : (
          <Card title="Pension access">
            <KeyValue items={d.accounts.filter((a) => a.pension).map((a) => [a.name, a.pension!.accessDate ? formatDate(a.pension!.accessDate) : 'Add your date of birth in Settings'])} />
            <p className="mt-3 text-[12.5px] text-ink-3">The normal minimum pension age rises from 55 to 57 on 6 April 2028.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
