// Baselines: your monthly income, spending and saving over a past period, from covered time only
// (docs/FORMULAS.md §3). They drive the projections and the saving and runway figures.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { AssumptionSet } from '../../shared/assumptions';
import { addMonths, diffDays, eachMonth, endOfMonth, formatMonth, maxDate, minDate, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import { taxYearOf, taxYearParams } from '../../shared/uk';
import type { Store } from '../store';
import { flows, type FlowTx } from './cashflow';
import { covers, coveredDays, type Coverage, type Interval } from './coverage';

export const DAYS_PER_MONTH = 365.25 / 12;
/**
 * Fewest days every account has data for before a baseline is given without a complete month (at
 * low confidence): a month's cycle, so it holds a payday and the monthly bills. Fewer days can miss
 * the salary altogether and show a monthly loss.
 */
export const MIN_BASELINE_DAYS = 28;

export interface WrapperFlow {
  accountId: string;
  /** Monthly money paid in from your cash. */
  personal: number;
  /** Monthly money arriving from elsewhere: payroll, employer, tax relief, LISA bonus. */
  external: number;
  /** How each figure was arrived at. */
  notes: string[];
}

export interface Baseline {
  from: ISODate;
  to: ISODate;
  available: boolean;
  reason?: string | undefined;
  confidence: 'high' | 'medium' | 'low';
  /** Complete months used, or the covered days when no month is complete. */
  basis: { kind: 'months' | 'days'; months: string[]; days: number; limiting: { accountId: string; name: string; missingDays: number }[] };
  monthly: { income: number; spending: number; net: number };
  wrappers: WrapperFlow[];
  /** Monthly investing from cash to accounts the app does not know. */
  unassignedInvesting: number;
  /** Standard error of the monthly saving (income − spending), in pounds. */
  netSd: number;
  netSdBasis: string;
  /** The flows the figures were computed from (income and spending on covered days). */
  flows: FlowTx[];
}

const isWrapper = (a: Account) => {
  const meta = ACCOUNT_TYPE_META[a.type];
  return (balanceModeOf(a) === 'market' || meta.pension || meta.isa) && a.type !== 'db_pension' && a.type !== 'state_pension' && a.type !== 'cash_isa' && a.type !== 'property' && a.type !== 'other_asset';
};

/** Payroll-funded: contributions come out of pay before it reaches the bank. */
const payrollFunded = (a: Account) => a.type === 'workplace_pension' || a.pension?.method === 'net_pay' || a.pension?.method === 'salary_sacrifice';

export function computeBaseline(store: Store, coverage: Coverage, from: ISODate, to: ISODate, set: AssumptionSet): Baseline {
  const joint = coverage.joint(from, to);
  const useMonths = joint.completeMonths.length > 0;
  const covered: Interval[] = useMonths ? joint.completeMonths.map((m) => ({ from: `${m}-01`, to: endOfMonth(`${m}-01`) })) : joint.intervals;
  const periodMonths = useMonths ? joint.completeMonths.length : joint.days / DAYS_PER_MONTH;
  const basis = { kind: useMonths ? ('months' as const) : ('days' as const), months: joint.completeMonths, days: useMonths ? covered.reduce((s, i) => s + diffDays(i.from, i.to) + 1, 0) : joint.days, limiting: joint.limiting };
  const empty: Baseline = {
    from,
    to,
    available: false,
    confidence: 'low',
    basis,
    monthly: { income: 0, spending: 0, net: 0 },
    wrappers: [],
    unassignedInvesting: 0,
    netSd: 0,
    netSdBasis: '',
    flows: [],
  };
  if (!useMonths && joint.days < MIN_BASELINE_DAYS) {
    const who = joint.limiting.slice(0, 3).map((l) => l.name);
    const span = from.slice(0, 7) === to.slice(0, 7) ? formatMonth(from) : `${formatMonth(from)} – ${formatMonth(to)}`;
    return {
      ...empty,
      reason: joint.days === 0 ? `No day in ${span} has data for every account${who.length ? ` (missing: ${who.join(', ')})` : ''}` : `Only ${joint.days} days in ${span} have data for every account; at least ${MIN_BASELINE_DAYS} are needed`,
    };
  }

  const inCovered = (d: ISODate) => covers(covered, d);
  // Spending a student loan pays for you (tuition fees paid to your university) is not your own
  // money, and stops when the course does: it is left out of what continues (FORMULAS.md §3).
  const lent = new Set(store.accounts.filter((a) => a.type === 'student_loan').map((a) => a.id));
  const list = flows(store, from, to).filter((f) => inCovered(f.t.date) && !lent.has(f.t.accountId));
  const income = list.filter((f) => f.cls === 'income').reduce((s, f) => s + f.minor, 0);
  const spending = list.filter((f) => f.cls === 'spending').reduce((s, f) => s + f.minor, 0);
  const perMonth = (minor: number) => fromMinor(Math.round(minor / periodMonths));

  // Monthly net saving per complete month, for its standard error.
  let netSd: number;
  let netSdBasis: string;
  if (useMonths && joint.completeMonths.length >= 3) {
    const nets = joint.completeMonths.map((m) => list.filter((f) => f.t.date.startsWith(m)).reduce((s, f) => s + (f.cls === 'income' ? f.minor : -f.minor), 0) / 100);
    const mean = nets.reduce((s, v) => s + v, 0) / nets.length;
    const sd = Math.sqrt(nets.reduce((s, v) => s + (v - mean) ** 2, 0) / (nets.length - 1));
    netSd = sd / Math.sqrt(nets.length);
    netSdBasis = `Standard error over ${nets.length} complete months`;
  } else {
    const u = set.resolve('cashflow.uncertainty');
    netSd = u.value * (spending / 100 / periodMonths);
    netSdBasis = `${Math.round(u.value * 100)}% of monthly spending (${u.source === 'fallback' ? 'fallback' : 'assumption'}): fewer than 3 complete months`;
  }

  // Contributions to ISAs, the LISA, investment accounts and pensions.
  const ty = taxYearParams(taxYearOf(to));
  const wrappers: WrapperFlow[] = [];
  const bankSide = new Map<string, number>();
  let unassigned = 0;
  for (const a of store.accounts) {
    if (balanceModeOf(a) !== 'ledger' || !a.includeInNetWorth) continue;
    for (const t of store.transactions(a.id)) {
      if (t.amount >= 0 || !inCovered(t.date) || t.date < from || t.date > to) continue;
      const other = t.counterpartyAccountId ? store.account(t.counterpartyAccountId) : undefined;
      if (other && isWrapper(other)) bankSide.set(other.id, (bankSide.get(other.id) ?? 0) - toMinor(t.amount));
      else if (!other && t.category === 'investment-transfer') unassigned += -toMinor(t.amount);
    }
  }
  for (const a of store.accounts.filter((x) => isWrapper(x) && x.status === 'open' && x.includeInNetWorth)) {
    const notes: string[] = [];
    const txs = store.transactions(a.id);
    const snaps = store.balances(a.id);
    // The months this account has any data for within the period.
    const dataFrom = minDate(txs[0]?.date, snaps[0]?.date);
    const dataTo = maxDate(txs[txs.length - 1]?.date, snaps[snaps.length - 1]?.date);
    const spanFrom = maxDate(from, dataFrom) ?? from;
    const spanTo = minDate(to, dataTo) ?? to;
    const months = spanFrom <= spanTo ? eachMonth(spanFrom, spanTo).length : 0;
    const inPeriod = txs.filter((t) => t.date >= from && t.date <= to && t.amount > 0);
    const sum = (cats: string[]) => inPeriod.filter((t) => t.category && cats.includes(t.category)).reduce((s, t) => s + toMinor(t.amount), 0);
    const own = sum(['contribution']);
    const employer = sum(['employer-contribution']);
    const relief = sum(['tax-relief']);
    const bonus = sum(['government-bonus']);
    let personal = 0;
    let external = 0;
    const bank = bankSide.get(a.id) ?? 0;
    if (bank > 0) {
      personal = bank / 100 / periodMonths;
      notes.push('Paid in: payments from your bank accounts to it');
    } else if (own > 0 && months > 0) {
      if (payrollFunded(a)) {
        external += own / 100 / months;
        notes.push('Your contributions come out of pay before it reaches the bank, so they do not reduce your cash');
      } else {
        personal = own / 100 / months;
        notes.push(`Paid in: contributions on its statements over ${months} month${months > 1 ? 's' : ''}`);
      }
    }
    if (months > 0 && employer + relief + bonus > 0) {
      external += (employer + relief + bonus) / 100 / months;
      notes.push('Employer contributions, tax relief and bonuses on its statements');
    }
    // Money that will arrive but has not been seen yet: the LISA bonus, basic-rate relief at source.
    if (a.type === 'lisa' && personal > 0 && bonus === 0) {
      external += Math.min(personal, ty.lisaAllowance / 12) * ty.lisaBonusRate;
      notes.push(`Adds the ${Math.round(ty.lisaBonusRate * 100)}% government bonus (none recorded yet)`);
    }
    const ras = a.type === 'sipp' || a.type === 'personal_pension' || (a.pension?.method === 'relief_at_source' && !payrollFunded(a));
    if (ras && personal > 0 && relief === 0) {
      external += personal * ty.reliefAtSourceRate / (1 - ty.reliefAtSourceRate);
      notes.push(`Adds basic-rate relief at source (${Math.round(ty.reliefAtSourceRate * 100)}% of the gross; none recorded yet)`);
    }
    if (personal || external) wrappers.push({ accountId: a.id, personal: Math.round(personal * 100) / 100, external: Math.round(external * 100) / 100, notes });
  }

  const confidence = useMonths ? (joint.completeMonths.length >= 3 ? 'high' : 'medium') : 'low';
  return {
    from,
    to,
    available: true,
    confidence,
    basis,
    monthly: { income: perMonth(income), spending: perMonth(spending), net: perMonth(income - spending) },
    wrappers,
    unassignedInvesting: perMonth(unassigned),
    netSd: Math.round(netSd * 100) / 100,
    netSdBasis,
    flows: list,
  };
}

/**
 * Standard periods: the last 3 and 12 full months before `on`. When the last 3 full months have too
 * little data for every account (as after a first import), the recent period runs up to `on`, so
 * the covered days of this month count, at low confidence.
 */
export function standardPeriods(on: ISODate, coverage?: Coverage): { id: 'recent' | 'year'; label: string; from: ISODate; to: ISODate }[] {
  const lastFullMonthEnd = endOfMonth(addMonths(on, -1));
  const recent = { id: 'recent' as const, label: 'If the last 3 months continued', from: `${addMonths(lastFullMonthEnd, -2).slice(0, 7)}-01`, to: lastFullMonthEnd };
  const year = { id: 'year' as const, label: 'If the last 12 months continued', from: `${addMonths(lastFullMonthEnd, -11).slice(0, 7)}-01`, to: lastFullMonthEnd };
  if (coverage) {
    const full = coverage.joint(recent.from, recent.to);
    if (!full.completeMonths.length && full.days < MIN_BASELINE_DAYS) {
      const soFar = coverage.joint(recent.from, on);
      if (soFar.days >= MIN_BASELINE_DAYS) return [{ ...recent, label: `If the ${soFar.days} days of data so far continued`, to: on }, year];
    }
  }
  return [recent, year];
}

export { coveredDays };
