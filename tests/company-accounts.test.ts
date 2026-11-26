// A company's own accounts (Account.companyId; docs/DATA_FORMAT.md, accounts.json): never in your
// estate on any write path, kept out of the store's personal accessors, worked out apart by
// enrichment (no category of yours, transfers only within the company), and seen on their own page.
// The property that no personal figure changes is tests/company-scope.test.ts. Every name and figure
// is invented.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDetailResponse, AccountSummary, CompanyAccountsGroup, TransactionsResponse } from '../src/shared/api';
import type { Account, ProposalInput, Transaction } from '../src/shared/schema';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { crossingRows, enrich, linkTransfers, separateSides } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { Store, StoreError } from '../src/server/store';

const stamp = '2026-01-01T00:00:00+00:00';
const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const COMPANY = 'example-studio';

const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({ id: transactionId(accountId, date, amount, description, 0), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });

async function seed(store: Store): Promise<void> {
  await store.upsertInstitution({ id: 'example-bank', name: 'Example Bank', kind: 'bank' });
  await store.upsertInstitution({ id: 'capital-on-tap', name: 'Capital on Tap', kind: 'card_issuer' });
  await store.setProfile({ ...store.profile, name: 'Jo Bloggs' });
  await store.setAccounts([acct('current', 'Everyday', 'current', { institutionId: 'example-bank', last4: '1111' }), acct('card', 'Example Card', 'credit_card', { last4: '3333' }), acct('shares', 'Example Studio Ltd shares', 'other_asset')]);
  await store.setCompanies([{ id: COMPANY, name: 'EXAMPLE STUDIO LTD', holdings: [], valuations: [], accountId: 'shares', createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
  for (const a of [acct('studio-current', 'Studio Account', 'current', { institutionId: 'example-bank', last4: '4444', companyId: COMPANY, includeInNetWorth: false }), acct('studio-card', 'Studio Card', 'credit_card', { institutionId: 'capital-on-tap', last4: '4321', companyId: COMPANY, includeInNetWorth: false })]) await store.upsertAccount(a);
}

describe("a company's accounts", () => {
  let dir: string;
  let app: App;
  let store: Store;
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const send = async (method: string, p: string, body: unknown) => {
    const res = await req(p, { method, headers: CSRF, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-company-accounts-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
    store = app.ctx.store;
    await seed(store);
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('are never in your estate, on every write path', () => {
    it('made by hand: out of your estate by default, and refused in it', async () => {
      const made = await send('POST', '/api/accounts', { name: 'Studio savings', type: 'savings', companyId: COMPANY });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ companyId: COMPANY, includeInNetWorth: false });
      const refused = await send('POST', '/api/accounts', { name: 'Studio savings 2', type: 'savings', companyId: COMPANY, includeInNetWorth: true });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/never counted in your estate/);
      expect(store.allAccounts.some((a) => a.name === 'Studio savings 2')).toBe(false);
      // A company that is not in your data.
      expect((await send('POST', '/api/accounts', { name: 'Elsewhere', type: 'current', companyId: 'no-such-company' })).body.error).toMatch(/not in your data/);
      // Its id is unique among every account's, a company's too.
      const twin = await send('POST', '/api/accounts', { id: 'studio-current', name: 'Mine', type: 'current' });
      expect(twin.body.id).not.toBe('studio-current');
    });

    it('changed by hand: given to a company only out of your estate, and kept out of it', async () => {
      const alone = await send('PATCH', '/api/accounts/card', { companyId: COMPANY });
      expect(alone.status).toBe(400);
      expect(store.account('card')!.companyId).toBeUndefined();
      expect((await send('PATCH', '/api/accounts/card', { companyId: COMPANY, includeInNetWorth: false })).status).toBe(200);
      expect(store.account('card')).toMatchObject({ companyId: COMPANY, includeInNetWorth: false });
      expect((await send('PATCH', '/api/accounts/card', { includeInNetWorth: true })).status).toBe(400);
      // Back to you; then it may count again.
      expect((await send('PATCH', '/api/accounts/card', { companyId: null })).status).toBe(200);
      expect((await send('PATCH', '/api/accounts/card', { includeInNetWorth: true })).status).toBe(200);
    });

    it('the account carrying your shares in a company is yours, and a link carries on only on one side', async () => {
      expect((await send('PATCH', '/api/accounts/shares', { companyId: COMPANY, includeInNetWorth: false })).body.error).toMatch(/carries your shares/);
      expect((await send('PATCH', '/api/accounts/studio-current', { continues: { accountId: 'current', from: '2026-03-01' } })).body.error).toMatch(/cannot carry on/);
      // A company cannot carry your shares on its own account either.
      await expect(store.setCompanies([{ ...store.company(COMPANY)!, accountId: 'studio-current' }])).rejects.toThrow(/company's own account/);
    });

    it('in the store itself, whoever writes', async () => {
      const err = await store.upsertAccount({ ...store.account('studio-card')!, includeInNetWorth: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).status).toBe(400);
    });

    it('your own records cannot name one: goals, rules, agreements and money set aside', async () => {
      expect((await send('PUT', '/api/goals', [{ id: 'g', name: 'Buffer', targetAmount: 1000, accountIds: ['studio-current'] }])).status).toBe(400);
      expect((await send('POST', '/api/rules', { match: { value: 'STUDIO' }, set: { counterpartyAccountId: 'studio-current' } })).status).toBe(400);
      await expect(store.upsertAgreement({ id: 'a', name: 'Lending', counterparty: 'Example', names: [], direction: 'in', category: 'salary', accountId: 'studio-current', from: '2026-01-01', payments: [{ due: '2026-02-01', amount: 100 }], details: [], source: {}, createdBy: 'owner', createdAt: stamp, updatedAt: stamp })).rejects.toThrow(/a company's own account/);
      await expect(store.setEarmarks({ everyday: ['studio-current'], setAside: [], pots: [{ id: 'tax', name: 'Tax', start: '2026-01-01', opening: 0, rules: [], checks: [] }], decisions: {}, updatedAt: stamp })).rejects.toThrow(/a company's own account/);
    });

    it('an agent cannot propose a change to one', async () => {
      const agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
      await store.addTransactions([tx('studio-current', '2026-03-02', -50, 'EXAMPLE HOSTING LTD'), tx('current', '2026-03-02', 50, 'FROM STUDIO')], 'test');
      const proposal: ProposalInput = {
        title: 'Tidy up',
        summary: 'Two changes.',
        provenance: { model: 'test-model' },
        changes: [
          { key: 'a', kind: 'set_account_dates', why: 'Its first statement.', account: 'studio-current', openedOn: '2026-01-01' },
          { key: 'b', kind: 'link_transfer', why: 'Same money.', from: store.transactions('studio-current')[0]!.id, to: store.transactions('current')[0]!.id },
        ],
      };
      const res = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(proposal) });
      const body = (await res.json()) as { problems?: { problem: string }[] };
      expect(res.status).toBe(422);
      expect(body.problems!.map((p) => p.problem)).toEqual([expect.stringMatching(/EXAMPLE STUDIO LTD's own account, not yours/), expect.stringMatching(/EXAMPLE STUDIO LTD's own account, not yours/)]);
    });
  });

  describe('are kept out of the store’s personal accessors', () => {
    it('lists, totals and transactions are yours; a lookup by id finds any', async () => {
      await store.addTransactions([tx('studio-current', '2026-03-02', 1200, 'EXAMPLE CLIENT LTD'), tx('current', '2026-03-03', -20, 'EXAMPLE CAFE')], 'test');
      expect(store.accounts.map((a) => a.id)).toEqual(['current', 'card', 'shares']);
      expect(store.allAccounts).toHaveLength(5);
      expect(store.companyAccounts(COMPANY).map((a) => a.id)).toEqual(['studio-current', 'studio-card']);
      expect(store.transactions().map((t) => t.accountId)).toEqual(['current']);
      expect(store.transactionCount()).toBe(1);
      expect(store.allTransactions()).toHaveLength(2);
      expect(store.companyTransactions(COMPANY).map((t) => t.accountId)).toEqual(['studio-current']);
      expect(store.transactions('studio-current')).toHaveLength(1);
      expect(store.account('studio-current')?.companyId).toBe(COMPANY);
      // A provider only the company's accounts are at is not one of yours.
      expect(store.institutions.map((i) => i.id)).toEqual(['example-bank']);
      expect(store.allInstitutions.map((i) => i.id).sort()).toEqual(['capital-on-tap', 'example-bank']);
    });

    it('a hand edit that breaks the rules is reported when the data is read', async () => {
      const file = path.join(dir, 'data', 'accounts.json');
      const json = JSON.parse(await readFile(file, 'utf8')) as { accounts: Account[] };
      json.accounts.push(acct('stray', 'Stray', 'current', { companyId: 'no-such-company' }));
      await writeFile(file, JSON.stringify(json));
      await store.load();
      expect(store.issues.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringContaining('names unknown company "no-such-company"'), expect.stringContaining('says it counts in your estate')]));
    });
  });

  describe('are worked out apart by enrichment', () => {
    it('their rows get no category of yours; a transfer is linked within the company, never with you', async () => {
      await store.setRules([{ id: 'rule_hosting', enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE HOSTING', caseSensitive: false }, set: { category: 'software' }, createdAt: stamp, updatedAt: stamp }]);
      await store.addTransactions(
        [
          // The company pays its card: names the card's provider.
          tx('studio-current', '2026-03-10', -250, 'CAPITAL ON TAP REPAYMENT'),
          tx('studio-card', '2026-03-11', 250, 'PAYMENT RECEIVED THANK YOU'),
          // Your rule's words, a merchant the app knows, and the bank's category: none of them applies.
          tx('studio-card', '2026-03-12', -24.99, 'EXAMPLE HOSTING LTD', { category: 'software', categorisedBy: 'rule', ruleId: 'rule_hosting' }),
          tx('studio-current', '2026-03-13', -9.5, 'TESCO STORES 3297', { bankCategory: 'Groceries' }),
          // A row you categorised on a company's account stays yours.
          tx('studio-current', '2026-03-14', -15, 'EXAMPLE STATIONERS', { category: 'professional-fees', categorisedBy: 'user' }),
          // Your money to the company and the company's to you: the same amount, the same day, each
          // naming the other side. Not a transfer between accounts of one side.
          tx('current', '2026-03-20', -500, 'TO STUDIO ACCOUNT 12344444', { category: 'transfers', categorisedBy: 'builtin' }),
          tx('studio-current', '2026-03-20', 500, 'FROM JO BLOGGS EVERYDAY 12341111'),
          tx('current', '2026-03-21', -33, 'EXAMPLE HOSTING LTD'),
        ],
        'test',
      );
      await enrich(store);
      const of = (accountId: string, amount: number) => store.transactions(accountId).find((t) => t.amount === amount)!;
      expect(of('studio-current', -250)).toMatchObject({ counterpartyAccountId: 'studio-card', categorisedBy: 'transfer', category: 'credit-card-payment' });
      expect(of('studio-card', 250)).toMatchObject({ counterpartyAccountId: 'studio-current', transferGroup: of('studio-current', -250).transferGroup });
      const hosting = of('studio-card', -24.99);
      expect([hosting.category, hosting.categorisedBy, hosting.ruleId]).toEqual([undefined, undefined, undefined]);
      expect(hosting.payee).toBe('Example Hosting Ltd');
      expect(of('studio-current', -9.5).category).toBeUndefined();
      expect(of('studio-current', -15)).toMatchObject({ category: 'professional-fees', categorisedBy: 'user' });
      for (const t of [of('current', -500), of('studio-current', 500)]) {
        expect(t.transferGroup).toBeUndefined();
        expect(t.counterpartyAccountId).toBeUndefined();
      }
      expect(of('studio-current', 500).category).toBeUndefined();
      // Your own rows are categorised as they always were.
      expect(of('current', -33)).toMatchObject({ category: 'software', categorisedBy: 'rule' });

      // Working it out again changes nothing.
      const again = await enrich(store, { dryRun: true, detail: true });
      expect(again.changes).toEqual([]);
      // Nor does linking the rows an import would have added.
      expect(await linkTransfers(store, store.allTransactions().map((t) => t.id), 'test')).toBe(0);
    });

    it('linking at commit pairs within one side only', async () => {
      await store.addTransactions([tx('current', '2026-04-01', -300, 'TRANSFER TO STUDIO ACCOUNT'), tx('studio-current', '2026-04-01', 300, 'TRANSFER FROM EVERYDAY'), tx('studio-card', '2026-04-02', 300, 'PAYMENT RECEIVED'), tx('studio-current', '2026-04-02', -300, 'CAPITAL ON TAP')], 'test');
      const linked = await linkTransfers(store, store.allTransactions().map((t) => t.id), 'test');
      expect(linked).toBe(1);
      expect(store.transactions('current')[0]!.transferGroup).toBeUndefined();
      expect(store.transactions('studio-card')[0]!.counterpartyAccountId).toBe('studio-current');
    });

    it('an account given to a company: its rows lose your categories, and a transfer with yours is unlinked on both sides; given back, they are yours again', async () => {
      await store.addTransactions([tx('current', '2026-05-01', -100, 'TO EXAMPLE CARD 12343333'), tx('card', '2026-05-02', 100, 'PAYMENT RECEIVED THANK YOU'), tx('card', '2026-05-03', -12.5, 'TESCO STORES 3297')], 'test');
      await enrich(store);
      expect(store.transactions('card')[0]!.transferGroup).toBeDefined();
      expect(store.transactions('card')[1]!.category).toBe('groceries');

      expect((await send('PATCH', '/api/accounts/card', { companyId: COMPANY, includeInNetWorth: false })).status).toBe(200);
      const [repaid, shop] = store.transactions('card');
      expect([repaid!.transferGroup, repaid!.counterpartyAccountId, repaid!.category]).toEqual([undefined, undefined, undefined]);
      expect(shop!.category).toBeUndefined();
      const out = store.transactions('current')[0]!;
      expect([out.transferGroup, out.counterpartyAccountId]).toEqual([undefined, undefined]);
      expect(crossingRows(store).size).toBe(0);

      expect((await send('PATCH', '/api/accounts/card', { companyId: null })).status).toBe(200);
      expect(store.transactions('card')[1]!.category).toBe('groceries');
      expect(store.transactions('card')[0]!.counterpartyAccountId).toBe('current');
    });

    it('a link across the line left by a hand edit is taken away at start-up (separateSides)', async () => {
      await store.addTransactions([tx('current', '2026-06-01', -40, 'TO STUDIO'), tx('studio-current', '2026-06-01', 40, 'FROM JO BLOGGS')], 'test');
      const [a] = store.transactions('current');
      const [b] = store.transactions('studio-current');
      await store.updateTransactions(
        [
          { id: a!.id, patch: { transferGroup: 'tg_handedit00000000', counterpartyAccountId: 'studio-current', category: 'transfers', categorisedBy: 'transfer' } },
          { id: b!.id, patch: { transferGroup: 'tg_handedit00000000', counterpartyAccountId: 'current', category: 'transfers', categorisedBy: 'transfer' } },
        ],
        'test: hand edit',
      );
      expect(crossingRows(store).size).toBe(2);
      expect(await separateSides(store)).toBe(2);
      expect(crossingRows(store).size).toBe(0);
      for (const id of [a!.id, b!.id]) expect([store.transaction(id)!.transferGroup, store.transaction(id)!.counterpartyAccountId]).toEqual([undefined, undefined]);
      expect(store.transaction(b!.id)!.category).toBeUndefined();
    });
  });

  describe('have their own page and group', () => {
    it('its page: its balance, its rows, its imports', async () => {
      await store.addTransactions([tx('studio-current', '2026-03-02', 1200, 'EXAMPLE CLIENT LTD', { balanceAfter: 1200 }), tx('studio-current', '2026-03-05', -24.99, 'EXAMPLE HOSTING LTD', { balanceAfter: 1175.01 })], 'test');
      const detail = (await (await req('/api/accounts/studio-current')).json()) as AccountDetailResponse;
      expect(detail.account.companyId).toBe(COMPANY);
      expect(detail.summary).toMatchObject({ companyId: COMPANY, includeInNetWorth: false, balance: 1175.01, transactionCount: 2 });
      expect(detail.series.length).toBeGreaterThan(0);
      const rows = (await (await req('/api/transactions?accounts=studio-current')).json()) as TransactionsResponse;
      expect(rows.total).toBe(2);
      // Not without asking for it by name.
      expect(((await (await req('/api/transactions')).json()) as TransactionsResponse).total).toBe(0);
      // Not among your accounts; in the company's own group.
      expect(((await (await req('/api/accounts')).json()) as AccountSummary[]).map((a) => a.id)).toEqual(['current', 'card', 'shares']);
      const groups = (await (await req('/api/company-accounts')).json()) as CompanyAccountsGroup[];
      expect(groups).toEqual([{ company: { id: COMPANY, name: 'EXAMPLE STUDIO LTD', known: true }, accounts: [expect.objectContaining({ id: 'studio-current', balance: 1175.01 }), expect.objectContaining({ id: 'studio-card' })] }]);
      const summary = (await (await req('/api/summary')).json()) as { estate: { value: number } };
      expect(summary.estate.value).toBe(0);
    });
  });
});
