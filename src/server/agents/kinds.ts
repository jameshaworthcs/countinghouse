// The agent jobs: what each one sees, which tools it gets, what it must return, and how its output
// becomes records through the validated write path. docs/AGENTS.md describes the contract.
//
// Privacy boundary, by construction:
//   research-instrument, research-provider, refresh-assumptions → web tools; prompts built only from
//     public identifiers (fund names, ISINs, provider names, asset classes, public account types);
//   insights-after-import, monthly-review, interpret-note, label-imports → the owner's data, and no
//     web tools.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { LABEL_BATCH } from '../../shared/api';
import { ASSUMPTION_DEFS, AssumptionSet, formatAssumptionValue } from '../../shared/assumptions';
import { addDays, today } from '../../shared/dates';
import { ACCOUNT_TYPES, ASSET_CLASSES, CONTEXT_KINDS, INSIGHT_KINDS, INSIGHT_PAGES, INSTRUMENT_TYPES, type ImportRecord, type Insight, type Note, type Provenance, type Research } from '../../shared/schema';
import type { Analytics } from '../analytics';
import { nowISO } from '../fsutil';
import type { ProposalService } from '../proposals';
import { applyRecords, researchIdOf, type ApplyResult, type RecordBatch, type RecordInput } from '../records';
import type { Store } from '../store';
import type { AgentTool } from './claude';
import { buildDigest } from './digest';

export const JOB_KINDS = ['research-instrument', 'research-provider', 'refresh-assumptions', 'insights-after-import', 'monthly-review', 'interpret-note', 'label-imports'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobContext {
  store: Store;
  analytics: Analytics;
  params: Record<string, unknown>;
  /** Empty scratch directory the job runs in. */
  scratch: string;
  /**
   * Where a job proposes fixes to the owner's data (docs/AGENTS.md, "Proposing fixes"): its
   * `apply` calls `proposals.create(input, provenance)` with the provenance it is given, and the
   * owner applies or dismisses each. A job never changes source facts itself.
   */
  proposals?: ProposalService;
}

export interface JobOutcome {
  summary: string;
  result?: ApplyResult;
}

/**
 * Thrown by a job's `prepare` when what it was asked to do has been done meanwhile: the job ends as
 * succeeded, with this as its summary, without calling Claude.
 */
export class NothingToDo extends Error {}

export interface JobKindDef {
  kind: JobKind;
  promptVersion: string;
  /** "public": only public identifiers go in, web tools allowed. "personal": no web tools. */
  privacy: 'public' | 'personal';
  tools: AgentTool[];
  label(ctx: Pick<JobContext, 'store' | 'params'>): string;
  systemPrompt: string;
  output: z.ZodType;
  /** What Claude is given. Throws `NothingToDo` when nothing is left for it to do. */
  prepare(ctx: JobContext): Promise<string> | string;
  apply(ctx: JobContext, output: unknown, provenance: Provenance): Promise<JobOutcome>;
}

// ─── Shared output pieces ────────────────────────────────────────────────────────────────────────

const Source = z.object({ title: z.string(), url: z.string(), publisher: z.string().nullable(), quote: z.string().nullable() });
const Conf = z.enum(['high', 'medium', 'low']);
const sourcesOf = (list: z.infer<typeof Source>[]) =>
  list
    .filter((s) => /^https?:\/\//.test(s.url))
    .slice(0, 8)
    .map((s) => ({ title: s.title.slice(0, 300), url: s.url, ...(s.publisher ? { publisher: s.publisher.slice(0, 120) } : {}), ...(s.quote ? { quote: s.quote.slice(0, 600) } : {}), retrievedOn: today() }));
const isDate = (s: string | null | undefined): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const RESEARCH_SYSTEM = `You research public facts about UK investment funds, savings and investment providers, and the UK economy, for a private personal-finance app.
You know only the public identifiers in the request (fund names, ISINs, provider names, asset classes, kinds of account). You know nothing about the person the app belongs to, and you must not try to find out.
- Use WebSearch and WebFetch. Prefer primary sources: the fund manager's factsheet and KID/KIID; the provider's own rates and charges pages; the Bank of England, ONS, OBR and gov.uk; the publisher's own capital market assumptions.
- Report only figures you found on a page. For each, give the page URL, its title and publisher, and quote the exact short text that supports the key figure.
- Percentages are decimal fractions (0.22% → 0.0022; 6.5% → 0.065). Returns over more than a year are annualised. Dates are YYYY-MM-DD.
- Use null for anything you could not find. Never guess or fill gaps from memory. If sources disagree, prefer the most recent primary source and say so in notes.`;

const ANALYSIS_SYSTEM = `You are the analyst of a private UK personal-finance app. Read ./digest.json (the app's own computed figures about the owner's money) and write a few short, specific insights.
- Inference, not calculation: interpret and connect the digest's figures. Never recompute totals differently or invent numbers; quote figures as the digest gives them.
- Every insight cites evidence: ids that appear in the digest (transaction ids, account ids, context ids) or "computed" metrics named after digest fields with their values.
- UK context: tax years run 6 April to 5 April; ISA, LISA and pension allowances; the Personal Savings Allowance.
- Not regulated advice: say what the data shows and what may be worth considering. Never recommend specific products or providers.
- Respect coverage: where completeData is false or an account's data is missing, say so or avoid the conclusion.
- A balance or value marked estimated is a rough figure (often one the owner gave), not a statement figure: draw nothing from its precision. A null figure is not known; never read it as zero.
- One to three sentences each, British English, plain words, no hype, no exclamation marks. Address the owner as "you".
- Do not repeat earlier insights (in the digest) unless something changed; weigh the owner's feedback on them.
- Confidence "high" only when the data clearly shows it. Return fewer insights, or none, rather than weak ones.`;

const InsightOut = z.object({
  kind: z.enum(INSIGHT_KINDS),
  pages: z.array(z.enum(INSIGHT_PAGES)).min(1),
  subject: z.object({ accountId: z.string().nullable(), instrumentId: z.string().nullable(), category: z.string().nullable(), taxYear: z.string().nullable(), month: z.string().nullable() }),
  title: z.string(),
  body: z.string(),
  confidence: Conf,
  evidence: z.array(
    z.object({
      type: z.enum(['transactions', 'account', 'context', 'research', 'assumption', 'computed']),
      ids: z.array(z.string()).nullable(),
      id: z.string().nullable(),
      metric: z.string().nullable(),
      value: z.number().nullable(),
      label: z.string().nullable(),
    }),
  ),
  expiresInDays: z.number().int().nullable(),
});
const InsightsOut = z.object({ insights: z.array(InsightOut).max(8) });

/** Keep only evidence that resolves; drop insights left with none. */
function toInsightRecords(store: Store, list: z.infer<typeof InsightOut>[], defaults: { period?: { from: string; to: string } }): { records: RecordInput[]; dropped: number } {
  const accounts = new Set(store.accounts.map((a) => a.id));
  const context = new Set(store.context.map((c) => c.id));
  const research = new Set(store.research.map((r) => r.id));
  const assumptions = new Set(store.assumptions.map((a) => a.id));
  const instruments = new Set(store.instruments.map((i) => i.id));
  const records: RecordInput[] = [];
  let dropped = 0;
  for (const i of list) {
    const evidence: Insight['evidence'] = [];
    for (const e of i.evidence) {
      const label = e.label?.slice(0, 200) ?? undefined;
      if (e.type === 'transactions') {
        const ids = (e.ids ?? (e.id ? [e.id] : [])).filter((id) => store.transaction(id));
        if (ids.length) evidence.push({ type: 'transactions', ids: ids.slice(0, 200), ...(label ? { label } : {}) });
      } else if (e.type === 'account' && e.id && accounts.has(e.id)) evidence.push({ type: 'account', id: e.id, ...(label ? { label } : {}) });
      else if (e.type === 'context' && e.id && context.has(e.id)) evidence.push({ type: 'context', id: e.id, ...(label ? { label } : {}) });
      else if (e.type === 'research' && e.id && research.has(e.id)) evidence.push({ type: 'research', id: e.id, ...(label ? { label } : {}) });
      else if (e.type === 'assumption' && e.id && assumptions.has(e.id)) evidence.push({ type: 'assumption', id: e.id, ...(label ? { label } : {}) });
      else if (e.type === 'computed' && e.metric) evidence.push({ type: 'computed', metric: e.metric.slice(0, 120), ...(e.value !== null ? { value: e.value } : {}), ...(label ? { label } : {}) });
    }
    if (!evidence.length || !i.title.trim()) {
      dropped++;
      continue;
    }
    const subject: Insight['subject'] = {};
    if (i.subject.accountId && accounts.has(i.subject.accountId)) subject.accountId = i.subject.accountId;
    if (i.subject.instrumentId && instruments.has(i.subject.instrumentId)) subject.instrumentId = i.subject.instrumentId;
    if (i.subject.category) subject.category = i.subject.category;
    if (i.subject.taxYear && /^\d{4}\/\d{2}$/.test(i.subject.taxYear)) subject.taxYear = i.subject.taxYear;
    if (i.subject.month && /^\d{4}-\d{2}$/.test(i.subject.month)) subject.month = i.subject.month;
    records.push({
      type: 'insight',
      record: {
        kind: i.kind,
        pages: [...new Set(i.pages)],
        subject,
        title: i.title.slice(0, 160),
        body: i.body.slice(0, 4000),
        evidence,
        confidence: i.confidence,
        ...(defaults.period ? { period: defaults.period } : {}),
        expiresOn: addDays(today(), Math.min(Math.max(i.expiresInDays ?? 45, 7), 400)),
      },
    });
  }
  return { records, dropped };
}

async function writeDigest(ctx: JobContext, digest: unknown): Promise<void> {
  await writeFile(path.join(ctx.scratch, 'digest.json'), JSON.stringify(digest, null, 1));
}

// ─── research-instrument ─────────────────────────────────────────────────────────────────────────

const Nr = z.number().nullable();
const InstrumentOut = z.object({
  identity: z.object({ name: z.string().nullable(), isin: z.string().nullable(), ticker: z.string().nullable(), type: z.enum(INSTRUMENT_TYPES).nullable(), manager: z.string().nullable(), currency: z.string().nullable() }),
  facts: z.object({
    asOf: z.string().nullable(),
    ocf: Nr,
    transactionCosts: Nr,
    allocation: z.object({ equity: Nr, bond: Nr, cash: Nr, property: Nr, commodity: Nr, other: Nr }).nullable(),
    regions: z.array(z.object({ region: z.string(), weight: z.number() })),
    benchmark: z.string().nullable(),
    launchDate: z.string().nullable(),
    distribution: z.enum(['accumulation', 'income']).nullable(),
    riskIndicator: z.number().int().nullable(),
    fundSizeGbp: Nr,
    sources: z.array(Source),
    confidence: Conf,
  }),
  performance: z
    .object({
      periodEnd: z.string().nullable(),
      currency: z.string().nullable(),
      returns: z.object({ y1: Nr, y3: Nr, y5: Nr, y10: Nr, sinceLaunch: Nr }),
      benchmarkReturns: z.object({ y1: Nr, y3: Nr, y5: Nr, y10: Nr, sinceLaunch: Nr }).nullable(),
      calendarYears: z.array(z.object({ year: z.number().int(), return: z.number() })),
      volatility: z.object({ y3: Nr, y5: Nr }),
      maxDrawdown: Nr,
      sources: z.array(Source),
      confidence: Conf,
    })
    .nullable(),
  observation: z.object({ title: z.string(), body: z.string(), confidence: Conf }).nullable(),
  notes: z.string(),
});

const compact = <T extends Record<string, number | null>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Record<string, number>;

const researchInstrument: JobKindDef = {
  kind: 'research-instrument',
  promptVersion: 'research-instrument-1',
  privacy: 'public',
  tools: ['WebSearch', 'WebFetch'],
  label: ({ store, params }) => `Research ${store.instrument(String(params.instrumentId))?.name ?? String(params.instrumentId)}`,
  systemPrompt: RESEARCH_SYSTEM,
  output: InstrumentOut,
  prepare({ store, params }) {
    const i = store.instrument(String(params.instrumentId));
    if (!i) throw new Error(`Unknown instrument ${String(params.instrumentId)}`);
    // Public identifiers only.
    return [
      `Research this investment. Today is ${today()}.`,
      `- Name: ${i.name}`,
      i.isin ? `- ISIN: ${i.isin}` : '',
      i.ticker ? `- Ticker: ${i.ticker}` : '',
      i.type ? `- Type: ${i.type.replace(/_/g, ' ')}` : '',
      i.manager ? `- Manager: ${i.manager}` : '',
      '',
      'Find:',
      '1. Identity: confirm the ISIN and the share class (accumulation or income), currency, manager and type.',
      '2. From the latest factsheet and KID: ongoing charges figure (OCF), transaction costs if disclosed, asset allocation by class (equity, bond, cash, property, commodity, other; fractions summing to 1), regional split of the equity part if shown, benchmark, launch date, the KID summary risk indicator (1-7), fund size in GBP if shown, and the factsheet date (asOf).',
      '3. Historical performance to the latest month end in GBP: annualised returns over 1, 3, 5 and 10 years and since launch; the benchmark’s if shown; calendar-year returns for the last 5 years; annualised volatility over 3 or 5 years if published (else null); maximum drawdown if published.',
      '4. observation: one short, well-supported remark about its cost or make-up compared with typical UK funds of its kind, or null.',
    ]
      .filter(Boolean)
      .join('\n');
  },
  async apply({ store, params }, raw, provenance) {
    const out = InstrumentOut.parse(raw);
    const i = store.instrument(String(params.instrumentId))!;
    const records: RecordInput[] = [];
    // Fill identity blanks only; never overwrite what is there.
    const identity: Record<string, unknown> = {};
    if (!i.isin && out.identity.isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(out.identity.isin) && !store.instruments.some((x) => x.isin === out.identity.isin)) identity.isin = out.identity.isin;
    if (!i.ticker && out.identity.ticker) identity.ticker = out.identity.ticker.slice(0, 20);
    if (!i.type && out.identity.type) identity.type = out.identity.type;
    if (!i.manager && out.identity.manager) identity.manager = out.identity.manager;
    if (!i.currency && out.identity.currency && /^[A-Z]{3}$/.test(out.identity.currency)) identity.currency = out.identity.currency;
    if (Object.keys(identity).length) records.push({ type: 'instrument', record: { id: i.id, name: i.name, aliases: [], ...identity } });
    const f = out.facts;
    let factsId: string | undefined;
    const factSources = sourcesOf(f.sources);
    if (isDate(f.asOf) && factSources.length) {
      let allocation: Record<string, number> | undefined;
      if (f.allocation) {
        const a = compact(f.allocation);
        const total = Object.values(a).reduce((s, v) => s + v, 0);
        if (total > 0.9 && total < 1.1) allocation = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Math.round((v / total) * 10_000) / 10_000]));
      }
      const regionsTotal = f.regions.reduce((s, r) => s + r.weight, 0);
      const data = {
        ...(f.ocf !== null && f.ocf >= 0 && f.ocf < 0.05 ? { ocf: f.ocf } : {}),
        ...(f.transactionCosts !== null && Math.abs(f.transactionCosts) < 0.05 ? { transactionCosts: f.transactionCosts } : {}),
        ...(allocation ? { allocation } : {}),
        ...(f.regions.length && regionsTotal > 0.9 && regionsTotal < 1.1 ? { regions: Object.fromEntries(f.regions.map((r) => [r.region, r.weight])) } : {}),
        ...(f.benchmark ? { benchmark: f.benchmark } : {}),
        ...(isDate(f.launchDate) ? { launchDate: f.launchDate } : {}),
        ...(f.distribution ? { distribution: f.distribution } : {}),
        ...(f.riskIndicator !== null && f.riskIndicator >= 1 && f.riskIndicator <= 7 ? { riskIndicator: f.riskIndicator } : {}),
        ...(f.fundSizeGbp !== null && f.fundSizeGbp >= 0 ? { fundSizeGbp: f.fundSizeGbp } : {}),
        ...(out.identity.isin ? { isin: out.identity.isin } : {}),
        ...(out.identity.name ? { name: out.identity.name } : {}),
      };
      const rec = { kind: 'instrument.facts' as const, subject: { instrumentId: i.id }, asOf: f.asOf, sources: factSources, confidence: f.confidence, data, ...(out.notes ? { notes: out.notes.slice(0, 2000) } : {}) };
      factsId = researchIdOf(rec);
      records.push({ type: 'research', record: rec });
    }
    const p = out.performance;
    if (p && isDate(p.periodEnd) && sourcesOf(p.sources).length && Object.values(p.returns).some((v) => v !== null)) {
      records.push({
        type: 'research',
        record: {
          kind: 'instrument.performance',
          subject: { instrumentId: i.id },
          asOf: p.periodEnd,
          sources: sourcesOf(p.sources),
          confidence: p.confidence,
          data: {
            currency: p.currency && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'GBP',
            periodEnd: p.periodEnd,
            returns: compact(p.returns),
            ...(p.benchmarkReturns ? { benchmarkReturns: compact(p.benchmarkReturns) } : {}),
            calendarYears: p.calendarYears.filter((c) => c.year > 1900 && Math.abs(c.return) < 10).slice(-10),
            volatility: compact(p.volatility),
            ...(p.maxDrawdown !== null && p.maxDrawdown <= 0 && p.maxDrawdown >= -1 ? { maxDrawdown: p.maxDrawdown } : {}),
          },
        },
      });
    }
    if (out.observation && factsId) {
      records.push({
        type: 'insight',
        record: { kind: 'fund', pages: ['investments'], subject: { instrumentId: i.id }, title: out.observation.title.slice(0, 160), body: out.observation.body.slice(0, 4000), evidence: [{ type: 'research', id: factsId, label: 'fund research' }], confidence: out.observation.confidence, expiresOn: addDays(today(), 180) },
      });
    }
    if (!records.length) return { summary: `Found nothing usable for ${i.name}${out.notes ? `: ${out.notes.slice(0, 200)}` : ''}` };
    const result = await applyRecords(store, { provenance, supersede: true, records } satisfies RecordBatch);
    return { summary: `${i.name}: ${result.written.filter((w) => w.type === 'research').length} research record(s)${factsId ? '' : ', no factsheet found'}`, result };
  },
};

// ─── research-provider ───────────────────────────────────────────────────────────────────────────

const ProviderOut = z.object({
  rates: z
    .object({
      asOf: z.string().nullable(),
      products: z.array(z.object({ name: z.string(), accountType: z.enum(ACCOUNT_TYPES).nullable(), aer: z.number(), variable: z.boolean(), bonus: Nr, bonusEndsOn: z.string().nullable(), conditions: z.string().nullable() })),
      sources: z.array(Source),
      confidence: Conf,
    })
    .nullable(),
  fees: z
    .object({
      asOf: z.string().nullable(),
      tiers: z.array(z.object({ upToGbp: Nr, rate: z.number() })),
      capGbpPerYear: Nr,
      fixedGbpPerYear: Nr,
      accountTypes: z.array(z.enum(ACCOUNT_TYPES)),
      notes: z.string().nullable(),
      sources: z.array(Source),
      confidence: Conf,
    })
    .nullable(),
  notes: z.string(),
});

const researchProvider: JobKindDef = {
  kind: 'research-provider',
  promptVersion: 'research-provider-1',
  privacy: 'public',
  tools: ['WebSearch', 'WebFetch'],
  label: ({ store, params }) => `Research ${store.institution(String(params.institutionId))?.name ?? String(params.institutionId)} rates and charges`,
  systemPrompt: RESEARCH_SYSTEM,
  output: ProviderOut,
  prepare({ store, params }) {
    const inst = store.institution(String(params.institutionId));
    if (!inst) throw new Error(`Unknown institution ${String(params.institutionId)}`);
    // The kinds of account held there, by type only: never names, numbers or balances.
    const types = [...new Set(store.accounts.filter((a) => a.institutionId === inst.id && a.status === 'open').map((a) => a.type))];
    return [
      `Research this UK provider. Today is ${today()}.`,
      `- Provider: ${inst.name}${inst.website ? ` (${inst.website})` : ''}`,
      `- Kinds of account to cover: ${types.map((t) => `${ACCOUNT_TYPE_META[t].label} (${t})`).join('; ') || 'any'}`,
      '',
      'Find:',
      '1. rates: the current AER of its savings products of those kinds, whether variable, any introductory bonus included and when it ends, and conditions (notice, withdrawals, minimums). Null if none of those kinds pay interest.',
      '2. fees: its charges for investment or pension accounts of those kinds: percentage platform fee tiers by account value (upToGbp null on the last tier), any annual cap, any flat yearly fee, and which account types they apply to. Null if none of those kinds charge.',
      'Use the provider’s own pages first.',
    ].join('\n');
  },
  async apply({ store, params }, raw, provenance) {
    const out = ProviderOut.parse(raw);
    const inst = store.institution(String(params.institutionId))!;
    const records: RecordInput[] = [];
    if (out.rates && isDate(out.rates.asOf) && sourcesOf(out.rates.sources).length && out.rates.products.length) {
      records.push({
        type: 'research',
        record: {
          kind: 'provider.rates',
          subject: { institutionId: inst.id },
          asOf: out.rates.asOf,
          sources: sourcesOf(out.rates.sources),
          confidence: out.rates.confidence,
          data: {
            products: out.rates.products
              .filter((p) => p.aer >= 0 && p.aer < 0.25)
              .map((p) => ({ name: p.name, variable: p.variable, aer: p.aer, ...(p.accountType ? { accountType: p.accountType } : {}), ...(p.bonus !== null ? { bonus: p.bonus } : {}), ...(isDate(p.bonusEndsOn) ? { bonusEndsOn: p.bonusEndsOn } : {}), ...(p.conditions ? { conditions: p.conditions } : {}) })),
          },
        },
      });
    }
    if (out.fees && isDate(out.fees.asOf) && sourcesOf(out.fees.sources).length && (out.fees.tiers.length || out.fees.fixedGbpPerYear !== null)) {
      records.push({
        type: 'research',
        record: {
          kind: 'provider.fees',
          subject: { institutionId: inst.id },
          asOf: out.fees.asOf,
          sources: sourcesOf(out.fees.sources),
          confidence: out.fees.confidence,
          data: {
            tiers: out.fees.tiers.filter((t) => t.rate >= 0 && t.rate < 0.05).map((t) => ({ rate: t.rate, ...(t.upToGbp !== null && t.upToGbp > 0 ? { upToGbp: t.upToGbp } : {}) })),
            ...(out.fees.capGbpPerYear !== null ? { capGbpPerYear: out.fees.capGbpPerYear } : {}),
            ...(out.fees.fixedGbpPerYear !== null ? { fixedGbpPerYear: out.fees.fixedGbpPerYear } : {}),
            ...(out.fees.accountTypes.length ? { accountTypes: out.fees.accountTypes } : {}),
            ...(out.fees.notes ? { notes: out.fees.notes } : {}),
          },
        },
      });
    }
    if (!records.length) return { summary: `Found no current rates or charges for ${inst.name}${out.notes ? `: ${out.notes.slice(0, 200)}` : ''}` };
    const result = await applyRecords(store, { provenance, supersede: false, records });
    return { summary: `${inst.name}: ${records.map((r) => (r.type === 'research' ? r.record.kind : r.type)).join(', ')}`, result };
  },
};

// ─── refresh-assumptions ─────────────────────────────────────────────────────────────────────────

const AssumptionsOut = z.object({
  indicators: z.array(
    z.object({ indicator: z.enum(['cpi', 'earnings', 'bank-rate', 'house-prices', 'gilt-yield']), basis: z.enum(['latest', 'forecast', 'target']), value: z.number(), period: z.string(), publisher: z.string(), asOf: z.string(), sources: z.array(Source) }),
  ),
  outlooks: z.array(
    z.object({ assetClass: z.enum(ASSET_CLASSES), publisher: z.string(), horizonYears: z.number().int(), currency: z.string(), expectedReturnNominal: Nr, expectedReturnReal: Nr, rangeLow: Nr, rangeHigh: Nr, volatility: Nr, asOf: z.string(), sources: z.array(Source) }),
  ),
  assumptions: z.array(
    z.object({
      key: z.string(),
      assetClass: z.enum(ASSET_CLASSES).nullable(),
      value: z.number(),
      low: z.number(),
      high: z.number(),
      rationale: z.string(),
      basedOn: z.array(z.object({ type: z.enum(['indicator', 'outlook']), index: z.number().int() })),
      sources: z.array(Source),
    }),
  ),
  notes: z.string(),
});

export const REFRESHABLE_KEYS = ['inflation', 'earnings.growth', 'return.expected', 'return.volatility', 'withdrawal.rate', 'property.growth'];

const refreshAssumptions: JobKindDef = {
  kind: 'refresh-assumptions',
  promptVersion: 'refresh-assumptions-1',
  privacy: 'public',
  tools: ['WebSearch', 'WebFetch'],
  label: () => 'Refresh modelling assumptions from current research',
  systemPrompt: RESEARCH_SYSTEM,
  output: AssumptionsOut,
  prepare({ store }) {
    const set = new AssumptionSet(store.assumptions, today());
    // Asset classes held, as classes only (no amounts).
    const classes = [...new Set(['equity', 'bond', 'cash', ...store.instruments.flatMap((i) => Object.keys(i.allocation ?? {}))])];
    const current = REFRESHABLE_KEYS.flatMap((key) =>
      key.startsWith('return.')
        ? classes.map((c) => {
            const r = set.resolve(key, { assetClass: c as (typeof ASSET_CLASSES)[number] });
            return `- ${key} (${c}): ${formatAssumptionValue(key, r.value)} — ${r.source === 'fallback' ? 'app fallback' : (r.record?.source ?? r.source)}`;
          })
        : [`- ${key}: ${formatAssumptionValue(key, set.resolve(key).value)} — ${set.resolve(key).source === 'fallback' ? 'app fallback' : (set.resolve(key).record?.source ?? '')}`],
    );
    return [
      `Set long-run, forward-looking modelling assumptions for a UK household's financial projections, from current published evidence. Today is ${today()}.`,
      `Asset classes to cover: ${classes.join(', ')}.`,
      '',
      'For each key, propose a value and a plausible range (the 10th to 90th percentile of the long-run average), with the sources and your reasoning:',
      '- inflation: UK CPI inflation a year over the long run (the Bank of England target, OBR and market-implied figures are the evidence).',
      '- earnings.growth: UK average earnings growth a year over the long run, nominal (OBR long-term assumptions).',
      '- return.expected, per asset class: expected nominal annual return in GBP, before fund charges, over 10+ years. Use published capital market assumptions from several major managers (e.g. Vanguard, BlackRock, J.P. Morgan, Schroders) and long-run history; record each outlook you use under outlooks.',
      '- return.volatility, per asset class: annualised volatility.',
      '- withdrawal.rate: a sustainable initial withdrawal rate for a UK retiree over about 30 years, rising with inflation; cite UK-specific studies.',
      '- property.growth: UK house prices a year over the long run, nominal.',
      'Record the indicators (CPI, earnings, Bank Rate…) and outlooks you rely on under indicators and outlooks, and link each assumption to them with basedOn (by type and index).',
      '',
      'Current values, for reference only (do not anchor on them):',
      ...current,
    ].join('\n');
  },
  async apply({ store }, raw, provenance) {
    const out = AssumptionsOut.parse(raw);
    const records: RecordInput[] = [];
    const indicatorIds: (string | undefined)[] = [];
    const outlookIds: (string | undefined)[] = [];
    for (const i of out.indicators) {
      const sources = sourcesOf(i.sources);
      if (!isDate(i.asOf) || !sources.length || Math.abs(i.value) > 1) {
        indicatorIds.push(undefined);
        continue;
      }
      const rec = { kind: 'economy.indicator' as const, subject: { topic: i.indicator }, asOf: i.asOf, sources, confidence: 'medium' as const, data: { indicator: i.indicator, basis: i.basis, value: i.value, period: i.period.slice(0, 40), publisher: i.publisher } };
      indicatorIds.push(researchIdOf(rec));
      records.push({ type: 'research', record: rec });
    }
    for (const o of out.outlooks) {
      const sources = sourcesOf(o.sources);
      if (!isDate(o.asOf) || !sources.length || o.horizonYears < 1) {
        outlookIds.push(undefined);
        continue;
      }
      const rec = {
        kind: 'market.outlook' as const,
        subject: { assetClass: o.assetClass },
        asOf: o.asOf,
        sources,
        confidence: 'medium' as const,
        data: {
          assetClass: o.assetClass,
          publisher: o.publisher,
          horizonYears: Math.min(o.horizonYears, 50),
          currency: /^[A-Z]{3}$/.test(o.currency) ? o.currency : 'GBP',
          ...(o.expectedReturnNominal !== null ? { expectedReturnNominal: o.expectedReturnNominal } : {}),
          ...(o.expectedReturnReal !== null ? { expectedReturnReal: o.expectedReturnReal } : {}),
          ...(o.rangeLow !== null && o.rangeHigh !== null ? { range: { low: o.rangeLow, high: o.rangeHigh } } : {}),
          ...(o.volatility !== null ? { volatility: o.volatility } : {}),
        },
      };
      outlookIds.push(researchIdOf(rec));
      records.push({ type: 'research', record: rec });
    }
    const keys = new Set(ASSUMPTION_DEFS.map((d) => d.key));
    let skipped = 0;
    for (const a of out.assumptions) {
      if (!keys.has(a.key) || !REFRESHABLE_KEYS.includes(a.key) || a.low > a.value || a.high < a.value) {
        skipped++;
        continue;
      }
      const perClass = a.key.startsWith('return.');
      if (perClass && !a.assetClass) {
        skipped++;
        continue;
      }
      const basedOn = a.basedOn.map((b) => (b.type === 'indicator' ? indicatorIds[b.index] : outlookIds[b.index])).filter((x): x is string => Boolean(x));
      const evidence = sourcesOf(a.sources);
      if (!basedOn.length && !evidence.length) {
        skipped++;
        continue;
      }
      // Who the value rests on: the research it cites, then its own sources.
      const publishers = [...new Set([...a.basedOn.map((b) => (b.type === 'indicator' ? out.indicators[b.index]?.publisher : out.outlooks[b.index]?.publisher)), ...evidence.map((e) => e.publisher)].filter(Boolean))];
      records.push({
        type: 'assumption',
        record: {
          key: a.key,
          scope: perClass ? { kind: 'assetClass', assetClass: a.assetClass! } : { kind: 'global' },
          value: a.value,
          range: { low: a.low, high: a.high },
          asOf: today(),
          source: publishers.length ? `Research: ${publishers.join(', ')}`.slice(0, 300) : 'Research',
          evidence,
          basedOn,
          rationale: a.rationale.slice(0, 2000),
          status: 'active',
          reviewBy: addDays(today(), 182),
        },
      });
    }
    // Drop assumptions a validation problem would reject (e.g. out of bounds), rather than failing all.
    const ok = records.filter((r) => r.type !== 'assumption' || (r.record.value >= (ASSUMPTION_DEFS.find((d) => d.key === r.record.key)?.min ?? -Infinity) && r.record.value <= (ASSUMPTION_DEFS.find((d) => d.key === r.record.key)?.max ?? Infinity)));
    skipped += records.length - ok.length;
    if (!ok.length) return { summary: `No usable assumptions${out.notes ? `: ${out.notes.slice(0, 200)}` : ''}` };
    const result = await applyRecords(store, { provenance, supersede: false, records: ok });
    return { summary: `${result.written.filter((w) => w.type === 'assumption').length} assumption(s) and ${result.written.filter((w) => w.type === 'research').length} research record(s)${skipped ? `; ${skipped} proposal(s) skipped` : ''}`, result };
  },
};

// ─── insights-after-import and monthly-review ────────────────────────────────────────────────────

const insightsAfterImport: JobKindDef = {
  kind: 'insights-after-import',
  promptVersion: 'insights-after-import-3',
  privacy: 'personal',
  tools: ['Read'],
  label: ({ params }) => `Insights from ${(params.importIds as string[] | undefined)?.length ?? 0} new import(s)`,
  systemPrompt: ANALYSIS_SYSTEM,
  output: InsightsOut,
  async prepare(ctx) {
    await writeDigest(ctx, buildDigest(ctx.store, ctx.analytics, { importIds: (ctx.params.importIds as string[]) ?? [] }));
    return [
      'Read ./digest.json with the Read tool.',
      'Imports were just committed (digest.focus.imports). Write up to 4 insights about what they show that you (the owner) would want to know now:',
      'unusual or new spending, a regular payment that changed or stopped, income that looks late or different, a large one-off, allowance progress, or anything that looks like a data problem.',
      'Each import lists what it added (transactions, balances, holdings, figures). A screenshot of a value or holdings, a payslip or a voucher adds no transactions and is not empty; an import that added nothing at all was kept as a record of a document another import covers, not a failure.',
      'Pick the pages each belongs on (overview, spending, accounts, transactions, tax, investments, projections). Set expiresInDays to how long it stays useful. Return an empty list if nothing is notable.',
    ].join('\n');
  },
  async apply({ store }, raw, provenance) {
    const out = InsightsOut.parse(raw);
    const { records, dropped } = toInsightRecords(store, out.insights, {});
    if (!records.length) return { summary: dropped ? `No insights kept (${dropped} cited nothing that exists)` : 'Nothing notable' };
    const result = await applyRecords(store, { provenance, supersede: false, records });
    return { summary: `${records.length} insight(s)${dropped ? `; ${dropped} dropped for missing evidence` : ''}`, result };
  },
};

const monthlyReview: JobKindDef = {
  kind: 'monthly-review',
  promptVersion: 'monthly-review-2',
  privacy: 'personal',
  tools: ['Read'],
  label: ({ params }) => `Month in review: ${String(params.month)}`,
  systemPrompt: ANALYSIS_SYSTEM,
  output: InsightsOut,
  async prepare(ctx) {
    const month = String(ctx.params.month);
    await writeDigest(ctx, buildDigest(ctx.store, ctx.analytics, { month }));
    return [
      'Read ./digest.json with the Read tool.',
      `Review ${month} (digest.focus). Write:`,
      `1. Exactly one insight of kind "month-review" for the overview page, with subject.month "${month}": a short paragraph on the month — income, spending against recent months, saving, notable changes, and the estate value — citing computed figures.`,
      '2. Up to 5 more, only where the data supports them:',
      '   - habit changes, for spending;',
      '   - allowance opportunities, for tax (ISA, LISA or pension headroom and days left, Personal Savings Allowance headroom);',
      '   - notes on investments (charges, make-up, drift from what the owner said they want);',
      '   - how the month bears on the owner’s plans (digest.ownerContext), for projections.',
      'Set subject.month to the month for every insight about it.',
    ].join('\n');
  },
  async apply({ store, params }, raw, provenance) {
    const out = InsightsOut.parse(raw);
    const month = String(params.month);
    const { records, dropped } = toInsightRecords(
      store,
      out.insights.map((i) => ({ ...i, subject: { ...i.subject, month } })),
      { period: { from: `${month}-01`, to: `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}` } },
    );
    if (!records.length) return { summary: dropped ? `No insights kept (${dropped} cited nothing that exists)` : 'Nothing to say' };
    const result = await applyRecords(store, { provenance, supersede: true, records });
    return { summary: `${records.length} insight(s) for ${month}${dropped ? `; ${dropped} dropped for missing evidence` : ''}`, result };
  },
};

// ─── interpret-note ──────────────────────────────────────────────────────────────────────────────

const NoteOut = z.object({
  reply: z.string(),
  proposals: z.array(
    z.object({
      type: z.enum(['context', 'instrument']),
      explanation: z.string(),
      context: z
        .object({
          kind: z.enum(CONTEXT_KINDS),
          statement: z.string(),
          detail: z.object({
            accountId: z.string().nullable(),
            instrumentId: z.string().nullable(),
            event: z.string().nullable(),
            amount: Nr,
            annualAmount: Nr,
            rate: Nr,
            date: z.string().nullable(),
            from: z.string().nullable(),
            to: z.string().nullable(),
            accountIds: z.array(z.string()),
          }),
        })
        .nullable(),
      instrument: z.object({ name: z.string(), isin: z.string().nullable(), ticker: z.string().nullable(), type: z.enum(INSTRUMENT_TYPES).nullable(), manager: z.string().nullable() }).nullable(),
    }),
  ),
});

const interpretNote: JobKindDef = {
  kind: 'interpret-note',
  promptVersion: 'interpret-note-1',
  privacy: 'personal',
  tools: [],
  label: () => 'Understand what you told the app',
  systemPrompt: `You turn what the owner of a private UK personal-finance app tells it, in plain words, into structured records for them to confirm.
- Record only what they said. Do not add assumptions, advice or anything they did not state.
- One record per distinct fact or plan. Kinds: holding (an investment they hold, and where), plan (something they intend to do, with a date), goal (a target amount or state), preference (how they want to be treated or what they care about), income (pay, bonuses, pensions), household (people and dependants), property (homes and their values), fact (anything else about their finances).
- statement: one plain sentence in the second person ("You plan to buy a house in 2028 for about £400,000").
- detail: link to their accounts and instruments by the ids listed (never invent ids); money in pounds; dates YYYY-MM-DD (when only a year or month is given, use its last day and say so in the explanation).
- An investment they name that is not in the instruments list becomes an instrument proposal too (name as they said it, ISIN or ticker only if they gave it).
- reply: one short sentence back to them saying what you understood.`,
  output: NoteOut,
  prepare({ store, params }) {
    const note = store.notes.find((n) => n.id === params.noteId);
    if (!note) throw new Error(`Unknown note ${String(params.noteId)}`);
    return [
      `Today is ${today()}. The owner wrote:`,
      '"""',
      note.text,
      '"""',
      '',
      'Their accounts (id: name, type, provider):',
      ...store.accounts.filter((a) => a.status === 'open').map((a) => `- ${a.id}: ${a.name}, ${a.type}${a.institutionId ? `, ${store.institution(a.institutionId)?.name ?? a.institutionId}` : ''}`),
      '',
      'Instruments already known (id: name, ISIN):',
      ...(store.instruments.length ? store.instruments.map((i) => `- ${i.id}: ${i.name}${i.isin ? `, ${i.isin}` : ''}`) : ['- none']),
      '',
      'Context already recorded (do not duplicate):',
      ...(store.context.filter((c) => c.status === 'active').map((c) => `- ${c.kind}: ${c.statement}`) || []),
    ].join('\n');
  },
  async apply({ store, params }, raw, provenance) {
    const out = NoteOut.parse(raw);
    const note = store.notes.find((n) => n.id === params.noteId)!;
    const accounts = new Set(store.accounts.map((a) => a.id));
    const instruments = new Set(store.instruments.map((i) => i.id));
    const proposals: Note['proposals'] = [];
    out.proposals.forEach((p, i) => {
      if (p.type === 'context' && p.context) {
        const d = p.context.detail;
        const detail: Record<string, unknown> = {};
        if (d.accountId && accounts.has(d.accountId)) detail.accountId = d.accountId;
        if (d.instrumentId && instruments.has(d.instrumentId)) detail.instrumentId = d.instrumentId;
        if (d.event) detail.event = d.event.slice(0, 40);
        for (const k of ['amount', 'annualAmount'] as const) {
          const v = d[k];
          if (v !== null) detail[k] = Math.round(v * 100) / 100;
        }
        if (d.rate !== null && Math.abs(d.rate) <= 1) detail.rate = d.rate;
        for (const k of ['date', 'from', 'to'] as const) if (isDate(d[k])) detail[k] = d[k];
        const ids = d.accountIds.filter((x) => accounts.has(x));
        if (ids.length) detail.accountIds = ids;
        proposals.push({ key: `p${i}`, type: 'context', record: { kind: p.context.kind, statement: p.context.statement.slice(0, 1000), detail }, explanation: p.explanation.slice(0, 500) });
      } else if (p.type === 'instrument' && p.instrument) {
        const isin = p.instrument.isin?.toUpperCase();
        proposals.push({
          key: `p${i}`,
          type: 'instrument',
          record: { name: p.instrument.name.slice(0, 200), aliases: [], ...(isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? { isin } : {}), ...(p.instrument.ticker ? { ticker: p.instrument.ticker.slice(0, 20) } : {}), ...(p.instrument.type ? { type: p.instrument.type } : {}), ...(p.instrument.manager ? { manager: p.instrument.manager } : {}) },
          explanation: p.explanation.slice(0, 500),
        });
      }
    });
    await store.upsertRecords('notes', [{ ...note, status: proposals.length ? 'proposed' : 'applied', proposals, ...(provenance.jobId ? { jobId: provenance.jobId } : {}), updatedAt: nowISO() }], 'note: interpreted');
    return { summary: `${out.reply}${proposals.length ? ` (${proposals.length} to confirm)` : ''}`.slice(0, 500) };
  },
};

// ─── label-imports ───────────────────────────────────────────────────────────────────────────────
// A name for each committed import, to find it by in History. It sees what the import's reading
// and review said the document was (its kind, provider, accounts, dates, employer), never amounts,
// account numbers or references, and has no tools.

/**
 * The imports a `label-imports` job names: those it was given (`importIds`), or else the latest
 * committed, that have no name yet. A name is never replaced, Claude's or yours: an import named
 * again has had its name taken away first.
 */
export function importsToLabel(store: Store, params: Record<string, unknown>): string[] {
  const asked = Array.isArray(params.importIds) ? new Set(params.importIds.map(String)) : undefined;
  return store.imports
    .filter((i) => i.committedAt && !i.label && (!asked || asked.has(i.id)))
    .sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? ''))
    .slice(0, LABEL_BATCH)
    .map((i) => i.id);
}

/**
 * What the job is told about one import: what it is, never what it says in figures. It is known by
 * `ref`, its place in the list (1, 2, 3…), which is easier to give back without a slip than an id.
 */
export function labelFacts(store: Store, r: ImportRecord, ref: number): Record<string, unknown> {
  const d = r.draft;
  const accounts = (d?.sections ?? [])
    .filter((s) => s.target.mode !== 'skip')
    .map((s) => {
      const id = r.result?.sections?.find((x) => x.key === s.key)?.accountId ?? (s.target.mode === 'existing' ? s.target.accountId : s.target.mode === 'new' ? s.target.account.id : undefined);
      const account = id ? store.account(id) : undefined;
      const dates = s.transactions.map((t) => t.date).sort();
      const from = s.periodStart ?? dates[0];
      const to = s.periodEnd ?? dates[dates.length - 1] ?? s.balanceDate;
      return {
        name: account?.name ?? s.detected.accountName ?? null,
        type: account?.type ?? s.detected.accountType ?? null,
        provider: (account?.institutionId ? store.institution(account.institutionId)?.name : undefined) ?? s.detected.institutionName ?? null,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(s.transactions.length ? { rows: s.transactions.length } : {}),
        ...(s.holdings?.length ? { holdings: s.holdings.length } : {}),
      };
    });
  const unique = <T>(list: T[]) => [...new Set(list.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x) as T);
  const figures = unique((d?.figures ?? []).map((f) => ({ kind: f.kind, ...(f.taxYear ? { taxYear: f.taxYear } : {}), ...(f.payer ? { payer: f.payer } : {}), ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}) }))).slice(0, 8);
  const payslips = (d?.payslips ?? []).slice(0, 4).map((p) => ({ employer: p.record.employer, payDate: p.record.payDate, ...(p.record.periodLabel ? { period: p.record.periodLabel } : {}) }));
  const hmrc = [...new Set((d?.hmrc ?? []).map((h) => h.record.type))];
  const employers = [...new Set((d?.jobs ?? []).map((j) => j.employer))];
  return {
    ref,
    fileName: r.document.fileName,
    fileType: r.document.mediaType,
    uploadedOn: r.createdAt.slice(0, 10),
    ...(r.document.capturedOn ? { capturedOn: r.document.capturedOn } : {}),
    ...(d ? { documentType: d.documentType } : {}),
    ...(d?.institutionName ? { provider: d.institutionName } : {}),
    ...(d?.documentDate ? { documentDate: d.documentDate } : {}),
    ...(accounts.length ? { accounts } : {}),
    ...(figures.length ? { figures } : {}),
    ...(payslips.length ? { payslips } : {}),
    ...(hmrc.length ? { hmrcRecords: hmrc } : {}),
    ...(employers.length ? { employers } : {}),
    ...(r.result?.nothingNew ? { filedWithNothingNew: true } : {}),
  };
}

/** A name as kept: one line, no wrapping quotes, at most 120 characters. */
export function cleanLabel(text: string): string | undefined {
  const t = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return t.length >= 3 && t.length <= 120 ? t : undefined;
}

const LabelsOut = z.object({ labels: z.array(z.object({ ref: z.number().int(), label: z.string() })).max(LABEL_BATCH) });
/** The imports a run showed Claude, in ref order, kept in its scratch directory until it ends. */
const SHOWN_FILE = 'imports.json';

const labelImports: JobKindDef = {
  kind: 'label-imports',
  promptVersion: 'label-imports-2',
  privacy: 'personal',
  tools: [],
  label: ({ params }) => (Array.isArray(params.importIds) ? `Name ${params.importIds.length === 1 ? 'an import' : `${params.importIds.length} imports`}` : 'Name imports that have no name'),
  systemPrompt: `You name the documents imported into a private UK personal-finance app, so the owner can find each one again in a list of hundreds. You are given what the app read from each document (its kind, provider, accounts, dates), not the document itself.
- One name per import, at most 70 characters, sentence case, in British English: what the document is, whose it is (provider or employer) and when.
- Lead with the provider or employer, then the document, then its date or period: "Monzo current account statement, Sep 2026", "Vanguard ISA holdings screenshot, 14 Mar 2026", "P60 from Example Ltd, 2025/26", "Example Ltd payslip, 31 Aug 2026", "HMRC tax code notice, 2026/27".
- Dates: a whole month as "Sep 2026"; a range as "12 Aug – 11 Sep 2026" (or "Aug – Sep 2026" when it runs month to month); one day as "14 Mar 2026"; a tax year as "2025/26". Prefer the period the document covers over the day it was uploaded; use the capture date for a screenshot.
- Name the account the way the facts do ("current account", "credit card", "cash ISA", or its own name when that tells it apart). Several accounts: name the provider and say "statements" or the accounts in brief.
- Use only the facts given. Never include amounts, balances, account or card numbers, references or people's names. When little is known, say what kind of file it is and its date.
- Imports that are different documents get different names: include what tells them apart.
- Return one name for every import you were given, by its ref.`,
  output: LabelsOut,
  async prepare({ store, params, scratch }) {
    const shown: string[] = [];
    const facts: Record<string, unknown>[] = [];
    for (const id of importsToLabel(store, params)) {
      const r = await store.readImport(id);
      if (!r) continue;
      shown.push(id);
      facts.push(labelFacts(store, r, shown.length));
    }
    // A run queued after imports were committed finds them named already when another got there first.
    if (!shown.length) throw new NothingToDo('Nothing to name: every import it was asked about has a name');
    // The names are kept for exactly these, whatever is committed while Claude is at it.
    await writeFile(path.join(scratch, SHOWN_FILE), JSON.stringify(shown));
    return [`Today is ${today()}. Name these ${facts.length} imports:`, '', ...facts.map((f) => JSON.stringify(f))].join('\n');
  },
  async apply({ store, scratch }, raw, provenance) {
    const out = LabelsOut.parse(raw);
    const shown = z.array(z.string()).parse(JSON.parse(await readFile(path.join(scratch, SHOWN_FILE), 'utf8')));
    const waiting = new Set(shown);
    let named = 0;
    let skipped = 0;
    for (const l of out.labels) {
      const id = shown[l.ref - 1];
      const text = cleanLabel(l.label);
      const r = id && waiting.has(id) ? await store.readImport(id) : undefined;
      // A ref it was not given (or gave twice), or a name that is no name.
      if (!text || !r) {
        skipped++;
        continue;
      }
      waiting.delete(r.id);
      // A name you gave meanwhile is kept.
      if (r.label) {
        skipped++;
        continue;
      }
      await store.saveImport({ ...r, label: { text, provenance, at: nowISO() } }, `import: ${r.id} named by the agent`);
      named++;
    }
    return { summary: `Named ${named} import${named === 1 ? '' : 's'}${skipped ? `; ${skipped} name${skipped === 1 ? '' : 's'} not kept` : ''}${waiting.size ? `; ${waiting.size} not named` : ''}` };
  },
};

export const JOB_DEFS: Record<JobKind, JobKindDef> = {
  'research-instrument': researchInstrument,
  'research-provider': researchProvider,
  'refresh-assumptions': refreshAssumptions,
  'insights-after-import': insightsAfterImport,
  'monthly-review': monthlyReview,
  'interpret-note': interpretNote,
  'label-imports': labelImports,
};

/** The JSON Schema handed to --json-schema for a job's output. */
export function outputJsonSchema(def: JobKindDef): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(def.output, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  return rest;
}

export type { Research };
