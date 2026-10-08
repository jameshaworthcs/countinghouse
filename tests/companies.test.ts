// Shares you hold in a company (companies.json; FORMULAS.md §9, "Shares in a company"): added by a
// proposal the owner applies, counted in the estate at its book value, with the dividends it paid.
// Every figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyView, ProposalDecision, ProposalView } from '../src/shared/api';
import type { ProposalInput } from '../src/shared/schema';
import { BalanceEngine } from '../src/server/analytics/balances';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { figureId, transactionId } from '../src/server/ids';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';

describe('shares you hold in a company', () => {
  let app: App;
  let dir: string;
  let agent: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-companies-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.setAccounts([{ id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.setEmployments([{ id: 'quillon', employer: 'QUILLON SYSTEMS LTD', aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    // A dividend voucher and the credit that paid it; and a dividend credit with no voucher.
    await store.addFigures([{ id: figureId('dividends_paid', 1200, '2025/26', 'QUILLON SYSTEMS LTD', 'Dividend', 'v1'), kind: 'dividends_paid', label: 'Dividend', amount: 1200, currency: 'GBP', taxYear: '2025/26', periodEnd: '2025-09-19', payer: 'QUILLON SYSTEMS LTD', source: {}, createdAt: stamp }], 'test: voucher');
    await store.addTransactions(
      [
        { id: transactionId('current', '2025-09-19', 1200, 'QUILLON SYSTEMS LTD DIVIDEND', 0), accountId: 'current', date: '2025-09-19', amount: 1200, currency: 'GBP', description: 'QUILLON SYSTEMS LTD DIVIDEND', category: 'dividends', source: {} },
        { id: transactionId('current', '2026-04-17', 750, 'QUILLON SYSTEMS LTD DIV', 0), accountId: 'current', date: '2026-04-17', amount: 750, currency: 'GBP', description: 'QUILLON SYSTEMS LTD DIV', category: 'dividends', source: {} },
      ],
      'test: credits',
    );
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const proposal = (holdingShares = 4): ProposalInput => ({
    title: 'Your shares in Quillon Systems Ltd',
    summary: 'The share certificate and the company’s accounts.',
    provenance: { model: 'test-model' },
    changes: [
      {
        key: 'quillon',
        kind: 'add_company',
        why: 'Certificate 12 says 4 A ordinary shares; its accounts to 31 Dec 2025 give net assets of £158,730 and 120 shares in issue.',
        company: { id: 'quillon-systems', name: 'QUILLON SYSTEMS LTD', number: '12345678', holdings: [{ shareClass: 'A ordinary', shares: holdingShares, totalShares: 120, certificate: '12', acquiredOn: '2025-05-14', source: {} }], employmentId: 'quillon' },
        valuation: { asOf: '2025-12-31', method: 'net-assets', netAssets: 158730, value: 5291, note: 'Book value: net assets £158,730 × 4 of its 120 shares, from its accounts to 31 Dec 2025.', source: {} },
        account: { id: 'quillon-shares', name: 'Quillon Systems Ltd shares' },
      },
    ],
  });
  const propose = async (p: ProposalInput) => (await (await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(p) })).json()) as ProposalView;

  it('an agent proposes them; applied, they are a company, an account in your estate, and its valuation', async () => {
    const view = await propose(proposal());
    expect(view).toMatchObject({ ready: 1, problems: 0 });
    const res = await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProposalDecision).proposal.status).toBe('applied');
    const { store } = app.ctx;
    expect(store.company('quillon-systems')).toMatchObject({ name: 'QUILLON SYSTEMS LTD', accountId: 'quillon-shares', employmentId: 'quillon', createdBy: 'agent', valuations: [{ asOf: '2025-12-31', value: 5291 }] });
    expect(store.account('quillon-shares')).toMatchObject({ type: 'other_asset', includeInNetWorth: true });
    const [balance] = store.balances('quillon-shares');
    expect(balance).toMatchObject({ date: '2025-12-31', balance: 5291, kind: 'manual', note: 'Book value: net assets £158,730 × 4 of its 120 shares, from its accounts to 31 Dec 2025.' });
    expect(balance!.approximate).toBeUndefined();
    expect(store.company('quillon-systems')!.valuations[0]!.balanceId).toBe(balance!.id);
    // It counts in the estate, at that value until a newer one.
    expect(new BalanceEngine(store).balanceOn('quillon-shares', '2026-10-01')).toMatchObject({ value: 5291, gbp: 5291 });

    // Its page: the holding, the valuation, and its dividends with what paid them.
    const [company] = (await (await req('/api/companies')).json()) as CompanyView[];
    expect(company).toMatchObject({ value: { amount: 5291, date: '2025-12-31', approximate: false }, valuation: { method: 'net-assets', netAssets: 158730 }, dividendsTotal: 1950 });
    expect(company!.dividends.map((d) => [d.date, d.amount, Boolean(d.figureId), d.paidIn?.date ?? null])).toEqual([
      ['2025-09-19', 1200, true, '2025-09-19'],
      ['2026-04-17', 750, false, '2026-04-17'],
    ]);

    // The same proposal again is done already; one with another holding for it does not fit.
    const send = async (p: ProposalInput) => {
      const r = await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(p) });
      return { status: r.status, body: (await r.json()) as { problems?: { problem: string }[] } };
    };
    expect(await send(proposal())).toMatchObject({ status: 422, body: { problems: [{ problem: 'Your data already says this: leave the change out.' }] } });
    expect((await send(proposal(5))).body.problems![0]!.problem).toMatch(/is in your data already, with another holding/);
  });

  it('you change a company yourself', async () => {
    const view = await propose(proposal());
    await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' });
    const res = await req('/api/companies/quillon-systems', { method: 'PUT', headers: CSRF, body: JSON.stringify({ notes: 'Founder shares' }) });
    expect(res.status).toBe(200);
    expect(app.ctx.store.company('quillon-systems')).toMatchObject({ notes: 'Founder shares' });
    // An agent's token cannot.
    expect((await req('/api/companies/quillon-systems', { method: 'PUT', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ notes: 'x' }) })).status).toBe(403);
  });
});
