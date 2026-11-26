// Set aside (docs/FORMULAS.md §21): the Overview card and the transaction drawer's section. Both show
// nothing, and ask for nothing, without earmarks.json.

import { HandCoins, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { EarmarkFigures, EarmarksResponse } from '../../shared/api';
import type { EarmarkEffect, Transaction } from '../../shared/schema';
import { api, useApi, useApiMutation, type Json } from '../lib/api';
import { useAppData } from '../lib/data';
import { BY_WORDS, EFFECT_WORDS } from '../lib/earmarks';
import { formatDate, money, plural } from '../lib/format';
import { Button, Card, Dialog, ErrorNote, Field, IconButton, Input, Money, NumberInput, Select, useToast } from './ui';

/** Which effects a payment in or out can have (as the server checks). */
const EFFECTS_IN: EarmarkEffect[] = ['source', 'from-pot', 'own-back', 'use', 'own'];
const EFFECTS_OUT: EarmarkEffect[] = ['use', 'to-pot', 'topped-up', 'source', 'own'];

export interface DecidePayment {
  pot: string;
  potName: string;
  transactionId: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  /** The parts to start from: the decision there is, the suggestion, or how it counts now. */
  parts: { effect: EarmarkEffect; amount: number }[];
  reason?: string;
  /** There is a decision of yours already: it can be taken away. */
  decided?: boolean;
}

/** One decision for one payment, with its effect on the figure shown as you go. Nothing is written on the payment. */
export function DecisionDialog({ payment, onClose }: { payment: DecidePayment | null; onClose: () => void }) {
  const { accountName } = useAppData();
  const toast = useToast();
  const [parts, setParts] = useState(payment?.parts ?? []);
  const [reason, setReason] = useState(payment?.reason ?? '');
  const [preview, setPreview] = useState<{ before: EarmarkFigures | null; after: EarmarkFigures | null } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    setParts(payment?.parts ?? []);
    setReason(payment?.reason ?? '');
    setPreview(null);
  }, [payment]);
  const abs = Math.abs(payment?.amount ?? 0);
  const used = Math.round(parts.reduce((s, p) => s + (p.amount || 0), 0) * 100) / 100;
  const rest = Math.round((abs - used) * 100) / 100;
  const body = payment ? { decisions: [{ pot: payment.pot, transaction: payment.transactionId, parts: parts.length ? parts.filter((p) => p.amount > 0) : null, reason: reason.trim() || undefined }] } : null;
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!body || rest < 0 || parts.some((p) => !(p.amount > 0))) return;
    const timer = setTimeout(() => {
      api<{ before: EarmarkFigures | null; after: EarmarkFigures | null }>('/earmarks/preview', { body })
        .then((r) => {
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: Error) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(timer);
    // `key` stands for the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const save = useApiMutation((b: Json) => api('/earmarks/decisions', { body: b }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Decided' });
      onClose();
    },
  });
  if (!payment) return null;
  const allowed = payment.amount > 0 ? EFFECTS_IN : EFFECTS_OUT;
  const invalid = rest < 0 || parts.some((p) => !(p.amount > 0)) || !parts.length;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`What did this do to ${payment.potName}?`}
      description="Your decision is kept with Set aside, by payment: nothing is written on the payment itself."
      footer={
        <>
          {payment.decided && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={save.isPending} onClick={() => save.mutate({ decisions: [{ pot: payment.pot, transaction: payment.transactionId, parts: null }] })}>
              Take my decision away
            </Button>
          )}
          <Button variant="primary" disabled={invalid} loading={save.isPending} onClick={() => body && save.mutate(body)}>
            Decide
          </Button>
        </>
      }
    >
      <div className="grid gap-4 text-[13.5px]">
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
          <div className="sensitive text-ink">{payment.description}</div>
          <div className="text-ink-3">
            {formatDate(payment.date)} · {accountName(payment.accountId)} · <span className="sensitive">{money(payment.amount)}</span>
          </div>
        </div>
        <div className="grid gap-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-end gap-2">
              <Field label={i === 0 ? 'Counted as' : ' '} className="min-w-0 flex-1">
                <Select value={p.effect} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, effect: e.target.value as EarmarkEffect } : x)))}>
                  {allowed.map((e) => (
                    <option key={e} value={e}>
                      {EFFECT_WORDS[e]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={i === 0 ? 'Amount' : ' '} className="w-32">
                <NumberInput value={p.amount} onValue={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: v ?? 0 } : x)))} />
              </Field>
              <IconButton label="Remove this part" onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          {parts.length < 5 && (
            <div>
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setParts([...parts, { effect: allowed[0]!, amount: Math.max(0, rest) }])}>
                Add a part
              </Button>
            </div>
          )}
          <p className={rest < 0 ? 'text-bad-ink' : 'text-ink-3'}>{rest < 0 ? `The parts add up to ${money(used)}, more than the payment.` : rest > 0 ? `The rest, ${money(rest)}, is your own money.` : 'All of it is counted.'}</p>
        </div>
        <Field label="Why" hint="For you later, and for agents proposing more like it.">
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Granny’s birthday money, saved" />
        </Field>
        {preview?.before && preview.after && (
          <div className="sensitive rounded-lg border border-line px-3 py-2 text-ink-2">
            Set aside {money(preview.before.setAside)} → <span className="text-ink">{money(preview.after.setAside)}</span> · spendable {money(preview.before.spendable)} → <span className="text-ink">{money(preview.after.spendable)}</span>
            {preview.before.toCheck !== preview.after.toCheck && (
              <>
                {' '}
                · to check {preview.before.toCheck} → {preview.after.toCheck}
              </>
            )}
          </div>
        )}
        {previewError && <p className="text-bad-ink">{previewError}</p>}
        {save.error && <ErrorNote error={save.error} />}
      </div>
    </Dialog>
  );
}

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
  const [deciding, setDeciding] = useState<DecidePayment | null>(null);
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
  // The pot a decision would be for: the one it counts in, else the first that has started by its day.
  const decidedPot = setup.decisions[tx.id]?.pot;
  const pot = setup.pots.find((p) => p.id === decidedPot) ?? setup.pots.find((p) => p.start <= tx.date);
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
      {pot && (
        <button
          type="button"
          className="mt-1 text-[13px] text-accent hover:underline"
          onClick={() => {
            const decided = setup.decisions[tx.id];
            setDeciding({ pot: pot.id, potName: pot.name, transactionId: tx.id, accountId: tx.accountId, date: tx.date, description: tx.description, amount: tx.amount, parts: decided?.parts ?? [{ effect: 'own', amount: Math.abs(tx.amount) }], ...(decided ? { reason: decided.reason, decided: true } : {}) });
          }}
        >
          {setup.decisions[tx.id] ? 'Change your decision…' : 'Decide what it did…'}
        </button>
      )}
      <DecisionDialog payment={deciding} onClose={() => setDeciding(null)} />
    </section>
  );
}
