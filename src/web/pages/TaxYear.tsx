import { ChevronRight, CircleCheck, CircleDashed, Download, FileWarning, Printer, TriangleAlert } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AllowanceLine, AllowancesResponse, PayResponse, SaItem, SelfAssessmentResponse, TaxBandEstimate } from '../../shared/api';
import { formatDate } from '../../shared/dates';
import { Meter } from '../components/charts/bars';
import { InsightsPanel } from '../components/Intel';
import { PayView } from '../components/Pay';
import { Badge, Button, Callout, Card, KeyValue, Loading, Money, PageHeader, Select, StatusBadge, Tabs, tableClasses } from '../components/ui';
import { qs, useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { bandLabel, cn, money } from '../lib/format';

function Lines({ lines }: { lines: AllowanceLine[] }) {
  const { accountName } = useAppData();
  if (!lines.length) return null;
  return (
    <details className="mt-2 text-[12.5px]">
      <summary className="cursor-pointer text-ink-3 hover:text-ink">What counts ({lines.length})</summary>
      <table className={cn(tableClasses.table, 'mt-1')}>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="py-1 pr-2 text-ink-2">
                {l.accountId ? (
                  <Link to={`/accounts/${l.accountId}`} className="hover:underline">
                    {l.label || accountName(l.accountId)}
                  </Link>
                ) : (
                  l.label
                )}
                <span className="ml-1.5 text-ink-3">{l.source === 'provider' ? '· reported by provider' : l.source === 'figure' ? '· from a document' : l.source === 'estimate' ? '· estimate' : ''}</span>
              </td>
              <td className="py-1 text-right">
                <Money value={l.amount} className="tabular" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 text-[12.5px] text-ink-3">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/** Says which accounts' data does not cover the tax year, so the figure above is a minimum. */
function Incomplete({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-warn-soft px-2.5 py-2 text-[12px] text-ink-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn-ink" aria-hidden />
      <span>{note}</span>
    </div>
  );
}

/** How the tax band was worked out: the year's income, the allowance and where the bands start. */
function TaxBandBreakdown({ t }: { t: TaxBandEstimate }) {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium text-ink">Your tax band: {bandLabel(t)}</div>
        <Badge tone="muted">{t.basis === 'documents' ? 'from your P60 and payslips' : t.basis === 'estimate' ? 'estimate' : 'minimum'}</Badge>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">Worked out from the income in your data. It sets the Personal Savings Allowance.</p>
      <details className="mt-2 text-[12.5px]">
        <summary className="cursor-pointer text-ink-3 hover:text-ink">How it is worked out</summary>
        <table className={cn(tableClasses.table, 'mt-1')}>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.label}>
                <td className="py-1 pr-2 text-ink-2">{l.label}</td>
                <td className="py-1 text-right">
                  <Money value={l.amount} className="tabular" />
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-1 pr-2 text-ink-2">Personal allowance</td>
              <td className="py-1 text-right">
                <Money value={t.personalAllowance} decimals={0} className="tabular" />
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-2 font-medium text-ink">Taxable income</td>
              <td className="py-1 text-right font-medium">
                <Money value={t.taxable} decimals={0} className="tabular" />
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-2 text-ink-3">Higher rate from / additional rate from</td>
              <td className="py-1 text-right text-ink-3">
                <Money value={t.higherFrom} decimals={0} className="tabular" /> / <Money value={t.additionalFrom} decimals={0} className="tabular" />
              </td>
            </tr>
          </tbody>
        </table>
      </details>
      <Notes notes={t.notes} />
    </div>
  );
}

function Allowances({ a }: { a: AllowancesResponse }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="ISA allowance" description="All ISAs together, including the LISA">
        <Meter label="Subscriptions" used={a.isa.used} limit={a.isa.allowance} atLeast={a.isa.incomplete !== null} />
        <Incomplete note={a.isa.incomplete} />
        {a.isa.cashLimit < a.isa.allowance && (
          <div className="mt-4">
            <Meter label="Of which cash ISAs" used={a.isa.cashUsed} limit={a.isa.cashLimit} />
          </div>
        )}
        <Lines lines={a.isa.lines} />
        <Notes notes={a.isa.notes} />
      </Card>
      {a.lisa ? (
        <Card title="Lifetime ISA" description="Counts within the £20,000 ISA allowance">
          <Meter label="Contributions" used={a.lisa.contributed} limit={a.lisa.allowance} atLeast={a.lisa.incomplete !== null} />
          <Incomplete note={a.lisa.incomplete} />
          <KeyValue
            className="mt-3"
            items={[
              ['Bonus received this year', <Money value={a.lisa.bonusReceived} />],
              ['Bonus due on contributions', <Money value={a.lisa.bonusExpected} />],
            ]}
          />
          <Lines lines={a.lisa.lines} />
          <Notes notes={a.lisa.notes} />
        </Card>
      ) : (
        <Card title="Lifetime ISA">
          <p className="text-[13px] text-ink-3">No LISA recorded. If you have one, upload a screenshot and it will be picked up.</p>
        </Card>
      )}
      <Card title="Pension annual allowance" description="Your contributions (grossed up for tax relief) plus employer contributions">
        <Meter label="Contributions" used={a.pension.total} limit={a.pension.annualAllowance} atLeast={a.pension.incomplete !== null} />
        <Incomplete note={a.pension.incomplete} />
        <KeyValue
          className="mt-3"
          items={[
            ['You paid', <Money value={a.pension.personal} />],
            ['With tax relief', <Money value={a.pension.personalGross} />],
            ['Employer', <Money value={a.pension.employer} />],
          ]}
        />
        {a.pension.carryForward.length > 0 && (
          <div className="mt-3 text-[12.5px]">
            <div className="mb-1 font-medium text-ink-2">Unused allowance you may be able to carry forward</div>
            <ul>
              {a.pension.carryForward.map((c) => (
                <li key={c.taxYear} className="flex justify-between text-ink-3">
                  <span>{c.taxYear}</span>
                  {c.unused === null ? <span title={c.basis}>not known</span> : <Money value={c.unused} decimals={0} />}
                </li>
              ))}
            </ul>
            {[...new Set(a.pension.carryForward.filter((c) => c.unused === null).map((c) => c.basis))].map((b) => (
              <p key={b} className="mt-1 text-[12px] text-ink-3">
                {b}
              </p>
            ))}
          </div>
        )}
        <Lines lines={a.pension.lines} />
        <Notes notes={a.pension.notes} />
      </Card>
      <Card title="Savings interest" description={`Interest outside ISAs vs your Personal Savings Allowance (${bandLabel(a.taxBand)})`}>
        <Meter label="Interest earned" used={a.savings.interest} limit={a.savings.allowance} atLeast={a.savings.incomplete !== null} overLabel="Taxable" />
        <Incomplete note={a.savings.incomplete} />
        <Lines lines={a.savings.lines} />
        <Notes notes={a.savings.notes} />
        <div className="mt-4 border-t border-line pt-4">
          <Meter label="Dividends outside ISAs" used={a.dividends.amount} limit={a.dividends.allowance} overLabel="Taxable" />
          <Lines lines={a.dividends.lines} />
        </div>
        <TaxBandBreakdown t={a.taxBand} />
      </Card>
      {a.ruleNotes.length > 0 && (
        <Callout tone="neutral" title="Rule changes around this tax year" className="lg:col-span-2">
          <ul className="list-disc pl-4">
            {a.ruleNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

function statusBadge(item: SaItem) {
  switch (item.status) {
    case 'ready':
      return <StatusBadge status="good">Ready to check</StatusBadge>;
    case 'check':
      return <StatusBadge status="warn">Check carefully</StatusBadge>;
    case 'missing':
      return <StatusBadge status="bad">Missing</StatusBadge>;
    default:
      return <Badge tone="muted">Not applicable</Badge>;
  }
}

/** The year's return deadlines: the next one first in weight, those passed muted. */
function SaDeadlines({ sa }: { sa: SelfAssessmentResponse }) {
  const next = sa.deadlines.find((d) => !d.passed);
  return (
    <Card title={`Deadlines for the ${sa.taxYear.label} return`} description="From GOV.UK’s Self Assessment deadlines. Registering late gives you a later filing date, but the tax is still due on 31 January.">
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {sa.deadlines.map((d, i) => (
          <li key={i} className={cn('flex gap-3', d.passed ? 'text-ink-3' : d === next ? 'font-medium text-ink' : 'text-ink-2')}>
            <span className="w-28 shrink-0 tabular">{formatDate(d.date)}</span>
            <span>
              {d.what}
              {d.passed && ' (passed)'}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** One SA102 page per job: what goes on each, from the source that counts. */
function EmploymentPages({ sa }: { sa: SelfAssessmentResponse }) {
  if (!sa.employments.length) return null;
  return (
    <Card title="Employment pages (SA102): one per job" description="Each job’s page, as its figures stand. A P60 (or a P45 for a job you left) gives the figures to enter; check each against it." padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {sa.employments.map((e) => (
          <li key={e.key} className="px-5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-ink">{e.employer}</div>
                <div className="text-[12.5px] text-ink-3">{[e.payeReference ? `PAYE reference ${e.payeReference}` : 'PAYE reference not known', e.startedOn ? `started ${formatDate(e.startedOn)}` : '', e.endedOn ? `left ${formatDate(e.endedOn)}` : ''].filter(Boolean).join(' · ')}</div>
              </div>
              {e.final ? <StatusBadge status="good">The year’s figures</StatusBadge> : <StatusBadge status="warn">So far</StatusBadge>}
            </div>
            <KeyValue
              className="mt-2"
              items={[
                ['Pay', e.pay !== null ? <Money value={e.pay} /> : '—'],
                ['UK tax taken off', e.tax !== null ? <Money value={e.tax} /> : 'Not known'],
                ...(e.studentLoan !== null ? ([['Student loan deducted', <Money value={e.studentLoan} />]] as [string, React.ReactNode][]) : []),
                ['From', e.basis],
              ]}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** HMRC's working out of the year, and the payments that settled it. */
function Settlement({ sa }: { sa: SelfAssessmentResponse }) {
  const s = sa.settlement;
  if (!s) return null;
  const paid = (l: { date: string; amount: number; accountId: string }) => (
    <Link to={`/transactions?accounts=${l.accountId}&period=custom&from=${l.date}&to=${l.date}`} className="text-accent hover:underline">
      paid in your bank on {formatDate(l.date)}
    </Link>
  );
  return (
    <Card title={`HMRC’s working out of ${sa.taxYear.label}`} description={`As HMRC’s page showed it on ${formatDate(s.asOf)}.`}>
      <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        <div>
          {s.outcome === 'underpaid' ? 'You paid too little tax' : s.outcome === 'overpaid' ? 'You paid too much tax' : 'Nothing owed either way'}
          {s.amount !== undefined && (
            <>
              : <Money value={s.amount} />
            </>
          )}
          {s.calculatedOn && `, worked out on ${formatDate(s.calculatedOn)}`}.{' '}
          {s.outstanding > 0 ? (
            <span className="font-medium text-warn-ink">
              <Money value={s.outstanding} /> still to pay.
            </span>
          ) : s.outstanding < 0 ? (
            <span>
              <Money value={-s.outstanding} /> to be repaid to you.
            </span>
          ) : (
            <span>Nothing outstanding.</span>
          )}
        </div>
        {s.payments.map((p, i) => (
          <div key={i}>
            You paid <Money value={p.amount} /> by {p.how} on {formatDate(p.date)}
            {p.paidFrom ? <>, {paid(p.paidFrom)}</> : <span className="text-ink-3">; not found in your bank data</span>}.
          </div>
        ))}
        {s.refund && (
          <div>
            HMRC’s refund of <Money value={s.refund.amount} /> was {paid(s.refund)}.
          </div>
        )}
      </div>
    </Card>
  );
}

/** One section of the return: its items, each with where it goes, its basis, notes and sources. */
function SaSectionCard({ section, items }: { section: SelfAssessmentResponse['sections'][number]; items: SaItem[] }) {
  return (
    <Card title={section.title} description={section.description} padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {items.map((item) => (
          <li key={item.id} className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-ink">{item.label}</div>
                <div className="mt-0.5 text-[12.5px] text-ink-3">{item.where}</div>
              </div>
              <div className="flex items-center gap-3">
                {statusBadge(item)}
                <div className="text-right text-[18px] font-semibold text-ink">{item.amount !== null ? <Money value={item.amount} /> : <span className="text-ink-3">—</span>}</div>
              </div>
            </div>
            <div className="mt-1 text-[12.5px] text-ink-2">Basis: {item.basis}</div>
            <Notes notes={item.notes} />
            {item.sources.length > 0 && (
              <details className="mt-2 text-[12.5px]">
                <summary className="cursor-pointer text-ink-3 hover:text-ink">Sources ({item.sources.length})</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {item.sources.map((s) => (
                    <li key={s.type + s.id} className="flex justify-between gap-3 text-ink-2">
                      <span className="truncate">
                        {s.date ? `${formatDate(s.date)} · ` : ''}
                        {s.type === 'account' ? (
                          <Link to={`/accounts/${s.id}`} className="hover:underline">
                            {s.label}
                          </Link>
                        ) : (
                          s.label
                        )}
                      </span>
                      {s.amount !== undefined && <Money value={s.amount} className="tabular" />}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SelfAssessment({ sa, taxYear }: { sa: SelfAssessmentResponse; taxYear: string }) {
  const [showNA, setShowNA] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border-2 border-warn bg-warn-soft px-5 py-4" role="note">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <FileWarning className="size-5 text-warn-ink" /> You must check everything before you submit
        </div>
        <p className="mt-1.5 text-[13px] text-ink-2">{sa.disclaimer}</p>
      </div>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-ink-2">
          Online filing and payment deadline for {sa.taxYear.label}: <span className="font-semibold text-ink">{formatDate(sa.taxYear.filingDeadline)}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => window.print()}>
            Print
          </Button>
          <a href={`/api/self-assessment${qs({ taxYear, format: 'csv' })}`}>
            <Button size="sm" icon={<Download className="size-3.5" />}>
              Export CSV
            </Button>
          </a>
        </div>
      </div>

      <SaDeadlines sa={sa} />
      <Settlement sa={sa} />
      {sa.ni && (
        <Callout tone={sa.ni.status === 'not-full' ? 'warn' : 'neutral'} title={`National Insurance for ${sa.taxYear.label}`}>
          {sa.ni.status === 'full' ? 'A full year on your record.' : sa.ni.status === 'not-full' ? 'Not a full year on your record.' : sa.ni.status === 'not-available' ? 'Not on your record yet.' : (sa.ni.text ?? '')}{' '}
          {sa.ni.voluntaryCost !== undefined && (
            <>
              A voluntary contribution of <Money value={sa.ni.voluntaryCost} /> would fill it{sa.ni.payBy ? `, by ${formatDate(sa.ni.payBy)}` : ''}.{' '}
            </>
          )}
          <span className="text-ink-3">As HMRC’s page showed it on {formatDate(sa.ni.asOf)}.</span>{' '}
          <Link to="/investments" className="text-accent hover:underline">
            Your whole record
          </Link>
        </Callout>
      )}

      {sa.mayNeedToFile.length > 0 && (
        <Card title="Why you might need to file" description="Hints only; check gov.uk/check-if-you-need-tax-return">
          <ul className="flex flex-col gap-2 text-[13px]">
            {sa.mayNeedToFile.map((m) => (
              <li key={m.reason} className="flex gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" />
                <span>
                  <span className="font-medium text-ink">{m.reason}.</span> <span className="text-ink-3">{m.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sa.sections.map((section) => {
        const items = section.items.filter((i) => showNA || i.status !== 'not-applicable');
        if (!items.length) return null;
        // Each job's own page follows the employment totals.
        if (section.id === 'employment')
          return (
            <Fragment key={section.id}>
              <SaSectionCard section={section} items={items} />
              <EmploymentPages sa={sa} />
            </Fragment>
          );
        return <SaSectionCard key={section.id} section={section} items={items} />;
      })}
      <div className="no-print">
        <Button size="sm" variant="ghost" onClick={() => setShowNA((v) => !v)}>
          {showNA ? 'Hide' : 'Show'} items that don’t apply
        </Button>
      </div>

      <Card title="Before you file">
        <ul className="flex flex-col gap-2 text-[13px]">
          {sa.checklist.map((c) => (
            <li key={c.id} className="flex gap-2">
              {c.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-3" />}
              <span>
                <span className={cn('font-medium', c.done ? 'text-ink-2' : 'text-ink')}>{c.label}</span>
                {c.detail && !c.done && <span className="block text-ink-3">{c.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[12.5px] text-ink-3">
          Add figures by hand (for example from a P60 you have on paper) in Settings → Tax documents, or upload the document on the <Link to="/import" className="text-accent hover:underline">Import</Link> page.
        </p>
      </Card>
    </div>
  );
}

export default function TaxYear() {
  const { tab = 'allowances' } = useParams();
  const navigate = useNavigate();
  const years = useApi<string[]>(['tax-years'], '/tax-years');
  const [year, setYear] = useState<string>('');
  // Self Assessment is filed for a finished tax year, so default to the last completed one there.
  const defaultYear = tab === 'self-assessment' ? (years.data?.[1] ?? years.data?.[0]) : years.data?.[0];
  const ty = year || defaultYear || '';
  const allowances = useApi<AllowancesResponse>(['allowances', ty], ty ? `/allowances${qs({ taxYear: ty })}` : null);
  const sa = useApi<SelfAssessmentResponse>(['self-assessment', ty], ty && tab === 'self-assessment' ? `/self-assessment${qs({ taxYear: ty })}` : null);
  const payQ = useApi<PayResponse>(['pay', ty], ty && tab === 'pay' ? `/pay${qs({ taxYear: ty })}` : null);
  return (
    <div>
      <PageHeader
        title={`Tax year ${ty}`}
        subtitle={allowances.data ? `${formatDate(allowances.data.taxYear.start)} – ${formatDate(allowances.data.taxYear.end)}${allowances.data.taxYear.daysLeft !== null ? ` · ${allowances.data.taxYear.daysLeft} days left` : ''}` : undefined}
        actions={
          <Select value={ty} onChange={(e) => setYear(e.target.value)} className="w-36" aria-label="Tax year">
            {(years.data ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => navigate(v === 'allowances' ? '/tax' : `/tax/${v}`)}
        tabs={[
          { value: 'allowances', label: 'Allowances' },
          { value: 'pay', label: 'Pay' },
          { value: 'self-assessment', label: 'Self Assessment prep' },
        ]}
      />
      {tab === 'allowances' && <InsightsPanel page="tax" title="Claude’s notes on your allowances" className="my-5" />}
      {tab === 'pay' ? payQ.data ? <PayView pay={payQ.data} /> : <Loading /> : tab === 'self-assessment' ? sa.data ? <SelfAssessment sa={sa.data} taxYear={ty} /> : <Loading /> : allowances.data ? <Allowances a={allowances.data} /> : <Loading />}
      {tab === 'allowances' && (
        <Link to="/tax/self-assessment" className="no-print mt-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          Preparing a Self Assessment return? <ChevronRight className="size-4" />
        </Link>
      )}
      <div className="sr-only">{money(0)}</div>
    </div>
  );
}
