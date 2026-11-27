// Which incomplete stretches on a TimeChart get their label drawn, without colliding.

export interface PartialBox {
  from: number;
  to: number;
  x0: number;
  x1: number;
  label: string;
}

/**
 * Which incomplete stretches get their label drawn, without two labels ever colliding. Wider
 * stretches claim space first so a long gap is labelled ahead of a narrow sliver beside it; a
 * stretch at the start of the chart may still run on into the known days when nothing collides.
 */
export function placePartialLabels(boxes: readonly PartialBox[], innerW: number): Set<number> {
  const placed: [number, number][] = [];
  const shown = new Set<number>();
  const order = boxes.map((b, i) => ({ b, i, w: b.x1 - b.x0 })).sort((a, b) => b.w - a.w || a.b.x0 - b.b.x0);
  for (const { b, i, w } of order) {
    const textW = Math.ceil(b.label.length * 6.6);
    const fitsBox = w >= textW + 12;
    if (!fitsBox && b.from > 0) continue;
    const left = b.x0 + 6;
    const right = left + textW;
    if (right > innerW) continue;
    if (placed.some(([a, z]) => left < z + 8 && right + 8 > a)) continue;
    placed.push([left, right]);
    shown.add(i);
  }
  return shown;
}
