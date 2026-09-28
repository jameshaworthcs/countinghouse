import { useMemo, useState } from 'react';
import type { ProjectionResponse } from '../../shared/api';
import { addMonths, formatDate, today } from '../../shared/dates';
import { taxYearOf } from '../../shared/uk';
import { ChartFrame, SERIES } from '../components/charts/common';
import { TimeChart, type TimeSeries } from '../components/charts/TimeChart';
import { Callout, Card, Field, Input, Loading, Money, PageHeader, Segmented, Select, Stat, tableClasses } from '../components/ui';
import { qs, useApi } from '../lib/api';
import { cn, money, pct } from '../lib/format';

const HORIZONS = [
  { value: '12', label: '1Y' },
  { value: '24', label: '2Y' },
  { value: '60', label: '5Y' },
  { value: '120', label: '10Y' },
  { value: '240', label: '20Y' },
] as const;

export default function Projections() {
  const [months, setMonths] = useState<string>('60');
  const [adjust, setAdjust] = useState(0);
  const [compare, setCompare] = useState<'none' | 'last-tax-year' | 'custom'>('none');
  const [customFrom, setCustomFrom] = useState(addMonths(today(), -24).slice(0, 7) + '-01');
  const [customTo, setCustomTo] = useState(addMonths(today(), -13).slice(0, 7) + '-28');
  const lastTy = taxYearOf(addMonths(taxYearOf(today()).start, -1));
  const past = compare === 'last-tax-year' ? { pastFrom: lastTy.start, pastTo: lastTy.end } : compare === 'custom' ? { pastFrom: customFrom, pastTo: customTo } : {};
  const q = useApi<ProjectionResponse>(['projections', months, adjust, past], `/projections${qs({ months, adjust: adjust / 100, ...past })}`);
  const p = q.data;

  const chart = useMemo(() => {
    if (!p) return null;
    const hist = p.history;
    const futureDates = p.series[0]?.points.map((pt) => pt.date).slice(1) ?? [];
    const dates = [...hist.map((h) => h.date), ...futureDates];
    const splitIndex = hist.length - 1;
    const series: TimeSeries[] = [
      { id: 'history', label: 'Estate value', color: 'var(--ink-2)', values: [...hist.map((h) => h.value), ...futureDates.map(() => null)], kind: 'line' },
      ...p.series.map((s, i) => ({
        id: s.id,
        label: s.label.replace('If the ', '').replace(' continued', ''),
        color: SERIES[i]!,
        kind: 'line' as const,
        dashed: true,
        values: [...hist.map((_, hi) => (hi === splitIndex ? s.points[0]!.value : null)), ...s.points.slice(1).map((pt) => pt.value)],
      })),
    ];
    return { dates, series, splitIndex };
  }, [p]);

  const milestones = [12, 24, 60, 120, 240].filter((m) => m <= Number(months));
  return (
    <div>
      <PageHeader title="Projections" subtitle="Where your estate value heads if your spending and saving carried on as before" />
      <div className="no-print mb-5 flex flex-wrap items-end gap-4">
        <Field label="Horizon">
          <Segmented value={months} onChange={setMonths} options={HORIZONS.map((h) => ({ value: h.value, label: h.label }))} />
        </Field>
        <Field label={`Spending ${adjust > 0 ? '+' : ''}${adjust}%`}>
          <input type="range" min={-40} max={40} step={5} value={adjust} onChange={(e) => setAdjust(Number(e.target.value))} className="h-9 w-56 accent-[var(--accent)]" aria-label="Spending adjustment" />
        </Field>
        <Field label="Also compare">
          <Select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className="w-56">
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
              <div key={s.id} className="rounded-xl border border-line bg-panel px-4 py-3.5 shadow-card">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <svg width="18" height="8" aria-hidden>
                    <line x1="1" y1="4" x2="17" y2="4" stroke={SERIES[i]} strokeWidth="2" strokeDasharray="4 3" />
                  </svg>
                  {s.label}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-3">
                  Based on {formatDate(s.from)} – {formatDate(s.to)}
                </div>
                {s.available ? (
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                    <dt className="text-ink-3">Income / month</dt>
                    <dd className="text-right"><Money value={s.monthly.income} decimals={0} /></dd>
                    <dt className="text-ink-3">Spending / month</dt>
                    <dd className="text-right"><Money value={s.monthly.spending} decimals={0} /></dd>
                    <dt className="text-ink-3">Left over</dt>
                    <dd className={cn('text-right font-semibold', s.monthly.net >= 0 ? 'text-good-ink' : 'text-bad-ink')}><Money value={s.monthly.net} decimals={0} /></dd>
                    <dt className="text-ink-3">Into investments</dt>
                    <dd className="text-right"><Money value={s.monthly.investing} decimals={0} /></dd>
                    <dt className="text-ink-3">Into pensions</dt>
                    <dd className="text-right"><Money value={s.monthly.pensionInflow} decimals={0} /></dd>
                  </dl>
                ) : (
                  <div className="mt-3 text-[13px] text-ink-3">{s.reason}</div>
                )}
              </div>
            ))}
          </div>

          {p.series.length ? (
            <ChartFrame
              title="Estate value: history and projection"
              subtitle="Solid is what happened; dashed is each scenario continuing"
              legend={chart.series.map((s) => ({ label: s.label, color: s.color, kind: s.dashed ? 'dash' : 'line' }))}
              table={{
                columns: ['Date', ...p.series.map((s) => s.label)],
                rows: (p.series[0]?.points ?? []).map((pt, i) => [formatDate(pt.date), ...p.series.map((s) => money(s.points[i]?.value ?? null, { decimals: 0 }))]),
              }}
            >
              <TimeChart dates={chart.dates} series={chart.series} splitIndex={chart.splitIndex} endLabels height={320} ariaLabel="Projected estate value" />
            </ChartFrame>
          ) : (
            <Callout tone="neutral">Import a few months of bank statements to unlock projections.</Callout>
          )}

          <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <Card title="Milestones" padded={false}>
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th className={tableClasses.th}>In</th>
                    {p.series.map((s, i) => (
                      <th key={s.id} className={cn(tableClasses.th, 'text-right')}>
                        <span className="inline-flex items-center gap-1.5">
                          <svg width="14" height="6" aria-hidden>
                            <line x1="1" y1="3" x2="13" y2="3" stroke={SERIES[i]} strokeWidth="2" strokeDasharray="3 2" />
                          </svg>
                          {s.id === 'recent' ? 'Last 3 months' : s.id === 'year' ? 'Last 12 months' : 'Chosen period'}
                        </span>
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
                        const target = addMonths(p.startDate, m);
                        const pt = [...s.points].reverse().find((x) => x.date <= target.slice(0, 7) + '-31') ?? s.points[s.points.length - 1];
                        return (
                          <td key={s.id} className={cn(tableClasses.td, tableClasses.num, 'font-medium')}>
                            <Money value={pt?.value ?? null} decimals={0} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Today’s position">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Cash (net of cards)" value={<Money value={p.start.liquid} decimals={0} />} />
                <Stat label="Investments" value={<Money value={p.start.invested} decimals={0} />} />
                <Stat label="Pensions" value={<Money value={p.start.pensions} decimals={0} />} />
                <Stat label="Cash runway" value={p.runwayMonths !== null ? `${p.runwayMonths} months` : '—'} sub="if income stopped" />
              </div>
            </Card>
          </div>

          {p.categories.length > 0 && (
            <Card title="If the last 3 months’ pace continued for a year" description="Annualised spending by group, next to what you actually spent in the last 12 months" padded={false}>
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
          <Callout tone="neutral" title="Assumptions">
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
