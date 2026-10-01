// A spreadsheet that is not a list of payments: a timesheet, a sheet a month (docs/INGESTION.md,
// "Timesheets"). Every sheet goes to the reader as text, the sheets check what it read, and its
// earned pay is reviewed and committed. The reader here is a stand-in `claude` that answers from a
// script: no Claude is run. The workbook is made here; all data is invented.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { suggestMapping } from '../src/server/ingest/csv';
import { checkEarnedPay } from '../src/server/ingest/timesheet';
import { looksLikeLedger, sheetRows, workbookSheets, workbookText } from '../src/server/ingest/xlsx';
import type { SummaryResponse } from '../src/shared/api';
import type { DraftFigure, Figure, ImportRecord } from '../src/shared/schema';

const CSRF = { 'x-finance-csrf': '1' };
const MONEY = '"£"#,##0.00';
const RATE = 120;

/** One month's sheet of a timesheet: a header block, a row a working day, a total. `worked` maps day of month → days worked. */
function monthSheet(year: number, month: number, worked: Record<number, number>, holiday: Record<number, number> = {}): XLSX.WorkSheet {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows: unknown[][] = [
    ['', 'Project 7'],
    [],
    ['', 'Employee Name', '', 'Alex Example'],
    ['', 'Legal Entity', '', 'Kestrel Labs Ltd', '', 'Cost Centre', '0815', 'Key', 0.25],
    [],
    ['', 'Month Ending', '', new Date(Date.UTC(year, month - 1, last)), '', 'Day Rate', RATE],
    [],
    ['', 'Day', 'Date', 'Worked', 'Holiday', 'Total Pay', '', 'Holiday Taken'],
  ];
  const moneyCells: string[] = ['G6'];
  let total = 0;
  let days = 0;
  let hols = 0;
  for (let d = 1; d <= last; d++) {
    const date = new Date(Date.UTC(year, month - 1, d));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const w = worked[d] ?? 0;
    const h = holiday[d] ?? 0;
    total += w * RATE;
    days += w;
    hols += h;
    rows.push(['', date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }), date, w || '', h || '', w * RATE, '', rows.length === 9 ? hols : '']);
    moneyCells.push(`F${rows.length}`);
  }
  rows.push(['', 'Total', '', days, hols, total]);
  moneyCells.push(`F${rows.length}`);
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
  for (const ref of moneyCells) if (ws[ref]) (ws[ref] as XLSX.CellObject).z = MONEY;
  return ws;
}

/** June (no work), July (4 days and a day's holiday: £480) and August (6 days: £720). */
function timesheet(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, monthSheet(2026, 6, {}), 'June');
  XLSX.utils.book_append_sheet(wb, monthSheet(2026, 7, { 20: 1, 21: 1, 22: 1, 23: 1 }, { 24: 1 }), 'July');
  XLSX.utils.book_append_sheet(wb, monthSheet(2026, 8, { 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 10: 1 }), 'August');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const earnedFigure = (key: string, month: string, amount: number): DraftFigure => ({ key, include: true, kind: 'earned_pay', label: `${month} total`, amount, currency: 'GBP', periodStart: `${month}-01`, periodEnd: `${month}-31` });

describe('a timesheet workbook', () => {
  it('is not a list of payments, and every sheet goes to the reader as text', () => {
    const bytes = timesheet();
    const sheets = workbookSheets(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['June', 'July', 'August']);
    expect(looksLikeLedger(suggestMapping(sheetRows(bytes).rows, {}), sheets.length)).toBe(false);
    const text = workbookText(sheets, 'timesheet.xlsx');
    expect(text).toContain('=== Sheet "July" ===');
    // Dates as dates, money as the sheet shows it beside its value.
    expect(text).toMatch(/C\d+=2026-07-20 \| D\d+=1 \| F\d+=120 \[£120\.00\]/);
    expect(text).toMatch(/B\d+=Total \| D\d+=4 \| E\d+=1 \| F\d+=480 \[£480\.00\]/);
    expect(sheetRows(bytes, 'August').sheet).toBe('August');
  });

  it('a bank export is still a list of payments', () => {
    const rows = [
      ['Date', 'Description', 'Amount'],
      ['01/09/2026', 'TESCO', '-12.50'],
      ['02/09/2026', 'SALARY', '2150.75'],
      ['03/09/2026', 'PRET', '-4.20'],
    ];
    expect(looksLikeLedger(suggestMapping(rows, {}), 1)).toBe(true);
  });

  it('the sheets confirm each month’s earned pay, and say what a reading got wrong or missed', () => {
    const sheets = workbookSheets(timesheet());
    const right = checkEarnedPay([earnedFigure('a', '2026-07', 480), earnedFigure('b', '2026-08', 720)], sheets);
    expect(right.problems).toEqual([]);
    expect([...right.confirmed]).toEqual(['a', 'b']);
    const wrong = checkEarnedPay([earnedFigure('a', '2026-07', 840)], sheets);
    expect(wrong.problems).toEqual(['2026-07 total: £840.00 is not on the sheet for Jul 2026', 'Sheet “August” has pay on it, but no earned pay was read for it']);
    expect(wrong.confirmed.size).toBe(0);
  });
});

/** The stand-in reader: answers a timesheet reading from the workbook text it was given, and logs each call. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const text = fs.readFileSync('./workbook.txt', 'utf8');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ model, prompt: args[args.indexOf('-p') + 1], text }) + '\\n');
const wrong = process.env.FAKE_CLAUDE_MODE === 'wrong-first' && model !== 'opus';
const work = (days, holidayDays) => ({ role: 'Project 7', daysWorked: days, holidayDays, hoursWorked: null, rate: 120, ratePer: 'day' });
const fig = (month, amount, w) => ({ kind: 'earned_pay', label: month + ': Total Pay', amount, currency: 'GBP', periodStart: '2026-' + (month === 'July' ? '07' : '08') + '-01', periodEnd: '2026-' + (month === 'July' ? '07' : '08') + '-31', taxYear: null, payer: 'Kestrel Labs Ltd', payerReference: null, accountLast4: null, taxCode: null, work: w });
const out = { documentType: 'timesheet', institutionName: null, documentDate: null, accounts: [], figures: [fig('July', wrong ? 840 : 480, work(4, 1)), fig('August', 720, work(6, 0))], notes: [], nothingToRecord: null, confidence: 'high' };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, total_cost_usd: 0, duration_ms: 5, modelUsage: { [model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5']: {} } }));
`;

describe('importing a timesheet', () => {
  let app: App;
  let dir: string;
  let log: string;
  let binDir: string;
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, bin: process.env.FINANCE_CLAUDE_BIN, log: process.env.FAKE_CLAUDE_LOG, mode: process.env.FAKE_CLAUDE_MODE };
  beforeAll(async () => {
    // Only the stand-in can be found: no real claude on the PATH or in the home directory. It stays
    // in one place for every test (the engines found are remembered for a minute).
    binDir = await mkdtemp(path.join(os.tmpdir(), 'finance-fake-claude-'));
    await mkdir(path.join(binDir, 'home'));
    const bin = path.join(binDir, 'claude');
    await writeFile(bin, FAKE_CLAUDE);
    await chmod(bin, 0o755);
    process.env.PATH = path.dirname(process.execPath);
    process.env.HOME = path.join(binDir, 'home');
    process.env.FINANCE_CLAUDE_BIN = bin;
  });
  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries({ HOME: saved.HOME, PATH: saved.PATH, FINANCE_CLAUDE_BIN: saved.bin, FAKE_CLAUDE_LOG: saved.log, FAKE_CLAUDE_MODE: saved.mode })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-timesheet-'));
    log = path.join(dir, 'claude.log');
    process.env.FAKE_CLAUDE_LOG = log;
    delete process.env.FAKE_CLAUDE_MODE;
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://127.0.0.1${p}`, { ...init, headers: { host: '127.0.0.1', ...(init.headers ?? {}) } });
  const json = (body: unknown) => ({ method: 'POST', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { model: string; prompt: string; text: string });
  async function upload(): Promise<ImportRecord> {
    const form = new FormData();
    form.append('file', new Blob([timesheet()]), 'Alex Example – Project 7 timesheet.xlsx');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    return waitFor(results[0]!.id, ['review', 'needs_mapping', 'failed']);
  }
  async function waitFor(id: string, statuses: string[]): Promise<ImportRecord> {
    let rec: ImportRecord | undefined;
    for (let i = 0; i < 200 && !statuses.includes(rec?.status ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 50));
      rec = (await (await req(`/api/imports/${id}`)).json()) as ImportRecord;
    }
    return rec!;
  }

  it('reads every sheet with the reader, and the sheets confirm what it read', async () => {
    const rec = await upload();
    expect(rec.extraction.error).toBeUndefined();
    expect(rec.status).toBe('review');
    expect(rec.extraction).toMatchObject({ engine: 'claude-cli', engineVersion: 'xlsx-1+extract-11', detail: '3 sheets, claude-sonnet-5-5' });
    // One reading: the sheets confirmed it, so no second one.
    expect(rec.extraction.verification).toMatchObject({ method: 'checks' });
    const [call, ...more] = await calls();
    expect(more).toEqual([]);
    expect(call!.prompt).toMatch(/It is a spreadsheet, given as text/);
    expect(call!.text).toContain('=== Sheet "August" ===');
    expect(rec.draft!.documentType).toBe('timesheet');
    expect(rec.draft!.sections).toEqual([]);
    expect(rec.draft!.figures.map((f) => [f.kind, f.periodEnd, f.amount, f.taxYear, f.work])).toEqual([
      ['earned_pay', '2026-07-31', 480, undefined, { role: 'Project 7', daysWorked: 4, holidayDays: 1, rate: 120, ratePer: 'day' }],
      ['earned_pay', '2026-08-31', 720, undefined, { role: 'Project 7', daysWorked: 6, holidayDays: 0, rate: 120, ratePer: 'day' }],
    ]);

    // Committed, it is earned pay: in no tax year, and pending beside the estate.
    const committed = (await (await req(`/api/imports/${rec.id}/commit`, { method: 'POST', headers: CSRF })).json()) as ImportRecord;
    expect(committed.status).toBe('committed');
    const figures = (await (await req('/api/figures')).json()) as Figure[];
    expect(figures.map((f) => [f.kind, f.amount, f.taxYear, f.work?.daysWorked])).toEqual([
      ['earned_pay', 480, undefined, 4],
      ['earned_pay', 720, undefined, 6],
    ]);
    const summary = (await (await req('/api/summary')).json()) as SummaryResponse;
    expect(summary.owed).toMatchObject({ gross: 1200, next: null, late: false });
    expect(summary.estate.value).toBe(0);
  });

  it('reads it again with the checking model when the sheets contradict the first reading', async () => {
    process.env.FAKE_CLAUDE_MODE = 'wrong-first';
    const rec = await upload();
    expect(rec.status).toBe('review');
    expect((await calls()).map((c) => c.model)).toEqual(['sonnet', 'opus']);
    expect(rec.extraction.verification).toMatchObject({ method: 'second-reading', kept: 'second' });
    expect(rec.extraction.verification!.reasons).toContain('July: Total Pay: £840.00 is not on the sheet for Jul 2026');
    expect(rec.draft!.figures.map((f) => f.amount)).toEqual([480, 720]);
    expect(rec.extraction.warnings).toEqual([]);
  });

  it('can be mapped like a CSV instead, and is when Claude is not the reader', async () => {
    const rec = await upload();
    await req(`/api/imports/${rec.id}/reprocess`, json({ readAs: 'columns' }));
    const mapped = await waitFor(rec.id, ['needs_mapping', 'review', 'failed']);
    expect(mapped.status).toBe('needs_mapping');
    expect(mapped.extraction.engine).toBe('csv');

    const settings = (await (await req('/api/settings')).json()) as Record<string, { engine: string }>;
    await req('/api/settings', { method: 'PUT', headers: { ...CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, extraction: { ...settings.extraction, engine: 'ocr' } }) });
    await req(`/api/imports/${rec.id}/reprocess`, json({}));
    const fallback = await waitFor(rec.id, ['needs_mapping', 'review', 'failed']);
    expect(fallback.status).toBe('needs_mapping');
    expect(fallback.extraction.warnings[0]).toMatch(/does not look like a list of payments, but Claude is not available/);
  });
});
