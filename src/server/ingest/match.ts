// Which of your accounts does an extracted account belong to?

import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import { sameFundName } from '../../shared/funds';
import { findInstitution } from '../../shared/institutions';
import type { Account, AccountType, Holding, Institution, NewAccountInput } from '../../shared/schema';

export interface Detected {
  institutionName?: string | undefined;
  accountName?: string | undefined;
  accountType?: AccountType | undefined;
  last4?: string | undefined;
  currency?: string | undefined;
  /** Names of the holdings the document lists. */
  holdings?: string[] | undefined;
}

/**
 * The same holding, named on two screens: by ISIN or ticker when both have one, else by name
 * (shared/funds.ts: a name cut short matches the full one it begins).
 */
export function sameHolding(a: Pick<Holding, 'name' | 'isin' | 'ticker'>, b: Pick<Holding, 'name' | 'isin' | 'ticker'>): boolean {
  if (a.isin && b.isin) return a.isin.toUpperCase() === b.isin.toUpperCase();
  if (a.ticker && b.ticker && a.ticker.toUpperCase() === b.ticker.toUpperCase()) return true;
  return sameFundName(a.name, b.name);
}

/** Does this document identify an account at all: a provider, kind, number, name or holdings? */
export function identifies(detected: Detected): boolean {
  return Boolean(detected.institutionName || detected.accountName || detected.accountType || detected.last4 || detected.holdings?.length);
}

export interface AccountMatch {
  accountId?: string;
  score: number;
  reason: string;
}

function words(s: string | undefined): Set<string> {
  return new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

export function matchAccount(detected: Detected, accounts: Account[], institutions: Institution[], hintAccountId?: string, held?: Map<string, Pick<Holding, 'name' | 'isin' | 'ticker'>[]>): AccountMatch {
  const inst = findInstitution(detected.institutionName) ?? findInstitution(detected.accountName);
  let best: AccountMatch = { score: 0, reason: 'No existing account looked like this one' };
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
        if (ofType === 1) {
          score += 15;
          reasons.push(`your only ${ACCOUNT_TYPE_META[a.type].shortLabel}`);
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
    }
    if (detected.currency && detected.currency !== a.currency) score -= 50;
    // An account already holding every fund the screen lists (a fund's own page names no account).
    const funds = detected.holdings ?? [];
    const has = held?.get(a.id) ?? [];
    if (funds.length && has.length && funds.every((name) => has.some((h) => sameHolding({ name }, h)))) {
      score += 50;
      reasons.push(funds.length === 1 ? 'holds this fund' : 'holds these funds');
    }
    if (score > best.score) best = { accountId: a.id, score, reason: `Matched by ${reasons.join(', ')}` };
  }
  if (best.accountId && best.score >= 50) return best;
  return { score: best.score, reason: best.score > 0 ? `Weak match (${best.reason}); please confirm` : best.reason, ...(best.score >= 30 && best.accountId ? { accountId: best.accountId } : {}) };
}

/** A sensible new-account proposal for something we could not match. */
export function proposeAccount(detected: Detected, accounts: Account[], fallbackType: AccountType = 'current'): NewAccountInput {
  const inst = findInstitution(detected.institutionName) ?? findInstitution(detected.accountName);
  const type = detected.accountType ?? fallbackType;
  const label = ACCOUNT_TYPE_META[type].label;
  const instName = inst?.name ?? detected.institutionName ?? undefined;
  const name =
    detected.accountName && instName && !detected.accountName.toLowerCase().includes(instName.toLowerCase().split(' ')[0]!)
      ? `${instName} ${detected.accountName}`
      : (detected.accountName ?? (instName ? `${instName} ${label}` : label));
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
