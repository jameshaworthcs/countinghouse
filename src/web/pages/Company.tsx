// A company you keep the books of (companies.json, `books`): its deadlines, its cash and your
// director's loan with it, and its records. All of it from the company's own routes
// (routes/company-books.ts), never a personal one; nothing here counts in a figure of yours.

import { ArrowRight, Building2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { CompanyAccountsGroup, CompanyBooksListItem, CompanyBooksResponse } from '../../shared/api';
import { FILING_KIND_LABELS, VAT_STAGGER_LABELS, formatMonthDay, type CompanyDeadline } from '../../shared/company-books';
import { formatDate, formatSpan, today } from '../../shared/dates';
import { DEADLINE_WARN_DAYS } from '../../shared/deadlines';
import { toMinor, fromMinor } from '../../shared/money';
import { COMPANY_FILING_KINDS, MICRO_ENTITY_LINES, type CompanyBooks, type CompanyBooksSetup, type CompanyFiling, type CompanyFilingInput, type CompanyFilingKind, type VatBoxes } from '../../shared/schema';
import { VAT_STAGGERS, type VatStagger } from '../../shared/uk';
import { Badge, Button, Callout, Card, Checkbox, Dialog, EmptyState, ErrorNote, Field, Input, Loading, Money, NumberInput, PageHeader, Select, StatusBadge, Tabs, tableClasses, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { KeepBooks } from '../components/KeepBooks';
import { cn } from '../lib/format';

type Tab = 'overview' | 'settings';

/** A deadline's state, as a badge: done (filed late marked), overdue, due within 14 days, due soon, later. */
function DeadlineBadge({ d }: { d: CompanyDeadline }) {
  if (d.status === 'done')
    return (
      <span className="flex flex-wrap gap-1">
        <StatusBadge status="good">{d.nothingToPay ? 'Nothing to pay' : 'Done'}</StatusBadge>
        {d.filedLate && <Badge tone="warn">Filed late</Badge>}
      </span>
    );
  if (d.status === 'overdue') return <StatusBadge status="bad">Overdue</StatusBadge>;
  if (d.status === 'due-soon') return <StatusBadge status={d.days <= DEADLINE_WARN_DAYS ? 'warn' : 'info'}>{d.days === 0 ? 'Due today' : `Due in ${d.days} day${d.days === 1 ? '' : 's'}`}</StatusBadge>;
  return <Badge tone="neutral">Upcoming</Badge>;
}

/** Its period has ended, so a filing for it can be recorded. */
const recordable = (d: CompanyDeadline) => d.status !== 'done' && d.period.end < today();

function DeadlineRows({ list, onRecord }: { list: CompanyDeadline[]; onRecord?: (d: CompanyDeadline) => void }) {
  return (
    <>
      {list.map((d) => (
        <tr key={d.id}>
          <td className={cn(tableClasses.td, 'align-top whitespace-nowrap tabular sm:align-middle')}>{formatDate(d.due)}</td>
          <td className={tableClasses.td}>
            <div className={d.status === 'done' ? 'text-ink-2' : 'font-medium text-ink'}>{d.title}</div>
            <div className="text-[12px] text-ink-3">
              {d.to} · {d.rule}
              {d.filing && ` · filed ${formatDate(d.filing.filedOn)}${d.filing.reference ? `, ${d.filing.reference}` : ''}`}
            </div>
            {/* On a phone its state and button sit under it. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
              <DeadlineBadge d={d} />
              {onRecord && recordable(d) && (
                <Button size="sm" onClick={() => onRecord(d)}>
                  Record it
                </Button>
              )}
            </div>
          </td>
          <td className={cn(tableClasses.td, 'hidden sm:table-cell')}>
            <DeadlineBadge d={d} />
          </td>
          <td className={cn(tableClasses.td, 'hidden text-right sm:table-cell')}>
            {onRecord && recordable(d) && (
              <Button size="sm" onClick={() => onRecord(d)}>
                Record it
              </Button>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

/** Done deadlines shown before you ask for all of them. */
const DONE_SHOWN = 8;

/** Its deadlines: those still to do first, by due day; then those done, newest first. */
function DeadlinesCard({ view, onRecord }: { view: CompanyBooksResponse; onRecord: (d: CompanyDeadline) => void }) {
  const open = view.deadlines.filter((d) => d.status !== 'done');
  const done = view.deadlines.filter((d) => d.status === 'done').reverse();
  // The latest done ones; the rest on asking.
  const [allDone, setAllDone] = useState(false);
  const shownDone = allDone ? done : done.slice(0, DONE_SHOWN);
  return (
    <Card
      title="Deadlines"
      description="Worked out from its dates and the rules in force (each one’s rule is given). Not worked out: Corporation Tax instalments (large companies), a later date HMRC’s notice gives, a period shortened by notice (3 months from it), extensions, and PAYE."
      padded={false}
    >
      {view.deadlines.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No deadlines">Its periods begin after today.</EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Due</th>
                <th className={tableClasses.th}>What</th>
                <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>State</th>
                <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>
                  <span className="sr-only">Record</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <DeadlineRows list={open} onRecord={onRecord} />
              {done.length > 0 && (
                <tr>
                  <td colSpan={4} className="bg-panel-2 px-3 py-1.5 text-[12px] font-medium text-ink-3">
                    Done
                  </td>
                </tr>
              )}
              <DeadlineRows list={shownDone} />
            </tbody>
          </table>
          {done.length > DONE_SHOWN && (
            <div className="px-3 py-2">
              <Button size="sm" variant="ghost" onClick={() => setAllDone((v) => !v)}>
                {allDone ? 'Show the latest only' : `Show all ${done.length} done`}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** What needs doing: overdue first, then due within 60 days. */
function TodoCard({ view, onRecord }: { view: CompanyBooksResponse; onRecord: (d: CompanyDeadline) => void }) {
  const todo = view.deadlines.filter((d) => d.status === 'overdue' || d.status === 'due-soon');
  return (
    <Card title="What needs doing" description="Overdue, or due within 60 days. Check each date with Companies House or HMRC.">
      {todo.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing is due in the next 60 days.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-[13px]">
          {todo.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <DeadlineBadge d={d} />
              <span className="min-w-0 flex-1 text-ink">
                {d.title}, by {formatDate(d.due)}
              </span>
              {recordable(d) && (
                <Button size="sm" onClick={() => onRecord(d)}>
                  Record it
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.problems.length > 0 && (
        <Callout tone="warn" className="mt-3" title="Its records need a look">
          <ul className="list-disc pl-4">
            {view.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
    </Card>
  );
}

/** The company's own accounts (never yours), and your director's loan with it. */
function MoneyCard({ view }: { view: CompanyBooksResponse }) {
  const groups = useApi<CompanyAccountsGroup[]>(['company-accounts'], '/company-accounts');
  const group = groups.data?.find((g) => g.company.id === view.company.id);
  const total = group ? fromMinor(group.accounts.reduce((n, a) => n + toMinor(a.balanceGBP ?? 0), 0)) : null;
  const loan = view.directorLoan;
  return (
    <Card title="Its cash" description="Its own accounts, at their latest balances: the company’s money, in none of your figures.">
      {!groups.data ? (
        <Loading />
      ) : !group?.accounts.length ? (
        <p className="text-[13px] text-ink-3">
          None of its accounts is kept here. Add one on the{' '}
          <Link to="/accounts" className="text-accent hover:underline">
            Accounts page
          </Link>
          , saying it is the company’s.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {group.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <Link to={`/accounts/${a.id}`} className="text-ink hover:underline">
                {a.name}
                {a.asOf && <span className="text-ink-3"> · {formatDate(a.asOf)}</span>}
              </Link>
              <Money value={a.balanceGBP} className="tabular" />
            </li>
          ))}
          {group.accounts.length > 1 && (
            <li className="flex justify-between border-t border-line pt-1.5 font-medium">
              <span>Together</span>
              <Money value={total} className="tabular" />
            </li>
          )}
        </ul>
      )}
      <div className="mt-4 border-t border-line pt-3 text-[13px]">
        {loan ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Link to={`/accounts/${loan.accountId}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              Your director’s loan <ArrowRight className="size-3.5" />
            </Link>
            <span className="text-ink-2">
              {loan.balance === null ? 'no balance yet' : <Money value={loan.balance} className="tabular" />}
              <span className="text-ink-3"> {loan.balance !== null && loan.balance < 0 ? '(you owe it)' : '(it owes you)'}</span>
            </span>
          </div>
        ) : (
          <span className="text-ink-3">No director’s loan account is linked: add one from the company’s card on its shares account.</span>
        )}
      </div>
    </Card>
  );
}

// ─── Settings: the books ─────────────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Period rows you can add and take away. */
function PeriodsField({ label, hint, value, onChange }: { label: string; hint: ReactNode; value: { start: string; end: string }[]; onChange: (v: { start: string; end: string }[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {value.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label={`${label}: first day`} value={p.start} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className="w-40" />
          <span className="text-ink-3">to</span>
          <Input type="date" aria-label={`${label}: last day`} value={p.end} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} className="w-40" />
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label="Take it away" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { start: '', end: '' }])}>
          Add a period
        </Button>
      </div>
      <span className="text-[12px] text-ink-3">{hint}</span>
    </div>
  );
}

type Draft = Omit<CompanyBooksSetup, 'tradeStartedOn'> & { trade: 'incorporation' | 'not-yet' | 'on'; tradeOn: string; hasVat: boolean; hasPaye: boolean };

function draftOf(books: CompanyBooks | null): Draft {
  const vat = books?.vat ?? { registeredFrom: '', scheme: 'cash' as const, schedule: [{ from: '', stagger: 'quarterly-1' }] };
  return {
    incorporatedOn: books?.incorporatedOn ?? '',
    ...(books?.accountingReferenceDate ? { accountingReferenceDate: books.accountingReferenceDate } : {}),
    periods: books?.periods ?? [],
    ctPeriods: books?.ctPeriods ?? [],
    vat,
    paye: books?.paye ?? { from: '' },
    ...(books?.confirmationStatement ? { confirmationStatement: books.confirmationStatement } : {}),
    ...(books?.deadlinesFrom ? { deadlinesFrom: books.deadlinesFrom } : {}),
    trade: books?.tradeStartedOn === null ? 'not-yet' : books?.tradeStartedOn ? 'on' : 'incorporation',
    tradeOn: books?.tradeStartedOn ?? '',
    hasVat: Boolean(books?.vat),
    hasPaye: Boolean(books?.paye),
  };
}

/** The books as the API takes them, from the form. */
function setupOf(d: Draft): CompanyBooksSetup {
  const vat = d.vat!;
  return {
    incorporatedOn: d.incorporatedOn,
    ...(d.accountingReferenceDate ? { accountingReferenceDate: d.accountingReferenceDate } : {}),
    periods: d.periods,
    ctPeriods: d.ctPeriods,
    ...(d.hasVat ? { vat: { registeredFrom: vat.registeredFrom, scheme: 'cash' as const, schedule: vat.schedule, ...(vat.firstPeriodEnd ? { firstPeriodEnd: vat.firstPeriodEnd } : {}), ...(vat.deregisteredOn ? { deregisteredOn: vat.deregisteredOn } : {}) } } : {}),
    ...(d.hasPaye && d.paye ? { paye: { from: d.paye.from, ...(d.paye.closedOn ? { closedOn: d.paye.closedOn } : {}) } } : {}),
    ...(d.confirmationStatement?.nextMadeUpTo ? { confirmationStatement: d.confirmationStatement } : {}),
    ...(d.deadlinesFrom ? { deadlinesFrom: d.deadlinesFrom } : {}),
    ...(d.trade === 'not-yet' ? { tradeStartedOn: null } : d.trade === 'on' && d.tradeOn ? { tradeStartedOn: d.tradeOn } : {}),
  };
}

function BooksForm({ view, onSaved }: { view: CompanyBooksResponse; onSaved?: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(view.books));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const vat = d.vat!;
  const setVat = (patch: Partial<NonNullable<Draft['vat']>>) => set({ vat: { ...vat, ...patch } });
  const save = useApiMutation(() => api<{ updatedAt: string }>(`/companies/${view.company.id}/books`, { method: 'PUT', body: { books: setupOf(d), was: view.books?.updatedAt ?? null } }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Saved' });
      onSaved?.();
    },
  });
  const ard = d.accountingReferenceDate;
  const [ardMonth = 0, ardDay = 0] = ard ? ard.split('-').map(Number) : [];
  const defaultArd = view.accountingReferenceDate?.isDefault ? formatMonthDay(view.accountingReferenceDate.value) : 'the last day of the month of its anniversary';
  const nextConfirmation = view.deadlines.find((x) => x.kind === 'confirmation' && x.status !== 'done');
  return (
    <Card title="Its records" description="Its dates and registrations, as its certificates and Companies House show them. The deadlines are worked out from these.">
      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Incorporated on">
            <Input type="date" value={d.incorporatedOn} max={today()} onChange={(e) => set({ incorporatedOn: e.target.value })} required />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-ink-2">Accounting reference date</span>
            <div className="flex gap-2">
              <Select
                aria-label="Accounting reference date: month"
                value={ardMonth ? String(ardMonth) : ''}
                onChange={(e) => {
                  const m = Number(e.target.value);
                  set({ accountingReferenceDate: m ? `${String(m).padStart(2, '0')}-${String(DAYS_IN[m - 1] === 29 ? 28 : DAYS_IN[m - 1]).padStart(2, '0')}` : undefined });
                }}
                className="w-40"
              >
                <option value="">The default</option>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
              {ardMonth > 0 && (
                <Select aria-label="Accounting reference date: day" value={String(ardDay)} onChange={(e) => set({ accountingReferenceDate: `${String(ardMonth).padStart(2, '0')}-${e.target.value.padStart(2, '0')}` })} className="w-24">
                  {Array.from({ length: ardMonth === 2 ? 28 : DAYS_IN[ardMonth - 1]! }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {ardMonth === 2 && n === 28 ? 'last' : n}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <span className="text-[12px] text-ink-3">{ard ? `The day each period ends: ${formatMonthDay(ard)}.` : `The default is ${defaultArd} (CA 2006 s391(4)).`} A later change is a period below.</span>
          </div>
        </div>
        <PeriodsField label="Accounting periods that differ" hint="A period shortened or extended by notice (CA 2006 s392), never over 18 months. The next ones follow on from its end." value={d.periods} onChange={(periods) => set({ periods })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trade started" hint="It starts its first Corporation Tax period. Not yet: no Corporation Tax deadlines are worked out.">
            <Select value={d.trade} onChange={(e) => set({ trade: e.target.value as Draft['trade'] })}>
              <option value="incorporation">From incorporation</option>
              <option value="on">On a day</option>
              <option value="not-yet">Not yet</option>
            </Select>
          </Field>
          {d.trade === 'on' && (
            <Field label="Trade started on">
              <Input type="date" value={d.tradeOn} onChange={(e) => set({ tradeOn: e.target.value })} />
            </Field>
          )}
        </div>
        <PeriodsField label="Corporation Tax periods that differ" hint="As HMRC’s notice sets them, each 12 months at most (CTA 2009 s10)." value={d.ctPeriods} onChange={(ctPeriods) => set({ ctPeriods })} />

        <div className="grid gap-3 border-t border-line pt-4">
          <Checkbox checked={d.hasVat} onChange={(v) => set({ hasVat: v })} label="Registered for VAT" />
          {d.hasVat && (
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Registered from">
                  <Input
                    type="date"
                    value={vat.registeredFrom}
                    onChange={(e) => {
                      const from = e.target.value;
                      // The first schedule applies from registration.
                      setVat({ registeredFrom: from, schedule: vat.schedule.map((s, i) => (i === 0 ? { ...s, from } : s)) });
                    }}
                  />
                </Field>
                <Field label="First period ends" hint="Only when HMRC set one other than its stagger’s.">
                  <Input type="date" value={vat.firstPeriodEnd ?? ''} onChange={(e) => setVat({ firstPeriodEnd: e.target.value || undefined })} />
                </Field>
                <Field label="Deregistered on">
                  <Input type="date" value={vat.deregisteredOn ?? ''} onChange={(e) => setVat({ deregisteredOn: e.target.value || undefined })} />
                </Field>
              </div>
              <p className="text-[12.5px] text-ink-3">Accounting scheme: cash accounting (accrual and flat rate are not supported yet).</p>
              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-ink-2">Returns</span>
                {vat.schedule.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <span className="w-12 text-[12.5px] text-ink-3">{i === 0 ? 'From' : 'Then'}</span>
                    <Input type="date" aria-label="From" value={s.from} disabled={i === 0} onChange={(e) => setVat({ schedule: vat.schedule.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} className="w-40" />
                    <Select aria-label="How often" value={s.stagger} onChange={(e) => setVat({ schedule: vat.schedule.map((x, j) => (j === i ? { ...x, stagger: e.target.value as VatStagger } : x)) })} className="min-w-0 flex-1 sm:max-w-lg">
                      {VAT_STAGGERS.map((st) => (
                        <option key={st} value={st}>
                          {VAT_STAGGER_LABELS[st]}
                        </option>
                      ))}
                    </Select>
                    {i > 0 && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label="Take this change away" onClick={() => setVat({ schedule: vat.schedule.filter((_, j) => j !== i) })} />}
                  </div>
                ))}
                <div>
                  <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setVat({ schedule: [...vat.schedule, { from: '', stagger: vat.schedule.at(-1)!.stagger }] })}>
                    HMRC changed how often
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-3 border-t border-line pt-4">
          <Checkbox checked={d.hasPaye} onChange={(v) => set({ hasPaye: v })} label="Has a PAYE scheme (a record only, for now)" />
          {d.hasPaye && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From">
                <Input type="date" value={d.paye?.from ?? ''} onChange={(e) => set({ paye: { ...d.paye, from: e.target.value } })} />
              </Field>
              <Field label="Closed on">
                <Input type="date" value={d.paye?.closedOn ?? ''} onChange={(e) => set({ paye: { from: d.paye?.from ?? '', ...(e.target.value ? { closedOn: e.target.value } : {}) } })} />
              </Field>
            </div>
          )}
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Next confirmation statement made up to" hint={`As Companies House shows it. Empty: worked out${nextConfirmation ? ` (${formatDate(nextConfirmation.period.end)})` : ''}.`}>
            <Input type="date" value={d.confirmationStatement?.nextMadeUpTo ?? ''} onChange={(e) => set({ confirmationStatement: e.target.value ? { nextMadeUpTo: e.target.value } : undefined })} />
          </Field>
          <Field label="List deadlines from" hint="Deadlines due before this day and not recorded here are left out: settled before you kept its books here.">
            <Input type="date" value={d.deadlinesFrom ?? ''} onChange={(e) => set({ deadlinesFrom: e.target.value || undefined })} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={save.isPending} disabled={!d.incorporatedOn} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
          {view.books && (
            <span className="text-[12px] text-ink-3">
              Last set {formatDate(view.books.updatedAt.slice(0, 10))} {view.books.setBy === 'agent' ? 'from an agent’s proposal you applied' : 'by you'}.
            </span>
          )}
          {save.error && <span className="text-[12px] text-bad-ink">{save.error.message}</span>}
        </div>
      </div>
    </Card>
  );
}

// ─── Filings ─────────────────────────────────────────────────────────────────────────────────────

const VAT_BOXES: [keyof VatBoxes, string, boolean][] = [
  ['vatDueSales', 'Box 1: VAT due on sales', false],
  ['vatDueAcquisitions', 'Box 2: VAT due on acquisitions', false],
  ['totalVatDue', 'Box 3: total VAT due', false],
  ['vatReclaimedCurrPeriod', 'Box 4: VAT reclaimed', false],
  ['netVatDue', 'Box 5: net VAT', false],
  ['totalValueSalesExVAT', 'Box 6: sales before VAT', true],
  ['totalValuePurchasesExVAT', 'Box 7: purchases before VAT', true],
  ['totalValueGoodsSuppliedExVAT', 'Box 8: goods to the EU', true],
  ['totalAcquisitionsExVAT', 'Box 9: goods from the EU', true],
];
const LINE_LABELS: Record<(typeof MICRO_ENTITY_LINES)[number], string> = {
  A: 'Called up share capital not paid',
  B: 'Fixed assets',
  C: 'Current assets',
  D: 'Prepayments and accrued income',
  E: 'Creditors: due within one year',
  F: 'Net current assets (liabilities)',
  G: 'Total assets less current liabilities',
  H: 'Creditors: due after more than one year',
  I: 'Provisions for liabilities',
  J: 'Accruals and deferred income',
  K: 'Capital and reserves',
};

interface FilingDraft {
  kind: CompanyFilingKind;
  periodStart: string;
  periodEnd: string;
  filedOn: string;
  reference: string;
  boxes: Partial<Record<keyof VatBoxes, number>>;
  lines: Partial<Record<(typeof MICRO_ENTITY_LINES)[number], number>>;
  amount: number | undefined;
}

const blankFiling = (d?: CompanyDeadline): FilingDraft => ({ kind: d?.kind ?? 'vat', periodStart: d?.period.start && d.kind !== 'confirmation' ? d.period.start : '', periodEnd: d?.period.end ?? '', filedOn: today(), reference: '', boxes: {}, lines: {}, amount: undefined });

/** The filing as the API takes it, with only the figures given. */
function filingOf(f: FilingDraft): CompanyFilingInput {
  const base = { periodEnd: f.periodEnd, filedOn: f.filedOn, ...(f.periodStart ? { periodStart: f.periodStart } : {}), ...(f.reference.trim() ? { reference: f.reference.trim() } : {}) };
  switch (f.kind) {
    case 'vat': {
      const given = VAT_BOXES.every(([k]) => f.boxes[k] !== undefined);
      return { kind: 'vat', ...base, ...(given ? { figures: f.boxes as VatBoxes } : {}) };
    }
    case 'accounts': {
      const lines = Object.fromEntries(Object.entries(f.lines).filter(([, v]) => v !== undefined));
      return { kind: 'accounts', ...base, ...(Object.keys(lines).length ? { figures: lines } : {}) };
    }
    case 'ct600':
      return { kind: 'ct600', ...base, ...(f.amount !== undefined ? { figures: { taxPayable: f.amount } } : {}) };
    case 'ct-payment':
      return { kind: 'ct-payment', ...base, ...(f.amount !== undefined ? { figures: { amount: f.amount } } : {}) };
    case 'confirmation':
      return { kind: 'confirmation', periodEnd: f.periodEnd, filedOn: f.filedOn, ...(f.reference.trim() ? { reference: f.reference.trim() } : {}) };
  }
}

function FilingDialog({ companyId, initial, onClose }: { companyId: string; initial: FilingDraft | null; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<FilingDraft>(initial ?? blankFiling());
  const set = (patch: Partial<FilingDraft>) => setF((x) => ({ ...x, ...patch }));
  const add = useApiMutation(() => api(`/companies/${companyId}/filings`, { method: 'POST', body: filingOf(f) }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Recorded' });
      onClose();
    },
  });
  // Boxes 3 and 5 as the others give them, to check what you typed.
  const b = f.boxes;
  const box3 = b.vatDueSales !== undefined && b.vatDueAcquisitions !== undefined ? fromMinor(toMinor(b.vatDueSales) + toMinor(b.vatDueAcquisitions)) : undefined;
  const box5 = b.totalVatDue !== undefined && b.vatReclaimedCurrPeriod !== undefined ? fromMinor(Math.abs(toMinor(b.totalVatDue) - toMinor(b.vatReclaimedCurrPeriod))) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Record a filing"
      description="Something the company filed or paid: its kind, the period it is for, and the day."
      footer={
        <>
          {add.error && <span className="mr-auto self-center text-[12px] text-bad-ink">{add.error.message}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!f.periodEnd || !f.filedOn} onClick={() => add.mutate(undefined)}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What">
            <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as CompanyFilingKind })}>
              {COMPANY_FILING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FILING_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" hint="A submission receipt or payment reference, if you have one.">
            <Input value={f.reference} maxLength={60} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {f.kind !== 'confirmation' && (
            <Field label="Period from">
              <Input type="date" value={f.periodStart} onChange={(e) => set({ periodStart: e.target.value })} />
            </Field>
          )}
          <Field label={f.kind === 'confirmation' ? 'Made up to' : f.kind === 'accounts' ? 'Balance sheet date' : 'Period to'}>
            <Input type="date" value={f.periodEnd} onChange={(e) => set({ periodEnd: e.target.value })} />
          </Field>
          <Field label={f.kind === 'ct-payment' ? 'Paid on' : 'Filed on'}>
            <Input type="date" value={f.filedOn} max={today()} onChange={(e) => set({ filedOn: e.target.value })} />
          </Field>
        </div>
        {f.kind === 'vat' && (
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">Its nine boxes (optional: all of them, or none)</div>
            <div className="grid gap-3 sm:grid-cols-3">
              {VAT_BOXES.map(([k, label, whole]) => (
                <Field key={k} label={label} hint={k === 'totalVatDue' && box3 !== undefined ? `Boxes 1 + 2: ${box3.toFixed(2)}` : k === 'netVatDue' && box5 !== undefined ? `Boxes 3 − 4: ${box5.toFixed(2)}` : whole ? 'Whole pounds' : undefined}>
                  <NumberInput value={b[k]} onValue={(v) => set({ boxes: { ...b, [k]: v } })} className="sensitive tabular" />
                </Field>
              ))}
            </div>
          </div>
        )}
        {f.kind === 'accounts' && (
          <details>
            <summary className="cursor-pointer text-[12.5px] font-medium text-ink-2">Its balance sheet, micro-entity lines A–K (optional, whole pounds)</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {MICRO_ENTITY_LINES.map((l) => (
                <Field key={l} label={`${l}: ${LINE_LABELS[l]}`}>
                  <NumberInput value={f.lines[l]} onValue={(v) => set({ lines: { ...f.lines, [l]: v } })} className="sensitive tabular" />
                </Field>
              ))}
            </div>
          </details>
        )}
        {(f.kind === 'ct600' || f.kind === 'ct-payment') && (
          <Field label={f.kind === 'ct600' ? 'Tax payable (optional; 0 says there is nothing to pay)' : 'Amount paid (optional)'} className="sm:w-60">
            <NumberInput value={f.amount} onValue={(v) => set({ amount: v })} className="sensitive tabular" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function FilingFigures({ f }: { f: CompanyFiling }) {
  const figure = (label: string, value: number, decimals?: number) => (
    <span>
      {label} <Money value={value} className="tabular" {...(decimals !== undefined ? { decimals } : {})} />
    </span>
  );
  if (f.kind === 'vat' && f.figures) return figure('Box 5', f.figures.netVatDue);
  if (f.kind === 'ct600' && f.figures) return figure('Tax', f.figures.taxPayable);
  if (f.kind === 'ct-payment' && f.figures) return figure('Paid', f.figures.amount);
  if (f.kind === 'accounts' && f.figures?.K !== undefined) return figure('Capital and reserves', f.figures.K, 0);
  return null;
}

function FilingsCard({ view, onRecord }: { view: CompanyBooksResponse; onRecord: () => void }) {
  const toast = useToast();
  const remove = useApiMutation((id: string) => api(`/companies/${view.company.id}/filings/${id}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Taken away' }) });
  const filings = useMemo(() => [...(view.books?.filings ?? [])].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.kind.localeCompare(b.kind)), [view.books]);
  return (
    <Card
      title="Filings"
      description="What it has filed and paid. Each does the deadline of its kind and period."
      padded={false}
      actions={
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onRecord}>
          Record a filing
        </Button>
      }
    >
      {filings.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Nothing recorded yet">Record its accounts, confirmation statements, CT600s, Corporation Tax paid and VAT returns as they are filed.</EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>What</th>
                <th className={tableClasses.th}>Period</th>
                <th className={tableClasses.th}>Filed</th>
                <th className={tableClasses.th}>Reference</th>
                <th className={tableClasses.th}>Figures</th>
                <th className={tableClasses.th}>
                  <span className="sr-only">Take away</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filings.map((f) => (
                <tr key={f.id}>
                  <td className={tableClasses.td}>
                    {FILING_KIND_LABELS[f.kind]}
                    {f.addedBy === 'agent' && <span className="ml-1.5 text-[12px] text-ink-3">· from a proposal</span>}
                  </td>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{f.periodStart ? formatSpan(f.periodStart, f.periodEnd) : formatDate(f.periodEnd)}</td>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{formatDate(f.filedOn)}</td>
                  <td className={cn(tableClasses.td, 'sensitive')}>{f.reference ?? ''}</td>
                  <td className={tableClasses.td}>
                    <FilingFigures f={f} />
                  </td>
                  <td className={cn(tableClasses.td, 'text-right')}>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label={`Take away the ${FILING_KIND_LABELS[f.kind].toLowerCase()} to ${formatDate(f.periodEnd)}`} loading={remove.isPending && remove.variables === f.id} onClick={() => remove.mutate(f.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove.error && <p className="px-5 pb-3 text-[12px] text-bad-ink">{remove.error.message}</p>}
    </Card>
  );
}

export default function Company() {
  const { id = '', tab: tabParam } = useParams();
  const tab: Tab = tabParam === 'settings' ? 'settings' : 'overview';
  const navigate = useNavigate();
  const q = useApi<CompanyBooksResponse>(['company-books', id], `/companies/${id}/books`);
  const list = useApi<CompanyBooksListItem[]>(['company-books'], '/company-books');
  const [recording, setRecording] = useState<FilingDraft | null | undefined>(undefined);
  if (q.error) return <ErrorNote error={q.error} />;
  const view = q.data;
  if (!view) return <Loading />;
  const others = (list.data ?? []).filter((c) => c.id !== id);
  return (
    <div>
      <PageHeader
        title={view.company.name}
        subtitle={[view.company.number ? `Company ${view.company.number}` : '', view.books ? `incorporated ${formatDate(view.books.incorporatedOn)}` : '', 'its own records, apart from yours'].filter(Boolean).join(' · ')}
        actions={
          others.length > 0 ? (
            <Select value={id} onChange={(e) => void navigate(`/company/${e.target.value}${tab === 'settings' ? '/settings' : ''}`)} aria-label="Company" className="w-56">
              {[{ id, name: view.company.name }, ...others].map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />
      {!view.books ? (
        <Card title="Its books are not kept here yet" description="Keep them here to see its deadlines: accounts and confirmation statements at Companies House, Corporation Tax and VAT at HMRC.">
          <KeepBooks companyId={view.company.id} companyName={view.company.name} />
        </Card>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(v) => void navigate(v === 'overview' ? `/company/${id}` : `/company/${id}/settings`)}
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'settings', label: 'Settings' },
            ]}
          />
          <div className="mt-5 flex flex-col gap-5">
            {tab === 'overview' ? (
              <>
                <section className="grid gap-5 lg:grid-cols-2">
                  <TodoCard view={view} onRecord={(d) => setRecording(blankFiling(d))} />
                  <MoneyCard view={view} />
                </section>
                <DeadlinesCard view={view} onRecord={(d) => setRecording(blankFiling(d))} />
              </>
            ) : (
              <>
                <BooksForm key={view.books.updatedAt} view={view} />
                <FilingsCard view={view} onRecord={() => setRecording(null)} />
              </>
            )}
          </div>
        </>
      )}
      {recording !== undefined && <FilingDialog companyId={view.company.id} initial={recording} onClose={() => setRecording(undefined)} />}
      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-ink-3">
        <Building2 className="size-3.5" aria-hidden /> Deadlines are worked out from the dates here and the rules in force; check each with Companies House or HMRC. They are the company’s, and count in none of your figures.
      </p>
    </div>
  );
}
