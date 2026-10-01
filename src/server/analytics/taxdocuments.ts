// Settings → Tax documents: a tax year's tax figures by job, each value with the source that counts
// and the others that state it (FORMULAS.md §11, "One source per employer and year"), then the year's
// other figures by kind. Nothing here is new arithmetic: it shows what the calculations use.

import type { TaxDocSource, TaxDocumentsResponse } from '../../shared/api';
import { formatDate, formatMonth, today, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Figure, FigureKind } from '../../shared/schema';
import { taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import { jobStartedOn } from './pay';
import { payslipOf, yearSoFar } from './payslips';
import { employerYears, isPayslipFigure, jobEndedOn, PAY_KINDS, type PayKind, type PaySource } from './sources';

const PAY_LABELS: Record<PayKind, string> = { gross_pay: 'Pay', tax_deducted: 'Tax', national_insurance: 'National Insurance', student_loan_deducted: 'Student loan' };
const PENSION_LABELS = { pension_contribution_employee: 'Pension (you)', pension_contribution_employer: 'Pension (employer)' } as const;

/** What each other kind of figure is called on the page. */
const KIND_LABELS: Partial<Record<FigureKind, string>> = {
  interest_paid: 'Interest',
  interest_tax_deducted: 'Tax taken off interest',
  dividends_paid: 'Dividends',
  pension_contribution_employee: 'Pension: your contributions',
  pension_contribution_employer: 'Pension: employer contributions',
  pension_tax_relief: 'Pension: tax relief',
  benefit_in_kind: 'Benefits in kind',
  gift_aid_donation: 'Gift Aid donations',
  child_benefit: 'Child Benefit',
  self_employment_income: 'Self-employment income',
  self_employment_expenses: 'Self-employment expenses',
  capital_gain: 'Capital gains',
  capital_loss: 'Capital losses',
  rental_income: 'Rental income',
  other_income: 'Other income',
  other: 'Other',
};

export function taxDocuments(store: Store, label?: string, now: ISODate = today()): TaxDocumentsResponse {
  const ty = label && /^\d{4}\/\d{2}$/.test(label) ? taxYearOf(`${label.slice(0, 4)}-06-01`) : taxYearOf(now);
  const years = [
    ...new Set([taxYearOf(now).label, ...store.figures.flatMap((f) => (f.taxYear && /^\d{4}\/\d{2}$/.test(f.taxYear) ? [f.taxYear] : [])), ...store.payslips.map((p) => p.taxYear), ...store.hmrc.flatMap((r) => ('taxYear' in r ? [r.taxYear] : []))]),
  ]
    .sort()
    .reverse();
  const fileOf = (importId: string | undefined) => (importId ? store.imports.find((i) => i.id === importId)?.fileName : undefined);
  const view = (s: PaySource): TaxDocSource => {
    const file = fileOf(s.importId);
    return {
      kind: s.kind,
      label: s.label,
      amount: s.amount,
      asOf: s.asOf,
      final: s.final,
      ...(s.importId ? { importId: s.importId } : {}),
      ...(file ? { fileName: file } : {}),
      figureIds: s.figures.map((f) => f.id),
      ...(s.records ? { hmrcRecords: s.records.length } : {}),
      ...(s.payslipId ? { payslipId: s.payslipId } : {}),
    };
  };
  const inYear = (f: Figure) => f.taxYear === ty.label;

  const jobs: TaxDocumentsResponse['jobs'] = employerYears(store, ty).map((y) => {
    const job = store.employment(y.employmentId);
    const values: TaxDocumentsResponse['jobs'][number]['values'] = PAY_KINDS.flatMap((kind) => {
      const list = y.sources[kind];
      return list?.length ? [{ kind, label: PAY_LABELS[kind], chosen: view(list[0]!), others: list.slice(1).map(view) }] : [];
    });
    // Pension on its payslips: the year to date when they were read in full, else the payslips added up.
    if (y.employmentId) {
      for (const kind of ['pension_contribution_employee', 'pension_contribution_employer'] as const) {
        const figures = store.figures.filter((f) => f.kind === kind && f.employmentId === y.employmentId && inYear(f) && isPayslipFigure(store, f));
        const ytd = yearSoFar(store, y.employmentId, ty, kind, figures);
        const sum: TaxDocSource | undefined = figures.length
          ? { kind: 'payslips', label: `${figures.length} payslip figure${figures.length === 1 ? '' : 's'}, so far`, amount: fromMinor(figures.reduce((x, f) => x + toMinor(f.amount), 0)), asOf: figures.map((f) => f.date ?? f.periodEnd ?? '').sort().at(-1)!, final: false, figureIds: figures.map((f) => f.id) }
          : undefined;
        const fromYtd: TaxDocSource | undefined = ytd && (ytd.amount || sum) ? { kind: 'to-date', label: `year to date on the payslip of ${formatDate(ytd.payslip.payDate)}`, amount: ytd.amount, asOf: ytd.asOf, final: false, figureIds: [], payslipId: ytd.payslip.id } : undefined;
        const chosen = fromYtd ?? sum;
        if (chosen) values.push({ kind, label: PENSION_LABELS[kind], chosen, others: chosen === fromYtd && sum ? [sum] : [] });
      }
    }
    // Its payslips: the pay periods its payslip figures make, with the payslip in full when it was read so.
    const grossSlips = (y.sources.gross_pay ?? []).find((s) => s.kind === 'payslips')?.figures ?? [];
    const payslips = grossSlips
      .map((f) => {
        const rec = payslipOf(store, [f]);
        const file = fileOf(f.source.importId);
        return {
          ...(rec ? { id: rec.id } : {}),
          ...(f.source.importId ? { importId: f.source.importId } : {}),
          ...(file ? { fileName: file } : {}),
          payDate: rec?.payDate ?? f.date ?? f.periodEnd ?? ty.end,
          ...(f.periodEnd || rec?.periodLabel ? { period: f.periodEnd ? formatMonth(f.periodEnd) : rec!.periodLabel! } : {}),
          gross: f.amount,
          net: rec?.totals.net ?? null,
          ...(rec?.taxCode || f.taxCode ? { taxCode: rec?.taxCode ? `${rec.taxCode}${rec.cumulative === false ? ' M1' : ''}` : f.taxCode! } : {}),
        };
      })
      .sort((a, b) => a.payDate.localeCompare(b.payDate));
    const started = y.employmentId ? jobStartedOn(store, y.employmentId) : undefined;
    const ended = jobEndedOn(store, y.employmentId);
    return {
      key: y.key,
      ...(y.employmentId ? { employmentId: y.employmentId } : {}),
      employer: y.payer,
      names: y.names,
      ...(y.payeReference ? { payeReference: y.payeReference } : {}),
      ...(job?.payrollNumbers.length ? { payrollNumbers: job.payrollNumbers } : {}),
      ...(started ? { startedOn: started } : {}),
      ...(ended ? { endedOn: ended } : {}),
      values,
      payslips,
      hmrcPayments: y.employmentId ? store.hmrc.filter((r) => r.type === 'payment' && r.taxYear === ty.label && r.employmentId === y.employmentId).length : 0,
    };
  });

  // The year's other figures, by kind: everything but a job's pay figures and its payslips' pension.
  const job = new Set<string>(PAY_KINDS);
  const others = store.figures.filter((f) => inYear(f) && f.kind !== 'earned_pay' && !job.has(f.kind) && !(f.employmentId && isPayslipFigure(store, f)));
  const kinds = [...new Set(others.map((f) => f.kind))];
  const other: TaxDocumentsResponse['other'] = kinds.map((kind) => {
    const list = others.filter((f) => f.kind === kind).sort((a, b) => (a.payer ?? '').localeCompare(b.payer ?? '') || a.amount - b.amount);
    return {
      kind,
      label: KIND_LABELS[kind] ?? kind.replace(/_/g, ' '),
      total: fromMinor(list.reduce((x, f) => x + toMinor(f.amount), 0)),
      figures: list.map((f) => {
        const file = fileOf(f.source.importId);
        return {
          id: f.id,
          label: f.label,
          amount: f.amount,
          ...(f.payer ? { payer: f.payer } : {}),
          ...(f.accountId ? { accountId: f.accountId } : {}),
          ...(f.date ? { date: f.date } : {}),
          ...(f.source.importId ? { importId: f.source.importId } : {}),
          ...(file ? { fileName: file } : {}),
          yours: !f.source.importId,
        };
      }),
    };
  });
  return { taxYear: { label: ty.label, start: ty.start, end: ty.end }, years, jobs, other };
}
