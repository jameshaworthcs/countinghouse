// The import pipeline: upload → (queue) → parse or extract → draft → review → commit.

import { EventEmitter } from 'node:events';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '../../shared/accounts';
import type { Reread } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { Categoriser } from '../../shared/categorise';
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
  type Transaction,
} from '../../shared/schema';
import type { Config } from '../config';
import { Limiter, nowISO, sha256 } from '../fsutil';
import { balanceId, documentId, importId, transactionId } from '../ids';
import { recordInstrumentsFromHoldings } from '../instruments';
import { StoreError, type ImportSummary, type Store } from '../store';
import { extractWithClaudeApi } from './claude-api';
import { extractWithClaudeCli } from './claude-cli';
import { commitDraft } from './commit';
import { linkTransfers } from '../enrich';
import { BUILTIN_CSV_PROFILES } from './csv-profiles';
import { recheckDraft } from './dedup';
import { compareReading } from './reread';
import { CSV_ENGINE_VERSION, findProfile, parseWithProfile, readCsvRows, suggestMapping } from './csv';
import { HOLDINGS_CSV_VERSION, parseHoldingsCsv } from './holdings-csv';
import { decodeText, detectKind, MAX_UPLOAD_BYTES, mediaTypeFor } from './detect';
import { buildDraft, draftIsClean, type BatchEvidence } from './draft';
import { assessNovelty, type NothingNew } from './novelty';
import { assessReading, chooseReading, compareReadings, shortModel } from './verify';
import { detectEngines, pickEngine, type EngineResult } from './engines';
import { captureDate, imageInfo, prepareImage } from './images';
import { extractWithOcr, OCR_ENGINE_VERSION } from './ocr';
import { OFX_ENGINE_VERSION, parseOfx } from './ofx';
import { extractionJsonSchema, PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from './prompt';
import { parseQif, QIF_ENGINE_VERSION } from './qif';
import { parseSantanderTxt, SANTANDER_ENGINE_VERSION } from './santander';
import { WorkArea } from './workarea';
import { sheetRows, XLSX_ENGINE_VERSION } from './xlsx';

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

/** Screenshots uploaded within this long of each other were uploaded together. */
const UPLOADED_TOGETHER_MS = 2 * 60_000;
/** Screenshots taken within this long of each other, on one phone, were taken together. */
const TAKEN_TOGETHER_MS = 10 * 60_000;

/** Taken and uploaded together, on the same phone (docs/INGESTION.md, "Screenshots taken together"). */
export function takenTogether(a: ImportRecord, b: ImportRecord): boolean {
  const [x, y] = [a.document, b.document];
  if (a.id === b.id || !x.capturedAt || !y.capturedAt || !x.image || !y.image) return false;
  if (Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) > UPLOADED_TOGETHER_MS) return false;
  if (Math.abs(Date.parse(x.capturedAt) - Date.parse(y.capturedAt)) > TAKEN_TOGETHER_MS) return false;
  return x.image.width === y.image.width && (!x.image.device || !y.image.device || x.image.device === y.image.device);
}

/** The one account a screenshot shows by itself (not by another screenshot's evidence), if any. */
function accountShown(r: ImportRecord): string | undefined {
  if (!r.draft || r.draft.batchMatch) return undefined;
  const sections = r.draft.sections.filter((s) => s.target.mode !== 'skip');
  if (sections.length !== 1) return undefined;
  const s = sections[0]!;
  // A committed screenshot may have created its account.
  const committed = r.result?.sections?.find((x) => x.key === s.key)?.accountId;
  return committed ?? (s.target.mode === 'existing' ? s.target.accountId : undefined);
}

export interface ProcessOptions {
  engine?: ExtractionEnginePreference | undefined;
  model?: string | undefined;
  /** The model that checks the reading; empty to skip the check. Defaults to the setting. */
  verifyModel?: string | undefined;
}

export class ImportService extends EventEmitter {
  private pending = new Map<string, ImportRecord>();
  /** Stored documents read again: the latest reading of each, kept in the work area. */
  private rereads = new Map<string, Reread>();
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
    for (const r of await this.work.loadRereads()) {
      // A reading the app stopped in the middle of is not coming back.
      this.rereads.set(r.importId, r.status === 'running' ? { ...r, status: 'failed', error: 'Stopped when the app restarted: read it again.' } : r);
    }
    await this.redraftWaiting();
  }

  /**
   * Drafts you have not edited are drafted again from their readings when the app starts, so what a
   * newer version matches, categorises or checks applies to imports already waiting. Nothing is read
   * again, and a draft you saved changes to is left alone.
   */
  private async redraftWaiting(): Promise<void> {
    const waiting = [...this.pending.values()].filter((r) => r.status === 'review' && r.draft && r.extraction.raw && !r.draftEditedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const r of waiting) {
      try {
        const next = this.rebuild(r, r.document.image ? await this.batchEvidence(r) : undefined);
        if (JSON.stringify(next) === JSON.stringify(r.draft)) continue;
        r.draft = next;
        await this.save(r);
      } catch (err) {
        console.warn(`[imports] ${r.id} could not be drafted again: ${(err as Error).message}`);
      }
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
    delete record.draftEditedAt;
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
      if (kind === 'csv' || kind === 'xlsx') {
        // A spreadsheet's first table goes through the same profiles and mapping as a CSV.
        const table = kind === 'xlsx' ? sheetRows(bytes) : undefined;
        const { rows } = table ?? readCsvRows(decodeText(bytes));
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
          const suggestion = suggestMapping(rows, { accountType: record.hintAccountId ? this.store.account(record.hintAccountId)?.type : undefined });
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
            warnings: [
              'This CSV layout was not recognised; columns were detected automatically. Check signs and dates carefully, then save the mapping for next time.',
              ...(suggestion.profile.amountSign === 'inverted' ? ['The amounts were read card style, money out positive: the file is for a credit card, and its purchases and payments only have the right signs that way round.'] : []),
            ],
            durationMs: Date.now() - started,
          };
          record.mapping = { profile: suggestion.profile, headers: suggestion.headers, sample: suggestion.sample, headerIndex: suggestion.headerIndex };
          detail = 'auto-detected';
        }
        engine = 'csv';
        engineVersion = holdings ? HOLDINGS_CSV_VERSION : CSV_ENGINE_VERSION;
        if (table) {
          engineVersion = `${XLSX_ENGINE_VERSION}+${engineVersion}`;
          detail = `sheet “${table.sheet}”${detail ? `, ${detail}` : ''}`;
        }
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
        const read = await this.readDocument(record, kind, bytes, this.work.filePath(record.document), opts, abort.signal);
        ({ result, engine, engineVersion, verified } = read);
        detail = result.model;
      } else {
        throw new Error('Unsupported file type');
      }

      const draft = verified?.draft ?? this.draftOf(record, result, kind === 'image' ? await this.batchEvidence(record) : undefined);
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
      if (kind === 'image') await this.refreshBatch(record);
    } catch (err) {
      if (!this.pending.has(id)) return; // discarded while running
      record.status = 'failed';
      record.extraction = { ...record.extraction, error: (err as Error).message, finishedAt: nowISO(), durationMs: Date.now() - started };
      await this.save(record);
    } finally {
      this.aborts.delete(id);
    }
  }

  /**
   * Read a PDF or image with the chosen engine, checked by a second reading when the settings ask
   * for one (docs/INGESTION.md, "Checking every figure"). For an upload, and for reading a stored
   * document again (the scratch directory is named by `scratchId`).
   */
  private async readDocument(
    record: ImportRecord,
    kind: 'pdf' | 'image',
    bytes: Buffer,
    source: string,
    opts: ProcessOptions,
    signal: AbortSignal,
    scratchId: string = record.id,
  ): Promise<{ result: EngineResult & { ocrText?: string; candidates?: { amounts: number[]; dates: string[] } }; engine: EngineId; engineVersion: string; verified?: Awaited<ReturnType<ImportService['verifyReading']>> | undefined }> {
    let result: EngineResult & { ocrText?: string; candidates?: { amounts: number[]; dates: string[] } };
    let engineVersion: string;
    let verified: Awaited<ReturnType<ImportService['verifyReading']>> | undefined;
    const settings = this.store.settings.extraction;
    const { engines, claudeBin } = await detectEngines({ apiKey: this.config.anthropicApiKey });
    const chosen = pickEngine(opts.engine ?? settings.engine, engines);
    if (!chosen) throw new Error('No extraction engine is available for PDFs and images. See Settings → Extraction.');
    const model = opts.model ?? settings.model;
    const scratch = await this.work.scratch(scratchId);
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
          signal,
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
        signal,
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
        const checked = await this.verifyReading(record, result, { model, verifyModel, readWith, batch: await this.batchEvidence(record) });
        result = checked.result;
        verified = checked;
      }
    }
    await this.work.clearScratch(scratchId);
    return { result, engine: chosen, engineVersion, verified };
  }

  // ─── Reading a stored document again (docs/INGESTION.md, "Reading a stored document again") ──

  /** A stored document's latest re-reading, if one was made. */
  getReread(importId: string): Reread | undefined {
    return this.rereads.get(importId);
  }

  listRereads(): Reread[] {
    return [...this.rereads.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Read a committed document again and compare the reading with what the import recorded. Nothing
   * in the data changes.
   * - A PDF or screenshot: with the current reader (and its check), in the background, only while
   *   reading stored documents again is turned on (it uses Claude).
   * - A CSV or spreadsheet: parsed again on this machine with the layout that fits it now, at once,
   *   whatever that setting says. Its rows pair with what they recorded by their line in the file.
   */
  async startReread(importId: string): Promise<Reread> {
    const record = await this.store.readImport(importId);
    if (!record || record.status !== 'committed' || !record.document.path) throw new StoreError('Only a committed import’s document can be read again.', 404);
    if (record.result?.nothingNew) throw new StoreError('This document was filed as adding nothing new: there is nothing recorded to compare with.', 409);
    if (this.rereads.get(importId)?.status === 'running') throw new StoreError('It is being read again already.', 409);
    const reread: Reread = { importId, status: 'running', startedAt: nowISO(), sections: [], notes: [], ...(record.extraction.engineVersion ? { previousVersion: record.extraction.engineVersion } : {}) };
    if (record.extraction.engine === 'csv') {
      await this.saveReread(reread);
      await this.runCsvReread(record, reread);
      return this.rereads.get(importId)!;
    }
    if (!['claude-cli', 'claude-api', 'ocr'].includes(record.extraction.engine ?? '')) throw new StoreError('OFX, QIF and Santander text files are parsed the same way every time: there is nothing new to read them with.', 409);
    if (!this.store.settings.extraction.rereadDocuments) throw new StoreError('Reading stored documents again is off: turn it on in Settings → Import & extraction.', 409);
    await this.saveReread(reread);
    void this.limiter.run(() => this.runReread(record, reread));
    return reread;
  }

  /**
   * A CSV or spreadsheet parsed again: with a layout that fits it now (one you saved, or a built-in
   * bank's), else the columns you chose for this import, else columns worked out afresh.
   */
  private async runCsvReread(record: ImportRecord, reread: Reread): Promise<void> {
    try {
      const bytes = await readFile(this.store.documentAbsPath(record.document.path!));
      const table = detectKind(record.document.fileName, bytes) === 'xlsx' ? sheetRows(bytes) : undefined;
      const { rows } = table ?? readCsvRows(decodeText(bytes));
      const match = findProfile(rows, this.store.csvProfiles);
      const own = !/auto-detected|holdings export/.test(record.extraction.detail ?? '') && record.mapping?.profile ? { profile: record.mapping.profile, headerIndex: record.mapping.headerIndex, headerless: false } : undefined;
      // The account it went to, as if you had pinned the upload to it.
      const accountIds = record.result?.accountIds ?? [];
      const ctx: ImportRecord = { ...record, ...(accountIds.length === 1 ? { hintAccountId: accountIds[0] } : {}) };
      let layout: string;
      let parsed: ReturnType<typeof parseWithProfile>;
      if (match) {
        parsed = parseWithProfile(rows, match);
        layout = `the ${match.profile.name} layout`;
      } else if (own) {
        parsed = parseWithProfile(rows, own);
        layout = 'the columns you chose';
      } else {
        if (parseHoldingsCsv(rows, record.document.fileName)) throw new Error('It lists holdings, not transactions: there are no rows to compare.');
        const suggestion = suggestMapping(rows, { accountType: ctx.hintAccountId ? this.store.account(ctx.hintAccountId)?.type : undefined });
        if (!suggestion) throw new Error('Could not find a date and description column in it.');
        parsed = parseWithProfile(rows, { profile: suggestion.profile, headerIndex: suggestion.headerIndex, headerless: false });
        layout = suggestion.profile.amountSign === 'inverted' ? 'columns worked out afresh, with card-style signs' : 'columns worked out afresh';
      }
      const draft = this.draftOf(ctx, { extraction: parsed.extraction, warnings: [] });
      const { sections, notes } = compareReading(this.store, record, draft, { byRow: true });
      await this.saveReread({ ...reread, status: 'done', finishedAt: nowISO(), engine: 'csv', engineVersion: table ? `${XLSX_ENGINE_VERSION}+${CSV_ENGINE_VERSION}` : CSV_ENGINE_VERSION, layout, sections, notes });
    } catch (err) {
      await this.saveReread({ ...reread, status: 'failed', finishedAt: nowISO(), error: (err as Error).message.slice(0, 500) });
    }
  }

  private async runReread(record: ImportRecord, reread: Reread): Promise<void> {
    const abort = new AbortController();
    try {
      const file = this.store.documentAbsPath(record.document.path!);
      const bytes = await readFile(file);
      const kind = detectKind(record.document.fileName, bytes);
      if (kind !== 'pdf' && kind !== 'image') throw new Error('Only PDFs and screenshots are read again.');
      // The account it went to, as if you had pinned the upload to it.
      const accountIds = record.result?.accountIds ?? [];
      const ctx: ImportRecord = { ...record, ...(accountIds.length === 1 ? { hintAccountId: accountIds[0] } : {}) };
      const read = await this.readDocument(ctx, kind, bytes, file, {}, abort.signal, `reread-${record.id}`);
      const draft = read.verified?.draft ?? this.draftOf(ctx, read.result);
      const { sections, notes } = compareReading(this.store, record, draft);
      await this.saveReread({
        ...reread,
        status: 'done',
        finishedAt: nowISO(),
        engine: read.engine,
        ...(read.result.model ? { model: read.result.model } : {}),
        engineVersion: read.engineVersion,
        costUsd: Math.round(((read.result.costUsd ?? 0) + (read.verified?.otherCostUsd ?? 0)) * 1000) / 1000,
        sections,
        notes: [...notes, ...read.result.warnings, ...(read.verified?.verification.disagreements.length ? [`The two readings disagreed: ${read.verified.verification.disagreements.join('; ')}`] : [])],
      });
    } catch (err) {
      await this.saveReread({ ...reread, status: 'failed', finishedAt: nowISO(), error: (err as Error).message.slice(0, 500) });
    }
  }

  /**
   * Apply one difference a re-reading found, as you chose: a changed row is corrected (what was
   * recorded is kept in its corrections), a row read now is added, a balance is set to the new
   * reading. Never a deletion: a row missing from the new reading is yours to look at.
   */
  async applyReread(importId: string, key: string): Promise<Reread> {
    const reread = this.rereads.get(importId);
    if (!reread || reread.status !== 'done') throw new StoreError('Nothing read again to apply.', 404);
    const record = await this.store.readImport(importId);
    if (!record) throw new StoreError('Unknown import', 404);
    const note = reread.layout ? `Read again with ${reread.layout}` : `Read again with ${reread.engineVersion ?? 'the current reader'}${reread.model ? ` (${shortModel(reread.model)})` : ''}`;
    const at = nowISO();
    for (const section of reread.sections) {
      if (key === `balance:${section.accountId}` && section.balance?.read && section.balance.changed && !section.balance.applied) {
        const b = section.balance;
        if (b.stored) await this.store.updateBalance(b.stored.id, { balance: b.read!.balance, date: b.read!.date, note: `${note}: was ${b.stored.balance.toFixed(2)} on ${b.stored.date}` }, `balance: ${section.accountName} read again`);
        else await this.store.addBalances([{ id: balanceId(section.accountId, b.read!.date, b.read!.balance, 'reread', importId), accountId: section.accountId, date: b.read!.date, balance: b.read!.balance, currency: this.store.account(section.accountId)?.currency ?? 'GBP', kind: record.document.mediaType.startsWith('image/') ? 'screenshot' : 'statement', dateSource: 'document', note, source: { importId, documentId: record.document.id }, createdAt: at }], `balance: ${section.accountName} read again`);
        b.applied = true;
        await this.saveReread(reread);
        return reread;
      }
      const row = section.rows.find((r) => r.key === key);
      if (!row || row.applied) continue;
      if (row.kind === 'changed' && row.stored && row.read) {
        const current = this.store.transaction(row.stored.id);
        if (!current) throw new StoreError('That transaction no longer exists.', 409);
        const fields = row.changes ?? [];
        const patch: Partial<Transaction> = { corrections: [...(current.corrections ?? []), ...fields.map((f) => ({ field: f, from: current[f], to: row.read![f], at, note }))] };
        for (const f of fields) (patch as Record<string, unknown>)[f] = row.read[f];
        if (row.read.type && !current.type) patch.type = row.read.type;
        // What was worked out from the old description or amount is worked out again, except what
        // you set yourself and what a transfer link decided.
        const account = this.store.account(current.accountId)!;
        const categoriser = new Categoriser(this.store.rules, new CategoryIndex(this.store.categories), this.store.accounts, this.store.institutions);
        const cat = categoriser.categorise({ accountId: account.id, description: row.read.description, amount: row.read.amount, bankCategory: current.bankCategory });
        if (current.payeeSetBy !== 'user' && cat.payee) patch.payee = cat.payee;
        if (!current.transferGroup && current.categorisedBy !== 'user' && current.categorisedBy !== 'transfer') {
          patch.category = cat.category;
          patch.categorisedBy = cat.categorisedBy;
          patch.ruleId = cat.ruleId;
        }
        await this.store.updateTransactions([{ id: current.id, patch }], `transaction: corrected from ${record.document.fileName} read again`);
        // Now it says where it went, it may be one leg of a transfer already recorded.
        if (!current.transferGroup && current.categorisedBy !== 'user') await linkTransfers(this.store, [current.id], `transaction: corrected from ${record.document.fileName} read again (transfer linked)`);
      } else if (row.kind === 'added' && row.read) {
        const account = this.store.account(section.accountId)!;
        const categoriser = new Categoriser(this.store.rules, new CategoryIndex(this.store.categories), this.store.accounts, this.store.institutions);
        const cat = categoriser.categorise({ accountId: account.id, description: row.read.description, amount: row.read.amount });
        let occurrence = 0;
        let id = transactionId(account.id, row.read.date, row.read.amount, row.read.description, occurrence, `${importId}:reread`);
        while (this.store.transaction(id)) id = transactionId(account.id, row.read.date, row.read.amount, row.read.description, ++occurrence, `${importId}:reread`);
        await this.store.addTransactions(
          [{ id, accountId: account.id, date: row.read.date, amount: row.read.amount, currency: account.currency, description: row.read.description, ...(cat.payee ? { payee: cat.payee } : {}), ...(cat.category ? { category: cat.category } : {}), ...(cat.categorisedBy ? { categorisedBy: cat.categorisedBy } : {}), notes: note, source: { importId, documentId: record.document.id }, createdAt: at }],
          `transaction: added from ${record.document.fileName} read again`,
        );
      } else {
        throw new StoreError('Only a changed row, a row read now, or a changed balance can be applied.', 409);
      }
      row.applied = true;
      await this.saveReread(reread);
      return reread;
    }
    throw new StoreError('Nothing to apply there.', 404);
  }

  async forgetReread(importId: string): Promise<void> {
    this.rereads.delete(importId);
    await this.work.removeReread(importId);
  }

  private async saveReread(reread: Reread): Promise<void> {
    this.rereads.set(reread.importId, reread);
    await this.work.saveReread(reread);
  }

  /** Rebuild the draft from the stored extraction (after adding accounts, rules, etc.). */
  async refreshDraft(id: string): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record?.extraction.raw) throw new StoreError('Nothing to refresh', 404);
    record.draft = this.rebuild(record, await this.batchEvidence(record));
    delete record.draftEditedAt;
    await this.save(record);
    if (record.document.image) await this.refreshBatch(record);
    return record;
  }

  /**
   * The draft again from the stored reading, as it would be built now: the rows the two readings
   * disagreed on are marked again, from the reading that was not kept.
   */
  private rebuild(record: ImportRecord, batch: BatchEvidence | undefined): Draft {
    const raw = record.extraction.raw!;
    const draft = this.draftOf(record, { extraction: raw, warnings: record.extraction.warnings }, batch);
    const v = record.extraction.verification;
    const other = record.extraction.alternative;
    if (v?.method === 'second-reading' && v.secondModel && other) {
      const otherDraft = this.draftOf(record, { extraction: other, warnings: [] }, batch);
      const [first, second] = [shortModel(v.firstModel), shortModel(v.secondModel)];
      markDisagreements(draft, compareReadings(otherDraft, draft, v.kept === 'second' ? { first, second } : { first: second, second: first }).rowNotes);
    }
    if (record.draft?.ocrText) draft.ocrText = record.draft.ocrText;
    if (record.draft?.candidates) draft.candidates = record.draft.candidates;
    return draft;
  }

  /**
   * The account a screenshot taken and uploaded with this one shows, as evidence for matching
   * (docs/INGESTION.md). The nearest such screenshots before and after it must agree: a batch can
   * move from one account's screens to another's.
   */
  async batchEvidence(record: ImportRecord): Promise<BatchEvidence | undefined> {
    const at = record.document.capturedAt ? Date.parse(record.document.capturedAt) : NaN;
    if (Number.isNaN(at) || !record.document.image) return undefined;
    const created = Date.parse(record.createdAt);
    const committed = await Promise.all(
      this.store.imports.filter((i) => i.mediaType.startsWith('image/') && Math.abs(Date.parse(i.createdAt) - created) <= UPLOADED_TOGETHER_MS).map((i) => this.store.readImport(i.id)),
    );
    const shown = [...[...this.pending.values()].filter((r) => r.status === 'review'), ...committed.filter((r): r is ImportRecord => r !== undefined)]
      .filter((r) => takenTogether(record, r))
      .flatMap((r) => {
        const accountId = accountShown(r);
        return accountId && this.store.account(accountId) ? [{ r, accountId, dt: Date.parse(r.document.capturedAt!) - at }] : [];
      });
    const before = shown.filter((x) => x.dt <= 0).sort((a, b) => b.dt - a.dt)[0];
    const after = shown.filter((x) => x.dt > 0).sort((a, b) => a.dt - b.dt)[0];
    if (before && after && before.accountId !== after.accountId) return undefined;
    const nearest = [before, after].filter((x) => x !== undefined).sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt))[0];
    if (!nearest) return undefined;
    return { accountId: nearest.accountId, importId: nearest.r.id, fileName: nearest.r.document.fileName, minutes: Math.round(-nearest.dt / 60_000) };
  }

  /**
   * A screenshot was read (or dropped, or its account chosen): the screenshots taken with it that
   * could use what it shows are drafted again. Never one you have edited.
   */
  private async refreshBatch(changed: ImportRecord): Promise<void> {
    for (const r of this.pending.values()) {
      if (r.status !== 'review' || !r.draft || !r.extraction.raw || r.draftEditedAt || !takenTogether(changed, r)) continue;
      if (!r.draft.batchMatch && r.draft.sections.every((s) => s.target.mode === 'existing')) continue;
      const evidence = await this.batchEvidence(r);
      const now = r.draft.batchMatch;
      if (evidence?.accountId === now?.accountId && (!evidence || evidence.importId === now?.importId)) continue;
      const next = this.rebuild(r, evidence);
      if (JSON.stringify(next) === JSON.stringify(r.draft)) continue;
      r.draft = next;
      await this.save(r);
    }
  }

  async updateDraft(id: string, draft: Draft): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record || record.status !== 'review') throw new StoreError('This import is not awaiting review.', 409);
    record.draft = DraftSchema.parse(draft);
    // Yours now: it is never drafted again by itself.
    record.draftEditedAt = nowISO();
    await this.save(record);
    await this.refreshBatch(record);
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
    const { rows } = detectKind(record.document.fileName, bytes) === 'xlsx' ? sheetRows(bytes) : readCsvRows(decodeText(bytes));
    const headerIndex = record.mapping?.headerIndex ?? 0;
    const parsed = parseWithProfile(rows, { profile, headerIndex, headerless: false });
    if (!parsed.rowCount) throw new StoreError('No rows could be read with this mapping; check the date and amount columns.');
    if (saveAs) {
      const saved: CsvProfile = {
        ...profile,
        id: slugify(saveAs, [...this.store.csvProfiles.map((p) => p.id), ...BUILTIN_CSV_PROFILES.map((p) => p.id)]),
        name: saveAs,
        builtin: false,
        headerSignature: (record.mapping?.headers ?? profile.headerSignature).filter(Boolean).map((h) => h.trim().toLowerCase()),
        createdAt: nowISO(),
      };
      await this.store.setCsvProfiles([...this.store.csvProfiles, saved], `csv profile: ${saveAs}`);
    }
    // Drafted afresh from the columns you chose, so the warning about ones worked out automatically
    // no longer applies.
    record.draft = this.draftOf(record, { extraction: parsed.extraction, warnings: [] });
    delete record.draftEditedAt;
    record.extraction = { ...record.extraction, engine: 'csv', engineVersion: CSV_ENGINE_VERSION, detail: saveAs ?? 'custom mapping', warnings: [], raw: parsed.extraction };
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
    // Rows another import has recorded since this draft was made are not recorded twice.
    const checked = recheckDraft(finalDraft, (accountId) => this.store.transactions(accountId));
    if (checked.toCheck.length) {
      record.draft = checked.draft;
      if (draft) record.draftEditedAt = nowISO();
      await this.save(record);
      const n = checked.toCheck.length;
      throw new StoreError(`${n} row${n === 1 ? '' : 's'} may already be recorded: another import added similar ${n === 1 ? 'one' : 'ones'} after this draft was made. ${n === 1 ? 'It is' : 'They are'} marked and left out; check, then commit.`, 409);
    }
    if (checked.alreadyStored) {
      const n = checked.alreadyStored;
      checked.draft.notes.push(`${n} row${n === 1 ? ' was' : 's were'} already recorded when this was committed (by another import, after this draft was made), so ${n === 1 ? 'it was' : 'they were'} left out.`);
    }
    const committed = await commitDraft(this.store, { record, draft: checked.draft, workFile: this.work.filePath(record.document) });
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    // Funds on it become instruments. The import is committed whatever happens here: the app
    // records any it missed when it next starts.
    if (committed.result?.holdingsAdded) {
      try {
        await recordInstrumentsFromHoldings(this.store);
      } catch (err) {
        console.warn(`[imports] ${id}: its funds were not recorded as instruments: ${(err as Error).message}`);
      }
    }
    this.emit('update', committed);
    return committed;
  }

  private draftOf(record: ImportRecord, result: Pick<EngineResult, 'extraction' | 'warnings'>, batch?: BatchEvidence): Draft {
    return buildDraft(result.extraction, { store: this.store, document: record.document, hintAccountId: record.hintAccountId, uploadedOn: record.createdAt.slice(0, 10), warnings: result.warnings, batch });
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
  private async verifyReading(record: ImportRecord, first: EngineResult, opts: { model: string; verifyModel: string; readWith: (m: string) => Promise<EngineResult>; batch?: BatchEvidence | undefined }) {
    const firstDraft = this.draftOf(record, first, opts.batch);
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
    const secondDraft = this.draftOf(record, second, opts.batch);
    const a2 = this.assess(record, secondDraft, second.warnings);
    const kept = chooseReading(a1, a2);
    const names = { first: shortModel(firstModel), second: shortModel(second.model ?? opts.verifyModel) };
    const [keptResult, keptDraft, other, otherDraft] = kept === 'second' ? [second, secondDraft, first, firstDraft] : [first, firstDraft, second, secondDraft];
    const cmp = kept === 'second' ? compareReadings(otherDraft, keptDraft, { first: names.first, second: names.second }) : compareReadings(otherDraft, keptDraft, { first: names.second, second: names.first });
    markDisagreements(keptDraft, cmp.rowNotes);
    return {
      result: keptResult,
      draft: keptDraft,
      otherCostUsd: other.costUsd ?? 0,
      alternative: other.extraction,
      verification: { method: 'second-reading' as const, firstModel, secondModel: second.model ?? opts.verifyModel, reasons, disagreements: cmp.disagreements, kept },
    };
  }

  /** The imports waiting for review that add nothing new, and why (./novelty.ts). */
  novelty(): Map<string, NothingNew> {
    return assessNovelty([...this.pending.values()], this.store);
  }

  /**
   * Put away an import that adds nothing new: its document is archived with the other documents
   * and its import record says why, and nothing else is written. It must still add nothing now.
   */
  async dismiss(id: string): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record?.draft || record.status !== 'review') throw new StoreError('Only an import waiting for review can be dismissed.', 409);
    const nothing = this.novelty().get(id);
    if (!nothing) throw new StoreError('This import has something new now: review it instead.', 409);
    const draft: Draft = {
      ...record.draft,
      // Nothing is created either: a section that would have made a new account is left out.
      sections: record.draft.sections.map((s) => ({ ...s, ...(s.target.mode === 'new' ? { target: { mode: 'skip' as const } } : {}), recordBalance: false, recordHoldings: false, transactions: s.transactions.map((t) => ({ ...t, include: false })) })),
      figures: record.draft.figures.map((f) => ({ ...f, include: false })),
    };
    const filed = await commitDraft(this.store, { record, draft, workFile: this.work.filePath(record.document), nothingNew: nothing.reason });
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    this.emit('update', filed);
    return filed;
  }

  /** Dismiss every import that adds nothing new. The ones that cover them stay. */
  async dismissNothingNew(): Promise<string[]> {
    const done: string[] = [];
    for (const id of this.novelty().keys()) {
      if (this.novelty().has(id)) {
        await this.dismiss(id);
        done.push(id);
      }
    }
    return done;
  }

  /** Why an import is (not) safe to commit without review. */
  readiness(record: ImportRecord, nothingNew?: NothingNew): { ready: boolean; reasons: string[] } {
    if (record.status !== 'review' || !record.draft) return { ready: false, reasons: [record.status] };
    // Nothing to commit: it is dismissed, not committed.
    if (nothingNew) return { ready: false, reasons: ['nothing new'] };
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
    const novelty = this.novelty();
    for (const record of this.listPending()) {
      if (record.status !== 'review') continue;
      const r = this.readiness(record, novelty.get(record.id));
      if (!r.ready) {
        skipped.push({ id: record.id, reasons: r.reasons });
        continue;
      }
      try {
        await this.commit(record.id);
        committed.push(record.id);
      } catch (err) {
        // Rows another import recorded meanwhile, to check: it waits for you like any other.
        if (!(err instanceof StoreError) || err.status !== 409) throw err;
        skipped.push({ id: record.id, reasons: ['possible duplicates to check'] });
      }
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
    // Screenshots that took their account from it no longer can.
    await this.refreshBatch(record);
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

/** Mark the rows two readings disagreed on, so they are checked against the document. */
function markDisagreements(draft: Draft, rowNotes: Map<string, string>): void {
  for (const s of draft.sections) {
    for (const t of s.transactions) {
      const n = rowNotes.get(t.key);
      if (n) t.uncertain = (t.uncertain ? `${t.uncertain}; ${n}` : n).slice(0, 300);
    }
  }
}

