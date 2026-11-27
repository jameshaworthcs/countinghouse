import { FileText, Pencil, Plus, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { formatMonth, today } from '../../shared/dates';
import type { AccountDetailResponse, CompanyBooksListItem, CompanyView, CoverageResponse, DirectorLoanView, PensionArrangementsResponse, TransactionsResponse } from '../../shared/api';
import { KeepBooks } from '../components/KeepBooks';
import { DIRECTOR_LOAN_KIND_LABELS } from '../../shared/company';
import { AccountDialog, BalanceDialog } from '../components/AccountForms';
import { ChartFrame } from '../components/charts/common';
import { TimeChart } from '../components/charts/TimeChart';
import { CoverageGrid } from '../components/Coverage';
import { LinkedAccounts } from '../components/Handover';
import { InsightsPanel } from '../components/Intel';
import { TermsCard } from '../components/Terms';
import { TransactionList } from '../components/TransactionList';
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Loading, Money, PageHeader, Select, SortHeader, Stat, Tabs, tableClasses, useToast } from '../components/ui';
import { FilePickerButton } from '../components/Upload';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { cn, formatDate, money, pct, timeAgo } from '../lib/format';
import { Sorted } from '../lib/sort';
import { LiveAccountValue, LiveSub } from '../components/LiveFeed';

type Tab = 'transactions' | 'balances' | 'holdings' | 'documents';

/** What your employers said they would pay into this pension, and what arrived. */
function ArrangementsCard({ accountId }: { accountId: string }) {
  const q = useApi<PensionArrangementsResponse>(['arrangements', accountId], `/accounts/${accountId}/arrangements`);
  const d = q.data;
  if (!d?.arrangements.length) return null;
  const month = (m: string) => formatMonth(`${m}-01`);
  return (
    <Card className="mb-5" title="Paid in by your employer" description="What each employer’s form set up, checked against the contributions that arrived.">
      <ul className="flex flex-col gap-2 text-[13px] text-ink-2">
        {d.arrangements.map((x, i) => {
          const a = x.arrangement;
          return (
            <li key={i}>
              <div>
                <span className="font-medium text-ink">{x.employer}</span>: <Money value={a.amount} /> {a.kind === 'single' ? 'once' : 'a month'}, gross, from its form of {formatDate(a.from)}
                {a.until ? ` to ${formatDate(a.until)}` : ''}.{a.note ? <span className="text-ink-3"> {a.note}.</span> : null}
              </div>
              <div className="text-[12.5px] text-ink-3">
                {a.kind === 'single'
                  ? x.arrived
                    ? `Arrived on ${formatDate(x.arrived.date)}.`
                    : 'Not found in this account’s data within 60 days of the form.'
                  : x.firstSeen === false
                    ? 'Its first collection was not found within two months of the form.'
                    : `${x.collected!.length} collected, from ${formatDate(x.collected![0]!.date)} to ${formatDate(x.collected!.at(-1)!.date)}.${x.missing!.length ? ` None in ${x.missing!.length === 1 ? month(x.missing![0]!) : `${x.missing!.length} months since: ${month(x.missing![0]!)} to ${month(x.missing!.at(-1)!)}`}.` : ''}`}
              </div>
            </li>
          );
        })}
      </ul>
      {d.others.length > 0 && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          Other employer contributions, on no arrangement: {d.others.map((o) => `${money(o.amount)} on ${formatDate(o.date)}`).join(', ')}.
        </p>
      )}
    </Card>
  );
}

/** A company's own account: whose it is, and that it counts in nothing of yours. */
function CompanyBadge({ companyId }: { companyId: string }) {
  const q = useApi<CompanyView[]>(['companies'], '/companies');
  const name = q.data?.find((x) => x.company.id === companyId)?.company.name ?? companyId;
  return (
    <span title="The company’s own account: its money is the company’s, so it is never in your estate or any figure of yours">
      <Badge tone="muted">{name}’s account</Badge>
    </span>
  );
}

/** Your director's loan with a company: what it owes you, linked to its account; or a way to add one. */
function DirectorLoanLine({ view }: { view: CompanyView }) {
  const toast = useToast();
  const navigate = useNavigate();
  const add = useApiMutation(() => api<{ account: { id: string } }>(`/companies/${view.company.id}/director-loan`, { body: {} }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: 'Director’s loan account added' });
      void navigate(`/accounts/${r.account.id}`);
    },
  });
  const d = view.directorLoan;
  if (d)
    return (
      <div className="sensitive">
        <Link to={`/accounts/${d.accountId}`} className="text-accent hover:underline">
          Director’s loan
        </Link>
        :{' '}
        {d.balance === null ? (
          'no balance yet'
        ) : d.balance >= 0 ? (
          <>
            it owes you <Money value={d.balance} />
          </>
        ) : (
          <>
            you owe it <Money value={-d.balance} />
          </>
        )}
        {d.asOf ? <span className="text-ink-3"> (as of {formatDate(d.asOf)}{d.estimated ? ', estimated' : ''})</span> : null}.
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ink-3">No director’s loan account yet: if you are one of its directors, it would hold what the company owes you, from the payments you mark as paid for it or lent to it.</span>
      <Button size="sm" icon={<Plus className="size-3.5" />} loading={add.isPending} onClick={() => add.mutate(undefined)}>
        Add the director’s loan account for {view.company.name}
      </Button>
      {add.error && <span className="text-[12px] text-bad-ink">{add.error.message}</span>}
    </div>
  );
}

/**
 * A director's loan account (docs/FORMULAS.md §9, "A director's loan"): whose it is, what it means, and
 * the warnings when you owe the company. Its movements are listed in their tab below.
 */
function DirectorLoanCard({ view, accountId }: { view: DirectorLoanView; accountId: string }) {
  if (!view.company) return <LinkDirectorLoan accountId={accountId} />;
  return (
    <>
      {view.warnings.map((w) => (
        <Callout key={w.kind} tone="warn" className="mb-5" title={w.title}>
          {w.detail}
        </Callout>
      ))}
      <Card className="mb-5" title={`Your director’s loan with ${view.company.name}`} description="What the company owes you; below nothing, what you owe it.">
        <p className="text-[13px] text-ink-2">
          It moves with the payments of yours you mark as paid for the company (a cost of its you paid, or its refund to you) or lent to it (or paid back by it): each one, the other way round. Those payments stay in their own accounts and count in none of your spending or income, so nothing is counted twice. When you keep the company’s books here, it moves with what its books post to the director’s loan instead: the same payments of yours (or the company’s own rows linked to them), and what only the books know, such as a journal. Record a balance (the director’s loan figure in the company’s filed accounts) and it is worked out from there, as a statement anchors a bank account.{' '}
          <Link to="/transactions" className="text-accent hover:underline" title="Open a payment and choose ‘Your company’">
            Mark a payment
          </Link>
          .
        </p>
        <p className="mt-1 text-[12px] text-ink-3">
          {view.movements.length ? `${view.movements.length} movement${view.movements.length === 1 ? '' : 's'}, from ${formatDate(view.movements.at(-1)!.date)}.` : 'No payments marked yet.'}
        </p>
        <MoveDirectorLoan company={view.company} />
      </Card>
    </>
  );
}

/** Added to the wrong company: move it to one that has none (POST /api/companies/:id/director-loan/move). */
function MoveDirectorLoan({ company }: { company: { id: string; name: string } }) {
  const toast = useToast();
  const q = useApi<CompanyView[]>(['companies'], '/companies');
  const free = (q.data ?? []).filter((c) => !c.directorLoan && c.company.id !== company.id);
  const [choice, setChoice] = useState('');
  const move = useApiMutation(() => api<{ to: CompanyView; renamed: boolean }>(`/companies/${company.id}/director-loan/move`, { body: { to: choice } }), {
    onSuccess: (r) => {
      setChoice('');
      toast({ tone: 'good', text: `Moved to ${r.to.company.name}${r.renamed ? ' and renamed' : ''}` });
    },
    // Refused: show what is saved now, not the page as it was.
    onError: () => undefined,
  });
  if (!free.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12.5px] text-ink-3">
      <span>Not your director’s loan with {company.name}? Move it, with its balances, to</span>
      <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Company to move it to" className="w-56">
        <option value="">Choose the company…</option>
        {free.map((c) => (
          <option key={c.company.id} value={c.company.id}>
            {c.company.name}
          </option>
        ))}
      </Select>
      <Button size="sm" disabled={!choice} loading={move.isPending} onClick={() => move.mutate(undefined)}>
        Move
      </Button>
      {move.error && <span className="text-[12px] text-bad-ink">{move.error.message}</span>}
      {choice && (
        <span className="basis-full">
          It then moves with your money with {free.find((c) => c.company.id === choice)?.company.name}. Payments you marked with {company.name} stay marked with it, and count in no director’s loan of yours until you mark them again.
        </span>
      )}
    </div>
  );
}

/** A director's loan account no company names: link it to one that has none (PUT /api/companies/:id). */
function LinkDirectorLoan({ accountId }: { accountId: string }) {
  const toast = useToast();
  const q = useApi<CompanyView[]>(['companies'], '/companies');
  const free = (q.data ?? []).filter((c) => !c.directorLoan);
  const [choice, setChoice] = useState('');
  const link = useApiMutation(() => api(`/companies/${choice}`, { method: 'PUT', body: { directorLoanAccountId: accountId } }), { onSuccess: () => toast({ tone: 'good', text: 'Linked' }) });
  return (
    <Callout tone="warn" className="mb-5" title="No company names this director’s loan account">
      Its movements are the payments you mark as paid for a company or lent to it, so it moves only once a company names it as your director’s loan.
      {free.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Company" className="w-64">
            <option value="">Choose the company…</option>
            {free.map((c) => (
              <option key={c.company.id} value={c.company.id}>
                {c.company.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" disabled={!choice} loading={link.isPending} onClick={() => link.mutate(undefined)}>
            Link
          </Button>
          {link.error && <span className="text-[12px] text-bad-ink">{link.error.message}</span>}
        </div>
      ) : (
        ' Every company you hold shares in has one already, or there is none yet.'
      )}
    </Callout>
  );
}

/** A director's loan's movements, newest first: what each was, the payment it comes from, and its account. */
function MovementsTable({ view }: { view: DirectorLoanView }) {
  if (!view.movements.length) return <EmptyState title="No movements yet">Mark a payment of yours as paid for the company or lent to it: open it on the Transactions page and choose “Your company”.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th className={tableClasses.th}>Date</th>
            <th className={tableClasses.th}>What</th>
            <th className={tableClasses.th}>Payment</th>
            <th className={cn(tableClasses.th, tableClasses.num)}>Owed to you</th>
          </tr>
        </thead>
        <tbody>
          {view.movements.map((m) => (
            <tr key={m.id}>
              <td className={tableClasses.td}>{formatDate(m.date)}</td>
              <td className={tableClasses.td}>{DIRECTOR_LOAN_KIND_LABELS[m.kind]}</td>
              <td className={tableClasses.td}>
                {m.accountId ? (
                  <Link to={`/transactions?accounts=${m.accountId}&period=custom&from=${m.date}&to=${m.date}`} className="text-accent hover:underline">
                    {m.payee ?? m.description}
                  </Link>
                ) : (
                  <span className="text-ink">{m.description}</span>
                )}
                <div className="text-[12px] text-ink-3">{m.source === 'mark' ? m.accountName : m.source === 'journal' ? 'A journal in the company’s books' : `${m.accountName}, from the company’s books`}</div>
              </td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Money value={m.amount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The company whose shares this account holds: the holding, how it is valued, and its dividends. */
function CompanyCard({ accountId }: { accountId: string }) {
  const q = useApi<CompanyView[]>(['companies'], '/companies');
  // Whether its books are kept here: from the company's own route, never from this personal view.
  const books = useApi<CompanyBooksListItem[]>(['company-books'], '/company-books');
  const [keeping, setKeeping] = useState(false);
  const v = q.data?.find((x) => x.company.accountId === accountId);
  if (!v) return null;
  const c = v.company;
  const kept = books.data?.find((b) => b.id === c.id);
  return (
    <Card className="mb-5" title={c.name} description={[c.number ? `Company ${c.number}` : '', 'shares you hold'].filter(Boolean).join(' · ')}>
      <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        {c.holdings.map((h, i) => (
          <div key={i}>
            <span className="font-medium text-ink">
              {h.shares} {h.shareClass} share{h.shares === 1 ? '' : 's'}
            </span>
            {h.totalShares ? ` of the ${h.totalShares} it has issued (${pct(h.shares / h.totalShares)})` : ''}
            {h.certificate ? `, certificate ${h.certificate}` : ''}
            {h.acquiredOn ? `, held from ${formatDate(h.acquiredOn)}` : ''}
          </div>
        ))}
        {v.valuation && (
          <div className="sensitive">
            Worth about <Money value={v.valuation.value} /> on {formatDate(v.valuation.asOf)}
            {v.valuation.method === 'net-assets' && v.valuation.netAssets !== undefined ? (
              <>
                : its net assets of <Money value={v.valuation.netAssets} />, as your share of its shares (book value, an estimate)
              </>
            ) : (
              ' (your figure)'
            )}
            .
          </div>
        )}
        <DirectorLoanLine view={v} />
        {books.data &&
          (kept ? (
            <div>
              Its books are kept here:{' '}
              <Link to={`/company/${c.id}`} className="text-accent hover:underline">
                its deadlines and records
              </Link>
              {kept.overdue > 0 ? `, ${kept.overdue} overdue` : kept.dueSoon > 0 ? `, ${kept.dueSoon} due soon` : ''}.
            </div>
          ) : keeping ? (
            <div className="mt-1">
              <KeepBooks companyId={c.id} companyName={c.name} />
            </div>
          ) : (
            <div>
              <Button size="sm" onClick={() => setKeeping(true)}>
                Keep its books here
              </Button>
              <span className="ml-2 text-ink-3">If you run it: its accounts, confirmation statements, Corporation Tax and VAT deadlines.</span>
            </div>
          ))}
        {c.employmentId && (
          <div>
            You also work for it: its pay is on the{' '}
            <Link to="/tax/pay" className="text-accent hover:underline">
              Pay tab
            </Link>
            .
          </div>
        )}
      </div>
      {v.dividends.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[12px] font-medium text-ink-3">
            Dividends it paid you: <Money value={v.dividendsTotal} />
          </div>
          <ul className="flex flex-col gap-0.5 text-[13px]">
            {v.dividends.map((d, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-ink-2">
                  {formatDate(d.date)}
                  {d.taxYear ? <span className="text-ink-3"> · {d.taxYear}</span> : null}
                  {d.figureId ? (d.importId ? <Link to={`/import/${d.importId}`} className="text-ink-3 hover:underline"> · voucher</Link> : <span className="text-ink-3"> · voucher</span>) : <span className="text-ink-3"> · no voucher</span>}
                  {d.paidIn ? (
                    <Link to={`/transactions?accounts=${d.paidIn.accountId}&period=custom&from=${d.paidIn.date}&to=${d.paidIn.date}`} className="text-ink-3 hover:underline">
                      {' '}
                      · paid in {formatDate(d.paidIn.date)}
                    </Link>
                  ) : null}
                </span>
                <Money value={d.amount} className="tabular" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export default function AccountDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi<AccountDetailResponse>(['account', id], `/accounts/${id}`);
  const txs = useApi<TransactionsResponse>(['transactions', 'account', id], `/transactions${qs({ accounts: id, limit: 50 })}`);
  const cov = useApi<CoverageResponse>(['coverage'], '/coverage');
  const [tab, setTab] = useState<Tab>('transactions');
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const delBalance = useApiMutation((bid: string) => api(`/balances/${bid}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Balance deleted' }) });
  const delAccount = useApiMutation(() => api(`/accounts/${id}`, { method: 'DELETE' }), { onSuccess: () => void navigate('/accounts') });
  // Today where you are (shared/dates.ts), not in UTC: just after midnight in summer that is still yesterday.
  const close = useApiMutation(() => api(`/accounts/${id}`, { method: 'PATCH', body: { status: 'closed', closedOn: today() } }));

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { account, summary, balances, holdings, series, gaps, imports, paidIn } = q.data;
  // A company's account has its own coverage grid; yours are in GET /coverage.
  const coverage = q.data.coverage ?? cov.data;
  const meta = ACCOUNT_TYPE_META[account.type];
  const market = balanceModeOf(account) === 'market';
  // A director's loan: no rows of its own, its movements worked out from the payments you mark.
  const loan = q.data.directorLoan;
  const latestHoldings = holdings[holdings.length - 1];
  const lastBal = balances[balances.length - 1];
  const points = series.filter((p) => p.value !== null);
  const snapshotDates = new Set(balances.map((b) => b.date));
  const empty = !summary.transactionCount && !balances.length && !loan?.movements.length;

  return (
    <div>
      <PageHeader
        title={account.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {[summary.institutionName, meta.label, account.last4 ? `•••• ${account.last4}` : null].filter(Boolean).join(' · ')}
            {account.status === 'closed' && <Badge tone="muted">closed</Badge>}
            {account.companyId ? <CompanyBadge companyId={account.companyId} /> : !account.includeInNetWorth && <Badge tone="muted">not in estate value</Badge>}
          </span>
        }
        actions={
          <>
            {!meta.derived && (
              <FilePickerButton accountId={account.id} icon={<Upload className="size-4" />}>
                Upload for this account
              </FilePickerButton>
            )}
            <Button icon={<Plus className="size-4" />} onClick={() => setRecording(true)}>
              {market ? 'Record value' : 'Record balance'}
            </Button>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          </>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={market ? 'Value' : 'Balance'}
          value={<Money value={summary.balance} currency={account.currency} />}
          sub={summary.live ? <LiveSub live={summary.live} currency={account.currency} /> : summary.asOf ? `as of ${formatDate(summary.asOf)}${summary.estimated ? ' (estimated)' : ''}` : summary.balance !== null ? 'estimated: no statement data yet' : 'no data yet'}
        />
        <Stat label="Last updated" value={summary.asOf ? timeAgo(summary.asOf) : '—'} sub={summary.stale ? <span className="inline-flex items-center gap-1 text-warn-ink"><TriangleAlert className="size-3.5" /> needs new data</span> : 'up to date'} />
        {market && paidIn ? (
          <Stat label="Paid in" value={<Money value={paidIn.amount} />} sub={summary.balance !== null ? <span>growth {money(summary.balance - paidIn.amount - (lastBal?.bonusToDate ?? 0))} ({pct((summary.balance - paidIn.amount - (lastBal?.bonusToDate ?? 0)) / Math.max(1, paidIn.amount + (lastBal?.bonusToDate ?? 0)))})</span> : undefined} />
        ) : loan ? (
          <Stat label="Movements" value={loan.movements.length.toLocaleString()} sub={loan.movements[0] ? `latest ${formatDate(loan.movements[0].date)}` : 'none marked yet'} />
        ) : (
          <Stat label="Transactions" value={summary.transactionCount.toLocaleString()} sub={summary.lastTransaction ? `latest ${formatDate(summary.lastTransaction)}` : undefined} />
        )}
        {account.type === 'lisa' && lastBal?.bonusToDate !== undefined ? (
          <Stat label="Government bonus" value={<Money value={lastBal.bonusToDate} />} sub="received to date" />
        ) : (
          <Stat label="Snapshots" value={balances.length.toLocaleString()} sub={lastBal ? `latest ${formatDate(lastBal.date)}` : 'none yet'} />
        )}
      </div>

      <LiveAccountValue accountId={account.id} live={Boolean(summary.live)} />
      <LinkedAccounts links={q.data.links} />
      <InsightsPanel page="accounts" accountId={id} title="Agent notes on this account" className="mb-5" />
      {gaps.length > 0 && (
        <Callout tone="warn" className="mb-5" title={`${gaps.length} gap${gaps.length > 1 ? 's' : ''} in this account’s history`}>
          Balances don’t add up between some statements, which usually means a statement or some transactions are missing:
          <ul className="mt-1 list-disc pl-5">
            {gaps.slice(0, 5).map((g) => (
              <li key={g.from + g.to}>
                {formatDate(g.from)} to {formatDate(g.to)}: <span className="sensitive">{money(g.difference)}</span> unexplained
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {loan && <DirectorLoanCard view={loan} accountId={account.id} />}
      <CompanyCard accountId={account.id} />
      {ACCOUNT_TYPE_META[account.type].pension && <ArrangementsCard accountId={account.id} />}
      <TermsCard account={account} />

      {empty && loan ? null : empty ? (
        <Card>
          <EmptyState icon={<Upload className="size-8" />} title="No data for this account yet" action={<FilePickerButton accountId={account.id} variant="primary">Upload a statement or screenshot</FilePickerButton>}>
            Upload a statement, export or screenshot and it will be matched to this account.
          </EmptyState>
        </Card>
      ) : (
        points.length > 1 && (
          <ChartFrame
            className="mb-5"
            title={market ? 'Value over time' : 'Balance over time'}
            subtitle={market ? 'Dots are recorded valuations; between them, contributions are added' : loan ? 'Worked out from the payments you marked and the balances you recorded' : 'Rebuilt from statements and transactions'}
            table={{ columns: ['Date', 'Balance'], rows: [...points].reverse().map((p) => [formatDate(p.date), money(p.value)]) }}
          >
            <TimeChart
              dates={series.map((p) => p.date)}
              series={[
                { id: 'balance', label: market ? 'Value' : 'Balance', color: 'var(--s1)', values: series.map((p) => p.value), kind: 'area' },
                ...(market ? [{ id: 'snaps', label: 'Recorded value', color: 'var(--s1)', values: series.map((p) => (snapshotDates.has(p.date) ? p.value : null)), kind: 'line' as const, markers: true, quiet: true }] : []),
              ]}
              height={240}
              ariaLabel={`${account.name} balance over time`}
            />
          </ChartFrame>
        )
      )}

      {coverage && !empty && coverage.accounts.some((a) => a.accountId === id && a.source !== 'none') && (
        <Card
          className="mb-5"
          title="Data coverage"
          description={(() => {
            const row = coverage.accounts.find((a) => a.accountId === id)!;
            const span = row.from && row.to ? `${formatDate(row.from)} to ${formatDate(row.to)}` : 'no dates yet';
            return `Days with transaction data in each of the last 13 months (${row.source === 'imports' ? 'from the periods your statements cover' : 'from the first to the last transaction'}; ${span}). Months without data are left out of averages rather than counted as no spending.`;
          })()}
        >
          <CoverageGrid cov={coverage} only={id} />
        </Card>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'transactions', label: loan ? 'Movements' : 'Transactions', count: loan ? loan.movements.length : summary.transactionCount },
          { value: 'balances', label: market ? 'Valuations' : 'Balances', count: balances.length },
          ...(holdings.length ? [{ value: 'holdings' as Tab, label: 'Holdings' }] : []),
          { value: 'documents', label: 'Documents', count: imports.length },
        ]}
      />
      {tab === 'transactions' && loan && (
        <Card padded={false}>
          <MovementsTable view={loan} />
        </Card>
      )}
      {tab === 'transactions' && !loan && (
        <Card padded={false}>
          {txs.data?.items.length ? (
            <>
              <TransactionList items={txs.data.items} showAccount={false} />
              {txs.data.total > txs.data.items.length && (
                <div className="px-5 py-3 text-[13px]">
                  <Link to={`/transactions?accounts=${account.id}&period=all`} className="text-accent hover:underline">
                    See all {txs.data.total.toLocaleString()} transactions
                  </Link>
                </div>
              )}
            </>
          ) : (
            <EmptyState title="No transactions">{market ? 'Investment accounts are usually tracked by valuations; transactions (contributions, fees) are optional.' : 'Import a statement to see transactions.'}</EmptyState>
          )}
        </Card>
      )}
      {tab === 'balances' && (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <Sorted rows={[...balances].reverse()} columns={{ date: { value: (b) => `${b.date} ${b.at && b.at.slice(0, 10) === b.date ? b.at.slice(11, 19) : '24'}`, first: 'desc' }, balance: { value: (b) => b.balance }, paidIn: { value: (b) => b.contributions }, source: { value: (b) => b.kind } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Date" sort={sortProps('date')} />
                      <SortHeader label={market ? 'Value' : 'Balance'} sort={sortProps('balance')} numeric />
                      {market && <SortHeader label="Paid in" sort={sortProps('paidIn')} numeric />}
                      <SortHeader label="Source" sort={sortProps('source')} />
                      <th className={tableClasses.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id}>
                        <td className={tableClasses.td}>{formatDate(b.date)}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={b.balance} currency={b.currency} />
                        </td>
                        {market && <td className={cn(tableClasses.td, tableClasses.num)}>{b.contributions !== undefined ? <Money value={b.contributions} /> : '—'}</td>}
                        <td className={cn(tableClasses.td, 'text-ink-3')}>
                          {b.approximate ? <Badge tone="muted">approximate</Badge> : b.kind === 'feed' ? 'Trading 212 feed' : b.kind}
                          {b.enteredBy === 'user' && b.kind !== 'manual' ? ' · entered by you' : ''}
                          {b.at && b.at.slice(0, 10) === b.date ? ` · at ${b.at.slice(11, 16)}` : ''}
                          {b.dateSource && b.dateSource !== 'document' && b.dateSource !== 'manual' && b.dateSource !== 'feed' ? ` · date from ${b.dateSource}` : ''}
                          {b.note && <div className="text-[12px]">{b.note}</div>}
                          {b.source.importId && (
                            <Link to={`/import/${b.source.importId}`} className="ml-2 text-accent hover:underline">
                              import
                            </Link>
                          )}
                        </td>
                        <td className={cn(tableClasses.td, 'text-right')}>
                          <button className="text-ink-3 hover:text-bad-ink" aria-label="Delete balance" onClick={() => confirm('Delete this balance snapshot?') && delBalance.mutate(b.id)}>
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        </Card>
      )}
      {tab === 'holdings' && latestHoldings && (
        <Card title={`Holdings on ${formatDate(latestHoldings.date)}`} padded={false}>
          <div className="overflow-x-auto">
            <Sorted rows={latestHoldings.holdings} columns={{ name: { value: (h) => h.name }, units: { value: (h) => h.units }, price: { value: (h) => h.price }, value: { value: (h) => h.value }, weight: { value: (h) => h.value } }}>
              {({ rows, sortProps }) => (
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <SortHeader label="Holding" sort={sortProps('name')} />
                      <SortHeader label="Units" sort={sortProps('units')} numeric />
                      <SortHeader label="Price" sort={sortProps('price')} numeric />
                      <SortHeader label="Value" sort={sortProps('value')} numeric />
                      <SortHeader label="Weight" sort={sortProps('weight')} numeric />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => (
                      <tr key={h.name}>
                        <td className={tableClasses.td}>
                          <div className="font-medium">{h.name}</div>
                          <div className="text-[12px] text-ink-3">{[h.isin, h.sedol, h.ticker, h.assetClass].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{h.units?.toLocaleString('en-GB', { maximumFractionDigits: 4 }) ?? '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{h.price !== undefined ? h.price.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={h.value} currency={h.currency} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{pct(h.value / latestHoldings.totalValue)}</td>
                      </tr>
                    ))}
                    {latestHoldings.cash !== undefined && (
                      <tr>
                        <td className={tableClasses.td}>Cash</td>
                        <td className={tableClasses.td} />
                        <td className={tableClasses.td} />
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={latestHoldings.cash} />
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{pct(latestHoldings.cash / latestHoldings.totalValue)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </Sorted>
          </div>
        </Card>
      )}
      {tab === 'documents' && (
        <Card padded={false}>
          {imports.length ? (
            <ul className="divide-y divide-line">
              {imports.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <FileText className="size-4 text-ink-3" />
                  <a href={`/api/documents/${i.documentId}`} target="_blank" rel="noreferrer" className="flex-1 truncate text-accent hover:underline">
                    {i.label ?? i.fileName}
                  </a>
                  <span className="text-ink-3">{i.committedAt ? formatDate(i.committedAt.slice(0, 10)) : ''}</span>
                  <Link to={`/import/${i.id}`} className="text-ink-2 hover:underline">
                    details
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No documents yet" />
          )}
        </Card>
      )}

      <div className="no-print mt-8 flex flex-wrap gap-2 border-t border-line pt-5">
        {account.status === 'open' && (
          <Button variant="ghost" loading={close.isPending} onClick={() => confirm('Mark this account as closed? Its history is kept.') && close.mutate(undefined)}>
            Mark as closed
          </Button>
        )}
        {empty && (
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={delAccount.isPending} onClick={() => confirm('Delete this account?') && delAccount.mutate(undefined)}>
            Delete account
          </Button>
        )}
        {delAccount.error && <span className="text-[13px] text-bad-ink">{delAccount.error.message}</span>}
      </div>
      {editing && <AccountDialog open onOpenChange={setEditing} account={account} institutionName={summary.institutionName} />}
      {recording && <BalanceDialog open onOpenChange={setRecording} account={account} />}
    </div>
  );
}
