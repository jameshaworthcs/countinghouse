// Screenshot handling: when was it taken, and how to present it to a vision model so small text
// stays legible (long scrolling screenshots are cut into overlapping tiles).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import sharp, { type Metadata } from 'sharp';
import { dateOf, makeDate, type ISODate } from '../../shared/dates';
import type { DateSource } from '../../shared/schema';

/** Dates in screenshot / photo file names from iOS, Android, macOS, Windows, GNOME and apps. */
export function dateFromFileName(name: string): ISODate | null {
  const base = path.basename(name);
  const patterns = [
    /(20\d{2})[-_.](\d{2})[-_.](\d{2})/, // 2026-09-26, 2026_09_26, 2026.09.26
    /(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/, // 20260926
    /(?:^|[^\d])(20\d{2})(\d{2})(\d{2})[-_ T]?\d{4,6}/, // 20260926-143012 / 20260926_143012
  ];
  const latest = dateOf(Date.now() + 86_400_000);
  for (const re of patterns) {
    const m = re.exec(base);
    if (m) {
      const d = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (d && d <= latest) return d;
    }
  }
  // Dates written with the month's name: "5th_June_2024", "17th Apr 2026", "2025Sept18th", "June 3 2025".
  const words = base.toLowerCase();
  const day = '(\\d{1,2})(?:st|nd|rd|th)?';
  const sep = '[\\s_.,-]*';
  const named: [RegExp, (m: RegExpExecArray) => [string, string, string]][] = [
    [new RegExp(`(?<![\\d])${day}${sep}${MONTH}${sep}(20\\d{2})(?!\\d)`), (m) => [m[3]!, m[2]!, m[1]!]],
    [new RegExp(`(?<![\\d])(20\\d{2})${sep}${MONTH}${sep}${day}(?!\\d)`), (m) => [m[1]!, m[2]!, m[3]!]],
    [new RegExp(`${MONTH}${sep}${day}${sep}(20\\d{2})(?!\\d)`), (m) => [m[3]!, m[1]!, m[2]!]],
  ];
  for (const [re, parts] of named) {
    const m = re.exec(words);
    if (!m) continue;
    const [y, mon, d] = parts(m);
    const date = makeDate(Number(y), MONTHS.indexOf(mon.slice(0, 3)) + 1, Number(d));
    if (date && date <= latest) return date;
  }
  // Day first with separators, as ii names exports: 29-09-2026.
  const dmySep = /(?:^|[^\d])(\d{2})[-_.](\d{2})[-_.](20\d{2})(?:[^\d]|$)/.exec(base);
  if (dmySep) {
    const d = makeDate(Number(dmySep[3]), Number(dmySep[2]), Number(dmySep[1]));
    if (d && d <= latest) return d;
  }
  // Day first with no separators, as some banks name statements: 05072026 is 5 July 2026.
  const dmy = /(?:^|[^\d])(\d{2})(\d{2})(20\d{2})(?:[^\d]|$)/.exec(base);
  if (dmy) {
    const d = makeDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    if (d && d <= latest) return d;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A month's name or abbreviation, not part of a longer word. */
const MONTH = '(?<![a-z])(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])';

export interface CaptureDate {
  date: ISODate;
  source: DateSource;
}

/** Best-known capture date: embedded metadata, then file name, then the file's modified time. */
export async function captureDate(bytes: Buffer, fileName: string, lastModified?: string): Promise<CaptureDate | null> {
  try {
    const meta = (await exifr.parse(bytes, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateCreated', 'ModifyDate'],
      xmp: true,
      tiff: true,
      exif: true,
    })) as Record<string, unknown> | undefined;
    const v = meta?.DateTimeOriginal ?? meta?.CreateDate ?? meta?.DateCreated ?? meta?.ModifyDate;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return { date: dateOf(v), source: 'exif' };
    if (typeof v === 'string') {
      const m = /(\d{4})[:-](\d{2})[:-](\d{2})/.exec(v);
      const d = m ? makeDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
      if (d) return { date: d, source: 'exif' };
    }
  } catch {
    // No or unreadable metadata.
  }
  const fromName = dateFromFileName(fileName);
  if (fromName) return { date: fromName, source: 'filename' };
  if (lastModified) {
    const t = Date.parse(lastModified);
    if (!Number.isNaN(t)) return { date: dateOf(t), source: 'file-modified' };
  }
  return null;
}

export interface PreparedImages {
  files: string[];
  tiled: boolean;
  width: number;
  height: number;
}

/**
 * Write model-ready PNGs into `outDir`. Tall screenshots (height > 2.4 × width) are split into
 * overlapping tiles about 1.6 × width tall, so text is not shrunk into illegibility.
 */
export async function prepareImage(bytes: Buffer, outDir: string, baseName = 'page'): Promise<PreparedImages> {
  await mkdir(outDir, { recursive: true });
  let image = sharp(bytes, { failOn: 'none', limitInputPixels: 200_000_000 }).rotate();
  let meta: Metadata;
  try {
    meta = await image.metadata();
  } catch (err) {
    throw new Error(`Could not read this image (${(err as Error).message}). HEIC photos need converting to JPEG or PNG first.`);
  }
  let width = meta.autoOrient?.width ?? meta.width ?? 0;
  let height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error('Image has no dimensions');
  // Very wide/large images: cap the long edge at 4000px first.
  if (Math.max(width, height) > 4000 && height / width <= 2.4) {
    const buf = await image.resize({ width: 4000, height: 4000, fit: 'inside' }).png().toBuffer();
    image = sharp(buf);
    const m2 = await image.metadata();
    width = m2.width ?? width;
    height = m2.height ?? height;
  }
  const normalised = await image.png().toBuffer();
  if (height / width <= 2.4) {
    const file = path.join(outDir, `${baseName}-1.png`);
    await writeFile(file, normalised);
    return { files: [file], tiled: false, width, height };
  }
  const tileHeight = Math.round(width * 1.6);
  const overlap = Math.round(tileHeight * 0.12);
  const files: string[] = [];
  for (let top = 0, i = 1; top < height; top += tileHeight - overlap, i++) {
    const h = Math.min(tileHeight, height - top);
    if (h < overlap && i > 1) break;
    const file = path.join(outDir, `${baseName}-${i}.png`);
    await sharp(normalised).extract({ left: 0, top, width, height: h }).png().toFile(file);
    files.push(file);
    if (top + h >= height) break;
  }
  return { files, tiled: files.length > 1, width, height };
}
