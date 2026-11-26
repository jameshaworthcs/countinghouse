// A company's own records (companies.json, `books`): its dates, registrations and filings, and the
// deadlines worked out from them (shared/company-books.ts, FORMULAS.md §22). These are the company's
// routes, apart from every personal one: no personal route carries a company's books or deadlines
// (DECISIONS 2026-11-26), and tests/company-scope.test.ts lists these as answering for the company.
//
// Only the owner changes the books: no agent token may use the routes that change them (tokens.ts
// lists none of them); an agent proposes instead (`set_company_books`, `add_filing`).

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CompanyBooksListItem, CompanyBooksResponse } from '../../shared/api';
import { accountingPeriodsOf, addedBooksProblems, booksProblems, companyDeadlineAlerts, companyDeadlines, ctPeriodsOf, FILING_KIND_LABELS, vatPeriodsOf, withinChargeAssumed, withinChargeFrom } from '../../shared/company-books';
import { formatDate, today } from '../../shared/dates';
import { CompanyBooksSchema, CompanyBooksSetupSchema, CompanyFilingInputSchema, CompanyFilingSchema, CompanySchema, SlugSchema, TimestampSchema, type Company } from '../../shared/schema';
import { defaultAccountingReferenceDate } from '../../shared/uk';
import { companyView } from '../analytics/companies';
import { agentTokenOf, readJson, type AppContext } from '../context';
import { nowAfter, nowISO } from '../fsutil';
import { filingId } from '../ids';
import { StoreError } from '../store';

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
        const next = CompanyBooksSchema.parse({ ...books, filings: company.books?.filings ?? [], setBy: 'owner', updatedAt: nowAfter(company.books?.updatedAt) });
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

  /** Record a filing (or a payment of Corporation Tax): one per kind and period's end. */
  app.post('/companies/:id/filings', async (c) => {
    ownerOnly(c);
    const id = c.req.param('id');
    const input = await readJson(c, CompanyFilingInputSchema);
    if (input.filedOn > today()) throw new StoreError(`${formatDate(input.filedOn)} is in the future.`, 422);
    const filing = CompanyFilingSchema.parse({ ...input, id: filingId(id, input.kind, input.periodEnd), addedBy: 'owner' });
    const name = companyOr404(id).name;
    await store.updateCompany(
      id,
      (company) => {
        if (!company) throw new StoreError('No such company', 404);
        const books = booksOr404(company);
        if (books.filings.some((f) => f.kind === input.kind && f.periodEnd === input.periodEnd)) throw new StoreError(`${FILING_KIND_LABELS[input.kind]} for the period to ${formatDate(input.periodEnd)} is recorded already: remove it first to record it again.`, 409);
        const next = { ...books, filings: [...books.filings, filing] };
        const added = addedBooksProblems(books, next);
        if (added.length) throw new StoreError(added.join(' '), 422);
        return CompanySchema.parse({ ...company, books: next, updatedAt: nowISO() });
      },
      `company: ${name} ${FILING_KIND_LABELS[input.kind].toLowerCase()} to ${input.periodEnd}`,
    );
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

  return app;
}
