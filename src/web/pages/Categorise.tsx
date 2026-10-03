// To categorise (Spending → To categorise): money with people and cash and cheques paid in, decided
// payment by payment; rules your decisions point to; what's left uncategorised, by payee; and the categories the
// app guessed, to confirm or change (docs/FORMULAS.md §10).

import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, SearchCheck, Trash2, UserRound, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { CategoriseQueue, GuessGroup, PayeeGroup, PersonGroup, PersonRow, QueueExample, RuleSuggestion } from '../../shared/api';
import { addMonths, formatDate, startOfMonth, today } from '../../shared/dates';
import type { Person, Rule } from '../../shared/schema';
import { CategorySelect } from '../components/TransactionList';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, Input, Loading, Money, PageHeader, Segmented, Select, Tabs, useToast } from '../components/ui';
import { api, qs, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, matchWords, money, plural } from '../lib/format';

type Tab = 'people' | 'rules' | 'payees' | 'guesses';
type Period = '12m' | 'all';
type Relation = NonNullable<Person['relation']>;
type UsuallyIn = NonNullable<Person['usually']['in']>;
type UsuallyOut = NonNullable<Person['usually']['out']>;

interface DecisionsResult {
  updated: number;
  person?: Person;
  rule?: Rule;
  ruleApplied?: { recategorised: number };
}

interface DecisionsBody {
  decisions: { id: string; category: string }[];
  person?: { id?: string; name: string; names: string[]; relation?: Relation | null; usually?: { in?: UsuallyIn; out?: UsuallyOut } };
  rule?: { match: Rule['match']; category: string };
}

const decide = (body: DecisionsBody) => api<DecisionsResult>('/categorise/decisions', { body: body as unknown as Record<string, unknown> });

const PAGE = 25;

const TABS: Tab[] = ['people', 'rules', 'payees', 'guesses'];

export default function Categorise() {
  // The tab is in the address (#rules, #payees, #guesses), so a link can open it.
  const [tab, setTabState] = useState<Tab>(() => TABS.find((t) => `#${t}` === window.location.hash) ?? 'people');
  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(null, '', t === 'people' ? window.location.pathname + window.location.search : `#${t}`);
  };
  const [period, setPeriod] = useState<Period>('12m');
  const from = period === '12m' ? addMonths(startOfMonth(today()), -12) : undefined;
  const q = useApi<CategoriseQueue>(['categorise', 'queue', from ?? 'all'], `/categorise/queue${qs({ from })}`);
  const people = useApi<Person[]>(['people'], '/people');
  const data = q.data;
  return (
    <div>
      <PageHeader
        title="To categorise"
        subtitle={from ? `Payments since ${formatDate(from)}; rules look at all of history` : 'All payments'}
        actions={
          <Segmented
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: '12m', label: 'Last 12 months' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <Callout tone="neutral" className="mb-4">
        Money with people, and cash and cheques paid in, is yours to decide, one payment at a time: a suggestion only fills in the choice, and nothing is categorised until you confirm it. Re-apply categorisation first (
        <Link className="text-accent underline-offset-2 hover:underline" to="/settings#rules">
          Settings → Rules → Preview re-applying to history
        </Link>
        ), so the app fills what it can by itself.
      </Callout>
      {!data ? (
        q.error ? (
          <Callout tone="bad">{q.error.message}</Callout>
        ) : (
          <Loading />
        )
      ) : (
        <div className={cn(q.isFetching && 'opacity-70')}>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'people', label: 'People and cash', count: data.counts.people },
              { value: 'rules', label: 'Rules to make', count: data.counts.rules },
              { value: 'payees', label: 'By payee', count: data.counts.payees },
              { value: 'guesses', label: 'Guesses to check', count: data.counts.guesses },
            ]}
          />
          {tab === 'people' && <PeopleTab groups={data.people} saved={people.data ?? []} />}
          {tab === 'rules' && <RulesTab rules={data.rules} />}
          {tab === 'payees' && <PayeesTab groups={data.payees} />}
          {tab === 'guesses' && <GuessesTab groups={data.guesses} />}
        </div>
      )}
    </div>
  );
}

// ─── People ──────────────────────────────────────────────────────────────────────────────────────

function PeopleTab({ groups, saved }: { groups: PersonGroup[]; saved: Person[] }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 ? (
        <Card>
          <EmptyState icon={<UserRound className="size-6" />} title="No payments with people or cash to decide">
            Payments to and from people, and cash and cheques paid in, show here until you say what each was: a gift, your share of something paid back, or your own money.
          </EmptyState>
        </Card>
      ) : (
        groups.map((g) => <PersonCard key={g.key} group={g} saved={saved} />)
      )}
      {saved.length > 0 && <SavedPeople people={saved} />}
    </div>
  );
}

/**
 * Where a quick choice puts a payment, by its direction: a suggestion of the same kind keeps its
 * category. Your own cash paid back in goes in Cash withdrawal, netting off what you took out.
 */
function quickCategory(r: PersonRow, choice: 'gift' | 'back' | 'own', cash: boolean): string {
  const into = r.amount >= 0;
  if (choice === 'gift') return into ? 'gifts-received' : 'gifts';
  if (choice === 'own') return cash && !r.cheque ? 'cash-withdrawal' : 'transfer';
  const kept = r.suggestion && (r.suggestion.treatment === 'repaid' || r.suggestion.treatment === 'shared') ? r.suggestion.category : undefined;
  return kept ?? (into ? 'repaid' : 'other-expense');
}

function PersonCard({ group, saved }: { group: PersonGroup; saved: Person[] }) {
  const { cats, accountName } = useAppData();
  const toast = useToast();
  const [choice, setChoice] = useState<Record<string, string | undefined>>({});
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [notPerson, setNotPerson] = useState(false);
  const [saveAs, setSaveAs] = useState<string>(group.person?.id ?? 'new');
  const [name, setName] = useState(group.name);
  const [relation, setRelation] = useState<Relation | ''>(group.person?.relation ?? (group.sharesYourSurname ? 'family' : ''));
  const [usuallyIn, setUsuallyIn] = useState<UsuallyIn | ''>(group.person?.usually.in ?? '');
  const [usuallyOut, setUsuallyOut] = useState<UsuallyOut | ''>(group.person?.usually.out ?? '');
  const [always, setAlways] = useState(true);
  const [single, setSingle] = useState<string | undefined>();
  // Cash and cheques paid in name no one: nobody to save, and only your own decisions.
  const cash = Boolean(group.cash);

  const chosen = (r: PersonRow) => (r.id in choice ? choice[r.id] : (r.suggestion?.category ?? r.category));
  const ticked = (r: PersonRow) => toggled[r.id] ?? Boolean(r.suggestion?.strong);
  const tickedRows = group.rows.filter(ticked);
  const missing = tickedRows.filter((r) => !chosen(r)).length;
  const shown = showAll ? group.rows : group.rows.slice(0, PAGE);
  const target = saveAs === 'new' ? undefined : saved.find((p) => p.id === saveAs);

  const confirm = useApiMutation(
    () =>
      decide({
        decisions: tickedRows.map((r) => ({ id: r.id, category: chosen(r)! })),
        ...(cash
          ? {}
          : {
              person: {
                ...(target ? { id: target.id } : {}),
                name: target?.name ?? (name.trim() || group.name),
                names: group.names.slice(0, 30),
                relation: relation || null,
                usually: { ...(usuallyIn ? { in: usuallyIn } : {}), ...(usuallyOut ? { out: usuallyOut } : {}) },
              },
            }),
      }),
    { onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.updated, 'payment')} categorised${r.person ? `; ${r.person.name} saved` : ''}` }) },
  );
  const asPayee = useApiMutation(
    () =>
      decide({
        decisions: group.rows.map((r) => ({ id: r.id, category: single! })),
        ...(always ? { rule: { match: { field: 'description', op: 'contains', value: group.names[0] ?? group.name, caseSensitive: false }, category: single! } } : {}),
      }),
    { onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.updated, 'payment')} categorised${r.ruleApplied ? `; the rule categorised ${r.ruleApplied.recategorised} more` : ''}` }) },
  );

  const setTicked = (rows: PersonRow[], v: boolean) => setToggled((t) => ({ ...t, ...Object.fromEntries(rows.map((r) => [r.id, v])) }));
  const quick = (c: 'gift' | 'back' | 'own') => setChoice((cur) => ({ ...cur, ...Object.fromEntries(tickedRows.map((r) => [r.id, quickCategory(r, c, cash)])) }));
  const all = group.rows.every(ticked);
  const none = !group.rows.some(ticked);
  // The names their payments carry, once each whatever the capitals.
  const variants = [...new Map(group.names.map((n) => [n.toLowerCase(), n])).values()];

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 pt-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
            {group.name}
            {group.person && <Badge tone="accent">Saved</Badge>}
            {group.sharesYourSurname && !group.person && <Badge tone="muted">Your surname</Badge>}
          </div>
          {variants.length > 1 && <div className="text-[12px] text-ink-3">Their payments say: {variants.join(' · ')}</div>}
          {cash && <div className="text-[12px] text-ink-3">Paid in at a machine or a counter: nothing on them says whose money it was.</div>}
        </div>
        <div className="tabular text-right text-[12.5px] text-ink-2">
          {group.in > 0 && (
            <span>
              In <Money value={group.in} />
            </span>
          )}
          {group.in > 0 && group.out < 0 && ' · '}
          {group.out < 0 && (
            <span>
              Out <Money value={-group.out} />
            </span>
          )}
          <div className="text-[12px] text-ink-3">
            {group.rows.length} to decide{group.decided ? ` · ${group.decided} decided` : ''}
          </div>
        </div>
      </div>

      {notPerson ? (
        <div className="px-5 py-4">
          <p className="mb-2 text-[12.5px] text-ink-3">Not a person: give all {plural(group.rows.length, 'payment')} one category, as for any payee.</p>
          <div className="flex flex-wrap items-center gap-2">
            <CategorySelect value={single} onChange={setSingle} placeholder="Choose a category…" className="w-full sm:w-64" />
            <Checkbox checked={always} onChange={setAlways} label={`Always: a rule for “${group.names[0] ?? group.name}”`} />
            <Button variant="primary" size="sm" disabled={!single} loading={asPayee.isPending} onClick={() => asPayee.mutate(undefined)}>
              Categorise {group.rows.length}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNotPerson(false)}>
              It is a person
            </Button>
          </div>
          {asPayee.error && <div className="mt-2 text-[12px] text-bad-ink">{asPayee.error.message}</div>}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
            <Checkbox checked={all} indeterminate={!all && !none} onChange={(v) => setTicked(group.rows, v)} ariaLabel="Tick all" />
            <span className="text-[12.5px] text-ink-3">{tickedRows.length} ticked · set them to</span>
            <Button size="sm" disabled={!tickedRows.length} onClick={() => quick('gift')}>
              Gift
            </Button>
            <Button size="sm" disabled={!tickedRows.length} onClick={() => quick('back')}>
              Paid back / my share
            </Button>
            <Button size="sm" disabled={!tickedRows.length} onClick={() => quick('own')}>
              {cash && !group.rows.some((r) => r.cheque) ? 'My own cash back' : 'My own money'}
            </Button>
          </div>
          <ul className="divide-y divide-line">
            {shown.map((r) => (
              <li key={r.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1.5 px-5 py-2.5 sm:grid-cols-[auto_1fr_auto_15rem]">
                <Checkbox checked={ticked(r)} onChange={(v) => setTicked([r], v)} ariaLabel={`Tick ${formatDate(r.date)} ${money(r.amount)}`} className="pt-0.5" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink" title={r.description}>
                    {r.reference ? `“${r.reference}”` : r.description}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {formatDate(r.date)} · {accountName(r.accountId)}
                    {r.category && r.categorisedBy !== 'user' && ` · now ${cats.name(r.category)}`}
                  </div>
                  {r.suggestion && (
                    <div className={cn('text-[12px]', r.suggestion.strong ? 'text-ink-2' : 'text-ink-3')}>
                      {r.suggestion.strong ? 'Says itself: ' : 'Maybe: '}
                      {r.suggestion.reason}
                    </div>
                  )}
                </div>
                <Money value={r.amount} className={cn('tabular pt-0.5 text-[13px] font-medium', r.amount > 0 ? 'text-good-ink' : 'text-ink')} />
                <div className="col-span-3 sm:col-span-1">
                  <CategorySelect value={chosen(r)} onChange={(v) => setChoice((c) => ({ ...c, [r.id]: v }))} placeholder="Choose…" className="w-full" direction={r.amount >= 0 ? 'in' : 'out'} />
                </div>
              </li>
            ))}
          </ul>
          {group.rows.length > PAGE && (
            <div className="border-t border-line px-5 py-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${group.rows.length}`}
              </Button>
            </div>
          )}
          {!cash && (
            <div className="border-t border-line bg-panel-2 px-5 py-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Save as">
                  <Select value={saveAs} onChange={(e) => setSaveAs(e.target.value)}>
                    <option value="new">{group.person ? 'Someone new' : 'A new person'}</option>
                    {saved.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {saveAs === 'new' && (
                  <Field label="Name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                )}
                <Field label="Who they are">
                  <RelationSelect value={relation} onChange={setRelation} />
                </Field>
                <Field label="Money from them is usually">
                  <Select value={usuallyIn} onChange={(e) => setUsuallyIn(e.target.value as UsuallyIn | '')}>
                    <option value="">Ask each time</option>
                    <option value="gift">A gift</option>
                    <option value="repaid">Paying me back</option>
                    <option value="own">My own money</option>
                  </Select>
                </Field>
                <Field label="Money to them is usually">
                  <Select value={usuallyOut} onChange={(e) => setUsuallyOut(e.target.value as UsuallyOut | '')}>
                    <option value="">Ask each time</option>
                    <option value="gift">A gift</option>
                    <option value="shared">My share of something</option>
                    <option value="own">My own money</option>
                  </Select>
                </Field>
              </div>
              <p className="mt-2 text-[12px] text-ink-3">What they usually are only fills in the choice for their next payments: you still confirm each one.</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
            <Button variant="primary" size="sm" disabled={!tickedRows.length || missing > 0} loading={confirm.isPending} onClick={() => confirm.mutate(undefined)}>
              Confirm {tickedRows.length} ticked
            </Button>
            {missing > 0 && <span className="text-[12px] text-warn-ink">{plural(missing, 'ticked payment')} without a category</span>}
            {!cash && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setNotPerson(true)}>
                Not a person
              </Button>
            )}
          </div>
          {confirm.error && <div className="px-5 pb-3 text-[12px] text-bad-ink">{confirm.error.message}</div>}
        </>
      )}
    </Card>
  );
}

function RelationSelect({ value, onChange }: { value: Relation | ''; onChange: (v: Relation | '') => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Relation | '')}>
      <option value="">Not said</option>
      <option value="family">Family</option>
      <option value="partner">Partner</option>
      <option value="friend">Friend</option>
      <option value="other">Someone else</option>
    </Select>
  );
}

const RELATION_WORDS: Record<Relation, string> = { family: 'Family', partner: 'Partner', friend: 'Friend', other: 'Someone else' };
const IN_WORDS: Record<UsuallyIn, string> = { gift: 'gifts', repaid: 'paying back', own: 'your money' };
const OUT_WORDS: Record<UsuallyOut, string> = { gift: 'gifts', shared: 'your share', own: 'your money' };

function SavedPeople({ people }: { people: Person[] }) {
  const remove = useApiMutation((id: string) => api(`/people/${id}`, { method: 'DELETE' }));
  return (
    <Card title="People you've saved" description="Their names group their payments; what they usually are only fills in the choice." padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {people.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink">
                {p.name}
                {p.relation && <span className="ml-2 text-[12px] font-normal text-ink-3">{RELATION_WORDS[p.relation]}</span>}
              </div>
              <div className="truncate text-[12px] text-ink-3">
                {[p.usually.in && `from them: ${IN_WORDS[p.usually.in]}`, p.usually.out && `to them: ${OUT_WORDS[p.usually.out]}`, p.names.length ? `also ${p.names.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Nothing usual said'}
              </div>
            </div>
            <button className="text-ink-3 hover:text-bad-ink" aria-label={`Forget ${p.name}`} title="Forget them (their payments keep your categories)" onClick={() => remove.mutate(p.id)}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─── Rules ───────────────────────────────────────────────────────────────────────────────────────

function RulesTab({ rules }: { rules: RuleSuggestion[] }) {
  if (!rules.length)
    return (
      <Card>
        <EmptyState icon={<Wand2 className="size-6" />} title="No rules to suggest">
          A rule is suggested when you put a payee in one category twice or more (or the reader did three times): for the payments it would categorise now, or, when you decided them all, for the next ones.
        </EmptyState>
      </Card>
    );
  return (
    <div className="flex flex-col gap-3">
      {rules.map((r) => (
        <RuleCard key={`${r.payee}|${r.direction}|${r.category}`} rule={r} />
      ))}
    </div>
  );
}

function RuleCard({ rule }: { rule: RuleSuggestion }) {
  const { cats } = useAppData();
  const toast = useToast();
  const [category, setCategory] = useState<string | undefined>(rule.category);
  const make = useApiMutation(
    () =>
      api<{ rule: Rule; result: { recategorised: number } | null }>('/rules', {
        body: { name: `${rule.payee} → ${cats.name(category)}`, enabled: true, priority: 100, match: rule.match, set: { category }, apply: true },
      }),
    { onSuccess: (r) => toast({ tone: 'good', text: `Rule made; ${plural(r.result?.recategorised ?? 0, 'payment')} categorised` }) },
  );
  return (
    <Card padded={false}>
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <DirectionIcon direction={rule.direction} />
            {rule.payee} → {cats.path(rule.category)}
          </div>
          <div className="tabular text-[13px] text-ink-2">
            {rule.next ? (
              'For the next ones'
            ) : (
              <>
                {plural(rule.fills.count, 'payment')} · <Money value={rule.fills.amount} />
              </>
            )}
          </div>
        </div>
        <p className="mt-1 text-[12.5px] text-ink-3">
          {rule.from.by === 'user' ? `You put ${rule.from.count} of these in ${cats.name(rule.category)}` : `The reader put ${rule.from.count} of these in ${cats.name(rule.category)}, and you never put one elsewhere`}. The rule: {matchWords(rule.match)}.{' '}
          {rule.next ? 'You decided every one so far; without a rule, the next ones come in uncategorised.' : 'It categorises these now, and the next ones as they come.'}
        </p>
        {rule.next && <div className="mt-2 text-[12px] text-ink-3">Yours so far:</div>}
        <Examples items={rule.examples} more={rule.next ? rule.from.count - rule.examples.length : rule.fills.count - rule.examples.length} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CategorySelect value={category} onChange={setCategory} allowEmpty={false} className="w-full sm:w-64" />
          <Button variant="primary" size="sm" disabled={!category} loading={make.isPending} onClick={() => make.mutate(undefined)}>
            Make this rule
          </Button>
        </div>
        {make.error && <div className="mt-2 text-[12px] text-bad-ink">{make.error.message}</div>}
      </div>
    </Card>
  );
}

function DirectionIcon({ direction }: { direction: 'in' | 'out' | undefined }) {
  if (direction === 'in') return <ArrowDownLeft className="size-4 text-good-ink" aria-label="Money in" />;
  if (direction === 'out') return <ArrowUpRight className="size-4 text-ink-3" aria-label="Money out" />;
  return null;
}

function Examples({ items, more }: { items: QueueExample[]; more: number }) {
  const { accountName } = useAppData();
  return (
    <ul className="mt-2 flex flex-col gap-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12.5px]">
      {items.map((e) => (
        <li key={e.id} className="flex items-baseline gap-3">
          <span className="w-20 shrink-0 text-ink-3">{formatDate(e.date)}</span>
          <span className="min-w-0 flex-1 truncate text-ink-2" title={e.description}>
            {e.description} <span className="text-ink-3">· {accountName(e.accountId)}</span>
          </span>
          <Money value={e.amount} className="tabular shrink-0" />
        </li>
      ))}
      {more > 0 && <li className="text-ink-3">and {more} more</li>}
    </ul>
  );
}

// ─── What's left, by payee ───────────────────────────────────────────────────────────────────────

function PayeesTab({ groups }: { groups: PayeeGroup[] }) {
  const [limit, setLimit] = useState(50);
  if (!groups.length)
    return (
      <Card>
        <EmptyState title="Nothing uncategorised">Every payment in this period has a category.</EmptyState>
      </Card>
    );
  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {groups.slice(0, limit).map((g) => (
          <PayeeRow key={`${g.payee}|${g.direction}`} group={g} />
        ))}
      </ul>
      {groups.length > limit && (
        <div className="border-t border-line px-5 py-2">
          <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 50)}>
            Show more ({groups.length - limit} left)
          </Button>
        </div>
      )}
    </Card>
  );
}

function PayeeRow({ group }: { group: PayeeGroup }) {
  const { accountName } = useAppData();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string | undefined>();
  const [always, setAlways] = useState(group.count > 1);
  const save = useApiMutation(
    () =>
      decide({
        decisions: group.ids.map((id) => ({ id, category: category! })),
        ...(always ? { rule: { match: group.match, category: category! } } : {}),
      }),
    { onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.updated, 'payment')} categorised${r.ruleApplied?.recategorised ? `; the rule categorised ${r.ruleApplied.recategorised} more` : ''}` }) },
  );
  const span = group.first === group.last ? formatDate(group.first) : `${formatDate(group.first)} – ${formatDate(group.last)}`;
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <button type="button" className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="size-4 shrink-0 text-ink-3" /> : <ChevronRight className="size-4 shrink-0 text-ink-3" />}
          <DirectionIcon direction={group.direction} />
          <span className="truncate text-[13.5px] font-medium text-ink">{group.payee}</span>
        </button>
        <Money value={group.amount} className={cn('tabular text-[13px] font-medium', group.amount > 0 ? 'text-good-ink' : 'text-ink')} />
      </div>
      <div className="pl-[1.375rem] text-[12px] text-ink-3">
        {plural(group.count, 'payment')} · {span} · {group.accountIds.map(accountName).join(', ')}
      </div>
      {open && <Examples items={group.examples} more={group.count - group.examples.length} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-[1.375rem]">
        <CategorySelect value={category} onChange={setCategory} placeholder="Choose a category…" className="w-full sm:w-64" direction={group.direction} />
        <Checkbox checked={always} onChange={setAlways} label={`Always (a rule: ${matchWords(group.match)})`} />
        <Button variant="primary" size="sm" disabled={!category} loading={save.isPending} onClick={() => save.mutate(undefined)}>
          Categorise {group.count}
        </Button>
      </div>
      {save.error && <div className="mt-2 pl-[1.375rem] text-[12px] text-bad-ink">{save.error.message}</div>}
    </li>
  );
}

// ─── Guesses to check ────────────────────────────────────────────────────────────────────────────

function GuessesTab({ groups }: { groups: GuessGroup[] }) {
  const [limit, setLimit] = useState(50);
  if (!groups.length)
    return (
      <Card>
        <EmptyState icon={<SearchCheck className="size-6" />} title="No guesses to check">
          Categories the app takes from the bank’s own category or the reader’s suggestion show here until you confirm or change them.
        </EmptyState>
      </Card>
    );
  return (
    <div className="flex flex-col gap-3">
      <Callout tone="neutral">
        The app filled these in from a guess: the bank’s own category, or the reader’s suggestion when it read the statement. Most are right, but some aren’t: a bank can call a card top-up “training”. Confirming makes a category yours, and Always makes a rule so the next ones are yours too. Your
        rules, linked transfers, schedules and the names the app knows aren’t listed.
      </Callout>
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {groups.slice(0, limit).map((g) => (
            <GuessRow key={`${g.payee}|${g.direction}|${g.category}`} group={g} />
          ))}
        </ul>
        {groups.length > limit && (
          <div className="border-t border-line px-5 py-2">
            <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 50)}>
              Show more ({groups.length - limit} left)
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Where a guess came from, in words. */
function guessWords(g: GuessGroup): string {
  const bank = g.bankSays.length ? `the bank’s category (${g.bankSays.map((b) => `“${b}”`).join(', ')})` : 'the bank’s category';
  if (g.by.bank && g.by.ai) return `Guessed from ${bank} for ${g.by.bank} and the reader’s suggestion for ${g.by.ai}`;
  return g.by.bank ? `Guessed from ${bank}` : 'Guessed by the reader of the statement';
}

function GuessRow({ group }: { group: GuessGroup }) {
  const { cats, accountName } = useAppData();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string | undefined>(group.category);
  const [always, setAlways] = useState(group.count > 1);
  const same = category === group.category;
  const save = useApiMutation(
    () =>
      decide({
        decisions: group.ids.map((id) => ({ id, category: category! })),
        ...(always ? { rule: { match: group.match, category: category! } } : {}),
      }),
    { onSuccess: (r) => toast({ tone: 'good', text: `${plural(r.updated, 'payment')} ${same ? 'confirmed' : 'categorised'}${r.ruleApplied?.recategorised ? `; the rule categorised ${r.ruleApplied.recategorised} more` : ''}` }) },
  );
  const span = group.first === group.last ? formatDate(group.first) : `${formatDate(group.first)} – ${formatDate(group.last)}`;
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <button type="button" className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="size-4 shrink-0 text-ink-3" /> : <ChevronRight className="size-4 shrink-0 text-ink-3" />}
          <DirectionIcon direction={group.direction} />
          <span className="truncate text-[13.5px] font-medium text-ink">{group.payee}</span>
          {/* On a phone the category shows in the choice below, leaving the payee room. */}
          <span className="hidden shrink-0 text-[13px] text-ink-3 sm:inline">→ {cats.path(group.category)}</span>
        </button>
        <Money value={group.amount} className={cn('tabular text-[13px] font-medium', group.amount > 0 ? 'text-good-ink' : 'text-ink')} />
      </div>
      <div className="pl-[1.375rem] text-[12px] text-ink-3">
        {plural(group.count, 'payment')} · {span} · {group.accountIds.map(accountName).join(', ')}
      </div>
      <div className="pl-[1.375rem] text-[12px] text-ink-3">{guessWords(group)}</div>
      {open && <Examples items={group.examples} more={group.count - group.examples.length} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-[1.375rem]">
        <CategorySelect value={category} onChange={setCategory} allowEmpty={false} className="w-full sm:w-64" direction={group.direction} />
        <Checkbox checked={always} onChange={setAlways} label={`Always (a rule: ${matchWords(group.match)})`} />
        <Button variant="primary" size="sm" disabled={!category} loading={save.isPending} onClick={() => save.mutate(undefined)}>
          {same ? `Right: confirm ${group.count}` : `Categorise ${group.count}`}
        </Button>
      </div>
      {save.error && <div className="mt-2 pl-[1.375rem] text-[12px] text-bad-ink">{save.error.message}</div>}
    </li>
  );
}
