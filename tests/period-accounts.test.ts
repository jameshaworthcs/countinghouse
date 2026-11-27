// A company's books at each period's end and its accounts for a period (docs/FORMULAS.md §22, "At a
// period's end" and "The period's accounts"): depreciation by whole months with cumulative rounding,
// disposals, prepayments and accruals from `covers`, and the trial balance, profit and loss, balance
// sheet (exact and in whole pounds), register, director's loan, bank reconciliation and checks. Pure
// functions over an in-memory source, and properties over generated assets and covers. Every name and
// figure is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CompanyAccountsResponse, LedgerPosting } from '../src/shared/api';
import { BalanceEngine, type BalanceSource } from '../src/server/analytics/balances';
import { companyLedger, type LedgerSource } from '../src/server/analytics/ledger';
import { periodAccounts } from '../src/server/analytics/period-accounts';
import { transactionId } from '../src/server/ids';
import { accountingPeriodsOf, booksProblems } from '../src/shared/company-books';
import { addDays, diffDays } from '../src/shared/dates';
import { codingProblems, journalProblems, reg111Goods } from '../src/shared/ledger';
import { carriedAt, coverParts, depreciationTo, monthsCounted, overlapDays } from '../src/shared/period-end';
import { SettingsSchema, type Account, type BalanceSnapshot, type BooksCoding, type Company, type Journal, type Transaction } from '../src/shared/schema';

const stamp = '2024-01-01T00:00:00+00:00';
const CO = 'example-works';
const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let n = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, n++), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
type Books = NonNullable<Company['books']>;
/** Incorporated on 1 January 2024, its year to 31 December: periods 2024, 2025, 2026… */
const booksOf = (extra: Partial<Books> = {}): Books => ({ incorporatedOn: '2024-01-01', accountingReferenceDate: '12-31', periods: [], ctPeriods: [], filings: [], setBy: 'owner', updatedAt: stamp, vat: { registeredFrom: '2024-01-01', scheme: 'cash', schedule: [{ from: '2024-01-01', stagger: 'quarterly-1' }] }, ...extra });
const companyOf = (books: Partial<Books> = {}): Company => ({ id: CO, name: 'Example Works Ltd', holdings: [], valuations: [], directorLoanAccountId: 'loan', createdBy: 'owner', createdAt: stamp, updatedAt: stamp, books: booksOf(books) });
const journal = (date: string, memo: string, lines: Journal['lines'], extra: Partial<Journal> = {}): Journal => ({ id: `jnl_${(n++).toString(16).padStart(12, '0')}`, companyId: CO, date, memo, lines, createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
const coded = (ledger: string, extra: Partial<BooksCoding> = {}): BooksCoding => ({ ledger, setBy: 'user', ...extra });
const std = (amount: number) => ({ amount, treatment: 'standard' as const });

const ACCOUNTS: Account[] = [acct('current', 'Everyday', 'current'), acct('loan', 'Director’s loan', 'director_loan'), acct('works-bank', 'Works Account', 'current', { companyId: CO, includeInNetWorth: false })];

function memory(rows: Transaction[], opts: { journals?: Journal[]; company?: Company; snapshots?: BalanceSnapshot[] } = {}): LedgerSource {
  const companies = [opts.company ?? companyOf()];
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const companyOfAccount = (id: string) => ACCOUNTS.find((a) => a.id === id)?.companyId;
  return {
    balances: (id) => (opts.snapshots ?? []).filter((b) => b.accountId === id),
    transactions: (accountId?: string) => (accountId ? sorted.filter((t) => t.accountId === accountId) : sorted.filter((t) => !companyOfAccount(t.accountId))),
    transaction: (id) => byId.get(id),
    account: (id) => ACCOUNTS.find((a) => a.id === id),
    company: (id) => companies.find((c) => c.id === id),
    companyAccounts: (id) => ACCOUNTS.filter((a) => a.companyId === id),
    companyTransactions: (id) => sorted.filter((t) => companyOfAccount(t.accountId) === id),
    companyJournals: (id) => (opts.journals ?? []).filter((j) => j.companyId === id),
    bookRules: () => [],
  };
}

/** The company's own balance engine over the in-memory source (what the route gives the report). */
function engineOf(src: LedgerSource, snapshots: BalanceSnapshot[] = []): BalanceEngine {
  const own = src.companyAccounts(CO);
  const source: BalanceSource = { accounts: own, settings: SettingsSchema.parse({}), transactions: (id?: string) => (id ? src.companyTransactions(CO).filter((t) => t.accountId === id) : src.companyTransactions(CO)), balances: (id?: string) => snapshots.filter((b) => !id || b.accountId === id) };
  return new BalanceEngine(source);
}
const snapshot = (date: string, balance: number): BalanceSnapshot => ({ id: `bal_${(n++).toString(16).padStart(16, '0')}`, accountId: 'works-bank', date, balance, currency: 'GBP', kind: 'statement', dateSource: 'document', source: {}, createdAt: stamp });

const byLedger = (postings: readonly LedgerPosting[], keep: (p: LedgerPosting) => boolean = () => true) => {
  const out: Record<string, number> = {};
  for (const p of postings) if (keep(p)) out[p.ledger] = (out[p.ledger] ?? 0) + p.amount;
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
};
const inSpan = (from: string, to: string) => (p: LedgerPosting) => p.date >= from && p.date <= to;
const upTo = (to: string) => (p: LedgerPosting) => p.date <= to;

describe('months and depreciation', () => {
  it('counts the month of acquisition, and the month a period ends in, in full', () => {
    expect(monthsCounted('2024-08-11', '2024-08-11')).toBe(1);
    expect(monthsCounted('2024-08-31', '2024-09-01')).toBe(2);
    expect(monthsCounted('2024-08-11', '2024-12-31')).toBe(5);
    expect(monthsCounted('2024-08-11', '2025-12-31')).toBe(17);
    expect(monthsCounted('2024-08-11', '2024-07-31')).toBe(0);
  });

  it('writes a cost down straight line by whole months, rounding cumulatively, never past its cost', () => {
    // £1,200 over 36 months from August 2024: 5, 17, 29 and 36 months to each year end.
    const laptop = { cost: 120_000, from: '2024-08-11', months: 36 };
    expect(['2024-12-31', '2025-12-31', '2026-12-31', '2027-12-31', '2030-12-31'].map((d) => depreciationTo(laptop, d))).toEqual([16_667, 56_667, 96_667, 120_000, 120_000]);
    expect(depreciationTo({ ...laptop, months: undefined }, '2030-12-31')).toBe(0);
    // Stopped at the month it left.
    expect(depreciationTo({ ...laptop, disposedOn: '2026-02-15' }, '2027-12-31')).toBe(63_333);
  });

  it('as a property: to-date depreciation never falls, never passes the cost, and reaches it at the end of its life', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), fc.integer({ min: 1, max: 120 }), fc.integer({ min: 0, max: 3_000 }), (cost, months, offset) => {
        const from = addDays('2024-01-01', offset);
        const asset = { cost, from, months };
        let last = 0;
        for (let k = 0; k <= months + 2; k++) {
          const d = addDays(from, Math.round(k * 30.44));
          const v = depreciationTo(asset, d);
          if (v < last || v > cost) return false;
          last = v;
        }
        return depreciationTo(asset, addDays(from, Math.ceil(months * 31) + 31)) === cost;
      }),
      { numRuns: 200 },
    );
  });
});

describe('the parts of a cover in each period', () => {
  const periods = accountingPeriodsOf(booksOf(), '2026-12-31');

  it('splits by days, inclusive, and counts days before the books’ first day on it', () => {
    expect(overlapDays({ start: '2024-09-03', end: '2024-12-31' }, { start: '2024-01-01', end: '2024-12-31' })).toBe(120);
    // £240 net for 3 September 2024 to 2 September 2025: 120 days then 245.
    expect(coverParts(24_000, { from: '2024-09-03', to: '2025-09-02' }, periods, '2024-01-01')).toEqual([7_890, 16_110, 0]);
    expect(coverParts(10_000, { from: '2023-10-01', to: '2023-12-31' }, periods, '2024-01-01')).toEqual([10_000, 0, 0]);
    expect(coverParts(10_000, { from: '2023-12-01', to: '2024-01-31' }, periods, '2024-01-01')).toEqual([10_000, 0, 0]);
  });

  it('carries to each period end what is due by then less what is posted by then', () => {
    const parts = [7_890, 16_110, 0];
    expect(carriedAt(0, parts, 24_000, '2024-09-03', periods)).toBe(-16_110);
    // Paid in 2025 for 2024: an accrual at the end of 2024, nothing after.
    expect(carriedAt(0, [36_000, 0, 0], 36_000, '2025-02-20', periods)).toBe(36_000);
    expect(carriedAt(1, [36_000, 0, 0], 36_000, '2025-02-20', periods)).toBe(0);
  });
});

describe('postings at a period’s end', () => {
  it('depreciates a fixed asset each period, on the period’s last day, to its class’s depreciation code', () => {
    const laptop = tx('works-bank', '2024-08-11', -1_440, 'EXAMPLE COMPUTERS LTD', { books: coded('fixed-assets:computer:cost', { vat: std(-240), asset: { class: 'computer', months: 36 } }) });
    const { postings, assets, checks } = companyLedger(memory([laptop]), CO);
    expect(assets).toEqual([expect.objectContaining({ id: `row:${laptop.id}`, cost: 120_000, from: '2024-08-11', months: 36, life: 'asset', depreciationLedger: 'fixed-assets:computer:depreciation' })]);
    const dep = postings.filter((p) => p.source.kind === 'depreciation' && p.ledger === 'depreciation');
    // The books reach the period of their last posting (2024), whose end holds its depreciation.
    expect(dep.map((p) => [p.date, p.amount])).toEqual([['2024-12-31', 16_667]]);
    expect(byLedger(postings)['fixed-assets:computer:depreciation']).toBe(-16_667);
    expect(checks.filter((c) => c.kind !== 'uncoded')).toEqual([]);
  });

  it('runs on to the end of its life once the books reach it, and the charges add up to its cost', () => {
    const laptop = tx('works-bank', '2024-08-11', -1_200, 'EXAMPLE COMPUTERS LTD', { books: coded('fixed-assets:computer:cost', { asset: { class: 'computer', months: 36 } }) });
    const later = tx('works-bank', '2028-02-01', 10, 'EXAMPLE BANK INTEREST', { books: coded('interest-receivable') });
    const { postings } = companyLedger(memory([laptop, later]), CO);
    const dep = postings.filter((p) => p.source.kind === 'depreciation' && p.ledger === 'depreciation');
    expect(dep.map((p) => p.amount)).toEqual([16_667, 40_000, 40_000, 23_333]);
    expect(dep.reduce((s, p) => s + p.amount, 0)).toBe(120_000);
  });

  it('takes a life from the company’s policy for the class, and asks for one when there is none', () => {
    const desk = tx('works-bank', '2024-03-05', -600, 'EXAMPLE FURNITURE', { books: coded('fixed-assets:furniture:cost', { asset: { class: 'furniture' } }) });
    const noPolicy = companyLedger(memory([desk]), CO);
    expect(noPolicy.checks).toContainEqual(expect.objectContaining({ kind: 'no-depreciation-policy', class: 'furniture', amount: 600 }));
    expect(noPolicy.postings.filter((p) => p.source.kind === 'depreciation')).toEqual([]);
    const withPolicy = companyLedger(memory([desk], { company: companyOf({ policies: [{ class: 'furniture', months: 60 }] }) }), CO);
    expect(withPolicy.assets[0]).toMatchObject({ months: 60, life: 'policy' });
    // March to December 2024: 10 of 60 months of £600.
    expect(byLedger(withPolicy.postings, upTo('2024-12-31')).depreciation).toBe(10_000);
    expect(withPolicy.checks.filter((c) => c.kind === 'no-depreciation-policy')).toEqual([]);
  });

  it('amortises an intangible asset the same way, to its amortisation code', () => {
    const mark = tx('works-bank', '2024-01-10', -1_000, 'EXAMPLE TRADE MARKS', { books: coded('intangible-assets:cost', { asset: { class: 'intangible', months: 120 } }) });
    const { postings } = companyLedger(memory([mark]), CO);
    expect(byLedger(postings, upTo('2024-12-31'))).toMatchObject({ depreciation: 10_000, 'intangible-assets:amortisation': -10_000 });
    // Coded as goods for reg 111 no longer: an intangible is a supply of services.
    expect(reg111Goods('intangible-assets:cost')).toBe(false);
    expect(reg111Goods('fixed-assets:computer:cost')).toBe(true);
  });

  it('on disposal, stops depreciating at the month it left and takes its cost and depreciation away, the rest to disposals', () => {
    const laptop = tx('works-bank', '2024-08-11', -1_200, 'EXAMPLE COMPUTERS LTD', { books: coded('fixed-assets:computer:cost', { asset: { class: 'computer', months: 36, disposedOn: '2026-02-15' } }) });
    // What it fetched, coded to disposals on the row it came in on.
    const sold = tx('works-bank', '2026-02-16', 300, 'EXAMPLE RESELLER', { books: coded('disposals') });
    const { postings } = companyLedger(memory([laptop, sold]), CO);
    const disposal = postings.filter((p) => p.source.kind === 'disposal');
    expect(disposal.map((p) => [p.date, p.ledger, p.amount])).toEqual([
      ['2026-02-15', 'fixed-assets:computer:cost', -120_000],
      ['2026-02-15', 'fixed-assets:computer:depreciation', 63_333],
      ['2026-02-15', 'disposals', 56_667],
    ]);
    // The charge for 2026 is January and February's, on the day it left.
    expect(postings.filter((p) => p.source.kind === 'depreciation' && p.ledger === 'depreciation' && p.date >= '2026-01-01').map((p) => [p.date, p.amount])).toEqual([['2026-02-15', 6_666]]);
    const after = byLedger(postings);
    expect(after['fixed-assets:computer:cost']).toBeUndefined();
    expect(after['fixed-assets:computer:depreciation']).toBeUndefined();
    // A loss of £266.67: its net book value £566.67 less the £300 it fetched.
    expect(after.disposals).toBe(26_667);
  });

  it('refuses a fixed asset on money coming in, or written as a credit, and asks about one left off the register', () => {
    expect(codingProblems(300, { ledger: 'fixed-assets:computer:cost', asset: { class: 'computer', months: 36 } }, 'company')[0]).toMatch(/money going out/);
    expect(journalProblems({ lines: [{ ledger: 'fixed-assets:computer:cost', amount: -500, asset: { class: 'computer' } }, { ledger: 'disposals', amount: 500 }] }, () => true)[0]).toMatch(/is a debit/);
    const bare = tx('works-bank', '2024-05-01', -800, 'EXAMPLE OFFICE', { books: coded('fixed-assets:office:cost') });
    const bought = tx('works-bank', '2024-06-01', -400, 'EXAMPLE PRINTERS', { books: coded('fixed-assets:office:cost', { asset: { class: 'office', months: 36, disposedOn: '2024-05-01' } }) });
    const handWritten = journal('2024-12-31', 'Depreciation by hand', [
      { ledger: 'depreciation', amount: 100 },
      { ledger: 'fixed-assets:office:depreciation', amount: -100 },
    ]);
    const { checks, assets } = companyLedger(memory([bare, bought], { journals: [handWritten] }), CO);
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'fixed-asset-unmarked', ledger: 'fixed-assets:office:cost', amount: 800 }));
    expect(checks.filter((c) => c.kind === 'fixed-asset-invalid').map((c) => (c as { problem: string }).problem)).toEqual(expect.arrayContaining([expect.stringMatching(/by hand/), expect.stringMatching(/before it was bought/)]));
    // Its disposal left out until it is put right: still on the register, still depreciated.
    expect(assets.find((a) => a.memo === 'EXAMPLE PRINTERS')?.disposedOn).toBeUndefined();
  });

  it('brings an asset on an opening journal in from the books’ first day, at its carrying amount over its remaining life', () => {
    const open = journal(
      '2024-12-31',
      'Opening balances',
      [
        { ledger: 'fixed-assets:computer:cost', amount: 900, asset: { class: 'computer', months: 18 } },
        { ledger: 'retained-earnings', amount: -900 },
      ],
      { opening: true },
    );
    const row = tx('works-bank', '2025-03-01', 5, 'EXAMPLE BANK INTEREST', { books: coded('interest-receivable') });
    const { postings, assets } = companyLedger(memory([row], { journals: [open], company: companyOf({ ledgerFrom: '2025-01-01' }) }), CO);
    expect(assets[0]).toMatchObject({ acquired: '2024-12-31', from: '2025-01-01' });
    // Nothing in 2024, twelve months of eighteen in 2025.
    expect(postings.filter((p) => p.source.kind === 'depreciation' && p.ledger === 'depreciation').map((p) => [p.date, p.amount])).toEqual([['2025-12-31', 60_000]]);
  });

  describe('covers', () => {
    it('carries a cost paid ahead as a prepayment at the period end, reversed the next day', () => {
      const tools = tx('works-bank', '2024-09-03', -288, 'EXAMPLE DESIGN TOOLS', { books: coded('software-hosting', { vat: std(-48), covers: { from: '2024-09-03', to: '2025-09-02' } }) });
      const { postings } = companyLedger(memory([tools]), CO);
      expect(postings.filter((p) => p.source.kind === 'deferral').map((p) => [p.date, p.ledger, p.amount])).toEqual([
        ['2024-12-31', 'software-hosting', -16_110],
        ['2024-12-31', 'prepayments', 16_110],
        ['2025-01-01', 'software-hosting', 16_110],
        ['2025-01-01', 'prepayments', -16_110],
      ]);
      expect(byLedger(postings, upTo('2024-12-31'))).toMatchObject({ 'software-hosting': 7_890, prepayments: 16_110, vat: 4_800 });
      expect(byLedger(postings, inSpan('2025-01-01', '2025-12-31'))['software-hosting']).toBe(16_110);
    });

    it('accrues a cost paid after the period it covers, at that period’s end', () => {
      const fees = tx('works-bank', '2025-02-20', -360, 'EXAMPLE ACCOUNTANTS', { books: coded('professional-fees', { covers: { from: '2024-10-01', to: '2024-12-31' } }) });
      const { postings } = companyLedger(memory([fees]), CO);
      expect(byLedger(postings, upTo('2024-12-31'))).toEqual({ 'professional-fees': 36_000, accruals: -36_000 });
      // Paid in 2025: the accrual reversed on its first day, so the cost is not counted again.
      expect(byLedger(postings, inSpan('2025-01-01', '2025-12-31'))).toEqual({ 'bank:works-bank': -36_000, accruals: 36_000 });
    });

    it('defers income received ahead, and accrues income received late', () => {
      const ahead = tx('works-bank', '2024-12-01', 1_200, 'EXAMPLE CLIENT RETAINER', { books: coded('turnover', { covers: { from: '2024-12-01', to: '2025-11-30' } }) });
      const late = tx('works-bank', '2025-01-15', 620, 'EXAMPLE CLIENT DECEMBER', { books: coded('turnover', { covers: { from: '2024-12-01', to: '2024-12-31' } }) });
      const { postings } = companyLedger(memory([ahead, late]), CO);
      const atYearEnd = byLedger(postings, upTo('2024-12-31'));
      // 31 of 365 days of £1,200 in 2024; £620 for December accrued.
      expect(atYearEnd).toMatchObject({ turnover: -(10_192 + 62_000), 'deferred-income': -(120_000 - 10_192), 'accrued-income': 62_000 });
    });

    it('spreads nothing on a balance sheet code, and says so', () => {
      const deposit = tx('works-bank', '2024-04-01', -500, 'EXAMPLE LANDLORD DEPOSIT', { books: coded('debtors:other', { covers: { from: '2024-04-01', to: '2025-03-31' } }) });
      const { postings, checks } = companyLedger(memory([deposit]), CO);
      expect(checks).toContainEqual(expect.objectContaining({ kind: 'covers-not-spread', ledger: 'debtors:other' }));
      expect(postings.filter((p) => p.source.kind === 'deferral')).toEqual([]);
    });

    it('as a property: each period recognises its part, the parts add up to the posting, and each period end carries exactly what is not recognised yet', () => {
      const day = (k: number) => addDays('2024-01-01', k);
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5_000_000 }),
          fc.boolean(),
          fc.integer({ min: 0, max: 1_400 }),
          fc.integer({ min: 0, max: 1_400 }),
          fc.integer({ min: 0, max: 900 }),
          (pence, income, paidOn, from, length) => {
            const amount = (income ? pence : -pence) / 100;
            const covers = { from: day(from), to: day(from + length) };
            const t = tx('works-bank', day(paidOn), amount, 'EXAMPLE SUBSCRIPTION', { books: coded(income ? 'turnover' : 'software-hosting', { covers }) });
            const { postings, periods } = companyLedger(memory([t]), CO);
            const code = income ? 'turnover' : 'software-hosting';
            const sheetCodes = ['prepayments', 'accruals', 'deferred-income', 'accrued-income'];
            const minor = -Math.round(amount * 100);
            const parts = coverParts(minor, covers, periods, '2024-01-01');
            let total = 0;
            for (const [k, p] of periods.entries()) {
              const recognised = byLedger(postings, inSpan(p.start, p.end))[code] ?? 0;
              if (recognised !== parts[k]) return false;
              total += recognised;
              const atEnd = byLedger(postings, upTo(p.end));
              const carried = sheetCodes.reduce((s, c) => s + (atEnd[c] ?? 0), 0);
              const posted = t.date <= p.end ? minor : 0;
              const due = parts.slice(0, k + 1).reduce((s, x) => s + x, 0);
              if (carried !== posted - due) return false;
            }
            return total === minor && postings.reduce((s, p) => s + p.amount, 0) === 0;
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  it('as a property: depreciation and disposals add up, the register empties when an asset leaves, and every source balances', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 2_000_000 }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 700 }), fc.option(fc.integer({ min: 0, max: 1_500 }), { nil: undefined }), (pence, months, bought, heldFor) => {
        const date = addDays('2024-01-01', bought);
        const disposedOn = heldFor === undefined ? undefined : addDays(date, heldFor);
        const t = tx('works-bank', date, -pence / 100, 'EXAMPLE KIT', { books: coded('fixed-assets:office:cost', { asset: { class: 'office', months, ...(disposedOn ? { disposedOn } : {}) } }) });
        const late = tx('works-bank', addDays(date, 2_200), 1, 'EXAMPLE BANK INTEREST', { books: coded('interest-receivable') });
        const { postings } = companyLedger(memory([t, late]), CO);
        const charged = postings.filter((p) => p.source.kind === 'depreciation' && p.ledger === 'depreciation').reduce((s, p) => s + p.amount, 0);
        const expected = depreciationTo({ cost: pence, from: date, months, disposedOn }, addDays(date, 2_200));
        const all = byLedger(postings);
        const sources = new Map<string, number>();
        for (const p of postings) sources.set(`${p.source.kind}:${p.source.id}`, (sources.get(`${p.source.kind}:${p.source.id}`) ?? 0) + p.amount);
        const balanced = [...sources.values()].every((v) => v === 0);
        if (disposedOn) return charged === expected && !all['fixed-assets:office:cost'] && !all['fixed-assets:office:depreciation'] && (all.disposals ?? 0) === pence - expected && balanced;
        return charged === Math.min(expected, pence) && (all['fixed-assets:office:cost'] ?? 0) - pence === 0 && -(all['fixed-assets:office:depreciation'] ?? 0) === charged && balanced;
      }),
      { numRuns: 150 },
    );
  });
});

describe('a period’s accounts', () => {
  /** A year of a small studio's books: shares, sales with VAT, costs, a laptop, a prepayment, an accrual, your loan. */
  function studio(opts: { filings?: Books['filings']; snapshots?: BalanceSnapshot[]; extra?: Transaction[] } = {}) {
    const rows = [
      tx('works-bank', '2024-01-05', 1_000, 'J BLOGGS LOAN', { books: coded('directors-loan') }),
      tx('works-bank', '2024-02-10', 20, 'J BLOGGS SHARES', { books: coded('share-capital-unpaid') }),
      tx('works-bank', '2024-03-01', 3_600, 'EXAMPLE CLIENT LTD INV 1', { books: coded('turnover', { vat: std(600) }) }),
      tx('works-bank', '2024-08-11', -1_440, 'EXAMPLE COMPUTERS LTD', { books: coded('fixed-assets:computer:cost', { vat: std(-240), asset: { class: 'computer', months: 36 } }) }),
      tx('works-bank', '2024-09-03', -288, 'EXAMPLE DESIGN TOOLS', { books: coded('software-hosting', { vat: std(-48), covers: { from: '2024-09-03', to: '2025-09-02' } }) }),
      tx('works-bank', '2024-12-20', -0.5, 'EXAMPLE BANK FEE', { books: coded('bank-charges') }),
      tx('works-bank', '2025-02-20', -360, 'EXAMPLE ACCOUNTANTS', { books: coded('professional-fees', { covers: { from: '2024-10-01', to: '2024-12-31' } }) }),
      tx('works-bank', '2025-06-30', 2_400, 'EXAMPLE CLIENT LTD INV 2', { books: coded('turnover', { vat: std(400) }) }),
      ...(opts.extra ?? []),
    ];
    const shares = journal('2024-01-01', 'Shares issued at incorporation', [
      { ledger: 'share-capital-unpaid', amount: 20 },
      { ledger: 'share-capital', amount: -20 },
    ]);
    const dividend = journal('2025-03-31', 'Dividend declared, credited to the director’s loan', [
      { ledger: 'dividends', amount: 500 },
      { ledger: 'directors-loan', amount: -500 },
    ]);
    const src = memory(rows, { journals: [shares, dividend], company: companyOf({ filings: opts.filings ?? [] }), ...(opts.snapshots ? { snapshots: opts.snapshots } : {}) });
    return { src, rows };
  }
  const report = (s: ReturnType<typeof studio>, period?: string, snapshots: BalanceSnapshot[] = [], today = '2026-06-01') => periodAccounts({ src: s.src, company: s.src.company(CO)!, engine: engineOf(s.src, snapshots), today, period })!;
  const line = (r: CompanyAccountsResponse, l: string) => r.balanceSheet.lines.find((x) => x.line === l)!;
  const pl = (r: CompanyAccountsResponse, l: string) => r.profitAndLoss.lines.find((x) => x.line === l)!;

  it('offers the periods the books reach, newest first, and shows the latest ended one by default', () => {
    const r = report(studio());
    expect(r.periods.map((p) => [p.start, p.end, p.ended])).toEqual([
      ['2026-01-01', '2026-12-31', false],
      ['2025-01-01', '2025-12-31', true],
      ['2024-01-01', '2024-12-31', true],
    ]);
    expect(r.period).toMatchObject({ end: '2025-12-31', first: false });
    expect(report(studio(), '2024-12-31').period.first).toBe(true);
    expect(periodAccounts({ src: studio().src, company: studio().src.company(CO)!, engine: { balanceOn: () => null }, today: '2026-06-01', period: '2024-06-30' })).toBeUndefined();
  });

  it('works out the profit and loss by the micro-entity lines, with the codes beneath', () => {
    const r = report(studio(), '2024-12-31');
    expect(pl(r, 'A')).toMatchObject({ amount: 300_000, codes: [{ ledger: 'turnover', amount: 300_000 }] });
    // Depreciation (5 months of 36 of £1,200), and other charges: the tools’ 120 days of 365, the accrued fees, the fee.
    expect(pl(r, 'E').amount).toBe(-16_667);
    expect(pl(r, 'F').amount).toBe(-(7_890 + 36_000 + 50));
    expect(r.profitAndLoss.profitBeforeTax).toBe(300_000 - 16_667 - 43_940);
    expect(r.profitAndLoss.tax).toBe(0);
    expect(r.profitAndLoss.profit).toBe(r.profitAndLoss.profitBeforeTax);
  });

  it('balances the trial balance and the balance sheet, and K is capital and reserves', () => {
    for (const end of ['2024-12-31', '2025-12-31']) {
      const r = report(studio(), end);
      expect(r.trialBalance.debit).toBe(r.trialBalance.credit);
      expect(r.balanceSheet.balances).toBe(true);
      expect(line(r, 'K').exact).toBe(r.balanceSheet.capital.total.exact);
      expect(line(r, 'K').whole).toBe(r.balanceSheet.capital.total.whole);
    }
    const r = report(studio(), '2024-12-31');
    expect(line(r, 'A').exact).toBe(0);
    expect(line(r, 'B')).toMatchObject({ exact: 120_000 - 16_667, codes: [{ ledger: 'fixed-assets:computer:cost', amount: 120_000 }, { ledger: 'fixed-assets:computer:depreciation', amount: -16_667 }] });
    expect(line(r, 'D').exact).toBe(16_110);
    expect(line(r, 'J').exact).toBe(36_000);
    // The VAT owed (£600 charged less £48 and £240 reclaimed) and the loan are creditors.
    expect(line(r, 'E').codes.map((c) => [c.ledger, c.amount])).toEqual([
      ['vat', 31_200],
      ['directors-loan', 100_000],
    ]);
  });

  it('closes each period’s profit to retained earnings, the next period’s opening, with dividends taken off', () => {
    const y1 = report(studio(), '2024-12-31');
    const y2 = report(studio(), '2025-12-31');
    expect(y2.balanceSheet.capital.reserve.opening).toBe(y1.balanceSheet.capital.reserve.exact);
    expect(y2.balanceSheet.capital.reserve.dividends).toBe(50_000);
    expect(y2.balanceSheet.capital.reserve.exact).toBe(y1.balanceSheet.capital.reserve.exact + y2.profitAndLoss.profit - 50_000);
    // The trial balance holds retained earnings at the start, the period's profit and loss codes alone.
    expect(y2.trialBalance.rows.find((x) => x.ledger === 'retained-earnings')).toMatchObject({ credit: y1.balanceSheet.capital.reserve.exact });
    expect(y2.trialBalance.rows.find((x) => x.ledger === 'turnover')).toMatchObject({ credit: 200_000 });
  });

  it('rounds lines A–E and H–J to the pound and works F, G and K out from the rounded lines', () => {
    // 50p of bank charges leaves the bank at £x.50: rounded away from zero, the totals from the rounded lines.
    const r = report(studio(), '2024-12-31');
    const w = Object.fromEntries(r.balanceSheet.lines.map((l) => [l.line, l.whole]));
    const e = Object.fromEntries(r.balanceSheet.lines.map((l) => [l.line, l.exact]));
    for (const l of ['A', 'B', 'C', 'D', 'E', 'H', 'I', 'J']) expect(w[l]).toBe(Math.sign(e[l]!) * Math.round(Math.abs(e[l]!) / 100 + 1e-9));
    expect(w.F).toBe(w.C! + w.D! - w.E!);
    expect(w.G).toBe(w.A! + w.B! + w.F!);
    expect(w.K).toBe(w.G! - w.H! - w.I! - w.J!);
    expect(r.balanceSheet.capital.shareCapital).toEqual({ exact: 2_000, whole: 20 });
    expect(r.balanceSheet.capital.reserve.whole).toBe(w.K! - 20);
    expect(e.C! % 100).not.toBe(0);
  });

  it('lists the register at the period end: cost, depreciation before, for and to it, and net book value', () => {
    const r = report(studio(), '2025-12-31');
    expect(r.register).toEqual([expect.objectContaining({ cost: 120_000, before: 16_667, charge: 40_000, toDate: 56_667, netBookValue: 63_333, months: 36, acquired: '2024-08-11', disposedInPeriod: false })]);
  });

  it('holds the current period’s period-end postings though nothing is recorded in it yet', () => {
    const r = report(studio(), '2026-12-31');
    // 29 months of 36 to the end of 2026: the register and line B agree.
    expect(r.register[0]).toMatchObject({ toDate: 96_667, charge: 40_000 });
    expect(r.balanceSheet.lines.find((l) => l.line === 'B')!.exact).toBe(120_000 - 96_667);
    expect(r.profitAndLoss.lines.find((l) => l.line === 'E')!.amount).toBe(-40_000);
  });

  it('states the director’s loan over the period, in your sign and the books’', () => {
    const r = report(studio(), '2025-12-31');
    expect(r.directorLoan).toMatchObject({ opening: 100_000, closing: 150_000, books: { opening: -100_000, closing: -150_000 } });
    expect(r.directorLoan!.movements).toEqual([expect.objectContaining({ date: '2025-03-31', source: 'journal', amount: 50_000 })]);
  });

  it('reconciles the bank against its statement balance, and says when there is none', () => {
    const s = studio();
    const atEnd = byLedger(companyLedger(s.src, CO).postings, upTo('2024-12-31'))['bank:works-bank']!;
    const good = report(s, '2024-12-31', [snapshot('2024-12-31', atEnd / 100)]);
    expect(good.reconciliation).toEqual([expect.objectContaining({ status: 'reconciled', books: atEnd, statement: atEnd, difference: 0 })]);
    expect(good.checks).toEqual([]);
    expect(good.ready).toBe(true);
    const off = report(s, '2024-12-31', [snapshot('2024-12-31', atEnd / 100 + 12.34)]);
    expect(off.reconciliation[0]).toMatchObject({ status: 'differs', difference: 1_234 });
    expect(off.checks).toContainEqual({ kind: 'bank', reconciliation: off.reconciliation[0] });
    expect(off.ready).toBe(false);
    // No statement balance: the engine's figure is the rows alone, said and not a block.
    const rows = report(s, '2024-12-31');
    expect(rows.reconciliation[0]!.status).toBe('rows-only');
    expect(rows.ready).toBe(true);
  });

  it('is not ready while the period runs, or with a row in suspense, and a check after the period end does not stop it', () => {
    const uncodedLater = tx('works-bank', '2025-04-01', -9.99, 'EXAMPLE STATIONERS');
    const s = studio({ extra: [uncodedLater] });
    expect(report(s, '2024-12-31').ready).toBe(true);
    const y2 = report(s, '2025-12-31');
    expect(y2.checks).toContainEqual({ kind: 'clearing', ledger: 'suspense', amount: 999 });
    expect(y2.checks.some((c) => c.kind === 'ledger' && c.check.kind === 'uncoded')).toBe(true);
    const current = report(studio(), '2026-12-31');
    expect(current.checks).toContainEqual({ kind: 'not-ended', end: '2026-12-31' });
    expect(current.ready).toBe(false);
  });

  it('compares the lines filed for the period with those worked out now, and names any that drifted', () => {
    const r = report(studio(), '2024-12-31');
    const w = Object.fromEntries(r.balanceSheet.lines.map((l) => [l.line, l.whole]));
    const filing = (figures: Record<string, number>) => [{ id: 'fil_000000000001', kind: 'accounts' as const, periodStart: '2024-01-01', periodEnd: '2024-12-31', filedOn: '2025-06-01', addedBy: 'owner' as const, figures }];
    const same = report(studio({ filings: filing({ B: w.B!, K: w.K! }) }), '2024-12-31');
    expect(same.filing).toMatchObject({ matches: true, lines: [{ line: 'B', filed: w.B, computed: w.B }, { line: 'K', filed: w.K, computed: w.K }] });
    expect(same.period.filed).toMatchObject({ filedOn: '2025-06-01', lines: true });
    expect(same.ready).toBe(true);
    const drifted = report(studio({ filings: filing({ B: w.B! + 1, K: w.K! }) }), '2024-12-31');
    expect(drifted.checks).toContainEqual({ kind: 'drift', lines: [{ line: 'B', filed: w.B! + 1, computed: w.B }] });
    expect(drifted.ready).toBe(false);
  });

  it('as a property: over generated rows, every period balances and K is capital and reserves', () => {
    const codes = ['turnover', 'software-hosting', 'travel', 'directors-loan', 'debtors:other', 'creditors:trade', 'interest-receivable', 'dividends'];
    fc.assert(
      fc.property(
        fc.array(fc.record({ day: fc.integer({ min: 0, max: 1_000 }), pence: fc.integer({ min: -500_000, max: 500_000 }).filter((x) => x !== 0), code: fc.constantFrom(...codes), covers: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }), asset: fc.boolean() }), { maxLength: 25 }),
        (specs) => {
          const rows = specs.map((x) => {
            const date = addDays('2024-01-01', x.day);
            if (x.asset) return tx('works-bank', date, -Math.abs(x.pence) / 100, 'EXAMPLE KIT', { books: coded('fixed-assets:office:cost', { asset: { class: 'office', months: 24 } }) });
            const pAndL = ['turnover', 'software-hosting', 'travel', 'interest-receivable'].includes(x.code);
            return tx('works-bank', date, x.pence / 100, 'EXAMPLE ROW', { books: coded(x.code, x.covers !== undefined && pAndL ? { covers: { from: date, to: addDays(date, x.covers) } } : {}) });
          });
          const src = memory(rows);
          for (const end of ['2024-12-31', '2025-12-31', '2026-12-31']) {
            const r = periodAccounts({ src, company: src.company(CO)!, engine: { balanceOn: () => null }, today: '2027-06-01', period: end })!;
            const k = r.balanceSheet.lines.find((l) => l.line === 'K')!;
            if (r.trialBalance.debit !== r.trialBalance.credit || !r.balanceSheet.balances || k.whole !== r.balanceSheet.capital.total.whole) return false;
          }
          return true;
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuses two depreciation policies for one class', () => {
    expect(booksProblems(booksOf({ policies: [{ class: 'computer', months: 36 }, { class: 'computer', months: 48 }] }))).toContainEqual(expect.stringMatching(/Two depreciation policies/));
    expect(diffDays('2024-01-01', '2024-12-31')).toBe(365);
  });
});
