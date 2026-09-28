// Git integration: every change to data/ becomes a commit, so history is a complete audit log and
// any mistake can be undone. Commits are debounced so one import is one commit, and only paths
// under the data directory are ever staged or committed.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ChangeEvent } from './store';

const exec = promisify(execFile);

export interface GitStatus {
  enabled: boolean;
  repoRoot?: string;
  branch?: string;
  /** Uncommitted changes under the data directory. */
  dirty: number;
  ahead?: number;
  behind?: number;
  remote?: string;
  lastCommit?: { hash: string; date: string; subject: string };
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (allowFail) return '';
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export class GitCommitter {
  private messages: string[] = [];
  private timer?: NodeJS.Timeout | undefined;
  private committing: Promise<void> = Promise.resolve();
  lastError?: string | undefined;

  private constructor(
    readonly repoRoot: string | null,
    /** Data dir relative to the repo root, e.g. "data". */
    readonly dataRel: string,
    private readonly isEnabled: () => boolean,
    private readonly debounceMs: number,
  ) {}

  static async create(dataDir: string, isEnabled: () => boolean, debounceMs = 2500): Promise<GitCommitter> {
    const root = (await git(dataDir, ['rev-parse', '--show-toplevel'], true)).trim();
    if (!root) return new GitCommitter(null, '', () => false, debounceMs);
    const rel = path.relative(root, dataDir) || '.';
    // A data dir that git ignores (e.g. demo-data/) is never committed.
    if (await isIgnored(root, rel)) return new GitCommitter(null, rel, () => false, debounceMs);
    return new GitCommitter(root, rel, isEnabled, debounceMs);
  }

  get enabled(): boolean {
    return this.repoRoot !== null && this.isEnabled();
  }

  /** Record a change; a commit follows once changes stop arriving. */
  queue(event: ChangeEvent): void {
    if (!this.enabled) return;
    this.messages.push(event.message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Commit anything pending now. */
  flush(extraMessage?: string): Promise<void> {
    clearTimeout(this.timer);
    const messages = [...this.messages, ...(extraMessage ? [extraMessage] : [])];
    this.messages = [];
    this.committing = this.committing.then(() => this.commit(messages)).catch((err: Error) => {
      this.lastError = err.message;
      console.error(`[git] ${err.message}`);
    });
    return this.committing;
  }

  private async commit(messages: string[]): Promise<void> {
    if (!this.repoRoot) return;
    await git(this.repoRoot, ['add', '-A', '--', this.dataRel]);
    const staged = await git(this.repoRoot, ['diff', '--cached', '--name-only', '--', this.dataRel]);
    if (!staged.trim()) return;
    const unique = [...new Set(messages.filter(Boolean))];
    const subject = unique.length === 1 ? unique[0]! : unique.length === 0 ? 'data: update' : `data: ${unique.length} changes`;
    const body = unique.length > 1 ? unique.map((m) => `- ${m}`).join('\n') : '';
    const args = ['commit', '--quiet', '-m', subject];
    if (body) args.push('-m', body);
    args.push('-m', 'Committed by the finance app.', '--', this.dataRel);
    await git(this.repoRoot, args);
    this.lastError = undefined;
  }

  async status(): Promise<GitStatus> {
    if (!this.repoRoot) return { enabled: false, dirty: 0 };
    const [branch, porcelain, upstream, last] = await Promise.all([
      git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], true),
      git(this.repoRoot, ['status', '--porcelain', '--', this.dataRel], true),
      git(this.repoRoot, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], true),
      git(this.repoRoot, ['log', '-1', '--format=%h%x1f%aI%x1f%s', '--', this.dataRel], true),
    ]);
    const status: GitStatus = {
      enabled: this.enabled,
      repoRoot: this.repoRoot,
      branch: branch.trim(),
      dirty: porcelain.split('\n').filter(Boolean).length,
    };
    const counts = upstream.trim().split(/\s+/);
    if (counts.length === 2) {
      status.behind = Number(counts[0]);
      status.ahead = Number(counts[1]);
      status.remote = (await git(this.repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}'], true)).trim();
    }
    const [hash, date, subject] = last.trim().split('\x1f');
    if (hash && date && subject) status.lastCommit = { hash, date, subject };
    return status;
  }

  async log(limit = 50): Promise<GitLogEntry[]> {
    if (!this.repoRoot) return [];
    const out = await git(this.repoRoot, ['log', `-n${limit}`, '--format=%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', '--', this.dataRel], true);
    return out
      .split('\x1e')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [hash = '', author = '', date = '', subject = '', body = ''] = chunk.split('\x1f');
        return { hash, author, date, subject, body: body.trim() };
      });
  }
}

async function isIgnored(root: string, rel: string): Promise<boolean> {
  try {
    await exec('git', ['check-ignore', '-q', rel], { cwd: root });
    return true; // exit 0 = ignored
  } catch {
    return false;
  }
}
