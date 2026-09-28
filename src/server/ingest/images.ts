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
  for (const re of patterns) {
    const m = re.exec(base);
    if (m) {
      const d = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (d && d <= dateOf(Date.now() + 86_400_000)) return d;
    }
  }
  return null;
}

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
