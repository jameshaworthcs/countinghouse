// Small filesystem and concurrency helpers.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortHash(...parts: (string | number | undefined)[]): string {
  return sha256(parts.map((p) => String(p ?? '')).join('␟')).slice(0, 16);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Write a file atomically: temp file in the same directory, then rename over the target. */
export async function atomicWrite(file: string, content: string | Buffer, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomHex(4)}`;
  try {
    await writeFile(tmp, content, mode === undefined ? undefined : { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Serialises async critical sections. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Run at most `limit` tasks at once. */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      };
      this.queue.push(start);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) this.queue.shift()!();
  }
}

/** Timestamp in ISO 8601 with the local offset, e.g. 2026-09-28T20:15:00+01:00. */
export function nowISO(date: Date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function safeFileName(name: string, maxLength = 60): string {
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = path
    .basename(name, path.extname(name))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxLength);
  return `${base || 'file'}${ext}`;
}
