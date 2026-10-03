// Commit a reviewed draft: create accounts, write transactions / balances / holdings / figures, link
// transfers, archive the original document and record the import. Everything lands in one git commit.

import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import { linkedPayee, transferLegCategory } from '../../shared/categorise';
import { fullerName } from '../../shared/funds';
import { catalogInstitution, findInstitution } from '../../shared/institutions';
import { tidyPlace } from '../../shared/places';
import { formatMoney, fromMinor, toMinor } from '../../shared/money';
import { taxYearOf } from '../../shared/uk';
import { detailToAdd, fillIn, seenInEntry, stillAdds } from '../../shared/detail';
import { sameTerms, termsOfReading } from '../../shared/terms';
import type { Account, Agreement, BalanceSnapshot, DetailField, Draft, DraftSection, Employment, Extraction, Figure, HmrcRecord, Holding, HoldingsSnapshot, ImportRecord, PayslipRecord, Terms, Transaction } from '../../shared/schema';
import { AccountSchema, AgreementSchema, BalanceSnapshotSchema, DraftSchema, EmploymentSchema, FigureSchema, HmrcRecordSchema, HoldingsSnapshotSchema, PayslipRecordSchema, TermsSchema, TransactionSchema } from '../../shared/schema';
import { learn, learnFromPayslip, matchEmployment } from '../employments';
import { scheduledPatches } from '../analytics/agreements';
import { payeReference } from '../analytics/sources';
import { nowISO, safeFileName } from '../fsutil';
import { balanceId, figureId, hmrcId, holdingsId, payslipId, termsId, transactionId, transferGroupId } from '../ids';
import { categoriserFor } from '../categoriser';
import { linkTransfers, rederive, salaryByPayroll } from '../enrich';
import { StoreError, type Store } from '../store';
import { hasYourChanges } from './dedup';
import { sameHolding } from './match';
import { mergeSchedule, recordedAs } from './schedules';

export interface CommitInput {
  record: ImportRecord;
  draft: Draft;
  /** Absolute path of the uploaded file in the work area. */
  workFile: string;
  /**
   * The import adds nothing new (./novelty.ts): the document is archived and the record says why,
   * and nothing else is written, not even the last digits an account could learn from it.
   */
  nothingNew?: string | undefined;
  /** Filled in with the transaction each recorded row became (row key → transaction id). */
  rowIds?: Map<string, string>;
}

function balanceKind(draft: Draft, mediaType: string): BalanceSnapshot['kind'] {
  if (draft.documentType === 'csv_export') return 'export';
  if (mediaType.startsWith('image/')) return 'screenshot';
  return 'statement';
}

/**
 * Whether you typed or changed a section's balance while reviewing: it is not what the draft
 * proposed. A draft from before `readBalance` is compared with the reading itself, sign aside (the
 * draft turns a balance owed negative); with no reading kept, it is not known and so not yours.
 */
export function balanceByYou(section: Pick<DraftSection, 'key' | 'balance' | 'readBalance'>, reading: Extraction | undefined): boolean {
  if (section.balance === undefined) return false;
  if (section.readBalance !== undefined) return section.readBalance === null || toMinor(section.readBalance) !== toMinor(section.balance);
  if (!reading) return false;
  const read = reading.accounts[Number(section.key.slice(1))]?.closingBalance;
  return read === null || read === undefined || Math.abs(toMinor(read)) !== Math.abs(toMinor(section.balance));
}

/**
 * When on its day an imported balance was seen (`BalanceSnapshot.at`): one you gave for the day you
 * gave it is as of then, like your own balance; a screenshot's is when it was taken; a statement's
 * or an export's is the day's close (none).
 */
export function balanceSeenAt(date: string, kind: BalanceSnapshot['kind'], byYou: boolean, capturedAt: string | undefined, stamp: string): string | undefined {
  if (byYou && stamp.slice(0, 10) === date) return stamp;
  if (kind === 'screenshot' && capturedAt?.slice(0, 10) === date) return capturedAt;
  return undefined;
}

export async function commitDraft(store: Store, input: CommitInput): Promise<ImportRecord> {
  const draft = DraftSchema.parse(input.draft);
  const { record, nothingNew } = input;
  const stamp = nowISO();
  const source = { importId: record.id, documentId: record.document.id };
  const accountsCreated: string[] = [];
  const accountIds: string[] = [];

  // Everything is built and validated first; nothing is written until all of it passes. Writes then
  // follow in dependency order, and ids are derived from the import so a retry is idempotent.
  // 1. Accounts (and institutions) that need creating.
  const resolved = new Map<string, Account>();
  const toCreate: { account: Account; institution?: { id: string; name: string; kind: string; fscsGroup?: string } }[] = [];
  // An existing account set up without its number learns the last digits its statement shows, so
  // the next statement matches it by itself.
  const toLearn: Account[] = [];
  for (const section of draft.sections) {
    if (section.target.mode === 'skip') continue;
    if (section.target.mode === 'existing') {
      const acc = store.account(section.target.accountId);
      if (!acc) throw new StoreError(`Account "${section.target.accountId}" no longer exists`, 409);
      resolved.set(section.key, acc);
      const last4 = section.detected.last4;
      const learnt = toLearn.find((a) => a.id === acc.id) ?? acc;
      const learn: Partial<Account> = {};
      if (!nothingNew && !learnt.last4 && last4 && /^\d{2,6}$/.test(last4)) learn.last4 = last4;
      // A Space whose move you left out is remembered, so a row that shows only its name is known.
      const spaces = [...new Set(section.transactions.filter((t) => t.insideAccount && !t.include).map((t) => t.insideAccount!))].filter((name) => !learnt.spaces?.some((x) => x.toLowerCase() === name.toLowerCase()));
      if (spaces.length) learn.spaces = [...(learnt.spaces ?? []), ...spaces];
      if (Object.keys(learn).length) {
        const next = AccountSchema.parse({ ...learnt, ...learn, updatedAt: stamp });
        toLearn.splice(0, toLearn.length, ...toLearn.filter((a) => a.id !== acc.id), next);
      }
      continue;
    }
    const input = section.target.account;
    let institutionId = input.institutionId;
    if (!institutionId && input.institutionName) {
      const cat = findInstitution(input.institutionName);
      institutionId = cat?.id ?? slugify(input.institutionName, store.institutions.map((i) => i.id));
    }
    let institution: (typeof toCreate)[number]['institution'];
    if (institutionId && !store.institution(institutionId)) {
      const cat = catalogInstitution(institutionId);
      institution = { id: institutionId, name: cat?.name ?? input.institutionName ?? institutionId, kind: cat?.kind ?? 'bank', ...(cat?.fscsGroup ? { fscsGroup: cat.fscsGroup } : {}) };
    }
    const taken = [...store.accounts.map((a) => a.id), ...toCreate.map((x) => x.account.id)];
    const id = taken.includes(input.id) ? slugify(input.id, taken) : input.id;
    const account: Account = {
      id,
      name: input.name,
      type: input.type,
      currency: input.currency,
      status: 'open',
      aliases: [],
      includeInNetWorth: ACCOUNT_TYPE_META[input.type].defaultInNetWorth,
      createdAt: stamp,
      updatedAt: stamp,
      ...(institutionId ? { institutionId } : {}),
      ...(input.last4 ? { last4: input.last4 } : {}),
      ...(input.openedOn ? { openedOn: input.openedOn } : {}),
      ...(input.closedOn ? { status: 'closed' as const, closedOn: input.closedOn } : {}),
    };
    AccountSchema.parse(account);
    toCreate.push({ account, ...(institution ? { institution } : {}) });
    accountsCreated.push(id);
    resolved.set(section.key, account);
  }

  // 2. Transactions.
  const newTx: Transaction[] = [];
  const transferLinks: { newId: string; otherId: string; account: Account }[] = [];
  // Rows linked by you to a row of another import waiting for review: kept for that link (./links.ts).
  const heldForLink = new Set<string>();
  const byKey = new Map<string, { tx: Transaction; row: Draft['sections'][number]['transactions'][number]; account: Account }>();
  let skipped = 0;
  for (const section of draft.sections) {
    const account = resolved.get(section.key);
    if (!account) continue;
    accountIds.push(account.id);
    const occurrences = new Map<string, number>();
    for (const row of section.transactions) {
      if (!row.include) {
        skipped++;
        continue;
      }
      const base = `${row.date}|${row.amount}|${row.description}`;
      let occurrence = occurrences.get(base) ?? 0;
      let id = transactionId(account.id, row.date, row.amount, row.description, occurrence, record.id);
      while (newTx.some((t) => t.id === id)) id = transactionId(account.id, row.date, row.amount, row.description, ++occurrence, record.id);
      occurrences.set(base, occurrence + 1);
      const tx: Transaction = {
        id,
        accountId: account.id,
        date: row.date,
        amount: row.amount,
        currency: section.currency,
        description: row.description,
        ...(row.detail ?? {}),
        ...(tidyPlace(row.detail?.merchant) ? { place: tidyPlace(row.detail?.merchant) } : {}),
        ...(row.balanceAfter !== undefined ? { balanceAfter: row.balanceAfter } : {}),
        ...(row.original ? { original: row.original } : {}),
        ...(row.pending ? { pending: true } : {}),
        ...(row.payee ? { payee: row.payee } : {}),
        ...(row.category ? { category: row.category } : {}),
        ...(row.categorisedBy ? { categorisedBy: row.categorisedBy } : {}),
        ...(row.ruleId ? { ruleId: row.ruleId } : {}),
        ...(row.counterpartyAccountId ? { counterpartyAccountId: row.counterpartyAccountId } : {}),
        source: { ...source, ...(row.row !== undefined ? { row: row.row } : {}) },
        createdAt: stamp,
      };
      // Not one another transfer has taken since the draft was made.
      const match = row.transferMatch ? store.transaction(row.transferMatch) : undefined;
      if (match && !match.transferGroup && match.accountId !== account.id && !transferLinks.some((l) => l.otherId === match.id)) {
        tx.transferGroup = transferGroupId(id, match.id);
        transferLinks.push({ newId: id, otherId: match.id, account });
        // A payee naming another account of yours than the one it is linked with takes that one's name.
        const other = store.account(match.accountId);
        const payee = other ? linkedPayee(tx, other, store.accounts) : undefined;
        if (payee) tx.payee = payee;
      }
      if (row.pendingLink && row.pendingLink.importId !== record.id) heldForLink.add(id);
      byKey.set(row.key, { tx, row, account });
      newTx.push(tx);
    }
  }

  // Rows of this import you linked to each other (two accounts' rows of one document): linked now.
  for (const { tx, row, account } of byKey.values()) {
    const link = row.pendingLink;
    if (!link || link.importId !== record.id || tx.transferGroup) continue;
    const other = byKey.get(link.key);
    if (!other || other.tx.transferGroup || other.account.id === account.id || other.row.pendingLink?.key !== row.key) continue;
    const group = transferGroupId(tx.id, other.tx.id);
    for (const [a, b] of [
      [{ tx, row, account }, other],
      [other, { tx, row, account }],
    ] as const) {
      a.tx.transferGroup = group;
      a.tx.counterpartyAccountId = b.account.id;
      const payee = linkedPayee(a.tx, b.account, [...store.accounts, ...toCreate.map((x) => x.account)]);
      if (payee) a.tx.payee = payee;
      if (a.row.categorisedBy !== 'user') {
        a.tx.category = transferLegCategory(a.account.type, b.account.type, a.tx.amount);
        a.tx.categorisedBy = 'transfer';
        delete a.tx.ruleId;
      }
    }
  }
  if (input.rowIds) for (const [key, { tx }] of byKey) input.rowIds.set(key, tx.id);

  // 2b. Copies of payments recorded twice that the document shows once, ticked to be taken away
  // (the draft's `extraCopies`). Each is checked again: both copies still there, in this account, on
  // the same day for the same amount, and nothing of yours on the one going. Not when rows of this
  // import match both (it shows the payment twice), or a row matched to either is ticked in (you
  // counted it as a different payment).
  const removals: Transaction[] = [];
  if (!nothingNew) {
    const withReceipts = new Set(store.receipts.map((r) => r.transactionId));
    for (const section of draft.sections) {
      const account = resolved.get(section.key);
      if (!account || section.target.mode !== 'existing') continue;
      const matched = new Set(section.transactions.flatMap((r) => (!r.include && r.duplicateOf ? [r.duplicateOf] : [])));
      const counted = new Set(section.transactions.flatMap((r) => (r.include && r.duplicateOf ? [r.duplicateOf] : [])));
      for (const c of section.extraCopies ?? []) {
        if (!c.remove) continue;
        const gone = store.transaction(c.transactionId);
        const kept = store.transaction(c.keepId);
        if (!gone || !kept || gone.id === kept.id || removals.some((t) => t.id === gone.id)) continue;
        if (gone.accountId !== account.id || kept.accountId !== account.id || gone.date !== kept.date || toMinor(gone.amount) !== toMinor(kept.amount)) continue;
        if (hasYourChanges(gone, withReceipts) || (matched.has(gone.id) && matched.has(kept.id)) || counted.has(gone.id) || counted.has(kept.id)) continue;
        removals.push(gone);
      }
    }
  }

  // 2c. Details a document adds to payments already recorded (rows' `adds`, as you ticked them):
  // worked out again against the record as it is now, keeping only what you saw and what is still
  // empty. Not for a row ticked in as a payment of its own, nor a copy being taken away. The first
  // row matched to a record fills it in.
  const detailed: { t: Transaction; patch: Partial<Transaction>; added: DetailField[] }[] = [];
  if (!nothingNew) {
    const categoriser = categoriserFor(store);
    for (const section of draft.sections) {
      const account = resolved.get(section.key);
      if (!account || section.target.mode !== 'existing') continue;
      for (const row of section.transactions) {
        if (row.include || !row.adds?.include || !row.duplicateOf) continue;
        const recorded = store.transaction(row.duplicateOf);
        if (!recorded || recorded.accountId !== account.id || toMinor(recorded.amount) !== toMinor(row.amount)) continue;
        if (removals.some((t) => t.id === recorded.id) || detailed.some((d) => d.t.id === recorded.id)) continue;
        const now = detailToAdd(row, recorded);
        const { patch, added } = fillIn(recorded, stillAdds(row.adds.fields, now.fields));
        if (!added.length) continue;
        // What this document calls it is kept with it (seen in), and counts in working out its payee
        // and category: a statement's "Outgoing transaction" takes the app's "ALDI".
        const seenIn = [...(recorded.seenIn ?? []), seenInEntry({ ...source, row: row.row }, added, now.differs, stamp)];
        const merged: Transaction = { ...recorded, ...patch, seenIn };
        if (added.includes('merchant')) {
          const place = tidyPlace(merged.merchant);
          if (place !== recorded.place) patch.place = place;
        }
        const named = now.differs.some((d) => d.field === 'description');
        Object.assign(patch, rederive(categoriser, merged, named ? [...added, 'seenIn'] : added));
        patch.seenIn = seenIn;
        detailed.push({ t: recorded, patch, added });
      }
    }
  }

  // 3. Balances, holdings, figures.
  const balances: BalanceSnapshot[] = [];
  const holdings: HoldingsSnapshot[] = [];
  const replacedHoldings: string[] = [];
  for (const section of draft.sections) {
    const account = resolved.get(section.key);
    if (!account || !section.balanceDate) continue;
    if (section.recordBalance && section.balance !== undefined) {
      const kind = balanceKind(draft, record.document.mediaType);
      const byYou = balanceByYou(section, record.extraction.raw);
      const at = balanceSeenAt(section.balanceDate, kind, byYou, record.document.capturedAt, stamp);
      balances.push({
        id: balanceId(account.id, section.balanceDate, section.balance, 'import', record.id),
        accountId: account.id,
        date: section.balanceDate,
        balance: section.balance,
        currency: section.currency,
        kind,
        source,
        createdAt: stamp,
        ...(at ? { at } : {}),
        ...(byYou ? { enteredBy: 'user' as const } : {}),
        ...(section.balanceDateSource ? { dateSource: section.balanceDateSource } : {}),
        ...(section.availableBalance !== undefined ? { availableBalance: section.availableBalance } : {}),
        ...(section.contributions !== undefined ? { contributions: section.contributions } : {}),
        ...(section.gain !== undefined ? { gain: section.gain } : {}),
        ...(section.cash !== undefined ? { cash: section.cash } : {}),
        ...(section.bonusToDate !== undefined ? { bonusToDate: section.bonusToDate } : {}),
        ...(section.annualIncome !== undefined ? { annualIncome: section.annualIncome } : {}),
        ...(section.taxYearContributions !== undefined
          ? { taxYearContributions: section.taxYearContributions, taxYear: taxYearOf(section.balanceDate).label }
          : {}),
      });
    }
    if (section.recordHoldings && section.holdings.length) {
      // Screenshots of one account on one day (a list scrolled in parts, one fund's own page) are
      // one set of holdings: they merge into what that day already has instead of replacing it.
      const date = section.balanceDate;
      const sameDay = [...store.holdings(account.id), ...holdings.filter((h) => h.accountId === account.id)].filter((h) => h.date === date);
      const prior = sameDay.at(-1);
      // A partial list adds to the day's holdings; a complete one replaces them, keeping only the
      // extra figures the earlier screens had for the funds it still lists.
      const list = !prior ? section.holdings : section.holdingsPartial ? mergeHoldings(prior.holdings, section.holdings) : mergeHoldings(prior.holdings.filter((h) => section.holdings.some((n) => sameHolding(h, n))), section.holdings);
      const cash = section.cash ?? prior?.cash;
      // The total is the value shown, else a value already recorded for that day, else what the holdings come to.
      const dayValue = section.balance ?? [...balances, ...store.balances(account.id)].find((b) => b.accountId === account.id && b.date === date && !b.approximate)?.balance;
      const total = dayValue ?? fromMinor(list.reduce((s, h) => s + toMinor(h.value), 0) + toMinor(cash ?? 0));
      for (const h of sameDay) {
        const i = holdings.indexOf(h);
        if (i >= 0) holdings.splice(i, 1);
        else replacedHoldings.push(h.id);
      }
      holdings.push({
        id: holdingsId(account.id, date, total, record.id),
        accountId: account.id,
        date,
        holdings: list,
        totalValue: Math.round(total * 100) / 100,
        source,
        createdAt: stamp,
        ...(cash !== undefined ? { cash } : {}),
      });
    }
  }
  // 3b. Jobs: the job of yours each draft job is, or a new one, and what an existing job learns from
  // the document (another name, its PAYE reference, a payroll number). Only a job something ticked
  // is about is set up or changed.
  const used = new Set([...draft.figures, ...(draft.hmrc ?? []), ...(draft.payslips ?? [])].flatMap((x) => (x.include && x.jobKey ? [x.jobKey] : [])));
  const jobIds = new Map<string, string>();
  const jobsToWrite = new Map<string, Employment>();
  const employmentsCreated: string[] = [];
  for (const job of draft.jobs ?? []) {
    if (!used.has(job.key)) continue;
    const who = { employer: job.employer, payeReference: job.payeReference, payrollNumber: job.payrollNumber };
    const attach = (e: Employment) => {
      const next = learn(e, who);
      if (JSON.stringify(next) !== JSON.stringify(e)) jobsToWrite.set(e.id, { ...next, updatedAt: stamp });
      jobIds.set(job.key, e.id);
    };
    if (job.target.mode === 'existing') {
      const e = jobsToWrite.get(job.target.employmentId) ?? store.employment(job.target.employmentId);
      if (!e) throw new StoreError(`The job "${job.target.employmentId}" no longer exists`, 409);
      attach(e);
    } else {
      // The job this draft would set up may have been set up since the draft was made, by another
      // document about the same employer: its id is taken by a job this employer is (and no other
      // PAYE reference says otherwise). Then it is that job, not a second one.
      const since = jobsToWrite.get(job.target.employment.id) ?? store.employment(job.target.employment.id);
      const ref = payeReference(who.payeReference);
      if (since && matchEmployment([since], who) && !(ref && since.payeReference && since.payeReference !== ref)) {
        attach(since);
        continue;
      }
      const taken = [...store.employments.map((e) => e.id), ...jobsToWrite.keys()];
      const id = taken.includes(job.target.employment.id) ? slugify(job.target.employment.id, taken) : job.target.employment.id;
      const fresh = EmploymentSchema.parse({ id, employer: job.target.employment.employer, aliases: [], payrollNumbers: [], owed: [], createdBy: 'import', createdAt: stamp, updatedAt: stamp });
      jobsToWrite.set(id, learn(fresh, who));
      employmentsCreated.push(id);
      jobIds.set(job.key, id);
    }
  }
  const jobOf = (key: string | undefined) => (key ? jobIds.get(key) : undefined);
  const figures: Figure[] = draft.figures
    .filter((f) => f.include)
    .map((f) => ({
      id: figureId(f.kind, f.amount, f.taxYear ?? f.periodEnd ?? '', f.payer ?? '', f.label, record.id),
      kind: f.kind,
      label: f.label,
      amount: f.amount,
      currency: f.currency,
      source,
      createdAt: stamp,
      ...(f.periodStart ? { periodStart: f.periodStart } : {}),
      ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}),
      ...(f.taxYear ? { taxYear: f.taxYear } : {}),
      ...(draft.documentDate ? { date: draft.documentDate } : {}),
      ...(f.accountId ? { accountId: f.accountId } : {}),
      ...(f.payer ? { payer: f.payer } : {}),
      ...(f.payerReference ? { payerReference: f.payerReference } : {}),
      ...(f.taxCode ? { taxCode: f.taxCode } : {}),
      ...(f.paidBy && f.paidBy !== f.payer ? { paidBy: f.paidBy } : {}),
      ...(f.work ? { work: f.work } : {}),
      ...(jobOf(f.jobKey) ? { employmentId: jobOf(f.jobKey)! } : {}),
    }));
  // HMRC's records, under their job: an id from what each says, so one read twice is stored once. A
  // State Pension forecast is on your State Pension account, when you have the one.
  const statePensions = store.accounts.filter((a) => a.type === 'state_pension' && a.status === 'open');
  const hmrcRecords: HmrcRecord[] = (draft.hmrc ?? [])
    .filter((h) => h.include)
    .map((h) =>
      HmrcRecordSchema.parse({
        ...h.record,
        id: hmrcId(h.record),
        ...(jobOf(h.jobKey) ? { employmentId: jobOf(h.jobKey)! } : {}),
        ...(h.record.type === 'state-pension-forecast' && statePensions.length === 1 ? { accountId: statePensions[0]!.id } : {}),
        source,
        createdAt: stamp,
      }),
    );
  const hmrcFresh = hmrcRecords.filter((r) => !store.hmrc.some((x) => x.id === r.id));
  // Payslips in full, under their job: an id from what identifies each, so one read twice is stored once.
  const payslipRecords: PayslipRecord[] = (draft.payslips ?? [])
    .filter((p) => p.include)
    .map((p) => PayslipRecordSchema.parse({ ...p.record, id: payslipId(p.record), ...(jobOf(p.jobKey) ? { employmentId: jobOf(p.jobKey)! } : {}), taxYear: taxYearOf(p.record.payDate).label, source, createdAt: stamp }));
  const payslipsFresh = payslipRecords.filter((r, i) => !store.payslips.some((x) => x.id === r.id) && payslipRecords.findIndex((x) => x.id === r.id) === i);
  // Each payslip's job learns what it prints: its payroll number, and every name on it (a group's).
  for (const p of payslipRecords) {
    if (!p.employmentId) continue;
    const e = jobsToWrite.get(p.employmentId) ?? store.employment(p.employmentId);
    if (!e) continue;
    const next = learnFromPayslip(e, p);
    if (JSON.stringify(next) !== JSON.stringify(e)) jobsToWrite.set(e.id, { ...next, updatedAt: stamp });
  }
  // A forecast with no balance (a State Pension forecast) is its income per year on its account
  // (FORMULAS.md §9). With a balance, the balance carries it.
  for (const section of draft.sections) {
    const account = resolved.get(section.key);
    if (!account || section.annualIncome === undefined || !section.balanceDate || (section.recordBalance && section.balance !== undefined)) continue;
    figures.push({
      id: figureId('pension_income_forecast', section.annualIncome, section.balanceDate, account.id, 'Forecast income per year', record.id),
      kind: 'pension_income_forecast',
      label: 'Forecast income per year',
      amount: section.annualIncome,
      currency: section.currency,
      date: section.balanceDate,
      accountId: account.id,
      source,
      createdAt: stamp,
    });
  }

  // Validate everything before the first write.
  for (const t of newTx) TransactionSchema.parse(t);
  for (const { t, patch } of detailed) TransactionSchema.parse(Object.fromEntries(Object.entries({ ...t, ...patch }).filter(([, v]) => v !== undefined)));
  for (const b of balances) BalanceSnapshotSchema.parse(b);
  for (const h of holdings) HoldingsSnapshotSchema.parse(h);
  for (const f of figures) FigureSchema.parse(f);
  for (const e of jobsToWrite.values()) EmploymentSchema.parse(e);

  // 4. Write.
  for (const account of toLearn) await store.upsertAccount(account);
  for (const { account, institution } of toCreate) {
    if (institution && !store.institution(institution.id)) await store.upsertInstitution(institution as Parameters<Store['upsertInstitution']>[0]);
    if (!store.account(account.id)) await store.upsertAccount(account);
  }
  const label = record.document.fileName;
  const removed = removals.length ? await store.deleteTransactions(removals.map((t) => t.id), `import: ${label} (−${removals.length} recorded twice)`) : 0;
  const added = newTx.length ? await store.addTransactions(newTx, `import: ${label} (+${newTx.length} transactions)`) : 0;
  if (detailed.length) {
    await store.updateTransactions(
      detailed.map(({ t, patch }) => ({ id: t.id, patch })),
      `import: ${label} (details added to ${detailed.length} recorded payment${detailed.length === 1 ? '' : 's'})`,
    );
    // Now it says more about where it went, a row may be one leg of a transfer already recorded.
    await linkTransfers(
      store,
      detailed.filter(({ t, patch }) => 'category' in patch && !t.transferGroup).map(({ t }) => t.id),
      `import: ${label} (transfers linked)`,
    );
  }
  if (transferLinks.length) {
    await store.updateTransactions(
      transferLinks.map(({ newId, otherId, account }) => {
        const other = store.transaction(otherId)!;
        const otherAccount = store.account(other.accountId)!;
        const patch: Partial<Transaction> = { transferGroup: transferGroupId(newId, otherId), counterpartyAccountId: account.id };
        if (other.categorisedBy !== 'user') {
          patch.category = transferLegCategory(otherAccount.type, account.type, other.amount);
          patch.categorisedBy = 'transfer';
        }
        const payee = linkedPayee(other, account, store.accounts);
        if (payee) patch.payee = payee;
        return { id: otherId, patch };
      }),
      `import: link ${transferLinks.length} transfer(s)`,
    );
  }
  // The other leg of a transfer may already be stored, from another account's statement: link it.
  await linkTransfers(
    store,
    newTx.filter((t) => !t.transferGroup && !heldForLink.has(t.id)).map((t) => t.id),
    `import: ${label} (transfers linked)`,
  );
  // Each account's terms on the day the document gives them for (its rates, its limit and a card's
  // minimum payment), kept whether or not its balance is; not when the same terms are given already.
  const termsFresh: Terms[] = [];
  if (!nothingNew) {
    for (const section of draft.sections) {
      const account = resolved.get(section.key);
      const asOf = section.balanceDate ?? section.periodEnd ?? draft.documentDate;
      const content = account && asOf ? termsOfReading(section, account.type) : undefined;
      if (!account || !asOf || !content) continue;
      if ([...store.terms(account.id), ...termsFresh].some((t) => t.accountId === account.id && t.asOf === asOf && sameTerms(t, content))) continue;
      termsFresh.push(TermsSchema.parse({ id: termsId(account.id, asOf, source), accountId: account.id, asOf, ...content, source, createdAt: stamp }));
    }
  }
  const balancesAdded = balances.length ? await store.addBalances(balances, `import: ${label} balance`) : 0;
  if (termsFresh.length) await store.upsertRecords('terms', termsFresh, `import: ${label} terms`);
  const termsAdded = termsFresh.length;
  const holdingsAdded = holdings.length ? await store.addHoldings(holdings, `import: ${label} holdings`, replacedHoldings) : 0;
  // A payroll number the document taught a job: the pay already recorded with it, uncategorised, is salary.
  const learned = [...jobsToWrite.values()].flatMap((e) => e.payrollNumbers.filter((n) => !(store.employment(e.id)?.payrollNumbers ?? []).includes(n)));
  for (const e of jobsToWrite.values()) await store.upsertEmployment(e, `import: ${label} (job ${e.employer})`);
  const salaried = learned.length ? await salaryByPayroll(store, learned, `import: ${label} (pay with a payroll number it gave is salary)`) : 0;
  const figuresAdded = figures.length ? await store.addFigures(figures, `import: ${label} figures`) : 0;
  if (hmrcFresh.length) await store.upsertRecords('hmrc', hmrcFresh, `import: ${label} HMRC records`);
  const hmrcAdded = hmrcFresh.length;
  if (payslipsFresh.length) await store.upsertRecords('payslips', payslipsFresh, `import: ${label} payslips`);
  const payslipsAdded = payslipsFresh.length;
  // The schedules it gives, as agreements: new ones, or what they add to one recorded already (laid
  // over it again now, as it may have changed since the draft). An account a schedule pays through
  // that this import creates takes its final id. Then the payments already recorded that each one
  // schedules take its category, as the categoriser will file those to come.
  let agreementsAdded = 0;
  if (!nothingNew) {
    const finalId = (id: string | undefined) => {
      const section = id ? draft.sections.find((x) => x.target.mode === 'new' && x.target.account.id === id) : undefined;
      return (section ? resolved.get(section.key)?.id : undefined) ?? id;
    };
    for (const d of draft.agreements ?? []) {
      if (!d.include) continue;
      const accountId = finalId(d.record.accountId);
      const record = { ...d.record, ...(accountId ? { accountId } : {}) };
      // One recorded meanwhile with the same schedule (another document of it, committed first) is filled in, not made twice.
      const base = d.target.mode === 'existing' ? store.agreement(d.target.agreementId) : recordedAs(store.agreements, record);
      let agreement: Agreement;
      if (base) {
        const { merged } = mergeSchedule(base, record);
        agreement = AgreementSchema.parse({ ...merged, createdBy: base.createdBy, createdAt: base.createdAt, updatedAt: stamp });
      } else {
        const taken = store.agreements.map((a) => a.id);
        const id = taken.includes(record.id) ? slugify(record.id, taken) : record.id;
        agreement = AgreementSchema.parse({ ...record, id, source, createdBy: 'owner', createdAt: stamp, updatedAt: stamp });
      }
      await store.upsertAgreement(agreement, `import: ${label} agreement ${agreement.name}`);
      agreementsAdded++;
      const files = scheduledPatches(store, agreement, categoriserFor(store));
      if (files.length) await store.updateTransactions(files.map(({ t, patch }) => ({ id: t.id, patch })), `import: ${label} (${files.length} payment${files.length === 1 ? '' : 's'} ${agreement.name} schedules filed)`);
    }
  }

  const sha = record.document.sha256;
  const docPath = await store.storeDocument(input.workFile, sha, safeFileName(record.document.fileName));
  const committed: ImportRecord = {
    ...record,
    status: 'committed',
    updatedAt: stamp,
    committedAt: stamp,
    document: { ...record.document, path: docPath },
    draft,
    result: {
      accountIds: [...new Set(accountIds)],
      accountsCreated,
      transactionsAdded: added,
      transactionsSkipped: skipped,
      balancesAdded,
      holdingsAdded,
      figuresAdded,
      ...(hmrcAdded ? { hmrcAdded } : {}),
      ...(payslipsAdded ? { payslipsAdded } : {}),
      ...(termsAdded ? { termsAdded } : {}),
      ...(agreementsAdded ? { agreementsAdded } : {}),
      ...(employmentsCreated.length ? { employmentsCreated } : {}),
      ...(jobIds.size ? { jobs: [...jobIds].map(([key, employmentId]) => ({ key, employmentId })) } : {}),
      ...(nothingNew ? { nothingNew: nothingNew.slice(0, 500) } : {}),
      ...(detailed.length ? { transactionsDetailed: detailed.map(({ t, added }) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, added })) } : {}),
      ...(removed ? { transactionsRemoved: removals.map((t) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, ...(t.source.importId ? { importId: t.source.importId } : {}) })) } : {}),
      sections: draft.sections.flatMap((s) => {
        const account = resolved.get(s.key);
        return account ? [{ key: s.key, accountId: account.id }] : [];
      }),
    },
  };
  const names = [...new Set(accountIds)].map((id) => store.account(id)?.name ?? id).join(', ');
  const bits = [
    added ? `+${added} txns` : '',
    removed ? `−${removed} recorded twice` : '',
    detailed.length ? `details on ${detailed.length}` : '',
    balances[0] ? `balance ${formatMoney(balances[0].balance, { currency: balances[0].currency })}` : '',
    holdingsAdded ? 'holdings' : '',
    figuresAdded ? `${figuresAdded} figures` : '',
    hmrcAdded ? `${hmrcAdded} HMRC record${hmrcAdded === 1 ? '' : 's'}` : '',
    payslipsAdded ? `${payslipsAdded} payslip${payslipsAdded === 1 ? '' : 's'} in full` : '',
    termsAdded ? 'terms' : '',
    agreementsAdded ? `${agreementsAdded} agreement${agreementsAdded === 1 ? '' : 's'}` : '',
    employmentsCreated.length ? `${employmentsCreated.length} new job${employmentsCreated.length === 1 ? '' : 's'}` : '',
    salaried ? `${salaried} payment${salaried === 1 ? '' : 's'} with its payroll number now salary` : '',
  ].filter(Boolean);
  const message = nothingNew ? `import: ${label} filed, nothing new` : `import: ${label} → ${names || 'figures'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  await store.saveImport(committed, message, [docPath]);
  return committed;
}

/**
 * Holdings of one account on one day, from several screens: each holding is matched across them
 * (ISIN, ticker or name) and the later screen's figures win, while figures only the earlier one
 * showed (units on a fund's own page, say) are kept.
 */
export function mergeHoldings(prior: Holding[], next: Holding[]): Holding[] {
  const out = prior.map((h) => ({ ...h }));
  for (const n of next) {
    const i = out.findIndex((h) => sameHolding(h, n));
    if (i < 0) {
      out.push({ ...n });
      continue;
    }
    const merged: Holding = { ...out[i]!, ...n };
    // Keep the fuller name: a narrow screen cuts names short.
    merged.name = fullerName(out[i]!.name, n.name);
    out[i] = merged;
  }
  return out;
}
