// The capture list: what to collect from each provider, with each ask ticked off by the data when it
// can be (statement coverage, a real valuation, a tax figure) and by you otherwise. The items are
// records in capture.json, written through records.ts; this only works out where each one stands.

import type { CaptureAskView, CaptureItemView, CaptureResponse } from '../../shared/api';
import { settledThrough } from '../../shared/coverage';
import { formatDate, formatSpan, today, type ISODate } from '../../shared/dates';
import type { CaptureAsk, CaptureItem } from '../../shared/schema';
import { parseTaxYear } from '../../shared/uk';
import type { Store } from '../store';
import { isPaidInToDate } from './balances';
import { coveredIntervals, missingDays } from './coverage';
import { isPayslipFigure, payerKey } from './pay';

function checkAsk(store: Store, item: CaptureItem, ask: CaptureAsk, now: ISODate): Pick<CaptureAskView, 'state' | 'progress'> {
  const check = ask.check;
  if (!check) return { state: 'todo' };
  const account = item.accountId ? store.account(item.accountId) : undefined;
  switch (check.type) {
    case 'coverage': {
      if (!account) return { state: 'todo', progress: 'The account is not in your data yet.' };
      // The one rule for missing days (docs/FORMULAS.md §3), to the check's day or, by default, to
      // the end of the month before last: the statements for later days are still due.
      const to = check.to ?? settledThrough(now);
      const covered = coveredIntervals(store, account);
      const missing = missingDays(store, account, check.from, to, covered);
      if (!missing.length) {
        const from = account.openedOn && account.openedOn > check.from ? account.openedOn : check.from;
        const end = account.closedOn && account.closedOn < to ? account.closedOn : to;
        return { state: 'done', progress: from > end ? 'Nothing to cover in this period.' : `Covered ${formatSpan(from, end)}.` };
      }
      const had = covered.filter((i) => i.to >= check.from && i.from <= to);
      if (!had.length) return { state: 'todo' };
      const gaps = missing.slice(0, 3).map((g) => formatSpan(g.from, g.to));
      return { state: 'partial', progress: `Missing ${gaps.join('; ')}${missing.length > 3 ? ` and ${missing.length - 3} more stretches` : ''}.` };
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
          // A figure with no tax year is the year's it is dated in, except a summary of what was paid
          // in since the start, which is no year's.
          (f.taxYear === check.taxYear || (!f.taxYear && !isPaidInToDate(f) && ty && (f.periodEnd ?? f.date ?? '') >= ty.start && (f.periodEnd ?? f.date ?? '') <= ty.end)) &&
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
