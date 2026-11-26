// Set aside (docs/FORMULAS.md §21): how much of your everyday accounts is set aside in pots and how
// much is yours to spend, with every payment behind the figure. Read-only for now: changes come as
// proposals you apply.

import { ChevronRight, CircleCheck, HandCoins, Pencil, RotateCcw, TriangleAlert } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { Link } from 'react-router';
import type { EarmarkLine, EarmarkPotResult, EarmarkRow, EarmarksResult } from '../../shared/api';
import { EARMARK_EFFECTS, POT_EFFECTS, type EarmarkEffect, type Earmarks } from '../../shared/schema';
import { DecisionDialog, useEarmarks, type DecidePayment } from '../components/Earmarks';
import { earmarkRuleWords, proposedBy, useProposals } from '../components/Proposals';
import { Badge, Button, Callout, Card, Dialog, EmptyState, ErrorNote, IconButton, Loading, Money, PageHeader, Stat, useToast } from '../components/ui';
import { api, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { BY_WORDS, EFFECT_WORDS } from '../lib/earmarks';
import { cn, formatDate, money, plural } from '../lib/format';

export default function EarmarksPage() {
  const { data } = useAppData();
  const q = useEarmarks();
  if (!data.earmarks.length) {
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title="Set aside" />
        <EmptyState icon={<HandCoins className="size-6" />} title="Nothing is set aside">
          Set aside is for money already in your everyday accounts that’s spoken for: tax to pay, money you hold for someone, a loan meant for rent. Goals are for saving towards something. An agent can propose setting it up; you apply it on the Import page.
        </EmptyState>
      </div>
    );
  }
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { setup, result, problems } = q.data;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Set aside" subtitle="Money in your everyday accounts that’s spoken for, and what’s yours to spend. Worked out from your payments and balances." />
      <Pending />
      {problems.length > 0 && (
        <Callout tone="warn" className="mb-5" title="The figure can’t be worked out">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      {result && setup && <Deciding result={result} setup={setup} />}
    </div>
  );
}

/** Proposals waiting that change set aside, each one click away. */
function Pending() {
  const q = useProposals();
  const mine = (q.data?.pending ?? []).filter((v) => v.proposal.changes.some((c) => c.kind === 'set_earmarks' || c.kind === 'decide_earmark_flow'));
  if (!mine.length) return null;
  return (
    <Callout tone="accent" className="mb-5" title={`${plural(mine.length, 'proposal')} waiting for you`}>
      <ul className="grid gap-1">
        {mine.map((v) => (
          <li key={v.proposal.id}>
            <Link to={`/proposals/${v.proposal.id}`} state={{ from: '/earmarks' }} className="font-medium text-accent hover:underline">
              {v.proposal.title}
            </Link>{' '}
            <span className="text-ink-3">· proposed by {proposedBy(v.proposal.provenance)}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Opens the decision dialog for a payment, from anywhere on the page. */
const DecideContext = createContext<(p: DecidePayment) => void>(() => undefined);

/** Every payment's parts in a pot, as it counts now: to start a decision from. */
function partsOf(pot: EarmarkPotResult): Map<string, { row: EarmarkRow; parts: { effect: EarmarkEffect; amount: number }[] }> {
  const out = new Map<string, { row: EarmarkRow; parts: { effect: EarmarkEffect; amount: number }[] }>();
  for (const line of pot.lines) {
    for (const row of line.rows) {
      const e = out.get(row.transactionId) ?? out.set(row.transactionId, { row, parts: [] }).get(row.transactionId)!;
      if (row.counted !== 0) e.parts.push({ effect: line.effect, amount: Math.abs(row.counted) });
    }
  }
  return out;
}

function Deciding({ result, setup }: { result: EarmarksResult; setup: Earmarks }) {
  const [payment, setPayment] = useState<DecidePayment | null>(null);
  return (
    <DecideContext.Provider value={setPayment}>
      <Figures result={result} setup={setup} />
      <DecisionDialog payment={payment} onClose={() => setPayment(null)} />
    </DecideContext.Provider>
  );
}

/** Start a decision for a payment as it counts now (or as decided). */
function useDecide(setup: Earmarks, pot: EarmarkPotResult) {
  const open = useContext(DecideContext);
  return (row: Pick<EarmarkRow, 'transactionId' | 'accountId' | 'date' | 'description' | 'amount'>, parts?: { effect: EarmarkEffect; amount: number }[]) => {
    const decided = setup.decisions[row.transactionId];
    open({
      pot: pot.id,
      potName: pot.name,
      transactionId: row.transactionId,
      accountId: row.accountId,
      date: row.date,
      description: row.description,
      amount: row.amount,
      parts: decided?.parts ?? parts ?? partsOf(pot).get(row.transactionId)?.parts ?? [{ effect: 'own', amount: Math.abs(row.amount) }],
      ...(decided ? { reason: decided.reason, decided: true } : {}),
    });
  };
}

function Figures({ result: r, setup }: { result: EarmarksResult; setup: Earmarks }) {
  const { accountName } = useAppData();
  const setAside = r.pots.reduce((s, p) => s + Math.round(p.setAside * 100), 0) / 100;
  const provisional = r.pots.reduce((s, p) => s + p.provisional, 0);
  const everyday = r.accounts.filter((a) => a.role === 'everyday');
  const held = r.accounts.filter((a) => a.role === 'set-aside');
  return (
    <div className="flex flex-col gap-5">
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Spendable" value={<Money value={r.spendable} />} />
        <Stat label={setAside >= 0 ? 'Set aside in everyday accounts' : 'You’ve covered for the pots'} value={<Money value={Math.abs(setAside)} />} sub={setAside < 0 ? <span>move {money(-setAside)} from a set-aside account to square up</span> : undefined} />
        <Stat label="In your everyday accounts" value={<Money value={r.everydayTotal + r.onItsWayTotal} />} sub={r.onItsWayTotal ? <span>including {money(r.onItsWayTotal)} on its way</span> : undefined} />
      </section>

      <Card title="How it adds up">
        <div className="grid gap-1 text-[13.5px] sm:max-w-xl">
          {everyday.map((a) => (
            <Row key={a.accountId} label={<AccountLabel name={a.name} asOf={a.asOf} stale={a.stale} />} value={a.balance} />
          ))}
          {r.onItsWay.map((w) => (
            <Row key={w.transactionId} label={<span className="text-ink-3">On its way to {accountName(w.otherAccountId)} ({formatDate(w.date)}): its statements don’t show it yet</span>} value={w.amount} />
          ))}
          <Row label={<span className="font-medium text-ink">In your everyday accounts</span>} value={r.everydayTotal + r.onItsWayTotal} strong />
          {r.pots.map((p) => (
            <Row key={p.id} label={<span>{p.setAside >= 0 ? `Less set aside for ${p.name}` : `Plus what you’ve covered for ${p.name}`}</span>} value={-p.setAside} />
          ))}
          <Row label={<span className="font-medium text-ink">Spendable</span>} value={r.spendable} strong />
        </div>
        {provisional > 0 && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            {money(provisional)} of the payments behind it {provisional === 1 ? 'is' : 'are'} still to check: counted as suggested for now (<a href="#to-check" className="text-accent hover:underline">see below</a>).
          </p>
        )}
        {r.lowest && (
          <p className="mt-1 text-[12.5px] text-ink-3">
            Lowest spendable since the start: <Money value={r.lowest.spendable} /> on {formatDate(r.lowest.date)}.{r.lowest.spendable < 0 && r.spendable >= 0 ? ' A short dip like that is fine: later money in made it good.' : ''}
          </p>
        )}
        {held.length > 0 && (
          <p className="mt-1 text-[12.5px] text-ink-3">
            Your set-aside accounts hold a further <Money value={r.heldInSetAside} />: {held.map((a) => `${a.name} ${money(a.balance)}${a.asOf ? ` (${formatDate(a.asOf)})` : ''}`).join(', ')}.
          </p>
        )}
        <p className="mt-1 text-[12.5px] text-ink-3">The app can’t know your intentions: a transfer it counts as “put back” might be savings of your own. Each payment below says why it counts as it does; change any of them with its pencil.</p>
        <Checked result={r} />
      </Card>

      <ToCheck result={r} setup={setup} />

      {r.pots.map((p) => (
        <PotCard key={p.id} pot={p} setup={setup} />
      ))}

      <HowItsWorkedOut setup={setup} result={r} />
    </div>
  );
}

function AccountLabel({ name, asOf, stale }: { name: string; asOf: string | null; stale: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {name}
      <span className={cn('text-[12px]', stale ? 'text-warn-ink' : 'text-ink-3')}>
        {stale && <TriangleAlert className="mr-0.5 inline size-3.5 align-[-2px]" aria-hidden />}
        {asOf ? `to ${formatDate(asOf)}` : 'no data'}
      </span>
    </span>
  );
}

function Row({ label, value, strong }: { label: React.ReactNode; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', strong && 'border-t border-line pt-1')}>
      <span className="min-w-0 text-ink-2">{label}</span>
      <Money value={value} className={cn('tabular shrink-0', strong ? 'font-semibold text-ink' : 'text-ink')} />
    </div>
  );
}

function ToCheck({ result: r, setup }: { result: EarmarksResult; setup: Earmarks }) {
  const { accountName } = useAppData();
  const toast = useToast();
  const confirm = useApiMutation((body: { decisions: { pot: string; transaction: string; parts: { effect: EarmarkEffect; amount: number }[] | null; reason?: string }[] }) => api('/earmarks/decisions', { body }), {
    onSuccess: () => toast({ tone: 'good', text: 'Decided' }),
  });
  const open = useContext(DecideContext);
  if (!r.toCheck.length) return null;
  const rows = new Map(r.pots.flatMap((p) => p.lines.flatMap((l) => l.rows.map((row) => [row.transactionId, { row, pot: p }] as const))));
  return (
    <Card id="to-check" title={`To check (${r.toCheck.length})`} description="The app can’t tell these from your data. Each is counted as suggested until you decide; an agent can propose a decision for you to apply.">
      <ul className="flex flex-col divide-y divide-line">
        {r.toCheck.map((c, i) => {
          const pot = r.pots.find((p) => p.id === c.pot);
          return (
            <li key={`${c.kind}-${c.date}-${i}`} className="py-3 first:pt-0 last:pb-0">
              <div className="text-[13px] text-ink-3">{formatDate(c.date)}</div>
              <p className="sensitive text-[13.5px] text-ink">{c.question}</p>
              <ul className="mt-1 grid gap-1 text-[12.5px] text-ink-2">
                {c.transactionIds.map((id) => {
                  const found = rows.get(id);
                  const parts = c.suggestion?.find((x) => x.transactionId === id)?.parts;
                  const decision = setup.decisions[id];
                  return (
                    <li key={id} className="sensitive flex flex-wrap items-center gap-x-2">
                      <span>{found ? `${found.row.description} · ${accountName(found.row.accountId)} · ${money(found.row.amount)}` : decision ? `${formatDate(decision.seen.date)} · ${accountName(decision.seen.accountId)} · ${money(decision.seen.amount)}` : id}</span>
                      {parts && <span className="text-ink-3">→ {parts.map((p) => `${EFFECT_WORDS[p.effect].toLowerCase()} ${money(p.amount)}`).join(', ')}</span>}
                      {found && pot && (
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() =>
                            open({
                              pot: pot.id,
                              potName: pot.name,
                              transactionId: id,
                              accountId: found.row.accountId,
                              date: found.row.date,
                              description: found.row.description,
                              amount: found.row.amount,
                              parts: decision?.parts ?? parts ?? partsOf(pot).get(id)?.parts ?? [],
                              ...(decision ? { reason: decision.reason, decided: true } : {}),
                            })
                          }
                        >
                          Decide…
                        </button>
                      )}
                      {!found && decision && (
                        <button type="button" className="text-accent hover:underline" onClick={() => confirm.mutate({ decisions: [{ pot: decision.pot, transaction: id, parts: null }] })}>
                          Remove this decision
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {c.suggestion && (
                <Button
                  size="sm"
                  className="mt-2"
                  icon={<CircleCheck className="size-4" />}
                  loading={confirm.isPending}
                  onClick={() => confirm.mutate({ decisions: c.suggestion!.map((x) => ({ pot: c.pot, transaction: x.transactionId, parts: x.parts, reason: 'Confirmed the suggestion' })) })}
                >
                  Confirm as suggested
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {confirm.error && <ErrorNote error={confirm.error} />}
    </Card>
  );
}

/** "I've checked this": the figures you last checked, and how far they have moved since. */
function Checked({ result: r }: { result: EarmarksResult }) {
  const toast = useToast();
  const check = useApiMutation(() => api('/earmarks/checks', { body: {} }), { onSuccess: () => toast({ tone: 'good', text: 'Noted: you checked these figures' }) });
  const last = r.pots
    .flatMap((p) => p.checks.slice(-1).map((c) => ({ ...c, pot: p })))
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const setAside = r.pots.reduce((s, p) => s + Math.round(p.setAside * 100), 0) / 100;
  const lastSetAside = last ? r.pots.reduce((s, p) => s + Math.round((p.checks.at(-1)?.setAside ?? 0) * 100), 0) / 100 : 0;
  const moved = last ? Math.round((setAside - lastSetAside) * 100) / 100 : 0;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-[12.5px]">
      <Button size="sm" icon={<CircleCheck className="size-4" />} loading={check.isPending} onClick={() => check.mutate()}>
        I’ve checked this
      </Button>
      {last ? (
        <span className={moved ? 'text-warn-ink' : 'text-ink-3'}>
          You checked it on {formatDate(last.at.slice(0, 10))}: set aside <Money value={lastSetAside} />, spendable <Money value={last.spendable} />.
          {moved !== 0 && (
            <>
              {' '}
              Set aside has moved by <Money value={moved} sign /> since: new payments, or a change to the rules or decisions.
            </>
          )}
        </span>
      ) : (
        <span className="text-ink-3">Mark the figures as checked, and the page will say if a later change moves them.</span>
      )}
      {check.error && <ErrorNote error={check.error} />}
    </div>
  );
}

function PotCard({ pot, setup }: { pot: EarmarkPotResult; setup: Earmarks }) {
  const lines = EARMARK_EFFECTS.map((e) => pot.lines.find((l) => l.effect === e)).filter((l): l is EarmarkLine => Boolean(l));
  return (
    <Card title={pot.name} description={`${pot.purpose ? `${pot.purpose} · ` : ''}from ${formatDate(pot.start)}`}>
      <div className="grid gap-1 text-[13.5px]">
        <Row label="Set aside at the start" value={pot.opening} />
        {lines.filter((l) => POT_EFFECTS.includes(l.effect)).map((l) => (
          <LineRow key={l.effect} line={l} pot={pot} setup={setup} />
        ))}
        <Row label={<span className="font-medium text-ink">{pot.setAside >= 0 ? 'Set aside now' : 'You’ve covered for it'}</span>} value={pot.setAside} strong />
      </div>
      {lines.some((l) => !POT_EFFECTS.includes(l.effect)) && (
        <div className="mt-4 grid gap-1 border-t border-line pt-3 text-[13.5px]">
          <div className="text-[12.5px] text-ink-3">Your own money, which doesn’t change what is set aside:</div>
          {lines.filter((l) => !POT_EFFECTS.includes(l.effect)).map((l) => (
            <LineRow key={l.effect} line={l} pot={pot} setup={setup} own />
          ))}
        </div>
      )}
    </Card>
  );
}

function LineRow({ line, own, pot, setup }: { line: EarmarkLine; own?: boolean; pot: EarmarkPotResult; setup: Earmarks }) {
  const { accountName } = useAppData();
  const decide = useDecide(setup, pot);
  const [open, setOpen] = useState(false);
  const shown = 25;
  const [all, setAll] = useState(false);
  const rows = all ? line.rows : line.rows.slice(0, shown);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!line.rows.length} className="flex w-full items-baseline justify-between gap-3 text-left enabled:hover:text-ink">
        <span className="inline-flex items-center gap-1 text-ink-2">
          <ChevronRight className={cn('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90', !line.rows.length && 'invisible')} aria-hidden />
          <span>
            {EFFECT_WORDS[line.effect]} <span className="text-[12px] whitespace-nowrap text-ink-3">· {plural(line.count, 'payment')}</span>
          </span>
        </span>
        <Money value={own ? line.in - line.out : line.total} className="tabular shrink-0 text-ink" />
      </button>
      {open && (
        <ul className="mt-1 mb-2 ml-5 grid gap-1 border-l border-line pl-3 text-[12.5px]">
          {rows.map((row, i) => (
            <li key={`${row.transactionId}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-2 gap-y-0.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto_auto] sm:gap-x-3">
              <span className="col-span-3 text-ink-3 sm:col-span-1">{formatDate(row.date)}</span>
              <span className="min-w-0">
                <span className="sensitive block truncate text-ink-2">{row.description}</span>
                <span className="text-ink-3">
                  {accountName(row.accountId)} · {row.by === 'rule' ? `rule “${row.ruleName ?? row.ruleId}”` : row.by === 'decision' ? `your decision${row.reason ? `: “${row.reason}”` : ''}` : BY_WORDS[row.by]}
                  {row.counted !== row.amount && <> · {money(Math.abs(row.counted))} of {money(Math.abs(row.amount))}</>}
                </span>
              </span>
              <Money value={row.counted} className="tabular text-ink" />
              <IconButton label="Change what it did" className="-my-1 size-7" onClick={() => decide(row)}>
                <Pencil className="size-3.5" />
              </IconButton>
            </li>
          ))}
          {!all && line.rows.length > shown && (
            <li>
              <button type="button" className="text-accent hover:underline" onClick={() => setAll(true)}>
                Show all {line.rows.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function HowItsWorkedOut({ setup, result }: { setup: Earmarks; result: EarmarksResult }) {
  const { accountName, cats } = useAppData();
  const open = useContext(DecideContext);
  const [restarting, setRestarting] = useState<string | null>(null);
  const decisions = Object.entries(setup.decisions).sort(([, a], [, b]) => a.seen.date.localeCompare(b.seen.date));
  return (
    <Card title="How it’s worked out" description="Changes come as proposals you apply. Every payment in an everyday account counts as your own money unless a rule or your decision says otherwise; money to or from a set-aside account is put back into, or borrowed from, the pot.">
      <div className="grid gap-4 text-[13px]">
        <div className="text-ink-2">
          <div>
            <span className="text-ink-3">Everyday accounts:</span> {setup.everyday.map(accountName).join(', ')}
          </div>
          {setup.setAside.length > 0 && (
            <div>
              <span className="text-ink-3">Set-aside accounts:</span> {setup.setAside.map(accountName).join(', ')}
            </div>
          )}
        </div>
        {setup.pots.map((pot) => (
          <div key={pot.id}>
            <div className="font-medium text-ink">
              {pot.name} <span className="font-normal text-ink-3">· from {formatDate(pot.start)} · set aside at the start {money(pot.opening)}</span>
            </div>
            {pot.rules.length > 0 ? (
              <ol className="mt-1 ml-5 list-decimal text-ink-2">
                {pot.rules.map((r) => (
                  <li key={r.id}>
                    <span className="text-ink">{r.name}</span>: {EFFECT_WORDS[r.effect].toLowerCase()} · {earmarkRuleWords(r, accountName, (id) => cats.name(id))}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-ink-3">No rules: only your decisions and transfers with set-aside accounts count.</p>
            )}
            <p className="mt-1 text-[12px] text-ink-3">The first rule that fits a payment decides.</p>
            <Button size="sm" variant="ghost" className="mt-1" icon={<RotateCcw className="size-4" />} onClick={() => setRestarting(pot.id)}>
              Start {pot.name} again from here
            </Button>
          </div>
        ))}
        <div>
          <div className="font-medium text-ink">Your decisions ({decisions.length})</div>
          {decisions.length ? (
            <ul className="mt-1 grid gap-1 text-ink-2">
              {decisions.map(([id, d]) => (
                <li key={id} className="sensitive flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    {formatDate(d.seen.date)} · {accountName(d.seen.accountId)} · {money(d.seen.amount)}: {d.parts.map((p) => `${EFFECT_WORDS[p.effect].toLowerCase()} ${money(p.amount)}`).join(', ')} — “{d.reason}”
                    {d.proposalId && (
                      <Badge tone="neutral" className="ml-1">
                        from a proposal
                      </Badge>
                    )}
                    {result.toCheck.some((c) => c.kind === 'stale-decision' && c.transactionIds.includes(id)) && (
                      <Badge tone="warn" className="ml-1">
                        to check
                      </Badge>
                    )}
                  </span>
                  <IconButton
                    label="Change this decision"
                    className="-my-1 size-7"
                    onClick={() => {
                      const pot = setup.pots.find((p) => p.id === d.pot);
                      open({ pot: d.pot, potName: pot?.name ?? d.pot, transactionId: id, accountId: d.seen.accountId, date: d.seen.date, description: result.pots.flatMap((p) => p.lines.flatMap((l) => l.rows)).find((x) => x.transactionId === id)?.description ?? '', amount: d.seen.amount, parts: d.parts, reason: d.reason, decided: true });
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">None yet.</p>
          )}
        </div>
      </div>
      <Restart pot={setup.pots.find((p) => p.id === restarting) ?? null} result={result} onClose={() => setRestarting(null)} />
    </Card>
  );
}

/** Start a pot again from the latest day every everyday account has data for, with what it held then. */
function Restart({ pot, result, onClose }: { pot: Earmarks['pots'][number] | null; result: EarmarksResult; onClose: () => void }) {
  const toast = useToast();
  const restart = useApiMutation((id: string) => api('/earmarks/restart', { body: { pot: id } }), {
    onSuccess: () => {
      toast({ tone: 'good', text: 'Started again' });
      onClose();
    },
  });
  if (!pot) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Start ${pot.name} again from here?`}
      description="For when the past is settled and you only want to count from now on."
      footer={
        <Button variant="primary" loading={restart.isPending} onClick={() => restart.mutate(pot.id)}>
          Start again
        </Button>
      }
    >
      <div className="grid gap-2 text-[13.5px] text-ink-2">
        <p>
          It will start on the day after {result.oldest ? formatDate(result.oldest) : 'the latest day'} (the latest day every everyday account has data for), with what it had set aside then as its opening. Payments before then stop counting, and your decisions for them go: your data’s history keeps them.
        </p>
        <p>The figure today stays the same.</p>
        {restart.error && <ErrorNote error={restart.error} />}
      </div>
    </Dialog>
  );
}
