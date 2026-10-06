import { Archive, ArrowLeft, CircleCheck, Copy, CopyCheck, ExternalLink, Info, ListChecks, LoaderCircle, Maximize2, Minimize2, Pencil, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import type { DraftLinkView, ImportView, NothingNewView } from '../../shared/api';
import { formatDate, formatMonth } from '../../shared/dates';
import { describeDetail, describeDifference, fieldsInWords } from '../../shared/detail';
import { sectionChecks, type ReviewCheck } from '../../shared/review';
import { headlineApplies, RATE_NAMES } from '../../shared/terms';
import { FIGURE_KINDS, type CsvProfile, type Draft, type DraftJob, type DraftSection, type DraftTransaction, type Employment, type ExtractedHmrc, type Figure, type ImportRecord, type PayslipLine, type PayslipYtdKey, type Settings as SettingsT } from '../../shared/schema';
import { CLAUDE_MODELS, INFERENCE_ALIASES, isInferenceAlias, resolveTask } from '../../shared/tasks';
import { AccountTypeSelect } from '../components/AccountForms';
import { CategorySelect } from '../components/TransactionList';
import { Badge, Button, Callout, Card, Checkbox, type ClickModifiers, ErrorNote, Field, IconButton, Input, KeyValue, Loading, Money, NumberInput, Select, StatusBadge, tableClasses, useToast } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, fileSize, money, plural } from '../lib/format';
import { nextSelection, type Anchor } from '../lib/selection';
import { useShiftHold } from '../lib/useSelection';
import { importStatus } from './Import';
import { ReadAgainCard } from '../components/ReadAgain';
import { limitName, RatesList } from '../components/Terms';
import { SessionsLink } from '../components/SessionsLink';
import { LinkButton, LinkLine, withServerLinks } from '../components/DraftLinks';

type Rec = ImportView;

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
  // One of HMRC's pages: read from its own text on this machine, the same way every time.
  if (rec.extraction.engine === 'govuk') {
    return (
      <Callout tone={rec.draft?.confidence === 'high' ? 'good' : 'warn'} title="One of HMRC’s pages, read from its own text on this machine">
        {rec.draft?.confidence === 'high' ? 'No agent was used. Where the page prints a total, the rows add up to it.' : 'No agent was used, but something on it did not add up: check the notes and the page.'}
      </Callout>
    );
  }
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
      {v.byClaude && <div className="mt-1 text-ink-2">Both readings by the local model failed a check, so Claude read it too (Settings → Models lets checking fall back to Claude); its reading is the second one here.</div>}
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
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  // The local model, by its alias: "vision-extract" or "vision-extract, thinking".
  const [alias, thinking] = model.split(', ');
  return isInferenceAlias(alias) ? `the local model${alias === 'vision-extract' ? '' : ` (${alias})`}${thinking ? ', thinking' : ''}` : model;
};

/** Read by a model (the local one or Claude), not parsed by a reader of this app. */
const byModel = (engine: string | undefined) => engine === 'inference' || engine === 'claude-cli' || engine === 'claude-api';

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

function TxRow({ t, currency, flags, onChange, onTick, linking }: { t: DraftTransaction; currency: string; flags?: string[] | undefined; onChange: (p: Partial<DraftTransaction>) => void; onTick: (mods: ClickModifiers) => void; linking: Linking }) {
  const [editing, setEditing] = useState(false);
  // A row that fills in a recorded payment is doing something, though it is not recorded again.
  const muted = !t.include && !t.adds?.include;
  const tone = cn(muted ? 'opacity-55' : '', t.status === 'possible_duplicate' || flags?.length ? 'bg-warn-soft/60' : '');
  return (
    <>
      {/* Shift-clicking ticks a range, so it must not select the table's text. */}
      <tr className={cn(tone, t.adds && '[&>td]:border-b-0')} onMouseDown={(e) => e.shiftKey && e.preventDefault()}>
        <td className={cn(tableClasses.td, 'w-8')}>
          <Checkbox checked={t.include} onChange={(_, mods) => onTick(mods)} ariaLabel="Record this row" />
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
          <LinkLine importId={linking.importId} row={t} view={linking.views?.[t.key]} onChanged={linking.onChanged} />
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
          <CategorySelect value={t.category} onChange={(v) => onChange({ category: v, categorisedBy: 'user' })} className="h-8 text-[12.5px]" direction={t.amount > 0 ? 'in' : 'out'} />
        </td>
        <td className={cn(tableClasses.td, tableClasses.num)}>
          {editing ? (
            <NumberInput signed value={t.amount} onValue={(v) => onChange({ amount: v ?? 0 })} className="h-8 w-28 text-right" />
          ) : (
            <Money value={t.amount} className={cn('font-medium', t.amount > 0 ? 'text-good-ink' : 'text-ink')} />
          )}
          {t.balanceAfter !== undefined && <div className="text-[11px] text-ink-3"><Money value={t.balanceAfter} /></div>}
        </td>
        <td className={cn(tableClasses.td, 'w-8')}>
          <div className="flex flex-col items-center gap-0.5">
            <button className="rounded p-1 text-ink-3 hover:bg-panel-2" onClick={() => setEditing((e) => !e)} aria-label="Edit row">
              <Pencil className="size-3.5" />
            </button>
            {linking.editable && <LinkButton importId={linking.importId} row={t} linked={Boolean(linking.views?.[t.key])} onLinked={linking.onChanged} />}
          </div>
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

/** What a section's rows need to show and change their transfer links (components/DraftLinks.tsx). */
interface Linking {
  importId: string;
  views: Record<string, DraftLinkView> | undefined;
  /** Waiting for review: links can change. */
  editable: boolean;
  onChanged: (r: ImportRecord) => void;
}

function SectionEditor({ section, index, total, latest, periodFromRows, onChange, linking }: { section: DraftSection; index: number; total: number; latest: string; periodFromRows: boolean; onChange: (s: DraftSection) => void; linking: Linking }) {
  const { data } = useAppData();
  const [showDupes, setShowDupes] = useState(false);
  const set = (patch: Partial<DraftSection>) => onChange({ ...section, ...patch });
  const setTx = (key: string, patch: Partial<DraftTransaction>) => set({ transactions: section.transactions.map((t) => (t.key === key ? { ...t, ...patch } : t)) });
  // Another account chosen: its rows are checked again against that account, as which are recorded
  // there already decides which are ticked. Shown at once, then replaced by the server's check.
  const retarget = (next: DraftSection['target']) => {
    const moved = { ...section, target: next };
    onChange(moved);
    if (next.mode === 'skip' || !linking.editable) return;
    void api<DraftSection>(`/imports/${linking.importId}/sections/redraft`, { body: { section: moved } as unknown as Record<string, unknown> })
      .then(onChange)
      .catch(() => undefined);
  };
  // Ticking rows in and out with Shift and Ctrl/⌘, as in the transactions list (lib/selection.ts).
  const holdOf = useShiftHold();
  const anchor = useRef<Anchor | undefined>(undefined);
  const target = section.target;
  const targetValue = target.mode === 'existing' ? target.accountId : target.mode === 'new' ? '__new' : '__skip';
  const counts = { new: 0, duplicate: 0, possible_duplicate: 0 };
  for (const t of section.transactions) counts[t.status]++;
  const detailing = section.transactions.filter((t) => t.adds && !t.include).length;
  // Rows matched for certain, whose details can be added all at once; a possible match is yours to judge.
  const certainAdds = section.transactions.filter((t) => t.adds && !t.include && t.status === 'duplicate');
  // Rows already imported are hidden, unless they have details to add.
  const visible = section.transactions.filter((t) => showDupes || t.status !== 'duplicate' || t.adds);
  const tick = (key: string, mods: ClickModifiers) => {
    const included = new Set(section.transactions.filter((t) => t.include).map((t) => t.key));
    const next = nextSelection({ selected: included, anchor: anchor.current }, visible.map((t) => t.key), key, mods, holdOf(mods));
    anchor.current = next.anchor;
    set({
      transactions: section.transactions.map((t) => {
        const v = next.selected.has(t.key);
        // Recorded as a payment of its own, a row adds nothing to the payment it matched.
        return v === t.include ? t : { ...t, include: v, ...(v && t.adds?.include ? { adds: { ...t.adds, include: false } } : {}) };
      }),
    });
  };
  const type = target.mode === 'existing' ? data.accounts.find((a) => a.id === target.accountId)?.type : target.mode === 'new' ? target.account.type : undefined;
  const market = type ? ACCOUNT_TYPE_META[type].balanceMode === 'market' : false;
  const d = section.detected;
  // A document that does not print its period (an export, a screenshot of a list) covers its rows'
  // span; the range you chose can widen it (docs/FORMULAS.md §3).
  const rowDates = section.transactions.map((t) => t.date).sort();
  const [rowsFrom, rowsTo] = [rowDates[0] ?? '', rowDates.at(-1) ?? ''];
  const coverable = !market && !section.fromSchedule && rowDates.length > 0 && (periodFromRows || !section.periodStart);
  const suggested = section.suggestedAccountId ? data.accounts.find((a) => a.id === section.suggestedAccountId) : undefined;
  const into = target.mode === 'existing' ? data.accounts.find((a) => a.id === target.accountId) : target.mode === 'new' ? target.account : undefined;
  const checks = target.mode === 'skip' ? [] : sectionChecks(section, { accountType: type, latest, periodFromRows, openedOn: into?.openedOn, closedOn: into?.closedOn });
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
                  retarget({
                    mode: 'new',
                    account: target.mode === 'new' ? target.account : { id: slugify(`${d.institutionName ?? ''} ${d.accountName ?? 'account'}`, data.accounts.map((a) => a.id)), name: d.accountName ?? 'New account', type: d.accountType ?? 'current', currency: section.currency, ...(d.last4 ? { last4: d.last4 } : {}), ...(d.institutionName ? { institutionName: d.institutionName } : {}) },
                  });
                else retarget({ mode: 'existing', accountId: v });
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
            <Button size="sm" variant="primary" onClick={() => retarget({ mode: 'existing', accountId: suggested.id })}>
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
        {section.fromSchedule && target.mode !== 'skip' && (
          <Callout tone="neutral">These rows are the payments its schedule says were made, not a statement of the account: they add to what you owe, and cover none of its days. Its balance comes from its own statements.</Callout>
        )}
        {target.mode !== 'skip' && (
          <>
            <div className={cn('rounded-lg border border-line p-3', section.fromSchedule && 'hidden')}>
              <Checkbox checked={section.recordBalance} onChange={(v) => set({ recordBalance: v })} label={<span className="font-medium text-ink">Record the {market ? 'value' : 'balance'}</span>} />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={market ? 'Value' : 'Balance'} hint={type && ACCOUNT_TYPE_META[type].liability ? 'Money owed is negative' : undefined}>
                  <NumberInput signed value={section.balance} onValue={(v) => set({ balance: v })} placeholder={section.transactions.length ? 'Balance shown in your app' : ''} />
                </Field>
                <Field label="On" hint={section.balanceDateSource ? DATE_SOURCE_LABEL[section.balanceDateSource] : undefined} error={section.balanceDateSource === 'upload' ? 'The date could not be read; set the date the screenshot was taken' : undefined}>
                  <Input type="date" value={section.balanceDate ?? ''} onChange={(e) => set({ balanceDate: e.target.value, balanceDateSource: 'manual' })} />
                </Field>
                {(['contributions', 'gain', 'bonusToDate', 'taxYearContributions', 'cash', 'availableBalance', 'annualIncome'] as const)
                  .filter((k) => section[k] !== undefined)
                  .map((k) => (
                    <Field key={k} label={{ contributions: 'Total paid in', gain: 'Growth (as shown)', bonusToDate: 'LISA bonus received', taxYearContributions: 'Paid in this tax year', cash: 'Uninvested cash', availableBalance: 'Available', annualIncome: 'Income per year' }[k]}>
                      <NumberInput signed={k === 'gain' || k === 'availableBalance'} value={section[k]} onValue={(v) => set({ [k]: v })} />
                    </Field>
                  ))}
              </div>
              {section.transactions.length > 0 && section.balance === undefined && !market && (
                <Callout tone="accent" className="mt-3">
                  This export has no balance. Add the balance your app shows (and its date) so this account’s history can be rebuilt accurately.
                </Callout>
              )}
            </div>
            {(section.creditLimit !== undefined || section.interestRate !== undefined || section.terms) && (
              <div className="rounded-lg border border-line p-3">
                <div className="text-[13px] font-medium text-ink">Its terms</div>
                <div className="text-[12.5px] text-ink-3">Kept as the account’s terms{section.balanceDate ?? section.periodEnd ? ` on ${formatDate((section.balanceDate ?? section.periodEnd)!)}` : ''}, whether or not the {market ? 'value' : 'balance'} is recorded.</div>
                {(section.creditLimit !== undefined || section.interestRate !== undefined) && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {section.creditLimit !== undefined && (
                      <Field label={limitName(type)}>
                        <NumberInput value={section.creditLimit} onValue={(v) => set({ creditLimit: v })} />
                      </Field>
                    )}
                    {section.interestRate !== undefined && (
                      <Field label={`${RATE_NAMES[headlineApplies(type ?? 'current')]} (% a year)`}>
                        <NumberInput value={section.interestRate} onValue={(v) => set({ interestRate: v })} />
                      </Field>
                    )}
                  </div>
                )}
                {section.terms && (section.terms.rates.length > 0 || section.terms.minimumPayment !== undefined) && (
                  <div className="mt-2">
                    <RatesList terms={section.terms} type={type} now={section.balanceDate ?? section.periodEnd} />
                  </div>
                )}
              </div>
            )}
            <ChecksPanel checks={checks} />
            {coverable && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="It covers from (optional)"
                  hint={`It doesn’t print its period, so it counts from its first row, ${formatDate(rowsFrom)}. Give the first day of the range you exported, if earlier.`}
                  error={section.coversFrom && section.coversFrom > rowsFrom ? `It has rows from ${formatDate(rowsFrom)}` : undefined}
                >
                  <Input type="date" max={rowsFrom} value={section.coversFrom ?? ''} onChange={(e) => set({ coversFrom: e.target.value || undefined })} />
                </Field>
                <Field
                  label="To (optional)"
                  hint={`Its last row is ${formatDate(rowsTo)}. Give the last day of the range, if later.`}
                  error={section.coversTo && section.coversTo < rowsTo ? `It has rows up to ${formatDate(rowsTo)}` : section.coversTo && section.coversTo > latest ? 'That’s after it was uploaded' : undefined}
                >
                  <Input type="date" min={rowsTo} max={latest} value={section.coversTo ?? ''} onChange={(e) => set({ coversTo: e.target.value || undefined })} />
                </Field>
              </div>
            )}
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
                            onChange={(v) => {
                              anchor.current = undefined;
                              set({ transactions: section.transactions.map((t) => (visible.includes(t) ? { ...t, include: v, ...(v && t.adds?.include ? { adds: { ...t.adds, include: false } } : {}) } : t)) });
                            }}
                            ariaLabel="Record every row shown"
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
                        <TxRow key={t.key} t={t} currency={section.currency} flags={flags.get(t.key)} onChange={(p) => setTx(t.key, p)} onTick={(mods) => tick(t.key, mods)} linking={linking} />
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
      {/* On a phone the label and tax year go under what it is, so the table fits. */}
      <div className="overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th} />
              <th className={tableClasses.th}>What</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Label on document</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Tax year</th>
              <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const label = (
                <>
                  {f.label}
                  {f.payer && payers.length > 1 && <div className="text-[12px] text-ink-3">{f.payer}</div>}
                  {f.taxCode && <div className="text-[12px] text-ink-3">Tax code {f.taxCode}</div>}
                </>
              );
              const year = <Input value={f.taxYear ?? ''} onChange={(e) => set(f.key, { taxYear: e.target.value || undefined })} placeholder="2025/26" className="h-8 w-24" aria-label="Tax year" />;
              return (
                <tr key={f.key} className={f.include ? '' : 'opacity-55'}>
                  <td className={cn(tableClasses.td, 'align-top sm:align-middle')}>
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
                    <div className="mt-1 flex flex-col gap-1 text-[12.5px] sm:hidden">
                      <div>{label}</div>
                      {year}
                    </div>
                  </td>
                  <td className={cn(tableClasses.td, 'hidden sm:table-cell')}>{label}</td>
                  <td className={cn(tableClasses.td, 'hidden sm:table-cell')}>{year}</td>
                  <td className={cn(tableClasses.td, tableClasses.num, 'align-top sm:align-middle')}>
                    <NumberInput value={f.amount} onValue={(v) => set(f.key, { amount: v ?? 0 })} className="h-8 w-24 text-right sm:w-28" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const YTD_LABELS: Record<PayslipYtdKey, string> = {
  gross: 'Gross pay',
  taxable: 'Taxable pay',
  tax: 'Tax',
  ni: 'National Insurance',
  niEmployer: 'Employer’s NI',
  niablePay: 'Pay for NI',
  pension: 'Pension (you)',
  pensionEmployer: 'Pension (employer)',
  studentLoan: 'Student loan',
  ssp: 'Statutory sick pay',
  smp: 'Statutory maternity pay',
  taxCredit: 'Tax credit',
};

function PayslipLines({ title, lines, total }: { title: string; lines: PayslipLine[]; total?: number | undefined }) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-ink-3">{title}</div>
      <ul className="flex flex-col gap-0.5 text-[13px]">
        {lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span className="min-w-0 truncate text-ink-2">
              {l.label}
              {l.quantity !== undefined && l.rate !== undefined && <span className="text-ink-3"> ({l.quantity} × {money(l.rate)})</span>}
            </span>
            <span className="tabular">{money(l.amount)}</span>
          </li>
        ))}
        {!lines.length && <li className="text-ink-3">None</li>}
        {total !== undefined && (
          <li className="mt-1 flex justify-between gap-3 border-t border-line pt-1 font-medium">
            <span>Total</span>
            <span className="tabular">{money(total)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * A payslip read in full: its lines, totals, codes and year-to-date column, kept beside its tax
 * figures (docs/DATA_FORMAT.md, payslips.jsonl).
 */
function PayslipEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  if (!draft.payslips?.length) return null;
  const set = (key: string, include: boolean) => onChange({ ...draft, payslips: draft.payslips!.map((p) => (p.key === key ? { ...p, include } : p)) });
  return (
    <>
      {draft.payslips.map((d) => {
        const p = d.record;
        const facts = [
          p.periodLabel ?? (p.periodEnd ? formatMonth(p.periodEnd) : ''),
          p.periodNumber ? `month ${p.periodNumber}` : '',
          `paid ${formatDate(p.payDate)}`,
          p.taxCode ? `code ${p.taxCode}${p.cumulative === false ? ' M1' : ''}` : '',
          p.niLetter ? `NI letter ${p.niLetter}` : '',
          p.payrollNumber ? `payroll no. ${p.payrollNumber}` : '',
          p.payMethod ?? '',
          p.department ?? '',
        ].filter(Boolean);
        const ytd = (Object.keys(YTD_LABELS) as PayslipYtdKey[]).filter((k) => p.yearToDate[k] !== undefined);
        const employer = [p.employerCosts.ni !== undefined ? `NI ${money(p.employerCosts.ni)}` : '', p.employerCosts.pension !== undefined ? `pension ${money(p.employerCosts.pension)}` : ''].filter(Boolean);
        return (
          <Card key={d.key} title="The payslip in full" description={`${p.employer}${p.otherNames.length ? ` (also ${p.otherNames.join(', ')})` : ''}: ${facts.join(' · ')}. Kept beside its tax figures, with the lines that are not tax figures (a cycle scheme, say) and its year to date.`}>
            <label className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
              <Checkbox checked={d.include} onChange={(v) => set(d.key, v)} />
              Keep the payslip in full
              {d.duplicateOf && <Badge tone="muted">already stored</Badge>}
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <PayslipLines title="Payments" lines={p.payments} total={p.totals.payments} />
              <PayslipLines title="Deductions" lines={p.deductions} total={p.totals.deductions} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
              {p.totals.net !== undefined && (
                <span>
                  Net pay <span className="font-semibold text-ink tabular">{money(p.totals.net)}</span>
                </span>
              )}
              {p.totals.taxable !== undefined && <span>Taxable pay {money(p.totals.taxable)}</span>}
              {p.totals.nonTaxable ? <span>Not taxed {money(p.totals.nonTaxable)}</span> : null}
              {employer.length > 0 && <span>Employer paid: {employer.join(', ')}</span>}
            </div>
            {ytd.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[12px] font-medium text-ink-3">Year to date</div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
                  {ytd.map((k) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-ink-2">{YTD_LABELS[k]}</dt>
                      <dd className="tabular">{money(p.yearToDate[k])}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}

/**
 * Every other labelled value the document prints (extract-12, "read everything"): kept with the
 * import, by the heading it is under, though nothing reads it yet.
 */
function PrintedValues({ printed }: { printed: { section?: string | undefined; label: string; value: string }[] }) {
  if (!printed.length) return null;
  const sections = [...new Set(printed.map((p) => p.section ?? ''))];
  return (
    <details className="rounded-xl border border-line bg-panel">
      <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-2">Everything else it prints ({printed.length})</summary>
      <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
        <p className="text-[12.5px] text-ink-3">Kept with the import as printed, so nothing on the document is lost.</p>
        {sections.map((section) => (
          <div key={section}>
            {section && <div className="mb-1 text-[12px] font-medium text-ink-3">{section}</div>}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
              {printed
                .filter((p) => (p.section ?? '') === section)
                .map((p, i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <dt className="min-w-0 text-ink-2">{p.label}</dt>
                    <dd className="text-right [overflow-wrap:anywhere]">{p.value}</dd>
                  </div>
                ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
  );
}

/** One HMRC record in a line: what it is, its date, what it says, and its amount when it has one. */
function describeHmrc(r: ExtractedHmrc): { what: string; date: string; detail: string; amount?: number } {
  const code = (c: string, cumulative: boolean) => `${c}${cumulative ? '' : ' week 1/month 1'}`;
  switch (r.type) {
    case 'payment':
      return { what: 'Payment reported', date: r.payDate, detail: `${r.employer ?? ''}: tax ${money(r.tax)}${r.ni !== undefined ? `, NI ${money(r.ni)}` : ''}`, amount: r.taxablePay };
    case 'tax-code':
      return { what: 'Tax code', date: r.date, detail: `${r.employer ?? ''}: ${code(r.code, r.cumulative)}` };
    case 'employment':
      return {
        what: 'Job details',
        date: r.asOf,
        detail: [
          r.employer,
          r.payeReference ? `PAYE ${r.payeReference}` : '',
          r.payrollNumber ? `payroll no. ${r.payrollNumber}` : '',
          r.startedOn ? `started ${formatDate(r.startedOn)}` : '',
          r.endedOn ? `ended ${formatDate(r.endedOn)}` : '',
          r.code ? `code ${code(r.code, r.cumulative ?? true)}` : '',
          r.estimatedPay !== undefined ? `HMRC estimates ${money(r.estimatedPay)} for the year` : '',
          r.leavingPay !== undefined ? `P45 pay ${money(r.leavingPay)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'event':
      return { what: 'PAYE account', date: r.date, detail: r.text, ...(r.amount !== undefined ? { amount: r.amount } : {}) };
    case 'settlement':
      return {
        what: `Tax year ${r.taxYear} settled`,
        date: r.asOf,
        detail: `${r.outcome === 'underpaid' ? 'Tax was still owed' : r.outcome === 'overpaid' ? 'Tax was overpaid' : 'Nothing owed either way'}${r.calculatedOn ? ` (worked out ${formatDate(r.calculatedOn)})` : ''}${r.payments.length ? `; paid ${r.payments.map((x) => `${money(x.amount)} on ${formatDate(x.date)} by ${x.how}`).join(', ')}` : ''}; ${money(r.outstanding)} outstanding`,
        ...(r.amount !== undefined ? { amount: r.amount } : {}),
      };
    case 'ni-year':
      return {
        what: `NI record ${r.taxYear}`,
        date: r.asOf,
        detail: `${r.status === 'full' ? 'Full year' : r.status === 'not-full' ? 'Not a full year' : r.status === 'not-available' ? 'Not available yet' : (r.text ?? '')}${r.contributions.length ? `: ${r.contributions.map((c) => `${c.kind}${c.amount !== undefined ? ` ${money(c.amount)}` : ''}`).join(', ')}` : ''}${r.voluntaryCost !== undefined ? `; a voluntary contribution of ${money(r.voluntaryCost)}${r.payBy ? ` by ${formatDate(r.payBy)}` : ''} fills it` : ''}`,
      };
    case 'state-pension-forecast':
      return {
        what: 'State Pension forecast',
        date: r.asOf,
        detail: `${money(r.weekly)} a week${r.payableFrom ? ` from ${formatDate(r.payableFrom)}` : ''}${r.qualifyingYears !== undefined ? `; ${r.qualifyingYears} qualifying years${r.yearsNeeded !== undefined ? ` (${r.yearsNeeded} needed for any)` : ''}` : ''}${r.maximum ? '; the most you can get' : ''}`,
        amount: r.annual,
      };
  }
}

/**
 * The jobs a document is about: each matched to a job of yours (by its PAYE reference, payroll number
 * or a name it has had) or set up as a new one. Choosing another moves all its figures and records.
 */
function JobsEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const jobs = useApi<Employment[]>(['employments'], draft.jobs?.length ? '/employments' : null);
  if (!draft.jobs?.length) return null;
  const set = (key: string, target: DraftJob['target']) => onChange({ ...draft, jobs: draft.jobs!.map((j) => (j.key === key ? { ...j, target, matchedBy: 'you' as const } : j)) });
  const BY = { payeReference: 'its PAYE reference', payrollNumber: 'your payroll number', name: 'a name it has had', hmrc: 'HMRC’s record of a payment with the same pay and tax', you: 'you' } as const;
  return (
    <Card title="Jobs" description="The job of yours each employer on this document is. Its pay figures and HMRC’s records go under it.">
      <div className="flex flex-col gap-3">
        {draft.jobs.map((j) => (
          <div key={j.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
            <div className="text-[13px]">
              <div className="font-medium text-ink">{j.employer}</div>
              <div className="text-[12px] text-ink-3">{[j.payeReference ? `PAYE ${j.payeReference}` : '', j.payrollNumber ? `payroll no. ${j.payrollNumber}` : '', j.matchedBy ? `matched by ${BY[j.matchedBy]}` : 'no job of yours has it'].filter(Boolean).join(' · ')}</div>
            </div>
            <Field label="Is your job">
              <Select
                value={j.target.mode === 'existing' ? j.target.employmentId : 'new'}
                onChange={(e) => set(j.key, e.target.value === 'new' ? { mode: 'new', employment: { id: j.target.mode === 'new' ? j.target.employment.id : j.employer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'job', employer: j.employer } } : { mode: 'existing', employmentId: e.target.value })}
              >
                {(jobs.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.employer}
                    {x.payeReference ? ` (${x.payeReference})` : ''}
                  </option>
                ))}
                <option value="new">A new job: {j.target.mode === 'new' ? j.target.employment.employer : j.employer}</option>
              </Select>
            </Field>
          </div>
        ))}
      </div>
    </Card>
  );
}

const PAYMENT_STATUS_WORDS: Record<string, string> = { paid: 'Paid', due: 'Due', scheduled: 'Expected', awaiting: 'Awaiting confirmation', cancelled: 'Cancelled' };

/**
 * The schedules on this document (docs/INGESTION.md, "Schedules"): each the agreement it records, new
 * or filling in one recorded already, with its payments as the document gives them and the recorded
 * payments they are. Its category is what its payments take: change it here before committing.
 */
function AgreementsEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const { accountName } = useAppData();
  if (!draft.agreements?.length) return null;
  const set = (key: string, patch: Partial<NonNullable<Draft['agreements']>[number]>) => onChange({ ...draft, agreements: draft.agreements!.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  return (
    <Card title="Schedules" description="Payments this document says are due, made or expected, kept as an agreement: its payments take its category as they come, and each is checked against what was paid." padded={false}>
      <div className="divide-y divide-line border-t border-line">
        {draft.agreements.map((d) => {
          const a = d.record;
          const toYou = a.direction === 'in';
          const who = toYou ? `${a.counterparty} pays you${a.accountId ? `, lent through ${accountName(a.accountId)}` : ''}` : a.paidBy ? `${a.paidBy} pays ${a.counterparty} for you${a.accountId ? `, from ${accountName(a.accountId)}` : ''}` : `You pay ${a.counterparty}`;
          const explained = new Map(d.explains.map((e) => [e.index, e]));
          return (
            <div key={d.key} className={cn('px-5 py-4', d.include ? '' : 'opacity-60')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-2.5">
                  <Checkbox checked={d.include} onChange={(v) => set(d.key, { include: v })} />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{a.name}</span>
                    <span className="block text-[12.5px] text-ink-3">
                      {who}
                      {a.total !== undefined && (
                        <>
                          {' '}
                          · <Money value={a.total} /> in all
                        </>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-3">
                      {d.target.mode === 'new' ? (
                        <Badge tone="accent">New agreement</Badge>
                      ) : d.adds && d.adds.payments + d.adds.statuses > 0 ? (
                        <Badge tone="neutral">
                          Fills in the one recorded: {[d.adds.payments ? plural(d.adds.payments, 'new payment') : '', d.adds.statuses ? plural(d.adds.statuses, 'newer status', 'newer statuses') : ''].filter(Boolean).join(', ')}
                        </Badge>
                      ) : (
                        <Badge tone="muted">Recorded already, as it is here</Badge>
                      )}
                    </span>
                  </span>
                </label>
                <div className="w-56 max-w-full">
                  <CategorySelect value={a.category} onChange={(v) => v && set(d.key, { record: { ...a, category: v } })} className="h-8 text-[12.5px]" />
                </div>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>Date</th>
                      <th className={tableClasses.th}>Payment</th>
                      <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Its document says</th>
                      <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.payments.map((p, i) => {
                      const e = explained.get(i);
                      return (
                        <tr key={i}>
                          <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{formatDate(p.due)}</td>
                          <td className={cn(tableClasses.td, 'text-[12.5px]')}>
                            {p.label ?? `Payment ${i + 1}`}
                            {/* On a phone what its document says goes under the payment, so the amount fits. */}
                            {p.status && <div className="text-[12px] text-ink-3 sm:hidden">{PAYMENT_STATUS_WORDS[p.status]}</div>}
                            {e && (
                              <div className="text-[12px] text-good-ink">
                                {toYou ? 'Received' : 'Paid'} {formatDate(e.date)} · {accountName(e.accountId)}
                              </div>
                            )}
                          </td>
                          <td className={cn(tableClasses.td, 'hidden text-[12.5px] text-ink-2 sm:table-cell')}>{p.status ? PAYMENT_STATUS_WORDS[p.status] : ''}</td>
                          <td className={cn(tableClasses.td, tableClasses.num)}>
                            <Money value={p.amount} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {a.details.length > 0 && (
                <details className="mt-2 text-[12.5px]">
                  <summary className="cursor-pointer text-ink-3 hover:text-ink-2">What else it says</summary>
                  <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)]">
                    {a.details.map((x, i) => (
                      <Fragment key={i}>
                        <dt className="text-ink-3">{x.label}</dt>
                        <dd className="text-ink-2">{x.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** HMRC's records on this document: payments, codes, job details, events, settlements, NI years, forecasts. */
function HmrcEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  if (!draft.hmrc?.length) return null;
  const set = (key: string, include: boolean) => onChange({ ...draft, hmrc: draft.hmrc!.map((h) => (h.key === key ? { ...h, include } : h)) });
  return (
    <Card title="HMRC’s records" description="What HMRC’s pages show, kept as HMRC’s own record: each payment an employer reported, tax codes, job details and events, a year settled, your National Insurance record and State Pension forecast." padded={false}>
      {/* On a phone the date goes under what it is, and long names wrap, so the table fits. */}
      <div className="overflow-x-auto">
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th className={tableClasses.th} />
              <th className={tableClasses.th}>What</th>
              <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>Date</th>
              <th className={tableClasses.th}>Says</th>
              <th className={cn(tableClasses.th, 'text-right')}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {draft.hmrc.map((h) => {
              const d = describeHmrc(h.record);
              return (
                <tr key={h.key} className={h.include ? '' : 'opacity-55'}>
                  <td className={tableClasses.td}>
                    <Checkbox checked={h.include} onChange={(v) => set(h.key, v)} />
                  </td>
                  <td className={cn(tableClasses.td, 'sm:whitespace-nowrap')}>
                    {d.what}
                    <div className="text-[12px] whitespace-nowrap text-ink-3 sm:hidden">{formatDate(d.date)}</div>
                    {h.duplicateOf && (
                      <div>
                        <Badge tone="muted">already stored</Badge>
                      </div>
                    )}
                  </td>
                  <td className={cn(tableClasses.td, 'hidden whitespace-nowrap sm:table-cell')}>{formatDate(d.date)}</td>
                  <td className={cn(tableClasses.td, 'text-[12.5px] [overflow-wrap:anywhere]')}>{d.detail}</td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>{d.amount !== undefined ? money(d.amount) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
                  <NumberInput value={f.amount} onValue={(v) => set(f.key, { amount: v ?? 0 })} className="h-8 w-28 text-right" />
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
  const byClaude = byModel(rec.extraction.engine);
  const redo = useApiMutation(() => api(`/imports/${rec.id}/reprocess`, { body: { readAs: byClaude ? 'columns' : 'document' } }));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-4 py-2.5 text-[12.5px] text-ink-2">
      <span className="min-w-0 flex-1">{byClaude ? `Every sheet was read by the agent, as this spreadsheet is not a list of payments.` : 'Its first table is read as a list of payments, column by column.'}</span>
      <Button size="sm" variant="secondary" loading={redo.isPending} onClick={() => redo.mutate(undefined)}>
        {byClaude ? 'Map its columns instead' : 'Read it with the agent instead'}
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

/**
 * A committed import's name, to find it by in History, with its file name under it. You can give
 * your own (Claude never replaces it) or take it away.
 */
function ImportName({ rec }: { rec: Rec }) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | undefined>();
  const save = useApiMutation((text: string | null) => api(`/imports/${rec.id}/label`, { method: 'PUT', body: { text } }), {
    onSuccess: (_r, text) => {
      setEditing(undefined);
      toast({ tone: 'good', text: text ? 'Name saved' : 'Name taken away' });
    },
  });
  const label = rec.label;
  if (editing !== undefined) {
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (editing.trim()) save.mutate(editing.trim());
        }}
      >
        <Input value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={120} autoFocus aria-label="Name" className="w-[min(28rem,80vw)]" />
        <Button size="sm" variant="primary" type="submit" loading={save.isPending} disabled={!editing.trim()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(undefined)}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <h1 className="line-clamp-2 text-[20px] font-semibold text-ink sm:truncate">{label?.text ?? rec.document.fileName}</h1>
        <IconButton label="Rename" className="size-8 shrink-0" onClick={() => setEditing(label?.text ?? '')}>
          <Pencil className="size-3.5" />
        </IconButton>
      </div>
      {label && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
          <span className="truncate">{rec.document.fileName}</span>
          <span>· {label.provenance.setBy === 'owner' ? 'your name for it' : 'named by the agent'}</span>
          <button type="button" className="text-accent hover:underline" onClick={() => save.mutate(null)}>
            {label.provenance.setBy === 'owner' ? 'take your name away' : 'take the name away'}
          </button>
        </div>
      )}
    </>
  );
}

/** Are documents read by the local model (Settings → Models)? */
const readsLocally = (settings: SettingsT) => resolveTask('read-document', settings.models.tasks).engine === 'inference';

/**
 * Read it with Claude now: for when the local model is away or could not read it. It sends the
 * document to Anthropic, so it is a click of yours each time.
 */
function ReadWithClaude({ rec }: { rec: Rec }) {
  const redo = useApiMutation(() => api(`/imports/${rec.id}/reprocess`, { body: { engine: 'claude-cli', interrupt: true } }));
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" loading={redo.isPending} onClick={() => confirm('Read this document with Claude? It is sent to Anthropic.') && redo.mutate(undefined)}>
        Read with Claude instead
      </Button>
      <span className="text-[12px] text-ink-3">Sends this document to Anthropic.</span>
      {redo.error && <span className="text-[12px] text-bad-ink">{redo.error.message}</span>}
    </span>
  );
}

/** A reading under way: how long it takes, and why it waits when the local model cannot take it. */
function Reading({ rec }: { rec: Rec }) {
  const { data } = useAppData();
  const local = readsLocally(data.settings);
  const w = rec.extraction.waiting;
  return (
    <Card>
      <div className="flex items-start gap-3 py-4 text-[14px] text-ink-2">
        <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-accent" />
        <div className="flex flex-col gap-2">
          <div>
            {local
              ? 'Reading the document with the local model, on this machine. That takes a few minutes (half an hour for a long statement), and a second reading, when the checks ask for one, takes as long again.'
              : 'Reading the document… This usually takes 10 to 60 seconds.'}{' '}
            You can leave this page; it will be waiting on the Import page.
          </div>
          {w && (
            <Callout tone="warn" title={`Waiting since ${new Date(w.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}>
              {w.reason}
              {w.until ? `; it says to try again at ${new Date(w.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. It keeps trying for up to 12 hours.
            </Callout>
          )}
          {local && rec.status === 'processing' && <ReadWithClaude rec={rec} />}
        </div>
      </div>
    </Card>
  );
}

function Retry({ rec }: { rec: Rec }) {
  const [engine, setEngine] = useState('auto');
  const [model, setModel] = useState('');
  const sheetRead = /spreadsheet|ms-excel/.test(rec.document.mediaType) && byModel(rec.extraction.engine);
  const retry = useApiMutation(() => api(`/imports/${rec.id}/reprocess`, { body: { engine, ...(model ? { model } : {}), ...(sheetRead ? { readAs: 'document' } : {}) } }));
  const isDoc = rec.document.mediaType.startsWith('image/') || rec.document.mediaType === 'application/pdf' || sheetRead;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {isDoc && (
        <>
          <Field label="Engine">
            <Select
              value={engine}
              onChange={(e) => {
                setEngine(e.target.value);
                setModel('');
              }}
              className="h-8 w-40 text-[13px]"
            >
              <option value="auto">Default</option>
              <option value="inference">Local model</option>
              <option value="claude-cli">Claude (CLI login)</option>
              <option value="claude-api">Claude API</option>
              <option value="ocr">Offline OCR</option>
            </Select>
          </Field>
          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)} className="h-8 w-40 text-[13px]">
              <option value="">Default</option>
              {engine === 'inference'
                ? INFERENCE_ALIASES.filter((a) => a.vision).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))
                : engine !== 'ocr' &&
                  CLAUDE_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m.charAt(0).toUpperCase() + m.slice(1)}
                    </option>
                  ))}
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
  const { data } = useAppData();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi<Rec>(['import', id], `/imports/${id}`, { refetchInterval: 4000 });
  const rereads = useApi<{ current: string }>(['rereads'], '/imports/rereads');
  const rec = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // With changes not yet saved, only links made meanwhile (perhaps from another import's page) come in.
    if (rec?.draft) setDraft(!draft || !dirty ? rec.draft : withServerLinks(draft, rec.draft));
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
  // A filed document, back in review as an import of its own.
  const reopen = useApiMutation(() => api<ImportRecord>(`/imports/${id}/reopen`, { method: 'POST' }), {
    onSuccess: (r) => void navigate(`/import/${r.id}`),
  });
  const summary = useMemo(() => {
    if (!draft) return '';
    const n = draft.sections.filter((s) => s.target.mode !== 'skip').reduce((s, sec) => s + sec.transactions.filter((t) => t.include).length, 0);
    const b = draft.sections.filter((s) => s.target.mode !== 'skip' && s.recordBalance && s.balance !== undefined).length;
    const h = draft.sections.filter((s) => s.target.mode !== 'skip' && s.recordHoldings && s.holdings.length).length;
    const f = draft.figures.filter((x) => x.include && x.kind !== 'earned_pay').length;
    const w = draft.figures.filter((x) => x.include && x.kind === 'earned_pay').length;
    const d = draft.sections.filter((s) => s.target.mode === 'existing').reduce((s, sec) => s + sec.transactions.filter((t) => !t.include && t.adds?.include).length, 0);
    // A forecast with no balance (a State Pension forecast) is recorded as its income per year.
    const p = draft.sections.filter((s) => s.target.mode !== 'skip' && s.annualIncome !== undefined && s.balanceDate && !(s.recordBalance && s.balance !== undefined)).length;
    const r = (draft.hmrc ?? []).filter((x) => x.include).length;
    const ps = (draft.payslips ?? []).filter((x) => x.include).length;
    const ag = (draft.agreements ?? []).filter((x) => x.include).length;
    const used = new Set([...draft.figures, ...(draft.hmrc ?? []), ...(draft.payslips ?? [])].flatMap((x) => (x.include && x.jobKey ? [x.jobKey] : [])));
    const j = (draft.jobs ?? []).filter((x) => x.target.mode === 'new' && used.has(x.key)).length;
    return [n ? plural(n, 'transaction') : '', d ? `details on ${plural(d, 'recorded payment')}` : '', b ? plural(b, 'balance') : '', h ? 'holdings' : '', f ? plural(f, 'tax figure') : '', w ? `earned pay for ${plural(w, 'month')}` : '', p ? plural(p, 'pension forecast') : '', r ? plural(r, 'HMRC record') : '', ps ? `${plural(ps, 'payslip')} in full` : '', ag ? plural(ag, 'schedule') : '', j ? plural(j, 'new job') : ''].filter(Boolean).join(', ') || 'nothing';
  }, [draft]);

  if (q.error) return <ErrorNote error={q.error} />;
  if (!rec) return <Loading />;
  const linking: Linking = {
    importId: rec.id,
    views: rec.links,
    editable: rec.status === 'review',
    // The server keeps the links: take its rows' links into the draft here, keeping unsaved edits.
    onChanged: (r) => {
      setDraft((d) => (d ? withServerLinks(d, r.draft) : (r.draft ?? null)));
    },
  };
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
          {committed ? <ImportName rec={rec} /> : <h1 className="truncate text-[20px] font-semibold text-ink">{rec.document.fileName}</h1>}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            {importStatus(rec)}
            {rec.extraction.engine && <span>read by {rec.extraction.engine === 'csv' ? `CSV parser (${rec.extraction.detail})` : rec.extraction.engine === 'govuk' ? 'the gov.uk page reader' : rec.extraction.engine === 'payslip' ? 'the payslip reader, on this machine' : rec.extraction.engine === 'inference' ? 'the local model, on this machine' : rec.extraction.engine}{rec.extraction.model ? ` · ${rec.extraction.model}` : ''}</span>}
            {rec.extraction.durationMs !== undefined && <span>· {rec.extraction.durationMs >= 120_000 ? `${Math.round(rec.extraction.durationMs / 60_000)} min` : `${(rec.extraction.durationMs / 1000).toFixed(1)}s`}</span>}
            {rec.extraction.costUsd !== undefined && <span>· ~${rec.extraction.costUsd.toFixed(3)}</span>}
            {(byModel(rec.extraction.engine) || rec.status === 'processing' || rec.status === 'failed') && <SessionsLink of={rec.id}>{rec.status === 'processing' ? 'Watch the agent read it' : 'What the agent did'}</SessionsLink>}
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

      {(rec.status === 'processing' || rec.status === 'queued') && <Reading rec={rec} />}
      {rec.status === 'failed' && (
        <Callout tone="bad" title="Couldn’t read this file">
          {rec.extraction.error}
          <div className="mt-1 text-ink-3">Try reading it again, perhaps with another engine or model, or discard it.</div>
          {readsLocally(data.settings) && (
            <div className="mt-2">
              <ReadWithClaude rec={rec} />
            </div>
          )}
        </Callout>
      )}
      {filed && (
        <Callout tone="neutral" title={`Filed ${rec.committedAt ? formatDate(rec.committedAt.slice(0, 10)) : ''}: nothing new`}>
          {filed} The document is kept with your other documents; nothing was recorded from it.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" loading={reopen.isPending} onClick={() => reopen.mutate(undefined)}>
              Open it again
            </Button>
            <span className="text-[12.5px] text-ink-3">Drafted again from its reading as the app would draft it now, to find what it had no place for before. Nothing is read with Claude unless you ask.</span>
          </div>
          {reopen.error && <div className="mt-1 text-[12.5px] text-bad-ink">{reopen.error.message}</div>}
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

      {committed && !filed && (byModel(rec.extraction.engine) || (rec.extraction.engine === 'csv' && !/holdings export/.test(rec.extraction.detail ?? ''))) && (
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
                {draft.sections.length === 0 && !draft.figures.length && !draft.hmrc?.length && !draft.agreements?.length && !nothingNew && !filed && (
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
                    linking={linking}
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
                <PayslipEditor
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
                <JobsEditor
                  draft={draft}
                  onChange={(d) => {
                    setDirty(true);
                    setDraft(d);
                  }}
                />
                <HmrcEditor
                  draft={draft}
                  onChange={(d) => {
                    setDirty(true);
                    setDraft(d);
                  }}
                />
                <AgreementsEditor
                  draft={draft}
                  onChange={(d) => {
                    setDirty(true);
                    setDraft(d);
                  }}
                />
                <PrintedValues printed={rec.extraction.raw?.printed ?? []} />
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
