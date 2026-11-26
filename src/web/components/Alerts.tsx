import { ArrowRight, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { Alert } from '../../shared/api';
import { cn } from '../lib/format';

const ALERT_ICON = { info: Info, warning: TriangleAlert, critical: CircleAlert };

/** The Overview's alerts: yours, and beside them a company's deadlines, each with what to do. */
export function AlertList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((a) => {
        const Icon = ALERT_ICON[a.level];
        return (
          <li key={a.id} className={cn('flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[13px]', a.level === 'critical' ? 'border-transparent bg-bad-soft' : a.level === 'warning' ? 'border-transparent bg-warn-soft' : 'border-line bg-panel')}>
            <Icon className={cn('size-4 shrink-0', a.level === 'critical' ? 'text-bad-ink' : a.level === 'warning' ? 'text-warn-ink' : 'text-accent')} />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-ink">{a.title}</span>
              {a.detail && <span className="ml-2 text-ink-3">{a.detail}</span>}
            </div>
            {a.action && (
              <Link to={a.action.href} className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline">
                {a.action.label} <ArrowRight className="size-3.5" />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
