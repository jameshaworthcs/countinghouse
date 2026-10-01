// The evaluation set: synthetic documents of the kinds the owner will import, each with the result
// the app should produce. Documents and expected results come from the same data, so they cannot
// drift apart. Everything here is invented: names, numbers and references.

import type { AccountType, FigureKind, TermsRateApplies } from '../src/shared/schema';
import { appActivityHtml, appHoldingHtml, appListHtml, appOverviewHtml, appTabbedHtml, dayName, fmtDate, gbp, simpleDocHtml, statementHtml, type AppRow, type Brand, type StatementSection } from './render';

export interface ExpectedTx {
  date: string;
  amount: number;
  description: string;
  pending?: boolean;
  balanceAfter?: number;
  original?: { amount: number; currency: string };
  /** Already in the store from an earlier document in the group. */
  duplicate?: boolean;
}

export interface ExpectedSection {
  /** The account in the eval store the rows belong to, or a new account of this type. */
  account: string | { new: AccountType; last4?: string };
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: number;
  balance?: number;
  balanceDate?: string;
  contributions?: number;
  bonusToDate?: number;
  taxYearContributions?: number;
  cash?: number;
  /** Totals of money in and out printed on the statement. */
  statedTotals?: { moneyIn: number; moneyOut: number };
  transactions?: ExpectedTx[];
  /** The holdings shown; an empty list means the document shows none, so any read is extra. */
  holdings?: { name: string; isin?: string; units?: number; value: number }[];
  /** Nothing on the document is the account's value: none may be recorded. */
  noValue?: boolean;
  /** Its terms: its limit, every rate it prints and a card's minimum payment (scored when reading everything). */
  terms?: { limit?: number; rates: { applies: TermsRateApplies; rate: number; until?: string }[]; minimumPayment?: number; paymentDue?: string };
}

/** A payslip read in full (scored when reading everything, `--everything`). */
export interface ExpectedPayslip {
  payDate: string;
  net: number;
  taxCode: string;
  niLetter: string;
  periodNumber?: number;
  payments: { label: string; amount: number }[];
  deductions: { label: string; amount: number }[];
  yearToDate: Partial<Record<'gross' | 'taxable' | 'tax' | 'ni' | 'niEmployer' | 'pension' | 'pensionEmployer' | 'studentLoan', number>>;
  employerCosts?: { ni?: number; pension?: number };
}

export interface Expected {
  sections: ExpectedSection[];
  figures?: { kind: FigureKind; amount: number; taxYear?: string }[];
  /** Payslips in full, and other values it prints as label and value (scored when reading everything). */
  payslips?: ExpectedPayslip[];
  printed?: { label: RegExp; value: RegExp }[];
  /** Understood, but adds nothing another import or the stored data does not already have. */
  nothingNew?: boolean;
  /** Claims the document does not make (where money went, say): a note stating one loses a point. */
  unsupported?: RegExp;
}

export interface EvalCase {
  id: string;
  title: string;
  tags: string[];
  file: { name: string; kind: 'pdf' | 'png' | 'csv'; html?: string; text?: string };
  expected: Expected;
  /** Cases in a group share one store and run in order; each is committed before the next. */
  group?: string;
  /** The group's files are uploaded together, as one batch from a phone, and none is committed. */
  together?: boolean;
  /** The account the owner uploaded it for ("Upload for this account"). */
  hintAccountId?: string;
}

/** The owner's accounts in every eval store: what drafts are matched against. */
export const EVAL_ACCOUNTS: { id: string; name: string; type: AccountType; institutionId: string; last4?: string }[] = [
  { id: 'monzo-current', name: 'Monzo Current Account', type: 'current', institutionId: 'monzo', last4: '4821' },
  { id: 'barclays-current', name: 'Barclays Bank Account', type: 'current', institutionId: 'barclays', last4: '7302' },
  { id: 'hsbc-current', name: 'HSBC Advance', type: 'current', institutionId: 'hsbc', last4: '1188' },
  { id: 'lloyds-current', name: 'Lloyds Classic', type: 'current', institutionId: 'lloyds', last4: '6034' },
  { id: 'nationwide-flex', name: 'Nationwide FlexAccount', type: 'current', institutionId: 'nationwide', last4: '5540' },
  { id: 'nationwide-saver', name: 'Nationwide Flex Instant Saver', type: 'savings', institutionId: 'nationwide', last4: '9021' },
  { id: 'revolut-current', name: 'Revolut', type: 'current', institutionId: 'revolut' },
  { id: 'starling-current', name: 'Starling Personal', type: 'current', institutionId: 'starling', last4: '2291' },
  { id: 'amex-gold', name: 'Amex Gold', type: 'credit_card', institutionId: 'amex', last4: '1005' },
  { id: 'barclaycard', name: 'Barclaycard Rewards', type: 'credit_card', institutionId: 'barclaycard', last4: '6621' },
  { id: 'marcus-savings', name: 'Marcus Online Savings', type: 'savings', institutionId: 'marcus', last4: '7733' },
  { id: 'vanguard-isa', name: 'Vanguard Stocks & Shares ISA', type: 'stocks_isa', institutionId: 'vanguard' },
  { id: 'moneybox-lisa', name: 'Moneybox Lifetime ISA', type: 'lisa', institutionId: 'moneybox' },
  { id: 'aviva-pension', name: 'Aviva Workplace Pension', type: 'workplace_pension', institutionId: 'aviva', last4: '5521' },
  { id: 'nest-pension', name: 'Nest', type: 'workplace_pension', institutionId: 'nest' },
  { id: 'ajbell-sipp', name: 'AJ Bell SIPP', type: 'sipp', institutionId: 'aj-bell', last4: '8830' },
  { id: 'premium-bonds', name: 'Premium Bonds', type: 'premium_bonds', institutionId: 'ns-and-i' },
];

// ─── Data helpers ────────────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pence = (v: number) => Math.round(v * 100);
const pounds = (p: number) => p / 100;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

interface Spend {
  name: string;
  /** How each bank prints it. */
  statement: string;
  min: number;
  max: number;
}
const SHOPS: Spend[] = [
  { name: 'Tesco', statement: 'TESCO STORES 3297', min: 14, max: 86 },
  { name: 'Sainsbury’s', statement: "SAINSBURY'S S/MKT", min: 9, max: 64 },
  { name: 'Pret A Manger', statement: 'PRET A MANGER', min: 3.2, max: 8.9 },
  { name: 'Costa Coffee', statement: 'COSTA COFFEE 43012', min: 2.9, max: 6.4 },
  { name: 'TfL', statement: 'TFL TRAVEL CH', min: 2.8, max: 2.8 },
  { name: 'Amazon', statement: 'AMAZON.CO.UK*HX4TY2', min: 7.99, max: 64.99 },
  { name: 'Deliveroo', statement: 'DELIVEROO', min: 17.5, max: 36.4 },
  { name: 'Boots', statement: 'BOOTS 1142', min: 4.5, max: 28 },
  { name: 'Shell', statement: 'SHELL CLAPHAM', min: 42, max: 71 },
  { name: 'Greggs', statement: 'GREGGS 1234', min: 2.1, max: 6.8 },
  { name: 'Nando’s', statement: 'NANDOS BRIXTON', min: 18, max: 46 },
  { name: 'Waitrose', statement: 'WAITROSE 721', min: 12, max: 74 },
];
const pickFrom = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
const amountIn = (r: () => number, s: Spend) => pounds(pence(s.min + r() * (s.max - s.min)));

interface Tx {
  date: string;
  amount: number;
  /** Text as the bank prints it. */
  text: string;
  /** Name in an app feed. */
  name: string;
  type?: string;
  detail?: string;
  pending?: boolean;
  original?: { amount: number; currency: string };
}

/** A month of current-account life: pay, rent, bills, and everyday spending. */
function currentAccountRows(seed: number, from: string, to: string, style: 'barclays' | 'hsbc' | 'lloyds' | 'nationwide' | 'plain', opts: { perDay?: number } = {}): Tx[] {
  const r = rng(seed);
  const out: Tx[] = [];
  const fixed: { day: number; amount: number; name: string; text: Record<string, string>; type: Record<string, string> }[] = [
    { day: 1, amount: -1450, name: 'Rent', text: { barclays: 'Standing Order to J Patel Ref: Flat 4B Rent', hsbc: 'J PATEL FLAT 4B RENT', lloyds: 'J PATEL FLAT4B RENT', nationwide: 'Standing order J PATEL', plain: 'RENT J PATEL' }, type: { hsbc: 'SO', lloyds: 'SO' } },
    { day: 2, amount: -175, name: 'Lambeth Council', text: { barclays: 'Direct Debit to LB Lambeth Ref: 30114728', hsbc: 'LB LAMBETH CTAX', lloyds: 'LB LAMBETH CTAX', nationwide: 'Direct debit LB LAMBETH', plain: 'LB LAMBETH' }, type: { hsbc: 'DD', lloyds: 'DD' } },
    { day: 5, amount: -72.4, name: 'Octopus Energy', text: { barclays: 'Direct Debit to Octopus Energy Ref: A-12B34C56', hsbc: 'OCTOPUS ENERGY', lloyds: 'OCTOPUS ENERGY LTD', nationwide: 'Direct debit OCTOPUS ENERGY', plain: 'OCTOPUS ENERGY' }, type: { hsbc: 'DD', lloyds: 'DD' } },
    { day: 11, amount: -12.99, name: 'Netflix', text: { barclays: 'Card Payment to Netflix.com', hsbc: 'NETFLIX.COM', lloyds: 'NETFLIX.COM CD 6034', nationwide: 'Visa purchase NETFLIX.COM', plain: 'NETFLIX.COM' }, type: { hsbc: 'VIS', lloyds: 'DEB' } },
    { day: 14, amount: -45, name: 'PureGym', text: { barclays: 'Direct Debit to Puregym Ltd', hsbc: 'PUREGYM LTD', lloyds: 'PUREGYM LTD', nationwide: 'Direct debit PUREGYM LTD', plain: 'PUREGYM' }, type: { hsbc: 'DD', lloyds: 'DD' } },
    { day: 26, amount: 4898.42, name: 'Acme Analytics Ltd', text: { barclays: 'Received From Acme Analytics Ltd Ref: Salary', hsbc: 'ACME ANALYTICS LTD SALARY', lloyds: 'ACME ANALYTICS LTD', nationwide: 'Bank credit ACME ANALYTICS LTD', plain: 'ACME ANALYTICS LTD' }, type: { hsbc: 'CR', lloyds: 'BGC' } },
    { day: 27, amount: -300, name: 'Marcus', text: { barclays: 'Bill Payment to Marcus Savings Ref: Savings', hsbc: 'MARCUS SAVINGS', lloyds: 'MARCUS SAVINGS', nationwide: 'Transfer to MARCUS SAVINGS', plain: 'MARCUS SAVINGS' }, type: { hsbc: 'BP', lloyds: 'FPO' } },
  ];
  for (const d of days(from, to)) {
    const dom = Number(d.slice(8));
    for (const f of fixed) if (f.day === dom) out.push({ date: d, amount: f.amount, text: f.text[style]!, name: f.name, ...(f.type[style] ? { type: f.type[style] } : {}) });
    const n = Math.floor(r() * (opts.perDay ?? 1.6) + 0.3);
    for (let i = 0; i < n; i++) {
      const s = pickFrom(r, SHOPS);
      const amt = -amountIn(r, s);
      const text =
        style === 'barclays' ? `Card Payment to ${s.statement} On ${fmtDate(d, 'd-mon')}` : style === 'hsbc' ? `${s.statement} LONDON` : style === 'lloyds' ? `${s.statement} CD 6034` : style === 'nationwide' ? `Contactless Payment ${s.statement}` : s.statement;
      out.push({ date: d, amount: amt, text, name: s.name, ...(style === 'hsbc' ? { type: s.name === 'TfL' || s.min < 9 ? ')))' : 'VIS' } : style === 'lloyds' ? { type: 'DEB' } : {}) });
    }
    if (r() < 0.04) out.push({ date: d, amount: pounds(pence(12 + r() * 40)), text: style === 'barclays' ? 'Card Refund From Amazon.co.uk' : 'AMAZON.CO.UK REFUND', name: 'Amazon refund', ...(style === 'hsbc' ? { type: 'CR' } : style === 'lloyds' ? { type: 'CR' } : {}) });
  }
  return out;
}

/** Running balances, in integer pence. */
function withBalances<T extends { amount: number }>(opening: number, rows: T[]): (T & { balanceAfter: number })[] {
  let bal = pence(opening);
  return rows.map((t) => {
    bal += pence(t.amount);
    return { ...t, balanceAfter: pounds(bal) };
  });
}
const sum = (opening: number, rows: { amount: number }[]) => pounds(rows.reduce((s, t) => s + pence(t.amount), pence(opening)));
const totals = (rows: { amount: number }[]) => ({ moneyIn: pounds(rows.reduce((s, t) => s + Math.max(0, pence(t.amount)), 0)), moneyOut: pounds(rows.reduce((s, t) => s + Math.max(0, -pence(t.amount)), 0)) });
const exp = (rows: (Tx & { balanceAfter?: number })[], opts: { balances?: 'every' | 'end-of-day' | 'none'; description?: (t: Tx) => string } = {}): ExpectedTx[] =>
  rows.map((t, i) => {
    const endOfDay = i === rows.length - 1 || rows[i + 1]!.date !== t.date;
    const withBal = opts.balances === 'every' || (opts.balances === 'end-of-day' && endOfDay);
    return {
      date: t.date,
      amount: t.amount,
      description: opts.description ? opts.description(t) : t.text,
      ...(t.pending ? { pending: true } : {}),
      ...(withBal && t.balanceAfter !== undefined ? { balanceAfter: t.balanceAfter } : {}),
      ...(t.original ? { original: t.original } : {}),
    };
  });

const CUSTOMER = 'Mx Alex Taylor<br>Flat 4B, 22 Acre Lane<br>London SW2 5SG';
const brand = (name: string, color: string, address: string): Brand => ({ name, color, address });

// ─── The cases ───────────────────────────────────────────────────────────────────────────────────

export function buildCases(): EvalCase[] {
  const cases: EvalCase[] = [];

  // ── CSV exports (parsed locally) ──
  // Monzo: a payment abroad and a refund; the start of the Monzo group.
  const monzoRows: Tx[] = currentAccountRows(11, '2026-09-01', '2026-09-25', 'plain', { perDay: 1.2 });
  monzoRows.push({ date: '2026-09-18', amount: -38.92, text: 'CAFE DE FLORE PARIS FRA', name: 'Café de Flore', original: { amount: -45, currency: 'EUR' } });
  monzoRows.push({ date: '2026-09-19', amount: 12, text: 'AMAZON.CO.UK REFUND', name: 'Amazon' });
  monzoRows.sort((a, b) => a.date.localeCompare(b.date));
  {
    const rows = monzoRows;
    const head = 'Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In';
    const lines = rows.map((t, i) =>
      [`tx_0000${String(i).padStart(4, '0')}`, fmtDate(t.date, 'dd/mm/yyyy'), '12:00:00', t.amount > 0 && t.name !== 'Amazon' ? 'Faster payment' : 'Card payment', t.name.replace(/,/g, ''), '', '', t.amount.toFixed(2), 'GBP', (t.original?.amount ?? t.amount).toFixed(2), t.original?.currency ?? 'GBP', '', '', '', t.text, '', t.amount < 0 ? t.amount.toFixed(2) : '', t.amount > 0 ? t.amount.toFixed(2) : ''].join(','),
    );
    cases.push({ id: 'csv-monzo-fx-refund', title: 'Monzo CSV: a payment in euros and a refund', tags: ['csv', 'fx', 'refund'], group: 'monzo', file: { name: 'Monzo Transactions Export.csv', kind: 'csv', text: [head, ...lines].join('\n') }, expected: { sections: [{ account: 'monzo-current', transactions: exp(rows) }] } });
  }
  {
    // Amex CSV: charges are positive in the file, credits negative.
    const r = rng(12);
    const rows: Tx[] = [];
    for (const d of days('2026-08-12', '2026-09-11')) if (r() < 0.45) {
      const s = pickFrom(r, SHOPS);
      rows.push({ date: d, amount: -amountIn(r, s), text: `${s.statement}`, name: s.name });
    }
    rows.push({ date: '2026-08-28', amount: 540.12, text: 'PAYMENT RECEIVED - THANK YOU', name: 'Payment' });
    rows.push({ date: '2026-09-03', amount: 23.99, text: 'AMAZON.CO.UK REFUND', name: 'Amazon' });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const head = 'Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,Town/City,Postcode,Country,Reference,Category';
    const lines = rows.map((t, i) => [fmtDate(t.date, 'dd/mm/yyyy'), t.text, (-t.amount).toFixed(2), '', `${t.text} LONDON`, '', 'LONDON', '', 'UNITED KINGDOM', `'AT2624${String(i).padStart(6, '0')}'`, ''].join(','));
    cases.push({ id: 'csv-amex-signs', title: 'Amex CSV: card signs inverted in the file', tags: ['csv', 'card-signs', 'refund'], file: { name: 'activity.csv', kind: 'csv', text: [head, ...lines].join('\n') }, expected: { sections: [{ account: 'amex-gold', transactions: exp(rows) }] } });
  }
  {
    // Revolut: completed rows count; pending and reverted ones are left out by the parser.
    const rows: Tx[] = [
      { date: '2026-09-02', amount: -10.84, text: 'Café de Flore', name: 'Café de Flore' },
      { date: '2026-09-02', amount: -3.2, text: 'Boulangerie Paul', name: 'Boulangerie Paul' },
      { date: '2026-09-04', amount: 250, text: 'Payment from Alex Taylor', name: 'Top up' },
      { date: '2026-09-06', amount: -61.5, text: 'Eurostar', name: 'Eurostar' },
      { date: '2026-09-09', amount: -14.99, text: 'Uber', name: 'Uber' },
    ];
    let bal = 412.77;
    const lines = ['Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'];
    for (const t of rows) {
      bal = pounds(pence(bal) + pence(t.amount));
      lines.push([t.amount > 0 ? 'TOPUP' : 'CARD_PAYMENT', 'Current', `${t.date} 10:00:00`, `${t.date} 18:00:00`, t.text, t.amount.toFixed(2), '0.00', 'GBP', 'COMPLETED', bal.toFixed(2)].join(','));
    }
    lines.push(['CARD_PAYMENT', 'Current', '2026-09-10 09:00:00', '', 'Pret A Manger', '-4.20', '0.00', 'GBP', 'PENDING', ''].join(','));
    lines.push(['CARD_PAYMENT', 'Current', '2026-09-08 09:00:00', '2026-09-08 09:05:00', 'Hotel Lutetia', '-120.00', '0.00', 'GBP', 'REVERTED', ''].join(','));
    cases.push({ id: 'csv-revolut-pending', title: 'Revolut CSV: pending and reverted rows are left out', tags: ['csv', 'pending'], file: { name: 'account-statement_2026-09-01_2026-09-10_en-gb_4f2a1c.csv', kind: 'csv', text: lines.join('\n') }, expected: { sections: [{ account: 'revolut-current', transactions: exp(rows) }] } });
  }

  // ── Lloyds: a statement, then an export overlapping it ──
  {
    const opening = 842.15;
    const rows = withBalances(opening, currentAccountRows(21, '2026-08-15', '2026-09-14', 'lloyds'));
    const closing = sum(opening, rows);
    const section: StatementSection = {
      title: 'Classic Account',
      accountLine: 'Sort code 30-94-57 · Account number ****6034',
      period: ['2026-08-15', '2026-09-14'],
      opening,
      closing,
      rows: rows.map((t) => ({ date: t.date, description: t.text, type: t.type ?? '', amount: t.amount, balanceAfter: t.balanceAfter })),
      columns: 'out-in',
      showTypeColumn: true,
      dateStyle: 'dd/mm/yyyy',
      balances: 'every',
      summary: [['Money in', gbp(totals(rows).moneyIn)], ['Money out', gbp(totals(rows).moneyOut)]],
    };
    cases.push({
      id: 'pdf-lloyds-statement',
      title: 'Lloyds PDF statement with a type column (first of an overlapping pair)',
      tags: ['pdf', 'statement', 'overlap'],
      group: 'lloyds',
      file: { name: 'Statement_2026_09.pdf', kind: 'pdf', html: statementHtml(brand('Lloyds-style Bank', '#006a4d', 'PO Box 1000, Andover BX1 1LT'), 'Your statement', CUSTOMER, [section]) },
      expected: { sections: [{ account: 'lloyds-current', periodStart: '2026-08-15', periodEnd: '2026-09-14', openingBalance: opening, balance: closing, balanceDate: '2026-09-14', statedTotals: totals(rows), transactions: exp(rows, { balances: 'every' }) }] },
    });
    // The export a fortnight later overlaps the statement's last two weeks.
    const later = withBalances(closing, currentAccountRows(22, '2026-09-15', '2026-09-27', 'lloyds'));
    const overlap = rows.filter((t) => t.date >= '2026-09-01');
    const csvRows = [...overlap, ...later];
    const lines = ['Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance'];
    for (const t of [...csvRows].reverse()) lines.push([fmtDate(t.date, 'dd/mm/yyyy'), t.type ?? 'DEB', "'12-34-56", '12346034', t.text, t.amount < 0 ? (-t.amount).toFixed(2) : '', t.amount > 0 ? t.amount.toFixed(2) : '', t.balanceAfter.toFixed(2)].join(','));
    cases.push({
      id: 'csv-lloyds-overlap',
      title: 'Lloyds CSV overlapping the statement already imported: the overlap is recognised',
      tags: ['csv', 'overlap'],
      group: 'lloyds',
      file: { name: '12346034_20260928_0915.csv', kind: 'csv', text: lines.join('\n') },
      expected: { sections: [{ account: 'lloyds-current', transactions: [...exp(overlap, { balances: 'every' }).map((t) => ({ ...t, duplicate: true })), ...exp(later, { balances: 'every' })] }] },
    });
  }

  // ── PDF statements ──
  {
    const opening = 1234.56;
    const rows = withBalances(opening, currentAccountRows(31, '2026-08-01', '2026-08-31', 'barclays', { perDay: 0.9 }));
    const closing = sum(opening, rows);
    cases.push({
      id: 'pdf-barclays-current',
      title: 'Barclays-style statement: paid out / paid in columns, balance on every row',
      tags: ['pdf', 'statement'],
      file: { name: 'Statement 31-Aug-26 AC 20-45-77 ****7302.pdf', kind: 'pdf', html: statementHtml(brand('Barclays-style Bank', '#00aeef', 'Leicester LE87 2BB'), 'Your Barclays-style Bank Account statement', CUSTOMER, [{ title: 'Bank Account', accountLine: 'Sort code 20-45-77 · Account no. ****7302', period: ['2026-08-01', '2026-08-31'], opening, closing, rows: rows.map((t) => ({ date: t.date, description: t.text, amount: t.amount, balanceAfter: t.balanceAfter })), columns: 'out-in', dateStyle: 'd-mon', balances: 'every', summary: [['Start balance', gbp(opening)], ['End balance', gbp(closing)]] }]) },
      expected: { sections: [{ account: 'barclays-current', periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalance: opening, balance: closing, balanceDate: '2026-08-31', transactions: exp(rows, { balances: 'every' }) }] },
    });
  }
  {
    // HSBC: three pages, the date only on each day's first row, the balance at each day's end,
    // and "balance brought/carried forward" at every page break.
    const opening = 2310.4;
    const rows = withBalances(opening, currentAccountRows(41, '2026-07-19', '2026-08-18', 'hsbc', { perDay: 2.9 }));
    const closing = sum(opening, rows);
    cases.push({
      id: 'pdf-hsbc-long',
      title: 'HSBC-style statement: 3 pages, dates once per day, end-of-day balances, brought forward lines',
      tags: ['pdf', 'statement', 'multi-page'],
      file: { name: '2026-08-18_Statement.pdf', kind: 'pdf', html: statementHtml(brand('HSBC-style UK', '#db0011', 'HSBC-style UK Bank plc, 1 Centenary Square, Birmingham B1 1HQ'), 'Your Statement', CUSTOMER, [{ title: 'HSBC-style Advance', accountLine: 'Sort Code 40-11-62 · Account Number ****1188', period: ['2026-07-19', '2026-08-18'], opening, closing, rows: rows.map((t) => ({ date: t.date, description: t.text, type: t.type ?? '', amount: t.amount, balanceAfter: t.balanceAfter })), columns: 'out-in', showTypeColumn: true, dateStyle: 'd-mon-yy', dateOncePerDay: true, balances: 'end-of-day', broughtForward: true, rowsPerPage: 38, summary: [['Opening balance', gbp(opening)], ['Payments in', gbp(totals(rows).moneyIn)], ['Payments out', gbp(totals(rows).moneyOut)], ['Closing balance', gbp(closing)]] }], 'Payment types: VIS Visa, ))) Contactless, DD Direct Debit, SO Standing Order, BP Bill Payment, CR Credit.') },
      expected: { sections: [{ account: 'hsbc-current', periodStart: '2026-07-19', periodEnd: '2026-08-18', openingBalance: opening, balance: closing, balanceDate: '2026-08-18', statedTotals: totals(rows), transactions: exp(rows, { balances: 'end-of-day' }) }] },
    });
  }
  {
    // Nationwide: two accounts in one PDF, with a transfer between them.
    const flexOpen = 1502.33;
    const flexRows = withBalances(flexOpen, [...currentAccountRows(51, '2026-08-01', '2026-08-31', 'nationwide', { perDay: 0.7 }), { date: '2026-08-28', amount: -500, text: 'Transfer to FLEX INSTANT SAVER 9021', name: 'Saver' }].sort((a, b) => a.date.localeCompare(b.date)));
    const flexClose = sum(flexOpen, flexRows);
    const saverOpen = 7950;
    const saverRows = withBalances(saverOpen, [{ date: '2026-08-28', amount: 500, text: 'Transfer from FLEXACCOUNT 5540', name: 'Transfer' }, { date: '2026-08-31', amount: 16.87, text: 'Interest', name: 'Interest' }] as Tx[]);
    const saverClose = sum(saverOpen, saverRows);
    const sect = (title: string, line: string, open: number, close: number, rows: typeof flexRows): StatementSection => ({ title, accountLine: line, period: ['2026-08-01', '2026-08-31'], opening: open, closing: close, rows: rows.map((t) => ({ date: t.date, description: t.text, amount: t.amount, balanceAfter: t.balanceAfter })), columns: 'out-in', dateStyle: 'd-mon', balances: 'every' });
    cases.push({
      id: 'pdf-nationwide-multi',
      title: 'Nationwide-style combined statement: two accounts in one PDF',
      tags: ['pdf', 'statement', 'multi-account'],
      file: { name: 'Nationwide statement August 2026.pdf', kind: 'pdf', html: statementHtml(brand('Nationwide-style Building Society', '#1a2b6d', 'Nationwide House, Pipers Way, Swindon SN38 1NW'), 'Your statement for August 2026', CUSTOMER, [sect('FlexAccount', 'Sort code 07-04-36 · Account ****5540', flexOpen, flexClose, flexRows), sect('Flex Instant Saver', 'Sort code 07-04-36 · Account ****9021 · 4.10% AER variable', saverOpen, saverClose, saverRows)]) },
      expected: {
        sections: [
          { account: 'nationwide-flex', periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalance: flexOpen, balance: flexClose, transactions: exp(flexRows, { balances: 'every' }) },
          { account: 'nationwide-saver', periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalance: saverOpen, balance: saverClose, transactions: exp(saverRows, { balances: 'every' }) },
        ],
      },
    });
  }
  {
    // Amex: amounts printed without signs, credits marked CR; spending abroad with the rate and a
    // separate non-sterling fee; the balance owed printed as a positive "new balance".
    const r = rng(61);
    const rows: Tx[] = [];
    for (const d of days('2026-08-12', '2026-09-11')) if (r() < 0.5) {
      const s = pickFrom(r, SHOPS);
      rows.push({ date: d, amount: -amountIn(r, s), text: `${s.statement} LONDON`, name: s.name });
    }
    rows.push({ date: '2026-08-21', amount: -38.92, text: 'LE COMPTOIR PARIS', name: 'Le Comptoir', detail: '45.00 EUR  Rate 1.1562', original: { amount: -45, currency: 'EUR' } });
    rows.push({ date: '2026-08-21', amount: -1.07, text: 'NON-STERLING TRANSACTION FEE', name: 'Fee' });
    rows.push({ date: '2026-08-26', amount: 612.4, text: 'PAYMENT RECEIVED - THANK YOU', name: 'Payment' });
    rows.push({ date: '2026-09-02', amount: 29.99, text: 'ASOS.COM REFUND', name: 'ASOS' });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const previous = -612.4;
    const closing = sum(previous, rows);
    cases.push({
      id: 'pdf-amex-card',
      title: 'Amex-style card statement: unsigned amounts with CR credits, spending in euros, a fee',
      tags: ['pdf', 'card-signs', 'fx', 'refund'],
      file: { name: 'Statement_Sep 2026.pdf', kind: 'pdf', html: statementHtml(brand('American Express-style', '#016fd0', 'Amex-style Services Europe, Brighton BN88 1AH'), 'Gold Card statement', CUSTOMER, [{ title: 'Gold Card', accountLine: 'Card number ending 1005 · Credit limit £9,000.00', period: ['2026-08-12', '2026-09-11'], closing, rows: rows.map((t) => ({ date: t.date, description: t.text, ...(t.detail ? { detail: t.detail } : {}), amount: t.amount })), columns: 'card-cr', dateStyle: 'd-mon', balances: 'none', closingLabel: 'New balance', summary: [['Previous balance', gbp(-previous)], ['New balance', gbp(-closing)], ['Minimum payment', gbp(Math.round(-closing * 3) / 100)], ['Payment due', '6 October 2026']] }]) },
      expected: { sections: [{ account: 'amex-gold', periodStart: '2026-08-12', periodEnd: '2026-09-11', openingBalance: previous, balance: closing, transactions: exp(rows) }] },
    });
  }
  {
    // Barclaycard: spending printed positive, payments with a minus sign: the other convention.
    const r = rng(71);
    const rows: Tx[] = [];
    for (const d of days('2026-08-05', '2026-09-04')) if (r() < 0.4) {
      const s = pickFrom(r, SHOPS);
      rows.push({ date: d, amount: -amountIn(r, s), text: s.statement, name: s.name });
    }
    rows.push({ date: '2026-08-19', amount: 300, text: 'PAYMENT, THANK YOU', name: 'Payment' });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const previous = -287.2;
    const closing = sum(previous, rows);
    cases.push({
      id: 'pdf-barclaycard',
      title: 'Barclaycard-style statement: spending positive, payments negative in print',
      tags: ['pdf', 'card-signs'],
      file: { name: 'Barclaycard-statement-Sep-2026.pdf', kind: 'pdf', html: statementHtml(brand('Barclaycard-style', '#00395d', 'Barclaycard-style, Northampton NN4 7SG'), 'Your Barclaycard-style Rewards statement', CUSTOMER, [{ title: 'Rewards Visa', accountLine: 'Card ending 6621', period: ['2026-08-05', '2026-09-04'], closing, rows: rows.map((t) => ({ date: t.date, description: t.text, amount: t.amount })), columns: 'card-plus', dateStyle: 'dd/mm/yyyy', balances: 'none', closingLabel: 'Statement balance', summary: [['Previous balance', gbp(-previous)], ['Statement balance', gbp(-closing)], ['Credit limit', '£4,500.00'], ['Minimum payment', '£25.00 by 29/09/2026'], ['Standard purchase rate', '24.9% a year, variable (simple)'], ['Cash rate', '27.9% a year, variable (simple)'], ['Promotional balance transfer rate', '0% until 15/03/2027']] }]) },
      expected: {
        sections: [
          {
            account: 'barclaycard',
            periodStart: '2026-08-05',
            periodEnd: '2026-09-04',
            openingBalance: previous,
            balance: closing,
            transactions: exp(rows),
            terms: { limit: 4500, minimumPayment: 25, paymentDue: '2026-09-29', rates: [{ applies: 'purchases', rate: 24.9 }, { applies: 'cash', rate: 27.9 }, { applies: 'balance-transfers', rate: 0, until: '2027-03-15' }] },
          },
        ],
      },
    });
  }
  {
    const opening = 14027.52;
    const rows = withBalances(opening, [
      { date: '2026-06-28', amount: 300, text: 'Deposit from Barclays 7302', name: 'Deposit' },
      { date: '2026-06-30', amount: 47.11, text: 'Interest paid', name: 'Interest' },
      { date: '2026-07-28', amount: 300, text: 'Deposit from Barclays 7302', name: 'Deposit' },
      { date: '2026-07-31', amount: 48.7, text: 'Interest paid', name: 'Interest' },
      { date: '2026-08-12', amount: -1200, text: 'Withdrawal to Barclays 7302', name: 'Withdrawal' },
      { date: '2026-08-28', amount: 300, text: 'Deposit from Barclays 7302', name: 'Deposit' },
      { date: '2026-08-31', amount: 46.02, text: 'Interest paid', name: 'Interest' },
    ] as Tx[]);
    const closing = sum(opening, rows);
    cases.push({
      id: 'pdf-marcus-savings',
      title: 'Savings statement for a quarter: deposits, a withdrawal and monthly interest',
      tags: ['pdf', 'savings'],
      file: { name: 'Marcus_Statement_Q2.pdf', kind: 'pdf', html: statementHtml(brand('Marcus-style Savings', '#2b2b2b', 'Marcus-style, PO Box 12345, Leeds LS1 1AA'), 'Online Savings Account: quarterly statement', CUSTOMER, [{ title: 'Online Savings Account', accountLine: 'Account ending 7733 · 4.10% AER (variable)', period: ['2026-06-01', '2026-08-31'], opening, closing, rows: rows.map((t) => ({ date: t.date, description: t.text, amount: t.amount, balanceAfter: t.balanceAfter })), columns: 'out-in', dateStyle: 'dd/mm/yyyy', balances: 'every' }]) },
      expected: { sections: [{ account: 'marcus-savings', periodStart: '2026-06-01', periodEnd: '2026-08-31', openingBalance: opening, balance: closing, transactions: exp(rows, { balances: 'every' }), terms: { rates: [{ applies: 'interest', rate: 4.1 }] } }] },
    });
  }
  {
    // An account the owner has not set up yet: overdrawn part of the month.
    const opening = 211.4;
    const rows = withBalances(opening, currentAccountRows(81, '2026-08-01', '2026-08-31', 'plain', { perDay: 0.6 }).map((t) => (t.name === 'Acme Analytics Ltd' ? { ...t, amount: 1650, text: 'ACME ANALYTICS LTD WAGES' } : t)));
    const closing = sum(opening, rows);
    cases.push({
      id: 'pdf-santander-new-overdrawn',
      title: 'A statement for an account not set up yet, going overdrawn (OD balances)',
      tags: ['pdf', 'statement', 'new-account', 'overdraft'],
      file: { name: 'Santander-style statement 31 Aug 2026.pdf', kind: 'pdf', html: statementHtml(brand('Santander-style', '#ec0000', 'Santander-style UK plc, Bootle L30 4GB'), 'Everyday Current Account statement', CUSTOMER, [{ title: 'Everyday Current Account', accountLine: 'Sort code 09-01-28 · Account number ****3399', period: ['2026-08-01', '2026-08-31'], opening, closing, rows: rows.map((t) => ({ date: t.date, description: t.text, amount: t.amount, balanceAfter: t.balanceAfter })), columns: 'out-in', dateStyle: 'dd/mm/yyyy', balances: 'every' }]) },
      expected: { sections: [{ account: { new: 'current', last4: '3399' }, periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalance: opening, balance: closing, transactions: exp(rows, { balances: 'every' }) }] },
    });
  }

  // ── Investment and pension documents ──
  {
    const funds = [
      { name: 'Aviva-style Pension BlackRock 30:70 Currency Hedged Global Equity Index', units: 18422.114, price: 1.8911 },
      { name: 'Aviva-style Pension My Future Growth', units: 6031.557, price: 1.2044 },
    ].map((f) => ({ ...f, value: pounds(pence(f.units * f.price)) }));
    const total = pounds(funds.reduce((s, f) => s + pence(f.value), 0));
    // The year's summary adds up: start + contributions + growth − charges = end.
    const start = pounds(pence(total) - 840_000 - 238_052 + 17_477);
    cases.push({
      id: 'pdf-aviva-pension-annual',
      title: 'Workplace pension annual statement: value, contributions for the tax year, funds',
      tags: ['pdf', 'pension', 'holdings', 'figures'],
      file: {
        name: 'Annual_Pension_Statement_2026.pdf',
        kind: 'pdf',
        html: simpleDocHtml(brand('Aviva-style Life & Pensions', '#004f9f', 'PO Box 520, Norwich NR1 3WG'), 'Your annual pension statement', [
          { rows: [['Plan', 'Acme Analytics Ltd Group Personal Pension'], ['Plan number', '****5521'], ['Statement period', '6 April 2025 to 5 April 2026']] },
          { heading: 'Your plan value', rows: [['Value on 6 April 2025', gbp(start)], ['Contributions paid in the year', '£8,400.00'], ['Investment growth', '£2,380.52'], ['Charges', '-£174.77'], ['Value on 5 April 2026', gbp(total)]] },
          { heading: 'Contributions in the tax year 2025/26', rows: [['Your contributions (by salary sacrifice, paid by your employer)', '£3,900.00'], ['Your employer’s contributions', '£4,500.00'], ['Total', '£8,400.00']] },
          { heading: 'Your funds on 5 April 2026', table: { head: ['Fund', 'Units', 'Unit price', 'Value'], rows: funds.map((f) => [f.name, f.units.toLocaleString('en-GB', { minimumFractionDigits: 3 }), `£${f.price.toFixed(4)}`, gbp(f.value)]), numeric: [1, 2, 3] } },
          { text: 'Your selected retirement age is 67. This statement does not take account of inflation.' },
        ]),
      },
      expected: {
        sections: [{ account: 'aviva-pension', balance: total, balanceDate: '2026-04-05', holdings: funds.map((f) => ({ name: f.name, units: f.units, value: f.value })) }],
        // Salary sacrifice is an employer contribution for tax, whatever the statement calls it.
        figures: [
          { kind: 'pension_contribution_employer', amount: 4500, taxYear: '2025/26' },
          { kind: 'pension_contribution_employer', amount: 3900, taxYear: '2025/26' },
        ],
      },
    });
  }
  {
    const holdings = [
      { name: 'Vanguard FTSE Global All Cap Index Fund Accumulation', isin: 'GB00BD3RZ582', units: 61.2044, price: 271.93 },
      { name: 'Vanguard FTSE All-World UCITS ETF (VWRP)', isin: 'IE00BK5BQT80', units: 58, price: 121.46 },
      { name: 'Royal London Short Term Money Market Fund Y Acc', isin: 'GB00B8XYYQ86', units: 1203.51, price: 1.1452 },
    ].map((h) => ({ ...h, value: pounds(pence(h.units * h.price)) }));
    const cash = 412.08;
    const total = pounds(holdings.reduce((s, h) => s + pence(h.value), pence(cash)));
    cases.push({
      id: 'pdf-ajbell-sipp',
      title: 'SIPP valuation: funds with ISINs, an ETF, cash, and contributions this tax year',
      tags: ['pdf', 'pension', 'holdings'],
      file: {
        name: 'SIPP valuation 26-09-2026.pdf',
        kind: 'pdf',
        html: simpleDocHtml(brand('AJ Bell-style Investcentre', '#e5004b', '4 Exchange Quay, Salford Quays M5 3EE'), 'SIPP valuation as at 26 September 2026', [
          { rows: [['Account', 'Self-Invested Personal Pension ****8830'], ['Total value', gbp(total)], ['Cash', gbp(cash)]] },
          { heading: 'Holdings', table: { head: ['Investment', 'ISIN', 'Units', 'Price (£)', 'Value (£)'], rows: holdings.map((h) => [h.name, h.isin, String(h.units), h.price.toFixed(4), h.value.toFixed(2)]), numeric: [2, 3, 4] } },
          { heading: 'This tax year (2026/27)', rows: [['Your contributions', '£4,000.00'], ['Basic-rate tax relief claimed', '£1,000.00'], ['Gross contributions this tax year', '£5,000.00']] },
        ]),
      },
      expected: {
        sections: [{ account: 'ajbell-sipp', balance: total, balanceDate: '2026-09-26', cash, taxYearContributions: 5000, holdings: holdings.map((h) => ({ name: h.name, isin: h.isin, units: h.units, value: h.value })) }],
        // The contributions stated for the tax year are figures too: what you paid, and the relief.
        figures: [
          { kind: 'pension_contribution_employee', amount: 4000, taxYear: '2026/27' },
          { kind: 'pension_tax_relief', amount: 1000, taxYear: '2026/27' },
        ],
      },
    });
  }
  {
    const rows: Tx[] = [
      { date: '2026-06-02', amount: 600, text: 'Direct debit contribution', name: 'Contribution' },
      { date: '2026-07-02', amount: 600, text: 'Direct debit contribution', name: 'Contribution' },
      { date: '2026-07-31', amount: -9.45, text: 'Account fee', name: 'Fee' },
      { date: '2026-08-03', amount: 600, text: 'Direct debit contribution', name: 'Contribution' },
    ];
    const holdings = [
      { name: 'FTSE Global All Cap Index Fund - Accumulation', isin: 'GB00BD3RZ582', units: 91.4411, price: 270.12 },
      { name: 'LifeStrategy 80% Equity Fund - Accumulation', isin: 'GB00B4PQW151', units: 12.7512, price: 312.31 },
    ].map((h) => ({ ...h, value: pounds(pence(h.units * h.price)) }));
    const total = pounds(holdings.reduce((s, h) => s + pence(h.value), 0));
    cases.push({
      id: 'pdf-vanguard-isa-quarter',
      title: 'Stocks & Shares ISA quarterly statement: contributions, a fee, holdings, subscriptions used',
      tags: ['pdf', 'isa', 'holdings'],
      file: {
        name: 'Vanguard-style ISA statement Q2 2026.pdf',
        kind: 'pdf',
        html: simpleDocHtml(brand('Vanguard-style Investor', '#96151d', 'PO Box 10315, Chelmsford CM99 2AT'), 'Stocks & Shares ISA: quarterly statement, 1 June 2026 to 31 August 2026', [
          { rows: [['Account', 'Stocks & Shares ISA'], ['Value on 31 August 2026', gbp(total)], ['ISA subscriptions this tax year', '£3,000.00 of £20,000.00']] },
          { heading: 'Cash transactions', table: { head: ['Date', 'Description', 'Amount (£)'], rows: rows.map((t) => [fmtDate(t.date, 'dd-mon-yyyy'), t.text, t.amount.toFixed(2)]), numeric: [2] } },
          { heading: 'Holdings on 31 August 2026', table: { head: ['Fund', 'ISIN', 'Units', 'Price', 'Value'], rows: holdings.map((h) => [h.name, h.isin, h.units.toFixed(4), `£${h.price.toFixed(2)}`, gbp(h.value)]), numeric: [2, 3, 4] } },
        ]),
      },
      expected: { sections: [{ account: 'vanguard-isa', balance: total, balanceDate: '2026-08-31', taxYearContributions: 3000, transactions: exp(rows), holdings: holdings.map((h) => ({ name: h.name, isin: h.isin, units: h.units, value: h.value })) }] },
    });
  }
  cases.push({
    id: 'pdf-p60',
    title: 'P60 for 2025/26: pay, tax, National Insurance and student loan',
    tags: ['pdf', 'figures', 'tax'],
    file: {
      name: 'P60 2025-26.pdf',
      kind: 'pdf',
      html: simpleDocHtml(brand('P60 End of Year Certificate', '#333333', 'Tax year to 5 April 2026'), 'P60 End of Year Certificate', [
        { rows: [['Employee', 'Alex Taylor'], ['National Insurance number', 'QQ ** ** ** C'], ['Tax code at 5 April', '1257L'], ['Tax year to', '5 April 2026']] },
        { heading: 'Pay and Income Tax details', table: { head: ['', 'Pay', 'Tax deducted'], rows: [['In this employment', '£69,120.00', '£15,137.60']], numeric: [1, 2] } },
        { heading: 'National Insurance contributions in this employment', table: { head: ['NIC letter', 'Earnings at LEL', 'Employee’s contributions due on all earnings above the PT'], rows: [['A', '£6,500.00', '£3,247.35']], numeric: [1, 2] } },
        { heading: 'Statutory payments and student loans', rows: [['Student loan deductions in this employment', '£3,070.80']] },
        { heading: 'Employer', rows: [['Employer’s name', 'Acme Analytics Ltd'], ['Employer PAYE reference', '123/AB456']] },
      ]),
    },
    expected: {
      sections: [],
      figures: [
        { kind: 'gross_pay', amount: 69120, taxYear: '2025/26' },
        { kind: 'tax_deducted', amount: 15137.6, taxYear: '2025/26' },
        { kind: 'national_insurance', amount: 3247.35, taxYear: '2025/26' },
        { kind: 'student_loan_deducted', amount: 3070.8, taxYear: '2025/26' },
      ],
      // Its NI table, which no figure holds.
      printed: [{ label: /earnings at (the )?LEL/i, value: /6,?500(\.00)?/ }],
    },
  });
  cases.push({
    id: 'png-payslip-scan',
    title: 'A scanned payslip in a layout read by no rule: every line, the totals, the codes and the year to date',
    tags: ['png', 'figures', 'payslip'],
    file: {
      name: 'payslip-august-2026.png',
      kind: 'png',
      html: simpleDocHtml(brand('Brightwater Analytics Ltd', '#2d5d7b', 'Payroll: Brightwater Analytics Ltd, 9 Quay Street, Bristol BS1 4DA'), 'Payslip', [
        { rows: [['Employee', 'Alex Taylor'], ['Payroll no.', '50021'], ['NI number', 'QQ ** ** ** C'], ['NI category', 'A'], ['Tax code', '1257L'], ['Pay date', '28/08/2026'], ['Tax period', 'Month 5'], ['Pay method', 'BACS']] },
        { heading: 'Payments', table: { head: ['Description', 'Units', 'Rate', 'Amount'], rows: [['Basic salary', '', '', '2,500.00'], ['Overtime', '6.00', '22.50', '135.00'], ['Bonus', '', '', '200.00']], numeric: [1, 2, 3] } },
        { heading: 'Deductions', table: { head: ['Description', 'Amount'], rows: [['PAYE tax', '398.40'], ['National Insurance', '140.72'], ['Pension (net pay)', '125.00'], ['Student loan (Plan 2)', '37.00'], ['Cycle to work', '41.67']], numeric: [1] } },
        { heading: 'This period', rows: [['Total payments', '£2,835.00'], ['Total deductions', '£742.79'], ['Net pay', '£2,092.21'], ['Employer NI', '£337.86'], ['Employer pension', '£75.00']] },
        { heading: 'Year to date', rows: [['Taxable pay', '£13,050.00'], ['Tax', '£1,992.00'], ['Employee NI', '£703.60'], ['Employer NI', '£1,689.30'], ['Pension (you)', '£625.00'], ['Pension (employer)', '£375.00'], ['Student loan', '£185.00']] },
      ]),
    },
    expected: {
      sections: [],
      figures: [
        { kind: 'gross_pay', amount: 2835, taxYear: '2026/27' },
        { kind: 'tax_deducted', amount: 398.4, taxYear: '2026/27' },
        { kind: 'national_insurance', amount: 140.72, taxYear: '2026/27' },
        { kind: 'pension_contribution_employee', amount: 125, taxYear: '2026/27' },
        { kind: 'student_loan_deducted', amount: 37, taxYear: '2026/27' },
      ],
      payslips: [
        {
          payDate: '2026-08-28',
          net: 2092.21,
          taxCode: '1257L',
          niLetter: 'A',
          periodNumber: 5,
          payments: [
            { label: 'Basic salary', amount: 2500 },
            { label: 'Overtime', amount: 135 },
            { label: 'Bonus', amount: 200 },
          ],
          deductions: [
            { label: 'PAYE tax', amount: 398.4 },
            { label: 'National Insurance', amount: 140.72 },
            { label: 'Pension (net pay)', amount: 125 },
            { label: 'Student loan (Plan 2)', amount: 37 },
            { label: 'Cycle to work', amount: 41.67 },
          ],
          yearToDate: { taxable: 13050, tax: 1992, ni: 703.6, niEmployer: 1689.3, pension: 625, pensionEmployer: 375, studentLoan: 185 },
          employerCosts: { ni: 337.86, pension: 75 },
        },
      ],
    },
  });
  cases.push({
    id: 'pdf-interest-certificate',
    title: 'Annual interest certificate for a savings account',
    tags: ['pdf', 'figures', 'tax'],
    file: {
      name: 'Tax certificate 2025-26.pdf',
      kind: 'pdf',
      html: simpleDocHtml(brand('Marcus-style Savings', '#2b2b2b', 'PO Box 12345, Leeds LS1 1AA'), 'Certificate of interest paid: 6 April 2025 to 5 April 2026', [
        { rows: [['Account', 'Online Savings Account ending 7733'], ['Gross interest paid', '£512.34'], ['Tax deducted', '£0.00'], ['Net interest paid', '£512.34']] },
        { text: 'Interest is paid without tax taken off. You may need to tell HMRC about it if it is more than your Personal Savings Allowance.' },
      ]),
    },
    expected: { sections: [], figures: [{ kind: 'interest_paid', amount: 512.34, taxYear: '2025/26' }] },
  });

  // ── Phone screenshots ──
  /** A feed grouped by day: "Today" and "Yesterday" relative to the capture day, unless `relative` is off. */
  const feed = (rows: Tx[], money: (t: Tx) => string, sub: (t: Tx) => string | undefined, today: string, relative = true): { day: string; rows: AppRow[] }[] => {
    const groups: { day: string; rows: AppRow[] }[] = [];
    for (const t of [...rows].sort((a, b) => b.date.localeCompare(a.date))) {
      const label = relative && t.date === today ? 'Today' : relative && t.date === addDays(today, -1) ? 'Yesterday' : `${dayName(t.date)} ${Number(t.date.slice(8))} ${fmtDate(t.date, 'd-month-yyyy').split(' ')[1]}`;
      let g = groups.at(-1);
      if (!g || g.day !== label) groups.push((g = { day: label, rows: [] }));
      g.rows.push({ name: t.name, sub: sub(t), amount: money(t), positive: t.amount > 0, pending: Boolean(t.pending) });
    }
    return groups;
  };
  const signed = (t: Tx) => (t.amount > 0 ? `+${gbp(t.amount)}` : gbp(t.amount, { sign: 'unicode' }));
  {
    // Monzo feed, captured on 29 Sep: today's rows pending; 22–25 Sep were in the CSV already. The
    // feed shows merchant names ("Tesco"), where the CSV had the bank's text ("TESCO STORES 3297").
    const inCsv = monzoRows.filter((t) => t.date >= '2026-09-25');
    const newer: Tx[] = currentAccountRows(91, '2026-09-26', '2026-09-29', 'plain', { perDay: 1.8 }).map((t) => (t.date === '2026-09-29' ? { ...t, pending: true } : t));
    const shown: Tx[] = [...inCsv, ...newer];
    const balance = 3041.7;
    cases.push({
      id: 'png-monzo-pending-overlap',
      title: 'Monzo-style feed screenshot: pending rows today, and days already imported from the CSV',
      tags: ['png', 'pending', 'overlap'],
      group: 'monzo',
      hintAccountId: 'monzo-current',
      file: { name: 'Screenshot 2026-09-29 at 12.41.07.png', kind: 'png', html: appListHtml({ accent: '#ff4f40', title: 'Personal account', balance: gbp(balance), balanceLabel: 'Balance', pills: ['Pots', 'Payments', 'Card'], groups: feed(shown, signed, (t) => (t.original ? `${t.original.currency === 'EUR' ? '€' : ''}${Math.abs(t.original.amount).toFixed(2)}` : undefined), '2026-09-29') }) },
      expected: { sections: [{ account: 'monzo-current', balance, transactions: [...exp(inCsv, { description: (t) => t.name }).map((t) => ({ ...t, duplicate: true })), ...exp(newer, { description: (t) => t.name })] }] },
    });
  }
  {
    // A long scrolling capture: three weeks of a busy feed, cut into overlapping tiles.
    const rows: Tx[] = currentAccountRows(101, '2026-08-25', '2026-09-14', 'plain', { perDay: 2.6 });
    const balance = 2210.18;
    cases.push({
      id: 'png-monzo-long-scroll',
      title: 'Long scrolling screenshot (about 60 rows): read once, no rows lost or repeated at the joins',
      tags: ['png', 'long-screenshot'],
      hintAccountId: 'monzo-current',
      file: { name: 'Screenshot 2026-09-14 at 21.03.55.png', kind: 'png', html: appListHtml({ accent: '#ff4f40', title: 'Personal account', balance: gbp(balance), balanceLabel: 'Balance', groups: feed(rows, signed, () => undefined, '2026-09-14') }) },
      expected: { sections: [{ account: 'monzo-current', balance, transactions: exp(rows, { description: (t) => t.name }) }] },
    });
  }
  {
    // Amex app: purchases without a sign, credits with a minus: the card's own convention.
    const r = rng(111);
    const rows: Tx[] = [];
    // One screen: a pending purchase and the last week or so.
    for (const d of days('2026-09-21', '2026-09-28')) if (r() < 0.6) {
      const s = pickFrom(r, SHOPS);
      rows.push({ date: d, amount: -amountIn(r, s), text: s.statement, name: s.name, ...(d >= '2026-09-27' ? { pending: true } : {}) });
    }
    rows.push({ date: '2026-09-22', amount: 18.5, text: 'Refund', name: 'Uniqlo refund' });
    const settled = rows.filter((t) => !t.pending);
    const balance = sum(-104.3, settled);
    cases.push({
      id: 'png-amex-app',
      title: 'Card app screenshot: pending section, purchases unsigned, credits with a minus',
      tags: ['png', 'card-signs', 'pending', 'refund'],
      file: {
        name: 'Screenshot 2026-09-28 at 18.22.10.png',
        kind: 'png',
        html: appListHtml({ accent: '#016fd0', title: 'Gold Card ••1005', balance: gbp(-balance), balanceLabel: 'Current balance', meta: 'Credit limit £9,000', groups: [{ day: 'Pending', rows: rows.filter((t) => t.pending).map((t) => ({ name: t.name, sub: fmtDate(t.date, 'd-mon'), amount: gbp(-t.amount) })) }, { day: 'Recent transactions', rows: [...settled].sort((a, b) => b.date.localeCompare(a.date)).map((t) => ({ name: t.name, sub: fmtDate(t.date, 'd-mon'), amount: t.amount > 0 ? `-${gbp(t.amount)}` : gbp(-t.amount), positive: t.amount > 0 })) }] }),
      },
      expected: { sections: [{ account: 'amex-gold', balance, transactions: exp(rows, { description: (t) => t.name }) }] },
    });
  }
  {
    const rows: Tx[] = [
      { date: '2026-09-24', amount: -10.84, text: 'Café de Flore', name: 'Café de Flore', original: { amount: -12.5, currency: 'EUR' } },
      { date: '2026-09-24', amount: -54.12, text: 'Hôtel du Nord', name: 'Hôtel du Nord', original: { amount: -62.4, currency: 'EUR' } },
      { date: '2026-09-25', amount: -3.47, text: 'RATP', name: 'RATP', original: { amount: -4, currency: 'EUR' } },
      { date: '2026-09-26', amount: 200, text: 'Top-up', name: 'Top-up by Apple Pay' },
      { date: '2026-09-27', amount: -21.5, text: 'Eurostar', name: 'Eurostar' },
    ];
    const balance = 318.44;
    cases.push({
      id: 'png-revolut-fx',
      title: 'Revolut-style screenshot: payments in euros shown with their sterling amounts',
      tags: ['png', 'fx'],
      file: { name: 'Screenshot_20260927-201544.png', kind: 'png', html: appListHtml({ accent: '#191c1f', title: 'Revolut · Main · GBP', balance: gbp(balance), balanceLabel: 'Personal', groups: feed(rows, signed, (t) => (t.original ? `€${Math.abs(t.original.amount).toFixed(2)}` : t.amount > 0 ? 'Top-up' : undefined), '2026-09-27') }) },
      expected: { sections: [{ account: 'revolut-current', balance, transactions: exp(rows, { description: (t) => t.name }) }] },
    });
  }
  {
    // Starling in dark mode: a refund, a pending row and an international payment. The file name
    // carries no date, so the feed's days are written out (a relative "Today" could not be dated).
    const rows: Tx[] = [
      { date: '2026-09-25', amount: -19.99, text: 'Amazon', name: 'Amazon' },
      { date: '2026-09-26', amount: 19.99, text: 'Amazon', name: 'Amazon refund' },
      { date: '2026-09-26', amount: -64.2, text: 'Booking.com', name: 'Booking.com', original: { amount: -74, currency: 'EUR' } },
      { date: '2026-09-27', amount: -8.4, text: 'Franco Manca', name: 'Franco Manca' },
      { date: '2026-09-28', amount: -2.8, text: 'TfL', name: 'TfL', pending: true },
    ];
    const balance = 1422.06;
    cases.push({
      id: 'png-starling-dark',
      title: 'Dark-mode banking screenshot: a refund, a pending row and a payment in euros',
      tags: ['png', 'refund', 'pending', 'fx'],
      file: { name: 'IMG_4471.PNG', kind: 'png', html: appListHtml({ accent: '#7433ff', dark: true, title: 'Starling · Personal ••2291', balance: gbp(balance), balanceLabel: 'Effective balance', groups: feed(rows, signed, (t) => (t.original ? `€${Math.abs(t.original.amount).toFixed(2)}` : undefined), '2026-09-28', false) }) },
      expected: { sections: [{ account: 'starling-current', balance, transactions: exp(rows, { description: (t) => t.name }) }] },
    });
  }
  cases.push({
    id: 'png-vanguard-isa',
    title: 'ISA app overview: value, total invested, return, allowance used, holdings',
    tags: ['png', 'isa', 'holdings'],
    file: {
      name: 'Screenshot 2026-09-26 at 08.15.44.png',
      kind: 'png',
      html: appOverviewHtml({
        accent: '#96151d',
        title: 'Vanguard-style Investor · Stocks & Shares ISA',
        value: '£34,003.51',
        valueLabel: 'Total value',
        stats: [['Total invested', '£31,100.00'], ['Return', '+£2,903.51 (9.3%)'], ['ISA allowance used 2026/27', '£3,600.00 of £20,000']],
        sections: [{ title: 'Holdings', rows: [{ name: 'FTSE Global All Cap Index Fund - Acc', sub: 'GB00BD3RZ582 · 72%', amount: '£24,482.53' }, { name: 'LifeStrategy 80% Equity Fund - Acc', sub: 'GB00B4PQW151 · 20%', amount: '£6,800.70' }, { name: 'U.K. Government Bond Index Fund - Acc', sub: 'IE00B1S74Q32 · 8%', amount: '£2,720.28' }] }],
      }),
    },
    expected: {
      sections: [
        {
          account: 'vanguard-isa',
          balance: 34003.51,
          balanceDate: '2026-09-26',
          contributions: 31100,
          taxYearContributions: 3600,
          holdings: [
            { name: 'FTSE Global All Cap Index Fund - Acc', isin: 'GB00BD3RZ582', value: 24482.53 },
            { name: 'LifeStrategy 80% Equity Fund - Acc', isin: 'GB00B4PQW151', value: 6800.7 },
            { name: 'U.K. Government Bond Index Fund - Acc', isin: 'IE00B1S74Q32', value: 2720.28 },
          ],
        },
      ],
    },
  });
  cases.push({
    id: 'png-moneybox-lisa',
    title: 'LISA app: balance, government bonus, paid in this tax year',
    tags: ['png', 'lisa'],
    file: {
      name: 'Screenshot 2026-09-27 at 10.02.31.png',
      kind: 'png',
      html: appOverviewHtml({
        accent: '#1f5eff',
        title: 'Moneybox-style · Lifetime ISA',
        value: '£20,300.85',
        valueLabel: 'Balance',
        stats: [['Total deposits', '£14,000.00'], ['Government bonus received', '£3,712.40'], ['Investment growth', '+£2,588.45']],
        progress: { label: 'This tax year', used: 2000, of: 4000, text: 'You’ve paid in £2,000.00 of your £4,000.00 allowance' },
        sections: [{ title: 'Your investments', rows: [{ name: 'Fidelity Index World Fund P Acc', sub: '100%', amount: '£20,300.85' }] }],
      }),
    },
    expected: { sections: [{ account: 'moneybox-lisa', balance: 20300.85, balanceDate: '2026-09-27', contributions: 14000, bonusToDate: 3712.4, taxYearContributions: 2000 }] },
  });
  cases.push({
    id: 'png-nest-pension',
    title: 'Workplace pension app: pot value and contributions this tax year',
    tags: ['png', 'pension'],
    file: {
      name: 'Screenshot 2026-09-20 at 19.48.02.png',
      kind: 'png',
      html: appOverviewHtml({ accent: '#e5007e', title: 'Nest-style pension', value: '£42,065.55', valueLabel: 'Your pot', stats: [['Contributions this tax year', '£3,000.00'], ['From you', '£1,200.00'], ['From your employer', '£1,500.00'], ['Tax relief', '£300.00'], ['Retirement date', '14 May 2061']] }),
    },
    expected: {
      sections: [{ account: 'nest-pension', balance: 42065.55, balanceDate: '2026-09-20', taxYearContributions: 3000 }],
      // Contributions stated for the tax year, as printed: yours, your employer's, and the relief.
      figures: [
        { kind: 'pension_contribution_employee', amount: 1200, taxYear: '2026/27' },
        { kind: 'pension_contribution_employer', amount: 1500, taxYear: '2026/27' },
        { kind: 'pension_tax_relief', amount: 300, taxYear: '2026/27' },
      ],
    },
  });
  cases.push({
    id: 'png-premium-bonds',
    title: 'Premium Bonds holding with a prize history',
    tags: ['png', 'savings'],
    file: {
      name: 'Screenshot 2026-09-17 at 07.30.12.png',
      kind: 'png',
      html: appOverviewHtml({ accent: '#5b2c83', title: 'NS&I-style · Premium Bonds', value: '£20,000.00', valueLabel: 'Holding', subtitle: 'Holder’s number ending 2210', stats: [['Prizes this month', '£25.00'], ['Prizes in the last 12 months', '£275.00']], sections: [{ title: 'Recent prizes', rows: [{ name: 'September 2026', sub: 'Paid to your bank account', amount: '£25.00' }, { name: 'July 2026', sub: 'Paid to your bank account', amount: '£50.00' }] }] }),
    },
    expected: { sections: [{ account: 'premium-bonds', balance: 20000, balanceDate: '2026-09-17' }] },
  });
  cases.push({
    id: 'png-nationwide-home-multi',
    title: 'Banking app home screen listing three accounts, one of them new',
    tags: ['png', 'multi-account', 'new-account', 'card-signs'],
    file: {
      name: 'Screenshot 2026-09-28 at 07.55.19.png',
      kind: 'png',
      html: appOverviewHtml({
        accent: '#1a2b6d',
        title: 'Nationwide-style · Your accounts',
        value: 'Good morning',
        stats: [],
        sections: [{ title: 'Accounts', rows: [{ name: 'FlexAccount', sub: '07-04-36 ••5540', amount: '£2,112.40' }, { name: 'Flex Instant Saver', sub: '07-04-36 ••9021 · 4.10% AER', amount: '£8,450.00' }, { name: 'Member Credit Card', sub: '••2280 · Balance owed', amount: '£312.44' }] }],
      }),
    },
    expected: {
      sections: [
        { account: 'nationwide-flex', balance: 2112.4, balanceDate: '2026-09-28' },
        { account: 'nationwide-saver', balance: 8450, balanceDate: '2026-09-28' },
        { account: { new: 'credit_card', last4: '2280' }, balance: -312.44, balanceDate: '2026-09-28' },
      ],
    },
  });
  {
    const rows: Tx[] = [
      { date: '2026-09-01', amount: 5000, text: 'Transfer in', name: 'Transfer from Barclays' },
      { date: '2026-09-15', amount: 200, text: 'Round up', name: 'Round-ups' },
      { date: '2026-09-28', amount: 10.44, text: 'Interest', name: 'Interest' },
    ];
    cases.push({
      id: 'png-chase-saver-new',
      title: 'Savings app screenshot for an account not set up yet',
      tags: ['png', 'new-account', 'savings'],
      file: { name: 'Screenshot 2026-09-28 at 20.11.40.png', kind: 'png', html: appListHtml({ accent: '#1c6dd0', title: 'Chase-style Saver ••3310', balance: '£5,210.44', balanceLabel: 'Balance', meta: '4.10% AER', groups: feed(rows, signed, (t) => t.text, '2026-09-28') }) },
      expected: { sections: [{ account: { new: 'savings', last4: '3310' }, balance: 5210.44, transactions: exp(rows, { description: (t) => t.name }) }] },
    });
  }
  // An investment app's LISA, as three screens of one morning, committed in order: the overview
  // (value, cash, the first holding of a list that continues), the activity list scrolled past its
  // account selector (the running balance is the cash, the provider named only in its own charge),
  // and one fund's own page (its figures, and a nickname, but no account).
  cases.push({
    id: 'png-lisa-app-overview',
    title: 'Investment LISA overview: value, cash, and only the first holding of the list',
    tags: ['png', 'lisa', 'holdings', 'app-set'],
    group: 'lisa-app',
    file: {
      name: 'Screenshot 2026-09-29 at 09.13.40.png',
      kind: 'png',
      html: appOverviewHtml({
        accent: '#1f5eff',
        title: 'Lifetime ISA',
        subtitle: 'Account number: MB7Q2XK',
        value: '£9,418.62',
        valueLabel: '+21.40% investment change',
        stats: [['Available cash to invest', '£612.30'], ['Interest rate', '3.8% (AER variable)']],
        sections: [{ title: 'Your investments', rows: [{ name: 'Fidelity Index World Fund P Acc', sub: 'Fund', amount: '£5,204.77' }] }],
      }),
    },
    expected: { sections: [{ account: 'moneybox-lisa', balance: 9418.62, balanceDate: '2026-09-29', cash: 612.3, holdings: [{ name: 'Fidelity Index World Fund P Acc', value: 5204.77 }] }] },
  });
  {
    const rows = [
      { date: '2026-09-26', amount: 1000, name: 'Debit card payment', balance: 1612.3 },
      { date: '2026-09-22', amount: -2.01, name: 'Moneybox charge - Aug 2026', balance: 612.3 },
      { date: '2026-09-02', amount: 250, name: 'Lifetime isa government bonus', balance: 614.31 },
    ];
    const opening = 364.31;
    cases.push({
      id: 'png-lisa-app-activity',
      title: 'Investment LISA activity, scrolled: the Balance column is the cash, not the value',
      tags: ['png', 'lisa', 'cash-ledger', 'app-set'],
      group: 'lisa-app',
      file: {
        name: 'Screenshot 2026-09-29 at 09.15.02.png',
        kind: 'png',
        html: appActivityHtml({
          accent: '#1f5eff',
          period: '2026 · 30 Aug - 29 Sep',
          rows: [
            ...rows.map((r) => ({ name: r.name, date: fmtDate(r.date, 'd-month-yyyy'), amount: r.amount > 0 ? `+${gbp(r.amount)}` : gbp(r.amount), balance: gbp(r.balance), positive: r.amount > 0 })),
            { name: '* BALANCE B/F *', date: '30 August 2026', amount: `+${gbp(opening)}`, balance: gbp(opening), positive: true },
          ],
        }),
      },
      expected: {
        sections: [
          {
            account: 'moneybox-lisa',
            periodStart: '2026-08-30',
            periodEnd: '2026-09-29',
            openingBalance: opening,
            cash: 1612.3,
            noValue: true,
            transactions: rows.map((r) => ({ date: r.date, amount: r.amount, description: r.name, balanceAfter: r.balance })),
          },
        ],
      },
    });
  }
  cases.push({
    id: 'png-lisa-app-fund-page',
    title: 'One fund’s own page: a holding with units and amount invested, not an account',
    tags: ['png', 'lisa', 'holdings', 'app-set'],
    group: 'lisa-app',
    file: {
      name: 'Screenshot 2026-09-29 at 09.16.21.png',
      kind: 'png',
      html: appHoldingHtml({
        accent: '#1f5eff',
        fund: 'Fidelity Index World Fund P Acc',
        nickname: 'Around the world',
        stats: [['Amount invested', '£4,300.00'], ['Current value', '£5,204.77'], ['Change since you invested', '£904.77'], ['Change since you invested (%)', '21.04 %'], ['Latest price per unit', '£3.94'], ['Number of units you own', '1,321.007']],
      }),
    },
    expected: { sections: [{ account: 'moneybox-lisa', noValue: true, holdings: [{ name: 'Fidelity Index World Fund P Acc', units: 1321.007, value: 5204.77 }] }] },
  });
  // A savings provider's app, as six screenshots taken a few minutes apart and uploaded together:
  // the account's Transactions tab (the holding, and prizes reinvested), the same tab scrolled
  // (older rows, no header), its Bond record tab (blocks of bond numbers: neither transactions nor
  // holdings), and the prize history (the same prizes by bond number and month, which never says
  // where the money went), twice. Only two of them add anything.
  {
    const accent = '#5b2c83';
    const holder = 'Holder’s number ••••3704';
    const value = 12350;
    const reinvested = [
      { date: '2026-09-03', amount: 50 },
      { date: '2026-09-03', amount: 25 },
      { date: '2026-08-05', amount: 25 },
      { date: '2026-07-02', amount: 100 },
      { date: '2026-07-02', amount: 25 },
    ];
    const older = [
      { date: '2026-06-02', amount: 25, name: 'Auto prize reinvestment' },
      { date: '2026-05-20', amount: 1000, name: 'Purchase by debit card' },
      { date: '2026-05-05', amount: 50, name: 'Auto prize reinvestment' },
      { date: '2026-04-02', amount: 25, name: 'Auto prize reinvestment' },
    ];
    const byDay = (rows: { date: string; amount: number; name?: string }[]) => {
      const days = [...new Set(rows.map((r) => r.date))];
      return days.map((d) => ({ heading: fmtDate(d, 'd-month-yyyy'), rows: rows.filter((r) => r.date === d).map((r) => ({ name: r.name ?? 'Auto prize reinvestment', amount: `+${gbp(r.amount)}`, positive: true })) }));
    };
    const tabs = ['Transactions', 'Bond record', 'Prizes'];
    const account = (active: string, time: string, groups: { heading: string; rows: AppRow[] }[]) => appTabbedHtml({ accent, time, header: true, title: 'Premium Bonds', subtitle: holder, value: gbp(value), valueLabel: 'Total holding', tabs, active, groups });
    const prizes = (header: boolean, time: string, groups: { heading: string; rows: AppRow[] }[]) => appTabbedHtml({ accent, time, header, title: 'Prize history', subtitle: holder, groups });
    const bond = (n: string, amount: number) => ({ name: n, amount: gbp(amount) });
    // Where the money went: none of these screens says it went elsewhere, and only the Transactions
    // tab says prizes were reinvested.
    const unsupported = /\b(paid (out )?(to|into)|sent to|credited to|(to|into) (your|a|another|the) (bank|current) account)\b/i;
    const unsupportedOrReinvested = /\b(paid (out )?(to|into)|sent to|credited to|(to|into) (your|a|another|the) (bank|current) account|reinvest\w*)\b/i;
    const together = { group: 'nsi-app', together: true } as const;
    cases.push({
      id: 'png-nsi-transactions',
      title: 'Savings app, Transactions tab: the holding with no date printed, and prizes reinvested',
      tags: ['png', 'savings', 'app-set', 'capture-date'],
      ...together,
      file: { name: 'Screenshot 2026-09-24 at 19.42.10.png', kind: 'png', html: account('Transactions', '19:42', byDay(reinvested)) },
      // The holding is what the app showed when the screenshot was taken, not on the latest row's day.
      expected: { sections: [{ account: 'premium-bonds', balance: value, balanceDate: '2026-09-24', transactions: reinvested.map((r) => ({ date: r.date, amount: r.amount, description: 'Auto prize reinvestment' })) }], unsupported },
    });
    cases.push({
      id: 'png-nsi-transactions-scrolled',
      title: 'The same tab scrolled: older rows, and nothing on screen saying which account',
      tags: ['png', 'savings', 'app-set', 'batch'],
      ...together,
      file: { name: 'Screenshot 2026-09-24 at 19.42.31.png', kind: 'png', html: appTabbedHtml({ accent, time: '19:42', header: false, title: '', groups: byDay(older) }) },
      expected: { sections: [{ account: 'premium-bonds', transactions: older.map((r) => ({ date: r.date, amount: r.amount, description: r.name })) }], unsupported },
    });
    cases.push({
      id: 'png-nsi-bond-record',
      title: 'Bond record tab: blocks of bond numbers are neither transactions nor holdings',
      tags: ['png', 'savings', 'app-set', 'nothing-new'],
      ...together,
      file: {
        name: 'Screenshot 2026-09-24 at 19.43.05.png',
        kind: 'png',
        html: account('Bond record', '19:43', [
          { heading: 'Eligible for the 1 October 2026 draw', rows: [bond('117BQ206001 to 117BQ206050', 50), bond('121CR554000 to 121CR554024', 25)] },
          { heading: 'Eligible for the 1 September 2026 draw', rows: [bond('117BQ205901 to 117BQ205925', 25)] },
          { heading: 'Eligible for the 1 August 2026 draw', rows: [bond('098TT418200 to 098TT418299', 100), bond('098TT417800 to 098TT417824', 25)] },
        ]),
      },
      // Its only figure, the holding on that day, is already on the Transactions tab's screenshot.
      expected: { sections: [{ account: 'premium-bonds', balance: value, balanceDate: '2026-09-24', holdings: [], transactions: [] }], nothingNew: true, unsupported: unsupportedOrReinvested },
    });
    const history = [
      { heading: 'September 2026', rows: [bond('117BQ204518', 50), bond('117BQ204972', 25)] },
      { heading: 'August 2026', rows: [bond('121CR553107', 25)] },
      { heading: 'July 2026', rows: [bond('117BQ205331', 100), bond('121CR550824', 25)] },
    ];
    cases.push({
      id: 'png-nsi-prize-history',
      title: 'Prize history: the same prizes by bond number and month, not where they went',
      tags: ['png', 'savings', 'app-set', 'nothing-new'],
      ...together,
      file: { name: 'Screenshot 2026-09-24 at 19.41.12.png', kind: 'png', html: prizes(true, '19:41', history) },
      expected: { sections: [], nothingNew: true, unsupported: unsupportedOrReinvested },
    });
    cases.push({
      id: 'png-nsi-prize-history-scrolled',
      title: 'Prize history scrolled: older prizes, nothing to record',
      tags: ['png', 'savings', 'app-set', 'nothing-new'],
      ...together,
      file: {
        name: 'Screenshot 2026-09-24 at 19.41.30.png',
        kind: 'png',
        html: prizes(false, '19:41', [
          { heading: 'June 2026', rows: [bond('098TT418251', 25)] },
          { heading: 'May 2026', rows: [bond('117BQ204077', 50)] },
          { heading: 'April 2026', rows: [bond('121CR551990', 25)] },
          { heading: 'February 2026', rows: [bond('098TT417811', 100), bond('117BQ205120', 25)] },
        ]),
      },
      expected: { sections: [], nothingNew: true, unsupported: unsupportedOrReinvested },
    });
  }
  return cases;
}
