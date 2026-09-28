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
import { defaultCategories } from '../shared/categories';
import {
  AccountSchema,
  BalanceSnapshotSchema,
  CategorySchema,
  CsvProfileSchema,
  FigureSchema,
  GoalSchema,
  HoldingsSnapshotSchema,
  ImportRecordSchema,
  InstitutionSchema,
  MetaSchema,
  ProfileSchema,
  RuleSchema,
  SettingsSchema,
  TransactionSchema,
  type Account,
  type BalanceSnapshot,
  type Category,
  type CsvProfile,
  type Figure,
  type Goal,
  type HoldingsSnapshot,
  type ImportRecord,
  type Institution,
  type Meta,
  type Profile,
  type Rule,
  type Settings,
  type Transaction,
} from '../shared/schema';
import { atomicWrite, Mutex, nowISO, readTextIfExists, sha256 } from './fsutil';

/** Bump when the on-disk format changes, and add a migration in migrations.ts. */
export const FORMAT_VERSION = 1;

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
  detail?: string | undefined;
  result?: ImportRecord['result'];
  path: string;
}

export interface ChangeEvent {
  /** Short human description, used as the git commit message line. */
  message: string;
  /** Paths (relative to the data dir) that were written. */
  paths: string[];
}

const ARRAY_FILES = {
  institutions: { file: 'institutions.json', key: 'institutions', schema: InstitutionSchema },
  accounts: { file: 'accounts.json', key: 'accounts', schema: AccountSchema },
  categories: { file: 'categories.json', key: 'categories', schema: CategorySchema },
  rules: { file: 'rules.json', key: 'rules', schema: RuleSchema },
  goals: { file: 'goals.json', key: 'goals', schema: GoalSchema },
  csvProfiles: { file: 'csv-profiles.json', key: 'profiles', schema: CsvProfileSchema },
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
  csvProfiles: CsvProfile[];
  transactions: Map<string, Transaction[]>;
  balances: Map<string, BalanceSnapshot[]>;
  holdings: Map<string, HoldingsSnapshot[]>;
  figures: Figure[];
  imports: ImportSummary[];
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
    csvProfiles: [],
    transactions: new Map(),
    balances: new Map(),
    holdings: new Map(),
    figures: [],
    imports: [],
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
      ['csv-profiles.json', { $schema: '../schemas/csv-profiles.schema.json', profiles: [] }],
    ];
    for (const [rel, value] of writes) await this.writeJson(rel, value);
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

    // Referential checks (warnings only).
    const accountIds = new Set(next.accounts.map((a) => a.id));
    for (const id of next.transactions.keys()) {
      if (!accountIds.has(id)) issues.push({ file: `transactions/${id}`, severity: 'warning', message: `Transactions for unknown account "${id}"` });
    }
    for (const id of next.balances.keys()) {
      if (!accountIds.has(id)) issues.push({ file: `balances/${id}.jsonl`, severity: 'warning', message: `Balances for unknown account "${id}"` });
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

  private changed(message: string, paths: string[]): void {
    this.version++;
    this.emit('change', { message, paths } satisfies ChangeEvent);
  }

  /** Run a mutation exclusively. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
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
  get institutions(): Institution[] {
    return this.state.institutions;
  }
  get accounts(): Account[] {
    return this.state.accounts;
  }
  get categories(): Category[] {
    return this.state.categories;
  }
  get rules(): Rule[] {
    return this.state.rules;
  }
  get goals(): Goal[] {
    return this.state.goals;
  }
  get csvProfiles(): CsvProfile[] {
    return this.state.csvProfiles;
  }
  get figures(): Figure[] {
    return this.state.figures;
  }
  get imports(): ImportSummary[] {
    return this.state.imports;
  }

  account(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  institution(id: string | undefined): Institution | undefined {
    return id ? this.state.institutions.find((i) => i.id === id) : undefined;
  }

  transaction(id: string): Transaction | undefined {
    return this.txById.get(id);
  }

  /** Transactions for one account (sorted by date), or all transactions. */
  transactions(accountId?: string): Transaction[] {
    if (accountId) return this.state.transactions.get(accountId) ?? [];
    const all: Transaction[] = [];
    for (const list of this.state.transactions.values()) all.push(...list);
    return sortByDate(all);
  }

  transactionCount(): number {
    return this.txById.size;
  }

  balances(accountId?: string): BalanceSnapshot[] {
    if (accountId) return this.state.balances.get(accountId) ?? [];
    return sortByDate([...this.state.balances.values()].flat());
  }

  holdings(accountId?: string): HoldingsSnapshot[] {
    if (accountId) return this.state.holdings.get(accountId) ?? [];
    return sortByDate([...this.state.holdings.values()].flat());
  }

  async readImport(id: string): Promise<ImportRecord | undefined> {
    const summary = this.state.imports.find((i) => i.id === id);
    if (!summary) return undefined;
    const text = await readTextIfExists(this.abs(summary.path));
    if (!text) return undefined;
    return ImportRecordSchema.parse(JSON.parse(text));
  }

  // ─── Writes: settings-like files ────────────────────────────────────────────────────────────

  setProfile(profile: Profile): Promise<void> {
    return this.exclusive(async () => {
      const p = ProfileSchema.parse(profile);
      await this.writeJson('profile.json', p);
      this.state.profile = p;
      this.changed('profile: update', ['profile.json']);
    });
  }

  setSettings(settings: Settings): Promise<void> {
    return this.exclusive(async () => {
      const s = SettingsSchema.parse(settings);
      await this.writeJson('settings.json', s);
      this.state.settings = s;
      await this.applyDocumentTracking();
      this.changed('settings: update', ['settings.json']);
    });
  }

  setMeta(meta: Meta): Promise<void> {
    return this.exclusive(async () => {
      const m = MetaSchema.parse(meta);
      await this.writeJson('meta.json', m);
      this.state.meta = m;
      this.changed(`data: format v${m.version}`, ['meta.json']);
    });
  }

  /** When documents are not tracked, a .gitignore inside documents/ keeps them out of git. */
  private async applyDocumentTracking(): Promise<void> {
    const ignore = 'documents/.gitignore';
    if (this.state.settings.git.trackDocuments) await rm(this.abs(ignore), { force: true });
    else await this.writeText(ignore, '*\n!.gitignore\n!.gitkeep\n');
  }

  private setArray<K extends keyof typeof ARRAY_FILES>(name: K, items: State[K], message: string): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.writeArrayFile(name, items);
      const def = ARRAY_FILES[name];
      (this.state as unknown as Record<string, unknown>)[name] = (items as unknown[]).map((i) => (def.schema as z.ZodType<unknown>).parse(i));
      this.changed(message, [file]);
    });
  }

  setCategories(list: Category[], message = 'categories: update'): Promise<void> {
    return this.setArray('categories', list, message);
  }
  setRules(list: Rule[], message = 'rules: update'): Promise<void> {
    return this.setArray('rules', list, message);
  }
  setGoals(list: Goal[], message = 'goals: update'): Promise<void> {
    return this.setArray('goals', list, message);
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

  async upsertInstitution(inst: Institution): Promise<void> {
    const list = this.state.institutions.filter((i) => i.id !== inst.id);
    list.push(inst);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.setInstitutions(list, `institutions: ${inst.name}`);
  }

  async upsertAccount(account: Account): Promise<void> {
    const existing = this.state.accounts.findIndex((a) => a.id === account.id);
    const list = [...this.state.accounts];
    if (existing >= 0) list[existing] = { ...account, updatedAt: nowISO() };
    else list.push(account);
    await this.setAccounts(list, `${existing >= 0 ? 'account: update' : 'account: add'} ${account.name}`);
  }

  hasAccountData(accountId: string): boolean {
    return (
      (this.state.transactions.get(accountId)?.length ?? 0) > 0 ||
      (this.state.balances.get(accountId)?.length ?? 0) > 0 ||
      (this.state.holdings.get(accountId)?.length ?? 0) > 0
    );
  }

  async deleteAccount(accountId: string): Promise<void> {
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
      for (const raw of txs) {
        const t = TransactionSchema.parse(raw);
        if (this.txById.has(t.id)) continue;
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
      if (added) this.changed(message, paths);
      return added;
    });
  }

  /** Apply patches to existing transactions (enrichment or corrections). */
  updateTransactions(updates: { id: string; patch: Partial<Transaction> }[], message: string): Promise<Transaction[]> {
    return this.exclusive(async () => {
      const touched = new Map<string, Set<string>>();
      const out: Transaction[] = [];
      const stamp = nowISO();
      for (const { id, patch } of updates) {
        const current = this.txById.get(id);
        if (!current) throw new StoreError(`Unknown transaction ${id}`, 404);
        const { id: _i, accountId: _a, ...rest } = patch;
        const merged: Record<string, unknown> = { ...current, ...rest, updatedAt: stamp };
        // `undefined` in a patch means "clear this field".
        for (const [k, v] of Object.entries(rest)) if (v === undefined) delete merged[k];
        const next = TransactionSchema.parse(merged);
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
      if (out.length) this.changed(message, paths);
      return out;
    });
  }

  deleteTransactions(ids: string[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Map<string, Set<string>>();
      let removed = 0;
      for (const id of ids) {
        const t = this.txById.get(id);
        if (!t) continue;
        const list = this.state.transactions.get(t.accountId)!;
        list.splice(list.indexOf(t), 1);
        this.txById.delete(id);
        (touched.get(t.accountId) ?? touched.set(t.accountId, new Set()).get(t.accountId)!).add(t.date.slice(0, 4));
        removed++;
      }
      const paths: string[] = [];
      for (const [accountId, years] of touched) paths.push(...(await this.writeTransactionYears(accountId, years)));
      if (removed) this.changed(message, paths);
      return removed;
    });
  }

  // ─── Writes: balances, holdings, figures ─────────────────────────────────────────────────────

  addBalances(snaps: BalanceSnapshot[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Set<string>();
      let added = 0;
      for (const raw of snaps) {
        const s = BalanceSnapshotSchema.parse(raw);
        const list = this.state.balances.get(s.accountId) ?? [];
        if (list.some((b) => b.id === s.id)) continue;
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
      if (added) this.changed(message, paths);
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
        list[i] = next;
        this.state.balances.set(accountId, sortByDate(list));
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, this.state.balances.get(accountId)!);
        this.changed(message, [rel]);
        return next;
      }
      throw new StoreError(`Unknown balance ${id}`, 404);
    });
  }

  deleteBalance(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      for (const [accountId, list] of this.state.balances) {
        const i = list.findIndex((b) => b.id === id);
        if (i < 0) continue;
        list.splice(i, 1);
        const rel = `balances/${accountId}.jsonl`;
        await this.writeJsonl(rel, list);
        this.changed(message, [rel]);
        return;
      }
      throw new StoreError(`Unknown balance ${id}`, 404);
    });
  }

  addHoldings(snaps: HoldingsSnapshot[], message: string): Promise<number> {
    return this.exclusive(async () => {
      const touched = new Set<string>();
      let added = 0;
      for (const raw of snaps) {
        const s = HoldingsSnapshotSchema.parse(raw);
        const list = this.state.holdings.get(s.accountId) ?? [];
        if (list.some((h) => h.id === s.id)) continue;
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
      if (added) this.changed(message, paths);
      return added;
    });
  }

  deleteHoldings(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      for (const [accountId, list] of this.state.holdings) {
        const i = list.findIndex((h) => h.id === id);
        if (i < 0) continue;
        list.splice(i, 1);
        const rel = `holdings/${accountId}.jsonl`;
        await this.writeJsonl(rel, list);
        this.changed(message, [rel]);
        return;
      }
      throw new StoreError(`Unknown holdings snapshot ${id}`, 404);
    });
  }

  addFigures(figs: Figure[], message: string): Promise<number> {
    return this.exclusive(async () => {
      let added = 0;
      for (const raw of figs) {
        const f = FigureSchema.parse(raw);
        if (this.state.figures.some((x) => x.id === f.id)) continue;
        this.state.figures.push(f);
        added++;
      }
      if (added) {
        const key = (f: Figure) => f.periodEnd ?? f.date ?? f.periodStart ?? '';
        this.state.figures.sort((a, b) => key(a).localeCompare(key(b)));
        await this.writeJsonl('figures.jsonl', this.state.figures);
        this.changed(message, ['figures.jsonl']);
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
      this.state.figures[i] = next;
      await this.writeJsonl('figures.jsonl', this.state.figures);
      this.changed(message, ['figures.jsonl']);
      return next;
    });
  }

  deleteFigure(id: string, message: string): Promise<void> {
    return this.exclusive(async () => {
      const before = this.state.figures.length;
      this.state.figures = this.state.figures.filter((f) => f.id !== id);
      if (this.state.figures.length === before) throw new StoreError(`Unknown figure ${id}`, 404);
      await this.writeJsonl('figures.jsonl', this.state.figures);
      this.changed(message, ['figures.jsonl']);
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
      this.state.imports = [summarise(r, rel), ...this.state.imports.filter((i) => i.id !== r.id)];
      this.changed(message, [rel, ...extraPaths]);
    });
  }
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function summarise(r: ImportRecord, rel: string): ImportSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    committedAt: r.committedAt,
    fileName: r.document.fileName,
    mediaType: r.document.mediaType,
    documentId: r.document.id,
    documentPath: r.document.path,
    engine: r.extraction.engine,
    detail: r.extraction.detail,
    result: r.result,
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
