// Agreements on the Spending page: what an accommodation offer, a contract, a payment plan or a student
// finance award says is due and when, each payment checked against what was paid, by you, to you, or by
// a loan for you (docs/FORMULAS.md §10, "Agreements").

import { Handshake } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router';
import type { AgreementView } from '../../shared/api';
import { today } from '../../shared/dates';
import { useApi } from '../lib/api';
import { useAppData } from '../lib/data';
import { formatDate, money } from '../lib/format';
import { Badge, Card, Money, StatusBadge } from './ui';

const paidLink = (p: { accountId: string; date: string }) => `/transactions?accounts=${p.accountId}&period=custom&from=${p.date}&to=${p.date}`;

function Payment({ p, i, toYou }: { p: AgreementView['payments'][number]; i: number; toYou: boolean }) {
  const { accountName } = useAppData();
  const off = p.paid?.difference;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1.5 sm:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,22rem)]">
      <span className="min-w-0 text-ink-2">
        {p.label ?? `Payment ${i + 1}`}
        <span className="text-ink-3"> · due {formatDate(p.due)}</span>
      </span>
      <Money value={p.amount} className="tabular text-right" />
      <span className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:col-span-1">
        {p.paid ? (
          <>
            <Link to={paidLink(p.paid)} className="hover:underline">
              <StatusBadge status="good">{toYou ? 'Received' : 'Paid'} {formatDate(p.paid.date)}</StatusBadge>
            </Link>
            <span className="text-[12px] text-ink-3">
              {off ? (
                <>
                  <span className="sensitive">{money(Math.abs(off))}</span> {off < 0 ? 'less' : 'more'} ·{' '}
                </>
              ) : null}
              {accountName(p.paid.accountId)}
            </span>
          </>
        ) : p.status === 'upcoming' ? (
          <Badge tone="muted">Not due yet</Badge>
        ) : p.status === 'due' ? (
          <StatusBadge status="info">Due</StatusBadge>
        ) : p.status === 'documented' ? (
          <span title="Its document says it was paid; no payment matching it is in your accounts (from before your data begins, say)">
            <Badge tone="muted">Paid, says its document</Badge>
          </span>
        ) : p.status === 'cancelled' ? (
          <Badge tone="muted">Cancelled</Badge>
        ) : (
          <StatusBadge status="warn">No payment seen</StatusBadge>
        )}
      </span>
    </li>
  );
}

function AgreementBlock({ v }: { v: AgreementView }) {
  const { cats, accountName } = useAppData();
  const a = v.agreement;
  const toYou = a.direction === 'in';
  // Who pays whom: you pay it; it pays you (lent through an account of yours); someone pays it for you.
  const who = toYou ? `${a.counterparty} pays you${a.accountId ? `, lent through ${accountName(a.accountId)}` : ''}` : a.paidBy ? `${a.paidBy} pays ${a.counterparty} for you` : a.counterparty;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="font-medium text-ink">{a.name}</div>
          <div className="text-[12.5px] text-ink-3">
            {who} · {formatDate(a.from)}
            {a.until ? ` to ${formatDate(a.until)}` : ''}
            {a.total !== undefined && (
              <>
                {' '}
                · <Money value={a.total} /> in all
              </>
            )}
          </div>
        </div>
        <Badge tone="neutral">{cats.name(a.category)}</Badge>
      </div>
      <ul className="mt-1 divide-y divide-line text-[13px]">
        {v.payments.map((p, i) => (
          <Payment key={i} p={p} i={i} toYou={toYou} />
        ))}
      </ul>
      {v.others.length > 0 && (
        <div className="mt-1 text-[12.5px] text-ink-3">
          Also paid to {a.counterparty} as {cats.name(a.category).toLowerCase()} around it:{' '}
          {v.others.map((o, i) => (
            <Fragment key={o.transactionId}>
              {i > 0 && ', '}
              <Link to={paidLink(o)} className="sensitive hover:underline">
                {money(o.amount)} on {formatDate(o.date)}
              </Link>{' '}
              ({accountName(o.accountId)})
            </Fragment>
          ))}
          .
        </div>
      )}
      <div className="mt-1.5 text-[12.5px] text-ink-3">
        <Money value={v.paid} className="font-medium text-ink-2" /> {toYou ? 'received in your accounts' : a.accountId ? `paid from ${accountName(a.accountId)}` : 'paid to it in your accounts'}
        {a.total !== undefined ? (
          <>
            {' '}
            of the <Money value={a.total} /> it comes to
          </>
        ) : (
          ''
        )}
        .{a.statusAsOf && v.payments.some((p) => p.status === 'documented') ? ` Its document gave the payments as they were on ${formatDate(a.statusAsOf)}.` : ''}
      </div>
      {(a.details.length > 0 || a.reference || a.agreedOn || a.notes) && (
        <details className="mt-2 text-[12.5px]">
          <summary className="cursor-pointer text-ink-3 hover:text-ink-2">What its document says</summary>
          <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)]">
            {a.agreedOn && (
              <>
                <dt className="text-ink-3">Agreed</dt>
                <dd className="text-ink-2">{formatDate(a.agreedOn)}</dd>
              </>
            )}
            {a.reference && (
              <>
                <dt className="text-ink-3">Reference</dt>
                <dd className="text-ink-2">{a.reference}</dd>
              </>
            )}
            {a.details.map((d, i) => (
              <Fragment key={i}>
                <dt className="text-ink-3">{d.label}</dt>
                <dd className="text-ink-2">{d.value}</dd>
              </Fragment>
            ))}
          </dl>
          {a.notes && <p className="mt-1.5 text-ink-2">{a.notes}</p>}
          {a.source.importId && (
            <Link to={`/import/${a.source.importId}`} className="mt-1.5 inline-block text-accent hover:underline">
              The document
            </Link>
          )}
        </details>
      )}
    </div>
  );
}

/** Each agreement: those still running first, then the rest, the latest first. Nothing when there are none. */
export function AgreementsCard() {
  const q = useApi<AgreementView[]>(['agreements'], '/agreements');
  if (!q.data?.length) return null;
  const now = today();
  const running = (v: AgreementView) => v.payments.some((p) => p.status === 'upcoming' || p.status === 'due') || (v.agreement.until ?? v.agreement.from) >= now;
  const list = [...q.data].sort((x, y) => Number(running(y)) - Number(running(x)) || y.agreement.from.localeCompare(x.agreement.from));
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Handshake className="size-4 text-ink-3" /> Agreements</span>} description="What an offer, contract, payment plan or student finance award says is due and when, checked against what was paid. Its payments take its category as they come." padded={false}>
      <div className="divide-y divide-line border-t border-line">
        {list.map((v) => (
          <AgreementBlock key={v.agreement.id} v={v} />
        ))}
      </div>
    </Card>
  );
}
