import { Archive, ArrowLeft, CircleCheck, Copy, CopyCheck, ExternalLink, Info, ListChecks, LoaderCircle, Maximize2, Minimize2, Pencil, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import type { NothingNewView } from '../../shared/api';
import { formatDate, formatMonth } from '../../shared/dates';
import { describeDetail, describeDifference, fieldsInWords } from '../../shared/detail';
import { sectionChecks, type ReviewCheck } from '../../shared/review';
import { FIGURE_KINDS, type CsvProfile, type Draft, type DraftSection, type DraftTransaction, type Figure, type ImportRecord } from '../../shared/schema';
import { AccountTypeSelect } from '../components/AccountForms';
import { CategorySelect } from '../components/TransactionList';
import { Badge, Button, Callout, Card, Checkbox, ErrorNote, Field, Input, KeyValue, Loading, Money, Select, StatusBadge, tableClasses, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, fileSize, money, plural } from '../lib/format';
import { importStatus } from './Import';
import { ReadAgainCard } from '../components/ReadAgain';

type Rec = ImportRecord & { readiness?: { ready: boolean; reasons: string[] }; nothingNew?: NothingNewView };

/**
 * An import the reader understood that adds nothing: a view of what is already recorded, or of
 * what another upload has. Said plainly, with the reason, and put away in one click.
 */
function NothingNewPanel({ nothingNew, onDismiss, dismissing, error }: { nothingNew: NothingNewView; onDismiss: () => void; dismissing: boolean; error?: Error | null }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-4 py-4">
      <div className="flex items-start gap-3">
        <CopyCheck className="mt-0.5 size-5 shrink-0 text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold text-ink">Nothing new here</div>
          <p className="mt-0.5 text-[13px] text-ink-2">{nothingNew.reason}</p>
          {nothingNew.coveredBy.length > 0 && (
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              Waiting beside it:{' '}
              {nothingNew.coveredBy.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ', '}
                  <Link to={`/import/${c.id}`} className="text-accent hover:underline">
                    {c.fileName}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
        <Button variant="primary" size="sm" icon={<Archive className="size-3.5" />} loading={dismissing} onClick={onDismiss}>
          Dismiss
        </Button>
        <span className="min-w-0 flex-1 text-[12.5px] text-ink-3">Files it with your documents and records nothing from it.</span>
        {error && <span className="w-full text-[12.5px] text-bad-ink">{error.message}</span>}
      </div>
    </div>
  );
}

const DATE_SOURCE_LABEL: Record<string, string> = {
  document: 'from the document',
  exif: 'from photo metadata',
  filename: 'from the file name',
  'file-modified': 'from the file’s date',
  upload: 'upload date: please check',
  manual: 'entered by you',
};

/** How the figures were checked: by the document's own arithmetic, or by a second reading. */
function VerificationNote({ rec }: { rec: Rec }) {
  const v = rec.extraction.verification;
  if (!v) return null;
  const first = shortName(v.firstModel);
  const second = v.secondModel ? shortName(v.secondModel) : undefined;
  if (v.method === 'checks') {
    return (
      <Callout tone="good" title={`Read by ${first}; the document’s own figures confirm it`}>
        {rec.draft?.documentType === 'timesheet' ? 'Each month’s pay is on its sheet, to the penny, and every sheet with pay on it was read.' : 'The balances, totals or holdings on the document add up with what was read.'}
      </Callout>
    );
  }
  // Nothing found is a reading like any other: both readers found nothing to record.
  if (!rec.draft?.sections.length && !rec.draft?.figures.length && second && !v.error && !v.disagreements.length) {
    return (
      <Callout tone="good" title={`Read twice: ${first} and ${second} both found nothing to record`}>
        A document with nothing to record is read by a second model before it is believed.
      </Callout>
    );
  }
  if (v.error) {
    return (
      <Callout tone="warn" title={`Read by ${first}; the second reading failed`}>
        {v.error}. Check every figure against the document.
      </Callout>
    );
  }
  return (
    <Callout tone={v.disagreements.length ? 'warn' : 'good'} title={v.disagreements.length ? `Read twice: ${first} and ${second} disagreed on ${plural(v.disagreements.length, 'figure')}` : `Read twice: ${first} and ${second} agreed on every figure`}>
      <div className="text-ink-2">Why it was read twice: {v.reasons.slice(0, 3).join('; ')}{v.reasons.length > 3 ? '…' : ''}.</div>
      {v.disagreements.length > 0 && (
        <>
          <div className="mt-1 text-ink-2">{v.kept === 'second' ? second : first}’s reading is shown; the rows they differed on are marked below.</div>
          <ul className="sensitive mt-1 list-disc pl-4 text-ink-3">
            {v.disagreements.slice(0, 8).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      )}
    </Callout>
  );
}

const shortName = (model: string) => {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() : model;
};

function DocumentViewer({ rec }: { rec: Rec }) {
  const [zoom, setZoom] = useState(false);
  const url = `/api/imports/${rec.id}/file`;
  const isSheet = /spreadsheet|ms-excel/.test(rec.document.mediaType);
  const isText = !isSheet && !rec.document.mediaType.startsWith('image/') && rec.document.mediaType !== 'application/pdf';
  const text = useApi<string>(['import-file', rec.id], isText ? `/imports/${rec.id}/file` : null);
  const [sheetName, setSheetName] = useState('');
  const sheet = useApi<{ sheet: string; sheets: string[]; rows: string[][]; total: number }>(['import-table', rec.id, sheetName], isSheet ? `/imports/${rec.id}/table${sheetName ? `?sheet=${encodeURIComponent(sheetName)}` : ''}` : null);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{rec.document.fileName}</span>
        <span className="text-ink-3">{fileSize(rec.document.size)}</span>
        {rec.document.mediaType.startsWith('image/') && (
          <button className="rounded p-1 text-ink-3 hover:bg-panel-2" onClick={() => setZoom((z) => !z)} aria-label={zoom ? 'Fit to width' : 'Actual size'}>
            {zoom ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
        <a href={url} target="_blank" rel="noreferrer" className="rounded p-1 text-ink-3 hover:bg-panel-2" aria-label="Open in new tab">
          <ExternalLink className="size-4" />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-panel-2">
        {rec.document.mediaType.startsWith('image/') ? (
          <img src={url} alt={rec.document.fileName} className={cn('sensitive mx-auto', zoom ? 'max-w-none' : 'w-full')} />
        ) : rec.document.mediaType === 'application/pdf' ? (
          <iframe src={`${url}#view=FitH`} title={rec.document.fileName} className="sensitive h-full min-h-[70dvh] w-full" />
        ) : isSheet ? (
          <div className="sensitive p-2">
            {sheet.data ? (
              <>
                <div className="flex flex-wrap items-center gap-2 px-1 pb-2 text-[11.5px] text-ink-3">
                  {sheet.data.sheets.length > 1 ? (
                    <Select value={sheet.data.sheet} onChange={(e) => setSheetName(e.target.value)} className="h-7 w-auto text-[12px]" aria-label="Sheet">
                      {sheet.data.sheets.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span>Sheet “{sheet.data.sheet}”</span>
                  )}
                  {sheet.data.sheets.length > 1 && <span>{sheet.data.sheets.length} sheets with a table</span>}
                  {sheet.data.total > sheet.data.rows.length ? <span>the first {sheet.data.rows.length} of {sheet.data.total} rows</span> : null}
                </div>
                <table className="border-collapse font-mono text-[11.5px] text-ink-2">
                  <tbody>
                    {sheet.data.rows.map((row, i) => (
                      <tr key={i} className={i === 0 ? 'font-semibold text-ink' : undefined}>
                        {row.map((cell, j) => (
                          <td key={j} className="border border-line px-1.5 py-0.5 whitespace-nowrap">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <span className="text-ink-3">{sheet.error ? sheet.error.message : 'Loading…'}</span>
            )}
          </div>
        ) : (
          <pre className="sensitive p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink-2">{typeof text.data === 'string' ? text.data.split('\n').slice(0, 400).join('\n') : 'Loading…'}</pre>
        )}
      </div>
    </div>
  );
}

const CHECK_ICON = {
  ok: <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" aria-label="Passed" />,
  warn: <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" aria-label="Check this" />,
  info: <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-label="For information" />,
};

/** What was checked on this account's rows, problems first. */
function ChecksPanel({ checks }: { checks: ReviewCheck[] }) {
  if (!checks.length) return null;
  const order = { warn: 0, info: 1, ok: 2 };
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const warnings = checks.filter((c) => c.status === 'warn').length;
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', warnings ? 'border-warn-ink/30 bg-warn-soft/50' : 'border-line bg-panel-2')}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        <ListChecks className="size-4 text-ink-3" /> {warnings ? `${warnings} thing${warnings > 1 ? 's' : ''} to check against the original` : 'Checks passed'}
      </div>
      <ul className="flex flex-col gap-1.5">
        {sorted.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-[12.5px]">
            {CHECK_ICON[c.status]}
            <div className="min-w-0">
              <div className="text-ink">{c.title}</div>
              {c.detail && <div className="sensitive text-ink-3">{c.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A row matched to a recorded payment that knows more about it: what it would fill in, ticked to
 * add it on commit, and what it says differently, which stays as recorded (shared/detail.ts). A
 * line or two under the row, so a statement overlapping an export stays easy to read.
 */
function AddsDetail({ t, currency, onChange }: { t: DraftTransaction; currency: string; onChange: (p: Partial<DraftTransaction>) => void }) {
  const { cats } = useAppData();
  const adds = t.adds!;
  const lines = describeDetail(adds.fields, currency);
  const differs = adds.differs.map(describeDifference);
  const on = adds.include && !t.include;
  return (
    // On a phone the table scrolls sideways: the note stays in view, as wide as the screen.
    <div className={cn('sticky left-3 flex max-w-[calc(100vw-6.5rem)] items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12px] md:max-w-none', on ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-panel-2')}>
      <Checkbox checked={on} disabled={t.include} onChange={(v) => onChange({ adds: { ...adds, include: v }, ...(v ? { include: false } : {}) })} className="mt-px" />
      <div className="min-w-0">
        <span className="font-medium text-ink">{t.status === 'duplicate' ? 'Add to the recorded payment: ' : 'The same payment? Add to it: '}</span>
        <span className="sensitive text-ink-2">
          {lines.map((l, i) => (
            <Fragment key={l.label}>
              {i > 0 && <span className="text-ink-3"> · </span>}
              <span className="text-ink-3">{l.label}</span> {l.value}
            </Fragment>
          ))}
        </span>
        {adds.category && (
          <div className="text-ink-2">
            Its category becomes {adds.category.to ? cats.name(adds.category.to) : 'uncategorised'}
            {adds.category.from ? ` (was ${cats.name(adds.category.from)})` : ''}.
          </div>
        )}
        {differs.length > 0 && (
          <div className="sensitive text-ink-3">
            The record keeps its own {differs.map((d) => `${d.label.toLowerCase()}, “${d.recorded}”`).join('; ')}; this says {differs.map((d) => `“${d.here}”`).join('; ')}.
          </div>
        )}
        {t.include && <div className="text-ink-3">Ticked in as a payment of its own, so nothing is added to the recorded one.</div>}
      </div>
    </div>
  );
}

function TxRow({ t, currency, flags, onChange }: { t: DraftTransaction; currency: string; flags?: string[] | undefined; onChange: (p: Partial<DraftTransaction>) => void }) {
  const [editing, setEditing] = useState(false);
  // A row that fills in a recorded payment is doing something, though it is not recorded again.
  const muted = !t.include && !t.adds?.include;
  const tone = cn(muted ? 'opacity-55' : '', t.status === 'possible_duplicate' || flags?.length ? 'bg-warn-soft/60' : '');
  return (
    <>
      <tr className={cn(tone, t.adds && '[&>td]:border-b-0')}>
        <td className={cn(tableClasses.td, 'w-8')}>
          <Checkbox checked={t.include} onChange={(v) => onChange({ include: v, ...(v && t.adds?.include ? { adds: { ...t.adds, include: false } } : {}) })} />
        </td>
        <td className={cn(tableClasses.td, 'whitespace-nowrap')}>
          {editing ? <Input type="date" value={t.date} onChange={(e) => onChange({ date: e.target.value })} className="h-8 w-36" /> : <span className="tabular text-ink-2">{formatDate(t.date)}</span>}
          {t.detail?.time && <div className="text-[11px] text-ink-3">{t.detail.time}</div>}
        </td>
        <td className={cn(tableClasses.td, 'min-w-[220px]')}>
          {editing ? (
            <Input value={t.description} onChange={(e) => onChange({ description: e.target.value })} className="h-8" />
          ) : (
            <>
              <div className="text-[13px] font-medium text-ink">{t.payee ?? t.description}</div>
              <div className="text-[12px] text-ink-3">{t.description}</div>
            </>
          )}
          {t.status !== 'new' && (
            <div className="mt-0.5">
              <Badge tone={t.status === 'duplicate' ? 'muted' : 'warn'} icon={<Copy className="size-3" />}>
                {t.status === 'duplicate' ? 'Already imported' : 'Possible duplicate'}
              </Badge>
            </div>
          )}
          {t.transferMatch && <div className="mt-0.5"><Badge tone="accent">Links to a transfer</Badge></div>}
          {t.pending && <div className="mt-0.5"><Badge tone="muted">Pending</Badge></div>}
          {t.insideAccount && (
            <div className="mt-0.5" title="The account’s statements count this Space in its balance and list no move to or from it, so recording it would be money in or out they never saw.">
              <Badge tone="muted">Move {t.amount < 0 ? 'to' : 'from'} your Space “{t.insideAccount}”: inside the account</Badge>
            </div>
          )}
          {flags?.map((f) => (
            <div key={f} className="mt-0.5 flex items-center gap-1 text-[11.5px] text-warn-ink">
              <TriangleAlert className="size-3" /> {f}
            </div>
          ))}
        </td>
        <td className={cn(tableClasses.td, 'w-52')}>
          <CategorySelect value={t.category} onChange={(v) => onChange({ category: v, categorisedBy: 'user' })} className="h-8 text-[12.5px]" />
        </td>
        <td className={cn(tableClasses.td, tableClasses.num)}>
          {editing ? (
            <Input value={String(t.amount)} onChange={(e) => onChange({ amount: Number(e.target.value) || 0 })} inputMode="decimal" className="h-8 w-28 text-right" />
          ) : (
            <Money value={t.amount} className={cn('font-medium', t.amount > 0 ? 'text-good-ink' : 'text-ink')} />
          )}
          {t.balanceAfter !== undefined && <div className="text-[11px] text-ink-3"><Money value={t.balanceAfter} /></div>}
        </td>
        <td className={cn(tableClasses.td, 'w-8')}>
          <button className="rounded p-1 text-ink-3 hover:bg-panel-2" onClick={() => setEditing((e) => !e)} aria-label="Edit row">
            <Pencil className="size-3.5" />
          </button>
        </td>
      </tr>
      {t.adds && (
        <tr className={tone}>
          <td colSpan={6} className={cn(tableClasses.td, 'pt-0 md:pl-[3.25rem]')}>
            <AddsDetail t={t} currency={currency} onChange={onChange} />
          </td>
        </tr>
      )}
    </>
  );
}

function SectionEditor({ section, index, total, latest, periodFromRows, onChange }: { section: DraftSection; index: number; total: number; latest: string; periodFromRows: boolean; onChange: (s: DraftSection) => void }) {
  const { data } = useAppData();
  const [showDupes, setShowDupes] = useState(false);
  const set = (patch: Partial<DraftSection>) => onChange({ ...section, ...patch });
  const setTx = (key: string, patch: Partial<DraftTransaction>) => set({ transactions: section.transactions.map((t) => (t.key === key ? { ...t, ...patch } : t)) });
  const target = section.target;
  const targetValue = target.mode === 'existing' ? target.accountId : target.mode === 'new' ? '__new' : '__skip';
  const counts = { new: 0, duplicate: 0, possible_duplicate: 0 };
  for (const t of section.transactions) counts[t.status]++;
  const detailing = section.transactions.filter((t) => t.adds && !t.include).length;
  // Rows matched for certain, whose details can be added all at once; a possible match is yours to judge.
  const certainAdds = section.transactions.filter((t) => t.adds && !t.include && t.status === 'duplicate');
  // Rows already imported are hidden, unless they have details to add.
  const visible = section.transactions.filter((t) => showDupes || t.status !== 'duplicate' || t.adds);
  const type = target.mode === 'existing' ? data.accounts.find((a) => a.id === target.accountId)?.type : target.mode === 'new' ? target.account.type : undefined;
  const market = type ? ACCOUNT_TYPE_META[type].balanceMode === 'market' : false;
  const d = section.detected;
  const suggested = section.suggestedAccountId ? data.accounts.find((a) => a.id === section.suggestedAccountId) : undefined;
  const checks = target.mode === 'skip' ? [] : sectionChecks(section, { accountType: type, latest, periodFromRows });
  // Rows a check is about carry its title, so the problem is visible where it is.
  const flags = new Map<string, string[]>();
  for (const c of checks) if (c.status === 'warn') for (const k of c.rows ?? []) flags.set(k, [...(flags.get(k) ?? []), c.title]);
  // Copies recorded twice, as commit will see them: in the account chosen, and not where you ticked a
  // matching row in as a payment of its own.
  const counted = new Set(section.transactions.flatMap((t) => (t.include && t.duplicateOf ? [t.duplicateOf] : [])));
  const extraCopies = (section.extraCopies ?? []).filter((c) => target.mode === 'existing' && (!c.accountId || c.accountId === target.accountId) && !counted.has(c.keepId) && !counted.has(c.transactionId));

  return (
    <Card
      title={total > 1 ? `Account ${index + 1} of ${total}` : 'Account'}
      description={[d.institutionName, d.accountName, d.accountType ? ACCOUNT_TYPE_META[d.accountType].label : null, d.last4 ? `ending ${d.last4}` : null].filter(Boolean).join(' · ') || 'Details as read from the document'}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Import into" hint={section.matchReason}>
            <Select
              value={targetValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__skip') set({ target: { mode: 'skip' } });
                else if (v === '__new')
                  set({
                    target: {
                      mode: 'new',
                      account: target.mode === 'new' ? target.account : { id: slugify(`${d.institutionName ?? ''} ${d.accountName ?? 'account'}`, data.accounts.map((a) => a.id)), name: d.accountName ?? 'New account', type: d.accountType ?? 'current', currency: section.currency, ...(d.last4 ? { last4: d.last4 } : {}), ...(d.institutionName ? { institutionName: d.institutionName } : {}) },
                    },
                  });
                else set({ target: { mode: 'existing', accountId: v } });
              }}
            >
              <optgroup label="Your accounts">
                {data.accounts
                  .filter((a) => a.status === 'open')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
              {data.accounts.some((a) => a.status === 'closed') && (
                <optgroup label="Closed accounts (for their old statements)">
                  {data.accounts
                    .filter((a) => a.status === 'closed')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.closedOn ? ` (closed ${formatDate(a.closedOn)})` : ''}
                      </option>
                    ))}
                </optgroup>
              )}
              <option value="__new">+ Create a new account</option>
              <option value="__skip">Don’t import this account</option>
            </Select>
          </Field>
          {target.mode === 'skip' && suggested && (
            <Button size="sm" variant="primary" onClick={() => set({ target: { mode: 'existing', accountId: suggested.id } })}>
              Import into {suggested.name}
            </Button>
          )}
        </div>
        {target.mode === 'new' && (
          <div className="grid gap-3 rounded-lg border border-line bg-panel-2 p-3 sm:grid-cols-2">
            <Field label="New account name">
              <Input value={target.account.name} onChange={(e) => set({ target: { ...target, account: { ...target.account, name: e.target.value } } })} />
            </Field>
            <Field label="Type">
              <AccountTypeSelect value={target.account.type} onChange={(t) => set({ target: { ...target, account: { ...target.account, type: t } } })} />
            </Field>
            <Field label="Provider">
              <Input value={target.account.institutionName ?? ''} onChange={(e) => set({ target: { ...target, account: { ...target.account, institutionName: e.target.value, institutionId: undefined } } })} />
            </Field>
            <Field label="Last 4 digits">
              <Input value={target.account.last4 ?? ''} onChange={(e) => set({ target: { ...target, account: { ...target.account, last4: e.target.value.replace(/\D/g, '').slice(0, 6) || undefined } } })} />
            </Field>
            <Field label="Opened on (optional)">
              <Input type="date" value={target.account.openedOn ?? ''} onChange={(e) => set({ target: { ...target, account: { ...target.account, openedOn: e.target.value || undefined } } })} />
            </Field>
            <Field label="Closed on (if it has closed)" hint="Created as a closed account, worth nothing after this day">
              <Input type="date" value={target.account.closedOn ?? ''} onChange={(e) => set({ target: { ...target, account: { ...target.account, closedOn: e.target.value || undefined } } })} />
            </Field>
          </div>
        )}
        {target.mode !== 'skip' && (
          <>
            <div className="rounded-lg border border-line p-3">
              <Checkbox checked={section.recordBalance} onChange={(v) => set({ recordBalance: v })} label={<span className="font-medium text-ink">Record the {market ? 'value' : 'balance'}</span>} />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={market ? 'Value' : 'Balance'} hint={type && ACCOUNT_TYPE_META[type].liability ? 'Money owed is negative' : undefined}>
                  <Input value={section.balance ?? ''} onChange={(e) => set({ balance: e.target.value === '' ? undefined : Number(e.target.value) })} inputMode="decimal" placeholder={section.transactions.length ? 'Balance shown in your app' : ''} />
                </Field>
                <Field label="On" hint={section.balanceDateSource ? DATE_SOURCE_LABEL[section.balanceDateSource] : undefined} error={section.balanceDateSource === 'upload' ? 'The date could not be read; set the date the screenshot was taken' : undefined}>
                  <Input type="date" value={section.balanceDate ?? ''} onChange={(e) => set({ balanceDate: e.target.value, balanceDateSource: 'manual' })} />
                </Field>
                {(['contributions', 'gain', 'bonusToDate', 'taxYearContributions', 'cash', 'availableBalance', 'creditLimit', 'annualIncome'] as const)
                  .filter((k) => section[k] !== undefined)
                  .map((k) => (
                    <Field key={k} label={{ contributions: 'Total paid in', gain: 'Growth (as shown)', bonusToDate: 'LISA bonus received', taxYearContributions: 'Paid in this tax year', cash: 'Uninvested cash', availableBalance: 'Available', creditLimit: 'Credit limit', annualIncome: 'Income per year' }[k]}>
                      <Input value={section[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? undefined : Number(e.target.value) })} inputMode="decimal" />
                    </Field>
                  ))}
              </div>
              {section.transactions.length > 0 && section.balance === undefined && !market && (
                <Callout tone="accent" className="mt-3">
                  This export has no balance. Add the balance your app shows (and its date) so this account’s history can be rebuilt accurately.
                </Callout>
              )}
            </div>
            <ChecksPanel checks={checks} />
            {section.transactions.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[13px] text-ink-2">
                    <span className="font-semibold text-ink">{plural(counts.new, 'new transaction')}</span>
                    {counts.duplicate > 0 && <span> · {counts.duplicate} already imported</span>}
                    {counts.possible_duplicate > 0 && <span className="text-warn-ink"> · {counts.possible_duplicate} possible duplicates, check them</span>}
                    {detailing > 0 && <span> · {detailing === 1 ? '1 knows more about a recorded payment' : `${detailing} know more about recorded payments`}</span>}
                    {section.periodStart && section.periodEnd && <span className="text-ink-3"> · {formatDate(section.periodStart)} – {formatDate(section.periodEnd)}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {certainAdds.length > 1 && (
                      <Checkbox
                        checked={certainAdds.every((t) => t.adds!.include)}
                        indeterminate={certainAdds.some((t) => t.adds!.include) && !certainAdds.every((t) => t.adds!.include)}
                        onChange={(v) => set({ transactions: section.transactions.map((t) => (certainAdds.includes(t) ? { ...t, adds: { ...t.adds!, include: v } } : t)) })}
                        label="Add what they show to the recorded payments"
                      />
                    )}
                    {counts.duplicate > 0 && <Checkbox checked={showDupes} onChange={setShowDupes} label="Show already imported" />}
                  </div>
                </div>
                <div className="max-h-[60dvh] overflow-auto rounded-lg border border-line">
                  <table className={tableClasses.table}>
                    <thead className="sticky top-0 z-10 bg-panel">
                      <tr>
                        <th className={tableClasses.th}>
                          <Checkbox
                            checked={visible.every((t) => t.include)}
                            indeterminate={visible.some((t) => t.include) && !visible.every((t) => t.include)}
                            onChange={(v) => set({ transactions: section.transactions.map((t) => (visible.includes(t) ? { ...t, include: v, ...(v && t.adds?.include ? { adds: { ...t.adds, include: false } } : {}) } : t)) })}
                          />
                        </th>
                        <th className={tableClasses.th}>Date</th>
                        <th className={tableClasses.th}>Description</th>
                        <th className={tableClasses.th}>Category</th>
                        <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
                        <th className={tableClasses.th} />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((t) => (
                        <TxRow key={t.key} t={t} currency={section.currency} flags={flags.get(t.key)} onChange={(p) => setTx(t.key, p)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {extraCopies.length > 0 && (
              <Callout tone="warn" title={`${plural(extraCopies.length, 'payment')} recorded twice`}>
                <p className="mb-2">This account has {extraCopies.length === 1 ? 'it' : 'them'} twice, and this document shows {extraCopies.length === 1 ? 'it' : 'each'} once. A ticked copy is taken away when you commit; the other stays.</p>
                <ul className="flex flex-col gap-2">
                  {extraCopies.map((c) => (
                    <li key={c.transactionId}>
                      <Checkbox
                        checked={c.remove}
                        onChange={(v) => set({ extraCopies: section.extraCopies!.map((x) => (x.transactionId === c.transactionId ? { ...x, remove: v } : x)) })}
                        label={
                          <span>
                            Take away the copy “{c.description}”, {formatDate(c.date)}, <Money value={c.amount} className="tabular" />
                            {c.fromFile ? ` (from ${c.fromFile})` : ''}
                          </span>
                        }
                      />
                      <div className="ml-6 text-[12px] text-ink-3">{c.sameBalance ? 'Both copies show the same balance after them: the same payment.' : 'It is recorded more times than this document shows it: check it is not a second payment before taking it away.'}</div>
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {section.holdings.length > 0 && (
              <div>
                <Checkbox checked={section.recordHoldings} onChange={(v) => set({ recordHoldings: v })} label={<span className="font-medium text-ink">Record {plural(section.holdings.length, 'holding')}</span>} />
                <table className={cn(tableClasses.table, 'mt-2')}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>Holding</th>
                      <th className={cn(tableClasses.th, 'text-right')}>Units</th>
                      <th className={cn(tableClasses.th, 'text-right')}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.holdings.map((h, i) => (
                      <tr key={i}>
                        <td className={tableClasses.td}>
                          {h.name}
                          <div className="text-[12px] text-ink-3">{[h.isin, h.sedol, h.ticker, h.assetClass].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>{h.units ?? '—'}</td>
                        <td className={cn(tableClasses.td, tableClasses.num)}>
                          <Money value={h.value} currency={h.currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function FiguresEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  // A timesheet's earned pay has its own card (EarnedEditor).
  const shown = draft.figures.filter((f) => f.kind !== 'earned_pay');
  if (!shown.length) return null;
  const set = (key: string, patch: Partial<Draft['figures'][number]>) => onChange({ ...draft, figures: draft.figures.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  // Who paid, as one name per payer on the document: renaming it renames it on all its figures.
  const payers = [...new Set(shown.flatMap((f) => (f.payer ? [f.payer] : [])))];
  const rename = (from: string, to: string) => {
    const name = to.trim();
    if (name && name !== from) onChange({ ...draft, figures: draft.figures.map((f) => (f.payer === from ? { ...f, payer: name } : f)) });
  };
  return (
    <Card title="Tax figures" description="Standalone figures for Self Assessment (P60, interest certificates, pension statements)">
      {payers.length > 0 && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          {payers.map((p) => (
            <Field key={p} label={payers.length > 1 ? `Paid by (${p})` : 'Paid by'} hint="Give an employer the name its P60 has: payslips and P60s under different names count as different jobs">
              <Input defaultValue={p} onBlur={(e) => rename(p, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename(p, e.currentTarget.value)} />
            </Field>
          ))}
        </div>
      )}
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th className={tableClasses.th} />
            <th className={tableClasses.th}>What</th>
            <th className={tableClasses.th}>Label on document</th>
            <th className={tableClasses.th}>Tax year</th>
            <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((f) => (
            <tr key={f.key} className={f.include ? '' : 'opacity-55'}>
              <td className={tableClasses.td}>
                <Checkbox checked={f.include} onChange={(v) => set(f.key, { include: v })} />
              </td>
              <td className={tableClasses.td}>
                <Select value={f.kind} onChange={(e) => set(f.key, { kind: e.target.value as typeof f.kind })} className="h-8 text-[12.5px]">
                  {FIGURE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
                {f.duplicateOf && <Badge tone="muted">already stored</Badge>}
              </td>
              <td className={tableClasses.td}>
                {f.label}
                {f.payer && payers.length > 1 && <div className="text-[12px] text-ink-3">{f.payer}</div>}
                {f.taxCode && <div className="text-[12px] text-ink-3">Tax code {f.taxCode}</div>}
              </td>
              <td className={tableClasses.td}>
                <Input value={f.taxYear ?? ''} onChange={(e) => set(f.key, { taxYear: e.target.value || undefined })} placeholder="2025/26" className="h-8 w-24" />
              </td>
              <td className={cn(tableClasses.td, tableClasses.num)}>
                <Input value={String(f.amount)} onChange={(e) => set(f.key, { amount: Number(e.target.value) || 0 })} inputMode="decimal" className="h-8 w-28 text-right" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * A timesheet's earned pay, period by period, and the payroll that pays it: the employer as its
 * payslips name it, whose payslips its months are matched to (FORMULAS.md §17, "Earned pay").
 */
function EarnedEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const earned = draft.figures.filter((f) => f.kind === 'earned_pay');
  const stored = useApi<Figure[]>(['figures'], earned.length ? '/figures' : null);
  if (!earned.length) return null;
  const set = (key: string, patch: Partial<Draft['figures'][number]>) => onChange({ ...draft, figures: draft.figures.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  const payers = [...new Set(earned.map((f) => f.payer ?? ''))];
  // Payrolls: the employers your payslips name.
  const payrolls = [...new Set((stored.data ?? []).filter((f) => f.kind === 'gross_pay' && f.periodStart && f.payer).map((f) => f.payer!))].sort();
  const link = (payer: string, paidBy: string) => onChange({ ...draft, figures: draft.figures.map((f) => (f.kind === 'earned_pay' && (f.payer ?? '') === payer ? { ...f, paidBy: paidBy || undefined } : f)) });
  const days = (v: number | undefined) => (v === undefined ? '—' : String(Math.round(v * 100) / 100));
  return (
    <Card title="Work and pay earned" description="Pay for work on a timesheet, before it is paid. It is not income until a payslip pays it, so it counts in no tax year; until then the overview shows it as pending, beside your estate rather than in it.">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        {payers.map((p) => {
          const paidBy = earned.find((f) => (f.payer ?? '') === p)?.paidBy ?? '';
          const options = [...new Set([...payrolls, ...(paidBy ? [paidBy] : [])])].filter((x) => x !== p);
          return (
            <Field key={p} label={payers.length > 1 ? `Paid through (${p || 'no name'})` : 'Paid through'} hint="The employer as its payslips name it: these months are matched to its payslips">
              <Select value={paidBy} onChange={(e) => link(p, e.target.value)}>
                <option value="">{p ? `${p}, as on the timesheet` : 'Not linked'}</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </Field>
          );
        })}
      </div>
      <div className="overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th} />
              <th className={tableClasses.th}>Work in</th>
              <th className={cn(tableClasses.th, 'text-right')}>Days worked</th>
              <th className={cn(tableClasses.th, 'text-right')}>Holiday</th>
              <th className={cn(tableClasses.th, 'text-right')}>Rate</th>
              <th className={cn(tableClasses.th, 'text-right')}>Earned</th>
            </tr>
          </thead>
          <tbody>
            {earned.map((f) => (
              <tr key={f.key} className={f.include ? '' : 'opacity-55'}>
                <td className={tableClasses.td}>
                  <Checkbox checked={f.include} onChange={(v) => set(f.key, { include: v })} />
                </td>
                <td className={tableClasses.td}>
                  {f.periodEnd ? formatMonth(f.periodEnd) : '—'}
                  <div className="text-[12px] text-ink-3">
                    {[f.work?.role, f.label].filter(Boolean).join(' · ')}
                  </div>
                  {f.duplicateOf && <Badge tone="muted">already stored</Badge>}
                  {f.replaces && (
                    <Badge tone="warn">
                      replaces {money(f.replaces.amount)} from an earlier upload
                    </Badge>
                  )}
                </td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{f.work?.hoursWorked !== undefined && f.work.daysWorked === undefined ? `${days(f.work.hoursWorked)} h` : days(f.work?.daysWorked)}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{days(f.work?.holidayDays)}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>{f.work?.rate !== undefined ? `${money(f.work.rate)} a ${f.work.ratePer ?? 'day'}` : '—'}</td>
                <td className={cn(tableClasses.td, tableClasses.num)}>
                  <Input value={String(f.amount)} onChange={(e) => set(f.key, { amount: Number(e.target.value) || 0 })} inputMode="decimal" className="h-8 w-28 text-right" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * A spreadsheet is read one of two ways: its first table mapped like a CSV, or, when it is not a list
 * of payments (a timesheet, a sheet a month), every sheet read by Claude like a document.
 */
function SheetReadAs({ rec }: { rec: Rec }) {
  const byClaude = rec.extraction.engine === 'claude-cli' || rec.extraction.engine === 'claude-api';
  const redo = useApiMutation(() => api(`/imports/${rec.id}/reprocess`, { body: { readAs: byClaude ? 'columns' : 'document' } }));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-4 py-2.5 text-[12.5px] text-ink-2">
      <span className="min-w-0 flex-1">{byClaude ? `Every sheet was read by Claude, as this spreadsheet is not a list of payments.` : 'Its first table is read as a list of payments, column by column.'}</span>
      <Button size="sm" variant="secondary" loading={redo.isPending} onClick={() => redo.mutate(undefined)}>
        {byClaude ? 'Map its columns instead' : 'Read it with Claude instead'}
      </Button>
      {redo.error && <span className="w-full text-bad-ink">{redo.error.message}</span>}
    </div>
  );
}

const ROLE_LABELS: [keyof CsvProfile['columns'], string][] = [
  ['date', 'Date'],
  ['amount', 'Amount (signed)'],
  ['debit', 'Money out'],
  ['credit', 'Money in'],
  ['balance', 'Balance'],
  ['currency', 'Currency'],
  ['category', 'Bank category'],
  ['type', 'Type'],
  ['reference', 'Reference'],
  ['time', 'Time'],
];

/**
 * The columns of a CSV layout no profile knows: asked for before anything is drafted, or, once a
 * draft was made from columns worked out automatically (or chosen), there to change on asking.
 */
function MappingEditor({ rec, onApplied }: { rec: Rec; onApplied?: (r: ImportRecord) => void }) {
  const toast = useToast();
  const mapping = rec.mapping!;
  const drafted = rec.status === 'review';
  const [open, setOpen] = useState(!drafted);
  const [profile, setProfile] = useState<CsvProfile>(mapping.profile);
  const [saveAs, setSaveAs] = useState('');
  const apply = useApiMutation(() => api<ImportRecord>(`/imports/${rec.id}/mapping`, { body: { profile, ...(saveAs.trim() ? { saveAs: saveAs.trim() } : {}) } }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: 'Mapping applied' });
      setOpen(false);
      onApplied?.(r);
    },
  });
  const setCol = (role: keyof CsvProfile['columns'], value: string) => {
    const columns = { ...profile.columns } as Record<string, unknown>;
    if (role === 'description') columns.description = value ? [value] : [];
    else if (value) columns[role] = value;
    else delete columns[role];
    setProfile({ ...profile, columns: columns as CsvProfile['columns'] });
  };
  const [title, description] = !drafted
    ? ['Tell me what the columns mean', 'This CSV layout isn’t recognised. Map it once and save it; next time it imports automatically.']
    : /auto-detected/.test(rec.extraction.detail ?? '')
      ? ['Columns worked out from the file', 'This CSV layout isn’t recognised, so its columns were worked out automatically. If the signs or dates are wrong, change them here; save them and the next file like it imports this way.']
      : ['The columns you chose', 'Change them here if the rows still look wrong; save them and the next file like it imports this way.'];
  return (
    <Card
      title={title}
      description={description}
      padded={open}
      actions={
        !open && (
          <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setOpen(true)}>
            Change
          </Button>
        )
      }
    >
      {open && (
        <>
          <div className="mb-4 overflow-x-auto rounded-lg border border-line">
            <table className={tableClasses.table}>
              <thead>
                <tr>
                  {mapping.headers.map((h, i) => (
                    <th key={i} className={tableClasses.th}>
                      {h || `(column ${i + 1})`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mapping.sample.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} className={cn(tableClasses.td, 'sensitive whitespace-nowrap')}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Description">
              <Select value={profile.columns.description[0] ?? ''} onChange={(e) => setCol('description', e.target.value)}>
                <option value="">—</option>
                {mapping.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </Field>
            {ROLE_LABELS.map(([role, label]) => (
              <Field key={role} label={label}>
                <Select value={(profile.columns[role] as string | undefined) ?? ''} onChange={(e) => setCol(role, e.target.value)}>
                  <option value="">—</option>
                  {mapping.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
            <Field label="Date format">
              <Select value={profile.dateOrder} onChange={(e) => setProfile({ ...profile, dateOrder: e.target.value as CsvProfile['dateOrder'] })}>
                <option value="DMY">Day/Month/Year (UK)</option>
                <option value="MDY">Month/Day/Year (US)</option>
                <option value="YMD">Year-Month-Day</option>
                <option value="auto">Work it out</option>
              </Select>
            </Field>
            <Field label="Amount signs">
              <Select value={profile.amountSign} onChange={(e) => setProfile({ ...profile, amountSign: e.target.value as CsvProfile['amountSign'] })}>
                <option value="normal">Money out is negative</option>
                <option value="inverted">Money out is positive (card style)</option>
              </Select>
            </Field>
            <Field label="Save as (optional)" hint="e.g. the bank’s name">
              <Input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
            </Field>
          </div>
          {apply.error && <Callout tone="bad" className="mt-3">{apply.error.message}</Callout>}
          <div className="mt-4 flex justify-end">
            <Button variant="primary" loading={apply.isPending} disabled={!profile.columns.date || !profile.columns.description.length || !(profile.columns.amount || profile.columns.debit || profile.columns.credit)} onClick={() => apply.mutate(undefined)}>
              Apply mapping
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function Retry({ rec }: { rec: Rec }) {
  const [engine, setEngine] = useState('auto');
  const [model, setModel] = useState('');
  const sheetRead = /spreadsheet|ms-excel/.test(rec.document.mediaType) && (rec.extraction.engine === 'claude-cli' || rec.extraction.engine === 'claude-api');
  const retry = useApiMutation(() => api(`/imports/${rec.id}/reprocess`, { body: { engine, ...(model ? { model } : {}), ...(sheetRead ? { readAs: 'document' } : {}) } }));
  const isDoc = rec.document.mediaType.startsWith('image/') || rec.document.mediaType === 'application/pdf' || sheetRead;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {isDoc && (
        <>
          <Field label="Engine">
            <Select value={engine} onChange={(e) => setEngine(e.target.value)} className="h-8 w-40 text-[13px]">
              <option value="auto">Default</option>
              <option value="claude-cli">Claude (CLI login)</option>
              <option value="claude-api">Claude API</option>
              <option value="ocr">Offline OCR</option>
            </Select>
          </Field>
          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)} className="h-8 w-32 text-[13px]">
              <option value="">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="fable">Fable</option>
            </Select>
          </Field>
        </>
      )}
      <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={retry.isPending} onClick={() => retry.mutate(undefined)}>
        {isDoc ? 'Read again' : 'Parse again'}
      </Button>
      {retry.error && <span className="text-[12px] text-bad-ink">{retry.error.message}</span>}
    </div>
  );
}

export default function Review() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi<Rec>(['import', id], `/imports/${id}`, { refetchInterval: 4000 });
  const rereads = useApi<{ current: string }>(['rereads'], '/imports/rereads');
  const rec = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (rec?.draft && (!draft || !dirty)) setDraft(rec.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.draft, rec?.updatedAt]);
  const commit = useApiMutation(() => api<ImportRecord>(`/imports/${id}/commit`, { body: draft as unknown as Record<string, unknown> }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: `Committed: ${r.result?.transactionsAdded ?? 0} transactions${r.result?.transactionsDetailed?.length ? `, details on ${plural(r.result.transactionsDetailed.length, 'recorded payment')}` : ''}${r.result?.balancesAdded ? ', balance' : ''}${r.result?.holdingsAdded ? ', holdings' : ''}` });
      void navigate('/import');
    },
    // Rows another import recorded meanwhile are marked on the server's copy: show that one.
    onError: (e) => {
      if (e.status === 409) setDirty(false);
    },
  });
  const saveDraft = useApiMutation(() => api(`/imports/${id}/draft`, { method: 'PUT', body: draft as unknown as Record<string, unknown> }), { onSuccess: () => setDirty(false) });
  const discard = useApiMutation(() => api(`/imports/${id}`, { method: 'DELETE' }), { onSuccess: () => void navigate('/import') });
  const dismiss = useApiMutation(() => api<ImportRecord>(`/imports/${id}/dismiss`, { method: 'POST' }), {
    onSuccess: (r) => {
      toast({ tone: 'good', text: `${r.document.fileName} filed with your documents; nothing recorded` });
      void navigate('/import');
    },
  });
  const summary = useMemo(() => {
    if (!draft) return '';
    const n = draft.sections.filter((s) => s.target.mode !== 'skip').reduce((s, sec) => s + sec.transactions.filter((t) => t.include).length, 0);
    const b = draft.sections.filter((s) => s.target.mode !== 'skip' && s.recordBalance && s.balance !== undefined).length;
    const h = draft.sections.filter((s) => s.target.mode !== 'skip' && s.recordHoldings && s.holdings.length).length;
    const f = draft.figures.filter((x) => x.include && x.kind !== 'earned_pay').length;
    const w = draft.figures.filter((x) => x.include && x.kind === 'earned_pay').length;
    const d = draft.sections.filter((s) => s.target.mode === 'existing').reduce((s, sec) => s + sec.transactions.filter((t) => !t.include && t.adds?.include).length, 0);
    return [n ? plural(n, 'transaction') : '', d ? `details on ${plural(d, 'recorded payment')}` : '', b ? plural(b, 'balance') : '', h ? 'holdings' : '', f ? plural(f, 'tax figure') : '', w ? `earned pay for ${plural(w, 'month')}` : ''].filter(Boolean).join(', ') || 'nothing';
  }, [draft]);

  if (q.error) return <ErrorNote error={q.error} />;
  if (!rec) return <Loading />;
  const committed = rec.status === 'committed';
  const filed = committed ? rec.result?.nothingNew : undefined;
  const nothingNew = rec.status === 'review' ? rec.nothingNew : undefined;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/import" className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" /> Import
        </Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold text-ink">{rec.document.fileName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            {importStatus(rec)}
            {rec.extraction.engine && <span>read by {rec.extraction.engine === 'csv' ? `CSV parser (${rec.extraction.detail})` : rec.extraction.engine}{rec.extraction.model ? ` · ${rec.extraction.model}` : ''}</span>}
            {rec.extraction.durationMs !== undefined && <span>· {(rec.extraction.durationMs / 1000).toFixed(1)}s</span>}
            {rec.extraction.costUsd !== undefined && <span>· ~${rec.extraction.costUsd.toFixed(3)}</span>}
            {draft?.confidence && <Badge tone={draft.confidence === 'high' ? 'good' : draft.confidence === 'medium' ? 'neutral' : 'warn'}>{draft.confidence} confidence</Badge>}
          </div>
        </div>
        {!committed && (
          <div className="flex flex-wrap items-center gap-2">
            <Retry rec={rec} />
            <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} loading={discard.isPending} onClick={() => confirm('Discard this import? The file is removed from the work area.') && discard.mutate(undefined)}>
              Discard
            </Button>
          </div>
        )}
      </div>

      {(rec.status === 'processing' || rec.status === 'queued') && (
        <Card>
          <div className="flex items-center gap-3 py-6 text-[14px] text-ink-2">
            <LoaderCircle className="size-5 animate-spin text-accent" />
            Reading the document… This usually takes 10 to 60 seconds. You can leave this page; it will be waiting on the Import page.
          </div>
        </Card>
      )}
      {rec.status === 'failed' && (
        <Callout tone="bad" title="Couldn’t read this file">
          {rec.extraction.error}
          <div className="mt-1 text-ink-3">Try reading it again, perhaps with another engine or model, or discard it.</div>
        </Callout>
      )}
      {filed && (
        <Callout tone="neutral" title={`Filed ${rec.committedAt ? formatDate(rec.committedAt.slice(0, 10)) : ''}: nothing new`}>
          {filed} The document is kept with your other documents; nothing was recorded from it.
        </Callout>
      )}
      {committed && rec.result && !filed && (
        <Callout tone="good" title={`Committed ${rec.committedAt ? formatDate(rec.committedAt.slice(0, 10)) : ''}`}>
          <KeyValue
            items={[
              ['Transactions added', `${rec.result.transactionsAdded} (${rec.result.transactionsSkipped} skipped)`],
              ...(rec.result.transactionsDetailed?.length
                ? [['Details added to recorded payments', rec.result.transactionsDetailed.map((t) => `${formatDate(t.date)} ${money(t.amount)} “${t.description}”: ${fieldsInWords(t.added)}`).join('; ')] as [string, string]]
                : []),
              ...(rec.result.transactionsRemoved?.length
                ? [['Recorded twice, taken away', rec.result.transactionsRemoved.map((t) => `${formatDate(t.date)} ${money(t.amount)} “${t.description}”`).join('; ')] as [string, string]]
                : []),
              ['Balances / holdings / figures', `${rec.result.balancesAdded} / ${rec.result.holdingsAdded} / ${rec.result.figuresAdded}`],
              ['Accounts', rec.result.accountIds.map((a) => <Link key={a} to={`/accounts/${a}`} className="mr-2 text-accent hover:underline">{a}</Link>)],
              ['Transactions', <Link to={`/transactions?source=${rec.id}&period=all`} className="text-accent hover:underline">View what was imported</Link>],
            ]}
          />
        </Callout>
      )}

      {committed && !filed && (rec.extraction.engine === 'claude-cli' || rec.extraction.engine === 'claude-api' || (rec.extraction.engine === 'csv' && !/holdings export/.test(rec.extraction.detail ?? ''))) && (
        <div className="mt-4">
          <ReadAgainCard rec={rec} currentVersion={rereads.data?.current ?? null} />
        </div>
      )}
      {nothingNew && <NothingNewPanel nothingNew={nothingNew} onDismiss={() => dismiss.mutate(undefined)} dismissing={dismiss.isPending} error={dismiss.error} />}
      {(rec.status === 'review' || rec.status === 'needs_mapping' || committed || rec.status === 'failed') && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="lg:sticky lg:top-5 lg:h-[calc(100dvh-140px)]">
            <DocumentViewer rec={rec} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {(rec.status === 'needs_mapping' || rec.status === 'review') && /spreadsheet|ms-excel/.test(rec.document.mediaType) && <SheetReadAs rec={rec} />}
            {rec.status === 'needs_mapping' && rec.extraction.warnings.length > 0 && (
              <Callout tone="warn" title="While reading the document">
                <ul className="list-disc pl-4">
                  {rec.extraction.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {(rec.status === 'needs_mapping' || rec.status === 'review') && rec.mapping && (
              <MappingEditor
                rec={rec}
                // The draft is made again from the new columns, replacing any unsaved changes.
                onApplied={(r) => {
                  if (r.draft) setDraft(r.draft);
                  setDirty(false);
                }}
              />
            )}
            {draft && (
              <>
                <VerificationNote rec={rec} />
                {rec.extraction.warnings.length > 0 && (
                  <Callout tone="warn" title="While reading the document">
                    <ul className="list-disc pl-4">
                      {rec.extraction.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </Callout>
                )}
                {draft.notes.length > 0 && (
                  <Callout tone="neutral" title="Notes from reading the document">
                    <ul className="list-disc pl-4">
                      {draft.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </Callout>
                )}
                {draft.sections.length === 0 && !draft.figures.length && !nothingNew && !filed && (
                  <Callout tone="warn" title="Nothing was found to record">
                    {draft.nothingToRecord ? `${draft.nothingToRecord} ` : ''}Check the document: if it does hold figures, read it again with another model; if not, discard it.
                  </Callout>
                )}
                {draft.sections.map((s, i) => (
                  <SectionEditor
                    key={s.key}
                    section={s}
                    index={i}
                    total={draft.sections.length}
                    latest={rec.createdAt.slice(0, 10)}
                    periodFromRows={draft.documentType === 'csv_export'}
                    onChange={(next) => {
                      setDirty(true);
                      setDraft({ ...draft, sections: draft.sections.map((x) => (x.key === next.key ? next : x)) });
                    }}
                  />
                ))}
                <FiguresEditor
                  draft={draft}
                  onChange={(d) => {
                    setDirty(true);
                    setDraft(d);
                  }}
                />
                <EarnedEditor
                  draft={draft}
                  onChange={(d) => {
                    setDirty(true);
                    setDraft(d);
                  }}
                />
                {draft.ocrText && (
                  <details className="rounded-xl border border-line bg-panel p-4">
                    <summary className="cursor-pointer text-[13px] font-medium text-ink-2">Recognised text (offline OCR)</summary>
                    {draft.candidates && (
                      <div className="mt-2 text-[12.5px] text-ink-3">
                        Amounts found: {draft.candidates.amounts.slice(0, 20).map((a) => money(a)).join(', ')}
                      </div>
                    )}
                    <pre className="sensitive mt-2 max-h-80 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-ink-2">{draft.ocrText}</pre>
                  </details>
                )}
                {!committed && rec.status === 'review' && (!nothingNew || dirty) && (
                  <div className="no-print sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-lg">
                    <div className="text-[13px] text-ink-2">
                      <Info className="mr-1 inline size-4 text-accent" />
                      Will save <span className="font-semibold text-ink">{summary}</span>
                    </div>
                    <div className="flex gap-2">
                      {dirty && (
                        <Button size="sm" loading={saveDraft.isPending} onClick={() => saveDraft.mutate(undefined)}>
                          Save for later
                        </Button>
                      )}
                      <Button variant="primary" loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
                        Commit
                      </Button>
                    </div>
                    {commit.error && <div className="w-full text-[12.5px] text-bad-ink">{commit.error.message}</div>}
                  </div>
                )}
                {committed && <StatusBadge status="good">This import is committed; edit the data from the account or transaction pages.</StatusBadge>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
