// Pension arrangements (a job's `pensionArrangements`): what an employer said it would pay into a
// pension account of yours, checked against what arrived (FORMULAS.md §11, "Pension arrangements").

import type { PensionArrangementsResponse } from '../../shared/api';
import { addDays, addMonths, today, type ISODate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { Store } from '../store';

/** Days after a single payment's form that it is looked for. */
export const SINGLE_PAYMENT_DAYS = 60;
/** Months after a monthly one's form that its first collection is looked for. */
export const FIRST_COLLECTION_MONTHS = 2;

export function arrangementsInto(store: Store, accountId: string, now: ISODate = today()): PensionArrangementsResponse {
  const credits = store
    .transactions(accountId)
    .filter((t) => t.amount > 0 && t.category === 'employer-contribution')
    .sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set<string>();
  const take = (t: { id: string; date: string } | undefined) => {
    if (!t) return undefined;
    used.add(t.id);
    return { date: t.date, transactionId: t.id };
  };
  const out: PensionArrangementsResponse['arrangements'] = [];
  for (const job of store.employments) {
    for (const a of job.pensionArrangements.filter((x) => x.accountId === accountId)) {
      const of = (t: { id: string; amount: number }) => !used.has(t.id) && toMinor(t.amount) === toMinor(a.amount);
      if (a.kind === 'single') {
        const arrived = take(credits.find((t) => of(t) && t.date >= a.from && t.date <= addDays(a.from, SINGLE_PAYMENT_DAYS)));
        out.push({ employmentId: job.id, employer: job.employer, arrangement: a, ...(arrived ? { arrived } : {}) });
        continue;
      }
      // A monthly one: from its first collection (looked for within two months of the form), a
      // collection each month to its end or now; a month with none is listed.
      const first = credits.find((t) => of(t) && t.date >= a.from && t.date <= addMonths(a.from, FIRST_COLLECTION_MONTHS));
      if (!first) {
        out.push({ employmentId: job.id, employer: job.employer, arrangement: a, collected: [], missing: [], firstSeen: false });
        continue;
      }
      const collected: { date: string; transactionId: string }[] = [];
      const missing: string[] = [];
      const last = (a.until && a.until < now ? a.until : now).slice(0, 7);
      for (let month = first.date.slice(0, 7); month <= last; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
        const t = credits.find((x) => of(x) && x.date.slice(0, 7) === month);
        if (t) collected.push(take(t)!);
        // This month's may simply not have come yet.
        else if (month !== now.slice(0, 7)) missing.push(month);
      }
      out.push({ employmentId: job.id, employer: job.employer, arrangement: a, collected, missing, firstSeen: true });
    }
  }
  // Employer contributions no arrangement accounts for, from the first arrangement on.
  const since = out.map((x) => x.arrangement.from).sort()[0];
  const others = since ? credits.filter((t) => !used.has(t.id) && t.date >= since).map((t) => ({ date: t.date, amount: t.amount, transactionId: t.id })) : [];
  return { arrangements: out, others };
}
