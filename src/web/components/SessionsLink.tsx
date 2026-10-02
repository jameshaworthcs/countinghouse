// A link to the Claude sessions of a job, import or receipt (pages/Sessions.tsx), for the pages
// they appear on.

import { ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/format';

export function SessionsLink({ of, children, className }: { of?: string; children?: ReactNode; className?: string }) {
  return (
    <Link to={of ? `/sessions?for=${encodeURIComponent(of)}` : '/sessions'} className={cn('inline-flex items-center gap-1 text-accent hover:underline', className)}>
      <ScrollText className="size-3.5" aria-hidden />
      {children ?? 'Agent sessions'}
    </Link>
  );
}
