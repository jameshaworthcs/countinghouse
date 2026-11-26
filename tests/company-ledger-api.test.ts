// A company's general ledger through the app (routes/company-books.ts, analytics/ledger.ts; DATA_FORMAT.md
// transactions `books` and `companyLink`, journals.jsonl, rules.json book rules): the store refuses a
// coding, a link or a journal that does not fit; enrichment codes by book rules and links exact matches
// by itself; the owner codes, links and writes journals; an agent only proposes; and with books kept, the
// director's loan moves by the ledger. Every company, name and figure is invented.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDetailResponse, CompanyCodingResponse, CompanyLedgerResponse, DataHealthResponse, ProposalDecision, ProposalView } from '../src/shared/api';
import type { Account, Company, Journal, ProposalInput, Rule, Transaction } from '../src/shared/schema';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { enrich } from '../src/server/enrich';
import { transactionId } from '../src/server/ids';
import { Store } from '../src/server/store';
import { requiredScope } from '../src/server/tokens';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';
const CO = 'example-forge';

const acct = (id: string, name: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}, n = 0): Transaction => ({ id: transactionId(accountId, date, amount, description, n), accountId, date, amount, currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
const forge = (books = true): Company => ({
  id: CO,
  name: 'Example Forge Ltd',
  holdings: [],
  valuations: [],
  directorLoanAccountId: 'forge-loan',
  createdBy: 'owner',
  createdAt: stamp,
  updatedAt: stamp,
  ...(books ? { books: { incorporatedOn: '2024-02-01', periods: [], ctPeriods: [], filings: [], setBy: 'owner' as const, updatedAt: stamp, vat: { registeredFrom: '2024-04-01', scheme: 'cash' as const, schedule: [{ from: '2024-04-01', stagger: 'quarterly-1' as const }] } } } : {}),
});

const lent = tx('current', '2025-06-02', -750, 'TO FORGE ACCOUNT', { company: { id: CO, as: 'loan', setBy: 'user' } });
const arrived = tx('forge-bank', '2025-06-03', 750, 'FROM J BLOGGS');
const tools = tx('card', '2025-06-04', -60, 'EXAMPLE TOOLS LTD', { company: { id: CO, as: 'paid-for', setBy: 'user' } });
const sale = tx('forge-bank', '2025-06-05', 1800, 'EXAMPLE CLIENT LTD INV 0042');
const cloud = tx('forge-card', '2025-06-06', -36, 'EXAMPLE CLOUD INC');
const coffee = tx('current', '2025-06-07', -3.2, 'EXAMPLE CAFE');

describe('a company’s general ledger through the app', () => {
  let app: App;
  let dir: string;
  let store: Store;
  let agent: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-ledger-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
    store = app.ctx.store;
    await store.setAccounts([acct('current', 'Everyday', 'current'), acct('card', 'Example Card', 'credit_card'), acct('forge-loan', 'Director’s loan', 'director_loan')]);
    await store.setCompanies([forge()]);
    for (const a of [acct('forge-bank', 'Forge Account', 'current', { companyId: CO, includeInNetWorth: false }), acct('forge-card', 'Forge Card', 'credit_card', { companyId: CO, includeInNetWorth: false })]) await store.upsertAccount(a);
    await store.addTransactions([lent, arrived, tools, sale, cloud, coffee], 'test: rows');
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const json = async <T>(p: string) => (await (await req(p)).json()) as T;
  const send = async (method: string, p: string, body?: unknown, auth?: string) => {
    const r = await req(p, { method, headers: { ...CSRF, ...(auth ? { authorization: auth } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const propose = async (p: ProposalInput) => {
    const r = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(p) });
    return { status: r.status, body: (await r.json()) as ProposalView & { problems?: { key: string; problem: string }[] } };
  };
  const apply = async (id: string) => (await send('POST', `/api/proposals/${id}/apply`, {})).body as unknown as ProposalDecision;
  const loanBalance = async () => (await json<AccountDetailResponse>('/api/accounts/forge-loan')).summary.balance;

  it('codes a row where it applies and as it fits, and refuses the rest', async () => {
    const code = (t: Transaction, books: unknown) => send('PUT', `/api/companies/${CO}/rows/${t.id}/books`, { books });
    expect((await code(sale, { ledger: 'turnover', vat: { amount: 300, treatment: 'standard' } })).status).toBe(200);
    expect(store.transaction(sale.id)?.books).toEqual({ ledger: 'turnover', vat: { amount: 300, treatment: 'standard' }, setBy: 'user' });
    expect((await code(tools, { ledger: 'small-equipment', vat: { amount: -10, treatment: 'standard' } })).status).toBe(200);
    // Not a row of the company's books, a VAT bigger than the row, a fixed asset where none goes.
    expect((await code(coffee, { ledger: 'travel' })).status).toBe(404);
    expect((await code(cloud, { ledger: 'software-hosting', vat: { amount: -40, treatment: 'standard' } })).status).toBe(422);
    expect((await code(cloud, { ledger: 'travel', asset: { class: 'computer' } })).status).toBe(422);
    // The store refuses it on every path, not only this one.
    await expect(store.updateTransactions([{ id: coffee.id, patch: { books: { ledger: 'travel', setBy: 'user' } } }], 'test')).rejects.toThrow(/Only a company account’s row/);
    // A mark changed away from paid for takes its coding with it.
    await send('PATCH', `/api/transactions/${tools.id}`, { company: { id: CO, as: 'loan' } });
    expect(store.transaction(tools.id)?.books).toBeUndefined();
    // No token may code.
    expect((await send('PUT', `/api/companies/${CO}/rows/${sale.id}/books`, { books: null }, agent)).status).toBe(403);
    expect(requiredScope('PUT', `/api/companies/${CO}/rows/${sale.id}/books`)).toBeNull();
  });

  it('links the exact match by itself, keeps your own link and your “not linked”, and drops its own when a row changes', async () => {
    await enrich(store);
    expect(store.transaction(arrived.id)?.companyLink).toEqual({ rows: [lent.id], setBy: 'auto' });
    // Taking the mark away drops the app's own link with it.
    await send('PATCH', `/api/transactions/${lent.id}`, { company: null });
    expect(store.transaction(arrived.id)?.companyLink).toBeUndefined();
    await send('PATCH', `/api/transactions/${lent.id}`, { company: { id: CO, as: 'loan' } });
    // Your link stays, and refuses a change that would break it.
    expect((await send('PUT', `/api/companies/${CO}/rows/${arrived.id}/link`, { rows: [lent.id] })).status).toBe(200);
    expect((await send('PATCH', `/api/transactions/${lent.id}`, { company: null })).status).toBe(409);
    // A link that does not fit is refused: not a loan of yours, coded otherwise, or the company row coded to sales.
    expect((await send('PUT', `/api/companies/${CO}/rows/${sale.id}/link`, { rows: [tools.id] })).status).toBe(422);
    expect((await send('PUT', `/api/companies/${CO}/rows/${arrived.id}/books`, { books: { ledger: 'turnover' } })).status).toBe(422);
    // "Not linked": the app never links it again.
    expect((await send('PUT', `/api/companies/${CO}/rows/${arrived.id}/link`, { rows: [] })).status).toBe(200);
    await enrich(store);
    expect(store.transaction(arrived.id)?.companyLink).toEqual({ rows: [], setBy: 'user' });
    const coding = await json<CompanyCodingResponse>(`/api/companies/${CO}/coding`);
    expect(coding.suggestions.find((s) => s.personal.id === lent.id)?.candidates).toEqual([]);
  });

  it('serves the postings and checks, and moves the director’s loan by the books once they are kept', async () => {
    const before = await loanBalance();
    expect(before).toBe(750 + 60);
    await enrich(store);
    await store.putJournal({ id: 'jnl_00000000000a', companyId: CO, date: '2025-06-30', memo: 'June salary', lines: [{ ledger: 'directors-salaries', amount: 1048 }, { ledger: 'paye', amount: -48 }, { ledger: 'directors-loan', amount: -1000 }], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }, 'test: journal');
    const ledger = await json<CompanyLedgerResponse>(`/api/companies/${CO}/ledger?from=2025-06-01&to=2025-06-30`);
    expect(ledger.postings.filter((p) => p.source.id === arrived.id).map((p) => [p.ledger, p.amount])).toEqual([
      ['bank:forge-bank', 75000],
      ['directors-loan', -75000],
    ]);
    expect(ledger.totals.find((t) => t.ledger === 'directors-loan')).toEqual({ ledger: 'directors-loan', debit: 0, credit: 75000 + 6000 + 100000, net: -181000 });
    expect(ledger.checks.filter((c) => c.kind === 'uncoded').map((c) => (c as { transactionId: string }).transactionId).sort()).toEqual([tools.id, sale.id, cloud.id].sort());
    // With books kept, the loan is its books' postings: your marks and the journal's £1,000.
    expect(await loanBalance()).toBe(750 + 60 + 1000);
    const detail = await json<AccountDetailResponse>('/api/accounts/forge-loan');
    expect(detail.directorLoan?.movements.map((m) => m.source).sort()).toEqual(['company-row', 'journal', 'mark']);
    // Without books, the marks alone, as before.
    const { books: _b, ...withoutBooks } = store.company(CO)!;
    await store.upsertCompany(withoutBooks);
    expect(await loanBalance()).toBe(750 + 60);
    expect((await req(`/api/companies/${CO}/ledger`)).status).toBe(404);
  });

  it('book rules code the company’s rows and are kept apart from your rules', async () => {
    const rule = { name: 'Cloud hosting', enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE CLOUD', caseSensitive: false, company: { id: CO, rows: 'own' } }, set: { books: { ledger: 'software-hosting', vat: { treatment: 'reverse-charge' } } } };
    const res = await send('POST', `/api/companies/${CO}/book-rules`, rule);
    expect(res.status).toBe(201);
    expect(res.body.coded).toBe(1);
    expect(store.transaction(cloud.id)?.books).toMatchObject({ ledger: 'software-hosting', vat: { amount: -7.2, treatment: 'reverse-charge' }, setBy: 'rule' });
    // Your rules never list it, and a personal route cannot write one.
    expect(await json<Rule[]>('/api/rules')).toEqual([]);
    expect((await send('POST', '/api/rules', rule)).status).toBe(400);
    // A rule of yours still never touches the company's rows; re-applying keeps the rule's coding.
    await send('POST', '/api/rules', { enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: 'EXAMPLE CLOUD', caseSensitive: false }, set: { category: 'software' }, apply: true });
    expect(store.transaction(cloud.id)?.category).toBeUndefined();
    await enrich(store);
    expect(store.transaction(cloud.id)?.books?.ruleId).toBe((res.body.rule as Rule).id);
    // Deleting it takes away what it coded.
    await send('DELETE', `/api/companies/${CO}/book-rules/${(res.body.rule as Rule).id}`);
    expect(store.transaction(cloud.id)?.books).toBeUndefined();
  });

  it('writes, changes and takes away journals that add up, and refuses those that do not', async () => {
    const add = await send('POST', `/api/companies/${CO}/journals`, { journal: { date: '2024-02-01', memo: 'Shares issued at incorporation', lines: [{ ledger: 'share-capital-unpaid', amount: 100 }, { ledger: 'share-capital', amount: -100 }] } });
    expect(add.status).toBe(201);
    const j = add.body as unknown as Journal;
    expect((await send('POST', `/api/companies/${CO}/journals`, { journal: { date: '2024-02-01', memo: 'Off', lines: [{ ledger: 'share-capital-unpaid', amount: 100 }, { ledger: 'share-capital', amount: -99 }] } })).status).toBe(422);
    expect((await send('PUT', `/api/companies/${CO}/journals/${j.id}`, { journal: { ...j, memo: 'Shares issued' }, was: '2020-01-01T00:00:00+00:00' })).status).toBe(409);
    expect((await send('PUT', `/api/companies/${CO}/journals/${j.id}`, { journal: { date: j.date, memo: 'Shares issued', lines: j.lines }, was: j.updatedAt })).status).toBe(200);
    expect((await json<CompanyCodingResponse>(`/api/companies/${CO}/coding`)).journals.map((x) => x.memo)).toEqual(['Shares issued']);
    expect((await send('POST', `/api/companies/${CO}/journals`, { journal: { date: '2024-02-01', memo: 'x', lines: j.lines } }, agent)).status).toBe(403);
    expect((await send('DELETE', `/api/companies/${CO}/journals/${j.id}`)).status).toBe(200);
    expect(store.journal(j.id)).toBeUndefined();
  });

  it('an agent proposes codings, links, journals and book rules, never over yours', async () => {
    await store.updateTransactions([{ id: sale.id, patch: { books: { ledger: 'turnover', setBy: 'user' } } }], 'test: yours');
    const res = await propose({
      title: 'Code the forge’s June',
      summary: 'From its invoices.',
      changes: [
        { key: 'a', kind: 'set_books', why: 'An invoice for tools.', transaction: tools.id, books: { ledger: 'small-equipment', vat: { amount: -10, treatment: 'standard' } } },
        { key: 'b', kind: 'link_company', why: 'The same £750 a day apart.', transaction: arrived.id, rows: [lent.id] },
        { key: 'c', kind: 'add_journal', why: 'The payroll summary.', company: CO, journal: { date: '2025-06-30', memo: 'June salary', lines: [{ ledger: 'directors-salaries', amount: 1048 }, { ledger: 'paye', amount: -48 }, { ledger: 'directors-loan', amount: -1000 }] } },
        { key: 'd', kind: 'add_rule', why: 'Monthly hosting from abroad.', rule: { match: { field: 'description', op: 'contains', value: 'EXAMPLE CLOUD', caseSensitive: false, company: { id: CO, rows: 'own' } }, books: { ledger: 'software-hosting', vat: { treatment: 'reverse-charge' } } } },
      ],
    });
    expect(res.status).toBe(201);
    const refused = await propose({ title: 'Recode', summary: 'No.', changes: [{ key: 'a', kind: 'set_books', why: 'Again.', transaction: sale.id, books: { ledger: 'cost-of-sales' } }] });
    expect(refused.status).toBe(422);
    expect(refused.body.problems?.[0]?.problem).toMatch(/coded it yourself/);
    const decided = await apply(res.body.proposal.id);
    expect(decided.proposal.status).toBe('applied');
    expect(store.transaction(tools.id)?.books).toMatchObject({ ledger: 'small-equipment', setBy: 'agent' });
    expect(store.transaction(arrived.id)?.companyLink).toEqual({ rows: [lent.id], setBy: 'agent' });
    expect(store.transaction(cloud.id)?.books).toMatchObject({ ledger: 'software-hosting', setBy: 'rule' });
    const journal = (await json<CompanyCodingResponse>(`/api/companies/${CO}/coding`)).journals[0]!;
    expect(journal).toMatchObject({ memo: 'June salary', createdBy: 'agent' });
    // An agent's journal can be taken away by a proposal; yours cannot.
    const gone = await propose({ title: 'Take it away', summary: 'Twice.', changes: [{ key: 'a', kind: 'remove_journal', why: 'Entered twice.', journal: journal.id }] });
    expect(gone.status).toBe(201);
    expect((await apply(gone.body.proposal.id)).proposal.status).toBe('applied');
    expect(store.journal(journal.id)).toBeUndefined();
    expect((await store.readProposal(gone.body.proposal.id))?.before?.journals?.[0]?.id).toBe(journal.id);
  });

  it('reads a hand edit that left a coding, a link or a journal where it does not fit as a warning, never as data lost', async () => {
    const file = path.join(dir, 'data', 'journals.jsonl');
    await writeFile(file, `${JSON.stringify({ id: 'jnl_00000000000b', companyId: CO, date: '2025-06-30', memo: 'Off by a penny', lines: [{ ledger: 'travel', amount: 1 }, { ledger: 'bank:forge-bank', amount: -0.99 }], createdBy: 'owner', createdAt: stamp, updatedAt: stamp })}\n`);
    const rowsFile = path.join(dir, 'data', 'transactions', 'current', '2025.jsonl');
    const text = await readFile(rowsFile, 'utf8');
    await writeFile(rowsFile, text.replace(`"id":"${coffee.id}"`, `"id":"${coffee.id}","books":{"ledger":"travel","setBy":"user"}`));
    await store.load();
    const health = await json<DataHealthResponse>('/api/data-health');
    expect(health.issues.map((i) => i.message).join('\n')).toMatch(/Journal jnl_00000000000b does not fit/);
    expect(health.issues.map((i) => i.message).join('\n')).toMatch(new RegExp(`Transaction ${coffee.id} is coded where it does not fit`));
    // Re-working rows out takes a coding away from a row it does not apply to.
    await enrich(store);
    expect(store.transaction(coffee.id)?.books).toBeUndefined();
  });
});
