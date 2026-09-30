// Funds on statements become instruments (docs/INGESTION.md). Each fund in an open account's latest
// holdings that no instrument matches is recorded as one, with its name and identifiers as the
// document printed them: a fact from the document, not an inference, so it happens whether or not
// agents are on, at each commit that records holdings and when the app starts. Researching the new
// instrument is agent work, and waits for agents.

import { fullerName } from '../shared/funds';
import { matchInstrument } from './analytics/research';
import { applyRecords } from './records';
import type { Store } from './store';

/** Record instruments for holdings that have none yet. Returns how many were added. */
export async function recordInstrumentsFromHoldings(store: Store): Promise<number> {
  const seen = new Map<string, { name: string; isin?: string; ticker?: string; sedol?: string }>();
  // A fund first recorded under a name cut short takes the full name when a statement prints
  // it; the short one stays as an alias, so older holdings still match.
  const renamed = new Map<string, { id: string; name: string; aliases: string[]; sedol?: string }>();
  for (const a of store.accounts.filter((x) => x.status === 'open')) {
    const snap = store.holdings(a.id).at(-1);
    for (const h of snap?.holdings ?? []) {
      const known = matchInstrument(h, store.instruments);
      if (known) {
        const name = fullerName(renamed.get(known.id)?.name ?? known.name, h.name);
        const sedol = !known.sedol && h.sedol ? h.sedol : undefined;
        if (name !== known.name || sedol) renamed.set(known.id, { id: known.id, name, aliases: name !== known.name ? [known.name] : [], ...(sedol ? { sedol } : {}) });
        continue;
      }
      const key = h.isin?.toUpperCase() ?? h.sedol?.toUpperCase() ?? h.ticker?.toUpperCase() ?? h.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name: h.name, ...(h.isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(h.isin.toUpperCase()) ? { isin: h.isin.toUpperCase() } : {}), ...(h.ticker ? { ticker: h.ticker } : {}), ...(h.sedol ? { sedol: h.sedol } : {}) });
    }
  }
  if (!seen.size && !renamed.size) return 0;
  await applyRecords(store, {
    provenance: { setBy: 'system', session: 'holdings' },
    supersede: false,
    records: [
      ...[...seen.values()].map((r) => ({ type: 'instrument' as const, record: { ...r, aliases: [] } })),
      ...[...renamed.values()].map((r) => ({ type: 'instrument' as const, record: r })),
    ],
  });
  return seen.size;
}
