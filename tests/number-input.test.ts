// The text of a number field while it is typed (NumberInput in src/web/components/ui.tsx).

import { describe, expect, it } from 'vitest';
import { flipSign, parseNumberText } from '../src/web/lib/format';

describe('parseNumberText', () => {
  it('reads empty text as no value', () => {
    expect(parseNumberText('')).toBeUndefined();
    expect(parseNumberText('  ')).toBeUndefined();
  });

  it('holds partial text that is not yet a number', () => {
    expect(parseNumberText('-')).toBeNull();
    expect(parseNumberText('.')).toBeNull();
    expect(parseNumberText('-.')).toBeNull();
    expect(parseNumberText('12a')).toBeNull();
  });

  it('reads signed and decimal numbers, with or without £ and commas', () => {
    expect(parseNumberText('-12.')).toBe(-12);
    expect(parseNumberText('-0.5')).toBe(-0.5);
    expect(parseNumberText('.5')).toBe(0.5);
    expect(parseNumberText('£1,234.56')).toBe(1234.56);
    expect(parseNumberText('-£20')).toBe(-20);
  });
});

describe('flipSign', () => {
  it('swaps the sign, and starts empty text with a minus', () => {
    expect(flipSign('12.5')).toBe('-12.5');
    expect(flipSign('-12.5')).toBe('12.5');
    expect(flipSign('')).toBe('-');
    expect(flipSign('-')).toBe('');
    expect(flipSign('12.')).toBe('-12.');
  });
});
