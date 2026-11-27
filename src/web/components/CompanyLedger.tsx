// A company's Books tab (docs/FORMULAS.md §22, "The general ledger"): the rows to code and the coding
// editor, the links between its rows and yours, its journals and book rules, what the ledger asks of
// you, and its postings for a date range. Everything from the company's own routes
// (routes/company-books.ts); nothing here is a figure of yours.

import { Link2, Plus, Trash2, Unlink, Wand2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { BooksRowView, CompanyCodingResponse, CompanyLedgerResponse, LedgerCheck, LinkSuggestion } from '../../shared/api';
import { addDays, formatDate, today } from '../../shared/dates';
import { FIXED_ASSET_CLASS_META, LEDGER_CODES, ledgerCode, ledgerName, reverseChargeVat, takesVat, vatInGross, VAT_TREATMENT_LABELS, type AssetRegisterClass, type LedgerKind } from '../../shared/ledger';
import { fromMinor, toMinor } from '../../shared/money';
import { VAT_TREATMENTS, type BooksCoding, type BooksLine, type Journal, type JournalInput, type JournalLine, type Rule, type VatTreatment } from '../../shared/schema';
import { api, useApi, useApiMutation } from '../lib/api';
import { cn, matchWords } from '../lib/format';
import { Badge, Button, Callout, Card, Checkbox, Dialog, EmptyState, ErrorNote, Field, Input, Loading, Money, NumberInput, Select, StatusBadge, tableClasses, useToast } from './ui';

const KIND_LABELS: Record<LedgerKind, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Capital and reserves', income: 'Income', expense: 'Expenses' };
const KINDS: LedgerKind[] = ['income', 'expense', 'asset', 'liability', 'equity'];

/** A ledger select, grouped by kind: the codes a payment can be coded to, or (journals) every code but the books' own clearing codes, with the company's own accounts. */
function LedgerSelect({ value, onChange, journal, accounts, label }: { value: string; onChange: (v: string) => void; journal?: boolean; accounts?: CompanyCodingResponse['accounts']; label: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Choose a ledger…</option>
      {KINDS.map((k) => (
        <optgroup key={k} label={KIND_LABELS[k]}>
          {LEDGER_CODES.filter((c) => c.kind === k && !c.account && (journal ? !c.clearing : c.codable)).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
          {journal &&
            accounts
              ?.filter((a) => ledgerCode(a.ledger)?.kind === k)
              .map((a) => (
                <option key={a.ledger} value={a.ledger}>
                  {ledgerName(a.ledger, () => a.name)}
                </option>
              ))}
        </optgroup>
      ))}
    </Select>
  );
}

const minorText = (minor: number) => <Money value={fromMinor(minor)} className="tabular" />;
const formatMoneyPlain = (n: number) => `${n < 0 ? '−' : ''}£${Math.abs(n).toFixed(2)}`;

// ─── Coding a row ────────────────────────────────────────────────────────────────────────────────

interface LineDraft {
  ledger: string;
  amount: number | undefined;
  treatment: VatTreatment | '';
  vat: number | undefined;
  coversFrom: string;
  coversTo: string;
  months: number | undefined;
  reg111: boolean;
  connected: boolean;
  disposedOn: string;
  residual: number | undefined;
  /** On a credit to a cost code: the asset whose cost it reduces. */
  reduces: string;
  invoicedOn: string;
}
const lineDraft = (l: Partial<BooksLine> = {}): LineDraft => ({
  ledger: l.ledger ?? '',
  amount: l.amount,
  treatment: l.vat?.treatment ?? '',
  vat: l.vat?.amount,
  coversFrom: l.covers?.from ?? '',
  coversTo: l.covers?.to ?? '',
  months: l.asset?.months,
  reg111: l.vat?.claim === 'reg111',
  connected: l.asset?.connected === true,
  disposedOn: l.asset?.disposedOn ?? '',
  residual: l.asset?.residual,
  reduces: l.reduces ?? '',
  invoicedOn: l.invoicedOn ?? '',
});

/**
 * The fixed asset fields a line takes (FORMULAS.md §22, "The register"): on a cost code, a debit (`debit`)
 * is an asset on the register, with its life, residual value and the day it left (`connected` only on a
 * tangible one); a credit reduces an asset, when it says which. Nothing else carries them.
 */
function assetFieldsOf(d: Pick<LineDraft, 'ledger' | 'months' | 'connected' | 'disposedOn' | 'residual' | 'reduces'>, debit: boolean): Pick<BooksLine, 'asset' | 'reduces'> {
  const asset = ledgerCode(d.ledger)?.asset;
  if (asset?.part !== 'cost') return {};
  if (!debit) return d.reduces ? { reduces: d.reduces } : {};
  return { asset: { class: asset.class, ...(d.months ? { months: d.months } : {}), ...(d.connected && asset.class !== 'intangible' ? { connected: true } : {}), ...(d.disposedOn ? { disposedOn: d.disposedOn } : {}), ...(d.residual ? { residual: d.residual } : {}) } };
}

/** A coding's line from the form: on a row, money going out (a negative amount) is a debit in the company's books. */
const lineOf = (d: LineDraft): BooksLine => {
  const covers = d.coversFrom && d.coversTo ? { covers: { from: d.coversFrom, to: d.coversTo } } : {};
  return {
    ledger: d.ledger,
    amount: d.amount ?? 0,
    ...(d.treatment ? { vat: { amount: d.vat ?? 0, treatment: d.treatment, ...(d.reg111 ? { claim: 'reg111' as const } : {}) } } : {}),
    ...covers,
    ...(covers.covers && d.invoicedOn ? { invoicedOn: d.invoicedOn } : {}),
    ...assetFieldsOf(d, (d.amount ?? 0) < 0),
  };
};

/** One line of a coding: its ledger, VAT (with the helper that takes it out of a VAT-inclusive amount), the period it covers and an asset's life. */
function LineFields({ d, set, row, vatRegistered, vatFrom, showAmount, assets }: { d: LineDraft; set: (p: Partial<LineDraft>) => void; row: BooksRowView; vatRegistered: boolean; vatFrom: string | undefined; showAmount: boolean; assets: CompanyCodingResponse['assets'] }) {
  const entry = ledgerCode(d.ledger);
  const gross = d.amount ?? row.amount;
  const debit = gross < 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Ledger" className="sm:col-span-2" hint={entry?.hint}>
        <LedgerSelect value={d.ledger} onChange={(ledger) => set({ ledger })} label="Ledger" />
      </Field>
      {showAmount && (
        <Field label="Amount" hint="Signed like the payment, VAT included.">
          <NumberInput value={d.amount} onValue={(amount) => set({ amount })} className="sensitive tabular" signed />
        </Field>
      )}
      <Field label="VAT" hint={vatRegistered ? undefined : 'The company is not registered for VAT on this day.'}>
        <Select value={d.treatment} onChange={(e) => set({ treatment: e.target.value as VatTreatment | '', ...(['zero', 'exempt', 'outside'].includes(e.target.value) ? { vat: 0 } : {}) })} aria-label="VAT treatment">
          <option value="">No VAT</option>
          {VAT_TREATMENTS.map((t) => (
            <option key={t} value={t}>
              {VAT_TREATMENT_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      {(d.treatment === 'standard' || d.treatment === 'reduced' || d.treatment === 'reverse-charge') && (
        <Field label={d.treatment === 'reverse-charge' ? 'Notional VAT (on the amount)' : 'VAT in the amount'}>
          <div className="flex items-center gap-1.5">
            <NumberInput value={d.vat} onValue={(vat) => set({ vat })} className="sensitive tabular" signed />
            {d.treatment !== 'reverse-charge' ? (
              <>
                <Button size="sm" variant="ghost" title="The VAT in a VAT-inclusive amount at 20%" onClick={() => set({ treatment: 'standard', vat: vatInGross(gross, row.date, 'standard') })}>
                  20%
                </Button>
                <Button size="sm" variant="ghost" title="The VAT in a VAT-inclusive amount at 5%" onClick={() => set({ treatment: 'reduced', vat: vatInGross(gross, row.date, 'reduced') })}>
                  5%
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" title="The standard rate on the amount, posted as both output and input VAT" onClick={() => set({ vat: reverseChargeVat(gross, row.date) })}>
                Standard rate
              </Button>
            )}
          </div>
        </Field>
      )}
      {!vatRegistered && vatFrom && row.date < vatFrom && (d.treatment === 'standard' || d.treatment === 'reduced') && (
        <Checkbox className="sm:col-span-2" checked={d.reg111} onChange={(reg111) => set({ reg111 })} label="Claim it in the first VAT return (bought before registration: goods within 4 years, still held then; services within 6 months; VAT Regulations 1995 reg 111)" />
      )}
      <Field label="Covers (from)" hint="A cost or income for a period: a year’s subscription.">
        <Input type="date" value={d.coversFrom} onChange={(e) => set({ coversFrom: e.target.value })} />
      </Field>
      <Field label="Covers (to)">
        <Input type="date" value={d.coversTo} onChange={(e) => set({ coversTo: e.target.value })} />
      </Field>
      {d.coversFrom && d.coversTo && (
        <Field label="Invoiced on" hint="The day the bill or invoice for it was issued, if it was: unpaid at a period end, it is then a trade creditor or debtor rather than an accrual.">
          <Input type="date" value={d.invoicedOn} onChange={(e) => set({ invoicedOn: e.target.value })} />
        </Field>
      )}
      {entry?.asset?.part === 'cost' && debit && <AssetFields d={d} set={set} assetClass={entry.asset.class} />}
      {entry?.asset?.part === 'cost' && debit && entry.asset.class !== 'intangible' && <Checkbox className="sm:col-span-2" checked={d.connected} onChange={(connected) => set({ connected })} label="Bought from a connected person (a director, or a company they control): no annual investment allowance, and its cost capped (CAA 2001 ss214–218)" />}
      {entry?.asset?.part === 'cost' && !debit && <ReducesField value={d.reduces} onChange={(reduces) => set({ reduces })} assets={assets.filter((a) => a.ledger === d.ledger)} />}
    </div>
  );
}

/** Money back on a fixed asset's cost (a supplier's part refund, a cost moved off it): the asset whose cost it reduces. */
function ReducesField({ value, onChange, assets }: { value: string; onChange: (v: string) => void; assets: CompanyCodingResponse['assets'] }) {
  return (
    <Field label="Reduces the cost of" className="sm:col-span-2" hint="A credit to a fixed asset’s cost reduces one asset on the register: its net book value is then written down over what is left of its life. Without one, the books ask.">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="The asset it reduces">
        <option value="">Choose an asset…</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.memo} · {formatDate(a.acquired)} · {formatMoneyPlain(fromMinor(a.cost))}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A fixed asset's life (empty: the company's policy for its class) and the day it left the company. */
function AssetFields({ d, set, assetClass }: { d: Pick<LineDraft, 'months' | 'disposedOn' | 'residual'>; set: (p: Partial<Pick<LineDraft, 'months' | 'disposedOn' | 'residual'>>) => void; assetClass: AssetRegisterClass }) {
  const meta = FIXED_ASSET_CLASS_META[assetClass];
  const tax = meta.capitalAllowances === 'not-supported' ? ' Capital allowances on cars are not worked out here.' : meta.capitalAllowances === 'intangibles' ? ' For tax, the intangibles regime (CTA 2009 Part 8).' : '';
  return (
    <>
      <Field label={`${meta.name}: life in months`} hint={`Its cost is written down over it, straight line, the month it was bought in full. Empty: the company’s policy for the class (Settings).${tax}`}>
        <NumberInput value={d.months} onValue={(months) => set({ months: months === undefined ? undefined : Math.round(months) })} className="tabular" />
      </Field>
      <Field label="Residual value" hint="What it is expected to fetch at the end of its life: only its cost less this is written down. Empty: nothing.">
        <NumberInput value={d.residual} onValue={(residual) => set({ residual })} className="sensitive tabular" />
      </Field>
      <Field label="Left the company on" hint="Sold, scrapped or given away: depreciation stops (the month it left is counted as the company’s policy says), and its cost and depreciation leave the books. Code what it fetched to profit or loss on disposal.">
        <Input type="date" value={d.disposedOn} onChange={(e) => set({ disposedOn: e.target.value })} />
      </Field>
    </>
  );
}

/** The coding editor: one ledger, or a split across lines that add up to the row. */
function CodingDialog({ companyId, row, vat, assets, onClose }: { companyId: string; row: BooksRowView; vat: CompanyCodingResponse['vat']; assets: CompanyCodingResponse['assets']; onClose: () => void }) {
  const toast = useToast();
  const b = row.books;
  const [lines, setLines] = useState<LineDraft[]>(
    b?.lines?.length
      ? b.lines.map(lineDraft)
      : [lineDraft(b && !b.uncoded ? { ledger: b.ledger ?? '', amount: row.amount, ...(b.vat ? { vat: b.vat } : {}), ...(b.covers ? { covers: b.covers } : {}), ...(b.asset ? { asset: b.asset } : {}), ...(b.reduces ? { reduces: b.reduces } : {}), ...(b.invoicedOn ? { invoicedOn: b.invoicedOn } : {}) } : { amount: row.amount })],
  );
  const [invoiced, setInvoiced] = useState(b?.invoiceToCompany === true);
  const split = lines.length > 1;
  const vatRegistered = Boolean(vat && row.date >= vat.registeredFrom && (!vat.deregisteredOn || row.date <= vat.deregisteredOn));
  const books = (): Omit<BooksCoding, 'setBy' | 'ruleId' | 'uncoded'> => {
    const invoice = row.side === 'paid-for' ? { invoiceToCompany: invoiced } : {};
    if (split) return { lines: lines.map(lineOf), ...invoice };
    const { amount: _a, ...one } = lineOf({ ...lines[0]!, amount: row.amount });
    return { ...one, ...invoice };
  };
  const left = toMinor(row.amount) - lines.reduce((s, l) => s + toMinor(l.amount ?? 0), 0);
  const save = useApiMutation(({ body, reset }: { body: Omit<BooksCoding, 'setBy' | 'ruleId' | 'uncoded'> | null; reset?: boolean }) => api(`/companies/${companyId}/rows/${row.id}/books`, { method: 'PUT', body: { books: body, ...(reset ? { reset } : {}) } }), {
    onSuccess: () => (toast({ tone: 'good', text: 'Saved' }), onClose()),
  });
  const claimsVat = lines.some((l) => l.treatment && l.treatment !== 'reverse-charge' && toMinor(l.vat ?? 0) !== 0);
  const set = (i: number) => (p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Code it in the company’s books"
      description={
        <>
          {formatDate(row.date)} · {row.payee ?? row.description} · <span className="sensitive">{formatMoneyPlain(row.amount)}</span> · {row.side === 'paid-for' ? 'paid by you for the company' : row.accountName}
        </>
      }
      footer={
        <>
          {b && (
            <Button variant="ghost" loading={save.isPending} title="No coding at all: the book rules code it, if one matches" onClick={() => save.mutate({ body: null, reset: true })}>
              Let the rules code it
            </Button>
          )}
          {!b?.uncoded && (
            <Button variant="ghost" loading={save.isPending} title="It stays uncoded (posted to suspense), and the book rules leave it" onClick={() => save.mutate({ body: null })}>
              Leave it uncoded
            </Button>
          )}
          <Button variant="primary" loading={save.isPending} disabled={lines.some((l) => !l.ledger) || (split && (left !== 0 || lines.some((l) => !toMinor(l.amount ?? 0))))} onClick={() => save.mutate({ body: books() })}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {lines.map((l, i) => (
          <div key={i} className={cn(split && 'rounded-lg border border-line p-3')}>
            {split && (
              <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-ink-3">
                Line {i + 1}
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            )}
            <LineFields d={{ ...l, ...(split ? {} : { amount: row.amount }) }} set={set(i)} row={row} vatRegistered={vatRegistered} vatFrom={vat?.registeredFrom} showAmount={split} assets={assets} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-3">
          <Button
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              setLines((ls) => {
                // Split in two, half each (the odd penny on the first); a further line takes what is left.
                if (ls.length > 1) return [...ls, lineDraft({ amount: fromMinor(left) })];
                const whole = toMinor(row.amount);
                const second = Math.trunc(whole / 2);
                return [{ ...ls[0]!, amount: fromMinor(whole - second), vat: undefined, treatment: '' }, lineDraft({ amount: fromMinor(second) })];
              })
            }
          >
            Split it
          </Button>
          {split && <span className={cn(left || lines.some((l) => !toMinor(l.amount ?? 0)) ? 'text-warn-ink' : 'text-good-ink')}>{left ? <>Left to code: {minorText(left)}</> : lines.some((l) => !toMinor(l.amount ?? 0)) ? 'A line of nothing: give it an amount or remove it.' : 'The lines add up to the payment.'}</span>}
        </div>
        {row.side === 'paid-for' && (
          <div className="flex flex-col gap-1">
            <Checkbox checked={invoiced} onChange={setInvoiced} label="The supply was made to the company, and its VAT invoice is addressed to it" />
            {claimsVat && !invoiced && <p className="text-[12.5px] text-warn-ink">Without an invoice addressed to the company it cannot reclaim the VAT you paid (VATA 1994 s24(1); VAT Regulations 1995 reg 29(2)): the books ask about it until you say so.</p>}
          </div>
        )}
        {save.error && <ErrorNote error={save.error} />}
      </div>
    </Dialog>
  );
}

/** A coding in words: its ledger (or lines), VAT and what it covers. */
function CodingWords({ books }: { books: BooksCoding }) {
  const lines = books.lines?.length ? books.lines : [{ ledger: books.ledger ?? '', amount: 0, ...(books.vat ? { vat: books.vat } : {}) }];
  return (
    <span className="text-ink-2">
      {lines.map((l, i) => (
        <span key={i}>
          {i > 0 && ' + '}
          {ledgerName(l.ledger)}
          {books.lines?.length ? (
            <>
              {' '}
              <span className="sensitive">{formatMoneyPlain(l.amount)}</span>
            </>
          ) : null}
          {l.vat && l.vat.treatment !== 'outside' ? <span className="text-ink-3"> · {VAT_TREATMENT_LABELS[l.vat.treatment].toLowerCase()}</span> : null}
        </span>
      ))}
      {books.covers && <span className="text-ink-3"> · covers {formatDate(books.covers.from)} – {formatDate(books.covers.to)}</span>}
    </span>
  );
}

const SET_BY: Record<BooksCoding['setBy'], string> = { user: 'You', rule: 'A rule', agent: 'A proposal' };

/** The rows to code: uncoded first, then the newest. */
function RowsCard({ view, companyId }: { view: CompanyCodingResponse; companyId: string }) {
  const [editing, setEditing] = useState<BooksRowView | null>(null);
  const [all, setAll] = useState(false);
  const needs = view.rows.filter((r) => (!r.books && !r.linked) || r.problem);
  const shown = all ? view.rows : view.rows.slice(0, Math.max(needs.length, 12));
  return (
    <Card title="Rows to code" description="What each payment is to the company: the company’s own rows, and the ones you paid for it. Those not coded yet come first; a transfer between its own accounts needs no coding." padded={false}>
      {view.rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No rows in these dates">Its accounts’ rows, and your rows marked as paid for it, are listed here.</EmptyState>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th className={tableClasses.th}>Date</th>
                <th className={tableClasses.th}>Payment</th>
                <th className={cn(tableClasses.th, 'hidden md:table-cell')}>Coded as</th>
                <th className={cn(tableClasses.th, tableClasses.num)}>Amount</th>
                <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>
                  <span className="sr-only">Code</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{formatDate(r.date)}</td>
                  <td className={tableClasses.td}>
                    <div className="sensitive text-ink">{r.payee ?? r.description}</div>
                    <div className="text-[12px] text-ink-3">{r.side === 'paid-for' ? `Paid by you · ${r.accountName}` : r.accountName}</div>
                    <div className="mt-1 text-[12px] md:hidden">
                      <CodedAs r={r} />
                    </div>
                    {/* On a phone its button sits under it. */}
                    {!r.linked && (
                      <div className="mt-1.5 sm:hidden">
                        <Button size="sm" onClick={() => setEditing(r)}>
                          {r.books ? 'Change' : 'Code'}
                        </Button>
                      </div>
                    )}
                  </td>
                  <td className={cn(tableClasses.td, 'hidden md:table-cell')}>
                    <CodedAs r={r} />
                  </td>
                  <td className={cn(tableClasses.td, tableClasses.num)}>
                    <Money value={r.amount} className="sensitive" />
                  </td>
                  <td className={cn(tableClasses.td, 'hidden text-right sm:table-cell')}>
                    {!r.linked && (
                      <Button size="sm" onClick={() => setEditing(r)}>
                        {r.books ? 'Change' : 'Code'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.rows.length > shown.length && (
            <div className="px-3 py-2">
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                Show all {view.rows.length}
              </Button>
            </div>
          )}
        </div>
      )}
      {editing && <CodingDialog companyId={companyId} row={editing} vat={view.vat} assets={view.assets} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function CodedAs({ r }: { r: BooksRowView }) {
  if (r.linked) return <Badge tone="accent">Director’s loan: linked to yours</Badge>;
  if (r.problem)
    return (
      <span className="text-warn-ink" title={r.problem}>
        Does not fit: {r.problem}
      </span>
    );
  if (!r.books) return <StatusBadge status="warn">Not coded</StatusBadge>;
  if (r.books.uncoded) return <StatusBadge status="warn">{r.books.setBy === 'agent' ? 'Left uncoded by a proposal' : 'Left uncoded by you'}</StatusBadge>;
  return (
    <span>
      <CodingWords books={r.books} /> <span className="text-[11.5px] text-ink-3">({SET_BY[r.books.setBy]})</span>
    </span>
  );
}

// ─── Links ───────────────────────────────────────────────────────────────────────────────────────

/** The links between the company's rows and your loans, and the company rows that could be the other side of a loan of yours. */
function LinksCard({ view, companyId }: { view: CompanyCodingResponse; companyId: string }) {
  const toast = useToast();
  const link = useApiMutation(({ row, rows }: { row: string; rows: string[] | null }) => api(`/companies/${companyId}/rows/${row}/link`, { method: 'PUT', body: { rows } }), { onError: (e) => toast({ tone: 'bad', text: e.message }) });
  const auto = useApiMutation(() => api<{ changed: number }>(`/companies/${companyId}/links/auto`, { method: 'POST' }), { onSuccess: (r) => toast({ tone: 'good', text: r.changed ? `${r.changed} linked` : 'Nothing new to link' }) });
  const open = view.suggestions;
  return (
    <Card
      title="Money between you and the company"
      description="A loan of yours and the company’s row for it are the same money: linked, it posts once, through the company’s row, to your director’s loan. A fee taken on the way (up to 3% of yours, at least £1, at most £25) is the company’s bank charge."
      actions={
        open.some((s) => s.candidates.some((c) => c.exact)) ? (
          <Button size="sm" icon={<Wand2 className="size-3.5" />} loading={auto.isPending} onClick={() => auto.mutate(undefined)}>
            Link exact matches
          </Button>
        ) : undefined
      }
    >
      {view.links.length === 0 && open.length === 0 ? (
        <p className="text-[13px] text-ink-3">No loans of yours with the company in these records.</p>
      ) : (
        <div className="flex flex-col gap-4 text-[13px]">
          {view.links.map((l) => (
            <div key={l.companyRows.map((r) => r.id).join()} className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-3 last:border-0">
              <div className="min-w-0 flex-1">
                {l.personalRows.map((r) => (
                  <div key={r.id}>
                    <span className="text-ink-3">Yours:</span> {formatDate(r.date)} · <span className="sensitive">{r.description}</span> · <Money value={r.amount} className="sensitive" />
                  </div>
                ))}
                {l.companyRows.map((r) => (
                  <div key={r.id}>
                    <span className="text-ink-3">{r.accountName}:</span> {formatDate(r.date)} · <span className="sensitive">{r.description}</span> · <Money value={r.amount} className="sensitive" />
                  </div>
                ))}
                <div className="mt-1 flex flex-wrap gap-1.5 text-[12px] text-ink-3">
                  <Badge tone="muted">{l.setBy === 'auto' ? 'Linked by the app' : l.setBy === 'agent' ? 'Linked by a proposal' : 'Linked by you'}</Badge>
                  {l.fee !== 0 && <span>Fee taken on the way: {minorText(l.fee)}</span>}
                  {l.problem && <span className="text-warn-ink">Does not fit: {l.problem}</span>}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={<Unlink className="size-3.5" />} loading={link.isPending} onClick={() => l.companyRows.forEach((r) => link.mutate({ row: r.id, rows: [] }))}>
                Unlink
              </Button>
            </div>
          ))}
          {open.map((s) => (
            <Suggestion key={s.personal.id} s={s} onLink={(row) => link.mutate({ row, rows: [s.personal.id] })} busy={link.isPending} />
          ))}
        </div>
      )}
    </Card>
  );
}

function Suggestion({ s, onLink, busy }: { s: LinkSuggestion; onLink: (companyRow: string) => void; busy: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div>
        <span className="text-ink-3">Yours, not linked:</span> {formatDate(s.personal.date)} · <span className="sensitive">{s.personal.description}</span> · <Money value={s.personal.amount} className="sensitive" />
      </div>
      {s.candidates.length === 0 ? (
        <div className="mt-1 text-[12px] text-ink-3">No company row looks like its other side: until one is linked, it posts against the company’s bank not imported.</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {s.candidates.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                {c.accountName}: {formatDate(c.date)} · <span className="sensitive">{c.description}</span> · <Money value={c.amount} className="sensitive" />
                <span className="text-[12px] text-ink-3">
                  {' '}
                  · {c.days} day{c.days === 1 ? '' : 's'} apart{c.fee ? <>, fee {minorText(c.fee)}</> : ''}
                </span>
              </span>
              <Button size="sm" icon={<Link2 className="size-3.5" />} loading={busy} onClick={() => onLink(c.id)}>
                Link
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Journals ────────────────────────────────────────────────────────────────────────────────────

/** A journal line as the form holds it: its ledger and amount, and for a fixed asset's cost, its life and the day it left. */
interface JournalLineDraft {
  ledger: string;
  amount: number | undefined;
  months: number | undefined;
  disposedOn: string;
  residual: number | undefined;
  reduces: string;
  /** What the form does not show, kept as it was on an edit while its ledger takes it: VAT, covers and the day invoiced, a connected seller. */
  rest: Pick<JournalLine, 'vat' | 'covers' | 'invoicedOn'> & { connected?: boolean };
}
const journalLineDraft = (l?: JournalLine): JournalLineDraft => {
  const { ledger = '', amount, asset, reduces, ...rest } = l ?? {};
  return { ledger, amount, months: asset?.months, disposedOn: asset?.disposedOn ?? '', residual: asset?.residual, reduces: reduces ?? '', rest: { ...rest, ...(asset?.connected ? { connected: true } : {}) } };
};
/**
 * A journal's line from the form: what is kept from an edit only where its ledger now takes it (VAT on
 * VAT, income, an expense or an asset's cost; a period on income or an expense, the day invoiced beside
 * it), and the fixed asset fields on a cost code by its side (a debit is an asset, a credit reduces one).
 */
const journalLineOf = (d: JournalLineDraft): JournalLine => {
  const { connected, vat, covers, invoicedOn } = d.rest;
  const kind = ledgerCode(d.ledger)?.kind;
  const spreads = kind === 'income' || kind === 'expense';
  return {
    ledger: d.ledger,
    amount: d.amount!,
    ...(vat && (takesVat(d.ledger) || d.ledger === 'vat') ? { vat } : {}),
    ...(covers && spreads ? { covers, ...(invoicedOn ? { invoicedOn } : {}) } : {}),
    ...assetFieldsOf({ ...d, connected: connected === true }, (d.amount ?? 0) > 0),
  };
};

/** A journal's lines: debits positive, credits negative, adding up to nothing before it can be saved. A journal given is changed in place. */
function JournalDialog({ companyId, accounts, assets, initial, onClose }: { companyId: string; accounts: CompanyCodingResponse['accounts']; assets: CompanyCodingResponse['assets']; initial?: Journal; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(initial?.date ?? today());
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [evidence, setEvidence] = useState(initial?.evidence ?? '');
  const [lines, setLines] = useState<JournalLineDraft[]>(initial ? initial.lines.map(journalLineDraft) : [journalLineDraft(), journalLineDraft()]);
  const total = lines.reduce((s, l) => s + toMinor(l.amount ?? 0), 0);
  const [opening, setOpening] = useState(initial?.opening === true);
  const ready = memo.trim() && lines.length >= 2 && lines.every((l) => l.ledger && l.amount) && total === 0;
  const save = useApiMutation((journal: JournalInput) => (initial ? api(`/companies/${companyId}/journals/${initial.id}`, { method: 'PUT', body: { journal, was: initial.updatedAt } }) : api(`/companies/${companyId}/journals`, { method: 'POST', body: { journal } })), {
    onSuccess: () => (toast({ tone: 'good', text: initial ? 'Journal changed' : 'Journal written' }), onClose()),
  });
  const set = (i: number, p: Partial<JournalLineDraft>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={initial ? 'Change a journal' : 'Write a journal'}
      description="An entry in the company’s books that is not a payment: shares issued at incorporation, a month’s pay and its PAYE, a dividend declared, a fixed asset brought in at its carrying amount. Debits are positive and credits negative; the lines add up to nothing."
      footer={
        <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate({ date, memo: memo.trim(), lines: lines.map(journalLineOf), ...(evidence.trim() ? { evidence: evidence.trim() } : {}), ...(opening ? { opening } : {}) })}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="What it is">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="June salary and PAYE" />
          </Field>
        </div>
        <Field label="What shows it" hint="The document: a payroll summary, a board minute, an invoice.">
          <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <Checkbox checked={opening} onChange={setOpening} label="An opening balance: it posts even before the day its books start (Settings). A fixed asset here is its carrying amount, with its remaining life." />
        {lines.map((l, i) => {
          const asset = ledgerCode(l.ledger)?.asset;
          return (
            <div key={i} className="grid gap-2">
              <div className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_auto]">
                <Field label={`Line ${i + 1}`}>
                  <LedgerSelect value={l.ledger} onChange={(ledger) => set(i, { ledger })} journal accounts={accounts} label={`Line ${i + 1} ledger`} />
                </Field>
                <Field label="Debit + / credit −">
                  <NumberInput value={l.amount} onValue={(amount) => set(i, { amount })} className="sensitive tabular" signed />
                </Field>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <span className="sm:sr-only">Remove</span>
                </Button>
              </div>
              {asset?.part === 'cost' && (l.amount ?? 0) > 0 && (
                <div className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                  <AssetFields d={l} set={(p) => set(i, p)} assetClass={asset.class} />
                </div>
              )}
              {asset?.part === 'cost' && (l.amount ?? 0) < 0 && <ReducesField value={l.reduces} onChange={(reduces) => set(i, { reduces })} assets={assets.filter((a) => a.ledger === l.ledger)} />}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, { ...journalLineDraft(), amount: total ? fromMinor(-total) : undefined }])}>
            Add a line
          </Button>
          <span className={total ? 'text-warn-ink' : 'text-good-ink'}>{total ? <>Out by {minorText(total)}</> : 'The lines add up to nothing.'}</span>
        </div>
        {save.error && <ErrorNote error={save.error} />}
      </div>
    </Dialog>
  );
}

/** Journals shown before you ask for all of them, newest first. */
const JOURNALS_SHOWN = 6;

function JournalsCard({ view, companyId }: { view: CompanyCodingResponse; companyId: string }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Journal | null>(null);
  const [all, setAll] = useState(false);
  const newest = useMemo(() => [...view.journals].reverse(), [view.journals]);
  const remove = useApiMutation((id: string) => api(`/companies/${companyId}/journals/${id}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Journal taken away' }), onError: (e) => toast({ tone: 'bad', text: e.message }) });
  return (
    <Card
      title="Journals"
      description="Entries that are not payments, posted as written."
      actions={
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
          Write a journal
        </Button>
      }
      padded={false}
    >
      {view.journals.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No journals yet">Shares issued at incorporation, a month’s pay with its PAYE, a dividend declared: what moves the books but no bank account.</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {(all ? newest : newest.slice(0, JOURNALS_SHOWN)).map((j) => (
            <li key={j.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-[13px]">
              <div className="min-w-0 flex-1 basis-64">
                <div className="text-ink">
                  {formatDate(j.date)} · {j.memo}
                  {j.createdBy === 'agent' && (
                    <Badge tone="muted" className="ml-1.5">
                      By a proposal
                    </Badge>
                  )}
                </div>
                <ul className="mt-1 grid gap-0.5 text-[12.5px] text-ink-2">
                  {j.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className={cn(l.amount < 0 && 'pl-4')}>{ledgerName(l.ledger, (id) => view.accounts.find((a) => a.id === id)?.name)}</span>
                      <span className="sensitive tabular">
                        {l.amount > 0 ? 'Dr ' : 'Cr '}
                        {formatMoneyPlain(Math.abs(l.amount))}
                      </span>
                    </li>
                  ))}
                </ul>
                {j.evidence && <div className="mt-1 text-[12px] text-ink-3">{j.evidence}</div>}
              </div>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(j)}>
                  Change
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={remove.isPending} onClick={() => remove.mutate(j.id)}>
                  Take away
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {newest.length > JOURNALS_SHOWN && (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? 'Show the latest only' : `Show all ${newest.length}`}
          </Button>
        </div>
      )}
      {adding && <JournalDialog companyId={companyId} accounts={view.accounts} assets={view.assets} onClose={() => setAdding(false)} />}
      {editing && <JournalDialog key={editing.id} companyId={companyId} accounts={view.accounts} assets={view.assets} initial={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ─── Book rules ──────────────────────────────────────────────────────────────────────────────────

function BookRulesCard({ view, companyId }: { view: CompanyCodingResponse; companyId: string }) {
  const toast = useToast();
  const [words, setWords] = useState('');
  const [rows, setRows] = useState<'own' | 'paid-for' | 'both'>('own');
  const [ledger, setLedger] = useState('');
  const [treatment, setTreatment] = useState<VatTreatment | ''>('');
  const [months, setMonths] = useState<number | undefined>(undefined);
  const add = useApiMutation(
    () =>
      api<{ coded: number }>(`/companies/${companyId}/book-rules`, {
        method: 'POST',
        body: { enabled: true, priority: 100, match: { field: 'description', op: 'contains', value: words.trim(), caseSensitive: false, company: { id: companyId, rows } }, set: { books: { ledger, ...(treatment ? { vat: { treatment } } : {}), ...(months ? { coversMonths: Math.round(months) } : {}) } } },
      }),
    {
      onSuccess: (r) => {
        toast({ tone: 'good', text: `Rule made: ${r.coded} row${r.coded === 1 ? '' : 's'} coded` });
        setWords('');
      },
      onError: (e) => toast({ tone: 'bad', text: e.message }),
    },
  );
  const remove = useApiMutation((r: Rule) => api(`/companies/${companyId}/book-rules/${r.id}`, { method: 'DELETE' }), { onSuccess: () => toast({ tone: 'good', text: 'Rule removed' }) });
  return (
    <Card title="Book rules" description="Words that say what a payment is, so the rows that match are coded by themselves: never one you coded, and never a row of yours but those paid for the company. Kept apart from your own rules.">
      <div className="flex flex-col gap-3 text-[13px]">
        {view.rules.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {view.rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  When {matchWords(r.match)} ({r.match.company?.rows === 'paid-for' ? 'rows you paid for it' : r.match.company?.rows === 'both' ? 'its rows and those you paid' : 'its own rows'}): <Badge tone="accent">{ledgerName(r.set.books?.ledger ?? '')}</Badge>
                  {r.set.books?.vat && <span className="text-ink-3"> · {VAT_TREATMENT_LABELS[r.set.books.vat.treatment].toLowerCase()}</span>}
                  {r.set.books?.coversMonths && <span className="text-ink-3"> · covers {r.set.books.coversMonths} months</span>}
                </span>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={remove.isPending} onClick={() => remove.mutate(r)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="When the description holds">
            <Input value={words} onChange={(e) => setWords(e.target.value)} placeholder="EXAMPLE HOSTING" />
          </Field>
          <Field label="Rows">
            <Select value={rows} onChange={(e) => setRows(e.target.value as typeof rows)} aria-label="Rows">
              <option value="own">Its own</option>
              <option value="paid-for">Paid by you</option>
              <option value="both">Both</option>
            </Select>
          </Field>
          <Field label="Code it as">
            <LedgerSelect value={ledger} onChange={setLedger} label="Ledger" />
          </Field>
          <Field label="VAT">
            <Select value={treatment} onChange={(e) => setTreatment(e.target.value as VatTreatment | '')} aria-label="VAT">
              <option value="">No VAT</option>
              {VAT_TREATMENTS.map((t) => (
                <option key={t} value={t}>
                  {VAT_TREATMENT_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Covers months">
            <NumberInput value={months} onValue={setMonths} className="tabular" />
          </Field>
          <div className="sm:col-span-2">
            <Button icon={<Plus className="size-3.5" />} disabled={!words.trim() || !ledger} loading={add.isPending} onClick={() => add.mutate(undefined)}>
              Make the rule
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Checks and postings ─────────────────────────────────────────────────────────────────────────

export const CHECK_TITLES: Record<LedgerCheck['kind'], string> = {
  uncoded: 'Not coded yet: posted to suspense',
  'coding-invalid': 'Coded where it does not fit',
  'bank-not-imported': 'A loan of yours with no company row: posted against the company’s bank not imported',
  'transfer-unmatched': 'One leg of a transfer between its accounts, the other not there',
  'foreign-currency': 'In another currency: the books are kept in pounds, so it is not posted',
  'possible-double-count': 'Maybe the same money twice: a loan of yours and a company row on the loan, not linked',
  'link-invalid': 'A link that does not fit',
  'journal-invalid': 'A journal that does not fit',
  'vat-unregistered': 'VAT on a day the company was not registered for it',
  reg111: 'VAT claimed from before registration, out of time (VAT Regulations 1995 reg 111)',
  'reverse-charge-rate': 'A reverse charge whose VAT is not the standard rate on the amount',
  'vat-no-invoice': 'VAT you paid claimed without an invoice addressed to the company',
  'journal-double-count': 'Maybe the same money twice: a journal on your loan and a row of yours for the same',
  'loan-balance-differs': 'A balance recorded on your director’s loan the books do not add up to',
  unbalanced: 'Postings that do not add up (please report this)',
  'no-depreciation-policy': 'A fixed asset with no life: give it one, or a depreciation policy for its class (Settings)',
  'fixed-asset-unmarked': 'Posted to a fixed asset’s cost without saying what it is: a debit is an asset (with its life), a credit says which asset it reduces',
  'fixed-asset-invalid': 'A fixed asset, or its depreciation, that does not fit',
  'covers-not-spread': 'A period said on a balance sheet code: posted as it is, not spread over it',
  'dividend-exceeds-reserves': 'A dividend more than the profit and loss reserve on the day it was paid (CA 2006 s830)',
};

export function checkLine(c: LedgerCheck): ReactNode {
  switch (c.kind) {
    case 'uncoded':
    case 'coding-invalid':
    case 'bank-not-imported':
    case 'transfer-unmatched':
    case 'foreign-currency':
      return (
        <>
          {formatDate(c.date)} · <span className="sensitive">{c.description}</span> · <Money value={c.amount} currency={c.kind === 'foreign-currency' ? c.currency : 'GBP'} className="sensitive" />
          {c.kind === 'coding-invalid' && <span className="text-ink-3"> · {c.problem}</span>}
        </>
      );
    case 'possible-double-count':
      return (
        <>
          {formatDate(c.date)} · <span className="sensitive">{c.description}</span> · <Money value={c.amount} className="sensitive" />: link them if they are the same money
        </>
      );
    case 'link-invalid':
      return c.problem;
    case 'journal-invalid':
      return `${formatDate(c.date)} · ${c.memo}: ${c.problem}`;
    case 'vat-no-invoice':
      return (
        <>
          {formatDate(c.date)} · <span className="sensitive">{c.description}</span> · VAT <Money value={c.amount} className="sensitive" />: say the invoice is addressed to the company, or code it without VAT
        </>
      );
    case 'reg111':
      return `${formatDate(c.date)}: ${c.problem}`;
    case 'reverse-charge-rate':
      return (
        <>
          {formatDate(c.date)} · VAT <Money value={c.amount} className="sensitive" />, where the standard rate gives <Money value={c.expected} className="sensitive" />
        </>
      );
    case 'journal-double-count':
      return (
        <>
          {formatDate(c.date)} · <Money value={c.amount} className="sensitive" /> beside your <span className="sensitive">{c.description}</span>: take one away if they are the same
        </>
      );
    case 'loan-balance-differs':
      return (
        <>
          {formatDate(c.date)}: recorded <Money value={c.recorded} className="sensitive" />, the books <Money value={c.ledger} className="sensitive" /> (a difference of <Money value={c.difference} className="sensitive" />)
        </>
      );
    case 'vat-unregistered':
      return (
        <>
          {formatDate(c.date)} · VAT <Money value={c.amount} className="sensitive" />
        </>
      );
    case 'unbalanced':
      return `${c.source.kind} ${c.source.id}`;
    case 'no-depreciation-policy':
      return (
        <>
          {formatDate(c.date)} · <span className="sensitive">{c.memo}</span> · <Money value={c.amount} className="sensitive" /> ({FIXED_ASSET_CLASS_META[c.class].name.toLowerCase()})
        </>
      );
    case 'fixed-asset-unmarked':
      return (
        <>
          {formatDate(c.date)} · <span className="sensitive">{c.memo}</span> · <Money value={c.amount} className="sensitive" />: code it again with its life, or to what it is
        </>
      );
    case 'fixed-asset-invalid':
      return `${formatDate(c.date)}: ${c.problem}`;
    case 'dividend-exceeds-reserves':
      return (
        <>
          {formatDate(c.date)} · <Money value={c.amount} className="sensitive" />, with <Money value={c.available} className="sensitive" /> available before it (the reserve that day, this period’s own depreciation and accruals not yet in it)
        </>
      );
    case 'covers-not-spread':
      return (
        <>
          {formatDate(c.date)} · {ledgerName(c.ledger)} · <Money value={c.amount} className="sensitive" />
        </>
      );
  }
}

function ChecksCard({ checks }: { checks: LedgerCheck[] }) {
  const groups = useMemo(() => {
    const m = new Map<LedgerCheck['kind'], LedgerCheck[]>();
    for (const c of checks) (m.get(c.kind) ?? m.set(c.kind, []).get(c.kind)!).push(c);
    return [...m];
  }, [checks]);
  if (!checks.length) return <Callout tone="good" title="Nothing to check">Every row is coded, every loan of yours has its company side, and every journal adds up.</Callout>;
  return (
    <Card title="What the books ask of you" description="Until each is settled, the books cannot be finished: suspense and the bank not imported are cleared by coding and linking, never by a journal.">
      <div className="flex flex-col gap-3 text-[13px]">
        {groups.map(([kind, list]) => (
          <details key={kind} open={list.length <= 3}>
            <summary className="cursor-pointer font-medium text-ink">
              {CHECK_TITLES[kind]} <span className="text-ink-3">({list.length})</span>
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-ink-2">
              {list.slice(0, 50).map((c, i) => (
                <li key={i}>{checkLine(c)}</li>
              ))}
              {list.length > 50 && <li className="text-ink-3">and {list.length - 50} more</li>}
            </ul>
          </details>
        ))}
      </div>
    </Card>
  );
}

/** Postings shown a page at a time. */
const POSTINGS_PAGE = 50;

/** The postings in the dates, newest first, behind a toggle and a page at a time; what they add up to by ledger beside them. */
function PostingsCard({ ledger }: { ledger: CompanyLedgerResponse }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const accountName = (id: string) => ledger.accounts.find((a) => a.id === id)?.name;
  const newest = useMemo(() => [...ledger.postings].reverse(), [ledger.postings]);
  const pages = Math.max(1, Math.ceil(newest.length / POSTINGS_PAGE));
  const at = Math.min(page, pages - 1);
  const shown = newest.slice(at * POSTINGS_PAGE, (at + 1) * POSTINGS_PAGE);
  return (
    <Card
      title="Postings"
      description={`Every posting in these dates (${ledger.postings.length}): debits and credits, each source adding up to nothing. The Accounts tab builds the trial balance, profit and loss and balance sheet from them.`}
      padded={false}
      actions={
        ledger.postings.length > 0 ? (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide them' : 'Show them'}
          </Button>
        ) : undefined
      }
    >
      {ledger.postings.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No postings in these dates" />
        </div>
      ) : !open ? null : (
        <>
          <div className="relative overflow-x-auto">
            <table className={tableClasses.table}>
              <thead>
                <tr>
                  <th className={tableClasses.th}>Date</th>
                  <th className={tableClasses.th}>Ledger</th>
                  <th className={cn(tableClasses.th, 'hidden sm:table-cell')}>From</th>
                  <th className={cn(tableClasses.th, tableClasses.num)}>Debit</th>
                  <th className={cn(tableClasses.th, tableClasses.num)}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td className={cn(tableClasses.td, 'whitespace-nowrap')}>{formatDate(p.date)}</td>
                    <td className={tableClasses.td}>
                      {ledgerName(p.ledger, accountName)}
                      {p.vat && <span className="text-[12px] text-ink-3"> · VAT {p.vat.part === 'tax' ? p.vat.side : 'net'}</span>}
                      <div className="sensitive text-[12px] text-ink-3 sm:hidden">{p.memo}</div>
                    </td>
                    <td className={cn(tableClasses.td, 'sensitive hidden text-ink-2 sm:table-cell')}>{p.memo}</td>
                    <td className={cn(tableClasses.td, tableClasses.num, 'sensitive')}>{p.amount > 0 ? minorText(p.amount) : ''}</td>
                    <td className={cn(tableClasses.td, tableClasses.num, 'sensitive')}>{p.amount < 0 ? minorText(-p.amount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px] text-ink-3">
              <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => setPage(at - 1)}>
                Newer
              </Button>
              <span>
                Page {at + 1} of {pages}
              </span>
              <Button size="sm" variant="ghost" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                Older
              </Button>
            </div>
          )}
          {ledger.totals.length > 0 && (
            <details className="border-t border-line">
              <summary className="cursor-pointer px-3 py-2.5 text-[12.5px] font-medium text-ink-2">By ledger, in these dates</summary>
              <div className="relative overflow-x-auto">
                <table className={tableClasses.table}>
                  <thead>
                    <tr>
                      <th className={tableClasses.th}>Ledger</th>
                      <th className={cn(tableClasses.th, tableClasses.num)}>Debit</th>
                      <th className={cn(tableClasses.th, tableClasses.num)}>Credit</th>
                      <th className={cn(tableClasses.th, tableClasses.num, 'hidden sm:table-cell')}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.totals.map((t) => (
                      <tr key={t.ledger}>
                        <td className={tableClasses.td}>{ledgerName(t.ledger, accountName)}</td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'sensitive')}>{minorText(t.debit)}</td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'sensitive')}>{minorText(t.credit)}</td>
                        <td className={cn(tableClasses.td, tableClasses.num, 'sensitive hidden sm:table-cell')}>{minorText(t.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

/** The Books tab: a date range, and everything above for it. */
export function BooksTab({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(addDays(today(), -365));
  const [to, setTo] = useState(today());
  const range = `from=${from}&to=${to}`;
  const coding = useApi<CompanyCodingResponse>(['company-coding', companyId, from, to], `/companies/${companyId}/coding?${range}`);
  const ledger = useApi<CompanyLedgerResponse>(['company-ledger', companyId, from, to], `/companies/${companyId}/ledger?${range}`);
  if (coding.error) return <ErrorNote error={coding.error} />;
  if (ledger.error) return <ErrorNote error={ledger.error} />;
  if (!coding.data || !ledger.data || coding.data.company.id !== companyId) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
        <p className="pb-2 text-[12.5px] text-ink-3">
          The rows and postings in these dates; what the books ask of you, across all of them.
          {coding.data.lockedThrough && ` Locked through ${formatDate(coding.data.lockedThrough)}: rows on or before it keep their coding as filed.`}
        </p>
      </div>
      <ChecksCard checks={ledger.data.checks} />
      <RowsCard view={coding.data} companyId={companyId} />
      <LinksCard view={coding.data} companyId={companyId} />
      <section className="grid gap-5 xl:grid-cols-2">
        <JournalsCard view={coding.data} companyId={companyId} />
        <BookRulesCard view={coding.data} companyId={companyId} />
      </section>
      <PostingsCard ledger={ledger.data} />
    </div>
  );
}

