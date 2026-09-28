import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { AccountParamsSummary, ProjectionResponse, ProjectionScenario } from '../../shared/api';
import { formatAssumptionValue } from '../../shared/assumptions';
import { addMonths, formatDate, formatMonth, today } from '../../shared/dates';
import { taxYearOf } from '../../shared/uk';
import { ChartFrame, SERIES } from '../components/charts/common';
import { TimeChart, type TimeSeries } from '../components/charts/TimeChart';
import { AssumptionsLink, InsightsPanel, SourceTag } from '../components/Intel';
import { Badge, Callout, Card, Field, Input, Loading, Money, PageHeader, Segmented, Select, Stat, tableClasses } from '../components/ui';
import { qs, useApi } from '../lib/api';
import { cn, compact, money, pct } from '../lib/format';

const HORIZONS = [
  { value: '12', label: '1Y' },
  { value: '24', label: '2Y' },
  { value: '60', label: '5Y' },
  { value: '120', label: '10Y' },
  { value: '240', label: '20Y' },
  { value: '480', label: '40Y' },
] as const;

const rate = (v: number) => formatAssumptionValue('return.expected', v);

function basisText(s: ProjectionScenario): string {
  if (s.basis.kind === 'months') {
    const m = s.basis.months;
    return m.length === 1 ? `${formatMonth(m[0]!)} (1 complete month)` : `${m.length} complete months, ${formatMonth(m[0]!, { short: true })} – ${formatMonth(m[m.length - 1]!, { short: true })}`;
  }
  return `${s.basis.days} days with data for every account (no complete month yet)`;
}

function ScenarioCard({ s, color }: { s: ProjectionScenario; color: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3.5 shadow-card">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <svg width="18" height="8" aria-hidden>
          <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        {s.label}
        {s.available && <Badge tone={s.confidence === 'high' ? 'neutral' : 'muted'} className="ml-auto">{s.confidence} confidence</Badge>}
      </div>
      <div className="mt-0.5 text-[12px] text-ink-3">{s.available ? `Based on ${basisText(s)}` : `${formatDate(s.from)} – ${formatDate(s.to)}`}</div>
      {s.available ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-3">Income / month</dt>
          <dd className="text-right"><Money value={s.monthly.income} decimals={0} /></dd>
          <dt className="text-ink-3">Spending / month</dt>
          <dd className="text-right"><Money value={s.monthly.spending} decimals={0} /></dd>
          <dt className="text-ink-3">Left over</dt>
          <dd className={cn('text-right font-semibold', s.monthly.net >= 0 ? 'text-good-ink' : 'text-bad-ink')}><Money value={s.monthly.net} decimals={0} /></dd>
          <dt className="text-ink-3">You invest</dt>
          <dd className="text-right"><Money value={s.monthly.investing} decimals={0} /></dd>
          <dt className="text-ink-3" title="Payroll pension contributions, employer contributions, tax relief and the LISA bonus">From pay, employer and relief</dt>
          <dd className="text-right"><Money value={s.monthly.external} decimals={0} /></dd>
        </dl>
      ) : (
        <div className="mt-3 text-[13px] text-ink-3">
          {s.reason}
          {s.basis.limiting.length > 0 && <div className="mt-1">Missing most: {s.basis.limiting.slice(0, 3).map((l) => `${l.name} (${l.missingDays} days)`).join(', ')}.</div>}
        </div>
      )}
      {s.available && s.basis.limiting.length > 0 && <div className="mt-2 text-[12px] text-ink-3">Days without data for {s.basis.limiting.slice(0, 2).map((l) => l.name).join(' and ')} are left out.</div>}
    </div>
  );
}

function AccountRow({ a }: { a: AccountParamsSummary }) {
  const [open, setOpen] = useState(false);
  const invest = a.bucket === 'market' || a.bucket === 'pension';
  return (
    <>
      <tr>
        <td className={tableClasses.td}>
          <button type="button" className="inline-flex items-center gap-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!invest || a.holdings.length < 1}>
            {invest && a.holdings.length > 0 ? open ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" /> : <span className="inline-block w-3.5" />}
            <span className="font-medium text-ink">{a.name}</span>
          </button>
          {invest && !a.holdingsKnown && <div className="ml-4.5 text-[11.5px] text-ink-3">Holdings not known yet</div>}
        </td>
        <td className={cn(tableClasses.td, tableClasses.num)}><Money value={a.value} decimals={0} /></td>
        <td className={cn(tableClasses.td, 'text-right')}>
          {invest ? (
            <span className="inline-flex items-center justify-end gap-1.5">
              <span className="tabular">{rate(a.expectedReturn.value)}</span>
              {a.expectedReturn.range && <span className="text-[11.5px] text-ink-3">({rate(a.expectedReturn.range.low)}–{rate(a.expectedReturn.range.high)})</span>}
              <SourceTag value={a.expectedReturn} />
            </span>
          ) : a.interest ? (
            <span className="inline-flex items-center justify-end gap-1.5">
              <span className="tabular">{rate(a.interest.value)}</span> <span className="text-[11.5px] text-ink-3">interest</span>
              <SourceTag value={a.interest} />
            </span>
          ) : a.growth ? (
            <span className="inline-flex items-center justify-end gap-1.5">
              <span className="tabular">{rate(a.growth.value)}</span> <span className="text-[11.5px] text-ink-3">growth</span>
              <SourceTag value={a.growth} />
            </span>
          ) : (
            <span className="text-ink-3">held flat</span>
          )}
        </td>
        <td className={cn(tableClasses.td, 'text-right')}>{invest ? <span className="tabular">{rate(a.volatility.value)}</span> : <span className="text-ink-3">—</span>}</td>
        <td className={cn(tableClasses.td, 'text-right')}>
          {invest ? (
            <span className="inline-flex items-center justify-end gap-1.5" title={`Fund charges: ${a.fundFee.basis}\nPlatform: ${a.platformFee.basis}`}>
              <span className="tabular">{rate(a.fundFee.value + a.platformFee.value)}</span>
              <SourceTag value={a.fundFee.source === 'fallback' ? a.platformFee : a.fundFee} />
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </td>
        <td className={cn(tableClasses.td, 'text-right font-medium')}>{a.netGrowth !== undefined ? <span className="tabular">{rate(a.netGrowth)}</span> : <span className="text-ink-3">—</span>}</td>
      </tr>
      {open &&
        a.holdings.map((h) => (
          <tr key={h.name} className="bg-panel-2/50">
            <td className={cn(tableClasses.td, 'pl-9 text-[12.5px]')}>
              <div className="text-ink-2">{h.name}</div>
              <div className="text-[11.5px] text-ink-3">{h.exposureBasis}</div>
            </td>
            <td className={cn(tableClasses.td, tableClasses.num, 'text-[12.5px]')}><Money value={h.value} decimals={0} /></td>
            <td className={cn(tableClasses.td, 'text-right text-[12.5px]')} title={h.expectedReturn.basis}>
              {rate(h.expectedReturn.value)} <SourceTag value={h.expectedReturn} />
            </td>
            <td className={cn(tableClasses.td, 'text-right text-[12.5px]')} title={h.volatility.basis}>{rate(h.volatility.value)}</td>
            <td className={cn(tableClasses.td, 'text-right text-[12.5px]')} title={h.fundFee.basis}>
              {rate(h.fundFee.value)} <SourceTag value={h.fundFee} />
            </td>
            <td className={tableClasses.td} />
          </tr>
        ))}
    </>
  );
}

export default function Projections() {
  const [months, setMonths] = useState<string>('120');
  const [adjust, setAdjust] = useState(0);
  const [units, setUnits] = useState<'real' | 'nominal'>('real');
  const [compare, setCompare] = useState<'none' | 'last-tax-year' | 'custom'>('none');
  const [customFrom, setCustomFrom] = useState(addMonths(today(), -24).slice(0, 7) + '-01');
  const [customTo, setCustomTo] = useState(addMonths(today(), -13).slice(0, 7) + '-28');
  const lastTy = taxYearOf(addMonths(taxYearOf(today()).start, -1));
  const past = compare === 'last-tax-year' ? { pastFrom: lastTy.start, pastTo: lastTy.end } : compare === 'custom' ? { pastFrom: customFrom, pastTo: customTo } : {};
  const q = useApi<ProjectionResponse>(['projections', months, adjust, units, past], `/projections${qs({ months, adjust: adjust / 100, units, ...past })}`);
  const p = q.data;
  const colorOf = (i: number) => SERIES[i]!;

  const chart = useMemo(() => {
    if (!p) return null;
    const hist = p.history;
    const futureDates = p.series[0]?.points.map((pt) => pt.date).slice(1) ?? [];
    const dates = [...hist.map((h) => h.date), ...futureDates];
    const splitIndex = hist.length - 1;
    const pad = <T,>(before: T[], after: T[]) => [...before, ...after];
    const series: TimeSeries[] = [{ id: 'history', label: 'Estate value', color: 'var(--ink-2)', values: [...hist.map((h) => h.value), ...futureDates.map(() => null)], kind: 'line' }];
    p.series.forEach((s) => {
      const i = p.scenarios.findIndex((x) => x.id === s.id);
      const head = hist.map((_, hi) => (hi === splitIndex ? s.points[0]!.total : null));
      series.push({ id: `${s.id}-band`, label: `${s.label.replace('If the ', '').replace(' continued', '')}: 80% range`, color: colorOf(i), kind: 'band', values: pad(head, s.points.slice(1).map((pt) => pt.band.p90)), lower: pad(head, s.points.slice(1).map((pt) => pt.band.p10)) });
      series.push({ id: s.id, label: s.label.replace('If the ', '').replace(' continued', ''), color: colorOf(i), kind: 'line', dashed: true, values: pad(head, s.points.slice(1).map((pt) => pt.total)) });
    });
    return { dates, series, splitIndex };
  }, [p]);

  const milestones = [12, 24, 60, 120, 240, 480].filter((m) => m <= Number(months));
  const invest = p?.accounts.filter((a) => a.bucket === 'market' || a.bucket === 'pension') ?? [];
  const other = p?.accounts.filter((a) => !(a.bucket === 'market' || a.bucket === 'pension')) ?? [];
  return (
    <div>
      <PageHeader title="Projections" subtitle="Where your estate value heads if your income, spending and saving carried on, each account growing at its own rate" />
      <div className="no-print mb-5 flex flex-wrap items-end gap-4">
        <Field label="Horizon">
          <Segmented value={months} onChange={setMonths} options={HORIZONS.map((h) => ({ value: h.value, label: h.label }))} />
        </Field>
        <Field label={`Spending ${adjust > 0 ? '+' : ''}${adjust}%`}>
          <input type="range" min={-40} max={40} step={5} value={adjust} onChange={(e) => setAdjust(Number(e.target.value))} className="h-9 w-48 accent-[var(--accent)]" aria-label="Spending adjustment" />
        </Field>
        <Field label="Shown in">
          <Segmented value={units} onChange={setUnits} options={[{ value: 'real', label: 'Today’s money' }, { value: 'nominal', label: 'Future pounds' }]} />
        </Field>
        <Field label="Also compare">
          <Select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className="w-52">
            <option value="none">Nothing else</option>
            <option value="last-tax-year">Last tax year ({lastTy.label})</option>
            <option value="custom">A period I choose</option>
          </Select>
        </Field>
        {compare === 'custom' && (
          <>
            <Field label="From">
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {!p || !chart ? (
        <Loading />
      ) : (
        <div className={cn('flex flex-col gap-5', q.isFetching ? 'opacity-70' : '')}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {p.scenarios.map((s, i) => (
              <ScenarioCard key={s.id} s={s} color={colorOf(i)} />
            ))}
          </div>

          {p.series.length ? (
            <ChartFrame
              title="Estate value: history and projection"
              subtitle={`Solid is what happened; dashed is the median of each scenario; the shaded range covers 80% of outcomes. ${units === 'real' ? 'In today’s money.' : 'In future pounds.'}`}
              legend={[
                { label: 'Estate value', color: 'var(--ink-2)', kind: 'line' },
                ...p.series.map((s) => ({ label: s.label.replace('If the ', '').replace(' continued', ''), color: colorOf(p.scenarios.findIndex((x) => x.id === s.id)), kind: 'dash' as const })),
                { label: 'Shaded: 80% range of each', color: 'var(--deemph)', kind: 'area' as const },
              ]}
              table={{
                columns: ['Date', ...p.series.flatMap((s) => [`${s.label} (median)`, '10th percentile', '90th percentile'])],
                rows: (p.series[0]?.points ?? []).map((pt, i) => [formatDate(pt.date), ...p.series.flatMap((s) => [money(s.points[i]?.total ?? null, { decimals: 0 }), money(s.points[i]?.band.p10 ?? null, { decimals: 0 }), money(s.points[i]?.band.p90 ?? null, { decimals: 0 })])]),
              }}
            >
              <TimeChart dates={chart.dates} series={chart.series} splitIndex={chart.splitIndex} endLabels height={340} ariaLabel="Projected estate value with ranges" />
            </ChartFrame>
          ) : (
            <Callout tone="neutral" title="Not enough data to project yet">
              A projection needs at least two weeks in which every account has data. Import statements or exports for all your accounts covering the same period.
            </Callout>
          )}

          <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
            <Card title="Milestones" description="Median, with the 80% range below it" padded={false}>
              <div className="overflow-x-auto">
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>In</th>
                      {p.series.map((s) => (
                        <th key={s.id} className={cn(tableClasses.th, 'text-right')}>
                          {s.id === 'recent' ? 'Last 3 months' : s.id === 'year' ? 'Last 12 months' : 'Chosen period'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={tableClasses.td}>Today</td>
                      {p.series.map((s) => (
                        <td key={s.id} className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={p.start.total} decimals={0} />
                        </td>
                      ))}
                    </tr>
                    {milestones.map((m) => (
                      <tr key={m}>
                        <td className={tableClasses.td}>{m >= 12 ? `${m / 12} year${m > 12 ? 's' : ''}` : `${m} months`}</td>
                        {p.series.map((s) => {
                          const pt = s.points.find((x) => x.month >= m) ?? s.points[s.points.length - 1];
                          return (
                            <td key={s.id} className={cn(tableClasses.td, tableClasses.num)}>
                              <div className="font-medium">
                                <Money value={pt?.total ?? null} decimals={0} />
                              </div>
                              {pt && (
                                <div className="sensitive text-[11.5px] text-ink-3">
                                  {compact(pt.band.p10)} – {compact(pt.band.p90)}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Today’s position">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Cash (net of cards)" value={<Money value={p.start.cash} decimals={0} />} />
                <Stat label="Investments" value={<Money value={p.start.market} decimals={0} />} />
                <Stat label="Pensions" value={<Money value={p.start.pension} decimals={0} />} />
                <Stat label="Cash runway" value={p.runwayMonths !== null ? `${p.runwayMonths} months` : '—'} sub="cash ÷ monthly spending, if income stopped" />
              </div>
            </Card>
          </div>

          <InsightsPanel page="projections" title="Claude’s notes on your plans" />

          <Card title="What this assumes" description={<>Every value, where it came from, and whether you have overridden it. Change any of them on <AssumptionsLink />.</>} padded={false}>
            <div className="border-b border-line px-5 py-3">
              <div className="mb-2 text-[12.5px] font-medium text-ink-3">Across everything</div>
              <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2 xl:grid-cols-3">
                {p.assumptions.map((a) => (
                  <div key={a.key} className="flex items-center justify-between gap-2">
                    <dt className="text-ink-2" title={a.basis}>{a.label}</dt>
                    <dd className="inline-flex items-center gap-1.5">
                      <span className="tabular font-medium text-ink">{formatAssumptionValue(a.key, a.value)}</span>
                      {a.range && <span className="text-[11.5px] text-ink-3">({formatAssumptionValue(a.key, a.range.low)}–{formatAssumptionValue(a.key, a.range.high)})</span>}
                      <SourceTag value={a} />
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 text-[12px] text-ink-3">
                Combined portfolio: expected {rate(p.pool.mu)} a year {p.pool.muRange ? `(${rate(p.pool.muRange.low)}–${rate(p.pool.muRange.high)})` : ''}, volatility {rate(p.pool.sigma)}, charges {rate(p.pool.fee)}.
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th className={tableClasses.th}>Account</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Today</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Expected return</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Volatility</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Charges</th>
                    <th className={cn(tableClasses.th, 'text-right')} title="Median growth a year after charges">Net growth</th>
                  </tr>
                </thead>
                <tbody>
                  {[...invest, ...other].map((a) => (
                    <Fragment key={a.id}>
                      <AccountRow a={a} />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {p.categories.length > 0 && (
            <Card title="If the last 3 months’ pace continued for a year" description="Annualised spending by group, next to the last 12 months, both from covered time" padded={false}>
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th className={tableClasses.th}>Group</th>
                    <th className={cn(tableClasses.th, 'text-right')}>At recent pace</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Last 12 months</th>
                    <th className={cn(tableClasses.th, 'text-right')}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {p.categories.map((c) => {
                    const diff = c.recentAnnual - c.lastYear;
                    return (
                      <tr key={c.id}>
                        <td className={tableClasses.td}>{c.name}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={c.recentAnnual} decimals={0} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={c.lastYear} decimals={0} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num, diff > 0 ? 'text-bad-ink' : diff < 0 ? 'text-good-ink' : 'text-ink-3')}>
                          <span className="sensitive">
                            {diff > 0 ? '+' : ''}
                            {money(diff, { decimals: 0 })}
                          </span>
                          {c.lastYear > 0 && <span className="ml-1 text-ink-3">({pct(diff / c.lastYear, 0, true)})</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          <Callout tone="neutral" title="How to read this">
            <ul className="list-disc pl-4">
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
    </div>
  );
}
