// An account's terms (terms.jsonl): its rates, its limit and a card's minimum payment as its
// documents give them; the latest, how they changed, and what ends soon (FORMULAS.md §4, "Terms").

import type { Alert, TermsResponse } from '../../shared/api';
import { diffDays, formatDate, today, type ISODate } from '../../shared/dates';
import { formatMoney, toMinor } from '../../shared/money';
import type { Terms, TermsRate, TermsRateApplies } from '../../shared/schema';
import { RATE_NAMES } from '../../shared/terms';
import type { Store } from '../store';

/** Days ahead that a rate's end is shown as coming. */
export const TERMS_ENDING_DAYS = 60;

/**
 * The rate paid on what the account holds, from the latest terms that give one: the first of its
 * interest rates still running on `on`, or, when every one has ended, the one that ended.
 */
export function interestFromTerms(store: Store, accountId: string, on: ISODate): { terms: Terms; rate: TermsRate; ended: boolean } | undefined {
  // A year's rates: a monthly one is not a rate a year.
  const yearly = (r: TermsRate) => r.applies === 'interest' && r.per !== 'month';
  const terms = store
    .terms(accountId)
    .filter((t) => t.rates.some(yearly))
    .at(-1);
  if (!terms) return undefined;
  const rates = terms.rates.filter(yearly);
  const running = rates.find((r) => !r.until || r.until >= on);
  return running ? { terms, rate: running, ended: false } : { terms, rate: rates[0]!, ended: true };
}

/** A kind of rate's standing rate in one set of terms: the one with no end, else the first. */
const standing = (t: Terms, applies: TermsRateApplies) => {
  const of = t.rates.filter((r) => r.applies === applies);
  return of.find((r) => !r.until) ?? of[0];
};

export function termsView(store: Store, accountId: string, now: ISODate = today()): TermsResponse {
  // What documents of `now` or before give: a month looked back on knows nothing of later ones.
  const all = store.terms(accountId).filter((t) => t.asOf <= now);
  // Each part from the latest document that gives it: a screenshot showing only the limit does not
  // hide the rates the statement before it gave.
  const fileNames = new Map(store.imports.map((i) => [i.id, i.fileName]));
  const from = (t: Terms) => ({ asOf: t.asOf, ...(t.source.importId ? { importId: t.source.importId, ...(fileNames.has(t.source.importId) ? { fileName: fileNames.get(t.source.importId)! } : {}) } : {}) });
  const withRates = all.filter((t) => t.rates.length).at(-1);
  const withLimit = all.filter((t) => t.limit !== undefined).at(-1);
  const withMinimum = all.filter((t) => t.minimumPayment !== undefined).at(-1);
  const changes: TermsResponse['changes'] = [];
  const last = new Map<string, number>();
  const note = (asOf: string, what: 'limit' | TermsRateApplies, value: number | undefined, scale: (n: number) => number) => {
    if (value === undefined) return;
    const before = last.get(what);
    if (before === undefined || scale(before) !== scale(value)) changes.push({ asOf, what, ...(before !== undefined ? { from: before } : {}), to: value });
    last.set(what, value);
  };
  for (const t of all) {
    note(t.asOf, 'limit', t.limit, toMinor);
    for (const applies of new Set(t.rates.map((r) => r.applies))) note(t.asOf, applies, standing(t, applies)?.rate, (n) => Math.round(n * 1000));
  }
  const ending = (withRates?.rates ?? []).flatMap((rate) => {
    if (!rate.until) return [];
    const days = diffDays(now, rate.until);
    return days <= TERMS_ENDING_DAYS ? [{ rate, days }] : [];
  });
  return {
    ...(withRates ? { rates: { ...from(withRates), rates: withRates.rates } } : {}),
    ...(withLimit ? { limit: { ...from(withLimit), value: withLimit.limit! } } : {}),
    ...(withMinimum ? { minimum: { ...from(withMinimum), amount: withMinimum.minimumPayment!, ...(withMinimum.paymentDue ? { due: withMinimum.paymentDue } : {}) } } : {}),
    changes,
    ending,
    records: all.length,
  };
}

/** Rates on open accounts that end within 60 days, as alerts for the overview. */
export function termsAlerts(store: Store, now: ISODate = today()): Alert[] {
  return store.accounts
    .filter((a) => a.status === 'open')
    .flatMap((a) =>
      termsView(store, a.id, now)
        .ending.filter((e) => e.days >= 0)
        .map(({ rate, days }) => ({
          id: `terms-${a.id}-${rate.applies}-${rate.until}`,
          level: 'info' as const,
          title: `${a.name}: ${rate.label ?? RATE_NAMES[rate.applies].toLowerCase()} at ${rate.rate}% ends ${days === 0 ? 'today' : `on ${formatDate(rate.until!)}`}`,
          detail: `${rate.balance !== undefined ? `${formatMoney(rate.balance)} is at this rate. ` : ''}See what applies after it on the account's page.`,
          action: { label: 'Terms', href: `/accounts/${a.id}#terms` },
        })),
    );
}
