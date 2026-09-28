// The inbox folder: drop files in (or point a Syncthing/cloud folder at it) and each becomes an
// import waiting for review. Files are moved out of the inbox once safely in the work area.

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ACCEPTED_EXTENSIONS } from './detect';
import type { ImportService } from './service';

const IGNORE = /^\.|^README\.md$|\.(part|crdownload|tmp|download|swp)$|~$/i;

export class InboxWatcher {
  private watcher?: FSWatcher | undefined;
  private inFlight = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  lastError?: string | undefined;

  constructor(
    readonly dir: string,
    private readonly service: ImportService,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const f of await readdir(this.dir)) this.consider(f);
    try {
      this.watcher = watch(this.dir, (_e, filename) => {
        if (filename) this.consider(filename.toString());
      });
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
  }

  private consider(name: string): void {
    if (IGNORE.test(name) || this.inFlight.has(name)) return;
    if (!ACCEPTED_EXTENSIONS.includes(path.extname(name).toLowerCase())) return;
    clearTimeout(this.timers.get(name));
    // Wait for the file to stop growing (syncs and copies arrive in pieces).
    this.timers.set(
      name,
      setTimeout(() => void this.ingestWhenStable(name), 1500),
    );
  }

  private async ingestWhenStable(name: string, lastSize = -1): Promise<void> {
    const file = path.join(this.dir, name);
    let size: number;
    let mtime: Date;
    try {
      const s = await stat(file);
      if (!s.isFile()) return;
      size = s.size;
      mtime = s.mtime;
    } catch {
      return; // gone
    }
    if (size !== lastSize) {
      this.timers.set(
        name,
        setTimeout(() => void this.ingestWhenStable(name, size), 1500),
      );
      return;
    }
    this.inFlight.add(name);
    try {
      const bytes = await readFile(file);
      const res = await this.service.create({ fileName: name, bytes, lastModified: mtime.toISOString(), origin: 'inbox' });
      if (res.record || res.duplicateOf) await rm(file, { force: true });
      this.lastError = undefined;
    } catch (err) {
      this.lastError = `${name}: ${(err as Error).message}`;
      console.error(`[inbox] ${this.lastError}`);
    } finally {
      this.inFlight.delete(name);
    }
  }
}
