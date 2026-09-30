// Column sorting shared by the API and the web tables (src/shared/sort.ts).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareValues, formatSortParam, parseFigure, parseSortParam, sortRows } from '../src/shared/sort';
import { nextSort } from '../src/web/lib/sort';

describe('sorting', () => {
  it('compares numbers numerically and text the way people read it', () => {
    expect(sortRows([10, -2, 3], (v) => v, 'asc')).toEqual([-2, 3, 10]);
    expect(sortRows([10, -2, 3], (v) => v, 'desc')).toEqual([10, 3, -2]);
    expect(sortRows(['Item 10', 'item 2', 'Item 1'], (v) => v, 'asc')).toEqual(['Item 1', 'item 2', 'Item 10']);
    expect(sortRows(['banana', 'Apple', 'cherry'], (v) => v, 'asc')).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('puts blanks last whichever way it sorts', () => {
    const rows = [null, 'b', '', 'a', undefined];
    expect(sortRows(rows, (v) => v, 'asc').slice(0, 2)).toEqual(['a', 'b']);
    expect(sortRows(rows, (v) => v, 'desc').slice(0, 2)).toEqual(['b', 'a']);
    expect(compareValues(null, 1, 'asc')).toBeGreaterThan(0);
    expect(compareValues(null, 1, 'desc')).toBeGreaterThan(0);
    expect(compareValues(Number.NaN, 1, 'desc')).toBeGreaterThan(0);
  });

  it('keeps equal rows in the order they came', () => {
    const rows = [{ k: 1, n: 'a' }, { k: 0, n: 'b' }, { k: 1, n: 'c' }, { k: 0, n: 'd' }];
    expect(sortRows(rows, (r) => r.k, 'asc').map((r) => r.n)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortRows(rows, (r) => r.k, 'desc').map((r) => r.n)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('descending is ascending reversed, for distinct values', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer()), (xs) => {
        expect(sortRows(xs, (v) => v, 'desc')).toEqual(sortRows(xs, (v) => v, 'asc').reverse());
      }),
    );
  });

  it('reads and writes the API sort parameter', () => {
    expect(parseSortParam('amount_asc')).toEqual({ key: 'amount', dir: 'asc' });
    expect(parseSortParam('amount')).toBeNull();
    expect(parseSortParam('amount_up')).toBeNull();
    expect(parseSortParam(undefined)).toBeNull();
    expect(formatSortParam('payee', 'desc')).toBe('payee_desc');
  });

  it('cycles a column through its first direction, the other, then the original order', () => {
    const a = nextSort(null, 'amount', 'desc');
    expect(a).toEqual({ key: 'amount', dir: 'desc' });
    const b = nextSort(a, 'amount', 'desc');
    expect(b).toEqual({ key: 'amount', dir: 'asc' });
    expect(nextSort(b, 'amount', 'desc')).toBeNull();
    expect(nextSort(b, 'name', 'asc')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('reads formatted figures back as numbers', () => {
    expect(parseFigure('-£1,234.50')).toBe(-1234.5);
    expect(parseFigure('−£5')).toBe(-5);
    expect(parseFigure('£1.2m')).toBe(1_200_000);
    expect(parseFigure('£1.5k')).toBe(1500);
    expect(parseFigure('+3.0%')).toBe(3);
    expect(parseFigure('12')).toBe(12);
    expect(parseFigure('—')).toBeNull();
    expect(parseFigure('Jan 26')).toBeNull();
  });
});
