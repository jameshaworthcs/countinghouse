// An account's terms as a reading gives them (FORMULAS.md §4, "Terms"): its rates in detail, with the
// credit limit or overdraft and the one rate every reading gives, kept as one terms record.

import { ACCOUNT_TYPE_META } from './accounts';
import { toMinor } from './money';
import type { AccountType, ExtractedTerms, Terms, TermsRate, TermsRateApplies } from './schema';

/** How a rate is named, by what it applies to. */
export const RATE_NAMES: Record<TermsRateApplies, string> = {
  interest: 'Interest',
  purchases: 'Purchases',
  cash: 'Cash',
  'balance-transfers': 'Balance transfers',
  overdraft: 'Overdraft',
  loan: 'Interest charged',
  other: 'Other',
};

/** What an account's one headline rate is: a card's purchase rate, a loan's, or interest paid to you. */
export function headlineApplies(type: AccountType): TermsRateApplies {
  if (type === 'credit_card') return 'purchases';
  return ACCOUNT_TYPE_META[type].liability ? 'loan' : 'interest';
}

/** What a terms record holds, without where it is from. */
export type TermsContent = Pick<Terms, 'rates' | 'limit' | 'minimumPayment' | 'paymentDue'>;

/**
 * The terms a reading gives an account of `type`: every rate in detail, and the headline rate when
 * the detail has none of its kind (an AER is interest paid; a card's rate, its purchase rate), with
 * the credit limit or overdraft. Undefined when it gives none.
 */
export function termsOfReading(r: { creditLimit?: number | undefined; interestRate?: number | undefined; terms?: ExtractedTerms | undefined }, type: AccountType): TermsContent | undefined {
  const rates: TermsRate[] = [...(r.terms?.rates ?? [])];
  const applies = headlineApplies(type);
  if (r.interestRate !== undefined && r.interestRate >= 0 && r.interestRate <= 100 && !rates.some((x) => x.applies === applies)) rates.unshift({ applies, rate: r.interestRate, ...(applies === 'interest' ? { basis: 'AER' as const } : {}) });
  const content: TermsContent = {
    rates,
    ...(r.creditLimit !== undefined ? { limit: r.creditLimit } : {}),
    ...(r.terms?.minimumPayment !== undefined ? { minimumPayment: r.terms.minimumPayment } : {}),
    ...(r.terms?.paymentDue ? { paymentDue: r.terms.paymentDue } : {}),
  };
  return rates.length || content.limit !== undefined || content.minimumPayment !== undefined ? content : undefined;
}

const rateKey = (r: TermsRate) => JSON.stringify([r.applies, Math.round(r.rate * 1000), r.basis ?? '', r.variable ?? '', r.until ?? '', r.balance === undefined ? '' : toMinor(r.balance), r.label ?? '']);

/** Do two sets of terms say the same: the same rates (in any order), limit and minimum payment? */
export function sameTerms(a: TermsContent, b: TermsContent): boolean {
  const money = (x: number | undefined, y: number | undefined) => (x === undefined ? y === undefined : y !== undefined && toMinor(x) === toMinor(y));
  const rates = (x: TermsRate[]) => x.map(rateKey).sort().join('|');
  return money(a.limit, b.limit) && money(a.minimumPayment, b.minimumPayment) && (a.paymentDue ?? '') === (b.paymentDue ?? '') && rates(a.rates) === rates(b.rates);
}
