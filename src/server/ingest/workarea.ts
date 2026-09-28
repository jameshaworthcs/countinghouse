// The work area holds uploads that have not been reviewed yet: the file itself and its import
// record (status, extraction, draft). Nothing here is committed to git; on commit the document moves
// into data/documents and the record into data/imports.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportRecordSchema, type DocumentRef, type ImportRecord } from '../../shared/schema';
import { atomicWrite } from '../fsutil';

export class WorkArea {
  readonly filesDir: string;
  readonly importsDir: string;
  readonly extractDir: string;

  constructor(readonly dir: string) {
    this.filesDir = path.join(dir, 'files');
    this.importsDir = path.join(dir, 'imports');
    this.extractDir = path.join(dir, 'extract');
  }

  async init(): Promise<void> {
    for (const d of [this.filesDir, this.importsDir, this.extractDir]) await mkdir(d, { recursive: true, mode: 0o700 });
  }

  filePath(doc: Pick<DocumentRef, 'sha256' | 'fileName'>): string {
    const ext = path.extname(doc.fileName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    return path.join(this.filesDir, `${doc.sha256}${ext}`);
  }

  async saveFile(doc: Pick<DocumentRef, 'sha256' | 'fileName'>, bytes: Buffer): Promise<string> {
    const p = this.filePath(doc);
    await writeFile(p, bytes, { mode: 0o600 });
    return p;
  }

  async readFile(doc: Pick<DocumentRef, 'sha256' | 'fileName'>): Promise<Buffer> {
    return readFile(this.filePath(doc));
  }

  async saveRecord(record: ImportRecord): Promise<void> {
    await atomicWrite(path.join(this.importsDir, `${record.id}.json`), JSON.stringify(ImportRecordSchema.parse(record), null, 2));
  }

  async loadAll(): Promise<ImportRecord[]> {
    const out: ImportRecord[] = [];
    let files: string[] = [];
    try {
      files = (await readdir(this.importsDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    for (const f of files) {
      try {
        const parsed = ImportRecordSchema.safeParse(JSON.parse(await readFile(path.join(this.importsDir, f), 'utf8')));
        if (parsed.success) out.push(parsed.data);
        else console.warn(`[work] ignoring unreadable pending import ${f}`);
      } catch {
        console.warn(`[work] ignoring unreadable pending import ${f}`);
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Remove a pending record; its file too unless another pending record shares it. */
  async remove(record: ImportRecord, others: ImportRecord[]): Promise<void> {
    await rm(path.join(this.importsDir, `${record.id}.json`), { force: true });
    await rm(path.join(this.extractDir, record.id), { recursive: true, force: true });
    if (!others.some((o) => o.id !== record.id && o.document.sha256 === record.document.sha256)) {
      await rm(this.filePath(record.document), { force: true });
    }
  }

  /** A fresh, empty scratch directory for one extraction run. */
  async scratch(importId: string): Promise<string> {
    const dir = path.join(this.extractDir, importId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async clearScratch(importId: string): Promise<void> {
    await rm(path.join(this.extractDir, importId), { recursive: true, force: true });
  }
}
