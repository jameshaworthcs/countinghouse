// Categorisation: decides payee and category for a transaction.
//
// Precedence (first hit wins; a user's manual edit is never overwritten because callers skip
// transactions with categorisedBy = "user"):
//   1. your rules (data/rules.json), by priority
//   2. transfers to/from your own accounts (by account aliases and institution names; never cash
//      from a machine, whichever bank runs it)
//   3. wrapper-account flows (contributions, tax relief, LISA bonus, fees) on ISA/pension accounts
//   3b. a payment one of your agreements schedules (agreements.json)
//   4. built-in UK merchant list
//   5. the bank's own category (Monzo/Starling/Revolut/Amex exports)
//   6. Claude's suggestion (from screenshot/PDF extraction)

import { ACCOUNT_TYPE_META } from './accounts';
import { agreementPattern, isScheduledPayment } from './agreements';
import { CategoryIndex, mapBankCategory } from './categories';
import { INSTITUTION_CATALOG, TRANSFER_WORDS } from './institutions';
import { cleanPayee, GENERIC_PAYEES, matchMerchant, normaliseDescription } from './merchants';
import type { Account, AccountType, Agreement, CategorisedBy, Institution, Rule } from './schema';

export interface CategoriseInput {
  accountId: string;
  description: string;
  amount: number;
  payee?: string | undefined;
  bankCategory?: string | undefined;
  aiCategory?: string | undefined;
  aiPayee?: string | undefined;
  /** The bank's transaction type, as printed ("Cash withdrawal", "Card payment"). */
  type?: string | undefined;
  /** The day it was paid: an agreement's payments are recognised by when they were due. */
  date?: string | undefined;
}

export interface CategoriseResult {
  payee: string;
  category?: string;
  categorisedBy?: CategorisedBy;
  ruleId?: string;
  tags?: string[];
  counterpartyAccountId?: string;
}

/**
 * Cash taken from a machine, by the description or the bank's type for the row. The bank such a row
 * names runs the machine ("Cash withdrawal, Santander, Faro"): it is not one of your accounts.
 */
const CASH_WITHDRAWAL = /\bCASH WITHDRAWAL|\bATM\b|CASH MACHINE|CASHPOINT|\bLINK\b.*\bCASH\b|\bCASH CD\b|\bCSH WDL\b/i;

export function isCashWithdrawal(description: string, type?: string): boolean {
  return CASH_WITHDRAWAL.test(description) || (type !== undefined && CASH_WITHDRAWAL.test(type));
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

/** A dividend or fund distribution as providers word it; interactive investor writes "Div 250 VANGUARD FUNDS PLC …". */
export const DIVIDEND_WORDING = /DIVIDEND|DISTRIBUTION|^DIV\b/i;

/** The pattern, its category and direction, and where the row names the investment (group 1), used as the payee. */
type WrapperRule = [pattern: RegExp, category: string, direction?: 'in' | 'out', names?: RegExp];

/** Flows inside ISA / pension / investment accounts, recognised from the provider's wording. */
const WRAPPER_RULES: WrapperRule[] = [
  // A settlement date marks a trade, whatever the fund is called (interactive investor:
  // "12 VANGUARD FTSE GLOB  Del   105.20 S Date 03/02/25").
  [/\bS\s+DATE\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/i, 'trade', undefined, /^\s*[\d,.]+\s+(.+?)\s+(?:[A-Z]+\s+)?[\d,.]+\s+S\s+DATE\b/i],
  [/GOVERNMENT BONUS|LISA BONUS|\bBONUS\b.*(HMRC|GOV)|HMRC.*BONUS/i, 'government-bonus', 'in'],
  [/TAX RELIEF|BASIC RATE RELIEF|RELIEF AT SOURCE|\bHMRC\b|INCOME TAX RECLAIM/i, 'tax-relief', 'in'],
  // interactive investor marks an employer's regular payment "(E)": "Reg Contribution (E)".
  [/EMPLOYER|CONTRIBUTION \(E\)/i, 'employer-contribution', 'in'],
  [/ISA TRANSFER|TRANSFER IN FROM|TRANSFER FROM .*(ISA|PENSION|PLAN)|PENSION TRANSFER|\bTRANSFER IN\b/i, 'transfer', 'in'],
  [/CONTRIBUTION|SUBSCRIPTION|DEPOSIT|LUMP SUM|TOP ?UP|DIRECT DEBIT|REGULAR (SAVING|INVEST)|PAYMENT IN|MONEY IN|FASTER PAYMENT|BANK TRANSFER|CARD PAYMENT/i, 'contribution', 'in'],
  [new RegExp(`${DIVIDEND_WORDING.source}|INTEREST|COUPON|INCOME`, 'i'), 'investment-income', 'in', /^DIV\s+[\d,.]+\s+(.+)$/i],
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

/**
 * Long numbers in a description: runs of 7 or more digits, with a card number printed in fours
 * ("4000 1234 5678 9010") joined up. Nothing else is joined, so a date ("ON 14-03-2026") never
 * becomes one, and a sort code and account ("12-34-56 00012345678") leave the account number whole.
 */
export function longNumbers(description: string): string[] {
  const joined = description.replace(/\b\d{4}(?: \d{4})+\b/g, (m) => m.replace(/ /g, ''));
  return (joined.match(/\d{7,}/g) ?? []).filter((n) => !/^(\d)\1+$/.test(n));
}

/**
 * Money to or from you by name ("TO SAM TAYLOR", "FROM S R TAYLOR", "FROM TAYLOR S"): from the
 * name in your profile. Only after "to" or "from", so a payer naming you as the payee ("BANK GIRO
 * CREDIT REF ACME, S TAYLOR") is not taken for your own money.
 */
export function ownNamePattern(name: string | undefined): RegExp | null {
  const parts = (name ?? '').trim().split(/\s+/).filter((p) => /^[A-Za-z][A-Za-z'-]+$/.test(p));
  if (parts.length < 2) return null;
  const [first, ...rest] = parts.map(escapeRegex) as [string, ...string[]];
  const last = rest[rest.length - 1]!;
  const middles = rest.slice(0, -1);
  const initials = parts.slice(0, -1).map((p) => p[0]!);
  const variants = [
    `${first}\\s+${middles.map((m) => `(?:${m}\\s+)?`).join('')}${last}`,
    `${initials[0]}\\.?\\s*${initials.slice(1).map((i) => `(?:${i}\\.?\\s*)?`).join('')}${last}`,
    `${last},?\\s+(?:${first}|${initials[0]}\\b)`,
  ];
  return new RegExp(`\\b(?:to|from)\\s+(?:(?:mr|mrs|ms|miss|mx|dr)\\.?\\s+)?(?:${variants.join('|')})\\b`, 'i');
}

export class Categoriser {
  private readonly rules: CompiledRule[];
  private readonly categories: CategoryIndex;
  private readonly accountsById: Map<string, Account>;
  private readonly ownMatchers: { account: Account; aliases: RegExp[]; institution: RegExp[]; ambiguous: boolean; number?: string }[];
  private readonly ownName: RegExp | null;
  private readonly payroll: RegExp | null;
  private readonly agreements: { agreement: Agreement; pattern: RegExp }[];

  /**
   * `ownerName`: the name in your profile, so money to or from you by name is seen as a transfer.
   * `payrollNumbers`: your payroll numbers at your jobs, so pay that carries one is seen as salary.
   * `agreements`: what you agreed to pay and when, so a payment one schedules takes its category.
   */
  constructor(rules: Rule[], categories: CategoryIndex, accounts: Account[], institutions: Institution[], opts: { ownerName?: string | undefined; payrollNumbers?: readonly string[]; agreements?: readonly Agreement[] } = {}) {
    this.rules = rules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
      .map(compileRule);
    this.categories = categories;
    this.ownName = ownNamePattern(opts.ownerName);
    this.payroll = payrollPattern(opts.payrollNumbers);
    this.agreements = (opts.agreements ?? []).map((agreement) => ({ agreement, pattern: agreementPattern(agreement) }));
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
        // Its number, as another bank prints it: the last digits you gave for it.
        const number = account.last4 && /^\d{4,6}$/.test(account.last4) ? account.last4 : undefined;
        return { account, aliases, institution, ambiguous: Boolean(catalog?.ambiguous), ...(number ? { number } : {}) };
      })
      .filter((m) => m.aliases.length + m.institution.length > 0 || m.number);
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
   * Own accounts (other than this one) that a description refers to.
   * - An account's number wins: a long number ending in its last digits (a sort code and account,
   *   a card number in a direct debit's reference, "EAV1234567") names that one account.
   * - Otherwise its aliases, and its institution's name. Institution names are only used outside
   *   investment/pension accounts, where platform names also appear in fund names.
   * - A cash withdrawal names none: the bank in it is the machine's (`type`, the bank's type for the
   *   row, can say it is one).
   */
  ownAccountsMentioned(accountId: string, description: string, useInstitutions = true, type?: string): Account[] {
    if (isCashWithdrawal(description, type)) return [];
    const others = this.ownMatchers.filter((m) => m.account.id !== accountId);
    const numbers = longNumbers(description);
    const byNumber = numbers.length ? others.filter((m) => m.number && numbers.some((n) => n.endsWith(m.number!))) : [];
    if (byNumber.length) return byNumber.map((m) => m.account);
    const text = normaliseDescription(description);
    const transferish = TRANSFER_WORDS.test(text);
    return others.filter((m) => m.aliases.some((re) => re.test(text)) || (useInstitutions && (!m.ambiguous || transferish) && m.institution.some((re) => re.test(text)))).map((m) => m.account);
  }

  /** Does the description pay you, or come from you, by name? */
  namesOwner(description: string): boolean {
    return this.ownName?.test(description) ?? false;
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
    const mentioned = this.ownAccountsMentioned(input.accountId, input.description, !isWrapper || account?.type === 'cash_isa', input.type);
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

    // 2b. Money to or from you by name, not saying which account: your money moving between your
    // own accounts, not spending or income. Linking it to the other side says which.
    const cash = input.amount < 0 && isCashWithdrawal(input.description, input.type);
    if (!isWrapper && !cash && this.namesOwner(input.description)) {
      return { payee: fallbackPayee, category: account?.type === 'credit_card' ? 'credit-card-payment' : 'transfer', categorisedBy: 'transfer' };
    }

    // 3. Flows inside wrapper accounts.
    if (isWrapper) {
      const dir = input.amount >= 0 ? 'in' : 'out';
      for (const [re, category, direction, names] of WRAPPER_RULES) {
        if (direction && direction !== dir) continue;
        if (re.test(input.description)) {
          const investment = input.payee || input.aiPayee ? undefined : names?.exec(input.description)?.[1]?.replace(/\s+/g, ' ').trim();
          return { payee: investment || fallbackPayee, category, categorisedBy: 'builtin' };
        }
      }
    }

    // 3b. A payment one of your agreements schedules: to its counterparty, near a due date, for about
    // what was due. It takes the agreement's category, whatever the merchant list says of the name
    // (a university is paid rent as well as fees). Its payee is worked out as any other's, so it
    // groups with the payments to the same payee before and after the agreement.
    if (!isWrapper && input.date && input.amount < 0) {
      const text = `${input.payee ?? ''} ${input.description}`;
      const hit = this.agreements.find(({ agreement, pattern }) => this.known(agreement.category) && isScheduledPayment(agreement, pattern, { date: input.date!, amount: input.amount, text }));
      if (hit) return { payee: fallbackPayee, category: hit.agreement.category, categorisedBy: 'agreement' };
    }

    // 4. Built-in merchants.
    const merchant = matchMerchant(input.description, input.amount);
    if (merchant && (!isWrapper || this.categories.kindOf(merchant.category) !== 'expense')) {
      const sourcePayee = input.payee ?? input.aiPayee;
      const payee = GENERIC_PAYEES.has(merchant.payee) ? (sourcePayee ?? cleanPayee(input.description)) : merchant.payee;
      return { payee, category: merchant.category, categorisedBy: 'builtin' };
    }
    // 4b. Cash that only the bank's type calls cash (an app lists it under the machine's bank).
    if (cash && !isWrapper && this.known('cash-withdrawal')) return { payee: fallbackPayee, category: 'cash-withdrawal', categorisedBy: 'builtin' };
    // 4c. Money in that carries one of your payroll numbers: pay. An employer's name alone is not
    // enough, since a company you own also pays you dividends and transfers under its name.
    if (input.amount > 0 && !isWrapper && this.payroll?.test(input.description) && this.known('salary')) return { payee: fallbackPayee, category: 'salary', categorisedBy: 'builtin' };

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

/**
 * Is it one person's payroll or works number, as far as can be told: 5 to 20 letters and digits. A
 * shorter one is too likely by chance, and is more often a payroll's group code ("Payroll Ref.: Q1")
 * shared by everyone on it.
 */
export const isPayrollNumber = (n: string): boolean => /^[A-Za-z0-9]{5,20}$/.test(n);

/**
 * A bank reference carrying one of your payroll numbers (`isPayrollNumber`), not inside a longer
 * number. Null with none.
 */
export function payrollPattern(numbers: readonly string[] | undefined): RegExp | null {
  const usable = [...new Set((numbers ?? []).filter(isPayrollNumber))];
  return usable.length ? new RegExp(`(?:^|[^0-9])(?:${usable.map(escapeRegex).join('|')})(?:[^0-9]|$)`, 'i') : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
