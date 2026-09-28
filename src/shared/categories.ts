// The default category taxonomy (UK-flavoured), written to data/categories.json on first run and
// fully editable afterwards. Categories marked `system` carry meaning in calculations, so they can
// be renamed but not deleted.

import type { Category } from './schema';

type Def = [id: string, name: string, children?: [string, string][]];

const EXPENSE: Def[] = [
  ['housing', 'Housing', [
    ['rent', 'Rent'],
    ['mortgage-payment', 'Mortgage payments'],
    ['council-tax', 'Council tax'],
    ['home-insurance', 'Home insurance'],
    ['home-maintenance', 'Repairs & maintenance'],
    ['service-charge', 'Service charge & ground rent'],
  ]],
  ['bills', 'Bills & utilities', [
    ['energy', 'Energy'],
    ['water', 'Water'],
    ['broadband', 'Broadband & TV'],
    ['mobile', 'Mobile phone'],
    ['tv-licence', 'TV licence'],
  ]],
  ['food', 'Food & drink', [
    ['groceries', 'Groceries'],
    ['eating-out', 'Eating out'],
    ['takeaway', 'Takeaway & delivery'],
    ['coffee', 'Coffee & snacks'],
    ['pubs-bars', 'Pubs & bars'],
  ]],
  ['transport', 'Transport', [
    ['public-transport', 'Public transport'],
    ['trains', 'Trains'],
    ['taxis', 'Taxis & ride-hailing'],
    ['fuel', 'Fuel & charging'],
    ['parking', 'Parking & tolls'],
    ['car-insurance', 'Car insurance'],
    ['car-maintenance', 'Car maintenance'],
    ['vehicle-tax', 'Vehicle tax'],
  ]],
  ['shopping', 'Shopping', [
    ['clothing', 'Clothing & shoes'],
    ['electronics', 'Electronics'],
    ['home-garden', 'Home & garden'],
    ['online-marketplace', 'Amazon & marketplaces'],
    ['general-shopping', 'General shopping'],
  ]],
  ['subscriptions', 'Subscriptions', [
    ['streaming', 'Streaming'],
    ['software', 'Software & cloud'],
    ['memberships', 'Memberships'],
    ['news-magazines', 'News & magazines'],
  ]],
  ['health', 'Health & fitness', [
    ['gym', 'Gym & sport'],
    ['pharmacy', 'Pharmacy'],
    ['dental', 'Dentist'],
    ['optical', 'Opticians'],
    ['healthcare', 'Healthcare'],
  ]],
  ['personal-care', 'Personal care', [['hair-beauty', 'Hair & beauty']]],
  ['entertainment', 'Entertainment', [
    ['events', 'Events & tickets'],
    ['hobbies', 'Hobbies'],
    ['games', 'Games'],
    ['books', 'Books'],
    ['cinema', 'Cinema'],
  ]],
  ['travel', 'Travel', [
    ['flights', 'Flights'],
    ['accommodation', 'Hotels & accommodation'],
    ['holidays', 'Holidays'],
  ]],
  ['family', 'Family & pets', [
    ['childcare', 'Childcare'],
    ['kids', 'Kids'],
    ['pets', 'Pets'],
  ]],
  ['giving', 'Gifts & giving', [
    ['gifts', 'Gifts'],
    ['charity', 'Charity'],
  ]],
  ['education', 'Education', [['courses', 'Courses & tuition']]],
  ['finance', 'Financial', [
    ['bank-fees', 'Bank fees'],
    ['interest-charges', 'Interest charged'],
    ['insurance', 'Insurance'],
    ['tax', 'Tax (HMRC)'],
    ['professional-fees', 'Professional fees'],
    ['loan-repayment', 'Loan repayments'],
  ]],
  ['cash', 'Cash', [['cash-withdrawal', 'Cash withdrawal']]],
  ['other-expense', 'Other spending'],
];

const INCOME: Def[] = [
  ['income', 'Income', [
    ['salary', 'Salary'],
    ['bonus', 'Bonus'],
    ['interest', 'Savings interest'],
    ['dividends', 'Dividends'],
    ['refunds', 'Refunds'],
    ['cashback', 'Cashback & rewards'],
    ['gifts-received', 'Gifts received'],
    ['benefits', 'Benefits'],
    ['side-income', 'Side income'],
    ['tax-refund', 'Tax refund'],
    ['other-income', 'Other income'],
  ]],
];

const TRANSFER: Def[] = [
  ['transfers', 'Transfers', [
    ['transfer', 'Between my accounts'],
    ['credit-card-payment', 'Credit card payment'],
    ['savings-transfer', 'To/from savings'],
    ['investment-transfer', 'To/from investments & pensions'],
  ]],
];

const INVESTMENT: Def[] = [
  ['investing', 'Investment flows', [
    ['contribution', 'Contribution'],
    ['employer-contribution', 'Employer contribution'],
    ['tax-relief', 'Tax relief'],
    ['government-bonus', 'Government bonus (LISA)'],
    ['withdrawal', 'Withdrawal'],
    ['investment-income', 'Dividends & interest (in account)'],
    ['investment-fee', 'Platform & fund fees'],
    ['trade', 'Buy / sell'],
  ]],
];

/** Categories the calculations depend on. */
export const SYSTEM_CATEGORY_IDS = new Set([
  'transfers',
  'transfer',
  'credit-card-payment',
  'savings-transfer',
  'investment-transfer',
  'investing',
  'contribution',
  'employer-contribution',
  'tax-relief',
  'government-bonus',
  'withdrawal',
  'investment-income',
  'investment-fee',
  'trade',
  'income',
  'salary',
  'interest',
  'dividends',
  'refunds',
  'cash-withdrawal',
]);

/**
 * Categories that represent money genuinely entering or leaving an investment/pension account from
 * outside it. For market-valued accounts only these move the balance between valuations; dividends,
 * fees and trades happen inside the valuation.
 */
export const EXTERNAL_FLOW_CATEGORIES = new Set([
  'contribution',
  'employer-contribution',
  'tax-relief',
  'government-bonus',
  'withdrawal',
  'transfer',
  'savings-transfer',
  'investment-transfer',
  'credit-card-payment',
]);

/** Contributions into a wrapper that count toward ISA / pension allowances. */
export const CONTRIBUTION_CATEGORIES = new Set(['contribution', 'employer-contribution', 'tax-relief', 'transfer', 'savings-transfer', 'investment-transfer']);

function expand(defs: Def[], kind: Category['kind']): Category[] {
  const out: Category[] = [];
  for (const [id, name, children] of defs) {
    out.push({ id, name, kind, ...(SYSTEM_CATEGORY_IDS.has(id) ? { system: true } : {}) });
    for (const [cid, cname] of children ?? []) {
      out.push({ id: cid, name: cname, parent: id, kind, ...(SYSTEM_CATEGORY_IDS.has(cid) ? { system: true } : {}) });
    }
  }
  return out;
}

export function defaultCategories(): Category[] {
  return [
    ...expand(EXPENSE, 'expense'),
    ...expand(INCOME, 'income'),
    ...expand(TRANSFER, 'transfer'),
    ...expand(INVESTMENT, 'investment'),
  ];
}

/** Lookup helpers built over a category list. */
export class CategoryIndex {
  readonly byId = new Map<string, Category>();
  constructor(readonly list: Category[]) {
    for (const c of list) this.byId.set(c.id, c);
  }
  get(id: string | undefined): Category | undefined {
    return id ? this.byId.get(id) : undefined;
  }
  /** The top-level group of a category (itself if it is a group). */
  groupOf(id: string | undefined): Category | undefined {
    let c = this.get(id);
    const seen = new Set<string>();
    while (c?.parent && !seen.has(c.id)) {
      seen.add(c.id);
      const p = this.byId.get(c.parent);
      if (!p) break;
      c = p;
    }
    return c;
  }
  kindOf(id: string | undefined): Category['kind'] | undefined {
    return this.get(id)?.kind;
  }
  name(id: string | undefined): string {
    if (!id) return 'Uncategorised';
    return this.get(id)?.name ?? id;
  }
  /** "Food & drink › Groceries" */
  path(id: string | undefined): string {
    const c = this.get(id);
    if (!c) return this.name(id);
    const parent = c.parent ? this.get(c.parent) : undefined;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  }
  /** Is this spending/income that belongs in cash-flow reports (not a transfer or investment flow)? */
  isCashflow(id: string | undefined): boolean {
    const kind = this.kindOf(id);
    return kind === undefined || kind === 'expense' || kind === 'income';
  }
  children(groupId: string): Category[] {
    return this.list.filter((c) => c.parent === groupId);
  }
  groups(): Category[] {
    return this.list.filter((c) => !c.parent);
  }
}

/**
 * Map bank-provided categories (Monzo, Starling, Revolut, Amex exports) to ours. Keys are
 * lower-cased and stripped of punctuation.
 */
export const BANK_CATEGORY_MAP: Record<string, string> = {
  groceries: 'groceries',
  eatingout: 'eating-out',
  eating_out: 'eating-out',
  restaurants: 'eating-out',
  takeaway: 'takeaway',
  transport: 'public-transport',
  travel: 'holidays',
  holidays: 'holidays',
  shopping: 'general-shopping',
  entertainment: 'hobbies',
  bills: 'bills',
  billsandutilities: 'bills',
  expenses: 'other-expense',
  general: 'other-expense',
  personalcare: 'hair-beauty',
  family: 'kids',
  gifts: 'gifts',
  charity: 'charity',
  finances: 'finance',
  income: 'other-income',
  savings: 'savings-transfer',
  transfers: 'transfer',
  cash: 'cash-withdrawal',
  health: 'healthcare',
  lifestyle: 'hobbies',
  petrol: 'fuel',
  fuel: 'fuel',
  subscriptions: 'subscriptions',
  payment: 'credit-card-payment',
  salary: 'salary',
  interest: 'interest',
  charges: 'bank-fees',
};

export function mapBankCategory(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/[^a-z_]/g, '');
  return BANK_CATEGORY_MAP[key] ?? BANK_CATEGORY_MAP[key.replace(/_/g, '')];
}
