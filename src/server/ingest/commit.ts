// Commit a reviewed draft: create accounts, write transactions / balances / holdings / figures, link
// transfers, archive the original document and record the import. Everything lands in one git commit.

import { ACCOUNT_TYPE_META, slugify } from '../../shared/accounts';
import { transferLegCategory } from '../../shared/categorise';
import { catalogInstitution, findInstitution } from '../../shared/institutions';
import { formatMoney } from '../../shared/money';
import { taxYearOf } from '../../shared/uk';
import type { Account, BalanceSnapshot, Draft, Figure, HoldingsSnapshot, ImportRecord, Transaction } from '../../shared/schema';
import { AccountSchema, BalanceSnapshotSchema, DraftSchema, FigureSchema, HoldingsSnapshotSchema, TransactionSchema } from '../../shared/schema';
import { nowISO, safeFileName } from '../fsutil';
import { balanceId, figureId, holdingsId, transactionId, transferGroupId } from '../ids';
import { StoreError, type Store } from '../store';

export interface CommitInput {
  record: ImportRecord;
  draft: Draft;
  /** Absolute path of the uploaded file in the work area. */
  workFile: string;
}

function balanceKind(draft: Draft, mediaType: string): BalanceSnapshot['kind'] {
  if (draft.documentType === 'csv_export') return 'export';
  if (mediaType.startsWith('image/')) return 'screenshot';
  return 'statement';
}

export async function commitDraft(store: Store, input: CommitInput): Promise<ImportRecord> {
  const draft = DraftSchema.parse(input.draft);
  const { record } = input;
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
      if (!acc.last4 && last4 && /^\d{2,6}$/.test(last4) && !toLearn.some((a) => a.id === acc.id)) toLearn.push(AccountSchema.parse({ ...acc, last4, updatedAt: stamp }));
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
    };
    AccountSchema.parse(account);
    toCreate.push({ account, ...(institution ? { institution } : {}) });
    accountsCreated.push(id);
    resolved.set(section.key, account);
  }

  // 2. Transactions.
  const newTx: Transaction[] = [];
  const transferLinks: { newId: string; otherId: string; account: Account }[] = [];
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
      if (row.transferMatch && store.transaction(row.transferMatch)) {
        tx.transferGroup = transferGroupId(id, row.transferMatch);
        transferLinks.push({ newId: id, otherId: row.transferMatch, account });
      }
      newTx.push(tx);
    }
  }

  // 3. Balances, holdings, figures.
  const balances: BalanceSnapshot[] = [];
  const holdings: HoldingsSnapshot[] = [];
  for (const section of draft.sections) {
    const account = resolved.get(section.key);
    if (!account || !section.balanceDate) continue;
    if (section.recordBalance && section.balance !== undefined) {
      balances.push({
        id: balanceId(account.id, section.balanceDate, section.balance, 'import', record.id),
        accountId: account.id,
        date: section.balanceDate,
        balance: section.balance,
        currency: section.currency,
        kind: balanceKind(draft, record.document.mediaType),
        source,
        createdAt: stamp,
        ...(section.balanceDateSource ? { dateSource: section.balanceDateSource } : {}),
        ...(section.availableBalance !== undefined ? { availableBalance: section.availableBalance } : {}),
        ...(section.creditLimit !== undefined ? { creditLimit: section.creditLimit } : {}),
        ...(section.contributions !== undefined ? { contributions: section.contributions } : {}),
        ...(section.gain !== undefined ? { gain: section.gain } : {}),
        ...(section.cash !== undefined ? { cash: section.cash } : {}),
        ...(section.bonusToDate !== undefined ? { bonusToDate: section.bonusToDate } : {}),
        ...(section.annualIncome !== undefined ? { annualIncome: section.annualIncome } : {}),
        ...(section.interestRate !== undefined ? { interestRate: section.interestRate } : {}),
        ...(section.taxYearContributions !== undefined
          ? { taxYearContributions: section.taxYearContributions, taxYear: taxYearOf(section.balanceDate).label }
          : {}),
      });
    }
    if (section.recordHoldings && section.holdings.length) {
      const total = section.balance ?? section.holdings.reduce((s, h) => s + h.value, 0) + (section.cash ?? 0);
      holdings.push({
        id: holdingsId(account.id, section.balanceDate, total, record.id),
        accountId: account.id,
        date: section.balanceDate,
        holdings: section.holdings,
        totalValue: Math.round(total * 100) / 100,
        source,
        createdAt: stamp,
        ...(section.cash !== undefined ? { cash: section.cash } : {}),
      });
    }
  }
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
    }));

  // Validate everything before the first write.
  for (const t of newTx) TransactionSchema.parse(t);
  for (const b of balances) BalanceSnapshotSchema.parse(b);
  for (const h of holdings) HoldingsSnapshotSchema.parse(h);
  for (const f of figures) FigureSchema.parse(f);

  // 4. Write.
  for (const account of toLearn) await store.upsertAccount(account);
  for (const { account, institution } of toCreate) {
    if (institution && !store.institution(institution.id)) await store.upsertInstitution(institution as Parameters<Store['upsertInstitution']>[0]);
    if (!store.account(account.id)) await store.upsertAccount(account);
  }
  const label = record.document.fileName;
  const added = newTx.length ? await store.addTransactions(newTx, `import: ${label} (+${newTx.length} transactions)`) : 0;
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
        return { id: otherId, patch };
      }),
      `import: link ${transferLinks.length} transfer(s)`,
    );
  }
  const balancesAdded = balances.length ? await store.addBalances(balances, `import: ${label} balance`) : 0;
  const holdingsAdded = holdings.length ? await store.addHoldings(holdings, `import: ${label} holdings`) : 0;
  const figuresAdded = figures.length ? await store.addFigures(figures, `import: ${label} figures`) : 0;

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
      sections: draft.sections.flatMap((s) => {
        const account = resolved.get(s.key);
        return account ? [{ key: s.key, accountId: account.id }] : [];
      }),
    },
  };
  const names = [...new Set(accountIds)].map((id) => store.account(id)?.name ?? id).join(', ');
  const bits = [
    added ? `+${added} txns` : '',
    balances[0] ? `balance ${formatMoney(balances[0].balance, { currency: balances[0].currency })}` : '',
    holdingsAdded ? 'holdings' : '',
    figuresAdded ? `${figuresAdded} figures` : '',
  ].filter(Boolean);
  await store.saveImport(committed, `import: ${label} → ${names || 'figures'}${bits.length ? ` (${bits.join(', ')})` : ''}`, [docPath]);
  return committed;
}
