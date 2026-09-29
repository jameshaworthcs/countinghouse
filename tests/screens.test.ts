// Investment-app screenshots: activity lists whose running balance is the cash, scrolled screens
// that do not name the account, one fund's own page, holdings lists split over several screens.
// Synthetic figures only.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDraft, mergeHoldings } from '../src/server/ingest/commit';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { dateFromFileName } from '../src/server/ingest/images';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type Account, type Draft, type ImportRecord } from '../src/shared/schema';

const stamp = '2026-09-01T00:00:00+01:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let docs = 0;
const doc = (fileName = 'IMG_0001.png') => ({ id: `doc_${(++docs).toString(16).padStart(16, '0')}`, sha256: String(docs).padStart(64, '0'), fileName, mediaType: 'image/png', size: 1, capturedOn: '2026-09-29', capturedOnSource: 'exif' as const });
const draftOf = (raw: unknown, hint?: string) => buildDraft(ExtractionSchema.parse(raw), { store, document: doc(), uploadedOn: '2026-09-29', ...(hint ? { hintAccountId: hint } : {}) });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-screens-'));
  store = await Store.open(path.join(dir, 'data'));
  await store.setCategories(defaultCategories());
  await store.upsertInstitution({ id: 'aj-bell', name: 'AJ Bell', kind: 'investment_platform' });
  await store.upsertInstitution({ id: 'bank', name: 'Some Bank', kind: 'bank' });
  await store.setAccounts([acct('lisa', 'lisa', { name: 'Example Lifetime ISA', institutionId: 'aj-bell' }), acct('current', 'current', { institutionId: 'bank' })]);
});
afterEach(async () => {
  store.stopWatching();
  await rm(dir, { recursive: true, force: true });
});

// An activity list as a platform's app shows it: newest first, a running balance that is the cash.
const activity = (extra: Record<string, unknown> = {}) => ({
  documentType: 'transactions_screenshot',
  accounts: [
    {
      institutionName: null,
      // The account selector at the top of the screen.
      accountName: 'Lifetime ISA',
      accountType: null,
      periodStart: '2026-08-30',
      periodEnd: '2026-09-29',
      openingBalance: 3.42,
      closingBalance: 1251.55,
      transactions: [
        { date: '2026-09-26', description: 'Debit card payment', amount: 1000, balanceAfter: 1251.55 },
        { date: '2026-09-22', description: 'Platform charge - Aug 2026', amount: -1.87, balanceAfter: 251.55 },
        { date: '2026-09-02', description: 'Lifetime isa government bonus', amount: 250, balanceAfter: 253.42 },
      ],
      ...extra,
    },
  ],
});

describe('an investment account’s activity list', () => {
  it('records the rows, not the cash balance as the account’s value', () => {
    const d = draftOf(activity());
    const [s] = d.sections;
    // The reader left the type out; the selector's name and a Lifetime ISA bonus row say it.
    expect(s!.target).toEqual({ mode: 'existing', accountId: 'lisa' });
    expect(s!.detected.accountType).toBe('lisa');
    expect(s!).toMatchObject({ cashLedger: true, cash: 1251.55, recordBalance: false });
    expect(s!.balance).toBeUndefined();
    const checks = sectionChecks(s!, { accountType: 'lisa', latest: '2026-09-29' });
    expect(checks.find((c) => c.id === 'reconcile')).toMatchObject({ status: 'ok', title: 'The cash balances add up' });
    expect(checks.find((c) => c.id === 'cash-ledger')).toMatchObject({ status: 'info' });
    expect(checks.some((c) => c.status === 'warn')).toBe(false);
    expect(draftIsClean(d).clean).toBe(true);
    expect(s!.transactions.map((t) => t.category)).toEqual(['contribution', 'investment-fee', 'government-bonus']);
  });

  it('a scrolled screen naming only the provider goes to your only account there', () => {
    const d = draftOf(
      activity({
        // Scrolled past the selector: only the platform's own charge names it.
        accountName: null,
        institutionName: 'Dodl',
        openingBalance: 412.3,
        closingBalance: 7.12,
        transactions: [
          { date: '2026-07-29', description: 'Purchase 312.408 L&G Global Technology Index I Acc', amount: -999.81, balanceAfter: 7.12 },
          { date: '2026-07-28', description: 'Debit card payment', amount: 1000, balanceAfter: 1006.93 },
          { date: '2026-07-22', description: 'Dodl charge - Jun 2026', amount: -1.62, balanceAfter: 6.93 },
          { date: '2026-07-06', description: 'Purchase 29 State Street SPDR S&P 500 ETF', amount: -403.75, balanceAfter: 8.55 },
        ],
      }),
    );
    const [s] = d.sections;
    expect(s!.target).toEqual({ mode: 'existing', accountId: 'lisa' });
    expect(s!.matchReason).toMatch(/your only AJ Bell account/);
    expect(s!).toMatchObject({ cashLedger: true, cash: 7.12 });
    expect(s!.balance).toBeUndefined();
  });

  it('the reader saying the balance is cash is enough, and a printed total is still the value', () => {
    const d = draftOf(activity({ runningBalanceOf: 'cash', closingBalance: 15930.4, cashBalance: 1251.55 }));
    expect(d.sections[0]!).toMatchObject({ cashLedger: true, cash: 1251.55, balance: 15930.4, recordBalance: true });
  });

  it('a cash account’s running balance is its value', async () => {
    await store.setAccounts([...store.accounts, acct('cash-lisa', 'lisa', { institutionId: 'bank', last4: '4242' })]);
    const d = draftOf(activity({ institutionName: 'Some Bank', last4: '4242', accountType: 'lisa' }));
    expect(d.sections[0]!).toMatchObject({ target: { mode: 'existing', accountId: 'cash-lisa' }, balance: 1251.55, recordBalance: true });
    expect(d.sections[0]!.cashLedger).toBeUndefined();
  });
});

describe('screens that show part of an account’s holdings', () => {
  const detail = { documentType: 'holding_detail_screenshot', accounts: [{ accountName: 'Robo revolution', closingBalance: 1845.76, contributionsToDate: 1302.55, gainLoss: 543.21, holdings: [{ name: 'iShares Automation & Robotics UCITS ETF USD (Acc) GBP', units: 112, price: 16.48, value: 1845.76, costBasis: 1302.55, gain: 543.21 }] }] };

  it('one fund’s own page is a holding, not an account worth that fund', () => {
    // Nothing on it names an account, and none holds the fund yet: you choose, nothing is created.
    let d = draftOf(detail);
    expect(d.sections[0]!).toMatchObject({ target: { mode: 'skip' }, holdingsPartial: true, recordBalance: false });
    expect(d.sections[0]!.balance).toBeUndefined();
    expect(d.sections[0]!.contributions).toBeUndefined();
    expect(d.sections[0]!.holdings[0]).toMatchObject({ units: 112, costBasis: 1302.55, gain: 543.21 });
    expect(draftIsClean(d).reasons).toContain('an account to choose or a section left out');
    // Uploaded onto the account (from its page or the capture list), it goes there.
    d = draftOf(detail, 'lisa');
    expect(d.sections[0]!.target).toEqual({ mode: 'existing', accountId: 'lisa' });
    expect(sectionChecks(d.sections[0]!, { accountType: 'lisa', latest: '2026-09-29' }).find((c) => c.id === 'holdings')).toMatchObject({ status: 'info' });
  });

  it('a list of funds naming no account does not propose a new one', () => {
    const d = draftOf({ documentType: 'holdings_screenshot', accounts: [{ holdings: [{ name: 'World Fund', value: 1876.4 }, { name: 'UK Fund', value: 1288.15 }] }] });
    expect(d.sections[0]!).toMatchObject({ target: { mode: 'skip' }, holdingsPartial: true });
    expect(d.sections[0]!.matchReason).toMatch(/choose it/);
  });

  it('a fund page goes to the account that already holds the fund', async () => {
    await store.addHoldings([{ id: 'hld_0000000000000001', accountId: 'lisa', date: '2026-09-28', holdings: [{ name: 'iShares Automation & Robotics UCITS ETF USD (Acc) GBP', value: 2100, currency: 'GBP' }], totalValue: 2100, source: {}, createdAt: stamp }], 't');
    expect(draftOf(detail).sections[0]!.target).toEqual({ mode: 'existing', accountId: 'lisa' });
  });

  it('an overview listing only its first holding is part of the list, not a misread', () => {
    const d = draftOf({ documentType: 'account_overview_screenshot', accounts: [{ accountName: 'Lifetime ISA', accountType: 'lisa', closingBalance: 15930.4, cashBalance: 1251.55, holdings: [{ name: 'Legal & General Global', value: 5874.62 }] }] });
    const s = d.sections[0]!;
    expect(s).toMatchObject({ target: { mode: 'existing', accountId: 'lisa' }, balance: 15930.4, holdingsPartial: true });
    expect(sectionChecks(s, { accountType: 'lisa', latest: '2026-09-29' }).find((c) => c.id === 'holdings')).toMatchObject({ status: 'info', title: 'Part of the holdings list' });
    // Holdings worth more than the account are a misread, and still stop the draft.
    const over = { ...s, holdings: [{ name: 'Fund', value: 20000, currency: 'GBP' }] };
    expect(sectionChecks(over, { accountType: 'lisa', latest: '2026-09-29' }).find((c) => c.id === 'holdings')).toMatchObject({ status: 'warn' });
  });

  it('screens of one day merge into one set of holdings, whatever order they are committed in', async () => {
    const workFile = path.join(dir, 'x.png');
    await writeFile(workFile, 'x');
    let seq = 0;
    const commit = (sections: Draft['sections']) => {
      const id = `imp_20260929_0900${String(seq++).padStart(2, '0')}_abcd`;
      const record: ImportRecord = { id, status: 'review', createdAt: stamp, updatedAt: stamp, origin: 'upload', document: doc(), extraction: { warnings: [] } };
      return commitDraft(store, { record, draft: { documentType: 'holdings_screenshot', sections, figures: [], notes: [] }, workFile });
    };
    const section = (holdings: Draft['sections'][number]['holdings'], extra: Partial<Draft['sections'][number]> = {}): Draft['sections'][number] => ({ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'lisa' }, currency: 'GBP', recordBalance: extra.balance !== undefined, balanceDate: '2026-09-29', transactions: [], recordHoldings: true, holdings, holdingsPartial: true, ...extra });
    // The fund's own page first, then the list in two parts, then the overview with the total.
    await commit([section([{ name: 'Tech Index Fund Accumulation', value: 5874.62, units: 2041.517, costBasis: 4408.9, currency: 'GBP' }])]);
    await commit([section([{ name: 'World Fund', value: 1876.4, currency: 'GBP' }, { name: 'UK Fund', value: 1288.15, currency: 'GBP' }])]);
    await commit([section([{ name: 'Tech Index Fund Accumulation', value: 5874.62, currency: 'GBP' }, { name: 'Robotics ETF', value: 1845.76, currency: 'GBP' }])]);
    await commit([section([{ name: 'Tech Index Fund', value: 5874.62, currency: 'GBP' }], { balance: 15000, cash: 1251.55 })]);
    const snaps = store.holdings('lisa');
    expect(snaps).toHaveLength(1);
    const [snap] = snaps;
    expect(snap!).toMatchObject({ date: '2026-09-29', totalValue: 15000, cash: 1251.55 });
    expect(snap!.holdings.map((h) => h.name)).toEqual(['Tech Index Fund Accumulation', 'World Fund', 'UK Fund', 'Robotics ETF']);
    // The units and amount invested from the fund's own page survive the later screens.
    expect(snap!.holdings[0]).toMatchObject({ units: 2041.517, costBasis: 4408.9 });
    // A complete list replaces the day's holdings: a fund it no longer lists is gone.
    await commit([section([{ name: 'World Fund', value: 1900, currency: 'GBP' }], { holdingsPartial: false })]);
    expect(store.holdings('lisa')).toHaveLength(1);
    expect(store.holdings('lisa')[0]!.holdings.map((h) => h.name)).toEqual(['World Fund']);
  });

  it('a commit links a transfer whose other leg another account’s statement brought in earlier', async () => {
    const out = { id: 'tx_00000000000000aa', accountId: 'current', date: '2026-05-23', amount: -1000, currency: 'GBP', description: 'AJ BELL (VIA APPLE PAY)', category: 'investment-transfer', source: {} };
    await store.addTransactions([out], 't');
    const workFile = path.join(dir, 'a.png');
    await writeFile(workFile, 'x');
    const record: ImportRecord = { id: 'imp_20260929_110000_abcd', status: 'review', createdAt: stamp, updatedAt: stamp, origin: 'upload', document: doc(), extraction: { warnings: [] } };
    await commitDraft(store, {
      record,
      workFile,
      draft: { documentType: 'transactions_screenshot', figures: [], notes: [], sections: [{ key: 's0', detected: {}, target: { mode: 'existing', accountId: 'lisa' }, currency: 'GBP', recordBalance: false, balanceDate: '2026-06-01', cashLedger: true, cash: 1006.42, transactions: [{ key: 't0', include: true, status: 'new', date: '2026-05-23', amount: 1000, description: 'Debit card payment', category: 'contribution' }], recordHoldings: false, holdings: [] }] },
    });
    const [inLisa] = store.transactions('lisa');
    const bank = store.transaction(out.id)!;
    expect(inLisa!.transferGroup).toBeDefined();
    expect(bank.transferGroup).toBe(inLisa!.transferGroup);
    expect(bank.counterpartyAccountId).toBe('lisa');
    expect(inLisa!.category).toBe('contribution');
    // No value came from the activity list.
    expect(store.balances('lisa')).toHaveLength(0);
  });

  it('merges by ISIN first, and keeps the fuller name', () => {
    expect(mergeHoldings([{ name: 'A Fund', isin: 'GB0000000001', value: 1, currency: 'GBP' }], [{ name: 'Another name', isin: 'gb0000000001', value: 2, currency: 'GBP' }])).toEqual([{ name: 'Another name', isin: 'gb0000000001', value: 2, currency: 'GBP' }]);
    expect(mergeHoldings([{ name: 'Legal & General Global Technology Index', value: 1, currency: 'GBP' }], [{ name: 'Legal & General Global', value: 2, currency: 'GBP' }])[0]).toMatchObject({ name: 'Legal & General Global Technology Index', value: 2 });
  });
});

describe('small things a screenshot import got wrong', () => {
  it('keeps only a trailing run of digits as last4', () => {
    const last4 = (v: string) => normaliseExtraction({ documentType: 'other', accounts: [{ last4: v }] }).extraction.accounts[0]!.last4;
    expect(last4('QK7WM3P')).toBeNull();
    expect(last4('••••4471')).toBe('4471');
    expect(last4('ending 12-3456')).toBe('3456');
  });

  it('reads dates written with the month’s name in file names', () => {
    expect(dateFromFileName('Alex_AJBell_Dodl_statement_5th_June_2024.jpeg')).toBe('2024-06-05');
    expect(dateFromFileName('dividend-17th Apr 2026_signed.pdf')).toBe('2026-04-17');
    expect(dateFromFileName('dividend-2025Sept18th_signed.pdf')).toBe('2025-09-18');
    expect(dateFromFileName('statement June 3 2025.pdf')).toBe('2025-06-03');
    expect(dateFromFileName('accountStatement_08062026.pdf')).toBe('2026-06-08');
    expect(dateFromFileName('Mayfair 2026.pdf')).toBeNull();
    expect(dateFromFileName('IMG_0558.png')).toBeNull();
  });

  it('a new account can be created already closed', async () => {
    const workFile = path.join(dir, 's.pdf');
    await writeFile(workFile, 'x');
    const record: ImportRecord = { id: 'imp_20260929_100000_abcd', status: 'review', createdAt: stamp, updatedAt: stamp, origin: 'upload', document: { ...doc('s.pdf'), mediaType: 'application/pdf' }, extraction: { warnings: [] } };
    await commitDraft(store, {
      record,
      workFile,
      draft: {
        documentType: 'savings_statement',
        figures: [],
        notes: [],
        sections: [{ key: 's0', detected: {}, target: { mode: 'new', account: { id: 'fixed', name: 'Fixed bond', type: 'savings', currency: 'GBP', openedOn: '2023-09-14', closedOn: '2025-09-14' } }, currency: 'GBP', recordBalance: true, balance: 19250.4, balanceDate: '2023-09-14', transactions: [], recordHoldings: false, holdings: [] }],
      },
    });
    expect(store.account('fixed')).toMatchObject({ status: 'closed', openedOn: '2023-09-14', closedOn: '2025-09-14' });
  });
});
