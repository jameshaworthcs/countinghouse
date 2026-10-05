// Ask (src/server/ask.ts; DECISIONS 2026-10-05): conversations about your money, each kept in the
// work area with every step the model took. An answer is an inference: the figures in it that came
// from the app's tools are marked computed, and link to where they can be checked.

import type { AuditActor } from './audit';

export const ASK_PROMPT_VERSION = 'ask-3';

/** The models a question can be asked of (Settings → Models gives the default). */
export const ASK_MODEL_OPTIONS = [
  { id: 'local-thinking', label: 'Local model, thinking (slower, better)', engine: 'inference', model: 'fast-chat', thinking: true },
  { id: 'local-quick', label: 'Local model, no thinking (quicker)', engine: 'inference', model: 'fast-chat', thinking: false },
  { id: 'claude-sonnet', label: 'Claude Sonnet (sends what it looks up to Anthropic)', engine: 'claude-cli', model: 'sonnet', effort: 'high' },
  { id: 'claude-opus', label: 'Claude Opus (sends what it looks up to Anthropic)', engine: 'claude-cli', model: 'opus', effort: 'high' },
] as const;
export type AskModelId = (typeof ASK_MODEL_OPTIONS)[number]['id'];

export interface AskModel {
  id: AskModelId;
  engine: 'inference' | 'claude-cli';
  model: string;
  thinking?: boolean;
  effort?: string;
}

/** What the owner set on the question: the tools use them when the model gives none. */
export interface AskDefaults {
  from?: string;
  to?: string;
  accounts?: string[];
}

export interface AskFigure {
  label: string;
  value: string;
  /** The step whose result it is from, as the model gave it. */
  step: number | null;
  /** The app found the figure in that step's result: computed by the app, not by the model. */
  computed: boolean;
  /** Where it can be checked (the step's evidence). */
  href?: string;
}

export interface AskAnswer {
  answer: string;
  figures: AskFigure[];
  confidence: 'high' | 'medium' | 'low';
  /** The model's own confidence, when the app lowered it: a figure in the answer was not in what the app gave it. */
  modelConfidence?: 'high' | 'medium' | 'low';
  caveats: string[];
  cannotAnswer: boolean;
}

/** One tool call the model made, and what the app gave back. */
export interface AskStep {
  n: number;
  at: string;
  /** What it was looking for, in its words. */
  why: string;
  tool: string;
  args: Record<string, unknown>;
  /** One line for the page: "13 payments found, money out £1,234.56". */
  summary?: string;
  error?: string;
  /** Where to check it: the Transactions page with the same filters, or the page it came from. */
  href?: string;
  ms: number;
  /** What the model said for this step, and the result it was given (kept for the next steps and turns). */
  said: string;
  resultText: string;
}

export type AskTurnStatus = 'queued' | 'running' | 'answered' | 'failed' | 'cancelled';

export interface AskTurn {
  id: string;
  question: string;
  askedAt: string;
  model: AskModel;
  defaults: AskDefaults;
  status: AskTurnStatus;
  steps: AskStep[];
  answer?: AskAnswer;
  error?: string;
  /** The sessions it ran as (two when Claude stood in for the local model). */
  sessions: string[];
  /** Who asked it, as the audit log names them, and the request that did (its audit row). */
  askedBy?: AuditActor;
  requestId?: string;
  startedAt?: string;
  finishedAt?: string;
  stoppedBy?: string;
  /** Claude answered because the local model could not, and why. */
  fellBack?: string;
  promptVersion: string;
  /** "This is wrong", with why, and who said so: kept as an evaluation set for the next prompt version. */
  feedback?: { wrong: boolean; note: string; at: string; by?: string };
  /** While it runs, what it is doing now (not kept). */
  live?: AskLive;
}

export interface AskLive {
  /** waiting: for the local model; reading: its prompt; thinking; writing: its step. */
  phase: 'waiting' | 'reading' | 'thinking' | 'writing' | 'looking';
  waiting?: string;
  /** How much it has thought, and what it is writing (the step's why or the answer so far). */
  reasoningChars: number;
  text?: string;
  since: string;
}

export interface AskConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Taken off the list (Delete): kept until retention removes it. */
  hidden?: { at: string; by: string };
  /** The figures the first question was given (accounts, categories, months): every turn starts from them. */
  context: string;
  turns: AskTurn[];
}

export interface AskConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status: AskTurnStatus;
  lastAnswer?: string;
}

export interface AskServiceState {
  /** The local model service's state for Ask's model, for the expected wait. */
  state: string;
  queued?: number;
  inFlight?: number;
  /** Its GPU is lent to another program until then. */
  leasedUntil?: string;
  note: string;
}

export interface AskListResponse {
  conversations: AskConversationSummary[];
  suggestions: string[];
  models: { id: AskModelId; label: string; available: boolean; why?: string }[];
  defaultModel: AskModelId;
  maxToolCalls: number;
  /** Turns waiting or running, across conversations (one runs at a time). */
  busy: number;
  service: AskServiceState | null;
  retentionDays: number;
}

export interface AskFeedbackItem {
  conversationId: string;
  turnId: string;
  question: string;
  answer?: string;
  note: string;
  at: string;
  by?: string;
  promptVersion: string;
  model: string;
}
