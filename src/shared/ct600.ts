// The Company Tax Return (CT600), box by box, as HMRC prints it (docs/UK_RULES.md, "Corporation Tax:
// the CT600"): only the boxes a small UK company with trading and non-trading income, capital
// allowances and losses needs, with their labels verbatim from the form, and how the books fill each.
// A new version of the form is a new catalogue here, never an edit to an old one. Nothing here is sent
// to HMRC: the owner files through commercial software.

import type { Ct600BoxView, CtComputationView } from './api';
import { formatDate, formatSpan } from './dates';
import { roundToPounds } from './money';
import type { Company } from './schema';
import { ctRatesFor } from './uk';

/** The form these boxes are from (GOV.UK, "Company Tax Return CT600 (2026) Version 3", HMRC 04/26). */
export const CT600_FORM = {
  name: 'Company Tax Return CT600 (2026) Version 3',
  version: 'CT600 (2026) Version 3, HMRC 04/26: for accounting periods starting on or after 1 April 2015',
  url: 'https://www.gov.uk/government/publications/corporation-tax-company-tax-return-ct600-2015-version-3',
} as const;

/** A box as the form prints it: its number, its label (verbatim), its column where it has two, and how it takes its value. */
export interface Ct600BoxDef {
  box: string;
  label: string;
  /** The form's column for boxes printed in pairs ("Capital allowances", "Balancing charges"). */
  column?: string;
  kind: Ct600BoxView['kind'];
  section: string;
}

const S = {
  company: 'Company information',
  period: 'About this return',
  turnover: 'Turnover',
  income: 'Income',
  profits: 'Profits before deductions',
  deductions: 'Deductions and reliefs',
  tax: 'Tax calculation',
  allowances: 'Capital allowances and balancing charges',
  expenditure: 'Qualifying expenditure',
  losses: 'Losses, deficits and excess amounts',
};
const box = (b: string, label: string, kind: Ct600BoxView['kind'], section: string, column?: string): Ct600BoxDef => ({ box: b, label, kind, section, ...(column ? { column } : {}) });
const ALLOWANCE = 'Capital allowances';
const CHARGE = 'Balancing charges';

/**
 * The boxes covered, in the form's order, labels verbatim from the CT600 (2026) Version 3 PDF. Boxes
 * not here (property, chargeable gains, group relief, ring fence and Northern Ireland profits, the
 * reliefs in terms of tax, and the rest) are not worked out; a company that needs one is told so.
 */
export const CT600_BOXES: readonly Ct600BoxDef[] = [
  box('1', 'Company name', 'text', S.company),
  box('2', 'Company registration number', 'text', S.company),
  box('3', 'Tax reference', 'text', S.company),
  box('4', 'Type of company', 'number', S.company),
  box('30', 'from DD MM YYYY', 'date', S.period),
  box('35', 'to DD MM YYYY', 'date', S.period),
  box('145', 'Total turnover from trade', 'pounds', S.turnover),
  box('155', 'Trading profits', 'pounds', S.income),
  box('160', 'Trading losses brought forward set against trading profits', 'pounds', S.income),
  box('165', 'Net trading profits – box 155 minus box 160', 'pounds', S.income),
  box('170', 'Bank, building society or other interest, and profits from non-trading loan relationships', 'pounds', S.income),
  box('230', 'Non-trade deficits on loan relationships (including interest) and derivative contracts (financial instruments) brought forward set against non-trading profits', 'pounds', S.profits),
  box('235', 'Profits before other deductions and reliefs – net sum of boxes 165 to 205 and 220 minus sum of boxes 225 and 230', 'pounds', S.profits),
  box('260', 'Non-trade deficits for this accounting period from loan relationships and derivative contracts (financial instruments)', 'pounds', S.deductions),
  box('263', 'Carried forward non-trade deficits from loan relationships and derivative contracts (financial instruments)', 'pounds', S.deductions),
  box('275', 'Total trading losses of this or a later accounting period', 'pounds', S.deductions),
  box('285', 'Trading losses carried forward and claimed against total profits', 'pounds', S.deductions),
  box('295', 'Total of deductions and reliefs – total of boxes 240 to 275, 285 and 290', 'pounds', S.deductions),
  box('300', 'Profits before qualifying donations and group relief – box 235 minus box 295', 'pounds', S.deductions),
  box('305', 'Qualifying donations', 'pounds', S.deductions),
  box('315', 'Profits chargeable to Corporation Tax – box 300 minus boxes 305, 310 and 312', 'pounds', S.deductions),
  box('326', 'Number of associated companies in this period', 'number', S.tax),
  box('327', 'Number of associated companies in the first financial year', 'number', S.tax),
  box('328', 'Number of associated companies in the second financial year', 'number', S.tax),
  box('329', 'Put an ‘X’ in box 329 if the company is chargeable at the small profit rate or is entitled to marginal relief', 'x', S.tax),
  ...(['330', '380'] as const).flatMap((fy, k) => [
    box(fy, 'Financial year (yyyy)', 'number', S.tax),
    ...[0, 1, 2].flatMap((line) => {
      const b = (k === 0 ? 335 : 385) + line * 15;
      return [box(String(b), 'Amount of profit', 'pounds', S.tax), box(String(b + 5), 'Rate of tax %', 'percent', S.tax), box(String(b + 10), 'Tax', 'money', S.tax)];
    }),
  ]),
  box('430', 'Corporation Tax – total of boxes 345, 360, 375, 395, 410 and 425', 'money', S.tax),
  box('435', 'Marginal relief', 'money', S.tax),
  box('440', 'Corporation Tax chargeable – box 430 minus box 435', 'money', S.tax),
  box('470', 'Total reliefs and deduction in terms of tax – total of boxes 445, 450 and 465', 'money', S.tax),
  box('475', 'Net Corporation Tax liability – box 440 minus box 470', 'money', S.tax),
  box('480', 'Tax payable on loans and arrangements to participators', 'money', S.tax),
  box('510', 'Tax chargeable – total of boxes 475, 480, 500, 501, 502 and 505', 'money', S.tax),
  box('515', 'Income Tax deducted from gross income included in profits', 'money', S.tax),
  box('525', 'Self-assessment of tax payable before restitution tax and coronavirus support scheme overpayments – box 510 minus box 515', 'money', S.tax),
  box('528', 'Self-assessment of tax payable – total of boxes 525, 526 and 527', 'money', S.tax),
  box('688', 'Full expensing', 'pounds', S.allowances, ALLOWANCE),
  box('689', 'Full expensing', 'pounds', S.allowances, CHARGE),
  box('690', 'Annual investment allowance', 'pounds', S.allowances, ALLOWANCE),
  box('693', 'Machinery and plant – special rate allowance', 'pounds', S.allowances, ALLOWANCE),
  box('694', 'Machinery and plant – special rate allowance', 'pounds', S.allowances, CHARGE),
  box('695', 'Machinery and plant – special rate pool', 'pounds', S.allowances, ALLOWANCE),
  box('700', 'Machinery and plant – special rate pool', 'pounds', S.allowances, CHARGE),
  box('705', 'Machinery and plant – main pool', 'pounds', S.allowances, ALLOWANCE),
  box('710', 'Machinery and plant – main pool', 'pounds', S.allowances, CHARGE),
  box('760', 'Machinery and plant on which first year allowance is claimed', 'pounds', S.expenditure),
  box('770', 'Machinery and plant on long-life assets and integral features', 'pounds', S.expenditure),
  box('773', 'Machinery and plant – special rate allowance', 'pounds', S.expenditure),
  box('775', 'Other machinery and plant', 'pounds', S.expenditure),
  box('780', 'Losses of trades carried on wholly or partly in the UK', 'pounds', S.losses),
  box('795', 'Non-trade deficits on loan relationships and derivative contracts', 'pounds', S.losses),
];

/** The figures (pence, exact) the profit boxes come from. `null`: no trade in the period (pre-trading), so the trading boxes are left blank. */
export interface ProfitFigures {
  turnover: number | null;
  tradingProfit: number | null;
  lossesAgainstTrading: number;
  nonTradingProfits: number;
  /** Non-trading deficits of periods before 1 April 2017 set against non-trading profits (box 230). */
  deficitsAgainstNonTrading: number;
  lossesAgainstTotal: number;
  deficitsAgainstTotal: number;
}

/** The profit boxes in whole pounds: each figure rounded to the nearest pound, half away from nothing, and each total from the rounded boxes, as the form's own arithmetic adds them. */
export interface ProfitBoxes {
  b145: number | null;
  b155: number | null;
  b160: number | null;
  b165: number | null;
  b170: number;
  b230: number;
  b235: number;
  b263: number;
  b285: number;
  b295: number;
  b300: number;
  b315: number;
}

/**
 * The profit boxes from the exact figures. The form prints ".00" against them: whole pounds. No HMRC text
 * found says how pence are dropped (COM130040: no rounding to thousands on the form), so each figure is
 * rounded to the nearest pound, half away from nothing, and every total is the form's sum of the rounded
 * boxes, never a rounding of its own (as the accounts' whole pounds are worked out). A deduction is never
 * more than what it is set against, so no total goes below nothing.
 */
export function profitBoxes(f: ProfitFigures): ProfitBoxes {
  const r = (minor: number) => roundToPounds(minor);
  const b155 = f.tradingProfit === null ? null : r(f.tradingProfit);
  const b160 = b155 === null ? null : Math.min(r(f.lossesAgainstTrading), b155);
  const b165 = b155 === null ? null : b155 - (b160 ?? 0);
  const b170 = r(f.nonTradingProfits);
  const b230 = Math.min(r(f.deficitsAgainstNonTrading), b170);
  const b235 = (b165 ?? 0) + b170 - b230;
  const b285 = Math.min(r(f.lossesAgainstTotal), b235);
  const b263 = Math.min(r(f.deficitsAgainstTotal), b235 - b285);
  const b295 = b263 + b285;
  const b300 = b235 - b295;
  return { b145: f.turnover === null ? null : r(f.turnover), b155, b160, b165, b170, b230, b235, b263, b285, b295, b300, b315: b300 };
}

/**
 * The CT600's boxes for a period's computation, each with its value and how it was worked out. Boxes the
 * books cannot fill are given with nothing in them and say why: the tax reference (an identifier, never
 * kept here), the reliefs not worked out (qualifying donations, s455 tax, losses claimed under s37).
 */
export function ct600Boxes(v: CtComputationView, company: Pick<Company, 'name' | 'number'>, figures: ProfitFigures): Ct600BoxView[] {
  const p = profitBoxes(figures);
  const ca = v.capitalAllowances;
  const pounds = (minor: number) => roundToPounds(minor);
  const trading = v.period.phase === 'trading';
  const values = new Map<string, [Ct600BoxView['value'], string]>();
  const set = (b: string, value: Ct600BoxView['value'], working: string) => values.set(b, [value, working]);

  set('1', company.name, 'The company’s name, as on its record.');
  set('2', company.number ?? null, company.number ? 'Its Companies House number.' : 'Its Companies House number: give it on the company’s record.');
  set('3', null, 'Its 10-digit Unique Taxpayer Reference: an identifier, never kept here. Type it in your filing software.');
  const cihc = v.settings.closeInvestmentHolding === true;
  set('4', cihc ? 2 : 0, cihc ? '2: a close investment-holding company, as the settings say (CTA 2010 s18N).' : '0: none of the types of company applies, as far as the books know (2 is a close investment-holding company, which the settings say it is not, or do not say).');
  set('30', v.period.start, 'The first day of the Corporation Tax accounting period (CTA 2009 s9).');
  set('35', v.period.end, 'Its last day (CTA 2009 s10).');
  const sales = v.accounts.lines.filter((l) => l.treatment === 'trading-income');
  set('145', p.b145, trading ? `Sales for the period, ${sales.some((l) => l.basis === 'days') ? 'the period of account’s shared by days (CTA 2009 s52)' : 'by date'}, to the nearest pound.` : 'Left blank: no trade in the period.');
  set('155', p.b155, trading ? `The trading result after capital allowances, when a profit (a loss goes in box 780), to the nearest pound.` : 'Left blank: the trade had not started.');
  set('160', p.b160 || null, p.b160 ? 'Trading losses of periods beginning before 1 April 2017 carried forward against the same trade’s profits (CTA 2010 s45), only as far as box 155.' : 'None: losses from 1 April 2017 that may be set against total profits go in box 285.');
  set('165', p.b165, p.b165 === null ? 'Left blank, as box 155 is.' : 'Box 155 minus box 160.');
  set('170', p.b170, `Interest received and other non-trading loan relationship credits less debits (CTA 2009 s301), when a profit${v.nonTrading.net < 0 ? ': here a deficit, in box 795' : ''}.`);
  set('230', p.b230 || null, p.b230 ? 'Non-trading deficits of periods before 1 April 2017 carried forward, set against non-trading profits only (CTA 2009 s457), as far as box 170.' : 'None: deficits from 1 April 2017 that may be set against total profits go in box 263.');
  set('235', p.b235, 'Box 165 plus box 170, less box 230 (the other boxes from 175 to 225 are not used here).');
  set('260', null, v.nonTrading.net < 0 ? 'Left blank: this period’s deficit is carried forward, not claimed against this period’s profits (CTA 2009 s459), which the company may choose instead.' : 'Left blank: no deficit claimed against this period’s profits.');
  set('263', p.b263 || null, p.b263 ? 'Non-trading deficits carried forward set against total profits (CTA 2009 s463G, a claim), as far as they go after box 285.' : 'None used.');
  set('275', null, v.losses.trading.arising ? 'Left blank: this period’s loss is carried forward, not set against total profits by a claim under CTA 2010 s37.' : 'Left blank.');
  set('285', p.b285 || null, p.b285 ? 'Trading losses of periods from 1 April 2017 carried forward and claimed against total profits (CTA 2010 s45A), as far as they go. Show the deductions allowance used in the computation (CTA 2010 s269ZB, s269ZD).' : 'None used.');
  set('295', p.b295, 'Box 263 plus box 285 (the other deductions are not used here).');
  set('300', p.b300, 'Box 235 minus box 295.');
  set('305', null, 'Qualifying charitable donations are not worked out here.');
  set('315', p.b315, 'Box 300 (no qualifying donations or group relief): the tax below is worked out on it.');

  const parts = v.tax.parts;
  const marginal = parts.some((x) => x.band === 'small' || x.band === 'marginal');
  const straddles = parts.length > 1;
  const [assoc1 = 0, assoc2 = assoc1] = v.settings.associatedByYear;
  // Boxes 327 and 328 replace 326 for a period over two financial years when the limits changed between them or the numbers differ (the CT600 guide).
  const limitsChanged = parts.length > 1 && (ctRatesFor(parts[0]!.fy)?.lower !== ctRatesFor(parts[1]!.fy)?.lower || ctRatesFor(parts[0]!.fy)?.upper !== ctRatesFor(parts[1]!.fy)?.upper);
  const split = parts.length > 1 && (limitsChanged || assoc1 !== assoc2);
  const assocWord = v.settings.associatedSaid ? 'as the settings say for this period' : 'none said in the settings for this period';
  set('326', marginal && !split ? assoc1 : null, marginal ? (split ? `Left blank: the period runs over two financial years and ${limitsChanged ? 'the limits changed between them' : 'the number differs between them'}, so boxes 327 and 328 are used.` : `Associated companies for any part of the period, not this one (CTA 2010 s18E), ${assocWord}.`) : 'Left blank: neither the small profits rate nor marginal relief applies.');
  set('327', marginal && split ? assoc1 : null, marginal && split ? `Associated companies in the first financial year, ${assocWord}.` : 'Left blank: box 326 is used.');
  set('328', marginal && split ? assoc2 : null, marginal && split ? `Associated companies in the second financial year, ${assocWord}.` : 'Left blank: box 326 is used.');
  set('329', parts.some((x) => x.band === 'small' || x.band === 'marginal'), 'An X when the small profits rate or marginal relief applies to any part.');
  parts.slice(0, 2).forEach((x, k) => {
    const fyBox = k === 0 ? 330 : 380;
    set(String(fyBox), x.fy, `Financial year ${x.fy} (1 April ${x.fy} to 31 March ${x.fy + 1}): ${x.days} days of the period, ${formatSpan(x.start, x.end)}.`);
    set(String(fyBox + 5), x.profit, straddles ? `Box 315 shared between the financial years by days (CTA 2009 s8(5), CTA 2010 s1172), to the pound.` : 'Box 315.');
    set(String(fyBox + 10), x.rate, x.band === 'small' ? 'The small profits rate (CTA 2010 s18A).' : x.band === 'single' ? 'The rate for the year.' : x.band === 'marginal' ? 'The main rate, less marginal relief (box 435).' : cihc ? 'The main rate: a close investment-holding company (CTA 2010 s18N).' : 'The main rate.');
    set(String(fyBox + 15), x.tax, `${x.profit.toLocaleString('en-GB')} × ${x.rate}%.`);
  });
  set('430', v.tax.atRates, 'The tax at each rate, added up.');
  const fractions = [...new Set(parts.map((x) => ctRatesFor(x.fy)?.fraction).filter((f): f is { n: number; d: number } => Boolean(f)).map((f) => `${f.n}/${f.d}`))].join(' and ');
  set('435', v.tax.marginalRelief || null, v.tax.marginalRelief ? `F × (U − A) × N ÷ A, with F ${fractions}, U the upper limit after associated companies and the period’s length, and A (augmented profits) taken as N (CTA 2010 s18B): see the tax by financial year.` : 'None.');
  set('440', v.tax.chargeable, 'Box 430 minus box 435.');
  set('470', 0, 'None: the reliefs in terms of tax (community investment, double taxation, advance Corporation Tax) are not worked out here.');
  set('475', v.tax.chargeable, 'Box 440 minus box 470.');
  const s455 = v.s455?.tax ?? 0;
  set('480', v.s455 ? s455 : null, v.s455 ? `Tax on loans to participators (CTA 2010 s455), as box A80 of the CT600A would give it: what you were lent in the period and still owed at its end, at the rate for each part's tax year, less relief for repayments by ${formatDate(v.s455.due)} (s458)${v.s455.provisional ? ', so far' : ''}. Check it on your CT600A.` : 'None: nothing lent to you in the period was owed at its end (CTA 2010 s455).');
  set('510', v.tax.chargeable + s455, 'Box 475 plus box 480 (the rest not used here).');
  set('515', 0, 'None: a company’s bank interest is paid gross.');
  set('525', v.tax.chargeable + s455, 'Box 510 minus box 515.');
  set('528', v.payable, 'Box 525 (no restitution tax or coronavirus support scheme overpayment): the tax payable.');

  const fe = ca.assets.filter((a) => a.treatment === 'full-expensing');
  const sr = ca.assets.filter((a) => a.treatment === 'fya-50');
  const charge = (t: 'full-expensing' | 'fya-50') => ca.disposals.filter((d) => d.treatment === t).reduce((x, d) => x + d.balancingCharge, 0);
  const pool = (k: 'main' | 'special') => ca.pools.find((x) => x.pool === k);
  const aiaIn = (k: 'main' | 'special') => ca.assets.filter((a) => a.pool === k).reduce((x, a) => x + a.aia, 0);
  const some = (n: number) => (n ? n : null);
  set('688', some(pounds(fe.reduce((x, a) => x + a.firstYear, 0))), 'Full expensing claimed (CAA 2001 s45S, 100%).');
  set('689', some(pounds(charge('full-expensing'))), 'Balancing charges on disposals of plant that had full expensing (CAA 2001 s59A).');
  set('690', some(pounds(ca.aia)), 'The annual investment allowance claimed (CAA 2001 s51A).');
  set('693', some(pounds(sr.reduce((x, a) => x + a.firstYear, 0))), 'The 50% first-year allowance on special rate expenditure (CAA 2001 s45S).');
  set('694', some(pounds(charge('fya-50'))), 'Balancing charges on disposals of plant that had the 50% allowance (CAA 2001 s59B).');
  set('695', some(pounds(aiaIn('special') + (pool('special')?.wda ?? 0))), 'All allowances on the special rate pool, the annual investment allowance on special rate expenditure included (as the CT600 guide asks), and its writing-down allowance.');
  set('700', some(pounds(pool('special')?.balancingCharge ?? 0)), 'A balancing charge when disposals exceed the special rate pool.');
  set('705', some(pounds(aiaIn('main') + (pool('main')?.wda ?? 0))), 'All allowances on the main pool, the annual investment allowance on main rate expenditure included (as the CT600 guide asks), and its writing-down allowance (or small pools allowance).');
  set('710', some(pounds(pool('main')?.balancingCharge ?? 0)), 'A balancing charge when disposals exceed the main pool.');
  // The part of an asset the AIA covered is in 770 or 775; only what took a first-year allowance is in 760 (and 773 for 50%).
  const fyaPart = (a: (typeof ca.assets)[number]) => (a.firstYear ? a.qualifying - a.aia : 0);
  set('760', some(pounds(ca.assets.reduce((x, a) => x + fyaPart(a), 0))), 'Expenditure on which a first-year allowance (full expensing or the 50% allowance) is claimed: not any part the annual investment allowance covered.');
  set('770', some(pounds(ca.assets.filter((a) => a.pool === 'special').reduce((x, a) => x + a.qualifying - fyaPart(a), 0))), 'Special rate expenditure (integral features, long-life assets, thermal insulation) not in box 760, the part taking the annual investment allowance included.');
  set('773', some(pounds(sr.reduce((x, a) => x + fyaPart(a), 0))), 'Expenditure on which the 50% allowance is claimed (also in box 760).');
  set('775', some(pounds(ca.assets.filter((a) => a.pool === 'main').reduce((x, a) => x + a.qualifying - fyaPart(a), 0))), 'Other plant and machinery: main rate expenditure not in box 760, the part taking the annual investment allowance included.');
  set('780', some(pounds(v.losses.trading.arising)), 'The trading loss of the period, after capital allowances.');
  set('795', some(pounds(v.losses.nonTrading.arising)), 'The non-trading loan relationship deficit of the period (CTA 2009 s301).');

  return CT600_BOXES.filter((d) => values.has(d.box)).map((d) => {
    const [value, working] = values.get(d.box)!;
    return { box: d.box, label: d.label, ...(d.column ? { column: d.column } : {}), kind: d.kind, value, section: d.section, working };
  });
}
