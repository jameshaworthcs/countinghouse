// The monthly update checklist: for every open account, is this month's data in, and how to get it.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import type { MonthlyChecklistResponse, MonthlyItem } from '../../shared/api';
import { addDays, diffDays, monthKey, startOfMonth, today } from '../../shared/dates';
import type { Account } from '../../shared/schema';
import type { Store } from '../store';
import { lastUpdated, type BalanceEngine } from './balances';

/** How to get a statement export out of each provider's app or website. */
const TIPS: Record<string, string> = {
  monzo: 'Monzo app → Home → your account → ⋯ → Export transactions → CSV (choose last month). Or share a statement PDF.',
  starling: 'Starling app → Account → Statements → Export CSV for last month.',
  revolut: 'Revolut app → Accounts → ⋯ → Statement → Excel/CSV, last month.',
  barclays: 'Barclays online banking → Account → Export transactions → CSV. The app can share a PDF statement.',
  hsbc: 'HSBC online banking → Account → Download transactions → CSV.',
  'first-direct': 'first direct online banking → Statements → Download → CSV.',
  lloyds: 'Lloyds online banking → Account → Export → CSV.',
  halifax: 'Halifax online banking → Account → Export → CSV.',
  'bank-of-scotland': 'Bank of Scotland online banking → Account → Export → CSV.',
  natwest: 'NatWest online banking → Statements → Download or export transactions → CSV.',
  rbs: 'RBS online banking → Statements → Download or export transactions → CSV.',
  santander: 'Santander online banking → Account → Download transactions → Text (TXT) or OFX.',
  nationwide: 'Nationwide Internet Bank → Account → Download transactions → CSV.',
  tsb: 'TSB online banking → Account → Export transactions → CSV.',
  amex: 'Amex website → Statements & Activity → Download → CSV.',
  chase: 'Chase app → Account → Statements → share the PDF (or screenshot the transactions list).',
  'trading-212': 'Trading 212 → History → Export CSV (last month), plus a screenshot of the account value.',
  vanguard: 'Vanguard Investor app → Account → screenshot the value and holdings.',
  'hargreaves-lansdown': 'HL app → Account → screenshot the value and holdings (or download the quarterly statement PDF).',
  'aj-bell': 'AJ Bell app → Account → screenshot the value and holdings.',
  moneybox: 'Moneybox app → the account → screenshot the value (include "total deposits").',
  pensionbee: 'PensionBee app → screenshot the pot value and contributions.',
  nest: 'Nest online → screenshot your pot value and this year’s contributions.',
  aviva: 'MyAviva → the pension → screenshot the value and contributions.',
  'ns-and-i': 'NS&I online → Premium Bonds → screenshot the holding.',
};

function wantFor(a: Account): MonthlyItem['want'] {
  if (a.type === 'property' || a.type === 'other_asset' || a.type === 'db_pension' || a.type === 'state_pension' || a.type === 'student_loan' || a.type === 'mortgage') return 'balance';
  if (ACCOUNT_TYPE_META[a.type].expectsTransactions && balanceModeOf(a) === 'ledger') return 'statement';
  return 'screenshot';
}

function tipFor(a: Account, want: MonthlyItem['want']): string {
  const specific = a.institutionId ? TIPS[a.institutionId] : undefined;
  if (specific) return specific;
  if (want === 'statement') return 'Download last month’s statement as CSV, OFX or PDF from online banking, or screenshot the transaction list.';
  if (want === 'screenshot') return 'Screenshot the account value (and holdings or contributions if shown).';
  if (a.type === 'property') return 'Update the estimated value a few times a year (e.g. from a valuation site).';
  if (a.type === 'state_pension') return 'Check gov.uk/check-state-pension once a year and record the forecast.';
  return 'Update the balance from your latest statement.';
}

export function monthlyChecklist(store: Store, engine: BalanceEngine): MonthlyChecklistResponse {
  const now = today();
  const items: MonthlyItem[] = [];
  for (const a of store.accounts.filter((x) => x.status === 'open')) {
    const want = wantFor(a);
    const last = lastUpdated(store, engine, a.id);
    // Monthly accounts are current once data reaches (nearly) the end of last month; yearly ones
    // once they are under a year old.
    let status: MonthlyItem['status'];
    if (!last) status = 'never';
    else if (want === 'balance') status = diffDays(last, now) <= 365 ? 'up-to-date' : 'overdue';
    else if (last >= addDays(startOfMonth(now), -5)) status = 'up-to-date';
    else status = diffDays(last, now) > 62 ? 'overdue' : 'due';
    const inst = store.institution(a.institutionId);
    items.push({
      accountId: a.id,
      name: a.name,
      type: a.type,
      lastData: last,
      due: status !== 'up-to-date',
      status,
      want,
      tip: tipFor(a, want),
      ...(inst ? { institutionName: inst.name } : {}),
    });
  }
  const order = { never: 0, overdue: 1, due: 2, 'up-to-date': 3 } as const;
  items.sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name));
  return { month: monthKey(now), items, done: items.filter((i) => !i.due).length, total: items.length };
}
