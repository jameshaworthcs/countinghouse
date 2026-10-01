// Checking a reading of a timesheet against the spreadsheet itself (docs/INGESTION.md, "Timesheets").
// Each period's earned pay must be a figure on that period's sheet, to the penny; a sheet with pay on
// two days or more must have had its period read. What passes needs no second reading.

import { formatMonth } from '../../shared/dates';
import { formatMoney, toMinor } from '../../shared/money';
import type { DraftFigure } from '../../shared/schema';
import type { Sheet } from './xlsx';

export interface TimesheetCheck {
  /** What the sheets contradict: the reading should be read again. */
  problems: string[];
  /** The earned_pay figures the sheets confirm, by draft key. */
  confirmed: Set<string>;
}

/** The dates on a sheet, from its date cells. */
const datesOf = (s: Sheet) => s.rows.flatMap((r) => r.cells.filter((c) => c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.text)).map((c) => c.text));

/** Rows that are a dated day with money on it: pay recorded for that day. */
const paidDays = (s: Sheet) => s.rows.filter((r) => r.cells.some((c) => c.date) && r.cells.some((c) => c.money && c.value !== undefined && toMinor(c.value) !== 0)).length;

export function checkEarnedPay(figures: DraftFigure[], sheets: Sheet[]): TimesheetCheck {
  const problems: string[] = [];
  const confirmed = new Set<string>();
  const earned = figures.filter((f) => f.kind === 'earned_pay');
  for (const f of earned) {
    if (!f.periodStart || !f.periodEnd) {
      problems.push(`${f.label}: no period was read for it`);
      continue;
    }
    const own = sheets.filter((s) => datesOf(s).some((d) => d >= f.periodStart! && d <= f.periodEnd!));
    const target = toMinor(f.amount);
    const found = own.some((s) => s.rows.some((r) => r.cells.some((c) => c.value !== undefined && toMinor(c.value) === target)));
    if (found) confirmed.add(f.key);
    else problems.push(`${f.label}: ${formatMoney(f.amount)} is not on the sheet for ${formatMonth(f.periodEnd)}`);
  }
  // A sheet with pay on two days or more is a period with work in it: it must have been read.
  for (const s of sheets) {
    if (paidDays(s) < 2) continue;
    const dates = datesOf(s);
    const covered = earned.some((f) => f.periodStart && f.periodEnd && dates.some((d) => d >= f.periodStart! && d <= f.periodEnd!));
    if (!covered) problems.push(`Sheet “${s.name}” has pay on it, but no earned pay was read for it`);
  }
  return { problems, confirmed };
}
