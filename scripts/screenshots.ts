// Screenshot smoke test: loads every page in headless Chrome, saves PNGs to screens/, and fails if
// any page logs an error. Run against a server that is already up:
//
//   npm run demo &                                   (demo data, built UI, port 4770)
//   npm run screens -- --base http://127.0.0.1:4770
//
// A server with a login also needs SCREENS_USER and SCREENS_PASSWORD. The script then signs in
// through the login page first, and fails unless that lands in the app on the first try.
//
// `--only <text>` shoots only the pages whose name has it (light, desktop), for a change that
// touches a few pages; add `--dark` or `--mobile` (or both) to shoot those that way instead.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { PROJECT_ROOT } from '../src/server/config';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const base = arg('base', 'http://127.0.0.1:4770');
const out = path.resolve(PROJECT_ROOT, arg('out', 'screens'));
const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const only = arg('only', '');
const dark = argv.includes('--dark');
const mobile = argv.includes('--mobile');
const login = process.env.SCREENS_USER && process.env.SCREENS_PASSWORD ? { user: process.env.SCREENS_USER, password: process.env.SCREENS_PASSWORD } : null;

/** Sign in through the login page as a person would; returns the session cookie. */
async function signIn(browser: Browser, creds: { user: string; password: string }): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  // Start at / so the app first learns it is signed out, as on a real visit.
  await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30_000 });
  await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 15_000 });
  await page.screenshot({ path: path.join(out, 'login.png') });
  await page.type('input[autocomplete="username"]', creds.user);
  await page.type('input[autocomplete="current-password"]', creds.password);
  await page.click('button[type="submit"]');
  // Runs in the page (a string because scripts are type-checked without the DOM library).
  const settled = `(() => {
    if (document.querySelector('aside')) return 'in';
    const password = document.querySelector('input[autocomplete="current-password"]');
    if (password && password.value === '') return 'the login form came back empty';
    return document.querySelector('[role="alert"]')?.textContent || false;
  })()`;
  const outcome = await page
    .waitForFunction(settled, { timeout: 15_000, polling: 50 })
    .then((h) => h.jsonValue())
    .catch(() => 'timed out waiting for the app');
  await page.close();
  if (outcome !== 'in') throw new Error(`Signing in failed: ${String(outcome)}`);
  return (await browser.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function main() {
  await mkdir(out, { recursive: true });
  const status = (await (await fetch(`${base}/api/auth/status`, { headers: { host: '127.0.0.1' } })).json()) as { configured: boolean };
  if (status.configured && !login) throw new Error('This server has a login: set SCREENS_USER and SCREENS_PASSWORD.');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  // Pages share the default browser context, so they all use this session.
  const cookie = status.configured && login ? await signIn(browser, login) : '';
  if (cookie) console.log('✓ login');
  const imports = (await (await fetch(`${base}/api/imports`, { headers: { host: '127.0.0.1', cookie } })).json()) as { pending: { id: string; nothingNew?: unknown; draft?: { sections: unknown[]; hmrc?: unknown[]; payslips?: unknown[]; agreements?: unknown[] } }[] };
  // An import to review, and the two kinds that add nothing new, when the data has them.
  const pendingId = (imports.pending.find((p) => !p.nothingNew && !p.draft?.hmrc?.length && !p.draft?.payslips?.length && !p.draft?.agreements?.length) ?? imports.pending.find((p) => !p.nothingNew) ?? imports.pending[0])?.id;
  const repeatsId = imports.pending.find((p) => p.nothingNew && p.draft?.sections.length)?.id;
  const nothingId = imports.pending.find((p) => p.nothingNew && !p.draft?.sections.length)?.id;
  // One of HMRC's pages, with its records and the jobs they are about.
  const hmrcPageId = imports.pending.find((p) => p.draft?.hmrc?.length && p.id !== pendingId)?.id;
  // A payslip read in full.
  const payslipId = imports.pending.find((p) => p.draft?.payslips?.length && p.id !== pendingId)?.id;
  // A document with a schedule of payments (a student finance page).
  const scheduleId = imports.pending.find((p) => p.draft?.agreements?.length && p.id !== pendingId)?.id;
  // Account pages from whatever data is being shot: the first current account and the first ISA.
  const boot = (await (await fetch(`${base}/api/bootstrap`, { headers: { host: '127.0.0.1', cookie } })).json()) as { accounts: { id: string; type: string }[] };
  const txs = (await (await fetch(`${base}/api/transactions?limit=1`, { headers: { host: '127.0.0.1', cookie } })).json()) as { total: number };
  // A proposed fix waiting, when the data has one.
  const proposals = (await (await fetch(`${base}/api/proposals`, { headers: { host: '127.0.0.1', cookie } })).json()) as { pending: { proposal: { id: string } }[] };
  const proposalId = proposals.pending[0]?.proposal.id;
  // A Claude session with its transcript, when the data has one; else the first listed.
  const sessions = (await (await fetch(`${base}/api/sessions`, { headers: { host: '127.0.0.1', cookie } })).json()) as { sessions: { id: string; source: string }[] };
  const sessionId = (sessions.sessions.find((x) => x.source === 'recorded') ?? sessions.sessions[0])?.id;
  // A conversation in Ask, when the work area has one.
  const asked = (await (await fetch(`${base}/api/ask`, { headers: { host: '127.0.0.1', cookie } })).json()) as { conversations: { id: string }[] };
  const conversationId = asked.conversations[0]?.id;
  const accountPage = (name: string, type: string): [string, string][] => {
    const id = boot.accounts.find((a) => a.type === type)?.id;
    return id ? [[name, `/accounts/${id}`]] : [];
  };
  const pages: [string, string][] = [
    ['overview', '/'],
    ['reviews', '/reviews'],
    ['accounts', '/accounts'],
    ...accountPage('account-current', 'current'),
    ...accountPage('account-savings', 'savings'),
    ...accountPage('account-isa', 'stocks_isa'),
    ...accountPage('account-asset', 'other_asset'),
    ...accountPage('account-pension', 'workplace_pension'),
    ['transactions', '/transactions'],
    ['spending', '/spending'],
    ['spending-categorise', '/spending/categorise'],
    ['spending-categorise-rules', '/spending/categorise#rules'],
    ['spending-categorise-payees', '/spending/categorise#payees'],
    ['spending-categorise-guesses', '/spending/categorise#guesses'],
    ['projections', '/projections'],
    ['investments', '/investments'],
    ['tax', '/tax'],
    ['tax-pay', '/tax/pay'],
    ['self-assessment', '/tax/self-assessment'],
    ['assumptions', '/assumptions'],
    ['assumptions-research', '/assumptions#research'],
    ['assumptions-about', '/assumptions#about'],
    ['assumptions-jobs', '/assumptions#jobs'],
    ['import', '/import'],
    ...(pendingId ? ([['review', `/import/${pendingId}`]] as [string, string][]) : []),
    ...(repeatsId ? ([['review-already-here', `/import/${repeatsId}`]] as [string, string][]) : []),
    ...(nothingId ? ([['review-nothing-to-record', `/import/${nothingId}`]] as [string, string][]) : []),
    ...(hmrcPageId ? ([['review-hmrc', `/import/${hmrcPageId}`]] as [string, string][]) : []),
    ...(payslipId ? ([['review-payslip', `/import/${payslipId}`]] as [string, string][]) : []),
    ...(scheduleId ? ([['review-schedule', `/import/${scheduleId}`]] as [string, string][]) : []),
    ...(proposalId ? ([['proposal', `/proposals/${proposalId}`]] as [string, string][]) : []),
    ['settings', '/settings'],
    ['settings-extraction', '/settings#extraction'],
    ['settings-categories', '/settings#categories'],
    ['settings-rules', '/settings#rules'],
    ['settings-tax-documents', '/settings#tax-documents'],
    ['settings-access', '/settings#access'],
    ['settings-audit', '/settings#audit'],
    ['settings-health', '/settings#health'],
    ['ask', '/ask'],
    ...(conversationId ? ([['ask-conversation', `/ask/${conversationId}`]] as [string, string][]) : []),
    ['sessions', '/sessions'],
    ...(sessionId ? ([['session', `/sessions/${sessionId}`]] as [string, string][]) : []),
  ];
  const problems: string[] = [];
  type Page = Awaited<ReturnType<typeof browser.newPage>>;
  const shoot = async (name: string, route: string, opts: { width: number; height: number; theme: 'light' | 'dark'; mobile?: boolean; act?: (page: Page) => Promise<void> }) => {
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
    if (opts.act) {
      await opts.act(page);
      await new Promise((r) => setTimeout(r, 400));
    }
    const file = path.join(out, `${name}${opts.theme === 'dark' ? '-dark' : ''}${opts.mobile ? '-mobile' : ''}.png`);
    // A drawer is fixed to the viewport, so it is shot as the viewport shows it.
    await page.screenshot({ path: file, fullPage: !opts.act });
    await page.close();
    return file;
  };
  for (const [name, route] of pages) {
    if (only && !name.includes(only)) continue;
    await shoot(name, route, { ...(mobile ? { width: 390, height: 844, mobile: true } : { width: 1440, height: 900 }), theme: dark ? 'dark' : 'light' });
    console.log(`✓ ${name}`);
  }
  // The transaction drawer, with the form for correcting a misread value open.
  const openDrawer = async (page: Page) => {
    const row = await page.$('main button.min-w-0.text-left');
    if (!row) throw new Error('transaction-drawer: no transaction row to open');
    await row.click();
    await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
    await page.click('[role="dialog"] summary::-p-text(Correct a misread)');
  };
  // Only with a transaction to open: a fresh data directory has none.
  if (txs.total > 0 && (!only || 'transaction-drawer'.includes(only))) {
    await shoot('transaction-drawer', '/transactions', { width: 1440, height: 1500, theme: 'light', act: openDrawer });
    console.log('✓ transaction-drawer');
  }
  // The audit log with its latest entry open: who, from where, what it sent and changed.
  const openEntry = async (page: Page) => {
    const row = await page.$('main li > button[aria-expanded]');
    if (!row) throw new Error('settings-audit-entry: no audit entry to open');
    await row.click();
  };
  if (!only || 'settings-audit-entry'.includes(only)) {
    await shoot('settings-audit-entry', '/settings#audit', { ...(mobile ? { width: 390, height: 1400, mobile: true } : { width: 1440, height: 1400 }), theme: dark ? 'dark' : 'light', act: openEntry });
    console.log('✓ settings-audit-entry');
  }
  // What re-applying categorisation would change, before anything is written, with the first
  // group's payments open to choose for.
  const openReapply = async (page: Page) => {
    await page.click('main button::-p-text(Preview re-applying to history)');
    await page.waitForSelector('main ::-p-text(would change)', { timeout: 15_000 });
    const show = await page.waitForSelector('main button::-p-text(Show the)', { timeout: 5_000 }).catch(() => null);
    if (show) {
      await show.click();
      await page.waitForSelector('main ::-p-text(Hide the payments)', { timeout: 5_000 });
      // A category of yours for all of the first payee's payments, and "always".
      const all = await page.$('main select[aria-label^="All "]');
      if (all) {
        await page.select('main select[aria-label^="All "]', 'public-transport');
        await page.click('main ::-p-text(Always: a rule)');
        await page.waitForSelector('main ::-p-text(in all)', { timeout: 5_000 });
      }
    }
  };
  if (!only || 'settings-rules-reapply'.includes(only)) {
    await shoot('settings-rules-reapply', '/settings#rules', { ...(mobile ? { width: 390, height: 1600, mobile: true } : { width: 1440, height: 1400 }), theme: dark ? 'dark' : 'light', act: openReapply });
    console.log('✓ settings-rules-reapply');
  }
  if (!only) {
    if (txs.total > 0) await shoot('transaction-drawer', '/transactions', { width: 390, height: 844, theme: 'dark', mobile: true, act: openDrawer });
    for (const [name, route] of [['overview', '/'], ['spending', '/spending'], ['projections', '/projections'], ['assumptions', '/assumptions'], ['review', pendingId ? `/import/${pendingId}` : '/import'], ...(nothingId ? [['review-nothing-to-record', `/import/${nothingId}`]] : []), ...(proposalId ? [['proposal', `/proposals/${proposalId}`]] : [])] as [string, string][]) {
      await shoot(name, route, { width: 1440, height: 900, theme: 'dark' });
    }
    for (const [name, route] of [['overview', '/'], ['import', '/import'], ['transactions', '/transactions'], ['projections', '/projections'], ...(repeatsId ? [['review-already-here', `/import/${repeatsId}`]] : []), ...(proposalId ? [['proposal', `/proposals/${proposalId}`]] : [])] as [string, string][]) {
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
