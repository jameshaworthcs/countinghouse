// Money paid in to an account with a live feed, from the provider's own list of cash movements
// (docs/FORMULAS.md §12, "Paid in"): its deposits, withdrawals and transfers, signed as it gives them
// (money in positive). A movement your imports file as something other than money paid in or taken
// out (a promotion's deposit filed as income) is left out: the import's row has the provider's
// reference as its ID, and its category says what it was.
//
// The list is read in full once, then only its newest page, at most hourly (it is 20 requests a
// minute and changes rarely), following pages while every item on one is new. It is kept in the
// work area (feeds/<feed>/cash-movements.json), never in data/.

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTERNAL_FLOW_CATEGORIES } from '../../shared/categories';
import { fromMinor, toMinor } from '../../shared/money';
import type { Transaction } from '../../shared/schema';
import { atomicWrite } from '../fsutil';
import type { T212CashMovement } from './trading212';

/** The kinds of movement that are money paid in or taken out; interest and fees are not. */
export const PAID_IN_TYPES = new Set(['DEPOSIT', 'WITHDRAW', 'TRANSFER']);

/** How often the newest page is read again. */
export const CASH_REFRESH_MS = 60 * 60_000;

export interface CashMovementsFile {
  /** Every page has been read back to the first movement. */
  complete: boolean;
  readAt: string;
  items: T212CashMovement[];
}

interface Pager {
  cashMovements(next?: string): Promise<{ items: T212CashMovement[]; next: string | null }>;
}

export class CashMovementsBook {
  private data: CashMovementsFile | undefined;
  private readAtMs = 0;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly now: () => number,
  ) {
    this.file = path.join(dir, 'cash-movements.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as CashMovementsFile;
      if (Array.isArray(parsed.items) && typeof parsed.readAt === 'string') {
        this.data = parsed;
        this.readAtMs = Date.parse(parsed.readAt) || 0;
      }
    } catch {
      // Not read yet.
    }
  }

  get status(): { count: number; readAt: string; complete: boolean } | undefined {
    return this.data ? { count: this.data.items.length, readAt: this.data.readAt, complete: this.data.complete } : undefined;
  }

  /** Whether the list should be read again now. */
  due(force = false): boolean {
    if (!this.data?.complete) return true;
    return force || this.now() - this.readAtMs >= CASH_REFRESH_MS;
  }

  /**
   * Read what is new: every page when the list is not complete, else the newest page and the ones
   * after it while each holds nothing already known. `wait` spaces the pages (the API allows 20 a
   * minute).
   */
  async refresh(client: Pager, readAt: string, wait: (ms: number) => Promise<void>): Promise<void> {
    const known = new Map((this.data?.items ?? []).map((i) => [i.reference, i]));
    const full = !this.data?.complete;
    let next: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await client.cashMovements(next);
      pages++;
      let fresh = 0;
      for (const item of page.items) {
        if (!known.has(item.reference)) fresh++;
        known.set(item.reference, item);
      }
      if (!page.next || (!full && fresh < page.items.length) || pages >= 200) {
        this.data = { complete: full ? !page.next : true, readAt, items: [...known.values()].sort((a, b) => b.dateTime.localeCompare(a.dateTime)) };
        break;
      }
      next = page.next;
      await wait(3_100);
    }
    this.readAtMs = this.now();
    await mkdir(path.dirname(this.file), { recursive: true });
    await atomicWrite(this.file, `${JSON.stringify(this.data, null, 1)}\n`, 0o600);
  }

  /**
   * Money paid in to date, net of withdrawals, in `currency`: undefined until the list is complete.
   * `rows` are the account's imported transactions, whose categories say what each movement was.
   */
  contributions(currency: string, rows: readonly Transaction[]): number | undefined {
    if (!this.data?.complete) return undefined;
    return paidIn(this.data.items, currency, rows);
  }
}

/** The movements that are money paid in or out, less those your imports say were something else. */
export function paidIn(items: readonly T212CashMovement[], currency: string, rows: readonly Transaction[]): number {
  const filedAs = new Map<string, string | undefined>();
  for (const t of rows) {
    const id = t.raw?.ID;
    if (typeof id === 'string' && id) filedAs.set(id, t.category);
  }
  let minor = 0;
  for (const m of items) {
    if (!PAID_IN_TYPES.has(m.type) || m.currency !== currency) continue;
    const category = filedAs.get(m.reference);
    if (category !== undefined && !EXTERNAL_FLOW_CATEGORIES.has(category)) continue;
    minor += toMinor(m.amount);
  }
  return fromMinor(minor);
}
