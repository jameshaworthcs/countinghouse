// The leak guard: keeps personal data out of code, tests, docs and commit messages
// (docs/LEAK_GUARD.md). It runs under plain Node (types stripped), so a hook costs a fraction of a
// second.
//
//   npm run leak-guard -- --staged                 added lines and new files in the index (pre-commit)
//   npm run leak-guard -- --commit-msg <file>      a commit message (commit-msg)
//   npm run leak-guard -- --range <a>..<b>         each commit's message, identity, added lines and new files
//   npm run leak-guard -- --pre-push <remote>      the commits git is about to push (reads the pre-push input)
//   npm run leak-guard -- --tree [<rev>]           every file at a revision (HEAD by default)
//   npm run leak-guard -- --history                every file version and message reachable from any ref
//   npm run leak-guard -- --stdin --path <p>       stdin, as the content of <p>
//   npm run leak-guard -- --claude-hook            a Claude Code PreToolUse hook (Write, Edit, NotebookEdit)
//   npm run leak-guard -- --deep                   postcode and address candidates from data/imports, for the extras file
//   npm run leak-guard -- --rebuild                rebuild the denylist now
//
// Options: --data <dir>, --patterns-only (CI: no data), --json, --summary, --pence, --exclude <glob>
// (repeatable), --repo <dir>. Output is always masked. Exit 0 clean, 1 findings, 2 error (for
// --claude-hook, 2 blocks the write).

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, loadDenylist, loadExtras, resolveDataDir, type BuildStats, type Denylist, type Extras } from './leak-guard/denylist.ts';
import { commitAdded, commitInfo, catBlobs, diffAdded, git, historyIndex, isCombined, isPrivatePath, repoRoot, revList, treeFiles, tryGit, ZERO, type FileChange, type AddedBlock } from './leak-guard/git.ts';
import { fileRules } from './leak-guard/patterns.ts';
import { ALLOW_FILE, Allowlist, describe, Scanner, type Finding } from './leak-guard/scan.ts';
import { globToRegExp, isBinary, mask, tokenKey } from './leak-guard/text.ts';

interface Args {
  mode?: string;
  value?: string;
  data?: string;
  patternsOnly: boolean;
  json: boolean;
  summary: boolean;
  pence: boolean;
  rebuild: boolean;
  path?: string;
  repo?: string;
  exclude: RegExp[];
}

const MODES = ['--staged', '--commit-msg', '--range', '--pre-push', '--tree', '--history', '--stdin', '--claude-hook', '--deep', '--rebuild'];
const TAKES_VALUE = new Set(['--commit-msg', '--range', '--pre-push', '--tree']);

function parseArgs(argv: string[]): Args {
  const args: Args = { patternsOnly: false, json: false, summary: false, pence: false, rebuild: false, exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (MODES.includes(a)) {
      if (a === '--rebuild') args.rebuild = true;
      if (a !== '--rebuild' || !args.mode) args.mode = a;
      if (TAKES_VALUE.has(a) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) args.value = argv[++i];
    } else if (a === '--data') args.data = next();
    else if (a === '--path') args.path = next();
    else if (a === '--repo') args.repo = next();
    else if (a === '--exclude') args.exclude.push(globToRegExp(next()));
    else if (a === '--patterns-only') args.patternsOnly = true;
    else if (a === '--json') args.json = true;
    else if (a === '--summary') args.summary = true;
    else if (a === '--pence') args.pence = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error(`give a mode: ${MODES.join(', ')}`);
  return args;
}

const warn = (message: string) => process.stderr.write(`leak-guard: ${message}\n`);

/** The denylist and extras, unless --patterns-only. */
async function loadSources(args: Args, quiet: boolean): Promise<{ denylist?: Denylist; extras?: Extras; stats?: BuildStats }> {
  if (args.patternsOnly) return {};
  const extras = loadExtras();
  const dataDir = resolveDataDir(args.data);
  if (!dataDir || !existsSync(dataDir)) {
    if (!quiet) warn(dataDir ? `no data directory at ${dataDir}: patterns and extras only` : 'no data directory configured (--data, ~/.config/finance/leak-guard.json or FINANCE_DATA_DIR): patterns and extras only');
    return { extras };
  }
  const { denylist, built, stats } = await loadDenylist(dataDir, { rebuild: args.rebuild });
  if (built && !quiet) warn(`built the denylist from ${dataDir} (${denylist.tokens.length} tokens, ${denylist.amounts.length} amounts)`);
  return { denylist, extras, stats };
}

interface Context {
  root: string;
  combined: boolean;
  scanner: Scanner;
  args: Args;
}

/** Paths left out: --exclude, and private paths in a repository that holds the data too. */
function skipped(ctx: Context, p: string): boolean {
  return ctx.args.exclude.some((re) => re.test(p)) || (ctx.combined && isPrivatePath(p));
}

/** A private path being added outside a combined repository is a finding of its own. */
function privatePathFinding(ctx: Context, p: string, where = p): Finding[] {
  return !ctx.combined && isPrivatePath(p) && !ctx.args.exclude.some((re) => re.test(p))
    ? [{ path: where, line: 0, category: 'file', rule: 'private-path', masked: p.split('/')[0] + '/…' }]
    : [];
}

async function scanAdded(ctx: Context, files: FileChange[], blocks: AddedBlock[], label = (p: string) => p): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const b of blocks) if (!skipped(ctx, b.path)) out.push(...ctx.scanner.scanText(label(b.path), b.text, b.firstLine));
  const relevant = files.filter((f) => f.status !== 'D' && !skipped(ctx, f.path));
  for (const f of files) if (f.status === 'A') out.push(...privatePathFinding(ctx, f.path, label(f.path)));
  const contents = catBlobs(ctx.root, relevant.map((f) => f.blob));
  for (const f of relevant) {
    const bytes = contents.get(f.blob);
    if (!bytes) continue;
    for (const hit of await fileRules(f.path, bytes)) {
      if (hit.rule === 'document-file' && f.status !== 'A') continue;
      out.push({ path: label(f.path), line: 0, category: 'file', rule: hit.rule, masked: hit.message, ...(hit.warning ? { warning: true } : {}) });
    }
  }
  return out;
}

/** A commit message without git's comments and anything below the scissors line. */
function messageText(raw: string): string {
  const scissors = raw.indexOf('# ------------------------ >8 ------------------------');
  return (scissors === -1 ? raw : raw.slice(0, scissors))
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
}

/** True when everything staged is private data in a combined repository: the app's own data commits. */
function dataOnlyStaged(ctx: Context): boolean {
  if (!ctx.combined) return false;
  const staged = git(ctx.root, ['diff', '--cached', '--name-only', '-z', '--no-renames']).split('\0').filter(Boolean);
  return staged.length > 0 && staged.every(isPrivatePath);
}

async function scanCommits(ctx: Context, shas: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  const email = tryGit(ctx.root, ['config', 'user.email'])?.trim();
  for (const sha of shas) {
    const info = commitInfo(ctx.root, sha);
    const short = info.sha.slice(0, 10);
    const { files, blocks } = commitAdded(ctx.root, info);
    if (ctx.combined && files.length && files.every((f) => isPrivatePath(f.path))) continue;
    out.push(...ctx.scanner.scanText(`commit ${short} (message)`, info.message));
    for (const [role, address] of [
      ['author', info.authorEmail],
      ['committer', info.committerEmail],
    ] as const) {
      if (email && address.toLowerCase() !== email.toLowerCase()) out.push({ path: `commit ${short}`, line: 0, category: 'identity', rule: `${role}-email`, masked: `${mask(address)} is not the configured identity` });
    }
    out.push(...(await scanAdded(ctx, files, blocks, (p) => `${p} @${short}`)));
  }
  return out;
}

async function scanTree(ctx: Context, rev: string): Promise<Finding[]> {
  const files = treeFiles(ctx.root, rev).filter((f) => !skipped(ctx, f.path));
  const contents = catBlobs(ctx.root, [...new Set(files.map((f) => f.blob))]);
  const out: Finding[] = [];
  for (const f of files) {
    out.push(...privatePathFinding(ctx, f.path));
    const bytes = contents.get(f.blob);
    if (!bytes) continue;
    if (!isBinary(bytes)) out.push(...ctx.scanner.scanText(f.path, bytes.toString('utf8')));
    for (const hit of await fileRules(f.path, bytes)) out.push({ path: f.path, line: 0, category: 'file', rule: hit.rule, masked: hit.message, ...(hit.warning ? { warning: true } : {}) });
  }
  return out;
}

async function scanHistory(ctx: Context): Promise<Finding[]> {
  const { blobs, commits } = historyIndex(ctx.root);
  const out: Finding[] = [];
  const wanted = [...blobs].map(([blob, paths]) => [blob, [...paths].filter((p) => !skipped(ctx, p))] as const).filter(([, paths]) => paths.length);
  for (const [, paths] of wanted) for (const p of paths) out.push(...privatePathFinding(ctx, p));
  const contents = catBlobs(ctx.root, wanted.map(([blob]) => blob));
  for (const [blob, paths] of wanted) {
    const bytes = contents.get(blob);
    if (!bytes) continue;
    // One scan per file version; it is reported under its first path, with the others counted.
    const where = paths.length > 1 ? `${paths[0]} (+${paths.length - 1} paths) @${blob.slice(0, 10)}` : `${paths[0]} @${blob.slice(0, 10)}`;
    if (!isBinary(bytes)) out.push(...ctx.scanner.scanText(where, bytes.toString('utf8')));
    for (const p of paths) for (const hit of await fileRules(p, bytes)) out.push({ path: `${p} @${blob.slice(0, 10)}`, line: 0, category: 'file', rule: hit.rule, masked: hit.message, ...(hit.warning ? { warning: true } : {}) });
  }
  const email = tryGit(ctx.root, ['config', 'user.email'])?.trim();
  for (const [sha, paths] of commits) {
    if (ctx.combined && paths.length && paths.every(isPrivatePath)) continue;
    const info = commitInfo(ctx.root, sha);
    const short = sha.slice(0, 10);
    out.push(...ctx.scanner.scanText(`commit ${short} (message)`, info.message));
    for (const [role, address] of [
      ['author', info.authorEmail],
      ['committer', info.committerEmail],
    ] as const) {
      if (email && address.toLowerCase() !== email.toLowerCase()) out.push({ path: `commit ${short}`, line: 0, category: 'identity', rule: `${role}-email`, masked: `${mask(address)} is not the configured identity` });
    }
  }
  return out;
}

/** Git's pre-push input: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
function prePushCommits(root: string, input: string): string[] {
  const shas: string[] = [];
  for (const line of input.split('\n').filter(Boolean)) {
    const [, local, , remote] = line.split(' ');
    if (!local || local === ZERO) continue;
    const known = remote && remote !== ZERO && tryGit(root, ['cat-file', '-e', `${remote}^{commit}`]) !== undefined;
    shas.push(...(known ? revList(root, [`${remote}..${local}`]) : revList(root, [local, '--not', '--remotes'])));
  }
  return [...new Set(shas)];
}

interface HookInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: { file_path?: string; notebook_path?: string; content?: string; new_string?: string; new_source?: string; edits?: { new_string?: string }[] };
}

/** The text a Write, Edit, MultiEdit or NotebookEdit call would put in a file. */
function hookContent(input: HookInput): string {
  const t = input.tool_input ?? {};
  return [t.content, t.new_string, t.new_source, ...(t.edits ?? []).map((e) => e.new_string)].filter((s): s is string => typeof s === 'string').join('\n');
}

async function claudeHook(args: Args): Promise<number> {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput;
  const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) return 0;
  const abs = path.resolve(project, target);
  const rel = path.relative(project, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 0;
  const root = repoRoot(project) ?? project;
  const relRoot = path.relative(root, abs).split(path.sep).join('/');
  if (tryGit(root, ['check-ignore', '-q', '--', relRoot]) !== undefined) return 0;
  const combined = isCombined(root);
  if (combined && isPrivatePath(relRoot)) return 0;
  const { denylist, extras } = await loadSources(args, true);
  const scanner = new Scanner({ denylist, extras, allow: Allowlist.load(path.join(root, ALLOW_FILE)), pence: args.pence });
  const findings = scanner.scanText(relRoot, hookContent(input)).filter((f) => !f.warning);
  if (!findings.length) return 0;
  process.stderr.write(
    [
      `Leak guard: this ${input.tool_name ?? 'write'} would put personal data into ${relRoot} (lines are of the new text):`,
      ...findings.slice(0, 20).map((f) => `  ${describe(f)}`),
      ...(findings.length > 20 ? [`  …and ${findings.length - 20} more`] : []),
      'Use invented values instead (a test needs none of the real ones). If a match is a generic term, add it to .leakguard-allow.',
    ].join('\n') + '\n',
  );
  return 2;
}

/**
 * Postcodes and address-like lines in the readings under data/imports: candidates for the extras
 * file, never added by themselves. Ranked by how many documents print them: your address is on
 * every statement, a shop's on one.
 */
async function deep(args: Args): Promise<number> {
  const dataDir = resolveDataDir(args.data);
  if (!dataDir) throw new Error('--deep needs a data directory');
  // What the denylist has already (shops' addresses from your payments) needs no decision.
  const known = new Set((await loadDenylist(dataDir)).denylist.tokens.map(([k]) => k));
  const documents = new Map<string, Set<string>>();
  const POSTCODE = /\b(?:[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/g;
  const ADDRESS = /\b(?:flat \d+[a-z]?|\d+[a-z]?,? [a-z' -]{2,40} (?:road|street|lane|avenue|close|drive|way|court|place|crescent|terrace|grove|gardens|hill|row|walk|square|mews|park|view|rise|gate|green))\b/gi;
  const imports = path.join(dataDir, 'imports');
  const files = existsSync(imports) ? readdirSync(imports, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const walk = (v: unknown) => {
      if (typeof v === 'string') {
        for (const m of [...v.matchAll(POSTCODE), ...v.matchAll(ADDRESS)]) {
          const key = m[0].replace(/\s+/g, ' ');
          let seen = documents.get(key);
          if (!seen) documents.set(key, (seen = new Set()));
          seen.add(f);
        }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    try {
      walk(JSON.parse(readFileSync(path.join(imports, f), 'utf8')));
    } catch {
      // Unreadable: skipped.
    }
  }
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const out = path.join(configDir(), 'leak-extra.candidates.txt');
  const ranked = [...documents].filter(([v]) => !known.has(tokenKey(v))).sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
  const line = ([v, docs]: [string, Set<string>]) => `${v}    # in ${docs.size} document${docs.size === 1 ? '' : 's'}`;
  const many = ranked.filter(([, d]) => d.size >= 3);
  const few = ranked.filter(([, d]) => d.size < 3);
  writeFileSync(
    out,
    [
      `# Candidates from the readings under ${dataDir}/imports. Copy the ones that are yours (your`,
      '# addresses, past and present) into leak-extra.txt, without the "# in" part. Delete this file after.',
      '',
      '# In three or more documents: your addresses are likely here, beside banks\' own.',
      ...many.map(line),
      '',
      '# In one or two documents: mostly shops and payees.',
      ...few.map(line),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
  warn(`${ranked.length} candidates (${documents.size - ranked.length} more are in the denylist already), ${many.length} of them in three or more documents, written to ${out}`);
  return 0;
}

function report(args: Args, findings: Finding[], stats?: BuildStats): number {
  const failures = findings.filter((f) => !f.warning);
  const warnings = findings.filter((f) => f.warning);
  const byRule: Record<string, number> = {};
  for (const f of failures) byRule[`${f.category}/${f.rule}`] = (byRule[`${f.category}/${f.rule}`] ?? 0) + 1;
  if (args.json) {
    process.stdout.write(JSON.stringify({ findings: failures, warnings, summary: byRule, ...(stats ? { denylist: stats } : {}) }, null, 2) + '\n');
  } else {
    if (!args.summary) for (const f of failures) process.stdout.write(describe(f) + '\n');
    for (const w of warnings) warn(`warning: ${describe(w)}`);
    const files = new Set(failures.map((f) => f.path)).size;
    const parts = Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`);
    warn(failures.length ? `${failures.length} finding${failures.length === 1 ? '' : 's'} in ${files} place${files === 1 ? '' : 's'} (${parts.join(', ')})` : 'clean');
  }
  return failures.length ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === '--claude-hook') return claudeHook(args);
  if (args.mode === '--deep') return await deep(args);

  const root = repoRoot(path.resolve(args.repo ?? process.cwd()));
  const quiet = args.json;
  const { denylist, extras, stats } = await loadSources(args, quiet);
  if (args.mode === '--rebuild') {
    if (!quiet) warn(denylist ? 'denylist rebuilt' : 'nothing to build');
    return 0;
  }
  const allow = Allowlist.load(path.join(root ?? process.cwd(), ALLOW_FILE));
  const scanner = new Scanner({ denylist, extras, allow, pence: args.pence, history: args.mode === '--history', lineKeys: args.json && args.mode === '--history' });

  if (args.mode === '--stdin') {
    return report(args, scanner.scanText(args.path ?? '(stdin)', readFileSync(0, 'utf8')));
  }
  if (!root) throw new Error('not inside a git repository (use --repo)');
  const ctx: Context = { root, combined: isCombined(root), scanner, args };

  switch (args.mode) {
    case '--staged': {
      if (dataOnlyStaged(ctx)) return 0;
      const { files, blocks } = diffAdded(root, { cached: true });
      return report(args, await scanAdded(ctx, files, blocks));
    }
    case '--commit-msg': {
      if (!args.value) throw new Error('--commit-msg needs the message file');
      if (dataOnlyStaged(ctx)) return 0;
      return report(args, scanner.scanText('commit message', messageText(readFileSync(args.value, 'utf8'))));
    }
    case '--range': {
      if (!args.value) throw new Error('--range needs <a>..<b>');
      return report(args, await scanCommits(ctx, revList(root, [args.value])));
    }
    case '--pre-push':
      return report(args, await scanCommits(ctx, prePushCommits(root, readFileSync(0, 'utf8'))));
    case '--tree':
      return report(args, await scanTree(ctx, args.value ?? 'HEAD'), stats);
    case '--history':
      return report(args, await scanHistory(ctx), stats);
  }
  throw new Error(`unhandled mode ${args.mode}`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const hook = process.argv.includes('--claude-hook');
  // A hook that cannot run blocks the write rather than let it through unchecked.
  process.stderr.write(`leak-guard: ${(err as Error).message}${hook ? ' (the write was blocked because the leak guard could not run; fix it or ask the owner)' : ''}\n`);
  process.exitCode = 2;
}
