// Every other labelled value a document prints (extract-14, "read everything"), by the heading it is
// under: as its import was read, and as later readings added (docs/INGESTION.md, "Reading a stored
// document again").

import type { ImportRecord, PrintedValue } from '../../shared/schema';
import { formatDate } from '../lib/format';

export function PrintedList({ printed }: { printed: PrintedValue[] }) {
  const sections = [...new Set(printed.map((p) => p.section ?? ''))];
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => (
        <div key={section}>
          {section && <div className="mb-1 text-[12px] font-medium text-ink-3">{section}</div>}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
            {printed
              .filter((p) => (p.section ?? '') === section)
              .map((p, i) => (
                <div key={i} className="flex justify-between gap-3">
                  <dt className="min-w-0 text-ink-2">{p.label}</dt>
                  <dd className="text-right [overflow-wrap:anywhere]">{p.value}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/** Kept with the import, though nothing reads it yet. */
export function PrintedValues({ printed, later = [] }: { printed: PrintedValue[]; later?: NonNullable<ImportRecord['readAgain']> }) {
  const total = printed.length + later.reduce((n, r) => n + r.printed.length, 0);
  if (!total) return null;
  return (
    <details className="rounded-xl border border-line bg-panel">
      <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-2">Everything else it prints ({total})</summary>
      <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
        <p className="text-[12.5px] text-ink-3">Kept with the import as printed, so nothing on the document is lost.</p>
        {printed.length > 0 && <PrintedList printed={printed} />}
        {later.map((r) => (
          <div key={r.at} className="flex flex-col gap-2">
            <div className="text-[12.5px] text-ink-3">
              Added when it was read again with {r.engineVersion}
              {r.model ? ` (${r.model.replace(/^claude-/, '')})` : ''}, {formatDate(r.at.slice(0, 10))}:
            </div>
            <PrintedList printed={r.printed} />
          </div>
        ))}
      </div>
    </details>
  );
}
