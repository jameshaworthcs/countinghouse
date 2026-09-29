// Estate value (net worth): everything you hold minus what you owe, now and over time.

import {
  staleAfterDays,
  ACCESS_GROUP_LABELS,
  ACCESS_GROUPS,
  ACCOUNT_TYPE_META,
  WRAPPER_GROUP_LABELS,
  WRAPPER_GROUPS,
  type AccessGroup,
  type WrapperGroup,
} from '../../shared/accounts';
import type { AccountSummary, EstateSeriesResponse } from '../../shared/api';
import { addDays, addMonths, diffDays, endOfMonth, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Account } from '../../shared/schema';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';

/** Sampling dates for a chart over [from, to]: daily, weekly or month-ends depending on span. */
export function sampleDates(from: ISODate, to: ISODate): ISODate[] {
  const span = diffDays(from, to);
  const out: ISODate[] = [];
  if (span <= 120) {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  if (span <= 800) {
    for (let d = to; d >= from; d = addDays(d, -7)) out.unshift(d);
    if (out[0] !== from) out.unshift(from);
    return out;
  }
  for (let d = endOfMonth(from); d < to; d = endOfMonth(addMonths(d, 1))) out.push(d);
  out.push(to);
  return out;
}

export function includedAccounts(store: Store): Account[] {
  return store.accounts.filter((a) => a.includeInNetWorth);
}

export function estateOn(store: Store, engine: BalanceEngine, date: ISODate) {
  let assets = 0;
  let liabilities = 0;
  let estimated = false;
  const wrapper = new Map<WrapperGroup, number>();
  const access = new Map<AccessGroup, number>();
  for (const a of includedAccounts(store)) {
    const p = engine.balanceOn(a.id, date);
    if (!p || p.gbp === null) continue;
    const minor = toMinor(p.gbp);
    if (p.estimated) estimated = true;
    const meta = ACCOUNT_TYPE_META[a.type];
    // Classify by the sign of the balance, not just the account type: an overdrawn current account
    // is a debt, and a credit card in credit is money you are owed (treated as cash).
    if (minor < 0) liabilities += minor;
    else assets += minor;
    const g: WrapperGroup = minor < 0 ? 'liabilities' : meta.liability ? 'cash' : meta.group;
    const ag: AccessGroup = minor < 0 ? 'liabilities' : meta.liability ? 'now' : meta.access;
    wrapper.set(g, (wrapper.get(g) ?? 0) + minor);
    access.set(ag, (access.get(ag) ?? 0) + minor);
  }
  return {
    total: fromMinor(assets + liabilities),
    assets: fromMinor(assets),
    liabilities: fromMinor(liabilities),
    estimated,
    wrapper: new Map([...wrapper].map(([k, v]) => [k, fromMinor(v)])),
    access: new Map([...access].map(([k, v]) => [k, fromMinor(v)])),
  };
}

/** Earliest date with data for any included account. */
export function firstDataDate(store: Store, engine: BalanceEngine): ISODate | null {
  let first: ISODate | null = null;
  for (const a of includedAccounts(store)) {
    const d = engine.firstDataDate(a.id);
    if (d && (!first || d < first)) first = d;
  }
  return first;
}

export function estateSeries(store: Store, engine: BalanceEngine, from: ISODate, to: ISODate, grouping: 'wrapper' | 'access'): EstateSeriesResponse {
  const dates = sampleDates(from, to);
  const keys = grouping === 'wrapper' ? WRAPPER_GROUPS : ACCESS_GROUPS;
  const labels: Record<string, string> = grouping === 'wrapper' ? WRAPPER_GROUP_LABELS : ACCESS_GROUP_LABELS;
  const groupValues = new Map<string, number[]>(keys.map((k) => [k, []]));
  const total: number[] = [];
  const assets: number[] = [];
  const liabilities: number[] = [];
  const estimated: boolean[] = [];
  for (const d of dates) {
    const e = estateOn(store, engine, d);
    total.push(e.total);
    assets.push(e.assets);
    liabilities.push(e.liabilities);
    estimated.push(e.estimated);
    const src = grouping === 'wrapper' ? e.wrapper : e.access;
    for (const k of keys) groupValues.get(k)!.push((src as Map<string, number>).get(k) ?? 0);
  }
  // Before every account's first data, the total leaves out the accounts not known yet.
  let completeFrom: ISODate | null = null;
  for (const a of includedAccounts(store)) {
    const first = engine.firstDataDate(a.id);
    if (first && (!completeFrom || first > completeFrom)) completeFrom = first;
  }
  return {
    grouping,
    dates,
    total,
    assets,
    liabilities,
    estimated,
    completeFrom: completeFrom && completeFrom > from ? completeFrom : null,
    groups: keys
      .map((k) => ({ id: k, label: labels[k]!, values: groupValues.get(k)! }))
      .filter((g) => g.values.some((v) => v !== 0)),
  };
}

export function accountSummary(store: Store, engine: BalanceEngine, account: Account, on: ISODate = today()): AccountSummary {
  const meta = ACCOUNT_TYPE_META[account.type];
  const latest = engine.latest(account.id, on);
  const asOf = engine.lastDataDate(account.id);
  const staleDays = asOf ? diffDays(asOf, on) : null;
  const info = engine.info(account.id);
  const monthEnds: ISODate[] = [];
  for (let i = 12; i >= 1; i--) monthEnds.push(endOfMonth(addMonths(on, -i)));
  monthEnds.push(on);
  const inst = store.institution(account.institutionId);
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    typeLabel: meta.label,
    group: meta.group,
    access: meta.access,
    currency: account.currency,
    liability: meta.liability,
    status: account.status,
    includeInNetWorth: account.includeInNetWorth,
    balance: latest?.value ?? null,
    balanceGBP: latest?.gbp ?? null,
    estimated: latest?.estimated ?? false,
    asOf,
    staleDays,
    stale: account.status === 'open' && (staleDays === null || staleDays > staleAfterDays(account.type, store.settings.staleAfterDays)),
    annualIncome: store.balances(account.id).findLast((b) => b.annualIncome !== undefined)?.annualIncome ?? null,
    lastSnapshot: info?.lastSnapshot ?? null,
    lastTransaction: info?.lastTransaction ?? null,
    transactionCount: store.transactions(account.id).length,
    sparkline: engine.series(account.id, monthEnds),
    ...(account.institutionId ? { institutionId: account.institutionId } : {}),
    ...(inst ? { institutionName: inst.name } : {}),
  };
}
