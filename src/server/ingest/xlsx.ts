// Spreadsheet exports (.xlsx, .xls, and the HTML tables some banks save as .xls), read into rows of
// text for the CSV profiles and column mapping (docs/INGESTION.md). Dates become YYYY-MM-DD and
// numbers keep full precision, whatever the cell's format.
//
// A spreadsheet that is not a list of payments (a timesheet, a form, a sheet a month) is read by
// Claude instead, from `workbookText`: every sheet's cells as text, the only thing sent.

import * as XLSX from 'xlsx';

export const XLSX_ENGINE_VERSION = 'xlsx-1';

/** SheetJS's number-format helpers, which its types leave untyped. */
const SSF = XLSX.SSF as unknown as { is_date(format: string): boolean; parse_date_code(value: number): { y: number; m: number; d: number } | null };

/** One cell as text: a date as YYYY-MM-DD, a number as written in full, text as it is. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  if (cell.t === 'n' && typeof cell.v === 'number') {
    const format = typeof cell.z === 'string' ? cell.z : undefined;
    if (format && SSF.is_date(format)) {
      const p = SSF.parse_date_code(cell.v);
      if (p) return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    return String(cell.v);
  }
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.t === 'e') return '';
  return String(cell.v).trim();
}

// raw: text cells stay text. Without it SheetJS reads "01/09/2026" in an HTML table as 9 January
// (US order); the CSV profiles read it day first, as a UK bank means it.
const readBook = (bytes: Uint8Array, shown = false) => XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false, cellNF: true, cellText: shown, dense: false });

/**
 * The rows of the workbook's first sheet with a table in it (two rows or more with text), or of the
 * sheet named, each cell as text. Empty rows are dropped, as the CSV reader drops them.
 */
export function sheetRows(bytes: Uint8Array, only?: string): { rows: string[][]; sheet: string; sheets: string[] } {
  const wb = readBook(bytes);
  const tables: { name: string; rows: string[][] }[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws?.['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined));
      while (row.length && row[row.length - 1] === '') row.pop();
      if (row.some((v) => v !== '')) rows.push(row);
    }
    if (rows.length >= 2) tables.push({ name, rows });
  }
  const first = (only !== undefined ? tables.find((t) => t.name === only) : undefined) ?? tables[0];
  if (!first) throw new Error('No table was found in this spreadsheet.');
  return { rows: first.rows, sheet: first.name, sheets: tables.map((t) => t.name) };
}

/** One non-empty cell: where it is, its text as the CSV reader gives it, and how the sheet shows it. */
export interface SheetCell {
  /** "D10" */
  ref: string;
  text: string;
  /** A number cell's value (dates excepted). */
  value?: number;
  /** The cell as the spreadsheet shows it, when that differs from `text` ("£115.00"). */
  shown?: string;
  /** Formatted as money (a currency symbol in its number format). */
  money?: boolean;
  /** A date cell (its text is YYYY-MM-DD). */
  date?: boolean;
}

export interface Sheet {
  name: string;
  hidden: boolean;
  /** Rows with any text, by their row number in the sheet (1-based). */
  rows: { r: number; cells: SheetCell[] }[];
}

const MONEY_FORMAT = /[£$€¥]|\[\$[^\]]*\]/;

/** Every sheet with two rows or more of text, cell by cell. */
export function workbookSheets(bytes: Uint8Array): Sheet[] {
  const wb = readBook(bytes, true);
  const out: Sheet[] = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    if (!ws?.['!ref']) return;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: Sheet['rows'] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: SheetCell[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = ws[ref] as XLSX.CellObject | undefined;
        const text = cellText(cell);
        if (text === '') continue;
        const format = typeof cell?.z === 'string' ? cell.z : '';
        const date = cell?.t === 'd' || (cell?.t === 'n' && Boolean(format) && SSF.is_date(format));
        const item: SheetCell = { ref, text };
        if (date) item.date = true;
        else if (cell?.t === 'n' && typeof cell.v === 'number') {
          item.value = cell.v;
          if (MONEY_FORMAT.test(format)) item.money = true;
        }
        const shown = typeof cell?.w === 'string' ? cell.w.trim() : '';
        if (!date && shown && shown !== text) item.shown = shown;
        cells.push(item);
      }
      if (cells.length) rows.push({ r: r + 1, cells });
    }
    if (rows.length >= 2) out.push({ name, hidden: Boolean(wb.Workbook?.Sheets?.[i]?.Hidden), rows });
  });
  return out;
}

/** Numbers as text: full precision, without floating-point noise ("98.38333333333334" → "98.383333"). */
const numberText = (v: number) => String(Number(v.toFixed(6)));

/**
 * The workbook as text for the reader: each sheet's rows, each cell as REF=value, with how the
 * sheet shows it in brackets when that differs ("P10=115 [£115.00]"). Dates are YYYY-MM-DD.
 */
export function workbookText(sheets: Sheet[], fileName: string): string {
  const lines = [`Spreadsheet "${fileName}": ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} with content (${sheets.map((s) => `"${s.name}"`).join(', ')}).`, 'Each line is one row: its number, then its non-empty cells as CELL=value; [brackets] show how the sheet displays a value. Dates are YYYY-MM-DD.', ''];
  for (const s of sheets) {
    lines.push(`=== Sheet "${s.name}"${s.hidden ? ' (hidden)' : ''} ===`);
    for (const row of s.rows) lines.push(`${row.r}: ${row.cells.map((c) => `${c.ref}=${c.value !== undefined ? numberText(c.value) : c.text.replace(/\s+/g, ' ')}${c.shown ? ` [${c.shown}]` : ''}`).join(' | ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Is this table a list of payments? It is not when no column could hold an amount, or when the
 * workbook has several sheets and the columns could not be worked out with confidence: a sheet a
 * month, a timesheet, a form. Such a spreadsheet is read by Claude, like a PDF.
 */
export function looksLikeLedger(suggestion: { confident: boolean; profile: { columns: { amount?: unknown; debit?: unknown; credit?: unknown } } } | null, sheets: number): boolean {
  if (!suggestion) return false;
  const c = suggestion.profile.columns;
  if (c.amount === undefined && c.debit === undefined && c.credit === undefined) return false;
  return suggestion.confident || sheets < 2;
}
