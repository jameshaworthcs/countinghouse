// The assumption registry and resolver.
//
// Every modelling parameter is a key defined here with its unit, bounds, allowed scopes and a code
// fallback. The values themselves live in data/assumptions.jsonl as records with provenance and
// history (see schema.ts → AssumptionSchema and docs/AGENTS.md). The fallbacks below are the only
// modelling numbers in the code, and the UI labels them as fallbacks wherever they are used.
//
// Resolution (docs/FORMULAS.md §1):
//   1. Layers, in order: your records (setBy "owner"), then agents' (setBy "agent" or "system"),
//      then the fallback. The first layer with any matching record wins, so your global override
//      beats an agent's fund-level value.
//   2. Within a layer, the most specific matching scope wins:
//      instrument → account → institution → account type → asset class → global.
//   3. Within a layer and scope, the newest record wins; a "retired" newest record means the
//      layer has no value at that scope.

import type { AccountType } from './schema';
import type { Assumption, AssumptionScope, AssumptionScopeKind } from './schema';
import { ASSET_CLASSES } from './schema';

export type AssetClass = (typeof ASSET_CLASSES)[number];
export type Unit = 'rate' | 'gbpPerYear' | 'ratio';

export interface Range {
  low: number;
  high: number;
}

interface FallbackValue {
  value: number;
  range?: Range;
}

export interface AssumptionDef {
  key: string;
  label: string;
  unit: Unit;
  description: string;
  scopes: AssumptionScopeKind[];
  min: number;
  max: number;
  fallback: FallbackValue & {
    /** Why the fallback is what it is, shown next to it in the UI. */
    note: string;
    byAssetClass?: Partial<Record<AssetClass, FallbackValue>>;
    byAccountType?: Partial<Record<AccountType, FallbackValue>>;
    /** The fallback is another key's resolved value (e.g. salary growth = earnings growth). */
    derivedFrom?: string;
    /** Or the largest of several keys' values and a floor (the State Pension triple lock). */
    maxOf?: { keys: string[]; floor: number };
  };
}

const R = (value: number, low?: number, high?: number): FallbackValue => (low === undefined || high === undefined ? { value } : { value, range: { low, high } });

export const ASSUMPTION_DEFS: AssumptionDef[] = [
  {
    key: 'inflation',
    label: 'Inflation (CPI)',
    unit: 'rate',
    description: 'Long-run consumer price inflation a year. Converts future pounds into today’s money and grows spending.',
    scopes: ['global'],
    min: -0.05,
    max: 0.2,
    fallback: { ...R(0.02, 0.015, 0.035), note: 'The Bank of England’s 2% CPI target.' },
  },
  {
    key: 'earnings.growth',
    label: 'Earnings growth',
    unit: 'rate',
    description: 'Long-run growth in average earnings a year, before inflation is taken off.',
    scopes: ['global'],
    min: -0.05,
    max: 0.2,
    fallback: { ...R(0.03, 0.02, 0.045), note: 'Inflation plus about 1% a year of productivity growth.' },
  },
  {
    key: 'salary.growth',
    label: 'Your pay growth',
    unit: 'rate',
    description: 'How fast your income grows a year in the projections.',
    scopes: ['global'],
    min: -0.1,
    max: 0.3,
    fallback: { value: 0.03, derivedFrom: 'earnings.growth', note: 'Follows average earnings growth.' },
  },
  {
    key: 'contribution.growth',
    label: 'Contribution growth',
    unit: 'rate',
    description: 'How fast regular ISA and pension contributions grow a year.',
    scopes: ['global', 'account'],
    min: -0.1,
    max: 0.3,
    fallback: { value: 0.03, derivedFrom: 'salary.growth', note: 'Follows your pay growth (percentage-of-pay contributions).' },
  },
  {
    key: 'spending.growth',
    label: 'Spending growth',
    unit: 'rate',
    description: 'How fast spending grows a year in the projections.',
    scopes: ['global'],
    min: -0.1,
    max: 0.3,
    fallback: { value: 0.02, derivedFrom: 'inflation', note: 'Follows inflation: the same lifestyle, in today’s money.' },
  },
  {
    key: 'return.expected',
    label: 'Expected return',
    unit: 'rate',
    description: 'Expected long-run return a year before charges and before inflation (nominal).',
    scopes: ['global', 'assetClass', 'accountType', 'account', 'instrument'],
    min: -0.5,
    max: 0.5,
    fallback: {
      ...R(0.055, 0.035, 0.075),
      note: 'Broad long-run averages by asset class (about 4.5% above inflation for shares, 2% for bonds).',
      byAssetClass: {
        equity: R(0.065, 0.035, 0.09),
        bond: R(0.04, 0.025, 0.055),
        cash: R(0.03, 0.015, 0.045),
        property: R(0.055, 0.03, 0.075),
        mixed: R(0.055, 0.035, 0.075),
        commodity: R(0.04, 0, 0.07),
        crypto: R(0.02, -0.2, 0.2),
        other: R(0.04, 0.02, 0.06),
      },
    },
  },
  {
    key: 'return.volatility',
    label: 'Volatility',
    unit: 'rate',
    description: 'Annualised standard deviation of returns: how widely a year’s return can swing.',
    scopes: ['global', 'assetClass', 'accountType', 'account', 'instrument'],
    min: 0,
    max: 2,
    fallback: {
      value: 0.1,
      note: 'Typical long-run volatility by asset class.',
      byAssetClass: {
        equity: R(0.16),
        bond: R(0.07),
        cash: R(0.005),
        property: R(0.12),
        mixed: R(0.1),
        commodity: R(0.18),
        crypto: R(0.7),
        other: R(0.1),
      },
    },
  },
  {
    key: 'correlation.assetClasses',
    label: 'Correlation between asset classes',
    unit: 'ratio',
    description: 'How closely different asset classes move together (0 = independently, 1 = in step). Used to combine volatilities.',
    scopes: ['global'],
    min: -1,
    max: 1,
    fallback: { ...R(0.3, 0, 0.6), note: 'A moderate long-run average across shares, bonds and property.' },
  },
  {
    key: 'fee.fund',
    label: 'Fund charge (OCF)',
    unit: 'rate',
    description: 'Ongoing charges of a fund a year, taken from its value. A researched OCF replaces the fallback.',
    scopes: ['global', 'accountType', 'account', 'instrument'],
    min: 0,
    max: 0.05,
    fallback: { value: 0.002, note: 'A typical index-fund charge of 0.2%.' },
  },
  {
    key: 'fee.platform',
    label: 'Platform fee',
    unit: 'rate',
    description: 'The platform or pension provider’s annual charge, as a share of the account’s value.',
    scopes: ['global', 'accountType', 'institution', 'account'],
    min: 0,
    max: 0.05,
    fallback: { value: 0.0025, note: 'A typical UK platform charge (most are 0.15%–0.45%).' },
  },
  {
    key: 'fee.platformFixed',
    label: 'Fixed platform fee',
    unit: 'gbpPerYear',
    description: 'A flat yearly charge on an account, in pounds.',
    scopes: ['institution', 'account'],
    min: 0,
    max: 10_000,
    fallback: { value: 0, note: 'No flat fee unless one is known.' },
  },
  {
    key: 'interest.rate',
    label: 'Interest rate (AER)',
    unit: 'rate',
    description: 'Interest on cash a year. A rate from your statement or the account beats research, which beats this.',
    scopes: ['global', 'accountType', 'institution', 'account'],
    min: 0,
    max: 0.25,
    fallback: {
      value: 0,
      note: 'Current accounts pay nothing; savings a typical easy-access rate.',
      byAccountType: { savings: R(0.03), cash_isa: R(0.03), premium_bonds: R(0.03), current: R(0) },
    },
  },
  {
    key: 'withdrawal.rate',
    label: 'Sustainable withdrawal rate',
    unit: 'rate',
    description: 'The share of your pension pots you can draw each year in retirement, rising with inflation, with little risk of running out.',
    scopes: ['global'],
    min: 0.01,
    max: 0.1,
    fallback: { ...R(0.035, 0.025, 0.045), note: 'UK studies put it nearer 3%–3.5% than the US “4% rule”.' },
  },
  {
    key: 'statePension.growth',
    label: 'State Pension growth',
    unit: 'rate',
    description: 'How fast the State Pension rises a year.',
    scopes: ['global'],
    min: -0.05,
    max: 0.2,
    fallback: { value: 0.03, maxOf: { keys: ['earnings.growth', 'inflation'], floor: 0.025 }, note: 'The triple lock: the highest of earnings growth, inflation and 2.5%.' },
  },
  {
    key: 'property.growth',
    label: 'House price growth',
    unit: 'rate',
    description: 'How fast property values grow a year (nominal).',
    scopes: ['global', 'account'],
    min: -0.2,
    max: 0.3,
    fallback: { ...R(0.03, 0, 0.05), note: 'Roughly inflation plus 1%.' },
  },
  {
    key: 'mortgage.rate',
    label: 'Mortgage rate',
    unit: 'rate',
    description: 'Interest on a mortgage a year.',
    scopes: ['global', 'account'],
    min: 0,
    max: 0.25,
    fallback: { value: 0.045, note: 'A typical fixed rate.' },
  },
  {
    key: 'cashflow.uncertainty',
    label: 'Uncertainty in monthly saving',
    unit: 'ratio',
    description: 'With fewer than 3 months of data, how far the monthly saving could be off, as a share of monthly spending.',
    scopes: ['global'],
    min: 0,
    max: 2,
    fallback: { value: 0.25, note: 'One month of data says little about the next; a quarter of spending either way.' },
  },
];

export const ASSUMPTION_KEYS = ASSUMPTION_DEFS.map((d) => d.key);
const DEFS = new Map(ASSUMPTION_DEFS.map((d) => [d.key, d]));

export function assumptionDef(key: string): AssumptionDef | undefined {
  return DEFS.get(key);
}

/** Order of specificity, most specific first. */
export const SCOPE_ORDER: AssumptionScopeKind[] = ['instrument', 'account', 'institution', 'accountType', 'assetClass', 'global'];

export function scopeKey(scope: AssumptionScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'assetClass':
      return `assetClass:${scope.assetClass}`;
    case 'accountType':
      return `accountType:${scope.accountType}`;
    case 'institution':
      return `institution:${scope.institutionId}`;
    case 'account':
      return `account:${scope.accountId}`;
    case 'instrument':
      return `instrument:${scope.instrumentId}`;
  }
}

export function describeScope(scope: AssumptionScope, names: { account?: (id: string) => string; instrument?: (id: string) => string; institution?: (id: string) => string } = {}): string {
  switch (scope.kind) {
    case 'global':
      return 'everything';
    case 'assetClass':
      return `all ${scope.assetClass === 'equity' ? 'shares' : scope.assetClass}`;
    case 'accountType':
      return `every ${scope.accountType.replace(/_/g, ' ')} account`;
    case 'institution':
      return names.institution?.(scope.institutionId) ?? scope.institutionId;
    case 'account':
      return names.account?.(scope.accountId) ?? scope.accountId;
    case 'instrument':
      return names.instrument?.(scope.instrumentId) ?? scope.instrumentId;
  }
}

export type Layer = 'owner' | 'agent';
export const layerOf = (a: Pick<Assumption, 'provenance'>): Layer => (a.provenance.setBy === 'owner' ? 'owner' : 'agent');

/** Where a value to be resolved sits. Only the fields that apply are set. */
export interface ResolveTarget {
  instrumentId?: string | undefined;
  accountId?: string | undefined;
  institutionId?: string | undefined;
  accountType?: AccountType | undefined;
  assetClass?: AssetClass | undefined;
}

export interface Resolved {
  key: string;
  value: number;
  range?: Range | undefined;
  /** "owner" and "agent" come from records; "fallback" from the registry above. */
  source: 'owner' | 'agent' | 'fallback';
  record?: Assumption | undefined;
  /** For fallbacks: why the value is what it is. */
  note?: string | undefined;
  /** An agent value whose review date has passed. */
  stale?: boolean;
}

function scopesFor(target: ResolveTarget, allowed: AssumptionScopeKind[]): { kind: AssumptionScopeKind; key: string }[] {
  const out: { kind: AssumptionScopeKind; key: string }[] = [];
  for (const kind of SCOPE_ORDER) {
    if (!allowed.includes(kind)) continue;
    if (kind === 'instrument' && target.instrumentId) out.push({ kind, key: `instrument:${target.instrumentId}` });
    if (kind === 'account' && target.accountId) out.push({ kind, key: `account:${target.accountId}` });
    if (kind === 'institution' && target.institutionId) out.push({ kind, key: `institution:${target.institutionId}` });
    if (kind === 'accountType' && target.accountType) out.push({ kind, key: `accountType:${target.accountType}` });
    if (kind === 'assetClass' && target.assetClass) out.push({ kind, key: `assetClass:${target.assetClass}` });
    if (kind === 'global') out.push({ kind, key: 'global' });
  }
  return out;
}

/**
 * All assumption records, indexed for resolution. Build one per store version; it is immutable.
 */
export class AssumptionSet {
  /** Newest record per `${key}|${scopeKey}|${layer}`. */
  private readonly current = new Map<string, Assumption>();
  private readonly all: Assumption[];

  constructor(
    records: Assumption[],
    private readonly today: string,
  ) {
    this.all = records;
    for (const r of records) {
      const k = `${r.key}|${scopeKey(r.scope)}|${layerOf(r)}`;
      const prev = this.current.get(k);
      // File order is append order; createdAt breaks ties between hand-merged files.
      if (!prev || r.createdAt >= prev.createdAt) this.current.set(k, r);
    }
  }

  /** Every current, active record (one per key, scope and layer). */
  active(): Assumption[] {
    return [...this.current.values()].filter((r) => r.status === 'active');
  }

  /** Every version of one key at one scope, oldest first. */
  history(key: string, scope: AssumptionScope): Assumption[] {
    const sk = scopeKey(scope);
    return this.all.filter((r) => r.key === key && scopeKey(r.scope) === sk);
  }

  /** The record in force for (key, scope) in a layer, if any. */
  at(key: string, scope: AssumptionScope, layer: Layer): Assumption | undefined {
    const r = this.current.get(`${key}|${scopeKey(scope)}|${layer}`);
    return r && r.status === 'active' ? r : undefined;
  }

  resolve(key: string, target: ResolveTarget = {}, seen = new Set<string>()): Resolved {
    const def = DEFS.get(key);
    if (!def) throw new Error(`Unknown assumption key "${key}"`);
    const scopes = scopesFor(target, def.scopes);
    for (const layer of ['owner', 'agent'] as const) {
      for (const s of scopes) {
        const r = this.current.get(`${key}|${s.key}|${layer}`);
        if (!r || r.status !== 'active') continue;
        return { key, value: r.value, range: r.range, source: layer, record: r, stale: layer === 'agent' && r.reviewBy !== undefined && r.reviewBy < this.today };
      }
    }
    return this.fallback(def, target, seen);
  }

  /** The value a key would have with no records at all (or from the keys it derives from). */
  fallback(def: AssumptionDef, target: ResolveTarget = {}, seen = new Set<string>()): Resolved {
    const f = def.fallback;
    if ((f.derivedFrom || f.maxOf) && !seen.has(def.key)) {
      const next = new Set(seen).add(def.key);
      if (f.derivedFrom) {
        const base = this.resolve(f.derivedFrom, target, next);
        return { key: def.key, value: base.value, range: base.range, source: 'fallback', note: f.note };
      }
      if (f.maxOf) {
        const values = f.maxOf.keys.map((k) => this.resolve(k, target, next).value);
        return { key: def.key, value: Math.max(f.maxOf.floor, ...values), source: 'fallback', note: f.note };
      }
    }
    const byClass = target.assetClass ? f.byAssetClass?.[target.assetClass] : undefined;
    const byType = target.accountType ? f.byAccountType?.[target.accountType] : undefined;
    const v = byClass ?? byType ?? f;
    return { key: def.key, value: v.value, range: v.range, source: 'fallback', note: f.note };
  }
}

/** Problems with an assumption record beyond its shape: unknown key, disallowed scope, bounds. */
export function assumptionProblems(a: Pick<Assumption, 'key' | 'scope' | 'value' | 'range'>): string[] {
  const def = DEFS.get(a.key);
  if (!def) return [`unknown key "${a.key}" (known: ${ASSUMPTION_KEYS.join(', ')})`];
  const problems: string[] = [];
  if (!def.scopes.includes(a.scope.kind)) problems.push(`"${a.key}" cannot be set for scope "${a.scope.kind}" (allowed: ${def.scopes.join(', ')})`);
  if (a.value < def.min || a.value > def.max) problems.push(`"${a.key}" must be between ${def.min} and ${def.max}; got ${a.value}`);
  if (a.range) {
    if (a.range.low > a.value || a.range.high < a.value) problems.push(`range ${a.range.low}–${a.range.high} must contain the value ${a.value}`);
    if (a.range.low < def.min || a.range.high > def.max) problems.push(`range must stay within ${def.min}–${def.max}`);
  }
  return problems;
}

/** "5.5%" for rates, "£120 a year" for money. */
export function formatAssumptionValue(key: string, value: number): string {
  const def = DEFS.get(key);
  if (def?.unit === 'gbpPerYear') return `£${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })} a year`;
  if (def?.unit === 'ratio') return value.toFixed(2);
  const pct = value * 100;
  return `${pct.toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}
