// A tax year's Self Assessment return, box by box (docs/FORMULAS.md §20): what is left to do, the
// questions it turns on, each page with the figure to enter and where it came from, and the tax
// worked out from those boxes, with what is still to pay and when.

import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleHelp, FileText, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ReturnBoxView, ReturnPageView, ReturnQuestion, ReturnTrace, TaxReturnView } from '../../shared/api';
import { formatDate } from '../../shared/dates';
import type { CalcLine } from '../../shared/taxcalc';
import { api, useApiMutation } from '../lib/api';
import { cn, plural } from '../lib/format';
import { Badge, Button, Callout, Card, Input, Money, NumberInput, Segmented, Select, StatusBadge, useToast } from './ui';

type Value = number | string | boolean | null;

function useSaveEntry(taxYear: string) {
  const toast = useToast();
  return useApiMutation((v: { key: string; value?: Value; clear?: boolean; note?: string }) => api('/self-assessment/entry', { method: 'PUT', body: { taxYear, ...v } }), {
    onError: (e) => toast({ tone: 'bad', text: e.message }),
  });
}

const STATE: Record<ReturnBoxView['state'], { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  records: { label: 'From your records', tone: 'good' },
  yours: { label: 'Your figure', tone: 'info' },
  nil: { label: 'None', tone: 'muted' },
  missing: { label: 'Missing', tone: 'bad' },
  check: { label: 'Check', tone: 'warn' },
  blank: { label: 'Blank', tone: 'muted' },
};

function StateBadge({ state }: { state: ReturnBoxView['state'] }) {
  const s = STATE[state];
  if (s.tone === 'muted') return <Badge tone="muted">{s.label}</Badge>;
  return <StatusBadge status={s.tone}>{s.label}</StatusBadge>;
}

const anchor = (key: string) => `ret-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;

/** What is left before the return is ready, with what you owe for the year, and when. */
function Summary({ r }: { r: TaxReturnView }) {
  const o = r.owed;
  const c = r.calculation;
  const refund = o.balance < 0;
  const poa = o.withoutCoding.poa;
  return (
    <Card
      title={`Your ${r.taxYear.label} return`}
      description={r.forms.own ? `Box by box on HMRC’s ${r.taxYear.label} forms (the ${r.forms.edition} editions).` : `On the ${r.forms.taxYear} forms: HMRC has not published the ${r.taxYear.label} ones yet.`}
      actions={r.readiness.ready ? <StatusBadge status="good">Ready to check and enter</StatusBadge> : <StatusBadge status="warn">{plural(r.readiness.blockers.length, 'thing')} to settle</StatusBadge>}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Tax for the year" value={o.liability} sub="Income tax and any other charges, as worked out below" />
        <Figure label="Already taken off" value={o.deductedAtSource} sub="Through your pay (PAYE) and at source" />
        <Figure label={refund ? 'To be repaid to you' : 'Left to pay for the year'} value={Math.abs(o.balance)} sub={o.paymentsOnAccountMade ? `After ${formatMoneyPlain(o.paymentsOnAccountMade)} paid on account` : 'Before any payment you have made since'} />
        <Figure label="Payments on account" value={poa.reason === 'due' ? poa.first + poa.second : 0} sub={poa.reason === 'due' ? `For ${nextYear(r.taxYear.label)}: two of about ${formatMoneyPlain(poa.first)}` : poa.reason === 'mostly-at-source' ? 'None: most of the tax was taken off at source' : 'None: what is left is under £1,000'} />
      </div>
      {!r.readiness.ready && <p className="mt-3 text-[12.5px] text-ink-3">Provisional: these figures change as you settle the list below.</p>}
      {(o.withCoding || o.withoutCoding.dueJanuary > 0 || o.withoutCoding.dueJuly > 0) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {o.withCoding && (
            <div className="rounded-lg border border-line bg-panel-2 px-4 py-3 text-[13px]">
              <div className="font-semibold text-ink">Pay through your tax code</div>
              <p className="mt-1 text-ink-2">
                Send the return online by <span className="font-medium text-ink">{formatDate(o.withCoding.by)}</span> and leave TR 6 box 2 blank: HMRC can collect <Money value={o.withCoding.coded} /> through your pay from April {Number(r.taxYear.label.slice(0, 4)) + 2}.{' '}
                {o.withCoding.dueJanuary > 0 || o.withCoding.dueJuly > 0 ? (
                  <>
                    Still due: <Money value={o.withCoding.dueJanuary} /> by {formatDate(o.januaryDue)} and <Money value={o.withCoding.dueJuly} /> by {formatDate(o.julyDue)}.
                  </>
                ) : (
                  <>Nothing to pay in January, and no payments on account.</>
                )}
              </p>
              <p className="mt-1 text-[12px] text-ink-3">HMRC decides: only with enough pay or pension through PAYE, and not if it would double the tax on it or take more than half of it.</p>
            </div>
          )}
          <div className="rounded-lg border border-line bg-panel-2 px-4 py-3 text-[13px]">
            <div className="font-semibold text-ink">{o.withCoding ? 'Or pay HMRC directly' : 'What to pay HMRC'}</div>
            <p className="mt-1 text-ink-2">
              {o.withoutCoding.dueJanuary >= 0 ? (
                <>
                  <Money value={o.withoutCoding.dueJanuary} /> by <span className="font-medium text-ink">{formatDate(o.januaryDue)}</span>
                </>
              ) : (
                <>
                  A credit of <Money value={-o.withoutCoding.dueJanuary} /> after {formatDate(o.januaryDue)}
                </>
              )}
              {poa.reason === 'due' && (
                <>
                  {' '}
                  (<Money value={o.balance} /> for {r.taxYear.label}, and the first payment on account, <Money value={poa.first} />), then <Money value={o.withoutCoding.dueJuly} /> by {formatDate(o.julyDue)}
                </>
              )}
              .
            </p>
          </div>
        </div>
      )}
      {refund && poa.reason !== 'due' && <p className="mt-4 text-[13px] text-ink-2">HMRC owes you <Money value={-o.balance} />: give your bank details in TR 6 boxes 4 to 14 (online, in the repayment section) to have it paid there.</p>}
      {c.marriageAllowanceRefused && <Callout tone="warn" className="mt-3">Marriage Allowance is not given: some of your income is over the basic rate limit.</Callout>}
    </Card>
  );
}

function nextYear(label: string) {
  const y = Number(label.slice(0, 4)) + 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

function formatMoneyPlain(v: number) {
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Figure({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="text-[20px] font-semibold text-ink tabular">
        <Money value={value} />
      </div>
      {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

/** Everything that stops the return being ready, each linking to its place below. */
function ToDo({ r }: { r: TaxReturnView }) {
  if (r.readiness.ready) return <Callout tone="good" title="Nothing left to settle">Every box has a figure from your records or from you, and nothing outside what Counting House prepares applies. Check each figure against your documents as you enter it.</Callout>;
  const groups: { kind: TaxReturnView['readiness']['blockers'][number]['kind']; title: string }[] = [
    { kind: 'not-covered', title: 'Outside what Counting House prepares' },
    { kind: 'question', title: 'Questions to answer' },
    { kind: 'missing', title: 'Figures missing' },
    { kind: 'check', title: 'Figures to check' },
  ];
  return (
    <Card title="Before the return is ready" description="A gap is never shown as a nil: each of these is something only you can settle.">
      <div className="flex flex-col gap-4">
        {groups.map((g) => {
          const list = r.readiness.blockers.filter((b) => b.kind === g.kind);
          if (!list.length) return null;
          return (
            <div key={g.kind}>
              <div className="mb-1 text-[12.5px] font-semibold text-ink-2">
                {g.title} ({list.length})
              </div>
              {g.kind === 'question' ? (
                <a href="#ret-questions" className="text-[13px] text-ink-2 hover:text-ink hover:underline">
                  {plural(list.length, 'question')} below, each a click: Yes, No or a choice.
                </a>
              ) : (
              <ul className="flex flex-col gap-1 text-[13px]">
                {list.map((b) => (
                  <li key={b.key + b.text} className="flex gap-2">
                    {g.kind === 'not-covered' ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-3" />}
                    <a href={`#${anchor(b.key)}`} className="text-ink-2 hover:text-ink hover:underline">
                      {b.text.replace(/^Answer: /, '')}
                    </a>
                  </li>
                ))}
              </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function answerLabel(q: ReturnQuestion, v: Value): string {
  if (q.choices) return q.choices.find((c) => c.value === v)?.label ?? String(v);
  return v === true ? 'Yes' : v === false ? 'No' : '—';
}

/** The questions the return turns on: yours, inferred from your records, or open. */
function Questions({ r }: { r: TaxReturnView }) {
  const save = useSaveEntry(r.taxYear.label);
  const open = r.questions.filter((q) => q.state === 'unanswered');
  return (
    <Card id="ret-questions" title="Questions the return turns on" description="What you answer here decides which pages and boxes apply. An answer from your records is a suggestion until you confirm it." padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {r.questions.map((q) => (
          <li key={q.key} id={anchor(q.key)} className="scroll-mt-20 px-5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 basis-72">
                <div className="text-[13.5px] font-medium text-ink">{q.text}</div>
                {q.help && <div className="mt-0.5 text-[12.5px] text-ink-3">{q.help}</div>}
                {q.state === 'inferred' && q.inferred && (
                  <div className="mt-1 text-[12.5px] text-ink-2">
                    From your records: <span className="font-medium">{answerLabel(q, q.inferred.answer)}</span>. {q.inferred.why}.
                  </div>
                )}
                {q.coverage === 'not-covered' && q.answer === true && <div className="mt-1 text-[12.5px] text-warn-ink">{q.notCovered}</div>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {q.state === 'answered' ? <Badge tone="accent">Your answer</Badge> : q.state === 'inferred' ? <Badge tone="neutral">Suggested</Badge> : <Badge tone="warn">To answer</Badge>}
                {q.choices ? (
                  <Select aria-label={q.text} value={typeof q.answer === 'string' ? q.answer : ''} onChange={(e) => save.mutate({ key: q.key, value: e.target.value })} className="w-72 max-w-full">
                    <option value="" disabled>
                      Choose…
                    </option>
                    {q.choices.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Segmented<'yes' | 'no' | ''>
                    size="sm"
                    label={q.text}
                    value={q.answer === true ? 'yes' : q.answer === false ? 'no' : ''}
                    onChange={(v) => save.mutate({ key: q.key, value: v === 'yes' })}
                    options={[
                      { value: 'yes', label: 'Yes' },
                      { value: 'no', label: 'No' },
                    ]}
                  />
                )}
                {q.state === 'inferred' && (
                  <Button size="sm" variant="ghost" onClick={() => save.mutate({ key: q.key, value: q.inferred!.answer })}>
                    Confirm
                  </Button>
                )}
                {q.state === 'answered' && (
                  <Button size="sm" variant="ghost" onClick={() => save.mutate({ key: q.key, clear: true })} title="Forget your answer">
                    Undo
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {open.length > 0 && <div className="border-t border-line px-5 py-2.5 text-[12.5px] text-ink-3">{plural(open.length, 'question')} still to answer.</div>}
    </Card>
  );
}

function Trace({ trace }: { trace: ReturnTrace[] }) {
  if (!trace.length) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-[12.5px]">
      {trace.map((t, i) => (
        <li key={i} className="flex justify-between gap-3 text-ink-2">
          <span className="min-w-0 truncate">
            {t.date ? `${formatDate(t.date)} · ` : ''}
            {t.ref?.type === 'account' ? (
              <Link to={`/accounts/${t.ref.id}`} className="hover:underline">
                {t.label}
              </Link>
            ) : t.ref?.type === 'transaction' && t.ref.accountId && t.date ? (
              <Link to={`/transactions?accounts=${t.ref.accountId}&period=custom&from=${t.date}&to=${t.date}`} className="hover:underline">
                {t.label}
              </Link>
            ) : (
              t.label
            )}
          </span>
          {t.amount !== undefined && <Money value={t.amount} className="shrink-0 tabular" />}
        </li>
      ))}
    </ul>
  );
}

/** Your figure for a box: a value of its kind, a nil, or back to the records. */
function BoxEditor({ b, taxYear, onDone }: { b: ReturnBoxView; taxYear: string; onDone: () => void }) {
  const save = useSaveEntry(taxYear);
  const [num, setNum] = useState<number | undefined>(typeof b.value === 'number' ? b.value : undefined);
  const [text, setText] = useState(typeof b.value === 'string' ? b.value : '');
  const [note, setNote] = useState('');
  const submit = (value: Value) => save.mutate({ key: b.key, value, ...(note.trim() ? { note } : {}) }, { onSuccess: onDone });
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-3">
      {b.kind === 'money' || b.kind === 'number' || b.kind === 'percent' ? (
        <NumberInput aria-label={`Box ${b.box}`} value={num} onValue={setNum} className="w-36" signed={b.label.includes('tax taken off')} />
      ) : b.kind === 'yesno' || b.kind === 'x' ? null : (
        <Input aria-label={`Box ${b.box}`} type={b.kind === 'date' ? 'date' : 'text'} value={text} onChange={(e) => setText(e.target.value)} className="w-56" maxLength={300} />
      )}
      <Input aria-label="Note" placeholder="Where it comes from (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-56 max-w-full" maxLength={300} />
      {b.kind === 'yesno' ? (
        <>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => submit(true)}>
            Yes
          </Button>
          <Button size="sm" loading={save.isPending} onClick={() => submit(false)}>
            No
          </Button>
        </>
      ) : b.kind === 'x' ? (
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => submit(true)}>
          Put an X
        </Button>
      ) : (
        <Button size="sm" variant="primary" loading={save.isPending} disabled={b.kind === 'money' || b.kind === 'number' || b.kind === 'percent' ? num === undefined : !text.trim()} onClick={() => submit(b.kind === 'money' || b.kind === 'number' || b.kind === 'percent' ? num! : text)}>
          Save
        </Button>
      )}
      {b.kind !== 'yesno' && !b.nilRefused && (
        <Button size="sm" loading={save.isPending} onClick={() => submit(null)} title="A genuine nil: nothing to enter">
          None
        </Button>
      )}
      {(b.state === 'yours' || b.state === 'nil') && b.fromRecords !== undefined && (
        <Button size="sm" variant="ghost" loading={save.isPending} onClick={() => save.mutate({ key: b.key, clear: true }, { onSuccess: onDone })}>
          Use the records’ figure
        </Button>
      )}
      {(b.state === 'yours' || b.state === 'nil') && b.fromRecords === undefined && (
        <Button size="sm" variant="ghost" loading={save.isPending} onClick={() => save.mutate({ key: b.key, clear: true }, { onSuccess: onDone })}>
          Clear
        </Button>
      )}
    </div>
  );
}

function BoxRow({ b, taxYear }: { b: ReturnBoxView; taxYear: string }) {
  const [open, setOpen] = useState(b.state === 'missing');
  const [editing, setEditing] = useState(false);
  return (
    <li id={anchor(b.key)} className="scroll-mt-20 px-5 py-2.5">
      <div className="grid grid-cols-[3.25rem_1fr] gap-x-3 gap-y-1 sm:grid-cols-[3.25rem_1fr_auto]">
        <div className="pt-0.5 text-[12.5px] font-semibold text-ink-2 tabular">
          {b.box}
          {b.page && <div className="text-[10.5px] font-normal text-ink-3">{b.page}</div>}
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 items-start gap-1 text-left text-[13px] text-ink hover:text-accent">
          {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-ink-3" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-ink-3" />}
          <span>{b.label}</span>
        </button>
        <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:row-start-1 sm:justify-end">
          <StateBadge state={b.state} />
          <span className={cn('min-w-[5.5rem] text-right font-mono text-[14px] font-semibold tabular', b.entered ? 'text-ink' : 'text-ink-3')} title="What to enter online">
            {b.entered || (b.state === 'missing' ? '?' : '—')}
          </span>
        </div>
      </div>
      {open && (
        <div className="mt-1.5 ml-[4rem] text-[12.5px]">
          <div className="text-ink-2">{b.basis}</div>
          {b.paper && <div className="text-ink-3">On paper: {b.paper} (whole pounds, rounded as the form says).</div>}
          {b.check && <div className="mt-0.5 text-warn-ink">{b.check}</div>}
          {b.state === 'yours' && b.fromRecords !== undefined && b.fromRecords !== null && <div className="text-ink-3">Your records give {typeof b.fromRecords === 'number' ? formatMoneyPlain(b.fromRecords) : String(b.fromRecords)}.</div>}
          {b.notes.map((n, i) => (
            <div key={i} className="text-ink-3">
              {n}
            </div>
          ))}
          <Trace trace={b.trace} />
          {b.editable && !editing && (
            <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => setEditing(true)}>
              {b.state === 'missing' || b.state === 'blank' ? 'Fill in' : 'Change'}
            </Button>
          )}
          {editing && <BoxEditor b={b} taxYear={taxYear} onDone={() => setEditing(false)} />}
        </div>
      )}
    </li>
  );
}

function Page({ p, taxYear }: { p: ReturnPageView; taxYear: string }) {
  const [all, setAll] = useState(false);
  const shown = p.boxes.filter((b) => b.always || b.state !== 'blank');
  const hidden = p.boxes.length - shown.length;
  const boxes = all ? p.boxes : shown;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <FileText className="size-4 text-ink-3" />
          <span>
            {p.form} {p.page}: {p.title}
          </span>
          {p.instance && <Badge tone="neutral">{p.instance}</Badge>}
        </span>
      }
      padded={false}
    >
      <ul className="divide-y divide-line border-t border-line">
        {boxes.map((b) => (
          <BoxRow key={b.key} b={b} taxYear={taxYear} />
        ))}
        {!boxes.length && <li className="px-5 py-3 text-[13px] text-ink-3">Nothing to enter on this page.</li>}
      </ul>
      {hidden > 0 && (
        <div className="no-print border-t border-line px-5 py-2">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? 'Hide the blank boxes' : `Show the other ${plural(hidden, 'box', 'boxes')} on this page`}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Row({ label, amount, rate, tax, strong, sub }: { label: ReactNode; amount?: number; rate?: number; tax?: number; strong?: boolean; sub?: boolean }) {
  return (
    <tr className={cn(strong && 'font-semibold text-ink', sub && 'text-ink-3')}>
      <td className="py-1 pr-3">{label}</td>
      <td className="py-1 pr-3 text-right tabular">{amount !== undefined && <Money value={amount} />}</td>
      <td className="hidden py-1 pr-3 text-right tabular sm:table-cell">{rate !== undefined && `${+(rate * 100).toFixed(2)}%`}</td>
      <td className="py-1 text-right tabular">{tax !== undefined && <Money value={tax} />}</td>
    </tr>
  );
}

/** The tax worked out from the boxes, step by step, as HMRC works it out. */
function Working({ r }: { r: TaxReturnView }) {
  const c = r.calculation;
  const lines = (list: CalcLine[]) => list.map((l) => <Row key={l.id + l.label} label={l.label} amount={l.amount} {...(l.rate !== undefined ? { rate: l.rate } : {})} {...(l.tax !== undefined ? { tax: l.tax } : {})} />);
  const poa = c.paymentsOnAccount;
  return (
    <Card title="How the tax is worked out" description="From the boxes above, in HMRC’s order: income rounded down to whole pounds box by box, each band’s tax to the penny." padded={false}>
      <div className="overflow-x-auto border-t border-line px-5 py-3">
        <table className="w-full text-[13px] text-ink-2">
          <thead className="text-[11.5px] text-ink-3">
            <tr>
              <th className="pb-1 text-left font-medium">Step</th>
              <th className="pb-1 text-right font-medium">Amount</th>
              <th className="hidden pb-1 text-right font-medium sm:table-cell">Rate</th>
              <th className="pb-1 text-right font-medium">Tax</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Total income" amount={c.totalIncome} strong />
            {c.bandExtension > 0 && <Row label="Less pension contributions and Gift Aid, grossed up: adjusted net income" amount={c.adjustedNetIncome} sub />}
            <Row label={`Personal allowance${c.personalAllowance < c.personalAllowanceStandard ? ' (reduced)' : ''}`} amount={-c.personalAllowance} sub />
            <Row label="Taxable income" amount={c.taxableIncome} strong />
            {c.bandExtension > 0 && <Row label={`Basic rate band widened by ${formatMoneyPlain(c.bandExtension)} to`} amount={c.basicRateLimit} sub />}
            {lines(c.lines)}
            <Row label="Income tax charged" tax={c.incomeTaxCharged} strong />
            {lines(c.reducers)}
            {c.reducers.length > 0 && <Row label="Income tax due" tax={c.incomeTaxDue} strong />}
            {c.hicbc > 0 && <Row label="High Income Child Benefit Charge" tax={c.hicbc} />}
            {lines(c.class4Lines)}
            {c.capitalGains && c.capitalGains.net > 0 && (
              <>
                <Row label="Capital gains less losses" amount={c.capitalGains.net} sub />
                <Row label="Less the annual exempt amount" amount={-Math.min(c.capitalGains.net - c.capitalGains.broughtForwardUsed, c.capitalGains.annualExemptAmount)} sub />
                {c.capitalGains.broughtForwardUsed > 0 && <Row label="Less losses brought forward" amount={-c.capitalGains.broughtForwardUsed} sub />}
                {lines(c.capitalGains.lines)}
                {!c.capitalGains.lines.length && <Row label="No capital gains tax: the gains are within the annual exempt amount" tax={0} sub />}
              </>
            )}
            {c.studentLoan && (
              <>
                {lines(c.studentLoan.lines)}
                {c.studentLoan.deducted > 0 && <Row label="Less student loan taken off your pay" tax={-c.studentLoan.deducted} sub />}
              </>
            )}
            <Row label="Total tax for the year" tax={c.totalLiability} strong />
            <Row label="Less tax taken off at source" tax={-c.deductedAtSource} sub />
            <Row label={c.balancing < 0 ? 'Overpaid: to be repaid' : 'Left to pay for the year'} tax={c.balancing} strong />
          </tbody>
        </table>
        <p className="mt-3 text-[12.5px] text-ink-3">
          {poa.relevantAmount === 0 && c.codedOut > 0 && r.owed.withoutCoding.poa.reason === 'due'
            ? `Payments on account: none if HMRC collects the balance through your tax code; otherwise ${formatMoneyPlain(r.owed.withoutCoding.poa.first)} and ${formatMoneyPlain(r.owed.withoutCoding.poa.second)}, half each of the income tax left after tax taken off (${formatMoneyPlain(r.owed.withoutCoding.poa.relevantAmount)}).`
            : r.owed.withoutCoding.poa.reason === 'due'
              ? `Payments on account for ${nextYear(r.taxYear.label)}: half each of the income tax${c.class4 ? ' and Class 4' : ''} left after tax taken off (${formatMoneyPlain(r.owed.withoutCoding.poa.relevantAmount)}), since it is £1,000 or more and at least 20% of the year’s.`
              : r.owed.withoutCoding.poa.reason === 'mostly-at-source'
                ? 'No payments on account: more than 80% of the income tax was taken off at source.'
                : 'No payments on account: the income tax left after tax taken off is under £1,000.'}{' '}
          Capital gains tax and student loan repayments never count towards them.
        </p>
      </div>
    </Card>
  );
}

function Checks({ r }: { r: TaxReturnView }) {
  if (!r.checks.length) return null;
  return (
    <Card title="Checks against the rest of Counting House">
      <ul className="flex flex-col gap-2 text-[13px]">
        {r.checks.map((k) => (
          <li key={k.label} className="flex gap-2">
            {k.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" />}
            <span>
              <span className="font-medium text-ink">{k.label}.</span> <span className="text-ink-3">{k.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TaxReturn({ r }: { r: TaxReturnView }) {
  return (
    <div className="flex flex-col gap-5">
      <Summary r={r} />
      <ToDo r={r} />
      <Questions r={r} />
      <div className="flex items-center gap-2 pt-1 text-[13px] text-ink-3">
        <CircleHelp className="size-4" />
        <span>Each box shows what to type online (pounds and pence); open a box for where its figure came from, the paper figure, and to set your own.</span>
      </div>
      {r.pages.map((p) => (
        <Page key={p.keyPrefix} p={p} taxYear={r.taxYear.label} />
      ))}
      <Working r={r} />
      <Checks r={r} />
    </div>
  );
}
