// Field-level scoring of a draft against a case's expected result. Every expected field is one
// point; a missing row loses its row point, an extra row costs a precision point.

import { alignRows, sameMoney, sameText } from '../src/server/ingest/verify';
import type { Draft, DraftSection } from '../src/shared/schema';
import type { Expected, ExpectedSection } from './cases';

export interface Tally {
  correct: number;
  total: number;
}
export interface CaseScore {
  fields: Record<string, Tally>;
  rows: { expected: number; found: number; extra: number };
  errors: string[];
  score: number;
}

// Rows are aligned and text compared exactly as the live check does (src/server/ingest/verify.ts).
export { sameText };

class Scorer {
  fields: Record<string, Tally> = {};
  errors: string[] = [];
  rows = { expected: 0, found: 0, extra: 0 };
  check(field: string, ok: boolean, message?: string) {
    const t = (this.fields[field] ??= { correct: 0, total: 0 });
    t.total++;
    if (ok) t.correct++;
    else if (message && this.errors.length < 40) this.errors.push(message);
  }
}

function targetMatches(e: ExpectedSection, s: DraftSection): boolean {
  if (typeof e.account === 'string') return s.target.mode === 'existing' && s.target.accountId === e.account;
  if (s.target.mode !== 'new') return false;
  return s.target.account.type === e.account.new && (!e.account.last4 || s.target.account.last4 === e.account.last4);
}

function scoreSection(sc: Scorer, e: ExpectedSection, s: DraftSection | undefined, label: string) {
  sc.check('account', Boolean(s && targetMatches(e, s)), `${label}: ${s ? `imported into ${s.target.mode === 'existing' ? s.target.accountId : s.target.mode === 'new' ? `a new ${s.target.account.type}${s.target.account.last4 ? ` ${s.target.account.last4}` : ''}` : 'nothing (skipped)'}` : 'no section found'}`);
  const scalar = (field: string, exp: number | string | undefined, act: number | string | undefined) => {
    if (exp === undefined) return;
    const ok = typeof exp === 'number' ? sameMoney(exp, act as number | undefined) : exp === act;
    sc.check(field, ok, `${label} ${field}: expected ${exp}, got ${act ?? 'nothing'}`);
  };
  scalar('period', e.periodStart, s?.periodStart);
  scalar('period', e.periodEnd, s?.periodEnd);
  scalar('balance', e.openingBalance, s?.openingBalance);
  scalar('balance', e.balance, s?.balance);
  // A screen whose figures are not the account's value (an activity list's cash, one fund's page).
  if (e.noValue) sc.check('balance', Boolean(s) && (s!.balance === undefined || !s!.recordBalance), `${label}: recorded ${s?.balance} as the account's value`);
  scalar('balanceDate', e.balanceDate, s?.balanceDate);
  scalar('wrapper', e.contributions, s?.contributions);
  scalar('wrapper', e.bonusToDate, s?.bonusToDate);
  scalar('wrapper', e.taxYearContributions, s?.taxYearContributions);
  scalar('wrapper', e.cash, s?.cash);
  scalar('totals', e.statedTotals?.moneyIn, s?.statedTotals?.moneyIn);
  scalar('totals', e.statedTotals?.moneyOut, s?.statedTotals?.moneyOut);

  const exp = e.transactions ?? [];
  const act = s?.transactions ?? [];
  if (exp.length || act.length) {
    const pairs = alignRows(exp, act);
    sc.rows.expected += exp.length;
    sc.rows.found += pairs.size;
    sc.rows.extra += act.length - pairs.size;
    exp.forEach((t, i) => {
      const j = pairs.get(i);
      const where = `${label} ${t.date} ${t.description} ${t.amount}`;
      sc.check('row', j !== undefined, `${where}: missing`);
      if (j === undefined) return;
      const a = act[j]!;
      sc.check('date', a.date === t.date, `${where}: dated ${a.date}`);
      sc.check('sign', Math.sign(a.amount) === Math.sign(t.amount), `${where}: sign wrong (${a.amount})`);
      sc.check('amount', sameMoney(a.amount, t.amount), `${where}: amount ${a.amount}`);
      sc.check('description', sameText(t.description, a.description), `${where}: description "${a.description}"`);
      sc.check('pending', Boolean(a.pending) === Boolean(t.pending), `${where}: pending ${Boolean(a.pending)}`);
      if (t.balanceAfter !== undefined) sc.check('balanceAfter', sameMoney(a.balanceAfter, t.balanceAfter), `${where}: balance after ${a.balanceAfter ?? 'none'}`);
      if (t.original) sc.check('original', sameMoney(a.original?.amount, t.original.amount) && a.original?.currency === t.original.currency, `${where}: original ${a.original ? `${a.original.amount} ${a.original.currency}` : 'none'}`);
      sc.check('duplicate', t.duplicate ? a.status !== 'new' : a.status === 'new', `${where}: ${t.duplicate ? 'not recognised as already imported' : `marked ${a.status}`}`);
    });
    const alignedActual = new Set(pairs.values());
    act.forEach((a, k) => {
      sc.check('noExtra', alignedActual.has(k), `${label} extra row: ${a.date} ${a.description} ${a.amount}`);
    });
  }

  // A document with no holdings on it (a list of bond numbers, say) must not gain any.
  if (e.holdings) {
    const extra = (s?.holdings ?? []).filter((x) => !e.holdings!.some((h) => (h.isin && x.isin?.toUpperCase() === h.isin) || sameText(h.name, x.name)));
    for (const x of extra) sc.check('noExtraHolding', false, `${label} extra holding: ${x.name} ${x.value}`);
  }
  for (const h of e.holdings ?? []) {
    const found = (s?.holdings ?? []).find((x) => (h.isin && x.isin?.toUpperCase() === h.isin) || sameText(h.name, x.name));
    sc.check('holding', Boolean(found), `${label} holding missing: ${h.name}`);
    if (!found) continue;
    sc.check('holdingValue', sameMoney(found.value, h.value), `${label} ${h.name}: value ${found.value}`);
    if (h.units !== undefined) sc.check('holdingUnits', found.units !== undefined && Math.abs(found.units - h.units) < 0.0005, `${label} ${h.name}: units ${found.units ?? 'none'}`);
    if (h.isin) sc.check('holdingIsin', found.isin?.toUpperCase() === h.isin, `${label} ${h.name}: ISIN ${found.isin ?? 'none'}`);
  }
}

/** A sentence that states something (not one saying the document does not say it). */
const HEDGED = /\b(whether|not (say|show|state|name)|doesn'?t|does not|isn'?t|is not|no indication|unclear|unknown|cannot tell|can'?t tell|may|might|possibly|perhaps)\b/i;

export function scoreCase(expected: Expected, draft: Draft | undefined, outcome: { nothingNew?: boolean } = {}): CaseScore {
  const sc = new Scorer();
  // Understood but adding nothing is an outcome to recognise, and never to claim of a document
  // that does add something.
  sc.check('nothingNew', Boolean(outcome.nothingNew) === Boolean(expected.nothingNew), expected.nothingNew ? 'not recognised as adding nothing new' : 'wrongly said to add nothing new');
  if (expected.unsupported) {
    const sentences = (draft?.notes ?? []).flatMap((n) => n.split(/(?<=[.;])\s+/));
    const claims = sentences.filter((x) => expected.unsupported!.test(x) && !HEDGED.test(x));
    sc.check('noClaim', claims.length === 0, `a note claims what the document does not say: "${claims[0]?.slice(0, 160)}"`);
  }
  const sections = draft?.sections ?? [];
  const used = new Set<number>();
  // Sections are matched by where they are imported; a misrouted one is still scored for content.
  const matched = expected.sections.map((e) => {
    const i = sections.findIndex((s, k) => !used.has(k) && targetMatches(e, s));
    if (i >= 0) used.add(i);
    return i;
  });
  expected.sections.forEach((e, n) => {
    let i = matched[n]!;
    if (i < 0) {
      i = sections.findIndex((_, k) => !used.has(k));
      if (i >= 0) used.add(i);
    }
    scoreSection(sc, e, i >= 0 ? sections[i] : undefined, typeof e.account === 'string' ? e.account : `new ${e.account.new}`);
  });
  sections.forEach((s, k) => {
    if (!used.has(k) && s.target.mode !== 'skip') sc.check('noExtraSection', false, `extra section: ${s.detected.accountName ?? s.detected.institutionName ?? s.key}`);
  });
  const usedFigures = new Set<number>();
  const figures = draft?.figures ?? [];
  for (const f of expected.figures ?? []) {
    let i = figures.findIndex((x, n) => !usedFigures.has(n) && x.kind === f.kind && sameMoney(x.amount, f.amount));
    if (i < 0) i = figures.findIndex((x, n) => !usedFigures.has(n) && x.kind === f.kind);
    const found = i >= 0 ? figures[i] : undefined;
    if (i >= 0) usedFigures.add(i);
    sc.check('figure', Boolean(found && sameMoney(found.amount, f.amount)), `figure ${f.kind} ${f.amount}: ${found ? `got ${found.amount}` : 'missing'}`);
    if (found && f.taxYear) sc.check('figureYear', found.taxYear === f.taxYear, `figure ${f.kind}: tax year ${found.taxYear ?? 'none'}`);
  }
  // A figure the document does not state would be counted on the tax page (a net interest figure
  // next to the gross one counts the interest twice).
  // A printed zero ("Tax deducted £0.00") changes no total, so it costs nothing.
  figures.forEach((x, n) => {
    if (!usedFigures.has(n) && x.amount !== 0) sc.check('noExtraFigure', false, `extra figure: ${x.kind} ${x.amount} (${x.label})`);
  });
  const all = Object.values(sc.fields);
  const correct = all.reduce((s, t) => s + t.correct, 0);
  const total = all.reduce((s, t) => s + t.total, 0);
  return { fields: sc.fields, rows: sc.rows, errors: sc.errors, score: total ? correct / total : 1 };
}
