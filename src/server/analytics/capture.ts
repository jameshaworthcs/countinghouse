// The capture list: what to collect from each provider, with each ask ticked off by the data when it
// can be (statement coverage, a real valuation, a tax figure) and by you otherwise. The items are
// records in capture.json, written through records.ts; this only works out where each one stands.

import type { CaptureAskView, CaptureItemView, CaptureResponse } from '../../shared/api';
import { addDays, diffDays, formatDate, maxDate, today, type ISODate } from '../../shared/dates';
import type { CaptureAsk, CaptureItem } from '../../shared/schema';
import { parseTaxYear } from '../../shared/uk';
import type { Store } from '../store';
import { wrapperDataSpan } from './allowances';
import { complement } from './coverage';
import { isPayslipFigure, payerKey } from './pay';

/** Gaps this short between statements (or at the ends of the period) do not count as missing. */
const GAP_SLACK_DAYS = 4;
/** "Up to now" means up to about a month ago: the latest statement closes some weeks back. */
const RECENT_DAYS = 35;

const span = (from: ISODate, to: ISODate) => (from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`);

function checkAsk(store: Store, item: CaptureItem, ask: CaptureAsk, now: ISODate): Pick<CaptureAskView, 'state' | 'progress'> {
  const check = ask.check;
  if (!check) return { state: 'todo' };
  const account = item.accountId ? store.account(item.accountId) : undefined;
  switch (check.type) {
    case 'coverage': {
      if (!account) return { state: 'todo', progress: 'The account is not in your data yet.' };
      const from = maxDate(check.from, account.openedOn) ?? check.from;
      const to = check.to ?? addDays(now, -RECENT_DAYS);
      const end = account.closedOn && account.closedOn < to ? account.closedOn : to;
      if (from > end) return { state: 'done', progress: 'Nothing to cover in this period.' };
      const intervals = wrapperDataSpan(store, account);
      const missing = complement(intervals, from, end).filter((g) => diffDays(g.from, g.to) + 1 > GAP_SLACK_DAYS);
      if (!missing.length) return { state: 'done', progress: `Covered ${span(from, end)}.` };
      const had = intervals.filter((i) => i.to >= from && i.from <= end);
      if (!had.length) return { state: 'todo' };
      const gaps = missing.slice(0, 3).map((g) => span(g.from, g.to));
      return { state: 'partial', progress: `Missing ${gaps.join('; ')}${missing.length > 3 ? ` and ${missing.length - 3} more gaps` : ''}.` };
    }
    case 'valuation': {
      if (!account) return { state: 'todo', progress: 'The account is not in your data yet.' };
      const value = store
        .balances(account.id)
        .filter((b) => b.date >= check.since && !b.approximate)
        .at(-1);
      const holdings = store.holdings(account.id).filter((h) => h.date >= check.since).at(-1);
      if (value && (!check.holdings || holdings)) return { state: 'done', progress: `Value of ${formatDate(value.date)}${check.holdings ? ' with holdings' : ''}.` };
      if (value || holdings) return { state: 'partial', progress: value ? `Have the value of ${formatDate(value.date)}; the holdings are still missing.` : `Have holdings of ${formatDate(holdings!.date)}; the value is still missing.` };
      return { state: 'todo' };
    }
    case 'figures': {
      const ty = parseTaxYear(check.taxYear);
      const payer = check.payer ? payerKey(check.payer).slice(0, 8) : '';
      const found = store.figures.filter(
        (f) =>
          check.kinds.includes(f.kind) &&
          (f.taxYear === check.taxYear || (!f.taxYear && ty && (f.periodEnd ?? f.date ?? '') >= ty.start && (f.periodEnd ?? f.date ?? '') <= ty.end)) &&
          (!check.from || isPayslipFigure(store, f) === (check.from === 'payslip')) &&
          (!payer || payerKey(f.payer).includes(payer)),
      );
      return found.length ? { state: 'done', progress: `In your documents: ${found.slice(0, 3).map((f) => `${f.label}${f.payer ? ` (${f.payer})` : ''}`).join(', ')}${found.length > 3 ? ` and ${found.length - 3} more` : ''}.` } : { state: 'todo' };
    }
  }
}

export function captureList(store: Store, now: ISODate = today()): CaptureResponse {
  const order = { high: 0, normal: 1, low: 2 } as const;
  const items: CaptureItemView[] = store.capture.map((item) => {
    const asks: CaptureAskView[] = item.asks.map((ask) => {
      const auto = checkAsk(store, item, ask, now);
      const state = ask.doneAt ? 'done' : auto.state;
      return {
        id: ask.id,
        what: ask.what,
        ...(ask.how ? { how: ask.how } : {}),
        ...(ask.why ? { why: ask.why } : {}),
        state,
        checkedByData: Boolean(ask.check),
        tickedByYou: Boolean(ask.doneAt),
        ...(auto.progress ? { progress: auto.progress } : {}),
      };
    });
    const account = item.accountId ? store.account(item.accountId) : undefined;
    const institution = store.institution(item.institutionId ?? account?.institutionId);
    return {
      id: item.id,
      title: item.title,
      priority: item.priority,
      ...(item.note ? { note: item.note } : {}),
      ...(account ? { accountId: account.id } : {}),
      ...(institution ? { institutionId: institution.id, institutionName: institution.name } : {}),
      asks,
      done: asks.every((a) => a.state === 'done'),
      skipped: Boolean(item.skippedAt),
    };
  });
  items.sort((a, b) => Number(a.skipped) - Number(b.skipped) || Number(a.done) - Number(b.done) || order[a.priority] - order[b.priority]);
  const live = items.filter((i) => !i.skipped);
  const asks = live.flatMap((i) => i.asks);
  return { items, asks: asks.length, asksDone: asks.filter((a) => a.state === 'done').length, open: live.filter((i) => !i.done).length };
}
