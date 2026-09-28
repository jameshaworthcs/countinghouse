// Generate a realistic, deterministic synthetic dataset in demo-data/ (gitignored), so every screen
// can be seen before any real data exists.
//
//   npm run demo:reset          regenerate
//   tsx scripts/demo-data.ts --if-missing

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../src/server/config';
import { enrich } from '../src/server/enrich';
import { nowISO } from '../src/server/fsutil';
import { balanceId, figureId, holdingsId, transactionId } from '../src/server/ids';
import { ImportService } from '../src/server/ingest/service';
import { applyRecords, researchIdOf, setOwnerAssumption } from '../src/server/records';
import { WorkArea } from '../src/server/ingest/workarea';
import { Store } from '../src/server/store';
import { addDays, addMonths, endOfMonth, startOfMonth, today, weekday } from '../src/shared/dates';
import { roundMoney } from '../src/shared/money';
import type { Account, BalanceSnapshot, Figure, HoldingsSnapshot, Transaction } from '../src/shared/schema';

const DIR = path.join(PROJECT_ROOT, 'demo-data');
const WORK = path.join(PROJECT_ROOT, '.work', 'demo-data');
const args = new Set(process.argv.slice(2));

if (args.has('--if-missing') && existsSync(path.join(DIR, 'meta.json'))) {
  console.log('demo-data/ already exists (npm run demo:reset to regenerate)');
  process.exit(0);
}

// Deterministic PRNG (mulberry32).
let seed = 20260928;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a: number, b: number) => roundMoney(a + rand() * (b - a));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

const stamp = nowISO();
const END = today();
const START = startOfMonth(addMonths(END, -24));

const acct = (id: string, name: string, type: Account['type'], institutionId: string | undefined, extra: Partial<Account> = {}): Account => ({
  id,
  name,
  type,
  currency: 'GBP',
  status: 'open',
  aliases: [],
  includeInNetWorth: type !== 'student_loan' && type !== 'state_pension',
  createdAt: stamp,
  updatedAt: stamp,
  ...(institutionId ? { institutionId } : {}),
  ...extra,
});

const txs: Transaction[] = [];
const occ = new Map<string, number>();
function tx(accountId: string, date: string, amount: number, description: string, extra: Partial<Transaction> = {}): void {
  if (date > END) return;
  const key = `${accountId}|${date}|${amount}|${description}`;
  const n = occ.get(key) ?? 0;
  occ.set(key, n + 1);
  txs.push({ id: transactionId(accountId, date, amount, description, n), accountId, date, amount: roundMoney(amount), currency: 'GBP', description, source: {}, createdAt: stamp, ...extra });
}

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await rm(WORK, { recursive: true, force: true });
  const store = await Store.open(DIR);
  await store.setProfile({ name: 'Jo Bloggs', dateOfBirth: '1990-05-14', taxRegion: 'england', taxBand: 'higher', grossSalary: 115_000, retirementAge: 67 });
  // Demo data never starts agent jobs on its own (they would spend your Claude plan).
  await store.setSettings({ ...store.settings, agents: { ...store.settings.agents, enabled: false } });
  for (const inst of [
    { id: 'example-bank', name: 'Example Bank', kind: 'bank' as const },
    { id: 'example-cards', name: 'Example Cards', kind: 'card_issuer' as const },
    { id: 'example-savings', name: 'Example Savings', kind: 'bank' as const },
    { id: 'ns-and-i', name: 'NS&I', kind: 'government' as const },
    { id: 'example-invest', name: 'Example Invest', kind: 'investment_platform' as const },
    { id: 'example-app', name: 'Example App', kind: 'investment_platform' as const },
    { id: 'example-pensions', name: 'Example Pensions', kind: 'pension_provider' as const },
    { id: 'dwp', name: 'DWP (State Pension)', kind: 'government' as const },
    { id: 'slc', name: 'Student Loans Company', kind: 'government' as const },
  ]) {
    await store.upsertInstitution(inst);
  }
  await store.setAccounts([
    acct('current-account', 'Example Bank current account', 'current', 'example-bank', { last4: '4821' }),
    acct('rewards-card', 'Example Rewards card', 'credit_card', 'example-cards', { last4: '1005' }),
    acct('easy-access', 'Example Savings easy access', 'savings', 'example-savings', { last4: '7733', interestRate: 4.1 }),
    acct('premium-bonds', 'Premium Bonds', 'premium_bonds', 'ns-and-i'),
    acct('stocks-isa', 'Example Invest Stocks & Shares ISA', 'stocks_isa', 'example-invest'),
    acct('lifetime-isa', 'Example Lifetime ISA', 'lisa', 'example-app'),
    acct('workplace-pension', 'Acme Analytics workplace pension', 'workplace_pension', 'example-pensions', { pension: { employer: 'Acme Analytics Ltd', method: 'salary_sacrifice' } }),
    acct('sipp', 'Example Pensions SIPP', 'sipp', 'example-pensions', { pension: { method: 'relief_at_source' } }),
    acct('state-pension', 'State Pension forecast', 'state_pension', 'dwp'),
    acct('student-loan', 'Student loan (Plan 2)', 'student_loan', 'slc'),
  ]);

  // ── Everyday banking ──
  const months: string[] = [];
  for (let m = START; m <= END; m = addMonths(m, 1)) months.push(m);
  const groceries = ['TESCO STORES 3297 LONDON', "SAINSBURY'S S/MKT LONDON", 'ALDI 84 LONDON', 'WAITROSE 721 LONDON', 'LIDL GB LONDON', 'M&S SIMPLY FOOD LONDON'];
  const coffee = ['PRET A MANGER LONDON', 'COSTA COFFEE 43012', 'CAFFE NERO LONDON', 'GREGGS 1234 LONDON'];
  const takeaway = ['DELIVEROO LONDON', 'UBER *EATS HELP.UBER.COM', 'JUST EAT.CO.UK LTD'];
  const eatingOut = ['NANDOS CLAPHAM', 'WAGAMAMA SOHO', 'DISHOOM KINGS CROSS', 'FRANCO MANCA BRIXTON', 'PIZZA EXPRESS 551'];
  const shopping = ['AMAZON.CO.UK*AB12CD34E', 'AMZNMKTPLACE AMAZON.CO.UK', 'UNIQLO REGENT ST', 'JOHN LEWIS 012', 'ARGOS LTD', 'IKEA WEMBLEY', 'BOOTS 1142 LONDON'];
  let savingsBal = 43_500;
  // Premium Bonds at the £50,000 limit all along: prizes are paid out to the bank.
  const pbBal = 50_000;
  for (const m of months) {
    const mEnd = endOfMonth(m);
    const salaryDay = addDays(mEnd, -3);
    const salary = m >= '2026-04-01' ? 5_061.56 : m >= '2025-04-01' ? 4_973.81 : 4_964.81;
    tx('current-account', salaryDay, salary, 'ACME ANALYTICS LTD SALARY', { payee: 'Acme Analytics Ltd' });
    tx('current-account', `${m.slice(0, 7)}-01`, -1_800, 'OPENRENT LTD RENT REF FLAT 4B');
    if (Number(m.slice(5, 7)) <= 10 && Number(m.slice(5, 7)) >= 1) tx('current-account', `${m.slice(0, 7)}-02`, m.startsWith('2026') ? -205 : -193, 'LB LAMBETH COUNCIL TAX');
    const winter = [1, 2, 3, 11, 12].includes(Number(m.slice(5, 7)));
    tx('current-account', `${m.slice(0, 7)}-05`, winter ? -between(138, 168) : -between(68, 90), 'OCTOPUS ENERGY LIMITED');
    tx('current-account', `${m.slice(0, 7)}-06`, -44.8, 'THAMES WATER UTILITIES');
    tx('current-account', `${m.slice(0, 7)}-08`, -45, 'HYPEROPTIC LTD');
    tx('current-account', `${m.slice(0, 7)}-09`, -18, 'GIFFGAFF.COM');
    tx('current-account', `${m.slice(0, 7)}-11`, m >= '2026-02-01' ? -12.99 : -10.99, 'NETFLIX.COM');
    tx('current-account', `${m.slice(0, 7)}-12`, -11.99, 'SPOTIFY P1A2B3C4D5');
    tx('current-account', `${m.slice(0, 7)}-14`, -45, 'PUREGYM LTD');
    tx('current-account', `${m.slice(0, 7)}-15`, -2.99, 'APPLE.COM/BILL ITUNES.COM');
    if (m.slice(5, 7) === '03') tx('current-account', `${m.slice(0, 7)}-20`, -174.5, 'TV LICENCE MBP');
    if (m.slice(5, 7) === '11') tx('current-account', `${m.slice(0, 7)}-20`, -95, 'AMAZON PRIME*RT4Y3Q2');
    // Transfers out to savings and investments, the day after payday.
    const after = addDays(salaryDay, 1);
    tx('current-account', after, -300, 'EXAMPLE SAVINGS TRANSFER');
    tx('easy-access', addDays(after, 1), 300, 'DEPOSIT FROM EXAMPLE BANK');
    savingsBal += 300;
    tx('current-account', after, -800, 'EXAMPLE INVEST DD');
    tx('current-account', after, -333.33, 'EXAMPLE APP LISA SAVING');
    // The card's direct debit (settles last month's spend).
    tx('current-account', `${m.slice(0, 7)}-18`, -between(600, 1_050), 'EXAMPLE CARDS DD');
    // Interest.
    const interest = roundMoney((savingsBal * 0.041) / 12);
    tx('easy-access', mEnd, interest, 'INTEREST PAID');
    savingsBal += interest;
    // Premium Bonds: up to three prizes a month, paid to the bank in one payment.
    let prizes = 0;
    for (let n = Math.floor(rand() * 4); n > 0; n--) prizes += pick([25, 25, 25, 25, 50, 50, 100]);
    if (prizes) tx('current-account', addDays(`${m.slice(0, 7)}-01`, 3), prizes, 'NS&I PREMIUM BOND PRIZE');
    // Day-to-day.
    for (let d = m; d <= mEnd && d <= END; d = addDays(d, 1)) {
      const wd = weekday(d);
      if (wd >= 1 && wd <= 5 && chance(0.75)) tx('current-account', d, -2.8, 'TFL TRAVEL CH TFL.GOV.UK/CP', { time: '08:1' + Math.floor(rand() * 10) });
      if (wd >= 1 && wd <= 5 && chance(0.45)) tx('current-account', d, -between(2.9, 4.8), pick(coffee), { time: `0${7 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` });
      if (chance(0.22)) tx('current-account', d, -between(20, 95), pick(groceries), { time: `${12 + Math.floor(rand() * 8)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` });
      if ((wd === 5 || wd === 6) && chance(0.4)) tx('current-account', d, -between(20, 42), pick(takeaway), { time: `${19 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` });
      if ((wd === 0 || wd === 6) && chance(0.3)) tx('rewards-card', d, -between(38, 130), pick(eatingOut));
      if (chance(0.12)) tx('rewards-card', d, -between(12, 190), pick(shopping));
      if ((wd === 5 || wd === 6) && chance(0.35)) tx('current-account', d, -between(6, 28), pick(['WETHERSPOON THE CROWN', 'BREWDOG CLAPHAM', 'THE FALCON PUB']), { time: '21:0' + Math.floor(rand() * 10) });
      if (chance(0.03)) tx('current-account', d, -pick([20, 40, 50]), 'CASH WITHDRAWAL LINK ATM');
      if (chance(0.02)) tx('rewards-card', d, -between(45, 160), pick(['TRAINLINE.COM', 'LNER', 'AVANTI WEST COAST']));
    }
    if (chance(0.3)) tx('rewards-card', addDays(m, 10), -between(10, 80), 'JUSTGIVING DONATION');
    if (['2025-07', '2026-06', '2025-02'].includes(m.slice(0, 7))) {
      tx('rewards-card', addDays(m, 4), -between(260, 600), pick(['EASYJET 0012345', 'BRITISH AIRWAYS 125', 'RYANAIR']));
      tx('rewards-card', addDays(m, 6), -between(520, 1_300), pick(['BOOKING.COM HOTEL', 'AIRBNB * HM12345']));
    }
    if (chance(0.15)) tx('rewards-card', addDays(m, 20), between(15, 80), 'AMAZON.CO.UK REFUND');
  }
  // The card: the monthly direct debit arrives on it.
  for (const t of txs.filter((x) => x.accountId === 'current-account' && x.description === 'EXAMPLE CARDS DD')) tx('rewards-card', t.date, -t.amount, 'PAYMENT RECEIVED - THANK YOU');

  // ── Balances for ledger accounts (statement closing balances) ──
  const snapshots: BalanceSnapshot[] = [];
  const runLedger = (accountId: string, opening: number) => {
    let bal = opening;
    const list = txs.filter((t) => t.accountId === accountId).sort((a, b) => (a.date < b.date ? -1 : 1));
    let i = 0;
    for (const m of months) {
      const mEnd = endOfMonth(m) > END ? END : endOfMonth(m);
      while (i < list.length && list[i]!.date <= mEnd) bal = roundMoney(bal + list[i++]!.amount);
      if (mEnd < END || accountId === 'current-account') {
        snapshots.push({ id: balanceId(accountId, mEnd, bal, 'statement'), accountId, date: mEnd, balance: bal, currency: 'GBP', kind: 'statement', dateSource: 'document', source: {}, createdAt: stamp });
      }
    }
  };
  runLedger('current-account', 12_000);
  runLedger('rewards-card', -905.6);
  runLedger('easy-access', 43_500);
  snapshots.push({ id: balanceId('premium-bonds', END, pbBal, 'screenshot'), accountId: 'premium-bonds', date: addDays(END, -12), balance: roundMoney(pbBal), currency: 'GBP', kind: 'screenshot', dateSource: 'exif', source: {}, createdAt: stamp });
  snapshots.push({ id: balanceId('premium-bonds', START, 50_000, 'manual'), accountId: 'premium-bonds', date: START, balance: 50_000, currency: 'GBP', kind: 'manual', source: {}, createdAt: stamp });

  // ── Investments & pensions (valuations with market noise) ──
  const holdings: HoldingsSnapshot[] = [];
  const market = (accountId: string, start: number, monthly: (m: string, i: number) => { own: number; employer?: number; relief?: number; bonus?: number }, every = 1, drift = 0.006, vol = 0.028) => {
    let value = start;
    let paidIn = start;
    let bonus = 0;
    months.forEach((m, i) => {
      const flows = monthly(m, i);
      const payDay = addDays(endOfMonth(m), -2);
      if (flows.own) tx(accountId, payDay, flows.own, 'Regular contribution', { category: 'contribution', categorisedBy: 'builtin' });
      if (flows.employer) tx(accountId, payDay, flows.employer, 'Employer contribution', { category: 'employer-contribution', categorisedBy: 'builtin' });
      if (flows.relief) tx(accountId, addDays(payDay, 40), flows.relief, 'Tax relief received from HMRC', { category: 'tax-relief', categorisedBy: 'builtin' });
      if (flows.bonus) tx(accountId, addDays(payDay, 25), flows.bonus, 'Government bonus', { category: 'government-bonus', categorisedBy: 'builtin' });
      const inflow = (flows.own ?? 0) + (flows.employer ?? 0) + (flows.relief ?? 0) + (flows.bonus ?? 0);
      value = (value + inflow) * (1 + drift + vol * gauss());
      paidIn += (flows.own ?? 0) + (flows.employer ?? 0) + (flows.relief ?? 0);
      bonus += flows.bonus ?? 0;
      const date = endOfMonth(m) > END ? addDays(END, -2) : endOfMonth(m);
      if (i % every === 0 || i === months.length - 1) {
        snapshots.push({
          id: balanceId(accountId, date, roundMoney(value), 'screenshot'),
          accountId,
          date,
          balance: roundMoney(value),
          currency: 'GBP',
          kind: 'screenshot',
          contributions: roundMoney(paidIn),
          dateSource: 'exif',
          source: {},
          createdAt: stamp,
          ...(accountId === 'lifetime-isa' ? { bonusToDate: roundMoney(bonus) } : {}),
        });
      }
    });
    return roundMoney(value);
  };
  const isaValue = market('stocks-isa', 87_000, () => ({ own: 800 }));
  const lisaValue = market('lifetime-isa', 46_000, () => ({ own: 333.33, bonus: 83.33 }), 1, 0.005, 0.022);
  // Acme's whole contribution: the salary sacrificed and its own 6%.
  market('workplace-pension', 154_000, (m) => ({ own: 0, employer: m >= '2026-04-01' ? 2_075 : 1_800 }), 1, 0.0055, 0.025);
  market('sipp', 38_500, (m) => (['03', '09'].includes(m.slice(5, 7)) ? { own: 2_000, relief: 500 } : { own: 0 }), 3);
  // The LISA screenshot shows the allowance used this tax year.
  const lisaLast = snapshots.filter((s) => s.accountId === 'lifetime-isa').at(-1)!;
  lisaLast.taxYearContributions = roundMoney(333.33 * 6);
  lisaLast.taxYear = '2026/27';
  holdings.push({
    id: holdingsId('stocks-isa', addDays(END, -2), isaValue),
    accountId: 'stocks-isa',
    date: addDays(END, -2),
    holdings: [
      { name: 'Vanguard FTSE Global All Cap Index Fund Acc', isin: 'GB00BD3RZ582', units: roundMoney((isaValue * 0.72) / 271.9), price: 271.9, value: roundMoney(isaValue * 0.72), currency: 'GBP', assetClass: 'equity' },
      { name: 'Vanguard LifeStrategy 80% Equity Fund Acc', isin: 'GB00B4PQW151', units: roundMoney((isaValue * 0.2) / 312.4), price: 312.4, value: roundMoney(isaValue * 0.2), currency: 'GBP', assetClass: 'mixed' },
      { name: 'Vanguard U.K. Government Bond Index Fund Acc', isin: 'IE00B1S74Q32', units: roundMoney((isaValue * 0.07) / 158.2), price: 158.2, value: roundMoney(isaValue * 0.07), currency: 'GBP', assetClass: 'bond' },
    ],
    cash: roundMoney(isaValue * 0.01),
    totalValue: isaValue,
    source: {},
    createdAt: stamp,
  });
  holdings.push({
    id: holdingsId('lifetime-isa', addDays(END, -2), lisaValue),
    accountId: 'lifetime-isa',
    date: addDays(END, -2),
    holdings: [{ name: 'Fidelity Index World Fund P Acc', isin: 'GB00BJS8SJ34', value: roundMoney(lisaValue * 0.99), currency: 'GBP', assetClass: 'equity' }],
    cash: roundMoney(lisaValue * 0.01),
    totalValue: lisaValue,
    source: {},
    createdAt: stamp,
  });
  snapshots.push({ id: balanceId('state-pension', '2026-01-15', 0, 'manual'), accountId: 'state-pension', date: '2026-01-15', balance: 0, currency: 'GBP', kind: 'manual', annualIncome: 11_502.8, source: {}, createdAt: stamp });
  snapshots.push({ id: balanceId('student-loan', '2026-04-05', -42_180.55, 'statement'), accountId: 'student-loan', date: '2026-04-05', balance: -42_180.55, currency: 'GBP', kind: 'statement', source: {}, createdAt: stamp });

  await store.addTransactions(txs, 'demo: transactions');
  await store.addBalances(snapshots, 'demo: balances');
  await store.addHoldings(holdings, 'demo: holdings');
  const fig = (kind: Figure['kind'], label: string, amount: number, payer: string, extra: Partial<Figure> = {}): Figure => ({
    id: figureId(kind, amount, '2025/26', payer, label),
    kind,
    label,
    amount,
    currency: 'GBP',
    taxYear: '2025/26',
    payer,
    source: {},
    createdAt: stamp,
    ...extra,
  });
  await store.addFigures(
    [
      fig('gross_pay', 'Pay', 95_000.04, 'Acme Analytics Ltd', { payerReference: '123/AB456' }),
      fig('tax_deducted', 'Tax', 25_428.4, 'Acme Analytics Ltd'),
      fig('national_insurance', "Employee's contributions", 3_909.96, 'Acme Analytics Ltd'),
      fig('student_loan_deducted', 'Student loan deductions', 5_976, 'Acme Analytics Ltd'),
      // The savings account's interest certificate: what it paid in 2025/26.
      fig('interest_paid', 'Gross interest paid', roundMoney(txs.filter((t) => t.accountId === 'easy-access' && t.description === 'INTEREST PAID' && t.date >= '2025-04-06' && t.date <= '2026-04-05').reduce((sum, t) => sum + t.amount, 0)), 'Example Savings', { accountId: 'easy-access' }),
    ],
    'demo: figures',
  );
  const res = await enrich(store);
  console.log(`demo: ${txs.length} transactions, ${snapshots.length} balances; enrich: ${res.recategorised} categorised, ${res.transfersLinked} transfers linked`);
  await demoIntelligence(store);

  // A pending import to review: this month's export from the bank, in Monzo's CSV layout, overlapping
  // what is already stored.
  const config = loadConfig({ ...process.env, FINANCE_DATA_DIR: DIR, FINANCE_WORK_DIR: WORK, FINANCE_WATCH: '0' });
  const svc = new ImportService(store, config, new WorkArea(WORK));
  await svc.init();
  const recent = txs.filter((t) => t.accountId === 'current-account' && t.date >= addDays(END, -12)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const lines = ['Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In'];
  recent.forEach((t, i) => {
    const d = `${t.date.slice(8, 10)}/${t.date.slice(5, 7)}/${t.date.slice(0, 4)}`;
    lines.push([`tx_demo${i}`, d, t.time ?? '12:00:00', 'Card payment', '', '', '', t.amount.toFixed(2), 'GBP', t.amount.toFixed(2), 'GBP', '', '', '', t.description, '', t.amount < 0 ? t.amount.toFixed(2) : '', t.amount > 0 ? t.amount.toFixed(2) : ''].join(','));
  });
  lines.push(['tx_demo_new1', `${END.slice(8, 10)}/${END.slice(5, 7)}/${END.slice(0, 4)}`, '13:05:00', 'Card payment', 'Dishoom', '', 'Eating out', '-58.40', 'GBP', '-58.40', 'GBP', '', '', '', 'DISHOOM SHOREDITCH', '', '-58.40', ''].join(','));
  await mkdir(WORK, { recursive: true });
  const file = path.join(WORK, 'bank-export.csv');
  await writeFile(file, lines.join('\n'));
  const { record } = await svc.create({ fileName: 'Example-Bank-export-last-2-weeks.csv', bytes: Buffer.from(lines.join('\n')), origin: 'upload', hintAccountId: 'current-account' });
  for (let i = 0; i < 50 && svc.getPending(record!.id)?.status !== 'review'; i++) await new Promise((r) => setTimeout(r, 100));
  await rm(file, { force: true });
  console.log(`demo: pending import ${record?.id} (${svc.getPending(record!.id)?.status})`);
  store.stopWatching();
}

/**
 * Synthetic research, assumptions, insights and context, so every page shows its researched and
 * inferred parts. Everything here is made up and labelled as demo; the figures are illustrative.
 */
async function demoIntelligence(store: Store) {
  const demo = { setBy: 'agent' as const, model: 'demo', promptVersion: 'demo', session: 'demo-data' };
  const src = (title: string) => [{ title: `${title} (demo, synthetic)`, url: 'https://example.com/demo-research', publisher: 'Demo' }];
  const asOf = addDays(END, -28);
  const funds = [
    { id: 'vanguard-ftse-global-all-cap', name: 'Vanguard FTSE Global All Cap Index Fund Acc', isin: 'GB00BD3RZ582', ocf: 0.0023, allocation: { equity: 1 } },
    { id: 'vanguard-lifestrategy-80', name: 'Vanguard LifeStrategy 80% Equity Fund Acc', isin: 'GB00B4PQW151', ocf: 0.002, allocation: { equity: 0.8, bond: 0.2 } },
    { id: 'vanguard-uk-gov-bond', name: 'Vanguard U.K. Government Bond Index Fund Acc', isin: 'IE00B1S74Q32', ocf: 0.0012, allocation: { bond: 1 } },
    { id: 'fidelity-index-world', name: 'Fidelity Index World Fund P Acc', isin: 'GB00BJS8SJ34', ocf: 0.0012, allocation: { equity: 1 } },
  ];
  const cpi = { kind: 'economy.indicator' as const, subject: { topic: 'cpi' }, asOf, sources: src('Inflation target'), confidence: 'high' as const, data: { indicator: 'cpi' as const, basis: 'target' as const, value: 0.02, period: 'long run', publisher: 'Demo central bank' } };
  const eqOutlook = { kind: 'market.outlook' as const, subject: { assetClass: 'equity' as const }, asOf, sources: src('10-year outlook'), confidence: 'medium' as const, data: { assetClass: 'equity' as const, publisher: 'Demo asset manager', horizonYears: 10, currency: 'GBP', expectedReturnNominal: 0.062, range: { low: 0.04, high: 0.085 }, volatility: 0.16 } };
  const bondOutlook = { kind: 'market.outlook' as const, subject: { assetClass: 'bond' as const }, asOf, sources: src('10-year outlook'), confidence: 'medium' as const, data: { assetClass: 'bond' as const, publisher: 'Demo asset manager', horizonYears: 10, currency: 'GBP', expectedReturnNominal: 0.043, range: { low: 0.03, high: 0.055 }, volatility: 0.07 } };
  await applyRecords(store, {
    provenance: demo,
    supersede: false,
    records: [
      ...funds.map((f) => ({ type: 'instrument' as const, record: { id: f.id, name: f.name, isin: f.isin, type: 'fund' as const, aliases: [] } })),
      ...funds.map((f) => ({ type: 'research' as const, record: { kind: 'instrument.facts' as const, subject: { instrumentId: f.id }, asOf, sources: src('Factsheet'), confidence: 'medium' as const, data: { ocf: f.ocf, allocation: f.allocation } } })),
      { type: 'research', record: { kind: 'instrument.performance', subject: { instrumentId: 'vanguard-lifestrategy-80' }, asOf, sources: src('Performance'), confidence: 'medium', data: { currency: 'GBP', periodEnd: asOf, returns: { y1: 0.074, y3: 0.058, y5: 0.061 }, calendarYears: [], volatility: { y5: 0.097 } } } },
      { type: 'research', record: { kind: 'provider.fees', subject: { institutionId: 'example-invest' }, asOf, sources: src('Charges'), confidence: 'medium', data: { tiers: [{ rate: 0.0025 }], capGbpPerYear: 300 } } },
      { type: 'research', record: { kind: 'provider.rates', subject: { institutionId: 'example-savings' }, asOf, sources: src('Savings rates'), confidence: 'medium', data: { products: [{ name: 'Easy Access', accountType: 'savings', aer: 0.041, variable: true }] } } },
      { type: 'research', record: cpi },
      { type: 'research', record: eqOutlook },
      { type: 'research', record: bondOutlook },
      { type: 'assumption', record: { key: 'inflation', scope: { kind: 'global' }, value: 0.022, range: { low: 0.015, high: 0.035 }, asOf, source: 'Demo research', evidence: [], basedOn: [researchIdOf(cpi)], rationale: 'The 2% target with a small premium for recent overshoots (demo).', status: 'active' } },
      { type: 'assumption', record: { key: 'return.expected', scope: { kind: 'assetClass', assetClass: 'equity' }, value: 0.062, range: { low: 0.04, high: 0.085 }, asOf, source: 'Demo research', evidence: [], basedOn: [researchIdOf(eqOutlook)], rationale: 'Published 10-year outlooks for global shares in GBP (demo).', status: 'active' } },
      { type: 'assumption', record: { key: 'return.expected', scope: { kind: 'assetClass', assetClass: 'bond' }, value: 0.043, range: { low: 0.03, high: 0.055 }, asOf, source: 'Demo research', evidence: [], basedOn: [researchIdOf(bondOutlook)], rationale: 'Current gilt yields plus a small term premium (demo).', status: 'active' } },
    ],
  });
  await setOwnerAssumption(store, { key: 'withdrawal.rate', scope: { kind: 'global' }, value: 0.0325, range: { low: 0.025, high: 0.04 }, rationale: 'I would rather plan cautiously (demo).' });
  const ctx = await applyRecords(store, {
    provenance: { setBy: 'owner' },
    supersede: false,
    records: [
      { type: 'context', record: { kind: 'plan', statement: 'You plan to buy a home in 2028 for about £450,000, using your Lifetime ISA for the deposit.', detail: { event: 'buy-home', amount: 450_000, date: '2028-06-30', accountIds: ['lifetime-isa', 'easy-access'] }, status: 'active', origin: { kind: 'form' } } },
      { type: 'context', record: { kind: 'goal', statement: 'You want an emergency fund of six months’ spending.', detail: {}, status: 'active', origin: { kind: 'form' } } },
    ],
  });
  // Insights citing real demo records.
  const all = store.transactions();
  const month = addMonths(END, -1).slice(0, 7);
  const takeaways = all.filter((t) => t.category === 'takeaway' && t.date.startsWith(month));
  const netflix = all.filter((t) => t.description === 'NETFLIX.COM').slice(-3);
  const planId = ctx.written.find((w) => w.type === 'context')!.id;
  const lsFacts = store.research.find((r) => r.kind === 'instrument.facts' && r.subject.instrumentId === 'vanguard-lifestrategy-80')!;
  await applyRecords(store, {
    provenance: demo,
    supersede: false,
    records: [
      {
        type: 'insight',
        record: {
          kind: 'month-review',
          pages: ['overview'],
          subject: { month },
          title: `${month}: a steady month (demo)`,
          body: 'Spending was close to your recent average and you saved about a third of your income. The ISA and pensions grew with markets; the estate rose by a little over 1% (synthetic demo insight).',
          evidence: [{ type: 'computed', metric: 'months.net', label: 'saved this month' }],
          confidence: 'medium',
        },
      },
      ...(takeaways.length ? [{ type: 'insight' as const, record: { kind: 'habit' as const, pages: ['spending' as const], subject: { category: 'takeaway', month }, title: 'Takeaways are creeping up (demo)', body: `${takeaways.length} takeaways last month, mostly on Fridays. At this pace that is several hundred pounds a year (synthetic demo insight).`, evidence: [{ type: 'transactions' as const, ids: takeaways.map((t) => t.id).slice(0, 20), label: `${takeaways.length} takeaways` }], confidence: 'medium' as const } }] : []),
      ...(netflix.length ? [{ type: 'insight' as const, record: { kind: 'subscription' as const, pages: ['spending' as const, 'overview' as const], subject: {}, title: 'Netflix went up this year (demo)', body: 'Your plan rose from £10.99 to £12.99 a month. Worth checking you still use it enough (synthetic demo insight).', evidence: [{ type: 'transactions' as const, ids: netflix.map((t) => t.id), label: 'recent payments' }], confidence: 'high' as const } }] : []),
      { type: 'insight', record: { kind: 'allowance', pages: ['tax'], subject: { taxYear: '2026/27' }, title: 'Room left in your ISA this year (demo)', body: 'Much of this year’s ISA allowance is still unused. Your regular payments will use about three quarters of it by April (synthetic demo insight).', evidence: [{ type: 'account', id: 'stocks-isa', label: 'Example Invest ISA' }], confidence: 'medium' } },
      { type: 'insight', record: { kind: 'fund', pages: ['investments'], subject: { instrumentId: 'vanguard-lifestrategy-80' }, title: 'A low-cost multi-asset fund (demo)', body: 'LifeStrategy 80’s charge is well below the typical UK multi-asset fund; its 20% in bonds makes it less volatile than your all-share funds (synthetic demo insight).', evidence: [{ type: 'research', id: lsFacts.id, label: 'fund research' }], confidence: 'medium' } },
      { type: 'insight', record: { kind: 'projection', pages: ['projections'], subject: {}, title: 'The 2028 deposit looks on track (demo)', body: 'At the recent pace, the LISA and savings together reach a 30% deposit on a £450,000 home by mid-2028, with the bonus included (synthetic demo insight).', evidence: [{ type: 'context', id: planId, label: 'your plan' }, { type: 'account', id: 'lifetime-isa', label: 'LISA' }], confidence: 'low' } },
    ],
  });
  const stampNote = nowISO();
  await store.upsertRecords('notes', [{ id: 'note_00000000000000d1', text: 'We are buying a flat in 2028 and I want six months of spending as an emergency fund (demo).', status: 'applied', proposals: [], createdAt: stampNote, updatedAt: stampNote }], 'demo: note');
}

await main();
