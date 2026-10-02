// The audit log's records (src/server/audit.ts; Settings → Audit log): every action that changes
// your data or the app's work area, who did it, from where, and what it changed.

/** Who did something. */
export type AuditActor =
  /** You, signed in (or, on a server with no login, on this machine directly). */
  | { type: 'owner'; user: string; via: 'session' | 'local'; ip: string; device?: string; tailnetUser?: string; userAgent?: string }
  /** An agent with one of your tokens (Settings → Agent access). */
  | { type: 'token'; tokenId: string; name: string; scopes: string[]; ip: string; device?: string; tailnetUser?: string; userAgent?: string }
  /** An agent job the app ran (Assumptions & research → Agent jobs). */
  | { type: 'job'; jobId: string; kind: string; trigger: string; label?: string }
  /** The app by itself: start-up upkeep, the import queue, the inbox folder, git, the job scheduler. */
  | { type: 'app'; task: string }
  /** A file in the data directory changed while the app was not the one writing it: a hand edit, git, a script. */
  | { type: 'outside' }
  /** A request that was not signed in (refused), or presented a token that is not valid. */
  | { type: 'anonymous'; ip: string; device?: string; tailnetUser?: string; userAgent?: string; claimedToken?: string };

export type AuditActorType = AuditActor['type'];
export const AUDIT_ACTOR_TYPES: AuditActorType[] = ['owner', 'token', 'job', 'app', 'outside', 'anonymous'];

export const AUDIT_CATEGORIES = ['data', 'request', 'auth', 'import', 'job', 'session', 'proposal', 'token', 'app'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditOutcome = 'ok' | 'refused' | 'failed';

/** Fields that changed: before → after (long values shortened). */
export type FieldChanges = Record<string, [unknown, unknown]>;

/** What a write to the data changed, record by record. */
export interface ChangeDiff {
  added?: number;
  removed?: number;
  changed?: number;
  /** Up to 50 records: what each is, and for a change, its fields before → after. */
  items?: { id: string; op: 'added' | 'removed' | 'changed'; label?: string; fields?: FieldChanges }[];
  /** A single file such as settings or your profile: the fields that changed. */
  fields?: FieldChanges;
}

/** Something done within a request, folded into its request entry. */
export interface AuditChild {
  seq: number;
  action: string;
  summary: string;
  paths?: string[];
  /** The git commit that holds it (filled in when read). */
  commit?: string;
}

export interface AuditEntry {
  /** 1, 2, 3…: one sequence for the whole log, never reused. */
  seq: number;
  /** When, UTC with milliseconds. */
  at: string;
  category: AuditCategory;
  /** e.g. data.change, request, auth.sign-in, import.review, job.succeeded, token.create. */
  action: string;
  outcome: AuditOutcome;
  summary: string;
  actor: AuditActor;
  /** Every entry made while answering one request shares its id. */
  requestId?: string;
  request?: { method: string; path: string; status?: number; ms?: number; contentType?: string; bytes?: number; body?: unknown; error?: string };
  /** For a request: what it did, in order. */
  changes?: AuditChild[];
  /** Files under the data directory that were written. */
  paths?: string[];
  /** Ids of the records, imports, jobs, proposals or tokens it concerns. */
  targets?: string[];
  details?: Record<string, unknown>;
  diff?: ChangeDiff;
  /** The git commit holding a data change (filled in when read, not stored on the entry). */
  commit?: string;
  /** The Claude sessions it concerns (filled in when read, not stored on the entry). */
  sessions?: { id: string; title: string }[];
  /** sha256(previous entry's hash + this entry without its hash): a removed or altered entry breaks the chain. */
  hash: string;
}

export interface AuditStatus {
  /** Entries written so far (the last sequence number). */
  entries: number;
  firstAt?: string;
  /** Where the log is kept, and how much room it takes. */
  dir: string;
  bytes: number;
  /** Writes that failed since the app started; they are retried with the next entry. */
  failures: number;
  unwritten: number;
  lastError?: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  /** Pass as `before` for the next, older page. */
  next?: number;
  status: AuditStatus;
}

export interface AuditVerifyResponse {
  ok: boolean;
  entries: number;
  files: number;
  /** Lines that are not a whole entry (a write cut off by a crash). */
  unreadable: number;
  problems: { file: string; line: number; seq?: number; problem: string }[];
}

/** Who, in a few words: "You", "Token “Claude Code on P360”", "Job research-instrument". */
export function actorName(a: AuditActor): string {
  switch (a.type) {
    case 'owner':
      return a.via === 'local' ? 'You (on this machine, no login)' : 'You';
    case 'token':
      return `Agent token “${a.name}”`;
    case 'job':
      return `Agent job ${a.kind}`;
    case 'app':
      return `The app (${a.task})`;
    case 'outside':
      return 'Outside the app';
    case 'anonymous':
      return a.claimedToken ? 'An invalid token' : 'Not signed in';
  }
}
