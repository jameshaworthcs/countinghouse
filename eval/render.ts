// HTML for the synthetic documents, printed to PDF or captured as a phone screenshot by headless
// Chrome. The looks are generic (no real bank's branding): what matters is the layouts UK banks,
// card issuers, platforms and pension providers use.

import type { Browser } from 'puppeteer-core';

export interface Brand {
  name: string;
  color: string;
  address?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const gbp = (v: number, opts: { sign?: 'minus' | 'unicode' | 'none'; symbol?: boolean } = {}) => {
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = `${opts.symbol === false ? '' : '£'}${abs}`;
  if (v >= 0 || opts.sign === 'none') return body;
  return `${opts.sign === 'unicode' ? '−' : '-'}${body}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "12 Sep", "12 Sep 26", "12/09/2026", "12 September 2026" */
export function fmtDate(iso: string, style: 'd-mon' | 'd-mon-yy' | 'dd/mm/yyyy' | 'd-month-yyyy' | 'dd-mon-yyyy'): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (style === 'd-mon') return `${d} ${MONTHS[m - 1]}`;
  if (style === 'd-mon-yy') return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
  if (style === 'dd/mm/yyyy') return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  if (style === 'dd-mon-yyyy') return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  return `${d} ${LONG_MONTHS[m - 1]} ${y}`;
}
export const dayName = (iso: string) => DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;

const page = (css: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
body { margin: 0; font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; color: #1b1b1f; }
${css}
</style></head><body>${body}</body></html>`;

// ─── Statements (A4 PDF) ─────────────────────────────────────────────────────────────────────────

export interface StatementRow {
  date: string;
  description: string;
  /** Second line under the description (a reference, an FX note). */
  detail?: string;
  type?: string;
  amount: number;
  balanceAfter?: number;
}

export interface StatementSection {
  title: string;
  accountLine: string;
  period: [string, string];
  opening?: number;
  closing: number;
  rows: StatementRow[];
  /** out-in: separate paid out / paid in columns; signed: one amount column; card-cr: amounts unsigned, credits marked CR; card-plus: spend positive, credits negative */
  columns: 'out-in' | 'signed' | 'card-cr' | 'card-plus';
  dateStyle: 'd-mon' | 'd-mon-yy' | 'dd/mm/yyyy';
  /** Show the date only on a day's first row (HSBC style). */
  dateOncePerDay?: boolean;
  /** Running balance on every row, only on each day's last row, or not at all. */
  balances: 'every' | 'end-of-day' | 'none';
  /** Page rows and add "balance brought/carried forward" lines at page breaks. */
  broughtForward?: boolean;
  summary?: [string, string][];
  rowsPerPage?: number;
  showTypeColumn?: boolean;
  /** For card statements, the balance owed is printed positive. */
  closingLabel?: string;
}

export function statementHtml(brand: Brand, heading: string, customer: string, sections: StatementSection[], footer = ''): string {
  const css = `
@page { size: A4; margin: 14mm 12mm 16mm; }
.head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${brand.color}; padding-bottom: 8px; margin-bottom: 12px; }
.logo { font-size: 22px; font-weight: 700; color: ${brand.color}; letter-spacing: -0.5px; }
.addr { font-size: 9px; color: #555; text-align: right; line-height: 1.4; }
h1 { font-size: 15px; margin: 0 0 2px; }
.cust { font-size: 10.5px; margin-bottom: 10px; line-height: 1.5; }
.box { border: 1px solid #ccc; padding: 7px 10px; margin: 8px 0 10px; font-size: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 18px; }
.box div { display: flex; justify-content: space-between; }
table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
th { background: ${brand.color}; color: #fff; text-align: left; padding: 4px 5px; font-weight: 600; }
th.n, td.n { text-align: right; white-space: nowrap; }
td { padding: 3.5px 5px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
td .sub { color: #666; font-size: 8.5px; }
tr.bf td { font-weight: 600; background: #f4f4f4; }
.sect { margin-top: 14px; }
.sect h2 { font-size: 12.5px; margin: 0 0 2px; color: ${brand.color}; }
.acct { font-size: 9.5px; color: #444; margin-bottom: 4px; }
.pb { page-break-after: always; }
.foot { font-size: 8px; color: #777; margin-top: 12px; line-height: 1.4; }
.pageno { font-size: 8px; color: #999; text-align: right; margin-top: 6px; }`;
  const header = `<div class="head"><div class="logo">${esc(brand.name)}</div><div class="addr">${esc(brand.address ?? '')}</div></div>`;
  let body = header + `<h1>${esc(heading)}</h1><div class="cust">${customer}</div>`;
  let pageNo = 1;
  sections.forEach((s, si) => {
    const colsHead =
      s.columns === 'out-in'
        ? `<th>Date</th>${s.showTypeColumn ? '<th>Type</th>' : ''}<th>Description</th><th class="n">Paid out</th><th class="n">Paid in</th>${s.balances !== 'none' ? '<th class="n">Balance</th>' : ''}`
        : `<th>Date</th>${s.showTypeColumn ? '<th>Type</th>' : ''}<th>Description</th><th class="n">Amount</th>${s.balances !== 'none' ? '<th class="n">Balance</th>' : ''}`;
    const summary = (s.summary ?? []).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    body += `<div class="sect"><h2>${esc(s.title)}</h2><div class="acct">${s.accountLine}</div>`;
    body += `<div class="box"><div><span>Statement period</span><b>${fmtDate(s.period[0], 'd-month-yyyy')} to ${fmtDate(s.period[1], 'd-month-yyyy')}</b></div>${summary}</div>`;
    const per = s.rowsPerPage ?? 34;
    const pages: StatementRow[][] = [];
    for (let i = 0; i < s.rows.length; i += per) pages.push(s.rows.slice(i, i + per));
    if (!pages.length) pages.push([]);
    let running = s.opening;
    pages.forEach((rows, pi) => {
      let html = `<table><thead><tr>${colsHead}</tr></thead><tbody>`;
      const colCount = (s.columns === 'out-in' ? 5 : 4) + (s.showTypeColumn ? 1 : 0) - (s.balances === 'none' ? 1 : 0);
      if (s.opening !== undefined && (pi === 0 || s.broughtForward)) {
        const label = pi === 0 ? 'BALANCE BROUGHT FORWARD' : 'BALANCE BROUGHT FORWARD';
        html += `<tr class="bf"><td>${fmtDate(pi === 0 ? s.period[0] : rows[0]!.date, s.dateStyle)}</td><td colspan="${colCount - 2}">${label}</td><td class="n">${gbp(running!, { symbol: false })}</td></tr>`;
      }
      rows.forEach((r, ri) => {
        const prev = ri > 0 ? rows[ri - 1] : pi > 0 ? pages[pi - 1]!.at(-1) : undefined;
        const next = ri < rows.length - 1 ? rows[ri + 1] : pi < pages.length - 1 ? pages[pi + 1]![0] : undefined;
        const showDate = !s.dateOncePerDay || !prev || prev.date !== r.date || ri === 0;
        const endOfDay = !next || next.date !== r.date;
        const showBal = s.balances === 'every' || (s.balances === 'end-of-day' && endOfDay);
        running = r.balanceAfter ?? running;
        let amountCells: string;
        if (s.columns === 'out-in') amountCells = `<td class="n">${r.amount < 0 ? gbp(-r.amount, { symbol: false }) : ''}</td><td class="n">${r.amount > 0 ? gbp(r.amount, { symbol: false }) : ''}</td>`;
        else if (s.columns === 'card-cr') amountCells = `<td class="n">${gbp(Math.abs(r.amount), { symbol: false })}${r.amount > 0 ? ' CR' : ''}</td>`;
        else if (s.columns === 'card-plus') amountCells = `<td class="n">${r.amount > 0 ? '-' : ''}${gbp(Math.abs(r.amount), { symbol: false })}</td>`;
        else amountCells = `<td class="n">${gbp(r.amount, { symbol: false })}</td>`;
        const bal = s.balances === 'none' ? '' : `<td class="n">${showBal && r.balanceAfter !== undefined ? gbp(r.balanceAfter, { symbol: false }) + (r.balanceAfter < 0 && s.columns === 'out-in' ? ' OD' : '') : ''}</td>`;
        html += `<tr><td>${showDate ? fmtDate(r.date, s.dateStyle) : ''}</td>${s.showTypeColumn ? `<td>${esc(r.type ?? '')}</td>` : ''}<td>${esc(r.description)}${r.detail ? `<div class="sub">${esc(r.detail)}</div>` : ''}</td>${amountCells}${bal}</tr>`;
      });
      const last = pi === pages.length - 1;
      if (s.balances !== 'none' && (last || s.broughtForward)) {
        html += `<tr class="bf"><td>${fmtDate(last ? s.period[1] : rows.at(-1)!.date, s.dateStyle)}</td><td colspan="${colCount - 2}">${last ? 'BALANCE CARRIED FORWARD' : 'BALANCE CARRIED FORWARD'}</td><td class="n">${gbp(last ? s.closing : running!, { symbol: false })}</td></tr>`;
      }
      html += '</tbody></table>';
      body += html;
      if (!last) body += `<div class="pageno">Page ${pageNo++}</div><div class="pb"></div>${header}<div class="acct">${esc(s.title)} (continued)</div>`;
    });
    if (s.balances === 'none' && s.closingLabel) body += `<div class="box"><div><span>${esc(s.closingLabel)}</span><b>${gbp(-s.closing)}</b></div></div>`;
    body += '</div>';
    if (si < sections.length - 1) body += '';
  });
  body += `<div class="foot">${footer}</div><div class="pageno">Page ${pageNo}</div>`;
  return page(css, body);
}

// ─── Other A4 documents: valuations, P60, certificates ───────────────────────────────────────────

export function simpleDocHtml(brand: Brand, title: string, blocks: { heading?: string; rows?: [string, string][]; table?: { head: string[]; rows: string[][]; numeric?: number[] }; text?: string }[]): string {
  const css = `
@page { size: A4; margin: 16mm 14mm; }
.head { display: flex; justify-content: space-between; border-bottom: 3px solid ${brand.color}; padding-bottom: 8px; margin-bottom: 14px; }
.logo { font-size: 22px; font-weight: 700; color: ${brand.color}; }
.addr { font-size: 9px; color: #555; text-align: right; line-height: 1.4; }
h1 { font-size: 16px; margin: 0 0 12px; }
h2 { font-size: 12.5px; margin: 16px 0 6px; color: ${brand.color}; }
.kv { font-size: 10.5px; border: 1px solid #ccc; }
.kv div { display: flex; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid #eee; }
.kv div:last-child { border-bottom: 0; }
table { width: 100%; border-collapse: collapse; font-size: 10px; }
th { background: ${brand.color}; color: #fff; text-align: left; padding: 4px 6px; }
td { padding: 4px 6px; border-bottom: 1px solid #e6e6e6; }
.n { text-align: right; white-space: nowrap; }
p { font-size: 10px; line-height: 1.5; color: #333; }`;
  let body = `<div class="head"><div class="logo">${esc(brand.name)}</div><div class="addr">${esc(brand.address ?? '')}</div></div><h1>${esc(title)}</h1>`;
  for (const b of blocks) {
    if (b.heading) body += `<h2>${esc(b.heading)}</h2>`;
    if (b.rows) body += `<div class="kv">${b.rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
    if (b.table) {
      const num = new Set(b.table.numeric ?? []);
      body += `<table><thead><tr>${b.table.head.map((h, i) => `<th class="${num.has(i) ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${num.has(i) ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    if (b.text) body += `<p>${esc(b.text)}</p>`;
  }
  return page(css, body);
}

// ─── Phone screenshots ───────────────────────────────────────────────────────────────────────────

export interface AppRow {
  name: string;
  sub?: string;
  amount: string;
  positive?: boolean;
  pending?: boolean;
}

const phoneCss = (accent: string, dark: boolean) => `
body { width: 390px; min-height: 844px; background: ${dark ? '#12141a' : '#f4f5f7'}; color: ${dark ? '#f2f3f5' : '#15171c'}; font-size: 15px; }
.status { height: 44px; display: flex; justify-content: space-between; align-items: center; padding: 0 22px; font-size: 14px; font-weight: 600; }
.top { padding: 6px 18px 14px; }
.top .label { font-size: 13px; opacity: .65; }
.top .big { font-size: 34px; font-weight: 700; letter-spacing: -1px; margin: 2px 0; }
.top .meta { font-size: 13px; opacity: .6; }
.pill { display: inline-block; background: ${accent}; color: #fff; border-radius: 16px; padding: 6px 14px; font-size: 13px; font-weight: 600; margin: 10px 8px 0 0; }
.day { padding: 16px 18px 6px; font-size: 13px; font-weight: 700; opacity: .6; text-transform: none; }
.card { background: ${dark ? '#1d2029' : '#fff'}; margin: 0 12px; border-radius: 14px; overflow: hidden; }
.row { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid ${dark ? '#2a2e38' : '#eef0f3'}; }
.row:last-child { border-bottom: 0; }
.ico { width: 38px; height: 38px; border-radius: 50%; background: ${accent}22; color: ${accent}; display: flex; align-items: center; justify-content: center; font-weight: 700; margin-right: 12px; flex: none; }
.mid { flex: 1; min-width: 0; }
.name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12.5px; opacity: .6; margin-top: 1px; }
.amt { font-weight: 600; margin-left: 10px; white-space: nowrap; }
.amt.pos { color: ${dark ? '#56d38a' : '#128a4a'}; }
.pend { font-size: 11px; font-weight: 700; color: ${accent}; background: ${accent}1f; border-radius: 6px; padding: 1px 6px; margin-left: 6px; }
.stats { margin: 0 12px; background: ${dark ? '#1d2029' : '#fff'}; border-radius: 14px; padding: 4px 14px; }
.stats div { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid ${dark ? '#2a2e38' : '#eef0f3'}; font-size: 14.5px; }
.stats div:last-child { border-bottom: 0; }
.stats span { opacity: .65; }
.sect { padding: 18px 18px 8px; font-size: 16px; font-weight: 700; }
.bar { height: 6px; border-radius: 3px; background: ${accent}33; margin-top: 6px; }
.bar i { display: block; height: 6px; border-radius: 3px; background: ${accent}; }
.foot { height: 40px; }`;

export function appListHtml(opts: { accent: string; dark?: boolean; title: string; balanceLabel: string; balance: string; meta?: string; pills?: string[]; groups: { day: string; rows: AppRow[] }[] }): string {
  let body = `<div class="status"><span>9:41</span><span>● ● ●</span></div><div class="top"><div class="label">${esc(opts.title)}</div><div class="big">${esc(opts.balance)}</div><div class="meta">${esc(opts.balanceLabel)}${opts.meta ? ` · ${esc(opts.meta)}` : ''}</div>${(opts.pills ?? []).map((p) => `<span class="pill">${esc(p)}</span>`).join('')}</div>`;
  for (const g of opts.groups) {
    body += `<div class="day">${esc(g.day)}</div><div class="card">`;
    for (const r of g.rows) {
      body += `<div class="row"><div class="ico">${esc(r.name.slice(0, 1).toUpperCase())}</div><div class="mid"><div class="name">${esc(r.name)}${r.pending ? '<span class="pend">Pending</span>' : ''}</div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ''}</div><div class="amt${r.positive ? ' pos' : ''}">${esc(r.amount)}</div></div>`;
    }
    body += '</div>';
  }
  body += '<div class="foot"></div>';
  return page(phoneCss(opts.accent, Boolean(opts.dark)), body);
}

export function appOverviewHtml(opts: { accent: string; dark?: boolean; title: string; subtitle?: string; value: string; valueLabel?: string; stats: [string, string][]; sections?: { title: string; rows: AppRow[] }[]; note?: string; progress?: { label: string; used: number; of: number; text: string } }): string {
  let body = `<div class="status"><span>9:41</span><span>● ● ●</span></div><div class="top"><div class="label">${esc(opts.title)}</div><div class="big">${esc(opts.value)}</div><div class="meta">${esc(opts.valueLabel ?? '')}${opts.subtitle ? ` · ${esc(opts.subtitle)}` : ''}</div></div>`;
  body += `<div class="stats">${opts.stats.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
  if (opts.progress) {
    const p = opts.progress;
    body += `<div class="sect">${esc(p.label)}</div><div class="stats"><div><span>${esc(p.text)}</span></div><div class="bar"><i style="width:${Math.min(100, (p.used / p.of) * 100)}%"></i></div><div style="border:0"></div></div>`;
  }
  for (const s of opts.sections ?? []) {
    body += `<div class="sect">${esc(s.title)}</div><div class="card">`;
    for (const r of s.rows) body += `<div class="row"><div class="ico">${esc(r.name.slice(0, 1))}</div><div class="mid"><div class="name">${esc(r.name)}</div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ''}</div><div class="amt${r.positive ? ' pos' : ''}">${esc(r.amount)}</div></div>`;
    body += '</div>';
  }
  if (opts.note) body += `<div class="day" style="font-weight:400">${esc(opts.note)}</div>`;
  body += '<div class="foot"></div>';
  return page(phoneCss(opts.accent, Boolean(opts.dark)), body);
}

/**
 * An investment app's activity list, scrolled past the account selector: name and date, amount,
 * and a Balance column that is the account's cash. Newest first, ending with a brought-forward row.
 */
export function appActivityHtml(opts: { accent: string; heading?: string; period: string; rows: { name: string; date: string; amount: string; balance: string; positive?: boolean }[] }): string {
  let body = `<div class="status"><span>9:15</span><span>● ● ●</span></div><div class="top"><div class="big" style="font-size:22px">Your account activity</div>${opts.heading ? `<div class="meta">${esc(opts.heading)}</div>` : ''}</div>`;
  body += `<div class="sect" style="text-align:center">${esc(opts.period)}</div><div class="card"><div class="row" style="opacity:.6;font-size:13px"><div class="mid">Name and date</div><div class="amt" style="font-weight:400">Amount</div><div class="amt" style="font-weight:400;width:92px;text-align:right">Balance</div></div>`;
  for (const r of opts.rows) body += `<div class="row"><div class="mid"><div class="name" style="white-space:normal">${esc(r.name)}</div><div class="sub">${esc(r.date)}</div></div><div class="amt${r.positive ? ' pos' : ''}">${esc(r.amount)}</div><div class="amt" style="width:92px;text-align:right">${esc(r.balance)}</div></div>`;
  body += '</div><div class="foot"></div>';
  return page(phoneCss(opts.accent, false), body);
}

/** One fund's own page in an investment app: its figures only, and the nickname the app gave it. */
export function appHoldingHtml(opts: { accent: string; fund: string; nickname: string; stats: [string, string][] }): string {
  let body = `<div class="status"><span>9:16</span><span>● ● ●</span></div><div class="top"><div class="big" style="font-size:24px;line-height:1.2">${esc(opts.fund)}</div><div class="meta" style="font-weight:600;opacity:.8">${esc(opts.nickname)}</div><span class="pill">View investment info</span></div>`;
  body += `<div class="stats">${opts.stats.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
  body += '<div class="foot"></div>';
  return page(phoneCss(opts.accent, false), body);
}

/**
 * A savings provider's account page with tabs (Transactions, Bond record…): the holding at the top,
 * then the open tab's list grouped by heading. `header: false` is the same page scrolled past the
 * holding and tabs; `title` alone (no value) is a page of its own, such as a prize history.
 */
export function appTabbedHtml(opts: {
  accent: string;
  time: string;
  header: boolean;
  title: string;
  subtitle?: string;
  value?: string;
  valueLabel?: string;
  tabs?: string[];
  active?: string;
  groups: { heading: string; rows: AppRow[] }[];
}): string {
  let body = `<div class="status"><span>${esc(opts.time)}</span><span>● ● ●</span></div>`;
  if (opts.header) {
    body += `<div class="top"><div class="label">${esc(opts.title)}</div>${opts.value ? `<div class="big">${esc(opts.value)}</div>` : ''}<div class="meta">${esc([opts.valueLabel, opts.subtitle].filter(Boolean).join(' · '))}</div>`;
    body += (opts.tabs ?? []).map((t) => `<span class="pill" style="${t === opts.active ? '' : `background:transparent;color:inherit;border:1px solid ${opts.accent}55`}">${esc(t)}</span>`).join('');
    body += '</div>';
  }
  for (const g of opts.groups) {
    body += `<div class="day">${esc(g.heading)}</div><div class="card">`;
    for (const r of g.rows) body += `<div class="row"><div class="mid"><div class="name">${esc(r.name)}</div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ''}</div><div class="amt${r.positive ? ' pos' : ''}">${esc(r.amount)}</div></div>`;
    body += '</div>';
  }
  body += '<div class="foot"></div>';
  return page(phoneCss(opts.accent, false), body);
}

// ─── Rendering ───────────────────────────────────────────────────────────────────────────────────

export async function renderPdf(browser: Browser, html: string): Promise<Buffer> {
  const p = await browser.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  const pdf = await p.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  await p.close();
  return Buffer.from(pdf);
}

/**
 * A phone screenshot: 390pt wide at 3x, one screen tall (844pt), or longer when the content is (a
 * long scrolling capture). Every row in the document is visible, so every expected row can be read.
 */
export async function renderPng(browser: Browser, html: string): Promise<Buffer> {
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
  await p.setContent(html, { waitUntil: 'load' });
  const png = await p.screenshot({ type: 'png', fullPage: true });
  await p.close();
  return Buffer.from(png);
}
