// A company's Corporation Tax computation, worked out from its general ledger (docs/FORMULAS.md §22,
// "Corporation Tax"): for each Corporation Tax accounting period, the accounts' profit allocated to it
// from its period of account, the adjustments to the trading result each code's treatment calls for,
// pre-trading expenditure, capital allowances (pools, the annual investment allowance, full expensing),
// losses and non-trading loan relationships carried from one period to the next, the tax by financial
// year with marginal relief, and the CT600's boxes. Pure but for the ledger and the accounts it reads;
// nothing is stored, and nothing is sent to HMRC: the owner files through commercial software.
//
// This is company data: one company's books at a time, served only from its own routes
// (routes/company-books.ts), never joining a figure of yours (ESLint's allowlist, eslint.config.js).

import type { CompanyCtResponse, CtAccountsLine, CtAdjustment, CtAssetRow, CtCapitalAllowances, CtCheck, CtComputationView, CtDisposalRow, CtNote, CtPeriodRow, CtPoolView, CtTreatmentKey, FixedAsset, LedgerPosting } from '../../shared/api';
import { ctPeriodsOf, withinChargeAssumed, withinChargeFrom, type CtPeriod } from '../../shared/company-books';
import { ASSOCIATED_TEST, CIHC_TEST, CT_GUIDANCE, daysOf, forPeriod, isYear, taxOnProfits, wdaChange, wdaRateHundredths, writingDown } from '../../shared/corporation-tax';
import { CT600_FORM, ct600Boxes, profitBoxes, type ProfitFigures } from '../../shared/ct600';
import { addDays, addYears, formatDate, type ISODate } from '../../shared/dates';
import { monthsAfter } from '../../shared/uk';
import { CT_DISCLAIMER } from '../../shared/disclaimers';
import { LEDGER_CODES, ledgerCode, ledgerName } from '../../shared/ledger';
import { apportion, fromMinor, mulDivRound, toMinor } from '../../shared/money';
import { costOn, coverParts } from '../../shared/period-end';
import type { Company } from '../../shared/schema';
import { AIA_LIMITS, ct600Due, s455Rate, ctPaymentDue, ctRatesFor, financialYearOf, FIRST_YEAR_ALLOWANCES, FLEXIBLE_LOSSES_FROM, LOSS_DEDUCTIONS_ALLOWANCE, PRE_TRADING_YEARS, ruleOn, SMALL_POOLS_LIMIT, WDA_RATES } from '../../shared/uk';
import type { BalanceEngine } from './balances';
import { companyLedger, type Ledger, type LedgerSource } from './ledger';
import { accountsPeriods, periodAccounts } from './period-accounts';

export interface CtInput {
  src: LedgerSource;
  company: Company;
  /** The company's own balance engine: its accounts' bank reconciliation, which their readiness needs. */
  engine: Pick<BalanceEngine, 'balanceOn' | 'statementFor'>;
  today: ISODate;
  /** The CT period's last day; absent: the one to work on next. */
  period?: ISODate | undefined;
  ledger?: Ledger;
}

/** Why each disallowable code is added back. */
const DISALLOWED_WHY: Record<string, string> = {
  depreciation: 'Depreciation is not deductible: it writes down capital (CTA 2009 s53); capital allowances are given instead.',
  'formation-costs': 'Setting the company up is capital, not an expense of the trade (CTA 2009 s53).',
  entertainment: 'Business entertainment and gifts are not deductible (CTA 2009 s1298).',
  penalties: 'Tax penalties and interest on them are not deductible (CTA 2009 s1303), nor fines for breaking the law (not incurred wholly and exclusively for the trade, s54).',
  donations: 'A donation is not an expense of the trade (CTA 2009 s54). A donation to a charity may be relieved as a qualifying charitable donation against total profits (CTA 2010 Part 6): not worked out here.',
};
const CAPITAL_WHY: Record<string, string> = {
  'small-equipment': 'Equipment is capital whatever the accounts call it (CTA 2009 s53): it takes capital allowances instead (below).',
  disposals: 'A profit or loss on disposing of a fixed asset is capital (CTA 2009 s53): its disposal value goes to capital allowances instead (below).',
};

/** The key the pre-trading expenditure released on the trade's first day is shared out under, beside the codes. */
const PRE_TRADING = '__pre-trading';

/** A posting's part of the profit (income positive, charges negative), pence. */
const profitOf = (p: LedgerPosting) => -p.amount;

/** What a code is for Corporation Tax (income and expense codes only). */
const treatmentOf = (code: string): CtTreatmentKey | undefined => {
  const e = ledgerCode(code);
  return e && (e.kind === 'income' || e.kind === 'expense') ? e.ct : undefined;
};

/** Pence as money in words. */
const money = (minor: number) => `£${fromMinor(minor).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CHART_ORDER = new Map(LEDGER_CODES.map((c, i) => [c.code, i]));
const chartIndex = (code: string): number => CHART_ORDER.get(code) ?? Number.MAX_SAFE_INTEGER;

/** An item of plant for capital allowances: an asset on the register, or small equipment expensed in the accounts. */
interface PlantItem {
  id: string;
  memo: string;
  class: string;
  pool: 'main' | 'special';
  acquired: ISODate;
  cost: number;
  connected: boolean;
  marketValue?: number;
  used: boolean;
  allowance?: 'aia' | 'first-year' | 'none';
  smallEquipment: boolean;
}

/** How an item was relieved when its allowances were claimed: so its disposal is treated as it was. */
interface Relieved {
  treatment: CtAssetRow['treatment'];
  pool: 'main' | 'special';
  qualifying: number;
  /** The part of its qualifying expenditure that took a first-year allowance (pence). */
  firstYearPart: number;
}

/** What one CT period carries to the next (pence). */
interface Carried {
  /** Pre-trading expenditure not yet released (CTA 2009 s61), and whether its release has begun. */
  preTrading: number;
  releasing: boolean;
  losses: { amount: number; flexible: boolean }[];
  nonTradingDeficits: number;
  /** Non-trading deficits of periods beginning before 1 April 2017: against non-trading profits only (CTA 2009 s457). */
  oldDeficits: number;
  mainPool: number;
  specialPool: number;
  relieved: Map<string, Relieved>;
}

/**
 * A company's Corporation Tax computations (FORMULAS.md §22, "Corporation Tax"): every CT period up to
 * the one containing today, each worked out in order so what one carries forward the next brings in,
 * and the one asked for (or the one to work on next) in full. Undefined when it keeps no books here, or
 * the period asked for is not one of them.
 */
export function companyCorporationTax({ src, company, engine, today, period: wanted, ledger: given }: CtInput): CompanyCtResponse | undefined {
  const books = company.books;
  if (!books) return undefined;
  const periods = ctPeriodsOf(books, today);
  const offered = accountsPeriods(company, today);
  const latestEnd = [offered[0]?.end, ...periods.map((p) => p.periodOfAccount.end), today].filter((d): d is ISODate => Boolean(d)).sort().at(-1)!;
  const ledger = given ?? companyLedger(src, company.id, { until: latestEnd });
  const first = books.ledgerFrom ?? books.incorporatedOn;
  const trade = books.tradeStartedOn ?? undefined;
  const trading = (d: ISODate) => trade !== undefined && d >= trade;
  const name = (code: string) => ledgerName(code, (id) => src.account(id)?.name);
  const bf = books.taxBroughtForward;

  // The accounts of each period of account, for their readiness (worked out once each).
  const accountsCache = new Map<ISODate, ReturnType<typeof periodAccounts>>();
  const accountsOf = (end: ISODate) => {
    if (!accountsCache.has(end)) accountsCache.set(end, periodAccounts({ src, company, engine, today, period: end, ledger }));
    return accountsCache.get(end);
  };

  // Profit and loss postings (the tax charge left out: the computation starts from profit before tax).
  const pl = ledger.postings.filter((p) => {
    const t = treatmentOf(p.ledger);
    return t !== undefined && t !== 'tax';
  });
  /** A loan relationship's credit or debit: interest received or paid. */
  const isLoanRelationship = (p: Pick<LedgerPosting, 'ledger'>) => {
    const t = treatmentOf(p.ledger);
    return t === 'non-trading-income' || t === 'loan-relationship';
  };
  /** Items allocated by their own date: everything before the trade started but loan relationships (which are shared out on their own basis, below). */
  const byDate = (p: LedgerPosting) => !isLoanRelationship(p) && !trading(p.date);

  // Pre-trading expenditure (CTA 2009 s61): revenue expenses before the trade started, those within 7
  // years before it treated as incurred on its first day; with any brought forward (taken as within).
  const preItems = pl.filter((p) => treatmentOf(p.ledger) === 'allowable' && !trading(p.date));
  const cutoff = trade ? addYears(trade, -PRE_TRADING_YEARS) : undefined;
  const releasable = (bf?.preTradingExpenditure ? toMinor(bf.preTradingExpenditure) : 0) + preItems.filter((p) => cutoff !== undefined && p.date >= cutoff).reduce((x, p) => x + p.amount, 0);
  const tradePoa = trade ? periods.find((c) => c.start === trade)?.periodOfAccount : undefined;

  // Time apportionment within each period of account (CTA 2009 s52(3): by days): its trading-phase items
  // by code, and the pre-trading expenditure treated as incurred on the trade's first day, shared
  // between its trading CT periods by their days.
  const apportioned = new Map<ISODate, Map<string, number>>(); // CT period end → code → pence
  for (const key of new Set(periods.map((p) => `${p.periodOfAccount.start}|${p.periodOfAccount.end}`))) {
    const [ps, pe] = key.split('|') as [ISODate, ISODate];
    const tradingCts = periods.filter((c) => c.periodOfAccount.end === pe && c.start >= ps && trading(c.start) && c.start >= first);
    if (!tradingCts.length) continue;
    const totals = new Map<string, number>();
    for (const p of pl) if (p.date >= ps && p.date <= pe && !byDate(p) && !isLoanRelationship(p)) totals.set(p.ledger, (totals.get(p.ledger) ?? 0) + profitOf(p));
    if (tradePoa && tradePoa.end === pe && releasable) totals.set(PRE_TRADING, -releasable);
    const weights = tradingCts.map((c) => daysOf(c.start, c.end));
    for (const [code, total] of totals) {
      const parts = apportion(total, weights);
      tradingCts.forEach((c, i) => {
        const m = apportioned.get(c.end) ?? apportioned.set(c.end, new Map()).get(c.end)!;
        m.set(code, (m.get(code) ?? 0) + parts[i]!);
      });
    }
  }

  // Loan relationships (interest received and paid): shared between the CT periods of each period of
  // account by days (CTA 2009 s307(2A)–(2B); CTA 2010 s1172), the days in no CT period (before it came
  // within the charge) taking their share too, which is taxed nowhere (and stops the period, below);
  // or, on the s307(2C) basis the owner may choose, as accounts drawn up for each CT period would
  // recognise them: each amount over the days it covers (`covers`), else on its day.
  const basis = books.loanRelationshipBasis ?? 'time';
  const lrParts = new Map<ISODate, Map<string, number>>(); // CT period end → code → pence
  const addLr = (end: ISODate, code: string, amount: number) => {
    if (!amount) return;
    const m = lrParts.get(end) ?? lrParts.set(end, new Map()).get(end)!;
    m.set(code, (m.get(code) ?? 0) + amount);
  };
  const lrPostings = pl.filter(isLoanRelationship);
  const inBooks = periods.filter((c) => c.start >= first);
  if (basis === 'time') {
    for (const key of new Set(inBooks.map((p) => `${p.periodOfAccount.start}|${p.periodOfAccount.end}`))) {
      const [ps, pe] = key.split('|') as [ISODate, ISODate];
      const cts = inBooks.filter((c) => c.periodOfAccount.end === pe && c.start >= ps);
      const covered = cts.reduce((x, c) => x + daysOf(c.start, c.end), 0);
      const weights = [...cts.map((c) => daysOf(c.start, c.end)), Math.max(0, daysOf(ps, pe) - covered)];
      const totals = new Map<string, number>();
      for (const p of lrPostings) if (p.date >= ps && p.date <= pe) totals.set(p.ledger, (totals.get(p.ledger) ?? 0) + profitOf(p));
      for (const [code, total] of totals) apportion(total, weights).forEach((x, i) => i < cts.length && addLr(cts[i]!.end, code, x));
    }
  } else {
    // Each posting as made (the ledger's own deferrals at period ends left out: its cover is spread here).
    const spans = [...inBooks.map((c) => ({ start: c.start, end: c.end })), { start: dayAfter(inBooks.at(-1)?.end ?? today), end: '9999-12-31' }];
    for (const p of lrPostings) {
      if (p.source.kind === 'deferral') continue;
      if (p.covers) coverParts(profitOf(p), p.covers, spans, first).forEach((x, i) => i < inBooks.length && addLr(inBooks[i]!.end, p.ledger, x));
      else {
        const c = inBooks.find((x) => x.start <= p.date && x.end >= p.date);
        if (c) addLr(c.end, p.ledger, profitOf(p));
      }
    }
  }

  // Plant: the register's tangible assets bought in these books (those brought in on opening journals
  // are in the pools brought forward; cars and intangibles are not worked out), and small equipment.
  const plant: PlantItem[] = [];
  /** Brought in, not bought in these books: on an opening journal of books taken over mid-life, whatever its day (in the pools brought forward). */
  const broughtIn = (a: FixedAsset) => Boolean(a.broughtIn || (books.ledgerFrom && a.opening));
  for (const a of ledger.assets) {
    if (broughtIn(a) || a.class === 'intangible' || a.class === 'motor') continue;
    plant.push({ id: a.id, memo: a.memo, class: a.class, pool: a.tax?.pool ?? 'main', acquired: a.acquired, cost: a.cost, connected: Boolean(a.tax?.connected), ...(a.tax?.marketValue !== undefined ? { marketValue: a.tax.marketValue } : {}), used: Boolean(a.tax?.used), ...(a.tax?.allowance ? { allowance: a.tax.allowance } : {}), smallEquipment: false });
  }
  const smallCredits: LedgerPosting[] = [];
  for (const p of pl) {
    if (p.ledger !== 'small-equipment') continue;
    if (p.amount > 0) plant.push({ id: p.id, memo: p.memo, class: 'small-equipment', pool: 'main', acquired: p.date, cost: p.amount, connected: false, used: false, smallEquipment: true });
    else smallCredits.push(p);
  }
  plant.sort((a, b) => a.acquired.localeCompare(b.acquired) || a.id.localeCompare(b.id));
  /** The day plant counts from for capital allowances: the trade's first day for plant bought before it (CAA 2001 s12). */
  const incurredOf = (item: { acquired: ISODate }) => (trade && item.acquired < trade ? trade : item.acquired);
  const assetById = new Map(ledger.assets.map((a) => [a.id, a]));

  const carried: Carried = {
    preTrading: bf?.preTradingExpenditure ? toMinor(bf.preTradingExpenditure) : 0,
    releasing: false,
    losses: [...(bf?.tradingLossesBefore2017 ? [{ amount: toMinor(bf.tradingLossesBefore2017), flexible: false }] : []), ...(bf?.tradingLosses ? [{ amount: toMinor(bf.tradingLosses), flexible: true }] : [])],
    nonTradingDeficits: bf?.nonTradingDeficits ? toMinor(bf.nonTradingDeficits) : 0,
    oldDeficits: bf?.nonTradingDeficitsBefore2017 ? toMinor(bf.nonTradingDeficitsBefore2017) : 0,
    mainPool: bf?.mainPool ? toMinor(bf.mainPool) : 0,
    specialPool: bf?.specialPool ? toMinor(bf.specialPool) : 0,
    relieved: new Map(),
  };

  const views: CtComputationView[] = [];
  const rows: CtPeriodRow[] = [];
  let prevEnd: ISODate | undefined;
  let firstInBooks = true;
  for (const c of periods) {
    const row = periodRow(c, books, today, trade);
    if (c.start < first) {
      rows.push({ ...row, status: row.status === 'filed' || row.status === 'filed-late' ? row.status : 'before-books', payable: null });
      prevEnd = c.end;
      continue;
    }
    const view = computePeriod(c, row, prevEnd && prevEnd >= first ? dayAfter(prevEnd) : first, firstInBooks);
    firstInBooks = false;
    prevEnd = c.end;
    // An earlier period not ready (and with no CT600 filed) may still change what this one brings in.
    const earlier = views.find((v) => !v.ready && !v.period.ct600);
    if (earlier) view.checks.push({ kind: 'earlier-not-ready', end: earlier.period.end });
    finish(view);
    views.push(view);
    rows.push(view.period);
  }

  function finish(view: CtComputationView) {
    view.ready = view.checks.length === 0;
    const p = view.period;
    p.payable = view.payable;
    if (p.status !== 'filed' && p.status !== 'filed-late') p.status = p.end >= today ? 'open' : view.ready ? 'ready' : 'not-ready';
    if (p.ct600?.taxPayable !== undefined && p.ct600.taxPayable !== view.payable) p.differs = true;
    if (view.ready && view.payable === 0 && !p.payment && p.ct600?.taxPayable !== 0) p.offerNothingToPay = true;
  }

  function computePeriod(c: CtPeriod, row: CtPeriodRow, windowStart: ISODate, isFirst: boolean): CtComputationView {
    const s = carried;
    const checks: CtCheck[] = [];
    const notes: CtNote[] = [];
    const unsupported = (what: string) => checks.push({ kind: 'unsupported', what });
    const phase: 'pre-trading' | 'trading' = trading(c.start) ? 'trading' : 'pre-trading';
    const days = daysOf(c.start, c.end);
    if (c.end >= today) checks.push({ kind: 'not-ended', end: c.end });
    if (isFirst && books!.ledgerFrom && !bf) checks.push({ kind: 'brought-forward', ledgerFrom: books!.ledgerFrom });
    if (trade && c.start < trade && trade <= c.end) unsupported(`trade started on ${formatDate(trade)}, within this period: starting to trade ends a Corporation Tax period (CTA 2009 s10(1)(d)), so check its dates in the settings`);
    if (c.start < c.periodOfAccount.start) unsupported('the period runs over the end of a period of account: set its dates within one period of account, as HMRC’s notice gives them');
    else if (c.periodOfAccount.start < first) unsupported(`its period of account starts on ${formatDate(c.periodOfAccount.start)}, before these books (${formatDate(first)}): its profit cannot be shared out by days (CTA 2009 s52) from part of it`);
    if (isFirst && trade && trade < first && bf?.preTradingExpenditure) unsupported(`pre-trading expenditure is brought forward, but the trade started on ${formatDate(trade)}, before these books: it was relieved on that day (CTA 2009 s61)`);

    // The accounts of its period of account must be ready: the profit shared out comes from them.
    const accounts = accountsOf(c.periodOfAccount.end);
    if (!accounts || !accounts.ready) checks.push({ kind: 'accounts-not-ready', periodOfAccount: c.periodOfAccount, checks: accounts?.checks.length ?? 0, ended: c.periodOfAccount.end < today });

    // ── The accounts' profit for the period, and the adjustments ──
    const lineMap = new Map<string, CtAccountsLine>();
    const addLine = (code: string, amount: number, basis: CtAccountsLine['basis']) => {
      if (!amount) return;
      const key = `${code}|${basis}`;
      const l = lineMap.get(key) ?? lineMap.set(key, { ledger: code, name: name(code), amount: 0, basis, treatment: treatmentOf(code)! }).get(key)!;
      l.amount += amount;
    };
    const parts = apportioned.get(c.end) ?? new Map<string, number>();
    for (const [code, amount] of parts) if (code !== PRE_TRADING) addLine(code, amount, 'days');
    const dated = pl.filter((p) => byDate(p) && p.date >= windowStart && p.date <= c.end);
    for (const p of dated) if (p.date >= c.start) addLine(p.ledger, profitOf(p), 'date');
    const lr = lrParts.get(c.end) ?? new Map<string, number>();
    for (const [code, amount] of lr) addLine(code, amount, basis === 'time' ? 'days' : 'accrued');
    // Opening journals of books taken over mid-life are balances brought in, dated before the books start.
    for (const a of ledger.assets) if (books!.ledgerFrom && a.opening && a.acquired >= first && a.acquired >= c.start && a.acquired <= c.end) checks.push({ kind: 'opening-journal', date: a.acquired, ledgerFrom: books!.ledgerFrom });
    // Income or interest paid in no CT period (before it came within the charge): taxed nowhere, so the day it came within it is wrong.
    for (const p of pl) {
      const t = treatmentOf(p.ledger);
      if (p.date < windowStart || p.date >= c.start) continue;
      if (t === 'non-trading-income' || t === 'loan-relationship' || t === 'trading-income') checks.push({ kind: 'income-before-charge', amount: profitOf(p), from: c.start, ledger: p.ledger });
    }
    const lines = [...lineMap.values()].filter((l) => l.amount).sort((a, b) => chartIndex(a.ledger) - chartIndex(b.ledger) || a.basis.localeCompare(b.basis));
    const accountsProfit = lines.reduce((x, l) => x + l.amount, 0);

    const adjustments: CtAdjustment[] = [];
    let salesBefore = 0;
    for (const l of lines) {
      const out = (kind: CtAdjustment['kind'], why: string) => adjustments.push({ kind, ledger: l.ledger, label: l.name, amount: -l.amount, why });
      switch (l.treatment) {
        case 'disallowable':
          out('disallowable', DISALLOWED_WHY[l.ledger] ?? 'Not deductible for Corporation Tax.');
          break;
        case 'capital':
          out('capital', CAPITAL_WHY[l.ledger] ?? 'Capital, not revenue (CTA 2009 s53).');
          break;
        case 'non-trading-income':
          out('non-trading', 'Interest received is a credit of a non-trading loan relationship (CTA 2009 s301): non-trading profits (below), not trading income.');
          break;
        case 'loan-relationship':
          if (phase === 'pre-trading') out('non-trading', 'Interest paid before the trade started is a non-trading loan relationship debit (CTA 2009 s301), not pre-trading expenditure (s61(3)); an election within 2 years after the period can treat it as a trading debit of the period the trade starts in (s330), not worked out here.');
          break;
        case 'trading-income':
          if (phase === 'pre-trading') {
            salesBefore += l.amount;
            out('pre-trading', 'Sales before the trade started: check the day it started.');
          }
          break;
        case 'allowable':
          if (phase === 'pre-trading') out('pre-trading', `Before the trade started: pre-trading expenditure, treated as incurred on its first day when within ${PRE_TRADING_YEARS} years before it (CTA 2009 s61).`);
          break;
      }
    }
    if (salesBefore) checks.push({ kind: 'sales-before-trade', amount: salesBefore });

    // Pre-trading expenses by date (the window reaches back over days in no CT period, before it came within the charge).
    const preTradingItems: CtComputationView['preTrading']['items'] = [];
    for (const p of dated) {
      if (treatmentOf(p.ledger) === 'allowable' && !trading(p.date)) preTradingItems.push({ date: p.date, memo: p.date < c.start ? `${p.memo} (before it came within the charge)` : p.memo, ledger: p.ledger, amount: p.amount });
    }
    // Loan relationships: interest received is a non-trading credit; interest paid a non-trading debit before the trade starts (a trading one after, s297).
    const ntItems: CtComputationView['nonTrading']['items'] = [];
    let ntCredits = 0;
    let ntDebits = 0;
    for (const [code, amount] of lr) {
      const t = treatmentOf(code);
      if (t === 'non-trading-income') ntCredits += amount;
      else if (phase === 'pre-trading') ntDebits -= amount;
      else continue;
      ntItems.push({ date: c.end, memo: basis === 'time' ? 'Shared out from the period of account by days (CTA 2009 s307(2A))' : 'As accrued to the period (CTA 2009 s307(2C))', ledger: code, amount });
    }

    // ── Pre-trading expenditure: gathered until the trade starts, released on its first day ──
    const preBroughtForward = s.preTrading;
    const preAdded = preTradingItems.reduce((x, i) => x + i.amount, 0);
    s.preTrading += preAdded;
    let released = 0;
    let lapsed = 0;
    const share = -(parts.get(PRE_TRADING) ?? 0);
    if (phase === 'trading' && (share || (!s.releasing && s.preTrading && tradePoa?.end === c.periodOfAccount.end))) {
      if (!s.releasing) {
        lapsed = s.preTrading - releasable;
        s.preTrading = releasable;
        s.releasing = true;
        if (lapsed) notes.push({ level: 'info', text: `${money(lapsed)} of expenses was incurred more than ${PRE_TRADING_YEARS} years before the trade started: it gets no relief (CTA 2009 s61(1)(b)).` });
        if (bf?.preTradingExpenditure) notes.push({ level: 'info', text: `Pre-trading expenditure brought forward from before these books is taken as incurred within ${PRE_TRADING_YEARS} years before the trade started (CTA 2009 s61(1)(b)).` });
      }
      released = share;
      s.preTrading -= released;
      if (released) adjustments.push({ kind: 'pre-trading-released', label: 'Pre-trading expenditure, treated as incurred on the first day of trading', amount: -released, why: `Expenses incurred within ${PRE_TRADING_YEARS} years before the trade started that would have been deductible are treated as incurred on the day it started (CTA 2009 s61(2)), and shared by days with any other period of the same period of account (s52).` });
    }
    const beforeAllowances = accountsProfit + adjustments.reduce((x, a) => x + a.amount, 0);

    // ── Capital allowances ──
    const ca = capitalAllowances(c, phase, s, checks, notes);
    const tradingResult = phase === 'trading' ? beforeAllowances - ca.net : 0;

    // Cars, intangible assets and chargeable gains are not worked out here: a period that has one says so.
    const held = (a: FixedAsset) => a.acquired <= c.end && !(a.disposedOn && a.disposedOn < c.start);
    if (ledger.assets.some((a) => a.class === 'motor' && held(a))) unsupported('a car: capital allowances on cars (CAA 2001 Part 2, the CO2 emissions tests) are not worked out here');
    if (ledger.assets.some((a) => a.class === 'intangible' && held(a))) unsupported('an intangible asset: the intangible fixed assets regime (CTA 2009 Part 8) is not worked out here, and its amortisation would be added back as if it were depreciation');
    if (ledger.postings.some((p) => p.ledger === 'investments' && p.amount < 0 && p.date >= c.start && p.date <= c.end)) unsupported('investments sold or reduced: chargeable gains (TCGA 1992; CT600 boxes 210 to 220) are not worked out here');

    // ── Non-trading loan relationships ──
    const ntNet = ntCredits - ntDebits;
    const ntProfits = Math.max(0, ntNet);
    const ntArising = Math.max(0, -ntNet);
    // Deficits of periods before 1 April 2017: against non-trading profits only (CTA 2009 s457; box 230).
    const oldBroughtForward = s.oldDeficits;
    const oldUsed = Math.min(oldBroughtForward, ntProfits);
    s.oldDeficits -= oldUsed;
    if (oldUsed) notes.push({ level: 'info', text: 'Non-trading deficits of periods before 1 April 2017 are set against non-trading profits only (CTA 2009 s457; box 230).' });
    if (ntArising) notes.push({ level: 'info', text: `A non-trading loan relationship deficit of ${money(ntArising)} arises (CTA 2009 s301): it is carried forward here (s463G). The company may instead claim to set it against this period’s other profits, or carry it back (s459, within 2 years after the period, s460).` });

    // ── Trading losses, and deductions against total profits ──
    const tradingProfit = Math.max(0, tradingResult);
    const arising = Math.max(0, -tradingResult);
    const lossesBroughtForward = s.losses.reduce((x, l) => x + l.amount, 0);
    const ntBroughtForward = s.nonTradingDeficits;
    // Losses of periods beginning before 1 April 2017: against the same trade's profits, automatically (CTA 2010 s45).
    let againstTrading = 0;
    let roomTrading = tradingProfit;
    for (const l of s.losses.filter((x) => !x.flexible)) {
      const use = Math.min(l.amount, roomTrading);
      l.amount -= use;
      roomTrading -= use;
      againstTrading += use;
    }
    const totalProfits = tradingProfit - againstTrading + ntProfits - oldUsed;
    // Then, against total profits by claim, as far as they go: trading losses from 1 April 2017 (s45A),
    // then non-trading deficits carried forward (CTA 2009 s463G).
    let room = totalProfits;
    let againstTotal = 0;
    for (const l of s.losses.filter((x) => x.flexible)) {
      const use = Math.min(l.amount, room);
      l.amount -= use;
      room -= use;
      againstTotal += use;
    }
    const deficitsUsed = Math.min(ntBroughtForward, room);
    room -= deficitsUsed;
    s.losses = s.losses.filter((l) => l.amount > 0);
    s.nonTradingDeficits = ntBroughtForward - deficitsUsed + ntArising;
    if (arising) {
      const flexible = c.start >= FLEXIBLE_LOSSES_FROM;
      if (!flexible && c.end >= FLEXIBLE_LOSSES_FROM) unsupported('a trading loss in a period running over 1 April 2017: its parts are carried forward under different rules (CTA 2010 s45 and s45A)');
      s.losses.push({ amount: arising, flexible });
      // A loss may be carried back only to a period in which the company carried on the trade (s37(6)).
      const back = trade && trade < c.start ? (addYears(c.start, -1) >= trade ? 'and then carried back against the total profits of the previous 12 months' : `and then carried back against the total profits of the months since the trade started (${formatDate(trade)}), not before it`) : 'but not carried back: the company did not carry on the trade before this period (s37(6)), so pre-trading interest stays taxed';
      notes.push({ level: 'info', text: `A trading loss of ${money(arising)} is carried forward to later periods (CTA 2010 ${flexible ? 's45A' : 's45'}). The company may instead claim to set it against this period’s total profits, interest included (s37(3)(a)), ${back} (s37(3)(b)), within two years after the period ends: not worked out here.` });
    }
    if (againstTotal) notes.push({ level: 'info', text: 'Trading losses carried forward are claimed against total profits as far as they go (CTA 2010 s45A(4), a claim: the company may claim less, or none).' });
    if (deficitsUsed) notes.push({ level: 'info', text: 'Non-trading deficits carried forward are claimed against total profits as far as they go (CTA 2009 s463G, a claim within 2 years after the period: the company may claim less).' });
    if (againstTrading + againstTotal + deficitsUsed + oldUsed) notes.push({ level: 'warn', text: `Carried-forward losses and deficits used are within the company’s deductions allowance (up to £${LOSS_DEDUCTIONS_ALLOWANCE.toLocaleString('en-GB')} a year, CTA 2010 s269ZR and s269ZW), which it must specify in its return (s269ZB, s269ZD): otherwise the allowance is nil and only half the profits can be relieved. Show the allowance used in the computation you file.` });
    if (againstTrading + againstTotal + deficitsUsed + oldUsed > forPeriod(toMinor(LOSS_DEDUCTIONS_ALLOWANCE), c.start, c.end)) unsupported(`carried-forward losses of more than the deductions allowance: the restriction of CTA 2010 Part 7ZA is not worked out here`);
    const chargeableExact = totalProfits - againstTotal - deficitsUsed;

    // ── The profit boxes, in whole pounds, and the tax on box 315 ──
    const turnover = phase === 'trading' ? lines.filter((l) => l.treatment === 'trading-income').reduce((x, l) => x + l.amount, 0) : null;
    const figures: ProfitFigures = { turnover, tradingProfit: phase === 'trading' ? tradingProfit : null, lossesAgainstTrading: againstTrading, nonTradingProfits: ntProfits, deficitsAgainstNonTrading: oldUsed, lossesAgainstTotal: againstTotal, deficitsAgainstTotal: deficitsUsed };
    const chargeableWhole = profitBoxes(figures).b315;
    const assoc = books!.associatedCompanies?.find((a) => a.periodEnd === c.end);
    const associated = assoc?.count ?? 0;
    const byYear = [associated, assoc?.secondYear ?? associated];
    const cihc = books!.closeInvestmentHolding ?? null;
    const tax = taxOnProfits({ start: c.start, end: c.end, profit: chargeableWhole, associated: byYear, closeInvestmentHolding: cihc === true });
    if (tax.unsupported) unsupported(tax.unsupported);
    const atRates = tax.parts.reduce((x, p) => x + p.tax, 0);
    const relief = tax.parts.reduce((x, p) => x + p.marginalRelief, 0);
    const chargeable = atRates - relief;
    // Small profits rates apply in some financial year of the period (from FY 2023).
    const tiered = [financialYearOf(c.start), financialYearOf(c.end)].some((fy) => ctRatesFor(fy)?.small !== undefined);
    if (tiered && cihc === null && phase === 'pre-trading' && chargeableWhole > 0) checks.push({ kind: 'close-investment-holding' });
    if (tiered && !assoc) notes.push({ level: 'info', text: `No associated companies are said for this period: taken as none. ${ASSOCIATED_TEST} Say how many in Settings.` });
    if (tiered && cihc === null && phase === 'trading') notes.push({ level: 'info', text: `Not said whether it is a close investment-holding company: taken as not one, as it trades. ${CIHC_TEST} Say so in Settings if that changes.` });
    if (tiered) notes.push({ level: 'info', text: 'Augmented profits are taken as the profits chargeable: exempt distributions it receives from companies outside its 51% group, which would count towards them (CTA 2010 s18L), are not tracked.' });
    if (phase === 'pre-trading' && ntCredits && s.preTrading) notes.push({ level: 'info', text: 'Pre-trading expenditure is not set against the interest: it waits for the trade to start (CTA 2009 s61). It is not management expenses either (s1219): a company holding cash on deposit until it is used in a trade it intends to carry on is not normally a company with investment business (s1218B; HMRC’s CTM08070).' });

    // ── What else to know ──
    const s455 = s455Of(c);
    if (s455) notes.push({ level: 'warn', text: `At the period’s end you owed the company ${money(s455.owedAtEnd)} on your director’s loan, ${money(s455.outstanding)} of it lent in this period: tax under CTA 2010 s455 of ${money(s455.charge)} is due on that (at the rate for the tax year each part was lent), less relief for what is repaid by ${formatDate(s455.due)} (s458): ${money(s455.relief)} repaid so far, so ${money(s455.tax)}${s455.provisional ? ', so far' : ''}. It goes in box 480 (from the CT600A, which the return needs while a loan to a participator is outstanding at the period’s end) and is paid with the Corporation Tax. Matching repayments to loans oldest first; the rules on borrowing again (s464C, s464ZA) are not worked out.` });
    if (phase === 'trading' && lines.some((l) => l.treatment === 'loan-relationship')) notes.push({ level: 'info', text: 'Interest paid is taken as a trading loan relationship debit, a deduction from the trading profit (CTA 2009 s297): if the borrowing was not for the trade, it is non-trading (s301) instead.' });
    if (lines.some((l) => l.ledger === 'donations')) notes.push({ level: 'info', text: 'Qualifying charitable donations (CTA 2010 Part 6, CT600 box 305) are not worked out: a donation is only added back here.' });

    const settings = { associatedCompanies: associated, associatedByYear: tax.parts.length > 1 ? byYear : [associated], associatedSaid: Boolean(assoc), aiaAllocated: books!.aiaAllocated?.find((a) => a.periodEnd === c.end)?.amount ?? null, closeInvestmentHolding: cihc };
    const view: CtComputationView = {
      period: { ...row },
      days,
      accounts: { lines, profit: accountsProfit },
      adjustments,
      beforeAllowances,
      capitalAllowances: ca,
      tradingResult,
      preTrading: { broughtForward: preBroughtForward, added: preAdded, released, lapsed, carriedForward: s.preTrading, items: preTradingItems },
      nonTrading: { credits: ntCredits, debits: ntDebits, net: ntNet, items: ntItems },
      losses: {
        trading: { broughtForward: lossesBroughtForward, usedAgainstTrading: againstTrading, usedAgainstTotal: againstTotal, arising, carriedForward: s.losses.reduce((x, l) => x + l.amount, 0) },
        nonTrading: { broughtForward: ntBroughtForward, used: deficitsUsed, arising: ntArising, carriedForward: s.nonTradingDeficits },
      },
      totalProfits,
      chargeable: { exact: chargeableExact, whole: chargeableWhole },
      tax: { parts: tax.parts, atRates, marginalRelief: relief, chargeable },
      payable: chargeable + (s455?.tax ?? 0),
      ...(s455 ? { s455 } : {}),
      carriedForward: { preTrading: s.preTrading, tradingLosses: s.losses.reduce((x, l) => x + l.amount, 0), nonTradingDeficits: s.nonTradingDeficits, mainPool: s.mainPool, specialPool: s.specialPool },
      settings,
      boxes: [],
      checks,
      notes,
      ready: false,
    };
    view.boxes = ct600Boxes(view, company, figures);
    return view;
  }

  /**
   * A period's capital allowances (CAA 2001 Part 2; FORMULAS.md §22, "Capital allowances"), moving the
   * pools in `s` on: plant counting from its day (the trade's first day for plant bought before it, s12),
   * the owner's choices, then the annual investment allowance (special rate expenditure before main
   * rate, then by day), then full expensing or the 50% first-year allowance on what is left where it is
   * available, the rest to its pool; disposal values out of the pools (or, for plant that had a
   * first-year allowance, a balancing charge); then writing-down allowances, or a small pool written off.
   * Nothing before the trade starts.
   */
  function capitalAllowances(c: CtPeriod, phase: 'pre-trading' | 'trading', s: Carried, checks: CtCheck[], notes: CtNote[]): CtCapitalAllowances {
    const unsupported = (what: string) => checks.push({ kind: 'unsupported', what });
    const annual = ruleOn(AIA_LIMITS, c.start).limit;
    const allocatedRow = books!.aiaAllocated?.find((a) => a.periodEnd === c.end);
    const ownLimit = forPeriod(annual * 100, c.start, c.end);
    const limit = allocatedRow ? Math.min(ownLimit, toMinor(allocatedRow.amount)) : ownLimit;
    const rowOf = (item: PlantItem, incurred: ISODate): CtAssetRow => {
      const capped = item.connected ? Math.min(item.cost, item.marketValue ?? item.cost) : item.cost;
      const a = assetById.get(item.id);
      // A refund on its cost by the end of the period it counts in reduces what qualifies.
      const qualifying = a ? Math.min(capped, costOn(a, c.end)) : capped;
      const rowNotes: string[] = [];
      if (item.acquired < incurred) rowNotes.push(`Bought before the trade started (${formatDate(item.acquired)}): treated as incurred on its first day (CAA 2001 s12).`);
      if (item.connected) rowNotes.push(item.marketValue === undefined ? 'Bought from a connected person: its qualifying expenditure is capped at the seller’s disposal value, or the smallest of its market value and the seller’s (or a connected person’s) own cost (CAA 2001 s218). Its cost is used: confirm its market value on the asset.' : 'Bought from a connected person: its qualifying expenditure is capped at its market value (CAA 2001 s218); check it is no more than the seller’s disposal value or own cost.');
      if (item.smallEquipment) rowNotes.push('Expensed in the accounts as small equipment: capital for tax (CTA 2009 s53), so it takes allowances as plant in the main pool, never a first-year allowance (that needs it new and unused, which the books do not say).');
      if (a && a.reductions.some((r) => r.date > c.end)) rowNotes.push('Its cost was reduced after this period: not worked out here (the reduction is not brought in as a disposal value).');
      return { id: item.id, memo: item.memo, class: item.class, pool: item.pool, acquired: item.acquired, incurred, cost: item.cost, qualifying, treatment: 'pool', aia: 0, firstYear: 0, toPool: qualifying, ...(item.smallEquipment ? { smallEquipment: true as const } : {}), ...(item.connected ? { connected: true as const } : {}), notes: rowNotes };
    };
    if (phase === 'pre-trading') {
      const deferred = plant.filter((i) => i.acquired <= c.end).map((i) => rowOf(i, trade && trade > i.acquired ? trade : i.acquired));
      for (const r of deferred) if (!r.notes.length || !trade) r.notes.unshift('Bought before the trade started: it counts from its first day (CAA 2001 s12).');
      return { aiaLimit: { annual, period: limit, allocated: Boolean(allocatedRow), used: 0 }, assets: [], disposals: disposalsOf(c, s, checks, notes, true), pools: [], aia: 0, firstYear: 0, wda: 0, balancingCharges: 0, net: 0, deferred };
    }
    if (allocatedRow && toMinor(allocatedRow.amount) > ownLimit) notes.push({ level: 'warn', text: `The annual investment allowance allocated to this period (${money(toMinor(allocatedRow.amount))}) is more than its own limit (${money(ownLimit)}): the limit is used.` });
    if (c.start < AIA_LIMITS[0]!.from) unsupported(`a period before ${formatDate(AIA_LIMITS[0]!.from)}: capital allowances before then are not covered here`);
    else if (ruleOn(AIA_LIMITS, c.start) !== ruleOn(AIA_LIMITS, c.end)) unsupported('the period runs over a change in the annual investment allowance limit: its transitional rules are not worked out here');

    // Plant counting in this period, in day order; money back on small equipment nets against it first.
    const items = plant.filter((i) => {
      const d = incurredOf(i);
      return d >= c.start && d <= c.end;
    });
    const assets = items.map((i) => rowOf(i, incurredOf(i)));
    // Money back counts on the day it came, or on the trade's first day when before it (as the equipment does, s12).
    let smallBack = smallCredits.filter((p) => incurredOf({ acquired: p.date }) >= c.start && incurredOf({ acquired: p.date }) <= c.end).reduce((x, p) => x - p.amount, 0);
    for (const r of [...assets].reverse()) {
      if (!r.smallEquipment || !smallBack) continue;
      const take = Math.min(smallBack, r.qualifying);
      r.qualifying -= take;
      r.toPool = r.qualifying;
      smallBack -= take;
      r.notes.push('Money back on small equipment in the same period reduces what qualifies.');
    }
    const fyaRow = FIRST_YEAR_ALLOWANCES.filter((f) => f.from <= c.end).at(-1);
    const byId = new Map(items.map((i) => [i.id, i]));
    const fyaEligible = (r: CtAssetRow) => {
      const i = byId.get(r.id)!;
      return fyaRow !== undefined && r.incurred >= fyaRow.from && !i.connected && !i.used && !i.smallEquipment;
    };
    let room = limit;
    const takeAia = (r: CtAssetRow) => {
      const take = Math.min(room, r.qualifying - r.aia - r.firstYear);
      if (take <= 0) return;
      r.aia += take;
      room -= take;
      r.treatment = 'aia';
    };
    const takeFya = (r: CtAssetRow) => {
      const rest = r.qualifying - r.aia;
      if (rest <= 0 || !fyaRow) return;
      r.firstYear = mulDivRound(rest, r.pool === 'special' ? fyaRow.special : fyaRow.main, 100);
      r.treatment = r.pool === 'special' ? 'fya-50' : 'full-expensing';
      r.notes.push(r.pool === 'special' ? 'The 50% first-year allowance on special rate expenditure (CAA 2001 s45S): the other half goes to the special rate pool. Taken as unused and not second-hand: say on the asset if it was.' : 'Full expensing, a 100% first-year allowance on main rate plant (CAA 2001 s45S). Taken as unused and not second-hand: say on the asset if it was.');
    };
    const choice = (r: CtAssetRow) => byId.get(r.id)!.allowance;
    // The owner's choices first: none (the pool only), the first-year allowance, the annual investment allowance.
    for (const r of assets.filter((x) => choice(x) === 'none')) r.notes.push('You chose writing-down allowances only for it.');
    for (const r of assets.filter((x) => choice(x) === 'first-year')) {
      if (fyaEligible(r)) takeFya(r);
      else r.notes.push(`A first-year allowance is not available for it${fyaRow && r.incurred >= fyaRow.from ? '' : ` (only for expenditure from ${formatDate(FIRST_YEAR_ALLOWANCES[0]!.from)})`}: it goes to its pool.`);
    }
    for (const r of assets.filter((x) => choice(x) === 'aia')) {
      if (byId.get(r.id)!.connected) r.notes.push('You chose the annual investment allowance, but there is none on plant bought from a connected person (CAA 2001 s217): it goes to its pool. (New plant the seller sells in the ordinary course of its business is excepted, s230: not worked out here.)');
      else takeAia(r);
    }
    // Then the default: the annual investment allowance, special rate expenditure first, then by day.
    const defaults = assets.filter((x) => choice(x) === undefined);
    for (const r of [...defaults.filter((x) => x.pool === 'special'), ...defaults.filter((x) => x.pool === 'main')]) {
      if (byId.get(r.id)!.connected) r.notes.push('No annual investment allowance or first-year allowance on plant bought from a connected person (CAA 2001 s217): it goes to its pool. (New plant the seller sells in the ordinary course of its business is excepted, s230: not worked out here.)');
      else takeAia(r);
    }
    // What the annual investment allowance did not cover: full expensing or 50% where available.
    for (const r of [...assets.filter((x) => choice(x) === 'aia'), ...defaults]) if (r.qualifying - r.aia > 0 && fyaEligible(r)) takeFya(r);
    for (const r of assets) {
      r.toPool = r.qualifying - r.aia - r.firstYear;
      if (r.treatment === 'aia') r.notes.unshift('The annual investment allowance (CAA 2001 s51A).');
      s.relieved.set(r.id, { treatment: r.treatment, pool: r.pool, qualifying: r.qualifying, firstYearPart: r.firstYear ? r.qualifying - r.aia : 0 });
    }
    if (smallBack) notes.push({ level: 'info', text: `Money back on small equipment (${money(smallBack)}) with none bought in the period to set it against is deducted from the main pool as a disposal value.` });

    // Disposals in the period: disposal values out of the pools, first-year plant's as balancing charges.
    const disposals = disposalsOf(c, s, checks, notes, false);
    const smallLimit = forPeriod(ruleOn(SMALL_POOLS_LIMIT, c.start).limit * 100, c.start, c.end);
    const pools: CtPoolView[] = [];
    let balancingCharges = disposals.reduce((x, d) => x + d.balancingCharge, 0);
    let wda = 0;
    for (const pool of ['main', 'special'] as const) {
      const broughtForward = pool === 'main' ? s.mainPool : s.specialPool;
      const additions = assets.filter((r) => r.pool === pool).reduce((x, r) => x + r.toPool, 0);
      const out = disposals.filter((d) => d.pool === pool).reduce((x, d) => x + d.fromPool, 0) + (pool === 'main' ? smallBack : 0);
      const balance = broughtForward + additions - out;
      const charge = Math.max(0, -balance);
      // What is left of expenditure that had the 50% allowance joins the pool after this period's writing-down allowance (CAA 2001 s58).
      const afterAllowance = assets.filter((r) => r.pool === pool && r.treatment === 'fya-50').reduce((x, r) => x + r.toPool, 0);
      const base = Math.max(0, balance - afterAllowance);
      const rate = wdaRateHundredths(WDA_RATES, pool, c.start, c.end);
      const small = base > 0 && base <= smallLimit;
      const allowance = small ? base : writingDown(base, rate, c.start, c.end);
      wda += allowance;
      balancingCharges += charge;
      const carriedForward = Math.max(0, balance) - allowance;
      if (pool === 'main') s.mainPool = carriedForward;
      else s.specialPool = carriedForward;
      if (broughtForward || additions || out) pools.push({ pool, broughtForward, additions, disposals: out, available: balance, afterAllowance, balancingCharge: charge, wda: allowance, rate: rate / 100, smallPool: small, carriedForward });
      const change = wdaChange(WDA_RATES, pool, c.start, c.end);
      if (base && !small && change) notes.push({ level: 'info', text: `The ${pool === 'main' ? 'main' : 'special rate'} pool’s writing-down allowance is at ${rate / 100}%: the period runs over ${formatDate(change.from)}, when the rate went from ${change.before}% to ${change.after}%, so it takes the days before and after it (${pool === 'main' ? 'FA 2026 s28' : 'FA 2019 s31'}), rounded up to two decimal places.` });
    }
    const smallYearly = ruleOn(SMALL_POOLS_LIMIT, c.start).limit;
    if (pools.some((p) => p.smallPool)) notes.push({ level: 'info', text: `A pool of ${money(smallLimit)} or less${isYear(c.start, c.end) ? '' : ` (the £${smallYearly.toLocaleString('en-GB')} limit, proportionately reduced for a period shorter than a year)`} is written off in full by the small pools allowance (CAA 2001 s56A), a claim the company may choose not to make.` });
    if (pools.some((p) => p.afterAllowance)) notes.push({ level: 'info', text: 'What is left of expenditure that had the 50% first-year allowance joins the special rate pool after this period’s writing-down allowance, which it first takes next period (CAA 2001 s58).' });
    const aia = assets.reduce((x, r) => x + r.aia, 0);
    const firstYear = assets.reduce((x, r) => x + r.firstYear, 0);
    return { aiaLimit: { annual, period: limit, allocated: Boolean(allocatedRow), used: aia }, assets, disposals, pools, aia, firstYear, wda, balancingCharges, net: aia + firstYear + wda - balancingCharges, deferred: [] };
  }

  /**
   * The assets that left in a period, with their disposal values (CAA 2001 s61): what each fetched, as
   * it says, or as coded to profit or loss on disposal in the period when it alone left then; at most its
   * qualifying expenditure (s62). Out of its pool, but for plant that had a first-year allowance: the
   * part of its disposal value relieved by full expensing is a balancing charge (s59A), half the part
   * relieved by the 50% allowance (s59B), the rest out of the pool. Before the trade started: listed,
   * with nothing brought in (it never counted, s12).
   */
  function disposalsOf(c: CtPeriod, s: Carried, checks: CtCheck[], notes: CtNote[], preTrading: boolean): CtDisposalRow[] {
    const leaving = ledger.assets.filter((a) => a.disposedOn && a.disposedOn >= c.start && a.disposedOn <= c.end && a.class !== 'intangible' && a.class !== 'motor');
    if (!leaving.length) return [];
    // What was coded to profit or loss on disposal in the period (net of VAT, from rows and journals).
    const coded = ledger.postings.filter((p) => p.ledger === 'disposals' && p.source.kind !== 'disposal' && p.date >= c.start && p.date <= c.end).reduce((x, p) => x - p.amount, 0);
    const said = leaving.reduce((x, a) => x + (a.tax?.proceeds ?? 0), 0);
    const unsaid = leaving.filter((a) => a.tax?.proceeds === undefined);
    if (unsaid.length > 1) checks.push({ kind: 'disposal-proceeds', count: unsaid.length, amount: Math.max(0, coded - said) });
    const out: CtDisposalRow[] = [];
    for (const a of leaving) {
      const rowNotes: string[] = [];
      const proceeds = a.tax?.proceeds ?? (unsaid.length === 1 ? Math.max(0, coded - said) : 0);
      if (a.tax?.proceeds === undefined && unsaid.length === 1) rowNotes.push('What it fetched is what was coded to profit or loss on disposal in the period, less what the other assets leaving say they fetched.');
      if (preTrading || (trade !== undefined && a.disposedOn! < trade) || trade === undefined) {
        out.push({ id: a.id, memo: a.memo, date: a.disposedOn!, proceeds, disposalValue: 0, treatment: 'pool', pool: a.tax?.pool ?? 'main', fromPool: 0, balancingCharge: 0, notes: [...rowNotes, 'It left before the trade started, so it never counted for capital allowances (CAA 2001 s12).'] });
        continue;
      }
      const relieved = s.relieved.get(a.id);
      const pool = relieved?.pool ?? a.tax?.pool ?? 'main';
      const qualifying = relieved?.qualifying ?? a.cost;
      if (broughtIn(a)) rowNotes.push('Brought in on an opening journal: in the pool brought forward. Its disposal value is capped at its cost as the register holds it (its carrying amount then); its original cost may be higher (CAA 2001 s62).');
      const disposalValue = Math.min(proceeds, qualifying);
      if (proceeds > qualifying) rowNotes.push('It fetched more than its qualifying expenditure: its disposal value is capped at that (CAA 2001 s62); the rest may be a chargeable gain, not worked out here.');
      // The relevant proportion: the expenditure relieved by the first-year allowance (halved for 50%) over its qualifying expenditure.
      const fe = relieved?.treatment === 'full-expensing';
      const half = relieved?.treatment === 'fya-50';
      const charge = relieved && relieved.firstYearPart && qualifying && (fe || half) ? mulDivRound(disposalValue, relieved.firstYearPart, qualifying * (half ? 2 : 1)) : 0;
      if (charge) rowNotes.push(fe ? 'It had full expensing: the relevant proportion of its disposal value is a balancing charge, not deducted from the pool (CAA 2001 s59A).' : 'It had the 50% first-year allowance: half the relevant proportion of its disposal value is a balancing charge, the rest comes off the special rate pool (CAA 2001 s59B).');
      out.push({ id: a.id, memo: a.memo, date: a.disposedOn!, proceeds, disposalValue, treatment: fe ? 'full-expensing' : half ? 'fya-50' : 'pool', pool, fromPool: disposalValue - charge, balancingCharge: charge, notes: rowNotes });
    }
    const leftover = coded - out.reduce((x, d) => x + d.proceeds, 0);
    if (unsaid.length <= 1 && leftover > 0) notes.push({ level: 'warn', text: `${money(leftover)} coded to profit or loss on disposal in the period is not what any asset leaving says it fetched: check what each fetched.` });
    return out;
  }

  /**
   * Tax on loans to participators for a period (CTA 2010 s455; CT600A): the director's loan's postings in
   * date order, a debit balance (you owe the company) made up of the loans that took it there, each with
   * its day, a credit repaying them oldest first. What was lent in the period and still owed at its end
   * is charged at the rate for the tax year each part was lent (`s455Rate`); repayments after the end, by
   * today and before relief runs out 9 months after it (s458), relieve it. Undefined when nothing lent in
   * the period was owed at its end.
   */
  function s455Of(c: CtPeriod): NonNullable<CtComputationView['s455']> | undefined {
    const postings = ledger.postings.filter((p) => p.ledger === 'directors-loan').sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    const lots: { date: ISODate; amount: number; repaid: number }[] = [];
    let balance = 0;
    const cutoff = monthsAfter(c.end, 9);
    const until = today < cutoff ? today : cutoff;
    type Lot = (typeof lots)[number];
    let atEnd: { owed: number; inPeriod: { lot: Lot; amount: number }[] } | undefined;
    const owedFromPeriod = () => lots.filter((l) => l.date >= c.start && l.date <= c.end && l.amount > l.repaid).map((l) => ({ lot: l, amount: l.amount - l.repaid }));
    for (const p of postings) {
      if (p.date > until) break;
      if (p.date > c.end && !atEnd) atEnd = { owed: Math.max(0, balance), inPeriod: owedFromPeriod() };
      const before = balance;
      balance += p.amount;
      if (p.amount > 0) {
        const lent = Math.max(0, balance) - Math.max(0, before);
        // A loan made after the period's end is not relieved by a later repayment of it here: only earlier lots are.
        if (lent) lots.push({ date: p.date, amount: lent, repaid: 0 });
      } else {
        let back = Math.max(0, before) - Math.max(0, balance);
        for (const l of lots) {
          const take = Math.min(back, l.amount - l.repaid);
          l.repaid += take;
          back -= take;
          if (!back) break;
        }
      }
    }
    atEnd ??= { owed: Math.max(0, balance), inPeriod: owedFromPeriod() };
    const outstanding = atEnd.inPeriod.reduce((x, l) => x + l.amount, 0);
    if (!outstanding) return undefined;
    const parts = atEnd.inPeriod.map((l) => ({ date: l.lot.date, amount: l.amount, rate: s455Rate(l.lot.date) }));
    const tax = (amount: number, rate: number) => mulDivRound(amount, Math.round(rate * 10_000), 10_000);
    const charge = parts.reduce((x, l) => x + tax(l.amount, l.rate), 0);
    // What is still owed now of each part lent in the period, after repayments since the end.
    const still = atEnd.inPeriod.map((l) => Math.min(l.amount, l.lot.amount - l.lot.repaid));
    const relief = parts.reduce((x, l, i) => x + (l.amount - still[i]!), 0);
    const reliefTax = parts.reduce((x, l, i) => x + tax(l.amount - still[i]!, l.rate), 0);
    return { owedAtEnd: atEnd.owed, outstanding, charge, relief, reliefTax, tax: charge - reliefTax, due: cutoff, provisional: today <= cutoff, parts };
  }

  // The period to work on next: the earliest ended in the books with no CT600 recorded (not one settled
  // before the books were kept here), else the earliest ended with its tax not recorded as paid, else the one running.
  const from = books.deadlinesFrom;
  const ended = views.filter((v) => v.period.end < today && !(from && v.period.returnDue < from));
  const next = ended.find((v) => !v.period.ct600) ?? ended.find((v) => !v.period.payment && !(from && v.period.paymentDue < from)) ?? views.find((v) => v.period.start <= today && v.period.end >= today);
  const shown = wanted ? views.find((v) => v.period.end === wanted) : (next ?? views.at(-1));
  if (wanted && !shown && !rows.some((r) => r.end === wanted)) return undefined;
  return {
    company: { id: company.id, name: company.name },
    periods: rows,
    ...(next ? { next: next.period.end } : {}),
    computation: shown ?? null,
    setup: { tradeStartedOn: trade ?? null, withinCharge: { from: withinChargeFrom(books) ?? null, assumed: withinChargeAssumed(books) }, closeInvestmentHolding: books.closeInvestmentHolding ?? null, ledgerFrom: books.ledgerFrom ?? null, broughtForward: Boolean(bf) },
    form: { ...CT600_FORM },
    guidance: [...CT_GUIDANCE],
    disclaimer: CT_DISCLAIMER,
  };
}

const dayAfter = (d: ISODate): ISODate => addDays(d, 1);

/** A CT period's row before its computation: its dates, due days and what is recorded for it. */
function periodRow(c: CtPeriod, books: NonNullable<Company['books']>, today: ISODate, trade: ISODate | undefined): CtPeriodRow {
  const returnDue = ct600Due(c, c.periodOfAccount);
  const ct600 = books.filings.find((f) => f.kind === 'ct600' && f.periodEnd === c.end);
  const payment = books.filings.find((f) => f.kind === 'ct-payment' && f.periodEnd === c.end);
  const filedLate = ct600 ? ct600.filedOn > returnDue : false;
  return {
    start: c.start,
    end: c.end,
    periodOfAccount: c.periodOfAccount,
    phase: trade !== undefined && c.start >= trade ? 'trading' : 'pre-trading',
    returnDue,
    paymentDue: ctPaymentDue(c.end),
    status: ct600 ? (filedLate ? 'filed-late' : 'filed') : c.end >= today ? 'open' : 'not-ready',
    payable: null,
    ...(ct600?.kind === 'ct600' ? { ct600: { filedOn: ct600.filedOn, ...(ct600.reference ? { reference: ct600.reference } : {}), ...(ct600.figures ? { taxPayable: toMinor(ct600.figures.taxPayable) } : {}) } } : {}),
    ...(payment?.kind === 'ct-payment' ? { payment: { filedOn: payment.filedOn, ...(payment.figures ? { amount: toMinor(payment.figures.amount) } : {}) } } : {}),
  };
}

/**
 * A computation as CSV: its period, the CT600 boxes as they would be entered, the working in short, and
 * the disclaimer last.
 */
export function ctComputationCsv(company: Pick<Company, 'name'>, ct: Pick<CompanyCtResponse, 'form' | 'disclaimer'> & { computation: CtComputationView }, cell: (v: string | number) => string): string {
  const v = ct.computation;
  const out = ['box,description,value,working'];
  for (const b of v.boxes) {
    const value = b.value === null ? '' : b.kind === 'money' ? fromMinor(b.value as number).toFixed(2) : b.kind === 'x' ? (b.value ? 'X' : '') : String(b.value);
    out.push([b.box, b.column ? `${b.label} (${b.column})` : b.label, value, b.working].map((x) => cell(x)).join(','));
  }
  out.push('', ['company', company.name].map(cell).join(','), ['period', `${v.period.start} to ${v.period.end}`].map(cell).join(','), ['return due', v.period.returnDue].map(cell).join(','), ['tax due', v.period.paymentDue].map(cell).join(','), ['form', ct.form.version].map(cell).join(','));
  if (!v.ready) out.push(cell(`Not ready: ${v.checks.length} check${v.checks.length === 1 ? '' : 's'} to clear (see the Corporation Tax tab).`));
  for (const n of v.notes) out.push(cell(`${n.level === 'warn' ? 'Check: ' : 'Note: '}${n.text}`));
  out.push(cell('Profits, allowances and losses are in whole pounds (to the nearest pound); tax in pounds and pence. The tax reference (box 3) is left for you to enter.'));
  out.push('', cell(ct.disclaimer));
  return out.join('\n') + '\n';
}
