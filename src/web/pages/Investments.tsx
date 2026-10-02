import { useState } from 'react';
import { Link } from 'react-router';
import type { InvestmentsResponse } from '../../shared/api';
import { formatDate } from '../../shared/dates';
import { AllocationBar } from '../components/charts/bars';
import { ChartFrame, SERIES } from '../components/charts/common';
import { TimeChart } from '../components/charts/TimeChart';
import { formatAssumptionValue } from '../../shared/assumptions';
import { AssumptionsLink, InsightsPanel, SourceTag } from '../components/Intel';
import { Callout, Card, EmptyState, KeyValue, Loading, Money, PageHeader, Select, SortHeader, Stat, tableClasses } from '../components/ui';
import { useApi } from '../lib/api';
import { cn, money, pct } from '../lib/format';
import { Sorted } from '../lib/sort';

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

/** HMRC's State Pension forecast in full, and your National Insurance record year by year. */
function StatePensionCard({ r }: { r: InvestmentsResponse['retirement'] }) {
  const h = r.statePension?.hmrc;
  if (!h && !r.niRecord.length) return null;
  const gaps = r.niRecord.filter((y) => y.status === 'not-full');
  return (
    <Card title="State Pension and National Insurance" description={h ? `HMRC’s forecast of ${formatDate(h.asOf)}, in today’s money` : 'Your National Insurance record, as HMRC’s pages showed it'}>
      {h && (
        <KeyValue
          items={[
            ['Forecast', <span><Money value={h.weekly} /> a week (<Money value={h.annual} decimals={0} /> a year){h.maximum ? ', the most you can get' : ''}</span>],
            ...(h.payableFrom ? ([['From', formatDate(h.payableFrom)]] as [string, React.ReactNode][]) : []),
            ...(h.qualifyingYears !== undefined
              ? ([
                  [
                    'Qualifying years',
                    `${h.qualifyingYears} so far${h.recordTo ? ` (to ${formatDate(h.recordTo)})` : ''}${h.assumesYears !== undefined ? `; the forecast assumes ${h.assumesYears} more` : ''}${h.yearsNeeded !== undefined ? `; ${h.yearsNeeded} are needed for any State Pension` : ''}`,
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
      )}
      {r.niRecord.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[12px] font-medium text-ink-3">National Insurance record</div>
          <ul className="flex flex-col gap-0.5 text-[13px]">
            {r.niRecord.map((y) => (
              <li key={y.taxYear} className="flex flex-wrap justify-between gap-x-3">
                <span className="tabular text-ink-2">{y.taxYear}</span>
                <span className={cn('text-right', y.status === 'not-full' ? 'text-warn-ink' : y.status === 'full' ? 'text-ink-2' : 'text-ink-3')}>
                  {y.status === 'full' ? 'Full year' : y.status === 'not-full' ? 'Not full' : y.status === 'not-available' ? 'Not available yet' : (y.text ?? 'See HMRC')}
                  {y.voluntaryCost !== undefined && (
                    <>
                      {' '}
                      · <Money value={y.voluntaryCost} /> fills it{y.payBy ? `, by ${formatDate(y.payBy)}` : ''}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {gaps.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              {gaps.length} year{gaps.length === 1 ? ' is' : 's are'} not full.{' '}
              {h?.maximum ? 'HMRC’s forecast already says it is the most you can get, so filling them would not raise it unless you have fewer qualifying years than it assumes.' : 'Filling one raises your State Pension only if it brings you closer to the qualifying years the full amount needs: check with the Future Pension Centre before you pay.'}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

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
        <Stat label="Paid in" value={<Money value={d.totals.contributions} decimals={0} />} sub={d.totals.paidInUnknown ? `not known yet for ${d.totals.paidInUnknown} account${d.totals.paidInUnknown > 1 ? 's' : ''}` : 'as reported or from your contributions'} />
        <Stat label="Growth" value={<Money value={d.totals.growth} decimals={0} />} sub={d.totals.growthPct !== null ? `${pct(d.totals.growthPct, 1, true)}${d.totals.paidInUnknown ? ' on the accounts with paid in known' : ''}` : 'needs what you paid in'} />
        <Stat label="Pensions" value={<Money value={d.totals.pensions} decimals={0} />} sub={<>ISAs <Money value={d.totals.isas} decimals={0} /></>} />
        <Stat label="Charges this year" value={<Money value={d.totals.annualCharges} decimals={0} />} sub={d.totals.value ? `${pct(d.totals.annualCharges / d.totals.value, 2)} of the value` : undefined} />
      </div>

      <Card title="Accounts" padded={false} className="mb-5">
        <div className="overflow-x-auto">
          <Sorted rows={d.accounts} columns={{ account: { value: (a) => a.name }, value: { value: (a) => a.value }, paidIn: { value: (a) => a.contributions }, growth: { value: (a) => a.growth }, xirr: { value: (a) => a.xirr }, charges: { value: (a) => a.charges.rate }, drag: { value: (a) => a.charges.drag }, asOf: { value: (a) => a.asOf, first: 'desc' } }}>
            {({ rows, sortProps }) => (
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <SortHeader label="Account" sort={sortProps('account')} />
                    <SortHeader label="Value" sort={sortProps('value')} numeric />
                    <SortHeader label="Paid in" sort={sortProps('paidIn')} numeric />
                    <SortHeader label="Growth" sort={sortProps('growth')} numeric />
                    <SortHeader label="Annual return" sort={sortProps('xirr')} numeric title="Money-weighted annual return" />
                    <SortHeader label="Charges" sort={sortProps('charges')} numeric title="Fund charges plus the platform fee, this year" />
                    <SortHeader label="Cost of charges" sort={sortProps('drag')} numeric title="What the charges cost by retirement (or over 10 years), in today's money" />
                    <SortHeader label="As of" sort={sortProps('asOf')} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className="hover:bg-panel-2">
                      <td className={tableClasses.td}>
                        <Link to={`/accounts/${a.id}`} className="font-medium hover:underline">
                          {a.name}
                        </Link>
                        <div className="text-[12px] text-ink-3">{a.typeLabel}</div>
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                        <Money value={a.value} decimals={0} />
                        {a.estimated && <div className="text-[11px] font-normal text-ink-3">estimated</div>}
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num)}>
                        <Money value={a.contributions} decimals={0} />
                      </td>
                      <td className={cn(tableClasses.td, tableClasses.num, a.growth !== null && a.growth < 0 ? 'text-bad-ink' : '')}>
                        {a.growth !== null ? (
                          <>
                            <Money value={a.growth} decimals={0} />
                            <span className="ml-1 text-ink-3">{pct(a.growthPct, 1, true)}</span>
                            {a.estimated && <div className="text-[11px] text-ink-3">from an estimate</div>}
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
            )}
          </Sorted>
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
            <div className="py-10 text-center text-[13px] text-ink-3">{current.history.length ? 'One valuation so far. Upload a screenshot each month to build the history.' : 'No valuations yet. Upload a statement or screenshot to start the history.'}</div>
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
            <Sorted rows={funds} columns={{ name: { value: (h) => h.name }, account: { value: (h) => h.account }, value: { value: (h) => h.value }, fee: { value: (h) => h.fundFee.value } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Holding" sort={sortProps('name')} />
                      <SortHeader label="Account" sort={sortProps('account')} />
                      <SortHeader label="Value" sort={sortProps('value')} numeric />
                      <SortHeader label="Fund charge" sort={sortProps('fee')} numeric />
                      <th className={tableClasses.th}>Make-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => (
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
              )}
            </Sorted>
          </div>
        </Card>
      )}

      <InsightsPanel page="investments" title="Agent notes on your investments" className="mb-5" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Retirement outlook" description={`At age ${r.age}${r.date ? ` (${formatDate(r.date)})` : ''}, in today’s money`}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Pension pots today" value={<Money value={r.potToday} decimals={0} />} />
            <Stat
              label="Going in each month"
              value={r.contributionsKnown ? <Money value={r.monthlyPersonal + r.monthlyExternal} decimals={0} /> : 'Not known yet'}
              sub={
                r.contributionsKnown ? (
                  <span>
                    <Money value={r.monthlyPersonal} decimals={0} /> from your bank · <Money value={r.monthlyExternal} decimals={0} /> from pay, employer and relief
                  </span>
                ) : (
                  'needs a month of data for every account'
                )
              }
            />
            <Stat
              label={r.contributionsKnown ? 'Pots at retirement' : 'Pots at retirement, with nothing more paid in'}
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
        <StatePensionCard r={r} />
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
