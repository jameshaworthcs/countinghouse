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

/** A commit the app made: its hash, subject, and the audit log entries of the changes in it. */
export interface DataCommit {
  hash: string;
  subject: string;
  auditSeqs: number[];
}

export class GitCommitter {
  private messages: string[] = [];
  private auditSeqs: number[] = [];
  /** Told of each commit made (the audit log records it). */
  onCommit?: ((commit: DataCommit) => void) | undefined;
  private timer?: NodeJS.Timeout | undefined;
  private committing: Promise<void> = Promise.resolve();
  lastError?: string | undefined;

  private constructor(
    readonly repoRoot: string | null,
    /** Data dir relative to the repo root, e.g. "data". */
    readonly dataRel: string,
    private readonly isEnabled: () => boolean,
    private readonly debounceMs: number,
    /** The branch data commits must land on (null: any branch, but never a detached HEAD). */
    readonly branch: string | null,
  ) {}

  static async create(dataDir: string, isEnabled: () => boolean, debounceMs = 2500, branch: string | null = null): Promise<GitCommitter> {
    const root = (await git(dataDir, ['rev-parse', '--show-toplevel'], true)).trim();
    if (!root) return new GitCommitter(null, '', () => false, debounceMs, branch);
    const rel = path.relative(root, dataDir) || '.';
    // A data dir that git ignores (e.g. demo-data/) is never committed.
    if (await isIgnored(root, rel)) return new GitCommitter(null, rel, () => false, debounceMs, branch);
    return new GitCommitter(root, rel, isEnabled, debounceMs, branch);
  }

  /** True when the data directory is tracked by git (real data rather than a throwaway copy). */
  get tracked(): boolean {
    return this.repoRoot !== null;
  }

  get enabled(): boolean {
    return this.repoRoot !== null && this.isEnabled();
  }

  /** Record a change; a commit follows once changes stop arriving. */
  queue(event: ChangeEvent): void {
    if (!this.enabled) return;
    this.messages.push(event.message);
    if (event.auditSeq !== undefined) this.auditSeqs.push(event.auditSeq);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Commit anything pending now. */
  flush(extraMessage?: string): Promise<void> {
    clearTimeout(this.timer);
    const messages = [...this.messages, ...(extraMessage ? [extraMessage] : [])];
    const seqs = this.auditSeqs;
    this.messages = [];
    this.auditSeqs = [];
    this.committing = this.committing.then(() => this.commit(messages, seqs)).catch((err: Error) => {
      this.lastError = err.message;
      console.error(`[git] ${err.message}`);
      // The changes stay on disk for the next commit; so do the audit entries that name them.
      this.auditSeqs.unshift(...seqs);
    });
    return this.committing;
  }

  private async commit(messages: string[], auditSeqs: number[] = []): Promise<void> {
    if (!this.repoRoot) return;
    // Data commits belong on one branch. If the checkout holding data/ is on another branch or a
    // detached HEAD, hold them (the changes stay on disk) and say so, rather than scatter the audit
    // log across branches. They are committed by the next flush once the branch is right again.
    const head = (await git(this.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim();
    if (!head || (this.branch && head !== this.branch)) {
      throw new Error(
        `data changes are not being committed: the repository is on ${head ? `branch "${head}"` : 'a detached HEAD'}, not "${this.branch ?? 'a branch'}". Check out ${this.branch ?? 'a branch'} in ${this.repoRoot}; the next change commits everything pending.`,
      );
    }
    await withLockRetry(() => git(this.repoRoot!, ['add', '-A', '--', this.dataRel]));
    const staged = await git(this.repoRoot, ['diff', '--cached', '--name-only', '--', this.dataRel]);
    if (!staged.trim()) {
      this.lastError = undefined;
      return;
    }
    const unique = [...new Set(messages.filter(Boolean))];
    const subject = unique.length === 1 ? unique[0]! : unique.length === 0 ? 'data: update' : `data: ${unique.length} changes`;
    const body = unique.length > 1 ? unique.map((m) => `- ${m}`).join('\n') : '';
    const args = ['commit', '--quiet', '-m', subject];
    if (body) args.push('-m', body);
    // The audit log's entries for these changes (Settings → Audit log) say who made each one.
    const audit = auditSeqs.length ? `\nAudit: ${auditRange(auditSeqs)}` : '';
    args.push('-m', `Committed by the finance app.${audit}`, '--', this.dataRel);
    await withLockRetry(() => git(this.repoRoot!, args));
    this.lastError = undefined;
    if (this.onCommit) {
      const hash = (await git(this.repoRoot, ['rev-parse', '--short', 'HEAD'], true)).trim();
      if (hash) this.onCommit({ hash, subject, auditSeqs });
    }
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

/** "#12, #14–#16": the audit entries in a commit, runs folded. */
export function auditRange(seqs: number[]): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `#${sorted[i]}–#${sorted[j]}` : `#${sorted[i]}`);
    i = j + 1;
  }
  return runs.join(', ');
}

/**
 * Another git process (a person committing code in the same checkout) may hold the index lock for
 * a moment. Retry briefly instead of failing the commit.
 */
async function withLockRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !/index\.lock|Unable to create .*\.lock/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 250 * i));
    }
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
