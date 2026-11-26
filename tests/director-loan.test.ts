// Money between you and a company of yours (Transaction.company; docs/DATA_FORMAT.md) and the director's
// loan it moves (a `director_loan` account a company names; docs/FORMULAS.md §9, "A director's loan").
// The rules of a mark on every write path, re-working rows out, the `set_company` proposal, the company
// link, the derived movements in the balance engine, and the properties that matter most: marking moves
// value between your accounts and never makes or loses any; spending and income drop exactly the marked
// rows; the loan's balance is its anchor plus the negated marked amounts since. Every name and figure is
// invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDetailResponse, CashflowResponse, CompanyView, DataHealthResponse, MonthSummary, ProposalView, SummaryResponse } from '../src/shared/api';
import { defaultCategories } from '../src/shared/categories';
import { addDays, today } from '../src/shared/dates';
import { fromMinor, toMinor } from '../src/shared/money';
import { SettingsSchema, type Account, type BalanceSnapshot, type Company, type CompanyMark, type ProposalInput, type Transaction } from '../src/shared/schema';
import { s455Rate, taxYearOf } from '../src/shared/uk';
import { createApp, type App } from '../src/server/app';
import { BalanceEngine, type BalanceSource } from '../src/server/analytics/balances';
import { flows } from '../src/server/analytics/cashflow';
import { directorLoanMovements, directorLoanWarnings, movementId } from '../src/server/analytics/director-loan';
import { estateOn } from '../src/server/analytics/estate';
import { loadConfig } from '../src/server/config';
import { enrich } from '../src/server/enrich';
import { balanceId, transactionId, transferGroupId } from '../src/server/ids';
import type { Store } from '../src/server/store';
import { requiredScope } from '../src/server/tokens';

const stamp = '2026-01-01T00:00:00+00:00';
const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const COMPANY = 'example-studio';

const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}, n = 0): Transaction => ({ id: transactionId(accountId, date, amount, description, n), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
const company = (extra: Partial<Company> = {}): Company => ({ id: COMPANY, name: 'EXAMPLE STUDIO LTD', holdings: [], valuations: [], accountId: 'shares', createdBy: 'owner', createdAt: stamp, updatedAt: stamp, ...extra });
const anchor = (accountId: string, date: string, value: number): BalanceSnapshot => ({ id: balanceId(accountId, date, value, 'manual', stamp), accountId, date, balance: value, currency: 'GBP', kind: 'manual', dateSource: 'manual', source: {}, createdAt: stamp });

// Dates in the current tax year, so the warnings about it are about these rows.
const T0 = taxYearOf(today()).start;
const day = (n: number) => {
  const d = addDays(T0, n);
  return d > today() ? today() : d;
};

const hosting = tx('card', day(2), -24, 'EXAMPLE HOSTING LTD', { category: 'software', categorisedBy: 'builtin' });
const lent = tx('current', day(3), -500, 'TRANSFER TO STUDIO ACCOUNT 12344444');
const repaid = tx('current', day(5), 200, 'EXAMPLE STUDIO LTD REPAYMENT', { category: 'salary', categorisedBy: 'rule' });
const salary = tx('current', day(6), 1800, 'EXAMPLE STUDIO LTD SALARY', { category: 'salary', categorisedBy: 'rule' });
const cafe = tx('current', day(4), -6.5, 'EXAMPLE CAFE', { category: 'coffee', categorisedBy: 'builtin' });
// A row of yours the money out to the studio would pair with, as a transfer to your saver, if it were not marked.
const saverIn = tx('saver', day(3), 500, 'TRANSFER FROM EVERYDAY ACCOUNT 12341111');
const studioRow = tx('studio-current', day(3), 500, 'FROM JO BLOGGS');

describe("money with your company and the director's loan", () => {
  let dir: string;
  let app: App;
  let store: Store;
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const send = async (method: string, p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await req(p, { method, headers: { ...CSRF, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const get = async <T>(p: string) => (await (await req(p)).json()) as T;
  const mark = (t: Transaction, as: CompanyMark['as'] | null) => send('PATCH', `/api/transactions/${t.id}`, { company: as ? { id: COMPANY, as } : null });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-director-loan-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
    store = app.ctx.store;
    await store.setProfile({ ...store.profile, name: 'Jo Bloggs' });
    await store.setAccounts([
      acct('current', 'Everyday', 'current', { last4: '1111', aliases: ['Everyday Account'] }),
      acct('saver', 'Rainy Day', 'savings'),
      acct('card', 'Example Card', 'credit_card'),
      acct('isa', 'Stocks ISA', 'stocks_isa'),
      acct('shares', 'Example Studio Ltd shares', 'other_asset'),
      acct('loan', 'Director’s loan', 'director_loan'),
    ]);
    await store.setCompanies([company({ directorLoanAccountId: 'loan' }), { ...company(), id: 'other-co', name: 'OTHER EXAMPLE LTD', accountId: undefined }]);
    await store.upsertAccount(acct('studio-current', 'Studio Account', 'current', { last4: '4444', companyId: COMPANY, includeInNetWorth: false }));
    await store.addTransactions([hosting, lent, repaid, salary, cafe, saverIn, studioRow], 'test');
    await store.addBalances([anchor('current', addDays(T0, -1), 3000), anchor('card', addDays(T0, -1), -100), anchor('saver', addDays(T0, -1), 1000)], 'test');
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('a mark', () => {
    it('is set and taken away by you on a transaction, and is yours', async () => {
      const set = await mark(hosting, 'paid-for');
      expect(set.status).toBe(200);
      expect(store.transaction(hosting.id)!.company).toEqual({ id: COMPANY, as: 'paid-for', setBy: 'user' });
      expect((await mark(hosting, null)).status).toBe(200);
      expect(store.transaction(hosting.id)!.company).toBeUndefined();
    });

    it('fits only where it can: each rule refuses with its reason, and writes nothing', async () => {
      // On a company's own account.
      expect((await mark(studioRow, 'loan')).body.error).toMatch(/EXAMPLE STUDIO LTD’s own account/);
      // A company that is not there.
      expect((await send('PATCH', `/api/transactions/${hosting.id}`, { company: { id: 'no-such-co', as: 'paid-for' } })).body.error).toMatch(/no company "no-such-co"/);
      // Pay and dividends are money in.
      expect((await mark(hosting, 'pay')).body.error).toMatch(/money out: pay/);
      expect((await mark(lent, 'dividend')).body.error).toMatch(/money out: a dividend/);
      // On an account valued at market.
      const inIsa = tx('isa', day(2), -100, 'EXAMPLE PLATFORM FEE');
      await store.addTransactions([inIsa], 'test');
      expect((await mark(inIsa, 'paid-for')).body.error).toMatch(/valued at market/);
      // Not in pounds.
      const abroad = tx('current', day(2), -40, 'EXAMPLE HOSTING INC', { currency: 'USD' });
      await store.addTransactions([abroad], 'test');
      expect((await mark(abroad, 'paid-for')).body.error).toMatch(/in USD/);
      // £0.
      const nothing = tx('current', day(2), 0, 'EXAMPLE CARD CHECK');
      await store.addTransactions([nothing], 'test');
      expect((await mark(nothing, 'loan')).body.error).toMatch(/moves no money/);
      for (const t of [studioRow, hosting, lent, inIsa, abroad, nothing]) expect(store.transaction(t.id)!.company).toBeUndefined();
    });

    it('never sits on a transfer between your accounts: a linked row must be unlinked first, and a marked row is never linked', async () => {
      const group = transferGroupId(lent.id, saverIn.id);
      await store.updateTransactions(
        [
          { id: lent.id, patch: { transferGroup: group, counterpartyAccountId: 'saver' } },
          { id: saverIn.id, patch: { transferGroup: group, counterpartyAccountId: 'current' } },
        ],
        'test: linked',
      );
      expect((await mark(lent, 'loan')).body.error).toMatch(/linked as a transfer between two of your accounts/);
      await store.updateTransactions(
        [
          { id: lent.id, patch: { transferGroup: undefined, counterpartyAccountId: undefined } },
          { id: saverIn.id, patch: { transferGroup: undefined, counterpartyAccountId: undefined } },
        ],
        'test: unlinked',
      );
      expect((await mark(lent, 'loan')).status).toBe(200);
      // Re-working everything out (and linking transfers) leaves it marked and unlinked; without the mark it would pair.
      await enrich(store);
      expect(store.transaction(lent.id)).toMatchObject({ company: { id: COMPANY, as: 'loan', setBy: 'user' } });
      expect(store.transaction(lent.id)!.transferGroup).toBeUndefined();
      expect(store.transaction(saverIn.id)!.transferGroup).toBeUndefined();
      // The store itself refuses a link on a marked row, whoever writes.
      await expect(store.updateTransactions([{ id: lent.id, patch: { transferGroup: group } }], 'test')).rejects.toThrow(/linked as a transfer/);
      // Without the mark, the same rows pair: the mark is what keeps them apart.
      await mark(lent, null);
      await enrich(store);
      expect(store.transaction(lent.id)!.transferGroup).toBe(store.transaction(saverIn.id)!.transferGroup);
    });

    it('is kept through re-working rows out, re-applying, and a rule', async () => {
      await mark(repaid, 'loan');
      await mark(salary, 'pay');
      for (let i = 0; i < 2; i++) {
        expect((await send('POST', '/api/enrich', {})).status).toBe(200);
        expect((await send('POST', '/api/rules', { match: { field: 'description', op: 'contains', value: 'EXAMPLE STUDIO', caseSensitive: false }, set: { category: 'dividends' }, apply: true })).status).toBe(201);
      }
      expect(store.transaction(repaid.id)!.company).toEqual({ id: COMPANY, as: 'loan', setBy: 'user' });
      expect(store.transaction(salary.id)!.company).toEqual({ id: COMPANY, as: 'pay', setBy: 'user' });
    });

    it('in bulk: every one fits, or none changes', async () => {
      const bad = await send('POST', '/api/transactions/bulk', { ids: [hosting.id, studioRow.id], company: { id: COMPANY, as: 'paid-for' } });
      expect(bad.status).toBe(400);
      expect(store.transaction(hosting.id)!.company).toBeUndefined();
      const ok = await send('POST', '/api/transactions/bulk', { ids: [hosting.id, lent.id], company: { id: COMPANY, as: 'paid-for' } });
      expect(ok.body).toEqual({ updated: 2 });
      expect(store.transaction(lent.id)!.company?.as).toBe('paid-for');
    });

    it('takes no split while it moves the loan, and a correction cannot make pay money out', async () => {
      await mark(hosting, 'paid-for');
      expect((await send('PATCH', `/api/transactions/${hosting.id}`, { splits: [{ amount: -12, category: 'software' }, { amount: -12, category: 'groceries' }] })).body.error).toMatch(/cannot be split/);
      await send('PATCH', `/api/transactions/${cafe.id}`, { splits: [{ amount: -3.5, category: 'coffee' }, { amount: -3, category: 'groceries' }] });
      expect((await mark(cafe, 'paid-for')).body.error).toMatch(/take the split away first/);
      await mark(salary, 'pay');
      expect((await send('PATCH', `/api/transactions/${salary.id}`, { amount: -1800 })).body.error).toMatch(/money out: pay/);
      expect(store.transaction(salary.id)!.amount).toBe(1800);
    });

    it('agent tokens cannot set one directly: only through a proposal', async () => {
      expect(requiredScope('PATCH', `/api/transactions/${hosting.id}`)).toBeNull();
      expect(requiredScope('POST', '/api/transactions/bulk')).toBeNull();
      expect(requiredScope('PUT', `/api/companies/${COMPANY}`)).toBeNull();
      expect(requiredScope('POST', `/api/companies/${COMPANY}/director-loan`)).toBeNull();
      const agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records', 'imports', 'jobs'], days: 1 })).token}`;
      expect((await send('PATCH', `/api/transactions/${hosting.id}`, { company: { id: COMPANY, as: 'paid-for' } }, { authorization: agent })).status).toBe(403);
      expect(store.transaction(hosting.id)!.company).toBeUndefined();
    });

    it("a company's row loses a mark a hand edit left on it when its rows are worked out", async () => {
      await store.updateTransactions([{ id: lent.id, patch: { company: { id: COMPANY, as: 'loan', setBy: 'user' } } }], 'test');
      // The account becomes the company's: its rows are worked out again for their new side.
      expect((await send('PATCH', '/api/accounts/current', { companyId: COMPANY, includeInNetWorth: false })).status).toBe(200);
      expect(store.transaction(lent.id)!.company).toBeUndefined();
    });
  });

  describe('your figures', () => {
    it('a row paid for the company or lent is not your spending or income; pay and dividends still are', async () => {
      const from = T0;
      const to = today();
      const before = await get<CashflowResponse>(`/api/cashflow?from=${from}&to=${to}`);
      await mark(hosting, 'paid-for');
      await mark(lent, 'loan');
      await mark(repaid, 'loan');
      await mark(salary, 'pay');
      const after = await get<CashflowResponse>(`/api/cashflow?from=${from}&to=${to}`);
      expect(toMinor(before.totals.spending) - toMinor(after.totals.spending)).toBe(2400 + 50_000);
      expect(toMinor(before.totals.income) - toMinor(after.totals.income)).toBe(20_000);
      // Not in the To categorise queue either.
      const queue = await get<{ payees: { examples: { id: string }[] }[] }>('/api/categorise/queue');
      expect(JSON.stringify(queue)).not.toContain(lent.id);
    });

    it("the month in review shows money with the company where it went, and its parts add up", async () => {
      await mark(hosting, 'paid-for');
      await mark(lent, 'loan');
      await mark(repaid, 'loan');
      const month = (await get<MonthSummary>(`/api/month/${hosting.date.slice(0, 7)}`)).whereItWent;
      const item = month.items.find((i) => i.id === 'company');
      const inMonth = [hosting, lent, repaid].filter((t) => t.date.slice(0, 7) === hosting.date.slice(0, 7));
      expect(item?.amount).toBe(fromMinor(-inMonth.reduce((s, t) => s + toMinor(t.amount), 0)));
      expect(item?.parts.map((p) => p.name)).toEqual(['EXAMPLE STUDIO LTD']);
      expect(month.items.reduce((s, i) => s + toMinor(i.amount), 0)).toBe(toMinor(month.total));
    });
  });

  describe("the director's loan", () => {
    it('is the movements of the marked rows, anchored by a balance you record, without counting anything twice', async () => {
      const worth = async () => toMinor((await get<SummaryResponse>('/api/summary')).estate.value);
      const was = await worth();
      await mark(hosting, 'paid-for');
      await mark(lent, 'loan');
      await mark(repaid, 'loan');
      await mark(salary, 'pay');
      // Each marked row is now a move between two of your accounts: it stays in its own account, and
      // the loan holds what the company owes you for it. Your estate is up by exactly that (it was
      // spending, and money in, before), and nothing is counted twice.
      expect((await worth()) - was).toBe(2400 + 50_000 - 20_000);
      let page = await get<AccountDetailResponse>('/api/accounts/loan');
      expect(page.summary.balance).toBe(24 + 500 - 200);
      expect(page.directorLoan?.company).toEqual({ id: COMPANY, name: 'EXAMPLE STUDIO LTD' });
      expect(page.directorLoan?.movements.map((m) => [m.id, m.kind, m.amount, m.accountName])).toEqual([
        [movementId(repaid.id), 'repaid', -200, 'Everyday'],
        [movementId(lent.id), 'lent', 500, 'Everyday'],
        [movementId(hosting.id), 'paid-for', 24, 'Example Card'],
      ]);
      // A balance you record (the figure in the filed accounts) anchors it; movements after it are added.
      expect((await send('POST', '/api/accounts/loan/balances', { date: day(4), balance: 1000 })).status).toBe(201);
      page = await get<AccountDetailResponse>('/api/accounts/loan');
      expect(page.summary.balance).toBe(1000 - 200);
      // Its own source rows' accounts are as they were: each still holds its row.
      expect((await get<AccountDetailResponse>('/api/accounts/current')).summary.balance).toBe(3000 - 500 + 200 + 1800 - 6.5);
      // It has no rows of its own.
      expect((await send('POST', '/api/transactions', { accountId: 'loan', date: day(2), amount: 10, description: 'BY HAND' })).body.error).toMatch(/director’s loan account/);
    });

    it('warns when you owe the company, at the s455 rate of the year, and over the benefit threshold', async () => {
      await mark(repaid, 'loan');
      const big = tx('current', day(5), 12_000, 'EXAMPLE STUDIO LTD ADVANCE');
      await store.addTransactions([big], 'test');
      await mark(big, 'loan');
      const page = await get<AccountDetailResponse>('/api/accounts/loan');
      expect(page.summary.balance).toBe(-12_200);
      const kinds = page.directorLoan!.warnings.map((w) => w.kind);
      expect(kinds).toEqual(['s455', 'beneficial-loan']);
      const rate = `${Math.round(s455Rate(today()) * 10_000) / 100}%`;
      expect(page.directorLoan!.warnings[0]!.detail).toContain(rate);
      expect(page.directorLoan!.warnings[0]!.detail).toMatch(/s455.*s458.*s464ZA/s);
      expect(page.directorLoan!.warnings[1]!.detail).toMatch(/ITEPA 2003 s180/);
      const health = await get<DataHealthResponse>('/api/data-health');
      expect(health.directorLoans?.[0]).toMatchObject({ accountId: 'loan', companyName: 'EXAMPLE STUDIO LTD', balance: -12_200 });
      const summary = await get<SummaryResponse>('/api/summary');
      expect(summary.alerts.map((a) => a.id)).toEqual(expect.arrayContaining(['director-loan-s455-loan', 'director-loan-beneficial-loan-loan']));
    });

    it('warns of nothing while the company owes you, and of the benefit only over £10,000 in the year', () => {
      expect(directorLoanWarnings('EXAMPLE STUDIO LTD', 500, null, today())).toEqual([]);
      expect(directorLoanWarnings('EXAMPLE STUDIO LTD', 0, { amount: 10_000, date: today() }, today())).toEqual([]);
      expect(directorLoanWarnings('EXAMPLE STUDIO LTD', 0, { amount: 10_000.01, date: today() }, today()).map((w) => w.kind)).toEqual(['beneficial-loan']);
    });

    it("s455 follows the dividend upper rate of the year the money was lent; 25% before 6 April 2016", () => {
      expect(s455Rate('2016-04-05')).toBe(0.25);
      expect(s455Rate('2016-04-06')).toBe(0.325);
      expect(s455Rate('2022-04-05')).toBe(0.325);
      expect(s455Rate('2022-04-06')).toBe(0.3375);
      expect(s455Rate('2026-04-05')).toBe(0.3375);
      expect(s455Rate('2026-04-06')).toBe(0.3575);
    });

    it('a company names at most one, of the right kind, of yours; you link, unlink and add one', async () => {
      const put = (body: unknown, id = COMPANY) => send('PUT', `/api/companies/${id}`, body);
      expect((await put({ directorLoanAccountId: 'saver' })).body.error).toMatch(/not a director’s loan account/);
      expect((await put({ directorLoanAccountId: 'no-such' })).body.error).toMatch(/not in your data/);
      expect((await put({ directorLoanAccountId: 'loan' }, 'other-co')).body.error).toMatch(/director’s loan with EXAMPLE STUDIO LTD already/);
      // A director's loan is never one of the company's own accounts.
      expect((await send('PATCH', '/api/accounts/loan', { companyId: COMPANY, includeInNetWorth: false })).body.error).toMatch(/never one of the company’s own accounts/);
      // Nor can it stop being one while a company names it, nor be deleted.
      expect((await send('PATCH', '/api/accounts/loan', { type: 'other_asset' })).body.error).toMatch(/take that link away/);
      expect((await send('DELETE', '/api/accounts/loan', {})).body.error).toMatch(/take that link away/);
      expect((await put({ directorLoanAccountId: null })).status).toBe(200);
      expect(store.company(COMPANY)!.directorLoanAccountId).toBeUndefined();
      // An account with rows of its own cannot become one.
      expect((await send('PATCH', '/api/accounts/saver', { type: 'director_loan' })).body.error).toMatch(/rows of its own/);
      // Added and linked in one request, with its first balance.
      const made = await send('POST', '/api/companies/other-co/director-loan', { balance: 750, balanceDate: day(1) });
      expect(made.status).toBe(201);
      const id = (made.body.account as Account).id;
      expect(store.account(id)).toMatchObject({ type: 'director_loan', includeInNetWorth: true });
      expect(store.company('other-co')!.directorLoanAccountId).toBe(id);
      expect(store.balances(id).map((b) => b.balance)).toEqual([750]);
      expect((await send('POST', '/api/companies/other-co/director-loan', {})).status).toBe(409);
      const view = (await get<CompanyView[]>('/api/companies')).find((c) => c.company.id === 'other-co')!;
      expect(view.directorLoan).toMatchObject({ accountId: id, balance: 750 });
    });

    it('an unlinked director’s loan account has no movements', async () => {
      await mark(lent, 'loan');
      await send('PUT', `/api/companies/${COMPANY}`, { directorLoanAccountId: null });
      const page = await get<AccountDetailResponse>('/api/accounts/loan');
      expect(page.directorLoan).toEqual({ movements: [], warnings: [] });
      expect(page.summary.balance).toBeNull();
    });
  });

  describe('the set_company proposal', () => {
    const propose = async (changes: ProposalInput['changes']) => {
      const agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
      const res = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ title: 'Company money', summary: 'Marks.', provenance: { model: 'test-model' }, changes }) });
      return { status: res.status, body: (await res.json()) as ProposalView & { problems?: { key: string; problem: string }[] } };
    };

    it('is checked, shown and applied: the mark is the agent’s, and the owner can change it', async () => {
      const made = await propose([{ key: 'a', kind: 'set_company', why: 'Hosting for the studio.', transaction: hosting.id, company: { id: COMPANY, as: 'paid-for' } }]);
      expect(made.status).toBe(201);
      expect(made.body.changes[0]!.mark).toEqual({ company: 'EXAMPLE STUDIO LTD' });
      expect(made.body.rows[hosting.id]!.company).toBeUndefined();
      const applied = await send('POST', `/api/proposals/${made.body.proposal.id}/apply`, {});
      expect(applied.status).toBe(200);
      expect(store.transaction(hosting.id)!.company).toEqual({ id: COMPANY, as: 'paid-for', setBy: 'agent' });
      // An agent may take its own mark away.
      const undo = await propose([{ key: 'b', kind: 'set_company', why: 'Not the studio’s after all.', transaction: hosting.id, company: null }]);
      expect(undo.status).toBe(201);
      expect(undo.body.changes[0]!.mark).toEqual({ was: 'Paid for the company: EXAMPLE STUDIO LTD' });
    });

    it('never over a mark of yours, never on a company’s row, and only where a mark fits', async () => {
      await mark(lent, 'loan');
      const res = await propose([
        { key: 'a', kind: 'set_company', why: 'Pay.', transaction: lent.id, company: null },
        { key: 'b', kind: 'set_company', why: 'Theirs.', transaction: studioRow.id, company: { id: COMPANY, as: 'loan' } },
        { key: 'c', kind: 'set_company', why: 'Pay.', transaction: hosting.id, company: { id: COMPANY, as: 'pay' } },
        { key: 'd', kind: 'set_company', why: 'Same.', transaction: lent.id, company: { id: COMPANY, as: 'loan' } },
      ]);
      expect(res.status).toBe(422);
      expect(res.body.problems.map((p) => [p.key, p.problem])).toEqual([
        ['a', expect.stringMatching(/You marked it yourself/)],
        ['b', expect.stringMatching(/own account, not yours/)],
        ['c', expect.stringMatching(/money out: pay/)],
        ['d', expect.stringMatching(/already says this/)],
      ]);
      // A marked row is not linked as a transfer by a proposal either.
      const link = await propose([{ key: 'l', kind: 'link_transfer', why: 'Same money.', from: lent.id, to: saverIn.id }]);
      expect(link.body.problems?.[0]?.problem).toMatch(/marked as money with EXAMPLE STUDIO LTD/);
    });
  });
});

// ─── Properties, over the engine and the flows alone ─────────────────────────────────────────────

const ACCOUNTS: Account[] = [acct('current', 'Everyday', 'current'), acct('card', 'Example Card', 'credit_card'), acct('saver', 'Rainy Day', 'savings'), acct('loan', 'Director’s loan', 'director_loan')];
const START = '2026-01-01';
const DAYS = 90;
const CATS = ['groceries', 'software', 'salary', 'transfers', 'refunds', undefined] as const;
const MARKS: (CompanyMark['as'] | null)[] = [null, null, 'paid-for', 'loan', 'pay', 'dividend'];

interface Draw {
  account: number;
  day: number;
  pence: number;
  cat: number;
  mark: number;
}
const draw = fc.record({ account: fc.nat(2), day: fc.nat(DAYS - 1), pence: fc.integer({ min: -300_000, max: 300_000 }).filter((p) => p !== 0), cat: fc.nat(CATS.length - 1), mark: fc.nat(MARKS.length - 1) });
const world = fc.record({
  rows: fc.array(draw, { minLength: 5, maxLength: 60 }),
  anchors: fc.array(fc.record({ account: fc.nat(2), day: fc.nat(DAYS - 1), pence: fc.integer({ min: -500_000, max: 500_000 }) }), { maxLength: 6 }),
  loanAnchor: fc.option(fc.record({ day: fc.nat(DAYS - 1), pence: fc.integer({ min: -2_000_000, max: 2_000_000 }) }), { nil: undefined }),
});

/** Rows from draws, each with its mark when the mark fits its sign (pay and dividends are money in). */
function rowsOf(draws: readonly Draw[], marked: boolean): Transaction[] {
  return draws.map((d, i) => {
    const account = ACCOUNTS[d.account]!;
    const amount = d.pence / 100;
    const as = MARKS[d.mark]!;
    const cat = CATS[d.cat];
    const fits = as && !((as === 'pay' || as === 'dividend') && amount < 0);
    return tx(account.id, addDays(START, d.day), amount, `ROW ${i}`, { ...(cat ? { category: cat, categorisedBy: 'builtin' as const } : {}), ...(marked && fits ? { company: { id: COMPANY, as, setBy: 'user' as const } } : {}) }, i);
  });
}

function sourceOf(txs: Transaction[], balances: BalanceSnapshot[]): BalanceSource & Pick<Store, 'categories'> {
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
  return {
    accounts: ACCOUNTS,
    settings: SettingsSchema.parse({}),
    companies: [company({ accountId: undefined, directorLoanAccountId: 'loan' })],
    categories: defaultCategories(),
    transactions: ((id?: string) => (id ? sorted.filter((t) => t.accountId === id) : sorted)),
    balances: ((id?: string) => [...balances].filter((b) => !id || b.accountId === id).sort((a, b) => a.date.localeCompare(b.date))),
  };
}

describe("the director's loan, as properties", () => {
  it('marking moves value between your accounts and never makes or loses any: every other account is as it was, and the estate differs by the loan alone (no anchor on it)', () => {
    fc.assert(
      fc.property(world, (w) => {
        const anchors = w.anchors.map((a) => anchor(ACCOUNTS[a.account]!.id, addDays(START, a.day), a.pence / 100));
        const plainRows = rowsOf(w.rows, false);
        const markedRows = rowsOf(w.rows, true);
        const plain = sourceOf(plainRows, anchors);
        const marked = sourceOf(markedRows, anchors);
        const [e0, e1] = [new BalanceEngine(plain), new BalanceEngine(marked)];
        const moving = markedRows.filter((t) => t.company && (t.company.as === 'paid-for' || t.company.as === 'loan'));
        for (let d = 0; d < DAYS; d++) {
          const date = addDays(START, d);
          // Each row stays in its own account: no account but the loan changes.
          for (const a of ACCOUNTS.filter((x) => x.id !== 'loan')) expect(e1.balanceOn(a.id, date)?.value).toBe(e0.balanceOn(a.id, date)?.value);
          // Without the marks there is no loan; with them, it is what the marked rows moved to it, to the penny.
          expect(e0.balanceOn('loan', date)).toBeNull();
          const loanMinor = moving.filter((t) => t.date <= date).reduce((s, t) => s - toMinor(t.amount), 0);
          const loan = e1.balanceOn('loan', date);
          expect(loan === null ? 0 : toMinor(loan.value)).toBe(loanMinor);
          // So the pair (a row and its movement) sums to nothing: the estate is the unmarked one plus the loan.
          expect(toMinor(estateOn(marked as unknown as Store, e1, date).total)).toBe(toMinor(estateOn(plain as unknown as Store, e0, date).total) + loanMinor);
        }
      }),
      { seed: 20261126, numRuns: 60 },
    );
  });

  it('spending and income drop exactly the rows paid for the company or lent; pay and dividends are untouched', () => {
    fc.assert(
      fc.property(world, (w) => {
        const plainRows = rowsOf(w.rows, false);
        const markedRows = rowsOf(w.rows, true);
        const total = (rows: Transaction[], cls: 'income' | 'spending') => flows(sourceOf(rows, []) as unknown as Store, START, addDays(START, DAYS)).filter((f) => f.cls === cls);
        for (const cls of ['income', 'spending'] as const) {
          const before = total(plainRows, cls);
          const after = total(markedRows, cls);
          const moving = new Set(markedRows.filter((t) => t.company && (t.company.as === 'paid-for' || t.company.as === 'loan')).map((t) => t.id));
          expect(after.map((f) => f.t.id)).toEqual(before.filter((f) => !moving.has(f.t.id)).map((f) => f.t.id));
          expect(after.reduce((s, f) => s + f.minor, 0)).toBe(before.filter((f) => !moving.has(f.t.id)).reduce((s, f) => s + f.minor, 0));
        }
      }),
      { seed: 20261127, numRuns: 80 },
    );
  });

  it("the loan's balance is its anchor plus the negated marked amounts after it, and the movements are those rows", () => {
    fc.assert(
      fc.property(world, (w) => {
        const rows = rowsOf(w.rows, true);
        const loanAnchors = w.loanAnchor ? [anchor('loan', addDays(START, w.loanAnchor.day), w.loanAnchor.pence / 100)] : [];
        const source = sourceOf(rows, loanAnchors);
        const engine = new BalanceEngine(source);
        const moving = rows.filter((t) => t.company && (t.company.as === 'paid-for' || t.company.as === 'loan'));
        expect(directorLoanMovements(source, COMPANY).map((m) => [m.id, m.amount])).toEqual(
          [...moving].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [movementId(t.id), fromMinor(-toMinor(t.amount))]),
        );
        for (let d = 0; d < DAYS; d++) {
          const date = addDays(START, d);
          const v = engine.balanceOn('loan', date)?.value;
          // Before its first data (a movement or the anchor) it holds nothing known, as any account.
          const firstData = [...moving.map((t) => t.date), ...(w.loanAnchor ? [addDays(START, w.loanAnchor.day)] : [])].sort()[0];
          if (!firstData || date < firstData) {
            expect(v).toBeUndefined();
            continue;
          }
          if (w.loanAnchor) {
            const a = addDays(START, w.loanAnchor.day);
            const sum = (from: string, to: string) => moving.filter((t) => t.date > from && t.date <= to).reduce((s, t) => s - toMinor(t.amount), 0);
            const want = date >= a ? w.loanAnchor.pence + sum(a, date) : w.loanAnchor.pence - sum(date, a);
            expect(v === undefined ? undefined : toMinor(v)).toBe(want);
          } else {
            expect(toMinor(v!)).toBe(moving.filter((t) => t.date <= date).reduce((s, t) => s - toMinor(t.amount), 0));
          }
        }
      }),
      { seed: 20261128, numRuns: 60 },
    );
  });
});
