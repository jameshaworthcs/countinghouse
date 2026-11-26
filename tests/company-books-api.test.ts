// A company's books through the app (routes/company-books.ts; DATA_FORMAT.md, companies.json `books`):
// the owner keeps them and records filings, an agent only proposes them, and nothing of them reaches a
// personal route. Every company, date, reference and figure is invented.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert, CompanyBooksListItem, CompanyBooksResponse, CompanyView, ProposalDecision, ProposalView } from '../src/shared/api';
import { addDays, addMonths, today } from '../src/shared/dates';
import type { CompanyBooksSetup, ProposalInput } from '../src/shared/schema';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { requiredScope } from '../src/server/tokens';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';
const COMPANY = 'example-forge';

/** Books for a company incorporated 2 years and a few days ago, its year to 31 December. */
const SETUP = (): CompanyBooksSetup => ({
  incorporatedOn: addDays(addMonths(today(), -24), -3),
  accountingReferenceDate: '12-31',
  periods: [],
  ctPeriods: [],
  vat: { registeredFrom: addMonths(today(), -18).slice(0, 8) + '01', scheme: 'cash', schedule: [{ from: addMonths(today(), -18).slice(0, 8) + '01', stagger: 'quarterly-2' }] },
});

describe('a company’s books through the app', () => {
  let app: App;
  let dir: string;
  let agent: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-books-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false, pauseJobs: true });
    await app.ctx.store.setCompanies([{ id: COMPANY, name: 'Example Forge Ltd', number: '24681357', holdings: [], valuations: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const json = async <T>(p: string) => (await (await req(p)).json()) as T;
  const put = (body: unknown, auth?: string) => req(`/api/companies/${COMPANY}/books`, { method: 'PUT', headers: { ...CSRF, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  const file = (body: unknown, auth?: string) => req(`/api/companies/${COMPANY}/filings`, { method: 'POST', headers: { ...CSRF, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  const propose = async (p: ProposalInput) => {
    const r = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(p) });
    return { status: r.status, body: (await r.json()) as ProposalView & { problems?: { problem: string }[] } };
  };

  it('the owner keeps its books, records and removes filings; its deadlines follow', async () => {
    const none = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    expect(none).toMatchObject({ books: null, deadlines: [], accountingReferenceDate: null });
    expect(await json<CompanyBooksListItem[]>('/api/company-books')).toEqual([]);

    expect((await put({ books: SETUP(), was: null })).status).toBe(200);
    const view = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    expect(view.books).toMatchObject({ setBy: 'owner', accountingReferenceDate: '12-31', filings: [] });
    expect(view.accountingReferenceDate).toEqual({ value: '12-31', isDefault: false });
    expect(view.deadlines.length).toBeGreaterThan(5);
    expect(view.problems).toEqual([]);
    const accounts = view.deadlines.find((d) => d.kind === 'accounts' && d.status !== 'done')!;
    const list = await json<CompanyBooksListItem[]>('/api/company-books');
    expect(list).toMatchObject([{ id: COMPANY, name: 'Example Forge Ltd' }]);
    expect(list[0]!.overdue).toBe(view.deadlines.filter((d) => d.status === 'overdue').length);

    // Filing the first accounts does that deadline.
    const res = await file({ kind: 'accounts', periodStart: accounts.period.start, periodEnd: accounts.period.end, filedOn: addDays(accounts.period.end, 40), figures: { B: 1234, C: 5678, K: 6912 } });
    expect(res.status).toBe(201);
    const recorded = (await res.json()) as { id: string };
    expect(recorded.id).toMatch(/^fil_[0-9a-f]{12}$/);
    const after = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    expect(after.deadlines.find((d) => d.id === accounts.id)).toMatchObject({ status: 'done', filing: { id: recorded.id } });

    // The same filing again is refused, as is one filed in the future or before its period ends.
    expect((await file({ kind: 'accounts', periodEnd: accounts.period.end, filedOn: addDays(accounts.period.end, 41) })).status).toBe(409);
    expect((await file({ kind: 'confirmation', periodEnd: addDays(today(), -10), filedOn: addDays(today(), 1) })).status).toBe(422);
    expect((await file({ kind: 'vat', periodStart: '2025-02-01', periodEnd: '2025-04-30', filedOn: '2025-04-29' })).status).toBe(422);
    // VAT boxes that do not add up are refused.
    const boxes = { vatDueSales: 1975.2, vatDueAcquisitions: 0, totalVatDue: 1975.2, vatReclaimedCurrPeriod: 431.85, netVatDue: 1543.35, totalValueSalesExVAT: 9876, totalValuePurchasesExVAT: 2159, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 };
    const vat = after.deadlines.find((d) => d.kind === 'vat')!;
    expect((await file({ kind: 'vat', periodStart: vat.period.start, periodEnd: vat.period.end, filedOn: addDays(vat.period.end, 20), figures: { ...boxes, netVatDue: 1543.36 } })).status).toBe(422);
    expect((await file({ kind: 'vat', periodStart: vat.period.start, periodEnd: vat.period.end, filedOn: addDays(vat.period.end, 20), figures: boxes, reference: '135792468' })).status).toBe(201);

    // Removing one opens its deadline again.
    expect((await req(`/api/companies/${COMPANY}/filings/${recorded.id}`, { method: 'DELETE', headers: CSRF })).status).toBe(200);
    expect((await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`)).deadlines.find((d) => d.id === accounts.id)!.status).not.toBe('done');

    // Changing the books keeps the filings; a stale `was` is refused.
    const now = (await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`)).books!;
    expect((await put({ books: { ...SETUP(), paye: { from: SETUP().incorporatedOn } }, was: now.updatedAt })).status).toBe(200);
    expect(app.ctx.store.company(COMPANY)!.books!.filings).toHaveLength(1);
    expect((await put({ books: SETUP(), was: now.updatedAt })).status).toBe(409);
    // A period over 18 months is refused (CA 2006 s392(5)), and accrual VAT is not supported yet.
    expect((await put({ books: { ...SETUP(), periods: [{ start: '2025-01-01', end: '2026-07-31' }] } })).status).toBe(422);
    const accrual = await put({ books: { ...SETUP(), vat: { ...SETUP().vat!, scheme: 'accrual' } } });
    expect(accrual.status).toBe(400);
    expect(((await accrual.json()) as { error: string }).error).toContain('not supported yet');
  });

  it('agent tokens cannot write the books or filings: no scope opens those routes', async () => {
    for (const [method, p] of [
      ['PUT', `/api/companies/${COMPANY}/books`],
      ['POST', `/api/companies/${COMPANY}/filings`],
      ['DELETE', `/api/companies/${COMPANY}/filings/fil_000000000000`],
    ] as const)
      expect(requiredScope(method, p)).toBeNull();
    expect((await put({ books: SETUP() }, agent)).status).toBe(403);
    await put({ books: SETUP() });
    expect((await file({ kind: 'confirmation', periodEnd: addDays(today(), -30), filedOn: addDays(today(), -29) }, agent)).status).toBe(403);
    // Reading is any GET.
    expect(requiredScope('GET', `/api/companies/${COMPANY}/books`)).toBe('read');
  });

  it('an agent proposes the books and filings; applied, they are the agent’s, and never over yours', async () => {
    const setup = SETUP();
    const first = await propose({ title: 'Keep Example Forge Ltd’s books', summary: 'From its certificate of incorporation and VAT certificate.', changes: [{ kind: 'set_company_books', why: 'Its certificate of incorporation and VAT registration certificate.', company: COMPANY, books: setup, was: null }] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ready: 1, problems: 0 });
    expect(first.body.changes[0]!.books!.what).toContain('Keeps Example Forge Ltd’s books here');
    const applied = (await (await req(`/api/proposals/${first.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' })).json()) as ProposalDecision;
    expect(applied.proposal.status).toBe('applied');
    const books = app.ctx.store.company(COMPANY)!.books!;
    expect(books).toMatchObject({ setBy: 'agent', incorporatedOn: setup.incorporatedOn });

    // A filing: proposed, applied; the same again is done already; another for that period does not fit.
    const confirmation = { kind: 'confirmation' as const, periodEnd: addDays(setup.incorporatedOn, 364), filedOn: addDays(setup.incorporatedOn, 370), reference: 'CS01-2468' };
    const f = await propose({ title: 'A confirmation statement', summary: 'Its Companies House filing history.', changes: [{ kind: 'add_filing', why: 'Its filing history lists it.', company: COMPANY, filing: confirmation }] });
    expect(f.body).toMatchObject({ ready: 1 });
    await req(`/api/proposals/${f.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    expect(app.ctx.store.company(COMPANY)!.books!.filings).toMatchObject([{ kind: 'confirmation', addedBy: 'agent', reference: 'CS01-2468' }]);
    expect((await propose({ title: 'Again', summary: 'Again.', changes: [{ kind: 'add_filing', why: 'Again.', company: COMPANY, filing: confirmation }] })).body.problems[0]!.problem).toBe('Your data already says this: leave the change out.');
    expect((await propose({ title: 'Other', summary: 'Other.', changes: [{ kind: 'add_filing', why: 'Other.', company: COMPANY, filing: { ...confirmation, filedOn: addDays(confirmation.filedOn, 1) } }] })).body.problems[0]!.problem).toContain('is recorded already');

    // A change proposed against books changed since does not fit.
    expect((await propose({ title: 'Stale', summary: 'Stale.', changes: [{ kind: 'set_company_books', why: 'Stale.', company: COMPANY, books: { ...setup, tradeStartedOn: setup.incorporatedOn }, was: null }] })).body.problems[0]!.problem).toContain('after this was proposed');
    const fresh = await propose({ title: 'Trade', summary: 'Trade.', changes: [{ kind: 'set_company_books', why: 'Its first invoice.', company: COMPANY, books: { ...setup, tradeStartedOn: setup.incorporatedOn }, was: app.ctx.store.company(COMPANY)!.books!.updatedAt }] });
    expect(fresh.body).toMatchObject({ ready: 1 });

    // Once you change the books yourself, no proposal replaces them; that one no longer fits.
    await put({ books: setup });
    const check = (await (await req(`/api/proposals/${fresh.body.proposal.id}`)).json()) as ProposalView;
    expect(check.changes[0]!.problem).toContain('You set up Example Forge Ltd’s books yourself');
    // An applied proposal keeps the company as it was: the audit trail.
    expect((await app.ctx.store.readProposal(f.body.proposal.id))!.before!.companies).toMatchObject([{ id: COMPANY, books: { setBy: 'agent', filings: [] } }]);
    expect((await app.ctx.store.readProposal(first.body.proposal.id))!.before!.companies).toMatchObject([{ id: COMPANY }]);
    expect((await app.ctx.store.readProposal(first.body.proposal.id))!.before!.companies![0]).not.toHaveProperty('books');
  });

  it('a filing recorded while a proposal applies is kept; books changed meanwhile stop the apply', async () => {
    await put({ books: SETUP() });
    const { store } = app.ctx;
    const inc = SETUP().incorporatedOn;
    const theirs = { kind: 'confirmation' as const, periodEnd: addDays(inc, 364), filedOn: addDays(inc, 366) };
    const p = await propose({ title: 'A filing', summary: 'Its filing history.', changes: [{ kind: 'add_category', why: 'For its costs.', category: { id: 'example-forge-costs', name: 'Example Forge costs', kind: 'expense' } }, { kind: 'add_filing', why: 'Its filing history.', company: COMPANY, filing: theirs }] });
    expect(p.body).toMatchObject({ ready: 2 });
    // While the apply writes the category, the owner records a Corporation Tax payment.
    const setCategories = store.setCategories.bind(store);
    const spy = vi.spyOn(store, 'setCategories').mockImplementationOnce(async (list, message) => {
      const res = file({ kind: 'ct-payment', periodEnd: addDays(inc, 200), filedOn: addDays(inc, 500) });
      await setCategories(list, message);
      expect((await res).status).toBe(201);
    });
    const applied = await req(`/api/proposals/${p.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    spy.mockRestore();
    expect(applied.status).toBe(200);
    expect(store.company(COMPANY)!.books!.filings.map((f) => f.kind).sort()).toEqual(['confirmation', 'ct-payment']);
  });

  it('books an agent set, changed by the owner while a proposal applies: refused, not overwritten', async () => {
    const { store } = app.ctx;
    const first = await propose({ title: 'Books', summary: 'Its certificate.', changes: [{ kind: 'set_company_books', why: 'Its certificate.', company: COMPANY, books: SETUP(), was: null }] });
    await req(`/api/proposals/${first.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    expect(store.company(COMPANY)!.books!.setBy).toBe('agent');
    const inc = SETUP().incorporatedOn;
    const next = await propose({ title: 'Trade', summary: 'Its first invoice.', changes: [{ kind: 'add_category', why: 'For its sales.', category: { id: 'example-forge-sales', name: 'Example Forge sales', kind: 'income' } }, { kind: 'set_company_books', why: 'Its first invoice.', company: COMPANY, books: { ...SETUP(), tradeStartedOn: inc }, was: store.company(COMPANY)!.books!.updatedAt }] });
    expect(next.body).toMatchObject({ ready: 2 });
    const setCategories = store.setCategories.bind(store);
    const spy = vi.spyOn(store, 'setCategories').mockImplementationOnce(async (list, message) => {
      const res = put({ books: { ...SETUP(), paye: { from: inc } } });
      await setCategories(list, message);
      expect((await res).status).toBe(200);
    });
    const res = await req(`/api/proposals/${next.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('changed while this was being applied');
    expect(store.company(COMPANY)!.books).toMatchObject({ setBy: 'owner', paye: { from: inc } });
    expect(store.company(COMPANY)!.books!.tradeStartedOn).toBeUndefined();
  });

  it('a hand edit that left two problems can be put right one at a time; a change that adds one is refused', async () => {
    const { store } = app.ctx;
    const file0 = path.join(dir, 'data', 'companies.json');
    const data = JSON.parse(await readFile(file0, 'utf8')) as { companies: Record<string, unknown>[] };
    data.companies[0]!.books = { ...SETUP(), periods: [{ start: '2025-01-01', end: '2026-12-31' }], ctPeriods: [{ start: '2025-01-01', end: '2026-01-31' }], filings: [], setBy: 'owner', updatedAt: stamp };
    await writeFile(file0, JSON.stringify(data));
    await store.load();
    expect((await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`)).problems).toHaveLength(2);
    // Recording a filing beside them, and fixing one of them, both go through.
    const inc = SETUP().incorporatedOn;
    expect((await file({ kind: 'confirmation', periodEnd: addDays(inc, 364), filedOn: addDays(inc, 366) })).status).toBe(201);
    expect((await put({ books: { ...SETUP(), ctPeriods: [{ start: '2025-01-01', end: '2026-01-31' }] } })).status).toBe(200);
    expect((await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`)).problems).toHaveLength(1);
    // One that adds a problem does not.
    expect((await put({ books: { ...SETUP(), ctPeriods: [{ start: '2025-01-01', end: '2026-01-31' }], tradeStartedOn: '2001-01-01' } })).status).toBe(422);
  });

  it('a page’s save for another company is refused; the response says when it came within the charge, and whether that is assumed', async () => {
    await put({ books: SETUP() });
    expect((await put({ books: SETUP(), company: 'example-other' })).status).toBe(409);
    expect((await put({ books: SETUP(), company: COMPANY })).status).toBe(200);
    expect((await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`)).withinCharge).toEqual({ from: SETUP().incorporatedOn, assumed: true });
    await put({ books: { ...SETUP(), withinChargeFrom: null } });
    const dormant = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    expect(dormant.withinCharge).toEqual({ from: null, assumed: false });
    expect(dormant.deadlines.filter((d) => d.kind === 'ct600' || d.kind === 'ct-payment')).toEqual([]);
  });

  it('nothing to pay for a CT period: recorded by the owner or proposed by an agent, the payment is done', async () => {
    await put({ books: SETUP() });
    const view = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    const [first, second] = view.deadlines.filter((d) => d.kind === 'ct-payment' && d.period.end < today());
    expect((await file({ kind: 'ct-payment', periodStart: first!.period.start, periodEnd: first!.period.end, filedOn: today(), figures: { amount: 0 } })).status).toBe(201);
    const p = await propose({ title: 'No tax', summary: 'Its CT600 workings.', changes: [{ kind: 'add_filing', why: 'Its computations show no profit.', company: COMPANY, filing: { kind: 'ct-payment', periodStart: second!.period.start, periodEnd: second!.period.end, filedOn: today(), figures: { amount: 0 } } }] });
    expect(p.body.changes[0]!.books!.what).toContain('No Corporation Tax to pay');
    await req(`/api/proposals/${p.body.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    const after = await json<CompanyBooksResponse>(`/api/companies/${COMPANY}/books`);
    for (const d of [first!, second!]) {
      const x = after.deadlines.find((y) => y.id === d.id)!;
      expect(x).toMatchObject({ status: 'done', nothingToPay: true });
      expect(x.filedLate).toBeUndefined();
    }
    expect((await json<{ alerts: Alert[] }>('/api/company-alerts')).alerts.some((a) => a.id.includes(first!.id) || a.id.includes(second!.id))).toBe(false);
  });

  it('a filing proposed for a company whose books are not kept here, or for one not in your data, does not fit', async () => {
    const filing = { kind: 'confirmation' as const, periodEnd: '2025-05-01', filedOn: '2025-05-02' };
    expect((await propose({ title: 'x', summary: 'x', changes: [{ kind: 'add_filing', why: 'x', company: COMPANY, filing }] })).body.problems[0]!.problem).toContain('books are not kept here');
    expect((await propose({ title: 'x', summary: 'x', changes: [{ kind: 'add_filing', why: 'x', company: 'example-none', filing }] })).body.problems[0]!.problem).toContain('There is no company');
  });

  it('nothing of the books reaches a personal route; company alerts come from their own', async () => {
    await put({ books: SETUP() });
    const companies = await json<CompanyView[]>('/api/companies');
    expect(companies[0]!.company).not.toHaveProperty('books');
    expect(JSON.stringify(await json('/api/summary'))).not.toContain('Example Forge Ltd:');
    const { alerts } = await json<{ alerts: Alert[] }>('/api/company-alerts');
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.title.startsWith('Example Forge Ltd: ')).toBe(true);
      expect(a.action?.href).toBe(`/company/${COMPANY}`);
    }
  });
});
