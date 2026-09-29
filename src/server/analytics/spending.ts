// Spending habits: where the money goes, how that is changing, and patterns worth knowing about.

import type { Signal, SpendingResponse, SummaryResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, addMonths, diffDays, endOfMonth, formatDate, monthKey, startOfMonth, today, weekday, eachMonth, type ISODate } from '../../shared/dates';
import { cleanPayee } from '../../shared/merchants';
import { formatMoney, formatPercent, fromMinor } from '../../shared/money';
import { taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import { categoryBreakdown, flows } from './cashflow';
import { Coverage, type JointCoverage } from './coverage';
import { detectRecurring } from './recurring';

/** Thresholds for the computed signals (docs/FORMULAS.md §10). */
export const SIGNAL_RULES = {
  /** A period-on-period change worth mentioning. */
  totalChange: 0.1,
  /** Category trend: at least this relative change and this many pounds a month. */
  trendChange: 0.25,
  trendMinimumPounds: 20,
  /** Categories below this monthly average are too small to trend. */
  trendBasePounds: 30,
  /** A "small purchase" is this much or less. */
  smallPurchase: 10,
  smallCount: 20,
  /** A habit: at least this many purchases in 30 days. */
  habitCount: 6,
  weekendRatio: 1.5,
  cashShare: 0.1,
  uncategorisedShare: 0.08,
  topCategoryShare: 0.25,
  /** Share of days that must be covered before rates are compared. */
  minCoverage: 0.5,
} as const;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The period a spending period is compared with, like for like, so that monthly bills fall the
 * same way in both:
 * - from the start of a tax year: the same dates a year earlier;
 * - from the 1st of a month: the same days, as many months earlier as the period spans (a period
 *   ending on a month's last day compares with whole months);
 * - otherwise: the same number of days just before.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  if (from === taxYearOf(from).start) return { from: addMonths(from, -12), to: addMonths(to, -12) };
  if (from === startOfMonth(from)) {
    const months = eachMonth(from, to).length;
    const shifted = addMonths(to, -months);
    return { from: addMonths(from, -months), to: to === endOfMonth(to) ? endOfMonth(shifted) : shifted };
  }
  const days = diffDays(from, to) + 1;
  const previousTo = addDays(from, -1);
  return { from: addDays(previousTo, -(days - 1)), to: previousTo };
}

/**
 * Spending this month so far, and how it compares with the same days last month (FORMULAS §14).
 * Unknown until some day of the month has data for every account. The change is like for like:
 * only days with data for every account in both months count, and they must be at least half the
 * days so far.
 */
export function monthToDate(store: Store, coverage: Coverage, now: ISODate): SummaryResponse['monthToDate'] {
  const from = startOfMonth(now);
  const prev = previousPeriod(from, now);
  const cov = coverage.joint(from, now);
  const prevCov = coverage.joint(prev.from, prev.to);
  const covered = (c: JointCoverage, d: ISODate) => c.intervals.some((i) => i.from <= d && d <= i.to);
  const byDay = new Map<ISODate, number>();
  for (const f of flows(store, prev.from, now)) if (f.cls === 'spending') byDay.set(f.t.date, (byDay.get(f.t.date) ?? 0) + f.minor);
  let spent = 0;
  for (const [d, minor] of byDay) if (d >= from) spent += minor;
  // Day n of this month against day n of last month, while last month has one.
  let compared = 0;
  let current = 0;
  let previous = 0;
  for (let d = from, p = prev.from; d <= now && p <= prev.to; d = addDays(d, 1), p = addDays(p, 1)) {
    if (!covered(cov, d) || !covered(prevCov, p)) continue;
    compared++;
    current += byDay.get(d) ?? 0;
    previous += byDay.get(p) ?? 0;
  }
  const comparable = compared >= SIGNAL_RULES.minCoverage * cov.totalDays;
  const note =
    cov.days === 0
      ? 'no day this month has data for every account yet'
      : comparable
        ? null
        : cov.days < SIGNAL_RULES.minCoverage * cov.totalDays
          ? `only ${cov.days} of ${cov.totalDays} days so far have data for every account`
          : `not enough data for ${formatDate(prev.from, { year: false })} – ${formatDate(prev.to, { year: false })} to compare`;
  return { spending: cov.days > 0 ? fromMinor(spent) : null, change: comparable ? fromMinor(current - previous) : null, note };
}

export function spending(store: Store, from: string, to: string, coverage: Coverage = new Coverage(store)): SpendingResponse {
  const cats = new CategoryIndex(store.categories);
  const { from: previousFrom, to: previousTo } = previousPeriod(from, to);
  const list = flows(store, from, to).filter((f) => f.cls === 'spending');
  const prev = flows(store, previousFrom, previousTo).filter((f) => f.cls === 'spending');
  const total = list.reduce((s, f) => s + f.minor, 0);
  const previousTotal = prev.reduce((s, f) => s + f.minor, 0);
  const cov = coverage.joint(from, to);
  const prevCov = coverage.joint(previousFrom, previousTo);
  const { categories, groups } = categoryBreakdown(list, cats, 'spending', prev);

  // Heatmap: leaf categories × months, for the months in range (at most the last 12).
  const months = eachMonth(from, to).slice(-12);
  const byCat = new Map<string, number[]>();
  for (const f of list) {
    const mi = months.indexOf(monthKey(f.t.date));
    if (mi < 0) continue;
    const id = f.t.category ?? 'uncategorised';
    const row = byCat.get(id) ?? byCat.set(id, months.map(() => 0)).get(id)!;
    row[mi]! += f.minor;
  }
  const heatRows = [...byCat.entries()]
    .map(([id, values]) => ({ id, name: id === 'uncategorised' ? 'Uncategorised' : cats.name(id), values: values.map(fromMinor), total: fromMinor(values.reduce((a, b) => a + b, 0)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 14);

  // Merchants.
  const merchants = new Map<string, { minor: number; count: number; category?: string; lastDate: string }>();
  for (const f of list) {
    const payee = f.t.payee ?? cleanPayee(f.t.description);
    const e = merchants.get(payee) ?? { minor: 0, count: 0, lastDate: f.t.date };
    e.minor += f.minor;
    e.count++;
    if (f.t.date >= e.lastDate) e.lastDate = f.t.date;
    if (f.t.category) e.category = f.t.category;
    merchants.set(payee, e);
  }
  const merchantList = [...merchants.entries()]
    .map(([payee, e]) => ({
      payee,
      categoryName: cats.name(e.category),
      amount: fromMinor(e.minor),
      count: e.count,
      average: fromMinor(Math.round(e.minor / e.count)),
      lastDate: e.lastDate,
      ...(e.category ? { category: e.category } : {}),
    }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);

  // Day of week: average per occurrence of that weekday in the range.
  const occurrences = WEEKDAYS.map(() => 0);
  for (let d = from; d <= to; d = addDays(d, 1)) occurrences[weekday(d)]!++;
  const wd = WEEKDAYS.map(() => ({ minor: 0, count: 0 }));
  for (const f of list) {
    const e = wd[weekday(f.t.date)]!;
    e.minor += f.minor;
    e.count++;
  }
  const weekdayStats = [1, 2, 3, 4, 5, 6, 0].map((day) => ({
    day,
    label: WEEKDAYS[day]!,
    total: fromMinor(wd[day]!.minor),
    average: fromMinor(Math.round(wd[day]!.minor / Math.max(1, occurrences[day]!))),
    count: wd[day]!.count,
  }));

  // Time of day, only when enough transactions carry a time.
  const timed = list.filter((f) => f.t.time);
  const hours =
    timed.length >= Math.max(20, list.length * 0.3)
      ? Array.from({ length: 24 }, (_, hour) => {
          const hs = timed.filter((f) => Number(f.t.time!.slice(0, 2)) === hour);
          return { hour, total: fromMinor(hs.reduce((s, f) => s + f.minor, 0)), count: hs.length };
        })
      : null;

  const largest = [...list]
    .sort((a, b) => b.minor - a.minor)
    .slice(0, 12)
    .map((f) => f.t);
  const threshold = SIGNAL_RULES.smallPurchase * 100;
  const smallList = list.filter((f) => f.minor > 0 && f.minor <= threshold);

  const recurring = detectRecurring(store);
  const signals = buildSignals(store, cats, coverage, { total, previousTotal, cov, prevCov, list, recurring, weekdayStats, smallCount: smallList.length, smallTotal: smallList.reduce((s, f) => s + f.minor, 0), categories, to });

  return {
    from,
    to,
    previousFrom,
    previousTo,
    total: fromMinor(total),
    previousTotal: fromMinor(previousTotal),
    // Averages divide by the days every account has data for, not the calendar.
    dailyAverage: fromMinor(Math.round(total / Math.max(1, cov.days || diffDays(from, to) + 1))),
    coverage: { days: cov.days, totalDays: cov.totalDays, limiting: cov.limiting.slice(0, 5), previousDays: prevCov.days },
    categories,
    groups,
    heatmap: { months, rows: heatRows },
    merchants: merchantList,
    weekday: weekdayStats,
    hours,
    largest,
    small: { threshold: threshold / 100, count: smallList.length, total: fromMinor(smallList.reduce((s, f) => s + f.minor, 0)) },
    signals,
    recurring,
  };
}

/**
 * Computed signals: deterministic observations with named thresholds (SIGNAL_RULES), never
 * inferences. Each says which rule produced it. Rates compare covered time, so partial data does
 * not look like a change in habits.
 */
function buildSignals(
  store: Store,
  cats: CategoryIndex,
  coverage: Coverage,
  ctx: {
    total: number;
    previousTotal: number;
    cov: JointCoverage;
    prevCov: JointCoverage;
    list: ReturnType<typeof flows>;
    recurring: ReturnType<typeof detectRecurring>;
    weekdayStats: { day: number; average: number }[];
    smallCount: number;
    smallTotal: number;
    categories: SpendingResponse['categories'];
    to: string;
  },
): Signal[] {
  const out: Signal[] = [];
  const R = SIGNAL_RULES;
  const money = (minorOrMajor: number, isMinor = false) => formatMoney(isMinor ? minorOrMajor / 100 : minorOrMajor, { decimals: 0 });
  const enough = (c: JointCoverage) => c.days >= R.minCoverage * c.totalDays;

  if (ctx.previousTotal > 0 && ctx.total > 0 && enough(ctx.cov) && enough(ctx.prevCov)) {
    const rate = ctx.total / ctx.cov.days;
    const prevRate = ctx.previousTotal / ctx.prevCov.days;
    const change = (rate - prevRate) / prevRate;
    if (Math.abs(change) >= R.totalChange) {
      out.push({
        id: 'total-change',
        tone: change > 0 ? 'warning' : 'good',
        title: `Spending ${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), 0)} on the previous period`,
        detail: `${money(rate * 30.44, true)} a month at this period's pace, against ${money(prevRate * 30.44, true)} before (covered days only).`,
        rule: `Daily spending rate over covered days changed by ${Math.round(R.totalChange * 100)}% or more`,
      });
    }
  }

  // Category trends: the last 3 months against the 9 before, per covered month.
  const end = ctx.to;
  const recentFrom = startOfMonth(addMonths(end, -2));
  const baseFrom = startOfMonth(addMonths(end, -11));
  const recentCov = coverage.joint(recentFrom, end);
  const baseCov = coverage.joint(baseFrom, addDays(recentFrom, -1));
  if (recentCov.days >= 28 && baseCov.days >= 60) {
    const inCov = (c: JointCoverage, d: string) => c.intervals.some((i) => i.from <= d && d <= i.to);
    const all = flows(store, baseFrom, end).filter((f) => f.cls === 'spending');
    const recent = new Map<string, number>();
    const base = new Map<string, number>();
    for (const f of all) {
      const id = f.t.category ?? 'uncategorised';
      if (f.t.date >= recentFrom && inCov(recentCov, f.t.date)) recent.set(id, (recent.get(id) ?? 0) + f.minor);
      else if (f.t.date < recentFrom && inCov(baseCov, f.t.date)) base.set(id, (base.get(id) ?? 0) + f.minor);
    }
    const recentMonths = recentCov.days / 30.44;
    const baseMonths = baseCov.days / 30.44;
    const trends: Signal[] = [];
    for (const [id, r] of recent) {
      const recentAvg = r / recentMonths;
      const baseAvg = (base.get(id) ?? 0) / baseMonths;
      if (baseAvg < R.trendBasePounds * 100 || id === 'uncategorised') continue;
      const change = (recentAvg - baseAvg) / baseAvg;
      if (Math.abs(change) >= R.trendChange && Math.abs(recentAvg - baseAvg) >= R.trendMinimumPounds * 100) {
        trends.push({
          id: `trend-${id}`,
          tone: change > 0 ? 'warning' : 'good',
          title: `${cats.name(id)} ${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), 0)}`,
          detail: `${money(recentAvg, true)} a month over the last 3 months, against ${money(baseAvg, true)} before.`,
          rule: `Monthly average over covered time changed by ${Math.round(R.trendChange * 100)}% and £${R.trendMinimumPounds} or more`,
        });
      }
    }
    trends.sort((a, b) => b.title.localeCompare(a.title));
    out.push(...trends.slice(0, 4));
  }

  const active = ctx.recurring.filter((r) => r.active);
  if (active.length) {
    const monthly = active.reduce((s, r) => s + r.monthlyCost, 0);
    out.push({
      id: 'recurring',
      tone: 'neutral',
      title: `${active.length} regular payments cost ${money(monthly)} a month`,
      detail: `That is ${money(monthly * 12)} a year across subscriptions, bills and memberships.`,
      rule: 'Same payee at a steady interval, 3 or more times',
    });
  }
  for (const r of active.filter((x) => x.priceChange && x.priceChange.to > x.priceChange.from).slice(0, 3)) {
    out.push({
      id: `price-${r.key}`,
      tone: 'warning',
      title: `${r.payee} went up`,
      detail: `From ${formatMoney(r.priceChange!.from)} to ${formatMoney(r.priceChange!.to)} (${r.cadence}).`,
      rule: 'A regular payment changed by more than 3% and held steady since',
    });
  }

  const last30From = addDays(end, -29);
  const last30Cov = coverage.joint(last30From, end);
  if (last30Cov.days >= 25) {
    const last30 = flows(store, last30From, end).filter((f) => f.cls === 'spending');
    for (const [id, label] of [
      ['coffee', 'Coffee & snacks'],
      ['takeaway', 'Takeaways'],
    ] as const) {
      const hits = last30.filter((f) => f.t.category === id);
      if (hits.length >= R.habitCount) {
        const sum = hits.reduce((s, f) => s + f.minor, 0);
        out.push({ id: `habit-${id}`, tone: 'neutral', title: `${label}: ${hits.length} times in 30 days`, detail: `${money(sum, true)} in total, about ${money((sum / 30) * 365, true)} a year at this pace.`, rule: `${R.habitCount} or more purchases in the last 30 days` });
      }
    }
  }

  const weekend = ((ctx.weekdayStats.find((d) => d.day === 0)?.average ?? 0) + (ctx.weekdayStats.find((d) => d.day === 6)?.average ?? 0)) / 2;
  const weekdays = ctx.weekdayStats.filter((d) => d.day >= 1 && d.day <= 5).reduce((s, d) => s + d.average, 0) / 5;
  if (weekdays > 0 && weekend > weekdays * R.weekendRatio && enough(ctx.cov)) {
    out.push({ id: 'weekend', tone: 'neutral', title: 'Weekends cost more', detail: `An average weekend day costs ${money(weekend)}, against ${money(weekdays)} on weekdays.`, rule: `Weekend daily average ${R.weekendRatio}× the weekday average or more` });
  }

  if (ctx.smallCount >= R.smallCount) {
    out.push({ id: 'small', tone: 'neutral', title: `${ctx.smallCount} small purchases add up`, detail: `Purchases of £${R.smallPurchase} or less came to ${money(ctx.smallTotal, true)} this period.`, rule: `${R.smallCount} or more purchases of £${R.smallPurchase} or less` });
  }
  const cash = ctx.categories.find((c) => c.id === 'cash-withdrawal');
  if (cash && ctx.total > 0 && cash.amount * 100 > ctx.total * R.cashShare) {
    out.push({ id: 'cash', tone: 'neutral', title: `${formatPercent(cash.share, 0)} of spending was cash`, detail: `${money(cash.amount)} withdrawn: where it went is not tracked.`, rule: `Cash withdrawals over ${Math.round(R.cashShare * 100)}% of spending` });
  }
  const unc = ctx.categories.find((c) => c.id === 'uncategorised');
  if (unc && unc.share > R.uncategorisedShare) {
    out.push({ id: 'uncategorised', tone: 'warning', title: `${formatPercent(unc.share, 0)} of spending is uncategorised`, detail: 'Categorise a few transactions and create rules so the picture sharpens.', rule: `Over ${Math.round(R.uncategorisedShare * 100)}% uncategorised` });
  }
  const topGroup = ctx.categories[0];
  if (topGroup && topGroup.id !== 'uncategorised' && topGroup.share > R.topCategoryShare) {
    out.push({ id: 'top', tone: 'neutral', title: `${topGroup.name} is ${formatPercent(topGroup.share, 0)} of spending`, detail: `${money(topGroup.amount)} this period.`, rule: `One category over ${Math.round(R.topCategoryShare * 100)}% of spending` });
  }
  return out;
}

export function defaultSpendingRange(): { from: string; to: string } {
  const to = today();
  return { from: addDays(to, -89), to };
}
