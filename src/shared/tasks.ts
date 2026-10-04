// Which model does each piece of model work (docs/ARCHITECTURE.md, "Models per task"; decided
// 2026-10-04 in docs/DECISIONS.md). One table says, for every task, what it needs, whose data it
// sees, which engines may run it, its default engine and model, the priority it asks the local
// model service for, and how long a local run may take. Settings → Models overrides it per task
// (`settings.models.tasks`); `resolveTask` merges the two and keeps only what the task allows.
//
// Engines: `inference` is the local model service on this machine (never leaves it), `claude-cli`
// and `claude-api` send what the task sees to Anthropic, `ocr` is tesseract (documents only), and
// `off` turns a check off.

import { z } from 'zod';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const TASK_ENGINES = ['inference', 'claude-cli', 'claude-api', 'ocr', 'off'] as const;
export type TaskEngine = (typeof TASK_ENGINES)[number];

/** Claude's models, by the names the CLI and API take. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku'] as const;

/**
 * The local model service's aliases (its README §2). A task names an alias, never a model file; the
 * service says which file answered (the provenance).
 */
export interface InferenceAlias {
  id: string;
  label: string;
  /** Reads images (page renders, screenshots). */
  vision: boolean;
  /** A bake-off alias: loading it swaps the GPU, so its first answer takes minutes and it holds the card for 10. */
  swapsGpu?: boolean;
  /** Short answers only (a verdict, a label). */
  short?: boolean;
}

export const INFERENCE_ALIASES: InferenceAlias[] = [
  { id: 'vision-extract', label: 'vision-extract (Qwen3.6-35B-A3B)', vision: true },
  { id: 'fast-chat', label: 'fast-chat (Qwen3.6-35B-A3B)', vision: false },
  { id: 'classify-small', label: 'classify-small (Qwen3.6-35B-A3B)', vision: false, short: true },
  { id: 'chat-q8', label: 'chat-q8: experiment (Q8_0 weights; swaps the GPU)', vision: true, swapsGpu: true },
  { id: 'chat-9b', label: 'chat-9b: experiment (Qwen3.5-9B; swaps the GPU)', vision: true, swapsGpu: true },
];

export const isInferenceAlias = (model: string | undefined): boolean => INFERENCE_ALIASES.some((a) => a.id === model);

export type Priority = 'batch' | 'normal' | 'interactive';
export type TaskNeed = 'vision' | 'web' | 'tools' | 'reasoning' | 'long-context' | 'structured';

export const TASK_KINDS = ['read-document', 'check-reading', 'read-receipt', 'label-imports', 'interpret-note', 'suggest-categories', 'ask', 'monthly-review', 'insights-after-import', 'research'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** One task's model, as Settings → Models stores it (each field optional: the default fills it). */
export const TaskChoiceSchema = z.object({
  engine: z.enum(TASK_ENGINES).optional(),
  /** An alias of the local service, or a Claude model ("sonnet", "opus" or a full id). */
  model: z.string().min(1).max(80).optional(),
  /** Local model only: think before answering (within the service's 16k-token budget). */
  thinking: z.boolean().optional(),
  /** Claude only. */
  effort: z.enum(EFFORTS).optional(),
  /**
   * Local model only: when it cannot do the work (down, its GPU lent out for longer than the wait,
   * or a reading it could not finish), Claude does it instead. That sends what the task sees to
   * Anthropic, so it is off unless you turn it on.
   */
  fallback: z.boolean().optional(),
});
export type TaskChoiceInput = z.infer<typeof TaskChoiceSchema>;

/** A task's model with every field decided. */
export interface TaskChoice {
  engine: TaskEngine;
  model: string;
  thinking: boolean;
  effort: Effort;
  fallback: boolean;
}

export interface TaskDef {
  kind: TaskKind;
  label: string;
  description: string;
  needs: TaskNeed[];
  /** "personal": sees your data (never web tools). "public": public identifiers only. */
  privacy: 'personal' | 'public';
  /** Engines that can do it, the default first. */
  engines: TaskEngine[];
  default: TaskChoice;
  /** The Claude model a fallback (or a "Read with Claude") uses. */
  claude: { model: string; effort: Effort };
  /** The local model's alias and thinking, when the task runs there. */
  local?: { model: string; thinking: boolean };
  /** What the local model service is asked for (its README §5, "Priorities"). */
  priority: Priority;
  /** Minutes a local run may take once its turn comes (the queue wait is on top). */
  runMinutes: number;
  /** Output tokens allowed on the local model (thinking off; thinking uses the service's own cap). */
  maxTokens: number;
  /** The jobs (docs/AGENTS.md §7) this task covers. */
  jobs?: string[];
}

const local = (model: string, thinking = false): TaskChoice => ({ engine: 'inference', model, thinking, effort: 'high', fallback: false });
const claude = (model: string): TaskChoice => ({ engine: 'claude-cli', model, thinking: false, effort: 'high', fallback: false });

export const TASKS: Record<TaskKind, TaskDef> = {
  'read-document': {
    kind: 'read-document',
    label: 'Read documents',
    description: 'Every PDF, screenshot and spreadsheet uploaded (CSV, OFX and the layouts known here are always read on this machine), and a stored document read again.',
    needs: ['vision', 'structured'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli', 'claude-api', 'ocr'],
    // Claude until the local model's evaluation passes (DECISIONS 2026-10-04: 98.9% of fields, but
    // some wrong readings passed every check).
    default: claude('sonnet'),
    claude: { model: 'sonnet', effort: 'high' },
    local: { model: 'vision-extract', thinking: false },
    priority: 'batch',
    runMinutes: 60,
    maxTokens: 49_152,
  },
  'check-reading': {
    kind: 'check-reading',
    label: 'Check a reading',
    description: 'Reads a document again when its checks fail, or when nothing on it confirms the figures, and keeps the better reading.',
    needs: ['vision', 'structured', 'reasoning'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli', 'claude-api', 'off'],
    default: claude('opus'),
    claude: { model: 'opus', effort: 'high' },
    local: { model: 'vision-extract', thinking: true },
    priority: 'batch',
    runMinutes: 90,
    maxTokens: 49_152,
  },
  'read-receipt': {
    kind: 'read-receipt',
    label: 'Read receipts',
    description: 'The lines of a receipt you attach, to propose how to split the payment.',
    needs: ['vision', 'structured'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli'],
    default: claude('sonnet'),
    claude: { model: 'sonnet', effort: 'high' },
    local: { model: 'vision-extract', thinking: false },
    priority: 'batch',
    runMinutes: 30,
    maxTokens: 8192,
  },
  'label-imports': {
    kind: 'label-imports',
    label: 'Name imports',
    description: 'A name for each committed import, from what was read from it (never amounts).',
    needs: ['structured'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli'],
    default: local('fast-chat'),
    claude: { model: 'opus', effort: 'high' },
    local: { model: 'fast-chat', thinking: false },
    priority: 'batch',
    runMinutes: 15,
    maxTokens: 4096,
    jobs: ['label-imports'],
  },
  'interpret-note': {
    kind: 'interpret-note',
    label: 'Understand notes',
    description: 'What you tell the app in plain words, as records for you to confirm.',
    needs: ['structured'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli'],
    default: local('fast-chat'),
    claude: { model: 'opus', effort: 'high' },
    local: { model: 'fast-chat', thinking: false },
    priority: 'normal',
    runMinutes: 15,
    maxTokens: 4096,
    jobs: ['interpret-note'],
  },
  'suggest-categories': {
    kind: 'suggest-categories',
    label: 'Suggest categories',
    description: 'A category for each payment your rules, the merchant list and the bank leave, one payment at a time, as proposals you review.',
    needs: ['structured'],
    privacy: 'personal',
    engines: ['inference'],
    default: local('fast-chat'),
    claude: { model: 'sonnet', effort: 'high' },
    local: { model: 'fast-chat', thinking: false },
    priority: 'batch',
    runMinutes: 5,
    maxTokens: 256,
    jobs: ['suggest-categories'],
  },
  ask: {
    kind: 'ask',
    label: 'Answer questions',
    description: 'A question you ask about your money, answered from the figures the app works out (never from its own sums).',
    needs: ['reasoning', 'structured'],
    privacy: 'personal',
    engines: ['inference', 'claude-cli'],
    default: local('fast-chat', true),
    claude: { model: 'sonnet', effort: 'high' },
    local: { model: 'fast-chat', thinking: true },
    priority: 'interactive',
    runMinutes: 30,
    maxTokens: 8192,
  },
  'monthly-review': {
    kind: 'monthly-review',
    label: 'Month in review',
    description: 'Reads the month’s figures with tools; the local model has no tools, so Claude writes it.',
    needs: ['tools', 'reasoning', 'long-context', 'structured'],
    privacy: 'personal',
    engines: ['claude-cli'],
    default: claude('opus'),
    claude: { model: 'opus', effort: 'high' },
    priority: 'batch',
    runMinutes: 30,
    maxTokens: 16_384,
    jobs: ['monthly-review'],
  },
  'insights-after-import': {
    kind: 'insights-after-import',
    label: 'Insights after imports',
    description: 'Reads the digest of your figures with tools; the local model has no tools, so Claude writes them.',
    needs: ['tools', 'reasoning', 'long-context', 'structured'],
    privacy: 'personal',
    engines: ['claude-cli'],
    default: claude('opus'),
    claude: { model: 'opus', effort: 'high' },
    priority: 'batch',
    runMinutes: 30,
    maxTokens: 16_384,
    jobs: ['insights-after-import'],
  },
  research: {
    kind: 'research',
    label: 'Research',
    description: 'Funds, providers and the modelling assumptions, from the web, with public identifiers only. The local model has no web access.',
    needs: ['web', 'tools', 'structured'],
    privacy: 'public',
    engines: ['claude-cli'],
    default: claude('opus'),
    claude: { model: 'opus', effort: 'high' },
    priority: 'batch',
    runMinutes: 30,
    maxTokens: 16_384,
    jobs: ['research-instrument', 'research-provider', 'refresh-assumptions'],
  },
};

/** The task an agent job kind runs as. */
export function taskOfJob(jobKind: string): TaskKind | undefined {
  return TASK_KINDS.find((k) => TASKS[k].jobs?.includes(jobKind));
}

/** Can this model run on this engine for this task? */
export function modelFits(task: TaskKind, engine: TaskEngine, model: string): boolean {
  const def = TASKS[task];
  if (engine === 'inference') {
    const alias = INFERENCE_ALIASES.find((a) => a.id === model);
    if (!alias) return false;
    return !def.needs.includes('vision') || alias.vision;
  }
  if (engine === 'claude-cli' || engine === 'claude-api') return !isInferenceAlias(model);
  return true;
}

/** The task's model: Settings → Models over the table's default, kept to what the task allows. */
export function resolveTask(task: TaskKind, overrides?: Partial<Record<TaskKind, TaskChoiceInput>>): TaskChoice {
  const def = TASKS[task];
  const o = overrides?.[task] ?? {};
  const engine = o.engine && def.engines.includes(o.engine) ? o.engine : def.default.engine;
  const sameEngine = engine === def.default.engine;
  // A model chosen for another engine does not carry over: the engine's own default does.
  const fallbackModel = engine === 'inference' ? (sameEngine ? def.default.model : (def.local?.model ?? INFERENCE_ALIASES.find((a) => modelFits(task, 'inference', a.id))!.id)) : engine === 'claude-cli' || engine === 'claude-api' ? (sameEngine ? def.default.model : def.claude.model) : engine;
  const model = o.model && modelFits(task, engine, o.model) ? o.model : fallbackModel;
  return {
    engine,
    model,
    thinking: engine === 'inference' ? (o.thinking ?? (sameEngine ? def.default.thinking : (def.local?.thinking ?? false))) : false,
    effort: o.effort ?? (sameEngine && engine !== 'inference' ? def.default.effort : def.claude.effort),
    fallback: engine === 'inference' && def.engines.some((e) => e === 'claude-cli' || e === 'claude-api') ? (o.fallback ?? false) : false,
  };
}

/** The Claude choice a fallback, or a "Read with Claude", uses for a task. */
export function claudeChoice(task: TaskKind, engine: 'claude-cli' | 'claude-api' = 'claude-cli'): TaskChoice {
  const def = TASKS[task];
  return { engine, model: def.claude.model, thinking: false, effort: def.claude.effort, fallback: false };
}

/** A model choice as words: "vision-extract, thinking" or "opus". */
export function choiceName(c: Pick<TaskChoice, 'engine' | 'model' | 'thinking'>): string {
  if (c.engine === 'inference') return `${c.model}${c.thinking ? ', thinking' : ''}`;
  return c.engine === 'ocr' || c.engine === 'off' ? c.engine : c.model;
}
