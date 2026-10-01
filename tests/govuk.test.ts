// HMRC's gov.uk pages read from their text on this machine (src/server/ingest/govuk.ts). The fixtures
// are laid out like the real pages; every name, reference and amount in them is invented.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLongDate, parseMoney, readGovUkPage } from '../src/server/ingest/govuk';

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', 'govuk', name), 'utf8');
const page = (raw: string, layout = raw) => readGovUkPage({ raw, layout })!;

describe('reading HMRC’s pages', () => {
  it('reads dates and amounts as the pages print them', () => {
    expect(parseLongDate('27 August 2026')).toBe('2026-08-27');
    expect(parseLongDate('30 September2026')).toBe('2026-09-30');
    expect(parseLongDate('19August 2026')).toBe('2026-08-19');
    expect(parseLongDate('Total')).toBeNull();
    expect(parseMoney('£1,150.00')).toBe(1150);
    expect(parseMoney('-120.45')).toBe(-120.45);
    expect(parseMoney('£6,750')).toBe(6750);
    expect(parseMoney('Update')).toBeNull();
  });

  it('one employer’s taxable income: a payment per pay date, the leaving date, the total checked', () => {
    const e = page(fixture('taxable-income-employer.raw.txt'));
    expect(e).toMatchObject({ documentType: 'tax_document', documentDate: '2026-08-28', confidence: 'high', figures: [] });
    const payments = e.hmrc.filter((r) => r.type === 'payment');
    expect(payments).toHaveLength(5);
    expect(payments[0]).toEqual({ type: 'payment', employer: 'LARCHWOOD DATA LIMITED', payDate: '2026-04-28', taxablePay: 2100, tax: 210.4, ni: 90.12, taxYear: '2026/27' });
    expect(payments[4]).toMatchObject({ payDate: '2026-08-28', taxablePay: 300.5, tax: -120, ni: 0 });
    expect(e.hmrc.find((r) => r.type === 'employment')).toEqual({ type: 'employment', employer: 'LARCHWOOD DATA LIMITED', asOf: '2026-08-28', taxYear: '2026/27', endedOn: '2026-08-02' });
    // Rows that do not add up to the printed total are flagged, not trusted.
    const off = page(fixture('taxable-income-employer.raw.txt').replace('Total 8,700.50', 'Total 8,800.50'));
    expect(off.confidence).toBe('medium');
    expect(off.notes.join(' ')).toMatch(/do not add up to the page's printed total/);
  });

  it('a year’s taxable income: each job’s pay for the year, with its PAYE reference when printed', () => {
    const e = page(fixture('taxable-income-year.raw.txt'));
    expect(e.figures.map((f) => [f.payer, f.amount, f.payerReference, f.taxYear, f.periodStart, f.periodEnd])).toEqual([
      ['OAKFIELD ENGINEERING LIMITED', 12345.67, '123/AB45678', '2025/26', '2025-04-06', '2026-04-05'],
      ['QUILLON SYSTEMS LTD', 1500, null, '2025/26', '2025-04-06', '2026-04-05'],
    ]);
  });

  it('a job’s details on the day they were printed', () => {
    expect(page(fixture('employment-details.raw.txt')).hmrc).toEqual([
      { type: 'employment', employer: 'OAKFIELD ENGINEERING LIMITED', asOf: '2026-10-02', taxYear: '2026/27', payeReference: '123/AB45678', payrollNumber: '10203040', startedOn: '2026-05-04', estimatedPay: 18000, code: '1100L', cumulative: false },
    ]);
  });

  it('the PAYE account’s activity: codes with their basis, jobs starting and ending', () => {
    const text = fixture('paye-activity.layout.txt');
    const e = page('', text);
    expect(e.hmrc).toEqual([
      { type: 'tax-code', employer: 'OAKFIELD ENGINEERING LIMITED', date: '2026-09-30', code: '1100L', cumulative: false, taxYear: '2026/27' },
      { type: 'tax-code', employer: 'QUILLON SYSTEMS LTD', date: '2026-05-31', code: 'BR', cumulative: true, taxYear: '2026/27' },
      { type: 'event', employer: 'OAKFIELD ENGINEERING LIMITED', date: '2026-05-04', event: 'started', text: 'New employment at OAKFIELD ENGINEERING LIMITED' },
      { type: 'event', employer: 'LARCHWOOD DATA LIMITED', date: '2026-08-02', event: 'ended', text: 'Employment ended at LARCHWOOD DATA LIMITED' },
      { type: 'event', date: '2026-04-06', event: 'year-started', text: 'Tax year started' },
      { type: 'event', date: '2026-01-26', event: 'allowance', text: 'Personal Allowance of £12,570.00 added', amount: 12570 },
    ]);
  });

  it('a finished year’s settlement: what HMRC worked out, and how it was paid', () => {
    expect(page(fixture('tax-you-paid.raw.txt')).hmrc).toEqual([
      { type: 'settlement', taxYear: '2024/25', asOf: '2026-10-02', outcome: 'underpaid', amount: 96.8, calculatedOn: '2026-07-21', outstanding: 0, payments: [{ date: '2026-09-15', amount: 96.8, how: 'bank transfer' }] },
    ]);
  });

  it('the State Pension forecast, with the years it rests on', () => {
    expect(page(fixture('state-pension.raw.txt')).hmrc).toEqual([
      { type: 'state-pension-forecast', asOf: '2026-10-02', weekly: 200, monthly: 869.05, annual: 10428.57, payableFrom: '2058-03-01', recordTo: '2026-04-05', assumesYears: 20, qualifyingYears: 15, yearsNeeded: 10 },
    ]);
  });

  it('the National Insurance record, year by year, with what a gap would cost to fill', () => {
    const years = page(fixture('ni-record.raw.txt')).hmrc;
    expect(years.map((y) => (y.type === 'ni-year' ? [y.taxYear, y.status, y.contributions, y.voluntaryCost ?? null, y.payBy ?? null] : null))).toEqual([
      ['2026/27', 'not-available', [], null, null],
      ['2025/26', 'full', [{ kind: 'Paid employment', amount: 1234.56 }], null, null],
      ['2024/25', 'full', [{ kind: 'Paid employment', amount: 300 }, { kind: 'National Insurance credits', amount: 0 }], null, null],
      ['2023/24', 'not-full', [], 850.5, '2030-04-05'],
    ]);
  });

  it('a page it does not know is left to Claude', () => {
    expect(readGovUkPage({ raw: 'Monthly statement\nOpening balance £10.00', layout: '' })).toBeNull();
    expect(readGovUkPage({ raw: 'GOV.UK\nRegister to vote', layout: '' })).toBeNull();
  });
});
