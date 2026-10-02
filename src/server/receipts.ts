// Receipts attached to transactions (docs/DATA_FORMAT.md, receipts.jsonl).
//
// The document is kept with your other documents (data/documents, served by id). When reading
// receipts with Claude is on (Settings → Import & extraction, off unless you turn it on), Claude reads
// it in a scratch directory holding only that file, with only the Read tool: the receipt and your
// category names go to Claude, and nothing else leaves. What it reads is a proposal: the split lines
// change only when you accept them.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CategoryIndex } from '../shared/categories';
import { fromMinor } from '../shared/money';
import { ReceiptSchema, type Receipt, type Transaction } from '../shared/schema';
import { runAgent, type AgentRunOptions, type AgentRunResult } from './agents/claude';
import type { Config } from './config';
import { currentActor } from './audit';
import type { SessionLog } from './sessions';
import { nowISO, safeFileName, sha256 } from './fsutil';
import { documentId } from './ids';
import { resolveClaudeBin } from './ingest/claude-cli';
import { StoreError, type Store } from './store';

export const RECEIPT_PROMPT_VERSION = 'receipt-1';
export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };

/** What the reader returns: the receipt as printed. */
const ReadingOutput = z.object({
  merchant: z.string().nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  lines: z.array(z.object({ description: z.string(), amount: z.number(), category: z.string().nullable() })).max(200),
  notes: z.array(z.string()).default([]),
});

export function receiptJsonSchema(categoryIds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['merchant', 'date', 'total', 'lines', 'notes'],
    properties: {
      merchant: { type: ['string', 'null'], description: 'The shop or business, as printed' },
      date: { type: ['string', 'null'], description: 'The date on the receipt, YYYY-MM-DD' },
      total: { type: ['number', 'null'], description: 'The total paid, in pounds, as printed (positive)' },
      lines: {
        type: 'array',
        description: 'Every line that makes up the total, in order: items, and discounts, delivery or service charges as their own lines',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'amount', 'category'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'number', description: 'In pounds as printed: positive for what was bought, negative for a discount or voucher' },
            category: { type: ['string', 'null'], enum: [...categoryIds, null], description: 'The category it belongs in, from the list, or null when unsure' },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'Anything that could not be read with certainty, in a few words each' },
    },
  };
}

export function receiptPrompt(t: Transaction, categories: { id: string; name: string; group?: string }[]): { system: string; user: string } {
  const system = `You read one shop receipt, bill or invoice and return its lines as JSON matching the schema exactly. Read only what is printed: never guess a line or an amount. Amounts are in pounds. Give every line that makes up the total, including discounts (negative), delivery and service charges. For each line choose the category it belongs in from the list given, or null when you are unsure. Say in notes anything you could not read with certainty.`;
  const user = [
    `The receipt is the file in the current directory. It was attached to a payment of £${Math.abs(t.amount).toFixed(2)} on ${t.date}${t.payee ? ` to ${t.payee}` : ''}: its lines usually add up to that.`,
    '',
    'Categories (id: name):',
    ...categories.map((c) => `- ${c.id}: ${c.group ? `${c.group} › ` : ''}${c.name}`),
  ].join('\n');
  return { system, user };
}

const receiptId = (transactionId: string, sha: string) => `rct_${sha256(Buffer.from(`${transactionId}|${sha}`)).slice(0, 16)}`;

/** Keep a receipt with your documents and attach it to a transaction. The same file twice is one receipt. */
export async function attachReceipt(store: Store, workDir: string, transactionId: string, file: { name: string; type: string; bytes: Buffer }): Promise<Receipt> {
  const t = store.transaction(transactionId);
  if (!t) throw new StoreError('Unknown transaction', 404);
  const ext = TYPES[file.type];
  if (!ext) throw new StoreError('A receipt is a photo (PNG, JPEG, WebP, HEIC) or a PDF.', 415);
  if (file.bytes.length > MAX_RECEIPT_BYTES) throw new StoreError('That file is over 15 MB.', 413);
  const sha = sha256(file.bytes);
  const id = receiptId(transactionId, sha);
  const existing = store.receipts.find((r) => r.id === id);
  if (existing) return existing;
  const tmpDir = path.join(workDir, 'receipts');
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(tmpDir, `${sha}${ext}`);
  await writeFile(tmp, file.bytes, { mode: 0o600 });
  try {
    const fileName = safeFileName(file.name || `receipt${ext}`);
    const docPath = await store.storeDocument(tmp, sha, fileName);
    const stamp = nowISO();
    const receipt = ReceiptSchema.parse({
      id,
      transactionId,
      document: { id: documentId(sha), sha256: sha, fileName: file.name || `receipt${ext}`, mediaType: file.type, size: file.bytes.length, path: docPath },
      status: 'attached',
      createdAt: stamp,
      updatedAt: stamp,
    });
    await store.upsertRecords('receipts', [receipt], `receipt: attached to ${t.payee ?? t.description} ${t.date}`);
    return receipt;
  } finally {
    await rm(tmp, { force: true });
  }
}

export type ReceiptReader = (opts: AgentRunOptions) => Promise<AgentRunResult>;

/**
 * Read a receipt with Claude, when that is turned on: its lines, signed like the payment, each with
 * a suggested category. A proposal: the transaction does not change.
 */
export async function readReceipt(store: Store, config: Config, id: string, opts: { reader?: ReceiptReader; bin?: string; sessions?: SessionLog | undefined } = {}): Promise<Receipt> {
  const settings = store.settings.extraction;
  if (!settings.readReceipts) throw new StoreError('Reading receipts with Claude is off: turn it on in Settings → Import & extraction.', 409);
  const receipt = store.receipts.find((r) => r.id === id);
  if (!receipt) throw new StoreError('Unknown receipt', 404);
  const t = store.transaction(receipt.transactionId);
  if (!t) throw new StoreError('The receipt’s transaction no longer exists', 404);
  const bin = opts.bin ?? (await resolveClaudeBin());
  if (!bin) throw new StoreError('The claude CLI is not installed or not logged in on this server.', 503);
  const cats = new CategoryIndex(store.categories);
  const categories = store.categories.filter((c) => (c.kind === 'expense' || c.kind === 'income') && !c.hidden && c.parent).map((c) => ({ id: c.id, name: c.name, group: cats.get(c.parent)?.name }));
  const { system, user } = receiptPrompt(t, categories);
  const scratch = path.join(config.workDir, 'extract', id);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const ext = TYPES[receipt.document.mediaType] ?? path.extname(receipt.document.fileName);
  await copyFile(store.documentAbsPath(receipt.document.path!), path.join(scratch, `receipt${ext}`));
  const stamp = nowISO();
  try {
    // The reading is a Claude session, with its transcript (sessions.ts).
    const session = await opts.sessions?.start({
      kind: 'receipt',
      title: `Read a receipt for ${t.payee ?? t.description} on ${t.date}`,
      receiptId: receipt.id,
      transactionId: t.id,
      engine: 'claude-cli',
      model: settings.model,
      effort: settings.effort,
      promptVersion: RECEIPT_PROMPT_VERSION,
      tools: ['Read'],
      privacy: 'personal',
      startedBy: { actor: currentActor(), reason: 'Read the receipt attached to this payment' },
    });
    const readOnce = (transcript: AgentRunOptions['transcript']) =>
      (opts.reader ?? runAgent)({
        bin,
        cwd: scratch,
        prompt: user,
        systemPrompt: system,
        schema: receiptJsonSchema(categories.map((c) => c.id)),
        tools: ['Read'],
        model: settings.model,
        effort: settings.effort,
        timeoutMs: Math.min(settings.timeoutSeconds, 600) * 1000,
        transcript,
      });
    const result = session ? await session.run(readOnce) : await readOnce(undefined);
    const out = ReadingOutput.parse(result.output);
    const sign = t.amount < 0 ? -1 : 1;
    const known = new Set(categories.map((c) => c.id));
    const money = (v: number) => fromMinor(Math.round(v * 100));
    const next = ReceiptSchema.parse({
      ...receipt,
      status: 'read',
      reading: {
        model: result.model,
        promptVersion: RECEIPT_PROMPT_VERSION,
        at: stamp,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        merchant: out.merchant,
        date: out.date && /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? out.date : null,
        total: out.total === null ? null : money(Math.abs(out.total)),
        lines: out.lines.map((l) => ({ description: l.description.slice(0, 200), amount: money(sign * l.amount), category: l.category && known.has(l.category) ? l.category : null })),
        notes: out.notes.map((n) => n.slice(0, 300)),
      },
      error: undefined,
      updatedAt: stamp,
    });
    delete next.error;
    await store.upsertRecords('receipts', [next], `receipt: read (${next.reading!.lines.length} lines)`);
    return next;
  } catch (err) {
    const failed = ReceiptSchema.parse({ ...receipt, status: 'failed', error: (err as Error).message.slice(0, 500), updatedAt: stamp });
    await store.upsertRecords('receipts', [failed], 'receipt: could not be read');
    return failed;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Take a receipt off its transaction. Its file goes too, unless something else keeps it. */
export async function detachReceipt(store: Store, id: string): Promise<void> {
  const receipt = store.receipts.find((r) => r.id === id);
  if (!receipt) throw new StoreError('Unknown receipt', 404);
  await store.removeRecords('receipts', [id], 'receipt: removed');
  const stillUsed = store.receipts.some((r) => r.document.id === receipt.document.id) || store.imports.some((i) => i.documentId === receipt.document.id);
  if (!stillUsed && receipt.document.path) await rm(store.documentAbsPath(receipt.document.path), { force: true });
}
