// Agent jobs without calling Claude: the privacy boundary of the prompts, and how each job's
// output becomes records through the validated write path.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentArgs } from '../src/server/agents/claude';
import { JobRunner } from '../src/server/agents/jobs';
import { JOB_DEFS, outputJsonSchema, type JobContext } from '../src/server/agents/kinds';
import { Analytics } from '../src/server/analytics';
import { loadConfig } from '../src/server/config';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { AssumptionSet } from '../src/shared/assumptions';
import type { Account, Transaction } from '../src/shared/schema';

const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, name: string, type: Account['type'], institutionId: string): Account => ({ id, name, type, institutionId, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp });
const provenance = { setBy: 'agent' as const, model: 'claude-test', promptVersion: 'test', jobId: 'job_test' };

let dir: string;
let store: Store;
let ctx: (params: Record<string, unknown>) => JobContext;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-agents-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.upsertInstitution({ id: 'vanguard', name: 'Vanguard Investor', kind: 'investment_platform' });
  await store.upsertInstitution({ id: 'marcus', name: 'Marcus by Goldman Sachs', kind: 'bank' });
  await store.setAccounts([acct('isa', 'Joint ISA for Sam and Priya', 'stocks_isa', 'vanguard'), acct('saver', 'Rainy Day Pot 4471', 'savings', 'marcus'), acct('current', 'Current', 'current', 'marcus')]);
  await store.addBalances([{ id: 'bal_00000000000000a1', accountId: 'isa', date: '2026-09-01', balance: 48_123.45, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp }], 'b');
  await store.addHoldings(
    [{ id: 'hld_00000000000000a1', accountId: 'isa', date: '2026-09-01', holdings: [{ name: 'Vanguard LifeStrategy 80% Equity Fund Acc', isin: 'GB00B4PQW151', units: 120.5, value: 48_000, currency: 'GBP' }], totalValue: 48_123.45, source: {}, createdAt: stamp }],
    'h',
  );
  const analytics = new Analytics(store);
  ctx = (params) => ({ store, analytics, params, scratch: dir });
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

describe('privacy boundary', () => {
  it('research jobs get only web tools; jobs that read your data get none', () => {
    for (const def of Object.values(JOB_DEFS)) {
      if (def.privacy === 'public') expect(def.tools).toEqual(['WebSearch', 'WebFetch']);
      else expect(def.tools.every((t) => t === 'Read')).toBe(true);
    }
    const args = agentArgs({ schema: {}, tools: [], model: 'opus', effort: 'high', systemPrompt: 's' });
    expect(args).toContain('--restricted');
    expect(args).toContain('--safe-mode');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('research prompts carry public identifiers only: no balances, holdings, account names or numbers', async () => {
    const runner = new JobRunner(store, new Analytics(store), loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), { autoRun: false });
    await runner.init();
    expect(await runner.ensureInstrumentsFromHoldings()).toBe(1);
    const instrumentId = store.instruments[0]!.id;
    const prompts = [
      await JOB_DEFS['research-instrument'].prepare(ctx({ instrumentId })),
      await JOB_DEFS['research-provider'].prepare(ctx({ institutionId: 'marcus' })),
      await JOB_DEFS['research-provider'].prepare(ctx({ institutionId: 'vanguard' })),
      await JOB_DEFS['refresh-assumptions'].prepare(ctx({})),
    ].join('\n');
    for (const secret of ['48123', '48,123', '48000', '48,000', '120.5', 'Sam', 'Priya', 'Rainy Day', '4471']) expect(prompts).not.toContain(secret);
    expect(prompts).toContain('GB00B4PQW151');
    expect(prompts).toContain('Marcus by Goldman Sachs');
    runner.stop();
  });

  it('analysis jobs read a digest from their scratch directory', async () => {
    const prompt = await JOB_DEFS['monthly-review'].prepare(ctx({ month: '2026-08' }));
    expect(prompt).toMatch(/digest\.json/);
    const digest = JSON.parse(await readFile(path.join(dir, 'digest.json'), 'utf8')) as Record<string, unknown>;
    expect(digest).toHaveProperty('accounts');
    expect(JSON.stringify(digest)).not.toMatch(/"name":"[^"]*Taylor/);
  });

  it('every job’s output schema is strict JSON Schema', () => {
    for (const def of Object.values(JOB_DEFS)) {
      const schema = outputJsonSchema(def);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe('job outputs become records', () => {
  const source = { title: 'Factsheet', url: 'https://www.example.com/factsheet', publisher: 'Vanguard', quote: 'OCF 0.20%' };

  it('research-instrument: fills identity blanks, records facts and performance, and a fund note', async () => {
    await store.setInstruments([{ id: 'ls80', name: 'Vanguard LifeStrategy 80', aliases: [], createdAt: stamp, updatedAt: stamp }]);
    const out = {
      identity: { name: 'Vanguard LifeStrategy 80% Equity Fund A Acc', isin: 'GB00B4PQW151', ticker: null, type: 'fund', manager: 'Vanguard', currency: 'GBP' },
      facts: { asOf: '2026-08-31', ocf: 0.002, transactionCosts: 0.0003, allocation: { equity: 0.8, bond: 0.2, cash: null, property: null, commodity: null, other: null }, regions: [], benchmark: 'LifeStrategy 80 composite', launchDate: '2011-06-23', distribution: 'accumulation', riskIndicator: 4, fundSizeGbp: null, sources: [source], confidence: 'high' },
      performance: { periodEnd: '2026-08-31', currency: 'GBP', returns: { y1: 0.081, y3: 0.064, y5: 0.057, y10: 0.071, sinceLaunch: null }, benchmarkReturns: null, calendarYears: [{ year: 2025, return: 0.09 }], volatility: { y3: 0.098, y5: null }, maxDrawdown: null, sources: [source], confidence: 'high' },
      observation: { title: 'A low-cost multi-asset fund', body: 'Its charge is below the typical UK multi-asset fund.', confidence: 'medium' },
      notes: '',
    };
    const res = await JOB_DEFS['research-instrument'].apply(ctx({ instrumentId: 'ls80' }), out, provenance);
    expect(res.summary).toMatch(/2 research record/);
    expect(store.instrument('ls80')).toMatchObject({ isin: 'GB00B4PQW151', manager: 'Vanguard', type: 'fund' });
    expect(store.research.map((r) => r.kind).sort()).toEqual(['instrument.facts', 'instrument.performance']);
    const facts = store.research.find((r) => r.kind === 'instrument.facts')!;
    expect(facts.data).toMatchObject({ ocf: 0.002, allocation: { equity: 0.8, bond: 0.2 } });
    expect(facts.provenance).toMatchObject(provenance);
    expect(store.insights[0]).toMatchObject({ kind: 'fund', evidence: [{ type: 'research', id: facts.id }] });
  });

  it('refresh-assumptions: research first, then assumptions citing it; bad proposals skipped', async () => {
    const out = {
      indicators: [{ indicator: 'cpi', basis: 'target', value: 0.02, period: 'long run', publisher: 'Bank of England', asOf: '2026-09-01', sources: [{ ...source, publisher: 'Bank of England' }] }],
      outlooks: [{ assetClass: 'equity', publisher: 'Vanguard', horizonYears: 10, currency: 'GBP', expectedReturnNominal: 0.061, expectedReturnReal: null, rangeLow: 0.041, rangeHigh: 0.081, volatility: 0.16, asOf: '2026-06-30', sources: [source] }],
      assumptions: [
        { key: 'inflation', assetClass: null, value: 0.022, low: 0.015, high: 0.035, rationale: 'Target plus a small premium.', basedOn: [{ type: 'indicator', index: 0 }], sources: [] },
        { key: 'return.expected', assetClass: 'equity', value: 0.062, low: 0.04, high: 0.085, rationale: 'Vanguard 10-year outlook.', basedOn: [{ type: 'outlook', index: 0 }], sources: [source] },
        { key: 'return.expected', assetClass: null, value: 0.05, low: 0.03, high: 0.07, rationale: 'No class.', basedOn: [], sources: [source] },
        { key: 'made.up', assetClass: null, value: 1, low: 0, high: 2, rationale: 'x', basedOn: [], sources: [source] },
      ],
      notes: '',
    };
    const res = await JOB_DEFS['refresh-assumptions'].apply(ctx({}), out, provenance);
    expect(res.summary).toMatch(/2 assumption\(s\) and 2 research record\(s\); 2 proposal\(s\) skipped/);
    const set = new AssumptionSet(store.assumptions, '2026-09-29');
    expect(set.resolve('inflation')).toMatchObject({ source: 'agent', value: 0.022 });
    const eq = set.resolve('return.expected', { assetClass: 'equity' });
    expect(eq.record!.basedOn).toEqual([store.research.find((r) => r.kind === 'market.outlook')!.id]);
    expect(eq.record!.reviewBy).toBeDefined();
  });

  it('insights: evidence that does not exist is dropped, and so is an insight left with none', async () => {
    const t: Transaction = { id: transactionId('current', '2026-08-02', -12.5, 'CAFE', 0), accountId: 'current', date: '2026-08-02', amount: -12.5, currency: 'GBP', description: 'CAFE', source: {} };
    await store.addTransactions([t], 't');
    const insight = (ids: string[], title: string) => ({ kind: 'habit', pages: ['spending'], subject: { accountId: null, instrumentId: null, category: null, taxYear: null, month: null }, title, body: 'b', confidence: 'medium', evidence: [{ type: 'transactions', ids, id: null, metric: null, value: null, label: null }], expiresInDays: 30 });
    const res = await JOB_DEFS['insights-after-import'].apply(ctx({ importIds: [] }), { insights: [insight([t.id, 'tx_ffffffffffffffff'], 'Real'), insight(['tx_eeeeeeeeeeeeeeee'], 'Invented')] }, provenance);
    expect(res.summary).toMatch(/1 insight\(s\); 1 dropped/);
    expect(store.insights).toHaveLength(1);
    expect(store.insights[0]!.evidence).toEqual([{ type: 'transactions', ids: [t.id] }]);
  });

  it('interpret-note: proposals wait for you; unknown ids are not carried over', async () => {
    const stampNow = '2026-09-29T10:00:00+01:00';
    await store.upsertRecords('notes', [{ id: 'note_0000000000000001', text: 'I hold LifeStrategy 80 in my ISA and we plan to buy a house in 2028', status: 'new', proposals: [], createdAt: stampNow, updatedAt: stampNow }], 'n');
    const out = {
      reply: 'Got it.',
      proposals: [
        { type: 'context', explanation: 'A plan', context: { kind: 'plan', statement: 'You plan to buy a house in 2028', detail: { accountId: 'nope', instrumentId: null, event: 'buy-home', amount: null, annualAmount: null, rate: null, date: '2028-12-31', from: null, to: null, accountIds: ['isa', 'ghost'] } }, instrument: null },
        { type: 'instrument', explanation: 'A fund', context: null, instrument: { name: 'Vanguard LifeStrategy 80', isin: 'gb00b4pqw151', ticker: null, type: 'fund', manager: 'Vanguard' } },
      ],
    };
    await JOB_DEFS['interpret-note'].apply(ctx({ noteId: 'note_0000000000000001' }), out, provenance);
    const note = store.notes[0]!;
    expect(note.status).toBe('proposed');
    expect(note.proposals).toHaveLength(2);
    expect(note.proposals[0]!.record).toEqual({ kind: 'plan', statement: 'You plan to buy a house in 2028', detail: { event: 'buy-home', date: '2028-12-31', accountIds: ['isa'] } });
    expect(note.proposals[1]!.record).toMatchObject({ isin: 'GB00B4PQW151' });
    expect(store.context).toHaveLength(0);
  });
});

describe('what is stale', () => {
  it('a fund first recorded under a name cut short takes the full name when a statement prints it', async () => {
    const runner = new JobRunner(store, new Analytics(store), loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), { autoRun: false });
    await runner.init();
    const snap = (id: string, date: string, name: string) => ({ id, accountId: 'isa', date, holdings: [{ name, units: 10, value: 100, currency: 'GBP' }], totalValue: 100, source: {}, createdAt: stamp });
    await store.addHoldings([snap('hld_00000000000000b1', '2026-09-10', 'HSBC FTSE 100 Index Accum…')], 'h');
    await runner.ensureInstrumentsFromHoldings();
    expect(store.instruments.map((i) => i.name)).toEqual(['HSBC FTSE 100 Index Accum…']);
    await store.addHoldings([snap('hld_00000000000000b2', '2026-09-20', 'HSBC FTSE 100 Index Accumulation C')], 'h');
    expect(await runner.ensureInstrumentsFromHoldings()).toBe(0);
    expect(store.instruments).toHaveLength(1);
    expect(store.instruments[0]).toMatchObject({ name: 'HSBC FTSE 100 Index Accumulation C', aliases: ['HSBC FTSE 100 Index Accum…'] });
    runner.stop();
  });

  it('suggests research for new funds and providers, and assumptions still on fallbacks', async () => {
    const runner = new JobRunner(store, new Analytics(store), loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' }), { autoRun: false });
    await runner.init();
    await runner.ensureInstrumentsFromHoldings();
    const kinds = runner.suggestions('2026-09-29').map((s) => s.kind).sort();
    expect(kinds).toEqual(['refresh-assumptions', 'research-instrument', 'research-provider', 'research-provider']);
    runner.stop();
  });

  it('does not start a job again by itself after it ran, even when it found nothing', async () => {
    await store.setSettings({ ...store.settings, agents: { ...store.settings.agents, enabled: true } });
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    const first = new JobRunner(store, new Analytics(store), config, { autoRun: false });
    await first.init();
    await first.ensureInstrumentsFromHoldings();
    const due = first.suggestions('2026-09-29');
    expect(due).toHaveLength(4);
    first.stop();
    // Each job ran and succeeded without writing anything, so every suggestion is still there.
    await writeJobs(
      first.dir,
      due.map((s, i) => ({ id: `job_done${i}`, kind: s.kind, label: s.label, params: s.params, status: 'succeeded', trigger: 'schedule', privacy: 'public', promptVersion: 'test', createdAt: '2026-09-29T10:00:00+01:00', finishedAt: '2026-09-29T10:05:00+01:00', summary: 'Nothing found' })),
    );
    const runner = new JobRunner(store, new Analytics(store), config, { autoRun: true, paused: true });
    await runner.init();
    expect(runner.suggestions('2026-10-01')).toHaveLength(4);
    await runner.tick('2026-10-01');
    expect(runner.list().filter((j) => j.status === 'queued')).toEqual([]);
    // Once the research is stale (90 days by default), it is due again.
    await runner.tick('2027-01-05');
    expect(runner.list().filter((j) => j.status === 'queued').map((j) => j.kind)).toContain('research-instrument');
    runner.stop();
  });
});

async function writeJobs(jobsDir: string, jobs: object[]) {
  for (const j of jobs) await writeFile(path.join(jobsDir, `${(j as { id: string }).id}.json`), JSON.stringify(j));
}
