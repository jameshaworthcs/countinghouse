// One entry point for all analytics, cached per store version (any data change invalidates).

import { ACCESS_GROUP_LABELS, ACCESS_GROUPS, WRAPPER_GROUP_LABELS, WRAPPER_GROUPS } from '../../shared/accounts';
import type { Alert, SummaryResponse } from '../../shared/api';
import { addDays, addYears, today } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import { daysLeftInTaxYear, taxYearOf } from '../../shared/uk';
import type { Store } from '../store';
import { allowances } from './allowances';
import { BalanceEngine } from './balances';
import { cashflow } from './cashflow';
import { AssumptionSet } from '../../shared/assumptions';
import { computeBaseline, standardPeriods } from './baseline';
import { Coverage } from './coverage';
import { accountSummary, estateKnownOn, estateOn, estateSeries, firstDataDate } from './estate';
import { dataHealth } from './health';
import { investments } from './investments';
import { monthlyChecklist } from './monthly';
import { projections, type ProjectionOptions } from './projections';
import { detectRecurring } from './recurring';
import { selfAssessment } from './selfassessment';
import { monthToDate as monthToDateSpending, spending } from './spending';

export class Analytics {
  private cache = new Map<string, { version: number; value: unknown }>();

  constructor(private readonly store: Store) {}

  private cached<T>(key: string, fn: () => T): T {
    const hit = this.cache.get(key);
    if (hit && hit.version === this.store.version) return hit.value as T;
    const value = fn();
    this.cache.set(key, { version: this.store.version, value });
    if (this.cache.size > 200) this.cache.clear();
    return value;
  }

  get engine(): BalanceEngine {
    return this.cached('engine', () => new BalanceEngine(this.store));
  }

  get coverageIndex(): Coverage {
    return this.cached('coverage-index', () => new Coverage(this.store));
  }

  coverage() {
    return this.cached(`coverage:${today()}`, () => this.coverageIndex.summary());
  }

  accountSummaries() {
    return this.cached(`accounts:${today()}`, () => this.store.accounts.map((a) => accountSummary(this.store, this.engine, a)));
  }

  estateSeries(from?: string, to?: string, grouping: 'wrapper' | 'access' = 'wrapper') {
    const end = to ?? today();
    // Never before the first data: an empty stretch would read as an estate of £0.
    const first = firstDataDate(this.store, this.engine);
    const start = from && first && from < first ? first : (from ?? first ?? addDays(end, -365));
    return this.cached(`estate:${start}:${end}:${grouping}`, () => estateSeries(this.store, this.engine, start, end, grouping));
  }

  cashflow(from: string, to: string) {
    return this.cached(`cashflow:${from}:${to}`, () => cashflow(this.store, from, to, this.coverageIndex));
  }

  spending(from: string, to: string) {
    return this.cached(`spending:${from}:${to}`, () => spending(this.store, from, to, this.coverageIndex));
  }

  recurring() {
    return this.cached(`recurring:${today()}`, () => detectRecurring(this.store));
  }

  projections(opts: ProjectionOptions) {
    return this.cached(`proj:${JSON.stringify(opts)}:${today()}`, () => projections(this.store, this.engine, opts));
  }

  allowances(taxYear?: string) {
    return this.cached(`allow:${taxYear ?? ''}:${today()}`, () => allowances(this.store, taxYear));
  }

  selfAssessment(taxYear?: string) {
    return this.cached(`sa:${taxYear ?? ''}:${today()}`, () => selfAssessment(this.store, taxYear));
  }

  investments() {
    return this.cached(`inv:${today()}`, () => investments(this.store, this.engine));
  }

  monthly() {
    return this.cached(`monthly:${today()}`, () => monthlyChecklist(this.store, this.engine));
  }

  health() {
    return this.cached(`health:${today()}`, () => ({ ...dataHealth(this.store, this.engine), coverage: this.coverage() }));
  }

  summary(importCounts: Record<string, number>): SummaryResponse {
    const now = today();
    return this.cached(`summary:${now}:${JSON.stringify(importCounts)}`, () => {
      const engine = this.engine;
      const e = estateOn(this.store, engine, now);
      const accounts = this.accountSummaries();
      const ty = taxYearOf(now);
      // A change is only measured from a day the estate is fully known: comparing with an estate
      // that left some accounts out would show their arrival as growth.
      const anyData = firstDataDate(this.store, engine) !== null;
      const compare = (id: string, label: string, since: string) => {
        if (!anyData || !estateKnownOn(this.store, engine, since)) return { id, label, since, change: null, pct: null };
        const then = estateOn(this.store, engine, since).total;
        const change = Math.round((e.total - then) * 100) / 100;
        return { id, label, since, change, pct: then !== 0 ? change / Math.abs(then) : null };
      };
      const deltas = [compare('30d', 'Past 30 days', addDays(now, -30)), compare('tax-year', `Since ${ty.label} began`, ty.start), compare('1y', 'Past year', addYears(now, -1))];
      // Saving and runway from the last 3 full months (or, after a first import, the days so far),
      // using covered time only.
      const set = new AssumptionSet(this.store.assumptions, now);
      const [recent] = standardPeriods(now, this.coverageIndex);
      const b = computeBaseline(this.store, this.coverageIndex, recent!.from, recent!.to, set);
      const accessible = [...e.access.entries()].filter(([k]) => k === 'now').reduce((s, [, v]) => s + v, 0);
      const kpis = b.available
        ? {
            savingsRate: b.monthly.income > 0 ? (b.monthly.income - b.monthly.spending) / b.monthly.income : null,
            monthlySaving: b.monthly.net,
            monthlySpending: b.monthly.spending,
            runwayMonths: b.monthly.spending > 0 ? Math.round((accessible / b.monthly.spending) * 10) / 10 : null,
            confidence: b.confidence,
            basis: b.basis.kind === 'months' ? `${b.basis.months.length} complete month${b.basis.months.length > 1 ? 's' : ''}` : `${b.basis.days} covered days`,
          }
        : { savingsRate: null, monthlySaving: null, monthlySpending: null, runwayMonths: null, confidence: 'low' as const, basis: b.reason ?? 'Not enough data yet' };
      const monthToDate = monthToDateSpending(this.store, this.coverageIndex, now);
      const cov = this.coverageIndex.summary(3, now);
      const alerts: Alert[] = [];
      const health = this.health();
      const errors = health.issues.filter((i) => i.severity === 'error');
      if (errors.length) {
        alerts.push({ id: 'issues', level: 'critical', title: `${errors.length} problem${errors.length > 1 ? 's' : ''} in the data files`, detail: errors[0]!.message, action: { label: 'Review', href: '/settings#health' } });
      }
      if (importCounts.review) {
        alerts.push({ id: 'review', level: 'info', title: `${importCounts.review} import${importCounts.review > 1 ? 's' : ''} waiting for review`, action: { label: 'Review', href: '/import' } });
      }
      if (importCounts.failed) alerts.push({ id: 'failed', level: 'warning', title: `${importCounts.failed} import${importCounts.failed > 1 ? 's' : ''} failed`, action: { label: 'See why', href: '/import' } });
      const monthly = this.monthly();
      const due = monthly.items.filter((i) => i.due);
      if (due.length && this.store.accounts.length) {
        alerts.push({
          id: 'monthly',
          level: 'info',
          title: `Monthly update: ${due.length} of ${monthly.total} accounts need new data`,
          detail: due
            .slice(0, 4)
            .map((d) => d.name)
            .join(', '),
          action: { label: 'Update', href: '/import' },
        });
      }
      if (health.gaps.length) {
        const g = health.gaps[0]!;
        alerts.push({ id: 'gaps', level: 'warning', title: `${health.gaps.length} balance gap${health.gaps.length > 1 ? 's' : ''} (missing statements?)`, detail: `${g.name}: ${formatMoney(g.difference)} unexplained between ${g.from} and ${g.to}.`, action: { label: 'Details', href: '/settings#health' } });
      }
      for (const f of health.fscs.filter((x) => x.near)) {
        alerts.push({
          id: `fscs-${f.group}`,
          level: 'warning',
          title: `${formatMoney(f.total, { decimals: 0 })} with ${f.institutions.join(' / ')}`,
          detail: f.over ? `Above the ${formatMoney(f.limit, { decimals: 0 })} FSCS limit for one banking licence.` : `Close to the ${formatMoney(f.limit, { decimals: 0 })} FSCS limit for one banking licence.`,
        });
      }
      if (!this.store.profile.dateOfBirth || !this.store.profile.taxBand) {
        const missing = [!this.store.profile.dateOfBirth && 'date of birth', !this.store.profile.taxBand && 'tax band'].filter(Boolean);
        const uses = [!this.store.profile.dateOfBirth && 'LISA, cash-ISA and pension-age rules', !this.store.profile.taxBand && 'your savings allowance and tax figures'].filter(Boolean);
        alerts.push({ id: 'profile', level: 'info', title: `Add your ${missing.join(' and ')}`, detail: `${missing.length > 1 ? 'They drive' : 'It drives'} ${uses.join(', and ')}.`, action: { label: 'Settings', href: '/settings' } });
      }
      const daysLeft = daysLeftInTaxYear(now);
      if (daysLeft <= 60) {
        const al = this.allowances();
        if (al.isa.remaining > 0) alerts.push({ id: 'tye', level: 'info', title: `${daysLeft} days left in ${ty.label}`, detail: `${formatMoney(al.isa.remaining, { decimals: 0 })} of ISA allowance unused.`, action: { label: 'Tax year', href: '/tax' } });
      }
      return {
        asOf: now,
        estate: { value: e.total, assets: e.assets, liabilities: e.liabilities },
        deltas,
        groups: WRAPPER_GROUPS.map((id) => ({ id, label: WRAPPER_GROUP_LABELS[id], value: e.wrapper.get(id) ?? 0 })).filter((g) => g.value !== 0),
        access: ACCESS_GROUPS.map((id) => ({ id, label: ACCESS_GROUP_LABELS[id], value: e.access.get(id) ?? 0 })).filter((g) => g.value !== 0),
        accounts,
        alerts,
        imports: importCounts,
        taxYear: { label: ty.label, daysLeft, start: ty.start, end: ty.end },
        hasData: this.store.accounts.length > 0,
        kpis,
        monthToDate,
        coverage: { lastCompleteMonth: cov.lastCompleteMonth, jointTo: cov.jointTo, limiting: b.basis.limiting.slice(0, 5) },
      };
    });
  }
}
