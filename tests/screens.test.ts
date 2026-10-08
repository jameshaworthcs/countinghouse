// Investment-app screenshots: activity lists whose running balance is the cash, scrolled screens
// that do not name the account, one fund's own page, holdings lists split over several screens.
// Synthetic figures only.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowances } from '../src/server/analytics/allowances';
import { matchInstrument } from '../src/server/analytics/research';
import { selfAssessment } from '../src/server/analytics/selfassessment';
import { commitDraft, mergeHoldings } from '../src/server/ingest/commit';
import { buildDraft, draftIsClean } from '../src/server/ingest/draft';
import { dateFromFileName } from '../src/server/ingest/images';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { Store } from '../src/server/store';
import { defaultCategories } from '../src/shared/categories';
import { cutShort, fullerName, sameFundName } from '../src/shared/funds';
import { sectionChecks } from '../src/shared/review';
import { ExtractionSchema, type Account, type Draft, type Figure, type ImportRecord, type Instrument } from '../src/shared/schema';

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
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
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

describe('payslips and P60s', () => {
  const fig = (n: number, kind: Figure['kind'], amount: number, payer: string, period?: [string, string]): Figure => ({ id: `fig_${n.toString(16).padStart(16, '0')}`, kind, label: kind, amount, currency: 'GBP', taxYear: '2026/27', payer, source: {}, createdAt: stamp, ...(period ? { periodStart: period[0], periodEnd: period[1] } : {}) });
  const payslips = [fig(1, 'gross_pay', 812.4, 'LARCHWOOD DATA LTD', ['2026-07-01', '2026-07-31']), fig(2, 'gross_pay', 1105.25, 'LARCHWOOD DATA LTD', ['2026-08-01', '2026-08-31']), fig(3, 'gross_pay', 1105.25, 'LARCHWOOD DATA LTD', ['2026-09-01', '2026-09-30'])];

  it('counts each employer once: its P60, else its payslips so far, and salary from others as a floor', async () => {
    await store.addFigures(payslips, 't');
    await store.addTransactions(
      [
        { id: 'tx_0000000000000101', accountId: 'current', date: '2026-07-28', amount: 812.4, currency: 'GBP', description: 'FASTER PAYMENTS RECEIPT REF.LarchwoodData July', category: 'salary', source: {} },
        { id: 'tx_0000000000000102', accountId: 'current', date: '2026-08-25', amount: 1310.18, currency: 'GBP', description: 'BANK GIRO CREDIT REF OAKFIELD ENGINEERING', category: 'salary', source: {} },
      ],
      't',
    );
    let band = allowances(store, '2026/27', '2026-09-29').taxBand;
    expect(band.lines.filter((l) => l.kind === 'pay')).toEqual([
      { label: 'Pay from LARCHWOOD DATA LTD (3 payslips, so far)', amount: 3022.9, kind: 'pay' },
      // LarchwoodData's own salary payment is covered by its payslips; Oakfield's is not.
      { label: 'Other pay (at least: 1 salary payment received, after tax)', amount: 1310.18, kind: 'pay' },
    ]);
    expect(band.basis).toBe('minimum');
    // A P60's figures from the same employer (typed by hand here) replace its payslips rather than adding to them.
    await store.addFigures([fig(4, 'gross_pay', 9000, 'Larchwood Data Ltd'), fig(5, 'gross_pay', 30000, 'Oakfield Engineering Ltd')], 't');
    band = allowances(store, '2026/27', '2026-09-29').taxBand;
    expect(band.lines.filter((l) => l.kind === 'pay').map((l) => [l.label, l.amount])).toEqual([
      ['Pay from Larchwood Data Ltd (your figure)', 9000],
      ['Pay from Oakfield Engineering Ltd (your figure)', 30000],
    ]);
    expect(band.basis).toBe('documents');
    const sa = selfAssessment(store, '2026/27');
    expect(sa.sections[0]!.items.find((i) => i.id === 'pay')).toMatchObject({ amount: 39000, status: 'ready' });
  });

  it('Self Assessment shows payslips as pay so far, to be settled by the P60', async () => {
    await store.addFigures(payslips, 't');
    const item = selfAssessment(store, '2026/27').sections[0]!.items.find((i) => i.id === 'pay')!;
    expect(item).toMatchObject({ amount: 3022.9, status: 'check', basis: 'So far this year' });
    expect(item.notes.join(' ')).toMatch(/LARCHWOOD DATA LTD: pay £3,022\.90, from 3 payslips, so far: its P60 for 2026\/27 gives the year's figure/);
  });

  it('two months of equal pay are two figures, not a duplicate', async () => {
    await store.addFigures([payslips[1]!], 't');
    const d = draftOf({ documentType: 'payslip', accounts: [], figures: [{ kind: 'gross_pay', label: 'Basic Pay', amount: 1105.25, taxYear: '2026/27', periodStart: '2026-09-01', periodEnd: '2026-09-30', payer: 'LARCHWOOD DATA LTD' }] });
    expect(d.figures[0]).toMatchObject({ include: true });
    expect(d.figures[0]!.duplicateOf).toBeUndefined();
    const again = draftOf({ documentType: 'payslip', accounts: [], figures: [{ kind: 'gross_pay', label: 'Basic Pay', amount: 1105.25, taxYear: '2026/27', periodStart: '2026-08-01', periodEnd: '2026-08-31', payer: 'LARCHWOOD DATA LTD' }] });
    expect(again.figures[0]).toMatchObject({ include: false, duplicateOf: payslips[1]!.id });
  });
});

describe('fund names cut short', () => {
  it('match the full name they begin, and give way to it', () => {
    expect(cutShort('HSBC FTSE 100 Index Accum…')).toBe('hsbcftse100indexaccum');
    expect(sameFundName('HSBC FTSE 100 Index Accum…', 'HSBC FTSE 100 Index Accumulation C')).toBe(true);
    // The app's type label after the cut does not stop the match.
    expect(sameFundName('Fidelity Index Emerging Mar… Accumulation Fund', 'Fidelity Index Emerging Markets P Acc')).toBe(true);
    expect(sameFundName('HSBC FTSE 100 Index Accum…', 'HSBC FTSE 250 Index C Acc')).toBe(false);
    expect(fullerName('iShares Core MSCI World ETF …', 'iShares Core MSCI World UCITS ETF USD (Acc)')).toBe('iShares Core MSCI World UCITS ETF USD (Acc)');
    expect(fullerName('iShares Core MSCI World UCITS ETF USD (Acc)', 'iShares Core MSCI World ETF …')).toBe('iShares Core MSCI World UCITS ETF USD (Acc)');
  });

  it('an instrument recorded under a cut name is found by the full one, when only one fits', () => {
    const inst = (id: string, name: string): Instrument => ({ id, name, aliases: [], createdAt: stamp, updatedAt: stamp });
    const list = [inst('hsbc-100', 'HSBC FTSE 100 Index Accum…'), inst('hsbc-250', 'HSBC FTSE 250 Index C Acc')];
    expect(matchInstrument({ name: 'HSBC FTSE 100 Index Accumulation C' }, list)?.id).toBe('hsbc-100');
    expect(matchInstrument({ name: 'HSBC FTSE 250 Index C Acc' }, list)?.id).toBe('hsbc-250');
    expect(matchInstrument({ name: 'HSBC FTSE All-World Index' }, list)).toBeUndefined();
  });
});

describe('statement dates', () => {
  it('a statement’s balance is at the end of its period, not the day it was produced', async () => {
    await store.setAccounts([...store.accounts, acct('card', 'credit_card', { last4: '1234' })]);
    const d = draftOf({ documentType: 'credit_card_statement', accounts: [{ accountType: 'credit_card', last4: '1234', periodStart: '2026-02-03', periodEnd: '2026-03-02', balanceDate: '2026-03-03', closingBalance: -1312.4, transactions: [{ date: '2026-02-10', description: 'SHOP', amount: -20 }] }] });
    expect(d.sections[0]!.balanceDate).toBe('2026-03-02');
  });

  it('Self Assessment does not look for interest from an account closed before the year', async () => {
    await store.setAccounts([...store.accounts, acct('fixed', 'savings', { status: 'closed', openedOn: '2023-09-14', closedOn: '2025-09-14' })]);
    await store.addTransactions([{ id: 'tx_0000000000000201', accountId: 'fixed', date: '2023-09-14', amount: 1000, currency: 'GBP', description: 'Deposit', category: 'transfer', source: {} }], 't');
    const notes = (ty: string) => selfAssessment(store, ty).sections.find((x) => x.id === 'savings')!.items[0]!.notes.join(' ');
    expect(notes('2026/27')).not.toMatch(/fixed/);
    // It closed during 2025/26, and nothing covers its days of that year before it did: interest
    // paid when it closed may be missing then.
    expect(notes('2025/26')).toMatch(/fixed: no document covers 6 Apr – 14 Sep 2025, so interest may be missing/);
  });
});

describe('holdings identifiers', () => {
  it('a SEDOL read into the ticker field is kept as a SEDOL; a real ticker stays a ticker', () => {
    const d = draftOf({ documentType: 'holdings_screenshot', accounts: [{ accountType: 'lisa', accountName: 'Lifetime ISA', closingBalance: 300, holdings: [{ name: 'HSBC FTSE 100 Index Accumulation C', ticker: 'B80QFR5', value: 100 }, { name: 'iShares Core MSCI World ETF', ticker: 'SWDA', value: 200 }] }] });
    expect(d.sections[0]!.holdings.map((h) => [h.ticker, h.sedol])).toEqual([
      [undefined, 'B80QFR5'],
      ['SWDA', undefined],
    ]);
  });
});
