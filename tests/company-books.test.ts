// A company's books (FORMULAS.md §22, "Company books"; UK_RULES.md, "Companies"): its periods and the
// deadlines worked out from them, checked against the Acts' and HMRC's own worked examples, and the
// edge cases of month arithmetic. Every company, date and figure is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { accountingPeriodsOf, addedBooksProblems, booksProblems, withinChargeAssumed, companyDeadlineAlerts, companyDeadlines, ctPeriodsOf, vatPeriodsOf, type CompanyDeadline } from '../src/shared/company-books';
import { addDays, fromUTC } from '../src/shared/dates';
import { CompanyBooksSchema, CompanyFilingSchema, CompanyVatSchema, MonthDaySchema, type CompanyBooks, type CompanyFiling, type CompanyFilingInput } from '../src/shared/schema';
import {
  ACCOUNTS_FILING_RULES,
  CONFIRMATION_STATEMENT_RULES,
  CT_PAYMENT_RULES,
  CT_RETURN_RULES,
  ruleOn,
  VAT_RETURN_RULES,
  accountsFilingDeadline,
  confirmationStatementDue,
  ct600Due,
  ctPaymentDue,
  defaultAccountingReferenceDate,
  easterSunday,
  firstAccountingPeriodEnd,
  lastDayOfMonths,
  lastWorkingDayOfMonth,
  monthsAfter,
  vatPeriodEnd,
  vatReturnDue,
} from '../src/shared/uk';

const stamp = '2026-01-01T00:00:00+00:00';
const books = (extra: Partial<CompanyBooks> & { incorporatedOn: string }): CompanyBooks => CompanyBooksSchema.parse({ updatedAt: stamp, ...extra });
let n = 0;
const filing = (f: CompanyFilingInput): CompanyFiling => ({ ...f, id: `fil_${(n++).toString(16).padStart(12, '0')}`, addedBy: 'owner' });
const of = (list: CompanyDeadline[], kind: CompanyDeadline['kind']) => list.filter((d) => d.kind === kind);
const short = (list: CompanyDeadline[]) => list.map((d) => [d.period.start ?? null, d.period.end, d.due]);

describe('months as the Acts count them', () => {
  it('a number of months after a day: the corresponding day, the month’s last day after a month end (CA 2006 s443)', () => {
    expect(monthsAfter('2025-03-15', 9)).toBe('2025-12-15');
    // s443(3): the last day of a month runs to the last day of the month.
    expect(monthsAfter('2025-06-30', 9)).toBe('2026-03-31');
    expect(monthsAfter('2025-04-30', 1)).toBe('2025-05-31');
    expect(monthsAfter('2025-02-28', 12)).toBe('2026-02-28');
    expect(monthsAfter('2027-02-28', 12)).toBe('2028-02-29');
    // s443(4): the 29th or 30th into February is its last day.
    expect(monthsAfter('2025-05-30', 9)).toBe('2026-02-28');
    expect(monthsAfter('2027-05-29', 9)).toBe('2028-02-29');
    // A 31-day month's end into a 30-day month.
    expect(monthsAfter('2025-03-31', 6)).toBe('2025-09-30');
  });

  it('HMRC’s own table of Corporation Tax due dates (CTM01800), every row', () => {
    expect(ctPaymentDue('1999-03-31')).toBe('2000-01-01');
    expect(ctPaymentDue('1999-07-01')).toBe('2000-04-02');
    expect(ctPaymentDue('2000-02-28')).toBe('2000-11-29');
    expect(ctPaymentDue('2001-02-28')).toBe('2001-12-01');
    expect(ctPaymentDue('2000-02-29')).toBe('2000-12-01');
    expect(ctPaymentDue('2000-05-28')).toBe('2001-03-01');
    expect(ctPaymentDue('2003-05-28')).toBe('2004-02-29');
    expect(ctPaymentDue('2000-05-29')).toBe('2001-03-01');
    expect(ctPaymentDue('2000-05-30')).toBe('2001-03-01');
    expect(ctPaymentDue('2000-05-31')).toBe('2001-03-01');
  });

  it('a period of months beginning with a day: to the day before the corresponding day, or the month’s last day with none', () => {
    expect(lastDayOfMonths('2024-03-15', 12)).toBe('2025-03-14');
    expect(lastDayOfMonths('2024-04-01', 12)).toBe('2025-03-31');
    expect(lastDayOfMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(lastDayOfMonths('2023-03-01', 12)).toBe('2024-02-29');
    expect(lastDayOfMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(lastDayOfMonths('2018-05-01', 30)).toBe('2020-10-31');
  });

  it('Easter and the last working day of a month (VAT annual accounting)', () => {
    expect([2024, 2025, 2026, 2027].map(easterSunday)).toEqual(['2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28']);
    // 31 May 2027 is the spring bank holiday, a Monday: the Friday before.
    expect(lastWorkingDayOfMonth('2027-05-01')).toBe('2027-05-28');
    // 31 August 2026 is the summer bank holiday.
    expect(lastWorkingDayOfMonth('2026-08-10')).toBe('2026-08-28');
    // A weekend: 31 January 2027 is a Sunday.
    expect(lastWorkingDayOfMonth('2027-01-15')).toBe('2027-01-29');
    // Good Friday on 31 March 2051 (Easter Sunday is 2 April that year).
    expect(easterSunday(2051)).toBe('2051-04-02');
    expect(lastWorkingDayOfMonth('2051-03-01')).toBe('2051-03-30');
    expect(lastWorkingDayOfMonth('2026-06-01')).toBe('2026-06-30');
  });
});

describe('accounting reference periods (CA 2006 ss391–392)', () => {
  it('the default reference date is the last day of the month of the anniversary of incorporation (s391(4))', () => {
    expect(defaultAccountingReferenceDate('2024-03-15')).toBe('03-31');
    expect(defaultAccountingReferenceDate('2023-04-02')).toBe('04-30');
    expect(defaultAccountingReferenceDate('2023-02-10')).toBe('02-28');
    expect(accountingPeriodsOf({ incorporatedOn: '2024-03-15', periods: [] }, '2026-11-26')).toEqual([
      { start: '2024-03-15', end: '2025-03-31', source: 'worked-out' },
      { start: '2025-04-01', end: '2026-03-31', source: 'worked-out' },
      { start: '2026-04-01', end: '2027-03-31', source: 'worked-out' },
    ]);
  });

  it('a February company’s periods end on the last day of February, the 29th in a leap year', () => {
    expect(accountingPeriodsOf({ incorporatedOn: '2023-02-10', periods: [] }, '2025-03-10').map((p) => p.end)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
  });

  it('the first period is more than 6 months (s391(5)): a reference date too soon after incorporation is the next year’s', () => {
    expect(firstAccountingPeriodEnd('2024-03-15', '12-31')).toBe('2024-12-31');
    // 1 January to 30 June is exactly 6 months: not more, so 18 months to the next 30 June.
    expect(firstAccountingPeriodEnd('2024-01-01', '06-30')).toBe('2025-06-30');
    expect(firstAccountingPeriodEnd('2024-01-02', '06-30')).toBe('2025-06-30');
    expect(firstAccountingPeriodEnd('2023-12-30', '06-30')).toBe('2024-06-30');
    // From 31 December, 30 June is 6 months on (the month's end stands for the 31st it lacks).
    expect(firstAccountingPeriodEnd('2023-12-31', '06-30')).toBe('2025-06-30');
  });

  it('a period you set (shortened or extended, s392) is used, and the next ones follow on from its end', () => {
    const b = books({ incorporatedOn: '2023-05-02', accountingReferenceDate: '12-31', periods: [{ start: '2025-01-01', end: '2026-03-31' }] });
    expect(accountingPeriodsOf(b, '2027-06-01').map((p) => [p.start, p.end, p.source])).toEqual([
      ['2023-05-02', '2023-12-31', 'worked-out'],
      ['2024-01-01', '2024-12-31', 'worked-out'],
      ['2025-01-01', '2026-03-31', 'yours'],
      ['2026-04-01', '2027-03-31', 'worked-out'],
      ['2027-04-01', '2028-03-31', 'worked-out'],
    ]);
    // A shortened one cuts the worked-out period before it.
    const s = books({ incorporatedOn: '2023-05-02', accountingReferenceDate: '12-31', periods: [{ start: '2024-07-01', end: '2025-03-31' }] });
    expect(accountingPeriodsOf(s, '2025-06-01').map((p) => [p.start, p.end])).toEqual([
      ['2023-05-02', '2023-12-31'],
      ['2024-01-01', '2024-06-30'],
      ['2024-07-01', '2025-03-31'],
      ['2025-04-01', '2026-03-31'],
    ]);
  });

  it('a period over 18 months, overlapping periods, and a period before incorporation are problems (s392(5))', () => {
    expect(booksProblems(books({ incorporatedOn: '2023-05-02', periods: [{ start: '2024-06-01', end: '2025-12-31' }] }))).toEqual([expect.stringContaining('longer than 18 months (CA 2006 s392(5))')]);
    expect(booksProblems(books({ incorporatedOn: '2023-05-02', periods: [{ start: '2024-06-01', end: '2025-11-30' }] }))).toEqual([]);
    expect(booksProblems(books({ incorporatedOn: '2023-05-02', periods: [{ start: '2024-01-01', end: '2024-12-31' }, { start: '2024-12-01', end: '2025-06-30' }] }))).toEqual([expect.stringContaining('overlap')]);
    expect(booksProblems(books({ incorporatedOn: '2023-05-02', periods: [{ start: '2023-01-01', end: '2023-12-31' }] }))).toEqual([expect.stringContaining('before the company was incorporated')]);
    expect(booksProblems(books({ incorporatedOn: '2023-05-02', ctPeriods: [{ start: '2024-01-01', end: '2025-01-31' }] }))).toEqual([expect.stringContaining('longer than 12 months (CTA 2009 s10(1)(a))')]);
  });
});

describe('accounts at Companies House (CA 2006 s442)', () => {
  it('9 months after the period, its month’s end to a month’s end (s442(2)(a), s443)', () => {
    expect(accountsFilingDeadline({ start: '2025-01-01', end: '2025-12-31' }, '2023-05-02')).toBe('2026-09-30');
    expect(accountsFilingDeadline({ start: '2025-07-01', end: '2026-06-30' }, '2023-05-02')).toBe('2027-03-31');
    expect(accountsFilingDeadline({ start: '2025-05-29', end: '2026-05-28' }, '2023-05-02')).toBe('2027-02-28');
    expect(accountsFilingDeadline({ start: '2027-05-30', end: '2028-05-29' }, '2023-05-02')).toBe('2029-02-28');
    expect(accountsFilingDeadline({ start: '2026-05-30', end: '2027-05-29' }, '2023-05-02')).toBe('2028-02-29');
  });

  it('a first period longer than 12 months: the later of 9 months from the first anniversary and 3 months from its end (s442(3))', () => {
    // 21 months from incorporation, not 9 months from the end (31 December 2025).
    expect(accountsFilingDeadline({ start: '2024-03-15', end: '2025-03-31' }, '2024-03-15')).toBe('2025-12-15');
    // 18 months: 9 months from 1 January 2025 is 1 October; 3 months from 30 June 2025 is 30 September.
    expect(accountsFilingDeadline({ start: '2024-01-01', end: '2025-06-30' }, '2024-01-01')).toBe('2025-10-01');
    // An anniversary on a month's end runs to a month's end.
    expect(accountsFilingDeadline({ start: '2023-04-30', end: '2024-04-30' }, '2023-04-30')).toBe('2025-01-31');
    expect(accountsFilingDeadline({ start: '2024-01-31', end: '2025-01-31' }, '2024-01-31')).toBe('2025-10-31');
    // A first period of 12 months exactly is not longer than 12 months.
    expect(accountsFilingDeadline({ start: '2024-04-01', end: '2025-03-31' }, '2024-04-01')).toBe('2025-12-31');
    // A 29 February incorporation: the first anniversary taken as 28 February, a month's end.
    expect(accountsFilingDeadline({ start: '2024-02-29', end: '2025-02-28' }, '2024-02-29')).toBe('2025-11-30');
  });

  it('a first period shorter than 12 months is due 9 months after it ends', () => {
    const d = companyDeadlines({ books: books({ incorporatedOn: '2024-03-15', accountingReferenceDate: '12-31' }) }, '2025-01-10');
    expect(short(of(d, 'accounts'))).toEqual([
      ['2024-03-15', '2024-12-31', '2025-09-30'],
      ['2025-01-01', '2025-12-31', '2026-09-30'],
    ]);
    expect(of(d, 'accounts')[0]!.rule).toBe('CA 2006 s442(2)(a)');
  });
});

describe('Corporation Tax (CTA 2009 ss9–10, TMA 1970 s59D, FA 1998 Sch 18 para 14)', () => {
  it('a period of account longer than 12 months is two accounting periods, both returns due 12 months after it ends', () => {
    const b = books({ incorporatedOn: '2024-03-15' });
    const d = companyDeadlines({ books: b }, '2025-04-10');
    expect(short(of(d, 'ct600'))).toEqual([
      ['2024-03-15', '2025-03-14', '2026-03-31'],
      ['2025-03-15', '2025-03-31', '2026-03-31'],
      ['2025-04-01', '2026-03-31', '2027-03-31'],
    ]);
    expect(short(of(d, 'ct-payment'))).toEqual([
      ['2024-03-15', '2025-03-14', '2025-12-15'],
      ['2025-03-15', '2025-03-31', '2026-01-01'],
      ['2025-04-01', '2026-03-31', '2027-01-01'],
    ]);
  });

  it('HMRC’s CT600 filing date examples (CTM93050, examples 1, 3 and 4)', () => {
    expect(ct600Due({ end: '2018-12-31' }, { start: '2018-01-01', end: '2018-12-31' })).toBe('2019-12-31');
    // 15 months to 31 March 2019: both returns by 31 March 2020.
    expect(ct600Due({ end: '2018-12-31' }, { start: '2018-01-01', end: '2019-03-31' })).toBe('2020-03-31');
    expect(ct600Due({ end: '2019-03-31' }, { start: '2018-01-01', end: '2019-03-31' })).toBe('2020-03-31');
    // 20 months from 1 May 2018: 30 months from its beginning.
    expect(ct600Due({ end: '2019-04-30' }, { start: '2018-05-01', end: '2019-12-31' })).toBe('2020-10-31');
    expect(ct600Due({ end: '2019-12-31' }, { start: '2018-05-01', end: '2019-12-31' })).toBe('2020-12-31');
  });

  it('the first accounting period starts when it came within the charge, interest alone included (s9); starting to trade ends one (s10(1)(d))', () => {
    const later = ctPeriodsOf(books({ incorporatedOn: '2024-03-15', accountingReferenceDate: '03-31', withinChargeFrom: '2024-09-02', tradeStartedOn: '2024-09-02' }), '2025-05-01');
    expect(later.map((p) => [p.start, p.end])).toEqual([
      ['2024-09-02', '2025-03-31'],
      ['2025-04-01', '2026-03-31'],
    ]);
    // Not trading yet, but earning interest from incorporation: within the charge, with a period break when trade starts.
    const pre = ctPeriodsOf(books({ incorporatedOn: '2024-03-15', accountingReferenceDate: '03-31', tradeStartedOn: '2024-11-04' }), '2025-05-01');
    expect(pre.map((p) => [p.start, p.end])).toEqual([
      ['2024-03-15', '2024-11-03'],
      ['2024-11-04', '2025-03-31'],
      ['2025-04-01', '2026-03-31'],
    ]);
    // Trade not started (null) does not make it dormant: it is within the charge from incorporation, assumed.
    expect(ctPeriodsOf(books({ incorporatedOn: '2024-03-15', tradeStartedOn: null }), '2026-05-01').length).toBeGreaterThan(0);
    expect(withinChargeAssumed(books({ incorporatedOn: '2024-03-15' }))).toBe(true);
    expect(withinChargeAssumed(books({ incorporatedOn: '2024-03-15', withinChargeFrom: '2024-03-15' }))).toBe(false);
    // Dormant for Corporation Tax (null): no CT600 or payment, unless periods are set (HMRC's notice).
    expect(ctPeriodsOf(books({ incorporatedOn: '2024-03-15', withinChargeFrom: null }), '2026-05-01')).toEqual([]);
    expect(of(companyDeadlines({ books: books({ incorporatedOn: '2024-03-15', withinChargeFrom: null }) }, '2026-05-01'), 'ct600')).toEqual([]);
    expect(ctPeriodsOf(books({ incorporatedOn: '2024-03-15', withinChargeFrom: null, ctPeriods: [{ start: '2025-04-01', end: '2026-03-31' }] }), '2026-05-01').map((p) => p.start)).toEqual(['2025-04-01']);
    // Trading before it came within the charge, or while dormant, is a problem.
    expect(booksProblems(books({ incorporatedOn: '2024-03-15', withinChargeFrom: '2024-06-01', tradeStartedOn: '2024-05-01' }))).toEqual([expect.stringContaining('trading brings a company within the charge')]);
    expect(booksProblems(books({ incorporatedOn: '2024-03-15', withinChargeFrom: null, tradeStartedOn: '2024-05-01' }))).toEqual([expect.stringContaining('not dormant for Corporation Tax')]);
    const set = ctPeriodsOf(books({ incorporatedOn: '2024-03-15', ctPeriods: [{ start: '2024-04-01', end: '2025-03-31' }] }), '2025-05-01');
    expect(set.map((p) => [p.start, p.end, p.source])).toEqual([
      ['2024-03-15', '2024-03-31', 'worked-out'],
      ['2024-04-01', '2025-03-31', 'yours'],
      ['2025-04-01', '2026-03-31', 'worked-out'],
    ]);
  });

  it('Corporation Tax is done when paid, or when its CT600 says there is nothing to pay', () => {
    const b = books({
      incorporatedOn: '2024-04-01',
      accountingReferenceDate: '03-31',
      filings: [
        filing({ kind: 'ct600', periodStart: '2024-04-01', periodEnd: '2025-03-31', filedOn: '2026-02-10', figures: { taxPayable: 0 } }),
        filing({ kind: 'ct-payment', periodStart: '2025-04-01', periodEnd: '2026-03-31', filedOn: '2027-01-05', figures: { amount: 1234.5 } }),
      ],
    });
    const d = of(companyDeadlines({ books: b }, '2027-02-01'), 'ct-payment');
    expect(d[0]).toMatchObject({ status: 'done', nothingToPay: true });
    expect(d[0]!.filedLate).toBeUndefined();
    expect(d[1]).toMatchObject({ status: 'done', due: '2027-01-01', filedLate: true });
  });

  it('a £0 payment says there is nothing to pay: done, and never late, though recorded after the day', () => {
    const b = books({ incorporatedOn: '2024-04-01', accountingReferenceDate: '03-31', filings: [filing({ kind: 'ct-payment', periodStart: '2024-04-01', periodEnd: '2025-03-31', filedOn: '2026-02-20', figures: { amount: 0 } })] });
    const [first] = of(companyDeadlines({ books: b }, '2026-03-01'), 'ct-payment');
    expect(first).toMatchObject({ status: 'done', due: '2026-01-01', nothingToPay: true });
    expect(first!.filedLate).toBeUndefined();
    expect(companyDeadlineAlerts({ id: 'x', name: 'Example Ltd' }, companyDeadlines({ books: b }, '2026-03-01')).some((a) => a.id.includes('ct-payment:2025-03-31'))).toBe(false);
    // A negative payment is not one.
    expect(CompanyFilingSchema.safeParse({ id: 'fil_000000000abc', kind: 'ct-payment', periodEnd: '2025-03-31', filedOn: '2026-01-02', figures: { amount: -1 } }).success).toBe(false);
  });
});

describe('VAT returns (VAT Regulations 1995 regs 25, 25A(20), 50)', () => {
  it('the three quarterly staggers end in HMRC’s months, and monthly returns each month', () => {
    expect(vatPeriodEnd('quarterly-1', '2026-04-14')).toBe('2026-06-30');
    expect(vatPeriodEnd('quarterly-2', '2026-04-14')).toBe('2026-04-30');
    expect(vatPeriodEnd('quarterly-2', '2026-05-01')).toBe('2026-07-31');
    expect(vatPeriodEnd('quarterly-3', '2026-04-14')).toBe('2026-05-31');
    expect(vatPeriodEnd('quarterly-3', '2026-12-02')).toBe('2027-02-28');
    expect(vatPeriodEnd('monthly', '2028-02-03')).toBe('2028-02-29');
  });

  it('a return is due 1 month and 7 days after its period, whatever the day', () => {
    expect(vatReturnDue({ start: '2026-01-01', end: '2026-03-31' }, 'quarterly-1')).toBe('2026-05-07');
    expect(vatReturnDue({ start: '2026-02-01', end: '2026-04-30' }, 'quarterly-2')).toBe('2026-06-07');
    expect(vatReturnDue({ start: '2025-12-01', end: '2026-02-28' }, 'quarterly-3')).toBe('2026-04-07');
    expect(vatReturnDue({ start: '2026-01-01', end: '2026-01-31' }, 'monthly')).toBe('2026-03-07');
    // 7 March 2026 is a Saturday: the day does not move.
    expect(vatReturnDue({ start: '2025-12-01', end: '2026-01-31' }, 'quarterly-2')).toBe('2026-03-07');
  });

  it('a period not ending on a month’s end: the last day of the month after, and 7 days (reg 25(1))', () => {
    expect(vatReturnDue({ start: '2025-11-14', end: '2026-02-10' }, 'quarterly-1')).toBe('2026-04-07');
    expect(vatReturnDue({ start: '2025-02-14', end: '2025-06-15' }, 'quarterly-1')).toBe('2025-08-07');
    expect(vatReturnDue({ start: '2026-01-05', end: '2026-01-04' }, 'monthly')).toBe('2026-03-07');
  });

  it('under annual accounting, by the last working day of the second month after the year (reg 50(2)(b)); 1 month for a period under 4 months', () => {
    expect(vatReturnDue({ start: '2026-04-01', end: '2027-03-31' }, 'annual')).toBe('2027-05-28');
    expect(vatReturnDue({ start: '2025-07-01', end: '2026-06-30' }, 'annual')).toBe('2026-08-28');
    expect(vatReturnDue({ start: '2026-01-01', end: '2026-03-31' }, 'annual')).toBe('2026-04-30');
    expect(vatReturnDue({ start: '2026-01-01', end: '2026-04-30' }, 'annual')).toBe('2026-06-30');
  });

  it('the first period runs from registration; a schedule change starts a period on its day; deregistration ends the last', () => {
    const vat = CompanyVatSchema.parse({ registeredFrom: '2025-02-14', scheme: 'cash', schedule: [{ from: '2025-02-14', stagger: 'monthly' }, { from: '2025-06-01', stagger: 'quarterly-1' }], deregisteredOn: '2026-02-10' });
    expect(vatPeriodsOf({ vat }, '2026-11-26').map((p) => [p.start, p.end, p.stagger])).toEqual([
      ['2025-02-14', '2025-02-28', 'monthly'],
      ['2025-03-01', '2025-03-31', 'monthly'],
      ['2025-04-01', '2025-04-30', 'monthly'],
      ['2025-05-01', '2025-05-31', 'monthly'],
      ['2025-06-01', '2025-06-30', 'quarterly-1'],
      ['2025-07-01', '2025-09-30', 'quarterly-1'],
      ['2025-10-01', '2025-12-31', 'quarterly-1'],
      ['2026-01-01', '2026-02-10', 'quarterly-1'],
    ]);
  });

  it('a first period HMRC set, and a filed return’s own dates, win', () => {
    const vat = CompanyVatSchema.parse({ registeredFrom: '2025-02-14', scheme: 'cash', schedule: [{ from: '2025-02-14', stagger: 'quarterly-1' }], firstPeriodEnd: '2025-06-30' });
    const filings = [filing({ kind: 'vat', periodStart: '2025-07-01', periodEnd: '2025-10-31', filedOn: '2025-12-01' })];
    expect(vatPeriodsOf({ vat, filings }, '2026-01-15').map((p) => [p.start, p.end, Boolean(p.filing)])).toEqual([
      ['2025-02-14', '2025-06-30', false],
      ['2025-07-01', '2025-10-31', true],
      ['2025-11-01', '2025-12-31', false],
      ['2026-01-01', '2026-03-31', false],
    ]);
  });

  it('annual accounting runs in years from its schedule entry', () => {
    const vat = CompanyVatSchema.parse({ registeredFrom: '2025-04-01', scheme: 'cash', schedule: [{ from: '2025-04-01', stagger: 'annual' }] });
    const d = of(companyDeadlines({ books: books({ incorporatedOn: '2024-03-15', vat }) }, '2026-06-01'), 'vat');
    expect(short(d)).toEqual([
      ['2025-04-01', '2026-03-31', '2026-05-29'],
      ['2026-04-01', '2027-03-31', '2027-05-28'],
    ]);
  });

  it('only the cash accounting scheme is taken, for now', () => {
    for (const scheme of ['accrual', 'flat-rate']) {
      const r = CompanyVatSchema.safeParse({ registeredFrom: '2025-04-01', scheme, schedule: [{ from: '2025-04-01', stagger: 'monthly' }] });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0]!.message).toContain('not supported yet');
    }
  });
});

describe('rules as dated rows', () => {
  it('each period takes the row in force by its date, never a later one', () => {
    const rows = [
      { from: '2008-04-06', months: 9 },
      { from: '2030-01-01', months: 6 },
    ];
    expect(ruleOn(rows, '2025-12-31').months).toBe(9);
    expect(ruleOn(rows, '2030-01-01').months).toBe(6);
    // Before the first row: the first (earlier rules are not covered).
    expect(ruleOn(rows, '2001-01-01').months).toBe(9);
    for (const table of [ACCOUNTS_FILING_RULES, CONFIRMATION_STATEMENT_RULES, CT_PAYMENT_RULES, CT_RETURN_RULES, VAT_RETURN_RULES]) {
      expect(table.length).toBeGreaterThan(0);
      expect([...table].map((r) => r.from)).toEqual([...table].map((r) => r.from).sort());
    }
  });
});

describe('confirmation statements (CA 2006 s853A)', () => {
  it('made up to the last day of each 12-month review period, due 14 days after', () => {
    const d = of(companyDeadlines({ books: books({ incorporatedOn: '2023-05-02' }) }, '2024-06-01'), 'confirmation');
    expect(short(d)).toEqual([
      ['2023-05-02', '2024-05-01', '2024-05-15'],
      ['2024-05-02', '2025-05-01', '2025-05-15'],
    ]);
    expect(d.map((x) => x.status)).toEqual(['overdue', 'upcoming']);
    expect(confirmationStatementDue('2026-12-20')).toBe('2027-01-03');
  });

  it('one made up early starts the next review period the day after (s853A(6))', () => {
    const b = books({ incorporatedOn: '2023-05-02', filings: [filing({ kind: 'confirmation', periodEnd: '2024-03-10', filedOn: '2024-03-10' })] });
    expect(short(of(companyDeadlines({ books: b }, '2024-06-01'), 'confirmation'))).toEqual([
      ['2023-05-02', '2024-03-10', '2024-05-15'],
      ['2024-03-11', '2025-03-10', '2025-03-24'],
    ]);
  });

  it('one made up early is due 14 days after its review period, not its made-up date (s853A(1))', () => {
    // Made up on 10 March, filed on 20 April: within 14 days of the review period's end (1 May), not late.
    const b = books({ incorporatedOn: '2023-05-02', filings: [filing({ kind: 'confirmation', periodEnd: '2024-03-10', filedOn: '2024-04-20' })] });
    const [first] = of(companyDeadlines({ books: b }, '2024-06-01'), 'confirmation');
    expect(first).toMatchObject({ status: 'done', due: '2024-05-15' });
    expect(first!.filedLate).toBeUndefined();
    // Filed after it, late.
    const late = books({ incorporatedOn: '2023-05-02', filings: [filing({ kind: 'confirmation', periodEnd: '2024-03-10', filedOn: '2024-05-16' })] });
    expect(of(companyDeadlines({ books: late }, '2024-06-01'), 'confirmation')[0]).toMatchObject({ filedLate: true });
  });

  it('the next made-up date Companies House shows anchors the chain; statements before it are settled', () => {
    const b = books({ incorporatedOn: '2018-09-20', confirmationStatement: { nextMadeUpTo: '2026-10-05' }, filings: [filing({ kind: 'confirmation', periodEnd: '2025-10-05', filedOn: '2025-10-12' })] });
    const d = of(companyDeadlines({ books: b }, '2026-11-26'), 'confirmation');
    expect(d.map((x) => [x.period.end, x.due, x.status])).toEqual([
      ['2025-10-05', '2025-10-19', 'done'],
      ['2026-10-05', '2026-10-19', 'overdue'],
      ['2027-10-05', '2027-10-19', 'upcoming'],
    ]);
  });
});

describe('deadlines and what was filed', () => {
  const b = books({
    incorporatedOn: '2023-05-02',
    accountingReferenceDate: '12-31',
    vat: { registeredFrom: '2024-04-01', scheme: 'cash', schedule: [{ from: '2024-04-01', stagger: 'quarterly-1' }] },
    filings: [
      filing({ kind: 'accounts', periodStart: '2023-05-02', periodEnd: '2023-12-31', filedOn: '2024-08-01', figures: { B: 1234, K: 2345 } }),
      filing({ kind: 'vat', periodStart: '2024-04-01', periodEnd: '2024-06-30', filedOn: '2024-08-16', reference: '481516234' }),
    ],
  });

  it('a filing that matches a deadline does it, marked late when filed after its day', () => {
    const d = companyDeadlines({ books: b }, '2024-10-01');
    expect(d.find((x) => x.id === 'accounts:2023-12-31')).toMatchObject({ status: 'done', due: '2024-09-30' });
    expect(d.find((x) => x.id === 'accounts:2023-12-31')!.filedLate).toBeUndefined();
    expect(d.find((x) => x.id === 'vat:2024-06-30')).toMatchObject({ status: 'done', due: '2024-08-07', filedLate: true });
  });

  it('overdue after its day, due soon within 60 days, upcoming beyond', () => {
    const d = companyDeadlines({ books: b }, '2024-10-01');
    expect(d.find((x) => x.id === 'confirmation:2024-05-01')).toMatchObject({ status: 'overdue', due: '2024-05-15', days: -139 });
    expect(d.find((x) => x.id === 'ct-payment:2023-12-31')).toMatchObject({ status: 'due-soon', due: '2024-10-01', days: 0 });
    expect(d.find((x) => x.id === 'vat:2024-09-30')).toMatchObject({ status: 'due-soon', due: '2024-11-07', days: 37 });
    expect(d.find((x) => x.id === 'ct600:2023-12-31')).toMatchObject({ status: 'upcoming', due: '2024-12-31', days: 91 });
    // On the 60th day it is due soon; the 61st, upcoming.
    expect(companyDeadlines({ books: b }, '2024-11-01').find((x) => x.id === 'ct600:2023-12-31')!.status).toBe('due-soon');
    expect(companyDeadlines({ books: b }, '2024-10-31').find((x) => x.id === 'ct600:2023-12-31')!.status).toBe('upcoming');
  });

  it('a filing matching no period is listed, not lost; deadlines before deadlinesFrom and not done are left out', () => {
    const odd = books({ ...b, filings: [...b.filings, filing({ kind: 'accounts', periodStart: '2024-01-01', periodEnd: '2024-11-30', filedOn: '2025-03-01' })] });
    const d = companyDeadlines({ books: odd }, '2025-04-01');
    expect(d.filter((x) => x.unmatched).map((x) => x.kind)).toEqual(['accounts']);
    const from = companyDeadlines({ books: books({ ...b, deadlinesFrom: '2025-01-01' }) }, '2025-04-01');
    expect(from.every((x) => x.status === 'done' || x.due >= '2025-01-01')).toBe(true);
    expect(from.some((x) => x.id === 'accounts:2023-12-31')).toBe(true);
  });

  it('the Overview’s alerts: due soon or overdue, named with the company, warnings from 14 days', () => {
    const alerts = companyDeadlineAlerts({ id: 'example-studio', name: 'Example Studio Ltd' }, companyDeadlines({ books: b }, '2024-10-01'));
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) expect(a.title.startsWith('Example Studio Ltd: ')).toBe(true);
    expect(alerts.find((a) => a.id === 'company-example-studio-vat:2024-09-30')).toMatchObject({ level: 'info', action: { href: '/company/example-studio' } });
    expect(alerts.find((a) => a.id === 'company-example-studio-ct-payment:2023-12-31')).toMatchObject({ level: 'warning' });
  });

  it('a write is refused only for problems it adds, so a hand edit can be put right one problem at a time', () => {
    const two = { ...b, periods: [{ start: '2024-01-01', end: '2025-12-31' }], ctPeriods: [{ start: '2024-01-01', end: '2025-03-31' }] };
    expect(booksProblems(two)).toHaveLength(2);
    // Fixing one and adding none: nothing added.
    expect(addedBooksProblems(two, { ...two, periods: [] })).toEqual([]);
    // Recording a filing beside them adds none either.
    expect(addedBooksProblems(two, { ...two, filings: [...b.filings, filing({ kind: 'confirmation', periodEnd: '2024-05-01', filedOn: '2024-05-02' })] })).toEqual([]);
    // A new problem is the write's.
    expect(addedBooksProblems(two, { ...two, tradeStartedOn: '2020-01-01' })).toEqual([expect.stringContaining('before the company was incorporated')]);
    expect(addedBooksProblems(undefined, two)).toHaveLength(2);
  });

  it('filings are checked: VAT boxes add up, one per kind and period, filed after the period', () => {
    const boxes = { vatDueSales: 2468.1, vatDueAcquisitions: 0, totalVatDue: 2468.1, vatReclaimedCurrPeriod: 812.45, netVatDue: 1655.65, totalValueSalesExVAT: 12341, totalValuePurchasesExVAT: 4062, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0 };
    const ok = filing({ kind: 'vat', periodStart: '2024-07-01', periodEnd: '2024-09-30', filedOn: '2024-10-20', figures: boxes });
    expect(booksProblems({ ...b, filings: [ok] })).toEqual([]);
    expect(booksProblems({ ...b, filings: [{ ...ok, figures: { ...boxes, netVatDue: 1655.66 } } as CompanyFiling] })).toEqual([expect.stringContaining('box 5')]);
    expect(booksProblems({ ...b, filings: [{ ...ok, figures: { ...boxes, totalVatDue: 2468.11 } } as CompanyFiling] })).toEqual(expect.arrayContaining([expect.stringContaining('box 3')]));
    expect(booksProblems({ ...b, filings: [ok, { ...ok, id: 'fil_00000000ffff' }] })).toEqual([expect.stringContaining('recorded twice')]);
    expect(booksProblems({ ...b, filings: [{ ...ok, filedOn: '2024-09-29' }] })).toEqual([expect.stringContaining('before its period ends')]);
    expect(MonthDaySchema.safeParse('02-30').success).toBe(false);
    expect(MonthDaySchema.safeParse('02-29').success).toBe(true);
  });
});

// ─── Properties ──────────────────────────────────────────────────────────────────────────────────

const day = (min: number, max: number) => fc.integer({ min, max }).map((t) => fromUTC(new Date(t * 86_400_000)));
const D2015 = Date.UTC(2015, 0, 1) / 86_400_000;
const D2024 = Date.UTC(2024, 0, 1) / 86_400_000;
const md = fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 })).map(([m, d]) => `${String(m).padStart(2, '0')}-${String(Math.min(d, [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!)).padStart(2, '0')}`);
const stagger = fc.constantFrom('monthly', 'quarterly-1', 'quarterly-2', 'quarterly-3', 'annual' as const);

/** Books with their deadlines' own periods filed, some late, some not at all. */
const world = fc
  .record({
    inc: day(D2015, D2024),
    ard: fc.option(md, { nil: undefined }),
    trade: fc.option(fc.integer({ min: 0, max: 400 }), { nil: undefined }),
    within: fc.option(fc.option(fc.integer({ min: 0, max: 300 }), { nil: null }), { nil: undefined }),
    vat: fc.option(fc.record({ after: fc.integer({ min: 0, max: 900 }), stagger, change: fc.option(fc.record({ after: fc.integer({ min: 30, max: 700 }), stagger }), { nil: undefined }) }), { nil: undefined }),
    today: fc.integer({ min: 0, max: 3000 }),
    files: fc.array(fc.tuple(fc.boolean(), fc.integer({ min: -20, max: 40 })), { minLength: 80, maxLength: 80 }),
  })
  .map((w) => {
    const vatFrom = w.vat ? addDays(w.inc, w.vat.after) : undefined;
    const base = books({
      incorporatedOn: w.inc,
      ...(w.ard ? { accountingReferenceDate: w.ard } : {}),
      // Within the charge from a day (trade no earlier), dormant (no trade), or not said.
      ...(w.within !== undefined ? { withinChargeFrom: w.within === null ? null : addDays(w.inc, w.within) } : {}),
      ...(w.trade !== undefined && w.within !== null ? { tradeStartedOn: addDays(w.inc, (w.within ?? 0) + w.trade) } : {}),
      ...(w.vat && vatFrom ? { vat: { registeredFrom: vatFrom, scheme: 'cash' as const, schedule: [{ from: vatFrom, stagger: w.vat.stagger }, ...(w.vat.change ? [{ from: addDays(vatFrom, w.vat.change.after), stagger: w.vat.change.stagger }] : [])] } } : {}),
    });
    const today = addDays(w.inc, w.today);
    // File what is worked out, some of it late, some of it never.
    const filings: CompanyFiling[] = companyDeadlines({ books: base }, today).flatMap((d, i) => {
      const [file, lateBy] = w.files[i % w.files.length]!;
      if (!file) return [];
      const filedOn = addDays(d.due, lateBy);
      if (filedOn < d.period.end || filedOn > today) return [];
      return [filing({ kind: d.kind, ...(d.period.start && d.kind !== 'confirmation' ? { periodStart: d.period.start } : {}), periodEnd: d.period.end, filedOn })];
    });
    return { books: { ...base, filings }, today };
  });

describe('properties', () => {
  it('every deadline is after its period ends', () => {
    fc.assert(
      fc.property(world, ({ books: b, today }) => {
        for (const d of companyDeadlines({ books: b }, today)) expect(d.due > d.period.end, `${d.id} due ${d.due}`).toBe(true);
      }),
      { numRuns: 300, seed: 20261126 },
    );
  });

  it('what is done does not depend on the order filings were recorded in', () => {
    // Filings of their own besides: some matching nothing, some several to a period (no start given).
    const extra = fc.array(fc.record({ kind: fc.constantFrom('accounts', 'ct600', 'ct-payment', 'vat', 'confirmation' as const), end: fc.integer({ min: 0, max: 3000 }), late: fc.integer({ min: 0, max: 90 }), start: fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }) }), { maxLength: 12 });
    fc.assert(
      fc.property(world, extra, fc.integer(), ({ books: base, today }, more, seed) => {
        const keys = new Set(base.filings.map((f) => `${f.kind}|${f.periodEnd}`));
        const added = more.flatMap((x) => {
          const periodEnd = addDays(base.incorporatedOn, x.end);
          if (keys.has(`${x.kind}|${periodEnd}`)) return [];
          keys.add(`${x.kind}|${periodEnd}`);
          return [filing({ kind: x.kind, ...(x.start !== undefined ? { periodStart: addDays(periodEnd, -x.start) } : {}), periodEnd, filedOn: addDays(periodEnd, x.late) })];
        });
        const b = { ...base, filings: [...base.filings, ...added] };
        const shuffled = [...b.filings].map((f, i) => ({ f, k: Math.sin(seed + i) })).sort((x, y) => x.k - y.k).map((x) => x.f);
        const a = companyDeadlines({ books: b }, today);
        const z = companyDeadlines({ books: { ...b, filings: shuffled } }, today);
        expect(z.map((d) => [d.id, d.status, d.filing?.id ?? null, d.filedLate ?? false])).toEqual(a.map((d) => [d.id, d.status, d.filing?.id ?? null, d.filedLate ?? false]));
      }),
      { numRuns: 200, seed: 20261127 },
    );
  });

  it('periods follow on from each other without gaps, and none is longer than the Acts allow', () => {
    fc.assert(
      fc.property(world, ({ books: b, today }) => {
        const aps = accountingPeriodsOf(b, today);
        aps.forEach((p, i) => {
          expect(p.end >= p.start).toBe(true);
          expect(p.end <= lastDayOfMonths(p.start, 18)).toBe(true);
          if (i) expect(p.start).toBe(addDays(aps[i - 1]!.end, 1));
        });
        const cts = ctPeriodsOf(b, today);
        cts.forEach((p, i) => {
          expect(p.end <= lastDayOfMonths(p.start, 12)).toBe(true);
          expect(p.periodOfAccount.start <= p.end && p.end <= p.periodOfAccount.end).toBe(true);
          if (i) expect(p.start).toBe(addDays(cts[i - 1]!.end, 1));
        });
        expect(booksProblems(b)).toEqual([]);
      }),
      { numRuns: 300, seed: 20261128 },
    );
  });
});
