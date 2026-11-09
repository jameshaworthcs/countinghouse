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
import type { LiveOverride } from '../feeds/live';
import { lastUpdated, type BalanceEngine } from './balances';

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

/**
 * The estate on a date. `live` is today's value of accounts with a live reading that stands for it
 * (feeds/live.ts), in place of what the engine says.
 */
export function estateOn(store: Store, engine: BalanceEngine, date: ISODate, live?: LiveOverride) {
  let assets = 0;
  let liabilities = 0;
  let estimated = false;
  const wrapper = new Map<WrapperGroup, number>();
  const access = new Map<AccessGroup, number>();
  for (const a of includedAccounts(store)) {
    const p = live && live.accountId === a.id ? { gbp: live.value, estimated: false } : engine.balanceOn(a.id, date);
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

/**
 * Whether the estate on a date is fully known: every included account with data has data by then,
 * or had not opened yet (it held nothing). Accounts with no data at all are left out.
 */
export function estateKnownOn(store: Store, engine: BalanceEngine, date: ISODate): boolean {
  return includedAccounts(store).every((a) => {
    const first = engine.firstDataDate(a.id);
    return !first || first <= date || (a.openedOn !== undefined && date < a.openedOn);
  });
}

/**
 * The days each included account leaves out of the estate: from its opening date (or, with none,
 * from always: it may have been open before) up to the day before its first data. An account whose
 * data starts on or before its opening day leaves nothing out, nor one with no data at all; nor
 * one you confirmed nothing is missing from since it opened (the engine knows it from then).
 */
export function unknownStretches(store: Store, engine: BalanceEngine): { account: Account; from: ISODate | null; to: ISODate }[] {
  const out: { account: Account; from: ISODate | null; to: ISODate }[] = [];
  for (const a of includedAccounts(store)) {
    const first = engine.firstDataDate(a.id);
    if (!first || (a.openedOn !== undefined && a.openedOn >= first)) continue;
    out.push({ account: a, from: a.openedOn ?? null, to: addDays(first, -1) });
  }
  return out;
}

/**
 * The stretches of [from, to] on which the estate is not fully known (`estateKnownOn` is false), with
 * the accounts it leaves out on each, split wherever that set changes.
 */
export function incompleteStretches(store: Store, engine: BalanceEngine, from: ISODate, to: ISODate): EstateSeriesResponse['incomplete'] {
  const clipped = unknownStretches(store, engine)
    .map((u) => ({ ...u, from: u.from && u.from > from ? u.from : from, to: u.to < to ? u.to : to }))
    .filter((u) => u.from <= u.to);
  // Every day a stretch starts or ends after, the set of accounts left out may change.
  const cuts = [...new Set(clipped.flatMap((u) => [u.from, addDays(u.to, 1)]))].filter((d) => d <= to).sort();
  const out: EstateSeriesResponse['incomplete'] = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i]!;
    const end = i + 1 < cuts.length ? addDays(cuts[i + 1]!, -1) : to;
    const left = clipped.filter((u) => u.from <= start && start <= u.to).map((u) => ({ id: u.account.id, name: u.account.name }));
    if (!left.length) continue;
    const prev = out[out.length - 1];
    if (prev && addDays(prev.to, 1) === start && prev.accounts.map((x) => x.id).join() === left.map((x) => x.id).join()) prev.to = end;
    else out.push({ from: start, to: end, accounts: left });
  }
  return out;
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
  // Before an account's first data, from when it opened, the total leaves it out.
  const incomplete = incompleteStretches(store, engine, from, to);
  return {
    grouping,
    dates,
    total,
    assets,
    liabilities,
    estimated,
    incomplete,
    groups: keys
      .map((k) => ({ id: k, label: labels[k]!, values: groupValues.get(k)! }))
      .filter((g) => g.values.some((v) => v !== 0)),
  };
}

export function accountSummary(store: Store, engine: BalanceEngine, account: Account, on: ISODate = today(), live?: LiveOverride): AccountSummary {
  const meta = ACCOUNT_TYPE_META[account.type];
  const recorded = engine.latest(account.id, on);
  const mine = live && live.accountId === account.id ? live : undefined;
  const latest = mine ? { value: mine.value, gbp: mine.value, estimated: false } : recorded;
  const recordedAsOf = lastUpdated(store, engine, account.id);
  const asOf = mine ? on : recordedAsOf;
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
    sparkline: mine ? [...engine.series(account.id, monthEnds).slice(0, -1), mine.value] : engine.series(account.id, monthEnds),
    ...(mine ? { live: { at: mine.at, feed: mine.feed, recorded: recorded?.value ?? null, recordedAsOf } } : {}),
    ...(account.institutionId ? { institutionId: account.institutionId } : {}),
    ...(inst ? { institutionName: inst.name } : {}),
  };
}
