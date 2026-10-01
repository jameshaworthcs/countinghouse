// Which figures count for a job's tax year when several documents state it (docs/FORMULAS.md §11,
// "One source per employer and year").
//
// A job's pay for a year can be stated by its P60, its P45, HMRC's taxable-income pages and the
// payslips themselves. Adding them up counted one job two or three times; taking any year-to-date
// page as if it were a P60 froze that employer's pay at the page's date. So each employer's year has
// candidate sources, all of them kept and shown, and exactly one counts (`chooseSource`):
//
//   1. your own figure, typed in Settings → Tax documents;
//   2. a document for the whole tax year: a P60, or HMRC's figure for a finished year;
//   3. otherwise the most recent of the rest, as at its latest date: a document's figure to date (a
//      P45, an HMRC page) or the payslips so far. On the same date a document, which states the
//      total, wins over a sum of payslips.

import { diffDays, formatDate, type ISODate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { Figure, FigureKind, HmrcRecord } from '../../shared/schema';
import type { TaxYear } from '../../shared/uk';
import type { Store } from '../store';

/** An employer's name reduced for comparing: "Larchwood Data Ltd" and "LARCHWOODDATA" are one. */
export const payerKey = (name: string | undefined) =>
  (name ?? '')
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|uk)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * An employer PAYE reference tidied for comparing: "123 AB456", "123/AB456" and "123 / ab456"
 * are "123/AB456". Anything else in the field (a company number, say) is not one: undefined.
 */
export function payeReference(text: string | undefined): string | undefined {
  const m = /^\s*(\d{3})\s*[/ ]\s*([A-Za-z0-9]{1,10})\s*$/.exec(text ?? '');
  return m ? `${m[1]}/${m[2]!.toUpperCase()}` : undefined;
}

/**
 * A payslip's figure (one pay period) rather than a P60's (the whole year): by the document it came
 * from, else by a period much shorter than a year.
 */
export function isPayslipFigure(store: Store, f: Figure): boolean {
  const doc = f.source.importId ? store.imports.find((i) => i.id === f.source.importId)?.documentType : undefined;
  if (doc) return doc === 'payslip';
  return Boolean(f.periodStart && f.periodEnd && diffDays(f.periodStart, f.periodEnd) < 200);
}

/** The figures that make up a job's tax year. */
export const PAY_KINDS = ['gross_pay', 'tax_deducted', 'national_insurance', 'student_loan_deducted'] as const satisfies readonly FigureKind[];
export type PayKind = (typeof PAY_KINDS)[number];

/** A figure belongs to a tax year by its label, else by the day it ends. */
export const figureInYear = (f: Figure, ty: TaxYear) => f.taxYear === ty.label || (!f.taxYear && Boolean((f.periodEnd ?? f.date) && (f.periodEnd ?? f.date)! >= ty.start && (f.periodEnd ?? f.date)! <= ty.end));

/**
 * Which figures are one employer's: the names and PAYE references that occur together on a figure
 * belong to one employer, so a P60 under "Halden Systems Limited" and an HMRC page under "HALDEN SYSTEMS LIMITED, 123/AB456"
 * are the same job. Names are compared reduced (`payerKey`).
 */
export class Employers {
  private parent = new Map<string, string>();
  private names = new Map<string, Map<string, number>>();
  private refs = new Map<string, string>();

  constructor(figures: Pick<Figure, 'payer' | 'payerReference'>[]) {
    for (const f of figures) {
      const name = payerKey(f.payer);
      const ref = payeReference(f.payerReference);
      const nodes = [name ? `n:${name}` : null, ref ? `r:${ref}` : null].filter((x): x is string => x !== null);
      for (const n of nodes) this.find(n);
      if (nodes.length === 2) this.union(nodes[0]!, nodes[1]!);
    }
    for (const f of figures) {
      const node = this.nodeOf(f);
      if (!node) continue;
      const root = this.find(node);
      if (f.payer) {
        const counts = this.names.get(root) ?? this.names.set(root, new Map()).get(root)!;
        counts.set(f.payer, (counts.get(f.payer) ?? 0) + 1);
      }
      const ref = payeReference(f.payerReference);
      if (ref && !this.refs.has(root)) this.refs.set(root, ref);
    }
  }

  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }

  private union(a: string, b: string) {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  private nodeOf(f: Pick<Figure, 'payer' | 'payerReference'>): string | null {
    const ref = payeReference(f.payerReference);
    if (ref) return `r:${ref}`;
    const name = payerKey(f.payer);
    return name ? `n:${name}` : null;
  }

  /** The employer a figure is from: one key per employer, whatever name or reference it came under. */
  keyOf(f: Pick<Figure, 'payer' | 'payerReference'>): string {
    const node = this.nodeOf(f);
    return node ? this.find(node) : '';
  }

  /** The employer a name belongs to (the payslips' or the bank's name for it). */
  keyOfName(name: string | undefined): string {
    const key = payerKey(name);
    return key ? this.find(`n:${key}`) : '';
  }

  /** Every name the employer's figures give it, most used first. */
  namesOf(key: string): string[] {
    return [...(this.names.get(key) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }

  referenceOf(key: string): string | undefined {
    return this.refs.get(key);
  }
}

/** One document's (or the payslips', or your own) statement of a figure for a job's tax year. */
export interface PaySource {
  /** `year`: a document for the whole tax year; `to-date`: one for the year so far; `payslips`: the payslips added up; `yours`: typed by you. */
  kind: 'yours' | 'year' | 'to-date' | 'payslips';
  /** How it is described: "P60", "the whole year", "to 27 Jul 2026", "3 payslips so far", "your figure". */
  label: string;
  /** The day it is true at: the end of what it covers, or the last payslip's date. */
  asOf: ISODate;
  /** The whole year's figure: nothing more will come for this job and year. */
  final: boolean;
  amount: number;
  figures: Figure[];
  /** HMRC's records of the job's payments it adds up (its figures are then none). */
  records?: Extract<HmrcRecord, { type: 'payment' }>[];
  /** The import it came from (none for payslips, which are several, or for your own). */
  importId?: string;
}

/** A job's tax year: for each kind of figure, the source that counts and the others that state it. */
export interface EmployerYear {
  key: string;
  /** The job (employments.json), when the figures are under one. */
  employmentId?: string;
  /** The day the job ended, when HMRC or you say it has. */
  endedOn?: string;
  /** The employer's name: its P60's, else the name its figures use most. */
  payer: string;
  /** Every name its figures give it. */
  names: string[];
  payeReference?: string;
  chosen: Partial<Record<PayKind, PaySource>>;
  /** Every source for each kind, the one that counts first. */
  sources: Partial<Record<PayKind, PaySource[]>>;
}

const sum = (figures: Figure[]) => fromMinor(figures.reduce((s, f) => s + toMinor(f.amount), 0));
const latest = (dates: (string | undefined)[]) => dates.filter((d): d is string => Boolean(d)).sort().at(-1);

/** The amount an HMRC payment record gives for a kind of pay figure (taxable pay, tax, NI). */
const paymentAmount = (r: Extract<HmrcRecord, { type: 'payment' }>, kind: PayKind): number | undefined => (kind === 'gross_pay' ? r.taxablePay : kind === 'tax_deducted' ? r.tax : kind === 'national_insurance' ? r.ni : undefined);

/** The day a job ended: yours, else HMRC's (its employment page, or the account's "employment ended"). */
export function jobEndedOn(store: Store, employmentId: string | undefined): string | undefined {
  if (!employmentId) return undefined;
  const yours = store.employment(employmentId)?.endedOn;
  if (yours) return yours;
  return latest(
    store.hmrc.flatMap((r) => (r.employmentId !== employmentId ? [] : r.type === 'employment' && r.endedOn ? [r.endedOn] : r.type === 'event' && r.event === 'ended' ? [r.date] : [])),
  );
}

/**
 * The candidate sources for one job's figures of one kind in one tax year: its payslips, each
 * document, your own figures, and HMRC's record of its payments. A document (or HMRC's record) to a
 * day on or after the job ended is final for the year: nothing more comes from a job you left.
 */
export function candidateSources(store: Store, figures: Figure[], ty: TaxYear, extra: { payments?: Extract<HmrcRecord, { type: 'payment' }>[]; kind?: PayKind; endedOn?: string | undefined } = {}): PaySource[] {
  const out: PaySource[] = [];
  const ended = extra.endedOn && extra.endedOn >= ty.start && extra.endedOn <= ty.end ? extra.endedOn : undefined;
  const payslips = figures.filter((f) => isPayslipFigure(store, f));
  if (payslips.length) {
    const periods = new Set(payslips.map((f) => `${f.periodStart ?? ''}|${f.periodEnd ?? f.date ?? ''}`)).size;
    out.push({ kind: 'payslips', label: `${periods} payslip${periods === 1 ? '' : 's'}, so far`, asOf: latest(payslips.map((f) => f.date ?? f.periodEnd)) ?? ty.end, final: false, amount: sum(payslips), figures: payslips });
  }
  // A figure you typed for the year (Settings → Tax documents): not a payslip, from no document.
  const yours = figures.filter((f) => !f.source.importId && !isPayslipFigure(store, f));
  if (yours.length) out.push({ kind: 'yours', label: 'your figure', asOf: latest(yours.map((f) => f.periodEnd)) ?? ty.end, final: true, amount: sum(yours), figures: yours });
  const byImport = new Map<string, Figure[]>();
  for (const f of figures) if (f.source.importId && !isPayslipFigure(store, f)) (byImport.get(f.source.importId) ?? byImport.set(f.source.importId, []).get(f.source.importId)!).push(f);
  for (const [importId, list] of byImport) {
    const end = latest(list.map((f) => f.periodEnd ?? (f.periodStart ? undefined : ty.end)));
    const whole = !end || end >= ty.end;
    const p60 = store.imports.find((i) => i.id === importId)?.documentType === 'p60';
    out.push({
      kind: whole ? 'year' : 'to-date',
      label: p60 ? 'P60' : whole ? 'the whole year' : `to ${formatDate(end)}`,
      asOf: whole ? ty.end : end,
      final: whole || Boolean(ended && end >= ended),
      amount: sum(list),
      figures: list,
      importId,
    });
  }
  const payments = (extra.payments ?? []).filter((r) => extra.kind && paymentAmount(r, extra.kind) !== undefined);
  if (payments.length && extra.kind) {
    const asOf = latest(payments.map((r) => r.payDate))!;
    const minor = payments.reduce((x, r) => x + toMinor(paymentAmount(r, extra.kind!)!), 0);
    out.push({ kind: 'to-date', label: `HMRC to ${formatDate(asOf)}`, asOf, final: Boolean(ended && asOf >= ended), amount: fromMinor(minor), figures: [], records: payments });
  }
  return out;
}

/** The source that counts, of several stating one figure (the rules at the top of this file). */
export function chooseSource(store: Store, candidates: PaySource[]): PaySource | undefined {
  const rank = (s: PaySource) => (s.kind === 'yours' ? 3 : s.kind === 'year' ? 2 : 0);
  const p60 = (s: PaySource) => (s.importId && store.imports.find((i) => i.id === s.importId)?.documentType === 'p60' ? 1 : 0);
  return [...candidates].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      p60(b) - p60(a) ||
      b.asOf.localeCompare(a.asOf) ||
      // On the same date: a document (or HMRC's record) over the payslips, then a document over
      // HMRC's record, then the later import.
      Number(b.kind !== 'payslips') - Number(a.kind !== 'payslips') ||
      Number(Boolean(b.importId)) - Number(Boolean(a.importId)) ||
      (b.importId ?? '').localeCompare(a.importId ?? ''),
  )[0];
}

/**
 * Every job's tax year in `ty`, with the source of each figure that counts. A job is its figures'
 * `employmentId`; figures under none are grouped by name and PAYE reference (`Employers`).
 */
export function employerYears(store: Store, ty: TaxYear, kinds: readonly PayKind[] = PAY_KINDS): EmployerYear[] {
  const figures = store.figures.filter((f) => (kinds as readonly string[]).includes(f.kind) && figureInYear(f, ty));
  const payments = store.hmrc.filter((r): r is Extract<HmrcRecord, { type: 'payment' }> => r.type === 'payment' && r.taxYear === ty.label);
  const employers = new Employers([...figures.filter((f) => !f.employmentId), ...payments.filter((r) => !r.employmentId).map((r) => ({ payer: r.employer, payerReference: r.payeReference }))]);
  const keyOf = (f: Figure) => (f.employmentId ? `job:${f.employmentId}` : `name:${employers.keyOf(f)}`);
  const keyOfPayment = (r: (typeof payments)[number]) => (r.employmentId ? `job:${r.employmentId}` : `name:${employers.keyOf({ payer: r.employer, payerReference: r.payeReference })}`);
  const groups = new Map<string, { figures: Figure[]; payments: typeof payments }>();
  const group = (key: string) => groups.get(key) ?? groups.set(key, { figures: [], payments: [] }).get(key)!;
  for (const f of figures) group(keyOf(f)).figures.push(f);
  for (const r of payments) group(keyOfPayment(r)).payments.push(r);
  const out: EmployerYear[] = [];
  for (const [key, g] of groups) {
    const employmentId = key.startsWith('job:') ? key.slice(4) : undefined;
    const job = store.employment(employmentId);
    const endedOn = jobEndedOn(store, employmentId);
    const chosen: EmployerYear['chosen'] = {};
    const sources: EmployerYear['sources'] = {};
    for (const kind of kinds) {
      const of = g.figures.filter((f) => f.kind === kind);
      const candidates = candidateSources(store, of, ty, { payments: g.payments, kind, endedOn });
      if (!candidates.length) continue;
      const pick = chooseSource(store, candidates)!;
      chosen[kind] = pick;
      sources[kind] = [pick, ...candidates.filter((c) => c !== pick)];
    }
    if (!Object.keys(chosen).length) continue;
    const named = [...new Set([...(job ? [job.employer, ...job.aliases] : []), ...g.figures.flatMap((f) => (f.payer ? [f.payer] : [])), ...g.payments.flatMap((r) => (r.employer ? [r.employer] : []))])];
    const yearName = job?.employer ?? (chosen.gross_pay?.kind === 'year' || chosen.gross_pay?.kind === 'yours' ? chosen.gross_pay.figures.find((f) => f.payer)?.payer : undefined) ?? (key.startsWith('name:') ? employers.namesOf(key.slice(5))[0] : undefined) ?? named[0] ?? '';
    const ref = job?.payeReference ?? (key.startsWith('name:') ? employers.referenceOf(key.slice(5)) : undefined);
    out.push({ key, ...(employmentId ? { employmentId } : {}), ...(endedOn ? { endedOn } : {}), payer: yearName, names: named, ...(ref ? { payeReference: ref } : {}), chosen, sources });
  }
  return out.sort((a, b) => a.payer.localeCompare(b.payer));
}

/**
 * Each employer's pay (or tax, or another payroll figure) for a tax year, from the one source that
 * counts, so nothing counts twice. `final` when it is the whole year's figure.
 */
export function payByEmployer(store: Store, ty: TaxYear, kind: PayKind = 'gross_pay') {
  return employerYears(store, ty)
    .filter((e) => e.chosen[kind])
    .map((e) => {
      const source = e.chosen[kind]!;
      return { key: e.key, ...(e.employmentId ? { employmentId: e.employmentId } : {}), payer: e.payer, names: e.names, ...(e.payeReference ? { payeReference: e.payeReference } : {}), source, final: source.final, figures: source.figures, amount: source.amount, others: (e.sources[kind] ?? []).slice(1) };
    });
}
