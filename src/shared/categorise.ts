// Categorisation: decides payee and category for a transaction.
//
// Precedence (first hit wins; a user's manual edit is never overwritten because callers skip
// transactions with categorisedBy = "user"):
//   1. your rules (data/rules.json), by priority
//   2. transfers to/from your own accounts (by account aliases and institution names)
//   3. wrapper-account flows (contributions, tax relief, LISA bonus, fees) on ISA/pension accounts
//   4. built-in UK merchant list
//   5. the bank's own category (Monzo/Starling/Revolut/Amex exports)
//   6. Claude's suggestion (from screenshot/PDF extraction)

import { ACCOUNT_TYPE_META } from './accounts';
import { CategoryIndex, mapBankCategory } from './categories';
import { INSTITUTION_CATALOG } from './institutions';
import { cleanPayee, GENERIC_PAYEES, matchMerchant, normaliseDescription } from './merchants';
import type { Account, AccountType, CategorisedBy, Institution, Rule } from './schema';

export interface CategoriseInput {
  accountId: string;
  description: string;
  amount: number;
  payee?: string | undefined;
  bankCategory?: string | undefined;
  aiCategory?: string | undefined;
  aiPayee?: string | undefined;
}

export interface CategoriseResult {
  payee: string;
  category?: string;
  categorisedBy?: CategorisedBy;
  ruleId?: string;
  tags?: string[];
  counterpartyAccountId?: string;
}

/** Category for money moving between two of your own accounts, from the other account's type. */
export function transferCategoryFor(otherType: AccountType, thisType?: AccountType): string {
  const other = ACCOUNT_TYPE_META[otherType];
  if (otherType === 'credit_card' || thisType === 'credit_card') return 'credit-card-payment';
  if (other.isa === 'stocks' || other.isa === 'lisa' || other.isa === 'ifisa' || other.pension || otherType === 'gia' || otherType === 'crypto') {
    return 'investment-transfer';
  }
  if (otherType === 'savings' || otherType === 'cash_isa' || otherType === 'premium_bonds') return 'savings-transfer';
  return 'transfer';
}

type WrapperRule = [pattern: RegExp, category: string, direction?: 'in' | 'out'];

/** Flows inside ISA / pension / investment accounts, recognised from the provider's wording. */
const WRAPPER_RULES: WrapperRule[] = [
  [/GOVERNMENT BONUS|LISA BONUS|\bBONUS\b.*(HMRC|GOV)|HMRC.*BONUS/i, 'government-bonus', 'in'],
  [/TAX RELIEF|BASIC RATE RELIEF|RELIEF AT SOURCE|\bHMRC\b|INCOME TAX RECLAIM/i, 'tax-relief', 'in'],
  [/EMPLOYER/i, 'employer-contribution', 'in'],
  [/ISA TRANSFER|TRANSFER IN FROM|TRANSFER FROM .*(ISA|PENSION|PLAN)|PENSION TRANSFER|\bTRANSFER IN\b/i, 'transfer', 'in'],
  [/CONTRIBUTION|SUBSCRIPTION|DEPOSIT|LUMP SUM|TOP ?UP|DIRECT DEBIT|REGULAR (SAVING|INVEST)|PAYMENT IN|MONEY IN|FASTER PAYMENT|BANK TRANSFER|CARD PAYMENT/i, 'contribution', 'in'],
  [/DIVIDEND|DISTRIBUTION|INTEREST|COUPON|INCOME/i, 'investment-income', 'in'],
  [/FEE|CHARGE|COMMISSION|STAMP DUTY|PTM LEVY|\bFX\b/i, 'investment-fee', 'out'],
  [/\bBUY\b|\bSELL\b|\bBOUGHT\b|\bSOLD\b|PURCHASE|\bSALE\b|SWITCH|REBALANC|ORDER/i, 'trade'],
  [/WITHDRAW|TRANSFER OUT|PAYMENT OUT|MONEY OUT|DRAWDOWN|TAX[- ]FREE CASH|LUMP SUM PAID/i, 'withdrawal', 'out'],
];

interface CompiledRule {
  rule: Rule;
  test: (text: string) => boolean;
}

function compileRule(rule: Rule): CompiledRule {
  const { op, value, caseSensitive } = rule.match;
  const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const needle = norm(value);
  let test: (text: string) => boolean;
  switch (op) {
    case 'equals':
      test = (t) => norm(t.trim()) === needle.trim();
      break;
    case 'startsWith':
      test = (t) => norm(t).startsWith(needle);
      break;
    case 'endsWith':
      test = (t) => norm(t).trimEnd().endsWith(needle);
      break;
    case 'regex': {
      let re: RegExp | null = null;
      try {
        re = new RegExp(value, caseSensitive ? '' : 'i');
      } catch {
        re = null;
      }
      test = (t) => (re ? re.test(t) : false);
      break;
    }
    default:
      test = (t) => norm(t).includes(needle);
  }
  return { rule, test };
}

export function ruleMatches(rule: Rule, input: CategoriseInput, payee?: string): boolean {
  return new Categoriser([rule], new CategoryIndex([]), [], []).matchRule(rule, input, payee);
}

export class Categoriser {
  private readonly rules: CompiledRule[];
  private readonly categories: CategoryIndex;
  private readonly accountsById: Map<string, Account>;
  private readonly ownMatchers: { account: Account; aliases: RegExp[]; institution: RegExp[] }[];

  constructor(rules: Rule[], categories: CategoryIndex, accounts: Account[], institutions: Institution[]) {
    this.rules = rules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
      .map(compileRule);
    this.categories = categories;
    this.accountsById = new Map(accounts.map((a) => [a.id, a]));
    const instById = new Map(institutions.map((i) => [i.id, i]));
    this.ownMatchers = accounts
      .filter((a) => a.status === 'open' || !a.closedOn)
      .map((account) => {
        const aliases: RegExp[] = [];
        for (const alias of account.aliases) {
          const trimmed = alias.trim();
          if (trimmed.length >= 3) aliases.push(new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'i'));
        }
        const institution: RegExp[] = [];
        const inst = account.institutionId ? instById.get(account.institutionId) : undefined;
        const catalog = account.institutionId ? INSTITUTION_CATALOG.find((c) => c.id === account.institutionId) : undefined;
        // Institution names identify transfers only for money-holding institutions; payroll-funded
        // pension providers would mostly produce false positives.
        const kind = inst?.kind ?? catalog?.kind;
        if (kind && kind !== 'pension_provider' && kind !== 'government') {
          if (catalog) institution.push(new RegExp(catalog.match, 'i'));
          else if (inst && inst.name.length >= 4) institution.push(new RegExp(`\\b${escapeRegex(inst.name)}\\b`, 'i'));
        }
        return { account, aliases, institution };
      })
      .filter((m) => m.aliases.length + m.institution.length > 0);
  }

  matchRule(rule: Rule, input: CategoriseInput, payee?: string): boolean {
    const m = rule.match;
    if (m.accountIds?.length && !m.accountIds.includes(input.accountId)) return false;
    if (m.direction === 'in' && input.amount < 0) return false;
    if (m.direction === 'out' && input.amount >= 0) return false;
    const abs = Math.abs(input.amount);
    if (m.amountMin !== undefined && abs < m.amountMin) return false;
    if (m.amountMax !== undefined && abs > m.amountMax) return false;
    const compiled = this.rules.find((c) => c.rule.id === rule.id) ?? compileRule(rule);
    const text = m.field === 'payee' ? (payee ?? input.payee ?? cleanPayee(input.description)) : input.description;
    return compiled.test(text);
  }

  /**
   * Own accounts (other than this one) that a description refers to. Institution names are only
   * used outside investment/pension accounts, where platform names also appear in fund names.
   */
  ownAccountsMentioned(accountId: string, description: string, useInstitutions = true): Account[] {
    const text = normaliseDescription(description);
    return this.ownMatchers
      .filter((m) => m.account.id !== accountId && (m.aliases.some((re) => re.test(text)) || (useInstitutions && m.institution.some((re) => re.test(text)))))
      .map((m) => m.account);
  }

  categorise(input: CategoriseInput): CategoriseResult {
    const account = this.accountsById.get(input.accountId);
    const fallbackPayee = input.payee ?? input.aiPayee ?? cleanPayee(input.description);

    // 1. User rules.
    for (const { rule } of this.rules) {
      if (!this.matchRule(rule, input, fallbackPayee)) continue;
      const res: CategoriseResult = {
        payee: rule.set.payee ?? fallbackPayee,
        categorisedBy: 'rule',
        ruleId: rule.id,
      };
      if (rule.set.category) res.category = rule.set.category;
      if (rule.set.tags?.length) res.tags = rule.set.tags;
      if (rule.set.counterpartyAccountId) {
        res.counterpartyAccountId = rule.set.counterpartyAccountId;
        const other = this.accountsById.get(rule.set.counterpartyAccountId);
        if (!res.category && other) res.category = transferCategoryFor(other.type, account?.type);
      }
      if (res.category || res.counterpartyAccountId || rule.set.payee) return res;
    }

    const isWrapper = account ? isWrapperAccount(account.type) : false;

    // 2. Transfers to your own accounts.
    const mentioned = this.ownAccountsMentioned(input.accountId, input.description, !isWrapper || account?.type === 'cash_isa');
    if (mentioned.length > 0) {
      const types = new Set(mentioned.map((a) => (account ? transferLegCategory(account.type, a.type, input.amount) : transferCategoryFor(a.type))));
      const [only] = mentioned;
      const res: CategoriseResult = {
        payee: mentioned.length === 1 && only ? only.name : fallbackPayee,
        category: types.size === 1 ? [...types][0]! : 'transfer',
        categorisedBy: 'transfer',
      };
      if (mentioned.length === 1 && only) res.counterpartyAccountId = only.id;
      return res;
    }

    // 3. Flows inside wrapper accounts.
    if (isWrapper) {
      const dir = input.amount >= 0 ? 'in' : 'out';
      for (const [re, category, direction] of WRAPPER_RULES) {
        if (direction && direction !== dir) continue;
        if (re.test(input.description)) {
          return { payee: fallbackPayee, category, categorisedBy: 'builtin' };
        }
      }
    }

    // 4. Built-in merchants.
    const merchant = matchMerchant(input.description, input.amount);
    if (merchant && (!isWrapper || this.categories.kindOf(merchant.category) !== 'expense')) {
      const sourcePayee = input.payee ?? input.aiPayee;
      const payee = GENERIC_PAYEES.has(merchant.payee) ? (sourcePayee ?? cleanPayee(input.description)) : merchant.payee;
      return { payee, category: merchant.category, categorisedBy: 'builtin' };
    }

    // 5. Bank-provided category.
    const bank = mapBankCategory(input.bankCategory);
    if (bank && this.known(bank)) return { payee: fallbackPayee, category: bank, categorisedBy: 'bank' };

    // 6. Claude's suggestion.
    if (input.aiCategory && this.known(input.aiCategory)) {
      return { payee: fallbackPayee, category: input.aiCategory, categorisedBy: 'ai' };
    }

    return { payee: fallbackPayee };
  }

  private known(id: string): boolean {
    return this.categories.list.length === 0 || this.categories.byId.has(id);
  }
}

/** ISA, LISA, pension and investment accounts: their flows are contributions, relief, fees, trades. */
export function isWrapperAccount(type: AccountType): boolean {
  const meta = ACCOUNT_TYPE_META[type];
  return Boolean(meta.pension || meta.isa || type === 'gia' || type === 'crypto');
}

/** Accounts whose incoming money counts toward an annual allowance (ISAs, LISA, pensions). */
export function isAllowanceWrapper(type: AccountType): boolean {
  const meta = ACCOUNT_TYPE_META[type];
  return Boolean(meta.isa || meta.pension);
}

/**
 * Category for one leg of a transfer between two of your own accounts. Money arriving in an ISA or
 * pension from outside the wrapper is a contribution (it uses allowance); leaving is a withdrawal;
 * wrapper-to-wrapper moves (ISA transfers, pension transfers) are plain transfers.
 */
export function transferLegCategory(thisType: AccountType, otherType: AccountType, amount: number): string {
  const thisWrapper = isWrapperAccount(thisType);
  const otherWrapper = isWrapperAccount(otherType);
  if (thisWrapper && otherWrapper) return 'transfer';
  if (thisWrapper) return amount >= 0 ? 'contribution' : 'withdrawal';
  return transferCategoryFor(otherType, thisType);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
