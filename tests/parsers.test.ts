import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProfile, parseWithProfile, readCsvRows, suggestMapping } from '../src/server/ingest/csv';
import { decodeText, detectKind } from '../src/server/ingest/detect';
import { parseHoldingsCsv } from '../src/server/ingest/holdings-csv';
import { dateFromFileName } from '../src/server/ingest/images';
import { parseStatementText } from '../src/server/ingest/ocr';
import { parseOfx } from '../src/server/ingest/ofx';
import { parseQif } from '../src/server/ingest/qif';
import { parseSantanderTxt } from '../src/server/ingest/santander';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name));

function parseCsvFixture(name: string) {
  const bytes = fixture(name);
  expect(detectKind(name, bytes)).toBe('csv');
  const { rows } = readCsvRows(decodeText(bytes));
  const match = findProfile(rows);
  expect(match, `profile for ${name}`).not.toBeNull();
  return { match: match!, result: parseWithProfile(rows, match!) };
}

const simple = (tx: { date: string; amount: number; description: string }[]) => tx.map((t) => [t.date, t.amount, t.description]);

describe('CSV bank formats', () => {
  it('Monzo: keeps time, id, merchant, bank category and FX detail', () => {
    const { match, result } = parseCsvFixture('monzo.csv');
    expect(match.profile.id).toBe('monzo');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions).toHaveLength(9);
    const pret = acc!.transactions[0]!;
    expect(pret).toMatchObject({ date: '2026-09-01', time: '08:12:44', amount: -4.5, description: 'PRET A MANGER LONDON GBR', sourceId: 'tx_0000A1', bankCategory: 'Eating out', payee: 'Pret A Manger' });
    expect(pret.raw?.['Transaction ID']).toBe('tx_0000A1');
    const paris = acc!.transactions.find((t) => t.description.startsWith('CAFE DE FLORE'))!;
    expect(paris.originalAmount).toBe(-14);
    expect(paris.originalCurrency).toBe('EUR');
    expect(acc!.institutionName).toBe('Monzo');
  });

  it('Starling: running balances, opening balance row becomes the opening balance', () => {
    const { match, result } = parseCsvFixture('starling.csv');
    expect(match.profile.id).toBe('starling');
    const [acc] = result.extraction.accounts;
    expect(simple(acc!.transactions)).toEqual([
      ['2026-09-02', -12.34, 'TESCO STORES 2231 LONDON'],
      ['2026-09-03', 2000, 'ACME LTD · SEPT SALARY'],
      ['2026-09-05', -60, 'British Gas · BG DD REF 1234'],
    ]);
    expect(acc!.openingBalance).toBe(1000);
    expect(acc!.closingBalance).toBe(2927.66);
    expect(acc!.balanceDate).toBe('2026-09-05');
    expect(acc!.transactions[1]!.counterpartyName).toBe('ACME LTD');
  });

  it('Barclays: newest-first export is stored oldest-first, last 4 of account kept', () => {
    const { result } = parseCsvFixture('barclays.csv');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions.map((t) => t.date)).toEqual(['2026-09-02', '2026-09-03', '2026-09-05']);
    expect(acc!.last4).toBe('5678');
    expect(acc!.transactions[0]!.type).toBe('PAYMENT');
  });

  it('Nationwide: Windows-1252 £ signs, preamble, paid in/out columns', () => {
    const { match, result } = parseCsvFixture('nationwide.csv');
    expect(match.profile.id).toBe('nationwide-current');
    const [acc] = result.extraction.accounts;
    expect(simple(acc!.transactions)).toEqual([
      ['2026-09-01', -12.34, 'TESCO STORES 3297'],
      ['2026-09-03', 2000, 'ACME LTD SALARY'],
      ['2026-09-05', -60, 'BRITISH GAS'],
    ]);
    expect(acc!.closingBalance).toBe(2940);
    expect(acc!.accountName).toBe('FlexDirect ****12345');
    expect(acc!.last4).toBe('2345');
  });

  it('Lloyds group: debit/credit columns, reversed order', () => {
    const { match, result } = parseCsvFixture('lloyds.csv');
    expect(match.profile.id).toBe('lloyds-group');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions.map((t) => t.amount)).toEqual([-12.34, 2000, -60]);
    expect(acc!.openingBalance).toBe(1012.34);
    expect(acc!.closingBalance).toBe(2940);
  });

  it('NatWest: spaced headers, blank first line, quoted account number', () => {
    const { match, result } = parseCsvFixture('natwest.csv');
    expect(match.profile.id).toBe('natwest-group');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions.map((t) => t.amount)).toEqual([-12.34, 2000]);
    expect(acc!.last4).toBe('5678');
  });

  it('Amex: inverted signs, merchant address and reference id', () => {
    const { result } = parseCsvFixture('amex.csv');
    const [acc] = result.extraction.accounts;
    expect(acc!.accountType).toBe('credit_card');
    expect(acc!.transactions.map((t) => t.amount)).toEqual([-12.34, 500]);
    expect(acc!.transactions[0]!.merchant).toMatchObject({ address: '1 HIGH ST', city: 'LONDON', postcode: 'SW1A 1AA' });
    expect(acc!.transactions[0]!.sourceId).toBe('AT262450001000010012345');
  });

  it('Aqua: inverted signs, and what the statement shows as the reference', () => {
    const { match, result } = parseCsvFixture('aqua.csv');
    expect(match.profile.id).toBe('aqua');
    const [acc] = result.extraction.accounts;
    expect(acc!.institutionName).toBe('Aqua (NewDay)');
    expect(acc!.accountType).toBe('credit_card');
    // Newest first in the file, oldest first once read: purchases out, the refund and payment in.
    expect(acc!.transactions.map((t) => [t.date, t.amount, t.description, t.reference])).toEqual([
      ['2026-09-01', -12.34, 'Tesco', 'TESCO STORES 3297      LONDON        GBR'],
      ['2026-09-03', -30, 'Trainline', 'TRAINLINE.COM          LONDON        GBR'],
      ['2026-09-05', 8.5, 'Trainline', 'TRAINLINE.COM          LONDON        GBR'],
      ['2026-09-21', 42.34, 'PAYMENT RECEIVED - THANK YOU', null],
    ]);
  });

  it('Revolut: completed only, fee applied, split by product and currency', () => {
    const { result } = parseCsvFixture('revolut.csv');
    const accounts = result.extraction.accounts;
    expect(accounts).toHaveLength(3);
    const gbp = accounts.find((a) => a.accountName?.includes('Current · GBP'))!;
    expect(gbp.transactions.map((t) => t.amount)).toEqual([-12.34, 500, -100.5]);
    expect(gbp.transactions[2]!.fee).toBe(-0.5);
    expect(gbp.transactions[0]!.transactionDate).toBe('2026-09-01');
    expect(gbp.transactions[0]!.time).toBe('09:00:00');
    expect(accounts.find((a) => a.accountName?.includes('Savings'))!.accountType).toBe('savings');
    expect(accounts.find((a) => a.currency === 'EUR')!.transactions[0]!.amount).toBe(115);
    expect(result.skipped).toBe(1);
  });

  it('HSBC: header-less three-column export', () => {
    const { match, result } = parseCsvFixture('hsbc.csv');
    expect(match.profile.id).toBe('hsbc');
    expect(result.extraction.accounts[0]!.transactions.map((t) => t.amount)).toEqual([-12.34, 2000]);
  });

  it('Trading 212: buys and withdrawals are money out', () => {
    const { result } = parseCsvFixture('trading212.csv');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions.map((t) => t.amount)).toEqual([500, -492, 1.23, 0.45]);
    expect(acc!.transactions[1]!.description).toBe('Market buy · Vanguard FTSE All-World');
  });

  it('Chase UK: the description column, not the type column beside it', () => {
    const { match, result } = parseCsvFixture('chase.csv');
    expect(match.profile.id).toBe('chase');
    const [acc] = result.extraction.accounts;
    expect(acc!.transactions.map((t) => [t.date, t.time, t.amount, t.description, t.type, t.balanceAfter])).toEqual([
      ['2026-08-12', '12:07', -45.67, 'To Revolving Line Account', 'Transfer', 954.33],
      ['2026-09-03', '08:44', 500, 'From A N OTHER - CHASE-TOPUP', 'Payment', 1454.33],
      ['2026-09-17', '10:36', -34.48, 'Cash withdrawal, Bank, Faro', 'Cash withdrawal | EUR 40.00 | FX rate £1 = €1.1600', 1386.7],
    ]);
    // Worked out without the layout, the same columns.
    const { rows } = readCsvRows(decodeText(fixture('chase.csv')));
    expect(suggestMapping(rows)!.profile.columns).toMatchObject({ date: 'Date', time: 'Time', description: ['Transaction Description'], type: 'Transaction Type', amount: 'Amount', balance: 'Balance' });
  });

  it('suggests a mapping for unknown layouts', () => {
    const { rows } = readCsvRows(decodeText(fixture('unknown.csv')));
    expect(findProfile(rows)).toBeNull();
    const s = suggestMapping(rows)!;
    expect(s.profile.columns).toMatchObject({ date: 'Posted On', description: ['Details'], debit: 'Money Out', credit: 'Money In' });
    expect(s.confident).toBe(false);
    const parsed = parseWithProfile(rows, { profile: s.profile, headerIndex: s.headerIndex, headerless: false });
    expect(parsed.extraction.accounts[0]!.transactions.map((t) => t.amount)).toEqual([-10, 100]);
    // Money out and money in columns say which way round the signs are, card or not.
    expect(suggestMapping(rows, { accountType: 'credit_card' })!.profile.amountSign).toBe('normal');
  });

  it('reads an unknown layout card style only for a card whose rows need it', () => {
    // A card's own export: purchases positive, the payment to the card negative.
    const { rows } = readCsvRows('Date,Merchant,Amount (GBP)\n01/09/2026,TESCO,12.34\n03/09/2026,TRAINLINE,30.00\n21/09/2026,PAYMENT RECEIVED - THANK YOU,-42.34\n');
    expect(findProfile(rows)).toBeNull();
    const card = suggestMapping(rows, { accountType: 'credit_card' })!;
    expect(card.confident).toBe(true);
    expect(card.profile.amountSign).toBe('inverted');
    const parsed = parseWithProfile(rows, { profile: card.profile, headerIndex: card.headerIndex, headerless: false });
    expect(parsed.extraction.accounts[0]!.transactions.map((t) => t.amount)).toEqual([-12.34, -30, 42.34]);
    // Not known to be a card: read as it stands.
    expect(suggestMapping(rows)!.profile.amountSign).toBe('normal');
    expect(suggestMapping(rows, { accountType: 'current' })!.profile.amountSign).toBe('normal');
    // Too few rows to tell.
    expect(suggestMapping(rows.slice(0, 3), { accountType: 'credit_card' })!.profile.amountSign).toBe('normal');
    // A card export already signed the app's way is left alone.
    const signed = readCsvRows('Date,Merchant,Amount (GBP)\n01/09/2026,TESCO,-12.34\n03/09/2026,TRAINLINE,-30.00\n21/09/2026,PAYMENT RECEIVED - THANK YOU,42.34\n').rows;
    expect(suggestMapping(signed, { accountType: 'credit_card' })!.profile.amountSign).toBe('normal');
    // Flipped, it would still fail the card-signs check: a payment to the card comes out as money out.
    const mixed = readCsvRows('Date,Merchant,Amount (GBP)\n01/09/2026,TESCO,-12.34\n03/09/2026,TRAINLINE,-30.00\n05/09/2026,PRET,-4.50\n21/09/2026,PAYMENT RECEIVED - THANK YOU,-42.34\n22/09/2026,DIRECT DEBIT PAYMENT,42.34\n').rows;
    expect(suggestMapping(mixed, { accountType: 'credit_card' })!.profile.amountSign).toBe('normal');
  });
});

describe('OFX, QIF, Santander TXT', () => {
  it('parses SGML OFX with ledger balance and FITIDs', () => {
    const bytes = fixture('statement.ofx');
    expect(detectKind('statement.ofx', bytes)).toBe('ofx');
    const ex = parseOfx(decodeText(bytes));
    const [acc] = ex.accounts;
    expect(ex.institutionName).toBe('Santander UK');
    expect(acc!.last4).toBe('9876');
    expect(acc!.closingBalance).toBe(2940);
    expect(acc!.availableBalance).toBe(2900);
    expect(acc!.periodStart).toBe('2026-09-01');
    expect(acc!.transactions.map((t) => [t.date, t.amount, t.description, t.sourceId])).toEqual([
      ['2026-09-01', -12.34, 'TESCO STORES 3297 · CARD PAYMENT', 'F1'],
      ['2026-09-03', 2000, 'ACME LTD · SALARY & BONUS', 'F2'],
    ]);
  });

  it('parses QIF with day-first dates', () => {
    const bytes = fixture('statement.qif');
    expect(detectKind('statement.qif', bytes)).toBe('qif');
    const ex = parseQif(decodeText(bytes));
    expect(ex.accounts[0]!.transactions.map((t) => [t.date, t.amount])).toEqual([
      ['2026-09-01', -12.34],
      ['2026-09-13', 2000],
    ]);
  });

  it('parses the Santander text export', () => {
    const bytes = fixture('santander.txt');
    expect(detectKind('santander.txt', bytes)).toBe('santander-txt');
    const ex = parseSantanderTxt(decodeText(bytes));
    const [acc] = ex.accounts;
    expect(acc!.last4).toBe('9876');
    expect(acc!.transactions.map((t) => t.amount)).toEqual([-12.34, 2000, -60]);
    expect(acc!.closingBalance).toBe(2940);
    expect(acc!.openingBalance).toBe(1012.34);
  });
});

describe('screenshots and OCR helpers', () => {
  it.each([
    ['Screenshot_20260926-143012.png', '2026-09-26'],
    ['Screenshot 2026-09-26 at 14.30.12.png', '2026-09-26'],
    ['PXL_20260926_143012345.jpg', '2026-09-26'],
    ['IMG_4471.PNG', null],
    ['Screenshot from 2026-09-26 14-30-12.png', '2026-09-26'],
  ])('dateFromFileName(%j)', (name, expected) => {
    expect(dateFromFileName(name)).toBe(expected);
  });

  it('infers signs from running balances in text statements', () => {
    const text = [
      '01/09/2026  TESCO STORES 3297              12.34        987.66',
      '03/09/2026  ACME LTD SALARY             2,000.00      2,987.66',
      '05/09/2026  BRITISH GAS                    60.00      2,927.66',
    ].join('\n');
    const rows = parseStatementText(text, 2026);
    expect(rows.map((r) => r.amount)).toEqual([12.34, 2000, -60]);
  });
});

describe('holdings exports', () => {
  it('reads interactive investor’s portfolio export: prices in pence or pounds, SEDOL or ticker, the totals line', () => {
    const { rows } = readCsvRows(decodeText(fixture('ii-holdings.csv')));
    // Several byte-order marks in front of the header do not hide it.
    expect(rows[0]![0]).toBe('Symbol');
    const ex = parseHoldingsCsv(rows, 'ii-29-09-2026-ISA.csv')!;
    const [acc] = ex.accounts;
    expect(acc).toMatchObject({ institutionName: 'interactive investor', accountType: 'stocks_isa', closingBalance: 8978.1 });
    expect(acc!.holdings).toEqual([
      expect.objectContaining({ name: 'Example Global Index Fund Acc', sedol: 'B3X7QG6', ticker: null, units: 1200.5, price: 2.501, value: 3002.45, costBasis: 2500, gain: 502.45 }),
      expect.objectContaining({ name: 'Example World ETF USD Acc GBP', sedol: null, ticker: 'XMPL', units: 40, price: 123.45, value: 4938 }),
      expect.objectContaining({ name: 'Example Income Fund £ Inc', sedol: 'B0000C4', price: 101.2345, value: 1037.65 }),
    ]);
    expect(dateFromFileName('ii-29-09-2026-ISA.csv')).toBe('2026-09-29');
  });

  it('leaves transaction exports to the transaction profiles', () => {
    const { rows } = readCsvRows(decodeText(fixture('trading212.csv')));
    expect(parseHoldingsCsv(rows, 'trading212.csv')).toBeNull();
    expect(parseHoldingsCsv(readCsvRows(decodeText(fixture('monzo.csv'))).rows, 'monzo.csv')).toBeNull();
  });
});
