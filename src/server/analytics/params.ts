// Modelling parameters for every account and holding, resolved from (in order of precedence) your
// assumption records, facts from statements and research, agents' assumption records, and the
// registry's fallbacks. Every value carries its source and a plain-words basis, so the UI can say
// exactly where each number came from. Formulas: docs/FORMULAS.md §4.

import { ACCOUNT_TYPE_META, balanceModeOf, YEARLY_STALE_AFTER_DAYS } from '../../shared/accounts';
import { AssumptionSet, formatAssumptionValue, type AssetClass, type Range, type Resolved, type ResolveTarget } from '../../shared/assumptions';
import { ASSET_CLASSES, type Account, type Allocation, type Holding } from '../../shared/schema';
import { diffDays, today } from '../../shared/dates';
import type { Store } from '../store';
import type { BalanceEngine } from './balances';
import { isStale, latestResearch, matchInstrument } from './research';

export type ParamSource = 'owner' | 'agent' | 'research' | 'statement' | 'account' | 'fallback';

export interface Sourced {
  value: number;
  range?: Range | undefined;
  source: ParamSource;
  /** How the value was arrived at, in plain words. */
  basis: string;
  recordId?: string | undefined;
  asOf?: string | undefined;
  stale?: boolean | undefined;
}

export type Exposure = Record<AssetClass, number>;

export type Bucket = 'cash' | 'market' | 'pension' | 'property' | 'debt' | 'income';

export interface HoldingParams {
  name: string;
  instrumentId?: string | undefined;
  /** Today's value of this holding (the account value split by the latest holdings' weights). */
  value: number;
  exposure: Exposure;
  exposureBasis: string;
  exposureSource: ParamSource;
  expectedReturn: Sourced;
  volatility: Sourced;
  fundFee: Sourced;
}

export interface AccountParams {
  accountId: string;
  name: string;
  type: Account['type'];
  bucket: Bucket;
  value: number;
  holdingsKnown: boolean;
  holdingsAsOf?: string | undefined;
  holdings: HoldingParams[];
  exposure: Exposure;
  expectedReturn: Sourced;
  volatility: Sourced;
  fundFee: Sourced;
  platformFee: Sourced;
  platformFixed: Sourced;
  interest?: Sourced | undefined;
  growth?: Sourced | undefined;
}

export function bucketOf(a: Account): Bucket {
  const meta = ACCOUNT_TYPE_META[a.type];
  if (a.type === 'db_pension' || a.type === 'state_pension') return 'income';
  if (meta.pension) return 'pension';
  if (a.type === 'property' || a.type === 'other_asset') return 'property';
  if (meta.liability && a.type !== 'credit_card') return 'debt';
  if (balanceModeOf(a) === 'market') return 'market';
  return 'cash';
}

const zeroExposure = (): Exposure => Object.fromEntries(ASSET_CLASSES.map((c) => [c, 0])) as Exposure;

export function exposureFrom(allocation: Allocation): Exposure {
  const e = zeroExposure();
  let total = 0;
  for (const v of Object.values(allocation)) total += v ?? 0;
  for (const [k, v] of Object.entries(allocation)) e[k as AssetClass] = (v ?? 0) / (total || 1);
  return e;
}

const pct = (v: number) => formatAssumptionValue('return.expected', v);
const CLASS_LABEL: Record<AssetClass, string> = { equity: 'shares', bond: 'bonds', cash: 'cash', property: 'property', mixed: 'mixed assets', commodity: 'commodities', crypto: 'crypto', other: 'other assets' };

function fromResolved(r: Resolved, what: string): Sourced {
  const basis =
    r.source === 'fallback'
      ? `Fallback: ${r.note ?? 'no record yet'}`
      : `${r.source === 'owner' ? 'Your' : 'Agent'} assumption for ${what}${r.record?.source ? ` (${r.record.source})` : ''}`;
  return { value: r.value, range: r.range, source: r.source, basis, recordId: r.record?.id, asOf: r.record?.asOf, stale: r.stale };
}

/** Correlation matrix between asset classes: 1 on the diagonal, ρ elsewhere. */
function corr(rho: number) {
  return (c: AssetClass, d: AssetClass) => (c === d ? 1 : rho);
}

/** e₁ᵀ R e₂ for exposures and the asset-class correlation matrix. */
function quad(a: Exposure, b: Exposure, rho: number): number {
  const r = corr(rho);
  let s = 0;
  for (const c of ASSET_CLASSES) if (a[c]) for (const d of ASSET_CLASSES) if (b[d]) s += a[c] * b[d] * r(c, d);
  return s;
}

/** Correlation between two holdings implied by their exposures. */
export function exposureCorrelation(a: Exposure, b: Exposure, rho: number): number {
  const den = Math.sqrt(quad(a, a, rho) * quad(b, b, rho));
  return den > 0 ? quad(a, b, rho) / den : 0;
}

export interface Resolver {
  set: AssumptionSet;
  rho: number;
  staleAfterDays: number;
}

export function makeResolver(store: Store, on: string = today()): Resolver {
  const set = new AssumptionSet(store.assumptions, on);
  return { set, rho: set.resolve('correlation.assetClasses').value, staleAfterDays: store.settings.agents.researchStaleAfterDays };
}

function holdingParams(store: Store, r: Resolver, account: Account, h: { name: string; isin?: string | undefined; ticker?: string | undefined; assetClass?: Holding['assetClass']; value: number; isCash?: boolean }): HoldingParams {
  const instrument = h.isCash ? undefined : matchInstrument(h, store.instruments);
  const target: ResolveTarget = { instrumentId: instrument?.id, accountId: account.id, institutionId: account.institutionId, accountType: account.type };

  // Exposure: your allocation for the instrument, then researched allocation, then the class the
  // statement gave, then "mixed" for an unknown fund.
  let exposure: Exposure;
  let exposureBasis: string;
  let exposureSource: ParamSource;
  const facts = instrument ? latestResearch(store, 'instrument.facts', { instrumentId: instrument.id }) : undefined;
  if (h.isCash) {
    exposure = { ...zeroExposure(), cash: 1 };
    exposureBasis = 'Uninvested cash';
    exposureSource = 'statement';
  } else if (instrument?.allocation) {
    exposure = exposureFrom(instrument.allocation);
    exposureBasis = 'Your allocation for this fund';
    exposureSource = 'owner';
  } else if (facts?.data.allocation) {
    exposure = exposureFrom(facts.data.allocation);
    exposureBasis = `Researched allocation (${facts.asOf})`;
    exposureSource = 'research';
  } else if (h.assetClass) {
    exposure = { ...zeroExposure(), [h.assetClass]: 1 };
    exposureBasis = `Asset class from the statement (${CLASS_LABEL[h.assetClass]})`;
    exposureSource = 'statement';
  } else {
    const cls: AssetClass = account.type === 'crypto' ? 'crypto' : account.type === 'ifisa' ? 'other' : 'mixed';
    exposure = { ...zeroExposure(), [cls]: 1 };
    exposureBasis = `Unknown holdings: assumed ${CLASS_LABEL[cls]} until research or a statement says otherwise`;
    exposureSource = 'fallback';
  }

  // Return and volatility: resolved per asset class, blended by exposure.
  const classes = ASSET_CLASSES.filter((c) => exposure[c] > 0);
  const byClass = classes.map((c) => ({ c, w: exposure[c], ret: r.set.resolve('return.expected', { ...target, assetClass: c }), vol: r.set.resolve('return.volatility', { ...target, assetClass: c }) }));
  const mu = byClass.reduce((s, x) => s + x.w * x.ret.value, 0);
  const lowHigh = byClass.every((x) => x.ret.range)
    ? { low: byClass.reduce((s, x) => s + x.w * x.ret.range!.low, 0), high: byClass.reduce((s, x) => s + x.w * x.ret.range!.high, 0) }
    : undefined;
  const dominant = [...byClass].sort((a, b) => b.w - a.w)[0]!;
  const sameRecord = (pick: (x: (typeof byClass)[number]) => Resolved) => byClass.length > 0 && byClass.every((x) => pick(x).record && pick(x).record?.id === pick(byClass[0]!).record?.id && pick(x).record?.scope.kind !== 'assetClass' && pick(x).record?.scope.kind !== 'global');
  const expectedReturn: Sourced =
    byClass.length === 1 || sameRecord((x) => x.ret)
      ? fromResolved(dominant.ret, byClass.length === 1 ? CLASS_LABEL[dominant.c] : 'this holding')
      : {
          value: mu,
          range: lowHigh,
          source: dominant.ret.source,
          basis: byClass.map((x) => `${Math.round(x.w * 100)}% ${CLASS_LABEL[x.c]} at ${pct(x.ret.value)} (${x.ret.source === 'fallback' ? 'fallback' : x.ret.source === 'owner' ? 'yours' : 'agent'})`).join(', '),
        };
  if (lowHigh && !expectedReturn.range) expectedReturn.range = lowHigh;
  let sigma: number;
  let volBasis: string;
  if (sameRecord((x) => x.vol)) {
    sigma = dominant.vol.value;
    volBasis = fromResolved(dominant.vol, 'this holding').basis;
  } else {
    const rho = corr(r.rho);
    let v = 0;
    for (const a of byClass) for (const b of byClass) v += a.w * b.w * a.vol.value * b.vol.value * rho(a.c, b.c);
    sigma = Math.sqrt(Math.max(0, v));
    volBasis = byClass.length === 1 ? fromResolved(dominant.vol, CLASS_LABEL[dominant.c]).basis : `Combined from ${byClass.map((x) => `${CLASS_LABEL[x.c]} ${pct(x.vol.value)}`).join(', ')} at correlation ${r.rho.toFixed(2)}`;
  }
  const volatility: Sourced = { value: sigma, source: dominant.vol.source, basis: volBasis, recordId: dominant.vol.record?.id };

  // Fund charge: yours, then the researched OCF, then agents' or the fallback.
  let fundFee: Sourced;
  const feeResolved = r.set.resolve('fee.fund', target);
  if (h.isCash) fundFee = { value: 0, source: 'statement', basis: 'Cash has no fund charge' };
  else if (feeResolved.source === 'owner') fundFee = fromResolved(feeResolved, 'fund charges');
  else if (facts?.data.ocf !== undefined) {
    fundFee = { value: facts.data.ocf, source: 'research', basis: `Researched OCF (${facts.sources[0]?.publisher ?? facts.sources[0]?.title ?? 'source'}, ${facts.asOf})`, recordId: facts.id, asOf: facts.asOf, stale: isStale(facts, r.staleAfterDays) };
  } else fundFee = fromResolved(feeResolved, 'fund charges');

  return { name: h.name, instrumentId: instrument?.id, value: h.value, exposure, exposureBasis, exposureSource, expectedReturn, volatility, fundFee };
}

function platformFee(store: Store, r: Resolver, account: Account, value: number): { rate: Sourced; fixed: Sourced } {
  const target: ResolveTarget = { accountId: account.id, institutionId: account.institutionId, accountType: account.type };
  const rate = r.set.resolve('fee.platform', target);
  const fixed = r.set.resolve('fee.platformFixed', target);
  if (rate.source === 'owner') return { rate: fromResolved(rate, 'platform fees'), fixed: fromResolved(fixed, 'flat fees') };
  const research = account.institutionId ? latestResearch(store, 'provider.fees', { institutionId: account.institutionId }) : undefined;
  if (research && (!research.data.accountTypes || research.data.accountTypes.includes(account.type))) {
    // Tiered charge on the account value, capped, plus any flat fee.
    let remaining = Math.max(0, value);
    let prevCap = 0;
    let fee = 0;
    for (const t of research.data.tiers) {
      const band = t.upToGbp !== undefined ? Math.min(remaining, t.upToGbp - prevCap) : remaining;
      fee += band * t.rate;
      remaining -= band;
      prevCap = t.upToGbp ?? prevCap;
      if (remaining <= 0) break;
    }
    if (research.data.capGbpPerYear !== undefined) fee = Math.min(fee, research.data.capGbpPerYear);
    const effective = value > 0 ? fee / value : (research.data.tiers[0]?.rate ?? 0);
    const src = `${research.sources[0]?.publisher ?? research.sources[0]?.title ?? 'source'}, ${research.asOf}`;
    return {
      rate: { value: effective, source: 'research', basis: `Researched charges (${src})${research.data.capGbpPerYear !== undefined ? `, capped at £${research.data.capGbpPerYear}` : ''}`, recordId: research.id, asOf: research.asOf, stale: isStale(research, r.staleAfterDays) },
      fixed: research.data.fixedGbpPerYear !== undefined ? { value: research.data.fixedGbpPerYear, source: 'research', basis: `Researched flat fee (${src})`, recordId: research.id } : fromResolved(fixed, 'flat fees'),
    };
  }
  return { rate: fromResolved(rate, 'platform fees'), fixed: fromResolved(fixed, 'flat fees') };
}

function interestRate(store: Store, r: Resolver, account: Account): Sourced {
  const target: ResolveTarget = { accountId: account.id, institutionId: account.institutionId, accountType: account.type };
  const resolved = r.set.resolve('interest.rate', target);
  if (resolved.source === 'owner') return fromResolved(resolved, 'this account');
  if (account.interestRate !== undefined) return { value: account.interestRate / 100, source: 'account', basis: 'The rate on the account (Accounts page)' };
  const snap = store.balances(account.id).findLast((b) => b.interestRate !== undefined);
  if (snap) return { value: snap.interestRate! / 100, source: 'statement', basis: `Rate on your statement of ${snap.date}`, asOf: snap.date };
  const research = account.institutionId ? latestResearch(store, 'provider.rates', { institutionId: account.institutionId }) : undefined;
  if (research) {
    const products = research.data.products.filter((p) => !p.accountType || p.accountType === account.type);
    const words = new Set(account.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const scored = products.map((p) => ({ p, score: p.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length })).sort((a, b) => b.score - a.score);
    const pick = scored[0]?.p;
    if (pick) return { value: pick.aer, source: 'research', basis: `Researched rate for ${pick.name} (${research.asOf})${scored[0]!.score === 0 ? ', closest product' : ''}`, recordId: research.id, asOf: research.asOf, stale: isStale(research, r.staleAfterDays) };
  }
  return fromResolved(resolved, 'this account');
}

/** Parameters for one account, with its value today. */
export function accountParams(store: Store, engine: BalanceEngine, r: Resolver, account: Account, on: string = today()): AccountParams {
  const bucket = bucketOf(account);
  const value = engine.balanceOn(account.id, on)?.gbp ?? 0;
  const base = { accountId: account.id, name: account.name, type: account.type, bucket, value };
  const none: Sourced = { value: 0, source: 'fallback', basis: 'Not applicable' };
  if (bucket === 'market' || bucket === 'pension') {
    const snaps = store.holdings(account.id);
    const snap = snaps[snaps.length - 1];
    // Holdings from an annual statement stay in use for a year and a month.
    const fresh = snap && diffDays(snap.date, on) <= YEARLY_STALE_AFTER_DAYS ? snap : undefined;
    const items: { name: string; isin?: string; ticker?: string; assetClass?: Holding['assetClass']; value: number; isCash?: boolean }[] = [];
    if (fresh) {
      for (const h of fresh.holdings) items.push({ name: h.name, value: h.value, ...(h.isin ? { isin: h.isin } : {}), ...(h.ticker ? { ticker: h.ticker } : {}), ...(h.assetClass ? { assetClass: h.assetClass } : {}) });
      if (fresh.cash) items.push({ name: 'Uninvested cash', value: fresh.cash, isCash: true });
    }
    const snapTotal = items.reduce((s, x) => s + Math.max(0, x.value), 0);
    const holdingsKnown = snapTotal > 0;
    const scaled = holdingsKnown ? items.map((x) => ({ ...x, value: (Math.max(0, x.value) / snapTotal) * value })) : [{ name: 'Whole account (holdings not known)', value }];
    const holdings = scaled.map((h) => holdingParams(store, r, account, h));
    const weights = holdings.map((h) => (value > 0 ? h.value / value : 1 / holdings.length));
    const exposure = zeroExposure();
    holdings.forEach((h, i) => {
      for (const c of ASSET_CLASSES) exposure[c] += weights[i]! * h.exposure[c];
    });
    const mu = holdings.reduce((s, h, i) => s + weights[i]! * h.expectedReturn.value, 0);
    const range = holdings.every((h) => h.expectedReturn.range)
      ? { low: holdings.reduce((s, h, i) => s + weights[i]! * h.expectedReturn.range!.low, 0), high: holdings.reduce((s, h, i) => s + weights[i]! * h.expectedReturn.range!.high, 0) }
      : undefined;
    let variance = 0;
    holdings.forEach((a, i) =>
      holdings.forEach((b, j) => {
        variance += weights[i]! * weights[j]! * a.volatility.value * b.volatility.value * exposureCorrelation(a.exposure, b.exposure, r.rho);
      }),
    );
    const fundFee = holdings.reduce((s, h, i) => s + weights[i]! * h.fundFee.value, 0);
    const one = holdings.length === 1 ? holdings[0]! : undefined;
    const fees = platformFee(store, r, account, value);
    return {
      ...base,
      holdingsKnown,
      holdingsAsOf: fresh?.date,
      holdings,
      exposure,
      expectedReturn: one ? one.expectedReturn : { value: mu, range, source: holdings[0]!.expectedReturn.source, basis: `Weighted by holding: ${holdings.map((h) => `${h.name} ${pct(h.expectedReturn.value)}`).join('; ')}` },
      volatility: one ? one.volatility : { value: Math.sqrt(Math.max(0, variance)), source: holdings[0]!.volatility.source, basis: `Combined across ${holdings.length} holdings` },
      fundFee: one ? one.fundFee : { value: fundFee, source: holdings.some((h) => h.fundFee.source === 'research') ? 'research' : holdings[0]!.fundFee.source, basis: `Weighted by holding: ${holdings.map((h) => `${h.name} ${pct(h.fundFee.value)}`).join('; ')}` },
      platformFee: fees.rate,
      platformFixed: fees.fixed,
    };
  }
  const empty = { ...base, holdingsKnown: false, holdings: [], exposure: zeroExposure(), expectedReturn: none, volatility: none, fundFee: none, platformFee: none, platformFixed: none };
  if (bucket === 'cash') return { ...empty, exposure: { ...zeroExposure(), cash: 1 }, interest: account.type === 'credit_card' ? { value: 0, source: 'fallback', basis: 'Card balances are assumed repaid each month' } : interestRate(store, r, account) };
  if (bucket === 'property') return { ...empty, exposure: { ...zeroExposure(), property: 1 }, growth: fromResolved(r.set.resolve('property.growth', { accountId: account.id }), 'this property') };
  return empty;
}

export interface PoolStats {
  value: number;
  mu: number;
  muRange?: Range | undefined;
  sigma: number;
  fee: number;
  fixedFees: number;
}

/**
 * Combined statistics of market and pension accounts treated as one portfolio: value-weighted
 * return and charges, and volatility from every pair of holdings' covariance.
 */
export function poolStats(accounts: AccountParams[], rho: number, weightsOverride?: Map<string, number>): PoolStats {
  const holdings: { w: number; h: HoldingParams; acc: AccountParams }[] = [];
  let total = 0;
  for (const a of accounts) {
    const av = weightsOverride?.get(a.accountId) ?? a.value;
    if (av <= 0) continue;
    total += av;
    const sum = a.holdings.reduce((s, h) => s + h.value, 0);
    for (const h of a.holdings) holdings.push({ w: av * (sum > 0 ? h.value / sum : 1 / a.holdings.length), h, acc: a });
  }
  if (total <= 0) return { value: 0, mu: 0, sigma: 0, fee: 0, fixedFees: accounts.reduce((s, a) => s + a.platformFixed.value, 0) };
  for (const x of holdings) x.w /= total;
  const mu = holdings.reduce((s, x) => s + x.w * x.h.expectedReturn.value, 0);
  const ranged = holdings.every((x) => x.h.expectedReturn.range);
  const muRange = ranged ? { low: holdings.reduce((s, x) => s + x.w * x.h.expectedReturn.range!.low, 0), high: holdings.reduce((s, x) => s + x.w * x.h.expectedReturn.range!.high, 0) } : undefined;
  let variance = 0;
  for (const a of holdings) for (const b of holdings) variance += a.w * b.w * a.h.volatility.value * b.h.volatility.value * exposureCorrelation(a.h.exposure, b.h.exposure, rho);
  const fee = holdings.reduce((s, x) => s + x.w * (x.h.fundFee.value + x.acc.platformFee.value), 0);
  return { value: total, mu, muRange, sigma: Math.sqrt(Math.max(0, variance)), fee, fixedFees: accounts.reduce((s, a) => s + a.platformFixed.value, 0) };
}
