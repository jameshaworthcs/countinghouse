// Spreadsheet exports (.xlsx, .xls, and the HTML tables some banks save as .xls), read into rows of
// text for the CSV profiles and column mapping (docs/INGESTION.md). Read on this machine, never sent
// anywhere. Dates become YYYY-MM-DD and numbers keep full precision, whatever the cell's format.

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

/**
 * The rows of the workbook's first sheet with a table in it (two rows or more with text), each cell
 * as text. Empty rows are dropped, as the CSV reader drops them.
 */
export function sheetRows(bytes: Uint8Array): { rows: string[][]; sheet: string; sheets: string[] } {
  // raw: text cells stay text. Without it SheetJS reads "01/09/2026" in an HTML table as 9 January
  // (US order); the CSV profiles read it day first, as a UK bank means it.
  const wb = XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false, cellNF: true, cellText: false, dense: false });
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
  const first = tables[0];
  if (!first) throw new Error('No table was found in this spreadsheet.');
  return { rows: first.rows, sheet: first.name, sheets: wb.SheetNames };
}
