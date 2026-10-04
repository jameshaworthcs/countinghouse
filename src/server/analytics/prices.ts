// Published prices (research of kind instrument.prices), and what they say an account of
// investments was worth between its valuations (docs/FORMULAS.md §9, "Between valuations"):
//   - its holdings path: the units it held each day, walked from a holdings snapshot through its
//     trades, at each day's published price, with its cash;
//   - failing that, its price index: its holdings' prices weighted as on a snapshot.

import { addDays, diffDays, type ISODate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { HoldingsSnapshot, Instrument, Research, Transaction } from '../../shared/schema';
import { matchInstrument } from './research';

/** The rules, named. */
export const PRICE_RULES = {
  /** An index needs prices for at least this share of the holdings' value (cash counts as priced). */
  minPricedShare: 0.5,
  /** A price series covers a day when its first point is no later than this many days after it. */
  startSlackDays: 7,
  /** A trade is of the holding whose published price that day is within this of the trade's own price. */
  tradePriceTolerance: 0.15,
  /** Holdings with no prices may be at most this share of the value for a holdings path. */
  maxUnpricedShare: 0.05,
} as const;

interface PricePoint {
  date: ISODate;
  price: number;
}

/** Every instrument's published prices, newest research winning on a day both give. */
export class PriceBook {
  private readonly series = new Map<string, PricePoint[]>();

  constructor(research: readonly Research[]) {
    const byInstrument = new Map<string, Map<ISODate, number>>();
    const sorted = [...research].filter((r) => r.kind === 'instrument.prices' && r.subject.instrumentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of sorted) {
      if (r.kind !== 'instrument.prices') continue;
      const id = r.subject.instrumentId!;
      const days = byInstrument.get(id) ?? byInstrument.set(id, new Map()).get(id)!;
      for (const p of r.data.points) days.set(p.date, p.price);
    }
    for (const [id, days] of byInstrument) this.series.set(id, [...days.entries()].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date)));
  }

  has(instrumentId: string): boolean {
    return this.series.has(instrumentId);
  }

  /** The first and last days with a price. */
  span(instrumentId: string): { from: ISODate; to: ISODate } | undefined {
    const s = this.series.get(instrumentId);
    return s?.length ? { from: s[0]!.date, to: s[s.length - 1]!.date } : undefined;
  }

  /** The price on a day: the last published on or before it, else the first after it. */
  on(instrumentId: string, date: ISODate): number | undefined {
    const s = this.series.get(instrumentId);
    if (!s?.length) return undefined;
    let lo = 0;
    let hi = s.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.date <= date) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return (found >= 0 ? s[found] : s[0])!.price;
  }
}

/** How an account's holdings moved, as a number that is 1 on the holdings' own day. */
export interface PriceIndex {
  at(date: ISODate): number;
  /** The days every priced holding has a price for. */
  from: ISODate;
  to: ISODate;
  /** The holdings snapshot it is weighted by. */
  snapshot: ISODate;
}

/**
 * The index of a holdings snapshot: each holding weighted by its value on the snapshot's day, moving
 * with its own price; cash stays as it is; a holding with no prices moves with the priced ones.
 * None when the priced holdings and cash are less than half the value, or nothing is priced.
 */
export function priceIndex(snapshot: Pick<HoldingsSnapshot, 'date' | 'holdings' | 'cash'>, instruments: Instrument[], prices: PriceBook): PriceIndex | undefined {
  const cash = Math.max(0, snapshot.cash ?? 0);
  const priced: { id: string; value: number; base: number }[] = [];
  let unpriced = 0;
  for (const h of snapshot.holdings) {
    const value = Math.max(0, h.value);
    const inst = matchInstrument(h, instruments);
    const base = inst ? prices.on(inst.id, snapshot.date) : undefined;
    if (inst && base) priced.push({ id: inst.id, value, base });
    else unpriced += value;
  }
  const pricedValue = priced.reduce((s, p) => s + p.value, 0);
  const total = pricedValue + unpriced + cash;
  if (!priced.length || total <= 0 || (pricedValue + cash) / total < PRICE_RULES.minPricedShare) return undefined;
  const spans = priced.map((p) => prices.span(p.id)!);
  const from = spans.map((s) => s.from).sort().reverse()[0]!;
  const to = spans.map((s) => s.to).sort()[0]!;
  return {
    snapshot: snapshot.date,
    from: addDays(from, -PRICE_RULES.startSlackDays),
    to,
    at(date: ISODate) {
      const moved = priced.reduce((s, p) => s + p.value * (prices.on(p.id, date)! / p.base), 0);
      const ratio = moved / pricedValue;
      return (cash + moved + unpriced * ratio) / total;
    },
  };
}

/** Whether an index has prices for every day from `from` to `to`. */
export const covers = (index: PriceIndex, from: ISODate, to: ISODate): boolean => from >= index.from && diffDays(index.to, to) <= 0;

/**
 * The index for valuing an account near a day: weighted by its holdings snapshot nearest to that day
 * (the later of two equally near), when there is one and enough of it is priced.
 */
export function indexNear(snapshots: readonly HoldingsSnapshot[], day: ISODate, instruments: Instrument[], prices: PriceBook): PriceIndex | undefined {
  const ranked = [...snapshots].sort((a, b) => Math.abs(diffDays(a.date, day)) - Math.abs(diffDays(b.date, day)) || b.date.localeCompare(a.date));
  for (const s of ranked) {
    const idx = priceIndex(s, instruments, prices);
    if (idx) return idx;
  }
  return undefined;
}

/** Words that tell one fund from another, without those every fund name has. */
const COMMON = new Set(['ETF', 'UCITS', 'USD', 'GBP', 'ACC', 'ACCUMULATION', 'INC', 'INCOME', 'INDEX', 'IDX', 'FUND', 'CLASS', 'TRUST', 'UNIT', 'TR', 'THE', 'OF', 'AND', 'DEL', 'DATE', 'PLC', 'FUNDS', 'SHARES']);
const words = (s: string): string[] => (s.toUpperCase().match(/[A-Z][A-Z0-9]+/g) ?? []).filter((w) => !COMMON.has(w));

/** What a trade row says: how many units (a "Purchase 20 …", "12 EXAMPLE ETF Del 25.10 …"). */
const UNITS = /^\s*(?:purchase|sale|bought|sold|buy|sell)?\s*([\d,]*\.?\d+)\s+(.+)$/i;

/**
 * An account's holdings path: what its holdings were worth each day at published prices, in pence.
 * The units held are walked from a holdings snapshot through the trades recorded either side of it
 * (a purchase adds units, a sale takes them away), and the cash by every row recorded.
 */
export interface HoldingsPath {
  at(date: ISODate): number;
  /** The days it is good for: prices for every holding, and no holding walked below none. */
  from: ISODate;
  to: ISODate;
  snapshot: ISODate;
}

/**
 * The holdings path from a snapshot, or none: when a holding with no prices is more than a little of
 * the value, or a trade cannot be told apart as one holding's (by its units at that day's price).
 * `cash` is the snapshot's uninvested cash, when known; else nothing is taken to be.
 */
export function holdingsPath(snapshot: Pick<HoldingsSnapshot, 'date' | 'holdings' | 'cash'>, cash: number | undefined, rows: readonly Pick<Transaction, 'date' | 'amount' | 'description' | 'category'>[], instruments: Instrument[], prices: PriceBook): HoldingsPath | undefined {
  const S = snapshot.date;
  const held = new Map<string, { units: number }>();
  let unpriced = 0;
  let total = 0;
  for (const h of snapshot.holdings) {
    total += Math.max(0, h.value);
    const inst = matchInstrument(h, instruments);
    const price = inst ? prices.on(inst.id, S) : undefined;
    if (!inst || !price) {
      unpriced += Math.max(0, h.value);
      continue;
    }
    const units = h.units ?? h.value / price;
    held.set(inst.id, { units: (held.get(inst.id)?.units ?? 0) + units });
  }
  if (!held.size || (total > 0 && unpriced / total > PRICE_RULES.maxUnpricedShare)) return undefined;
  // Each trade, as units of one holding: of those whose price that day is near the trade's own, the
  // one its words name best ("iShares Automation&Robotics" over an S&P 500 fund at a similar
  // price), else the nearest in price.
  const names = new Map([...held.keys()].map((id) => {
    const inst = instruments.find((i) => i.id === id)!;
    return [id, new Set([inst.name, ...inst.aliases].flatMap(words))] as const;
  }));
  const trades: { date: ISODate; id: string; units: number }[] = [];
  for (const t of rows) {
    if (t.category !== 'trade') continue;
    const m = UNITS.exec(t.description);
    const units = m ? Number(m[1]!.replace(/,/g, '')) : NaN;
    if (!(units > 0)) return undefined;
    const own = Math.abs(t.amount) / units;
    const said = words(m![2]!);
    let best: { id: string; named: number; miss: number } | undefined;
    for (const id of held.keys()) {
      const p = prices.on(id, t.date);
      if (!p) continue;
      const miss = Math.abs(Math.log(own / p));
      if (miss > Math.log(1 + PRICE_RULES.tradePriceTolerance)) continue;
      const named = said.filter((w) => names.get(id)!.has(w)).length;
      if (!best || named > best.named || (named === best.named && miss < best.miss)) best = { id, named, miss };
    }
    if (!best) return undefined;
    trades.push({ date: t.date, id: best.id, units: t.amount < 0 ? units : -units });
  }
  const unitsOn = (id: string, date: ISODate) => {
    let u = held.get(id)!.units;
    for (const tr of trades) if (tr.id === id) u += date >= S ? (tr.date > S && tr.date <= date ? tr.units : 0) : tr.date > date && tr.date <= S ? -tr.units : 0;
    return u;
  };
  // Back from the snapshot, it is good until a holding would be walked below none.
  let from = [...held.keys()].map((id) => prices.span(id)!.from).sort().reverse()[0]!;
  // (A snapshot that gives values alone has units worked out from prices, so a little below is none.)
  for (const tr of [...trades].sort((a, b) => b.date.localeCompare(a.date))) if (tr.date <= S && unitsOn(tr.id, addDays(tr.date, -1)) < -(0.01 + 0.02 * held.get(tr.id)!.units)) {
    if (tr.date > from) from = tr.date;
    break;
  }
  const to = [...held.keys()].map((id) => prices.span(id)!.to).sort()[0]!;
  const cashS = toMinor(cash ?? 0);
  const rowsMinor = rows.map((r) => ({ date: r.date, minor: toMinor(r.amount) }));
  return {
    snapshot: S,
    from,
    to,
    at(date: ISODate) {
      let c = cashS;
      for (const r of rowsMinor) {
        if (date < S && r.date > date && r.date <= S) c -= r.minor;
        else if (date > S && r.date > S && r.date <= date) c += r.minor;
      }
      let value = c + toMinor(unpriced);
      for (const id of held.keys()) value += Math.max(0, unitsOn(id, date)) * prices.on(id, date)! * 100;
      return value;
    },
  };
}
