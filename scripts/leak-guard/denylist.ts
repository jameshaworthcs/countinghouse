// The leak guard's private denylist: values from your own data directory that must never appear in
// code, tests, docs or commit messages. Built on demand and cached outside every repository
// (~/.cache/finance/leak-denylist.json, 0600). Nothing here prints a value.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenKey } from './text.ts';

/** Bump when the build changes what it collects, so caches are rebuilt. */
const BUILDER_VERSION = 6;

export interface Denylist {
  version: number;
  key: string;
  dataDir: string;
  builtAt: string;
  /** [token key, category] */
  tokens: [string, string][];
  /** Absolute amounts as `pounds.pence`. */
  amounts: string[];
  last4: string[];
  /** Holding units with three or more decimals, trailing zeros removed. */
  units: string[];
}

export interface Extras {
  tokens: { key: string; head: boolean }[];
  patterns: { re: RegExp; head: boolean }[];
}

const ROOT = path.resolve(import.meta.dirname, '../..');
export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'finance');
export const cacheFile = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'finance', 'leak-denylist.json');
export const extrasFile = () => path.join(configDir(), 'leak-extra.txt');

/** Where the data is: --data, then `dataDir` in ~/.config/finance/leak-guard.json, then FINANCE_DATA_DIR. */
export function resolveDataDir(option?: string): string | undefined {
  if (option) return path.resolve(option);
  const config = path.join(configDir(), 'leak-guard.json');
  if (existsSync(config)) {
    const dir = (JSON.parse(readFileSync(config, 'utf8')) as { dataDir?: string }).dataDir;
    if (dir) return path.resolve(dir.replace(/^~(?=\/)/, os.homedir()));
  }
  return process.env.FINANCE_DATA_DIR ? path.resolve(process.env.FINANCE_DATA_DIR) : undefined;
}

// ─── Reading the data ────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : []);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readJsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line that does not parse is skipped; npm run validate reports it.
    }
  }
  return out;
}

function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, filter));
    else if (entry.isFile() && filter(entry.name)) out.push(full);
  }
  return out;
}

const list = (data: unknown, key: string): Json[] => (isObject(data) && Array.isArray(data[key]) ? data[key].filter(isObject) : []);

/** Every object in a JSON value, depth first. */
function* objects(v: unknown): Generator<Json> {
  if (Array.isArray(v)) for (const x of v) yield* objects(x);
  else if (isObject(v)) {
    yield v;
    for (const x of Object.values(v)) yield* objects(x);
  }
}

// ─── What counts as generic ──────────────────────────────────────────────────────────────────────

/** Words that say what kind of account, product or payment something is, not whose. */
const GENERIC_WORDS = new Set(
  (
    'a an and the of for to from in on at by with my your our new old main joint sole ' +
    'account accounts current saver savings saving save easy access instant notice fixed rate rates bond bonds term ' +
    'isa isas lisa jisa sipp ssas pension pensions workplace personal stakeholder retirement drawdown annuity ' +
    'card cards credit debit charge loan loans student finance mortgage overdraft cash stocks shares share investment investments ' +
    'investing trading general premium plan plans money purchase reward rewards club plus premier select classic gold platinum ' +
    'black blue green cashback everyday regular monthly weekly annual year years month months day days interest bonus ' +
    'business company limited ltd plc llp inc group holdings uk gb england bank banking building society direct online app ' +
    'payment payments transfer transfers deposit deposits withdrawal withdrawals refund refunds fee fees salary pay wages ' +
    'rent bills bill utilities groceries shopping transport travel holiday holidays gift gifts pot pots space spaces vault ' +
    'balance balances statement wallet tax income allowance dividend dividends maintenance tuition grant award state ' +
    'government national insurance ni hmrc paye employer employee contribution contributions top up ' +
    'visa mastercard amex contactless apple google pay standing order direct debit faster fpi fpo bacs chaps atm ' +
    'giro cheque cheques paid received sent incoming outgoing transaction transactions adjustment reversal counter ' +
    'branch post office cashback'
  ).split(/\s+/),
);

/** Words of names this code base already makes public: the institution catalogue and the merchant list. */
async function publicVocabulary(): Promise<{ words: Set<string>; names: Set<string>; merchantPatterns: RegExp[] }> {
  const words = new Set(GENERIC_WORDS);
  const names = new Set<string>();
  const merchantPatterns: RegExp[] = [];
  const { INSTITUTION_CATALOG } = await import('../../src/shared/institutions.ts');
  const { MERCHANTS } = await import('../../src/shared/merchants.ts');
  for (const i of INSTITUTION_CATALOG) {
    names.add(tokenKey(i.name));
    for (const w of tokenKey(i.name).split(/[^\p{L}\p{N}]+/u)) if (w) words.add(w);
    merchantPatterns.push(new RegExp(i.match, 'i'));
  }
  for (const [pattern, payee] of MERCHANTS) {
    names.add(tokenKey(payee));
    for (const w of tokenKey(payee).split(/[^\p{L}\p{N}]+/u)) if (w) words.add(w);
    merchantPatterns.push(new RegExp(pattern, 'i'));
  }
  return { words, names, merchantPatterns };
}

/** A name made only of generic and public words (and small numbers or years): "Chase Saver". */
function genericName(key: string, words: Set<string>, dictionary?: Set<string>): boolean {
  const parts = key.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // An initial ("J Smith") makes it a person's name, whatever words follow.
  if (dictionary && parts.some((w) => /^\p{L}$/u.test(w) && w !== 'a' && w !== 'i')) dictionary = undefined;
  return parts.every((w) => words.has(w) || dictionary?.has(w) || /^\d{1,2}$/.test(w) || /^(19|20)\d{2}$/.test(w));
}

const DICTIONARY_FILES = ['/usr/share/dict/british-english', '/usr/share/dict/words'];

/**
 * The system word list's common words (lower-case entries only: capitalised ones are names). Payees,
 * descriptions and places made only of these ("Cheque paid in") are bank wording, not anyone's. No
 * list, no filter: more matches, never fewer.
 */
function commonWords(): Set<string> | undefined {
  const words = new Set<string>();
  for (const file of DICTIONARY_FILES) {
    try {
      for (const w of readFileSync(file, 'utf8').split('\n')) if (w && w === w.toLowerCase()) words.add(w.replace(/'s$/, ''));
    } catch {
      // Not installed.
    }
  }
  return words.size ? words : undefined;
}

/** The given names src/shared/people.ts knows (read as text: that module needs the bundler's imports). */
function givenNames(): Set<string> {
  try {
    const text = readFileSync(path.join(ROOT, 'src/shared/people.ts'), 'utf8');
    const start = text.indexOf('const FIRST_NAMES');
    const block = text.slice(start, text.indexOf(').split(', start));
    return new Set([...block.matchAll(/'([^']*)'/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean));
  } catch {
    return new Set();
  }
}

// ─── Amounts ─────────────────────────────────────────────────────────────────────────────────────

/** Fields that hold money (MoneySchema in src/shared/schema.ts) and a payslip's year-to-date keys. */
const MONEY_KEYS = new Set(
  (
    'amount amountMax amountMin annual annualAmount annualIncome availableBalance balance balanceAfter bonusToDate cash ' +
    'cashBalance closingBalance contributions contributionsToDate costBasis creditLimit deductions difference ' +
    'estimatedPay fee gain gainLoss governmentBonusToDate grossSalary leavingPay limit minimumPayment moneyIn moneyOut ' +
    'monthly net netAssets ni nonTaxable openingBalance originalAmount outstanding payments pension propertyPrice rate ' +
    'readBalance statedMoneyIn statedMoneyOut targetAmount tax taxable taxablePay taxYearContributions total totalValue ' +
    'value voluntaryCost weekly gross niEmployer niablePay pensionEmployer studentLoan ssp smp taxCredit'
  ).split(/\s+/),
);

/** £100 or more with pence, or £1,000 or more in whole pounds that is neither round (a multiple of £50) nor a year. */
export function distinctiveAmount(n: number): string | undefined {
  const pence = Math.round(Math.abs(n) * 100);
  if (!Number.isFinite(pence)) return undefined;
  const pounds = Math.floor(pence / 100);
  const rest = pence % 100;
  if (rest) return pounds >= 100 ? `${pounds}.${String(rest).padStart(2, '0')}` : undefined;
  if (pounds < 1000 || pounds % 50 === 0 || (pounds >= 1900 && pounds <= 2100)) return undefined;
  return `${pounds}.00`;
}

/**
 * Amounts the UK rules make public (src/shared/uk.ts, docs/UK_RULES.md): a personal allowance or a
 * full State Pension in your data is everyone's figure, not yours.
 */
function publicAmounts(): Set<string> {
  const out = new Set<string>();
  for (const f of ['src/shared/uk.ts', 'docs/UK_RULES.md']) {
    let text = '';
    try {
      text = readFileSync(path.join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\d[\d,_]*(?:\.\d{1,2})?/g)) {
      const a = distinctiveAmount(Number(m[0].replace(/[,_]/g, '')));
      if (a) out.add(a);
    }
  }
  return out;
}

function collectAmounts(value: unknown, into: Set<string>, units: Set<string>): void {
  for (const obj of objects(value)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && MONEY_KEYS.has(k)) {
        const a = distinctiveAmount(v);
        if (a) into.add(a);
      } else if (k === 'yearToDate' && isObject(v)) {
        for (const x of Object.values(v)) if (typeof x === 'number') {
          const a = distinctiveAmount(x);
          if (a) into.add(a);
        }
      } else if (k === 'units' && typeof v === 'number') {
        const s = String(Math.abs(v));
        if (/\.\d{3,}$/.test(s)) units.add(s.replace(/0+$/, ''));
      }
    }
  }
}

// ─── Building ────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [];
  const [, y, mm, dd] = m as unknown as [string, string, string, string];
  const d = String(Number(dd));
  const mo = String(Number(mm));
  const month = MONTHS[Number(mm) - 1]!;
  return [
    iso,
    `${dd}/${mm}/${y}`,
    `${d}/${mo}/${y}`,
    `${dd}-${mm}-${y}`,
    `${dd}.${mm}.${y}`,
    `${y}/${mm}/${dd}`,
    `${y}${mm}${dd}`,
    `${d} ${month} ${y}`,
    `${dd} ${month} ${y}`,
    `${d} ${month.slice(0, 3)} ${y}`,
    `${dd} ${month.slice(0, 3)} ${y}`,
    `${month} ${d}, ${y}`,
    `${month} ${d} ${y}`,
  ];
}

function payeVariants(ref: string): string[] {
  const m = /^\s*(\d{3})\s*\/\s*([A-Za-z0-9]+)\s*$/.exec(ref);
  if (!m) return [ref];
  const [, office, rest] = m as unknown as [string, string, string];
  return [`${office}/${rest}`, `${office} / ${rest}`, `${office} /${rest}`, `${office}/ ${rest}`, `${office}${rest}`, `${office} ${rest}`, ...(rest.length >= 6 ? [rest] : [])];
}

const IDENTIFIER_KEYS = /^(reference|customerNumber|policyNumber|membershipNumber|memberNumber|accountNumber|rollNumber|certificate|holderNumber|bondHolderNumber|utr|uniqueTaxpayerReference|employeeNumber|worksNumber|payrollNumber|payerReference|payeReference|contractNumber|agreementNumber|bookingReference)$/;
const AGREEMENT_DETAIL_LABELS = /address|flat|room|block|street|property|landlord|tenant|guarantor|reference|number|name|postcode|contact|phone|email|resident/i;

/**
 * How many times a payee may appear and still count as rare. Every payee that is not a public name
 * is denylisted; a rare one's descriptions and references are too.
 */
export const RARE_PAYEE = 3;

export interface BuildStats {
  [category: string]: number;
}

export async function buildDenylist(dataDir: string): Promise<{ denylist: Denylist; stats: BuildStats }> {
  const { words, names: publicNameSet, merchantPatterns } = await publicVocabulary();
  const file = (name: string) => path.join(dataDir, name);
  const dictionary = commonWords();
  const tokens = new Map<string, string>();
  const stats: BuildStats = {};
  /** `generic`: false keeps it whatever it is; `words` also drops it when it is only common words. */
  const add = (category: string, value: string | undefined, opts: { min?: number; generic?: false | 'names' | 'words' } = {}) => {
    if (!value) return;
    const key = tokenKey(value);
    if (key.length < (opts.min ?? 4) || tokens.has(key)) return;
    const generic = opts.generic ?? 'names';
    if (generic && (genericName(key, words, generic === 'words' ? dictionary : undefined) || publicNameSet.has(key))) return;
    tokens.set(key, category);
    stats[category] = (stats[category] ?? 0) + 1;
  };
  // An employer's or company's own word ("Quillfeather" of "Quillfeather Analytics Ltd") names it on its own too,
  // unless it is a given name, a common word, a public name or a town (a city is allowed to show).
  const given = givenNames();
  const txs: Json[] = [];
  for (const f of listFiles(file('transactions'), (n) => n.endsWith('.jsonl'))) txs.push(...readJsonl(f).filter(isObject));
  const towns = new Set(txs.flatMap((t) => (isObject(t.merchant) && str(t.merchant.city) ? tokenKey(str(t.merchant.city)!).split(/[^\p{L}\p{N}]+/u) : [])));
  const addWords = (category: string, value: string | undefined) => {
    for (const w of tokenKey(value ?? '').split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 4 && !/\d/.test(w) && !words.has(w) && !given.has(w) && !dictionary?.has(w) && !towns.has(w)) add(category, w, { generic: false });
    }
  };
  const addIdentifier = (value: string | undefined) => {
    if (value && /\d/.test(value) && value.replace(/\W/g, '').length >= 5) add('identifier', value, { min: 5, generic: false });
  };

  // You.
  const profile = readJson(file('profile.json'));
  if (isObject(profile)) {
    const name = str(profile.name);
    if (name) {
      add('owner-name', name, { generic: false });
      const parts = name.split(/\s+/);
      if (parts.length > 1) add('owner-name', parts[parts.length - 1], { generic: false });
    }
    const dob = str(profile.dateOfBirth);
    if (dob) for (const v of dateVariants(dob)) add('date-of-birth', v, { min: 6, generic: false });
    for (const e of Array.isArray(profile.employers) ? profile.employers.filter(isObject) : []) add('employer', str(e.name));
  }

  // People, accounts, jobs, companies, agreements.
  for (const p of list(readJson(file('people.json')), 'people')) {
    add('person', str(p.name), { generic: false });
    for (const n of strings(p.names)) add('person', n, { generic: false });
  }
  const last4 = new Set<string>();
  for (const a of list(readJson(file('accounts.json')), 'accounts')) {
    add('account', str(a.name));
    for (const n of strings(a.aliases)) add('account', n);
    const l4 = str(a.last4);
    if (l4) last4.add(l4);
    if (isObject(a.pension)) add('employer', str(a.pension.employer));
    for (const o of objects(a.attributes)) for (const [k, v] of Object.entries(o)) if (IDENTIFIER_KEYS.test(k)) addIdentifier(str(v));
  }
  for (const e of list(readJson(file('employments.json')), 'employments')) {
    add('employer', str(e.employer));
    addWords('employer', str(e.employer));
    for (const n of strings(e.aliases)) {
      add('employer', n);
      addWords('employer', n);
    }
    const paye = str(e.payeReference);
    if (paye) for (const v of payeVariants(paye)) add('paye-reference', v, { min: 5, generic: false });
    for (const n of strings(e.payrollNumbers)) if (n.length >= 5 || (n.length >= 4 && /[a-z]/i.test(n))) add('payroll-number', n, { min: 4, generic: false });
  }
  for (const c of list(readJson(file('companies.json')), 'companies')) {
    add('company', str(c.name));
    addWords('company', str(c.name));
    add('company-number', str(c.number), { generic: false });
    for (const h of Array.isArray(c.holdings) ? c.holdings.filter(isObject) : []) addIdentifier(str(h.certificate));
  }
  for (const a of list(readJson(file('agreements.json')), 'agreements')) {
    add('agreement', str(a.name));
    add('agreement', str(a.counterparty));
    add('agreement', str(a.paidBy));
    for (const n of strings(a.names)) add('agreement', n);
    addIdentifier(str(a.reference));
    for (const d of Array.isArray(a.details) ? a.details.filter(isObject) : []) {
      if (AGREEMENT_DETAIL_LABELS.test(str(d.label) ?? '')) add('agreement', str(d.value));
    }
  }

  // Payslips, figures and HMRC's records: employers, references and payroll numbers.
  for (const p of readJsonl(file('payslips.jsonl')).filter(isObject)) {
    add('employer', str(p.employer));
    for (const n of strings(p.otherNames)) add('employer', n);
    const n = str(p.payrollNumber);
    if (n && (n.length >= 5 || (n.length >= 4 && /[a-z]/i.test(n)))) add('payroll-number', n, { min: 4, generic: false });
  }
  for (const f of readJsonl(file('figures.jsonl')).filter(isObject)) {
    if (f.employmentId || /pay|pension|national_insurance|tax_deducted|student_loan/.test(String(f.kind))) add('employer', str(f.payer));
    add('employer', str(f.paidBy));
    const ref = str(f.payerReference);
    if (ref && /^\d{3}\s*\//.test(ref)) for (const v of payeVariants(ref)) add('paye-reference', v, { min: 5, generic: false });
    else addIdentifier(ref);
  }
  for (const o of objects(readJsonl(file('hmrc.jsonl')))) {
    for (const [k, v] of Object.entries(o)) {
      if (/^employer(Name)?$/.test(k)) add('employer', str(v));
      else if (/payeReference|employerReference/.test(k)) for (const x of payeVariants(str(v) ?? '')) add('paye-reference', x, { min: 5, generic: false });
    }
  }

  // Transactions: payees no one would call a chain, and what their rows said.
  const isPublic = (s: string) => publicNameSet.has(tokenKey(s)) || merchantPatterns.some((re) => re.test(s));
  const counts = new Map<string, number>();
  const payeeOf = (t: Json) => tokenKey(str(t.payee) ?? str(t.counterpartyName) ?? str(t.description) ?? '');
  for (const t of txs) counts.set(payeeOf(t), (counts.get(payeeOf(t)) ?? 0) + 1);
  for (const t of txs) {
    const l4 = str(t.cardLast4);
    if (l4) last4.add(l4);
    const payee = str(t.payee);
    const description = str(t.description);
    const named = payee ?? str(t.counterpartyName) ?? description;
    if (!named || isPublic(named)) continue;
    add('payee', payee, { generic: 'words' });
    add('payee', str(t.counterpartyName), { generic: 'words' });
    if (isObject(t.merchant)) {
      add('payee', str(t.merchant.name), { generic: 'words' });
      add('place', str(t.merchant.address), { min: 6, generic: 'words' });
      add('place', str(t.merchant.postcode), { min: 5, generic: false });
    }
    add('place', str(t.place), { min: 6, generic: 'words' });
    // A one-off payment's own words are as telling as its payee: they are what a test copies.
    if ((counts.get(payeeOf(t)) ?? 0) <= RARE_PAYEE) {
      if (description && description.length >= 10) add('description', description, { generic: 'words' });
      const ref = str(t.reference);
      if (ref && ref.length >= 6) add('identifier', ref, { min: 6, generic: 'words' });
    }
  }

  // Amounts, units and the rest of the identifiers, from every record that holds them.
  const amounts = new Set<string>();
  const units = new Set<string>();
  collectAmounts(txs, amounts, units);
  for (const name of ['payslips.jsonl', 'figures.jsonl', 'hmrc.jsonl', 'terms.jsonl']) collectAmounts(readJsonl(file(name)), amounts, units);
  for (const name of ['profile.json', 'agreements.json', 'companies.json', 'employments.json', 'goals.json', 'budgets.json', 'coverage.json', 'accounts.json']) {
    collectAmounts(readJson(file(name)), amounts, units);
  }
  for (const dir of ['balances', 'holdings']) for (const f of listFiles(file(dir), (n) => n.endsWith('.jsonl'))) collectAmounts(readJsonl(f), amounts, units);
  for (const dir of ['imports', 'proposals']) for (const f of listFiles(file(dir), (n) => n.endsWith('.json'))) collectAmounts(readJson(f), amounts, units);
  for (const a of publicAmounts()) amounts.delete(a);
  stats.amount = amounts.size;
  stats.last4 = last4.size;
  stats.units = units.size;

  const denylist: Denylist = {
    version: BUILDER_VERSION,
    key: denylistKey(dataDir),
    dataDir,
    builtAt: new Date().toISOString(),
    tokens: [...tokens],
    amounts: [...amounts],
    last4: [...last4],
    units: [...units],
  };
  return { denylist, stats };
}

// ─── Cache ───────────────────────────────────────────────────────────────────────────────────────

/** Changes whenever a file in the data directory (other than the stored documents) or the public lists change. */
export function denylistKey(dataDir: string): string {
  const hash = createHash('sha256').update(`v${BUILDER_VERSION}\0${dataDir}\0`);
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (full !== path.join(dataDir, 'documents') && e.name !== '.git') walk(full);
      } else if (e.isFile()) {
        const s = statSync(full);
        hash.update(`${path.relative(dataDir, full)}\0${s.size}\0${s.mtimeMs}\n`);
      }
    }
  };
  walk(dataDir);
  // The public lists by content (every worktree has its own copies), the dictionaries by date.
  for (const f of ['src/shared/merchants.ts', 'src/shared/institutions.ts', 'src/shared/uk.ts', 'src/shared/people.ts', 'docs/UK_RULES.md']) {
    try {
      hash.update(`${f}\0`).update(readFileSync(path.join(ROOT, f))).update('\n');
    } catch {
      // Missing: the vocabulary is smaller, and the key says so.
    }
  }
  for (const f of DICTIONARY_FILES) {
    try {
      const s = statSync(f);
      hash.update(`${f}\0${s.size}\0${s.mtimeMs}\n`);
    } catch {
      // Not installed.
    }
  }
  return hash.digest('hex');
}

function insideRepository(dir: string): boolean {
  let probe = dir;
  while (!existsSync(probe)) probe = path.dirname(probe);
  // A git hook runs with GIT_DIR and friends set, which would make every directory look inside it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  try {
    return execFileSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

export function writeCache(denylist: Denylist, file = cacheFile()): void {
  const dir = path.dirname(file);
  if (insideRepository(dir)) throw new Error(`refusing to write the denylist inside a git repository (${dir})`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(denylist), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function readCache(dataDir: string, file = cacheFile()): Denylist | undefined {
  if (!existsSync(file)) return undefined;
  const cached = readJson(file) as Denylist | undefined;
  if (!cached || cached.version !== BUILDER_VERSION || cached.dataDir !== dataDir || cached.key !== denylistKey(dataDir)) return undefined;
  return cached;
}

/** The cached denylist for this data directory, rebuilt when the data has changed. */
export async function loadDenylist(dataDir: string, opts: { rebuild?: boolean; cache?: boolean } = {}): Promise<{ denylist: Denylist; built: boolean; stats?: BuildStats }> {
  const cache = opts.cache !== false;
  if (cache && !opts.rebuild) {
    const cached = readCache(dataDir);
    if (cached) return { denylist: cached, built: false };
  }
  const { denylist, stats } = await buildDenylist(dataDir);
  if (cache) writeCache(denylist);
  return { denylist, built: true, stats };
}

// ─── Extras ──────────────────────────────────────────────────────────────────────────────────────

/**
 * ~/.config/finance/leak-extra.txt: one token per line, `#` for comments, `re:` before a regular
 * expression (matched against lower-cased text). `head:` before either flags it everywhere except a
 * --history scan: for names that are fine in old commits but must not come back.
 */
export function parseExtras(text: string): Extras {
  const extras: Extras = { tokens: [], patterns: [] };
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.startsWith('head:');
    if (head) line = line.slice(5).trim();
    if (line.startsWith('re:')) extras.patterns.push({ re: new RegExp(line.slice(3), 'gu'), head });
    else extras.tokens.push({ key: tokenKey(line), head });
  }
  return extras;
}

export function loadExtras(file = extrasFile()): Extras {
  return existsSync(file) ? parseExtras(readFileSync(file, 'utf8')) : { tokens: [], patterns: [] };
}
