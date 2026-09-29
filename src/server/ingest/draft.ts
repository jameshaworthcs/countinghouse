// Build the reviewable draft from an extraction: match each extracted account to one of yours (or
// propose a new one), categorise, flag duplicates and transfers, resolve the balance date.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { findInstitution } from '../../shared/institutions';
import { CategoryIndex } from '../../shared/categories';
import { Categoriser, isWrapperAccount, transferLegCategory } from '../../shared/categorise';
import { diffDays, today } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type {
  Account,
  AccountType,
  DateSource,
  DocumentRef,
  Draft,
  DraftFigure,
  DraftSection,
  DraftTransaction,
  Extraction,
  Holding,
  Transaction,
} from '../../shared/schema';
import { DraftSchema } from '../../shared/schema';
import type { Store } from '../store';
import { classifyDuplicates } from './dedup';
import { identifies, matchAccount, proposeAccount, sameHolding } from './match';

export interface DraftContext {
  store: Store;
  document: DocumentRef;
  hintAccountId?: string | undefined;
  uploadedOn: string;
  warnings?: string[];
}

/** A SEDOL: 7 characters, no vowels, a digit among the first six, a check digit. */
const isSedol = (s: string) => /^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}\d$/.test(s.toUpperCase()) && /\d/.test(s.slice(0, 6));

/** A row only a Lifetime ISA has. */
const LISA_ROW = /\blifetime\s*isa\b.*\bbonus\b|\bgovernment\s+bonus\b/i;
/** Rows that buy or sell investments: evidence that a running balance is cash beside holdings. */
const TRADE_ROW = /\b(purchase|bought|buy|sale|sold|sell|redemption|switch)\b/i;

const TRANSFER_CATEGORIES = new Set(['transfer', 'credit-card-payment', 'savings-transfer', 'investment-transfer', 'contribution', 'withdrawal']);

/** Candidate other leg of a transfer: opposite amount, within ±4 days, in another own account. */
function findTransferMatch(accountId: string, date: string, amount: number, others: Transaction[], taken: Set<string>): Transaction | undefined {
  let best: { t: Transaction; days: number } | undefined;
  const want = -toMinor(amount);
  for (const t of others) {
    if (t.accountId === accountId || t.transferGroup || taken.has(t.id)) continue;
    if (toMinor(t.amount) !== want) continue;
    const days = Math.abs(diffDays(t.date, date));
    if (days > 4) continue;
    if (!best || days < best.days) best = { t, days };
  }
  return best?.t;
}

export function buildDraft(extraction: Extraction, ctx: DraftContext): Draft {
  const { store } = ctx;
  const categories = new CategoryIndex(store.categories);
  const categoriser = new Categoriser(store.rules, categories, store.accounts, store.institutions);
  const allTx = store.transactions();
  const txByAmount = new Map<number, Transaction[]>();
  for (const t of allTx) {
    const k = Math.abs(toMinor(t.amount));
    (txByAmount.get(k) ?? txByAmount.set(k, []).get(k)!).push(t);
  }
  const takenTransfers = new Set<string>();
  const notes = [...extraction.notes, ...(ctx.warnings ?? [])];
  // Each account's latest holdings: a fund's own page names no account, but the account holding it.
  const held = new Map(store.accounts.map((a) => [a.id, store.holdings(a.id).at(-1)?.holdings ?? []]));

  const sections: DraftSection[] = extraction.accounts.map((acc, si) => {
    // A screen about one holding: its value, gain and amount invested are the holding's, not the
    // account's, and the name at the top is the fund's (or the app's nickname for it).
    const holdingDetail =
      acc.holdings.length === 1 &&
      acc.transactions.length === 0 &&
      (extraction.documentType === 'holding_detail_screenshot' || (acc.accountName !== null && sameHolding({ name: acc.accountName }, { name: acc.holdings[0]!.name })));
    // Scrolled app screens hide the account's name; a row only one kind of account has still says it.
    const typeFromRows: AccountType | undefined = !acc.accountType && acc.transactions.some((t) => LISA_ROW.test(t.description)) ? 'lisa' : undefined;
    const detected = {
      institutionName: acc.institutionName ?? extraction.institutionName ?? undefined,
      accountName: holdingDetail ? undefined : (acc.accountName ?? undefined),
      accountType: acc.accountType ?? typeFromRows,
      last4: acc.last4 ?? undefined,
      currency: acc.currency ?? undefined,
    };
    if (typeFromRows) notes.push('The screen does not name the account, but its Lifetime ISA bonus rows say it is a Lifetime ISA.');
    const hint = extraction.accounts.length === 1 ? ctx.hintAccountId : undefined;
    const match = matchAccount({ ...detected, holdings: acc.holdings.map((h) => h.name) }, store.accounts, store.institutions, hint, held);
    const existing: Account | undefined = match.accountId && match.score >= 50 ? store.account(match.accountId) : undefined;
    const provider = findInstitution(detected.institutionName);
    const investing = provider?.kind === 'investment_platform' || provider?.kind === 'pension_provider';
    const fallbackType: AccountType = acc.holdings.length || investing ? 'stocks_isa' : 'current';
    // With nothing on the screen saying which account it is, a new account would be a guess: ask.
    // Funds can point at an account that holds them, but a list of funds alone does not say which
    // account (or kind of account) a new one would be.
    const anonymous = !existing && !hint && !identifies(detected);
    const target: DraftSection['target'] = existing
      ? { mode: 'existing', accountId: existing.id }
      : anonymous
        ? { mode: 'skip' }
        : { mode: 'new', account: proposeAccount(detected, store.accounts, fallbackType) };
    const targetType: AccountType = existing?.type ?? (target.mode === 'new' ? target.account.type : detected.accountType ?? fallbackType);
    const targetId = existing?.id ?? (target.mode === 'new' ? target.account.id : '');
    const currency = acc.currency ?? existing?.currency ?? 'GBP';

    // Balance date: printed date, else statement end, else when the screenshot was taken.
    let balanceDate = acc.balanceDate ?? undefined;
    let balanceDateSource: DateSource | undefined = balanceDate ? 'document' : undefined;
    // A statement's closing balance is at the end of its period, whatever date the statement was
    // produced ("Statement date: 03 Mar" for a period ending 2 Mar); dating it later would count
    // the next period's first rows twice.
    if (balanceDate && acc.periodEnd && balanceDate > acc.periodEnd && acc.transactions.length && !acc.transactions.some((t) => t.date > acc.periodEnd!)) {
      notes.push(`The balance was dated ${balanceDate}, after the statement period ends (${acc.periodEnd}); it is dated at the period's end.`);
      balanceDate = acc.periodEnd;
    }
    if (!balanceDate && acc.periodEnd) {
      balanceDate = acc.periodEnd;
      balanceDateSource = 'document';
    }
    if (!balanceDate && acc.transactions.length && acc.closingBalance !== null) {
      balanceDate = acc.transactions.reduce((m, t) => (t.date > m ? t.date : m), acc.transactions[0]!.date);
      balanceDateSource = 'document';
    }
    if (!balanceDate && extraction.documentDate) {
      balanceDate = extraction.documentDate;
      balanceDateSource = 'document';
    }
    if (!balanceDate) {
      balanceDate = ctx.document.capturedOn ?? ctx.uploadedOn;
      balanceDateSource = ctx.document.capturedOnSource ?? 'upload';
    }

    let balance = acc.closingBalance ?? undefined;
    let cash = acc.cashBalance ?? undefined;
    // An investment account's activity list: its running balance is the uninvested cash, not the
    // account's value, however the reader labelled it. Recording it as the value would make a
    // whole account look like a few pounds.
    const market = balanceModeOf(existing ?? { type: targetType }) === 'market';
    const investmentEvidence =
      investing ||
      acc.holdings.length > 0 ||
      acc.transactions.some((t) => TRADE_ROW.test(t.description)) ||
      Boolean(existing && store.holdings(existing.id).length) ||
      Boolean(existing && ['investment_platform', 'pension_provider'].includes(store.institution(existing.institutionId)?.kind ?? ''));
    const closingIsRunning = balance !== undefined && acc.transactions.some((t) => t.balanceAfter !== null && toMinor(t.balanceAfter) === toMinor(balance!));
    const cashLedger = market && acc.transactions.length > 0 && (acc.runningBalanceOf === 'cash' || (closingIsRunning && investmentEvidence));
    if (cashLedger) {
      if (closingIsRunning || acc.runningBalanceOf === 'cash') {
        if (balance !== undefined && (closingIsRunning || cash === undefined)) cash = balance;
        if (closingIsRunning) balance = undefined;
      }
      notes.push('The running balances on this screen are the uninvested cash, not the account’s value, so no value is recorded from it.');
    }
    if (holdingDetail) {
      balance = undefined;
      cash = undefined;
      notes.push(`This screen shows one holding (${acc.holdings[0]!.name}); its value is not the account’s, so only the holding is recorded, beside the others of that day.`);
    }
    if (balance !== undefined && ACCOUNT_TYPE_META[targetType].liability && balance > 0 && !acc.transactions.some((t) => t.balanceAfter !== null)) {
      balance = -balance;
      notes.push(`${detected.accountName ?? 'Account'}: the balance owed was shown as a positive number and has been stored as negative (money owed). Change it if the account is actually in credit.`);
    }

    // Transactions.
    const existingForAccount = existing ? store.transactions(existing.id) : [];
    const dups = classifyDuplicates(
      acc.transactions.map((t) => ({ date: t.date, amount: t.amount, description: t.description, sourceId: t.sourceId ?? undefined })),
      existingForAccount,
    );
    const transactions: DraftTransaction[] = acc.transactions.map((t, ti) => {
      const cat = categoriser.categorise({
        accountId: targetId,
        description: t.description,
        amount: t.amount,
        payee: t.payee ?? undefined,
        bankCategory: t.bankCategory ?? undefined,
        aiCategory: t.category ?? undefined,
        aiPayee: t.payee ?? undefined,
      });
      const dup = dups[ti]!;
      let category = cat.category;
      let categorisedBy = cat.categorisedBy;
      let counterpartyAccountId = cat.counterpartyAccountId;
      let transferMatch: string | undefined;
      if (dup.status === 'new' && (!category || TRANSFER_CATEGORIES.has(category))) {
        const candidates = txByAmount.get(Math.abs(toMinor(t.amount))) ?? [];
        const other = findTransferMatch(targetId, t.date, t.amount, counterpartyAccountId ? candidates.filter((c) => c.accountId === counterpartyAccountId) : candidates, takenTransfers);
        const otherAccount = other ? store.account(other.accountId) : undefined;
        if (other && otherAccount && (category || (other.category && TRANSFER_CATEGORIES.has(other.category)))) {
          takenTransfers.add(other.id);
          transferMatch = other.id;
          counterpartyAccountId = other.accountId;
          category = transferLegCategory(targetType, otherAccount.type, t.amount);
          categorisedBy = 'transfer';
        }
      }
      const merchant = { ...(t.merchant ?? {}), ...(t.merchantLocation ? { city: t.merchantLocation } : {}) };
      const detail: NonNullable<DraftTransaction['detail']> = {
        ...(t.sourceId ? { sourceId: t.sourceId } : {}),
        ...(t.transactionDate && t.transactionDate !== t.date ? { transactionDate: t.transactionDate } : {}),
        ...(t.time && /^\d{2}:\d{2}(:\d{2})?$/.test(t.time) ? { time: t.time } : {}),
        ...(t.type ? { type: t.type } : {}),
        ...(t.reference ? { reference: t.reference } : {}),
        ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
        ...(Object.keys(merchant).length ? { merchant } : {}),
        ...(t.bankCategory ? { bankCategory: t.bankCategory } : {}),
        ...(t.cardLast4 && /^\d{4}$/.test(t.cardLast4) ? { cardLast4: t.cardLast4 } : {}),
        ...(t.exchangeRate ? { exchangeRate: t.exchangeRate } : {}),
        ...(t.fee ? { fee: t.fee } : {}),
        ...(t.raw ? { raw: t.raw } : {}),
        ...(t.attributes ? { attributes: t.attributes } : {}),
      };
      const row: DraftTransaction = {
        key: `s${si}-t${ti}`,
        // Pending rows are shown but not recorded: the settled row arrives with the next statement.
        include: dup.status === 'new' && !t.pending,
        status: dup.status,
        date: t.date,
        amount: t.amount,
        description: t.description,
        payee: cat.payee,
        ...(dup.duplicateOf ? { duplicateOf: dup.duplicateOf } : {}),
        ...(category ? { category } : {}),
        ...(categorisedBy ? { categorisedBy } : {}),
        ...(cat.ruleId ? { ruleId: cat.ruleId } : {}),
        ...(t.balanceAfter !== null ? { balanceAfter: t.balanceAfter } : {}),
        // A foreign amount goes the same way as the sterling one; documents often print it unsigned.
        ...(t.originalAmount !== null && t.originalCurrency ? { original: { amount: t.amount < 0 ? -Math.abs(t.originalAmount) : Math.abs(t.originalAmount), currency: t.originalCurrency.toUpperCase() } } : {}),
        ...(t.pending ? { pending: true } : {}),
        ...(t.uncertain ? { uncertain: t.uncertain.slice(0, 300) } : {}),
        ...(counterpartyAccountId ? { counterpartyAccountId } : {}),
        ...(transferMatch ? { transferMatch } : {}),
        ...(t.row !== null ? { row: t.row } : { row: ti }),
        ...(Object.keys(detail).length ? { detail } : {}),
      };
      return row;
    });

    const holdings: Holding[] = acc.holdings.map((h) => ({
      name: h.name,
      value: h.value,
      currency: h.currency ?? currency,
      ...(h.isin ? { isin: h.isin } : {}),
      // A SEDOL read into the ticker field (UK platforms print both under "Symbol") is a SEDOL.
      ...(h.ticker && !isSedol(h.ticker) ? { ticker: h.ticker } : {}),
      ...((h.sedol && isSedol(h.sedol)) || (h.ticker && isSedol(h.ticker)) ? { sedol: (h.sedol && isSedol(h.sedol) ? h.sedol : h.ticker!).toUpperCase() } : {}),
      ...(h.units !== null ? { units: h.units } : {}),
      ...(h.price !== null ? { price: h.price } : {}),
      ...(h.costBasis !== null ? { costBasis: h.costBasis } : {}),
      ...(h.gain !== null ? { gain: h.gain } : {}),
      ...(h.assetClass ? { assetClass: h.assetClass } : {}),
    }));
    // Holdings that do not reach the value shown (a list cut off by the screen), or with no value to
    // check against, are part of the account's holdings: they join the others recorded that day.
    const heldMinor = holdings.reduce((sum, h) => sum + toMinor(h.value), 0) + toMinor(cash ?? 0);
    const holdingsPartial = holdings.length > 0 && (holdingDetail || balance === undefined || heldMinor < toMinor(balance) - Math.max(100, Math.round(Math.abs(toMinor(balance)) * 0.001)));

    // Screenshots of wrapper accounts rarely show a list of flows; statements do.
    const isScreenshot = /screenshot/.test(extraction.documentType) || ctx.document.mediaType.startsWith('image/');
    const section: DraftSection = {
      key: `s${si}`,
      detected: Object.fromEntries(Object.entries(detected).filter(([, v]) => v !== undefined)),
      target,
      matchReason: existing ? match.reason : anonymous ? 'Nothing on this screen says which account it is: choose it' : match.accountId ? `${match.reason}` : 'New account',
      currency,
      recordBalance: balance !== undefined,
      balanceDate,
      recordHoldings: holdings.length > 0,
      transactions,
      holdings,
      ...(cashLedger ? { cashLedger: true } : {}),
      ...(holdingsPartial ? { holdingsPartial: true } : {}),
      ...(balanceDateSource ? { balanceDateSource } : {}),
      ...(balance !== undefined ? { balance } : {}),
      ...(acc.periodStart ? { periodStart: acc.periodStart } : {}),
      ...(acc.periodEnd ? { periodEnd: acc.periodEnd } : {}),
      ...(acc.openingBalance !== null ? { openingBalance: acc.openingBalance } : {}),
      ...(acc.availableBalance !== null ? { availableBalance: acc.availableBalance } : {}),
      ...(acc.creditLimit !== null ? { creditLimit: acc.creditLimit } : {}),
      ...(acc.contributionsToDate !== null && !holdingDetail ? { contributions: acc.contributionsToDate } : {}),
      ...(acc.gainLoss !== null && !holdingDetail ? { gain: acc.gainLoss } : {}),
      ...(cash !== undefined ? { cash } : {}),
      ...(acc.governmentBonusToDate !== null ? { bonusToDate: acc.governmentBonusToDate } : {}),
      ...(acc.taxYearContributions !== null ? { taxYearContributions: acc.taxYearContributions } : {}),
      ...(acc.annualIncome !== null ? { annualIncome: acc.annualIncome } : {}),
      ...(acc.interestRate !== null ? { interestRate: acc.interestRate } : {}),
      ...(acc.statedMoneyIn !== null || acc.statedMoneyOut !== null
        ? { statedTotals: { ...(acc.statedMoneyIn !== null ? { moneyIn: Math.abs(acc.statedMoneyIn) } : {}), ...(acc.statedMoneyOut !== null ? { moneyOut: Math.abs(acc.statedMoneyOut) } : {}) } }
        : {}),
    };
    if (isScreenshot && isWrapperAccount(targetType) && transactions.length === 0 && balance === undefined && !holdingDetail && !holdings.length) {
      notes.push(`${detected.accountName ?? 'An account'}: no value found on this screenshot.`);
    }
    return section;
  });

  // Figures, matched to accounts by last 4 digits and checked against what is already stored.
  const figures: DraftFigure[] = extraction.figures.map((f, fi) => {
    // Matched by last 4 digits only when exactly one account has them.
    const byLast4 = f.accountLast4 ? store.accounts.filter((a) => a.last4 === f.accountLast4) : [];
    const account = byLast4.length === 1 ? byLast4[0] : undefined;
    const dup = store.figures.find(
      (x) =>
        x.kind === f.kind &&
        toMinor(x.amount) === toMinor(f.amount) &&
        // The same tax year and, for a payslip, the same pay period: two months' equal pay are two figures.
        (x.taxYear ?? x.periodEnd ?? '') === (f.taxYear ?? f.periodEnd ?? '') &&
        (x.periodEnd ?? '') === (f.periodEnd ?? '') &&
        (x.payer ?? '').toLowerCase() === (f.payer ?? '').toLowerCase(),
    );
    return {
      key: `f${fi}`,
      include: !dup,
      kind: f.kind,
      label: f.label,
      amount: f.amount,
      currency: f.currency ?? 'GBP',
      ...(f.periodStart ? { periodStart: f.periodStart } : {}),
      ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}),
      ...(f.taxYear && /^\d{4}\/\d{2}$/.test(f.taxYear) ? { taxYear: f.taxYear } : {}),
      ...(f.payer ? { payer: f.payer } : {}),
      ...(f.payerReference ? { payerReference: f.payerReference } : {}),
      ...(account ? { accountId: account.id } : {}),
      ...(dup ? { duplicateOf: dup.id } : {}),
    };
  });

  // An account the document only mentions (the account on an interest certificate, say) has
  // nothing to import: leave it out rather than offer to create it.
  const importable = sections.filter((s) => s.transactions.length || s.holdings.length || s.balance !== undefined || [s.contributions, s.bonusToDate, s.taxYearContributions, s.cash, s.annualIncome].some((v) => v !== undefined));
  return DraftSchema.parse({
    documentType: extraction.documentType,
    sections: importable,
    figures,
    notes,
    confidence: extraction.confidence,
    ...(extraction.institutionName ? { institutionName: extraction.institutionName } : {}),
    ...(extraction.documentDate ? { documentDate: extraction.documentDate } : {}),
  });
}

/** Is this draft safe to commit without looking (for "Commit all ready")? */
export function draftIsClean(draft: Draft): { clean: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (draft.confidence === 'low') reasons.push('low extraction confidence');
  for (const s of draft.sections) {
    if (s.target.mode === 'new') reasons.push('creates a new account');
    if (s.target.mode === 'skip') reasons.push('an account to choose or a section left out');
    if (s.transactions.some((t) => t.status === 'possible_duplicate')) reasons.push('possible duplicates to check');
    if (s.balanceDateSource === 'upload') reasons.push('balance date unknown');
  }
  if (!draft.sections.length && !draft.figures.length) reasons.push('nothing extracted');
  return { clean: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function uploadDay(): string {
  return today();
}
