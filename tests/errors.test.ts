// The web app's error screen: which failures send you to sign in, which reload onto a new build.

import { describe, expect, it } from 'vitest';
import { classifyFailure, signInPath } from '../src/web/lib/errors';

describe('classifyFailure', () => {
  it('treats a 401 from the API as signed out', () => {
    expect(classifyFailure(Object.assign(new Error('Not signed in'), { status: 401 }))).toBe('signed-out');
  });

  it('recognises every browser’s wording for a page bundle a deploy removed', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://finance.example/assets/Spending-abc123.js',
      'error loading dynamically imported module: https://finance.example/assets/Spending-abc123.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/Spending-abc123.css',
      "'text/html' is not a valid JavaScript MIME type.",
    ]) {
      expect(classifyFailure(new TypeError(message))).toBe('stale-build');
    }
  });

  it('leaves other failures alone', () => {
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe('other');
    expect(classifyFailure(Object.assign(new Error('Request failed (500)'), { status: 500 }))).toBe('other');
    expect(classifyFailure(null)).toBe('other');
    expect(classifyFailure('Failed to fetch dynamically imported module: /assets/x.js')).toBe('stale-build');
  });
});

describe('signInPath', () => {
  it('comes back to the same page and query', () => {
    expect(signInPath('/transactions?q=tesco&from=2026-09-01')).toBe('/login?next=%2Ftransactions%3Fq%3Dtesco%26from%3D2026-09-01');
  });
});
