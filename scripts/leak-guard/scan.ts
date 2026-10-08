// The leak guard's scanner: finds denylisted values, extras and built-in patterns in text, and
// reports each finding masked, so its output can go to a terminal, a CI log or a Claude transcript.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Denylist, Extras } from './denylist.ts';
import { scanPatterns } from './patterns.ts';
import { bounded, globToRegExp, lineAt, lineStarts, mask, normalise, tokenKey, trieSource } from './text.ts';

export interface Finding {
  /** A file path, or `commit <sha>` for a commit message or identity. */
  path: string;
  line: number;
  /** denylist, extra, pattern, file or identity. */
  category: string;
  rule: string;
  masked: string;
  /** sha256 of the whole line (without its newline): what a line map is keyed on. */
  lineKey?: string;
  /** Reported, but does not fail the scan. */
  warning?: boolean;
}

export const describe = (f: Finding) => `${f.path}${f.line ? `:${f.line}` : ''} [${f.category}/${f.rule}] ${f.masked}`;

// ─── The allowlist ───────────────────────────────────────────────────────────────────────────────

export const ALLOW_FILE = '.leakguard-allow';

interface AllowEntry {
  term: string;
  glob?: RegExp;
}

/**
 * .leakguard-allow: generic terms that collide with the denylist or a pattern, one per line, `#` for
 * comments. `path-glob:term` allows a term only in matching paths (the part before the first colon
 * has no spaces); write `**:term` for a term that itself has a colon early on.
 */
export class Allowlist {
  private readonly global = new Set<string>();
  private readonly scoped: AllowEntry[] = [];

  constructor(text = '') {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([^\s:]+):(.+)$/.exec(line);
      if (m) this.scoped.push({ term: tokenKey(m[2]!), glob: globToRegExp(m[1]!) });
      else this.global.add(tokenKey(line));
    }
  }

  static load(file: string): Allowlist {
    return new Allowlist(existsSync(file) ? readFileSync(file, 'utf8') : '');
  }

  /** Terms allowed everywhere: left out of the denylist before it is compiled. */
  get terms(): ReadonlySet<string> {
    return this.global;
  }

  allows(value: string, filePath: string): boolean {
    const key = tokenKey(value);
    if (this.global.has(key)) return true;
    // The allowlist may name its own terms.
    if (filePath === ALLOW_FILE) return this.scoped.some((e) => e.term === key);
    return this.scoped.some((e) => e.term === key && e.glob!.test(filePath));
  }
}

// ─── Scanning ────────────────────────────────────────────────────────────────────────────────────

/** An amount as written in text: optional sign and £, thousands separators, up to 2 decimals. */
const AMOUNT = /(?<![\p{L}\p{N}_.])-?£?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\p{L}\p{N}_]|[.,]\d)/gu;
const UNITS = /(?<![\p{L}\p{N}_.])\d+\.\d{3,}(?![\p{N}])/gu;
const PENCE = /(?<![\p{L}\p{N}_.])\d{6,}(?![\p{N}]|\.\d)/gu;
/** Where a last-4 is meant: within 24 characters after one of these. */
const LAST4_CONTEXT = /(?:ending(?:\s+in)?|last\s?4|last\s+four|\*{2,}|x{2,}|•+|account|card)([^\n]{0,24})/gu;

export interface ScannerOptions {
  denylist?: Denylist;
  extras?: Extras;
  allow?: Allowlist;
  /** A history scan: extras marked `head:` are left out. */
  history?: boolean;
  /** Also read integers of six or more digits as pence. */
  pence?: boolean;
  /** Add line keys to findings (for the history maps). */
  lineKeys?: boolean;
}

export class Scanner {
  private readonly tokenRe?: RegExp;
  private readonly categories = new Map<string, string>();
  private readonly extraRes: RegExp[];
  private readonly amounts: Set<string>;
  private readonly last4: Set<string>;
  private readonly units: Set<string>;
  private readonly allow: Allowlist;
  private readonly options: ScannerOptions;

  // No parameter properties: Node runs this file by stripping types, which cannot rewrite them.
  constructor(options: ScannerOptions = {}) {
    this.options = options;
    this.allow = options.allow ?? new Allowlist();
    const skip = this.allow.terms;
    for (const [key, category] of options.denylist?.tokens ?? []) if (!skip.has(key)) this.categories.set(key, `denylist/${category}`);
    for (const t of options.extras?.tokens ?? []) {
      if (options.history && t.head) continue;
      if (t.key && !this.categories.has(t.key)) this.categories.set(t.key, 'extra/token');
    }
    const source = trieSource(this.categories.keys());
    this.tokenRe = source ? new RegExp(bounded(source), 'gu') : undefined;
    this.extraRes = (options.extras?.patterns ?? []).filter((p) => !(options.history && p.head)).map((p) => p.re);
    this.amounts = new Set(options.denylist?.amounts ?? []);
    this.last4 = new Set(options.denylist?.last4 ?? []);
    this.units = new Set(options.denylist?.units ?? []);
  }

  /** Findings in a text that is the whole of a file, or a block of lines starting at `firstLine`. */
  scanText(filePath: string, text: string, firstLine = 1): Finding[] {
    const out: Finding[] = [];
    const nfkc = text.normalize('NFKC');
    const norm = normalise(text);
    const nfkcStarts = lineStarts(nfkc);
    const normStarts = lineStarts(norm);
    // Lower-casing rarely changes a length; when it has not, a match is masked in its own case.
    const sameLength = norm.length === nfkc.length;
    const push = (category: string, rule: string, value: string, starts: number[], index: number) => {
      if (this.allow.allows(value, filePath)) return;
      const shown = starts === normStarts && sameLength ? nfkc.slice(index, index + value.length) : value;
      out.push({ path: filePath, line: firstLine - 1 + lineAt(starts, index), category, rule, masked: mask(shown) });
    };

    if (this.tokenRe) {
      for (const m of norm.matchAll(this.tokenRe)) {
        const [category, rule] = (this.categories.get(m[0].replace(/\s+/g, ' ')) ?? 'denylist/token').split('/') as [string, string];
        push(category, rule, m[0], normStarts, m.index);
      }
    }
    for (const re of this.extraRes) {
      re.lastIndex = 0;
      for (const m of norm.matchAll(re)) if (m[0]) push('extra', 'pattern', m[0], normStarts, m.index);
    }
    if (this.amounts.size) {
      for (const m of norm.matchAll(AMOUNT)) {
        const pounds = m[1]!.replace(/,/g, '');
        const key = `${Number(pounds)}.${(m[2] ?? '').padEnd(2, '0')}`;
        if (this.amounts.has(key)) push('denylist', 'amount', m[0], normStarts, m.index);
      }
      if (this.options.pence) {
        for (const m of norm.matchAll(PENCE)) {
          const n = Number(m[0]);
          const key = `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
          if (this.amounts.has(key)) push('denylist', 'amount-pence', m[0], normStarts, m.index);
        }
      }
    }
    if (this.units.size) {
      for (const m of norm.matchAll(UNITS)) if (this.units.has(m[0].replace(/0+$/, ''))) push('denylist', 'units', m[0], normStarts, m.index);
    }
    if (this.last4.size) {
      for (const m of norm.matchAll(LAST4_CONTEXT)) {
        const windowStart = m.index + m[0].length - m[1]!.length;
        for (const d of m[1]!.matchAll(/(?<!\p{N})\p{N}{2,6}(?!\p{N})/gu)) {
          if (this.last4.has(d[0])) push('denylist', 'last4', d[0], normStarts, windowStart + d.index);
        }
      }
    }
    for (const hit of scanPatterns(nfkc)) push('pattern', hit.rule, hit.value, nfkcStarts, hit.index);

    // One finding per line and rule: a last-4 window can see the same digits twice.
    const seen = new Set<string>();
    const unique = out.filter((f) => {
      const k = `${f.line}\0${f.category}/${f.rule}\0${f.masked}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    if (this.options.lineKeys && unique.length) {
      const lines = text.split('\n');
      for (const f of unique) f.lineKey = sha256(lines[f.line - firstLine] ?? '');
    }
    return unique.sort((a, b) => a.line - b.line);
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
