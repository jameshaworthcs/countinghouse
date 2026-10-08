// Git plumbing for the leak guard: what a commit adds, what a tree holds, every file version and
// message in a history. Paths are relative to the repository root.

import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 1 << 30;
export const ZERO = '0000000000000000000000000000000000000000';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function gitBytes(root: string, args: string[], input?: string): Buffer {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
}

export const git = (root: string, args: string[], input?: string) => gitBytes(root, args, input).toString('utf8');

export function tryGit(root: string, args: string[]): string | undefined {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
}

export const repoRoot = (cwd: string) => tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();

/**
 * Data and private operations material. In a repository that holds both code and data (the data is
 * tracked), they are the data's business and are not scanned; anywhere else, adding them is a finding.
 */
export const PRIVATE_DIRS = ['data/', 'ops/'];
export const isPrivatePath = (p: string) => PRIVATE_DIRS.some((d) => p.startsWith(d));

/** True when the repository tracks a data directory (data/meta.json) beside the code. */
export function isCombined(root: string): boolean {
  return !!tryGit(root, ['ls-files', '--', 'data/meta.json'])?.trim() || tryGit(root, ['cat-file', '-e', 'HEAD:data/meta.json']) !== undefined;
}

/** Blob contents by id, through one `git cat-file --batch`. */
export function catBlobs(root: string, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!shas.length) return out;
  const buf = gitBytes(root, ['cat-file', '--batch'], shas.join('\n') + '\n');
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) break;
    const [sha, type, size] = buf.subarray(pos, nl).toString().split(' ');
    if (type === 'missing' || size === undefined) {
      pos = nl + 1;
      continue;
    }
    const n = Number(size);
    out.set(sha!, buf.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return out;
}

export interface FileChange {
  path: string;
  /** A, M, D, T… (renames are reported as a delete and an add). */
  status: string;
  blob: string;
}

export interface AddedBlock {
  path: string;
  firstLine: number;
  text: string;
}

/** C-style quoted paths, as git prints names with control characters or quotes. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const next = body[i + 1]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** What a diff adds: the changed files (with their new blobs) and each run of added lines. */
export function diffAdded(root: string, range: { cached: true } | { from: string; to: string }): { files: FileChange[]; blocks: AddedBlock[] } {
  const spec = 'cached' in range ? ['--cached'] : [range.from, range.to];
  const raw = git(root, ['diff', ...spec, '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff']).split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i]!.replace(/^\n/, '');
    if (!meta.startsWith(':')) break;
    const [, , , blob, status] = meta.slice(1).split(' ');
    files.push({ path: raw[i + 1]!, status: status!, blob: blob! });
  }
  const blocks: AddedBlock[] = [];
  const patch = git(root, ['diff', ...spec, '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']);
  let current: string | undefined;
  let block: AddedBlock | undefined;
  let line = 0;
  const flush = () => {
    if (block) blocks.push(block);
    block = undefined;
  };
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) {
      flush();
      current = undefined;
    } else if (l.startsWith('+++ ')) {
      const name = l.slice(4);
      current = name === '/dev/null' ? undefined : unquote(name).replace(/^b\//, '');
    } else if (l.startsWith('@@ ')) {
      flush();
      line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    } else if (current && l.startsWith('+')) {
      if (!block) block = { path: current, firstLine: line, text: l.slice(1) };
      else block.text += '\n' + l.slice(1);
      line++;
    } else if (l.startsWith('-') || l.startsWith('\\')) {
      // Removed lines and "No newline at end of file" leave the added run going.
    }
  }
  flush();
  return { files, blocks };
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

export function commitInfo(root: string, sha: string): CommitInfo {
  const [full, parents, an, ae, cn, ce, ...message] = git(root, ['log', '-1', '--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B', sha]).split('\0');
  return {
    sha: full!,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName: an!,
    authorEmail: ae!,
    committerName: cn!,
    committerEmail: ce!,
    message: message.join('\0').replace(/\n$/, ''),
  };
}

/** What a commit adds against its first parent (or everything, for a root commit). */
export const commitAdded = (root: string, info: CommitInfo) => diffAdded(root, { from: info.parents[0] ?? EMPTY_TREE, to: info.sha });

export function revList(root: string, args: string[]): string[] {
  return git(root, ['rev-list', '--reverse', ...args])
    .split('\n')
    .filter(Boolean);
}

export interface TreeFile {
  path: string;
  blob: string;
}

export function treeFiles(root: string, rev: string): TreeFile[] {
  const out: TreeFile[] = [];
  for (const entry of git(root, ['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, blob] = entry.slice(0, tab).split(' ');
    // Submodules and symlinks hold no content of their own worth scanning.
    if (type === 'blob' && mode !== '120000') out.push({ path: entry.slice(tab + 1), blob: blob! });
  }
  return out;
}

/** Every (blob, path) any commit reachable from any ref introduced, and every commit with the paths it touched. */
export function historyIndex(root: string): { blobs: Map<string, Set<string>>; commits: Map<string, string[]> } {
  const blobs = new Map<string, Set<string>>();
  const commits = new Map<string, string[]>();
  const tokens = git(root, ['log', '--all', '-m', '--no-renames', '--raw', '--no-abbrev', '--format=%x01%H', '-z']).split('\0');
  let commit: string[] | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^\n/, '');
    if (t.startsWith('\x01')) {
      const sha = t.slice(1);
      commit = commits.get(sha) ?? [];
      commits.set(sha, commit);
    } else if (t.startsWith(':') && commit) {
      const [, mode, , blob, status] = t.slice(1).split(' ');
      const p = tokens[++i]!;
      commit.push(p);
      // Deletions, symlinks and submodules add no content to scan.
      if (status === 'D' || blob === ZERO || mode === '120000' || mode === '160000') continue;
      let paths = blobs.get(blob!);
      if (!paths) blobs.set(blob!, (paths = new Set()));
      paths.add(p);
    }
  }
  // Commits with no changes of their own (an empty commit, a merge seen only through -m) still have messages.
  for (const sha of git(root, ['rev-list', '--all']).split('\n').filter(Boolean)) if (!commits.has(sha)) commits.set(sha, []);
  return { blobs, commits };
}
