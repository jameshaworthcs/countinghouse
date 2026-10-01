// Pension arrangements (FORMULAS.md §11, "Pension arrangements"): what an employer's form set up to
// pay into a pension of yours, added by a proposal the owner applies, and checked against what
// arrived. Every figure is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProposalView } from '../src/shared/api';
import type { ProposalInput, Transaction } from '../src/shared/schema';
import { arrangementsInto } from '../src/server/analytics/arrangements';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { transactionId } from '../src/server/ids';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';

describe('what an employer pays into your pension', () => {
  let app: App;
  let dir: string;
  let agent: string;
  const credit = (date: string, amount: number, description: string): Transaction => ({ id: transactionId('sipp', date, amount, description, 0), accountId: 'sipp', date, amount, currency: 'GBP', description, category: 'employer-contribution', source: {} });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-arrangements-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.setAccounts([{ id: 'sipp', name: 'Example SIPP', type: 'sipp', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    await store.setEmployments([{ id: 'quillon', employer: 'QUILLON SYSTEMS LTD', aliases: [], payrollNumbers: [], owed: [], pensionArrangements: [], createdBy: 'owner', createdAt: stamp, updatedAt: stamp }]);
    const monthly = ['2025-01-02', '2025-02-03', '2025-03-03', '2025-04-01', '2025-05-01', '2025-06-02', '2025-07-01'].map((d) => credit(d, 250, 'Reg Contribution (E)'));
    await store.addTransactions([credit('2024-12-24', 1250, 'Employer Bank Credit Contribution'), ...monthly, credit('2026-09-01', 360, 'Reg Contribution (E)'), credit('2026-09-02', 4500, 'Employer Bank Credit Contribution')], 'test: contributions');
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });

  it('an agent proposes the form’s contributions; applied, the pension’s page checks them against what arrived', async () => {
    const proposal: ProposalInput = {
      title: 'What Quillon pays into your SIPP',
      summary: 'Its contribution form of 14 November 2024.',
      provenance: { model: 'test-model' },
      changes: [
        { key: 'single', kind: 'add_pension_arrangement', why: 'The form asks for a single gross employer contribution of £1,250.', employmentId: 'quillon', arrangement: { accountId: 'sipp', kind: 'single', amount: 1250, from: '2024-11-14', source: {} } },
        { key: 'monthly', kind: 'add_pension_arrangement', why: 'The form asks for a monthly gross employer contribution of £250 by Direct Debit.', employmentId: 'quillon', arrangement: { accountId: 'sipp', kind: 'monthly', amount: 250, from: '2024-11-14', source: {} } },
      ],
    };
    const view = (await (await req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(proposal) })).json()) as ProposalView;
    expect(view).toMatchObject({ ready: 2, problems: 0 });
    expect((await req(`/api/proposals/${view.proposal.id}/apply`, { method: 'POST', headers: CSRF, body: '{}' })).status).toBe(200);
    expect(app.ctx.store.employment('quillon')!.pensionArrangements).toHaveLength(2);

    const r = arrangementsInto(app.ctx.store, 'sipp', '2026-10-01');
    expect(r.arrangements[0]).toMatchObject({ arrangement: { kind: 'single' }, arrived: { date: '2024-12-24' } });
    const monthly = r.arrangements[1]!;
    expect(monthly.collected!.map((c) => c.date)).toEqual(['2025-01-02', '2025-02-03', '2025-03-03', '2025-04-01', '2025-05-01', '2025-06-02', '2025-07-01']);
    // None since July 2025, to the month before this one; September's £360 is not this arrangement's.
    expect(monthly.missing).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(r.others.map((o) => [o.date, o.amount])).toEqual([
      ['2026-09-01', 360],
      ['2026-09-02', 4500],
    ]);
    // On the route as well.
    expect((await req('/api/accounts/sipp/arrangements')).status).toBe(200);
  });

  it('will not add one to an account that is not a pension you pay into', async () => {
    await app.ctx.store.setAccounts([...app.ctx.store.accounts, { id: 'current', name: 'Current', type: 'current', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
    const res = await req('/api/proposals', {
      method: 'POST',
      headers: { ...CSRF, authorization: agent },
      body: JSON.stringify({ title: 'x', summary: 'x', provenance: { model: 'test-model' }, changes: [{ key: 'c', kind: 'add_pension_arrangement', why: 'x', employmentId: 'quillon', arrangement: { accountId: 'current', kind: 'monthly', amount: 50, from: '2026-01-01' } }] }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/is not a pension you pay into/);
  });
});
