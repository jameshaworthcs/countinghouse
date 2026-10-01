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
import { isNiNumber, withoutNiNumbers } from '../shared/privacy';
import { atomicWrite, nowISO, shortHash } from './fsutil';
import { figureId, hmrcId, payslipId, termsId } from './ids';
import { Employers, PAY_KINDS, payerKey } from './analytics/sources';
import { pdfText, readGovUkPage } from './ingest/govuk';
import { readPayslipPage } from './ingest/payslips';
import { EmploymentSchema, HmrcRecordSchema, PayslipRecordSchema, TermsSchema, type AccountType, type Employment, type PayslipRecord, type Terms } from '../shared/schema';
import { learnFromPayslip } from './employments';
import { sameTerms, termsOfReading } from '../shared/terms';
import { toMinor } from '../shared/money';
import { taxYearOf } from '../shared/uk';
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
  {
    from: 2,
    description: 'Balances say when on their day they were seen (at), and which imported figures you typed yourself (enteredBy)',
    async run(ctx) {
      // The committed imports the balances came from: their document, reading and reviewed draft.
      interface Rec {
        id?: string;
        document?: { capturedAt?: string };
        extraction?: { raw?: { accounts?: { closingBalance?: number | null }[] } };
        draft?: { sections?: { key: string; recordBalance?: boolean; balance?: number; balanceDate?: string }[] };
        result?: { sections?: { key: string; accountId: string }[] };
      }
      const imports = new Map<string, Rec>();
      for await (const file of walk(path.join(ctx.dataDir, 'imports'))) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(await readFile(file, 'utf8')) as Rec;
          if (rec.id) imports.set(rec.id, rec);
        } catch {
          // An unreadable record says nothing about its balances.
        }
      }
      const pence = (n: number) => Math.round(Math.abs(n) * 100);
      let timed = 0;
      let yours = 0;
      await ctx.mapJsonl('balances', (b) => {
        if (b.at || b.enteredBy || b.approximate || typeof b.date !== 'string' || typeof b.balance !== 'number') return null;
        const created = typeof b.createdAt === 'string' ? b.createdAt : '';
        let at: string | undefined;
        let byYou = false;
        const importId = (b.source as { importId?: string } | undefined)?.importId;
        const rec = importId ? imports.get(importId) : undefined;
        if (b.kind === 'manual') {
          // Your own balance, given for the day you gave it: as of then.
          if (created.slice(0, 10) === b.date) at = created;
        } else if (rec) {
          const keys = (rec.result?.sections ?? []).filter((s) => s.accountId === b.accountId).map((s) => s.key);
          const section = (rec.draft?.sections ?? []).find((s) => keys.includes(s.key) && s.recordBalance !== false && s.balanceDate === b.date && s.balance === b.balance);
          const reading = rec.extraction?.raw;
          if (section && reading) {
            // Not what the reader read (sign aside: the draft turns a balance owed negative): you typed it.
            const read = reading.accounts?.[Number(section.key.slice(1))]?.closingBalance;
            byYou = typeof read !== 'number' || pence(read) !== pence(b.balance);
          }
          const captured = rec.document?.capturedAt;
          if (byYou && created.slice(0, 10) === b.date) at = created;
          else if (b.kind === 'screenshot' && captured?.slice(0, 10) === b.date) at = captured;
        }
        if (!at && !byYou) return null;
        if (at) timed++;
        if (byYou) yours++;
        return { ...b, ...(at ? { at } : {}), ...(byYou ? { enteredBy: 'user' } : {}) };
      });
      ctx.log(`[migrate] ${timed} balance${timed === 1 ? '' : 's'} now say when on their day they were seen; ${yours} you typed yourself`);
    },
  },
  {
    from: 3,
    description: 'A pension forecast with no balance is kept as a figure (backfilled from the imports that dropped it); National Insurance numbers are taken out of figures and readings',
    async run(ctx) {
      interface Rec {
        id?: string;
        status?: string;
        committedAt?: string;
        document?: { id?: string };
        draft?: { sections?: { key: string; target?: { mode?: string }; recordBalance?: boolean; balance?: number; balanceDate?: string; annualIncome?: number; currency?: string }[] };
        result?: { sections?: { key: string; accountId: string }[] };
      }
      // 1. Forecasts: a committed section with income per year and no balance recorded nothing before.
      const figures = (await ctx.exists('figures.jsonl')) ? (await readFile(path.join(ctx.dataDir, 'figures.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()) : [];
      const have = new Set(figures.map((l) => (JSON.parse(l) as { id: string }).id));
      const added: string[] = [];
      for await (const file of walk(path.join(ctx.dataDir, 'imports'))) {
        if (!file.endsWith('.json')) continue;
        let rec: Rec;
        try {
          rec = JSON.parse(await readFile(file, 'utf8')) as Rec;
        } catch {
          continue;
        }
        if (rec.status !== 'committed' || !rec.id) continue;
        for (const s of rec.draft?.sections ?? []) {
          if (s.target?.mode === 'skip' || typeof s.annualIncome !== 'number' || !s.balanceDate || (s.recordBalance !== false && typeof s.balance === 'number')) continue;
          const accountId = rec.result?.sections?.find((x) => x.key === s.key)?.accountId;
          if (!accountId) continue;
          const id = figureId('pension_income_forecast', s.annualIncome, s.balanceDate, accountId, 'Forecast income per year', rec.id);
          if (have.has(id)) continue;
          have.add(id);
          added.push(
            JSON.stringify({
              id,
              kind: 'pension_income_forecast',
              label: 'Forecast income per year',
              amount: s.annualIncome,
              currency: s.currency ?? 'GBP',
              date: s.balanceDate,
              accountId,
              source: { importId: rec.id, ...(rec.document?.id ? { documentId: rec.document.id } : {}) },
              createdAt: rec.committedAt ?? nowISO(),
            }),
          );
        }
      }

      // 2. National Insurance numbers: out of figures (a payer reference that is one) and out of the
      //    readings and drafts kept with imports. Bank descriptions are source facts and keep theirs.
      const scrub = (value: unknown): { value: unknown; changed: boolean } => {
        if (typeof value === 'string') {
          const next = withoutNiNumbers(value);
          return { value: next, changed: next !== value };
        }
        if (Array.isArray(value)) {
          let changed = false;
          const next = value.map((v) => {
            const r = scrub(v);
            changed ||= r.changed;
            return r.value;
          });
          return { value: next, changed };
        }
        if (value && typeof value === 'object') {
          let changed = false;
          const next: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) {
            if (k === 'payerReference' && typeof v === 'string' && isNiNumber(v)) {
              changed = true;
              continue;
            }
            const r = scrub(v);
            changed ||= r.changed;
            next[k] = r.value;
          }
          return { value: next, changed };
        }
        return { value, changed: false };
      };
      let inFigures = 0;
      const lines = [...figures, ...added].map((line) => {
        const r = scrub(JSON.parse(line));
        if (!r.changed) return line;
        inFigures++;
        return JSON.stringify(r.value);
      });
      if (added.length || inFigures) await ctx.writeText('figures.jsonl', `${lines.join('\n')}\n`);
      ctx.log(`[migrate] ${added.length} pension forecast${added.length === 1 ? '' : 's'} recorded from the imports that read ${added.length === 1 ? 'it' : 'them'}`);
      let inImports = 0;
      for await (const file of walk(path.join(ctx.dataDir, 'imports'))) {
        if (!file.endsWith('.json')) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          continue;
        }
        const r = scrub(rec);
        if (!r.changed) continue;
        await ctx.writeJson(path.relative(ctx.dataDir, file), r.value);
        inImports++;
      }
      ctx.log(`[migrate] National Insurance numbers taken out of ${inFigures} figure${inFigures === 1 ? '' : 's'} and ${inImports} import record${inImports === 1 ? '' : 's'}`);
    },
  },
  {
    from: 4,
    description: 'Jobs (employments.json) set up from the pay figures, each pay figure under its job; HMRC pages already imported read again on this machine into hmrc.jsonl',
    async run(ctx) {
      interface Rec {
        id?: string;
        status?: string;
        committedAt?: string;
        document?: { id?: string; path?: string; mediaType?: string };
        draft?: { documentType?: string };
      }
      const imports = new Map<string, Rec>();
      for await (const file of walk(path.join(ctx.dataDir, 'imports'))) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(await readFile(file, 'utf8')) as Rec;
          if (rec.id && rec.status === 'committed') imports.set(rec.id, rec);
        } catch {
          // An unreadable record says nothing.
        }
      }
      type Fig = Record<string, unknown> & { id: string; kind: string; payer?: string; payerReference?: string; paidBy?: string; source?: { importId?: string } };
      const lines = (await ctx.exists('figures.jsonl')) ? (await readFile(path.join(ctx.dataDir, 'figures.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()) : [];
      let figures = lines.map((l) => JSON.parse(l) as Fig);
      const docType = (f: Fig) => (f.source?.importId ? imports.get(f.source.importId)?.draft?.documentType : undefined);

      // 1. HMRC's pages already imported, read again from their text (no Claude). What they say goes to
      //    hmrc.jsonl; the figures their earlier reading made for what the records now hold (a National
      //    Insurance record's amounts, a State Pension forecast) are taken out.
      const hmrcLines: string[] = (await ctx.exists('hmrc.jsonl')) ? (await readFile(path.join(ctx.dataDir, 'hmrc.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()) : [];
      const have = new Set(hmrcLines.map((l) => (JSON.parse(l) as { id: string }).id));
      let reread = 0;
      const replaced = new Set<string>();
      for (const rec of imports.values()) {
        if (rec.document?.mediaType !== 'application/pdf' || !rec.document.path) continue;
        const file = path.join(ctx.dataDir, rec.document.path);
        const text = await pdfText(file, path.dirname(file));
        const reading = text ? readGovUkPage(text) : null;
        if (!reading?.hmrc.length) continue;
        reread++;
        // A forecast stays on the account its figure was on.
        const forecastAccount = figures.find((f) => f.source?.importId === rec.id && f.kind === 'pension_income_forecast' && typeof f.accountId === 'string')?.accountId;
        for (const r of reading.hmrc) {
          const id = hmrcId(r);
          if (have.has(id)) continue;
          have.add(id);
          const account = r.type === 'state-pension-forecast' && forecastAccount ? { accountId: forecastAccount } : {};
          hmrcLines.push(JSON.stringify(HmrcRecordSchema.parse({ ...r, id, ...account, source: { importId: rec.id, ...(rec.document.id ? { documentId: rec.document.id } : {}) }, createdAt: rec.committedAt ?? nowISO() })));
        }
        const holds = new Set(reading.hmrc.map((r) => r.type));
        for (const f of figures) {
          if (f.source?.importId !== rec.id) continue;
          if ((holds.has('ni-year') && f.kind === 'national_insurance' && !f.payer) || (holds.has('state-pension-forecast') && f.kind === 'pension_income_forecast')) replaced.add(f.id);
        }
      }
      figures = figures.filter((f) => !replaced.has(f.id));
      ctx.log(`[migrate] ${reread} HMRC page${reread === 1 ? '' : 's'} read again on this machine; ${replaced.size} figure${replaced.size === 1 ? '' : 's'} they replace taken out`);

      // 2. Jobs: pay figures whose names (reduced) or PAYE references meet are one job's. Earned pay
      //    is the payroll's that pays it, and a payslip's pension deductions are its job's.
      const pay = figures.filter((f) => (PAY_KINDS as readonly string[]).includes(f.kind) && f.payer);
      const groups = new Employers(pay);
      const profile = ((await ctx.readJson('profile.json')) ?? {}) as Record<string, unknown> & { employers?: { name: string; payLagMonths?: number }[] };
      const employments: Record<string, unknown>[] = [];
      const idOf = new Map<string, string>();
      const taken = new Set<string>();
      const slug = (name: string) => {
        const base = name.toLowerCase().replace(/\b(ltd|limited|plc|llp)\b\.?/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'job';
        let id = base;
        for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
        taken.add(id);
        return id;
      };
      const stamp = nowISO();
      const jobFor = (key: string, named?: string) => {
        const existing = idOf.get(key);
        if (existing) return existing;
        // A payroll known only from earned pay has no pay figures to give it a name: the one it came by.
        const names = groups.namesOf(key).length ? groups.namesOf(key) : named ? [named] : [];
        // The name a whole-year document gives it (a P60), else the one its figures use most.
        const p60 = pay.find((f) => groups.keyOf(f) === key && docType(f) === 'p60' && f.payer)?.payer;
        const employer = p60 ?? names[0] ?? 'Employer';
        const aliases = [...new Set(names.filter((n) => payerKey(n) !== payerKey(employer)))];
        const lag = profile.employers?.find((e) => names.some((n) => payerKey(n) === payerKey(e.name)))?.payLagMonths;
        const ref = groups.referenceOf(key);
        const id = slug(employer);
        employments.push({ id, employer, aliases, ...(ref ? { payeReference: ref } : {}), payrollNumbers: [], ...(lag !== undefined ? { payLagMonths: lag } : {}), owed: [], createdBy: 'migration', createdAt: stamp, updatedAt: stamp });
        idOf.set(key, id);
        return id;
      };
      let placed = 0;
      figures = figures.map((f) => {
        if (f.employmentId) return f;
        let key: string | undefined;
        let named: string | undefined;
        if ((PAY_KINDS as readonly string[]).includes(f.kind) && f.payer) key = groups.keyOf(f);
        else if ((f.kind === 'pension_contribution_employee' || f.kind === 'pension_contribution_employer') && f.payer && docType(f) === 'payslip') key = groups.keyOfName((named = f.payer));
        else if (f.kind === 'earned_pay' && (f.paidBy ?? f.payer)) key = groups.keyOfName((named = f.paidBy ?? f.payer));
        if (!key) return f;
        placed++;
        return { ...f, employmentId: jobFor(key, named) };
      });
      // A payroll whose pay lag you set but that has no pay figures yet keeps it on a job of its own.
      for (const e of profile.employers ?? []) {
        if (e.payLagMonths === undefined || employments.some((x) => [x.employer as string, ...(x.aliases as string[])].some((n) => payerKey(n) === payerKey(e.name)))) continue;
        employments.push({ id: slug(e.name), employer: e.name, aliases: [], payrollNumbers: [], payLagMonths: e.payLagMonths, owed: [], createdBy: 'migration', createdAt: stamp, updatedAt: stamp });
      }
      if ('employers' in profile) {
        delete profile.employers;
        await ctx.writeJson('profile.json', profile);
      }
      await ctx.writeJson('employments.json', { $schema: '../schemas/employments.schema.json', employments });
      await ctx.writeText('figures.jsonl', figures.length ? `${figures.map((f) => JSON.stringify(f)).join('\n')}\n` : '');
      await ctx.writeText('hmrc.jsonl', hmrcLines.length ? `${hmrcLines.join('\n')}\n` : '');
      ctx.log(`[migrate] ${employments.length} job${employments.length === 1 ? '' : 's'} set up; ${placed} pay figure${placed === 1 ? '' : 's'} put under ${placed === 1 ? 'its job' : 'their jobs'}`);
    },
  },
  {
    from: 5,
    description: 'Payslips in full (payslips.jsonl): stored payslips in a layout read on this machine are read again, and figures their first reading got wrong or missed are put right',
    async run(ctx) {
      interface Rec {
        id?: string;
        status?: string;
        committedAt?: string;
        document?: { id?: string; path?: string; mediaType?: string };
        draft?: { documentType?: string };
      }
      const payslipImports: Rec[] = [];
      for await (const file of walk(path.join(ctx.dataDir, 'imports'))) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(await readFile(file, 'utf8')) as Rec;
          if (rec.id && rec.status === 'committed' && rec.draft?.documentType === 'payslip' && rec.document?.mediaType === 'application/pdf' && rec.document.path) payslipImports.push(rec);
        } catch {
          // An unreadable record says nothing.
        }
      }
      type Fig = Record<string, unknown> & { id: string; kind: string; amount: number; label: string; payer?: string; date?: string; employmentId?: string; taxCode?: string; notes?: string; source?: { importId?: string } };
      const read = async (name: string) => ((await ctx.exists(name)) ? (await readFile(path.join(ctx.dataDir, name), 'utf8')).split('\n').filter((l) => l.trim()) : []);
      const figures = (await read('figures.jsonl')).map((l) => JSON.parse(l) as Fig);
      const payslipLines = await read('payslips.jsonl');
      const have = new Set(payslipLines.map((l) => (JSON.parse(l) as { id: string }).id));
      let reread = 0;
      let corrected = 0;
      let added = 0;
      let coded = 0;
      const unsure: string[] = [];
      for (const rec of payslipImports.sort((a, b) => a.id!.localeCompare(b.id!))) {
        const file = path.join(ctx.dataDir, rec.document!.path!);
        const text = await pdfText(file, path.dirname(file));
        const got = text ? readPayslipPage(text) : null;
        if (!got) continue;
        reread++;
        const mine = figures.filter((f) => f.source?.importId === rec.id);
        const job = mine.find((f) => f.employmentId)?.employmentId;
        const source = { importId: rec.id, ...(rec.document?.id ? { documentId: rec.document.id } : {}) };
        for (const p of got.extraction.payslips) {
          const id = payslipId(p);
          if (have.has(id)) continue;
          have.add(id);
          payslipLines.push(JSON.stringify(PayslipRecordSchema.parse({ ...p, id, ...(job ? { employmentId: job } : {}), taxYear: taxYearOf(p.payDate).label, source, createdAt: rec.committedAt ?? nowISO() })));
        }
        // Its figures, put right from this reading when every line on it adds up to what it prints.
        if (got.extraction.confidence !== 'high' || got.extraction.payslips.length !== 1) continue;
        const slip = got.extraction.payslips[0]!;
        for (const f of got.extraction.figures) {
          const same = mine.filter((x) => x.kind === f.kind);
          // Several figures of one kind (one per line printed) are right when they add up to it; when
          // they do not, which is wrong cannot be told, and they are left for you.
          if (same.length > 1) {
            if (same.reduce((x, y) => x + toMinor(y.amount), 0) !== toMinor(f.amount)) unsure.push(`${rec.id} ${f.kind}`);
            continue;
          }
          const stored = same[0];
          if (!stored) {
            const payer = mine.find((x) => x.payer)?.payer ?? f.payer ?? undefined;
            figures.push({
              id: figureId(f.kind, f.amount, f.taxYear ?? f.periodEnd ?? '', payer ?? '', f.label, rec.id),
              kind: f.kind,
              label: f.label,
              amount: f.amount,
              currency: 'GBP',
              ...(f.taxYear ? { taxYear: f.taxYear } : {}),
              ...(f.periodStart ? { periodStart: f.periodStart } : {}),
              ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}),
              date: mine.find((x) => x.date)?.date ?? slip.payDate,
              ...(payer ? { payer } : {}),
              ...(job ? { employmentId: job } : {}),
              ...(f.taxCode ? { taxCode: f.taxCode } : {}),
              notes: 'Read again on this machine (format v6): the first reading left it out.',
              source,
              createdAt: rec.committedAt ?? nowISO(),
            });
            added++;
            continue;
          }
          if (toMinor(stored.amount) !== toMinor(f.amount)) {
            stored.notes = [stored.notes, `Read again on this machine (format v6): the first reading had ${stored.amount.toFixed(2)}.`].filter(Boolean).join(' ');
            stored.amount = f.amount;
            corrected++;
          }
          if (f.kind === 'gross_pay' && f.taxCode && !stored.taxCode) {
            stored.taxCode = f.taxCode;
            coded++;
          }
        }
      }
      await ctx.writeText('figures.jsonl', figures.length ? `${figures.map((f) => JSON.stringify(f)).join('\n')}\n` : '');
      await ctx.writeText('payslips.jsonl', payslipLines.length ? `${payslipLines.join('\n')}\n` : '');
      ctx.log(`[migrate] ${reread} payslip${reread === 1 ? '' : 's'} read again on this machine; ${corrected} figure${corrected === 1 ? '' : 's'} put right, ${added} added, ${coded} given ${coded === 1 ? 'its' : 'their'} tax code`);
      if (unsure.length) ctx.log(`[migrate] figures that do not add up to their payslip, left as they are: ${unsure.join(', ')}`);
    },
  },
  {
    from: 6,
    description: "Terms (terms.jsonl): the credit limit and rate each balance kept become the account's terms, as its document gave them that day",
    async run(ctx) {
      const accounts = ((await ctx.readJson('accounts.json')) as { accounts?: { id: string; type: AccountType }[] } | undefined)?.accounts ?? [];
      const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
      const lines = (await ctx.exists('terms.jsonl')) ? (await readFile(path.join(ctx.dataDir, 'terms.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()) : [];
      const terms = lines.map((l) => JSON.parse(l) as Terms);
      let moved = 0;
      const kept: string[] = [];
      await ctx.mapJsonl('balances', (b) => {
        if (!('creditLimit' in b) && !('interestRate' in b)) return null;
        const { creditLimit, interestRate, ...rest } = b;
        const accountId = String(b.accountId);
        const asOf = String(b.date);
        const source = (b.source ?? {}) as Terms['source'];
        const content = termsOfReading({ creditLimit: typeof creditLimit === 'number' ? creditLimit : undefined, interestRate: typeof interestRate === 'number' ? interestRate : undefined }, typeOf.get(accountId) ?? 'current');
        const id = termsId(accountId, asOf, source);
        const record = content ? TermsSchema.safeParse({ id, accountId, asOf, ...content, source, createdAt: typeof b.createdAt === 'string' ? b.createdAt : nowISO() }) : undefined;
        // What cannot be made a terms record stays where it is, for you to see.
        if (!record?.success) {
          kept.push(`${accountId} ${asOf}`);
          return null;
        }
        // The same terms from two balances of one day (a statement and a screenshot) are kept once.
        if (!terms.some((t) => t.id === id || (t.accountId === accountId && t.asOf === asOf && sameTerms(t, record.data)))) terms.push(record.data);
        moved++;
        return rest;
      });
      await ctx.writeText('terms.jsonl', terms.length ? `${terms.map((t) => JSON.stringify(t)).join('\n')}\n` : '');
      ctx.log(`[migrate] the credit limit or rate on ${moved} balance${moved === 1 ? '' : 's'} kept as ${terms.length} terms record${terms.length === 1 ? '' : 's'}`);
      if (kept.length) ctx.log(`[migrate] a limit or rate that could not be kept as terms, left on its balance: ${kept.join(', ')}`);
    },
  },
  {
    from: 7,
    description: 'Jobs learn what their payslips print: the payroll number, and every name on them (a group’s too)',
    async run(ctx) {
      const file = (await ctx.readJson('employments.json')) as { employments?: Employment[] } | undefined;
      const jobs = file?.employments ?? [];
      if (!jobs.length) return;
      const lines = (await ctx.exists('payslips.jsonl')) ? (await readFile(path.join(ctx.dataDir, 'payslips.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()) : [];
      const taught = new Set<string>();
      for (const line of lines) {
        const p = JSON.parse(line) as PayslipRecord;
        const i = jobs.findIndex((e) => e.id === p.employmentId);
        if (i < 0) continue;
        const next = learnFromPayslip(EmploymentSchema.parse(jobs[i]), p);
        if (JSON.stringify(next) === JSON.stringify(EmploymentSchema.parse(jobs[i]))) continue;
        jobs[i] = { ...next, updatedAt: nowISO() };
        taught.add(next.id);
      }
      if (taught.size) await ctx.writeJson('employments.json', { ...file, employments: jobs });
      ctx.log(`[migrate] ${taught.size} job${taught.size === 1 ? '' : 's'} learnt what ${taught.size === 1 ? 'its' : 'their'} payslips print${taught.size ? `: ${[...taught].join(', ')}` : ''}`);
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
