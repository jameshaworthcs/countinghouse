// Spending habits: where the money goes, how that is changing, and patterns worth knowing about.

import type { Insight, SpendingResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { addDays, addMonths, diffDays, eachMonth, monthKey, startOfMonth, today, weekday } from '../../shared/dates';
import { cleanPayee } from '../../shared/merchants';
import { formatMoney, formatPercent, fromMinor } from '../../shared/money';
import type { Store } from '../store';
import { categoryBreakdown, flows } from './cashflow';
import { detectRecurring } from './recurring';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function spending(store: Store, from: string, to: string): SpendingResponse {
  const cats = new CategoryIndex(store.categories);
  const days = diffDays(from, to) + 1;
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  const list = flows(store, from, to).filter((f) => f.cls === 'spending');
  const prev = flows(store, previousFrom, previousTo).filter((f) => f.cls === 'spending');
  const total = list.reduce((s, f) => s + f.minor, 0);
  const previousTotal = prev.reduce((s, f) => s + f.minor, 0);
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
  const threshold = 1000;
  const smallList = list.filter((f) => f.minor > 0 && f.minor <= threshold);

  const recurring = detectRecurring(store);
  const insights = buildInsights(store, cats, { total, previousTotal, list, recurring, weekdayStats, smallCount: smallList.length, smallTotal: smallList.reduce((s, f) => s + f.minor, 0), categories, to });

  return {
    from,
    to,
    previousFrom,
    previousTo,
    total: fromMinor(total),
    previousTotal: fromMinor(previousTotal),
    dailyAverage: fromMinor(Math.round(total / days)),
    categories,
    groups,
    heatmap: { months, rows: heatRows },
    merchants: merchantList,
    weekday: weekdayStats,
    hours,
    largest,
    small: { threshold: threshold / 100, count: smallList.length, total: fromMinor(smallList.reduce((s, f) => s + f.minor, 0)) },
    insights,
    recurring,
  };
}

function buildInsights(
  store: Store,
  cats: CategoryIndex,
  ctx: {
    total: number;
    previousTotal: number;
    list: ReturnType<typeof flows>;
    recurring: ReturnType<typeof detectRecurring>;
    weekdayStats: { day: number; average: number }[];
    smallCount: number;
    smallTotal: number;
    categories: SpendingResponse['categories'];
    to: string;
  },
): Insight[] {
  const out: Insight[] = [];
  const money = (minorOrMajor: number, isMinor = false) => formatMoney(isMinor ? minorOrMajor / 100 : minorOrMajor, { decimals: 0 });

  if (ctx.previousTotal > 0 && ctx.total > 0) {
    const change = (ctx.total - ctx.previousTotal) / ctx.previousTotal;
    if (Math.abs(change) >= 0.1) {
      out.push({
        id: 'total-change',
        tone: change > 0 ? 'warning' : 'good',
        title: `Spending ${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), 0)} on the previous period`,
        detail: `${money(ctx.total, true)} this period against ${money(ctx.previousTotal, true)} before.`,
      });
    }
  }

  // Category trends: last 3 months vs the 9 months before that.
  const end = ctx.to;
  const recentFrom = startOfMonth(addMonths(end, -2));
  const baseFrom = startOfMonth(addMonths(end, -11));
  const all = flows(store, baseFrom, end).filter((f) => f.cls === 'spending');
  const recent = new Map<string, number>();
  const base = new Map<string, number>();
  for (const f of all) {
    const id = f.t.category ?? 'uncategorised';
    const m = f.t.date >= recentFrom ? recent : base;
    m.set(id, (m.get(id) ?? 0) + f.minor);
  }
  const baseMonths = Math.max(1, eachMonth(baseFrom, addDays(recentFrom, -1)).length);
  const trends: Insight[] = [];
  for (const [id, r] of recent) {
    const recentAvg = r / 3;
    const baseAvg = (base.get(id) ?? 0) / baseMonths;
    if (baseAvg < 3000 || id === 'uncategorised') continue;
    const change = (recentAvg - baseAvg) / baseAvg;
    if (Math.abs(change) >= 0.25 && Math.abs(recentAvg - baseAvg) >= 2000) {
      trends.push({
        id: `trend-${id}`,
        tone: change > 0 ? 'warning' : 'good',
        title: `${cats.name(id)} ${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), 0)}`,
        detail: `${money(recentAvg, true)} a month over the last 3 months, against ${money(baseAvg, true)} before.`,
      });
    }
  }
  trends.sort((a, b) => b.title.localeCompare(a.title));
  out.push(...trends.slice(0, 4));

  const active = ctx.recurring.filter((r) => r.active);
  if (active.length) {
    const monthly = active.reduce((s, r) => s + r.monthlyCost, 0);
    out.push({
      id: 'recurring',
      tone: 'neutral',
      title: `${active.length} regular payments cost ${money(monthly)} a month`,
      detail: `That is ${money(monthly * 12)} a year across subscriptions, bills and memberships.`,
    });
  }
  for (const r of active.filter((x) => x.priceChange && x.priceChange.to > x.priceChange.from).slice(0, 3)) {
    out.push({
      id: `price-${r.key}`,
      tone: 'warning',
      title: `${r.payee} went up`,
      detail: `From ${formatMoney(r.priceChange!.from)} to ${formatMoney(r.priceChange!.to)} (${r.cadence}).`,
    });
  }

  const last30 = flows(store, addDays(end, -29), end).filter((f) => f.cls === 'spending');
  for (const [id, label] of [
    ['coffee', 'Coffee & snacks'],
    ['takeaway', 'Takeaways'],
  ] as const) {
    const hits = last30.filter((f) => f.t.category === id);
    if (hits.length >= 6) {
      const sum = hits.reduce((s, f) => s + f.minor, 0);
      out.push({ id: `habit-${id}`, tone: 'neutral', title: `${label}: ${hits.length} times in 30 days`, detail: `${money(sum, true)} in total, about ${money((sum / 30) * 365, true)} a year at this pace.` });
    }
  }

  const weekend = ((ctx.weekdayStats.find((d) => d.day === 0)?.average ?? 0) + (ctx.weekdayStats.find((d) => d.day === 6)?.average ?? 0)) / 2;
  const weekdays = ctx.weekdayStats.filter((d) => d.day >= 1 && d.day <= 5).reduce((s, d) => s + d.average, 0) / 5;
  if (weekdays > 0 && weekend > weekdays * 1.5) {
    out.push({ id: 'weekend', tone: 'neutral', title: 'Weekends cost more', detail: `An average weekend day costs ${money(weekend)}, against ${money(weekdays)} on weekdays.` });
  }

  if (ctx.smallCount >= 20) {
    out.push({ id: 'small', tone: 'neutral', title: `${ctx.smallCount} small purchases add up`, detail: `Purchases of £10 or less came to ${money(ctx.smallTotal, true)} this period.` });
  }
  const cash = ctx.categories.find((c) => c.id === 'cash-withdrawal');
  if (cash && ctx.total > 0 && cash.amount * 100 > ctx.total * 0.1) {
    out.push({ id: 'cash', tone: 'neutral', title: `${formatPercent(cash.share, 0)} of spending was cash`, detail: `${money(cash.amount)} withdrawn: where it went is not tracked.` });
  }
  const unc = ctx.categories.find((c) => c.id === 'uncategorised');
  if (unc && unc.share > 0.08) {
    out.push({ id: 'uncategorised', tone: 'warning', title: `${formatPercent(unc.share, 0)} of spending is uncategorised`, detail: 'Categorise a few transactions and create rules so the picture sharpens.' });
  }
  const topGroup = ctx.categories[0];
  if (topGroup && topGroup.id !== 'uncategorised' && topGroup.share > 0.25) {
    out.push({ id: 'top', tone: 'neutral', title: `${topGroup.name} is ${formatPercent(topGroup.share, 0)} of spending`, detail: `${money(topGroup.amount)} this period.` });
  }
  return out;
}

export function defaultSpendingRange(): { from: string; to: string } {
  const to = today();
  return { from: addDays(to, -89), to };
}
