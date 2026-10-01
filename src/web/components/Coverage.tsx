import { Link } from 'react-router';
import type { CoverageResponse } from '../../shared/api';
import { formatMonth } from '../lib/format';

/** Sequential shade for the share of a month's days that have data. */
const shade = (f: number) => (f <= 0 ? 'var(--panel-2)' : f < 0.5 ? 'var(--seq-2)' : f < 0.9 ? 'var(--seq-4)' : 'var(--seq-6)');

/**
 * Which months each account has transaction data for. With `only`, one account's row, without the
 * account column and the marks for months complete across every account.
 */
export function CoverageGrid({ cov, only }: { cov: CoverageResponse; only?: string }) {
  const rows = only ? cov.accounts.filter((a) => a.accountId === only) : cov.accounts;
  if (!rows.length) return null;
  const starred = rows.some((a) => a.source === 'transactions');
  const years: { year: string; span: number }[] = [];
  for (const m of cov.months) {
    const y = m.slice(0, 4);
    if (years.at(-1)?.year === y) years.at(-1)!.span++;
    else years.push({ year: y, span: 1 });
  }
  return (
    // Positioned, so the cells' screen-reader labels (absolutely placed) scroll with the grid
    // instead of widening the page on a phone.
    <div className="relative overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-[12px]">
        <thead>
          <tr>
            {!only && <th />}
            {years.map((y) => (
              <th key={y.year} colSpan={y.span} className="border-b border-line pb-0.5 text-left text-[11px] font-medium text-ink-3">
                {y.year}
              </th>
            ))}
          </tr>
          <tr>
            {!only && <th className="pr-3 text-left align-bottom font-medium text-ink-3">Account</th>}
            {cov.months.map((m) => (
              <th key={m} className="min-w-8 text-center align-top font-medium text-ink-3">
                {formatMonth(m, { short: true }).split(' ')[0]}
                {!only && (
                  <div className="text-good-ink" aria-label={cov.completeMonths.includes(m) ? 'complete' : undefined}>
                    {cov.completeMonths.includes(m) ? '✓' : '\u00a0'}
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.accountId}>
              {!only && (
                <td className="pr-3 whitespace-nowrap">
                  <Link to={`/accounts/${a.accountId}`} className="text-ink hover:underline">
                    {a.name}
                  </Link>
                  {a.source === 'transactions' && (
                    <span className="ml-1 text-ink-3" title="No import records: covered from first to last transaction">
                      *
                    </span>
                  )}
                </td>
              )}
              {a.source === 'none' ? (
                // Tracked by balances or valuations alone: nothing is missing, so no empty months.
                <td colSpan={a.months.length} className="h-6 px-2 text-[11.5px] text-ink-3">
                  no transactions: tracked by its balances
                </td>
              ) : (
                a.months.map((m) => (
                  <td key={m.month} className="h-6 min-w-8 rounded-[3px]" style={{ background: shade(m.fraction) }} title={`${a.name}, ${formatMonth(m.month)}: ${Math.round(m.fraction * 100)}% of days covered`}>
                    <span className="sr-only">
                      {formatMonth(m.month)}: {Math.round(m.fraction * 100)}%
                    </span>
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-3">
        {(
          [
            ['none', 0],
            ['under half', 0.3],
            ['most days', 0.7],
            ['complete', 1],
          ] as const
        ).map(([label, f]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="inline-block size-3 rounded-[3px]" style={{ background: shade(f) }} /> {label}
          </span>
        ))}
        {starred && <span>{only ? 'Covered from its first to its last transaction: there are no statements with dates to go by' : '* covered from its first to its last transaction (no import records)'}</span>}
      </div>
    </div>
  );
}
