// What kind of file is this? Decided from content first, then name.

import path from 'node:path';

export type FileKind = 'csv' | 'xlsx' | 'ofx' | 'qif' | 'santander-txt' | 'pdf' | 'image' | 'unsupported';

export const MEDIA_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.ofx': 'application/x-ofx',
  '.qfx': 'application/x-ofx',
  '.qif': 'application/qif',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
};

/** An old Excel workbook (and other OLE2 files) starts with this. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** A ZIP file, as an .xlsx is. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

export const ACCEPTED_EXTENSIONS = Object.keys(MEDIA_TYPES);
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function mediaTypeFor(fileName: string, bytes?: Uint8Array): string {
  if (bytes) {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (bytes.length > 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
    if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 12)).match(/ftyp(heic|heix|mif1|msf1|hevc)/)) return 'image/heic';
  }
  return MEDIA_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/** Decode text exports: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function detectKind(fileName: string, bytes: Uint8Array): FileKind {
  const mt = mediaTypeFor(fileName, bytes);
  if (mt === 'application/pdf') return 'pdf';
  if (mt.startsWith('image/')) return 'image';
  const ext = path.extname(fileName).toLowerCase();
  // Spreadsheets: by their bytes, or by name for the HTML tables some banks save as .xls.
  if (startsWith(bytes, OLE2) || (startsWith(bytes, ZIP) && (ext === '.xlsx' || ext === '.xlsm')) || ext === '.xls' || ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  const head = decodeText(bytes.subarray(0, 4096));
  if (/<OFX>|OFXHEADER|<\?OFX/i.test(head)) return 'ofx';
  if (/^\s*!(Type|Account|Option)/im.test(head)) return 'qif';
  if (/^\s*From:\s*\d{1,2}\/\d{1,2}\/\d{4}\s+to\s+\d{1,2}\/\d{1,2}\/\d{4}/im.test(head) && /Account:/i.test(head)) return 'santander-txt';
  if (ext === '.ofx' || ext === '.qfx') return 'ofx';
  if (ext === '.qif') return 'qif';
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return 'csv';
  // Unknown extension but looks like delimited text.
  if (/^[^\n]*[,;\t][^\n]*\n/.test(head)) return 'csv';
  return 'unsupported';
}
