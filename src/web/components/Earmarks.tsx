// Set aside (docs/FORMULAS.md §21): the Overview card and the transaction drawer's section. Both show
// nothing, and ask for nothing, without earmarks.json.

import { HandCoins, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { EarmarksResponse } from '../../shared/api';
import type { Transaction } from '../../shared/schema';
import { useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { BY_WORDS, EFFECT_WORDS } from '../lib/earmarks';
import { formatDate, money, plural } from '../lib/format';
import { Card, Money } from './ui';

/** The set-aside figures; never asked for when nothing is set up. */
export function useEarmarks() {
  const { data } = useAppData();
  return useApi<EarmarksResponse>(['earmarks'], '/earmarks', { enabled: data.earmarks.length > 0 });
}

/** Overview: what is spendable, and what each pot has set aside. Nothing when nothing is set up. */
export function EarmarksPanel() {
  const { data } = useAppData();
  const q = useEarmarks();
  if (!data.earmarks.length) return null;
  const r = q.data?.result;
  if (!r) {
    if (!q.data?.problems.length) return null;
    return (
      <Card title="Set aside" actions={<Link to="/earmarks" className="text-[13px] font-medium text-accent hover:underline">Details</Link>}>
        <p className="text-[13px] text-ink-2">{q.data.problems[0]}</p>
      </Card>
    );
  }
  const stale = r.accounts.filter((a) => a.role === 'everyday' && a.stale);
  return (
    <Card title="Set aside" actions={<Link to="/earmarks" className="text-[13px] font-medium text-accent hover:underline">Details</Link>}>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-[12.5px] text-ink-3">Spendable</div>
          <Money value={r.spendable} decimals={0} className="text-[24px] font-semibold tracking-tight text-ink" />
        </div>
        {r.pots.map((p) => (
          <div key={p.id}>
            <div className="text-[12.5px] text-ink-3">{p.setAside >= 0 ? `Set aside for ${p.name}` : `You've covered for ${p.name}`}</div>
            <Money value={Math.abs(p.setAside)} decimals={0} className="text-[18px] font-medium text-ink" />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-ink-3">
        Worked out from your payments and balances{r.oldest ? `, to ${formatDate(r.oldest)}${r.newest && r.newest !== r.oldest ? `–${formatDate(r.newest)}` : ''}` : ''}.
        {stale.length > 0 && (
          <span className="ml-1 inline-flex items-center gap-1 text-warn-ink">
            <TriangleAlert className="size-3.5" aria-hidden /> {stale.map((a) => a.name).join(', ')} {stale.length === 1 ? 'is' : 'are'} out of date
          </span>
        )}
        {r.toCheck.length > 0 && (
          <Link to="/earmarks#to-check" className="ml-2 font-medium text-accent hover:underline">
            {plural(r.toCheck.length, 'payment')} to check
          </Link>
        )}
      </p>
    </Card>
  );
}

/** The drawer's read-only "Set aside" section: what a payment counts as, worked out each time, never stored on it. */
export function EarmarkSection({ tx }: { tx: Transaction }) {
  const { data } = useAppData();
  const q = useEarmarks();
  const setup = q.data?.setup;
  if (!data.earmarks.length || !setup || !q.data?.result || !setup.everyday.includes(tx.accountId)) return null;
  const said: string[] = [];
  for (const pot of q.data.result.pots) {
    if (tx.date < pot.start) continue;
    for (const line of pot.lines) {
      for (const row of line.rows) {
        if (row.transactionId !== tx.id) continue;
        const why = row.by === 'rule' ? `rule “${row.ruleName ?? row.ruleId}”` : row.by === 'decision' ? `your decision${row.reason ? `: “${row.reason}”` : ''}` : BY_WORDS[row.by];
        said.push(`${EFFECT_WORDS[line.effect]} (${pot.name}): ${money(Math.abs(row.counted))}, by ${why}.`);
      }
    }
  }
  const toCheck = q.data.result.toCheck.some((c) => c.transactionIds.includes(tx.id));
  const onItsWay = q.data.result.onItsWay.some((w) => w.transactionId === tx.id);
  if (!said.length && !toCheck && !onItsWay) said.push('Your own money: it doesn’t change what is set aside.');
  if (onItsWay) said.push('Money on its way between two everyday accounts: the other one’s statements don’t show it yet.');
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <HandCoins className="size-4 text-ink-3" /> Set aside
      </h3>
      <ul className="grid gap-1 text-[13px] text-ink-2">
        {said.map((s) => (
          <li key={s} className="sensitive">
            {s}
          </li>
        ))}
        {toCheck && (
          <li>
            <Link to="/earmarks#to-check" className="text-accent hover:underline">
              Waiting to be checked
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}
