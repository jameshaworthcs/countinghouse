// What the months in review ask of you (docs/DATA_FORMAT.md, actions.json): a review writes actions by
// key, a later one carries or closes them, a rerun of the same month drops what only its earlier run
// asked, your decision survives all of it, and actions age by their date. Every value is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actionsFor, actionsView, applyReviewActions, decideAction, laterReviewWrote, type ActionInput } from '../src/server/actions';
import { diffById } from '../src/server/auditdiff';
import { Store } from '../src/server/store';
import { requiredScope } from '../src/server/tokens';
import { actionState } from '../src/shared/actions';
import { ReviewActionSchema, type Provenance } from '../src/shared/schema';

const provenance: Provenance = { setBy: 'agent', promptVersion: 'monthly-review-7', jobId: 'job_a' };
const act = (key: string, extra: Partial<ActionInput> = {}): ActionInput => ({ key, what: `Do ${key}`, why: 'Because £120 a month', kind: 'money', ...extra });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-actions-'));
  store = await Store.open(path.join(dir, 'data'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('a review’s actions', () => {
  it('asked again keeps its first month and your decision; closed when a later review finds it no longer applies', async () => {
    await applyReviewActions(store, '2026-08', { actions: [act('payee-example-gym-unused'), act('acct-saver-idle-cash')], drops: [] }, provenance);
    await decideAction(store, 'acct-saver-idle-cash', 'not-relevant', 'Kept for a deposit');
    const r = await applyReviewActions(store, '2026-09', { actions: [act('payee-example-gym-unused', { what: 'Cancel the gym', by: '2026-10-31' }), act('acct-saver-idle-cash')], drops: [] }, provenance);
    // The one you decided is yours: a review asking it again changes nothing.
    expect(r.written).toEqual(['payee-example-gym-unused']);
    expect(store.actions.find((a) => a.key === 'acct-saver-idle-cash')).toMatchObject({ what: 'Do acct-saver-idle-cash', months: ['2026-08'] });
    const gym = store.actions.find((a) => a.key === 'payee-example-gym-unused')!;
    expect(gym).toMatchObject({ months: ['2026-08', '2026-09'], firstMonth: '2026-08', lastMonth: '2026-09', what: 'Cancel the gym', by: '2026-10-31' });
    expect(store.actions.find((a) => a.key === 'acct-saver-idle-cash')!.decision).toMatchObject({ status: 'not-relevant', note: 'Kept for a deposit' });
    await applyReviewActions(store, '2026-10', { actions: [], drops: [{ key: 'payee-example-gym-unused', reason: 'No gym payment since September' }] }, provenance);
    expect(store.actions.find((a) => a.key === 'payee-example-gym-unused')!.closed).toEqual({ month: '2026-10', reason: 'No gym payment since September' });
    for (const a of store.actions) expect(ReviewActionSchema.safeParse(a).success).toBe(true);
  });

  it('a rerun of the same month drops what only its earlier run asked, unless you decided it', async () => {
    await applyReviewActions(store, '2026-08', { actions: [act('plan-carried')], drops: [] }, provenance);
    await applyReviewActions(store, '2026-09', { actions: [act('plan-carried'), act('plan-first-run-only'), act('plan-decided')], drops: [] }, provenance);
    await decideAction(store, 'plan-decided', 'done');
    const r = await applyReviewActions(store, '2026-09', { actions: [act('plan-carried')], drops: [] }, provenance);
    expect(r.removed).toEqual(['plan-first-run-only']);
    expect(store.actions.map((a) => a.key).sort()).toEqual(['plan-carried', 'plan-decided']);
  });

  it('a rerun of a month takes back what its earlier run did: the month it added, a close it made', async () => {
    await applyReviewActions(store, '2026-08', { actions: [act('plan-carried'), act('plan-dropped')], drops: [] }, provenance);
    await applyReviewActions(store, '2026-09', { actions: [act('plan-carried', { what: 'Said in the first run' })], drops: [{ key: 'plan-dropped', reason: 'Done already' }] }, provenance);
    expect(store.actions.find((a) => a.key === 'plan-dropped')!.closed).toMatchObject({ month: '2026-09' });
    // Before September's rerun, both are open again, as August left them.
    const before = actionsFor(store.actions, '2026-09', '2026-10-01');
    expect(before.open.map((a) => [a.key, a.lastMonth]).sort()).toEqual([
      ['plan-carried', '2026-08'],
      ['plan-dropped', '2026-08'],
    ]);
    // The rerun drops the one the first run carried, and leaves out the other: open as August left it.
    await applyReviewActions(store, '2026-09', { actions: [], drops: [{ key: 'plan-carried', reason: 'No longer applies' }] }, provenance);
    expect(store.actions.find((a) => a.key === 'plan-carried')).toMatchObject({ months: ['2026-08'], closed: { month: '2026-09' } });
    expect(store.actions.find((a) => a.key === 'plan-dropped')!.closed).toBeUndefined();
  });

  it('a month before one whose review wrote actions writes none', async () => {
    await applyReviewActions(store, '2026-09', { actions: [act('plan-a')], drops: [] }, provenance);
    expect(laterReviewWrote(store.actions, '2026-08')).toBe(true);
    const r = await applyReviewActions(store, '2026-08', { actions: [act('plan-b')], drops: [{ key: 'plan-a', reason: 'x' }] }, provenance);
    expect(r).toEqual({ written: [], closed: [], removed: [] });
    expect(store.actions.map((a) => a.key)).toEqual(['plan-a']);
  });

  it('records each change in the audit log by key', () => {
    const one = { key: 'plan-a', what: 'A' };
    expect(diffById([one, { key: 'plan-b', what: 'B' }], [{ ...one, what: 'A again' }, { key: 'plan-b', what: 'B' }]).items).toMatchObject([{ id: 'plan-a', op: 'changed' }]);
  });

  it('a decision can be undone, and a closed action asked again is open again', async () => {
    await applyReviewActions(store, '2026-08', { actions: [act('plan-a')], drops: [] }, provenance);
    await decideAction(store, 'plan-a', 'done');
    await decideAction(store, 'plan-a', 'open');
    expect(store.actions[0]!.decision).toBeUndefined();
    await applyReviewActions(store, '2026-09', { actions: [], drops: [{ key: 'plan-a', reason: 'Settled' }] }, provenance);
    await applyReviewActions(store, '2026-10', { actions: [act('plan-a')], drops: [] }, provenance);
    expect(store.actions[0]!.closed).toBeUndefined();
    await expect(decideAction(store, 'plan-missing', 'done')).rejects.toThrow(/No action/);
  });

  it('ages by its date, or by how long since a review last asked it', async () => {
    await applyReviewActions(store, '2026-09', { actions: [act('tax-2026-27-isa', { by: '2026-11-30' }), act('plan-undated')], drops: [] }, provenance);
    const dated = store.actions.find((a) => a.key === 'tax-2026-27-isa')!;
    expect(actionState(dated, '2026-11-01')).toBe('open');
    expect(actionState(dated, '2026-11-20')).toBe('due-soon');
    expect(actionState(dated, '2026-12-05')).toBe('overdue');
    expect(actionState(dated, '2027-01-05')).toBe('expired');
    const undated = { ...store.actions.find((a) => a.key === 'plan-undated')!, updatedAt: '2026-09-01T00:00:00+00:00' };
    expect(actionState(undated, '2026-10-15')).toBe('open');
    expect(actionState(undated, '2026-11-15')).toBe('stale');
    expect(actionState(undated, '2026-12-15')).toBe('expired');
    const view = actionsView(store, '2026-11-20');
    expect(view.open[0]).toMatchObject({ key: 'tax-2026-27-isa', state: 'due-soon' });
  });

  it('only your session decides one: no agent token may', () => {
    expect(requiredScope('PATCH', '/api/actions/plan-a')).toBeNull();
    expect(requiredScope('GET', '/api/actions')).toBe('read');
  });

  it('keys follow the grammar', () => {
    const base = { what: 'x', why: 'y', kind: 'money', months: ['2026-09'], firstMonth: '2026-09', lastMonth: '2026-09', provenance, createdAt: '2026-09-01T00:00:00+00:00', updatedAt: '2026-09-01T00:00:00+00:00' };
    expect(ReviewActionSchema.safeParse({ ...base, key: 'acct-chase-saver-idle-cash' }).success).toBe(true);
    expect(ReviewActionSchema.safeParse({ ...base, key: 'register-self-assessment' }).success).toBe(false);
    expect(ReviewActionSchema.safeParse({ ...base, key: 'plan-Bad_Key' }).success).toBe(false);
  });
});

describe('the gates a month in review must pass (scripts/review-eval.ts)', () => {
  it('pass a short, plain review in whole pounds, and name what fails in one that is not', async () => {
    const { reviewGates } = await import('../src/server/agents/review-gates');
    const base = { id: 'inf_0000000000000001', kind: 'month-review' as const, pages: ['overview' as const], subject: { month: '2026-10' }, body: 'b', evidence: [{ type: 'computed' as const, metric: 'm' }], confidence: 'medium' as const, provenance, status: 'active' as const, createdAt: '2026-11-01T00:00:00+00:00' };
    const opts = { actions: [], month: '2026-10', catchUp: false, alerts: [], openBefore: [], decidedBefore: [], cardsClean: ['card'] };
    const good = reviewGates({ ...base, title: 'A quiet month: £600 left over and £400 into the ISA', keyPoints: [{ text: 'Pay of £2,000 came in as usual.' }], sections: [{ id: 'month', heading: 'Why', body: 'Rent and bills as usual.' }] }, opts);
    expect(good.filter((g) => !g.ok)).toEqual([]);
    const bad = reviewGates(
      {
        ...base,
        title: 'October: £1,812.43 down with £947.00 at Example Shop and £208.19 for a trip, while £4,000.00 went into ISAs and more',
        keyPoints: [{ text: 'Nothing was scheduled. EXAMPLE LETTINGS LTD took £900.12.' }],
        sections: [],
        watch: ['Whether the card is paid in full by its direct debit'],
        unchecked: ['£7,777'],
      },
      { ...opts, openBefore: ['plan-left-open'] },
    );
    expect(bad.filter((g) => !g.ok).map((g) => g.id).sort()).toEqual(['names', 'open-carried', 'plain-words', 'title', 'unchecked', 'whole-pounds', 'no-routine-watch'].sort());
  });
});
