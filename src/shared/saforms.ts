// The Self Assessment forms, box by box, as HMRC prints them for a tax year (docs/UK_RULES.md,
// "Self Assessment: the forms"). The labels are verbatim from the form, not the notes (the notes have
// errors: docs/UK_RULES.md). A new year's forms are a new catalogue here, never an edit to an old one.

/** How a box takes its value: money (whole pounds unless `pence`), an X, a Yes/No pair, text, a number, a date or a percentage. */
export type SaBoxKind = 'money' | 'x' | 'yesno' | 'text' | 'number' | 'date' | 'percent';

export interface SaBoxDef {
  /** The box number as printed ("2", "7.3", "Q1"). */
  box: string;
  label: string;
  kind: SaBoxKind;
  /**
   * How the figure is rounded for the form (the SA100's rules: income down, expenses and tax paid up,
   * whole pounds), or `pence` where the form takes pence. Money boxes only.
   */
  round?: 'down' | 'up' | 'pence';
  /** May be negative (a minus sign in the shaded box). */
  signed?: boolean;
  /** The printed page, where it is not the page's own (SA106's columns and totals run over F 2 and F 3). */
  page?: string;
}

export interface SaPageDef {
  id: string;
  form: 'SA100' | 'SA102' | 'SA106' | 'SA108' | 'SA110';
  /** The page as printed ("TR 3", "E 1"). */
  page: string;
  title: string;
  /** Section headings, each with its boxes in order. */
  sections: { heading: string; boxes: SaBoxDef[] }[];
}

export interface SaFormSet {
  /** The tax year the forms are for ("2025/26"), and the edition HMRC prints on them ("SA100 2026"). */
  taxYear: string;
  edition: string;
  pages: SaPageDef[];
}

const m = (box: string, label: string, round: SaBoxDef['round'] = 'down', extra: Partial<SaBoxDef> = {}): SaBoxDef => ({ box, label, kind: 'money', round, ...extra });

/** The 2025–26 forms (the 2026 editions), from HMRC's PDFs: docs/UK_RULES.md lists each with its URL. */
const FORMS_2025_26: SaFormSet = {
  taxYear: '2025/26',
  edition: '2026',
  pages: [
    {
      id: 'TR2',
      form: 'SA100',
      page: 'TR 2',
      title: 'What makes up your tax return',
      sections: [
        {
          heading: 'What makes up your tax return',
          boxes: [
            { box: 'Q1', label: 'Employment: were you an employee, director, office holder or agency worker in the year to 5 April 2026?', kind: 'yesno' },
            { box: 'Q1 number', label: 'Employment: number of ‘Employment’ pages', kind: 'number' },
            { box: 'Q2', label: 'Self-employment: do you need to fill in the ‘Self-employment’ pages?', kind: 'yesno' },
            { box: 'Q3', label: 'Partnership: were you in a partnership?', kind: 'yesno' },
            { box: 'Q4', label: 'UK property: do you need to fill in the ‘UK property’ pages?', kind: 'yesno' },
            { box: 'Q5', label: 'Foreign: do you need to fill in the ‘Foreign’ pages?', kind: 'yesno' },
            { box: 'Q6', label: 'Trusts etc: did you receive, or are you treated as having received, income from a trust, settlement or the residue of a deceased person’s estate?', kind: 'yesno' },
            { box: 'Q7', label: 'Capital Gains Tax summary: do you need to fill in the ‘Capital Gains Tax summary’ page and provide computations?', kind: 'yesno' },
            { box: 'Q8', label: 'Residence and foreign income and gains (FIG) regime etc: do you need to fill in a ‘Residence and foreign income and gains (FIG) regime etc’ page?', kind: 'yesno' },
            { box: 'Q9', label: 'Additional information: do you need to fill in the ‘Additional information’ pages?', kind: 'yesno' },
          ],
        },
      ],
    },
    {
      id: 'TR3',
      form: 'SA100',
      page: 'TR 3',
      title: 'Income',
      sections: [
        {
          heading: 'Dividends and interest from UK banks and building societies',
          boxes: [
            m('1', 'Taxed UK interest – the net amount after tax has been taken off - read the notes'),
            m('2', 'Untaxed UK interest – amounts which have not had tax taken off - read the notes'),
            m('3', 'Untaxed foreign interest (up to £2,000) – amounts which have not had tax taken off - read the notes'),
            m('4', 'Dividends from UK companies – the amount received - read the notes'),
            m('5', 'Other dividends – the amount received - read the notes'),
            m('6', 'Foreign dividends (up to £500) – the amount in sterling after foreign tax was taken off. Do not include this amount in the ‘Foreign’ pages'),
            m('7', 'Tax taken off foreign dividends – the sterling equivalent', 'up'),
          ],
        },
        {
          heading: 'UK pensions, annuities and other state benefits received',
          boxes: [
            m('8', 'State Pension – amount you were entitled to receive in the year, not the weekly or 4-weekly amount - read the notes'),
            m('11', 'Pensions (other than State Pension), retirement annuities and taxable lump sums treated as pensions – the gross amount. Tax taken off goes in box 12'),
            m('12', 'Tax taken off box 11', 'up', { signed: true }),
            m('13', 'Taxable Incapacity Benefit and contribution-based Employment and Support Allowance - read the notes'),
            m('14', 'Tax taken off Incapacity Benefit in box 13', 'up'),
            m('15', 'Jobseeker’s Allowance'),
            m('16', 'Total of any other taxable State Pensions and benefits'),
          ],
        },
        {
          heading: 'Other UK income not included on supplementary pages',
          boxes: [m('17', 'Other taxable income – before expenses and tax taken off'), m('18', 'Total amount of allowable expenses – read the notes', 'up'), m('19', 'Any tax taken off box 17', 'up'), { box: '21', label: 'Description of income in boxes 17 and 20', kind: 'text' }],
        },
      ],
    },
    {
      id: 'TR4',
      form: 'SA100',
      page: 'TR 4',
      title: 'Tax reliefs',
      sections: [
        {
          heading: 'Paying into registered pension schemes and overseas pension schemes',
          boxes: [
            m('1', 'Payments to registered pension schemes where basic rate tax relief will be claimed by your pension provider (called ‘relief at source’). Enter the payments and basic rate tax', 'up'),
            m('1.1', 'Total of any ‘one-off’ payments in box 1', 'up'),
            m('3', 'Payments to your employer’s scheme which were not deducted from your pay before tax – this will be unusual - read the notes', 'up'),
          ],
        },
        {
          heading: 'Charitable giving',
          boxes: [
            m('5', 'Gift Aid payments made in the year to 5 April 2026', 'up'),
            m('6', 'Total of any ‘one-off’ payments in box 5', 'up'),
            m('7', 'Gift Aid payments made in the year to 5 April 2026 but treated as if made in the year to 5 April 2025', 'up'),
            m('8', 'Gift Aid payments made after 5 April 2026 but to be treated as if made in the year to 5 April 2026', 'up'),
          ],
        },
      ],
    },
    {
      id: 'TR5',
      form: 'SA100',
      page: 'TR 5',
      title: 'Student loans, Child Benefit and Marriage Allowance',
      sections: [
        {
          heading: 'Student Loan and Postgraduate Loan repayments',
          boxes: [
            { box: 'SL1', label: 'If you’ve received notification from Student Loans Company that your repayment of an Income Contingent Loan was due before 6 April 2026, put ‘X’ in the box. We’ll use your plan and or loan type to calculate amounts due', kind: 'x' },
            m('SL2', 'If your employer has deducted Student Loan repayments enter the amount deducted', 'up'),
            m('SL3', 'If your employer has deducted Postgraduate Loan repayments enter the amount deducted', 'up'),
          ],
        },
        {
          heading: 'High Income Child Benefit Charge',
          boxes: [
            m('CB1', 'Enter the total amount of Child Benefit you and your partner got for the year to 5 April 2026'),
            { box: 'CB2', label: 'Enter the number of children you and your partner got Child Benefit for on 5 April 2026', kind: 'number' },
            { box: 'CB3', label: 'Enter the date that you and your partner stopped getting all Child Benefit payments if this was before 6 April 2026', kind: 'date' },
          ],
        },
        {
          heading: 'Marriage Allowance',
          boxes: [{ box: 'MA1–5', label: 'Your spouse or civil partner’s first name, last name, National Insurance number, date of birth, and the date of marriage or civil partnership', kind: 'text' }],
        },
      ],
    },
    {
      id: 'TR6',
      form: 'SA100',
      page: 'TR 6',
      title: 'Finishing your tax return',
      sections: [
        { heading: 'Tax refunded or set off', boxes: [m('1', 'If you’ve had any 2025–26 Income Tax refunded or set off by us or Jobcentre Plus, enter the amount - read the notes', 'down')] },
        {
          heading: 'If you have not paid enough tax',
          boxes: [
            {
              box: '2',
              label: 'If you owe less than £3,000 for the 2025–26 tax year (excluding Class 2 NICs) and you send us your paper tax return by 31 October, or 30 December 2026 if you file online, we’ll try to collect the tax through your wages or pension by adjusting your 2027–28 tax code. If you do not want us to do this, put ‘X’ in the box - read the notes',
              kind: 'x',
            },
            {
              box: '3',
              label: 'If you owe tax on savings, casual earnings and/or the High Income Child Benefit Charge for the 2026–27 tax year, we’ll try to collect it through your wages or pension by adjusting your 2026–27 tax code. If you do not want us to do this, put ‘X’ in the box - read the notes',
              kind: 'x',
            },
          ],
        },
      ],
    },
    {
      id: 'SA102',
      form: 'SA102',
      page: 'E 1',
      title: 'Employment',
      sections: [
        {
          heading: 'Complete an ‘Employment’ page for each employment or directorship',
          boxes: [
            m('1', 'Pay from this employment – the total from your P45 or P60 – before tax was taken off'),
            m('1.1', 'Payrolled benefits included in box 1 which affect your student loan repayments – read the notes'),
            m('2', 'UK tax taken off pay in box 1', 'up', { signed: true }),
            m('3', 'Tips and other payments not on your P60'),
            { box: '4', label: 'PAYE tax reference of your employer (on your P45/P60)', kind: 'text' },
            { box: '5', label: 'Your employer’s name', kind: 'text' },
            { box: '6', label: 'Were you a director of this company – you must put ‘X’ in one of these boxes', kind: 'yesno' },
            { box: '6.1', label: 'If you ceased being a director before 6 April 2026, put the date the directorship ceased in the box', kind: 'date' },
            { box: '7', label: 'Was this company a close company – you must put ‘X’ in one of these boxes', kind: 'yesno' },
            { box: '7.1', label: 'Name of this close company', kind: 'text' },
            { box: '7.2', label: 'Registration number of this close company', kind: 'text' },
            m('7.3', 'Dividends you received from this close company'),
            { box: '7.4', label: 'Percentage shareholding in this close company', kind: 'percent' },
            { box: '8', label: 'If this employment income is from inside off-payroll working engagements, put ‘X’ in the box – read the notes', kind: 'x' },
          ],
        },
        {
          heading: 'Benefits from your employment – use your form P11D (or equivalent information)',
          boxes: [
            m('9', 'Company cars and vans'),
            m('10', 'Fuel for company cars and vans'),
            m('11', 'Private medical and dental insurance'),
            m('12', 'Vouchers, credit cards and excess mileage allowance'),
            m('13', 'Goods and other assets provided by your employer'),
            m('14', 'Accommodation provided by your employer'),
            m('15', 'Other benefits (including interest-free and low interest loans)'),
            m('16', 'Expenses payments received and balancing charges'),
          ],
        },
        {
          heading: 'Employment expenses',
          boxes: [m('17', 'Business travel and subsistence expenses', 'up'), m('18', 'Fixed deductions for expenses', 'up'), m('19', 'Professional fees and subscriptions', 'up'), m('20', 'Other expenses and capital allowances', 'up')],
        },
      ],
    },
    {
      id: 'SA106',
      form: 'SA106',
      page: 'F 2',
      title: 'Foreign: dividends from foreign companies',
      sections: [
        {
          heading: 'Dividends from foreign companies (one row per country)',
          boxes: [
            { box: 'A', label: 'Country or territory code', kind: 'text' },
            m('B', 'Amount of income arising or received before any tax taken off'),
            m('C', 'Foreign tax taken off or paid', 'up'),
            { box: 'E', label: 'To claim Foreign Tax Credit Relief – put ‘X’ in the box', kind: 'x', page: 'F 3' },
            m('F', 'Taxable amount – if you’re claiming Foreign Tax Credit Relief, copy column B here. If not, enter column B minus column C', 'down', { page: 'F 3' }),
            m('5', 'Total of column above (column D)', 'up', { page: 'F 3' }),
            m('6', 'Total of column above (column F)', 'down', { page: 'F 3' }),
          ],
        },
        { heading: 'Foreign Tax Credit Relief', boxes: [m('2', 'If you’re calculating your tax, enter the total Foreign Tax Credit Relief on your income', 'pence', { page: 'F 1' })] },
      ],
    },
    {
      id: 'SA108',
      form: 'SA108',
      page: 'CG 2',
      title: 'Capital Gains Tax summary: listed shares and securities',
      sections: [
        {
          heading: 'Listed shares and securities',
          boxes: [
            { box: '23', label: 'Number of disposals', kind: 'number' },
            m('24', 'Disposal proceeds'),
            m('25', 'Allowable costs (including purchase price)', 'up'),
            m('26', 'Gains in the year, before losses – any gains included in box 29 amounts must be included in this total'),
            m('27', 'Losses in the year – any losses included in box 29 amounts must be included in this total', 'up'),
          ],
        },
        { heading: 'Losses set against 2025–26 capital gains', boxes: [m('45', 'Losses brought forward and used in-year', 'up', { page: 'CG 3' })] },
        { heading: '2025–26 capital losses – other information', boxes: [m('47', 'Losses available to be carried forward', 'up', { page: 'CG 3' })] },
        { heading: 'Any other information', boxes: [{ box: '53', label: 'If your computations include any estimates or valuations, put ‘X’ in the box', kind: 'x', page: 'CG 4' }] },
      ],
    },
    {
      id: 'SA110',
      form: 'SA110',
      page: 'TC 1',
      title: 'Tax calculation summary: underpaid tax and payments on account',
      sections: [
        {
          heading: 'Underpaid tax and other debts',
          boxes: [
            m('7', 'Underpaid tax for earlier years included in your tax code for 2025–26 – enter the amount shown as ‘amount of underpaid tax for earlier years’ from your P2, ‘PAYE Coding Notice’', 'pence'),
            m('8', 'Underpaid tax for 2025–26 included in your tax code for 2026–27 – enter the amount shown as ‘estimated underpayment for 2025–26’ from your P2, ‘PAYE Coding Notice’', 'pence'),
            m('9', 'Outstanding debt included in your tax code for 2025–26 – enter the amount from your P2, ‘PAYE Coding Notice’', 'pence'),
          ],
        },
        {
          heading: 'Payments on account',
          boxes: [
            { box: '10', label: 'If you’re claiming to reduce your 2026–27 payments on account, put ‘X’ in the box – enter the reduced amount of your first payment in box 11 and say why you’re making the claim in box 17 on page TC 2 of this form', kind: 'x' },
            m('11', 'Your first payment on account for 2026–27 – enter the amount (including pence)', 'pence'),
          ],
        },
      ],
    },
  ],
};

const FORM_SETS: SaFormSet[] = [FORMS_2025_26];

/**
 * The forms for a tax year: its own when HMRC has published them, else the latest before it (`own`
 * false: a year still in progress shows its figures on the last forms there are). Null before the
 * first catalogue.
 */
export function saFormsFor(taxYear: string): { forms: SaFormSet; own: boolean } | null {
  const own = FORM_SETS.find((f) => f.taxYear === taxYear);
  if (own) return { forms: own, own: true };
  const earlier = FORM_SETS.filter((f) => f.taxYear < taxYear).sort((a, b) => b.taxYear.localeCompare(a.taxYear))[0];
  return earlier ? { forms: earlier, own: false } : null;
}

export function saBox(forms: SaFormSet, pageId: string, box: string): SaBoxDef {
  const page = forms.pages.find((p) => p.id === pageId);
  const def = page?.sections.flatMap((s) => s.boxes).find((b) => b.box === box);
  if (!def) throw new Error(`No box ${pageId} ${box} on the ${forms.taxYear} forms`);
  return def;
}
