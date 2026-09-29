// The import pipeline: upload → (queue) → parse or extract → draft → review → commit.

import { EventEmitter } from 'node:events';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '../../shared/accounts';
import { CategoryIndex } from '../../shared/categories';
import { today } from '../../shared/dates';
import { sectionChecks } from '../../shared/review';
import {
  CsvProfileSchema,
  DraftSchema,
  type CsvProfile,
  type Draft,
  type EngineId,
  type ExtractionEnginePreference,
  type ImportRecord,
} from '../../shared/schema';
import type { Config } from '../config';
import { Limiter, nowISO, sha256 } from '../fsutil';
import { documentId, importId } from '../ids';
import { StoreError, type ImportSummary, type Store } from '../store';
import { extractWithClaudeApi } from './claude-api';
import { extractWithClaudeCli } from './claude-cli';
import { commitDraft } from './commit';
import { CSV_ENGINE_VERSION, findProfile, parseWithProfile, readCsvRows, suggestMapping } from './csv';
import { HOLDINGS_CSV_VERSION, parseHoldingsCsv } from './holdings-csv';
import { decodeText, detectKind, MAX_UPLOAD_BYTES, mediaTypeFor } from './detect';
import { buildDraft, draftIsClean } from './draft';
import { assessReading, chooseReading, compareReadings, shortModel } from './verify';
import { detectEngines, pickEngine, type EngineResult } from './engines';
import { captureDate, imageInfo, prepareImage } from './images';
import { extractWithOcr, OCR_ENGINE_VERSION } from './ocr';
import { OFX_ENGINE_VERSION, parseOfx } from './ofx';
import { extractionJsonSchema, PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from './prompt';
import { parseQif, QIF_ENGINE_VERSION } from './qif';
import { parseSantanderTxt, SANTANDER_ENGINE_VERSION } from './santander';
import { WorkArea } from './workarea';

export interface CreateImportInput {
  fileName: string;
  bytes: Buffer;
  lastModified?: string | undefined;
  origin: ImportRecord['origin'];
  hintAccountId?: string | undefined;
  /** Import even if this exact file was committed before. */
  force?: boolean;
}

export interface CreateImportResult {
  record?: ImportRecord;
  duplicateOf?: ImportSummary | ImportRecord;
}

export interface ProcessOptions {
  engine?: ExtractionEnginePreference | undefined;
  model?: string | undefined;
  /** The model that checks the reading; empty to skip the check. Defaults to the setting. */
  verifyModel?: string | undefined;
}

export class ImportService extends EventEmitter {
  private pending = new Map<string, ImportRecord>();
  private readonly limiter: Limiter;
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    readonly work: WorkArea,
  ) {
    super();
    this.limiter = new Limiter(store.settings.extraction.maxConcurrent);
  }

  async init(): Promise<void> {
    await this.work.init();
    for (const r of await this.work.loadAll()) {
      this.pending.set(r.id, r);
      if (r.status === 'queued' || r.status === 'processing') this.schedule(r.id);
    }
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────────────────────

  listPending(): ImportRecord[] {
    return [...this.pending.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getPending(id: string): ImportRecord | undefined {
    return this.pending.get(id);
  }

  async get(id: string): Promise<ImportRecord | undefined> {
    return this.pending.get(id) ?? (await this.store.readImport(id));
  }

  workFile(record: ImportRecord): string {
    return this.work.filePath(record.document);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.pending.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────────────────────

  private async save(record: ImportRecord): Promise<void> {
    record.updatedAt = nowISO();
    this.pending.set(record.id, record);
    await this.work.saveRecord(record);
    this.emit('update', record);
  }

  async create(input: CreateImportInput): Promise<CreateImportResult> {
    if (input.bytes.length === 0) throw new StoreError('The file is empty.');
    if (input.bytes.length > MAX_UPLOAD_BYTES) throw new StoreError(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are accepted.`, 413);
    const kind = detectKind(input.fileName, input.bytes);
    if (kind === 'unsupported') throw new StoreError(`"${input.fileName}" is not a supported file (CSV, OFX, QIF, TXT, PDF, PNG, JPEG, WebP).`, 415);
    const sha = sha256(input.bytes);
    const docId = documentId(sha);
    const pendingDup = [...this.pending.values()].find((r) => r.document.sha256 === sha && r.status !== 'discarded');
    if (pendingDup) return { duplicateOf: pendingDup };
    const committedDup = this.store.imports.find((i) => i.documentId === docId);
    if (committedDup && !input.force) return { duplicateOf: committedDup };

    const mediaType = mediaTypeFor(input.fileName, input.bytes);
    const stamp = nowISO();
    const record: ImportRecord = {
      id: importId(),
      status: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
      origin: input.origin,
      document: {
        id: docId,
        sha256: sha,
        fileName: path.basename(input.fileName).slice(0, 200),
        mediaType,
        size: input.bytes.length,
        ...(input.lastModified ? { lastModified: input.lastModified } : {}),
      },
      extraction: { warnings: [] },
      ...(input.hintAccountId && this.store.account(input.hintAccountId) ? { hintAccountId: input.hintAccountId } : {}),
    };
    if (kind === 'image') await describeCapture(record, input.bytes);
    await this.work.saveFile(record.document, input.bytes);
    await this.save(record);
    this.schedule(record.id);
    return { record };
  }

  private schedule(id: string, opts: ProcessOptions = {}): void {
    this.limiter.setLimit(this.store.settings.extraction.maxConcurrent);
    void this.limiter.run(() => this.process(id, opts));
  }

  async reprocess(id: string, opts: ProcessOptions = {}): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Only imports that have not been committed can be re-processed.', 404);
    if (record.status === 'processing') throw new StoreError('Already processing.', 409);
    record.status = 'queued';
    record.extraction = { warnings: [] };
    delete record.draft;
    delete record.mapping;
    await this.save(record);
    this.schedule(id, opts);
    return record;
  }

  private async process(id: string, opts: ProcessOptions): Promise<void> {
    const record = this.pending.get(id);
    if (!record || (record.status !== 'queued' && record.status !== 'processing')) return;
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const started = Date.now();
    record.status = 'processing';
    record.extraction = { ...record.extraction, startedAt: nowISO(), warnings: [] };
    await this.save(record);
    try {
      const bytes = await this.work.readFile(record.document);
      const kind = detectKind(record.document.fileName, bytes);
      // Screenshots uploaded before the capture time and screen size were kept get them now.
      if (kind === 'image' && !record.document.image) await describeCapture(record, bytes);
      let result: EngineResult & { ocrText?: string; candidates?: { amounts: number[]; dates: string[] } };
      let engine: EngineId;
      let detail: string | undefined;
      let engineVersion: string;
      let verified: Awaited<ReturnType<ImportService['verifyReading']>> | undefined;
      if (kind === 'csv') {
        const { rows } = readCsvRows(decodeText(bytes));
        const match = findProfile(rows, this.store.csvProfiles);
        // A platform's portfolio export lists holdings, not transactions.
        const holdings = match ? null : parseHoldingsCsv(rows, record.document.fileName);
        if (holdings) {
          result = { extraction: holdings, warnings: [], durationMs: Date.now() - started };
          detail = 'holdings export';
        } else if (match) {
          const parsed = parseWithProfile(rows, match);
          result = { extraction: parsed.extraction, warnings: [], durationMs: Date.now() - started };
          detail = match.profile.id;
        } else {
          const suggestion = suggestMapping(rows);
          if (!suggestion) throw new Error('Could not find a date and description column in this CSV.');
          if (!suggestion.confident) {
            record.mapping = { profile: suggestion.profile, headers: suggestion.headers, sample: suggestion.sample, headerIndex: suggestion.headerIndex };
            record.status = 'needs_mapping';
            record.extraction = { ...record.extraction, engine: 'csv', finishedAt: nowISO(), durationMs: Date.now() - started };
            await this.save(record);
            return;
          }
          const parsed = parseWithProfile(rows, { profile: suggestion.profile, headerIndex: suggestion.headerIndex, headerless: false });
          result = {
            extraction: parsed.extraction,
            warnings: ['This CSV layout was not recognised; columns were detected automatically. Check signs and dates carefully, then save the mapping for next time.'],
            durationMs: Date.now() - started,
          };
          record.mapping = { profile: suggestion.profile, headers: suggestion.headers, sample: suggestion.sample, headerIndex: suggestion.headerIndex };
          detail = 'auto-detected';
        }
        engine = 'csv';
        engineVersion = holdings ? HOLDINGS_CSV_VERSION : CSV_ENGINE_VERSION;
      } else if (kind === 'ofx') {
        result = { extraction: parseOfx(decodeText(bytes)), warnings: [], durationMs: Date.now() - started };
        engine = 'ofx';
        engineVersion = OFX_ENGINE_VERSION;
      } else if (kind === 'qif') {
        result = { extraction: parseQif(decodeText(bytes)), warnings: [], durationMs: Date.now() - started };
        engine = 'qif';
        engineVersion = QIF_ENGINE_VERSION;
      } else if (kind === 'santander-txt') {
        result = { extraction: parseSantanderTxt(decodeText(bytes)), warnings: [], durationMs: Date.now() - started };
        engine = 'santander-txt';
        engineVersion = SANTANDER_ENGINE_VERSION;
      } else if (kind === 'pdf' || kind === 'image') {
        const settings = this.store.settings.extraction;
        const { engines, claudeBin } = await detectEngines({ apiKey: this.config.anthropicApiKey });
        const chosen = pickEngine(opts.engine ?? settings.engine, engines);
        if (!chosen) throw new Error('No extraction engine is available for PDFs and images. See Settings → Extraction.');
        engine = chosen;
        const model = opts.model ?? settings.model;
        const scratch = await this.work.scratch(record.id);
        const source = this.work.filePath(record.document);
        let files: { path: string; mediaType: string }[];
        let tiled = false;
        if (kind === 'image') {
          const prepared = await prepareImage(bytes, scratch, 'page');
          files = prepared.files.map((p) => ({ path: p, mediaType: 'image/png' }));
          tiled = prepared.tiled;
        } else {
          const p = path.join(scratch, 'document.pdf');
          await copyFile(source, p);
          files = [{ path: p, mediaType: 'application/pdf' }];
        }
        const hint = record.hintAccountId ? this.store.account(record.hintAccountId) : undefined;
        const promptCtx = {
          fileName: record.document.fileName,
          tiled,
          capturedOn: record.document.capturedOn,
          capturedOnSource: record.document.capturedOnSource,
          uploadedOn: record.createdAt.slice(0, 10),
          categoryIds: new CategoryIndex(this.store.categories).list.filter((c) => c.parent).map((c) => c.id),
          accountHint: hint ? `${hint.name} (${hint.type}${hint.last4 ? `, ending ${hint.last4}` : ''})` : undefined,
        };
        const timeoutMs = settings.timeoutSeconds * 1000;
        const readWith = async (m: string): Promise<EngineResult> => {
          if (chosen === 'claude-cli') {
            if (!claudeBin) throw new Error('claude CLI not found');
            return extractWithClaudeCli({
              bin: claudeBin,
              cwd: scratch,
              userPrompt: userPrompt({ ...promptCtx, files: files.map((f) => `./${path.basename(f.path)}`) }),
              systemPrompt: SYSTEM_PROMPT,
              schema: extractionJsonSchema(),
              model: m,
              effort: settings.effort,
              timeoutMs,
              signal: abort.signal,
            });
          }
          return extractWithClaudeApi({
            apiKey: this.config.anthropicApiKey!,
            files,
            userPrompt: userPrompt(promptCtx),
            systemPrompt: SYSTEM_PROMPT,
            schema: extractionJsonSchema(),
            model: m,
            effort: settings.effort,
            timeoutMs,
            signal: abort.signal,
          });
        };
        if (chosen === 'ocr') {
          result = await extractWithOcr(files[0]!, scratch, Number(today().slice(0, 4)));
          engineVersion = OCR_ENGINE_VERSION;
        } else {
          result = await readWith(model);
          engineVersion = PROMPT_VERSION;
          const verifyModel = opts.verifyModel !== undefined ? opts.verifyModel : settings.verifyModel;
          if (verifyModel && verifyModel !== model) {
            const checked = await this.verifyReading(record, result, { model, verifyModel, readWith });
            result = checked.result;
            verified = checked;
          }
        }
        detail = result.model;
        await this.work.clearScratch(record.id);
      } else {
        throw new Error('Unsupported file type');
      }

      const draft = verified?.draft ?? this.draftOf(record, result);
      if (result.ocrText) draft.ocrText = result.ocrText;
      if (result.candidates) draft.candidates = result.candidates;
      record.draft = draft;
      record.extraction = {
        ...record.extraction,
        engine,
        engineVersion,
        finishedAt: nowISO(),
        durationMs: Date.now() - started,
        warnings: result.warnings,
        raw: result.extraction,
        ...(detail ? { detail } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.costUsd !== undefined || verified?.otherCostUsd ? { costUsd: Math.round(((result.costUsd ?? 0) + (verified?.otherCostUsd ?? 0)) * 10000) / 10000 } : {}),
        ...(verified ? { verification: verified.verification } : {}),
        ...(verified?.alternative ? { alternative: verified.alternative } : {}),
      };
      record.status = 'review';
      await this.save(record);
    } catch (err) {
      if (!this.pending.has(id)) return; // discarded while running
      record.status = 'failed';
      record.extraction = { ...record.extraction, error: (err as Error).message, finishedAt: nowISO(), durationMs: Date.now() - started };
      await this.save(record);
    } finally {
      this.aborts.delete(id);
    }
  }

  /** Rebuild the draft from the stored extraction (after adding accounts, rules, etc.). */
  async refreshDraft(id: string): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record?.extraction.raw) throw new StoreError('Nothing to refresh', 404);
    record.draft = buildDraft(record.extraction.raw, {
      store: this.store,
      document: record.document,
      hintAccountId: record.hintAccountId,
      uploadedOn: record.createdAt.slice(0, 10),
      warnings: record.extraction.warnings,
    });
    await this.save(record);
    return record;
  }

  async updateDraft(id: string, draft: Draft): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record || record.status !== 'review') throw new StoreError('This import is not awaiting review.', 409);
    record.draft = DraftSchema.parse(draft);
    await this.save(record);
    return record;
  }

  async setHint(id: string, accountId: string | undefined): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Unknown import', 404);
    if (accountId) record.hintAccountId = accountId;
    else delete record.hintAccountId;
    await this.save(record);
    return record.extraction.raw ? this.refreshDraft(id) : record;
  }

  /** Apply a user-confirmed CSV mapping, optionally saving it as a profile for next time. */
  async applyMapping(id: string, profileInput: CsvProfile, saveAs?: string): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Unknown import', 404);
    const profile = CsvProfileSchema.parse(profileInput);
    const bytes = await this.work.readFile(record.document);
    const { rows } = readCsvRows(decodeText(bytes));
    const headerIndex = record.mapping?.headerIndex ?? 0;
    const parsed = parseWithProfile(rows, { profile, headerIndex, headerless: false });
    if (!parsed.rowCount) throw new StoreError('No rows could be read with this mapping; check the date and amount columns.');
    if (saveAs) {
      const saved: CsvProfile = {
        ...profile,
        id: slugify(saveAs, [...this.store.csvProfiles.map((p) => p.id), 'monzo', 'starling', 'revolut']),
        name: saveAs,
        builtin: false,
        headerSignature: (record.mapping?.headers ?? profile.headerSignature).filter(Boolean).map((h) => h.trim().toLowerCase()),
        createdAt: nowISO(),
      };
      await this.store.setCsvProfiles([...this.store.csvProfiles, saved], `csv profile: ${saveAs}`);
    }
    record.draft = buildDraft(parsed.extraction, {
      store: this.store,
      document: record.document,
      hintAccountId: record.hintAccountId,
      uploadedOn: record.createdAt.slice(0, 10),
    });
    record.extraction = { ...record.extraction, engine: 'csv', engineVersion: CSV_ENGINE_VERSION, detail: saveAs ?? 'custom mapping', raw: parsed.extraction };
    record.mapping = { ...(record.mapping ?? { headers: [], sample: [], headerIndex }), profile };
    record.status = 'review';
    await this.save(record);
    return record;
  }

  async commit(id: string, draft?: Draft): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Unknown or already committed import', 404);
    if (record.status !== 'review') throw new StoreError(`Cannot commit an import that is ${record.status}.`, 409);
    const finalDraft = draft ? DraftSchema.parse(draft) : record.draft;
    if (!finalDraft) throw new StoreError('Nothing to commit', 409);
    const committed = await commitDraft(this.store, { record, draft: finalDraft, workFile: this.work.filePath(record.document) });
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    this.emit('update', committed);
    return committed;
  }

  private draftOf(record: ImportRecord, result: EngineResult): Draft {
    return buildDraft(result.extraction, { store: this.store, document: record.document, hintAccountId: record.hintAccountId, uploadedOn: record.createdAt.slice(0, 10), warnings: result.warnings });
  }

  private assess(record: ImportRecord, draft: Draft, warnings: string[]) {
    return assessReading(draft, {
      accountTypeOf: (s) => (s.target.mode === 'existing' ? this.store.account(s.target.accountId)?.type : s.target.mode === 'new' ? s.target.account.type : undefined),
      latest: record.createdAt.slice(0, 10),
      warnings,
    });
  }

  /**
   * Check a model's reading (docs/INGESTION.md, "Checking every figure"). A reading the document's
   * own arithmetic confirms is kept. Otherwise (a check failed, or some figures have nothing to be
   * checked against) the document is read again with the checking model, the two readings are
   * compared figure by figure, the better one is kept, and rows they disagree on are marked.
   */
  private async verifyReading(record: ImportRecord, first: EngineResult, opts: { model: string; verifyModel: string; readWith: (m: string) => Promise<EngineResult> }) {
    const firstDraft = this.draftOf(record, first);
    const a1 = this.assess(record, firstDraft, first.warnings);
    const firstModel = first.model ?? opts.model;
    if (!a1.problems.length && !a1.unconfirmed.length) {
      return { result: first, draft: firstDraft, otherCostUsd: 0, alternative: undefined, verification: { method: 'checks' as const, firstModel, reasons: [], disagreements: [], kept: 'first' as const } };
    }
    const reasons = [...a1.problems, ...a1.unconfirmed.map((u) => `Nothing on the document confirms: ${u}`)];
    let second: EngineResult;
    try {
      second = await opts.readWith(opts.verifyModel);
    } catch (err) {
      // Without a second reading the first stands; the review page says it is unchecked.
      return { result: first, draft: firstDraft, otherCostUsd: 0, alternative: undefined, verification: { method: 'second-reading' as const, firstModel, secondModel: opts.verifyModel, reasons, disagreements: [], kept: 'first' as const, error: (err as Error).message.slice(0, 300) } };
    }
    const secondDraft = this.draftOf(record, second);
    const a2 = this.assess(record, secondDraft, second.warnings);
    const kept = chooseReading(a1, a2);
    const names = { first: shortModel(firstModel), second: shortModel(second.model ?? opts.verifyModel) };
    const [keptResult, keptDraft, other, otherDraft] = kept === 'second' ? [second, secondDraft, first, firstDraft] : [first, firstDraft, second, secondDraft];
    const cmp = kept === 'second' ? compareReadings(otherDraft, keptDraft, { first: names.first, second: names.second }) : compareReadings(otherDraft, keptDraft, { first: names.second, second: names.first });
    for (const s of keptDraft.sections) {
      for (const t of s.transactions) {
        const n = cmp.rowNotes.get(t.key);
        if (n) t.uncertain = t.uncertain ? `${t.uncertain}; ${n}` : n;
      }
    }
    return {
      result: keptResult,
      draft: keptDraft,
      otherCostUsd: other.costUsd ?? 0,
      alternative: other.extraction,
      verification: { method: 'second-reading' as const, firstModel, secondModel: second.model ?? opts.verifyModel, reasons, disagreements: cmp.disagreements, kept },
    };
  }

  /** Why an import is (not) safe to commit without review. */
  readiness(record: ImportRecord): { ready: boolean; reasons: string[] } {
    if (record.status !== 'review' || !record.draft) return { ready: false, reasons: [record.status] };
    const { clean, reasons } = draftIsClean(record.draft);
    // Every check that asks for a look (the review page shows the same ones) holds the import back.
    for (const s of record.draft.sections) {
      if (s.target.mode === 'skip') continue;
      const accountType = s.target.mode === 'existing' ? this.store.account(s.target.accountId)?.type : s.target.account.type;
      for (const c of sectionChecks(s, { accountType, latest: record.createdAt.slice(0, 10), periodFromRows: record.draft.documentType === 'csv_export' })) if (c.status === 'warn') reasons.push(c.title.toLowerCase());
    }
    if (record.extraction.warnings.length) reasons.push('warnings from reading the document');
    if (record.extraction.verification?.disagreements.length) reasons.push('the two readings disagreed');
    if (record.extraction.verification?.error) reasons.push('the figures could not be checked');
    if (record.extraction.engine === 'ocr') reasons.push('read with offline OCR');
    return { ready: clean && reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  async commitReady(): Promise<{ committed: string[]; skipped: { id: string; reasons: string[] }[] }> {
    const committed: string[] = [];
    const skipped: { id: string; reasons: string[] }[] = [];
    for (const record of this.listPending()) {
      if (record.status !== 'review') continue;
      const r = this.readiness(record);
      if (!r.ready) {
        skipped.push({ id: record.id, reasons: r.reasons });
        continue;
      }
      await this.commit(record.id);
      committed.push(record.id);
    }
    return { committed, skipped };
  }

  async discard(id: string): Promise<void> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Unknown import', 404);
    this.aborts.get(id)?.abort();
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    this.emit('update', { ...record, status: 'discarded' });
  }
}

/** When a screenshot was taken, and on what screen: its date for the balance, the rest for batches. */
async function describeCapture(record: ImportRecord, bytes: Buffer): Promise<void> {
  const doc = record.document;
  const cap = await captureDate(bytes, doc.fileName, doc.lastModified);
  if (cap) {
    doc.capturedOn = cap.date;
    doc.capturedOnSource = cap.source;
    if (cap.at) doc.capturedAt = cap.at;
    else delete doc.capturedAt;
  }
  const info = await imageInfo(bytes);
  if (info) doc.image = info;
}
