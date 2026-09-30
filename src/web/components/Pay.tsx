// Tax year → Pay: each employer's payslips month by month, what reached the bank, and pay seen with no
// payslip (docs/FORMULAS.md §17).

import { Link } from 'react-router';
import type { PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { formatMonth } from '../../shared/dates';
import { cn, formatDate } from '../lib/format';
import { useSort } from '../lib/sort';
import { Badge, Callout, Card, EmptyState, Money, SortHeader, StatusBadge, tableClasses } from './ui';

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

function EmployerCard({ e }: { e: PayEmployer }) {
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
    <Card title={e.payer || 'Employer not named'} description={payslips ? `${payslips} payslip${payslips === 1 ? '' : 's'}${e.months.length > payslips ? `, and ${e.months.length - payslips} payment${e.months.length - payslips === 1 ? '' : 's'} with no payslip` : ''}` : 'Pay into your bank; no payslips for this year'} padded={false}>
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
        <EmployerCard key={e.key} e={e} />
      ))}
      <p className="text-[12.5px] text-ink-3">{pay.notes.join(' ')}</p>
    </div>
  );
}
