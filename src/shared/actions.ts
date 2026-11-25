// What a month in review asks you to do (docs/AGENTS.md, "monthly-review"; docs/DATA_FORMAT.md,
// actions.json): the pages an action may send you to, the grammar of its key, and how it ages. Pure,
// shared by the server (the job's checks and GET /api/actions) and the page.

import { diffDays, type ISODate } from './dates';
import type { ReviewAction } from './schema';

/** The pages an action may link to, by name. */
export const ACTION_PAGES = {
  overview: '/',
  accounts: '/accounts',
  transactions: '/transactions',
  spending: '/spending',
  categorise: '/spending/categorise',
  budgets: '/spending#budgets',
  investments: '/investments',
  projections: '/projections',
  tax: '/tax',
  'tax-pay': '/tax/pay',
  'tax-self-assessment': '/tax/self-assessment',
  import: '/import',
  assumptions: '/assumptions',
} as const;
export type ActionPage = keyof typeof ACTION_PAGES;
export const ACTION_PAGE_IDS = Object.keys(ACTION_PAGES) as [ActionPage, ...ActionPage[]];

/**
 * An action's key: what it is about, then a few words for the topic, so the next review can carry
 * the same action under the same key. `acct-`, `job-` and `cat-` name an account, a job or a
 * category by its id; `payee-` a payee in words; `tax-` a tax year ("tax-2026-27-isa"); `plan-`
 * anything else.
 */
export const ACTION_KEY = /^(acct|job|payee|tax|cat|plan)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ACTION_KEY_PREFIXES = ['acct', 'job', 'payee', 'tax', 'cat', 'plan'] as const;

/** How an action ages (docs/AGENTS.md, "monthly-review"). */
export const ACTION_AGING = {
  /** A dated action is due soon from this many days before its date… */
  dueSoonDays: 14,
  /** …and leaves the list this many days after it. */
  expireAfterDays: 30,
  /** An undated action no review has said again for this many days asks whether it still matters… */
  staleDays: 60,
  /** …and leaves the list after this many. */
  expireUndatedDays: 90,
} as const;

export type ActionState = 'open' | 'due-soon' | 'overdue' | 'stale' | 'expired' | 'closed' | 'done' | 'not-relevant';

/** Where an action stands today: decided by you, closed by a review, or open and how it has aged. */
export function actionState(a: ReviewAction, today: ISODate): ActionState {
  if (a.decision) return a.decision.status;
  if (a.closed) return 'closed';
  if (a.by) {
    const days = diffDays(today, a.by);
    if (days < -ACTION_AGING.expireAfterDays) return 'expired';
    if (days < 0) return 'overdue';
    if (days <= ACTION_AGING.dueSoonDays) return 'due-soon';
    return 'open';
  }
  const age = diffDays(a.updatedAt.slice(0, 10), today);
  if (age > ACTION_AGING.expireUndatedDays) return 'expired';
  if (age > ACTION_AGING.staleDays) return 'stale';
  return 'open';
}

/** States that are on your list. */
export const ACTIVE_STATES: ReadonlySet<ActionState> = new Set(['open', 'due-soon', 'overdue', 'stale']);
