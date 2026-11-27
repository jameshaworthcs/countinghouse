// Layout of "No data yet for …" labels on TimeChart incomplete stretches (src/web/components/charts/partial.ts).

import { describe, expect, it } from 'vitest';
import { placePartialLabels } from '../src/web/components/charts/partial';

describe('placePartialLabels', () => {
  it('never overlaps adjacent labels and prefers the wider stretch', () => {
    const shown = placePartialLabels(
      [
        { from: 0, to: 1, x0: 0, x1: 14, label: 'No data yet for Example A and Example B' },
        { from: 2, to: 18, x0: 14, x1: 280, label: 'No data yet for Example B' },
      ],
      600,
    );
    // The wide stretch takes the label; the narrow leading sliver collides with it and is skipped.
    expect([...shown]).toEqual([1]);
  });

  it('keeps a single leading stretch label when nothing collides, and drops one wider than the chart', () => {
    expect([...placePartialLabels([{ from: 0, to: 2, x0: 0, x1: 40, label: 'No data yet for Example A' }], 600)]).toEqual([0]);
    expect([...placePartialLabels([{ from: 0, to: 2, x0: 0, x1: 40, label: 'No data yet for Example A' }], 100)]).toEqual([]);
  });

  it('keeps well-separated wide stretches', () => {
    const shown = placePartialLabels(
      [
        { from: 0, to: 10, x0: 0, x1: 200, label: 'No data yet for Example A' },
        { from: 20, to: 30, x0: 360, x1: 580, label: 'No data yet for Example B' },
      ],
      600,
    );
    expect([...shown].sort()).toEqual([0, 1]);
  });
});
