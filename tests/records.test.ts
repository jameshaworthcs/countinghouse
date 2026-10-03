// Assumptions (resolution, validation), the validated write path for agent records, owner
// overrides, and the format v2 migration.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/server/migrations';
import { applyRecords, RecordsError, setOwnerAssumption, type RecordBatch } from '../src/server/records';
import { Store } from '../src/server/store';
import { AssumptionSet, assumptionProblems } from '../src/shared/assumptions';
import type { Assumption } from '../src/shared/schema';

const stamp = (n: number) => `2026-09-${String(10 + n).padStart(2, '0')}T12:00:00+01:00`;
let seq = 0;
const asm = (key: string, scope: Assumption['scope'], value: number, setBy: 'owner' | 'agent', extra: Partial<Assumption> = {}): Assumption => ({
  id: `asm_${(seq++).toString(16).padStart(16, '0')}`,
  key,
  scope,
  value,
  asOf: '2026-09-01',
  source: 'test',
  evidence: [],
  basedOn: [],
  rationale: 'test',
  provenance: { setBy },
  status: 'active',
  createdAt: stamp(seq),
  ...extra,
});

describe('assumption resolution', () => {
  it('falls back to the registry, by asset class where it has one', () => {
    const set = new AssumptionSet([], '2026-09-28');
    expect(set.resolve('return.expected', { assetClass: 'equity' })).toMatchObject({ source: 'fallback', value: 0.065 });
    expect(set.resolve('return.expected', { assetClass: 'bond' }).value).toBe(0.04);
    expect(set.resolve('interest.rate', { accountType: 'current' }).value).toBe(0);
    expect(set.resolve('interest.rate', { accountType: 'savings' }).value).toBe(0.03);
  });

  it('derives fallbacks from other keys, and applies the triple lock', () => {
    const set = new AssumptionSet([asm('earnings.growth', { kind: 'global' }, 0.041, 'agent'), asm('inflation', { kind: 'global' }, 0.023, 'agent')], '2026-09-28');
    expect(set.resolve('salary.growth').value).toBe(0.041);
    expect(set.resolve('contribution.growth').value).toBe(0.041);
    expect(set.resolve('spending.growth').value).toBe(0.023);
    expect(set.resolve('statePension.growth').value).toBe(0.041);
    const low = new AssumptionSet([asm('earnings.growth', { kind: 'global' }, 0.01, 'agent'), asm('inflation', { kind: 'global' }, 0.015, 'agent')], '2026-09-28');
    expect(low.resolve('statePension.growth').value).toBe(0.025);
  });

  it('prefers your records over agents’, even at a broader scope', () => {
    const records = [asm('return.expected', { kind: 'instrument', instrumentId: 'fund-a' }, 0.07, 'agent'), asm('return.expected', { kind: 'assetClass', assetClass: 'equity' }, 0.05, 'owner')];
    const set = new AssumptionSet(records, '2026-09-28');
    expect(set.resolve('return.expected', { instrumentId: 'fund-a', assetClass: 'equity' })).toMatchObject({ source: 'owner', value: 0.05 });
    // A class you did not override still uses the agent's fund-level value.
    expect(set.resolve('return.expected', { instrumentId: 'fund-a', assetClass: 'bond' })).toMatchObject({ source: 'agent', value: 0.07 });
  });

  it('within a layer, the most specific scope and then the newest record win', () => {
    const records = [
      asm('fee.platform', { kind: 'global' }, 0.004, 'agent'),
      asm('fee.platform', { kind: 'institution', institutionId: 'vanguard' }, 0.0015, 'agent'),
      asm('fee.platform', { kind: 'institution', institutionId: 'vanguard' }, 0.0012, 'agent'),
    ];
    const set = new AssumptionSet(records, '2026-09-28');
    expect(set.resolve('fee.platform', { institutionId: 'vanguard' }).value).toBe(0.0012);
    expect(set.resolve('fee.platform', { institutionId: 'aj-bell' }).value).toBe(0.004);
    expect(set.history('fee.platform', { kind: 'institution', institutionId: 'vanguard' })).toHaveLength(2);
  });

  it('a retired override hands back to the agent, and stale agent values are flagged', () => {
    const records = [
      asm('inflation', { kind: 'global' }, 0.025, 'agent', { reviewBy: '2026-06-30' }),
      asm('inflation', { kind: 'global' }, 0.03, 'owner'),
      asm('inflation', { kind: 'global' }, 0.03, 'owner', { status: 'retired' }),
    ];
    const r = new AssumptionSet(records, '2026-09-28').resolve('inflation');
    expect(r).toMatchObject({ source: 'agent', value: 0.025, stale: true });
  });

  it('checks keys, scopes, bounds and ranges', () => {
    expect(assumptionProblems({ key: 'nope', scope: { kind: 'global' }, value: 1 })[0]).toMatch(/unknown key/);
    expect(assumptionProblems({ key: 'inflation', scope: { kind: 'account', accountId: 'x' }, value: 0.02 })[0]).toMatch(/cannot be set for scope/);
    expect(assumptionProblems({ key: 'inflation', scope: { kind: 'global' }, value: 0.9 })[0]).toMatch(/between/);
    expect(assumptionProblems({ key: 'inflation', scope: { kind: 'global' }, value: 0.02, range: { low: 0.025, high: 0.03 } })[0]).toMatch(/contain/);
    expect(assumptionProblems({ key: 'inflation', scope: { kind: 'global' }, value: 0.02, range: { low: 0.015, high: 0.035 } })).toEqual([]);
  });
});

describe('the validated write path', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-records-'));
    store = await Store.open(path.join(dir, 'data'));
    await store.setAccounts([{ id: 'isa', name: 'ISA', type: 'stocks_isa', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, institutionId: 'vanguard', createdAt: stamp(0), updatedAt: stamp(0) }]);
    await store.upsertInstitution({ id: 'vanguard', name: 'Vanguard', kind: 'investment_platform' });
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });
  const agent = { setBy: 'agent' as const, model: 'claude-test', promptVersion: 'test-1' };

  it('writes instruments, research and assumptions, and skips identical research', async () => {
    const batch: RecordBatch = {
      provenance: agent,
      supersede: false,
      records: [
        { type: 'instrument', record: { id: 'vg-lifestrategy-80', name: 'Vanguard LifeStrategy 80% Equity Fund', isin: 'GB00B4PQW151', aliases: [] } },
        {
          type: 'research',
          record: {
            kind: 'instrument.facts',
            subject: { instrumentId: 'vg-lifestrategy-80' },
            asOf: '2026-08-31',
            sources: [{ title: 'Factsheet', url: 'https://www.vanguardinvestor.co.uk/example' }],
            confidence: 'high',
            data: { ocf: 0.0022, allocation: { equity: 0.8, bond: 0.2 } },
          },
        },
        {
          type: 'assumption',
          record: { key: 'return.expected', scope: { kind: 'assetClass', assetClass: 'equity' }, value: 0.064, range: { low: 0.04, high: 0.085 }, asOf: '2026-08-01', source: 'Outlook', evidence: [{ title: 'Outlook', url: 'https://example.com/outlook' }], basedOn: [], rationale: 'Because.', status: 'active' },
        },
      ],
    };
    const res = await applyRecords(store, batch);
    expect(res.written.map((w) => w.type)).toEqual(['instrument', 'research', 'assumption']);
    expect(store.instrument('vg-lifestrategy-80')?.isin).toBe('GB00B4PQW151');
    expect(store.research).toHaveLength(1);
    expect(store.assumptions[0]!.provenance).toMatchObject(agent);
    const again = await applyRecords(store, { ...batch, records: [batch.records[1]!] });
    expect(again.skipped[0]!.reason).toMatch(/identical research/);
    expect(store.research).toHaveLength(1);
  });

  it('rejects the whole batch when anything is wrong, and writes nothing', async () => {
    const bad: RecordBatch = {
      provenance: agent,
      supersede: false,
      records: [
        { type: 'assumption', record: { key: 'return.expected', scope: { kind: 'account', accountId: 'nope' }, value: 0.05, asOf: '2026-09-01', source: 's', evidence: [], basedOn: [], rationale: 'r', status: 'active' } },
        { type: 'research', record: { kind: 'provider.rates', subject: { institutionId: 'vanguard' }, asOf: '2026-09-01', sources: [{ title: 'No link' }], confidence: 'medium', data: { products: [{ name: 'Saver', aer: 0.04, variable: true }] } } },
        {
          type: 'insight',
          record: { kind: 'habit', pages: ['spending'], subject: {}, title: 'T', body: 'B', evidence: [{ type: 'transactions', ids: ['tx_0000000000000000'] }], confidence: 'low', provenance: agent } as never,
        },
      ],
    };
    const err = await applyRecords(store, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordsError);
    const problems = (err as RecordsError).problems.join('\n');
    expect(problems).toMatch(/unknown account "nope"/);
    expect(problems).toMatch(/evidence \(sources\) or basedOn/);
    expect(problems).toMatch(/at least one source with a URL/);
    expect(problems).toMatch(/unknown transaction tx_0000000000000000/);
    expect(store.assumptions).toHaveLength(0);
    expect(store.research).toHaveLength(0);
  });

  it('a rerun supersedes the same job’s earlier insight', async () => {
    await store.addBalances([{ id: 'bal_00000000000000aa', accountId: 'isa', date: '2026-09-01', balance: 1000, currency: 'GBP', kind: 'manual', source: {}, createdAt: stamp(1) }], 'b');
    const insight = { kind: 'month-review' as const, pages: ['overview' as const], subject: { month: '2026-08' }, title: 'August', body: 'Quiet.', evidence: [{ type: 'balance' as const, id: 'bal_00000000000000aa' }], confidence: 'medium' as const };
    await applyRecords(store, { provenance: agent, supersede: true, records: [{ type: 'insight', record: insight }] });
    await applyRecords(store, { provenance: agent, supersede: true, records: [{ type: 'insight', record: { ...insight, title: 'August again' } }] });
    expect(store.insights.map((i) => i.status)).toEqual(['superseded', 'active']);
    expect(store.insights[1]!.supersedes).toBe(store.insights[0]!.id);
  });

  it('your override wins, and removing it restores the agent value', async () => {
    await applyRecords(store, {
      provenance: agent,
      supersede: false,
      records: [{ type: 'assumption', record: { key: 'withdrawal.rate', scope: { kind: 'global' }, value: 0.034, asOf: '2026-09-01', source: 'Study', evidence: [{ title: 'Study', url: 'https://example.com/s' }], basedOn: [], rationale: 'r', status: 'active' } }],
    });
    await setOwnerAssumption(store, { key: 'withdrawal.rate', scope: { kind: 'global' }, value: 0.04, rationale: 'I plan to be flexible.' });
    expect(new AssumptionSet(store.assumptions, '2026-09-28').resolve('withdrawal.rate')).toMatchObject({ source: 'owner', value: 0.04 });
    await setOwnerAssumption(store, { key: 'withdrawal.rate', scope: { kind: 'global' }, retire: true });
    expect(new AssumptionSet(store.assumptions, '2026-09-28').resolve('withdrawal.rate')).toMatchObject({ source: 'agent', value: 0.034 });
    expect(store.assumptions).toHaveLength(3);
  });
});

describe('the capture list', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-capture-'));
    store = await Store.open(path.join(dir, 'data'));
    const acct = (id: string, type: 'current' | 'stocks_isa') => ({ id, name: id, type, currency: 'GBP', status: 'open' as const, aliases: [], includeInNetWorth: true, createdAt: stamp(0), updatedAt: stamp(0) });
    await store.setAccounts([acct('bank', 'current'), acct('isa', 'stocks_isa')]);
  });
  afterEach(async () => {
    store.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });
  const session = { setBy: 'agent' as const, session: 'claude-code' };
  const batch = (asks: string[] = ['statements', 'letter']): RecordBatch => ({
    provenance: session,
    supersede: false,
    records: [
      {
        type: 'capture',
        record: {
          id: 'bank',
          title: 'Bank',
          accountId: 'bank',
          priority: 'high',
          asks: [
            { id: 'statements', what: 'Statements from 6 April 2026', check: { type: 'coverage' as const, from: '2026-04-06' } },
            { id: 'letter', what: 'The overdraft letter' },
          ].filter((a) => asks.includes(a.id)),
        },
      },
      { type: 'capture', record: { id: 'isa', title: 'ISA', accountId: 'isa', priority: 'normal', asks: [{ id: 'value', what: 'Value and holdings', check: { type: 'valuation', since: '2026-09-01', holdings: true } }] } },
      { type: 'capture', record: { id: 'p60', title: 'P60', priority: 'normal', asks: [{ id: 'p60', what: 'P60 for 2025/26', check: { type: 'figures', kinds: ['gross_pay'], taxYear: '2025/26' } }] } },
    ],
  });

  it('rejects asks that check an account the item does not name, and unknown accounts', async () => {
    const bad = batch();
    bad.records.push({ type: 'capture', record: { id: 'x', title: 'X', priority: 'normal', asks: [{ id: 'a', what: 'a', check: { type: 'coverage', from: '2026-01-01' } }] } });
    bad.records.push({ type: 'capture', record: { id: 'y', title: 'Y', accountId: 'nope', priority: 'normal', asks: [{ id: 'a', what: 'a' }, { id: 'a', what: 'b' }] } });
    await expect(applyRecords(store, bad)).rejects.toThrow(/needs an accountId/);
    await expect(applyRecords(store, bad)).rejects.toThrow(/unknown account "nope"/);
    await expect(applyRecords(store, bad)).rejects.toThrow(/ask ids must be unique/);
    // Agents cannot tick asks off or skip items: those fields are not part of their input.
    const ticked = batch() as unknown as { records: { record: Record<string, unknown> & { asks: Record<string, unknown>[] } }[] };
    ticked.records[0]!.record.asks[1]!.doneAt = stamp(1);
    ticked.records[0]!.record.skippedAt = stamp(1);
    await applyRecords(store, ticked);
    expect(store.capture[0]!.asks[1]!.doneAt).toBeUndefined();
    expect(store.capture[0]!.skippedAt).toBeUndefined();
  });

  it('ticks asks off from the data, and keeps your ticks when an agent rewrites the item', async () => {
    await applyRecords(store, batch());
    const { captureList } = await import('../src/server/analytics/capture');
    let list = captureList(store, '2026-09-29');
    expect(list).toMatchObject({ asks: 4, asksDone: 0, open: 3 });
    expect(list.items[0]).toMatchObject({ id: 'bank', priority: 'high', done: false });

    const tx = (date: string, n: number) => ({ id: `tx_${n.toString(16).padStart(16, '0')}`, accountId: 'bank', date, amount: -1, currency: 'GBP', description: 'x', source: {}, createdAt: stamp(0) });
    await store.addTransactions([tx('2026-04-06', 1), tx('2026-05-31', 2)], 'test');
    // "Up to now" is up to the end of the month before last (31 July), by when every statement for
    // those days is out, so rows to 31 May cover only part of it.
    list = captureList(store, '2026-09-29');
    expect(list.items.find((i) => i.id === 'bank')!.asks[0]).toMatchObject({ state: 'partial', progress: 'Missing 1 Jun – 31 Jul 2026.' });
    await store.addTransactions([tx('2026-07-01', 3), tx('2026-08-28', 4)], 'test');
    // The span of rows stands in for statement periods here (no import records), so it is covered through.
    expect(captureList(store, '2026-09-29').items.find((i) => i.id === 'bank')!.asks[0]!.state).toBe('done');

    // A valuation that is only approximate does not count; a real one without holdings is partial.
    await store.addBalances([{ id: 'bal_0000000000000001', accountId: 'isa', date: '2026-09-10', balance: 1000, currency: 'GBP', kind: 'manual', approximate: true, source: {}, createdAt: stamp(0) }], 'test');
    expect(captureList(store, '2026-09-29').items.find((i) => i.id === 'isa')!.asks[0]!.state).toBe('todo');
    await store.addBalances([{ id: 'bal_0000000000000002', accountId: 'isa', date: '2026-09-12', balance: 1000, currency: 'GBP', kind: 'screenshot', source: {}, createdAt: stamp(0) }], 'test');
    expect(captureList(store, '2026-09-29').items.find((i) => i.id === 'isa')!.asks[0]!.state).toBe('partial');

    await store.addFigures([{ id: 'fig_0000000000000001', kind: 'gross_pay', label: 'Pay', amount: 30000, currency: 'GBP', taxYear: '2025/26', source: {}, createdAt: stamp(0) }], 'test');
    expect(captureList(store, '2026-09-29').items.find((i) => i.id === 'p60')!.done).toBe(true);

    // You tick the letter; a rewrite by an agent keeps it, and an ask it drops goes away.
    const item = store.capture.find((i) => i.id === 'bank')!;
    await store.setCapture(store.capture.map((i) => (i.id === 'bank' ? { ...item, asks: item.asks.map((a) => (a.id === 'letter' ? { ...a, doneAt: stamp(2) } : a)) } : i)));
    expect(captureList(store, '2026-09-29').items.find((i) => i.id === 'bank')).toMatchObject({ done: true });
    await applyRecords(store, batch());
    expect(store.capture.find((i) => i.id === 'bank')!.asks.find((a) => a.id === 'letter')!.doneAt).toBe(stamp(2));
    expect(store.capture).toHaveLength(3);
    await applyRecords(store, batch(['statements']));
    expect(store.capture.find((i) => i.id === 'bank')!.asks.map((a) => a.id)).toEqual(['statements']);
  });

  it('finds a gap between statement periods', async () => {
    await applyRecords(store, batch());
    const { captureList } = await import('../src/server/analytics/capture');
    const summary = (from: string, to: string, n: number) => ({ id: `imp_${n}`, sections: [{ accountId: 'bank', from, to }] });
    (store as unknown as { state: { imports: unknown[] } }).state.imports.push(summary('2026-04-05', '2026-05-04', 1), summary('2026-06-05', '2026-09-04', 2));
    const ask = captureList(store, '2026-09-29').items.find((i) => i.id === 'bank')!.asks[0]!;
    expect(ask.state).toBe('partial');
    expect(ask.progress).toMatch(/Missing 5 May – 4 Jun 2026/);
  });
});

describe('format v2 migration', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-migrate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const v1 = async (profile: Record<string, unknown>) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ format: 'finance-data', version: 1, baseCurrency: 'GBP', createdAt: '2026-09-28T22:07:00+01:00' }));
    await writeFile(path.join(dir, 'profile.json'), JSON.stringify(profile));
  };

  it('drops the default return and adds the new collections', async () => {
    await v1({ name: 'A', taxRegion: 'england', retirementAge: 67, assumedRealReturn: 0.04 });
    const res = await runMigrations(dir, () => undefined);
    expect(res).toMatchObject({ from: 1, to: 9 });
    const profile = JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8')) as Record<string, unknown>;
    expect(profile).not.toHaveProperty('assumedRealReturn');
    expect(await readFile(path.join(dir, 'assumptions.jsonl'), 'utf8')).toBe('');
    for (const f of ['research.jsonl', 'insights.jsonl', 'context.jsonl', 'notes.jsonl', 'instruments.json']) await expect(readFile(path.join(dir, f), 'utf8')).resolves.toBeDefined();
    const store = await Store.open(dir);
    expect(store.meta.version).toBe(9);
    expect(store.issues).toEqual([]);
  });

  it('keeps a changed return as your global override', async () => {
    await v1({ taxRegion: 'england', retirementAge: 67, assumedRealReturn: 0.05 });
    await runMigrations(dir, () => undefined);
    const store = await Store.open(dir);
    expect(store.assumptions).toHaveLength(1);
    const r = new AssumptionSet(store.assumptions, '2026-09-28').resolve('return.expected', { assetClass: 'equity' });
    expect(r).toMatchObject({ source: 'owner', value: 0.071 });
  });
});
