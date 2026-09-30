// Proposed fixes (src/server/proposals.ts): an agent proposes with its token, the owner applies or
// dismisses; every proposal is checked against the data when it is made, shown and applied. All data
// here is invented.

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProposalCheckResponse, ProposalListResponse, ProposalView } from '../src/shared/api';
import type { Account, Transaction } from '../src/shared/schema';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { transactionId, transferGroupId } from '../src/server/ids';
import { ProposalService } from '../src/server/proposals';

const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
const stamp = '2026-01-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: id, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: transactionId(accountId, date, amount, description, 0),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  createdAt: stamp,
  ...extra,
});

// October: £1,000 from the bank to the saver, £1,000 from the easy-access account to the bank, and a
// £1,000 card payment to a platform. The saver's £1,000 was linked to the platform payment: wrong.
const toSaver = tx('bank', '2026-03-03', -1000, 'BILL PAYMENT TO A N OTHER REFERENCE SAVING');
const platform = tx('bank', '2026-03-03', -1000, 'EXAMPLE PLATFORM (VIA APPLE PAY)');
const saverIn = tx('saver', '2026-03-02', 1000, 'From A N OTHER - SAVING');
const easyOut = tx('easy', '2026-03-02', -1000, 'To 12-34-56 00012345678');
const bankIn = tx('bank', '2026-03-02', 1000, 'FASTER PAYMENTS RECEIPT FROM EXAMPLE BANK');
const wrongLink = transferGroupId(platform.id, saverIn.id);
// A deposit of £400 and £10,100.50, and the letter that confirmed it as one £10,500.50.
const letter = tx('fixed', '2024-02-01', 10500.5, 'Confirmation of deposit to your savings account');
const part1 = tx('fixed', '2024-02-02', 400, 'Faster Payment Posted: 01/02/2024');
const part2 = tx('fixed', '2024-02-02', 10100.5, 'Faster Payment');

let app: App;
let dir: string;
let agent: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'finance-proposals-'));
  const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
  config.webDist = path.join(dir, 'no-web');
  app = await createApp(config, { version: 'test', env: {}, inbox: false });
  const { store } = app.ctx;
  await store.setAccounts([acct('bank', 'current'), acct('saver', 'savings'), acct('easy', 'savings'), acct('fixed', 'savings', { openedOn: '2024-02-01', status: 'closed', closedOn: '2026-02-03' })]);
  await store.addTransactions(
    [
      toSaver,
      { ...platform, category: 'savings-transfer', categorisedBy: 'transfer', transferGroup: wrongLink, counterpartyAccountId: 'saver' },
      { ...saverIn, category: 'savings-transfer', categorisedBy: 'transfer', transferGroup: wrongLink, counterpartyAccountId: 'bank' },
      { ...easyOut, category: 'transfer', categorisedBy: 'transfer' },
      bankIn,
      letter,
      part1,
      part2,
    ],
    'test',
  );
  agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records'], days: 1 })).token}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
const propose = (body: unknown, authorization = agent) => req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization }, body: JSON.stringify(body) });
const owner = (p: string, body: unknown = {}) => req(p, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
const relink = {
  title: 'Re-link the October transfers',
  summary: 'The saver’s £1,000 came from the bank’s SAVING payment, not the platform card payment.',
  provenance: { model: 'test-model' },
  changes: [
    { key: 'unlink', kind: 'unlink_transfer', transaction: saverIn.id, why: 'The card payment names a platform, not the saver.' },
    { key: 'saver', kind: 'link_transfer', from: toSaver.id, to: saverIn.id, why: 'Both name the owner and SAVING; the same £1,000 a day apart.' },
    { key: 'easy', kind: 'link_transfer', from: easyOut.id, to: bankIn.id, why: 'The easy-access row names the bank’s account number.' },
  ],
};

describe('an agent proposes, the owner decides', () => {
  it('shows the rows each change is about, and applies what the owner keeps', async () => {
    const res = await propose(relink);
    expect(res.status).toBe(201);
    const view = (await res.json()) as ProposalView;
    expect(view.proposal).toMatchObject({ status: 'pending', provenance: { setBy: 'agent', model: 'test-model', session: 'Test agent' } });
    expect(view).toMatchObject({ ready: 3, problems: 0 });
    // How each link leaves its rows.
    expect(view.changes.find((c) => c.change.key === 'easy')!.after).toEqual({ [easyOut.id]: { category: 'transfer', transferWith: 'bank' }, [bankIn.id]: { category: 'savings-transfer', transferWith: 'easy' } });
    // The unlinked row's partner is shown in full, with where each row came from.
    expect(view.rows[saverIn.id]!.partner?.id).toBe(platform.id);
    expect(view.rows[platform.id]).toMatchObject({ accountId: 'bank', amount: -1000 });
    expect(view.accounts.saver!.name).toBe('saver');

    const list = (await (await req('/api/proposals')).json()) as ProposalListResponse;
    expect(list.pending.map((v) => v.proposal.id)).toEqual([view.proposal.id]);

    // Left out, the unlink leaves the saver's row linked, so its new link no longer fits.
    const check = (await (await owner(`/api/proposals/${view.proposal.id}/check`, { leaveOut: ['unlink'] })).json()) as ProposalCheckResponse;
    expect(check.changes.find((c) => c.key === 'saver')!.problem).toMatch(/is linked with .*: include change 1, which undoes that link/);
    expect(check).toMatchObject({ ready: 1, problems: 1 });
    expect((await owner(`/api/proposals/${view.proposal.id}/apply`, { leaveOut: ['unlink'] })).status).toBe(409);

    // A token can neither apply nor dismiss.
    for (const action of ['apply', 'dismiss']) expect((await req(`/api/proposals/${view.proposal.id}/${action}`, { method: 'POST', headers: { ...CSRF, authorization: agent }, body: '{}' })).status).toBe(403);

    const applied = await owner(`/api/proposals/${view.proposal.id}/apply`, { leaveOut: ['easy'] });
    expect(applied.status).toBe(200);
    const { store } = app.ctx;
    const s = store.transaction(saverIn.id)!;
    const p = store.transaction(platform.id)!;
    expect(s.transferGroup).toBe(transferGroupId(toSaver.id, saverIn.id));
    expect(store.transaction(toSaver.id)).toMatchObject({ transferGroup: s.transferGroup, counterpartyAccountId: 'saver', category: 'savings-transfer', categorisedBy: 'transfer' });
    expect(p.transferGroup).toBeUndefined();
    expect(p.counterpartyAccountId).toBeUndefined();
    // Left out: untouched.
    expect(store.transaction(easyOut.id)!.transferGroup).toBeUndefined();

    // Kept in the data, with what it changed as it was before.
    const kept = (await (await req(`/api/proposals/${view.proposal.id}`)).json()) as ProposalView;
    expect(kept.proposal).toMatchObject({ status: 'applied', applied: ['unlink', 'saver'] });
    const file = JSON.parse(await readFile(path.join(dir, 'data', store.proposals[0]!.path), 'utf8')) as { before: { transactions: Transaction[] } };
    expect(file.before.transactions.find((x) => x.id === platform.id)!.transferGroup).toBe(wrongLink);
    // The page shows the rows as they were: the saver's row still with its old partner.
    expect(kept.rows[saverIn.id]!.partner?.id).toBe(platform.id);
    expect(((await (await req('/api/proposals')).json()) as ProposalListResponse).pending).toEqual([]);
  });

  it('removes a duplicate whose rows add up to it, and sets an account’s dates', async () => {
    const res = await propose({
      title: 'The fixed-rate account',
      summary: 'A letter restated the deposit; the account’s money moved on 2 Feb 2026.',
      changes: [
        { kind: 'remove_duplicate', transaction: letter.id, sameAs: [part1.id, part2.id], why: 'The letter confirms the two Faster Payments as one deposit.' },
        { kind: 'set_account_dates', account: 'fixed', closedOn: '2026-02-01', why: 'It matured on 2 Feb 2026, when its money moved.' },
      ],
    });
    expect(res.status).toBe(201);
    const { proposal } = (await res.json()) as ProposalView;
    expect(proposal.changes.map((c) => c.key)).toEqual(['c1', 'c2']);
    expect((await owner(`/api/proposals/${proposal.id}/apply`)).status).toBe(200);
    const { store } = app.ctx;
    expect(store.transaction(letter.id)).toBeUndefined();
    expect(store.transaction(part1.id)).toBeDefined();
    expect(store.account('fixed')).toMatchObject({ status: 'closed', closedOn: '2026-02-01', openedOn: '2024-02-01' });
  });

  it('dismissed, it is kept with the reason, and the same proposal is refused after', async () => {
    const { proposal } = (await (await propose(relink)).json()) as ProposalView;
    // The same again while it waits.
    expect((await propose(relink)).status).toBe(409);
    const res = await owner(`/api/proposals/${proposal.id}/dismiss`, { reason: 'That £1,000 was the platform.' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProposalView).proposal).toMatchObject({ status: 'dismissed', dismissedReason: 'That £1,000 was the platform.' });
    expect(app.ctx.store.transaction(saverIn.id)!.transferGroup).toBe(wrongLink);
    const again = await propose(relink);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/dismissed the same proposal .*That £1,000 was the platform/);
  });

  it('an agent withdraws its own proposal; the owner dismisses instead', async () => {
    const { proposal } = (await (await propose(relink)).json()) as ProposalView;
    expect((await req(`/api/proposals/${proposal.id}`, { method: 'DELETE', headers: CSRF })).status).toBe(405);
    expect((await req(`/api/proposals/${proposal.id}`, { method: 'DELETE', headers: { ...CSRF, authorization: agent } })).status).toBe(200);
    expect(app.ctx.proposals.pendingCount).toBe(0);
    expect(app.ctx.store.proposals).toEqual([]);
  });

  it('waits across restarts in the work area, not in the data', async () => {
    const { proposal } = (await (await propose(relink)).json()) as ProposalView;
    const fresh = ProposalService.forWorkDir(app.ctx.store, path.join(dir, 'work'));
    await fresh.init();
    expect(fresh.pendingCount).toBe(1);
    expect(app.ctx.store.proposals).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, 'work', 'proposals', `${proposal.id}.json`), 'utf8'))).toMatchObject({ id: proposal.id, status: 'pending' });
  });
});

describe('a proposal must fit the data', () => {
  const one = (change: Record<string, unknown>) => propose({ title: 'One change', summary: 'A test.', changes: [{ why: 'A test.', ...change }] });
  const problem = async (change: Record<string, unknown>) => {
    const res = await one(change);
    expect(res.status).toBe(422);
    return ((await res.json()) as { problems: { problem: string }[] }).problems[0]!.problem;
  };

  it('refuses a change that does not', async () => {
    expect(await problem({ kind: 'link_transfer', from: toSaver.id, to: bankIn.id })).toMatch(/Both are in bank/);
    expect(await problem({ kind: 'link_transfer', from: bankIn.id, to: saverIn.id })).toMatch(/is money in/);
    expect(await problem({ kind: 'link_transfer', from: toSaver.id, to: saverIn.id })).toMatch(/is linked with .*: undo that link first/);
    expect(await problem({ kind: 'link_transfer', from: toSaver.id, to: 'tx_0000000000000000' })).toMatch(/no longer in your data/);
    expect(await problem({ kind: 'remove_duplicate', transaction: letter.id, sameAs: [part1.id] })).toMatch(/add up to £400.00, not £10,500.50/);
    expect(await problem({ kind: 'remove_duplicate', transaction: letter.id, sameAs: [toSaver.id] })).toMatch(/another account/);
    expect(await problem({ kind: 'set_account_dates', account: 'fixed', closedOn: '2020-01-01' })).toMatch(/close .* before it opened/);
    expect(await problem({ kind: 'set_category', transaction: toSaver.id, category: 'no-such-category' })).toMatch(/no category/);
    expect(await problem({ kind: 'set_category', transaction: saverIn.id, category: 'groceries' })).toMatch(/transfer category, not/);
    // What the data says already is not a change.
    expect(await problem({ kind: 'set_account_dates', account: 'fixed', closedOn: '2026-02-03' })).toMatch(/already says this/);
  });

  it('checks without keeping it on a dry run, and only a token proposes', async () => {
    const res = await propose({ ...relink, dryRun: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProposalView).ready).toBe(3);
    expect(app.ctx.proposals.pendingCount).toBe(0);
    expect((await req('/api/proposals', { method: 'POST', headers: CSRF, body: JSON.stringify(relink) })).status).toBe(403);
  });

  it('shows a change that stopped fitting after it was made, and applies the rest', async () => {
    const { proposal } = (await (await propose(relink)).json()) as ProposalView;
    // The owner deletes the bank's receipt meanwhile.
    await app.ctx.store.deleteTransactions([bankIn.id], 'test');
    const view = (await (await req(`/api/proposals/${proposal.id}`)).json()) as ProposalView;
    expect(view.changes.find((c) => c.change.key === 'easy')!.problem).toMatch(/no longer in your data/);
    expect(view.rows[bankIn.id]).toMatchObject({ missing: true });
    const refused = await owner(`/api/proposals/${proposal.id}/apply`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { problems: { key: string }[] }).problems.map((p) => p.key)).toEqual(['easy']);
    expect((await owner(`/api/proposals/${proposal.id}/apply`, { leaveOut: ['easy'] })).status).toBe(200);
  });

  it('carries one pattern across many rows', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => tx('bank', `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, -(10 + i), `TO A N OTHER REFERENCE POT ${i}`));
    await app.ctx.store.addTransactions(rows, 'test');
    const res = await propose({ title: 'Payments to your own name', summary: 'A test.', changes: rows.map((t) => ({ kind: 'set_category', transaction: t.id, category: 'transfer', why: 'Paid to you by name.' })) });
    expect(res.status).toBe(201);
    const { proposal, ready } = (await res.json()) as ProposalView;
    expect(ready).toBe(120);
    expect((await owner(`/api/proposals/${proposal.id}/apply`, { leaveOut: ['c1'] })).status).toBe(200);
    expect(app.ctx.store.transaction(rows[1]!.id)).toMatchObject({ category: 'transfer', categorisedBy: 'user' });
    expect(app.ctx.store.transaction(rows[0]!.id)!.category).toBeUndefined();
  });

  it('a job proposes through the same service, as itself', async () => {
    const view = await app.ctx.proposals.create(
      { title: 'From a job', summary: 'A test.', changes: [{ kind: 'link_transfer', from: easyOut.id, to: bankIn.id, why: 'A test.' }] },
      { setBy: 'agent', model: 'test-model', promptVersion: 'check-data-1', jobId: 'job_0123456789ab' },
    );
    expect(view.proposal.provenance).toEqual({ setBy: 'agent', model: 'test-model', promptVersion: 'check-data-1', jobId: 'job_0123456789ab' });
    expect(app.ctx.proposals.pendingCount).toBe(1);
  });
});
