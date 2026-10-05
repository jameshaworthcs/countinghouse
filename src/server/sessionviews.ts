// What the Claude sessions page shows (routes/sessions.ts): the sessions the app recorded, those
// that ran before transcripts were kept (from what their jobs, imports, re-readings and receipts
// recorded; never a transcript made up after the fact), and agents with your tokens, by their
// requests. For one session: what it produced, linked to where each thing lives, and its rows in
// the audit log.

import { actorName, type AuditActor } from '../shared/audit';
import type { ImportRecord, InsightPage } from '../shared/schema';
import { TOKEN_ACTIVITY_GAP_MS, type SessionDetail, type SessionOutput, type SessionRecord, type SessionSummary, type TokenRequest } from '../shared/sessions';
import { TRIGGER_WORDS, type JobRecord } from './agents/jobs';
import { nowISO } from './fsutil';
import type { AppContext } from './context';
import { shortModel } from './ingest/verify';

const CLAUDE = new Set(['claude-cli', 'claude-api']);
const EARLIER = 'earlier-';
const TOKEN = 'token-';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Before transcripts were kept (records elsewhere keep whole seconds, so the second they began counts as after). */
const before = (iso: string | undefined, since: string) => Boolean(iso) && Date.parse(iso!) < Math.floor(Date.parse(since) / 1000) * 1000;

export function summaryOf(r: SessionRecord): SessionSummary {
  return {
    id: r.id,
    source: 'recorded',
    kind: r.kind,
    title: r.title,
    ...(r.jobKind ? { jobKind: r.jobKind } : {}),
    ...(r.role ? { role: r.role } : {}),
    ...(r.jobId ? { jobId: r.jobId } : {}),
    ...(r.importId ? { importId: r.importId } : {}),
    ...(r.receiptId ? { receiptId: r.receiptId } : {}),
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    engine: r.engine,
    startedBy: actorName(r.startedBy.actor),
    ...(r.startedBy.reason ? { reason: r.startedBy.reason } : {}),
    model: r.modelUsed ?? r.model,
    ...(r.promptVersion ? { promptVersion: r.promptVersion } : {}),
    status: r.status,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    ...(r.fallbackOf ? { fallbackOf: r.fallbackOf } : {}),
    transcript: r.transcript.removed ? 'removed' : r.transcript.truncated ? 'truncated' : 'kept',
  };
}

const TRIGGER_WHO: Record<JobRecord['trigger'], string> = { owner: 'You', agent: 'An agent token', 'post-import': 'The app', schedule: 'The app', stale: 'The app' };

function earlierJob(j: JobRecord): SessionSummary {
  return {
    id: `${EARLIER}${j.id}`,
    source: 'earlier',
    kind: 'job',
    title: j.label,
    jobKind: j.kind,
    jobId: j.id,
    engine: 'claude-cli',
    startedBy: j.requestedBy ? actorName(j.requestedBy) : TRIGGER_WHO[j.trigger],
    reason: TRIGGER_WORDS[j.trigger],
    ...(j.model ? { model: j.model } : {}),
    promptVersion: j.promptVersion,
    status: j.status === 'queued' || j.status === 'running' ? 'failed' : j.status,
    startedAt: j.startedAt ?? j.createdAt,
    ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
    ...(j.durationMs !== undefined ? { durationMs: j.durationMs } : {}),
    ...(j.costUsd !== undefined ? { costUsd: j.costUsd } : {}),
    transcript: 'none',
  };
}

type Reading = NonNullable<import('./store').ImportSummary['reading']>;

function earlierReading(i: { id: string; fileName: string; createdAt: string; engine?: string | undefined; engineVersion?: string | undefined }, r: Reading, by: string): SessionSummary {
  const v = r.verification;
  const checked = v?.method === 'second-reading' && v.secondModel ? `, checked by ${shortModel(v.secondModel)}` : '';
  return {
    id: `${EARLIER}${i.id}`,
    source: 'earlier',
    kind: 'reading',
    title: `Read ${i.fileName}${checked}`,
    importId: i.id,
    engine: i.engine === 'inference' ? 'inference' : i.engine === 'claude-api' ? 'claude-api' : 'claude-cli',
    startedBy: by,
    ...(v?.firstModel || r.model ? { model: v?.firstModel ?? r.model } : {}),
    ...(i.engineVersion ? { promptVersion: i.engineVersion } : {}),
    status: 'succeeded',
    startedAt: r.startedAt ?? i.createdAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    transcript: 'none',
  };
}

const ORIGIN_WORDS: Record<ImportRecord['origin'], string> = { upload: 'Uploaded', inbox: 'Dropped in the inbox folder', cli: 'Queued with npm run import' };

/** Every session the page lists, newest first. */
export async function allSessions(ctx: AppContext): Promise<SessionSummary[]> {
  const since = ctx.sessions.since;
  const recorded = ctx.sessions.list();
  const out: SessionSummary[] = recorded.map(summaryOf);
  // Before transcripts: what each job, import, re-reading and receipt recorded about its run.
  const jobsWithSessions = new Set(recorded.map((r) => r.jobId).filter(Boolean));
  for (const j of ctx.runner?.list() ?? []) {
    if (j.startedAt && before(j.startedAt, since) && !jobsWithSessions.has(j.id)) out.push(earlierJob(j));
  }
  const seen = new Set<string>(recorded.filter((r) => r.kind === 'reading').map((r) => r.importId).filter((x): x is string => Boolean(x)));
  for (const r of ctx.imports.listPending()) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const e = r.extraction;
    if (!CLAUDE.has(e.engine ?? '') || !before(e.startedAt ?? r.createdAt, since)) continue;
    out.push({ ...earlierReading({ id: r.id, fileName: r.document.fileName, createdAt: r.createdAt, engine: e.engine, engineVersion: e.engineVersion }, e, 'The app (reading imports)'), reason: `${ORIGIN_WORDS[r.origin]}: ${r.document.fileName}` });
  }
  for (const i of ctx.store.imports) {
    if (seen.has(i.id) || !i.reading || !CLAUDE.has(i.engine ?? '') || !before(i.reading.startedAt ?? i.createdAt, since)) continue;
    out.push(earlierReading(i, i.reading, 'The app (reading imports)'));
  }
  const rereadsWithSessions = new Set(recorded.filter((r) => r.kind === 'reread').map((r) => r.importId));
  for (const rr of ctx.imports.listRereads()) {
    if (!CLAUDE.has(rr.engine ?? '') || !before(rr.startedAt, since) || rereadsWithSessions.has(rr.importId)) continue;
    const name = ctx.store.imports.find((i) => i.id === rr.importId)?.fileName ?? rr.importId;
    out.push({
      id: `${EARLIER}reread-${rr.importId}`,
      source: 'earlier',
      kind: 'reread',
      title: `Read again ${name}`,
      importId: rr.importId,
      engine: rr.engine === 'claude-api' ? 'claude-api' : 'claude-cli',
      startedBy: 'You',
      reason: 'Read a stored document again, to compare with what was recorded',
      ...(rr.model ? { model: rr.model } : {}),
      ...(rr.engineVersion ? { promptVersion: rr.engineVersion } : {}),
      status: rr.status === 'done' ? 'succeeded' : 'failed',
      startedAt: rr.startedAt,
      ...(rr.finishedAt ? { finishedAt: rr.finishedAt, durationMs: Date.parse(rr.finishedAt) - Date.parse(rr.startedAt) } : {}),
      ...(rr.costUsd !== undefined ? { costUsd: rr.costUsd } : {}),
      transcript: 'none',
    });
  }
  const receiptsWithSessions = new Set(recorded.map((r) => r.receiptId).filter(Boolean));
  for (const rc of ctx.store.receipts) {
    if (receiptsWithSessions.has(rc.id)) continue;
    const at = rc.reading?.at ?? (rc.status === 'failed' ? rc.updatedAt : undefined);
    if (!at || !before(at, since)) continue;
    const t = ctx.store.transaction(rc.transactionId);
    out.push({
      id: `${EARLIER}${rc.id}`,
      source: 'earlier',
      kind: 'receipt',
      title: `Read a receipt${t ? ` for ${t.payee ?? t.description} on ${t.date}` : ''}`,
      receiptId: rc.id,
      engine: 'claude-cli',
      startedBy: 'You',
      ...(rc.reading?.model ? { model: rc.reading.model } : {}),
      ...(rc.reading?.promptVersion ? { promptVersion: rc.reading.promptVersion } : {}),
      status: rc.reading ? 'succeeded' : 'failed',
      startedAt: at,
      ...(rc.reading?.costUsd !== undefined ? { costUsd: rc.reading.costUsd } : {}),
      transcript: 'none',
    });
  }
  out.push(...(await tokenActivity(ctx)).map((a) => a.summary));
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id));
}

// ─── Agents with your tokens ─────────────────────────────────────────────────────────────────────

interface Activity {
  summary: SessionSummary;
  requests: TokenRequest[];
}

/**
 * A token's requests, grouped by the agent's own session when it named one (`X-Agent-Session`: a
 * Claude Code session's id), else in stretches with no gap longer than TOKEN_ACTIVITY_GAP_MS.
 */
export async function tokenActivity(ctx: AppContext, now = Date.now()): Promise<Activity[]> {
  const uses = (await ctx.tokens.recentUses(5000)).reverse();
  const byToken = new Map<string, typeof uses>();
  for (const u of uses) (byToken.get(u.tokenId) ?? byToken.set(u.tokenId, []).get(u.tokenId)!).push(u);
  const tokens = ctx.tokens.list();
  const out: Activity[] = [];
  for (const [tokenId, list] of byToken) {
    const named = new Map<string, typeof uses>();
    const groups: (typeof uses)[] = [];
    for (const u of list) {
      if (u.agentSession) {
        (named.get(u.agentSession) ?? named.set(u.agentSession, []).get(u.agentSession)!).push(u);
        continue;
      }
      const last = groups.at(-1)?.at(-1);
      if (last && Date.parse(u.at) - Date.parse(last.at) <= TOKEN_ACTIVITY_GAP_MS) groups.at(-1)!.push(u);
      else groups.push([u]);
    }
    const token = tokens.find((t) => t.id === tokenId);
    const all: [string | undefined, typeof uses][] = [...[...named.entries()].map(([k, g]): [string, typeof uses] => [k, g]), ...groups.map((g): [undefined, typeof uses] => [undefined, g])];
    for (const [agentSession, g] of all) {
      const first = g[0]!;
      const last = g.at(-1)!;
      const name = token?.name ?? first.name;
      out.push({
        summary: {
          id: agentSession ? `${TOKEN}${tokenId}-cc-${agentSession}` : `${TOKEN}${tokenId}-${Date.parse(first.at)}`,
          source: 'token',
          kind: 'token',
          title: `Agent with the token “${name}”${agentSession ? ` (session ${agentSession.slice(0, 8)})` : ''}`,
          tokenId,
          ...(agentSession ? { agentSession } : {}),
          startedBy: `Agent token “${name}”`,
          reason: `From ${first.from}${token ? `; it can ${token.scopes.join(', ')}` : ''}`,
          status: now - Date.parse(last.at) < TOKEN_ACTIVITY_GAP_MS ? 'running' : 'succeeded',
          startedAt: first.at,
          finishedAt: last.at,
          durationMs: Date.parse(last.at) - Date.parse(first.at),
          requests: {
            total: g.length,
            changes: g.filter((u) => u.method !== 'GET' && u.method !== 'HEAD' && u.status < 400).length,
            refused: g.filter((u) => u.status >= 400).length,
          },
          transcript: 'none',
        },
        requests: g.map((u) => ({ at: u.at, method: u.method, path: u.path, ...(u.query ? { query: u.query } : {}), status: u.status, ...(u.bytes !== undefined ? { bytes: u.bytes } : {}), from: u.from })),
      });
    }
  }
  return out;
}

// ─── One session ─────────────────────────────────────────────────────────────────────────────────

const PAGE_PATHS: Record<InsightPage, string> = { overview: '/', accounts: '/accounts', transactions: '/transactions', spending: '/spending', projections: '/projections', investments: '/investments', tax: '/tax', import: '/import' };

/** What a job produced: the records it wrote, proposals, notes it read, imports it named. */
function jobOutputs(ctx: AppContext, jobId: string): SessionOutput[] {
  const { store } = ctx;
  const job = ctx.runner?.get(jobId);
  const out: SessionOutput[] = [];
  for (const w of job?.written ?? []) {
    if (w.type === 'research') {
      const r = store.research.find((x) => x.id === w.id);
      out.push({ type: 'research', id: w.id, label: r ? `${r.kind}${'instrumentId' in r.subject && r.subject.instrumentId ? ` for ${store.instrument(String(r.subject.instrumentId))?.name ?? r.subject.instrumentId}` : 'institutionId' in r.subject && r.subject.institutionId ? ` for ${store.institution(String(r.subject.institutionId))?.name ?? r.subject.institutionId}` : ''}` : w.id, href: '/assumptions#research' });
    } else if (w.type === 'assumption') {
      const a = store.assumptions.find((x) => x.id === w.id);
      out.push({ type: 'assumption', id: w.id, label: a ? `${a.key} = ${a.value}` : w.id, href: '/assumptions' });
    } else if (w.type === 'insight') {
      const i = store.insights.find((x) => x.id === w.id);
      out.push({ type: 'insight', id: w.id, label: i?.title ?? w.id, href: i ? PAGE_PATHS[i.pages[0]!] : '/', ...(i ? { note: i.status } : {}) });
    } else if (w.type === 'instrument') {
      out.push({ type: 'instrument', id: w.id, label: store.instrument(w.id)?.name ?? w.id, href: '/assumptions#research' });
    } else if (w.type === 'context') {
      out.push({ type: 'what you told the app', id: w.id, label: store.context.find((c) => c.id === w.id)?.statement ?? w.id, href: '/assumptions#about' });
    } else {
      out.push({ type: w.type, id: w.id, label: w.id });
    }
  }
  const proposals = [...ctx.proposals.list().pending.map((v) => v.proposal), ...store.proposals].filter((p) => p.provenance.jobId === jobId);
  for (const p of proposals) out.push({ type: 'proposal', id: p.id, label: p.title, href: `/proposals/${p.id}`, note: p.status });
  for (const n of store.notes.filter((x) => x.jobId === jobId)) out.push({ type: 'note read', id: n.id, label: n.text.length > 120 ? `${n.text.slice(0, 120)}…` : n.text, href: '/assumptions#about', note: `${n.status}${n.proposals?.length ? `, ${plural(n.proposals.length, 'thing')} to confirm` : ''}` });
  for (const i of store.imports.filter((x) => x.label?.provenance.jobId === jobId)) out.push({ type: 'import name', id: i.id, label: i.label!.text, href: `/import/${i.id}`, note: i.fileName });
  if (job?.summary) out.push({ type: 'outcome', label: job.summary });
  if (job?.error) out.push({ type: 'error', label: job.error });
  return out;
}

function extractionWords(x: ImportRecord['extraction']['raw']): string {
  if (!x) return 'nothing read';
  const rows = x.accounts.reduce((n, a) => n + a.transactions.length, 0);
  const holdings = x.accounts.reduce((n, a) => n + (a.holdings?.length ?? 0), 0);
  return [x.documentType, plural(x.accounts.length, 'account'), plural(rows, 'row'), holdings ? plural(holdings, 'holding') : '', x.figures?.length ? plural(x.figures.length, 'figure') : ''].filter(Boolean).join(', ');
}

/** What a reading of an import produced: its extraction, the check, the draft and what was committed. */
async function readingOutputs(ctx: AppContext, s: SessionSummary, later: boolean): Promise<SessionOutput[]> {
  const id = s.importId!;
  const r = ctx.imports.getPending(id) ?? (await ctx.store.readImport(id));
  if (!r) return [{ type: 'import', id, label: 'The import is no longer here: it was discarded before it was committed' }];
  const href = `/import/${id}`;
  const out: SessionOutput[] = [{ type: 'import', id, label: r.label?.text ?? r.document.fileName, href, note: r.status }];
  const v = r.extraction.verification;
  const role = s.role ?? 'first';
  if (later) out.push({ type: 'extraction', label: 'Replaced: the document was read again later, and that reading is the import’s now', href });
  else if (s.source === 'earlier') {
    out.push({ type: 'extraction', label: extractionWords(r.extraction.raw), href, note: 'the reading kept' });
    if (r.extraction.alternative) out.push({ type: 'extraction', label: extractionWords(r.extraction.alternative), href, note: 'the other reading, not kept (stored for audit)' });
  } else {
    const kept = v?.method !== 'second-reading' || v.kept === role;
    out.push({ type: 'extraction', label: extractionWords(kept ? r.extraction.raw : r.extraction.alternative), href, note: kept ? 'kept: the import’s reading' : 'not kept: stored beside it for audit' });
  }
  if (v && !later) {
    out.push({
      type: 'verification',
      label: v.method === 'second-reading' ? `Checked by a second reading (${shortModel(v.firstModel)}, then ${shortModel(v.secondModel ?? '')}): ${v.disagreements.length ? plural(v.disagreements.length, 'disagreement') : 'they agreed'}; the ${v.kept} was kept` : 'Checked by the document’s own arithmetic',
      href,
      ...(v.reasons.length || v.error ? { note: [...v.reasons, ...(v.error ? [`second reading failed: ${v.error}`] : [])].join('; ') } : {}),
    });
  }
  if (r.draft && !later) {
    const rows = r.draft.sections.reduce((n, sec) => n + sec.transactions.length, 0);
    out.push({ type: 'draft', label: `${plural(r.draft.sections.length, 'section')}, ${plural(rows, 'row')}${r.draft.figures.length ? `, ${plural(r.draft.figures.length, 'figure')}` : ''}`, href, note: r.status === 'committed' ? 'reviewed and committed' : r.status === 'discarded' ? 'discarded' : 'waiting for your review' });
  }
  if (r.result && !later) {
    const x = r.result;
    out.push({ type: 'committed', label: x.nothingNew ? 'Filed: nothing new to record' : [plural(x.transactionsAdded, 'transaction'), plural(x.balancesAdded, 'balance'), x.holdingsAdded ? plural(x.holdingsAdded, 'holding') : '', x.figuresAdded ? plural(x.figuresAdded, 'figure') : ''].filter(Boolean).join(', ') + ' added', href });
  }
  return out;
}

/** What a question's session produced: the steps it took and its answer, an inference (Ask). */
function askOutputs(ctx: AppContext, s: SessionSummary): SessionOutput[] {
  const r = ctx.sessions.get(s.id);
  const found = ctx.ask?.turnOf(r?.conversationId, r?.turnId);
  if (!found) return s.kind === 'job' ? [{ type: 'answer', label: 'Asked before conversations were kept: the answer was not kept' }] : [{ type: 'answer', label: 'The conversation is no longer kept (past the retention period)' }];
  const { conversation, turn } = found;
  const href = `/ask/${conversation.id}#${turn.id}`;
  const out: SessionOutput[] = [];
  // Its own steps: Claude standing in starts again, so a turn's steps are its last session's.
  if (turn.sessions.at(-1) === s.id) for (const st of turn.steps) out.push({ type: `step ${st.n}: ${st.tool}`, label: st.error ? `${st.why}: failed (${st.error})` : `${st.why}: ${st.summary ?? ''}`, ...(st.href ? { href: st.href } : {}), note: 'computed by the app' });
  if (turn.answer && turn.sessions.at(-1) === s.id) out.push({ type: 'answer', id: turn.id, label: turn.answer.answer, href, note: `${turn.answer.confidence} confidence${turn.answer.cannotAnswer ? '; it could not answer' : ''}; an inference, not a computed figure` });
  else if (turn.error && s.status !== 'running') out.push({ type: turn.status === 'cancelled' ? 'stopped' : 'error', label: turn.error, href });
  if (turn.feedback?.wrong) out.push({ type: 'marked wrong', label: turn.feedback.note || 'You marked the answer wrong', href });
  return out;
}

async function outputsOf(ctx: AppContext, s: SessionSummary, siblings: SessionSummary[]): Promise<SessionOutput[]> {
  if (s.kind === 'ask' || (s.kind === 'job' && s.jobKind === 'ask')) return askOutputs(ctx, s);
  if (s.kind === 'job' && s.jobId) return jobOutputs(ctx, s.jobId);
  if (s.kind === 'reading' && s.importId) {
    // A later first reading (read again before review) replaced this one's.
    const later = s.source === 'recorded' && siblings.some((x) => x.kind === 'reading' && x.source === 'recorded' && x.role === 'first' && Date.parse(x.startedAt) > Date.parse(s.startedAt) && (s.role !== 'first' || x.id !== s.id));
    return readingOutputs(ctx, s, later);
  }
  if (s.kind === 'reread' && s.importId) {
    const rr = ctx.imports.getReread(s.importId);
    const href = `/import/${s.importId}`;
    if (!rr) return [{ type: 'comparison', label: 'Put away: the comparison is no longer kept', href }];
    const changed = rr.sections.reduce((n, sec) => n + sec.rows.filter((row) => row.kind !== 'same').length + (sec.balance?.changed ? 1 : 0), 0);
    return [{ type: 'comparison', label: rr.status === 'done' ? `${plural(rr.sections.length, 'account')} compared with what was recorded: ${plural(changed, 'difference')}` : rr.status === 'failed' ? `Failed: ${rr.error ?? ''}` : 'Reading…', href, note: 'you apply each difference yourself' }];
  }
  if (s.kind === 'receipt' && s.receiptId) {
    const rc = ctx.store.receipts.find((x) => x.id === s.receiptId);
    if (!rc) return [{ type: 'receipt', label: 'The receipt was taken off its payment' }];
    const t = ctx.store.transaction(rc.transactionId);
    const href = t ? `/transactions?accounts=${t.accountId}&period=custom&from=${t.date}&to=${t.date}` : undefined;
    return [
      { type: 'receipt reading', id: rc.id, label: rc.reading ? `${plural(rc.reading.lines.length, 'line')}${rc.reading.merchant ? ` from ${rc.reading.merchant}` : ''}${rc.reading.total !== null ? `, total £${rc.reading.total.toFixed(2)}` : ''}` : (rc.error ?? 'Not read'), ...(href ? { href } : {}), note: 'a proposed split: nothing changes until you save it' },
    ];
  }
  return [];
}

function noTranscriptWords(s: SessionSummary, r: SessionRecord | undefined, since: string, days: number): string | undefined {
  if (s.source === 'token') return `This agent ran outside the app, as a Claude Code session or a script holding one of your tokens. The app saw only the requests it made to the API, listed here, and keeps no transcript of it.${s.agentSession ? ` It named its session: ${s.agentSession}. That session's own transcript is in Claude Code on the machine it ran on.` : ' It did not name its session, so its requests are grouped by time.'}`;
  if (s.source === 'earlier') return `This session ran before the app kept transcripts (it has since ${since.slice(0, 10)}). What its ${s.kind === 'job' ? 'job' : s.kind === 'receipt' ? 'receipt' : 'import'} recorded is shown here. No transcript was kept, and the app does not reconstruct one.`;
  const removed = r?.transcript.removed;
  if (removed) return removed.why === 'expired' ? `Its transcript was deleted on ${removed.at.slice(0, 10)}: transcripts are kept for ${days} days.` : `Its transcript was deleted on ${removed.at.slice(0, 10)}, oldest first, to keep transcripts under their total size cap.`;
  return undefined;
}

/** What an earlier session's own record says, for the page to show as it is. */
async function recordedFields(ctx: AppContext, s: SessionSummary): Promise<Record<string, unknown> | undefined> {
  if (s.kind === 'job' && s.jobId) {
    const j = ctx.runner?.get(s.jobId);
    if (!j) return undefined;
    const { requestedBy: _r, ...rest } = j;
    return rest;
  }
  if (s.kind === 'reading' && s.importId) {
    const r = ctx.imports.getPending(s.importId) ?? (await ctx.store.readImport(s.importId));
    if (!r) return undefined;
    const { raw: _raw, alternative: _alt, ...meta } = r.extraction;
    return { origin: r.origin, file: r.document.fileName, ...meta };
  }
  if (s.kind === 'reread' && s.importId) {
    const rr = ctx.imports.getReread(s.importId);
    if (!rr) return undefined;
    const { sections: _s, ...meta } = rr;
    return meta;
  }
  if (s.kind === 'receipt' && s.receiptId) {
    const rc = ctx.store.receipts.find((x) => x.id === s.receiptId);
    return rc ? { status: rc.status, ...(rc.reading ? { model: rc.reading.model, promptVersion: rc.reading.promptVersion, at: rc.reading.at, costUsd: rc.reading.costUsd, notes: rc.reading.notes } : {}), ...(rc.error ? { error: rc.error } : {}) } : undefined;
  }
  return undefined;
}

export async function sessionDetail(ctx: AppContext, id: string): Promise<SessionDetail | undefined> {
  const all = await allSessions(ctx);
  const s = all.find((x) => x.id === id);
  if (!s) return undefined;
  const record = s.source === 'recorded' ? ctx.sessions.get(id) : undefined;
  const parent = s.jobId ?? s.importId ?? s.receiptId ?? s.conversationId ?? s.tokenId;
  const related = parent ? all.filter((x) => x.id !== id && (x.jobId ?? x.importId ?? x.receiptId ?? x.conversationId ?? x.tokenId) === parent && x.source !== 'token') : [];
  const produced = s.source === 'token' ? [] : await outputsOf(ctx, s, related);
  // Its rows in the audit log: the session's own, and its job's, import's, receipt's or token's.
  const about = [...(s.source === 'recorded' ? [s.id] : []), ...(parent ? [parent] : []), ...(record?.transactionId ? [record.transactionId] : [])];
  const fromDay = nowISO(new Date(Date.parse(s.startedAt) - 86_400_000)).slice(0, 10);
  let audit = (await ctx.audit.query({ about, from: fromDay, limit: 300 })).entries;
  let requests: TokenRequest[] | undefined;
  if (s.source === 'token') {
    const lo = Date.parse(s.startedAt) - 1000;
    const hi = Date.parse(s.finishedAt ?? s.startedAt) + 1000;
    audit = audit.filter((e) => Date.parse(e.at) >= lo && Date.parse(e.at) <= hi);
    requests = (await tokenActivity(ctx)).find((a) => a.summary.id === id)?.requests;
  }
  const noTranscript = noTranscriptWords(s, record, ctx.sessions.since, ctx.sessions.limits.days);
  const recorded = s.source === 'earlier' ? await recordedFields(ctx, s) : undefined;
  return {
    session: s,
    ...(record ? { record } : {}),
    ...(recorded ? { recorded } : {}),
    ...(noTranscript ? { noTranscript } : {}),
    related,
    produced,
    audit,
    ...(requests ? { requests } : {}),
  };
}

/** The sessions each id belongs to (a session's own, its job's, import's, receipt's or token's): for the audit log's links. */
export async function sessionIndex(ctx: AppContext): Promise<Map<string, { id: string; title: string }[]>> {
  const map = new Map<string, { id: string; title: string }[]>();
  const add = (key: string | undefined, s: SessionSummary) => {
    if (!key) return;
    (map.get(key) ?? map.set(key, []).get(key)!).push({ id: s.id, title: s.title });
  };
  for (const s of await allSessions(ctx)) {
    if (s.source === 'token') continue;
    add(s.id, s);
    add(s.jobId, s);
    add(s.importId, s);
    add(s.receiptId, s);
    add(s.conversationId, s);
  }
  return map;
}

/** The sessions an audit entry concerns. */
export function sessionsOfEntry(index: Map<string, { id: string; title: string }[]>, e: { targets?: string[]; actor: AuditActor }): { id: string; title: string }[] {
  const ids = [...(e.targets ?? []), ...(e.actor.type === 'job' ? [e.actor.jobId] : [])];
  const out = new Map<string, { id: string; title: string }>();
  for (const id of ids) for (const s of index.get(id) ?? []) out.set(s.id, s);
  return [...out.values()].slice(0, 6);
}

export { EARLIER as EARLIER_PREFIX, TOKEN as TOKEN_PREFIX };
