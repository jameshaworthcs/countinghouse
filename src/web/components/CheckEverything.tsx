// The "check everything yourself" disclaimer every return the app prepares carries (CLAUDE.md,
// "Invariants"): Self Assessment on the Tax year page, a company's VAT return on its VAT tab. The words
// are the server's (shared/disclaimers.ts), shown under one heading, printed with the page.

import { FileWarning } from 'lucide-react';
import { CHECK_EVERYTHING_TITLE } from '../../shared/disclaimers';

export function CheckEverything({ text }: { text: string }) {
  return (
    <div className="rounded-xl border-2 border-warn bg-warn-soft px-5 py-4" role="note">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <FileWarning className="size-5 shrink-0 text-warn-ink" aria-hidden /> {CHECK_EVERYTHING_TITLE}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2">{text}</p>
    </div>
  );
}
