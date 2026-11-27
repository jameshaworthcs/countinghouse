// A company's Accounts tab (docs/FORMULAS.md §22, "The period's accounts"): for one accounting period,
// whether its accounts are ready and what stops them, its profit and loss account and balance sheet in
// the micro-entity formats (exact, and in whole pounds as Companies House takes them), its trial
// balance, fixed asset register, director's loan and bank reconciliation, and the lines filed against
// those worked out now. Everything from the company's own route (GET /api/companies/:id/accounts);
// nothing here is a figure of yours.

import { useState, type ReactNode } from 'react';
import type { AccountsCheck, AccountsPeriodChoice, BalanceSheet, BankReconciliation, CompanyAccountsResponse, ProfitAndLoss, RegisterRow, ReportCode, TrialBalance } from '../../shared/api';
import { DIRECTOR_LOAN_KIND_LABELS } from '../../shared/company';
import { formatDate, formatSpan } from '../../shared/dates';
import { FIXED_ASSET_CLASS_META, ledgerName, PROFIT_LINE_LABELS } from '../../shared/ledger';
import { fromMinor } from '../../shared/money';
import { useApi } from '../lib/api';
import { cn } from '../lib/format';
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Field, Loading, Money, Select, StatusBadge, tableClasses } from './ui';
import { CHECK_TITLES, checkLine } from './CompanyLedger';

/** Pence as money. */
const Pence = ({ value, className }: { value: number | null; className?: string }) => <Money value={value === null ? null : fromMinor(value)} className={cn('sensitive tabular', className)} />;
/** Whole pounds as money, no pence. */
const Pounds = ({ value }: { value: number }) => <Money value={value} decimals={0} className="sensitive tabular" />;

const periodLabel = (p: AccountsPeriodChoice) => `${formatSpan(p.start, p.end)}${p.ended ? '' : ' (running)'}${p.filed ? ' · filed' : ''}`;

/** A report's codes, beneath its line. */
function CodeRows({ codes, cols }: { codes: ReportCode[]; cols: number }) {
  return (
    <>
      {codes.map((c) => (
        <tr key={c.ledger} className="text-[12.5px] text-ink-2">
          <td className={cn(tableClasses.td, 'py-1 pl-7')}>{c.name}</td>
          <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
            <Pence value={c.amount} />
          </td>
          {cols > 2 && <td className={cn(tableClasses.td, 'py-1')} />}
        </tr>
      ))}
    </>
  );
}

function ProfitCard({ pl, codes }: { pl: ProfitAndLoss; codes: boolean }) {
  return (
    <Card title="Profit and loss account" description="The micro-entity format, for the period. Income adds to the profit; charges, shown negative, take from it." padded={false}>
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Line</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {pl.lines.map((l) => (
              <LineRows key={l.line} label={`${l.line}. ${l.label}`} amount={l.amount} codes={codes ? l.codes : []} />
            ))}
            <tr className="font-medium">
              <td className={tableClasses.td}>Profit or loss before tax (A to F)</td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pence value={pl.profitBeforeTax} />
              </td>
            </tr>
            <tr className="font-medium">
              <td className={tableClasses.td}>H. {PROFIT_LINE_LABELS.H}</td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pence value={pl.profit} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[12px] text-ink-3">Corporation Tax is not worked out yet: line G holds only a charge written in a journal. The tax computation comes in a later step.</p>
    </Card>
  );
}

function LineRows({ label, amount, codes }: { label: string; amount: number; codes: ReportCode[] }) {
  if (!amount && !codes.length) return null;
  return (
    <>
      <tr>
        <td className={tableClasses.td}>{label}</td>
        <td className={cn(tableClasses.td, tableClasses.num)}>
          <Pence value={amount} />
        </td>
      </tr>
      <CodeRows codes={codes} cols={2} />
    </>
  );
}

function SheetCard({ sheet, codes, filed }: { sheet: BalanceSheet; codes: boolean; filed: CompanyAccountsResponse['filing'] }) {
  const filedLine = (l: string) => filed?.lines.find((x) => x.line === l);
  const totals = new Set(['F', 'G', 'K']);
  return (
    <Card title="Balance sheet" description="The micro-entity format 1 at the period’s last day, exact and in whole pounds: Companies House takes whole pounds and works F, G and K out from the lines, so they are worked out here from the rounded lines too." padded={false}>
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th}>Line</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>Exact</th>
              <th className={cn(tableClasses.th, tableClasses.num)}>To file</th>
            </tr>
          </thead>
          <tbody>
            {sheet.lines.map((l) => {
              const f = filedLine(l.line);
              return (
                <SheetRows key={l.line} line={l.line} label={l.label} exact={l.exact} whole={l.whole} total={totals.has(l.line)} codes={codes && l.line !== 'K' ? l.codes : []} {...(f ? { filed: f.filed } : {})} />
              );
            })}
            <tr className="text-[12.5px] text-ink-2">
              <td className={cn(tableClasses.td, 'py-1 pl-7')}>Called up share capital</td>
              <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
                <Pence value={sheet.capital.shareCapital.exact} />
              </td>
              <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
                <Pounds value={sheet.capital.shareCapital.whole} />
              </td>
            </tr>
            <tr className="text-[12.5px] text-ink-2">
              <td className={cn(tableClasses.td, 'py-1 pl-7')}>
                Profit and loss account
                <div className="text-[11.5px] text-ink-3">
                  At the start <Pence value={sheet.capital.reserve.opening} />, the period’s profit <Pence value={sheet.capital.reserve.profit} />, dividends <Pence value={-sheet.capital.reserve.dividends} />
                  {sheet.capital.reserve.other !== 0 && (
                    <>
                      , other movements <Pence value={sheet.capital.reserve.other} />
                    </>
                  )}
                </div>
              </td>
              <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
                <Pence value={sheet.capital.reserve.exact} />
              </td>
              <td className={cn(tableClasses.td, tableClasses.num, 'py-1')}>
                <Pounds value={sheet.capital.reserve.whole} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[12px] text-ink-3">
        {sheet.balances ? 'Net assets (K) are capital and reserves, to the penny.' : 'Net assets (K) are not capital and reserves: please report this.'} In whole pounds the profit and loss account is K less the share capital, so the two add up to K.
      </p>
    </Card>
  );
}

function SheetRows({ line, label, exact, whole, total, codes, filed }: { line: string; label: string; exact: number; whole: number; total: boolean; codes: ReportCode[]; filed?: number }) {
  return (
    <>
      <tr className={cn(total && 'bg-panel-2 font-medium')}>
        <td className={tableClasses.td}>
          {line}. {label}
        </td>
        <td className={cn(tableClasses.td, tableClasses.num)}>
          <Pence value={exact} />
        </td>
        <td className={cn(tableClasses.td, tableClasses.num)}>
          <Pounds value={whole} />
          {filed !== undefined && filed !== whole && (
            <div className="text-[11.5px] text-bad-ink">
              filed <Pounds value={filed} />
            </div>
          )}
        </td>
      </tr>
      <CodeRows codes={codes} cols={3} />
    </>
  );
}

function TrialBalanceCard({ tb, accountName }: { tb: TrialBalance; accountName: (id: string) => string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title="Trial balance"
      description="Every code’s balance at the period’s end: balance sheet codes to date, profit and loss codes for the period alone, retained earnings at its start."
      padded={false}
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide it' : `Show it (${tb.rows.length})`}
        </Button>
      }
    >
      {open && (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Ledger</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Debit</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r) => (
                <tr key={r.ledger}>
                  <td className={tableClasses.td}>{ledgerName(r.ledger, accountName)}</td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{r.debit ? <Pence value={r.debit} /> : ''}</td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{r.credit ? <Pence value={r.credit} /> : ''}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className={tableClasses.td}>Together</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <Pence value={tb.debit} />
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <Pence value={tb.credit} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RegisterCard({ register }: { register: RegisterRow[] }) {
  return (
    <Card title="Fixed asset register" description="Each asset’s cost, written down straight line by whole months over its life (the month it was bought in full), to the period’s end." padded={false}>
      {register.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No fixed assets">A payment coded to a fixed asset’s cost, with its life, is listed here.</EmptyState>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Asset</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Cost</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>This period</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Written down</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Book value</th>
              </tr>
            </thead>
            <tbody>
              {register.map((a) => (
                <tr key={a.id}>
                  <td className={tableClasses.td}>
                    <div className="sensitive text-ink">{a.memo}</div>
                    <div className="text-[12px] text-ink-3">
                      {FIXED_ASSET_CLASS_META[a.class].name} · bought {formatDate(a.acquired)}
                      {a.from !== a.acquired && `, counted from ${formatDate(a.from)}`} · {a.months ? `${a.months} months${a.life === 'policy' ? ' (the policy)' : ''}` : 'no life: not written down'}
                      {a.disposedOn && ` · left ${formatDate(a.disposedOn)}`}
                    </div>
                    <div className="text-[12px] text-ink-3 sm:hidden">
                      This period <Pence value={a.charge} />, written down <Pence value={a.toDate} />
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Pence value={a.cost} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={a.charge} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>
                    <Pence value={a.toDate} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{a.disposedInPeriod ? <Badge tone="muted">Left</Badge> : <Pence value={a.netBookValue} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LoanCard({ loan }: { loan: NonNullable<CompanyAccountsResponse['directorLoan']> }) {
  const sideOf = (v: number) => (v < 0 ? '(you owe it)' : v > 0 ? '(it owes you)' : '');
  return (
    <Card title="Your director’s loan" description="Its movements in the period, from the books, signed from your side: what the company owes you grows positive. In the company’s books a credit." padded={false}>
      <div className="relative overflow-x-auto">
        <table className={tableClasses.table}>
          <tbody>
            <tr className="font-medium">
              <td className={tableClasses.td}>At the start</td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pence value={loan.opening} /> <span className="text-[12px] font-normal text-ink-3">{sideOf(loan.opening)}</span>
              </td>
            </tr>
            {loan.movements.map((m, i) => (
              <tr key={i}>
                <td className={tableClasses.td}>
                  <span className="whitespace-nowrap">{formatDate(m.date)}</span> · <span className="sensitive">{m.description}</span>
                  <div className="text-[12px] text-ink-3">{DIRECTOR_LOAN_KIND_LABELS[m.kind]}</div>
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <Pence value={m.amount} />
                </td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className={tableClasses.td}>At the end</td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Pence value={loan.closing} /> <span className="text-[12px] font-normal text-ink-3">{sideOf(loan.closing)}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[12px] text-ink-3">
        In the company’s books (debit positive): <Pence value={loan.books.opening} /> at the start, <Pence value={loan.books.closing} /> at the end.
      </p>
    </Card>
  );
}

const RECONCILED: Record<BankReconciliation['status'], ReactNode> = {
  reconciled: <StatusBadge status="good">Reconciled</StatusBadge>,
  differs: <StatusBadge status="bad">Differs</StatusBadge>,
  'rows-only': <Badge tone="muted">Rows only</Badge>,
  'no-balance': <Badge tone="warn">No balance that day</Badge>,
  'other-currency': <Badge tone="warn">Not in pounds</Badge>,
};

function ReconciliationCard({ list }: { list: BankReconciliation[] }) {
  return (
    <Card title="Bank reconciliation" description="Each of its accounts’ ledger at the period’s end against its balance from its statements on that day." padded={false}>
      {list.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No accounts of its own">Add the company’s bank account on the Accounts page, saying it is the company’s.</EmptyState>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Account</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Books</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Statements</th>
                <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Difference</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.accountId}>
                  <td className={tableClasses.td}>
                    <div className="text-ink">{r.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                      {RECONCILED[r.status]}
                      {r.basis && <span>from its balance on {formatDate(r.basis.date)}</span>}
                      {r.status === 'rows-only' && <span>no statement balance: its rows alone, which say nothing the books do not</span>}
                      {r.difference !== null && r.difference !== 0 && (
                        <span className="sm:hidden">
                          difference <Pence value={r.difference} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Pence value={r.books} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{r.statement === null ? '—' : <Pence value={r.statement} />}</td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'hidden sm:table-cell')}>{r.difference === null ? '—' : <Pence value={r.difference} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** A check that stops the accounts being ready, in words. */
function checkWords(c: AccountsCheck): { title: string; line?: ReactNode } {
  switch (c.kind) {
    case 'not-ended':
      return { title: `The period runs to ${formatDate(c.end)}: shown as at its end, from what is recorded so far` };
    case 'ledger':
      return { title: CHECK_TITLES[c.check.kind], line: checkLine(c.check) };
    case 'clearing':
      return {
        title: `${ledgerName(c.ledger)} holds a balance at the period’s end`,
        line: (
          <>
            <Pence value={c.amount} />: cleared by coding and linking, never by a journal
          </>
        ),
      };
    case 'trial-balance':
      return { title: 'The trial balance does not balance (please report this)' };
    case 'sheet':
      return { title: 'Net assets are not capital and reserves (please report this)' };
    case 'bank':
      return {
        title: `${c.reconciliation.name}: the books and its statements differ at the period’s end`,
        line:
          c.reconciliation.status === 'differs' ? (
            <>
              Books <Pence value={c.reconciliation.books} />, statements <Pence value={c.reconciliation.statement} />: a difference of <Pence value={c.reconciliation.difference} />
            </>
          ) : c.reconciliation.status === 'other-currency' ? (
            'Not in pounds: the books are kept in pounds'
          ) : (
            'The account has no balance known on that day, though the books carry one'
          ),
      };
    case 'drift':
      return { title: 'The books no longer work out to the accounts filed', line: `Line${c.lines.length === 1 ? '' : 's'} ${c.lines.map((l) => `${l.line} (filed £${l.filed}, now £${l.computed})`).join(', ')}. A correction goes through a journal in a later period: prior-period adjustments are not supported.` };
  }
}

function ReadyCard({ view }: { view: CompanyAccountsResponse }) {
  if (view.ready)
    return (
      <Callout tone="good" title="Ready">
        The period has ended, every row is coded, nothing sits in suspense, the books balance and each account reconciles to its statements.
        {view.filing && (view.filing.matches ? ' The lines filed match the books.' : '')}
      </Callout>
    );
  const groups = new Map<string, { title: string; lines: ReactNode[] }>();
  for (const c of view.checks) {
    const w = checkWords(c);
    const g = groups.get(w.title) ?? groups.set(w.title, { title: w.title, lines: [] }).get(w.title)!;
    if (w.line) g.lines.push(w.line);
  }
  const running = view.checks.length === 1 && view.checks[0]!.kind === 'not-ended';
  return (
    <Card title={running ? 'Not ended yet' : 'Not ready'} description={running ? 'Nothing else stops it: once the period ends, its accounts are ready.' : 'Each of these stops the accounts being ready.'}>
      <div className="flex flex-col gap-3 text-[13px]">
        {[...groups.values()].map((g) => (
          <details key={g.title} open={g.lines.length <= 3}>
            <summary className="cursor-pointer font-medium text-ink">
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
    </Card>
  );
}

function FilingCard({ filing }: { filing: NonNullable<CompanyAccountsResponse['filing']> }) {
  return (
    <Card title="As filed" description={`Accounts filed on ${formatDate(filing.filedOn)}${filing.reference ? `, ${filing.reference}` : ''}. The lines filed against those the books work out to now.`}>
      {filing.lines.length === 0 ? (
        <p className="text-[13px] text-ink-3">The filing recorded gives no lines to compare: add them in Settings → Filings to lock the books against it.</p>
      ) : filing.matches ? (
        <p className="text-[13px] text-good-ink">Every line filed ({filing.lines.map((l) => l.line).join(', ')}) is what the books work out to.</p>
      ) : (
        <p className="text-[13px] text-bad-ink">The books have moved since: {filing.lines.filter((l) => l.filed !== l.computed).map((l) => `${l.line} filed £${l.filed}, now £${l.computed}`).join('; ')}. Correct it with a journal in a later period (prior-period adjustments are not supported).</p>
      )}
    </Card>
  );
}

/** The Accounts tab: a period, and its accounts. */
export function AccountsTab({ companyId }: { companyId: string }) {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [codes, setCodes] = useState(true);
  const q = useApi<CompanyAccountsResponse>(['company-period-accounts', companyId, period ?? 'latest'], `/companies/${companyId}/accounts${period ? `?period=${period}` : ''}`);
  if (q.error) return <ErrorNote error={q.error} />;
  const view = q.data;
  if (!view || view.company.id !== companyId) return <Loading />;
  const accountName = (id: string) => view.reconciliation.find((r) => r.accountId === id)?.name;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Accounting period">
          <Select value={view.period.end} onChange={(e) => setPeriod(e.target.value)} aria-label="Accounting period" className="w-72 max-w-full">
            {view.periods.map((p) => (
              <option key={p.end} value={p.end}>
                {periodLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-2 pb-2">
          {view.ready ? <StatusBadge status="good">Ready</StatusBadge> : view.period.ended ? <StatusBadge status="warn">Not ready</StatusBadge> : <Badge tone="neutral">Running</Badge>}
          {view.period.filed && <Badge tone="muted">Filed {formatDate(view.period.filed.filedOn)}</Badge>}
          <Button size="sm" variant="ghost" aria-pressed={codes} onClick={() => setCodes((v) => !v)}>
            {codes ? 'Hide the codes beneath' : 'Show the codes beneath'}
          </Button>
        </div>
      </div>
      <ReadyCard view={view} />
      <section className="grid gap-5 xl:grid-cols-2">
        <ProfitCard pl={view.profitAndLoss} codes={codes} />
        <SheetCard sheet={view.balanceSheet} codes={codes} filed={view.filing} />
      </section>
      {view.filing && <FilingCard filing={view.filing} />}
      <RegisterCard register={view.register} />
      <section className="grid gap-5 xl:grid-cols-2">
        <ReconciliationCard list={view.reconciliation} />
        {view.directorLoan && <LoanCard loan={view.directorLoan} />}
      </section>
      <TrialBalanceCard tb={view.trialBalance} accountName={accountName} />
      <p className="text-[12px] text-ink-3">Worked out from the books on every visit, never stored: a correction is a coding or a journal, never an edit here. The figures to file are in whole pounds; check every one before filing.</p>
    </div>
  );
}
