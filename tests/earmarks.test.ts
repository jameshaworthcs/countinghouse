// Set aside (docs/FORMULAS.md §21): the money set aside in everyday accounts, worked out from rules,
// decisions and transfers, and proposed by agents for the owner to apply. All data here is invented
// (Jo Bloggs, a student, at "Example" providers).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BootstrapResponse, EarmarksResponse, ProposalDecision, ProposalView } from '../src/shared/api';
import { addDays } from '../src/shared/dates';
import { fromMinor, toMinor } from '../src/shared/money';
import { EarmarksSchema, POT_EFFECTS, type Account, type Earmarks, type Transaction } from '../src/shared/schema';
import { computeEarmarks, type EarmarksInput } from '../src/server/analytics/earmarks';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { balanceId, transactionId, transferGroupId } from '../src/server/ids';

const stamp = '2026-08-01T00:00:00+00:00';
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ id, name: `Example ${id}`, type, currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp, ...extra });
let seq = 0;
const tx = (accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: transactionId(accountId, date, amount, description, seq++),
  accountId,
  date,
  amount,
  currency: 'GBP',
  description,
  source: {},
  createdAt: stamp,
  ...extra,
});
/** Both sides of a move between two accounts, linked. */
const move = (from: string, to: string, date: string, amount: number, words: string): [Transaction, Transaction] => {
  const a = tx(from, date, -amount, `${words} TO ${to.toUpperCase()}`, { category: 'transfer', counterpartyAccountId: to });
  const b = tx(to, date, amount, `${words} FROM ${from.toUpperCase()}`, { category: 'transfer', counterpartyAccountId: from });
  const g = transferGroupId(a.id, b.id);
  return [{ ...a, transferGroup: g }, { ...b, transferGroup: g }];
};

const accounts = [acct('current', 'current'), acct('card', 'credit_card'), acct('saver', 'savings'), acct('loan', 'student_loan'), acct('platform', 'stocks_isa')];
const categories = [
  { id: 'rent', name: 'Rent', kind: 'expense' as const },
  { id: 'groceries', name: 'Groceries', kind: 'expense' as const },
  { id: 'transfer', name: 'Transfer', kind: 'transfer' as const },
];
const START = '2026-09-01';
const base = (): Earmarks =>
  EarmarksSchema.parse({
    everyday: ['current', 'card'],
    setAside: ['saver'],
    pots: [
      {
        id: 'student-money',
        name: 'Student money',
        start: START,
        opening: 0,
        rules: [
          { id: 'loan', name: 'Maintenance loan', effect: 'source', counterpartyAccountId: 'loan' },
          { id: 'rent', name: 'Hall rent', effect: 'use', category: 'rent', direction: 'out', limitTo: ['loan'] },
          { id: 'isa', name: 'ISA', effect: 'use', text: { value: 'EXAMPLE PLATFORM' }, direction: 'out' },
        ],
      },
    ],
    decisions: {},
    updatedAt: stamp,
  });

const [toSaver, saverIn] = move('current', 'saver', '2026-09-12', 200, 'SAVING');
const [fromSaver, currentIn] = move('saver', 'current', '2026-09-20', 500, 'LOAN');
const [cardPay, cardIn] = move('current', 'card', '2026-09-28', 1200, 'CARD');
const loanIn = tx('current', '2026-09-05', 1500, 'EXAMPLE STUDENT FINANCE', { counterpartyAccountId: 'loan' });
const rent = tx('card', '2026-09-10', -1200, 'EXAMPLE HALL RENT', { category: 'rent' });
const groceries = tx('current', '2026-09-25', -50, 'EXAMPLE SUPERMARKET', { category: 'groceries' });
const rows = [loanIn, rent, toSaver, saverIn, fromSaver, currentIn, groceries, cardPay, cardIn];
/** Opening balances on the day before the start. */
const OPENING: Record<string, number> = { current: 300, card: 0, saver: 1000 };

/** A plain ledger: each account's opening plus its rows to the day. */
function input(setup: Earmarks, txs: Transaction[], last: Record<string, string> = {}): EarmarksInput {
  return {
    setup,
    accounts,
    categories,
    transactions: txs,
    balanceOn: (id, d) => {
      if (!(id in OPENING)) return null;
      return fromMinor(txs.filter((t) => t.accountId === id && t.date <= d).reduce((s, t) => s + toMinor(t.amount), toMinor(OPENING[id]!)));
    },
    lastDataOf: (id) => last[id] ?? txs.filter((t) => t.accountId === id).reduce<string | null>((m, t) => (!m || t.date > m ? t.date : m), id in OPENING ? addDays(START, -1) : null),
    firstDataOf: (id) => (id in OPENING ? addDays(START, -1) : null),
    today: '2026-10-01',
  };
}
const pot = (r: EarmarksResponse) => r.result!.pots[0]!;
const line = (r: EarmarksResponse, effect: string) => pot(r).lines.find((l) => l.effect === effect);

describe('set aside: the sum', () => {
  it('counts sources, uses up to what they brought in, and transfers with the saver', () => {
    const r = computeEarmarks(input(base(), rows));
    expect(r.problems).toEqual([]);
    // 1,500 loan − 1,200 rent (on the card) − 200 put back + 500 borrowed.
    expect(pot(r).setAside).toBe(600);
    expect(line(r, 'source')!.total).toBe(1500);
    expect(line(r, 'use')!.total).toBe(-1200);
    expect(line(r, 'to-pot')!.total).toBe(-200);
    expect(line(r, 'from-pot')!.total).toBe(500);
    // The card repayment is a move between two everyday accounts: it changes nothing.
    expect(r.result!.internal.count).toBe(2);
    // Everyday: current 300 + 1500 − 200 + 500 − 50 − 1200 = 850; card 0 − 1200 + 1200 = 0.
    expect(r.result!.everydayTotal).toBe(850);
    expect(r.result!.spendable).toBe(250);
    expect(r.result!.toCheck).toEqual([]);
    expect(r.result!.heldInSetAside).toBe(1000 + 200 - 500);
  });

  it('pays from the pot only up to what its sources brought in', () => {
    const bigRent = { ...rent, amount: -2000 };
    const r = computeEarmarks(input(base(), rows.map((t) => (t.id === rent.id ? bigRent : t))));
    expect(line(r, 'use')!.total).toBe(-1500);
    const own = line(r, 'own')!;
    expect(own.out).toBe(500);
    // With nothing left in the pot, the 200 sent to the saver can only be you topping it up: nothing to ask.
    expect(pot(r).setAside).toBe(500);
    expect(r.result!.toCheck).toEqual([]);
    expect(line(r, 'topped-up')!.rows.map((x) => [x.transactionId, x.counted, x.by])).toEqual([[toSaver.id, -200, 'default']]);
  });

  it('puts back what the pot held, and asks about more than that', () => {
    const [big, bigIn] = move('current', 'saver', '2026-09-26', 1000, 'SAVING');
    const r = computeEarmarks(input(base(), [...rows, big, bigIn]));
    // It held 600: 600 put back, 400 counted as you topping it up until you decide.
    expect(pot(r).setAside).toBe(0);
    expect(r.result!.toCheck).toHaveLength(1);
    expect(r.result!.toCheck[0]).toMatchObject({ kind: 'more-than-held', amount: 1000, transactionIds: [big.id] });
    expect(r.result!.toCheck[0]!.suggestion![0]!.parts).toEqual([
      { effect: 'to-pot', amount: 600 },
      { effect: 'topped-up', amount: 400 },
    ]);
    expect(pot(r).provisional).toBe(1000);
  });

  it('a decision wins over rules and defaults, and a stale one is flagged', () => {
    const [big, bigIn] = move('current', 'saver', '2026-09-26', 1000, 'SAVING');
    const setup = base();
    setup.decisions[big.id] = { pot: 'student-money', parts: [{ effect: 'topped-up', amount: 1000 }], reason: 'Birthday money, saved', seen: { accountId: 'current', date: big.date, amount: big.amount }, decidedAt: stamp };
    setup.decisions['tx_0000000000000000'] = { pot: 'student-money', parts: [{ effect: 'source', amount: 10 }], reason: 'Gone', seen: { accountId: 'current', date: '2026-09-02', amount: 10 }, decidedAt: stamp };
    const r = computeEarmarks(input(setup, [...rows, big, bigIn]));
    expect(pot(r).setAside).toBe(600);
    expect(r.result!.toCheck.map((c) => c.kind)).toEqual(['stale-decision']);
    expect(line(r, 'topped-up')!.rows.find((x) => x.transactionId === big.id)).toMatchObject({ by: 'decision', reason: 'Birthday money, saved' });
  });

  it('a share of a payment, and money on its way between two everyday accounts', () => {
    const setup = base();
    setup.pots[0]!.rules.unshift({ id: 'tips', name: 'A third of tips', effect: 'source', text: { field: 'description', op: 'contains', value: 'EXAMPLE TIPS', caseSensitive: false }, portion: { percent: 33.33 } });
    const tips = tx('current', '2026-09-15', 100, 'EXAMPLE TIPS');
    // Paid to the card on the 29th; the card's data ends on the 28th.
    const late = tx('current', '2026-09-29', -60, 'CARD PAYMENT', { category: 'transfer', counterpartyAccountId: 'card' });
    const r = computeEarmarks(input(setup, [...rows, tips, late], { card: '2026-09-28' }));
    expect(line(r, 'source')!.total).toBe(1500 + 33.33);
    expect(r.result!.onItsWay).toMatchObject([{ transactionId: late.id, amount: 60, otherAccountId: 'card' }]);
    expect(r.result!.spendable).toBe(fromMinor(toMinor(r.result!.everydayTotal) + toMinor(60) - toMinor(pot(r).setAside)));
  });

  it('can’t work out an account with no balance', () => {
    const setup = { ...base(), everyday: ['current', 'card', 'platform'] };
    const r = computeEarmarks(input(setup, rows));
    expect(r.result).toBeNull();
    expect(r.problems[0]).toMatch(/no balance/);
  });
});

describe('set aside: what the review found', () => {
  it('pairs by amount only transfers between everyday accounts, never a saver transfer with a refund', () => {
    const setup = base();
    setup.pots[0]!.opening = 500;
    // −200 to the saver (linked), and a +200 uncategorised refund on the card two days later.
    const [save, saveIn] = move('current', 'saver', '2026-09-14', 200, 'SAVING');
    const refund = tx('card', '2026-09-16', 200, 'EXAMPLE SHOP REFUND');
    const r = computeEarmarks(input(setup, [...rows, save, saveIn, refund]));
    expect(line(r, 'to-pot')!.rows.map((x) => x.transactionId)).toContain(save.id);
    // Two transfers of opposite amounts, unlinked, between the current account and the card: paired.
    const out = tx('current', '2026-09-21', -75, 'PAYMENT TO CARD', { category: 'transfer' });
    const inn = tx('card', '2026-09-23', 75, 'PAYMENT RECEIVED', { category: 'transfer' });
    expect(computeEarmarks(input(base(), [...rows, out, inn])).result!.internal.count).toBe(4);
  });

  it('every pot’s rules come before any default', () => {
    const setup = base();
    setup.everyday = ['current', 'card'];
    setup.setAside = ['saver'];
    setup.pots.push(EarmarksSchema.parse({ ...base(), pots: [{ id: 'holiday', name: 'Holiday', start: START, opening: 400, rules: [{ id: 'trip', name: 'Trip money', effect: 'to-pot', text: { value: 'HOLIDAY' }, direction: 'out' }] }] }).pots[0]!);
    const [trip, tripIn] = move('current', 'saver', '2026-09-15', 100, 'HOLIDAY');
    const r = computeEarmarks(input(setup, [...rows, trip, tripIn])).result!;
    // The first pot is as without it; the holiday pot's rule takes the transfer.
    expect(r.pots.map((p) => [p.id, p.setAside])).toEqual([
      ['student-money', 600],
      ['holiday', 300],
    ]);
  });

  it('starting again carries what a limited rule could still pay, so no figure changes', () => {
    // 1,500 of loan, 1,200 of rent by the end of the 28th: 300 the rent rule could still pay.
    const laterRent = tx('card', '2026-10-05', -250, 'EXAMPLE HALL RENT', { category: 'rent' });
    const all = [...rows, laterRent];
    const before = computeEarmarks(input(base(), all, { card: '2026-10-05', current: '2026-10-05' })).result!;
    const atD = computeEarmarks(input(base(), all.filter((t) => t.date <= '2026-09-28'))).result!.pots[0]!;
    expect(atD.allowances).toEqual({ rent: 300 });
    const restarted = base();
    restarted.pots[0] = { ...restarted.pots[0]!, start: '2026-09-29', opening: atD.setAside, carried: atD.allowances };
    const after = computeEarmarks(input(restarted, all, { card: '2026-10-05', current: '2026-10-05' })).result!;
    expect([after.pots[0]!.setAside, after.spendable]).toEqual([before.pots[0]!.setAside, before.spendable]);
    expect(after.pots[0]!.lines.find((l) => l.effect === 'use')!.total).toBe(-250);
  });

  it('a limited rule’s refund counts with the day’s money in, before money put back', () => {
    const setup = base();
    setup.pots[0]!.opening = 0;
    // The rent is refunded (+200) on the day 200 goes to the saver: the refund is in the pot first.
    const refund = tx('card', '2026-09-12', 200, 'EXAMPLE HALL RENT REFUND', { category: 'rent' });
    const r = computeEarmarks(input(setup, [...rows, refund]));
    expect(line(r, 'to-pot')!.rows.find((x) => x.transactionId === toSaver.id)?.counted).toBe(-200);
    expect(r.result!.toCheck).toEqual([]);
  });

  it('the chart ends on today’s figure', () => {
    const r = computeEarmarks(input(base(), rows)).result!;
    expect(r.series.at(-1)).toEqual({ date: '2026-09-28', spendable: r.spendable, setAside: 600, total: 850 });
  });
});

describe('set aside: properties', () => {
  const RUNS = { numRuns: 150 };
  const day = fc.integer({ min: 0, max: 29 }).map((n) => addDays(START, n));
  const shop = fc.record({ date: day, pence: fc.integer({ min: -50_000, max: 50_000 }).filter((p) => p !== 0) });

  it('ordinary payments never move what is set aside, and move spendable by exactly their sum', () => {
    fc.assert(
      fc.property(fc.array(shop, { maxLength: 30 }), (shops) => {
        const extra = shops.map((s, i) => tx('current', s.date, fromMinor(s.pence), `EXAMPLE SHOP ${i}`, { category: 'groceries' }));
        const a = computeEarmarks(input(base(), rows)).result!;
        const b = computeEarmarks(input(base(), [...rows, ...extra])).result!;
        const sum = shops.reduce((s, x) => s + x.pence, 0);
        return b.pots[0]!.setAside === a.pots[0]!.setAside && toMinor(b.spendable) - toMinor(a.spendable) === sum;
      }),
      RUNS,
    );
  });

  it('the order rows are recorded in changes nothing, within a day too', () => {
    // Rows are taken in date and id order, so giving the same payments other ids reorders each day.
    const [big, bigIn] = move('current', 'saver', '2026-09-05', 2500, 'SAVING');
    const all = [...rows, big, bigIn, tx('current', '2026-09-05', -300, 'EXAMPLE PLATFORM ISA'), tx('current', '2026-09-05', 120, 'EXAMPLE STUDENT FINANCE TOP UP', { counterpartyAccountId: 'loan' })];
    const figures = (r: EarmarksResponse) => JSON.stringify({ spendable: r.result!.spendable, setAside: r.result!.pots.map((p) => [p.setAside, p.provisional, p.lines.map((l) => [l.effect, l.total, l.in, l.out, l.count])]), toCheck: r.result!.toCheck.map((c) => [c.kind, c.date, c.amount]) });
    const want = figures(computeEarmarks(input(base(), all)));
    fc.assert(
      fc.property(fc.shuffledSubarray(all.map((t) => t.id), { minLength: all.length, maxLength: all.length }), (ids) => {
        const renamed = all.map((t, i) => ({ ...t, id: ids[i]! }));
        return figures(computeEarmarks(input(base(), renamed))) === want;
      }),
      { numRuns: 80 },
    );
  });

  it('set aside is the opening plus its lines, and adds up with spendable to the everyday accounts', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ date: day, pence: fc.integer({ min: 1, max: 300_000 }), kind: fc.constantFrom('loan', 'rent', 'save', 'borrow', 'isa') }), { maxLength: 25 }), fc.integer({ min: -50_000, max: 50_000 }), (events, opening) => {
        const extra = events.flatMap((e, i): Transaction[] => {
          const amount = fromMinor(e.pence);
          if (e.kind === 'loan') return [tx('current', e.date, amount, `EXAMPLE STUDENT FINANCE ${i}`, { counterpartyAccountId: 'loan' })];
          if (e.kind === 'rent') return [tx('card', e.date, -amount, `EXAMPLE HALL RENT ${i}`, { category: 'rent' })];
          if (e.kind === 'isa') return [tx('current', e.date, -amount, `EXAMPLE PLATFORM ${i}`)];
          return move(e.kind === 'save' ? 'current' : 'saver', e.kind === 'save' ? 'saver' : 'current', e.date, amount, `MOVE ${i}`);
        });
        const setup = base();
        setup.pots[0]!.opening = fromMinor(opening);
        const r = computeEarmarks(input(setup, [...rows, ...extra])).result!;
        const p = r.pots[0]!;
        const fromLines = p.lines.filter((l) => POT_EFFECTS.includes(l.effect)).reduce((s, l) => s + toMinor(l.total), opening);
        const addsUp = toMinor(r.spendable) + toMinor(p.setAside) === toMinor(r.everydayTotal) + toMinor(r.onItsWayTotal);
        // Rent is never counted beyond the loans brought in.
        const loans = (p.lines.find((l) => l.effect === 'source')?.in ?? 0) * 100;
        const rentCounted = (p.lines.find((l) => l.effect === 'use')?.rows ?? []).filter((x) => x.ruleId === 'rent').reduce((s, x) => s - toMinor(x.counted), 0);
        return fromLines === toMinor(p.setAside) && addsUp && rentCounted <= Math.round(loans);
      }),
      RUNS,
    );
  });
});

describe('set aside: in the app, by proposals', () => {
  const CSRF = { 'x-finance-csrf': '1', 'content-type': 'application/json' };
  let app: App;
  let dir: string;
  let agent: string;
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://localhost${p}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
  const propose = (body: unknown) => req('/api/proposals', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify(body) });
  const owner = (p: string, body: unknown = {}) => req(p, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
  const get = async <T,>(p: string) => (await (await req(p)).json()) as T;
  const setup = () => {
    const { decisions: _d, updatedAt: _u, ...rest } = base();
    return { ...rest, pots: rest.pots.map(({ checks: _c, ...p }) => p) };
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-earmarks-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
    const { store } = app.ctx;
    await store.setAccounts(accounts);
    await store.setCategories([...store.categories.filter((c) => !categories.some((x) => x.id === c.id)), ...categories]);
    await store.addTransactions(rows, 'test');
    const day = addDays(START, -1);
    await store.addBalances(
      Object.entries(OPENING).map(([accountId, balance]) => ({ id: balanceId(accountId, day, balance, 'statement'), accountId, date: day, balance, currency: 'GBP', kind: 'statement' as const, source: {}, createdAt: stamp })),
      'test',
    );
    agent = `Bearer ${(await app.ctx.tokens.create({ name: 'Test agent', scopes: ['records', 'read'], days: 1 })).token}`;
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('shows nothing and works out nothing without the file', async () => {
    expect((await get<BootstrapResponse>('/api/bootstrap')).earmarks).toEqual([]);
    expect(await get<EarmarksResponse>('/api/earmarks')).toEqual({ setup: null, result: null, problems: [] });
  });

  it('an agent proposes the setup; applying it writes earmarks.json and the figure follows', async () => {
    const res = await propose({ title: 'Set aside Student money', summary: 'The loan is for rent.', changes: [{ kind: 'set_earmarks', why: 'From your answers', setup: setup(), was: null }] });
    expect(res.status).toBe(201);
    const view = (await res.json()) as ProposalView;
    const shown = await get<ProposalView>(`/api/proposals/${view.proposal.id}`);
    expect(shown.earmarks).toEqual({ before: null, after: { setAside: 600, spendable: 250, toCheck: 0 } });
    const applied = (await (await owner(`/api/proposals/${view.proposal.id}/apply`)).json()) as ProposalDecision;
    expect(applied.proposal.status).toBe('applied');
    const file = EarmarksSchema.parse(JSON.parse(await readFile(path.join(dir, 'data', 'earmarks.json'), 'utf8')));
    expect(file.pots[0]!.rules).toHaveLength(3);
    expect((await get<BootstrapResponse>('/api/bootstrap')).earmarks).toEqual([{ id: 'student-money', name: 'Student money' }]);
    const r = await get<EarmarksResponse>('/api/earmarks');
    expect(r.result!.spendable).toBe(250);
    // Proposed against no setup, it no longer fits once there is one.
    const again = await propose({ title: 'Again', summary: 'Again', changes: [{ kind: 'set_earmarks', why: 'Again', setup: { ...setup(), setAside: [] }, was: null }] });
    expect(again.status).toBe(422);
  });

  it('a decision is proposed, applied with its proposal noted, and replacing it says so', async () => {
    await app.ctx.store.setEarmarks(base());
    const decide = (parts: { effect: string; amount: number }[] | null, was: string | null, why: string) => propose({ title: 'Decide the saving', summary: 'From the reference', changes: [{ kind: 'decide_earmark_flow', why, pot: 'student-money', transaction: toSaver.id, parts, was }] });
    // Its parts can't add up to more than the payment, and money out can't be borrowed from the pot.
    expect((await decide([{ effect: 'topped-up', amount: 250 }], null, 'Too much')).status).toBe(422);
    expect((await decide([{ effect: 'from-pot', amount: 200 }], null, 'Wrong way')).status).toBe(422);
    const v = (await (await decide([{ effect: 'topped-up', amount: 200 }], null, 'Birthday money, saved')).json()) as ProposalView;
    expect((await get<ProposalView>(`/api/proposals/${v.proposal.id}`)).earmarks).toEqual({ before: { setAside: 600, spendable: 250, toCheck: 0 }, after: { setAside: 800, spendable: 50, toCheck: 0 } });
    await owner(`/api/proposals/${v.proposal.id}/apply`);
    const d = app.ctx.store.earmarks!.decisions[toSaver.id]!;
    expect(d).toMatchObject({ pot: 'student-money', reason: 'Birthday money, saved', proposalId: v.proposal.id, seen: { amount: -200 } });
    // Against the decision as it is now, a proposal can replace it, and says whose it replaces.
    const replace = (await (await decide([{ effect: 'to-pot', amount: 200 }], d.decidedAt, 'Paid back')).json()) as ProposalView;
    expect(replace.changes[0]!.earmark!.replaces).toMatch(/Replaces your decision/);
    // Against no decision, it no longer fits.
    expect((await decide([{ effect: 'to-pot', amount: 200 }], null, 'Stale')).status).toBe(422);
  });

  it('the owner decides, checks and starts again on the page; no token can', async () => {
    await app.ctx.store.setEarmarks(base());
    const asOwner = (p: string, body: unknown) => owner(p, body);
    // A token can't decide: it proposes instead.
    const byToken = await req('/api/earmarks/decisions', { method: 'POST', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: [{ effect: 'topped-up', amount: 200 }] }] }) });
    expect(byToken.status).toBe(403);
    // The preview says what deciding would do, writing nothing.
    const preview = (await (await asOwner('/api/earmarks/preview', { decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: [{ effect: 'topped-up', amount: 200 }] }] })).json()) as { before: { setAside: number }; after: { setAside: number } };
    expect([preview.before.setAside, preview.after.setAside]).toEqual([600, 800]);
    expect(app.ctx.store.earmarks!.decisions).toEqual({});
    // A decision that doesn't fit is refused with why.
    const bad = await asOwner('/api/earmarks/decisions', { decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: [{ effect: 'from-pot', amount: 200 }] }] });
    expect(bad.status).toBe(422);
    const decided = (await (await asOwner('/api/earmarks/decisions', { decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: [{ effect: 'topped-up', amount: 200 }], reason: 'Birthday money, saved' }] })).json()) as EarmarksResponse;
    expect(decided.result!.pots[0]!.setAside).toBe(800);
    expect(app.ctx.store.earmarks!.decisions[toSaver.id]).toMatchObject({ reason: 'Birthday money, saved', seen: { amount: -200 } });
    expect(app.ctx.store.earmarks!.decisions[toSaver.id]!.proposalId).toBeUndefined();
    // "I've checked this" keeps the figures.
    const checked = (await (await asOwner('/api/earmarks/checks', {})).json()) as EarmarksResponse;
    expect(checked.result!.pots[0]!.checks).toMatchObject([{ setAside: 800, spendable: 50 }]);
    // Starting again keeps today's figure, from the day after every everyday account's latest day.
    const before = checked.result!;
    const restarted = (await (await asOwner('/api/earmarks/restart', { pot: 'student-money' })).json()) as EarmarksResponse;
    const pot2 = restarted.setup!.pots[0]!;
    expect(pot2.start).toBe(addDays(before.oldest!, 1));
    expect(restarted.result!.pots[0]!.setAside).toBe(before.pots[0]!.setAside);
    expect(restarted.result!.spendable).toBe(before.spendable);
    expect(restarted.setup!.decisions).toEqual({});
    // Taking a decision away (none left now) is refused for a payment before the new start.
    expect((await asOwner('/api/earmarks/decisions', { decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: null }] })).status).toBe(422);
  });

  it('the owner sets it up, changes and removes it by hand; a stale change and a token are refused', async () => {
    const send = (method: string, p: string, body?: unknown) => req(p, { method, headers: CSRF, ...(body ? { body: JSON.stringify(body) } : {}) });
    const preview = (await (await owner('/api/earmarks/setup/preview', { setup: setup() })).json()) as EarmarksResponse;
    expect(preview.result!.pots[0]!.setAside).toBe(600);
    expect(app.ctx.store.earmarks).toBeNull();
    // A rule naming a category you don't have is refused, with why.
    const bad = { ...setup(), pots: [{ ...setup().pots[0]!, rules: [{ id: 'x', name: 'X', effect: 'source', category: 'no-such-category' }] }] };
    expect(((await (await owner('/api/earmarks/setup/preview', { setup: bad })).json()) as EarmarksResponse).problems[0]).toMatch(/no category/);
    expect((await send('PUT', '/api/earmarks/setup', { setup: bad, was: null })).status).toBe(422);
    const tokenPut = await req('/api/earmarks/setup', { method: 'PUT', headers: { ...CSRF, authorization: agent }, body: JSON.stringify({ setup: setup(), was: null }) });
    expect(tokenPut.status).toBe(403);
    const made = await send('PUT', '/api/earmarks/setup', { setup: setup(), was: null });
    expect(made.status).toBe(200);
    expect((await get<BootstrapResponse>('/api/bootstrap')).earmarks).toEqual([{ id: 'student-money', name: 'Student money' }]);
    // A decision stays when the setup changes.
    await owner('/api/earmarks/decisions', { decisions: [{ pot: 'student-money', transaction: toSaver.id, parts: [{ effect: 'topped-up', amount: 200 }] }] });
    const was = app.ctx.store.earmarks!.updatedAt;
    const changed = { ...setup(), pots: [{ ...setup().pots[0]!, name: 'Loan for rent' }] };
    expect((await send('PUT', '/api/earmarks/setup', { setup: changed, was: '2020-01-01T00:00:00+00:00' })).status).toBe(409);
    expect((await send('PUT', '/api/earmarks/setup', { setup: changed, was })).status).toBe(200);
    expect(app.ctx.store.earmarks!.pots[0]!.name).toBe('Loan for rent');
    expect(Object.keys(app.ctx.store.earmarks!.decisions)).toEqual([toSaver.id]);
    expect((await req('/api/earmarks', { method: 'DELETE', headers: { ...CSRF, authorization: agent } })).status).toBe(403);
    expect((await send('DELETE', '/api/earmarks')).status).toBe(200);
    expect(app.ctx.store.earmarks).toBeNull();
    expect((await get<BootstrapResponse>('/api/bootstrap')).earmarks).toEqual([]);
  });

  it('Ask reads it with its own tool, offered only when something is set aside', async () => {
    const { toolsFor, runTool } = await import('../src/server/ask-tools');
    const { systemPrompt, stepSchema } = await import('../src/server/ask');
    expect(toolsFor(app.ctx.store)).not.toContain('set_aside');
    expect(systemPrompt(8, toolsFor(app.ctx.store))).not.toMatch(/set_aside/);
    await app.ctx.store.setEarmarks(base());
    const tools = toolsFor(app.ctx.store);
    expect(tools).toContain('set_aside');
    expect(JSON.stringify(stepSchema(undefined, tools))).toMatch(/set_aside/);
    const r = runTool(app.ctx.store, app.ctx.analytics, 'set_aside', {});
    expect(r.href).toBe('/earmarks');
    expect(r.result).toMatchObject({ spendable: 250, setAside: 600, pots: [{ name: 'Student money', setAside: 600 }] });
  });

  it('the local model suggests decisions as one proposal, only with its switch on', async () => {
    const { suggestEarmarks } = await import('../src/server/earmark-suggest');
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0', INFERENCE_BASE_URL: 'http://127.0.0.1:9/v1', INFERENCE_API_KEY: 'inf_finance_test' });
    // 1,000 to the saver when the pot held 600: one payment to check.
    const [big, bigIn] = move('current', 'saver', '2026-09-26', 1000, 'SAVING');
    await app.ctx.store.addTransactions([big, bigIn], 'test');
    await app.ctx.store.setEarmarks(base());
    const seen: string[] = [];
    const fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: { text: string }[] | string }[] };
      seen.push(JSON.stringify(body.messages));
      const out = { choice: 'as-suggested', reason: 'The pot held 600: the rest is your own saving.', confidence: 'high' };
      return Promise.resolve(new Response(JSON.stringify({ model: 'qwen-test-q4', choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 }, provenance: { request_id: 'inf_1', alias: 'fast-chat', model_id: 'qwen-test-q4', schema_valid: true } }), { status: 200 }));
    }) as typeof globalThis.fetch;
    // Off until you turn it on.
    await expect(suggestEarmarks(app.ctx.store, app.ctx.analytics, config, app.ctx.proposals, { fetch })).rejects.toThrow(/off/);
    await app.ctx.store.setSettings({ ...app.ctx.store.settings, agents: { ...app.ctx.store.settings.agents, earmarkSuggest: true } });
    const r = await suggestEarmarks(app.ctx.store, app.ctx.analytics, config, app.ctx.proposals, { fetch });
    expect(r).toMatchObject({ asked: 1, suggested: 1 });
    // It was given the payment and why the app asks.
    expect(seen[0]).toMatch(/more than the £600\.00 Student money held/);
    const view = await app.ctx.proposals.get(r.proposalId!);
    expect(view.proposal.provenance).toMatchObject({ setBy: 'agent', engine: 'inference', promptVersion: 'suggest-earmarks-1' });
    expect(view.proposal.changes).toMatchObject([{ kind: 'decide_earmark_flow', transaction: big.id, parts: [{ effect: 'to-pot', amount: 600 }, { effect: 'topped-up', amount: 400 }] }]);
    // Nothing is decided until you apply it, and a payment already proposed is not asked about again.
    expect(app.ctx.store.earmarks!.decisions).toEqual({});
    expect(await suggestEarmarks(app.ctx.store, app.ctx.analytics, config, app.ctx.proposals, { fetch })).toMatchObject({ asked: 0, suggested: 0 });
  });

  it('two decisions at once are both kept, and deciding by hand closes the same proposal', async () => {
    await app.ctx.store.setEarmarks(base());
    const decide = (id: string, effect: string, amount: number) => owner('/api/earmarks/decisions', { decisions: [{ pot: 'student-money', transaction: id, parts: [{ effect, amount }] }] });
    const [a, b] = await Promise.all([decide(toSaver.id, 'topped-up', 200), decide(groceries.id, 'own', 50)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Object.keys(app.ctx.store.earmarks!.decisions).sort()).toEqual([toSaver.id, groceries.id].sort());
    // An agent proposes a decision; you then decide the same yourself: the proposal is already done.
    const v = (await (await propose({ title: 'Decide the loan', summary: 'From the reference', changes: [{ kind: 'decide_earmark_flow', why: 'Borrowed', pot: 'student-money', transaction: currentIn.id, parts: [{ effect: 'from-pot', amount: 500 }], was: null }] })).json()) as ProposalView;
    await decide(currentIn.id, 'from-pot', 500);
    const closed = await app.ctx.proposals.closeDone();
    expect(closed.map((p) => [p.id, p.status])).toEqual([[v.proposal.id, 'superseded']]);
  });
});

