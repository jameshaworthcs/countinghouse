// Fund names as statements and apps print them: the same fund under a full name, a name cut short
// on a narrow screen ("HSBC FTSE 100 Index Accum…"), or a name with the app's own type label added
// after the cut ("Fidelity Index Emerging Mar… Accumulation Fund").

/** A name reduced to letters and digits, for comparing. */
export function fundKey(name: string): string {
  return name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

/** The part of a name before an ellipsis ("…" or "..."), when it was cut short; otherwise null. */
export function cutShort(name: string): string | null {
  const i = name.search(/…|\.{3}/);
  return i > 0 ? fundKey(name.slice(0, i)) : null;
}

/**
 * The same fund by name: equal names, a name cut short that begins the other, or a shorter name
 * that begins a longer one (12+ characters, so "HSBC" alone never matches every HSBC fund).
 */
export function sameFundName(a: string, b: string): boolean {
  const x = fundKey(a);
  const y = fundKey(b);
  if (x === y) return true;
  for (const [cut, full] of [
    [cutShort(a), y],
    [cutShort(b), x],
  ] as const) {
    if (cut && cut.length >= 8 && full.startsWith(cut)) return true;
  }
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.startsWith(short);
}

/** Of two names for one fund, the one to keep: never a name cut short, else the longer. */
export function fullerName(a: string, b: string): string {
  if (cutShort(a) && !cutShort(b)) return b;
  if (cutShort(b) && !cutShort(a)) return a;
  return b.length > a.length ? b : a;
}
