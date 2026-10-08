// Spreadsheet exports (src/server/ingest/xlsx.ts): .xlsx, legacy .xls and HTML tables saved as .xls,
// read into rows for the CSV profiles. The workbooks are made here; all data is invented.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { detectKind } from '../src/server/ingest/detect';
import { sheetRows } from '../src/server/ingest/xlsx';
import type { ImportRecord } from '../src/shared/schema';

const CSRF = { 'x-finance-csrf': '1' };

/** A bank-style export: a title row, a blank row, then the table, with real date cells. */
function workbook(bookType: XLSX.BookType): Buffer {
  const rows = [
    ['Statement for account ending 4821'],
    [],
    ['Date', 'Description', 'Amount'],
    [new Date(Date.UTC(2026, 8, 1)), 'TESCO STORES 3297', -12.5],
    [new Date(Date.UTC(2026, 8, 2)), 'SALARY ACME LTD', 2150.75],
    [new Date(Date.UTC(2026, 8, 3)), 'PRET A MANGER', -4.2],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Notes');
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

describe('reading a spreadsheet', () => {
  it('takes the first sheet with a table; dates as YYYY-MM-DD, numbers in full', () => {
    for (const bookType of ['xlsx', 'xls'] as const) {
      const { rows, sheet } = sheetRows(workbook(bookType));
      expect(sheet, bookType).toBe('Transactions');
      expect(rows, bookType).toEqual([['Statement for account ending 4821'], ['Date', 'Description', 'Amount'], ['2026-09-01', 'TESCO STORES 3297', '-12.5'], ['2026-09-02', 'SALARY ACME LTD', '2150.75'], ['2026-09-03', 'PRET A MANGER', '-4.2']]);
    }
  });

  it('knows a spreadsheet by its bytes or its name, including an HTML table saved as .xls', () => {
    expect(detectKind('export.xlsx', workbook('xlsx'))).toBe('xlsx');
    expect(detectKind('export.dat', workbook('xls'))).toBe('xlsx');
    const html = Buffer.from('<table><tr><td>Date</td><td>Description</td><td>Amount</td></tr><tr><td>01/09/2026</td><td>TESCO</td><td>-12.50</td></tr></table>');
    expect(detectKind('statement.xls', html)).toBe('xlsx');
    expect(sheetRows(html).rows).toEqual([
      ['Date', 'Description', 'Amount'],
      ['01/09/2026', 'TESCO', '-12.50'],
    ]);
    expect(() => sheetRows(XLSX.write(XLSX.utils.book_new(), { type: 'buffer', bookType: 'xlsx' }) as Buffer)).toThrow();
  });
});

describe('importing a spreadsheet', () => {
  let app: App;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finance-xlsx-'));
    const config = loadConfig({ FINANCE_DATA_DIR: path.join(dir, 'data'), FINANCE_WORK_DIR: path.join(dir, 'work'), FINANCE_WATCH: '0' });
    config.webDist = path.join(dir, 'no-web');
    app = await createApp(config, { version: 'test', env: {}, inbox: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = (p: string, init: RequestInit = {}) => app.app.request(`http://127.0.0.1${p}`, { ...init, headers: { host: '127.0.0.1', ...(init.headers ?? {}) } });

  it('goes through the CSV profiles, like a CSV of the same layout', async () => {
    const form = new FormData();
    form.append('file', new Blob([workbook('xlsx')]), 'current-account.xlsx');
    const { results } = (await (await req('/api/imports', { method: 'POST', headers: CSRF, body: form })).json()) as { results: { id: string }[] };
    let rec: ImportRecord | undefined;
    for (let i = 0; i < 100 && rec?.status !== 'review'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rec = (await (await req(`/api/imports/${results[0]!.id}`)).json()) as ImportRecord;
    }
    expect(rec!.status).toBe('review');
    expect(rec!.document.mediaType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(rec!.extraction.engine).toBe('csv');
    expect(rec!.extraction.engineVersion).toMatch(/^xlsx-1\+/);
    expect(rec!.extraction.detail).toMatch(/^sheet “Transactions”/);
    expect(rec!.draft!.sections[0]!.transactions.map((t) => [t.date, t.amount, t.description])).toEqual([
      ['2026-09-01', -12.5, 'TESCO STORES 3297'],
      ['2026-09-02', 2150.75, 'SALARY ACME LTD'],
      ['2026-09-03', -4.2, 'PRET A MANGER'],
    ]);
    const table = (await (await req(`/api/imports/${results[0]!.id}/table`)).json()) as { sheet: string; rows: string[][] };
    expect(table.sheet).toBe('Transactions');
  });
});
