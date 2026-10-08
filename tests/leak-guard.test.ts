// The leak guard (scripts/leak-guard.ts): its denylist, matching, masking, patterns and modes. The
// persona here is invented, and inputs shaped like personal data (NI numbers, card numbers, IBANs)
// are put together at run time so this file holds none.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDenylist, distinctiveAmount, parseExtras, type Denylist } from '../scripts/leak-guard/denylist.ts';
import { ibanValid, luhn, scanPatterns } from '../scripts/leak-guard/patterns.ts';
import { Allowlist, Scanner } from '../scripts/leak-guard/scan.ts';
import { globToRegExp, mask, tokenKey, trieSource, bounded } from '../scripts/leak-guard/text.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUARD = path.join(ROOT, 'scripts/leak-guard.ts');
const INSTALL = path.join(ROOT, 'scripts/hooks-install.ts');
const stamp = '2026-01-01T00:00:00+00:00';

// ─── The persona ─────────────────────────────────────────────────────────────────────────────────

const OWNER = 'Orla Penhallow';
const FRIEND = 'Tamsin Kerridge';
const EMPLOYER = 'Quillfeather Analytics Ltd';
const PAYE = ['475', 'QF90210'].join('/');
const PAYROLL = 'QF88123';
const COMPANY_NO = '0' + '9876543';
const PAYEE = 'Moorgate Fishery';
const AMOUNT = 3141.59;
const LAST4 = '8' + '264';

/** Every value the persona would not want published. */
const SECRETS = [OWNER, 'Penhallow', FRIEND, 'T KERRIDGE', EMPLOYER, PAYE, PAYROLL, COMPANY_NO, PAYEE, '3141.59', LAST4, '1991-03-07'];

const tx = (id: string, date: string, amount: number, description: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, accountId: 'joint', date, amount, currency: 'GBP', description, source: {}, ...extra });

function writePersona(dir: string): void {
  const w = (file: string, data: unknown) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
  };
  w('meta.json', { format: 'finance', version: 7 });
  w('profile.json', { name: OWNER, dateOfBirth: '1991-03-07' });
  w('people.json', { people: [{ id: 'tamsin', name: FRIEND, names: ['T KERRIDGE'], createdAt: stamp, updatedAt: stamp }] });
  w('accounts.json', {
    accounts: [
      { id: 'joint', name: 'Monzo Current Account', type: 'current', last4: LAST4, aliases: ['Penhallow Household Pot'], createdAt: stamp, updatedAt: stamp },
      { id: 'saver', name: 'Chase Saver', type: 'savings', aliases: [], createdAt: stamp, updatedAt: stamp },
    ],
  });
  w('employments.json', { employments: [{ id: 'qf', employer: EMPLOYER, aliases: ['QUILLFEATHER'], payeReference: PAYE, payrollNumbers: [PAYROLL], createdAt: stamp, updatedAt: stamp }] });
  w('companies.json', { companies: [{ id: 'bw', name: 'Bramblecote Widgets Ltd', number: COMPANY_NO, valuations: [{ asOf: '2025-11-30', method: 'yours', value: 2718.28 }], createdAt: stamp, updatedAt: stamp }] });
  w('agreements.json', { agreements: [{ id: 'room', name: 'Gorsehill Hall room, 2025/26', counterparty: 'University of Exampleshire', category: 'rent', from: '2025-09-20', payments: [{ due: '2025-10-01', amount: 1618.03 }], createdAt: stamp, updatedAt: stamp }] });
  w(
    'transactions/joint/2026.jsonl',
    [
      tx('tx_0000000000000001', '2026-01-02', -AMOUNT, 'FPO MOORGATE FISHERY REF 7781', { payee: PAYEE }),
      tx('tx_0000000000000002', '2026-01-03', -12.34, 'TESCO STORES 3297', { payee: 'Tesco' }),
      tx('tx_0000000000000003', '2026-01-04', -1500, 'Cheque paid in', { payee: 'Cheque paid in' }),
      tx('tx_0000000000000004', '2026-01-05', -45.67, 'SMALL THING'),
    ].join('\n') + '\n',
  );
  w('holdings/joint.jsonl', JSON.stringify({ id: 'hld_0000000000000001', accountId: 'joint', date: '2026-01-31', holdings: [{ name: 'Example Global Index', units: 123.4567, value: 4321.0 }], totalValue: 4321.0, createdAt: stamp }) + '\n');
}

let tmp: string;
let dataDir: string;
let denylist: Denylist;

/** A process environment that sees none of the owner's settings, caches or git configuration. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.join(tmp, 'home');
  const { FINANCE_DATA_DIR: _data, CLAUDE_PROJECT_DIR: _project, ...rest } = process.env;
  return {
    ...rest,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function run(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('node', [GUARD, ...args], { cwd: opts.cwd ?? tmp, input: opts.input ?? '', env: env(opts.env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function expectMasked(text: string): void {
  for (const s of SECRETS) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
}

function newRepo(name: string): { repo: string; git: (...args: string[]) => string } {
  const repo = path.join(tmp, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: env(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  // The repository runs the guard from its own checkout: link this one's.
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  execFileSync('ln', ['-s', path.join(ROOT, 'scripts/leak-guard.ts'), path.join(repo, 'scripts/leak-guard.ts')]);
  execFileSync('ln', ['-s', path.join(ROOT, 'scripts/leak-guard'), path.join(repo, 'scripts/leak-guard')]);
  writeFileSync(path.join(repo, 'README.md'), '# Example\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'start');
  return { repo, git };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'leak-guard-'));
  mkdirSync(path.join(tmp, 'home'), { recursive: true });
  writeFileSync(path.join(tmp, 'home', '.gitconfig'), '');
  dataDir = path.join(tmp, 'persona');
  writePersona(dataDir);
  denylist = (await buildDenylist(dataDir)).denylist;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

describe('matching text', () => {
  it('matches whole tokens only, in any case and any whitespace, with ’ read as \'', () => {
    const re = new RegExp(bounded(trieSource([tokenKey('Orla Penhallow'), tokenKey("o'neill"), tokenKey('Penhallow')])!), 'gu');
    const find = (s: string) => [...tokenKey(s).matchAll(re)].map((m) => m[0]);
    expect(find('paid ORLA   PENHALLOW today')).toEqual(['orla penhallow']);
    expect(find('orla\npenhallow')).toEqual(['orla penhallow']);
    expect(find('O’Neill')).toEqual(["o'neill"]);
    expect(find('penhallows penhallowe xpenhallow')).toEqual([]);
    expect(find('(penhallow)')).toEqual(['penhallow']);
  });

  it('masks every word but its first character, and a number but its first digit', () => {
    expect(mask('Orla Penhallow')).toBe('O*** P********');
    expect(mask('£23,456.78')).toBe('£2*,***.**');
    expect(mask('AB 12 34 56 C')).toBe('A* ** ** ** *');
  });

  it('reads globs with ** across directories', () => {
    expect(globToRegExp('eval/**').test('eval/a/b.ts')).toBe(true);
    expect(globToRegExp('tests/*.ts').test('tests/a/b.ts')).toBe(false);
    expect(globToRegExp('**/x.md').test('x.md')).toBe(true);
  });
});

// ─── The denylist ────────────────────────────────────────────────────────────────────────────────

describe('the denylist', () => {
  const has = (value: string) => denylist.tokens.find(([k]) => k === tokenKey(value))?.[1];

  it('collects names, jobs, references and payees from the data', () => {
    expect(has(OWNER)).toBe('owner-name');
    expect(has('Penhallow')).toBe('owner-name');
    expect(has(FRIEND)).toBe('person');
    expect(has('T KERRIDGE')).toBe('person');
    expect(has(EMPLOYER)).toBe('employer');
    expect(has('Quillfeather')).toBe('employer');
    expect(has(PAYE)).toBe('paye-reference');
    expect(has(PAYE.replace('/', ' / '))).toBe('paye-reference');
    expect(has(PAYROLL)).toBe('payroll-number');
    expect(has(COMPANY_NO)).toBe('company-number');
    expect(has('University of Exampleshire')).toBe('agreement');
    expect(has(PAYEE)).toBe('payee');
    expect(has('Penhallow Household Pot')).toBe('account');
    for (const v of ['1991-03-07', '07/03/1991', '7 March 1991', '7 Mar 1991']) expect(has(v)).toBe('date-of-birth');
    expect(denylist.last4).toContain(LAST4);
    expect(denylist.units).toContain('123.4567');
  });

  it('leaves out generic and public names: products, chains and bank wording', () => {
    expect(has('Monzo Current Account')).toBeUndefined();
    expect(has('Chase Saver')).toBeUndefined();
    expect(has('Tesco')).toBeUndefined();
    expect(has('Cheque paid in')).toBeUndefined();
  });

  it('keeps distinctive amounts only', () => {
    expect(denylist.amounts).toEqual(expect.arrayContaining(['3141.59', '2718.28', '1618.03', '4321.00']));
    expect(distinctiveAmount(-45.67)).toBeUndefined();
    expect(distinctiveAmount(1500)).toBeUndefined();
    expect(distinctiveAmount(2026)).toBeUndefined();
    expect(distinctiveAmount(1234)).toBe('1234.00');
    expect(distinctiveAmount(150.5)).toBe('150.50');
  });
});

// ─── Scanning ────────────────────────────────────────────────────────────────────────────────────

describe('scanning', () => {
  const scanner = () => new Scanner({ denylist, allow: new Allowlist('') });
  const rules = (text: string, s = scanner(), file = 'src/x.ts') => s.scanText(file, text).map((f) => `${f.line}:${f.category}/${f.rule}`);

  it('finds amounts however they are written, but not inside other numbers', () => {
    expect(rules('a = 3141.59\nb = "£3,141.59"\nc = -3141.59\nd = 2718.28')).toEqual(['1:denylist/amount', '2:denylist/amount', '3:denylist/amount', '4:denylist/amount']);
    expect(rules('v1.3141.59 13141.59 3141.591 3141.5')).toEqual([]);
    expect(rules('x = 1618.03 y = 4321')).toEqual(['1:denylist/amount', '1:denylist/amount']);
  });

  it('counts a last-4 only where one is meant', () => {
    expect(rules(`card ending ${LAST4}`)).toEqual(['1:denylist/last4']);
    expect(rules(`**** ${LAST4}`)).toEqual(['1:denylist/last4']);
    expect(rules(`retry ${LAST4} times`)).toEqual([]);
  });

  it('reads holdings units', () => {
    expect(rules('units: 123.4567')).toEqual(['1:denylist/units']);
  });

  it('applies the allowlist, everywhere or by path', () => {
    const allow = new Allowlist(`# comment\n${PAYEE}\nLICENSE:${OWNER}\n`);
    const s = new Scanner({ denylist, allow });
    expect(rules(`${PAYEE}`, s)).toEqual([]);
    expect(rules(`© ${OWNER}`, s, 'LICENSE')).toEqual([]);
    expect(rules(`© ${OWNER}`, s, 'README.md')).toEqual(['1:denylist/owner-name']);
    expect(rules(`LICENSE:${OWNER}`, s, '.leakguard-allow')).toEqual([]);
  });

  it('reads extras: tokens, patterns, and head-only entries a history scan leaves out', () => {
    const extras = parseExtras('# mine\nhome.example.lan\nre:flat \\d+[a-z]? lark rise\nhead:oldbox\n');
    expect(rules('ssh home.example.lan', new Scanner({ extras }))).toEqual(['1:extra/token']);
    expect(rules('Flat 4b Lark Rise', new Scanner({ extras }))).toEqual(['1:extra/pattern']);
    expect(rules('on oldbox', new Scanner({ extras }))).toEqual(['1:extra/token']);
    expect(rules('on oldbox', new Scanner({ extras, history: true }))).toEqual([]);
  });
});

// ─── Patterns ────────────────────────────────────────────────────────────────────────────────────

/** A card number with its Luhn check digit, so none is written out here. */
function withLuhn(body: string): string {
  for (let d = 0; d <= 9; d++) if (luhn(body + d)) return body + d;
  throw new Error('unreachable');
}

/** A GB IBAN with valid check digits, made at run time. */
function iban(bban: string): string {
  for (let c = 2; c <= 98; c++) {
    const candidate = `GB${String(c).padStart(2, '0')}${bban}`;
    if (ibanValid(candidate)) return candidate;
  }
  throw new Error('unreachable');
}

describe('built-in patterns', () => {
  const found = (text: string) => scanPatterns(text).map((h) => h.rule);

  it('finds NI numbers with a valid prefix, but not HMRC’s examples', () => {
    expect(found(['JK', '12', '34', '56', 'D'].join(' '))).toEqual(['ni-number']);
    expect(found(['GB', '12', '34', '56', 'D'].join(''))).toEqual([]);
    expect(found(['QQ', '123456', 'C'].join(''))).toEqual([]);
  });

  it('finds card numbers that pass Luhn, but not test numbers or timestamps', () => {
    expect(found(withLuhn('453201511283036'))).toEqual(['card-number']);
    expect(found(withLuhn('453201511283036').replace(/(\d{4})(?=\d)/g, '$1 '))).toEqual(['card-number']);
    expect(found(['4242', '4242', '4242', '4242'].join(''))).toEqual([]);
    expect(found(withLuhn('175908360000'))).toEqual([]);
    expect(found('20260903120000')).toEqual([]);
  });

  it('finds IBANs that pass mod 97 and sort codes beside account numbers', () => {
    expect(found(iban('NWBK60161331926801'))).toEqual(['iban']);
    expect(found(`sort ${['20', '31', '55'].join('-')} account ${'4123' + '4567'}`)).toEqual(['sort-code-account']);
    expect(found(`${['12', '34', '56'].join('-')} ${'1234' + '5678'}`)).toEqual([]);
  });

  it('finds emails outside example domains, tailnet addresses and postcodes', () => {
    expect(found(['olly', 'mail.co.uk'].join('@'))).toEqual(['email']);
    expect(found('dev@example.com x@y.test')).toEqual([]);
    expect(found(['100', '88', '1', '2'].join('.'))).toEqual(['tailnet-address']);
    expect(found(['100', '100', '100', '100'].join('.'))).toEqual([]);
    expect(found(['fd7a', '115c', 'a1e0', '', '8a', '1'].join(':'))).toEqual(['tailnet-address']);
    expect(found(`${['fd7a', '115c', 'a1e0'].join(':')}::/48 and ${['fd7a', '115c', 'a1e0'].join(':')}:`)).toEqual([]);
    expect(found(['YO10', '5DD'].join(' '))).toEqual(['postcode']);
  });

  it('finds PAYE references, but not ones in the documentation offices', () => {
    expect(found(PAYE)).toEqual(['paye-reference']);
    expect(found(['123', 'AB456'].join('/'))).toEqual([]);
  });
});

// ─── The command ─────────────────────────────────────────────────────────────────────────────────

describe('the command', () => {
  it('reports masked findings and exits 1, or 0 when clean', () => {
    const dirty = run(['--stdin', '--path', 'tests/x.test.ts', '--data', dataDir], { input: `const who = '${OWNER}'; // paid ${PAYEE} £3,141.59\n` });
    expect(dirty.code).toBe(1);
    expect(dirty.out).toMatch(/tests\/x\.test\.ts:1 \[denylist\/owner-name\] O\*\*\* P\*{8}/);
    expectMasked(dirty.all);
    const clean = run(['--stdin', '--path', 'x.ts', '--data', dataDir], { input: 'const who = "Alex Example";\n' });
    expect(clean.code).toBe(0);
  });

  it('caches the denylist outside any repository, readable only by you', () => {
    run(['--rebuild', '--data', dataDir]);
    const cache = path.join(tmp, 'home', '.cache', 'finance', 'leak-denylist.json');
    expect(statSync(cache).mode & 0o777).toBe(0o600);
    const repo = newRepo('cache-repo').repo;
    const inside = run(['--rebuild', '--data', dataDir], { env: { XDG_CACHE_HOME: path.join(repo, '.cache') } });
    expect(inside.code).toBe(2);
    expect(inside.err).toMatch(/refusing to write the denylist inside a git repository/);
    // In a git hook, GIT_DIR is set: the cache outside the repository is still outside it.
    expect(run(['--rebuild', '--data', dataDir], { env: { GIT_DIR: path.join(repo, '.git') } }).code).toBe(0);
  });

  it('runs on patterns alone without data, as CI does', () => {
    const r = run(['--stdin', '--patterns-only'], { input: `${OWNER} ${['olly', 'mail.co.uk'].join('@')}\n` });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/pattern\/email/);
    expect(r.out).not.toMatch(/owner-name/);
  });

  it('blocks a Claude Code write that holds personal data, and only inside the project', () => {
    const { repo } = newRepo('hook-repo');
    writeFileSync(path.join(repo, '.gitignore'), 'local/\n');
    const hook = (file: string, content: string, tool = 'Write') =>
      run(['--claude-hook', '--data', dataDir], { cwd: repo, env: { CLAUDE_PROJECT_DIR: repo }, input: JSON.stringify({ tool_name: tool, tool_input: { file_path: path.join(repo, file), ...(tool === 'Write' ? { content } : { old_string: 'x', new_string: content }) } }) });
    const blocked = hook('src/a.ts', `export const name = '${FRIEND}';\n`);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/src\/a\.ts:1 \[denylist\/person\] T\*{5} K\*{7}/);
    expectMasked(blocked.all);
    expect(hook('src/a.ts', `x = '${FRIEND}'`, 'Edit').code).toBe(2);
    expect(hook('src/a.ts', 'export const name = "Alex Example";\n').code).toBe(0);
    expect(hook('local/notes.md', FRIEND).code).toBe(0);
    expect(run(['--claude-hook', '--data', dataDir], { cwd: repo, env: { CLAUDE_PROJECT_DIR: repo }, input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'outside.md'), content: FRIEND } }) }).code).toBe(0);
  });
});

// ─── Git ─────────────────────────────────────────────────────────────────────────────────────────

describe('git modes and hooks', () => {
  /** Hooks installed in a fresh repository whose guard reads the persona. */
  function hookedRepo(name: string) {
    const r = newRepo(name);
    mkdirSync(path.join(tmp, 'home', '.config', 'finance'), { recursive: true });
    writeFileSync(path.join(tmp, 'home', '.config', 'finance', 'leak-guard.json'), JSON.stringify({ dataDir }));
    execFileSync('node', [INSTALL, '--quiet'], { cwd: r.repo, env: env() });
    return r;
  }
  const tryCommit = (git: (...a: string[]) => string, ...args: string[]) => {
    try {
      git('commit', '-q', ...args);
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  };

  it('refuses a commit that adds personal data, and one whose message has it', () => {
    const { repo, git } = hookedRepo('commit-repo');
    writeFileSync(path.join(repo, 'a.ts'), `export const payee = '${PAYEE}';\n`);
    git('add', 'a.ts');
    expect(tryCommit(git, '-m', 'feat: add a')).not.toBe(0);
    writeFileSync(path.join(repo, 'a.ts'), "export const payee = 'Example Cafe';\n");
    git('add', 'a.ts');
    expect(tryCommit(git, '-m', `feat: pay ${FRIEND}`)).not.toBe(0);
    expect(tryCommit(git, '-m', 'feat: add a')).toBe(0);
    expect(git('log', '--format=%s', '-1').trim()).toBe('feat: add a');
  });

  it('keeps a hook that was already there, and runs it after the guard', () => {
    const { repo, git } = newRepo('chain-repo');
    const hooks = path.join(repo, '.git', 'hooks');
    writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho chained >> "${path.join(repo, '.git', 'chained.log')}"\n`);
    chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    execFileSync('node', [INSTALL, '--quiet'], { cwd: repo, env: env() });
    expect(readFileSync(path.join(hooks, 'pre-commit'), 'utf8')).toMatch(/# leak-guard hooks v\d+/);
    writeFileSync(path.join(repo, 'b.ts'), 'export {};\n');
    git('add', 'b.ts');
    expect(tryCommit(git, '-m', 'chore: b')).toBe(0);
    expect(readFileSync(path.join(repo, '.git', 'chained.log'), 'utf8')).toBe('chained\n');
  });

  it('lets the app commit its own data where code and data share a repository, but scans code there', () => {
    const { repo, git } = hookedRepo('combined-repo');
    mkdirSync(path.join(repo, 'data'));
    writeFileSync(path.join(repo, 'data', 'meta.json'), '{}\n');
    writeFileSync(path.join(repo, 'data', 'people.json'), JSON.stringify({ people: [{ name: FRIEND }] }));
    git('add', 'data');
    expect(tryCommit(git, '-m', `data: add ${FRIEND}`)).toBe(0);
    writeFileSync(path.join(repo, 'c.ts'), `// ${FRIEND}\n`);
    git('add', 'c.ts');
    expect(tryCommit(git, '-m', 'chore: c')).not.toBe(0);
    // As the app commits (src/server/git.ts): only data/, by pathspec, whatever else is staged.
    writeFileSync(path.join(repo, 'data', 'people.json'), JSON.stringify({ people: [{ name: FRIEND, names: ['T KERRIDGE'] }] }));
    git('add', '-A', '--', 'data');
    expect(tryCommit(git, '-m', `person: ${FRIEND}`, '-m', 'Committed by the finance app.', '--', 'data')).toBe(0);
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/people.json');
    // An empty commit is not a data commit: its message is still checked.
    git('reset', '-q');
    expect(tryCommit(git, '--allow-empty', '-m', `chore: thanks ${FRIEND}`)).not.toBe(0);
  });

  it('scans a range and a tree, and reports what a commit adds', () => {
    const { repo, git } = newRepo('range-repo');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(repo, 'd.ts'), `export const x = 1;\nexport const y = '${PAYROLL}';\n`);
    git('add', 'd.ts');
    git('commit', '-q', '-m', `chore: d for ${FRIEND}`);
    mkdirSync(path.join(repo, 'data'));
    writeFileSync(path.join(repo, 'data', 'x.json'), '{}\n');
    writeFileSync(path.join(repo, 'statement.pdf'), '%PDF-1.4\n');
    git('add', 'data', 'statement.pdf');
    git('commit', '-q', '-m', 'chore: more');
    const range = run(['--range', `${base}..HEAD`, '--data', dataDir], { cwd: repo });
    expect(range.code).toBe(1);
    expect(range.out).toMatch(/d\.ts @\w+:2 \[denylist\/payroll-number\]/);
    expect(range.out).toMatch(/commit \w+ \(message\):1 \[denylist\/person\]/);
    expect(range.out).toMatch(/data\/x\.json @\w+ \[file\/private-path\]/);
    expect(range.out).toMatch(/statement\.pdf @\w+ \[file\/document-file\]/);
    expectMasked(range.all);
    const tree = run(['--tree', 'HEAD', '--data', dataDir, '--exclude', 'data/**'], { cwd: repo });
    expect(tree.out).toMatch(/d\.ts:2 \[denylist\/payroll-number\]/);
    expect(tree.out).not.toMatch(/data\/x\.json/);
    const history = run(['--history', '--data', dataDir, '--json'], { cwd: repo });
    const json = JSON.parse(history.out) as { findings: { rule: string; lineKey?: string }[] };
    expect(json.findings.some((f) => f.rule === 'payroll-number' && f.lineKey?.length === 64)).toBe(true);
    expectMasked(history.all);
  });

  it('checks what a push would publish', () => {
    const { repo, git } = newRepo('push-repo');
    writeFileSync(path.join(repo, 'e.ts'), `export const z = '${PAYEE}';\n`);
    git('add', 'e.ts');
    git('commit', '-q', '-m', 'chore: e');
    const head = git('rev-parse', 'HEAD').trim();
    const r = run(['--pre-push', 'origin', '--data', dataDir], { cwd: repo, input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n` });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/e\.ts @\w+:1 \[denylist\/payee\]/);
    expect(existsSync(path.join(repo, '.git'))).toBe(true);
  });
});
