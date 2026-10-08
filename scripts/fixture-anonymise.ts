// Turn a document a real import failed on into a synthetic test fixture, so the regression test
// needs none of the real rows (CONTRIBUTING.md, "Real imports, synthetic fixtures").
//
//   npm run fixture:anonymise -- <file> [--out <path>] [--seed <n>] [--shift-days <n>] [--scale <x>]
//
// - Dates move by a whole number of weeks (--shift-days), amounts are scaled by one factor
//   (--scale), and identifiers, emails and postcodes are replaced.
// - Names, places and merchants that are not public chains become invented words, the same word
//   each time; column headers, common words and public names stay.
// - The output (default: tests/fixtures/<name>-anon.<ext>) is then scanned by the leak guard.
//   Anything it still finds is listed, masked, and the command fails: fix those by hand.
// - Without --seed, a random one is used and printed, so the same fixture can be made again.
// CSV, OFX, QIF and other text exports; European amounts ("1.234,56") are left as they are.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/server/config';
import { commonWords, GENERIC_WORDS, givenNames, loadDenylist, loadExtras, publicVocabulary, resolveDataDir } from './leak-guard/denylist.ts';
import { ALLOW_FILE, Allowlist, describe, Scanner } from './leak-guard/scan.ts';
import { anonymise, headerWords, prng } from './fixture-anonymise/anonymise.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!file) {
  console.error('Give the file: npm run fixture:anonymise -- <file> [--out <path>] [--seed <n>]');
  process.exit(2);
}

const seed = opt('seed') ? Number(opt('seed')) : Math.floor(Math.random() * 2 ** 31);
const rand = prng(seed);
const shiftDays = opt('shift-days') ? Number(opt('shift-days')) : 7 * (8 + Math.floor(rand() * 40));
const scale = opt('scale') ? Number(opt('scale')) : Math.round((0.6 + rand() * 0.8) * 10_000) / 10_000;
const ext = path.extname(file);
const out = path.resolve(opt('out') ?? path.join(PROJECT_ROOT, 'tests', 'fixtures', `${path.basename(file, ext).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-anon${ext}`));

// Bank exports are UTF-8 or Windows-1252: read and write each the way it came.
const bytes = readFileSync(file);
let text: string;
let latin1 = false;
try {
  text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
} catch {
  text = new TextDecoder('windows-1252').decode(bytes);
  latin1 = true;
}

const { words, names } = await publicVocabulary();
const dataDir = resolveDataDir();
const denylist = dataDir ? (await loadDenylist(dataDir)).denylist : undefined;
const generic = new Set([...GENERIC_WORDS, ...words, ...[...names].flatMap((n) => n.split(/[^\p{L}\p{N}]+/u))]);
const dictionary = commonWords();
// The denylist's own words, less the plain ones its descriptions also hold ("card", "payment").
const deny = new Set(
  (denylist?.tokens ?? [])
    .flatMap(([k]) => k.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !generic.has(w) && !dictionary?.has(w)),
);

const result = anonymise(text, { seed, shiftDays, scale, keep: headerWords(text), deny, generic, dictionary, given: givenNames() });
writeFileSync(out, latin1 ? Buffer.from(result.text, 'latin1') : result.text);

const c = result.counts;
console.log(`Wrote ${path.relative(process.cwd(), out)} (seed ${seed}: dates moved ${shiftDays} days, amounts × ${scale}).`);
console.log(`Replaced ${c.dates} dates, ${c.amounts} amounts, ${c.numbers} identifiers, ${c.words} words, ${c.emails} emails and ${c.postcodes} postcodes.`);
console.log('Sums and running balances still agree to within a penny or two: check the totals your test relies on.');

const scanner = new Scanner({ denylist, extras: loadExtras(), allow: Allowlist.load(path.join(PROJECT_ROOT, ALLOW_FILE)) });
const findings = scanner.scanText(path.relative(PROJECT_ROOT, out), result.text).filter((f) => !f.warning);
if (findings.length) {
  console.error(`\nThe leak guard still finds ${findings.length} thing(s) in it: change them by hand before you use it.`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  process.exit(1);
}
console.log(dataDir ? 'The leak guard finds nothing personal in it.' : 'The leak guard ran on patterns alone (no data directory configured).');
