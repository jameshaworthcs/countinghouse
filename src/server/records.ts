// The validated write path for agent-maintained records: assumptions, research, insights, owner
// context and instruments. In-app jobs, the /api/records endpoint and `npm run records` (for Claude
// Code sessions) all go through `applyRecords`, so every record meets the same Zod schemas plus the
// checks a schema cannot express: known keys and scopes, references that resolve, evidence that
// exists, and agents never writing as the owner. See docs/AGENTS.md.

import { z } from 'zod';
import { assumptionProblems, scopeKey } from '../shared/assumptions';
import {
  AssumptionSchema,
  ContextSchema,
  InsightSchema,
  InstrumentSchema,
  ProvenanceSchema,
  ResearchInputSchema,
  ResearchSchema,
  type Assumption,
  type AssumptionScope,
  type ContextRecord,
  type Insight,
  type Instrument,
  type Provenance,
  type Research,
} from '../shared/schema';
import { nowISO, randomHex, shortHash } from './fsutil';
import { StoreError, type Store } from './store';

// Inputs: the record without the fields the app assigns (id, createdAt, provenance).
const omitAssigned = { id: true, createdAt: true, provenance: true } as const;
export const AssumptionInputSchema = AssumptionSchema.omit(omitAssigned);
export const InsightInputSchema = InsightSchema.omit({ ...omitAssigned, status: true, feedback: true });
export const ContextInputSchema = ContextSchema.omit({ id: true, createdAt: true, updatedAt: true });
export const InstrumentInputSchema = InstrumentSchema.omit({ createdAt: true, updatedAt: true }).extend({ id: InstrumentSchema.shape.id.optional() });

export const RecordInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assumption'), record: AssumptionInputSchema }),
  z.object({ type: z.literal('research'), record: ResearchInputSchema }),
  z.object({ type: z.literal('insight'), record: InsightInputSchema }),
  z.object({ type: z.literal('context'), record: ContextInputSchema }),
  z.object({ type: z.literal('instrument'), record: InstrumentInputSchema }),
]);
export type RecordInput = z.infer<typeof RecordInputSchema>;

export const RecordBatchSchema = z.object({
  provenance: ProvenanceSchema,
  records: z.array(RecordInputSchema).min(1).max(500),
  /**
   * Insights from this batch replace the writer's earlier active insights with the same kind and
   * subject (a rerun of a job supersedes its previous output).
   */
  supersede: z.boolean().default(false),
});
export type RecordBatch = z.infer<typeof RecordBatchSchema>;

export interface ApplyResult {
  written: { type: RecordInput['type']; id: string }[];
  skipped: { type: RecordInput['type']; reason: string }[];
}

export class RecordsError extends StoreError {
  constructor(readonly problems: string[]) {
    super(`Rejected: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ''}`, 422);
  }
}

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Research ids are content-addressed: the same findings always get the same id. */
export function researchIdOf(r: Pick<z.infer<typeof ResearchInputSchema>, 'kind' | 'subject' | 'asOf' | 'data'>): string {
  return `res_${shortHash('res', canonicalJson([r.kind, r.subject, r.asOf, r.data]))}`;
}

/** Check a batch without writing anything. Returns the problems (empty when valid). */
export function checkRecords(store: Store, batch: RecordBatch): string[] {
  const problems: string[] = [];
  const accounts = new Set(store.accounts.map((a) => a.id));
  const institutions = new Set(store.institutions.map((i) => i.id));
  // Instruments may be created in the same batch and referenced by later records.
  const instruments = new Set(store.instruments.map((i) => i.id));
  for (const r of batch.records) if (r.type === 'instrument' && r.record.id) instruments.add(r.record.id);
  // Research in the same batch can be cited by the assumptions that rest on it.
  const research = new Set([...store.research.map((r) => r.id), ...batch.records.flatMap((r) => (r.type === 'research' ? [researchIdOf(r.record)] : []))]);
  const assumptions = new Set(store.assumptions.map((a) => a.id));
  const context = new Set(store.context.map((c) => c.id));
  const figures = new Set(store.figures.map((f) => f.id));
  const balances = new Set(store.balances().map((b) => b.id));
  const holdings = new Set(store.holdings().map((h) => h.id));

  const ref = (where: string, kind: string, id: string | undefined, set: Set<string>) => {
    if (id !== undefined && !set.has(id)) problems.push(`${where}: unknown ${kind} "${id}"`);
  };
  const scopeRefs = (where: string, s: AssumptionScope) => {
    if (s.kind === 'account') ref(where, 'account', s.accountId, accounts);
    if (s.kind === 'institution') ref(where, 'institution', s.institutionId, institutions);
    if (s.kind === 'instrument') ref(where, 'instrument', s.instrumentId, instruments);
  };

  if (batch.provenance.setBy !== 'owner' && !batch.provenance.model && !batch.provenance.session) {
    problems.push('provenance: an agent must say which model or session produced the records');
  }

  batch.records.forEach((input, i) => {
    const where = `records[${i}] (${input.type})`;
    switch (input.type) {
      case 'assumption': {
        const a = input.record;
        for (const p of assumptionProblems(a)) problems.push(`${where}: ${p}`);
        scopeRefs(where, a.scope);
        for (const id of a.basedOn) ref(where, 'research record', id, research);
        if (batch.provenance.setBy !== 'owner' && a.evidence.length === 0 && a.basedOn.length === 0) {
          problems.push(`${where}: an agent's assumption needs evidence (sources) or basedOn (research records)`);
        }
        break;
      }
      case 'research': {
        const r = input.record;
        ref(where, 'instrument', r.subject.instrumentId, instruments);
        ref(where, 'institution', r.subject.institutionId, institutions);
        if (batch.provenance.setBy !== 'owner' && !r.sources.some((s) => s.url)) problems.push(`${where}: research needs at least one source with a URL`);
        break;
      }
      case 'insight': {
        const r = input.record;
        ref(where, 'account', r.subject.accountId, accounts);
        ref(where, 'instrument', r.subject.instrumentId, instruments);
        if (r.period && r.period.from > r.period.to) problems.push(`${where}: period ends before it starts`);
        for (const e of r.evidence) {
          if (e.type === 'transactions') for (const id of e.ids) if (!store.transaction(id)) problems.push(`${where}: evidence cites unknown transaction ${id}`);
          if (e.type === 'balance') ref(where, 'balance', e.id, balances);
          if (e.type === 'holdings') ref(where, 'holdings snapshot', e.id, holdings);
          if (e.type === 'figure') ref(where, 'figure', e.id, figures);
          if (e.type === 'research') ref(where, 'research record', e.id, research);
          if (e.type === 'assumption') ref(where, 'assumption', e.id, assumptions);
          if (e.type === 'context') ref(where, 'context record', e.id, context);
          if (e.type === 'account') ref(where, 'account', e.id, accounts);
        }
        break;
      }
      case 'context': {
        const d = input.record.detail;
        ref(where, 'account', d.accountId, accounts);
        ref(where, 'institution', d.institutionId, institutions);
        ref(where, 'instrument', d.instrumentId, instruments);
        for (const id of d.accountIds ?? []) ref(where, 'account', id, accounts);
        break;
      }
      case 'instrument': {
        const r = input.record;
        if (r.isin) {
          const clash = store.instruments.find((x) => x.isin === r.isin && x.id !== r.id);
          if (clash) problems.push(`${where}: ISIN ${r.isin} already belongs to instrument "${clash.id}"`);
        }
        break;
      }
    }
  });
  return problems;
}

function stamp(p: Provenance): Provenance {
  return ProvenanceSchema.parse(p);
}

/**
 * Validate and write a batch. Nothing is written unless every record passes. Research records are
 * content-addressed, so writing the same findings twice is a no-op.
 */
export async function applyRecords(store: Store, input: unknown): Promise<ApplyResult> {
  const parsed = RecordBatchSchema.safeParse(input);
  if (!parsed.success) throw new RecordsError(parsed.error.issues.map((i) => `${i.path.join('.') || 'batch'}: ${i.message}`));
  const batch = parsed.data;
  const problems = checkRecords(store, batch);
  if (problems.length) throw new RecordsError(problems);

  const provenance = stamp(batch.provenance);
  const now = nowISO();
  const who = provenance.setBy === 'owner' ? 'owner' : provenance.session ? `agent (${provenance.session})` : 'agent';
  const result: ApplyResult = { written: [], skipped: [] };

  // Instruments first: other records may refer to them.
  const instrumentInputs = batch.records.filter((r): r is Extract<RecordInput, { type: 'instrument' }> => r.type === 'instrument');
  if (instrumentInputs.length) {
    const list = [...store.instruments];
    for (const { record } of instrumentInputs) {
      const id = record.id ?? slugForInstrument(record, list);
      const existing = list.find((x) => x.id === id);
      const next: Instrument = InstrumentSchema.parse({
        ...(existing ?? {}),
        ...record,
        id,
        aliases: [...new Set([...(existing?.aliases ?? []), ...record.aliases])],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (existing) list[list.indexOf(existing)] = next;
      else list.push(next);
      result.written.push({ type: 'instrument', id });
    }
    await store.setInstruments(list, `instruments: ${instrumentInputs.length} by ${who}`);
  }

  const assumptions: Assumption[] = [];
  const research: Research[] = [];
  const insights: Insight[] = [];
  const context: ContextRecord[] = [];
  for (const r of batch.records) {
    if (r.type === 'assumption') {
      const rec = AssumptionSchema.parse({ ...r.record, provenance, createdAt: now, id: `asm_${shortHash('asm', r.record.key, scopeKey(r.record.scope), r.record.value, now, randomHex(4))}` });
      assumptions.push(rec);
    } else if (r.type === 'research') {
      const id = researchIdOf(r.record);
      if (store.research.some((x) => x.id === id) || research.some((x) => x.id === id)) {
        result.skipped.push({ type: 'research', reason: `identical research already stored (${id})` });
        continue;
      }
      research.push(ResearchSchema.parse({ ...r.record, id, provenance, createdAt: now }));
    } else if (r.type === 'insight') {
      const id = `inf_${shortHash('inf', r.record.kind, JSON.stringify(r.record.subject), r.record.title, now, randomHex(4))}`;
      insights.push(InsightSchema.parse({ ...r.record, id, provenance, status: 'active', createdAt: now }));
    } else if (r.type === 'context') {
      const id = `ctx_${shortHash('ctx', r.record.kind, r.record.statement, now, randomHex(4))}`;
      context.push(ContextSchema.parse({ ...r.record, id, createdAt: now, updatedAt: now }));
    }
  }
  if (research.length) {
    await store.appendRecords('research', research, `research: ${research.length} by ${who}`);
    result.written.push(...research.map((a) => ({ type: 'research' as const, id: a.id })));
  }
  if (assumptions.length) {
    await store.appendRecords('assumptions', assumptions, `assumptions: ${assumptions.length} by ${who}`);
    result.written.push(...assumptions.map((a) => ({ type: 'assumption' as const, id: a.id })));
  }
  if (insights.length) {
    const superseded: Insight[] = [];
    if (batch.supersede) {
      const keyOf = (x: Pick<Insight, 'kind' | 'subject'>) => `${x.kind}|${JSON.stringify(x.subject)}`;
      const fresh = new Map(insights.map((x) => [keyOf(x), x.id]));
      for (const old of store.insights) {
        const replacement = fresh.get(keyOf(old));
        if (old.status === 'active' && old.provenance.setBy !== 'owner' && replacement) superseded.push({ ...old, status: 'superseded' });
      }
      for (const n of insights) {
        const prev = superseded.find((o) => keyOf(o) === keyOf(n));
        if (prev) n.supersedes = prev.id;
      }
    }
    await store.upsertRecords('insights', [...superseded, ...insights], `insights: ${insights.length} by ${who}${superseded.length ? `, ${superseded.length} superseded` : ''}`);
    result.written.push(...insights.map((a) => ({ type: 'insight' as const, id: a.id })));
  }
  if (context.length) {
    await store.upsertRecords('context', context, `context: ${context.length} by ${who}`);
    result.written.push(...context.map((a) => ({ type: 'context' as const, id: a.id })));
  }
  return result;
}

function slugForInstrument(record: { name: string; isin?: string | undefined }, taken: Instrument[]): string {
  const base = (record.isin ? record.isin.toLowerCase() : record.name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'instrument';
  const ids = new Set(taken.map((t) => t.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Your override for an assumption (or its removal, with `retire`). */
export async function setOwnerAssumption(
  store: Store,
  input: { key: string; scope: AssumptionScope; value?: number; range?: { low: number; high: number }; rationale?: string; retire?: boolean },
): Promise<Assumption> {
  const current = [...store.assumptions].reverse().find((a) => a.key === input.key && scopeKey(a.scope) === scopeKey(input.scope) && a.provenance.setBy === 'owner');
  if (input.retire) {
    if (!current || current.status === 'retired') throw new StoreError('There is no override to remove.', 404);
    const retired = AssumptionSchema.parse({
      ...current,
      id: `asm_${shortHash('asm', input.key, scopeKey(input.scope), 'retire', nowISO(), randomHex(4))}`,
      status: 'retired',
      rationale: input.rationale ?? 'Override removed.',
      createdAt: nowISO(),
    });
    await store.appendRecords('assumptions', [retired], `assumption: remove your ${input.key} override`);
    return retired;
  }
  if (input.value === undefined) throw new StoreError('A value is needed.', 400);
  const batch: RecordBatch = {
    provenance: { setBy: 'owner' },
    supersede: false,
    records: [
      {
        type: 'assumption',
        record: {
          key: input.key,
          scope: input.scope,
          value: input.value,
          ...(input.range ? { range: input.range } : {}),
          asOf: nowISO().slice(0, 10),
          source: 'Your override',
          evidence: [],
          basedOn: [],
          rationale: input.rationale?.trim() || 'Set by you.',
          status: 'active',
        },
      },
    ],
  };
  const res = await applyRecords(store, batch);
  const id = res.written[0]!.id;
  return store.assumptions.find((a) => a.id === id)!;
}
