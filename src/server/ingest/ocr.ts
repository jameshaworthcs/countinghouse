// Offline fallback: tesseract for images, pdftotext (or OCR of rendered pages) for PDFs. It does not
// try to be clever: it proposes a headline balance and candidate amounts/dates for you to confirm,
// and for text PDFs it parses statement-style lines, using running balances to infer signs.

import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFlexibleDate, type ISODate } from '../../shared/dates';
import { parseAmount, roundMoney, toMinor } from '../../shared/money';
import { ExtractionSchema, type ExtractedTransaction } from '../../shared/schema';
import { runProcess } from './claude-cli';
import type { EngineResult } from './engines';

export const OCR_ENGINE_VERSION = 'ocr-1';

interface OcrLine {
  text: string;
  height: number;
  top: number;
}

async function tesseractLines(file: string, cwd: string): Promise<OcrLine[]> {
  const { stdout, code, stderr } = await runProcess('tesseract', [file, 'stdout', '--psm', '3', 'tsv'], { cwd, timeoutMs: 120_000 });
  if (code !== 0) throw new Error(`tesseract failed: ${stderr.slice(0, 300)}`);
  const lines = new Map<string, { words: string[]; height: number; top: number }>();
  for (const row of stdout.split('\n').slice(1)) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols[11]!.trim();
    if (!text) continue;
    const key = `${cols[1]}-${cols[2]}-${cols[3]}-${cols[4]}`;
    const entry = lines.get(key) ?? { words: [], height: 0, top: Number(cols[7]) };
    entry.words.push(text);
    entry.height = Math.max(entry.height, Number(cols[9]));
    lines.set(key, entry);
  }
  return [...lines.values()].map((l) => ({ text: l.words.join(' '), height: l.height, top: l.top })).sort((a, b) => a.top - b.top);
}

const MONEY_RE = /[-−]?\s?£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|[-−]?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s?(?:CR|DR))?/gi;
const DATE_RE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/gi;

export function candidatesFromText(text: string, pivotYear?: number): { amounts: number[]; dates: ISODate[] } {
  const amounts = [...new Set((text.match(MONEY_RE) ?? []).map((m) => parseAmount(m)).filter((n): n is number => n !== null))];
  const dates = [
    ...new Set(
      (text.match(DATE_RE) ?? [])
        .map((m) => parseFlexibleDate(m, 'DMY', { defaultYear: pivotYear ?? new Date().getFullYear() }))
        .filter((d): d is ISODate => d !== null),
    ),
  ];
  return { amounts, dates };
}

/** Statement lines: "<date> <description> <amount> [<balance>]". Signs come from balance changes. */
export function parseStatementText(text: string, year: number): ExtractedTransaction[] {
  const rows: { date: ISODate; description: string; amount: number; balance: number | null }[] = [];
  const lineRe = /^\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?)\s+(.+?)\s+((?:[-−]?£?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s?(?:CR|DR))?\s*){1,3})\s*$/;
  let lastDate: ISODate | null = null;
  for (const line of text.split('\n')) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const date: ISODate | null = parseFlexibleDate(m[1], 'DMY', { defaultYear: year }) ?? lastDate;
    if (!date) continue;
    lastDate = date;
    const nums = (m[3]!.match(/[-−]?£?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s?(?:CR|DR))?/g) ?? []).map((x) => parseAmount(x)).filter((n): n is number => n !== null);
    if (!nums.length) continue;
    const description = m[2]!.replace(/\s{2,}/g, ' ').trim();
    if (/balance (brought|carried) forward|opening balance|closing balance/i.test(description)) continue;
    rows.push({ date, description, amount: nums[0]!, balance: nums.length > 1 ? nums[nums.length - 1]! : null });
  }
  // Infer signs from consecutive running balances where possible.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (prev.balance === null || cur.balance === null) continue;
    const delta = toMinor(cur.balance) - toMinor(prev.balance);
    if (Math.abs(delta) === Math.abs(toMinor(cur.amount))) cur.amount = roundMoney(delta / 100);
  }
  return rows.map((r, i) => ({
    date: r.date,
    description: r.description,
    amount: r.amount,
    balanceAfter: r.balance,
    category: null,
    payee: null,
    pending: false,
    currency: 'GBP',
    originalAmount: null,
    originalCurrency: null,
    transactionDate: null,
    time: null,
    sourceId: null,
    type: null,
    reference: null,
    counterpartyName: null,
    merchantLocation: null,
    cardLast4: null,
    bankCategory: null,
    fee: null,
    exchangeRate: null,
    raw: null,
    attributes: null,
    merchant: null,
    row: i,
  }));
}

export async function extractWithOcr(file: { path: string; mediaType: string }, workDir: string, year: number): Promise<EngineResult & { ocrText: string; candidates: { amounts: number[]; dates: string[] } }> {
  const started = Date.now();
  let text = '';
  let headline: number | null = null;
  const notes: string[] = ['Read offline with OCR. Check every value against the original.'];
  if (file.mediaType === 'application/pdf') {
    const pdf = await runProcess('pdftotext', ['-layout', file.path, '-'], { cwd: workDir, timeoutMs: 60_000 });
    text = pdf.stdout;
    if (text.replace(/\s/g, '').length < 40) {
      const pagesDir = path.join(workDir, 'ocr-pages');
      await mkdir(pagesDir, { recursive: true });
      await runProcess('pdftoppm', ['-r', '200', '-png', file.path, path.join(pagesDir, 'page')], { cwd: workDir, timeoutMs: 180_000 });
      const pages = (await readdir(pagesDir)).filter((f) => f.endsWith('.png')).sort();
      const parts: string[] = [];
      for (const p of pages) parts.push((await tesseractLines(path.join(pagesDir, p), workDir)).map((l) => l.text).join('\n'));
      text = parts.join('\n\f\n');
      notes.push('The PDF had no text layer, so its pages were OCR-ed.');
    }
  } else {
    const lines = await tesseractLines(file.path, workDir);
    text = lines.map((l) => l.text).join('\n');
    const withMoney = lines.filter((l) => /£\s?\d/.test(l.text)).sort((a, b) => b.height - a.height);
    if (withMoney[0]) headline = parseAmount(withMoney[0].text.match(MONEY_RE)?.[0]);
  }
  const candidates = candidatesFromText(text, year);
  const transactions = parseStatementText(text, year);
  if (transactions.length) notes.push(`${transactions.length} statement-style lines found; signs were inferred from running balances where possible.`);
  const extraction = ExtractionSchema.parse({
    documentType: file.mediaType === 'application/pdf' ? 'bank_statement' : 'account_overview_screenshot',
    accounts: [
      {
        closingBalance: headline ?? (transactions.length ? (transactions[transactions.length - 1]!.balanceAfter ?? null) : null),
        balanceDate: transactions.length ? transactions[transactions.length - 1]!.date : null,
        transactions,
      },
    ],
    notes,
    confidence: 'low',
  });
  return { extraction, warnings: [], model: 'tesseract', durationMs: Date.now() - started, ocrText: text.slice(0, 20_000), candidates };
}
