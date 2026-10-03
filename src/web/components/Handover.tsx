import { Link } from 'react-router';
import type { AccountDetailResponse, Handover } from '../../shared/api';
import { addDays, formatDate } from '../../shared/dates';
import { money } from '../lib/format';
import { Callout } from './ui';

/** What carried over between two linked accounts, in words (docs/FORMULAS.md §9). */
export function HandoverText({ h }: { h: Handover }) {
  const last = formatDate(addDays(h.from, -1));
  const estimated = h.estimated ? ' (worked out with no statement balance to rest on)' : '';
  if (h.status === 'adds-up')
    return (
      <span>
        <span className="sensitive">{money(h.opening)}</span> carried over: what {h.older.name} ended with on {last} is what {h.newer.name} starts from{estimated}.
      </span>
    );
  if (h.status === 'unexplained')
    return (
      <span className="text-warn-ink">
        {h.older.name} ended on <span className="sensitive">{money(h.closing)}</span> on {last}, but {h.newer.name} starts from <span className="sensitive">{money(h.opening)}</span>:{' '}
        <span className="sensitive">{money(Math.abs(h.difference!))}</span> unexplained. A statement, or a row, is missing on one side{estimated}.
      </span>
    );
  if (h.valued) return <span>One of them is valued, so what carried over cannot be checked against its balances.</span>;
  return <span>{h.closing === null ? `No balance for ${h.older.name} on ${last}` : `No balance for ${h.newer.name} on ${formatDate(h.from)}`} to check what carried over against.</span>;
}

/** On an account's page: the account it carries on from, and the one that carries on from it. */
export function LinkedAccounts({ links }: { links: AccountDetailResponse['links'] }) {
  if (!links || (!links.carriesOnFrom && !links.carriedOnAs)) return null;
  const { carriesOnFrom: from, carriedOnAs: as } = links;
  const warn = from?.status === 'unexplained' || as?.status === 'unexplained';
  return (
    <Callout tone={warn ? 'warn' : 'neutral'} className="mb-5" title="Linked account">
      <div className="flex flex-col gap-1.5">
        {from && (
          <div>
            Carries on from{' '}
            <Link to={`/accounts/${from.older.accountId}`} className="font-medium text-accent hover:underline">
              {from.older.name}
            </Link>{' '}
            from {formatDate(from.from)}, under the same number: statements that run across that day are split between the two.{' '}
            <HandoverText h={from} />
          </div>
        )}
        {as && (
          <div>
            Carried on as{' '}
            <Link to={`/accounts/${as.newer.accountId}`} className="font-medium text-accent hover:underline">
              {as.newer.name}
            </Link>{' '}
            from {formatDate(as.from)}.{' '}
            <HandoverText h={as} />
          </div>
        )}
      </div>
    </Callout>
  );
}
