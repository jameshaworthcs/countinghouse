// Which days of a stretch no document covers you can confirm, one at a time or all at once
// (docs/FORMULAS.md §3, "Balance evidence").

import type { CoverageGapView } from './api';
import { addDays, addMonths, startOfMonth, type ISODate } from './dates';
import type { DraftSection } from './schema';

/**
 * The last day "confirm all" reaches: the end of the month before last. Every monthly statement
 * that includes it has been issued by then, so a document that has not come is not still on its
 * way. Later days are the monthly update's: their statements are still due.
 */
export function settledThrough(now: ISODate): ISODate {
  return addDays(startOfMonth(addMonths(now, -1)), -1);
}

/**
 * The last day a stretch can be confirmed to: as far as its balances reach when they add up, and
 * never today, which is still going. Null when nothing of it can be (or its balances leave
 * something unexplained: the document for those days is missing).
 */
export function confirmableTo(g: Pick<CoverageGapView, 'from' | 'to' | 'evidence'>, now: ISODate): ISODate | null {
  if (g.evidence.status === 'unexplained') return null;
  let end = g.evidence.status === 'adds-up' && g.evidence.through ? g.evidence.through : g.to;
  if (end >= now) end = addDays(now, -1);
  return end >= g.from ? end : null;
}

/** What "confirm all" confirms: each stretch whose balances add up, up to the settled day. */
export function settledStretches(gaps: CoverageGapView[], now: ISODate): { accountId: string; from: ISODate; to: ISODate }[] {
  const settled = settledThrough(now);
  return gaps.flatMap((g) => {
    const to = g.evidence.status === 'adds-up' ? confirmableTo(g, now) : null;
    const end = to && to > settled ? settled : to;
    return end && end >= g.from ? [{ accountId: g.accountId, from: g.from, to: end }] : [];
  });
}

/**
 * Documents whose period is the span of their rows, not printed: a CSV export. Its first row's date
 * is not a printed start (docs/FORMULAS.md §3).
 */
export function periodFromRows(documentType: string | undefined): boolean {
  return documentType === 'csv_export';
}

/**
 * The days a draft section covers for its account (docs/FORMULAS.md §3): its printed period, else
 * the span of its rows (a statement with an opening balance and no rows: its closing day), widened
 * to `coversFrom`/`coversTo`. `fromStated` says the start was given (printed, or a range for a
 * document that prints none), so coverage does not run it on from the statement before. Null when
 * it covers no days. A schedule's rows (a loan's instalments) are not a statement: none.
 */
export function sectionSpan(
  s: Pick<DraftSection, 'periodStart' | 'periodEnd' | 'coversFrom' | 'coversTo' | 'transactions' | 'openingBalance' | 'balanceDate' | 'fromSchedule'>,
  documentType: string | undefined,
): { from: ISODate; to: ISODate; fromStated: boolean } | null {
  if (s.fromSchedule) return null;
  const dates = s.transactions.map((t) => t.date).sort();
  const readTo = s.periodEnd ?? dates[dates.length - 1] ?? (s.openingBalance !== undefined ? s.balanceDate : undefined);
  const readFrom = s.periodStart ?? dates[0] ?? readTo;
  const from = s.coversFrom && (!readFrom || s.coversFrom < readFrom) ? s.coversFrom : readFrom;
  const to = s.coversTo && (!readTo || s.coversTo > readTo) ? s.coversTo : readTo;
  if (!from || !to || from > to) return null;
  return { from, to, fromStated: Boolean((s.periodStart && !periodFromRows(documentType)) || s.coversFrom) };
}
