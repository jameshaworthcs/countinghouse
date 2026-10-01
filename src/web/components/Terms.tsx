// An account's terms on its page: its rates, its limit and a card's minimum payment as its latest
// document gives them, what ends soon, and how they changed (docs/FORMULAS.md §4, "Terms").

import { Percent } from 'lucide-react';
import { Link } from 'react-router';
import type { TermsFrom, TermsResponse } from '../../shared/api';
import { diffDays, today } from '../../shared/dates';
import type { Account, Terms, TermsRate } from '../../shared/schema';
import { RATE_NAMES } from '../../shared/terms';
import { useApi } from '../lib/api';
import { formatDate, money } from '../lib/format';
import { Badge, Callout, Card, StatusBadge } from './ui';

/** "34.94% simple, variable". */
export function rateText(r: Pick<TermsRate, 'rate' | 'basis' | 'variable'>): string {
  return [`${r.rate}%`, [r.basis, r.variable === undefined ? '' : r.variable ? 'variable' : 'fixed'].filter(Boolean).join(', ')].filter(Boolean).join(' ');
}

/** What a limit is on an account of this type. */
export const limitName = (type: Account['type'] | undefined) => (type === 'credit_card' ? 'Credit limit' : type === 'current' ? 'Arranged overdraft' : 'Limit');

/** Each rate, with when it ends and the balance at it. */
export function RatesList({ terms, type, now = today() }: { terms: Pick<Terms, 'rates' | 'limit' | 'minimumPayment' | 'paymentDue'>; type?: Account['type'] | undefined; now?: string }) {
  return (
    <ul className="divide-y divide-line text-[13px]">
      {terms.rates.map((r, i) => {
        const days = r.until ? diffDays(now, r.until) : undefined;
        return (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <span className="min-w-0 text-ink-2">
              {r.label ?? RATE_NAMES[r.applies]}
              {r.label && !r.label.toLowerCase().includes(RATE_NAMES[r.applies].toLowerCase()) && <span className="text-ink-3"> · {RATE_NAMES[r.applies].toLowerCase()}</span>}
              {r.balance !== undefined && (
                <span className="text-ink-3">
                  {' '}
                  · <span className="sensitive">{money(r.balance)}</span> at this rate
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-baseline justify-end gap-x-2">
              <span className="font-medium text-ink tabular-nums">{rateText(r)}</span>
              {r.until && days !== undefined && (days < 0 ? <Badge tone="muted">ended {formatDate(r.until)}</Badge> : <StatusBadge status={days <= 60 ? 'warn' : 'info'}>until {formatDate(r.until)}</StatusBadge>)}
            </span>
          </li>
        );
      })}
      {terms.limit !== undefined && (
        <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
          <span className="text-ink-2">{limitName(type)}</span>
          <span className="sensitive font-medium text-ink tabular-nums">{money(terms.limit)}</span>
        </li>
      )}
      {terms.minimumPayment !== undefined && (
        <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
          <span className="text-ink-2">Minimum payment{terms.paymentDue ? `, due ${formatDate(terms.paymentDue)}` : ''}</span>
          <span className="sensitive font-medium text-ink tabular-nums">{money(terms.minimumPayment)}</span>
        </li>
      )}
    </ul>
  );
}

/** "Purchases 41.21% → 34.94%", "Credit limit £500 → £2,400". */
function Changes({ changes, type }: { changes: TermsResponse['changes']; type: Account['type'] }) {
  const byWhat = new Map<string, TermsResponse['changes']>();
  for (const c of changes) (byWhat.get(c.what) ?? byWhat.set(c.what, []).get(c.what)!).push(c);
  const moved = [...byWhat.entries()].filter(([, list]) => list.length > 1);
  if (!moved.length) return null;
  const show = (what: string, n: number) => (what === 'limit' ? money(n, { decimals: 0 }) : `${n}%`);
  return (
    <div className="mt-3">
      <div className="mb-1 text-[12px] font-medium text-ink-3">How they changed</div>
      <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
        {moved.map(([what, list]) => (
          <li key={what}>
            <span className="text-ink-3">{what === 'limit' ? limitName(type) : RATE_NAMES[what as TermsRate['applies']]}: </span>
            {list.map((c, i) => (
              <span key={c.asOf} className="sensitive">
                {i > 0 && ' → '}
                {show(what, c.to)}
                <span className="text-ink-3"> ({formatDate(c.asOf)})</span>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A document gives them; your own figures give them. */
const gives = (from: TermsFrom) => (from.importId ? 'gives' : 'give');

/** "your statement.pdf of 1 Sep 2026", linking to the document. */
function FromDoc({ from }: { from: TermsFrom }) {
  return (
    <>
      {from.importId ? (
        <Link to={`/import/${from.importId}`} className="hover:underline">
          {from.fileName ?? 'your document'}
        </Link>
      ) : (
        'your own figures'
      )}{' '}
      of {formatDate(from.asOf)}
    </>
  );
}

export function TermsCard({ account }: { account: Account }) {
  const q = useApi<TermsResponse>(['terms', account.id], `/accounts/${account.id}/terms`);
  const t = q.data;
  const parts: TermsFrom[] = [t?.rates, t?.limit, t?.minimum].flatMap((x) => (x ? [x] : []));
  if (!parts.length && !account.maturesOn && account.interestRate === undefined) return null;
  const coming = (t?.ending ?? []).filter((e) => e.days >= 0);
  // The parts come from one document, or each from the latest that gives it.
  const one = parts.every((p) => p.asOf === parts[0]!.asOf && p.importId === parts[0]!.importId);
  return (
    <Card
      id="terms"
      className="mb-5"
      title={
        <span className="inline-flex items-center gap-2">
          <Percent className="size-4 text-ink-3" /> Terms
        </span>
      }
      description={
        !parts.length ? (
          'As you gave them.'
        ) : one ? (
          <>
            As <FromDoc from={parts[0]!} /> {gives(parts[0]!)} them.
          </>
        ) : (
          <>
            {t?.rates && (
              <>
                Rates as <FromDoc from={t.rates} /> {gives(t.rates)} them.{' '}
              </>
            )}
            {t?.limit && (
              <>
                {limitName(account.type)} as <FromDoc from={t.limit} />.{' '}
              </>
            )}
            {t?.minimum && (
              <>
                Minimum payment as <FromDoc from={t.minimum} />.
              </>
            )}
          </>
        )
      }
    >
      {coming.map(({ rate, days }) => (
        <Callout key={`${rate.applies}-${rate.until}`} tone="warn" className="mb-3" title={`${rate.label ?? RATE_NAMES[rate.applies]} at ${rate.rate}% ends ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`}>
          Its last day is {formatDate(rate.until!)}.
          {rate.balance !== undefined && t?.rates && (
            <>
              {' '}
              <span className="sensitive">{money(rate.balance)}</span> was at this rate on {formatDate(t.rates.asOf)}.
            </>
          )}
          {(() => {
            const after = t?.rates?.rates.find((r) => r.applies === rate.applies && !r.until);
            return after ? ` After it, ${rateText(after)} applies.` : ' What applies after it is not on the document.';
          })()}
        </Callout>
      ))}
      {parts.length > 0 && <RatesList terms={{ rates: t?.rates?.rates ?? [], ...(t?.limit ? { limit: t.limit.value } : {}), ...(t?.minimum ? { minimumPayment: t.minimum.amount, ...(t.minimum.due ? { paymentDue: t.minimum.due } : {}) } : {}) }} type={account.type} />}
      {(account.interestRate !== undefined || account.maturesOn) && (
        <div className="mt-2 text-[12.5px] text-ink-3">
          {account.interestRate !== undefined && <>Your own rate for it: {account.interestRate}%, which projections use. </>}
          {account.maturesOn && <>It matures on {formatDate(account.maturesOn)}.</>}
        </div>
      )}
      {t && <Changes changes={t.changes} type={account.type} />}
    </Card>
  );
}
