// Data-format migrations.
//
// The data format is versioned (data/meta.json → "version"). When the format changes, bump
// FORMAT_VERSION in store.ts and add a migration below that upgrades files IN PLACE. Migrations run
// on the raw JSON before the store loads it, so they can read fields the new schema no longer has.
//
// This is what makes "future changes without re-ingestion" work:
//   - new derived fields  → recomputed from stored records (see enrich.ts), no migration needed;
//   - new source fields   → backfilled here from each transaction's `raw` row or from the full
//                           extraction kept in data/imports/, never by re-uploading documents;
//   - renamed/split fields → rewritten here, once, with a git commit recording the change.

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { today } from '../shared/dates';
import { atomicWrite, nowISO, shortHash } from './fsutil';
import { FORMAT_VERSION } from './store';

export interface MigrationContext {
  dataDir: string;
  /** Read a JSON file relative to the data dir (undefined if missing). */
  readJson(rel: string): Promise<unknown>;
  writeJson(rel: string, value: unknown): Promise<void>;
  /** Write a text file relative to the data dir. */
  writeText(rel: string, text: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** Rewrite every line of every JSONL file under `dir` with `fn` (return null to keep as-is). */
  mapJsonl(dir: string, fn: (record: Record<string, unknown>, file: string) => Record<string, unknown> | null): Promise<number>;
  log(message: string): void;
}

export interface Migration {
  /** Upgrades data from version `from` to `from + 1`. */
  from: number;
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}

/**
 * Registered migrations, oldest first. A backfill from raw rows would look like:
 *
 *   run: (ctx) => ctx.mapJsonl('transactions', (t) => {
 *     const raw = t.raw as Record<string, string> | undefined;
 *     return raw?.Time && !t.time ? { ...t, time: raw.Time } : null;
 *   }).then(() => undefined),
 */
export const MIGRATIONS: Migration[] = [
  {
    from: 1,
    description: 'Assumptions become data: profile.assumedRealReturn moves to assumptions.jsonl; add instruments, research, insights, context and notes',
    async run(ctx) {
      const profile = (await ctx.readJson('profile.json')) as Record<string, unknown> | undefined;
      if (profile && 'assumedRealReturn' in profile) {
        const real = profile.assumedRealReturn;
        delete profile.assumedRealReturn;
        await ctx.writeJson('profile.json', profile);
        // 4% was the default. A different value was the owner's choice, so it stays theirs, as a
        // global expected-return override (nominal, at the 2% inflation the old model implied).
        if (typeof real === 'number' && Math.abs(real - 0.04) > 1e-9) {
          const nominal = Math.round(((1 + real) * 1.02 - 1) * 10_000) / 10_000;
          const record = {
            id: `asm_${shortHash('asm', 'v2-migration', real)}`,
            key: 'return.expected',
            scope: { kind: 'global' },
            value: nominal,
            asOf: today(),
            source: 'Your profile setting before data format v2',
            evidence: [],
            basedOn: [],
            rationale: `Migrated from the profile's assumed real return of ${(real * 100).toFixed(1)}% a year, converted to a nominal return assuming 2% inflation.`,
            provenance: { setBy: 'owner' },
            status: 'active',
            createdAt: nowISO(),
          };
          const existing = (await ctx.exists('assumptions.jsonl')) ? await readFile(path.join(ctx.dataDir, 'assumptions.jsonl'), 'utf8') : '';
          await ctx.writeText('assumptions.jsonl', `${existing}${JSON.stringify(record)}\n`);
          ctx.log(`[migrate] kept your ${(real * 100).toFixed(1)}% real return as a global expected-return override`);
        }
      }
      for (const f of ['assumptions.jsonl', 'research.jsonl', 'insights.jsonl', 'context.jsonl', 'notes.jsonl']) {
        if (!(await ctx.exists(f))) await ctx.writeText(f, '');
      }
      if (!(await ctx.exists('instruments.json'))) await ctx.writeJson('instruments.json', { $schema: '../schemas/instruments.schema.json', instruments: [] });
    },
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export async function runMigrations(dataDir: string, log: (m: string) => void = console.log): Promise<MigrationResult | null> {
  const metaPath = path.join(dataDir, 'meta.json');
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null; // fresh data dir; the store initialises it at the current version
  }
  const from = typeof meta.version === 'number' ? meta.version : 1;
  if (from >= FORMAT_VERSION) return null;

  const ctx: MigrationContext = {
    dataDir,
    async readJson(rel) {
      try {
        return JSON.parse(await readFile(path.join(dataDir, rel), 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    async writeJson(rel, value) {
      await atomicWrite(path.join(dataDir, rel), `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeText(rel, text) {
      await atomicWrite(path.join(dataDir, rel), text);
    },
    async exists(rel) {
      try {
        await access(path.join(dataDir, rel));
        return true;
      } catch {
        return false;
      }
    },
    async mapJsonl(dir, fn) {
      let changed = 0;
      for await (const file of walk(path.join(dataDir, dir))) {
        if (!file.endsWith('.jsonl')) continue;
        const text = await readFile(file, 'utf8');
        let fileChanged = false;
        const lines = text.split('\n').map((line) => {
          if (!line.trim()) return line;
          try {
            const next = fn(JSON.parse(line) as Record<string, unknown>, path.relative(dataDir, file));
            if (next === null) return line;
            fileChanged = true;
            changed++;
            return JSON.stringify(next);
          } catch {
            return line;
          }
        });
        if (fileChanged) await atomicWrite(file, lines.join('\n'));
      }
      return changed;
    },
    log,
  };

  const applied: string[] = [];
  let version = from;
  while (version < FORMAT_VERSION) {
    const m = MIGRATIONS.find((x) => x.from === version);
    if (!m) throw new Error(`No migration registered from data format v${version}`);
    log(`[migrate] v${version} → v${version + 1}: ${m.description}`);
    await m.run(ctx);
    applied.push(m.description);
    version++;
    await ctx.writeJson('meta.json', { ...meta, version, migratedAt: nowISO() });
  }
  return { from, to: version, applied };
}
