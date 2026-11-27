// A company's own records (companies.json, `books`): its dates, registrations and filings, and the
// deadlines worked out from them (shared/company-books.ts, FORMULAS.md §22). These are the company's
// routes, apart from every personal one: no personal route carries a company's books or deadlines
// (DECISIONS 2026-11-26), and tests/company-scope.test.ts lists these as answering for the company.
//
// Its general ledger too (analytics/ledger.ts, FORMULAS.md §22): its postings and checks, the rows to
// code with the links between its rows and yours, its journals and its book rules; and its accounts for
// each accounting period (analytics/period-accounts.ts); its VAT returns (analytics/vat-return.ts),
// Corporation Tax computations (analytics/corporation-tax.ts) and its accounts as it files them at
// Companies House (analytics/accounts-filing.ts). One write here reaches a figure of yours: the book
// value of your shares at a period's end, recorded only when you choose to (`accounts/book-value`).
//
// Only the owner changes the books: no agent token may use the routes that change them (tokens.ts
// lists none of them); an agent proposes instead (`set_company_books`, `add_filing`, `set_books`,
// `link_company`, `add_journal`, `remove_journal`, `add_rule` with `books`).

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CompanyBooksListItem, CompanyBooksResponse } from '../../shared/api';
import { accountingPeriodsOf, addedBooksProblems, booksProblems, keptWithBooks, lockAfterFiling, companyDeadlineAlerts, companyDeadlines, ctPeriodsOf, FILING_KIND_LABELS, vatPeriodsOf, withinChargeAssumed, withinChargeFrom } from '../../shared/company-books';
import { formatDate, today } from '../../shared/dates';
import { AccountsNotesSchema, BalanceSnapshotSchema, BooksCodingSchema, BooksEmployeesSchema, CompanyBooksSchema, CompanyBooksSetupSchema, CompanyFilingInputSchema, CompanyFilingSchema, CompanySchema, ISODateSchema, JournalInputSchema, MICRO_ENTITY_LINES, RuleSchema, SlugSchema, TimestampSchema, VatCorrectionSchema, VatDisclosureSchema, type Company, type CompanyFiling, type Journal, type Rule, type Transaction } from '../../shared/schema';
import { codingPlace, isLinked } from '../../shared/ledger';
import { autoLinkPatches, bookRulePatches, codingView, companyBookRules, ledgerView } from '../analytics/ledger';
import { periodAccounts } from '../analytics/period-accounts';
import { companyVat, vatReturnCsv } from '../analytics/vat-return';
import { companyCorporationTax, ctComputationCsv } from '../analytics/corporation-tax';
import { companyFiling, filingCsv, filingJson } from '../analytics/accounts-filing';
import { formatMoney } from '../../shared/money';
import { defaultAccountingReferenceDate } from '../../shared/uk';
import { companyView } from '../analytics/companies';
import { agentTokenOf, csvCell, queryDate, readJson, type AppContext } from '../context';
import { nowAfter, nowISO, randomHex } from '../fsutil';
import { balanceId, filingId, ruleId } from '../ids';
import { StoreError } from '../store';

const CodingBody = z.object({
  /** null: leave it uncoded, and book rules leave it so (with `reset`, take that away too, so rules may code it). */
  books: BooksCodingSchema.omit({ setBy: true, ruleId: true, uncoded: true }).nullable(),
  reset: z.boolean().optional(),
});
const LinkBody = z.object({
  /** The rows of yours it is the other side of; [] says it is linked to none; null takes the link away. */
  rows: z.array(z.string().regex(/^tx_[0-9a-f]{16}$/)).max(30).nullable(),
  /** A fee you confirm, larger than a link allows by itself: what was sent less what arrived, to the penny. */
  fee: z.number().positive().optional(),
});
const JournalBody = z.object({ journal: JournalInputSchema, /** An edit: the journal's `updatedAt` it was made against. */ was: TimestampSchema.optional() });
const BookRuleBody = RuleSchema.omit({ id: true, createdAt: true, updatedAt: true });

/** The errors a VAT return corrected (method 1) and its own errors reported separately (method 2): each null takes it away. */
const VatCorrectionsBody = z.object({ corrections: z.array(VatCorrectionSchema).max(40).nullable().optional(), disclosed: VatDisclosureSchema.nullable().optional() });

/** What you confirm for one period's accounts: its average number employed, and its notes (each null: take it away). */
const AccountsNotesBody = z.object({
  periodEnd: ISODateSchema,
  employees: BooksEmployeesSchema.shape.average.nullable().optional(),
  notes: AccountsNotesSchema.omit({ periodEnd: true }).nullable().optional(),
});
/** The accounts recorded as filed: the lines you saw, the day and reference, the approval as filed. */
const AccountsFiledBody = z.object({
  periodEnd: ISODateSchema,
  filedOn: ISODateSchema,
  reference: z.string().trim().min(1).max(60).optional(),
  approvedOn: ISODateSchema,
  approvedBy: z.string().trim().min(1).max(120),
  lines: z.object(Object.fromEntries(MICRO_ENTITY_LINES.map((l) => [l, z.number().int()])) as Record<(typeof MICRO_ENTITY_LINES)[number], z.ZodNumber>),
});

const SetupBody = z.object({ books: CompanyBooksSetupSchema, was: TimestampSchema.nullable().optional(), /** The company the page was showing: refused when it is not this one. */ company: SlugSchema.optional() });

export function companyBookRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { store } = ctx;
  const ownerOnly = (c: Context) => {
    if (agentTokenOf(c)) throw new StoreError('Only the owner changes a company’s books: propose it instead.', 403);
  };
  const companyOr404 = (id: string): Company => {
    const company = store.company(id);
    if (!company) throw new StoreError('No such company', 404);
    return company;
  };
  const booksOr404 = (company: Company) => {
    if (!company.books) throw new StoreError(`${company.name}’s books are not kept here.`, 404);
    return company.books;
  };

  /** The companies whose books are kept here, with what needs you. */
  app.get('/company-books', (c) => {
    const now = today();
    const list: CompanyBooksListItem[] = store.companies.flatMap((co) => {
      if (!co.books) return [];
      const deadlines = companyDeadlines(co, now);
      const next = deadlines.find((d) => d.status !== 'done');
      return [{ id: co.id, name: co.name, overdue: deadlines.filter((d) => d.status === 'overdue').length, dueSoon: deadlines.filter((d) => d.status === 'due-soon').length, ...(next ? { next } : {}) }];
    });
    return c.json(list);
  });

  /** Company deadlines due within 60 days or overdue, across companies, as the Overview shows them beside its own alerts. */
  app.get('/company-alerts', (c) => {
    const now = today();
    return c.json({ alerts: store.companies.flatMap((co) => (co.books ? companyDeadlineAlerts(co, companyDeadlines(co, now)) : [])) });
  });

  /** A company's books, periods and deadlines. */
  app.get('/companies/:id/books', (c) => {
    const company = companyOr404(c.req.param('id'));
    const now = today();
    const books = company.books ?? null;
    const loan = company.directorLoanAccountId ? companyView(store, company, ctx.analytics.engine).directorLoan : undefined;
    const body: CompanyBooksResponse = {
      company: { id: company.id, name: company.name, ...(company.number ? { number: company.number } : {}) },
      books,
      accountingReferenceDate: books ? { value: books.accountingReferenceDate ?? defaultAccountingReferenceDate(books.incorporatedOn), isDefault: !books.accountingReferenceDate } : null,
      periods: books ? { accounts: accountingPeriodsOf(books, now), ct: ctPeriodsOf(books, now), vat: vatPeriodsOf(books, now).map(({ filing: _f, ...p }) => p) } : { accounts: [], ct: [], vat: [] },
      deadlines: companyDeadlines(company, now),
      problems: books ? booksProblems(books) : [],
      withinCharge: books ? { from: withinChargeFrom(books) ?? null, assumed: withinChargeAssumed(books) } : null,
      ...(loan ? { directorLoan: loan } : {}),
    };
    return c.json(body);
  });

  /**
   * Keep a company's books here, or change them: its filings stay. What you set is yours: a proposal
   * never replaces it. Built on the company as it is when written (`Store.updateCompany`), so a filing
   * recorded meanwhile is kept; `was` (and `company`, the page's) must match it, or it is refused.
   */
  app.put('/companies/:id/books', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const { books, was, company: from } = await readJson(c, SetupBody);
    if (from !== undefined && from !== id) throw new StoreError('These books are another company’s: reload the page and make your change again.', 409);
    const name = companyOr404(id).name;
    let updatedAt = '';
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        if (was !== undefined && was !== (company.books?.updatedAt ?? null)) throw new StoreError(`${company.name}’s books changed since you opened them (an applied proposal, or another tab): reload and make your change again.`, 409);
        const next = CompanyBooksSchema.parse({ ...books, ...keptWithBooks(company.books), setBy: 'owner', updatedAt: nowAfter(company.books?.updatedAt) });
        // Only problems this change adds: one a hand edit left can be put right a step at a time.
        const added = addedBooksProblems(company.books, next);
        if (added.length) throw new StoreError(added.join(' '), 422);
        updatedAt = next.updatedAt;
        return CompanySchema.parse({ ...company, books: next, updatedAt: nowISO() });
      },
      `company: ${name} books`,
    );
    return c.json({ ok: true, updatedAt });
  });

  /** Write a filing to a company's books: one per kind and period's end; accounts lock the books through their period's end. */
  const recordFiling = async (id: string, filing: CompanyFiling) => {
    const name = companyOr404(id).name;
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        const books = booksOr404(company);
        if (books.filings.some((f) => f.kind === filing.kind && f.periodEnd === filing.periodEnd)) throw new StoreError(`${FILING_KIND_LABELS[filing.kind]} for the period to ${formatDate(filing.periodEnd)} is recorded already: remove it first to record it again.`, 409);
        // Accounts recorded as filed lock the books through their period's end.
        const next = { ...books, filings: [...books.filings, filing], ...lockAfterFiling(books, filing) };
        const added = addedBooksProblems(books, next);
        if (added.length) throw new StoreError(added.join(' '), 422);
        return CompanySchema.parse({ ...company, books: next, updatedAt: nowISO() });
      },
      `company: ${name} ${FILING_KIND_LABELS[filing.kind].toLowerCase()} to ${filing.periodEnd}`,
    );
  };

  /** Record a filing (or a payment of Corporation Tax): one per kind and period's end. */
  app.post('/companies/:id/filings', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const input = await readJson(c, CompanyFilingInputSchema);
    if (input.filedOn > today()) throw new StoreError(`${formatDate(input.filedOn)} is in the future.`, 422);
    if (input.kind === 'vat' && input.disclosed && input.disclosed.on > today()) throw new StoreError(`${formatDate(input.disclosed.on)} is in the future.`, 422);
    if (input.kind === 'accounts' && input.approvedOn && (input.approvedOn < input.periodEnd || input.approvedOn > input.filedOn)) throw new StoreError('The accounts are approved on or after the balance sheet date, and before they are filed.', 422);
    const filing = CompanyFilingSchema.parse({ ...input, id: filingId(id, input.kind, input.periodEnd), addedBy: 'owner' });
    await recordFiling(id, filing);
    return c.json(filing, 201);
  });

  /** Take a filing away (one recorded by mistake): the deadline it did is open again. */
  app.delete('/companies/:id/filings/:filingId', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const fid = c.req.param('filingId');
    const name = companyOr404(id).name;
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        const books = booksOr404(company);
        if (!books.filings.some((f) => f.id === fid)) throw new StoreError('No such filing', 404);
        return CompanySchema.parse({ ...company, books: { ...books, filings: books.filings.filter((f) => f.id !== fid) }, updatedAt: nowISO() });
      },
      `company: ${name} filing ${fid} removed`,
    );
    return c.json({ ok: true });
  });

  /**
   * Say which errors on earlier returns a VAT return corrected (VAT Notice 700/45 method 1: its boxes 1
   * and 4 include them), or that its own errors were reported to HMRC separately (method 2). The figures
   * filed stay as they are: this records what was done about them.
   */
  app.put('/companies/:id/filings/:filingId/vat-corrections', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const fid = c.req.param('filingId');
    const body = await readJson(c, VatCorrectionsBody);
    if (body.disclosed && body.disclosed.on > today()) throw new StoreError(`${formatDate(body.disclosed.on)} is in the future.`, 422);
    const name = companyOr404(id).name;
    let saved: unknown;
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        const books = booksOr404(company);
        const was = books.filings.find((f) => f.id === fid);
        if (!was) throw new StoreError('No such filing', 404);
        if (was.kind !== 'vat') throw new StoreError('Only a VAT return records corrections of VAT errors.', 422);
        const { corrections: _c, disclosed: _d, ...rest } = was;
        const corrections = body.corrections === undefined ? was.corrections : (body.corrections ?? undefined);
        const disclosed = body.disclosed === undefined ? was.disclosed : (body.disclosed ?? undefined);
        const filing = CompanyFilingSchema.parse({ ...rest, ...(corrections?.length ? { corrections } : {}), ...(disclosed ? { disclosed } : {}) });
        const next = { ...books, filings: books.filings.map((f) => (f.id === fid ? filing : f)) };
        const added = addedBooksProblems(books, next);
        if (added.length) throw new StoreError(added.join(' '), 422);
        saved = filing;
        return CompanySchema.parse({ ...company, books: next, updatedAt: nowISO() });
      },
      `company: ${name} VAT corrections on ${fid}`,
    );
    return c.json(saved);
  });

  // ─── The general ledger (FORMULAS.md §22, "The general ledger") ──────────────────────────────────

  const keptOr404 = (id: string): Company => {
    const company = companyOr404(id);
    booksOr404(company);
    return company;
  };

  /** Its postings in a date range, what they add up to by ledger, and the ledger's checks. */
  app.get('/companies/:id/ledger', (c) => c.json(ledgerView(store, keptOr404(c.req.param('id')), queryDate(c.req.query('from')), queryDate(c.req.query('to')), today())));

  /**
   * Its accounts for one accounting period (`?period=<its last day>`; absent: the latest ended, or the
   * current one): trial balance, profit and loss, balance sheet exact and in whole pounds, the fixed
   * asset register, the director's loan, the bank reconciled, and what stops it being ready.
   */
  app.get('/companies/:id/accounts', (c) => {
    const company = keptOr404(c.req.param('id'));
    const wanted = c.req.query('period');
    const period = queryDate(wanted);
    if (wanted && !period) throw new StoreError('A period is given by its last day, YYYY-MM-DD.', 400);
    const body = periodAccounts({ src: store, company, engine: ctx.analytics.companyEngine(company.id), today: today(), period });
    if (!body) throw new StoreError(period ? `${company.name} has no accounting period ending on ${formatDate(period)} in its books.` : `${company.name}’s books reach no accounting period yet.`, 404);
    return c.json(body);
  });

  /**
   * Its VAT returns from the books (`?period=<its last day>`; absent: the next to file): the periods and
   * their state, the return's nine boxes with their working and checks, the return filed against them,
   * the errors on returns filed, penalty points information and the thresholds. `format=csv`: the
   * return's nine boxes, ending with the disclaimer. Nothing is sent to HMRC.
   */
  app.get('/companies/:id/vat', (c) => {
    const company = keptOr404(c.req.param('id'));
    const wanted = c.req.query('period');
    const period = queryDate(wanted);
    if (wanted && !period) throw new StoreError('A VAT period is given by its last day, YYYY-MM-DD.', 400);
    const body = companyVat({ src: store, company, today: today(), period });
    if (!body) throw new StoreError(`${company.name} has no VAT period ending on ${formatDate(period ?? '')} in its books.`, 404);
    if (c.req.query('format') !== 'csv') return c.json(body);
    if (!body.ret) throw new StoreError(`${company.name} has no VAT return to export: it is not registered for VAT here.`, 404);
    return new Response(vatReturnCsv(company, body.ret, csvCell), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vat-return-${company.id}-${body.ret.period.end}.csv"` },
    });
  });

  /**
   * Its Corporation Tax computations from the books (`?period=<a CT period's last day>`; absent: the one
   * to work on next): the CT periods and their state, the computation (accounts' profit, adjustments,
   * pre-trading expenditure, capital allowances, losses, non-trading income, tax by financial year) with
   * the CT600's boxes and what stops it being ready. `format=csv`: the boxes and working, ending with the
   * disclaimer. Nothing is sent to HMRC.
   */
  app.get('/companies/:id/corporation-tax', (c) => {
    const company = keptOr404(c.req.param('id'));
    const wanted = c.req.query('period');
    const period = queryDate(wanted);
    if (wanted && !period) throw new StoreError('A Corporation Tax period is given by its last day, YYYY-MM-DD.', 400);
    const body = companyCorporationTax({ src: store, company, engine: ctx.analytics.companyEngine(company.id), today: today(), period });
    if (!body) throw new StoreError(`${company.name} has no Corporation Tax period ending on ${formatDate(period ?? '')} in its books.`, 404);
    if (c.req.query('format') !== 'csv') return c.json(body);
    if (!body.computation) throw new StoreError(`${company.name} has no Corporation Tax computation to export${period ? ' for that period: it is before these books' : ''}.`, 404);
    return new Response(ctComputationCsv(company, { form: body.form, disclaimer: body.disclaimer, computation: body.computation }, csvCell), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="corporation-tax-${company.id}-${body.computation.period.end}.csv"` },
    });
  });

  // ─── Filing the accounts (analytics/accounts-filing.ts, FORMULAS.md §22, "Filing the accounts") ────

  /** A period's filing sheet, from its accounts and what you confirmed for it (`?period=<its last day>`). */
  const filingOf = (company: Company, period: string | undefined) => {
    const body = companyFiling({ src: store, company, engine: ctx.analytics.companyEngine(company.id), today: today(), period });
    if (!body) throw new StoreError(period ? `${company.name} has no accounting period ending on ${formatDate(period)} in its books.` : `${company.name}’s books reach no accounting period yet.`, 404);
    return body;
  };

  /**
   * Its micro-entity accounts as it files them (`?period=<its last day>`; absent: the latest ended, or
   * the current one): the balance sheet in the form's order and words with the period before, the notes,
   * the statements, eligibility and what must be done before filing. `format=csv` or `format=json`: the
   * figures to file, ending with the disclaimer. Nothing is sent to Companies House.
   */
  app.get('/companies/:id/filing', (c) => {
    const company = keptOr404(c.req.param('id'));
    const wanted = c.req.query('period');
    const period = queryDate(wanted);
    if (wanted && !period) throw new StoreError('A period is given by its last day, YYYY-MM-DD.', 400);
    const body = filingOf(company, period);
    const format = c.req.query('format');
    const name = `accounts-${company.id}-${body.period.end}`;
    if (format === 'csv') return new Response(filingCsv(company, body, csvCell), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` } });
    if (format === 'json') return new Response(JSON.stringify(filingJson(company, body), null, 2) + '\n', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.json"` } });
    return c.json(body);
  });

  /**
   * What you confirm for a period's accounts: the average number employed (`employees`: a number, or null
   * to take it away) and the notes the books cannot work out (`notes`: replaced whole; null takes them
   * away). Yours alone: no agent token reaches it. Nothing that posts changes, so a locked period's notes
   * can still be put right.
   */
  app.put('/companies/:id/accounts-notes', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const body = await readJson(c, AccountsNotesBody);
    const name = companyOr404(id).name;
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        const books = booksOr404(company);
        if (!accountingPeriodsOf(books, today()).some((p) => p.end === body.periodEnd)) throw new StoreError(`${company.name} has no accounting period ending on ${formatDate(body.periodEnd)}.`, 422);
        const others = <T extends { periodEnd: string }>(list: readonly T[] | undefined) => (list ?? []).filter((x) => x.periodEnd !== body.periodEnd);
        const employees = body.employees === undefined ? books.employees : [...others(books.employees), ...(body.employees === null ? [] : [{ periodEnd: body.periodEnd, average: body.employees }])].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
        const notes = body.notes === undefined ? books.accountsNotes : [...others(books.accountsNotes), ...(body.notes === null ? [] : [{ ...body.notes, periodEnd: body.periodEnd }])].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
        const { employees: _e, accountsNotes: _n, ...rest } = books;
        return CompanySchema.parse({ ...company, books: { ...rest, ...(employees?.length ? { employees } : {}), ...(notes?.length ? { accountsNotes: notes } : {}) }, updatedAt: nowISO() });
      },
      `company: ${name} accounts notes to ${body.periodEnd}`,
    );
    return c.json({ ok: true });
  });

  /**
   * Record the period's accounts as filed, once you have submitted them: lines A–K as the sheet works
   * them out now (the lines you saw must still be them), the day filed and its reference, and the
   * approval (day and director) as filed. Only when the sheet is ready; it locks the books through the
   * period's end. Never done by itself.
   */
  app.post('/companies/:id/accounts/filed', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const body = await readJson(c, AccountsFiledBody);
    const company = keptOr404(id);
    const sheet = filingOf(company, body.periodEnd);
    if (sheet.filing) throw new StoreError(`The accounts for the period to ${formatDate(body.periodEnd)} are recorded as filed already.`, 409);
    if (!sheet.ready) throw new StoreError(`Not ready to record as filed: ${sheet.gate.filter((g) => !g.ok).map((g) => g.label.toLowerCase()).join('; ')}.`, 422);
    const moved = MICRO_ENTITY_LINES.filter((l) => body.lines[l] !== sheet.lines[l]);
    if (moved.length) throw new StoreError(`The books have changed since you opened the sheet (line${moved.length === 1 ? '' : 's'} ${moved.join(', ')}): reload it and check what you filed.`, 409);
    const now = today();
    if (body.filedOn > now) throw new StoreError(`${formatDate(body.filedOn)} is in the future.`, 422);
    if (body.approvedOn < body.periodEnd) throw new StoreError('The accounts are approved on or after the balance sheet date.', 422);
    if (body.approvedOn > body.filedOn) throw new StoreError('The accounts are approved before they are filed.', 422);
    const filing = CompanyFilingSchema.parse({ kind: 'accounts', periodStart: sheet.period.start, periodEnd: body.periodEnd, filedOn: body.filedOn, ...(body.reference ? { reference: body.reference } : {}), figures: sheet.lines, approvedOn: body.approvedOn, approvedBy: body.approvedBy, id: filingId(id, 'accounts', body.periodEnd), addedBy: 'owner' });
    await recordFiling(id, filing);
    return c.json(filing, 201);
  });

  /**
   * Record the book value of your shares at a period's end (FORMULAS.md §9, "Shares in a company"): its
   * net assets (K, as filed or as the books give it) × your shares ÷ the shares it has issued, never below
   * nothing, as a valuation of the account that carries them and a balance on it. The one write here that
   * reaches a figure of yours, and only on your click.
   */
  app.post('/companies/:id/accounts/book-value', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const { periodEnd } = await readJson(c, z.object({ periodEnd: ISODateSchema }));
    const company = keptOr404(id);
    const sheet = filingOf(company, periodEnd);
    const bv = sheet.bookValue;
    if (bv.why || bv.value === undefined) throw new StoreError(bv.why ?? 'There is no book value to record.', 422);
    if (bv.recorded) throw new StoreError(`A book value at ${formatDate(periodEnd)} is recorded already (${formatMoney(bv.recorded.value)}).`, 409);
    const account = store.account(company.accountId!);
    if (!account) throw new StoreError('The account that carries your shares is no longer in your data.', 422);
    const pounds = (n: number) => `£${n.toLocaleString('en-GB')}`;
    const note = bv.netAssets > 0 ? `Book value: net assets ${pounds(bv.netAssets)} × ${bv.shares} of its ${bv.totalShares} shares, from its accounts to ${formatDate(periodEnd)}.` : `Book value: nothing. Its accounts to ${formatDate(periodEnd)} show ${bv.netAssets < 0 ? `net liabilities of ${pounds(-bv.netAssets)}` : 'no net assets'}; shares are never valued below nothing.`;
    const stamp = nowISO();
    const balance = BalanceSnapshotSchema.parse({ id: balanceId(account.id, periodEnd, bv.value, 'manual'), accountId: account.id, date: periodEnd, balance: bv.value, currency: 'GBP', kind: 'manual', dateSource: 'document', note, source: {}, createdAt: stamp });
    // A balance there already (the same value on the same day) is the valuation's: it is never taken away below.
    const existed = store.balances(account.id).some((b) => b.id === balance.id);
    await store.addBalances([balance], `balance: ${account.name} book value at ${periodEnd}`);
    try {
      await store.updateCompany(
        id,
        (current) => {
          if (!current) throw new StoreError('No such company', 404);
          if (current.valuations.some((v) => v.asOf === periodEnd && v.method === 'net-assets')) throw new StoreError(`A book value at ${formatDate(periodEnd)} is recorded already.`, 409);
          return CompanySchema.parse({ ...current, valuations: [...current.valuations, { asOf: periodEnd, method: 'net-assets', netAssets: bv.netAssets, value: bv.value, note, balanceId: balance.id, source: {} }], updatedAt: stamp });
        },
        `company: ${company.name} book value at ${periodEnd}`,
      );
    } catch (err) {
      if (!existed) await store.deleteBalance(balance.id, `balance: ${account.name} book value at ${periodEnd} not kept`);
      throw err;
    }
    return c.json({ ok: true, value: bv.value, balanceId: balance.id }, 201);
  });

  /** The rows to code (uncoded first), the links between its rows and yours and what could be linked, its journals and book rules. */
  app.get('/companies/:id/coding', (c) => c.json(codingView(store, keptOr404(c.req.param('id')), queryDate(c.req.query('from')), queryDate(c.req.query('to')))));

  /** A row of this company's books: one of its own accounts' rows, or a row of yours paid for or lent to it. */
  const rowOf = (company: Company, txId: string): Transaction => {
    const t = store.transaction(txId);
    const account = t ? store.account(t.accountId) : undefined;
    if (!t || !account || (account.companyId ? account.companyId !== company.id : t.company?.id !== company.id)) throw new StoreError(`No such row in ${company.name}’s books.`, 404);
    return t;
  };

  /**
   * Code a row: yours, so nothing else changes it. `books: null` leaves it uncoded on purpose (a coding
   * of yours that says so, which book rules leave); with `reset: true` it has no coding at all, and the
   * book rules may code it again.
   */
  app.put('/companies/:id/rows/:txId/books', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const t = rowOf(company, c.req.param('txId'));
    const { books, reset } = await readJson(c, CodingBody);
    if (books) {
      const place = codingPlace(t, { account: (id) => store.account(id), company: (id) => store.company(id) });
      if ('problem' in place) throw new StoreError(place.problem, 422);
      if (isLinked(t) && !(books.ledger === 'directors-loan' && !books.lines?.length && !books.vat)) throw new StoreError('It is linked to money between you and the company, so it is the director’s loan: unlink it first to code it otherwise.', 422);
    }
    const next = books ? { ...books, setBy: 'user' as const } : reset ? undefined : { uncoded: true as const, setBy: 'user' as const };
    await store.updateTransactions([{ id: t.id, patch: { books: next } }], `books: ${company.name} ${books ? 'code' : reset ? 'reset' : 'leave uncoded'} ${t.id}`);
    // Back to no coding: the book rules code it again, as they would have.
    if (reset) {
      const patches = bookRulePatches(store, company.id, { only: new Set([t.id]) });
      if (patches.length) await store.updateTransactions(patches.map(({ id, patch }) => ({ id, patch })), `books: ${company.name} rule codes ${t.id}`, { locked: 'skip' });
    }
    return c.json(store.transaction(t.id));
  });

  /** Link a company row to rows of yours lent to it or repaid by it (null: take the link away; []: linked to none). */
  app.put('/companies/:id/rows/:txId/link', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const t = rowOf(company, c.req.param('txId'));
    if (!store.account(t.accountId)?.companyId) throw new StoreError('A link is set on the company’s row, naming the rows of yours that are the same money.', 422);
    const { rows, fee } = await readJson(c, LinkBody);
    for (const id of rows ?? []) rowOf(company, id);
    if (fee !== undefined && !rows?.length) throw new StoreError('A fee is confirmed on a link to rows of yours.', 422);
    const [updated] = await store.updateTransactions([{ id: t.id, patch: { companyLink: rows === null ? undefined : { rows, setBy: 'user', ...(fee !== undefined ? { fee } : {}) } } }], `books: ${company.name} ${rows?.length ? 'link' : 'unlink'} ${t.id}`);
    return c.json(updated);
  });

  /** Link what the app would link by itself now (exact, unique, within 4 days), without re-working every row. */
  app.post('/companies/:id/links/auto', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const patches = autoLinkPatches(store, company.id);
    if (patches.length) await store.updateTransactions(patches, `books: ${company.name} links worked out (${patches.length})`, { locked: 'skip' });
    return c.json({ changed: patches.length });
  });

  /** Write a journal. */
  app.post('/companies/:id/journals', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const { journal } = await readJson(c, JournalBody);
    const stamp = nowISO();
    const saved = await store.putJournal({ ...journal, id: `jnl_${randomHex(6)}`, companyId: company.id, createdBy: 'owner', createdAt: stamp, updatedAt: stamp } satisfies Journal, `books: ${company.name} journal ${journal.memo}`);
    return c.json(saved, 201);
  });

  /** Change a journal (yours from then on). */
  app.put('/companies/:id/journals/:jid', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const was = store.journal(c.req.param('jid'));
    if (!was || was.companyId !== company.id) throw new StoreError('No such journal', 404);
    const body = await readJson(c, JournalBody);
    // What the form gives, whole (evidence it leaves out is taken away), on the journal's own id and company.
    const saved = await store.putJournal({ ...body.journal, id: was.id, companyId: was.companyId, createdBy: 'owner', createdAt: was.createdAt, updatedAt: nowAfter(was.updatedAt) }, `books: ${company.name} journal ${body.journal.memo}`, body.was ? { was: body.was } : {});
    return c.json(saved);
  });

  app.delete('/companies/:id/journals/:jid', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const was = store.journal(c.req.param('jid'));
    if (!was || was.companyId !== company.id) throw new StoreError('No such journal', 404);
    await store.deleteJournal(was.id, `books: ${company.name} journal removed ${was.memo}`);
    return c.json({ ok: true });
  });

  /** A company's book rules applied to its rows now: each row they reach takes what they make of it. */
  const applyBookRules = async (company: Company, label: string) => {
    const patches = bookRulePatches(store, company.id);
    if (patches.length) await store.updateTransactions(patches.map(({ id, patch }) => ({ id, patch })), `books: ${company.name} rule ${label} (${patches.length} coded)`, { locked: 'skip' });
    return patches.length;
  };

  /** Add a book rule, and code the rows it matches. */
  app.post('/companies/:id/book-rules', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const body = await readJson(c, BookRuleBody);
    if (body.match.company?.id !== company.id) throw new StoreError(`A book rule here names ${company.name}.`, 422);
    const stamp = nowISO();
    const rule: Rule = { ...body, id: ruleId(), createdAt: stamp, updatedAt: stamp };
    await store.setBookRules(company.id, [...companyBookRules(store, company.id), rule], `books: ${company.name} rule ${rule.name ?? rule.match.value}`);
    const coded = await applyBookRules(company, rule.name ?? rule.match.value);
    return c.json({ rule, coded }, 201);
  });

  app.put('/companies/:id/book-rules/:ruleId', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const rules = companyBookRules(store, company.id);
    const was = rules.find((r) => r.id === c.req.param('ruleId'));
    if (!was) throw new StoreError('No such rule', 404);
    const body = await readJson(c, BookRuleBody);
    if (body.match.company?.id !== company.id) throw new StoreError(`A book rule here names ${company.name}.`, 422);
    const next = RuleSchema.parse({ ...body, id: was.id, createdAt: was.createdAt, updatedAt: nowISO() });
    await store.setBookRules(company.id, rules.map((r) => (r.id === was.id ? next : r)), `books: ${company.name} rule ${next.name ?? next.match.value}`);
    const coded = await applyBookRules(company, next.name ?? next.match.value);
    return c.json({ rule: next, coded });
  });

  app.delete('/companies/:id/book-rules/:ruleId', async (c) => {
    ownerOnly(c);
    const company = keptOr404(c.req.param('id'));
    const rules = companyBookRules(store, company.id);
    const was = rules.find((r) => r.id === c.req.param('ruleId'));
    if (!was) throw new StoreError('No such rule', 404);
    await store.setBookRules(company.id, rules.filter((r) => r.id !== was.id), `books: ${company.name} rule removed ${was.name ?? was.match.value}`);
    const coded = await applyBookRules(company, `${was.name ?? was.match.value} (removed)`);
    return c.json({ ok: true, coded });
  });

  return app;
}
