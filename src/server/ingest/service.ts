// The import pipeline: upload → (queue) → parse or extract → draft → review → commit.

import { EventEmitter } from 'node:events';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '../../shared/accounts';
import type { DraftLinkView, LinkCandidate, Reread } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import { findInstitution } from '../../shared/institutions';
import { today } from '../../shared/dates';
import { formatMoney, toMinor } from '../../shared/money';
import { sectionChecks } from '../../shared/review';
import {
  CsvProfileSchema,
  DraftSchema,
  type CsvProfile,
  type Draft,
  type DraftSection,
  type DraftTransaction,
  type EngineId,
  type Extraction,
  type ExtractionEnginePreference,
  type ImportRecord,
  type Transaction,
} from '../../shared/schema';
import { currentActor, runAs } from '../audit';
import { categoriserFor } from '../categoriser';
import type { Config } from '../config';
import { Limiter, nowISO, sha256 } from '../fsutil';
import { balanceId, documentId, importId, transactionId } from '../ids';
import { recordInstrumentsFromHoldings } from '../instruments';
import type { SessionEngine, SessionRecord } from '../../shared/sessions';
import type { SessionLog, TranscriptSink } from '../sessions';
import { StoreError, type ImportSummary, type Store } from '../store';
import { extractWithClaudeApi } from './claude-api';
import { extractWithClaudeCli } from './claude-cli';
import { GOVUK_ENGINE_VERSION, pdfText, readGovUkPage } from './govuk';
import { PAYSLIP_ENGINE_VERSION, readPayslipPage } from './payslips';
import { commitDraft } from './commit';
import { linkTransfers } from '../enrich';
import { BUILTIN_CSV_PROFILES } from './csv-profiles';
import { candidateOf, classifyDuplicates, recheckDraft } from './dedup';
import { compareReading } from './reread';
import { CSV_ENGINE_VERSION, findProfile, parseWithProfile, readCsvRows, suggestMapping, withCardSigns } from './csv';
import { HOLDINGS_CSV_VERSION, parseHoldingsCsv } from './holdings-csv';
import { PENSION_CSV_VERSION, parseContributionsCsv, parseFundTradesCsv } from './pension-csv';
import { decodeText, detectKind, MAX_UPLOAD_BYTES, mediaTypeFor } from './detect';
import { buildDraft, draftIsClean, exportDate, type BatchEvidence } from './draft';
import { asTransferLeg, findRow, keepLinks, keepYourLinks, linkCandidates, linkViews, replaceRow, sameAccount, sectionAccount, withoutLink, type FoundRow, type RowRef, type SectionAccount } from './links';
import { assessNovelty, mentionedPayments, type NothingNew } from './novelty';
import { assessReading, chooseReading, compareReadings, shortModel } from './verify';
import { claudeEngine, detectEngines, engineAvailable, type AiEngineId, type EngineResult, type EngineStatus } from './engines';
import { extractWithInference } from './inference-read';
import { InferenceFailed, InferenceUnavailable } from '../inference';
import { claudeChoice, choiceName, isInferenceAlias, resolveTask, TASKS, type TaskChoice, type TaskEngine } from '../../shared/tasks';
import { captureDate, imageInfo, prepareImage } from './images';
import { extractWithOcr, OCR_ENGINE_VERSION } from './ocr';
import { OFX_ENGINE_VERSION, parseOfx } from './ofx';
import { extractionJsonSchema, readerVersion, systemPrompt, userPrompt } from './prompt';
import { parseQif, QIF_ENGINE_VERSION } from './qif';
import { parseSantanderTxt, SANTANDER_ENGINE_VERSION } from './santander';
import { WorkArea } from './workarea';
import { checkEarnedPay } from './timesheet';
import { looksLikeLedger, sheetRows, workbookSheets, workbookText, XLSX_ENGINE_VERSION, type Sheet } from './xlsx';

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

const CARD_STYLE_WARNING = 'The amounts were read card style, money out positive: the file is for a credit card, and its purchases and payments only have the right signs that way round.';

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

/** The provider, of those listed, whose document a reading says this is (by name, or Premium Bonds). */
function weakProvider(extraction: Extraction, providers: string[]): string | undefined {
  if (!providers.length) return undefined;
  const names = [extraction.institutionName, ...extraction.accounts.map((a) => a.institutionName)];
  for (const n of names) {
    const inst = findInstitution(n);
    if (inst && providers.includes(inst.id)) return inst.name;
  }
  if (providers.includes('ns-and-i') && extraction.accounts.some((a) => a.accountType === 'premium_bonds')) return 'NS&I';
  return undefined;
}

/**
 * A reading's reader, as a verification records it: Claude's model id (shortened to "Sonnet" where
 * it is shown), or the local model's alias ("vision-extract", "vision-extract, thinking").
 */
function readerName(c: TaskChoice, r: EngineResult): string {
  if ((r.engine ?? c.engine) === 'inference') return choiceName({ engine: 'inference', model: r.inference?.alias ?? c.model, thinking: r.inference?.thinking ?? c.thinking });
  return r.model ?? c.model;
}

export interface ProcessOptions {
  engine?: ExtractionEnginePreference | undefined;
  model?: string | undefined;
  /** The model that checks the reading; empty to skip the check. Defaults to the setting. */
  verifyModel?: string | undefined;
  /**
   * A spreadsheet: read by Claude like a document, or its columns mapped like a CSV. Unset, a
   * spreadsheet that is not a list of payments is read by Claude (ingest/xlsx.ts, `looksLikeLedger`).
   */
  readAs?: 'document' | 'columns' | undefined;
  /** Who asked for the reading, and why (its Claude sessions say so). Set by the service. */
  startedBy?: SessionRecord['startedBy'] | undefined;
}

/**
 * A PDF read from its text on this machine: one of HMRC's gov.uk pages (ingest/govuk.ts), or a
 * payslip in a layout known here (ingest/payslips.ts). Null for anything else, which Claude reads.
 */
async function readTextPdf(file: string): Promise<{ extraction: Extraction; engine: 'govuk' | 'payslip'; engineVersion: string; detail: string } | null> {
  const text = await pdfText(file, path.dirname(file));
  if (!text) return null;
  const govuk = readGovUkPage(text);
  if (govuk) return { extraction: govuk, engine: 'govuk', engineVersion: GOVUK_ENGINE_VERSION, detail: 'gov.uk page, read on this machine' };
  const payslip = readPayslipPage(text);
  if (payslip) return { extraction: payslip.extraction, engine: 'payslip', engineVersion: PAYSLIP_ENGINE_VERSION, detail: `${payslip.layout === 'sap' ? 'SAP paystub' : 'payslip'}, read on this machine` };
  return null;
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
    /** Where each Claude reading is recorded, with its transcript (sessions.ts). */
    private readonly sessions?: SessionLog,
  ) {
    super();
    this.limiter = new Limiter(store.settings.extraction.maxConcurrent);
  }

  async init(): Promise<void> {
    await this.work.init();
    for (const r of await this.work.loadAll()) {
      this.pending.set(r.id, r);
      if (r.status === 'queued' || r.status === 'processing') this.schedule(r.id, { startedBy: { actor: { type: 'app', task: 'start-up' }, reason: 'An upload not yet read when the app stopped' } });
    }
    for (const r of await this.work.loadRereads()) {
      // A reading the app stopped in the middle of is not coming back.
      this.rereads.set(r.importId, r.status === 'running' ? { ...r, status: 'failed', error: 'Stopped when the app restarted: read it again.' } : r);
    }
    await this.redraftWaiting();
  }

  /**
   * Drafts you have not edited are drafted again from their readings when the app starts, so what a
   * newer version matches, categorises or checks applies to imports already waiting; after a commit
   * sets up an account or a job, teaches a job, adds HMRC's records or records an agreement, so they
   * can match them; and after a proposal you applied changes an account or adds an agreement (an
   * account linked to the one it carries on from splits a statement waiting). Nothing is read
   * again, and a draft you saved changes to is left alone.
   */
  async redraftWaiting(): Promise<void> {
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
    const from = { upload: 'Uploaded', inbox: 'Dropped in the inbox folder', cli: 'Queued with npm run import' }[input.origin];
    this.schedule(record.id, { startedBy: { actor: currentActor(), reason: `${from}: ${record.document.fileName}` } });
    return { record };
  }

  private schedule(id: string, opts: ProcessOptions = {}): void {
    this.limiter.setLimit(this.store.settings.extraction.maxConcurrent);
    // Reading is the app's work (the audit log), whoever's upload queued it.
    void this.limiter.run(() => runAs({ type: 'app', task: 'reading imports' }, () => this.process(id, opts)));
  }

  async reprocess(id: string, opts: ProcessOptions & { interrupt?: boolean } = {}): Promise<ImportRecord> {
    const record = this.pending.get(id);
    if (!record) throw new StoreError('Only imports that have not been committed can be re-processed.', 404);
    // Read it another way now (Read with Claude while the local model is busy or away): the reading
    // under way is stopped first.
    if (record.status === 'processing' && opts.interrupt) {
      this.aborts.get(id)?.abort();
      for (let i = 0; i < 100 && this.pending.get(id)?.status === 'processing'; i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (record.status === 'processing') throw new StoreError('Already processing.', 409);
    record.status = 'queued';
    record.extraction = { warnings: [] };
    delete record.draft;
    delete record.draftEditedAt;
    delete record.mapping;
    await this.save(record);
    this.schedule(id, { ...opts, startedBy: { actor: currentActor(), reason: `Read again before review${opts.readAs ? ` (as ${opts.readAs === 'document' ? 'a document' : 'columns'})` : ''}${opts.model ? ` with ${opts.model}` : ''}` } });
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
      // A spreadsheet that is not a list of payments (a timesheet, a sheet a month) is read by Claude,
      // like a PDF, when Claude is available; otherwise its first table is mapped like a CSV.
      let sheets: Sheet[] | undefined;
      let noClaude: string | undefined;
      let local: Awaited<ReturnType<typeof readTextPdf>> = null;
      if (kind === 'xlsx' && opts.readAs !== 'columns') {
        const { rows } = sheetRows(bytes);
        const known = opts.readAs === 'document' ? false : Boolean(findProfile(rows, this.store.csvProfiles) ?? parseFundTradesCsv(rows) ?? parseHoldingsCsv(rows, record.document.fileName) ?? parseContributionsCsv(rows, record.document.fileName));
        if (!known) {
          const all = workbookSheets(bytes);
          if (opts.readAs === 'document' || !looksLikeLedger(suggestMapping(rows, { accountType: record.hintAccountId ? this.store.account(record.hintAccountId)?.type : undefined }), all.length)) {
            if (await this.modelReaderAvailable(opts)) sheets = all;
            else if (opts.readAs === 'document') throw new Error('Reading a spreadsheet as a document needs a model: see Settings → Models.');
            else noClaude = 'This spreadsheet does not look like a list of payments, but no model is set up to read it: map its columns, or choose a model in Settings → Models and read it again.';
          }
        }
      }
      if (sheets) {
        const read = await this.readDocument(record, 'sheet', bytes, this.work.filePath(record.document), opts, abort.signal, record.id, sheets);
        ({ result, engine, engineVersion, verified } = read);
        detail = `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}${result.model ? `, ${result.model}` : ''}`;
      } else if (kind === 'csv' || kind === 'xlsx') {
        // A spreadsheet's first table goes through the same profiles and mapping as a CSV.
        const table = kind === 'xlsx' ? sheetRows(bytes) : undefined;
        const { rows } = table ?? readCsvRows(decodeText(bytes));
        const match = findProfile(rows, this.store.csvProfiles);
        // An export with no date in it is as at the day it was downloaded.
        const asOf = exportDate(record.document, record.createdAt.slice(0, 10))?.date;
        // A pension or fund provider's trades, with their units and prices.
        const trades = match ? null : parseFundTradesCsv(rows, { asOf });
        // A platform's portfolio export lists holdings, not transactions.
        const holdings = match || trades ? null : parseHoldingsCsv(rows, record.document.fileName);
        // A provider's summary of what you and your employer have paid in.
        const contributions = match || trades || holdings ? null : parseContributionsCsv(rows, record.document.fileName, { asOf });
        const own = trades ?? contributions;
        if (holdings) {
          result = { extraction: holdings, warnings: [], durationMs: Date.now() - started };
          detail = 'holdings export';
        } else if (own) {
          result = { extraction: own, warnings: [], durationMs: Date.now() - started };
          detail = trades ? 'fund trades' : 'contributions summary';
        } else if (match) {
          const layout = withCardSigns(rows, match, record.hintAccountId ? this.store.account(record.hintAccountId)?.type : undefined);
          const parsed = parseWithProfile(rows, layout);
          const flipped = layout.profile.amountSign !== match.profile.amountSign;
          result = { extraction: parsed.extraction, warnings: flipped ? [CARD_STYLE_WARNING] : [], durationMs: Date.now() - started };
          // Signs chosen for you can be changed on the review page, as with columns worked out.
          if (flipped) record.mapping = { profile: layout.profile, headers: rows[layout.headerIndex]!, sample: rows.slice(layout.headerIndex + 1).filter((r) => r.length >= 2).slice(0, 8), headerIndex: layout.headerIndex };
          detail = match.profile.id;
        } else {
          const suggestion = suggestMapping(rows, { accountType: record.hintAccountId ? this.store.account(record.hintAccountId)?.type : undefined });
          if (!suggestion) throw new Error(noClaude ?? 'Could not find a date and description column in this CSV.');
          if (!suggestion.confident) {
            record.mapping = { profile: suggestion.profile, headers: suggestion.headers, sample: suggestion.sample, headerIndex: suggestion.headerIndex };
            record.status = 'needs_mapping';
            record.extraction = { ...record.extraction, engine: 'csv', finishedAt: nowISO(), durationMs: Date.now() - started, ...(noClaude ? { warnings: [noClaude] } : {}) };
            await this.save(record);
            return;
          }
          const parsed = parseWithProfile(rows, { profile: suggestion.profile, headerIndex: suggestion.headerIndex, headerless: false });
          result = {
            extraction: parsed.extraction,
            warnings: [
              'This CSV layout was not recognised; columns were detected automatically. Check signs and dates carefully, then save the mapping for next time.',
              ...(noClaude ? [noClaude] : []),
              ...(suggestion.profile.amountSign === 'inverted' ? [CARD_STYLE_WARNING] : []),
            ],
            durationMs: Date.now() - started,
          };
          record.mapping = { profile: suggestion.profile, headers: suggestion.headers, sample: suggestion.sample, headerIndex: suggestion.headerIndex };
          detail = 'auto-detected';
        }
        engine = 'csv';
        engineVersion = holdings ? HOLDINGS_CSV_VERSION : own ? PENSION_CSV_VERSION : CSV_ENGINE_VERSION;
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
      } else if (kind === 'pdf' && (local = await readTextPdf(this.work.filePath(record.document)))) {
        // One of HMRC's gov.uk pages or a known payslip, read from its text on this machine.
        result = { extraction: local.extraction, warnings: [], durationMs: Date.now() - started };
        engine = local.engine;
        engineVersion = local.engineVersion;
        detail = local.detail;
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
      // Read again: the links you made stay on rows that are still the same payment.
      record.draft = keepYourLinks(record.draft, draft);
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
        ...(result.inference ? { inference: result.inference } : {}),
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

  /** Can a model read documents now (a spreadsheet that is not a list of payments needs one)? */
  private async modelReaderAvailable(opts: ProcessOptions): Promise<boolean> {
    const { engines } = await detectEngines(this.engineOpts());
    const { read } = this.readChoices(opts, engines);
    if (read.engine === 'ocr' || read.engine === 'off') return false;
    // The local model counts while it is set up: work for it waits when it is down.
    if (read.engine === 'inference') return Boolean(this.config.inference) || (read.fallback && claudeEngine(engines) !== null);
    return claudeEngine(engines) !== null;
  }

  private engineOpts() {
    return { apiKey: this.config.anthropicApiKey, inference: this.config.inference };
  }

  /**
   * The models that read and check a document: Settings → Models (src/shared/tasks.ts), unless
   * this reading asks for others. An engine asked for (Read with Claude) reads and checks with it;
   * a model asked for picks its engine (an alias of the local model, or Claude's); `verifyModel`
   * empty turns the check off.
   */
  readChoices(opts: Pick<ProcessOptions, 'engine' | 'model' | 'verifyModel'>, engines: EngineStatus[]): { read: TaskChoice; check: TaskChoice } {
    const tasks = this.store.settings.models.tasks;
    let read = resolveTask('read-document', tasks);
    let check = resolveTask('check-reading', tasks);
    const claudeEng = claudeEngine(engines) ?? 'claude-cli';
    const engineOf = (model: string): TaskEngine => (isInferenceAlias(model) ? 'inference' : claudeEng);
    const forced = opts.engine && opts.engine !== 'auto' ? opts.engine : opts.model ? engineOf(opts.model) : undefined;
    if (forced) {
      read = resolveTask('read-document', { 'read-document': { engine: forced, ...(opts.model ? { model: opts.model } : {}) } });
      if (forced !== 'inference' && forced !== 'ocr' && forced !== 'off' && check.engine !== 'off') check = claudeChoice('check-reading', forced);
    }
    if (opts.verifyModel !== undefined) check = opts.verifyModel === '' ? { ...check, engine: 'off' } : resolveTask('check-reading', { 'check-reading': { engine: engineOf(opts.verifyModel), model: opts.verifyModel } });
    return { read, check };
  }

  /**
   * Read a PDF, image or spreadsheet (its sheets as text) with the model Settings → Models gives
   * reading documents, checked by a second reading when the checks ask for one (docs/INGESTION.md,
   * "Checking every figure"). For an upload, and for reading a stored document again (the scratch
   * directory is named by `scratchId`). Work for the local model waits while it cannot take it,
   * and falls back to Claude only where Settings → Models allows that.
   */
  private async readDocument(
    record: ImportRecord,
    kind: 'pdf' | 'image' | 'sheet',
    bytes: Buffer,
    source: string,
    opts: ProcessOptions,
    signal: AbortSignal,
    scratchId: string = record.id,
    sheets?: Sheet[],
    sessionKind: 'reading' | 'reread' = 'reading',
  ): Promise<{ result: EngineResult & { ocrText?: string; candidates?: { amounts: number[]; dates: string[] } }; engine: EngineId; engineVersion: string; verified?: Awaited<ReturnType<ImportService['verifyReading']>> | undefined }> {
    let result: EngineResult & { ocrText?: string; candidates?: { amounts: number[]; dates: string[] } };
    let engineVersion: string;
    let verified: Awaited<ReturnType<ImportService['verifyReading']>> | undefined;
    const settings = this.store.settings.extraction;
    const { engines, claudeBin } = await detectEngines(this.engineOpts());
    const choices = this.readChoices(opts, engines);
    let readChoice = choices.read;
    let checkChoice = choices.check;
    if (kind === 'sheet' && readChoice.engine === 'ocr') throw new Error('A spreadsheet that is not a list of payments is read by a model, and documents are set to offline OCR. See Settings → Models.');
    const scratch = await this.work.scratch(scratchId);
    let files: { path: string; mediaType: string }[];
    let tiled = false;
    if (kind === 'image') {
      const prepared = await prepareImage(bytes, scratch, 'page');
      files = prepared.files.map((p) => ({ path: p, mediaType: 'image/png' }));
      tiled = prepared.tiled;
    } else if (kind === 'sheet') {
      sheets ??= workbookSheets(bytes);
      const p = path.join(scratch, 'workbook.txt');
      await writeFile(p, workbookText(sheets, record.document.fileName), 'utf8');
      files = [{ path: p, mediaType: 'text/plain' }];
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
      spreadsheet: kind === 'sheet',
    };
    const timeoutMs = settings.timeoutSeconds * 1000;
    // Everything the document prints, when that is turned on (prompt.ts, extract-14).
    const everything = settings.readEverything;
    const engineVersionOf = (local = false) => (kind === 'sheet' ? `${XLSX_ENGINE_VERSION}+${readerVersion(everything, local)}` : readerVersion(everything, local));
    // While the local model cannot take the reading, the import says so (an upload only).
    const onWait =
      sessionKind === 'reading'
        ? (w: { reason: string; until?: string }) => {
            if (!this.pending.has(record.id)) return;
            record.extraction = { ...record.extraction, waiting: { since: record.extraction.waiting?.since ?? nowISO(), reason: `The local model cannot take it yet: ${w.reason}`, ...(w.until ? { until: w.until } : {}) } };
            void this.save(record);
          }
        : undefined;
    const readOnce = async (c: TaskChoice, task: 'read-document' | 'check-reading', engine: AiEngineId, transcript: TranscriptSink | undefined): Promise<EngineResult> => {
      if (engine === 'inference') {
        const def = TASKS[task];
        return extractWithInference({
          cfg: this.config.inference,
          files,
          scratch,
          userPrompt: userPrompt(promptCtx),
          systemPrompt: systemPrompt(everything, true),
          schema: extractionJsonSchema(everything),
          alias: c.model,
          thinking: c.thinking,
          priority: def.priority,
          runMinutes: def.runMinutes,
          maxTokens: def.maxTokens,
          signal,
          transcript,
          onWait,
        });
      }
      if (engine === 'claude-cli') {
        if (!claudeBin) throw new Error('claude CLI not found');
        const r = await extractWithClaudeCli({
          bin: claudeBin,
          cwd: scratch,
          userPrompt: userPrompt({ ...promptCtx, files: files.map((f) => `./${path.basename(f.path)}`) }),
          systemPrompt: systemPrompt(everything),
          schema: extractionJsonSchema(everything),
          model: c.model,
          effort: c.effort,
          timeoutMs,
          signal,
          transcript,
        });
        return { ...r, engine };
      }
      if (!this.config.anthropicApiKey) throw new Error('No ANTHROPIC_API_KEY is set for the Claude API.');
      const r = await extractWithClaudeApi({
        apiKey: this.config.anthropicApiKey,
        files,
        userPrompt: userPrompt(promptCtx),
        systemPrompt: systemPrompt(everything),
        schema: extractionJsonSchema(everything),
        model: c.model,
        effort: c.effort,
        timeoutMs,
        signal,
        transcript,
      });
      return { ...r, engine };
    };
    // Each reading is a session of its own, with its transcript (sessions.ts).
    let lastSession: string | undefined;
    const session = async (c: TaskChoice, engine: AiEngineId, role: 'first' | 'second', task: 'read-document' | 'check-reading', fallback?: { fallbackOf?: string; fallbackReason: string }): Promise<EngineResult> => {
      const s = await this.sessions?.start({
        kind: sessionKind,
        title: `${role === 'first' ? (sessionKind === 'reread' ? 'Read again' : 'Read') : 'Check by a second reading of'} ${record.document.fileName}`,
        role,
        importId: record.id,
        engine: engine as SessionEngine,
        model: c.model,
        ...(engine === 'inference' ? { thinking: c.thinking } : { effort: c.effort }),
        promptVersion: engineVersionOf(engine === 'inference'),
        tools: engine === 'claude-cli' ? ['Read'] : [],
        privacy: 'personal',
        ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
        ...(fallback?.fallbackOf ? { fallbackOf: fallback.fallbackOf } : {}),
        ...(fallback ? { fallbackReason: fallback.fallbackReason } : {}),
      });
      lastSession = s?.id;
      const run = (transcript: TranscriptSink | undefined) => readOnce(c, task, engine, transcript);
      return s ? s.run(run, signal) : run(undefined);
    };
    // A reading by the chosen model; by Claude instead when the local model cannot and the task allows it.
    const readWith = async (c: TaskChoice, role: 'first' | 'second', task: 'read-document' | 'check-reading' = role === 'first' ? 'read-document' : 'check-reading'): Promise<EngineResult> => {
      const claudeEng = claudeEngine(engines);
      const engine: AiEngineId = c.engine === 'claude-cli' || c.engine === 'claude-api' ? (engineAvailable(engines, c.engine) ? c.engine : (claudeEng ?? c.engine)) : (c.engine as AiEngineId);
      try {
        return await session(c, engine, role, task);
      } catch (err) {
        if (engine !== 'inference' || !c.fallback || signal.aborted || !(err instanceof InferenceUnavailable || err instanceof InferenceFailed)) throw err;
        if (!claudeEng) throw new Error(`${err.message} Claude is not available to read it instead.`);
        const r = await session(claudeChoice(task, claudeEng), claudeEng, role, task, { ...(lastSession ? { fallbackOf: lastSession } : {}), fallbackReason: err.message });
        return { ...r, notices: [`${err.message} Claude read it instead, as Settings → Models allows for ${TASKS[task].label.toLowerCase()}.`, ...(r.notices ?? [])] };
      } finally {
        if (record.extraction.waiting) {
          delete record.extraction.waiting;
          if (this.pending.has(record.id)) await this.save(record);
        }
      }
    };
    if (readChoice.engine === 'ocr') {
      result = await extractWithOcr(files[0]!, scratch, Number(today().slice(0, 4)));
      engineVersion = OCR_ENGINE_VERSION;
    } else {
      // A provider the local model reads poorly (Settings → Models, read-document's claudeFor): known
      // before reading when the document was dropped onto its account, else from the reading itself.
      const claudeEng = claudeEngine(engines);
      const toClaude = (why: string) => {
        readChoice = claudeChoice('read-document', claudeEng!);
        if (checkChoice.engine !== 'off') checkChoice = claudeChoice('check-reading', claudeEng!);
        return why;
      };
      let routed: string | undefined;
      // The account's provider by its catalogue id ("ns-and-i"); Premium Bonds are NS&I's whatever they are named.
      const hintProvider = !hint ? undefined : hint.type === 'premium_bonds' ? 'ns-and-i' : findInstitution((hint.institutionId ? this.store.institution(hint.institutionId)?.name : undefined) ?? hint.name)?.id;
      if (readChoice.engine === 'inference' && claudeEng && hintProvider && readChoice.claudeFor.includes(hintProvider)) routed = toClaude(`Claude read it: it was dropped onto ${hint!.name}, and Settings → Models has Claude read that provider's documents.`);
      result = await readWith(readChoice, 'first');
      const weak = readChoice.engine === 'inference' && result.engine === 'inference' ? weakProvider(result.extraction, readChoice.claudeFor) : undefined;
      if (weak) {
        if (claudeEng) {
          routed = toClaude(`The local model read it as ${weak}'s, whose documents Claude reads (Settings → Models): Claude read it again, and its reading is the one kept.`);
          result = await readWith(readChoice, 'first');
        } else result = { ...result, notices: [`It is ${weak}'s, whose documents Claude reads (Settings → Models), but Claude is not available: the local model's reading is kept.`, ...(result.notices ?? [])] };
      }
      if (routed) result = { ...result, notices: [routed, ...(result.notices ?? [])] };
      engineVersion = engineVersionOf(result.engine === 'inference');
      const same = checkChoice.engine === readChoice.engine && checkChoice.model === readChoice.model && checkChoice.thinking === readChoice.thinking;
      if (checkChoice.engine !== 'off' && !same) {
        const checked = await this.verifyReading(record, result, { read: readChoice, check: checkChoice, readWith, batch: await this.batchEvidence(record), sheets, claudeAvailable: claudeEngine(engines) });
        result = checked.result;
        verified = checked;
      }
      // What the spreadsheet's own cells still contradict in the reading kept, for the review page.
      if (sheets) {
        const kept = verified?.draft ?? this.draftOf(record, result);
        const problems = checkEarnedPay(kept.figures, sheets).problems;
        if (problems.length) result = { ...result, warnings: [...result.warnings, ...problems] };
      }
    }
    await this.work.clearScratch(scratchId);
    // What was put right or done another way goes with the warnings, once the checks are done.
    if (result.notices?.length) result = { ...result, warnings: [...result.notices, ...result.warnings] };
    // The reading kept may be the check's, on another engine: its version is the one recorded.
    if (readChoice.engine !== 'ocr') engineVersion = engineVersionOf(result.engine === 'inference');
    return { result, engine: result.engine ?? (readChoice.engine as EngineId), engineVersion, verified };
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
    if (!this.store.settings.extraction.rereadDocuments) throw new StoreError('Reading stored documents again is off: turn it on in Settings → Models & import.', 409);
    await this.saveReread(reread);
    const startedBy = { actor: currentActor(), reason: 'Read a stored document again, to compare with what was recorded' };
    void this.limiter.run(() => this.runReread(record, reread, startedBy));
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
      let trades: Extraction | null;
      if (match) {
        const signed = withCardSigns(rows, match, ctx.hintAccountId ? this.store.account(ctx.hintAccountId)?.type : undefined);
        parsed = parseWithProfile(rows, signed);
        layout = `the ${match.profile.name} layout${signed.profile.amountSign !== match.profile.amountSign ? ', with card-style signs' : ''}`;
      } else if (own) {
        parsed = parseWithProfile(rows, own);
        layout = 'the columns you chose';
      } else if ((trades = parseFundTradesCsv(rows, { asOf: exportDate(record.document, record.createdAt.slice(0, 10))?.date }))) {
        parsed = { extraction: trades, rowCount: trades.accounts[0]!.transactions.length, skipped: 0 };
        layout = 'a fund trade history';
      } else {
        if (parseHoldingsCsv(rows, record.document.fileName)) throw new Error('It lists holdings, not transactions: there are no rows to compare.');
        if (parseContributionsCsv(rows, record.document.fileName)) throw new Error('It sums up contributions, not transactions: there are no rows to compare.');
        const suggestion = suggestMapping(rows, { accountType: ctx.hintAccountId ? this.store.account(ctx.hintAccountId)?.type : undefined });
        if (!suggestion) throw new Error('Could not find a date and description column in it.');
        parsed = parseWithProfile(rows, { profile: suggestion.profile, headerIndex: suggestion.headerIndex, headerless: false });
        layout = suggestion.profile.amountSign === 'inverted' ? 'columns worked out afresh, with card-style signs' : 'columns worked out afresh';
      }
      const draft = this.draftOf(ctx, { extraction: parsed.extraction, warnings: [] });
      const { sections, notes } = compareReading(this.store, record, draft, { byRow: true });
      const version = layout === 'a fund trade history' ? PENSION_CSV_VERSION : CSV_ENGINE_VERSION;
      await this.saveReread({ ...reread, status: 'done', finishedAt: nowISO(), engine: 'csv', engineVersion: table ? `${XLSX_ENGINE_VERSION}+${version}` : version, layout, sections, notes });
    } catch (err) {
      await this.saveReread({ ...reread, status: 'failed', finishedAt: nowISO(), error: (err as Error).message.slice(0, 500) });
    }
  }

  private async runReread(record: ImportRecord, reread: Reread, startedBy: SessionRecord['startedBy']): Promise<void> {
    const abort = new AbortController();
    try {
      const file = this.store.documentAbsPath(record.document.path!);
      const bytes = await readFile(file);
      const kind = detectKind(record.document.fileName, bytes);
      if (kind !== 'pdf' && kind !== 'image' && kind !== 'xlsx') throw new Error('Only PDFs, screenshots and spreadsheets are read again.');
      // The account it went to, as if you had pinned the upload to it.
      const accountIds = record.result?.accountIds ?? [];
      const ctx: ImportRecord = { ...record, ...(accountIds.length === 1 ? { hintAccountId: accountIds[0] } : {}) };
      const read = await this.readDocument(ctx, kind === 'xlsx' ? 'sheet' : kind, bytes, file, { startedBy }, abort.signal, `reread-${record.id}`, undefined, 'reread');
      const draft = read.verified?.draft ?? this.draftOf(ctx, read.result);
      const { sections, notes } = compareReading(this.store, record, draft);
      await this.saveReread({
        ...reread,
        status: 'done',
        finishedAt: nowISO(),
        engine: read.engine,
        ...(read.result.model ? { model: read.result.model } : {}),
        ...(read.result.inference ? { inference: read.result.inference } : {}),
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
        // The reading's figure, as you chose: no longer one you typed, and seen when the document says.
        if (b.stored) await this.store.updateBalance(b.stored.id, { balance: b.read!.balance, date: b.read!.date, note: `${note}: was ${b.stored.balance.toFixed(2)} on ${b.stored.date}`, enteredBy: undefined, ...(b.read!.date !== b.stored.date ? { at: undefined } : {}) }, `balance: ${section.accountName} read again`);
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
        const categoriser = categoriserFor(this.store);
        const cat = categoriser.categorise({ accountId: account.id, description: row.read.description, amount: row.read.amount, date: row.read.date, type: row.read.type ?? current.type, bankCategory: current.bankCategory });
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
        const categoriser = categoriserFor(this.store);
        const cat = categoriser.categorise({ accountId: account.id, description: row.read.description, amount: row.read.amount, date: row.read.date, type: row.read.type });
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
    return keepYourLinks(record.draft, draft);
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
    record.draft = keepLinks(record.draft, DraftSchema.parse(draft));
    // Yours now: it is never drafted again by itself.
    record.draftEditedAt = nowISO();
    await this.save(record);
    await this.refreshBatch(record);
    return record;
  }

  // ─── Linking transfers before commit (./links.ts) ────────────────────────────────────────────

  /** A row of an import waiting for review, to link: in an account, and not one recorded already. */
  private linkable(ref: RowRef): { record: ImportRecord; found: FoundRow; account: SectionAccount } {
    const record = this.pending.get(ref.importId);
    if (!record || record.status !== 'review' || !record.draft) throw new StoreError('That import is not waiting for review.', 409);
    const found = findRow(record.draft, ref.key);
    if (!found) throw new StoreError('No such row in that import.', 404);
    const account = sectionAccount(this.store, found.section);
    if (!account) throw new StoreError('Choose the account this row goes into first.', 409);
    if (found.row.status === 'duplicate') throw new StoreError('This row is recorded already: link the recorded transaction instead, from its account.', 409);
    return { record, found, account };
  }

  linkCandidates(ref: RowRef): LinkCandidate[] {
    const self = this.pending.get(ref.importId);
    if (!self) throw new StoreError('Unknown import', 404);
    return linkCandidates(this.store, [...this.pending.values()], self, ref.key);
  }

  linkViews(record: ImportRecord): Record<string, DraftLinkView> {
    return linkViews(this.store, this.pending, record);
  }

  /** Change rows of imports waiting for review (several at once, maybe in one import), saving each import once. */
  private async changeRows(changes: { importId: string; row: DraftTransaction }[]): Promise<void> {
    const touched = new Set<string>();
    for (const { importId, row } of changes) {
      const record = this.pending.get(importId);
      if (!record?.draft) continue;
      record.draft = replaceRow(record.draft, row);
      touched.add(importId);
    }
    for (const id of touched) await this.save(this.pending.get(id)!);
  }

  /**
   * Link a row as one leg of a transfer: to a row of an import waiting for review (or another
   * account's row in this one), linked as a transfer once both are committed, or to a recorded
   * transaction, linked when this one is. What either was linked to before is unlinked.
   */
  async linkRow(ref: RowRef, to: RowRef | { transactionId: string }): Promise<ImportRecord> {
    const mine = this.linkable(ref);
    if ('transactionId' in to) {
      const tx = this.store.transaction(to.transactionId);
      if (!tx) throw new StoreError('Unknown transaction', 404);
      if (tx.transferGroup) throw new StoreError('That transaction is linked to another already.', 409);
      if (toMinor(tx.amount) !== -toMinor(mine.found.row.amount)) throw new StoreError('The two legs of a transfer are the same amount, one in and one out.');
      if (sameAccount(mine.account, { id: tx.accountId })) throw new StoreError('A transfer is between two of your accounts: these are in the same one.');
      const otherAccount = this.store.account(tx.accountId);
      if (!otherAccount) throw new StoreError('Unknown account', 404);
      await this.unlinkRow(ref, { quiet: true });
      const row = findRow(this.pending.get(ref.importId)!.draft, ref.key)!.row;
      await this.changeRows([{ importId: ref.importId, row: { ...asTransferLeg(withoutLink(row), mine.account, otherAccount), transferMatch: tx.id } }]);
      return this.pending.get(ref.importId)!;
    }
    if (to.importId === ref.importId && to.key === ref.key) throw new StoreError('A row cannot be linked to itself.');
    const theirs = this.linkable(to);
    if (toMinor(theirs.found.row.amount) !== -toMinor(mine.found.row.amount)) throw new StoreError('The two legs of a transfer are the same amount, one in and one out.');
    if ((to.importId === ref.importId && theirs.found.section.key === mine.found.section.key) || sameAccount(mine.account, theirs.account)) throw new StoreError('A transfer is between two of your accounts: these are in the same one.');
    await this.unlinkRow(ref, { quiet: true });
    await this.unlinkRow(to, { quiet: true });
    // Read again: unlinking may have changed either draft.
    const a = findRow(this.pending.get(ref.importId)!.draft, ref.key)!.row;
    const b = findRow(this.pending.get(to.importId)!.draft, to.key)!.row;
    await this.changeRows([
      { importId: ref.importId, row: { ...asTransferLeg(withoutLink(a), mine.account, theirs.account), pendingLink: { importId: to.importId, key: to.key } } },
      { importId: to.importId, row: { ...asTransferLeg(withoutLink(b), theirs.account, mine.account), pendingLink: { importId: ref.importId, key: ref.key } } },
    ]);
    return this.pending.get(ref.importId)!;
  }

  /**
   * Take a row's link away (yours, or the one the draft found): the other row of a pending link
   * loses it too. A category the link set goes back to what the rules say. `quiet`: a row with no
   * link is left as it is (relinking), rather than marked as having none.
   */
  async unlinkRow(ref: RowRef, opts: { quiet?: boolean } = {}): Promise<ImportRecord> {
    const record = this.pending.get(ref.importId);
    if (!record || record.status !== 'review' || !record.draft) throw new StoreError('That import is not waiting for review.', 409);
    const found = findRow(record.draft, ref.key);
    if (!found) throw new StoreError('No such row in that import.', 404);
    if (opts.quiet && !found.row.pendingLink && !found.row.transferMatch) return record;
    const changes = [{ importId: ref.importId, row: this.unlinked(found.section, found.row) }];
    const link = found.row.pendingLink;
    const other = link ? this.pending.get(link.importId) : undefined;
    const back = other ? findRow(other.draft, link!.key) : undefined;
    if (other && back && back.row.pendingLink?.importId === ref.importId && back.row.pendingLink.key === ref.key) {
      changes.push({ importId: other.id, row: this.unlinked(back.section, back.row) });
    }
    await this.changeRows(changes);
    return this.pending.get(ref.importId)!;
  }

  /** A row with no link, its transfer category (one a link set) back to what the rules say. */
  private unlinked(section: DraftSection, row: DraftTransaction): DraftTransaction {
    const out = withoutLink(row);
    if (row.categorisedBy !== 'transfer') return out;
    const accountId = section.target.mode === 'existing' ? section.target.accountId : '';
    const cat = categoriserFor(this.store).categorise({ accountId, description: row.description, amount: row.amount, date: row.date, type: row.detail?.type, payee: row.payee, bankCategory: row.detail?.bankCategory });
    delete out.category;
    delete out.categorisedBy;
    delete out.ruleId;
    delete out.counterpartyAccountId;
    return { ...out, ...(cat.category ? { category: cat.category } : {}), ...(cat.categorisedBy ? { categorisedBy: cat.categorisedBy } : {}), ...(cat.ruleId ? { ruleId: cat.ruleId } : {}), ...(cat.counterpartyAccountId ? { counterpartyAccountId: cat.counterpartyAccountId } : {}) };
  }

  /**
   * An import left the queue (committed, dismissed or discarded): rows of imports still waiting that
   * were linked to its rows now link to the transactions they recorded, to be linked as a transfer
   * when they are committed. A link to a row it did not record goes, with a note saying so.
   */
  private async settleLinks(goneId: string, fileName: string, how: 'committed' | 'dismissed' | 'discarded', rowIds: ReadonlyMap<string, string> = new Map()): Promise<void> {
    for (const record of [...this.pending.values()]) {
      if (!record.draft) continue;
      let draft = record.draft;
      const notes: string[] = [];
      for (const section of draft.sections) {
        for (const row of section.transactions) {
          if (row.pendingLink?.importId !== goneId) continue;
          const txId = rowIds.get(row.pendingLink.key);
          const tx = txId ? this.store.transaction(txId) : undefined;
          const mine = sectionAccount(this.store, section);
          const otherAccount = tx ? this.store.account(tx.accountId) : undefined;
          if (tx && !tx.transferGroup && mine && otherAccount) {
            draft = replaceRow(draft, { ...asTransferLeg(withoutLink(row), mine, otherAccount), transferMatch: tx.id });
          } else {
            const { pendingLink: _gone, ...rest } = row;
            draft = replaceRow(draft, rest);
            const why = how !== 'committed' ? `${fileName} was ${how}` : tx ? `the transaction ${fileName} recorded for it is in another transfer now` : `${fileName} was committed without it`;
            notes.push(`The row of ${formatMoney(row.amount)} on ${row.date} was linked to a row of another import, but ${why}: the link was taken away.`);
          }
        }
      }
      if (draft === record.draft) continue;
      record.draft = { ...draft, notes: [...draft.notes, ...notes] };
      await this.save(record);
    }
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
    record.draft = keepYourLinks(record.draft, this.draftOf(record, { extraction: parsed.extraction, warnings: [] }));
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
    const finalDraft = draft ? keepLinks(record.draft, DraftSchema.parse(draft)) : record.draft;
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
    const rowIds = new Map<string, string>();
    const committed = await commitDraft(this.store, { record, draft: checked.draft, workFile: this.work.filePath(record.document), rowIds });
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    // Rows of other imports linked to this one's now link to what it recorded.
    await this.settleLinks(id, record.document.fileName, 'committed', rowIds);
    // An account or job it set up may be the one other waiting documents are about (a letter
    // uploaded with the new account's first statement, a P60 beside HMRC's page for the same job),
    // and HMRC's records it added match payslips to their job: drafts you have not edited are matched
    // again, so they are not committed into another account or job, or into a second new one.
    if (committed.result?.accountsCreated.length || committed.result?.jobs?.length || committed.result?.hmrcAdded || committed.result?.agreementsAdded) await this.redraftWaiting();
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

  private assess(record: ImportRecord, draft: Draft, warnings: string[], sheets?: Sheet[]) {
    return assessReading(draft, {
      accountTypeOf: (s) => (s.target.mode === 'existing' ? this.store.account(s.target.accountId)?.type : s.target.mode === 'new' ? s.target.account.type : undefined),
      latest: record.createdAt.slice(0, 10),
      warnings,
      sheetCheck: sheets ? checkEarnedPay(draft.figures, sheets) : undefined,
    });
  }

  /**
   * Check a model's reading (docs/INGESTION.md, "Checking every figure"). A reading the document's
   * own arithmetic confirms is kept. Otherwise (a check failed, or some figures have nothing to be
   * checked against) the document is read again with the checking model, the two readings are
   * compared figure by figure, the better one is kept, and rows they disagree on are marked.
   */
  private async verifyReading(
    record: ImportRecord,
    first: EngineResult,
    opts: { read: TaskChoice; check: TaskChoice; readWith: (c: TaskChoice, role: 'first' | 'second') => Promise<EngineResult>; batch?: BatchEvidence | undefined; sheets?: Sheet[] | undefined; claudeAvailable: 'claude-cli' | 'claude-api' | null },
  ) {
    const firstDraft = this.draftOf(record, first, opts.batch);
    const a1 = this.assess(record, firstDraft, first.warnings, opts.sheets);
    const firstModel = readerName(opts.read, first);
    const firstInference = first.inference ? { firstInference: first.inference } : {};
    if (!a1.problems.length && !a1.unconfirmed.length) {
      return { result: first, draft: firstDraft, otherCostUsd: 0, alternative: undefined, verification: { method: 'checks' as const, firstModel, ...firstInference, reasons: [], disagreements: [], kept: 'first' as const } };
    }
    const reasons = [...a1.problems, ...a1.unconfirmed.map((u) => `Nothing on the document confirms: ${u}`)];
    let second: EngineResult;
    try {
      second = await opts.readWith(opts.check, 'second');
    } catch (err) {
      // Without a second reading the first stands; the review page says it is unchecked.
      return { result: first, draft: firstDraft, otherCostUsd: 0, alternative: undefined, verification: { method: 'second-reading' as const, firstModel, ...firstInference, secondModel: choiceName(opts.check), reasons, disagreements: [], kept: 'first' as const, error: (err as Error).message.slice(0, 300) } };
    }
    let secondDraft = this.draftOf(record, second, opts.batch);
    let a2 = this.assess(record, secondDraft, second.warnings, opts.sheets);
    let kept = chooseReading(a1, a2);
    let byClaude = false;
    let otherCost = 0;
    // Both local readings still fail a check, and checking may fall back to Claude: Claude reads it,
    // and stands in for the second reading when it finds no more wrong than the better of the two.
    const best = kept === 'second' ? a2 : a1;
    if (best.problems.length && opts.check.engine === 'inference' && opts.check.fallback && opts.claudeAvailable && second.engine === 'inference') {
      try {
        const third = await opts.readWith(claudeChoice('check-reading', opts.claudeAvailable), 'second');
        const thirdDraft = this.draftOf(record, third, opts.batch);
        const a3 = this.assess(record, thirdDraft, third.warnings, opts.sheets);
        if (chooseReading(best, a3) === 'second') {
          // The local reading not kept is set aside; Claude's is compared with the better local one.
          if (kept === 'second') {
            otherCost += first.costUsd ?? 0;
            first = second;
          }
          second = { ...third, notices: [`Both readings by the local model failed a check, so Claude read it too, as Settings → Models allows for checking.`, ...(third.notices ?? [])] };
          secondDraft = thirdDraft;
          a2 = a3;
          kept = 'second';
          byClaude = true;
        } else otherCost += third.costUsd ?? 0;
      } catch {
        // Claude could not read it either: the two local readings stand.
      }
    }
    const firstFinal = this.draftOf(record, first, opts.batch);
    const stored = { first: readerName(opts.read, first), second: byClaude ? readerName(claudeChoice('check-reading'), second) : readerName(opts.check, second) };
    const names = { first: shortModel(stored.first), second: shortModel(stored.second) };
    if (names.first === names.second) names.second = `${names.second} (second reading)`;
    const [keptResult, keptDraft, other, otherDraft] = kept === 'second' ? [second, secondDraft, first, firstFinal] : [first, firstFinal, second, secondDraft];
    const cmp = kept === 'second' ? compareReadings(otherDraft, keptDraft, { first: names.first, second: names.second }) : compareReadings(otherDraft, keptDraft, { first: names.second, second: names.first });
    markDisagreements(keptDraft, cmp.rowNotes);
    return {
      result: keptResult,
      draft: keptDraft,
      otherCostUsd: (other.costUsd ?? 0) + otherCost,
      alternative: other.extraction,
      verification: {
        method: 'second-reading' as const,
        firstModel: stored.first,
        secondModel: stored.second,
        ...(first.inference ? { firstInference: first.inference } : {}),
        ...(second.inference ? { secondInference: second.inference } : {}),
        ...(byClaude ? { byClaude: true } : {}),
        reasons,
        disagreements: cmp.disagreements,
        kept,
      },
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
      // Nor any HMRC record, so no job is set up for one either, nor an agreement.
      ...(record.draft.hmrc ? { hmrc: record.draft.hmrc.map((h) => ({ ...h, include: false })) } : {}),
      ...(record.draft.agreements ? { agreements: record.draft.agreements.map((a) => ({ ...a, include: false })) } : {}),
    };
    const filed = await commitDraft(this.store, { record, draft, workFile: this.work.filePath(record.document), nothingNew: nothing.reason });
    this.pending.delete(id);
    await this.work.remove(record, [...this.pending.values()]);
    await this.settleLinks(id, record.document.fileName, 'dismissed');
    this.emit('update', filed);
    return filed;
  }

  /**
   * A document filed as adding nothing new, back in review as an import of its own (docs/INGESTION.md,
   * "Nothing new"): its stored reading drafted again as it would be drafted now, with no Claude, so a
   * newer app finds what an older one had no place for. The filing stays in History as it was. When
   * the stored reading is not enough (an older reader put a schedule only in its remarks), "Read it
   * again" on the review page reads the document afresh.
   */
  async reopen(filedId: string): Promise<ImportRecord> {
    const filed = await this.store.readImport(filedId);
    if (!filed || filed.status !== 'committed' || !filed.result?.nothingNew || !filed.document.path) throw new StoreError('Only a document filed as adding nothing new can be opened again.', 409);
    const waiting = [...this.pending.values()].find((r) => r.document.sha256 === filed.document.sha256 && r.status !== 'discarded');
    if (waiting) return waiting;
    const bytes = await readFile(this.store.documentAbsPath(filed.document.path));
    const stamp = nowISO();
    const { path: _stored, ...document } = filed.document;
    const record: ImportRecord = {
      id: importId(),
      status: filed.extraction.raw ? 'review' : 'queued',
      createdAt: stamp,
      updatedAt: stamp,
      origin: filed.origin,
      document,
      extraction: filed.extraction,
      reopens: filed.id,
      ...(filed.hintAccountId ? { hintAccountId: filed.hintAccountId } : {}),
      ...(filed.label ? { label: filed.label } : {}),
    };
    await this.work.saveFile(record.document, bytes);
    if (filed.extraction.raw) record.draft = this.rebuild(record, await this.batchEvidence(record));
    await this.save(record);
    if (!filed.extraction.raw) this.schedule(record.id, { startedBy: { actor: currentActor(), reason: `Opened again: ${record.document.fileName}` } });
    return record;
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

  /**
   * A section's rows checked again against the account you chose for it (docs/INGESTION.md,
   * "Review"): which are recorded there already and which are new, each ticked accordingly. What a
   * row would fill in on a payment it matched elsewhere is dropped, as that payment is another
   * account's. Nothing else about the section changes.
   */
  redraftSection(section: DraftSection): DraftSection {
    const target = section.target;
    const recorded = target.mode === 'existing' ? this.store.transactions(target.accountId) : [];
    const dups = target.mode === 'existing' ? classifyDuplicates(section.transactions.map(candidateOf), recorded, 3) : section.transactions.map(() => ({ status: 'new' as const, duplicateOf: undefined }));
    return {
      ...section,
      transactions: section.transactions.map((t, i) => {
        const d = dups[i]!;
        const { duplicateOf: _was, adds: _adds, ...rest } = t;
        return { ...rest, status: d.status, include: d.status === 'new' && !t.pending && !t.insideAccount, ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}) };
      }),
      ...(section.extraCopies ? { extraCopies: target.mode === 'existing' ? section.extraCopies.filter((c) => !c.accountId || c.accountId === target.accountId) : [] } : {}),
    };
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
      const account = s.target.mode === 'existing' ? this.store.account(s.target.accountId) : s.target.account;
      for (const c of sectionChecks(s, { accountType: account?.type, latest: record.createdAt.slice(0, 10), periodFromRows: record.draft.documentType === 'csv_export', openedOn: account?.openedOn, closedOn: account?.closedOn })) if (c.status === 'warn') reasons.push(c.title.toLowerCase());
    }
    if (record.extraction.warnings.length) reasons.push('warnings from reading the document');
    // A schedule recorded for the first time files your payments under it: look at it once.
    if (record.draft.agreements?.some((a) => a.include && a.target.mode === 'new')) reasons.push('a new schedule to check');
    // Payments it mentions, recorded already, that its reading had no place for: read it again.
    const d = record.draft;
    if (!d.sections.length && !d.figures.length && !d.hmrc?.length && !d.payslips?.length && !d.agreements?.length) {
      const mentioned = mentionedPayments(record, this.store);
      if (mentioned.length) reasons.push(`it mentions ${mentioned.length === 1 ? 'a payment' : `${mentioned.length} payments`} already recorded that its reading had no place for: read it again`);
    }
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
    await this.settleLinks(id, record.document.fileName, 'discarded');
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

