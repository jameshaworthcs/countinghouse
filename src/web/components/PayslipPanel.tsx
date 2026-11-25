// Tax year → Pay: one payslip in a panel, the document beside what was read from it (its lines, totals
// and year to date) and what reached the bank (docs/FORMULAS.md §17). On a small screen the reading
// comes first and the document opens below it or in a tab of its own.

import { ChevronLeft, ChevronRight, ExternalLink, FileText } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { PayEmployer, PayMonth, PayResponse } from '../../shared/api';
import { formatMonth } from '../../shared/dates';
import type { PayslipRecord, PayslipYtdKey } from '../../shared/schema';
import { useApi } from '../lib/api';
import { cn, formatDate } from '../lib/format';
import { Badge, Button, Drawer, IconButton, KeyValue, Loading, Money, StatusBadge, tableClasses, useMediaQuery } from './ui';

export const STATUS: Record<PayMonth['status'], { tone: 'good' | 'warn' | 'bad' | 'info' | 'pending'; label: string } | null> = {
  paid: { tone: 'good', label: 'Paid' },
  differs: { tone: 'warn', label: 'Differs' },
  'not-seen': { tone: 'warn', label: 'Not seen' },
  owed: { tone: 'pending', label: 'Owed' },
  due: { tone: 'pending', label: 'Due' },
  nothing: null,
  'no-payslip': null,
};
/** Rows with nothing to check: a muted label instead of a status. */
export const QUIET: Partial<Record<PayMonth['status'], string>> = { nothing: 'Nothing due', 'no-payslip': 'From the bank' };

/** How a month with a payslip is found again (in the address): its payslip in full, else its first figure. */
export const payslipKey = (m: PayMonth): string | null => m.payslipId ?? m.figureIds[0] ?? null;

const YTD: Record<PayslipYtdKey, string> = {
  gross: 'Pay',
  taxable: 'Taxable pay',
  tax: 'Tax',
  ni: 'NI (you)',
  niEmployer: 'NI (employer)',
  niablePay: 'Pay for NI',
  pension: 'Pension (you)',
  pensionEmployer: 'Pension (employer)',
  studentLoan: 'Student loan',
  ssp: 'Statutory sick pay',
  smp: 'Statutory maternity pay',
  taxCredit: 'Tax credit',
};

const docUrl = (id: string) => `/api/documents/${id}`;
const isPdf = (d: NonNullable<PayMonth['document']>) => d.mediaType === 'application/pdf';
const isImage = (d: NonNullable<PayMonth['document']>) => d.mediaType.startsWith('image/');

/** The original document: a PDF or picture shown in place, anything else a link to open it. */
function Original({ doc, className }: { doc: NonNullable<PayMonth['document']>; className?: string }) {
  const url = docUrl(doc.id);
  return (
    <div className={cn('flex min-h-0 flex-col bg-panel-2', className)}>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 text-[12.5px]">
        <FileText className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{doc.fileName}</span>
        <a href={url} target="_blank" rel="noreferrer" className="rounded p-1 text-ink-3 hover:bg-panel-2" aria-label="Open the original in a new tab" title="Open in a new tab">
          <ExternalLink className="size-4" />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isPdf(doc) ? (
          <iframe key={doc.id} src={`${url}#navpanes=0&view=FitH`} title={doc.fileName} className="sensitive h-full min-h-[60dvh] w-full" />
        ) : isImage(doc) ? (
          <img src={url} alt={doc.fileName} className="sensitive mx-auto w-full" />
        ) : (
          <p className="p-4 text-[13px] text-ink-2">
            This file can’t be shown here.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open {doc.fileName}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

/** One side of a payslip in full: its payments or deductions, as printed, with their total. */
function Lines({ title, lines, total, advanced }: { title: string; lines: PayslipRecord['payments']; total: number | undefined; advanced?: PayMonth['advanced'] }) {
  if (!lines.length && total === undefined) return null;
  const advanceOf = (l: { label: string; amount: number }) => advanced?.find((a) => a.label === l.label && Math.round(a.amount * 100) === Math.round(l.amount * 100));
  return (
    <table className={cn(tableClasses.table, 'self-start')}>
      <thead>
        <tr>
          <th className={tableClasses.th}>{title}</th>
          <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const a = advanceOf(l);
          return (
            <tr key={i}>
              <td className={tableClasses.td}>
                {l.label}
                {a && (
                  <Link to={`/transactions?accounts=${a.accountId}&period=custom&from=${a.date}&to=${a.date}`} className="block text-[11.5px] text-ink-3 hover:underline">
                    the advance paid on {formatDate(a.date)}
                  </Link>
                )}
              </td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Money value={l.amount} />
              </td>
            </tr>
          );
        })}
        {total !== undefined && (
          <tr className="font-medium">
            <td className={tableClasses.td}>Total</td>
            <td className={cn(tableClasses.td, tableClasses.num)}>
              <Money value={total} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** What was read from the payslip, and what reached the bank. */
function Reading({ m, record, loading }: { m: PayMonth; record: PayslipRecord | undefined; loading: boolean }) {
  const s = STATUS[m.status];
  const facts: [string, ReactNode][] = [
    ['Pay date', m.payDate ? formatDate(m.payDate) : '—'],
    ...(m.periodStart && m.periodEnd ? ([['Period', `${formatDate(m.periodStart)} – ${formatDate(m.periodEnd)}${record?.periodNumber ? ` (month ${record.periodNumber})` : ''}`]] as [string, string][]) : []),
    ...(m.taxCode ? ([['Tax code', m.taxCode]] as [string, string][]) : []),
    ...(m.niLetter ? ([['NI letter', m.niLetter]] as [string, string][]) : []),
    ...(record?.payrollNumber ? ([['Payroll no.', record.payrollNumber]] as [string, string][]) : []),
    ...(record?.department ? ([['Department', record.department]] as [string, string][]) : []),
    ...(record?.payMethod ? ([['Paid by', record.payMethod]] as [string, string][]) : []),
  ];
  // The year to date as printed: its pay, tax and NI always, the rest when not £0.
  const ytd = record ? (Object.keys(YTD) as PayslipYtdKey[]).filter((k) => record.yearToDate[k] !== undefined && (['gross', 'taxable', 'tax', 'ni'].includes(k) || record.yearToDate[k] !== 0)) : [];
  const figures: [string, number | null][] = [
    ['Gross pay', m.gross],
    ['Tax', m.tax],
    ['National Insurance', m.ni],
    ['Pension', m.pension],
    ['Student loan', m.studentLoan],
  ];
  return (
    <div className="flex flex-col gap-5">
      <KeyValue items={facts} className="sensitive" />

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">As read</h3>
        {record ? (
          <div className="sensitive grid gap-4 sm:grid-cols-2">
            <Lines title="Payments" lines={record.payments} total={record.totals.payments} />
            <Lines title="Deductions" lines={record.deductions} total={record.totals.deductions} advanced={m.advanced} />
          </div>
        ) : loading ? (
          <Loading label="Reading the payslip…" />
        ) : (
          <>
            <table className={cn(tableClasses.table, 'sensitive')}>
              <tbody>
                {figures
                  .filter(([, v]) => v !== null)
                  .map(([label, v]) => (
                    <tr key={label}>
                      <td className={tableClasses.td}>{label}</td>
                      <td className={cn(tableClasses.td, tableClasses.num)}>
                        <Money value={v} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="text-[12.5px] text-ink-3">Only its figures were read: the payslip’s lines and year to date were not kept.</p>
          </>
        )}
        <div className="sensitive flex items-baseline justify-between rounded-lg bg-panel-2 px-3 py-2 text-[13px]">
          <span className="font-medium text-ink">Net pay{m.netPrinted ? ', as printed' : ', its gross less the deductions read'}</span>
          <Money value={m.expectedNet} className="font-semibold tabular" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Into your bank</h3>
        <div className="sensitive flex flex-col gap-1 text-[13px]">
          {m.paidIn ? (
            <Link to={`/transactions?accounts=${m.paidIn.accountId}&period=custom&from=${m.paidIn.date}&to=${m.paidIn.date}`} className="flex items-baseline justify-between hover:underline">
              <span>Arrived {formatDate(m.paidIn.date)}</span>
              <Money value={m.paidIn.amount} className="tabular" />
            </Link>
          ) : (
            <span className="text-ink-3">Nothing matched to it yet.</span>
          )}
          {m.advanced?.map((a) => (
            <Link key={a.transactionId} to={`/transactions?accounts=${a.accountId}&period=custom&from=${a.date}&to=${a.date}`} className="flex items-baseline justify-between hover:underline">
              <span>Advance paid {formatDate(a.date)}</span>
              <Money value={a.amount} className="tabular" />
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          {s ? <StatusBadge status={s.tone}>{s.label}</StatusBadge> : <Badge tone="muted">{QUIET[m.status]}</Badge>}
          {m.note && <span>{m.note}.</span>}
        </div>
        {m.check && <p className="text-[12.5px] text-warn-ink">{m.check.note}.</p>}
        {m.hmrc && (
          <p className="sensitive text-[12.5px] text-ink-2">
            HMRC’s record of this pay date: <Money value={m.hmrc.taxablePay} /> taxable, <Money value={m.hmrc.tax} /> tax
            {m.hmrc.ni !== null && (
              <>
                , <Money value={m.hmrc.ni} /> NI
              </>
            )}
            .
          </p>
        )}
      </section>

      {(ytd.length > 0 || m.employerCosts) && (
        <section className="sensitive grid gap-4 sm:grid-cols-2">
          {ytd.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold text-ink">Year to date, as printed</h3>
              <KeyValue items={ytd.map((k) => [YTD[k], <Money key={k} value={record!.yearToDate[k]} className="tabular" />])} />
            </div>
          )}
          {m.employerCosts && (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold text-ink">Your employer paid on top</h3>
              <KeyValue
                items={[
                  ...(m.employerCosts.pension !== undefined ? ([['Pension', <Money key="p" value={m.employerCosts.pension} className="tabular" />]] as [string, ReactNode][]) : []),
                  ...(m.employerCosts.ni !== undefined ? ([['NI', <Money key="n" value={m.employerCosts.ni} className="tabular" />]] as [string, ReactNode][]) : []),
                ]}
              />
            </div>
          )}
        </section>
      )}

      {m.document && (
        <p className="text-[12.5px] text-ink-3">
          Read from {m.document.fileName}.{' '}
          <Link to={`/import/${m.document.importId}`} className="text-accent hover:underline">
            Its import
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * The payslip `open` names (`payslipKey`), in a panel: the document beside its reading on a large
 * screen, the reading first on a small one. ← and → step through the same employer's payslips.
 */
export function PayslipPanel({ pay, open, onOpen }: { pay: PayResponse; open: string | null; onOpen: (key: string | null, step?: boolean) => void }) {
  const found = open ? pay.employers.flatMap((e) => e.months.filter((m) => payslipKey(m) === open).map((m) => ({ e, m })))[0] : undefined;
  const wide = useMediaQuery('(min-width: 1024px)');
  const [showDoc, setShowDoc] = useState(false);
  const slips = useApi<PayslipRecord[]>(['payslips', pay.taxYear.label], found?.m.payslipId ? `/payslips?taxYear=${encodeURIComponent(pay.taxYear.label)}` : null);
  const list = found ? found.e.months.filter((m) => m.figureIds.length > 0) : [];
  const at = found ? list.indexOf(found.m) : -1;
  const prev = at > 0 ? list[at - 1] : undefined;
  const next = at >= 0 && at < list.length - 1 ? list[at + 1] : undefined;

  useEffect(() => {
    if (!found) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (ev.key === 'ArrowLeft' && prev) onOpen(payslipKey(prev), true);
      if (ev.key === 'ArrowRight' && next) onOpen(payslipKey(next), true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [found, prev, next, onOpen]);

  if (!found) return null;
  const { e, m } = found;
  const record = m.payslipId ? slips.data?.find((r) => r.id === m.payslipId) : undefined;
  const doc = m.document;
  const reading = <Reading m={m} record={record} loading={Boolean(m.payslipId) && slips.isLoading} />;
  const title = `${m.periodEnd ? formatMonth(m.periodEnd) : formatDate(m.payDate!)} payslip`;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onOpen(null)}
      wide
      flush
      title={title}
      description={[employerName(e), at >= 0 ? `${at + 1} of ${list.length} this tax year` : ''].filter(Boolean).join(' · ')}
      actions={
        <>
          <IconButton label="Earlier payslip (←)" disabled={!prev} onClick={() => prev && onOpen(payslipKey(prev), true)} className="disabled:opacity-40">
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton label="Later payslip (→)" disabled={!next} onClick={() => next && onOpen(payslipKey(next), true)} className="disabled:opacity-40">
            <ChevronRight className="size-4" />
          </IconButton>
        </>
      }
    >
      {wide && doc ? (
        <div className="grid h-full grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Original doc={doc} className="h-full border-r border-line" />
          <div className="overflow-y-auto px-5 py-4">{reading}</div>
        </div>
      ) : (
        <div className="h-full overflow-y-auto px-5 py-4">
          <div className="mx-auto max-w-3xl">
          {doc ? (
            <div className="mb-4 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setShowDoc((v) => !v)} icon={<FileText className="size-3.5" />}>
                  {showDoc ? 'Hide the original' : 'Show the original'}
                </Button>
                <a href={docUrl(doc.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
                  <ExternalLink className="size-3.5" /> Open in a new tab
                </a>
              </div>
              {showDoc && <Original doc={doc} className="h-[70dvh] overflow-hidden rounded-lg border border-line" />}
            </div>
          ) : (
            <p className="mb-4 text-[12.5px] text-ink-3">The original document is not kept for this payslip: its figures came {m.payslipId ? 'without a file' : 'from an import that kept no file, or were added by hand'}.</p>
          )}
          {reading}
          </div>
        </div>
      )}
    </Drawer>
  );
}

const employerName = (e: PayEmployer) => e.payer || 'Employer not named';

/** A month's payslip, as a button that opens it in the panel. */
export function OpenPayslip({ m, onOpen, children, className }: { m: PayMonth; onOpen: (key: string) => void; children: ReactNode; className?: string }) {
  const key = payslipKey(m);
  if (!key) return <>{children}</>;
  return (
    <button type="button" onClick={() => onOpen(key)} className={cn('inline-flex items-center gap-1 text-left text-accent hover:underline', className)} title={m.document ? `See the payslip beside ${m.document.fileName}` : 'See what was read from the payslip'}>
      {children}
      {m.document && <FileText className="size-3.5 text-ink-3" aria-label="its document is kept" />}
    </button>
  );
}

