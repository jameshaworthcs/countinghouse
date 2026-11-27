// A company's VAT tab (docs/FORMULAS.md §22, "VAT returns"): its VAT periods and their state, one
// return's nine boxes with the postings behind each, what stops it being ready to file, the return filed
// against what the books give, the errors on returns filed and how they may be corrected, HMRC's late
// submission penalty points as information, and taxable turnover against the registration thresholds.
// Everything from the company's own route (GET /api/companies/:id/vat); nothing here is a figure of
// yours, and nothing is sent to HMRC: the return is printed or exported, and filed elsewhere.

import { Download, Printer } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import type { CompanyVatResponse, VatBoxView, VatCorrectionsView, VatErrorRow, VatFiledComparison, VatLeftOut, VatPenaltyView, VatPeriodRow, VatPeriodStatus, VatReturnCheck, VatReturnView, VatThresholdView } from '../../shared/api';
import { addVatCorrection, addVatDisclosure, VAT_STAGGER_LABELS } from '../../shared/company-books';
import { formatDate, formatSpan, today } from '../../shared/dates';
import { ledgerName, VAT_TREATMENT_LABELS } from '../../shared/ledger';
import { addMoney, fromMinor, toMinor } from '../../shared/money';
import type { CompanyFiling } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn } from '../lib/format';
import { CheckEverything } from './CheckEverything';
import { CHECK_TITLES, checkLine } from './CompanyLedger';
import { Badge, Button, Callout, Card, Dialog, EmptyState, ErrorNote, Field, Input, Loading, Money, NumberInput, Select, StatusBadge, tableClasses, useToast } from './ui';

/** Pence as money. */
const Pence = ({ value, className }: { value: number | null; className?: string }) => <Money value={value === null ? null : fromMinor(value)} className={cn('sensitive tabular', className)} />;
/** Whole pounds as money, no pence. */
const Pounds = ({ value }: { value: number }) => <Money value={value} decimals={0} className="sensitive tabular" />;
/** A box's value in its own units: boxes 1–5 pence, 6–9 whole pounds. */
const BoxValue = ({ box, value }: { box: number; value: number }) => (box <= 5 ? <Pence value={value} /> : <Pounds value={value} />);

const STATUS: Record<VatPeriodStatus, ReactNode> = {
  open: <Badge tone="neutral">Open</Badge>,
  'not-ready': <StatusBadge status="warn">Not ready</StatusBadge>,
  ready: <StatusBadge status="good">Ready to file</StatusBadge>,
  filed: <Badge tone="muted">Filed</Badge>,
  'filed-late': <StatusBadge status="bad">Filed late</StatusBadge>,
  'before-books': <Badge tone="muted">Before these books</Badge>,
};
const STATUS_WORDS: Record<VatPeriodStatus, string> = { open: 'open', 'not-ready': 'not ready', ready: 'ready to file', filed: 'filed', 'filed-late': 'filed late', 'before-books': 'before these books' };

function PeriodStatus({ p }: { p: VatPeriodRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {STATUS[p.status]}
      {p.overdue && <StatusBadge status="bad">Overdue</StatusBadge>}
      {p.differs && <Badge tone="warn">Differs from the books</Badge>}
    </span>
  );
}

/** A signed net (box 3 less box 4) in words: to pay, to reclaim, or nil. */
function Net({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  if (value === 0) return <span className="tabular">nil</span>;
  return (
    <span>
      <Pence value={Math.abs(value)} /> <span className="text-[12px] text-ink-3">{value > 0 ? 'to pay' : 'to reclaim'}</span>
    </span>
  );
}

const LEFT_OUT: Record<VatLeftOut['reason'], string> = {
  outside: 'Outside the scope of VAT, not a supply (no consideration): left out of boxes 6 and 7',
  'not-a-supply': 'Not a supply (pay, pensions, depreciation, Corporation Tax, penalties, donations): never in boxes 6 and 7',
  untreated: 'No VAT treatment said: left out of boxes 6 and 7 until you say one (zero rate, exempt, supplied outside the UK or outside the scope)',
};

function checkWords(c: VatReturnCheck): { title: string; line?: ReactNode } {
  switch (c.kind) {
    case 'not-ended':
      return { title: `The period runs to ${formatDate(c.end)}: the boxes so far` };
    case 'not-in-books':
      return { title: `The books start on ${formatDate(c.ledgerFrom)}, within or after the period: what came before is not in them` };
    case 'suspense':
      return { title: 'Rows posted to suspense in the period', line: <><Pence value={c.amount} />: their VAT is not known until they are coded</> };
    case 'cash-limit':
      return {
        title: `Taxable supplies reached the cash accounting scheme’s limit for leaving (£${c.limit.toLocaleString('en-GB')}) in the 12 months to ${formatDate(c.periodEnd)}`,
        line: (
          <>
            <Pence value={c.turnover} />: the scheme ends with that period, and the VAT on everything still outstanding is due then (VAT Notice 731 paras 2.5 and 6.4). The books do not work that out, nor later returns on the normal basis.
          </>
        ),
      };
    case 'ledger':
      return { title: CHECK_TITLES[c.check.kind], line: checkLine(c.check) };
  }
}

/** One box with its working, opened beneath it. */
function BoxRow({ b, filed }: { b: VatBoxView; filed?: VatFiledComparison['boxes'][number] }) {
  const [open, setOpen] = useState(false);
  const total = b.box === 3 || b.box === 5;
  return (
    <>
      <tr className={cn(total && 'bg-panel-2 font-medium')}>
        <td className={cn(tableClasses.td, 'w-10 align-top tabular')}>{b.box}</td>
        <td className={tableClasses.td}>
          {b.label}
          {b.unsupported && <div className="text-[11.5px] text-ink-3">Not supported here (Northern Ireland’s goods): 0</div>}
          {b.exact !== undefined && b.exact !== toMinor(b.value) && (
            <div className="text-[11.5px] text-ink-3">
              exact <Pence value={b.exact} />, the pence left out
            </div>
          )}
          {b.lines.length > 0 && (
            <button type="button" className="no-print mt-0.5 block text-[12px] text-accent-ink hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide the working' : `The working (${b.lines.length})`}
            </button>
          )}
        </td>
        <td className={cn(tableClasses.td, tableClasses.num, 'align-top')}>
          <BoxValue box={b.box} value={b.value} />
          {filed && filed.difference !== 0 && (
            <div className="text-[11.5px] text-bad-ink">
              filed <BoxValue box={b.box} value={filed.filed} />
            </div>
          )}
        </td>
      </tr>
      {open &&
        b.lines.map((l) => (
          <tr key={`${b.box}:${l.postingId}`} className="text-[12.5px] text-ink-2">
            <td className={cn(tableClasses.td, 'py-1')} />
            <td className={cn(tableClasses.td, 'py-1 pl-6')}>
              <span className="whitespace-nowrap">{formatDate(l.date)}</span> · <span className="sensitive">{l.memo}</span>
              <div className="text-[11.5px] text-ink-3">
                {ledgerName(l.ledger)}
                {l.treatment && ` · ${VAT_TREATMENT_LABELS[l.treatment].toLowerCase()}`}
                {l.counted === 'reg111' && ' · from before registration: claimed in the first return'}
                {l.counted === 'tax-point' && ' · on its tax point, not its own day (reg 82)'}
              </div>
            </td>
            <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
              <Pence value={l.amount} />
            </td>
          </tr>
        ))}
    </>
  );
}

function ReturnCard({ ret, companyId }: { ret: VatReturnView; companyId: string }) {
  const p = ret.period;
  const box5 = ret.boxes.find((b) => b.box === 5)!;
  const groups = new Map<string, { title: string; lines: ReactNode[] }>();
  for (const c of ret.checks) {
    const w = checkWords(c);
    const g = groups.get(w.title) ?? groups.set(w.title, { title: w.title, lines: [] }).get(w.title)!;
    if (w.line) g.lines.push(w.line);
  }
  const leftOut = new Map<VatLeftOut['reason'], VatLeftOut[]>();
  for (const l of ret.leftOut) (leftOut.get(l.reason) ?? leftOut.set(l.reason, []).get(l.reason)!).push(l);
  return (
    <Card
      title={`VAT return for ${formatSpan(p.start, p.end)}`}
      description={
        <>
          Due by {formatDate(p.due)} · {VAT_STAGGER_LABELS[p.stagger]} · cash accounting · {STATUS_WORDS[p.status]}
          {p.first && ' · the first return after registration'}
          {p.final && ' · the final return'}
        </>
      }
      padded={false}
      actions={
        <div className="no-print flex gap-2">
          <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => window.print()}>
            Print
          </Button>
          <a href={`/api/companies/${companyId}/vat?period=${p.end}&format=csv`}>
            <Button size="sm" icon={<Download className="size-3.5" />}>
              CSV
            </Button>
          </a>
        </div>
      }
    >
      <div className="px-5 pt-4">
        {!ret.inBooks ? (
          <Callout tone="neutral" title="Before these books">
            The books start after this period, so its boxes are not worked out here.{p.filedOn ? ' What was filed is recorded below.' : ''}
          </Callout>
        ) : ret.ready ? (
          <Callout tone="good" title={p.filedOn ? `Filed ${formatDate(p.filedOn)}` : 'Ready to file'}>
            {p.filedOn
              ? `Every row in the period is coded and nothing in the books stops it${ret.filed ? ': the return filed is set against them below' : ''}.`
              : 'The period has ended, every row in it is coded and nothing stops it. Copy the boxes into your Making Tax Digital software, check each, and record the return as filed in Settings → Filings.'}
          </Callout>
        ) : (
          <div className="rounded-lg border border-line bg-panel-2 px-4 py-3">
            <div className="text-[13px] font-medium text-ink">{p.filedOn ? 'Filed; the books have checks to clear' : ret.checks.length === 1 && ret.checks[0]!.kind === 'not-ended' ? 'Not ended yet: the boxes so far' : 'Not ready to file'}</div>
            <div className="mt-2 flex flex-col gap-2 text-[13px]">
              {[...groups.values()].map((g) => (
                <details key={g.title} open={g.lines.length <= 3}>
                  <summary className="cursor-pointer text-ink">
                    {g.title} {g.lines.length > 0 && <span className="text-ink-3">({g.lines.length})</span>}
                  </summary>
                  {g.lines.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-ink-2">
                      {g.lines.slice(0, 30).map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                      {g.lines.length > 30 && <li className="text-ink-3">and {g.lines.length - 30} more</li>}
                    </ul>
                  )}
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="relative mt-3 overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Box</th>
              <th className={tableClasses.th}>What</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>From the books</th>
            </tr>
          </thead>
          <tbody>
            {ret.boxes.map((b) => (
              <BoxRow key={b.box} b={b} {...(ret.filed ? { filed: ret.filed.boxes.find((x) => x.box === b.box)! } : {})} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 px-5 py-3 text-[12.5px] text-ink-2">
        <p>
          Box 5: <Pence value={box5.value} /> {ret.direction === 'pay' ? 'to pay to HMRC' : ret.direction === 'reclaim' ? 'to reclaim from HMRC' : '(nothing to pay or reclaim)'}. Boxes 1 to 5 are in pounds and pence; boxes 6 to 9 in whole pounds, the pence left out.
        </p>
        {ret.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
        {ret.latePayment && <LatePayment l={ret.latePayment} />}
        {leftOut.size > 0 && (
          <details className="no-print">
            <summary className="cursor-pointer font-medium text-ink">Left out of boxes 6 and 7 ({ret.leftOut.length})</summary>
            <div className="mt-1 flex flex-col gap-2">
              {[...leftOut.entries()].map(([reason, list]) => (
                <div key={reason}>
                  <div className="text-ink">{LEFT_OUT[reason]}</div>
                  <ul className="pl-4">
                    {list.slice(0, 20).map((l) => (
                      <li key={l.postingId}>
                        {formatDate(l.date)} · <span className="sensitive">{l.memo}</span> · {ledgerName(l.ledger)} · <Pence value={l.amount} />
                      </li>
                    ))}
                    {list.length > 20 && <li className="text-ink-3">and {list.length - 20} more</li>}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

/** Late payment penalties on box 5, were none of it paid by its due day: information. */
function LatePayment({ l }: { l: NonNullable<VatReturnView['latePayment']> }) {
  if (!l.rates) return <p>Paid late, it would take late payment penalties at the rates then (Finance Act 2021 Sch 26), not covered here; and interest.</p>;
  const r = l.rates;
  return (
    <p>
      Paid late (due by {formatDate(l.due)}): nothing in the first {r.graceDays} days; then {r.firstPercent}% of what is unpaid on day {r.graceDays} (<Pence value={l.atFirst} /> if none of it is paid), and a further {r.secondPercent}% of what is still unpaid on day {r.secondDays} (<Pence value={l.atSecond} /> in all); from day {r.dailyFromDay} a second penalty of {r.yearlyPercent}% a year, daily, on what is unpaid, and late payment interest besides, not worked out here (Finance Act 2021 Sch 26; GOV.UK, “How late payment penalties work if you pay VAT late”). Check your VAT account for HMRC’s figures.
    </p>
  );
}

function FiledCard({ filed }: { filed: VatFiledComparison }) {
  const corrected = filed.corrections.length > 0;
  return (
    <Card title="As filed" description={`Filed on ${formatDate(filed.filedOn)}${filed.reference ? `, ${filed.reference}` : ''}${filed.late ? ', after its due day' : ''}. Each box filed against what the books give: the filing is never changed here.`} padded={false}>
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Box</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>Filed</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>Books</th>
              {corrected && <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>With corrections</th>}
              <th className={cn(tableClasses.th, tableClasses.num)}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {filed.boxes.map((b) => (
              <tr key={b.box}>
                <td className={cn(tableClasses.td, 'tabular')}>{b.box}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <BoxValue box={b.box} value={b.filed} />
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <BoxValue box={b.box} value={b.computed} />
                </td>
                {corrected && (
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <BoxValue box={b.box} value={b.expected} />
                  </td>
                )}
                <td className={cn(tableClasses.td, tableClasses.num, b.difference !== 0 && 'text-bad-ink')}>{b.difference === 0 ? '—' : <BoxValue box={b.box} value={b.difference} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1.5 px-5 py-3 text-[12.5px] text-ink-2">
        {corrected && (
          <p>
            It corrected errors on earlier returns:{' '}
            {filed.corrections.map((c, i) => (
              <Fragment key={c.periodEnd}>
                {i > 0 && ', '}
                the period to {formatDate(c.periodEnd)} <Pence value={c.amount} />
              </Fragment>
            ))}{' '}
            (in box 1 when VAT was due to HMRC, box 4 when due to the company).
          </p>
        )}
        {filed.matches ? <p className="text-good-ink">Every box filed is what the books give.</p> : filed.causes.length ? filed.causes.map((c) => <p key={c}>{c}</p>) : <p>The boxes differ: check the coding of the period, and what was filed.</p>}
      </div>
    </Card>
  );
}

function PeriodsCard({ periods, current, onPick }: { periods: VatPeriodRow[]; current: string | undefined; onPick: (end: string) => void }) {
  const rows = [...periods].reverse();
  return (
    <Card title="VAT periods" description="Each return from registration to the period running, its due day and state, and its net VAT for its own period as the books give it and as filed (less any corrections of earlier returns the filing included)." padded={false} className="no-print">
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Period</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Due</th>
              <th className={tableClasses.th}>State</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>Books</th>
              <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Filed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.end} className={cn(p.end === current && 'bg-accent-soft')}>
                <td className={tableClasses.td}>
                  <button type="button" className="text-left text-accent-ink hover:underline" onClick={() => onPick(p.end)} aria-current={p.end === current ? 'true' : undefined}>
                    {formatSpan(p.start, p.end)}
                  </button>
                  <div className="text-[12px] text-ink-3 sm:hidden">due {formatDate(p.due)}</div>
                </td>
                <td className={cn(tableClasses.td, 'hidden whitespace-nowrap sm:table-cell')}>{formatDate(p.due)}</td>
                <td className={tableClasses.td}>
                  <PeriodStatus p={p} />
                  {p.filedOn && <div className="text-[12px] text-ink-3">filed {formatDate(p.filedOn)}</div>}
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <Net value={p.computed} />
                </td>
                <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                  <Net value={p.filed} />
                  {p.correctionsIncluded !== undefined && (
                    <div className="text-[11.5px] text-ink-3">
                      for its own period; its filing also corrected <Pence value={p.correctionsIncluded} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type VatFiling = Extract<CompanyFiling, { kind: 'vat' }>;

/** Record that an error was corrected: on a later return (method 1), or reported to HMRC separately (method 2). */
function CorrectionDialog({ companyId, error, filings, onClose }: { companyId: string; error: VatErrorRow; filings: VatFiling[]; onClose: () => void }) {
  const toast = useToast();
  const later = filings.filter((f) => (f.periodStart ?? f.periodEnd) > error.end).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const own = filings.find((f) => f.periodEnd === error.end);
  const [how, setHow] = useState<'return' | 'separately'>(later.length ? 'return' : 'separately');
  const [on, setOn] = useState(later[0]?.id ?? '');
  const [amount, setAmount] = useState<number | undefined>(fromMinor(error.uncorrected));
  const [day, setDay] = useState(today());
  const [reference, setReference] = useState('');
  // What is recorded already, on the return chosen (method 1) or on the return itself (method 2): what is entered is added to it.
  const target = later.find((x) => x.id === on);
  const already = how === 'return' ? (target?.corrections?.find((c) => c.periodEnd === error.end)?.amount ?? 0) : (own?.disclosed?.amount ?? 0);
  const save = useApiMutation(
    () => {
      if (how === 'return') return api(`/companies/${companyId}/filings/${target!.id}/vat-corrections`, { method: 'PUT', body: { corrections: addVatCorrection(target!.corrections, error.end, amount ?? 0) } });
      const disclosed = addVatDisclosure(own!.disclosed, day, amount ?? 0, reference);
      return api(`/companies/${companyId}/filings/${own!.id}/vat-corrections`, { method: 'PUT', body: { disclosed: disclosed ?? null } });
    },
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Recorded' });
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`The error on the return for ${formatSpan(error.start, error.end)}`}
      description="What was done about it: corrected on a later return (its box 1 or 4 included it), or reported to HMRC separately. The amount is net VAT, positive when the company owed HMRC."
      footer={
        <>
          {save.error && <span className="mr-auto self-center text-[12px] text-bad-ink">{save.error.message}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!amount || (how === 'return' ? !target : !own)} onClick={() => save.mutate(undefined)}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="How">
          <Select value={how} onChange={(e) => setHow(e.target.value as 'return' | 'separately')}>
            <option value="return" disabled={!later.length}>
              Corrected on a later return (method 1)
            </option>
            <option value="separately">Reported to HMRC separately (method 2)</option>
          </Select>
        </Field>
        {how === 'return' ? (
          <Field label="On the return for" hint={later.length ? undefined : 'Record the later return in Settings → Filings first.'}>
            <Select value={on} onChange={(e) => setOn(e.target.value)}>
              {later.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.periodStart ? formatSpan(f.periodStart, f.periodEnd) : `the period to ${formatDate(f.periodEnd)}`}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reported on">
              <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label="HMRC’s reference (optional)">
              <Input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
        )}
        <Field
          label={already ? 'Net VAT corrected now, added to what is recorded' : 'Net VAT corrected'}
          hint={
            already ? (
              <>
                Already recorded {how === 'return' ? 'on that return for this period' : 'as reported separately'}: <Pence value={toMinor(already)} />; with this, <Pence value={toMinor(addMoney(already, amount ?? 0))} />. Positive: VAT the company owed HMRC.
              </>
            ) : (
              'Positive: VAT the company owed HMRC; negative: VAT due to it.'
            )
          }
        >
          <NumberInput value={amount} onValue={setAmount} className="sensitive tabular sm:w-48" />
        </Field>
      </div>
    </Dialog>
  );
}

function CorrectionsCard({ c, companyId, filings }: { c: VatCorrectionsView; companyId: string; filings: VatFiling[] }) {
  const [editing, setEditing] = useState<VatErrorRow | null>(null);
  const pounds = (n: number) => `£${n.toLocaleString('en-GB')}`;
  return (
    <Card title="Errors on returns filed" description="Where a return filed differs from the books in its net VAT (VAT Notice 700/45). Information: check each before you act on it." padded={false}>
      {c.errors.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No errors found">Every return filed that the books cover whole has the net VAT the books give, after the corrections recorded.</EmptyState>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Return</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Error</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Left</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Running total</th>
                <th className={tableClasses.th}>
                  <span className="sr-only">Record</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {c.errors.map((e) => (
                <tr key={e.end}>
                  <td className={tableClasses.td}>
                    {formatSpan(e.start, e.end)}
                    <div className="text-[12px] text-ink-3">
                      output tax <Pence value={e.output} /> {e.output !== 0 && `(in time until ${formatDate(e.outputUntil)})`}, input tax <Pence value={e.input} /> {e.input !== 0 && `(in time until ${formatDate(e.inputUntil)})`}
                      {e.outOfTime && ' · out of time'}
                      {e.unsettled && ' · its books have checks to clear, so it is not counted'}
                      {e.correctedBy.map((x, i) => (
                        <Fragment key={i}>
                          {' '}
                          · {x.kind === 'return' ? `corrected on the return to ${formatDate(x.periodEnd)}` : `reported separately on ${formatDate(x.on)}`} <Pence value={x.amount} />
                        </Fragment>
                      ))}
                    </div>
                    <div className="text-[12px] text-ink-3 sm:hidden">
                      left <Pence value={e.uncorrected} />
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Pence value={e.error} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={e.uncorrected} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={e.runningTotal} />
                  </td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    {e.uncorrected !== 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>
                        Record
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-col gap-1.5 px-5 py-3 text-[12.5px] text-ink-2">
        {c.method !== 'none' && (
          <p className="font-medium text-ink">
            Net of the errors left: <Pence value={c.net} /> {c.net > 0 ? 'due to HMRC' : 'due to the company'}.{' '}
            {c.method === 'next-return'
              ? `It may be corrected on the current return${c.on ? ` (for ${formatSpan(c.on.start, c.on.end)})` : ''}, in box ${c.net > 0 ? 1 : 4}${c.limit === 'box6' ? `: above ${pounds(c.rules.limit)}, but within ${c.rules.box6Percent}% of its box 6 and ${pounds(c.rules.upperLimit)}` : ''}.`
              : 'It is over the limit for the current return: report it to HMRC separately (method 2: online or in writing).'}
          </p>
        )}
        <p>
          A net error of up to {pounds(c.rules.limit)}, or up to {pounds(c.rules.upperLimit)} when that is no more than {c.rules.box6Percent}% of box 6 of the return for the period it is found in{c.on ? ` (${formatSpan(c.on.start, c.on.end)}: box 6 so far £${c.on.box6.toLocaleString('en-GB')}${c.on.provisional ? ', provisional' : ''})` : ''}, may be corrected on that return (method 1); anything more, or any error made deliberately, is reported separately (method 2: online or in writing, form VAT652 having been withdrawn), which may be chosen for any error. Each part of an error is corrected within {c.rules.years} years: output tax, and input tax claimed too much, from the end of its period; input tax under-claimed from the return’s due day (VAT Notice 700/45 sections 4.2–4.7).
        </p>
      </div>
      {editing && <CorrectionDialog companyId={companyId} error={editing} filings={filings} onClose={() => setEditing(null)} />}
    </Card>
  );
}

const FREQ: Record<'annual' | 'quarterly' | 'monthly', string> = { annual: 'annual', quarterly: 'quarterly', monthly: 'monthly' };

function PenaltiesCard({ p }: { p: VatPenaltyView }) {
  const r = p.rules;
  return (
    <Card title="Late submission penalty points" description="HMRC’s points for returns filed late, as information: check your VAT account for HMRC’s figure." padded={false}>
      {p.late.length === 0 ? (
        <div className="p-5 text-[13px] text-ink-2">No return here was filed late, or is overdue.</div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Return</th>
                <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Due</th>
                <th className={tableClasses.th}>Filed</th>
                <th className={tableClasses.th}>Point</th>
              </tr>
            </thead>
            <tbody>
              {p.late.map((l) => (
                <tr key={l.end}>
                  <td className={tableClasses.td}>
                    {formatSpan(l.start, l.end)}
                    <div className="text-[12px] text-ink-3 sm:hidden">due {formatDate(l.due)}</div>
                  </td>
                  <td className={cn(tableClasses.td, 'hidden whitespace-nowrap sm:table-cell')}>{formatDate(l.due)}</td>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{l.filedOn ? `${formatDate(l.filedOn)} (${l.days} day${l.days === 1 ? '' : 's'} late)` : <StatusBadge status="bad">Not filed</StatusBadge>}</td>
                  <td className={cn(tableClasses.td, 'text-[12.5px]')}>
                    {l.regime === 'points' ? `A point; it would expire on ${formatDate(l.expires)} below the threshold` : l.regime === 'excluded' ? (l.excluded === 'first' ? 'None: the first return after registration takes no point' : 'None: the final return takes no point') : 'Before points: the default surcharge applied'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-col gap-1.5 px-5 py-3 text-[12.5px] text-ink-2">
        <p className="font-medium text-ink">
          {p.live} point{p.live === 1 ? '' : 's'} from these would still count today, were the threshold never reached. The threshold for {FREQ[p.frequency]} returns is {r.thresholds[p.frequency]}: check your VAT account for HMRC’s figure.
        </p>
        <p>
          A point for each return submitted late (nil and repayment returns too) for periods starting on or after {formatDate(p.from)}; the default surcharge applied before. At the threshold (annual {r.thresholds.annual}, quarterly {r.thresholds.quarterly}, monthly {r.thresholds.monthly}) a £{r.penalty} penalty, and another for each later late return. Below it, a point expires at the end of the month {r.expiryMonths} months after the month the return was due ({r.expiryMonths + 1} when due on a month’s last day). At it, the points are reset only after a period of compliance (annual {r.complianceMonths.annual} months, quarterly {r.complianceMonths.quarterly}, monthly {r.complianceMonths.monthly}) with every return due in the previous {r.outstandingMonths} months submitted.
        </p>
        <p>
          A change of frequency adjusts the points (never below nothing): annual to quarterly +{r.frequencyChange.annual.quarterly}, annual to monthly +{r.frequencyChange.annual.monthly}, quarterly to monthly +{r.frequencyChange.quarterly.monthly}, quarterly to annual {r.frequencyChange.quarterly.annual}, monthly to quarterly {r.frequencyChange.monthly.quarterly}, monthly to annual {r.frequencyChange.monthly.annual}.
          {p.changes.map((c) => ` This company changed from ${FREQ[c.was]} to ${FREQ[c.to]} on ${formatDate(c.from)}: ${c.adjustment > 0 ? '+' : ''}${c.adjustment}.`).join('')}
        </p>
      </div>
    </Card>
  );
}

function ThresholdCard({ t }: { t: VatThresholdView }) {
  const [open, setOpen] = useState(false);
  const pounds = (n: number) => `£${n.toLocaleString('en-GB')}`;
  return (
    <Card
      title="Taxable turnover and the thresholds"
      description={`Taxable turnover in the 12 months to ${formatDate(t.to)}, from the books, against the VAT registration and deregistration thresholds in force (${pounds(t.registration)} and ${pounds(t.deregistration)} from ${formatDate(t.thresholdsFrom)}). Information only.`}
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide the months' : 'Each month'}
        </Button>
      }
    >
      <div className="flex flex-col gap-2 text-[13px] text-ink-2">
        <div className="text-[22px] font-semibold text-ink">
          <Pence value={t.taxable} />
        </div>
        <p>
          Taxable sales <Pence value={t.parts.sales} />, sales with no VAT treatment counted as taxable <Pence value={t.parts.untreated} />, services received from abroad under the reverse charge <Pence value={t.parts.reverseCharge} />. Exempt sales, interest, sales outside the scope or supplied outside the UK, and the sale of the company’s own fixed assets are left out. The law counts supplies when they are made (their tax point); the books count them when paid, so sales on credit not yet paid are missing, and for a company not registered the figure can be too low.
          {t.partial && ' The books start within these 12 months: what came before is not in them.'}
        </p>
        <p>
          {t.registered
            ? t.taxable < toMinor(t.deregistration)
              ? `The last 12 months were below the deregistration threshold (${pounds(t.deregistration)}). That is a hint, not the test: a registered business may cancel when HMRC are satisfied its taxable supplies in the year ahead will not exceed it (VATA 1994 Sch 1 para 4).`
              : `Registered, and the last 12 months were above the deregistration threshold (${pounds(t.deregistration)}); the test for cancelling looks at the year ahead (VATA 1994 Sch 1 para 4).`
            : t.taxable > toMinor(t.registration)
              ? `Over the registration threshold: a business must register when its taxable turnover in the last 12 months goes over ${pounds(t.registration)}, from the first day of the second month after.`
              : `Not registered here, and under the registration threshold (${pounds(t.registration)}). It must also register if it expects to go over it in the next 30 days alone.`}
        </p>
        {t.registered && (
          <p>
            Cash accounting: taxable supplies with the sale of capital assets, <Pence value={t.cash.turnover} /> in these 12 months, against {pounds(t.cash.join)} to join and {pounds(t.cash.leave)} to leave (VAT Notice 731 paras 2.1 and 2.5).{' '}
            {t.cash.over ? 'Over the limit for leaving: the scheme ends with the current period, and the VAT on everything outstanding is due then.' : 'Within the scheme.'} Supplies the scheme excludes (payment not due within 6 months, or invoiced before the supply: VAT Regulations 1995 reg 58(2)) are not detected.
          </p>
        )}
        {open && (
          <div className="relative overflow-x-auto">
            <table className={tableClasses.table}>
              <thead>
                <tr>
                  <th className={tableClasses.th}>12 months to</th>
                  <th className={cn(tableClasses.th, tableClasses.num)}>Taxable turnover</th>
                  <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Registration</th>
                </tr>
              </thead>
              <tbody>
                {t.months.map((m) => (
                  <tr key={m.end}>
                    <td className={tableClasses.td}>{formatDate(m.end)}</td>
                    <td className={cn(tableClasses.td, tableClasses.num)}>
                      <Pence value={m.taxable} />
                    </td>
                    <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>{pounds(m.registration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The VAT tab: the periods, a return, and what bears on them. */
export function VatTab({ companyId, filings }: { companyId: string; filings: CompanyFiling[] }) {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const q = useApi<CompanyVatResponse>(['company-vat', companyId, period ?? 'next'], `/companies/${companyId}/vat${period ? `?period=${period}` : ''}`);
  if (q.error) return <ErrorNote error={q.error} />;
  const view = q.data;
  if (!view || view.company.id !== companyId) return <Loading />;
  const vatFilings = filings.filter((f): f is VatFiling => f.kind === 'vat');
  if (!view.registration)
    return (
      <div className="flex flex-col gap-5">
        <Card title="Not registered for VAT here" description="Give its VAT registration in Settings to work out its returns from the books.">
          <p className="text-[13px] text-ink-2">Its taxable turnover against the registration threshold is below.</p>
        </Card>
        <ThresholdCard t={view.threshold} />
      </div>
    );
  const ret = view.ret;
  return (
    <div className="flex flex-col gap-5">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Field label="VAT period">
          <Select value={ret?.period.end ?? ''} onChange={(e) => setPeriod(e.target.value)} aria-label="VAT period" className="w-80 max-w-full">
            {[...view.periods].reverse().map((p) => (
              <option key={p.end} value={p.end}>
                {formatSpan(p.start, p.end)} · {STATUS_WORDS[p.status]}
                {p.end === view.next ? ' · next to file' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="pb-2 text-[12.5px] text-ink-3">
          Registered from {formatDate(view.registration.registeredFrom)}
          {view.registration.deregisteredOn && `, deregistered ${formatDate(view.registration.deregisteredOn)}`} · cash accounting
        </div>
      </div>
      {ret ? <ReturnCard ret={ret} companyId={companyId} /> : <EmptyState title="No VAT period yet">Its first period begins on registration.</EmptyState>}
      {ret?.filed && <FiledCard filed={ret.filed} />}
      <CheckEverything text={view.disclaimer} />
      <div className="no-print flex flex-col gap-5">
        <PeriodsCard periods={view.periods} current={ret?.period.end} onPick={setPeriod} />
        <section className="grid gap-5 xl:grid-cols-2">
          <CorrectionsCard c={view.corrections} companyId={companyId} filings={vatFilings} />
          {view.penalties && <PenaltiesCard p={view.penalties} />}
        </section>
        <ThresholdCard t={view.threshold} />
        <p className="text-[12px] text-ink-3">Worked out from the books on every visit, never stored; nothing is sent to HMRC. A correction is a coding or a journal, never an edit here.</p>
      </div>
    </div>
  );
}
