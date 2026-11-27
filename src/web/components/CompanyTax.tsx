// A company's Corporation Tax tab (docs/FORMULAS.md §22, "Corporation Tax"): its Corporation Tax
// periods and their state, one period's computation from the accounts' profit to the tax payable (the
// adjustments, pre-trading expenditure, capital allowances, losses, non-trading profits and the tax by
// financial year with marginal relief), what it carries forward, the CT600's boxes with the working
// behind each, and what stops it being ready. Everything from the company's own route
// (GET /api/companies/:id/corporation-tax); nothing here is a figure of yours, and nothing is sent to
// HMRC: the boxes are printed or exported, and filed through other software.

import { Download, Printer } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { CompanyCtResponse, CtCapitalAllowances, CtCheck, CtComputationView, CtPeriodRow, CtPeriodStatus, Ct600BoxView } from '../../shared/api';
import { formatDate, formatSpan, today } from '../../shared/dates';
import { ledgerName } from '../../shared/ledger';
import { fromMinor } from '../../shared/money';
import { CIHC_TEST } from '../../shared/corporation-tax';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn } from '../lib/format';
import { CheckEverything } from './CheckEverything';
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Field, Loading, Money, Select, StatusBadge, tableClasses, useToast } from './ui';

/** Pence as money. */
const Pence = ({ value, className }: { value: number | null; className?: string }) => <Money value={value === null ? null : fromMinor(value)} className={cn('sensitive tabular', className)} />;
/** Whole pounds as money, no pence. */
const Pounds = ({ value }: { value: number }) => <Money value={value} decimals={0} className="sensitive tabular" />;

const STATUS: Record<CtPeriodStatus, ReactNode> = {
  open: <Badge tone="neutral">Open</Badge>,
  'not-ready': <StatusBadge status="warn">Not ready</StatusBadge>,
  ready: <StatusBadge status="good">Ready</StatusBadge>,
  filed: <Badge tone="muted">CT600 filed</Badge>,
  'filed-late': <StatusBadge status="bad">CT600 filed late</StatusBadge>,
  'before-books': <Badge tone="muted">Before these books</Badge>,
};
const STATUS_WORDS: Record<CtPeriodStatus, string> = { open: 'open', 'not-ready': 'not ready', ready: 'ready', filed: 'CT600 filed', 'filed-late': 'CT600 filed late', 'before-books': 'before these books' };
const TREATMENT: Record<string, string> = { aia: 'Annual investment allowance', 'full-expensing': 'Full expensing', 'fya-50': '50% first-year allowance', pool: 'Pool only' };

function checkWords(c: CtCheck, companyId: string): ReactNode {
  switch (c.kind) {
    case 'not-ended':
      return `The period runs to ${formatDate(c.end)}: the figures so far.`;
    case 'accounts-not-ready':
      return (
        <>
          Its period of account’s accounts ({formatSpan(c.periodOfAccount.start, c.periodOfAccount.end)}) are not ready{c.ended ? `: ${c.checks} check${c.checks === 1 ? '' : 's'} to clear` : ': the period of account has not ended'}. The profit shared out comes from them (<Link to={`/company/${companyId}/accounts`} className="text-accent-ink hover:underline">Accounts</Link>).
        </>
      );
    case 'earlier-not-ready':
      return `The period to ${formatDate(c.end)} is not ready (and has no CT600 recorded): what it carries forward may still change.`;
    case 'brought-forward':
      return (
        <>
          The books start on {formatDate(c.ledgerFrom)}: give the tax figures carried forward from before them (pools, losses, deficits; all may be nil) in <Link to={`/company/${companyId}/settings`} className="text-accent-ink hover:underline">Settings</Link>.
        </>
      );
    case 'before-books':
      return `The books start on ${formatDate(c.ledgerFrom)}, after this period starts.`;
    case 'sales-before-trade':
      return (
        <>
          Sales of <Pence value={c.amount} /> before the trade started: check the day it started in Settings.
        </>
      );
    case 'income-before-charge':
      return (
        <>
          {ledgerName(c.ledger)} of <Pence value={Math.abs(c.amount)} /> before it came within the charge to Corporation Tax ({formatDate(c.from)}), in no Corporation Tax period: income or business brings a company within the charge (CTA 2009 s9), so check that day in Settings.
        </>
      );
    case 'opening-journal':
      return `An opening journal dated ${formatDate(c.date)} brings in a fixed asset, but the books start on ${formatDate(c.ledgerFrom)}: opening balances are dated before then. For tax it is taken as brought in (in the pools brought forward), not bought; date the journal before the books start, or code the purchase if it was bought then.`;
    case 'disposal-proceeds':
      return `${c.count} assets left in the period with nothing said of what each fetched: say it on each asset (what it fetched), so each disposal value is right.`;
    case 'close-investment-holding':
      return (
        <>
          Say whether it is a close investment-holding company in <Link to={`/company/${companyId}/settings`} className="text-accent-ink hover:underline">Settings</Link>: before it trades, the rate depends on it. {CIHC_TEST}
        </>
      );
    case 'unsupported':
      return `Not supported here: ${c.what}.`;
  }
}

/** A line of the computation: a label, an amount, and its working beneath. */
function Row({ label, value, sub, strong, indent, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; strong?: boolean; indent?: boolean; children?: ReactNode }) {
  return (
    <>
      <tr className={cn(strong && 'bg-panel-2 font-medium')}>
        <td className={cn(tableClasses.td, indent && 'pl-8')}>
          {label}
          {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
        </td>
        <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>{value}</td>
      </tr>
      {children}
    </>
  );
}

function ComputationCard({ v, companyId }: { v: CtComputationView; companyId: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const p = v.period;
  const nothing = useApiMutation(() => api(`/companies/${companyId}/filings`, { method: 'POST', body: { kind: 'ct-payment', periodStart: p.start, periodEnd: p.end, filedOn: today(), figures: { amount: 0 } } }), {
    onSuccess: () => toast({ tone: 'good', text: 'Recorded: no Corporation Tax to pay' }),
    onError: (e) => toast({ tone: 'bad', text: e.message }),
  });
  const ca = v.capitalAllowances;
  const blocks = v.checks.filter((c) => c.kind !== 'not-ended');
  const trading = p.phase === 'trading';
  return (
    <Card
      title={`Corporation Tax for ${formatSpan(p.start, p.end)}`}
      description={
        <>
          {v.days} days · {trading ? 'trading' : 'before the trade started'} · period of account {formatSpan(p.periodOfAccount.start, p.periodOfAccount.end)} · CT600 due {formatDate(p.returnDue)}, tax due {formatDate(p.paymentDue)} · {STATUS_WORDS[p.status]}
        </>
      }
      padded={false}
      actions={
        <div className="no-print flex gap-2">
          <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => window.print()}>
            Print
          </Button>
          <a href={`/api/companies/${companyId}/corporation-tax?period=${p.end}&format=csv`}>
            <Button size="sm" icon={<Download className="size-3.5" />}>
              CSV
            </Button>
          </a>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-5 pt-4">
        {v.ready ? (
          <Callout tone="good" title={p.ct600 ? `CT600 filed ${formatDate(p.ct600.filedOn)}` : 'Ready'} action={p.offerNothingToPay ? <Button size="sm" loading={nothing.isPending} onClick={() => nothing.mutate(undefined)}>Record nothing to pay</Button> : undefined}>
            {p.offerNothingToPay
              ? 'The period has ended, its accounts are ready and the books give no Corporation Tax to pay. Record it, so the payment’s deadline is done (nothing is recorded by itself).'
              : 'The period has ended, its accounts are ready and nothing stops it. Check each figure, enter the boxes in your filing software, and record the CT600 and the payment in Settings → Filings.'}
          </Callout>
        ) : (
          <div className="rounded-lg border border-line bg-panel-2 px-4 py-3">
            <div className="text-[13px] font-medium text-ink">{blocks.length ? (p.ct600 ? 'CT600 filed; the books have checks to clear' : 'Not ready') : 'Not ended yet: the figures so far'}</div>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-2">
              {v.checks.map((c, i) => (
                <li key={i}>{checkWords(c, companyId)}</li>
              ))}
            </ul>
          </div>
        )}
        {p.differs && p.ct600?.taxPayable !== undefined && (
          <Callout tone="warn" title="The CT600 filed differs from the books">
            It gave <Pence value={p.ct600.taxPayable} /> to pay; the books give <Pence value={v.payable} />.
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Profits chargeable" value={<Pounds value={v.chargeable.whole} />} />
          <Figure label="Corporation Tax" value={<Pence value={v.tax.atRates} />} />
          <Figure label="Marginal relief" value={<Pence value={v.tax.marginalRelief} />} />
          <Figure label="To pay" value={<Pence value={v.payable} />} />
        </div>
      </div>
      <div className="relative mt-3 overflow-x-auto">
        <table className={tableClasses.table}>
          <tbody>
            <Row
              label="Profit before tax, as the accounts give it for this period"
              value={<Pence value={v.accounts.profit} />}
              sub={
                <>
                  {v.accounts.lines.some((l) => l.basis === 'days') ? 'Shared out from the period of account by days (CTA 2009 s52; interest, s307(2A)). ' : 'By date. '}
                  <button type="button" className="no-print text-accent-ink hover:underline" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
                    {open ? 'Hide its lines' : `Its lines (${v.accounts.lines.length})`}
                  </button>
                </>
              }
              strong
            >
              {open &&
                v.accounts.lines.map((l) => (
                  <tr key={`${l.ledger}:${l.basis}`} className="text-[12.5px] text-ink-2">
                    <td className={cn(tableClasses.td, 'py-1 pl-8')}>
                      {ledgerName(l.ledger)} <span className="text-ink-3">· {l.basis === 'days' ? 'by days' : l.basis === 'accrued' ? 'as accrued' : 'by date'}</span>
                    </td>
                    <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
                      <Pence value={l.amount} />
                    </td>
                  </tr>
                ))}
            </Row>
            {v.adjustments.map((a, i) => (
              <Row key={i} indent label={a.kind === 'pre-trading-released' ? a.label : `${a.amount > 0 ? 'Add back' : 'Take out'}: ${a.label}`} value={<Pence value={a.amount} />} sub={a.why} />
            ))}
            {trading ? (
              <>
                <Row label="Trading result before capital allowances" value={<Pence value={v.beforeAllowances} />} strong />
                <Row indent label="Capital allowances, less balancing charges" value={<Pence value={-ca.net} />} sub="Below." />
                <Row label={v.tradingResult >= 0 ? 'Trading profit' : 'Trading loss'} value={<Pence value={v.tradingResult} />} strong />
                {v.losses.trading.usedAgainstTrading > 0 && <Row indent label="Losses before 1 April 2017 set against it (CTA 2010 s45)" value={<Pence value={-v.losses.trading.usedAgainstTrading} />} />}
              </>
            ) : (
              <Row label="Trading result" value="—" sub="No trade yet: no trading profit or loss arises; expenses wait as pre-trading expenditure (below)." strong />
            )}
            <Row label="Non-trading loan relationships (interest), net" value={<Pence value={v.nonTrading.net} />} sub={v.nonTrading.net < 0 ? 'A deficit: carried forward.' : 'Interest received, less interest paid before the trade started.'} />
            <Row label="Profits before other deductions" value={<Pence value={v.totalProfits} />} strong />
            {v.losses.trading.usedAgainstTotal > 0 && <Row indent label="Trading losses carried forward, claimed (CTA 2010 s45A)" value={<Pence value={-v.losses.trading.usedAgainstTotal} />} />}
            {v.losses.nonTrading.used > 0 && <Row indent label="Non-trading deficits carried forward, claimed (CTA 2009 s463G)" value={<Pence value={-v.losses.nonTrading.used} />} />}
            <Row label="Profits chargeable to Corporation Tax" value={<Pounds value={v.chargeable.whole} />} sub={<>exact <Pence value={v.chargeable.exact} />; the CT600 takes whole pounds</>} strong />
            {v.s455 && <Row label="Tax on loans to participators (CTA 2010 s455; box 480)" value={<Pence value={v.s455.tax} />} sub={<>on <Pence value={v.s455.outstanding} /> lent in the period and owed at its end, less relief for <Pence value={v.s455.relief} /> repaid by {formatDate(v.s455.due)}{v.s455.provisional ? ' (so far)' : ''}: paid with the Corporation Tax</>} />}
          </tbody>
        </table>
      </div>
      <TaxParts v={v} />
      {v.notes.length > 0 && (
        <ul className="flex flex-col gap-1.5 px-5 py-4 text-[12.5px]">
          {v.notes.map((n, i) => (
            <li key={i} className={cn(n.level === 'warn' ? 'text-warn-ink' : 'text-ink-2')}>
              {n.level === 'warn' ? 'Check: ' : ''}
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div className="text-[15px] font-medium">{value}</div>
    </div>
  );
}

function TaxParts({ v }: { v: CtComputationView }) {
  if (!v.tax.parts.length) return null;
  const band = { small: 'small profits rate', marginal: 'main rate, marginal relief', main: 'main rate', single: 'the year’s rate' } as const;
  return (
    <div className="relative overflow-x-auto border-t border-line">
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th className={tableClasses.th}>Financial year</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Profit</th>
            <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Limits</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Tax</th>
          </tr>
        </thead>
        <tbody>
          {v.tax.parts.map((x) => (
            <tr key={x.fy}>
              <td className={tableClasses.td}>
                FY {x.fy} <span className="text-[12px] text-ink-3">· {x.days} days · {x.rate}%, {band[x.band]}</span>
              </td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pounds value={x.profit} />
              </td>
              <td className={cn(tableClasses.td, tableClasses.num, 'hidden text-[12px] sm:table-cell')}>
                {x.lower !== undefined && x.upper !== undefined ? (
                  <>
                    <Pence value={x.lower} /> – <Pence value={x.upper} />
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pence value={x.tax} />
                {x.marginalRelief > 0 && (
                  <div className="text-[11.5px] text-ink-3">
                    less <Pence value={x.marginalRelief} /> relief
                  </div>
                )}
              </td>
            </tr>
          ))}
          <tr className="bg-panel-2 font-medium">
            <td className={tableClasses.td}>Corporation Tax chargeable</td>
            <td className={tableClasses.td} />
            <td className={cn(tableClasses.td, 'hidden sm:table-cell')} />
            <td className={cn(tableClasses.td, tableClasses.num)}>
              <Pence value={v.tax.chargeable} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="px-5 py-2 text-[12px] text-ink-3">
        Profits shared between financial years by days. The limits are the small profits limits for the period: divided by one more than its {v.settings.associatedCompanies} associated compan{v.settings.associatedCompanies === 1 ? 'y' : 'ies'}
        {v.settings.associatedSaid ? '' : ' (none said)'}, reduced for a period shorter than 12 months.
      </p>
    </div>
  );
}

function AllowancesCard({ ca, trading }: { ca: CtCapitalAllowances; trading: boolean }) {
  if (!trading && !ca.deferred.length && !ca.disposals.length) return null;
  const rows = trading ? ca.assets : ca.deferred;
  return (
    <Card title="Capital allowances" description={trading ? `Plant and machinery (CAA 2001 Part 2): the annual investment allowance first (this period’s limit ${fmt(ca.aiaLimit.period)}${ca.aiaLimit.allocated ? ', as allocated' : ''}), then full expensing or 50% where available, the rest to its pool, written down each period.` : 'Plant bought before the trade started waits for its first day (CAA 2001 s12): nothing is allowed before it.'} padded={false}>
      {rows.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>{trading ? 'Bought' : 'Waiting'}</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Qualifying</th>
                {trading && <th className={cn(tableClasses.th, tableClasses.num)}>Allowance</th>}
                {trading && <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>To its pool</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className={tableClasses.td}>
                    <span className="sensitive">{a.memo}</span>
                    <div className="text-[11.5px] text-ink-3">
                      {formatDate(a.incurred)} · {a.pool === 'special' ? 'special rate' : 'main rate'}
                      {trading && ` · ${TREATMENT[a.treatment]}`}
                      {trading && a.aia > 0 && a.firstYear > 0 && (
                        <>
                          {' '}
                          · annual investment allowance <Pence value={a.aia} />, first-year <Pence value={a.firstYear} />
                        </>
                      )}
                    </div>
                    {a.notes.map((n, i) => (
                      <div key={i} className="text-[11.5px] text-ink-3">
                        {n}
                      </div>
                    ))}
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                    <Pence value={a.qualifying} />
                  </td>
                  {trading && (
                    <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                      <Pence value={a.aia + a.firstYear} />
                    </td>
                  )}
                  {trading && (
                    <td className={cn(tableClasses.td, tableClasses.num, 'hidden align-top sm:table-cell')}>
                      <Pence value={a.toPool} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ca.disposals.length > 0 && (
        <div className="relative overflow-x-auto border-t border-line">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Left</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Disposal value</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Balancing charge</th>
              </tr>
            </thead>
            <tbody>
              {ca.disposals.map((d) => (
                <tr key={d.id}>
                  <td className={tableClasses.td}>
                    <span className="sensitive">{d.memo}</span>
                    <div className="text-[11.5px] text-ink-3">
                      {formatDate(d.date)} · fetched {fmt(d.proceeds)}
                    </div>
                    {d.notes.map((n, i) => (
                      <div key={i} className="text-[11.5px] text-ink-3">
                        {n}
                      </div>
                    ))}
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                    <Pence value={d.disposalValue} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                    <Pence value={d.balancingCharge} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ca.pools.length > 0 && (
        <div className="relative overflow-x-auto border-t border-line">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Pool</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Brought forward</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>In, less out</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Allowance</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Carried forward</th>
              </tr>
            </thead>
            <tbody>
              {ca.pools.map((x) => (
                <tr key={x.pool}>
                  <td className={tableClasses.td}>
                    {x.pool === 'main' ? 'Main pool' : 'Special rate pool'}
                    <div className="text-[11.5px] text-ink-3">
                      {x.smallPool ? 'small pool: written off' : `${x.rate}% a year`}
                      {x.balancingCharge ? ' · a balancing charge' : ''}
                      {x.afterAllowance ? (
                        <>
                          {' '}
                          · <Pence value={x.afterAllowance} /> joins after the allowance (s58)
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={x.broughtForward} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={x.additions - x.disposals} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Pence value={x.balancingCharge ? -x.balancingCharge : x.wda} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Pence value={x.carriedForward} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {trading && (
        <p className="px-5 py-3 text-[12.5px] text-ink-2">
          Annual investment allowance <Pence value={ca.aia} /> · first-year <Pence value={ca.firstYear} /> · writing-down <Pence value={ca.wda} /> · balancing charges <Pence value={ca.balancingCharges} /> · net <Pence value={ca.net} />. Balancing allowances arise only when the trade ends, which is not worked out here; nor are cars, structures and buildings, or short-life assets.
        </p>
      )}
    </Card>
  );
}

const fmt = (minor: number) => `£${fromMinor(minor).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function CarriedCard({ v }: { v: CtComputationView }) {
  const c = v.carriedForward;
  const pre = v.preTrading;
  return (
    <Card title="Carried forward" description="What this period leaves for the next, worked out period by period from the first in these books.">
      <div className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
        <KV k="Pre-trading expenditure" v={<Pence value={c.preTrading} />} sub={pre.added || pre.released ? `brought forward ${fmt(pre.broughtForward)}, added ${fmt(pre.added)}, released ${fmt(pre.released)}${pre.lapsed ? `, lapsed ${fmt(pre.lapsed)}` : ''}` : undefined} />
        <KV k="Trading losses" v={<Pence value={c.tradingLosses} />} sub={v.losses.trading.arising ? `${fmt(v.losses.trading.arising)} arising this period` : undefined} />
        <KV k="Non-trading deficits" v={<Pence value={c.nonTradingDeficits} />} />
        <KV k="Main pool" v={<Pence value={c.mainPool} />} />
        <KV k="Special rate pool" v={<Pence value={c.specialPool} />} />
      </div>
      {pre.items.length > 0 && (
        <details className="mt-3 text-[12.5px]">
          <summary className="cursor-pointer text-ink-2">Pre-trading expenses in this period ({pre.items.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-ink-2">
            {pre.items.map((i, k) => (
              <li key={k}>
                {formatDate(i.date)} · <span className="sensitive">{i.memo}</span> · {ledgerName(i.ledger)} · <Pence value={i.amount} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function KV({ k, v, sub }: { k: string; v: ReactNode; sub?: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5">
      <span className="text-ink-2">
        {k}
        {sub && <span className="block text-[11.5px] text-ink-3">{sub}</span>}
      </span>
      <span>{v}</span>
    </div>
  );
}

/** A box's value in its own units. */
function BoxValue({ b }: { b: Ct600BoxView }) {
  if (b.value === null) return <span className="text-ink-3">blank</span>;
  if (b.kind === 'money') return <Pence value={b.value as number} />;
  if (b.kind === 'pounds') return <Pounds value={b.value as number} />;
  if (b.kind === 'x') return <span>{b.value ? 'X' : <span className="text-ink-3">blank</span>}</span>;
  if (b.kind === 'date') return <span className="tabular">{formatDate(b.value as string)}</span>;
  if (b.kind === 'percent') return <span className="tabular">{String(b.value)}%</span>;
  return <span className={cn('tabular', b.kind === 'text' && 'sensitive')}>{String(b.value)}</span>;
}

function BoxesCard({ boxes, form }: { boxes: Ct600BoxView[]; form: CompanyCtResponse['form'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const sections = [...new Set(boxes.map((b) => b.section))];
  return (
    <Card
      title="The CT600’s boxes"
      description={
        <>
          From the{' '}
          <a href={form.url} className="text-accent-ink hover:underline" rel="noreferrer noopener" target="_blank">
            {form.name}
          </a>
          , labels as the form prints them. Profits, allowances and losses in whole pounds (to the nearest pound); tax in pounds and pence. Choose a box for its working.
        </>
      }
      padded={false}
    >
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <tbody>
            {sections.map((s) => (
              <Fragment key={s}>
                <tr>
                  <th colSpan={3} className={cn(tableClasses.th, 'bg-panel-2 text-left')}>
                    {s}
                  </th>
                </tr>
                {boxes
                  .filter((b) => b.section === s)
                  .map((b) => (
                    <Fragment key={b.box}>
                      <tr>
                        <td className={cn(tableClasses.td, 'w-12 align-top tabular')}>{b.box}</td>
                        <td className={tableClasses.td}>
                          <button type="button" className="text-left hover:underline" aria-expanded={open === b.box} onClick={() => setOpen((x) => (x === b.box ? null : b.box))}>
                            {b.label}
                            {b.column && <span className="text-ink-3"> · {b.column.toLowerCase()}</span>}
                          </button>
                          {open === b.box && <div className="mt-1 text-[12px] text-ink-3">{b.working}</div>}
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
                          <BoxValue b={b} />
                        </td>
                      </tr>
                    </Fragment>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PeriodsCard({ periods, current, next, onPick }: { periods: CtPeriodRow[]; current: string | undefined; next: string | undefined; onPick: (end: string) => void }) {
  const rows = [...periods].reverse();
  return (
    <Card title="Corporation Tax periods" description="Each period from when it came within the charge to the one running, its return’s and payment’s due days, its state, and the tax the books give for it." padded={false} className="no-print">
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Period</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>CT600 due</th>
              <th className={tableClasses.th}>State</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>To pay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.end} className={cn(p.end === current && 'bg-accent-soft')}>
                <td className={tableClasses.td}>
                  <button type="button" className="text-left text-accent-ink hover:underline" onClick={() => onPick(p.end)} aria-current={p.end === current ? 'true' : undefined}>
                    {formatSpan(p.start, p.end)}
                  </button>
                  <div className="text-[12px] text-ink-3">
                    {p.phase === 'pre-trading' ? 'before the trade started' : 'trading'}
                    {p.end === next ? ' · next' : ''}
                    <span className="sm:hidden"> · CT600 due {formatDate(p.returnDue)}</span>
                  </div>
                </td>
                <td className={cn(tableClasses.td, 'hidden whitespace-nowrap sm:table-cell')}>{formatDate(p.returnDue)}</td>
                <td className={tableClasses.td}>
                  <span className="inline-flex flex-wrap gap-1">
                    {STATUS[p.status]}
                    {p.differs && <Badge tone="warn">Differs from the books</Badge>}
                    {p.payment && <Badge tone="muted">{p.payment.amount === 0 ? 'Nothing to pay' : 'Paid'}</Badge>}
                  </span>
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{p.payable === null ? <span className="text-ink-3">—</span> : <Pence value={p.payable} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SetupLine({ view, companyId }: { view: CompanyCtResponse; companyId: string }) {
  const s = view.setup;
  const cihc = s.closeInvestmentHolding === null ? 'not said' : s.closeInvestmentHolding ? 'yes' : 'no';
  return (
    <div className="pb-2 text-[12.5px] text-ink-3">
      Trade started {s.tradeStartedOn ? formatDate(s.tradeStartedOn) : 'not yet (or not given)'} · within the charge {s.withinCharge.from ? `from ${formatDate(s.withinCharge.from)}${s.withinCharge.assumed ? ' (assumed)' : ''}` : 'never (dormant)'} · close investment-holding company: {cihc} ·{' '}
      <Link to={`/company/${companyId}/settings`} className="text-accent-ink hover:underline">
        Settings
      </Link>
    </div>
  );
}

export function CorporationTaxTab({ companyId }: { companyId: string }) {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const q = useApi<CompanyCtResponse>(['company-ct', companyId, period ?? 'next'], `/companies/${companyId}/corporation-tax${period ? `?period=${period}` : ''}`);
  if (q.error) return <ErrorNote error={q.error} />;
  const view = q.data;
  if (!view || view.company.id !== companyId) return <Loading />;
  const v = view.computation;
  const shown = v?.period.end ?? period;
  return (
    <div className="flex flex-col gap-5">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Field label="Corporation Tax period">
          <Select value={shown ?? ''} onChange={(e) => setPeriod(e.target.value)} aria-label="Corporation Tax period" className="w-80 max-w-full">
            {[...view.periods].reverse().map((p) => (
              <option key={p.end} value={p.end}>
                {formatSpan(p.start, p.end)} · {STATUS_WORDS[p.status]}
                {p.end === view.next ? ' · next' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <SetupLine view={view} companyId={companyId} />
      </div>
      {!view.periods.length ? (
        <EmptyState title="No Corporation Tax period yet">Its first begins when it comes within the charge: when it starts to trade or has income, such as interest (CTA 2009 s9). Give that day in Settings.</EmptyState>
      ) : !v ? (
        <Callout tone="neutral" title="Before these books">
          The books start after this period begins, so it is not worked out here{view.periods.find((p) => p.end === shown)?.ct600 ? '; its CT600 is recorded' : ''}.
        </Callout>
      ) : (
        <>
          <ComputationCard v={v} companyId={companyId} />
          <AllowancesCard ca={v.capitalAllowances} trading={v.period.phase === 'trading'} />
          <CarriedCard v={v} />
          <BoxesCard boxes={v.boxes} form={view.form} />
        </>
      )}
      <Card title="Good to know" className="no-print">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-ink-2">
          {view.guidance.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </Card>
      <CheckEverything text={view.disclaimer} />
      <PeriodsCard periods={view.periods} current={shown} next={view.next} onPick={setPeriod} />
      <p className="no-print text-[12px] text-ink-3">Worked out from the books on every visit, never stored; nothing is sent to HMRC. A correction is a coding, a journal or a setting, never an edit here. The CT600 and its payment are recorded in Settings → Filings.</p>
    </div>
  );
}
