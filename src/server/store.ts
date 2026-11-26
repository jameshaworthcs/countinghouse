// The data store: everything under data/ loaded into memory, with atomic, serialised writes.
//
// Guarantees:
//  - Every write goes through the schemas (validation + canonical key order) and is atomic.
//  - A record that fails validation on load is never lost: it is quarantined and written back
//    verbatim alongside the valid records, and reported as a data issue until fixed.
//  - Edits made to the files outside the app (by hand, git checkout, Claude Code) are picked up
//    automatically by a file watcher.

import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import type { ChangeDiff } from '../shared/audit';
import { ACCOUNT_TYPE_META, balanceModeOf, sideOf } from '../shared/accounts';
import { companyMarkProblem, markMisfit } from '../shared/company';
import { addedBooksProblems } from '../shared/company-books';
import { codingPlace, codingProblems, companyLinkProblem, isBookRule, journalProblems, linkGroups, ruleBooksProblems } from '../shared/ledger';
import { defaultCategories } from '../shared/categories';
import { earmarkAccountIds } from '../shared/earmarks';
import { sectionSpan } from '../shared/coverage';
import {
  AccountSchema,
  AssumptionSchema,
  BalanceSnapshotSchema,
  CategorySchema,
  ContextSchema,
  EmploymentSchema,
  CompanySchema,
  AgreementSchema,
  CoverageConfirmationSchema,
  PersonSchema,
  TaxReturnSchema,
  EarmarksSchema,
  HmrcRecordSchema,
  JournalSchema,
  PayslipRecordSchema,
  TermsSchema,
  CsvProfileSchema,
  FigureSchema,
  CaptureItemSchema,
  ReviewActionSchema,
  GoalSchema,
  BudgetSchema,
  HoldingsSnapshotSchema,
  ImportRecordSchema,
  InsightSchema,
  InstitutionSchema,
  InstrumentSchema,
  MetaSchema,
  NoteSchema,
  ReceiptSchema,
  ProfileSchema,
  ProposalSchema,
  ResearchSchema,
  RuleSchema,
  SettingsSchema,
  TransactionSchema,
  type Account,
  type Assumption,
  type BalanceSnapshot,
  type Category,
  type ContextRecord,
  type Employment,
  type Company,
  type Agreement,
  type CoverageConfirmation,
  type Person,
  type TaxReturn,
  type HmrcRecord,
  type Journal,
  type PayslipRecord,
  type Terms,
  type CsvProfile,
  type Figure,
  type CaptureItem,
  type ReviewAction,
  type Goal,
  type Budget,
  type HoldingsSnapshot,
  type ImportRecord,
  type Insight,
  type Institution,
  type Instrument,
  type Meta,
  type Note,
  type Receipt,
  type Profile,
  type Proposal,
  type Research,
  type Rule,
  type Earmarks,
  type Settings,
  type Transaction,
} from '../shared/schema';
import { diffById, DiffCollector, diffFields, listed } from './auditdiff';
import { atomicWrite, Mutex, nowISO, readTextIfExists, sha256 } from './fsutil';

/** Bump when the on-disk format changes, and add a migration in migrations.ts. */
export const FORMAT_VERSION = 11;

export interface DataIssue {
  file: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ImportSummary {
  id: string;
  createdAt: string;
  committedAt?: string | undefined;
  fileName: string;
  mediaType: string;
  documentId: string;
  documentPath?: string | undefined;
  engine?: string | undefined;
  /** The reader or parser version that made it (e.g. "extract-9"). */
  engineVersion?: string | undefined;
  detail?: string | undefined;
  /** What the document was (a P60, a payslip, a statement…), as read. */
  documentType?: string | undefined;
  /** The name to find it by in History (ImportRecord.label), when it has one. */
  label?: ImportRecord['label'];
  result?: ImportRecord['result'];
  /** How Claude read it: model, cost, timing and its check (the Claude sessions page, for imports read before transcripts were kept). */
  reading?: Pick<ImportRecord['extraction'], 'model' | 'costUsd' | 'startedAt' | 'finishedAt' | 'durationMs' | 'verification'>;
  /**
   * The period each account's section covered (statement period, or the span of its rows), with
   * its opening and closing balances when read, and whether the start was printed (`fromStated`).
   * Coverage links a statement to the one before it by these (analytics/coverage.ts).
   */
  sections: { accountId: string; from: string; to: string; fromStated?: boolean; opening?: number; closing?: number }[];
  path: string;
}

/** A proposed fix you applied or dismissed (data/proposals/<yyyy>/<id>.json). */
export interface DecidedProposalSummary {
  id: string;
  status: Proposal['status'];
  title: string;
  changes: number;
  applied: number;
  provenance: Proposal['provenance'];
  createdAt: string;
  decidedAt?: string | undefined;
  path: string;
}

export interface ChangeEvent {
  /** Short human description, used as the git commit message line. */
  message: string;
  /** Paths (relative to the data dir) that were written. */
  paths: string[];
  /** What changed, record by record (the audit log keeps it). */
  diff?: ChangeDiff | undefined;
  /** The audit log's entry for this change, once it has one (git.ts names it in the commit). */
  auditSeq?: number | undefined;
}

const ARRAY_FILES = {
  institutions: { file: 'institutions.json', key: 'institutions', schema: InstitutionSchema },
  accounts: { file: 'accounts.json', key: 'accounts', schema: AccountSchema },
  categories: { file: 'categories.json', key: 'categories', schema: CategorySchema },
  rules: { file: 'rules.json', key: 'rules', schema: RuleSchema },
  goals: { file: 'goals.json', key: 'goals', schema: GoalSchema },
  budgets: { file: 'budgets.json', key: 'budgets', schema: BudgetSchema },
  capture: { file: 'capture.json', key: 'items', schema: CaptureItemSchema },
  actions: { file: 'actions.json', key: 'actions', schema: ReviewActionSchema },
  csvProfiles: { file: 'csv-profiles.json', key: 'profiles', schema: CsvProfileSchema },
  instruments: { file: 'instruments.json', key: 'instruments', schema: InstrumentSchema },
  employments: { file: 'employments.json', key: 'employments', schema: EmploymentSchema },
  companies: { file: 'companies.json', key: 'companies', schema: CompanySchema },
  agreements: { file: 'agreements.json', key: 'agreements', schema: AgreementSchema },
  coverage: { file: 'coverage.json', key: 'confirmations', schema: CoverageConfirmationSchema },
  people: { file: 'people.json', key: 'people', schema: PersonSchema },
  returns: { file: 'returns.json', key: 'returns', schema: TaxReturnSchema },
} as const;

/** Single-file JSONL collections: one record per line. */
const JSONL_FILES = {
  assumptions: { file: 'assumptions.jsonl', schema: AssumptionSchema },
  research: { file: 'research.jsonl', schema: ResearchSchema },
  insights: { file: 'insights.jsonl', schema: InsightSchema },
  context: { file: 'context.jsonl', schema: ContextSchema },
  notes: { file: 'notes.jsonl', schema: NoteSchema },
  receipts: { file: 'receipts.jsonl', schema: ReceiptSchema },
  hmrc: { file: 'hmrc.jsonl', schema: HmrcRecordSchema },
  payslips: { file: 'payslips.jsonl', schema: PayslipRecordSchema },
  terms: { file: 'terms.jsonl', schema: TermsSchema },
  /** A company's journals: its books' entries that are not payments (optional: no file, none). */
  journals: { file: 'journals.jsonl', schema: JournalSchema },
} as const;

interface State {
  meta: Meta;
  profile: Profile;
  settings: Settings;
  institutions: Institution[];
  accounts: Account[];
  categories: Category[];
  rules: Rule[];
  goals: Goal[];
  budgets: Budget[];
  capture: CaptureItem[];
  /** What the months in review asked of you (actions.json). */
  actions: ReviewAction[];
  csvProfiles: CsvProfile[];
  instruments: Instrument[];
  employments: Employment[];
  companies: Company[];
  agreements: Agreement[];
  /** Stretches you confirmed nothing is missing from (coverage.json). */
  coverage: CoverageConfirmation[];
  /** People you send money to or get money from (people.json). */
  people: Person[];
  /** What you told the app for each tax year's Self Assessment return (returns.json). */
  returns: TaxReturn[];
  /** Money set aside inside your everyday accounts (earmarks.json); null without the file. */
  earmarks: Earmarks | null;
  /** Append-only: every version of every assumption, in file order. */
  assumptions: Assumption[];
  /** Append-only: every research record, in file order. */
  research: Research[];
  insights: Insight[];
  context: ContextRecord[];
  notes: Note[];
  receipts: Receipt[];
  hmrc: HmrcRecord[];
  payslips: PayslipRecord[];
  terms: Terms[];
  /** Companies' journals (journals.jsonl): company data, never listed for you. */
  journals: Journal[];
  transactions: Map<string, Transaction[]>;
  balances: Map<string, BalanceSnapshot[]>;
  holdings: Map<string, HoldingsSnapshot[]>;
  figures: Figure[];
  imports: ImportSummary[];
  proposals: DecidedProposalSummary[];
}

function emptyState(): State {
  return {
    meta: { format: 'finance-data', version: FORMAT_VERSION, baseCurrency: 'GBP', createdAt: nowISO() },
    profile: ProfileSchema.parse({}),
    settings: SettingsSchema.parse({}),
    institutions: [],
    accounts: [],
    categories: [],
    rules: [],
    goals: [],
    budgets: [],
    capture: [],
    actions: [],
    csvProfiles: [],
    instruments: [],
    employments: [],
    companies: [],
    agreements: [],
    coverage: [],
    people: [],
    returns: [],
    earmarks: null,
    assumptions: [],
    research: [],
    insights: [],
    context: [],
    notes: [],
    receipts: [],
    hmrc: [],
    payslips: [],
    terms: [],
    journals: [],
    transactions: new Map(),
    balances: new Map(),
    holdings: new Map(),
    figures: [],
    imports: [],
    proposals: [],
  };
}

const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** Stable sort by date, keeping source order within a day (it matters for running balances). */
function sortByDate<T extends { date: string }>(list: T[]): T[] {
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => byDate(a.v, b.v) || a.i - b.i)
    .map(({ v }) => v);
}

export class Store extends EventEmitter {
  private state: State = emptyState();
  private readonly mutex = new Mutex();
  private txById = new Map<string, Transaction>();
  /** A row of yours → the company rows whose link names it (`companyLink`). */
  private linkedBy = new Map<string, string[]>();
  /** Raw lines / items that failed validation, keyed by relative file path. */
  private quarantine = new Map<string, unknown[]>();
  /** Hash of the last content this process wrote, per relative path. */
  private selfWrites = new Map<string, string>();
  private watcher?: FSWatcher | undefined;
  private reloadTimer?: NodeJS.Timeout | undefined;
  private pendingPaths = new Set<string>();
  issues: DataIssue[] = [];
  /** Increments on every change; analytics caches key off it. */
  version = 0;
  /** True when this process created the data directory skeleton. */
  created = false;

  private constructor(readonly dataDir: string) {
    super();
  }

  /** Open (creating if needed) a data directory. */
  static async open(dataDir: string, opts: { watch?: boolean } = {}): Promise<Store> {
    const store = new Store(path.resolve(dataDir));
    await store.ensureInitialised();
    await store.load();
    if (opts.watch) store.startWatching();
    return store;
  }

  // ─── Paths ────────────────────────────────────────────────────────────────────────────────────

  abs(rel: string): string {
    const p = path.resolve(this.dataDir, rel);
    if (p !== this.dataDir && !p.startsWith(this.dataDir + path.sep)) throw new Error(`Path escapes data dir: ${rel}`);
    return p;
  }

  private txFile(accountId: string, year: string): string {
    return `transactions/${accountId}/${year}.jsonl`;
  }

  // ─── Initialisation & loading ───────────────────────────────────────────────────────────────

  private async ensureInitialised(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const metaText = await readTextIfExists(this.abs('meta.json'));
    if (metaText !== null) return;
    this.created = true;
    const writes: [string, unknown][] = [
      ['meta.json', { format: 'finance-data', version: FORMAT_VERSION, baseCurrency: 'GBP', createdAt: nowISO() }],
      ['profile.json', ProfileSchema.parse({})],
      ['settings.json', SettingsSchema.parse({})],
      ['institutions.json', { $schema: '../schemas/institutions.schema.json', institutions: [] }],
      ['accounts.json', { $schema: '../schemas/accounts.schema.json', accounts: [] }],
      ['categories.json', { $schema: '../schemas/categories.schema.json', categories: defaultCategories() }],
      ['rules.json', { $schema: '../schemas/rules.schema.json', rules: [] }],
      ['goals.json', { $schema: '../schemas/goals.schema.json', goals: [] }],
      ['budgets.json', { $schema: '../schemas/budgets.schema.json', budgets: [] }],
      ['csv-profiles.json', { $schema: '../schemas/csv-profiles.schema.json', profiles: [] }],
      ['instruments.json', { $schema: '../schemas/instruments.schema.json', instruments: [] }],
      ['employments.json', { $schema: '../schemas/employments.schema.json', employments: [] }],
      ['companies.json', { $schema: '../schemas/companies.schema.json', companies: [] }],
      ['agreements.json', { $schema: '../schemas/agreements.schema.json', agreements: [] }],
      ['coverage.json', { $schema: '../schemas/coverage.schema.json', confirmations: [] }],
      ['people.json', { $schema: '../schemas/people.schema.json', people: [] }],
      ['returns.json', { $schema: '../schemas/returns.schema.json', returns: [] }],
    ];
    for (const [rel, value] of writes) await this.writeJson(rel, value);
    for (const def of Object.values(JSONL_FILES)) await atomicWrite(this.abs(def.file), '');
    for (const dir of ['transactions', 'balances', 'holdings', 'imports', 'documents']) {
      await mkdir(this.abs(dir), { recursive: true });
      await atomicWrite(this.abs(`${dir}/.gitkeep`), '');
    }
    await atomicWrite(this.abs('figures.jsonl'), '');
    const readme = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../docs/DATA_README.md');
    try {
      await copyFile(readme, this.abs('README.md'));
    } catch {
      // Optional; the format is documented in docs/DATA_FORMAT.md regardless.
    }
  }

  async load(): Promise<void> {
    const next = emptyState();
    const issues: DataIssue[] = [];
    const quarantine = new Map<string, unknown[]>();

    const readJson = async (rel: string): Promise<unknown> => {
      const text = await readTextIfExists(this.abs(rel));
      if (text === null) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        issues.push({ file: rel, severity: 'error', message: `Not valid JSON: ${(err as Error).message}` });
        return undefined;
      }
    };

    const single = async <T>(rel: string, schema: z.ZodType<T>, fallback: T): Promise<T> => {
      const raw = await readJson(rel);
      if (raw === undefined) return fallback;
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      issues.push({ file: rel, severity: 'error', message: formatZodError(parsed.error) });
      return fallback;
    };

    next.meta = await single('meta.json', MetaSchema, next.meta);
    next.profile = await single('profile.json', ProfileSchema, next.profile);
    next.settings = await single('settings.json', SettingsSchema, next.settings);

    const loadArray = async <T>(rel: string, key: string, schema: z.ZodType<T>): Promise<T[]> => {
      const raw = await readJson(rel);
      if (raw === undefined) return [];
      const items = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)[key];
      if (!Array.isArray(items)) {
        issues.push({ file: rel, severity: 'error', message: `Expected an object with a "${key}" array` });
        return [];
      }
      const out: T[] = [];
      items.forEach((item, i) => {
        const parsed = schema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
        else {
          issues.push({ file: `${rel}#${i}`, severity: 'error', message: `${formatZodError(parsed.error)} (kept as-is, ignored by the app)` });
          (quarantine.get(rel) ?? quarantine.set(rel, []).get(rel)!).push(item);
        }
      });
      return out;
    };

    for (const [name, def] of Object.entries(ARRAY_FILES) as [keyof typeof ARRAY_FILES, (typeof ARRAY_FILES)[keyof typeof ARRAY_FILES]][]) {
      const list = await loadArray(def.file, def.key, def.schema as z.ZodType<unknown>);
      (next as unknown as Record<string, unknown[]>)[name] = list;
    }
    if (next.categories.length === 0) next.categories = defaultCategories();
    // Optional: no file, no feature (docs/FORMULAS.md §21).
    next.earmarks = await single<Earmarks | null>('earmarks.json', EarmarksSchema, null);

    const loadJsonl = async <T>(rel: string, schema: z.ZodType<T>): Promise<T[]> => {
      const text = await readTextIfExists(this.abs(rel));
      if (!text) return [];
      const out: T[] = [];
      text.split('\n').forEach((line, i) => {
        if (!line.trim()) return;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          issues.push({ file: `${rel}:${i + 1}`, severity: 'error', message: 'Line is not valid JSON (kept as-is)' });
          (quarantine.get(rel) ?? quarantine.set(rel, []).get(rel)!).push(line);
          return;
        }
        const parsed = schema.safeParse(value);
        if (parsed.success) out.push(parsed.data);
        else {
          issues.push({ file: `${rel}:${i + 1}`, severity: 'error', message: `${formatZodError(parsed.error)} (kept as-is)` });
          (quarantine.get(rel) ?? quarantine.set(rel, []).get(rel)!).push(line);
        }
      });
      return out;
    };

    // Transactions: transactions/<account>/<year>.jsonl
    for (const accountId of await listDirs(this.abs('transactions'))) {
      const list: Transaction[] = [];
      const files = (await listFiles(this.abs(`transactions/${accountId}`))).filter((f) => f.endsWith('.jsonl')).sort();
      for (const f of files) {
        const rel = `transactions/${accountId}/${f}`;
        for (const t of await loadJsonl(rel, TransactionSchema)) {
          if (t.accountId !== accountId) {
            issues.push({ file: rel, severity: 'warning', message: `Transaction ${t.id} has accountId ${t.accountId} but lives under ${accountId}` });
          }
          list.push({ ...t, accountId });
        }
      }
      next.transactions.set(accountId, sortByDate(list));
    }

    for (const f of (await listFiles(this.abs('balances'))).filter((f) => f.endsWith('.jsonl'))) {
      const accountId = f.replace(/\.jsonl$/, '');
      next.balances.set(accountId, sortByDate(await loadJsonl(`balances/${f}`, BalanceSnapshotSchema)));
    }
    for (const f of (await listFiles(this.abs('holdings'))).filter((f) => f.endsWith('.jsonl'))) {
      const accountId = f.replace(/\.jsonl$/, '');
      next.holdings.set(accountId, sortByDate(await loadJsonl(`holdings/${f}`, HoldingsSnapshotSchema)));
    }
    next.figures = await loadJsonl('figures.jsonl', FigureSchema);
    for (const [name, def] of Object.entries(JSONL_FILES) as [keyof typeof JSONL_FILES, (typeof JSONL_FILES)[keyof typeof JSONL_FILES]][]) {
      (next as unknown as Record<string, unknown[]>)[name] = await loadJsonl(def.file, def.schema as z.ZodType<unknown>);
    }

    // Committed import records (summaries only; full records are read on demand).
    for (const year of await listDirs(this.abs('imports'))) {
      for (const f of (await listFiles(this.abs(`imports/${year}`))).filter((f) => f.endsWith('.json'))) {
        const rel = `imports/${year}/${f}`;
        const raw = await readJson(rel);
        const parsed = ImportRecordSchema.safeParse(raw);
        if (!parsed.success) {
          issues.push({ file: rel, severity: 'warning', message: formatZodError(parsed.error) });
          continue;
        }
        next.imports.push(summarise(parsed.data, rel));
      }
    }
    next.imports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Proposed fixes you applied or dismissed (summaries only; full records are read on demand).
    for (const year of await listDirs(this.abs('proposals'))) {
      for (const f of (await listFiles(this.abs(`proposals/${year}`))).filter((f) => f.endsWith('.json'))) {
        const rel = `proposals/${year}/${f}`;
        const parsed = ProposalSchema.safeParse(await readJson(rel));
        if (!parsed.success) {
          issues.push({ file: rel, severity: 'warning', message: formatZodError(parsed.error) });
          continue;
        }
        next.proposals.push(summariseProposal(parsed.data, rel));
      }
    }
    next.proposals.sort(latestDecidedFirst);

    // Referential checks (warnings only).
    const accountIds = new Set(next.accounts.map((a) => a.id));
    for (const id of next.transactions.keys()) {
      if (!accountIds.has(id)) issues.push({ file: `transactions/${id}`, severity: 'warning', message: `Transactions for unknown account "${id}"` });
    }
    for (const id of next.balances.keys()) {
      if (!accountIds.has(id)) issues.push({ file: `balances/${id}.jsonl`, severity: 'warning', message: `Balances for unknown account "${id}"` });
    }
    if (next.earmarks) {
      for (const id of [...next.earmarks.everyday, ...next.earmarks.setAside]) {
        if (!accountIds.has(id)) issues.push({ file: 'earmarks.json', severity: 'warning', message: `Set aside names unknown account "${id}"` });
      }
      const categoryIds = new Set(next.categories.map((c) => c.id));
      for (const pot of next.earmarks.pots) {
        for (const r of pot.rules) {
          if (r.category && !categoryIds.has(r.category)) issues.push({ file: 'earmarks.json', severity: 'warning', message: `Rule "${r.name}" of ${pot.name} names unknown category "${r.category}"` });
          if (r.counterpartyAccountId && !accountIds.has(r.counterpartyAccountId)) issues.push({ file: 'earmarks.json', severity: 'warning', message: `Rule "${r.name}" of ${pot.name} names unknown account "${r.counterpartyAccountId}"` });
        }
      }
    }
    // Company accounts (docs/DATA_FORMAT.md, accounts.json): what a hand edit can get wrong.
    const companyIds = new Set(next.companies.map((c) => c.id));
    const accountsById = new Map(next.accounts.map((a) => [a.id, a]));
    for (const a of next.accounts) {
      if (a.companyId && !companyIds.has(a.companyId)) issues.push({ file: 'accounts.json', severity: 'warning', message: `Account "${a.id}" names unknown company "${a.companyId}"` });
      if (a.companyId && a.includeInNetWorth) issues.push({ file: 'accounts.json', severity: 'warning', message: `Account "${a.id}" is a company's (${a.companyId}) but says it counts in your estate: it never does` });
      const older = a.continues ? accountsById.get(a.continues.accountId) : undefined;
      if (older && sideOf(older) !== sideOf(a)) issues.push({ file: 'accounts.json', severity: 'warning', message: `Account "${a.id}" carries on from "${older.id}" across the line between your money and a company's: link accounts on one side only` });
    }
    for (const c of next.companies) {
      if (c.accountId && accountsById.get(c.accountId)?.companyId) issues.push({ file: 'companies.json', severity: 'warning', message: `Company "${c.id}" carries your shares on "${c.accountId}", which is a company's own account` });
      const problem = c.directorLoanAccountId ? directorLoanLinkProblem(c, next.companies, next.accounts) : undefined;
      if (problem) issues.push({ file: 'companies.json', severity: 'warning', message: `Company "${c.id}": ${problem}` });
    }
    // Director's loans (docs/DATA_FORMAT.md): rows of their own, and marks a hand edit put where they do not fit.
    for (const a of next.accounts) {
      if (ACCOUNT_TYPE_META[a.type].derived && (next.transactions.get(a.id)?.length ?? 0) > 0) issues.push({ file: `transactions/${a.id}`, severity: 'warning', message: `Account "${a.id}" is a director's loan: its movements are the payments you mark, so its own rows are left out of its balance` });
    }
    for (const list of next.transactions.values()) {
      for (const t of list) {
        if (!t.company) continue;
        const problem = companyMarkProblem(t, t.company, { account: accountsById.get(t.accountId), company: next.companies.find((c) => c.id === t.company!.id), companyName: (id) => next.companies.find((c) => c.id === id)?.name });
        if (problem) issues.push({ file: `transactions/${t.accountId}`, severity: 'warning', message: `Transaction ${t.id} is marked as money with a company where it does not fit (${problem}): its mark counts for nothing` });
      }
    }
    const theirs = new Set(next.accounts.filter((a) => a.companyId).map((a) => a.id));
    for (const n of theirs.size ? recordsNaming(next, theirs) : []) issues.push({ file: n.file, severity: 'warning', message: `${n.what} names a company's own account (${n.accountId}): your records name only accounts of yours, so it is left out of your figures` });
    // A company's books (docs/DATA_FORMAT.md): codings, links, book rules and journals a hand edit got wrong.
    const marks = { account: (id: string) => accountsById.get(id), company: (id: string | undefined) => next.companies.find((c) => c.id === id) };
    const rowsById = new Map([...next.transactions.values()].flat().map((t) => [t.id, t]));
    for (const list of next.transactions.values()) {
      for (const t of list) {
        if (!t.books) continue;
        const place = codingPlace(t, marks);
        const problem = 'problem' in place ? place.problem : codingProblems(t.amount, t.books, place.row)[0];
        if (problem) issues.push({ file: `transactions/${t.accountId}`, severity: 'warning', message: `Transaction ${t.id} is coded where it does not fit (${problem}): its coding counts for nothing until it is put right` });
      }
    }
    for (const c of next.companies) {
      const own = new Set(next.accounts.filter((a) => a.companyId === c.id).map((a) => a.id));
      const rows = [...own].flatMap((id) => next.transactions.get(id) ?? []);
      for (const g of linkGroups(rows)) {
        const problem = companyLinkProblem(g, (id) => rowsById.get(id), marks);
        if (problem) issues.push({ file: `transactions/${rowsById.get(g.companyIds[0]!)?.accountId ?? ''}`, severity: 'warning', message: `Transaction ${g.companyIds.join(', ')} is linked to rows of yours where it does not fit (${problem}): the link counts for nothing` });
      }
    }
    for (const r of next.rules.filter(isBookRule)) {
      const problem = [...ruleBooksProblems(r), ...bookRuleAccountProblems(r, (id) => accountsById.get(id), (id) => companyIds.has(id))][0];
      if (problem) issues.push({ file: 'rules.json', severity: 'warning', message: `The rule "${r.name ?? r.match.value}" codes a company's rows but does not fit (${problem}): it codes nothing` });
    }
    for (const j of next.journals) {
      const problem = !next.companies.some((c) => c.id === j.companyId) ? `there is no company "${j.companyId}"` : journalProblems(j, (id) => accountsById.get(id)?.companyId === j.companyId)[0];
      if (problem) issues.push({ file: 'journals.jsonl', severity: 'warning', message: `Journal ${j.id} does not fit (${problem}): it is left out of the company's books` });
    }
    if (next.meta.version > FORMAT_VERSION) {
      issues.push({ file: 'meta.json', severity: 'error', message: `Data format v${next.meta.version} is newer than this app understands (v${FORMAT_VERSION}). Update the app before editing.` });
    }

    const txById = new Map<string, Transaction>();
    for (const list of next.transactions.values()) {
      for (const t of list) {
        if (txById.has(t.id)) issues.push({ file: `transactions/${t.accountId}`, severity: 'warning', message: `Duplicate transaction id ${t.id}` });
        txById.set(t.id, t);
      }
    }

    this.state = next;
    this.txById = txById;
    this.indexLinks();
    this.issues = issues;
    this.quarantine = quarantine;
    this.version++;
    this.emit('reload');
  }

  // ─── Watching for external edits ──────────────────────────────────────────────────────────────

  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dataDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join('/');
        if (rel.startsWith('documents/') || rel.includes('.tmp-') || rel.startsWith('.git') || rel.endsWith('.gitkeep')) return;
        this.pendingPaths.add(rel);
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.checkExternalChanges(), 400);
      });
    } catch (err) {
      console.warn(`File watching unavailable: ${(err as Error).message}`);
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.reloadTimer);
  }

  private async checkExternalChanges(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    let external = false;
    for (const rel of paths) {
      const text = await readTextIfExists(this.abs(rel)).catch(() => null);
      const hash = text === null ? 'deleted' : sha256(text);
      if (this.selfWrites.get(rel) !== hash) {
        external = true;
        break;
      }
    }
    if (!external) return;
    this.emit('external', paths);
    await this.mutex.run(async () => {
      console.log(`[store] external change detected (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '…' : ''}); reloading`);
      await this.load();
    });
  }

  // ─── Low-level writes ───────────────────────────────────────────────────────────────────────

  private async writeText(rel: string, text: string): Promise<void> {
    this.selfWrites.set(rel, sha256(text));
    await atomicWrite(this.abs(rel), text);
  }

  private async writeJson(rel: string, value: unknown): Promise<void> {
    await this.writeText(rel, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeJsonl(rel: string, records: unknown[]): Promise<void> {
    const lines = records.map((r) => JSON.stringify(r));
    for (const q of this.quarantine.get(rel) ?? []) lines.push(typeof q === 'string' ? q : JSON.stringify(q));
    await this.writeText(rel, lines.length ? `${lines.join('\n')}\n` : '');
  }

  private async writeArrayFile(name: keyof typeof ARRAY_FILES, items: unknown[]): Promise<string> {
    const def = ARRAY_FILES[name];
    const canonical = items.map((i) => (def.schema as z.ZodType<unknown>).parse(i));
    const all = [...canonical, ...(this.quarantine.get(def.file) ?? [])];
    await this.writeJson(def.file, { $schema: `../schemas/${def.file.replace('.json', '.schema.json')}`, [def.key]: all });
    return def.file;
  }

  private changed(message: string, paths: string[], diff?: ChangeDiff): void {
    this.version++;
    this.emit('change', { message, paths, ...(diff && Object.keys(diff).length ? { diff } : {}) } satisfies ChangeEvent);
  }

  /** Run a mutation exclusively. Data written by a newer version of the app is read-only. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state.meta.version > FORMAT_VERSION) {
      return Promise.reject(new StoreError(`The data is format v${this.state.meta.version}, newer than this app understands (v${FORMAT_VERSION}); it is read-only until the app is updated.`, 409));
    }
    return this.mutex.run(fn);
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────────────────────

  get meta(): Meta {
    return this.state.meta;
  }
  get profile(): Profile {
    return this.state.profile;
  }
  get settings(): Settings {
    return this.state.settings;
  }
  /**
   * The providers of your accounts, and any no account names: not one only a company's accounts
   * are at (its business bank is not a bank of yours).
   */
  get institutions(): Institution[] {
    if (this.wide) return this.state.institutions;
    const theirs = new Set(this.state.accounts.filter((a) => a.companyId && a.institutionId).map((a) => a.institutionId!));
    if (!theirs.size) return this.state.institutions;
    for (const a of this.scope().personal) if (a.institutionId) theirs.delete(a.institutionId);
    return this.state.institutions.filter((i) => !theirs.has(i.id));
  }
  /** Every provider, a company's accounts' too: for infrastructure only (ESLint's allowlist). */
  get allInstitutions(): Institution[] {
    return this.state.institutions;
  }
  /**
   * A provider by its name (any case), whoever's accounts are at it: a provider typed by name is
   * the one already there, not a second of the same name (a company's provider is not among yours).
   */
  institutionNamed(name: string): Institution | undefined {
    const key = name.trim().toLowerCase();
    return key ? this.state.institutions.find((i) => i.name.trim().toLowerCase() === key) : undefined;
  }
  /** Every provider's id: the ids a new one's must differ from. */
  institutionIds(): string[] {
    return this.state.institutions.map((i) => i.id);
  }

  // ─── Scope: your money, not a company's ─────────────────────────────────────────────────────
  //
  // An account with a `companyId` is a company's (its bank account, its card), and its money is
  // never yours. The accessors that list across accounts (`accounts`, `transactions()`,
  // `balances()`, `holdings()`, `figures`, `terms()`, `coverageConfirmations`, `institutions`,
  // `transactionCount()`) give your own only, so every figure built on them is personal without a
  // filter of its own.
  // Infrastructure that must see everything (ingestion, enrichment, transfer linking, validation)
  // asks for it by name (`allAccounts`, `allTransactions()`…), and company code for one company
  // (`companyAccounts`, `companyTransactions`). ESLint allows those names only in the files listed
  // in eslint.config.js (docs/ARCHITECTURE.md, "Company accounts"). A lookup by id (`account(id)`,
  // `transaction(id)`, `transactions(accountId)`) finds any record: a lookup is not a total.

  /** Test only: every accessor sees company data too (tests/company-scope.test.ts's canary). */
  private wide = false;
  private sides?: { accounts: Account[]; company: Map<string, string>; personal: Account[] };

  /** Company account id → its company, worked out once per accounts list. */
  private scope(): { company: Map<string, string>; personal: Account[] } {
    if (this.sides?.accounts !== this.state.accounts) {
      const company = new Map<string, string>();
      for (const a of this.state.accounts) if (a.companyId) company.set(a.id, a.companyId);
      this.sides = { accounts: this.state.accounts, company, personal: this.state.accounts.filter((a) => !a.companyId) };
    }
    return this.sides;
  }

  /** Is the account yours: not a company's (an account not known is yours). */
  private personal(accountId: string | undefined): boolean {
    return this.wide || !accountId || !this.scope().company.has(accountId);
  }

  /**
   * Your own records (goals, agreements, rules, set aside) are about your money: one that names a
   * company's account would carry the company's money into a personal figure, so it is refused.
   */
  private refuseCompanyAccounts(ids: readonly string[], what: string): void {
    const theirs = ids.map((id) => this.state.accounts.find((a) => a.id === id)).find((a) => a?.companyId);
    if (theirs) throw new StoreError(`${what} names ${theirs.name}, a company's own account: it can only name accounts of yours.`);
  }

  /**
   * The canary of the test that company data changes no personal figure: from now on the store's
   * accessors no longer keep company data out, so that test must fail. Refused outside Vitest, and
   * ESLint refuses it outside tests/.
   */
  widenScopeForTest(): void {
    if (process.env.VITEST !== 'true') throw new Error('widenScopeForTest is for tests only');
    this.wide = true;
    this.version++;
  }

  /** Your accounts: not a company's. */
  get accounts(): Account[] {
    return this.wide ? this.state.accounts : this.scope().personal;
  }
  /** Every account, a company's too: for infrastructure only (ESLint's allowlist). */
  get allAccounts(): Account[] {
    return this.state.accounts;
  }
  /** Every account's id, a company's too: the ids a new account's must differ from. */
  accountIds(): string[] {
    return this.state.accounts.map((a) => a.id);
  }
  /** One company's own accounts (`Account.companyId`). */
  companyAccounts(companyId: string): Account[] {
    return this.state.accounts.filter((a) => a.companyId === companyId);
  }
  /**
   * The accounts on the same side as this one (shared/accounts.ts, `sideOf`): yours for one of
   * yours, its company's for a company's. For what an account's own page or a row's neighbours
   * need, without ever mixing the two.
   */
  accountsBeside(accountId: string): Account[] {
    const companyId = this.wide ? undefined : this.scope().company.get(accountId);
    return companyId ? this.companyAccounts(companyId) : this.accounts;
  }
  get categories(): Category[] {
    return this.state.categories;
  }
  /** Your rules: those that categorise your rows (not a company's book rules). */
  get rules(): Rule[] {
    return this.state.rules.filter((r) => !isBookRule(r));
  }
  /** A company's book rules (`set.books`), or every company's: company data, for its own pages and enrichment. */
  bookRules(companyId?: string): Rule[] {
    return this.state.rules.filter((r) => isBookRule(r) && (!companyId || r.match.company?.id === companyId));
  }
  get goals(): Goal[] {
    return this.state.goals;
  }
  /** Monthly spending budgets (docs/FORMULAS.md §15). */
  get budgets(): Budget[] {
    return this.state.budgets;
  }
  /** The capture list: what to collect from each provider (docs/DATA_FORMAT.md). */
  get capture(): CaptureItem[] {
    return this.state.capture;
  }

  /** What the months in review asked of you (docs/DATA_FORMAT.md, actions.json). */
  get actions(): ReviewAction[] {
    return this.state.actions;
  }
  get csvProfiles(): CsvProfile[] {
    return this.state.csvProfiles;
  }
  /** Your figures: not those of a company's account. */
  get figures(): Figure[] {
    return this.state.figures.filter((f) => this.personal(f.accountId));
  }
  /** Every figure, those of a company's accounts too: for infrastructure only. */
  get allFigures(): Figure[] {
    return this.state.figures;
  }
  get companies(): Company[] {
    return this.state.companies;
  }
  company(id: string | undefined): Company | undefined {
    return id ? this.state.companies.find((c) => c.id === id) : undefined;
  }
  get agreements(): Agreement[] {
    return this.state.agreements;
  }
  agreement(id: string | undefined): Agreement | undefined {
    return id ? this.state.agreements.find((a) => a.id === id) : undefined;
  }
  get people(): Person[] {
    return this.state.people;
  }
  /** Money set aside inside your everyday accounts; null without earmarks.json. */
  get earmarks(): Earmarks | null {
    return this.state.earmarks;
  }
  get returns(): TaxReturn[] {
    return this.state.returns;
  }
  /** What you told the app for a tax year's return ("2025/26"), if anything. */
  taxReturn(taxYear: string): TaxReturn | undefined {
    return this.state.returns.find((r) => r.taxYear === taxYear);
  }

  /** Stretches you confirmed nothing is missing from, of your accounts. */
  get coverageConfirmations(): CoverageConfirmation[] {
    return this.state.coverage.filter((c) => this.personal(c.accountId));
  }
  /** Every confirmation, a company account's too: what a write of coverage.json starts from. */
  get allCoverageConfirmations(): CoverageConfirmation[] {
    return this.state.coverage;
  }
  get employments(): Employment[] {
    return this.state.employments;
  }
  employment(id: string | undefined): Employment | undefined {
    return id ? this.state.employments.find((e) => e.id === id) : undefined;
  }
  get hmrc(): HmrcRecord[] {
    return this.state.hmrc;
  }
  /** Each of your accounts' terms, or one account's, oldest first. */
  terms(accountId?: string): Terms[] {
    const list = accountId ? this.state.terms.filter((t) => t.accountId === accountId) : this.state.terms.filter((t) => this.personal(t.accountId));
    return [...list].sort((a, b) => a.asOf.localeCompare(b.asOf) || a.createdAt.localeCompare(b.createdAt));
  }
  get payslips(): PayslipRecord[] {
    return this.state.payslips;
  }
  get instruments(): Instrument[] {
    return this.state.instruments;
  }
  /** Every version of every assumption, oldest first (resolve with shared/assumptions.ts). */
  get assumptions(): Assumption[] {
    return this.state.assumptions;
  }
  get research(): Research[] {
    return this.state.research;
  }
  get insights(): Insight[] {
    return this.state.insights;
  }
  get context(): ContextRecord[] {
    return this.state.context;
  }
  get notes(): Note[] {
    return this.state.notes;
  }
  /** Receipts attached to transactions. */
  get receipts(): Receipt[] {
    return this.state.receipts;
  }
  /** One company's journals (journals.jsonl), by date: company data, for its books only (ESLint's allowlist). */
  companyJournals(companyId: string): Journal[] {
    return sortByDate(this.state.journals.filter((j) => j.companyId === companyId));
  }
  /** A journal by its id, whichever company's it is. */
  journal(id: string): Journal | undefined {
    return this.state.journals.find((j) => j.id === id);
  }
  /** The company rows whose link names a row of yours (`companyLink`): a lookup by the row's id. */
  companyLinksTo(transactionId: string): Transaction[] {
    return (this.linkedBy.get(transactionId) ?? []).map((id) => this.txById.get(id)).filter((t): t is Transaction => t !== undefined);
  }
  get imports(): ImportSummary[] {
    return this.state.imports;
  }
  /** An import of a company's accounts alone (every section of it is a company account's): no document of yours. */
  companyImport(summary: Pick<ImportSummary, 'sections'>): boolean {
    return !this.wide && summary.sections.length > 0 && summary.sections.every((s) => !this.personal(s.accountId));
  }
  /** Proposed fixes you applied or dismissed, the latest decided first. */
  get proposals(): DecidedProposalSummary[] {
    return this.state.proposals;
  }

  account(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  institution(id: string | undefined): Institution | undefined {
    return id ? this.state.institutions.find((i) => i.id === id) : undefined;
  }

  instrument(id: string | undefined): Instrument | undefined {
    return id ? this.state.instruments.find((i) => i.id === id) : undefined;
  }

  transaction(id: string): Transaction | undefined {
    return this.txById.get(id);
  }

  /** Rows of the accounts `keep` lets through, sorted by date (source order within a day). */
  private rowsOf<T extends { date: string }>(map: Map<string, T[]>, keep: (accountId: string) => boolean): T[] {
    const out: T[] = [];
    for (const [accountId, list] of map) if (keep(accountId)) out.push(...list);
    return sortByDate(out);
  }

  /** One account's transactions (sorted by date), whoever's it is; or all of yours. */
  transactions(accountId?: string): Transaction[] {
    if (accountId) return this.state.transactions.get(accountId) ?? [];
    return this.rowsOf(this.state.transactions, (id) => this.personal(id));
  }
  /**
   * The transactions of the accounts named, whoever's they are, in the order `transactions()` gives:
   * a list asked for by account (an account's own page), which is a lookup, not a total.
   */
  transactionsOf(accountIds: ReadonlySet<string>): Transaction[] {
    return this.rowsOf(this.state.transactions, (id) => accountIds.has(id));
  }
  /** Every transaction, a company's too: for infrastructure only (ESLint's allowlist). */
  allTransactions(): Transaction[] {
    return this.rowsOf(this.state.transactions, () => true);
  }
  /** One company's transactions: its own accounts' rows. */
  companyTransactions(companyId: string): Transaction[] {
    const ids = new Set(this.companyAccounts(companyId).map((a) => a.id));
    return this.rowsOf(this.state.transactions, (id) => ids.has(id));
  }
  /** The transactions on the same side as this account (`accountsBeside`): yours, or its company's. */
  transactionsBeside(accountId: string): Transaction[] {
    const companyId = this.wide ? undefined : this.scope().company.get(accountId);
    return companyId ? this.companyTransactions(companyId) : this.transactions();
  }

  /** How many transactions of yours. */
  transactionCount(): number {
    if (this.wide) return this.txById.size;
    let n = 0;
    for (const [accountId, list] of this.state.transactions) if (this.personal(accountId)) n += list.length;
    return n;
  }

  /** One account's balances, whoever's it is; or all of yours. */
  balances(accountId?: string): BalanceSnapshot[] {
    if (accountId) return this.state.balances.get(accountId) ?? [];
    return this.rowsOf(this.state.balances, (id) => this.personal(id));
  }
  /** Every balance, a company account's too: for infrastructure only. */
  allBalances(): BalanceSnapshot[] {
    return this.rowsOf(this.state.balances, () => true);
  }
  /** One account's figures, whoever's account it is. */
  figuresOf(accountId: string): Figure[] {
    return this.state.figures.filter((f) => f.accountId === accountId);
  }

  /** A balance by its id, whoever's account it is of. */
  balance(id: string): BalanceSnapshot | undefined {
    for (const list of this.state.balances.values()) {
      const found = list.find((b) => b.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** One account's holdings, whoever's it is; or all of yours. */
  holdings(accountId?: string): HoldingsSnapshot[] {
    if (accountId) return this.state.holdings.get(accountId) ?? [];
    return this.rowsOf(this.state.holdings, (id) => this.personal(id));
  }
  /** Every holdings snapshot, a company account's too: for infrastructure only. */
  allHoldings(): HoldingsSnapshot[] {
    return this.rowsOf(this.state.holdings, () => true);
  }

  async readImport(id: string): Promise<ImportRecord | undefined> {
    const summary = this.state.imports.find((i) => i.id === id);
    if (!summary) return undefined;
    const text = await readTextIfExists(this.abs(summary.path));
    if (!text) return undefined;
    return ImportRecordSchema.parse(JSON.parse(text));
  }

  async readProposal(id: string): Promise<Proposal | undefined> {
    const summary = this.state.proposals.find((p) => p.id === id);
    if (!summary) return undefined;
    const text = await readTextIfExists(this.abs(summary.path));
    if (!text) return undefined;
    return ProposalSchema.parse(JSON.parse(text));
  }

  // ─── Writes: settings-like files ────────────────────────────────────────────────────────────

  setProfile(profile: Profile): Promise<void> {
    return this.exclusive(async () => {
      const p = ProfileSchema.parse(profile);
      await this.writeJson('profile.json', p);
      const before = this.state.profile;
      this.state.profile = p;
      this.changed('profile: update', ['profile.json'], { fields: diffFields(before, p) });
    });
  }

  setSettings(settings: Settings): Promise<void> {
    return this.exclusive(async () => {
      const s = SettingsSchema.parse(settings);
      await this.writeJson('settings.json', s);
      const before = this.state.settings;
      this.state.settings = s;
      await this.applyDocumentTracking();
      this.changed('settings: update', ['settings.json'], { fields: diffFields(before, s) });
    });
  }

  /** Money set aside inside your everyday accounts (docs/FORMULAS.md §21); null removes the file. */
  setEarmarks(earmarks: Earmarks | null, message = 'set aside: update'): Promise<void> {
    return this.updateEarmarks(() => earmarks, message);
  }

  /**
   * Change set aside from what it is at the moment of writing, under the lock: two changes at once
   * each build on the other rather than one being lost. `change` may throw to refuse.
   */
  updateEarmarks(change: (current: Earmarks | null) => Earmarks | null, message = 'set aside: update'): Promise<void> {
    return this.exclusive(async () => {
      const next = change(this.state.earmarks);
      const e = next ? EarmarksSchema.parse(next) : null;
      const named = (x: Earmarks | null) => (x ? earmarkAccountIds(x) : []);
      const was = new Set(named(this.state.earmarks));
      if (e) this.refuseCompanyAccounts(named(e).filter((id) => !was.has(id)), 'Money set aside');
      if (e) await this.writeJson('earmarks.json', e);
      else {
        this.selfWrites.set('earmarks.json', 'deleted');
        await rm(this.abs('earmarks.json'), { force: true });
      }
      const before = this.state.earmarks;
      this.state.earmarks = e;
      this.changed(message, ['earmarks.json'], { fields: diffFields(before ?? {}, e ?? {}) });
    });
  }

  setMeta(meta: Meta): Promise<void> {
    return this.exclusive(async () => {
      const m = MetaSchema.parse(meta);
      await this.writeJson('meta.json', m);
      const before = this.state.meta;
      this.state.meta = m;
      this.changed(`data: format v${m.version}`, ['meta.json'], { fields: diffFields(before, m) });
    });
  }

  /** When documents are not tracked, a .gitignore inside documents/ keeps them out of git. */
  private async applyDocumentTracking(): Promise<void> {
    const ignore = 'documents/.gitignore';
    if (this.state.settings.git.trackDocuments) await rm(this.abs(ignore), { force: true });
    else await this.writeText(ignore, '*\n!.gitignore\n!.gitkeep\n');
  }

  private setArray<K extends keyof typeof ARRAY_FILES>(name: K, items: State[K], message: string): Promise<void> {
    return this.exclusive(() => this.writeArray(name, items, message));
  }

  /** `setArray`'s work, for a caller that holds the lock already (`updateCompany`). */
  private async writeArray<K extends keyof typeof ARRAY_FILES>(name: K, items: State[K], message: string): Promise<void> {
    const def = ARRAY_FILES[name];
    const before = this.state[name] as unknown[];
    const after = (items as unknown[]).map((i) => (def.schema as z.ZodType<unknown>).parse(i));
    // Company accounts stay apart from yours: refused before anything is written.
    if (name === 'accounts') {
      checkCompanyAccounts(after as Account[], before as Account[], this.state.companies);
      // An account that changes side may not leave your records naming it (a goal reading a
      // company's rows by id): refused, with the records to change first.
      const was = new Map((before as Account[]).map((a) => [a.id, a]));
      for (const a of after as Account[]) {
        const prior = was.get(a.id);
        if (!prior || sideOf(prior) === sideOf(a)) continue;
        const naming = recordsNaming(this.state, new Set([a.id]), { bookRules: true });
        if (naming.length) throw new StoreError(`${a.name} cannot ${a.companyId ? 'become a company’s account' : 'become yours again'} while ${naming.map((n) => n.what).join(', ')} ${naming.length === 1 ? 'names' : 'name'} it: change ${naming.length === 1 ? 'that' : 'those'} first.`);
      }
    }
    if (name === 'accounts') {
      checkDirectorLoanAccounts(after as Account[], before as Account[], this.state.companies, (id) => (this.state.transactions.get(id)?.length ?? 0) > 0);
      checkMarksStillFit(after as Account[], before as Account[], (id) => this.state.transactions.get(id) ?? [], (id) => this.state.companies.some((c) => c.id === id));
    }
    if (name === 'companies') {
      checkCompanyEstateAccounts(after as Company[], before as Company[], this.state.accounts);
      checkDirectorLoanLinks(after as Company[], before as Company[], this.state.accounts);
      checkCompanyBooks(after as Company[], before as Company[]);
    }
    // Only what this write adds or changes: one stored before (a hand edit) does not block the rest.
    const fresh = <T extends { id: string }>(list: T[]) => {
      const was = new Map((before as T[]).map((x) => [x.id, JSON.stringify(x)]));
      return list.filter((x) => was.get(x.id) !== JSON.stringify(x));
    };
    if (name === 'goals') for (const g of fresh(after as Goal[])) this.refuseCompanyAccounts(g.accountIds, `The goal "${g.name}"`);
    if (name === 'agreements') for (const a of fresh(after as Agreement[])) this.refuseCompanyAccounts(a.accountId ? [a.accountId] : [], `The agreement "${a.name}"`);
    if (name === 'rules') {
      for (const r of fresh(after as Rule[])) {
        if (!isBookRule(r)) this.refuseCompanyAccounts(ruleAccountIds(r), `The rule "${r.name ?? r.match.value}"`);
        else {
          const problem = [...ruleBooksProblems(r), ...bookRuleAccountProblems(r, (id) => this.state.accounts.find((a) => a.id === id), (id) => this.state.companies.some((x) => x.id === id))][0];
          if (problem) throw new StoreError(`The rule "${r.name ?? r.match.value}": ${problem}`);
        }
      }
    }
    const file = await this.writeArrayFile(name, items);
    (this.state as unknown as Record<string, unknown>)[name] = after;
    this.changed(message, [file], diffById(before, after));
  }

  setCategories(list: Category[], message = 'categories: update'): Promise<void> {
    return this.setArray('categories', list, message);
  }
  /** Replace your rules; companies' book rules stay as they are (they are written with `setBookRules`). */
  setRules(list: Rule[], message = 'rules: update'): Promise<void> {
    return this.exclusive(() => {
      if (list.some(isBookRule)) throw new StoreError('A rule that codes a company’s rows is kept on the company’s page.');
      return this.writeArray('rules', [...list, ...this.state.rules.filter(isBookRule)], message);
    });
  }
  /** Replace one company's book rules; yours and other companies' stay as they are. */
  setBookRules(companyId: string, list: Rule[], message = 'book rules: update'): Promise<void> {
    return this.exclusive(() => {
      if (list.some((r) => r.match.company?.id !== companyId || !r.set.books)) throw new StoreError('A company’s book rules name it and code its rows.');
      return this.writeArray('rules', [...this.state.rules.filter((r) => !isBookRule(r) || r.match.company?.id !== companyId), ...list], message);
    });
  }
  setGoals(list: Goal[], message = 'goals: update'): Promise<void> {
    return this.setArray('goals', list, message);
  }
  setBudgets(list: Budget[], message = 'budgets: update'): Promise<void> {
    return this.setArray('budgets', list, message);
  }
  setCapture(list: CaptureItem[], message = 'capture list: update'): Promise<void> {
    return this.setArray('capture', list, message);
  }

  setActions(list: ReviewAction[], message = 'actions: update'): Promise<void> {
    return this.setArray('actions', list, message);
  }
  setCsvProfiles(list: CsvProfile[], message = 'csv profiles: update'): Promise<void> {
    return this.setArray('csvProfiles', list, message);
  }
  setInstitutions(list: Institution[], message = 'institutions: update'): Promise<void> {
    return this.setArray('institutions', list, message);
  }
  setAccounts(list: Account[], message = 'accounts: update'): Promise<void> {
    return this.setArray('accounts', list, message);
  }
  setInstruments(list: Instrument[], message = 'instruments: update'): Promise<void> {
    return this.setArray('instruments', list, message);
  }
  setEmployments(list: Employment[], message = 'jobs: update'): Promise<void> {
    return this.setArray('employments', list, message);
  }
  setCompanies(list: Company[], message = 'companies: update'): Promise<void> {
    return this.setArray('companies', list, message);
  }
  async upsertCompany(company: Company, message?: string): Promise<void> {
    const existing = this.state.companies.findIndex((c) => c.id === company.id);
    const list = [...this.state.companies];
    if (existing >= 0) list[existing] = company;
    else list.push(company);
    await this.setCompanies(list, message ?? `${existing >= 0 ? 'company: update' : 'company: add'} ${company.name}`);
  }
  /**
   * Change one company from what it is at the moment of writing, under the lock: two changes at once
   * (a filing recorded while a proposal applies) each build on the other rather than one being lost.
   * `change` gets the company as it is now (undefined: none) and may throw to refuse.
   */
  updateCompany(id: string, change: (current: Company | undefined) => Company, message: string): Promise<void> {
    return this.exclusive(async () => {
      const next = change(this.state.companies.find((c) => c.id === id));
      const list = this.state.companies.some((c) => c.id === id) ? this.state.companies.map((c) => (c.id === id ? next : c)) : [...this.state.companies, next];
      await this.writeArray('companies', list, message);
    });
  }
  setAgreements(list: Agreement[], message = 'agreements: update'): Promise<void> {
    return this.setArray('agreements', list, message);
  }
  setPeople(list: Person[], message = 'people: update'): Promise<void> {
    return this.setArray('people', list, message);
  }
  setReturns(list: TaxReturn[], message = 'returns: update'): Promise<void> {
    return this.setArray('returns', list, message);
  }

  /**
   * Add stretches you confirmed nothing is missing from. Kept beside every other confirmation, a
   * company account's too: the readable list (`coverageConfirmations`) is yours alone, so a write is
   * never built from it.
   */
  addCoverageConfirmations(list: CoverageConfirmation[], message = 'coverage: update'): Promise<void> {
    return this.setArray('coverage', [...this.state.coverage, ...list], message);
  }
  /** Withdraw a confirmation by its id (any account's). */
  removeCoverageConfirmation(id: string, message = 'coverage: update'): Promise<void> {
    return this.setArray(
      'coverage',
      this.state.coverage.filter((c) => c.id !== id),
      message,
    );
  }
  /** One account's confirmations, whoever's account it is. */
  coverageConfirmationsOf(accountId: string): CoverageConfirmation[] {
    return this.state.coverage.filter((c) => c.accountId === accountId);
  }
  /** A confirmation by its id, whoever's account it is of. */
  coverageConfirmation(id: string): CoverageConfirmation | undefined {
    return this.state.coverage.find((c) => c.id === id);
  }
  async upsertAgreement(agreement: Agreement, message?: string): Promise<void> {
    const existing = this.state.agreements.findIndex((a) => a.id === agreement.id);
    const list = [...this.state.agreements];
    if (existing >= 0) list[existing] = agreement;
    else list.push(agreement);
    await this.setAgreements(list, message ?? `${existing >= 0 ? 'agreement: update' : 'agreement: add'} ${agreement.name}`);
  }
  async upsertEmployment(employment: Employment, message?: string): Promise<void> {
    const existing = this.state.employments.findIndex((e) => e.id === employment.id);
    const list = [...this.state.employments];
    if (existing >= 0) list[existing] = employment;
    else list.push(employment);
    await this.setEmployments(list, message ?? `${existing >= 0 ? 'job: update' : 'job: add'} ${employment.employer}`);
  }

  // ─── Writes: agent-maintained collections (assumptions, research, insights, context, notes) ──

  /**
   * Append records to an append-only collection (assumptions, research). Existing ids are skipped.
   * Returns the records added.
   */
  appendRecords<K extends 'assumptions' | 'research'>(name: K, records: State[K], message: string): Promise<State[K]> {
    return this.exclusive(async () => {
      const def = JSONL_FILES[name];
      const list = this.state[name] as unknown as { id: string }[];
      const ids = new Set(list.map((r) => r.id));
      const added: unknown[] = [];
      for (const raw of records as unknown as unknown[]) {
        const r = (def.schema as z.ZodType<{ id: string }>).parse(raw);
        if (ids.has(r.id)) continue;
        ids.add(r.id);
        list.push(r);
        added.push(r);
      }
      if (added.length) {
        await this.writeJsonl(def.file, list);
        this.changed(message, [def.file], listed('added', added));
      }
      return added as State[K];
    });
  }

  /** Remove records by id from a JSONL collection that is not append-only (receipts, terms). */
  removeRecords<K extends 'receipts' | 'terms'>(name: K, ids: string[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const def = JSONL_FILES[name];
      const before = this.state[name] as unknown as { id: string }[];
      const list = before.filter((r) => !ids.includes(r.id));
      if (list.length === before.length) return 0;
      await this.writeJsonl(def.file, list);
      (this.state as unknown as Record<string, unknown>)[name] = list;
      this.changed(message, [def.file], listed('removed', before.filter((r) => ids.includes(r.id))));
      return before.length - list.length;
    });
  }

  /** Insert or replace records by id in a rewritable collection (insights, context, notes, …). */
  upsertRecords<K extends 'insights' | 'context' | 'notes' | 'receipts' | 'hmrc' | 'payslips' | 'terms'>(name: K, records: State[K], message: string): Promise<void> {
    return this.exclusive(async () => {
      const def = JSONL_FILES[name];
      const list = [...(this.state[name] as unknown as { id: string }[])];
      const diff = new DiffCollector();
      for (const raw of records as unknown as unknown[]) {
        const r = (def.schema as z.ZodType<{ id: string }>).parse(raw);
        const i = list.findIndex((x) => x.id === r.id);
        if (i >= 0) {
          diff.changed(list[i]!, r);
          list[i] = r;
        } else {
          diff.op('added', r);
          list.push(r);
        }
      }
      await this.writeJsonl(def.file, list);
      (this.state as unknown as Record<string, unknown>)[name] = list;
      this.changed(message, [def.file], diff.result());
    });
  }

  // ─── Writes: a company's journals (journals.jsonl) ──────────────────────────────────────────────

  /**
   * Add or replace a company's journal, checked against the chart and its company's own accounts
   * (shared/ledger.ts, `journalProblems`). `was`: the journal's `updatedAt` the change was made against
   * (an edit), so a change made meanwhile is not lost.
   */
  putJournal(journal: Journal, message: string, opts: { was?: string } = {}): Promise<Journal> {
    return this.exclusive(async () => {
      const j = JournalSchema.parse(journal);
      if (!this.state.companies.some((c) => c.id === j.companyId)) throw new StoreError(`There is no company "${j.companyId}" in your data.`, 404);
      const problems = journalProblems(j, (id) => this.state.accounts.find((a) => a.id === id)?.companyId === j.companyId);
      if (problems.length) throw new StoreError(problems.join(' '), 422);
      const list = [...this.state.journals];
      const i = list.findIndex((x) => x.id === j.id);
      if (i >= 0 && list[i]!.companyId !== j.companyId) throw new StoreError('That journal is another company’s.', 409);
      if (opts.was !== undefined && (i < 0 || list[i]!.updatedAt !== opts.was)) throw new StoreError('The journal changed since you opened it: reload and make your change again.', 409);
      const diff = new DiffCollector();
      if (i >= 0) {
        diff.changed(list[i]!, j);
        list[i] = j;
      } else {
        diff.op('added', j);
        list.push(j);
      }
      await this.writeJsonl(JSONL_FILES.journals.file, list);
      this.state.journals = list;
      this.changed(message, [JSONL_FILES.journals.file], diff.result());
      return j;
    });
  }

  /** Take a journal away. */
  deleteJournal(id: string, message: string): Promise<Journal> {
    return this.exclusive(async () => {
      const gone = this.state.journals.find((j) => j.id === id);
      if (!gone) throw new StoreError('No such journal', 404);
      const list = this.state.journals.filter((j) => j.id !== id);
      await this.writeJsonl(JSONL_FILES.journals.file, list);
      this.state.journals = list;
      this.changed(message, [JSONL_FILES.journals.file], listed('removed', [gone]));
      return gone;
    });
  }

  async upsertInstitution(inst: Institution): Promise<void> {
    const list = this.state.institutions.filter((i) => i.id !== inst.id);
    list.push(inst);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.setInstitutions(list, `institutions: ${inst.name}`);
  }

  async upsertAccount(account: Account, message?: string): Promise<void> {
    const existing = this.state.accounts.findIndex((a) => a.id === account.id);
    const list = [...this.state.accounts];
    if (existing >= 0) list[existing] = { ...account, updatedAt: nowISO() };
    else list.push(account);
    await this.setAccounts(list, message ?? `${existing >= 0 ? 'account: update' : 'account: add'} ${account.name}`);
  }

  hasAccountData(accountId: string): boolean {
    return (
      (this.state.transactions.get(accountId)?.length ?? 0) > 0 ||
      (this.state.balances.get(accountId)?.length ?? 0) > 0 ||
      (this.state.holdings.get(accountId)?.length ?? 0) > 0
    );
  }

  async deleteAccount(accountId: string): Promise<void> {
    const linked = this.state.companies.find((c) => c.directorLoanAccountId === accountId);
    if (linked) throw new StoreError(`${linked.name} names it as your director’s loan account: take that link away first.`, 409);
    if (this.hasAccountData(accountId)) {
      throw new StoreError('Account still has transactions, balances or holdings. Close it instead, or delete its data first.', 409);
    }
    await this.setAccounts(
      this.state.accounts.filter((a) => a.id !== accountId),
      `account: delete ${accountId}`,
    );
  }

  // ─── Writes: transactions ───────────────────────────────────────────────────────────────────

  private async writeTransactionYears(accountId: string, years: Set<string>): Promise<string[]> {
    const list = this.state.transactions.get(accountId) ?? [];
    const written: string[] = [];
    for (const year of years) {
      const rel = this.txFile(accountId, year);
      const records = list.filter((t) => t.date.startsWith(year)).map((t) => TransactionSchema.parse(t));
      if (records.length === 0 && !(this.quarantine.get(rel)?.length ?? 0)) {
        await rm(this.abs(rel), { force: true });
        this.selfWrites.set(rel, 'deleted');
      } else {
        await this.writeJsonl(rel, records);
      }
      written.push(rel);
    }
    return written;
  }

  /** Add new transactions. Ids that already exist are skipped. Returns the number added. */
  addTransactions(txs: Transaction[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Map<string, Set<string>>();
      let added = 0;
      const diff = new DiffCollector();
      // Every row is checked before any is added: a refused one leaves nothing half-written.
      const fresh: Transaction[] = [];
      for (const raw of txs) {
        const t = TransactionSchema.parse(raw);
        if (this.txById.has(t.id) || fresh.some((x) => x.id === t.id)) continue;
        this.checkRow(t, undefined);
        fresh.push(t);
      }
      // A new company row that names rows of yours must make a link that fits (none is dropped: nothing changed under it).
      if (fresh.some((t) => t.companyLink)) this.linkUpkeep(new Map(fresh.map((t) => [t.id, t])));
      for (const t of fresh) {
        if (this.txById.has(t.id)) continue;
        diff.op('added', t);
        const list = this.state.transactions.get(t.accountId) ?? [];
        list.push(t);
        this.state.transactions.set(t.accountId, list);
        this.txById.set(t.id, t);
        (touched.get(t.accountId) ?? touched.set(t.accountId, new Set()).get(t.accountId)!).add(t.date.slice(0, 4));
        added++;
      }
      const paths: string[] = [];
      for (const [accountId, years] of touched) {
        this.state.transactions.set(accountId, sortByDate(this.state.transactions.get(accountId) ?? []));
        paths.push(...(await this.writeTransactionYears(accountId, years)));
      }
      if (added) {
        this.indexLinks();
        this.changed(message, paths, diff.result());
      }
      return added;
    });
  }

  /** Apply patches to existing transactions (enrichment or corrections). */
  updateTransactions(updates: { id: string; patch: Partial<Transaction> }[], message: string): Promise<Transaction[]> {
    return this.exclusive(async () => {
      const touched = new Map<string, Set<string>>();
      const out: Transaction[] = [];
      const stamp = nowISO();
      const diff = new DiffCollector();
      // Every patch is worked out and checked before any is applied: a refused one leaves nothing
      // half-written. A row patched twice takes both, in order.
      const staged = new Map<string, Transaction>();
      const plan: { id: string; current: Transaction; next: Transaction }[] = [];
      for (const { id, patch } of updates) {
        const current = staged.get(id) ?? this.txById.get(id);
        if (!current) throw new StoreError(`Unknown transaction ${id}`, 404);
        const { id: _i, accountId: _a, ...rest } = patch;
        const merged: Record<string, unknown> = { ...current, ...rest, updatedAt: stamp };
        // `undefined` in a patch means "clear this field".
        for (const [k, v] of Object.entries(rest)) if (v === undefined) delete merged[k];
        const next = TransactionSchema.parse(merged);
        this.checkRow(next, this.txById.get(id));
        staged.set(id, next);
        plan.push({ id, current, next });
      }
      // Links between the company's rows and yours still fit, or an automatic one broken by this write goes with it.
      for (const next of this.linkUpkeep(staged)) {
        const current = staged.get(next.id) ?? this.txById.get(next.id)!;
        const stamped = { ...next, updatedAt: stamp };
        staged.set(next.id, stamped);
        plan.push({ id: next.id, current, next: stamped });
      }
      for (const { id, current, next } of plan) {
        diff.changed(current, next);
        const list = this.state.transactions.get(current.accountId)!;
        list[list.indexOf(current)] = next;
        this.txById.set(id, next);
        const years = touched.get(current.accountId) ?? touched.set(current.accountId, new Set()).get(current.accountId)!;
        years.add(current.date.slice(0, 4));
        years.add(next.date.slice(0, 4));
        out.push(next);
      }
      const paths: string[] = [];
      for (const [accountId, years] of touched) {
        this.state.transactions.set(accountId, sortByDate(this.state.transactions.get(accountId) ?? []));
        paths.push(...(await this.writeTransactionYears(accountId, years)));
      }
      if (out.length) {
        this.indexLinks();
        this.changed(message, paths, diff.result());
      }
      return out;
    });
  }

  /**
   * A row a write adds or changes: never on a director's loan account (its movements are worked out
   * from the payments you mark), and a mark of money with a company (`company`) only where it fits
   * (shared/company.ts, `companyMarkProblem`). Checked when the row is new, or when its mark, link,
   * amount, currency or split changes: a row stored before (a hand edit) does not block the rest.
   */
  private checkRow(next: Transaction, current: Transaction | undefined): void {
    const account = this.state.accounts.find((a) => a.id === next.accountId);
    if (!current && account && ACCOUNT_TYPE_META[account.type].derived) throw new StoreError(`${account.name} is a director’s loan account: its movements are the payments you mark as paid for or lent to its company, never rows of its own.`);
    const changed = (keys: readonly (keyof Transaction)[]) => !current || keys.some((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    if (next.company && changed(['company', 'transferGroup', 'amount', 'currency', 'splits'])) {
      const problem = companyMarkProblem(next, next.company, { account, company: this.company(next.company.id), companyName: (id) => this.company(id)?.name });
      if (problem) throw new StoreError(problem);
    }
    // A coding only where it applies (shared/ledger.ts, `codingPlace`), and only one that fits its row.
    if (next.books && changed(['books', 'amount', 'currency', 'company', 'transferGroup', 'counterpartyAccountId', 'splits'])) {
      const place = codingPlace(next, this.markContext());
      if ('problem' in place) throw new StoreError(place.problem);
      const problems = codingProblems(next.amount, next.books, place.row);
      if (problems.length) throw new StoreError(problems.join(' '), 422);
    }
    // A link is on a company account's row, naming each row of yours once; the group it makes is checked whole (`linkUpkeep`).
    if (next.companyLink && changed(['companyLink'])) {
      if (!account?.companyId) throw new StoreError('A link to rows of yours is on a company account’s row.');
      if (new Set(next.companyLink.rows).size !== next.companyLink.rows.length) throw new StoreError('A link names each row of yours once.');
    }
  }

  /** Where a mark or a coding is judged: any account by id, and the companies in your data. */
  private markContext() {
    return { account: (id: string) => this.state.accounts.find((a) => a.id === id), company: (id: string | undefined) => this.company(id) };
  }

  /** Each row of yours that a company row's link names → those company rows. */
  private indexLinks(): void {
    const by = new Map<string, string[]>();
    for (const t of this.txById.values()) for (const id of t.companyLink?.rows ?? []) (by.get(id) ?? by.set(id, []).get(id)!).push(t.id);
    this.linkedBy = by;
  }

  /**
   * The links a write touches (shared/ledger.ts, `companyLinkProblem`), with `staged` the rows it writes
   * (null: removed). A link the write sets must fit, or the write is refused. One that a change to a row
   * breaks (a mark taken away, an amount corrected, a row removed) goes with the change when the app made
   * it (`auto`, worked out again with the rows); one you or a proposal made refuses the change, which
   * says to unlink it first. Returns the company rows whose automatic links go.
   */
  private linkUpkeep(staged: ReadonlyMap<string, Transaction | null>): Transaction[] {
    const companyOf = (accountId: string) => this.state.accounts.find((a) => a.id === accountId)?.companyId;
    const row = (id: string) => (staged.has(id) ? (staged.get(id) ?? undefined) : this.txById.get(id));
    const differs = (a: Transaction | undefined | null, b: Transaction | undefined | null, keys: readonly (keyof Transaction)[]) => !a || !b || keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    const companies = new Set<string>();
    const touched = new Set<string>();
    const setting = new Set<string>();
    for (const [id, next] of staged) {
      const prev = this.txById.get(id);
      const t = next ?? prev;
      if (!t) continue;
      const companyId = companyOf(t.accountId);
      if (companyId) {
        if ((prev?.companyLink || next?.companyLink) && differs(prev, next, ['companyLink', 'amount', 'date', 'books', 'transferGroup', 'counterpartyAccountId'])) {
          companies.add(companyId);
          touched.add(id);
        }
        if (next?.companyLink && JSON.stringify(prev?.companyLink) !== JSON.stringify(next.companyLink)) setting.add(id);
      } else {
        const by = this.linkedBy.get(id) ?? [];
        if (!by.length || !differs(prev, next, ['company', 'amount', 'currency', 'date', 'transferGroup', 'splits'])) continue;
        touched.add(id);
        for (const c of by) {
          const ct = this.txById.get(c);
          const cid = ct ? companyOf(ct.accountId) : undefined;
          if (cid) companies.add(cid);
        }
      }
    }
    const drops: Transaction[] = [];
    const ctx = this.markContext();
    for (const companyId of companies) {
      const ids = new Set(this.state.accounts.filter((a) => a.companyId === companyId).map((a) => a.id));
      const rows: Transaction[] = [];
      for (const accountId of ids) for (const t of this.state.transactions.get(accountId) ?? []) if (row(t.id)) rows.push(row(t.id)!);
      for (const [id, t] of staged) if (t && ids.has(t.accountId) && !this.txById.has(id)) rows.push(t);
      for (const g of linkGroups(rows)) {
        if (![...g.companyIds, ...g.personalIds].some((id) => touched.has(id))) continue;
        const problem = companyLinkProblem(g, row, ctx);
        if (!problem) continue;
        if (g.companyIds.some((id) => setting.has(id))) throw new StoreError(problem, 422);
        const linkedRows = g.companyIds.map((id) => row(id)!);
        if (linkedRows.every((t) => t.companyLink?.setBy === 'auto')) {
          for (const t of linkedRows) {
            const { companyLink: _l, ...rest } = t;
            drops.push(rest);
          }
        } else throw new StoreError(`${problem} The company’s row is linked to it by hand: unlink them on the company’s Books tab first.`, 409);
      }
    }
    return drops;
  }

  deleteTransactions(ids: string[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Map<string, Set<string>>();
      let removed = 0;
      const diff = new DiffCollector();
      // A row of yours a company row's link names: an automatic link goes with it, one made by hand refuses it.
      const drops = this.linkUpkeep(new Map(ids.filter((id) => this.txById.has(id)).map((id) => [id, null])));
      const stamp = nowISO();
      for (const next of drops) {
        if (ids.includes(next.id)) continue;
        const current = this.txById.get(next.id)!;
        const stamped = { ...next, updatedAt: stamp };
        diff.changed(current, stamped);
        const list = this.state.transactions.get(current.accountId)!;
        list[list.indexOf(current)] = stamped;
        this.txById.set(next.id, stamped);
        (touched.get(current.accountId) ?? touched.set(current.accountId, new Set()).get(current.accountId)!).add(current.date.slice(0, 4));
      }
      for (const id of ids) {
        const t = this.txById.get(id);
        if (!t) continue;
        diff.op('removed', t);
        const list = this.state.transactions.get(t.accountId)!;
        list.splice(list.indexOf(t), 1);
        this.txById.delete(id);
        (touched.get(t.accountId) ?? touched.set(t.accountId, new Set()).get(t.accountId)!).add(t.date.slice(0, 4));
        removed++;
      }
      const paths: string[] = [];
      for (const [accountId, years] of touched) paths.push(...(await this.writeTransactionYears(accountId, years)));
      if (removed) {
        this.indexLinks();
        this.changed(message, paths, diff.result());
      }
      return removed;
    });
  }

  // ─── Writes: balances, holdings, figures ─────────────────────────────────────────────────────

  addBalances(snaps: BalanceSnapshot[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Set<string>();
      let added = 0;
      const diff = new DiffCollector();
      for (const raw of snaps) {
        const s = BalanceSnapshotSchema.parse(raw);
        const list = this.state.balances.get(s.accountId) ?? [];
        if (list.some((b) => b.id === s.id)) continue;
        diff.op('added', s);
        list.push(s);
        this.state.balances.set(s.accountId, sortByDate(list));
        touched.add(s.accountId);
        added++;
      }
      const paths: string[] = [];
      for (const accountId of touched) {
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, this.state.balances.get(accountId)!);
        paths.push(rel);
      }
      if (added) this.changed(message, paths, diff.result());
      return added;
    });
  }

  updateBalance(id: string, patch: Partial<BalanceSnapshot>, message: string): Promise<BalanceSnapshot> {
    return this.exclusive(async () => {
      for (const [accountId, list] of this.state.balances) {
        const i = list.findIndex((b) => b.id === id);
        if (i < 0) continue;
        const { id: _id, accountId: _acc, ...rest } = patch;
        const next = BalanceSnapshotSchema.parse({ ...list[i], ...rest });
        const diff = new DiffCollector();
        diff.changed(list[i]!, next);
        list[i] = next;
        this.state.balances.set(accountId, sortByDate(list));
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, this.state.balances.get(accountId)!);
        this.changed(message, [rel], diff.result());
        return next;
      }
      throw new StoreError(`Unknown balance ${id}`, 404);
    });
  }

  /** Move balances to the accounts they are of (a proposal applied): each keeps its id and all else. */
  moveBalances(moves: { id: string; accountId: string }[], message: string): Promise<BalanceSnapshot[]> {
    return this.exclusive(async () => {
      const touched = new Set<string>();
      const out: BalanceSnapshot[] = [];
      const diff = new DiffCollector();
      for (const { id, accountId } of moves) {
        const from = [...this.state.balances].find(([, list]) => list.some((b) => b.id === id));
        if (!from) throw new StoreError(`Unknown balance ${id}`, 404);
        const [fromId, list] = from;
        const was = list.find((b) => b.id === id)!;
        if (fromId === accountId) continue;
        list.splice(list.indexOf(was), 1);
        const next = BalanceSnapshotSchema.parse({ ...was, accountId });
        diff.changed(was, next);
        this.state.balances.set(accountId, sortByDate([...(this.state.balances.get(accountId) ?? []), next]));
        touched.add(fromId).add(accountId);
        out.push(next);
      }
      const paths: string[] = [];
      for (const accountId of touched) {
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, this.state.balances.get(accountId)!);
        paths.push(rel);
      }
      if (out.length) this.changed(message, paths, diff.result());
      return out;
    });
  }

  deleteBalance(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      for (const [accountId, list] of this.state.balances) {
        const i = list.findIndex((b) => b.id === id);
        if (i < 0) continue;
        const [gone] = list.splice(i, 1);
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, list);
        this.changed(message, [rel], listed('removed', [gone]));
        return;
      }
      throw new StoreError(`Unknown balance ${id}`, 404);
    });
  }

  /** Add holdings snapshots; `replaces` are snapshots they supersede (same account and day, merged into them). */
  addHoldings(snaps: HoldingsSnapshot[], message: string, replaces: string[] = []): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Set<string>();
      let added = 0;
      const diff = new DiffCollector();
      for (const [accountId, list] of this.state.holdings) {
        const kept = list.filter((h) => !replaces.includes(h.id));
        if (kept.length === list.length) continue;
        for (const h of list) if (replaces.includes(h.id)) diff.op('removed', h);
        this.state.holdings.set(accountId, kept);
        touched.add(accountId);
      }
      for (const raw of snaps) {
        const s = HoldingsSnapshotSchema.parse(raw);
        const list = this.state.holdings.get(s.accountId) ?? [];
        if (list.some((h) => h.id === s.id)) continue;
        diff.op('added', s);
        list.push(s);
        this.state.holdings.set(s.accountId, sortByDate(list));
        touched.add(s.accountId);
        added++;
      }
      const paths: string[] = [];
      for (const accountId of touched) {
        const rel = `holdings/${accountId}.jsonl`;
        await this.writeJsonl(rel, this.state.holdings.get(accountId)!);
        paths.push(rel);
      }
      if (added || paths.length) this.changed(message, paths, diff.result());
      return added;
    });
  }

  deleteHoldings(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      for (const [accountId, list] of this.state.holdings) {
        const i = list.findIndex((h) => h.id === id);
        if (i < 0) continue;
        const [gone] = list.splice(i, 1);
        const rel = `holdings/${accountId}.jsonl`;
        await this.writeJsonl(rel, list);
        this.changed(message, [rel], listed('removed', [gone]));
        return;
      }
      throw new StoreError(`Unknown holdings snapshot ${id}`, 404);
    });
  }

  addFigures(figs: Figure[], message: string): Promise<number> {
    return this.exclusive(async () => {
      let added = 0;
      const diff = new DiffCollector();
      for (const raw of figs) {
        const f = FigureSchema.parse(raw);
        if (this.state.figures.some((x) => x.id === f.id)) continue;
        this.state.figures.push(f);
        diff.op('added', f);
        added++;
      }
      if (added) {
        const key = (f: Figure) => f.periodEnd ?? f.date ?? f.periodStart ?? '';
        this.state.figures.sort((a, b) => key(a).localeCompare(key(b)));
        await this.writeJsonl('figures.jsonl', this.state.figures);
        this.changed(message, ['figures.jsonl'], diff.result());
      }
      return added;
    });
  }

  updateFigure(id: string, patch: Partial<Figure>, message: string): Promise<Figure> {
    return this.exclusive(async () => {
      const i = this.state.figures.findIndex((f) => f.id === id);
      if (i < 0) throw new StoreError(`Unknown figure ${id}`, 404);
      const { id: _id, ...rest } = patch;
      const next = FigureSchema.parse({ ...this.state.figures[i], ...rest });
      const diff = new DiffCollector();
      diff.changed(this.state.figures[i]!, next);
      this.state.figures[i] = next;
      await this.writeJsonl('figures.jsonl', this.state.figures);
      this.changed(message, ['figures.jsonl'], diff.result());
      return next;
    });
  }

  /** Put a figure in place of the stored one with its id: unlike `updateFigure`, a field it leaves out is removed. */
  replaceFigure(figure: Figure, message: string): Promise<Figure> {
    return this.exclusive(async () => {
      const i = this.state.figures.findIndex((f) => f.id === figure.id);
      if (i < 0) throw new StoreError(`Unknown figure ${figure.id}`, 404);
      const next = FigureSchema.parse(figure);
      const diff = new DiffCollector();
      diff.changed(this.state.figures[i]!, next);
      this.state.figures[i] = next;
      await this.writeJsonl('figures.jsonl', this.state.figures);
      this.changed(message, ['figures.jsonl'], diff.result());
      return next;
    });
  }

  deleteFigure(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      const gone = this.state.figures.filter((f) => f.id === id);
      if (!gone.length) throw new StoreError(`Unknown figure ${id}`, 404);
      this.state.figures = this.state.figures.filter((f) => f.id !== id);
      await this.writeJsonl('figures.jsonl', this.state.figures);
      this.changed(message, ['figures.jsonl'], listed('removed', gone));
    });
  }

  // ─── Writes: imports & documents ─────────────────────────────────────────────────────────────

  /** Copy an original document into data/documents/<yyyy>/<mm>/ and return its relative path. */
  async storeDocument(sourceFile: string, sha: string, fileName: string, date = new Date()): Promise<string> {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const rel = `documents/${yyyy}/${mm}/${sha.slice(0, 12)}-${fileName}`;
    const abs = this.abs(rel);
    try {
      await stat(abs);
      return rel; // identical content already stored
    } catch {
      await mkdir(path.dirname(abs), { recursive: true });
      await copyFile(sourceFile, abs);
      return rel;
    }
  }

  documentAbsPath(rel: string): string {
    return this.abs(rel);
  }

  saveImport(record: ImportRecord, message: string, extraPaths: string[] = []): Promise<void> {
    return this.exclusive(async () => {
      const r = ImportRecordSchema.parse(record);
      const rel = `imports/${r.id.slice(4, 8)}/${r.id}.json`;
      await this.writeJson(rel, r);
      const was = this.state.imports.find((i) => i.id === r.id);
      this.state.imports = [summarise(r, rel), ...this.state.imports.filter((i) => i.id !== r.id)];
      this.changed(message, [rel, ...extraPaths], { [was ? 'changed' : 'added']: 1, items: [{ id: r.id, op: was ? 'changed' : 'added', label: `${r.status} ${r.document.fileName}` }] });
    });
  }

  /** Keep a proposed fix you applied or dismissed: the record of what changed, why, and who said so. */
  saveProposal(record: Proposal, message: string): Promise<void> {
    return this.exclusive(async () => {
      const p = ProposalSchema.parse(record);
      if (p.status === 'pending') throw new StoreError('Only a proposal you applied or dismissed is kept in the data.', 500);
      const rel = `proposals/${p.id.slice(5, 9)}/${p.id}.json`;
      await this.writeJson(rel, p);
      this.state.proposals = [summariseProposal(p, rel), ...this.state.proposals.filter((x) => x.id !== p.id)].sort(latestDecidedFirst);
      this.changed(message, [rel], { added: 1, items: [{ id: p.id, op: 'added', label: `${p.status} ${p.title}`.slice(0, 160) }] });
    });
  }
}

/** The accounts a rule names: those it is limited to, and the one it sends money to. */
function ruleAccountIds(r: Rule): string[] {
  return [...(r.match.accountIds ?? []), ...(r.set.counterpartyAccountId ? [r.set.counterpartyAccountId] : [])];
}

/**
 * The accounts a book rule is limited to are those whose rows it codes: its company's own (rows `own`),
 * yours (rows of yours `paid-for`), or either (`both`); its company is in your data. Problems in words.
 */
export function bookRuleAccountProblems(r: Rule, account: (id: string) => Account | undefined, companyKnown: (id: string) => boolean): string[] {
  const c = r.match.company;
  if (!c) return [];
  const out: string[] = [];
  if (!companyKnown(c.id)) out.push(`there is no company "${c.id}" in your data.`);
  for (const id of r.match.accountIds ?? []) {
    const a = account(id);
    if (!a) out.push(`there is no account "${id}".`);
    else if (a.companyId ? a.companyId !== c.id || c.rows === 'paid-for' : c.rows === 'own') out.push(`${a.name} is not an account whose rows it codes (${c.rows === 'own' ? 'the company’s own' : c.rows === 'paid-for' ? 'yours' : 'the company’s own or yours'}).`);
  }
  return out;
}

/**
 * Your records that name one of `ids`: goals, agreements, rules and money set aside. A company's
 * account must never be among them (a goal would read its rows by id), so an account named here
 * cannot change side, and one found on load is reported.
 */
export function recordsNaming(state: Pick<State, 'goals' | 'agreements' | 'rules' | 'earmarks'>, ids: ReadonlySet<string>, opts: { bookRules?: boolean } = {}): { file: string; what: string; accountId: string }[] {
  const out: { file: string; what: string; accountId: string }[] = [];
  const hit = (file: string, what: string, named: readonly string[]) => {
    const accountId = named.find((id) => ids.has(id));
    if (accountId) out.push({ file, what, accountId });
  };
  for (const g of state.goals) hit('goals.json', `the goal "${g.name}"`, g.accountIds);
  for (const a of state.agreements) hit('agreements.json', `the agreement "${a.name}"`, a.accountId ? [a.accountId] : []);
  // A company's book rule names its accounts by design: only an account changing side asks about it (`bookRules`).
  for (const r of state.rules) if (opts.bookRules || !isBookRule(r)) hit('rules.json', `the rule "${r.name ?? r.match.value}"`, ruleAccountIds(r));
  if (state.earmarks) hit('earmarks.json', 'money set aside', earmarkAccountIds(state.earmarks));
  return out;
}

/**
 * The rules that keep a company's accounts apart from yours (docs/DATA_FORMAT.md, accounts.json),
 * for each account a write adds or changes (or that carries on from one it changes): it names a
 * company that exists; it is never in your estate; it is not the account that carries your shares
 * in a company in your estate (that one is yours); and it carries on only from an account on its own
 * side. Throws a 400 naming the first problem.
 */
export function checkCompanyAccounts(next: readonly Account[], before: readonly Account[], companies: readonly Company[]): void {
  const was = new Map(before.map((a) => [a.id, JSON.stringify(a)]));
  const byId = new Map(next.map((a) => [a.id, a]));
  const changed = new Set(next.filter((a) => was.get(a.id) !== JSON.stringify(a)).map((a) => a.id));
  for (const a of next) {
    const older = a.continues ? byId.get(a.continues.accountId) : undefined;
    if (!changed.has(a.id) && !(older && changed.has(older.id))) continue;
    if (a.companyId) {
      const company = companies.find((c) => c.id === a.companyId);
      if (!company) throw new StoreError(`${a.name} names a company that is not in your data ("${a.companyId}").`);
      if (a.includeInNetWorth) throw new StoreError(`${a.name} is ${company.name}'s account: its money is the company's, so it is never counted in your estate.`);
      if (companies.some((c) => c.accountId === a.id)) throw new StoreError(`${a.name} carries your shares in a company in your estate: it is yours, not the company's.`);
    }
    if (older && sideOf(older) !== sideOf(a)) throw new StoreError(`${a.name} cannot carry on from ${older.name}: one is a company's account and the other is not, or they are two companies'.`);
  }
}

/** A company's `accountId` (its shares in your estate) is yours: never an account of a company. Checked for the companies a write adds or changes. */
export function checkCompanyEstateAccounts(companies: readonly Company[], before: readonly Company[], accounts: readonly Account[]): void {
  const was = new Map(before.map((c) => [c.id, JSON.stringify(c)]));
  for (const c of companies) {
    if (was.get(c.id) === JSON.stringify(c)) continue;
    const account = c.accountId ? accounts.find((a) => a.id === c.accountId) : undefined;
    if (account?.companyId) throw new StoreError(`${account.name} is a company's own account, so it cannot carry your shares in ${c.name} in your estate.`);
  }
}

/**
 * Director's loan accounts (docs/DATA_FORMAT.md, accounts.json), for each account a write adds or
 * changes: yours (never a company's own), moving with its movements (ledger, in pounds), with no rows
 * of its own; and an account a company names as its director's loan stays one. Throws a 400.
 */
export function checkDirectorLoanAccounts(next: readonly Account[], before: readonly Account[], companies: readonly Company[], hasRows: (id: string) => boolean): void {
  const was = new Map(before.map((a) => [a.id, a]));
  for (const a of next) {
    const prior = was.get(a.id);
    if (prior && JSON.stringify(prior) === JSON.stringify(a)) continue;
    if (ACCOUNT_TYPE_META[a.type].derived) {
      if (a.companyId) throw new StoreError(`${a.name} is a director’s loan: it is yours (what the company owes you), never one of the company’s own accounts.`);
      if (balanceModeOf(a) !== 'ledger') throw new StoreError(`${a.name} is a director’s loan: it moves with its movements, never at market.`);
      if (a.currency !== 'GBP') throw new StoreError(`${a.name} is a director’s loan: it is kept in pounds.`);
      if (prior && !ACCOUNT_TYPE_META[prior.type].derived && hasRows(a.id)) throw new StoreError(`${a.name} has rows of its own: a director’s loan’s movements are the payments you mark, so it cannot become one.`);
    } else if (prior && ACCOUNT_TYPE_META[prior.type].derived) {
      const linked = companies.find((c) => c.directorLoanAccountId === a.id);
      if (linked) throw new StoreError(`${linked.name} names ${a.name} as your director’s loan account: take that link away before changing its type.`);
    }
  }
}

/**
 * An account whose type, valuation (`balanceMode`) or side (`companyId`) a write changes must leave
 * every mark of money with a company on its rows fitting (shared/company.ts): a payment on an account
 * now valued at market, or now a company's own, would otherwise keep a mark that counts for nothing.
 * Refused with the marks to take away first, as a side change is refused while your records name it.
 */
export function checkMarksStillFit(next: readonly Account[], before: readonly Account[], rowsOf: (id: string) => readonly Transaction[], companyKnown: (id: string) => boolean): void {
  const was = new Map(before.map((a) => [a.id, a]));
  for (const a of next) {
    const prior = was.get(a.id);
    if (!prior || (prior.type === a.type && prior.balanceMode === a.balanceMode && prior.companyId === a.companyId)) continue;
    const broken = rowsOf(a.id).filter((t) => t.company && !markMisfit(t, t.company, prior, companyKnown(t.company.id)) && markMisfit(t, t.company, a, companyKnown(t.company.id)));
    if (!broken.length) continue;
    const listed = broken.slice(0, 3).map((t) => `${t.description} on ${t.date}`).join('; ');
    throw new StoreError(`${a.name} cannot change like that while ${broken.length === 1 ? 'a payment on it is' : `${broken.length} payments on it are`} marked as money with your company (${listed}${broken.length > 3 ? '…' : ''}): the mark${broken.length === 1 ? '' : 's'} would no longer count. Take ${broken.length === 1 ? 'it' : 'them'} away first.`);
  }
}

/** Why a company's director's loan account cannot be the one it names, or undefined. */
export function directorLoanLinkProblem(c: Company, companies: readonly Company[], accounts: readonly Account[]): string | undefined {
  if (!c.directorLoanAccountId) return undefined;
  const account = accounts.find((a) => a.id === c.directorLoanAccountId);
  if (!account) return `its director’s loan account "${c.directorLoanAccountId}" is not in your data.`;
  if (!ACCOUNT_TYPE_META[account.type].derived) return `${account.name} is a ${ACCOUNT_TYPE_META[account.type].label.toLowerCase()}, not a director’s loan account.`;
  if (account.companyId) return `${account.name} is a company’s own account: your director’s loan is yours.`;
  if (c.accountId === account.id) return `${account.name} carries your shares in ${c.name}: a director’s loan is an account of its own.`;
  const other = companies.find((x) => x.id !== c.id && x.directorLoanAccountId === account.id);
  if (other) return `${account.name} is your director’s loan with ${other.name} already: each company has its own.`;
  return undefined;
}

/** For each company a write adds or changes: its director's loan account fits (`directorLoanLinkProblem`). Throws a 400. */
export function checkDirectorLoanLinks(companies: readonly Company[], before: readonly Company[], accounts: readonly Account[]): void {
  const was = new Map(before.map((c) => [c.id, JSON.stringify(c)]));
  for (const c of companies) {
    if (was.get(c.id) === JSON.stringify(c)) continue;
    const problem = directorLoanLinkProblem(c, companies, accounts);
    if (problem) throw new StoreError(`${c.name}: ${problem}`);
  }
}

/**
 * For each company a write adds or changes: its books gain no problem (`addedBooksProblems`: periods
 * within the Acts' limits, in order, filings once each and after their periods). A problem already
 * there (a hand edit) does not block the write, so the app can fix one at a time; one the write adds
 * is refused. Throws a 422.
 */
export function checkCompanyBooks(companies: readonly Company[], before: readonly Company[]): void {
  const was = new Map(before.map((c) => [c.id, c.books]));
  for (const c of companies) {
    const prior = was.get(c.id);
    if (!c.books || JSON.stringify(prior ?? null) === JSON.stringify(c.books)) continue;
    const added = addedBooksProblems(prior, c.books);
    if (added.length) throw new StoreError(`${c.name}: ${added.join(' ')}`, 422);
  }
}

function summariseProposal(p: Proposal, rel: string): DecidedProposalSummary {
  return {
    id: p.id,
    status: p.status,
    title: p.title,
    changes: p.changes.length,
    applied: p.applied?.length ?? 0,
    provenance: p.provenance,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    path: rel,
  };
}

const latestDecidedFirst = (a: DecidedProposalSummary, b: DecidedProposalSummary) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt);

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function sectionsOf(r: ImportRecord): ImportSummary['sections'] {
  if (r.status !== 'committed' || !r.draft) return [];
  const out: ImportSummary['sections'] = [];
  for (const s of r.draft.sections) {
    if (s.target.mode === 'skip') continue;
    const accountId = r.result?.sections?.find((x) => x.key === s.key)?.accountId ?? (s.target.mode === 'existing' ? s.target.accountId : s.target.account.id);
    const span = sectionSpan(s, r.draft.documentType);
    if (!span) continue;
    const { from, to } = span;
    // With an investment app's activity list, the balances are its cash, and so is `cash`.
    const closing = s.cashLedger ? s.cash : s.balance;
    out.push({
      accountId,
      from,
      to,
      ...(span.fromStated ? { fromStated: true } : {}),
      ...(s.openingBalance !== undefined ? { opening: s.openingBalance } : {}),
      ...(closing !== undefined ? { closing } : {}),
    });
  }
  return out;
}

function summarise(r: ImportRecord, rel: string): ImportSummary {
  return {
    sections: sectionsOf(r),
    id: r.id,
    createdAt: r.createdAt,
    committedAt: r.committedAt,
    fileName: r.document.fileName,
    mediaType: r.document.mediaType,
    documentId: r.document.id,
    documentPath: r.document.path,
    engine: r.extraction.engine,
    engineVersion: r.extraction.engineVersion,
    detail: r.extraction.detail,
    documentType: r.draft?.documentType,
    label: r.label,
    result: r.result,
    ...(r.extraction.engine === 'inference' || r.extraction.engine === 'claude-cli' || r.extraction.engine === 'claude-api'
      ? { reading: { model: r.extraction.model, costUsd: r.extraction.costUsd, startedAt: r.extraction.startedAt, finishedAt: r.extraction.finishedAt, durationMs: r.extraction.durationMs, verification: r.extraction.verification } }
      : {}),
    path: rel,
  };
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}
