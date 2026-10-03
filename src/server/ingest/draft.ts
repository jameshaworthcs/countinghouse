// Build the reviewable draft from an extraction: match each extracted account to one of yours (or
// propose a new one), categorise, flag duplicates and transfers, resolve the balance date.

import { ACCOUNT_TYPE_META, balanceModeOf } from '../../shared/accounts';
import { findInstitution } from '../../shared/institutions';
import { isWrapperAccount, transferLegCategory, type Categoriser } from '../../shared/categorise';
import { AGREEMENT_RECEIPT_DAYS } from '../../shared/agreements';
import { addDays, dateOf, diffDays, formatDate, today } from '../../shared/dates';
import { formatMoney, toMinor } from '../../shared/money';
import { spaceMove } from '../../shared/spaces';
import { categoriserFor } from '../categoriser';
import { addsAnything, detailToAdd, fillIn } from '../../shared/detail';
import { rederive, transferEvidence, transferReader, type TransferSide } from '../enrich';
import type {
  Account,
  AccountType,
  DateSource,
  DocumentRef,
  Draft,
  DraftFigure,
  DraftSection,
  DraftTransaction,
  ExtractedAccount,
  ExtractedSchedule,
  Extraction,
  Holding,
  Transaction,
} from '../../shared/schema';
import { isNiNumber, withoutNiNumbers } from '../../shared/privacy';
import { DraftSchema, WorkDetailSchema, type DraftJob, type Employment, type WorkDetail } from '../../shared/schema';
import { isPayslipFigure, payeReference, payerKey } from '../analytics/sources';
import { jobOfFigure, jobOfHmrc, matchEmployment, newEmploymentId, type JobIdentity } from '../employments';
import { hmrcId, payslipId } from '../ids';
import { earnedReplaced, inferPayroll } from '../analytics/earned';
import type { Store } from '../store';
import { classifyDuplicates, storedTwice } from './dedup';
import { dateFromFileName } from './images';
import { fitsAccount, identifies, matchAccount, onlyKind, proposeAccount, sameHolding } from './match';
import { asAgreement, draftAgreements, isStudentFinance, STUDENT_FINANCE, studentLoanAccount } from './schedules';

export { fitsAccount } from './match';

export interface DraftContext {
  store: Store;
  document: DocumentRef;
  hintAccountId?: string | undefined;
  uploadedOn: string;
  warnings?: string[];
  /** The account a screenshot taken and uploaded with this one shows (ImportService.batchEvidence). */
  batch?: BatchEvidence | undefined;
}

/** Another screenshot of the same moment, on the same phone, that shows which account it is. */
export interface BatchEvidence {
  accountId: string;
  importId: string;
  fileName: string;
  /** Whole minutes from that screenshot to this one: negative when this one was taken first. */
  minutes: number;
}

function batchReason(b: BatchEvidence, account: Account): string {
  const when = b.minutes === 0 ? 'within a minute of' : `${Math.abs(b.minutes)} minute${Math.abs(b.minutes) === 1 ? '' : 's'} ${b.minutes > 0 ? 'after' : 'before'}`;
  return `Nothing on this screen names the account. It was taken ${when} ${b.fileName}, which shows ${account.name}, on the same phone, and uploaded with it`;
}

/** A SEDOL: 7 characters, no vowels, a digit among the first six, a check digit. */
const isSedol = (s: string) => /^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}\d$/.test(s.toUpperCase()) && /\d/.test(s.slice(0, 6));

/** A row only a Lifetime ISA has. */
const LISA_ROW = /\blifetime\s*isa\b.*\bbonus\b|\bgovernment\s+bonus\b/i;
/** Rows that buy or sell investments: evidence that a running balance is cash beside holdings. */
const TRADE_ROW = /\b(purchase|bought|buy|sale|sold|sell|redemption|switch)\b/i;

/**
 * A screen of an app as it was when captured, not a picture of a dated document: its headline
 * figures are as at the moment it was taken. A photo or screenshot of a statement is a statement.
 */
export function isLiveView(documentType: Extraction['documentType'], mediaType: string): boolean {
  return documentType.endsWith('_screenshot') || (documentType === 'other' && mediaType.startsWith('image/'));
}

/**
 * When an export with no date in it is from: an export is made as it is downloaded, so the date in
 * its file name, else the day the file was saved, never after the upload. (Not a PDF's saved day: a
 * statement downloaded today can be last year's.)
 */
function exportDate(document: DocumentRef, uploadedOn: string): { date: string; source: DateSource } | undefined {
  const named = dateFromFileName(document.fileName);
  if (named && named <= uploadedOn) return { date: named, source: 'filename' };
  const saved = document.lastModified ? dateOf(document.lastModified) : undefined;
  return saved && saved <= uploadedOn ? { date: saved, source: 'file-modified' } : undefined;
}

const DATE_SOURCE_WORDS: Record<DateSource, string> = {
  document: 'from the document',
  exif: 'from its metadata',
  filename: 'from its file name',
  'file-modified': 'from the file’s date',
  upload: 'the upload day',
  manual: 'as you set it',
};

const TRANSFER_CATEGORIES = new Set(['transfer', 'credit-card-payment', 'savings-transfer', 'investment-transfer', 'contribution', 'withdrawal']);

/** Documents that list each payment: none of their rows restates others. */
const TRANSACTION_LISTS = new Set<Extraction['documentType']>(['bank_statement', 'credit_card_statement', 'savings_statement', 'investment_statement', 'pension_statement', 'account_overview_screenshot', 'transactions_screenshot', 'csv_export']);

/**
 * The other leg of a transfer already stored: the opposite amount, within ±4 days, in another of
 * your accounts, that the two descriptions say is the same money (transferEvidence, as when an
 * import is linked at commit). The best evidence wins, then the closest date.
 */
function findTransferMatch(row: TransferSide & { date: string; amount: number }, others: Transaction[], taken: Set<string>, reader: ReturnType<typeof transferReader>): Transaction | undefined {
  let best: { t: Transaction; score: number; days: number } | undefined;
  const want = -toMinor(row.amount);
  for (const t of others) {
    if (t.accountId === row.accountId || t.transferGroup || taken.has(t.id)) continue;
    if (toMinor(t.amount) !== want) continue;
    const days = Math.abs(diffDays(t.date, row.date));
    if (days > 4) continue;
    const [out, into] = row.amount < 0 ? [row, t] : [t, row];
    const score = transferEvidence(out, into, reader.named, reader.ownName);
    if (score === null) continue;
    if (!best || score > best.score || (score === best.score && days < best.days)) best = { t, score, days };
  }
  return best?.t;
}

export function buildDraft(extraction: Extraction, ctx: DraftContext): Draft {
  const { store } = ctx;
  // Schedules (extract-15): the agreements they are, which the categoriser reads beside yours. Student
  // finance's lend and pay through your student loan, or one proposed for it.
  const statusAsOf = extraction.documentDate ?? ctx.document.capturedOn ?? ctx.uploadedOn;
  const studentFinance = extraction.schedules.filter(isStudentFinance);
  const loan = studentFinance.length ? studentLoanAccount(store) : undefined;
  const newLoan = studentFinance.length && !loan ? proposeAccount({ institutionName: 'Student Loans Company', accountType: 'student_loan', accountName: 'Student loan' }, store.accounts, 'student_loan') : undefined;
  const loanAccountId = loan?.id ?? newLoan?.id;
  const agreements = draftAgreements(store, extraction.schedules, { loanAccountId, statusAsOf });
  const replaced = new Set(agreements.flatMap((d) => (d.target.mode === 'existing' ? [d.target.agreementId] : [])));
  const categoriser = categoriserFor(store, { agreements: [...store.agreements.filter((a) => !replaced.has(a.id)), ...agreements.map((d) => asAgreement(d.record))] });
  const reader = transferReader(store, categoriser);
  const allTx = store.transactions();
  const txByAmount = new Map<number, Transaction[]>();
  for (const t of allTx) {
    const k = Math.abs(toMinor(t.amount));
    (txByAmount.get(k) ?? txByAmount.set(k, []).get(k)!).push(t);
  }
  const takenTransfers = new Set<string>();
  // A National Insurance number the reader copied into its remarks is not kept (shared/privacy.ts).
  const notes = [...extraction.notes.map(withoutNiNumbers), ...(ctx.warnings ?? [])];
  const liveView = isLiveView(extraction.documentType, ctx.document.mediaType);
  let batchMatch: Draft['batchMatch'];
  // Each account's latest holdings: a fund's own page names no account, but the account holding it.
  const held = new Map(store.accounts.map((a) => [a.id, store.holdings(a.id).at(-1)?.holdings ?? []]));

  // A statement that runs across the day one of your accounts carries on from another is two: the
  // rows before for the older account, the rest for the newer (docs/INGESTION.md, "Linked accounts").
  const entries = splitAtLinks(store, extraction.accounts, (acc) => matchAccount({ institutionName: acc.institutionName ?? extraction.institutionName ?? undefined, accountName: acc.accountName ?? undefined, accountType: acc.accountType ?? undefined, last4: acc.last4 ?? undefined, currency: acc.currency ?? undefined }, store.accounts, store.institutions, extraction.accounts.length === 1 ? ctx.hintAccountId : undefined, held));
  for (const e of entries) if (e.note) notes.push(e.note);

  const sections: DraftSection[] = entries.map(({ acc, force }, si) => {
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
    const match = force ? { accountId: force, score: 100, reason: 'Its part of a statement that runs across the day one account carries on from the other' } : matchAccount({ ...detected, holdings: acc.holdings.map((h) => h.name) }, store.accounts, store.institutions, hint, held);
    let existing: Account | undefined = match.accountId && match.score >= 50 ? store.account(match.accountId) : undefined;
    // A scrolled screen seldom names its account; one taken beside it on the same phone and uploaded
    // with it usually does. Only when this screen has no confident match of its own, shows one
    // account, and says nothing that contradicts that account.
    const batchAccount = ctx.batch && !existing && !hint && extraction.accounts.length === 1 ? store.account(ctx.batch.accountId) : undefined;
    const byBatch = Boolean(batchAccount && fitsAccount(detected, batchAccount, store.institutions));
    if (byBatch) {
      existing = batchAccount;
      batchMatch = { accountId: batchAccount!.id, importId: ctx.batch!.importId };
    }
    const provider = findInstitution(detected.institutionName);
    const investing = provider?.kind === 'investment_platform' || provider?.kind === 'pension_provider';
    const fallbackType: AccountType = acc.holdings.length || investing ? 'stocks_isa' : 'current';
    // With nothing on the screen saying which account it is, a new account would be a guess: ask.
    // Funds can point at an account that holds them, but a list of funds alone does not say which
    // account (or kind of account) a new one would be.
    const anonymous = !existing && !hint && !identifies(detected);
    // A screen that says only the kind of account (a scrolled list of a LISA's rows) is one of your
    // accounts of that kind, not a new one: ask which, and suggest it when you have only one.
    const sameKind = !existing && !hint && !anonymous && onlyKind(detected) ? store.accounts.filter((a) => a.status !== 'closed' && fitsAccount(detected, a, store.institutions)) : [];
    const target: DraftSection['target'] = existing
      ? { mode: 'existing', accountId: existing.id }
      : anonymous || sameKind.length
        ? { mode: 'skip' }
        : { mode: 'new', account: proposeAccount(detected, store.accounts, fallbackType) };
    const targetType: AccountType = existing?.type ?? (target.mode === 'new' ? target.account.type : detected.accountType ?? fallbackType);
    const targetId = existing?.id ?? (target.mode === 'new' ? target.account.id : '');
    const currency = acc.currency ?? existing?.currency ?? 'GBP';

    // Balance date: a printed date, else the statement's end, else (an app screen) when it was
    // taken, else (a statement) its latest row or its own date.
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
    // An app screen shows its figures as they were when it was taken, so with no date printed beside
    // them that is their date: a holding seen on 29 Sep is not the holding on 2 Sep, the day of the
    // last row it lists. Only a statement's balance is the balance after its latest row.
    const latestSettled = acc.transactions.filter((t) => !t.pending).reduce<string | undefined>((m, t) => (!m || t.date > m ? t.date : m), undefined);
    if (!balanceDate && liveView) {
      const { capturedOn, capturedOnSource } = ctx.document;
      if (capturedOn && capturedOnSource && capturedOnSource !== 'upload') {
        balanceDate = capturedOn;
        balanceDateSource = capturedOnSource;
        // A settled row cannot be later than the screen showing it: the row's date is the doubtful
        // one (misread, or a payment the app lists ahead of time). The review check marks it.
        if (latestSettled && latestSettled > capturedOn) notes.push(`This screenshot was taken on ${capturedOn} (${DATE_SOURCE_WORDS[capturedOnSource]}), but it lists a row dated ${latestSettled}. Check that row's date against the screenshot.`);
      } else if (latestSettled && !extraction.documentDate) {
        notes.push(`Nothing says when this screenshot was taken, so its balance is dated on the upload day. It was taken on or after ${latestSettled}, its latest row: set the day it was taken.`);
      }
    }
    if (!balanceDate && !liveView && acc.transactions.length && acc.closingBalance !== null) {
      balanceDate = acc.transactions.reduce((m, t) => (t.date > m ? t.date : m), acc.transactions[0]!.date);
      balanceDateSource = 'document';
    }
    if (!balanceDate && extraction.documentDate) {
      balanceDate = extraction.documentDate;
      balanceDateSource = 'document';
    }
    const exported = !balanceDate && extraction.documentType === 'csv_export' ? exportDate(ctx.document, ctx.uploadedOn) : undefined;
    if (exported) {
      balanceDate = exported.date;
      balanceDateSource = exported.source;
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
    const recordedById = new Map(existingForAccount.map((t) => [t.id, t]));
    const candidates = acc.transactions.map((t) => ({ date: t.date, amount: t.amount, description: t.description, sourceId: t.sourceId ?? undefined, balanceAfter: t.balanceAfter ?? undefined, time: t.time && /^\d{2}:\d{2}(:\d{2})?$/.test(t.time) ? t.time : undefined }));
    const ownDups = classifyDuplicates(
      candidates,
      existingForAccount,
      3,
      // A letter or confirmation may restate payments recorded one by one (dedup.ts, step 5).
      { sums: !TRANSACTION_LISTS.has(extraction.documentType) },
    );
    // Rows another of your accounts under the same number and provider has recorded already (the
    // older or newer product, when the two are not linked): left out, to check.
    const twins = existing?.last4 ? store.accounts.filter((a) => a.id !== existing.id && a.last4 === existing.last4 && a.institutionId === existing.institutionId) : [];
    const twinDups = twins.length ? classifyDuplicates(candidates, twins.flatMap((a) => store.transactions(a.id)), 3) : [];
    const dups = ownDups.map((d, i) => {
      const twin = d.status === 'new' ? twinDups[i] : undefined;
      return twin && twin.status !== 'new' && twin.duplicateOf ? { status: 'possible_duplicate' as const, duplicateOf: twin.duplicateOf } : d;
    });
    const onTwin = dups.filter((d, i) => d !== ownDups[i]).length;
    if (onTwin) notes.push(`${onTwin === 1 ? 'A row is' : `${onTwin} rows are`} recorded already on ${twins.map((a) => a.name).join(' or ')}, under the same account number: left out, to check. If one account carries on from the other, link them on its account page, and the statement is split between them.`);
    // The account's Spaces, and those this document's own rows show by type: a row cut off above
    // its type still names the Space.
    const shownSpaces = existing ? acc.transactions.flatMap((t) => (t.type ? (spaceMove({ ...existing, spaces: [] }, t) ?? []) : [])) : [];
    const spacesOf = existing ? { ...existing, spaces: [...new Set([...(existing.spaces ?? []), ...shownSpaces])] } : undefined;
    const transactions: DraftTransaction[] = acc.transactions.map((t, ti) => {
      const cat = categoriser.categorise({
        accountId: targetId,
        description: t.description,
        amount: t.amount,
        date: t.date,
        type: t.type ?? undefined,
        payee: t.payee ?? undefined,
        bankCategory: t.bankCategory ?? undefined,
        aiCategory: t.category ?? undefined,
        aiPayee: t.payee ?? undefined,
      });
      const dup = dups[ti]!;
      const space = spaceMove(spacesOf, t);
      let category = cat.category;
      let categorisedBy = cat.categorisedBy;
      let counterpartyAccountId = cat.counterpartyAccountId;
      let transferMatch: string | undefined;
      if (dup.status === 'new' && !space && (!category || TRANSFER_CATEGORIES.has(category))) {
        const candidates = txByAmount.get(Math.abs(toMinor(t.amount))) ?? [];
        const row = { id: `draft:${si}:${ti}`, accountId: targetId, date: t.date, amount: t.amount, description: t.description, ...(t.type ? { type: t.type } : {}), ...(category ? { category } : {}), ...(counterpartyAccountId ? { counterpartyAccountId } : {}) };
        const other = findTransferMatch(row, counterpartyAccountId ? candidates.filter((c) => c.accountId === counterpartyAccountId) : candidates, takenTransfers, reader);
        const otherAccount = other ? store.account(other.accountId) : undefined;
        if (other && otherAccount) {
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
        // A move to or from one of the account's Spaces is not money in or out.
        include: dup.status === 'new' && !t.pending && !space,
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
        ...(space ? { insideAccount: space.slice(0, 80) } : {}),
        ...(counterpartyAccountId ? { counterpartyAccountId } : {}),
        ...(transferMatch ? { transferMatch } : {}),
        ...(t.row !== null ? { row: t.row } : { row: ti }),
        ...(Object.keys(detail).length ? { detail } : {}),
      };
      // Matched to a recorded payment (never one of several a letter adds up): what this document
      // knows about it that the record does not. Filled in on commit when ticked: by itself only
      // when the match is certain.
      const recorded = dup.duplicateOf && !dup.sum ? recordedById.get(dup.duplicateOf) : undefined;
      if (recorded) {
        const found = detailToAdd(row, recorded);
        if (addsAnything(found)) {
          const change = rederive(categoriser, { ...recorded, ...fillIn(recorded, found.fields).patch }, Object.keys(found.fields));
          row.adds = {
            include: dup.status === 'duplicate',
            fields: found.fields,
            differs: found.differs,
            ...('category' in change ? { category: { ...(recorded.category ? { from: recorded.category } : {}), ...(change.category ? { to: change.category } : {}) } } : {}),
          };
        }
      }
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

    // Payments recorded twice that this document shows once: offered to be taken away on commit.
    const extraCopies = existing
      ? storedTwice(transactions, existingForAccount, {
          withReceipts: new Set(store.receipts.map((r) => r.transactionId)),
          fileOf: (t) => store.imports.find((i) => i.id === t.source.importId)?.fileName,
        })
      : [];
    // Screenshots of wrapper accounts rarely show a list of flows; statements do.
    const isScreenshot = /screenshot/.test(extraction.documentType) || ctx.document.mediaType.startsWith('image/');
    const section: DraftSection = {
      key: `s${si}`,
      detected: Object.fromEntries(Object.entries(detected).filter(([, v]) => v !== undefined)),
      target,
      matchReason: byBatch
        ? batchReason(ctx.batch!, existing!)
        : existing
          ? match.reason
          : anonymous
            ? 'Nothing on this screen says which account it is: choose it'
            : sameKind.length === 1
              ? `Nothing on this screen names the account, only that it is ${ACCOUNT_TYPE_META[sameKind[0]!.type].label}. It looks like your ${sameKind[0]!.name}: choose it`
              : sameKind.length
                ? `Nothing on this screen names the account, only that it is ${ACCOUNT_TYPE_META[sameKind[0]!.type].label}, and you have ${sameKind.length}: choose it`
                : match.accountId
                  ? `${match.reason}`
                  : 'New account',
      ...(sameKind.length === 1 ? { suggestedAccountId: sameKind[0]!.id } : {}),
      currency,
      recordBalance: balance !== undefined,
      balanceDate,
      recordHoldings: holdings.length > 0,
      transactions,
      holdings,
      ...(cashLedger ? { cashLedger: true } : {}),
      ...(holdingsPartial ? { holdingsPartial: true } : {}),
      ...(extraCopies.length ? { extraCopies } : {}),
      ...(balanceDateSource ? { balanceDateSource } : {}),
      ...(balance !== undefined ? { balance } : {}),
      readBalance: balance ?? null,
      ...(acc.periodStart ? { periodStart: acc.periodStart } : {}),
      ...(acc.periodEnd ? { periodEnd: acc.periodEnd } : {}),
      ...(acc.openingBalance !== null ? { openingBalance: acc.openingBalance } : {}),
      ...(acc.availableBalance !== null ? { availableBalance: acc.availableBalance } : {}),
      ...(acc.creditLimit !== null ? { creditLimit: acc.creditLimit } : {}),
      ...(acc.terms ? { terms: acc.terms } : {}),
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
  // A timesheet's earned pay is linked to the payroll that pays it (FORMULAS.md §17, "Earned pay").
  const workOf = (w: (typeof extraction.figures)[number]['work']): WorkDetail | undefined => {
    if (!w) return undefined;
    const out = Object.fromEntries(Object.entries({ role: w.role?.trim() || null, daysWorked: w.daysWorked, holidayDays: w.holidayDays, hoursWorked: w.hoursWorked, rate: w.rate, ratePer: w.ratePer }).filter(([, v]) => v !== null && v !== undefined));
    const parsed = WorkDetailSchema.safeParse(out);
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : undefined;
  };
  const payrolls = inferPayroll(store, extraction.figures.map((f) => ({ kind: f.kind, payer: f.payer ?? undefined, periodEnd: f.periodEnd ?? undefined, amount: f.amount, work: workOf(f.work) })));
  // The jobs the document's pay figures and HMRC records are about, each matched to a job of yours
  // or set up as a new one (server/employments.ts).
  const identities: { ref: string; who: JobIdentity }[] = [];
  extraction.figures.forEach((f, fi) => {
    const ref = f.payerReference && !isNiNumber(f.payerReference) ? f.payerReference : undefined;
    const who = jobOfFigure({ kind: f.kind, payer: f.payer ?? undefined, payerReference: ref, paidBy: f.kind === 'earned_pay' ? payrolls.get(f.payer ?? '') : undefined }, extraction.documentType);
    if (who) identities.push({ ref: `f${fi}`, who });
  });
  extraction.hmrc.forEach((r, hi) => {
    const who = jobOfHmrc(r);
    if (who) identities.push({ ref: `h${hi}`, who });
  });
  // A payslip in full: its job by the payroll number it prints, else its employer's name.
  extraction.payslips.forEach((p, si) => identities.push({ ref: `s${si}`, who: { employer: p.employer, ...(p.payeReference ? { payeReference: p.payeReference } : {}), ...(p.payrollNumber ? { payrollNumber: p.payrollNumber } : {}) } }));
  const { jobs, jobKeyOf } = documentJobs(store, identities, extraction.figures);
  const employmentOf = (ref: string) => {
    const job = jobs.find((j) => j.key === jobKeyOf.get(ref));
    return job?.target.mode === 'existing' ? job.target.employmentId : undefined;
  };
  const figures: DraftFigure[] = extraction.figures.map((f, fi) => {
    // Matched by last 4 digits only when exactly one account has them.
    const byLast4 = f.accountLast4 ? store.accounts.filter((a) => a.last4 === f.accountLast4) : [];
    const account = byLast4.length === 1 ? byLast4[0] : undefined;
    const dup = store.figures.find(
      (x) =>
        x.kind === f.kind &&
        toMinor(x.amount) === toMinor(f.amount) &&
        // The same tax year and, for a payslip, the same pay period: two months' equal pay are two figures.
        (x.taxYear ?? x.periodEnd ?? '') === ((f.kind === 'earned_pay' ? null : f.taxYear) ?? f.periodEnd ?? '') &&
        (x.periodEnd ?? '') === (f.periodEnd ?? '') &&
        // The same payer, by name or by the job both are about…
        ((x.payer ?? '').toLowerCase() === (f.payer ?? '').toLowerCase() || (Boolean(x.employmentId) && x.employmentId === employmentOf(`f${fi}`))) &&
        // …from the same kind of document: a P60 and HMRC's page that agree are two sources, both
        // kept (one counts: analytics/sources.ts); the same P60 read twice is one. A figure with no
        // import is a payslip's when it covers a pay period, else yours.
        (store.imports.find((i) => i.id === x.source.importId)?.documentType ?? (isPayslipFigure(store, x) ? 'payslip' : 'yours')) === extraction.documentType,
    );
    const earned = f.kind === 'earned_pay';
    const work = earned ? workOf(f.work) : undefined;
    const paidBy = earned ? payrolls.get(f.payer ?? '') : undefined;
    const replaced = earned && !dup ? earnedReplaced(store, { kind: f.kind, payer: f.payer ?? undefined, work, periodStart: f.periodStart ?? undefined, periodEnd: f.periodEnd ?? undefined, amount: f.amount }) : undefined;
    const taxCode = f.taxCode?.trim().toUpperCase().slice(0, 20);
    return {
      key: `f${fi}`,
      include: !dup,
      ...(jobKeyOf.has(`f${fi}`) ? { jobKey: jobKeyOf.get(`f${fi}`)! } : {}),
      kind: f.kind,
      label: f.label,
      amount: f.amount,
      currency: f.currency ?? 'GBP',
      ...(f.periodStart ? { periodStart: f.periodStart } : {}),
      ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}),
      // Earned pay belongs to no tax year until it is paid.
      ...(!earned && f.taxYear && /^\d{4}\/\d{2}$/.test(f.taxYear) ? { taxYear: f.taxYear } : {}),
      ...(f.payer ? { payer: f.payer } : {}),
      // A "reference" that is your National Insurance number is not the payer's: it is left out.
      ...(f.payerReference && !isNiNumber(f.payerReference) ? { payerReference: f.payerReference } : {}),
      ...(account ? { accountId: account.id } : {}),
      ...(taxCode && !earned ? { taxCode } : {}),
      ...(paidBy && paidBy !== f.payer ? { paidBy } : {}),
      ...(work ? { work } : {}),
      ...(dup ? { duplicateOf: dup.id } : {}),
      ...(replaced ? { replaces: { id: replaced.id, amount: replaced.amount } } : {}),
    };
  });

  // Student finance's paid instalments, as its student loan's own movements: on the loan's section
  // when the document gives one, else on a section of their own.
  const loanRows = studentLoanRows(store, studentFinance, { categoriser, loanAccountId, taken: takenTransfers, keyPrefix: `s${sections.length}` });
  if (loanRows.length && loanAccountId) {
    const own = sections.find((x) => (x.target.mode === 'existing' && x.target.accountId === loanAccountId) || (x.target.mode === 'new' && x.target.account.id === loanAccountId));
    if (own) own.transactions.push(...loanRows.map((r, i) => ({ ...r, key: `${own.key}-l${i}` })));
    else
      sections.push({
        key: `s${sections.length}`,
        detected: { institutionName: studentFinance[0]!.provider, accountType: 'student_loan', accountName: 'Student loan' },
        target: loan ? { mode: 'existing', accountId: loan.id } : { mode: 'new', account: newLoan! },
        matchReason: 'Student finance pays out of your student loan: each instalment it paid is money the loan lent you, or paid for you',
        fromSchedule: true,
        currency: 'GBP',
        recordBalance: false,
        balanceDate: statusAsOf,
        recordHoldings: false,
        transactions: loanRows,
        holdings: [],
        readBalance: null,
      });
  }

  // An account the document only mentions (the account on an interest certificate, say) has
  // nothing to import: leave it out rather than offer to create it.
  const importable = sections.filter((s) => s.transactions.length || s.holdings.length || s.balance !== undefined || [s.contributions, s.bonusToDate, s.taxYearContributions, s.cash, s.annualIncome].some((v) => v !== undefined));
  // HMRC's records, each ticked unless the same record is stored already.
  const hmrc = extraction.hmrc.map((record, hi) => {
    const id = hmrcId(record);
    const dup = store.hmrc.find((x) => x.id === id);
    return { key: `h${hi}`, include: !dup, ...(jobKeyOf.has(`h${hi}`) ? { jobKey: jobKeyOf.get(`h${hi}`)! } : {}), ...(dup ? { duplicateOf: dup.id } : {}), record };
  });
  // Payslips in full, each ticked unless the same payslip is stored already.
  const payslips = extraction.payslips.map((record, si) => {
    const dup = store.payslips.find((x) => x.id === payslipId(record));
    return { key: `s${si}`, include: !dup, ...(jobKeyOf.has(`s${si}`) ? { jobKey: jobKeyOf.get(`s${si}`)! } : {}), ...(dup ? { duplicateOf: dup.id } : {}), record };
  });
  return DraftSchema.parse({
    documentType: extraction.documentType,
    sections: importable,
    figures,
    ...(jobs.length ? { jobs } : {}),
    ...(hmrc.length ? { hmrc } : {}),
    ...(payslips.length ? { payslips } : {}),
    ...(agreements.length ? { agreements } : {}),
    notes,
    ...(extraction.nothingToRecord?.trim() ? { nothingToRecord: extraction.nothingToRecord.trim().slice(0, 300) } : {}),
    ...(batchMatch && importable.some((s) => s.target.mode === 'existing' && s.target.accountId === batchMatch!.accountId) ? { batchMatch } : {}),
    confidence: extraction.confidence,
    ...(extraction.institutionName ? { institutionName: extraction.institutionName } : {}),
    ...(extraction.documentDate ? { documentDate: extraction.documentDate } : {}),
  });
}

/**
 * Extracted accounts as entries to draft: one that runs across the day one of your accounts carries
 * on from another (`Account.continues`: a product change under one account number) is split there,
 * the rows before for the older account and the rest for the newer, each with the balance it
 * starts or ends with as its running balances give them; one wholly on one side goes to that side's
 * account. `matchOf` is how the account would be matched without the link.
 */
export function splitAtLinks(store: Store, accounts: readonly ExtractedAccount[], matchOf: (acc: ExtractedAccount) => { accountId?: string | undefined; score: number }): { acc: ExtractedAccount; force?: string; note?: string }[] {
  const links = store.accounts.flatMap((n) => {
    const older = n.continues ? store.account(n.continues.accountId) : undefined;
    return older && n.continues ? [{ newer: n, older, from: n.continues.from }] : [];
  });
  if (!links.length) return accounts.map((acc) => ({ acc }));
  return accounts.flatMap((acc) => {
    const m = matchOf(acc);
    const link = links.find((l) => (acc.last4 && (l.newer.last4 === acc.last4 || l.older.last4 === acc.last4) && (!acc.institutionName || findInstitution(acc.institutionName)?.id === (l.newer.institutionId ?? l.older.institutionId))) || (m.score >= 50 && (m.accountId === l.newer.id || m.accountId === l.older.id)));
    if (!link) return [{ acc }];
    const before = acc.transactions.filter((t) => t.date < link.from);
    const after = acc.transactions.filter((t) => t.date >= link.from);
    const runsAcross = before.length > 0 && (after.length > 0 || Boolean(acc.periodEnd && acc.periodEnd >= link.from));
    if (!runsAcross) return [{ acc, force: before.length || (acc.periodEnd && acc.periodEnd < link.from) ? link.older.id : link.newer.id }];
    const carried = before.at(-1)?.balanceAfter ?? null;
    const dayBefore = addDays(link.from, -1);
    const older: ExtractedAccount = { ...acc, transactions: before, holdings: [], ...(acc.periodEnd && acc.periodEnd >= link.from ? { periodEnd: dayBefore } : {}), closingBalance: carried, balanceDate: carried !== null ? (before.at(-1)?.date ?? dayBefore) : null, statedMoneyIn: null, statedMoneyOut: null, cashBalance: null };
    const newer: ExtractedAccount = { ...acc, transactions: after, ...(acc.periodStart && acc.periodStart < link.from ? { periodStart: link.from } : {}), openingBalance: carried, statedMoneyIn: null, statedMoneyOut: null };
    const note = `Split at ${formatDate(link.from)}, where ${link.newer.name} carries on from ${link.older.name}: ${before.length === 1 ? 'the row' : `the ${before.length} rows`} before ${before.length === 1 ? 'goes' : 'go'} to ${link.older.name}, ${after.length === 1 ? 'the row' : `the ${after.length} rows`} from it to ${link.newer.name}.${carried !== null ? ` The balance carried over: ${formatMoney(carried)}.` : ''}`;
    return [
      { acc: older, force: link.older.id, note },
      { acc: newer, force: link.newer.id },
    ];
  });
}

/** A student loan's row for a student finance payment: what it was, and who it was paid to. */
export function loanRowDescription(s: Pick<ExtractedSchedule, 'name' | 'direction' | 'paidTo'>, p: Pick<ExtractedSchedule['payments'][number], 'label'>): string {
  const what = `${s.name}${p.label ? ` (${p.label})` : ''}`;
  return `${what}: paid to ${s.direction === 'to-you' ? 'you' : (s.paidTo ?? 'your university or college')}`;
}

/**
 * Student finance's paid instalments as rows on its student loan (docs/INGESTION.md, "Schedules").
 * Each is money the loan lent you or paid for you, so it adds to what you owe. One paid to you is the
 * other leg of the money that reached your bank: the credit of exactly that amount within 7 days,
 * which commit links as a transfer. One paid for you takes the agreement's category (its fees).
 */
function studentLoanRows(store: Store, schedules: readonly ExtractedSchedule[], opts: { categoriser: Categoriser; loanAccountId: string | undefined; taken: Set<string>; keyPrefix: string }): DraftTransaction[] {
  const loanId = opts.loanAccountId;
  if (!loanId || !schedules.length) return [];
  const wrapper = new Set(store.accounts.filter((a) => isWrapperAccount(a.type)).map((a) => a.id));
  const loanType: AccountType = store.account(loanId)?.type ?? 'student_loan';
  const items = schedules.flatMap((s) => s.payments.filter((p) => p.status === 'paid').map((p) => ({ s, p, description: loanRowDescription(s, p) })));
  const dups = classifyDuplicates(
    items.map(({ p, description }) => ({ date: p.date, amount: -p.amount, description })),
    store.transactions(loanId),
    3,
  );
  const credits = store.transactions().filter((t) => t.amount > 0 && t.accountId !== loanId && !wrapper.has(t.accountId) && !t.transferGroup && (t.categorisedBy !== 'user' || TRANSFER_CATEGORIES.has(t.category ?? '')));
  return items.map(({ s, p, description }, i) => {
    const toYou = s.direction === 'to-you';
    const payee = toYou ? s.provider : (s.paidTo ?? s.provider);
    const cat = opts.categoriser.categorise({ accountId: loanId, description, amount: -p.amount, date: p.date, payee });
    const dup = dups[i]!;
    let category = cat.category;
    let categorisedBy = cat.categorisedBy;
    let counterpartyAccountId: string | undefined;
    let transferMatch: string | undefined;
    if (toYou && dup.status === 'new') {
      // The credit of exactly that amount within 7 days: one naming student finance first, then the nearest.
      const names = (t: Transaction) => Number(STUDENT_FINANCE.test(`${t.payee ?? ''} ${t.counterpartyName ?? ''} ${t.description}`));
      const credit = credits
        .filter((t) => !opts.taken.has(t.id) && toMinor(t.amount) === toMinor(p.amount) && Math.abs(diffDays(t.date, p.date)) <= AGREEMENT_RECEIPT_DAYS)
        .sort((a, b) => names(b) - names(a) || Math.abs(diffDays(a.date, p.date)) - Math.abs(diffDays(b.date, p.date)))[0];
      const other = credit ? store.account(credit.accountId) : undefined;
      if (credit && other) {
        opts.taken.add(credit.id);
        transferMatch = credit.id;
        counterpartyAccountId = credit.accountId;
        category = transferLegCategory(loanType, other.type, -p.amount);
        categorisedBy = 'transfer';
      }
    }
    return {
      key: `${opts.keyPrefix}-t${i}`,
      include: dup.status === 'new',
      status: dup.status,
      date: p.date,
      amount: -p.amount,
      description,
      payee,
      ...(dup.duplicateOf ? { duplicateOf: dup.duplicateOf } : {}),
      ...(category ? { category } : {}),
      ...(categorisedBy ? { categorisedBy } : {}),
      ...(counterpartyAccountId ? { counterpartyAccountId } : {}),
      ...(transferMatch ? { transferMatch } : {}),
      row: i,
    };
  });
}

/**
 * The jobs a document's items are about: items naming one PAYE reference, or one employer once
 * names are reduced, are one job. Each is matched to a job of yours, else set up as a new one.
 */
function documentJobs(store: Store, items: { ref: string; who: JobIdentity }[], figures: Extraction['figures'] = []): { jobs: DraftJob[]; jobKeyOf: Map<string, string> } {
  const groups: { who: JobIdentity; names: Set<string>; refs: string[] }[] = [];
  for (const it of items) {
    const key = payerKey(it.who.employer);
    const paye = payeReference(it.who.payeReference);
    let g = groups.find((x) => (paye && payeReference(x.who.payeReference) === paye) || (key && x.names.has(key)));
    if (!g) groups.push((g = { who: { employer: it.who.employer }, names: new Set(), refs: [] }));
    g.refs.push(it.ref);
    if (key) g.names.add(key);
    g.who = { employer: g.who.employer || it.who.employer, payeReference: payeReference(g.who.payeReference) ?? paye, payrollNumber: g.who.payrollNumber ?? it.who.payrollNumber };
  }
  const taken = new Set(store.employments.map((e) => e.id));
  const jobKeyOf = new Map<string, string>();
  const jobs = groups.map((g, i): DraftJob => {
    const key = `j${i}`;
    for (const r of g.refs) jobKeyOf.set(r, key);
    const m = matchEmployment(store.employments, g.who) ?? matchByPayment(store, g.refs.flatMap((r) => (r.startsWith('f') ? [figures[Number(r.slice(1))]!] : [])));
    const id = m ? m.employment.id : newEmploymentId(g.who.employer, taken);
    taken.add(id);
    return {
      key,
      employer: g.who.employer,
      ...(g.who.payeReference ? { payeReference: g.who.payeReference } : {}),
      ...(g.who.payrollNumber ? { payrollNumber: g.who.payrollNumber } : {}),
      ...(m ? { matchedBy: m.by } : {}),
      target: m ? { mode: 'existing', employmentId: id } : { mode: 'new', employment: { id, employer: g.who.employer } },
    };
  });
  return { jobs, jobKeyOf };
}

/**
 * A payslip's job by HMRC's record of the payment it is: a stored payment in the same tax year with
 * the same tax, to the penny and not £0, and the same taxable pay (its gross, or its gross less the
 * pension taken before tax). Two jobs' payments that agree to the penny on both are not a coincidence;
 * a payslip that prints a group's name rather than the employer's is still its job's.
 */
function matchByPayment(store: Store, figures: Extraction['figures']): { employment: Employment; by: 'hmrc' } | undefined {
  const sum = (kind: string) => figures.filter((f) => f.kind === kind).reduce((x, f) => x + toMinor(f.amount), 0);
  const tax = sum('tax_deducted');
  const gross = sum('gross_pay');
  if (!tax || !figures.some((f) => f.kind === 'gross_pay')) return undefined;
  const taxable = [gross, gross - sum('pension_contribution_employee')];
  const years = new Set(figures.flatMap((f) => (f.taxYear ? [f.taxYear] : [])));
  const jobs = new Set(
    store.hmrc.flatMap((r) => (r.type === 'payment' && r.employmentId && (!years.size || years.has(r.taxYear)) && toMinor(r.tax) === tax && taxable.includes(toMinor(r.taxablePay)) ? [r.employmentId] : [])),
  );
  const only = jobs.size === 1 ? store.employment([...jobs][0]) : undefined;
  return only ? { employment: only, by: 'hmrc' } : undefined;
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
  if (!draft.sections.length && !draft.figures.length && !draft.hmrc?.length && !draft.payslips?.length) reasons.push('nothing extracted');
  if (draft.jobs?.some((j) => j.target.mode === 'new' && [...draft.figures, ...(draft.hmrc ?? []), ...(draft.payslips ?? [])].some((x) => x.include && x.jobKey === j.key))) reasons.push('sets up a new job');
  if (draft.figures.some((f) => f.include && f.replaces)) reasons.push('replaces earned pay recorded from an earlier upload');
  return { clean: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function uploadDay(): string {
  return today();
}
