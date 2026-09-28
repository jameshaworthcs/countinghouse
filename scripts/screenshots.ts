// Screenshot smoke test: loads every page in headless Chrome, saves PNGs to screens/, and fails if
// any page logs an error. Run against a server that is already up:
//
//   FINANCE_DATA_DIR=demo-data npm run serve &     (or npm run demo)
//   npm run screens -- --base http://127.0.0.1:4750

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT } from '../src/server/config';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const base = arg('base', 'http://127.0.0.1:4750');
const out = path.join(PROJECT_ROOT, 'screens');
const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const only = arg('only', '');

async function main() {
  await mkdir(out, { recursive: true });
  const imports = (await (await fetch(`${base}/api/imports`, { headers: { host: '127.0.0.1' } })).json()) as { pending: { id: string }[] };
  const pendingId = imports.pending[0]?.id;
  const pages: [string, string][] = [
    ['overview', '/'],
    ['accounts', '/accounts'],
    ['account-current', '/accounts/current-account'],
    ['account-isa', '/accounts/stocks-isa'],
    ['transactions', '/transactions'],
    ['spending', '/spending'],
    ['projections', '/projections'],
    ['investments', '/investments'],
    ['tax', '/tax'],
    ['self-assessment', '/tax/self-assessment'],
    ['import', '/import'],
    ...(pendingId ? ([['review', `/import/${pendingId}`]] as [string, string][]) : []),
    ['settings', '/settings'],
    ['settings-rules', '/settings#rules'],
    ['settings-health', '/settings#health'],
  ];
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const problems: string[] = [];
  const shoot = async (name: string, route: string, opts: { width: number; height: number; theme: 'light' | 'dark'; mobile?: boolean }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1, isMobile: Boolean(opts.mobile), hasTouch: Boolean(opts.mobile) });
    await page.evaluateOnNewDocument((theme: string) => {
      localStorage.setItem('finance.theme', theme);
    }, opts.theme);
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`${name} [${opts.theme}${opts.mobile ? ' mobile' : ''}]: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`${name}: ${(err as Error).message}`));
    // The live-update event stream keeps one connection open, so wait for content, not network idle.
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    await page.waitForSelector('h1', { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 900));
    const file = path.join(out, `${name}${opts.theme === 'dark' ? '-dark' : ''}${opts.mobile ? '-mobile' : ''}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await page.close();
    return file;
  };
  for (const [name, route] of pages) {
    if (only && !name.includes(only)) continue;
    await shoot(name, route, { width: 1440, height: 900, theme: 'light' });
    console.log(`✓ ${name}`);
  }
  if (!only) {
    for (const [name, route] of [['overview', '/'], ['spending', '/spending'], ['review', pendingId ? `/import/${pendingId}` : '/import']] as [string, string][]) {
      await shoot(name, route, { width: 1440, height: 900, theme: 'dark' });
    }
    for (const [name, route] of [['overview', '/'], ['import', '/import'], ['transactions', '/transactions']] as [string, string][]) {
      await shoot(name, route, { width: 390, height: 844, theme: 'light', mobile: true });
    }
  }
  await browser.close();
  if (problems.length) {
    console.error(`\n${problems.length} console problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`\nScreenshots in ${out}`);
}

await main();
