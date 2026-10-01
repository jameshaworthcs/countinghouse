// Reading everything a document prints (extract-13; docs/INGESTION.md, "Reading everything"): the
// prompt and schema it adds, what the normaliser makes of a reading, and a payslip that confirms its
// own figures. No Claude runs here: the readings are written by hand, and invented.

import { describe, expect, it } from 'vitest';
import { normaliseExtraction } from '../src/server/ingest/normalise';
import { extractionJsonSchema, promptVersion, systemPrompt } from '../src/server/ingest/prompt';
import { assessReading } from '../src/server/ingest/verify';
import type { Draft } from '../src/shared/schema';

const NI = /[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]/;

describe('the reader, reading everything', () => {
  it('is a prompt version of its own, with four more rules and their part of the schema', () => {
    expect([promptVersion(false), promptVersion(true)]).toEqual(['extract-11', 'extract-13']);
    expect(systemPrompt(false)).not.toMatch(/^20\. payslips/m);
    expect(systemPrompt(true)).toMatch(/^20\. payslips:/m);
    expect(systemPrompt(true)).toMatch(/^22\. printed:/m);
    expect(systemPrompt(true)).toMatch(/^23\. terms, on each account:/m);
    const keys = (s: Record<string, unknown>) => Object.keys(s.properties as Record<string, unknown>);
    expect(keys(extractionJsonSchema(false))).not.toContain('payslips');
    expect(keys(extractionJsonSchema(true))).toEqual(expect.arrayContaining(['payslips', 'hmrc', 'printed']));
    // An account's terms: only when reading everything.
    const account = (s: Record<string, unknown>) => ((s.properties as Record<string, { items: Record<string, unknown> }>).accounts!.items);
    expect(keys(account(extractionJsonSchema(false)))).not.toContain('terms');
    expect(keys(account(extractionJsonSchema(true)))).toContain('terms');
  });

  it('keeps a scanned payslip in full, HMRC’s records by their kind, and every other value printed', () => {
    const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
    const hmrcBlank = { ...nulls(['employer', 'payeReference', 'taxYear', 'date', 'asOf', 'code', 'cumulative', 'payDate', 'taxablePay', 'tax', 'ni', 'payrollNumber', 'startedOn', 'endedOn', 'estimatedPay', 'leavingPay', 'event', 'text', 'amount', 'outcome', 'calculatedOn', 'outstanding', 'status', 'voluntaryCost', 'payBy', 'weekly', 'monthly', 'annual', 'payableFrom', 'recordTo', 'qualifyingYears', 'yearsNeeded', 'assumesYears', 'maximum']), payments: [], contributions: [] };
    const reading = {
      documentType: 'payslip',
      institutionName: 'Quillon Systems Ltd',
      documentDate: '2026-07-28',
      accounts: [],
      figures: [{ kind: 'gross_pay', label: 'Total pay', amount: 2150, currency: 'GBP', periodStart: '2026-07-01', periodEnd: '2026-07-31', taxYear: '2026/27', payer: 'Quillon Systems Ltd', payerReference: null, accountLast4: null, taxCode: '1257L', work: null }],
      payslips: [
        {
          employer: 'Quillon Systems Ltd',
          otherNames: ['Quillon Group'],
          payeReference: '120 qs123',
          // A National Insurance number where the payroll number goes is left out.
          payrollNumber: 'QQ123456C',
          payDate: '28/07/2026',
          periodStart: '2026-07-01',
          periodEnd: '2026-07-31',
          periodLabel: 'Jul-2026',
          periodNumber: 4,
          frequency: 'monthly',
          taxCode: '1257L',
          cumulative: true,
          niLetter: 'a',
          payMethod: 'BACS',
          department: null,
          payments: [{ label: 'Basic Pay', amount: '2,150.00', quantity: null, rate: null }],
          deductions: [
            { label: 'Income Tax', amount: 216.4, quantity: null, rate: null },
            { label: 'National Insurance', amount: 88.32, quantity: null, rate: null },
          ],
          totals: { payments: 2150, deductions: 304.72, taxable: 2150, nonTaxable: null, net: 1845.28 },
          employerCosts: { ni: 207.4, pension: null },
          yearToDate: { gross: 8600, taxable: 8600, tax: 865.6, ni: 353.28, niEmployer: null, niablePay: null, pension: null, pensionEmployer: null, studentLoan: null, ssp: null, smp: null, taxCredit: null },
        },
      ],
      hmrc: [
        { ...hmrcBlank, type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-07-28', taxablePay: 2150, tax: 216.4, ni: 88.32, taxYear: '2026/27', asOf: '2026-08-02' },
        { ...hmrcBlank, type: 'tax-code', employer: 'QUILLON SYSTEMS LTD', date: '2026-04-06', code: '1257L', cumulative: true, taxYear: '2026/27' },
        { ...hmrcBlank, type: 'state-pension-forecast', asOf: '2026-09-30', weekly: 230.25, annual: 12006.75, qualifyingYears: 9.0, payableFrom: '2058-03-01' },
        // A payment with no pay date cannot be kept.
        { ...hmrcBlank, type: 'payment', employer: 'QUILLON SYSTEMS LTD', taxablePay: 10, tax: 0, taxYear: '2026/27' },
      ],
      printed: [
        { section: 'Pension', label: 'Scheme', value: 'Quillon Money Purchase Plan' },
        { section: null, label: 'Employee', value: 'NI number QQ 12 34 56 C' },
        { section: null, label: 'Message', value: '' },
      ],
      notes: [],
      nothingToRecord: null,
      confidence: 'high',
    };
    const { extraction, warnings } = normaliseExtraction(reading);
    expect(extraction.payslips).toEqual([
      {
        employer: 'Quillon Systems Ltd',
        otherNames: ['Quillon Group'],
        payeReference: '120/QS123',
        payDate: '2026-07-28',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        periodLabel: 'Jul-2026',
        periodNumber: 4,
        frequency: 'monthly',
        taxCode: '1257L',
        cumulative: true,
        niLetter: 'A',
        payMethod: 'BACS',
        payments: [{ label: 'Basic Pay', amount: 2150 }],
        deductions: [
          { label: 'Income Tax', amount: 216.4 },
          { label: 'National Insurance', amount: 88.32 },
        ],
        totals: { payments: 2150, deductions: 304.72, taxable: 2150, net: 1845.28 },
        employerCosts: { ni: 207.4 },
        yearToDate: { gross: 8600, taxable: 8600, tax: 865.6, ni: 353.28 },
      },
    ]);
    expect(extraction.hmrc).toEqual([
      { type: 'payment', employer: 'QUILLON SYSTEMS LTD', payDate: '2026-07-28', taxablePay: 2150, tax: 216.4, ni: 88.32, taxYear: '2026/27' },
      { type: 'tax-code', employer: 'QUILLON SYSTEMS LTD', date: '2026-04-06', code: '1257L', cumulative: true, taxYear: '2026/27' },
      { type: 'state-pension-forecast', asOf: '2026-09-30', weekly: 230.25, annual: 12006.75, payableFrom: '2058-03-01', qualifyingYears: 9 },
    ]);
    expect(warnings.join(' ')).toMatch(/HMRC record 4 \(payment\) could not be kept/);
    expect(extraction.printed).toEqual([
      { section: 'Pension', label: 'Scheme', value: 'Quillon Money Purchase Plan' },
      { label: 'Employee', value: 'NI number [NI number]' },
    ]);
    expect(JSON.stringify(extraction)).not.toMatch(NI);
  });

  it('a payslip that adds up confirms the tax figures read from it; one that does not is read again', () => {
    const slip = {
      employer: 'Quillon Systems Ltd',
      otherNames: [],
      payDate: '2026-07-28',
      payments: [{ label: 'Basic Pay', amount: 2150 }],
      deductions: [
        { label: 'Income Tax', amount: 216.4 },
        { label: 'National Insurance', amount: 88.32 },
      ],
      totals: { payments: 2150, deductions: 304.72, net: 1845.28 },
      employerCosts: {},
      yearToDate: {},
    };
    const figure = (key: string, kind: Draft['figures'][number]['kind'], amount: number) => ({ key, include: true, kind, label: kind, amount, currency: 'GBP' as const, taxYear: '2026/27' });
    const draft = (figures: Draft['figures'], payslip = slip): Draft => ({ documentType: 'payslip', sections: [], figures, payslips: [{ key: 's0', include: true, record: payslip }], notes: [] });
    const ctx = { accountTypeOf: () => undefined, latest: '2026-10-01', warnings: [] };
    const right = [figure('f0', 'gross_pay', 2150), figure('f1', 'tax_deducted', 216.4), figure('f2', 'national_insurance', 88.32)];
    expect(assessReading(draft(right), ctx)).toEqual({ problems: [], unconfirmed: [] });
    // The figures read say other than its lines.
    expect(assessReading(draft([right[0]!, figure('f1', 'tax_deducted', 261.4), right[2]!]), ctx).problems).toEqual(['The tax figures read are not what the payslip’s lines say']);
    // Its lines do not add up to its total.
    const wrong = assessReading(draft(right, { ...slip, totals: { ...slip.totals, deductions: 340.72 } }), ctx);
    expect(wrong.problems.join(' ')).toMatch(/deduction lines read come to 304\.72, not the 340\.72 printed/);
    expect(wrong.unconfirmed).toContain('Tax figures');
  });
});
