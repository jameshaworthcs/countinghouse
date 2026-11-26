// Which of your accounts does an extracted account belong to?

import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import { formatDate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import { sameFundName } from '../../shared/funds';
import { catalogInstitution, findInstitution } from '../../shared/institutions';
import type { Account, AccountType, Holding, Institution, NewAccountInput } from '../../shared/schema';

export interface Detected {
  institutionName?: string | undefined;
  accountName?: string | undefined;
  accountType?: AccountType | undefined;
  last4?: string | undefined;
  currency?: string | undefined;
  /** Names of the holdings the document lists. */
  holdings?: string[] | undefined;
  /** The list is the account's whole holdings (an export or a statement), not one fund's page or a scrolled screen. */
  holdingsComplete?: boolean | undefined;
  /**
   * What your accounts have recorded already of what the document shows, by account (draft.ts,
   * `recordedEvidence`): an export that names no account is still the account its rows are in.
   */
  recorded?: Map<string, RecordedEvidence> | undefined;
}

/** One account's share of a document's rows and opening balance, as recorded already. */
export interface RecordedEvidence {
  /** The document's settled rows, and how many of them the account has on the same day for the same amount. */
  of: number;
  rows: number;
  /** Of those, the rows whose balance after is the account's too. */
  balances: number;
  /** The account's balance just before the document's first day is the balance it opens on. */
  opening?: { amount: number; date: string } | undefined;
}

const rowsWord = (n: number) => (n === 1 ? 'row' : 'rows');

/**
 * Points for what an account has recorded already of the document (docs/INGESTION.md, "Which
 * account"): a row with the same balance after is as good as the account's number; most of its rows
 * on the same days for the same amounts, or opening on the account's own balance, nearly so.
 */
function recordedPoints(ev: RecordedEvidence | undefined): { score: number; reasons: string[] } {
  if (!ev) return { score: 0, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  const some = (n: number) => (n === ev.of ? (n === 1 ? 'its row' : `its ${n} rows`) : `${n} of its ${ev.of} ${rowsWord(ev.of)}`);
  if (ev.balances > 0) {
    score += 60;
    reasons.push(`${some(ev.rows)} recorded there${ev.balances === ev.rows ? ', with the same balances' : `, ${ev.balances} with the same balance`}`);
  } else if (ev.rows >= 2 && ev.rows * 2 >= ev.of) {
    score += 40;
    reasons.push(`${some(ev.rows)} recorded there`);
  }
  if (ev.opening) {
    score += 30;
    reasons.push(`it opens on that account's balance (${formatMoney(ev.opening.amount)} on ${formatDate(ev.opening.date)})`);
  }
  return { score, reasons };
}

/**
 * The same holding, named on two screens: by ISIN or ticker when both have one, else by name
 * (shared/funds.ts: a name cut short matches the full one it begins).
 */
export function sameHolding(a: Pick<Holding, 'name' | 'isin' | 'ticker' | 'sedol'>, b: Pick<Holding, 'name' | 'isin' | 'ticker' | 'sedol'>): boolean {
  if (a.isin && b.isin) return a.isin.toUpperCase() === b.isin.toUpperCase();
  if (a.sedol && b.sedol) return a.sedol.toUpperCase() === b.sedol.toUpperCase();
  if (a.ticker && b.ticker && a.ticker.toUpperCase() === b.ticker.toUpperCase()) return true;
  return sameFundName(a.name, b.name);
}

/** Does this document identify an account at all: a provider, kind, number, name or holdings? */
export function identifies(detected: Detected): boolean {
  return Boolean(detected.institutionName || detected.accountName || detected.accountType || detected.last4 || detected.holdings?.length);
}

/** The screen says only what kind of account it is: no provider, name, number or holdings. */
export function onlyKind(detected: Detected): boolean {
  return Boolean(detected.accountType) && !detected.institutionName && !detected.accountName && !detected.last4 && !detected.holdings?.length;
}

/**
 * Could this screen be of that account? Nothing on it may say otherwise: another number, provider,
 * kind of account, currency or name. Screenshots uploaded together can span accounts.
 */
export function fitsAccount(detected: Detected, account: Account, institutions: { id: string; name: string }[]): boolean {
  if (detected.last4 && account.last4 && detected.last4 !== account.last4) return false;
  if (detected.accountType && detected.accountType !== account.type) return false;
  if (detected.currency && detected.currency !== account.currency) return false;
  const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));
  if (detected.institutionName) {
    const inst = findInstitution(detected.institutionName);
    const own = institutions.find((i) => i.id === account.institutionId);
    if (inst ? account.institutionId !== undefined && inst.id !== account.institutionId : !own || !overlaps(words(detected.institutionName), words(own.name))) return false;
  }
  if (detected.accountName) {
    const named = words(detected.accountName);
    if (named.size && !fitsName(named, account)) return false;
  }
  return true;
}

/** A name shares a word with the account's name, one of its aliases, or its kind ("Savings account"). */
function fitsName(named: Set<string>, account: Account): boolean {
  return [account.name, ...account.aliases, ACCOUNT_TYPE_META[account.type].label].some((n) => [...words(n)].some((w) => named.has(w)));
}

export interface AccountMatch {
  accountId?: string;
  score: number;
  reason: string;
  /** Accounts that match equally well: nothing on the document tells them apart, so you choose. */
  tied?: string[];
}

function words(s: string | undefined): Set<string> {
  return new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

export function matchAccount(detected: Detected, accounts: Account[], institutions: Institution[], hintAccountId?: string, held?: Map<string, Pick<Holding, 'name' | 'isin' | 'ticker'>[]>): AccountMatch {
  const inst = findInstitution(detected.institutionName) ?? findInstitution(detected.accountName);
  let best: AccountMatch = { score: 0, reason: 'No existing account looked like this one' };
  // Accounts scoring the same as the best, with their reasons: a tie is not a match.
  let level: { account: Account; reasons: string[] }[] = [];
  // Apps rarely show their own name on screen: being your only account of a type is evidence too.
  const ofType = detected.accountType ? accounts.filter((a) => a.status !== 'closed' && a.type === detected.accountType).length : 0;
  // A scrolled screen may name only the provider: being your only open account there is evidence.
  const atProvider = inst ? accounts.filter((a) => a.status !== 'closed' && a.institutionId === inst.id).length : 0;
  for (const a of accounts) {
    let score = 0;
    const reasons: string[] = [];
    // A closed account still takes its old statements, but an open one wins a tie.
    if (a.status === 'closed') score -= 20;
    if (hintAccountId === a.id) {
      score += 100;
      reasons.push('your choice');
    }
    if (detected.last4 && a.last4) {
      if (detected.last4 === a.last4) {
        score += 60;
        reasons.push(`number ending ${a.last4}`);
      } else {
        score -= 100;
      }
    }
    const accountInst = a.institutionId;
    const instName = institutions.find((i) => i.id === accountInst)?.name;
    if (inst && accountInst === inst.id) {
      score += 30;
      reasons.push(`provider (${inst.name})`);
      if (!detected.accountType && atProvider === 1 && a.status !== 'closed') {
        score += 20;
        reasons.push(`your only ${inst.name} account`);
      }
    } else if (inst && accountInst && accountInst !== inst.id) {
      score -= 40;
    } else if (detected.institutionName && instName && words(detected.institutionName).size && [...words(detected.institutionName)].some((w) => words(instName).has(w))) {
      score += 20;
      reasons.push(`provider (${instName})`);
    }
    if (detected.accountType) {
      if (detected.accountType === a.type) {
        score += 25;
        reasons.push(`type (${ACCOUNT_TYPE_META[a.type].shortLabel})`);
        // Only the open one is your only account of its type: a closed one does not borrow it.
        if (ofType === 1 && a.status !== 'closed') {
          score += 15;
          reasons.push(`your only ${ACCOUNT_TYPE_META[a.type].shortLabel}`);
          // Being your only LISA is a suggestion; being your only Premium Bonds is the account, since
          // a person holds only one. Unless the screen names another number, provider or name.
          if (ACCOUNT_TYPE_META[a.type].onePerPerson && fitsAccount(detected, a, institutions)) {
            score += 20;
            reasons.push('a person holds only one');
          }
        }
      } else if (ACCOUNT_TYPE_META[detected.accountType].group !== ACCOUNT_TYPE_META[a.type].group) {
        score -= 30;
      }
    }
    const names = [a.name, ...a.aliases];
    const dn = words(detected.accountName);
    if (dn.size && names.some((n) => [...words(n)].filter((w) => dn.has(w)).length >= Math.min(2, dn.size))) {
      score += 15;
      reasons.push('similar name');
    } else if (dn.size && !fitsName(dn, a)) {
      // A product named on the document that shares no word with the account's names or kind is
      // another product ("Easy Access Issue 4" is not your "2 Year Fixed Rate"), even at the same
      // provider: the provider and kind alone are then not enough.
      score -= 25;
    }
    if (detected.currency && detected.currency !== a.currency) score -= 50;
    // Never for an account whose number the document contradicts.
    const known = detected.last4 && a.last4 && detected.last4 !== a.last4 ? { score: 0, reasons: [] } : recordedPoints(detected.recorded?.get(a.id));
    score += known.score;
    reasons.push(...known.reasons);
    // An account already holding every fund the screen lists (a fund's own page names no account).
    const funds = detected.holdings ?? [];
    const has = held?.get(a.id) ?? [];
    if (funds.length && has.length && funds.every((name) => has.some((h) => sameHolding({ name }, h)))) {
      score += 50;
      // A whole list (an export, a statement) that is all the account holds is that account, more
      // than one holding these funds among others: two of your accounts can hold the same fund.
      const only = Boolean(detected.holdingsComplete) && has.every((h) => funds.some((name) => sameHolding({ name }, h)));
      if (only) score += 15;
      reasons.push(`holds ${only ? 'only ' : ''}${funds.length === 1 ? 'this fund' : 'these funds'}`);
    }
    if (score > best.score) {
      best = { accountId: a.id, score, reason: `Matched by ${reasons.join(', ')}` };
      level = [{ account: a, reasons }];
    } else if (score === best.score && best.accountId) level.push({ account: a, reasons });
  }
  if (best.accountId && best.score >= 50 && level.length > 1) {
    const names = level.map((l) => `your ${l.account.name} (${l.reasons.join(', ')})`);
    return { score: best.score, reason: `Could be ${names.slice(0, -1).join(', ')} or ${names.at(-1)}, which match it equally well: choose it`, tied: level.map((l) => l.account.id) };
  }
  if (best.accountId && best.score >= 50) return best;
  return { score: best.score, reason: best.score > 0 ? `Weak match (${best.reason}); please confirm` : best.reason, ...(best.score >= 30 && best.accountId ? { accountId: best.accountId } : {}) };
}

/**
 * The provider a section shows of itself: one it names, one its account's name names ("MONZO FLEX"),
 * or the only issuer of its kind (Premium Bonds are NS&I's).
 */
export function providerShown(detected: Detected): string | undefined {
  const issuer = detected.accountType ? ACCOUNT_TYPE_META[detected.accountType].issuer : undefined;
  return detected.institutionName ?? findInstitution(detected.accountName)?.name ?? (issuer ? catalogInstitution(issuer)?.name : undefined);
}

/**
 * The provider of the accounts on a document, for one that names none of its own. One bank's screen
 * of its accounts ("Banking & savings") seldom prints the bank's name; the accounts on it you
 * already have, or that show a provider (`providerShown`), say which. Only when they all say the
 * same provider: a screen with accounts at two providers (an app that shows other banks' accounts)
 * says nothing, and an account of yours with no provider recorded could be anyone's. `accounts`
 * names your accounts that said it, and `count` how many sections did, for the review page.
 */
export function providerBeside(store: { account(id: string): Account | undefined; institutions: Institution[] }, sections: { provider?: string | undefined; accountId?: string | undefined }[]): { id: string; name: string; accounts: string[]; count: number } | undefined {
  const ids = new Set<string>();
  const accounts: string[] = [];
  let count = 0;
  for (const s of sections) {
    if (s.provider) {
      const own = store.institutions.find((i) => i.name.toLowerCase() === s.provider!.toLowerCase());
      ids.add(findInstitution(s.provider)?.id ?? own?.id ?? `named:${s.provider.toLowerCase()}`);
      count++;
      continue;
    }
    const account = s.accountId ? store.account(s.accountId) : undefined;
    if (!account) continue;
    ids.add(account.institutionId ?? `unknown:${account.id}`);
    count++;
    if (!accounts.includes(account.name)) accounts.push(account.name);
  }
  if (ids.size !== 1) return undefined;
  const id = [...ids][0]!;
  const name = store.institutions.find((i) => i.id === id)?.name ?? catalogInstitution(id)?.name;
  return name ? { id, name, accounts, count } : undefined;
}

// Words an account's name keeps in capitals when written out of a screen's capitals ("CASH ISA").
const KEEP_CAPITALS = new Set(['isa', 'isas', 'lisa', 'jisa', 'sipp', 'ssas', 'gia', 'etf', 'aer', 'apr', 'uk', 'us', 'eu', 'gbp', 'usd', 'eur', 'saye', 'vct', 'eis', 'oeic', 'nhs', 'aj', 'uss']);

/**
 * An account's name as a page shows it: one printed in capitals ("EDGE SAVER") written as a name
 * ("Edge Saver"), keeping abbreviations ("CASH ISA" is "Cash ISA", "E-ISA"), numbers ("30-Day")
 * and words with no vowel ("HSBC"). A name in mixed case is left as printed.
 */
export function accountNameCase(name: string): string {
  if (/[a-z]/.test(name) || !/[A-Z]/.test(name)) return name;
  // Each word, and each part of one joined by a hyphen, slash or bracket, on its own.
  return name
    .split(/([\s\-/()]+)/)
    .map((part) => {
      const bare = part.toLowerCase().replace(/[^a-z]/g, '');
      if (!bare || KEEP_CAPITALS.has(bare) || /\d|&/.test(part) || !/[aeiouy]/.test(bare)) return part;
      return part.charAt(0) + part.slice(1).toLowerCase();
    })
    .join('');
}

/** The name a provider goes by in an account's name: "Santander UK" is "Santander", "Aqua (NewDay)" is "Aqua". */
export function brandOf(provider: string): string {
  return provider.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+UK$/i, '').trim() || provider;
}

/** A sensible new-account proposal for something we could not match. */
export function proposeAccount(detected: Detected, accounts: Account[], fallbackType: AccountType = 'current', institutions: readonly Pick<Institution, 'id' | 'name'>[] = []): NewAccountInput {
  const type = detected.accountType ?? fallbackType;
  // Only NS&I issues Premium Bonds: the provider follows from the kind.
  const issuer = ACCOUNT_TYPE_META[type].issuer;
  // A provider of yours the catalogue does not know (a building society you added) is still that one.
  const yours = detected.institutionName ? institutions.find((i) => i.name.toLowerCase() === detected.institutionName!.toLowerCase()) : undefined;
  const inst: Pick<Institution, 'id' | 'name'> | undefined = findInstitution(detected.institutionName) ?? yours ?? findInstitution(detected.accountName) ?? (issuer ? catalogInstitution(issuer) : undefined);
  const label = ACCOUNT_TYPE_META[type].label;
  const instName = inst?.name ?? detected.institutionName ?? undefined;
  const brand = instName ? brandOf(instName) : undefined;
  const accountName = detected.accountName ? accountNameCase(detected.accountName) : undefined;
  const name =
    accountName && brand && !accountName.toLowerCase().includes(brand.toLowerCase().split(' ')[0]!)
      ? `${brand} ${accountName}`
      : (accountName ?? (brand ? `${brand} ${label}` : label));
  const id = slugify(
    [inst?.id ?? instName, ACCOUNT_TYPE_META[type].shortLabel, detected.last4].filter(Boolean).join(' '),
    accounts.map((a) => a.id),
  );
  return {
    id,
    name,
    type,
    currency: detected.currency ?? 'GBP',
    ...(inst ? { institutionId: inst.id } : {}),
    ...(instName ? { institutionName: instName } : {}),
    ...(detected.last4 ? { last4: detected.last4 } : {}),
  };
}
