// A company's Filing tab (docs/FORMULAS.md §22, "Filing the accounts"): for one accounting period, its
// micro-entity accounts as it files them at Companies House, in the order and words of the micro-entity
// form, in whole pounds with the period before, each figure traced to the books; the notes, the
// statements above the director's signature, the rounding statement and the optional accounting
// policies; whether it qualifies; and what must be done before filing. You file by hand: once submitted,
// record it here (which locks the books), and, if you like, the book value of your shares. Everything
// from the company's own route (GET /api/companies/:id/filing); nothing is sent to Companies House.

import { Download, Printer } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { type QualificationRule } from '../../shared/accounts-filing';
import type { CompanyFilingResponse, EligibilityView, FilingSheetLine } from '../../shared/api';
import { formatDate, formatSpan, today } from '../../shared/dates';
import { fromMinor } from '../../shared/money';
import type { OwnerNote } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn } from '../lib/format';
import { CheckEverything } from './CheckEverything';
import { Badge, Button, Callout, Card, Checkbox, Dialog, ErrorNote, Field, Input, Loading, Money, NumberInput, Select, StatusBadge, Textarea, tableClasses, useToast } from './ui';

/** Whole pounds as money, no pence. */
const Pounds = ({ value }: { value: number }) => <Money value={value} decimals={0} className="sensitive tabular" />;
/** Pence as money. */
const Pence = ({ value }: { value: number }) => <Money value={fromMinor(value)} className="sensitive tabular" />;
const pounds = (n: number) => `£${n.toLocaleString('en-GB')}`;

// ─── What you confirm: a draft of the period's notes ─────────────────────────────────────────────────

interface NoteDraft {
  state: 'unset' | 'none' | 'text';
  text: string;
  amount: number | undefined;
}
interface Draft {
  employees: number | undefined;
  offBalanceSheet: NoteDraft;
  commitments: NoteDraft;
  directors: NoteDraft;
  interest: string;
  conditions: string;
  writtenOff: number | undefined;
  waived: number | undefined;
  notExcluded: boolean;
  previousQualified: boolean | undefined;
}
const noteDraft = (n: OwnerNote | null): NoteDraft => (n === null ? { state: 'unset', text: '', amount: undefined } : 'none' in n ? { state: 'none', text: '', amount: undefined } : { state: 'text', text: n.text, amount: n.amount });
const noteOf = (d: NoteDraft): OwnerNote | undefined => (d.state === 'none' ? { none: true } : d.state === 'text' && d.text.trim() ? { text: d.text.trim(), ...(d.amount !== undefined ? { amount: d.amount } : {}) } : undefined);
function draftOf(v: CompanyFilingResponse): Draft {
  const a = v.notes.advances.given;
  return {
    employees: v.notes.employees.average ?? undefined,
    offBalanceSheet: noteDraft(v.notes.offBalanceSheet),
    commitments: noteDraft(v.notes.commitments),
    directors: noteDraft(v.notes.directors),
    interest: a?.interest ?? '',
    conditions: a?.conditions ?? '',
    writtenOff: a?.writtenOff,
    waived: a?.waived,
    notExcluded: v.eligibility.notExcluded === true,
    previousQualified: v.eligibility.previousQualified ?? undefined,
  };
}
function bodyOf(periodEnd: string, d: Draft) {
  const notes = {
    ...(noteOf(d.offBalanceSheet) ? { offBalanceSheet: noteOf(d.offBalanceSheet) } : {}),
    ...(noteOf(d.commitments) ? { commitments: noteOf(d.commitments) } : {}),
    ...(noteOf(d.directors) ? { directors: noteOf(d.directors) } : {}),
    ...(d.interest.trim() && d.conditions.trim() ? { advances: { interest: d.interest.trim(), conditions: d.conditions.trim(), ...(d.writtenOff ? { writtenOff: d.writtenOff } : {}), ...(d.waived ? { waived: d.waived } : {}) } } : {}),
    ...(d.notExcluded ? { notExcluded: true } : {}),
    ...(d.previousQualified !== undefined ? { previousQualified: d.previousQualified } : {}),
  };
  return { periodEnd, employees: d.employees ?? null, notes: Object.keys(notes).length ? notes : null };
}

// ─── The sheet ──────────────────────────────────────────────────────────────────────────────────────

function SheetRows({ lines, withPrior, trace }: { lines: FilingSheetLine[]; withPrior: boolean; trace: boolean }) {
  return (
    <>
      {lines.map((l) => (
        <Fragment key={l.key}>
          <tr className={cn(l.total && 'bg-panel-2 font-medium', l.sub && 'text-[12.5px] text-ink-2')}>
            <td className={cn(tableClasses.td, l.sub && 'py-1 pl-7')}>
              {l.line && !l.sub ? <span className="text-ink-3">{l.line}. </span> : null}
              {l.label}
              {(l.working || l.note) && (
                <div className="text-[11.5px] font-normal text-ink-3">
                  {l.working ? `Worked out: ${l.working}.` : ''} {l.note}
                </div>
              )}
            </td>
            <td className={cn(tableClasses.td, tableClasses.num, l.sub && 'py-1')}>
              <Pounds value={l.whole} />
            </td>
            {withPrior && <td className={cn(tableClasses.td, tableClasses.num, l.sub && 'py-1')}>{l.prior === undefined ? <span className="text-ink-3">—</span> : <Pounds value={l.prior} />}</td>}
          </tr>
          {trace &&
            l.trace.map((c) => (
              <tr key={`${l.key}:${c.ledger}`} className="text-[12px] text-ink-3">
                <td className={cn(tableClasses.td, 'py-0.5 pl-10')}>{c.name}</td>
                <td className={cn(tableClasses.td, tableClasses.num, 'py-0.5')}>
                  <Pence value={c.amount} />
                </td>
                {withPrior && <td className={cn(tableClasses.td, 'py-0.5')} />}
              </tr>
            ))}
        </Fragment>
      ))}
    </>
  );
}

function noteText(n: OwnerNote | null): ReactNode {
  if (n === null) return <span className="text-warn-ink">Not confirmed yet.</span>;
  if ('none' in n) return 'None.';
  return (
    <>
      <span className="sensitive whitespace-pre-wrap">{n.text}</span>
      {n.amount !== undefined && (
        <>
          {' '}
          Total: <Money value={n.amount} className="sensitive tabular" />.
        </>
      )}
    </>
  );
}

function AdvancesText({ v }: { v: CompanyFilingResponse['notes']['advances'] }) {
  if (!v.any)
    return (
      <>
        None.{' '}
        <span className="text-ink-3">
          {!v.loan ? 'The books hold no director’s loan.' : v.lentToCompany ? 'The director’s loan was in credit throughout: the director lent to the company, which is not an advance or credit granted to a director (s413).' : 'The director owed the company nothing at any time in the period.'}
        </span>
      </>
    );
  const g = v.given;
  return (
    <>
      An advance to the director on the director’s loan account: owed <Pence value={v.opening} /> at the start, <Pence value={v.advanced} /> advanced and <Pence value={v.repaid} /> repaid in the period, owed <Pence value={v.closing} /> at the end (the most owed on any day, <Pence value={v.maximum} />).{' '}
      {g ? (
        <>
          Interest: <span className="sensitive">{g.interest}</span>. Main conditions: <span className="sensitive">{g.conditions}</span>. Written off: <Money value={g.writtenOff ?? 0} className="sensitive tabular" />; waived: <Money value={g.waived ?? 0} className="sensitive tabular" />.
        </>
      ) : (
        <span className="text-warn-ink">Give its interest rate and main conditions below.</span>
      )}
    </>
  );
}

function SheetCard({ v, companyId }: { v: CompanyFilingResponse; companyId: string }) {
  const [trace, setTrace] = useState(false);
  const withPrior = Boolean(v.comparative);
  const p = v.period;
  return (
    <Card
      title={`Micro-entity accounts for ${formatSpan(p.start, p.end)}`}
      description={
        <>
          {v.company.name}
          {v.company.number ? `, company ${v.company.number}` : ''}. Balance sheet at {formatDate(p.end)}, in the order and words of Companies House’s micro-entity form, in whole pounds. A breakdown of fixed and current assets is taken, not asked for.
        </>
      }
      padded={false}
      actions={
        <div className="no-print flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" aria-pressed={trace} onClick={() => setTrace((x) => !x)}>
            {trace ? 'Hide where each comes from' : 'Where each comes from'}
          </Button>
          <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => window.print()}>
            Print
          </Button>
          <a href={`/api/companies/${companyId}/filing?period=${p.end}&format=csv`}>
            <Button size="sm" icon={<Download className="size-3.5" />}>
              CSV
            </Button>
          </a>
          <a href={`/api/companies/${companyId}/filing?period=${p.end}&format=json`}>
            <Button size="sm" icon={<Download className="size-3.5" />}>
              JSON
            </Button>
          </a>
        </div>
      }
    >
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Balance sheet</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>{formatDate(p.end)}</th>
              {withPrior && <th className={cn(tableClasses.th, tableClasses.num)}>{formatDate(v.comparative!.end)}</th>}
            </tr>
          </thead>
          <tbody>
            <SheetRows lines={v.sheet} withPrior={withPrior} trace={trace} />
            <tr>
              <td className={cn(tableClasses.td, 'pt-4 font-medium')} colSpan={withPrior ? 3 : 2}>
                Capital and reserves
              </td>
            </tr>
            <SheetRows lines={v.capital} withPrior={withPrior} trace={trace} />
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4 text-[13px] text-ink-2">
        {v.comparative && <p className="text-[12px] text-ink-3">The period before ({formatSpan(v.comparative.start, v.comparative.end)}) is {v.comparative.sheet === 'filed' ? 'as filed: its fixed and current assets’ breakdown was not recorded, so give it as filed, or leave the breakdown out for both years' : 'as the books work it out'}. The form asks for it, as it does unless there is no period before.</p>}
        <p className="text-[12px] text-ink-3">{v.rounding} (FRS 105 para 3.13(d))</p>
        <div>
          <h3 className="font-medium text-ink">Notes (at the foot of the balance sheet)</h3>
          <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5">
            <li>
              <span className="font-medium">Average number of employees</span> during the period: {v.notes.employees.average === null ? <span className="text-warn-ink">not given yet.</span> : <span className="tabular">{v.notes.employees.average}</span>} <span className="text-ink-3">(CA 2006 s411)</span>
            </li>
            <li>
              <span className="font-medium">Advances and credits to directors, and guarantees on their behalf</span> <span className="text-ink-3">(s413)</span>: <AdvancesText v={v.notes.advances} /> Others: {noteText(v.notes.directors)}
            </li>
            <li>
              <span className="font-medium">Financial commitments, guarantees and contingencies</span> not in the balance sheet <span className="text-ink-3">(SI 2008/409 Sch 1 para 57)</span>: {noteText(v.notes.commitments)}
            </li>
            <li>
              <span className="font-medium">Arrangements not reflected in the balance sheet</span> <span className="text-ink-3">(s410A; FRS 105 para 6A.1)</span>: {noteText(v.notes.offBalanceSheet)}
            </li>
          </ol>
        </div>
        <div>
          <h3 className="font-medium text-ink">Statements, above the director’s signature</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {v.statements.map((s) => (
              <li key={s.key}>
                {s.text} <span className="text-[12px] text-ink-3">({s.source})</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">{v.approval.line}</p>
          <p className="mt-1 text-[12px] text-ink-3">
            The form asks you to accept the four statements, and for the day the board approved the accounts (on or after {formatDate(p.end)}, not in the future) and the director who signed them. A micro-entity need not also say its profit and loss account is not filed (CA 2006 s444(5C)).
            {v.channel.enhancedAuditStatement && ' From 1 April 2028 a company claiming audit exemption gives a strengthened statement naming the exemption and confirming it qualifies: check the words your software gives.'}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ─── What must be done, and whether it qualifies ─────────────────────────────────────────────────────

function GateCard({ v }: { v: CompanyFilingResponse }) {
  return (
    <Card title={v.filing ? `Filed ${formatDate(v.filing.filedOn)}` : v.ready ? 'Ready to file' : 'Before you file'} description={v.filing ? 'Recorded as filed: the books are locked through the period’s end.' : 'Each must be done before the accounts are filed and recorded here.'}>
      <ul className="flex flex-col gap-2 text-[13px]">
        {v.gate.map((g) => (
          <li key={g.key} className="flex items-start gap-2">
            <span className="shrink-0">{g.ok ? <StatusBadge status="good">Done</StatusBadge> : <StatusBadge status="warn">To do</StatusBadge>}</span>
            <span className="min-w-0">
              <span className="font-medium text-ink">{g.label}</span> <span className="text-ink-3">{g.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const RULE_WORDS: Record<QualificationRule, string> = {
  'first-year': 'its first financial year: as it meets the conditions in it (s384A(1), s382(1))',
  'two-years': 'it met (or did not meet) the conditions in this year and the last: two consecutive years decide it (s384A(3), s382(2))',
  'one-year-only': 'this year differs from the last, and one year alone changes nothing: as it qualified for the year before (s384A(3), s382(2))',
  told: 'as you say it qualified for the year before, this year’s change not yet in two consecutive years (s384A(3))',
  unknown: 'it cannot be told from what is known: see each year',
};

function SizeTable({ e }: { e: EligibilityView }) {
  const req = (r: EligibilityView['years'][number]['turnover'], money: 'pence' | 'pounds' | 'count') =>
    r.value === undefined ? (
      <span className="text-ink-3">not known</span>
    ) : (
      <span className={cn(r.within ? 'text-ink' : 'text-bad-ink')}>
        {money === 'pence' ? <Pence value={r.value} /> : money === 'pounds' ? <Pounds value={r.value} /> : r.value}
        {r.within ? '' : ' (over)'}
      </span>
    );
  return (
    <div className="relative overflow-x-auto">
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th className={tableClasses.th}>Year</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Turnover</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Balance sheet total</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Employees</th>
            <th className={tableClasses.th}>Conditions</th>
          </tr>
        </thead>
        <tbody>
          {e.years
            .slice(-4)
            .reverse()
            .map((y) => (
              <tr key={y.end}>
                <td className={cn(tableClasses.td, 'whitespace-nowrap')}>to {formatDate(y.end)}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  {req(y.turnover, 'pence')}
                  <div className="text-[11px] text-ink-3">
                    limit <Pence value={y.turnover.limit} />
                  </div>
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{req(y.assets, 'pounds')}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{req(y.employees, 'count')}</td>
                <td className={tableClasses.td}>{y.meets === undefined ? <Badge tone="neutral">Not known</Badge> : y.meets ? <StatusBadge status="good">Met</StatusBadge> : <StatusBadge status="bad">Not met</StatusBadge>}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function EligibilityCard({ v, draft, set, dirty, save }: { v: CompanyFilingResponse; draft: Draft; set: (d: Partial<Draft>) => void; dirty: boolean; save: Saver }) {
  const e = v.eligibility;
  const verdict = (x: EligibilityView) => (x.qualifies === undefined ? <Badge tone="neutral">Cannot tell yet</Badge> : x.qualifies ? <StatusBadge status="good">Qualifies</StatusBadge> : <StatusBadge status="bad">Does not qualify</StatusBadge>);
  return (
    <Card
      title="Does it qualify as a micro-entity?"
      actions={
        <Button size="sm" variant="primary" disabled={!dirty} loading={save.pending} onClick={save.run}>
          Save
        </Button>
      }
      description={`By its size: two or more of turnover (pro-rated for a period other than a year), balance sheet total (its assets, A to D) and average employees within the limits, ${pounds(e.micro.limits.turnover)}, ${pounds(e.micro.limits.balanceSheet)} and ${e.micro.limits.employees}, for financial years beginning from ${formatDate(e.from)} (CA 2006 s384A(4); the years before judged by the same limits, SI 2024/1303 reg 3).`}
    >
      <div className="flex flex-col gap-4 text-[13px] text-ink-2">
        {save.error && <p className="text-bad-ink">{save.error}</p>}
        {!e.covered && <Callout tone="warn">Financial years beginning before 1 January 2016 are not covered: decide it yourself.</Callout>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">Micro-entity:</span> {verdict(e.micro)} <span className="text-ink-3">{RULE_WORDS[e.micro.rule]}</span>
        </div>
        <SizeTable e={e.micro} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">Small company</span> (the small companies regime and audit exemption, s382 and s477; limits {pounds(e.small.limits.turnover)}, {pounds(e.small.limits.balanceSheet)}, {e.small.limits.employees}): {verdict(e.small)}
        </div>
        {e.askPrevious && (
          <Field label="Did it qualify as a micro-entity for the period before?" hint="The books cannot settle it: its figures before them are not known. Its accounts for that period say, if they were prepared as micro-entity accounts and its size did not change.">
            <Select value={draft.previousQualified === undefined ? '' : draft.previousQualified ? 'yes' : 'no'} onChange={(ev) => set({ previousQualified: ev.target.value === '' ? undefined : ev.target.value === 'yes' })} className="w-56">
              <option value="">Not said</option>
              <option value="yes">Yes, it qualified</option>
              <option value="no">No, it did not</option>
            </Select>
          </Field>
        )}
        <div>
          <p className="font-medium text-ink">None of these may apply at any time in the period:</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
            {e.exclusions.map((x) => (
              <li key={x.key}>
                {x.text} <span className="text-[12px] text-ink-3">({x.source})</span>
              </li>
            ))}
          </ul>
          <Checkbox className="mt-2" checked={draft.notExcluded} onChange={(c) => set({ notExcluded: c })} label="I confirm none of these applied to the company at any time in the period" />
        </div>
      </div>
    </Card>
  );
}

// ─── What you confirm ───────────────────────────────────────────────────────────────────────────────

function NoteEditor({ label, hint, value, onChange, amountLabel }: { label: string; hint: ReactNode; value: NoteDraft; onChange: (d: NoteDraft) => void; amountLabel?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <Select value={value.state} onChange={(e) => onChange({ ...value, state: e.target.value as NoteDraft['state'] })} className="w-64 max-w-full">
          <option value="unset">Not confirmed</option>
          <option value="none">None</option>
          <option value="text">There are: describe them</option>
        </Select>
      </Field>
      {value.state === 'text' && (
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
          <Textarea aria-label={`${label}: what they are`} className="sensitive" rows={3} maxLength={2000} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
          {amountLabel && (
            <Field label={amountLabel}>
              <NumberInput value={value.amount} onValue={(a) => onChange({ ...value, amount: a === undefined ? undefined : Math.max(0, a) })} className="sensitive tabular" />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

/** Saving what you confirmed: one draft for the period, whichever card it is saved from. */
interface Saver {
  run: () => void;
  pending: boolean;
  error: string | undefined;
}

function ConfirmCard({ v, draft, set, dirty, save }: { v: CompanyFilingResponse; draft: Draft; set: (d: Partial<Draft>) => void; dirty: boolean; save: Saver }) {
  const hint = v.notes.employees.hint;
  const a = v.notes.advances;
  return (
    <Card
      title="What you confirm"
      description="The notes a micro-entity gives that the books cannot work out, and its average number of employees. Kept with the company’s books, for this period."
      actions={
        <Button size="sm" variant="primary" disabled={!dirty} loading={save.pending} onClick={save.run}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-5 text-[13px]">
        {save.error && <p className="text-bad-ink">{save.error}</p>}
        <div className="flex flex-col gap-2">
          <Field
            label="Average number of employees in the period"
            hint="For each month of the period, count the people employed under contracts of service in it (for any part of it): a director counts only with a contract of service. Add the months together and divide by the number of months (CA 2006 s411(3)–(4), s384A(7)). Never worked out for you."
          >
            <NumberInput value={draft.employees} onValue={(n) => set({ employees: n === undefined ? undefined : Math.max(0, Math.round(n * 100) / 100) })} className="w-32 tabular" aria-label="Average number of employees" />
          </Field>
          {hint && (
            <p className="text-[12px] text-ink-3">
              From the books, a hint only: {hint.paye ? 'it ran a PAYE scheme in the period, and ' : ''}staff costs (<Pence value={hint.staffCosts} />) fall in {hint.payrollMonths} of its {hint.months} months. One person employed in those months alone would average {hint.onePerson}; count each person, and only those with a contract of service.
            </p>
          )}
        </div>
        {a.any && (
          <div className="flex flex-col gap-2">
            <p className="font-medium text-ink-2">The advance to the director the books show (s413(3))</p>
            <p className="text-[12px] text-ink-3">
              Its amount and what was repaid come from the director’s loan; give its interest rate and main conditions (repayable when, secured or not), and any amounts written off or waived.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Interest rate">
                <Input className="sensitive" maxLength={200} value={draft.interest} placeholder="none, or the rate charged" onChange={(e) => set({ interest: e.target.value })} />
              </Field>
              <Field label="Main conditions">
                <Input className="sensitive" maxLength={500} value={draft.conditions} placeholder="unsecured, repayable on demand" onChange={(e) => set({ conditions: e.target.value })} />
              </Field>
              <Field label="Written off in the period">
                <NumberInput value={draft.writtenOff} onValue={(n) => set({ writtenOff: n === undefined ? undefined : Math.max(0, n) })} className="sensitive tabular" />
              </Field>
              <Field label="Waived in the period">
                <NumberInput value={draft.waived} onValue={(n) => set({ waived: n === undefined ? undefined : Math.max(0, n) })} className="sensitive tabular" />
              </Field>
            </div>
          </div>
        )}
        <NoteEditor
          label="Other advances, credits and guarantees for directors"
          hint="Not in these books: another director’s loan, a credit given to a director, a guarantee of a director’s borrowing (s413). For a guarantee: its main terms, the most the company could have to pay, and anything it paid."
          value={draft.directors}
          onChange={(d) => set({ directors: d })}
          amountLabel="Total (£)"
        />
        <NoteEditor
          label="Financial commitments, guarantees and contingencies not in the balance sheet"
          hint="What the company is committed to pay or may have to (a lease, a guarantee of another’s debt, a claim against it), with any security given, pensions and group commitments said apart (SI 2008/409 Sch 1 para 57)."
          value={draft.commitments}
          onChange={(d) => set({ commitments: d })}
          amountLabel="Total (£)"
        />
        <NoteEditor label="Arrangements not reflected in the balance sheet" hint="Their nature and business purpose, where their risks or benefits are material (CA 2006 s410A; FRS 105 para 6A.1)." value={draft.offBalanceSheet} onChange={(d) => set({ offBalanceSheet: d })} />
      </div>
    </Card>
  );
}

function PoliciesCard({ v }: { v: CompanyFilingResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title="Accounting policies (optional)"
      description="From the books. Not required for micro-entity accounts (FRS 105 para 6.1; the form’s help says so too); more than the minimum is given with regard to FRS 102 Section 1A (FRS 105 para 1.3)."
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          {open ? 'Hide them' : 'Show them'}
        </Button>
      }
    >
      {open && (
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-ink-2">
          {v.policies.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function RecordDialog({ v, companyId, onClose }: { v: CompanyFilingResponse; companyId: string; onClose: () => void }) {
  const toast = useToast();
  const [filedOn, setFiledOn] = useState(today());
  const [approvedOn, setApprovedOn] = useState(today());
  const [approvedBy, setApprovedBy] = useState('');
  const [reference, setReference] = useState('');
  const save = useApiMutation(() => api(`/companies/${companyId}/accounts/filed`, { method: 'POST', body: { periodEnd: v.period.end, filedOn, approvedOn, approvedBy: approvedBy.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}), lines: v.lines } }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Recorded as filed: the books are locked through the period’s end' });
      onClose();
    },
  });
  const wrong = approvedOn < v.period.end ? 'The accounts are approved on or after the balance sheet date.' : approvedOn > filedOn ? 'They are approved before they are filed.' : filedOn > today() ? 'The day filed is in the future.' : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record the accounts as filed"
      description="Only once you have submitted them at Companies House. Lines A to K are recorded as this sheet gives them, and the books are locked through the period’s end, so nothing filed moves."
      footer={
        <>
          {(save.error || wrong) && <span className="mr-auto self-center text-[12px] text-bad-ink">{save.error?.message ?? wrong}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={Boolean(wrong) || !approvedBy.trim()} onClick={() => save.mutate(undefined)}>
            I have submitted them: record it
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Approved by the board on">
          <Input type="date" value={approvedOn} min={v.period.end} max={today()} onChange={(e) => setApprovedOn(e.target.value)} />
        </Field>
        <Field label="Signed by (the director, as filed)" hint="Kept with this filing only.">
          <Input className="sensitive" maxLength={120} value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} />
        </Field>
        <Field label="Filed on">
          <Input type="date" value={filedOn} max={today()} onChange={(e) => setFiledOn(e.target.value)} />
        </Field>
        <Field label="Submission reference (optional)">
          <Input className="sensitive" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function BookValueCard({ v, companyId }: { v: CompanyFilingResponse; companyId: string }) {
  const toast = useToast();
  const b = v.bookValue;
  const record = useApiMutation(() => api(`/companies/${companyId}/accounts/book-value`, { method: 'POST', body: { periodEnd: v.period.end } }), {
    onSuccess: () => toast({ tone: 'good', text: 'Book value recorded on your shares’ account' }),
    onError: (e) => toast({ tone: 'bad', text: e.message }),
  });
  return (
    <Card title="Your shares at book value" description="Yours, not the company’s: its net assets (K) at the period’s end as your share of its shares, recorded as a valuation of your shares only when you choose to (FORMULAS.md §9). Never below nothing.">
      <div className="flex flex-col gap-2 text-[13px] text-ink-2">
        {b.recorded ? (
          <p>
            Recorded: <Money value={b.recorded.value} className="sensitive tabular" /> at {formatDate(b.asOf)}.
          </p>
        ) : b.why ? (
          <p className="text-ink-3">{b.why}</p>
        ) : (
          <>
            <p>
              {b.netAssets > 0 ? (
                <>
                  Net assets <Pounds value={b.netAssets} /> × {b.shares} of its {b.totalShares} shares = <Money value={b.value ?? 0} className="sensitive tabular font-medium" />.
                </>
              ) : (
                <>
                  Its {b.netAssets < 0 ? 'net liabilities' : 'net assets'} of <Pounds value={Math.abs(b.netAssets)} />: your shares are worth <Money value={0} className="tabular" /> on its books, never less.
                </>
              )}
            </p>
            <div>
              <Button size="sm" loading={record.isPending} onClick={() => record.mutate(undefined)}>
                Record it as your shares’ value at {formatDate(b.asOf)}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function FiledCard({ v }: { v: CompanyFilingResponse }) {
  const f = v.filing!;
  return (
    <Callout tone={f.matches ? 'good' : 'warn'} title={`Filed ${formatDate(f.filedOn)}${f.reference ? `, ${f.reference}` : ''}`}>
      {f.approvedOn && (
        <>
          Approved {formatDate(f.approvedOn)}
          {f.approvedBy ? (
            <>
              {' '}
              by <span className="sensitive">{f.approvedBy}</span>
            </>
          ) : null}
          .{' '}
        </>
      )}
      {f.lines.length === 0 ? 'The filing recorded gives no lines to compare.' : f.matches ? 'Every line filed is what the books work out to.' : `The books have moved since: ${f.lines.filter((l) => l.filed !== l.computed).map((l) => `${l.line} filed £${l.filed}, now £${l.computed}`).join('; ')}.`}
    </Callout>
  );
}

/** The Filing tab: a period's micro-entity accounts as the company files them. */
export function FilingTab({ companyId }: { companyId: string }) {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const q = useApi<CompanyFilingResponse>(['company-filing', companyId, period ?? 'latest'], `/companies/${companyId}/filing${period ? `?period=${period}` : ''}`);
  const view = q.data;
  const key = view ? `${view.company.id}:${view.period.end}:${JSON.stringify([view.notes, view.eligibility.notExcluded, view.eligibility.previousQualified])}` : '';
  if (q.error) return <ErrorNote error={q.error} />;
  if (!view || view.company.id !== companyId) return <Loading />;
  return <FilingView key={key} v={view} companyId={companyId} onPeriod={setPeriod} />;
}

function FilingView({ v, companyId, onPeriod }: { v: CompanyFilingResponse; companyId: string; onPeriod: (p: string) => void }) {
  const toast = useToast();
  const initial = draftOf(v);
  const [draft, setDraft] = useState<Draft>(initial);
  const [recording, setRecording] = useState(false);
  const set = (d: Partial<Draft>) => setDraft((x) => ({ ...x, ...d }));
  const dirty = JSON.stringify(bodyOf(v.period.end, draft)) !== JSON.stringify(bodyOf(v.period.end, initial));
  const save = useApiMutation(() => api(`/companies/${companyId}/accounts-notes`, { method: 'PUT', body: bodyOf(v.period.end, draft) }), { onSuccess: () => toast({ tone: 'good', text: 'Saved' }) });
  const saver = { run: () => save.mutate(undefined), pending: save.isPending, error: save.error?.message };
  return (
    <div className="flex flex-col gap-5">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Field label="Accounting period">
          <Select value={v.period.end} onChange={(e) => onPeriod(e.target.value)} aria-label="Accounting period" className="w-72 max-w-full">
            {v.periods.map((p) => (
              <option key={p.end} value={p.end}>
                {formatSpan(p.start, p.end)}
                {p.ended ? '' : ' (running)'}
                {p.filed ? ' · filed' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-2 pb-2">
          {v.filing ? <Badge tone="muted">Filed {formatDate(v.filing.filedOn)}</Badge> : v.ready ? <StatusBadge status="good">Ready to file</StatusBadge> : <StatusBadge status="warn">Not ready</StatusBadge>}
          {!v.filing && (
            <Button size="sm" variant="primary" disabled={!v.ready || dirty} onClick={() => setRecording(true)}>
              Record as filed
            </Button>
          )}
        </div>
      </div>
      <Callout tone={v.channel.webFiling ? 'neutral' : 'warn'} className="no-print">
        {v.channel.webFiling
          ? `You file these by hand on Companies House WebFiling (its micro-entity accounts form), or through commercial software: nothing is sent from here. From ${formatDate(v.channel.softwareOnlyFrom)} accounts can be filed only through commercial software, in iXBRL; WebFiling and paper close for accounts then.`
          : `Since ${formatDate(v.channel.softwareOnlyFrom)} accounts are filed only through commercial software, in iXBRL: enter these figures there. Nothing is sent from here.`}
      </Callout>
      {v.filing && <FiledCard v={v} />}
      <section className="no-print flex flex-col gap-5">
        <GateCard v={v} />
        <EligibilityCard v={v} draft={draft} set={set} dirty={dirty} save={saver} />
      </section>
      <div className="no-print">
        <ConfirmCard v={v} draft={draft} set={set} dirty={dirty} save={saver} />
      </div>
      <SheetCard v={v} companyId={companyId} />
      <div className="no-print flex flex-col gap-5">
        <PoliciesCard v={v} />
        <BookValueCard v={v} companyId={companyId} />
      </div>
      <CheckEverything text={v.disclaimer} />
      {recording && <RecordDialog v={v} companyId={companyId} onClose={() => setRecording(false)} />}
    </div>
  );
}
