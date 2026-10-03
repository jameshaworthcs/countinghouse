// What each account type means: how it is grouped, whether it is a liability, how its balance
// behaves, and which UK tax wrapper (if any) it sits in.

import type { Account, AccountType } from './schema';

/** Net-worth groups, in fixed chart order (this order is the categorical colour order). */
export const WRAPPER_GROUPS = ['cash', 'isa', 'lisa', 'investments', 'pensions', 'property', 'liabilities'] as const;
export type WrapperGroup = (typeof WRAPPER_GROUPS)[number];

export const WRAPPER_GROUP_LABELS: Record<WrapperGroup, string> = {
  cash: 'Cash',
  isa: 'ISAs',
  lisa: 'Lifetime ISA',
  investments: 'Investments',
  pensions: 'Pensions',
  property: 'Property & other',
  liabilities: 'Liabilities',
};

/** Access groups: when could you actually spend it? */
export const ACCESS_GROUPS = ['now', 'soon', 'home_or_60', 'pension_age', 'illiquid', 'liabilities'] as const;
export type AccessGroup = (typeof ACCESS_GROUPS)[number];

export const ACCESS_GROUP_LABELS: Record<AccessGroup, string> = {
  now: 'Accessible now',
  soon: 'Accessible within weeks',
  home_or_60: 'First home or 60',
  pension_age: 'Pension age',
  illiquid: 'Illiquid',
  liabilities: 'Liabilities',
};

export type IsaKind = 'cash' | 'stocks' | 'lisa' | 'ifisa';

export interface AccountTypeMeta {
  label: string;
  shortLabel: string;
  group: WrapperGroup;
  access: AccessGroup;
  liability: boolean;
  balanceMode: 'ledger' | 'market';
  /** Counts toward the annual ISA allowance. */
  isa?: IsaKind;
  pension?: boolean;
  /** Interest here is tax-free (inside an ISA / pension), so it does not use the PSA. */
  taxFreeInterest: boolean;
  /** New accounts of this type default to includeInNetWorth = this. */
  defaultInNetWorth: boolean;
  /** Expect regular transaction imports (vs. only periodic balances). */
  expectsTransactions: boolean;
  /** How often new data is expected: monthly statements/screenshots, or a yearly figure. */
  cadence?: 'monthly' | 'yearly';
  /**
   * A person can hold only one (NS&I allows one Premium Bonds holding per person): a screen of this
   * kind is your only account of it, unless something on the screen says otherwise.
   */
  onePerPerson?: boolean;
  /** The only provider of this kind of account (institution catalog id). */
  issuer?: string;
  /**
   * Interest is added to it that its documents do not list as movements (a student loan's): a
   * balance worked out from its movements away from a statement leaves that out, so it is estimated.
   */
  interestUnrecorded?: boolean;
  description: string;
}

export const ACCOUNT_TYPE_META: Record<AccountType, AccountTypeMeta> = {
  current: {
    label: 'Current account',
    shortLabel: 'Current',
    group: 'cash',
    access: 'now',
    liability: false,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: true,
    description: 'Everyday bank account.',
  },
  savings: {
    label: 'Savings account',
    shortLabel: 'Savings',
    group: 'cash',
    access: 'now',
    liability: false,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: true,
    description: 'Easy-access, notice, fixed-term or regular saver. Interest counts toward your Personal Savings Allowance.',
  },
  cash_isa: {
    label: 'Cash ISA',
    shortLabel: 'Cash ISA',
    group: 'isa',
    access: 'now',
    liability: false,
    balanceMode: 'ledger',
    isa: 'cash',
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: true,
    description: 'Tax-free savings. Counts toward the £20,000 ISA allowance (cash capped at £12,000 for under-65s from April 2027).',
  },
  stocks_isa: {
    label: 'Stocks & Shares ISA',
    shortLabel: 'S&S ISA',
    group: 'isa',
    access: 'soon',
    liability: false,
    balanceMode: 'market',
    isa: 'stocks',
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Tax-free investments. Counts toward the £20,000 ISA allowance.',
  },
  lisa: {
    label: 'Lifetime ISA',
    shortLabel: 'LISA',
    group: 'lisa',
    access: 'home_or_60',
    liability: false,
    balanceMode: 'market',
    isa: 'lisa',
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: '£4,000 a year with a 25% government bonus. Penalty-free for a first home up to £450k or from age 60.',
  },
  ifisa: {
    label: 'Innovative Finance ISA',
    shortLabel: 'IF ISA',
    group: 'isa',
    access: 'soon',
    liability: false,
    balanceMode: 'market',
    isa: 'ifisa',
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Peer-to-peer lending inside an ISA.',
  },
  gia: {
    label: 'General investment account',
    shortLabel: 'GIA',
    group: 'investments',
    access: 'soon',
    liability: false,
    balanceMode: 'market',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Taxable brokerage account. Dividends, interest and gains may be taxable.',
  },
  sipp: {
    label: 'SIPP',
    shortLabel: 'SIPP',
    group: 'pensions',
    access: 'pension_age',
    liability: false,
    balanceMode: 'market',
    pension: true,
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Self-invested personal pension. Contributions get 20% relief at source.',
  },
  workplace_pension: {
    label: 'Workplace pension',
    shortLabel: 'Workplace',
    group: 'pensions',
    access: 'pension_age',
    liability: false,
    balanceMode: 'market',
    pension: true,
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Defined-contribution pension through an employer.',
  },
  personal_pension: {
    label: 'Personal pension',
    shortLabel: 'Pension',
    group: 'pensions',
    access: 'pension_age',
    liability: false,
    balanceMode: 'market',
    pension: true,
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Personal or stakeholder defined-contribution pension.',
  },
  db_pension: {
    cadence: 'yearly',
    label: 'Defined benefit pension',
    shortLabel: 'DB pension',
    group: 'pensions',
    access: 'pension_age',
    liability: false,
    balanceMode: 'market',
    pension: true,
    taxFreeInterest: true,
    defaultInNetWorth: false,
    expectsTransactions: false,
    description: 'Final-salary / career-average pension. Tracked as a forecast annual income; add a transfer value to include it in net worth.',
  },
  state_pension: {
    cadence: 'yearly',
    label: 'State Pension forecast',
    shortLabel: 'State pension',
    group: 'pensions',
    access: 'pension_age',
    liability: false,
    balanceMode: 'market',
    pension: true,
    taxFreeInterest: true,
    defaultInNetWorth: false,
    expectsTransactions: false,
    description: 'Your forecast from gov.uk/check-state-pension, as annual income.',
  },
  premium_bonds: {
    label: 'Premium Bonds',
    shortLabel: 'Premium Bonds',
    group: 'cash',
    access: 'now',
    liability: false,
    balanceMode: 'ledger',
    taxFreeInterest: true,
    defaultInNetWorth: true,
    expectsTransactions: false,
    onePerPerson: true,
    issuer: 'ns-and-i',
    description: 'NS&I Premium Bonds. Prizes are tax-free; 100% Treasury-backed.',
  },
  crypto: {
    label: 'Crypto',
    shortLabel: 'Crypto',
    group: 'investments',
    access: 'soon',
    liability: false,
    balanceMode: 'market',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Cryptoassets. Not FSCS protected.',
  },
  property: {
    cadence: 'yearly',
    label: 'Property',
    shortLabel: 'Property',
    group: 'property',
    access: 'illiquid',
    liability: false,
    balanceMode: 'market',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Home or other property at an estimated market value. Record the mortgage separately.',
  },
  other_asset: {
    cadence: 'yearly',
    label: 'Other asset',
    shortLabel: 'Asset',
    group: 'property',
    access: 'illiquid',
    liability: false,
    balanceMode: 'market',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Vehicles, valuables or anything else with a value.',
  },
  credit_card: {
    label: 'Credit card',
    shortLabel: 'Credit card',
    group: 'liabilities',
    access: 'liabilities',
    liability: true,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: true,
    description: 'Balance owed is stored as a negative number.',
  },
  loan: {
    label: 'Loan',
    shortLabel: 'Loan',
    group: 'liabilities',
    access: 'liabilities',
    liability: true,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Personal loan or car finance. Balance owed is negative.',
  },
  mortgage: {
    cadence: 'yearly',
    label: 'Mortgage',
    shortLabel: 'Mortgage',
    group: 'liabilities',
    access: 'liabilities',
    liability: true,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Outstanding mortgage balance (negative).',
  },
  student_loan: {
    cadence: 'yearly',
    label: 'Student loan',
    shortLabel: 'Student loan',
    group: 'liabilities',
    access: 'liabilities',
    liability: true,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: false,
    expectsTransactions: false,
    interestUnrecorded: true,
    description: 'Plan 1/2/4/5 or postgraduate. Excluded from net worth by default because repayments work like a graduate tax and the balance may be written off.',
  },
  other_liability: {
    label: 'Other liability',
    shortLabel: 'Liability',
    group: 'liabilities',
    access: 'liabilities',
    liability: true,
    balanceMode: 'ledger',
    taxFreeInterest: false,
    defaultInNetWorth: true,
    expectsTransactions: false,
    description: 'Anything else you owe (negative).',
  },
};

export function typeMeta(type: AccountType): AccountTypeMeta {
  return ACCOUNT_TYPE_META[type];
}

export function cadenceOf(type: AccountType): 'monthly' | 'yearly' {
  return ACCOUNT_TYPE_META[type].cadence ?? 'monthly';
}

/**
 * Days after which an account updated once a year (an annual pension statement) counts as stale:
 * a year plus a month's grace for the statement to arrive. Monthly accounts use
 * `settings.staleAfterDays`.
 */
export const YEARLY_STALE_AFTER_DAYS = 400;

export function staleAfterDays(type: AccountType, monthlyDays: number): number {
  return cadenceOf(type) === 'yearly' ? YEARLY_STALE_AFTER_DAYS : monthlyDays;
}

export function balanceModeOf(account: Pick<Account, 'type' | 'balanceMode'>): 'ledger' | 'market' {
  return account.balanceMode ?? ACCOUNT_TYPE_META[account.type].balanceMode;
}

/** Account types in a sensible display order. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  'current',
  'savings',
  'premium_bonds',
  'cash_isa',
  'stocks_isa',
  'lisa',
  'ifisa',
  'gia',
  'crypto',
  'workplace_pension',
  'sipp',
  'personal_pension',
  'db_pension',
  'state_pension',
  'property',
  'other_asset',
  'credit_card',
  'loan',
  'mortgage',
  'student_loan',
  'other_liability',
];

/** "Monzo Current Account" -> "monzo-current-account", unique against `taken`. */
export function slugify(text: string, taken: Iterable<string> = []): string {
  const base =
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'item';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
