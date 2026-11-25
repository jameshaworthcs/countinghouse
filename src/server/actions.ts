// What the months in review ask of you (docs/AGENTS.md, "monthly-review"; docs/DATA_FORMAT.md,
// actions.json). A review of the latest month writes its actions here by key: one it asks again adds
// its month; one it finds no longer applies is closed. A rerun of a month first takes back what its
// earlier run did (its month, a close it made; an action only it asked goes). Whether an action is done
// or not relevant is yours alone (PATCH /api/actions/:key, your session only), and a review never
// changes one you decided.

import { ACTION_PAGES, ACTIVE_STATES, actionState } from '../shared/actions';
import type { ActionsResponse, ActionView } from '../shared/api';
import { addDays, type ISODate } from '../shared/dates';
import { ReviewActionSchema, type Provenance, type ReviewAction } from '../shared/schema';
import { nowISO } from './fsutil';
import { StoreError, type Store } from './store';

/** An action as a review writes it: the app adds its months, provenance and times. */
export type ActionInput = Pick<ReviewAction, 'key' | 'what' | 'why' | 'kind'> & Partial<Pick<ReviewAction, 'by' | 'where' | 'evidence'>>;

const withMonths = (a: ReviewAction, months: string[]): ReviewAction => ({ ...a, months, firstMonth: months[0]!, lastMonth: months.at(-1)! });

/**
 * The actions as they stood before `month`'s review: what an earlier run of it asked or closed taken
 * back. One you decided stays as it is; one only that run asked, and you did not decide, is gone.
 */
export function actionsBefore(actions: readonly ReviewAction[], month: string): ReviewAction[] {
  return actions.flatMap((a) => {
    if (a.decision) return [a];
    const months = a.months.filter((m) => m !== month);
    if (!months.length) return [];
    const { closed, ...rest } = a;
    return [withMonths(closed && closed.month !== month ? { ...rest, closed } : rest, months)];
  });
}

/** What earlier reviews asked that is still open before `month`'s review, and what you decided. */
export function actionsFor(actions: readonly ReviewAction[], month: string, today: ISODate): { open: ReviewAction[]; decided: ReviewAction[] } {
  const before = actionsBefore(actions, month);
  return { open: before.filter((a) => !a.decision && !a.closed && ACTIVE_STATES.has(actionState(a, today))), decided: actions.filter((a) => a.decision) };
}

/** Whether a later month's review has already written actions: then this month's is not the latest. */
export function laterReviewWrote(actions: readonly ReviewAction[], month: string): boolean {
  return actions.some((a) => a.months.some((m) => m > month) || (a.closed?.month ?? '') > month);
}

/** Write a review's actions for its month: take back an earlier run of it, then ask, carry and close. */
export async function applyReviewActions(store: Store, month: string, input: { actions: ActionInput[]; drops: { key: string; reason: string }[] }, provenance: Provenance): Promise<{ written: string[]; closed: string[]; removed: string[] }> {
  if (laterReviewWrote(store.actions, month)) return { written: [], closed: [], removed: [] };
  const now = nowISO();
  const before = actionsBefore(store.actions, month);
  const removed = store.actions.filter((a) => !before.some((b) => b.key === a.key)).map((a) => a.key);
  const asked = new Map(input.actions.map((a) => [a.key, a]));
  const written: string[] = [];
  const closed: string[] = [];
  const list: ReviewAction[] = [];
  for (const old of before) {
    const again = asked.get(old.key);
    asked.delete(old.key);
    // One you decided is yours: a review never changes it.
    if (old.decision) {
      list.push(old);
      continue;
    }
    if (again) {
      // What the review says now replaces what it said before, a date or page it no longer gives too.
      const { by: _by, where: _where, closed: _closed, ...kept } = old;
      list.push(ReviewActionSchema.parse(withMonths({ ...kept, ...again, evidence: again.evidence ?? [], provenance, updatedAt: now }, [...new Set([...old.months, month])].sort())));
      written.push(old.key);
      continue;
    }
    const drop = input.drops.find((d) => d.key === old.key && d.reason.trim());
    if (drop && !old.closed) {
      list.push({ ...old, closed: { month, reason: drop.reason.trim().slice(0, 300) }, updatedAt: now });
      closed.push(old.key);
      continue;
    }
    list.push(old);
  }
  for (const a of asked.values()) {
    if (store.actions.some((x) => x.key === a.key && x.decision)) continue;
    list.push(ReviewActionSchema.parse({ ...a, evidence: a.evidence ?? [], months: [month], firstMonth: month, lastMonth: month, provenance, createdAt: now, updatedAt: now }));
    written.push(a.key);
  }
  const changed = written.length || closed.length || removed.length || JSON.stringify(list) !== JSON.stringify(store.actions);
  if (changed) {
    const parts = [written.length && `${written.length} asked`, closed.length && `${closed.length} closed`, removed.length && `${removed.length} taken back`].filter(Boolean).join(', ') || 'rerun';
    await store.setActions(list, `actions: ${parts} by the review of ${month}`);
  }
  return { written, closed, removed };
}

/** Your actions as they stand today: those on your list first, most pressing first, then those decided or closed in the last 90 days. */
export function actionsView(store: Store, today: ISODate): ActionsResponse {
  const views = store.actions.map((a): ActionView => ({ ...a, state: actionState(a, today), ...(a.where ? { href: ACTION_PAGES[a.where] } : {}) }));
  const rank: Record<string, number> = { overdue: 0, 'due-soon': 1, open: 2, stale: 3 };
  const open = views.filter((v) => ACTIVE_STATES.has(v.state)).sort((a, b) => rank[a.state]! - rank[b.state]! || (a.by ?? '9999').localeCompare(b.by ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));
  const since = addDays(today, -90);
  const recent = views.filter((v) => !ACTIVE_STATES.has(v.state) && v.state !== 'expired' && (v.decision?.at ?? v.updatedAt).slice(0, 10) >= since).sort((a, b) => (b.decision?.at ?? b.updatedAt).localeCompare(a.decision?.at ?? a.updatedAt));
  return { open, recent };
}

/** Yours: an action done, not relevant, or open again. */
export async function decideAction(store: Store, key: string, status: 'open' | 'done' | 'not-relevant', note?: string): Promise<ReviewAction> {
  const old = store.actions.find((a) => a.key === key);
  if (!old) throw new StoreError(`No action "${key}"`, 404);
  const now = nowISO();
  const { decision: _d, closed: _c, ...rest } = old;
  const next: ReviewAction = status === 'open' ? { ...rest, updatedAt: now } : { ...old, decision: { status, at: now, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) }, updatedAt: now };
  await store.setActions(
    store.actions.map((a) => (a.key === key ? next : a)),
    `actions: ${key} ${status === 'open' ? 'reopened' : status} by owner`,
  );
  return next;
}
