// Settings → Models: which model does each piece of model work (src/shared/tasks.ts). One row per
// task: its engine (the local model service on this machine, Claude, offline OCR, or off), its model,
// thinking or effort, and whether Claude may stand in when the local model cannot.

import { CircleAlert, CircleCheck } from 'lucide-react';
import type { SystemResponse } from '../../shared/api';
import type { Settings } from '../../shared/schema';
import { CLAUDE_MODELS, EFFORTS, INFERENCE_ALIASES, modelFits, resolveTask, TASK_KINDS, TASKS, type TaskChoiceInput, type TaskEngine, type TaskKind } from '../../shared/tasks';
import { Badge, Callout, Card, Field, Select, Switch } from './ui';

const ENGINE_NAMES: Record<TaskEngine, string> = {
  inference: 'Local model (this machine)',
  'claude-cli': 'Claude, via your Claude login',
  'claude-api': 'Claude API',
  ocr: 'Offline OCR (lower accuracy)',
  off: 'Off',
};

const NEED_NAMES: Record<string, string> = { vision: 'reads images', web: 'web search', tools: 'tools', reasoning: 'reasoning', 'long-context': 'long input', structured: 'structured output' };

function TaskRow({ task, s, set }: { task: TaskKind; s: Settings; set: (task: TaskKind, patch: TaskChoiceInput) => void }) {
  const def = TASKS[task];
  const c = resolveTask(task, s.models.tasks);
  const locked = def.engines.length === 1;
  const sends = c.engine === 'claude-cli' || c.engine === 'claude-api';
  const aliases = INFERENCE_ALIASES.filter((a) => modelFits(task, 'inference', a.id));
  const alias = INFERENCE_ALIASES.find((a) => a.id === c.model);
  return (
    <div className="border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{def.label}</span>
        {c.engine === 'inference' && <Badge tone="good">stays on this machine</Badge>}
        {sends && <Badge tone="neutral">{def.privacy === 'personal' ? 'sends your data to Anthropic' : 'sends public identifiers to Anthropic'}</Badge>}
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink-3">
        {def.description} Needs: {def.needs.map((n) => NEED_NAMES[n] ?? n).join(', ')}.
      </div>
      {locked ? (
        <div className="mt-2 text-[12.5px] text-ink-3">
          {ENGINE_NAMES[c.engine]}, {c.model}
          {sends ? `, effort ${c.effort}` : ''}.
        </div>
      ) : (
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Field label="Engine">
            <Select value={c.engine} onChange={(e) => set(task, { engine: e.target.value as TaskEngine, model: undefined, thinking: undefined })}>
              {def.engines.map((e) => (
                <option key={e} value={e}>
                  {ENGINE_NAMES[e]}
                </option>
              ))}
            </Select>
          </Field>
          {c.engine === 'inference' && (
            <Field label="Model">
              <Select value={c.model} onChange={(e) => set(task, { model: e.target.value })}>
                {aliases.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {sends && (
            <Field label="Model">
              <Select value={c.model} onChange={(e) => set(task, { model: e.target.value })}>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {sends && (
            <Field label="Effort">
              <Select value={c.effort} onChange={(e) => set(task, { effort: e.target.value as (typeof EFFORTS)[number] })}>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {c.engine === 'inference' && (
            <div className="sm:col-span-3">
              <Switch checked={c.thinking} onChange={(v) => set(task, { thinking: v })} label="Think before answering" description="Slower (several times as long), within a 16k-token budget. It helps checking a reading and adding things up; it does not help a first reading." />
              {def.engines.some((e) => e === 'claude-cli' || e === 'claude-api') && (
                <Switch
                  checked={c.fallback}
                  onChange={(v) => set(task, { fallback: v })}
                  label="When the local model cannot, use Claude"
                  description={`Off: the work waits for the local model (up to 12 hours while it is down or its GPU is lent out), and you can ask Claude yourself. On: Claude (${def.claude.model}) does it instead, which sends ${def.privacy === 'personal' ? 'what it reads, your documents included,' : 'it'} to Anthropic.`}
                />
              )}
            </div>
          )}
        </div>
      )}
      {alias?.swapsGpu && c.engine === 'inference' && (
        <Callout tone="warn" className="mt-2">
          {alias.id} is an experiment: loading it swaps the GPU, so its first answer takes 2–3 minutes and it holds the card for at least 10, slowing everyone else’s work. Use it for a comparison, not every day.
        </Callout>
      )}
    </div>
  );
}

export function ModelsCard({ s, setS, sys }: { s: Settings; setS: (s: Settings) => void; sys: SystemResponse | undefined }) {
  const set = (task: TaskKind, patch: TaskChoiceInput) => {
    const prev = s.models.tasks[task] ?? {};
    const next = Object.fromEntries(Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined)) as TaskChoiceInput;
    setS({ ...s, models: { ...s.models, tasks: { ...s.models.tasks, [task]: next } } });
  };
  const local = sys?.engines.find((e) => e.id === 'inference');
  return (
    <Card title="Models" description="Which model does each piece of work. The local model runs on this machine, so nothing it reads leaves it; it is slower (minutes for a document) and has no web access or tools. Claude is faster, and sends what it reads to Anthropic.">
      <ul className="mb-3 flex flex-col gap-2">
        {sys?.engines.map((e) => (
          <li key={e.id} className="flex items-start gap-2 text-[13px]">
            {e.available ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-good-ink" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-3" />}
            <div>
              <span className="font-medium text-ink">{ENGINE_NAMES[e.id as TaskEngine] ?? e.id}</span>
              {e.external && <Badge tone="neutral" className="ml-2">sends to Anthropic</Badge>}
              <div className="text-ink-3">{e.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {local && !local.available && <Callout tone="warn" className="mb-3">The local model is not answering now. Work for it waits until it does, unless its task lets Claude stand in.</Callout>}
      <div>
        {TASK_KINDS.map((t) => (
          <TaskRow key={t} task={t} s={s} set={set} />
        ))}
      </div>
    </Card>
  );
}
