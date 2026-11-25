// What the months in review ask of you (docs/AGENTS.md, "monthly-review"; docs/DATA_FORMAT.md,
// actions.json). A review of the latest month writes its actions here by key: one it asks again keeps
// its first month and anything you decided; one it finds no longer applies is closed; on a rerun of
// the same month, an action only the earlier run asked, and you did not decide, goes. Whether an
// action is done or not relevant is yours alone (PATCH /api/actions/:key, your session only).

import { ACTION_PAGES, ACTIVE_STATES, actionState, type ActionState } from '../shared/actions';
import type { ISODate } from '../shared/dates';
import { ReviewActionSchema, type Provenance, type ReviewAction } from '../shared/schema';
import { nowISO } from './fsutil';
import { StoreError, type Store } from './store';

/** An action as a review writes it: the app adds its months, provenance and times. */
export type ActionInput = Pick<ReviewAction, 'key' | 'what' | 'why' | 'kind'> & Partial<Pick<ReviewAction, 'by' | 'where' | 'evidence'>>;

/** Write a review's actions for its month: ask, carry, close, and on a rerun drop what it no longer asks. */
export async function applyReviewActions(store: Store, month: string, input: { actions: ActionInput[]; drops: { key: string; reason: string }[] }, provenance: Provenance): Promise<{ written: string[]; closed: string[]; removed: string[] }> {
  const now = nowISO();
  const asked = new Map(input.actions.map((a) => [a.key, a]));
  const written: string[] = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const list: ReviewAction[] = [];
  for (const old of store.actions) {
    const again = asked.get(old.key);
    if (again) {
      // What the review says now replaces what it said before, a date or page it no longer gives too.
      const { by: _by, where: _where, ...kept } = old;
      list.push(
        ReviewActionSchema.parse({
          ...kept,
          ...again,
          evidence: again.evidence ?? [],
          lastMonth: old.lastMonth > month ? old.lastMonth : month,
          // Asked again, it is open again, unless you decided it.
          closed: old.decision ? old.closed : undefined,
          provenance,
          updatedAt: now,
        }),
      );
      written.push(old.key);
      asked.delete(old.key);
      continue;
    }
    const drop = input.drops.find((d) => d.key === old.key);
    if (drop && !old.decision && !old.closed) {
      list.push({ ...old, closed: { month, reason: drop.reason.slice(0, 300) }, updatedAt: now });
      closed.push(old.key);
      continue;
    }
    // A rerun of this month: what only its earlier run asked, and you did not decide, goes.
    if (!old.decision && old.firstMonth === month && old.lastMonth === month) {
      removed.push(old.key);
      continue;
    }
    list.push(old);
  }
  for (const a of asked.values()) {
    list.push(ReviewActionSchema.parse({ ...a, evidence: a.evidence ?? [], firstMonth: month, lastMonth: month, provenance, createdAt: now, updatedAt: now }));
    written.push(a.key);
  }
  if (written.length || closed.length || removed.length) {
    const parts = [written.length && `${written.length} asked`, closed.length && `${closed.length} closed`, removed.length && `${removed.length} removed`].filter(Boolean).join(', ');
    await store.setActions(list, `actions: ${parts} by the review of ${month}`);
  }
  return { written, closed, removed };
}

export interface ActionView extends ReviewAction {
  state: ActionState;
  href?: string;
}

/** Your actions as they stand today: those on your list first, most pressing first, then those decided or closed in the last 90 days. */
export function actionsView(store: Store, today: ISODate): { open: ActionView[]; recent: ActionView[] } {
  const views = store.actions.map((a): ActionView => ({ ...a, state: actionState(a, today), ...(a.where ? { href: ACTION_PAGES[a.where] } : {}) }));
  const rank: Record<string, number> = { overdue: 0, 'due-soon': 1, open: 2, stale: 3 };
  const open = views.filter((v) => ACTIVE_STATES.has(v.state)).sort((a, b) => rank[a.state]! - rank[b.state]! || (a.by ?? '9999').localeCompare(b.by ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const recent = views.filter((v) => !ACTIVE_STATES.has(v.state) && v.state !== 'expired' && (v.decision?.at ?? v.updatedAt).slice(0, 10) >= since).sort((a, b) => (b.decision?.at ?? b.updatedAt).localeCompare(a.decision?.at ?? a.updatedAt));
  return { open, recent };
}

/** Yours: an action done, not relevant, or open again. */
export async function decideAction(store: Store, key: string, status: 'open' | 'done' | 'not-relevant', note?: string): Promise<ReviewAction> {
  const old = store.actions.find((a) => a.key === key);
  if (!old) throw new StoreError(`No action "${key}"`, 404);
  const now = nowISO();
  const { decision: _d, closed: _c, ...rest } = old;
  const next: ReviewAction =
    status === 'open'
      ? { ...rest, updatedAt: now }
      : { ...old, decision: { status, at: now, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) }, updatedAt: now };
  await store.setActions(
    store.actions.map((a) => (a.key === key ? next : a)),
    `actions: ${key} ${status === 'open' ? 'reopened' : status} by owner`,
  );
  return next;
}
