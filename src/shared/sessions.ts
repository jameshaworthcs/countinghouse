// Claude sessions (src/server/sessions.ts; the Claude sessions page): every time the app runs
// Claude, what started it, what it was told, everything it did and what came of it. Agents with
// your tokens run outside the app: only their requests to it are seen.

import type { AuditActor, AuditEntry } from './audit';

/** What a session was for: an agent job, reading an upload, reading a stored document again, a receipt. */
export type SessionKind = 'job' | 'reading' | 'reread' | 'receipt';
export type SessionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type SessionEngine = 'inference' | 'claude-cli' | 'claude-api';

/** The reading a session made of a document: the first, or the check by a second model. */
export type ReadingRole = 'first' | 'second';

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** A session the app recorded as it ran (since transcripts were kept). */
export interface SessionRecord {
  /** ses_<time><random> */
  id: string;
  kind: SessionKind;
  title: string;
  /** The agent job's kind (research-instrument, label-imports…). */
  jobKind?: string;
  role?: ReadingRole;
  /** What it belongs to: the job, the import (a reading or a reading again), or the receipt. */
  jobId?: string;
  importId?: string;
  receiptId?: string;
  transactionId?: string;
  engine: SessionEngine;
  /** Who started it (as the audit log names them) and why. */
  startedBy: { actor: AuditActor; reason: string };
  /** The model asked for ("sonnet"), and the one that answered (claude-sonnet-5-5). */
  model: string;
  modelUsed?: string;
  effort?: string;
  /** The local model service: whether it thought before answering. */
  thinking?: boolean;
  /** The local model service's provenance of the answer, whole (its README §4). */
  inference?: Record<string, unknown>;
  promptVersion?: string;
  tools: string[];
  /** A job's privacy class: web tools with public inputs, or your data with no web. */
  privacy?: 'public' | 'personal';
  status: SessionStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  costUsd?: number;
  turns?: number;
  usage?: SessionUsage;
  error?: string;
  transcript: TranscriptInfo;
}

export interface TranscriptInfo {
  /** Where it is kept, relative to the work area (beside its job, import or receipt). */
  path: string;
  /** Events written so far. */
  events: number;
  bytes: number;
  /** It reached the size cap: later events were left out (the final result is always kept). */
  truncated?: boolean;
  /** It was deleted: past the retention period, or to keep transcripts under their total cap. */
  removed?: { at: string; why: 'expired' | 'over-total' };
}

/** One row of the list: a recorded session, one from before transcripts were kept, or a token's activity. */
export interface SessionSummary {
  id: string;
  /** "recorded": with a transcript. "earlier": from what jobs, imports and receipts recorded, before transcripts. "token": an agent outside the app, by its requests. */
  source: 'recorded' | 'earlier' | 'token';
  kind: SessionKind | 'token';
  title: string;
  jobKind?: string;
  role?: ReadingRole;
  jobId?: string;
  importId?: string;
  receiptId?: string;
  tokenId?: string;
  engine?: SessionEngine;
  /** Who started it, in a few words, and why. */
  startedBy: string;
  reason?: string;
  model?: string;
  promptVersion?: string;
  status: SessionStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  costUsd?: number;
  /** A token's activity: how many requests, and how many changed something or were refused. */
  requests?: { total: number; changes: number; refused: number };
  transcript: 'kept' | 'truncated' | 'removed' | 'none';
}

/** Something a session produced, and where it lives in the app. */
export interface SessionOutput {
  /** e.g. research, assumption, insight, instrument, proposal, note, import name, extraction, draft. */
  type: string;
  id?: string;
  label: string;
  /** A path in the app (/assumptions#research, /import/imp_…), when it has a page. */
  href?: string;
  /** Further words: "kept", "not kept: the other reading", "applied", "dismissed". */
  note?: string;
}

/** One request a token made (the token's use log). */
export interface TokenRequest {
  at: string;
  method: string;
  path: string;
  status: number;
  from: string;
}

export interface SessionDetail {
  session: SessionSummary;
  /** The full record of a session the app recorded. */
  record?: SessionRecord;
  /** What the record of an earlier session says (a job's, import's or receipt's own fields). */
  recorded?: Record<string, unknown>;
  /** Why there is no transcript, in plain words, when there is none. */
  noTranscript?: string;
  /** Other sessions of the same job, import or receipt. */
  related: SessionSummary[];
  produced: SessionOutput[];
  /** Its rows in the audit log, and its job's, import's or token's. */
  audit: AuditEntry[];
  /** A token's requests in this stretch of activity. */
  requests?: TokenRequest[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  /** How transcripts are kept. */
  retention: { days: number; maxBytesPerSession: number; maxBytesTotal: number; bytes: number; dir: string };
}

export interface TranscriptResponse {
  /** Events from `from` on, in order: the prompt the app sent, then the stream as the engine gave it. */
  events: unknown[];
  from: number;
  /** Events in the transcript so far. */
  total: number;
}

/** How long a gap in a token's requests ends one stretch of activity and starts the next. */
export const TOKEN_ACTIVITY_GAP_MS = 30 * 60_000;
