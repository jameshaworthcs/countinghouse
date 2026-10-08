// Text helpers for the leak guard: normalising text the same way for tokens and for what is
// scanned, a regular expression for a whole list of tokens, masking, globs and line numbers.

/** NFKC, lower case, and ’ ‘ ʼ read as '. Lengths may change; line breaks never do. */
export function normalise(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[‘’ʼ]/g, "'");
}

/** A token as it is stored and looked up: normalised, trimmed, with each run of whitespace as one space. */
export function tokenKey(token: string): string {
  return normalise(token).trim().replace(/\s+/g, ' ');
}

const SYNTAX = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
const escapeChar = (ch: string) => (SYNTAX.has(ch) ? `\\${ch}` : ch);

interface TrieNode {
  end: boolean;
  next: Map<string, TrieNode>;
}

function emit(node: TrieNode): string {
  const parts: string[] = [];
  for (const [ch, child] of [...node.next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push((ch === ' ' ? '\\s+' : escapeChar(ch)) + emit(child));
  }
  if (!parts.length) return '';
  const body = parts.length === 1 && !node.end ? parts[0]! : `(?:${parts.join('|')})`;
  return node.end ? `${body}?` : body;
}

/**
 * One regular expression source for every token, shaped as a trie so that matching costs about the
 * same for ten tokens as for ten thousand. Spaces in a token match any run of whitespace. Tokens
 * must already be token keys.
 */
export function trieSource(tokens: Iterable<string>): string | undefined {
  const root: TrieNode = { end: false, next: new Map() };
  let count = 0;
  for (const token of tokens) {
    if (!token) continue;
    let node = root;
    for (const ch of token) {
      let child = node.next.get(ch);
      if (!child) node.next.set(ch, (child = { end: false, next: new Map() }));
      node = child;
    }
    node.end = true;
    count++;
  }
  return count ? emit(root) : undefined;
}

/** Bounded on both sides by something that is not a letter or a digit. */
export const bounded = (source: string) => `(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`;

/**
 * Mask a match for output: the first character of each word stays and the rest become `*`, keeping
 * separators (`J**** H******`). Anything with three or more digits (an amount, an NI number, a sort
 * code) keeps only its first character (`£2*,***.**`).
 */
export function mask(value: string): string {
  if ((value.match(/\p{N}/gu)?.length ?? 0) >= 3) {
    let kept = false;
    return value.replace(/[\p{L}\p{N}]/gu, (c) => (kept ? '*' : ((kept = true), c)));
  }
  return value.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const [first, ...rest] = [...word];
    return first! + '*'.repeat(rest.length);
  });
}

/** Line number (1-based) for each offset, from a sorted list of where each line starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** A glob as a regular expression: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += /[\\^$.+()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${source}$`);
}

/** True for content git would call binary: a NUL byte in the first 8 KB. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}
