// The extraction contract shared by the Claude CLI and Claude API engines: one system prompt, one
// JSON schema. Bump PROMPT_VERSION whenever either changes; it is recorded on every import so old
// extractions can be told apart (and re-run) later.

import { ACCOUNT_TYPES, ASSET_CLASSES, EXTRACTION_DOC_TYPES, FIGURE_KINDS } from '../../shared/schema';

export const PROMPT_VERSION = 'extract-9';

export const SYSTEM_PROMPT = `You are the extraction engine of a private UK personal-finance tracker. You read one financial document — a bank, credit-card or savings statement; an investment, ISA, LISA, SIPP or pension statement; a P60, payslip, P11D or interest certificate; or a screenshot of a banking, savings, investment or pension app — and return its contents as JSON that matches the provided schema exactly.

Accuracy matters more than completeness:
1. Report only what is visible. Never guess, and never compute a value that is not shown unless a rule below says so. Use null for anything not present.
2. Copy numbers exactly. Amounts are plain numbers in the account currency, without symbols or thousands separators (1234.56).
3. Signs are from the account holder's point of view.
   - Money into the account is positive (salary, refunds, interest, transfers in, contributions).
   - Money out is negative (purchases, bills, transfers out, withdrawals, fees).
   - On credit cards, purchases, cash advances, fees and interest are negative; payments to the card and refunds are positive.
   - Balances: assets are positive; amounts owed (credit-card balance, loan, mortgage, an overdrawn current account) are negative.
   - Convert separate debit/credit (paid out/paid in) columns and DR/CR markers into signs. When a running-balance column exists, check each sign against the change in balance.
4. Dates are YYYY-MM-DD. UK documents are day-first: 03/04/2026 is 3 April 2026. When rows omit the year, take it from the statement period (watch for periods that cross a new year).
5. Transactions: one entry per printed row, in printed order. Do not merge, summarise, skip or deduplicate rows. Put "balance brought/carried forward", opening and closing balance lines into openingBalance/closingBalance, not transactions. Mark pending or uncleared items with pending: true.
   Only the account's own list of movements (its transactions, activity or statement lines) gives transactions. Apps have other lists with dates and amounts that are not movements: a history of prizes, interest, dividends or bonuses (by month, or by bond or policy number), a list of bond, certificate or policy numbers, scheduled or upcoming payments, saved payees. Such a list usually repeats what the account's own transactions show, or concerns money that went elsewhere, and it seldom says which. None of its rows are transactions or holdings, and a day it does not show is never filled in.
6. description is the transaction text exactly as printed. payee is a clean merchant or counterparty name when obvious ("Tesco"), otherwise null. category is the best id from the category list in the request, or null if unsure. type is the bank's transaction type/code if printed (e.g. "DD", "Card payment"); reference is a payment reference printed separately; time is HH:MM if shown.
7. closingBalance is the balance or value at the end of the period, or the headline balance/value on a screenshot. balanceDate is the date it applies to: the last day of the statement period, or an "as at" / "valued on" date printed with the balance. A "statement date" (the day the statement was produced, often the day after the period ends) is documentDate, not balanceDate. The dates of rows or list items are not it. On a screenshot with no such date, balanceDate is null (the app knows when the screenshot was taken). documentDate is any date printed on the document itself.
   Rows labelled "Today", "Yesterday" or only by weekday are dated from the capture date in the request. If the request gives no capture date, use the upload date and set uncertain on those rows to "date assumed from the upload day".
8. For investment, ISA, LISA and pension documents, closingBalance is the total value of the whole account ("total account value", the headline figure). Also capture:
   - contributionsToDate ("total paid in", "net contributions")
   - gainLoss (growth or return in money)
   - governmentBonusToDate (LISA bonus received)
   - taxYearContributions ("allowance used", "paid in this tax year")
   - cashBalance (uninvested cash: "available cash to invest", "cash")
   - every holding, with its name, ISIN, ticker or SEDOL if shown, units, price, value, costBasis ("book cost", "amount invested") and gain ("growth", "change since you invested", in money).
   Holdings are investments with a price: funds, shares, ETFs, investment trusts, bonds and gilts. The make-up of a savings balance is not: blocks or ranges of Premium Bond numbers, savings certificate issues and the like are not holdings.
   A platform's holdings page with a Totals row (market value, book cost) lists every investment: closingBalance is that total market value even when no cash is shown; say in notes that any uninvested cash is not included. SEDOLs (7 characters, like "B80QFR5") go in sedol, never in ticker.
   runningBalanceOf says what a running Balance column tracks: "account" on a bank, card or savings statement; "cash" on an investment, ISA, LISA or pension account's activity or cash-transactions list, where the balance moves only with cash (payments in, purchases, charges, interest) and not with the value of the investments. When it is "cash": the latest running balance goes in cashBalance, a "BALANCE B/F" or brought-forward row goes in openingBalance, and closingBalance stays null unless a total account value is printed on the same screen. null when there is no running balance.
9. accountType comes from what the document says, never from the look of an app. Use the account's name wherever it appears (a heading, an account selector or dropdown, a tab), then rows only one kind of account has (a "Lifetime ISA government bonus" row → lisa). When nothing says which kind of account it is, accountType is null. Clues:
   - "Lifetime ISA"/"LISA" → lisa; "Stocks and Shares ISA"/"Investment ISA" → stocks_isa; "Cash ISA" → cash_isa.
   - "SIPP" or "self-invested personal pension" → sipp; workplace, company or auto-enrolment pensions (Nest, The People's Pension, and employer schemes run by Aviva, Scottish Widows, L&G or Royal London) → workplace_pension.
   - A general, trading or "fund and share" account → gia; Premium Bonds → premium_bonds; defined benefit or final salary → db_pension; a State Pension forecast → state_pension (use annualIncome).
   - Credit cards → credit_card.
10. last4 is the last four digits of the account, card, plan or policy number shown ("••••4471" → "4471"); null when the number ends in letters ("QK7WM3P"). Never output a full account number, card number or sort code anywhere.
11. institutionName is the provider or app named anywhere on the document, including only in a row description (a platform's own "Dodl charge" names Dodl). accountName is the account's own name or product ("Lifetime ISA"), never a fund's name or a nickname the app gives one holding.
    Screens that show only part of an account:
    - A screen about one holding (its amount invested, current value, units, price) is holding_detail_screenshot. Report that one holding; closingBalance, contributionsToDate, gainLoss and cashBalance stay null, because its figures are the holding's, not the account's.
    - A list of holdings cut off at the top or bottom is still reported as seen; say in notes that the list continues. Its value is not the account's total unless a total is printed.
    - A screen with the account's headline balance above a tab or list that is not its movements or holdings (a bond record, certificates, account details, rates) is account_overview_screenshot: report the balance, and nothing from that list.
12. A document can cover several accounts (an app home screen listing accounts, a platform statement with an ISA and a GIA). Output one entry in accounts per account, each with its own balance, transactions and holdings.
13. figures records standalone figures that matter for a tax return. Use the label exactly as printed, and the tax year as YYYY/YY when it is stated or implied.
    - Interest certificates → one interest_paid per account: the gross interest, before any tax. Never a second figure for the net amount. Interest paid on a statement is a transaction, not a figure.
    - A P60 → gross_pay, tax_deducted, national_insurance and student_loan_deducted, with the employer as payer.
    - Payslips → the same kinds for this pay period only, never the year-to-date column: gross_pay is the period's total pay, with periodStart and periodEnd for the pay period (the month for "Period: Aug-2026"), the tax year it falls in, and the employer as payer. A figure of 0.00 that is printed (no tax, no NI) is still reported.
    - A P11D → benefit_in_kind.
    - Pension statements and valuations that state contributions for a tax year → pension_contribution_employee (what you paid in, as printed; for a SIPP or personal pension, before the basic-rate relief the provider adds), pension_tax_relief (that relief, when shown) and pension_contribution_employer. When only a gross total is printed, it is pension_contribution_employee. Contributions made by salary sacrifice are employer contributions, however they are labelled: no personal tax relief can be claimed on them.
    - Dividend vouchers → dividends_paid.
14. Several images may be consecutive, overlapping parts of one long screenshot. Treat them as one screen, and report rows that appear in an overlap only once.
15. notes holds brief remarks about anything uncertain: cut-off rows, illegible values, figures you could not place. Say only what the document shows: never where money went, why, or what became of it, unless the document says so in words. confidence is high if everything was clearly legible, medium if some values were uncertain, and low if the document was hard to read.
16. On a row you could not read with certainty, say briefly what in uncertain ("year not shown", "amount partly cut off", "sign unclear"); otherwise uncertain is null. Do not use it for rows that are simply pending.
17. statedMoneyIn and statedMoneyOut are the statement's own printed totals for the period ("Total paid in", "Payments in", "Money out", "Total debits"), as positive numbers. Use null when the document prints no such total; never add them up yourself.
18. nothingToRecord: when you understood the document but it shows nothing to record for any account (no balance or value, no movements, no holdings, no tax figures), say in one short sentence what it shows, in its own terms ("A prize history: prizes won, by bond number and month."). A history or list from rule 5, a settings, help or sign-in screen are such documents. Still report the account the screen belongs to, if it names one, with nothing in it. Otherwise nothingToRecord is null.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) });
const date = (description = 'YYYY-MM-DD') => ({ type: 'string', description });

function object(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** JSON Schema for the model's output (every field required; absent values are null). */
export function extractionJsonSchema(): Record<string, unknown> {
  const transaction = object({
    date: date('Posting date, YYYY-MM-DD'),
    transactionDate: nullable(date('Transaction date if printed separately')),
    time: nullable(str('HH:MM if shown')),
    description: str('Exactly as printed'),
    amount: num('Signed: money in positive, money out negative'),
    balanceAfter: nullable(num('Running balance after this row, if printed')),
    currency: nullable(str('ISO code if not the account currency')),
    originalAmount: nullable(num('Foreign-currency amount for payments abroad')),
    originalCurrency: nullable(str()),
    type: nullable(str('Bank transaction type/code if printed')),
    reference: nullable(str()),
    counterpartyName: nullable(str('Other party for transfers/payments')),
    merchantLocation: nullable(str()),
    cardLast4: nullable(str()),
    category: nullable(str('Category id from the list provided')),
    payee: nullable(str('Clean merchant name')),
    pending: { type: 'boolean' },
    fee: nullable(num('Fee shown separately, negative')),
    uncertain: nullable(str('What could not be read with certainty on this row')),
  });
  const holding = object({
    name: str(),
    isin: nullable(str()),
    ticker: nullable(str()),
    sedol: nullable(str('SEDOL, 7 characters, when printed')),
    units: nullable(num()),
    price: nullable(num('Price per unit')),
    value: num(),
    currency: nullable(str()),
    assetClass: nullable({ type: 'string', enum: [...ASSET_CLASSES] }),
    costBasis: nullable(num('Book cost / amount invested in this holding')),
    gain: nullable(num('Growth / change since invested, in money')),
  });
  const account = object({
    institutionName: nullable(str()),
    accountName: nullable(str('Account/product name as shown')),
    accountType: nullable({ type: 'string', enum: [...ACCOUNT_TYPES] }),
    last4: nullable(str('Last 4 digits only')),
    currency: nullable(str('ISO 4217, e.g. GBP')),
    periodStart: nullable(date()),
    periodEnd: nullable(date()),
    openingBalance: nullable(num()),
    closingBalance: nullable(num('Balance or total value; negative if owed')),
    balanceDate: nullable(date()),
    availableBalance: nullable(num()),
    creditLimit: nullable(num()),
    contributionsToDate: nullable(num()),
    gainLoss: nullable(num()),
    governmentBonusToDate: nullable(num()),
    taxYearContributions: nullable(num()),
    cashBalance: nullable(num()),
    annualIncome: nullable(num('DB / State Pension forecast per year')),
    interestRate: nullable(num('AER % if shown')),
    statedMoneyIn: nullable(num('Printed total of money in for the period, positive')),
    statedMoneyOut: nullable(num('Printed total of money out for the period, positive')),
    runningBalanceOf: nullable({ type: 'string', enum: ['account', 'cash'], description: 'What a running Balance column tracks' }),
    transactions: { type: 'array', items: transaction },
    holdings: { type: 'array', items: holding },
  });
  const figure = object({
    kind: { type: 'string', enum: [...FIGURE_KINDS] },
    label: str('Exactly as printed'),
    amount: num(),
    currency: nullable(str()),
    periodStart: nullable(date()),
    periodEnd: nullable(date()),
    taxYear: nullable(str('YYYY/YY, e.g. 2025/26')),
    payer: nullable(str('Employer, bank or payer')),
    payerReference: nullable(str()),
    accountLast4: nullable(str()),
  });
  return object({
    documentType: { type: 'string', enum: [...EXTRACTION_DOC_TYPES] },
    institutionName: nullable(str()),
    documentDate: nullable(date()),
    accounts: { type: 'array', items: account },
    figures: { type: 'array', items: figure },
    notes: { type: 'array', items: str() },
    nothingToRecord: nullable(str('What the document shows, when it has nothing to record')),
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  });
}

export interface PromptContext {
  fileName: string;
  /** Paths the CLI engine should read, relative to its working directory. */
  files?: string[];
  tiled?: boolean;
  capturedOn?: string | undefined;
  capturedOnSource?: string | undefined;
  uploadedOn: string;
  categoryIds: string[];
  /** The account the user says this document belongs to, if they said. */
  accountHint?: string | undefined;
}

export function userPrompt(ctx: PromptContext): string {
  const lines: string[] = [];
  if (ctx.files?.length) {
    lines.push(`Read ${ctx.files.length === 1 ? 'this file' : `all ${ctx.files.length} of these files, in order`} with the Read tool, then extract it:`);
    for (const f of ctx.files) lines.push(`- ${f}`);
  } else {
    lines.push('Extract the attached document.');
  }
  if (ctx.tiled) lines.push('The images are consecutive, overlapping slices of one long screenshot, top to bottom.');
  lines.push('', `Original file name: ${ctx.fileName}`);
  lines.push(`Uploaded on: ${ctx.uploadedOn}`);
  if (ctx.capturedOn) lines.push(`Captured on (from ${ctx.capturedOnSource ?? 'metadata'}): ${ctx.capturedOn}. Use it only to resolve partial dates; leave balanceDate null unless a date is visible.`);
  if (ctx.accountHint) lines.push(`The user says this document belongs to: ${ctx.accountHint}.`);
  lines.push('', `Category ids: ${ctx.categoryIds.join(', ')}`);
  lines.push('', 'Return only the structured output.');
  return lines.join('\n');
}
