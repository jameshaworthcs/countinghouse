// Tax year → Pay: each employer's payslips month by month, what reached the bank, and pay seen with no
// payslip (docs/FORMULAS.md §17).

import { Link } from 'react-router';
import type { EarnedPayroll, EarnedPeriod, ExpectedPay, PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { formatMonth } from '../../shared/dates';
import type { Profile } from '../../shared/schema';
import { api, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money } from '../lib/format';
import { useSort } from '../lib/sort';
import { Badge, Callout, Card, EmptyState, Money, Select, SortHeader, StatusBadge, tableClasses } from './ui';

const STATUS: Record<PayMonth['status'], { tone: 'good' | 'warn' | 'bad' | 'info' | 'pending'; label: string } | null> = {
  paid: { tone: 'good', label: 'Paid' },
  differs: { tone: 'warn', label: 'Differs' },
  'not-seen': { tone: 'warn', label: 'Not seen' },
  due: { tone: 'pending', label: 'Due' },
  nothing: null,
  'no-payslip': null,
};
/** Rows with nothing to check: a muted label instead of a status. */
const QUIET: Partial<Record<PayMonth['status'], string>> = { nothing: 'Nothing due', 'no-payslip': 'From the bank' };

const cell = (v: number | null) => (v === null ? <span className="text-ink-3">—</span> : <Money value={v} className="tabular" />);

const EARNED_STATUS: Record<EarnedPeriod['status'], { tone: 'good' | 'warn' | 'info' | 'pending'; label: string }> = {
  paid: { tone: 'good', label: 'Paid' },
  arrived: { tone: 'info', label: 'In the bank' },
  owed: { tone: 'pending', label: 'Owed' },
  late: { tone: 'warn', label: 'Late' },
};

const months = (ends: string[]) => ends.map((d) => formatMonth(d)).join(' and ');

/** Owed pay expected on one payslip: when, and what the payroll should take from it (an estimate). */
function ExpectedNote({ x }: { x: ExpectedPay }) {
  const est = x.estimate;
  const when = x.month ? `with the ${formatMonth(x.month)} payslip${x.payDate ? `, about ${formatDate(x.payDate)}` : ''}` : 'when its payslip comes (how long after the work this payroll pays is not known yet)';
  const title =
    x.status === 'arrived'
      ? `${money(x.arrived!.amount)} arrived on ${formatDate(x.arrived!.date)} for the work in ${months(x.periods)}`
      : `${money(x.gross)} owed for the work in ${months(x.periods)}, expected ${when}`;
  return (
    <Callout tone={x.status === 'late' ? 'warn' : x.status === 'arrived' ? 'good' : 'neutral'} title={title}>
      {x.status === 'arrived' ? (
        <span>Import its payslip to check it against the {money(x.gross)} earned{est.net !== null ? ` (about ${money(est.net)} after the estimated deductions)` : ''}.</span>
      ) : (
        <span className="flex flex-col gap-1">
          {x.status === 'late' && <span>The pay day has passed and nothing from this payroll has reached your bank data since. Import the payslip, or the statement it went into.</span>}
          <span>
            <Badge tone="muted">Estimate</Badge>{' '}
            {est.net !== null ? (
              <>
                After deductions about <Money value={est.net} className="font-medium" />: tax <Money value={est.tax} />, NI <Money value={est.ni} />
                {est.pension !== null && (
                  <>
                    , pension <Money value={est.pension} />
                  </>
                )}
                . Tax code {est.basis}.
              </>
            ) : (
              <>
                {est.ni !== null && <>NI about <Money value={est.ni} />. </>}
                Take-home not estimated.
              </>
            )}
          </span>
          {x.apart && (x.apart.extraNi ?? 0) + (x.apart.extraTax ?? 0) > 0 && (
            <span>
              Paying {x.periods.length} months’ work at once takes about <Money value={(x.apart.extraNi ?? 0) + (x.apart.extraTax ?? 0)} /> more than paying each in a month of its own
              {x.apart.extraNi ? (
                <>
                  : <Money value={x.apart.extraNi} /> of NI, which is worked out pay period by pay period and never refunded
                </>
              ) : null}
              {x.apart.extraTax ? (
                <>
                  {x.apart.extraNi ? ', and ' : ': '}
                  <Money value={x.apart.extraTax} /> of tax, which a month-1 code settles only after the tax year ends (a P800 refund or Self Assessment)
                </>
              ) : null}
              .
            </span>
          )}
          {est.notes.map((n) => (
            <span key={n} className="text-ink-3">
              {n}
            </span>
          ))}
        </span>
      )}
    </Callout>
  );
}

/** How long after the work this payroll pays a timesheet: learned, or what you say (kept in your profile). */
function LagSelect({ payroll, lag }: { payroll: string; lag: EarnedPayroll['lag'] }) {
  const { data } = useAppData();
  const save = useApiMutation((v: string) => {
    const others = (data.profile.employers ?? []).filter((e) => e.name !== payroll);
    const employers = v === '' ? others : [...others, { name: payroll, payLagMonths: Number(v) }];
    const profile: Profile = { ...data.profile, ...(employers.length ? { employers } : {}) };
    if (!employers.length) delete profile.employers;
    return api('/profile', { method: 'PUT', body: profile as unknown as Record<string, unknown> });
  });
  const say = (n: number) => (n === 0 ? 'the same month' : `${n} month${n === 1 ? '' : 's'} later`);
  return (
    <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
      <span>Pays the work</span>
      <Select value={lag.source === 'yours' ? String(lag.months) : ''} onChange={(e) => save.mutate(e.target.value)} className="h-7 w-auto text-[12px]" aria-label="When this payroll pays timesheet work">
        <option value="">{lag.source === 'learned' && lag.months !== null ? `${say(lag.months)} (learned from payslips)` : 'Not known yet'}</option>
        {[0, 1, 2, 3].map((n) => (
          <option key={n} value={String(n)}>
            {say(n)}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Which payroll pays a timesheet: the employer as its payslips name it. */
function LinkSelect({ timesheet, payroll, choices }: { timesheet: { payer: string; role?: string }; payroll: string; choices: string[] }) {
  const link = useApiMutation((paidBy: string) => api('/earned/link', { body: { payer: timesheet.payer, ...(timesheet.role ? { role: timesheet.role } : {}), paidBy: paidBy || null } }));
  return (
    <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
      <span>
        {[timesheet.payer, timesheet.role].filter(Boolean).join(', ')} is paid through
      </span>
      <Select value={payroll === timesheet.payer ? '' : payroll} onChange={(e) => link.mutate(e.target.value)} className="h-7 w-auto text-[12px]" aria-label="Payroll that pays this timesheet">
        <option value="">{timesheet.payer}, its own name</option>
        {[...new Set([...choices, payroll])]
          .filter((c) => c !== timesheet.payer)
          .map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
      </Select>
    </label>
  );
}

/** Timesheet work this payroll pays: each period, the payslip that paid it, and what is owed. */
function EarnedSection({ w, choices }: { w: EarnedPayroll; choices: string[] }) {
  const sheets = [...new Map(w.periods.map((p) => [`${p.payer}|${p.role ?? ''}`, { payer: p.payer, ...(p.role ? { role: p.role } : {}) }])).values()];
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-3 text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">Timesheet work</span>
        <span className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
          {sheets.map((t) => (
            <LinkSelect key={`${t.payer}|${t.role ?? ''}`} timesheet={t} payroll={w.payroll} choices={choices} />
          ))}
          <LagSelect payroll={w.payroll} lag={w.lag} />
        </span>
      </div>
      {w.periods.length > 0 && (
        <div className="overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Work in</th>
                <th className={cn(tableClasses.th, 'text-right')}>Days</th>
                <th className={cn(tableClasses.th, 'text-right')}>Earned</th>
                <th className={tableClasses.th}>Paid on</th>
                <th className={cn(tableClasses.th, 'text-right')}>Into your bank</th>
                <th className={tableClasses.th} />
              </tr>
            </thead>
            <tbody>
              {w.periods.map((p) => {
                const s = EARNED_STATUS[p.status];
                return (
                  <tr key={p.figureId}>
                    <td className={cn(tableClasses.td, 'whitespace-nowrap')}>
                      {formatMonth(p.periodEnd)}
                      {p.role && <div className="text-[11.5px] text-ink-3">{p.role}</div>}
                    </td>
                    <td className={cn(tableClasses.td, 'text-right whitespace-nowrap')}>
                      {p.daysWorked !== undefined ? p.daysWorked : p.hoursWorked !== undefined ? `${p.hoursWorked} h` : '—'}
                      {p.holidayDays ? <div className="text-[11.5px] text-ink-3">+{p.holidayDays} holiday</div> : null}
                    </td>
                    <td className={cn(tableClasses.td, 'text-right')}>
                      <Money value={p.amount} className="tabular" />
                    </td>
                    <td className={cn(tableClasses.td, 'whitespace-nowrap')}>
                      {p.payslip ? (
                        <>
                          {p.payslip.periodEnd ? `${formatMonth(p.payslip.periodEnd)} payslip` : 'A payslip'}
                          {p.payslip.periods > 1 && <div className="text-[11.5px] text-ink-3">with {p.payslip.periods - 1} other month{p.payslip.periods > 2 ? 's' : ''}</div>}
                        </>
                      ) : p.expected?.month ? (
                        <span className="text-ink-3">expected {formatMonth(p.expected.month)}</span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={cn(tableClasses.td, 'text-right')}>
                      {p.paidIn ? (
                        <Link to={`/transactions?accounts=${p.paidIn.accountId}&period=custom&from=${p.paidIn.date}&to=${p.paidIn.date}`} className="hover:underline">
                          <Money value={p.paidIn.amount} className="tabular" />
                          <div className="text-[11.5px] text-ink-3">{formatDate(p.paidIn.date)}</div>
                        </Link>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={cn(tableClasses.td, 'whitespace-nowrap')} title={p.note}>
                      <StatusBadge status={s.tone}>{s.label}</StatusBadge>
                      {p.note && <div className="mt-0.5 text-[11.5px] text-ink-3">{p.note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {w.expected.length > 0 && (
        <div className="flex flex-col gap-2 px-5 pb-4">
          {w.expected.map((x) => (
            <ExpectedNote key={x.figureIds.join()} x={x} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmployerCard({ e, choices }: { e: PayEmployer; choices: string[] }) {
  const payslips = e.months.filter((m) => m.status !== 'no-payslip').length;
  const t = e.totals;
  const { rows, sortProps } = useSort(e.months, {
    period: { value: (m) => m.periodEnd ?? m.payDate, first: 'desc' },
    gross: { value: (m) => m.gross },
    tax: { value: (m) => m.tax },
    ni: { value: (m) => m.ni },
    pension: { value: (m) => m.pension },
    studentLoan: { value: (m) => m.studentLoan },
    net: { value: (m) => m.expectedNet },
    paidIn: { value: (m) => m.paidIn?.amount },
  });
  return (
    <Card
      title={e.payer || 'Employer not named'}
      description={payslips ? `${payslips} payslip${payslips === 1 ? '' : 's'}${e.months.length > payslips ? `, and ${e.months.length - payslips} payment${e.months.length - payslips === 1 ? '' : 's'} with no payslip` : ''}` : e.months.length ? 'Pay into your bank; no payslips for this year' : 'Timesheet work; no payslips for this year yet'}
      padded={false}
    >
      {e.months.length > 0 && (
      <div className="overflow-x-auto border-t border-line">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <SortHeader label="Period" sort={sortProps('period')} />
              <SortHeader label="Gross" sort={sortProps('gross')} numeric />
              <SortHeader label="Tax" sort={sortProps('tax')} numeric />
              <SortHeader label="NI" sort={sortProps('ni')} numeric />
              <SortHeader label="Pension" sort={sortProps('pension')} numeric />
              <SortHeader label="Student loan" sort={sortProps('studentLoan')} numeric />
              <SortHeader label="After these" sort={sortProps('net')} numeric />
              <SortHeader label="Into your bank" sort={sortProps('paidIn')} numeric />
              <th className={tableClasses.th} />
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => {
              const s = STATUS[m.status];
              return (
                <tr key={`${m.periodEnd ?? m.payDate}-${i}`}>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')}>
                    {m.periodEnd ? formatMonth(m.periodEnd) : <span className="text-ink-3">No payslip</span>}
                    {m.payDate && <div className="text-[11.5px] text-ink-3">{m.paidIn ? `arrived ${formatDate(m.paidIn.date)}` : `pay date ${formatDate(m.payDate)}`}</div>}
                  </td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.gross)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.tax)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.ni)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.pension)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.studentLoan)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>{cell(m.expectedNet)}</td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    {m.paidIn ? (
                      <Link to={`/transactions?accounts=${m.paidIn.accountId}&period=custom&from=${m.paidIn.date}&to=${m.paidIn.date}`} className="hover:underline">
                        <Money value={m.paidIn.amount} className="tabular" />
                      </Link>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')} title={m.note}>
                    {s ? <StatusBadge status={s.tone}>{s.label}</StatusBadge> : <Badge tone="muted">{QUIET[m.status]}</Badge>}
                  </td>
                </tr>
              );
            })}
            <tr className="font-medium">
              <td className={tableClasses.td}>Year so far</td>
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.gross)}</td>
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.tax)}</td>
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.ni)}</td>
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.pension)}</td>
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.studentLoan)}</td>
              <td className={tableClasses.td} />
              <td className={cn(tableClasses.td, 'text-right')}>{cell(t.paidIn)}</td>
              <td className={tableClasses.td} />
            </tr>
          </tbody>
        </table>
      </div>
      )}
      {e.earned && <EarnedSection w={e.earned} choices={choices} />}
      {(e.months.some((m) => m.note) || e.p60) && (
        <div className="flex flex-col gap-1 border-t border-line px-5 py-3 text-[12.5px] text-ink-2">
          {e.p60 && (
            <span>
              P60 for the year: pay {cell(e.p60.gross)}, tax {cell(e.p60.tax)}
              {e.p60.ni !== null && <>, NI {cell(e.p60.ni)}</>}. {e.p60.note}
            </span>
          )}
          {e.months
            .filter((m) => m.note)
            .map((m, i) => (
              <span key={i}>
                {m.periodEnd ? formatMonth(m.periodEnd) : formatDate(m.payDate!)}: {m.note}.
              </span>
            ))}
        </div>
      )}
    </Card>
  );
}

export function PayView({ pay }: { pay: PayResponse }) {
  if (!pay.employers.length) {
    return (
      <Card className="mt-5">
        <EmptyState title="No pay for this tax year">Import your payslips, or statements for the account your salary goes into.</EmptyState>
      </Card>
    );
  }
  const missing = pay.employers.flatMap((e) => e.months.filter((m) => m.status === 'not-seen').map((m) => ({ e, m })));
  return (
    <div className="mt-5 flex flex-col gap-5">
      {missing.length > 0 && (
        <Callout tone="warn" title={`${missing.length} payslip${missing.length === 1 ? '’s' : 's’'} pay not seen in your bank`}>
          {missing.map(({ e, m }) => `${e.payer} ${m.periodEnd ? formatMonth(m.periodEnd) : ''}`).join(', ')}. {missing[0]!.m.note}.
        </Callout>
      )}
      {pay.employers.map((e) => (
        <EmployerCard key={e.key} e={e} choices={pay.employers.filter((x) => x.months.some((m) => m.status !== 'no-payslip')).map((x) => x.payer)} />
      ))}
      <p className="text-[12.5px] text-ink-3">{pay.notes.join(' ')}</p>
    </div>
  );
}
