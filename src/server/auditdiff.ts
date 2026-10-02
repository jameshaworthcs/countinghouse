// What a write changed, record by record, for the audit log (audit.ts): pure, so the store can
// describe each change without knowing who made it.

import type { ChangeDiff, FieldChanges } from '../shared/audit';

/** Records listed per change; the counts cover the rest. */
const MAX_ITEMS = 50;
/** Fields listed per record. */
const MAX_FIELDS = 40;
const MAX_TEXT = 160;
/** Fields that change with every write and say nothing. */
const IGNORED = new Set(['updatedAt', '$schema']);

/** A value short enough to keep: long strings and nested values are cut. */
export function brief(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  const s = JSON.stringify(v);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : v;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fields that differ, by dotted path into nested objects (arrays compare whole). */
export function diffFields(before: unknown, after: unknown, prefix = '', out: FieldChanges = {}): FieldChanges {
  if (isPlain(before) && isPlain(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (IGNORED.has(k) || Object.keys(out).length >= MAX_FIELDS) continue;
      diffFields(before[k], after[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after) && Object.keys(out).length < MAX_FIELDS) out[prefix || '(value)'] = [brief(before), brief(after)];
  return out;
}

/** A few words that say which record it is: its name, or its date, amount and description. */
export function recordLabel(r: unknown): string | undefined {
  if (!isPlain(r)) return undefined;
  const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const name = pick('name', 'title', 'employer', 'key', 'label', 'fileName');
  const date = pick('date', 'asOf', 'periodEnd', 'taxYear');
  const amount = typeof r.amount === 'number' ? r.amount : typeof r.balance === 'number' ? r.balance : typeof r.value === 'number' ? r.value : undefined;
  const text = pick('payee', 'description', 'kind', 'status');
  const parts = [date, amount !== undefined ? String(amount) : undefined, name ?? text].filter(Boolean);
  const label = parts.join(' ');
  return label ? (label.length > MAX_TEXT ? `${label.slice(0, MAX_TEXT)}…` : label) : undefined;
}

type WithId = { id: string };

/** Lists before and after, matched by id. */
export function diffById(before: readonly unknown[], after: readonly unknown[]): ChangeDiff {
  const was = new Map((before as WithId[]).map((r) => [r.id, r]));
  const now = new Map((after as WithId[]).map((r) => [r.id, r]));
  const diff: ChangeDiff = {};
  const items: NonNullable<ChangeDiff['items']> = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, r] of now) {
    const old = was.get(id);
    if (!old) {
      added++;
      if (items.length < MAX_ITEMS) items.push({ id, op: 'added', ...label(r) });
    } else if (JSON.stringify(old) !== JSON.stringify(r)) {
      const fields = diffFields(old, r);
      if (!Object.keys(fields).length) continue;
      changed++;
      if (items.length < MAX_ITEMS) items.push({ id, op: 'changed', ...label(r), fields });
    }
  }
  for (const [id, r] of was) {
    if (now.has(id)) continue;
    removed++;
    if (items.length < MAX_ITEMS) items.push({ id, op: 'removed', ...label(r) });
  }
  if (added) diff.added = added;
  if (removed) diff.removed = removed;
  if (changed) diff.changed = changed;
  if (items.length) diff.items = items;
  return diff;
}

/** Records added (or removed) outright. */
export function listed(op: 'added' | 'removed', records: readonly unknown[]): ChangeDiff {
  if (!records.length) return {};
  return { [op]: records.length, items: (records as WithId[]).slice(0, MAX_ITEMS).map((r) => ({ id: r.id, op, ...label(r) })) };
}

/** Changes to records one at a time (before, after), as they are made. */
export class DiffCollector {
  private readonly diff: ChangeDiff = {};
  private readonly items: NonNullable<ChangeDiff['items']> = [];

  changed(before: WithId, after: WithId): void {
    const fields = diffFields(before, after);
    if (!Object.keys(fields).length) return;
    this.diff.changed = (this.diff.changed ?? 0) + 1;
    if (this.items.length < MAX_ITEMS) this.items.push({ id: after.id, op: 'changed', ...label(after), fields });
  }

  op(op: 'added' | 'removed', r: WithId): void {
    this.diff[op] = (this.diff[op] ?? 0) + 1;
    if (this.items.length < MAX_ITEMS) this.items.push({ id: r.id, op, ...label(r) });
  }

  result(): ChangeDiff {
    return this.items.length ? { ...this.diff, items: this.items } : this.diff;
  }
}

function label(r: unknown): { label?: string } {
  const l = recordLabel(r);
  return l ? { label: l } : {};
}
