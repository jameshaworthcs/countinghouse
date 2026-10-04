// Reading a stored document again with the current reader, and what it found different from what
// the import recorded (docs/INGESTION.md, "Reading a stored document again").

import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import type { Reread, RereadRow } from '../../shared/api';
import type { ImportRecord } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, formatDate, money } from '../lib/format';
import { Badge, Button, Callout, Card, StatusBadge, tableClasses } from './ui';
import { SessionsLink } from './SessionsLink';

const KIND: Record<RereadRow['kind'], { label: string; tone: 'good' | 'warn' | 'info' | 'pending' }> = {
  same: { label: 'Same', tone: 'good' },
  changed: { label: 'Read differently', tone: 'warn' },
  added: { label: 'Read now, not recorded', tone: 'info' },
  missing: { label: 'Recorded, not read now', tone: 'pending' },
};

const rowText = (r: { date: string; amount: number; description: string }) => (
  <>
    <span className="whitespace-nowrap">{formatDate(r.date)}</span> · <span className="sensitive tabular">{money(r.amount)}</span>
    <div className="truncate text-[11.5px] text-ink-3">{r.description}</div>
  </>
);

export function ReadAgainCard({ rec, currentVersion }: { rec: ImportRecord; currentVersion: string | null }) {
  const { data } = useAppData();
  const q = useApi<Reread | null>(['reread', rec.id], `/imports/${rec.id}/reread`, { refetchInterval: 4000 });
  const start = useApiMutation(() => api<Reread>(`/imports/${rec.id}/reread`, { method: 'POST' }));
  const apply = useApiMutation((key: string) => api<Reread>(`/imports/${rec.id}/reread/apply`, { body: { key } }));
  const forget = useApiMutation(() => api(`/imports/${rec.id}/reread`, { method: 'DELETE' }));
  // A CSV or spreadsheet is parsed again on this machine: no Claude, so no setting to turn on.
  const parsed = rec.extraction.engine === 'csv';
  const enabled = parsed || data.settings.extraction.rereadDocuments;
  const r = q.data;
  // The prompt's number decides (a local reading adds "+local-N"; a spreadsheet's starts "xlsx-N+").
  const number = (v: string | undefined | null) => Number(/extract-(\d+)/.exec(v ?? '')?.[1] ?? 0);
  const older = currentVersion && rec.extraction.engineVersion && number(rec.extraction.engineVersion) < number(currentVersion);
  const differences = r?.sections.flatMap((s) => s.rows.filter((x) => x.kind !== 'same')) ?? [];
  return (
    <Card
      title="Read it again"
      description={
        parsed
          ? `Parsed on this machine${rec.extraction.detail ? ` (${rec.extraction.detail.replace('auto-detected', 'columns worked out automatically')})` : ''}. Reading it again parses the file with the layout that fits it now and compares each row with what it recorded. Nothing changes until you apply a difference.`
          : `Read with ${rec.extraction.engineVersion ?? 'an earlier reader'}${older ? `; the reader is now ${currentVersion}` : ''}. Reading it again compares the new reading with what was recorded. Nothing changes until you apply a difference.`
      }
      actions={
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={start.isPending || r?.status === 'running'} disabled={!enabled || r?.status === 'running'} onClick={() => start.mutate(undefined)}>
          {r?.status === 'running' ? 'Reading…' : r ? 'Read again' : 'Read it again'}
        </Button>
      }
    >
      {!enabled && (
        <p className="text-[12.5px] text-ink-3">
          Off: reading stored documents again runs the model that reads uploads (Claude’s usage, when that is Claude). Turn it on in <Link to="/settings#extraction" className="text-accent hover:underline">Settings → Models & import</Link>.
        </p>
      )}
      {start.error && <Callout tone="bad">{start.error.message}</Callout>}
      {r?.status === 'failed' && <Callout tone="bad" title="It could not be read again">{r.error}</Callout>}
      {r?.status === 'done' && (
        <div className="flex flex-col gap-3">
          <div className="text-[12.5px] text-ink-2">
            Read {formatDate(r.finishedAt!.slice(0, 10))} with {r.layout ?? r.engineVersion}
            {r.model ? ` (${r.model.replace(/^claude-/, '')})` : ''}
            {r.costUsd ? `, $${r.costUsd.toFixed(2)}` : ''}. {differences.length ? `${differences.length} difference${differences.length === 1 ? '' : 's'}.` : 'Everything it read is as recorded.'}
            {r.engine === 'inference' || r.engine === 'claude-cli' || r.engine === 'claude-api' ? (
              <>
                {' '}
                <SessionsLink of={r.importId}>What the agent did</SessionsLink>
              </>
            ) : null}
          </div>
          {r.notes.map((n) => (
            <Callout key={n} tone="neutral" className="text-[12.5px]">
              {n}
            </Callout>
          ))}
          {r.sections.map((s) => (
            <div key={s.accountId} className="flex flex-col gap-2">
              <div className="text-[13px] font-medium text-ink">{s.accountName}</div>
              {s.balance?.changed && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px]">
                  <span>
                    Balance: recorded {s.balance.stored ? `${money(s.balance.stored.balance)} on ${formatDate(s.balance.stored.date)}` : 'none'}; read now {s.balance.read ? `${money(s.balance.read.balance)} on ${formatDate(s.balance.read.date)}` : 'none'}
                  </span>
                  {s.balance.read && (s.balance.applied ? <Badge tone="muted">Applied</Badge> : <Button size="sm" loading={apply.isPending && apply.variables === `balance:${s.accountId}`} onClick={() => apply.mutate(`balance:${s.accountId}`)}>Use the new reading</Button>)}
                </div>
              )}
              {s.rows.some((x) => x.kind !== 'same') ? (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className={tableClasses.table}>
                    <thead>
                      <tr>
                        <th className={tableClasses.th}>Recorded</th>
                        <th className={tableClasses.th}>Read now</th>
                        <th className={tableClasses.th} />
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows
                        .filter((x) => x.kind !== 'same')
                        .map((x) => (
                          <tr key={x.key}>
                            <td className={cn(tableClasses.td, 'max-w-56')}>{x.stored ? rowText(x.stored) : <span className="text-ink-3">—</span>}</td>
                            <td className={cn(tableClasses.td, 'max-w-56')}>{x.read ? rowText(x.read) : <span className="text-ink-3">—</span>}</td>
                            <td className={cn(tableClasses.td, 'whitespace-nowrap text-right')}>
                              <StatusBadge status={KIND[x.kind].tone}>{x.kind === 'changed' ? `${x.changes!.join(', ')} differ` : KIND[x.kind].label}</StatusBadge>
                              <div className="mt-1">
                                {x.applied ? (
                                  <Badge tone="muted">Applied</Badge>
                                ) : x.kind === 'changed' ? (
                                  <Button size="sm" loading={apply.isPending && apply.variables === x.key} onClick={() => apply.mutate(x.key)}>
                                    Correct it
                                  </Button>
                                ) : x.kind === 'added' ? (
                                  <>
                                    {x.maybe && (
                                      <div className="mb-1 max-w-56 whitespace-normal text-left text-[11.5px] text-warn-ink">
                                        Maybe recorded already: {formatDate(x.maybe.date)}, <span className="sensitive">{money(x.maybe.amount)}</span>, “{x.maybe.description}”
                                      </div>
                                    )}
                                    <Button size="sm" loading={apply.isPending && apply.variables === x.key} onClick={() => apply.mutate(x.key)}>
                                      {x.maybe ? 'Add it anyway' : 'Add it'}
                                    </Button>
                                  </>
                                ) : (
                                  <Link to={`/transactions?accounts=${s.accountId}&period=custom&from=${x.stored!.date}&to=${x.stored!.date}`} className="text-[12px] text-accent hover:underline">
                                    Look at it
                                  </Link>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[12.5px] text-ink-3">{s.rows.length} row{s.rows.length === 1 ? '' : 's'}, all as recorded.</div>
              )}
            </div>
          ))}
          {apply.error && <Callout tone="bad">{apply.error.message}</Callout>}
          <div>
            <Button size="sm" onClick={() => forget.mutate(undefined)}>
              Put this reading away
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface RereadsResponse {
  current: string;
  enabled: boolean;
  older: { id: string; fileName: string; engineVersion: string | null; reason: string | null; committedAt: string | null; reread: Reread['status'] | null }[];
}

/** Import page: committed documents worth reading again (an earlier reader, or a CSV's columns worked out), each a link to read it again. */
export function OlderReadings() {
  const q = useApi<RereadsResponse>(['rereads'], '/imports/rereads');
  const d = q.data;
  if (!d?.older.length) return null;
  const claude = d.older.some((o) => !o.reason);
  return (
    <Card
      title={`${d.older.length} document${d.older.length === 1 ? '' : 's'} worth reading again`}
      description={`Read by an earlier reader (it is now ${d.current}), or a CSV whose columns were worked out automatically. Open one to read it again and compare${claude && !d.enabled ? '; reading PDFs and screenshots again is off in Settings → Models & import' : ''}.`}
      padded={false}
    >
      <details className="border-t border-line">
        <summary className="cursor-pointer px-5 py-2.5 text-[13px] font-medium text-ink-2">Show them</summary>
        <ul className="divide-y divide-line border-t border-line">
          {d.older.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 px-5 py-2 text-[13px]">
              <Link to={`/import/${o.id}`} className="min-w-0 truncate text-accent hover:underline">
                {o.fileName}
              </Link>
              <span className="flex shrink-0 items-center gap-2 text-ink-3">
                {o.reread === 'done' && <Badge tone="neutral">Read again</Badge>}
                {o.reread === 'running' && <Badge tone="neutral">Reading…</Badge>}
                {o.reason ?? o.engineVersion ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
